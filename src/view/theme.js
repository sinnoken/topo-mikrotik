/*
 * 檢視層視覺樣式的唯一來源（顏色、線型、透明度）。
 * 只有常數：Canvas 繪圖與圖例都讀這裡，不得各自寫色值。
 * Canvas 讀不到 CSS 變數，所以 DOM 用的 :root 變數（assets/app.css）與這裡的設備類型色
 * 以測試比對，避免漂移。Snapshot 不含任何樣式。
 */
(function (S) {
  'use strict';
  const V = (S.view = S.view || {});
  const kind = {
    firewall: '#22a338', switch: '#f29900', router: '#2563eb', host: '#8b5cf6', unknown: '#90a4ae',
    endpoint: '#78909c', downstream: '#f29900', cluster: '#90a4ae',
  };
  V.theme = {
    kind,
    // 設備節點外形；Canvas 繪圖與圖例共用
    shape: { firewall: 'shield', switch: 'wide', router: 'circle', host: 'square', unknown: 'circle' },
    edge: {
      lag: { c: '#3b82f6', w: 3.2 }, '40g': { c: '#ef4444', w: 2.8 }, '10g': { c: '#f59e0b', w: 2.1 }, '1g': { c: '#0f766e', w: 2.4 },
      oob: { c: '#22c55e', w: 1.2, dash: [4, 3] }, other: { c: '#b0b8c1', w: 1.3 },
    },
    // 證據強度較弱的邊，鍵與 query devicePairs 的 evidence 相同：單側觀察（對端無 LLDP）、推論。只有 MNDP 的設備對不畫
    weakEdge: {
      hearsay: { c: '#7c3aed', alpha: 0.85, dash: [2, 3] },
      // 推論鏈路：沒有 LLDP 時由 MAC 表、MNDP、點對點網段推定相鄰（證據強於純 MNDP，弱於 LLDP）
      inferred: { c: '#4d7c0f', alpha: 0.9, dash: [10, 3] },
    },
    sev: { error: '#d93025', warn: '#f29900' },
    // 選取、追蹤與檢查結果的標示色
    mark: { select: '#0b6bcb', hover: '#ff5722', find: '#ff5722', trace: '#0b6bcb', bad: '#d93025', good: '#1e8e3e' },
    alpha: { dimEdge: 0.12, dimNode: 0.15, dimLabel: 0.25, overlay: 0.9 },
    // 畫布上的中性色：分群底框、標籤、埠名、節點描邊
    canvas: {
      group: { fill: 'rgba(11,107,203,0.035)', stroke: 'rgba(11,107,203,0.18)', text: 'rgba(11,107,203,0.75)' },
      label: { bg: 'rgba(255,255,255,0.88)', text: '#1f2933', textUncollected: '#6b7785' },
      port: { bg: 'rgba(255,255,255,0.95)', border: 'rgba(120,130,140,0.5)', text: '#4a5560' },
      outline: '#ffffff', uncollectedFill: '#ffffff', sevFallback: '#999999',
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
      downstream: { fill: '#fff8e8', stroke: '#f29900', text: '#9a5b00' },
      cluster: { fill: '#eceff1', stroke: '#78909c', text: '#37474f' },
      dash: [3, 2],
    },
    // 防火牆規則畫面：動作文字色、停用規則的透明度、目前定位到的列
    firewall: {
      action: { accept: '#1e8e3e', drop: '#d93025', reject: '#d93025', 'tarpit': '#d93025', jump: '#3b6ea8', return: '#687789', other: '#4a5560' },
      disabledAlpha: 0.5,
      focus: { bg: '#e6f0fb', border: '#0b6bcb' },
    },
    // 新舊基準比對：effect 的標示色；new-exposure（新暴露）要醒目
    diff: {
      effect: { 'new-exposure': '#d93025', 'less-restrictive': '#b26a00', 'more-restrictive': '#1e8e3e' },
      exposureBg: '#fdecea',
    },
  };
  V.EDGE_STYLE = V.theme.edge; V.KIND_COLOR = kind;
})(globalThis.SSOT = globalThis.SSOT || {});
