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
 * 另外兩個功能（同樣只透過查詢介面讀取，不修改基準）：
 *   S.compare.snapshots(qOld, qNew) → 兩份基準的差異（ssot-snapdiff/1）
 *   S.compare.expectedFrom(q, opts) → 由基準產生預期資料（ssot-expected/1），之後拿來和新的基準比對
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const LINK_SCOPE = S.LINK_SCOPE;

  function parseEp(s) {
    const m = String(s).trim().match(/^(\S.*?)\s+(\S+)$/);
    return m ? K.ep(m[1], m[2]) : null;
  }

  S.compare = function (Q, expected) {
    const errors = [];
    if (!expected || expected.schema !== 'ssot-expected/1') errors.push('預期資料的 schema 必須是 "ssot-expected/1"');
    const report = { schema: 'ssot-diff/1', errors, items: [], summary: { ok: 0, missing: 0, different: 0, unexpected: 0 } };
    if (errors.length) return report;
    const push = (status, type, ref, message) => { report.items.push({ status, type, ref, message }); report.summary[status]++; };

    const expDevs = new Set();
    (expected.devices || []).forEach((d) => {
      const o = typeof d === 'string' ? { name: d } : d;
      const k = K.dev(o.name); expDevs.add(k);
      const got = Q.getDevice(k);
      if (!got) return push('missing', 'device', k, `基準中沒有 ${o.name}`);
      if (!got.collected) return push('different', 'device', k, `${o.name} 僅由鄰居發現，沒有收集資料`);
      if (o.kind && got.kind !== o.kind) return push('different', 'device', k, `${o.name} 類型預期 ${o.kind}，基準為 ${got.kind}`);
      push('ok', 'device', k, o.name);
    });
    if (expected.devices && expected.strictDevices) {
      Q.devices().forEach((d) => { if (d.collected && !expDevs.has(d.key)) push('unexpected', 'device', d.key, `基準多出 ${d.name}`); });
    }

    const expLinks = new Set();
    (expected.links || []).forEach((l) => {
      const a = parseEp(l.a); const b = parseEp(l.b);
      if (!a || !b) { errors.push(`鏈路格式錯誤：${JSON.stringify(l)}（應為 "設備 介面"）`); return; }
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
    if (expected.links && expected.strictLinks) {
      Q.links().forEach((l) => { if (l.layer === 'l2' && l.evidenceScope !== LINK_SCOPE.BROADCAST_DOMAIN && !expLinks.has(l.key)) push('unexpected', 'link', l.key, `基準多出 ${Q.epName(l.a)} ⇄ ${Q.epName(l.b)}`); });
    }

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
   * 回傳 { schema: 'ssot-snapdiff/1', errors: string[], summary, items }：
   *   summary = { added, removed, changed, byCategory: { device|link|vlan|ip|firewall|finding: { added, removed, changed } } }
   *   items[] = { category, change: 'added'|'removed'|'changed', key, field, before, after, message, effect }（effect 只有 firewall 類別有值，其他為 null）
   *     device ：key＝設備鍵；新增／移除，或 field 為 kind／deviceType／softwareVersion 的改變（before／after 是欄位值）
   *     link   ：key＝鏈路鍵；只比 LLDP／CDP 介面鄰接（新增／移除）
   *     vlan   ：key＝「設備|VLAN ID」；設備上新增／移除
   *     ip     ：key＝IP（不含遮罩）；只比設備自有的位址（不含鄰居宣告）。新增／移除，或 field 為 interface（改到別的介面）／address（遮罩改變）
   *     firewall：key＝規則鍵（設備＋位址族＋表＋chain＋比對條件，不含編號）。新增／移除，或 field 為 action／disabled／match（同 chain 同動作、條件變窄或變寬）的改變；
   *               effect：new-exposure（新基準才有的 F03／F04／F05／F07 指向這條規則）／more-restrictive／less-restrictive／null（不影響放行，例如 jump、log、src-nat）
   *     finding：key＝Q.findingKey；以鍵的多重集合比對，同一個鍵兩邊都有就視為同一個問題（訊息改變不算差異）
   *   新增時 before 為 null，移除時 after 為 null。items 依類別（上列順序）、鍵、變更種類、欄位排序。
   * 兩份基準的 schema 不同（或不是本工具的 schema）時不比對：errors 說明原因，items 為空。
   */
  S.compare.snapshots = function (qOld, qNew) {
    const errors = [];
    const byCategory = {}; CATEGORIES.forEach((c) => { byCategory[c] = { added: 0, removed: 0, changed: 0 }; });
    const report = { schema: 'ssot-snapdiff/1', errors, summary: { added: 0, removed: 0, changed: 0, byCategory }, items: [] };
    const metaOf = (q) => (q && typeof q.meta === 'function' ? q.meta() || {} : null);
    const mo = metaOf(qOld); const mn = metaOf(qNew);
    if (!mo || !mn) { errors.push('需要兩份基準的查詢介面（SSOT.query(snapshot)）'); return report; }
    if (mo.schema !== mn.schema) {
      errors.push(`兩份基準的 schema 不同（舊：${mo.schema || '未標示'}，新：${mn.schema || '未標示'}），欄位意義可能不同，不比對；請用同一版工具從原始輸入重新建立`);
      return report;
    }
    if (mo.schema !== S.SCHEMA) { errors.push(`基準的 schema 是 ${mo.schema || '未標示'}，本工具只能比對 ${S.SCHEMA}；請從原始輸入重新建立`); return report; }

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

    // IP 位址（設備自有）：同一個 IP 可能在多個介面（例如重複設定），以 { ep, address } 清單比較
    const ipMap = (q) => {
      const out = new Map();
      q.ipAddresses().forEach((a) => { if (!a.hearsay) U.getOr(out, a.ip || a.address, () => []).push({ ep: a.ep, address: a.address }); });
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
    const findingMap = (q) => { const out = new Map(); q.findings().forEach((f) => U.getOr(out, q.findingKey(f), () => []).push(f)); return out; };
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
   * 由基準產生 ssot-expected/1：已收集的設備（含 kind）、已雙向確認的 LLDP／CDP 介面鄰接鏈路、各設備的 VLAN。
   * 用 S.compare 拿它和同一份基準比對時全部是 ok。
   * opts.strict：加上 strictDevices／strictLinks，之後的基準多出設備或鏈路時列為 unexpected
   *   （注意：未經雙向確認的鏈路不在預期資料內，strict 時同一份基準的這些鏈路也會列為 unexpected）。
   */
  S.compare.expectedFrom = function (q, opts) {
    const o = opts || {};
    const devices = q.devices().filter((d) => d.collected).map((d) => ({ name: devRef(d), kind: d.kind }))
      .sort((x, y) => U.natural(x.name, y.name));
    const links = q.links().filter((l) => isAdjacency(l) && l.verified).map((l) => ({ a: epRef(q, l.a), b: epRef(q, l.b) }))
      .sort((x, y) => U.natural(x.a, y.a) || U.natural(x.b, y.b));
    const vlans = q.vlans().filter((v) => v.id != null).map((v) => {
      const d = q.getDevice(v.dev);
      return Object.assign({ device: d ? devRef(d) : v.dev, id: v.id }, v.name ? { name: v.name } : {});
    }).sort((x, y) => U.natural(x.device, y.device) || x.id - y.id);
    const meta = q.meta();
    const out = { schema: 'ssot-expected/1', _說明: `由基準產生（輸入指紋 ${meta.inputHash}，${meta.schema}）`, devices, links, vlans };
    if (o.strict) { out.strictDevices = true; out.strictLinks = true; }
    return out;
  };
})(globalThis.SSOT = globalThis.SSOT || {});
