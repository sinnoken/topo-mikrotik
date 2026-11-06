/*
 * L4 可達性：內部互通（zone 矩陣，L0）。Q.zoneMatrixSteps 的分段計算、服務與檢視方式、格子與鍵盤操作、表格檢視、CSV、圖例與提示。
 * 共用的狀態與函式在 l4.js（V.l4._）；點格子往下看的明細在 l4-trace.js（openCell、renderDrill）。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h;
  const I = V.l4._;
  const { st, els, TH, MATRIX_MAX, TABLE_LIMIT, BUSY_DELAY, layerText, deniedParts, optsOf, zoneById, zoneName, statusText, statusMark, statusTag, cellBg, countsText, hetBadge, decisiveText, zoneLabel, renderZones } = I;
  /** Q.zoneMatrixSteps 的階段（依序） */
  const STAGES = ['reps', 'evaluate', 'summary'];
  const STAGE_LABEL = { reps: '找代表位址', evaluate: '逐一判斷', summary: '整理格子' };
  /** 這個畫面已經算過的矩陣：Q → Map(service → 計算毫秒數，只算 next() 本身)；查詢層有快取，再開時不顯示忙碌提示 */
  const computed = new WeakMap();
  /** 分段計算的紀錄：Q → Map(service → { ms, wallMs, steps, maxStepMs, maxGapMs })；大型冒煙測試讀主執行緒被佔住的最長時間 */
  const runs = new WeakMap();
  /** 進行中的分段計算（同時最多一個）：{ Q, key, zo, it, promise, progress, … } */
  let job = null;
  let gridCells = []; let busyEls = null;

  const svcIdOf = (s) => s.proto + (s.port != null ? '/' + s.port : '');
  // 格子與圖例用的短標：格子很窄，「≠ 結果不一」會蓋住下面的數字；完整說法在 title 與圖例
  const HET_SHORT = '≠'; const hetShort = () => hetBadge(HET_SHORT, null, '結果不一：同一個 zone 的成員結果不一致');
  /** 對角線（zone 內）的虛線外框：顏色取自 theme.l4.diagonal */
  const diagStyle = () => ({ borderColor: TH().diagonal.border, borderStyle: TH().diagonal.dash });
  /** 格子的完整說明（aria-label 與提示共用） */
  function cellText(Q, c) {
    const k = c.counts;
    return `${zoneName(Q, c.src)} → ${zoneName(Q, c.dst)}${c.diagonal ? '（zone 內）' : ''}：${statusText(c)}。`
      + (k.total ? `${countsText(k, '、')}，共 ${V.num(k.total)} 組（位址 × 服務）` : V.L4_STATUS_TIP.empty)
      + (k.deny && deniedParts(c.deniedBy) ? `；拒絕：${deniedParts(c.deniedBy)}` : '')
      + (c.heterogeneous ? '；結果不一：同一個 zone 的成員結果不一致' : '')
      + (c.rule ? `；代表規則：${decisiveText(Q, c.rule)}${c.ruleCount > 1 ? `（另有 ${c.ruleCount - 1} 條）` : ''}` : '')
      + (c.reasons.length ? `；無法判斷的原因：${countedReasons(c.reasons)}` : '');
  }
  /** 有次數的原因（格子的 reasons：{ code, count }）依層級寫成一行 */
  const countedReasons = (list) => layerText(list, (x) => x.code, (x) => `${V.reachReason(x.code)}（${V.num(x.count)}）`);

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

  // ---------------------------------------------------------------- 計算
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
    I.renderDrill(App);
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
    td.addEventListener('click', () => { setRoving(r, col); I.openCell(App, c.src, c.dst); });
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
      setRoving(r, c); I.openCell(App, td.dataset.src, td.dataset.dst); return;
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
  /** 目前的格子（st.focus；矩陣沒有畫出那一格時是 undefined）：關掉明細時焦點回到這裡 */
  const focusedCell = () => gridCells[st.focus[0]] && gridCells[st.focus[0]][st.focus[1]];
  /** 提示：狀態、筆數、異質、代表規則與無法判斷的原因（和格子的 aria-label 相同的內容，分行顯示） */
  function showTip(App, c, td, ev) {
    const Q = App.Q; const k = c.counts; const tip = V.clear(els.tip);
    tip.appendChild(h('div', { class: 'l4-tip-head' }, [statusMark(c.status), ` ${zoneName(Q, c.src)} → ${zoneName(Q, c.dst)}${c.diagonal ? '（zone 內）' : ''}：${statusText(c)}`]));
    tip.appendChild(h('div', null, k.total ? `${countsText(k)}（共 ${V.num(k.total)} 組位址 × 服務）` : V.L4_STATUS_TIP.empty));
    if (k.deny && deniedParts(c.deniedBy)) tip.appendChild(h('div', { class: 'l4-tip-denied' }, '拒絕：' + deniedParts(c.deniedBy)));
    if (c.heterogeneous) tip.appendChild(h('div', null, '≠ 結果不一：同一個 zone 的成員結果不一致'));
    if (c.rule) tip.appendChild(h('div', null, `代表規則：${decisiveText(Q, c.rule)}${c.ruleCount > 1 ? `（共 ${V.num(c.ruleCount)} 條規則或預設）` : ''}`));
    if (c.reasons.length) tip.appendChild(h('div', null, '無法判斷：' + countedReasons(c.reasons.slice(0, 3))));
    tip.appendChild(h('div', { class: 'muted' }, 'Enter 或點一下往下看'));
    const box = els.box.getBoundingClientRect(); const rc = td.getBoundingClientRect();
    const x = ev && Number.isFinite(ev.clientX) ? ev.clientX - box.left + 14 : rc.left - box.left + rc.width / 2;
    const y = ev && Number.isFinite(ev.clientY) ? ev.clientY - box.top + 16 : rc.top - box.top + rc.height + 4;
    tip.style.left = Math.max(0, Math.round(x || 0)) + 'px'; tip.style.top = Math.max(0, Math.round(y || 0)) + 'px';
    tip.classList.remove('hidden');
  }
  function hideTip() { if (els.root) els.tip.classList.add('hidden'); }

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
      { t: '無法判斷的原因', f: (c) => countedReasons(c.reasons), s: (c) => (c.reasons[0] || {}).code },
      // zone 在多個 VRF 時：來源與目的的 VRF（放在最後，其他欄位的位置與只有 main 時相同）
      ...(mv ? [{ t: '來源 VRF', f: (c) => zoneVrf(Q, c.src), s: (c) => zoneVrf(Q, c.src) }, { t: '目的 VRF', f: (c) => zoneVrf(Q, c.dst), s: (c) => zoneVrf(Q, c.dst) }] : []),
    ], st.tableAll ? cells : open, { stack: true, onRow: (c) => I.openCell(App, c.src, c.dst), rowClass: (c) => 'l4-row st-' + c.status, limit: TABLE_LIMIT }),
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

  Object.assign(I, { computed, runs, matrixJob: () => job, focusedCell, buildLegend, ensureMatrix, openMatrix, stopJob, refresh, syncControls, renderMatrix, hideTip, downloadCsv });
})(globalThis.SSOT = globalThis.SSOT || {});
