/*
 * 頁首與工具列：搜尋；圖的操作（全圖、版面▾、顯示▾、路由追蹤、匯出 PNG）；預設版面與清除基準的動作
 * （入口在設定，app-settings.js）。配色在 app-scheme.js，圖例與匯出（A.exportPng、App.exportAs）在 app-legend.js。輸入與輸出的入口集中在資料中心（app-hub.js）；工具列只留和圖有關的「匯出 PNG」（資料中心也有，呼叫同一個 A.exportPng）。
 * 下拉選單（版面、顯示）共用 A.bindMenu：方向鍵、Home／End 移動，Esc 關閉並把焦點還給按鈕，Tab 或點外面關閉。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = V.app; const App = window.App;

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
  /**
   * 工具列的選單與路由追蹤表單放在 .grp 外面（.grp 會裁切），開啟時對齊按鈕的位置；窄螢幕放不下時往左移，不超出圖的右緣
   */
  const placeUnder = (btn, menu) => {
    const tb = $('#toolbar'); const room = (tb.parentNode.clientWidth || 0) - (tb.offsetLeft || 0) - (menu.offsetWidth || 0) - 10;
    menu.style.left = Math.max(0, Math.min(btn.offsetLeft || 0, room > 0 ? room : Infinity)) + 'px';
  };
  /** 路由追蹤表單打開時（App.openTrace）：對齊工具列的「路由追蹤…」，按鈕的 aria-expanded 跟著 */
  A.placeTrace = function placeTrace() { placeUnder($('#btn-trace'), $('#trace-pop')); $('#btn-trace').setAttribute('aria-expanded', 'true'); };
  /** 收起路由追蹤表單；refocus 時焦點回到工具列的「路由追蹤…」（Esc 收起時） */
  A.closeTrace = function closeTrace(refocus) {
    $('#trace-pop').classList.add('hidden'); $('#btn-trace').setAttribute('aria-expanded', 'false');
    if (refocus) $('#btn-trace').focus();
  };
  /** 點選單、路由追蹤以外的地方關閉它們；Esc 關閉開著的選單或路由追蹤，焦點回到開啟它的按鈕 */
  function bindDismiss() {
    const trace = $('#trace-pop');
    document.addEventListener('mousedown', (e) => {
      const t = e.target;
      menus.forEach((m) => { if (!m.btn.contains(t) && !m.menu.contains(t)) m.close(false); });
      if (!trace.contains(t) && !$('#btn-trace').contains(t)) A.closeTrace(false);
    });
    // Esc 的先後由 A.onEscape（app.js）決定：選單、路由追蹤在資料中心與抽屜之前
    A.onEscape('menu', () => { const open = menus.find((m) => m.isOpen()); if (open) open.close(true); return !!open; });
    A.onEscape('trace', () => { if (trace.classList.contains('hidden')) return false; A.closeTrace(true); return true; });
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
    bindDismiss();
    // 路由追蹤表單是工具列「路由追蹤…」下方的小對話框：按鈕開關，也可由詳情的「追蹤路由」開啟（App.openTrace）
    $('#btn-trace').onclick = () => ($('#trace-pop').classList.contains('hidden') ? App.openTrace() : A.closeTrace(false));
    $('#trace-run').onclick = A.runTrace;
    // 對調：交換來源與目的（例如看完去程再看回程），焦點留在按鈕
    $('#trace-swap').onclick = () => { const s = $('#trace-src'); const d = $('#trace-dst'); [s.value, d.value] = [d.value, s.value]; };
    ['#trace-src', '#trace-dst', '#trace-vrf'].forEach((s) => $(s).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') A.runTrace();
      if (e.key === 'Escape') { e.stopPropagation(); A.closeTrace(true); }
    }));
    // 畫布每次繪圖都先填滿 theme 的畫布底色，匯出前同步重畫一次，PNG 才是目前畫面且不透明
    $('#btn-png').onclick = () => A.exportPng();
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
      }, [V.chip(T[r.type]), h('span', null, r.type === 'device' ? App.Q.devLabel(r.key) : r.label), h('span', { class: 'sub' }, A.searchSub(App.Q, r))])));
      dd.classList.remove('hidden');
    };
    // 搜尋是「在圖上定位」：在「修正」、「驗證」時回到上一次看圖的「檢視」或「研判」，再選取
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
    A.bindMenu($('#btn-layout-menu'), $('#layout-menu'), placeUnder);
    A.bindMenu($('#btn-view-menu'), $('#view-menu'), placeUnder);
    $('#btn-fit').onclick = () => App.graph.fit();
    // VLAN 篩選的標示：按下或按 Esc 取消篩選，焦點移到 VLAN 選單（標示隨即隱藏）；Esc 不往外傳（不會同時取消選取）
    const chip = $('#vlan-chip');
    const clearFilter = () => { A.clearVlanFilter(); $('#vlan-filter').focus(); };
    chip.onclick = clearFilter;
    chip.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clearFilter(); } });
    $('#btn-relayout').onclick = () => A.relayout();
    // 版面：分層（ELK）或快速（內建），單選；選了就依新的版面重新排列。選擇就是預設版面（store 的 'layoutMode'，設定「一般」也改同一個）
    const modes = Array.from($('#layout-mode').querySelectorAll('.menu-item'));
    A.syncLayoutMode = () => { modes.forEach((b) => A.setChecked(b, b.dataset.layout === App.layoutMode)); A.syncSettingsControls(); };
    A.syncLayoutMode();
    modes.forEach((b) => { b.onclick = () => { A.closeMenus(); A.setLayoutMode(b.dataset.layout); $('#btn-relayout').click(); }; });
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
    A.buildLegend();
  };

  /** 版面的模式（App.LAYOUT_MODES 之一）：工具列「版面 ▾」與設定「一般」的「預設版面」共用。存進 store 的 'layoutMode'，下次開啟沿用；不重新排列 */
  App.LAYOUT_MODES = ['elk', 'builtin'];
  A.setLayoutMode = function setLayoutMode(mode) {
    if (!App.LAYOUT_MODES.includes(mode)) throw new RangeError('未知的版面：' + mode);
    App.layoutMode = mode; A.syncLayoutMode();
    S.store.set('layoutMode', mode).catch((e) => A.banner('無法儲存預設版面：' + V.reason(e) + '。這次有效，關閉頁面後不會保留。', 8000));
  };
  /** 清除這個工具儲存的基準與輸入（設定「本機資料」的「清除基準…」，先確認）；處理紀錄不受影響。回傳是否清除了 */
  App.clearBaseline = async function () {
    A.closeMenus();
    if (!App.snap || !confirm('清除目前的基準與輸入？（只清除這個工具的資料，處理紀錄保留）')) return false;
    await S.store.del('last'); A.resetBaselineView(); A.renderAll(); // 收起畫面上的基準只有一份實作（app.js）
    return true;
  };
})(globalThis.SSOT = globalThis.SSOT || {});
