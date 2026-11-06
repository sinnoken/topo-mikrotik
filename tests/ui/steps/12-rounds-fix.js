// 畫面冒煙測試的 step：處理紀錄多輪推進與匯出匯入、修正計畫。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { body, head, document, S, path, step, captureDownloads, contrastOf, forSchemes, buildInput, stepBtn, goStep, $, text } = require('../helpers.js');

module.exports = async () => {
  await step('處理紀錄多輪推進：修好判定已修好、又出現標為復發並醒目提示，收集不到的設備列為無法判斷，趨勢圖與表格', async () => {
    const VA = S.view.app; const sample = S.samples['sample-bundle.txt'];
    // 範例的 F06（TPE_CORE_RT_02 以來源埠放行）：拿掉那一行就會消失
    const F06_LINE = '/ip firewall filter add action=accept chain=input protocol=udp src-port=53';
    if (!sample.includes(F06_LINE + '\n')) throw new Error('測試資料：範例應有 F06 的那一行');
    await buildInput(sample + '\n# round-1\n'); await App.ledgerJob;
    const f06 = App.snap.findings.find((f) => f.id === 'F06'); const key = App.Q.findingKey(f06);
    await App.setLedger(f06, { status: 'scheduled', note: '下次維護' });
    if (VA.ledger().items[key].status !== 'scheduled') throw new Error('應可標為已排程修復');
    // 第二輪：修好了
    await buildInput(sample.replace(F06_LINE + '\n', '') + '\n# round-2\n'); await App.ledgerJob;
    if (VA.ledger().items[key].status !== 'fixed') throw new Error('已排程修復的項目消失時應判定為已修好');
    goStep('verify'); // 本輪變化與修復追蹤在「驗證」的中間
    const fixedList = $('#round-body').testAll('.ledger-list').find((l) => l.getAttribute('data-reason') === 'disappeared');
    if (!fixedList || !fixedList.testAll('.ledger-item').some((x) => x.getAttribute('data-key') === key)) throw new Error('本輪變化應列出已修好的項目');
    const fixedTrack = $('#tracking-body').testAll('.ledger-list').find((l) => l.getAttribute('data-status') === 'fixed');
    if (!fixedTrack || !fixedTrack.testAll('.ledger-item').some((x) => x.getAttribute('data-key') === key)) throw new Error('修復追蹤應列出累計已修好的項目');
    // 第三輪：又出現 → 復發
    await buildInput(sample + '\n# round-3\n'); await App.ledgerJob;
    if (VA.ledger().items[key].status !== 'regressed') throw new Error('已修好又出現時應標為復發');
    const nReg = Object.values(VA.ledger().items).filter((it) => it.status === 'regressed' && App.snap.findings.some((f) => App.Q.findingKey(f) === key)).length;
    // 復發的提示在右側的基準狀態卡（.ledger-alert），步驟列「驗證」的狀態也寫出筆數
    goStep('triage'); App.select(null);
    const alert = $('#detail').testAll('.ledger-alert').find((b) => b.getAttribute('data-alert') === 'regressed');
    if (!alert || !alert.textContent.includes(`復發 ${nReg} 項`) || !alert.className.includes('err')) throw new Error('基準狀態應醒目提示復發筆數：' + text('#detail').slice(0, 300));
    alert.click();
    if (App.step !== 'verify' || $('#view-verify').classList.contains('hidden') || document.activeElement !== $('#round-title')) throw new Error('點復發提示應到「驗證」並聚焦本輪變化');
    if (!stepBtn('verify').textContent.includes(`復發 ${nReg}`)) throw new Error('「驗證」的狀態應寫出復發筆數：' + stepBtn('verify').textContent);
    const reList = $('#round-body').testAll('.ledger-list').find((l) => l.getAttribute('data-reason') === 'reappeared');
    if (!reList || !reList.textContent.includes(f06.message)) throw new Error('本輪變化應列出復發的項目');
    reList.querySelector('.ledger-item').click();
    if (!App.sel || App.step !== 'verify') throw new Error('點復發的項目應定位到那筆檢查結果（詳情在右側，留在驗證）');
    // 復發的項目在檢查結果也有標示
    goStep('triage');
    const g06 = document.testAll('#pane-findings .fgroup').find((x) => { const el = x.querySelector('.head .id'); return el && el.textContent === 'F06'; });
    if (g06.querySelector('.head').getAttribute('aria-expanded') === 'false') g06.querySelector('.head').click();
    if (!$('#pane-findings').testAll('.ledger-chip').some((c) => c.getAttribute('data-status') === 'regressed')) throw new Error('檢查結果應標示復發');
    // 同一份基準再開一次：skipped，不顯示變化
    const iters = VA.ledger().iterations.length;
    A_load: { S.view.app.load(App.snap, null); await App.ledgerJob; }
    if (VA.ledger().iterations.length !== iters || VA.ledgerState().round) throw new Error('同一份基準重新載入時不應推進，也不顯示變化');
    // 第四輪：只收集第一台設備，其他設備的待處理項目無法判斷
    const first = sample.split(/\n_{5,}\n/)[0];
    await buildInput(first + '\n# round-4\n'); await App.ledgerJob;
    const st = VA.ledgerState();
    if (!st.round || !st.round.unobserved.length) throw new Error('沒有收集的設備，消失的待處理項目應列為無法判斷');
    if (st.round.unobserved.some((k) => VA.ledger().items[k].status === 'fixed')) throw new Error('無法判斷的項目不可判定為已修好');
    App.select(null);
    const un = $('#detail').testAll('.ledger-alert').find((b) => b.getAttribute('data-alert') === 'unobserved');
    if (!un || !un.textContent.includes(`無法判斷 ${S.view.num(st.round.unobserved.length)} 項`)) throw new Error('基準狀態應提示無法判斷的筆數');
    goStep('verify');
    const unList = $('#round-body').testAll('.ledger-list').find((l) => l.getAttribute('data-reason') === 'unobserved');
    if (!unList || !unList.parentNode.textContent.includes('因收集失敗而無法判斷') || unList.testAll('.ledger-item').length !== Math.min(300, st.round.unobserved.length)) throw new Error('本輪變化應說明因收集失敗而無法判斷');
    // 趨勢：和本輪變化、修復追蹤、比對一起在「驗證」；步驟的狀態是處理紀錄的第幾輪
    const series = S.ledger.summary(VA.ledger()).series;
    if (!stepBtn('verify').textContent.includes(`第 ${VA.ledgerRoundIndex() + 1} 輪`)) throw new Error('「驗證」的狀態應寫出目前是第幾輪：' + stepBtn('verify').textContent);
    App.showView('trend', { focus: true });
    if (App.centerView !== 'verify' || $('#view-verify').classList.contains('hidden') || document.activeElement !== $('#trend-title')) throw new Error('收斂趨勢的入口應開啟驗證並聚焦收斂趨勢的標題');
    if (!$('#view-verify').contains($('#trend-body')) || !$('#view-verify').contains($('#round-body')) || !$('#view-verify').contains($('#tracking-body'))) throw new Error('收斂趨勢、本輪變化、修復追蹤都在驗證畫面');
    // 多輪時畫三張圖（一張一個軸），顏色與線寬取自 theme，hover 顯示該輪全部數值，表格列出每一輪
    const charts = $('#trend-body').testAll('.trend-chart');
    if (charts.length !== 3) throw new Error('應有三張小倍數折線圖：' + charts.length);
    const T = S.view.theme.trend;
    const lines = charts[0].testAll('path').filter((p) => p.className.includes('trend-line'));
    if (lines.map((p) => p.getAttribute('stroke')).join() !== [T.pending, T.regressed, T.accepted].join()) throw new Error('計數圖的三條線應用 theme.trend 的顏色');
    if (charts.some((c) => c.testAll('path').filter((p) => p.className.includes('trend-line')).some((p) => p.getAttribute('stroke-width') !== String(T.lineWidth)))) throw new Error('折線應是 theme.trend.lineWidth 的細線');
    if (charts[0].testAll('.trend-legend-item').length !== 3 || charts[1].querySelector('.trend-legend')) throw new Error('多條線的圖要有圖例，單一條線的不需要');
    // 不只靠顏色：圖例的樣本畫出和線上相同的外形；線尾寫出名稱與數值，數值相同的線不會疊在一起
    charts[0].testAll('.trend-legend-item').forEach((it) => {
      const k = it.getAttribute('data-series'); const sw = it.querySelector('.trend-swatch');
      if (!sw || !sw.all().some((x) => x.getAttribute('data-shape') === T.marker[k])) throw new Error('圖例的樣本應畫出 ' + k + ' 的外形');
    });
    const ends = charts[0].testAll('text').filter((t) => t.className.includes('trend-end'));
    if (ends.length !== 3 || !ends.every((e) => e.textContent.startsWith({ pending: '未結案（含提醒）', regressed: '復發', accepted: '接受風險' }[e.getAttribute('data-series')]))) throw new Error('線尾應寫出名稱與數值');
    const ys = ends.map((e) => +e.getAttribute('y')).sort((a, b) => a - b);
    if (ys.some((y, i) => i && y - ys[i - 1] < 11)) throw new Error('線尾的文字不應重疊：' + ys.join());
    // 文字（座標軸、線尾、tooltip）對圖的底色 ≥ 4.5:1
    const TX = S.view.theme.text;
    forSchemes((mode) => [TX.body, TX.muted].forEach((c) => [S.view.theme.l2.box.fill, S.view.theme.canvas.surface].forEach((bg) => { if (contrastOf(c, bg) < 4.5) throw new Error(`${mode}：趨勢圖的文字 ${c} 對 ${bg} 只有 ${contrastOf(c, bg).toFixed(2)}:1`); })));
    if (!charts[0].testAll('text').every((t) => [TX.body, TX.muted].includes(t.getAttribute('fill')))) throw new Error('趨勢圖的文字應用 theme.text 的文字色，不用資料色');
    const hits = charts[0].testAll('rect').filter((r) => r.className.includes('trend-hit'));
    if (hits.length !== series.length) throw new Error('每一輪應有一個 hover 區');
    hits[hits.length - 1].dispatch('pointerenter');
    const tip = charts[0].querySelector('.trend-tip');
    const lastS = series[series.length - 1];
    if (tip.classList.contains('hidden') || !tip.textContent.includes(S.view.num(lastS.pending)) || !tip.textContent.includes('未結案（含提醒）') || !tip.textContent.includes(S.view.fmtUtc(lastS.at))) throw new Error('hover 應顯示該輪的數值與時間：' + tip.textContent);
    if (tip.testAll('.trend-swatch').length !== 3) throw new Error('tooltip 的每一列應有和圖例相同的樣本');
    hits[hits.length - 1].dispatch('pointerleave');
    if (!tip.classList.contains('hidden')) throw new Error('離開時應隱藏 tooltip');
    // 鍵盤：一張圖只有一個 Tab 停點（最後一輪），方向鍵換輪次並顯示該輪的數值
    if (hits.filter((r) => r.getAttribute('tabindex') === '0').length !== 1 || hits[hits.length - 1].getAttribute('tabindex') !== '0') throw new Error('一張圖只有一個 Tab 停點（最後一輪）');
    hits[hits.length - 1].dispatch('keydown', { key: 'ArrowLeft' });
    const prev = hits[hits.length - 2]; const prevS = series[series.length - 2];
    if (document.activeElement !== prev || prev.getAttribute('tabindex') !== '0' || hits[hits.length - 1].getAttribute('tabindex') !== '-1') throw new Error('左方向鍵應移到上一輪');
    if (tip.classList.contains('hidden') || !tip.textContent.includes(S.view.num(prevS.pending))) throw new Error('鍵盤移到的輪次應顯示它的數值：' + tip.textContent);
    hits[hits.length - 2].dispatch('keydown', { key: 'End' });
    if (document.activeElement !== hits[hits.length - 1]) throw new Error('End 應移到最後一輪');
    if ($('#trend-body').querySelector('.trend-table').testAll('tbody tr').length !== series.length) throw new Error('表格檢視應列出每一輪');
    App.showView('graph');
    // 之後的步驟以範例資料進行（範例的第一輪已在處理紀錄中，不會再推進）
    await buildInput(sample); await App.ledgerJob;
  });
  await step('處理紀錄：只有一輪時顯示目前的數字、不畫圖', () => {
    const lg = S.view.app.ledger(); const one = Object.assign({}, lg, { iterations: lg.iterations.slice(-1) });
    const st = S.view.app.ledgerState(); const keep = st.ledger;
    st.ledger = one; S.view.ledgerPane.render(App); S.view.ledgerPane.renderTrend(App);
    try {
      if ($('#trend-body').testAll('.trend-chart').length || !$('#trend-body').querySelector('.trend-single')) throw new Error('只有一輪時不應畫圖');
      const tiles = $('#trend-body').testAll('.trend-tile').map((x) => x.getAttribute('data-tile'));
      if (tiles.join() !== 'pending,info,accepted,coverage,unknownPeers') throw new Error('應列出待處理、提醒、已豁免、覆蓋率、未知對端（復發只在本輪變化）：' + tiles.join());
    } finally { st.ledger = keep; S.view.ledgerPane.render(App); S.view.ledgerPane.renderTrend(App); }
  });
  await step('舊的確認標記轉換成處理紀錄：寫入成功後才刪 acks；轉換失敗或寫入失敗時保留 acks 並說明', async () => {
    const VA = S.view.app; const Q = App.Q; const all = App.snap.findings;
    const keep = JSON.parse(JSON.stringify(VA.ledger()));
    const [f1, f2] = S.util.uniq(all.map((f) => Q.findingKey(f))).slice(0, 2);
    const acks = { [f1]: { at: '2025-01-02T00:00:00.000Z', kind: 'scheduled', note: '舊的' }, [f2]: { at: '2025-01-03T00:00:00.000Z' } };
    const realError = console.error; console.error = () => {}; // 預期中的錯誤（轉換、寫入失敗）不印出
    try {
      // 轉換成功
      await S.store.del('ledger'); await S.store.set('acks', acks);
      await VA.loadLedger(); await VA.advanceLedger(Q); VA.renderAll();
      const lg = await S.store.get('ledger');
      if (!lg || !S.ledger.validate(lg).ok) throw new Error('轉換後應寫入格式正確的 ledger');
      if (lg.items[f1].status !== 'scheduled' || lg.items[f2].status !== 'accepted' || lg.items[f1].history[0].ack.note !== '舊的') throw new Error('應依舊分類轉換並保留原始紀錄');
      if (await S.store.get('acks')) throw new Error('寫入成功後應刪掉 acks');
      if (!text('#banner').includes('轉換成處理紀錄')) throw new Error('轉換後應提示');
      // 轉換失敗：保留 acks、不寫 ledger，畫面說明
      await S.store.del('ledger'); const bad = { [f1]: { at: 'not-a-date' } }; await S.store.set('acks', bad);
      await VA.loadLedger(); await VA.advanceLedger(Q); VA.renderAll();
      if (JSON.stringify(await S.store.get('acks')) !== JSON.stringify(bad)) throw new Error('轉換失敗時 acks 應原樣保留');
      if (await S.store.get('ledger')) throw new Error('轉換失敗時不應寫入 ledger');
      if (!text('#banner').includes('無法轉換')) throw new Error('轉換失敗應以 banner 說明：' + text('#banner'));
      if (!$('#pane-findings').querySelector('.ledger-blocked') || !text('#ledger-body').includes('無法轉換') || !text('#round-body').includes('無法轉換')) throw new Error('檢查結果與驗證的處理紀錄應說明處理紀錄無法使用');
      if (!stepBtn('verify').textContent.includes('處理紀錄停用')) throw new Error('「驗證」的狀態應說明處理紀錄停用');
      const btn = document.testAll('#pane-findings .ledger-edit')[0];
      if (btn && btn.getAttribute('disabled') === null) throw new Error('處理紀錄無法使用時「處理」應停用');
      // 寫入失敗：acks 保留，之後寫入成功才刪
      await S.store.del('ledger'); await S.store.set('acks', acks);
      const realSet = S.store.set;
      S.store.set = async (k, v) => { if (k === 'ledger') throw new Error('模擬寫入失敗'); return realSet.call(S.store, k, v); };
      try { await VA.loadLedger(); await VA.advanceLedger(Q); } finally { S.store.set = realSet; }
      if (!(await S.store.get('acks')) || await S.store.get('ledger')) throw new Error('寫入失敗時應保留 acks');
      if (!text('#banner').includes('無法儲存處理紀錄') || !text('#banner').includes('保留不刪')) throw new Error('寫入失敗應說明：' + text('#banner'));
      const fx = all.find((f) => Q.findingKey(f) === f1);
      const r = await App.setLedger(fx, { note: '再寫一次' });
      if (!r.ok || !(await S.store.get('ledger')) || await S.store.get('acks')) throw new Error('之後寫入成功時才刪掉 acks');
    } finally {
      console.error = realError;
      await S.store.del('acks'); await S.store.set('ledger', keep); await VA.loadLedger(); VA.renderAll();
    }
  });
  await step('處理紀錄匯出與匯入：匯出 ssot-ledger/1；匯入先 validate，不合法列出錯誤且不覆蓋，合法時確認後才覆蓋', async () => {
    const VA = S.view.app;
    goStep('verify');
    // 匯出與匯入在資料中心；驗證畫面的處理紀錄只有入口，按了會開啟資料中心的處理紀錄那一列
    $('#ledger-body').querySelector('.open-hub').click();
    if ($('#hub').classList.contains('hidden') || document.activeElement !== $('#hub-sec-ledger')) throw new Error('驗證畫面的處理紀錄入口應開啟資料中心並聚焦處理紀錄');
    if (stepBtn('input').getAttribute('aria-current') !== 'step') throw new Error('資料中心開著時目前的一步是「輸入」');
    const btn = (cls) => $('#hub').querySelector('.' + cls);
    const { files } = await captureDownloads(() => btn('ledger-export').click());
    if (files.length !== 1 || !/^ledger-\d{8}T\d{6}Z\.json$/.test(files[0].name)) throw new Error('應下載 ledger-時間.json：' + (files[0] || {}).name);
    const exported = JSON.parse(files[0].text);
    require('assert').deepStrictEqual(exported, VA.ledger());
    if (!S.ledger.validate(exported).ok) throw new Error('匯出的處理紀錄應通過 validate');
    const importText = async (name, body) => {
      const inp = $('#hub').querySelector('.hub-file-ledger');
      inp.files = [{ name, text: async () => body }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 10));
    };
    const before = JSON.stringify(VA.ledger());
    await importText('bad.json', JSON.stringify({ schema: 'ssot-ledger/0', items: [], iterations: {} }));
    const res = $('#hub').querySelector('.ledger-import-result');
    if (!res || !res.textContent.includes('schema') || res.testAll('li').length < 2) throw new Error('不合法時應列出 validate 的錯誤');
    if (JSON.stringify(VA.ledger()) !== before) throw new Error('不合法時不可覆蓋現有的處理紀錄');
    await importText('broken.json', '{not json');
    if (!text('#hub').includes('不是有效的 JSON')) throw new Error('不是 JSON 時應說明');
    // 合法：先確認，按「覆蓋」才取代
    const k = Object.keys(exported.items)[0];
    const mod = JSON.parse(JSON.stringify(exported)); mod.items[k].note = '匯入的備註';
    await importText('good.json', JSON.stringify(mod));
    if (!$('#hub').querySelector('.ledger-import-confirm')) throw new Error('合法時應請使用者確認覆蓋');
    if (VA.ledger().items[k].note === '匯入的備註') throw new Error('確認前不可覆蓋');
    $('#hub').querySelector('.ledger-confirm-import').click(); await new Promise((r) => setTimeout(r, 10));
    if (VA.ledger().items[k].note !== '匯入的備註' || (await S.store.get('ledger')).items[k].note !== '匯入的備註') throw new Error('確認後應覆蓋並存進 store');
    // 還原
    await importText('restore.json', JSON.stringify(exported));
    $('#hub').querySelector('.ledger-confirm-import').click(); await new Promise((r) => setTimeout(r, 10));
    S.view.app.closeHub();
  });
  await step('修正計畫：依檢查、依設備或逐筆選取，依設備列出修改前（原文行號）與修改後（指令），三份 .rsc 與核心一致，下載檔名用 files() 的 base', async () => {
    const Q = App.Q; const RM = S.remediate; const RV = S.view.remediation; const PV = S.view.patchView;
    goStep('triage');
    $('#pane-findings').querySelector('.open-patch').click();
    // 修正計畫在中間的工作畫面（不是對話框）：分頁選取、拓樸圖被蓋住時 inert，焦點移到標題
    if (!PV.isOpen(App) || $('#view-patch').classList.contains('hidden') || $('#dlg-patch')) throw new Error('應在中間開啟修正計畫（不是對話框）');
    if (App.step !== 'fix' || stepBtn('fix').getAttribute('aria-current') !== 'step' || !$('#view-graph').inert || !$('#left').classList.contains('hidden')) throw new Error('修正計畫是「修正」（目前的一步，沒有左側清單），底下的拓樸圖不可聚焦');
    if (document.activeElement !== $('#patch-title') || !$('#view-patch').contains($('#patch-body'))) throw new Error('開啟後焦點應移到修正計畫的標題');
    if (!text('#patch-body').includes('不會連線')) throw new Error('應標示本工具只產生文字，不會連線設備');
    // 唯讀提示：寬螢幕預設展開；窄螢幕預設收成一行（摘要仍寫不會連線），可展開（UX #14）
    const ro = () => $('#patch-body').querySelector('.patch-readonly');
    if (ro().tagName !== 'DETAILS' || ro().getAttribute('open') === null || !ro().querySelector('summary').textContent.includes('不會連線')) throw new Error('寬螢幕的唯讀提示應展開，摘要寫不會連線');
    window.innerWidth = 390;
    try {
      PV.render(App);
      if (ro().getAttribute('open') !== null || !ro().querySelector('summary').textContent.includes('不會連線')) throw new Error('窄螢幕的唯讀提示應收成一行');
      ro().open = true; ro().dispatch('toggle'); PV.render(App);
      if (ro().getAttribute('open') === null) throw new Error('使用者展開後重繪仍保持展開');
    } finally { window.innerWidth = 1200; PV.state.note = null; PV.render(App); }
    // 同一份基準再開啟時保留上次的選取（例如從防火牆畫面開啟的）；全部清除後沒有計畫
    if (PV.state.keys.size) $('#patch-body').querySelector('.patch-clear').click();
    if (!$('#patch-body').querySelector('.patch-empty')) throw new Error('沒有選取時應說明如何選取');
    const autoIds = S.util.uniq(App.snap.findings.map((f) => f.id)).filter((id) => RM.levelOf(id) === 'auto');
    if (!autoIds.length) { if (process.env.SMOKE_INPUT) { App.showView('graph'); return; } throw new Error('範例資料應有 auto 修正'); }
    const chip = (id) => $('#patch-body').testAll('.patch-rule').find((c) => c.getAttribute('data-rule-id') === id);
    // 選取與計畫兩欄都在同一個工作畫面；用鍵盤按檢查時，重繪後焦點留在同一個檢查按鈕
    if (!$('#patch-body').querySelector('.patch-layout') || !$('#patch-body').querySelector('.patch-select') || !$('#patch-body').querySelector('.patch-main')) throw new Error('修正計畫應有「要修正哪些」與計畫兩欄');
    chip(autoIds[0]).focus(); chip(autoIds[0]).click();
    if (document.activeElement !== chip(autoIds[0])) throw new Error('重繪後焦點應留在剛按的檢查按鈕');
    autoIds.slice(1).forEach((id) => chip(id).click());
    if (chip('F03')) chip('F03').click();
    const keys = Array.from(PV.state.keys).sort(S.util.cmp);
    const want = S.util.uniq(App.snap.findings.filter((f) => autoIds.includes(f.id) || f.id === 'F03').map((f) => Q.findingKey(f))).sort(S.util.cmp);
    if (keys.join() !== want.join()) throw new Error('依檢查選取應選到這些檢查的全部檢查結果');
    const plan = RM.plan(Q, keys); const files = RM.files(plan);
    const devs = $('#patch-body').testAll('.patch-dev');
    if (devs.map((d) => d.getAttribute('data-dev')).join() !== plan.devices.map((d) => d.key).join()) throw new Error('應依 plan.devices 的順序分台列出');
    plan.items.forEach((it) => {
      const box = $('#patch-body').testAll('.patch-item').find((b) => b.getAttribute('data-key') === it.key);
      if (!box) throw new Error('每個 item 都應列出：' + it.key);
      if (box.querySelector('.patch-cmd').textContent !== RV.itemApplyLines(plan, it)) throw new Error('修改後應是核心產生的套用指令');
      const links = box.querySelector('.patch-before').testAll('a');
      if (links.length !== it.evidence.length || !it.evidence.every((e, n) => links[n].textContent === `${S.view.fileName(e.file)} 第 ${e.line} 行`)) throw new Error('修改前應列出 evidence 的原文行號');
    });
    // 修改前可點開原文
    const ev = plan.items[0].evidence[0];
    $('#patch-body').querySelector('.patch-before a').click();
    if (!$('#dlg-raw').open || !text('#raw-title').includes(`第 ${ev.line} 行`)) throw new Error('點修改前應開啟原文');
    $('#dlg-raw').close();
    // 沒有產生指令的：F03（choice）與 find 無法區分的 F02 列出原因
    const skipBox = $('#patch-body').querySelector('.patch-skipped');
    plan.skipped.forEach((x) => { if (!skipBox.textContent.includes(x.detail === RM.SKIP_TEXT[x.reason] ? RM.SKIP_TEXT[x.reason] : x.detail)) throw new Error('未產生指令的項目應說明原因：' + x.detail); });
    if (!process.env.SMOKE_INPUT && !plan.skipped.some((x) => x.id === 'F03' && x.reason === 'choice')) throw new Error('F03 應列為 choice，等第二階段');
    // 三份文字：與核心一致，可切換
    const f0 = files[0];
    const pre = () => $('#patch-body').testAll('.patch-dev')[0].querySelector('.patch-file');
    if (pre().textContent !== RM.renderRsc(plan, f0.dev)) throw new Error('預設顯示套用檔，內容應與 renderRsc 相同');
    [['rollback', RM.renderRollback], ['verify', RM.renderVerify], ['apply', RM.renderRsc]].forEach(([k, fn]) => {
      $('#patch-body').testAll('.patch-dev')[0].testAll('button').find((b) => b.getAttribute('data-kind') === k).click();
      if (pre().textContent !== fn(plan, f0.dev)) throw new Error(k + ' 的內容應與核心相同');
    });
    $('#patch-body').querySelector('.patch-copy').click(); await new Promise((r) => setTimeout(r, 5));
    if (!text('#banner').includes('複製')) throw new Error('複製應有提示');
    // 多台：逐檔下載全部＋總表
    if (files.length > 1) {
      const { files: got } = await captureDownloads(() => $('#patch-body').querySelector('.patch-download-every').click());
      const names = files.flatMap((x) => [x.base + '.rsc', x.base + '-rollback.rsc', x.base + '-verify.rsc']);
      if (got.slice(0, -1).map((x) => x.name).join() !== names.join()) throw new Error('逐檔下載的檔名應用 files() 的 base：' + got.map((x) => x.name));
      files.forEach((x, n) => {
        if (got[n * 3].text !== x.apply || got[n * 3 + 1].text !== x.rollback || got[n * 3 + 2].text !== x.verify) throw new Error('下載內容應與 S.remediate 一致');
      });
      const md = got[got.length - 1];
      if (!/^patch-summary-.*\.md$/.test(md.name) || !names.every((n) => md.text.includes(n)) || !md.text.includes('不會連線')) throw new Error('總表應列出每台設備的檔名');
      if (!plan.items.every((it) => md.text.includes(it.risk.text)) || !plan.skipped.every((x) => md.text.includes(x.detail))) throw new Error('總表應列出風險與未產生指令的原因');
    } else if (!process.env.SMOKE_INPUT) throw new Error('範例資料的 auto 修正應涵蓋多台設備');
    // 精簡：免責句只出現一次；上方只有一個主要下載，總表收在「其他格式 ▾」；各設備只有一個下載
    if (text('#view-patch').split('不會連線').length !== 2) throw new Error('「不會連線或改動任何設備」應只出現一次');
    const dlAll = $('#patch-body').querySelector('.patch-download-all');
    const prim = dlAll.testAll('button').filter((b) => b.className.split(' ').includes('primary'));
    const more = dlAll.querySelector('.patch-more');
    if (prim.length !== 1 || !more || more.tagName !== 'DETAILS' || !more.querySelector('summary').textContent.includes('其他格式') || !more.querySelector('.patch-download-summary')) throw new Error('上方應是一個主要下載加「其他格式 ▾」（總表在裡面）');
    if (dlAll.testAll('.patch-download').length) throw new Error('上方不應重複各設備的下載按鈕');
    if ($('#patch-body').testAll('.patch-dev').some((d) => d.testAll('.patch-download').length !== 1)) throw new Error('每台設備應只有一個下載按鈕');
    // 依檢查：類別 ▸ 檢查標題；chip 寫標題（取自檢查目錄），代碼只在 title
    $('#patch-body').testAll('.patch-rule').forEach((c) => {
      const id = c.getAttribute('data-rule-id'); const r = S.query.rule(id); const cat = c.closest ? c.closest('.patch-cat') : null;
      if (!r || !c.textContent.startsWith(r.title) || c.textContent.includes(id) || !c.getAttribute('title').startsWith(id)) throw new Error(`檢查 chip 應寫檢查標題、代碼放 title：${id} ${c.textContent}`);
      if (cat && cat.getAttribute('data-cat') !== r.cat) throw new Error(`${id} 應在類別「${r.cat}」之下`);
    });
    const cats = $('#patch-body').testAll('.patch-cat').map((d) => d.getAttribute('data-cat'));
    const wantCats = S.util.uniq(S.query.rules().filter((r) => App.snap.findings.some((f) => f.id === r.id)).map((r) => r.cat));
    if (cats.join() !== wantCats.join()) throw new Error('依檢查應依檢查目錄的類別分組：' + cats);
    if ($('#patch-body').testAll('.patch-item .chip').some((c) => /^[A-Z]\d\d$/.test(c.textContent))) throw new Error('計畫中的項目不應只寫檢查代碼');
    // 單台：依設備選取，三個 .rsc
    $('#patch-body').querySelector('.patch-clear').click();
    if (PV.state.keys.size) throw new Error('全部清除後選取應為空');
    const sel = $('#patch-body').querySelector('.patch-device');
    // 依設備：已收集的設備排前面（預設選項是有設定可改的設備）；只由鄰居得知的設備名稱常是位址，標「未收集」
    const opts = Array.from(sel.querySelectorAll('option')).map((o) => ({ d: Q.getDevice(o.getAttribute('value')), t: o.textContent }));
    const firstUn = opts.findIndex((o) => o.d && !o.d.collected);
    if (firstUn >= 0 && opts.slice(firstUn).some((o) => o.d && o.d.collected)) throw new Error('依設備應先列已收集的設備');
    opts.forEach((o) => { if (!o.t.startsWith(Q.devLabel(o.d.key)) || (!o.d.collected) !== o.t.includes('未收集')) throw new Error('依設備的選項應寫設備名稱（Q.devLabel），未收集的標出：' + o.t); });
    // 只由 OSPF 得知、名稱是 IP 的設備：選項與詳情標題都寫出來源，不只是一個位址
    const ipOnly = opts.find((o) => !o.d.collected && S.ip.isIp(Q.devName(o.d.key)));
    if (App.snap.model.devices.some((d) => d.key === '172.31.255.2') && (!ipOnly || !opts.some((o) => o.t.startsWith('172.31.255.2（OSPF 鄰居）')))) throw new Error('依設備應以「位址（OSPF 鄰居）」列出只由 OSPF 得知的設備：' + opts.map((o) => o.t).join(' | '));
    if (ipOnly) {
      const back = App.sel; App.select({ type: 'device', key: ipOnly.d.key });
      const h2 = $('#detail').querySelector('h2').textContent;
      if (h2 !== Q.devLabel(ipOnly.d.key) || h2 === Q.devName(ipOnly.d.key)) throw new Error('只由鄰居得知、名稱是 IP 的設備，詳情標題應帶來源：' + h2);
      // 其他給人看的地方也用 Q.devLabel：L2／L3 的節點提示、鏈路與設備對詳情的標題、鄰居表的對端
      const layer0 = App.layer;
      for (const ly of ['l3', 'l2']) {
        App.showLayer(ly); const node = App.graph.nodes.find((n) => (n.dev || n.id) === ipOnly.d.key);
        if (node && !S.view.app.layerTip({ type: 'node', id: node.id }).startsWith(Q.devLabel(ipOnly.d.key))) throw new Error(`${ly} 的節點提示應用 Q.devLabel：` + S.view.app.layerTip({ type: 'node', id: node.id }));
      }
      App.showLayer(layer0);
      const lk = Q.links().find((l) => [l.a, l.b].some((ep) => S.keys.splitEp(ep)[0] === ipOnly.d.key));
      if (lk) {
        App.select({ type: 'link', key: lk.key });
        if (!$('#detail').querySelector('h2').textContent.includes(Q.devLabel(ipOnly.d.key))) throw new Error('鏈路詳情的標題應用 Q.devLabel');
        const other = [lk.a, lk.b].map((ep) => S.keys.splitEp(ep)[0]).find((d) => d !== ipOnly.d.key);
        App.select({ type: 'device', key: other });
        if (!text('#detail').includes(Q.devLabel(ipOnly.d.key))) throw new Error('鄰居表的對端應用 Q.devLabel');
      }
      App.select(back);
    }
    if (opts.some((o) => o.d.collected) && !opts[0].d.collected) throw new Error('預設選項應是已收集的設備');
    sel.value = f0.dev;
    $('#patch-body').querySelector('.patch-add-device').click();
    const devKeys = S.util.uniq(App.snap.findings.filter((f) => Q.findingDevice(f) === f0.dev).map((f) => Q.findingKey(f)));
    if (Array.from(PV.state.keys).sort().join() !== devKeys.sort().join()) throw new Error('依設備應選到這台設備的全部檢查結果');
    const p1 = RM.plan(Q, Array.from(PV.state.keys).sort(S.util.cmp)); const fs1 = RM.files(p1);
    if (fs1.length === 1) {
      // 各設備只有一個下載：正在檢視的檔案（切換套用／回復／驗證後下載另一份）
      const dev0 = () => $('#patch-body').testAll('.patch-dev')[0];
      const got = [];
      for (const k of ['apply', 'rollback', 'verify']) {
        dev0().testAll('button').find((b) => b.getAttribute('data-kind') === k).click();
        const btns = dev0().testAll('.patch-download');
        if (btns.length !== 1) throw new Error('每台設備應只有一個下載按鈕（正在檢視的檔案）：' + btns.length);
        got.push(...(await captureDownloads(() => btns[0].click())).files);
      }
      if (got.map((x) => x.name).join() !== [fs1[0].base + '.rsc', fs1[0].base + '-rollback.rsc', fs1[0].base + '-verify.rsc'].join()) throw new Error('單台應可下載三個 .rsc：' + got.map((x) => x.name));
      if (got[0].text !== RM.renderRsc(p1, fs1[0].dev)) throw new Error('單台下載的套用檔應與 renderRsc 相同');
      dev0().testAll('button').find((b) => b.getAttribute('data-kind') === 'apply').click();
    }
    // 逐筆勾選
    $('#patch-body').querySelector('.patch-clear').click();
    const grp = $('#patch-body').testAll('.patch-group').find((g) => g.getAttribute('data-rule-id') === autoIds[0]);
    grp.open = true; grp.dispatch('toggle');
    const cb = grp.querySelector('.patch-pick'); cb.focus(); cb.checked = true; cb.dispatch('change');
    if (!PV.state.keys.has(cb.getAttribute('data-key')) || PV.state.keys.size !== 1) throw new Error('逐筆勾選應加入選取');
    if (!$('#patch-body').testAll('.patch-item').length && !$('#patch-body').querySelector('.patch-skipped')) throw new Error('勾選後應產生計畫');
    // 重繪後展開的檢查仍展開，焦點留在剛勾選的那一筆
    const grp2 = $('#patch-body').testAll('.patch-group').find((g) => g.getAttribute('data-rule-id') === autoIds[0]);
    const cb2 = grp2.testAll('.patch-pick').find((x) => x.getAttribute('data-key') === cb.getAttribute('data-key'));
    if (grp2.getAttribute('open') === null || !cb2 || !cb2.checked || document.activeElement !== cb2) throw new Error('勾選後展開的檢查應保持展開，焦點留在同一筆');
    // 「逐筆勾選」整區：瀏覽器以 open 屬性建立 <details> 時也會排入 toggle 事件，狀態沒變時不算使用者切換
    const pb = () => $('#patch-body').querySelector('.patch-picks-box');
    PV.state.picks = null; PV.render(App);
    if (pb().getAttribute('open') === null) throw new Error('測試前提：有展開的檢查時「逐筆勾選」應展開');
    pb().open = true; pb().dispatch('toggle'); // 模擬 DOM 不會把 open 屬性反映到 .open：照瀏覽器的行為設定
    if (PV.state.picks !== null) throw new Error('建立時排入的 toggle 不應被記成使用者的選擇');
    pb().open = false; pb().dispatch('toggle');
    if (PV.state.picks !== false) throw new Error('使用者收合「逐筆勾選」應記下');
    PV.state.picks = null; PV.render(App);
    // 點未產生指令的一筆：在右側開啟該筆，修正計畫留在中間
    const ref = $('#patch-body').querySelector('.finding-ref');
    if (ref) {
      App.select(null); ref.click();
      const f = App.Q.finding(+ref.getAttribute('data-finding-idx'));
      if (!PV.isOpen(App) || (f.entities.length && !App.sel)) throw new Error('點修正計畫中的檢查結果時，修正計畫應留在中間，右側顯示詳情');
    }
    App.showView('graph');
  });
  await step('修正計畫的選擇（A12）：NTP 預設採多數（推論）並修改偏離的設備，DNS 沒有多數時提示選擇，選了某一組才產生指令，選「不修改」寫入處理紀錄；畫面與總表沒有 undefined', async () => {
    const Q = App.Q; const RM = S.remediate; const RV = S.view.remediation; const PV = S.view.patchView; const VA = S.view.app;
    const a12 = new Map(Q.findings().filter((f) => f.id === 'A12').map((f) => [f.facet, f]));
    if (!a12.has('dns') || !a12.has('ntp')) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有 A12 的 DNS 與 NTP'); }
    const dnsF = a12.get('dns'); const dnsKey = Q.findingKey(dnsF); const ntpKey = Q.findingKey(a12.get('ntp'));
    // 前面的步驟（匯入與還原處理紀錄）留下的狀態不一定允許改為接受風險：以空白的處理紀錄進行，結束時還原
    const savedLedger = VA.ledgerJson();
    App.importLedger('empty.json', JSON.stringify(S.ledger.empty())); await App.confirmImport();
    if (VA.ledgerStatus(dnsF) !== 'open') throw new Error('前提：空白的處理紀錄推進後 DNS 這筆是待處理');
    try {
      PV.open(App, [dnsKey, ntpKey]);
      const body = () => $('#patch-body');
      const block = (k) => body().testAll('.patch-choice').find((b) => b.getAttribute('data-finding') === k);
      const radio = (k, id) => block(k).testAll('.patch-choice-opt').find((r) => r.value === id);
      const noUndefined = (where) => { if (text('#patch-body').includes('undefined')) throw new Error(where + '：修正計畫不應出現 undefined'); };
      /** 計畫中這筆選擇產生的 item 都顯示在所屬設備下：對象是伺服器（不是規則）、修改前→後、警告與核心產生的指令 */
      const checkItems = (plan, c) => c.items.map((k) => {
        const it = plan.items.find((i) => i.key === k);
        const box = body().testAll('.patch-dev').find((b) => b.getAttribute('data-dev') === it.dev).testAll('.patch-item').find((b) => b.getAttribute('data-key') === k);
        if (!box) throw new Error('選擇產生的指令應列在 ' + it.dev + ' 下');
        const tgt = box.querySelector('.patch-target').textContent;
        if (tgt !== RV.targetText(it.target) || !tgt.includes(RV.FACET_ITEM[c.facet]) || !tgt.includes(it.target.menu)) throw new Error('對象應顯示伺服器的項目與設定選單：' + tgt);
        if (!box.textContent.includes(it.note) || !it.warnings.every((w) => box.textContent.includes(w))) throw new Error('應顯示修改前→後（note）與警告');
        if (box.querySelector('.patch-cmd').textContent !== RV.itemApplyLines(plan, it)) throw new Error('指令應由核心產生');
        return it.dev;
      });
      noUndefined('開啟時');
      // NTP：有多數時預設採多數，標示推論與依據，修改不在多數組的設備
      const plan0 = PV.state.plan; const ntp = plan0.choices.find((c) => c.findingKey === ntpKey);
      const maj = ntp.options.find((o) => o.id === 'majority');
      if (!maj || ntp.chosen !== 'majority' || ntp.chosenBy !== 'default' || !radio(ntpKey, 'majority').checked) throw new Error('有多數時預設應選多數');
      const majRow = block(ntpKey).testAll('.patch-choice-row').find((r) => r.getAttribute('data-option') === 'majority');
      if (!majRow.querySelector('.patch-inferred') || !majRow.textContent.includes('推論') || !majRow.textContent.includes(`${maj.basis.total} 台中 ${maj.basis.agree} 台`)) throw new Error('多數選項應標示推論與依據');
      if (!block(ntpKey).querySelector('.patch-choice-default')) throw new Error('預設採多數時應說明');
      // UX #13：代碼不露出（在 title）、推論只標一次（chip），訊息用一般文字色、另有明確的連結開啟該筆
      [ntpKey, dnsKey].forEach((k) => {
        const head = block(k).querySelector('.patch-choice-head');
        if (!head || head.querySelector('.chip') || /\bA12\b/.test(head.textContent) || !/A12/.test(head.querySelector('b').getAttribute('title'))) throw new Error('選擇的標題不顯示代碼 chip，代碼放 title：' + (head && head.textContent));
        const msg = block(k).querySelector('.patch-choice-msg');
        if (!msg || msg.className.includes('link') || !msg.querySelector('.finding-ref')) throw new Error('檢查結果的訊息用一般文字，另有連結開啟該筆');
      });
      if ((majRow.textContent.match(/推論/g) || []).length !== 1) throw new Error('多數選項的「推論」只標一次（chip）：' + majRow.textContent);
      const ntpDevs = checkItems(plan0, ntp);
      if (!ntpDevs.length || ntpDevs.some((d) => maj.basis.devs.includes(d))) throw new Error('採多數時應修改不在多數組的設備');
      if (!ntpDevs.includes('TPE_ACC_SW_12')) throw new Error('範例資料的 NTP 應修改偏離的 TPE_ACC_SW_12');
      // DNS：沒有多數時明確提示，沒有預設的選擇，也不產生指令
      const dns0 = plan0.choices.find((c) => c.findingKey === dnsKey);
      if (dns0.reason !== 'needs-choice') throw new Error('範例資料的 DNS 應沒有多數');
      if (!block(dnsKey).querySelector('.patch-choice-need').textContent.includes('沒有多數') || block(dnsKey).testAll('.patch-choice-opt').some((r) => r.checked)) throw new Error('沒有多數時應提示選擇，且沒有預選');
      if (plan0.items.some((i) => i.findingKey === dnsKey)) throw new Error('選擇前不應產生 DNS 的指令');
      // 選一組（不含 RT_01 的那組）：其他組的設備（含 RT_01）產生指令；焦點留在剛選的 radio
      const pick = dns0.options.find((o) => o.devs && !o.devs.includes('TPE_CORE_RT_01'));
      const r = radio(dnsKey, pick.id); r.checked = true; r.dispatch('change');
      if (PV.state.choices.get(dnsKey) !== pick.id) throw new Error('選擇應存在修正計畫的檢視狀態');
      const plan1 = PV.state.plan; const dns1 = plan1.choices.find((c) => c.findingKey === dnsKey);
      if (dns1.chosenBy !== 'user' || dns1.chosen !== pick.id || !radio(dnsKey, pick.id).checked) throw new Error('應以選擇重新產生計畫');
      if (document.activeElement !== radio(dnsKey, pick.id)) throw new Error('重新產生後焦點應留在剛選的 radio（鍵盤操作）');
      const dnsDevs = checkItems(plan1, dns1);
      const others = dns0.options.filter((o) => o.devs && o.id !== pick.id).flatMap((o) => o.devs);
      if (dnsDevs.slice().sort().join() !== others.slice().sort().join() || !dnsDevs.includes('TPE_CORE_RT_01')) throw new Error('選一組後應修改其他組的設備（範例資料是 TPE_CORE_RT_01）');
      // 預覽與下載都跟著選擇：每台設備的檔案就是 files(plan) 的內容，總表列出選擇
      const files = RM.files(plan1);
      files.forEach((f) => { if (body().testAll('.patch-dev').find((b) => b.getAttribute('data-dev') === f.dev).querySelector('.patch-file').textContent !== f.apply) throw new Error('預覽應是依選擇產生的檔案'); });
      noUndefined('選擇後');
      const md = S.view.exporter.patchSummaryMarkdown(plan1, files, Q);
      if (md.includes('undefined') || !md.includes('需要選擇的項目') || !md.includes(RV.choiceText(dns1).text)) throw new Error('總表應列出目前的選擇，且沒有 undefined');
      // 選「不修改」：不產生指令，畫面填原因後以 S.ledger 標為接受風險
      const acc = radio(dnsKey, 'accept'); acc.checked = true; acc.dispatch('change');
      const plan2 = PV.state.plan;
      if (plan2.choices.find((c) => c.findingKey === dnsKey).reason !== 'accepted-choice' || plan2.items.some((i) => i.findingKey === dnsKey)) throw new Error('選不修改時不應產生指令');
      const ledgerBefore = JSON.stringify(VA.ledger());
      block(dnsKey).querySelector('.patch-accept-save').click(); await new Promise((res) => setTimeout(res, 10));
      if (JSON.stringify(VA.ledger()) !== ledgerBefore || block(dnsKey).querySelector('.ledger-error').classList.contains('hidden')) throw new Error('沒有原因時應顯示錯誤，處理紀錄不變');
      block(dnsKey).querySelector('.patch-accept-reason').value = '兩台各自使用不同的上游 DNS';
      block(dnsKey).querySelector('.patch-accept-save').click(); await new Promise((res) => setTimeout(res, 10));
      const it = VA.ledgerItem(dnsF);
      if (it.status !== 'accepted' || it.waiver.reason !== '兩台各自使用不同的上游 DNS' || (await S.store.get('ledger')).items[dnsKey].status !== 'accepted') throw new Error('選不修改後處理紀錄應變成接受風險並存進 store');
      if (!PV.isOpen(App) || !block(dnsKey).querySelector('.patch-accept-done')) throw new Error('標為接受風險後修正計畫應維持開啟並顯示處理紀錄的狀態');
      noUndefined('標為接受風險後');
    } finally {
      PV.state.choices.clear(); App.showView('graph');
      App.importLedger('restore.json', savedLedger); await App.confirmImport();
    }
  });
};
