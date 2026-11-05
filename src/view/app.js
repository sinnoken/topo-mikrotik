/*
 * 畫面組裝：輸入 → 建立基準 → 圖、檢查結果、覆蓋率、比對、詳細資料。
 * 畫面只透過 SSOT.query() 讀取基準；所有邏輯（解析、建模、檢查、追蹤、比對）都在核心，不在這裡。
 *
 * 這個檔案是畫面的起點：檢視狀態（App）、啟動、還原與儲存（store 接線）、載入基準與整體重繪。
 * 其他責任分在 app-*.js；彼此共用的內部函式掛在 S.view.app（程式內稱 A），公開操作掛在 App：
 *   app-graph.js   基準 → 圖資料、未知對端、版面排程（ELK／內建）
 *   app-layers.js  拓樸圖的層級（設備、L2 埠、L3 子網）、VLAN 篩選，以及 L2／L3 的圖資料、版面與標示
 *   app-select.js  選取、圖上互動、原文檢視、路由追蹤
 *   app-toolbar.js 頁首（搜尋、資料中心、「⋯」選單：路由追蹤、匯出 PNG、清除）、工具列與下拉選單、圖例、匯出
 *   app-panes.js   流程步驟（App.showStep）、左側的清單、中間的工作畫面（App.showView）、窄螢幕工作區、左右欄寬度
 *   app-input.js   輸入對話框與建立基準
 *   app-ledger.js  處理紀錄（S.ledger；store 的 'ledger'，並轉換舊的 'acks'）
 *   app-hub.js     資料中心：這一輪的輸入與輸出、工作包（S.workpack）的下載與讀入
 *
 * 「這一輪的資料」集中在 App.round（見下方 A.newRound）：收集檔、命名規則、建立選項 expectedData、基準與查詢介面、
 * 比對用的預期資料。工作包的讀寫、儲存（store 的 'last'）與畫面都從這裡讀；改變它只經過 A.load（換基準，可同時換輸入）、
 * A.setRoundInputs（只換輸入）與 A.clearRound（清除）。App.snap、App.Q、App.sources、App.profileJson 是它的唯讀存取器，
 * 讓既有的讀取不必改寫；處理紀錄仍由 app-ledger.js 管理（停用、轉換、寫入 store），App.round.ledger 是唯讀的存取器。
 * 檢視狀態（選取、展開、版面、縮放與位置）不放在這裡，留在 App 上。
 * 這些檔案在載入時只定義函式，實際執行都在 DOMContentLoaded 之後，所以彼此的載入先後不影響行為；
 * 只有這個檔案要最先載入，因為它建立 App 與 A。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = (V.app = V.app || {});
  const App = {
    graph: null,
    pairOfLink: new Map(), pairs: new Map(), sel: null, showHosts: true,
    // 未知對端（沒有 LLDP／CDP 介面鄰接、只由 MAC 推論出來的終端）：只存在於畫面，不寫進基準
    showUnknown: true, expanded: new Set(), virtual: new Map(), vOfEp: new Map(), virtualByDev: new Map(),
    // 終端的廠商色（前 8 個廠商；其餘歸「其他」），由 app-graph.js 依基準計算，只用於畫面與圖例
    vendorColors: new Map(), vendorOthers: 0,
    UNKNOWN_EXPAND_MAX: 8, UNKNOWN_TOTAL_CAP: 800,
    // 版面模式：elk（分層，預設）或 builtin（快速）；網路設備超過 ELK_MAX 台時分層版面不執行
    layoutMode: 'elk', layoutJob: Promise.resolve(), ELK_MAX: 1500,
    // 拓樸圖的層級（app-layers.js）：device（設備圖）、l2（埠層級）、l3（子網）。設備圖的位置在 devicePos（存進 store 的 'last'）；
    // L2／L3 的位置只在記憶體（App.layers），換基準時清空。layerJob 是 L2／L3 背景版面的工作（測試可等待）
    layer: 'device', devicePos: new Map(), deviceGraph: { nodes: [], edges: [] }, layerJob: Promise.resolve(),
    // L2 埠圖整張畫的上限（設備數）：埠讓 ELK 的計算量比設備圖大得多，超過時只畫選取的設備與它的鄰居
    L2_MAX: 300,
  };
  window.App = App;

  // ================================================================ 這一輪的資料
  /**
   * 這一輪的資料（不是檢視狀態）：
   *   sources       收集檔 [{ name, text }]（S.build 的來源，順序決定 inputHash）
   *   profile       建立基準時用的命名規則 JSON，沒有時 null
   *   expectedData  S.build 的建立選項 expectedData（各類設備應有的資料），沒有時 null；目前只會由工作包帶入
   *   snapshot、Q   基準與它的查詢介面（SSOT.query），沒有時 null
   *   expected      比對用的預期資料 { name, data（ssot-expected/1；無法解析時 null）, error }，沒有時 null；換基準時保留並重新比對
   *   origin        這份基準怎麼來的 { kind: 'build' | 'restore' | 'workpack', name?, createdAt? }，沒有時 null
   *   ledger        （唯讀）目前的處理紀錄；處理紀錄停用時為 null
   */
  A.newRound = (fields) => Object.assign({
    sources: [], profile: null, expectedData: null, snapshot: null, Q: null, expected: null, origin: null,
    get ledger() { return A.ledgerOrNull ? A.ledgerOrNull() : null; },
  }, fields || {});
  App.round = A.newRound();
  // 既有的讀取沿用 App.snap／App.Q／App.sources／App.profileJson：唯讀，寫入一律經過 A.load／A.setRoundInputs（嚴格模式下直接指定會丟錯）
  Object.defineProperties(App, {
    snap: { get: () => App.round.snapshot, enumerable: true },
    Q: { get: () => App.round.Q, enumerable: true },
    sources: { get: () => App.round.sources, enumerable: true },
    profileJson: { get: () => App.round.profile, enumerable: true },
  });
  /** 只換這一輪的輸入（收集檔、命名規則、expectedData、來源）；有給的欄位才換，基準不變 */
  A.setRoundInputs = function setRoundInputs(inputs) {
    ['sources', 'profile', 'expectedData', 'origin'].forEach((k) => {
      if (inputs && k in inputs) App.round[k] = k === 'sources' ? inputs[k] || [] : inputs[k] || null;
    });
  };
  /** 清除這一輪的資料（「清除」按鈕）：基準、輸入與比對用的預期資料；處理紀錄不在這裡，不受影響 */
  A.clearRound = function clearRound() { App.round = A.newRound(); };
  /** 存進 store 的 'last'：基準、輸入與目前的節點位置（位置是檢視狀態，和基準一起還原）。失敗時以 banner 說明，回傳 false */
  A.saveLast = function saveLast() {
    const r = App.round;
    return S.store.set('last', { snapshot: r.snapshot, sources: r.sources, profile: r.profile, expectedData: r.expectedData, positions: Object.fromEntries(App.devicePos) })
      .then(() => true, () => { A.banner('基準太大，無法存入瀏覽器；關閉頁面後需要重新建立。'); return false; });
  };

  // ================================================================ 啟動
  async function init() {
    App.graph = new V.GraphView($('#graph'));
    App.graph.on('click', A.onGraphClick);
    App.graph.on('dblclick', A.onGraphDblClick);
    App.graph.on('hover', A.onHover);
    let saveT = null;
    // 只有設備圖的位置存進 store；L2／L3 拖曳後的位置留在記憶體（App.layers）
    App.graph.on('moved', () => { if (App.layer === 'device') { clearTimeout(saveT); saveT = setTimeout(A.savePositions, 600); } App.graph.computeGroups(); });
    App.layoutMode = (await S.store.get('layoutMode').catch(() => null)) || 'elk';
    A.bindHeader(); A.bindToolbar(); A.bindLayers(); A.bindInputDialog(); A.bindHub(); A.bindSteps(); A.bindMobileWorkspaces(); A.bindSheet(); await A.bindResizers();
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
      const inputs = { sources: last.sources || [], profile: last.profile || null, expectedData: last.expectedData || null, origin: { kind: 'restore' } };
      A.setRoundInputs(inputs); // 無法還原基準時，輸入對話框仍可帶出上次的收集檔
      const sameSchema = savedMeta.schema === S.SCHEMA;
      let snap = sameSchema ? saved : null; let msg = `已還原上次建立的基準（${V.fmtTime(savedMeta.createdAt)}）`;
      if ((!sameSchema || savedMeta.version !== S.VERSION) && inputs.sources.length) { // 程式更新過：用儲存的輸入重建，欄位才會完整
        try { snap = await S.buildAsync(inputs.sources, { profile: inputs.profile, expectedData: inputs.expectedData }); msg = '程式已更新，已用儲存的輸入重新建立基準'; } catch (e) {
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
    last.positions = Object.fromEntries(App.devicePos); await S.store.set('last', last);
  };

  // ================================================================ 載入基準
  /**
   * 換成另一份基準。inputs（選用）是要一起換的輸入 { sources, profile, expectedData, origin }：
   * 和基準同時換，不會出現「基準換了、收集檔還是舊的」的中間狀態。
   */
  A.load = function load(snap, positions, inputs) {
    const Q = S.query(snap);
    if (inputs) A.setRoundInputs(inputs);
    App.round.snapshot = snap; App.round.Q = Q; App.sel = null; App.expanded = new Set(); App.graph.setEmphasis(null); A.closeSheet();
    // 處理紀錄推進一輪（目前時間由畫面傳入）；寫入 store 是非同步的，App.ledgerJob 讓呼叫端可以等待
    App.ledgerJob = A.advanceLedger(App.Q);
    V.lists.findings.reset(); V.lists.compare.reset(); V.lists.findings.openFirst(App.Q);
    const g = A.graphData(App.Q);
    const hostCount = g.nodes.filter((n) => n.kind === 'host').length;
    App.showHosts = hostCount <= 300;
    const pos = new Map();
    const auto = V.layout.layout(g.nodes, g.edges, { portrait: A.isPortrait() });
    const fresh = [];
    g.nodes.forEach((n) => {
      const saved = positions && positions[n.id];
      if (saved) pos.set(n.id, saved);
      else if (positions && n.virtual && positions[n.parent]) fresh.push(n); // 還原舊位置時，新出現的未知對端排在它所屬設備下方
      else pos.set(n.id, auto.get(n.id) || { x: 0, y: 0 });
    });
    A.placeLeaves(fresh, g.nodes, g.edges, pos);
    // L2／L3 的版面與位置屬於上一份基準：清掉；目前看的是 L2／L3 時，用新的基準重畫那一層
    A.resetLayers();
    A.setDeviceGraph(g.nodes, g.edges, pos);
    A.applyVisibility();
    if (App.layer === 'device') App.graph.fit(); else A.showLayer(App.layer, { rebuild: true });
    A.renderAll();
    // 先以內建版面立即出圖；沒有儲存位置時再於背景套用分層版面
    App.layoutJob = App.layoutMode === 'elk' && !(positions && Object.keys(positions).length) ? A.applyElk(g) : Promise.resolve();
  };

  // ================================================================ 重繪與提示
  // 拓樸圖上的通知（banner）在下方中央，不遮工具列；有 ms 時數秒後淡出。操作提示（#hint）只在第一次看到圖時顯示，數秒後淡出
  const FADE_MS = 400; const HINT_MS = 6000; const fadeT = {};
  function fadeOut(el, key) {
    clearTimeout(fadeT[key]); el.classList.add('fading');
    fadeT[key] = setTimeout(() => { el.classList.add('hidden'); el.classList.remove('fading'); }, FADE_MS);
  }
  A.banner = function banner(text, ms) {
    const b = $('#banner'); b.textContent = text; b.classList.remove('hidden'); b.classList.remove('fading');
    clearTimeout(banner.t); clearTimeout(fadeT.banner);
    if (ms) banner.t = setTimeout(() => fadeOut(b, 'banner'), ms);
  };
  const hint = { done: false, t: null };
  /** 操作提示：有基準且看的是拓樸圖（不是 L4）時顯示；第一次顯示後 HINT_MS 淡出，之後不再出現（同一次開啟頁面） */
  A.syncHint = function syncHint(l4) {
    const el = $('#hint'); const show = !!App.snap && !l4 && !hint.done;
    el.classList.toggle('hidden', !show);
    if (show && !hint.t) hint.t = setTimeout(() => { hint.done = true; fadeOut(el, 'hint'); }, HINT_MS);
  };
  A.renderAll = function renderAll() {
    const has = !!App.snap;
    $('#welcome').classList.toggle('hidden', has);
    // 圖例與操作提示依層級（A.syncLayerUi）；基準的摘要在步驟列的狀態與右側的基準狀態卡（未選取時）
    $('#toolbar').classList.toggle('hidden', !has);
    ['#btn-trace', '#btn-png', '#btn-clear', '#search'].forEach((s) => { $(s).disabled = !has; });
    syncTraceIps();
    // 覆蓋率在資料中心（① 輸入），由 V.hub.render 一起畫
    V.lists.findings(App); V.lists.inventory(App);
    V.ledgerPane.render(App); V.hub.render(App);
    // 步驟與中間的工作畫面：沒有基準時 ④、⑤ 回到 ③；只重繪目前顯示的那一個
    A.syncSteps(); A.renderCenter(); A.syncLayerUi();
    V.details.render(App, App.sel);
  };
  /**
   * 路由追蹤的 IP 自動完成（#trace-ips）：Q.ipEntries() 的每個 IP 一個選項；同一個位址在多個 VRF 只列一次並註明 VRF，
   * 從哪個 VRF 追蹤由追蹤的 VRF 選單決定（同 App.runTrace）。只在換基準時重建。
   */
  let traceIpsQ;
  function syncTraceIps() {
    if (traceIpsQ === App.Q) return;
    traceIpsQ = App.Q;
    const dl = V.clear($('#trace-ips'));
    if (!App.Q) return;
    const byIp = new Map(); App.Q.ipEntries().forEach((e) => S.util.getOr(byIp, e.ip, () => []).push(e));
    byIp.forEach((es, ip) => {
      const e = es.find((x) => x.dev) || es[0]; const vs = es.map((x) => x.vrf);
      const where = e.dev ? App.Q.devName(e.dev) + (e.ifc ? ' ' + e.ifc : '') : e.from.join('／');
      dl.appendChild(h('option', { value: ip }, where + (vs.length > 1 || vs[0] !== S.keys.MAIN_VRF ? `（${vs.map(V.vrfText).join('、')}）` : '')));
    });
  }
  document.addEventListener('DOMContentLoaded', init);
})(globalThis.SSOT = globalThis.SSOT || {});
