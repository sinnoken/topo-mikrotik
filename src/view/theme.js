/*
 * 檢視層視覺樣式的唯一來源（顏色、線型、透明度、字型）。
 * 只有常數：Canvas 繪圖與圖例都讀這裡，不得各自寫色值。
 * Canvas 讀不到 CSS 變數，所以 DOM 用的 :root 變數（assets/app.css）與這裡的設備類型色、嚴重度色、
 * 文字色、畫布底色與字型以測試比對，避免漂移。Snapshot 不含任何樣式。
 *
 * 配色規則（以 dataviz validate_palette.js 實測，亮色、底色 #f8fafc；暗色見下方的 DARK 覆寫表）：
 *  - 狀態色（sev、mark.bad／good）只表示狀態，且一律搭配外形或文字；類別色（設備、連線、廠商）不用紅、橘黃、綠。
 *  - 文字色（text.*）對其底色 ≥ 4.5:1；圖形標記對畫布底色 ≥ 3:1。
 *  - unknown、edge.other、vendorFallback 是刻意的中性色：代表「未分類／其他」，不做類別識別，所以不受彩度下限約束。
 */
(function (S) {
  'use strict';
  const V = (S.view = S.view || {});
  // 設備類型：任兩類都可能相鄰，以全部配對驗證（外形是第二編碼）
  const kind = { firewall: '#7b208e', switch: '#2795b5', router: '#335dcd', host: '#977af8', unknown: '#535d62' };
  // 狀態文字色：對白底、淺色狀態底與畫布底都 ≥ 4.5:1（與 app.css 的 --err-text 等一致，有測試）
  const text = { body: '#1f2933', muted: '#5f6d7e', err: '#b3261e', warn: '#8a5300', ok: '#17692f', info: '#315d8a' };
  // unverified：路由追蹤停在未收集的設備（無法驗證，不是錯誤），中性灰
  const mark = { select: '#0b6bcb', hover: '#1f2933', find: '#a44a88', trace: '#622fa6', bad: '#d93025', good: '#1e8e3e', unverified: '#687789' };
  const weakEdge = {
    hearsay: { alpha: 0.85, dash: [2, 3] },
    // 推論鏈路：沒有 LLDP 時由 MAC 表、MNDP、點對點網段推定相鄰（證據強於純 MNDP，弱於 LLDP）
    inferred: { alpha: 0.9, dash: [10, 3] },
  };
  // 圖例中只表達線型時用的中性線色；L2 埠與 L3 子網的外框也用它（中性色：埠、子網靠外形與文字區分，不佔類別色）
  const keyInk = '#4a5560';
  V.theme = {
    kind,
    // 設備節點外形；Canvas 繪圖與圖例共用
    shape: { firewall: 'shield', switch: 'wide', router: 'circle', host: 'square', unknown: 'circle' },
    // 連線：1G → 10G → 40G 是同一色相由淺到深的順序色階，線寬隨速率遞增；聚合最粗、管理線用虛線，其他為中性細線
    edge: {
      lag: { c: '#6e289c', w: 4.2 }, '40g': { c: '#085762', w: 3.4 }, '10g': { c: '#1e767f', w: 2.6 }, '1g': { c: '#3396a0', w: 1.8 },
      oob: { c: '#957bf9', w: 1.4, dash: [4, 3] }, other: { c: '#747b83', w: 1.2 },
    },
    // 同一對設備有多條鏈路：線加寬並在中間留一條底色細縫（看起來是雙線），不靠線寬猜速率
    multi: { widen: 1.7, gap: 0.34 },
    // 證據強度較弱的邊，鍵與 query devicePairs 的 evidence 相同：單側觀察（對端無 LLDP）、推論。只有 MNDP 的設備對不畫。
    // 只改線型與透明度，保留速率色
    weakEdge,
    // 嚴重度：顏色之外一律有外形（錯誤方形、警告三角形），節點右上角與連線中點共用
    sev: { error: '#d93025', warn: '#c27a00' },
    sevShape: { error: 'square', warn: 'triangle' },
    // 圖上的標示：選取（藍色實線環）、滑過（深色細環）、搜尋結果、路由追蹤（含箭頭）各用不同顏色；bad／good 是狀態
    mark,
    // VLAN 承載的高亮（鍵與 Q.vlanCarriers 的 status 相同；設備圖與 L2 埠圖共用）。只用既有的狀態色，另以線型與外形區分：
    //   carry 承載（實線）、inferred 推論鏈路承載（長虛線，同推論鏈路）、partial 只有一端帶（實線加垂直短刻度＋中點的錯誤外形）、
    //   oneSide 只有一端可確認（點線＋淡化，推論）
    // partial 與 carry 的紅綠在紅綠色盲下分不出來（validator 的 CVD 檢查不通過），所以 partial 另有專屬線型：
    // 沿線每 gap 一道垂直於線的短刻度（全長 len、粗 w）。其他線型都是沿線方向的虛線／點線／雙線，刻度不會和它們混淆。
    // 單位與 dash 相同：放大到 100% 以上隨縮放變大，縮小時維持螢幕上的大小
    vlan: {
      carry: { c: mark.good },
      inferred: { c: mark.good, dash: weakEdge.inferred.dash },
      partial: { c: mark.bad, sev: 'error', ticks: { gap: 8, len: 12, w: 2 } },
      oneSide: { c: mark.good, dash: [2, 4], alpha: 0.55 },
    },
    // L2 埠層級圖：設備是容器框（外框用設備類型色），埠是框邊上的小方塊；聚合埠較寬。未收集設備與推論鏈路未收集端的埠用虛線
    l2: {
      box: { fill: '#ffffff', radius: 6, labelH: 20, minW: 120, h: 46, portGap: 18, dash: [4, 3] },
      port: { size: 9, lagW: 16, fill: '#ffffff', stroke: keyInk, dash: [2, 2] },
    },
    // L3 子網圖：子網是圓角長條（中性外框、網段文字在內），只由路由得知的目的網段用虛線外框；
    // 位址邊用 edge.other，推論的位址邊（鄰居回報、管理 IP）用 weakEdge.hearsay；路由是虛線加箭頭；
    // 網段重疊是警告文字色的虛線，中點加警告外形；重疊與重複 IP 在子網下方另有文字標籤
    l3: {
      subnet: { fill: '#ffffff', stroke: keyInk, text: text.body, h: 26, minW: 70, routeDash: [4, 3] },
      route: { c: keyInk, w: 1.4, dash: [7, 4] },
      overlap: { c: text.warn, w: 1.6, dash: [3, 3], sev: 'warn' },
      badge: { bg: '#ffffff', text: text.warn, border: text.warn },
    },
    alpha: { dimEdge: 0.12, dimNode: 0.15, dimLabel: 0.25, overlay: 0.9 },
    text,
    // 字型清單與 app.css 的 --font-sans／--font-mono 同一串（有測試）：拉丁字型在前、繁中字型在後。
    // 畫布字級是螢幕 px：設備名稱 labelPx、分群名稱 groupPx、埠名 portPx（比設備名小，任何縮放都不會比設備名大）；
    // 節點內的小字在螢幕上小於 minPx 時不畫
    font: {
      sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      weight: { normal: 400, strong: 600 },
      labelPx: 13, groupPx: 13, portPx: 12, minPx: 11,
    },
    // 畫布上的中性色：底色（與 --surface 相同；每次繪圖先填滿，匯出 PNG 與多條鏈路的中縫也用它）、分群底框、標籤、埠名、節點描邊
    canvas: {
      surface: '#f8fafc',
      // 分群標籤畫在螢幕座標，底色 labelBg 蓋住底下的連線，文字對它 ≥ 4.5:1；滑過時顯示全名並加 stroke 外框。
      // stroke（對畫布底色約 1.3:1）刻意淡：群框只是版面的視覺分區（分群不代表實體位置），辨識靠標籤文字與詳情的群組 chip，
      // 不靠框線，屬裝飾性圖形，不受 1.4.11 的 3:1 約束；加深會和連線搶視線
      group: { fill: 'rgba(11,107,203,0.035)', stroke: 'rgba(11,107,203,0.18)', text: '#1f5a96', labelBg: 'rgba(248,250,252,0.92)' },
      // 與多數不同（跨設備一致性檢查依多數決推定與其他設備不同的那一台；是推論）：節點外再一圈虛線，
      // 比選取（mark.select 實線、外擴 6）與高亮（實線、外擴 5）更外圈，顏色與狀態色、選取、滑過、搜尋、追蹤都不同。tip 給圖例用（圖例的名稱用 V.DEVIATION_LABEL）
      deviation: { c: '#a21caf', w: 2.5, dash: [4, 3], gap: 10,
        tip: '跨設備一致性檢查依多數決推定與其他設備不同的設備；是推論，不代表一定是這台設錯' },
      label: { bg: 'rgba(255,255,255,0.88)', text: text.body, textUncollected: text.muted, maxEm: 14 },
      // 埠名標籤：border 是文字底塊的細邊（對畫布底色約 1.8:1），只是裝飾，可讀性由 text 對 bg 的對比負責（≥ 4.5:1）
      port: { bg: 'rgba(255,255,255,0.95)', border: 'rgba(120,130,140,0.5)', text: '#4a5560', maxEm: 12 },
      outline: '#ffffff', uncollectedFill: '#ffffff', sevFallback: '#7c8691',
      // 圖例中只表達線型（證據強度、介面類型）時用的中性線色
      keyInk,
    },
    endpoint: {
      // 廠商色最多 8 色（不用紅、橘黃、綠：避免和狀態混淆），依終端數量排前 8 的廠商；其餘歸「其他」用 vendorFallback
      vendor: ['#4a5ce0', '#94045d', '#6c20a9', '#a76ef8', '#235488', '#ea609c', '#3a95cd', '#975d8f'],
      vendorFallback: '#7c8691',
      // 依介面類型識別連到終端的連線（只標連線，節點外觀不變）：用不同線型，顏色維持連線類別色。
      // 鍵為 rawType（veth）或 type（wireless），用 styleOf 查
      byType: {
        veth: { dash: [12, 2, 2, 2, 2, 2], label: '容器 veth' },
        wireless: { dash: [7, 2, 2, 2], label: 'Wi-Fi' },
      },
      styleOf(i) { return this.byType[i.rawType] || this.byType[i.type] || null; },
      downstream: { fill: '#e8f5f8', stroke: '#1d6177', text: '#1d6177' },
      cluster: { fill: '#eceff1', stroke: '#6c7680', text: '#37474f' },
      dash: [3, 2],
    },
    // 防火牆規則畫面：動作文字色、停用規則的透明度、目前定位到的列
    firewall: {
      action: { accept: text.ok, drop: text.err, reject: text.err, tarpit: text.err, jump: text.info, return: text.muted, other: '#4a5560' },
      disabledAlpha: 0.5,
      focus: { bg: '#e6f0fb', border: '#0b6bcb' },
    },
    // 處理紀錄的改善趨勢圖（折線，SVG）：以 dataviz validate_palette.js 驗證（亮色、底色 #f8fafc，三色全部通過，最差 ΔE 18.4）。
    // 同一張圖的三條線另有外形（圓、方、三角）與線尾的名稱與數值，圖例與 tooltip 也畫出同樣的外形，不只靠顏色；
    // 只有一條線的圖（覆蓋率、未知對端）用 single。格線與座標軸用比底色深一階的中性色、1px 實線；文字一律用 text.*，不用資料色。
    // 線型：細線（lineWidth）、小標記（markerSize 是半徑，外圈 markerRing 是底色環）
    trend: {
      pending: '#335dcd', regressed: '#94045d', accepted: '#977af8', single: '#0b6bcb',
      marker: { pending: 'circle', regressed: 'square', accepted: 'triangle' },
      grid: '#e1e7ee', axis: '#cbd5df', crosshair: '#5f6d7e',
      lineWidth: 1.5, markerSize: 3, markerRing: 1.5,
    },
    // L4 zone 矩陣與可達性（panels/l4.js）：鍵與 Q.zoneMatrix 的格子 status、Q.reach 的 verdict 相同。
    // 狀態色只表示狀態，一律搭配外形符號（glyph）與文字標籤；格子的文字用 text.body（對每個格子底色 ≥ 4.5:1），
    // 符號用 mark（對格子底色與畫布底色 ≥ 3:1）。allow／deny 的 mark 以 dataviz validate_palette.js 驗證
    // （亮色、底色 #f8fafc：全部通過，最差 CVD ΔE 13.2（deutan）、一般視覺最差 28.5）。
    // partial（部分允許）是琥珀色（L4 審查的建議：色盲安全的琥珀色），亮 #c26e00／暗 #ffc247；
    // 和 allow／deny／unknown 的 mark 兩兩以 CIEDE2000 與 Machado 2009 的 CVD 模擬檢查（亮色最差 protan 11.0、deutan 11.1，
    // 暗色最差 tritan 10.0；一般視覺都 ≥ 26），琥珀和綠在紅綠色盲下最接近，所以仍一律有符號（✓／✕／◐）與文字。
    // unknown、empty 是刻意的中性色（「無法判斷」「沒有可算的組合」不是一種結果），不受彩度下限約束；
    // empty 另用斜線底紋（hatch），和 unknown 的實心灰底分開。
    // 異質（heterogeneous）是文字徽章；對角線（zone 內）是虛線外框（keyInk）
    l4: {
      status: {
        allow: { mark: '#20a050', bg: '#ebf7ee', glyph: '✓' },
        deny: { mark: '#a9221b', bg: '#fcecea', glyph: '✕' },
        partial: { mark: '#c26e00', bg: '#fdf2df', glyph: '◐' },
        unknown: { mark: '#5f6d7e', bg: '#eef1f4', glyph: '?' },
        empty: { mark: '#7c8691', bg: '#ffffff', glyph: '–', hatch: '#e1e7ee' },
      },
      text: text.body,
      badge: { bg: '#ffffff', text: text.body, border: keyInk },
      diagonal: { border: keyInk, dash: 'dashed' },
      focus: '#0b6bcb',
    },
    // 新舊基準比對：effect 的文字色（都另有文字標籤與外形）；new-exposure（新暴露）的列另加底色
    diff: {
      effect: { 'new-exposure': text.err, 'less-restrictive': text.warn, 'more-restrictive': text.ok },
      // effect 標籤前的外形，與嚴重度標記相同（DOM 的 .sev.error／warn／ok）
      effectSev: { 'new-exposure': 'error', 'less-restrictive': 'warn', 'more-restrictive': 'ok' },
      exposureBg: '#fdecea',
    },
  };
  V.EDGE_STYLE = V.theme.edge; V.KIND_COLOR = kind;

  // ---------------------------------------------------------------- 暗色覆寫表
  // 暗色＝亮色複本＋這張表：只寫要改的葉節點（陣列用索引當鍵），沒寫的沿用亮色。路徑寫錯或不是顏色時載入就丟錯。
  // 規則（與 app.css 的 :root[data-theme="dark"] 一致，有測試）：
  //  - 畫布底色 dSurface 等於深色的 --surface；亮色的白底（框、子網、徽章、未收集設備）改成深色的 --panel（dPanel）。
  //  - 文字對其底色 ≥ 4.5:1、圖形標記對畫布底色 ≥ 3:1（兩組都有測試）。
  //  - 連線速率色階反轉：亮色是越快越深，暗色是越快越亮（線寬編碼不變）。
  //  - 亮色中以參照共用的值（vlan.*.c ＝ mark.good／bad、l3.overlap 與 l3.badge ＝ text.warn、firewall.action 與 diff.effect ＝ text.*、
  //    l3.subnet.stroke 等 ＝ keyInk）在這裡也用同一個常數，兩組都相等（有測試）。
  //  - mark 的值互不相同（app-toolbar.js 依「舊值 → 新值」換算圖上存下的標示色）。
  const dSurface = '#151b23'; const dPanel = '#1c232c'; const dKeyInk = '#8d99a6';
  const dText = { body: '#e6edf3', muted: '#9aa7b4', err: '#ff8a80', warn: '#f0b354', ok: '#6fcf8a', info: '#8ab8e8' };
  const dMark = { select: '#539ce2', hover: '#e6edf3', find: '#f08cc4', trace: '#9472fd', bad: '#f56258', good: '#3cb672', unverified: '#8d9aab' };
  const DARK = {
    kind: { firewall: '#a148cc', switch: '#3296a9', router: '#92b1e0', host: '#9b83ff', unknown: '#a2a2a2' },
    edge: { lag: { c: '#c097e2' }, '40g': { c: '#8ee0e6' }, '10g': { c: '#48b3bd' }, '1g': { c: '#2f8a94' }, oob: { c: '#9d87f9' }, other: { c: '#818181' } },
    sev: { error: dMark.bad, warn: '#e0960f' },
    mark: dMark,
    vlan: { carry: { c: dMark.good }, inferred: { c: dMark.good }, partial: { c: dMark.bad }, oneSide: { c: dMark.good } },
    l2: { box: { fill: dPanel }, port: { fill: dPanel, stroke: dKeyInk } },
    l3: {
      subnet: { fill: dPanel, stroke: dKeyInk, text: dText.body }, route: { c: dKeyInk },
      overlap: { c: dText.warn }, badge: { bg: dPanel, text: dText.warn, border: dText.warn },
    },
    text: dText,
    canvas: {
      surface: dSurface,
      group: { fill: 'rgba(76,155,232,0.06)', stroke: 'rgba(76,155,232,0.24)', text: '#8fbdf0', labelBg: 'rgba(21,27,35,0.92)' },
      deviation: { c: '#e27ff0' },
      label: { bg: 'rgba(21,27,35,0.88)', text: dText.body, textUncollected: dText.muted },
      port: { bg: 'rgba(28,35,44,0.95)', border: 'rgba(140,150,160,0.5)', text: '#a9b4bf' },
      outline: dSurface, uncollectedFill: dPanel, keyInk: dKeyInk,
    },
    endpoint: {
      vendor: { 0: '#6a7bc5', 1: '#e1559c', 2: '#bf95f9', 3: '#9166fb', 4: '#94b6de', 5: '#c2457f', 6: '#4b9ecf', 7: '#b57fad' },
      downstream: { fill: '#15303a', stroke: '#7cc8dc', text: '#7cc8dc' },
      cluster: { fill: '#262e37', stroke: '#8a949e', text: '#c5ced6' },
    },
    firewall: {
      action: { accept: dText.ok, drop: dText.err, reject: dText.err, tarpit: dText.err, jump: dText.info, return: dText.muted, other: '#a9b4bf' },
      focus: { bg: '#17304a', border: dMark.select },
    },
    trend: { pending: '#4469e2', regressed: '#dc5a92', accepted: '#ae99f5', single: dMark.select, grid: '#2a333e', axis: '#3c4754', crosshair: dText.muted },
    l4: {
      status: {
        allow: { mark: '#189e32', bg: '#16301f' }, deny: { mark: '#ff978f', bg: '#3a1d1c' }, partial: { mark: '#ffc247', bg: '#33270f' },
        unknown: { mark: dText.muted, bg: '#262e37' }, empty: { bg: dPanel, hatch: '#2a333e' },
      },
      text: dText.body, badge: { bg: dPanel, text: dText.body, border: dKeyInk }, diagonal: { border: dKeyInk }, focus: dMark.select,
    },
    diff: { effect: { 'new-exposure': dText.err, 'less-restrictive': dText.warn, 'more-restrictive': dText.ok }, exposureBg: '#3a1d1c' },
  };

  // ---------------------------------------------------------------- 亮色／暗色配色
  // 結構（外形、線寬、虛線、透明度、字型、尺寸）只寫在上面一次；顏色另成兩組形狀相同的配色（palettes.light／dark），
  // 葉節點路徑與 V.theme 相同。亮色就是上面寫的值；暗色是亮色複本套上 DARK 覆寫表。
  // apply(mode) 原地改寫 V.theme 的顏色葉節點、不換掉任何物件：canvas.js 等檔案在載入時把子物件存成常數，換物件會讓它們停在舊值。
  // 用哪一組由畫面決定（app-toolbar.js：設定「一般」的配色偏好，跟隨系統時監聽 prefers-color-scheme）；PNG 匯出固定用亮色。
  const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i;
  /** 取出物件樹中所有顏色字串，保留相同的路徑（陣列保留索引）；沒有顏色的分支不列入 */
  function colorsOf(o) {
    const out = Array.isArray(o) ? [] : {}; let any = false;
    Object.keys(o).forEach((k) => {
      const v = o[k];
      if (typeof v === 'string' && COLOR.test(v)) { out[k] = v; any = true; } else if (v && typeof v === 'object') { const c = colorsOf(v); if (c) { out[k] = c; any = true; } }
    });
    return any ? out : null;
  }
  const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const light = colorsOf(V.theme);
  /** 覆寫表寫進 base（亮色複本）：每個鍵都必須是 base 已有的路徑，葉節點必須是顏色 */
  function override(base, over, path) {
    Object.keys(over).forEach((k) => {
      const v = over[k]; const p = path + k;
      if (!Object.prototype.hasOwnProperty.call(base, k)) throw new Error(`暗色覆寫表的 ${p} 不是亮色配色的路徑`);
      if (typeof v === 'string') {
        if (typeof base[k] !== 'string' || !COLOR.test(v)) throw new Error(`暗色覆寫表的 ${p} 應是顏色葉節點：${v}`);
        base[k] = v;
      } else if (base[k] && typeof base[k] === 'object' && v && typeof v === 'object') override(base[k], v, p + '.');
      else throw new Error(`暗色覆寫表的 ${p} 與亮色配色的形狀不同`);
    });
    return base;
  }
  const PALETTES = deepFreeze({ light: clone(light), dark: override(clone(light), DARK, '') });
  /** 把配色的葉節點寫進 target 的同一路徑（target 的物件與陣列保持原參照） */
  function assign(target, pal, path) {
    Object.keys(pal).forEach((k) => {
      const v = pal[k];
      if (typeof v === 'string') { target[k] = v; return; }
      if (!target[k] || typeof target[k] !== 'object') throw new Error(`theme.${path}${k} 不是物件，無法套用配色`);
      assign(target[k], v, path + k + '.');
    });
  }
  let mode = 'light';
  Object.defineProperties(V.theme, {
    palettes: { value: PALETTES },
    // 目前套用的配色（'light'／'dark'），唯讀；只經 apply 改變
    mode: { get: () => mode },
    apply: { value: function apply(m) {
      if (!Object.prototype.hasOwnProperty.call(PALETTES, m)) throw new RangeError('未知的配色模式：' + m);
      assign(V.theme, PALETTES[m], ''); mode = m;
    } },
  });
})(globalThis.SSOT = globalThis.SSOT || {});
