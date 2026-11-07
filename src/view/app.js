/*
 * 畫面組裝：輸入 → 建立基準 → 圖、檢查結果、覆蓋率、比對、詳細資料。
 * 畫面只透過 SSOT.query() 讀取基準；所有邏輯（解析、建模、檢查、追蹤、比對）都在核心，不在這裡。
 *
 * 這個檔案是畫面的起點：檢視狀態（App）、啟動、還原與儲存（store 接線）、載入基準與整體重繪。
 * 其他責任分在 app-*.js；彼此共用的內部函式掛在 S.view.app（程式內稱 A），公開操作掛在 App：
 *   app-graph.js   基準 → 圖資料、未知對端、版面排程（ELK／內建）
 *   app-layers.js  拓樸圖的層級（設備、L2 埠、L3 子網）、VLAN 篩選，以及 L2／L3 的圖資料、版面與標示
 *   app-select.js  選取、圖上互動、原文檢視、路由追蹤
 *   app-toolbar.js 頁首（搜尋）、工具列與下拉選單（含路由追蹤、匯出 PNG 的按鈕）、版面模式、清除基準
 *   app-scheme.js  配色（跟隨系統、淺色、深色；首次繪製前的 A.paintScheme）、減少動態效果、匯出時暫換配色（A.withScheme）
 *   app-legend.js  圖例、終端廠商色的圖例、匯出 PNG（A.exportPng）與匯出基準或檢查結果（App.exportAs）
 *   app-panes.js   流程步驟（App.showStep）、左側的清單、中間的工作畫面（App.showView）、窄螢幕工作區、左右欄寬度
 *   app-input.js   輸入對話框與建立基準
 *   app-ledger.js  處理紀錄（S.ledger；store 的 'ledger'，並轉換舊的 'acks'）
 *   app-hub.js     資料中心：這一輪的輸入與輸出、工作包（S.workpack）的下載與讀入
 *   app-settings.js 設定（頁首的 ⚙）：和資料中心同一種蓋住主畫面的另一層，兩者互斥；各分類的內容在 panels/settings-*.js
 *
 * 「這一輪的資料」集中在 App.round（見下方 A.newRound）：收集檔、命名規則、建立選項 expectedData、基準與查詢介面、
 * 比對用的預期資料。工作包的讀寫、儲存（store 的 'last'）與畫面都從這裡讀；改變它只經過 A.load（換基準，可同時換輸入）、
 * A.setRoundInputs（只換輸入）與 A.clearRound（清除）。App.snap、App.Q、App.sources、App.profileJson 是它的唯讀存取器，
 * 讓既有的讀取不必改寫；處理紀錄仍由 app-ledger.js 管理（停用、轉換、寫入 store），App.round.ledger 是唯讀的存取器。
 * 檢視狀態（選取、展開、版面、縮放與位置）不放在這裡，留在 App 上。
 * 這些檔案在載入時只定義函式，實際執行都在 DOMContentLoaded 之後，所以彼此的載入先後不影響行為；
 * 只有這個檔案要最先載入，因為它建立 App 與 A；app-scheme.js 另要在 index.html 首次繪製配色的 inline script 之前載入（它呼叫 A.paintScheme）。
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

  // ================================================================ Esc
  /**
   * 頁面層級的 Esc 一次只關最上層：各層以 A.onEscape(層, fn) 登記，fn 處理了這次 Esc 就回傳 true。
   * 只有一個 document 監聽，依 ESC_ORDER 由上往下交給第一個處理的層，不依各 bind* 的註冊先後。
   * 元素自己的 Esc（輸入框、選單、VLAN 標示、畫布、原生對話框）在元素上處理並停止傳遞，不經這裡。
   */
  const ESC_ORDER = ['menu', 'trace', 'hub', 'settings', 'sheet']; const escHandlers = new Map();
  A.onEscape = function onEscape(layer, fn) {
    if (!ESC_ORDER.includes(layer)) throw new RangeError('未知的 Esc 層：' + layer);
    escHandlers.set(layer, fn);
  };
  /**
   * 有強制回應的原生 <dialog> 開著（建立基準、原文、表格視窗 V.tableDialog…）：Esc 歸那個對話框，頁面的各層一律不處理。
   * 以頁面上全部的 dialog 判斷，新增對話框不必另外登記。
   */
  A.modalOpen = () => Array.from(document.querySelectorAll('dialog')).some((d) => d.open);
  function bindEscape() {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || A.modalOpen()) return;
      ESC_ORDER.some((l) => { const f = escHandlers.get(l); return !!f && f(e) === true; });
    });
  }

  // ================================================================ 蓋住主畫面的一層（資料中心、設定）
  const overlays = new Map();
  /**
   * 資料中心與設定共用的外殼（只有一份）：和 #main 疊在同一格（畫布大小不變），開著時主畫面不可聚焦（inert），
   * 頁首的按鈕 aria-expanded＋on，有一層開著時 #app 加上 overlay-open（頁首與提示列的樣式），
   * Esc 在 ESC_ORDER 的 name 層：只處理層內、頁首的按鈕或沒有焦點時的 Esc（頁首的搜尋、路由追蹤各自收起），關閉後焦點回到開啟它的按鈕。
   * 一次只開一層、開啟後的內容與焦點由呼叫端負責；cfg.onClose 在關閉後、焦點歸還前執行（重繪步驟列、清空內容）。
   *   name   Esc 層的名稱（ESC_ORDER 之一）
   *   root   這一層的元素（選擇器），button 頁首開關它的按鈕；opener 是 null 時焦點回到 button
   * 回傳 { isOpen(), opener(), open(opener), close(focus) }。
   */
  A.overlay = function overlay(name, cfg) {
    if (overlays.has(name)) throw new Error('重複的疊加層：' + name);
    const st = { open: false, opener: null };
    const show = (on) => {
      $(cfg.root).classList.toggle('hidden', !on);
      const any = Array.from(overlays.values()).some((o) => o.isOpen());
      $('#app').classList.toggle('overlay-open', any);
      $('#main').inert = any; $('#mobile-workspaces').inert = any;
      const btn = $(cfg.button); btn.setAttribute('aria-expanded', String(on)); btn.classList.toggle('on', on);
    };
    const layer = {
      isOpen: () => st.open,
      opener: () => st.opener,
      open(opener) { st.open = true; st.opener = opener || null; show(true); },
      /** 關閉；focus 為 true 時（鍵盤關閉）焦點回到開啟它的按鈕或頁首的按鈕 */
      close(focus) {
        if (!st.open) return;
        st.open = false;
        const back = st.opener || $(cfg.button); st.opener = null;
        show(false);
        if (cfg.onClose) cfg.onClose();
        if (focus) back.focus();
      },
    };
    overlays.set(name, layer);
    A.onEscape(name, (e) => {
      if (!st.open) return false;
      const root = $(cfg.root); const t = e.target;
      if (t && t !== document.body && t !== $(cfg.button) && root.contains && !root.contains(t)) return false;
      layer.close(true); return true;
    });
    return layer;
  };

  // ================================================================ 啟動
  async function init() {
    A.bindWelcome(); // 歡迎畫面一開始就看得到：在讀 store（第一個 await）之前綁定，頁面一出現就能按
    App.graph = new V.GraphView($('#graph'));
    App.graph.on('click', A.onGraphClick);
    App.graph.on('dblclick', A.onGraphDblClick);
    App.graph.on('hover', A.onHover);
    let saveT = null;
    // 只有設備圖的位置存進 store；L2／L3 拖曳後的位置留在記憶體（App.layers）
    App.graph.on('moved', () => { if (App.layer === 'device') { clearTimeout(saveT); saveT = setTimeout(A.savePositions, 600); } App.graph.computeGroups(); });
    App.layoutMode = (await S.store.get('layoutMode').catch(() => null)) || 'elk';
    // 配色（設定「一般」的偏好，預設跟隨系統）：在建立圖例之前套用 theme；CSS 的深淺已由 index.html 的 inline script 在首次繪製前設好
    A.bindColorScheme();
    bindEscape();
    A.bindHeader(); A.bindToolbar(); A.bindLayers(); A.bindInputDialog(); A.bindHub(); A.bindSettings(); A.bindSteps(); A.bindMobileWorkspaces(); A.bindSheet(); await A.bindResizers();
    if (!(await S.store.available())) A.banner('這個瀏覽器無法使用本機儲存，關閉頁面後基準不會保留。');
    await A.loadLedger();
    await App.restore();
  }

  /**
   * 還原上次的基準：能不能還原只依 S.store.lastRestorable（還原備份的檢查用同一個）；schema 或版本不同時用儲存的輸入重建。
   * 無法載入時明確告知，不靜默略過；畫面上若還有別的基準（例如從備份還原時）一起收起，畫面與 store 不會不一致。
   * 回傳 { loaded, reason }：loaded 是否載入了基準；reason 是儲存的基準無法載入的原因（沒有儲存時兩者皆空）。
   */
  App.restore = async function () {
    let last;
    try { last = await S.store.get('last'); } catch (e) {
      console.error(e); const reason = '無法讀取儲存的基準：' + V.reason(e);
      A.renderAll(); A.banner(reason, 10000); return { loaded: false, reason };
    }
    if (last === undefined || last === null) { A.renderAll(); return { loaded: false, reason: null }; }
    const chk = S.store.lastRestorable(last);
    const fail = (reason) => {
      if (App.snap) A.resetBaselineView();
      // 無法還原基準時，輸入對話框仍可帶出上次的收集檔（格式正確時）
      if (chk.meta) A.setRoundInputs(inputsOf(last));
      A.renderAll(); A.banner(`上次的基準無法還原：${reason}。請重新建立基準。`, 10000);
      return { loaded: false, reason };
    };
    if (!chk.ok) return fail(chk.reason);
    const inputs = inputsOf(last);
    let snap = chk.meta.schema === S.SCHEMA ? last.snapshot : null; let msg = `已還原上次建立的基準（${V.fmtTime(chk.meta.createdAt)}）`;
    if (chk.rebuild) { // 程式更新過：用儲存的輸入重建，欄位才會完整
      try { snap = await S.buildAsync(inputs.sources, { profile: inputs.profile, expectedData: inputs.expectedData }); msg = '程式已更新，已用儲存的輸入重新建立基準'; } catch (e) {
        console.error(e);
        if (!snap) return fail(`基準格式（${chk.meta.schema}）已不相容，用儲存的輸入重新建立失敗：${V.reason(e)}`);
        msg += `；用儲存的輸入重新建立失敗（${V.reason(e)}），沿用儲存的基準，新版的欄位可能不完整`;
      }
    }
    A.load(snap, last.positions, inputs);
    A.banner(msg, 6000);
    return { loaded: true, reason: null };
  };
  const inputsOf = (last) => ({ sources: last.sources || [], profile: last.profile || null, expectedData: last.expectedData || null, origin: { kind: 'restore' } });
  /** 收起畫面上的基準（不動 store）：清除基準與無法還原時共用 */
  A.resetBaselineView = function resetBaselineView() {
    A.cancelElk(); A.clearRound();
    // 沒有基準時只有設備圖（歡迎畫面）：L2／L3 的資料與 VLAN 篩選一起清掉
    App.vlanFilter = null; A.resetLayers(); App.layer = 'device'; A.setDeviceGraph([], [], new Map()); A.resetSelection();
  };

  /** 節點位置是檢視狀態：存回 store 的 'last'，與基準一起還原；儲存的基準無法還原時不寫（不把位置寫進壞掉的資料） */
  A.savePositions = async function savePositions() {
    if (!App.snap) return;
    const last = await S.store.get('last'); if (!last || !S.store.lastRestorable(last).ok) return;
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
    A.cancelElk(); // 上一份基準的分層版面不再套用，「計算中」的通知一起收起
    App.round.snapshot = snap; App.round.Q = Q; App.sel = null; App.expanded = new Set();
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
    A.resetSelection(); // 新的圖資料換上之後：畫布不留上一份的選取與標示
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
  // 回傳這則通知的 token：沒有 ms 的通知（例如「計算中」）由發出者在工作取消或結束時用 A.bannerClear(token) 收起；
  // 之後已換成別的通知時 token 不同，不會收掉別人的
  let bannerSeq = 0;
  A.banner = function banner(text, ms) {
    const b = $('#banner'); b.textContent = text; b.classList.remove('hidden'); b.classList.remove('fading');
    clearTimeout(banner.t); clearTimeout(fadeT.banner);
    if (ms) banner.t = setTimeout(() => fadeOut(b, 'banner'), ms);
    return (bannerSeq += 1);
  };
  /** 收起 token 那一則通知（仍顯示著才收；馬上隱藏，全圖與聚焦不再替它讓位） */
  A.bannerClear = function bannerClear(token) {
    if (token == null || token !== bannerSeq) return;
    clearTimeout(A.banner.t); clearTimeout(fadeT.banner);
    const b = $('#banner'); b.classList.add('hidden'); b.classList.remove('fading');
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
    ['#btn-trace', '#btn-png', '#search'].forEach((s) => { $(s).disabled = !has; });
    syncTraceIps();
    // 覆蓋率在資料中心（「輸入」），由 V.hub.render 一起畫；設定只在開著時重畫（「清除基準…」依有沒有基準停用）
    V.lists.findings(App); V.lists.inventory(App);
    V.ledgerPane.render(App); V.hub.render(App); A.renderSettings();
    // 步驟與中間的工作畫面：沒有基準時「修正」、「驗證」回到「研判」；只重繪目前顯示的那一個
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
