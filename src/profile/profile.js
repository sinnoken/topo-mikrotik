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
 *   "label":  { "match": "^(.*)$", "value": "$1" }
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
    const alias = new Map(Object.entries(json.alias || {}).map(([k, v]) => [String(k).trim().toUpperCase(), String(v)]));
    if (errs.length) throw new Error('命名規則檔有誤：\n- ' + errs.join('\n- '));

    return {
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
    };
  }

  S.profile = { compile, KINDS };
})(globalThis.SSOT = globalThis.SSOT || {});
