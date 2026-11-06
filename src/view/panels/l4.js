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
 * 由外而內：頁首的暴露清單（Q.exposureSteps）一顯示 L4 就算，show() 回傳它（App.l4Job）；zone 矩陣只在「內部互通」展開時才算
 * （沒有 WAN 時自動展開），它的計算放在 App.l4MatrixJob。規則詳情的「計算 L4 影響」（Q.ruleImpact）照舊在查詢層算矩陣。
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
  /** 暴露清單每一段先列幾列（其餘「顯示全部（N）」） */
  const EX_LIMIT = 20;
  /** 顯示忙碌提示後，等多久才開始計算（讓瀏覽器先畫出提示） */
  const BUSY_DELAY = 40;
  const PROTOS = ['tcp', 'udp', 'icmp'];
  /** Q.zoneMatrixSteps 的階段（依序） */
  const STAGES = ['reps', 'evaluate', 'summary'];
  const STAGE_LABEL = { reps: '找代表位址', evaluate: '逐一判斷', summary: '整理格子' };

  // 檢視狀態（不寫進基準、不存進 store）
  //   mx：「全部服務」的矩陣（服務選單的選項）；current：目前畫的矩陣（CSV 用）；showAllGroups：異質格子的 L1 是否列出全部的組
  //   vrf：矩陣依來源 zone 的 VRF 篩選（'' 是全部）；reachVrfs：可達性查詢的來源在多個 VRF 時，可以選的 VRF
  const st = { Q: null, service: '', mode: 'matrix', vrf: '', cell: null, cellData: null, reach: null, reachReq: null, reachErr: null, reachVrfs: null, hideDeny: true, showAllGroups: false, focus: [0, 0], mx: null, current: null, error: null,
    // exPath：暴露清單就地展開的逐跳路徑 { sec, row, req, reach, err, vrfs }；exAll：列出全部的段（超過 EX_LIMIT 列時）
    exPath: null, exAll: new Set() };
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
  // 格子與圖例用的短標：格子很窄，「≠ 結果不一」會蓋住下面的數字；完整說法在 title 與圖例
  const HET_SHORT = '≠'; const hetShort = () => hetBadge(HET_SHORT, null, '結果不一：同一個 zone 的成員結果不一致');
  /** 對角線（zone 內）的虛線外框：顏色取自 theme.l4.diagonal */
  const diagStyle = () => ({ borderColor: TH().diagonal.border, borderStyle: TH().diagonal.dash });

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
  const devLink = (App, d) => h('a', { class: 'link', onclick: () => App.select({ type: 'device', key: d }) }, App.Q.devLabel(d));
  const epText = (Q, ep) => (ep ? Q.epName(ep) : '不明');
  const reasonItem = (App, r) => h('li', { class: 'l4-reason', 'data-code': r.code, title: reasonNote(r.code) }, [
    h('b', null, V.reachReason(r.code)), r.message ? '：' + r.message : '',
    r.rule ? h('span', null, ['（', ruleLink(App, r.rule), '）']) : null,
  ]);
  /** 格子的完整說明（aria-label 與提示共用） */
  function cellText(Q, c) {
    const k = c.counts;
    return `${zoneName(Q, c.src)} → ${zoneName(Q, c.dst)}${c.diagonal ? '（zone 內）' : ''}：${statusText(c)}。`
      + (k.total ? `${countsText(k, '、')}，共 ${V.num(k.total)} 組（位址 × 服務）` : V.L4_STATUS_TIP.empty)
      + (c.heterogeneous ? '；結果不一：同一個 zone 的成員結果不一致' : '')
      + (c.rule ? `；代表規則：${decisiveText(Q, c.rule)}${c.ruleCount > 1 ? `（另有 ${c.ruleCount - 1} 條）` : ''}` : '')
      + (c.reasons.length ? `；無法判斷的原因：${c.reasons.map((x) => `${V.reachReason(x.code)}（${V.num(x.count)}）`).join('、')}` : '');
  }

  // ---------------------------------------------------------------- 骨架（第一次顯示時建立一次）
  function mount(App) {
    if (els) return;
    const root = $('#view-l4');
    const serviceSel = h('select', { id: 'l4-service', 'aria-label': '矩陣的服務', onchange: () => { st.service = serviceSel.value; App.l4MatrixJob = refresh(App); } });
    const modeBtn = (mode, label) => h('button', { type: 'button', 'data-mode': mode, 'aria-pressed': 'false', onclick: () => { st.mode = mode; App.l4MatrixJob = refresh(App); } }, label);
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
    const vrfFilter = h('select', { id: 'l4-vrf-filter', 'aria-label': '依來源 zone 的 VRF 篩選', onchange: () => { st.vrf = vrfFilter.value; st.focus = [0, 0]; if (st.current) { renderMatrix(App, st.current); } } });
    const vrfFilterBox = h('span', { class: 'l4-vrf-filter hidden' }, [h('label', { for: 'l4-vrf-filter', class: 'muted' }, 'VRF'), ' ', vrfFilter]);
    const run = () => runReach(App, src.value.trim(), dst.value.trim(), proto.value, port.value.trim(), vrf.value);
    [src, dst, port, vrf].forEach((x) => x.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } }));
    els = {
      root, serviceSel, modes, src, dst, proto, port, vrf, vrfBox, vrfFilter, vrfFilterBox,
      status: h('div', { id: 'l4-status', class: 'l4-status', role: 'status', 'aria-live': 'polite' }),
      matrix: h('div', { id: 'l4-matrix', class: 'l4-matrix' }),
      legend: h('div', { id: 'l4-legend', class: 'l4-legend' }),
      drill: h('section', { id: 'l4-drill', class: 'l4-drill hidden', 'aria-labelledby': 'l4-drill-title' }),
      zones: h('section', { id: 'l4-zones', class: 'work-card l4-card', 'aria-labelledby': 'l4-zones-title' }),
      live: h('div', { class: 'sr-only', 'aria-live': 'polite', id: 'l4-live' }),
      tip: h('div', { class: 'l4-tip hidden', role: 'tooltip', id: 'l4-tip' }),
      csv: h('button', { type: 'button', class: 'l4-csv', title: '下載目前 service 的矩陣（每一格一列）', onclick: () => downloadCsv(App) }, '下載 CSV'),
    };
    // 提示和矩陣放在同一個定位框裡（矩陣每次重畫，提示留著），位置相對於這個框
    els.box = h('div', { class: 'l4-matrix-box' }, [els.matrix, els.tip]);
    const assumptions = S.query.reachAssumptions();
    els.exHead = h('p', { id: 'l4-ex-summary', class: 'l4-ex-summary', role: 'status', 'aria-live': 'polite' });
    els.ex = h('section', { id: 'l4-exposure', class: 'work-card l4-card l4-exposure', 'aria-labelledby': 'l4-ex-title' });
    els.matrixFold = h('details', { id: 'l4-matrix-fold', class: 'l4-card-fold' }, [
      h('summary', null, h('h3', { id: 'l4-matrix-title', class: 'work-card-title', tabindex: '-1' }, '內部互通（zone 矩陣）')),
      h('p', { class: 'muted l4-note l4-matrix-note' }, '內部的 zone 之間互相連得到什麼。從外部進來的看上方三段；「外部（Internet）」在這裡只當目的。'),
      h('div', { class: 'l4-card-head' }, [h('label', { for: 'l4-service', class: 'muted' }, '服務'), serviceSel, vrfFilterBox, modes, els.csv]),
      els.status, els.legend, els.box,
    ]);
    // 展開時才計算矩陣（App.l4MatrixJob）；收合時不中斷已經開始的計算
    els.matrixFold.addEventListener('toggle', () => { if (isOpen(els.matrixFold)) App.l4MatrixJob = ensureMatrix(App); });
    els.assumeFold = h('details', { class: 'l4-fold', id: 'l4-assume-fold' }, [
      els.assumeSum = h('summary'),
      h('p', { class: 'muted l4-note' }, '只判斷 IPv4 的新連線，只套用 RouterOS 的防火牆與 NAT；條件無法判斷時結果為不明。'),
      els.assumeList = h('ul', { class: 'l4-assume-list' }),
    ]);
    fillAssume(assumptions);
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
      // 判斷的前提：頁尾一行，展開看全部；虛擬 zone（外部、網路設備）的說明也放在這裡
      h('section', { class: 'work-card l4-card l4-assume', 'aria-labelledby': 'l4-assume-title' }, [
        h('h3', { id: 'l4-assume-title', class: 'sr-only' }, '判斷的前提'), els.assumeFold,
      ]),
      els.zones, els.live,
    ]));
    buildLegend();
  }

  /** 圖例：五種狀態（符號、文字、底色）、異質、zone 內（對角線）與數字的意思 */
  function buildLegend() {
    const L = V.clear(els.legend);
    L.appendChild(h('div', { class: 'l4-legend-row' }, Object.keys(V.L4_STATUS).map((k) => h('span', { class: 'l4-legend-item', 'data-status': k, title: V.L4_STATUS_TIP[k] }, [
      h('span', { class: 'l4-swatch', style: { background: cellBg(k) } }, statusMark(k)), V.L4_STATUS[k],
    ])).concat([
      h('span', { class: 'l4-legend-item', 'data-legend': 'heterogeneous', title: '同一個 zone 的成員（代表位址）對同一個目的與服務的結果不一致：zone 切分可能不對，或規則只放行部分位址' }, [hetShort(), '結果不一（成員結果不一致）']),
      h('span', { class: 'l4-legend-item', 'data-legend': 'incomplete', title: '這一格有一部分位址組合的條件無法判斷，結果只算得出來的部分；原因在明細' }, [h('span', { class: 'l4-inc' }, '＋?'), V.L4_INCOMPLETE]),
      h('span', { class: 'l4-legend-item', 'data-legend': 'diagonal', title: '來源與目的是同一個 zone（zone 內的流量，主要受主機防火牆影響，不在範圍內）' }, [h('span', { class: 'l4-swatch diag', style: diagStyle() }), 'zone 內']),
    ])));
    L.appendChild(h('div', { class: 'muted l4-note' }, '每個 zone 取代表位址（ARP 看到的位址優先，否則推算），逐一判斷代表位址 × 目的 × 服務。滑過或用鍵盤移到格子會顯示筆數與代表規則；方向鍵移動，Enter 往下看明細（允許的服務寫成 IP:埠）。'));
    els.legendVirtual = h('div', { class: 'muted l4-note hidden', 'data-legend': 'virtual' });
    L.appendChild(els.legendVirtual);
  }
  /**
   * 圖例的虛擬 zone：名稱與依據取自矩陣的 zones（查詢層，virtual: true），這裡只說明「虛擬」的意思與只當目的的 zone 為什麼沒有來源列。
   * 矩陣沒有虛擬 zone 時收起
   */
  function legendVirtual(mx) {
    const el = V.clear(els.legendVirtual); const vz = mx.zones.filter((z) => z.virtual);
    el.classList.toggle('hidden', !vz.length);
    if (!vz.length) return;
    el.appendChild(h('span', null, `「${V.ZONE_SOURCE.virtual}」的 zone 不是基準中的直連網段，而是代表一類位址（推論）：`));
    el.appendChild(h('ul', { class: 'l4-legend-virtual' }, vz.map((z) => h('li', { 'data-zone': z.id }, [h('b', null, z.name), '：', z.basis || '',
      z.dstOnly ? '。只當目的：只判斷連進設備的流量（輸入規則與管理服務），設備自己發出的流量不在範圍內，所以只在目的欄，沒有來源列'
        : '。這裡只當目的（內部往外部）；從外部進來的結果在上方三段，所以沒有來源列']))));
  }

  // ---------------------------------------------------------------- 顯示與計算
  /**
   * 顯示 L4（App.showLayer）。opt.rebuild：換了基準，清掉下鑽的狀態。回傳暴露清單的計算（Promise，App.l4Job）。
   * zone 矩陣只在內部互通展開時才計算（大型網路要數秒，預設收合時不算）；矩陣的計算另放在 App.l4MatrixJob（測試可等待）
   */
  function show(App, opt) {
    mount(App);
    if (st.Q !== App.Q || (opt && opt.rebuild)) resetState(App.Q);
    st.zo = zoneOpts(App);
    syncControls(App);
    if (st.zonesFor !== App.Q || st.zonesZo !== st.zo) renderZones(App);
    const ex = exposure(App);
    // 展開時每次都重畫（換深淺配色時格子要換成新配色；同一份基準算過的直接用快取）
    if (isOpen(els.matrixFold)) App.l4MatrixJob = refresh(App);
    else { stopJob(); App.l4MatrixJob = Promise.resolve(); }
    return ex;
  }
  /** 展開內部互通（使用者展開、或沒有 WAN 時自動展開）：還沒畫目前的矩陣時才計算 */
  function ensureMatrix(App) {
    if (!App.Q || App.layer !== 'l4') return Promise.resolve();
    if (job && job.Q === App.Q && job.key === st.service && job.zo === st.zo) return job.promise;
    const d = st.drawnFor;
    if (st.current && d && d.Q === App.Q && d.key === st.service && d.zo === st.zo) return Promise.resolve();
    return refresh(App);
  }
  function openMatrix(App) {
    els.matrixFold.setAttribute('open', ''); els.matrixFold.open = true;
    App.l4MatrixJob = ensureMatrix(App);
  }
  function resetState(Q) {
    stopJob();
    stopEx(); st.ex = null; st.exErr = null; st.exPath = null; st.exAll = new Set();
    Object.assign(st, { Q, service: '', vrf: '', cell: null, cellData: null, reach: null, reachReq: null, reachErr: null, reachVrfs: null, showAllGroups: false, focus: [0, 0], mx: null, current: null, error: null, drawnFor: null, tableAll: false });
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
    if (seen && seen.has(key)) { draw(App, Q.zoneMatrix(optsOf(key))); return Promise.resolve(); }
    // 舊的矩陣是別的 service 的結果：計算期間不顯示，也不能下載
    st.current = null; V.clear(els.matrix); gridCells = []; hideTip();
    setBusy(true, key);
    const j = { Q, key, zo: st.zo, it: null, progress: null, steps: 0, ms: 0, maxStepMs: 0, maxGapMs: 0, t0: Date.now(), last: 0 };
    job = j;
    j.promise = new Promise((resolve) => {
      const fail = (e) => {
        console.error(e);
        st.error = V.reason(e); setBusy(false); els.status.textContent = '無法計算 zone 矩陣：' + st.error;
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
        try { draw(App, r.value); } catch (e) { fail(e); }
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
  // ---------------------------------------------------------------- 由外而內：暴露清單（Q.exposure）
  /** 暴露清單的分段計算：與矩陣分開（換 service 不重算）；紀錄 Q → { ms, wallMs, steps, maxStepMs, maxGapMs } */
  const exRuns = new WeakMap();
  let exJob = null;
  const EX_STAGES = ['prepare', 'evaluate', 'summary'];
  const EX_STAGE_LABEL = { prepare: '找入口與外部區段', evaluate: '逐一判斷', summary: '整理結果' };
  /** 三段：鍵、標題、沒有時的說明 */
  const EX_SECS = [
    { key: 'self', title: '① 外部 → 網路設備本身', none: '沒有從外部連得到的管理服務或設備本身的服務。' },
    { key: 'dnat', title: '② 外部 → 內部（dst-nat）', none: '沒有經 dst-nat 轉送到內部的服務。', noCand: '這些邊界路由器沒有 dst-nat 規則。' },
    { key: 'routed', title: '③ 外部 → 內部（直接路由）', none: '沒有不經 NAT、直接路由到內部的服務。' },
  ];
  function stopEx() { const j = exJob; if (!j) return; exJob = null; if (j.it) { try { j.it.return(); } catch (e) { console.error(e); } } }
  function exposure(App) {
    const Q = App.Q;
    if (exJob && exJob.Q === Q && exJob.zo === st.zo) return exJob.promise;
    stopEx();
    if (st.ex && st.exQ === Q && st.exZo === st.zo) { renderExposure(App); return Promise.resolve(); }
    st.ex = null; st.exErr = null; st.exPath = null;
    const j = { Q, zo: st.zo, it: null, steps: 0, ms: 0, maxStepMs: 0, maxGapMs: 0, t0: Date.now(), last: 0, progress: null };
    exJob = j; renderExposure(App);
    j.promise = new Promise((resolve) => {
      const tick = () => {
        if (exJob !== j) { resolve(); return; }
        if (App.Q !== Q || App.layer !== 'l4') { stopEx(); renderExposure(App); resolve(); return; }
        const s0 = Date.now(); if (j.last) j.maxGapMs = Math.max(j.maxGapMs, s0 - j.last);
        let r;
        try { if (!j.it) j.it = Q.exposureSteps(zo()); r = j.it.next(); } catch (e) { console.error(e); exJob = null; st.exErr = V.reason(e); renderExposure(App); resolve(); return; }
        const ms = Date.now() - s0; j.last = Date.now(); j.steps++; j.ms += ms; j.maxStepMs = Math.max(j.maxStepMs, ms);
        if (!r.done) { j.progress = r.value; exProgress(r.value); setTimeout(tick, 0); return; }
        exJob = null;
        exRuns.set(Q, { ms: j.ms, wallMs: Date.now() - j.t0, steps: j.steps, maxStepMs: j.maxStepMs, maxGapMs: j.maxGapMs });
        st.ex = r.value; st.exQ = Q; st.exZo = j.zo;
        try { renderExposure(App); } catch (e) { console.error(e); st.exErr = V.reason(e); renderExposure(App); }
        resolve();
      };
      setTimeout(tick, BUSY_DELAY);
    });
    return j.promise;
  }
  function exProgress(p) {
    const bar = $('#l4-ex-progress'); const t = $('#l4-ex-progress-text'); if (!bar) return;
    const n = EX_STAGES.indexOf(p.stage) + 1; const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    const txt = `第 ${n || '?'}／${EX_STAGES.length} 段：${EX_STAGE_LABEL[p.stage] || p.stage} ${V.num(p.done)}／${V.num(p.total)}`;
    bar.classList.remove('indeterminate'); bar.setAttribute('aria-valuenow', String(pct)); bar.setAttribute('aria-valuetext', txt); bar.dataset.stage = p.stage;
    if (bar.firstChild) bar.firstChild.style.width = pct + '%';
    if (t) t.textContent = txt;
  }
  /** 檢查結果的連結：「代碼 標題」，點了開那一筆（findingKey → idx） */
  function findingLink(App, key, chip) {
    const Q = App.Q; const idx = Q.findingIndexByKey(key); if (idx < 0) return null;
    const f = Q.finding(idx); const r = S.query.rule(f.id); const full = `${f.id} ${r ? r.title : ''}`.trim();
    // chip：只寫代碼，標題在 title 與 aria-label（依據欄下面一行）
    return h('a', { class: 'link l4-finding' + (chip ? ' chip' : ''), 'data-finding': key, href: '#', title: chip ? full : null, 'aria-label': chip ? full : null,
      onclick: (e) => { if (e && e.preventDefault) e.preventDefault(); if (e && e.stopPropagation) e.stopPropagation(); App.selectFinding(idx); } }, chip ? f.id : full);
  }
  const exPort = (x) => (x.portRange ? `${x.portRange[0]}–${x.portRange[1]}` : x.port != null ? String(x.port) : '');
  const exSvc = (x) => x.proto + (exPort(x) ? ' ' + exPort(x) : '');
  const withPort = (ip, x) => ip + (exPort(x) ? ':' + exPort(x) : '');
  /** 一列的目的：self 是設備的位址；dnat 是「公網:埠 → 內部:埠」（沒限制目的位址時寫入口介面上的任何位址）；routed 是內部位址與網段 */
  function exDst(App, sec, x) {
    const Q = App.Q;
    if (sec === 'self') return h('span', null, [h('span', { class: 'mono' }, withPort(x.ip, x)), ' ', h('span', { class: 'muted' }, Q.devName(x.dev) + (x.serviceName ? '・' + x.serviceName : ''))]);
    const to = x.nat && x.nat.to ? V.inVrfText(x.nat.to) : null;
    const from = sec === 'dnat' && x.dstAny ? withPort(`${x.inInterface} 上的任何位址`, x) : withPort(x.ip, x);
    const where = sec === 'routed' && x.subnet ? V.inVrfText(x.subnet) : '';
    return h('span', null, [h('span', { class: 'mono' }, from + (to ? ' → ' + to : '')), where ? h('span', { class: 'muted' }, ' ' + where) : null]);
  }
  function exResult(x) {
    const t = V.L4_STATUS[x.verdict] + (x.incomplete ? `（${V.L4_INCOMPLETE}）` : '');
    return h('span', { class: 'l4-ex-verdict', 'data-verdict': x.verdict }, [statusTag(x.verdict, t), h('span', { class: 'sr-only' }, '（推論）'),
      x.reasons.length ? h('span', { class: 'muted l4-ex-reasons' }, ' ' + x.reasons.map((c) => V.reachReason(c)).join('、')) : null]);
  }
  /**
   * 看路徑：用這一列的外部代表位址與入口介面查 Q.reach（和暴露清單算這一列時的條件相同），結果在這一列的下方就地展開；
   * 同一列再按一次收起。展開後焦點到路徑的標題，收起（再按一次或 Esc）回到這一列的按鈕
   */
  function openExposure(App, sec, i) {
    const x = st.ex && st.ex[sec] && st.ex[sec].rows[i]; if (!x) return;
    const p = st.exPath;
    if (p && p.sec === sec && p.row === i) { closeExposure(App); return; }
    const req = { src: x.src, dst: x.ip, proto: x.proto, port: x.port, vrf: null, entry: x.entry, from: 'exposure', sec, row: i };
    st.exPath = Object.assign({ sec, row: i }, runQuery(App, req));
    // 那一列在收起的部分（超過 EX_LIMIT 列）時先展開那一段
    if (exGroups(st.ex[sec].rows).findIndex((g) => g.i === i) >= EX_LIMIT) st.exAll.add(sec);
    renderExposure(App);
    const r = st.exPath.reach;
    announce(r ? `逐跳路徑：${req.src} → ${req.dst} ${svcLabel(req)} ${V.L4_STATUS[r.verdict]}` : `逐跳路徑：查詢失敗，${st.exPath.err}`);
    const t = $('#l4-ex-path-title'); if (t) { t.focus(); if (t.scrollIntoView) t.scrollIntoView({ block: 'nearest' }); }
  }
  function closeExposure(App) {
    const p = st.exPath; if (!p) return;
    st.exPath = null; renderExposure(App);
    const btn = Array.from(els.ex.querySelectorAll('.l4-ex-path')).find((b) => b.dataset.sec === p.sec && b.dataset.row === String(p.row));
    if (btn) btn.focus();
  }
  /**
   * 顯示用的分組（不改判斷）：同一台設備、同一個服務、結果、允許來源、依據與入口都相同的列併成一列（例如設備每個介面位址的 icmp），
   * 位址列在 title；回傳 [{ x（第一列）, i（它在 rows 的位置）, ips }]
   */
  const exGroupsCache = new WeakMap();
  function exGroups(rows) {
    let out = exGroupsCache.get(rows); if (out) return out;
    const m = new Map(); out = [];
    rows.forEach((x, i) => {
      const k = [x.dev, x.src, x.entries.join(','), x.service, x.verdict, x.incomplete, x.allowedFrom.text, x.rule ? x.rule.key || `${x.rule.table}|${x.rule.chain}` : '', x.entry, x.target || '', x.subnet || '', x.nat ? x.nat.to : '', x.serviceName || '', x.reasons.join(','), x.findingKeys.join(',')].join('\u0000');
      const g = m.get(k); if (g) { g.ips.push(x.ip); return; }
      const ng = { x, i, ips: [x.ip] }; m.set(k, ng); out.push(ng);
    });
    exGroupsCache.set(rows, out);
    return out;
  }
  function exSection(App, def) {
    const xr = st.ex; const s = xr[def.key]; const denied = xr.denied ? xr.denied[def.key] : s.counts.deny;
    const gs = exGroups(s.rows);
    const nAllow = gs.filter((g) => g.x.verdict === 'allow').length; const nUnk = gs.length - nAllow;
    const sentence = s.rows.length ? `${V.num(nAllow)} 個服務允許${nUnk ? `、${V.num(nUnk)} 個無法判斷` : ''}。` : '沒有。' + (def.noCand && !s.counts.candidates ? def.noCand : def.none);
    const id = 'l4-ex-' + def.key + '-title';
    // 5 欄（1440 不水平捲動）：怎麼進來是目的的第二行；相關檢查是依據下面一行的代碼 chip（標題在 title）；看路徑在結果下方
    const cols = [
      { t: '目的', f: ({ x, ips }) => h('span', { class: 'l4-ex-dst', title: ips.length > 1 ? ips.join('\n') : null }, [exDst(App, def.key, x), ips.length > 1 ? h('span', { class: 'muted l4-ex-more' }, ` 等 ${V.num(ips.length)} 個位址`) : null,
        h('span', { class: 'muted l4-ex-entry' }, `${App.Q.devName(x.dev)} · ${x.inInterface}${x.entries.length > 1 ? ` 等 ${V.num(x.entries.length)} 個介面` : ''}`)]) },
      { t: '服務', f: ({ x }) => h('span', { class: 'mono' }, exSvc(x)) },
      { t: '允許來源', f: ({ x }) => (x.allowedFrom.kind === 'any' ? V.chip('⚠ ' + x.allowedFrom.text, 'warn') : h('span', { class: 'mono' }, x.allowedFrom.text)) },
      { t: '結果', f: ({ x, i }) => { const on = !!(st.exPath && st.exPath.sec === def.key && st.exPath.row === i);
        return h('span', { class: 'l4-ex-res' }, [exResult(x),
          h('button', { type: 'button', class: 'ghost l4-ex-path', 'data-sec': def.key, 'data-row': String(i), 'aria-expanded': String(on), 'aria-controls': on ? 'l4-ex-path-box' : null,
            onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); openExposure(App, def.key, i); } }, on ? '收起路徑' : '看路徑')]); } },
      { t: '依據', f: ({ x }) => { const ls = x.findingKeys.map((k) => findingLink(App, k, true)).filter(Boolean);
        return h('span', { class: 'l4-ex-basis' }, [x.rule ? ruleLink(App, x.rule, true) : h('span', null, '—'), ls.length ? h('span', { class: 'l4-ex-findings' }, ls) : null]); } },
    ];
    // 每段最多先列 EX_LIMIT 列，其餘「顯示全部（N）」（同一段只有一個按鈕在 Tab 順序裡）
    const all = st.exAll.has(def.key); const shown = all ? gs.slice(0, ROW_LIMIT) : gs.slice(0, EX_LIMIT);
    const more = gs.length > EX_LIMIT ? h('button', { type: 'button', class: 'ghost l4-ex-all', 'data-sec': def.key, 'aria-expanded': String(all),
      onclick: () => { if (all) st.exAll.delete(def.key); else st.exAll.add(def.key); renderExposure(App); const b = Array.from(els.ex.querySelectorAll('.l4-ex-all')).find((x) => x.dataset.sec === def.key); if (b) b.focus(); } },
    all ? `只顯示前 ${EX_LIMIT} 列` : `顯示全部（${V.num(gs.length)}）`) : null;
    return h('section', { class: 'l4-ex-sec', 'data-sec': def.key, 'aria-labelledby': id }, [
      h('h4', { id, class: 'l4-ex-title' }, [def.title, ' ', V.chip(V.num(gs.length))]),
      h('p', { class: 'l4-ex-sentence' }, sentence),
      s.rows.length ? exTable(App, def, cols, shown) : null,
      all && gs.length > ROW_LIMIT ? h('div', { class: 'muted table-more' }, `只顯示前 ${ROW_LIMIT} 列，共 ${V.num(gs.length)} 列`) : null,
      more,
      denied ? h('p', { class: 'muted l4-ex-denied' }, `其餘 ${V.num(denied)} 個組合（服務 × 位址）拒絕。`) : null,
    ]);
  }
  /**
   * 暴露清單的表格（依查詢層的順序：允許 → 無法判斷，不另外排序）；和 V.table 的 stack 一樣窄螢幕時每列排成一塊、每格前面寫欄名。
   * 看路徑的那一列下方多一列（colspan），放逐跳路徑
   */
  function exTable(App, def, cols, groups) {
    const tb = h('tbody');
    groups.forEach((g) => {
      tb.appendChild(h('tr', { class: 'l4-ex-row st-' + g.x.verdict }, cols.map((c) => h('td', { 'data-label': c.t }, c.f(g)))));
      const p = st.exPath;
      if (p && p.sec === def.key && p.row === g.i) {
        const onVrf = (v) => { st.exPath = Object.assign({ sec: p.sec, row: p.row }, runQuery(App, Object.assign({}, p.req, { vrf: v }))); renderExposure(App); const t = $('#l4-ex-path-title'); if (t) t.focus(); };
        const box = h('div', { id: 'l4-ex-path-box', class: 'l4-ex-pathbox', onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); closeExposure(App); } } },
          reachBlock(App, { q: p.req, r: p.reach, err: p.err, vrfs: p.vrfs, titleId: 'l4-ex-path-title', onVrf }));
        tb.appendChild(h('tr', { class: 'l4-ex-pathrow' }, h('td', { colspan: String(cols.length) }, box)));
      }
    });
    return h('div', { class: 'table-scroll' }, h('table', { class: 't stack' }, [h('thead', null, h('tr', null, cols.map((c) => h('th', null, c.t)))), tb]));
  }
  /** 頁尾的判斷的前提：有暴露清單時用它的 assumptions（含暴露清單另加的前提），否則用 S.query.reachAssumptions */
  function fillAssume(list) {
    els.assumeSum.textContent = `判斷的前提（${V.num(list.length)} 條）`;
    V.clear(els.assumeList);
    list.forEach((a) => els.assumeList.appendChild(h('li', { 'data-code': a.code }, a.message)));
  }
  function openAssume() {
    els.assumeFold.setAttribute('open', ''); els.assumeFold.open = true;
    const sm = els.assumeFold.querySelector('summary'); if (sm) { sm.focus(); if (sm.scrollIntoView) sm.scrollIntoView({ block: 'start' }); }
  }
  /** 頁首的結論句與三段；沒有 WAN 時合併成一張說明並展開內部互通 */
  function renderExposure(App) {
    if (!els) return;
    const box = V.clear(els.ex); const Q = App.Q; const hd = V.clear(els.exHead);
    // 第一句結論在頁首（h2 下面），後面接頁面唯一的推論標示與「前提」連結（各段、各列只有給輔助科技念的「（推論）」）
    const tail = () => [' ', V.chip('推論', 'info', { title: '依基準的路由與防火牆規則推論，不寫進基準；前提見頁尾' }), ' ',
      h('a', { class: 'link l4-ex-assume', href: '#l4-assume-fold', onclick: (e) => { if (e && e.preventDefault) e.preventDefault(); openAssume(); } }, '前提')];
    const head = (children) => children.concat(tail()).forEach((c) => { if (c) hd.appendChild(typeof c === 'string' ? h('span', null, c) : c); });
    box.appendChild(h('h3', { id: 'l4-ex-title', class: 'work-card-title' }, '從外部進來'));
    if (st.exErr) { head(['無法計算從外部進得來什麼。']); box.appendChild(h('p', { class: 'diffA l4-ex-error', role: 'alert' }, '無法計算：' + st.exErr)); return; }
    if (!st.ex) {
      if (!exJob) { head(['已停止計算（離開了 L4）；回到 L4 時重新計算。']); return; }
      head(['計算中…']);
      box.appendChild(h('div', { class: 'l4-busy' }, [
        h('div', { id: 'l4-ex-progress', class: 'progress indeterminate', role: 'progressbar', 'aria-label': '從外部進來的計算進度', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuetext': '準備中' }, h('div')),
        h('span', { id: 'l4-ex-progress-text', class: 'l4-progress-text', 'aria-hidden': 'true' }, '準備中')]));
      return;
    }
    const xr = st.ex;
    fillAssume(Array.isArray(xr.assumptions) && xr.assumptions.length ? xr.assumptions : S.query.reachAssumptions());
    if (xr.status !== 'ok') {
      const nw = (xr.noWan || []).map((x) => findingLink(App, x.findingKey)).filter(Boolean);
      head([xr.status === 'no-wan' ? '找不到 WAN 介面，無法判斷從外部進得來什麼。' : xr.message || '無法判斷從外部進得來什麼。']);
      box.appendChild(h('p', { class: 'muted l4-ex-nowan' }, [xr.status === 'no-wan' ? '用 interface list 把對外的介面放進名稱含 WAN 的清單（F08）。' : '', ...nw.flatMap((l) => [' ', l])]));
      // 這時內部互通是唯一有內容的段：預設展開（並開始計算矩陣）
      if (!isOpen(els.matrixFold)) openMatrix(App);
      return;
    }
    const allow = (k) => exGroups(xr[k].rows).filter((g) => g.x.verdict === 'allow').length;
    const unk = EX_SECS.reduce((n, d) => n + exGroups(xr[d.key].rows).length - allow(d.key), 0);
    const total = EX_SECS.reduce((n, d) => n + allow(d.key), 0);
    const part = (n) => (n ? `${V.num(n)} 個` : '沒有');
    const noFw = (xr.noFirewall || []).map((d) => Q.devName(typeof d === 'string' ? d : d.dev));
    head([total ? `從外部進來，連得到 ${V.num(total)} 個服務：網路設備本身 ${part(allow('self'))}、轉送到內部 ${part(allow('dnat'))}、直接路由 ${part(allow('routed'))}。` : '從外部進來，連不到任何服務。',
      unk ? `另有 ${V.num(unk)} 個無法判斷。` : '',
      noFw.length ? `另有 ${noFw.join('、')} 無法判斷（沒有防火牆資料，缺 /export）。` : '']);
    const v6 = xr.ipv6 && (xr.ipv6.devices || []).length ? xr.ipv6.devices.map((x) => Q.devName(x.dev)) : [];
    box.appendChild(h('p', { class: 'muted l4-ex-notes' }, (v6.length ? `只算 IPv4；${v6.join('、')} 有使用 IPv6，IPv6 的防火牆見基準檢查的 F05。` : '依 IPv4 的防火牆與 NAT 推論；IPv6 未納入。')
      + (xr.limits && xr.limits.truncated ? `判斷次數超過上限（${V.num(xr.limits.maxEvaluations)} 次），只算到一部分。` : '')));
    EX_SECS.forEach((d) => box.appendChild(exSection(App, d)));
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
    // 可達性查詢的 VRF：基準有兩個以上的 VRF 時才顯示（只用 main 的網路與加入 VRF 之前相同）
    const vrfs = App.Q.vrfs();
    els.vrfBox.classList.toggle('hidden', vrfs.length < 2);
    V.fillVrfSelect(els.vrf, vrfs, els.vrf.value);
    // 矩陣的 VRF 篩選：zone 在兩個以上的 VRF 時才顯示（選項是 zoneMatrix.vrfs）
    const ref = st.current || st.mx; const mvrfs = ref ? ref.vrfs || [] : [];
    if (!mvrfs.includes(st.vrf)) st.vrf = '';
    els.vrfFilterBox.classList.toggle('hidden', mvrfs.length < 2);
    V.clear(els.vrfFilter);
    els.vrfFilter.appendChild(h('option', { value: '' }, '全部 VRF'));
    mvrfs.forEach((v) => els.vrfFilter.appendChild(h('option', { value: v }, `來源在 ${V.vrfText(v)}`)));
    els.vrfFilter.value = st.vrf;
    const tooBig = st.mx && st.mx.zones.length > MATRIX_MAX;
    els.modes.querySelectorAll('button').forEach((b) => {
      const on = (tooBig ? 'table' : st.mode) === b.dataset.mode;
      b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on);
      b.disabled = tooBig && b.dataset.mode === 'matrix';
      b.title = b.disabled ? `zone 超過 ${MATRIX_MAX} 個，只能用表格檢視` : b.dataset.mode === 'matrix' ? '來源 zone × 目的 zone 的格子（方向鍵移動，Enter 往下看）' : '每一格一列，可排序（和矩陣是同一份結果）';
    });
  }
  function draw(App, mx) {
    if (!st.service) st.mx = mx; // 服務選單的選項來自「全部服務」的矩陣
    st.error = null; setBusy(false);
    const Q = App.Q; const s = mx.stats;
    // 計算耗時與是否使用快取是實作細節，不顯示（計算紀錄仍在 V.l4 的除錯介面）
    els.status.textContent = `${V.num(s.zones)} 個 zone、${V.num(s.representatives)} 個代表位址、${V.num(s.natEntries)} 個 dst-nat 入口、${V.num(s.evaluations)} 次判斷。`
      + (st.zo && st.zo.error ? '命名規則的 zones 段沒有套用（原因見「zone 的依據」）。' : '');
    syncControls(App);
    st.current = mx; st.drawnFor = { Q, key: st.service, zo: st.zo };
    legendVirtual(mx);
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
    const srcZones = rowZones(mx);
    // 矩陣只算 IPv4：有設備在用 IPv6（推論）時提示，避免把「全部拒絕」誤讀成安全
    if (mx.ipv6 && mx.ipv6.length) box.appendChild(h('p', { class: 'muted l4-ipv6-note' }, `IPv6 未納入：${mx.ipv6.map((x) => App.Q.devName(x.dev)).join('、')} 有使用 IPv6（推論），IPv6 的防火牆見基準檢查的 F05／F07。`));
    if (st.vrf) box.appendChild(h('p', { class: 'muted l4-vrf-note' }, `只列來源在 ${V.vrfText(st.vrf)} 的 zone（${V.num(srcZones.length)} 個）；目的保留全部的 zone，跨 VRF 的格子（路由洩漏）照樣看得到。`));
    if (st.mode === 'table' || tooBig) { box.appendChild(matrixTable(App, mx)); return; }
    const byKey = new Map(mx.cells.map((c) => [c.src + '\u0000' + c.dst, c]));
    const n = mx.zones.length;
    const [fr, fc] = [Math.min(st.focus[0], srcZones.length - 1), Math.min(st.focus[1], n - 1)];
    const head = h('tr', null, [h('th', { scope: 'col', class: 'l4-corner' }, '來源 ＼ 目的')].concat(mx.zones.map((z) => h('th', { scope: 'col', class: 'l4-colhead', title: z.basis }, zoneLabel(z, true)))));
    const rows = srcZones.map((zs, r) => {
      const tds = mx.zones.map((zd, c) => {
        const cell = byKey.get(zs.id + '\u0000' + zd.id);
        const td = cellEl(App, cell, r, c, r === fr && c === fc);
        (gridCells[r] = gridCells[r] || [])[c] = td;
        return td;
      });
      return h('tr', null, [h('th', { scope: 'row', class: 'l4-rowhead', title: zs.basis }, zoneLabel(zs, true))].concat(tds));
    });
    box.appendChild(h('div', { class: 'l4-grid-wrap' }, h('table', { class: 'l4-grid', role: 'grid', 'aria-label': `zone 矩陣：列是來源 zone，欄是目的 zone（${st.service ? '服務 ' + st.service : '全部服務'}）。方向鍵移動，Enter 往下看`, 'aria-rowcount': String(srcZones.length + 1), 'aria-colcount': String(n + 1) }, [
      h('thead', null, head), h('tbody', null, rows),
    ])));
  }
  /**
   * zone 名稱，旁邊是來源（命名規則、介面清單、VLAN、網段）與「推論」標示；依據在 title。
   * quiet：矩陣的表頭（頁首已標一次推論，每個表頭再掛徽章太雜）只留給輔助科技念的「（推論）」
   */
  function zoneLabel(z, quiet) {
    return h('span', { class: 'l4-zone' }, [h('span', { class: 'l4-zone-name' }, z.name), ' ',
      h('span', { class: 'l4-zone-src' }, V.ZONE_SOURCE[z.source] || z.source),
      z.inferred ? (quiet ? h('span', { class: 'sr-only' }, '（推論）') : h('span', { class: 'l4-zone-inf' }, '推論')) : null]);
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
      c.incomplete ? h('span', { class: 'l4-inc', title: V.L4_INCOMPLETE }, '＋?') : null,
      // 次數（代表位址 × 目的 × 服務）不是使用者的單位，只放在提示與 aria-label（評審 M5）；格子只留結果不一的短標
      c.heterogeneous ? h('span', { class: 'l4-cnt' }, hetShort()) : null,
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
    // 列數與欄數可能不同（VRF 篩選只篩來源 zone）
    const nr = gridCells.length; if (!nr) return; const nc = gridCells[0].length;
    let to = null;
    if (e.key === 'ArrowRight') to = [r, Math.min(nc - 1, c + 1)];
    else if (e.key === 'ArrowLeft') to = [r, Math.max(0, c - 1)];
    else if (e.key === 'ArrowDown') to = [Math.min(nr - 1, r + 1), c];
    else if (e.key === 'ArrowUp') to = [Math.max(0, r - 1), c];
    else if (e.key === 'Home') to = e.ctrlKey ? [0, 0] : [r, 0];
    else if (e.key === 'End') to = e.ctrlKey ? [nr - 1, nc - 1] : [r, nc - 1];
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
    tip.appendChild(h('div', { class: 'l4-tip-head' }, [statusMark(c.status), ` ${zoneName(Q, c.src)} → ${zoneName(Q, c.dst)}${c.diagonal ? '（zone 內）' : ''}：${statusText(c)}`]));
    tip.appendChild(h('div', null, k.total ? `${countsText(k)}（共 ${V.num(k.total)} 組位址 × 服務）` : V.L4_STATUS_TIP.empty));
    if (c.heterogeneous) tip.appendChild(h('div', null, '≠ 結果不一：同一個 zone 的成員結果不一致'));
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

  /** 矩陣的列（來源 zone）：有 VRF 篩選時只取來源在那個 VRF 的 zone；欄（目的 zone）一律是全部 */
  // 虛擬 zone 不當列：網路設備（管理）只當目的；外部（Internet）從外部進來的結果在上方三段（評審 D2，2026-11-06 使用者決定），欄照樣保留
  const rowZones = (mx) => mx.zones.filter((z) => !z.virtual && !z.dstOnly && (!st.vrf || z.vrf === st.vrf));
  /** 格子：只取畫成列的來源 zone 的格子（表格檢視與 CSV 共用；VRF 篩選時只有來源在那個 VRF 的） */
  const shownCells = (mx) => { const ids = new Set(rowZones(mx).map((z) => z.id)); return mx.cells.filter((c) => ids.has(c.src)); };
  /** zone 的 VRF（zone 矩陣有兩個以上的 VRF 時，表格與 CSV 多兩欄） */
  const zoneVrf = (Q, id) => { const z = zoneById(Q, id); return z && z.vrf ? z.vrf : ''; };
  /** 表格檢視：每一格一列（和矩陣同一份 Q.zoneMatrix 的結果），可排序，點一列往下看 */
  function matrixTable(App, mx) {
    const Q = App.Q; const mv = (mx.vrfs || []).length > 1;
    // 先列有允許或無法判斷的格子（評審 M2），其餘（全部拒絕、沒有組合）收成「顯示其餘 N 格」；CSV 照樣是全部
    const cells = shownCells(mx); const open = cells.filter((c) => c.counts.allow || c.counts.unknown); const rest = cells.length - open.length;
    const more = rest ? h('button', { type: 'button', class: 'ghost l4-table-all', 'aria-expanded': String(!!st.tableAll),
      onclick: () => { st.tableAll = !st.tableAll; renderMatrix(App, mx); const b = els.matrix.querySelector('.l4-table-all'); if (b) b.focus(); } },
    st.tableAll ? `只列有允許或無法判斷的格子（${V.num(open.length)}）` :`顯示其餘 ${V.num(rest)} 格（全部拒絕或沒有組合）`) : null;
    return h('div', { class: 'l4-table' }, [V.table([
      { t: '來源 zone', f: (c) => zoneName(Q, c.src), s: (c) => zoneName(Q, c.src) },
      { t: '目的 zone', f: (c) => h('span', null, [zoneName(Q, c.dst), c.diagonal ? h('span', { class: 'muted' }, '（zone 內）') : null]), s: (c) => zoneName(Q, c.dst) },
      { t: '狀態', f: (c) => h('span', { class: 'l4-row-status', 'data-status': c.status }, [statusTag(c.status, statusText(c)), c.heterogeneous ? hetBadge() : null]), s: (c) => c.status },
      { t: V.L4_STATUS.allow, f: (c) => V.num(c.counts.allow), s: (c) => c.counts.allow, cls: 'num' },
      { t: V.L4_STATUS.deny, f: (c) => V.num(c.counts.deny), s: (c) => c.counts.deny, cls: 'num' },
      { t: V.L4_STATUS.unknown, f: (c) => V.num(c.counts.unknown), s: (c) => c.counts.unknown, cls: 'num' },
      { t: '總數', f: (c) => V.num(c.counts.total), s: (c) => c.counts.total, cls: 'num' },
      { t: '代表規則', f: (c) => (c.rule ? decisiveText(Q, c.rule) : '—'), s: (c) => (c.rule ? decisiveText(Q, c.rule) : null) },
      { t: '無法判斷的原因', f: (c) => c.reasons.map((x) => `${V.reachReason(x.code)}（${V.num(x.count)}）`).join('、'), s: (c) => (c.reasons[0] || {}).code },
      // zone 在多個 VRF 時：來源與目的的 VRF（放在最後，其他欄位的位置與只有 main 時相同）
      ...(mv ? [{ t: '來源 VRF', f: (c) => zoneVrf(Q, c.src), s: (c) => zoneVrf(Q, c.src) }, { t: '目的 VRF', f: (c) => zoneVrf(Q, c.dst), s: (c) => zoneVrf(Q, c.dst) }] : []),
    ], st.tableAll ? cells : open, { stack: true, onRow: (c) => openCell(App, c.src, c.dst), rowClass: (c) => 'l4-row st-' + c.status, limit: TABLE_LIMIT }),
    !open.length && !st.tableAll ? h('p', { class: 'muted' }, '沒有允許或無法判斷的格子。') : null, more]);
  }
  /** CSV：目前 service 的矩陣，每一格一列；有 VRF 篩選時只有篩選後的格子（檔名加上 VRF）；zone 在多個 VRF 時多「來源 VRF」「目的 VRF」兩欄 */
  function downloadCsv(App) {
    const mx = st.current; if (!mx) { V.app.banner('zone 矩陣還在計算，完成後再下載。', 4000); return; }
    const Q = App.Q; const C = V.exporter.csvCell; const mv = (mx.vrfs || []).length > 1;
    const head = ['來源 zone', '目的 zone', 'zone 內', '狀態', '結果不一', V.L4_STATUS.allow, V.L4_STATUS.deny, V.L4_STATUS.unknown, '總數', '代表規則', '無法判斷的原因'].concat(mv ? ['來源 VRF', '目的 VRF'] : []);
    const rows = shownCells(mx).map((c) => [zoneName(Q, c.src), zoneName(Q, c.dst), c.diagonal ? '是' : '', statusText(c), c.heterogeneous ? '是' : '',
      c.counts.allow, c.counts.deny, c.counts.unknown, c.counts.total, c.rule ? decisiveText(Q, c.rule) : '', c.reasons.map((x) => `${V.reachReason(x.code)}（${x.count}）`).join('、')].concat(mv ? [zoneVrf(Q, c.src), zoneVrf(Q, c.dst)] : []));
    const text = '﻿' + [head].concat(rows).map((r) => r.map(C).join(',')).join('\r\n') + '\r\n';
    V.exporter.download(`l4-matrix-${V.exporter.baseName(Q)}${st.service ? '-' + st.service.replace('/', '-') : ''}${st.vrf ? '-vrf-' + st.vrf.replace(/[^\w.-]/g, '_') : ''}.csv`, text, 'text/csv;charset=utf-8');
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
    box.appendChild(h('details', { class: 'l4-fold' }, [h('summary', null, `每個網段的依據（${V.num(z.subnets.length)}）`), V.table([
      { t: '網段', f: (s) => h('span', { class: 'mono' }, V.inVrfText(s.prefix)), s: (s) => s.prefix }, ...vrfCol,
      { t: 'zone', f: (s) => (zi.get(s.zone) || { name: s.zone }).name, s: (s) => (zi.get(s.zone) || { name: s.zone }).name },
      { t: '來源', f: (s) => h('span', null, [V.ZONE_SOURCE[s.source] || s.source, s.inferred ? ' ' : '', s.inferred ? V.chip('推論', 'info') : null]) },
      { t: '依據', f: (s) => s.basis || '' },
      { t: '其他來源的結果', f: (s) => s.alternatives.map((a) => `${V.ZONE_SOURCE[a.source] || a.source}：${(zi.get(a.zone) || { name: a.zone.replace(/^[a-z-]+:/, '') }).name}`).join('、') },
    ], z.subnets, { limit: 500 })]));
  }

  // ---------------------------------------------------------------- 下鑽
  /** L0 → L1／L2：一格的位址組與牽涉的規則（Q.zoneCell）；焦點移到下鑽的標題 */
  function openCell(App, src, dst) {
    hideTip();
    st.cell = { src, dst }; st.reach = null; st.reachReq = null; st.reachErr = null; st.reachVrfs = null; st.showAllGroups = false; st.hideDeny = true;
    st.cellData = App.Q.zoneCell(src, dst, optsOf(st.service));
    renderDrill(App);
    announce(`已開啟 ${zoneName(App.Q, src)} → ${zoneName(App.Q, dst)} 的明細：${V.L4_STATUS[st.cellData.status]}`);
    focusDrill();
  }
  /** L1 → L3：某一組（來源代表 → 目的）在某個服務的逐跳路徑 */
  function openGroup(App, gi, svcId) {
    const c = st.cellData; const g = c && c.groups[gi]; if (!g) return;
    const s = svcOf(svcId || g.services[0].service);
    // 查第一個來源代表（g.srcs 的結果相同），用矩陣算它時的同一組條件：
    //   entry：外部來源不在任何網段，矩陣從 WAN 介面進入（srcs[].entry）；不帶時逐跳會變成「找不到包含來源的網段」。有 entry 時 VRF 由入介面決定
    //   vrf：代表位址的 VRF（zone 依 VRF 分開）：重疊的位址在多個 VRF，一定要帶上
    const rep = g.srcs[0];
    query(App, { src: rep.ip, dst: g.dst.ip, proto: s.proto, port: s.port, vrf: rep.entry ? null : rep.vrf || null, entry: rep.entry || null, srcCount: g.srcs.length, from: 'cell', group: gi, service: svcId || g.services[0].service });
  }
  /**
   * 可達性查詢（表單）：結果用同一個 L3 畫面；表單的查詢不屬於任何格子，關掉 L1／L2。
   * vrf：來源的 VRF（選用；空字串或省略是依來源位址決定，位址在多個 VRF 時提示選擇）
   */
  function runReach(App, src, dst, proto, port, vrf) {
    const p = PROTOS.includes(proto) ? proto : String(proto || 'tcp');
    const pt = p === 'icmp' || port === '' || port == null ? (p === 'icmp' ? null : undefined) : /^\d+$/.test(String(port)) ? Number(port) : port;
    st.cell = null; st.cellData = null;
    els.src.value = src; els.dst.value = dst; els.proto.value = p; els.port.value = pt == null ? '' : String(pt); els.port.disabled = p === 'icmp';
    if (vrf !== undefined) els.vrf.value = vrf || '';
    query(App, { src, dst, proto: p, port: pt, vrf: vrf || null, from: 'form' });
  }
  /** 一次 Q.reach：{ req, reach, err, vrfs }（明細與暴露清單的就地路徑共用） */
  function runQuery(App, req) {
    const out = { req, reach: null, err: null, vrfs: null };
    try {
      const r = App.Q.reach(req.src, req.dst, Object.assign({ proto: req.proto, port: req.port }, req.vrf ? { vrf: req.vrf } : {}, req.entry ? { entry: req.entry } : {}));
      if (r.ok) out.reach = r; else { out.err = r.error; out.vrfs = r.vrfs || null; } // vrfs：來源在多個 VRF，請使用者選擇
    } catch (e) { out.err = V.reason(e); } // 參數不合法（例如 tcp 沒有埠、不存在的 VRF）：核心丟中文的 TypeError，V.reason 原樣顯示
    return out;
  }
  function query(App, req) {
    const o = runQuery(App, req);
    st.reachReq = req; st.reach = o.reach; st.reachErr = o.err; st.reachVrfs = o.vrfs;
    renderDrill(App);
    announce(st.reach ? `逐跳路徑：${req.src} → ${req.dst} ${svcLabel(req)} ${V.L4_STATUS[st.reach.verdict]}` : st.reachVrfs ? `逐跳路徑：來源 ${req.src} 在多個 VRF，請選擇 VRF` : `逐跳路徑：查詢失敗，${st.reachErr}`);
    focusDrill(st.cell ? 'l3' : null);
  }
  /** 來源在多個 VRF 時，用選的 VRF 重新查詢（同一個請求，只換 VRF） */
  function rerunWithVrf(App, vrf) {
    const q = st.reachReq; if (!q) return;
    if (q.from === 'form') runReach(App, q.src, q.dst, q.proto, q.port == null ? '' : String(q.port), vrf);
    else query(App, Object.assign({}, q, { vrf }));
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
    const where = st.cellData ? els.matrixCard : els.reachCard;
    if (box.parentNode !== where) where.appendChild(box);
    const Q = App.Q;
    if (st.cellData) {
      const c = st.cellData;
      box.appendChild(h('h3', { id: 'l4-drill-title', class: 'work-card-title', tabindex: '-1' }, `明細：${zoneName(Q, c.src)} → ${zoneName(Q, c.dst)}`));
      // 第一句是結論（IP:埠）；次數（代表位址 × 目的 × 服務）只放在狀態的 title 與「這一格怎麼算的」（評審 M5）
      box.appendChild(h('p', { class: 'l4-cell-sentence' }, cellSentence(c)));
      const tag = statusTag(c.status, statusText(c)); tag.setAttribute('title', `${countsText(c.counts)}，共 ${V.num(c.counts.total)} 組（位址 × 服務）`);
      box.appendChild(h('div', { class: 'row' }, [tag, c.heterogeneous ? hetBadge() : null, c.diagonal ? V.chip('zone 內') : null,
        st.service ? V.chip('服務 ' + st.service) : V.chip('全部服務'),
        h('button', { type: 'button', class: 'ghost l4-close', onclick: () => closeDrill(App) }, '關閉明細')]));
      if (c.reasons.length) box.appendChild(h('div', { class: 'l4-reasons' }, [h('b', null, '無法判斷的原因：'), h('ul', null, c.reasons.map((x) => h('li', { class: 'l4-reason', 'data-code': x.code, title: reasonNote(x.code) }, `${V.reachReason(x.code)}（${V.num(x.count)} 組）`)))]));
      box.appendChild(groupsBlock(App, c));
      box.appendChild(rulesBlock(App, c));
    } else {
      box.appendChild(h('h3', { id: 'l4-drill-title', class: 'work-card-title', tabindex: '-1' }, '可達性查詢的結果'));
      box.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost l4-close', onclick: () => closeDrill(App) }, '關閉')));
    }
    if (st.reach || st.reachErr) box.appendChild(reachBlock(App));
  }
  const isOpen = (d) => !!(d && (d.open || d.getAttribute('open') != null));
  function closeDrill(App) {
    const req = st.reachReq;
    st.cell = null; st.cellData = null; st.reach = null; st.reachReq = null; st.reachErr = null; st.reachVrfs = null; renderDrill(App);
    // 焦點回到觸發的地方：可達性查詢的按鈕、矩陣的格子（矩陣收合時是它的標題）；暴露清單的看路徑在列的下方展開，不用這個明細
    if (req && req.from === 'form') { const b = $('#l4-run'); if (b) { b.focus(); return; } }
    const td = isOpen(els.matrixFold) && gridCells[st.focus[0]] && gridCells[st.focus[0]][st.focus[1]];
    if (td) td.focus(); else { const t = $('#l4-matrix-title'); if (t) t.focus(); }
  }
  /** 重畫下鑽後把焦點放回同一個切換按鈕（按鈕是重新建立的） */
  const rerenderKeep = (App, sel) => { renderDrill(App); const b = els.drill.querySelector(sel); if (b) b.focus(); };
  /** 一組的某個服務寫成「tcp 目的:埠 → NAT 之後:埠」（用 IP:埠說話，評審 M5） */
  function svcAddr(g, s) {
    const p = svcOf(s.service); const port = p.port != null ? ':' + p.port : '';
    const nat = s.final && (s.final.dst !== g.dst.ip || s.final.port !== p.port) ? ` → ${s.final.dst}${s.final.port != null ? ':' + s.final.port : ''}` : '';
    return `${p.proto} ${g.dst.ip}${port}${nat}`;
  }
  /** 明細的第一句結論：允許的服務（IP:埠，最多列 3 個）、無法判斷的數目、其餘拒絕的組合數；筆數的單位在 title */
  function cellSentence(c) {
    // 同一個最後的目的（dst-nat 之後的 IP:埠）算一個服務：多個入口位址轉到同一台主機時寫「等 N 個位址」
    const uniq = (v) => {
      const m = new Map();
      c.groups.forEach((g) => g.services.filter((s) => s.verdict === v).forEach((s) => {
        const p = svcOf(s.service); const fin = s.final ? `${s.final.dst}:${s.final.port}` : `${g.dst.ip}:${p.port}`;
        const k = p.proto + ' ' + fin; const e = m.get(k);
        if (e) { if (!e.ips.includes(g.dst.ip)) e.ips.push(g.dst.ip); e.nat = e.nat || g.dst.via === 'nat'; } else m.set(k, { text: svcAddr(g, s), ips: [g.dst.ip], nat: g.dst.via === 'nat' });
      }));
      return Array.from(m.values()).map((e) => { const tail = [e.ips.length > 1 ? `${V.num(e.ips.length)} 個入口位址` : '', e.nat ? '經 dst-nat' : ''].filter(Boolean).join('，');
        return e.text + (tail ? `（${tail}）` : ''); });
    };
    const al = uniq('allow'); const un = uniq('unknown');
    if (!c.groups.length) return '這一格沒有可算的位址組合。';
    return (al.length ? `${V.num(al.length)} 個服務允許：${al.slice(0, 3).join('、')}${al.length > 3 ? ' 等' : ''}。` : '沒有允許的服務。')
      + (un.length ? `${V.num(un.length)} 個無法判斷。` : '')
      + (c.counts.deny ? `其餘 ${V.num(c.counts.deny)} 個組合拒絕。` : '');
  }
  /**
   * L1：目的 × 結果相同的來源代表（Q.zoneCell 的 groups）。先列允許與無法判斷（評審 H5）：
   * 全部拒絕的組一律預設收起（不論格子是否結果不一），其他組裡拒絕的服務收成「其餘 N 個服務拒絕」；「顯示拒絕的組合」一次全部列出。
   * 結果不一的格子：造成差異的服務（divergentServices）另標「≠ 差異」文字；等價類與「造成差異」的定義收在「這一格怎麼算的」。
   */
  function groupsBlock(App, c) {
    const Q = App.Q; const all = c.groups.map((g, i) => ({ g, i }));
    const divN = all.filter((x) => x.g.divergent).length;
    const het = c.heterogeneous && divN > 0;
    const denyGroups = all.filter((x) => x.g.status === 'deny').length;
    const denySvcs = all.reduce((n, x) => n + (x.g.status === 'deny' ? 0 : x.g.services.filter((s) => s.verdict === 'deny').length), 0);
    const hide = st.hideDeny;
    const rows = hide ? all.filter((x) => x.g.status !== 'deny') : all;
    const toggle = denyGroups || denySvcs ? h('button', { type: 'button', class: 'ghost l4-hide-deny', 'aria-pressed': String(hide), onclick: () => { st.hideDeny = !st.hideDeny; rerenderKeep(App, '.l4-hide-deny'); } },
      hide ? `顯示拒絕的組合（${[denyGroups ? `${V.num(denyGroups)} 組全部拒絕` : '', denySvcs ? `其他組的 ${V.num(denySvcs)} 個服務` : ''].filter(Boolean).join('、')}）` : '收起拒絕的組合') : null;
    const how = h('details', { class: 'l4-fold l4-how' }, [h('summary', null, '這一格怎麼算的'),
      h('p', { class: 'muted l4-note' }, '每一列是一個目的與一組結果相同的來源代表；點一列或某個服務看逐跳路徑。代表位址是等價類的代表：同一個區段內的位址對所有規則的位址條件結果相同。'
        + `格子的筆數是代表位址 × 目的 × 服務各算一次（${countsText(c.counts)}，共 ${V.num(c.counts.total)} 組）。`),
      het ? h('p', { class: 'l4-note l4-div-note' }, [hetBadge(), ' ', `這一格結果不一：${V.num(all.length)} 組中有 ${V.num(divN)} 組造成差異。`,
        '造成差異是指某個服務的結果和同一個目的的其他來源、或同一批來源往其他目的的結果不同，而且是少數（平手時兩邊都算）；那個服務的按鈕標「≠ 差異」。']) : null]);
    const divMark = () => hetBadge('≠ 差異', 'l4-div-mark');
    const srcText = (g) => (g.srcs.length === 1 ? g.srcs[0].ip : `${g.srcs[0].ip} 等 ${V.num(g.srcs.length)} 個`);
    const srcTitle = (g) => g.srcs.map((s) => `${s.ip}（${s.range ? s.range.join('–') : s.subnet || ''}；${s.basis === 'arp' ? 'ARP 看到的位址' : '推算的位址'}）`).join('\n');
    // 允許 → 無法判斷 → 拒絕（組內的服務同樣排序；拒絕的服務收起時只寫數目）
    const ORDER = { allow: 0, partial: 1, unknown: 2, empty: 3, deny: 4 };
    const sorted = rows.slice().sort((a, b) => (ORDER[a.g.status] ?? 9) - (ORDER[b.g.status] ?? 9) || a.i - b.i);
    const svcsOf = (g) => g.services.slice().sort((a, b) => (ORDER[a.verdict] ?? 9) - (ORDER[b.verdict] ?? 9)).filter((s) => !hide || s.verdict !== 'deny' || g.status === 'deny');
    return h('div', { class: 'l4-sub' }, [
      h('h4', null, ['位址組 ', V.chip(String(c.groups.length))]),
      how, toggle,
      c.groups.length && !rows.length ? h('p', { class: 'muted l4-all-deny' }, `${V.num(all.length)} 組全部拒絕，已收起。`) : null,
      c.groups.length && rows.length ? V.table([
        { t: '目的', f: ({ g }) => h('span', null, [h('span', { class: 'mono' }, g.dst.ip), ' ',
          g.dst.via === 'nat' ? V.chip(`dst-nat 入口 → ${g.dst.natTo}`, 'info', { title: `${Q.devName(g.dst.dev)} 的 dst-nat 規則把這個位址改寫到 ${g.dst.natTo}` }) : null,
          h('span', { class: 'muted' }, ` ${zoneName(Q, g.dst.zone)}`)]) },
        { t: '來源（代表）', f: ({ g }) => h('span', { class: 'mono', title: srcTitle(g) }, srcText(g)) },
        { t: '結果', f: ({ g, i }) => { const nd = hide && g.status !== 'deny' ? g.services.filter((s) => s.verdict === 'deny').length : 0;
          return h('span', { class: 'l4-svcs' }, svcsOf(g).map((s) => {
          const dv = g.divergentServices.includes(s.service);
          return h('button', {
            type: 'button', class: 'l4-svc st-' + s.verdict + (dv ? ' div' : ''), 'data-service': s.service, 'data-group': String(i), 'data-divergent': dv ? 'true' : null,
            title: dv ? `${s.service} 的結果造成這一格結果不一；看逐跳路徑` : `看 ${s.service} 的逐跳路徑`,
            style: { background: cellBg(s.verdict), color: TH().text },
            onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); openGroup(App, i, s.service); },
          }, [statusMark(s.verdict), ` ${s.service} ${V.L4_STATUS[s.verdict]}`, s.final && (s.final.dst !== g.dst.ip || s.final.port !== svcOf(s.service).port) ? ` → ${s.final.dst}${s.final.port != null ? ':' + s.final.port : ''}` : '', dv ? divMark() : null]);
        }).concat(nd ? [h('span', { class: 'muted l4-svc-denied' }, `其餘 ${V.num(nd)} 個服務拒絕`)] : [])); } },
        { t: '狀態', f: ({ g }) => statusTag(g.status, statusText(g)), s: ({ g }) => g.status },
      ].concat(het ? [{ t: '造成差異的服務', f: ({ g }) => (g.divergent ? h('span', { class: 'l4-div-svcs' }, ['≠ ', h('span', { class: 'mono' }, g.divergentServices.join('、'))]) : '—'), s: ({ g }) => g.divergentServices.length }] : [], [
        { t: '閘道／入口', f: ({ g }) => g.srcDevices.map((x) => (x.includes('|') ? Q.epName(x) : Q.devName(x))).join('、') || '—' },
      ]), sorted, { stack: true, onRow: ({ i }) => openGroup(App, i), limit: ROW_LIMIT, rowClass: ({ g }) => 'l4-group st-' + g.status + (g.divergent ? ' div' : '') }) : null,
      !c.groups.length ? h('p', { class: 'muted' }, '這一格沒有可算的位址組合。') : null,
      hide && denyGroups && rows.length ? h('p', { class: 'muted' }, `另有 ${V.num(denyGroups)} 組全部拒絕，已收起。`) : null,
    ]);
  }
  /** L2：牽涉的規則（Q.zoneCell 的 ruleDetails）：決定結果的規則、chain 結尾的預設與路由，以及條件無法判斷的規則 */
  function rulesBlock(App, c) {
    // 允許的規則在前，拒絕的在後（同一類維持查詢層的順序）
    const rank = (x) => (x.verdicts.allow ? 0 : x.verdicts.unknown || x.uncertain ? 1 : 2);
    const rows = c.ruleDetails.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map((o) => o.x);
    return h('div', { class: 'l4-sub' }, [
      h('h4', null, ['牽涉的規則 ', V.chip(String(rows.length))]),
      rows.length ? V.table([
        { t: '規則', f: (x) => ruleLink(App, x) },
        { t: V.L4_STATUS.allow, f: (x) => V.num(x.verdicts.allow), s: (x) => x.verdicts.allow, cls: 'num' },
        { t: V.L4_STATUS.deny, f: (x) => V.num(x.verdicts.deny), s: (x) => x.verdicts.deny, cls: 'num' },
        { t: V.L4_STATUS.unknown, f: (x) => V.num(x.verdicts.unknown), s: (x) => x.verdicts.unknown, cls: 'num' },
        { t: '條件無法判斷', f: (x) => (x.uncertain ? V.num(x.uncertain) : ''), s: (x) => x.uncertain, cls: 'num' },
        { t: '服務', f: (x) => h('span', { class: 'mono' }, x.services.join(' ')) },
      ], rows, { limit: ROW_LIMIT, rowClass: () => 'l4-ruledetail' }) : h('p', { class: 'muted' }, '沒有牽涉的規則。'),
    ]);
  }
  /** 逐跳路徑的標題：結論寫在標題（「tcp 來源 → 目的:埠 → NAT 之後:埠：允許」，評審 L4） */
  function reachTitle(Q, q, r) {
    const multi = Q.vrfs().length > 1;
    const port = q.port != null ? ':' + q.port : '';
    const nat = r && r.natApplied && r.final ? ` → ${r.final.dst}${r.final.port != null ? ':' + r.final.port : ''}` : '';
    return `逐跳路徑：${q.proto} ${q.src} → ${q.dst}${port}${nat}${multi && (r || q.vrf) ? `（${V.vrfText(r ? r.vrf : q.vrf)}）` : ''}${r ? '：' + V.L4_STATUS[r.verdict] : ''}`;
  }
  /**
   * L3：Q.reach 的結果：結論、起點、NAT 之後的目的、決定的規則、無法判斷的原因與每條路徑的逐跳。
   * x：{ q（請求）, r（Q.reach 的結果）, err, vrfs（來源在多個 VRF 時可選的 VRF）, titleId, onVrf（選了 VRF 時）}；
   * 省略時是明細（#l4-drill）目前的查詢
   */
  function reachBlock(App, x) {
    const c = x || { q: st.reachReq, r: st.reach, err: st.reachErr, vrfs: st.reachVrfs, titleId: 'l4-l3-title', onVrf: (v) => rerunWithVrf(App, v) };
    const Q = App.Q; const q = c.q; const r = c.r;
    const out = [h('h4', { id: c.titleId, tabindex: '-1' }, reachTitle(Q, q, r))];
    if (!r && c.vrfs) {
      // 來源位址在多個 VRF（位址重疊）：查詢層不猜，列出可選的 VRF，選了就重新查詢
      out.push(h('p', { class: 'warn-line l4-reach-vrf' }, `來源 ${q.src} 在多個 VRF（${c.vrfs.join('、')}，位址重疊），無法判斷封包從哪一個開始：請選擇 VRF。`));
      out.push(h('div', { class: 'row l4-reach-vrfs', role: 'group', 'aria-label': '選擇來源的 VRF' }, c.vrfs.map((v) => h('button', { type: 'button', 'data-vrf': v, onclick: () => c.onVrf(v) }, `用 ${V.vrfText(v)} 查詢`))));
      return h('div', { class: 'l4-sub l4-l3' }, out);
    }
    if (!r) { out.push(h('p', { class: 'diffA l4-reach-error' }, '無法查詢：' + c.err)); return h('div', { class: 'l4-sub l4-l3' }, out); }
    const start = r.start || {};
    out.push(h('div', { class: 'row' }, [h('span', { class: 'l4-verdict', 'data-verdict': r.verdict }, statusTag(r.verdict)),
      r.natApplied && r.final ? V.chip(`NAT 之後 ${r.final.dst}${r.final.port != null ? ':' + r.final.port : ''}`, 'info', { class: 'chip info l4-final' }) : null,
      q.from === 'cell' ? V.chip(`從 ${zoneName(Q, (st.cellData || {}).src)} → ${zoneName(Q, (st.cellData || {}).dst)} 的第 ${q.group + 1} 組`) : null,
      q.from === 'cell' && q.srcCount > 1 ? h('span', { class: 'muted l4-rep' }, `這一組有 ${V.num(q.srcCount)} 個來源代表（結果相同），這裡查第一個 ${q.src}${q.entry ? `，從 ${epText(Q, q.entry)} 進入` : ''}`) : null]));
    out.push(P().kv([
      ['起點', [V.REACH_START[start.how] || start.how, start.prefix ? `（${start.prefix}${start.basis ? '，' + (V.REACH_START_BASIS[start.basis] || start.basis) : ''}）` : '',
        start.dev ? '：' : '', start.dev ? devLink(App, start.dev) : null, start.ep ? h('span', { class: 'mono muted' }, ' ' + epText(Q, start.ep)) : null,
        !start.dev && (start.gateways || []).length ? '：' + start.gateways.map((g) => Q.devName(g.dev)).join('、') : ''].filter((x) => x !== '' && x != null)],
      ['NAT 之後的目的', r.final ? h('span', { class: 'mono' }, `${r.final.dst}${r.final.port != null ? ':' + r.final.port : ''}${r.natApplied ? '' : '（沒有改寫）'}`) : '各路徑不同'],
      ['決定結果', r.decisive.length ? h('div', null, r.decisive.map((x) => h('div', null, ruleLink(App, x)))) : '—'],
    ]));
    if (r.reasons.length) out.push(h('div', { class: 'l4-reasons' }, [h('b', null, '無法判斷的原因：'), h('ul', null, r.reasons.map((x) => reasonItem(App, x)))]));
    if (r.notes.length) out.push(h('div', { class: 'l4-notes' }, [h('b', null, '附註：'), h('ul', null, r.notes.map((x) => reasonItem(App, x)))]));
    r.paths.forEach((p, n) => out.push(pathBlock(App, p, n, r.paths.length, r.reasons)));
    out.push(h('details', { class: 'l4-fold' }, [h('summary', null, '這次查詢的前提'), h('ul', null, r.assumptions.map((a) => h('li', null, a.message)))]));
    return h('div', { class: 'l4-sub l4-l3' }, out);
  }
  /** /routing rule（策略路由）的文字：決定查表的規則、或使路由不明／丟棄的規則 */
  const routingRuleText = (r) => `/routing rule 第 ${r.order} 條（${Object.entries(r.match || {}).map(([k, v]) => `${k}=${v}`).join(' ') || '沒有條件'}，${r.action}${r.table ? ' ' + r.table : ''}）`;
  /** 這一跳的路由：VRF（基準有多個 VRF 時）、查的路由表（不是 VRF 的表時）、決定查表的規則與閘道（在別的 VRF 解析時標 @VRF） */
  function routeText(rt, multi) {
    if (!rt) return '';
    const gw = rt.gateway ? ' 經 ' + rt.gateway + (rt.gatewayVrf && rt.gatewayVrf !== rt.vrf ? '@' + rt.gatewayVrf : '') : '';
    return `・路由 ${rt.prefix || '—'}（${rt.proto || '—'}）${gw}`
      + (rt.table && rt.table !== rt.vrf ? `・路由表 ${rt.table}` : '')
      + (multi && rt.via && rt.via.length > 1 ? `・經 VRF 介面 ${rt.via.join(' → ')}` : '')
      + (rt.rule ? `・依 ${routingRuleText(rt.rule)}` : '');
  }
  /** 結束的說明和上方「無法判斷的原因」是同一句時只寫一次（評審 M3） */
  const sameReason = (reasons, end) => (reasons || []).some((x) => x.code === end.code && (x.message || '') === (end.message || ''));
  function pathBlock(App, p, n, total, reasons) {
    const Q = App.Q; const multi = Q.vrfs().length > 1;
    const addr = (ip, port) => (ip == null ? '（來源位址不明）' : ip + (port != null ? ':' + port : ''));
    const endRules = p.end ? (p.end.rules || []).concat(p.end.rule ? [p.end.rule] : []) : [];
    return h('div', { class: 'l4-path', 'data-verdict': p.verdict }, [
      h('div', { class: 'l4-path-head' }, [total > 1 ? `路徑 ${n + 1}：` : '路徑：', statusTag(p.verdict)]),
      h('ol', { class: 'l4-hops' }, p.hops.map((hp) => h('li', { class: 'l4-hop', 'data-dev': hp.dev }, [
        h('div', null, [h('b', null, devLink(App, hp.dev)), multi && hp.vrf ? h('span', { class: 'mono muted l4-hop-vrf' }, ` @${hp.vrf}`) : null, hp.chain ? h('span', { class: 'muted' }, ` ${hp.chain}`) : null,
          hp.collected ? null : V.chip('未收集', 'warn'), hp.firewall === 'none' && hp.collected ? V.chip('沒有防火牆資料', 'warn') : null, ' ',
          hp.verdict === 'pass' ? statusTag('allow', '這一跳通過') : statusTag(hp.verdict)]),
        h('div', { class: 'mono l4-hop-addr' }, `${addr(hp.src, null)} → ${addr(hp.dst, hp.port)}${hp.dstOut !== hp.dst || hp.portOut !== hp.port ? `　改寫為 ${addr(hp.dstOut, hp.portOut)}` : ''}${hp.srcOut !== hp.src ? `　來源改寫為 ${addr(hp.srcOut, null)}` : ''}`),
        h('div', { class: 'muted' }, `入 ${hp.inKnown ? epText(Q, hp.in) : '不明'}・出 ${hp.outKnown ? epText(Q, hp.out) : '不明'}${routeText(hp.route, multi)}`),
        hp.stages.length ? h('ul', { class: 'l4-stages' }, hp.stages.map((sg) => h('li', { 'data-status': sg.status }, [
          h('span', { class: 'mono' }, `${sg.table} ${sg.chain}`), '：',
          sg.status === 'decided' ? (sg.rule ? ruleLink(App, sg.rule) : (sg.note || '').replace(/^[^：]*：/, '')) : `無法判斷（可能 ${S.util.uniq(sg.outcomes.map((o) => o.verdict)).join('／')}）`,
          sg.status === 'decided' && sg.verdict ? h('span', { class: 'muted' }, `　→ ${V.L4_VERDICT[sg.verdict] || sg.verdict}`) : null,
          sg.via.length ? h('span', { class: 'muted' }, ['　經由 ', ...sg.via.flatMap((x, k) => [k ? '、' : '', ruleLink(App, x)])]) : null,
        ]))) : null,
        hp.nat.length ? h('ul', { class: 'l4-nat' }, hp.nat.map((x) => h('li', null, [h('b', null, `${x.dir === 'dst' ? '目的' : '來源'} NAT（${x.type}）`), `：${x.before == null ? '不明' : x.before} → ${x.after == null ? '不明' : x.after}　`, ruleLink(App, x.rule)]))) : null,
        hp.conntrack === 'untracked' ? h('div', { class: 'muted l4-ct' }, V.L4_CONNTRACK.untracked) : null,
        hp.service ? h('div', { class: 'muted' }, `設備的服務 ${hp.service.name}（埠 ${hp.service.port}）：${hp.service.enabled ? (hp.service.accepts === false ? '來源不在允許的位址內' : hp.service.accepts == null ? '來源位址不明' : '接受') : '停用'}`) : null,
        hp.reasons.length ? h('ul', { class: 'l4-reasons' }, hp.reasons.map((x) => reasonItem(App, x))) : null,
      ]))),
      p.end ? h('div', { class: 'l4-end', 'data-code': p.end.code, title: reasonNote(p.end.code) }, [h('b', null, '結束：' + V.reachReason(p.end.code)), p.end.message && !sameReason(reasons, p.end) ? '　' + p.end.message : '',
        multi && p.end.vrf ? h('span', { class: 'muted' }, `（${V.vrfText(p.end.vrf)}）`) : null,
        // 策略路由不明（policy-routing）或被 /routing rule 丟棄（policy-drop）：列出相關的規則
        endRules.length ? h('ul', { class: 'l4-end-rules' }, endRules.map((r) => h('li', { class: 'muted' }, routingRuleText(r)))) : null]) : null,
    ]);
  }

  V.l4 = {
    show, MATRIX_MAX,
    /** 查詢 zone 的參數（命名規則的 zones 段，核對失敗時不套用並附 error）；規則的 L4 影響（panels/firewall.js）用同一份 */
    zoneOpts,
    /** 測試與其他畫面用：目前的檢視狀態（複本） */
    state: () => ({ service: st.service, mode: st.mode, vrf: st.vrf, reachVrfs: st.reachVrfs ? st.reachVrfs.slice() : null, cell: st.cell ? Object.assign({}, st.cell) : null, reach: st.reach, reachReq: st.reachReq ? Object.assign({}, st.reachReq) : null, reachErr: st.reachErr, focus: st.focus.slice(), error: st.error,
      showAllGroups: st.showAllGroups, hideDeny: st.hideDeny,
      exPath: st.exPath ? { sec: st.exPath.sec, row: st.exPath.row, req: Object.assign({}, st.exPath.req), reach: st.exPath.reach, err: st.exPath.err } : null, exAll: Array.from(st.exAll),
      computing: job ? { service: job.key, progress: job.progress ? Object.assign({}, job.progress) : null } : null }),
    openCell, openGroup, runReach, rerunWithVrf, openExposure,
    /** 暴露清單的分段計算紀錄（{ ms, wallMs, steps, maxStepMs, maxGapMs }）；大型冒煙測試讀計算時間 */
    exposureRun: (Q) => exRuns.get(Q) || null,
    /** 目前畫的暴露清單（Q.exposure 的結果；還在算時為 null） */
    exposure: () => st.ex,
    /** 這個畫面在某份基準上算過的矩陣（service → 毫秒數）；大型冒煙測試讀計算時間 */
    timings: (Q) => new Map(computed.get(Q) || []),
    /** 分段計算的紀錄（service → { ms, wallMs, steps, maxStepMs：一段最久佔住主執行緒多久, maxGapMs：兩段之間最長的間隔 }） */
    runs: (Q) => new Map(runs.get(Q) || []),
  };
})(globalThis.SSOT = globalThis.SSOT || {});
