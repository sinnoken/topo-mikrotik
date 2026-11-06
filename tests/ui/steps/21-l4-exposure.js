// 畫面冒煙測試的 step：L4 由外而內：頁首的結論句、三段暴露清單（Q.exposure）、看路徑、內部互通與可達性查詢預設收合。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { S, step, $, text, layerBtn, L4, l4State } = require('../helpers.js');

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
    if (ex.status === 'ok' && (!mxFold || mxFold.open || (mxFold.getAttribute("open") != null))) throw new Error('有 WAN 時內部互通（zone 矩陣）應預設收合');
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
    SECS.forEach((k) => {
      const sec = $('#l4-exposure').testAll('.l4-ex-sec').find((x) => x.dataset.sec === k);
      if (!sec) throw new Error('應有這一段：' + k);
      const rows = sec.testAll('tr').filter((tr) => /l4-ex-row/.test(tr.className || ''));
      // 同一台設備、同一個服務與結果的列併成一列（位址在 title）：列數不多於 Q.exposure，每個位址都看得到
      if (!!rows.length !== !!ex[k].rows.length || rows.length > ex[k].rows.length) throw new Error(`${k} 段的列應來自 Q.exposure（${rows.length}／${ex[k].rows.length}）`);
      if (rows.length < 300) {
        const seen = sec.textContent + '\n' + sec.testAll('span').map((x) => x.getAttribute('title') || '').join('\n');
        const miss = ex[k].rows.filter((x) => !seen.includes(x.ip) && !x.dstAny);
        if (miss.length) throw new Error(`${k} 段應列出每個位址（缺 ${miss.map((x) => x.ip).join('、')}）`);
      }
      const byBtn = rows.map((tr) => ex[k].rows[Number(tr.querySelector('.l4-ex-path').dataset.row)]);
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
        const x = ex[k].rows[Number(b.dataset.row)];
        b.click();
        const s = l4State();
        if (!s.reach) throw new Error(`看路徑應有結果：${s.reachErr}`);
        if (s.reachReq.entry !== x.entry || s.reachReq.src !== x.src || s.reach.verdict !== x.verdict) throw new Error(`看路徑應與列一致（${k} ${x.ip} ${x.service}：列 ${x.verdict}，逐跳 ${s.reach.verdict}）`);
        if ($('#l4-drill').classList.contains('hidden') || !$('#l4-l3-title')) throw new Error('看路徑應開逐跳路徑');
        checked++;
      }
    }
    if (!process.env.SMOKE_INPUT && !checked) throw new Error('範例資料應能看至少一列的路徑');
    const link = $('#l4-exposure').testAll('.l4-rule')[0];
    if (link) { link.click(); if (!App.sel || App.sel.type !== 'rule' || App.sel.key !== link.dataset.rule) throw new Error('依據的規則連結應在右側開規則詳情'); }
    const fl = $('#l4-exposure').testAll('.l4-finding')[0];
    if (fl) { const idx = Q.findingIndexByKey(fl.dataset.finding); fl.click(); if (!text('#detail').includes(Q.finding(idx).id)) throw new Error('檢查連結應開那一筆檢查結果'); }
    App.select(null);
  });
};
