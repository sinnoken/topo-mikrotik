/*
 * 版面框架：左側分頁、中間的工作畫面、窄螢幕工作區切換、左右欄寬度（拖曳與還原）。
 * 欄寬是檢視狀態，存在 store 的 'layout' 鍵；中間顯示哪一個工作畫面也是檢視狀態，不存進 store。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = V.app; const App = window.App;

  // ================================================================ 中間的工作畫面
  /**
   * 中間的工作畫面：拓樸圖（預設）、修正計畫、比對、收斂趨勢。切換按鈕是 tablist／tab（一次只顯示一個畫面）：
   * 方向鍵、Home、End 移動並切換，Tab 進入畫面。
   * 工作畫面疊在拓樸圖上（index.html 的 #stage，同一格）：畫布的大小不變、不重新排列，位置、縮放與選取都保留，
   * 從工作畫面匯出的 PNG 也是同一張圖。拓樸圖被蓋住時設為 inert，鍵盤不會移到底下的畫布。
   * 只重繪目前顯示的工作畫面（大型網路的修正計畫與比對很大）；資料中心仍是整個主畫面上的另一層（app-hub.js）。
   */
  const VIEWS = ['graph', 'patch', 'compare', 'trend'];
  App.centerView = 'graph';
  const tabOf = (view) => $('#view-tab-' + view);
  /** 重繪目前顯示的工作畫面（拓樸圖只標記重畫，不重新排列） */
  A.renderCenter = function renderCenter() {
    const v = App.centerView;
    if (v === 'patch') V.patchView.refresh(App);
    else if (v === 'compare') V.lists.compare(App);
    else if (v === 'trend') V.ledgerPane.renderTrend(App);
    else if (App.graph) App.graph.redraw();
  };
  /** 顯示 v 這個工作畫面：分頁的選取狀態、工作畫面的顯示與拓樸圖的 inert，並重繪它 */
  function apply(v) {
    App.centerView = v;
    $('#center').dataset.view = v;
    VIEWS.forEach((x) => {
      const t = tabOf(x); const on = x === v;
      t.setAttribute('aria-selected', String(on)); t.setAttribute('tabindex', on ? '0' : '-1'); t.classList.toggle('on', on);
      if (x !== 'graph') $('#view-' + x).classList.toggle('hidden', !on);
    });
    $('#view-graph').inert = v !== 'graph';
    if (v !== 'graph') $('#tooltip').classList.add('hidden'); // 鍵盤 N 移到設備時顯示的提示不留在工作畫面上
    A.renderCenter();
  }
  /** 沒有基準時只有拓樸圖（歡迎畫面）：其他分頁停用，顯示中的工作畫面切回拓樸圖 */
  A.syncCenterTabs = function syncCenterTabs() {
    const has = !!App.snap;
    VIEWS.slice(1).forEach((v) => { tabOf(v).disabled = !has; });
    if (!has && App.centerView !== 'graph') apply('graph');
  };
  /**
   * 切換中間的工作畫面。opt.focus：'tab' 焦點移到切換按鈕（鍵盤在分頁間移動時）；true 焦點移到工作畫面的標題
   * （從其他地方的按鈕開啟時，例如「修正計畫…」）；拓樸圖則移到畫布。省略時焦點不動（點分頁時留在分頁上）。
   * 沒有基準時只能顯示拓樸圖。資料中心開著時先關閉，好看到工作畫面；窄螢幕切到中間的工作區。
   */
  App.showView = function (view, opt) {
    if (!VIEWS.includes(view)) throw new RangeError('未知的工作畫面：' + view);
    const o = opt || {};
    const v = view !== 'graph' && !App.snap ? 'graph' : view;
    A.closeHub();
    apply(v);
    if (A.isNarrowScreen()) A.setWorkspace('graph');
    if (o.focus === 'tab') tabOf(v).focus();
    else if (o.focus) (v === 'graph' ? $('#graph') : $('#' + v + '-title')).focus();
  };
  A.bindCenterViews = function bindCenterViews() {
    const tabs = Array.from(document.querySelectorAll('#center-views button'));
    tabs.forEach((t) => {
      t.addEventListener('click', () => App.showView(t.dataset.view));
      t.addEventListener('keydown', (e) => {
        const usable = tabs.filter((x) => !x.disabled); const at = usable.indexOf(t);
        const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: usable.length - 1 }[e.key];
        if (next === undefined || at < 0) return;
        e.preventDefault();
        App.showView(usable[(next + usable.length) % usable.length].dataset.view, { focus: 'tab' });
      });
    });
  };

  // 左右欄寬度是檢視狀態：存在獨立的 'layout' 鍵，清除基準時不受影響
  const PANE = { min: 240, centerMin: 320, def: { left: 330, right: 400 } };
  A.bindResizers = async function bindResizers() {
    const main = $('#main'); const sides = { left: $('#left'), right: $('#right') };
    const saved = (await S.store.get('layout').catch(() => null)) || {};
    App.layout = { left: PANE.def.left, right: PANE.def.right };
    const clamp = (side, w) => {
      const other = App.layout[side === 'left' ? 'right' : 'left']; const total = window.innerWidth || Infinity;
      return Math.round(Math.max(PANE.min, Math.min(w, total - other - PANE.centerMin)));
    };
    const apply = () => { main.style.gridTemplateColumns = `${App.layout.left}px 1fr ${App.layout.right}px`; };
    ['left', 'right'].forEach((side) => { if (Number.isFinite(saved[side])) App.layout[side] = clamp(side, saved[side]); });
    apply();
    const persist = () => S.store.set('layout', Object.assign({}, App.layout)).catch(() => {});
    ['left', 'right'].forEach((side) => {
      const grip = h('div', { class: 'grip grip-' + side, title: '拖曳調整寬度，雙擊還原' });
      sides[side].appendChild(grip);
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault(); const x0 = e.clientX; const w0 = App.layout[side];
        const move = (ev) => { App.layout[side] = clamp(side, w0 + (side === 'left' ? 1 : -1) * (ev.clientX - x0)); apply(); };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); grip.classList.remove('on'); persist(); };
        grip.classList.add('on'); document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
      grip.addEventListener('dblclick', () => { App.layout[side] = clamp(side, PANE.def[side]); apply(); persist(); });
    });
  };
  // ================================================================ 左側分頁與窄螢幕工作區
  A.bindTabs = function bindTabs() {
    document.querySelectorAll('#left .tabs button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#left .tabs button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('#left .pane').forEach((p) => p.classList.toggle('hidden', p.id !== b.dataset.pane));
    }));
  };
  A.isNarrowScreen = function isNarrowScreen() { return Number(window.innerWidth) <= 900; };
  A.setWorkspace = function setWorkspace(workspace) {
    $('#main').dataset.workspace = workspace;
    document.querySelectorAll('#mobile-workspaces button').forEach((button) => {
      const active = button.dataset.workspace === workspace;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };
  A.bindMobileWorkspaces = function bindMobileWorkspaces() {
    document.querySelectorAll('#mobile-workspaces button').forEach((button) => button.addEventListener('click', () => {
      A.setWorkspace(button.dataset.workspace);
    }));
  };
  A.activatePane = function activatePane(pane) {
    A.closeHub();
    const button = Array.from(document.querySelectorAll('#left .tabs button')).find((item) => item.dataset.pane === pane);
    if (button) button.click();
    A.setWorkspace('checks');
  };
})(globalThis.SSOT = globalThis.SSOT || {});
