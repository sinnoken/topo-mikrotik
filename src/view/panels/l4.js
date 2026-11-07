/*
 * L4 可達性（M2）：zone 矩陣（L0）→ 一格的位址組（L1）與牽涉的規則（L2）→ 逐跳的可達性（L3），以及直接輸入的可達性查詢。
 * 拓樸圖工具列選了「L4 可達性」時顯示在 #view-l4（疊在畫布上、工具列下面；app-layers.js 的 App.showLayer）。
 *
 * 資料全部來自查詢層：Q.zoneMatrix（L0）、Q.zoneCell（L1／L2）、Q.reach（L3）、Q.zones、Q.assumptionUse（哪些前提影響這份基準），
 * 以及 S.query.l4Services／reachDefinition／reachAssumptions／exposureAssumptions／traceAssumptions／reasonAssumptions。
 * 這些都是推論，由查詢層計算並快取，不寫進基準（ADR-014）；畫面不自己判斷規則或路由，只負責選取、顯示與鍵盤操作。
 * 目前的 service、檢視方式（矩陣／表格）與下鑽到哪裡是檢視狀態，只在記憶體，不存進 store，換基準時清掉。
 * 顏色與符號取自 theme.l4；格子狀態一律有符號與文字（V.L4_STATUS），不只靠顏色。
 * 第一次計算矩陣（大型網路要數秒）時用 Q.zoneMatrixSteps 分段計算：每段約 25 ms，段與段之間 setTimeout(0) 讓出主執行緒，
 * 進度條顯示目前的階段與進度，計算中畫面仍可操作；換 service、換基準或離開 L4 時放棄（it.return()），不畫過期的結果，查詢層也不留快取。
 * 同一份基準、同一個 service 再開時直接使用查詢層的快取。
 * 由外而內：頁首的暴露清單（Q.exposureSteps）一顯示 L4 就算，show() 回傳它（App.l4Job）；zone 矩陣只在「內部互通」展開時才算
 * （沒有 WAN 時自動展開），它的計算放在 App.l4MatrixJob。規則詳情的「計算 L4 影響」（Q.ruleImpact）照舊在查詢層算矩陣。
 *
 * 分成四個檔（依序載入）；檔案之間只經由內部命名空間 V.l4._（不列在 V.l4 的成員裡）互相呼叫，每個函式只定義在一個檔：
 *   l4.js          進入點：共用的檢視狀態 st 與元素 els、共用的文字與符號、骨架（mount）、show、zone 的依據，以及 V.l4 的對外成員
 *   l4-exposure.js 由外而內三段：暴露清單、分組、拒絕的說明、IPv6、回程不保證、看路徑就地展開、判斷的前提
 *   l4-matrix.js   內部互通：zone 矩陣的分段計算、格子、表格、CSV、圖例與提示
 *   l4-trace.js    明細（L1 位址組、L2 規則）、可達性查詢與逐跳路徑（L3）
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const TH = () => V.theme.l4;
  /** 矩陣最多畫幾個 zone（N² 個格子）；超過時只有表格檢視 */
  const MATRIX_MAX = 60;
  // 下鑽與矩陣的表格檢視不設上限：列多時用 V.bigList 分頁（每頁 V.BIG_LIST.page 列）
  /** 暴露清單每一段先列幾列（其餘「顯示全部（N）」，展開後分頁） */
  const EX_LIMIT = 20;
  /** 顯示忙碌提示後，等多久才開始計算（讓瀏覽器先畫出提示） */
  const BUSY_DELAY = 40;
  const PROTOS = ['tcp', 'udp', 'icmp'];

  // 檢視狀態（不寫進基準、不存進 store）
  //   mx：「全部服務」的矩陣（服務選單的選項）；current：目前畫的矩陣（CSV 用）；showAllGroups：異質格子的 L1 是否列出全部的組
  //   vrf：矩陣依來源 zone 的 VRF 篩選（'' 是全部）；reachVrfs：可達性查詢的來源在多個 VRF 時，可以選的 VRF
  const st = { Q: null, service: '', mode: 'matrix', vrf: '', cell: null, cellData: null, reach: null, reachReq: null, reachErr: null, reachVrfs: null, hideDeny: true, showAllGroups: false, focus: [0, 0], mx: null, current: null, error: null,
    // exPath：暴露清單就地展開的逐跳路徑 { sec, row, req, reach, err, vrfs }；exAll：列出全部的段（超過 EX_LIMIT 列時，分頁）
    // exAt：最後看路徑或收起路徑的那一列 { sec, row }（重畫後分頁翻到它所在的那一頁，焦點才回得去）
    exPath: null, exAll: new Set(), exAt: null };
  /** 畫面的元素：第一次顯示時 mount 填入（els.root 有值表示已經建立）；各檔共用同一個物件 */
  const els = {};
  /** 原因代碼的說明（S.query.reachReasonCodes 的 note），放在原因的提示裡 */
  let reasonNotes = null;
  const reasonNote = (code) => { if (!reasonNotes) reasonNotes = new Map(S.query.reachReasonCodes().map((x) => [x.code, x.note])); return reasonNotes.get(code) || null; };
  /** 原因代碼的層級（S.query.reachReasonCodes 的 layer；查詢層沒列的代碼同查詢層算 filter） */
  let reasonLayers = null;
  const layerOf = (code) => { if (!reasonLayers) reasonLayers = new Map(S.query.reachReasonCodes().map((x) => [x.code, x.layer])); return reasonLayers.get(code) || 'filter'; };
  /** 依層級分組：[{ layer, label, items }]，順序是 V.REACH_LAYER 的鍵（路由 → 防火牆 → NAT → 前提），沒列在那裡的層級接在最後 */
  function byLayer(list, codeOf) {
    const m = new Map(Object.keys(V.REACH_LAYER).map((l) => [l, []]));
    list.forEach((x) => { const l = layerOf(codeOf(x)); if (!m.has(l)) m.set(l, []); m.get(l).push(x); });
    return Array.from(m, ([layer, items]) => ({ layer, label: V.REACH_LAYER[layer] || layer, items })).filter((g) => g.items.length);
  }
  /** 一行的分層原因「路由：A、B；防火牆：C」（暴露清單的列、矩陣的提示與 aria-label） */
  const layerText = (list, codeOf, fmt) => byLayer(list, codeOf).map((g) => `${g.label}：${g.items.map(fmt).join('、')}`).join('；');
  /** 分組的原因清單：每一層一個 li.l4-reason-layer（「路由：」＋該層的原因） */
  const layerList = (list, codeOf, item) => h('ul', null, byLayer(list, codeOf).map((g) => h('li', { class: 'l4-reason-layer', 'data-layer': g.layer }, [h('b', null, g.label + '：'), h('ul', null, g.items.map(item))])));
  /** 路由層結果 → 狀態符號（theme.l4.status 的鍵）：抵達 ✓、沒到（沒有路由、黑洞、策略路由丟棄、迴圈）✕、不明 ? */
  const ROUTE_MARK = { reached: 'allow', 'no-route': 'deny', blackhole: 'deny', 'policy-drop': 'deny', loop: 'deny', unknown: 'unknown' };
  /**
   * 分層結果「路由 ✓ → 防火牆 ✕」（Q.reach paths[].route／filter 的 status）：符號＋文字（符號不只靠顏色，完整說法在 title 與 sr-only）；
   * 路由沒到時防火牆寫「—」。route 為 null 時（IPv6 只看邊界路由器）只寫防火牆
   */
  function layerLine(route, filter) {
    const title = (route ? `路由：${V.ROUTE_STATUS[route] || route}；` : '') + `防火牆：${V.FILTER_STATUS[filter] || filter}`;
    return h('span', { class: 'l4-layers', 'data-route': route || null, 'data-filter': filter, title }, [
      route ? h('span', { class: 'l4-layer' }, ['路由 ', statusMark(ROUTE_MARK[route] || 'unknown')]) : null, route ? ' → ' : null,
      h('span', { class: 'l4-layer' }, ['防火牆 ', filter === 'n/a' ? h('span', { 'aria-hidden': 'true' }, '—') : statusMark(filter)]),
      h('span', { class: 'sr-only' }, `（${title}）`)]);
  }
  /** 拒絕的拆分「沒有路由 a、防火牆拒絕 b、沒被 dst-nat 改寫 c」（Q.zoneMatrix／Q.zoneCell／Q.exposure 的 deniedBy；只寫非 0 的） */
  const DENIED_BY = [['noRoute', '沒有路由'], ['filter', '防火牆拒絕'], ['notNatted', '沒被 dst-nat 改寫']];
  const deniedParts = (by) => (by ? DENIED_BY.filter(([k]) => by[k]).map(([k, t]) => `${t} ${V.num(by[k])}`).join('、') : '');

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
      try { Q.zones({ profile: p }); out = { opts: { profile: p }, error: null }; } catch (e) { out = { opts: {}, error: V.reason(e) }; }
    }
    zoCache.set(Q, { p, out });
    return out;
  }
  const zo = () => (st.zo ? st.zo.opts : {});
  const optsOf = (id) => Object.assign({}, zo(), id ? { services: [svcOf(id)] } : {});
  // zone id → zone：依 Q.zones() 回傳的陣列（查詢層快取，同一份基準是同一個陣列）建一次
  const zoneIdx = new WeakMap();
  const zoneIndex = (Q) => { const zs = Q.zones(zo()).zones; let m = zoneIdx.get(zs); if (!m) { m = new Map(zs.map((z) => [z.id, z])); zoneIdx.set(zs, m); } return m; };
  // 虛擬 zone（外部、網路設備（管理））只在 Q.zoneMatrix 的 zones，不在 Q.zones
  const zoneById = (Q, id) => zoneIndex(Q).get(id) || (st.mx && st.mx.zones.find((z) => z.id === id)) || null;
  const zoneName = (Q, id) => { if (id == null) return '（不在任何 zone）'; const z = zoneById(Q, id); return z ? z.name : id; };
  /** 狀態文字：有確定的結果又有無法判斷的組合時接上「部分無法判斷」 */
  const statusText = (x) => V.L4_STATUS[x.status] + (x.incomplete ? `（${V.L4_INCOMPLETE}）` : '');
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
  /** 一格（或一組）的筆數「允許 N・拒絕 N・無法判斷 N」：用語取自 V.L4_STATUS */
  const countsText = (k, sep) => ['allow', 'deny', 'unknown'].map((s) => `${V.L4_STATUS[s]} ${V.num(k[s])}`).join(sep || '・');
  /** 異質的徽章（文字，不只靠顏色）；顏色取自 theme.l4.badge */
  const hetBadge = (text, cls, title) => { const b = TH().badge; return h('span', { class: 'l4-het' + (cls ? ' ' + cls : ''), title: title || null, style: { background: b.bg, color: b.text, borderColor: b.border } }, text || '≠ 結果不一'); };

  // ---------------------------------------------------------------- 規則與原因的文字
  /** 決定結果的規則（Q.zoneMatrix 的 rule／rules、Q.zoneCell 的 ruleDetails、Q.reach 的 decisive）：規則、chain 結尾的預設或路由 */
  function decisiveText(Q, x) {
    if (!x) return '';
    const r = x.rule && x.rule.position != null ? x.rule : x.position != null ? x : null;
    // position 是 chain 內的序號（從 1 起算），不是 print 的編號
    if (r) return `${Q.devName(r.dev)} ${r.table} ${r.chain} chain 內第 ${r.position} 條 ${r.action}${r.comment ? `（${r.comment}）` : ''}`;
    if (x.route) return `${Q.devName(x.dev)}：${V.reachReason(x.route)}`;
    if (x.policy) return `${Q.devName(x.dev)} ${x.table} ${x.chain} 沒有規則決定，chain 結尾預設${x.verdict === 'accept' ? '放行' : x.verdict}`;
    return x.key || x.id || '';
  }
  /** 規則的連結：點一下在右側開啟規則詳情（命中次數、影響）；規則已不在基準時只顯示文字 */
  function ruleLink(App, x, short) {
    const key = x && (x.key || (x.rule && x.rule.key));
    const full = decisiveText(App.Q, x);
    // short：窄欄用「forward 第 N 條」「input 結尾預設」，完整說明放 title
    const r = x && (x.rule && x.rule.position != null ? x.rule : x.position != null ? x : null);
    const text = !short ? full : r ? `${r.chain} 第 ${r.position} 條` : x && x.policy ? `${x.chain} 結尾預設` : full;
    const title = short && text !== full ? full : null;
    if (!key || !App.Q.getFirewallRule(key)) return h('span', { title }, text);
    return h('a', { class: 'link l4-rule', 'data-rule': key, title, onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); App.select({ type: 'rule', key }); } }, text);
  }

  // ---------------------------------------------------------------- 骨架（第一次顯示時建立一次）
  function mount(App) {
    if (els.root) return;
    const root = $('#view-l4');
    const serviceSel = h('select', { id: 'l4-service', 'aria-label': '矩陣的服務', onchange: () => { st.service = serviceSel.value; App.l4MatrixJob = I.refresh(App); } });
    const modeBtn = (mode, label) => h('button', { type: 'button', 'data-mode': mode, 'aria-pressed': 'false', onclick: () => { st.mode = mode; App.l4MatrixJob = I.refresh(App); } }, label);
    const modes = h('div', { class: 'seg l4-modes', role: 'group', 'aria-label': '檢視方式' }, [modeBtn('matrix', '矩陣'), modeBtn('table', '表格')]);
    const src = h('input', { id: 'l4-src', type: 'text', placeholder: '203.0.113.1', autocomplete: 'off', 'aria-label': '來源 IP' });
    const dst = h('input', { id: 'l4-dst', type: 'text', placeholder: '10.1.20.11', autocomplete: 'off', 'aria-label': '目的 IP' });
    const proto = h('select', { id: 'l4-proto', 'aria-label': '協定' }, PROTOS.map((p) => h('option', { value: p }, p)));
    const port = h('input', { id: 'l4-port', type: 'text', inputmode: 'numeric', placeholder: '443', autocomplete: 'off', 'aria-label': '目的埠', class: 'l4-port' });
    proto.onchange = () => { port.disabled = proto.value === 'icmp'; };
    // VRF（選用）：空字串是「依來源位址決定」；基準只有 main 時不顯示
    const vrf = h('select', { id: 'l4-vrf', 'aria-label': '來源的 VRF' });
    const vrfBox = h('span', { class: 'l4-vrf-box hidden' }, [h('label', { for: 'l4-vrf' }, 'VRF'), ' ', vrf]);
    // 矩陣的 VRF 篩選（依來源 zone 的 VRF）：基準的 zone 在兩個以上的 VRF 時才顯示
    const vrfFilter = h('select', { id: 'l4-vrf-filter', 'aria-label': '依來源 zone 的 VRF 篩選', onchange: () => { st.vrf = vrfFilter.value; st.focus = [0, 0]; if (st.current) { I.renderMatrix(App, st.current); } } });
    const vrfFilterBox = h('span', { class: 'l4-vrf-filter hidden' }, [h('label', { for: 'l4-vrf-filter', class: 'muted' }, 'VRF'), ' ', vrfFilter]);
    const run = () => I.runReach(App, src.value.trim(), dst.value.trim(), proto.value, port.value.trim(), vrf.value);
    [src, dst, port, vrf].forEach((x) => x.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } }));
    Object.assign(els, {
      root, serviceSel, modes, src, dst, proto, port, vrf, vrfBox, vrfFilter, vrfFilterBox,
      status: h('div', { id: 'l4-status', class: 'l4-status', role: 'status', 'aria-live': 'polite' }),
      matrix: h('div', { id: 'l4-matrix', class: 'l4-matrix' }),
      legend: h('div', { id: 'l4-legend', class: 'l4-legend' }),
      drill: h('section', { id: 'l4-drill', class: 'l4-drill hidden', 'aria-labelledby': 'l4-drill-title' }),
      zones: h('section', { id: 'l4-zones', class: 'work-card l4-card', 'aria-labelledby': 'l4-zones-title' }),
      live: h('div', { class: 'sr-only', 'aria-live': 'polite', id: 'l4-live' }),
      tip: h('div', { class: 'l4-tip hidden', role: 'tooltip', id: 'l4-tip' }),
      csv: h('button', { type: 'button', class: 'l4-csv', title: '下載目前 service 的矩陣（每一格一列）', onclick: () => I.downloadCsv(App) }, '下載 CSV'),
    });
    // 提示和矩陣放在同一個定位框裡（矩陣每次重畫，提示留著），位置相對於這個框
    els.box = h('div', { class: 'l4-matrix-box' }, [els.matrix, els.tip]);
    els.exHead = h('p', { id: 'l4-ex-summary', class: 'l4-ex-summary', role: 'status', 'aria-live': 'polite' });
    els.ex = h('section', { id: 'l4-exposure', class: 'work-card l4-card l4-exposure', 'aria-labelledby': 'l4-ex-title' });
    els.matrixFold = h('details', { id: 'l4-matrix-fold', class: 'l4-card-fold' }, [
      h('summary', null, h('h3', { id: 'l4-matrix-title', class: 'work-card-title', tabindex: '-1' }, '內部互通（zone 矩陣）')),
      h('p', { class: 'muted l4-note l4-matrix-note' }, '內部的 zone 之間互相連得到什麼。從外部進來的看上方三段；「外部（Internet）」在這裡只當目的。'),
      h('div', { class: 'l4-card-head' }, [h('label', { for: 'l4-service', class: 'muted' }, '服務'), serviceSel, vrfFilterBox, modes, els.csv]),
      els.status, els.legend, els.box,
    ]);
    // 展開時才計算矩陣（App.l4MatrixJob）；收合時不中斷已經開始的計算
    els.matrixFold.addEventListener('toggle', () => { if (isOpen(els.matrixFold)) App.l4MatrixJob = I.ensureMatrix(App); });
    // 判斷的前提：摘要是判斷方式的一句話；內容（依這份基準有影響的前提）在暴露清單算完或第一次展開時才填（Q.assumptionUse）
    els.assumeFold = h('details', { class: 'l4-fold', id: 'l4-assume-fold' }, [
      h('summary', null, [h('span', { class: 'l4-assume-k' }, '判斷的前提'), h('span', { class: 'l4-assume-def' }, S.query.reachDefinition())]),
      els.assumeBody = h('div', { class: 'l4-assume-body' }),
    ]);
    els.assumeFold.addEventListener('toggle', () => { if (isOpen(els.assumeFold)) I.fillAssume(App); });
    V.clear(root).appendChild(h('div', { class: 'work-inner l4-inner' }, [
      h('div', { class: 'work-head' }, [h('h2', { id: 'l4-title', class: 'work-title', tabindex: '-1' }, 'L4 可達性'), els.exHead]),
      // 由外而內：第一句結論與三段暴露清單（Q.exposure）在最上面；內部互通（zone 矩陣）與可達性查詢預設收合
      // 明細（#l4-drill）就地顯示：格子的明細在矩陣下面，可達性查詢的結果在查詢表單下面（renderDrill 搬到對應的卡片）
      els.ex,
      els.matrixCard = h('section', { class: 'work-card l4-card l4-matrix-card', 'aria-labelledby': 'l4-matrix-title' }, [els.matrixFold, els.drill]),
      els.reachCard = h('section', { class: 'work-card l4-card l4-reach-card', 'aria-labelledby': 'l4-reach-title' }, h('details', { id: 'l4-reach-fold', class: 'l4-card-fold' }, [
        h('summary', null, h('h3', { id: 'l4-reach-title', class: 'work-card-title' }, '可達性查詢')),
        h('p', { class: 'muted l4-note' }, '輸入來源與目的 IP、協定與埠，沿各設備的路由逐跳套用 raw、dst-nat、filter 與 src-nat；結果顯示在表單下面。'),
        h('div', { class: 'form-row l4-form' }, [
          h('label', { for: 'l4-src' }, '來源'), src, h('label', { for: 'l4-dst' }, '目的'), dst,
          h('label', { for: 'l4-proto' }, '協定'), proto, h('label', { for: 'l4-port' }, '埠'), port, vrfBox,
          h('button', { type: 'button', class: 'primary', id: 'l4-run', onclick: run }, '查詢'),
        ]),
      ])),
      // 判斷的前提：頁尾一行（判斷方式），展開看這份基準有影響的前提；路由層只寫「同 L3 路由追蹤」
      h('section', { class: 'work-card l4-card l4-assume', 'aria-labelledby': 'l4-assume-title' }, [
        h('h3', { id: 'l4-assume-title', class: 'sr-only' }, '判斷的前提'), els.assumeFold,
      ]),
      els.zones, els.live,
    ]));
    I.buildLegend();
  }

  // ---------------------------------------------------------------- 顯示
  /**
   * 顯示 L4（App.showLayer）。opt.rebuild：換了基準，清掉下鑽的狀態。回傳暴露清單的計算（Promise，App.l4Job）。
   * zone 矩陣只在內部互通展開時才計算（大型網路要數秒，預設收合時不算）；矩陣的計算另放在 App.l4MatrixJob（測試可等待）
   */
  function show(App, opt) {
    mount(App);
    if (st.Q !== App.Q || (opt && opt.rebuild)) resetState(App.Q);
    st.zo = zoneOpts(App);
    I.syncControls(App);
    if (st.zonesFor !== App.Q || st.zonesZo !== st.zo) renderZones(App);
    if (isOpen(els.assumeFold)) I.fillAssume(App);
    const ex = I.exposure(App);
    // 展開時每次都重畫（換深淺配色時格子要換成新配色；同一份基準算過的直接用快取）
    if (isOpen(els.matrixFold)) App.l4MatrixJob = I.refresh(App);
    else { I.stopJob(); App.l4MatrixJob = Promise.resolve(); }
    return ex;
  }
  function resetState(Q) {
    I.stopJob();
    I.stopEx(); st.ex = null; st.exErr = null; st.exPath = null; st.exAll = new Set(); st.exAt = null;
    Object.assign(st, { Q, service: '', vrf: '', cell: null, cellData: null, reach: null, reachReq: null, reachErr: null, reachVrfs: null, showAllGroups: false, focus: [0, 0], mx: null, current: null, error: null, drawnFor: null, tableAll: false });
    if (els.root) { els.drill.classList.add('hidden'); V.clear(els.drill); V.clear(els.assumeBody); }
    st.assumeFor = null; st.assumeN = 0;
  }
  const isOpen = (d) => !!(d && (d.open || d.getAttribute('open') != null));
  function announce(text) { if (els.root) els.live.textContent = text; }
  /**
   * zone 名稱，旁邊是來源（命名規則、介面清單、VLAN、網段）與「推論」標示；依據在 title。
   * quiet：矩陣的表頭（頁首已標一次推論，每個表頭再掛徽章太雜）只留給輔助科技念的「（推論）」
   */
  function zoneLabel(z, quiet) {
    return h('span', { class: 'l4-zone' }, [h('span', { class: 'l4-zone-name' }, z.name), ' ',
      h('span', { class: 'l4-zone-src' }, V.ZONE_SOURCE[z.source] || z.source),
      z.inferred ? (quiet ? h('span', { class: 'sr-only' }, '（推論）') : h('span', { class: 'l4-zone-inf' }, '推論')) : null]);
  }

  // ---------------------------------------------------------------- zone 的依據
  function renderZones(App) {
    const Q = App.Q; const z = Q.zones(zo()); const box = V.clear(els.zones);
    st.zonesFor = Q; st.zonesZo = st.zo;
    box.appendChild(h('h3', { id: 'l4-zones-title', class: 'work-card-title' }, ['zone 的依據 ', V.chip('推論', 'info')]));
    if (st.zo && st.zo.error) box.appendChild(h('p', { class: 'warn-line l4-profile-error' }, '命名規則的 zones 段沒有套用：' + st.zo.error));
    box.appendChild(h('p', { class: 'muted l4-note' }, '每個 IPv4 直連網段依序取第一個有結果的來源：命名規則的 zones 標籤 → 介面清單（interface list）→ VLAN → 網段本身。命名規則的標籤是註解，其餘都是推論（同一個 VLAN ID 視為同一個 zone）。'));
    // zone 依 VRF 分開：main 以外的 zone id 帶 @<VRF>、名稱帶（VRF …）；有兩個以上的 VRF 時另列一欄
    const mv = S.util.uniq(z.zones.map((x) => x.vrf)).length > 1;
    const vrfCol = mv ? [{ t: 'VRF', f: (x) => h('span', { class: 'mono' }, x.vrf || ''), s: (x) => x.vrf }] : [];
    if (mv) box.appendChild(h('p', { class: 'muted l4-note' }, '每個 VRF 的 zone 分開計算（不同 VRF 是不同的位址空間）：main 以外的 zone 名稱標出 VRF。'));
    box.appendChild(V.table([
      { t: 'zone', f: (x) => h('span', { class: 'l4-zone-row', 'data-zone': x.id }, zoneLabel(x)), s: (x) => x.name }, ...vrfCol,
      { t: '來源', f: (x) => V.ZONE_SOURCE[x.source] || x.source, s: (x) => x.source },
      { t: '依據', f: (x) => x.basis || '' },
      { t: '網段', f: (x) => h('span', { class: 'mono' }, x.subnets.map(V.inVrfText).join('、')), s: (x) => x.subnets.length },
      { t: '設備', f: (x) => V.num(x.devices.length), s: (x) => x.devices.length, cls: 'num' },
    ], z.zones));
    const zi = zoneIndex(Q);
    // 網段多時分頁（V.bigList），可依網段或 zone 名搜尋；不截斷
    box.appendChild(V.section('每個網段的依據', V.bigList([
      { t: '網段', f: (s) => h('span', { class: 'mono' }, V.inVrfText(s.prefix)), s: (s) => s.prefix }, ...vrfCol,
      { t: 'zone', f: (s) => (zi.get(s.zone) || { name: s.zone }).name, s: (s) => (zi.get(s.zone) || { name: s.zone }).name },
      { t: '來源', f: (s) => h('span', null, [V.ZONE_SOURCE[s.source] || s.source, s.inferred ? ' ' : '', s.inferred ? V.chip('推論', 'info') : null]) },
      { t: '依據', f: (s) => s.basis || '' },
      { t: '其他來源的結果', f: (s) => s.alternatives.map((a) => `${V.ZONE_SOURCE[a.source] || a.source}：${(zi.get(a.zone) || { name: a.zone.replace(/^[a-z-]+:/, '') }).name}`).join('、') },
    ], z.subnets, { text: (s) => s.prefix + ' ' + ((zi.get(s.zone) || { name: s.zone }).name), unit: '個網段', what: '網段', placeholder: '搜尋網段或 zone' }), { fold: true, count: z.subnets.length, cls: 'l4-fold' }));
  }

  /**
   * 內部命名空間：這個檔定義的共用狀態與函式；l4-exposure.js、l4-matrix.js、l4-trace.js 載入時把各自的函式加進來，
   * 呼叫另一個檔的函式一律經由它（I.名稱），不複製函式
   */
  const I = {
    st, els, TH, MATRIX_MAX, EX_LIMIT, BUSY_DELAY, PROTOS,
    reasonNote, layerOf, byLayer, layerText, layerList, layerLine, deniedParts, svcOf, zoneOpts, zo, optsOf, zoneIndex, zoneById, zoneName,
    statusText, statusMark, statusTag, cellBg, countsText, hetBadge, decisiveText, ruleLink, isOpen, announce, zoneLabel, renderZones,
  };

  V.l4 = {
    show, MATRIX_MAX,
    /** 查詢 zone 的參數（命名規則的 zones 段，核對失敗時不套用並附 error）；規則的 L4 影響（panels/firewall.js）用同一份 */
    zoneOpts,
    /** 測試與其他畫面用：目前的檢視狀態（複本） */
    state: () => { const job = I.matrixJob(); return { service: st.service, mode: st.mode, vrf: st.vrf, reachVrfs: st.reachVrfs ? st.reachVrfs.slice() : null, cell: st.cell ? Object.assign({}, st.cell) : null, reach: st.reach, reachReq: st.reachReq ? Object.assign({}, st.reachReq) : null, reachErr: st.reachErr, focus: st.focus.slice(), error: st.error,
      showAllGroups: st.showAllGroups, hideDeny: st.hideDeny,
      exPath: st.exPath ? { sec: st.exPath.sec, row: st.exPath.row, req: Object.assign({}, st.exPath.req), reach: st.exPath.reach, err: st.exPath.err } : null, exAll: Array.from(st.exAll),
      computing: job ? { service: job.key, progress: job.progress ? Object.assign({}, job.progress) : null } : null }; },
    // 以下定義在 l4-trace.js（明細與可達性查詢）、l4-exposure.js（暴露清單）
    openCell: (App, src, dst) => I.openCell(App, src, dst),
    openGroup: (App, gi, svcId) => I.openGroup(App, gi, svcId),
    runReach: (App, src, dst, proto, port, vrf) => I.runReach(App, src, dst, proto, port, vrf),
    rerunWithVrf: (App, vrf) => I.rerunWithVrf(App, vrf),
    openExposure: (App, sec, i) => I.openExposure(App, sec, i),
    /** 拒絕的拆分文字（deniedBy → 「沒有路由 a、防火牆拒絕 b、沒被 dst-nat 改寫 c」）與暴露清單一段的「其餘 N 個組合拒絕…」；測試用 */
    deniedParts, deniedSentence: (denied, by, notEvaluated) => I.deniedSentence(denied, by, notEvaluated),
    /** 暴露清單的分段計算紀錄（{ ms, wallMs, steps, maxStepMs, maxGapMs }）；大型冒煙測試讀計算時間 */
    exposureRun: (Q) => I.exRuns.get(Q) || null,
    /** 目前畫的暴露清單（Q.exposure 的結果；還在算時為 null） */
    exposure: () => st.ex,
    /** 這個畫面在某份基準上算過的矩陣（service → 毫秒數）；大型冒煙測試讀計算時間 */
    timings: (Q) => new Map(I.computed.get(Q) || []),
    /** 分段計算的紀錄（service → { ms, wallMs, steps, maxStepMs：一段最久佔住主執行緒多久, maxGapMs：兩段之間最長的間隔 }） */
    runs: (Q) => new Map(I.runs.get(Q) || []),
  };
  // 內部命名空間不是對外成員：不可列舉（Object.keys(V.l4) 與拆檔前相同）
  Object.defineProperty(V.l4, '_', { value: I });
})(globalThis.SSOT = globalThis.SSOT || {});
