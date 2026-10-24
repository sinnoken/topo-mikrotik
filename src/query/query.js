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
    const ipOwner = new Map(); const subnets = []; const ipsByEp = new Map(); const heard = new Map();
    m.ipAddresses.forEach((a) => {
      U.getOr(ipsByEp, a.ep, () => []).push(a);
      if (a.ip === null) return;
      if (a.hearsay) { U.getOr(heard, a.ip, () => []).push(a.ep); return; } // 鄰居宣告的位址：事實但非設備自有
      ipOwner.set(a.ip, a.ep);
      if (a.len < 32) subnets.push({ ep: a.ep, dev: a.dev, net: S.ip.parseCidr(a.address).net, len: a.len, ip: a.ip });
    });
    m.devices.forEach((d) => { if (d.mgmtIp && !ipOwner.has(d.mgmtIp)) ipOwner.set(d.mgmtIp, d.key + '|'); });
    const arpsByIp = new Map(); m.arps.forEach((a) => U.getOr(arpsByIp, a.ip, () => []).push(a));
    const vlansByDev = new Map();
    m.vlans.forEach((v) => U.getOr(vlansByDev, v.dev, () => []).push(v));
    const routesByDev = new Map(); m.routes.forEach((r) => U.getOr(routesByDev, r.dev, () => []).push(r));
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
    const vlanSrc = { vlans: m.vlans, interfaces: m.interfaces, links: m.links, inferred: m.inferredLinks || [], ifc: (ep) => ifc.get(ep), collected: (d) => !!(dev.get(d) || {}).collected };
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
      routesOf: (d) => routesByDev.get(d) || [],
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
        const CLS_RANK = ['lag', '40g', '10g', '1g', 'oob', 'other'];
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
      ipOwner: (ip) => ipOwner.get(ip) || null,
      /** 介面上的 IP 位址實體（含鄰居宣告）。 */
      ipsOf: (ep) => ipsByEp.get(ep) || [],
      /** 介面位址文字（CIDR），畫面顯示用。 */
      addressesOf: (ep) => (ipsByEp.get(ep) || []).map((a) => a.address),
      prefixes: () => m.prefixes,
      subnets: () => subnets,
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
      // 每個不重複的 IP 一列：介面位址、設備管理 IP 與 ARP 出現的 IP 合併，來源保留在 from
      ipEntries() {
        const all = new Set(ipOwner.keys()); arpsByIp.forEach((_, ip) => all.add(ip)); heard.forEach((_, ip) => all.add(ip));
        return Array.from(all).sort(U.natural).map((ip) => {
          const owner = ipOwner.get(ip) || null; const macs = U.uniq((arpsByIp.get(ip) || []).map((a) => a.mac));
          const from = [owner ? (owner.endsWith('|') ? '管理' : '介面') : null, macs.length ? 'ARP' : null, !owner && heard.has(ip) ? '鄰居宣告' : null].filter(Boolean);
          const ownerDev = owner ? K.splitEp(owner)[0] : null;
          return { ip, owner, dev: ownerDev, ifc: owner && !owner.endsWith('|') ? Q.epName(owner).slice(Q.devName(ownerDev).length + 1) : null, macs, from };
        });
      },
      /** 每個直連網段一列：設定在哪些介面／設備，以及清單中落在網段內的 IP 數（介面位址、管理 IP、ARP 合計）。 */
      prefixEntries(ips) {
        return m.prefixes.map((p) => ({
          prefix: p.prefix, net: p.net, len: p.len, basis: p.basis, eps: p.eps,
          devs: U.uniq(p.eps.map((ep) => K.splitEp(ep)[0])).sort(U.natural),
          ipCount: (ips || Q.ipEntries()).filter((r) => S.ip.inNet(r.ip, p.net, p.len)).length,
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
          else if (e.type === 'ip') { const o = ipOwner.get(e.key); d = o && K.splitEp(o)[0]; }
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
      findIp(ip) {
        if (!S.ip.isIp(ip)) return null;
        const arps = arpsByIp.get(ip) || [];
        const macs = U.uniq(arps.map((a) => a.mac));
        const nets = subnets.filter((s) => S.ip.inNet(ip, s.net, s.len)).sort((a, b) => b.len - a.len);
        const locations = [];
        macs.forEach((mk) => { const x = mac.get(mk); if (x) x.edge.forEach((ep) => locations.push({ mac: mk, ep })); });
        return { ip, owner: ipOwner.get(ip) || null, arps, macs, subnets: nets, locations };
      },
      /**
       * VLAN id 在整個基準的承載情況；domains 依承載此 VLAN 的鏈路與推論鏈路分成互不相連的區塊（推論，見設計說明 §5.3）。
       * 給 domain（區塊的 key）時，devices／entries／carry／partial／inferred 只含那個區塊。
       */
      vlan(id, domain) {
        id = +id;
        const all = S.infer.vlanSpan(vlanSrc, id);
        const pick = (d) => {
          const set = new Set(d.devices); const has = (l) => set.has(K.splitEp(l.a)[0]) || set.has(K.splitEp(l.b)[0]);
          return Object.assign({}, d, { entries: all.entries.filter((e) => set.has(e.dev)), carry: all.carry.filter(has), partial: all.partial.filter(has), inferred: all.inferred.filter(has) });
        };
        const domains = all.domains.map(pick);
        const one = domain != null && domains.find((d) => d.key === domain);
        const scope = one || all;
        return { id, domain: one ? one.key : null, domains, entries: scope.entries, devices: scope.devices, carry: scope.carry, partial: scope.partial, inferred: scope.inferred,
          names: U.uniq(scope.entries.map((e) => e.name).filter(Boolean)) };
      },

      /** 一個搜尋框搜所有東西：MAC、IP、VLAN、設備、介面描述。 */
      search(text, limit) {
        const q = String(text || '').trim(); const max = limit || 20; const out = [];
        if (!q) return out;
        if (K.isMacText(q)) { const r = Q.findMac(q); out.push({ type: 'mac', key: r.mac, label: K.macPretty(r.mac), sub: r.found ? (r.vendor || '') + (r.ips.length ? ' · ' + r.ips.join(', ') : '') : '基準中沒有這個 MAC' }); }
        if (S.ip.isIp(q)) { const r = Q.findIp(q); out.push({ type: 'ip', key: q, label: q, sub: r.owner ? '介面位址 · ' + Q.epName(r.owner.endsWith('|') ? r.owner + 'mgmt' : r.owner) : r.macs.length ? 'ARP：' + r.macs.map(K.macPretty).join(', ') : r.subnets.length ? '屬於 ' + Q.epName(r.subnets[0].ep) + ' 的網段' : '基準中沒有這個 IP' }); }
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
