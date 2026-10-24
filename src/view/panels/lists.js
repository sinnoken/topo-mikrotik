/*
 * 左側四個分頁：檢查結果、覆蓋率、清單、比對。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const K = S.keys;
  const A = () => V.app; // 畫面組裝的內部函式（app.js 在本檔之後才載入）

  // ---------------------------------------------------------------- 檢查結果
  // groupBy：rule（依規則代碼）或 device（依設備，Q.findingDevice）；onlyNew：只看與舊基準比對後新出現的；
  // exportByDevice：匯出 CSV／Markdown 時依設備排序；editing：正在變更處理狀態的那一筆（findings 的索引）
  const state = { sev: { error: true, warn: true, info: true }, open: new Set(), shown: new Map(), selected: -1,
    groupBy: 'rule', onlyNew: false, exportByDevice: false, editing: -1 };
  const R = () => V.remediation;
  const DAY_MS = 86400000;
  const dateOf = (iso) => String(iso).slice(0, 10);
  /** 已處理的狀態依這個順序各列一組（open、regressed 是待處理，留在上方的分組） */
  const HANDLED = ['scheduled', 'accepted', 'false-positive', 'fixed'];
  /**
   * 處理狀態的編輯欄位：狀態（目前的狀態＋S.ledger.USER_TO 允許的轉換）、備註；可接受另填豁免原因與到期日（預設 WAIVER_DAYS 天後）。
   * 儲存交給 App.setLedger（S.ledger.set）；不合法時在欄位下方顯示核心的錯誤訊息，欄位保留。
   */
  function ledgerEditor(App, f, it, idx) {
    const LG = S.ledger;
    const opts = [it.status].concat(LG.USER_TO[it.status] || []);
    const status = h('select', { class: 'ledger-status', 'aria-label': '處理狀態' }, opts.map((s) => h('option', { value: s }, R().statusText(s))));
    status.value = it.status;
    const note = h('input', { type: 'text', class: 'ledger-note', maxlength: '500', 'aria-label': '備註',
      placeholder: '備註（選填），例如：維護窗口 11/30 處理', value: it.note || '' });
    const w = it.waiver;
    const reason = h('input', { type: 'text', class: 'ledger-waiver-reason', maxlength: '500', 'aria-label': '豁免原因', placeholder: '可接受的原因（必填）', value: w ? w.reason : '' });
    const until = h('input', { type: 'date', class: 'ledger-waiver-until', 'aria-label': '豁免到期日',
      value: dateOf(w ? w.until : new Date(Date.now() + LG.WAIVER_DAYS * DAY_MS).toISOString()) });
    const waiverBox = h('div', { class: 'ledger-waiver' }, [reason, h('label', null, ['到期日 ', until])]);
    const err = h('div', { class: 'ledger-error hidden', role: 'alert' });
    const sync = () => waiverBox.classList.toggle('hidden', status.value !== 'accepted');
    status.addEventListener('change', sync); sync();
    const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
    const cancel = () => { state.editing = -1; findings(App); };
    const save = async () => {
      const change = { status: status.value, note: note.value };
      if (status.value === 'accepted') {
        if (!reason.value.trim()) { fail('可接受需要填寫原因'); return; }
        // 到期日沒改時沿用原本的時間（含時分秒），避免只因格式不同就寫一筆歷程
        const untilIso = w && until.value === dateOf(w.until) ? w.until : until.value ? until.value + 'T00:00:00Z' : undefined;
        change.waiver = { reason: reason.value, until: untilIso };
      }
      state.editing = -1;
      const r = await App.setLedger(f, change);
      if (!r.ok) { state.editing = idx; fail('無法變更：' + r.error); }
    };
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') cancel(); });
    return h('div', { class: 'ack-editor ledger-editor' }, [status, note, waiverBox,
      h('button', { class: 'primary', 'aria-label': '儲存處理狀態：' + f.message, onclick: save }, '儲存'),
      h('button', { class: 'ghost', onclick: cancel }, '取消'), err]);
  }
  const activateByKey = (fn) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
  /**
   * 篩選列的選項（所有分頁共用）：「標籤 筆數」，選取時以強調色填滿；筆數為 0 且未選取時停用。
   * cls 是狀態色（err／warn…），只在有內容時使用。
   */
  const filterChip = (label, n, opt) => {
    const o = opt || {}; const off = !n && !o.on;
    return V.chipButton([label + ' ', h('span', { class: 'n' }, String(n))], `btn ${n ? o.cls || '' : ''} ${o.on ? 'on' : ''} ${off ? 'off' : ''}`,
      { onclick: off ? null : o.onclick, title: o.title || null, 'aria-pressed': String(!!o.on), 'aria-disabled': off ? 'true' : null });
  };
  function findings(App) {
    const root = V.clear(V.$('#pane-findings'));
    if (!App.snap) return root.appendChild(h('div', { class: 'empty-detail' }, '建立基準後，資料之間的矛盾與缺漏會列在這裡。'));
    const all = App.snap.findings; const Q = App.Q;
    // 只看新出現的：依「比對」分頁載入的舊基準（S.compare.snapshots 的 finding added）；沒有舊基準時停用
    const base = V.baselineDiff.loaded();
    if (!base) state.onlyNew = false;
    const isNew = (f) => !!base && base.addedFindingKeys.has(Q.findingKey(f));
    const pass = (f) => !state.onlyNew || isNew(f);
    // 已處理的項目（處理紀錄的狀態不是待處理）依狀態另列分組（預設收合），不算在上方各嚴重度的筆數裡
    const handled = new Map(); const st = { error: 0, warn: 0, info: 0 };
    all.forEach((f, idx) => {
      if (!pass(f)) return;
      const s = A().ledgerStatus(f);
      if (R().isPendingStatus(s)) st[f.severity]++; else S.util.getOr(handled, s, () => []).push(idx);
    });
    const handledSet = new Set(Array.from(handled.values()).flat());
    root.appendChild(h('div', { class: 'summary' }, ['error', 'warn', 'info'].map((s) => filterChip(V.SEV[s], st[s], { cls: s === 'error' ? 'err' : s, on: state.sev[s],
      onclick: () => { state.sev[s] = !state.sev[s]; findings(App); }, title: '點一下切換顯示',
    }))));
    // 分組方式與「只看新出現的」；兩份基準的版本不同時提示新出現的可能只是新版才有的檢查（compare 的 warnings）
    const nNew = base ? all.filter(isNew).length : 0;
    const versionWarn = base ? (base.report.warnings || []).find((w) => w.kind === 'version') : null;
    root.appendChild(h('div', { class: 'summary sub findings-view' }, [
      h('div', { class: 'seg', role: 'group', 'aria-label': '分組方式' }, [['rule', '依規則'], ['device', '依設備']].map(([k, label]) => h('button', {
        class: `btn ${state.groupBy === k ? 'on' : ''}`, 'aria-pressed': String(state.groupBy === k), 'data-group-by': k,
        onclick: () => { state.groupBy = k; findings(App); } }, label))),
      base ? filterChip('只看新出現的', nNew, { cls: 'info', on: state.onlyNew, title: `與舊基準（${base.name}）比對後新出現的檢查結果`,
        onclick: () => { state.onlyNew = !state.onlyNew; findings(App); } })
        : V.chipButton('只看新出現的', 'btn off only-new', { 'aria-disabled': 'true', 'aria-pressed': 'false', title: '需要先在「比對」分頁載入舊基準' }),
      base ? null : h('span', { class: 'muted note only-new-why' }, '在「比對」分頁載入舊基準後，才能只看新出現的'),
      versionWarn ? h('span', { class: 'note warn-line only-new-version', title: versionWarn.message }, '新出現的可能來自新版檢查：' + versionWarn.message) : null,
    ]));
    // 匯出不受上方篩選影響：一律輸出全部檢查結果（含處理狀態）；可選擇依設備排序
    root.appendChild(h('div', { class: 'row spaced pane-section' }, [
      h('span', { class: 'muted' }, '匯出全部檢查結果'),
      h('button', { title: '每筆一列，含相關實體、證據行號、處理狀態、時間與備註（Excel 可直接開啟）', onclick: () => App.exportAs('csv', { byDevice: state.exportByDevice }) }, 'CSV'),
      h('button', { title: '依嚴重度（或依設備）分組的報表，含證據行號，已處理的項目會標示狀態與備註', onclick: () => App.exportAs('markdown', { byDevice: state.exportByDevice }) }, 'Markdown'),
      h('button', { class: 'ghost export-by-device' + (state.exportByDevice ? ' on' : ''), 'aria-pressed': String(state.exportByDevice),
        title: '匯出時依設備排序（Markdown 依設備分組）；不屬於任何設備的排最後',
        onclick: () => { state.exportByDevice = !state.exportByDevice; findings(App); } }, '依設備排序'),
      h('button', { class: 'open-patch', title: '選取檢查結果，產生每台設備的修正 .rsc（套用、回復、驗證）；只產生文字，不會連線設備', onclick: () => App.openPatch() }, '修正計畫…'),
    ]));
    if (!all.length) root.appendChild(h('div', { class: 'empty-detail' }, [h('div', { class: 'big' }, '沒有發現問題'), '所有資料彼此一致。']));
    else if (state.onlyNew && !nNew) root.appendChild(h('div', { class: 'muted pane-note' }, `與舊基準（${base.name}）比對，沒有新出現的檢查結果。`));
    const ledgerBlocked = A().ledgerState().blocked;
    if (ledgerBlocked) root.appendChild(h('div', { class: 'pane-note warn-line ledger-blocked' }, '處理紀錄目前無法使用：' + ledgerBlocked.reason + '（見「處理紀錄」分頁）'));
    /** 一筆檢查結果：點文字定位；旁邊的「處理」變更處理紀錄的狀態與備註 */
    const item = (i, showId) => {
      const f = all[i]; const it = A().ledgerItem(f); const s = it ? it.status : null;
      const done = handledSet.has(i); const at = done ? A().ledgerUserAt(it) : null;
      const select = () => { state.selected = i; App.selectFinding(i); findings(App); };
      const edit = (e) => { e.stopPropagation(); state.editing = state.editing === i ? -1 : i; findings(App); };
      return h('div', { class: 'fitem-wrap' }, [h('div', { class: 'fitem-row' }, [
        h('div', { class: 'fitem' + (state.selected === i ? ' sel' : ''), role: 'button', tabindex: '0', onclick: select, onkeydown: activateByKey(select) }, [
          done || showId ? h('span', { class: 'id' }, f.id + ' ') : null,
          s && s !== 'open' ? V.chip(R().statusText(s), R().STATUS_CHIP[s] + ' ledger-chip', { 'data-status': s }) : null, s && s !== 'open' ? ' ' : null,
          !state.onlyNew && isNew(f) ? V.chip('新出現', 'info', { title: `舊基準（${base.name}）沒有這筆` }) : null, f.message,
          at ? h('div', { class: 'muted note' }, `${R().statusText(s)}：${V.fmtUtc(at)}`) : null,
          it && it.waiver ? h('div', { class: 'muted note ledger-waiver-line' }, `豁免原因：${it.waiver.reason || '（未填）'}・到期 ${V.fmtUtc(it.waiver.until)}`) : null,
          it && it.note ? h('div', { class: 'muted note ack-reason' }, '備註：' + it.note) : null,
        ]),
        h('button', {
          class: 'ghost ack ledger-edit', 'aria-label': '處理：' + f.message, disabled: !it || null,
          title: it ? '變更處理狀態（待處理、已排程修復、可接受、誤報…）與備註；只存在這個瀏覽器的處理紀錄，不改變基準' : '處理紀錄沒有這一筆（處理紀錄無法使用）',
          onclick: edit,
        }, '處理'),
      ]), state.editing === i && it ? ledgerEditor(App, f, it, i) : null]);
    };
    /** 一個可展開的分組：key 是展開狀態的鍵，head 是標題列的內容 */
    const group = (key, head, idxs, cls, showId) => {
      const open = state.open.has(key);
      const toggle = () => { open ? state.open.delete(key) : state.open.add(key); findings(App); };
      const g = h('div', { class: 'fgroup' + (cls ? ' ' + cls : '') }, [h('div', { class: 'head', role: 'button', tabindex: '0', 'aria-expanded': String(open), onclick: toggle, onkeydown: activateByKey(toggle) }, [
        h('span', null, open ? '▾' : '▸'), ...head, V.chip(String(idxs.length)),
      ])]);
      if (open) {
        const n = state.shown.get(key) || 100;
        g.appendChild(h('div', { class: 'items' }, idxs.slice(0, n).map((i) => item(i, showId))));
        if (idxs.length > n) g.appendChild(h('a', { class: 'link more', onclick: () => { state.shown.set(key, n + 200); findings(App); } }, `再顯示 200 筆（共 ${idxs.length} 筆）`));
      }
      return g;
    };
    const shown = (idx) => state.sev[all[idx].severity] && !handledSet.has(idx) && pass(all[idx]);
    if (state.groupBy === 'device') {
      // 依設備：設備名稱順序，不屬於任何設備的最後一組；組內保留基準的順序，每筆標出規則代碼
      const groups = new Map();
      R().sortByDevice(Q, all).forEach((r) => { if (shown(r.idx)) S.util.getOr(groups, r.dev, () => []).push(r.idx); });
      const SEVS = ['error', 'warn', 'info'];
      groups.forEach((idxs, dev) => {
        const worst = SEVS.find((s) => idxs.some((i) => all[i].severity === s));
        root.appendChild(group(dev === null ? '#nodev' : 'dev:' + dev, [V.sevDot(worst), h('span', { class: 'title' }, dev === null ? '不屬於任何設備' : Q.devName(dev))],
          idxs, 'by-device' + (dev === null ? ' no-device' : ''), true));
      });
    } else {
      const groups = new Map();
      all.forEach((f, idx) => { if (shown(idx)) S.util.getOr(groups, f.id, () => []).push(idx); });
      groups.forEach((idxs, id) => {
        const c = S.check.CATALOG[id];
        root.appendChild(group(id, [V.sevDot(c.severity), h('span', { class: 'title' }, c.title), h('span', { class: 'id' }, id)], idxs, '', false));
      });
    }
    // 已處理：依狀態各一組，不受上方嚴重度篩選影響，預設收合
    HANDLED.concat(Array.from(handled.keys()).filter((s) => !HANDLED.includes(s))).forEach((s) => {
      const idxs = handled.get(s); if (!idxs || !idxs.length) return;
      const key = '#handled:' + s; const open = state.open.has(key);
      const toggle = () => { open ? state.open.delete(key) : state.open.add(key); findings(App); };
      const g = h('div', { class: 'fgroup handled', 'data-status': s }, [h('div', { class: 'head', role: 'button', tabindex: '0', 'aria-expanded': String(open), onclick: toggle, onkeydown: activateByKey(toggle) }, [
        h('span', null, open ? '▾' : '▸'), h('span', { class: 'title' }, R().statusText(s)), V.chip(String(idxs.length)),
      ])]);
      if (open) g.appendChild(h('div', { class: 'items' }, idxs.map((i) => item(i, true))));
      root.appendChild(g);
    });
    // 規則品質：誤報比率最高的規則（S.ledger.ruleStats），只列有誤報的，預設收合
    const fp = ledgerBlocked ? [] : S.ledger.ruleStats(A().ledger()).filter((r) => r.falsePositive > 0)
      .sort((a, b) => b.rate - a.rate || b.falsePositive - a.falsePositive || S.util.natural(a.id, b.id)).slice(0, 5);
    if (fp.length) {
      const key = '#fp'; const open = state.open.has(key);
      const toggle = () => { open ? state.open.delete(key) : state.open.add(key); findings(App); };
      const g = h('div', { class: 'fgroup rules fp-rules' }, [h('div', { class: 'head', role: 'button', tabindex: '0', 'aria-expanded': String(open), onclick: toggle, onkeydown: activateByKey(toggle) }, [
        h('span', null, open ? '▾' : '▸'), h('span', { class: 'title' }, '誤報率最高的規則'), V.chip(String(fp.length)),
      ])]);
      if (open) g.appendChild(h('div', { class: 'items' }, fp.map((r) => h('div', { class: 'rule', 'data-rule-id': r.id, title: '依處理紀錄：標為誤報的筆數／這條規則在處理紀錄中的總筆數' }, [
        h('span', { class: 'mark' }, '!'),
        h('span', { class: 'title' }, [(S.check.CATALOG[r.id] || {}).title || r.id,
          h('div', { class: 'muted note' }, `誤報 ${V.num(r.falsePositive)} / ${V.num(r.total)}（${Math.round(r.rate * 100)}%）`)]),
        h('span', { class: 'id' }, r.id)]))));
      root.appendChild(g);
    }
    // 沒有發現的規則：分成「通過」與「沒有資料可檢查」，預設收合（不受上方嚴重度篩選影響）
    const rules = App.Q.ruleStatus();
    const DL = S.check.DATA_LABEL;
    [['pass', '通過', '✓', (r) => '需要的資料都有收到，沒有發現問題'],
      ['nodata', '沒有資料可檢查', '–', (r) => '缺少：' + r.missing.map((g) => g.map((t) => DL[t] || t).join(' 或 ')).join('、')]].forEach(([st, label, mark, note]) => {
      const list = rules.filter((r) => r.status === st); if (!list.length) return;
      const key = '#' + st; const open = state.open.has(key);
      const toggle = () => { open ? state.open.delete(key) : state.open.add(key); findings(App); };
      const g = h('div', { class: 'fgroup rules ' + st }, [h('div', { class: 'head', role: 'button', tabindex: '0', 'aria-expanded': String(open), onclick: toggle, onkeydown: activateByKey(toggle) }, [
        h('span', null, open ? '▾' : '▸'), h('span', { class: 'title' }, label), V.chip(String(list.length), st === 'pass' ? 'ok' : ''),
      ])]);
      if (open) g.appendChild(h('div', { class: 'items' }, list.map((r) => h('div', { class: 'rule', title: note(r) }, [
        h('span', { class: 'mark' }, mark), h('span', { class: 'title' }, [r.title, st === 'nodata' ? h('div', { class: 'muted note' }, note(r)) : null,
          // 處理建議（CATALOG）：預設收合，展開狀態跨重繪保留
          V.details.parts.adviceBlock(r.id, { open: state.open.has('advice:' + r.id),
            ontoggle: (on) => (on ? state.open.add('advice:' + r.id) : state.open.delete('advice:' + r.id)) })]), h('span', { class: 'id' }, r.id),
      ]))));
      root.appendChild(g);
    });
  }
  findings.reset = () => { state.open = new Set(); state.shown = new Map(); state.selected = -1; state.editing = -1; state.onlyNew = false; };
  findings.openFirst = (snap) => { const f = snap.findings.find((x) => x.severity !== 'info'); if (f) state.open.add(f.id); };
  findings.showProblems = (App) => {
    state.sev = { error: true, warn: true, info: false };
    state.open = new Set();
    state.selected = -1;
    findings(App);
  };

  // ---------------------------------------------------------------- 覆蓋率
  const cov = { filter: 'all' };
  function coverage(App) {
    const root = V.clear(V.$('#pane-coverage'));
    if (!App.snap) return root.appendChild(h('div', { class: 'empty-detail' }, '建立基準後，可以在這裡看到每台設備收集了哪些資料。'));
    const rows = App.snap.coverage; const Q = App.Q;
    // 有缺漏：缺少應收集的資料，或有指令收集失敗（V.coverageGap，與基準摘要同一個判斷）
    const collected = rows.filter((r) => r.collected); const missing = collected.filter(V.coverageGap);
    const seenOnly = rows.filter((r) => !r.collected && r.kind !== 'host'); const hosts = rows.filter((r) => !r.collected && r.kind === 'host');
    const F = { all: ['全部已收集', collected], missing: ['有缺漏', missing], seen: ['未收集的網路設備', seenOnly], hosts: ['主機（只由 LLDP 看到）', hosts] };
    root.appendChild(h('div', { class: 'summary' }, Object.entries(F).map(([k, [label, list]]) => filterChip(label, list.length, { cls: k === 'missing' ? 'err' : '', on: cov.filter === k, onclick: () => { cov.filter = k; coverage(App); } }))));
    // C01（只被鄰居發現、沒有收集資料的網路設備）→ tools/collect.sh 的設備清單草稿
    const nC01 = App.snap.findings.filter((f) => f.id === 'C01').length;
    root.appendChild(h('div', { class: 'row spaced pane-section devices-draft' }, [
      h('span', { class: 'muted' }, nC01 ? `未收集的網路設備（C01）${V.num(nC01)} 台，可匯出收集器的設備清單草稿` : '沒有未收集的網路設備（C01）'),
      h('button', {
        disabled: !nC01 || null, onclick: () => App.exportAs('devicesCsv'),
        title: 'tools/collect.sh 的 devices.csv（name,address,user,port[,extra]）；address 取管理 IP 或鄰居回報的位址，user 是佔位值，執行前請修改',
      }, '匯出未收集設備的 devices.csv 草稿'),
    ]));
    const list = F[cov.filter][1];
    root.appendChild(V.table([
      { t: '設備', f: (r) => Q.devName(r.dev) },
      { t: '類型', f: (r) => V.kindChip(r.kind) },
      { t: '資料', f: (r) => h('div', { class: 'chip-list' }, [
        ...r.data.map((t) => V.chip(S.check.DATA_LABEL[t] || t)),
        ...r.missing.map((t) => V.chip('缺 ' + (S.check.DATA_LABEL[t] || t), 'err')),
      ]) },
      { t: '收集失敗', f: (r) => failureList(App, r.failures || []) },
      { t: '鏈路', f: (r) => String(r.links) },
    ], list, { onRow: (r) => App.select({ type: 'device', key: r.dev }, { focus: true }), limit: 600, bad: V.coverageGap }));
  }
  coverage.showMissing = (App) => { cov.filter = 'missing'; coverage(App); };
  /** 收集失敗清單：原因、指令（標頭層級的失敗沒有指令）與影響的資料類別；點一下開啟原文的失敗行 */
  function failureList(App, list) {
    if (!list.length) return '';
    return h('div', null, list.map((x) => {
      const b = App.Q.block(x.block);
      const what = (x.command || '整台設備') + (x.dataTypes.length ? `（影響：${x.dataTypes.map((t) => S.check.DATA_LABEL[t] || t).join('、')}）` : '');
      return h('div', { class: 'failure' }, [
        V.chip(V.failureText(x), 'err', { title: x.text || null }), ' ', what, ' ',
        b ? h('a', { class: 'link mono', onclick: (e) => { e.stopPropagation(); App.openRaw(b.file, x.line); } }, `第 ${x.line} 行`) : null,
      ]);
    }));
  }

  // ---------------------------------------------------------------- 比對
  const cmp = { report: null, name: '', filter: 'problem' };
  function compare(App) {
    // 分頁上半是預期資料比對，下半是新舊基準比對（panels/baseline-diff.js）
    const pane = V.clear(V.$('#pane-compare')); const root = h('div');
    pane.appendChild(root); pane.appendChild(V.baselineDiff.render(App));
    const file = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', onchange: async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      try { const exp = JSON.parse(await f.text()); cmp.report = S.compare(App.Q, exp); cmp.name = f.name; } catch (e) { cmp.report = { errors: ['無法讀取：' + e.message], items: [], summary: {} }; cmp.name = f.name; }
      compare(App);
    } });
    root.appendChild(h('div', { class: 'pane-body' }, [
      h('p', { class: 'muted' }, '把「預期應該長怎樣」的資料（格式 ssot-expected/1，獨立於基準）和目前基準比對。比對只讀取基準，不會修改它。'),
      h('div', { class: 'row' }, [
        file, h('button', { disabled: !App.Q || null, onclick: () => file.click() }, '載入預期資料（JSON）…'),
        h('button', {
          disabled: !App.Q || null, onclick: () => App.exportAs('expected'),
          title: '由目前的基準產生預期資料（已收集的設備、雙向確認的鏈路、VLAN），之後可拿來和新的基準比對',
        }, '匯出預期資料'),
        cmp.name ? h('span', { class: 'muted' }, cmp.name) : null,
      ]),
      h('details', null, [h('summary', { class: 'muted' }, '格式說明'), h('pre', { class: 'raw note-box' },
        '{\n  "schema": "ssot-expected/1",\n  "devices": ["TPE_CORE_SW_01", {"name": "TPE_FW_01", "kind": "firewall"}],\n  "links": [{"a": "TPE_CORE_SW_01 xe-0/0/0", "b": "TPE_FW_01 port1"}],\n  "vlans": [{"device": "TPE_ACC_SW_01", "id": 20, "name": "SRV"}],\n  "strictDevices": false,\n  "strictLinks": false\n}')]),
    ]));
    const r = cmp.report; if (!r) return;
    if (r.errors.length) root.appendChild(h('div', { class: 'pane-section' }, r.errors.map((e) => h('div', { class: 'finding' }, [V.sevDot('error'), e]))));
    const ST = { ok: ['一致', 'ok'], missing: ['基準缺少', 'err'], different: ['不同', 'warn'], unexpected: ['基準多出', 'info'] };
    root.appendChild(h('div', { class: 'summary' }, [filterChip('有差異', r.items.filter((i) => i.status !== 'ok').length, { on: cmp.filter === 'problem', onclick: () => { cmp.filter = 'problem'; compare(App); } }),
      ...Object.entries(ST).map(([k, [label, cls]]) => filterChip(label, r.summary[k] || 0, { cls, on: cmp.filter === k, onclick: () => { cmp.filter = k; compare(App); } }))]));
    const items = r.items.filter((i) => (cmp.filter === 'problem' ? i.status !== 'ok' : i.status === cmp.filter));
    root.appendChild(V.table([{ t: '', f: (i) => V.chip(ST[i.status][0], ST[i.status][1]) }, { t: '項目', f: (i) => i.message }], items, {
      onRow: (i) => {
        if (i.type === 'device' && App.Q.getDevice(i.ref)) App.select({ type: 'device', key: i.ref }, { focus: true });
        else if (i.type === 'link' && App.Q.getLink(i.ref)) App.select({ type: 'link', key: i.ref }, { focus: true });
        else if (i.type === 'link') { const ep = i.ref.split('~')[0]; if (App.Q.getInterface(ep)) App.select({ type: 'interface', key: ep }, { focus: true }); }
      },
    }));
  }
  compare.reset = () => { cmp.report = null; cmp.name = ''; V.baselineDiff.reset(); };

  // ---------------------------------------------------------------- 清單：設備、介面、IP、網段、MAC、VLAN
  const inv = { kind: 'device', filter: 'all', q: '', sortBy: -1, sortDir: 1 };
  function inventory(App) {
    const root = V.clear(V.$('#pane-inventory'));
    if (!App.snap) return root.appendChild(h('div', { class: 'empty-detail' }, '建立基準後，所有設備、介面、IP、網段、MAC 與 VLAN 會列在這裡。'));
    const Q = App.Q; const { rows: R, counts: C } = Q.inventory(); // 列與數字都來自 Q.inventory()，這裡不重算
    const devRows = R.devices.concat(R.endpoints);
    const nameOf = (r) => (r.end ? (r.wifi && r.mac ? K.macPretty(r.mac) : (!r.wifi && r.portMacs < 2 && r.desc) || r.vendors[0] || (r.mac ? K.macPretty(r.mac) : '?')) : Q.devName(r.key));
    const ipOf = (r) => (r.end ? r.ips[0] : r.mgmtIp); const vendorOf = (r) => (r.end ? r.vendors.join(' / ') : r.manufacturer);
    const dn = (d) => (d ? Q.devName(d) : '—'); const mono = (t) => h('span', { class: 'mono' }, t || '—');
    const TAB_COUNT = { device: C.devices + C.endpoints, interface: C.interfaces, ip: C.ips, prefix: C.prefixes, mac: C.macs, vlan: C.vlans };
    const T = {
      device: ['設備', devRows, [
        { t: '設備', f: (r) => nameOf(r), s: nameOf }, { t: '類型', f: (r) => (r.wifi ? V.chip('Wi-Fi', 'info') : r.end ? V.chip('終端', 'kind-unknown') : V.kindChip(r.kind)), s: (r) => (r.wifi ? 'Wi-Fi' : r.end ? '終端' : V.KIND[r.kind] || r.kind) },
        { t: '管理 IP', f: (r) => mono(ipOf(r)), s: ipOf }, { t: '廠商', f: (r) => vendorOf(r) || '', s: vendorOf },
        { t: '連接於', f: (r) => (r.end ? `${dn(r.dev)} ${r.ifc}` : ''), s: (r) => (r.end ? dn(r.dev) + ' ' + r.ifc : null) },
        { t: '收集', f: (r) => (r.end ? '' : r.collected ? '是' : '否'), s: (r) => (r.end ? null : r.collected ? '是' : '否') }],
      (r) => (r.end ? { type: 'interface', key: r.key } : { type: 'device', key: r.key }), (r) => [nameOf(r), ipOf(r), vendorOf(r), r.kind, r.end ? dn(r.dev) + ' ' + r.ifc : null]],
      interface: ['介面', R.interfaces, [
        { t: '設備', f: (r) => dn(r.dev), s: (r) => dn(r.dev) }, { t: '介面', f: (r) => mono(r.name), s: (r) => r.name }, { t: '狀態', f: (r) => r.status, s: (r) => r.status },
        { t: 'IP', f: (r) => mono(App.Q.addressesOf(r.key).slice(0, 2).join(' ')), s: (r) => App.Q.addressesOf(r.key)[0] }, { t: 'VLAN', f: (r) => h('span', { class: 'vlanlist' }, S.util.ifcVlans(r).length ? S.check.fmtVlans(S.util.ifcVlans(r)) : '—'), s: (r) => S.util.ifcVlans(r).join(' ') }],
      (r) => ({ type: 'interface', key: r.key }), (r) => [dn(r.dev), r.name, r.desc, App.Q.addressesOf(r.key).join(' '), S.util.ifcVlans(r).join(' ')]],
      ip: ['IP', R.ips, [
        { t: 'IP', f: (r) => mono(r.ip), s: (r) => r.ip }, { t: '設備', f: (r) => dn(r.dev), s: (r) => r.dev && dn(r.dev) }, { t: '介面', f: (r) => mono(r.ifc), s: (r) => r.ifc },
        { t: 'MAC', f: (r) => mono(r.macs.slice(0, 2).map(K.macPretty).join(' ')), s: (r) => r.macs[0] }, { t: '來源', f: (r) => r.from.join('、'), s: (r) => r.from.join('、') }],
      (r) => ({ type: 'ip', key: r.ip }), (r) => [r.ip, dn(r.dev), r.ifc, r.macs.map(K.macPretty).join(' ')]],
      prefix: ['網段', R.prefixes, [
        { t: '網段', f: (r) => mono(r.prefix), s: (r) => r.net }, { t: '設備', f: (r) => r.devs.map(dn).join('、'), s: (r) => dn(r.devs[0]) },
        { t: '介面', f: (r) => mono(r.eps.map((ep) => K.splitEp(ep)[1]).join(' ')), s: (r) => r.eps.length }, { t: 'IP 數', f: (r) => String(r.ipCount), s: (r) => r.ipCount }],
      (r) => ({ type: 'interface', key: r.eps[0] }), (r) => [r.prefix, ...r.devs.map(dn), ...r.eps]],
      mac: ['MAC', R.macs, [
        { t: '設備', f: (r) => dn(r.dev), s: (r) => r.dev && dn(r.dev) }, { t: '介面', f: (r) => mono(r.ifc), s: (r) => r.ifc }, { t: 'MAC', f: (r) => mono(K.macPretty(r.mac)), s: (r) => r.mac },
        { t: 'VLAN', f: (r) => r.vlan || '—', s: (r) => r.vlan }, { t: 'IP', f: (r) => (r.ips.length ? r.ips.slice(0, 2).join(' ') : V.chip('缺 IP', 'warn')), s: (r) => r.ips[0] }],
      (r) => ({ type: 'mac', key: r.mac }), (r) => [dn(r.dev), r.ifc, K.macPretty(r.mac), r.vlan, r.ips.join(' ')]],
      vlan: ['VLAN', R.vlans, [
        { t: '設備', f: (r) => dn(r.dev), s: (r) => dn(r.dev) }, { t: 'VLAN', f: (r) => (r.id == null ? '—' : String(r.id)), s: (r) => r.id }, { t: '名稱', f: (r) => r.name || r.desc || '', s: (r) => r.name || r.desc },
        { t: '成員', f: (r) => String(r.members.length), s: (r) => r.members.length }],
      (r) => (r.id == null ? { type: 'device', key: r.dev } : { type: 'vlan', key: String(r.id) }), (r) => [dn(r.dev), r.id, r.name, r.desc]],
    };
    // 兩層：清單種類用分段按鈕，種類內的篩選用篩選選項，避免兩排看起來是同一層
    root.appendChild(h('div', { class: 'summary' }, h('div', { class: 'seg', role: 'tablist' }, Object.entries(T).map(([k, [label]]) => h('button', {
      class: `btn ${inv.kind === k ? 'on' : ''}`, role: 'tab', 'aria-selected': String(inv.kind === k), title: label + '清單',
      onclick: () => { inv.kind = k; inv.filter = 'all'; inv.sortBy = -1; inv.sortDir = 1; inventory(App); } }, [label + ' ', h('span', { class: 'n' }, String(TAB_COUNT[k]))])))));
    const [, rows0, cols, sel, text] = T[inv.kind];
    const FILTERS = {
      ip: [['all', '全部', () => true, C.ips], ['arp', 'ARP', (r) => r.from.includes('ARP'), C.arpIps], ['own', '設備自有', (r) => r.from.some((x) => x === '介面' || x === '管理'), C.ownIps], ['heard', '鄰居宣告', (r) => r.from.includes('鄰居宣告'), C.heardIps]],
      mac: [['all', '全部', () => true, C.macs], ['noip', '缺 IP', (r) => r.noIp, C.noIpMacs]],
      device: [['all', '全部', () => true, C.devices + C.endpoints], ['net', '網路設備', (r) => !r.end && r.kind !== 'host', C.devices - C.hosts], ['host', '主機', (r) => !r.end && r.kind === 'host', C.hosts], ['end', '終端', (r) => r.end, C.endpoints]],
    };
    const flt = FILTERS[inv.kind];
    if (flt) {
      root.appendChild(h('div', { class: 'summary sub' }, flt.map(([k, label, , c]) => filterChip(label, c, { cls: k === 'noip' ? 'warn' : '', on: inv.filter === k, onclick: () => { inv.filter = k; inventory(App); }, title: '點一下切換篩選' }))));
    }
    const box = h('input', { type: 'search', placeholder: '篩選：名稱、IP、MAC、VLAN…', value: inv.q, class: 'pane-filter' });
    const body = h('div');
    const draw = () => {
      const t = inv.q.trim().toLowerCase();
      const rows = rows0.filter((r) => (!flt || flt.find((x) => x[0] === inv.filter)[2](r)) && (!t || text(r).filter((x) => x != null).join(' ').toLowerCase().includes(t)));
      const sc = cols[inv.sortBy] && cols[inv.sortBy].s ? cols[inv.sortBy] : null;
      const view = sc ? V.sortRows(rows, sc, inv.sortDir) : rows;
      const note = inv.kind === 'mac' ? `共 ${C.macRows} 列（同一個 MAC 在每個觀察到的介面各一列，不重複的 MAC ${C.macs} 個）` : inv.kind === 'vlan' ? `共 ${C.vlans} 筆（每台設備的每個 VLAN 定義一筆，不重複的 VLAN ID ${C.vlanIds} 個）`
        : inv.kind === 'prefix' ? '由設備自有的介面位址推導的直連網段（推論）；VRF 尚未收集' : '';
      V.clear(body); if (note) body.appendChild(h('div', { class: 'muted pane-note' }, note));
      body.appendChild(V.table(cols, view, { onRow: (r) => App.select(sel(r), { focus: true }), limit: 500, sortBy: sc ? inv.sortBy : -1, sortDir: inv.sortDir,
        onSort: (n) => { inv.sortDir = inv.sortBy === n ? -inv.sortDir : 1; inv.sortBy = n; draw(); } }));
    };
    box.addEventListener('input', () => { inv.q = box.value; draw(); });
    root.appendChild(box); root.appendChild(body); draw();
  }
  V.lists = { findings, coverage, compare, inventory };
})(globalThis.SSOT = globalThis.SSOT || {});
