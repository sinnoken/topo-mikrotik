/*
 * 命名規則（profile）引擎。profile 是一份獨立的 JSON，可以不套用。
 * 它只能：①建模前把名稱對應到正式名稱（alias / stripDomain）②建模後加註解（kind、role、group、label）。
 * 它不能新增、刪除或改變任何事實（介面、鏈路、VLAN、位址）。
 *
 * {
 *   "schema": "ssot-profile/1", "id": "site-naming", "version": "1",
 *   "stripDomain": true,
 *   "alias": { "OLD-NAME": "NEW_NAME" },
 *   "classify": [ { "match": "_FW_", "flags": "i", "kind": "firewall", "role": "fw" } ],
 *   "group":  { "match": "^([A-Z0-9]+)_", "value": "$1" },
 *   "label":  { "match": "^(.*)$", "value": "$1" },
 *   "zones":  [ { "on": "vlan", "match": "^MGMT$", "zone": "MGMT" } ]   ← 選用：L4 zone 標籤，只在查詢時使用（Q.zones）
 * }
 */
(function (S) {
  'use strict';
  const KINDS = ['firewall', 'switch', 'router', 'host', 'unknown'];

  function tmpl(m, value) { return String(value).replace(/\$(\d)/g, (_, n) => m[+n] || ''); }

  /** 驗證並編譯 profile；有錯時丟出 Error（訊息列出所有問題）。 */
  function compile(json) {
    if (!json) return null;
    const errs = [];
    if (!json.id) errs.push('缺少 id');
    const rx = (o, where) => {
      try { return new RegExp(o.match, o.flags || 'i'); } catch (e) { errs.push(`${where} 的 match 不是有效的正規表示式：${e.message}`); return null; }
    };
    const classify = (json.classify || []).map((r, i) => {
      if (r.kind && !KINDS.includes(r.kind)) errs.push(`classify[${i}].kind 必須是 ${KINDS.join(', ')}`);
      return { re: rx(r, `classify[${i}]`), kind: r.kind, role: r.role, site: r.site };
    });
    const group = json.group ? { re: rx(json.group, 'group'), value: json.group.value || '$1' } : null;
    const label = json.label ? { re: rx(json.label, 'label'), value: json.label.value || '$1' } : null;
    // zones（選用）：L4 zone 的標籤，只在查詢時使用（Q.zones），不寫進 Snapshot；on 是比對的對象
    const ZONE_ON = ['vlan', 'interface', 'subnet'];
    if (json.zones != null && !Array.isArray(json.zones)) errs.push('zones 必須是陣列');
    const zones = (Array.isArray(json.zones) ? json.zones : []).map((r, i) => {
      if (!ZONE_ON.includes(r && r.on)) errs.push(`zones[${i}].on 必須是 ${ZONE_ON.join(', ')}`);
      if (!r || typeof r.zone !== 'string' || !r.zone.trim()) errs.push(`zones[${i}].zone 必須是非空字串`);
      return { re: r ? rx(r, `zones[${i}]`) : null, on: r && r.on, zone: r && r.zone, match: r && r.match };
    });
    const alias = new Map(Object.entries(json.alias || {}).map(([k, v]) => [String(k).trim().toUpperCase(), String(v)]));
    if (errs.length) throw new Error('命名規則檔有誤：\n- ' + errs.join('\n- '));

    const compiled = {
      id: json.id, version: String(json.version || '1'), source: json,
      /** 建模前：原始名稱 → 正式名稱 */
      canon(name) {
        let n = String(name || '').trim();
        if (json.stripDomain && !S.ip.isIp(n)) n = n.replace(/\..*$/, '');
        return alias.get(n.toUpperCase()) || n;
      },
      /** 建模後：依名稱加註解 */
      annotate(name) {
        const out = {};
        for (const r of classify) {
          const m = r.re && r.re.exec(name);
          if (!m) continue;
          if (r.kind && !out.kind) out.kind = r.kind;
          if (r.role && !out.role) out.role = tmpl(m, r.role);
          if (r.site && !out.site) out.site = tmpl(m, r.site);
        }
        let m;
        if (group && group.re && (m = group.re.exec(name))) out.group = tmpl(m, group.value);
        if (label && label.re && (m = label.re.exec(name))) out.label = tmpl(m, label.value);
        return out;
      },
      /**
       * 網段的 zone 標籤（註解，不改寫事實）：t = { subnet: '10.0.0.0/24', vlans: [{ id, names }], interfaces: [{ name, desc }] }。
       * zones 由上往下，第一條符合的規則生效；vlan 比對 VLAN ID（文字）與名稱，interface 比對介面名稱與說明，subnet 比對網段文字。
       * 回傳 { zone, rule（索引）, on, match } 或 null。
       */
      zoneOf(t) {
        for (let i = 0; i < zones.length; i++) {
          const z = zones[i]; if (!z.re) continue;
          const texts = z.on === 'vlan' ? (t.vlans || []).flatMap((v) => [String(v.id)].concat(v.names || []))
            : z.on === 'interface' ? (t.interfaces || []).flatMap((x) => [x.name, x.desc].filter(Boolean)) : [t.subnet];
          for (const s of texts) { const m = z.re.exec(s); if (m) return { zone: tmpl(m, z.zone), rule: i, on: z.on, match: z.match }; }
        }
        return null;
      },
      /** 一句說明（見 describe） */
      describe() { return describe(json); },
      /** 對某份基準的套用結果（見 coverage） */
      coverage(Q) { return coverageOf(this, Q); },
    };
    return compiled;
  }

  /**
   * 命名規則的一句說明：有 description（字串）就用它；沒有時依有哪些規則推出一句（例如「去掉網域、分類規則 7 條、分群」）。
   * 只用於顯示，不影響標註。
   */
  function describe(json) {
    if (json && typeof json.description === 'string' && json.description.trim()) return json.description.trim();
    const j = json || {}; const out = [];
    const n = (x) => (Array.isArray(x) ? x.length : 0);
    if (j.stripDomain) out.push('去掉網域');
    const na = j.alias ? Object.keys(j.alias).length : 0; if (na) out.push(`別名 ${na} 個`);
    if (n(j.classify)) out.push(`分類規則 ${n(j.classify)} 條`);
    if (j.group) out.push('分群');
    if (j.label && typeof j.label === 'object') out.push('顯示名稱'); // 字串的 label 是這份規則的名稱，不是顯示名稱規則
    if (n(j.zones)) out.push(`zone 標籤 ${n(j.zones)} 條`);
    return out.length ? out.join('、') : '沒有任何規則（只記錄 id）';
  }

  /** coverage 的欄位（和 annotate 回傳、建模時 applyProfile 寫入的註解相同） */
  const FIELDS = ['kind', 'role', 'site', 'group', 'label'];
  /**
   * 命名規則對某份基準的套用結果（只讀 Q，不改寫基準；相同輸入得到相同結果）：
   * 每台設備取基準中的名稱（names[0]，沒有時用 key），先經這份規則的 canon（alias／stripDomain），再 annotate；
   * 有任何一個註解欄位就算「對上」。建立基準時用的若是別的命名規則，名稱已經過那一份的 canon，所以這是預覽，
   * 實際結果以用這份規則重新建立的基準為準（applied 表示目前的基準就是用這份規則建立的：id 與內容雜湊相同）。
   * 回傳 { id, version, applied, total, matched, collected: { total, matched },
   *        unmatched: [{ key, name, collected }]（依名稱排序）, renamed: [{ key, name, canon }]（canon 會改名的）,
   *        fields: { kind|role|site|group|label: [{ value, count }]（台數多到少，同數依值） } }
   */
  function coverageOf(c, Q) {
    if (!Q || typeof Q.devices !== 'function' || typeof Q.meta !== 'function') throw new TypeError('coverage 需要基準的查詢介面（S.query(snapshot)）');
    const nat = S.util.natural;
    const counts = Object.fromEntries(FIELDS.map((f) => [f, new Map()]));
    const out = { id: c.id, version: c.version, applied: false, total: 0, matched: 0, collected: { total: 0, matched: 0 }, unmatched: [], renamed: [], fields: {} };
    for (const d of Q.devices()) {
      const name = (d.names && d.names[0]) || d.key;
      const canon = c.canon(name);
      if (canon !== name) out.renamed.push({ key: d.key, name, canon });
      const a = c.annotate(canon);
      const hit = FIELDS.some((f) => a[f] != null && a[f] !== '');
      out.total++; if (d.collected) out.collected.total++;
      if (hit) { out.matched++; if (d.collected) out.collected.matched++; } else out.unmatched.push({ key: d.key, name, collected: !!d.collected });
      FIELDS.forEach((f) => { if (a[f] != null && a[f] !== '') counts[f].set(a[f], (counts[f].get(a[f]) || 0) + 1); });
    }
    out.unmatched.sort((x, y) => nat(x.name, y.name) || nat(x.key, y.key));
    out.renamed.sort((x, y) => nat(x.name, y.name) || nat(x.key, y.key));
    FIELDS.forEach((f) => { out.fields[f] = Array.from(counts[f], ([value, count]) => ({ value, count })).sort((x, y) => y.count - x.count || nat(x.value, y.value)); });
    const used = Q.meta().profile;
    out.applied = !!(used && used.id === c.id && used.hash === hash(c.source));
    return out;
  }
  /** S.profile.coverage(json, Q)：編譯（有錯時丟出 compile 的錯誤）後回傳套用結果 */
  const coverage = (json, Q) => { const c = compile(json); if (!c) throw new TypeError('coverage 需要命名規則'); return coverageOf(c, Q); };

  /**
   * 命名規則全文的雜湊（鍵排序後的 JSON）：meta.baselineKey、meta.profile.hash 與 Q.zones 的核對共用這一個算法，
   * 同一個 id 與 version、內容不同的命名規則也能區分；鍵的順序不算差異。
   */
  const hash = (json) => S.util.hash(S.util.canonicalJson(json));

  S.profile = { compile, hash, describe, coverage, FIELDS, KINDS };
})(globalThis.SSOT = globalThis.SSOT || {});
