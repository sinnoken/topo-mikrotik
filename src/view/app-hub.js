/*
 * 資料中心：這一輪所有的輸入與輸出集中在一處，以及工作包（ssot-workpack/1）的下載與讀入。
 * 畫面在 panels/hub.js；這裡是開關、狀態與動作。
 *
 * 資料都來自 App.round（app.js）：工作包的內容依角色從它組出來，讀回的內容也只經過 A.load／A.setRoundInputs 寫回去。
 * 格式、核對與重建全部在核心 S.workpack（read／build／validate）；處理紀錄只經過 app-ledger.js（S.ledger）。
 * 核心是同步的：1000 台的資料 build、read 各要數秒，validate（重建）約 10 秒；開始前先顯示忙碌提示並讓出一次畫面，
 * 進行中停用資料中心的操作。失敗時列出核心回報的全部問題，目前的資料不變。
 */
(function (S) {
  'use strict';
  const V = S.view; const $ = V.$;
  const A = V.app; const App = window.App;
  const nowIso = () => new Date().toISOString();

  /**
   * 資料中心的檢視狀態（不進基準，也不存進 store）：
   *   open        是否開啟
   *   byDevice    匯出報表時依設備排序（Markdown 依設備分組）
   *   pack        工作包要放哪些可選的角色（收集檔與基準一定放；命名規則與 expectedData 用過就一定放）
   *   busy        進行中的長時間操作的說明（null 表示沒有）
   *   buildErrors 上次建立工作包失敗的問題 [{ code, path, message }]
   *   read        讀入工作包的進度：{ name, errors, warnings }（讀取失敗）、
   *               { name, pack, choose, loss, errors?, warnings? }（等使用者確認；errors 是重建核對失敗）、
   *               { name, done: true, warnings, brought }（已帶回）
   */
  const hub = {
    open: false, byDevice: false, pack: { ledger: true, expected: true, report: true, patch: true },
    busy: null, buildErrors: null, read: null,
  };
  A.hubState = () => hub;
  A.hubOpen = () => hub.open;
  const renderHub = () => V.hub.render(App);

  // ================================================================ 開關
  A.bindHub = function bindHub() {
    $('#btn-hub').onclick = () => (hub.open ? A.closeHub({ focus: true }) : App.openHub());
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !hub.open) return;
      // 只處理資料中心內（或沒有焦點時）的 Esc：頁首的搜尋、路由追蹤各自用 Esc 收起
      const root = $('#hub'); const t = e.target;
      if (t && t !== document.body && root.contains && !root.contains(t)) return;
      // 對話框（輸入、修正計畫、原文）開著時，Esc 先關對話框
      if (['#dlg-input', '#dlg-patch', '#dlg-raw'].some((s) => $(s) && $(s).open)) return;
      A.closeHub({ focus: true });
    });
  };
  /** 開啟資料中心；section 是要捲到並聚焦的區塊（inputs、outputs、ledger、reports），省略時聚焦標題 */
  App.openHub = function (section) {
    hub.open = true;
    $('#hub').classList.remove('hidden'); $('#app').classList.add('hub-open');
    // 資料中心蓋在主畫面上（同一格，畫布大小不變）：主畫面不可聚焦，鍵盤只在資料中心內移動
    $('#main').inert = true; $('#mobile-workspaces').inert = true;
    $('#btn-hub').setAttribute('aria-expanded', 'true'); $('#btn-hub').classList.add('on');
    renderHub();
    const target = (section && $('#hub-sec-' + section)) || $('#hub-title');
    if (target) { target.focus(); if (target.scrollIntoView) target.scrollIntoView({ block: 'start' }); }
  };
  /** 關閉資料中心；opt.focus 為 true 時焦點回到頁首的「資料中心」按鈕（鍵盤關閉時） */
  A.closeHub = function closeHub(opt) {
    if (!hub.open) return;
    hub.open = false;
    $('#hub').classList.add('hidden'); $('#app').classList.remove('hub-open');
    $('#main').inert = false; $('#mobile-workspaces').inert = false;
    $('#btn-hub').setAttribute('aria-expanded', 'false'); $('#btn-hub').classList.remove('on');
    if (opt && opt.focus) $('#btn-hub').focus();
  };

  // ================================================================ 忙碌提示
  /**
   * 顯示忙碌提示並讓出主執行緒一次，讓提示先畫出來，再執行同步的核心計算。
   * requestAnimationFrame 之後再等一個 setTimeout 才會在畫面更新之後；沒有畫面更新時（背景分頁）以逾時保底。
   */
  A.hubBusy = function hubBusy(text) {
    hub.busy = text; renderHub();
    return new Promise((res) => {
      let done = false; const go = () => { if (!done) { done = true; setTimeout(res, 0); } };
      if (window.requestAnimationFrame) window.requestAnimationFrame(go);
      setTimeout(go, 100);
    });
  };
  const idle = () => { hub.busy = null; };
  /** 核心回報格式問題（WorkpackError／ZipError）是預期的結果，畫面已列出；其他例外才寫 console.error */
  const logUnexpected = (e) => { if (!(e && (e.name === 'WorkpackError' || e.name === 'ZipError'))) console.error(e); };
  /** 核心丟出的錯誤 → [{ code, path, message }]：WorkpackError／ZipError 用它的 errors（全部問題），其他錯誤一筆 */
  const errorsOf = (e) => (e && Array.isArray(e.errors) && e.errors.length
    ? e.errors.map((x) => ({ code: x.code || null, path: x.path || null, message: x.message || String(x) }))
    : [{ code: (e && e.name) || null, path: null, message: (e && e.message) || String(e) }]);
  /** 時間估計用：收集檔的總字元數（約 1400 萬字元是 1000 台） */
  const sizeOf = (sources) => sources.reduce((n, s) => n + s.text.length, 0);
  const slowNote = (chars) => (chars > 2e6 ? `資料較大（約 ${V.num(Math.round(chars / 1e4) / 100)} 百萬字元），可能要十幾秒；完成前畫面會暫停回應。` : '');

  // ================================================================ 工作包的內容
  /**
   * 工作包的角色清單（畫面勾選與建立共用）：[{ role, key, label, on, required, available, note }]。
   *   required：一定要放（收集檔、基準；基準用了命名規則或 expectedData 時也一定要放，否則讀回時對不上）
   *   available：目前有沒有這份資料；沒有時 note 說明原因
   */
  A.workpackRoles = function workpackRoles() {
    const r = App.round; const blocked = A.ledgerState().blocked; const exp = r.expected;
    const nPatch = V.patchView.selectedCount(App);
    const list = [
      { role: 'source', label: '收集檔', required: true, available: r.sources.length > 0, note: `${V.num(r.sources.length)} 份；可能含有設備機密，請自行保管` },
      { role: 'snapshot', label: '基準（Snapshot JSON）', required: true, available: !!r.snapshot, note: '' },
      { role: 'ledger', key: 'ledger', label: '處理紀錄', available: !blocked, note: blocked ? '處理紀錄停用中，不放進工作包' : '' },
      { role: 'profile', label: '命名規則', required: !!r.profile, available: !!r.profile,
        note: r.profile ? '基準用了命名規則，一定要附上（讀回時要用同一份才能重建同一個基準）' : '這份基準沒有用命名規則' },
      { role: 'expected-data', label: '建立選項 expectedData', required: !!r.expectedData, available: !!r.expectedData,
        note: r.expectedData ? '基準用了 expectedData，一定要附上（它是基準鍵的一部分）' : '這份基準沒有用 expectedData' },
      { role: 'expected', key: 'expected', label: '預期資料（ssot-expected/1）', available: !!(exp && exp.data && !exp.error),
        note: !exp ? '沒有載入預期資料' : exp.error ? '預期資料無法讀取，不放進工作包' : exp.name },
      { role: 'report', key: 'report', label: '報表（CSV、Markdown）', available: !!r.snapshot, note: hub.byDevice ? '依設備排序' : '' },
      { role: 'patch', key: 'patch', label: '修正 patch（.rsc 與總表）', available: nPatch > 0,
        note: nPatch ? `修正計畫目前選取 ${V.num(nPatch)} 項` : '修正計畫沒有選取項目；先在「開啟修正計畫」選取' },
    ];
    list.forEach((x) => { x.on = x.available && (x.required || !!hub.pack[x.key]); });
    return list;
  };
  /** 依勾選組出 S.workpack.build 的 parts；檔名沿用各匯出的慣例（baseName：建立時間＋設備數） */
  function partsOf(roles, now) {
    const r = App.round; const Q = r.Q; const K = V.exporter.KINDS;
    const on = new Set(roles.filter((x) => x.on).map((x) => x.role));
    const json = (v) => JSON.stringify(v, null, 2) + '\n';
    const parts = r.sources.map((s) => ({ role: 'source', name: s.name, text: s.text }));
    const base = K.snapshot; // 基準 JSON 的匯出種類（檔名與下載的相同）
    parts.push({ role: 'snapshot', name: base.name(Q), text: V.exporter.snapshotJson(r.snapshot) });
    if (on.has('ledger')) parts.push({ role: 'ledger', name: A.ledgerFileName(now), text: json(r.ledger) });
    if (on.has('profile')) parts.push({ role: 'profile', name: `profile-${r.profile.id || 'unnamed'}.json`, text: json(r.profile) });
    if (on.has('expected-data')) parts.push({ role: 'expected-data', name: 'expected-data.json', text: json(r.expectedData) });
    if (on.has('expected')) parts.push({ role: 'expected', name: r.expected.name, text: json(r.expected.data) });
    if (on.has('report')) {
      const opts = { ledgerOf: A.ledgerExport, byDevice: hub.byDevice, snapshot: r.snapshot };
      ['csv', 'markdown'].forEach((k) => parts.push({ role: 'report', name: K[k].name(Q), text: K[k].text(Q, opts) }));
    }
    if (on.has('patch')) {
      const cur = V.patchView.current(App);
      (cur ? cur.list : []).forEach((f) => parts.push({ role: 'patch', name: f.name, text: f.text }));
    }
    return parts;
  }
  A.workpackName = () => `workpack-${V.exporter.baseName(App.Q)}.zip`;

  // ================================================================ 下載
  /** 建立並下載工作包；失敗時列出核心回報的全部問題（不下載）。回傳 bytes 或 null */
  App.downloadWorkpack = async function () {
    if (!App.snap || hub.busy) return null;
    hub.buildErrors = null;
    await A.hubBusy('正在建立工作包…' + slowNote(sizeOf(App.round.sources)));
    const now = nowIso(); let bytes = null;
    try { bytes = S.workpack.build(partsOf(A.workpackRoles(), now), { now }); } catch (e) { logUnexpected(e); hub.buildErrors = errorsOf(e); }
    idle();
    if (bytes) {
      try { V.exporter.download(A.workpackName(), bytes, 'application/zip'); A.banner(`已建立工作包 ${A.workpackName()}（${V.num(bytes.length)} bytes）`, 6000); } catch (e) {
        console.error(e); hub.buildErrors = errorsOf(e); bytes = null;
      }
    }
    renderHub();
    return bytes;
  };

  // ================================================================ 讀入
  /**
   * 目前的處理紀錄裡有、但即將取代它的處理紀錄（next）沒有的內容：{ onlyHere, differ, rounds, blocked }；沒有時 null。
   *   onlyHere：next 沒有的項目數；differ：兩邊都有但內容不同的項目數；rounds：next 沒有的輪次數；blocked：目前停用（原資料會被取代）
   * 只比對鍵與內容是否相同，不解讀狀態；用來提醒使用者取代前先匯出。
   */
  A.ledgerLoss = function ledgerLoss(next) {
    const st = A.ledgerState();
    if (st.blocked) return st.blocked.raw !== undefined ? { onlyHere: 0, differ: 0, rounds: 0, blocked: true } : null;
    const cur = st.ledger; const cj = S.util.canonicalJson;
    const keys = Object.keys(cur.items);
    const onlyHere = keys.filter((k) => !Object.prototype.hasOwnProperty.call(next.items, k)).length;
    const differ = keys.filter((k) => Object.prototype.hasOwnProperty.call(next.items, k) && cj(cur.items[k]) !== cj(next.items[k])).length;
    const roundKey = (it) => cj([it.baseline, it.at]);
    const theirs = new Set(next.iterations.map(roundKey));
    const rounds = cur.iterations.filter((it) => !theirs.has(roundKey(it))).length;
    return onlyHere || differ || rounds ? { onlyHere, differ, rounds, blocked: false } : null;
  };
  /** 讀入工作包檔（bytes）：S.workpack.read 失敗時列出全部問題，目前的資料不變；成功時等使用者確認要帶回的內容 */
  App.readWorkpack = async function (name, bytes) {
    if (hub.busy) return hub.read;
    hub.read = null;
    await A.hubBusy(`正在讀取並核對工作包 ${name}…` + (bytes && bytes.length > 4e6 ? '資料較大，可能要數秒；完成前畫面會暫停回應。' : ''));
    let pack = null;
    try { pack = S.workpack.read(bytes); } catch (e) {
      logUnexpected(e); hub.read = { name, errors: errorsOf(e), warnings: (e && e.warnings) || [] };
    }
    idle();
    if (pack) {
      hub.read = { name, pack, loss: pack.ledger ? A.ledgerLoss(pack.ledger) : null,
        choose: { baseline: true, ledger: !!pack.ledger, expected: !!pack.expected, profileId: pack.profile ? 'pack' : 'none', ack: false } };
    }
    renderHub();
    return hub.read;
  };
  /** 讀入工作包的檔案（File）：讀成 Uint8Array 後交給 App.readWorkpack */
  A.readWorkpackFile = async function readWorkpackFile(f) {
    let bytes;
    try { bytes = new Uint8Array(await f.arrayBuffer()); } catch (e) { hub.read = { name: f.name, errors: errorsOf(e), warnings: [] }; renderHub(); return hub.read; }
    return App.readWorkpack(f.name, bytes);
  };
  App.cancelWorkpack = function () { hub.read = null; renderHub(); };
  /** 確認表單的選擇：baseline、ledger、expected、ack（勾選）與 profileId（命名規則） */
  A.chooseWorkpack = function chooseWorkpack(key, value) {
    const w = hub.read; if (!w || !w.choose) return;
    w.choose[key] = value;
    if (key === 'ledger' && !value) w.choose.ack = false;
    renderHub();
  };
  /** 命名規則的選項：工作包附的、目前清單中的、不套用 */
  A.workpackProfileOf = (w, id) => (id === 'pack' ? w.pack.profile : id === 'none' ? null : S.profiles[id] || null);

  /**
   * 帶回確認的內容：
   *   上一輪的基準：以 S.workpack.validate 用工作包的收集檔重建並核對（命名規則依選擇，預設是工作包附的），用重建的基準載入
   *   處理紀錄：整份取代目前的，再以載入的基準推進一輪（目前的有工作包沒有的內容時，要先勾選確認）
   *   命名規則：選了工作包附的時加入命名規則清單；預期資料：取代目前的
   * 任何一步失敗都在動到資料之前：重建核對失敗時列出問題，目前的基準、處理紀錄都不變。
   */
  App.applyWorkpack = async function () {
    const w = hub.read; if (!w || !w.pack || hub.busy) return { ok: false };
    const c = w.choose; const pack = w.pack;
    if (c.ledger && w.loss && !c.ack) { w.needAck = true; renderHub(); return { ok: false, needAck: true }; }
    const profile = A.workpackProfileOf(w, c.profileId);
    let res = null;
    if (c.baseline) {
      w.errors = null;
      await A.hubBusy('正在以工作包的收集檔重建基準並核對…' + slowNote(sizeOf(pack.sources)));
      try { res = S.workpack.validate(pack, { now: nowIso(), profile, expectedData: pack.expectedData }); } catch (e) {
        console.error(e); res = { ok: false, errors: errorsOf(e), warnings: [], snapshot: null };
      }
      idle();
      if (!res.ok) { w.errors = res.errors; w.validateWarnings = res.warnings; renderHub(); return { ok: false, errors: res.errors }; }
    }
    // 以下不再有會失敗的核對：依序寫回
    const brought = [];
    if (c.profileId === 'pack' && pack.profile && pack.profile.id) {
      S.profiles[pack.profile.id] = pack.profile;
      const saved = (await S.store.get('profiles').catch(() => null)) || {}; saved[pack.profile.id] = pack.profile;
      await S.store.set('profiles', saved).catch((e) => A.banner('無法儲存命名規則：' + e.message, 8000));
      brought.push('命名規則');
    }
    if (c.expected && pack.expected) {
      const ex = pack.files.find((f) => f.role === 'expected');
      App.round.expected = { name: ex ? ex.name : 'expected.json', data: pack.expected, error: null };
      brought.push('預期資料');
    }
    if (c.ledger && pack.ledger) { A.adoptLedger(pack.ledger); brought.push('處理紀錄'); }
    if (res) {
      A.load(res.snapshot, null, { sources: pack.sources, profile, expectedData: pack.expectedData,
        origin: { kind: 'workpack', name: w.name, createdAt: pack.manifest.createdAt } });
      await A.saveLast();
      brought.unshift('上一輪的基準');
    } else if (c.ledger && pack.ledger && App.Q) await A.advanceLedger(App.Q);
    if (c.ledger && pack.ledger) { await App.ledgerJob; await A.persistLedger(); }
    const warnings = pack.warnings.concat(res ? res.warnings : []);
    hub.read = { name: w.name, done: true, warnings, brought };
    A.renderAll();
    A.banner(brought.length ? `已從工作包帶回：${brought.join('、')}` : '沒有帶回任何內容', 8000);
    return { ok: true, warnings, brought };
  };

  // ================================================================ 其他輸入的檔案
  /** 讀入處理紀錄檔：交給 App.importLedger（先 S.ledger.validate，確認後才覆蓋） */
  A.importLedgerFile = async function importLedgerFile(f) {
    let text; try { text = await f.text(); } catch (e) { text = ''; }
    App.importLedger(f.name, text);
  };
  /** 匯出報表（CSV、Markdown）：依資料中心的「依設備排序」 */
  A.exportReport = (kind) => App.exportAs(kind, { byDevice: hub.byDevice });
  A.toggleByDevice = () => { hub.byDevice = !hub.byDevice; renderHub(); };
  A.togglePackRole = (key, on) => { hub.pack[key] = !!on; renderHub(); };
})(globalThis.SSOT = globalThis.SSOT || {});
