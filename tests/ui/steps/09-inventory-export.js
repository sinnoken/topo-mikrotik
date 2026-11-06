// 畫面冒煙測試的 step：清單、覆蓋率、MAC 詳情、比對與預期現況、匯出。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { body, head, document, S, fs, path, ROOT, step, captureDownloads, parseCsv, hubBtn, goStep, pickInv, $, text } = require('../helpers.js');

module.exports = async () => {
  await step('清單分頁列出設備、介面、MAC、VLAN，並可篩缺 IP；總覽顯示去重複的 IP（ARP）', () => {
    const C = App.Q.inventory().counts; const st = App.snap.meta.stats;
    const same = [['devices', st.devices], ['interfaces', st.interfaces], ['macs', st.macs], ['vlans', st.vlans]];
    same.forEach(([k, v]) => { if (C[k] !== v) throw new Error(`清單與總覽的 ${k} 不一致：${C[k]} vs ${v}`); });
    // 位址鍵（S.keys.inVrf）：同一個 IP 在兩個 VRF 是兩筆
    if (C.arpIps !== new Set(App.snap.model.arps.map((x) => S.keys.inVrf(x.ip, x.vrf))).size) throw new Error('IP（ARP）應為去重複的 ARP 位址鍵數');
    if (C.ips < C.arpIps || C.ips !== new Set(App.Q.inventory().rows.ips.map((r) => r.key)).size) throw new Error('IP 清單應依位址鍵去重複且涵蓋 ARP');
    const rows = App.Q.macEntries(); if (!rows.length) throw new Error('清單應有資料');
    const noIp = App.snap.model.macs.filter((x) => !x.ips.length).length;
    if (rows.filter((r) => r.noIp).length < noIp) throw new Error('缺 IP 筆數不符');
    goStep('view'); // 清單在「檢視」的左側
    if ($('#pane-inventory').classList.contains('hidden') || !$('#pane-findings').classList.contains('hidden')) throw new Error('「檢視」的左側應是清單');
    const m = App.snap.model; const ips = App.Q.ipEntries();
    const t = text('#pane-inventory');
    [`設備 ${m.devices.length + App.Q.endpointEntries().length}`, `介面 ${m.interfaces.length}`, `IP ${ips.length}`, `網段 ${m.prefixes.length}`, `MAC ${new Set(rows.map((r) => r.mac)).size}`, `VLAN ${m.vlans.length}`].forEach((x) => { if (!t.includes(x)) throw new Error('清單缺少分類：' + x); });
    if (new Set(ips.map((r) => r.key)).size !== ips.length) throw new Error('IP 清單應依位址鍵去重複');
    // 廠商與介面狀態用顯示名稱（V.vendorName、V.ifcState），不直接放原始列舉
    const cells = (col) => { const ths = document.testAll('#pane-inventory th').map((x) => x.textContent); const n = ths.findIndex((x) => x.trim().startsWith(col)); if (n < 0) throw new Error('清單缺少欄位 ' + col + '：' + ths.join('、'));
      return document.testAll('#pane-inventory tbody tr').map((tr) => tr.testAll('td')).filter((tds) => tds.length > n).map((tds) => tds[n].textContent); };
    pickInv('inv-kind', 'device'); const vend = m.devices.find((d) => d.collected && d.manufacturer);
    if (vend && !cells('廠商').includes(S.view.vendorName(vend.manufacturer))) throw new Error('設備清單的廠商應用顯示名稱');
    if (cells('廠商').some((c) => /^mikrotik$/.test(c))) throw new Error('廠商欄不應出現小寫原值 mikrotik');
    pickInv('inv-kind', 'interface');
    const ifcSt = cells('狀態');
    if (!ifcSt.length || ifcSt.some((c) => /^(unknown|disabled)$/.test(c)) || !ifcSt.every((c) => Object.values(S.view.STATUS).includes(c) || c === '停用')) throw new Error('介面狀態應用 V.ifcState：' + S.util.uniq(ifcSt).join('、'));
    pickInv('inv-kind', 'prefix');
    const pre = App.Q.inventory().rows.prefixes;
    if (!pre.length || document.testAll('#pane-inventory tbody tr').length !== pre.length) throw new Error('網段清單列數應等於推導出的網段數');
    pre.forEach((p) => { if (p.ipCount !== ips.filter((r) => r.vrf === p.vrf && S.ip.inNet(r.ip, p.net, p.len)).length) throw new Error('網段的 IP 數應等於清單中同一個 VRF、落在網段內的 IP'); });
    document.querySelector('#pane-inventory tbody tr').dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'interface' || !pre[0].eps.includes(App.sel.key)) throw new Error('點網段應選取設定該網段的介面');
    if (new Set(rows.map((r) => r.mac)).size !== App.snap.meta.stats.macs) throw new Error('清單的不重複 MAC 數應等於總覽');
    const nEnd = App.Q.endpointEntries().length; const unk = App.snap.model.interfaces.filter((i) => i.unknownPeer).length;
    if (nEnd < unk || new Set(App.Q.endpointEntries().map((e) => e.key)).size !== unk) throw new Error('終端的不重複介面數應等於未知對端介面數，且不可少於它');
    pickInv('inv-kind', 'device');
    const t0 = text('#pane-inventory'); ['全部 ' + (m.devices.length + nEnd), '終端 ' + nEnd].forEach((x) => { if (!t0.includes(x)) throw new Error('設備清單缺少分類：' + x); });
    // 最多兩層控制：資料分段之下只有一列——清單種類下拉、種類內篩選下拉與文字篩選；0 筆的篩選停用
    const bar = $('#pane-inventory .inv-bar'); if (!bar) throw new Error('清單應有一列控制');
    const kindOpts = bar.querySelector('.inv-kind').testAll('option');
    if (kindOpts.length !== 6 || !bar.querySelector('.inv-filter') || !bar.querySelector('.pane-filter')) throw new Error('清單種類（6 種）、篩選與文字篩選應在同一列');
    if (document.testAll('#pane-inventory .summary').length || $('#pane-inventory .seg')) throw new Error('清單不應再有分段按鈕或第二排篩選選項');
    ['inv-kind', 'inv-filter', 'pane-filter'].forEach((c) => { if (!bar.querySelector('.' + c).getAttribute('aria-label')) throw new Error('清單控制應有 aria 名稱：' + c); });
    bar.querySelector('.inv-filter').testAll('option').forEach((o) => {
      if ((/ 0$/.test(o.textContent) && o.getAttribute('value') !== 'all') !== (o.getAttribute('disabled') != null)) throw new Error('只有 0 筆的篩選停用：' + o.textContent);
    });
    const firstRow = document.querySelector('#pane-inventory tbody tr');
    if (!firstRow || firstRow.getAttribute('tabindex') !== '0') throw new Error('可點選清單列應可透過鍵盤聚焦');
    firstRow.dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'device') throw new Error('清單列按 Enter 應選取設備');
    if (nEnd) { pickInv('inv-filter', 'end'); if (document.testAll('#pane-inventory tbody tr').length !== Math.min(nEnd, 500)) throw new Error('終端篩選列數不符'); }
    if (document.activeElement !== $('#pane-inventory .inv-filter')) throw new Error('換篩選後焦點應留在篩選下拉');
    // 窄欄：表格在自己的框內橫向捲動，不截斷主要欄
    if (!$('#pane-inventory table').parentNode.className.includes('table-scroll')) throw new Error('清單表格應在可橫向捲動的框內');
    // 窄螢幕：每種清單的關鍵欄在前三欄（先看到），其餘依內容寬度橫向捲動並有滑動提示；終端的名稱不重複廠商欄
    const head3 = () => document.testAll('#pane-inventory th').slice(0, 3).map((x) => x.textContent.replace(/[▲▼]/g, '').trim()).join('|');
    [['device', '設備|類型|管理 IP'], ['interface', '設備|介面|狀態'], ['mac', 'MAC|廠商|IP']].forEach(([k, want]) => {
      pickInv('inv-kind', k); if (head3() !== want) throw new Error(`${k} 清單的前三欄應是關鍵欄 ${want}：${head3()}`);
      if (!$('#pane-inventory .inv-table .inv-scroll-hint')) throw new Error('清單應有窄螢幕的滑動提示');
    });
    pickInv('inv-kind', 'device'); pickInv('inv-filter', 'end');
    const endRows = document.testAll('#pane-inventory tbody tr').map((tr) => tr.testAll('td').map((td) => td.textContent));
    const vCol = document.testAll('#pane-inventory th').findIndex((x) => x.textContent.trim().startsWith('廠商'));
    if (endRows.some((tds) => tds[vCol] && tds[0] === tds[vCol])) throw new Error('終端的名稱欄不應重複廠商欄');
    const invCss = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8'); const invNarrow = invCss.slice(invCss.indexOf('@media (max-width: 900px)'));
    if (!/\.inv-scroll-hint \{ display: none; \}/.test(invCss) || !/\.inv-scroll-hint \{ display: block; \}/.test(invNarrow) || !/\.inv-table table\.t \{ width: max-content;/.test(invNarrow)) throw new Error('窄螢幕的清單表格應依內容寬度橫向捲動並顯示提示');
    pickInv('inv-kind', 'ip');
    if (document.activeElement !== $('#pane-inventory .inv-kind')) throw new Error('換清單種類後焦點應留在種類下拉');
    // 可排序的標頭是 th 裡的按鈕（鍵盤可操作），th 標 aria-sort
    const sortBtn = () => document.testAll('#pane-inventory th')[0].querySelector('.th-sort');
    if (!sortBtn() || document.testAll('#pane-inventory th')[0].getAttribute('aria-sort') !== 'none') throw new Error('可排序的標頭應是按鈕，未排序時 aria-sort=none');
    sortBtn().click();
    if (document.testAll('#pane-inventory th')[0].getAttribute('aria-sort') !== 'ascending') throw new Error('升冪時 aria-sort=ascending');
    const col = () => document.testAll('#pane-inventory tbody tr').map((tr) => tr.testAll('td')[0].textContent);
    const asc = col(); const num = (x) => x.split('.').reduce((n, p) => n * 256 + +p, 0);
    if (!asc.length || asc.some((x, i) => i && num(asc[i - 1]) > num(x))) throw new Error('IP 清單應依 IP 數值升冪');
    sortBtn().click();
    const desc = col(); if (asc.length > 1 && desc[0] === asc[0]) throw new Error('再點一次應反向排序');
    if (document.testAll('#pane-inventory th')[0].getAttribute('aria-sort') !== 'descending') throw new Error('降冪時 aria-sort=descending');
    pickInv('inv-kind', 'mac'); const t2 = text('#pane-inventory'); if (!t2.includes('缺 IP ' + new Set(rows.filter((r) => r.noIp).map((r) => r.mac)).size) || !t2.includes('全部 ' + App.snap.meta.stats.macs)) throw new Error('缺 IP 摘要不正確');
    App.select(null); const ov = text('#right'); const uniq = new Set(App.snap.model.arps.map((x) => x.ip)).size;
    if (!ov.includes('IP（ARP）' + uniq.toLocaleString()) && !ov.includes('IP（ARP）')) throw new Error('總覽缺少 IP（ARP）');
  });
  await step('覆蓋率在「輸入」（資料中心）', () => {
    goStep('input');
    if ($('#hub').classList.contains('hidden') || !$('#hub').contains($('#pane-coverage'))) throw new Error('覆蓋率應在資料中心（「輸入」）');
    if (!text('#pane-coverage').includes(process.env.SMOKE_INPUT ? '有缺漏 0' : '有缺漏 1')) throw new Error('覆蓋率摘要不正確');
    S.view.app.closeHub();
  });
  await step('覆蓋率：每台一列，缺少的資料以 chip 列在同列、有缺漏的排前，欄位可排序，超過上限註明', () => {
    goStep('input');
    const pc = () => $('#pane-coverage');
    pc().testAll('.chip').find((c) => c.textContent.startsWith('全部已收集')).click();
    const list = App.Q.coverage().filter((r) => r.collected);
    const gap = App.Q.coverageGap; const LIMIT = 600;
    // 有缺漏的排前（穩定排序，其餘維持原順序）
    const want = list.filter(gap).concat(list.filter((r) => !gap(r))).slice(0, LIMIT);
    const trs = pc().testAll('tbody tr');
    if (trs.length !== want.length) throw new Error(`覆蓋率列數應為 ${want.length}：${trs.length}`);
    trs.forEach((tr, n) => {
      const r = want[n]; const td = tr.testAll('td');
      if (td[0].textContent !== App.Q.devLabel(r.dev)) throw new Error('覆蓋率應有缺漏的排前、其餘維持原順序：' + td[0].textContent);
      const chips = td[2].testAll('.chip');
      if (chips.length !== r.missing.length + r.failures.length) throw new Error('缺少的資料與收集失敗應各一個 chip，列在同一列：' + td[0].textContent);
      if (!gap(r) && td[2].textContent !== '—') throw new Error('沒有缺漏的設備寫「—」');
    });
    if (list.length > LIMIT && !text('#pane-coverage').includes(`只顯示前 ${LIMIT} 筆，共 ${S.view.num(list.length)} 筆`)) throw new Error('超過上限應註明只顯示前 N 筆');
    const ths = pc().testAll('th');
    if (ths.map((th) => th.textContent).join('|') !== '設備|類型|缺少的資料|鏈路' || ths.some((th) => !th.querySelector('.th-sort'))) throw new Error('覆蓋率四欄都可排序：' + ths.map((th) => th.textContent).join('|'));
    ths[3].querySelector('.th-sort').click();
    const links = pc().testAll('tbody tr').map((tr) => +tr.testAll('td')[3].textContent);
    if (pc().testAll('th')[3].getAttribute('aria-sort') !== 'ascending' || links.some((x, i) => i && links[i - 1] > x)) throw new Error('依鏈路數排序');
    // 收集失敗的 chip 是按鈕：點一下開啟原文，不選取所在列的設備
    const fail = pc().querySelector('.failure');
    if (fail && fail.tagName === 'BUTTON') {
      const sel0 = App.sel; fail.click();
      if (App.sel !== sel0) throw new Error('點收集失敗的 chip 不應選取設備');
    }
    S.view.app.closeHub();
  });
  await step('MAC 詳情：事實、位置（推論）、學到它的介面分開；非終端埠收合，全相同的欄位不重複列', () => {
    const Q = App.Q;
    const anchorOf = (m) => (r) => m.edge.includes(r.ep) || (m.behind && m.behind.anchor === r.ep) || (m.wifi && m.wifi.ep === r.ep);
    const ms = App.snap.model.macs.map((x) => Q.findMac(x.mac));
    const m = ms.find((x) => x.edge.length && x.seen.some((r) => !anchorOf(x)(r))) || ms.find((x) => x.seen.length);
    if (!m) throw new Error('應有學到 MAC 的介面');
    App.select({ type: 'mac', key: m.mac });
    const d = $('#detail'); const heads = d.testAll('h3').concat(d.testAll('summary'));
    const head = (t) => heads.find((x) => x.textContent.startsWith(t));
    const kvs = d.testAll('.k').map((k) => k.textContent);
    if (!kvs.includes('IP（ARP）') || kvs.includes('位置（終端埠）')) throw new Error('事實區列 IP（ARP），位置另成一區');
    const place = head('位置');
    if (!place) throw new Error('MAC 詳情應有「位置」區塊');
    const inferred = m.edge.length || m.behind || (m.wifi && m.wifi.basis !== 'registration');
    if (!!inferred !== place.textContent.includes(S.view.TERMS.inferred)) throw new Error('推定的位置應在區塊標題加推論標示');
    const learnt = head('學到它的介面'); if (!learnt) throw new Error('應有「學到它的介面」區塊');
    const rest = m.seen.filter((r) => !anchorOf(m)(r));
    const fold = d.testAll('summary').find((x) => x.textContent.startsWith('另在 '));
    if (rest.length ? !fold || fold.textContent !== `另在 ${rest.length} 個非終端埠學到` : fold) throw new Error('非終端埠應收合為「另在 N 個非終端埠學到」');
    const th = d.testAll('th').map((x) => x.textContent);
    const allSame = (f) => m.seen.every((r) => f(r) === f(m.seen[0]));
    if (allSame((r) => !!r.static) === th.includes('類型')) throw new Error('類型全相同時不顯示類型欄');
    if (allSame((r) => r.vlan || '') === th.includes('VLAN')) throw new Error('VLAN 全相同時不顯示 VLAN 欄');
    if (allSame((r) => r.vlan || '') && m.seen[0].vlan && !learnt.textContent.includes('VLAN ' + m.seen[0].vlan)) throw new Error('VLAN 全相同時寫在區塊標題');
    // 基準中沒有的 MAC 沒有位置區塊
    App.select({ type: 'mac', key: '02:00:00:00:00:01' });
    if (d.testAll('h3').some((x) => x.textContent.startsWith('位置')) || !text('#detail').includes('基準中沒有這個 MAC')) throw new Error('基準中沒有的 MAC 不列位置');
    App.select(null);
  });
  await step('比對：在「驗證」全寬顯示，資料中心的「預期現況」列出同一份比對的摘要', async () => {
    goStep('verify');
    if (App.step !== 'verify' || App.centerView !== 'verify' || $('#view-verify').classList.contains('hidden') || document.activeElement !== $('#verify-title')) throw new Error('「驗證」應在中間開啟並聚焦標題');
    if (!$('#view-verify').contains($('#compare-body')) || !$('#left').classList.contains('hidden')) throw new Error('比對在中間的驗證畫面，「驗證」沒有左側清單');
    const inp = $('#compare-body').querySelector('input'); inp.files = [{ name: 'expected-sample.json', text: async () => fs.readFileSync(path.join(ROOT, 'samples/expected-sample.json'), 'utf8') }];
    inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
    if (!text('#compare-body').includes('有差異')) throw new Error('比對結果未顯示');
    // 資料中心的摘要和驗證畫面的結果是同一份比對（筆數依關係，不寫死）
    const rep = S.view.lists.compare.report(App); const nDiff = rep.items.filter((i) => i.status !== 'ok').length;
    const hubRow = $('#hub').testAll('.hub-row').find((r) => r.getAttribute('data-item') === 'expected');
    if (!hubRow.textContent.includes('expected-sample.json') || !hubRow.textContent.includes(`有差異 ${S.view.num(nDiff)} 項`)) throw new Error('資料中心應列出預期資料的檔名與差異筆數：' + hubRow.textContent);
    // 點一列：詳情在右側，比對留在中間
    const row = $('#compare-body').testAll('tbody tr').find((tr) => tr.getAttribute('tabindex') === '0');
    if (row) {
      App.select(null); row.click();
      if (App.centerView !== 'verify') throw new Error('點比對的一列時，比對應留在中間');
    }
    App.showView('graph');
  });
  await step('比對：預期現況的漂移提示（推論）——沒有漂移時不提示；只有一輪不符是偏離，連續兩輪是可能已過時；沒有來源的舊檔另外說明', async () => {
    const VL = S.view.lists; const BD = S.view.baselineDiff;
    const saved = App.round.expected;
    goStep('verify'); BD.reset();
    const loadExp = async (name, obj) => {
      const inp = $('#compare-body').querySelector('input'); inp.files = [{ name, text: async () => JSON.stringify(obj) }];
      inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
    };
    const box = () => $('#compare-body').querySelector('.cmp-drift');
    const has = (sel) => !!(box() && box().querySelector(sel));
    // 1. 由目前基準產生的預期現況（有 source）：沒有漂移，不顯示過時或偏離；只有一輪，說明找不到上一輪基準
    const gen = S.compare.expectedFrom(App.Q);
    await loadExp('expected-now.json', gen);
    const r0 = VL.compare.drift(App);
    if (!r0 || r0.errors.length || r0.stale.length || r0.drifted.length) throw new Error('同一份基準產生的預期現況不應有漂移');
    if (!box()) throw new Error('預期現況比對應有漂移判斷的區塊');
    if (has('.drift-stale') || has('.drift-drifted') || has('.drift-unobserved')) throw new Error('沒有漂移時不應顯示過時或偏離的提示');
    if (!box().textContent.includes('推論')) throw new Error('漂移判斷是推論，應有推論標示');
    const few = r0.warnings.find((w) => w.kind === 'too-few-rounds');
    if (!few || !box().textContent.includes(few.message) || !box().textContent.includes('上一輪的基準')) throw new Error('只有一輪時應顯示核心的提醒並說明沒有上一輪的基準：' + box().textContent);
    // 2. 預期現況多一台不存在的設備：只有一輪 → 網路與預期不同（偏離），不是過時
    const ghost = JSON.parse(JSON.stringify(gen)); ghost.devices.push('不存在的設備_X');
    await loadExp('expected-ghost.json', ghost);
    const r1 = VL.compare.drift(App);
    const d1 = r1.drifted.find((i) => i.ref === S.keys.dev('不存在的設備_X'));
    if (!d1 || r1.stale.length) throw new Error('只有一輪不符應是偏離（drifted），不是過時');
    if (!has('.drift-drifted') || has('.drift-stale') || !box().textContent.includes('網路與預期不同') || !box().textContent.includes(d1.message)) throw new Error('應列出偏離的項目：' + box().textContent);
    // 3. 有上一輪的基準（與工作包帶回時相同的路徑），預期現況由上一輪產生：兩輪都沒有這台 → 預期現況可能已過時
    const src = App.sources.map((s, i) => (i === 0 ? { name: s.name, text: '# 上一輪\n' + s.text } : s));
    const prevSnap = S.build(src, { profile: App.round.profile, expectedData: App.round.expectedData, now: '2000-01-01T00:00:00Z' });
    BD.setOld(App, '上一輪.json', prevSnap);
    if (!BD.loaded()) throw new Error('測試資料：上一輪的基準應能比對');
    const before = JSON.stringify(prevSnap);
    const old = JSON.parse(JSON.stringify(S.compare.expectedFrom(S.query(prevSnap)))); old.devices.push('不存在的設備_X');
    await loadExp('expected-old.json', old);
    const r2 = VL.compare.drift(App);
    const s2 = r2.stale.find((i) => i.ref === S.keys.dev('不存在的設備_X'));
    if (!s2 || s2.rounds < 2) throw new Error('上一輪與這一輪都不符應推論為過時：' + JSON.stringify(r2.summary));
    const t2 = box().textContent;
    if (!has('.drift-stale') || !t2.includes('預期現況可能已過時') || !t2.includes(`連續 ${s2.rounds} 輪不符`) || !t2.includes(s2.message)) throw new Error('應提示預期現況可能已過時並列出項目：' + t2);
    if (r2.warnings.some((w) => w.kind === 'too-few-rounds')) throw new Error('有上一輪的基準時不應是輪數不足');
    if (JSON.stringify(prevSnap) !== before) throw new Error('漂移判斷不可修改上一輪的基準');
    const go = box().querySelector('.drift-regenerate');
    if (!go || go.tagName !== 'BUTTON') throw new Error('過時時應有到資料中心重新產生的入口（按鈕，可用鍵盤操作）');
    if (App.round.expected.name !== 'expected-old.json') throw new Error('提示不可自動覆蓋預期現況');
    go.click();
    if (!S.view.app.hubOpen() || document.activeElement !== $('#hub-sec-compare') || !$('#hub-sec-compare').contains(hubBtn('export-expected'))) throw new Error('應開啟資料中心並聚焦「由目前基準產生預期現況」');
    const hubRow = $('#hub').testAll('.hub-row').find((r) => r.getAttribute('data-item') === 'expected');
    if (!hubRow.textContent.includes('可能已過時')) throw new Error('資料中心的預期現況也應註明可能已過時：' + hubRow.textContent);
    S.view.app.closeHub();
    if (App.round.expected.name !== 'expected-old.json') throw new Error('開啟資料中心不可覆蓋預期現況');
    // 3b. 上一輪的基準沒有列入時，說明實際用了幾輪、哪一份沒有列入與原因，不可再寫「目前的基準與上一輪的基準」
    //   before-source：預期現況由目前基準產生，上一輪（較早）早於來源；duplicate：上一輪與目前是同一次收集（輸入相同）
    await loadExp('expected-now.json', gen);
    const rb = VL.compare.drift(App);
    if (rb.basis.history.map((x) => x.reason).join() !== 'before-source,') throw new Error('測試資料：上一輪應早於來源基準：' + JSON.stringify(rb.basis.history));
    const tb = box().textContent;
    if (!tb.includes('依 1 輪基準判斷') || tb.includes('目前的基準與上一輪的基準') || !tb.includes('上一輪.json') || !tb.includes('早於預期現況的來源基準')) throw new Error('上一輪早於來源時應說明沒有列入與原因：' + tb);
    const dupSnap = S.build(App.sources, { profile: App.round.profile, expectedData: { switch: ['lldp'] }, now: '2000-01-01T00:00:00Z' });
    BD.setOld(App, '同一次收集.json', dupSnap);
    const old2 = JSON.parse(JSON.stringify(old)); delete old2.source;
    await loadExp('expected-legacy-ghost.json', old2);
    const rd = VL.compare.drift(App);
    if (rd.basis.history.map((x) => x.reason).join() !== ',duplicate') throw new Error('測試資料：同一次收集應以 duplicate 排除：' + JSON.stringify(rd.basis.history));
    if (rd.stale.length) throw new Error('同一次收集只算一輪，不可推論為過時');
    const td = box().textContent;
    if (!td.includes('依 1 輪基準判斷') || td.includes('目前的基準與上一輪的基準') || !td.includes('同一次收集.json') || !td.includes('同一次收集（輸入相同）')) throw new Error('同一次收集時應說明只算一輪與原因：' + td);
    BD.setOld(App, '上一輪.json', prevSnap);
    // 4. 舊格式（沒有 source）：顯示 no-source 提醒，並說明重新產生後才能完整判斷
    const noSrc = JSON.parse(JSON.stringify(gen)); delete noSrc.source;
    await loadExp('expected-legacy.json', noSrc);
    const r3 = VL.compare.drift(App);
    const ns = r3.warnings.find((w) => w.kind === 'no-source');
    if (!ns || !box().textContent.includes(ns.message) || !box().textContent.includes('這份預期現況沒有記錄來源基準，重新產生後才能完整判斷')) throw new Error('沒有來源的預期現況應說明：' + box().textContent);
    // 還原：載入原本的預期現況，不留上一輪的基準
    BD.reset();
    if (saved) await loadExp(saved.name, saved.data); else { App.round.expected = null; S.view.app.renderAll(); }
    App.showView('graph');
  });
  await step('匯出：基準 JSON 與檢查結果 CSV／Markdown 在本機產生（入口在資料中心），下載後釋放 URL，不改寫基準', async () => {
    const before = JSON.stringify(App.snap);
    if ($('#btn-json')) throw new Error('基準 JSON 的匯出已移到資料中心，工具列不應再有「匯出 JSON」');
    const { made, revoked, anchors, files } = await captureDownloads(() => {
      if (!hubBtn('export-snapshot') || !hubBtn('export-csv') || !hubBtn('export-markdown')) throw new Error('資料中心應有基準 JSON、CSV 與 Markdown 的匯出按鈕');
      hubBtn('export-snapshot').click(); hubBtn('export-csv').click(); hubBtn('export-markdown').click();
    });
    if (made.length !== 3 || anchors.length !== 3) throw new Error('三種匯出各應產生一個下載');
    if (revoked.join() !== made.map((b, i) => 'blob:smoke/' + (i + 1)).join()) throw new Error('下載後應釋放每一個 object URL');
    if (anchors.some((a) => a.parentNode)) throw new Error('下載用的連結應在點擊後移除');
    const names = anchors.map((a) => a.getAttribute('download'));
    const devs = String(App.snap.meta.stats.devices);
    if (!/\.json$/.test(names[0]) || !/\.csv$/.test(names[1]) || !/\.md$/.test(names[2])) throw new Error('副檔名不符：' + names);
    if (!names.every((n) => n.includes(devs + 'dev') && /\d{8}T\d{6}Z/.test(n))) throw new Error('檔名應含設備數與建立時間：' + names);
    if (JSON.stringify(App.snap) !== before) throw new Error('匯出不可改寫基準');
    const bytes = files.map((f) => f.bytes);
    const [json, csv, md] = files.map((f) => f.text);
    require('assert').deepStrictEqual(JSON.parse(json), App.snap);
    // CSV：UTF-8 BOM 開頭（bytes EF BB BF），內容依 RFC 4180 解析回來要和每筆 finding 對得上
    if (bytes[1].subarray(0, 3).toString('hex') !== 'efbbbf') throw new Error('CSV 應以 UTF-8 BOM 開頭');
    const rows = parseCsv(csv.replace(/^\uFEFF/, ''));
    if (rows[0].join() !== 'severity,id,title,message,entities,evidence,acknowledged,ack_kind,ack_note,device,action,status,note,waiver_reason,waiver_until,facet,與多數不同（推論）') throw new Error('CSV 標頭不符：' + rows[0]);
    if (rows.length - 1 !== App.snap.findings.length) throw new Error('CSV 每筆檢查結果應恰好一列');
    App.snap.findings.forEach((f, i) => {
      const r = rows[i + 1]; const lg = S.view.app.ledgerExport(f); const ack = lg && !S.ledger.isPending(lg.status) ? lg : {};
      if (r[0] !== f.severity || r[1] !== f.id || r[3].replace(/^'/, '') !== f.message) throw new Error(`CSV 第 ${i + 2} 列與 ${f.id} 不符`);
      if (!f.entities.every((e) => r[4].includes(e.type + ':' + e.key))) throw new Error(`CSV ${f.id} 缺少相關實體`);
      if (r[5] !== f.evidence.map((e) => `${e.file}:${e.line}`).join('; ')) throw new Error(`CSV ${f.id} 的證據應合在同一格`);
      if (r[6] !== (ack.at || '')) throw new Error(`CSV ${f.id} 的 acknowledged 應為確認時間（未確認為空白）`);
      if (r[7] !== (ack.status || '') || r[8].replace(/^'/, '') !== (ack.note || '')) throw new Error(`CSV ${f.id} 的 ack_kind／ack_note 應為已處理的狀態與備註`);
      if (r[11] !== (lg ? lg.status : '')) throw new Error(`CSV ${f.id} 的 status 應為處理紀錄的狀態`);
      if (r[9] !== (App.Q.findingDevice(f) || '')) throw new Error('CSV ' + f.id + ' 的 device 應為所屬設備');
      if (r[10].replace(/^'/, '') !== S.check.CATALOG[f.id].action) throw new Error('CSV ' + f.id + ' 的 action 應與 CATALOG 一致（原文照錄）');
      if (r[15].replace(/^'/, '') !== (f.facet != null ? String(f.facet) : '')) throw new Error('CSV ' + f.id + ' 的 facet 應為比對對象的原值（沒有時空白）');
      // 與多數不同（推論，與畫面同一個標籤）：多數決偏離的設備名；平手寫「沒有多數」；不是多數決或沒有 deviation 為空白
      const dvs = f.deviation && f.deviation.basis === 'majority' ? f.deviation.deviating : null;
      const wantDv = !dvs ? '' : dvs.length ? dvs.map((k) => App.Q.devName(k)).join('; ') : '沒有多數';
      if (r[16] !== wantDv) throw new Error('CSV ' + f.id + ' 的與多數不同應為「' + wantDv + '」：' + r[16]);
      if (r.length !== rows[0].length) throw new Error('CSV 第 ' + (i + 2) + ' 列的欄數應與標頭相同');
    });
    // Markdown（依檢查）：每項出現的檢查附處理建議與逐條的常見原因，反引號內是行內程式碼（不被跳脫）
    S.util.uniq(App.snap.findings.map((f) => f.id)).forEach((id) => {
      const sec = md.slice(md.indexOf('\n### ' + id + ' ')); const c = S.check.CATALOG[id];
      const line = sec.split('\n').find((x) => x.startsWith('- 處理建議：'));
      if (!line) throw new Error('Markdown 的 ' + id + ' 應附處理建議');
      Array.from(c.action.matchAll(/`[^`]+`/g)).forEach((m) => { if (!line.includes(m[0])) throw new Error('Markdown 的 ' + id + ' 應以行內程式碼呈現 ' + m[0] + '：' + line); });
      if (line.includes('\\`')) throw new Error('Markdown 的 ' + id + ' 處理建議不應跳脫指令的反引號');
      const lines = sec.split('\n'); const from = lines.indexOf('- 常見原因：');
      const causeLines = from < 0 ? [] : lines.slice(from + 1, from + 1 + c.causes.length);
      if (causeLines.length !== c.causes.length || causeLines.some((x, n) => !x.startsWith('  - ')
        || !Array.from(c.causes[n].matchAll(/`[^`]+`/g)).every((m) => x.includes(m[0])))) throw new Error('Markdown 的 ' + id + ' 應逐條列出常見原因（指令為行內程式碼）');
    });
    // 跳脫：逗號、引號、換行、公式開頭；以人工 finding 走一次完整組字再解析回來
    const X = S.view.exporter;
    [['a,b', '"a,b"'], ['說 "hi"', '"說 ""hi"""'], ['x\ny', '"x\ny"'], ['=1+1', "'=1+1"], [' 空白', '" 空白"'], ['一般', '一般']].forEach(([v, want]) => {
      if (X.csvCell(v) !== want) throw new Error(`csvCell(${JSON.stringify(v)}) 應為 ${want}，實際 ${X.csvCell(v)}`);
    });
    // 匯出的組字函式只透過 Q 讀取：以目前基準的副本換上人工 finding，再建立查詢介面
    const tricky = { ...JSON.parse(JSON.stringify(App.snap)), findings: [{ id: 'T01', severity: 'warn', title: '標題, "引號"', message: '第一行\r\n第二行, "x"',
      entities: [{ type: 'device', key: 'A,B' }], evidence: [{ file: 'a.txt', line: 3, text: '' }, { file: 'b "x".txt', line: 9, text: '' }] }] };
    const tr = parseCsv(X.findingsCsv(S.query(tricky)).replace(/^\uFEFF/, ''));
    if (tr.length !== 2 || tr[1][2] !== '標題, "引號"' || tr[1][3] !== '第一行\r\n第二行, "x"' || tr[1][4] !== 'device:A,B'
      || tr[1][5] !== 'a.txt:3; b "x".txt:9') throw new Error('CSV 跳脫後應能完整解析回原值：' + JSON.stringify(tr[1]));
    // Markdown：依嚴重度分組（錯誤 → 警告 → 提醒），每筆 finding 的檢查代碼與證據行號都在
    const heads = ['error', 'warn', 'info'].map((s) => md.indexOf(`\n## ${S.view.SEV[s]}（`));
    if (heads.some((x) => x < 0) || heads.some((x, i) => i && heads[i - 1] > x)) throw new Error('Markdown 應依嚴重度分組並依序排列');
    App.snap.findings.forEach((f) => {
      const sev = ['error', 'warn', 'info'].indexOf(f.severity); const at = md.indexOf(`\n### ${f.id} `, heads[sev]);
      if (at < 0 || (sev < 2 && at > heads[sev + 1])) throw new Error(`Markdown 的 ${f.id} 應在「${S.view.SEV[f.severity]}」分組下`);
      if (!f.evidence.every((e) => md.includes(` 第 ${e.line} 行：`))) throw new Error(`Markdown 缺少 ${f.id} 的證據行號`);
    });
    const tmd = X.findingsMarkdown(S.query(tricky));
    if (!tmd.includes('標題, "引號"') || !tmd.includes('第一行 第二行')) throw new Error('Markdown 訊息應保留文字並把換行併成一行');
    tricky.findings[0].message = '<b>*x*</b>'; tricky.findings[0].evidence[0].text = 'a`b';
    const emd = X.findingsMarkdown(S.query(tricky));
    if (!emd.includes('\\<b\\>\\*x\\*\\</b\\>') || !emd.includes('`` a`b ``')) throw new Error('Markdown 應跳脫格式字元與行內程式碼的反引號');
    // 與多數不同（推論）：CSV 最後一欄、Markdown 在該筆下另起一行；平手寫「沒有多數」，沒有 deviation 不輸出
    const dk = App.snap.model.devices.slice(0, 2).map((d) => d.key);
    tricky.findings[0].deviation = { basis: 'majority', deviating: dk, groups: [], main: null };
    const dq = S.query(tricky); const dnames = dk.map((k) => dq.devName(k));
    const dcsv = parseCsv(X.findingsCsv(dq).replace(/^\uFEFF/, ''));
    if (dcsv[0][16] !== '與多數不同（推論）' || dcsv[1][16] !== dnames.join('; ')) throw new Error('CSV 應有與多數不同的設備名：' + dcsv[1][16]);
    if (!X.findingsMarkdown(dq).includes('  - 與多數不同（推論）：' + dnames.join('、'))) throw new Error('Markdown 應列出與多數不同的設備');
    tricky.findings[0].deviation = { basis: 'majority', deviating: [], groups: [], main: null };
    const tq = S.query(tricky);
    if (parseCsv(X.findingsCsv(tq).replace(/^\uFEFF/, ''))[1][16] !== '沒有多數' || !X.findingsMarkdown(tq).includes('  - 與多數不同（推論）：沒有多數')) throw new Error('平手時應寫「沒有多數」');
    delete tricky.findings[0].deviation;
    if (X.findingsMarkdown(S.query(tricky)).includes('與多數不同') || parseCsv(X.findingsCsv(S.query(tricky)).replace(/^\uFEFF/, ''))[1][16] !== '') throw new Error('沒有 deviation 時不應輸出與多數不同');
  });
  await step('匯出：網路文件 Markdown／CSV（資料中心「給報告或紀錄」）的檔名與內容來自核心的 S.report，處理紀錄與檢查結果的匯出相同，不改寫基準', async () => {
    const before = JSON.stringify(App.snap);
    const { made, anchors, files } = await captureDownloads(() => {
      if (!hubBtn('export-site-markdown') || !hubBtn('export-site-csv')) throw new Error('資料中心應有網路文件（Markdown、CSV）的匯出按鈕');
      if (hubBtn('export-site-markdown').textContent !== '網路文件（Markdown）' || hubBtn('export-site-csv').textContent !== '網路文件（CSV）') throw new Error('網路文件按鈕的文字不符');
      hubBtn('export-site-markdown').click(); hubBtn('export-site-csv').click();
    });
    if (made.length !== 2 || anchors.length !== 2) throw new Error('網路文件的兩種匯出各應產生一個下載');
    const K = S.view.exporter.KINDS; const names = files.map((f) => f.name);
    if (names.join() !== [K.siteMarkdown.name(App.Q), K.siteCsv.name(App.Q)].join()) throw new Error('網路文件的檔名應依 V.exporter.KINDS：' + names);
    if (!/^sitedoc-\d{8}T\d{6}Z-\d+dev\.md$/.test(names[0]) || !/^sitedoc-\d{8}T\d{6}Z-\d+dev\.csv$/.test(names[1])) throw new Error('網路文件的檔名格式不符：' + names);
    const opts = { ledgerOf: S.view.app.ledgerExport, zones: S.view.l4.zoneOpts(App).opts };
    if (files[0].text !== S.report.siteDocMarkdown(App.Q, opts) || files[1].text !== S.report.siteDocCsv(App.Q, opts)) throw new Error('網路文件的內容應與 S.report 相同');
    if (files[1].bytes.subarray(0, 3).toString('hex') !== 'efbbbf') throw new Error('網路文件 CSV 應以 UTF-8 BOM 開頭');
    if (!files[0].text.startsWith('# 網路文件\n') || !files[0].text.includes('\n## 設備清單（')) throw new Error('網路文件 Markdown 的開頭不符');
    if (JSON.stringify(App.snap) !== before) throw new Error('匯出不可改寫基準');
    // 命名規則的 zones 無法套用（與建立基準時的命名規則不同）：說明原因並不匯出，不靜默改用推論的 zone（與 CLI 一致）
    const saved = App.profileJson;
    S.view.app.setRoundInputs({ profile: { schema: 'ssot-profile/1', id: 'smoke-zones-mismatch', version: '1', zones: [{ on: 'subnet', match: '.', zone: 'ALL' }] } });
    try {
      const err = S.view.l4.zoneOpts(App).error;
      if (!err) throw new Error('前提：不同的命名規則應讓 zoneOpts 回傳錯誤');
      const r = await captureDownloads(() => { hubBtn('export-site-markdown').click(); hubBtn('export-site-csv').click(); });
      if (r.made.length || r.files.length) throw new Error('命名規則的 zones 無法套用時不應匯出網路文件');
      if (!text('#banner').includes('網路文件') || !text('#banner').includes(err)) throw new Error('應以 banner 說明無法匯出網路文件的原因：' + text('#banner'));
    } finally { S.view.app.setRoundInputs({ profile: saved }); }
  });
};
