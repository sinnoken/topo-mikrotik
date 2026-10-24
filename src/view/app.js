/*
 * 畫面組裝：輸入 → 建立基準 → 圖、檢查結果、覆蓋率、比對、詳細資料。
 * 畫面只透過 SSOT.query() 讀取基準；所有邏輯（解析、建模、檢查、追蹤、比對）都在核心，不在這裡。
 *
 * 這個檔案是畫面的起點：檢視狀態（App）、啟動、還原與儲存（store 接線）、載入基準與整體重繪。
 * 其他責任分在 app-*.js；彼此共用的內部函式掛在 S.view.app（程式內稱 A），公開操作掛在 App：
 *   app-graph.js   基準 → 圖資料、未知對端、版面排程（ELK／內建）
 *   app-select.js  選取、圖上互動、原文檢視、路由追蹤
 *   app-toolbar.js 頁首（搜尋、追蹤、清除）、工具列、圖例、匯出
 *   app-panes.js   左側分頁、窄螢幕工作區、左右欄寬度
 *   app-input.js   輸入對話框與建立基準
 *   app-ledger.js  處理紀錄（S.ledger；store 的 'ledger'，並轉換舊的 'acks'）
 * 這些檔案在載入時只定義函式，實際執行都在 DOMContentLoaded 之後，所以彼此的載入先後不影響行為；
 * 只有這個檔案要最先載入，因為它建立 App 與 A。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = (V.app = V.app || {});
  const App = {
    snap: null, Q: null, sources: [], profileJson: null, graph: null,
    pairOfLink: new Map(), pairs: new Map(), sel: null, showHosts: true,
    // 未知對端（沒有 LLDP／CDP 介面鄰接、只由 MAC 推論出來的終端）：只存在於畫面，不寫進基準
    showUnknown: true, expanded: new Set(), virtual: new Map(), vOfEp: new Map(), virtualByDev: new Map(),
    // 終端的廠商色（前 8 個廠商；其餘歸「其他」），由 app-graph.js 依基準計算，只用於畫面與圖例
    vendorColors: new Map(), vendorOthers: 0,
    UNKNOWN_EXPAND_MAX: 8, UNKNOWN_TOTAL_CAP: 800,
    // 版面模式：elk（分層，預設）或 builtin（快速）；網路設備超過 ELK_MAX 台時分層版面不執行
    layoutMode: 'elk', layoutJob: Promise.resolve(), ELK_MAX: 1500,
  };
  window.App = App;

  // ================================================================ 啟動
  async function init() {
    App.graph = new V.GraphView($('#graph'));
    App.graph.on('click', A.onGraphClick);
    App.graph.on('dblclick', A.onGraphDblClick);
    App.graph.on('hover', A.onHover);
    let saveT = null;
    App.graph.on('moved', () => { clearTimeout(saveT); saveT = setTimeout(A.savePositions, 600); App.graph.computeGroups(); });
    App.layoutMode = (await S.store.get('layoutMode').catch(() => null)) || 'elk';
    A.bindHeader(); A.bindToolbar(); A.bindInputDialog(); A.bindTabs(); A.bindMobileWorkspaces(); await A.bindResizers();
    if (!(await S.store.available())) A.banner('這個瀏覽器無法使用本機儲存，關閉頁面後基準不會保留。');
    await A.loadLedger();
    await App.restore();
  }

  /** 還原上次的基準：schema 或版本不同時用儲存的輸入重建；無法還原時明確告知，不靜默略過。 */
  App.restore = async function () {
    const last = await S.store.get('last').catch(() => null);
    // 儲存的基準還沒建立查詢介面：先用 S.query.metaOf 讀 meta 判斷相容，再決定直接載入或重建
    const savedMeta = last ? S.query.metaOf(last.snapshot) : null;
    const saved = savedMeta ? last.snapshot : null;
    if (saved) {
      App.sources = last.sources || []; App.profileJson = last.profile || null;
      const sameSchema = savedMeta.schema === S.SCHEMA;
      let snap = sameSchema ? saved : null; let msg = `已還原上次建立的基準（${V.fmtTime(savedMeta.createdAt)}）`;
      if ((!sameSchema || savedMeta.version !== S.VERSION) && App.sources.length) { // 程式更新過：用儲存的輸入重建，欄位才會完整
        try { snap = await S.buildAsync(App.sources, { profile: App.profileJson }); msg = '程式已更新，已用儲存的輸入重新建立基準'; } catch (e) {
          console.error(e);
          if (!sameSchema) msg = `上次的基準格式（${savedMeta.schema}）已不相容，重新建立失敗：${e.message}。請重新建立基準。`;
        }
      } else if (!sameSchema) msg = `上次的基準格式（${savedMeta.schema}）已不相容，且沒有儲存輸入，請重新建立基準。`;
      if (snap) A.load(snap, last.positions); else A.renderAll();
      A.banner(msg, 6000);
    } else A.renderAll();
  };

  /** 節點位置是檢視狀態：存回 store 的 'last'，與基準一起還原 */
  A.savePositions = async function savePositions() {
    if (!App.snap) return;
    const last = await S.store.get('last'); if (!last) return;
    last.positions = Object.fromEntries(App.graph.pos); await S.store.set('last', last);
  };

  // ================================================================ 載入基準
  A.load = function load(snap, positions) {
    App.snap = snap; App.Q = S.query(snap); App.sel = null; App.expanded = new Set();
    // 處理紀錄推進一輪（目前時間由畫面傳入）；寫入 store 是非同步的，App.ledgerJob 讓呼叫端可以等待
    App.ledgerJob = A.advanceLedger(App.Q);
    V.lists.findings.reset(); V.lists.compare.reset(); V.lists.findings.openFirst(App.Q);
    const g = A.graphData(App.Q);
    const hostCount = g.nodes.filter((n) => n.kind === 'host').length;
    App.showHosts = hostCount <= 300;
    const pos = new Map();
    const auto = V.layout.layout(g.nodes, g.edges);
    const fresh = [];
    g.nodes.forEach((n) => {
      const saved = positions && positions[n.id];
      if (saved) pos.set(n.id, saved);
      else if (positions && n.virtual && positions[n.parent]) fresh.push(n); // 還原舊位置時，新出現的未知對端排在它所屬設備下方
      else pos.set(n.id, auto.get(n.id) || { x: 0, y: 0 });
    });
    A.placeLeaves(fresh, g.nodes, g.edges, pos);
    App.graph.setData(g.nodes, g.edges, pos);
    A.applyVisibility();
    App.graph.fit();
    A.renderAll();
    // 先以內建版面立即出圖；沒有儲存位置時再於背景套用分層版面
    App.layoutJob = App.layoutMode === 'elk' && !(positions && Object.keys(positions).length) ? A.applyElk(g) : Promise.resolve();
  };

  // ================================================================ 重繪與提示
  A.banner = function banner(text, ms) {
    const b = $('#banner'); b.textContent = text; b.classList.remove('hidden');
    clearTimeout(banner.t); if (ms) banner.t = setTimeout(() => b.classList.add('hidden'), ms);
  };
  A.renderAll = function renderAll() {
    const has = !!App.snap;
    $('#welcome').classList.toggle('hidden', has);
    ['#toolbar', '#legend', '#hint'].forEach((s) => $(s).classList.toggle('hidden', !has));
    renderBaselineSummary();
    $('#btn-trace').disabled = !has; $('#search').disabled = !has; $('#btn-clear').disabled = !has;
    const f = V.clear($('#footer'));
    if (has) {
      const m = App.Q.meta();
      f.appendChild(h('span', null, `建立：${V.fmtTime(m.createdAt)}`));
      f.appendChild(h('span', null, `設備 ${V.num(m.stats.devices)}（已收集 ${V.num(m.stats.collected)}）・鏈路 ${V.num(m.stats.links)}・MAC ${V.num(m.stats.macs)}`));
      f.appendChild(h('span', null, `命名規則：${m.profile ? m.profile.id : '未套用'}`));
      f.appendChild(h('span', { class: 'mono' }, `輸入指紋 ${m.inputHash}`));
      f.appendChild(h('span', null, `版本 ${m.version}`));
    } else f.appendChild(h('span', null, `RouterOS 網路基準 ${S.VERSION}・資料只在這個瀏覽器處理，不會傳到任何地方`));
    V.lists.findings(App); V.lists.coverage(App); V.lists.compare(App); V.lists.inventory(App);
    V.ledgerPane.render(App); V.patchView.refresh(App);
    V.details.render(App, App.sel);
  };
  function renderBaselineSummary() {
    const root = V.clear($('#baseline-summary'));
    const has = !!App.snap;
    root.classList.toggle('hidden', !has);
    if (!has) return;
    const stats = App.Q.meta().stats;
    const missing = App.Q.coverage().filter(V.coverageGap).length;
    // 已處理（排程修復、可接受、誤報、已修好）的錯誤／警告不算在待處理的問題裡，但註明筆數
    const pc = A.problemCounts(); const problems = pc.error + pc.warn;
    const ackNote = pc.handled ? `（另有 ${V.num(pc.handled)} 項已處理）` : '';
    root.appendChild(h('div', { class: 'baseline-state' }, [
      h('strong', null, '基準檢查'),
      h('span', { class: 'baseline-message' }, (problems
        ? `目前規則找到 ${V.num(pc.error)} 項錯誤、${V.num(pc.warn)} 項警告`
        : '目前規則未發現待處理的錯誤或警告') + ackNote),
      h('span', { class: 'baseline-coverage' }, `收集完整度：${V.num(stats.collected)} / ${V.num(stats.devices)} 台設備已收集；${V.num(missing)} 台有必要資料缺漏`),
      // 處理紀錄的提示：回歸（修好後又出現）、因收集失敗而無法判斷、豁免到期；點一下開啟處理紀錄分頁
      ...[['regressed', 'err', (n) => `回歸 ${V.num(n)} 項`, '已修好的問題又出現（依處理紀錄）'],
        ['unobserved', 'warn', (n) => `無法判斷 ${V.num(n)} 項`, '這一輪消失的待處理項目，所屬設備有收集失敗或沒有收集，因收集失敗而無法判斷是否已修好'],
        ['waiverExpired', 'warn', (n) => `豁免到期 ${V.num(n)} 項`, '「可接受」的豁免已到期，改回待處理']]
        .filter(([k]) => pc[k]).map(([k, cls, label, title]) => V.chipButton(label(pc[k]), 'btn ' + cls + ' ledger-alert', { 'data-alert': k, title,
          onclick: () => A.activatePane('pane-ledger') })),
    ]));
    const actions = h('div', { class: 'baseline-actions' });
    actions.appendChild(h('button', {
      disabled: !problems,
      onclick: () => {
        V.lists.findings.showProblems(App);
        A.activatePane('pane-findings');
      },
    }, '查看錯誤／警告'));
    actions.appendChild(h('button', {
      disabled: !missing,
      onclick: () => {
        V.lists.coverage.showMissing(App);
        A.activatePane('pane-coverage');
      },
    }, '查看收集缺漏'));
    actions.appendChild(h('button', { onclick: () => App.openTrace() }, '路由追蹤'));
    actions.appendChild(h('button', { onclick: () => $('#search').focus() }, '搜尋定位'));
    root.appendChild(actions);
  }

  document.addEventListener('DOMContentLoaded', init);
})(globalThis.SSOT = globalThis.SSOT || {});
