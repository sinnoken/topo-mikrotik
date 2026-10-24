/*
 * L4 可達性（M2）：zone 矩陣（L0）→ 一格的位址組（L1）與牽涉的規則（L2）→ 逐跳的可達性（L3），以及直接輸入的可達性查詢。
 * 拓樸圖工具列選了「L4 可達性」時顯示在 #view-l4（疊在畫布上、工具列下面；app-layers.js 的 App.showLayer）。
 *
 * 資料全部來自查詢層：Q.zoneMatrix（L0）、Q.zoneCell（L1／L2）、Q.reach（L3）、Q.zones，以及 S.query.l4Services／reachAssumptions。
 * 這些都是推論，由查詢層計算並快取，不寫進基準（ADR-014）；畫面不自己判斷規則或路由，只負責選取、顯示與鍵盤操作。
 * 目前的 service、檢視方式（矩陣／表格）與下鑽到哪裡是檢視狀態，只在記憶體，不存進 store，換基準時清掉。
 * 顏色與符號取自 theme.l4；格子狀態一律有符號與文字（V.L4_STATUS），不只靠顏色。
 * 第一次計算矩陣（大型網路要數秒）時用 Q.zoneMatrixSteps 分段計算：每段約 25 ms，段與段之間 setTimeout(0) 讓出主執行緒，
 * 進度條顯示目前的階段與進度，計算中畫面仍可操作；換 service、換基準或離開 L4 時放棄（it.return()），不畫過期的結果，查詢層也不留快取。
 * 同一份基準、同一個 service 再開時直接使用查詢層的快取。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const TH = () => V.theme.l4;
  const P = () => V.details.parts;
  /** 矩陣最多畫幾個 zone（N² 個格子）；超過時只有表格檢視 */
  const MATRIX_MAX = 60;
  /** 下鑽的表格最多列幾筆 */
  const ROW_LIMIT = 300;
  /** 矩陣的表格檢視最多列幾格（全部的格子在 CSV） */
  const TABLE_LIMIT = 3000;
  /** 顯示忙碌提示後，等多久才開始計算（讓瀏覽器先畫出提示） */
  const BUSY_DELAY = 40;
  const PROTOS = ['tcp', 'udp', 'icmp'];
  /** Q.zoneMatrixSteps 的階段（依序） */
  const STAGES = ['reps', 'evaluate', 'summary'];
  const STAGE_LABEL = { reps: '找代表位址', evaluate: '逐一判斷', summary: '整理格子' };

  // 檢視狀態（不寫進基準、不存進 store）
  //   mx：「全部服務」的矩陣（服務選單的選項）；current：目前畫的矩陣（CSV 用）；showAllGroups：異質格子的 L1 是否列出全部的組
  const st = { Q: null, service: '', mode: 'matrix', cell: null, cellData: null, reach: null, reachReq: null, reachErr: null, hideDeny: true, showAllGroups: false, focus: [0, 0], mx: null, current: null, error: null };
  /** 這個畫面已經算過的矩陣：Q → Map(service → 計算毫秒數，只算 next() 本身)；查詢層有快取，再開時不顯示忙碌提示 */
  const computed = new WeakMap();
  /** 分段計算的紀錄：Q → Map(service → { ms, wallMs, steps, maxStepMs, maxGapMs })；大型冒煙測試讀主執行緒被佔住的最長時間 */
  const runs = new WeakMap();
  /** 進行中的分段計算（同時最多一個）：{ Q, key, zo, it, promise, progress, … } */
  let job = null;
  let els = null; let gridCells = []; let busyEls = null;
  /** 原因代碼的說明（S.query.reachReasonCodes 的 note），放在原因的提示裡 */
  let reasonNotes = null;
  const reasonNote = (code) => { if (!reasonNotes) reasonNotes = new Map(S.query.reachReasonCodes().map((x) => [x.code, x.note])); return reasonNotes.get(code) || null; };

  const svcIdOf = (s) => s.proto + (s.port != null ? '/' + s.port : '');
  const svcOf = (id) => { const [proto, port] = String(id).split('/'); return { proto, port: port === undefined ? null : Number(port) }; };
  /**
   * 命名規則的 zones 段（選用，只在查詢時使用）：建立基準時套用的命名規則有 zones 時才傳給查詢層。
   * 查詢層核對它與基準記錄的是同一份（id、version 與內容雜湊）；核對失敗（例如 2.11.0 以前建立的基準沒有雜湊）時不套用，
   * 回傳的 error 由畫面寫出來，不靜默改用別的分法。依 Q 與命名規則快取：{ opts: { profile? }, error }
   */
  const zoCache = new WeakMap();
  function zoneOpts(App) {
    const Q = App.Q; const p = App.profileJson; const hit = zoCache.get(Q);
    if (hit && hit.p === p) return hit.out;
    let out = { opts: {}, error: null };
    if (p && Array.isArray(p.zones) && p.zones.length) {
      try { Q.zones({ profile: p }); out = { opts: { profile: p }, error: null }; } catch (e) { out = { opts: {}, error: e.message }; }
    }
    zoCache.set(Q, { p, out });
    return out;
  }
  const zo = () => (st.zo ? st.zo.opts : {});
  const optsOf = (id) => Object.assign({}, zo(), id ? { services: [svcOf(id)] } : {});
  // zone id → zone：依 Q.zones() 回傳的陣列（查詢層快取，同一份基準是同一個陣列）建一次
  const zoneIdx = new WeakMap();
  const zoneIndex = (Q) => { const zs = Q.zones(zo()).zones; let m = zoneIdx.get(zs); if (!m) { m = new Map(zs.map((z) => [z.id, z])); zoneIdx.set(zs, m); } return m; };
  const zoneName = (Q, id) => { if (id == null) return '（不在任何 zone）'; const z = zoneIndex(Q).get(id); return z ? z.name : id; };
  const statusMark = (status, extra) => {
    const s = TH().status[status] || TH().status.unknown;
    return h('span', Object.assign({ class: 'l4-glyph', 'aria-hidden': 'true', style: { color: s.mark } }, extra || {}), s.glyph);
  };
  /** 格子／結果的狀態標籤：符號＋文字（不只靠顏色） */
  const statusTag = (status, text) => h('span', { class: 'l4-tag st-' + status, style: { background: cellBg(status), color: TH().text } }, [statusMark(status), ' ', text || V.L4_STATUS[status] || status]);
  const cellBg = (status) => {
    const s = TH().status[status] || TH().status.unknown;
    return s.hatch ? `repeating-linear-gradient(45deg, ${s.bg} 0 5px, ${s.hatch} 5px 6px)` : s.bg;
  };
  const verdictTag = (v) => statusTag(v, V.VERDICT[v] || v);
  /** 異質的徽章（文字，不只靠顏色）；顏色取自 theme.l4.badge */
  const hetBadge = (text, cls) => { const b = TH().badge; return h('span', { class: 'l4-het' + (cls ? ' ' + cls : ''), style: { background: b.bg, color: b.text, borderColor: b.border } }, text || '≠ 異質'); };
  /** 對角線（zone 內）的虛線外框：顏色取自 theme.l4.diagonal */
  const diagStyle = () => ({ borderColor: TH().diagonal.border, borderStyle: TH().diagonal.dash });

  // ---------------------------------------------------------------- 規則與原因的文字
  /** 決定結果的規則（Q.zoneMatrix 的 rule／rules、Q.zoneCell 的 ruleDetails、Q.reach 的 decisive）：規則、chain 結尾的預設或路由 */
  function decisiveText(Q, x) {
    if (!x) return '';
    const r = x.rule && x.rule.position != null ? x.rule : x.position != null ? x : null;
    if (r) return `${Q.devName(r.dev)} ${r.table} ${r.chain} 第 ${r.position} 條 ${r.action}${r.comment ? `（${r.comment}）` : ''}`;
    if (x.route) return `${Q.devName(x.dev)}：${V.reachReason(x.route)}`;
    if (x.policy) return `${Q.devName(x.dev)} ${x.table} ${x.chain} 沒有規則決定，chain 結尾預設${x.verdict === 'accept' ? '放行' : x.verdict}`;
    return x.key || x.id || '';
  }
  /** 規則的連結：點一下在右側開啟規則詳情（命中次數、影響）；規則已不在基準時只顯示文字 */
  function ruleLink(App, x) {
    const key = x && (x.key || (x.rule && x.rule.key));
    const text = decisiveText(App.Q, x);
    if (!key || !App.Q.getFirewallRule(key)) return h('span', null, text);
    return h('a', { class: 'link l4-rule', 'data-rule': key, onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); App.select({ type: 'rule', key }); } }, text);
  }
  const devLink = (App, d) => h('a', { class: 'link', onclick: () => App.select({ type: 'device', key: d }) }, App.Q.devName(d));
  const epText = (Q, ep) => (ep ? Q.epName(ep) : '不明');
  const reasonItem = (App, r) => h('li', { class: 'l4-reason', 'data-code': r.code, title: reasonNote(r.code) }, [
    h('b', null, V.reachReason(r.code)), r.message ? '：' + r.message : '',
    r.rule ? h('span', null, ['（', ruleLink(App, r.rule), '）']) : null,
  ]);
  /** 格子的完整說明（aria-label 與提示共用） */
  function cellText(Q, c) {
    const k = c.counts;
    return `${zoneName(Q, c.src)} → ${zoneName(Q, c.dst)}${c.diagonal ? '（zone 內）' : ''}：${V.L4_STATUS[c.status]}。`
      + (k.total ? `允許 ${V.num(k.allow)}、拒絕 ${V.num(k.deny)}、無法判斷 ${V.num(k.unknown)}，共 ${V.num(k.total)} 組（位址 × 服務）` : V.L4_STATUS_TIP.empty)
      + (c.heterogeneous ? '；異質：同一個 zone 的成員結果不一致' : '')
      + (c.rule ? `；代表規則：${decisiveText(Q, c.rule)}${c.ruleCount > 1 ? `（另有 ${c.ruleCount - 1} 條）` : ''}` : '')
      + (c.reasons.length ? `；無法判斷的原因：${c.reasons.map((x) => `${V.reachReason(x.code)}（${V.num(x.count)}）`).join('、')}` : '');
  }

  // ---------------------------------------------------------------- 骨架（第一次顯示時建立一次）
  function mount(App) {
    if (els) return;
    const root = $('#view-l4');
    const serviceSel = h('select', { id: 'l4-service', 'aria-label': '矩陣的服務', onchange: () => { st.service = serviceSel.value; App.l4Job = refresh(App); } });
    const modeBtn = (mode, label) => h('button', { type: 'button', 'data-mode': mode, 'aria-pressed': 'false', onclick: () => { st.mode = mode; App.l4Job = refresh(App); } }, label);
    const modes = h('div', { class: 'seg l4-modes', role: 'group', 'aria-label': '檢視方式' }, [modeBtn('matrix', '矩陣'), modeBtn('table', '表格')]);
    const src = h('input', { id: 'l4-src', type: 'text', placeholder: '203.0.113.1', autocomplete: 'off', 'aria-label': '來源 IP' });
    const dst = h('input', { id: 'l4-dst', type: 'text', placeholder: '10.1.20.11', autocomplete: 'off', 'aria-label': '目的 IP' });
    const proto = h('select', { id: 'l4-proto', 'aria-label': '協定' }, PROTOS.map((p) => h('option', { value: p }, p)));
    const port = h('input', { id: 'l4-port', type: 'text', inputmode: 'numeric', placeholder: '443', autocomplete: 'off', 'aria-label': '目的埠', class: 'l4-port' });
    proto.onchange = () => { port.disabled = proto.value === 'icmp'; };
    const run = () => runReach(App, src.value.trim(), dst.value.trim(), proto.value, port.value.trim());
    [src, dst, port].forEach((x) => x.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } }));
    els = {
      root, serviceSel, modes, src, dst, proto, port,
      status: h('div', { id: 'l4-status', class: 'l4-status', role: 'status', 'aria-live': 'polite' }),
      matrix: h('div', { id: 'l4-matrix', class: 'l4-matrix' }),
      legend: h('div', { id: 'l4-legend', class: 'l4-legend' }),
      drill: h('section', { id: 'l4-drill', class: 'work-card l4-card l4-drill hidden', 'aria-labelledby': 'l4-drill-title' }),
      zones: h('section', { id: 'l4-zones', class: 'work-card l4-card', 'aria-labelledby': 'l4-zones-title' }),
      live: h('div', { class: 'sr-only', 'aria-live': 'polite', id: 'l4-live' }),
      tip: h('div', { class: 'l4-tip hidden', role: 'tooltip', id: 'l4-tip' }),
      csv: h('button', { type: 'button', class: 'l4-csv', title: '下載目前 service 的矩陣（每一格一列）', onclick: () => downloadCsv(App) }, '下載 CSV'),
    };
    // 提示和矩陣放在同一個定位框裡（矩陣每次重畫，提示留著），位置相對於這個框
    els.box = h('div', { class: 'l4-matrix-box' }, [els.matrix, els.tip]);
    const assumptions = S.query.reachAssumptions();
    V.clear(root).appendChild(h('div', { class: 'work-inner l4-inner' }, [
      h('div', { class: 'work-head' }, [h('h2', { id: 'l4-title', class: 'work-title', tabindex: '-1' }, 'L4 可達性'),
        h('span', { class: 'muted' }, '來源 zone × 目的 zone 的防火牆與 NAT 結果；點格子往下看位址組、牽涉的規則與逐跳路徑。全部是依基準的路由與規則推論出來的，不寫進基準')]),
      h('section', { class: 'work-card l4-card l4-assume', 'aria-labelledby': 'l4-assume-title' }, [
        h('h3', { id: 'l4-assume-title', class: 'work-card-title' }, ['判斷的前提 ', V.chip('推論', 'info')]),
        h('ul', { class: 'l4-assume-list' }, assumptions.map((a) => h('li', { 'data-code': a.code }, a.message))),
      ]),
      h('section', { class: 'work-card l4-card', 'aria-labelledby': 'l4-reach-title' }, [
        h('h3', { id: 'l4-reach-title', class: 'work-card-title' }, '可達性查詢'),
        h('p', { class: 'muted l4-note' }, '輸入來源與目的 IP、協定與埠，沿各設備的路由逐跳套用 raw、dst-nat、filter 與 src-nat（Q.reach）；結果顯示在下方的 L3。'),
        h('div', { class: 'form-row l4-form' }, [
          h('label', { for: 'l4-src' }, '來源'), src, h('label', { for: 'l4-dst' }, '目的'), dst,
          h('label', { for: 'l4-proto' }, '協定'), proto, h('label', { for: 'l4-port' }, '埠'), port,
          h('button', { type: 'button', class: 'primary', id: 'l4-run', onclick: run }, '查詢'),
        ]),
      ]),
      h('section', { class: 'work-card l4-card', 'aria-labelledby': 'l4-matrix-title' }, [
        h('div', { class: 'l4-card-head' }, [h('h3', { id: 'l4-matrix-title', class: 'work-card-title' }, 'zone 矩陣（L0）'),
          h('label', { for: 'l4-service', class: 'muted' }, '服務'), serviceSel, modes, els.csv]),
        els.status, els.legend, els.box,
      ]),
      els.drill, els.zones, els.live,
    ]));
    buildLegend();
  }

  /** 圖例：五種狀態（符號、文字、底色）、異質、zone 內（對角線）與數字的意思 */
  function buildLegend() {
    const L = V.clear(els.legend);
    L.appendChild(h('div', { class: 'l4-legend-row' }, Object.keys(V.L4_STATUS).map((k) => h('span', { class: 'l4-legend-item', 'data-status': k, title: V.L4_STATUS_TIP[k] }, [
      h('span', { class: 'l4-swatch', style: { background: cellBg(k) } }, statusMark(k)), V.L4_STATUS[k],
    ])).concat([
      h('span', { class: 'l4-legend-item', 'data-legend': 'heterogeneous', title: '同一個 zone 的成員（代表位址）對同一個目的與服務的結果不一致：zone 切分可能不對，或規則只放行部分位址' }, [hetBadge(), '成員結果不一致']),
      h('span', { class: 'l4-legend-item', 'data-legend': 'diagonal', title: '來源與目的是同一個 zone（zone 內的流量，主要受主機防火牆影響，不在範圍內）' }, [h('span', { class: 'l4-swatch diag', style: diagStyle() }), 'zone 內']),
    ])));
    L.appendChild(h('div', { class: 'muted l4-note' }, '格子的數字是「允許／總數」：每個 zone 取代表位址（ARP 看到的位址優先，否則推算），代表位址 × 目的 × 服務各算一次。滑過或用鍵盤移到格子會顯示詳細的筆數與代表規則；方向鍵移動，Enter 往下看。'));
  }

  // ---------------------------------------------------------------- 顯示與計算
  /** 顯示 L4（App.showLayer）。opt.rebuild：換了基準，清掉下鑽的狀態。回傳矩陣的計算（Promise） */
  function show(App, opt) {
    mount(App);
    if (st.Q !== App.Q || (opt && opt.rebuild)) resetState(App.Q);
    st.zo = zoneOpts(App);
    return refresh(App);
  }
  function resetState(Q) {
    stopJob();
    Object.assign(st, { Q, service: '', cell: null, cellData: null, reach: null, reachReq: null, reachErr: null, showAllGroups: false, focus: [0, 0], mx: null, current: null, error: null });
    if (els) { els.drill.classList.add('hidden'); V.clear(els.drill); }
  }
  /** 放棄進行中的分段計算：generator 的 return() 讓查詢層不留下不完整的快取；之後不會再畫它的結果 */
  function stopJob() {
    const j = job; if (!j) return;
    job = null;
    if (j.it) { try { j.it.return(); } catch (e) { console.error(e); } }
  }
  /**
   * 依目前的 service 取得矩陣：這個畫面算過的直接畫；否則用 Q.zoneMatrixSteps 分段計算（先顯示忙碌提示，BUSY_DELAY 後開始）。
   * 同一份基準、同一個 service 已經在算（例如只換了檢視方式）時沿用它，算完依當時的檢視方式畫。回傳計算的 Promise（放棄時也會結束）。
   */
  function refresh(App) {
    const Q = App.Q; const key = st.service;
    syncControls(App);
    if (job && job.Q === Q && job.key === key && job.zo === st.zo) return job.promise;
    stopJob();
    const seen = computed.get(Q);
    if (seen && seen.has(key)) { draw(App, Q.zoneMatrix(optsOf(key)), null); return Promise.resolve(); }
    // 舊的矩陣是別的 service 的結果：計算期間不顯示，也不能下載
    st.current = null; V.clear(els.matrix); gridCells = []; hideTip();
    setBusy(true, key);
    const j = { Q, key, zo: st.zo, it: null, progress: null, steps: 0, ms: 0, maxStepMs: 0, maxGapMs: 0, t0: Date.now(), last: 0 };
    job = j;
    j.promise = new Promise((resolve) => {
      const fail = (e) => {
        console.error(e);
        st.error = e.message; setBusy(false); els.status.textContent = '無法計算 zone 矩陣：' + e.message;
      };
      const tick = () => {
        if (job !== j) { resolve(); return; } // 換了 service 或基準：stopJob 已經放棄
        if (App.Q !== Q || App.layer !== 'l4') {
          stopJob(); setBusy(false);
          els.status.textContent = App.Q !== Q ? '基準已更換，已停止計算 zone 矩陣。' : '已停止計算 zone 矩陣（離開了 L4）；回到 L4 時重新計算。';
          resolve(); return;
        }
        const s0 = Date.now();
        if (j.last) j.maxGapMs = Math.max(j.maxGapMs, s0 - j.last);
        let r;
        try {
          if (!j.it) j.it = Q.zoneMatrixSteps(optsOf(key));
          r = j.it.next(); // 參數錯誤（TypeError）在第一次 next() 丟出
        } catch (e) { job = null; fail(e); resolve(); return; }
        const ms = Date.now() - s0; j.last = Date.now();
        j.steps++; j.ms += ms; j.maxStepMs = Math.max(j.maxStepMs, ms);
        if (!r.done) { j.progress = r.value; setProgress(r.value); setTimeout(tick, 0); return; }
        job = null;
        if (!computed.has(Q)) computed.set(Q, new Map());
        computed.get(Q).set(key, j.ms);
        if (!runs.has(Q)) runs.set(Q, new Map());
        runs.get(Q).set(key, { ms: j.ms, wallMs: Date.now() - j.t0, steps: j.steps, maxStepMs: j.maxStepMs, maxGapMs: j.maxGapMs });
        try { draw(App, r.value, j.ms, j.steps); } catch (e) { fail(e); }
        resolve();
      };
      setTimeout(tick, BUSY_DELAY);
    });
    return j.promise;
  }
  /** 忙碌提示：說明文字在 live region 讀一次；進度條與數字每段更新，不在 live region 反覆朗讀（進度條有 aria-valuetext） */
  function setBusy(on, key) {
    els.matrix.setAttribute('aria-busy', String(on));
    if (!on) { busyEls = null; return; }
    const fill = h('div');
    const bar = h('div', { id: 'l4-progress', class: 'progress indeterminate', role: 'progressbar', 'aria-label': 'zone 矩陣的計算進度', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuetext': '準備中' }, fill);
    const text = h('span', { id: 'l4-progress-text', class: 'l4-progress-text', 'aria-hidden': 'true' }, '準備中');
    busyEls = { bar, fill, text };
    V.clear(els.status).appendChild(h('div', { class: 'l4-busy' }, [bar,
      h('span', null, `計算 zone 矩陣中（${key ? '服務 ' + key : '全部服務'}）…第一次計算要逐一判斷每個 zone 的代表位址，大型網路約需數秒，計算時可以繼續操作；之後同一份基準會直接使用快取`),
      text,
    ]));
  }
  /** 進度：Q.zoneMatrixSteps 每段的 { stage, done, total }（total 是上限）；每個階段各自從 0 開始 */
  function setProgress(p) {
    if (!busyEls) return;
    const n = STAGES.indexOf(p.stage) + 1; const label = STAGE_LABEL[p.stage] || p.stage;
    const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    const t = `第 ${n || '?'}／${STAGES.length} 段：${label} ${V.num(p.done)}／${V.num(p.total)}`;
    const { bar, fill, text } = busyEls;
    bar.classList.remove('indeterminate');
    bar.setAttribute('aria-valuenow', String(pct)); bar.setAttribute('aria-valuetext', t);
    bar.dataset.stage = p.stage;
    fill.style.width = pct + '%';
    text.textContent = t;
  }
  /** 服務選單（全部，或單一 proto/port：預設服務與 dst-nat 規則的目的埠）與檢視方式 */
  function syncControls(App) {
    const sel = els.serviceSel;
    // 「全部服務」的矩陣算好之前，先列預設服務；之後依矩陣實際用的服務（含 dst-nat 規則的目的埠）
    const base = st.mx ? st.mx.services.map((s) => s.id) : S.query.l4Services().map(svcIdOf);
    const ids = S.util.uniq(base.concat(st.service ? [st.service] : []));
    V.clear(sel);
    sel.appendChild(h('option', { value: '' }, '全部服務'));
    ids.forEach((id) => sel.appendChild(h('option', { value: id }, id)));
    sel.value = st.service;
    const tooBig = st.mx && st.mx.zones.length > MATRIX_MAX;
    els.modes.querySelectorAll('button').forEach((b) => {
      const on = (tooBig ? 'table' : st.mode) === b.dataset.mode;
      b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on);
      b.disabled = tooBig && b.dataset.mode === 'matrix';
      b.title = b.disabled ? `zone 超過 ${MATRIX_MAX} 個，只能用表格檢視` : b.dataset.mode === 'matrix' ? '來源 zone × 目的 zone 的格子（方向鍵移動，Enter 往下看）' : '每一格一列，可排序（和矩陣是同一份結果）';
    });
  }
  function draw(App, mx, ms, steps) {
    if (!st.service) st.mx = mx; // 服務選單的選項來自「全部服務」的矩陣
    st.error = null; setBusy(false);
    const Q = App.Q; const s = mx.stats;
    els.status.textContent = `${V.num(s.zones)} 個 zone、${V.num(s.representatives)} 個代表位址、${V.num(s.natEntries)} 個 dst-nat 入口、${V.num(s.evaluations)} 次判斷；`
      + (ms == null ? '使用快取' : `計算 ${V.num(ms)} ms${steps > 1 ? `，分 ${V.num(steps)} 段` : ''}（之後同一份基準直接使用快取）`) + '。'
      + (st.zo && st.zo.error ? '命名規則的 zones 段沒有套用（原因見「zone 的依據」）。' : '');
    syncControls(App);
    st.current = mx;
    renderMatrix(App, mx);
    renderZones(App);
    // 下鑽的格子在新的 service 下重新取得（L1／L2）；L3 是一次查詢的結果，維持不變
    if (st.cell) st.cellData = Q.zoneCell(st.cell.src, st.cell.dst, optsOf(st.service));
    renderDrill(App);
  }

  // ---------------------------------------------------------------- L0：矩陣與表格
  function renderMatrix(App, mx) {
    const box = V.clear(els.matrix); gridCells = [];
    els.tip.classList.add('hidden');
    if (!mx.zones.length) { box.appendChild(h('p', { class: 'muted' }, '基準中沒有 IPv4 直連網段，無法建立 zone。')); return; }
    const tooBig = mx.zones.length > MATRIX_MAX;
    if (tooBig) box.appendChild(h('p', { class: 'muted' }, `zone 有 ${V.num(mx.zones.length)} 個（超過 ${MATRIX_MAX} 個），只用表格檢視。`));
    if (st.mode === 'table' || tooBig) { box.appendChild(matrixTable(App, mx)); return; }
    const byKey = new Map(mx.cells.map((c) => [c.src + '\u0000' + c.dst, c]));
    const n = mx.zones.length;
    const [fr, fc] = [Math.min(st.focus[0], n - 1), Math.min(st.focus[1], n - 1)];
    const head = h('tr', null, [h('th', { scope: 'col', class: 'l4-corner' }, '來源 ＼ 目的')].concat(mx.zones.map((z) => h('th', { scope: 'col', class: 'l4-colhead', title: z.basis }, zoneLabel(z)))));
    const rows = mx.zones.map((zs, r) => {
      const tds = mx.zones.map((zd, c) => {
        const cell = byKey.get(zs.id + '\u0000' + zd.id);
        const td = cellEl(App, cell, r, c, r === fr && c === fc);
        (gridCells[r] = gridCells[r] || [])[c] = td;
        return td;
      });
      return h('tr', null, [h('th', { scope: 'row', class: 'l4-rowhead', title: zs.basis }, zoneLabel(zs))].concat(tds));
    });
    box.appendChild(h('div', { class: 'l4-grid-wrap' }, h('table', { class: 'l4-grid', role: 'grid', 'aria-label': `zone 矩陣：列是來源 zone，欄是目的 zone（${st.service ? '服務 ' + st.service : '全部服務'}）。方向鍵移動，Enter 往下看`, 'aria-rowcount': String(n + 1), 'aria-colcount': String(n + 1) }, [
      h('thead', null, head), h('tbody', null, rows),
    ])));
  }
  /** zone 名稱，旁邊是來源（命名規則、interface list、VLAN、網段）與「推論」標示；依據在 title */
  function zoneLabel(z) {
    return h('span', { class: 'l4-zone' }, [h('span', { class: 'l4-zone-name' }, z.name), ' ',
      h('span', { class: 'l4-zone-src' }, V.ZONE_SOURCE[z.source] || z.source), z.inferred ? h('span', { class: 'l4-zone-inf' }, '推論') : null]);
  }
  function cellEl(App, c, r, col, focusable) {
    const Q = App.Q;
    const td = h('td', {
      role: 'gridcell', tabindex: focusable ? '0' : '-1',
      class: `l4-cell st-${c.status}${c.diagonal ? ' diag' : ''}${c.heterogeneous ? ' het' : ''}`,
      'data-src': c.src, 'data-dst': c.dst, 'data-status': c.status, 'data-r': String(r), 'data-c': String(col),
      'aria-label': cellText(Q, c),
      style: Object.assign({ background: cellBg(c.status), color: TH().text }, c.diagonal ? diagStyle() : {}),
    }, [
      statusMark(c.status),
      h('span', { class: 'l4-lab' }, V.L4_STATUS[c.status]),
      c.counts.total ? h('span', { class: 'l4-cnt' }, `${V.num(c.counts.allow)}/${V.num(c.counts.total)}`) : null,
      c.heterogeneous ? hetBadge() : null,
    ]);
    td.addEventListener('click', () => { setRoving(r, col); openCell(App, c.src, c.dst); });
    td.addEventListener('keydown', (e) => onCellKey(App, e, r, col));
    td.addEventListener('mouseenter', (e) => showTip(App, c, td, e));
    td.addEventListener('mouseleave', hideTip);
    td.addEventListener('focus', () => showTip(App, c, td, null));
    td.addEventListener('blur', hideTip);
    return td;
  }
  function onCellKey(App, e, r, c) {
    const n = gridCells.length; if (!n) return;
    let to = null;
    if (e.key === 'ArrowRight') to = [r, Math.min(n - 1, c + 1)];
    else if (e.key === 'ArrowLeft') to = [r, Math.max(0, c - 1)];
    else if (e.key === 'ArrowDown') to = [Math.min(n - 1, r + 1), c];
    else if (e.key === 'ArrowUp') to = [Math.max(0, r - 1), c];
    else if (e.key === 'Home') to = e.ctrlKey ? [0, 0] : [r, 0];
    else if (e.key === 'End') to = e.ctrlKey ? [n - 1, n - 1] : [r, n - 1];
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); const td = gridCells[r][c];
      setRoving(r, c); openCell(App, td.dataset.src, td.dataset.dst); return;
    } else if (e.key === 'Escape') { hideTip(); return; }
    if (!to) return;
    e.preventDefault(); setRoving(to[0], to[1]).focus();
  }
  /** roving tabindex：矩陣只有目前的格子在 Tab 順序裡（tabindex 0），其他是 -1 */
  function setRoving(r, c) {
    const [r0, c0] = st.focus; const old = gridCells[r0] && gridCells[r0][c0];
    if (old) old.setAttribute('tabindex', '-1');
    const td = gridCells[r][c]; td.setAttribute('tabindex', '0'); st.focus = [r, c];
    return td;
  }
  /** 提示：狀態、筆數、異質、代表規則與無法判斷的原因（和格子的 aria-label 相同的內容，分行顯示） */
  function showTip(App, c, td, ev) {
    const Q = App.Q; const k = c.counts; const tip = V.clear(els.tip);
    tip.appendChild(h('div', { class: 'l4-tip-head' }, [statusMark(c.status), ` ${zoneName(Q, c.src)} → ${zoneName(Q, c.dst)}${c.diagonal ? '（zone 內）' : ''}：${V.L4_STATUS[c.status]}`]));
    tip.appendChild(h('div', null, k.total ? `允許 ${V.num(k.allow)}・拒絕 ${V.num(k.deny)}・無法判斷 ${V.num(k.unknown)}（共 ${V.num(k.total)} 組位址 × 服務）` : V.L4_STATUS_TIP.empty));
    if (c.heterogeneous) tip.appendChild(h('div', null, '≠ 異質：同一個 zone 的成員結果不一致'));
    if (c.rule) tip.appendChild(h('div', null, `代表規則：${decisiveText(Q, c.rule)}${c.ruleCount > 1 ? `（共 ${V.num(c.ruleCount)} 條規則或預設）` : ''}`));
    if (c.reasons.length) tip.appendChild(h('div', null, '無法判斷：' + c.reasons.slice(0, 3).map((x) => `${V.reachReason(x.code)}（${V.num(x.count)}）`).join('、')));
    tip.appendChild(h('div', { class: 'muted' }, 'Enter 或點一下往下看'));
    const box = els.box.getBoundingClientRect(); const rc = td.getBoundingClientRect();
    const x = ev && Number.isFinite(ev.clientX) ? ev.clientX - box.left + 14 : rc.left - box.left + rc.width / 2;
    const y = ev && Number.isFinite(ev.clientY) ? ev.clientY - box.top + 16 : rc.top - box.top + rc.height + 4;
    tip.style.left = Math.max(0, Math.round(x || 0)) + 'px'; tip.style.top = Math.max(0, Math.round(y || 0)) + 'px';
    tip.classList.remove('hidden');
  }
  function hideTip() { if (els) els.tip.classList.add('hidden'); }

  /** 表格檢視：每一格一列（和矩陣同一份 Q.zoneMatrix 的結果），可排序，點一列往下看 */
  function matrixTable(App, mx) {
    const Q = App.Q;
    return h('div', { class: 'work-table l4-table' }, V.table([
      { t: '來源 zone', f: (c) => zoneName(Q, c.src), s: (c) => zoneName(Q, c.src) },
      { t: '目的 zone', f: (c) => h('span', null, [zoneName(Q, c.dst), c.diagonal ? h('span', { class: 'muted' }, '（zone 內）') : null]), s: (c) => zoneName(Q, c.dst) },
      { t: '狀態', f: (c) => h('span', { class: 'l4-row-status', 'data-status': c.status }, [statusTag(c.status), c.heterogeneous ? hetBadge() : null]), s: (c) => c.status },
      { t: '允許', f: (c) => V.num(c.counts.allow), s: (c) => c.counts.allow, cls: 'num' },
      { t: '拒絕', f: (c) => V.num(c.counts.deny), s: (c) => c.counts.deny, cls: 'num' },
      { t: '無法判斷', f: (c) => V.num(c.counts.unknown), s: (c) => c.counts.unknown, cls: 'num' },
      { t: '總數', f: (c) => V.num(c.counts.total), s: (c) => c.counts.total, cls: 'num' },
      { t: '代表規則', f: (c) => (c.rule ? decisiveText(Q, c.rule) : '—'), s: (c) => (c.rule ? decisiveText(Q, c.rule) : null) },
      { t: '無法判斷的原因', f: (c) => c.reasons.map((x) => `${V.reachReason(x.code)}（${V.num(x.count)}）`).join('、'), s: (c) => (c.reasons[0] || {}).code },
    ], mx.cells, { onRow: (c) => openCell(App, c.src, c.dst), rowClass: (c) => 'l4-row st-' + c.status, limit: TABLE_LIMIT }));
  }
  function downloadCsv(App) {
    const mx = st.current; if (!mx) { V.app.banner('zone 矩陣還在計算，完成後再下載。', 4000); return; }
    const Q = App.Q; const C = V.exporter.csvCell;
    const head = ['來源 zone', '目的 zone', 'zone 內', '狀態', '異質', '允許', '拒絕', '無法判斷', '總數', '代表規則', '無法判斷的原因'];
    const rows = mx.cells.map((c) => [zoneName(Q, c.src), zoneName(Q, c.dst), c.diagonal ? '是' : '', V.L4_STATUS[c.status], c.heterogeneous ? '是' : '',
      c.counts.allow, c.counts.deny, c.counts.unknown, c.counts.total, c.rule ? decisiveText(Q, c.rule) : '', c.reasons.map((x) => `${V.reachReason(x.code)}（${x.count}）`).join('、')]);
    const text = '﻿' + [head].concat(rows).map((r) => r.map(C).join(',')).join('\r\n') + '\r\n';
    V.exporter.download(`l4-matrix-${V.exporter.baseName(Q)}${st.service ? '-' + st.service.replace('/', '-') : ''}.csv`, text, 'text/csv;charset=utf-8');
  }

  // ---------------------------------------------------------------- zone 的依據
  function renderZones(App) {
    const Q = App.Q; const z = Q.zones(zo()); const box = V.clear(els.zones);
    box.appendChild(h('h3', { id: 'l4-zones-title', class: 'work-card-title' }, ['zone 的依據 ', V.chip('推論', 'info')]));
    if (st.zo && st.zo.error) box.appendChild(h('p', { class: 'warn-line l4-profile-error' }, '命名規則的 zones 段沒有套用：' + st.zo.error));
    box.appendChild(h('p', { class: 'muted l4-note' }, '每個 IPv4 直連網段依序取第一個有結果的來源：命名規則的 zones 標籤 → interface list → VLAN → 網段本身。命名規則的標籤是註解，其餘都是推論（同一個 VLAN ID 視為同一個 zone）。'));
    box.appendChild(h('div', { class: 'work-table' }, V.table([
      { t: 'zone', f: (x) => h('span', { class: 'l4-zone-row', 'data-zone': x.id }, zoneLabel(x)), s: (x) => x.name },
      { t: '來源', f: (x) => V.ZONE_SOURCE[x.source] || x.source, s: (x) => x.source },
      { t: '依據', f: (x) => x.basis || '' },
      { t: '網段', f: (x) => h('span', { class: 'mono' }, x.subnets.join('、')), s: (x) => x.subnets.length },
      { t: '設備', f: (x) => V.num(x.devices.length), s: (x) => x.devices.length, cls: 'num' },
    ], z.zones)));
    const zi = zoneIndex(Q);
    box.appendChild(h('details', { class: 'l4-fold' }, [h('summary', null, `每個網段的依據（${V.num(z.subnets.length)}）`), h('div', { class: 'work-table' }, V.table([
      { t: '網段', f: (s) => h('span', { class: 'mono' }, s.prefix), s: (s) => s.prefix },
      { t: 'zone', f: (s) => (zi.get(s.zone) || { name: s.zone }).name, s: (s) => (zi.get(s.zone) || { name: s.zone }).name },
      { t: '來源', f: (s) => h('span', null, [V.ZONE_SOURCE[s.source] || s.source, s.inferred ? ' ' : '', s.inferred ? V.chip('推論', 'info') : null]) },
      { t: '依據', f: (s) => s.basis || '' },
      { t: '其他來源的結果', f: (s) => s.alternatives.map((a) => `${V.ZONE_SOURCE[a.source] || a.source}：${(zi.get(a.zone) || { name: a.zone.replace(/^[a-z-]+:/, '') }).name}`).join('、') },
    ], z.subnets, { limit: 500 }))]));
  }

  // ---------------------------------------------------------------- 下鑽
  /** L0 → L1／L2：一格的位址組與牽涉的規則（Q.zoneCell）；焦點移到下鑽的標題 */
  function openCell(App, src, dst) {
    hideTip();
    st.cell = { src, dst }; st.reach = null; st.reachReq = null; st.reachErr = null; st.showAllGroups = false;
    st.cellData = App.Q.zoneCell(src, dst, optsOf(st.service));
    renderDrill(App);
    announce(`已開啟 ${zoneName(App.Q, src)} → ${zoneName(App.Q, dst)} 的下鑽：${V.L4_STATUS[st.cellData.status]}`);
    focusDrill();
  }
  /** L1 → L3：某一組（來源代表 → 目的）在某個服務的逐跳路徑 */
  function openGroup(App, gi, svcId) {
    const c = st.cellData; const g = c && c.groups[gi]; if (!g) return;
    const s = svcOf(svcId || g.services[0].service);
    query(App, { src: g.srcs[0].ip, dst: g.dst.ip, proto: s.proto, port: s.port, from: 'cell', group: gi, service: svcId || g.services[0].service });
  }
  /** 可達性查詢（表單）：結果用同一個 L3 畫面；表單的查詢不屬於任何格子，關掉 L1／L2 */
  function runReach(App, src, dst, proto, port) {
    const p = PROTOS.includes(proto) ? proto : String(proto || 'tcp');
    const pt = p === 'icmp' || port === '' || port == null ? (p === 'icmp' ? null : undefined) : /^\d+$/.test(String(port)) ? Number(port) : port;
    st.cell = null; st.cellData = null;
    els.src.value = src; els.dst.value = dst; els.proto.value = p; els.port.value = pt == null ? '' : String(pt); els.port.disabled = p === 'icmp';
    query(App, { src, dst, proto: p, port: pt, from: 'form' });
  }
  function query(App, req) {
    st.reachReq = req; st.reach = null; st.reachErr = null;
    try {
      const r = App.Q.reach(req.src, req.dst, { proto: req.proto, port: req.port });
      if (r.ok) st.reach = r; else st.reachErr = r.error;
    } catch (e) { st.reachErr = e.message; } // 參數不合法（例如 tcp 沒有埠）：核心丟 TypeError，原文顯示
    renderDrill(App);
    announce(st.reach ? `L3：${req.src} → ${req.dst} ${svcLabel(req)} ${V.VERDICT[st.reach.verdict]}` : `L3：查詢失敗，${st.reachErr}`);
    focusDrill(st.cell ? 'l3' : null);
  }
  const svcLabel = (q) => q.proto + (q.port != null ? '/' + q.port : '');
  function announce(text) { if (els) els.live.textContent = text; }
  function focusDrill(part) {
    const t = part === 'l3' ? $('#l4-l3-title') : $('#l4-drill-title');
    if (t) { t.focus(); if (t.scrollIntoView) t.scrollIntoView({ block: 'start' }); }
  }

  function renderDrill(App) {
    const box = V.clear(els.drill);
    const has = !!(st.cellData || st.reach || st.reachErr);
    box.classList.toggle('hidden', !has);
    if (!has) return;
    const Q = App.Q;
    if (st.cellData) {
      const c = st.cellData;
      box.appendChild(h('h3', { id: 'l4-drill-title', class: 'work-card-title', tabindex: '-1' }, `下鑽：${zoneName(Q, c.src)} → ${zoneName(Q, c.dst)}`));
      box.appendChild(h('div', { class: 'row' }, [statusTag(c.status), c.heterogeneous ? hetBadge() : null, c.diagonal ? V.chip('zone 內') : null,
        V.chip(`允許 ${V.num(c.counts.allow)}・拒絕 ${V.num(c.counts.deny)}・無法判斷 ${V.num(c.counts.unknown)}／共 ${V.num(c.counts.total)}`),
        st.service ? V.chip('服務 ' + st.service) : V.chip('全部服務'),
        h('button', { type: 'button', class: 'ghost l4-close', onclick: () => closeDrill(App) }, '關閉下鑽')]));
      if (c.reasons.length) box.appendChild(h('div', { class: 'l4-reasons' }, [h('b', null, '無法判斷的原因：'), h('ul', null, c.reasons.map((x) => h('li', { class: 'l4-reason', 'data-code': x.code, title: reasonNote(x.code) }, `${V.reachReason(x.code)}（${V.num(x.count)} 組）`)))]));
      box.appendChild(groupsBlock(App, c));
      box.appendChild(rulesBlock(App, c));
    } else {
      box.appendChild(h('h3', { id: 'l4-drill-title', class: 'work-card-title', tabindex: '-1' }, '可達性查詢的結果'));
      box.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost l4-close', onclick: () => closeDrill(App) }, '關閉')));
    }
    if (st.reach || st.reachErr) box.appendChild(reachBlock(App));
  }
  function closeDrill(App) {
    st.cell = null; st.cellData = null; st.reach = null; st.reachReq = null; st.reachErr = null; renderDrill(App);
    const td = gridCells[st.focus[0]] && gridCells[st.focus[0]][st.focus[1]];
    if (td) td.focus(); else { const t = $('#l4-matrix-title'); if (t) t.focus(); }
  }
  /** 重畫下鑽後把焦點放回同一個切換按鈕（按鈕是重新建立的） */
  const rerenderKeep = (App, sel) => { renderDrill(App); const b = els.drill.querySelector(sel); if (b) b.focus(); };
  /**
   * L1：目的 × 結果相同的來源代表（Q.zoneCell 的 groups）。
   * 異質的格子（規格書 §5.7）：預設只列造成差異的組（groups[].divergent），可切換顯示全部；造成差異的服務（divergentServices）另標「≠ 差異」文字。
   * 其他格子：全部拒絕的組預設收起。
   */
  function groupsBlock(App, c) {
    const Q = App.Q; const all = c.groups.map((g, i) => ({ g, i }));
    const divN = all.filter((x) => x.g.divergent).length;
    const het = c.heterogeneous && divN > 0;
    let rows = all; let hidden = 0; let toggle = null; let divNote = null;
    if (het) {
      const only = !st.showAllGroups;
      if (only) rows = all.filter((x) => x.g.divergent);
      if (divN < all.length) {
        toggle = h('button', { type: 'button', class: 'ghost l4-show-all', 'aria-pressed': String(!only), onclick: () => { st.showAllGroups = !st.showAllGroups; rerenderKeep(App, '.l4-show-all'); } },
          only ? `顯示全部（${V.num(all.length)} 組）` : `只顯示造成差異的組（${V.num(divN)}）`);
      }
      divNote = h('p', { class: 'l4-note l4-div-note' }, [hetBadge(), ' ',
        only && divN < all.length ? `這一格異質：只列出造成差異的 ${V.num(divN)} 組（共 ${V.num(all.length)} 組）。` : `這一格異質：${V.num(all.length)} 組中有 ${V.num(divN)} 組造成差異。`,
        '造成差異是指某個服務的結果和同一個目的的其他來源、或同一批來源往其他目的的結果不同，而且是少數（平手時兩邊都算）；那個服務的按鈕標「≠ 差異」。']);
    } else {
      hidden = st.hideDeny && all.some((x) => x.g.status !== 'deny') ? all.filter((x) => x.g.status === 'deny').length : 0;
      if (hidden) rows = all.filter((x) => x.g.status !== 'deny');
      toggle = all.some((x) => x.g.status === 'deny') && all.some((x) => x.g.status !== 'deny')
        ? h('button', { type: 'button', class: 'ghost l4-hide-deny', 'aria-pressed': String(st.hideDeny), onclick: () => { st.hideDeny = !st.hideDeny; rerenderKeep(App, '.l4-hide-deny'); } },
          st.hideDeny ? `顯示全部拒絕的組（${V.num(all.filter((x) => x.g.status === 'deny').length)}）` : '收起全部拒絕的組') : null;
    }
    const divMark = () => hetBadge('≠ 差異', 'l4-div-mark');
    const srcText = (g) => (g.srcs.length === 1 ? g.srcs[0].ip : `${g.srcs[0].ip} 等 ${V.num(g.srcs.length)} 個`);
    const srcTitle = (g) => g.srcs.map((s) => `${s.ip}（${s.range ? s.range.join('–') : s.subnet || ''}；${s.basis === 'arp' ? 'ARP 看到的位址' : '推算的位址'}）`).join('\n');
    return h('div', { class: 'l4-sub' }, [
      h('h4', null, ['L1：位址組 ', V.chip(String(c.groups.length))]),
      h('p', { class: 'muted l4-note' }, '每一列是一個目的與一組結果相同的來源代表；點一列或某個服務看逐跳路徑（L3）。代表位址是等價類的代表：同一個區段內的位址對所有規則的位址條件結果相同。'),
      divNote, toggle,
      c.groups.length ? h('div', { class: 'work-table' }, V.table([
        { t: '目的', f: ({ g }) => h('span', null, [h('span', { class: 'mono' }, g.dst.ip), ' ',
          g.dst.via === 'nat' ? V.chip(`dst-nat 入口 → ${g.dst.natTo}`, 'info', { title: `${Q.devName(g.dst.dev)} 的 dst-nat 規則把這個位址改寫到 ${g.dst.natTo}` }) : null,
          h('span', { class: 'muted' }, ` ${zoneName(Q, g.dst.zone)}`)]) },
        { t: '來源（代表）', f: ({ g }) => h('span', { class: 'mono', title: srcTitle(g) }, srcText(g)) },
        { t: '結果', f: ({ g, i }) => h('span', { class: 'l4-svcs' }, g.services.map((s) => {
          const dv = g.divergentServices.includes(s.service);
          return h('button', {
            type: 'button', class: 'l4-svc st-' + s.verdict + (dv ? ' div' : ''), 'data-service': s.service, 'data-group': String(i), 'data-divergent': dv ? 'true' : null,
            title: dv ? `${s.service} 的結果造成這一格異質；看逐跳路徑` : `看 ${s.service} 的逐跳路徑`,
            style: { background: cellBg(s.verdict), color: TH().text },
            onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); openGroup(App, i, s.service); },
          }, [statusMark(s.verdict), ` ${s.service} ${V.VERDICT[s.verdict]}`, s.final && (s.final.dst !== g.dst.ip || s.final.port !== svcOf(s.service).port) ? ` → ${s.final.dst}${s.final.port != null ? ':' + s.final.port : ''}` : '', dv ? divMark() : null]);
        })) },
        { t: '狀態', f: ({ g }) => statusTag(g.status), s: ({ g }) => g.status },
      ].concat(het ? [{ t: '造成差異的服務', f: ({ g }) => (g.divergent ? h('span', { class: 'l4-div-svcs' }, ['≠ ', h('span', { class: 'mono' }, g.divergentServices.join('、'))]) : '—'), s: ({ g }) => g.divergentServices.length }] : [], [
        { t: '閘道／入口', f: ({ g }) => g.srcDevices.map((x) => (x.includes('|') ? Q.epName(x) : Q.devName(x))).join('、') || '—' },
      ]), rows, { onRow: ({ i }) => openGroup(App, i), limit: ROW_LIMIT, rowClass: ({ g }) => 'l4-group st-' + g.status + (g.divergent ? ' div' : '') })) : h('p', { class: 'muted' }, '這一格沒有可算的位址組合。'),
      hidden ? h('p', { class: 'muted' }, `另有 ${V.num(hidden)} 組全部拒絕，已收起。`) : null,
      het && rows.length < all.length ? h('p', { class: 'muted' }, `另有 ${V.num(all.length - rows.length)} 組沒有造成差異，已收起。`) : null,
    ]);
  }
  /** L2：牽涉的規則（Q.zoneCell 的 ruleDetails）：決定結果的規則、chain 結尾的預設與路由，以及條件無法判斷的規則 */
  function rulesBlock(App, c) {
    const rows = c.ruleDetails;
    return h('div', { class: 'l4-sub' }, [
      h('h4', null, ['L2：牽涉的規則 ', V.chip(String(rows.length))]),
      rows.length ? h('div', { class: 'work-table' }, V.table([
        { t: '規則', f: (x) => ruleLink(App, x) },
        { t: '允許', f: (x) => V.num(x.verdicts.allow), s: (x) => x.verdicts.allow, cls: 'num' },
        { t: '拒絕', f: (x) => V.num(x.verdicts.deny), s: (x) => x.verdicts.deny, cls: 'num' },
        { t: '無法判斷', f: (x) => V.num(x.verdicts.unknown), s: (x) => x.verdicts.unknown, cls: 'num' },
        { t: '條件無法判斷', f: (x) => (x.uncertain ? V.num(x.uncertain) : ''), s: (x) => x.uncertain, cls: 'num' },
        { t: '服務', f: (x) => h('span', { class: 'mono' }, x.services.join(' ')) },
      ], rows, { limit: ROW_LIMIT, rowClass: () => 'l4-ruledetail' })) : h('p', { class: 'muted' }, '沒有牽涉的規則。'),
    ]);
  }
  /** L3：Q.reach 的結果：結論、起點、NAT 之後的目的、決定的規則、無法判斷的原因與每條路徑的逐跳 */
  function reachBlock(App) {
    const Q = App.Q; const q = st.reachReq; const r = st.reach;
    const title = `L3：${q.src} → ${q.dst} ${svcLabel(q)}`;
    const out = [h('h4', { id: 'l4-l3-title', tabindex: '-1' }, title)];
    if (!r) { out.push(h('p', { class: 'diffA l4-reach-error' }, '無法查詢：' + st.reachErr)); return h('div', { class: 'l4-sub l4-l3' }, out); }
    const start = r.start || {};
    out.push(h('div', { class: 'row' }, [h('span', { class: 'l4-verdict', 'data-verdict': r.verdict }, verdictTag(r.verdict)),
      r.natApplied && r.final ? V.chip(`NAT 之後 ${r.final.dst}${r.final.port != null ? ':' + r.final.port : ''}`, 'info', { class: 'chip info l4-final' }) : null,
      q.from === 'cell' ? V.chip(`從 ${zoneName(Q, (st.cellData || {}).src)} → ${zoneName(Q, (st.cellData || {}).dst)} 的第 ${q.group + 1} 組`) : null]));
    out.push(P().kv([
      ['起點', [V.REACH_START[start.how] || start.how, start.prefix ? `（${start.prefix}${start.basis ? '，' + (V.REACH_START_BASIS[start.basis] || start.basis) : ''}）` : '',
        start.dev ? '：' : '', start.dev ? devLink(App, start.dev) : null, start.ep ? h('span', { class: 'mono muted' }, ' ' + epText(Q, start.ep)) : null,
        !start.dev && (start.gateways || []).length ? '：' + start.gateways.map((g) => Q.devName(g.dev)).join('、') : ''].filter((x) => x !== '' && x != null)],
      ['NAT 之後的目的', r.final ? h('span', { class: 'mono' }, `${r.final.dst}${r.final.port != null ? ':' + r.final.port : ''}${r.natApplied ? '' : '（沒有改寫）'}`) : '各路徑不同'],
      ['決定結果', r.decisive.length ? h('div', null, r.decisive.map((x) => h('div', null, ruleLink(App, x)))) : '—'],
    ]));
    if (r.reasons.length) out.push(h('div', { class: 'l4-reasons' }, [h('b', null, '無法判斷的原因：'), h('ul', null, r.reasons.map((x) => reasonItem(App, x)))]));
    if (r.notes.length) out.push(h('div', { class: 'l4-notes' }, [h('b', null, '附註：'), h('ul', null, r.notes.map((x) => reasonItem(App, x)))]));
    r.paths.forEach((p, n) => out.push(pathBlock(App, p, n, r.paths.length)));
    out.push(h('details', { class: 'l4-fold' }, [h('summary', null, '這次查詢的前提'), h('ul', null, r.assumptions.map((a) => h('li', null, a.message)))]));
    return h('div', { class: 'l4-sub l4-l3' }, out);
  }
  function pathBlock(App, p, n, total) {
    const Q = App.Q;
    const addr = (ip, port) => (ip == null ? '（來源位址不明）' : ip + (port != null ? ':' + port : ''));
    return h('div', { class: 'l4-path', 'data-verdict': p.verdict }, [
      h('div', { class: 'l4-path-head' }, [total > 1 ? `路徑 ${n + 1}：` : '路徑：', verdictTag(p.verdict)]),
      h('ol', { class: 'l4-hops' }, p.hops.map((hp) => h('li', { class: 'l4-hop', 'data-dev': hp.dev }, [
        h('div', null, [h('b', null, devLink(App, hp.dev)), hp.chain ? h('span', { class: 'muted' }, ` ${hp.chain}`) : null,
          hp.collected ? null : V.chip('未收集', 'warn'), hp.firewall === 'none' && hp.collected ? V.chip('沒有防火牆資料', 'warn') : null, ' ',
          hp.verdict === 'pass' ? statusTag('allow', '這一跳通過') : verdictTag(hp.verdict)]),
        h('div', { class: 'mono l4-hop-addr' }, `${addr(hp.src, null)} → ${addr(hp.dst, hp.port)}${hp.dstOut !== hp.dst || hp.portOut !== hp.port ? `　改寫為 ${addr(hp.dstOut, hp.portOut)}` : ''}${hp.srcOut !== hp.src ? `　來源改寫為 ${addr(hp.srcOut, null)}` : ''}`),
        h('div', { class: 'muted' }, `入 ${hp.inKnown ? epText(Q, hp.in) : '不明'}・出 ${hp.outKnown ? epText(Q, hp.out) : '不明'}${hp.route ? `・路由 ${hp.route.prefix || '—'}（${hp.route.proto || '—'}）${hp.route.gateway ? ' 經 ' + hp.route.gateway : ''}` : ''}`),
        hp.stages.length ? h('ul', { class: 'l4-stages' }, hp.stages.map((sg) => h('li', { 'data-status': sg.status }, [
          h('span', { class: 'mono' }, `${sg.table} ${sg.chain}`), '：',
          sg.status === 'decided' ? (sg.rule ? ruleLink(App, sg.rule) : (sg.note || '').replace(/^[^：]*：/, '')) : `無法判斷（可能 ${S.util.uniq(sg.outcomes.map((o) => o.verdict)).join('／')}）`,
          sg.status === 'decided' && sg.verdict ? h('span', { class: 'muted' }, `　→ ${sg.verdict}`) : null,
          sg.via.length ? h('span', { class: 'muted' }, ['　經由 ', ...sg.via.flatMap((x, k) => [k ? '、' : '', ruleLink(App, x)])]) : null,
        ]))) : null,
        hp.nat.length ? h('ul', { class: 'l4-nat' }, hp.nat.map((x) => h('li', null, [h('b', null, `${x.dir === 'dst' ? '目的' : '來源'} NAT（${x.type}）`), `：${x.before == null ? '不明' : x.before} → ${x.after == null ? '不明' : x.after}　`, ruleLink(App, x.rule)]))) : null,
        hp.service ? h('div', { class: 'muted' }, `設備的服務 ${hp.service.name}（埠 ${hp.service.port}）：${hp.service.enabled ? (hp.service.accepts === false ? '來源不在允許的位址內' : hp.service.accepts == null ? '來源位址不明' : '接受') : '停用'}`) : null,
        hp.reasons.length ? h('ul', { class: 'l4-reasons' }, hp.reasons.map((x) => reasonItem(App, x))) : null,
      ]))),
      p.end ? h('div', { class: 'l4-end', 'data-code': p.end.code, title: reasonNote(p.end.code) }, [h('b', null, '結束：' + V.reachReason(p.end.code)), p.end.message ? '　' + p.end.message : '']) : null,
    ]);
  }

  V.l4 = {
    show, MATRIX_MAX,
    /** 查詢 zone 的參數（命名規則的 zones 段，核對失敗時不套用並附 error）；規則的 L4 影響（panels/firewall.js）用同一份 */
    zoneOpts,
    /** 測試與其他畫面用：目前的檢視狀態（複本） */
    state: () => ({ service: st.service, mode: st.mode, cell: st.cell ? Object.assign({}, st.cell) : null, reach: st.reach, reachReq: st.reachReq ? Object.assign({}, st.reachReq) : null, reachErr: st.reachErr, focus: st.focus.slice(), error: st.error,
      showAllGroups: st.showAllGroups, computing: job ? { service: job.key, progress: job.progress ? Object.assign({}, job.progress) : null } : null }),
    openCell, openGroup, runReach,
    /** 這個畫面在某份基準上算過的矩陣（service → 毫秒數）；大型冒煙測試讀計算時間 */
    timings: (Q) => new Map(computed.get(Q) || []),
    /** 分段計算的紀錄（service → { ms, wallMs, steps, maxStepMs：一段最久佔住主執行緒多久, maxGapMs：兩段之間最長的間隔 }） */
    runs: (Q) => new Map(runs.get(Q) || []),
  };
})(globalThis.SSOT = globalThis.SSOT || {});
