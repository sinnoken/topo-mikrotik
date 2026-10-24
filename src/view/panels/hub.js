/*
 * 資料中心的畫面（#hub）：「這一輪的輸入」逐項列出來源與狀態，「這一輪的輸出」列出工作包的內容與各種匯出。
 * 狀態與動作在 app-hub.js；資料都透過 App.round 與 App.Q（SSOT.query）讀取，這裡只排版。
 * 狀態文字一律有符號或文字（✓、!、✗、未載入），不只靠顏色；顏色只用既有的文字色變數。
 * 每次重繪都重建內容；有 data-hub-focus 的元素在重繪後把焦點還給同一個元素，鍵盤操作不會跳回開頭。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = () => V.app;

  // ---------------------------------------------------------------- 共用
  const ST = { ok: '✓ ', warn: '! ', err: '✗ ', muted: '' };
  /** 狀態文字：符號＋文字，顏色是對應的文字色（hub-st-ok 等） */
  const st = (kind, text) => h('span', { class: 'hub-st hub-st-' + kind }, ST[kind] + text);
  const btn = (label, action, onclick, attrs) => h('button', Object.assign({ type: 'button', 'data-action': action, 'data-hub-focus': action, onclick }, attrs || {}), label);
  const fileInput = (cls, accept, onFile) => h('input', { type: 'file', accept, class: 'hidden ' + cls, tabindex: '-1', 'aria-hidden': 'true',
    onchange: (ev) => { const f = ev.target.files[0]; if (f) onFile(f); } });
  /** 錯誤或警告清單：全部列出（不截斷），每筆是「路徑：訊息（代碼）」 */
  const issueList = (cls, list) => h('ul', { class: 'hub-issues ' + cls }, list.map((e) => h('li', { 'data-code': e.code || '' }, [
    e.path ? h('span', { class: 'mono' }, e.path + '：') : null, e.message, e.code ? h('span', { class: 'muted mono' }, `（${e.code}）`) : null])));
  const shQuote = (s) => (/^[\w./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

  // ---------------------------------------------------------------- 這一輪的輸入
  /** 一列：項目、來源、狀態、操作。id 給「在資料中心開啟」的區塊定位 */
  const row = (item, label, src, status, actions, id) => h('div', { class: 'hub-row', 'data-item': item, role: 'group', 'aria-label': label, id: id || null, tabindex: id ? '-1' : null }, [
    h('div', { class: 'hub-k' }, label), h('div', { class: 'hub-src' }, [h('span', { class: 'hub-cap' }, '來源：'), src]),
    h('div', { class: 'hub-st-cell' }, [h('span', { class: 'hub-cap' }, '狀態：'), status]),
    h('div', { class: 'hub-act' }, actions || [])]);

  function inputRows(App, busy) {
    const r = App.round; const Q = App.Q; const m = Q ? Q.meta() : null;
    const fromPack = r.origin && r.origin.kind === 'workpack' ? r.origin : null;
    const rows = [];
    // 收集檔
    const names = r.sources.map((s) => (s.name === S.readers.PASTE ? '（貼上的內容）' : s.name));
    const failures = Q ? Q.coverage().reduce((n, c) => n + (c.failures || []).length, 0) : 0;
    rows.push(row('sources', '收集檔',
      names.length ? `${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${V.num(names.length)} 份` : ''}${fromPack ? `（由工作包 ${fromPack.name} 帶回）` : ''}` : '—',
      !Q ? st('muted', '未載入') : h('span', null, [st('ok', `已收集 ${V.num(m.stats.collected)} 台`), failures ? st('warn', `・收集失敗 ${V.num(failures)} 段`) : null]),
      [btn('讀入收集檔…', 'row-read-sources', () => App.openInput(), { disabled: busy || null })]));
    // 上一輪的基準：工作包帶回的基準就是上一輪；讀入這一輪的收集檔後自動比對（也可以手動載入之前匯出的基準）
    const prev = V.baselineDiff.status();
    const prevFile = fileInput('hub-file-previous', '.json,application/json', (f) => V.baselineDiff.loadFile(App, f));
    let prevSt;
    if (prev) {
      const rep = prev.report; const ver = (rep.warnings || []).find((w) => w.kind === 'version');
      prevSt = rep.errors.length ? st('err', '無法比對：' + rep.errors[0])
        : ver ? st('warn', '已比對；' + ver.message)
          : st('ok', `已比對：新增 ${V.num(rep.summary.added)}、移除 ${V.num(rep.summary.removed)}、變更 ${V.num(rep.summary.changed)}`);
    } else prevSt = fromPack ? st('ok', '已載入為目前的基準；讀入這一輪的收集檔後會自動和它比對') : st('muted', '未載入');
    rows.push(row('previous', '上一輪的基準', prev ? prev.name : fromPack ? `工作包 ${fromPack.name}（${V.fmtUtc(fromPack.createdAt)} 建立）` : '—', prevSt,
      [prevFile, btn('載入舊基準（JSON）…', 'load-previous', () => prevFile.click(), { disabled: !Q || busy || null })]));
    // 處理紀錄
    const ls = A().ledgerState(); const lg = ls.ledger;
    const ledgerFile = fileInput('hub-file-ledger', '.json,application/json', (f) => A().importLedgerFile(f));
    const idx = A().ledgerRoundIndex();
    rows.push(row('ledger', '處理紀錄', '這個瀏覽器（工作包中有備份）',
      ls.blocked ? st('err', '停用：' + ls.blocked.reason)
        : Q && idx >= 0 ? st('ok', `第 ${V.num(idx + 1)} 輪（共 ${V.num(lg.iterations.length)} 輪、${V.num(Object.keys(lg.items).length)} 項）`)
          : st('muted', `${V.num(lg.iterations.length)} 輪、${V.num(Object.keys(lg.items).length)} 項`),
      [ledgerFile, btn('讀入處理紀錄…', 'import-ledger', () => ledgerFile.click(), { class: 'ledger-import', disabled: busy || null })], 'hub-sec-ledger'));
    // 命名規則
    const p = r.profile; const used = m && m.profile;
    rows.push(row('profile', '命名規則', p ? `${p.id}${p.version != null ? ` v${p.version}` : ''}${p.label ? '：' + p.label : ''}` : '—',
      !Q ? st('muted', p ? '下次建立基準時使用' : '未選擇') : used ? st('ok', '已套用') : st('muted', '未套用（只依收集的資料判斷）'),
      [btn('變更…', 'change-profile', () => App.openInput(), { title: '在「讀入收集檔」的對話框選擇命名規則，重新建立基準', disabled: busy || null })]));
    // 建立選項 expectedData（和下一列的預期資料不同：它是建立基準的選項，會改變基準鍵）
    const xd = r.expectedData;
    rows.push(row('expected-data', '建立選項 expectedData', xd ? `${V.num(Object.keys(xd).length)} 類設備${fromPack ? '（由工作包帶回）' : ''}` : '—',
      xd ? st('ok', '建立基準時使用（會改變基準鍵）') : st('muted', '未使用'), []));
    // 預期資料（ssot-expected/1，和基準比對用）
    const exp = r.expected; const rep = V.lists.compare.report(App);
    const expFile = fileInput('hub-file-expected', '.json,application/json', (f) => V.lists.compare.loadFile(App, f));
    rows.push(row('expected', '預期資料（ssot-expected/1）', exp ? exp.name : '—',
      !exp ? st('muted', '未載入') : rep && rep.errors.length ? st('err', rep.errors[0])
        : rep ? st(rep.items.some((i) => i.status !== 'ok') ? 'warn' : 'ok', `已比對：有差異 ${V.num(rep.items.filter((i) => i.status !== 'ok').length)} 項、一致 ${V.num(rep.summary.ok || 0)} 項`)
          : st('muted', '建立基準後比對'),
      [expFile, btn('載入預期資料（JSON）…', 'load-expected', () => expFile.click(), { disabled: !Q || busy || null })]));
    // 覆蓋率
    const nC01 = Q ? Q.findingsByRule('C01').length : 0;
    rows.push(row('coverage', '覆蓋率', Q ? `已收集 ${V.num(m.stats.collected)}／${V.num(m.stats.devices)} 台${nC01 ? `（${V.num(nC01)} 台網路設備只被鄰居發現）` : ''}` : '—',
      !Q ? st('muted', '建立基準後顯示') : nC01 ? st('warn', '有未收集的網路設備（C01）') : st('ok', '沒有未收集的網路設備'),
      [btn('匯出 devices.csv 草稿', 'devices-csv', () => App.exportAs('devicesCsv'), { disabled: !nC01 || null, title: '給 tools/collect.sh 的設備清單草稿；user 是佔位值，執行前請修改' })]));
    return h('div', { class: 'hub-rows' }, [
      h('div', { class: 'hub-row hub-row-head', 'aria-hidden': 'true' }, ['項目', '來源', '狀態', '操作'].map((t) => h('div', null, t))), ...rows]);
  }

  /** 讀入工作包的結果：失敗時列出全部問題；成功時列出警告與要帶回的內容，等使用者確認 */
  function readBlock(App, hub) {
    const w = hub.read; if (!w) return null;
    const close = btn('關閉', 'cancel-workpack', () => App.cancelWorkpack(), { class: 'ghost' });
    if (w.errors && !w.pack) {
      return h('div', { class: 'wp-read wp-read-error', role: 'alert' }, [
        h('p', { class: 'warn-line' }, `${w.name} 無法讀入（${V.num(w.errors.length)} 項問題），目前的資料不變：`),
        issueList('wp-errors', w.errors), w.warnings.length ? h('p', { class: 'muted' }, '另有警告：') : null,
        w.warnings.length ? issueList('wp-warnings', w.warnings) : null, h('div', { class: 'row' }, [close])]);
    }
    if (w.done) {
      return h('div', { class: 'wp-read wp-read-done', role: 'status' }, [
        h('p', null, w.brought.length ? `已從 ${w.name} 帶回：${w.brought.join('、')}。` : `${w.name}：沒有帶回任何內容。`),
        w.warnings.length ? h('p', { class: 'warn-line' }, `警告（${V.num(w.warnings.length)} 項）：`) : null,
        w.warnings.length ? issueList('wp-warnings', w.warnings) : null, h('div', { class: 'row' }, [close])]);
    }
    const pack = w.pack; const c = w.choose; const mf = pack.manifest; const busy = !!hub.busy;
    const check = (key, label, note, attrs) => {
      const cb = h('input', Object.assign({ type: 'checkbox', class: 'wp-choose', 'data-choose': key, 'data-hub-focus': 'wp-' + key }, attrs || {}));
      cb.checked = !!c[key]; cb.disabled = !!(attrs && attrs.disabled) || busy;
      cb.addEventListener('change', () => A().chooseWorkpack(key, cb.checked));
      return h('label', { class: 'wp-option' }, [cb, ' ', h('span', null, label), note ? h('span', { class: 'muted wp-note' }, note) : null]);
    };
    // 命名規則：預設用工作包附的；也可以換成目前清單中的或不套用（基準鍵會不同，處理紀錄當成新的一輪）
    const sel = h('select', { class: 'wp-profile', 'data-hub-focus': 'wp-profile', 'aria-label': '重建基準時使用的命名規則' }, [
      pack.profile ? h('option', { value: 'pack' }, `工作包附的：${pack.profile.id}${pack.profile.version != null ? ` v${pack.profile.version}` : ''}`) : null,
      ...Object.values(S.profiles).filter((p) => p && p.id).map((p) => h('option', { value: p.id }, `目前清單中的：${p.id}`)),
      h('option', { value: 'none' }, '不套用'),
    ]);
    sel.value = c.profileId; sel.disabled = busy;
    sel.addEventListener('change', () => A().chooseWorkpack('profileId', sel.value));
    const profChanged = (c.profileId === 'pack' ? pack.profile : A().workpackProfileOf(w, c.profileId)) !== pack.profile;
    const nItems = pack.ledger ? Object.keys(pack.ledger.items).length : 0;
    const loss = w.loss;
    const lossText = loss && (loss.blocked ? '目前的處理紀錄停用中；取代後，瀏覽器中格式不正確的原資料會被取代。'
      : `目前的處理紀錄有 ${[loss.onlyHere ? `${V.num(loss.onlyHere)} 項不在工作包中` : '', loss.differ ? `${V.num(loss.differ)} 項和工作包的內容不同` : '',
        loss.rounds ? `${V.num(loss.rounds)} 輪不在工作包中或內容不同` : ''].filter(Boolean).join('、')}；取代後這些內容會遺失。`);
    return h('div', { class: 'wp-read wp-read-confirm', role: 'group', 'aria-label': '確認要從工作包帶回的內容' }, [
      h('p', null, [h('b', null, w.name), `：${mf.toolVersion} 版於 ${V.fmtUtc(mf.createdAt)} 建立；收集檔 ${V.num(pack.sources.length)} 份、`
        + `檔案 ${V.num(pack.files.length)} 個；格式與雜湊都已核對。`]),
      pack.warnings.length ? h('div', { class: 'wp-warn-box', role: 'note' }, [h('p', { class: 'warn-line' }, `警告（${V.num(pack.warnings.length)} 項），資料仍可使用：`), issueList('wp-warnings', pack.warnings)]) : null,
      h('fieldset', { class: 'wp-choices' }, [h('legend', null, '要帶回的內容'),
        check('baseline', '上一輪的基準', '以工作包的收集檔重新建立並核對，取代目前的基準'),
        h('label', { class: 'wp-option wp-profile-row' }, [h('span', null, '命名規則 '), sel,
          profChanged ? h('span', { class: 'warn-line wp-note' }, '和工作包不同：基準鍵會不同，處理紀錄會當成新的一輪') : h('span', { class: 'muted wp-note' }, pack.profile ? '會加入命名規則清單' : '')]),
        check('ledger', '處理紀錄', pack.ledger ? `${V.num(nItems)} 項、${V.num(pack.ledger.iterations.length)} 輪；整份取代目前的處理紀錄` : '工作包沒有處理紀錄', { disabled: !pack.ledger }),
        check('expected', '預期資料（ssot-expected/1）', pack.expected ? '取代目前載入的預期資料' : '工作包沒有預期資料', { disabled: !pack.expected }),
        pack.expectedData ? h('p', { class: 'muted wp-note' }, `建立選項 expectedData（${V.num(Object.keys(pack.expectedData).length)} 類設備）：重建時一定使用`) : null,
      ]),
      c.ledger && loss ? h('div', { class: 'wp-loss', role: 'alert' }, [
        h('p', { class: 'warn-line' }, lossText),
        h('div', { class: 'row' }, [
          A().ledgerState().blocked && A().ledgerState().blocked.raw === undefined ? null : btn('先匯出目前的處理紀錄', 'export-ledger-first', () => App.exportLedger()),
          check('ack', '我了解，取代目前的處理紀錄'),
        ]),
        w.needAck && !c.ack ? h('p', { class: 'warn-line' }, '請先勾選確認，才會取代處理紀錄。') : null,
      ]) : null,
      w.errors ? h('div', { class: 'wp-validate-error', role: 'alert' }, [h('p', { class: 'warn-line' }, `重建核對沒有通過（${V.num(w.errors.length)} 項），沒有帶回任何內容，目前的資料不變：`), issueList('wp-errors', w.errors),
        w.validateWarnings && w.validateWarnings.length ? issueList('wp-warnings', w.validateWarnings) : null]) : null,
      h('div', { class: 'row' }, [
        btn('帶回', 'apply-workpack', () => App.applyWorkpack(), { class: 'primary', disabled: busy || (!c.baseline && !c.ledger && !c.expected && c.profileId !== 'pack') || null }),
        btn('取消', 'cancel-workpack', () => App.cancelWorkpack(), { class: 'ghost', disabled: busy || null })]),
    ]);
  }

  // ---------------------------------------------------------------- 這一輪的輸出
  function packBlock(App, hub) {
    const roles = A().workpackRoles(); const busy = !!hub.busy; const has = !!App.snap;
    const opt = (x) => {
      const cb = h('input', { type: 'checkbox', class: 'hub-pack-role', 'data-role': x.role, 'data-hub-focus': 'pack-' + x.role });
      cb.checked = x.on; cb.disabled = busy || x.required || !x.available;
      if (x.key) cb.addEventListener('change', () => A().togglePackRole(x.key, cb.checked));
      return h('label', { class: 'wp-option' + (x.available ? '' : ' off') }, [cb, ' ', h('span', null, x.label),
        x.required && x.available ? h('span', { class: 'chip' }, '必要') : null, x.note ? h('span', { class: 'muted wp-note' }, x.note) : null]);
    };
    return h('div', { class: 'hub-pack' }, [
      h('fieldset', { class: 'wp-choices' }, [h('legend', null, '工作包的內容'), ...roles.map(opt)]),
      h('div', { class: 'row' }, [
        btn('匯出本輪工作包（ZIP）', 'download-workpack', () => App.downloadWorkpack(), { class: 'primary', disabled: !has || busy || null }),
        has ? h('span', { class: 'muted' }, A().workpackName()) : h('span', { class: 'muted' }, '建立基準後才能匯出'),
      ]),
      hub.buildErrors ? h('div', { class: 'wp-build-error', role: 'alert' }, [
        h('p', { class: 'warn-line' }, `無法建立工作包（${V.num(hub.buildErrors.length)} 項問題），沒有下載：`), issueList('wp-errors', hub.buildErrors)]) : null,
    ]);
  }
  function outputCards(App, hub) {
    const has = !!App.snap; const busy = !!hub.busy; const off = !has || busy || null;
    const ls = A().ledgerState();
    const nPatch = has ? V.patchView.selectedCount(App) : 0;
    const nC01 = has ? App.Q.findingsByRule('C01').length : 0;
    const failures = has ? App.Q.coverage().reduce((n, c) => n + (c.failures || []).length, 0) : 0;
    const first = App.round.sources.find((s) => s.name !== S.readers.PASTE);
    const card = (key, title, desc, kids, id) => h('div', { class: 'hub-out', 'data-output': key, id: id || null, tabindex: id ? '-1' : null, role: 'group', 'aria-label': title },
      [h('h3', null, title), h('p', { class: 'muted' }, desc), h('div', { class: 'row' }, kids)]);
    return h('div', { class: 'hub-outs' }, [
      card('next', '給下一輪的自己', '基準 JSON・處理紀錄 JSON（工作包裡也有）', [
        btn('基準 JSON', 'export-snapshot', () => App.exportAs('snapshot'), { disabled: off, title: '目前的基準（Snapshot JSON），內容原樣不改寫；之後可當作舊基準比對' }),
        btn('處理紀錄 JSON', 'export-ledger', () => App.exportLedger(), { class: 'ledger-export', disabled: (ls.blocked && ls.blocked.raw === undefined) || busy || null,
          title: ls.blocked ? '處理紀錄停用中：匯出瀏覽器中格式不正確的原資料' : 'ssot-ledger/1' }),
      ]),
      card('device', '給設備', `修正 patch：每台的套用、回復、驗證 .rsc 與總表。本工具只產生文字，不會連線設備。${nPatch ? `目前選取 ${V.num(nPatch)} 項，會放進工作包。` : ''}`, [
        btn('開啟修正計畫', 'open-patch', () => App.openPatch(), { class: 'open-patch', disabled: off }),
      ]),
      card('report', '給報告或紀錄', '檢查結果 Markdown／CSV（含處理狀態，不受檢查結果分頁的篩選影響）・拓樸 PNG', [
        btn('Markdown', 'export-markdown', () => A().exportReport('markdown'), { disabled: off, title: '依嚴重度（或依設備）分組的報表，含證據行號，已處理的項目會標示狀態與備註' }),
        btn('CSV', 'export-csv', () => A().exportReport('csv'), { disabled: off, title: '每筆一列，含相關實體、證據行號、處理狀態、時間與備註（Excel 可直接開啟）' }),
        btn('依設備排序', 'by-device', () => A().toggleByDevice(), { class: 'ghost export-by-device' + (hub.byDevice ? ' on' : ''), 'aria-pressed': String(hub.byDevice),
          title: '匯出時依設備排序（Markdown 依設備分組）；不屬於任何設備的排最後；工作包的報表也依這個設定' }),
        btn('拓樸 PNG', 'export-png', () => A().exportPng(), { disabled: off, title: '目前的拓樸圖畫面' }),
      ], 'hub-sec-reports'),
      h('div', { class: 'hub-out', 'data-output': 'collector', role: 'group', 'aria-label': '給收集器' }, [
        h('h3', null, '給收集器'), h('p', { class: 'muted' }, 'devices.csv 草稿（未收集的網路設備）・只重收失敗的指令'),
        h('div', { class: 'row' }, [btn('devices.csv 草稿', 'export-devices-csv', () => App.exportAs('devicesCsv'), { disabled: !nC01 || busy || null,
          title: nC01 ? `C01 ${nC01} 台；user 是佔位值，執行前請修改` : '沒有未收集的網路設備（C01）' })]),
        failures ? h('p', { class: 'muted' }, `有 ${V.num(failures)} 段收集失敗，可以只重收失敗的指令：`) : null,
        failures ? h('code', { class: 'mono hub-cmd' }, `./tools/collect.sh devices.csv --retry-failed ${shQuote(first ? first.name : 'collection.txt')} -o collection-retry.txt`) : null,
      ]),
      card('compare', '給之後的比對', '預期資料（ssot-expected/1）：把確認過的現況當作標準，之後和新的基準比對', [
        btn('預期資料', 'export-expected', () => App.exportAs('expected'), { disabled: off, title: '由目前的基準產生（已收集的設備、雙向確認的鏈路、VLAN）' }),
      ]),
    ]);
  }

  // ---------------------------------------------------------------- 整體
  function render(App) {
    const root = $('#hub'); if (!root) return;
    const hub = A().hubState(); const busy = !!hub.busy;
    const ae = document.activeElement;
    const focusKey = ae && ae.getAttribute && hub.open ? ae.getAttribute('data-hub-focus') : null;
    V.clear(root);
    root.setAttribute('aria-busy', String(busy));
    const wpFile = fileInput('hub-file-workpack', '.zip,application/zip', (f) => A().readWorkpackFile(f));
    root.appendChild(h('div', { class: 'hub-inner' }, [
      h('div', { class: 'hub-head' }, [
        h('h1', { id: 'hub-title', tabindex: '-1' }, '資料中心'),
        h('span', { class: 'muted' }, '每一輪的輸入與輸出都在這裡；全部在本機處理，不會傳到任何地方'),
        h('span', { class: 'hub-spacer' }),
        btn('回到拓樸圖', 'close-hub', () => A().closeHub({ focus: true }), { class: 'ghost hub-close', title: '關閉資料中心（Esc）' }),
      ]),
      h('div', { id: 'hub-busy', class: 'hub-busy' + (busy ? '' : ' hidden'), role: 'status', 'aria-live': 'polite' }, busy ? [
        // 有進度（重建）時是確定的進度條，否則是不確定的動畫；文字一律說明在做什麼
        h('div', { class: 'progress' + (hub.progress ? '' : ' indeterminate'), role: 'progressbar', 'aria-label': hub.busy, 'aria-valuemin': '0', 'aria-valuemax': '100',
          'aria-valuenow': hub.progress ? String(hub.progress.pct) : null }, h('div', { style: hub.progress ? { width: hub.progress.pct + '%' } : null })),
        h('span', null, hub.busy), h('span', { class: 'hub-progress-text' }, hub.progress ? hub.progress.text : '')] : []),
      h('section', { class: 'hub-card', id: 'hub-sec-inputs', tabindex: '-1', 'aria-labelledby': 'hub-in-title' }, [
        h('div', { class: 'hub-card-head' }, [h('h2', { id: 'hub-in-title' }, '這一輪的輸入'), h('span', { class: 'hub-spacer' }), wpFile,
          btn('讀入工作包…', 'read-workpack', () => wpFile.click(), { disabled: busy || null }),
          btn('讀入收集檔…', 'read-sources', () => App.openInput(), { class: 'primary', disabled: busy || null })]),
        h('p', { class: 'muted' }, '讀入上一輪的工作包，會一次帶回上一輪的基準、處理紀錄與命名規則；再讀入這一輪的收集檔，就會自動和上一輪的基準比對並推進處理紀錄。'),
        readBlock(App, hub),
        inputRows(App, busy),
        V.ledgerPane.importBlock(App),
      ]),
      h('section', { class: 'hub-card', id: 'hub-sec-outputs', tabindex: '-1', 'aria-labelledby': 'hub-out-title' }, [
        h('div', { class: 'hub-card-head' }, [h('h2', { id: 'hub-out-title' }, '這一輪的輸出')]),
        h('p', { class: 'muted' }, '工作包（不壓縮的 ZIP）包含收集檔、基準、處理紀錄、報表與 patch；下一輪讀回這一份就能接著做。收集檔可能含有設備機密，請自行保管。'),
        packBlock(App, hub),
        outputCards(App, hub),
      ]),
    ]));
    if (focusKey) {
      const el = ['button', 'input', 'select'].flatMap((t) => Array.from(root.querySelectorAll(t))).find((x) => x.getAttribute('data-hub-focus') === focusKey && !x.disabled);
      if (el) el.focus();
    }
  }

  V.hub = { render };
})(globalThis.SSOT = globalThis.SSOT || {});
