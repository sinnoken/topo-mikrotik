/*
 * 畫面小工具。所有文字一律以 textContent 寫入，不使用 innerHTML 插入資料（避免設備名稱夾帶 HTML）。
 */
(function (S) {
  'use strict';
  const V = (S.view = S.view || {});

  /** 非 button 的可操作元素（role=button／link、可點的表格列）共用的鍵盤觸發：Enter 或空白鍵執行 fn（空白鍵不捲動頁面） */
  V.activateByKey = (fn) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
  /** h('div', {class:'x', onclick: fn}, [child, '文字']) */
  V.h = function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.entries(attrs).forEach(([k, v]) => {
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    if (tag === 'a' && attrs && String(attrs.class || '').split(/\s+/).includes('link') && !Object.prototype.hasOwnProperty.call(attrs, 'href')) {
      el.setAttribute('role', 'link'); el.setAttribute('tabindex', '0');
      el.addEventListener('keydown', V.activateByKey(() => el.click()));
    }
    (Array.isArray(children) ? children : children === undefined ? [] : [children]).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  };
  /** SVG 元素（圖表用）：與 h 相同的寫法，但以 SVG 命名空間建立，屬性一律 setAttribute */
  V.svg = function svg(tag, attrs, children) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, String(v));
    });
    (Array.isArray(children) ? children : children === undefined ? [] : [children]).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  };
  V.$ = (sel, root) => (root || document).querySelector(sel);
  V.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  /**
   * 畫面名詞的唯一來源：同一個概念全站只用一個詞。
   *   network：應收集的網路設備（覆蓋率的分母，同 Q.coverageSummary 的 network）；host：主機（定義見 V.HOST_DEF）。
   *   endpoint：終端（只學到一個 MAC、沒有 LLDP／CDP 鄰接的埠所接的東西）。link：拓樸上的邊；「連線」只用於防火牆的 TCP 連線與 SSH 連線。
   *   subnet：IP 網段（不說「子網」）。group：依鏈路自動分出的版面分群，不代表實體位置或 IP 網段（圖上的群名來自 Snapshot）。
   *   vlanDomain：同一個 VLAN ID 依鏈路證據分出的不相連部分（推論；不叫「區塊」，避免和指令區塊撞名）。
   *   hearsay：鏈路只有一端的資料（對端未收集，或收集了但沒有 LLDP／CDP 鄰居資料；build.js 的 pairing hearsay）；
   *     和 LLDP 單向（對端有鄰居資料但沒有回報這條鏈路，K01）是不同的事。
   *   inferred：推論的標示（V.inferChip）。
   */
  V.TERMS = Object.freeze({
    network: '網路設備', host: '主機', endpoint: '終端', link: '鏈路', subnet: '網段', group: '分群', vlanDomain: 'VLAN 片段',
    hearsay: '只有一端資料', inferred: '推論',
  });
  /** 主機的定義（與 S.check.expectsCollection 相同：沒有收集、依鄰居回報判斷為主機的設備不算應收集）：顯示選單、覆蓋率篩選與狀態卡共用這一句 */
  V.HOST_DEF = '沒有收集、依鄰居（LLDP／CDP／MNDP）回報判斷為主機的設備，不在收集範圍';
  /** 主機的一行說明（狀態卡）：「另有 N 台主機不在收集範圍（依 LLDP／CDP／MNDP 回報判斷）」，不括號套括號；完整定義放 title（V.HOST_DEF） */
  V.hostsText = (n) => `另有 ${V.num(n)} 台${V.TERMS.host}不在收集範圍（依 LLDP／CDP／MNDP 回報判斷）`;
  /**
   * 覆蓋率的缺漏（Q.coverageSummary 的結果）：「N 台缺資料、M 台未收集」，基準狀態卡與資料中心同一句。
   * 缺資料是已收集但缺少應收集的資料或有收集失敗（Q.coverageGap），未收集是只被鄰居發現的網路設備（C01）。
   */
  V.COVERAGE_GAP_TIP = { missing: '已收集，但缺少應收集的資料或有指令收集失敗', uncollected: '只被鄰居發現、沒有收集輸出的網路設備' };
  V.coverageGapParts = (cs) => [cs.missing ? `${V.num(cs.missing)} 台缺資料` : null,
    cs.network > cs.networkCollected ? `${V.num(cs.network - cs.networkCollected)} 台未收集` : null];
  V.coverageGapText = (cs) => { const p = V.coverageGapParts(cs).filter(Boolean); return p.length ? p.join('、') : `已收集的${V.TERMS.network}資料齊全`; };
  /** 鏈路只有一端資料（hearsay）的完整說法；「LLDP 單向」只用於對端有鄰居資料但沒回報（K01） */
  V.HEARSAY_TEXT = V.TERMS.hearsay + '（對端沒有鄰居資料）';
  V.ONE_WAY = 'LLDP 單向';
  V.ONE_WAY_TEXT = V.ONE_WAY + '（對端沒回報）';
  /** 推論標示：和收集到的事實並列的推定結果一律加這個 chip；依據放 title。 */
  V.inferChip = (tip) => V.chip(V.TERMS.inferred, 'info', tip ? { title: tip } : null);
  /** 多數決判定與多數不同的設備鍵（finding.deviation，推論）：不是多數決（或沒有 deviation）時 null，平手時空陣列。詳情、「研判」與圖上的虛線外圈共用；實作在 S.report */
  V.majorityDeviating = S.report.majorityDeviating;
  /** 與多數不同的標籤與平手的說法：詳情、「研判」（V.deviationLine）與匯出的 CSV 欄名、Markdown 共用；單一來源是 S.report */
  V.DEVIATION = S.report.DEVIATION;
  V.DEVIATION_LABEL = S.report.DEVIATION_LABEL;
  V.NO_MAJORITY = S.report.NO_MAJORITY;
  /**
   * 跨設備一致性檢查的多數決結果（finding.deviation，推論）：一律經這裡產生，詳情的每筆檢查結果共用。
   * 列出與多數不同的設備，點設備名選取該設備（不觸發外層的點選）。
   * 不是多數決的 deviation（或沒有）時為 null。沒有多數（平手）時預設也是 null（詳情與「研判」一致，平手沒有可指出的設備，
   * 不多佔一行）；opts.tie 為 true 時才寫出「沒有多數，無法推定」。
   */
  V.deviationLine = function (App, dv, opts) {
    const devs = V.majorityDeviating(dv);
    if (!devs) return null;
    const label = V.DEVIATION_LABEL + '：';
    if (!devs.length) return opts && opts.tie === true ? V.h('div', { class: 'deviation none muted' }, label + V.NO_MAJORITY + '，無法推定') : null;
    const pick = (key) => (e) => { if (e && e.stopPropagation) e.stopPropagation(); App.select({ type: 'device', key }, { focus: true }); };
    // a.link 沒有 href 時 h() 已補 role、tabindex 與 Enter／空白鍵啟動
    const links = devs.map((key) => V.h('a', { class: 'link', 'data-dev': key, title: '選取這台設備', onclick: pick(key) }, App.Q.devLabel(key)));
    return V.h('div', { class: 'deviation' }, [label, ...links.flatMap((a, n) => (n ? ['、', a] : [a]))]);
  };
  V.KIND = S.KIND_LABEL;
  V.KIND_BASIS = { board: '依設備型號', data: '依收集的資料', caps: '依鄰居回報的功能', vendor: '依廠牌推測', heuristic: '依對端埠名推測', profile: '依命名規則', none: '無法判斷' };
  /** 嚴重度的顯示名稱（單一來源是 S.report.SEV_TEXT，匯出的報表共用） */
  V.SEV = S.report.SEV_TEXT;
  V.CLS = { lag: '聚合', '40g': '40G 以上', '10g': '10G', '1g': '1G', oob: '管理', other: '其他' };
  /** 介面狀態的顯示文字（單一來源是 S.report.IFC_STATUS_TEXT，網路文件共用） */
  V.STATUS = S.report.IFC_STATUS_TEXT;
  /** 廠商的顯示名（devices[].manufacturer、清單的廠商欄）：Snapshot 存小寫鍵，畫面用正式寫法；沒有對照的原樣顯示，空值回傳空字串 */
  V.VENDOR = { mikrotik: 'MikroTik', cisco: 'Cisco', ubiquiti: 'Ubiquiti', juniper: 'Juniper', aruba: 'Aruba', hpe: 'HPE', tplink: 'TP-Link', asus: 'ASUS' };
  V.vendorName = (m) => (m == null ? '' : V.VENDOR[String(m).toLowerCase()] || String(m));
  /**
   * 鄰居回報的功能（LLDP system-caps-enabled、CDP capabilities，devices[].caps 是逗號或空白分隔的原值）→ 中文，以「、」連接。
   * 沒有對照的項目原樣保留，不吞掉；原值要不要放 title 由呼叫端決定。
   */
  V.CAPS = {
    bridge: '橋接', router: '路由', 'wlan-ap': '無線基地台', station: '終端', 'station-only': '終端', repeater: '中繼器', telephone: '電話', phone: '電話',
    'docsis-cable-device': 'DOCSIS 纜線設備', other: '其他', 'c-vlan': 'C-VLAN', 's-vlan': 'S-VLAN', tpmr: 'TPMR', switch: '交換', host: '主機',
    'trans-bridge': '透通橋接', 'source-route-bridge': '來源路由橋接', igmp: 'IGMP',
  };
  V.capsText = (caps) => String(caps || '').split(/[,\s]+/).filter(Boolean).map((c) => V.CAPS[c.toLowerCase()] || c).join('、');
  V.IFC_TYPE = { physical: '實體埠', lag: '聚合介面', bridge: 'Bridge', vlan: 'VLAN 介面', wireless: 'Wi-Fi', virtual: '虛擬介面', loopback: 'Loopback', other: '其他介面' };
  V.IFC_TYPE_BASIS = { rawType: '依 RouterOS 類型', member: '依聚合成員', name: '依介面名稱推測', default: '缺類型資料，預設為實體埠', assoc: '依 Wi-Fi 關聯表' };
  V.INFER_BASIS = { 'subnet-p2p': '/30／31 點對點網段', 'mndp-mutual': 'MNDP 雙向回報', 'mndp-unique': 'MNDP 唯一鄰居', fdb: 'MAC 表', stp: 'RSTP 指定橋接器' };
  V.CONFIDENCE = { high: '信心高（多重證據）', medium: '信心中（單一證據）' };
  V.WIFI_BASIS = { registration: '依關聯表（已確認）', 'bridge-wifi': '依 MAC 表的無線介面（推定）', 'via-ap-port': '經由 AP 所接的交換器埠（推定，無法區分有線或無線）' };
  V.MODE = { access: 'Access（untagged）', tagged: 'Tagged（trunk）' };
  // 拓樸圖的層級（App.layer）：L4 不是畫布，是疊在畫布上的 zone 矩陣與可達性（panels/l4.js）
  V.LAYER = { device: '設備', l2: 'L2 埠', l3: 'L3 ' + V.TERMS.subnet, l4: 'L4 可達性' };
  /**
   * L4（M2）：格子狀態（Q.zoneMatrix 的 status）與可達性結果（Q.reach 的 verdict，allow／deny／unknown 是它的子集）共用同一組用語，
   * 筆數欄（允許 N・拒絕 N・無法判斷 N）也取自這裡；格子的「全部」由提示說明（L4_STATUS_TIP），不另用「全通／全擋」。
   */
  V.L4_STATUS = { allow: '允許', deny: '拒絕', partial: '部分允許', unknown: '無法判斷', empty: '沒有組合' };
  V.L4_STATUS_TIP = {
    allow: '算到的位址組合 × 服務中有允許、沒有拒絕（另有無法判斷的組合時標「部分無法判斷」）',
    deny: '全部拒絕（被規則丟棄、沒有路由、黑洞路由，或設備的管理服務不接受）',
    partial: '有些允許、有些拒絕（不同的位址或服務結果不同）',
    unknown: '沒有確定的允許，而且有無法判斷的組合（原因見提示與明細；無法判斷的可能是允許，所以不寫成拒絕）',
    empty: '沒有可算的位址組合（例如目的 zone 只有設備自己的位址，或沒有可當代表的位址）；不是「無法判斷」',
  };
  /** 格子有確定的允許，又有無法判斷的組合（Q.zoneMatrix 的 incomplete）：接在狀態後面，確定的允許不被「無法判斷」藏起來 */
  V.L4_INCOMPLETE = '部分無法判斷';
  /** 逐跳的規則結果（stages[].verdict）：中文在前、RouterOS 原值在括號；nat 沒有命中（none）是「不改寫」 */
  V.L4_VERDICT = { accept: '放行（accept）', drop: '丟棄（drop）', notrack: '不追蹤（notrack）', none: '不改寫' };
  /** 逐跳的連線追蹤狀態（hops[].conntrack） */
  /** 暴露清單的 IPv6：入口設備沒有判斷的原因（Q.exposure().ipv6.missing[].reason） */
  V.L4_IPV6_MISSING = { 'no-address': '基準沒有它的 IPv6 位址（/ipv6 address）', disabled: 'IPv6 停用' };
  V.L4_CONNTRACK = { untracked: '不追蹤連線（untracked）：之後的規則以 connection-state=untracked 比對，不套用 NAT' };
  /** 檢查目錄（S.query.rule）的類別與標題；目錄沒有的代碼（不應發生）不吞掉，歸在 UNKNOWN_RULE_CAT、標題原樣寫代碼。「研判」與修正計畫共用 */
  V.UNKNOWN_RULE_CAT = '未登錄的檢查';
  V.ruleInfo = (id) => S.query.rule(id) || { id, cat: V.UNKNOWN_RULE_CAT, title: id };
  // zone 的來源（Q.zones 的 source）
  V.ZONE_SOURCE = { profile: '命名規則', 'interface-list': '介面清單', vlan: 'VLAN', subnet: '網段', virtual: '虛擬' };
  // Q.reach 的原因代碼與結束代碼（src/query/reach.js 的 reason／end）；沒有對照的代碼原樣顯示並標「沒有說明」，不吞掉
  V.REACH_REASON = {
    'rule-condition': '規則的比對條件無法判斷', 'raw-notrack': 'raw 規則是否不追蹤連線（notrack）無法判斷，追蹤與不追蹤的結果不同',
    'nat-ambiguous': '目的 NAT 可能由不同的規則改寫，改寫後的目的不明', 'nat-target': 'NAT 改寫後的位址或埠不明（範圍、無法解析或不支援的動作）',
    'no-firewall-data': '設備沒有設定資料（/export），防火牆規則不明', 'srcnat-ambiguous': '來源 NAT 可能由不同的規則改寫，之後的來源位址不明',
    'srcnat-address-unknown': '來源 NAT 改寫後的來源位址不明', 'branches-differ': '有多條路徑（ECMP 或多個閘道），結果不同，實際走哪一條無法判斷',
    'branch-limit': '路徑太多，只算了前面幾條', ttl: '超過跳數上限（TTL 用盡）', 'device-uncollected': '路徑上的設備沒有收集，不知道它的路由與防火牆',
    'no-route-data': '設備沒有路由表資料', 'no-route': '沒有符合的路由，封包被丟棄', blackhole: '黑洞路由，封包被丟棄', loop: '路由迴圈，封包到不了',
    'next-hop-outside': '下一跳不在基準內，之後的路徑無法判斷', 'dst-device-uncollected': '目的位址屬於沒有收集的設備，它自己的防火牆不明',
    'src-device-uncollected': '來源位址屬於沒有收集的設備', 'src-location-unknown': '找不到包含來源的網段，不知道封包從哪台設備進入',
    'no-gateway': '來源網段上沒有可當閘道的已收集設備', dropped: '被規則丟棄', local: '目的是設備自己的位址',
    host: '送達主機（主機本身的防火牆不在範圍內）', segment: '送達直連網段上的主機', 'same-subnet': '來源與目的在同一個網段，不經過路由器',
    'policy-routing': '策略路由（mangle 的 mark-routing、改過的 policy-rules，或無法判斷的 /routing rule 條件）使查哪一張路由表不明',
    'policy-drop': '/routing rule 的 drop 或 unreachable，封包被丟棄',
    'service-refused': '防火牆放行，但設備的管理服務（/ip service）停用或不接受這個來源（available-from）',
    'service-unknown': '設備的管理服務（/ip service）是否接受這個來源無法判斷',
    'egress-wan': '從 WAN 介面送往基準以外的位址，之後由電信業者決定（推論）',
    'egress-possible': '出介面只有弱證據顯示可能對外（例如公網位址），無法確定是否送往外部',
    'hairpin-no-srcnat': '目的 NAT 後與來源同網段，但沒有來源 NAT（hairpin NAT），回應不經過路由器，連線通常建立不起來',
    'return-not-guaranteed': '回程不保證：路徑經過的設備沒有放行已建立的連線（established），回應封包可能被丟棄（F15）',
    'no-ipv6-firewall': '這台設備沒有 IPv6 防火牆規則，IPv6 預設放行',
  };
  // S.trace 的結束狀態（ends[].status）
  V.TRACE_END = {
    reached: '抵達', noroute: '沒有路由', blackhole: '黑洞路由', loop: '路由迴圈', ttl: 'TTL 用盡', 'unknown-nh': '下一跳不在基準內',
    policy: '策略路由不明', 'policy-drop': '策略路由丟棄', unverified: '無法驗證', egress: '送往外部（推論）',
  };
  /**
   * 例外 → 給使用者看的中文原因（畫面上所有錯誤訊息的單一來源）。核心與命名規則丟出的錯誤本來就是中文，原樣使用；
   * JSON 解析錯誤說明檔案格式；其他（程式錯誤，英文訊息）改用中文說明，原訊息放在括號內，方便回報與追查。
   */
  const CJK = /[㐀-鿿]/;
  V.reason = (e) => {
    const msg = (e && e.message) || String(e);
    if (e instanceof SyntaxError) return `檔案不是有效的 JSON（${msg}）`;
    if (CJK.test(msg)) return msg;
    return `程式發生未預期的錯誤，請重新整理頁面後再試一次；若仍發生，請回報這段訊息：${msg}`;
  };
  /**
   * 寫入剪貼簿：成功回傳 null，失敗回傳中文原因（瀏覽器不支援或拒絕；原例外寫 console.error），由呼叫端告知改用手動選取（不靜默失敗）。
   * 輸入對話框（狀態列）與面板（banner：V.copyToBanner）共用。
   */
  V.copyText = async (text) => {
    const c = globalThis.navigator && globalThis.navigator.clipboard;
    if (!c || !c.writeText) return '這個瀏覽器不支援自動複製';
    try { await c.writeText(text); return null; } catch (e) { console.error(e); return '瀏覽器拒絕存取剪貼簿'; }
  };
  /** 面板的「複製」按鈕：結果以 banner 告知；what 是複製的內容（例如「套用指令」、檔名） */
  V.copyToBanner = (text, what) => V.copyText(text).then((why) => (why
    ? V.app.banner(`無法複製（${why}）；請選取文字後手動複製。`, 6000)
    : V.app.banner(`已複製${what}；執行前請逐行核對。`, 3000)));
  /** 來源檔名的顯示：貼上的內容（核心常數 S.readers.PASTE，半形括號）在畫面上用全形括號；其餘原樣 */
  V.fileName = (name) => (name === S.readers.PASTE ? '（貼上的內容）' : name);
  /**
   * 來源（[[block, line]] 的第一筆）的原文連結「檔名 第 N 行」；opts.short 時只寫「第 N 行」（防火牆表格內，檔案不言自明）。
   * 沒有來源時為空字串。點擊不往外層傳（表格列、可點的卡片）。詳細資料與防火牆共用。
   */
  V.srcLink = (App, src, opts) => {
    const x = src && src[0]; const b = x && App.Q.block(x[0]);
    if (!b) return '';
    return V.h('a', { class: 'link mono', onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); App.openRaw(b.file, x[1]); } },
      (opts && opts.short ? '' : V.fileName(b.file) + ' ') + `第 ${x[1]} 行`);
  };
  /** 輸入區塊的位置「設備 › 指令」（blk 是 Q.block／Q.blockAt 的結果）：原文對話框標題與詳情的來源列共用同一寫法 */
  V.blockWhere = (Q, blk) => `${blk.devKey ? Q.devName(blk.devKey) : blk.device || V.fileName(blk.file)} › ${blk.command || '（未標記指令）'}`;
  /**
   * 路由追蹤終點的分類（圖上節點顏色與詳情的結果列共用）：reached 抵達、unverified 停在未收集的設備（只是無法驗證，不是錯誤）、
   * external 經 WAN 送往基準以外（終點 egress、整體 external；之後由電信業者決定，推論，不是錯誤）、
   * 其餘狀態（沒有路由、迴圈、黑洞…）都是 bad。整體結果（S.trace 的 status：reached／external／unverified／unreachable）也用同一個函式分類。
   */
  const TRACE_EXTERNAL = new Set(['egress', 'external']);
  V.traceEndKind = (end) => (end.status === 'reached' ? 'reached' : end.status === 'unverified' ? 'unverified' : TRACE_EXTERNAL.has(end.status) ? 'external' : 'bad');
  /** 分類 → theme.mark 的鍵（圖上顏色）與 .hop 的 class（詳情）；送往外部沿用追蹤色（不新增顏色，詳情的圓點用 --info），靠文字「送往外部（推論）」區分 */
  V.TRACE_END_STYLE = { reached: { mark: 'trace', cls: 'end-reached' }, external: { mark: 'trace', cls: 'end-external' }, unverified: { mark: 'unverified', cls: 'end-unverified' }, bad: { mark: 'bad', cls: 'end-bad' } };
  /** 同一台設備有多個終點時取最差的一類（bad > unverified > external > reached）；沒有終點（只是中途經過）視為 reached */
  V.traceEndWorst = (ends) => ['bad', 'unverified', 'external'].find((k) => ends.some((e) => V.traceEndKind(e) === k)) || 'reached';
  /**
   * IP 的選取：{ type: 'ip', key: IP, vrf }。vrf 為 null 時不分 VRF（搜尋：列出所有 VRF 的結果），否則只看那個 VRF。
   * 從位址鍵（K.inVrf，例如檢查結果的實體、清單的列）建立時，沒有 @ 就是 main。
   */
  /**
   * VRF 選單（路由追蹤、L4 可達性查詢）：第一個選項「依來源位址決定」（值為空字串，不傳 vrf，由查詢層依來源位址決定），其餘是 Q.vrfs()。
   * value 不在清單中時回到第一個選項。
   */
  V.fillVrfSelect = (sel, vrfs, value) => {
    V.clear(sel);
    sel.appendChild(V.h('option', { value: '' }, '依來源位址決定'));
    vrfs.forEach((v) => sel.appendChild(V.h('option', { value: v }, V.vrfText(v))));
    sel.value = value && vrfs.includes(value) ? value : '';
  };
  V.ipSel = (key, vrf) => {
    if (vrf !== undefined) return { type: 'ip', key: String(key), vrf };
    const [ip, v] = S.keys.splitVrf(key); return { type: 'ip', key: ip, vrf: v };
  };
  /** VRF 標示：main 也寫出（「VRF main」），只在需要和其他 VRF 區分時呼叫 */
  V.vrfText = (v) => 'VRF ' + S.keys.vrf(v);
  /** 以 K.inVrf 組成的鍵（「位址@VRF」）給人看的寫法：「位址（VRF 名稱）」，main 不加（同 zone 名稱的寫法），畫面不外露 @ */
  V.inVrfText = (key) => { const [a, v] = S.keys.splitVrf(key); return v === S.keys.MAIN_VRF ? a : `${a}（${V.vrfText(v)}）`; };
  /** 介面 VRF 的依據（interfaces[].vrfBasis，見 model/build.js 的 resolveVrfs）；export 是推論（export 不寫內建 main，假設 main 在最後） */
  V.IFC_VRF_BASIS = { reported: '設備回報的 vrf=', 'vrf-print': '依 /ip vrf print 的順序', export: '依 export 的 /ip vrf（推論：假設 main 在最後）', default: '沒有列在任何 VRF，屬於 main' };
  V.IFC_VRF_INFERRED = new Set(['export']);
  /** 下一跳解析閘道的 VRF 依據（routes[].nh[].vrfBasis） */
  V.NH_VRF_BASIS = { explicit: '閘道寫了 @<VRF>', 'vrf-interface': '閘道是 VRF 介面，在那個 VRF 再查一次', interface: '閘道介面所屬的 VRF', default: '只有 IP、沒寫 @，在 main 解析' };
  V.reachReason = (code) => V.REACH_REASON[code] || `${code}（沒有說明的原因代碼）`;
  V.REACH_START = { gateway: '來源網段的閘道', device: '來源是網路設備自己的位址（output）', 'same-subnet': '來源與目的在同一個網段', entry: '指定的入口介面', none: '找不到來源所在的網段' };
  V.REACH_START_BASIS = { dhcp: '依 DHCP 網路的閘道', 'next-hop': '依網段上其他設備預設路由的下一跳', 'default-route': '依網段上有預設路由的設備', routes: '依網段上有路由表的設備', subnet: '依網段上已收集的設備' };
  /** 原因代碼的層級（S.query.reachReasonCodes() 的 layer）：顯示的順序就是鍵的順序 */
  V.REACH_LAYER = { route: '路由', filter: '防火牆', nat: 'NAT', assumption: '前提' };
  /** L4 分層結果：路由層（Q.reach paths[].route.status）與防火牆層（paths[].filter.status；路由沒到時 n/a） */
  V.ROUTE_STATUS = { reached: '抵達', 'no-route': '沒有路由', blackhole: '黑洞路由', 'policy-drop': '策略路由丟棄', loop: '路由迴圈', unknown: '不明' };
  V.FILTER_STATUS = { allow: '允許', deny: '拒絕', unknown: '無法判斷', 'n/a': '沒有判斷（路由沒到）' };
  /** 十進位數字字串（可能超過 2^53，例如命中次數的位元組數）加上千分位；不是數字字串時原樣回傳 */
  V.bigNum = (s) => (/^\d+$/.test(String(s)) ? String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(s));
  // VLAN 承載（Q.vlanCarriers 的 status 與 reason）；oneSide、inferred 是推論
  V.VLAN_STATUS = { carry: '兩端都帶這個 VLAN', partial: '只有一端帶這個 VLAN（兩端都有 VLAN 資料，V01）', oneSide: '至少一端無從得知是否帶這個 VLAN（推論）', inferred: '推論鏈路，已收集的各端都帶這個 VLAN（推論）' };
  V.VLAN_REASON = { unfiltered: '有一端在沒開 vlan-filtering 的 bridge 上，VLAN 原樣轉送、無法確認是否帶這個 VLAN', 'peer-uncollected': '對端設備沒有收集資料，無從得知是否帶這個 VLAN', 'peer-no-vlan-data': '對端設備沒有 VLAN 設定資料，無從得知是否帶這個 VLAN', hearsay: '鏈路' + V.HEARSAY_TEXT + '，對端的 VLAN 無法對照' };
  // L2 埠圖的邊（Q.portGraph 的 evidence）與 L3 網段圖的邊（Q.subnetGraph 的 basis）
  V.PORT_EVIDENCE = { adjacency: 'LLDP／CDP 雙側介面鄰接', hearsay: V.HEARSAY_TEXT + '（推論）', inferred: '推論鏈路（沒有 LLDP，推論）' };
  V.L3_BASIS = { address: '介面位址', neighbor: '鄰居回報的位址（推論）', mgmt: '管理 IP（推論，未列在介面位址）' };
  // 對外邊界（Q.boundaries，推論，ADR-023）：狀態、證據的強弱與種類（evidence[].kind；名稱與檢查訊息的用語相同）
  V.BOUNDARY_STATUS = { external: '對外（推論）', possible: '可能對外（推論）', internal: '不算對外' };
  V.BOUNDARY_STRENGTH = { strong: '強', weak: '弱', none: '不算' };
  V.BOUNDARY_EVIDENCE = {
    'default-route': '預設路由的出介面', 'dhcp-client': 'DHCP client 加入的預設路由', 'pppoe-client': 'PPPoE client 加入的預設路由',
    'srcnat-out': 'srcnat 的出介面', 'dstnat-in': 'dst-nat 的入介面', 'wan-list': 'WAN 清單',
    'public-address': '公網位址', 'cgnat-address': 'CGNAT 位址', 'dstnat-address': 'dst-nat 的目的位址',
  };
  /** 證據不算的原因（evidence[].ref.reason） */
  V.BOUNDARY_REASON = { 'next-hop-in-baseline': '下一跳是基準內設備的位址（指向內部）', disabled: '已停用', 'disabled-unknown': '不知道是否停用', 'restricted-destination': '規則另限了目的位址（例如 hairpin NAT）', 'lan-list': '入介面是 LAN 清單的成員（從內部進來的轉送）' };
  V.boundaryEvidenceText = (k) => V.BOUNDARY_EVIDENCE[k] || `${k}（沒有說明的證據種類）`;
  V.ifcState = (i) => (i.enabled === false ? '停用' : V.STATUS[i.status]);
  // 收集失敗（blocks[].failure、coverage[].failures[]）的原因
  V.FAILURE = { timeout: '逾時', 'exit-code': '指令失敗', connection: '連線失敗', other: '其他錯誤' };
  V.failureText = (f) => (V.FAILURE[f.reason] || f.reason) + (f.exitCode == null ? '' : `（結束碼 ${f.exitCode}）`);
  /** UTC ISO 時間 → 「2026-10-24 03:00:00 UTC」（收集時間是 UTC，不轉成本機時區） */
  V.fmtUtc = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$|Z$/, '') + ' UTC' : '');
  // 鄰居發現協定（LLDP／MNDP／CDP）；L3 鏈路沒有發現協定時退回 via（如 OSPF）
  V.protoText = (l) => ((l.protocols && l.protocols.length ? l.protocols : l.via) || []).map((p) => p.toUpperCase()).join('、');
  /** MNDP 的鏈路（broadcast-domain）只證明 L2 可達：詳情的 chip 與表格共用這一句 */
  V.DOMAIN_TEXT = '同一 L2 廣播網域可達（MNDP，未確認直連）';
  /**
   * 鏈路的類別文字（詳情的鄰居表、鏈路表共用）：類別，加上確認狀態——雙向確認不寫、只有一端資料寫 V.TERMS.hearsay、
   * 其他寫「LLDP 單向」（與 K01 的名稱相同；K01 依 LLDP／CDP 的配對判定，只有 CDP 的鏈路也用這個名稱）。opt.proto：前面加協定
   */
  V.linkClassText = (l, opt) => {
    if (l.evidenceScope === S.LINK_SCOPE.BROADCAST_DOMAIN) return V.DOMAIN_TEXT;
    const state = l.verified ? '' : '・' + (l.hearsay ? V.TERMS.hearsay : V.ONE_WAY);
    return (opt && opt.proto ? V.protoText(l) + '・' : '') + V.CLS[l.cls] + state;
  };

  /**
   * 反引號標出的 RouterOS 指令與欄位（CATALOG 的 causes／action 的寫法）：切成 [{ text, code }]。
   * 沒有成對的反引號保留為一般文字，不吞掉。實作在 S.report（匯出的 Markdown 用同一個切法）。
   */
  V.codeParts = S.report.codeParts;
  /** 同上，組成 DOM 節點：一般文字是文字節點，反引號內是 <code>（等寬字型），都以 textContent 寫入 */
  V.codeText = (s) => V.codeParts(s).map((p) => (p.code ? V.h('code', { class: 'mono' }, p.text) : p.text));

  V.chip = (text, cls, attrs) => V.h('span', Object.assign({ class: 'chip ' + (cls || '') }, attrs || {}), text);
  /** 可操作的 chip（篩選選項）：用 <button>，鍵盤可以聚焦與按 Enter／空白鍵操作 */
  V.chipButton = (text, cls, attrs) => V.h('button', Object.assign({ type: 'button', class: 'chip ' + (cls || '') }, attrs || {}), text);
  V.kindChip = (k) => V.chip(V.KIND[k] || k, 'kind-' + k);
  /** 嚴重度標記（外形＋顏色）：輔助科技念出嚴重度名稱，不只靠顏色 */
  V.sevDot = (s) => V.h('span', { class: 'sev ' + s, title: V.SEV[s], role: 'img', 'aria-label': V.SEV[s] });
  V.fmtTime = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  V.num = (n) => Number(n).toLocaleString('zh-TW');

  /** 依欄位的 s(row) 排序：空值固定排最後；字串用 natural（IP 依數值順序），數字比大小。回傳新陣列。 */
  V.sortRows = function (rows, col, dir) {
    const val = (r) => { const v = col.s(r); return v == null || v === '' ? null : v; };
    return rows.slice().sort((a, b) => {
      const x = val(a); const y = val(b);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : SSOT.util.natural(String(x), String(y))) * dir;
    });
  };

  /**
   * 簡易表格：cols [{t:'標題', f:(row)=>內容, s?:(row)=>排序值}]，onRow(row) 可點擊。
   * 有 s 的欄位可點標頭排序；呼叫端不傳 onSort 時由表格自己儲存排序狀態（詳情表用），
   * 傳入 onSort／sortBy／sortDir 時由呼叫端管理（清單分頁需跨重繪保留）。
   * stack：窄螢幕時每一列排成一塊、每格前面寫欄名（assets/app.css 的 table.t.stack；表頭不顯示，欄位多、右邊的欄會被切掉的表格用）。
   */
  V.table = function (cols, rows, opt) {
    const o = opt || {};
    if (o.onSort || !cols.some((c) => c.s)) return renderTable(cols, rows, o);
    const box = V.h('div');
    const st = { by: -1, dir: 1 };
    const draw = () => {
      V.clear(box);
      const sorted = st.by >= 0 ? V.sortRows(rows, cols[st.by], st.dir) : rows;
      box.appendChild(renderTable(cols, sorted, Object.assign({}, o, {
        sortBy: st.by, sortDir: st.dir, onSort: (n) => { st.dir = st.by === n ? -st.dir : 1; st.by = n; draw(); },
      })));
    };
    draw();
    return box;
  };

  let sortFocus = null; // 剛按下排序的欄位標題（重繪後把焦點還給它）
  function renderTable(cols, rows, o) {
    const tb = V.h('tbody');
    rows.slice(0, o.limit || rows.length).forEach((r) => {
      const activate = o.onRow ? () => o.onRow(r) : null;
      // rowClass／rowStyle：呼叫端加的列樣式；顏色由呼叫端從 theme 取，套在每個儲存格（表格的底色畫在 td 上）
      const style = o.rowStyle ? o.rowStyle(r) : null;
      tb.appendChild(V.h('tr', {
        class: [activate ? 'click' : '', o.bad && o.bad(r) ? 'bad' : '', o.rowClass ? o.rowClass(r) || '' : ''].join(' '),
        onclick: activate,
        tabindex: activate ? '0' : null,
        onkeydown: activate ? V.activateByKey(activate) : null,
      },
        cols.map((c) => V.h('td', { class: c.cls || null, style, 'data-label': o.stack && typeof c.t === 'string' ? c.t : null }, c.f(r)))));
    });
    // 可排序的標頭：標頭內放 <button>（鍵盤可聚焦、Enter／空白鍵排序），th 標 aria-sort；▲▼ 只是視覺提示，不念出
    const head = (c, n) => {
      if (!(c.s && o.onSort)) return V.h('th', null, c.t);
      const on = o.sortBy === n;
      const btn = V.h('button', { type: 'button', class: 'th-sort', title: '點一下排序', onclick: () => { sortFocus = c.t; o.onSort(n); } },
        [c.t, on ? V.h('span', { 'aria-hidden': 'true' }, o.sortDir < 0 ? ' ▼' : ' ▲') : null]);
      // 排序後表格整個重繪：焦點回到同一欄的新按鈕（呼叫端同步插入表格後才移動焦點）
      if (sortFocus === c.t) { sortFocus = null; Promise.resolve().then(() => btn.focus()); }
      return V.h('th', { class: 'sortable', 'aria-sort': on ? (o.sortDir < 0 ? 'descending' : 'ascending') : 'none' },
        btn);
    };
    const t = V.h('table', { class: o.stack ? 't stack' : 't' }, [V.h('thead', null, V.h('tr', null, cols.map(head))), tb]);
    // 識別字（IP、MAC、VLAN 清單）在表格內不斷行，寬於畫面時表格在自己的框內橫向捲動
    const box = V.h('div', { class: 'table-scroll' }, t);
    if (o.limit && rows.length > o.limit) return V.h('div', null, [box, V.h('div', { class: 'muted table-more' }, `只顯示前 ${o.limit} 筆，共 ${V.num(rows.length)} 筆`)]);
    return box;
  }
})(globalThis.SSOT = globalThis.SSOT || {});
