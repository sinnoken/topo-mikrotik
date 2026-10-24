/*
 * 畫面小工具。所有文字一律以 textContent 寫入，不使用 innerHTML 插入資料（避免設備名稱夾帶 HTML）。
 */
(function (S) {
  'use strict';
  const V = (S.view = S.view || {});

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
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
      });
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

  V.KIND = S.KIND_LABEL;
  V.KIND_BASIS = { board: '依設備型號', data: '依收集的資料', caps: '依鄰居回報的功能', vendor: '依廠牌推測', heuristic: '依對端埠名推測', profile: '依命名規則', none: '無法判斷' };
  V.SEV = { error: '錯誤', warn: '警告', info: '提醒' };
  V.CLS = { lag: '聚合', '40g': '40G 以上', '10g': '10G', '1g': '1G', oob: '管理', other: '其他' };
  V.STATUS = { up: '連線', down: '中斷', unknown: '不明' };
  V.IFC_TYPE = { physical: '實體埠', lag: '聚合介面', bridge: 'Bridge', vlan: 'VLAN 介面', wireless: 'Wi-Fi', virtual: '虛擬介面', loopback: 'Loopback', other: '其他介面' };
  V.IFC_TYPE_BASIS = { rawType: '依 RouterOS 類型', member: '依聚合成員', name: '依介面名稱推測', default: '缺類型資料，預設為實體埠', assoc: '依 Wi-Fi 關聯表' };
  V.INFER_BASIS = { 'subnet-p2p': '/30／31 點對點網段', 'mndp-mutual': 'MNDP 雙向回報', 'mndp-unique': 'MNDP 唯一鄰居', fdb: 'MAC 表', stp: 'RSTP 指定橋接器' };
  V.CONFIDENCE = { high: '信心高（多重證據）', medium: '信心中（單一證據）' };
  V.WIFI_BASIS = { registration: '依關聯表（已確認）', 'bridge-wifi': '依 MAC 表的無線介面（推定）', 'via-ap-port': '經由 AP 所接的交換器埠（推定，無法區分有線或無線）' };
  V.MODE = { access: 'Access（untagged）', tagged: 'Tagged（trunk）' };
  // 拓樸圖的層級（App.layer）：L4 不是畫布，是疊在畫布上的 zone 矩陣與可達性（panels/l4.js）
  V.LAYER = { device: '設備', l2: 'L2 埠', l3: 'L3 子網', l4: 'L4 可達性' };
  // L4（M2）：格子狀態（Q.zoneMatrix 的 status）、可達性結果（Q.reach 的 verdict）、zone 的來源（Q.zones 的 source）
  V.L4_STATUS = { allow: '全通', deny: '全擋', partial: '部分', unknown: '不明', empty: '沒有組合' };
  V.L4_STATUS_TIP = {
    allow: '這一格算到的位址組合 × 服務全部允許',
    deny: '全部拒絕（被規則丟棄、沒有路由或黑洞路由）',
    partial: '有些允許、有些拒絕（不同的位址或服務結果不同）',
    unknown: '有無法判斷的組合（原因見提示與下鑽），沒有允許與拒絕同時出現',
    empty: '沒有可算的位址組合（例如目的 zone 只有設備自己的位址，或沒有可當代表的位址）；不是「不明」',
  };
  V.VERDICT = { allow: '允許', deny: '拒絕', unknown: '無法判斷' };
  V.ZONE_SOURCE = { profile: '命名規則', 'interface-list': 'interface list', vlan: 'VLAN', subnet: '網段' };
  // Q.reach 的原因代碼與結束代碼（src/query/trace.js 的 reason／end）；沒有對照的代碼原樣顯示並標「未翻譯」，不吞掉
  V.REACH_REASON = {
    'rule-condition': '規則的比對條件無法判斷', 'raw-notrack': 'raw 規則不追蹤連線（notrack），之後依連線狀態比對的規則結果不明',
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
  };
  // S.trace 的結束狀態（ends[].status）
  V.TRACE_END = {
    reached: '抵達', noroute: '沒有路由', blackhole: '黑洞路由', loop: '路由迴圈', ttl: 'TTL 用盡', 'unknown-nh': '下一跳不在基準內',
    policy: '策略路由不明', 'policy-drop': '策略路由丟棄',
  };
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
  /** 介面 VRF 的依據（interfaces[].vrfBasis，見 model/build.js 的 resolveVrfs）；export 是推論（export 不寫內建 main，假設 main 在最後） */
  V.IFC_VRF_BASIS = { reported: '設備回報的 vrf=', 'vrf-print': '依 /ip vrf print 的順序', export: '依 export 的 /ip vrf（推論：假設 main 在最後）', default: '沒有列在任何 VRF，屬於 main' };
  V.IFC_VRF_INFERRED = new Set(['export']);
  /** 下一跳解析閘道的 VRF 依據（routes[].nh[].vrfBasis） */
  V.NH_VRF_BASIS = { explicit: '閘道寫了 @<VRF>', 'vrf-interface': '閘道是 VRF 介面，在那個 VRF 再查一次', interface: '閘道介面所屬的 VRF', default: '只有 IP、沒寫 @，在 main 解析' };
  V.reachReason = (code) => V.REACH_REASON[code] || `${code}（未翻譯的原因代碼）`;
  V.REACH_START = { gateway: '來源網段的閘道', device: '來源是網路設備自己的位址（output）', 'same-subnet': '來源與目的在同一個網段', entry: '指定的入口介面', none: '找不到來源所在的網段' };
  V.REACH_START_BASIS = { dhcp: '依 DHCP 網路的閘道', routes: '依網段上有路由表的設備', subnet: '依網段上已收集的設備' };
  /** 十進位數字字串（可能超過 2^53，例如命中次數的位元組數）加上千分位；不是數字字串時原樣回傳 */
  V.bigNum = (s) => (/^\d+$/.test(String(s)) ? String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(s));
  // VLAN 承載（Q.vlanCarriers 的 status 與 reason）；oneSide、inferred 是推論
  V.VLAN_STATUS = { carry: '兩端都帶這個 VLAN', partial: '只有一端帶這個 VLAN（兩端都有 VLAN 資料，V01）', oneSide: '只有一端可確認帶這個 VLAN（推論）', inferred: '推論鏈路，已收集的各端都帶這個 VLAN（推論）' };
  V.VLAN_REASON = { unfiltered: '有一端在沒開 vlan-filtering 的 bridge 上，VLAN 原樣轉送、無法確認是否帶這個 VLAN', 'peer-uncollected': '對端設備沒有收集資料，無從得知是否帶這個 VLAN', 'peer-no-vlan-data': '對端設備沒有 VLAN 設定資料，無從得知是否帶這個 VLAN', hearsay: '鏈路只有單側觀察（對端沒有提供 LLDP），對端的 VLAN 無法對照' };
  // L2 埠圖的邊（Q.portGraph 的 evidence）與 L3 子網圖的邊（Q.subnetGraph 的 basis）
  V.PORT_EVIDENCE = { adjacency: 'LLDP／CDP 雙側介面鄰接', hearsay: '只有單側觀察（推論）', inferred: '推論鏈路（沒有 LLDP，推論）' };
  V.L3_BASIS = { address: '介面位址', neighbor: '鄰居回報的位址（推論）', mgmt: '管理 IP（推論，未列在介面位址）' };
  V.ifcState = (i) => (i.enabled === false ? '停用' : V.STATUS[i.status]);
  // 收集失敗（blocks[].failure、coverage[].failures[]）的原因
  V.FAILURE = { timeout: '逾時', 'exit-code': '指令失敗', connection: '連線失敗', other: '其他錯誤' };
  V.failureText = (f) => (V.FAILURE[f.reason] || f.reason) + (f.exitCode == null ? '' : `（結束碼 ${f.exitCode}）`);
  /** 覆蓋率的「有缺漏」：已收集的設備缺少應收集的資料，或有指令收集失敗（只有失敗、沒有缺少也算） */
  V.coverageGap = (row) => !!row.collected && (row.missing.length > 0 || (row.failures || []).length > 0);
  /** UTC ISO 時間 → 「2026-10-24 03:00:00 UTC」（收集時間是 UTC，不轉成本機時區） */
  V.fmtUtc = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$|Z$/, '') + ' UTC' : '');
  // 鄰居發現協定（LLDP／MNDP／CDP）；L3 鏈路沒有發現協定時退回 via（如 OSPF）
  V.protoText = (l) => ((l.protocols && l.protocols.length ? l.protocols : l.via) || []).map((p) => p.toUpperCase()).join('、');

  /**
   * 反引號標出的 RouterOS 指令與欄位（CATALOG 的 causes／action 的寫法）：切成 [{ text, code }]。
   * 沒有成對的反引號保留為一般文字，不吞掉。
   */
  V.codeParts = (s) => {
    const str = String(s); const out = []; const re = /`([^`]+)`/g; let at = 0; let m;
    while ((m = re.exec(str))) {
      if (m.index > at) out.push({ text: str.slice(at, m.index), code: false });
      out.push({ text: m[1], code: true }); at = re.lastIndex;
    }
    if (at < str.length) out.push({ text: str.slice(at), code: false });
    return out;
  };
  /** 同上，組成 DOM 節點：一般文字是文字節點，反引號內是 <code>（等寬字型），都以 textContent 寫入 */
  V.codeText = (s) => V.codeParts(s).map((p) => (p.code ? V.h('code', { class: 'mono' }, p.text) : p.text));

  V.chip = (text, cls, attrs) => V.h('span', Object.assign({ class: 'chip ' + (cls || '') }, attrs || {}), text);
  /** 可操作的 chip（篩選選項）：用 <button>，鍵盤可以聚焦與按 Enter／空白鍵操作 */
  V.chipButton = (text, cls, attrs) => V.h('button', Object.assign({ type: 'button', class: 'chip ' + (cls || '') }, attrs || {}), text);
  V.kindChip = (k) => V.chip(V.KIND[k] || k, 'kind-' + k);
  V.sevDot = (s) => V.h('span', { class: 'sev ' + s, title: V.SEV[s] });
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
        onkeydown: activate ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } } : null,
      },
        cols.map((c) => V.h('td', { class: c.cls || null, style }, c.f(r)))));
    });
    const t = V.h('table', { class: 't' }, [V.h('thead', null, V.h('tr', null, cols.map((c, n) => V.h('th', c.s && o.onSort ? { class: 'sortable', title: '點一下排序', onclick: () => o.onSort(n) } : null, c.t + (o.sortBy === n ? (o.sortDir < 0 ? ' ▼' : ' ▲') : ''))))), tb]);
    if (o.limit && rows.length > o.limit) return V.h('div', null, [t, V.h('div', { class: 'muted table-more' }, `只顯示前 ${o.limit} 筆，共 ${V.num(rows.length)} 筆`)]);
    return t;
  }
})(globalThis.SSOT = globalThis.SSOT || {});
