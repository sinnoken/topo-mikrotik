/*
 * 圖例與匯出：拓樸圖的圖例（A.buildLegend，工具列綁定時建立；配色換了由 app-scheme.js 呼叫 A.rebuildLegend）、
 * 終端廠商色的圖例、匯出 PNG（固定亮色，經 app-scheme.js 的 A.withScheme）與匯出基準或檢查結果（App.exportAs）。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = V.app; const App = window.App;
  const EP = V.theme.endpoint; const WEAK = V.theme.weakEdge; const CV = V.theme.canvas;

  // ================================================================ 圖例
  A.buildLegend = function buildLegend() {
    const lg = $('#legend'); const T = V.theme; const M = T.mark; const EDGE = V.EDGE_STYLE;
    // 圖例的外形、顏色、線寬、虛線與透明度全部取自 theme，與 Canvas 繪圖同一來源
    // 分五類，預設收合只顯示標題列；細節說明放 title，避免圖例太長
    const head = h('button', { class: 'legend-head', title: '展開／收合圖例', 'aria-expanded': 'false' }, '圖例 ▸');
    const body = h('div', { class: 'legend-body hidden' });
    head.onclick = () => {
      const open = body.classList.contains('hidden'); body.classList.toggle('hidden', !open);
      lg.classList.toggle('open', open); // 展開時操作提示讓位（assets/app.css 的 .legend.open ~ .hint）
      head.textContent = open ? '圖例 ▾' : '圖例 ▸'; head.setAttribute('aria-expanded', String(open));
    };
    lg.appendChild(head); lg.appendChild(body);
    let grp = null;
    const group = (title) => { grp = h('div', { class: 'lg-group' }, [h('div', { class: 'lg-title' }, title)]); body.appendChild(grp); };
    const item = (swatches, label, tip) => grp.appendChild(h('div', { class: 'li', title: tip || null }, swatches.concat(label)));
    const LEG = 12;
    const SHAPE_CSS = {
      shield: { clipPath: 'polygon(50% 0, 100% 22%, 90% 70%, 50% 100%, 10% 70%, 0 22%)' },
      wide: { width: Math.round(LEG * 1.4) + 'px', height: Math.round(LEG * 0.85) + 'px', borderRadius: '2px' },
      square: { borderRadius: '2px' },
      circle: {},
    };
    const SEV_CSS = {
      square: { width: Math.round(LEG * 0.8) + 'px', height: Math.round(LEG * 0.8) + 'px', borderRadius: '1px' },
      triangle: { borderRadius: '0', clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' },
    };
    const dot = (style, attrs) => h('span', Object.assign({ class: 'sev', style: Object.assign({ width: LEG + 'px', height: LEG + 'px' }, style) }, attrs || {}));
    const line = (color, w, dash, alpha, attrs) => h('span', Object.assign({ class: 'ln', style: {
      borderTopWidth: '0', height: V.legendLineHeight(w), opacity: String(alpha == null ? 1 : alpha),
      background: dash ? `repeating-linear-gradient(90deg, ${dash.reduce((stops, n, i) => {
        const next = (stops.pos || 0) + n; const shade = i % 2 ? 'transparent' : color;
        stops.parts.push(`${shade} ${stops.pos || 0}px`, `${shade} ${next}px`); stops.pos = next; return stops;
      }, { parts: [], pos: 0 }).parts.join(', ')})` : color,
    } }, attrs || {}));
    // 實線加垂直短刻度（theme.vlan.partial.ticks）：與畫布 100% 時的大小相同；刻度與線是兩層背景，強制色彩模式下 .ln 保留原色
    const tickLine = (color, w, t, alpha, attrs) => {
      const lh = parseFloat(V.legendLineHeight(w)); const y0 = (t.len - lh) / 2; const x0 = (t.gap - t.w) / 2;
      return h('span', Object.assign({ class: 'ln', style: {
        borderTopWidth: '0', height: t.len + 'px', opacity: String(alpha == null ? 1 : alpha),
        background: `repeating-linear-gradient(90deg, transparent 0 ${x0}px, ${color} ${x0}px ${x0 + t.w}px, transparent ${x0 + t.w}px ${t.gap}px), ` +
          `linear-gradient(transparent 0 ${y0}px, ${color} ${y0}px ${y0 + lh}px, transparent ${y0 + lh}px)`,
      } }, attrs || {}));
    };
    const ring = (color, width, mark) => dot({ background: 'transparent', border: `${width}px solid ${color}` }, { 'data-mark': mark });
    group('設備');
    Object.entries(V.KIND).forEach(([k, label]) => item([dot(Object.assign({ background: V.KIND_COLOR[k] }, SHAPE_CSS[T.shape[k]]))], label));
    item([dot(Object.assign({ background: CV.uncollectedFill, border: '2px dashed ' + V.KIND_COLOR.unknown }, SHAPE_CSS.circle))], '未收集', '基準裡沒有收集檔的設備（虛線外框）');
    // L2 埠圖與 L3 子網圖的節點（中性外框，靠外形區分）
    item([dot({ background: T.l2.port.fill, border: '1.5px solid ' + T.l2.port.stroke, width: '9px', height: '9px', borderRadius: '1px' }, { 'data-l2': 'port' })], '埠（L2）',
      'L2 埠圖：設備是外框為類型色的方框，埠是框邊上的小方塊；較寬的是聚合埠，虛線的是推論鏈路未收集端的未知埠');
    item([dot({ background: T.l3.subnet.fill, border: '1.6px solid ' + T.l3.subnet.stroke, width: '22px', height: '10px', borderRadius: '5px' }, { 'data-l3': 'subnet' })], '網段（L3）',
      'L3 網段圖：圓角長條是網段；虛線外框是只由路由得知的目的網段。接到兩個以上網段、有路由表或是路由器／防火牆的設備是路由設備（推論）');
    item([dot({ background: T.l3.subnet.fill, border: '2px dashed ' + T.l3.subnet.stroke, width: '22px', height: '10px', borderRadius: '5px' }, { 'data-l3': 'external' })], '外部（L3，推論）',
      'L3 網段圖：基準看不到的外部網路（每個 VRF 一個），寫「外部（推論）」；依路由、NAT 與位址推論哪些介面對外，點選看依據');
    group('終端');
    // 前 8 個廠商各一色（依基準計算，載入基準後由 renderVendorLegend 填入），其餘與不明廠商用中性色
    vendorBox = h('div', { class: 'lg-vendors' }); grp.appendChild(vendorBox); A.renderVendorLegend();
    item([dot({ background: EP.downstream.fill, border: '2px dashed ' + EP.downstream.stroke, transform: 'rotate(45deg)', borderRadius: '0' })],
      'Wi-Fi 多 MAC', 'Wi-Fi MAC 觀察位置列入終端清單；Wi-Fi 介面不算終端埠，且不參與 A02');
    item([dot({
      background: EP.cluster.fill, border: '1.5px solid ' + EP.cluster.stroke,
      width: Math.round(LEG * 1.3) + 'px', height: Math.round(LEG * 0.8) + 'px', borderRadius: '3px',
    })], V.TERMS.endpoint + ' ×N', '同一台設備終端過多時收合，雙擊展開');
    group(V.TERMS.link);
    Object.entries(EDGE).forEach(([k, st]) => item([line(st.c, st.w, st.dash, 1, { 'data-edge': k })], V.CLS[k],
      k === '1g' ? '推論分類：ether、sfp1、combo 等介面名稱歸為 1G；不代表實際協商速率，ether 也可能是 2.5G 或 10G。線寬隨速率遞增。' : null));
    const mw = EDGE['1g'].w * T.multi.widen; const g0 = Math.round((1 - T.multi.gap) * 50); const g1 = 100 - g0;
    item([h('span', { class: 'ln', 'data-multi': '', style: {
      borderTopWidth: '0', height: V.legendLineHeight(mw), background: `linear-gradient(${CV.keyInk} 0 ${g0}%, ${CV.surface} ${g0}% ${g1}%, ${CV.keyInk} ${g1}%)`,
    } })], '多條鏈路（雙線）', '同一對設備之間有多條鏈路：線加寬並在中間留一條細縫；顏色仍是該鏈路類別');
    group(V.TERMS.link + '註記');
    const noteW = EDGE['1g'].w;
    item([line(CV.keyInk, noteW, WEAK.hearsay.dash, WEAK.hearsay.alpha)], V.TERMS.hearsay, '點線（顏色依鏈路類別）：' + V.HEARSAY_TEXT + '，只有本機這一端回報；不是「LLDP 單向」（K01，對端有鄰居資料但沒回報這條鏈路）');
    item([line(CV.keyInk, noteW, WEAK.inferred.dash, WEAK.inferred.alpha)], '推論鏈路',
      '長虛線（顏色依鏈路類別）：沒有 LLDP 的設備（例如只支援 MNDP 的 SwOS 交換器），依 MAC 表、MNDP、點對點網段推定相鄰；是直接相連或中間只有非網管型設備');
    Object.values(EP.byType).forEach((t) => item([line(CV.keyInk, noteW, t.dash, WEAK.hearsay.alpha)], t.label, '連到 ' + t.label + ' 介面終端的鏈路（專用線型）'));
    item([line(T.l3.route.c, T.l3.route.w, T.l3.route.dash, 1, { 'data-l3': 'route' }), h('span', { class: 'lg-arrow', style: { color: T.l3.route.c } }, '▶')], '路由（L3）',
      'L3 網段圖開啟「顯示路由」時：靜態路由與預設路由，從路由所在的設備以虛線箭頭指到目的網段');
    item([line(T.l3.boundary.c, T.l3.boundary.w, null, 1, { 'data-l3': 'boundary' })], '對外（L3，推論）',
      'L3 網段圖：設備到「外部」的實線，這台設備有判定對外的介面（預設路由、NAT 等強證據，或 WAN 清單）；預設路由經這裡出去時改為路由的虛線加箭頭。點選看依據');
    item([line(T.l3.possible.c, T.l3.possible.w, T.l3.possible.dash, 1, { 'data-l3': 'possible' })], '可能對外（L3，推論）',
      'L3 網段圖：設備到「外部」的長虛線，只有弱證據（公網或 CGNAT 位址等），線上標「可能對外」');
    item([line(T.l3.overlap.c, T.l3.overlap.w, T.l3.overlap.dash, 1, { 'data-l3': 'overlap' })], '網段重疊（L3）', 'L3 網段圖：互相包含的網段之間的虛線，中點有警告外形；網段下方另標「重疊網段」「重複 IP」');
    group('標示');
    // 嚴重度：外形與畫布的 sevMark 相同（theme.sevShape），不只靠顏色
    Object.entries(T.sevShape).forEach(([k, shape]) => item([dot(Object.assign({ background: T.sev[k] }, SEV_CSS[shape]), { 'data-shape': shape })],
      V.SEV[k], `有${V.SEV[k]}的設備在右上角、鏈路在中點標示${shape === 'square' ? '方形' : '三角形'}`));
    item([ring(M.select, 3, 'select')], '選取', '目前選取的設備（藍色粗環）與鏈路');
    item([ring(M.hover, 2, 'hover')], '滑過', '指標或鍵盤（N 鍵）目前所在的設備（深色細環）；相連的線一起標示');
    item([ring(M.find, 3, 'find')], '搜尋結果', '搜尋 MAC／IP 時，標出所在位置的設備與鏈路');
    { // 與多數不同：節點外的虛線圓圈（theme.canvas.deviation）；圓周依 LEG 換算虛線長度
      const D = CV.deviation; const r = LEG / 2; const per = 360 / (Math.PI * LEG); let deg = 0;
      const stops = D.dash.map((n, i) => { const from = deg; deg += n * per; return `${i % 2 ? 'transparent' : D.c} ${from.toFixed(1)}deg ${deg.toFixed(1)}deg`; });
      const mask = `radial-gradient(circle, transparent ${(r - D.w).toFixed(1)}px, ${D.c} ${(r - D.w).toFixed(1)}px)`; // 遮罩只看不透明度
      item([dot({ background: `repeating-conic-gradient(${stops.join(', ')})`, maskImage: mask, webkitMaskImage: mask }, { 'data-mark': 'deviation' })], V.DEVIATION_LABEL, D.tip); // 名稱和詳情、匯出同一個來源（V.DEVIATION_LABEL）
    }
    item([line(M.trace, 4, null, T.alpha.overlay, { 'data-mark': 'trace' }), h('span', { class: 'lg-arrow', style: { color: M.trace } }, '▶')], '路由追蹤', '逐跳路徑，箭頭表示方向');
    // VLAN 篩選：承載狀態（Q.vlanCarriers），線型與外形取自 theme.vlan，不只靠顏色
    const VL = { carry: ['VLAN 承載', '兩端都帶這個 VLAN（實線）'], inferred: ['VLAN 推論承載', '推論鏈路，已收集的各端都帶這個 VLAN（長虛線，推論）'],
      partial: ['VLAN 只有一端', '兩端都有 VLAN 資料，只有一端帶這個 VLAN（實線加垂直短刻度，中點有錯誤外形，V01）'], oneSide: ['VLAN 一端未知', '只有一端可確認：對端未收集、沒有 VLAN 資料或' + V.TERMS.hearsay + '（點線、淡色，推論）'] };
    Object.entries(T.vlan).forEach(([k, st]) => item([st.ticks ? tickLine(st.c, 4, st.ticks, st.alpha, { 'data-vlan': k }) : line(st.c, 4, st.dash, st.alpha, { 'data-vlan': k }),
      st.sev ? dot(Object.assign({ background: T.sev[st.sev] }, SEV_CSS[T.sevShape[st.sev]]), { 'data-shape': T.sevShape[st.sev] }) : null].filter(Boolean), VL[k][0], VL[k][1]));
  };
  /** 配色換了：以目前的 theme 重建圖例，保留展開狀態與焦點（焦點在圖例標題時移到新的標題） */
  A.rebuildLegend = function rebuildLegend() {
    const lg = $('#legend'); const old = lg.querySelector('.legend-head'); if (!old) return;
    const open = old.getAttribute('aria-expanded') === 'true'; const focused = document.activeElement === old;
    V.clear(lg); A.buildLegend();
    const head = lg.querySelector('.legend-head');
    if (open) head.click();
    if (focused) head.focus();
  };
  /** 圖例的線寬：依 theme 的線寬等比放大到圖例可辨識，保持速率越高越粗的順序 */
  V.legendLineHeight = (w) => Math.max(1, Math.round(w * 1.2)) + 'px';
  let vendorBox = null;
  /** 圖例的終端廠商色：前 8 個廠商（依目前基準）＋「其他」；沒有終端時只列中性色的「單一 MAC」 */
  A.renderVendorLegend = function renderVendorLegend() {
    if (!vendorBox) return; V.clear(vendorBox);
    const sw = (c) => h('span', { class: 'sev', style: { width: '12px', height: '12px', background: c, border: '1.5px solid ' + CV.outline } });
    App.vendorColors.forEach((c, v) => vendorBox.appendChild(h('div', { class: 'li lg-vendor', title: '終端廠商：' + v }, [sw(c), h('span', { class: 'lg-name' }, v)])));
    vendorBox.appendChild(h('div', { class: 'li', title: V.TERMS.endpoint + '：一個埠一個 MAC，依廠商上色；前 8 個以外的廠商與不明廠商用這個顏色' },
      [sw(EP.vendorFallback), App.vendorColors.size ? `其他廠商${App.vendorOthers ? `（${App.vendorOthers} 家）` : ''}／不明` : '單一 MAC']));
  };

  // ================================================================ 匯出
  /**
   * 目前的拓樸圖畫面 → PNG：設備圖是 topology.png，L2 埠圖、L3 子網圖是 topology-l2.png、topology-l3.png（畫的是目前的層級）。
   * 畫布每次繪圖都先填滿 theme 的畫布底色，匯出前同步重畫一次，PNG 才是目前畫面且不透明。
   * 資料中心蓋在圖上時畫布大小不變（兩者疊在同一格），所以從資料中心匯出也是同一張圖。
   */
  A.exportPng = function exportPng() {
    if (!App.snap) return;
    // L4 是矩陣不是畫布：PNG 只匯出拓樸圖的層級，矩陣改用 L4 畫面的「下載 CSV」
    if (App.layer === 'l4') { A.banner('L4 可達性沒有 PNG：請在 L4 畫面用「下載 CSV」匯出矩陣，或切到設備、L2、L3 再匯出 PNG。', 8000); return; }
    // PNG 固定用亮色（多半貼進報告或列印）：暫時套亮色畫一次，取得圖檔後還原目前的深淺並重畫
    let url;
    try { url = A.withScheme('light', () => { App.graph.draw(); return $('#graph').toDataURL('image/png'); }); } catch (e) {
      console.error(e); A.banner('匯出失敗：' + V.reason(e), 10000); return;
    }
    const a = document.createElement('a'); a.download = A.layerPngName(); a.href = url; a.click();
  };
  /** 匯出目前的基準或檢查結果（種類見 V.exporter.KINDS）；透過 App.Q 讀取，不改寫。extra 例如 { byDevice: true } */
  App.exportAs = function (kind, extra) {
    if (!App.snap) return;
    const k = V.exporter.KINDS[kind];
    if (!k) throw new Error('未知的匯出種類：' + kind);
    // 處理紀錄由畫面傳入：匯出內容的組字函式本身不讀全域狀態；整份基準只給基準 JSON 原樣序列化
    const opts = Object.assign({}, extra || {}, { ledgerOf: A.ledgerExport, snapshot: App.snap });
    try { V.exporter.download(k.name(App.Q), k.text(App.Q, opts), k.type); } catch (e) {
      console.error(e); A.banner('匯出失敗：' + V.reason(e), 10000);
    }
  };
})(globalThis.SSOT = globalThis.SSOT || {});
