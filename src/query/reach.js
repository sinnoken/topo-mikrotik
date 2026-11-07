/*
 * L4 可達性與 zone 矩陣（M2，查詢層，只讀 Snapshot）：S.reach.engine，由 Q.reach／Q.zones／Q.zoneMatrix／Q.zoneCell／Q.ruleImpact 呼叫。
 *  - 走法以 L3 為唯一來源（ADR-023 決策 3）：起點、逐跳、迴圈、TTL、送往外部都是 src/query/trace.js 的 S.trace.walker（與 S.trace 共用），
 *    這裡只以 hooks 在每一跳依 RouterOS 的處理順序套用 raw、nat（dst-nat 改寫目的後由 walker 重新查路由）、filter、srcnat 與 /ip service，規則語意全部用 S.infer.fw.decide。
 *  - 結果分層（決策 4）：Q.reach 的每條路徑另有 route（路由層）與 filter（防火牆層）；矩陣與暴露清單的拒絕分成路由沒到與防火牆擋下。
 *  - 結果是推論，不寫進 Snapshot（ADR-014）；同一份基準與參數一定得到相同結果，快取只在記憶體。
 *  - 無法判斷就回傳 unknown 並列出原因，不猜（見 REASON_CODES）。
 * 引擎分成五個檔案（依序載入，tools/core-files.js）：
 *   reach.js（本檔）：常數、S.reach、engine 的共用部分（base：位址等價類、每一關的判斷 stage、對外入口）、Q.reach 與 S.query.* 的靜態資訊；
 *   reach-eval.js：每一跳的 raw／nat／filter／service（walker 的 hooks）、摘要與分層結果；
 *   reach-zones.js：zone 與矩陣的代表位址、dst-nat 入口、虛擬 zone；
 *   reach-matrix.js：zone 矩陣、格子下鑽與規則影響；
 *   reach-exposure.js：暴露清單（含 IPv6）。
 * 跨檔只經 S.reach._（內部，不是對外介面）：常數與各部分的建構函式；每份基準一個 engine 物件 E，各部分依序把函式與快取加在 E 上。
 * 必須在 src/query/trace.js 之後載入。
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
  /*
   * 依層級排列（ADR-023 決策 5）：layer 'route'（路由層：查哪張路由表、走到哪裡）→ 'filter'（防火牆層：規則怎麼比對）→ 'assumption'（推論的假設）。
   * 文字依 2026-11-06 的唯讀稽核修正（與程式不符的 routeros-tables、policy-routing、untracked、ip-service、external、static-only），
   * 並補上漏寫的 conditions、address-list、return-path。Q.exposure 的兩條（EXPOSURE_ASSUMPTIONS）是推論的假設，接在最後。
   */
  /*
   * 前提分層（L4 繼承 L3）：路由層的前提在 S.trace.ASSUMPTIONS（L3 路由追蹤與 L4 共用）；這裡的 ASSUMPTIONS 只有 L4 自己的防火牆層（filter）與推論假設（assumption）。
   * 每條 { code, layer, short（一句白話，括號外不出現參數名）, detail（完整說明）, message（同 detail，相容舊的讀法） }。
   * 文字裡的事實由程式常數產生，不手寫（tests/core/assumptions.js）：可判斷的條件取 S.infer.fw.CONDITIONS／IFC_CONDITIONS／NONDET（decide 用的同一份），
   * jump 層數取 S.infer.fw.MAX_JUMP，第一個封包取 S.infer.fw.FIRST_PACKET，外部區段上限取 EXPOSURE_MAX_SOURCES（Q.exposure 的 maxSources 預設）。
   */
  const F0 = S.infer.fw;
  const zhList = S.trace.zhList;
  const assume = (code, layer, short, detail) => ({ code, layer, short, detail, message: detail });
  /** 可判斷的條件在文字中的分組（每個 S.infer.fw.CONDITIONS／IFC_CONDITIONS 的鍵恰好在一組，或屬於 src-port 前提；載入時檢查）。 */
  const CONDITION_GROUPS = deepFreeze([
    { label: '協定、目的埠、埠', keys: ['protocol', 'dst-port', 'port'] },
    { label: '來源與目的位址', keys: ['src-address', 'dst-address'] },
    { label: '位址類型', keys: ['src-address-type', 'dst-address-type'], note: ' 的 local／unicast／broadcast／multicast' },
    { label: '連線狀態與位址轉換狀態', keys: ['connection-state', 'connection-nat-state'] },
    { label: '傳輸旗標與控制訊息類型', keys: ['tcp-flags', 'icmp-options'], note: '，依第一個封包' },
    { label: '加密通道', keys: ['ipsec-policy'], note: '；設備沒有啟用中的 IPsec policy 時，視為不是加密通道的封包' },
    { label: '入介面與出介面', keys: F0.IFC_CONDITIONS.slice(), note: '；清單無法展開或介面不明時不明' },
  ]);
  /** 比對來源埠的條件（src-port 前提；Q.reach 的封包沒有來源埠）。 */
  const SRC_PORT_KEYS = Object.freeze(['src-port', 'port']);
  /** 依封包標記比對的條件（mangle 不在模型中；routeros-tables 前提）。 */
  const MARK_KEYS = Object.freeze(['packet-mark', 'connection-mark', 'routing-mark']);
  /** 文字中舉例的「其他條件」（S.infer.fw.condKind 都是 'other'，載入時檢查）。 */
  const OTHER_EXAMPLES = Object.freeze(['time', 'layer7-protocol', 'content', 'src-mac-address', 'in-bridge-port', 'ttl', 'packet-size', 'dscp', 'tls-host', 'hotspot']);
  (() => {
    const grouped = CONDITION_GROUPS.flatMap((g) => g.keys);
    const need = F0.CONDITIONS.concat(F0.IFC_CONDITIONS);
    const miss = need.filter((k) => !grouped.includes(k) && !SRC_PORT_KEYS.includes(k)); const extra = grouped.filter((k) => !need.includes(k));
    if (miss.length || extra.length) throw new Error(`判斷的前提（conditions）與 S.infer.fw 的可判斷條件不一致：缺 ${miss.join(',')}，多 ${extra.join(',')}（src/query/reach.js）`);
    const bad = OTHER_EXAMPLES.concat(MARK_KEYS).filter((k) => F0.condKind(k) !== 'other');
    if (bad.length) throw new Error(`判斷的前提舉例的條件 ${bad.join(',')} 不是無法判斷的條件（src/query/reach.js）`);
  })();
  /** 位址清單「可能有動態來源」的原因（S.infer.fw.ADDRESS_LIST_DYNAMIC，decide 用的同一份）在文字中的寫法；由規則寫入另附規則動作的原值。 */
  const AL_DYNAMIC = (source) => F0.ADDRESS_LIST_DYNAMIC.filter((x) => x.source === source)
    .map((x) => (x.code === 'rule' ? `${x.label}（${F0.ADDRESS_LIST_WRITE.join('、')}）` : x.label));
  /** Q.exposure 的外部區段數上限（maxSources 的預設；前提的文字也讀它）。 */
  const EXPOSURE_MAX_SOURCES = 16;
  const FP = F0.FIRST_PACKET;
  const ASSUMPTIONS = deepFreeze([
    // ---- 防火牆層
    assume('routeros-tables', 'filter', '只看原始表、位址轉換與過濾，用到標記的規則算不明',
      `只套用 RouterOS 防火牆的原始表、位址轉換與過濾（raw、nat、filter）；封包標記（mangle）只讀設定路由標記的規則，用來判斷策略路由（L3 路由追蹤的前提）；其他封包標記的動作、依標記比對的條件（${MARK_KEYS.join('、')}）、橋接過濾（bridge filter）、主機與服務本身的防火牆不在範圍內，用到標記的規則結果為不明`),
    assume('new-connection', 'filter', '只判斷新連線的第一個封包',
      `判斷的是新連線的第一個封包（connection-state=${FP.state}；TCP 只有 ${FP.tcpFlag.toUpperCase()} 旗標、ICMP 是回應請求 echo request，type ${FP.icmpType} code ${FP.icmpCode}）`),
    assume('conditions', 'filter', '時間、內容、限速等條件判斷不了，算不明',
      `可以判斷的比對條件：${CONDITION_GROUPS.map((g) => `${g.label}（${g.keys.join('、')}${g.note || ''}）`).join('、')}；`
      + `其他條件（例如 ${OTHER_EXAMPLES.join('、')}）與限速、隨機類比對（${Array.from(F0.NONDET).join('、')}）都是不明。`
      + `規則依匯出設定中新增的順序（/export 的 add），跳到其他規則鏈最多 ${F0.MAX_JUMP} 層（jump）`),
    assume('src-port', 'filter', '來源埠由用戶端自選，比對它的規則算不明',
      `來源埠由用戶端自選，比對來源埠的條件（${SRC_PORT_KEYS.join('、')}；port 符合目的埠時除外）無法判斷`),
    assume('address-list', 'filter', '只展開寫死的位址清單，可能有動態來源的算不明',
      `只展開匯出設定中寫死的位址清單（/ip firewall address-list、/ipv6 firewall address-list 的靜態項目，停用的項目不算），以它比對的規則（${F0.ADDRESS_LIST.join('、')}）依項目判斷；`
      + `含${AL_DYNAMIC('entry').join('、')}，或${AL_DYNAMIC('writer').join('、')}的清單算不明，匯出設定中沒有項目的清單也是不明`),
    assume('untracked', 'filter', '不追蹤連線的封包另外比對，也不做位址轉換',
      '原始表規則不追蹤連線（raw 的 notrack）時，這台設備之後的規則以連線狀態「不追蹤」（connection-state=untracked）比對，也不套用位址轉換（nat）；原始表的轉送前（prerouting）是否不追蹤無法判斷時，兩種情況都算，結果不同就是不明；設備自己送出時（raw 的 output）無法判斷就是不明'),
    assume('ip-service', 'filter', '目的是設備本身時，也看它的管理服務',
      '目的是網路設備本身時，除了輸入規則（input），也看設備的管理服務（/ip service）：服務停用或來源不在允許的位址內（available-from）一定是拒絕；其他情況下，服務所在的 VRF（vrf 參數）不在模型中，封包不在 main 時結果不明'),
    assume('static-only', 'filter', '只看匯出設定裡的規則，動態產生的不算',
      '只看匯出設定（/export）裡的規則；即插即用（UPnP、NAT-PMP）、熱點（hotspot）等功能產生的動態規則不在範圍內'),
    // ---- 推論的假設
    assume('external', 'assumption', '外部從判定對外的介面進出（推論）',
      '外部是基準以外的位址（推論）：從依路由證據判定的對外介面（對外邊界，ADR-023）進入；送往外部的封包從判定對外的介面送出、下一跳與目的都不在基準內時就算允許，之後由電信業者決定。只有弱證據、可能對外的介面不是入口，送往它是不明。代表位址見暴露清單的前提；矩陣取文件保留位址（TEST-NET）'),
    assume('return-path', 'assumption', '回程的路由與防火牆不檢查',
      '回程路徑不檢查：回應封包走的路由（非對稱路由）與回程上其他設備的防火牆不判斷；路徑上的設備若沒有保證放行已建立連線的封包，結果仍是允許、另標回程不保證（與 F15 同一份判斷，Q.policyBaseline 的 returnSafe）'),
  ]);
  /** 暴露清單另有的前提（只出現在 Q.exposure 的結果）。 */
  const EXPOSURE_ONLY = deepFreeze([
    assume('exposure-source-ranges', 'assumption', `外部來源依入口設備的規則切段，最多 ${EXPOSURE_MAX_SOURCES} 段`,
      `外部來源依入口設備的規則切成區段（src-address、展開的 src-address-list、/ip service 的 available-from、/routing rule 的 src-address）；經某個入口連到另一台網路設備本身時，另依那台目的設備的同樣規則切分；最多 ${EXPOSURE_MAX_SOURCES} 段；每段的代表位址先取文件保留位址（TEST-NET），區段內沒有時取區段內不屬於基準、也不是保留、本機迴路或群播的位址；路徑上其他經過的設備依來源位址比對的規則不再切分，所以允許的外部來源（allowedFrom）可能比實際寬`),
    assume('wan-member-no-interface', 'assumption', '沒有介面紀錄的對外清單成員也當入口',
      '名稱含對外字樣的介面清單成員沒有介面紀錄、只出現在位址與清單成員的設定時（/ip address、/interface list member），也當作入口（矩陣的外部與暴露清單相同），所在的 VRF 視為 main'),
  ]);
  /** Q.reach 結果的 assumptions：路由層（S.trace.ASSUMPTIONS）＋ L4 自己的（相容：結果仍列出完整的前提）。 */
  const REACH_ASSUMPTIONS = Object.freeze(S.trace.ASSUMPTIONS.concat(ASSUMPTIONS));
  /** Q.exposure 結果的 assumptions：REACH_ASSUMPTIONS ＋ 暴露清單另有的兩條。 */
  const EXPOSURE_ASSUMPTIONS = Object.freeze(REACH_ASSUMPTIONS.concat(EXPOSURE_ONLY));
  /** L4 的判斷方式（一句話，畫面頁尾用）。 */
  const DEFINITION = '路由沿用 L3 路由追蹤；在路徑上每台設備依 raw → nat → filter 判斷新連線的第一個封包，目的是設備本身時再看 /ip service；判斷不了的寫「?」並列出原因。';
  /**
   * Q.reach 的原因代碼與結束代碼（靜態清單，S.query.reachReasonCodes() 回傳）：
   *   kind 'end'：路徑結束的代碼（paths[].end.code；結果不是允許時也會出現在 reasons，拒絕時出現在決定結果的 route）
   *   kind 'reason'：只出現在 reasons／notes／hops[].reasons 的代碼
   *   layer：屬於哪一層（ADR-023 決策 4）——route（路由：起點、轉送決定、迴圈、送達）、filter（防火牆與 /ip service）、nat（位址轉換）、
   *     assumption（依推論的假設：送往外部之後由電信業者決定、回程是否放行）
   * 新增代碼時一定要加在這裡（reason／end 遇到不在清單的代碼會丟出錯誤，tests/core/reach.js 也會掃描引擎的五個檔案確認）。
   *   assumption：造成這個原因的前提 code（REASON_ASSUMPTION）；可能有多條時是陣列（實際是哪一條見 reasonAssumptions）；
   *     null 是由事實決定的結果（拒絕、送達）或資料不足（沒有收集、沒有 /export），不是前提造成的。
   */
  /** 原因代碼 → 前提（每個代碼都要列，沒有對應的寫 null；載入時檢查）。 */
  const REASON_ASSUMPTION = Object.freeze({
    'rule-condition': ['conditions', 'src-port', 'address-list', 'routeros-tables'], 'raw-notrack': 'untracked', 'no-firewall-data': null,
    'srcnat-ambiguous': 'conditions', 'srcnat-address-unknown': null, 'branches-differ': null, 'branch-limit': null,
    'nat-ambiguous': 'conditions', 'nat-target': null, loop: null, ttl: 'ipv4-vrf', 'device-uncollected': null, dropped: null, local: null,
    'no-route-data': null, 'route-data-incomplete': null, 'no-route': null, blackhole: null, 'next-hop-outside': null, 'dst-device-uncollected': null, host: 'routeros-tables', segment: null,
    'src-device-uncollected': null, 'src-location-unknown': null, 'same-subnet': 'bridge-ip-firewall', 'no-gateway': null,
    'policy-routing': ['policy-routing', 'mark-routing'], 'policy-drop': null, 'service-refused': null, 'service-unknown': 'ip-service',
    'egress-wan': 'external', 'egress-possible': 'external', 'hairpin-no-srcnat': null, 'return-not-guaranteed': 'return-path', 'no-ipv6-firewall': null,
  });
  const withAssumption = (list) => list.map((x) => {
    if (!Object.prototype.hasOwnProperty.call(REASON_ASSUMPTION, x.code)) throw new Error(`原因代碼 ${x.code} 沒有對應的前提（REASON_ASSUMPTION，src/query/reach.js）`);
    const a = REASON_ASSUMPTION[x.code];
    return Object.assign(x, { assumption: Array.isArray(a) ? a.slice() : a });
  });
  const REASON_CODES = deepFreeze(withAssumption([
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
    { code: 'route-data-incomplete', kind: 'end', layer: 'route', note: '設備的路由表收集不完整（收集失敗，例如逾時），收到的部分沒有符合的路由（不明）' },
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
  ]));
  const REASON_CODE_SET = new Set(REASON_CODES.map((x) => x.code));
  const REASON_LAYER = new Map(REASON_CODES.map((x) => [x.code, x.layer]));
  const checkCode = (code) => { if (!REASON_CODE_SET.has(code)) throw new Error(`原因代碼 ${code} 不在 REASON_CODES（src/query/reach.js）`); return code; };
  /** 無法判斷的條件鍵 → 原因。 */
  const KEY_WHY = {
    'src-address-list': 'address-list 可能有動態來源（DNS 名稱、逾時、動態項目或由規則等寫入），或 export 中沒有這份清單；export 沒有動態項目，不展開',
    'dst-address-list': 'address-list 可能有動態來源（DNS 名稱、逾時、動態項目或由規則等寫入），或 export 中沒有這份清單；export 沒有動態項目，不展開',
    'in-interface': '入介面不明（下一跳經遞迴路由解析）', 'out-interface': '出介面不明（路由沒有寫出介面）',
    'in-interface-list': 'interface list 無法展開（動態、內建或未定義的清單）', 'out-interface-list': 'interface list 無法展開（動態、內建或未定義的清單）',
    'src-port': '來源埠由用戶端自選', port: '來源埠由用戶端自選',
    'connection-mark': 'mangle 的標記不在範圍內', 'packet-mark': 'mangle 的標記不在範圍內', 'routing-mark': 'mangle 的標記不在範圍內',
    'ipsec-policy': '設備有啟用中的 IPsec policy，封包是否經 IPsec 不明', 'src-address': 'NAT 後的來源位址不明',
    'dst-address-type': '位址類型不明', 'src-address-type': '位址類型不明',
  };
  const keyWhy = (k) => KEY_WHY[k] || (S.infer.fw.NONDET.has(k) ? '依流量、速率或機率比對' : '這個條件不在可判斷的範圍');
  /**
   * 判斷不了的條件鍵 → 前提（rule-condition 依它對到前提；分類用 S.infer.fw.condKind，與 decide 同一份）：
   * 位址清單 → address-list；來源埠 → src-port；封包標記 → routeros-tables；其他（無法判斷的條件、依封包才判斷不了的條件與介面）→ conditions。
   */
  const keyAssumption = (k) => (F0.condKind(k) === 'address-list' ? 'address-list' : SRC_PORT_KEYS.includes(k) ? 'src-port' : MARK_KEYS.includes(k) ? 'routeros-tables' : 'conditions');
  /**
   * 一個原因實際對到的前提（陣列，依前提順序、不重複）：code 是 REASON_CODES 的代碼；
   * extra（選用）：原因本身（rule-condition 的 keys、policy-routing 的 assumption）。可能有多條、又沒有 extra 時回傳全部可能的。
   */
  const ALL_ASSUMPTION_CODES = Object.freeze(EXPOSURE_ASSUMPTIONS.map((a) => a.code));
  const assumptionOrder = (xs) => ALL_ASSUMPTION_CODES.filter((c) => xs.includes(c));
  function reasonAssumptions(code, extra) {
    if (!REASON_CODE_SET.has(code)) throw new TypeError(`原因代碼 ${JSON.stringify(code)} 不在 S.query.reachReasonCodes()`);
    const a = REASON_ASSUMPTION[code]; const x = extra || {};
    if (a === null) return Object.freeze([]);
    if (code === 'rule-condition' && Array.isArray(x.keys) && x.keys.length) return Object.freeze(assumptionOrder(x.keys.map(keyAssumption)));
    if (code === 'policy-routing' && typeof x.assumption === 'string') return Object.freeze([x.assumption]);
    return Object.freeze(assumptionOrder(Array.isArray(a) ? a : [a]));
  }
  /** 目的 NAT 的結果不明的結束代碼（分層結果與暴露清單共用）。 */
  const NAT_UNKNOWN = new Set(['nat-target', 'nat-ambiguous']);
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

  S.reach = {
    SERVICES, ZONE_SOURCES, ASSUMPTIONS, svcId,
    /** 每份基準一個（由 S.query 第一次呼叫 L4 函式時建立）；I：{ ctxOf(dev), addrSets() }（查詢層的防火牆比對環境與位址集合的登錄表 S.infer.addrSets）。 */
    engine: (Q, I) => makeEngine(Q, I),
    /**
     * 內部（只給 src/query/reach-*.js 用，不是對外介面）：常數，與各部分的建構函式（evalPart、zonesPart、matrixPart、exposurePart，
     * 由各檔案加上；每個都是 (E) => void，從 E 取用前面的部分建好的函式，再把自己的函式加在 E 上）。
     */
    _: {
      deepFreeze, MAX_PATHS, SERVICES, EXTERNAL_ZONE, SELF_ZONE, EXTERNAL_CANDIDATES, EXTERNAL6_CANDIDATES, svcId, ZONE_SOURCES, ASSUMPTIONS, EXPOSURE_ASSUMPTIONS, EXPOSURE_MAX_SOURCES,
      REASON_LAYER, checkCode, keyWhy, NAT_UNKNOWN, runAll, slicer,
    },
  };

  /** 依序建立各部分（後面的部分會用到前面的），回傳 Q 使用的成員。 */
  function makeEngine(Q, I) {
    const P = S.reach._;
    const E = base(Q, I);
    P.evalPart(E);
    reachPart(E);
    P.zonesPart(E);
    P.matrixPart(E);
    P.exposurePart(E);
    assumePart(E);
    const { reach, zones, zoneOf, matrix, matrixSteps, cell, ruleImpact, exposure, exposureSteps, assumptionUse } = E;
    return { reach, zones: (o) => ({ zones: zones(o).zones, subnets: zones(o).subnets }), zoneOf, matrix, matrixSteps, cell, ruleImpact, exposure, exposureSteps, assumptionUse };
  }

  /**
   * Q.assumptionUse：這份基準用得到哪些前提（推論，查詢時計算、依 Q 快取，Snapshot 不變）。判斷都用程式實際判斷時的同一份分類，不另寫規則語意：
   *   - 防火牆規則（啟用中、會導向結果的動作，同 S.infer.fw.decide）：條件鍵依 S.infer.fw.condKind 分類——位址清單 address-list（只算可能有動態來源或基準裡沒有的清單，ctx.addressList）、來源埠 src-port、
   *     封包標記 routeros-tables、無法判斷的條件 conditions（另含設備有啟用中 IPsec policy 時的 ipsec-policy、無法展開的介面清單，同 ctx.resolve）；
   *     raw 的 notrack 是 untracked。
   *   - 路由層：Q.policyOf（routeDecision 用的同一份）的 marks 是 mark-routing，rules 與改過的 policy-rules 是 policy-routing；
   *     有 bridge 與過濾規則的設備，橋接設定的 use-ip-firewall 沒有收集，bridge-ip-firewall 是 missing-data；在用 IPv6 的設備是 ipv4-vrf（只算 IPv4）。
   *   - 其他：非 main 的 VRF 是 ip-service；UPnP 啟用（Q.mgmtOf）是 static-only（熱點沒有解析，不列）；可能對外的邊界（Q.boundaries 的 possible）是 external；
   *     Q.policyBaseline 的 returnSafe 為 false 是 return-path；沒有介面紀錄的對外入口是 wan-member-no-interface。
   * status：'affects'（這份基準有用到）｜'missing-data'（判斷需要的資料沒有收集）｜'not-used'｜'always'（判斷方式本身，每份基準都適用）。
   * count：受影響的規則（防火牆規則、/routing rule、mark-routing）數；只依設備判斷的是設備數；unit 標出 count 數的是哪一種：'rules'｜'devices'｜null（count 為 0）。
   */
  const ALWAYS = new Set(['ipv4-vrf', 'routeros-tables', 'new-connection', 'ip-service', 'static-only', 'return-path']);
  const NEEDS_ENTRY = new Set(['external', 'exposure-source-ranges']);
  const LAYER_OF = new Map(EXPOSURE_ASSUMPTIONS.map((a) => [a.code, a.layer]));
  function assumePart(E) {
    const { Q, I, m, devInfo, l4Entries, ipv6Devices } = E;
    let memo = null;
    const decisive = (r) => r.action === 'jump' || r.action === 'return' || F0.TERMINAL.has(r.action) || (r.table === 'raw' && r.action === 'notrack');
    const TABLES = new Set(['raw', 'nat', 'filter']);
    /** 規則的條件鍵中，依程式的分類會判斷不了的前提（同 keyAssumption，但只列不依封包、在這份基準上一定判斷不了的）。 */
    const ruleAssumptions = (r) => {
      const ctx = I.ctxOf(r.dev); const out = [];
      Object.keys(r.match).forEach((k) => {
        const kind = F0.condKind(k);
        // 位址清單：只有可能有動態來源（或基準裡沒有）的清單判斷不了，同 decide 用的登錄表（S.infer.addrSets）
        const listUnknown = () => { const al = I.addrSets().ofRule(r, k); return !al || !al.static; };
        const unknown = (kind === 'address-list' && listUnknown()) || kind === 'nondet' || kind === 'other' || SRC_PORT_KEYS.includes(k)
          || (k === 'ipsec-policy' && devInfo(r.dev).ipsec)
          || (kind === 'interface' && k.endsWith('-list') && !!ctx && ctx.resolve(F0.splitNeg(r.match[k]).body) === null);
        if (unknown) out.push(keyAssumption(k));
      });
      return out;
    };
    function assumptionUse() {
      if (memo) return memo;
      const acc = new Map(ALL_ASSUMPTION_CODES.map((c) => [c, { devs: new Set(), rules: [], ruleSet: new Set(), items: 0, missing: false }]));
      const hit = (code, dev, ruleKey, items) => {
        const a = acc.get(code); a.devs.add(dev);
        if (ruleKey && !a.ruleSet.has(ruleKey)) { a.ruleSet.add(ruleKey); a.rules.push(ruleKey); }
        a.items += items || 0;
      };
      (m.firewallRules || []).forEach((r) => {
        if (r.disabled || !TABLES.has(r.table) || !decisive(r)) return;
        ruleAssumptions(r).forEach((c) => hit(c, r.dev, r.key));
        if (r.table === 'raw' && r.action === 'notrack') hit('untracked', r.dev, r.key);
      });
      (m.devices || []).forEach((d) => {
        const k = d.key;
        if (!d.collected) return;
        const pol = Q.policyOf(k);
        if (pol.marks.length) hit('mark-routing', k, null, pol.marks.length);
        if (pol.rules.length || pol.custom) hit('policy-routing', k, null, pol.rules.length + (pol.custom ? 1 : 0));
        if (!devInfo(k).config) return;
        // 有 bridge、也有啟用中的過濾規則（橋接流量走不走這些規則取決於 use-ip-firewall）
        if (Q.interfacesOf(k).some((i) => i.type === 'bridge') && Q.firewallRulesOf(k).some((r) => !r.disabled && r.table === 'filter')) { hit('bridge-ip-firewall', k); acc.get('bridge-ip-firewall').missing = true; }
        if (Q.vrfsOf(k).some((v) => !v.disabled && !v.builtin)) hit('ip-service', k);
        const mg = Q.mgmtOf(k); if (mg && mg.upnp && mg.upnp.enabled === true) hit('static-only', k);
        const pb = Q.policyBaseline(k); if (pb && pb.some((c) => c.returnSafe === false)) hit('return-path', k);
      });
      ipv6Devices().forEach((x) => hit('ipv4-vrf', x.dev));
      Q.boundaries().forEach((b) => { if (b.status === 'possible') hit('external', b.dev); });
      const entries = l4Entries();
      entries.forEach((w) => { if (!w.hasIfc) hit('wan-member-no-interface', w.dev); });
      memo = deepFreeze(ALL_ASSUMPTION_CODES.map((code) => {
        const a = acc.get(code); const devices = Array.from(a.devs).sort(U.natural);
        const status = a.missing ? 'missing-data' : devices.length ? 'affects'
          : NEEDS_ENTRY.has(code) ? (entries.length ? 'always' : 'not-used') : ALWAYS.has(code) ? 'always' : 'not-used';
        const nRules = a.rules.length + a.items;
        return { code, layer: LAYER_OF.get(code), status, devices, ruleKeys: a.rules.slice(), count: nRules || devices.length, unit: nRules ? 'rules' : devices.length ? 'devices' : null };
      }));
      return memo;
    }
    Object.assign(E, { assumptionUse });
  }

  /**
   * engine 物件 E 的共用部分：基準、設備資訊、規則參照、位址等價類、每一關（表＋chain）的判斷、NAT 用的位址、對外入口。
   * 位址等價類的邊界（bounds）算出後放在 E.ruleB（規則的位址邊界）與 E.repB（另加基準網段與 /ip service available-from 的邊界）；
   * available-from 不進 ruleB，節點鍵另以 afSig 區分（見 afIndex）。
   */
  function base(Q, I) {
    const E = { Q, I };
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
    // 邊界一律由位址集合的登錄表產生（S.infer.addrBounds：登錄的 set 的 bounds()）；新的位址來源在登錄表登錄後就會切開等價類
    let ruleB = null; let repB = null;
    const RULE_ADDR = Object.freeze(['src-address', 'dst-address', 'to-addresses'].concat(F.ADDRESS_LIST));
    const ROUTING_ADDR = Object.freeze(['src-address', 'dst-address']);
    const addBounds = (set, entries) => S.infer.addrBounds(entries, 32).forEach((b) => set.add(Number(b)));
    const sortedArr = (set) => Float64Array.from(Array.from(set).sort((a, b) => a - b));
    const bounds = () => {
      if (ruleB) return;
      const R = I.addrSets(); const es = [];
      // 規則的位址字面值、dst-nat 的 to-addresses 與展開的位址清單（完全靜態，同 decide）：清單項目的邊界也切開等價類，否則清單內外的位址會共用節點
      m.firewallRules.forEach((r) => { if (r.family === 'ip') RULE_ADDR.forEach((k) => es.push(R.ofRule(r, k))); });
      // /routing rule 的位址條件也切開等價類：同一個區段的位址，查哪一張表的結果相同
      (m.routingRules || []).forEach((r) => ROUTING_ADDR.forEach((k) => es.push(R.ofRoutingRule(r, k))));
      const rb = new Set([0]); addBounds(rb, es);
      const pb = new Set(rb);
      prefixes4().forEach((p) => { pb.add(p.lo); pb.add(p.hi + 1); });
      // 代表位址另依 /ip service 的 available-from 切開（同一個網段內只有部分位址被接受時，兩邊各有代表）
      addBounds(pb, afIndex().lists.map((x) => x.entry));
      ruleB = sortedArr(rb); repB = sortedArr(pb);
      E.ruleB = ruleB; E.repB = repB;
    };
    const findAtom = (arr, x) => { let lo = 0; let hi = arr.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid] <= x) lo = mid; else hi = mid - 1; } return lo; };
    const atomMemo = new Map();
    const ruleAtom = (ip) => U.getOr(atomMemo, ip, () => { bounds(); return findAtom(ruleB, IP.toInt(ip)); });
    /**
     * /ip service 的 available-from（啟用中、有 /export 的設備；停用的服務不看來源）：目的是設備本身時 localService（reach-eval.js）依實際來源判斷是否接受，
     * 等價類（ruleAtom）沒有這些邊界，同一個等價類的兩個來源會共用節點、得到錯的結果。
     * 不把它們加進 ruleB：每個站點各自的管理網段會把位址空間切碎，跨站點的來源就不能共用節點（1000 台時記憶體用盡）。
     * 改成節點鍵多一段（afSig）：來源在「這個封包可能用到的」available-from 清單內或外。可能用到的清單（afRelevant）：
     *   目的位址的擁有者（任何 VRF）在這個 tcp 埠的服務；基準裡有 dst-nat／redirect／netmap 時目的與埠可能改寫，改用全部的清單。
     * 節點的鍵已含目的與 service（trace.js 的 nk），所以同一個節點的可能清單固定，內外組合不會與別的目的混淆。
     */
    let afIdx = null;
    const DSTNAT_ACTIONS = new Set(['dst-nat', 'redirect', 'netmap']);
    const afIndex = () => {
      if (afIdx) return afIdx;
      const by = new Map(); const perDev = [];
      m.devices.forEach((d) => {
        if (!devInfo(d.key).config) return;
        Q.ipServicesOf(d.key).forEach((sv) => {
          if (!sv.enabled || !sv.addresses.length) return;
          const id = sv.addresses.slice().sort().join(',');
          // 內容相同的清單共用一筆；entry 是登錄表的 available-from（IPv4，同 reach-eval.js 的 serviceOf）
          if (!by.has(id)) by.set(id, { id, entry: I.addrSets().service(d.key, sv.name, 'ip') });
          perDev.push([d.key, sv.port, id]);
        });
      });
      const lists = Array.from(by.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const idxOf = new Map(lists.map((x, i) => [x.id, i]));
      const byDev = new Map();
      perDev.forEach(([dev, port, id]) => { const ps = level(byDev, dev); const l = U.getOr(ps, port, () => []); const i = idxOf.get(id); if (!l.includes(i)) l.push(i); });
      const owners = new Map();
      if (lists.length) m.ipAddresses.forEach((a) => { if (a.ip && IP.isIp(a.ip) && byDev.has(a.dev)) { const l = U.getOr(owners, a.ip, () => []); if (!l.includes(a.dev)) l.push(a.dev); } });
      const dstnat = m.firewallRules.some((r) => r.family === 'ip' && r.table === 'nat' && !r.disabled && DSTNAT_ACTIONS.has(r.action));
      afIdx = { lists, byDev, owners, all: Object.freeze(lists.map((x, i) => i)), dstnat };
      return afIdx;
    };
    const NO_LISTS = Object.freeze([]);
    const relMemo = new Map();
    /** 封包 st 可能用到的 available-from 清單（afIndex 的序號，由小到大）；沒有 st 時（呼叫端沒給）保守地用全部的清單。 */
    const afRelevant = (st) => {
      const x = afIndex();
      if (!x.lists.length) return NO_LISTS;
      if (!st) return x.all;
      if (st.proto !== 'tcp' || st.port == null) return NO_LISTS;
      if (x.dstnat) return x.all;
      const pm = level(relMemo, st.dst);
      let r = pm.get(st.port);
      if (!r) {
        const s = new Set();
        (x.owners.get(st.dst) || []).forEach((d) => (x.byDev.get(d).get(st.port) || []).forEach((i) => s.add(i)));
        r = s.size ? Object.freeze(Array.from(s).sort((a, b) => a - b)) : NO_LISTS;
        pm.set(st.port, r);
      }
      return r;
    };
    // 是否在清單內：登錄表的 set.has（與 reach-eval.js 的 serviceOf 同一份）
    const afSigMemo = new Map(); const afSigId = new Map();
    /** 來源 ip 在 rel 這些清單的內外組合的序號（0 是沒有清單；序號依遇到的順序，只當快取鍵用，不出現在結果裡）。 */
    const afSig = (ip, rel) => {
      if (!rel.length) return 0;
      const lv = level(afSigMemo, rel); let n = lv.get(ip);
      if (n === undefined) {
        const lists = afIndex().lists;
        const sig = rel.map((i) => (lists[i].entry.set.has(ip) ? '1' : '0')).join('');
        n = U.getOr(afSigId, sig, () => afSigId.size + 1);
        lv.set(ip, n);
      }
      return n;
    };
    /** 非網路設備來源的節點鍵（數字）：等價類 × available-from 的內外組合；乘數是等價類的個數（bounds 之後固定），不會碰撞。 */
    const atomKey = (ip, st) => { const a = ruleAtom(ip); return a + afSig(ip, afRelevant(st)) * (ruleB.length + 1); };

    /** 外部的代表位址（矩陣的外部 zone 與暴露清單共用）：EXTERNAL_CANDIDATES 中第一個不在 main 的基準網段、也不屬於任何設備的；都不行時 null。 */
    const externalRep = () => EXTERNAL_CANDIDATES.find((ip) => !longest(ip, K.MAIN_VRF) && !ownerOf(ip, K.MAIN_VRF)) || null;
    /**
     * 區段 [lo, hi] 的代表位址（外部來源切段用，IPv4 是數字、IPv6 是 BigInt）：依序試區段內的候選位址、區段的兩端與中點，取第一個 outside(n) 成立的；都不行時 undefined。
     */
    const repInRange = (lo, hi, cands, mid, outside) => cands.filter((n) => n >= lo && n <= hi).concat([lo, lo + (typeof lo === 'bigint' ? 1n : 1), mid, hi]).find((n) => n >= lo && n <= hi && outside(n));
    // ---- 每一關（表＋chain）的判斷：S.infer.fw.decide，依等價類快取
    const stageMemo = new Map();
    const hasRules = (ctx, table, chain) => ctx.chain('ip', table, chain).length > 0;
    // 節點的鍵：來源是網路設備的位址時用實際位址（之後的設備判斷 src-address-type=local 要用），否則用等價類＋available-from 的內外（afSig）。
    // st：這個節點的封包（決定可能用到的 available-from 清單；省略時用全部）
    const srcKey = (ip, vrf, st) => { if (ip == null) return 'n'; const d = ownerDev(ip, vrf); return d && netDev(d) ? 'o' + ip : 'a' + atomKey(ip, st); };
    const protoIdx = new Map();
    const svcNum = (st) => U.getOr(protoIdx, st.proto, () => protoIdx.size) * 65536 + (st.port || 0);
    const level = (map, k) => { let x = map.get(k); if (!x) { x = new Map(); map.set(k, x); } return x; };
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
          state: untracked ? 'untracked' : FP.state, natState, ipsec: devInfo(dev).ipsec ? null : 'none',
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

    // ---- NAT 改寫與設備自己的位址（逐跳、dst-nat 入口、虛擬 zone、規則影響與暴露清單共用）
    const single = (text) => { if (text === undefined) return undefined; const t = String(text).trim(); if (IP.isIp(t)) return t; const r = t.match(/^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$/); return r && r[1] === r[2] && IP.isIp(r[1]) ? r[1] : null; };
    const ownIps = (ep) => Q.ipsOf(ep).filter((a) => !a.hearsay && a.ip).map((a) => a);

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
    /** IPv6 在用（推論，firewallZones[].ipv6）的設備：矩陣只算 IPv4，畫面據此提示 IPv6 未納入（F05／F07）。 */
    const ipv6Devices = () => (m.firewallZones || []).filter((z) => z.ipv6 && z.ipv6.status === 'used').map((z) => ({ dev: z.dev, src: (z.ipv6.src || []).map((x) => x.slice()) })).sort((a, b) => U.natural(a.dev, b.dev));

    return Object.assign(E, {
      m, F, name, devOfEp, ownerOf, intOf, ownerDev, prefixes4, srcLocation, longest, realEp, devInfo, netDev, ref, where,
      bounds, findAtom, externalRep, repInRange, hasRules, srcKey, svcNum, level, stage, condReasons, reason, single, ownIps, l4Entries, ipv6Devices,
    });
  }

  // ---- Q.reach
  function reachPart(E) {
    const { Q, evaluate, skipOf, pathsOf, unsafeOfSum, unsafeReason, reason, ref, l4Entries } = E;
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
        paths: pathOut, assumptions: REACH_ASSUMPTIONS,
      })));
      reachCache.set(ck, out);
      return out;
    }
    Object.assign(E, { reach, normProto, normPort });
  }

  // 靜態資訊（不依賴 Snapshot）：預設 service、zone 來源與可達性前提，畫面經 S.query.* 讀取
  if (S.query) {
    S.query.l4Services = () => SERVICES;
    S.query.zoneSources = () => ZONE_SOURCES;
    /** L4 自己的前提（防火牆層與推論假設，凍結；路由層見 S.query.traceAssumptions）：[{ code, layer, short, detail, message }]。 */
    S.query.reachAssumptions = () => ASSUMPTIONS;
    /** 路由層的前提（L3 路由追蹤與 L4 共用，S.trace.ASSUMPTIONS）：形狀同 reachAssumptions。 */
    S.query.traceAssumptions = () => S.trace.ASSUMPTIONS;
    /** 暴露清單另有的前提（只出現在 Q.exposure 的 assumptions）：形狀同 reachAssumptions。 */
    S.query.exposureAssumptions = () => EXPOSURE_ONLY;
    /** L4 的判斷方式（一句話）。 */
    S.query.reachDefinition = () => DEFINITION;
    /** 一個原因實際對到的前提 code（凍結的陣列）：reasonAssumptions(code, reason?)；見 reach.js 的 reasonAssumptions。 */
    S.query.reasonAssumptions = (code, reason) => reasonAssumptions(code, reason);
    /** S.trace 的 ends[].status 對應的前提（凍結的陣列 [{ status, assumption, reasons? }]）。 */
    S.query.traceEndStatuses = () => S.trace.END_STATUSES;
    /** Q.reach／Q.zoneMatrix／Q.zoneCell 會出現的原因與結束代碼（凍結的陣列 [{ code, kind: 'reason'|'end', layer: 'route'|'filter'|'nat'|'assumption', note }]），畫面用來確認中文對照涵蓋每個代碼。 */
    S.query.reachReasonCodes = () => REASON_CODES;
    /** 閘道推定的依據（Q.reach 的 start.basis 可能的值，凍結的陣列，依優先順序）：畫面用來確認每個依據都有中文名稱。 */
    S.query.reachStartBases = () => S.trace.START_BASES;
  }
})(globalThis.SSOT = globalThis.SSOT || {});
