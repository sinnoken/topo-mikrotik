// 畫面冒煙測試的 step：L4 由外而內：頁首的結論句、三段暴露清單（Q.exposure）、看路徑、內部互通與可達性查詢預設收合。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { document, S, step, $, text, layerBtn, L4, l4State } = require('../helpers.js');

const SECS = ['self', 'dnat', 'routed'];

module.exports = async () => {
  await step('L4 由外而內：頁首第一句是從外部進來的結論，接著三段暴露清單；內部互通、可達性查詢預設收合，判斷的前提在頁尾', async () => {
    const Q = App.Q; const V = S.view;
    App.select(null); layerBtn('l4').click();
    await App.l4Job;
    const ex = Q.exposure();
    if (V.l4.exposure() !== ex) throw new Error('畫面應使用查詢層的暴露清單（同一個快取物件）');
    const run = V.l4.exposureRun(Q);
    if (run && run.steps < 1) throw new Error('暴露清單應分段計算');
    if (process.env.SMOKE_INPUT && run) console.log(`      暴露清單：${run.ms} ms（${run.steps} 段，單段最長 ${run.maxStepMs} ms，牆鐘 ${run.wallMs} ms）`);
    const head = L4().testAll('.work-head')[0]; const sum = $('#l4-ex-summary');
    if (!sum || !head.contains(sum)) throw new Error('結論句應在頁首');
    const st = text('#l4-ex-summary');
    if (!/從外部進來|WAN/.test(st)) throw new Error('結論句應回答從外部進得來什麼：' + st);
    if (!sum.testAll('.chip').some((c) => c.textContent === '推論') || !sum.querySelector('.l4-ex-assume')) throw new Error('結論句後面接「推論」與「前提」連結');
    // 推論只在頁首標一次：三段裡不再掛推論徽章
    if ($('#l4-exposure').testAll('.chip').some((c) => c.textContent === '推論')) throw new Error('暴露清單的段落與列不應再掛「推論」徽章');
    const cards = L4().testAll('.l4-card'); const at = (sel) => cards.findIndex((c) => c.querySelector(sel) || c.matches && c.matches(sel));
    const iEx = cards.indexOf($('#l4-exposure')); const iMx = at('#l4-matrix'); const iRun = at('#l4-run'); const iAs = at('.l4-assume-list');
    if (!(iEx >= 0 && iEx < iMx && iMx < iRun && iRun < iAs)) throw new Error(`順序應是暴露清單 → 內部互通 → 可達性查詢 → 判斷的前提（${iEx}、${iMx}、${iRun}、${iAs}）`);
    const reachFold = $('#l4-reach-fold'); const mxFold = $('#l4-matrix-fold');
    if (!reachFold || reachFold.open || (reachFold.getAttribute("open") != null)) throw new Error('可達性查詢應預設收合');
    if (ex.status === 'no-wan') {
      if (!(mxFold.getAttribute("open") != null)) throw new Error('沒有 WAN 時內部互通應展開');
      if (!st.includes('找不到 WAN')) throw new Error('沒有 WAN 時結論句應說明');
      return;
    }
    // 「前提」連結：展開頁尾的判斷的前提
    const af = $('#l4-assume-fold'); af.removeAttribute('open'); af.open = false;
    sum.querySelector('.l4-ex-assume').click();
    if (!(af.getAttribute("open") != null)) throw new Error('點「前提」應展開判斷的前提');
    // 三段：每段的列與 Q.exposure 一致；拒絕的只寫數字；沒有時寫「沒有」
    const secEl = (k) => $('#l4-exposure').testAll('.l4-ex-sec').find((x) => x.dataset.sec === k);
    SECS.forEach((k) => {
      if (!secEl(k)) throw new Error('應有這一段：' + k);
      // 每段超過 20 列時先列 20 列，其餘「顯示全部（N）」（aria-expanded）；按了列出全部，焦點留在按鈕
      const ng = secEl(k).testAll('tr').filter((tr) => /l4-ex-row/.test(tr.className || '')).length;
      const allBtn = () => secEl(k).querySelector('.l4-ex-all');
      if (ng > 20) throw new Error(`${k} 段預設最多列 20 列（${ng}）`);
      if (allBtn()) {
        if (ng !== 20 || allBtn().getAttribute('aria-expanded') !== 'false' || !/^顯示全部（[\d,]+）$/.test(allBtn().textContent)) throw new Error(`${k} 段超過 20 列時應有「顯示全部（N）」：${allBtn().textContent}`);
        allBtn().click();
        if (allBtn().getAttribute('aria-expanded') !== 'true' || document.activeElement !== allBtn()) throw new Error('按「顯示全部」後應展開，焦點留在按鈕');
      }
      const sec = secEl(k);
      const rows = sec.testAll('tr').filter((tr) => /l4-ex-row/.test(tr.className || ''));
      if (allBtn() && rows.length <= 20) throw new Error(`${k} 段按「顯示全部」後應列出超過 20 列`);
      // 同一台設備、同一個服務與結果的列併成一列（位址在 title）：列數不多於 Q.exposure，每個位址都看得到
      if (!!rows.length !== !!ex[k].rows.length || rows.length > ex[k].rows.length) throw new Error(`${k} 段的列應來自 Q.exposure（${rows.length}／${ex[k].rows.length}）`);
      if (rows.length < 300) {
        const seen = sec.textContent + '\n' + sec.testAll('span').map((x) => x.getAttribute('title') || '').join('\n');
        const miss = ex[k].rows.filter((x) => !seen.includes(x.ip) && !x.dstAny);
        if (miss.length) throw new Error(`${k} 段應列出每個位址（缺 ${miss.map((x) => x.ip).join('、')}）`);
      }
      const byBtn = rows.map((tr) => ex[k].rows[Number(tr.querySelector('.l4-ex-path').dataset.row)]);
      // 1440 不水平捲動（模擬 DOM 量不到寬度，改斷言欄數）：5 欄，入口在目的的第二行，相關檢查是依據下面的代碼 chip（標題在 title）
      if (rows.length) {
        const ths = sec.testAll('th').map((x) => x.textContent);
        if (ths.join('|') !== '目的|服務|允許來源|結果|依據') throw new Error(`暴露清單應只有 5 欄：${ths.join('、')}`);
        if (rows.some((tr) => tr.testAll('td').length !== 5 || !tr.querySelector('.l4-ex-entry'))) throw new Error('每列 5 格，目的格有入口的第二行');
        sec.testAll('.l4-finding').forEach((a) => { if (!/^[A-Z]\d+$/.test(a.textContent) || !(a.getAttribute('title') || '').startsWith(a.textContent + ' ')) throw new Error('相關檢查是代碼 chip，標題在 title：' + a.textContent); });
        sec.testAll('.l4-rule').forEach((a) => { if (a.textContent.length > 24 || !a.getAttribute('title')) throw new Error('依據的規則連結用短文字，完整說明在 title：' + a.textContent); });
      }
      if (rows.some((tr) => /st-deny/.test(tr.className))) throw new Error('拒絕的組合不列出');
      const t = sec.textContent;
      if (!ex[k].rows.length && !t.includes('沒有')) throw new Error(k + ' 段沒有列時應寫「沒有」');
      if (ex.denied[k] && !t.includes(`其餘 ${V.num(ex.denied[k])} 個組合`)) throw new Error(k + ' 段應寫出其餘拒絕的組合數');
      byBtn.slice(0, 20).forEach((x, i) => {
        const tr = rows[i]; const rt = tr.textContent;
        if (!rt.includes(x.ip) && !(x.dstAny && rt.includes('任何位址'))) throw new Error(`${k} 段第 ${i + 1} 列應寫出目的位址 ${x.ip}`);
        if (!rt.includes(x.proto) || !rt.includes(Q.devName(x.dev)) || !rt.includes(x.inInterface)) throw new Error(`${k} 段第 ${i + 1} 列應寫出服務、入口設備與介面`);
        if (!rt.includes(x.allowedFrom.text) || !rt.includes(V.L4_STATUS[x.verdict])) throw new Error(`${k} 段第 ${i + 1} 列應寫出允許來源與結果`);
        if (x.allowedFrom.kind === 'any' && !rt.includes('⚠')) throw new Error('任何來源應另有外形標示（不只靠顏色）');
        if (x.verdict === 'unknown' && x.reasons.length && !x.reasons.every((c) => rt.includes(V.reachReason(c)))) throw new Error('無法判斷的列應寫出原因');
        if (x.rule && x.rule.key && Q.getFirewallRule(x.rule.key) && !tr.querySelector('.l4-rule')) throw new Error('依據應是規則的連結');
        if (x.findingKeys.some((fk) => Q.findingIndexByKey(fk) >= 0) && !tr.querySelector('.l4-finding')) throw new Error('有相關檢查時列尾應有連結');
      });
    });
    if (!process.env.SMOKE_INPUT && !SECS.some((k) => ex[k].rows.length)) throw new Error('範例資料應有從外部連得到的服務');
  });

  await step('L4 暴露清單：看路徑用同一個外部代表位址與入口介面查 Q.reach，結論與列一致；規則與檢查的連結開右側詳情', async () => {
    const Q = App.Q; const ex = Q.exposure(); if (ex.status !== 'ok') return;
    let checked = 0;
    for (const k of SECS) {
      const btns = $('#l4-exposure').testAll('.l4-ex-path').filter((b) => b.dataset.sec === k);
      for (const b of btns.slice(0, 3)) {
        const x = ex[k].rows[Number(b.dataset.row)]; const row = b.dataset.row;
        const btnNow = () => $('#l4-exposure').testAll('.l4-ex-path').find((y) => y.dataset.sec === k && y.dataset.row === row);
        const drillWas = $('#l4-drill').classList.contains('hidden');
        b.click();
        const s = l4State().exPath;
        if (!s || !s.reach) throw new Error(`看路徑應有結果：${s && s.err}`);
        if (s.sec !== k || String(s.row) !== row || s.req.entry !== x.entry || s.req.src !== x.src || s.reach.verdict !== x.verdict) throw new Error(`看路徑應與列一致（${k} ${x.ip} ${x.service}：列 ${x.verdict}，逐跳 ${s.reach.verdict}）`);
        // 就地展開：路徑在那一列的正下方（同一個 tbody 的下一列），不開上方的明細；標題寫結論，焦點到標題
        const tr = btnNow(); let p = tr; while (p && p.tagName !== 'TR') p = p.parentNode;
        const tb = p.parentNode; const nx = tb.childNodes[tb.childNodes.indexOf(p) + 1];
        if (!nx || !/l4-ex-pathrow/.test(nx.className) || !nx.querySelector('#l4-ex-path-title')) throw new Error('看路徑應在那一列的下方展開逐跳路徑');
        if ($('#l4-drill').classList.contains('hidden') !== drillWas) throw new Error('看路徑不應開明細');
        if (document.activeElement !== $('#l4-ex-path-title') || !$('#l4-ex-path-title').textContent.includes(S.view.L4_STATUS[x.verdict])) throw new Error('展開後焦點應在路徑的標題，標題寫出結論');
        if (btnNow().getAttribute('aria-expanded') !== 'true' || $('#l4-exposure').testAll('.l4-ex-pathrow').length !== 1) throw new Error('看路徑的按鈕標 aria-expanded，同時只展開一列');
        // 再按一次收起，焦點回到同一個按鈕；Esc 也收起
        btnNow().click();
        if (l4State().exPath || $('#l4-exposure').testAll('.l4-ex-pathrow').length || document.activeElement !== btnNow() || btnNow().getAttribute('aria-expanded') !== 'false') throw new Error('再按一次應收起，焦點回到那一列的「看路徑」');
        btnNow().click(); $('#l4-ex-path-box').dispatch('keydown', { key: 'Escape' });
        if (l4State().exPath || document.activeElement !== btnNow()) throw new Error('Esc 應收起路徑，焦點回到按鈕');
        checked++;
      }
    }
    if (!process.env.SMOKE_INPUT && !checked) throw new Error('範例資料應能看至少一列的路徑');
    // 矩陣收合時從格子的明細關閉：焦點落在矩陣的標題（不落到看不到的格子）
    { const fold = $('#l4-matrix-fold'); const wasOpen = fold.getAttribute('open') != null;
      fold.removeAttribute('open'); fold.open = false;
      const c = Q.zoneMatrix().cells.find((x) => x.counts.total);
      if (c) { S.view.l4.openCell(App, c.src, c.dst); $('#l4-drill').querySelector('.l4-close').click();
        if (document.activeElement !== $('#l4-matrix-title')) throw new Error('矩陣收合時關閉明細，焦點應在矩陣的標題'); }
      if (wasOpen) { fold.setAttribute('open', ''); fold.open = true; } }
    const link = $('#l4-exposure').testAll('.l4-rule')[0];
    if (link) { link.click(); if (!App.sel || App.sel.type !== 'rule' || App.sel.key !== link.dataset.rule) throw new Error('依據的規則連結應在右側開規則詳情'); }
    const fl = $('#l4-exposure').testAll('.l4-finding')[0];
    if (fl) { const idx = Q.findingIndexByKey(fl.dataset.finding); fl.click(); if (!text('#detail').includes(Q.finding(idx).id)) throw new Error('檢查連結應開那一筆檢查結果'); }
    App.select(null);
  });
};
