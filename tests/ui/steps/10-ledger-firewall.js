// 畫面冒煙測試的 step：處理紀錄、依設備分組、防火牆畫面與修正、devices.csv 草稿。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { document, S, fs, path, ROOT, step, captureDownloads, parseCsv, hubBtn, goStep, until, $, text, shared } = require('../helpers.js');

module.exports = async () => {
  shared.ackedKey = null; // 處理紀錄中已處理的 finding 鍵：清除基準後要仍然存在
  await step('處理紀錄取代確認：每筆檢查結果都在處理紀錄中，可變更狀態與備註，不合法的變更顯示錯誤，已處理另列分組並從摘要排除，匯出對應欄位', async () => {
    const Q = App.Q; const all = App.snap.findings; const VA = S.view.app; const RV = S.view.remediation; const LG = S.ledger;
    if (all.some((f) => !VA.ledgerItem(f))) throw new Error('建立基準後每筆檢查結果都應在處理紀錄中（advance）');
    if (VA.ledgerRoundIndex() < 0) throw new Error('處理紀錄應有這份基準的一輪');
    const saved0 = await S.store.get('ledger');
    if (!saved0 || !LG.validate(saved0).ok) throw new Error('處理紀錄應存進 store 的 ledger 且格式正確');
    const problems = () => all.filter((f) => f.severity !== 'info' && VA.isPending(f));
    const before = problems();
    if (!before.length) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有錯誤或警告'); }
    const f = before[0]; const key = Q.findingKey(f);
    goStep('triage');
    const group = (id) => document.testAll('#pane-findings .fgroup').find((x) => {
      const el = x.querySelector('.head .id'); return el && el.textContent === id && !x.className.includes('handled');
    });
    const editBtn = (x) => document.testAll('#pane-findings .ledger-edit').find((b) => b.getAttribute('aria-label') === '處理狀態：' + x.message);
    const editor = () => $('#pane-findings').querySelector('.ledger-editor');
    const errText = () => { const e = editor() && editor().querySelector('.ledger-error'); return e && !e.classList.contains('hidden') ? e.textContent : ''; };
    const fill = async (status, o) => {
      const ed = editor(); if (!ed) throw new Error('按「處理」後應出現狀態欄位');
      ed.querySelector('select').value = status;
      const set = (cls, v) => { if (v !== undefined) ed.testAll('input').find((i) => i.className.includes(cls)).value = v; };
      set('ledger-note', o.note); set('ledger-waiver-reason', o.reason); set('ledger-waiver-until', o.until);
      ed.testAll('button').find((b) => b.getAttribute('aria-label') === '儲存處理狀態：' + f.message).click();
      await new Promise((r) => setTimeout(r, 10));
    };
    if (!editBtn(f)) group(f.id).querySelector('.head').click();
    // 「處理狀態」按鈕在訊息下方（不和訊息擠同一列），字和上方的「處理：…」提示區分（UX #8）
    if (editBtn(f).textContent !== '處理狀態' || $('#pane-findings').testAll('.fitem-row').some((r) => r.querySelector('.ledger-edit'))) throw new Error('「處理狀態」按鈕應在訊息下方、不在訊息那一列');
    if (editBtn(f).getAttribute('aria-expanded') !== 'false') throw new Error('「處理狀態」按鈕以 aria-expanded 標出編輯欄位是否展開');
    const snapBefore = JSON.stringify(App.snap);
    editBtn(f).click();
    const opts = editor().querySelector('select').testAll('option').map((o) => o.getAttribute('value'));
    const it0 = VA.ledgerItem(f);
    if (opts.join() !== [it0.status].concat(LG.USER_TO[it0.status]).join()) throw new Error('可選的狀態應是目前狀態加上 USER_TO：' + opts);
    editor().testAll('button').find((b) => b.textContent === '取消').click();
    if (editor()) throw new Error('按「取消」應關閉欄位');
    // 不合法：仍出現在最新一輪的項目不能手動標為 fixed；核心的錯誤要顯示，處理紀錄不變
    editBtn(f).click();
    const ledgerBefore = JSON.stringify(VA.ledger());
    await fill('fixed', { note: '' });
    if (!errText().includes('不能手動標為 fixed')) throw new Error('S.ledger.set 的錯誤應顯示在欄位下方：' + errText());
    if (JSON.stringify(VA.ledger()) !== ledgerBefore || VA.ledgerStatus(f) !== it0.status) throw new Error('不合法的變更不可改動處理紀錄');
    // 接受風險沒有原因：畫面要求填寫
    await fill('accepted', { reason: '  ' });
    if (!errText().includes('原因')) throw new Error('接受風險沒有原因時應提示');
    // 接受風險：原因與預設到期日（WAIVER_DAYS 天後）
    const reason1 = '設計如此, 見 "變更單" 123';
    await fill('accepted', { reason: reason1, note: '備註一' });
    if (editor()) throw new Error('儲存成功後應關閉欄位');
    const it1 = VA.ledgerItem(f);
    if (it1.status !== 'accepted' || it1.waiver.reason !== reason1 || it1.note !== '備註一') throw new Error('應設為接受風險並記下原因與備註：' + JSON.stringify(it1));
    const days = (Date.parse(it1.waiver.until) - Date.now()) / 86400000;
    if (days < LG.WAIVER_DAYS - 2 || days > LG.WAIVER_DAYS + 1) throw new Error('豁免到期日預設應約 WAIVER_DAYS 天後：' + it1.waiver.until);
    if (JSON.stringify(App.snap) !== snapBefore) throw new Error('處理紀錄不可改寫基準');
    let saved = await S.store.get('ledger'); shared.ackedKey = key;
    if (!saved.items[key] || saved.items[key].status !== 'accepted') throw new Error('變更應存進 store 的 ledger');
    // 已處理分組：依狀態，預設收合
    const handled = (s) => document.testAll('#pane-findings .fgroup').find((x) => x.className.includes('handled') && x.getAttribute('data-status') === s);
    if (!handled('accepted')) throw new Error('應有「接受風險」的已處理分組');
    if (handled('accepted').testAll('.fitem').length) throw new Error('已處理分組預設應收合');
    handled('accepted').querySelector('.head').click();
    const gt = handled('accepted').textContent;
    if (!gt.includes(f.message) || !gt.includes('豁免原因：' + reason1) || !gt.includes('備註：備註一')) throw new Error('已處理的項目應顯示原因與備註');
    // 摘要：排除已處理並註明
    const prevSel = App.sel; App.select(null);
    const left = problems(); const summary = $('#detail').querySelector('.status-line').textContent; App.select(prevSel);
    if (left.length !== before.length - 1) throw new Error('處理一筆後，待處理的問題應少一筆');
    const nHandled = all.filter((x) => x.severity !== 'info' && !VA.isPending(x)).length;
    if (!summary.includes(`另有 ${nHandled} 項已處理`)) throw new Error('基準狀態應註明已處理筆數：' + summary);
    // 改為誤報：備註以公式開頭，CSV 要防公式注入；檢查品質列出這項檢查
    document.testAll('#pane-findings .ledger-edit').find((b) => b.getAttribute('aria-label') === '處理狀態：' + f.message).click();
    const note2 = '=SUM(A1) 是誤判';
    await fill('false-positive', { note: note2 });
    const it2 = VA.ledgerItem(f);
    if (it2.status !== 'false-positive' || it2.waiver !== null || it2.note !== note2) throw new Error('應改為誤報、移除豁免：' + JSON.stringify(it2));
    if (it2.history[it2.history.length - 1].waiver.reason !== reason1) throw new Error('被移除的豁免應記在歷程');
    App.selectFinding(all.indexOf(f));
    if (text('#detail').includes(f.message) && !text('#detail').includes(RV.statusText('false-positive'))) throw new Error('詳情的檢查結果應標出處理狀態');
    goStep('triage');
    const fp = document.testAll('#pane-findings .fgroup').find((x) => x.className.includes('fp-rules'));
    if (!fp) throw new Error('有誤報時應列出誤報率最高的檢查');
    fp.querySelector('.head').click();
    const fpRow = document.testAll('#pane-findings .fp-rules .rule').find((r) => r.getAttribute('data-rule-id') === f.id);
    const st = LG.ruleStats(VA.ledger()).find((r) => r.id === f.id);
    if (!fpRow || !fpRow.textContent.includes(`誤報 ${st.falsePositive} / ${st.total}`)) throw new Error('誤報率應與 S.ledger.ruleStats 一致');
    // 匯出：舊欄位由處理紀錄對應；Markdown 標示狀態
    const X = S.view.exporter; const opts2 = { ledgerOf: VA.ledgerExport };
    const rows = parseCsv(X.findingsCsv(App.Q, opts2).replace(/^﻿/, ''));
    const row = rows[all.indexOf(f) + 1]; const userAt = VA.ledgerUserAt(it2);
    // 畫面的對應與核心（CLI 也用）是同一份：userAt 是同一個函式，ledgerExport 與 S.report.ledgerOfItems 逐筆相同
    if (VA.ledgerUserAt !== S.report.userAt) throw new Error('A.ledgerUserAt 應直接引用 S.report.userAt');
    const coreOf = S.report.ledgerOfItems(VA.ledger(), App.Q);
    if (!all.every((x) => JSON.stringify(VA.ledgerExport(x)) === JSON.stringify(coreOf(x)))) throw new Error('A.ledgerExport 應與 S.report.ledgerOfItems 逐筆相同');
    if (!all.some((x) => VA.ledgerExport(x))) throw new Error('改過處理狀態後應有處理紀錄可匯出');
    if (row[6] !== userAt || row[7] !== 'false-positive' || row[8] !== "'" + note2 || row[11] !== 'false-positive' || row[12] !== "'" + note2) throw new Error('CSV 的處理紀錄欄位不符：' + row);
    if (all.filter((x) => VA.isPending(x)).some((x) => rows[all.indexOf(x) + 1][6] !== '' || rows[all.indexOf(x) + 1][7] !== '')) throw new Error('待處理的列 acknowledged／ack_kind 應為空白');
    const md = X.findingsMarkdown(App.Q, opts2);
    if (!md.includes(`**${RV.statusText('false-positive')}**（${userAt}）`) || !md.includes('備註：') || !md.includes('- 處理紀錄：')) throw new Error('Markdown 應標示處理狀態與備註');
    // 改回待處理：回到原本的分組
    document.testAll('#pane-findings .fgroup').filter((x) => x.className.includes('handled') && !x.testAll('.fitem').length).forEach((g) => g.querySelector('.head').click());
    document.testAll('#pane-findings .ledger-edit').find((b) => b.getAttribute('aria-label') === '處理狀態：' + f.message).click();
    await fill('open', { note: '' });
    if (VA.ledgerStatus(f) !== 'open' || problems().length !== before.length) throw new Error('改回待處理後應算回待處理的問題');
  });
  await step('檢查結果依設備分組：依第一個設備實體或實體所屬設備，不屬於任何設備的另一組；匯出可依設備排序', async () => {
    const Q = App.Q; const all = App.snap.findings; const R = Object.assign({}, S.view.remediation, { findingDevice: (q, f) => q.findingDevice(f) }); const K = S.keys;
    // 歸屬規則：有 device 實體時是第一個；否則是某個實體所屬的設備；都對不到時為 null
    const owns = (d, e) => (e.type === 'interface' && K.splitEp(e.key)[0] === d) || (e.type === 'link' && String(e.key).split('~').some((ep) => K.splitEp(ep)[0] === d))
      || (e.type === 'rule' && (Q.getFirewallRule(e.key) || {}).dev === d) || (e.type === 'service' && K.splitEp(e.key)[0] === d)
      || (e.type === 'ip' && !!Q.ipOwner(e.key) && K.splitEp(Q.ipOwner(e.key))[0] === d);
    all.forEach((f) => {
      const d = R.findingDevice(Q, f); const first = f.entities.find((e) => e.type === 'device' && Q.getDevice(e.key));
      if (first && d !== Q.getDevice(first.key).key) throw new Error(`${f.id} 有設備實體時應歸到第一個設備`);
      if (!first && d !== null && !f.entities.some((e) => owns(d, e))) throw new Error(`${f.id} 應歸到實體所屬的設備`);
      if (!first && d === null && Q.devices().some((x) => f.entities.some((e) => owns(x.key, e)))) throw new Error(`${f.id} 的實體屬於某台設備，不應列為不屬於任何設備`);
    });
    if (R.findingDevice(Q, { entities: [] }) !== null || R.findingDevice(Q, { entities: [{ type: 'mac', key: '000000000000' }] }) !== null) throw new Error('沒有實體或只有 MAC 的檢查結果不屬於任何設備');
    goStep('triage');
    // 打開全部嚴重度，再切到依設備
    for (let n = 0; n < 3; n++) {
      const off = $('#pane-findings').querySelector('.summary').testAll('.chip').find((c) => c.getAttribute('aria-pressed') === 'false' && c.getAttribute('aria-disabled') !== 'true');
      if (off) off.click();
    }
    const seg = (k) => $('#pane-findings').testAll('button').find((b) => b.getAttribute('data-group-by') === k);
    seg('device').click();
    if (seg('device').getAttribute('aria-pressed') !== 'true') throw new Error('「依設備」應標示為選取');
    const groups = () => $('#pane-findings').testAll('.fgroup').filter((g) => g.className.split(' ').includes('by-device'));
    const want = new Map();
    R.sortByDevice(Q, all).forEach((r) => { if (S.view.app.isPending(r.f)) S.util.getOr(want, r.dev, () => []).push(r.idx); });
    const keys = Array.from(want.keys());
    const gs = groups();
    if (gs.length !== want.size) throw new Error(`依設備的分組數應等於設備數：${gs.length} / ${want.size}`);
    gs.forEach((g, n) => {
      const name = keys[n] === null ? '不屬於任何設備' : Q.devLabel(keys[n]); // 畫面用 Q.devLabel（匯出仍用 devName）
      if (g.querySelector('.head .title').textContent !== name) throw new Error('分組應依設備名稱排列：' + g.querySelector('.head .title').textContent);
      const chips = g.querySelector('.head').testAll('.chip');
      if (chips[chips.length - 1].textContent !== String(want.get(keys[n]).length)) throw new Error(`${name} 的筆數不符`);
    });
    if (want.has(null) && !gs[gs.length - 1].className.includes('no-device')) throw new Error('不屬於任何設備的應在最後一組');
    if (!process.env.SMOKE_INPUT && !want.has(null)) throw new Error('範例資料應有不屬於任何設備的檢查結果（例如 A01）');
    // 展開一組：每筆標出檢查代碼，且都屬於這台設備
    gs[0].querySelector('.head').click();
    const items = groups()[0].testAll('.fitem');
    if (items.length !== Math.min(100, want.get(keys[0]).length)) throw new Error('展開後應列出這台設備的檢查結果');
    items.forEach((it, n) => {
      const f = all[want.get(keys[0])[n]];
      if (!it.querySelector('.id') || it.querySelector('.id').textContent.trim() !== f.id || !it.textContent.includes(f.message)) throw new Error('依設備分組時每筆應標出檢查代碼與訊息');
    });
    groups()[0].querySelector('.head').click();
    // 匯出：可選依設備排序；CSV 的 device 欄依分組順序，Markdown 依設備分組
    // 報表的匯出在資料中心（檢查結果分頁只有入口）；依設備排序的切換也在那裡
    const toggle = () => hubBtn('by-device');
    toggle().click();
    if (toggle().getAttribute('aria-pressed') !== 'true') throw new Error('「依設備排序」應可切換');
    const button = (t) => hubBtn(t === 'CSV' ? 'export-csv' : 'export-markdown');
    const { files } = await captureDownloads(() => { button('CSV').click(); button('Markdown').click(); });
    const rows = parseCsv(files[0].text.replace(/^﻿/, '')).slice(1);
    if (rows.length !== all.length) throw new Error('依設備排序仍應輸出全部檢查結果');
    const order = rows.map((r) => r[9] || null);
    const allKeys = []; R.sortByDevice(Q, all).forEach((r) => { if (!allKeys.includes(r.dev)) allKeys.push(r.dev); });
    if (order.some((d, n) => n && allKeys.indexOf(order[n - 1]) > allKeys.indexOf(d))) throw new Error('CSV 應依設備排序，不屬於任何設備的在最後');
    const md = files[1].text;
    const heads = allKeys.map((d) => md.indexOf(`\n## ${d === null ? '不屬於任何設備' : Q.devName(d)}（`));
    if (heads.some((x) => x < 0) || heads.some((x, n) => n && heads[n - 1] > x)) throw new Error('Markdown 應依設備分組並依序排列');
    // 處理建議只在最後的附錄列一次：每項出現的檢查一段，依 CATALOG 的順序，設備分組內不重複
    const appendix = md.indexOf('\n## 附錄：處理建議與常見原因');
    if (appendix < 0 || appendix < Math.max(...heads)) throw new Error('依設備分組的 Markdown 應在最後附上處理建議的附錄');
    const usedIds = Object.keys(S.check.CATALOG).filter((id) => all.some((f) => f.id === id));
    const at = usedIds.map((id) => md.indexOf('\n### ' + id + ' ', appendix));
    if (at.some((x) => x < 0) || at.some((x, n) => n && at[n - 1] > x)) throw new Error('附錄應依 CATALOG 的順序列出每項出現的檢查');
    if (usedIds.some((id) => md.split('\n### ' + id + ' ').length !== 2)) throw new Error('每項檢查在附錄只列一次');
    if (md.split('\n- 處理建議：').length - 1 !== usedIds.length || md.lastIndexOf('\n- 處理建議：', appendix) >= 0) throw new Error('處理建議只應出現在附錄，每項檢查一次');
    toggle().click();
    const { files: f2 } = await captureDownloads(() => button('CSV').click());
    const plain = parseCsv(f2[0].text.replace(/^﻿/, '')).slice(1);
    if (plain.some((r, n) => r[1] !== all[n].id || r[3].replace(/^'/, '') !== all[n].message)) throw new Error('取消依設備排序後應回到基準的順序');
    seg('rule').click();
    // 依檢查是 類別 → 檢查；只有提醒的類別預設收合（例如大型乾淨網路），所以類別標題或檢查標題出現即算恢復
    if (groups().length || !($('#pane-findings').testAll('.fgroup').some((g) => g.className.split(' ').includes('fcat')) || $('#pane-findings').testAll('.fgroup .head .id').length)) throw new Error('切回「依檢查」應恢復依檢查代碼分組');
  });
  await step('防火牆：點選指向規則或服務的檢查結果，定位到該設備防火牆畫面的那一列', () => {
    const Q = App.Q; const all = App.snap.findings;
    const idxs = all.map((f, i) => i).filter((i) => all[i].entities.some((e) => e.type === 'rule' || e.type === 'service'));
    if (!idxs.length) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有指向防火牆規則或服務的檢查結果'); }
    const types = new Set();
    idxs.forEach((i) => {
      const f = all[i]; const e = f.entities.find((x) => x.type === 'rule' || x.type === 'service'); types.add(e.type);
      App.selectFinding(i);
      if (!App.sel || App.sel.type !== e.type || App.sel.key !== e.key) throw new Error(`${f.id} 應選取它指向的${e.type === 'rule' ? '規則' : '服務'}`);
      const dev = e.type === 'rule' ? Q.getFirewallRule(e.key).dev : S.keys.splitEp(e.key)[0];
      if (!App.graph.sel.nodes.has(dev)) throw new Error(`${f.id} 應在圖上選取規則所在的設備`);
      const row = $('#detail').querySelector('.focus');
      if (!row) throw new Error(`${f.id} 應在詳情標出定位的列`);
      if (!row.textContent.includes(f.id)) throw new Error(`${f.id} 定位的列應標出這筆檢查結果`);
      if (e.type === 'rule' && !row.textContent.includes(Q.getFirewallRule(e.key).action)) throw new Error('定位的列應是那條規則');
      if (e.type === 'service' && !row.textContent.includes(S.keys.splitEp(e.key)[1])) throw new Error('定位的列應是那個服務');
      if (row.testAll('td')[0].style.background !== S.view.theme.firewall.focus.bg) throw new Error('定位列的顏色應取自 theme');
    });
    if (!process.env.SMOKE_INPUT && !(types.has('rule') && types.has('service'))) throw new Error('範例資料應同時有指向規則與服務的檢查結果');
    // 找不到的規則或服務：不報錯，說明原因並標出設備
    const dev = Q.firewallRules()[0].dev;
    App.select({ type: 'rule', key: dev + '|ip|filter|input|nope' });
    if (!text('#detail').includes('基準中沒有這條規則') || !App.graph.sel.nodes.has(dev)) throw new Error('找不到的規則應說明，並標出設備');
    App.select({ type: 'service', key: dev + '|nope' });
    if (!text('#detail').includes('基準中沒有這個服務')) throw new Error('找不到的服務應說明');
    App.select(null);
  });
  await step('防火牆畫面：依位址族 → 表 → chain → position 列出，標出 WAN／LAN 判斷、服務與原文行號', () => {
    const Q = App.Q; const rules = Q.firewallRules();
    if (!rules.length) throw new Error('應有防火牆規則');
    const dev = rules.reduce((best, r) => (Q.firewallRulesOf(r.dev).length > Q.firewallRulesOf(best).length ? r.dev : best), rules[0].dev);
    App.select({ type: 'device', key: dev });
    const link = $('#detail').testAll('a').find((a) => a.textContent === '查看防火牆規則與服務');
    if (!link) throw new Error('設備詳情應有防火牆摘要與入口');
    // 防火牆摘要與相鄰的路由表、管理面設定同一種模式：可展開區塊（detail-fold），標題旁「N 條規則」；有問題的規則時預設展開
    {
      const fold = $('#detail').testAll('details').find((d) => d.querySelector('summary').firstChild.textContent === '防火牆');
      const n = Q.firewallRulesOf(dev).length; const bad = Q.firewallRulesOf(dev).some((r) => Q.findingsFor('rule', r.key).some((f) => f.severity !== 'info'));
      if (!fold || !/\bdetail-fold\b/.test(fold.className) || !fold.contains(link)) throw new Error('設備詳情的防火牆應是可展開區塊（section 的 fold），入口在裡面');
      const chip = fold.querySelector('summary').testAll('.chip')[0];
      if (!chip || chip.textContent !== `${S.view.num(n)} 條規則`) throw new Error('防火牆區塊的標題旁應寫「N 條規則」：' + (chip && chip.textContent));
      if ((fold.getAttribute('open') != null) !== bad) throw new Error('有問題的規則時防火牆區塊預設展開，沒有時收合');
      if ($('#detail').testAll('.detail-section').some((s) => s.querySelector('h3').textContent.startsWith('防火牆'))) throw new Error('防火牆摘要不應是一般區塊');
    }
    // WAN 狀態用語：摘要與防火牆畫面共用 V.firewall.zoneStatus()；三種狀態都可區分且標示推論
    const ZS = S.view.firewall.zoneStatus; const zoneNow = Q.firewallZone(dev);
    const known = ['ok', 'no-wan-list', 'empty-wan-list'].map(ZS);
    if (new Set(known.map((z) => z.short)).size !== known.length || new Set(known.map((z) => z.text)).size !== known.length) throw new Error('三種 WAN 狀態的文字應可區分');
    if (known.some((z) => !z.short.includes('（推論）') || !z.tone)) throw new Error('WAN 狀態摘要應標示（推論）並有色調');
    if (Q.devices().some((d) => { const z = Q.firewallZone(d.key); return z && !known.includes(ZS(z.status)); })) throw new Error('基準中的 WAN 狀態都應有對應用語');
    if (zoneNow && !text('#detail').includes(ZS(zoneNow.status).short)) throw new Error('設備詳情的防火牆摘要應顯示 WAN 狀態（與防火牆畫面同一來源）');
    link.click();
    if (zoneNow && !text('#detail').includes(ZS(zoneNow.status).text)) throw new Error('防火牆畫面應顯示 WAN 狀態的完整說明');
    if (App.sel.type !== 'firewall' || App.sel.dev !== dev) throw new Error('入口應開啟該設備的防火牆畫面');
    // chain 依 Q.firewallChains 的順序，每個 chain 一個可展開區塊；展開後列數等於規則數，position 由小到大
    const chains = Q.firewallChains(dev);
    // chain 的區塊在表的區塊裡（兩層都是可展開區塊）：最內層含規則表的是 chain
    const folds = $('#detail').testAll('details').filter((d) => d.querySelector('.fw-chain') && !d.testAll('details').length);
    if (folds.map((d) => d.querySelector('summary').firstChild.textContent).join('|') !== chains.map((c) => c.chain).join('|')) throw new Error('chain 的順序應與 Q.firewallChains 一致');
    const heads = $('#detail').testAll('summary').map((x) => x.firstChild.textContent);
    // 防火牆畫面與設備詳情同一種區塊模式：每個區塊都是可展開區塊（detail-fold），標題旁寫數量與單位
    const blocks = $('#detail').testAll('details').filter((d) => /\bdetail-fold\b/.test(d.className));
    const want = [...S.util.uniq(chains.map((c) => c.family + '|' + c.table)).map(() => '條規則'), ...(Q.ipServicesOf(dev).length ? ['個服務'] : [])];
    const units = blocks.map((d) => { const c = d.querySelector('summary').testAll('.chip')[0]; return c ? c.textContent.replace(/^[\d,]+ /, '') : null; });
    want.forEach((u) => { if (!units.includes(u)) throw new Error('防火牆畫面的區塊標題旁應有數量與單位「' + u + '」：' + units.join('|')); });
    if ($('#detail').testAll('.detail-section').some((s) => /^(IPv4|IPv6|服務|WAN)/.test(s.querySelector('h3').textContent))) throw new Error('防火牆畫面的表、服務與 WAN 判斷應是可展開區塊，不是一般區塊');
    const fams = S.util.uniq(chains.map((c) => c.family + ' ' + c.table));
    const famIdx = fams.map((k) => heads.findIndex((x) => x === k.replace(/^ip /, 'IPv4 ').replace(/^ipv6 /, 'IPv6 ')));
    if (famIdx.some((i) => i < 0) || famIdx.some((x, i) => i && famIdx[i - 1] > x)) throw new Error('位址族與表的分組應依序列出：' + heads.join('|'));
    folds.forEach((d, n) => {
      d.dispatch('toggle');
      const trs = d.testAll('tbody tr'); const c = chains[n];
      if (trs.length !== c.rules) throw new Error(`${c.chain} 的列數應等於規則數`);
      const pos = trs.map((tr) => Number(tr.testAll('td')[0].textContent));
      if (pos.some((x, i) => i && pos[i - 1] > x)) throw new Error(`${c.chain} 應依 position 排列`);
      const rows = Q.firewallRuleRows(dev, { family: c.family, table: c.table, chain: c.chain });
      trs.forEach((tr, i) => {
        const r = rows[i].rule; const act = tr.testAll('td')[1].firstChild;
        const want = S.view.theme.firewall.action[r.action] || S.view.theme.firewall.action.other;
        if (act.style.color !== want) throw new Error('規則動作的顏色應取自 theme');
        if (!tr.textContent.includes(`第 ${r.src[0][1]} 行`)) throw new Error('每列應有原文行號');
      });
      if (c.jumpedFrom.length && !d.textContent.includes('由這些規則 jump 進來')) throw new Error('有規則 jump 進來的 chain 應列出來源規則');
    });
    // 原文行號可開啟
    const a = $('#detail').testAll('.fw-chain a').find((x) => /^第 \d+ 行$/.test(x.textContent));
    $('#dlg-raw').close(); a.click();
    if (!$('#dlg-raw').open || !text('#raw-title').includes(a.textContent.replace(/\D/g, ''))) throw new Error('點原文行號應開啟原文');
    $('#dlg-raw').close();
    // WAN／LAN 判斷與服務
    const zone = Q.firewallZone(dev); const t = text('#detail');
    if (zone && (!t.includes('WAN／LAN 判斷（推論）') || !zone.wanLists.every((x) => t.includes(x)))) throw new Error('應顯示 WAN／LAN 判斷與依據');
    const svc = Q.ipServicesOf(dev);
    if (svc.length && !svc.every((x) => t.includes(x.name))) throw new Error('應列出 /ip service');
    if (svc.some((x) => x.basis === 'default') && !t.includes('預設值')) throw new Error('basis 為 default 的服務應標示「預設值」');
  });
  await step('防火牆修正：指令由 S.remediate 產生（畫面不自己組），F03 等不能產生指令的列出核心的原因', async () => {
    const Q = App.Q; const all = App.snap.findings; const RV = S.view.remediation; const RM = S.remediate;
    // 畫面不再自己組指令：舊的組字函式已移除，防火牆畫面的原始碼沒有 RouterOS 指令片段
    ['DISABLE_FIX', 'disableRuleFix', 'quote', 'findingDevice', 'fixTracking', 'ACK_KIND'].forEach((k) => { if (k in RV) throw new Error('V.remediation 不應再有 ' + k); });
    const fwSrc = fs.readFileSync(path.join(ROOT, 'src/view/panels/firewall.js'), 'utf8');
    if (/disabled=yes|find where|print where/.test(fwSrc)) throw new Error('防火牆畫面不應自己組 RouterOS 指令');
    const idxs = all.map((f, i) => i).filter((i) => all[i].entities.some((e) => e.type === 'rule') && RM.levelOf(all[i].id) !== 'manual');
    if (!process.env.SMOKE_INPUT && !['F01', 'F02', 'F03', 'F06'].every((id) => idxs.some((i) => all[i].id === id))) throw new Error('範例資料應有 F01、F02、F03、F06');
    const seen = { item: 0, skipped: 0 };
    idxs.forEach((i) => {
      const f = all[i]; const key = Q.findingKey(f);
      App.selectFinding(i);
      if (!text('#detail').includes('修正（停用規則）')) throw new Error(`${f.id} 的防火牆畫面應有修正區塊`);
      const box = $('#detail').testAll('.fw-fix').find((b) => b.getAttribute('data-finding') === key);
      if (!box) throw new Error(`${f.id} 的修正應對應它的 findingKey`);
      const plan = RM.plan(Q, [key]);
      const it = plan.items.find((x) => x.findingKey === key);
      if (it) {
        seen.item++;
        const cmd = box.querySelector('.fix-cmd').textContent;
        if (cmd !== RV.itemApplyLines(plan, it)) throw new Error(`${f.id} 的指令應與 S.remediate 產生的相同`);
        const apply = RM.renderRsc(plan, it.dev);
        if (!cmd.split('\n').every((l) => apply.split('\n').includes(l))) throw new Error(`${f.id} 的指令應是套用檔的一部分`);
        if (box.getAttribute('data-rule') !== it.target.key) throw new Error('修正應標出規則');
        if (!box.textContent.includes(it.note) || !it.warnings.every((w) => box.textContent.includes(w))) throw new Error('應列出說明與警告');
      } else {
        seen.skipped++;
        const sk = plan.skipped.find((x) => x.findingKey === key);
        if (!box.className.includes('skipped') || !box.textContent.includes(sk.detail)) throw new Error(`${f.id} 沒有產生指令時應列出原因：${sk.detail}`);
        const ref = box.querySelector('.finding-ref');
        if (!ref || ref.getAttribute('title') !== f.message) throw new Error(`${f.id} 沒有產生指令時應列出檢查結果的訊息`);
        if (box.querySelector('.fix-cmd')) throw new Error(`${f.id} 沒有產生指令時不應有指令`);
      }
      if (f.id === 'F03' && (it || box.textContent.includes('disabled=yes'))) throw new Error('F03 在核心是 choice，畫面不可產生停用指令');
    });
    if (!process.env.SMOKE_INPUT && (!seen.item || !seen.skipped)) throw new Error('範例資料應同時有產生指令與未產生指令的修正');
    if (idxs.length) {
      const withCmd = $('#detail').querySelector('.copy-fix');
      if (withCmd) { withCmd.click(); await new Promise((r) => setTimeout(r, 5)); if (!text('#banner').includes('複製')) throw new Error('複製後應有提示：' + text('#banner')); }
      // 設備的防火牆畫面：收合列出這台設備全部的修正與筆數（items＋skipped）
      const dev = Q.getFirewallRule(all[idxs[0]].entities.find((e) => e.type === 'rule').key).dev;
      App.select({ type: 'firewall', dev, key: dev });
      const keys = S.util.uniq(Q.findingsFor('device', dev).filter((f) => f.entities.some((e) => e.type === 'rule') && RM.levelOf(f.id) !== 'manual').map((f) => Q.findingKey(f)));
      const plan = RM.plan(Q, keys);
      const fold = $('#detail').testAll('details').find((d) => d.querySelector('summary').textContent.startsWith('修正'));
      if (!fold || fold.querySelector('summary .chip').textContent !== String(plan.items.length + plan.skipped.length)) throw new Error('設備的防火牆畫面應收合列出全部修正與筆數');
      // 在修正計畫中開啟：選取就是這些 findingKey
      fold.querySelector('.open-patch').click();
      if (!S.view.patchView.isOpen(App) || Array.from(S.view.patchView.state.keys).sort().join() !== keys.slice().sort().join()) throw new Error('「在修正計畫中開啟」應以這些檢查結果在中間開啟修正計畫');
      if (document.activeElement !== $('#patch-title')) throw new Error('從防火牆畫面開啟修正計畫時，焦點應移到修正計畫的標題');
      App.showView('graph');
    }
    App.select(null);
  });
  await step('覆蓋率：由 C01 匯出 tools/collect.sh 的 devices.csv 草稿（格式與 collect.sh 的讀法一致）', async () => {
    const Q = App.Q; const all = App.snap.findings; const R = S.view.remediation;
    // 依 tools/collect.sh 的 load_inventory：略過空白與 # 開頭的列，第一個資料列是標題列，其餘逐欄檢查
    const collectInventory = (t) => {
      const rows = []; let header = false;
      t.split('\n').forEach((line, n) => {
        const [name = '', address = '', user = '', port = ''] = line.split(',').map((s) => s.trim());
        if (!name || name.startsWith('#')) return;
        if (!header) { if (name !== 'name' || address !== 'address' || user !== 'user') throw new Error(`第 ${n + 1} 行：第一個資料列必須是標題列`); header = true; return; }
        if (!address || !user) throw new Error(`第 ${n + 1} 行：name、address、user 不可為空`);
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(name)) throw new Error(`第 ${n + 1} 行：設備名稱無效`);
        if (/[\s,]/.test(address) || /[\s,]/.test(user)) throw new Error(`第 ${n + 1} 行：address 或 user 無效`);
        const p = port || '22'; if (!/^\d+$/.test(p) || +p < 1 || +p > 65535) throw new Error(`第 ${n + 1} 行：port 無效`);
        if (rows.some((r) => r.name === name)) throw new Error(`第 ${n + 1} 行：設備名稱重複`);
        rows.push({ name, address, user, port: p });
      });
      if (!header) throw new Error('缺少標題列');
      return rows;
    };
    goStep('input'); // 覆蓋率與 devices.csv 草稿在「輸入」（資料中心）
    const btn = hubBtn('devices-csv');
    S.view.app.closeHub();
    const devs = S.util.uniq(all.filter((f) => f.id === 'C01').map((f) => f.entities.find((e) => e.type === 'device').key)).map((k) => Q.getDevice(k));
    if (!btn || !/devices\.csv 草稿/.test(btn.textContent)) throw new Error('「輸入」的覆蓋率應有匯出 devices.csv 草稿的按鈕');
    if ((btn.getAttribute('disabled') !== null) !== !devs.length) throw new Error('沒有 C01 時按鈕應停用');
    if (!devs.length) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有 C01'); }
    const { files } = await captureDownloads(() => btn.click());
    if (files.length !== 1 || !/^devices-draft-.*\.csv$/.test(files[0].name)) throw new Error('應下載 devices.csv 草稿：' + files.map((f) => f.name));
    if (files[0].bytes.subarray(0, 3).toString('hex') === 'efbbbf' || files[0].text.includes('\r')) throw new Error('草稿不可有 BOM 或 CR：collect.sh 以 bash read 逐行讀取');
    const t = files[0].text; const rows = collectInventory(t);
    devs.forEach((d) => {
      const heard = Q.ipAddresses().filter((a) => a.dev === d.key && a.hearsay).map((a) => a.ip);
      const row = rows.find((r) => r.name === d.name);
      if (row && row.address !== (d.mgmtIp || heard[0])) throw new Error(`${d.name} 的 address 應取管理 IP 或鄰居回報的位址`);
      if (!row && !t.split('\n').some((l) => l.startsWith('# ' + d.name + '：'))) throw new Error(`${d.name} 沒有列出，也沒有註解說明原因`);
    });
    if (rows.length !== devs.length && !process.env.SMOKE_INPUT) throw new Error('範例資料的 C01 設備都應有位址可列出');
    if (rows.some((r) => r.user !== R.USER_PLACEHOLDER) || !t.includes(`user 欄是佔位值 ${R.USER_PLACEHOLDER}`)) throw new Error('user 不可猜，應是明顯的佔位值並加註解');
    // 沒有位址、名稱不符合 collect.sh 規則的設備寫成註解列，草稿仍能被 collect.sh 讀取
    if (devs.length >= 2) {
      const clone = JSON.parse(JSON.stringify(App.snap));
      const d1 = clone.model.devices.find((d) => d.key === devs[0].key); const d2 = clone.model.devices.find((d) => d.key === devs[1].key);
      d1.mgmtIp = null; clone.model.ipAddresses = clone.model.ipAddresses.filter((a) => a.dev !== d1.key); d2.name = 'BAD NAME';
      const dr = R.devicesCsvDraft(S.query(clone)); const r2 = collectInventory(dr.text);
      if (r2.some((r) => r.name === d1.name) || !dr.text.includes(`# ${d1.name}：沒有管理 IP`)) throw new Error('沒有位址的設備應寫成註解列並說明');
      if (r2.some((r) => r.name === 'BAD NAME') || !dr.text.includes('# BAD NAME：名稱不符合')) throw new Error('名稱不符合 collect.sh 規則的設備應寫成註解列並說明');
      if (r2.length !== rows.length - 2) throw new Error('其他設備應照常列出');
    }
  });
};
