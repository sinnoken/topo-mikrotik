/*
 * L4 可達性與 zone 矩陣（M2，查詢層，只讀 Snapshot）：S.reach.engine，由 Q.reach／Q.zones／Q.zoneMatrix／Q.zoneCell／Q.ruleImpact 呼叫。
 *  - 走法以 L3 為唯一來源（ADR-023 決策 3）：起點、逐跳、迴圈、TTL、送往外部都是 src/query/trace.js 的 S.trace.walker（與 S.trace 共用），
 *    這裡只以 hooks 在每一跳依 RouterOS 的處理順序套用 raw、nat（dst-nat 改寫目的後由 walker 重新查路由）、filter、srcnat 與 /ip service，規則語意全部用 S.infer.fw.decide。
 *  - 結果分層（決策 4）：Q.reach 的每條路徑另有 route（路由層）與 filter（防火牆層）；矩陣與暴露清單的拒絕分成路由沒到與防火牆擋下。
 *  - 結果是推論，不寫進 Snapshot（ADR-014）；同一份基準與參數一定得到相同結果，快取只在記憶體。
 *  - 無法判斷就回傳 unknown 並列出原因，不猜（見 REASON_CODES）。
 * 必須在 src/query/trace.js 之後載入（tools/core-files.js）。
 */
(function (S) {
  'use strict';
  const IP = S.ip;
  const K = S.keys;
  const U = S.util;

  // ================================================================ L4：端到端可達性、zone、zone 矩陣（M2）
  const fw = () => S.infer.fw;
  const deepFreeze = (o) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
    return o;
  };
  /** 一次查詢最多展開的路徑數（ECMP、多個閘道）；超過時其餘路徑不算，結果為 unknown（branch-limit）。 */
  const MAX_PATHS = 32;
  /** 矩陣預設的 service：常見的管理與應用埠，另加 dst-nat 規則的目的埠（見 servicesOf）。 */
  const SERVICES = deepFreeze([
    { proto: 'icmp', port: null }, { proto: 'tcp', port: 22 }, { proto: 'tcp', port: 80 }, { proto: 'tcp', port: 443 },
    { proto: 'tcp', port: 3389 }, { proto: 'tcp', port: 8291 }, { proto: 'udp', port: 53 },
    // RouterOS 自己的管理服務（/ip service 的預設埠，https://manual.mikrotik.com/docs/cli-reference/ip/service.md），配合「網路設備（管理）」的目的
    { proto: 'tcp', port: 21 }, { proto: 'tcp', port: 23 }, { proto: 'tcp', port: 8728 }, { proto: 'tcp', port: 8729 },
  ]);
  /** 矩陣的虛擬 zone（推論）：外部（基準以外、經 WAN 介面）與網路設備本身（只當目的，走 input）。 */
  const EXTERNAL_ZONE = 'external';
  const SELF_ZONE = 'self';
  /**
   * 外部的代表位址：文件保留位址（S.ip 的 documentation 類：RFC 5737 的 TEST-NET-1／2／3、RFC 3849 的 2001:db8::/32），
   * IPv4 取每段的 .10、IPv6 取 <前綴>::10 與 <前綴>:ffff::10；用的時候取第一個不在基準網段內的（externalRep），只代表與它同一個規則位址區段的公網位址。
   */
  const DOC_NETS = IP.rangesOf(['documentation']);
  const EXTERNAL_CANDIDATES = Object.freeze(DOC_NETS.filter((c) => IP.isIp(c.split('/')[0])).map((c) => IP.fromInt(IP.toInt(c.split('/')[0]) + 10)));
  const EXTERNAL6_CANDIDATES = Object.freeze(DOC_NETS.filter((c) => !IP.isIp(c.split('/')[0])).flatMap((c) => { const base = c.split('/')[0].replace(/::$/, ''); return [base + '::10', base + ':ffff::10']; }));
  const svcId = (s) => s.proto + (s.port != null ? '/' + s.port : '');
  /** zone 的來源，依優先順序（同一個網段取第一個有結果的來源）。 */
  const ZONE_SOURCES = Object.freeze(['profile', 'interface-list', 'vlan', 'subnet']);
  /**
   * 可達性的前提（每次 Q.reach 都附上，畫面照列）。
   * 句子以中文敘述；RouterOS 的原值（參數、表、選單）放在括號內，可對回手冊與設定（tests/core/reach.js 檢查）。
   */
  const ASSUMPTIONS = deepFreeze([
    { code: 'new-connection', message: '判斷的是新建立的連線（connection-state=new）；回程由連線追蹤放行，不另外判斷' },
    { code: 'routeros-tables', message: '只套用 RouterOS 防火牆的原始表、位址轉換與過濾（raw、nat、filter）；封包標記與策略路由（mangle）、橋接過濾（bridge filter）、主機與服務本身的防火牆不在範圍內' },
    { code: 'ipv4-vrf', message: '只算 IPv4（RouterOS 7）；封包依入介面所屬的 VRF 查那個 VRF 的路由表，閘道指定了其他 VRF（@<VRF>）時在那個 VRF 解析（路由洩漏）' },
    { code: 'policy-routing', message: '策略路由：main 路由表的封包依路由規則（/routing rule）的順序決定查哪一張路由表，可判斷的條件是來源位址、目的位址與入介面（src-address、dst-address、interface）；有封包標記規則設定路由標記（mangle 的 mark-routing）、改過路由設定的策略規則（/routing settings 的 policy-rules），或條件無法判斷時，結果為不明，不假設查 main' },
    { code: 'src-port', message: '來源埠由用戶端自選，比對來源埠（src-port）的條件無法判斷' },
    { code: 'untracked', message: '原始表規則不追蹤連線（raw 的 notrack）時，這台設備之後的規則以連線狀態「不追蹤」（connection-state=untracked）比對，也不套用位址轉換（nat）；是否不追蹤無法判斷時，兩種情況都算，結果不同就是不明' },
    { code: 'ip-service', message: '目的是網路設備本身時，除了輸入規則（input），也看設備的管理服務（/ip service）：服務停用或來源不在允許的位址內（available-from）就是拒絕；服務所在的 VRF（vrf 參數）不在模型中，封包不在 main 時結果不明' },
    { code: 'external', message: '外部是基準以外的位址（推論）：代表位址取文件保留位址（TEST-NET），從對外介面（WAN 清單的成員）進入；送往外部的封包從對外介面送出、下一跳不在基準內時就算允許，之後由電信業者決定' },
    { code: 'static-only', message: '只看匯出設定（/export）裡的靜態規則；即插即用（UPnP、NAT-PMP）、熱點（hotspot）等功能產生的動態規則與動態位址清單不在範圍內' },
    { code: 'bridge-ip-firewall', message: '同一個網段的流量視為不經過路由器的防火牆；橋接設定讓橋接流量也走防火牆（/interface bridge settings 的 use-ip-firewall）時，橋接流量也會經過過濾規則，這種情況不在範圍內' },
  ]);
  /** Q.exposure 另有的前提：附加在 ASSUMPTIONS 之後，只出現在暴露清單的結果（Q.reach 的前提不變）。 */
  const EXPOSURE_ASSUMPTIONS = deepFreeze(ASSUMPTIONS.concat([
    { code: 'exposure-source-ranges', message: '外部來源只依入口設備自己的規則切成區段（src-address、/ip service 的 available-from、/routing rule 的 src-address）；之後經過的設備依來源位址比對的規則不再切分，所以允許的外部來源（allowedFrom）可能比實際寬' },
    { code: 'wan-member-no-interface', message: '對外介面清單的成員沒有介面紀錄、只出現在位址與清單成員的設定時（/ip address、/interface list member），也當作入口，所在的 VRF 視為 main' },
  ]));
  /**
   * Q.reach 的原因代碼與結束代碼（靜態清單，S.query.reachReasonCodes() 回傳）：
   *   kind 'end'：路徑結束的代碼（paths[].end.code；結果不是允許時也會出現在 reasons，拒絕時出現在決定結果的 route）
   *   kind 'reason'：只出現在 reasons／notes／hops[].reasons 的代碼
   *   layer：屬於哪一層（ADR-023 決策 4）——route（路由：起點、轉送決定、迴圈、送達）、filter（防火牆與 /ip service）、nat（位址轉換）、
   *     assumption（依推論的假設：送往外部之後由電信業者決定、回程是否放行）
   * 新增代碼時一定要加在這裡（reason／end 遇到不在清單的代碼會丟出錯誤，tests/core/reach.js 也會掃描本檔確認）。
   */
  const REASON_CODES = deepFreeze([
    { code: 'rule-condition', kind: 'reason', layer: 'filter', note: '規則的比對條件無法判斷（keys 列出條件）' },
    { code: 'raw-notrack', kind: 'reason', layer: 'filter', note: 'raw 規則是否 notrack 無法判斷，追蹤與不追蹤連線（untracked）的結果不同' },
    { code: 'no-firewall-data', kind: 'reason', layer: 'filter', note: '設備沒有 /export，防火牆規則不明' },
    { code: 'srcnat-ambiguous', kind: 'reason', layer: 'nat', note: 'srcnat 可能由不同的規則改寫' },
    { code: 'srcnat-address-unknown', kind: 'reason', layer: 'nat', note: 'srcnat 改寫後的來源位址不明' },
    { code: 'branches-differ', kind: 'reason', layer: 'route', note: '多條路徑（ECMP、多個閘道）結果不同' },
    { code: 'branch-limit', kind: 'reason', layer: 'route', note: '路徑超過上限，只列出前面幾條' },
    { code: 'nat-ambiguous', kind: 'end', layer: 'nat', note: 'dstnat 可能由不同的規則改寫；同時也是原因' },
    { code: 'nat-target', kind: 'end', layer: 'nat', note: 'dst-nat／redirect／netmap 改寫後的位址或埠不明；同時也是原因' },
    { code: 'loop', kind: 'end', layer: 'route', note: '路由迴圈（拒絕）' },
    { code: 'ttl', kind: 'end', layer: 'route', note: 'TTL 用盡（不明）' },
    { code: 'device-uncollected', kind: 'end', layer: 'route', note: '路徑上的設備沒有收集（不明）' },
    { code: 'dropped', kind: 'end', layer: 'filter', note: '被規則丟棄（拒絕）' },
    { code: 'local', kind: 'end', layer: 'route', note: '目的是設備自己的位址（送達）' },
    { code: 'no-route-data', kind: 'end', layer: 'route', note: '設備沒有路由表資料（不明）' },
    { code: 'no-route', kind: 'end', layer: 'route', note: '沒有符合的路由（拒絕）' },
    { code: 'blackhole', kind: 'end', layer: 'route', note: '黑洞路由（拒絕）' },
    { code: 'next-hop-outside', kind: 'end', layer: 'route', note: '下一跳不在基準內（不明）' },
    { code: 'dst-device-uncollected', kind: 'end', layer: 'filter', note: '目的位址屬於沒有收集的設備（不明）' },
    { code: 'host', kind: 'end', layer: 'route', note: '送達主機（主機防火牆不在範圍內）' },
    { code: 'segment', kind: 'end', layer: 'route', note: '送達直連網段上的主機' },
    { code: 'src-device-uncollected', kind: 'end', layer: 'route', note: '來源位址屬於沒有收集的設備（不明）' },
    { code: 'src-location-unknown', kind: 'end', layer: 'route', note: '找不到包含來源的網段（不明）' },
    { code: 'same-subnet', kind: 'end', layer: 'route', note: '來源與目的在同一個網段（送達）' },
    { code: 'no-gateway', kind: 'end', layer: 'route', note: '來源網段沒有可當閘道的已收集設備（不明）' },
    { code: 'policy-routing', kind: 'end', layer: 'route', note: '策略路由（mangle mark-routing、改過的 policy-rules，或無法判斷的 /routing rule 條件）使查哪一張路由表不明（不明）' },
    { code: 'policy-drop', kind: 'end', layer: 'route', note: '/routing rule 的 drop 或 unreachable（拒絕）' },
    { code: 'service-refused', kind: 'end', layer: 'filter', note: '防火牆放行，但 /ip service 停用或 available-from 不含來源（拒絕）' },
    { code: 'service-unknown', kind: 'end', layer: 'filter', note: '/ip service 是否接受這個來源無法判斷（來源經 NAT 後不明，或封包不在 main VRF）（不明）' },
    { code: 'egress-wan', kind: 'end', layer: 'assumption', note: '從對外介面（對外邊界的推論，Q.boundaryOf 為 external）送往基準以外的位址，之後由電信業者決定（允許）' },
    { code: 'egress-possible', kind: 'end', layer: 'assumption', note: '下一跳與目的都在基準以外，出介面只是可能對外（只有公網位址、CGNAT 位址等弱證據，Q.boundaryOf 為 possible），不判定為送往外部（不明）' },
    { code: 'hairpin-no-srcnat', kind: 'end', layer: 'nat', note: 'dst-nat 後的目的與來源在同一個網段，但沒有 srcnat 改寫來源（hairpin NAT），回應不經過路由器（不明）' },
    { code: 'return-not-guaranteed', kind: 'reason', layer: 'assumption', note: '新連線允許，但路徑上有設備的 input／forward 沒有保證放行已建立連線的封包（Q.policyBaseline 的 returnSafe 為 false，見 F15），回程可能被丟棄；結果仍是允許' },
    { code: 'no-ipv6-firewall', kind: 'reason', layer: 'filter', note: '設備沒有 IPv6 的過濾規則（/ipv6 firewall filter），IPv6 的 input／forward 預設放行；結果是允許（暴露清單的 IPv6 列）' },
  ]);
  const REASON_CODE_SET = new Set(REASON_CODES.map((x) => x.code));
  const REASON_LAYER = new Map(REASON_CODES.map((x) => [x.code, x.layer]));
  const checkCode = (code) => { if (!REASON_CODE_SET.has(code)) throw new Error(`原因代碼 ${code} 不在 REASON_CODES（src/query/reach.js）`); return code; };
  /** 無法判斷的條件鍵 → 原因。 */
  const KEY_WHY = {
    'src-address-list': 'address-list 的內容不在基準中（export 只有名稱與靜態項目，不展開，也沒有動態項目）',
    'dst-address-list': 'address-list 的內容不在基準中（export 只有名稱與靜態項目，不展開，也沒有動態項目）',
    'in-interface': '入介面不明（下一跳經遞迴路由解析）', 'out-interface': '出介面不明（路由沒有寫出介面）',
    'in-interface-list': 'interface list 無法展開（動態、內建或未定義的清單）', 'out-interface-list': 'interface list 無法展開（動態、內建或未定義的清單）',
    'src-port': '來源埠由用戶端自選', port: '來源埠由用戶端自選',
    'connection-mark': 'mangle 的標記不在範圍內', 'packet-mark': 'mangle 的標記不在範圍內', 'routing-mark': 'mangle 的標記不在範圍內',
    'ipsec-policy': '設備有啟用中的 IPsec policy，封包是否經 IPsec 不明', 'src-address': 'NAT 後的來源位址不明',
    'dst-address-type': '位址類型不明', 'src-address-type': '位址類型不明',
  };
  const keyWhy = (k) => KEY_WHY[k] || (S.infer.fw.NONDET.has(k) ? '依流量、速率或機率比對' : '這個條件不在可判斷的範圍');

  S.reach = {
    SERVICES, ZONE_SOURCES, ASSUMPTIONS, svcId,
    /** 每份基準一個（由 S.query 第一次呼叫 L4 函式時建立）；I：{ ctxOf(dev) }（查詢層的防火牆比對環境）。 */
    engine: (Q, I) => makeEngine(Q, I),
  };

  function makeEngine(Q, I) {
    const m = Q.snapshot.model;
    const F = fw();
    const name = (d) => Q.devName(d);
    const devOfEp = (ep) => K.splitEp(ep)[0];
    // 位址的擁有者都在封包所在的 VRF 查（ADR-015）
    const ownerOf = (ip, vrf) => Q.ipOwner(ip, vrf);
    // 與路由追蹤共用的資料與快取（src/query/trace.js 的 shared）：位址的數字形式、擁有者、基準的網段與最長前綴、來源所在的位置
    const X = S.trace.walker(Q).X;
    const { intOf, ownerDev, prefixes4, srcLocation } = X;
    const longest = X.longestPrefix;
    const realEp = (ep) => (ep && !ep.endsWith('|') ? ep : undefined); // 管理 IP（「設備|」）沒有介面
    const infoMemo = new Map();
    const devInfo = (d) => U.getOr(infoMemo, d, () => {
      const x = Q.getDevice(d);
      const pol = Q.ipsecOf(d).policies;
      return { exists: !!x, collected: !!(x && x.collected), config: !!(x && x.collected && x.data.includes('config')), host: !!x && x.kind === 'host',
        ipsec: pol.some((p) => !p.disabled && !p.template) };
    });
    const netDev = (d) => { const x = devInfo(d); return x.exists && !x.host; };

    // ---- 規則的參照（輸出用，含來源行）
    const refMemo = new Map();
    const ref = (r) => (r ? U.getOr(refMemo, r.key, () => ({ key: r.key, dev: r.dev, family: r.family, table: r.table, chain: r.chain, position: r.position,
      action: r.action, comment: r.comment, src: r.src.map((x) => x.slice()) })) : null);
    // position 是 chain 內從 1 起算的序號（不是 /ip firewall … print 的編號：print 依整張表從 0 起算，插入規則會改變）
    const where = (r) => `${name(r.dev)} ${r.table} ${r.chain} chain 內第 ${r.position} 條（${r.action}）`;

    // ---- 位址等價類：規則的位址邊界把位址空間切成區段，同一區段內的位址對所有規則的位址條件結果相同（規格書 §7）
    let ruleB = null; let repB = null;
    const toNum = (x) => Number(x);
    const addRanges = (set, key, text) => {
      if (text === undefined) return;
      const p = F.parseVal(key, F.splitNeg(text).body);
      if (p.kind === 'ranges' && p.bits === 32) p.items.forEach(([a, b]) => { set.add(toNum(a)); set.add(toNum(b) + 1); });
    };
    const sortedArr = (set) => Float64Array.from(Array.from(set).sort((a, b) => a - b));
    const bounds = () => {
      if (ruleB) return;
      const rb = new Set([0]);
      m.firewallRules.forEach((r) => {
        if (r.family !== 'ip') return;
        addRanges(rb, 'src-address', r.match['src-address']); addRanges(rb, 'dst-address', r.match['dst-address']);
        addRanges(rb, 'dst-address', r.params['to-addresses']);
      });
      // /routing rule 的位址條件也切開等價類：同一個區段的位址，查哪一張表的結果相同
      (m.routingRules || []).forEach((r) => {
        addRanges(rb, 'src-address', r.match['src-address']); addRanges(rb, 'dst-address', r.match['dst-address']);
      });
      const pb = new Set(rb);
      prefixes4().forEach((p) => { pb.add(p.lo); pb.add(p.hi + 1); });
      ruleB = sortedArr(rb); repB = sortedArr(pb);
    };
    const findAtom = (arr, x) => { let lo = 0; let hi = arr.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid] <= x) lo = mid; else hi = mid - 1; } return lo; };
    const atomMemo = new Map();
    const ruleAtom = (ip) => U.getOr(atomMemo, ip, () => { bounds(); return findAtom(ruleB, IP.toInt(ip)); });

    /** 外部的代表位址（矩陣的外部 zone 與暴露清單共用）：EXTERNAL_CANDIDATES 中第一個不在 main 的基準網段、也不屬於任何設備的；都不行時 null。 */
    const externalRep = () => EXTERNAL_CANDIDATES.find((ip) => !longest(ip, K.MAIN_VRF) && !ownerOf(ip, K.MAIN_VRF)) || null;
    /**
     * 區段 [lo, hi] 的代表位址（外部來源切段用，IPv4 是數字、IPv6 是 BigInt）：依序試區段內的候選位址、區段的兩端與中點，取第一個 outside(n) 成立的；都不行時 undefined。
     */
    const repInRange = (lo, hi, cands, mid, outside) => cands.filter((n) => n >= lo && n <= hi).concat([lo, lo + (typeof lo === 'bigint' ? 1n : 1), mid, hi]).find((n) => n >= lo && n <= hi && outside(n));
    // ---- 每一關（表＋chain）的判斷：S.infer.fw.decide，依等價類快取
    const stageMemo = new Map();
    const hasRules = (ctx, table, chain) => ctx.chain('ip', table, chain).length > 0;
    // 節點的鍵：來源是網路設備的位址時用實際位址（之後的設備判斷 src-address-type=local 要用），否則用等價類
    const srcKey = (ip, vrf) => { if (ip == null) return 'n'; const d = ownerDev(ip, vrf); return d && netDev(d) ? 'o' + ip : 'a' + ruleAtom(ip); };
    // ct：這台設備的連線追蹤狀態，'new'（預設）或 'untracked'（raw 的 notrack 之後，手冊 Connection tracking）
    function stage(dev, table, chain, st, inEp, outEp, natState, skip, ct) {
      const srcLocal = st.src != null && ownerDev(st.src, st.vrf) === dev; const dstLocal = ownerDev(st.dst, st.vrf) === dev;
      const untracked = ct === 'untracked';
      // 位址只透過等價類與「是不是這台設備的」影響判斷，所以鍵用這兩者，不用實際位址
      const lv = level(level(level(level(level(level(stageMemo, skip ? skip.id : ''), dev), table), chain), inEp === undefined ? '' : inEp), outEp === undefined ? '' : outEp === null ? '-' : outEp);
      const leaf = level(lv, svcNum(st) * 32 + (untracked ? 16 : 0) + (natState ? 8 : 0) + (srcLocal ? 4 : 0) + (dstLocal ? 2 : 0));
      // 來源與目的的等價類合成一個數字：乘數是等價類的個數（bounds 之後固定），不會碰撞
      bounds(); const key = (st.src == null ? 0 : ruleAtom(st.src) + 1) * (ruleB.length + 1) + ruleAtom(st.dst);
      return U.getOr(leaf, key, () => {
        const ctx = I.ctxOf(dev);
        const pkt = {
          family: 'ip', reach: true, in: inEp, out: outEp, protocol: st.proto, dstPort: st.port, srcPort: null,
          src: st.src == null ? null : BigInt(IP.toInt(st.src)), dst: BigInt(IP.toInt(st.dst)), srcLocal, dstLocal,
          state: untracked ? 'untracked' : 'new', natState, ipsec: devInfo(dev).ipsec ? null : 'none',
        };
        const d = F.decide(ctx, 'ip', table, chain, pkt, skip ? skip.set : null);
        const pub = {
          table, chain, status: d.decided ? 'decided' : 'unknown', verdict: d.decided ? d.verdict : null, rule: d.decided ? ref(d.rule) : null, policy: d.decided && d.policy,
          via: d.decided ? d.path.map(ref) : [], hits: d.hits.map(ref),
          uncertain: d.uncertain.map((u) => ({ rule: ref(u.rule), keys: U.uniq(u.keys), verdicts: u.verdicts })),
          outcomes: d.outcomes.map((o) => ({ verdict: o.verdict, rule: ref(o.rule), policy: o.policy })),
        };
        pub.note = `${table} ${chain}：${!d.decided ? `可能 ${U.uniq(d.outcomes.map((o) => o.verdict)).join('／')}，無法判斷`
          : d.rule ? `chain 內第 ${d.rule.position} 條 ${d.rule.action}${d.rule.comment ? `（${d.rule.comment}）` : ''}` : table === 'nat' ? '沒有 NAT 規則命中' : '沒有規則決定，預設放行'}`;
        return { pub, d };
      });
    }
    const condReasons = (dev, sg) => sg.pub.uncertain.filter(() => sg.pub.status === 'unknown').map((u) => ({
      code: 'rule-condition', dev, rule: u.rule, keys: u.keys,
      message: `${where(u.rule)} 的條件 ${u.keys.join('、')} 無法判斷：${U.uniq(u.keys.map(keyWhy)).join('；')}`,
    }));
    const reason = (code, dev, message, extra) => Object.assign({ code: checkCode(code), dev: dev || null, message }, extra);

    // ---- NAT 改寫
    const single = (text) => { if (text === undefined) return undefined; const t = String(text).trim(); if (IP.isIp(t)) return t; const r = t.match(/^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$/); return r && r[1] === r[2] && IP.isIp(r[1]) ? r[1] : null; };
    const ownIps = (ep) => Q.ipsOf(ep).filter((a) => !a.hearsay && a.ip).map((a) => a);
    function applyDst(dev, inEp, r, st) {
      const tp = r.params['to-ports'];
      const port = tp === undefined ? st.port : /^\d+$/.test(String(tp).trim()) ? +tp : null;
      if (port === null) return { unknown: reason('nat-target', dev, `${where(r)} 的 to-ports（${tp}）是範圍，改寫後的埠不明`, { rule: ref(r) }) };
      let dst;
      if (r.action === 'dst-nat') {
        const to = single(r.params['to-addresses']);
        if (to === null) return { unknown: reason('nat-target', dev, `${where(r)} 的 to-addresses（${r.params['to-addresses']}）是範圍，改寫後的位址不明`, { rule: ref(r) }) };
        dst = to === undefined ? st.dst : to;
      } else if (r.action === 'redirect') {
        const own = (realEp(inEp) ? ownIps(inEp) : []).concat(Q.interfacesOf(dev).flatMap((i) => ownIps(i.key)));
        if (!own.length) return { unknown: reason('nat-target', dev, `${where(r)} 轉給設備自己，但這台設備沒有已知的位址`, { rule: ref(r) }) };
        dst = own[0].ip;
      } else if (r.action === 'netmap') {
        const p = S.ip.parseCidr(String(r.params['to-addresses'] || ''));
        if (!p) return { unknown: reason('nat-target', dev, `${where(r)} 的 to-addresses 無法解析，改寫後的位址不明`, { rule: ref(r) }) };
        const mask = IP.maskOf(p.len);
        dst = IP.fromInt(((IP.toInt(p.net) & mask) | (IP.toInt(st.dst) & ~mask)) >>> 0);
      } else return { unknown: reason('nat-target', dev, `${where(r)} 的動作 ${r.action} 不在可判斷的範圍`, { rule: ref(r) }) };
      const fmt = (ip, pt) => ip + (pt != null ? ':' + pt : '');
      return { st: Object.assign({}, st, { dst, port }), nat: { type: r.action, dir: 'dst', rule: ref(r), before: fmt(st.dst, st.port), after: fmt(dst, port) } };
    }
    function applySrc(dev, outEp, r, st, nextIp) {
      let src;
      if (r.action === 'masquerade') {
        const own = realEp(outEp) ? ownIps(outEp) : [];
        const hit = nextIp ? own.find((a) => a.len < 32 && IP.inNet(nextIp, S.ip.parseCidr(a.address).net, a.len)) : null;
        src = hit ? hit.ip : own.length ? own[0].ip : null;
      } else if (r.action === 'src-nat') src = single(r.params['to-addresses']) || null;
      else if (r.action === 'netmap') {
        const p = S.ip.parseCidr(String(r.params['to-addresses'] || ''));
        src = p && st.src ? IP.fromInt(((IP.toInt(p.net) & IP.maskOf(p.len)) | (IP.toInt(st.src) & ~IP.maskOf(p.len))) >>> 0) : null;
      } else src = null;
      const out = { st: Object.assign({}, st, { src }), nat: { type: r.action, dir: 'src', rule: ref(r), before: st.src, after: src } };
      if (src === null) out.unknown = reason('srcnat-address-unknown', dev, `${where(r)} 改寫後的來源位址不明`, { rule: ref(r) });
      return out;
    }

    // ---- 逐跳：與路由追蹤共用的路徑展開（S.trace.walker），這裡只在每一跳掛上 raw、nat、filter 與 /ip service（ADR-023 決策 3）
    //   節點：{ hop, next: [node], end }，hop 是輸出的一跳，end 是在這一跳結束的原因；一個出介面一個節點（ECMP 時同一台設備有多個節點）
    const nodeMemo = new Map();
    const end = (status, verdict, code, dev, message, extra) => Object.assign({ status, verdict, code: checkCode(code), dev: dev || null, message }, extra);
    // hop.vrf：封包在這台設備所在的 VRF（入介面的 VRF；設備自己送出時是來源位址的 VRF）
    const newHop = (dev, inEp, st, chain) => ({
      dev, name: name(dev), vrf: st.vrf, collected: devInfo(dev).collected, firewall: devInfo(dev).config ? 'export' : 'none', chain, in: inEp === undefined ? null : inEp, inKnown: inEp !== undefined,
      out: null, outKnown: true, src: st.src, dst: st.dst, proto: st.proto, port: st.port, srcOut: st.src, dstOut: st.dst, portOut: st.port,
      route: null, stages: [], nat: [], service: null, reasons: [], verdict: 'pass', conntrack: 'new',
    });
    const cloneHop = (b) => ({
      dev: b.dev, name: b.name, vrf: b.vrf, collected: b.collected, firewall: b.firewall, chain: b.chain, in: b.in, inKnown: b.inKnown, out: b.out, outKnown: b.outKnown,
      src: b.src, dst: b.dst, proto: b.proto, port: b.port, srcOut: b.srcOut, dstOut: b.dstOut, portOut: b.portOut,
      route: b.route, stages: b.stages.slice(), nat: b.nat.slice(), service: b.service, reasons: b.reasons.slice(), verdict: b.verdict, conntrack: b.conntrack,
      ...(b.returnUnsafe ? { returnUnsafe: b.returnUnsafe } : {}),
    });
    /**
     * 回程的前提（推論，Q.policyBaseline）：這一跳的 chain（input／forward）returnSafe 為 false，而且不保證的介面和這條路徑有關時，
     * 回傳 { chain, rule, interfaces }，否則 null。同一條連線之後的封包（含回程）都是 established：
     *   forward 的回程從出介面進來、同方向的後續封包從入介面進來；input 的後續封包從入介面進來（設備送出的回應走 output，不在 policyBaseline）。
     *   blockedFrom 的 interfaces 為 null（只限出介面或清單展開不了）或包含這些介面（不明的介面也算）時才算；
     *   established 被一定命中的丟棄擋下（或沒有規則決定而預設丟棄）時所有介面都算（interfaces 為 null）。
     * rule：blockedFrom 的第一條相關規則；沒有 blockedFrom 時是擋下 established 的規則（established.rule），再沒有時是 defaultAction.rule。
     */
    const ruMemo = new Map();
    // 多數設備的 input、forward 都有保證：先依設備排除，矩陣的每一跳不必組鍵
    const ruDev = new Map();
    const anyUnsafe = (dev) => U.getOr(ruDev, dev, () => { const pb = Q.policyBaseline(dev); return !!(pb && pb.some((c) => c.returnSafe === false)); });
    function returnUnsafeOf(dev, chain, inEp, outEp) {
      if (!devInfo(dev).config || (chain !== 'input' && chain !== 'forward') || !anyUnsafe(dev)) return null;
      const k = [dev, chain, inEp === undefined ? '~' : String(inEp), outEp === undefined ? '~' : String(outEp)].join('\u0000');
      return U.getOr(ruMemo, k, () => {
        const pb = Q.policyBaseline(dev); const row = pb && pb.find((c) => c.chain === chain);
        if (!row || row.returnSafe !== false) return null;
        const est = row.established;
        if (est.status === 'drop' || (est.status === 'policy' && row.defaultAction.action !== 'accept')) {
          return deepFreeze({ chain, rule: (est.status === 'drop' && est.rule) || row.defaultAction.rule, interfaces: null });
        }
        const ifs = (chain === 'forward' ? [outEp, inEp] : [inEp]).filter((x) => x !== null).map((x) => (x === undefined ? undefined : realEp(x)));
        const hits = est.blockedFrom.filter((b) => b.interfaces === null || ifs.some((x) => x === undefined || b.interfaces.includes(x)));
        if (!hits.length) return null;
        const all = hits.some((b) => b.interfaces === null) ? null : U.uniq(hits.flatMap((b) => b.interfaces)).sort(U.natural);
        return deepFreeze({ chain, rule: hits[0].rule, interfaces: all });
      });
    }
    /** 允許的路徑上回程不保證的跳（只走允許的子路徑）：[{ dev, chain, rule, interfaces }]，依出現順序、不重複。 */
    const unsafeMemo = new WeakMap();
    const unsafeOfNode = (node) => {
      if (unsafeMemo.has(node)) return unsafeMemo.get(node);
      const out = [];
      if (summary(node).verdict === 'allow') {
        if (node.hop.returnUnsafe) out.push(Object.assign({ dev: node.hop.dev }, node.hop.returnUnsafe));
        (node.next || []).forEach((k) => unsafeOfNode(k).forEach((x) => out.push(x)));
      }
      const uniq = out.filter((x, i) => out.findIndex((y) => y.dev === x.dev && y.chain === x.chain && y.rule === x.rule) === i);
      unsafeMemo.set(node, uniq);
      return uniq;
    };
    const unsafeOfSum = (sum) => { const out = []; sum.nodes.forEach((n) => unsafeOfNode(n).forEach((x) => { if (!out.some((y) => y.dev === x.dev && y.chain === x.chain && y.rule === x.rule)) out.push(x); })); return out; };
    const unsafeReason = (x) => {
      const r = x.rule ? Q.getFirewallRule(x.rule) : null;
      return reason('return-not-guaranteed', x.dev, `${name(x.dev)} 的 ${x.chain} 沒有保證放行已建立連線的封包${r ? `（${where(r)}）` : ''}${x.interfaces ? `，從 ${x.interfaces.map((ep) => Q.epName(ep)).join('、')} 進來的` : ''}：新連線允許，回程可能被丟棄（推論，見 F15）`,
        { rule: r ? ref(r) : null, chain: x.chain, interfaces: x.interfaces ? x.interfaces.slice() : null });
    };

    const protoIdx = new Map();
    const svcNum = (st) => U.getOr(protoIdx, st.proto, () => protoIdx.size) * 65536 + (st.port || 0);
    const level = (map, k) => { let x = map.get(k); if (!x) { x = new Map(); map.set(k, x); } return x; };
    const stop = (hop, e) => [{ hop, next: null, end: e }]; // 節點的形狀與 walker 的相同（{ hop, next, end }）
    /** 進入設備之後（walker 的 enter）：raw prerouting（是否 notrack 無法判斷時兩種都算）→ afterRaw。 */
    function enterHook(dev, base, inEp, st, depth, ctx) {
      const info = devInfo(dev);
      if (!info.config) {
        base.reasons.push(reason('no-firewall-data', dev, `${name(dev)} 沒有設定資料（/export），防火牆規則不明`));
        return afterRaw(dev, base, inEp, st, depth, ctx, 'new');
      }
      const ctxF = I.ctxOf(dev);
      if (!hasRules(ctxF, 'raw', 'prerouting')) return afterRaw(dev, base, inEp, st, depth, ctx, 'new');
      const sg = stage(dev, 'raw', 'prerouting', st, inEp, undefined, null, ctx.skip, 'new');
      base.stages.push(sg.pub);
      if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { base.verdict = 'deny'; return stop(base, end('dropped', 'deny', 'dropped', dev, sg.pub.note)); }
      // notrack：連線不追蹤，之後的規則以 connection-state=untracked 比對，也不做 NAT（NAT 依賴連線追蹤；手冊 Connection tracking、Packet Flow）
      if (sg.pub.status === 'decided') return afterRaw(dev, base, inEp, st, depth, ctx, sg.pub.verdict === 'notrack' ? 'untracked' : 'new');
      const vs = U.uniq(sg.d.outcomes.map((o) => o.verdict));
      const reasons = condReasons(dev, sg);
      if (!vs.includes('notrack') || vs.includes('drop')) { base.reasons.push(...reasons); return afterRaw(dev, base, inEp, st, depth, ctx, 'new'); }
      // 只差在是否 notrack：兩種狀態各算一次，結果相同就是確定的，不同就是不明（不讓其中一邊的「拒絕」蓋過另一邊）
      const tracked = afterRaw(dev, cloneHop(base), inEp, st, depth, ctx, 'new');
      const untracked = afterRaw(dev, cloneHop(base), inEp, st, depth, ctx, 'untracked');
      const vt = combine(tracked.map(summary)); const vu = combine(untracked.map(summary));
      if (vt === vu && vt !== 'unknown') return tracked;
      const why = reason('raw-notrack', dev, `${name(dev)} raw prerouting 是否不追蹤連線（notrack）無法判斷：追蹤時${V_TEXT[vt]}、不追蹤時${V_TEXT[vu]}`, { rule: (sg.pub.uncertain.find((u) => u.verdicts.includes('notrack')) || {}).rule || null });
      tracked.forEach((n) => { n.hop.reasons.push(...reasons, why); n.hop.verdict = 'unknown'; n.hop.pinned = true; sumMemo.delete(n); });
      return tracked;
    }
    const V_TEXT = { allow: '允許', deny: '拒絕', unknown: '無法判斷' };
    /** raw prerouting 之後：dstnat（不追蹤時略過；改寫目的後由 walker 重新查路由）→ 送給自己（input）或轉送（forward）。ct 是這台設備的連線追蹤狀態。 */
    function afterRaw(dev, base, inEp, st, depth, ctx, ct) {
      const info = devInfo(dev);
      let cur = st; let natState = null;
      base.conntrack = ct;
      if (info.config && ct !== 'untracked' && hasRules(I.ctxOf(dev), 'nat', 'dstnat')) {
        const sg = stage(dev, 'nat', 'dstnat', cur, inEp, undefined, null, ctx.skip, ct);
        base.stages.push(sg.pub);
        if (sg.pub.status !== 'decided') {
          base.reasons.push(...condReasons(dev, sg));
          if (sg.d.outcomes.some((o) => o.verdict !== 'none')) {
            base.verdict = 'unknown';
            base.reasons.push(reason('nat-ambiguous', dev, `${name(dev)} dstnat 可能由不同的規則改寫（${sg.d.outcomes.map((o) => (o.rule ? `chain 內第 ${o.rule.position} 條 ${o.verdict}` : '不改寫')).join('、')}），改寫後的目的不明`));
            return stop(base, end('unknown', 'unknown', 'nat-ambiguous', dev, '目的 NAT 的結果不明，之後的路徑無法判斷'));
          }
        } else if (sg.pub.verdict !== 'none') {
          const res = applyDst(dev, inEp, sg.d.rule, cur);
          if (res.unknown) { base.verdict = 'unknown'; base.reasons.push(res.unknown); return stop(base, end('unknown', 'unknown', res.unknown.code, dev, res.unknown.message)); }
          base.nat.push(res.nat); cur = res.st; natState = 'dstnat';
          base.dstOut = cur.dst; base.portOut = cur.port;
        }
      }
      return W.atDevice(dev, base, inEp, cur, depth, ctx, { natState, ct });
    }
    /** 目的是這台設備自己（在封包所在的 VRF，walker 的 local）：input，再看管理服務（/ip service）是否接受。 */
    function localHook(dev, base, inEp, cur, ctx, x) {
      const info = devInfo(dev); const natState = x.natState; const ct = x.ct;
        if (info.config) {
          const sg = stage(dev, 'filter', 'input', cur, inEp, null, natState, ctx.skip, ct);
          base.stages.push(sg.pub); base.reasons.push(...condReasons(dev, sg));
          if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { base.verdict = 'deny'; return stop(base, end('dropped', 'deny', 'dropped', dev, sg.pub.note)); }
          const ru = returnUnsafeOf(dev, 'input', inEp, null); if (ru) base.returnUnsafe = ru;
        }
      return localService(dev, base, cur);
    }
    /**
     * 送到設備自己、防火牆沒有擋：依 /ip service 判斷（https://manual.mikrotik.com/docs/cli-reference/ip/service.md）。
     * 停用的服務不監聽；available-from 不含來源時，TCP 連線可以建立，但設備隨即關閉、不提供服務（埠仍看得到）；兩者都算拒絕（end service-refused）。
     * 來源不明（NAT 後）或封包不在 main（服務的 vrf 參數預設 main，模型沒有這個參數）時不明。沒有對應的服務時維持「防火牆允許」並註明。
     */
    function localService(dev, base, cur) {
      const sv = devInfo(dev).config ? serviceOf(dev, cur) : null;
      base.service = sv;
      if (sv && sv.accepts === false) {
        base.verdict = 'deny';
        return stop(base, end('refused', 'deny', 'service-refused', dev, !sv.enabled
          ? `${name(dev)} 的 ${sv.name} 服務（/ip service）已停用，沒有監聽 tcp/${sv.port}`
          : `${name(dev)} 的 ${sv.name} 服務只接受 ${sv.addresses.join('、')}（/ip service 的 available-from），來源 ${cur.src} 不在其中：連線建立後設備隨即關閉`, { service: sv.name, src: sv.src }));
      }
      if (sv && (sv.accepts === null || cur.vrf !== K.MAIN_VRF)) {
        base.verdict = 'unknown';
        return stop(base, end('unknown', 'unknown', 'service-unknown', dev, cur.vrf !== K.MAIN_VRF
          ? `${name(dev)} 的 ${sv.name} 服務所在的 VRF 不在模型中（預設 main），封包在 VRF ${cur.vrf}，是否接受無法判斷`
          : `${name(dev)} 的 ${sv.name} 服務只接受 ${sv.addresses.join('、')}，來源經 NAT 後不明，是否接受無法判斷`, { service: sv.name }));
      }
      if (base.reasons.length) base.verdict = 'unknown';
      const svText = !sv && cur.proto === 'tcp' && cur.port != null && devInfo(dev).config ? '（防火牆允許；沒有已知的管理服務（/ip service）使用這個埠）' : '';
      return stop(base, end('delivered', 'allow', 'local', dev, `目的 ${cur.dst} 是 ${name(dev)} 自己的位址${svText}`, { vrf: cur.vrf }));
    }
    /** 轉送決定之後、交給下一台之前（walker 的 out）：filter（forward／output，設備自己送出時先看 raw output）與 srcnat。 */
    function outHook(dev, hop, inEp, st0, o, chain, ctx, x) {
      const info = devInfo(dev); const ct0 = x.ct; const natState = x.natState; const cur = st0;
      let st = st0;
        let ct = ct0 === undefined ? 'new' : ct0; // 設備自己送出（originate）時沒有 raw prerouting，連線追蹤狀態是 new
        if (info.config) {
          const ctxF = I.ctxOf(dev);
          if (chain === 'output' && hasRules(ctxF, 'raw', 'output')) {
            const sg = stage(dev, 'raw', 'output', st, null, o.out, null, ctx.skip, ct);
            hop.stages.push(sg.pub); hop.reasons.push(...condReasons(dev, sg));
            if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { hop.verdict = 'deny'; return { end: end('dropped', 'deny', 'dropped', dev, sg.pub.note) }; }
            if (sg.pub.status === 'decided' && sg.pub.verdict === 'notrack') ct = 'untracked';
            else if (sg.pub.status !== 'decided' && sg.d.outcomes.some((x) => x.verdict === 'notrack')) hop.reasons.push(reason('raw-notrack', dev, `${name(dev)} raw output 是否不追蹤連線（notrack）無法判斷，之後的連線狀態不明`));
          }
          hop.conntrack = ct;
          const sg = stage(dev, 'filter', chain, st, inEp === undefined ? undefined : inEp, o.out, natState, ctx.skip, ct);
          hop.stages.push(sg.pub); hop.reasons.push(...condReasons(dev, sg));
          if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { hop.verdict = 'deny'; return { end: end('dropped', 'deny', 'dropped', dev, sg.pub.note) }; }
          if (chain === 'forward') { const ru = returnUnsafeOf(dev, 'forward', inEp, hop.outKnown ? hop.out : undefined); if (ru) hop.returnUnsafe = ru; }
          if (ct !== 'untracked' && hasRules(ctxF, 'nat', 'srcnat')) {
            const sn = stage(dev, 'nat', 'srcnat', st, inEp, o.out, natState, ctx.skip, ct);
            hop.stages.push(sn.pub); hop.reasons.push(...condReasons(dev, sn));
            if (sn.pub.status !== 'decided' && sn.d.outcomes.some((x) => x.verdict !== 'none')) {
              hop.reasons.push(reason('srcnat-ambiguous', dev, `${name(dev)} srcnat 可能由不同的規則改寫，之後的來源位址不明`));
              st = Object.assign({}, st, { src: null });
            } else if (sn.pub.status === 'decided' && sn.pub.verdict !== 'none') {
              const res = applySrc(dev, o.out, sn.d.rule, st, o.nh ? o.nh.ip || cur.dst : cur.dst);
              hop.nat.push(res.nat); st = res.st;
              if (res.unknown) hop.reasons.push(res.unknown);
            }
          }
        }
        hop.srcOut = st.src;
        if (hop.reasons.length) hop.verdict = 'unknown';
      return { st };
    }
    /** 送達直連網段之前（walker 的 beforeDeliver）：hairpin NAT。 */
    function hairpinHook(dev, hop, st) {
      if (hop.nat.some((x) => x.dir === 'dst') && !hop.nat.some((x) => x.dir === 'src') && st.src != null && st.src === hop.src) {
        const net = S.trace.longestSubnets(Q.subnetsOf(dev, st.vrf), st.dst)[0];
        if (net && IP.inNet(st.src, net.net, net.len)) {
          hop.verdict = 'unknown';
          return end('unknown', 'unknown', 'hairpin-no-srcnat', dev, `dst-nat 後的目的 ${st.dst} 與來源 ${st.src} 同在 ${net.net}/${net.len}，但沒有 srcnat 改寫來源：回應會直接送回來源、不經過 ${name(dev)}，連線通常建立不起來（需要 hairpin NAT）`, { ip: st.dst, vrf: st.vrf });
        }
      }
      return null;
    }
    function serviceOf(dev, st) {
      if (st.proto !== 'tcp' || st.port == null) return null;
      const sv = Q.ipServicesOf(dev).find((x) => x.port === st.port);
      if (!sv) return null;
      const accepts = !sv.enabled ? false : !sv.addresses.length ? true : st.src == null ? null
        : sv.addresses.some((a) => { const p = S.ip.parseCidr(a); return p ? IP.inNet(st.src, p.net, p.len) : false; });
      return { name: sv.name, enabled: sv.enabled, port: sv.port, addresses: sv.addresses.slice(), basis: sv.basis, accepts, src: sv.src.map((x) => x.slice()) };
    }

    // 節點的鍵：來源（Q.reach 用實際位址，矩陣用等價類，見 srcKey）與 service
    const W = S.trace.walker(Q, {
      newHop, cloneHop, checkCode, followOwner: true,
      srcKey: (dev, st, ctx) => (ctx.mode === 'exact' ? (st.src == null ? 'n' : st.src) : srcKey(st.src, st.vrf)),
      pktKey: svcNum,
      enter: enterHook, local: localHook, out: outHook, beforeDeliver: hairpinHook,
      originate: (dev, base) => { if (!devInfo(dev).config) base.reasons.push(reason('no-firewall-data', dev, `${name(dev)} 沒有設定資料（/export），防火牆規則不明`)); },
    });

    // ---- 摘要：每個節點的結果（allow／deny／unknown）、原因、決定的規則、牽涉的規則、最後的目的
    const sumMemo = new WeakMap();
    // 牽涉的規則（確定命中、無法判斷、決定結果的），只在 ruleImpact 需要時才算
    const invMemo = new WeakMap();
    const involvedOf = (node) => {
      if (invMemo.has(node)) return invMemo.get(node);
      const s = new Set();
      node.hop.stages.forEach((sg) => { sg.hits.forEach((r) => s.add(r.key)); sg.uncertain.forEach((u) => s.add(u.rule.key)); if (sg.rule) s.add(sg.rule.key); });
      (node.next || []).forEach((k) => involvedOf(k).forEach((x) => s.add(x)));
      invMemo.set(node, s);
      return s;
    };
    const involves = (sum, key) => sum.nodes.some((n) => involvedOf(n).has(key));
    const combine = (list) => {
      const vs = U.uniq(list.map((s) => s.verdict));
      return vs.length === 1 ? vs[0] : 'unknown';
    };
    const ruleId = (sg) => (sg.rule ? sg.rule.key : `policy:${sg.policyDev}|${sg.table}|${sg.chain}`);
    function summary(node) {
      if (sumMemo.has(node)) return sumMemo.get(node);
      const h = node.hop;
      const decisive = new Map(); const reasons = h.reasons.slice(); let nat = h.nat.some((x) => x.dir === 'dst');
      const pick = (sg) => { const id = sg.rule ? sg.rule.key : `policy:${h.dev}|${sg.table}|${sg.chain}`; decisive.set(id, { key: sg.rule ? sg.rule.key : null, dev: h.dev, table: sg.table, chain: sg.chain, policy: !sg.rule, verdict: sg.verdict }); };
      let verdict; let final = { dst: h.dstOut, port: h.portOut, vrf: (node.end && node.end.vrf) || h.vrf };
      const denyStage = h.stages.find((sg) => sg.status === 'decided' && sg.verdict === 'drop');
      if (h.verdict === 'deny' && denyStage) { pick(denyStage); verdict = 'deny'; }
      else {
        // srcnat 在 filter 之後（postrouting），只改寫來源、不決定允許或拒絕，不算決定結果的規則（逐跳的 nat 欄仍會列出）
        h.stages.forEach((sg) => { if (sg.status === 'decided' && (sg.table === 'filter' || (sg.table === 'nat' && sg.chain === 'dstnat' && sg.verdict !== 'none'))) pick(sg); });
        let v;
        if (node.end) {
          v = node.end.verdict;
          if (node.end.code !== 'local' && node.end.code !== 'host' && node.end.code !== 'segment' && node.end.code !== 'dropped' && node.end.verdict !== 'allow' && !reasons.some((x) => x.code === node.end.code)) reasons.push(reason(node.end.code, node.end.dev, node.end.message, node.end.ip ? { ip: node.end.ip } : {}));
          if (node.end.verdict === 'deny' && !denyStage) decisive.set('route:' + node.end.code + ':' + h.dev, { key: null, dev: h.dev, table: null, chain: null, policy: false, route: node.end.code, verdict: 'drop' });
        } else {
          const kids = node.next.map(summary);
          v = combine(kids);
          kids.forEach((k) => { if (k.nat) nat = true; });
          const sameFinal = kids.every((k) => k.final && kids[0].final && k.final.dst === kids[0].final.dst && k.final.port === kids[0].final.port && k.final.vrf === kids[0].final.vrf);
          final = sameFinal && kids.length ? kids[0].final : null;
          if (v === 'unknown' && U.uniq(kids.map((k) => k.verdict)).length > 1) {
            reasons.push(reason('branches-differ', h.dev, `${name(h.dev)} 之後有多條路徑（ECMP），結果不同（${U.uniq(kids.map((k) => k.verdict)).join('、')}），實際走哪一條無法判斷`));
          }
          // 決定的規則只取與結果一致的子路徑
          kids.filter((k) => k.verdict === v || v === 'unknown').forEach((k) => { k.decisive.forEach((x, id) => decisive.set(id, x)); k.reasons.forEach((x) => reasons.push(x)); });
          if (v === 'deny') { decisive.forEach((x, id) => { if (x.verdict !== 'drop') decisive.delete(id); }); }
        }
        // pinned：這一跳本身的結果不明（例如是否 notrack），之後確定的拒絕也不能決定結果
        verdict = h.verdict === 'unknown' ? (v === 'deny' && !h.pinned ? 'deny' : 'unknown') : v;
        if (verdict === 'deny') { decisive.forEach((x, id) => { if (x.verdict !== 'drop') decisive.delete(id); }); }
      }
      const s = { verdict, reasons: dedupeReasons(reasons), decisive, nodes: [node], final, nat };
      sumMemo.set(node, s);
      return s;
    }
    const dedupeReasons = (list) => { const seen = new Set(); return list.filter((r) => { const k = [r.code, r.dev, r.rule ? r.rule.key : '', r.ip || '', (r.keys || []).join(',')].join('|'); if (seen.has(k)) return false; seen.add(k); return true; }); };
    function summarize(b, st) {
      if (!b.nodes.length) {
        const e = b.end;
        return { verdict: e.verdict, reasons: e.verdict === 'unknown' ? [reason(e.code, e.dev, e.message, e.ip ? { ip: e.ip } : {})] : [], decisive: new Map(), nodes: [],
          final: { dst: st.dst, port: st.port, vrf: (e && e.vrf) || st.vrf }, nat: false };
      }
      // 只有一個起點節點時，下面的合併結果與那個節點的摘要內容相同（原因已去重、決定的規則與最後的目的照抄）：直接用它，
      // 1000 台的矩陣每次判斷少建一份摘要（記錄會保留摘要，也減少記憶體與 GC 的停頓）。摘要建立後不再修改。
      if (b.nodes.length === 1) return summary(b.nodes[0]);
      const kids = b.nodes.map(summary);
      const v = combine(kids);
      const reasons = []; const decisive = new Map(); let nat = false;
      kids.forEach((k) => { if (k.nat) nat = true; if (k.verdict === v || v === 'unknown') { k.reasons.forEach((x) => reasons.push(x)); k.decisive.forEach((x, id) => decisive.set(id, x)); } });
      if (v === 'unknown' && U.uniq(kids.map((k) => k.verdict)).length > 1) {
        reasons.unshift(reason('branches-differ', null, b.start.gateways.length > 1
          ? `來源網段 ${b.start.prefix} 有多個閘道（${b.start.gateways.map((g) => name(g.dev)).join('、')}），結果不同（${U.uniq(kids.map((k) => k.verdict)).join('、')}）；主機用哪一個閘道無法判斷`
          : `有多條路徑，結果不同（${U.uniq(kids.map((k) => k.verdict)).join('、')}），實際走哪一條無法判斷`));
      }
      const sameFinal = kids.every((k) => k.final && kids[0].final && k.final.dst === kids[0].final.dst && k.final.port === kids[0].final.port && k.final.vrf === kids[0].final.vrf);
      return { verdict: v, reasons: dedupeReasons(reasons), decisive, nodes: b.nodes, final: sameFinal ? kids[0].final : null, nat };
    }

    // ---- 結果分層：先路由、再防火牆（ADR-023 決策 4）
    const DENY_ROUTE = new Set(S.trace.ROUTE_DENY);
    const routeMemo = new WeakMap();
    /**
     * 節點之下每個結束的路由層結果 [{ status, code, dev, message }]（依出現順序、不重複）：
     *   路由決定的結束（沒有路由、黑洞、策略路由丟棄、迴圈、送達、送往外部、不明…）照 walker 的 routeOfEnd；
     *   防火牆擋下的（dropped）：從擋下的那一跳只看路由繼續走（S.trace.routeFrom，NAT 已套用的目的），路由本身到不到；
     *   目的是設備本身（input、/ip service）與 hairpin NAT：路由已經到了；目的 NAT 的結果不明：路由也不明。
     */
    function routeOfNode(node) {
      if (routeMemo.has(node)) return routeMemo.get(node);
      let out;
      const e = node.end;
      if (e) {
        const s = W.routeOfEnd(e); const h = node.hop;
        if (s !== null) out = [{ status: s, code: e.code, dev: e.dev, message: e.message }];
        else if (NAT_UNKNOWN.has(e.code)) out = [{ status: 'unknown', code: e.code, dev: e.dev, message: e.message }];
        else if (e.code === 'dropped' && h.chain !== 'input') out = S.trace.routeFrom(Q, h.dev, h.inKnown ? h.in : undefined, { src: h.src, dst: h.dstOut, vrf: h.vrf });
        else out = [{ status: 'reached', code: e.code, dev: e.dev, message: e.message }];
      } else {
        out = []; const seen = new Set();
        (node.next || []).forEach((k) => routeOfNode(k).forEach((x) => { const id = x.status + '|' + x.code + '|' + x.dev; if (!seen.has(id)) { seen.add(id); out.push(x); } }));
      }
      routeMemo.set(node, out);
      return out;
    }
    /**
     * 拒絕的判斷是路由沒到（noRoute：每個結束的路由層結果都是沒有路由、黑洞、策略路由丟棄或迴圈）還是防火牆擋下（filter）；不是拒絕時 null。
     * 節點的路由層結果有快取（routeOfNode），這裡不另外快取（矩陣有數十萬筆摘要）。
     */
    const deniedByOf = (sum) => {
      if (sum.verdict !== 'deny') return null;
      return sum.nodes.length && sum.nodes.every((n) => routeOfNode(n).every((x) => DENY_ROUTE.has(x.status))) ? 'noRoute' : 'filter';
    };
    const layerOf = (code) => (REASON_LAYER.get(code) || 'filter');
    /**
     * 一條路徑的分層結果：route（路由層）與 filter（防火牆層；路由沒到時 n/a）。v 是這條路徑原本的結論（verdict）。
     *   route：{ status: reached|no-route|blackhole|policy-drop|loop|unknown, code, reasons }——結束的路由層結果只有一種時就是它，
     *     不同時（防火牆擋下之後的 ECMP）是 unknown、code 為 branches-differ；reasons 是沒有抵達的結束
     *   filter：{ status: allow|deny|unknown|n/a, rule（擋下的規則，沒有規則決定而預設丟棄時 { key: null, policy: true }）, reasons（防火牆、NAT 與推論假設層的原因） }
     */
    function layered(v, hops, e, rl) {
      const ss = U.uniq(rl.map((x) => x.status));
      const status = ss.length === 1 ? ss[0] : 'unknown';
      const code = ss.length === 1 ? rl[0].code : 'branches-differ';
      const route = { status, code, reasons: status === 'reached' ? [] : rl.filter((x) => x.status !== 'reached').map((x) => ({ code: x.code, dev: x.dev, message: x.message })) };
      if (DENY_ROUTE.has(status)) return { route, filter: { status: 'n/a', rule: null, reasons: [] } };
      let rule = null;
      if (v === 'deny') {
        for (const h of hops) {
          const sg = h.stages.find((x) => x.status === 'decided' && x.verdict === 'drop');
          if (sg) { rule = sg.rule || { key: null, dev: h.dev, table: sg.table, chain: sg.chain, policy: true }; break; }
        }
      }
      const reasons = hops.flatMap((h) => h.reasons).filter((x) => layerOf(x.code) !== 'route');
      if (e && v !== 'allow' && layerOf(e.code) !== 'route' && e.code !== 'dropped' && !reasons.some((x) => x.code === e.code)) reasons.push({ code: e.code, dev: e.dev, message: e.message });
      return { route, filter: { status: v, rule, reasons: dedupeReasons(reasons) } };
    }

    /**
     * 展開的每一條路徑（最多 MAX_PATHS 條）與它的分層結果：Q.reach 的 paths[]，暴露清單每一列的 route／filter 也由它彙整（rowLayers）。
     * 回傳 { paths: [{ verdict, hops, end, route, filter }], truncated }。
     */
    function pathsOf(b) {
      const paths = [];
      const walk = (node, acc) => {
        if (paths.length >= MAX_PATHS) return;
        const hops = acc.concat(node.hop);
        if (node.end || !node.next || !node.next.length) { paths.push({ hops, end: node.end, node }); return; }
        node.next.forEach((k) => walk(k, hops));
      };
      b.nodes.forEach((n) => walk(n, []));
      const out = paths.map((p) => {
        const hv = p.hops.map((h) => h.verdict);
        const e = p.end;
        const v = hv.includes('deny') || (e && e.verdict === 'deny') ? 'deny' : hv.includes('unknown') || !e || e.verdict === 'unknown' ? 'unknown' : 'allow';
        return Object.assign({ verdict: v, hops: p.hops, end: e }, layered(v, p.hops, e, routeOfNode(p.node)));
      });
      if (!b.nodes.length) {
        const rs = W.routeOfEnd(b.end);
        out.push(Object.assign({ verdict: b.end.verdict, hops: [], end: b.end }, layered(b.end.verdict, [], b.end, [{ status: rs, code: b.end.code, dev: b.end.dev, message: b.end.message }])));
      }
      return { paths: out, truncated: paths.length >= MAX_PATHS };
    }
    /**
     * 一個結論（verdict，Q.reach 的 verdict）的分層結果，由它的每條路徑（pathsOf）彙整，形狀同 paths[] 的 route／filter：
     *   route：每條路徑的 route.status 只有一種時就是它（code 取第一條），不同時 unknown、code branches-differ；reasons 合併
     *   filter：路由沒到（route.status 是 no-route、blackhole、policy-drop、loop）時 n/a；否則 status 是 verdict，rule 是第一個有擋下規則的路徑的規則，reasons 合併
     */
    function rowLayers(verdict, paths) {
      const ss = U.uniq(paths.map((p) => p.route.status));
      const rStatus = ss.length === 1 ? ss[0] : 'unknown';
      const route = { status: rStatus, code: ss.length === 1 ? paths[0].route.code : 'branches-differ', reasons: dedupeReasons(paths.flatMap((p) => p.route.reasons)) };
      if (DENY_ROUTE.has(rStatus)) return { route, filter: { status: 'n/a', rule: null, reasons: [] } };
      const withRule = paths.find((p) => p.filter.rule);
      return { route, filter: { status: verdict, rule: withRule ? withRule.filter.rule : null, reasons: dedupeReasons(paths.flatMap((p) => p.filter.reasons)) } };
    }

    // ---- Q.reach
    const normProto = (p) => {
      if (p === undefined || p === null) throw new TypeError('proto 必須指定（例如 tcp、udp、icmp）');
      return S.infer.fw.protoName(String(p).trim().toLowerCase());
    };
    const normPort = (proto, port) => {
      if (!S.infer.fw.PORT_PROTOCOLS.has(proto)) { if (port != null) throw new TypeError(`${proto} 沒有埠，port 必須省略`); return null; }
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError(`${proto} 需要 port（1–65535 的整數），收到 ${JSON.stringify(port)}`);
      return port;
    };
    const reachCache = new Map();
    const skipOf = (keys) => (keys && keys.length ? { id: keys.slice().sort().join(','), set: new Set(keys) } : null);
    /** vrf：來源所在的 VRF（封包從這個 VRF 開始查路由；有 entry 時由入介面決定）。 */
    function evaluate(src, dst, svc, mode, skip, entry, vrf) {
      const ctx = W.context({ mode, skip, memo: level(nodeMemo, mode + '\u0000' + (skip ? skip.id : '')) });
      const st = { src, dst, proto: svc.proto, port: svc.port, vrf: K.vrf(vrf) };
      const b = W.begin(src, dst, st, ctx, entry);
      return { b, sum: summarize(b, st) };
    }
    function reach(src, dst, opts) {
      const o = opts || {};
      if (!IP.isIp(src) || !IP.isIp(dst)) return { ok: false, error: '請輸入有效的 IPv4 位址' };
      const proto = normProto(o.proto === undefined ? 'tcp' : o.proto); const port = normPort(proto, o.port);
      const entry = o.entry == null ? null : String(o.entry);
      // 對外入口（l4Entries）沒有介面紀錄時也可以當 entry（暴露清單的列會用到），VRF 視為入口的 VRF
      const entryIfc = entry ? Q.getInterface(entry) || l4Entries().find((w) => w.ep === entry) : null;
      if (entry && !entryIfc) throw new TypeError(`entry 必須是基準中的介面鍵（設備|介面）或對外入口，收到 ${JSON.stringify(entry)}`);
      // VRF：有 entry 時是入介面的 VRF（給了不同的 vrf 是錯誤）；否則同 S.trace（給了就用，不存在時 TypeError；沒給時依來源，重疊時請使用者指定）
      let vrf;
      if (entry) {
        vrf = K.vrf(entryIfc.vrf);
        if (o.vrf != null && K.vrf(o.vrf) !== vrf) throw new TypeError(`entry ${entry} 屬於 VRF ${vrf}，與 vrf 參數 ${JSON.stringify(String(o.vrf))} 不同`);
      } else {
        const pv = S.trace.pickVrf(Q, src, o.vrf);
        if (pv.error) return { ok: false, error: pv.error, vrfs: pv.vrfs };
        vrf = pv.vrf;
      }
      const skipKeys = o.disabledRules == null ? [] : Array.from(o.disabledRules, String);
      const ck = JSON.stringify([src, dst, proto, port, entry, skipKeys.slice().sort(), vrf]);
      if (reachCache.has(ck)) return reachCache.get(ck);
      const { b, sum } = evaluate(src, dst, { proto, port }, 'exact', skipOf(skipKeys), entry, vrf);
      const { paths: pathOut, truncated } = pathsOf(b);
      const reasons = sum.reasons.slice();
      if (truncated) reasons.push(reason('branch-limit', null, `路徑超過 ${MAX_PATHS} 條，只列出前 ${MAX_PATHS} 條`));
      const verdict = truncated && sum.verdict !== 'deny' ? 'unknown' : sum.verdict;
      // 允許的結果：路徑上回程不保證的跳附在 notes（結論仍是允許）
      if (verdict === 'allow') unsafeOfSum(sum).forEach((x) => reasons.push(unsafeReason(x)));
      const out = deepFreeze(JSON.parse(JSON.stringify({
        ok: true, src, dst, proto, port, vrf, entry, verdict,
        final: sum.final, natApplied: sum.nat, start: b.start,
        reasons: verdict === 'unknown' ? reasons : [],
        notes: verdict === 'unknown' ? [] : reasons,
        decisive: Array.from(sum.decisive.values()).map((x) => (x.key ? Object.assign({ policy: false, verdict: x.verdict }, Q.getFirewallRule(x.key) ? ref(Q.getFirewallRule(x.key)) : { key: x.key }) : x)),
        paths: pathOut, assumptions: ASSUMPTIONS,
      })));
      reachCache.set(ck, out);
      return out;
    }

    // ---- zone
    const zoneCache = new Map();
    let vlanNames = null;
    const vlanNamesOf = (id) => {
      if (!vlanNames) { vlanNames = new Map(); m.vlans.forEach((v) => { if (v.id != null && v.name) { const a = U.getOr(vlanNames, v.id, () => []); if (!a.includes(v.name)) a.push(v.name); } }); vlanNames.forEach((a) => a.sort(U.natural)); }
      return vlanNames.get(id) || [];
    };
    /** 網段所屬的 VLAN：prefixes 的 vlan；各設備不一致（A07）時取多數的介面，平手為 null。 */
    const vlanOfPrefix = (p) => {
      if (p.vlan != null) return { id: p.vlan, majority: false };
      const count = new Map();
      p.eps.forEach((ep) => { const i = Q.getInterface(ep); if (i && i.encapVlan != null) count.set(i.encapVlan, (count.get(i.encapVlan) || 0) + 1); });
      const best = Array.from(count.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      if (!best.length || (best[1] && best[1][1] === best[0][1])) return null;
      return { id: best[0][0], majority: true, all: best.map((x) => x[0]) };
    };
    function zoneOpts(opts) {
      const o = opts || {};
      let prof = null; let profHash = null;
      if (o.profile != null) {
        prof = S.profile.compile(o.profile);
        const meta = Q.meta().profile;
        if (!meta || meta.id !== prof.id || String(meta.version) !== prof.version) {
          throw new TypeError(`命名規則（${prof.id} 版本 ${prof.version}）與建立基準時的不同（${meta ? `${meta.id} 版本 ${meta.version}` : '沒有套用命名規則'}）；請用同一份命名規則重新建立基準`);
        }
        // id 與 version 相同、內容不同（例如改了 zones 段卻沒改 version）時，算出的 zone 會和這一輪的基準不一致：比對全文雜湊
        profHash = S.profile.hash(o.profile);
        if (meta.hash == null) {
          throw new TypeError(`基準沒有記錄命名規則（${prof.id} 版本 ${prof.version}）的內容雜湊（2.11.0 以前建立），無法確認是同一份命名規則；請重新建立基準`);
        }
        if (meta.hash !== profHash) {
          throw new TypeError(`命名規則（${prof.id} 版本 ${prof.version}）的內容與建立基準時的不同（id 與 version 相同，但內容雜湊不一致，例如改了 zones 段卻沒改 version）；請用同一份命名規則重新建立基準，或修改命名規則時一併提高 version`);
        }
      }
      const sources = o.sources == null ? ZONE_SOURCES.slice() : Array.from(o.sources, String);
      sources.forEach((s) => { if (!ZONE_SOURCES.includes(s)) throw new TypeError(`sources 只能包含 ${ZONE_SOURCES.join('、')}，收到 ${JSON.stringify(s)}`); });
      if (!sources.includes('subnet')) sources.push('subnet'); // 最後一定以網段本身當 zone，每個網段都有 zone
      return { prof, profHash, sources: ZONE_SOURCES.filter((s) => sources.includes(s)) };
    }
    function zones(opts) {
      const zo = zoneOpts(opts);
      const ck = JSON.stringify([zo.profHash, zo.sources]);
      if (zoneCache.has(ck)) return zoneCache.get(ck);
      const zmap = new Map(); const subnets = [];
      const zoneOfDef = (id, nm, source, inferred, basis) => U.getOr(zmap, id, () => ({ id, name: nm, source, inferred, basis, subnets: [], devices: new Set() }));
      // zone 依 VRF 分開（ADR-015）：非 main 的 VRF，zone 的 id 加上 @<VRF>（K.inVrf），名稱加上（VRF …）；main 的 id 與名稱和加入 VRF 之前相同
      prefixes4().forEach((x) => {
        const p = x.p; const cands = []; const vrf = x.vrf;
        const push = (c) => cands.push(Object.assign(c, { id: K.inVrf(c.id, vrf), name: vrf === K.MAIN_VRF ? c.name : `${c.name}（VRF ${vrf}）` }));
        const ownEps = p.eps.filter((ep) => devInfo(devOfEp(ep)).collected);
        const vl = vlanOfPrefix(p);
        if (zo.sources.includes('profile') && zo.prof && zo.prof.zoneOf) {
          const hit = zo.prof.zoneOf({
            subnet: p.prefix, vlans: vl ? [{ id: vl.id, names: vlanNamesOf(vl.id) }] : [],
            interfaces: ownEps.map((ep) => { const i = Q.getInterface(ep); return { name: i ? i.name : K.splitEp(ep)[1], desc: i ? i.desc : null }; }),
          });
          if (hit) push({ source: 'profile', id: 'tag:' + hit.zone, name: hit.zone, inferred: false, basis: `命名規則 ${zo.prof.id} 的 zones[${hit.rule}]（${hit.on} 符合 ${hit.match}）`, detail: { rule: hit.rule } });
        }
        if (zo.sources.includes('interface-list')) {
          const lists = [];
          ownEps.forEach((ep) => {
            const d = devOfEp(ep); if (!devInfo(d).config) return;
            const ctx = I.ctxOf(d);
            Q.interfaceListsOf(d).forEach((l) => {
              if (!l.defined) return;
              const set = ctx.resolve(l.name);
              if (set && set.has(ep)) lists.push({ name: l.name, dev: d, ep, size: set.size, src: l.src.map((s) => s.slice()) });
            });
          });
          lists.sort((a, b) => a.size - b.size || U.natural(a.name, b.name) || U.natural(a.dev, b.dev));
          if (lists.length) {
            const names = U.uniq(lists.map((l) => l.name));
            push({ source: 'interface-list', id: 'list:' + lists[0].name, name: lists[0].name, inferred: true,
              basis: `${Q.epName(lists[0].ep)} 是 interface list ${lists[0].name} 的成員（事實），以清單當 zone（推論）${names.length > 1 ? `；也屬於 ${names.slice(1).join('、')}，取成員最少的清單` : ''}`,
              detail: { lists: lists.map((l) => ({ name: l.name, dev: l.dev, ep: l.ep, members: l.size, src: l.src })) } });
          }
        }
        if (zo.sources.includes('vlan') && vl) {
          const names = vlanNamesOf(vl.id);
          push({ source: 'vlan', id: 'vlan:' + vl.id, name: names.length ? `VLAN ${vl.id}（${names.join('／')}）` : `VLAN ${vl.id}`, inferred: true,
            basis: vl.majority ? `網段設在 VLAN ${vl.all.join('、')} 的介面上（各設備不一致，見 A07），取多數的 VLAN ${vl.id}（推論）` : `網段設在 VLAN ${vl.id} 的介面上（推論：同一個 VLAN ID 視為同一個 zone）`,
            detail: { vlan: vl.id } });
        }
        push({ source: 'subnet', id: 'subnet:' + p.prefix, name: p.prefix, inferred: true, basis: '沒有其他來源，以網段本身當 zone（推論）', detail: {} });
        const pickC = zo.sources.map((s) => cands.find((c) => c.source === s)).find(Boolean);
        const z = zoneOfDef(pickC.id, pickC.name, pickC.source, pickC.inferred, pickC.source === 'subnet' ? pickC.basis : null);
        z.vrf = vrf; z.subnets.push(x.key); p.eps.forEach((ep) => z.devices.add(devOfEp(ep)));
        subnets.push({ prefix: p.prefix, key: x.key, net: p.net, len: p.len, vrf, zone: pickC.id, source: pickC.source, inferred: pickC.inferred, basis: pickC.basis, detail: pickC.detail,
          alternatives: cands.filter((c) => c !== pickC && zo.sources.includes(c.source)).map((c) => ({ zone: c.id, source: c.source })), eps: p.eps.slice() });
      });
      const order = (z) => ZONE_SOURCES.indexOf(z.source);
      const list = Array.from(zmap.values()).map((z) => ({
        id: z.id, name: z.name, source: z.source, inferred: z.inferred,
        basis: z.basis || { profile: '命名規則的 zones 標籤（註解，不改寫事實）', 'interface-list': 'interface list（防火牆的 zone）', vlan: 'VLAN ID' }[z.source],
        subnets: z.subnets.slice().sort(U.natural), devices: Array.from(z.devices).sort(U.natural), vrf: z.vrf,
      })).sort((a, b) => order(a) - order(b) || U.natural(a.name, b.name) || U.cmp(a.id, b.id));
      const bySubnet = new Map(subnets.map((s) => [s.key, s]));
      const out = { zones: deepFreeze(list), subnets: deepFreeze(subnets), bySubnet, byId: new Map(list.map((z) => [z.id, z])), opts: zo };
      zoneCache.set(ck, out);
      return out;
    }
    /**
     * IP 所屬的 zone（那個 VRF 最長相符的直連網段）。vrf 省略時用 opts.vrf；都沒有時依位址決定（同 S.trace，位址在多個 VRF 時 TypeError，請指定 vrf）。
     * 回傳 { zone, subnet（網段文字）, key（網段鍵）, vrf, source, inferred }；不在任何網段時為 null。
     */
    function zoneOf(ip, opts, vrf) {
      if (!IP.isIp(ip)) return null;
      let v = vrf !== undefined ? K.vrf(vrf) : null;
      if (v === null) {
        const pv = S.trace.pickVrf(Q, ip, opts && opts.vrf);
        if (pv.error) throw new TypeError(pv.error);
        v = pv.vrf;
      }
      const zs = zones(opts); const x = longest(ip, v);
      if (!x) return null;
      const s = zs.bySubnet.get(x.key);
      return { zone: s.zone, subnet: s.prefix, key: s.key, vrf: v, source: s.source, inferred: s.inferred };
    }

    // ---- zone 矩陣：每個 zone 的代表位址（等價類）× 目的（代表位址＋dst-nat 的入口）× service
    function repsOf(zs) {
      bounds();
      // ARP 的位址依 VRF 分開（代表位址只取同一個 VRF 的 ARP）
      const arpBy = new Map();
      m.arps.forEach((a) => { if (IP.isIp(a.ip)) U.getOr(arpBy, K.vrf(a.vrf), () => new Set()).add(IP.toInt(a.ip)); });
      const arpSorted = new Map(Array.from(arpBy, ([v, set]) => [v, Array.from(set).sort((a, b) => a - b)]));
      const out = new Map(); // zone → [rep]
      prefixes4().forEach((x) => {
        const s = zs.bySubnet.get(x.key);
        const arpIps = arpSorted.get(x.vrf) || [];
        const lo0 = x.len >= 31 ? x.lo : x.lo + 1; const hi0 = x.len >= 31 ? x.hi : x.hi - 1;
        let i = findAtom(repB, x.lo);
        while (i < repB.length && repB[i] <= x.hi) {
          const a = Math.max(repB[i], x.lo); const b = Math.min(i + 1 < repB.length ? repB[i + 1] - 1 : 0xffffffff, x.hi); i++;
          if (longest(IP.fromInt(a), x.vrf).key !== x.key) continue; // 屬於更長的網段
          const lo = Math.max(a, lo0); const hi = Math.min(b, hi0); if (lo > hi) continue;
          const free = (n) => { const o = ownerOf(IP.fromInt(n), x.vrf); return !o || !netDev(devOfEp(o)); };
          let rep = null; let basis = 'arp';
          let k = findAtom(Float64Array.from(arpIps.length ? arpIps : [0]), lo);
          for (; k < arpIps.length && arpIps[k] <= hi; k++) if (arpIps[k] >= lo && free(arpIps[k])) { rep = arpIps[k]; break; }
          if (rep === null) { basis = 'synthetic'; for (let n = lo, c = 0; n <= hi && c < 4096; n++, c++) if (free(n)) { rep = n; break; } }
          if (rep === null) continue;
          const ip = IP.fromInt(rep);
          // 同一個區段的第二個位址：zone 內（對角線）同網段的組合用它當目的
          let peer = null; for (let n = lo, c = 0; n <= hi && c < 4096; n++, c++) if (n !== rep && free(n)) { peer = IP.fromInt(n); break; }
          U.getOr(out, s.zone, () => []).push({ ip, vrf: x.vrf, zone: s.zone, subnet: x.key, range: [IP.fromInt(a), IP.fromInt(b)], basis, via: 'member', dev: null, peer });
        }
      });
      out.forEach((list) => list.sort((p, q) => IP.toInt(p.ip) - IP.toInt(q.ip)));
      return out;
    }
    function vipsOf(zs) {
      const out = [];
      m.firewallRules.forEach((r) => {
        if (r.family !== 'ip' || r.table !== 'nat' || r.disabled || r.action !== 'dst-nat') return;
        const to = single(r.params['to-addresses']); if (!to) return;
        const ctx = I.ctxOf(r.dev);
        const dstA = r.match['dst-address'] !== undefined && !F.splitNeg(r.match['dst-address']).neg ? single(F.splitNeg(r.match['dst-address']).body.replace(/\/32$/, '')) : undefined;
        // 入口位址所在的 VRF：設備自己的位址取該介面的 VRF；dst-address 不是設備的位址時為 main。改寫後的目的在同一個 VRF 找 zone
        const vrfOfOwn = (ip) => { const a = Q.interfacesOf(r.dev).flatMap((i) => ownIps(i.key)).find((x) => x.ip === ip); return a ? K.vrf(a.vrf) : K.MAIN_VRF; };
        let ips;
        if (dstA) ips = [dstA];
        else {
          const okEp = (ep) => ['in-interface', 'in-interface-list'].every((k) => {
            const v = r.match[k]; if (v === undefined) return true;
            const { neg, body } = F.splitNeg(v);
            const set = k === 'in-interface' ? new Set([K.ep(r.dev, body)]) : ctx.resolve(body);
            if (!set) return false;
            return neg ? !set.has(ep) : set.has(ep);
          });
          ips = Q.interfacesOf(r.dev).filter((i) => okEp(i.key)).flatMap((i) => ownIps(i.key).map((a) => a.ip));
        }
        U.uniq(ips).filter((ip) => IP.isIp(ip)).sort(U.natural).forEach((ip) => {
          const vrf = vrfOfOwn(ip); const tz = zoneOf(to, zs.optsRaw, vrf); if (!tz) return;
          out.push({ ip, vrf, zone: tz.zone, subnet: tz.key, range: null, basis: 'dst-nat', via: 'nat', rule: r.key, natTo: to, dev: r.dev });
        });
      });
      return out;
    }
    let entryList = null;
    /**
     * L4 的對外入口（矩陣的外部 zone 與暴露清單共用這一份，ADR-023 決策 1）：有 /export 的設備上，
     * Q.wanEntries()（名稱含 WAN 的清單成員，檢查用同一份）與對外邊界判定為 external 的介面（Q.boundaries）的聯集，依設備、介面排序。
     * [{ dev, ep, vrf, hasIfc }]：沒有介面紀錄的成員也是入口，VRF 視為 main（hasIfc false）。可能對外（possible）的介面不是入口。
     * VRF（同 S.infer.fw.wanEntries）：所有 VRF 的入口都算；連到設備本身服務的（矩陣「外部 → 網路設備」、暴露清單 self 段）
     * 只用服務所在 VRF（main，/ip service 的 vrf 參數沒有解析）的入口；轉送與 dst-nat 用全部入口，各自在入口的 VRF 查路由。
     */
    const l4Entries = () => entryList || (entryList = (() => {
      const byEp = new Map();
      const add = (w) => { if (devInfo(w.dev).config && !byEp.has(w.ep)) byEp.set(w.ep, { dev: w.dev, ep: w.ep, vrf: w.vrf, hasIfc: w.hasIfc }); };
      Q.wanEntries().forEach(add);
      Q.boundaries().forEach((b) => { if (b.status === 'external') add(b); });
      return Object.freeze(Array.from(byEp.values()).sort((a, b) => U.natural(a.dev, b.dev) || U.natural(a.ep, b.ep)).map(Object.freeze));
    })());
    /**
     * 矩陣的虛擬 zone（推論，不在 Q.zones）：
     *   外部（external）：基準以外的位址。來源從每個對外入口（l4Entries，與暴露清單相同）進入、在入口的 VRF 查路由，目的經對外介面送出（end egress-wan）；
     *     代表位址是 EXTERNAL_CANDIDATES 中第一個不在基準網段、也不屬於任何設備的位址，只代表與它同一個規則位址區段的公網位址（range）。
     *     沒有任何對外入口時沒有這個 zone。
     *   網路設備（管理）（self，只當目的）：已收集且有 /export 的設備自己的位址，走 input 與 /ip service；
     *     取 main VRF 入口介面上的位址，與每個網段的閘道介面上的位址（1000 台時不把每台設備的每個位址都算進來）。
     */
    function virtualOf(reps) {
      bounds();
      const wanEps = l4Entries();
      const extIp = wanEps.length ? externalRep() : null;
      let range = null;
      if (extIp) { const i = findAtom(ruleB, IP.toInt(extIp)); range = [IP.fromInt(ruleB[i]), IP.fromInt(i + 1 < ruleB.length ? ruleB[i + 1] - 1 : 0xffffffff)]; }
      const extSrc = extIp ? wanEps.map((w) => ({ ip: extIp, vrf: w.vrf, zone: EXTERNAL_ZONE, subnet: null, range, basis: 'documentation', via: 'external', dev: w.dev, entry: w.ep })) : [];
      const extDst = extIp ? [{ ip: extIp, vrf: K.MAIN_VRF, zone: EXTERNAL_ZONE, subnet: null, range, basis: 'documentation', via: 'external', dev: null }] : [];
      const selfMap = new Map();
      const addSelf = (dev, ep, inNet) => {
        if (!devInfo(dev).config || !realEp(ep)) return;
        ownIps(ep).filter((a) => !inNet || inNet(a)).forEach((a) => { const v = K.vrf(a.vrf); const k = K.inVrf(a.ip, v); if (!selfMap.has(k)) selfMap.set(k, { ip: a.ip, vrf: v, zone: SELF_ZONE, subnet: null, range: null, basis: 'device', via: 'device', dev }); });
      };
      wanEps.forEach((w) => { if (w.vrf === K.MAIN_VRF) addSelf(w.dev, w.ep); });
      reps.forEach((list) => list.forEach((r) => {
        const loc = srcLocation(r.ip, r.vrf); if (loc.how !== 'subnet') return;
        loc.gateways.forEach((g) => addSelf(g.dev, g.ep, (a) => IP.inNet(a.ip, loc.net, loc.len)));
      }));
      const selfDst = Array.from(selfMap.values()).sort((a, b) => U.natural(a.dev, b.dev) || IP.toInt(a.ip) - IP.toInt(b.ip));
      const zonesV = [];
      if (extIp) zonesV.push({ id: EXTERNAL_ZONE, name: '外部（Internet）', source: 'virtual', inferred: true, virtual: true, dstOnly: false, vrf: K.MAIN_VRF, subnets: [],
        devices: U.uniq(wanEps.map((w) => w.dev)).sort(U.natural), representative: extIp, range,
        basis: `基準以外的位址（推論）：代表位址 ${extIp} 是文件保留位址，只代表 ${range[0]}–${range[1]}（同一個規則位址區段）；來源從對外介面進入，目的經對外介面送出` });
      if (selfDst.length) zonesV.push({ id: SELF_ZONE, name: '網路設備（管理）', source: 'virtual', inferred: true, virtual: true, dstOnly: true, vrf: null, subnets: [],
        devices: U.uniq(selfDst.map((x) => x.dev)).sort(U.natural), representative: null, range: null,
        basis: '網路設備自己的位址（WAN 介面與各網段的閘道介面），走輸入規則（input）與管理服務（/ip service）' });
      return { extSrc, extDst, selfDst, zones: zonesV };
    }
    function servicesOf(list) {
      if (list != null) {
        if (!Array.isArray(list) || !list.length) throw new TypeError('services 必須是非空陣列，例如 [{ proto: "tcp", port: 443 }]');
        return list.map((s) => { const proto = normProto(s && s.proto); return { proto, port: normPort(proto, s.port == null ? null : s.port) }; })
          .filter((s, i, a) => a.findIndex((x) => svcId(x) === svcId(s)) === i);
      }
      const extra = [];
      m.firewallRules.forEach((r) => {
        if (r.family !== 'ip' || r.table !== 'nat' || r.disabled || r.action !== 'dst-nat' || r.match['dst-port'] === undefined) return;
        const p = r.match.protocol && !F.splitNeg(r.match.protocol).neg ? F.protoName(F.splitNeg(r.match.protocol).body.split(',')[0]) : 'tcp';
        const v = F.parseVal('dst-port', r.match['dst-port']);
        if (v.kind === 'ranges' && !v.neg && F.PORT_PROTOCOLS.has(p)) extra.push({ proto: p, port: Number(v.items[0][0]) });
      });
      const all = SERVICES.map((s) => ({ proto: s.proto, port: s.port })).concat(extra);
      const PO = ['icmp', 'tcp', 'udp'];
      return all.filter((s, i, a) => a.findIndex((x) => svcId(x) === svcId(s)) === i)
        .sort((a, b) => (PO.indexOf(a.proto) + 1 || 9) - (PO.indexOf(b.proto) + 1 || 9) || U.cmp(a.proto, b.proto) || (a.port || 0) - (b.port || 0));
    }
    /**
     * 格子的狀態：確定的允許不被「無法判斷」藏起來（暴露存在就要看得到）。
     *   允許與拒絕都有 → partial；只有允許（另有無法判斷）→ allow；沒有允許、有無法判斷 → unknown（無法判斷的可能是允許，拒絕不能當結論）。
     * 有確定的結果又有無法判斷的組合時，另以 incomplete（incompleteOf）標示「部分無法判斷」。
     */
    const STATUS = (c) => (c.allow && c.deny ? 'partial' : c.allow ? 'allow' : c.unknown ? 'unknown' : c.deny ? 'deny' : 'empty');
    const incompleteOf = (c) => c.unknown > 0 && c.allow > 0;
    const matrixCache = new Map();
    /**
     * service 的等價類：協定與埠對所有規則的條件結果相同的 service 只算一次（結果完全相同，只差最後的埠）。
     * 協定：規則提到的協定各自一類，其他依有沒有埠分兩類；埠：規則的 dst-port／port 邊界切出的區段。回傳 [[service 索引]]，依第一個索引排序。
     */
    let svcBounds = null;
    function svcClasses(services) {
      if (!svcBounds) {
        const protos = new Set(); const ports = new Set([0]);
        m.firewallRules.forEach((r) => {
          if (r.family !== 'ip') return;
          if (r.match.protocol !== undefined) F.splitNeg(r.match.protocol).body.split(',').forEach((p) => protos.add(F.protoName(p.trim().toLowerCase())));
          ['dst-port', 'port'].forEach((k) => {
            if (r.match[k] === undefined) return;
            const v = F.parseVal(k, r.match[k]);
            if (v.kind === 'ranges') v.items.forEach(([a, b]) => { ports.add(Number(a)); ports.add(Number(b) + 1); }); else ports.add(NaN);
          });
        });
        svcBounds = { protos, ports: ports.has(NaN) ? null : Float64Array.from(Array.from(ports).sort((a, b) => a - b)) };
      }
      const keyOf = (s) => {
        const p = svcBounds.protos.has(s.proto) ? s.proto : F.PORT_PROTOCOLS.has(s.proto) ? '~port' : '~noport';
        const pt = s.port == null ? -1 : svcBounds.ports ? findAtom(svcBounds.ports, s.port) : s.port; // 無法解析的埠清單：每個埠各自一類
        return p + '|' + pt;
      };
      const out = new Map();
      services.forEach((s, i) => U.getOr(out, keyOf(s), () => []).push(i));
      return Array.from(out.values());
    }
    /** 把 generator 跑完，回傳它的結果（同步版與分段版共用同一份判斷）。 */
    const runAll = (it) => { let r = it.next(); while (!r.done) r = it.next(); return r.value; };
    /**
     * 分段計算（Q.zoneMatrixSteps）每一段的時間預算：一次判斷約 0.05–0.3 ms（快取冷的時候較慢），格子的大小也差很多，
     * 用固定的次數切不出穩定的段長，所以每 SLICE_CHECK 個單位看一次經過的時間，超過 SLICE_MS 就讓出。
     * 時間只決定在哪裡讓出（yield 的次數），不影響任何結果（可重現）；1000 台時每段約 SLICE_MS 加上一個單位的時間。
     */
    const SLICE_MS = 25;
    const SLICE_CHECK = 8;
    const slicer = () => { let t0 = Date.now(); let n = 0; return () => { if (++n < SLICE_CHECK) return false; n = 0; const t = Date.now(); if (t - t0 < SLICE_MS) return false; t0 = t; return true; }; };
    function* matrixRawSteps(opts) {
      const o = opts || {};
      const zs = zones(o); zs.optsRaw = o;
      const services = servicesOf(o.services);
      const ck = JSON.stringify([zs.opts.profHash, zs.opts.sources, services.map(svcId)]);
      if (matrixCache.has(ck)) return matrixCache.get(ck);
      yield { stage: 'reps', done: 0, total: 2 };
      // 代表位址、dst-nat 入口與虛擬 zone 各算一段（1000 台時合起來接近 100 ms，分開讓出）
      const reps = repsOf(zs);
      yield { stage: 'reps', done: 1, total: 2 };
      const vips = vipsOf(zs); const vz = virtualOf(reps);
      const realIds = zs.zones.map((z) => z.id);
      const srcReps = []; realIds.forEach((z) => (reps.get(z) || []).forEach((r) => srcReps.push(r)));
      const memberN = srcReps.length;
      vz.extSrc.forEach((r) => srcReps.push(r));
      const targets = srcReps.slice(0, memberN).concat(vips, vz.extDst, vz.selfDst);
      // 列（來源）：實際的 zone＋外部；欄（目的）：再加網路設備（管理）
      const allZones = zs.zones.concat(vz.zones);
      const rowIds = allZones.filter((z) => !z.dstOnly).map((z) => z.id); const zoneIds = allZones.map((z) => z.id);
      const cells = new Map();
      const cellOf = (a, b) => U.getOr(cells, a + '\u0000' + b, () => ({ src: a, dst: b, recs: [] }));
      const classes = svcClasses(services);
      // 目的是設備本身時，localService 依埠找那台設備的管理服務（/ip service：停用或 available-from 不含來源就拒絕），
      // 規則沒提到的埠不一定行為相同：同一類再依「這台設備在這個埠的服務」（沒有、或啟用與允許的來源）分開
      const devClassMemo = new Map();
      const svcSig = (dev, s) => { if (s.proto !== 'tcp' || s.port == null) return '-'; const sv = Q.ipServicesOf(dev).find((x) => x.port === s.port); return sv ? (sv.enabled ? '1' : '0') + '|' + sv.addresses.slice().sort().join(',') : '-'; };
      const classesFor = (t) => (t.via !== 'device' ? classes : U.getOr(devClassMemo, t.dev, () => classes.flatMap((sis) => {
        const by = new Map(); sis.forEach((si) => U.getOr(by, svcSig(t.dev, services[si]), () => []).push(si));
        return Array.from(by.values());
      })));
      // 判斷次數的上限（來源代表 × 目的 × service 等價類，扣掉來源與目的相同的）只用來回報進度
      const total = srcReps.length * targets.reduce((n, t) => n + classesFor(t).length, 0);
      let done = 0;
      /** 一個判斷（sum，service 類 group 的代表）記進它的格子。 */
      const record = (a, ai, t, ti, tip, group, sum) => {
        const rp = services[group[0]].port;
        const fv0 = (sum.final && sum.final.vrf) || t.vrf;
        // dst-nat 的入口只算真的被改寫的；設備本身的目的只算真的送到那台設備的（重疊位址在來源的 VRF 送達別處時不算）
        if ((t.via === 'nat' && !sum.nat) || (t.via === 'device' && (fv0 !== t.vrf || (sum.final && sum.final.dst !== t.ip)))) return;
        // 目的 zone：NAT 改寫了目的時依改寫後的位址；送達的 VRF 和目的代表的 VRF 不同時（重疊的位址在來源的 VRF 就送達了）依送達的 VRF
        let dz = t.zone;
        if (sum.final && (sum.final.dst !== tip || (fv0 !== t.vrf && sum.verdict === 'allow'))) { const z = zoneOf(sum.final.dst, o, fv0); if (z) dz = z.zone; }
        const c = cellOf(a.zone, dz);
        for (const si of group) c.recs.push({ ai, ti, si, sum, rp });
      };
      yield { stage: 'evaluate', done, total };
      const due = slicer();
      for (let ai = 0; ai < srcReps.length; ai++) {
        const a = srcReps[ai];
        for (let ti = 0; ti < targets.length; ti++) {
          const t = targets[ti];
          for (const sis of classesFor(t)) {
            done++;
            // 來源與目的是同一個代表位址：zone 內同網段的組合改用同一個區段的第二個位址（沒有就略過）
            const same = a.ip === t.ip && a.vrf === t.vrf;
            if (same && !(t.via === 'member' && t.peer)) continue;
            // 外部經非 main VRF 的入口：不連到設備本身的服務（服務在 main，見 l4Entries）；
            // 外部到網段：只用入口 VRF 的代表位址（同暴露清單的 routed 段；其他 VRF 的重疊位址在入口的 VRF 是另一個目的）
            if (a.via === 'external' && ((t.via === 'device' && a.vrf !== K.MAIN_VRF) || (t.via === 'member' && t.vrf !== a.vrf))) continue;
            const tip = same ? t.peer : t.ip;
            const sum0 = evaluate(a.ip, tip, services[sis[0]], 'atom', null, a.entry || null, a.vrf).sum;
            // 不是設備本身的目的，卻送到某台網路設備自己的位址（重疊網段在另一個 VRF 的擁有者、dst-nat 到設備）：
            // 那台設備的 /ip service 依埠不同，同一類再依服務分開判斷（同 classesFor 對設備本身的目的）
            const od = t.via !== 'device' && sis.length > 1 && sum0.final && sum0.final.dst ? ownerDev(sum0.final.dst, sum0.final.vrf || t.vrf) : null;
            if (od && netDev(od)) {
              const by = new Map(); sis.forEach((si) => U.getOr(by, svcSig(od, services[si]), () => []).push(si));
              Array.from(by.values()).forEach((g) => record(a, ai, t, ti, tip, g, g[0] === sis[0] ? sum0 : evaluate(a.ip, tip, services[g[0]], 'atom', null, a.entry || null, a.vrf).sum));
            } else record(a, ai, t, ti, tip, sis, sum0);
            if (due() && done < total) yield { stage: 'evaluate', done, total };
          }
        }
      }
      // 跑完才寫進快取：中途放棄的 generator 不會留下不完整的結果
      if (matrixCache.has(ck)) return matrixCache.get(ck);
      const byId = new Map(allZones.map((z) => [z.id, z]));
      const res = { zs, services, srcReps, targets, cells, zoneIds, rowIds, allZones, byId, memberN, vz, natN: vips.length, opts: o };
      matrixCache.set(ck, res);
      return res;
    }
    const matrixRaw = (opts) => runAll(matrixRawSteps(opts));
    /** 一格的摘要（L0 的格子）：逐筆累加（add），最後 finish；分段計算時可以在記錄之間讓出。 */
    function cellAcc(mx, c) {
      const counts = { allow: 0, deny: 0, unknown: 0, total: 0 };
      const bySvc = mx.services.map(() => ({ allow: 0, deny: 0, unknown: 0, total: 0 }));
      // 拒絕分成路由沒到（noRoute）與防火牆擋下（filter），合計等於 counts.deny
      const deniedBy = { noRoute: 0, filter: 0 }; const deniedBySvc = mx.services.map(() => ({ noRoute: 0, filter: 0 }));
      // 規則依（id, verdict）累計：兩層 Map，不必每筆記錄都組合字串鍵（1000 台時有數十萬筆）；攤平後的順序與「第一次出現」相同，見 flatRules
      const rules = new Map(); const reasons = new Map();
      // 同一個目的（或來源）與 service 出現過的結果：數字鍵（索引 × service 數＋service 索引）→ 位元（允許 1、拒絕 2；兩種都有是 3）。
      // 用數字不用 Set：1000 台時有數十萬個鍵，每個 Set 都是一個物件（GC 的負擔）
      const byDst = new Map(); const bySrc = new Map(); const ns = mx.services.length;
      const add = (r) => {
        const v = r.sum.verdict; counts[v]++; counts.total++; bySvc[r.si][v]++; bySvc[r.si].total++;
        if (v === 'deny') { const k = deniedByOf(r.sum); deniedBy[k]++; deniedBySvc[r.si][k]++; }
        r.sum.decisive.forEach((x, id) => {
          let byV = rules.get(id); if (!byV) { byV = new Map(); rules.set(id, byV); }
          let e = byV.get(x.verdict); if (!e) { e = Object.assign({ id, count: 0 }, x); byV.set(x.verdict, e); }
          e.count++;
        });
        if (v === 'unknown') r.sum.reasons.forEach((x) => reasons.set(x.code, (reasons.get(x.code) || 0) + 1));
        if (v !== 'unknown') { const bit = v === 'allow' ? 1 : 2; const kd = r.ti * ns + r.si; const ks = r.ai * ns + r.si; byDst.set(kd, (byDst.get(kd) | 0) | bit); bySrc.set(ks, (bySrc.get(ks) | 0) | bit); }
      };
      return { add, finish: () => cellFinish(mx, c, { counts, bySvc, deniedBy, deniedBySvc, rules: flatRules(rules), reasons, byDst, bySrc }) };
    }
    /**
     * 兩層的規則累計攤平成一層（cellFinish 只用 values()）：同一個 id 的各結果依第一次出現的順序；
     * 不同 id 之間的順序由 cellFinish 依 count 與 id 排序決定，所以結果與依「第一次出現」排列的一層 Map 相同。
     */
    const flatRules = (rules) => { const out = []; rules.forEach((byV) => byV.forEach((e) => out.push(e))); return out; };
    function cellSummary(mx, c) { const acc = cellAcc(mx, c); c.recs.forEach(acc.add); return acc.finish(); }
    function cellFinish(mx, c, { counts, bySvc, deniedBy, deniedBySvc, rules, reasons, byDst, bySrc }) {
      const het = Array.from(byDst.values()).some((b) => b === 3) || Array.from(bySrc.values()).some((b) => b === 3);
      const ruleList = Array.from(rules.values()).sort((a, b) => b.count - a.count || U.cmp(a.id, b.id)).map(({ id, ...x }) => Object.assign({ id }, x, x.key ? { rule: ref(Q.getFirewallRule(x.key)) } : {}));
      return {
        src: c.src, dst: c.dst, diagonal: c.src === c.dst, status: STATUS(counts), incomplete: incompleteOf(counts), counts, deniedBy, heterogeneous: het,
        services: mx.services.map((s, i) => ({ service: svcId(s), proto: s.proto, port: s.port, status: STATUS(bySvc[i]), incomplete: incompleteOf(bySvc[i]), counts: bySvc[i], deniedBy: deniedBySvc[i] })),
        rule: ruleList.find((x) => x.key) || ruleList[0] || null, rules: ruleList.slice(0, 5), ruleCount: ruleList.length,
        reasons: Array.from(reasons.entries()).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || U.cmp(a.code, b.code)),
      };
    }
    /** IPv6 在用（推論，firewallZones[].ipv6）的設備：矩陣只算 IPv4，畫面據此提示 IPv6 未納入（F05／F07）。 */
    const ipv6Devices = () => (m.firewallZones || []).filter((z) => z.ipv6 && z.ipv6.status === 'used').map((z) => ({ dev: z.dev, src: (z.ipv6.src || []).map((x) => x.slice()) })).sort((a, b) => U.natural(a.dev, b.dev));
    const l0Cache = new Map();
    /**
     * zone 矩陣 L0 的分段計算（generator）：每一段 yield { stage: 'reps'|'evaluate'|'summary', done, total }，
     * 最後的回傳值就是 matrix(opts) 的結果，並寫進同一份快取；已有快取時不 yield、直接回傳。
     */
    function* matrixSteps(opts) {
      const mx = yield* matrixRawSteps(opts);
      const ck = JSON.stringify([mx.zs.opts.profHash, mx.zs.opts.sources, mx.services.map(svcId)]);
      if (l0Cache.has(ck)) return l0Cache.get(ck);
      const cells = [];
      // 進度以記錄數計（格子大小差很多）；空格子算一個單位
      const total = mx.rowIds.reduce((n, a) => n + mx.zoneIds.reduce((k, b) => { const c = mx.cells.get(a + '\u0000' + b); return k + (c ? Math.max(1, c.recs.length) : 1); }, 0), 0);
      let done = 0;
      yield { stage: 'summary', done, total };
      const due = slicer();
      for (const a of mx.rowIds) {
        for (const b of mx.zoneIds) {
          const c = mx.cells.get(a + '\u0000' + b);
          if (!c) {
            cells.push({ src: a, dst: b, diagonal: a === b, status: 'empty', incomplete: false, counts: { allow: 0, deny: 0, unknown: 0, total: 0 }, deniedBy: { noRoute: 0, filter: 0 }, heterogeneous: false,
              services: mx.services.map((s) => ({ service: svcId(s), proto: s.proto, port: s.port, status: 'empty', incomplete: false, counts: { allow: 0, deny: 0, unknown: 0, total: 0 }, deniedBy: { noRoute: 0, filter: 0 } })), rule: null, rules: [], ruleCount: 0, reasons: [] });
            done++;
          } else {
            const acc = cellAcc(mx, c);
            for (const r of c.recs) {
              acc.add(r); done++;
              if (due() && done < total) yield { stage: 'summary', done, total };
            }
            cells.push(acc.finish());
            if (!c.recs.length) done++;
          }
          if (due() && done < total) yield { stage: 'summary', done, total };
        }
      }
      if (l0Cache.has(ck)) return l0Cache.get(ck); // 兩個分段計算交錯時，先完成的為準（結果相同）
      const reps = mx.memberN; const evaluations = Array.from(mx.cells.values()).reduce((n, c) => n + c.recs.length, 0);
      const out = deepFreeze({
        vrf: null, vrfs: Q.vrfs().filter((v) => mx.zs.zones.some((z) => z.vrf === v)), zones: mx.allZones, services: mx.services.map((s) => ({ id: svcId(s), proto: s.proto, port: s.port })), cells,
        stats: { zones: mx.zoneIds.length, representatives: reps, natEntries: mx.natN, externalEntries: mx.vz.extSrc.length, deviceTargets: mx.vz.selfDst.length, evaluations },
        ipv6: ipv6Devices(),
      });
      l0Cache.set(ck, out);
      return out;
    }
    const matrix = (opts) => runAll(matrixSteps(opts));
    const recOut = (mx, r) => {
      const a = mx.srcReps[r.ai]; const t = mx.targets[r.ti]; const s = mx.services[r.si];
      return { src: a, dst: t, service: svcId(s), verdict: r.sum.verdict, final: r.sum.final && r.sum.final.port === r.rp ? { dst: r.sum.final.dst, port: s.port } : r.sum.final,
        rules: Array.from(r.sum.decisive.values()).map((x) => (x.key ? x.key : `policy:${x.dev}|${x.table}|${x.chain}`)),
        reasons: r.sum.verdict === 'unknown' ? U.uniq(r.sum.reasons.map((x) => x.code)) : [] };
    };
    function cell(srcZone, dstZone, opts) {
      const mx = matrixRaw(opts);
      if (!mx.byId.has(srcZone) || !mx.byId.has(dstZone)) throw new TypeError(`沒有這個 zone：${!mx.byId.has(srcZone) ? srcZone : dstZone}`);
      const c = mx.cells.get(srcZone + '\u0000' + dstZone) || { src: srcZone, dst: dstZone, recs: [] };
      const sm = cellSummary(mx, c);
      // L1：每個（來源代表、目的）一列，依 service 列出結果；結果相同的來源併成一組（規格書 §5.7）
      const pairs = new Map();
      c.recs.forEach((r) => {
        const p = U.getOr(pairs, r.ai + '|' + r.ti, () => ({ ai: r.ai, ti: r.ti, services: [] }));
        const x = recOut(mx, r); p.services.push({ service: x.service, verdict: x.verdict, final: x.final, rules: x.rules, reasons: x.reasons });
      });
      // 造成異質的記錄（與 cellSummary 的 heterogeneous 同一個依據）：heterogeneous 是「同一個目的與 service，不同來源的結果不同」
      // 或「同一個來源與 service，不同目的的結果不同」（unknown 不算）。在這樣一條有衝突的線上，結果是少數（平手時兩邊都算）的記錄造成差異。
      // 所以格子異質時至少有一組 divergent，不異質時沒有。
      const lineOf = new Map();
      const tally = (k, v) => { const e = U.getOr(lineOf, k, () => ({ allow: 0, deny: 0 })); e[v]++; };
      c.recs.forEach((r) => { if (r.sum.verdict !== 'unknown') { tally('d' + r.ti + '|' + r.si, r.sum.verdict); tally('s' + r.ai + '|' + r.si, r.sum.verdict); } });
      const minority = (k, v) => { const e = lineOf.get(k); return e.allow > 0 && e.deny > 0 && e[v] <= e[v === 'allow' ? 'deny' : 'allow']; };
      const divergentSvc = new Map(); // ai|ti → Set(service id)
      c.recs.forEach((r) => {
        const v = r.sum.verdict; if (v === 'unknown') return;
        if (minority('d' + r.ti + '|' + r.si, v) || minority('s' + r.ai + '|' + r.si, v)) U.getOr(divergentSvc, r.ai + '|' + r.ti, () => new Set()).add(svcId(mx.services[r.si]));
      });
      const rows = new Map();
      Array.from(pairs.values()).sort((p, q) => p.ti - q.ti || p.ai - q.ai).forEach((p) => {
        const sig = JSON.stringify(p.services.map((s) => [s.service, s.verdict, s.rules, s.reasons]));
        const row = U.getOr(rows, p.ti + '|' + sig, () => ({ dst: mx.targets[p.ti], srcs: [], services: p.services, div: new Set() }));
        row.srcs.push(mx.srcReps[p.ai]);
        (divergentSvc.get(p.ai + '|' + p.ti) || []).forEach((sv) => row.div.add(sv));
      });
      const groups = Array.from(rows.values()).map((r) => {
        const c2 = { allow: 0, deny: 0, unknown: 0 }; r.services.forEach((s) => { c2[s.verdict]++; });
        return { dst: r.dst, srcs: r.srcs, services: r.services, status: STATUS(c2), incomplete: incompleteOf(c2), counts: c2,
          srcDevices: U.uniq(r.srcs.flatMap((s) => { if (s.entry) return [s.entry]; const l = srcLocation(s.ip, s.vrf); return l.how === 'subnet' ? l.gateways.map((g) => g.ep || g.dev) : l.dev ? [l.dev] : []; })).sort(U.natural),
          divergent: r.div.size > 0, divergentServices: r.services.map((s) => s.service).filter((sv) => r.div.has(sv)) };
      });
      // L2：牽涉的規則
      const rules = new Map();
      c.recs.forEach((r) => {
        r.sum.decisive.forEach((x, id) => {
          const e = U.getOr(rules, id, () => ({ id, key: x.key, dev: x.dev, table: x.table, chain: x.chain, policy: !!x.policy, route: x.route || null, rule: x.key ? ref(Q.getFirewallRule(x.key)) : null, verdict: x.verdict || null, verdicts: { allow: 0, deny: 0, unknown: 0 }, services: [] }));
          e.verdicts[r.sum.verdict]++; const sv = svcId(mx.services[r.si]); if (!e.services.includes(sv)) e.services.push(sv);
        });
        if (r.sum.verdict === 'unknown') r.sum.reasons.forEach((x) => {
          if (!x.rule) return;
          const e = U.getOr(rules, x.rule.key, () => ({ id: x.rule.key, key: x.rule.key, dev: x.rule.dev, table: x.rule.table, chain: x.rule.chain, policy: false, route: null, rule: x.rule, verdicts: { allow: 0, deny: 0, unknown: 0 }, services: [] }));
          e.uncertain = (e.uncertain || 0) + 1;
        });
      });
      const ruleList = Array.from(rules.values()).map((e) => Object.assign({ uncertain: 0 }, e))
        .sort((a, b) => (b.verdicts.allow + b.verdicts.deny + b.verdicts.unknown + b.uncertain) - (a.verdicts.allow + a.verdicts.deny + a.verdicts.unknown + a.uncertain) || U.cmp(a.id, b.id));
      return deepFreeze(JSON.parse(JSON.stringify(Object.assign({}, sm, { groups, ruleDetails: ruleList }))));
    }

    // ---- 規則的影響
    function ruleImpact(key, opts) {
      const rule = Q.getFirewallRule(key);
      if (!rule) return null;
      const o = opts || {};
      const mx = matrixRaw(o);
      const limit = o.limit == null ? 50 : o.limit;
      const recs = [];
      mx.cells.forEach((c) => c.recs.forEach((r) => { if (involves(r.sum, key)) recs.push({ plane: 'transit', src: mx.srcReps[r.ai], dst: mx.targets[r.ti], svc: mx.services[r.si], sum: r.sum, cell: [c.src, c.dst] }); }));
      // 設備本身（input／output）：所有代表位址 → 這台設備的位址、這台設備的位址 → 所有目的
      if (rule.table !== 'nat' || rule.chain !== 'srcnat') {
        // 這台設備的位址（每個 VRF 分開；位址鍵排序）
        const ownAll = Q.interfacesOf(rule.dev).flatMap((i) => ownIps(i.key).map((a) => ({ ip: a.ip, vrf: K.vrf(a.vrf) })));
        const own = ownAll.filter((x, i) => ownAll.findIndex((y) => y.ip === x.ip && y.vrf === x.vrf) === i).sort((x, y) => U.natural(K.inVrf(x.ip, x.vrf), K.inVrf(y.ip, y.vrf)));
        const zoneOfIp = (ip, vrf) => { const z = zoneOf(ip, o, vrf); return z ? z.zone : null; };
        const finalZone = (sum, ip, vrf) => (sum.final && sum.final.dst ? zoneOfIp(sum.final.dst, sum.final.vrf || vrf) : zoneOfIp(ip, vrf)); // zone 以 NAT 後的位址為準
        own.forEach(({ ip, vrf }) => mx.srcReps.forEach((a) => mx.services.forEach((svc) => {
          if (a.ip === ip && a.vrf === vrf) return;
          const { sum } = evaluate(a.ip, ip, svc, 'atom', null, a.entry || null, a.vrf);
          if (involves(sum, key)) recs.push({ plane: 'device', src: a, dst: { ip, vrf, zone: zoneOfIp(ip, vrf), subnet: null, via: 'device', dev: rule.dev }, svc, sum, cell: [a.zone, finalZone(sum, ip, vrf)] });
        })));
        own.forEach(({ ip, vrf }) => mx.targets.forEach((t) => mx.services.forEach((svc) => {
          if (t.ip === ip && t.vrf === vrf) return;
          const { sum } = evaluate(ip, t.ip, svc, 'atom', null, null, vrf);
          if (involves(sum, key)) recs.push({ plane: 'device', src: { ip, vrf, zone: zoneOfIp(ip, vrf), subnet: null, via: 'device', dev: rule.dev }, dst: t, svc, sum, cell: [zoneOfIp(ip, vrf), finalZone(sum, t.ip, t.vrf) || t.zone] });
        })));
      }
      const roleOf = (r) => {
        const d = Array.from(r.sum.decisive.values()).some((x) => x.key === key);
        const u = r.sum.reasons.some((x) => x.rule && x.rule.key === key);
        return d ? 'decides' : u ? 'uncertain' : 'passes';
      };
      const cellMap = new Map();
      const skip = skipOf([key]);
      const changed = [];
      recs.forEach((r) => {
        const role = roleOf(r);
        const e = U.getOr(cellMap, r.cell.join('\u0000'), () => ({ src: r.cell[0], dst: r.cell[1], plane: r.plane, services: [], decides: 0, uncertain: 0, passes: 0, verdicts: { allow: 0, deny: 0, unknown: 0 } }));
        e[role]++; e.verdicts[r.sum.verdict]++; if (!e.services.includes(svcId(r.svc))) e.services.push(svcId(r.svc));
        const alt = evaluate(r.src.ip, r.dst.via === 'member' && r.src.ip === r.dst.ip ? r.dst.peer : r.dst.ip, r.svc, 'atom', skip, r.src.entry || null, r.src.vrf).sum;
        if (alt.verdict !== r.sum.verdict) changed.push({ src: r.src.ip, dst: r.dst.ip, srcZone: r.cell[0], dstZone: r.cell[1], service: svcId(r.svc), from: r.sum.verdict, to: alt.verdict, plane: r.plane });
      });
      const sortRec = (a, b) => U.cmp(a.srcZone || '', b.srcZone || '') || U.cmp(a.dstZone || '', b.dstZone || '') || IP.toInt(a.src) - IP.toInt(b.src) || IP.toInt(a.dst) - IP.toInt(b.dst) || U.cmp(a.service, b.service);
      const paths = recs.map((r) => ({ src: r.src.ip, dst: r.dst.ip, srcZone: r.cell[0], dstZone: r.cell[1], service: svcId(r.svc), plane: r.plane, role: roleOf(r), verdict: r.sum.verdict })).sort(sortRec);
      changed.sort(sortRec);
      const changeCounts = {}; changed.forEach((c) => { const k = c.from + '→' + c.to; changeCounts[k] = (changeCounts[k] || 0) + 1; });
      const fs = Q.findingsFor('rule', key);
      return deepFreeze(JSON.parse(JSON.stringify({
        rule: Object.assign({}, ref(rule), { stats: rule.stats || null }), shadowed: fs.some((f) => f.id === 'F01'), duplicate: fs.some((f) => f.id === 'F02'), findings: fs.map((f) => Q.findingKey(f)),
        cells: Array.from(cellMap.values()).sort((a, b) => U.cmp(a.plane, b.plane) || U.cmp(a.src || '', b.src || '') || U.cmp(a.dst || '', b.dst || '')),
        total: { evaluations: recs.length, decides: paths.filter((p) => p.role === 'decides').length, uncertain: paths.filter((p) => p.role === 'uncertain').length, passes: paths.filter((p) => p.role === 'passes').length },
        paths: paths.slice(0, limit), truncated: paths.length > limit,
        ifDisabled: { changed: changed.slice(0, limit), counts: changeCounts, total: changed.length, truncated: changed.length > limit },
      })));
    }

    // ---- 暴露清單（由外而內）：從 WAN 進來，連得到哪些位址、哪些服務（推論，查詢時計算，ADR-014）
    const exposureCache = new Map();
    /**
     * 不會是從 WAN 進來的新連線來源（S.ip.classify）：reserved（0.0.0.0/8「this network」、240.0.0.0/4 與廣播、192.0.0.0/24、198.18.0.0/15）、loopback、multicast。
     * private、cgnat、link-local 仍算（偽造或電信業者那一側的來源可能出現在 WAN）；documentation 是代表位址本身。
     */
    const NOT_EXTERNAL_SRC = new Set(['reserved', 'loopback', 'multicast']);
    const SPECIAL_SRC = (n) => NOT_EXTERNAL_SRC.has(IP.classify(IP.fromInt(n)));
    /**
     * 外部來源的代表位址（每台入口設備各自一份）：這台設備的規則（src-address）、/ip service 的 available-from 與 /routing rule 的 src-address 切出的區段，
     * 每個區段取一個不在基準網段、也不屬於任何設備的位址。第一個是矩陣外部 zone 的代表位址所在的區段（用同一個位址）。超過 max 時截斷。
     */
    function extSources(dev, extIp, max) {
      const b = new Set([0, 0x100000000]);
      const add = (key, text) => {
        if (text === undefined) return;
        const p = F.parseVal(key, F.splitNeg(text).body);
        if (p.kind === 'ranges' && p.bits === 32) p.items.forEach(([x, y]) => { b.add(Number(x)); b.add(Number(y) + 1); });
      };
      m.firewallRules.forEach((r) => { if (r.family === 'ip' && r.dev === dev) add('src-address', r.match['src-address']); });
      Q.ipServicesOf(dev).forEach((sv) => sv.addresses.forEach((a) => add('src-address', a)));
      (m.routingRules || []).forEach((r) => { if (r.dev === dev) add('src-address', r.match['src-address']); });
      const arr = Array.from(b).sort((x, y) => x - y);
      const outside = (n) => !SPECIAL_SRC(n) && !longest(IP.fromInt(n), K.MAIN_VRF) && !ownerOf(IP.fromInt(n), K.MAIN_VRF);
      const atoms = [];
      const cands = EXTERNAL_CANDIDATES.map(intOf);
      for (let i = 0; i + 1 < arr.length; i++) {
        const lo = arr[i]; const hi = arr[i + 1] - 1;
        const rep = repInRange(lo, hi, cands, lo + Math.floor((hi - lo) / 2), outside);
        if (rep !== undefined) atoms.push({ ip: IP.fromInt(rep), range: [IP.fromInt(lo), IP.fromInt(hi)], primary: extIp != null && intOf(extIp) >= lo && intOf(extIp) <= hi });
      }
      atoms.forEach((a) => { if (a.primary) a.ip = extIp; });
      // 矩陣的代表位址所在的區段排第一，其餘依位址
      atoms.sort((x, y) => (y.primary ? 1 : 0) - (x.primary ? 1 : 0) || intOf(x.ip) - intOf(y.ip));
      return { list: atoms.slice(0, max), total: atoms.length, truncated: atoms.length > max };
    }
    /** 候選服務：預設服務 ∪ 從 WAN 進來的 input／forward 放行規則的 dst-port ∪ dst-nat 的 dst-port ∪ 入口設備 /ip service 的埠。埠範圍取第一個埠當代表，記下範圍。 */
    function exposureServices(entries) {
      const byId = new Map();
      const addSvc = (proto, port, origin, range) => {
        const s = { proto, port }; const id = svcId(s);
        const e = U.getOr(byId, id, () => ({ id, proto, port, range: null, origins: [] }));
        if (!e.origins.includes(origin)) e.origins.push(origin);
        if (range && !e.range) e.range = range;
      };
      SERVICES.forEach((s) => addSvc(s.proto, s.port, 'default'));
      const wanOf = new Map(); entries.forEach((w) => U.getOr(wanOf, w.dev, () => []).push(w.ep));
      const fromWan = (r) => ['in-interface', 'in-interface-list'].every((k) => {
        const v = r.match[k]; if (v === undefined) return true;
        const { neg, body } = F.splitNeg(v);
        const set = k === 'in-interface' ? new Set([K.ep(r.dev, body)]) : I.ctxOf(r.dev).resolve(body);
        if (!set) return true; // 無法展開的清單：可能包含 WAN，候選服務寧多勿少（判斷交給引擎）
        return wanOf.get(r.dev).some((ep) => (neg ? !set.has(ep) : set.has(ep)));
      });
      const portsOf = (r, origin) => {
        if (r.match['dst-port'] === undefined) return;
        const v = F.parseVal('dst-port', r.match['dst-port']);
        if (v.kind !== 'ranges' || v.neg) return;
        const pr = r.match.protocol !== undefined && !F.splitNeg(r.match.protocol).neg ? F.splitNeg(r.match.protocol).body.split(',').map((p) => F.protoName(p.trim().toLowerCase())) : ['tcp'];
        pr.filter((p) => F.PORT_PROTOCOLS.has(p)).forEach((p) => v.items.forEach(([a, b2]) => addSvc(p, Number(a), origin, a === b2 ? null : [Number(a), Number(b2)])));
      };
      // IPv6 的放行規則也提供候選埠（暴露清單的 IPv6 列與 IPv4 共用同一份服務）；dst-nat 只有 IPv4
      m.firewallRules.forEach((r) => {
        if ((r.family !== 'ip' && r.family !== 'ipv6') || r.disabled) return;
        if (r.family === 'ip' && r.table === 'nat' && r.chain === 'dstnat' && r.action === 'dst-nat') portsOf(r, 'dst-nat');
        else if (r.table === 'filter' && (r.chain === 'input' || r.chain === 'forward') && r.action === 'accept' && wanOf.has(r.dev) && fromWan(r)) portsOf(r, 'filter');
      });
      wanOf.forEach((_, d) => Q.ipServicesOf(d).forEach((sv) => { if (Number.isInteger(sv.port)) addSvc('tcp', sv.port, 'ip-service'); }));
      wanOf.forEach((_, d) => mgmtPorts(d).forEach((x) => addSvc(x.proto, x.port, 'mgmt')));
      const PO = ['icmp', 'tcp', 'udp'];
      return Array.from(byId.values()).sort((a, b) => (PO.indexOf(a.proto) + 1 || 9) - (PO.indexOf(b.proto) + 1 || 9) || U.cmp(a.proto, b.proto) || (a.port || 0) - (b.port || 0));
    }
    /**
     * 設備本身的其他管理服務（Q.mgmtOf，F10、F13、F14 判斷過的埠）：開著的才列。name 是畫面顯示的服務名稱，finding 是對應的檢查（facet 為 null 時同 id 的都算）。
     */
    const mgmtPorts = (dev) => {
      const g = Q.mgmtOf(dev); if (!g) return [];
      const out = [];
      if (g.dns && g.dns.allowRemote) out.push({ proto: 'udp', port: 53, name: 'dns', finding: ['F10', null] }, { proto: 'tcp', port: 53, name: 'dns', finding: ['F10', null] });
      if (g.snmp && g.snmp.enabled) out.push({ proto: 'udp', port: 161, name: 'snmp', finding: ['F13', null] });
      if (g.proxy && g.proxy.enabled) (g.proxy.ports || []).forEach((p) => { if (Number.isInteger(p)) out.push({ proto: 'tcp', port: p, name: 'web-proxy', finding: ['F14', 'proxy'] }); });
      if (g.socks && g.socks.enabled && Number.isInteger(g.socks.port)) out.push({ proto: 'tcp', port: g.socks.port, name: 'socks', finding: ['F14', 'socks'] });
      if (g.bandwidthServer && g.bandwidthServer.enabled && Number.isInteger(g.bandwidthServer.port)) out.push({ proto: 'tcp', port: g.bandwidthServer.port, name: 'bandwidth-server', finding: ['F14', 'bandwidth-server'] });
      return out;
    };
    const EXPOSURE_FINDINGS = new Set(['F03', 'F04', 'F05', 'F07', 'F10', 'F11', 'F12', 'F13', 'F14']);
    /** 一列相關的檢查（findingKey）：決定結果的規則（F03、F04；IPv6 列的 F05）、/ip service（F07）與設備的管理服務（F10、F13、F14）。 */
    const rowFindings = (dev, sum, svcName, mg) => {
      const fs = [];
      sum.decisive.forEach((x) => { if (x.key) fs.push(...Q.findingsFor('rule', x.key)); });
      if (svcName) fs.push(...Q.findingsFor('service', dev + '|' + svcName));
      if (mg) fs.push(...Q.findingsFor('device', dev).filter((f) => f.id === mg.finding[0] && (mg.finding[1] == null || f.facet === mg.finding[1])));
      return U.uniq(fs.filter((f) => EXPOSURE_FINDINGS.has(f.id)).map((f) => Q.findingKey(f))).sort(U.cmp);
    };
    // ---- 暴露清單的 IPv6（第一階段，只看邊界路由器）：不做 IPv6 路由與 NAT66。
    //   從 WAN 進入入口設備，以它的 /ipv6 firewall（raw prerouting、filter input／forward）判斷能到設備本身（self）與它直連的 LAN 側網段（routed）；
    //   規則語意全部用 S.infer.fw.decide（family ipv6），/ip service 的 available-from 也接受 IPv6 前綴
    //   （https://manual.mikrotik.com/docs/cli-reference/ip/service.md）。位址以 BigInt 表示，只在這一段使用。
    // 從 WAN 進來的 IPv6 新連線來源取全球單播（S.ip 的 public 類，2000::/3）的範圍；其中的 2001:db8::/32 是 documentation（代表位址本身），也算
    const GUA = IP.rangesOf(['public']).filter((c) => !IP.isIp(c.split('/')[0])).map((c) => F.parseVal('dst-address', c).items[0])[0];
    const GUA_LO = GUA[0]; const GUA_HI = GUA[1];
    const EXT6_CLASSES = new Set(['public', 'documentation']);
    const range6 = (text) => { const p = F.parseVal('dst-address', String(text)); return p.kind === 'ranges' && p.bits === 128 && !p.neg ? p.items : null; };
    /** BigInt → IPv6 文字（RFC 5952：小寫、省略前導 0、最長的連續 0（至少兩組）寫成 ::）。 */
    const fmt6 = (n) => {
      const g = []; for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn));
      let bs = -1; let bl = 0;
      for (let i = 0; i < 8;) { if (g[i] !== 0) { i++; continue; } let j = i; while (j < 8 && g[j] === 0) j++; if (j - i >= 2 && j - i > bl) { bs = i; bl = j - i; } i = j; }
      const hex = g.map((x) => x.toString(16));
      return bs < 0 ? hex.join(':') : hex.slice(0, bs).join(':') + '::' + hex.slice(bs + bl).join(':');
    };
    const cmpBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const linkLocal6 = (n) => IP.classify(fmt6(n)) === 'link-local'; // 只在同一個鏈路有效，不是從 WAN 進得來的目的
    /** 基準中的 IPv6 位址（ipAddresses 的 family 6，main VRF、不含鄰居宣告的）：[{ dev, ep, n, ip, len, lo, hi, prefix, src }]。 */
    let v6facts = null;
    function v6Facts() {
      if (v6facts) return v6facts;
      const addrs = [];
      (m.ipAddresses || []).forEach((a) => {
        if (a.family !== 6 || a.hearsay || !a.ep || K.vrf(a.vrf) !== K.MAIN_VRF) return;
        const t = String(a.address || ''); const cut = t.indexOf('/');
        const len = cut < 0 ? 128 : Number(t.slice(cut + 1));
        const one = range6(cut < 0 ? t : t.slice(0, cut)); const net = range6(t);
        if (!one || !net || !Number.isInteger(len) || len < 0 || len > 128) return;
        addrs.push({ dev: a.dev, ep: a.ep, n: one[0][0], ip: fmt6(one[0][0]), len, lo: net[0][0], hi: net[0][1], prefix: fmt6(net[0][0]) + '/' + len, src: (a.src || []).map((x) => x.slice()) });
      });
      addrs.sort((x, y) => U.natural(x.dev, y.dev) || U.natural(x.ep, y.ep) || cmpBig(x.n, y.n));
      v6facts = { addrs, owned: new Set(addrs.map((a) => a.n)), nets: addrs.map((a) => [a.lo, a.hi]) };
      return v6facts;
    }
    const inNets6 = (n, nets) => nets.some(([lo, hi]) => n >= lo && n <= hi);
    /** IPv6 的外部來源：這台設備 IPv6 規則的 src-address 與 /ip service 的 available-from 切出的區段（同 extSources），每段取一個全球單播、不在基準網段的位址。 */
    function extSources6(dev, max) {
      const b = new Set([0n, 1n << 128n]);
      const add = (text) => {
        if (text === undefined) return;
        const p = F.parseVal('src-address', F.splitNeg(text).body);
        if (p.kind === 'ranges' && p.bits === 128) p.items.forEach(([x, y]) => { b.add(x); b.add(y + 1n); });
      };
      m.firewallRules.forEach((r) => { if (r.family === 'ipv6' && r.dev === dev) add(r.match['src-address']); });
      Q.ipServicesOf(dev).forEach((sv) => sv.addresses.forEach(add));
      const arr = Array.from(b).sort(cmpBig);
      const nets = v6Facts().nets;
      const outside = (n) => EXT6_CLASSES.has(IP.classify(fmt6(n))) && !inNets6(n, nets);
      const cands = EXTERNAL6_CANDIDATES.map((c) => range6(c)[0][0]);
      const primary = cands.find(outside);
      const atoms = [];
      for (let i = 0; i + 1 < arr.length; i++) {
        const lo = arr[i]; const hi = arr[i + 1] - 1n;
        const a = lo > GUA_LO ? lo : GUA_LO; const z = hi < GUA_HI ? hi : GUA_HI;
        if (a > z) continue;
        const rep = repInRange(a, z, cands, a + (z - a) / 2n, outside);
        if (rep !== undefined) atoms.push({ n: rep, ip: fmt6(rep), range: [fmt6(lo), fmt6(hi)], primary: rep === primary });
      }
      atoms.sort((x, y) => (y.primary ? 1 : 0) - (x.primary ? 1 : 0) || cmpBig(x.n, y.n));
      return { list: atoms.slice(0, max), total: atoms.length, truncated: atoms.length > max };
    }
    /** LAN 側網段內的目的：這台設備 IPv6 規則的 dst-address 在網段內切出的區段，每段取一個不屬於設備的位址（略過網段的第一個位址：subnet-router anycast）。 */
    function targets6(dev, net) {
      const b = new Set([net.lo, net.hi + 1n]);
      m.firewallRules.forEach((r) => {
        if (r.family !== 'ipv6' || r.dev !== dev || r.table !== 'filter' || r.match['dst-address'] === undefined) return;
        const p = F.parseVal('dst-address', F.splitNeg(r.match['dst-address']).body);
        if (p.kind === 'ranges' && p.bits === 128) p.items.forEach(([x, y]) => { if (x > net.lo && x <= net.hi) b.add(x); if (y >= net.lo && y < net.hi) b.add(y + 1n); });
      });
      const arr = Array.from(b).sort(cmpBig); const owned = v6Facts().owned; const out = [];
      for (let i = 0; i + 1 < arr.length; i++) {
        const lo = arr[i]; const hi = arr[i + 1] - 1n;
        let rep = null;
        for (let n = lo === net.lo && hi > lo ? lo + 1n : lo, c = 0; n <= hi && c < 64; n++, c++) if (!owned.has(n)) { rep = n; break; }
        if (rep !== null) out.push({ n: rep, ip: fmt6(rep), range: [fmt6(lo), fmt6(hi)], whole: lo === net.lo && hi === net.hi });
      }
      return out;
    }
    const rc6 = (dev, d) => d.uncertain.map((u) => reason('rule-condition', dev, `${where(u.rule)}（IPv6）的條件 ${U.uniq(u.keys).join('、')} 無法判斷：${U.uniq(u.keys.map(keyWhy)).join('；')}`, { rule: ref(u.rule), keys: U.uniq(u.keys) }));
    /**
     * 一個 IPv6 組合的判斷：{ verdict, reasons, decisive（同 summary 的 decisive，給 rowFindings）, rule（決定的過濾規則或預設） }。
     * ICMP 的服務以 ICMPv6（protocol icmpv6）比對。input 放行之後再看 /ip service（停用或 available-from 不含來源就是拒絕）。
     */
    function eval6(dev, inEp, outEp, chain, svc, src, dst, noFw) {
      const ctx = I.ctxOf(dev);
      const pkt = { family: 'ipv6', reach: true, in: inEp, out: chain === 'input' ? null : outEp, protocol: svc.proto === 'icmp' ? 'icmpv6' : svc.proto, dstPort: svc.port, srcPort: null,
        src, dst, srcLocal: false, dstLocal: chain === 'input', state: 'new', natState: null, ipsec: devInfo(dev).ipsec ? null : 'none' };
      const decisive = new Map();
      const pick = (d, table, ch) => decisive.set(d.rule ? d.rule.key : `policy:${dev}|${table}|${ch}`, { key: d.rule ? d.rule.key : null, dev, table, chain: ch, policy: !d.rule, verdict: d.verdict });
      const out = (verdict, reasons, rule) => ({ verdict, reasons, decisive, rule });
      if (ctx.chain('ipv6', 'raw', 'prerouting').length) {
        const d = F.decide(ctx, 'ipv6', 'raw', 'prerouting', Object.assign({}, pkt, { out: undefined }));
        if (!d.decided) return out('unknown', rc6(dev, d), null);
        if (d.verdict === 'drop') { pick(d, 'raw', 'prerouting'); return out('deny', [], d.rule); }
        if (d.verdict === 'notrack') pkt.state = 'untracked';
      }
      const d = F.decide(ctx, 'ipv6', 'filter', chain, pkt);
      if (!d.decided) return out('unknown', rc6(dev, d), null);
      pick(d, 'filter', chain);
      if (d.verdict === 'drop') return out('deny', [], d.rule);
      const reasons = noFw ? [reason('no-ipv6-firewall', dev, `${name(dev)} 沒有 IPv6 的過濾規則（/ipv6 firewall filter），IPv6 的 ${chain} 預設放行`)] : [];
      if (chain === 'input' && svc.proto === 'tcp' && svc.port != null) {
        const sv = Q.ipServicesOf(dev).find((x) => x.port === svc.port);
        if (sv && !sv.enabled) return out('deny', [], d.rule);
        if (sv && sv.addresses.length) {
          const rs = sv.addresses.map((a) => F.parseVal('src-address', a));
          if (rs.some((p) => p.kind === 'ranges' && p.bits === 128 && p.items.some(([a, b]) => src >= a && src <= b))) return out('allow', reasons, d.rule);
          if (rs.every((p) => p.kind === 'ranges')) return out('deny', [], d.rule);
          return out('unknown', [reason('service-unknown', dev, `${name(dev)} 的 ${sv.name} 服務的 available-from（${sv.addresses.join('、')}）無法解析，是否接受 IPv6 來源無法判斷`)], d.rule);
        }
      }
      return out('allow', reasons, d.rule);
    }
    /**
     * 暴露清單的 IPv6 列：{ info（ipv6 欄）, self, routed（列與計數，併進同名的段）, evaluations, truncated }。
     * entries：WAN 入口；services：候選服務；budget：剩下的判斷次數。
     */
    function exposure6(entries, services, maxSrc, budget) {
      const used = ipv6Devices();
      const f = v6Facts();
      const fz = new Map((m.firewallZones || []).map((z) => [z.dev, z]));
      const sec = () => ({ rows: [], counts: { candidates: 0, allow: 0, unknown: 0, deny: 0, natted: 0, notEvaluated: 0 } });
      const res = { self: sec(), routed: sec(), evaluations: 0, truncated: false };
      const devs = U.uniq(entries.map((w) => w.dev)).sort(U.natural);
      const evaluated = []; const missing = [];
      const combos = new Map();
      for (const dev of devs) {
        const z = fz.get(dev);
        if (z && z.ipv6 && z.ipv6.status === 'disabled') { missing.push({ dev, reason: 'disabled' }); continue; }
        const own = f.addrs.filter((a) => a.dev === dev && !linkLocal6(a.n));
        if (!own.length) { if (z && z.ipv6 && z.ipv6.status === 'used') missing.push({ dev, reason: 'no-address' }); continue; }
        evaluated.push(dev);
        const wanEps = entries.filter((w) => w.dev === dev).map((w) => w.ep);
        const noFw = !m.firewallRules.some((r) => r.dev === dev && r.family === 'ipv6' && r.table === 'filter' && !r.disabled);
        const srcs = extSources6(dev, maxSrc);
        const selfIps = U.uniq(own.map((a) => a.n)).sort(cmpBig);
        const lans = own.filter((a) => !wanEps.includes(a.ep) && a.len < 128).filter((a, i, l) => l.findIndex((x) => x.prefix === a.prefix) === i);
        const jobs = selfIps.map((n) => ({ sec: 'self', n, ip: fmt6(n), chain: 'input', out: null }))
          .concat(lans.flatMap((a) => targets6(dev, a).map((t) => ({ sec: 'routed', n: t.n, ip: t.ip, chain: 'forward', out: a.ep, subnet: a.prefix, range: t.range, whole: t.whole }))));
        for (const j of jobs) {
          for (const svc of services) {
            const c = U.getOr(combos, [j.sec, dev, j.ip, svc.id].join('\u0000'), () => ({ dev, job: j, svc, srcs, noFw, evals: [] }));
            for (const ep of wanEps) {
              for (const a of srcs.list) {
                if (res.evaluations >= budget) { res.truncated = true; break; }
                res.evaluations++;
                c.evals.push(Object.assign({ src: a, ep }, eval6(dev, ep, j.out, j.chain, svc, a.n, j.n, noFw)));
              }
            }
          }
        }
      }
      combos.forEach((c) => {
        const s = res[c.job.sec];
        // 判斷次數上限用完、一次都沒有判斷到的組合：另計（notEvaluated），不算候選，也不算拒絕
        if (!c.evals.length) { s.counts.notEvaluated++; return; }
        s.counts.candidates++;
        const vs = c.evals.map((e) => e.verdict);
        const verdict = vs.includes('allow') ? 'allow' : vs.includes('unknown') ? 'unknown' : 'deny';
        s.counts[verdict]++;
        if (verdict === 'deny') return;
        const hit = c.evals.filter((e) => e.verdict === verdict);
        const ok = new Set(hit.map((e) => e.src.n));
        const okSrc = c.srcs.list.filter((x) => ok.has(x.n));
        const any = okSrc.length === c.srcs.list.length && !c.srcs.truncated;
        const allowedFrom = any ? { kind: 'any', ranges: [], text: '任何外部位址' }
          : { kind: 'limited', ranges: okSrc.map((x) => x.range.slice()), text: okSrc.map((x) => (x.range[0] === x.range[1] ? x.range[0] : `${x.range[0]}–${x.range[1]}`)).join('、') + (c.srcs.truncated ? '（外部區段超過上限，只列出前面的）' : '') };
        const first = hit.find((e) => e.src.primary) || hit[0];
        const ipSvc = c.job.sec === 'self' && c.svc.proto === 'tcp' ? Q.ipServicesOf(c.dev).find((x) => x.port === c.svc.port) : null;
        const mg = c.job.sec === 'self' ? mgmtPorts(c.dev).find((x) => x.proto === c.svc.proto && x.port === c.svc.port) : null;
        const ifc = Q.getInterface(first.ep);
        const r = first.rule;
        const rule = r ? Object.assign({ verdict: 'accept' }, ref(r)) : first.decisive.size ? { key: null, dev: c.dev, table: 'filter', chain: c.job.chain, policy: true, route: null, verdict: 'accept' } : null;
        const row = { family: 'ipv6', dev: c.dev, entries: U.uniq(hit.map((e) => e.ep)).sort(U.natural), entry: first.ep, inInterface: ifc ? ifc.name : K.splitEp(first.ep)[1], src: first.src.ip,
          dst: c.job.ip, ip: c.job.ip, vrf: K.MAIN_VRF, serviceName: ipSvc ? ipSvc.name : mg ? mg.name : null,
          // routed：決定的放行沒有限制目的位址（或預設放行）時，整個區段（沒有規則切開時就是整個網段）的主機都暴露
          dstAny: c.job.sec === 'routed' && (!r || (r.match['dst-address'] === undefined && r.match['dst-address-list'] === undefined)),
          findingKeys: rowFindings(c.dev, { decisive: first.decisive }, ipSvc ? ipSvc.name : null, mg),
          service: c.svc.id, proto: c.svc.proto, port: c.svc.port, portRange: c.svc.range, verdict, allowedFrom, rule,
          reasons: U.uniq(hit.flatMap((e) => e.reasons.map((x) => x.code))).sort(U.cmp), returnUnsafe: [], incomplete: verdict === 'allow' && vs.includes('unknown'),
          target: c.job.sec === 'self' ? c.dev : c.job.subnet, zone: c.job.sec === 'self' ? SELF_ZONE : null,
          // 分層結果：IPv6 不做路由（route 為 null），只有防火牆層；列只有允許與不明，沒有擋下的規則
          route: null, filter: { status: first.verdict, rule: null, reasons: dedupeReasons(first.reasons) } };
        if (c.job.sec === 'routed') Object.assign(row, { subnet: c.job.subnet, dstRange: c.job.range.slice() });
        s.rows.push({ row, n: c.job.n });
      });
      const note = '只看邊界路由器：從 WAN 進入時，以 IPv6 的過濾規則（/ipv6 firewall filter 的 input／forward）判斷能到設備本身與它直連的 LAN 側網段；不做 IPv6 路由與 NAT66';
      const name6 = (l) => l.map((x) => name(x.dev)).join('、');
      const noAddr = missing.filter((x) => x.reason === 'no-address');
      res.info = evaluated.length
        ? { status: 'edge-only', message: note + (noAddr.length ? `；${name6(noAddr)} 在用 IPv6，但基準中沒有它的 IPv6 位址（/ipv6 address），未判斷` : ''), devices: used, evaluated, missing }
        : { status: 'no-ipv6-address', message: `基準中沒有 WAN 入口設備的 IPv6 位址（/ipv6 address），無法判斷從 WAN 進來的 IPv6 能到哪裡${noAddr.length ? `（${name6(noAddr)} 在用 IPv6）` : ''}；${note}`, devices: used, evaluated, missing };
      return res;
    }
    const NAT_UNKNOWN = new Set(['nat-target', 'nat-ambiguous']);
    /** 預設的判斷次數上限（入口 × 外部區段 × 目的 × 服務）；超過時其餘組合不算，結果標 truncated。 */
    const EXPOSURE_MAX_EVALS = 400000;
    const EXPOSURE_MAX_SOURCES = 16;
    /**
     * 暴露清單的分段計算（generator，yield { stage: 'prepare'|'evaluate'|'summary', done, total }）；回傳值與 exposure(opts) 相同，並寫進快取。
     * opts：Q.zones 的參數，另加 maxEvaluations（判斷次數上限）、maxSources（外部區段數上限）。
     */
    function* exposureSteps(opts) {
      const o = opts || {};
      const zs = zones(o); zs.optsRaw = o;
      const maxEvals = o.maxEvaluations == null ? EXPOSURE_MAX_EVALS : o.maxEvaluations;
      const maxSrc = o.maxSources == null ? EXPOSURE_MAX_SOURCES : o.maxSources;
      if (!Number.isInteger(maxEvals) || maxEvals < 1) throw new TypeError('maxEvaluations 必須是正整數');
      if (!Number.isInteger(maxSrc) || maxSrc < 1) throw new TypeError('maxSources 必須是正整數');
      const ck = JSON.stringify([zs.opts.profHash, zs.opts.sources, maxEvals, maxSrc]);
      if (exposureCache.has(ck)) return exposureCache.get(ck);
      yield { stage: 'prepare', done: 0, total: 1 };
      bounds();
      const entries = l4Entries();
      // IPv6 只看邊界路由器（exposure6）；沒有 WAN 入口時不判斷
      const ipv6 = { status: 'no-wan', message: '沒有可辨識的 WAN 入口，IPv6 從 WAN 進來能到哪裡也無法判斷', devices: ipv6Devices(), evaluated: [], missing: [] };
      const emptySec = () => ({ rows: [], counts: { candidates: 0, allow: 0, unknown: 0, deny: 0, natted: 0, notEvaluated: 0 } });
      // 拒絕依層級分開（合計等於 denied 的同一段）：noRoute 路由沒到、filter 防火牆擋下（含 IPv6）、notNatted dst-nat 寫明的位址但這個服務沒有被改寫
      const emptyDenied = () => ({ noRoute: 0, filter: 0, notNatted: 0 });
      // noWan：有防火牆規則卻判斷不出 WAN 的設備（F08）；noFirewall：已收集、有預設路由（推論：可能是邊界路由器）卻沒有 /export 的網路設備
      const noWan = Q.findingsByRule('F08').map((f) => ({ dev: Q.findingDevice(f), findingKey: Q.findingKey(f) })).sort((a, b) => U.natural(a.dev || '', b.dev || ''));
      const noFirewall = Q.devices().filter((d) => devInfo(d.key).collected && !devInfo(d.key).host && !devInfo(d.key).config && Q.routesOf(d.key).some((r) => r.len === 0 && !r.blackhole))
        .map((d) => d.key).sort(U.natural);
      const base = { ok: true, noWan, noFirewall, wan: { entries: entries.map((w) => ({ dev: w.dev, ep: w.ep, vrf: w.vrf })), devices: U.uniq(entries.map((w) => w.dev)).sort(U.natural) }, ipv6, assumptions: EXPOSURE_ASSUMPTIONS };
      const extIp = entries.length ? externalRep() : null;
      const finishEarly = (status, message) => {
        const out = deepFreeze(JSON.parse(JSON.stringify(Object.assign({ status, message, external: null, services: [], self: emptySec(), dnat: emptySec(), routed: emptySec(),
          limits: { evaluations: 0, maxEvaluations: maxEvals, truncated: false }, denied: { self: 0, dnat: 0, routed: 0 },
          deniedBy: { self: emptyDenied(), dnat: emptyDenied(), routed: emptyDenied() } }, base))));
        exposureCache.set(ck, out); return out;
      };
      if (!entries.length) return finishEarly('no-wan', '沒有可辨識的對外入口：有 /export 的設備都沒有對外的介面（名稱含 WAN、成員不為空的 interface list，或預設路由、NAT 上網、連接埠轉送等強證據，見對外邊界），無法判斷從外部進得來什麼');
      if (!extIp) base.ipv6 = { status: 'not-evaluated', message: 'IPv4 的外部代表位址不可用，暴露清單沒有計算，IPv6 也沒有判斷', devices: ipv6.devices, evaluated: [], missing: [] };
      if (!extIp) return finishEarly('no-external-address', `外部的代表位址（${EXTERNAL_CANDIDATES.join('、')}）都在基準的網段內或屬於設備，無法代表基準以外的位址`);
      const entryDevs = new Set(entries.map((w) => w.dev));
      const srcsOf = new Map(Array.from(entryDevs).sort(U.natural).map((d) => [d, extSources(d, extIp, maxSrc)]));
      const services = exposureServices(entries);
      // 目的（各在入口的 VRF）：入口設備自己的位址與 dst-nat 寫明的 dst-address → self／dnat；內部網段的代表位址（矩陣的 repsOf） → routed
      // front：從外部看得到的入口位址（入口介面上的位址與 dst-nat 寫明的 dst-address；dst-nat 規則不分 VRF），dst-nat 只在這些位址列進 dnat；
      // 設備其他介面的位址只看 input（經 dst-nat 改寫的計入 natted，同一條 dst-nat 已在 dnat 以入口位址列出）。
      // self 段只有 main VRF 的入口（設備的服務在 main，見 l4Entries）：非 main 的入口只列 dnat
      const own = new Map(); const front = new Set();
      const devVrf = (d, v) => d + '\u0000' + v;
      U.uniq(entries.map((w) => devVrf(w.dev, w.vrf))).forEach((dv) => {
        const [d, v] = dv.split('\u0000');
        const list = [];
        const wanSet = new Set(entries.filter((w) => w.dev === d && w.vrf === v).map((w) => w.ep));
        Q.interfacesOf(d).forEach((i) => ownIps(i.key).forEach((a) => {
          if (K.vrf(a.vrf) !== v || !IP.isIp(a.ip)) return;
          if (!list.includes(a.ip)) list.push(a.ip);
          if (wanSet.has(i.key)) front.add(dv + '|' + a.ip);
        }));
        m.firewallRules.forEach((r) => {
          if (r.dev !== d || r.family !== 'ip' || r.table !== 'nat' || r.disabled || r.action !== 'dst-nat' || r.match['dst-address'] === undefined) return;
          const { neg, body } = F.splitNeg(r.match['dst-address']); const ip = neg ? null : single(body.replace(/\/32$/, ''));
          if (!ip) return;
          if (!list.includes(ip)) list.push(ip);
          front.add(dv + '|' + ip);
        });
        own.set(dv, list.sort((a, b) => intOf(a) - intOf(b)));
      });
      const repsByVrf = new Map(); repsOf(zs).forEach((list) => list.forEach((r) => U.getOr(repsByVrf, r.vrf, () => []).push(r)));
      repsByVrf.forEach((list) => list.sort((a, b) => intOf(a.ip) - intOf(b.ip)));
      const jobs = [];
      entries.forEach((w) => own.get(devVrf(w.dev, w.vrf)).forEach((ip) => jobs.push({ kind: 'edge', w, ip })));
      entries.forEach((w) => (repsByVrf.get(w.vrf) || []).forEach((r) => jobs.push({ kind: 'routed', w, ip: r.ip, rep: r })));
      const total = jobs.reduce((n, j) => n + srcsOf.get(j.w.dev).list.length, 0) * services.length;
      yield { stage: 'prepare', done: 1, total: 1 };
      // 每個（區段, 入口設備, 目的, 服務）一個組合，跨入口與外部區段合併
      const combos = new Map();
      const comboOf = (sec, dev, vrf, ip, svc, extra) => U.getOr(combos, [sec, dev, vrf, ip, svc.id].join('\u0000'), () => Object.assign({ sec, dev, vrf, ip, svc, evals: [] }, extra));
      let done = 0; let truncated = false;
      yield { stage: 'evaluate', done, total };
      const due = slicer();
      outer: for (const j of jobs) {
        for (const svc of services) {
          for (const a of srcsOf.get(j.w.dev).list) {
            if (done >= maxEvals) { truncated = true; break outer; }
            done++;
            const wv = j.w.vrf;
            const { b, sum } = evaluate(a.ip, j.ip, svc, 'exact', null, j.w.ep, wv);
            const reasons = sum.verdict === 'unknown' ? U.uniq(sum.reasons.map((x) => x.code)) : [];
            const ev = { src: a, ep: j.w.ep, verdict: sum.verdict, sum, b, reasons };
            if (j.kind === 'edge') {
              const natUnknown = reasons.some((c) => NAT_UNKNOWN.has(c));
              const isOwn = ownerDev(j.ip, wv) === j.w.dev;
              const isFront = front.has(devVrf(j.w.dev, wv) + '|' + j.ip);
              const selfOk = wv === K.MAIN_VRF;
              if ((sum.nat || natUnknown) && isFront) comboOf('dnat', j.w.dev, wv, j.ip, svc, {}).evals.push(ev);
              else if (sum.nat || natUnknown) { if (selfOk) comboOf('self', j.w.dev, wv, j.ip, svc, {}).evals.push(Object.assign(ev, { natted: true })); }
              else if (isOwn) { if (selfOk) comboOf('self', j.w.dev, wv, j.ip, svc, {}).evals.push(ev); }
              else comboOf('dnat', j.w.dev, wv, j.ip, svc, {}).evals.push(Object.assign(ev, { verdict: 'deny', forced: true })); // dst-nat 寫明的位址、這個服務沒有被改寫：不算進得來
            } else comboOf('routed', j.w.dev, j.w.vrf, j.ip, svc, { rep: j.rep }).evals.push(sum.nat || ev.reasons.some((c) => NAT_UNKNOWN.has(c)) ? Object.assign(ev, { natted: true }) : ev);
            if (due() && done < total) yield { stage: 'evaluate', done, total };
          }
        }
      }
      yield { stage: 'summary', done, total };
      const secs = { self: emptySec(), dnat: emptySec(), routed: emptySec() };
      const deniedBy = { self: emptyDenied(), dnat: emptyDenied(), routed: emptyDenied() };
      const fmt = (ip, pt) => ip + (pt != null ? ':' + pt : '');
      const ruleOf = (sum) => {
        const ds = Array.from(sum.decisive.values());
        const pick = ds.find((x) => x.key && x.table === 'filter') || ds.find((x) => x.key) || ds[0] || null;
        if (!pick) return null;
        return pick.key ? Object.assign({ verdict: pick.verdict }, ref(Q.getFirewallRule(pick.key))) : { key: null, dev: pick.dev, table: pick.table, chain: pick.chain, policy: !!pick.policy, route: pick.route || null, verdict: pick.verdict };
      };
      combos.forEach((c) => {
        const sec = secs[c.sec]; sec.counts.candidates++;
        // 經 dst-nat 改寫的組合（不是這一段的路徑）：只計數，結果在 dnat 段以入口位址列出
        const evs = c.evals.filter((e) => !e.natted);
        if (!evs.length) { sec.counts.natted++; return; }
        c.evals = evs;
        const vs = c.evals.map((e) => e.verdict);
        const verdict = vs.includes('allow') ? 'allow' : vs.includes('unknown') ? 'unknown' : 'deny';
        sec.counts[verdict]++;
        if (verdict === 'deny') {
          const real = c.evals.filter((e) => !e.forced);
          deniedBy[c.sec][!real.length ? 'notNatted' : real.every((e) => deniedByOf(e.sum) === 'noRoute') ? 'noRoute' : 'filter']++;
          return;
        }
        const hit = c.evals.filter((e) => e.verdict === verdict);
        // 允許的來源：每個外部區段在任一入口的結果；全部區段都允許（且沒有截斷）就是 any
        const bySrc = new Map(); c.evals.forEach((e) => { const k = e.src.ip; const v = bySrc.get(k); if (!v || e.verdict === 'allow' || (e.verdict === 'unknown' && v.verdict === 'deny')) bySrc.set(k, e); });
        const srcs = srcsOf.get(c.dev);
        const okSrc = srcs.list.filter((s) => bySrc.has(s.ip) && bySrc.get(s.ip).verdict === verdict);
        const any = okSrc.length === srcs.list.length && !srcs.truncated;
        const allowedFrom = any ? { kind: 'any', ranges: [], text: '任何外部位址' }
          : { kind: 'limited', ranges: okSrc.map((s) => s.range.slice()), text: okSrc.map((s) => (s.range[0] === s.range[1] ? s.range[0] : `${s.range[0]}–${s.range[1]}`)).join('、') + (srcs.truncated ? '（外部區段超過上限，只列出前面的）' : '') };
        const first = hit.find((e) => e.src.primary) || hit[0];
        const ipSvc = c.sec === 'self' && c.svc.proto === 'tcp' ? Q.ipServicesOf(c.dev).find((x) => x.port === c.svc.port) : null;
        const mg = c.sec === 'self' ? mgmtPorts(c.dev).find((x) => x.proto === c.svc.proto && x.port === c.svc.port) : null;
        const ifc = Q.getInterface(first.ep);
        const sum = first.sum;
        // 回程不保證（推論）：列的那一個判斷（first，與 Q.reach(src, ip, { entry }) 相同）路徑上的跳
        const unsafe = verdict === 'allow' ? unsafeOfSum(sum) : [];
        const row = { family: 'ipv4', dev: c.dev, entries: U.uniq(hit.map((e) => e.ep)).sort(U.natural), entry: first.ep, inInterface: ifc ? ifc.name : K.splitEp(first.ep)[1], src: first.src.ip,
          dst: K.inVrf(c.ip, c.vrf), ip: c.ip, vrf: c.vrf, serviceName: ipSvc ? ipSvc.name : mg ? mg.name : null, dstAny: false,
          findingKeys: rowFindings(c.dev, first.sum, ipSvc ? ipSvc.name : null, mg),
          service: c.svc.id, proto: c.svc.proto, port: c.svc.port, portRange: c.svc.range, verdict, allowedFrom, rule: ruleOf(sum),
          reasons: verdict === 'unknown' ? U.uniq(hit.flatMap((e) => e.reasons)).sort(U.cmp) : unsafe.length ? [unsafeReason(unsafe[0]).code] : [],
          returnUnsafe: unsafe.map((x) => ({ dev: x.dev, chain: x.chain, rule: x.rule, interfaces: x.interfaces ? x.interfaces.slice() : null })),
          incomplete: verdict === 'allow' && vs.includes('unknown') };
        // 分層結果（同 Q.reach(src, ip, { proto, port, entry }) 的 paths[] 彙整，rowLayers）：這一列的那一個判斷（first）
        Object.assign(row, rowLayers(first.verdict, pathsOf(first.b).paths));
        const fin = sum.final;
        const finIp = fin && fin.dst ? fin.dst : null; const finVrf = (fin && fin.vrf) || c.vrf;
        if (c.sec === 'self') { row.target = c.dev; row.zone = SELF_ZONE; }
        else {
          const tIp = c.sec === 'routed' ? c.ip : finIp;
          const z = tIp ? zoneOf(tIp, o, finVrf) : null;
          const od = tIp ? ownerDev(tIp, finVrf) : null;
          row.target = od && netDev(od) ? od : z ? z.key : null; row.zone = z ? z.zone : null;
          if (c.sec === 'dnat') {
            const natRule = Array.from(sum.decisive.values()).find((x) => x.key && x.table === 'nat');
            const nr = natRule ? Q.getFirewallRule(natRule.key) : null;
            row.nat = { from: fmt(c.ip, c.svc.port), to: finIp ? fmt(K.inVrf(finIp, finVrf), fin.port) : null, rule: nr ? ref(nr) : null };
            row.dstAny = !!nr && nr.match['dst-address'] === undefined && nr.match['dst-address-list'] === undefined; // dst-nat 沒限制目的位址：任何送到入口的目的都會改寫
          } else if (sum.nat) row.nat = { from: fmt(c.ip, c.svc.port), to: finIp ? fmt(K.inVrf(finIp, finVrf), fin.port) : null, rule: null };
          if (c.sec === 'routed') row.subnet = c.rep.subnet;
        }
        sec.rows.push(row);
      });
      // IPv6（只看邊界路由器）：列併進 self／routed（family 'ipv6'），判斷次數與 IPv4 共用上限
      // IPv6 不分 VRF（只看 main 的入口）
      const v6 = exposure6(entries.filter((w) => w.vrf === K.MAIN_VRF), services, maxSrc, Math.max(0, maxEvals - done));
      done += v6.evaluations; if (v6.truncated) truncated = true;
      base.ipv6 = v6.info;
      const n6 = new Map();
      ['self', 'routed'].forEach((k) => {
        v6[k].rows.forEach((x) => { n6.set(x.row, x.n); secs[k].rows.push(x.row); });
        Object.keys(v6[k].counts).forEach((c) => { secs[k].counts[c] += v6[k].counts[c]; });
        deniedBy[k].filter += v6[k].counts.deny; // IPv6 只看防火牆（不做 IPv6 路由）
      });
      const PO = new Map(services.map((s, i) => [s.id, i]));
      // 依入口設備 → 位址族（IPv4 在前）→ 位址 → 服務
      const byIp = (a, b) => (a.family !== b.family ? (a.family === 'ipv4' ? -1 : 1) : a.family === 'ipv4' ? intOf(a.ip) - intOf(b.ip) : cmpBig(n6.get(a), n6.get(b)));
      Object.values(secs).forEach((sec) => sec.rows.sort((a, b) => U.natural(a.dev, b.dev) || byIp(a, b) || PO.get(a.service) - PO.get(b.service)));
      if (exposureCache.has(ck)) return exposureCache.get(ck);
      const out = deepFreeze(JSON.parse(JSON.stringify(Object.assign({
        status: 'ok', message: null,
        external: { representative: extIp, byDevice: Array.from(srcsOf, ([dev, x]) => ({ dev, sources: x.list.map((s) => ({ ip: s.ip, range: s.range })), sourceCount: x.total, truncated: x.truncated })) },
        services, self: secs.self, dnat: secs.dnat, routed: secs.routed,
        limits: { evaluations: done, maxEvaluations: maxEvals, truncated },
        denied: { self: secs.self.counts.deny, dnat: secs.dnat.counts.deny, routed: secs.routed.counts.deny }, deniedBy,
      }, base))));
      exposureCache.set(ck, out);
      return out;
    }
    const exposure = (opts) => runAll(exposureSteps(opts));

    return { reach, zones: (o) => ({ zones: zones(o).zones, subnets: zones(o).subnets }), zoneOf, matrix, matrixSteps, cell, ruleImpact, exposure, exposureSteps };
  }

  // 靜態資訊（不依賴 Snapshot）：預設 service、zone 來源與可達性前提，畫面經 S.query.* 讀取
  if (S.query) {
    S.query.l4Services = () => SERVICES;
    S.query.zoneSources = () => ZONE_SOURCES;
    S.query.reachAssumptions = () => ASSUMPTIONS;
    /** Q.reach／Q.zoneMatrix／Q.zoneCell 會出現的原因與結束代碼（凍結的陣列 [{ code, kind: 'reason'|'end', layer: 'route'|'filter'|'nat'|'assumption', note }]），畫面用來確認中文對照涵蓋每個代碼。 */
    S.query.reachReasonCodes = () => REASON_CODES;
    /** 閘道推定的依據（Q.reach 的 start.basis 可能的值，凍結的陣列，依優先順序）：畫面用來確認每個依據都有中文名稱。 */
    S.query.reachStartBases = () => S.trace.START_BASES;
  }
})(globalThis.SSOT = globalThis.SSOT || {});
