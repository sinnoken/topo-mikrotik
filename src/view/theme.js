/*
 * 檢視層視覺樣式的唯一來源（顏色、線型、透明度、字型）。
 * 只有常數：Canvas 繪圖與圖例都讀這裡，不得各自寫色值。
 * Canvas 讀不到 CSS 變數，所以 DOM 用的 :root 變數（assets/app.css）與這裡的設備類型色、嚴重度色、
 * 文字色、畫布底色與字型以測試比對，避免漂移。Snapshot 不含任何樣式。
 *
 * 配色規則（以 dataviz validate_palette.js 實測，亮色、底色 #f8fafc）：
 *  - 狀態色（sev、mark.bad／good）只表示狀態，且一律搭配外形或文字；類別色（設備、連線、廠商）不用紅、橘黃、綠。
 *  - 文字色（text.*）對其底色 ≥ 4.5:1；圖形標記對畫布底色 ≥ 3:1。
 *  - unknown、edge.other、vendorFallback 是刻意的中性色：代表「未分類／其他」，不做類別識別，所以不受彩度下限約束。
 */
(function (S) {
  'use strict';
  const V = (S.view = S.view || {});
  // 設備類型：任兩類都可能相鄰，以全部配對驗證（外形是第二編碼）
  const kind = { firewall: '#7b208e', switch: '#3398b5', router: '#335dcd', host: '#977af8', unknown: '#535d62' };
  // 狀態文字色：對白底、淺色狀態底與畫布底都 ≥ 4.5:1（與 app.css 的 --err-text 等一致，有測試）
  const text = { body: '#1f2933', muted: '#5f6d7e', err: '#b3261e', warn: '#8a5300', ok: '#17692f', info: '#315d8a' };
  V.theme = {
    kind,
    // 設備節點外形；Canvas 繪圖與圖例共用
    shape: { firewall: 'shield', switch: 'wide', router: 'circle', host: 'square', unknown: 'circle' },
    // 連線：1G → 10G → 40G 是同一色相由淺到深的順序色階；聚合、管理線與其他各自一色（都不用狀態色）
    edge: {
      lag: { c: '#6e289c', w: 3.2 }, '40g': { c: '#085762', w: 2.8 }, '10g': { c: '#1e767f', w: 2.1 }, '1g': { c: '#3396a0', w: 2.4 },
      oob: { c: '#957bf9', w: 1.2, dash: [4, 3] }, other: { c: '#747b83', w: 1.3 },
    },
    // 證據強度較弱的邊，鍵與 query devicePairs 的 evidence 相同：單側觀察（對端無 LLDP）、推論。只有 MNDP 的設備對不畫。
    weakEdge: {
      hearsay: { c: '#7c3aed', alpha: 0.85, dash: [2, 3] },
      // 推論鏈路：沒有 LLDP 時由 MAC 表、MNDP、點對點網段推定相鄰（證據強於純 MNDP，弱於 LLDP）
      inferred: { c: '#4d7c0f', alpha: 0.9, dash: [10, 3] },
    },
    // 嚴重度：顏色之外一律有外形（錯誤方形、警告三角形），節點右上角與連線中點共用
    sev: { error: '#d93025', warn: '#f29900' },
    sevShape: { error: 'square', warn: 'triangle' },
    // 圖上的標示：選取（藍色實線環）、滑過（深色細環）、搜尋結果、路由追蹤（含箭頭）各用不同顏色；bad／good 是狀態
    mark: { select: '#0b6bcb', hover: '#1f2933', find: '#a44a88', trace: '#622fa6', bad: '#d93025', good: '#1e8e3e' },
    alpha: { dimEdge: 0.12, dimNode: 0.15, dimLabel: 0.25, overlay: 0.9 },
    text,
    // 畫布上的中性色：分群底框、標籤、埠名、節點描邊
    canvas: {
      group: { fill: 'rgba(11,107,203,0.035)', stroke: 'rgba(11,107,203,0.18)', text: '#1f5a96' },
      label: { bg: 'rgba(255,255,255,0.88)', text: text.body, textUncollected: text.muted },
      port: { bg: 'rgba(255,255,255,0.95)', border: 'rgba(120,130,140,0.5)', text: '#4a5560' },
      outline: '#ffffff', uncollectedFill: '#ffffff', sevFallback: '#7c8691',
    },
    endpoint: {
      // 不用紅、橘、黃：避免和「錯誤／警告」標記混淆
      vendor: ['#26a69a', '#42a5f5', '#7e57c2', '#5c6bc0', '#8d6e63', '#546e7a', '#66bb6a', '#00897b', '#ab47bc', '#78909c'],
      vendorFallback: '#b0bec5',
      // 依介面類型識別連到終端的連線（只標連線，節點外觀不變）；鍵為 rawType（veth）或 type（wireless），用 styleOf 查
      byType: {
        veth: { c: '#d81b60', label: '容器 veth' },
        wireless: { c: '#00b8d4', label: 'Wi-Fi' },
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
    // 新舊基準比對：effect 的文字色（都另有文字標籤）；new-exposure（新暴露）的列另加底色
    diff: {
      effect: { 'new-exposure': text.err, 'less-restrictive': text.warn, 'more-restrictive': text.ok },
      exposureBg: '#fdecea',
    },
  };
  V.EDGE_STYLE = V.theme.edge; V.KIND_COLOR = kind;
})(globalThis.SSOT = globalThis.SSOT || {});
