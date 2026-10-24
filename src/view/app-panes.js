/*
 * 版面框架：上方的流程步驟（① 輸入 ② 檢視 ③ 分診 ④ 修正 ⑤ 驗證）、左側的清單、中間的工作畫面、窄螢幕工作區切換、左右欄寬度（拖曳與還原）。
 * 欄寬是檢視狀態，存在 store 的 'layout' 鍵；目前在哪一步、中間顯示哪一個工作畫面也是檢視狀態，不存進 store。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = V.app; const App = window.App;

  // ================================================================ 流程步驟
  /**
   * 每一步的左側清單與中間的工作畫面：
   *   ① input   資料中心（蓋住主畫面的另一層，app-hub.js）：這一輪的輸入、覆蓋率與輸出
   *   ② view    左：清單（設備、介面、IP、網段、MAC、VLAN）；中：拓樸圖（工具列的層級切換：設備、L2 埠、L3 子網）
   *   ③ triage  左：檢查結果（決定修、接受或標為誤報）；中：拓樸圖
   *   ④ fix     中：修正計畫（全寬，裡面的「要修正哪些」在左欄）
   *   ⑤ verify  中：驗證（本輪變化、處理紀錄、修復追蹤、收斂趨勢、比對；全寬）
   * App.step 是主畫面那一步（②–⑤）；資料中心開著時目前的一步是 ①，關閉後回到 App.step。
   * 步驟列是導覽（nav），目前的一步是 aria-current="step"；沒有基準時 ④、⑤ 停用（aria-disabled，仍可聚焦與朗讀原因）。
   */
  const STEPS = ['input', 'view', 'triage', 'fix', 'verify'];
  const WORK = {
    view: { left: 'pane-inventory', title: '清單', center: 'graph' },
    triage: { left: 'pane-findings', title: '檢查結果', center: 'graph' },
    fix: { left: null, center: 'patch' },
    verify: { left: null, center: 'verify' },
  };
  A.STEP_LABEL = { input: '① 輸入', view: '② 檢視', triage: '③ 分診', fix: '④ 修正', verify: '⑤ 驗證' };
  const STEP_TITLE = {
    input: '資料中心：這一輪的輸入（收集檔、工作包、處理紀錄、命名規則、預期資料）、覆蓋率與輸出',
    view: '左邊是清單（設備、介面、IP、網段、MAC、VLAN），中間是拓樸圖（設備、L2 埠、L3 子網）',
    triage: '左邊是檢查結果（決定修、接受或標為誤報），中間是拓樸圖，右邊是證據與處理建議',
    fix: '中間是修正計畫：選取檢查結果，預覽修改前後，下載套用、回復與驗證的 .rsc',
    verify: '中間是本輪變化、修復追蹤、收斂趨勢與比對：確認哪些已修好、哪些回歸',
  };
  const CENTER_LABEL = { graph: '拓樸圖', patch: '修正計畫', verify: '驗證' };
  const needsSnap = (s) => s === 'fix' || s === 'verify';
  const stepBtn = (s) => $('#step-' + s);
  App.step = 'triage';
  App.centerView = 'graph';
  // 上一次看拓樸圖的那一步（② 或 ③）：搜尋與路由追蹤從 ④、⑤ 回到拓樸圖時回到這一步
  let graphStep = 'triage';
  /** 目前的一步：資料中心開著時是 ①，否則是主畫面那一步 */
  A.currentStep = () => (A.hubOpen() ? 'input' : App.step);

  /** 重繪目前顯示的工作畫面（拓樸圖只標記重畫，不重新排列）；大型網路的修正計畫與比對很大，只畫顯示中的那一個 */
  A.renderCenter = function renderCenter() {
    const v = App.centerView;
    if (v === 'patch') V.patchView.refresh(App);
    else if (v === 'verify') { V.ledgerPane.renderTrend(App); V.lists.compare(App); }
    else if (App.graph) App.graph.redraw();
  };
  /** 換到 s 這一步（②–⑤）：左側清單、中間的工作畫面、拓樸圖的 inert、欄寬、窄螢幕工作區與步驟列，並重繪工作畫面 */
  function apply(s) {
    const w = WORK[s];
    App.step = s; App.centerView = w.center;
    if (w.center === 'graph') graphStep = s;
    $('#main').dataset.step = s;
    $('#center').dataset.view = w.center;
    $('#left').classList.toggle('hidden', !w.left);
    Object.values(WORK).forEach((x) => { if (x.left) $('#' + x.left).classList.toggle('hidden', x.left !== w.left); });
    if (w.left) $('#left-title').textContent = w.title;
    ['patch', 'verify'].forEach((x) => $('#view-' + x).classList.toggle('hidden', x !== w.center));
    // 工作畫面蓋住拓樸圖時，鍵盤不會移到底下的畫布；鍵盤 N 移到設備時顯示的提示也不留在工作畫面上
    $('#view-graph').inert = w.center !== 'graph';
    if (w.center !== 'graph') $('#tooltip').classList.add('hidden');
    A.applyColumns(); A.syncWorkspaces(); A.renderSteps();
    A.renderCenter();
  }
  /** 沒有基準時 ④、⑤ 不能用：停在這兩步時回到 ③ */
  A.syncSteps = function syncSteps() {
    if (!App.snap && needsSnap(App.step)) apply('triage'); else A.renderSteps();
  };
  /** 焦點的目標：true 是這一步的標題（②、③ 是左側清單的標題），字串是驗證畫面的區塊或 'graph'（畫布） */
  const FOCUS = { graph: '#graph', compare: '#compare-title', trend: '#trend-title', round: '#round-title', tracking: '#tracking-title', ledger: '#ledger-title' };
  function focusTarget(s, f) {
    if (typeof f === 'string' && FOCUS[f]) return $(FOCUS[f]);
    return $(WORK[s].left ? '#left-title' : '#' + WORK[s].center + '-title');
  }
  /**
   * 換到某一步。① 開啟資料中心（opt.section 是要捲到的區塊）；②–⑤ 先關閉資料中心。沒有基準時 ④、⑤ 改為 ③。
   * opt.focus：true 焦點移到這一步的標題，字串見 FOCUS，省略時焦點不動；opt.scroll：同 focus 的目標，只捲動不移焦點。
   * opt.workspace：窄螢幕要顯示的工作區，預設依流程（有左側清單時先看清單，否則看工作畫面）。
   */
  App.showStep = function (step, opt) {
    if (!STEPS.includes(step)) throw new RangeError('未知的步驟：' + step);
    const o = opt || {};
    if (step === 'input') { App.openHub(o.section, { opener: o.opener }); return; }
    const s = needsSnap(step) && !App.snap ? 'triage' : step;
    A.closeHub();
    apply(s);
    if (A.isNarrowScreen()) A.setWorkspace(o.workspace || (WORK[s].left ? 'checks' : 'graph'));
    if (o.focus) { const t = focusTarget(s, o.focus); if (t) t.focus(); }
    else if (o.scroll) { const t = focusTarget(s, o.scroll); if (t && t.scrollIntoView) t.scrollIntoView({ block: 'start' }); }
  };
  /**
   * 顯示某一個工作畫面（其他模組的入口用）：graph 是「在圖上定位」（目前不在拓樸圖時回到上一次看圖的 ② 或 ③），
   * patch 是 ④，verify、compare、trend 是 ⑤（compare、trend 捲到該區塊）。opt.focus 為 true 時焦點移到那個畫面或區塊的標題（拓樸圖是畫布）。
   */
  App.showView = function (view, opt) {
    const o = opt || {};
    const MAP = { graph: [null, 'graph'], patch: ['fix', true], verify: ['verify', true], compare: ['verify', 'compare'], trend: ['verify', 'trend'] };
    if (!MAP[view]) throw new RangeError('未知的工作畫面：' + view);
    const s = MAP[view][0] || (WORK[App.step].center === 'graph' ? App.step : graphStep);
    const block = view === 'compare' || view === 'trend' ? view : null;
    App.showStep(s, { focus: o.focus ? MAP[view][1] : null, scroll: o.focus ? null : block, workspace: 'graph' });
  };

  /** 每一步的狀態文字（不只靠顏色）：① 已收集台數、② 拓樸圖的層級、③ 待處理筆數、④ 已選項目、⑤ 處理紀錄的第幾輪 */
  function statusOf(s) {
    const has = !!App.snap;
    if (s === 'input') return has ? `${V.num(App.Q.meta().stats.collected)} 台` : '未載入';
    if (!has) return s === 'view' || s === 'triage' ? '—' : '建立基準後';
    if (s === 'view') return V.LAYER[App.layer] || App.layer;
    if (s === 'triage') { const pc = A.problemCounts(); return `待處理 ${V.num(pc.error + pc.warn)}`; }
    if (s === 'fix') return `已選 ${V.num(V.patchView.selectedCount(App))}`;
    const ls = A.ledgerState();
    if (ls.blocked) return '處理紀錄停用';
    const idx = A.ledgerRoundIndex(); const pc = A.problemCounts();
    return (idx >= 0 ? `第 ${V.num(idx + 1)} 輪` : '—') + (pc.regressed ? `・回歸 ${V.num(pc.regressed)}` : '');
  }
  /** 步驟列：目前的一步（aria-current="step"）、停用的步驟與每一步的狀態 */
  A.renderSteps = function renderSteps() {
    const cur = A.currentStep(); const has = !!App.snap;
    STEPS.forEach((s) => {
      const b = stepBtn(s); if (!b) return;
      const on = s === cur; const off = needsSnap(s) && !has;
      b.setAttribute('aria-current', on ? 'step' : 'false'); b.classList.toggle('on', on);
      b.setAttribute('aria-disabled', String(off)); b.classList.toggle('off', off);
      const st = b.querySelector('.step-st'); if (st) st.textContent = statusOf(s);
      b.setAttribute('title', (off ? '建立基準後才能使用。' : '') + STEP_TITLE[s]);
    });
  };
  A.bindSteps = function bindSteps() {
    STEPS.forEach((s) => {
      const b = stepBtn(s);
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-disabled') === 'true') { A.banner(`建立基準後才能使用「${A.STEP_LABEL[s]}」。`, 4000); return; }
        App.showStep(s, { focus: true, opener: b });
      });
    });
    A.renderSteps();
  };

  // ================================================================ 窄螢幕工作區
  A.isNarrowScreen = function isNarrowScreen() { return Number(window.innerWidth) <= 900; };
  /** 工作區切換列的標籤跟著目前的一步（左側清單的名稱、中間工作畫面的名稱）；沒有左側清單時不顯示「清單」工作區 */
  A.syncWorkspaces = function syncWorkspaces() {
    const w = WORK[App.step];
    document.querySelectorAll('#mobile-workspaces button').forEach((b) => {
      if (b.dataset.workspace === 'checks') { b.classList.toggle('hidden', !w.left); if (w.left) b.textContent = w.title; }
      if (b.dataset.workspace === 'graph') b.textContent = CENTER_LABEL[w.center];
    });
    if (!w.left && $('#main').dataset.workspace === 'checks') A.setWorkspace('graph');
  };
  A.setWorkspace = function setWorkspace(workspace) {
    const ws = workspace === 'checks' && !WORK[App.step].left ? 'graph' : workspace;
    $('#main').dataset.workspace = ws;
    document.querySelectorAll('#mobile-workspaces button').forEach((button) => {
      const active = button.dataset.workspace === ws;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };
  A.bindMobileWorkspaces = function bindMobileWorkspaces() {
    document.querySelectorAll('#mobile-workspaces button').forEach((button) => button.addEventListener('click', () => {
      A.setWorkspace(button.dataset.workspace);
    }));
    A.syncWorkspaces();
  };

  // ================================================================ 左右欄寬度
  // 左右欄寬度是檢視狀態：存在獨立的 'layout' 鍵，清除基準時不受影響。④、⑤ 沒有左側清單時左欄寬度為 0（記住的寬度不變）
  const PANE = { min: 240, centerMin: 320, def: { left: 330, right: 400 } };
  A.applyColumns = function applyColumns() {
    if (!App.layout) return;
    const left = WORK[App.step].left ? App.layout.left : 0;
    $('#main').style.gridTemplateColumns = `${left}px minmax(0, 1fr) ${App.layout.right}px`;
  };
  A.bindResizers = async function bindResizers() {
    const sides = { left: $('#left'), right: $('#right') };
    const saved = (await S.store.get('layout').catch(() => null)) || {};
    App.layout = { left: PANE.def.left, right: PANE.def.right };
    const clamp = (side, w) => {
      const other = App.layout[side === 'left' ? 'right' : 'left']; const total = window.innerWidth || Infinity;
      return Math.round(Math.max(PANE.min, Math.min(w, total - other - PANE.centerMin)));
    };
    ['left', 'right'].forEach((side) => { if (Number.isFinite(saved[side])) App.layout[side] = clamp(side, saved[side]); });
    A.applyColumns();
    const persist = () => S.store.set('layout', Object.assign({}, App.layout)).catch(() => {});
    ['left', 'right'].forEach((side) => {
      const grip = h('div', { class: 'grip grip-' + side, title: '拖曳調整寬度，雙擊還原' });
      sides[side].appendChild(grip);
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault(); const x0 = e.clientX; const w0 = App.layout[side];
        const move = (ev) => { App.layout[side] = clamp(side, w0 + (side === 'left' ? 1 : -1) * (ev.clientX - x0)); A.applyColumns(); };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); grip.classList.remove('on'); persist(); };
        grip.classList.add('on'); document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
      grip.addEventListener('dblclick', () => { App.layout[side] = clamp(side, PANE.def[side]); A.applyColumns(); persist(); });
    });
  };
})(globalThis.SSOT = globalThis.SSOT || {});
