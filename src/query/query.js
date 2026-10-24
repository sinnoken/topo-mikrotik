/*
 * 唯讀查詢介面：畫面與比對模組只能透過這裡讀 Snapshot，不直接碰內部陣列。
 * const Q = SSOT.query(snapshot);
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const U = S.util;

  /**
   * finding 的穩定鍵：id、facet（有時），再加上排序、去重後的 entities（type:key），不含 message、evidence 與行號，
   * 所以同一個問題在兩份基準之間（訊息文字或行號改變時）仍對得上。以 JSON 陣列字串表示，避免分隔符號與鍵內容混淆。
   *   沒有 facet：["A09","interface:A|ether5","ip:10.0.10.1"]（與 2.9.0 之前相同）
   *   有 facet：  ["A12","facet:dns","device:VA","device:VB"]
   * facet 固定放在第 2 個元素、不參與排序，並以 "facet:" 開頭；entity 的 type 不會是 facet（有測試檢查），所以不會和實體鍵混淆。
   * facet 只出現在同一組 id＋實體可能產生多筆的規則（CATALOG 有宣告 facet 的規則，例如 A12 的 dns／ntp），
   * 值取自設定的項目與正規化後的設定值，不取自訊息、設備名稱或行號（見 check/catalog.js）。
   * 仍可能碰撞（id、facet、entities 都相同、只差訊息）：例如同一台設備的多段 I01、I03，沒有設備的 I01（entities 為空）。
   * 需要逐筆對應時以鍵為多重集合處理（見 compare.snapshots）。
   */
  const entityKeys = (f) => U.uniq((f.entities || []).map((e) => e.type + ':' + e.key)).sort(U.cmp);
  const findingKey = (f) => JSON.stringify([f.id].concat(f.facet != null ? ['facet:' + f.facet] : [], entityKeys(f)));
  /**
   * 不含 facet 的鍵（id＋entities）：2.9.0 之前的 findingKey 就是這個形式。
   * 給處理紀錄等轉換舊鍵用：舊鍵等於這個值的項目，對應到 facet 不同的每一筆。沒有 facet 的 finding 與 findingKey 相同。
   */
  const findingBaseKey = (f) => JSON.stringify([f.id].concat(entityKeys(f)));
  /** 鏈路類別的強弱（一條線併了多條鏈路時取最前面的）：devicePairs 與 portGraph 共用。 */
  const CLS_RANK = ['lag', '40g', '10g', '1g', 'oob', 'other'];
  const clsRank = (c) => { const i = CLS_RANK.indexOf(c); return i < 0 ? CLS_RANK.length : i; };
  /** Q 自己建立的衍生物件（不含 Snapshot 的物件）整個凍結，呼叫端改不壞快取。 */
  const deepFreeze = (o) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
    return o;
  };
  const copySrc = (src) => (src || []).map((x) => x.slice());
  const oneOf = (name, v, allowed) => {
    if (v === undefined) return allowed[0];
    if (!allowed.includes(v)) throw new TypeError(`${name} 只能是 ${allowed.map((x) => JSON.stringify(x)).join('、')}，收到 ${JSON.stringify(v)}`);
    return v;
  };

  S.query = function (snap) {
    const m = snap.model;
    const dev = new Map(m.devices.map((d) => [d.key, d]));
    const ifc = new Map(m.interfaces.map((i) => [i.key, i]));
    const link = new Map(m.links.map((l) => [l.key, l]));
    const mac = new Map(m.macs.map((x) => [x.mac, x]));
    const ifcsByDev = new Map(); const linksByDev = new Map(); const linksByEp = new Map();
    const ospfByDev = new Map();
    m.interfaces.forEach((i) => U.getOr(ifcsByDev, i.dev, () => []).push(i));
    m.links.forEach((l) => {
      [l.a, l.b].forEach((ep) => {
        U.getOr(linksByEp, ep, () => []).push(l);
        const d = K.splitEp(ep)[0];
        const arr = U.getOr(linksByDev, d, () => []); if (!arr.includes(l)) arr.push(l);
      });
    });
    (m.ospfAdjacencies || []).forEach((a) => U.getOr(ospfByDev, a.dev, () => []).push(a));
    // 以 IP 為鍵的索引都用 K.inVrf(ip, vrf)：main 不加後綴，其他 VRF 加 @<VRF>（ADR-015）
    const MAIN = K.MAIN_VRF;
    const ipOwner = new Map(); const subnets = []; const ipsByEp = new Map(); const heard = new Map(); const ownersByIp = new Map();
    m.ipAddresses.forEach((a) => {
      U.getOr(ipsByEp, a.ep, () => []).push(a);
      if (a.ip === null) return;
      const vrf = K.vrf(a.vrf); const key = K.inVrf(a.ip, vrf);
      if (a.hearsay) { U.getOr(heard, key, () => []).push(a.ep); return; } // 鄰居宣告的位址：事實但非設備自有
      ipOwner.set(key, a.ep);
      const net = a.len < 32 ? S.ip.parseCidr(a.address).net : null;
      U.getOr(ownersByIp, a.ip, () => []).push({ ep: a.ep, dev: a.dev, vrf, net, len: a.len });
      if (a.len < 32) subnets.push({ ep: a.ep, dev: a.dev, net, len: a.len, ip: a.ip, vrf, prefix: K.inVrf(net + '/' + a.len, vrf) });
    });
    m.devices.forEach((d) => { if (d.mgmtIp && !ipOwner.has(d.mgmtIp)) ipOwner.set(d.mgmtIp, d.key + '|'); }); // 管理 IP 視為 main
    const arpsByIp = new Map(); m.arps.forEach((a) => U.getOr(arpsByIp, K.inVrf(a.ip, a.vrf), () => []).push(a));
    const vlansByDev = new Map();
    m.vlans.forEach((v) => U.getOr(vlansByDev, v.dev, () => []).push(v));
    const routesByDev = new Map(); m.routes.forEach((r) => U.getOr(routesByDev, r.dev, () => []).push(r));
    // VRF：每台設備的設定（model.vrfs），以及基準中出現的所有 VRF 名稱（main 一定有）。第一次查詢時才建立
    const vrfDefsByDev = new Map(); (m.vrfs || []).forEach((v) => U.getOr(vrfDefsByDev, v.dev, () => []).push(v));
    let vrfNames = null;
    const vrfList = () => {
      if (vrfNames) return vrfNames;
      const set = new Set([MAIN]);
      (m.vrfs || []).forEach((v) => { if (!v.disabled) set.add(v.name); });
      m.interfaces.forEach((i) => set.add(K.vrf(i.vrf)));
      m.ipAddresses.forEach((a) => set.add(K.vrf(a.vrf)));
      m.arps.forEach((a) => set.add(K.vrf(a.vrf)));
      m.routes.forEach((r) => { if (r.vrf != null) set.add(r.vrf); });
      vrfNames = Object.freeze(Array.from(set).sort((a, b) => (a === MAIN ? -1 : b === MAIN ? 1 : U.natural(a, b))));
      return vrfNames;
    };
    /** vrf 參數：undefined／null 為不指定；字串必須是基準中的 VRF，否則 TypeError（不猜）。 */
    const vrfArg = (vrf) => {
      if (vrf == null) return null;
      const v = K.vrf(vrf);
      if (!vrfList().includes(v)) throw new TypeError(`基準中沒有 VRF ${JSON.stringify(String(vrf))}（有：${vrfList().join('、')}）`);
      return v;
    };
    const routesMemo = new Map(); const subnetsMemo = new Map();
    // 策略路由（https://manual.mikrotik.com/docs/user-guides/routing-and-networking-protocols/routing-decision.md）：每台設備第一次查詢時才整理
    const POLICY_DEFAULT = ['mangle', 'vrf-lookup', 'vrf-unreach', 'local', 'user', 'main'];
    const policyMemo = new Map();
    const byDevList = (list) => { const out = new Map(); (list || []).forEach((x) => U.getOr(out, x.dev, () => []).push(x)); return out; };
    let rulesByDev = null; let marksByDev = null; let tablesByDev = null;
    const hopI = {
      owner: (ip, vrf) => { const k = ipOwner.get(K.inVrf(ip, vrf)); return k ? { key: k, dev: K.splitEp(k)[0] } : null; },
      owners: (ip) => ownersByIp.get(ip) || EMPTY_LIST,
      connected: (d, vrf) => Q.subnetsOf(d, vrf),
    };
    const EMPTY_LIST = Object.freeze([]);
    const inferredByDev = new Map(); const inferredByEp = new Map(); const inferredByKey = new Map();
    (m.inferredLinks || []).forEach((l) => {
      inferredByKey.set(l.key, l);
      [l.a, l.b].forEach((ep) => {
        U.getOr(inferredByEp, ep, () => []).push(l);
        const arr = U.getOr(inferredByDev, K.splitEp(ep)[0], () => []); if (!arr.includes(l)) arr.push(l);
      });
    });
    // 推論鏈路在已收集設備端記在聚合介面上：查成員埠時一併找所屬聚合
    const inferredOfEp = (ep) => { const i = ifc.get(ep); return U.uniq([ep].concat(i && i.lag ? [i.lag] : []).flatMap((e) => inferredByEp.get(e) || [])); };
    // 推定位置與推論鏈路是同一段路徑的兩個推論（錨點埠 → 未收集交換器 → 終端），以錨點埠與設備對回
    const behindVia = new Map(); const behindUnder = new Map();
    m.macs.forEach((x) => {
      if (!x.behind) return;
      const peers = x.behind.dev ? [x.behind.dev] : x.behind.via;
      const ls = inferredOfEp(x.behind.anchor).filter((l) => [l.a, l.b].some((ep) => peers.includes(K.splitEp(ep)[0])));
      behindVia.set(x.mac, ls);
      ls.forEach((l) => U.getOr(behindUnder, l.key, () => []).push(x));
    });
    let inv = null;
    const unkByDev = new Map();
    m.interfaces.forEach((i) => { if (i.unknownPeer) U.getOr(unkByDev, i.dev, () => []).push(i); });
    const wifiByDev = new Map();
    // 無線介面上的客戶端：MAC 表學到的 ∪ 關聯表登記的（關聯表在沒有 bridge host 資料時也能列出客戶端）
    const assocMacsByEp = new Map(); (m.wifiAssociations || []).forEach((a) => U.getOr(assocMacsByEp, a.ep, () => []).push(a.mac));
    const wifiMacsOf = (i) => U.uniq(i.macs.concat(assocMacsByEp.get(i.key) || [])).sort();
    const toCollectedInfra = (ep) => (linksByEp.get(ep) || []).some((l) => {
      if (l.evidenceScope === S.LINK_SCOPE.BROADCAST_DOMAIN) return false;
      const peer = dev.get(K.splitEp(l.a === ep ? l.b : l.a)[0]);
      return peer && peer.collected && peer.kind !== 'host';
    });
    m.interfaces.forEach((i) => {
      const owner = dev.get(i.dev);
      if (i.type !== 'wireless' || !wifiMacsOf(i).length || i.status === 'down' || i.enabled === false || !owner || !owner.collected) return;
      if (S.infer.isVirtualIfc(i)) return;
      const group = [i.key];
      if (i.lag) {
        const p = ifc.get(i.lag);
        if (p) group.push(p.key, ...p.lagMembers);
      }
      group.push(...i.lagMembers);
      if (group.some(toCollectedInfra)) return;
      U.getOr(wifiByDev, i.dev, () => []).push(i);
    });
    // 防火牆
    const FW_FAMILY = ['ip', 'ipv6']; const FW_TABLE = ['filter', 'nat', 'raw'];
    const fwRules = m.firewallRules || [];
    const fwByDev = new Map(); const fwByKey = new Map();
    fwRules.forEach((r) => { U.getOr(fwByDev, r.dev, () => []).push(r); fwByKey.set(r.key, r); });
    const chainRank = (r) => { const b = S.infer.fw.BUILTIN[r.table] || []; const i = b.indexOf(r.chain); return i < 0 ? b.length : i; };
    const fwSort = (a, b) => FW_FAMILY.indexOf(a.family) - FW_FAMILY.indexOf(b.family) || FW_TABLE.indexOf(a.table) - FW_TABLE.indexOf(b.table)
      || chainRank(a) - chainRank(b) || U.natural(a.chain, b.chain) || a.position - b.position;
    const byDevOf = (list) => { const out = new Map(); (list || []).forEach((x) => U.getOr(out, x.dev, () => []).push(x)); return out; };
    const listsByDev = byDevOf(m.interfaceLists); const svcByDev = byDevOf(m.ipServices); const peersByDev = byDevOf(m.ipsecPeers); const polByDev = byDevOf(m.ipsecPolicies);
    const zoneByDev = new Map((m.firewallZones || []).map((z) => [z.dev, z]));
    const fwCtx = new Map();
    const ctxOf = (d) => U.getOr(fwCtx, d, () => S.infer.fw.fwContext(d, listsByDev.get(d) || [], (ifcsByDev.get(d) || []).map((i) => i.key), fwByDev.get(d) || []));
    const findingsBy = new Map();
    snap.findings.forEach((f, idx) => f.entities.forEach((e) => U.getOr(findingsBy, e.type + ':' + e.key, () => []).push(idx)));
    // 第一次查詢時才建立的索引（1000 台規模下多數畫面用不到）；回傳的陣列是 Q 自己的索引，凍結以免呼叫端改壞
    let byFindingKey = null; let byRule = null; let blocksByDev = null; let covByDev = null;
    const freezeAll = (map) => { map.forEach((v) => Object.freeze(v)); return map; };
    const findingKeyIndex = () => byFindingKey || (byFindingKey = freezeAll(snap.findings.reduce((out, f, idx) => { U.getOr(out, findingKey(f), () => []).push(idx); return out; }, new Map())));
    const EMPTY = Object.freeze([]);
    let subnetsByDev = null;
    // L4（M2）：可達性、zone、zone 矩陣與規則影響。第一次呼叫時才建立（src/query/trace.js 的 S.reach.engine），結果都是推論、只在記憶體快取，不寫進 Snapshot（ADR-014）
    let l4 = null;
    const L4 = () => l4 || (l4 = S.reach.engine(Q, { ctxOf }));
    const vlanSrc = { vlans: m.vlans, interfaces: m.interfaces, links: m.links, inferred: m.inferredLinks || [], ifc: (ep) => ifc.get(ep), collected: (d) => !!(dev.get(d) || {}).collected };

    // ---- L2／L3 視圖（M1）：第一次呼叫時才建立，依參數快取；回傳的物件都是這裡新建的，深層凍結
    let vlanIdList = null; let subIfcsOf = null;
    const carriersCache = new Map(); const portCache = new Map(); const subnetCache = new Map();
    const effM = { ifcs: ifc }; // S.infer 的 VLAN helper 只用 M.ifcs.get，Snapshot 的介面（陣列欄位）可以直接套用
    const collectedDev = (d) => !!(dev.get(d) || {}).collected;
    // 這一端的 VLAN 是否已知：已收集且有 VLAN 設定資料（同 vlanComparable 的判斷）
    const vlanDataMemo = new Map();
    const vlanDataDev = (d) => U.getOr(vlanDataMemo, d, () => { const x = dev.get(d); return !!x && !!x.collected && S.infer.VLAN_DATA.some((t) => x.data.includes(t)); });
    const isUnknownPort = (ep) => K.splitEp(ep)[1].startsWith('?(');
    const portName = (ep) => { const i = ifc.get(ep); return i ? i.name : isUnknownPort(ep) ? '?' : K.splitEp(ep)[1]; };
    const vlanModeOf = (ep, id) => {
      const md = S.infer.effVlanModes(effM, ep); const t = md.tagged.has(id); const u = md.untagged.has(id);
      return t && u ? 'both' : t ? 'tagged' : u ? 'untagged' : null;
    };
    const unfilteredEp = (ep) => { const i = ifc.get(ep); return !!(i && i.vlanUnfiltered); };
    /**
     * 鏈路一端對某 VLAN 的狀態。has：true／false 是事實（這台設備有 VLAN 設定資料），null 是無從得知
     * （未收集、沒有 VLAN 資料，或這一端在未開 vlan-filtering 的 bridge 上、VLAN 原樣轉送）。
     * via：self（介面本身）、lag（所屬聚合介面，同 effVlans）、member（推論鏈路記在聚合上，由成員埠帶這個 VLAN，同 vlanSpan）。
     */
    const vlanSide = (ep, id, has, viaMember) => {
      const d = K.splitEp(ep)[0]; const i = ifc.get(ep); const known = vlanDataDev(d) && !unfilteredEp(ep);
      let via = null; let mode = null;
      if (has && i) {
        const p = i.lag ? ifc.get(i.lag) : null;
        if (S.util.ifcVlans(i).includes(id)) { via = 'self'; mode = vlanModeOf(ep, id); }
        else if (p && S.util.ifcVlans(p).includes(id)) { via = 'lag'; mode = vlanModeOf(ep, id); }
        else if (viaMember) {
          via = 'member';
          const modes = U.uniq(i.lagMembers.map((k) => vlanModeOf(k, id)).filter(Boolean));
          mode = modes.length === 1 ? modes[0] : 'both';
        }
      }
      return { ep, dev: d, port: portName(ep), has: has ? true : known ? false : null, via, mode, collected: collectedDev(d), vlanData: known };
    };
    const STATUS_ORDER = ['carry', 'partial', 'oneSide', 'inferred'];
    // 介面也會繼承其鏈路、設備的檢查結果：在查詢時合併
    const Q = {
      snapshot: snap,
      // ---- 防火牆（規則是事實；WAN／LAN 分類 firewallZone 是推論）
      /** 所有防火牆規則，依設備、位址族（ip、ipv6）、表（filter、nat、raw）、表內順序。 */
      firewallRules: () => fwRules,
      getFirewallRule: (k) => fwByKey.get(k) || null,
      /**
       * 某設備的規則，依位址族、表、chain（內建 chain 在前：input、forward、output／srcnat、dstnat／prerouting、output，其餘依名稱）、chain 內順序排序。
       * filter：{ family?, table?, chain? }，省略的欄位不篩選。
       */
      firewallRulesOf(d, filter) {
        const f = filter || {};
        return (fwByDev.get(d) || []).filter((r) => (!f.family || r.family === f.family) && (!f.table || r.table === f.table) && (!f.chain || r.chain === f.chain)).sort(fwSort);
      },
      /** 同 firewallRulesOf，每列附上與這條規則有關的 finding：[{ rule, findings }]。 */
      firewallRuleRows(d, filter) { return Q.firewallRulesOf(d, filter).map((rule) => ({ rule, findings: Q.findingsFor('rule', rule.key) })); },
      /** 某設備的 chain 清單：[{ family, table, chain, builtin, rules（條數，含停用）, jumpedFrom（jump 到這裡的規則鍵） }]，順序同 firewallRulesOf。 */
      firewallChains(d) {
        const out = new Map();
        Q.firewallRulesOf(d).forEach((r) => {
          const k = r.family + '|' + r.table + '|' + r.chain;
          U.getOr(out, k, () => ({ family: r.family, table: r.table, chain: r.chain, builtin: (S.infer.fw.BUILTIN[r.table] || []).includes(r.chain), rules: 0, jumpedFrom: [] })).rules++;
        });
        (fwByDev.get(d) || []).forEach((r) => {
          const c = r.action === 'jump' && out.get(r.family + '|' + r.table + '|' + r.params['jump-target']);
          if (c) c.jumpedFrom.push(r.key);
        });
        return Array.from(out.values());
      },
      /**
       * 防火牆命中次數（print stats）各表的對應結果（事實）：[{ dev, family, table, status: matched|mismatch|no-export, rows（去掉 D 列）, dynamic, rules, reason, collectedAt, src }]。
       * 配上時規則的 stats 為 { bytes, packets, src }（十進位字串，收集當下的累積值，可能被 reset 過；0 只代表到收集時為止沒有比對到）。
       */
      firewallStats: () => m.firewallStats || EMPTY,
      firewallStatsOf(d) { return (m.firewallStats || EMPTY).filter((t) => t.dev === d); },
      /** WAN／LAN 分類（推論）：{ dev, basis, status: ok|no-wan-list|empty-wan-list, wanLists, wanInterfaces, lanLists, lanInterfaces }；沒有設定資料的設備為 null。 */
      firewallZone: (d) => zoneByDev.get(d) || null,
      /** /ip service（含 export 沒寫的預設值，basis 為 default）。 */
      ipServicesOf: (d) => svcByDev.get(d) || [],
      interfaceListsOf: (d) => listsByDev.get(d) || [],
      ipsecOf: (d) => ({ peers: peersByDev.get(d) || [], policies: polByDev.get(d) || [] }),
      /** 規則 a 是否涵蓋 b（符合 b 的封包一定符合 a；以 a 所在設備的 interface list 判斷）。比對兩份基準的規則時使用。 */
      firewallCovers: (a, b) => S.infer.fw.covers(ctxOf(a.dev), a, b),
      /** 基準的 meta（schema、version、inputHash、stats…）。 */
      meta: () => snap.meta,
      /** 每台設備的收集覆蓋（Snapshot 的 coverage：collected、data、missing、failures…），依設備排序。 */
      coverage: () => snap.coverage || [],
      devices: () => m.devices,
      links: () => m.links,
      vlans: () => m.vlans,
      /** 所有 IP 位址實體（含鄰居宣告，hearsay 為 true）。 */
      ipAddresses: () => m.ipAddresses,
      /** 該設備的收集覆蓋列（同 coverage() 的元素）；沒有這台設備時為 null。 */
      coverageOf(d) {
        if (!covByDev) covByDev = new Map((snap.coverage || []).map((c) => [c.dev, c]));
        return covByDev.get(d) || null;
      },
      /** 全部 finding，依 Snapshot 的順序；陣列位置（idx）就是 finding(idx)、findingIndexesFor 等使用的索引。 */
      findings: () => snap.findings,
      /** 第 idx 筆 finding；不是有效索引時為 null。idx 只在同一份 Snapshot 內有效，跨基準請用 findingKey。 */
      finding: (idx) => (Number.isInteger(idx) && idx >= 0 && idx < snap.findings.length ? snap.findings[idx] : null),
      /**
       * findingKey 等於 key 的 finding 索引，由小到大（凍結的陣列）。findingKey 可能碰撞（見上方說明），所以是陣列；沒有時為空陣列。
       */
      findingIndexesByKey: (key) => findingKeyIndex().get(key) || EMPTY,
      /** findingKey 等於 key 的第一筆 finding 索引；沒有時為 -1（碰撞時取 Snapshot 順序的第一筆）。 */
      findingIndexByKey(key) { const a = findingKeyIndex().get(key); return a ? a[0] : -1; },
      /** 某條規則（id，例如 'C01'）的 finding，依 Snapshot 的順序（凍結的陣列）。 */
      findingsByRule(id) {
        if (!byRule) byRule = freezeAll(snap.findings.reduce((out, f) => { U.getOr(out, f.id, () => []).push(f); return out; }, new Map()));
        return byRule.get(id) || EMPTY;
      },
      findingKey,
      findingBaseKey,
      getDevice: (k) => dev.get(K.dev(k)) || dev.get(k) || null,
      getInterface: (ep) => ifc.get(ep) || null,
      getLink: (k) => link.get(k) || null,
      interfacesOf: (d) => ifcsByDev.get(d) || [],
      linksOf: (d) => linksByDev.get(d) || [],
      linksOfEp: (ep) => linksByEp.get(ep) || [],
      /**
       * 設備的鄰居列。MNDP 只證明同一 L2 廣播網域可達，同一對設備可因多個本機介面或雙向回報
       * 各有一條 link；這裡併成每個對端設備一列（links 保留全部來源），其他鏈路一條一列。
       */
      neighborRows(d) {
        const rows = []; const mndp = new Map();
        (linksByDev.get(d) || []).forEach((l) => {
          const mine = K.splitEp(l.a)[0] === d ? l.a : l.b; const other = l.a === mine ? l.b : l.a;
          const own = (l.observations || []).filter((o) => o.dev === d);
          if (l.evidenceScope !== S.LINK_SCOPE.BROADCAST_DOMAIN) { rows.push({ l, links: [l], mine, other, observations: own }); return; }
          const pk = K.splitEp(other)[0];
          const row = mndp.get(pk);
          if (row) { row.links.push(l); row.observations.push(...own); return; }
          const r = { l, links: [l], mine, other, observations: own.slice() }; mndp.set(pk, r); rows.push(r);
        });
        rows.forEach((r) => {
          const seen = new Set();
          r.observations = r.observations.filter((o) => !seen.has(o.ifc) && seen.add(o.ifc)).sort((x, y) => U.natural(x.ifc, y.ifc));
        });
        return rows;
      },
      ospfAdjacenciesOf: (d) => ospfByDev.get(d) || [],
      linkBetween(epA, epB) { return link.get(K.link(epA, epB)) || null; },
      peerOf(l, ep) { return l.a === ep ? l.b : l.a; },
      vlansOf: (d) => vlansByDev.get(d) || [],
      /**
       * 某設備的路由（所有路由表）；給 vrf 時只取 vrf 等於它的路由（那個 VRF 的路由表；只用於策略路由的路由表 vrf 為 null，不會被選到）。
       * vrf 不是基準中的 VRF 時 TypeError。
       */
      routesOf(d, vrf) {
        if (vrf === undefined) return routesByDev.get(d) || [];
        const v = vrfArg(vrf); const k = d + '\u0000' + v;
        if (!routesMemo.has(k)) routesMemo.set(k, Object.freeze((routesByDev.get(d) || []).filter((r) => r.vrf === v)));
        return routesMemo.get(k);
      },
      /** 某設備某張路由表的路由（routes[].routingTable 等於 table，不論是不是 VRF）；沒有時為空陣列。 */
      routesInTable(d, table) {
        const k = d + '\u0001' + table;
        if (!routesMemo.has(k)) routesMemo.set(k, Object.freeze((routesByDev.get(d) || []).filter((r) => K.vrf(r.routingTable) === table)));
        return routesMemo.get(k);
      },
      /** 所有設備的路由表（main 以外）：{ dev, name, fib, disabled, source: export|vrf, vrf, src }。 */
      routingTables: () => m.routingTables || EMPTY_LIST,
      /** 所有設備的 /routing rule（依設備、設定順序）。 */
      routingRules: () => m.routingRules || EMPTY_LIST,
      /**
       * 某設備的策略路由（凍結）：{ tables（這台的路由表）, rules（啟用中的 /routing rule，依順序）, marks（啟用中的 mangle mark-routing）,
       *   policyRules（/routing settings 的 policy-rules；沒寫時是預設順序）, custom（改過 policy-rules）, any（有任何會改變查表的設定） }。
       * any 為 false 時，查表只看封包所在的 VRF（與沒有策略路由的網路相同）。
       */
      policyOf(d) {
        if (policyMemo.has(d)) return policyMemo.get(d);
        if (!rulesByDev) { rulesByDev = byDevList(m.routingRules); marksByDev = byDevList(m.routingMarkRules); tablesByDev = byDevList(m.routingTables); }
        const x = dev.get(d);
        const rules = (rulesByDev.get(d) || []).filter((r) => !r.disabled); const marks = (marksByDev.get(d) || []).filter((r) => !r.disabled);
        const set = x && x.policyRules ? x.policyRules.rules : null;
        const custom = !!set && set.join(',') !== POLICY_DEFAULT.join(',');
        // 只凍結 Q 自己的陣列與物件，不凍結 Snapshot 的規則
        const out = Object.freeze({ tables: Object.freeze((tablesByDev.get(d) || []).slice()), rules: Object.freeze(rules), marks: Object.freeze(marks), policyRules: Object.freeze(set ? set.slice() : POLICY_DEFAULT.slice()), custom, any: !!(rules.length || marks.length || custom) });
        policyMemo.set(d, out);
        return out;
      },
      /** 基準中出現的 VRF 名稱（設定、位址與路由），main 在最前、其餘依名稱（凍結的陣列）。只用 main 的網路是 ['main']。 */
      vrfs: () => vrfList(),
      /** 某設備的 VRF 設定（model.vrfs 的元素：{ dev, name, order, interfaces, members, src }），依設定順序；沒有時為空陣列。 */
      vrfsOf: (d) => vrfDefsByDev.get(d) || EMPTY_LIST,
      /**
       * 下一跳（或直連網段上的目的）位址在 dev 的 vrf 中屬於誰：同名 VRF 的擁有者優先；沒有時，dev 在這個 VRF 的直連網段上、
       * 其他設備位址與網段都相同的唯一介面（推論，crossVrf 為 true；例如 CE 在 main、PE 在 cust-a）。規則見 S.check.hopOwner。
       * 回傳 { key（介面鍵；管理 IP 為「設備|」）, dev, vrf（擁有者所在的 VRF）, crossVrf } 或 null。
       */
      hopOwner: (d, ip, vrf) => S.check.hopOwner(hopI, d, ip, K.vrf(vrf)),
      /** 推論鏈路（沒有 LLDP／CDP 時的替代證據，見設計說明 §5.3）。 */
      inferredLinks: () => m.inferredLinks || [],
      /** 推定在未收集交換器底下的終端，依掛在圖上的設備分組（單一設備時為該設備，否則為錨點所在的已收集設備）。 */
      behindGroups() {
        const out = new Map();
        m.macs.forEach((x) => { if (x.behind) U.getOr(out, x.behind.dev || K.splitEp(x.behind.anchor)[0], () => []).push(x); });
        out.forEach((list) => list.sort((p, q) => U.cmp(p.mac, q.mac)));
        return out;
      },
      inferredLinksOf: (d) => inferredByDev.get(d) || [],
      /**
       * 每條檢查規則的結果：found（有發現）、pass（需要的資料有收到且沒有發現）、nodata（需要的資料沒有任何已收集設備提供）。
       * missing 是缺少的資料組，每組列出可提供的資料類別。依規則編號排序。
       */
      ruleStatus() {
        const have = new Set(m.devices.filter((d) => d.collected).flatMap((d) => d.data));
        const count = new Map(); snap.findings.forEach((f) => count.set(f.id, (count.get(f.id) || 0) + 1));
        return Object.entries(S.check.CATALOG).map(([id, c]) => {
          const missing = (c.data || []).filter((g) => !g.some((t) => have.has(t)));
          const n = count.get(id) || 0;
          return { id, severity: c.severity, cat: c.cat, title: c.title, count: n, missing, status: n ? 'found' : missing.length ? 'nodata' : 'pass' };
        }).sort((a, b) => U.natural(a.id, b.id)); // 依編號排序，與檢查結果群組一致
      },
      inferredLinksOfEp: inferredOfEp,
      getInferredLink: (k) => inferredByKey.get(k) || null,
      /** 推定位置經由的推論鏈路（錨點埠到未收集交換器）；沒有對應的推論鏈路時為空。 */
      behindVia: (mk) => behindVia.get(mk) || [],
      /** 推定在這條推論鏈路後面的終端。 */
      behindUnder: (k) => behindUnder.get(k) || [],
      /**
       * 圖上的設備對：同一對設備的鏈路與推論鏈路併成一筆。evidence 是這對設備最強的證據，決定線型：
       *   adjacency（有 LLDP／CDP 介面鄰接）> hearsay（介面鄰接都是單側觀察）> inferred（推論鏈路）> domainOnly（只有 MNDP）。
       * 推論鏈路只在沒有 LLDP／CDP 的設備對之間產生，所以 inferred 只會與 MNDP 並存。
       */
      devicePairs() {
        const pairs = new Map();
        const pairOf = (epA, epB) => {
          const da = K.splitEp(epA)[0]; const db = K.splitEp(epB)[0]; if (da === db) return null;
          const [a, b] = da < db ? [da, db] : [db, da]; const id = a + '~' + b;
          return U.getOr(pairs, id, () => ({ id, a, b, links: [], inferred: [], cls: null, count: 0, adjacency: 0, hearsay: 0, hasDomain: false }));
        };
        m.links.forEach((l) => {
          const p = pairOf(l.a, l.b); if (!p) return;
          p.links.push(l.key); p.count++;
          if (!p.cls || CLS_RANK.indexOf(l.cls) < CLS_RANK.indexOf(p.cls)) p.cls = l.cls;
          if (l.evidenceScope === S.LINK_SCOPE.BROADCAST_DOMAIN) p.hasDomain = true;
          else if (l.hearsay) p.hearsay++;
          else p.adjacency++;
        });
        (m.inferredLinks || []).forEach((l) => { const p = pairOf(l.a, l.b); if (p) p.inferred.push(l.key); });
        return Array.from(pairs.values()).map(({ adjacency, hearsay, ...p }) => Object.assign(p, {
          cls: p.cls || 'other',
          evidence: adjacency ? 'adjacency' : hearsay ? 'hearsay' : p.inferred.length ? 'inferred' : 'domainOnly',
        }));
      },
      inferredLinksBetween: (a, b) => (inferredByDev.get(a) || []).filter((l) => [l.a, l.b].some((ep) => K.splitEp(ep)[0] === b)),
      /**
       * 擁有這個 IP 的介面鍵（管理 IP 為「設備|」）；沒有時為 null。vrf 省略時 ip 可以是位址鍵（10.0.0.1、10.0.0.1@cust-a，見 K.inVrf），
       * 沒有 @ 就是 main；給 vrf 時查那個 VRF。不分 VRF 的查詢用 Q.findIp(ip)。
       */
      ipOwner: (ip, vrf) => ipOwner.get(vrf === undefined ? String(ip) : K.inVrf(ip, vrf)) || null,
      /** 介面上的 IP 位址實體（含鄰居宣告）。 */
      ipsOf: (ep) => ipsByEp.get(ep) || [],
      /** 介面位址文字（CIDR），畫面顯示用。 */
      addressesOf: (ep) => (ipsByEp.get(ep) || []).map((a) => a.address),
      prefixes: () => m.prefixes,
      /** 所有設備自有的直連網段：{ ep, dev, net, len, ip, vrf, prefix（網段鍵，K.inVrf） }。 */
      subnets: () => subnets,
      /** 某設備的直連網段（Q.subnets() 中 dev 為這台設備的元素，順序相同；凍結的陣列）。給 vrf 時只取那個 VRF 的。 */
      subnetsOf(d, vrf) {
        if (!subnetsByDev) subnetsByDev = freezeAll(subnets.reduce((out, s) => { U.getOr(out, s.dev, () => []).push(s); return out; }, new Map()));
        if (vrf === undefined) return subnetsByDev.get(d) || EMPTY;
        const v = K.vrf(vrf); const k = d + '\u0000' + v;
        if (!subnetsMemo.has(k)) subnetsMemo.set(k, Object.freeze((subnetsByDev.get(d) || EMPTY).filter((s) => s.vrf === v)));
        return subnetsMemo.get(k);
      },
      /**
       * 端到端可達性（推論，見設計說明 §5.3「L4 可達性」）：從 src 到 dst 的新連線，沿 L3 路徑（與 S.trace 相同的轉送決定）逐跳套用
       * raw prerouting → nat dstnat（dst-nat 改寫目的後重新查路由）→ filter input／forward（設備自己送出的是 raw／filter output）→ nat srcnat。
       * opts：{ proto（預設 tcp）, port（tcp／udp 必填）, vrf（只能是 null，M3）, entry（選用：封包進入的介面鍵，來源不在任何網段時用）, disabledRules（選用：當作停用的規則鍵） }
       * 回傳（深層凍結）{ ok, src, dst, proto, port, vrf, entry, verdict: allow|deny|unknown, final: { dst, port }|null（NAT 後）, natApplied, start,
       *   reasons（unknown 的原因）, notes, decisive（決定結果的規則或預設）, paths: [{ verdict, hops, end }], assumptions }；位址無效時 { ok: false, error }。
       */
      reach: (src, dst, opts) => L4().reach(src, dst, opts),
      /**
       * zone（推論，不寫進 Snapshot）：每個 IPv4 直連網段依序取第一個有結果的來源：命名規則的 zones 標籤（profile）→ interface list → VLAN → 網段本身。
       * opts：{ profile（選用：建立基準時用的命名規則 JSON，id／版本要相同）, sources（選用：要用的來源，subnet 一定包含） }
       * 回傳 { zones: [{ id, name, source, inferred, basis, subnets, devices, vrf }], subnets: [{ prefix, zone, source, inferred, basis, detail, alternatives, eps, vrf }] }
       */
      zones: (opts) => L4().zones(opts),
      /** IP 所屬的 zone（最長相符的直連網段）：{ zone, subnet, source, inferred }；不在任何網段時為 null。 */
      zoneOf: (ip, opts) => L4().zoneOf(ip, opts),
      /**
       * zone 矩陣 L0（推論，查詢時計算並快取，不寫進 Snapshot；ADR-014）。opts：zones 的參數，另加 services（[{ proto, port }]，預設 S.query.l4Services() 加 dst-nat 的目的埠）。
       * 回傳 { zones, services, cells: [{ src, dst, diagonal, status: allow|deny|partial|unknown|empty, counts, services, heterogeneous, rule, rules, ruleCount, reasons }], stats }
       */
      zoneMatrix: (opts) => L4().matrix(opts),
      /**
       * zone 矩陣的分段計算（generator，像 S.steps）：每一段 yield { stage: 'reps'|'evaluate'|'summary', done, total }（total 是上限，只用來顯示進度），
       * 跑完時的回傳值（next() 的 { done: true, value }）與 Q.zoneMatrix(opts) 是同一個物件，並寫進同一份快取；已算過時第一次 next() 就結束。
       * 參數錯誤在第一次 next() 時丟出 TypeError。中途放棄不會留下快取。Q.zoneMatrix 就是把它跑完。
       */
      zoneMatrixSteps: (opts) => L4().matrixSteps(opts),
      /**
       * 矩陣下鑽 L1／L2：一格的摘要，加上 groups（目的 × 結果相同的來源代表）與 ruleDetails（牽涉的規則）。L3 是 Q.reach(來源代表, 目的, { proto, port })。
       * groups[].divergent：這一組造成格子異質（heterogeneous）——有某個 service，這組的結果和同一個目的的其他來源組、或同一批來源往其他目的的結果不同（定義見 trace.js 的 cell）。
       */
      zoneCell: (srcZone, dstZone, opts) => L4().cell(srcZone, dstZone, opts),
      /** 規則的影響：牽涉到這條規則的 zone 對與路徑，以及停用它時結果改變的路徑（ifDisabled）。沒有這條規則時為 null。 */
      ruleImpact: (key, opts) => L4().ruleImpact(key, opts),
      devName(k) { const d = dev.get(k); return d ? (d.label || d.name) : k; },
      /**
       * 設備層級的 DNS／NTP 伺服器設定（事實）：{ dns, ntp }，各為 { values, menu, param, src } 或 null（沒有設定、或找不到設備）。
       * menu／param 是收集到的來源（/ip dns＋servers、/system ntp client＋servers、/system ntp client servers＋address、
       * /system ntp client＋primary-ntp/secondary-ntp），產生修正指令時依它決定寫法。
       */
      serversOf(k) { const d = dev.get(k); return { dns: (d && d.dnsServers) || null, ntp: (d && d.ntpServers) || null }; },
      // 清單與總覽的唯一數字來源：列資料與計數一起算，畫面不得自行重算
      inventory() {
        if (inv) return inv;
        const macs = Q.macEntries(); const ips = Q.ipEntries(); const endpoints = Q.endpointEntries(); const prefixes = Q.prefixEntries(ips);
        const macSet = (f) => new Set(macs.filter(f).map((r) => r.mac)).size;
        inv = {
          rows: { devices: m.devices, endpoints, interfaces: m.interfaces, ips, macs, vlans: m.vlans, prefixes },
          counts: {
            devices: m.devices.length, collected: m.devices.filter((d) => d.collected).length, hosts: m.devices.filter((d) => d.kind === 'host').length,
            endpoints: endpoints.length, endpointPorts: new Set(endpoints.map((e) => e.key)).size, interfaces: m.interfaces.length,
            ips: ips.length, arpIps: ips.filter((r) => r.from.includes('ARP')).length, ownIps: ips.filter((r) => r.from.includes('介面') || r.from.includes('管理')).length,
            heardIps: ips.filter((r) => r.from.includes('鄰居宣告')).length,
            macs: macSet(() => true), macRows: macs.length, noIpMacs: macSet((r) => r.noIp), vlans: m.vlans.length, vlanIds: new Set(m.vlans.map((v) => v.id)).size, prefixes: prefixes.length,
          },
        };
        return inv;
      },
      // 每個 (MAC, 介面, VLAN) 一列；沒有任何介面觀察的 MAC（只出現在 ARP）設備與介面為 null
      macEntries() {
        const rows = [];
        m.macs.forEach((x) => {
          const base = { mac: x.mac, vendor: x.vendor, ips: x.ips, noIp: !x.ips.length };
          if (!x.seen.length) rows.push(Object.assign({ ep: null, dev: null, ifc: null, vlan: null }, base));
          x.seen.forEach(({ ep, vlan }) => { const [d, i] = K.splitEp(ep); const f = ifc.get(ep); rows.push(Object.assign({ ep, dev: d, ifc: f ? f.name : i, vlan }, base)); });
        });
        return rows;
      },
      // 每個 VRF 中不重複的 IP 一列（key 是位址鍵 K.inVrf，同一個 IP 在兩個 VRF 是兩列）：介面位址、設備管理 IP 與 ARP 出現的 IP 合併，來源保留在 from
      ipEntries() {
        const all = new Set(ipOwner.keys()); arpsByIp.forEach((_, k) => all.add(k)); heard.forEach((_, k) => all.add(k));
        return Array.from(all).map((key) => [key].concat(K.splitVrf(key))).sort((a, b) => U.natural(a[1], b[1]) || (a[2] === MAIN ? -1 : b[2] === MAIN ? 1 : U.natural(a[2], b[2]))).map(([key, ip, vrf]) => {
          const owner = ipOwner.get(key) || null; const macs = U.uniq((arpsByIp.get(key) || []).map((a) => a.mac));
          const from = [owner ? (owner.endsWith('|') ? '管理' : '介面') : null, macs.length ? 'ARP' : null, !owner && heard.has(key) ? '鄰居宣告' : null].filter(Boolean);
          const ownerDev = owner ? K.splitEp(owner)[0] : null;
          return { key, ip, vrf, owner, dev: ownerDev, ifc: owner && !owner.endsWith('|') ? Q.epName(owner).slice(Q.devName(ownerDev).length + 1) : null, macs, from };
        });
      },
      /** 每個 VRF 的每個直連網段一列（key 是網段鍵）：設定在哪些介面／設備，以及清單中同一個 VRF、落在網段內的 IP 數（介面位址、管理 IP、ARP 合計）。 */
      prefixEntries(ips) {
        return m.prefixes.map((p) => ({
          key: p.key || K.inVrf(p.prefix, p.vrf), prefix: p.prefix, net: p.net, len: p.len, vrf: K.vrf(p.vrf), basis: p.basis, eps: p.eps,
          devs: U.uniq(p.eps.map((ep) => K.splitEp(ep)[0])).sort(U.natural),
          ipCount: (ips || Q.ipEntries()).filter((r) => r.vrf === K.vrf(p.vrf) && S.ip.inNet(r.ip, p.net, p.len)).length,
        }));
      },
      epName(ep) { const [d, i] = K.splitEp(ep); const x = ifc.get(ep); return Q.devName(d) + ' ' + (x ? x.name : i); },
      /**
       * 檢查結果所屬的設備：第一個 device 實體；沒有時取第一個能對到設備的實體（介面、鏈路一端、規則、服務、設備自有的 IP）。
       * 回傳基準中存在的設備鍵，都對不到時為 null（例如沒有設備標頭的 I01、只涉及 MAC 或 VLAN 的檢查）。
       * 這是「所屬設備」的唯一實作：修正 patch（src/remediate/patch.js）與畫面（檢查結果分組、匯出、修正計畫）都呼叫這裡，不另寫一份。
       */
      findingDevice(f) {
        const known = (d) => { const x = d && Q.getDevice(d); return x ? x.key : null; };
        const ents = f.entities || [];
        const devEnt = ents.find((e) => e.type === 'device');
        if (devEnt && known(devEnt.key)) return known(devEnt.key);
        for (const e of ents) {
          let d = null;
          if (e.type === 'interface') d = (ifc.get(e.key) || {}).dev || K.splitEp(e.key)[0];
          else if (e.type === 'link') { const l = link.get(e.key); d = K.splitEp(l ? l.a : String(e.key).split('~')[0])[0]; }
          else if (e.type === 'rule') d = (fwByKey.get(e.key) || {}).dev;
          else if (e.type === 'service') d = K.splitEp(e.key)[0];
          else if (e.type === 'ip') { const o = ipOwner.get(e.key); d = o && K.splitEp(o)[0]; } // 實體鍵就是位址鍵（K.inVrf）
          if (known(d)) return known(d);
        }
        return null;
      },
      findingsFor(type, key) { return (findingsBy.get(type + ':' + key) || []).map((i) => snap.findings[i]); },
      findingIndexesFor(type, key) { return findingsBy.get(type + ':' + key) || []; },
      block: (id) => snap.blocks[id] || null,
      /** 屬於某設備的輸入區塊（blocks[].devKey），依輸入順序（凍結的陣列）；沒有時為空陣列。 */
      blocksOf(d) {
        if (!blocksByDev) blocksByDev = freezeAll(snap.blocks.reduce((out, b) => { if (b.devKey) U.getOr(out, b.devKey, () => []).push(b); return out; }, new Map()));
        return blocksByDev.get(d) || EMPTY;
      },
      /** 有且僅有一個 MAC、非 Wi-Fi，且沒有 LLDP／CDP 介面鄰接的終端埠所屬設備（MNDP 廣播網域可達不算直連鄰接） */
      // 終端清單列：有線未知對端每筆 MAC 一列；Wi-Fi 每個 MAC／介面觀察位置一列。
      endpointEntries() {
        const rows = Q.unknownDevices().flatMap((d) => Q.unknownPeers(d).flatMap((u) => {
          const base = { end: true, key: u.ep, dev: d, ifc: u.name, desc: u.desc, type: u.type, rawType: u.rawType, status: u.status, vlans: u.vlans, portMacs: u.macs.length, wifi: false };
          return (u.macs.length ? u.macs : [null]).map((x) => Object.assign({ mac: x ? x.mac : null, ips: x ? x.ips : [], vendors: x && x.vendor ? [x.vendor] : [] }, base));
        }));
        wifiByDev.forEach((interfaces, d) => interfaces.forEach((i) => wifiMacsOf(i).forEach((mk) => {
          const x = mac.get(mk);
          rows.push({
            end: true, wifi: true, key: i.key, dev: d, ifc: i.name, desc: i.desc, type: i.type, rawType: i.rawType, status: i.status, vlans: U.ifcVlans(i),
            portMacs: wifiMacsOf(i).length, mac: mk, ips: x ? x.ips : [], vendors: x && x.vendor ? [x.vendor] : [],
          });
        })));
        return rows.sort((a, b) => U.natural(a.dev, b.dev) || U.natural(a.ifc, b.ifc) || U.natural(a.mac || '', b.mac || ''));
      },
      unknownDevices: () => Array.from(unkByDev.keys()).sort(U.natural),
      /** 某設備上「沒有 LLDP／CDP 介面鄰接」的終端埠，附 MAC、IP、廠商 */
      unknownPeers(devKey) {
        return (unkByDev.get(devKey) || []).slice().sort((a, b) => U.natural(a.name, b.name)).map((i) => ({
          ep: i.key, name: i.name, desc: i.desc, status: i.status, type: i.type, rawType: i.rawType, vlans: U.ifcVlans(i),
          macs: i.macs.map((mk) => { const x = mac.get(mk); return { mac: mk, vendor: x ? x.vendor : null, ips: x ? x.ips : [] }; }),
        }));
      },
      /** 圖面投影：真正終端加上 Wi-Fi MAC 觀察；Wi-Fi 介面不屬終端介面，也不參與 A02。 */
      visualUnknownDevices() {
        return U.uniq(Q.unknownDevices().concat(Array.from(wifiByDev.keys()))).sort(U.natural);
      },
      visualUnknownPeers(devKey) {
        const actual = Q.unknownPeers(devKey);
        const wireless = (wifiByDev.get(devKey) || []).map((i) => ({
          ep: i.key, name: i.name, desc: i.desc, status: i.status, type: i.type, rawType: i.rawType, vlans: U.ifcVlans(i), visualOnly: true,
          macs: wifiMacsOf(i).map((mk) => { const x = mac.get(mk); return { mac: mk, vendor: x ? x.vendor : null, ips: x ? x.ips : [] }; }),
        }));
        return actual.concat(wireless).sort((a, b) => U.natural(a.name, b.name));
      },

      findMac(text) {
        const k = K.mac(text); if (!k) return null;
        const x = mac.get(k);
        return x ? Object.assign({ found: true }, x) : { found: false, mac: k, vendor: S.oui ? S.oui.lookup(k) : null, ips: [], seen: [], edge: [] };
      },
      /**
       * 一個 IP 在基準中的資料。vrf 省略（或 null）時列出所有 VRF 的結果並標出 VRF；給 vrf 時只看那個 VRF（不是基準中的 VRF 時 TypeError）。
       * 回傳 { ip, vrf（給的 vrf 或 null）, vrfs（有結果的 VRF）, owner（第一個擁有者：main 優先，再依 VRF 名稱）, owners: [{ vrf, ep }],
       *   arps（每筆有 vrf）, macs, subnets（Q.subnets() 的元素，含 vrf 與網段鍵 prefix；最長遮罩在前）, locations }；ip 無效時為 null。
       */
      findIp(ip, vrf) {
        if (!S.ip.isIp(ip)) return null;
        const only = vrfArg(vrf);
        const vs = only ? [only] : vrfList();
        const owners = vs.map((v) => ({ vrf: v, ep: ipOwner.get(K.inVrf(ip, v)) || null })).filter((o) => o.ep);
        const arps = vs.flatMap((v) => arpsByIp.get(K.inVrf(ip, v)) || []);
        const macs = U.uniq(arps.map((a) => a.mac));
        const nets = subnets.filter((s) => (!only || s.vrf === only) && S.ip.inNet(ip, s.net, s.len)).sort((a, b) => b.len - a.len);
        const locations = [];
        macs.forEach((mk) => { const x = mac.get(mk); if (x) x.edge.forEach((ep) => locations.push({ mac: mk, ep })); });
        const found = U.uniq(owners.map((o) => o.vrf).concat(arps.map((a) => K.vrf(a.vrf)), nets.map((s) => s.vrf)));
        return { ip, vrf: only, vrfs: vs.filter((v) => found.includes(v)), owner: owners.length ? owners[0].ep : null, owners, arps, macs, subnets: nets, locations };
      },
      /**
       * VLAN id 在整個基準的承載情況；domains 依承載此 VLAN 的鏈路、推論鏈路與透通鏈路分成互不相連的區塊（推論，見設計說明 §5.3）。
       * transparent：只有一端帶這個 VLAN、另一端在未開 vlan-filtering 的 bridge 上的介面鄰接鏈路（推論：原樣轉送，無從確認）。
       * 給 domain（區塊的 key）時，devices／entries／carry／partial／inferred／transparent 只含那個區塊。
       */
      vlan(id, domain) {
        id = +id;
        const all = S.infer.vlanSpan(vlanSrc, id);
        const pick = (d) => {
          const set = new Set(d.devices); const has = (l) => set.has(K.splitEp(l.a)[0]) || set.has(K.splitEp(l.b)[0]);
          return Object.assign({}, d, { entries: all.entries.filter((e) => set.has(e.dev)), carry: all.carry.filter(has), partial: all.partial.filter(has), inferred: all.inferred.filter(has), transparent: all.transparent.filter(has) });
        };
        const domains = all.domains.map(pick);
        const one = domain != null && domains.find((d) => d.key === domain);
        const scope = one || all;
        return { id, domain: one ? one.key : null, domains, entries: scope.entries, devices: scope.devices, carry: scope.carry, partial: scope.partial, inferred: scope.inferred, transparent: scope.transparent,
          names: U.uniq(scope.entries.map((e) => e.name).filter(Boolean)) };
      },
      /** 基準中出現的所有 VLAN ID（VLAN 定義與介面的 PVID／untagged／tagged），由小到大（凍結的陣列）。VLAN 篩選的選項用。 */
      vlanIds() {
        if (vlanIdList) return vlanIdList;
        const ids = new Set();
        m.vlans.forEach((v) => { if (v.id != null) ids.add(v.id); });
        m.interfaces.forEach((i) => U.ifcVlans(i).forEach((v) => ids.add(v)));
        vlanIdList = Object.freeze(U.numSort(Array.from(ids)));
        return vlanIdList;
      },
      /**
       * 承載 VLAN id 的鏈路（VLAN 篩選時高亮用）；給 domain（Q.vlan 的區塊鍵）時只含那一塊。結果深層凍結。
       * 回傳 { id, domain, devices, links, counts: { carry, partial, oneSide, inferred }, eps }：
       *   links[]：{ key, kind: 'link'|'inferred', status, inferred, hearsay, reason, a, b, src }，a／b 見 vlanSide。
       *     kind 是 key 的種類：link 用 Q.getLink(key)、inferred 用 Q.getInferredLink(key) 取回原始實體。
       *     status（判斷依據與 Q.vlan 相同：兩端的 effVlans，即介面本身 ∪ 所屬聚合的 PVID／untagged／tagged）：
       *       carry    兩端都帶這個 VLAN（事實）
       *       partial  兩端都有 VLAN 資料、只有一端帶（事實；兩端不一致，V01）
       *       oneSide  只有一端帶，另一端無從得知（推論）；reason 為
       *                unfiltered（任一端在未開 vlan-filtering 的 bridge 上，VLAN 原樣轉送；即 Q.vlan(id).transparent，參與區塊劃分）、
       *                peer-uncollected、peer-no-vlan-data 或 hearsay（這三種不參與 Q.vlan 的區塊劃分）
       *       inferred 推論鏈路，已收集的各端都帶這個 VLAN（推論，同 Q.vlan(id).inferred）
       *     inferred 為 true 表示這一列是推論（oneSide、inferred）；hearsay 為 true 表示鏈路本身只有單側觀察。
       *     只算介面鄰接（LLDP／CDP）；MNDP 只證明同一廣播網域，不列入。
       *   eps：帶這個 VLAN 的鏈路端點（has 為 true），排序後的 ep 鍵。
       * 依 status（carry、partial、oneSide、inferred）再依鍵排序。VLAN 子介面（parent＋encapVlan）讓 parent 以 tagged 帶那個 VLAN
       * （export 解析時記成 parent 的 taggedVlans，停用的子介面不算）；parent 是 bridge 時只有 bridge 本身帶，成員埠不帶。與 V01 相同。
       * partial 只含 vlansDiff 中的 VLAN（例如單臂路由的實體埠對上 PVID 1，不算 partial）。
       */
      vlanCarriers(id, domain) {
        id = +id;
        const ck = JSON.stringify([id, domain == null ? null : String(domain)]);
        if (carriersCache.has(ck)) return carriersCache.get(ck);
        const v = Q.vlan(id, domain);
        const inScope = new Set(v.devices);
        const rows = [];
        const add = (l, kind, status, sideA, sideB, extra) => rows.push(Object.assign({
          key: l.key, kind, status, inferred: status === 'oneSide' || status === 'inferred', hearsay: !!l.hearsay, reason: null, a: sideA, b: sideB, src: copySrc(l.src),
        }, extra));
        v.carry.forEach((l) => add(l, 'link', 'carry', vlanSide(l.a, id, true), vlanSide(l.b, id, true)));
        v.partial.forEach((l) => add(l, 'link', 'partial', vlanSide(l.a, id, l.vlansA.includes(id)), vlanSide(l.b, id, l.vlansB.includes(id))));
        m.links.forEach((l) => {
          if (l.layer !== 'l2' || l.evidenceScope !== S.LINK_SCOPE.INTERFACE_ADJACENCY || l.vlanComparable) return;
          const inA = l.vlansA.includes(id); const inB = l.vlansB.includes(id);
          if (inA === inB) return;
          if (v.domain != null && !inScope.has(K.splitEp(inA ? l.a : l.b)[0])) return;
          const a = vlanSide(l.a, id, inA); const b = vlanSide(l.b, id, inB); const peer = inA ? b : a;
          // unfiltered 與 Q.vlan(id).transparent 是同一組鏈路（同一份 vlanUnfiltered 判斷）
          const reason = unfilteredEp(l.a) || unfilteredEp(l.b) ? 'unfiltered' : !peer.collected ? 'peer-uncollected' : !peer.vlanData ? 'peer-no-vlan-data' : 'hearsay';
          add(l, 'link', 'oneSide', a, b, { reason });
        });
        // 推論鏈路：已收集的一端（記在聚合上時看成員埠）帶這個 VLAN；未收集的一端無從得知
        v.inferred.forEach((l) => {
          const side = (ep) => {
            const i = ifc.get(ep); const known = !!i && collectedDev(K.splitEp(ep)[0]);
            const has = known && (U.ifcVlans(i).includes(id) || i.lagMembers.some((k) => { const x = ifc.get(k); return !!x && U.ifcVlans(x).includes(id); }));
            return vlanSide(ep, id, has, true);
          };
          add(l, 'inferred', 'inferred', side(l.a), side(l.b), { src: [] });
        });
        rows.sort((x, y) => STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status) || U.cmp(x.key, y.key));
        const counts = {}; STATUS_ORDER.forEach((s) => { counts[s] = rows.filter((r) => r.status === s).length; });
        const eps = U.uniq(rows.flatMap((r) => [r.a, r.b]).filter((s) => s.has).map((s) => s.ep)).sort(U.cmp);
        const out = deepFreeze({ id, domain: v.domain, devices: v.devices.slice(), links: rows, counts, eps });
        carriersCache.set(ck, out);
        return out;
      },
      /**
       * 埠層級的 L2 圖（給 ELK 的 port）：設備、埠與埠對埠的邊。結果依參數快取並深層凍結。
       * opts：
       *   lag：'collapse'（預設，聚合成員併進聚合介面，成員列在 members）或 'expand'（成員各自是埠，lag 指向所屬聚合）
       *   ports：'linked'（預設，只列有邊的埠）或 'all'（另列範圍內已收集設備的實體、聚合、無線介面）
       *   inferred：true（預設）／false，是否包含推論鏈路
       *   devices：設備鍵的陣列；給了就只取至少一端在其中的邊（另一端的設備也會出現，focus 為 false）
       * 回傳 { devices, ports, edges, omitted }：
       *   devices[]：{ id, label, kind, collected, focus, ports（埠 id，依名稱）, bridges: [{ ep, name, ports, vlanIfcs }] }
       *   ports[]：{ id（ep 鍵）, dev, name, ifc（介面鍵；推論鏈路未收集端的未知埠為 null）, unknown, type, rawType, status, enabled, hearsay,
       *             lag（expand 時成員所屬的聚合）, members（collapse 時聚合的成員）, bridge, mode, pvid, vlans（含所屬聚合）,
       *             subIfcs（掛在這個埠或其成員上的 VLAN 子介面 ep）, unknownPeer, macCount, edges（邊數） }
       *   edges[]：{ id, a, b（埠 id，a < b）, aDev, bDev, links（鏈路鍵）, inferredLinks（推論鏈路鍵）, count, evidence, inferred, cls, vlansCommon, src }
       *     evidence：adjacency（有雙側的 LLDP／CDP 介面鄰接）> hearsay（只有單側觀察，推論）> inferred（只有推論鏈路，推論）；inferred 為 evidence !== 'adjacency'。
       *   omitted：{ domainOnly（MNDP 鏈路，只證明同一廣播網域，不當直連）, sameDevice（同一台設備兩埠之間的鏈路，collapse 後兩端相同的不畫）, inferred（opts.inferred 為 false 時略過的推論鏈路） }
       */
      portGraph(opts) {
        const o = opts || {};
        const lagMode = oneOf('lag', o.lag, ['collapse', 'expand']);
        const portsMode = oneOf('ports', o.ports, ['linked', 'all']);
        const withInferred = oneOf('inferred', o.inferred, [true, false]);
        if (o.devices != null && !Array.isArray(o.devices)) throw new TypeError('devices 必須是設備鍵的陣列');
        const focus = o.devices ? new Set(o.devices.map(String)) : null;
        const ck = JSON.stringify([lagMode, portsMode, withInferred, focus ? Array.from(focus).sort(U.cmp) : null]);
        if (portCache.has(ck)) return portCache.get(ck);
        if (!subIfcsOf) { subIfcsOf = new Map(); m.interfaces.forEach((i) => { if (i.parent) U.getOr(subIfcsOf, i.parent, () => []).push(i.key); }); }
        const portOf = (ep) => { if (lagMode === 'expand') return ep; const i = ifc.get(ep); return i && i.lag && ifc.get(i.lag) ? i.lag : ep; };
        const touches = (a, b) => !focus || focus.has(K.splitEp(a)[0]) || focus.has(K.splitEp(b)[0]);
        const edges = new Map(); const omitted = { domainOnly: 0, sameDevice: 0, inferred: 0 };
        const edgeOf = (a, b) => {
          const id = K.link(a, b); const [x, y] = a < b ? [a, b] : [b, a];
          return U.getOr(edges, id, () => ({ id, a: x, b: y, aDev: K.splitEp(x)[0], bDev: K.splitEp(y)[0], links: [], inferredLinks: [], adjacency: 0, hearsay: 0, cls: null, vlansCommon: new Set(), src: [] }));
        };
        m.links.forEach((l) => {
          if (!touches(l.a, l.b)) return;
          if (l.evidenceScope === S.LINK_SCOPE.BROADCAST_DOMAIN) { omitted.domainOnly++; return; }
          if (l.evidenceScope !== S.LINK_SCOPE.INTERFACE_ADJACENCY) return;
          const pa = portOf(l.a); const pb = portOf(l.b);
          if (pa === pb) { omitted.sameDevice++; return; }
          const e = edgeOf(pa, pb);
          e.links.push(l.key); if (l.hearsay) e.hearsay++; else e.adjacency++;
          if (!e.cls || clsRank(l.cls) < clsRank(e.cls)) e.cls = l.cls;
          l.vlansCommon.forEach((x) => e.vlansCommon.add(x));
          e.src.push(...copySrc(l.src));
        });
        (m.inferredLinks || []).forEach((l) => {
          if (!touches(l.a, l.b)) return;
          if (!withInferred) { omitted.inferred++; return; }
          const pa = portOf(l.a); const pb = portOf(l.b);
          if (pa === pb) { omitted.sameDevice++; return; }
          edgeOf(pa, pb).inferredLinks.push(l.key);
        });
        const edgeList = Array.from(edges.values()).sort((x, y) => U.cmp(x.id, y.id)).map(({ adjacency, hearsay, vlansCommon, ...e }) => {
          const evidence = adjacency ? 'adjacency' : hearsay ? 'hearsay' : 'inferred';
          return Object.assign(e, { count: e.links.length + e.inferredLinks.length, evidence, inferred: evidence !== 'adjacency', cls: e.cls || 'other', vlansCommon: U.numSort(Array.from(vlansCommon)) });
        });
        const edgeCount = new Map();
        edgeList.forEach((e) => [e.a, e.b].forEach((p) => edgeCount.set(p, (edgeCount.get(p) || 0) + 1)));
        const portIds = new Set(edgeCount.keys());
        if (portsMode === 'all') {
          const PORT_TYPES = ['physical', 'lag', 'wireless'];
          m.interfaces.forEach((i) => {
            if (!PORT_TYPES.includes(i.type) || !collectedDev(i.dev) || (focus && !focus.has(i.dev))) return;
            portIds.add(portOf(i.key));
          });
        }
        const ports = Array.from(portIds).map((p) => {
          const i = ifc.get(p); const d = K.splitEp(p)[0];
          const members = lagMode === 'collapse' && i ? i.lagMembers.slice() : [];
          return {
            id: p, dev: d, name: portName(p), ifc: i ? i.key : null, unknown: !i && isUnknownPort(p),
            type: i ? i.type : null, rawType: i ? i.rawType : null, status: i ? i.status : null, enabled: i ? i.enabled : null, hearsay: i ? !!i.hearsay : false,
            lag: lagMode === 'expand' && i && i.lag ? i.lag : null, members, bridge: i ? i.bridge : null,
            mode: i ? i.mode : null, pvid: i ? i.pvid : null, vlans: i ? S.infer.effVlans(effM, p) : [],
            subIfcs: U.uniq([p].concat(members).flatMap((k) => subIfcsOf.get(k) || [])).sort(U.natural),
            unknownPeer: i ? !!i.unknownPeer : false, macCount: i ? i.macs.length : 0, edges: edgeCount.get(p) || 0,
          };
        }).sort((x, y) => U.natural(x.dev, y.dev) || U.natural(x.name, y.name) || U.cmp(x.id, y.id));
        const byDev = new Map();
        ports.forEach((p) => U.getOr(byDev, p.dev, () => []).push(p));
        if (focus) focus.forEach((d) => { if (dev.get(d)) U.getOr(byDev, d, () => []); });
        const devices = Array.from(byDev.keys()).sort(U.natural).map((d) => {
          const x = dev.get(d); const ps = byDev.get(d);
          const bridges = new Map();
          ps.forEach((p) => { if (p.bridge) U.getOr(bridges, p.bridge, () => []).push(p.id); });
          return {
            id: d, label: x ? x.label || x.name : d, kind: x ? x.kind : null, collected: !!(x && x.collected), focus: focus ? focus.has(d) : true,
            ports: ps.map((p) => p.id),
            bridges: Array.from(bridges.keys()).sort(U.natural).map((b) => ({ ep: b, name: portName(b), ports: bridges.get(b), vlanIfcs: (subIfcsOf.get(b) || []).slice().sort(U.natural) })),
          };
        });
        const out = deepFreeze({ devices, ports, edges: edgeList, omitted });
        portCache.set(ck, out);
        return out;
      },
      /**
       * L3 子網圖：子網（prefixes）節點、設備或介面節點，以及「在這個子網有位址」的邊。結果依參數快取並深層凍結。
       * VRF 是容器（ADR-015）：每個子網、節點、邊與路由都有 vrf（main 也寫出）；不同 VRF 的同一個網段是不同的子網節點。
       * id 用 K.inVrf：main 不加後綴（與加入 VRF 之前相同），其他 VRF 加 @<VRF>。設備模式時一台設備在每個有位址的 VRF 各一個節點
       * （id 為「設備鍵」或「設備鍵@VRF」）；介面模式時介面只屬於一個 VRF，id 就是介面鍵。
       * opts：
       *   nodes：'device'（預設，每台設備一個節點）或 'interface'（每個介面一個節點；管理 IP 的節點 id 為「設備鍵|」）
       *   hearsay：true（預設）／false，是否加入推論的邊：鄰居宣告的位址（basis neighbor）與未列在介面位址的管理 IP（basis mgmt），
       *            都只接到已知網段（最長相符），不產生新網段
       *   routes：false（預設）／true，是否加入靜態路由與預設路由的邊（routes[]）；目的網段不是已知網段時新增 basis 為 route 的節點。
       *           只取 VRF 的路由表（routes[].vrf 不是 null）；只用於策略路由的路由表不畫，數量在 omitted.policyRoutes
       * 回傳 { subnets, nodes, edges, routes, omitted: { policyRoutes } }：
       *   subnets[]：{ id（網段鍵：網段字串，非 main 加上 @VRF）, prefix, net, len, family, vrf, basis（connected／route）, vlan, vlans, eps, devices,
       *               routers（接在這裡的路由設備）, gateways（DHCP 網路設定的閘道）, overlaps（包含或被包含的其他網段 id；routes 為 true 時也含路由新增的子網，預設路由 /0 不列）, duplicateIps（同一 IP 設在多個介面，VRRP 除外） }
       *   nodes[]：{ id, type: 'device'|'interface', dev, ep, name, label, kind, collected, vrf, subnets, router, routerBasis, multihomed, hostAddresses }
       *     router（推論）：接到 2 個以上子網，而且有路由表資料（routerBasis 'routes'）或設備類型是路由器／防火牆（'kind'）；
       *     只是多張網卡的主機不算（multihomed 為 true、router 為 false）。interface 節點的 router 是所屬設備的值。
       *     hostAddresses：/32 的自有位址（loopback 等，不形成網段）。
       *   edges[]：{ id, subnet, node, dev, eps, addresses: [{ address, ip, ep, role, hearsay, seenBy, src }], basis（address／neighbor／mgmt）, inferred, vrf }
       *     管理 IP（mgmt）在 Snapshot 沒有來源行：src 為設備的 src（只由鄰居看到的設備為空），seenBy 列出看到這台設備的已收集設備。
       *   routes[]：{ id, dev（路由所在的設備；interface 模式也接在設備上）, node（設備在這個 VRF 的節點 id）, subnet（目的網段 id，同一個 VRF）, prefix, len, default, proto, distance, blackhole,
       *               nh（含 vrf、vrfBasis）, via（下一跳所在、這台設備在閘道的 VRF 直連的網段 id）, routingTable, vrf, src }
       */
      subnetGraph(opts) {
        const o = opts || {};
        const nodeMode = oneOf('nodes', o.nodes, ['device', 'interface']);
        const withHearsay = oneOf('hearsay', o.hearsay, [true, false]);
        const withRoutes = oneOf('routes', o.routes, [false, true]);
        const ck = JSON.stringify([nodeMode, withHearsay, withRoutes]);
        if (subnetCache.has(ck)) return subnetCache.get(ck);
        const ipNet = (ip, len) => S.ip.fromInt((S.ip.toInt(ip) & S.ip.maskOf(len)) >>> 0);
        const keyOf = (net, len, vrf) => K.inVrf(net + '/' + len, vrf);
        const subnets = new Map(); const lens = new Set();
        const subnetNode = (p, basis) => ({
          id: keyOf(p.net, p.len, p.vrf), prefix: p.prefix, net: p.net, len: p.len, family: p.family || 4, vrf: K.vrf(p.vrf), basis,
          vlan: p.vlan == null ? null : p.vlan, vlans: (p.vlans || []).slice(), eps: (p.eps || []).slice(), devices: [], routers: [], gateways: [], overlaps: [], duplicateIps: [],
        });
        m.prefixes.forEach((p) => { const n = subnetNode(p, 'connected'); subnets.set(n.id, n); lens.add(p.len); });
        const lensDesc = Array.from(lens).sort((a, b) => b - a);
        const longest = (ip, vrf) => { for (const len of lensDesc) { const s = subnets.get(keyOf(ipNet(ip, len), len, vrf)); if (s) return s; } return null; };
        // 邊：自有位址一定接到自己的網段；推論的邊只接到已知網段（同一個 VRF）
        const edges = new Map();
        const nodeIdOf = (d, ep, vrf) => (nodeMode === 'device' ? K.inVrf(d, vrf) : ep || d + '|');
        const edgeOf = (s, d, ep, basis) => {
          const node = nodeIdOf(d, ep, s.vrf); const id = s.id + '~' + node;
          return U.getOr(edges, id, () => ({ id, subnet: s.id, node, dev: d, eps: [], addresses: [], basis, inferred: basis !== 'address', vrf: s.vrf }));
        };
        const hostAddrs = new Map();
        m.ipAddresses.forEach((a) => {
          if (a.hearsay || a.ip === null) return;
          if (a.len >= 32) { U.getOr(hostAddrs, a.dev, () => []).push({ address: a.address, ep: a.ep, vrf: K.vrf(a.vrf) }); return; }
          const s = subnets.get(keyOf(ipNet(a.ip, a.len), a.len, a.vrf)); if (!s) return;
          const e = edgeOf(s, a.dev, a.ep, 'address');
          if (!e.eps.includes(a.ep)) e.eps.push(a.ep);
          e.addresses.push({ address: a.address, ip: a.ip, ep: a.ep, role: a.role, hearsay: false, seenBy: null, src: copySrc(a.src) });
        });
        const ownDevSubnet = new Set(Array.from(edges.values(), (e) => e.subnet + '~' + e.dev));
        if (withHearsay) {
          const addInferred = (ip, vrf, d, ep, basis, address, src, seenBy) => {
            const s = longest(ip, vrf); if (!s || ownDevSubnet.has(s.id + '~' + d)) return;
            const e = edgeOf(s, d, ep, basis);
            if (ep && !e.eps.includes(ep)) e.eps.push(ep);
            if (!e.addresses.some((x) => x.ip === ip)) e.addresses.push({ address, ip, ep, role: null, hearsay: true, seenBy: seenBy || null, src });
          };
          m.ipAddresses.forEach((a) => { if (a.hearsay && a.ip !== null) addInferred(a.ip, a.vrf, a.dev, a.ep, 'neighbor', a.address, copySrc(a.src)); });
          const own = new Set(m.ipAddresses.filter((a) => !a.hearsay && a.ip !== null).map((a) => a.dev + '|' + a.ip));
          // 管理 IP 沒有介面，視為 main（RouterOS：沒有指定 VRF 時服務在 main）
          m.devices.forEach((d) => { if (d.mgmtIp && !own.has(d.key + '|' + d.mgmtIp)) addInferred(d.mgmtIp, MAIN, d.key, null, 'mgmt', d.mgmtIp + '/32', copySrc(d.src), d.seenBy.slice()); });
        }
        const edgeList = Array.from(edges.values()).map((e) => Object.assign(e, { eps: e.eps.sort(U.natural) })).sort((x, y) => U.cmp(x.id, y.id));
        // 節點與路由設備
        const subnetsOfDev = new Map(); const nodes = new Map();
        edgeList.forEach((e) => {
          U.getOr(subnetsOfDev, e.dev, () => new Set()).add(e.subnet);
          const n = U.getOr(nodes, e.node, () => ({ id: e.node, dev: e.dev, vrf: e.vrf, ep: nodeMode === 'interface' && !e.node.endsWith('|') ? e.node : null, subnets: [] }));
          if (!n.subnets.includes(e.subnet)) n.subnets.push(e.subnet);
        });
        const routerOf = new Map();
        subnetsOfDev.forEach((set, d) => {
          const x = dev.get(d); const multi = set.size >= 2;
          const basis = !multi ? null : (routesByDev.get(d) || []).length ? 'routes' : x && (x.kind === 'router' || x.kind === 'firewall') ? 'kind' : null;
          routerOf.set(d, { router: !!basis, routerBasis: basis, multihomed: multi });
        });
        const nodeList = Array.from(nodes.values()).map((n) => {
          const x = dev.get(n.dev); const i = n.ep ? ifc.get(n.ep) : null;
          return Object.assign({
            id: n.id, type: nodeMode, dev: n.dev, ep: n.ep, name: nodeMode === 'device' ? null : i ? i.name : n.ep ? K.splitEp(n.ep)[1] : null,
            label: x ? x.label || x.name : n.dev, kind: x ? x.kind : null, collected: !!(x && x.collected), vrf: n.vrf, subnets: n.subnets.sort(U.natural),
          }, routerOf.get(n.dev), { hostAddresses: (hostAddrs.get(n.dev) || []).filter((h) => (nodeMode === 'device' ? h.vrf === n.vrf : h.ep === n.ep)).map((h) => ({ address: h.address, ep: h.ep })) });
        }).sort((x, y) => U.natural(x.dev, y.dev) || U.natural(x.id, y.id));
        // 子網的設備、路由設備、閘道、重疊與重複 IP
        edgeList.forEach((e) => { const s = subnets.get(e.subnet); if (!s.devices.includes(e.dev)) s.devices.push(e.dev); });
        (m.dhcpNetworks || []).forEach((n) => {
          const p = S.ip.parseCidr(n.network); const s = p && subnets.get(keyOf(ipNet(p.ip, p.len), p.len, n.vrf));
          if (s) n.gateways.forEach((g) => { if (!s.gateways.some((x) => x.ip === g && x.dev === n.dev)) s.gateways.push({ ip: g, dev: n.dev, src: copySrc(n.src) }); });
        });
        const seenIp = new Map();
        edgeList.forEach((e) => e.addresses.forEach((a) => { if (!a.hearsay && a.role !== 'vrrp') U.getOr(seenIp, e.subnet + ' ' + a.ip, () => new Set()).add(a.ep); }));
        seenIp.forEach((eps, k) => { if (eps.size > 1) { const [sid, ip] = k.split(' '); subnets.get(sid).duplicateIps.push(ip); } });
        // 路由（選用）：靜態路由與預設路由
        const routes = []; const omitted = { policyRoutes: 0 };
        if (withRoutes) {
          m.routes.forEach((r, idx) => {
            if (r.proto === 'Direct' || !(r.proto === 'Static' || r.proto === 'Blackhole' || r.len === 0)) return;
            if (r.vrf == null) { omitted.policyRoutes++; return; } // 只用於策略路由的路由表：不屬於任何 VRF 容器
            const prefix = r.prefix + '/' + r.len; const sid = K.inVrf(prefix, r.vrf);
            if (!subnets.has(sid)) { subnets.set(sid, subnetNode({ prefix, net: r.prefix, len: r.len, family: 4, vrf: r.vrf }, 'route')); }
            const mine = subnetsOfDev.get(r.dev) || new Set();
            const via = U.uniq(r.nh.filter((h) => h.ip && S.ip.isIp(h.ip)).map((h) => longest(h.ip, h.vrf || r.vrf)).filter((s) => s && mine.has(s.id)).map((s) => s.id));
            const src = copySrc(r.src);
            routes.push({
              id: K.inVrf(r.dev + '|' + prefix, r.vrf) + '#' + (src.length ? src[0].join(':') : idx), dev: r.dev, node: nodeMode === 'device' ? K.inVrf(r.dev, r.vrf) : null, subnet: sid, prefix: r.prefix, len: r.len, default: r.len === 0,
              proto: r.proto, distance: r.distance == null ? null : r.distance, blackhole: !!r.blackhole,
              nh: r.nh.map((h) => ({ ip: h.ip || null, ifc: h.ifc || null, vrf: h.vrf || null, vrfBasis: h.vrfBasis || null })), via, routingTable: r.routingTable || MAIN, vrf: r.vrf, src,
            });
          });
        }
        // 重疊：在路由新增的子網之後才算，路由子網（例如彙總路由）也互相列出。預設路由（/0）包含所有網段，不列。
        // via 與推論邊的最長相符（longest）仍只看直連網段
        const overlapLens = U.uniq(Array.from(subnets.values(), (s) => s.len)).filter((len) => len > 0).sort((a, b) => b - a);
        subnets.forEach((s) => {
          if (s.len === 0) return;
          for (const len of overlapLens) {
            if (len >= s.len) continue;
            const big = subnets.get(keyOf(ipNet(s.net, len), len, s.vrf)); // 只在同一個 VRF 內
            if (big) { s.overlaps.push(big.id); big.overlaps.push(s.id); }
          }
        });
        const vrfOrder = (a, b) => (a === b ? 0 : a === MAIN ? -1 : b === MAIN ? 1 : U.natural(a, b));
        const subnetList = Array.from(subnets.values()).map((s) => Object.assign(s, {
          devices: s.devices.sort(U.natural), routers: s.devices.filter((d) => (routerOf.get(d) || {}).router).sort(U.natural),
          overlaps: U.uniq(s.overlaps).sort(U.natural), duplicateIps: s.duplicateIps.sort(U.natural),
        })).sort((x, y) => U.natural(x.net, y.net) || x.len - y.len || vrfOrder(x.vrf, y.vrf));
        const out = deepFreeze({ subnets: subnetList, nodes: nodeList, edges: edgeList, routes, omitted });
        subnetCache.set(ck, out);
        return out;
      },

      /** 一個搜尋框搜所有東西：MAC、IP、VLAN、設備、介面描述。 */
      search(text, limit) {
        const q = String(text || '').trim(); const max = limit || 20; const out = [];
        if (!q) return out;
        if (K.isMacText(q)) { const r = Q.findMac(q); out.push({ type: 'mac', key: r.mac, label: K.macPretty(r.mac), sub: r.found ? (r.vendor || '') + (r.ips.length ? ' · ' + r.ips.join(', ') : '') : '基準中沒有這個 MAC' }); }
        if (S.ip.isIp(q)) {
          const r = Q.findIp(q);
          // VRF 在 main 時不寫（與 K.inVrf 相同）；在多個 VRF 時寫出數量與名稱，下拉選單就看得出位址重疊
          const vs = r.vrfs; const NAMES = 4;
          const inVrfs = vs.length > 1 ? ` · 在 ${vs.length} 個 VRF：${vs.slice(0, NAMES).join('、')}${vs.length > NAMES ? '…' : ''}` : vs.length === 1 && vs[0] !== MAIN ? ` · VRF ${vs[0]}` : '';
          out.push({ type: 'ip', key: q, label: q, sub: (r.owner ? '介面位址 · ' + Q.epName(r.owner.endsWith('|') ? r.owner + 'mgmt' : r.owner) : r.macs.length ? 'ARP：' + r.macs.map(K.macPretty).join(', ') : r.subnets.length ? '屬於 ' + Q.epName(r.subnets[0].ep) + ' 的網段' : '基準中沒有這個 IP') + inVrfs });
        }
        if (/^\d{1,4}$/.test(q) && +q >= 1 && +q <= 4094) { const v = Q.vlan(+q); out.push({ type: 'vlan', key: q, label: 'VLAN ' + q, sub: v.devices.length ? `${v.devices.length} 台設備${v.domains.length > 1 ? `（${v.domains.length} 個不相連區塊）` : ''} · ${v.names.join(' / ')}` : '基準中沒有這個 VLAN' }); }
        const uq = q.toUpperCase();
        for (const d of m.devices) {
          if (out.length >= max) break;
          if (d.key.includes(uq) || (d.label && d.label.toUpperCase().includes(uq)) || (d.mgmtIp && d.mgmtIp === q)) out.push({ type: 'device', key: d.key, label: d.label || d.name, sub: [d.kind, d.mgmtIp, d.collected ? '' : '未收集'].filter(Boolean).join(' · ') });
        }
        if (out.length < max && q.length >= 3) {
          const lq = q.toLowerCase();
          for (const i of m.interfaces) {
            if (out.length >= max) break;
            if (i.desc && i.desc.toLowerCase().includes(lq)) out.push({ type: 'interface', key: i.key, label: Q.epName(i.key), sub: '描述：' + i.desc });
          }
        }
        return out;
      },
    };
    return Q;
  };
  S.query.findingKey = findingKey;
  S.query.findingBaseKey = findingBaseKey;

  // ---- 不依賴 Snapshot 的靜態資訊：規則目錄與顯示名稱。
  // 掛在 S.query 上（與 findingKey 相同），畫面與下游不必讀 S.check／S.adapters 的內部結構；
  // 目前程式的規則目錄，不是建立該基準時的目錄（見 ADR-006 的「變困難的」）。
  const RULES = Object.freeze(Object.keys(S.check.CATALOG).map((id) => Object.freeze(Object.assign({ id }, S.check.CATALOG[id]))));
  const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));
  /**
   * 一條規則的目錄資料（凍結）：{ id, severity, cat, title, data?, evidenceLimit?, facet?, causes, action }；不認得的 id 為 null。
   * causes／action 給 V.remediation.advice 用，其他畫面不直接讀。
   */
  S.query.rule = (id) => RULE_BY_ID.get(id) || null;
  /** 所有規則（凍結的陣列），依 CATALOG 的宣告順序（I、K、V、A…，匯出附錄依這個順序）；依編號排序的結果見 Q.ruleStatus()。 */
  S.query.rules = () => RULES;
  /** 資料類別（設備的 data、coverage 的 data／missing、收集失敗的 dataTypes）的顯示名稱；不認得時原樣回傳。 */
  S.query.dataLabel = (t) => S.check.DATA_LABEL[t] || t;
  /** 解析器（adapter id，見 meta.adapters、blocks[].adapters）的顯示名稱；不認得時原樣回傳。 */
  S.query.adapterLabel = (id) => (Object.prototype.hasOwnProperty.call(S.adapters, id) && S.adapters[id] && S.adapters[id].label) || id;
  /**
   * 還沒建立查詢介面的 Snapshot JSON（瀏覽器儲存或使用者匯入的檔案）的 meta；不像 Snapshot（不是物件或沒有 meta 物件）時為 null。
   * 用來先判斷 schema／version 是否相容，再決定要 S.query 還是重建。
   */
  S.query.metaOf = (json) => (json && typeof json === 'object' && !Array.isArray(json) && json.meta && typeof json.meta === 'object' && !Array.isArray(json.meta) ? json.meta : null);
})(globalThis.SSOT = globalThis.SSOT || {});
