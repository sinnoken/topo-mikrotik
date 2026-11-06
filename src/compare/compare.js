/*
 * 比對（獨立模組）：把「預期資料」和基準比對，產生差異報告。
 * 預期資料有自己的格式，不共用 Snapshot 結構；只透過查詢介面（S.query）讀取基準，絕不修改基準。
 *
 * 預期資料格式 ssot-expected/1：
 * {
 *   "schema": "ssot-expected/1",
 *   "devices": [ "TPE_CORE_SW_01", { "name": "TPE_FW_01", "kind": "firewall" } ],
 *   "links":   [ { "a": "TPE_CORE_SW_01 xe-0/0/0", "b": "TPE_FW_01 port1" } ],
 *   "vlans":   [ { "device": "TPE_ACC_SW_01", "id": 20, "name": "SRV" } ]
 * }
 * 端點寫成「設備名 介面名」，以最後一個空白分隔（介面鍵不含空白，設備名可以有）。
 *
 * 選用欄位 source（expectedFrom 寫入）：{ baselineKey, inputHash, schema, createdAt }，記下預期資料由哪一份基準產生。
 * 沒有 source（手寫或 3.3.0（含）以前產生的檔案）時，S.compare 的結果不變；S.compare.drift 不能依來源切掉較早的基準。
 *
 * 另外三個功能（同樣只透過查詢介面讀取，不修改基準）：
 *   S.compare.snapshots(qOld, qNew) → 兩份基準的差異（ssot-snapdiff/1）
 *   S.compare.expectedFrom(q, opts) → 由基準產生預期資料（ssot-expected/1），之後拿來和新的基準比對
 *   S.compare.drift(q, expected, opts) → 連續幾輪基準和預期資料的偏離：預期資料可能已過時，或網路偏離預期（ssot-drift/1）
 *   S.compare.SCHEMA_EXPECTED／SCHEMA_DIFF／SCHEMA_SNAPDIFF／SCHEMA_DRIFT → 上述格式的 schema 字串（唯讀常數）
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const LINK_SCOPE = S.LINK_SCOPE;
  // 輸出與讀取的 schema（ADR-010）：程式內一律用這幾個常數，也匯出成 S.compare.SCHEMA_*（「關於」等處列出）
  const SCHEMA_EXPECTED = 'ssot-expected/1'; const SCHEMA_DIFF = 'ssot-diff/1'; const SCHEMA_SNAPDIFF = 'ssot-snapdiff/1'; const SCHEMA_DRIFT = 'ssot-drift/1';

  function parseEp(s) {
    if (typeof s !== 'string') return null; // 物件、數字等不轉字串（"[object Object]" 不是端點），交給呼叫端報格式錯誤
    const m = s.trim().match(/^(\S.*?)\s+(\S+)$/);
    return m ? K.ep(m[1], m[2]) : null;
  }
  // 錯誤與警告給人看：說明值的種類，不外露 JSON 原文
  const valueText = (v) => (v === undefined || v === null || v === '' ? '沒有填' : typeof v === 'string' ? `「${v}」`
    : typeof v === 'number' ? `數字 ${v}` : typeof v === 'boolean' ? '是非值' : Array.isArray(v) ? '陣列' : typeof v === 'object' ? '物件' : typeof v);

  S.compare = function (Q, expected) {
    const errors = [];
    if (!expected || expected.schema !== SCHEMA_EXPECTED) errors.push(`預期現況的格式版本（schema）必須是 ${SCHEMA_EXPECTED}（目前：${!expected ? '沒有內容' : typeof expected === 'object' && !Array.isArray(expected) ? valueText(expected.schema) : `整份不是物件，是${valueText(expected)}`}）`);
    const report = { schema: SCHEMA_DIFF, errors, items: [], summary: { ok: 0, missing: 0, different: 0, unexpected: 0 } };
    if (errors.length) return report;
    const push = (status, type, ref, message) => { report.items.push({ status, type, ref, message }); report.summary[status]++; };

    const expDevs = new Set();
    (expected.devices || []).forEach((d) => {
      const o = typeof d === 'string' ? { name: d } : d;
      const k = K.dev(o.name); expDevs.add(k);
      const got = Q.getDevice(k);
      if (!got) return push('missing', 'device', k, `基準中沒有 ${o.name}`);
      if (!got.collected) return push('different', 'device', k, `${o.name} 僅由鄰居發現，沒有收集資料`);
      if (o.kind && got.kind !== o.kind) return push('different', 'device', k, `${o.name} 類型預期 ${kindText(o.kind)}，基準為 ${kindText(got.kind)}`);
      push('ok', 'device', k, o.name);
    });
    const strictOf = strictExtrasOf(Q);
    if (expected.devices && expected.strictDevices) strictOf.device.forEach((x) => { if (!expDevs.has(x.key)) push('unexpected', 'device', x.key, x.text); });

    const expLinks = new Set();
    (expected.links || []).forEach((l, i) => {
      if (!l || typeof l !== 'object' || Array.isArray(l)) { errors.push(`預期現況的第 ${i + 1} 條鏈路格式錯誤：應為 { a: "設備 介面", b: "設備 介面" }，目前是${valueText(l)}`); return; }
      const a = parseEp(l.a); const b = parseEp(l.b);
      if (!a || !b) {
        const bad = [!a ? `a 端${valueText(l.a)}` : null, !b ? `b 端${valueText(l.b)}` : null].filter(Boolean).join('、');
        errors.push(`預期現況的第 ${i + 1} 條鏈路格式錯誤：${bad}；兩端都應為「設備 介面」（以最後一個空白分隔）`); return;
      }
      const key = K.link(a, b); expLinks.add(key);
      const got = Q.getLink(key);
      const devA = K.splitEp(a)[0]; const devB = K.splitEp(b)[0];
      const domainReachability = !!((got && got.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN)
        || Q.linksOf(devA).some((x) => x.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          && [K.splitEp(x.a)[0], K.splitEp(x.b)[0]].includes(devB)));
      // 這組介面本身有 LLDP／CDP 鄰接時以它為準；同一對設備另有 MNDP 觀察（例如在 bridge 上）不影響
      const direct = !!got && got.evidenceScope !== LINK_SCOPE.BROADCAST_DOMAIN;
      if (domainReachability && !direct) return push('different', 'link', key, `${l.a} ⇄ ${l.b} 只有 MNDP 的 L2 廣播網域可達證據，不能確認這組介面直連`);
      if (got) return push(got.verified ? 'ok' : 'different', 'link', key, got.verified ? `${l.a} ⇄ ${l.b}` : `${l.a} ⇄ ${l.b} 存在但未經雙向確認`);
      const ga = Q.linksOfEp(a).filter((x) => x.evidenceScope !== LINK_SCOPE.BROADCAST_DOMAIN);
      const gb = Q.linksOfEp(b).filter((x) => x.evidenceScope !== LINK_SCOPE.BROADCAST_DOMAIN);
      if (ga.length || gb.length) {
        const where = ga.concat(gb).map((x) => Q.epName(x.a) + ' ⇄ ' + Q.epName(x.b)).join('；');
        return push('different', 'link', key, `${l.a} ⇄ ${l.b} 不存在，實際為：${where}`);
      }
      push('missing', 'link', key, `基準中沒有 ${l.a} ⇄ ${l.b}`);
    });
    if (expected.links && expected.strictLinks) strictOf.link.forEach((x) => { if (!expLinks.has(x.key)) push('unexpected', 'link', x.key, x.text); });

    (expected.vlans || []).forEach((v) => {
      const dk = K.dev(v.device);
      const got = Q.vlansOf(dk).find((x) => x.id === +v.id);
      if (!got) return push('missing', 'vlan', dk + '|' + v.id, `${v.device} 沒有 VLAN ${v.id}`);
      if (v.name && got.name && got.name.toUpperCase() !== String(v.name).toUpperCase()) return push('different', 'vlan', dk + '|' + v.id, `${v.device} VLAN ${v.id} 名稱預期 ${v.name}，基準為 ${got.name}`);
      push('ok', 'vlan', dk + '|' + v.id, `${v.device} VLAN ${v.id}`);
    });
    return report;
  };

  // ------------------------------------------------------------------ 兩份基準的差異
  const U = S.util;
  const CATEGORIES = ['device', 'link', 'vlan', 'ip', 'firewall', 'finding'];
  const CHANGES = ['removed', 'added', 'changed'];
  const DEVICE_FIELDS = [['kind', '類型'], ['deviceType', '型號'], ['softwareVersion', '軟體版本']];
  const nil = (v) => (v === undefined ? null : v);
  const kindText = (k) => (k ? S.KIND_LABEL[k] || k : '不明');
  /** 介面鄰接（LLDP／CDP）的 L2 鏈路；MNDP 只證明廣播網域可達，不算直連。 */
  const isAdjacency = (l) => l.layer === 'l2' && l.evidenceScope === LINK_SCOPE.INTERFACE_ADJACENCY;

  /**
   * 比對兩份基準（舊 → 新），只透過查詢介面讀取。
   * 回傳 { schema: 'ssot-snapdiff/1', errors: string[], warnings, summary, items }：
   *   summary = { added, removed, changed, byCategory: { device|link|vlan|ip|firewall|finding: { added, removed, changed } } }
   *   items[] = { category, change: 'added'|'removed'|'changed', key, field, before, after, message, effect }（effect 只有 firewall 類別有值，其他為 null）
   *     device ：key＝設備鍵；新增／移除，或 field 為 kind／deviceType／softwareVersion 的改變（before／after 是欄位值）
   *     link   ：key＝鏈路鍵；只比 LLDP／CDP 介面鄰接（新增／移除）
   *     vlan   ：key＝「設備|VLAN ID」；設備上新增／移除
   *     ip     ：key＝位址鍵（IP 不含遮罩；非 main 的 VRF 加上 @<VRF>，見 S.keys.inVrf）；只比設備自有的位址（不含鄰居宣告）。
   *              新增／移除，或 field 為 interface（改到別的介面）／address（遮罩改變）。介面換到另一個 VRF 時是舊鍵移除、新鍵新增
   *     firewall：key＝規則鍵（設備＋位址族＋表＋chain＋比對條件，不含編號）。新增／移除，或 field 為 action／disabled／match（同 chain 同動作、條件變窄或變寬）的改變；
   *               effect：new-exposure（新基準才有的 F03／F04／F05／F07 指向這條規則）／more-restrictive／less-restrictive／null（不影響放行，例如 jump、log、src-nat）
   *     finding：key＝Q.findingKey；以鍵的多重集合比對，同一個鍵兩邊都有就視為同一個問題（訊息改變不算差異）。
   *              同一項檢查有任一邊的 finding 沒有 facet（例如 2.8.0 以前的基準）時，這項檢查兩邊都改用 Q.findingBaseKey（key 也是它）
   *   新增時 before 為 null，移除時 after 為 null。items 依類別（上列順序）、鍵、變更種類、欄位排序。
   * 兩份基準的 schema 不同（或不是本工具的 schema）時不比對：errors 說明原因，items 為空。
   * warnings[] = { kind: 'version'|'profile'|'profile-unverified', before, after, message }（依此順序，相同時不列）：schema 相同、照常比對，
   *   但差異可能來自程式或命名規則而不是網路。version 的 before／after 是 meta.version（沒有時為 null）；
   *   profile 與 profile-unverified 的是 meta.profile（{ id, version, hash } 或 null；hash 沒有時為 null）。
   *   profile：id、version 或內容雜湊不同（有一邊沒有命名規則也算）。profile-unverified：id 與 version 相同，
   *   但有一邊沒有 hash（2.11.0 以前的基準），無法確認內容相同；兩者最多出現一個。schema 不同而不比對時 warnings 為空。
   */
  S.compare.snapshots = function (qOld, qNew) {
    const errors = [];
    const byCategory = {}; CATEGORIES.forEach((c) => { byCategory[c] = { added: 0, removed: 0, changed: 0 }; });
    const warnings = [];
    const report = { schema: SCHEMA_SNAPDIFF, errors, warnings, summary: { added: 0, removed: 0, changed: 0, byCategory }, items: [] };
    const metaOf = (q) => (q && typeof q.meta === 'function' ? q.meta() || {} : null);
    const mo = metaOf(qOld); const mn = metaOf(qNew);
    if (!mo || !mn) { errors.push('需要兩份基準的查詢介面（SSOT.query(snapshot)）'); return report; }
    if (mo.schema !== mn.schema) {
      errors.push(`兩份基準的 schema 不同（舊：${mo.schema || '未標示'}，新：${mn.schema || '未標示'}），欄位意義可能不同，不比對；請用同一版工具從原始輸入重新建立`);
      return report;
    }
    if (mo.schema !== S.SCHEMA) { errors.push(`基準的 schema 是 ${mo.schema || '未標示'}，本工具只能比對 ${S.SCHEMA}；請從原始輸入重新建立`); return report; }
    // 程式版本或命名規則不同：照常比對，但提示部分差異可能不是網路改變（ADR-005）
    const vo = nil(mo.version); const vn = nil(mn.version);
    if (vo !== vn) {
      const t = (v) => (v == null ? '未標示' : v);
      warnings.push({ kind: 'version', before: vo, after: vn, message: `版本不同（${t(vo)} → ${t(vn)}）：新版才有的檢查會顯示為新出現，不代表網路改變` });
    }
    // 命名規則：id、version 與內容雜湊（meta.profile.hash，S.profile.hash 算出）。2.11.0 以前的基準沒有 hash，
    // id 與 version 相同時無法確認內容相同，以 profile-unverified 提示，不當成相同、也不當成不同
    const prof = (p) => (p ? { id: nil(p.id), version: nil(p.version), hash: nil(p.hash) } : null);
    const po = prof(mo.profile); const pn = prof(mn.profile);
    const t = (p) => (p ? `${p.id}（版本 ${p.version == null ? '未標示' : p.version}）` : '沒有');
    const sameName = po && pn ? po.id === pn.id && po.version === pn.version : po === pn;
    if (!sameName) {
      warnings.push({ kind: 'profile', before: po, after: pn, message: `命名規則不同（${t(po)} → ${t(pn)}）：設備名稱、類型與分群可能因此不同，這部分的差異不代表網路改變` });
    } else if (po && (po.hash == null || pn.hash == null)) {
      warnings.push({ kind: 'profile-unverified', before: po, after: pn, message: `命名規則都是 ${t(pn)}，但${po.hash == null && pn.hash == null ? '兩份' : po.hash == null ? '舊' : '新'}基準沒有記錄內容雜湊（2.11.0 以前建立），無法比對內容是否相同：內容若不同，設備名稱、類型與分群的差異不代表網路改變` });
    } else if (po && po.hash !== pn.hash) {
      warnings.push({ kind: 'profile', before: po, after: pn, message: `命名規則的內容不同（都是 ${t(pn)}，但內容雜湊不同）：設備名稱、類型與分群可能因此不同，這部分的差異不代表網路改變` });
    }

    const items = report.items;
    const push = (category, change, key, field, before, after, message) => {
      items.push({ category, change, key, field, before, after, message, effect: null });
      report.summary[change]++; byCategory[category][change]++;
    };
    /** 依鍵比對兩邊的清單：只在一邊的回報新增／移除，兩邊都有的交給 both。 */
    const diffMap = (oldMap, newMap, onRemoved, onAdded, both) => {
      oldMap.forEach((v, k) => { if (!newMap.has(k)) onRemoved(k, v); else if (both) both(k, v, newMap.get(k)); });
      newMap.forEach((v, k) => { if (!oldMap.has(k)) onAdded(k, v); });
    };

    // 設備
    const devSummary = (d) => ({ name: d.label || d.name, kind: nil(d.kind), deviceType: nil(d.deviceType), softwareVersion: nil(d.softwareVersion), collected: !!d.collected });
    const devMap = (q) => new Map(q.devices().map((d) => [d.key, d]));
    diffMap(devMap(qOld), devMap(qNew),
      (k, d) => push('device', 'removed', k, null, devSummary(d), null, `移除設備 ${qOld.devName(k)}（${kindText(d.kind)}）`),
      (k, d) => push('device', 'added', k, null, null, devSummary(d), `新增設備 ${qNew.devName(k)}（${kindText(d.kind)}）`),
      (k, a, b) => DEVICE_FIELDS.forEach(([field, label]) => {
        const x = nil(a[field]); const y = nil(b[field]);
        if (x === y) return;
        const fmt = field === 'kind' ? kindText : (v) => (v == null ? '（沒有資料）' : v);
        push('device', 'changed', k, field, x, y, `${qNew.devName(k)} ${label}：${fmt(x)} → ${fmt(y)}`);
      }));

    // 鏈路（介面鄰接）
    const linkSummary = (q, l) => ({ a: l.a, b: l.b, verified: !!l.verified, hearsay: !!l.hearsay, protocols: l.protocols || [] });
    const linkMap = (q) => new Map(q.links().filter(isAdjacency).map((l) => [l.key, l]));
    diffMap(linkMap(qOld), linkMap(qNew),
      (k, l) => push('link', 'removed', k, null, linkSummary(qOld, l), null, `移除鏈路 ${qOld.epName(l.a)} ⇄ ${qOld.epName(l.b)}`),
      (k, l) => push('link', 'added', k, null, null, linkSummary(qNew, l), `新增鏈路 ${qNew.epName(l.a)} ⇄ ${qNew.epName(l.b)}`));

    // VLAN
    const vlanMap = (q) => new Map(q.vlans().filter((v) => v.id != null).map((v) => [v.dev + '|' + v.id, v]));
    const vlanText = (q, v) => `${q.devName(v.dev)} VLAN ${v.id}${v.name ? `（${v.name}）` : ''}`;
    diffMap(vlanMap(qOld), vlanMap(qNew),
      (k, v) => push('vlan', 'removed', k, null, { dev: v.dev, id: v.id, name: nil(v.name) }, null, `移除 ${vlanText(qOld, v)}`),
      (k, v) => push('vlan', 'added', k, null, null, { dev: v.dev, id: v.id, name: nil(v.name) }, `新增 ${vlanText(qNew, v)}`));

    // IP 位址（設備自有）：同一個 IP 可能在多個介面（例如重複設定），以 { ep, address } 清單比較。
    // 鍵是位址鍵 K.inVrf（ADR-015）：不同 VRF 的同一個 IP 是不同的鍵，不會併在一起；main（vrf 為 null 時也是）不加後綴
    const ipMap = (q) => {
      const out = new Map();
      q.ipAddresses().forEach((a) => { if (!a.hearsay) U.getOr(out, K.inVrf(a.ip || a.address, a.vrf), () => []).push({ ep: a.ep, address: a.address }); });
      out.forEach((list) => list.sort((x, y) => U.natural(x.ep, y.ep) || U.natural(x.address, y.address)));
      return out;
    };
    const where = (q, list) => list.map((x) => `${q.epName(x.ep)}（${x.address}）`).join('、');
    diffMap(ipMap(qOld), ipMap(qNew),
      (k, list) => push('ip', 'removed', k, null, list, null, `移除位址 ${k}：${where(qOld, list)}`),
      (k, list) => push('ip', 'added', k, null, null, list, `新增位址 ${k}：${where(qNew, list)}`),
      (k, a, b) => {
        const eps = (list) => list.map((x) => x.ep).join('\u0000');
        if (eps(a) !== eps(b)) push('ip', 'changed', k, 'interface', a, b, `${k} 改到別的介面：${where(qOld, a)} → ${where(qNew, b)}`);
        else if (a.map((x) => x.address).join() !== b.map((x) => x.address).join()) push('ip', 'changed', k, 'address', a, b, `${k} 的遮罩改變：${a.map((x) => x.address).join('、')} → ${b.map((x) => x.address).join('、')}`);
      });

    // 防火牆規則：鍵＝設備＋位址族＋表＋chain＋比對條件（不含編號），插入規則時其他規則不會變成差異
    // item.key 就是 rule.key（Snapshot 的 firewallRules[].key），定位時用 Q.getFirewallRule(item.key)；要查哪一份基準依 change 決定：
    //   added、changed（action／disabled／match）→ 新基準的 qNew.getFirewallRule(key)；changed 的 action／disabled 鍵在兩份都存在
    //   removed → 只存在於舊基準，用 qOld.getFirewallRule(key)（新基準查不到，回傳 null）
    //   changed 的 match → key 是新規則的鍵，舊規則的鍵在 before.key（兩者不同）
    // 同一 chain 內簽章相同的重複規則，第二條以後鍵帶 #n（依出現順序編號）：刪掉前面那條時，後面那條會接手原本的鍵，
    // 比對結果顯示為移除 #n，而不是實際刪掉的那一條；定位到的是目前排第 n 個的那條。
    const fwSum = (r) => ({ key: r.key, position: r.position, action: r.action, disabled: !!r.disabled, comment: nil(r.comment), match: r.match, params: r.params });
    const fwText = (q, r) => {
      const m = Object.keys(r.match).sort().map((k) => `${k}=${r.match[k]}`).join(' ');
      return `${q.devName(r.dev)} ${r.family === 'ipv6' ? 'IPv6' : 'IPv4'} ${r.table} ${r.chain} 第 ${r.position} 條（${r.action}${m ? ' ' + m : ''}）`;
    };
    // 放行方向：accept 與 dst-nat 讓封包通過（+1），drop／reject／tarpit 擋下（-1），其他（jump、log、src-nat…）不判斷（0）
    const permits = (a) => (a === 'accept' || a === 'dst-nat' || a === 'netmap' ? 1 : a === 'drop' || a === 'reject' || a === 'tarpit' ? -1 : 0);
    const effectOf = (delta) => (delta > 0 ? 'less-restrictive' : delta < 0 ? 'more-restrictive' : null);
    // 新增可連入點：新基準才有的 F03／F04／F05／F07（依 findingKey）所指的規則
    const EXPOSURE = new Set(['F03', 'F04', 'F05', 'F07']);
    const oldKeys = new Set(qOld.findings().filter((f) => EXPOSURE.has(f.id)).map(qOld.findingKey));
    const exposed = new Set();
    qNew.findings().forEach((f) => { if (EXPOSURE.has(f.id) && !oldKeys.has(qNew.findingKey(f))) f.entities.forEach((e) => { if (e.type === 'rule') exposed.add(e.key); }); });
    const withExposure = (rule, effect) => (rule && exposed.has(rule.key) ? 'new-exposure' : effect);
    const fwPush = (change, key, field, before, after, message, effect) => {
      items.push({ category: 'firewall', change, key, field, before, after, message, effect });
      report.summary[change]++; byCategory.firewall[change]++;
    };
    const rulesOf = (q) => new Map((q.firewallRules ? q.firewallRules() : []).map((r) => [r.key, r]));
    const ro = rulesOf(qOld); const rn = rulesOf(qNew);
    const gone = []; const fresh = [];
    diffMap(ro, rn, (k, r) => gone.push(r), (k, r) => fresh.push(r), (k, a, b) => {
      if (a.action !== b.action) fwPush('changed', k, 'action', a.action, b.action, `${fwText(qNew, b)} 動作：${a.action} → ${b.action}`, withExposure(b, effectOf(permits(b.action) - permits(a.action))));
      if (!!a.disabled !== !!b.disabled) {
        fwPush('changed', k, 'disabled', !!a.disabled, !!b.disabled, `${fwText(qNew, b)} ${b.disabled ? '已停用' : '已啟用'}`,
          withExposure(b, effectOf(b.disabled ? -permits(b.action) : permits(b.action))));
      }
    });
    // 條件改變的規則會變成「移除＋新增」：同一個 chain、同動作、新舊條件互相涵蓋（變窄或變寬）時配成一筆 match 改變
    const chainOf = (r) => [r.dev, r.family, r.table, r.chain, r.action].join('\u0000');
    const paired = new Set();
    fresh.forEach((b) => {
      const a = gone.find((x) => !paired.has(x) && chainOf(x) === chainOf(b) && qNew.firewallCovers && (qNew.firewallCovers(x, b) !== qNew.firewallCovers(b, x)));
      if (!a) return;
      paired.add(a); paired.add(b);
      const narrower = qNew.firewallCovers(a, b); // 舊的涵蓋新的＝條件變多
      fwPush('changed', b.key, 'match', fwSum(a), fwSum(b), `${fwText(qNew, b)} 比對條件${narrower ? '變窄' : '變寬'}（原為 ${fwText(qOld, a)}）`,
        withExposure(b, effectOf(narrower ? -permits(b.action) : permits(b.action))));
    });
    gone.filter((r) => !paired.has(r)).forEach((r) => fwPush('removed', r.key, null, fwSum(r), null, `移除 ${fwText(qOld, r)}`, r.disabled ? null : effectOf(-permits(r.action))));
    fresh.filter((r) => !paired.has(r)).forEach((r) => fwPush('added', r.key, null, null, fwSum(r), `新增 ${fwText(qNew, r)}`, withExposure(r, r.disabled ? null : effectOf(permits(r.action)))));

    // finding：鍵的多重集合。同一個鍵先配對訊息相同的，其餘依基準中的順序配對；配不到的才是新增／消失
    // facet（2.9.0）：同一項檢查只要任一邊有不帶 facet 的 finding（2.8.0 以前的基準），這項檢查兩邊都改用 findingBaseKey，
    // 否則同一個問題會變成「消失＋新出現」。同一份基準內，一項檢查的 finding 不是都有 facet 就是都沒有（checks.js 檢查），
    // 所以同版本的比對不受影響；沒有 facet 的檢查 findingBaseKey 與 findingKey 相同。退回時 item.key 是 findingBaseKey。
    const noFacet = new Set();
    [qOld, qNew].forEach((q) => q.findings().forEach((f) => { if (f.facet == null) noFacet.add(f.id); }));
    const keyOf = (q, f) => (noFacet.has(f.id) ? q.findingBaseKey(f) : q.findingKey(f));
    const findingMap = (q) => { const out = new Map(); q.findings().forEach((f) => U.getOr(out, keyOf(q, f), () => []).push(f)); return out; };
    const fo = findingMap(qOld); const fn = findingMap(qNew);
    const fSummary = (f) => ({ id: f.id, severity: f.severity, title: f.title, message: f.message });
    new Set([...fo.keys(), ...fn.keys()]).forEach((k) => {
      const a = (fo.get(k) || []).slice(); const b = (fn.get(k) || []).slice();
      for (let i = a.length - 1; i >= 0; i--) { const j = b.findIndex((x) => x.message === a[i].message); if (j >= 0) { a.splice(i, 1); b.splice(j, 1); } }
      const paired = Math.min(a.length, b.length);
      a.slice(paired).forEach((f) => push('finding', 'removed', k, null, fSummary(f), null, `已消失 ${f.id} ${f.title}：${f.message}`));
      b.slice(paired).forEach((f) => push('finding', 'added', k, null, null, fSummary(f), `新出現 ${f.id} ${f.title}：${f.message}`));
    });

    const fieldOrder = (x) => (x.field ? 1 + DEVICE_FIELDS.findIndex(([f]) => f === x.field) : 0);
    items.sort((x, y) => CATEGORIES.indexOf(x.category) - CATEGORIES.indexOf(y.category) || U.natural(x.key, y.key)
      || CHANGES.indexOf(x.change) - CHANGES.indexOf(y.change) || fieldOrder(x) - fieldOrder(y) || U.cmp(x.field || '', y.field || '') || U.natural(x.message, y.message));
    return report;
  };

  // ------------------------------------------------------------------ 由基準產生預期資料
  /** 名稱經 K.dev／K.ifc 正規化後仍對回同一個鍵時用名稱（好讀），否則用鍵本身（例如命名規則改過名稱、介面名有空白或 .0 結尾）。 */
  const devRef = (d) => (K.dev(d.name) === d.key ? d.name : d.key);
  const epRef = (q, ep) => {
    const [dk, ik] = K.splitEp(ep); const d = q.getDevice(dk); const i = q.getInterface(ep);
    return `${d ? devRef(d) : dk} ${i && K.ifc(i.name) === ik ? i.name : ik}`;
  };

  /**
   * 「多出的實體」有兩個納入規則，各有用途，刻意不同：
   *   strictExtrasOf：strictDevices／strictLinks 時「基準不該有、預期資料卻沒列」的實體——已收集的設備、
   *     LLDP／CDP 的 L2 鏈路（含未經雙向確認的；單向看到的鄰居也是網路上的連接，strict 要列出）。S.compare 與 drift 的 strict 共用。
   *   currentOf：expectedFrom「會寫進預期資料」的實體——已收集的設備、已雙向確認的介面鄰接鏈路、有 VLAN ID 的 VLAN。
   *     只寫雙向確認的鏈路，是為了讓產生的預期資料只含有把握的事實；drift 在預期資料有 source、沒有 strict 時也用它，
   *     「多出」才和 expectedFrom 對得上（否則未經雙向確認的鏈路每一輪都會被當成多出）。
   * 每筆帶比對用的鍵、所屬設備（devs）與「基準多出 …」的訊息。
   */
  const extraLink = (q, l) => ({ key: l.key, devs: U.uniq([K.splitEp(l.a)[0], K.splitEp(l.b)[0]]), text: `基準多出 ${q.epName(l.a)} ⇄ ${q.epName(l.b)}` });
  function strictExtrasOf(q) {
    const device = q.devices().filter((d) => d.collected).map((d) => ({ key: d.key, devs: [d.key], text: `基準多出 ${d.name}` }));
    const link = q.links().filter((l) => l.layer === 'l2' && l.evidenceScope !== LINK_SCOPE.BROADCAST_DOMAIN).map((l) => extraLink(q, l));
    return { device, link };
  }
  function currentOf(q) {
    const device = q.devices().filter((d) => d.collected)
      .map((d) => ({ key: d.key, devs: [d.key], name: devRef(d), kind: d.kind, text: `基準多出 ${q.devName(d.key)}` }));
    const link = q.links().filter((l) => isAdjacency(l) && l.verified).map((l) => Object.assign(extraLink(q, l), { a: epRef(q, l.a), b: epRef(q, l.b) }));
    const vlan = q.vlans().filter((v) => v.id != null).map((v) => {
      const d = q.getDevice(v.dev);
      return { key: v.dev + '|' + v.id, devs: [v.dev], device: d ? devRef(d) : v.dev, id: v.id, name: v.name || null,
        text: `基準多出 ${q.devName(v.dev)} VLAN ${v.id}${v.name ? `（${v.name}）` : ''}` };
    });
    return { device, link, vlan };
  }

  /**
   * 由基準產生 ssot-expected/1：已收集的設備（含 kind）、已雙向確認的 LLDP／CDP 介面鄰接鏈路、各設備的 VLAN。
   * 用 S.compare 拿它和同一份基準比對時全部是 ok。
   * source：產生它的基準 { baselineKey, inputHash, schema, createdAt }（沒有的欄位為 null），供 drift 判斷哪些基準在它之後。
   * opts.strict：加上 strictDevices／strictLinks，之後的基準多出設備或鏈路時列為 unexpected
   *   （注意：未經雙向確認的鏈路不在預期資料內，strict 時同一份基準的這些鏈路也會列為 unexpected）。
   */
  S.compare.expectedFrom = function (q, opts) {
    const o = opts || {};
    const cur = currentOf(q);
    const devices = cur.device.map((d) => ({ name: d.name, kind: d.kind })).sort((x, y) => U.natural(x.name, y.name));
    const links = cur.link.map((l) => ({ a: l.a, b: l.b })).sort((x, y) => U.natural(x.a, y.a) || U.natural(x.b, y.b));
    const vlans = cur.vlan.map((v) => Object.assign({ device: v.device, id: v.id }, v.name ? { name: v.name } : {}))
      .sort((x, y) => U.natural(x.device, y.device) || x.id - y.id);
    const meta = q.meta();
    const source = { baselineKey: nil(meta.baselineKey), inputHash: nil(meta.inputHash), schema: nil(meta.schema), createdAt: nil(meta.createdAt) };
    const out = { schema: SCHEMA_EXPECTED, _說明: `由基準產生（輸入指紋 ${meta.inputHash}，${meta.schema}）`, source, devices, links, vlans };
    if (o.strict) { out.strictDevices = true; out.strictLinks = true; }
    return out;
  };

  // ------------------------------------------------------------------ 預期資料的漂移
  const DRIFT_TYPES = ['device', 'link', 'vlan'];
  /** 預設：連續 2 輪（目前與上一輪）都不符才推論預期資料已過時。畫面通常只有這兩輪；CLI 可傳更多輪與更大的門檻。 */
  const DRIFT_ROUNDS = 2;
  const isStr = (v) => typeof v === 'string' && v !== '';
  /**
   * 同一次收集：兩邊都有 inputHash 時比它，否則退回比 baselineKey（baselineKey 含 inputHash，相同時必是同一次收集）。
   * 和處理紀錄不同：處理紀錄用 baselineKey 判斷「這一輪推進過沒」，關心的是規則版本（major.minor、命名規則、expectedData）；
   * 漂移數的是網路被觀察了幾次，同一份收集檔以不同版本或選項重建仍只是一次觀察，所以看 inputHash。
   */
  const sameCollection = (x, y) => (x.inputHash && y.inputHash ? x.inputHash === y.inputHash : !!x.baselineKey && x.baselineKey === y.baselineKey);

  /** expected.source 的正規化；沒有時為 null，格式不對時加 warning 並視為沒有。 */
  function sourceOf(e, warnings) {
    if (e.source === undefined || e.source === null) {
      warnings.push({ kind: 'no-source', message: '預期現況沒有記錄由哪一份基準產生（手寫或較舊的檔案）：所有基準都列入判斷；基準多出的設備或鏈路，只在開啟嚴格比對設備／鏈路（strictDevices／strictLinks）時檢查' });
      return null;
    }
    const s = e.source;
    const ok = s && typeof s === 'object' && !Array.isArray(s)
      && ['baselineKey', 'inputHash', 'schema', 'createdAt'].every((k) => s[k] == null || isStr(s[k])) && (isStr(s.baselineKey) || isStr(s.inputHash));
    if (!ok) {
      const isObj = s && typeof s === 'object' && !Array.isArray(s);
      const FIELD = { baselineKey: '基準鍵', inputHash: '輸入雜湊', schema: '格式版本', createdAt: '建立時間' };
      const why = !isObj ? [`應為含基準鍵、輸入雜湊、格式版本與建立時間的物件，目前是${valueText(s)}`]
        : Object.keys(FIELD).filter((k) => s[k] != null && !isStr(s[k])).map((k) => `${FIELD[k]}（${k}）應為文字，目前是${valueText(s[k])}`)
          .concat(isStr(s.baselineKey) || isStr(s.inputHash) ? [] : ['至少要有基準鍵（baselineKey）或輸入雜湊（inputHash）']);
      warnings.push({ kind: 'source-invalid', message: `預期現況記錄的來源基準（source）格式不對，視為沒有來源：${why.join('；')}` });
      return null;
    }
    return { baselineKey: nil(s.baselineKey), inputHash: nil(s.inputHash), schema: nil(s.schema), createdAt: nil(s.createdAt) };
  }

  /**
   * 預期資料的漂移（ssot-drift/1）：把預期資料和連續幾輪基準比對，區分「預期資料可能已過時」與「網路偏離預期」。
   *   q：目前的基準（SSOT.query）；opts.history：之前的基準（舊 → 新，不含目前這一份），預設 []；
   *   opts.rounds：連續幾輪不符才推論為過時，預設 DRIFT_ROUNDS（≥ 1 的整數）。
   * 只透過查詢介面讀取，不修改基準與預期資料；相同輸入得到相同結果。
   *
   * 事實（每一輪）：S.compare 對預期資料中每一項的結果（ok／missing／different），以及預期資料沒有的實體（unexpected）：
   *   strict 的類別用 strictExtrasOf（與 S.compare 的 strict 同一個規則，結果一致）；只有 source 的類別用 currentOf（與 expectedFrom 同一個納入規則）。
   * 未觀察：該項目所屬的設備在這一輪有收集失敗（coverage[].failures）而且不是 ok 時，這一輪不算（不計入、也不中斷連續）。
   * 推論：從最新一輪往回數，連續不符的輪數 k（只數有觀察到的輪）：
   *   預期的項目：k ≥ rounds → stale（預期資料可能已過時）；1 ≤ k < rounds → drifted（網路偏離預期，可能是剛發生的改變或暫時狀態）。
   *   多出的實體：只在這一類「預期資料應該是完整的」時檢查——strictDevices／strictLinks 開啟（strict），或預期資料有 source（由基準整份產生）。
   *     k ≥ rounds → stale；k < rounds 時，strict 列為 drifted，只有 source 的不列（沒有 strict 時多出不算偏離）。VLAN 沒有 strict，只依 source。
   * 基準的取捨：同一次收集（sameCollection，看 inputHash）只算第一次；有 source 時，排在來源基準之前、或 createdAt 早於來源的基準不算（before-source）。
   *
   * 回傳 { schema, errors, warnings, basis, summary: { stale, drifted, unobserved }, stale, drifted, unobserved }：
   *   stale／drifted[] = { type: device|link|vlan, ref, change: missing|different|unexpected, rounds: k, observed, since, message }
   *     ref 與 S.compare 的 ref 相同（設備鍵、鏈路鍵、「設備|VLAN ID」）；change 與 message 是最新一次不符時的內容；
   *     observed 是有觀察到的輪數；since 是連續不符的第一輪 { baselineKey, inputHash, createdAt }。
   *   unobserved[] = { type, ref }：預期的項目在所有列入的輪都未觀察，無法判斷。
   *   依類別（device、link、vlan）、ref 排序。
   *   basis = { rounds, source, sourceInHistory, extras: { device, link, vlan }（'strict'｜'source'｜null：是否檢查多出的實體與依據），
   *             history: [{ baselineKey, inputHash, createdAt, used, reason: null|'duplicate'|'before-source' }]（輸入順序，最後一筆是 q） }
   *   warnings[] = { kind, message }，依序：no-source｜source-invalid、no-rounds、too-few-rounds。
   * 參數或預期資料格式錯誤時，errors 說明原因，其他欄位為空。
   */
  S.compare.drift = function (q, expected, opts) {
    const o = opts || {};
    const errors = []; const warnings = [];
    const report = { schema: SCHEMA_DRIFT, errors, warnings, basis: null, summary: { stale: 0, drifted: 0, unobserved: 0 }, stale: [], drifted: [], unobserved: [] };
    const N = o.rounds === undefined ? DRIFT_ROUNDS : o.rounds;
    if (!Number.isInteger(N) || N < 1) errors.push(`判斷輪數（rounds）必須是 ≥ 1 的整數（目前：${valueText(N)}）`);
    const history = o.history === undefined ? [] : o.history;
    if (!Array.isArray(history)) errors.push(`之前的基準（history）必須是查詢介面的陣列，由舊到新（目前：${valueText(history)}）`);
    const all = (Array.isArray(history) ? history : []).concat([q]);
    if (all.some((x) => !x || typeof x.meta !== 'function')) errors.push('需要基準的查詢介面（SSOT.query(snapshot)）');
    if (errors.length) return report;
    const probe = S.compare(q, expected);
    if (probe.errors.length) { errors.push(...probe.errors); return report; }

    const source = sourceOf(expected, warnings);
    const rows = all.map((x, i) => { const m = x.meta() || {}; return { q: x, i, baselineKey: nil(m.baselineKey), inputHash: nil(m.inputHash), createdAt: nil(m.createdAt), used: true, reason: null }; });
    rows.forEach((r, i) => { if (rows.slice(0, i).some((x) => x.used && sameCollection(x, r))) { r.used = false; r.reason = 'duplicate'; } });
    const at = source ? rows.findIndex((r) => sameCollection(r, source)) : -1;
    if (source) {
      const t0 = Date.parse(source.createdAt);
      rows.forEach((r) => {
        const t = Date.parse(r.createdAt);
        if (r.used && ((at >= 0 && r.i < at) || (!isNaN(t0) && !isNaN(t) && t < t0))) { r.used = false; r.reason = 'before-source'; }
      });
    }
    const strict = { device: !!(expected.devices && expected.strictDevices), link: !!(expected.links && expected.strictLinks), vlan: false };
    const extras = {}; DRIFT_TYPES.forEach((t) => { extras[t] = strict[t] ? 'strict' : source ? 'source' : null; });
    report.basis = { rounds: N, source, sourceInHistory: source ? at >= 0 : null, extras,
      history: rows.map((r) => ({ baselineKey: r.baselineKey, inputHash: r.inputHash, createdAt: r.createdAt, used: r.used, reason: r.reason })) };
    const used = rows.filter((r) => r.used);
    if (!used.length) { warnings.push({ kind: 'no-rounds', message: '沒有可以判斷的基準：全部都早於預期現況的來源基準' }); return report; }
    if (used.length < N) warnings.push({ kind: 'too-few-rounds', message: `只有 ${used.length} 輪基準可以判斷，少於 ${N} 輪：目前不會推論為「預期現況可能已過時」，只列出網路與預期不同的項目` });

    // 預期的項目與所屬設備（鍵的寫法與 S.compare 相同）
    const expOwners = new Map(); const tk = (type, ref) => type + '\u0000' + ref;
    (expected.devices || []).forEach((d) => { const k = K.dev(typeof d === 'string' ? d : d.name); expOwners.set(tk('device', k), [k]); });
    (expected.links || []).forEach((l) => { const a = parseEp(l.a); const b = parseEp(l.b); expOwners.set(tk('link', K.link(a, b)), U.uniq([K.splitEp(a)[0], K.splitEp(b)[0]])); });
    (expected.vlans || []).forEach((v) => { const dk = K.dev(v.device); expOwners.set(tk('vlan', dk + '|' + v.id), [dk]); });
    // 每一輪的狀態：{ off: false } ok／不在、{ off: true, change, message } 不符、null 未觀察
    const track = new Map(); // tk → { type, ref, extra, states: [] }
    const stateOf = (type, ref, extra) => U.getOr(track, tk(type, ref), () => ({ type, ref, extra, owners: null, states: new Array(used.length).fill(undefined) }));
    const failedOf = used.map((r) => new Set(r.q.coverage().filter((c) => (c.failures || []).length).map((c) => c.dev)));
    used.forEach((r, n) => {
      const blind = (devs) => devs.some((d) => failedOf[n].has(d));
      S.compare(r.q, Object.assign({}, expected, { strictDevices: false, strictLinks: false })).items.forEach((it) => {
        const t = stateOf(it.type, it.ref, false);
        if (t.states[n] !== undefined) return; // 預期資料重複列出同一項時以第一筆為準
        t.states[n] = it.status === 'ok' ? { off: false } : blind(expOwners.get(tk(it.type, it.ref)) || []) ? null : { off: true, change: it.status, message: it.message };
      });
      const cur = currentOf(r.q); const str = strictExtrasOf(r.q);
      DRIFT_TYPES.forEach((type) => {
        if (!extras[type]) return;
        (extras[type] === 'strict' ? str : cur)[type].forEach((x) => {
          if (expOwners.has(tk(type, x.key))) return;
          const t = stateOf(type, x.key, true);
          t.owners = x.devs; t.states[n] = { off: true, change: 'unexpected', message: x.text };
        });
      });
    });
    // 多出的實體在某一輪不在：所屬設備（出現時記下）那一輪有收集失敗時是未觀察，否則是不在（與預期一致）
    used.forEach((r, n) => {
      track.forEach((t) => { if (t.extra && t.states[n] === undefined) t.states[n] = t.owners.some((d) => failedOf[n].has(d)) ? null : { off: false }; });
    });

    const since = (r) => ({ baselineKey: r.baselineKey, inputHash: r.inputHash, createdAt: r.createdAt });
    const order = (x, y) => DRIFT_TYPES.indexOf(x.type) - DRIFT_TYPES.indexOf(y.type) || U.natural(x.ref, y.ref);
    Array.from(track.values()).sort(order).forEach((t) => {
      let k = 0; let first = -1; let latest = null; let observed = 0; let broken = false;
      for (let n = used.length - 1; n >= 0; n--) {
        const s = t.states[n];
        if (!s) continue;
        observed++;
        if (broken) continue;
        if (!s.off) { broken = true; continue; }
        k++; first = n; if (!latest) latest = s;
      }
      if (!observed) { if (!t.extra) report.unobserved.push({ type: t.type, ref: t.ref }); return; }
      if (!k) return;
      const verdict = k >= N ? 'stale' : !t.extra || extras[t.type] === 'strict' ? 'drifted' : null;
      if (!verdict) return;
      report[verdict].push({ type: t.type, ref: t.ref, change: latest.change, rounds: k, observed, since: since(used[first]), message: latest.message });
    });
    report.summary = { stale: report.stale.length, drifted: report.drifted.length, unobserved: report.unobserved.length };
    return report;
  };

  // schema 常數唯讀（不可寫、不可重新設定）
  Object.entries({ SCHEMA_EXPECTED, SCHEMA_DIFF, SCHEMA_SNAPDIFF, SCHEMA_DRIFT }).forEach(([k, v]) => Object.defineProperty(S.compare, k, { value: v, enumerable: true }));
})(globalThis.SSOT = globalThis.SSOT || {});
