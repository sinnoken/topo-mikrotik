/*
 * 路由追蹤（L3，查詢層，只讀 Snapshot）。L4 可達性與 zone 矩陣在 src/query/reach.js。
 *
 * 路由追蹤 S.trace(Q, src, dst)：在基準的路由表上，從來源 IP 逐跳走到目的 IP。
 *  - 起點：介面網段包含來源 IP 的設備（最長遮罩優先），即來源的閘道
 *  - 每一跳：目的在直連網段 → 抵達；否則最長前綴比對，同遮罩多條即 ECMP 分支
 *  - 下一跳 IP → 擁有該 IP 的設備；下一跳本身不屬於任何設備時，沿本機路由表遞迴解析（S.check.resolveNextHopIn，與檢查共用快取）；找不到、沒有路由資料、黑洞路由、迴圈、TTL 用盡都會停下並註明原因
 *  每一跳的轉送決定（lookup、routeDecision、nextOwner，掛在 S.trace 上）與路徑展開（walker：起點、逐跳、迴圈、TTL、送往外部）
 *  都與 L4 可達性（src/query/reach.js 的 S.reach.engine）共用，不另寫一份；L4 只在每一跳掛上 raw／nat／filter（ADR-023 決策 3）。
 */
(function (S) {
  'use strict';
  const IP = S.ip;
  const K = S.keys;
  const U = S.util;
  /** 最多走幾跳（L3 路由追蹤與 L4 可達性共用；設計說明 §5.3 的 TTL 32）。 */
  const TTL = 32;
  const deepFreeze = (o) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
    return o;
  };
  /** 中文的列舉：「甲、乙與丙」。 */
  const zhList = (xs) => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join('、') + '與' + xs[xs.length - 1]);
  /**
   * /routing rule 可以判斷的條件（ruleMatches 只判斷這幾個，其他條件無法判斷；routing-mark 另見 ruleMatches）。
   * 前提的文字由這份產生（ASSUMPTIONS 的 policy-routing）。
   */
  const RULE_CONDITIONS = deepFreeze([{ key: 'src-address', label: '來源位址' }, { key: 'dst-address', label: '目的位址' }, { key: 'interface', label: '入介面' }]);
  const RULE_CONDITION_KEYS = new Set(RULE_CONDITIONS.map((c) => c.key));
  /**
   * 路由層的前提（L3 路由追蹤與 L4 可達性共用；L4 在 S.reach.ASSUMPTIONS 另列防火牆層與推論假設）：
   *   code、layer 'route'、short（一句白話，畫面列表用）、detail（完整說明；RouterOS 原值放在括號內）、message（同 detail，相容舊的讀法）。
   * 文字中的數字與條件清單由程式常數產生（TTL、RULE_CONDITIONS），改常數時文字跟著變（tests/core/assumptions.js）。
   */
  const assume = (code, layer, short, detail) => ({ code, layer, short, detail, message: detail });
  const ASSUMPTIONS = deepFreeze([
    assume('ipv4-vrf', 'route', '只算 IPv4，依入介面所屬的 VRF 查路由表',
      `只算 IPv4（RouterOS 7）；封包依入介面所屬的 VRF 查那個 VRF 的路由表，閘道指定了其他 VRF（@<VRF>）時在那個 VRF 解析（路由洩漏）；最多逐跳走 ${TTL} 跳，超過時結果為不明（TTL）；不驗證設備的 RouterOS 版本`),
    assume('policy-routing', 'route', '依路由規則決定查哪張路由表，條件判斷不了算不明',
      `策略路由：main 路由表的封包依路由規則（/routing rule）的順序決定查哪一張路由表，可判斷的條件是${zhList(RULE_CONDITIONS.map((c) => c.label))}（${RULE_CONDITIONS.map((c) => c.key).join('、')}）；改過路由設定的策略規則（/routing settings 的 policy-rules），或條件無法判斷時，結果為不明，不假設查 main`),
    assume('mark-routing', 'route', '有路由標記的設備，轉送算不明',
      '設備只要有一條啟用中的封包標記規則設定路由標記（mangle 的 mark-routing），這台設備的轉送就是不明——不看那條規則的比對條件，不判斷哪些封包會被標記'),
    assume('bridge-ip-firewall', 'route', '同一個網段的流量視為不經過路由器的防火牆',
      '同一個網段的流量視為不經過路由器的防火牆；橋接設定讓橋接流量也走防火牆（/interface bridge settings 的 use-ip-firewall）時，橋接流量也會經過過濾規則，這種情況不在範圍內'),
  ]);
  /** 策略路由不明（routeDecision 的 policy-unknown）的原因 → 前提：mangle 的 mark-routing 是 mark-routing，其他（policy-rules、條件、action）是 policy-routing。 */
  const policyAssumption = (why) => (why === 'mark-routing' ? 'mark-routing' : 'policy-routing');
  /**
   * S.trace 的 ends[].status（與 reason）對應的前提（null：由事實決定的結果，或資料不足，不是前提造成的）。
   * policy 依 ends[].assumption（policyAssumption），這裡列出可能的前提。
   */
  const END_STATUSES = deepFreeze([
    { status: 'reached', assumption: null }, { status: 'unverified', assumption: null }, { status: 'ttl', assumption: 'ipv4-vrf' },
    { status: 'policy', assumption: ['policy-routing', 'mark-routing'] }, { status: 'policy-drop', assumption: null }, { status: 'noroute', assumption: null },
    { status: 'blackhole', assumption: null }, { status: 'egress', assumption: 'external' }, { status: 'unknown-nh', assumption: null, reasons: { 'egress-possible': 'external' } },
    { status: 'loop', assumption: null },
  ]);

  /**
   * 單跳轉送決定（lookup、lookupTable、routeDecision、nextOwner）只透過這個最小介面（路由視圖 R）讀資料，不直接讀 Q 的其他成員：
   *   vrfs()、vrfsOf(dev)、subnetsOf(dev, vrf)、routesOf(dev, vrf?)、routesInTable(dev, table)、hopOwner(dev, ip, vrf)、policyOf(dev)、routesIncomplete(dev)
   * 每個成員的語意與回傳形狀同 Q 的同名函式（docs/查詢介面.md）；回傳的陣列要是同一份（數字形式依陣列快取）。
   * 查詢層用 routingOf(Q)；之後模型（⑥ 檢查）可以用 M 提供另一份實作，與查詢層共用同一套單跳決定。
   */
  const ROUTING_VIEW = Object.freeze(['vrfs', 'vrfsOf', 'subnetsOf', 'routesOf', 'routesInTable', 'hopOwner', 'policyOf', 'routesIncomplete']);
  const viewMemo = new WeakMap();
  /** Q 的路由視圖（每個 Q 一份；成員直接轉給 Q 的同名函式）。 */
  const routingOf = (Q) => {
    let r = viewMemo.get(Q);
    if (!r) { r = Object.freeze(ROUTING_VIEW.reduce((o, k) => { o[k] = Q[k]; return o; }, {})); viewMemo.set(Q, r); }
    return r;
  };
  /** 某設備某個 VRF 的路由表（routes[].vrf 等於它）；VRF 不在基準中（例如 @ 寫了不存在的名稱）時為空。 */
  const routesIn = (R, dev, vrf) => (R.vrfs().includes(vrf) ? R.routesOf(dev, vrf) : []);
  /**
   * 直連網段的陣列（Q.subnets()、Q.subnetsOf() 的回傳值）中包含 ip、遮罩最長的元素（同遮罩多筆全取，順序不變）；沒有時為空陣列。
   * vrf（選用）：只看這個 VRF 的網段（Q.subnets() 含所有 VRF）。「位址落在哪個直連網段」只在這裡判斷（路由追蹤、L4 的起點、出介面與 hairpin 都用它）。
   * 最長前綴查表是 IP.longestPrefix（依前綴長度分桶的索引，與檢查的下一跳解析共用）；list 要是查詢介面回傳的同一個陣列（索引依陣列快取）。
   */
  const longestSubnets = (list, ip, vrf) => IP.longestPrefix(list, 'net', typeof ip === 'number' ? ip : IP.toInt(ip), vrf !== undefined ? (x) => x.vrf === vrf : undefined);
  /** 最長前綴的路由（同遮罩多條全取，順序不變）；n 是 IP.toInt 的結果。 */
  const longestRoutes = (routes, n) => IP.longestPrefix(routes, 'prefix', n);
  /**
   * 一台設備在某個 VRF 對目的位址的轉送決定（ADR-015：只看那個 VRF 的直連網段與路由表）：
   *   { kind: 'connected', conn }：目的在直連網段（conn 是 Q.subnets() 的元素，最長遮罩）
   *   { kind: 'no-route-data' }：沒有路由表資料（這台設備一筆路由都沒有）
   *   { kind: 'no-match', routes }：沒有符合的路由
   *   { kind: 'route-data-incomplete', routes }：沒有符合的路由，但這台設備的路由表收集不完整（R.routesIncomplete，例如逾時），不能當成沒有路由（不明）
   *   { kind: 'blackhole', route, routes }：最長前綴的路由都是黑洞
   *   { kind: 'route', route, proto, nhs: [{ r, n }], routes }：下一跳（同遮罩多條即 ECMP）；n.vrf 是解析這個閘道的 VRF
   * 每種結果都有 vrf（做出決定的 VRF）與 via（經過的 VRF，依序）：路由的閘道是 VRF 介面（下一跳 vrfBasis 為 vrf-interface，
   * 手冊：gateway=vrfTest2）時在同一台設備的那個 VRF 再查一次，via 會有兩個以上。
   */
  function lookup(R, dev, dst, vrf, via) {
    const v = K.vrf(vrf); const seen = (via || []).concat(v);
    const done = (x) => Object.assign(x, { vrf: v, via: seen, table: v });
    const n = IP.toInt(dst);
    const conn = longestSubnets(R.subnetsOf(dev, v), n)[0];
    if (conn) return done({ kind: 'connected', conn });
    if (!R.routesOf(dev).length) return done({ kind: 'no-route-data', routes: [] });
    const routes = routesIn(R, dev, v);
    const cands = longestRoutes(routes, n);
    if (!cands.length) return done({ kind: R.routesIncomplete(dev) ? 'route-data-incomplete' : 'no-match', routes });
    const route = `${cands[0].prefix}/${cands[0].len}`;
    if (cands.every((r) => r.blackhole)) return done({ kind: 'blackhole', route, routes });
    const nhs = [];
    cands.forEach((r) => r.nh.forEach((n) => nhs.push({ r, n })));
    const leak = nhs.find(({ n }) => !n.ip && n.vrfBasis === 'vrf-interface' && n.vrf !== v);
    if (leak && !seen.includes(leak.n.vrf)) return lookup(R, dev, dst, leak.n.vrf, seen);
    return done({ kind: 'route', route, proto: cands[0].proto, nhs, routes });
  }
  /**
   * 在一張路由表查目的：main 或這台設備的 VRF 用 lookup（含直連網段）；其他路由表（/routing table 定義的策略路由表）只有寫進那張表的路由，
   * 沒有直連網段（直連路由只在 main 與 VRF 的表）。回傳同 lookup，另有 table。
   */
  function lookupTable(R, dev, dst, table) {
    if (table === K.MAIN_VRF || R.vrfsOf(dev).some((v) => !v.disabled && !v.builtin && v.name === table)) return Object.assign(lookup(R, dev, dst, table), { table });
    const routes = R.routesInTable(dev, table);
    const cands = longestRoutes(routes, IP.toInt(dst));
    const base = { vrf: K.MAIN_VRF, via: [K.MAIN_VRF], table };
    // 路由表收集不完整時，查不到不代表這張表沒有（同 lookup）；策略路由不會因此改查下一條規則（routeDecision 視為已決定、結果不明）
    if (!cands.length) return Object.assign({ kind: R.routesIncomplete(dev) ? 'route-data-incomplete' : 'no-match', routes }, base);
    const route = `${cands[0].prefix}/${cands[0].len}`;
    if (cands.every((r) => r.blackhole)) return Object.assign({ kind: 'blackhole', route, routes }, base);
    const nhs = []; cands.forEach((r) => r.nh.forEach((n) => nhs.push({ r, n })));
    return Object.assign({ kind: 'route', route, proto: cands[0].proto, nhs, routes }, base);
  }
  /** 策略路由規則的參照（輸出用，含來源行）。 */
  const ruleRef = (r) => ({ dev: r.dev, order: r.order, action: r.action, table: r.table, match: Object.assign({}, r.match), comment: r.comment || null, src: r.src.map((x) => x.slice()) });
  /**
   * routing rule 的條件是否符合封包：true／false，或 null（無法判斷，keys 列出條件）。
   * 可以判斷的條件：src-address、dst-address（單一網段）、interface（入介面已知時）、routing-mark（沒有 mangle 的 mark-routing 時封包沒有標記，一定不符）。
   */
  function ruleMatches(r, pkt) {
    const unknown = []; let ok = true;
    const inNet = (ip, v) => { const p = /^[\d.]+(\/\d{1,2})?$/.test(String(v)) ? S.ip.parseCidr(v) : null; return p ? IP.inNet(ip, p.net, p.len) : null; };
    Object.keys(r.match).forEach((k) => {
      const v = r.match[k];
      if (!RULE_CONDITION_KEYS.has(k)) {
        if (k === 'routing-mark') ok = false;
        else if (!(k === 'chain' && v === 'user')) unknown.push(k); // 預設的 user chain 不是條件
      } else if (k === 'src-address' || k === 'dst-address') {
        const ip = k === 'src-address' ? pkt.src : pkt.dst; const hit = ip == null ? null : inNet(ip, v);
        if (hit === null) unknown.push(k); else if (!hit) ok = false;
      } else if (!pkt.inEp) unknown.push(k); // interface
      else if (K.ifc(v) !== K.splitEp(pkt.inEp)[1]) ok = false;
    });
    return unknown.length ? (ok ? { match: null, keys: unknown } : { match: false, keys: [] }) : { match: ok, keys: [] };
  }
  /**
   * 一台設備的轉送決定，含策略路由（RouterOS 7 的查表順序，https://manual.mikrotik.com/docs/user-guides/routing-and-networking-protocols/routing-decision.md）：
   * 預設依序是 mangle（mark-routing）→ 入介面屬於 VRF 時查那個 VRF（查不到就拒絕）→ 送給設備自己 → /routing rule（user chain，依序）→ main。
   * 「送給設備自己」由呼叫端先判斷。這裡的做法：
   *   - 設備沒有任何 /routing rule、mark-routing，也沒改 policy-rules：就是 lookup（沒有策略路由的網路結果不變）。
   *   - 有 mangle 的 mark-routing（mangle 不在模型中），或改過 /routing settings 的 policy-rules：無法判斷查哪一張表 → { kind: 'policy-unknown' }。
   *   - 封包在 VRF：查那個 VRF（使用者的 rule 在 VRF 之後）。
   *   - 在 main：依序比對 rule；條件無法判斷 → policy-unknown；符合時 drop／unreachable → { kind: 'policy-drop', rule }，
   *     lookup → 在 table 查，查不到就看下一條；lookup-only-in-table → 只在 table 查；其他 action → policy-unknown。都沒有決定時查 main。
   * pkt：{ src（null＝不明）, dst, vrf, inEp（介面鍵；null＝設備自己送出；undefined＝不明） }。回傳同 lookup，另有 table、rule（決定查表的規則）。
   */
  function routeDecision(R, dev, pkt) {
    const pol = R.policyOf(dev);
    if (!pol.any) return lookup(R, dev, pkt.dst, pkt.vrf);
    const v = K.vrf(pkt.vrf);
    if (pol.custom) return { kind: 'policy-unknown', why: 'policy-rules', vrf: v, via: [v], rules: [], note: `/routing settings 的 policy-rules 改過（${pol.policyRules.join(',')}），查表順序不在可判斷的範圍` };
    if (pol.marks.length) return { kind: 'policy-unknown', why: 'mark-routing', vrf: v, via: [v], rules: [], marks: pol.marks.map((x) => ({ chain: x.chain, mark: x.mark, src: x.src.map((s) => s.slice()) })), note: `有 ${pol.marks.length} 條 mangle mark-routing（mangle 不在模型中），封包可能改查其他路由表` };
    if (v !== K.MAIN_VRF) return lookup(R, dev, pkt.dst, v);
    for (const r of pol.rules) {
      const m = ruleMatches(r, pkt);
      if (m.match === null) return { kind: 'policy-unknown', why: 'condition', vrf: v, via: [v], rules: [ruleRef(r)], keys: m.keys, note: `/routing rule 第 ${r.order} 條的條件 ${m.keys.join('、')} 無法判斷` };
      if (!m.match) continue;
      if (r.action === 'drop' || r.action === 'unreachable') return { kind: 'policy-drop', vrf: v, via: [v], rule: ruleRef(r), note: `/routing rule 第 ${r.order} 條 ${r.action}` };
      if ((r.action === 'lookup' || r.action === 'lookup-only-in-table') && r.table) {
        const lk = lookupTable(R, dev, pkt.dst, K.vrf(r.table));
        if (lk.kind !== 'no-match' && lk.kind !== 'no-route-data') return Object.assign(lk, { rule: ruleRef(r) });
        if (r.action === 'lookup-only-in-table') return Object.assign(lk, { kind: 'no-match', rule: ruleRef(r) });
        continue;
      }
      return { kind: 'policy-unknown', why: 'action', vrf: v, via: [v], rules: [ruleRef(r)], note: `/routing rule 第 ${r.order} 條的 action ${r.action} 不在可判斷的範圍` };
    }
    return Object.assign(lookup(R, dev, pkt.dst, v), { table: v });
  }

  /**
   * 下一跳 IP（在 dev 的 vrf 解析）屬於哪台設備：
   *   { status: 'direct', ep, dev, vrf, crossVrf }（某台設備的位址；vrf 是對方所在的 VRF，規則見 R.hopOwner）
   *   { status: 'recursive', hits: [{ dev, vrf, chain }] }（不是已知位址，沿這個 VRF 的路由表遞迴解析到已知設備，例如 gateway 是對端 loopback）
   *   { status: 'unknown' }（不在基準內）。
   */
  function nextOwner(R, dev, ip, vrf) {
    const v = K.vrf(vrf);
    const own = R.hopOwner(dev, ip, v);
    if (own) return { status: 'direct', ep: own.key, dev: own.dev, vrf: own.vrf, crossVrf: own.crossVrf };
    // 遞迴解析與檢查 R01／R03／R04 共用，依 (R, dev, vrf, ip) 快取（S.check.resolveNextHopIn）；快取的結果凍結，chain 另外複製
    const hit = S.check.resolveNextHopIn(R, dev, ip, v).filter((x) => x.status === 'known');
    return hit.length ? { status: 'recursive', hits: hit.map((x) => ({ dev: x.owner, vrf: R.hopOwner(dev, x.ip, v).vrf, chain: x.chain.slice() })) } : { status: 'unknown' };
  }
  /** 來源位址可能在哪些 VRF：擁有它，或它落在某個直連網段（Q.vrfs() 的順序）。 */
  function vrfsOfIp(Q, ip) {
    const set = new Set(Q.subnets().filter((s) => IP.inNet(ip, s.net, s.len)).map((s) => s.vrf));
    Q.vrfs().forEach((v) => { if (Q.ipOwner(ip, v)) set.add(v); });
    return Q.vrfs().filter((v) => set.has(v));
  }
  /**
   * 查詢的 VRF：給了就必須是基準中的 VRF（否則 TypeError）；沒給時依來源位址：只在一個 VRF 時用它，不在任何 VRF 時是 main，
   * 在多個 VRF（位址重疊）時回傳 { error, vrfs }，由呼叫端請使用者指定，不猜。
   */
  function pickVrf(Q, src, vrf) {
    if (vrf != null) {
      const v = K.vrf(vrf);
      if (!Q.vrfs().includes(v)) throw new TypeError(`基準中沒有 VRF ${JSON.stringify(String(vrf))}（有：${Q.vrfs().join('、')}）`);
      return { vrf: v };
    }
    const c = vrfsOfIp(Q, src);
    if (c.length > 1) return { error: `${src} 在多個 VRF（${c.join('、')}），請指定 vrf`, vrfs: c };
    return { vrf: c[0] || K.MAIN_VRF };
  }

  // ================================================================ 路徑展開（L3 路由追蹤與 L4 可達性共用，ADR-023 決策 3）
  const level = (map, k) => { let x = map.get(k); if (!x) { x = new Map(); map.set(k, x); } return x; };
  const realEp = (ep) => (ep && !ep.endsWith('|') ? ep : undefined); // 管理 IP（「設備|」）沒有介面
  const BUSY = Symbol('busy');
  /**
   * 快取最後一層的鍵：目的（32 位元）與封包其他欄位（pk，非負整數）。pk < 2^21 時合成一個數字（目的 × 2^21 ＋ pk，最大 2^53 − 1，不會碰撞，
   * 1000 台的矩陣不必每個目的多一層 Map）；更大時用字串（數字與字串的鍵不會相同）。
   */
  const PK_SPAN = 2 ** 21;
  const cellKey = (dstN, pk) => (pk < PK_SPAN ? dstN * PK_SPAN + pk : dstN + '|' + pk);
  /**
   * 路徑結束代碼 → 路由層的結果（Q.reach 的 paths[].route.status）。null：不是路由決定的結束（防火牆、NAT、管理服務），
   * 路由層的結果由那一跳之後只看路由的展開決定（L4 的 routeOfNode）。未收集的設備另依目的是否在它的直連網段判斷（routeOfEnd）。
   */
  const ROUTE_OF_END = Object.freeze({
    loop: 'loop', 'no-route': 'no-route', blackhole: 'blackhole', 'policy-drop': 'policy-drop',
    local: 'reached', host: 'reached', segment: 'reached', 'same-subnet': 'reached', 'egress-wan': 'reached', 'dst-device-uncollected': 'reached',
    ttl: 'unknown', 'no-route-data': 'unknown', 'route-data-incomplete': 'unknown', 'policy-routing': 'unknown', 'next-hop-outside': 'unknown', 'egress-possible': 'unknown', 'src-location-unknown': 'unknown', 'no-gateway': 'unknown',
    'device-uncollected': 'unknown', 'src-device-uncollected': 'unknown',
  });
  /** 對外邊界的弱證據（只有弱證據時是 possible）在訊息中的說法。 */
  const BOUNDARY_WEAK = Object.freeze({ 'public-address': '介面上有公網位址', 'cgnat-address': '介面上有 CGNAT 位址', 'dstnat-address': 'dst-nat 的目的是這個介面上的公網位址' });
  /** 路由沒有到（拒絕）的路由層結果：這些情況防火牆的結果是 n/a。 */
  const ROUTE_DENY = Object.freeze(['no-route', 'blackhole', 'policy-drop', 'loop']);

  /** 來源所在網段的閘道依據（srcLocation 的 basis，依優先順序；Q.reach 的 start.basis 與 S.trace 的 startBasis，後者另有 device）。 */
  const START_BASES = Object.freeze(['dhcp', 'next-hop', 'default-route', 'routes', 'subnet']);
  const sharedMemo = new WeakMap();
  /**
   * 每個 Q 一份、L3 與 L4 的展開共用的資料與快取：位址擁有者、轉送決定、來源所在的位置、基準的網段（prefixes）與 WAN 介面。
   */
  function shared(Q) {
    let X = sharedMemo.get(Q);
    if (X) return X;
    const RV = routingOf(Q);
    const m = Q.snapshot.model;
    const devOfEp = (ep) => K.splitEp(ep)[0];
    const intMemo = new Map();
    const intOf = (ip) => { let n = intMemo.get(ip); if (n === undefined) { n = IP.toInt(ip); intMemo.set(ip, n); } return n; };
    const odMemo = new Map();
    // 位址的擁有者都在封包所在的 VRF 查（ADR-015）
    const ownerDev = (ip, vrf) => { const k = K.inVrf(ip, vrf); let d = odMemo.get(k); if (d === undefined) { const o = Q.ipOwner(ip, vrf); d = o ? devOfEp(o) : null; odMemo.set(k, d); } return d; };
    const infoMemo = new Map();
    const devInfo = (d) => U.getOr(infoMemo, d, () => { const x = Q.getDevice(d); return { exists: !!x, collected: !!(x && x.collected), host: !!x && x.kind === 'host' }; });
    const netDev = (d) => { const x = devInfo(d); return x.exists && !x.host; };
    // 網段（IPv4 的 prefixes，每個 VRF 分開；key 是網段鍵 K.inVrf）與最長前綴：「目的在不在基準內」與 L4 的 zone 共用
    let p4 = null; let lens = null; let byPrefix = null;
    const prefixes4 = () => p4 || (p4 = (m.prefixes || []).filter((p) => (p.family || 4) === 4).map((p) => {
      const lo = IP.toInt(p.net); const hi = lo + (p.len >= 32 ? 0 : 2 ** (32 - p.len) - 1); const vrf = K.vrf(p.vrf);
      return { p, prefix: p.prefix, key: K.inVrf(p.prefix, vrf), vrf, net: p.net, len: p.len, lo, hi };
    }));
    const longestPrefix = (ip, vrf) => {
      if (!lens) { byPrefix = new Map(prefixes4().map((x) => [x.key, x])); lens = U.uniq(prefixes4().map((x) => x.len)).sort((a, b) => b - a); }
      const n = IP.toInt(ip);
      for (const len of lens) { const x = byPrefix.get(K.inVrf(IP.fromInt((n & IP.maskOf(len)) >>> 0) + '/' + len, vrf)); if (x) return x; }
      return null;
    };
    /**
     * 出介面的對外邊界（推論，Q.boundaryOf，ADR-023 決策 1）：'external'（送往外部）｜'possible'（只有弱證據，不判定）｜'internal'（沒有證據）。
     * WAN 清單的成員是證據之一（wan-list），所以原本的「WAN 清單的介面」都還是 external。
     */
    const boundaryStatus = (ep) => { if (!ep) return 'internal'; const b = Q.boundaryOf(ep); return b ? b.status : 'internal'; };
    const lookMemo = new Map();
    const look = (dev, dst, vrf) => U.getOr(level(level(lookMemo, dev), vrf), dst, () => lookup(RV, dev, dst, vrf));
    // 轉送決定（含策略路由，routeDecision）：沒有策略路由的設備只依目的與 VRF 快取；有的時候也依入介面與來源
    const decMemo = new Map();
    const decide = (dev, st, inEp) => {
      if (!Q.policyOf(dev).any) return look(dev, st.dst, st.vrf);
      const leaf = level(level(level(level(decMemo, dev), st.vrf), inEp === undefined ? '~' : inEp === null ? '-' : inEp), st.src == null ? 'n' : st.src);
      return U.getOr(leaf, st.dst, () => routeDecision(RV, dev, { src: st.src, dst: st.dst, vrf: st.vrf, inEp }));
    };
    const locMemo = new Map();
    /**
     * 來源在 vrf 中的位置（memo 依 VRF 與位址）：
     *   { how: 'device', dev, ep }：來源是網路設備自己的位址（封包從那台設備送出）
     *   { how: 'none' }：不在任何直連網段
     *   { how: 'subnet', prefix, net, len, gateways: [{ dev, ep, gateway }], basis, candidates, mask, netN }：來源所在的網段（最長遮罩）與它的閘道。
     * 閘道依序取：DHCP 的 gateway（basis dhcp）→ 網段上其他設備的預設路由指向的設備（next-hop）→ 有路由表、不是用戶端的設備，其中有預設路由的優先（default-route／routes）
     * → 已收集的設備（subnet）。同一個依據有多台時全部都算（主機用哪一個閘道無法判斷，不猜）；candidates 是網段上所有的設備。
     */
    function srcLocation(src, vrf) {
      return U.getOr(locMemo, K.inVrf(src, vrf), () => {
        const own = Q.ipOwner(src, vrf); const sd = own ? devOfEp(own) : null;
        if (sd && netDev(sd)) return { how: 'device', dev: sd, ep: realEp(own) || null, vrf };
        const same = longestSubnets(Q.subnets(), src, vrf);
        if (!same.length) return { how: 'none', vrf };
        const len = same[0].len; const net = same[0].net; const prefix = `${net}/${len}`;
        const cands = U.uniq(same.map((s) => s.dev)).sort(U.natural);
        const epOn = (d) => same.find((s) => s.dev === d).ep;
        const dhcp = U.uniq((m.dhcpNetworks || []).filter((n) => { const p = S.ip.parseCidr(n.network); return K.vrf(n.vrf) === vrf && p && p.net === net && p.len === len; })
          .flatMap((n) => n.gateways).filter((g) => IP.isIp(g))).sort(U.natural);
        let gws = dhcp.map((g) => ({ ip: g, owner: Q.ipOwner(g, vrf) })).filter((g) => g.owner && cands.includes(devOfEp(g.owner))).map((g) => ({ dev: devOfEp(g.owner), ep: realEp(g.owner), gateway: g.ip }));
        let basis = 'dhcp';
        if (!gws.length) {
          // 預設路由的下一跳：網段上其他設備的預設路由指向這個網段內某台設備的位址 → 那台是這個網段的預設閘道（basis next-hop）。
          // 預設路由經這個網段內的下一跳送出的設備（例如交換器的管理位址）是這個網段的用戶端，不當閘道。
          const dflt = (d) => Q.routesOf(d, vrf).filter((r) => r.len === 0 && !r.blackhole).flatMap((r) => r.nh).filter((n) => n.ip);
          const nhIn = (d) => dflt(d).filter((n) => IP.inNet(n.ip, net, len));
          const pointed = U.uniq(cands.flatMap(nhIn).map((n) => { const o = Q.ipOwner(n.ip, vrf); return o ? devOfEp(o) : null; }).filter((d) => d && cands.includes(d))).sort(U.natural);
          const client = (d) => nhIn(d).length > 0;
          if (pointed.length) { basis = 'next-hop'; gws = pointed.map((d) => ({ dev: d, ep: epOn(d), gateway: null })); }
          else {
            // 其餘有路由表、不是用戶端的設備；其中有預設路由的優先（主機的預設閘道要能送往任何地方，basis default-route）
            const rt = cands.filter((d) => Q.routesOf(d).length && !client(d)); const withDefault = rt.filter((d) => dflt(d).length);
            basis = withDefault.length && withDefault.length < rt.length ? 'default-route' : 'routes';
            gws = (basis === 'default-route' ? withDefault : rt).map((d) => ({ dev: d, ep: epOn(d), gateway: null }));
          }
        }
        if (!gws.length) { basis = 'subnet'; gws = cands.filter((d) => devInfo(d).collected).map((d) => ({ dev: d, ep: epOn(d), gateway: null })); }
        gws = gws.filter((g, i) => gws.findIndex((x) => x.dev === g.dev && x.ep === g.ep) === i);
        // mask／netN：網段的數字形式（begin 每次查詢都要判斷目的是否在同一個網段，算式同 IP.inNet）
        const mask = IP.maskOf(len);
        return { how: 'subnet', prefix, net, len, gateways: gws, basis, candidates: cands, vrf, mask, netN: (IP.toInt(net) & mask) >>> 0 };
      });
    }
    X = { RV, devOfEp, intOf, ownerDev, devInfo, netDev, prefixes4, longestPrefix, boundaryStatus, look, decide, srcLocation };
    sharedMemo.set(Q, X);
    return X;
  }

  /**
   * 路徑展開（walker）：從起點逐跳走到目的。L3 路由追蹤（S.trace）與 L4 可達性（S.reach）都用這一份：
   *   起點（srcLocation／begin）、進入設備（TTL、迴圈、未收集的設備）、目的是設備本身、轉送決定（策略路由、沒有路由、黑洞、ECMP 分支）、
   *   下一跳（遞迴解析、送往外部 egress-wan、不在基準）與送達直連網段。
   * 節點：{ hop, next: [node]|null, end }；只看路由的展開（沒有 hooks）另有 info：{ lk（這一跳的轉送決定）, o（出介面分支）, no（下一跳的擁有者）, targets（下一台設備與它的節點） }；
   *   hooks 建立結束節點用 W.node(hop, null, end)；
   *   hop 由 H.newHop 建立（L4 是輸出的一跳），end 是 { status, verdict, code, dev, message, ... }。
   * hooks H（L4 在每一跳掛上 raw／nat／filter；都省略就是只看路由）：
   *   newHop(dev, inEp, st, chain)、cloneHop(hop)、checkCode(code)（結束代碼的檢查）
   *   srcKey(dev, st, ctx)、pktKey(st)：快取鍵中「來源」與「封包其他欄位」的部分（預設：有策略路由時用來源位址；0）
   *   enter(dev, base, inEp, st, depth, ctx)：進入設備之後（L4：raw prerouting、dstnat），之後呼叫 W.atDevice(..., x) 繼續（dst-nat 改寫目的後在這裡重新查路由）
   *   local(dev, base, inEp, st, ctx, x)：目的是這台設備（L4：input 與 /ip service）；預設送達（local）
   *   originate(dev, base)：設備自己送出的封包，查路由之前
   *   out(dev, hop, inEp, st, o, chain, ctx, x) → { end } 或 { st }：轉送決定之後、交給下一台之前（L4：forward／output、srcnat）
   *   beforeDeliver(dev, hop, st) → end 或 null：送達直連網段之前（L4：hairpin NAT）
   *   followOwner：目的屬於直連網段上的另一台網路設備時，進入那台設備（L4 要看它的 input）；L3 在送出的設備就算抵達
   * x：{ natState, ct }（L4 的 NAT 與連線追蹤狀態，原樣轉給 hooks）。ctx：W.context(...) 建立，含 memo、stack（目前路徑上的封包）與 ttl。
   */
  function walker(Q, hooks) {
    const H = hooks || {};
    const X = shared(Q);
    const name = (d) => Q.devName(d);
    const chk = H.checkCode || ((c) => c);
    const end = (status, verdict, code, dev, message, extra) => Object.assign({ status, verdict, code: chk(code), dev: dev || null, message }, extra);
    const newHop = H.newHop || ((dev, inEp, st, chain) => ({ dev, vrf: st.vrf, chain, in: inEp === undefined ? null : inEp, inKnown: inEp !== undefined, out: null, outKnown: true, route: null, nat: [], reasons: [], verdict: 'pass' }));
    const cloneHop = H.cloneHop || ((b) => Object.assign({}, b, { nat: b.nat.slice(), reasons: b.reasons.slice() }));
    const srcKey = H.srcKey || ((dev, st) => (st.src != null && Q.policyOf(dev).any ? st.src : 'n'));
    const pktKey = H.pktKey || (() => 0);
    const X0 = Object.freeze({ natState: null, ct: 'new' });
    // 節點的形狀固定（同一個 walker 的節點欄位相同，摘要逐一讀取時不會變慢）：只看路由的展開另有 info（L3 路由追蹤組輸出用），
    // 掛上 hooks 的展開（L4）不保留，1000 台的矩陣不多佔記憶體
    const keep = !hooks;
    const mk = keep ? (hop, next, e, info) => ({ hop, next, end: e, info: info || null }) : (hop, next, e) => ({ hop, next, end: e });
    const stop = (hop, e) => [mk(hop, null, e, null)];
    // 未收集的設備：沒有它的路由表，目的是它自己或在它已知的直連網段時路由層算抵達（L3 的「抵達」），否則不明
    const endRoute = new WeakMap();
    const uncollectedRoute = (dev, st) => (X.ownerDev(st.dst, st.vrf) === dev || X.look(dev, st.dst, st.vrf).kind === 'connected' ? 'reached' : 'unknown');
    /** 路徑結束的路由層結果（ROUTE_OF_END；未收集的設備依 uncollectedRoute）；不是路由決定的結束時 null。 */
    const routeOfEnd = (e) => (endRoute.has(e) ? endRoute.get(e) : Object.prototype.hasOwnProperty.call(ROUTE_OF_END, e.code) ? ROUTE_OF_END[e.code] : null);
    // 每次查詢一份（L4 的矩陣每次判斷都建一個，不多建用不到的 Map）：memo 可以由呼叫端給（跨查詢共用），stack 是目前路徑上的封包
    const context = (extra) => { const c = Object.assign({ stack: [], ttl: TTL }, extra); if (!c.memo) c.memo = new Map(); return c; };

    /** 封包從 inEp（undefined＝不明）進入 dev。 */
    // 快取分層（設備 → VRF → 入介面 → 來源 → 目的 → 封包其他欄位），避免每次組長字串；計算中的鍵存 BUSY
    function arrive(dev, inEp, st0, depth, ctx) {
      // 封包進入的介面決定它在哪個 VRF（RouterOS：依入介面所屬的 VRF 查路由表）；入介面不明時沿用上一跳交給它的 VRF
      const ie = realEp(inEp) && Q.getInterface(inEp);
      const st = ie && K.vrf(ie.vrf) !== st0.vrf ? Object.assign({}, st0, { vrf: K.vrf(ie.vrf) }) : st0;
      const sk = srcKey(dev, st, ctx);
      const leaf = level(level(level(level(ctx.memo, dev), st.vrf), inEp === undefined ? '' : inEp), sk);
      const nk = cellKey(X.intOf(st.dst), pktKey(st));
      const hit = leaf.get(nk);
      if (hit && hit !== BUSY) return hit;
      // 同樣的封包（入介面以外都相同；有策略路由的設備另看入介面）回到這條路徑上已經經過的設備：路由迴圈（L3 與 L4 同一個判斷）。
      // 路徑最多 ttl 跳，逐一比對比組字串鍵便宜
      const pol = Q.policyOf(dev).any; const stack = ctx.stack;
      let loop = hit === BUSY;
      for (let i = 0; !loop && i < stack.length; i++) { const f = stack[i]; loop = f.dev === dev && f.vrf === st.vrf && f.sk === sk && f.nk === nk && (!pol || f.inEp === inEp); }
      if (loop) {
        const hop = newHop(dev, inEp, st, null); hop.verdict = 'deny';
        return stop(hop, end('loop', 'deny', 'loop', dev, `回到 ${name(dev)}（同樣的封包），路由迴圈，封包到不了`));
      }
      leaf.set(nk, BUSY); stack.push({ dev, vrf: st.vrf, sk, nk, inEp });
      const out = enter(dev, inEp, st, depth, ctx);
      stack.pop(); leaf.set(nk, out);
      return out;
    }
    function enter(dev, inEp, st, depth, ctx) {
      const base = newHop(dev, inEp, st, null);
      if (depth >= ctx.ttl) { base.verdict = 'unknown'; return stop(base, end('ttl', 'unknown', 'ttl', dev, `超過 ${ctx.ttl} 跳，TTL 用盡`)); }
      if (!X.devInfo(dev).collected) {
        base.verdict = 'unknown';
        const e = end('unknown', 'unknown', 'device-uncollected', dev, `${name(dev)} 沒有收集，不知道它的路由與防火牆`);
        endRoute.set(e, uncollectedRoute(dev, st));
        return stop(base, e);
      }
      return H.enter ? H.enter(dev, base, inEp, st, depth, ctx) : atDevice(dev, base, inEp, st, depth, ctx, X0);
    }
    /** 進入設備的處理（L4：raw、dstnat）之後：目的是這台設備自己（在封包所在的 VRF）→ local；否則轉送。 */
    function atDevice(dev, base, inEp, st, depth, ctx, x) {
      if (X.ownerDev(st.dst, st.vrf) === dev) {
        base.chain = 'input';
        return H.local ? H.local(dev, base, inEp, st, ctx, x) : stop(base, end('delivered', 'allow', 'local', dev, `目的 ${st.dst} 是 ${name(dev)} 自己的位址`, { vrf: st.vrf }));
      }
      return route(dev, base, inEp, st, 'forward', depth, ctx, x);
    }
    /** 設備自己送出的封包（來源是設備的位址）：output。 */
    function originate(dev, st, ctx) {
      const base = newHop(dev, null, st, 'output');
      if (H.originate) H.originate(dev, base);
      if (X.ownerDev(st.dst, st.vrf) === dev) return stop(base, end('delivered', 'allow', 'local', dev, `來源與目的都是 ${name(dev)} 自己的位址`, { vrf: st.vrf }));
      return route(dev, base, null, st, 'output', 0, ctx, X0);
    }
    /** 轉送決定：依出介面分支（ECMP 時多個節點），每個分支經 H.out 之後交給下一台。 */
    function route(dev, base, inEp, cur, chain, depth, ctx, x) {
      base.chain = chain;
      const lk = X.decide(dev, cur, inEp);
      const one = (e) => [mk(base, null, e, { lk, o: null, no: null, targets: null })];
      if (lk.kind === 'policy-unknown') {
        base.verdict = 'unknown';
        return one(end('unknown', 'unknown', 'policy-routing', dev, `${name(dev)} 的策略路由：${lk.note}，查哪一張路由表無法判斷`, { rules: lk.rules || [], assumption: policyAssumption(lk.why) }));
      }
      if (lk.kind === 'policy-drop') {
        base.verdict = 'deny'; base.route = { prefix: null, proto: null, gateway: null, gatewayVrf: null, vrf: lk.vrf, via: lk.via, table: null, rule: lk.rule };
        return one(end('policy-drop', 'deny', 'policy-drop', dev, `${name(dev)} 的策略路由：${lk.note}，封包被丟棄`, { rule: lk.rule }));
      }
      // route.vrf：查路由的 VRF（閘道是 VRF 介面時是另一個 VRF，via 列出經過的 VRF）；route.gatewayVrf：解析閘道的 VRF（寫了 @<VRF> 時就是路由洩漏）
      const rv = { vrf: lk.vrf, via: lk.via, table: lk.table || lk.vrf, rule: lk.rule || null };
      const vrfMsg = lk.vrf !== K.MAIN_VRF || lk.via.length > 1 ? `（VRF ${lk.via.join(' → ')}）` : '';
      if (lk.kind === 'no-route-data') { base.verdict = 'unknown'; return one(end('unknown', 'unknown', 'no-route-data', dev, `${name(dev)} 沒有路由表資料`)); }
      if (lk.kind === 'route-data-incomplete') {
        base.verdict = 'unknown'; base.route = Object.assign({ prefix: null, proto: null, gateway: null, gatewayVrf: null }, rv);
        return one(end('unknown', 'unknown', 'route-data-incomplete', dev, `${name(dev)}${vrfMsg} 的路由表收集不完整，收到的部分沒有符合 ${cur.dst} 的路由，無法判斷`));
      }
      if (lk.kind === 'no-match') { base.verdict = 'deny'; base.route = Object.assign({ prefix: null, proto: null, gateway: null, gatewayVrf: null }, rv); return one(end('no-route', 'deny', 'no-route', dev, `${name(dev)}${vrfMsg} 沒有符合 ${cur.dst} 的路由，封包被丟棄`)); }
      if (lk.kind === 'blackhole') { base.verdict = 'deny'; base.route = Object.assign({ prefix: lk.route, proto: '黑洞路由', gateway: null, gatewayVrf: null }, rv); return one(end('blackhole', 'deny', 'blackhole', dev, `${lk.route}${vrfMsg} 是黑洞路由，封包被丟棄`)); }
      const outs = lk.kind === 'connected'
        ? [{ out: lk.conn.ep, route: Object.assign({ prefix: `${lk.conn.net}/${lk.conn.len}`, proto: 'connected', gateway: null, gatewayVrf: null }, rv), nh: null, vrf: lk.vrf }]
        : lk.nhs.map(({ r, n }) => ({ out: n.ifc ? K.ep(dev, n.ifc) : n.ip ? outEpFor(dev, n.ip, n.vrf) : undefined, route: Object.assign({ prefix: lk.route, proto: r.proto, gateway: n.ip || null, gatewayVrf: n.vrf }, rv), nh: n, vrf: n.vrf }));
      return outs.map((o) => {
        const hop = cloneHop(base); hop.out = o.out === undefined ? null : o.out; hop.outKnown = o.out !== undefined; hop.route = o.route;
        let st = cur.vrf === o.vrf ? cur : Object.assign({}, cur, { vrf: o.vrf }); // 之後（送出、交給下一台）在閘道的 VRF
        if (H.out) { const r = H.out(dev, hop, inEp, st, o, chain, ctx, x); if (r.end) return mk(hop, null, r.end, { lk, o, no: null, targets: null }); st = r.st; }
        return next(dev, hop, o, st, depth, ctx, lk);
      });
    }
    /** 「可能對外」的介面列出的弱證據（文字；種類見 S.infer 的 boundaries）。 */
    const weakText = (ep) => U.uniq(Q.boundaryOf(ep).evidence.filter((e) => e.strength === 'weak').map((e) => BOUNDARY_WEAK[e.kind] || e.kind)).join('、');
    const outEpFor = (dev, ip, vrf) => { const s = longestSubnets(Q.subnetsOf(dev, vrf), ip)[0]; return s ? s.ep : undefined; };
    /**
     * 交給下一台：沒有閘道位址就送達直連網段；閘道不屬於任何設備、目的也在基準以外時，依出介面的對外邊界（Q.boundaryOf）：
     * external 是 egress-wan（送往外部，推論），possible 是 egress-possible（只有弱證據，不明），其他是 next-hop-outside。
     */
    function next(dev, hop, o, st, depth, ctx, lk) {
      const info = (no, targets) => (keep ? { lk, o, no, targets } : null);
      if (!o.nh || !o.nh.ip) return deliver(dev, hop, st, depth, ctx, info(null, null));
      const no = nextOwner(X.RV, dev, o.nh.ip, o.nh.vrf);
      const bs = no.status === 'unknown' && !X.longestPrefix(st.dst, st.vrf) ? X.boundaryStatus(o.out) : 'internal';
      // 外部：從對外介面送出、目的不在基準的任何網段（推論：送往網際網路，之後由電信業者決定）
      if (bs === 'external') return mk(hop, null, end('delivered', 'allow', 'egress-wan', dev, `從 ${Q.epName(o.out)}（對外介面，推論）送往下一跳 ${K.inVrf(o.nh.ip, o.nh.vrf)}，目的 ${st.dst} 在基準以外，之後由電信業者決定（推論）`, { ip: st.dst, vrf: st.vrf }), info(no, null));
      if (bs === 'possible') return mk(hop, null, end('outside', 'unknown', 'egress-possible', dev, `從 ${Q.epName(o.out)} 送往下一跳 ${K.inVrf(o.nh.ip, o.nh.vrf)}，目的 ${st.dst} 在基準以外；這個介面可能對外（${weakText(o.out)}），證據不足，不判定為送往外部`, { ip: o.nh.ip, vrf: o.nh.vrf }), info(no, null));
      if (no.status === 'unknown') return mk(hop, null, end('outside', 'unknown', 'next-hop-outside', dev, `${name(dev)} 的下一跳 ${K.inVrf(o.nh.ip, o.nh.vrf)} 不在基準內，之後的路徑無法判斷`, { ip: o.nh.ip, vrf: o.nh.vrf }), info(no, null));
      if (!keep) { // L4：只要下一台的節點
        const kids = no.status === 'direct' ? arrive(no.dev, realEp(no.ep), Object.assign({}, st, { vrf: no.vrf }), depth + 1, ctx)
          : no.hits.flatMap((h) => arrive(h.dev, undefined, Object.assign({}, st, { vrf: h.vrf }), depth + 1, ctx));
        return mk(hop, kids, null);
      }
      const targets = no.status === 'direct' ? [{ dev: no.dev, vrf: no.vrf, ep: realEp(no.ep), crossVrf: no.crossVrf, chain: null }]
        : no.hits.map((h) => ({ dev: h.dev, vrf: h.vrf, ep: undefined, crossVrf: false, chain: h.chain }));
      targets.forEach((t) => { t.nodes = arrive(t.dev, t.ep, Object.assign({}, st, { vrf: t.vrf }), depth + 1, ctx); });
      return mk(hop, targets.flatMap((t) => t.nodes), null, info(no, targets));
    }
    /**
     * 目的在出介面的直連網段（封包所在的 VRF）：交給擁有目的位址的網路設備（H.followOwner 時再進入它），或送達主機。
     * 擁有者依 Q.hopOwner：同名 VRF 優先，否則是同一個網段上其他 VRF 的唯一擁有者（推論）。
     */
    function deliver(dev, hop, st, depth, ctx, info) {
      if (H.beforeDeliver) { const e = H.beforeDeliver(dev, hop, st); if (e) return mk(hop, null, e, info); }
      const own = Q.hopOwner(dev, st.dst, st.vrf); const d2 = own ? own.dev : null;
      if (d2 && d2 !== dev && X.netDev(d2)) {
        if (!X.devInfo(d2).collected) return mk(hop, null, end('unknown', 'unknown', 'dst-device-uncollected', d2, `目的 ${st.dst} 屬於沒有收集的 ${name(d2)}，它自己的防火牆不明`, { ip: st.dst, vrf: own.vrf }), info);
        if (H.followOwner) return mk(hop, arrive(d2, realEp(own.key), Object.assign({}, st, { vrf: own.vrf }), depth + 1, ctx), null, info);
      }
      return mk(hop, null, end('delivered', 'allow', d2 ? 'host' : 'segment', dev, `送達 ${st.dst}（${d2 ? `${name(d2)}，主機本身的防火牆不在範圍內` : '直連網段上的主機'}${st.vrf !== K.MAIN_VRF ? `，VRF ${st.vrf}` : ''}）`, { ip: st.dst, vrf: st.vrf }), info);
    }
    /** 一次查詢的起點節點。回傳 { start, nodes, end（nodes 為空時的結束原因）, loc }；entry 是封包進入的介面（L4 的外部來源）。 */
    function begin(src, dst, st, ctx, entry) {
      if (entry) return { start: { how: 'entry', dev: X.devOfEp(entry), ep: entry, gateways: [] }, nodes: arrive(X.devOfEp(entry), entry, st, 0, ctx) };
      const loc = X.srcLocation(src, st.vrf);
      if (loc.how === 'device') {
        if (!X.devInfo(loc.dev).collected) {
          const e = end('unknown', 'unknown', 'src-device-uncollected', loc.dev, `來源 ${src} 屬於沒有收集的 ${name(loc.dev)}，不知道它的路由與防火牆`);
          endRoute.set(e, uncollectedRoute(loc.dev, st));
          return { start: { how: 'device', dev: loc.dev, ep: loc.ep, gateways: [] }, nodes: [], end: e, loc };
        }
        return { start: { how: 'device', dev: loc.dev, ep: loc.ep, gateways: [] }, nodes: originate(loc.dev, st, ctx), loc };
      }
      if (loc.how === 'none') return { start: { how: 'none', dev: null, ep: null, gateways: [] }, nodes: [], end: end('unknown', 'unknown', 'src-location-unknown', null, `找不到包含 ${src} 的網段，不知道封包從哪台設備進入（可指定封包進入的介面）`), loc };
      const start = { how: 'gateway', prefix: loc.prefix, basis: loc.basis, dev: loc.gateways.length === 1 ? loc.gateways[0].dev : null, ep: loc.gateways.length === 1 ? loc.gateways[0].ep || null : null,
        gateways: loc.gateways.map((g) => ({ dev: g.dev, ep: g.ep || null, gateway: g.gateway })) };
      if (((X.intOf(dst) & loc.mask) >>> 0) === loc.netN) { // 同一個網段：不經過路由器（同 IP.inNet(dst, loc.net, loc.len)）
        const own = Q.ipOwner(dst, st.vrf); const d2 = own ? X.devOfEp(own) : null;
        start.how = 'same-subnet'; start.dev = null; start.ep = null; start.gateways = [];
        if (d2 && X.netDev(d2)) {
          if (!X.devInfo(d2).collected) return { start, nodes: [], end: end('unknown', 'unknown', 'dst-device-uncollected', d2, `目的 ${dst} 屬於沒有收集的 ${name(d2)}，它自己的防火牆不明`, { ip: dst }), loc };
          return { start, nodes: arrive(d2, realEp(own), st, 0, ctx), loc };
        }
        return { start, nodes: [], end: end('delivered', 'allow', 'same-subnet', null, `來源與目的在同一個網段 ${loc.prefix}，不經過路由器（bridge filter 與主機防火牆不在範圍內）`, { vrf: st.vrf }), loc };
      }
      if (!loc.gateways.length) return { start, nodes: [], end: end('unknown', 'unknown', 'no-gateway', null, `網段 ${loc.prefix} 上沒有可當閘道的已收集設備`), loc };
      return { start, nodes: loc.gateways.flatMap((g) => arrive(g.dev, g.ep, st, 0, ctx)), loc };
    }
    return { arrive, atDevice, originate, route, begin, context, routeOfEnd, uncollectedRoute, node: mk, X };
  }
  /** 只看路由的展開（沒有 hooks），每個 Q 一份；L3 路由追蹤與 L4 的路由層結果共用同一份快取。 */
  const routeWalkers = new WeakMap();
  const routeWalker = (Q) => U.getOr(routeWalkers, Q, () => walker(Q, null));
  /**
   * 只看路由的結果：封包（{ src, dst, vrf }）從 inEp 進入 dev 之後，路由層的結果 [{ status, code, dev, message }]（每個不同的結束一筆，依出現順序）。
   * L4 在防火牆擋下的那一跳用它判斷「路由本身會不會到」（先路由、再防火牆）。
   */
  const routeOnlyMemo = new WeakMap();
  function routeFrom(Q, dev, inEp, st) {
    const W = routeWalker(Q);
    let ctxs = routeOnlyMemo.get(Q); if (!ctxs) { ctxs = W.context(); routeOnlyMemo.set(Q, ctxs); }
    const nodes = W.arrive(dev, inEp, { src: st.src, dst: st.dst, vrf: st.vrf, proto: null, port: null }, 0, ctxs);
    return routeLeaves(W, nodes);
  }
  const leafMemo = new WeakMap();
  /** 節點（陣列）之下每個結束的路由層結果，依出現順序、不重複（status＋code＋dev）。 */
  function routeLeaves(W, nodes) {
    if (leafMemo.has(nodes)) return leafMemo.get(nodes);
    const out = []; const seen = new Set();
    const walk = (n) => {
      if (n.end) { const s = W.routeOfEnd(n.end); const k = s + '|' + n.end.code + '|' + n.end.dev; if (!seen.has(k)) { seen.add(k); out.push({ status: s, code: n.end.code, dev: n.end.dev, message: n.end.message }); } return; }
      (n.next || []).forEach(walk);
    };
    nodes.forEach(walk);
    leafMemo.set(nodes, out);
    return out;
  }

  /**
   * 路由追蹤。opt：{ ttl（選用，正整數；預設 TTL）, vrf（選用；省略時依來源位址決定，見 pickVrf） }。
   * 與 L4 共用同一份路徑展開（walker）：起點、逐跳、目的是設備本身、未收集的設備、送往外部、ECMP、迴圈與 TTL 的判斷相同，只是不看防火牆。
   *   - 起點：來源是網路設備的位址 → 那台設備；否則來源所在網段的閘道（srcLocation 的依據；同一個依據有多台時每一台都是起點，starts 列出全部，start 是第一台）
   *   - 走到未收集的設備（起點、中途或終點）時以 ends[].status 'unverified' 停下：沒有它的路由表，不能判斷是否抵達，不算斷掉
   *     （目的是它自己或在它已知的直連網段時算抵達）；路由表收集不完整（Q.routesIncomplete）的設備查不到符合的路由時也以 'unverified' 停下，
   *     另有 reason 'route-data-incomplete'
   *   - 經對外介面（Q.boundaryOf 的 status external）送往不在基準內的下一跳、目的也不在基準的網段：ends[].status 'egress'（送往外部，推論）；
   *     出介面只是可能對外（possible）時仍是 'unknown-nh'，另有 reason 'egress-possible'，note 寫出證據
   * status：'reached'（至少一個分支抵達）｜'external'（沒有抵達，但有分支送往外部）｜'unverified'（沒有抵達，且每個分支都停在未收集的設備）｜'unreachable'（其他）；
   * unverified 是停在未收集設備的設備鍵（去重、依出現順序）。
   * 回傳 { ok, src, dst, vrf, start, starts, startBasis, reached, status, unverified, hops: [{ dev, vrf, via, route, proto, ecmp, next: [{ ip, ifc, dev, vrf, crossVrf, status, note }] }], ends: [{ dev, vrf, status, note, path（, reason） }], edges }；
   * 位址無效或來源在多個 VRF 時 { ok: false, error（, vrfs） }。vrf 不是基準中的 VRF 時 TypeError。
   * 每一跳在它的 VRF 查路由；下一跳寫了 @<VRF>（路由洩漏）時在那個 VRF 解析閘道，下一台從擁有閘道位址的 VRF 繼續。
   */
  S.trace = function (Q, src, dst, opt) {
    const o = opt || {};
    if (o.ttl !== undefined && (!Number.isInteger(o.ttl) || o.ttl < 1)) throw new TypeError(`ttl 必須是正整數，收到 ${JSON.stringify(o.ttl)}`);
    const ttlMax = o.ttl === undefined ? TTL : o.ttl;
    if (!IP.isIp(src) || !IP.isIp(dst)) return { ok: false, error: '請輸入有效的 IPv4 位址' };
    const pv = pickVrf(Q, src, o.vrf);
    if (pv.error) return { ok: false, error: pv.error, vrfs: pv.vrfs };
    const vrf0 = pv.vrf;
    // 文字中的 VRF 在 main 時省略（與 K.inVrf、zone 名稱相同）：只用 main 的網路，文字和加入 VRF 之前相同
    const notMain = (v) => v !== K.MAIN_VRF;
    const W = routeWalker(Q); const RV = W.X.RV;
    const loc = W.X.srcLocation(src, vrf0);
    if (loc.how === 'none') return { ok: false, error: `找不到包含 ${src} 的網段${notMain(vrf0) ? `（VRF ${vrf0}）` : ''}，無法判斷起點設備` };
    let ctxs = traceCtx.get(Q); if (!ctxs) { ctxs = new Map(); traceCtx.set(Q, ctxs); }
    const ctx = U.getOr(ctxs, ttlMax, () => W.context({ ttl: ttlMax }));
    const st = { src, dst, vrf: vrf0, proto: null, port: null };
    const hops = []; const ends = []; const edges = new Set();
    const at = (d, v) => d + '\u0000' + v;
    const leakOf = (lk) => (lk.via.length > 1 ? `（經 VRF 介面從 ${lk.via.join(' → ')}）` : '');
    const connectedNote = (lk) => `目的位於直連網段 ${lk.conn.net}/${lk.conn.len}（${Q.epName(lk.conn.ep)}${notMain(lk.vrf) ? `，VRF ${lk.vrf}` : ''}）${leakOf(lk)}`;
    // 目的是這台設備自己：在直連網段時沿用直連網段的說明（與加入共用展開之前相同），否則寫出是設備自己的位址
    const localEnd = (dev, vrf, path) => {
      const lk = lookup(RV, dev, dst, vrf);
      return lk.kind === 'connected' ? { dev, vrf: lk.vrf, status: 'reached', note: connectedNote(lk), path } : { dev, vrf, status: 'reached', note: `目的 ${dst} 是 ${Q.devName(dev)} 自己的位址`, path };
    };
    const uncollectedEnd = (dev, vrf, path) => (W.uncollectedRoute(dev, Object.assign({}, st, { vrf })) === 'reached' ? localEnd(dev, vrf, path)
      : { dev, vrf, status: 'unverified', note: `${Q.devName(dev)} 未收集，無法再查它的路由表`, path });
    const queue = []; let starts;
    if (loc.how === 'device') {
      starts = [loc.dev];
      if (W.X.devInfo(loc.dev).collected) queue.push({ dev: loc.dev, vrf: vrf0, nodes: W.originate(loc.dev, st, ctx), path: [loc.dev] });
      else ends.push(uncollectedEnd(loc.dev, vrf0, [loc.dev]));
    } else if (loc.gateways.length) {
      // 同一個網段的目的也從閘道開始查（直連網段，抵達）
      starts = U.uniq(loc.gateways.map((g) => g.dev));
      loc.gateways.forEach((g) => queue.push({ dev: g.dev, vrf: vrf0, nodes: W.arrive(g.dev, g.ep, st, 0, ctx), path: [g.dev] }));
    } else {
      starts = loc.candidates.slice(); // 網段上都是未收集的設備
      starts.forEach((d) => ends.push(uncollectedEnd(d, vrf0, [d])));
    }
    // 依廣度展開（同一設備的同一個 VRF 只展開一次，ECMP 匯合時避免重複）：hops 與 ends 的順序與加入共用展開之前相同
    const expanded = new Set();
    while (queue.length) {
      const { dev, vrf, nodes, path } = queue.shift();
      if (expanded.has(at(dev, vrf))) continue;
      expanded.add(at(dev, vrf));
      const n0 = nodes[0]; const lk = n0.info && n0.info.lk;
      if (!lk) { // 還沒查路由就結束：TTL、未收集的設備、目的是設備自己
        const e = n0.end;
        if (e.code === 'ttl') ends.push({ dev, vrf, status: 'ttl', note: 'TTL 用盡' });
        else if (e.code === 'device-uncollected') ends.push(uncollectedEnd(dev, n0.hop.vrf, path));
        else ends.push(localEnd(dev, n0.hop.vrf, path));
        continue;
      }
      const lv = lk.vrf; const leakNote = leakOf(lk);
      const tableNote = lk.rule ? `（依 /routing rule 第 ${lk.rule.order} 條查路由表 ${lk.table}）` : '';
      if (lk.kind === 'policy-unknown') { ends.push({ dev, vrf, status: 'policy', note: `策略路由：${lk.note}，查哪一張路由表無法判斷`, rules: lk.rules, assumption: policyAssumption(lk.why), path }); continue; }
      if (lk.kind === 'policy-drop') { ends.push({ dev, vrf, status: 'policy-drop', note: `策略路由：${lk.note}，封包被丟棄`, rule: lk.rule, path }); continue; }
      if (lk.kind === 'connected') { ends.push({ dev, vrf: lv, status: 'reached', note: connectedNote(lk), path }); continue; }
      if (lk.kind === 'no-route-data') { ends.push({ dev, vrf, status: 'noroute', note: '這台設備沒有路由表資料', path }); continue; }
      // 路由表收集不完整：查不到不代表沒有路由，同未收集的設備以 unverified 停下（不算斷掉）
      if (lk.kind === 'route-data-incomplete') { ends.push({ dev, vrf: lv, status: 'unverified', reason: 'route-data-incomplete', note: `路由表收集不完整，收到的部分沒有符合 ${dst} 的路由，無法判斷`, path }); continue; }
      if (lk.kind === 'no-match') { ends.push({ dev, vrf: lv, status: 'noroute', note: `${lk.table && lk.table !== lv ? `路由表 ${lk.table} ` : notMain(lv) ? `VRF ${lv} ` : ''}沒有符合 ${dst} 的路由${tableNote}${leakNote}`, path }); continue; }
      if (lk.kind === 'blackhole') {
        hops.push({ dev, vrf: lv, via: lk.via, route: lk.route, proto: '黑洞路由', ecmp: false, next: [] });
        ends.push({ dev, vrf: lv, status: 'blackhole', note: `${lk.route} 是黑洞路由，封包在此被丟棄`, path }); continue;
      }
      const hop = { dev, vrf: lv, via: lk.via, table: lk.table, rule: lk.rule || null, note: tableNote || null, route: lk.route, proto: lk.proto, ecmp: lk.nhs.length > 1, next: [] };
      hops.push(hop);
      nodes.forEach((nd) => {
        const n = nd.info.o.nh;
        if (!n.ip) { hop.next.push({ ip: null, ifc: n.ifc, vrf: n.vrf, status: 'connected', note: `經 ${n.ifc} 直接送出（${nd.info.o.route.proto}${n.vrf !== lv ? `，VRF ${n.vrf}` : ''}）` }); ends.push({ dev, vrf: n.vrf, status: 'reached', note: `目的在 ${n.ifc} 直連`, path }); return; }
        const leak = n.vrf !== lv ? `（在 VRF ${n.vrf} 解析閘道）` : '';
        if (nd.info.no.status === 'unknown') {
          if (nd.end.code === 'egress-wan') {
            hop.next.push({ ip: n.ip, ifc: n.ifc, vrf: n.vrf, status: 'egress', note: `下一跳不屬於任何已知設備，經對外介面送往基準以外（推論）${leak}` });
            ends.push({ dev, vrf: n.vrf, status: 'egress', note: nd.end.message, path });
          } else {
            hop.next.push({ ip: n.ip, ifc: n.ifc, vrf: n.vrf, status: 'unknown', note: `下一跳不屬於任何已知設備${leak}` });
            // 出介面可能對外（只有弱證據）：仍是下一跳不在基準內，另以 reason 標示，訊息寫出證據
            if (nd.end.code === 'egress-possible') ends.push({ dev, vrf: n.vrf, status: 'unknown-nh', reason: 'egress-possible', note: nd.end.message, path });
            else ends.push({ dev, vrf: n.vrf, status: 'unknown-nh', note: `下一跳 ${K.inVrf(n.ip, n.vrf)} 不在基準內`, path });
          }
          return;
        }
        nd.info.targets.forEach((t) => {
          const x = t.chain ? { ip: n.ip, ifc: n.ifc, crossVrf: false, note: `遞迴解析：${t.chain.join(' → ')}${leak}` }
            : (() => { const cross = t.crossVrf ? `（推論：${Q.devName(t.dev)} 的這個位址在 VRF ${t.vrf}，網段相同）` : ''; return Object.assign({ ip: n.ip, ifc: n.ifc, crossVrf: t.crossVrf }, leak || cross ? { note: leak + cross } : {}); })();
          const c0 = t.nodes[0];
          if (t.nodes.length === 1 && !c0.info && c0.end && c0.end.code === 'loop') {
            hop.next.push(Object.assign(x, { dev: t.dev, vrf: t.vrf, status: 'loop', note: '路由迴圈' }));
            ends.push({ dev: t.dev, vrf: t.vrf, status: 'loop', note: `回到 ${Q.devName(t.dev)}${notMain(t.vrf) ? `（VRF ${t.vrf}）` : ''}，路由迴圈`, path: path.concat(t.dev) });
            return;
          }
          hop.next.push(Object.assign({ dev: t.dev, vrf: t.vrf, status: 'ok' }, x));
          edges.add(dev + '>' + t.dev);
          queue.push({ dev: t.dev, vrf: t.vrf, nodes: t.nodes, path: path.concat(t.dev) });
        });
      });
    }
    const reached = ends.some((e) => e.status === 'reached');
    const unverified = U.uniq(ends.filter((e) => e.status === 'unverified').map((e) => e.dev));
    const status = reached ? 'reached' : ends.some((e) => e.status === 'egress') ? 'external' : ends.length && ends.every((e) => e.status === 'unverified') ? 'unverified' : 'unreachable';
    return { ok: true, src, dst, vrf: vrf0, start: starts[0], starts, startBasis: loc.how === 'device' ? 'device' : loc.basis, reached, status, unverified, hops, ends, edges: Array.from(edges).map((e) => e.split('>')) };
  };
  const traceCtx = new WeakMap();
  S.trace.TTL = TTL;
  S.trace.ROUTING_VIEW = ROUTING_VIEW;
  S.trace.routingOf = routingOf;
  S.trace.lookup = lookup;
  S.trace.nextOwner = nextOwner;
  S.trace.pickVrf = pickVrf;
  S.trace.routeDecision = routeDecision;
  S.trace.longestSubnets = longestSubnets;
  /** 共用的路徑展開（L4 的 S.reach 以 hooks 掛上防火牆）、只看路由的結果與路由層的結果代碼，見上方 walker／routeFrom。 */
  S.trace.walker = walker;
  S.trace.routeFrom = routeFrom;
  S.trace.routeLeaves = (Q, nodes) => routeLeaves(routeWalker(Q), nodes);
  S.trace.ROUTE_DENY = ROUTE_DENY;
  S.trace.START_BASES = START_BASES;
  /** 路由層的前提（凍結；L3 路由追蹤與 L4 共用，見上方 ASSUMPTIONS）、/routing rule 可判斷的條件、ends[].status 對應的前提。 */
  S.trace.ASSUMPTIONS = ASSUMPTIONS;
  S.trace.RULE_CONDITIONS = RULE_CONDITIONS;
  S.trace.END_STATUSES = END_STATUSES;
  S.trace.policyAssumption = policyAssumption;
  S.trace.ruleMatches = ruleMatches;
  /** 共用的小工具（S.reach 的前提文字也用）。 */
  S.trace.zhList = zhList;
})(globalThis.SSOT = globalThis.SSOT || {});
