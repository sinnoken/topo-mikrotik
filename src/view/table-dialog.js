/*
 * 表格視窗（V.tableDialog）：置中、強制回應的大視窗（原生 <dialog id="dlg-table">，做法同原文對話框 #dlg-raw）。
 * 給右欄放不下的表格用（防火牆規則 panels/firewall.js、路由表 panels/routes.js）。左欄是分頁＋表格（每個分頁經 V.bigList），右欄是選取那一列的詳情，
 * 沒選列時是 empty() 的內容。寬度 900px 以下（V.app.isNarrowScreen，和其他窄螢幕版面同一個斷點）全螢幕、單欄：選了一列時只顯示詳情，
 * 「返回」回到表格，頁碼、展開的組與焦點都還在（左欄不重畫）。
 * 開關、焦點歸還、Esc、遮罩與狀態列只在這裡做一次；內容由呼叫端的函式產生，資料一律經呼叫端（App.Q）取得。
 * 選取哪一列是檢視狀態，只在這個元件與呼叫端的 onSelect（例如 App.sel），不進基準。
 *
 *   const dlg = V.tableDialog.open({
 *     id,                       // 視窗的識別（例如 'firewall|<設備鍵>'）；V.tableDialog.current().id 用它判斷要更新還是重開
 *     title,                    // 標題文字
 *     head?: () => Node,        // 分頁上方的一列（例如狀態 chip）
 *     tabs: [{ key, label, count?, extra?: [Node], rows, columns, rowKey(row),
 *              selectable?: true（false 時列不能點，例如 interface list），empty?: '沒有列時的說明',
 *              // 以下原樣交給 V.bigList（columns 的 inGroup: false、groups、grouped、text、match、unit、what、placeholder）
 *              groups?, grouped?, text?, match?, unit?, what?, placeholder?,
 *              table?: { bad, rowClass, rowStyle, rowAttrs } }],
 *     detail(row, tabKey) → Node,  // 右欄：選取的那一列（第一個 h2／h3 是選取後焦點的去處）
 *     empty() → Node,              // 右欄：沒有選取時
 *     initial?: { tab, row: rowKey, group: 組的 key, search: '搜尋字' },
 *     onSelect?(rowKey | null, tabKey),  // 使用者在表格選取或「返回」取消選取時（寬螢幕）通知呼叫端；handle.select 不會呼叫它
 *     onClose?(),                        // 使用者關閉（✕、Esc、點遮罩）時
 *     fallbackFocus?: () => Element,     // 開啟它的元素已不在頁面上時，關閉後焦點改去哪裡
 *   });
 *   dlg.select(tabKey, rowKey | null, { reveal })  // 從外部改選取（reveal：列不在畫面上時重畫那個分頁並翻到它）；不呼叫 onSelect
 *   dlg.refresh()        // 重畫右欄（例如算完 L4 影響）
 *   dlg.status(text)     // 視窗自己的狀態列（role=status）：banner 在強制回應視窗的遮罩底下看不到
 *   dlg.close({ focus }) // focus 預設 true：焦點回到開啟它的元素
 *   dlg.selected()       // { tab, key }
 *   V.tableDialog.current() → 開著的 handle 或 null
 *   V.tableDialog.hasFocus() → 焦點是否在開著的視窗裡（follow 關掉視窗後，呼叫端依它把焦點移到右欄新內容的標題）
 *   V.tableDialog.owner({ idOf, show, detailSel })、V.tableDialog.follow(App, sel)：視窗跟著選取開關（見檔尾）
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  let cur = null; // 開著的視窗：{ cfg, handle, tab, key, panels: Map(tabKey → 元素), opener }
  let bound = false;

  const dlgEl = () => $('#dlg-table');
  const bodyEl = () => $('#tdlg-body');
  const narrow = () => !!(V.app && V.app.isNarrowScreen && V.app.isNarrowScreen());
  const tabOf = (key) => cur.cfg.tabs.find((t) => t.key === key) || null;
  const rowOf = (tab, key) => (tab && key != null ? tab.rows.find((r) => tab.rowKey(r) === key) || null : null);
  /** 一個容器內 data-key 為 key 的列（鍵可能含 |，不組 CSS 選擇器） */
  const rowsByKey = (root, key) => Array.from(root.querySelectorAll('tr')).filter((tr) => tr.getAttribute('data-key') === key);

  function bind() {
    if (bound) return; bound = true;
    const dlg = dlgEl();
    // CSP 不放行內嵌事件屬性：控制項在第一次開啟前綁定（視窗只經 V.tableDialog.open 開啟）
    $('#tdlg-close').addEventListener('click', () => close({ user: true }));
    // Esc：自己關（焦點歸還與 onClose 走同一條路），不讓瀏覽器的預設動作與頁面的 Esc（A.onEscape）再處理一次
    dlg.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !cur) return;
      e.preventDefault(); e.stopPropagation(); close({ user: true });
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (cur) close({ user: true }); });
    // 點遮罩：點到的是 <dialog> 本身（內容 .dlg 填滿整個視窗）
    dlg.addEventListener('click', (e) => { if (e.target === dlg && cur) close({ user: true }); });
    // 其他原因關閉（例如瀏覽器的關閉要求）：一樣收尾
    dlg.addEventListener('close', () => { if (cur && !cur.closing) finish(cur, true); });
  }

  function open(cfg) {
    bind();
    const dlg = dlgEl();
    const keep = cur && dlg.open ? cur.opener : document.activeElement;
    if (cur) cur.closed = true; // 換成新的內容：舊的 handle 失效
    const first = (cfg.initial && cfg.initial.tab && cfg.tabs.some((t) => t.key === cfg.initial.tab)) ? cfg.initial.tab : (cfg.tabs[0] || {}).key;
    const ini = cfg.initial || {};
    const st = { cfg, tab: first, key: null, panels: new Map(), controls: new Map(), opener: keep, closed: false };
    if (ini.row != null && rowOf(cfg.tabs.find((t) => t.key === first), ini.row)) st.key = ini.row;
    st.handle = handleOf(st);
    cur = st;
    $('#tdlg-title').textContent = cfg.title; $('#tdlg-status').textContent = '';
    const body = V.clear(bodyEl());
    const tablist = h('div', { class: 'tdlg-tabs', role: 'tablist', 'aria-label': cfg.title },
      cfg.tabs.map((t) => h('button', { type: 'button', role: 'tab', class: 'tdlg-tab', id: 'tdlg-tab-' + t.key, 'data-tab': t.key, 'aria-controls': 'tdlg-panel-' + t.key,
        onclick: () => showTab(t.key, true), onkeydown: tabKeys }, [t.label, t.count ? ' ' : null, t.count ? V.chip(V.num(t.count), 'count') : null])));
    const list = h('div', { class: 'tdlg-list', id: 'tdlg-list' }, [cfg.head ? cfg.head() : null, cfg.tabs.length ? tablist : null]);
    cfg.tabs.forEach((t) => list.appendChild(h('div', { class: 'tdlg-panel', role: 'tabpanel', id: 'tdlg-panel-' + t.key, 'aria-labelledby': 'tdlg-tab-' + t.key, hidden: true })));
    body.appendChild(list);
    body.appendChild(h('div', { class: 'tdlg-side', id: 'tdlg-side', 'aria-live': 'polite' }));
    if (first) showTab(first, false, { reveal: st.key, group: ini.group, search: ini.search });
    renderSide(); syncView();
    if (!dlg.open) dlg.showModal();
    // 焦點：開啟時有選取 → 右欄的標題；沒有 → 視窗的標題
    if (st.key != null) { revealRow(); focusSide(); } else $('#tdlg-title').focus();
    return st.handle;
  }

  /** 分頁的內容：第一次切到時才建（之後切換只隱藏，展開的組、頁碼與搜尋字都保留） */
  function buildPanel(t, o) {
    const panel = $('#tdlg-panel-' + t.key) || bodyEl().querySelector('#tdlg-panel-' + t.key);
    V.clear(panel);
    const extra = (t.extra || []).filter(Boolean);
    if (extra.length) panel.appendChild(h('div', { class: 'row tdlg-extra' }, extra));
    if (!t.rows.length) { panel.appendChild(h('p', { class: 'muted' }, t.empty || '沒有資料。')); cur.panels.set(t.key, panel); return panel; }
    const selectable = t.selectable !== false;
    const isSel = (r) => cur && cur.tab === t.key && cur.key != null && t.rowKey(r) === cur.key;
    const user = t.table || {};
    const table = Object.assign({}, user, {
      label: t.label, selectable, stack: true, // stack：900px 以下每列一塊（欄名寫在格前），不橫捲
      isSelected: isSel,
      rowAttrs: (r) => Object.assign({}, user.rowAttrs ? user.rowAttrs(r) : null,
        { 'data-key': t.rowKey(r), 'aria-selected': selectable ? String(isSel(r)) : null }),
      rowClass: (r) => [user.rowClass ? user.rowClass(r) || '' : '', isSel(r) ? 'focus' : ''].join(' '),
    });
    const reveal = o && o.reveal != null ? rowOf(t, o.reveal) : null;
    const groups = t.groups && o && o.group != null ? () => t.groups().map((g) => (g.key === o.group ? Object.assign({}, g, { open: true }) : g)) : t.groups;
    const control = {};
    panel.appendChild(V.bigList(t.columns, t.rows, {
      table, onRow: selectable ? (r) => pick(t.key, t.rowKey(r)) : null, groups, grouped: t.grouped, text: t.text, match: t.match,
      unit: t.unit, what: t.what, placeholder: t.placeholder, reveal, search: o && o.search, control,
    }));
    cur.panels.set(t.key, panel); cur.controls.set(t.key, control);
    return panel;
  }
  function showTab(key, focus, o) {
    const t = tabOf(key); if (!t) return;
    // cur.view 是顯示中的分頁；cur.tab 是選取那一列所在的分頁（換分頁不取消選取，右欄照舊）
    cur.view = key; if (cur.key == null) cur.tab = key;
    if (!cur.panels.has(key) || (o && o.rebuild)) buildPanel(t, o);
    cur.cfg.tabs.forEach((x) => {
      const on = x.key === key; const b = bodyEl().querySelector('#tdlg-tab-' + x.key); const p = bodyEl().querySelector('#tdlg-panel-' + x.key);
      b.setAttribute('aria-selected', String(on)); b.setAttribute('tabindex', on ? '0' : '-1'); b.classList.toggle('on', on);
      if (on) p.removeAttribute('hidden'); else p.setAttribute('hidden', '');
    });
    if (focus) bodyEl().querySelector('#tdlg-tab-' + key).focus();
  }
  /** 分頁列的鍵盤：←→ 換分頁（Home／End 到頭尾），焦點跟著 */
  function tabKeys(e) {
    const keys = cur.cfg.tabs.map((t) => t.key); const n = keys.indexOf(cur.view);
    const to = { ArrowRight: n + 1, ArrowLeft: n - 1, Home: 0, End: keys.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault(); showTab(keys[(to + keys.length) % keys.length], true);
  }

  /** 選取的列：class focus（樣式在 CSS，顏色是 --row-focus-*）、aria-selected、只有它是 Tab 停留點 */
  function mark() {
    cur.panels.forEach((panel, tabKey) => {
      panel.querySelectorAll('tbody').forEach((tb) => {
        const trs = Array.from(tb.children).filter((tr) => tr.getAttribute('aria-selected') != null);
        if (!trs.length) return;
        trs.forEach((tr) => {
          const on = tabKey === cur.tab && cur.key != null && tr.getAttribute('data-key') === cur.key;
          tr.classList.toggle('focus', on); tr.setAttribute('aria-selected', String(on));
        });
        const at = Math.max(0, trs.findIndex((tr) => tr.classList.contains('focus')));
        trs.forEach((tr, i) => tr.setAttribute('tabindex', i === at ? '0' : '-1'));
      });
    });
  }
  /** 畫出來的那一列不在被隱藏的區塊裡（例如有搜尋字時的摘要）；收合的組不算，定位時展開它 */
  const unhidden = (panel, tr) => { for (let x = tr.parentNode; x && x !== panel; x = x.parentNode) if (x.getAttribute('hidden') != null) return false; return true; };
  /**
   * 選取的列看得到，捲到中間。依序：
   *   ① 已畫出、不在被隱藏的區塊裡（包括搜尋結果中的那一列：保留搜尋字）→ 展開它所在的組；
   *   ② 搜尋結果沒有它 → 清掉搜尋字，回到摘要（展開的組、頁碼與排序都保留），再找一次；
   *   ③ 還是沒畫出（組沒展開過或在別頁）→ 重畫那個分頁並翻到它（展開它所在的組；這個分頁的排序與其他組的展開回到預設）。
   */
  function revealRow() {
    if (cur.key == null) return;
    if (cur.view !== cur.tab) showTab(cur.tab, false);
    const panel = () => cur.panels.get(cur.tab);
    const find = () => rowsByKey(panel(), cur.key).find((tr) => unhidden(panel(), tr)) || null;
    let tr = find();
    if (!tr) { const c = cur.controls.get(cur.tab); if (c && c.clearSearch && c.clearSearch()) { mark(); tr = find(); } }
    if (!tr) { showTab(cur.tab, false, { rebuild: true, reveal: cur.key }); tr = find(); }
    if (!tr) return;
    for (let x = tr.parentNode; x && x !== panel(); x = x.parentNode) if (x.tagName === 'DETAILS' && !x.open) { x.open = true; x.setAttribute('open', ''); }
    tr.scrollIntoView({ block: 'center' });
  }
  function renderSide() {
    const side = V.clear(bodyEl().querySelector('#tdlg-side'));
    const t = tabOf(cur.tab); const row = rowOf(t, cur.key);
    if (row) {
      side.appendChild(h('div', { class: 'tdlg-side-head' }, h('button', { type: 'button', class: 'ghost tdlg-back', onclick: back,
        title: narrow() ? '回到表格（選取、頁碼與展開的組都保留）' : '取消選取，回到總覽' }, '‹ 返回')));
    }
    side.appendChild((row ? cur.cfg.detail(row, cur.tab) : cur.cfg.empty()) || h('p', { class: 'muted' }, '—'));
  }
  /** 窄螢幕單欄：data-view 是 detail（只顯示右欄）或 list；data-selected 表示有選取（list 時右欄不顯示） */
  function syncView() {
    const b = bodyEl();
    b.setAttribute('data-view', cur.key != null && !cur.listView ? 'detail' : 'list');
    if (cur.key != null) b.setAttribute('data-selected', ''); else b.removeAttribute('data-selected');
  }
  function focusSide() {
    const side = bodyEl().querySelector('#tdlg-side');
    const hd = side.querySelector('h2') || side.querySelector('h3');
    if (hd) { hd.setAttribute('tabindex', '-1'); hd.focus(); }
  }
  const focusRow = () => {
    const tr = cur.key != null && cur.panels.get(cur.tab) ? rowsByKey(cur.panels.get(cur.tab), cur.key)[0] : null;
    (tr || bodyEl().querySelector('#tdlg-tab-' + cur.view) || $('#tdlg-title')).focus();
  };
  /** 使用者在表格點一列（或 Enter）：寬螢幕焦點留在那一列，窄螢幕移到詳情的標題 */
  function pick(tabKey, key) {
    const st = cur;
    select(tabKey, key); st.listView = false; syncView();
    if (st.cfg.onSelect) st.cfg.onSelect(key, tabKey);
    if (cur !== st) return; // onSelect 換掉了視窗內容
    if (narrow()) focusSide(); else focusRow();
  }
  /** 「返回」：窄螢幕回到表格（保留選取、頁碼、展開的組，焦點回到那一列）；寬螢幕取消選取、右欄回到總覽 */
  function back() {
    const st = cur; const key = st.key; const tabKey = st.tab;
    if (narrow()) { st.listView = true; syncView(); focusRow(); return; }
    select(tabKey, null);
    if (st.cfg.onSelect) st.cfg.onSelect(null, tabKey);
    if (cur !== st) return;
    const tr = rowsByKey(st.panels.get(tabKey), key)[0]; (tr || $('#tdlg-title')).focus();
  }
  function select(tabKey, key, o) {
    if (!cur) return;
    const t = tabKey ? tabOf(tabKey) : null;
    cur.key = t && rowOf(t, key) ? key : null;
    if (cur.key != null) cur.tab = tabKey;
    cur.listView = false;
    mark(); renderSide(); syncView();
    if (o && o.reveal) revealRow();
  }

  function close(o) {
    const st = cur; if (!st) return;
    const opt = Object.assign({ focus: true, user: false }, o);
    // 先關（瀏覽器在 close() 裡把焦點還給開啟前的元素），再由 finish 決定焦點的去處；close 事件不再收尾一次
    st.closing = true; dlgEl().close();
    finish(st, opt.user, opt.focus);
  }
  /** 收尾：只做一次；user 時通知呼叫端；focus 時焦點回到開啟它的元素（不在頁面上時改去 fallbackFocus） */
  function finish(st, user, focus) {
    if (st.closed) return;
    st.closed = true; if (cur === st) cur = null;
    if (user && st.cfg.onClose) st.cfg.onClose();
    if (focus === false) return;
    const op = st.opener && st.opener !== document.body && document.body.contains(st.opener) ? st.opener : st.cfg.fallbackFocus ? st.cfg.fallbackFocus() : null;
    if (op) op.focus();
  }

  function handleOf(st) {
    const live = () => cur === st && !st.closed;
    return {
      get id() { return st.cfg.id; },
      select: (tabKey, key, o) => { if (live()) { select(tabKey, key, o); if (o && o.focus && st.key != null) focusSide(); } },
      refresh: () => {
        if (!live()) return;
        const side = bodyEl().querySelector('#tdlg-side'); const inSide = side.contains(document.activeElement);
        renderSide(); if (inSide) focusSide();
      },
      status: (text) => { if (live()) $('#tdlg-status').textContent = text; },
      close: (o) => { if (live()) close(o); },
      isOpen: live,
      selected: () => ({ tab: st.tab, key: st.key }),
    };
  }

  /*
   * 視窗跟著選取（App.sel）：每種視窗的擁有者（防火牆、路由表）在載入時登錄 { idOf(App, sel) → 視窗 id｜null, show(App, sel), detailSel(App, sel) }。
   * details.render 每次選取都呼叫 follow：開著的視窗不是這個選取的（沒有擁有者認領，或認領的 id 不同）時關閉，回傳認領的擁有者（由它開啟或更新視窗）。
   * 哪個選取屬於哪個視窗只由擁有者的 idOf 決定，詳情不必知道有哪些視窗。
   */
  const owners = [];
  function owner(o) { owners.push(o); }
  function follow(App, sel) {
    let own = null; let id = null;
    if (App.Q && sel) for (const o of owners) { id = o.idOf(App, sel); if (id != null) { own = o; break; } }
    const d = cur && !cur.closed ? cur.handle : null;
    // 焦點在視窗裡（例如點了詳情裡的連結）而且選到的不屬於任何視窗：不把焦點還給開啟它的入口（右欄接著重畫，入口會被移除），
    // 由呼叫端畫完新內容後把焦點移到它的標題（hasFocus 在 follow 之前問）
    if (d && d.id !== id) d.close({ focus: !(own == null && hasFocus()) });
    return own;
  }
  /** 焦點在開著的視窗裡 */
  const hasFocus = () => !!(cur && !cur.closed && dlgEl().contains(document.activeElement));

  V.tableDialog = { open, owner, follow, hasFocus, current: () => (cur && !cur.closed ? cur.handle : null) };
})(globalThis.SSOT = globalThis.SSOT || {});
