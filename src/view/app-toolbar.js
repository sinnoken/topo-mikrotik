/*
 * 頁首與工具列：搜尋、資料中心、「⋯」更多操作（路由追蹤、匯出 PNG、清除基準）；圖的操作（全圖、版面▾、顯示▾）、圖例與匯出。
 * 輸入與輸出的入口集中在資料中心（app-hub.js）；「⋯」只留和圖有關的「匯出 PNG」（資料中心也有，呼叫同一個 A.exportPng）。
 * 下拉選單（⋯、版面、顯示）共用 A.bindMenu：方向鍵、Home／End 移動，Esc 關閉並把焦點還給按鈕，Tab 或點外面關閉。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = V.app; const App = window.App;
  const EP = V.theme.endpoint; const WEAK = V.theme.weakEdge; const CV = V.theme.canvas;

  // ================================================================ 下拉選單
  const menus = [];
  /** 選單項目可以操作：沒有停用，也沒有因為層級而隱藏 */
  const usable = (b) => !b.disabled && !b.classList.contains('hidden');
  /** 勾選與單選的選單項目：aria-checked 與 class on 一起改（外觀與朗讀同一個狀態） */
  A.setChecked = function setChecked(el, on) { el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); };
  /** 關閉所有下拉選單（不移焦點）；路由追蹤、切換層級等操作先呼叫 */
  A.closeMenus = function closeMenus() { menus.forEach((m) => m.close(false)); };
  /**
   * 下拉選單：btn 開關 menu（aria-expanded），開啟時焦點到第一個（↑ 開啟時到最後一個）可操作的項目。
   * 有 data-keep 的項目（勾選項目）按了不關閉，方便連續切換；其他項目按了就關閉。place(btn, menu) 開啟前定位。
   */
  A.bindMenu = function bindMenu(btn, menu, place) {
    const items = () => Array.from(menu.querySelectorAll('.menu-item')).filter(usable);
    const isOpen = () => !menu.classList.contains('hidden');
    const m = {
      btn, menu, isOpen,
      open(at) {
        menus.forEach((x) => { if (x !== m) x.close(false); });
        menu.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true');
        if (place) place(btn, menu); // 顯示後才量得到選單的寬度
        const list = items(); if (at !== undefined && list.length) list[at < 0 ? list.length - 1 : Math.min(at, list.length - 1)].focus();
      },
      close(refocus) {
        if (!isOpen()) return;
        menu.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false');
        if (refocus) btn.focus();
      },
    };
    menus.push(m);
    btn.addEventListener('click', () => (isOpen() ? m.close(false) : m.open(0)));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); m.open(e.key === 'ArrowDown' ? 0 : -1); }
    });
    menu.addEventListener('keydown', (e) => {
      const list = items(); const i = list.indexOf(document.activeElement);
      const go = (n) => { e.preventDefault(); if (list.length) list[(n + list.length) % list.length].focus(); };
      if (e.key === 'ArrowDown') go(i + 1);
      else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(-1);
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); m.close(true); }
      else if (e.key === 'Tab') m.close(false);
    });
    // 事件冒泡到選單：項目自己的 onclick 先執行，再依 data-keep 決定要不要關閉
    menu.addEventListener('click', (e) => {
      const item = Array.from(menu.querySelectorAll('.menu-item')).find((x) => x.contains(e.target));
      if (item && item.dataset.keep === undefined) m.close(false);
    });
    return m;
  };
  /** 收起路由追蹤表單；refocus 時焦點回到開啟它的「⋯」按鈕（Esc 收起時） */
  A.closeTrace = function closeTrace(refocus) { $('#trace-pop').classList.add('hidden'); if (refocus) $('#btn-more').focus(); };
  /** 點選單、路由追蹤以外的地方關閉它們；Esc 關閉開著的選單或路由追蹤，焦點回到開啟它的按鈕 */
  function bindDismiss() {
    const trace = $('#trace-pop');
    document.addEventListener('mousedown', (e) => {
      const t = e.target;
      menus.forEach((m) => { if (!m.btn.contains(t) && !m.menu.contains(t)) m.close(false); });
      if (!trace.contains(t) && !$('#more-menu').contains(t)) A.closeTrace(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = menus.find((m) => m.isOpen());
      if (open) { open.close(true); return; }
      if (!trace.classList.contains('hidden')) A.closeTrace(true);
    });
  }

  /**
   * 搜尋下拉的副標：Q.search 只回傳結構化欄位，顯示文字在這裡組成（名詞用 V.TERMS、V.KIND、V.IFC_TYPE、V.ifcState）。
   * VRF 在 main 時不寫；在多個 VRF 時寫出數量與名稱（前 VRF_NAMES 個），下拉選單就看得出位址重疊。
   */
  const VRF_NAMES = 4; const SUB_EPS = 3;
  const inVrfs = (vs) => (vs.length > 1 ? ` · 在 ${vs.length} 個 VRF：${vs.slice(0, VRF_NAMES).join('、')}${vs.length > VRF_NAMES ? '…' : ''}`
    : vs.length === 1 && vs[0] !== S.keys.MAIN_VRF ? ` · VRF ${vs[0]}` : '');
  A.searchSub = function searchSub(Q, r) {
    const join = (parts) => parts.filter(Boolean).join(' · ');
    if (r.type === 'mac') return r.found ? join([r.vendor, r.ips.join(', ')]) : '基準中沒有這個 MAC';
    if (r.type === 'ip') {
      const mgmt = r.owner && r.owner.endsWith('|');
      const what = r.owner ? (mgmt ? '管理 IP · ' + Q.devName(r.owner.slice(0, -1)) : '介面位址 · ' + Q.epName(r.owner))
        : r.macs.length ? 'ARP：' + r.macs.map(S.keys.macPretty).join(', ')
          : r.heard ? '鄰居宣告的位址'
            : r.subnetEp ? `屬於 ${Q.epName(r.subnetEp)} 的${V.TERMS.subnet}` : '基準中沒有這個 IP';
      return what + inVrfs(r.vrfs);
    }
    if (r.type === 'subnet') {
      const eps = r.eps.slice(0, SUB_EPS).map(Q.epName).join(', ') + (r.eps.length > SUB_EPS ? ` 等 ${r.eps.length} 個介面` : '');
      return V.TERMS.subnet + ' · ' + eps + inVrfs([r.vrf]);
    }
    if (r.type === 'vlan') {
      if (!r.found) return '基準中沒有這個 VLAN';
      return join([`${r.devices} 台設備${r.vlanDomains > 1 ? `（${r.vlanDomains} 個${V.TERMS.vlanDomain}）` : ''}`, r.names.join(' / ')]);
    }
    if (r.type === 'device') return join([V.KIND[r.kind] || r.kind, r.mgmtIp, r.collected ? '' : '未收集']);
    if (r.type === 'interface') {
      const desc = r.desc ? '描述：' + r.desc : '';
      return r.match === 'desc' ? desc : join([V.IFC_TYPE[r.ifType] || r.ifType, V.ifcState(r), desc]);
    }
    return '';
  };

  // ================================================================ 頁首
  A.bindHeader = function bindHeader() {
    A.bindMenu($('#btn-more'), $('#more-menu'));
    // 程式版本：沒有基準時也看得到（基準狀態卡的版本是建立該基準時的版本，兩者意義不同）
    $('#app-version').textContent = '版本 ' + S.VERSION;
    bindDismiss();
    // 路由追蹤表單是「⋯」旁邊的小對話框：從選單開啟（選單先關閉），也可由詳情的「追蹤路由」開啟（App.openTrace）
    $('#btn-trace').onclick = () => App.openTrace();
    $('#trace-run').onclick = A.runTrace;
    ['#trace-src', '#trace-dst', '#trace-vrf'].forEach((s) => $(s).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') A.runTrace();
      if (e.key === 'Escape') { e.stopPropagation(); A.closeTrace(true); }
    }));
    // 畫布每次繪圖都先填滿 theme 的畫布底色，匯出前同步重畫一次，PNG 才是目前畫面且不透明
    $('#btn-png').onclick = () => A.exportPng();
    $('#btn-clear').onclick = async () => {
      A.closeMenus();
      if (!App.snap || !confirm('清除目前的基準與輸入？（只清除這個工具的資料）')) return;
      await S.store.del('last'); A.clearRound(); App.sel = null; App.graph.setEmphasis(null); A.closeSheet();
      // 沒有基準時只有設備圖（歡迎畫面）：L2／L3 的資料與 VLAN 篩選一起清掉
      App.vlanFilter = null; A.resetLayers(); App.layer = 'device'; A.setDeviceGraph([], [], new Map()); A.renderAll();
    };
    // 搜尋
    const inp = $('#search'); const dd = $('#search-dd'); let results = []; let active = 0;
    const show = () => {
      V.clear(dd); if (!App.Q || !inp.value.trim()) { dd.classList.add('hidden'); return; }
      results = App.Q.search(inp.value, 15); active = 0;
      if (!results.length) dd.appendChild(h('div', { class: 'empty' }, '找不到符合的設備、MAC、IP、網段、VLAN 或介面'));
      const T = { device: '設備', mac: 'MAC', ip: 'IP', subnet: V.TERMS.subnet, vlan: 'VLAN', interface: '介面' };
      results.forEach((r, i) => dd.appendChild(h('div', {
        class: 'item' + (i === active ? ' active' : ''),
        onmousedown: (e) => { e.preventDefault(); pick(r); },
      }, [V.chip(T[r.type]), h('span', null, r.label), h('span', { class: 'sub' }, A.searchSub(App.Q, r))])));
      dd.classList.remove('hidden');
    };
    // 搜尋是「在圖上定位」：在 ④ 修正、⑤ 驗證時回到上一次看圖的 ② 或 ③，再選取
    const pick = (r) => { dd.classList.add('hidden'); inp.blur(); App.showView('graph'); App.select({ type: r.type, key: r.key }, { focus: true }); };
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
    // 選單放在 .grp 外面（.grp 會裁切），開啟時對齊按鈕的位置；窄螢幕放不下時往左移，不超出圖的右緣
    const under = (btn, menu) => {
      const tb = $('#toolbar'); const room = (tb.parentNode.clientWidth || 0) - (tb.offsetLeft || 0) - (menu.offsetWidth || 0) - 10;
      menu.style.left = Math.max(0, Math.min(btn.offsetLeft || 0, room > 0 ? room : Infinity)) + 'px';
    };
    A.bindMenu($('#btn-layout-menu'), $('#layout-menu'), under);
    A.bindMenu($('#btn-view-menu'), $('#view-menu'), under);
    $('#btn-fit').onclick = () => App.graph.fit();
    $('#btn-relayout').onclick = () => A.relayout();
    // 版面：分層（ELK）或快速（內建），單選；選了就依新的版面重新排列
    const modes = Array.from($('#layout-mode').querySelectorAll('.menu-item'));
    A.syncLayoutMode = () => modes.forEach((b) => A.setChecked(b, b.dataset.layout === App.layoutMode));
    A.syncLayoutMode();
    modes.forEach((b) => { b.onclick = () => {
      App.layoutMode = b.dataset.layout; A.syncLayoutMode(); A.closeMenus();
      S.store.set('layoutMode', App.layoutMode).catch(() => {});
      $('#btn-relayout').click();
    }; });
    let running = null; const force = $('#btn-force');
    force.onclick = () => {
      if (running) { cancelAnimationFrame(running); running = null; A.setChecked(force, false); A.savePositions(); return; }
      const nodes = App.graph.nodes.filter((n) => App.graph.visible(n)); const ids = new Set(nodes.map((n) => n.id));
      const edges = App.graph.edges.filter((e) => ids.has(e.a) && ids.has(e.b)); let temp = 60; let it = 0;
      // 使用者偏好減少動態效果時不播動畫：同樣的迭代一次算完，直接顯示結果
      if (A.reducedMotion()) {
        while (it < 360 && temp > 1) { V.layout.forceStep(nodes, edges, App.graph.pos, temp); temp *= 0.985; it++; }
        App.graph.computeGroups(); A.savePositions(); return;
      }
      A.setChecked(force, true);
      const step = () => {
        const per = nodes.length > 1500 ? 1 : 3;
        for (let k = 0; k < per; k++) { V.layout.forceStep(nodes, edges, App.graph.pos, temp); temp *= 0.985; it++; }
        App.graph.computeGroups();
        if (it < 360 && temp > 1) running = requestAnimationFrame(step); else { running = null; A.setChecked(force, false); A.savePositions(); }
      };
      running = requestAnimationFrame(step);
    };
    $('#btn-hosts').onclick = () => { App.showHosts = !App.showHosts; A.applyVisibility(); };
    $('#btn-unknown').onclick = () => { App.showUnknown = !App.showUnknown; A.applyVisibility(); };
    $('#btn-groups').onclick = () => {
      App.graph.showGroups = !App.graph.showGroups; A.setChecked($('#btn-groups'), App.graph.showGroups); App.graph.redraw();
    };
    buildLegend();
  };

  /** 使用者的「減少動態效果」偏好（瀏覽器沒有 matchMedia 時視為沒有偏好） */
  A.reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ================================================================ 圖例
  function buildLegend() {
    const lg = $('#legend'); const T = V.theme; const M = T.mark; const EDGE = V.EDGE_STYLE;
    // 圖例的外形、顏色、線寬、虛線與透明度全部取自 theme，與 Canvas 繪圖同一來源
    // 分五類，預設收合只顯示標題列；細節說明放 title，避免圖例太長
    const head = h('button', { class: 'legend-head', title: '展開／收合圖例', 'aria-expanded': 'false' }, '圖例 ▸');
    const body = h('div', { class: 'legend-body hidden' });
    head.onclick = () => {
      const open = body.classList.contains('hidden'); body.classList.toggle('hidden', !open);
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
    item([line(T.l3.overlap.c, T.l3.overlap.w, T.l3.overlap.dash, 1, { 'data-l3': 'overlap' })], '網段重疊（L3）', 'L3 網段圖：互相包含的網段之間的虛線，中點有警告外形；網段下方另標「重疊網段」「重複 IP」');
    group('標示');
    // 嚴重度：外形與畫布的 sevMark 相同（theme.sevShape），不只靠顏色
    Object.entries(T.sevShape).forEach(([k, shape]) => item([dot(Object.assign({ background: T.sev[k] }, SEV_CSS[shape]), { 'data-shape': shape })],
      V.SEV[k], `有${V.SEV[k]}的設備在右上角、鏈路在中點標示${shape === 'square' ? '方形' : '三角形'}`));
    item([ring(M.select, 3, 'select')], '選取', '目前選取的設備（藍色粗環）與鏈路');
    item([ring(M.hover, 2, 'hover')], '滑過', '指標或鍵盤（N 鍵）目前所在的設備（深色細環）；相連的線一起標示');
    item([ring(M.find, 3, 'find')], '搜尋結果', '搜尋 MAC／IP 時，標出所在位置的設備與鏈路');
    { // 推定偏離：節點外的虛線圓圈（theme.canvas.deviation）；圓周依 LEG 換算虛線長度
      const D = CV.deviation; const r = LEG / 2; const per = 360 / (Math.PI * LEG); let deg = 0;
      const stops = D.dash.map((n, i) => { const from = deg; deg += n * per; return `${i % 2 ? 'transparent' : D.c} ${from.toFixed(1)}deg ${deg.toFixed(1)}deg`; });
      const mask = `radial-gradient(circle, transparent ${(r - D.w).toFixed(1)}px, ${D.c} ${(r - D.w).toFixed(1)}px)`; // 遮罩只看不透明度
      item([dot({ background: `repeating-conic-gradient(${stops.join(', ')})`, maskImage: mask, webkitMaskImage: mask }, { 'data-mark': 'deviation' })], D.label, D.tip);
    }
    item([line(M.trace, 4, null, T.alpha.overlay, { 'data-mark': 'trace' }), h('span', { class: 'lg-arrow', style: { color: M.trace } }, '▶')], '路由追蹤', '逐跳路徑，箭頭表示方向');
    // VLAN 篩選：承載狀態（Q.vlanCarriers），線型與外形取自 theme.vlan，不只靠顏色
    const VL = { carry: ['VLAN 承載', '兩端都帶這個 VLAN（實線）'], inferred: ['VLAN 推論承載', '推論鏈路，已收集的各端都帶這個 VLAN（長虛線，推論）'],
      partial: ['VLAN 只有一端', '兩端都有 VLAN 資料，只有一端帶這個 VLAN（實線加垂直短刻度，中點有錯誤外形，V01）'], oneSide: ['VLAN 一端未知', '只有一端可確認：對端未收集、沒有 VLAN 資料或' + V.TERMS.hearsay + '（點線、淡色，推論）'] };
    Object.entries(T.vlan).forEach(([k, st]) => item([st.ticks ? tickLine(st.c, 4, st.ticks, st.alpha, { 'data-vlan': k }) : line(st.c, 4, st.dash, st.alpha, { 'data-vlan': k }),
      st.sev ? dot(Object.assign({ background: T.sev[st.sev] }, SEV_CSS[T.sevShape[st.sev]]), { 'data-shape': T.sevShape[st.sev] }) : null].filter(Boolean), VL[k][0], VL[k][1]));
  }
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
    App.graph.draw(); const a = document.createElement('a'); a.download = A.layerPngName(); a.href = $('#graph').toDataURL('image/png'); a.click();
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
