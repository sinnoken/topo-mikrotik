// 畫面冒煙測試的 step：資料中心、命名規則、工作包、深層凍結、本機資料與清除基準。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { body, docListeners, document, S, fs, path, vm, ROOT, step, captureDownloads, buildInput, hubBtn, stepBtn, goStep, clearBaseline, until, $, text, shared, L4 } = require('../helpers.js');

module.exports = async () => {
  await step('資料中心：列出本輪所有的輸入與輸出與各自的狀態，鍵盤可開關（Esc 關閉後焦點回到按鈕），蓋住主畫面時主畫面不可聚焦', async () => {
    const VA = S.view.app; const NUM = S.view.num; const btnHub = $('#btn-hub');
    if (!btnHub || $('#btn-input')) throw new Error('頁首應有「資料中心」，建立基準改由資料中心的「讀入收集檔…」進入');
    btnHub.click();
    if ($('#hub').classList.contains('hidden') || btnHub.getAttribute('aria-expanded') !== 'true') throw new Error('按「資料中心」應開啟資料中心');
    if (document.activeElement !== $('#hub-title')) throw new Error('開啟後焦點應移到資料中心的標題');
    if (!$('#main').inert || !$('#app').classList.contains('hub-open')) throw new Error('資料中心開啟時主畫面應是 inert（鍵盤不會跑到被蓋住的圖上）');
    const row = (k) => $('#hub').testAll('.hub-row').find((r) => r.getAttribute('data-item') === k);
    ['sources', 'previous', 'ledger', 'profile', 'expected-data', 'expected', 'coverage'].forEach((k) => {
      const r = row(k);
      if (!r) throw new Error('資料中心應列出輸入：' + k);
      const stx = r.querySelector('.hub-st');
      if (!stx || !stx.textContent.trim()) throw new Error(`${k} 應有狀態文字（不只靠顏色）`);
      if (/hub-st-(ok|warn|err)/.test(stx.className) && !/^[✓!✗] /.test(stx.textContent)) throw new Error(`${k} 的狀態色應搭配符號`);
    });
    ['read-workpack', 'read-sources', 'load-previous', 'import-ledger', 'change-profile', 'load-expected', 'devices-csv',
      'download-workpack', 'export-snapshot', 'export-ledger', 'open-patch', 'export-markdown', 'export-csv', 'export-site-markdown', 'export-site-csv', 'export-manager-summary', 'by-device', 'export-png', 'export-devices-csv', 'export-expected']
      .forEach((a) => { if (!hubBtn(a)) throw new Error('資料中心缺少入口：' + a); });
    // 狀態和目前的資料一致（依關係，不寫死筆數）
    const m = App.Q.meta();
    if (!row('sources').textContent.includes(`已收集 ${NUM(m.stats.collected)} 台`)) throw new Error('收集檔應列出已收集的台數：' + row('sources').textContent);
    const idx = VA.ledgerRoundIndex();
    if (idx < 0 || !row('ledger').textContent.includes(`第 ${NUM(idx + 1)} 輪`)) throw new Error('處理紀錄應列出目前是第幾輪：' + row('ledger').textContent);
    if (!row('profile').textContent.includes(m.profile ? '已套用' : '未套用')) throw new Error('命名規則的狀態應依基準');
    { const rp = App.round.profile; const nm = rp && S.view.settings.profiles.nameOf(rp);
      if (/object Object/.test(row('profile').textContent) || (nm && !row('profile').textContent.includes(nm))) throw new Error('命名規則列應顯示規則名稱（V.settings.profiles.nameOf）：' + row('profile').textContent); }
    const rep = S.view.lists.compare.report(App);
    if (!!App.round.expected !== !row('expected').textContent.includes('未載入')) throw new Error('預期資料的狀態應依是否載入');
    if (rep && !rep.errors.length && !row('expected').textContent.includes('已比對')) throw new Error('預期資料載入後應列出比對結果');
    const nC01 = App.Q.findingsByRule('C01').length;
    const cs = App.Q.coverageSummary();
    if (!row('coverage').textContent.includes(`已收集 ${NUM(cs.networkCollected)}／${NUM(cs.network)} 台網路設備`)) throw new Error('覆蓋率應以網路設備為分母：' + row('coverage').textContent);
    if (cs.hosts && !row('coverage').textContent.includes(`另有 ${NUM(cs.hosts)} 台主機`)) throw new Error('覆蓋率應另列主機：' + row('coverage').textContent);
    if ((hubBtn('devices-csv').getAttribute('disabled') !== null) !== !nC01) throw new Error('沒有 C01 時 devices.csv 草稿應停用');
    // 狀態文字不露出檢查代碼（代碼只放 title）；各列共用同一組欄（subgrid），來源與狀態靠左和項目欄對齊
    ['sources', 'previous', 'ledger', 'profile', 'expected-data', 'expected', 'coverage'].forEach((k) => {
      const cell = row(k).querySelector('.hub-st-cell'); if (/\b[A-Z]\d{2}\b/.test(cell.textContent)) throw new Error(`${k} 的狀態不應出現檢查代碼：${cell.textContent}`);
    });
    if (nC01 && !row('coverage').querySelector('.hub-st-cell').testAll('span').some((x) => /^C01 /.test(x.getAttribute('title') || ''))) throw new Error('覆蓋率的代碼應保留在 title');
    const hubCss = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    if (!/\.hub-row \{[^}]*grid-template-columns: subgrid;[^}]*text-align: left;/.test(hubCss) || !/\.hub-rows \{ display: grid;/.test(hubCss)) throw new Error('資料中心各列應共用同一組欄並靠左對齊');
    // 工作包的角色：收集檔與基準一定放（不能取消）；命名規則用過就一定放
    const roleBox = (r) => $('#hub').testAll('.hub-pack-role').find((x) => x.getAttribute('data-role') === r);
    ['source', 'snapshot'].forEach((r) => { const cb = roleBox(r); if (!cb || !cb.checked || !cb.disabled) throw new Error(r + ' 是工作包的必要內容，應勾選且不能取消'); });
    if (App.round.profile && (!roleBox('profile').checked || !roleBox('profile').disabled)) throw new Error('基準用了命名規則時，命名規則一定要放進工作包');
    // 用字：「基準（JSON）」「修正指令（.rsc）」，機密提醒只在工作包說明寫一次（UX #19）
    const roleLabel = (r) => roleBox(r).parentNode.textContent;
    if (!roleLabel('snapshot').includes('基準（JSON）') || !roleLabel('patch').includes('修正指令（.rsc）') || /Snapshot JSON|patch/.test(roleLabel('snapshot') + roleLabel('patch'))) throw new Error('工作包內容的用字：' + roleLabel('snapshot') + '／' + roleLabel('patch'));
    if ((text('#hub').match(/設備機密/g) || []).length !== 1) throw new Error('「可能含有設備機密」在資料中心只寫一次');
    // 勾選可選的角色後，焦點留在同一個核取方塊（重繪不會讓鍵盤跳回開頭）
    const lgBox = roleBox('ledger'); lgBox.focus(); lgBox.checked = false; lgBox.dispatch('change');
    if (roleBox('ledger').checked || document.activeElement !== roleBox('ledger')) throw new Error('取消勾選後應保持取消，焦點留在同一個核取方塊');
    roleBox('ledger').checked = true; roleBox('ledger').dispatch('change');
    // Esc 關閉，焦點回到頁首的按鈕
    (docListeners.keydown || []).forEach((f) => f({ key: 'Escape', preventDefault() {} }));
    if (!$('#hub').classList.contains('hidden') || document.activeElement !== btnHub || $('#main').inert || btnHub.getAttribute('aria-expanded') !== 'false') throw new Error('Esc 應關閉資料中心並把焦點還給按鈕');
    // 檢查結果分頁的「匯出報表…」開啟資料中心的報表區塊
    goStep('triage');
    $('#pane-findings').querySelector('.open-hub').click();
    if ($('#hub').classList.contains('hidden') || document.activeElement !== $('#hub-sec-reports')) throw new Error('「匯出報表…」應開啟資料中心並聚焦報表');
    // 選取（例如從搜尋進來）要在圖與詳情看到結果：關閉資料中心
    App.select({ type: 'device', key: App.Q.devices()[0].key });
    if (!$('#hub').classList.contains('hidden')) throw new Error('選取設備後應關閉資料中心');
    // 窄螢幕：資料中心的列與輸出卡片改成單欄（覆蓋一般樣式，所以要寫在它之後），不產生水平捲動
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    const base = css.indexOf('.hub-row { display: grid;'); const narrow = css.lastIndexOf('@media (max-width: 900px)');
    const tail = css.slice(narrow);
    if (base < 0 || narrow < base || !/\.hub-row \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(tail) || !/\.hub-outs \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(tail)) throw new Error('窄螢幕時資料中心應改成單欄，且規則要在一般樣式之後');
    if (!/\.hub \{[^}]*overflow-x: hidden/.test(css)) throw new Error('資料中心不應水平捲動');
  });
  await step('設定「命名規則」：說明與文件連結、內建與已載入分開列、套用結果與沒對上的名稱、載入錯誤、下載範本、匯出、移除先確認且內建不可移除', async () => {
    const VP = S.view.settings.profiles; const panel = () => $('#settings-panel'); const wait = () => new Promise((r) => setTimeout(r, 20));
    App.openSettings('profiles'); await wait();
    const body = () => text('#settings-panel');
    // 窄螢幕：6 欄的表格包在可橫向捲動的 .table-scroll，不撐寬整頁
    { const ts = panel().testAll('table'); const wrapped = panel().testAll('.table-scroll table');
      if (!ts.length || ts.some((t) => !wrapped.includes(t))) throw new Error('命名規則的表格應包在 .table-scroll 內'); }
    if (!body().includes('不會新增、刪除或改寫') || !panel().testAll('a').some((a) => a.classList.contains('doc-link') && decodeURI(a.getAttribute('href')).endsWith('/blob/main/docs/命名規則.md'))) throw new Error('分類頂端應說明命名規則不改事實，並連到 docs/命名規則.md：' + body());
    const rowsOf = (src) => { const t = panel().testAll('table').find((x) => x.dataset.source === src); return t ? t.testAll('tr').filter((r) => r.dataset.profile) : []; };
    const btnOf = (r, action) => r.testAll('button').find((b) => b.dataset.action === action);
    // 內建：profiles/*.js 載入的；顯示 id、名稱、說明（S.profile.describe）、來源；不能移除
    const builtin = VP.builtinIds();
    if (!builtin.length || rowsOf('builtin').map((r) => r.dataset.profile).join() !== builtin.join()) throw new Error('內建的命名規則應各一列：' + rowsOf('builtin').map((r) => r.dataset.profile));
    rowsOf('builtin').forEach((r) => {
      const p = S.profiles[r.dataset.profile];
      if (!r.textContent.includes(S.profile.nameOf(p)) || !r.textContent.includes(S.profile.describe(p)) || !r.textContent.includes('內建')) throw new Error('內建的列應有名稱、說明與來源：' + r.textContent);
      if (btnOf(r, 'remove')) throw new Error('內建的命名規則不可移除');
      if (!btnOf(r, 'export')) throw new Error('每一份都可以匯出');
    });
    if (!rowsOf('saved').length && !body().includes('還沒有載入')) throw new Error('沒有載入過的命名規則時應明確說明');
    // 套用結果（對目前基準，S.profile.compile(…).coverage(Q)）：摘要與沒對上的名稱（最多 N 筆，可展開）
    if (!App.Q) throw new Error('測試前提：應有基準');
    const sel = $('#settings-profile-cov'); if (!sel) throw new Error('應可選擇要看套用結果的命名規則');
    const pid = builtin[0]; sel.value = pid; sel.dispatch('change'); await wait();
    const cov = S.profile.coverage(S.profiles[pid], App.Q); const box = () => $('#settings-profile-coverage');
    if (!text('#settings-profile-coverage').includes(`${cov.matched}／${cov.total}`)) throw new Error('應顯示對上幾台：' + text('#settings-profile-coverage'));
    const items = () => box().testAll('li').filter((li) => li.dataset.unmatched);
    if (items().length !== Math.min(VP.UNMATCHED_MAX, cov.unmatched.length)) throw new Error('沒對上的名稱最多先列 ' + VP.UNMATCHED_MAX + ' 筆：' + items().length);
    if (cov.unmatched.length > VP.UNMATCHED_MAX) {
      box().testAll('button').find((b) => b.dataset.action === 'more').click(); await wait();
      if (items().length !== cov.unmatched.length) throw new Error('展開後應列出全部沒對上的名稱');
    }
    cov.fields.group.slice(0, 1).forEach((g) => { if (!text('#settings-profile-coverage').includes(g.value)) throw new Error('應列出分群的分布'); });
    if (App.round.profile && !rowsOf('builtin').concat(rowsOf('saved')).some((r) => r.dataset.profile === App.round.profile.id && r.textContent.includes('目前的基準使用'))) throw new Error('應標出目前基準用的命名規則');
    // 載入錯誤：JSON 不合法、compile 的錯誤都明確說明，不加入清單
    const file = $('#settings-profile-file');
    const pick = async (name, content) => { file.files = [{ name, text: async () => content }]; file.dispatch('change', { target: file }); await wait(); };
    await pick('broken.json', '{ nope');
    if (!text('#settings-profiles-status').includes('broken.json') || !text('#settings-profiles-status').includes('JSON')) throw new Error('不是 JSON 時應說明：' + text('#settings-profiles-status'));
    await pick('bad.json', JSON.stringify({ id: 'bad', classify: [{ match: '(' }] }));
    if (!text('#settings-profiles-status').includes('正規表示式') || S.profiles.bad) throw new Error('compile 失敗時應列出錯誤且不加入：' + text('#settings-profiles-status'));
    const r0 = await VP.loadFile({ name: 'noid.json', text: async () => '{}' });
    if (r0.ok || !/缺少 id/.test(r0.error)) throw new Error('loadFile 應回傳 compile 的錯誤：' + JSON.stringify(r0));
    // 重複的鍵（JSON.parse 只留最後一個）：由 S.profile.compile 的解析擋下，錯誤含檔名，不加入
    await pick('dup.json', '{ "id": "dup-key", "label": "名稱", "label": { "match": "^(.+)$", "value": "$1" } }');
    if (!text('#settings-profiles-status').includes('dup.json') || !text('#settings-profiles-status').includes('重複的鍵') || S.profiles['dup-key']) throw new Error('重複的鍵應報錯（含檔名）且不加入：' + text('#settings-profiles-status'));
    // 載入成功：存進 store 的 'profiles'，列在「已載入」
    const floor = fs.readFileSync(path.join(ROOT, 'profiles/floor-device-naming.json'), 'utf8');
    await pick('floor-device-naming.json', floor);
    const fid = JSON.parse(floor).id;
    if (!S.profiles[fid] || !((await S.store.get('profiles')) || {})[fid]) throw new Error('載入的命名規則應加入並存進 store');
    const savedRow = rowsOf('saved').find((r) => r.dataset.profile === fid);
    if (!savedRow || !savedRow.textContent.includes('已載入') || !text('#settings-profiles-status').includes(fid)) throw new Error('載入的命名規則應列在「已載入」');
    // 名稱取自 S.profile.compile(…).name（name 欄位）；設定、建立基準對話框的選單與資料中心用同一個取法
    { const nm = S.profile.compile(floor).name;
      if (!nm || VP.nameOf(S.profiles[fid]) !== nm || !savedRow.textContent.includes(nm)) throw new Error('已載入的列應顯示規則名稱：' + savedRow.textContent);
      if (VP.nameOf({ id: 'x', label: { match: '^(.+)$', value: '$1' } }) !== null) throw new Error('物件的 label 是顯示名稱規則，不是名稱');
      await App.openInput(); const opt = $('#input-profile').testAll('option').find((o) => o.value === fid);
      if (!opt || !opt.textContent.includes(nm) || /object Object/.test(opt.textContent)) throw new Error('建立基準對話框的選單應顯示規則名稱：' + (opt && opt.textContent));
      $('#dlg-input').close(); }
    // 匯出某一份與下載範本：JSON，範本可直接編譯
    const ex = await captureDownloads(() => btnOf(rowsOf('saved').find((r) => r.dataset.profile === fid), 'export').click());
    if (ex.files.length !== 1 || ex.files[0].name !== fid + '.json') throw new Error('匯出的檔名應是 id.json：' + ex.files.map((f) => f.name));
    require('assert').deepStrictEqual(JSON.parse(ex.files[0].text), JSON.parse(floor));
    const tp = await captureDownloads(() => panel().testAll('button').find((b) => b.dataset.action === 'template').click());
    const tj = JSON.parse(tp.files[0].text);
    if (!tp.files[0].name.endsWith('.json') || !S.profile.compile(tj) || typeof tj.description !== 'string') throw new Error('範本應是可編譯、含 description 的 JSON');
    if (!S.profile.compile(tp.files[0].text).name || S.profile.compile(tp.files[0].text).name !== tj.name) throw new Error('範本應有規則名稱（name），經 compile 取得：' + tj.name);
    // 移除：先確認（取消時不變）；確認後從清單與 store 移除
    const asked = []; const c0 = window.confirm;
    try {
      window.confirm = (m) => { asked.push(m); return false; };
      btnOf(rowsOf('saved').find((r) => r.dataset.profile === fid), 'remove').click(); await wait();
      if (asked.length !== 1 || !asked[0].includes(fid) || !S.profiles[fid]) throw new Error('移除前應確認，取消時不變：' + asked);
      window.confirm = (m) => { asked.push(m); return true; };
      btnOf(rowsOf('saved').find((r) => r.dataset.profile === fid), 'remove').click(); await wait();
    } finally { window.confirm = c0; }
    if (S.profiles[fid] || ((await S.store.get('profiles')) || {})[fid] || rowsOf('saved').some((r) => r.dataset.profile === fid)) throw new Error('確認後應從清單與 store 移除');
    // 目前基準正在用的命名規則：確認訊息說明已建立的基準不受影響
    if (App.round.profile) { const m = VP.removeMessage(App, App.round.profile.id); if (!m.includes('已建立的基準不受影響')) throw new Error('移除目前基準用的規則時應說明：' + m); }
    if (VP.removeMessage(App, '__none__').includes('已建立的基準不受影響')) throw new Error('不是目前基準用的規則時不必多說明');
    VP.builtinIds().forEach((id) => { if (!S.profiles[id]) throw new Error('內建的命名規則不應被移除：' + id); });
    S.view.app.closeSettings();
  });
  await step('工作包：下載後讀回，基準、處理紀錄、命名規則與預期現況都帶回；壞掉的工作包列出全部問題，目前的資料不變', async () => {
    const VA = S.view.app; const WP = S.workpack; const HS = () => VA.hubState(); const deep = require('assert').deepStrictEqual;
    // 這一輪：範例資料（或 SMOKE_INPUT）＋命名規則
    const input = process.env.SMOKE_INPUT ? fs.readFileSync(process.env.SMOKE_INPUT, 'utf8') : S.samples['sample-bundle.txt'];
    const pid = Object.keys(S.profiles).find((k) => S.profiles[k] && S.profiles[k].id);
    if (!pid) throw new Error('測試前提：應有內建的命名規則');
    await App.openInput(); $('#input-profile').value = pid; $('#input-text').value = input + '\n# workpack\n'; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input + '\n# workpack\n');
    await until(() => App.snap && App.snap.meta.inputHash === hash && App.round.profile === S.profiles[pid], '建立有命名規則的基準');
    await App.layoutJob; await App.ledgerJob;
    if (!App.snap.meta.profile) throw new Error('測試前提：基準應套用命名規則');
    // 處理紀錄改一筆備註；載入預期資料（比對用）；修正計畫選一項可產生指令的檢查
    const f0 = App.snap.findings.find((f) => VA.ledgerItem(f));
    if ((await App.setLedger(f0, { note: '工作包測試' })).ok !== true) throw new Error('應可寫入處理紀錄');
    App.openHub('inputs');
    const expInput = $('#hub').querySelector('.hub-file-expected');
    expInput.files = [{ name: 'expected-sample.json', text: async () => fs.readFileSync(path.join(ROOT, 'samples/expected-sample.json'), 'utf8') }];
    expInput.dispatch('change', { target: expInput });
    await until(() => App.round.expected && App.round.expected.name === 'expected-sample.json', '載入預期資料');
    App.openPatch();
    if (!$('#hub').classList.contains('hidden') || !S.view.patchView.isOpen(App)) throw new Error('從資料中心開啟修正計畫時應關閉資料中心，修正計畫在中間');
    const auto = $('#patch-body').testAll('.patch-rule').find((c) => c.getAttribute('data-level') === 'auto');
    if (auto) auto.click();
    App.showView('graph');
    App.openHub('outputs');
    const patchBox = $('#hub').testAll('.hub-pack-role').find((x) => x.getAttribute('data-role') === 'patch');
    if (!!auto !== patchBox.checked) throw new Error('修正計畫有選取時 patch 才放進工作包');
    // 下載：按鈕開始後立刻顯示忙碌提示並停用操作，完成後下載一個 ZIP
    const { files } = await captureDownloads(async () => {
      hubBtn('download-workpack').click();
      if (!HS().busy || $('#hub-busy').classList.contains('hidden') || $('#hub').getAttribute('aria-busy') !== 'true') throw new Error('建立工作包時應先顯示忙碌提示');
      if (hubBtn('download-workpack').getAttribute('disabled') === null) throw new Error('進行中應停用下載按鈕');
      await until(() => !HS().busy, '建立工作包');
    });
    if (HS().buildErrors) throw new Error('建立工作包失敗：' + HS().buildErrors.map((e) => e.message).join('；'));
    if (files.length !== 1 || !/^workpack-\d{8}T\d{6}Z-\d+dev\.zip$/.test(files[0].name)) throw new Error('應下載 workpack-<建立時間>-<N>dev.zip：' + files.map((f) => f.name));
    const bytes = new Uint8Array(files[0].bytes);
    const pack = WP.read(bytes);
    const roles = (r) => pack.files.filter((f) => f.role === r);
    deep(pack.snapshot, JSON.parse(JSON.stringify(App.snap)));
    deep(pack.sources, App.round.sources.map((s) => ({ name: s.name, text: s.text })));
    deep(pack.ledger, VA.ledger()); deep(pack.profile, App.round.profile); deep(pack.expected, App.round.expected.data);
    const K = S.view.exporter.KINDS;
    if (roles('report').map((f) => f.name).join() !== [K.csv.name(App.Q), K.markdown.name(App.Q)].join()) throw new Error('報表應依匯出的檔名放進工作包');
    const cur = S.view.patchView.current(App);
    if (roles('patch').map((f) => f.name).join() !== (cur ? cur.list.map((f) => f.name).join() : '')) throw new Error('patch 應是修正計畫選取的 .rsc 與總表');
    if (cur && !roles('patch').every((f, i) => Buffer.from(f.bytes).toString('utf8') === cur.list[i].text)) throw new Error('patch 的內容應和修正計畫下載的相同（S.remediate 產生）');
    const saved = { snap: App.snap, ledger: JSON.parse(JSON.stringify(VA.ledger())), profile: App.round.profile, findings: App.snap.findings.length };

    // 讀入壞掉的工作包：列出全部問題（和核心回報的筆數相同），目前的資料不變
    const readPack = async (name, b) => {
      App.cancelWorkpack();
      const inp = $('#hub').querySelector('.hub-file-workpack');
      inp.files = [{ name, arrayBuffer: async () => b }]; inp.dispatch('change', { target: inp });
      await until(() => !HS().busy && HS().read, '讀入工作包 ' + name);
    };
    const enc = (o) => S.zip.utf8.encode(JSON.stringify(o));
    const crcBad = bytes.slice(); const src0 = S.zip.read(bytes).entries.find((e) => e.path.startsWith('sources/'));
    crcBad[Buffer.from(bytes).indexOf(Buffer.from(src0.bytes.subarray(0, 64))) + 10] ^= 0x20;
    // 收集檔順序不同：兩份收集檔的工作包，manifest 中兩份對調（各自的雜湊仍正確）
    const edge = fs.readFileSync(path.join(ROOT, 'tests/fixtures/firewall/edge-router.txt'), 'utf8');
    const two = [{ name: 'a.txt', text: edge }, { name: 'b.txt', text: edge + '\n# second\n' }];
    const now2 = '2026-01-01T00:00:00Z'; const snap2 = S.build(two, { now: now2 });
    const z2 = S.zip.read(WP.build(two.map((s) => ({ role: 'source', name: s.name, text: s.text })).concat([{ role: 'snapshot', name: 'b.json', text: JSON.stringify(snap2) }]), { now: now2 }));
    const mf = JSON.parse(S.zip.utf8.decode(z2.entries[0].bytes)); const si = mf.files.map((f, i) => [f, i]).filter(([f]) => f.role === 'source').map(([, i]) => i);
    [mf.files[si[0]], mf.files[si[1]]] = [mf.files[si[1]], mf.files[si[0]]];
    const swapped = S.zip.write([{ path: 'manifest.json', bytes: enc(mf) }].concat(z2.entries.slice(1).map((e) => ({ path: e.path, bytes: e.bytes }))));
    for (const [name, bad] of [['truncated.zip', bytes.slice(0, bytes.length - 30)], ['crc.zip', crcBad], ['order.zip', swapped]]) {
      let want = null; try { WP.read(bad); } catch (e) { want = e.errors; }
      if (!want || !want.length) throw new Error(name + '：測試資料應讓 S.workpack.read 失敗');
      const ledgerBefore = JSON.stringify(VA.ledger());
      await readPack(name, bad);
      const box = $('#hub').querySelector('.wp-read-error');
      if (!box || !box.textContent.includes(name) || box.querySelector('.wp-errors').testAll('li').length !== want.length) throw new Error(`${name}：應列出全部 ${want.length} 項問題`);
      if (!want.every((e) => box.textContent.includes(e.message))) throw new Error(name + '：應列出核心的訊息');
      if (App.snap !== saved.snap || JSON.stringify(VA.ledger()) !== ledgerBefore) throw new Error(name + '：讀入失敗時目前的基準與處理紀錄都不可改變');
    }
    const orderText = $('#hub').querySelector('.wp-read-error').textContent;
    if (!orderText.includes('source-mismatch') && !orderText.includes('input-hash')) throw new Error('順序不同時應列出收集檔不符：' + orderText);

    // 換成另一份基準，並讓目前的處理紀錄多出工作包沒有的內容
    await buildInput(edge); await App.ledgerJob;
    await App.setLedger(App.snap.findings.find((f) => VA.ledgerItem(f)), { note: '工作包之後才改的' });
    App.openHub('inputs');
    await readPack(files[0].name, bytes);
    const w = HS().read;
    if (!w.pack || !$('#hub').querySelector('.wp-read-confirm')) throw new Error('讀入成功時應請使用者確認要帶回的內容');
    if (!w.loss || !$('#hub').querySelector('.wp-loss')) throw new Error('目前的處理紀錄有工作包沒有的內容時應明確提示');
    if ($('#hub').querySelector('.wp-profile').value !== 'pack') throw new Error('命名規則預設應用工作包附的');
    // 沒有勾選確認就不取代
    hubBtn('apply-workpack').click(); await new Promise((r) => setTimeout(r, 10));
    if (App.snap.meta.inputHash === saved.snap.meta.inputHash || !$('#hub').textContent.includes('請先勾選確認')) throw new Error('取代處理紀錄前應先確認');
    const ack = $('#hub').testAll('.wp-choose').find((x) => x.getAttribute('data-choose') === 'ack');
    ack.checked = true; ack.dispatch('change');
    // 重建用 validateAsync：每次回報進度時，忙碌提示裡的進度條與文字跟著更新（記下每一次的畫面）
    const seen = []; const origProgress = VA.hubProgress;
    VA.hubProgress = (pr) => { origProgress(pr); const bar = $('#hub-busy').querySelector('.progress');
      seen.push({ stage: pr.stage, text: text('#hub-busy'), now: bar && bar.getAttribute('aria-valuenow'), width: bar && bar.firstElementChild.style.width }); };
    try {
      hubBtn('apply-workpack').click();
      if (!HS().busy || !text('#hub-busy').includes('重建')) throw new Error('重建核對時應顯示忙碌提示');
      await until(() => HS().read && HS().read.done, '帶回工作包');
    } finally { VA.hubProgress = origProgress; }
    if (!seen.length) throw new Error('重建期間應回報進度');
    seen.forEach((x) => {
      if (!x.text.includes('重建') || !x.text.includes(x.stage) || !/^\d+$/.test(x.now || '') || x.width !== x.now + '%') throw new Error('進度應顯示在忙碌提示中（階段、進度條）：' + JSON.stringify(x));
    });
    if (seen.some((x, i) => i && +x.now < +seen[i - 1].now)) throw new Error('進度不應倒退');
    if (!$('#hub-busy').classList.contains('hidden')) throw new Error('完成後應收起忙碌提示');
    await App.ledgerJob; await App.layoutJob;
    // 基準相同（依關係比對）；處理紀錄、命名規則、預期資料都帶回
    if (App.snap.meta.inputHash !== saved.snap.meta.inputHash || App.snap.meta.baselineKey !== saved.snap.meta.baselineKey) throw new Error('讀回的基準應和匯出前相同（inputHash、baselineKey）');
    if (App.snap.findings.length !== saved.findings) throw new Error('讀回的基準的檢查結果筆數應和匯出前相同');
    const qSaved = S.query(saved.snap);
    deep(App.snap.findings.map((f) => App.Q.findingKey(f)), saved.snap.findings.map((f) => qSaved.findingKey(f)));
    deep(VA.ledger(), saved.ledger); deep(await S.store.get('ledger'), saved.ledger);
    deep(App.round.profile, saved.profile); deep(App.round.expected.data, pack.expected);
    deep(App.round.sources, pack.sources);
    const last = await S.store.get('last'); deep(last.profile, saved.profile); deep(last.sources, pack.sources);
    if (!App.round.origin || App.round.origin.kind !== 'workpack') throw new Error('應記下基準來自工作包');
    if (!$('#hub').querySelector('.wp-read-done') || !text('#hub').includes('上一輪的基準')) throw new Error('應列出帶回的內容');
    // 再讀入這一輪的收集檔：自動和工作包的基準比對
    await buildInput(edge + '\n# next\n');
    const st = S.view.baselineDiff.status();
    if (!st || !st.name.includes(files[0].name) || st.report.errors.length) throw new Error('讀入這一輪的收集檔後，應自動以工作包的基準當上一輪比對');
    App.cancelWorkpack(); VA.closeHub();
  });
  await step('深層凍結的基準：選設備、選檢查結果、開詳情、開修正計畫、匯出、建立工作包，都不改寫基準也不因凍結出錯', async () => {
    const VA = S.view.app; const orig = App.snap;
    const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
    const frozen = deepFreeze(JSON.parse(JSON.stringify(orig))); const before = JSON.stringify(frozen);
    // 畫面捕捉的例外（例如匯出失敗）只寫 console.error 與 banner：一併收集，凍結造成的寫入錯誤不會被吞掉
    const errors = []; const origError = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ')); };
    try {
      VA.load(frozen, null); await App.ledgerJob; await App.layoutJob;
      if (App.snap !== frozen) throw new Error('應載入凍結的基準');
      const Q = App.Q;
      Q.devices().slice(0, 50).forEach((d) => App.select({ type: 'device', key: d.key }, { focus: true }));
      const d0 = Q.devices().find((d) => d.collected) || Q.devices()[0];
      App.select({ type: 'device', key: d0.key }, { focus: true });
      if (!text('#detail').includes(d0.name)) throw new Error('凍結的基準也應顯示設備詳情');
      Q.links().slice(0, 50).forEach((l) => App.select({ type: 'link', key: l.key }));
      // 每項檢查至少選一筆（大型資料只取前 200 筆再補上其他檢查的第一筆）
      const idxs = new Set(Q.findings().slice(0, 200).map((f, i) => i));
      S.util.uniq(Q.findings().map((f) => f.id)).forEach((id) => idxs.add(Q.findings().findIndex((f) => f.id === id)));
      idxs.forEach((i) => { App.selectFinding(i); App.graph.draw(); });
      App.select(null); App.graph.draw();
      ['input', 'view', 'triage', 'fix', 'verify'].forEach(goStep);
      goStep('triage');
      $('#pane-findings').querySelector('.open-patch').click();
      if (!S.view.patchView.isOpen(App)) throw new Error('應開啟修正計畫');
      $('#patch-body').testAll('.patch-rule').forEach((c) => c.click());
      // 比對與收斂趨勢的工作畫面也只讀基準
      App.showView('compare'); App.showView('trend');
      App.showView('graph');
      // L2／L3 視圖與 VLAN 篩選也只讀基準（Q 的結果另建畫面自己的節點）
      App.select({ type: 'vlan', key: String(Q.vlanIds()[0]) });
      for (const l of ['l2', 'l3', 'device']) { App.showLayer(l); await App.layerJob; App.graph.draw(); }
      $('#btn-l3-routes').click(); App.showLayer('l3'); await App.layerJob; App.graph.draw(); $('#btn-l3-routes').click();
      const sn = Q.subnetGraph().subnets[0]; if (sn) App.select({ type: 'subnet', key: sn.id });
      App.showLayer('device'); $('#vlan-filter').value = ''; $('#vlan-filter').dispatch('change');
      // L4：矩陣、下鑽、可達性查詢、規則的命中次數與影響（查詢層的推論只在記憶體，不寫回基準）
      App.showLayer('l4'); await App.l4Job;
      const mxF = Q.zoneMatrix(); const cF = mxF.cells.find((c) => c.counts.total);
      if (cF) {
        S.view.l4.openCell(App, cF.src, cF.dst);
        const b = $('#l4-drill').testAll('.l4-svc')[0]; if (b) b.click();
        const rl = $('#l4-drill').testAll('.l4-rule')[0];
        if (rl) { rl.click(); const run = $('#detail').querySelector('.fw-impact-run'); if (run) { run.click(); await App.l4ImpactJob; } }
      }
      L4().testAll('.l4-modes button').forEach((x) => { x.click(); }); // 表格、再回矩陣
      await App.l4Job;
      App.showLayer('device');
      const kinds = Object.keys(S.view.exporter.KINDS);
      const { files } = await captureDownloads(() => { kinds.forEach((k) => App.exportAs(k)); App.exportAs('csv', { byDevice: true }); App.exportAs('markdown', { byDevice: true }); });
      if (files.length !== kinds.length + 2) throw new Error(`每種匯出都應產生下載（${files.length}／${kinds.length + 2}）`);
      require('assert').deepStrictEqual(JSON.parse(files[kinds.indexOf('snapshot')].text), JSON.parse(before));
      // 資料中心的狀態與工作包（基準、報表、patch 都從凍結的基準組出來）
      App.openHub();
      const wp = await captureDownloads(() => App.downloadWorkpack());
      if (wp.files.length !== 1 || VA.hubState().buildErrors) throw new Error('凍結的基準也應能建立工作包：' + JSON.stringify(VA.hubState().buildErrors));
      require('assert').deepStrictEqual(S.workpack.read(new Uint8Array(wp.files[0].bytes)).snapshot, JSON.parse(before));
      VA.closeHub();
      if (JSON.stringify(frozen) !== before) throw new Error('畫面不可改寫基準');
      if (errors.length) throw new Error('凍結的基準不應造成錯誤：\n' + errors.join('\n'));
    } finally {
      console.error = origError;
      VA.load(orig, null); await App.ledgerJob; await App.layoutJob;
    }
  });
  await step('store 的本機資料：描述表涵蓋所有用到的鍵、列舉與大小、更新時間、備份與還原全有或全無、重設偏好不動資料（另以模擬的 IndexedDB 載入 store.js）', async () => {
    // 描述表是鍵的中文名稱與用途的唯一來源：src/view 裡以字面值存取的鍵都要在表裡
    const D = S.store.KEYS; const known = new Set(D.map((d) => d.key));
    const used = new Set(['ledger', 'acks']); // app-ledger.js 以常數存取
    const viewDir = path.join(ROOT, 'src/view');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
    walk(viewDir).forEach((f) => { for (const m of fs.readFileSync(f, 'utf8').matchAll(/S\.store\.(?:get|set|del)\('([^']+)'/g)) used.add(m[1]); });
    const missing = [...used].filter((k) => !known.has(k));
    if (missing.length) throw new Error('store 的 KEYS 沒有描述這些鍵：' + missing.join('、'));
    if (!known.has('theme') || D.some((d) => !d.label || !d.purpose || !d.loss || !['data', 'pref'].includes(d.kind))) throw new Error('每個鍵都要有中文名稱、用途、清除時會失去什麼與種類（data／pref）');
    if (!D.find((d) => d.key === 'ledger').critical) throw new Error('處理紀錄應標為無法重建（critical）');
    if (S.store.sizeOf('中') !== 5 || S.store.sizeOf(undefined) !== 0 || S.store.sizeOf({ a: 1 }) !== 7) throw new Error('sizeOf 是 JSON 序列化後的 UTF-8 位元組');
    // 這個模擬環境沒有 IndexedDB：明確回報只在記憶體
    if ((await S.store.inventory()).storage !== 'memory') throw new Error('沒有 IndexedDB 時 inventory 應回報 storage: memory');

    // 另載一份 store.js，接上模擬的 IndexedDB（交易在全部完成時才寫入；失敗時整筆交易不寫入）與 localStorage
    const data = new Map(); let failKey = null; const gets = [];
    const later = (f) => setTimeout(f, 0);
    const db = { createObjectStore() {}, transaction() {
      const staged = new Map(data); const t = { error: null }; let pending = 0; let failed = false;
      const finish = () => later(() => { if (pending || t.done) return; t.done = true; if (failed) { if (t.onerror) t.onerror(); } else { data.clear(); staged.forEach((v, k) => data.set(k, v)); if (t.oncomplete) t.oncomplete(); } });
      const op = (fn) => { const r = {}; pending++; later(() => { pending--; try { r.result = fn(); if (r.onsuccess) r.onsuccess(); } catch (e) { failed = true; t.error = e; } finish(); }); return r; };
      const store = { get: (k) => { gets.push(k); return op(() => structuredClone(staged.get(k))); }, getAllKeys: () => op(() => [...staged.keys()].sort()), delete: (k) => op(() => { staged.delete(k); }),
        put: (v, k) => op(() => { if (k === failKey) throw new Error('模擬寫入失敗'); staged.set(k, structuredClone(v)); return k; }) };
      t.objectStore = () => store; return t;
    } };
    const fakeIdb = { open: () => { const r = {}; later(() => { r.result = db; if (r.onupgradeneeded) r.onupgradeneeded(); if (r.onsuccess) r.onsuccess(); }); return r; } };
    const ls2 = new Map(); const fakeLs = { getItem: (k) => (ls2.has(k) ? ls2.get(k) : null), setItem: (k, v) => ls2.set(k, String(v)), removeItem: (k) => ls2.delete(k) };
    const sandbox = { indexedDB: fakeIdb, localStorage: fakeLs, console, setTimeout, structuredClone, SSOT: { VERSION: S.VERSION, SCHEMA: S.SCHEMA, ledger: S.ledger, query: S.query } };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/view/store.js'), 'utf8'), sandbox, { filename: 'store.js（模擬 IndexedDB）' });
    const ST = sandbox.SSOT.store; const J = (x) => JSON.stringify(x);
    if (!(await ST.available()) || (await ST.inventory()).storage !== 'indexedDB') throw new Error('有 IndexedDB 時應回報 storage: indexedDB');
    // 既有的 get／set／del 語意不變；keys 只列資料的鍵（store 自己記的更新時間不算）
    const ledger = S.ledger.empty(); const last = { snapshot: { meta: { schema: S.SCHEMA } }, sources: [{ name: 'a.txt', text: '中文' }], profile: null };
    await ST.set('last', last); await ST.set('ledger', ledger); await ST.set('layout', { left: 300, right: 420 }); await ST.set('layoutMode', 'builtin'); ST.theme.set('dark');
    if (J(await ST.get('last')) !== J(last)) throw new Error('get 應讀回 set 的值');
    if (J(await ST.keys()) !== J(['last', 'layout', 'layoutMode', 'ledger'])) throw new Error('keys 只列資料的鍵：' + J(await ST.keys()));
    const inv = await ST.inventory(); const row = (k) => inv.items.find((r) => r.key === k);
    if (inv.items.some((r) => !r.label || !r.purpose)) throw new Error('每一列都要有中文名稱與用途');
    if (!row('last').present || row('last').bytes !== ST.sizeOf(last) || !row('last').updatedAt) throw new Error('有資料的列應有大小與最後更新時間：' + J(row('last')));
    if (row('profiles').present || row('profiles').bytes !== 0) throw new Error('沒有資料的列 present 為 false、大小 0');
    if (!row('theme').present || row('theme').where !== 'localStorage') throw new Error('配色偏好列在 localStorage');
    await ST.set('legacy-x', 1);
    { const r = (await ST.inventory()).items.find((x) => x.key === 'legacy-x'); if (!r || r.kind !== 'other' || !r.present) throw new Error('不認得的鍵也要列出（kind other），使用者才看得到'); }
    await ST.clear('legacy-x'); if ((await ST.keys()).includes('legacy-x')) throw new Error('clear 應刪掉這個鍵');
    // 備份
    const now = '2026-11-06T00:00:00.000Z'; const backup = await ST.exportAll(now);
    if (backup.schema !== 'ssot-localdata/1' || backup.version !== S.VERSION || backup.exportedAt !== now) throw new Error('備份要有 schema、版本與時間：' + J(backup).slice(0, 200));
    if (J(backup.items.last) !== J(last) || backup.items.theme !== 'dark' || backup.items.layoutMode !== 'builtin') throw new Error('備份應包含所有存了的鍵（含配色）');
    // 不合法的備份：列出原因，一筆都不寫
    const snapshotOf = async () => J([...data.entries()].filter(([k]) => !k.startsWith('meta:'))) + J([...ls2.entries()]);
    const before = await snapshotOf();
    const bads = [[null, /物件/], [{ schema: 'ssot-ledger/1', items: {} }, /ssot-localdata\/1/], [{ schema: 'ssot-localdata/1', items: {} }, /沒有/],
      [{ schema: 'ssot-localdata/1', items: { layout: { left: 1 }, ledger: { schema: 'x' } } }, /ledger/], [{ schema: 'ssot-localdata/1', items: { theme: 'sepia', layout: { left: 1 } } }, /theme/],
      [{ schema: 'ssot-localdata/1', items: { nope: 1, layout: { left: 1 } } }, /nope/]];
    for (const [b, re] of bads) {
      const v = ST.validateBackup(b); if (v.ok || !v.errors.some((e) => re.test(e))) throw new Error('不合法的備份應說明原因：' + J(b) + ' → ' + J(v.errors));
      const r = await ST.restore(b); if (r.ok) throw new Error('不合法的備份不可還原');
      if (await snapshotOf() !== before) throw new Error('不合法的備份不可寫入任何資料：' + J(b));
    }
    // 寫入中途失敗：同一筆交易，整份不寫入
    const changed = { schema: 'ssot-localdata/1', items: { layout: { left: 250, right: 380 }, layoutMode: 'elk', ledger } };
    failKey = 'ledger';
    { let err = null; try { await ST.restore(changed); } catch (e) { err = e; } if (!err) throw new Error('寫入失敗時應丟出錯誤');
      if (await snapshotOf() !== before) throw new Error('寫入中途失敗時不可留下部分寫入'); }
    failKey = null;
    // 合法：逐項寫回，回傳覆蓋的鍵
    await ST.del('last'); ST.theme.clear();
    if (ST.theme.get() !== 'system' || ls2.has(ST.theme.KEY)) throw new Error('theme.clear 應刪除偏好、回到跟隨系統');
    const ok = await ST.restore(backup);
    if (!ok.ok || !ok.keys.includes('last') || !ok.keys.includes('theme')) throw new Error('合法的備份應還原：' + J(ok));
    if (J(await ST.get('last')) !== J(last) || ST.theme.get() !== 'dark') throw new Error('還原後應讀回備份的內容');
    // 重設畫面偏好：只清欄寬、版面與配色
    const cleared = await ST.resetPrefs();
    if (J(cleared.slice().sort()) !== J(['layout', 'layoutMode', 'theme'])) throw new Error('resetPrefs 應只清偏好：' + J(cleared));
    if (await ST.get('layout') !== undefined || await ST.get('layoutMode') !== undefined || ST.theme.get() !== 'system') throw new Error('偏好應已清除');
    if (J(await ST.get('last')) !== J(last) || J(await ST.get('ledger')) !== J(ledger)) throw new Error('重設偏好不可動基準與處理紀錄');
    // 「基準與輸入」能不能還原只有一個判斷（ST.lastRestorable，App.restore 也用它）：沒有 meta、格式不相容又沒有輸入時，整份備份都不寫入
    {
      const before2 = await snapshotOf();
      const cant = [[{ snapshot: {} }, /meta/], [{ snapshot: { meta: { schema: 'ssot-snapshot/1' } }, sources: [] }, /不相容/], [{ snapshot: { meta: { schema: 'ssot-snapshot/1' } } }, /不相容/]];
      for (const [lv, re] of cant) {
        const why = ST.lastRestorable(lv); if (why.ok || !re.test(why.reason)) throw new Error('lastRestorable 應說明不能還原的原因：' + J(lv) + ' → ' + J(why));
        const b = { schema: 'ssot-localdata/1', items: { last: lv, layout: { left: 222 } } };
        const v = ST.validateBackup(b); if (v.ok || !v.errors.some((e) => e.includes('基準與輸入') && re.test(e))) throw new Error('備份的基準不能還原時驗證應擋下並說明：' + J(v.errors));
        if ((await ST.restore(b)).ok || await snapshotOf() !== before2) throw new Error('基準不能還原時整份備份都不寫入（全有或全無）：' + J(lv));
      }
      const rebuild = ST.lastRestorable({ snapshot: { meta: { schema: 'ssot-snapshot/1' } }, sources: [{ name: 'a.txt', text: 'x' }] });
      if (!rebuild.ok || !rebuild.rebuild) throw new Error('格式不相容但有輸入時可以還原（用輸入重建）：' + J(rebuild));
      const same = ST.lastRestorable(last); if (!same.ok || same.meta !== last.snapshot.meta) throw new Error('相容的基準可以還原，並回傳 meta：' + J(same));
    }
    // 大小只在資料改變時重算：連續兩次 inventory 不再讀出整份資料；寫入後大小跟著變
    {
      await ST.set('last', last); await ST.inventory(); gets.length = 0;
      const r0 = ST.revision(); const inv2 = await ST.inventory();
      if (gets.includes('last') || gets.includes('ledger')) throw new Error('資料沒變時 inventory 不應再讀出整份資料：' + J(gets));
      if (ST.revision() !== r0) throw new Error('只讀不應改變 revision');
      const bigger = Object.assign({}, last, { sources: [{ name: 'b.txt', text: 'x'.repeat(100) }] });
      await ST.set('last', bigger);
      if (ST.revision() === r0) throw new Error('寫入後 revision 應改變（畫面據此判斷要不要重讀清單）');
      const inv3 = await ST.inventory(); const b2 = inv3.items.find((r) => r.key === 'last').bytes;
      if (b2 !== ST.sizeOf(bigger) || b2 === inv2.items.find((r) => r.key === 'last').bytes) throw new Error('寫入後大小應重算：' + b2);
      await ST.set('last', last);
    }
  });
  await step('設定「本機資料」：每項資料一列（名稱、用途、大小、更新時間）、個別清除先確認（處理紀錄特別警告）、下載全部與從備份還原（不合法時不寫入）、重設畫面偏好不動資料、只在記憶體時說明', async () => {
    const VA = S.view.app; const SD = S.view.settings.data; const J = (x) => JSON.stringify(x);
    const panel = () => $('#settings-panel'); const btn = (key) => panel().testAll('button').find((b) => b.getAttribute('data-store-key') === key && b.classList.contains('settings-clear'));
    const act = (a) => panel().testAll('button').find((b) => b.getAttribute('data-action') === a);
    const ask = async (answer, fn) => { const asked = []; const c0 = window.confirm; window.confirm = (m) => { asked.push(m); return answer; }; try { await fn(); await SD.refresh(); await new Promise((r) => setTimeout(r, 20)); } finally { window.confirm = c0; } return asked; };
    if (!App.snap) throw new Error('前提：有基準');
    App.openSettings('data'); await SD.refresh();
    const t0 = text('#settings-panel');
    { const ts = panel().testAll('table'); const wrapped = panel().testAll('.table-scroll table');
      if (!ts.length || ts.some((t) => !wrapped.includes(t))) throw new Error('本機資料的表格應包在 .table-scroll 內（窄螢幕橫向捲動，不撐寬整頁）'); }
    { const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
      ['settings-data', 'settings-profiles'].forEach((c) => { if (!new RegExp('\\.' + c + ' \\{[^}]*min-width:\\s*\\d+px').test(css)) throw new Error(`.${c} 應有最小寬度（窄螢幕在 .table-scroll 內橫捲，不擠成一字一行）`); }); }
    const present = S.store.KEYS.filter((d) => d.key === 'last' || d.key === 'ledger');
    if (present.some((d) => !t0.includes(d.label) || !t0.includes(d.purpose))) throw new Error('每一項資料都要列出中文名稱與用途：' + t0.slice(0, 300));
    if (!/\d+(\.\d)? (B|KB|MB)/.test(t0)) throw new Error('應顯示大小（B／KB／MB）');
    if (!t0.includes('只在記憶體')) throw new Error('沒有 IndexedDB 時應明確說明資料只在記憶體');
    // 每列的清除都是按鈕，可用鍵盤操作；處理紀錄的清除要特別警告，取消時什麼都不變
    const ledgerBefore = J(await S.store.get('ledger'));
    const asked = await ask(false, () => btn('ledger').click());
    if (asked.length !== 1 || !/無法從收集檔重建/.test(asked[0]) || !/備份/.test(asked[0])) throw new Error('清除處理紀錄應警告無法重建並建議先備份：' + asked[0]);
    if (J(await S.store.get('ledger')) !== ledgerBefore) throw new Error('取消時不可清除');
    // 下載全部（JSON）
    const dl = await captureDownloads(() => act('localdata-export').click());
    const file = dl.files[0]; const backup = file && JSON.parse(file.text);
    if (!backup || backup.schema !== 'ssot-localdata/1' || !/\.json$/.test(file.name) || J(backup.items.ledger) !== ledgerBefore || !backup.items.last) throw new Error('下載全部應是含基準與處理紀錄的 ssot-localdata/1：' + (file && file.name));
    // 清除處理紀錄（確認）：畫面與 store 的處理紀錄都沒有原本的項目
    const byUser = (lg) => Object.values((lg && lg.items) || {}).some((it) => it.history.some((x) => x.by === 'user'));
    if (!byUser(VA.ledger())) throw new Error('前提：處理紀錄有使用者的判斷');
    await ask(true, () => btn('ledger').click());
    if (byUser(VA.ledger()) || byUser(await S.store.get('ledger'))) throw new Error('確認後應清除處理紀錄（畫面與 store 都沒有使用者的判斷）');
    if (!App.snap) throw new Error('清除處理紀錄不可動基準');
    // 從備份還原：不合法時列出原因、不寫入；合法時列出將覆蓋的項目並確認
    const restoreFile = async (name, body, answer) => ask(answer, async () => {
      const inp = panel().querySelector('input'); inp.files = [{ name, text: async () => body }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 30));
    });
    const mid = J(await S.store.get('ledger'));
    for (const [name, body] of [['壞.json', '{不是 JSON'], ['錯.json', J({ schema: 'ssot-ledger/1', items: {} })], ['缺.json', J({ schema: 'ssot-localdata/1', items: { ledger: { schema: 'x' } } })]]) {
      const q = await restoreFile(name, body, true);
      if (q.length) throw new Error('不合法的備份不應詢問：' + name);
      if (!text('#settings-panel').includes(name) || !text('#settings-panel').includes('沒有寫入任何資料')) throw new Error('不合法的備份應說明原因且沒有寫入：' + name);
      if (J(await S.store.get('ledger')) !== mid) throw new Error('不合法的備份不可寫入：' + name);
    }
    { const q = await restoreFile('備份.json', file.text, false);
      if (q.length !== 1 || !q[0].includes('處理紀錄') || !q[0].includes('基準與輸入')) throw new Error('還原前應列出將覆蓋的項目：' + q[0]);
      if (J(await S.store.get('ledger')) !== mid) throw new Error('取消還原時不可寫入'); }
    await restoreFile('備份.json', file.text, true); await App.ledgerJob;
    const back = await S.store.get('ledger');
    if (Object.keys(JSON.parse(ledgerBefore).items).some((k) => !back.items[k] || !VA.ledger().items[k])) throw new Error('還原後處理紀錄應回到備份的內容');
    if (!App.snap) throw new Error('還原後應有基準');
    // 重設畫面偏好：只清欄寬、版面與配色，基準與處理紀錄不動
    const mode0 = App.layoutMode; VA.setLayoutMode(App.LAYOUT_MODES.find((m) => m !== mode0)); VA.setThemePref('dark');
    const keep = J([await S.store.get('last'), await S.store.get('ledger'), await S.store.get('profiles')]);
    const cols = () => [App.layout.left, App.layout.right]; const def = () => [VA.COLUMN_DEFAULT.left, VA.COLUMN_DEFAULT.right];
    const gridOk = () => $('#main').style.gridTemplateColumns.endsWith(App.layout.right + 'px');
    if (typeof VA.resetColumns !== 'function' || !VA.COLUMN_DEFAULT) throw new Error('app-panes 應提供 A.resetColumns 與 A.COLUMN_DEFAULT');
    App.layout.left = VA.COLUMN_DEFAULT.left + 17; App.layout.right = VA.COLUMN_DEFAULT.right + 23; VA.applyColumns();
    const q = await ask(true, () => act('localdata-reset-prefs').click());
    if (J(cols()) !== J(def()) || !gridOk()) throw new Error('重設畫面偏好後欄寬應馬上回到預設：' + J(cols()) + ' ' + $('#main').style.gridTemplateColumns);
    if (/下次開啟|重新開啟/.test(text('#banner'))) throw new Error('欄寬即時生效，banner 不應說下次開啟才生效：' + text('#banner'));
    if (q.length !== 1 || !/處理紀錄/.test(q[0]) || !/不受影響/.test(q[0])) throw new Error('重設偏好應先確認並說明不影響資料：' + q[0]);
    if (await S.store.get('layoutMode') !== undefined || await S.store.get('layout') !== undefined || S.store.theme.get() !== 'system' || VA.themePref() !== 'system') throw new Error('重設偏好應清除版面、欄寬與配色');
    if (App.layoutMode !== mode0) throw new Error('重設後的版面應回到預設：' + App.layoutMode);
    if (J([await S.store.get('last'), await S.store.get('ledger'), await S.store.get('profiles')]) !== keep) throw new Error('重設偏好不可動基準、處理紀錄與命名規則');
    // 偏好的個別清除也先確認並說明會失去什麼
    await S.store.set('layout', { left: 300, right: 400 }); await SD.refresh();
    App.layout.left = VA.COLUMN_DEFAULT.left + 11; VA.applyColumns();
    { const q2 = await ask(true, () => btn('layout').click()); const d = S.store.KEYS.find((x) => x.key === 'layout');
      if (q2.length !== 1 || !q2[0].includes(d.loss) || await S.store.get('layout') !== undefined) throw new Error('個別清除應先確認並寫出會失去什麼');
      if (J(cols()) !== J(def()) || !gridOk()) throw new Error('清除欄寬後應馬上回到預設寬度：' + J(cols())); }
    VA.closeSettings();
  });
  await step('本機資料的清除與還原讓畫面跟上：基準不能還原時不寫入、重建失敗時以 banner 說明並收起舊基準；清除舊確認標記不再轉換；命名規則即時更新；清單一次重繪只讀一次', async () => {
    const VA = S.view.app; const SD = S.view.settings.data; const VP = S.view.settings.profiles; const J = (x) => JSON.stringify(x);
    const wait = () => new Promise((r) => setTimeout(r, 30));
    const withConfirm = async (fn) => { const c0 = window.confirm; window.confirm = () => true; try { return await fn(); } finally { window.confirm = c0; } };
    const restore = (name, obj) => withConfirm(() => SD.restoreText(App, name, J(obj)));
    if (!App.snap) throw new Error('前提：有基準');
    const snap0 = App.snap; const last0 = J(await S.store.get('last')); const layout0 = J(await S.store.get('layout'));
    // 1. 基準不能還原（沒有 meta）：驗證擋下，整份不寫入，畫面仍是原本的基準
    App.openSettings('data'); await SD.refresh();
    if (await restore('壞基準.json', { schema: 'ssot-localdata/1', items: { last: { snapshot: {} }, layout: { left: 260, right: 380 } } })) throw new Error('基準不能還原的備份不應還原');
    if (J(await S.store.get('last')) !== last0 || J(await S.store.get('layout')) !== layout0 || App.snap !== snap0) throw new Error('基準不能還原時整份不寫入，畫面不變');
    if (!text('#settings-panel').includes('沒有寫入任何資料') || !text('#settings-panel').includes('基準與輸入')) throw new Error('應說明基準與輸入不能還原：' + text('#settings-panel').slice(0, 300));
    // 用輸入重建失敗：banner 明確說明，不可說「已還原」卻留著舊基準；之後的 savePositions 不寫進這份資料
    const oldLast = { snapshot: { meta: { schema: 'ssot-snapshot/1', version: '0.0.1', createdAt: '2026-01-01T00:00:00Z' } }, sources: [{ name: 'x.txt', text: 'x' }], profile: null };
    const b0 = S.buildAsync; S.buildAsync = async () => { throw new Error('模擬重建失敗'); };
    try { await restore('舊基準.json', { schema: 'ssot-localdata/1', items: { last: oldLast } }); } finally { S.buildAsync = b0; }
    if (App.snap === snap0) throw new Error('基準無法載入時不可留著舊基準');
    if (!/無法載入|不相容/.test(text('#banner')) || !text('#banner').includes('模擬重建失敗')) throw new Error('基準無法載入時應以 banner 說明原因：' + text('#banner'));
    await VA.savePositions();
    if (J(await S.store.get('last')) !== J(oldLast)) throw new Error('savePositions 不可寫進無法載入的基準');
    await S.store.set('last', JSON.parse(last0)); await App.restore(); await App.ledgerJob;
    if (!App.snap) throw new Error('前提：還原原本的基準');
    // 2. 清除「舊版的確認標記」：記憶體中等待轉換的也一起清掉，下一份基準不再轉換
    const ledger0 = await S.store.get('ledger'); const fk = App.Q.findingKey(App.Q.findings()[0]);
    try {
      await S.store.del('ledger'); await S.store.set('acks', { [fk]: { at: '2025-01-02T00:00:00.000Z', kind: 'scheduled', note: '舊的' } });
      await VA.loadLedger(); if (!VA.ledgerState().pendingAcks) throw new Error('前提：有等待轉換的舊確認標記');
      App.openSettings('data'); await SD.refresh();
      const btn = $('#settings-panel').testAll('button').find((b) => b.getAttribute('data-store-key') === 'acks' && b.classList.contains('settings-clear'));
      await withConfirm(async () => { btn.click(); await wait(); });
      if (VA.ledgerState().pendingAcks || VA.ledgerState().acksToDelete) throw new Error('清除舊確認標記後，記憶體中等待轉換的也要清掉');
      await VA.advanceLedger(App.Q);
      const lg = await S.store.get('ledger');
      if (lg && lg.items[fk] && lg.items[fk].history.some((x) => x.by === 'user')) throw new Error('清除的舊確認標記不可在下一份基準被轉換回來');
      // 還原含 acks 的備份（沒有處理紀錄時）：和啟動時一樣等第一份基準再轉換
      await S.store.del('ledger');
      await restore('acks.json', { schema: 'ssot-localdata/1', items: { acks: { [fk]: { at: '2025-01-02T00:00:00.000Z' } } } });
      if (!VA.ledgerState().pendingAcks && !(VA.ledger().items[fk] && VA.ledger().items[fk].history.length)) throw new Error('還原舊確認標記後應等待或完成轉換');
    } finally { await S.store.del('acks'); await S.store.set('ledger', ledger0); await VA.loadLedger(); }
    // 3. 命名規則：還原與清除後 S.profiles、命名規則分類與建立基準對話框都即時更新
    const builtinId = VP.builtinIds()[0]; const builtin = S.profiles[builtinId]; // 內容與內建的相同即可（之前的步驟可能載入過同 id 的複本）
    const mine = { schema: 'ssot-profile/1', id: 'restored-naming', version: '1', label: '還原的', classify: [] };
    const over = Object.assign({}, builtin, { label: '蓋過內建' });
    App.openSettings('profiles'); await wait(); // 已合併過一次
    await restore('profiles.json', { schema: 'ssot-localdata/1', items: { profiles: { [mine.id]: mine, [builtinId]: over } } });
    if (!S.profiles[mine.id] || S.profiles[builtinId].label !== '蓋過內建') throw new Error('還原命名規則後 S.profiles 應即時更新');
    App.openSettings('profiles'); await wait();
    const rowIds = (src) => { const t = $('#settings-panel').testAll('table').find((x) => x.dataset.source === src); return t ? t.testAll('tr').filter((r) => r.dataset.profile).map((r) => r.dataset.profile) : []; };
    if (!rowIds('saved').includes(mine.id)) throw new Error('還原後命名規則分類應列出備份裡的規則：' + rowIds('saved'));
    App.openSettings('data'); await SD.refresh();
    const pbtn = $('#settings-panel').testAll('button').find((b) => b.getAttribute('data-store-key') === 'profiles' && b.classList.contains('settings-clear'));
    await withConfirm(async () => { pbtn.click(); await wait(); });
    if (S.profiles[mine.id] || !S.profiles[builtinId] || S.profiles[builtinId].label === '蓋過內建') throw new Error('清除命名規則後應從 S.profiles 移除，內建的恢復');
    App.openSettings('profiles'); await wait();
    if (!rowIds('builtin').includes(builtinId) || rowIds('saved').length) throw new Error('清除後命名規則分類應只剩內建的：' + rowIds('saved'));
    VA.closeSettings(); await App.openInput();
    const opts = $('#input-profile').testAll('option').map((o) => o.getAttribute('value'));
    $('#dlg-input').close();
    if (opts.includes(mine.id) || !opts.includes(builtinId)) throw new Error('建立基準對話框的清單應跟著更新：' + opts);
    // 文件連結與說明頁同一個做法（V.settings.docLink，連到 GitHub 上的 main）
    App.openSettings('profiles'); await wait();
    const dl = $('#settings-panel').testAll('a').find((a) => a.classList.contains('doc-link') && decodeURI(a.getAttribute('href')).endsWith('/blob/main/docs/命名規則.md'));
    if (!dl) throw new Error('命名規則分類的文件連結應以 V.settings.docLink 產生（doc-link）');
    // 5. 清單：一次重繪只讀一次 inventory；資料沒變時不重讀
    App.openSettings('data'); await SD.refresh(); await wait();
    const inv0 = S.store.inventory; let calls = 0; S.store.inventory = (...a) => { calls++; return inv0.apply(S.store, a); };
    try {
      VA.renderSettings(); await SD.refresh(); await wait();
      if (calls > 0) throw new Error('資料沒變時重繪不應重讀清單：' + calls);
      await S.store.set('layout', { left: 301, right: 401 }); VA.renderSettings(); await SD.refresh(); await wait();
      if (calls !== 1) throw new Error('資料改變後重繪應只讀一次清單：' + calls);
      if (!text('#settings-panel').includes('欄寬')) throw new Error('清單應照常顯示');
    } finally { S.store.inventory = inv0; await S.store.set('layout', JSON.parse(layout0 || 'null') || { left: 330, right: 400 }); }
    VA.closeSettings();
  });
  await step('清除基準（處理紀錄不受影響）；沒有基準時「修正」、「驗證」停用，中間只有拓樸圖（歡迎畫面）', async () => {
    App.showView('patch');
    // 入口在設定「本機資料」，先確認：取消時什麼都不清
    { const asked = []; const c0 = window.confirm; window.confirm = (m) => { asked.push(m); return false; };
      try { App.openSettings('data'); $('#btn-clear').click(); await new Promise((r) => setTimeout(r, 20)); } finally { window.confirm = c0; }
      if (asked.length !== 1 || !/清除/.test(asked[0]) || !App.snap) throw new Error('「清除基準…」應先確認，取消時不清除');
      if (!$('#btn-clear').classList.contains('danger')) throw new Error('「清除基準…」應以 .danger 標示');
      S.view.app.closeSettings(); }
    await clearBaseline(); if (App.snap) throw new Error('未清除');
    App.openSettings('data');
    if ($('#btn-clear').getAttribute('disabled') === null ||!text('#settings-panel').includes('目前沒有基準')) throw new Error('沒有基準時「清除基準…」應停用並說明');
    S.view.app.closeSettings();
    if (App.step !== 'triage' || App.centerView !== 'graph' || !$('#view-patch').classList.contains('hidden') || $('#view-graph').inert) throw new Error('清除基準後應回到「研判」的拓樸圖');
    if (!['fix', 'verify'].every((s) => stepBtn(s).getAttribute('aria-disabled') === 'true') || ['input', 'view', 'triage'].some((s) => stepBtn(s).getAttribute('aria-disabled') !== 'false')) throw new Error('沒有基準時只有「修正」、「驗證」停用（aria-disabled，仍可聚焦）');
    if (!stepBtn('input').textContent.includes('未載入') || !stepBtn('fix').textContent.includes('建立基準後')) throw new Error('沒有基準時步驟的狀態應說明：' + text('#steps'));
    // 窄螢幕的五格等寬：停用步驟的狀態用短字，完整說法在 title（UX #4）
    window.innerWidth = 390; S.view.app.renderSteps();
    try {
      const fixSt = stepBtn('fix').querySelector('.step-st').textContent;
      if (fixSt.length > 3 || !stepBtn('fix').getAttribute('title').includes('建立基準後才能使用')) throw new Error('窄螢幕停用步驟的狀態應是短字、完整說法在 title：' + fixSt);
    } finally { window.innerWidth = 1200; S.view.app.renderSteps(); }
    goStep('verify'); if (App.step !== 'triage' || !text('#banner').includes('建立基準後')) throw new Error('停用的步驟按了不切換，並說明原因');
    App.showView('trend'); if (App.centerView !== 'graph' || App.step !== 'triage') throw new Error('沒有基準時不能切到其他工作畫面');
    goStep('view'); if (App.step !== 'view' || !text('#pane-inventory').includes('建立基準後')) throw new Error('沒有基準時「檢視」仍可開啟並說明');
    goStep('triage');
    const lg = await S.store.get('ledger');
    if (!lg || (shared.ackedKey && !lg.items[shared.ackedKey])) throw new Error('清除基準不應清掉處理紀錄');
  });
  await step('還原舊 schema 的基準：有儲存輸入時重建，沒有時明確告知', async () => {
    const sources = [{ name: 'sample-bundle.txt', text: S.samples['sample-bundle.txt'] }];
    const old = { meta: { schema: 'ssot-snapshot/1', version: '1.3.2', createdAt: '2026-01-01T00:00:00Z' }, model: {} };
    await S.store.set('last', { snapshot: old, sources, profile: null });
    await App.restore();
    if (!App.snap || App.snap.meta.schema !== S.SCHEMA) throw new Error('舊 schema 應以儲存的輸入重建');
    await clearBaseline();
    await S.store.set('last', { snapshot: old, sources: [], profile: null });
    await App.restore();
    if (App.snap) throw new Error('沒有輸入時不應載入不相容的基準');
    if (!document.body.textContent.includes('已不相容')) throw new Error('應提示上次的基準格式不相容');
    await clearBaseline();
  });
};
