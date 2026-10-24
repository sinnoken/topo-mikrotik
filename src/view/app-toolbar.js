/*
 * 頁首與工具列：建立基準、搜尋、路由追蹤、清除；圖的操作（全圖、重新排列、力導向、顯示切換）、圖例與匯出。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = V.app; const App = window.App;
  const EP = V.theme.endpoint; const WEAK = V.theme.weakEdge; const CV = V.theme.canvas;

  // ================================================================ 頁首
  A.bindHeader = function bindHeader() {
    $('#btn-input').onclick = () => A.openInput();
    $('#btn-trace').onclick = () => { const p = $('#trace-pop'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) $('#trace-src').focus(); };
    $('#trace-run').onclick = A.runTrace;
    ['#trace-src', '#trace-dst'].forEach((s) => $(s).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') A.runTrace();
      if (e.key === 'Escape') $('#trace-pop').classList.add('hidden');
    }));
    $('#btn-clear').onclick = async () => {
      if (!App.snap || !confirm('清除目前的基準與輸入？（只清除這個工具的資料）')) return;
      await S.store.del('last'); App.snap = null; App.Q = null; App.sources = []; App.graph.setData([], [], new Map()); A.renderAll();
    };
    // 搜尋
    const inp = $('#search'); const dd = $('#search-dd'); let results = []; let active = 0;
    const show = () => {
      V.clear(dd); if (!App.Q || !inp.value.trim()) { dd.classList.add('hidden'); return; }
      results = App.Q.search(inp.value, 15); active = 0;
      if (!results.length) dd.appendChild(h('div', { class: 'empty' }, '找不到符合的設備、MAC、IP 或 VLAN'));
      const T = { device: '設備', mac: 'MAC', ip: 'IP', vlan: 'VLAN', interface: '介面' };
      results.forEach((r, i) => dd.appendChild(h('div', {
        class: 'item' + (i === active ? ' active' : ''),
        onmousedown: (e) => { e.preventDefault(); pick(r); },
      }, [V.chip(T[r.type]), h('span', null, r.label), h('span', { class: 'sub' }, r.sub || '')])));
      dd.classList.remove('hidden');
    };
    const pick = (r) => { dd.classList.add('hidden'); inp.blur(); App.select({ type: r.type, key: r.key }, { focus: true }); };
    let t = null;
    inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(show, 120); });
    inp.addEventListener('focus', show);
    inp.addEventListener('blur', () => setTimeout(() => dd.classList.add('hidden'), 150));
    inp.addEventListener('keydown', (e) => {
      const items = dd.querySelectorAll('.item');
      if (e.key === 'Enter' && results[active]) pick(results[active]);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(0, Math.min(results.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
        items.forEach((el, i) => el.classList.toggle('active', i === active));
      } else if (e.key === 'Escape') { dd.classList.add('hidden'); inp.blur(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault(); inp.focus();
      }
    });
  };

  // ================================================================ 工具列
  A.bindToolbar = function bindToolbar() {
    $('#btn-fit').onclick = () => App.graph.fit();
    $('#btn-relayout').onclick = () => A.relayout();
    $('#layout-mode').value = App.layoutMode;
    $('#layout-mode').onchange = () => {
      App.layoutMode = $('#layout-mode').value;
      S.store.set('layoutMode', App.layoutMode).catch(() => {});
      $('#btn-relayout').click();
    };
    let running = null;
    $('#btn-force').onclick = () => {
      if (running) { cancelAnimationFrame(running); running = null; $('#btn-force').classList.remove('on'); A.savePositions(); return; }
      const nodes = App.graph.nodes.filter((n) => App.graph.visible(n)); const ids = new Set(nodes.map((n) => n.id));
      const edges = App.graph.edges.filter((e) => ids.has(e.a) && ids.has(e.b)); let temp = 60; let it = 0;
      $('#btn-force').classList.add('on');
      const step = () => {
        const per = nodes.length > 1500 ? 1 : 3;
        for (let k = 0; k < per; k++) { V.layout.forceStep(nodes, edges, App.graph.pos, temp); temp *= 0.985; it++; }
        App.graph.computeGroups();
        if (it < 360 && temp > 1) running = requestAnimationFrame(step); else { running = null; $('#btn-force').classList.remove('on'); A.savePositions(); }
      };
      running = requestAnimationFrame(step);
    };
    $('#btn-hosts').onclick = () => { App.showHosts = !App.showHosts; A.applyVisibility(); };
    $('#btn-unknown').onclick = () => { App.showUnknown = !App.showUnknown; A.applyVisibility(); };
    $('#btn-groups').onclick = () => {
      App.graph.showGroups = !App.graph.showGroups; $('#btn-groups').classList.toggle('on', App.graph.showGroups); App.graph.redraw();
    };
    $('#btn-png').onclick = () => { const a = document.createElement('a'); a.download = 'topology.png'; a.href = $('#graph').toDataURL('image/png'); a.click(); };
    $('#btn-json').onclick = () => App.exportAs('snapshot');
    buildLegend();
  };

  // ================================================================ 圖例
  function buildLegend() {
    const lg = $('#legend');
    // 圖例的外形、顏色、線寬、虛線與透明度全部取自 theme，與 Canvas 繪圖同一來源
    // 分四類，預設收合只顯示標題列；細節說明放 title，避免圖例太長
    const head = h('button', { class: 'legend-head', title: '展開／收合圖例' }, '圖例 ▸');
    const body = h('div', { class: 'legend-body hidden' });
    head.onclick = () => { const open = body.classList.contains('hidden'); body.classList.toggle('hidden', !open); head.textContent = open ? '圖例 ▾' : '圖例 ▸'; };
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
    const dot = (style) => h('span', { class: 'sev', style: Object.assign({ width: LEG + 'px', height: LEG + 'px' }, style) });
    const line = (color, w, dash, alpha) => h('span', { class: 'ln', style: {
      borderTopWidth: '0', height: Math.max(2, Math.round(w)) + 'px', opacity: String(alpha == null ? 1 : alpha),
      background: dash ? `repeating-linear-gradient(90deg, ${dash.reduce((stops, n, i) => {
        const next = (stops.pos || 0) + n; const shade = i % 2 ? 'transparent' : color;
        stops.parts.push(`${shade} ${stops.pos || 0}px`, `${shade} ${next}px`); stops.pos = next; return stops;
      }, { parts: [], pos: 0 }).parts.join(', ')})` : color,
    } });
    group('設備');
    Object.entries(V.KIND).forEach(([k, label]) => item([dot(Object.assign({ background: V.KIND_COLOR[k] }, SHAPE_CSS[V.theme.shape[k]]))], label));
    item([dot(Object.assign({ background: CV.uncollectedFill, border: '2px dashed ' + V.KIND_COLOR.unknown }, SHAPE_CSS.circle))], '未收集', '基準裡沒有收集檔的設備（虛線外框）');
    group('終端');
    item([dot({ background: EP.vendorFallback, border: '1.5px solid ' + CV.outline })], '單一 MAC', '未知對端：一個埠一個 MAC，依廠商上色');
    item([dot({ background: EP.downstream.fill, border: '2px dashed ' + EP.downstream.stroke, transform: 'rotate(45deg)', borderRadius: '0' })],
      'Wi-Fi 多 MAC', 'Wi-Fi MAC 觀察位置列入終端清單；Wi-Fi 介面不算終端埠，且不參與 A02');
    item([dot({
      background: EP.cluster.fill, border: '1.5px solid ' + EP.cluster.stroke,
      width: Math.round(LEG * 1.3) + 'px', height: Math.round(LEG * 0.8) + 'px', borderRadius: '3px',
    })], '群組 ×N', '同一台設備終端過多時收合，雙擊展開');
    item([h('span', { class: 'sev error' })], '錯誤／警告');
    group('連線');
    Object.entries(V.EDGE_STYLE).forEach(([k, st]) => item([line(st.c, st.w, st.dash)], V.CLS[k],
      k === '1g' ? '推論分類：ether、sfp1、combo 等介面名稱歸為 1G；不代表實際協商速率，ether 也可能是 2.5G 或 10G。' : null));
    group('連線註記');
    item([line(WEAK.hearsay.c, V.EDGE_STYLE.other.w, WEAK.hearsay.dash, WEAK.hearsay.alpha)], '單側觀察', '紫色點線：對端沒有提供 LLDP 鄰居資料，屬單向觀察');
    item([line(WEAK.inferred.c, V.EDGE_STYLE.other.w, WEAK.inferred.dash, WEAK.inferred.alpha)], '推論鏈路',
      '綠色長虛線：沒有 LLDP 的設備（例如只支援 MNDP 的 SwOS 交換器），依 MAC 表、MNDP、點對點網段推定相鄰；是直接相連或中間只有未管理設備');
    Object.values(EP.byType).forEach((t) => item([line(t.c, V.EDGE_STYLE.other.w, WEAK.hearsay.dash, WEAK.hearsay.alpha)], t.label, '連到 ' + t.label + ' 介面終端的連線'));
  }

  // ================================================================ 匯出
  /** 匯出目前的基準或檢查結果（種類見 V.exporter.KINDS）；只讀 App.snap，不改寫。extra 例如 { byDevice: true } */
  App.exportAs = function (kind, extra) {
    if (!App.snap) return;
    const k = V.exporter.KINDS[kind];
    if (!k) throw new Error('未知的匯出種類：' + kind);
    // 確認狀態與查詢介面由畫面傳入：匯出內容的組字函式本身不讀全域狀態
    const opts = Object.assign({}, extra || {}, { acked: A.ackOf, Q: App.Q });
    try { V.exporter.download(k.name(App.snap), k.text(App.snap, opts), k.type); } catch (e) {
      console.error(e); A.banner('匯出失敗：' + e.message, 10000);
    }
  };
})(globalThis.SSOT = globalThis.SSOT || {});
