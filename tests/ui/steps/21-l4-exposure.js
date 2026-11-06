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
        const ths = sec.testAll('thead th').map((x) => x.textContent);
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
    // 第 1 段依設備分組：每台設備一個標題列、列連續；入口設備（有 via 為 null 的列）在前；經別台入口設備的列寫「經 <入口設備> 的 <介面>」
    if (ex.self.rows.length) {
      const sec = secEl('self'); const entryDevs = new Set(ex.self.rows.filter((x) => x.via === null).map((x) => x.dev));
      const trs = sec.testAll('tr').filter((tr) => /l4-ex-(row|devrow)/.test(tr.className || ''));
      const order = []; let cur = null;
      trs.forEach((tr) => {
        if (/l4-ex-devrow/.test(tr.className)) {
          cur = tr.getAttribute('data-dev'); order.push(cur);
          const isEntry = entryDevs.has(cur);
          if (!tr.textContent.includes(Q.devName(cur)) || !tr.textContent.includes(isEntry ? '入口設備' : '經其他入口設備')) throw new Error('設備標題列應寫出設備名與是否為入口設備：' + tr.textContent);
          return;
        }
        const x = ex.self.rows[Number(tr.getAttribute('data-row'))];
        if (!x || x.dev !== cur) throw new Error('第 1 段的列應在它的設備標題列之下');
        const et = tr.querySelector('.l4-ex-entry').textContent;
        if (x.via ? !et.startsWith(`經 ${Q.devName(x.via.dev)} 的 ${x.inInterface}`) : et.startsWith('經 ')) throw new Error('入口的寫法不符（via ' + JSON.stringify(x.via) + '）：' + et);
      });
      if (new Set(order).size !== order.length) throw new Error('同一台設備的列應連續（只有一個標題列）：' + order.join('、'));
      const firstNon = order.findIndex((d) => !entryDevs.has(d));
      if (firstNon >= 0 && order.slice(firstNon).some((d) => entryDevs.has(d))) throw new Error('入口設備應排在前面：' + order.join('、'));
      if (!process.env.SMOKE_INPUT && !ex.self.rows.some((x) => x.via)) throw new Error('範例資料的第 1 段應有經別台入口設備的列');
      // 分組的 helper（exGroups）不因 via 拿掉允許在前的規則：同一台設備內允許排在無法判斷之前
      const gs = V.l4.exGroups(ex.self.rows);
      order.forEach((d) => {
        const vs = gs.filter((g) => g.x.dev === d).map((g) => g.x.verdict); const fn = vs.findIndex((v) => v !== 'allow');
        if (fn >= 0 && vs.slice(fn).includes('allow')) throw new Error(d + ' 的允許應在無法判斷之前');
      });
    }
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

  await step('L4 暴露清單的排序與邊界：允許排在無法判斷之前（前 20 列都是無法判斷時也看得到允許）；看路徑的列超過 300 列上限時另接在最後；畫面丟錯時 App.l4Job 仍會結束並寫出原因', async () => {
    if (process.env.SMOKE_INPUT) return; // 用範例資料的 dst-nat 列造資料
    const V = S.view; const realQ = App.Q; const real = realQ.exposure(); const base = real.dnat.rows[0];
    if (!base) throw new Error('測試前提：範例資料有 dst-nat 的列');
    // 一段 330 組：前 25 組無法判斷、第 26 組允許，其餘無法判斷（查詢層只依設備、位址、服務排序，不依結果）
    const rows = Array.from({ length: 330 }, (_, n) => Object.assign({}, base, { service: `tcp/${2000 + n}`, port: 2000 + n, verdict: n === 25 ? 'allow' : 'unknown', reasons: [], incomplete: false, returnUnsafe: [] }));
    const fake = Object.assign({}, real, { dnat: Object.assign({}, real.dnat, { rows }) });
    const gs = V.l4.exGroups(rows);
    if (gs[0].x.verdict !== 'allow' || gs.slice(1).some((g) => g.x.verdict !== 'unknown') || gs.slice(1).some((g, k) => k && g.i < gs[k].i)) throw new Error('分組應允許在前、同結果內保留原順序');
    // App.Q 是唯讀（App.round.Q）：測試暫時換成只改 exposureSteps 的查詢介面，結束時換回
    const withQ = async (q, after) => { App.showLayer('device'); App.round.Q = q; App.showLayer('l4', { rebuild: true }); if (after) after();
      const r = await Promise.race([App.l4Job.then(() => 'ok'), new Promise((res) => setTimeout(() => res('timeout'), 5000))]);
      if (r !== 'ok') throw new Error('App.l4Job 應結束'); };
    try {
      await withQ(Object.assign(Object.create(realQ), { exposureSteps: function* () { return fake; } }));
      const sec = $('#l4-exposure').testAll('.l4-ex-sec').find((x) => x.dataset.sec === 'dnat');
      const trs = () => sec.testAll('tr').filter((tr) => /l4-ex-row/.test(tr.className));
      if (trs().length !== 20 || !/st-allow/.test(trs()[0].className)) throw new Error('前 20 列應先列允許的那一組');
      // 看路徑的列在 300 列之後：另接在最後、展開路徑、焦點到路徑的標題
      V.l4.openExposure(App, 'dnat', 329);
      const sec2 = $('#l4-exposure').testAll('.l4-ex-sec').find((x) => x.dataset.sec === 'dnat');
      const btn = sec2.testAll('.l4-ex-path').find((b) => b.dataset.row === '329');
      if (!btn || btn.getAttribute('aria-expanded') !== 'true' || document.activeElement !== $('#l4-ex-path-title') || !sec2.textContent.includes('另接在最後')) throw new Error('超過上限的列看路徑時應另接在最後並展開，焦點在路徑的標題');
      // 第 1 段：入口設備 25 組全是無法判斷、非入口設備（經入口設備進來）1 組允許——允許的設備排在前面，收合時允許的列在前 20 列
      const sb = real.self.rows.find((x) => x.via === null);
      const other = App.Q.devices().map((d) => d.key).find((d) => sb && d !== sb.dev);
      if (!sb || !other) throw new Error('測試前提：範例資料第 1 段有入口設備的列，且有別台設備');
      V.l4.openExposure(App, 'dnat', 329); // 收起路徑
      const selfRows = Array.from({ length: 25 }, (_, n) => Object.assign({}, sb, { service: `tcp/${3000 + n}`, port: 3000 + n, verdict: 'unknown', reasons: [], incomplete: false, returnUnsafe: [], findingKeys: [] }))
        .concat([Object.assign({}, sb, { dev: other, target: other, via: { dev: sb.dev, ep: sb.entry }, ip: '10.250.0.1', service: 'tcp/22', port: 22, verdict: 'allow', reasons: [], incomplete: false, returnUnsafe: [], findingKeys: [] })]);
      const sg = V.l4.exGroups(selfRows);
      if (sg[0].x.dev !== other || sg[0].x.verdict !== 'allow') throw new Error('有允許的設備應排在只有無法判斷的入口設備之前');
      const renderSelf = async (rs) => {
        const fk = Object.assign({}, real, { self: Object.assign({}, real.self, { rows: rs }) });
        await withQ(Object.assign(Object.create(realQ), { exposureSteps: function* () { return fk; } }));
        const ssec = $('#l4-exposure').testAll('.l4-ex-sec').find((x) => x.dataset.sec === 'self');
        const strs = ssec.testAll('tr').filter((tr) => /l4-ex-row/.test(tr.className));
        const g = V.l4.exGroups(rs); const shownIdx = strs.map((tr) => Number(tr.getAttribute('data-row')));
        // 收合 20 列：每一列允許都在顯示的列裡，顯示的列仍依設備分組的順序
        if (strs.length !== 20 || !rs.every((x, i) => x.verdict !== 'allow' || shownIdx.includes(i))) throw new Error('收合時每一列允許都應在前 20 列');
        if (shownIdx.some((v, k) => k && g.findIndex((y) => y.i === v) < g.findIndex((y) => y.i === shownIdx[k - 1]))) throw new Error('收合時顯示的列應依設備分組的順序');
        return ssec.testAll('tr').filter((tr) => /l4-ex-devrow/.test(tr.className)).map((tr) => tr.getAttribute('data-dev'));
      };
      const heads = await renderSelf(selfRows);
      if (heads.join('|') !== [other, sb.dev].join('|')) throw new Error('設備分組的順序應是有允許的設備在前：' + heads.join('、'));
      // 兩台都有允許：入口設備在前，它的 25 組無法判斷不會把另一台的允許擠出前 20 列（收合以「允許優先」挑列）
      const both = selfRows.concat([Object.assign({}, selfRows[0], { service: 'tcp/8291', port: 8291, verdict: 'allow' })]);
      const heads2 = await renderSelf(both);
      if (heads2.join('|') !== [sb.dev, other].join('|')) throw new Error('都有允許時入口設備在前：' + heads2.join('、'));
      // 畫面丟錯兩次（畫錯誤時又丟錯）：App.l4Job 仍會結束，兩次的原因都寫出來
      // 同步的部分（計算中的頁首、zone 的依據）畫完之後才讓 V.chip 丟錯：之後畫結果與畫錯誤都會失敗
      const chip0 = V.chip; try { await withQ(Object.assign(Object.create(realQ), { exposureSteps: function* () { return fake; } }), () => { V.chip = () => { throw new Error('模擬畫面錯誤'); }; }); } finally { V.chip = chip0; }
      const al = $('#l4-exposure').querySelector('.l4-ex-error');
      if (!al || al.getAttribute('role') !== 'alert' || (al.textContent.match(/模擬畫面錯誤/g) || []).length < 2) throw new Error('畫錯誤時又丟錯應寫出兩次的原因：' + text('#l4-exposure'));
    } finally { App.showLayer('device'); App.round.Q = realQ; App.showLayer('l4', { rebuild: true }); await App.l4Job; App.showLayer('device'); }
  });

  await step('L4 結果分層：暴露清單的「結果」格第二行寫「路由 → 防火牆」；其餘拒絕依 deniedBy 拆成沒有路由、防火牆拒絕、沒被 dst-nat 改寫，沒判斷（上限）另寫', async () => {
    const V = S.view;
    // 純函式：只寫非 0 的部分；notEvaluated 另寫；都沒有時是空字串
    const s1 = V.l4.deniedSentence(5, { noRoute: 2, filter: 3, notNatted: 0 }, 4);
    if (!s1.includes('其餘 5 個組合') || !s1.includes('沒有路由 2') || !s1.includes('防火牆拒絕 3') || s1.includes('dst-nat') || !s1.includes('4 個沒判斷（上限）')) throw new Error('deniedSentence 應拆開拒絕並另寫沒判斷：' + s1);
    const s2 = V.l4.deniedSentence(1, { noRoute: 0, filter: 0, notNatted: 1 }, 0);
    if (!s2.includes('沒被 dst-nat 改寫 1') || s2.includes('沒判斷') || s2.includes('沒有路由')) throw new Error('deniedSentence 只寫非 0 的部分：' + s2);
    if (V.l4.deniedSentence(0, { noRoute: 0, filter: 0, notNatted: 0 }, 0) !== '') throw new Error('沒有拒絕也沒有沒判斷時不寫');
    if (!V.l4.deniedSentence(0, { noRoute: 0, filter: 0, notNatted: 0 }, 3).includes('3 個沒判斷（上限）')) throw new Error('只有沒判斷時也要寫');
    App.select(null); App.showLayer('l4'); await App.l4Job;
    const ex = App.Q.exposure(); if (ex.status !== 'ok') { App.showLayer('device'); return; }
    let rowsSeen = 0;
    for (const k of SECS) {
      const sec = $('#l4-exposure').testAll('.l4-ex-sec').find((x) => x.dataset.sec === k);
      const by = ex.deniedBy[k];
      if (by.noRoute + by.filter + by.notNatted !== ex.denied[k]) throw new Error(`前提：${k} 段 deniedBy 的合計等於 denied`);
      const want = V.l4.deniedSentence(ex.denied[k], by, ex[k].counts.notEvaluated || 0);
      const p = sec.querySelector('.l4-ex-denied');
      if (want ? !p || p.textContent !== want : p) throw new Error(`${k} 段的「其餘拒絕」應依 deniedBy 拆開：${p && p.textContent}／${want}`);
      sec.testAll('tr').filter((tr) => /l4-ex-row/.test(tr.className || '')).forEach((tr) => {
        const res = tr.querySelector('.l4-ex-res'); const ly = res && res.querySelector('.l4-layers');
        if (!ly || !ly.textContent.includes('防火牆')) throw new Error(`${k} 段的列在結果格應有「路由 → 防火牆」：${tr.textContent.slice(0, 80)}`);
        if (tr.dataset.family !== 'ipv6') {
          if (!/路由 [✓✕?] → 防火牆 [✓✕?—]/.test(ly.textContent)) throw new Error('IPv4 的列寫「路由 ✓ → 防火牆 ✓」：' + ly.textContent);
          const v = tr.querySelector('.l4-ex-verdict').dataset.verdict;
          if (v === 'allow' && (ly.dataset.route !== 'reached' || ly.dataset.filter !== 'allow')) throw new Error('允許的列應是路由 ✓ → 防火牆 ✓');
          if (v === 'unknown' && !(ly.dataset.route === 'unknown' || ly.dataset.filter === 'unknown')) throw new Error('無法判斷的列至少一層是 ?');
        }
        // 原因依 layer 分組，每組前面寫「路由：」「防火牆：」等
        const rs = res.querySelector('.l4-ex-reasons');
        if (rs && !Object.values(V.REACH_LAYER).some((l) => rs.textContent.trim().startsWith(l + '：'))) throw new Error('列的原因應依 layer 分組並寫出層名：' + rs.textContent);
        rowsSeen++;
      });
    }
    if (!process.env.SMOKE_INPUT && !rowsSeen) throw new Error('範例資料的暴露清單應有列');
    App.showLayer('device');
  });
  await step('L4 暴露清單的 IPv6 與回程：IPv6 的說明取自 exposure.ipv6（狀態、原因、缺少的設備）；IPv6 列寫位址或「整個網段 x 的主機」、沒有逐跳路徑；回程不保證的列與逐跳的跳標「⚠ 回程不保證」，規則可點', async () => {
    const VA = S.view.app; const V = S.view;
    // 範例資料：沒有 IPv6 位址的事實（no-ipv6-address），說明照列查詢層的 message 與缺少的設備
    { App.showLayer('l4'); await App.l4Job;
      const v6 = App.Q.exposure().ipv6; const note = text('#l4-ex-ipv6');
      if (!v6 || !note.includes(v6.message)) throw new Error('IPv6 的說明應照列 exposure.ipv6.message：' + note);
      (v6.missing || []).forEach((m) => { if (!note.includes(App.Q.devName(m.dev)) || !note.includes(V.L4_IPV6_MISSING[m.reason])) throw new Error('缺少 IPv6 的設備應列出原因：' + m.dev); });
      if ($('#l4-ex-ipv6').dataset.status !== v6.status) throw new Error('IPv6 說明應標狀態'); }
    if (process.env.SMOKE_INPUT) { App.showLayer('device'); return; }
    // 自建網路：R 的 ether1 是 WAN，ether2 是 LAN，ether3 是公網網段（沒有 NAT）；forward 放行到 203.0.113.2:443 後全部丟棄（回程不保證，F15）；
    // IPv6：forward 只限埠（F05），位址直接加進 ipAddresses（基準還沒有 IPv6 位址的事實，見 tests/core/reach-ipv6.js）
    const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
    const text0 = ['R (192.168.1.1):', '### /export terse', '/interface list add name=WAN', '/interface list add name=LAN',
      '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=ether2 list=LAN',
      '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0', '/ip address add address=192.168.1.1/24 interface=ether2 network=192.168.1.0',
      '/ip address add address=203.0.113.1/29 interface=ether3 network=203.0.113.0',
      '/ip firewall filter add action=accept chain=forward dst-address=203.0.113.2 dst-port=443 in-interface-list=WAN protocol=tcp',
      '/ip firewall filter add action=drop chain=forward',
      '/ipv6 firewall filter add action=accept chain=forward connection-state=established,related', '/ipv6 firewall filter add action=accept chain=forward dst-port=443 protocol=tcp',
      '/ipv6 firewall filter add action=drop chain=forward in-interface-list=WAN',
      '/ipv6 firewall filter add action=accept chain=input connection-state=established,related', '/ipv6 firewall filter add action=drop chain=input in-interface-list=WAN',
      '### /ip route print detail without-paging', RT,
      ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0', ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=ether2 distance=0',
      ' DAc dst-address=203.0.113.0/29 routing-table=main gateway=ether3 distance=0', ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1', ''].join('\n');
    const orig = { snap: App.snap, sources: App.round.sources, profile: App.round.profile };
    const sources = [{ name: 'r.txt', text: text0 }];
    try {
      const snap = S.build(sources, { now: '2026-01-01T00:00:00Z' });
      [['ether1', '3fff:0:1::2/64'], ['ether2', '3fff:0:2::1/64']].forEach(([ifc, address]) => { const [ip, len] = address.split('/');
        snap.model.ipAddresses.push({ address, ip, len: +len, family: 6, vrf: 'main', role: null, dev: 'R', ep: 'R|' + ifc, hearsay: false, src: [[0, 0]] }); });
      App.showLayer('device'); // 讀入新基準時不在 L4（否則讀入本身會重開 L4，這裡等到的是被取代的計算）
      VA.load(snap, null, { sources }); await App.ledgerJob; await App.layoutJob;
      App.showLayer('l4', { rebuild: true }); await App.l4Job;
      const Q = App.Q; const ex = Q.exposure();
      if (App.snap !== snap) throw new Error('測試前提：目前的基準應是這裡建立的（前面的步驟還有沒完成的建立）');
      if (ex.ipv6.status !== 'edge-only' || $('#l4-ex-ipv6').dataset.status !== 'edge-only' || !text('#l4-ex-ipv6').includes(ex.ipv6.message)) throw new Error(`有 IPv6 位址時說明應是 edge-only 的 message（${ex.ipv6.status}／${$('#l4-ex-ipv6').dataset.status}）：${text('#l4-ex-ipv6')}`);
      const secRows = (k) => $('#l4-exposure').testAll('.l4-ex-sec').find((x) => x.dataset.sec === k).testAll('tr').filter((tr) => /l4-ex-row/.test(tr.className));
      // IPv6 列：位址或整個網段，沒有看路徑（不呼叫 Q.reach），寫明只看邊界路由器
      const v6 = ex.routed.rows.find((r) => r.family === 'ipv6' && r.dstAny);
      if (!v6) throw new Error('測試前提：應有 IPv6 的 dstAny 列');
      const tr6 = secRows('routed').find((tr) => tr.dataset.family === 'ipv6');
      if (!tr6 || !tr6.textContent.includes(`整個網段 ${v6.subnet} 的主機`)) throw new Error('IPv6 dstAny 的列應寫「整個網段 x 的主機」：' + (tr6 && tr6.textContent));
      if (tr6.querySelector('.l4-ex-path') || !tr6.textContent.includes('沒有逐跳路徑')) throw new Error('IPv6 的列不提供看路徑，並說明只看邊界路由器');
      // 回程不保證：列上有短標，title 寫 chain 與規則，規則可點
      const ru = ex.routed.rows.find((r) => r.returnUnsafe.length);
      if (!ru) throw new Error('測試前提：應有回程不保證的列');
      const tr = secRows('routed').find((x) => x.dataset.family === 'ipv4' && x.textContent.includes(ru.ip));
      const tag = tr && tr.querySelector('.l4-return');
      if (!tag || !tag.textContent.includes('⚠ 回程不保證') || !/forward.*第 \d+ 條[\s\S]*F15/.test(tag.querySelector('.chip').getAttribute('title') || ''))throw new Error('回程不保證的列應有「⚠ 回程不保證」短標，title 寫 chain 與規則');
      if (tr.textContent.includes(V.reachReason('return-not-guaranteed'))) throw new Error('回程不保證只用短標，不另寫長句');
      const rl = tr.testAll('.l4-return-rule')[0];
      if (!rl) throw new Error('回程不保證應附規則連結'); rl.click();
      if (!App.sel || App.sel.type !== 'rule' || App.sel.key !== ru.returnUnsafe[0].rule) throw new Error('回程不保證的規則連結應開規則詳情');
      // 看路徑：逐跳的那一跳也標
      tr.querySelector('.l4-ex-path').click();
      const hop = $('#l4-ex-path-box').testAll('.l4-hop').find((x) => x.dataset.dev === 'R');
      if (!hop || !hop.querySelector('.l4-return')) throw new Error('逐跳路徑上回程不保證的跳應標「⚠ 回程不保證」');
      App.select(null);
    } finally {
      App.showLayer('device');
      VA.load(orig.snap, null, { sources: orig.sources, profile: orig.profile }); await App.ledgerJob; await App.layoutJob;
    }
  });
};
