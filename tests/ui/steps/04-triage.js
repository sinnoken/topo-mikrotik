// 畫面冒煙測試的 step：「研判」與檢查結果、詳情的處理提示、埠名、點選設備與鏈路。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { El, body, head, document, S, fs, path, ROOT, step, unticked, withGraph, goStep, $, text, detailRoot, fwRoot, fwList, fwSide, fwText, fwTab, fwRows } = require('../helpers.js');

module.exports = async () => {
  await step('檢查結果：沒有發現的檢查分成「通過」與「沒有資料可檢查」，預設收合', () => {
    const pass = App.Q.ruleStatus().filter((r) => r.status === 'pass'); if (!pass.length) return;
    const head = () => document.testAll('#pane-findings .fgroup').find((g) => g.className.split(' ').includes('pass'));
    if (!head()) throw new Error('應有「通過」區塊');
    if (head().testAll('.rule').length) throw new Error('「通過」區塊預設應收合');
    head().querySelector('.head').click();
    if (head().testAll('.rule').length !== pass.length || !text('#pane-findings').includes(pass[0].title)) throw new Error('展開後應列出每一項通過的檢查');
    // 每一項檢查都能看到 CATALOG 的處理建議（預設收合，反引號內是等寬元素）
    const rows = () => head().testAll('.rule');
    rows().forEach((row, n) => {
      const id = pass[n].id; const adv = row.querySelector('.advice');
      if (row.querySelector('.id').textContent !== id) throw new Error('通過的檢查應依 ruleStatus 的順序列出');
      if (!adv || adv.getAttribute('open') !== null || !adv.textContent.includes(unticked(S.check.CATALOG[id].action))) throw new Error('通過的 ' + id + ' 應附上預設收合的處理建議');
      if (S.check.CATALOG[id].action.includes('`') && !adv.querySelector('code')) throw new Error(id + ' 的處理建議應以等寬元素顯示指令');
    });
    // 展開狀態跨重繪保留，收合後也保留
    const toggleAdvice = (on) => { const d = rows()[0].querySelector('.advice'); d.open = on; d.dispatch('toggle'); };
    const reopen = () => { head().querySelector('.head').click(); head().querySelector('.head').click(); };
    toggleAdvice(true); reopen();
    if (rows()[0].querySelector('.advice').getAttribute('open') === null) throw new Error('展開的處理建議重繪後應保持展開');
    toggleAdvice(false); reopen();
    if (rows()[0].querySelector('.advice').getAttribute('open') !== null) throw new Error('收合的處理建議重繪後應保持收合');
    head().querySelector('.head').click();
    const nodata = App.Q.ruleStatus().filter((r) => r.status === 'nodata');
    const nd = () => document.testAll('#pane-findings .fgroup').find((g) => g.className.split(' ').includes('nodata'));
    if (nodata.length) {
      nd().querySelector('.head').click();
      nd().testAll('.rule').forEach((row, n) => {
        const adv = row.querySelector('.advice');
        if (!adv || !adv.textContent.includes(unticked(S.check.CATALOG[nodata[n].id].action))) throw new Error('沒有資料可檢查的 ' + nodata[n].id + ' 也應附上處理建議');
      });
      nd().querySelector('.head').click();
    }
  });
  await step('C02 的證據標示為已收集的指令，而不是缺少的資料', () => {
    const i = App.snap.findings.findIndex((f) => f.id === 'C02' && f.evidence.length);
    if (i < 0) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有帶證據的 C02'); }
    const f = App.snap.findings[i]; App.selectFinding(i);
    const t = text('#detail');
    if (!t.includes('已收集：')) throw new Error('C02 詳情應標示「已收集：」');
    const cmds = f.evidence.map((e) => App.Q.block(e.block)).filter((b) => b && b.command).map((b) => b.command);
    if (!cmds.length || !cmds.some((c) => t.includes(c))) throw new Error('C02 詳情應顯示已收集區塊的指令');
    if (f.evidence.length > 3 && !f.evidence.every((e) => t.includes(`第 ${e.line} 行`))) throw new Error('C02 的證據應全部列出');
    const other = App.snap.findings.findIndex((x) => x.id !== 'C02' && x.evidence.length && x.entities.length && x.entities.every((e) => !App.Q.findingsFor(e.type, e.key).some((y) => y.id === 'C02')));
    if (other >= 0) {
      App.selectFinding(other); const of = App.snap.findings[other];
      // 其他檢查的證據合併成一行「原文：第 a、b、c 行」：「原文」只出現一次，每個行號各自是連結，不用等寬字
      const ev = $('#detail').testAll('.ev-raw').find((x) => x.textContent.includes(`第 ${of.evidence[0].line}`));
      if (!ev || !ev.textContent.startsWith('原文：第 ') || ev.textContent.split('原文').length !== 2) throw new Error('其他檢查的證據應合併成一行「原文：第 N 行」：' + (ev && ev.textContent));
      const nums = ev.testAll('a');
      if (nums.length !== Math.min(3, of.evidence.length) || !nums.every((a, n) => a.textContent === String(of.evidence[n].line) && a.getAttribute('aria-label') === `原文 第 ${of.evidence[n].line} 行`)) throw new Error('每個行號應各自可點並有 aria 名稱');
      if (nums.some((a) => a.classList.contains('mono'))) throw new Error('原文行號不應用等寬字');
    }
  });
  await step('點選每一筆檢查結果', () => { App.snap.findings.forEach((f, i) => { App.selectFinding(i); App.graph.draw(); }); });
  await step('從其他入口選取檢查結果：「研判」的清單展開到那項檢查（含被篩掉的嚴重度與超過顯示筆數的位置），標出選取那一筆並捲到看得見', () => {
    const all = App.snap.findings; const VA = S.view.app;
    goStep('triage');
    const selected = () => $('#pane-findings').testAll('.fitem').filter((e) => e.classList.contains('sel'));
    // 狀態卡的「只看錯誤與警告」：全部收合、提醒被篩掉；再選一筆提醒（模擬狀態卡、詳細資料或防火牆的入口）
    const pick = ['info', 'warn', 'error'].map((s) => all.findIndex((f) => f.severity === s && VA.isPending(f))).find((i) => i >= 0);
    S.view.lists.findings.showProblems(App);
    const proto = Object.getPrototypeOf($('#pane-findings')); const orig = proto.scrollIntoView; const scrolled = [];
    proto.scrollIntoView = function () { scrolled.push(this); };
    try { App.selectFinding(pick); } finally { proto.scrollIntoView = orig; }
    const sel = selected();
    if (sel.length !== 1 || sel[0].getAttribute('data-finding') !== String(pick) || sel[0].getAttribute('aria-current') !== 'true') throw new Error('應只標出選取的那一筆：' + sel.length);
    if (!sel[0].textContent.includes(all[pick].message)) throw new Error('標出的應是選取的檢查結果');
    if (!scrolled.includes(sel[0])) throw new Error('選取的那一筆應捲到看得見');
    const head = $('#pane-findings').testAll('.fgroup').find((g) => g.testAll('.fitem').includes(sel[0]) && !g.classList.contains('fcat'));
    if (!head || head.querySelector('.head').getAttribute('aria-expanded') !== 'true') throw new Error('所在的檢查分組應展開');
    // 同一項檢查有很多筆時，超過預設顯示筆數的那一筆也要列出來
    const big = Object.entries(all.reduce((o, f) => { o[f.id] = (o[f.id] || 0) + 1; return o; }, {})).find(([, n]) => n > 100);
    if (big) {
      const late = all.map((f, i) => i).filter((i) => all[i].id === big[0] && VA.isPending(all[i]))[100];
      if (late != null) { App.selectFinding(late); if (!selected().some((e) => e.getAttribute('data-finding') === String(late))) throw new Error('超過顯示筆數的那一筆也應列出並標出'); }
    }
    // 依設備分組時展開那台設備的分組
    $('#pane-findings').testAll('button').find((b) => b.getAttribute('data-group-by') === 'device').click();
    App.selectFinding(pick);
    if (selected().length !== 1 || selected()[0].getAttribute('data-finding') !== String(pick)) throw new Error('依設備分組時也應展開並標出');
    $('#pane-findings').testAll('button').find((b) => b.getAttribute('data-group-by') === 'rule').click();
    App.select(null); goStep('view');
  });
  await step('詳情的檢查結果附上 CATALOG 的常見原因與處理：預設收合，反引號內的指令以等寬元素顯示', () => {
    const all = App.snap.findings; const C = S.check.CATALOG;
    // 反引號內的片段與去掉反引號後看到的文字（以正規式另外取出，不經過畫面的切法）
    const codes = (t) => Array.from(String(t).matchAll(/`([^`]+)`/g)).map((m) => m[1]);
    const ids = S.util.uniq(all.map((f) => f.id));
    if (!process.env.SMOKE_INPUT && !ids.some((id) => codes(C[id].action).length)) throw new Error('範例資料應有處理建議含反引號指令的檢查結果');
    ids.forEach((id) => {
      // 沒有相關實體的檢查結果沒有詳情畫面可顯示（選取後是總覽），取第一筆有實體的
      const i = all.findIndex((f) => f.id === id && f.entities.length); if (i < 0) return;
      const f = all[i]; App.selectFinding(i);
      if (!text('#detail').includes(f.message)) throw new Error(id + ' 的詳情應列出這筆檢查結果');
      const blocks = $('#detail').testAll('.advice').filter((d) => d.getAttribute('data-rule-id') === id);
      if (!blocks.length) throw new Error(id + ' 的詳情應有常見原因與處理');
      blocks.forEach((d) => {
        if (d.tagName !== 'DETAILS' || d.getAttribute('open') !== null) throw new Error(id + ' 的常見原因與處理應預設收合');
        const t = d.textContent;
        if (!t.includes(unticked(C[id].action))) throw new Error(id + ' 的詳情應顯示 CATALOG 的 action：' + C[id].action);
        if (!C[id].causes.every((c) => d.testAll('li').some((li) => li.textContent === unticked(c)))) throw new Error(id + ' 的常見原因應逐條列出');
        if (t.includes('`')) throw new Error(id + ' 的處理建議不應顯示反引號');
        const shown = d.testAll('code').map((c) => c.textContent);
        const want = codes(C[id].action).concat(...C[id].causes.map(codes));
        if (shown.join('\n') !== want.join('\n')) throw new Error(id + ' 反引號內的片段應依序成為等寬元素：' + JSON.stringify(shown) + ' / ' + JSON.stringify(want));
        if (d.testAll('code').some((c) => !c.classList.contains('mono') || c.childNodes.some((n) => n instanceof El))) throw new Error(id + ' 的等寬元素應為純文字的 code.mono');
      });
    });
    // 反引號沒有成對時保留原樣，不吞掉文字；內容以文字寫入，不解析 HTML
    const parts = S.view.codeParts('a `b` c `d');
    if (JSON.stringify(parts) !== JSON.stringify([{ text: 'a ', code: false }, { text: 'b', code: true }, { text: ' c `d', code: false }])) throw new Error('codeParts 切法不符：' + JSON.stringify(parts));
    const nodes = S.view.codeText('<b>x</b> `<i>`');
    if (nodes[0] !== '<b>x</b> ' || nodes[1].tagName !== 'CODE' || nodes[1].textContent !== '<i>' || nodes[1].childNodes.some((n) => n instanceof El)) throw new Error('codeText 應以文字寫入，不解析 HTML');
  });
  await step('處理提示：「研判」展開檢查後在結果列表上方顯示「處理：」，詳情的檢查結果卡片同一句', () => {
    goStep('triage'); const L = S.view.lists.findings; L.showProblems(App);
    const ruleGroups = () => $('#pane-findings').testAll('.fgroup').filter((g) => g.className === 'fgroup');
    const g0 = ruleGroups()[0]; if (!g0) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有錯誤或警告的檢查群組'); }
    if ($('#pane-findings').testAll('.fhint').length) throw new Error('檢查收合時不應顯示處理提示');
    const id = g0.querySelector('.head .id').textContent; const want = '處理：' + unticked(S.query.rule(id).hint);
    g0.querySelector('.head').click();
    const g = ruleGroups().find((x) => x.querySelector('.head .id').textContent === id);
    const hint = g.querySelector('.fhint'); const items = g.querySelector('.items');
    if (!hint || hint.textContent !== want) throw new Error(`${id} 展開後應顯示「${want}」：${hint && hint.textContent}`);
    if (g.childNodes.indexOf(hint) > g.childNodes.indexOf(items)) throw new Error('處理提示應在結果列表上方');
    if (S.query.rule(id).hint.includes('`') && !hint.querySelector('code')) throw new Error('處理提示的反引號內應以等寬元素顯示');
    const all = App.snap.findings;
    S.util.uniq(all.map((f) => f.id)).forEach((rid) => {
      const i = all.findIndex((f) => f.id === rid && f.entities.length); if (i < 0) return;
      App.selectFinding(i);
      const w = '處理：' + unticked(S.query.rule(rid).hint);
      if (!$('#detail').testAll('.finding .rule-hint').some((x) => x.getAttribute('data-rule-id') === rid && x.textContent === w)) throw new Error(`${rid} 的詳情卡片應顯示「${w}」`);
    });
    L.showProblems(App); App.select(null);
  });
  await step('多個實體的檢查結果（R08 設備＋介面、R09 設備＋規則、R10／R13 兩台設備）：詳情列出訊息與「相關：」連結，圖上標出每台相關設備；指向規則的不限類別列在防火牆畫面', () => {
    const Q = App.Q; const all = Q.findings();
    const KINDS = ['device', 'interface', 'rule', 'link', 'service'];
    const multi = all.map((f, i) => i).filter((i) => all[i].entities.filter((e) => KINDS.includes(e.type)).length >= 2);
    if (!process.env.SMOKE_INPUT && !['R08', 'R09', 'R10', 'R13'].every((id) => multi.some((i) => all[i].id === id))) throw new Error('範例資料應有 R08、R09、R10、R13 的多實體檢查結果');
    const devOf = (e) => (e.type === 'rule' ? Q.getFirewallRule(e.key).dev : e.type === 'device' ? e.key : S.keys.splitEp(e.key)[0]);
    multi.forEach((i) => {
      const f = all[i]; App.selectFinding(i);
      const box = $('#detail').testAll('.finding').find((x) => x.textContent.includes(f.message));
      if (!box) throw new Error(`${f.id} 的詳情應列出這筆檢查結果：${f.message}`);
      const rel = box.querySelector('.finding-related');
      if (!rel || !rel.textContent.startsWith('相關：')) throw new Error(`${f.id} 有多個實體，詳情應有「相關：」`);
      const links = rel.testAll('a');
      // 基準中有的物件是可用鍵盤操作的連結；沒有的（例如只出現在 DHCP client 的介面）寫成文字並註明
      if (links.length + rel.testAll('.related-missing').length < 2 || links.some((a) => a.getAttribute('tabindex') !== '0')) throw new Error(`${f.id} 的相關實體應列出，可開啟的是可用鍵盤操作的連結`);
      // 基準沒有的介面寫具體說法（沒有介面資料、只出現在哪裡由 title 補充），不寫籠統的「沒有詳細資料」
      rel.testAll('.related-missing').forEach((x) => { if (x.textContent.includes('沒有詳細資料') || !/基準中沒有/.test(x.textContent + (x.getAttribute('title') || ''))) throw new Error(`${f.id} 基準沒有的實體應寫具體說法：${x.textContent}`); });
      // 選取的這一筆在詳情中標出（.current、aria-current），不藏在收合區；放在檢查結果的第一筆
      const cur = $('#detail').testAll('.finding').filter((x) => /\bcurrent\b/.test(x.className));
      if (cur.length !== 1 || cur[0] !== box || box.getAttribute('aria-current') !== 'true' || !box.textContent.includes('目前選取')) throw new Error(`${f.id} 選取的檢查結果應在詳情中標出（只標一筆）`);
      let p = box.parentNode; while (p) { if (p.tagName === 'DETAILS' && p.getAttribute('open') == null) throw new Error(`${f.id} 選取的檢查結果不應藏在收合區`); p = p.parentNode; }
      const sec = box.parentNode && $('#detail').querySelector('.findings-section');
      if (!sec || sec.testAll('.finding')[0] !== box) throw new Error(`${f.id} 選取的檢查結果應排在檢查結果的第一筆`);
      // 圖上：每台相關設備都標出（連結兩端的設備另由鏈路標出）
      f.entities.filter((e) => e.type !== 'link' && KINDS.includes(e.type)).forEach((e) => {
        if (!App.graph.hl || !App.graph.hl.nodes.has(devOf(e))) throw new Error(`${f.id} 的相關設備 ${devOf(e)} 應在圖上標出`);
      });
    });
    // 指向規則的檢查結果（例如路由類的 R09）開啟防火牆畫面並列在那裡
    const ri = multi.find((i) => all[i].entities.some((e) => e.type === 'rule') && (S.query.rule(all[i].id) || {}).cat !== '防火牆');
    if (ri === undefined && !process.env.SMOKE_INPUT) throw new Error('範例資料應有指向規則、不是防火牆類別的檢查結果（R09）');
    if (ri !== undefined) {
      App.selectFinding(ri);
      if (App.sel.type !== 'rule' || !fwSide().textContent.includes(all[ri].message)) throw new Error(`${all[ri].id} 應在防火牆視窗的規則詳情列出`);
      // 相關的設備連結關閉視窗、在右欄開啟設備詳情，那裡也列出這筆
      const rel = fwSide().testAll('.finding').find((x) => x.textContent.includes(all[ri].message)).querySelector('.finding-related');
      const d = all[ri].entities.find((e) => e.type === 'device');
      rel.testAll('a').find((a) => a.textContent === Q.devLabel(d.key)).click();
      if (App.sel.type !== 'device' || App.sel.key !== d.key || $('#dlg-table').open || !detailRoot().textContent.includes(all[ri].message)) throw new Error('相關的設備連結應開啟設備詳情並列出這筆');
    }
    App.select(null);
  });
  await step('外部的詳情：依據（對外介面與依據）排在檢查結果之前，點外部時先看到為什麼判定對外', () => {
    const Q = App.Q;
    const vrf = Q.vrfs().find((v) => S.view.app.boundariesOf(Q, { key: v }).length);
    if (!vrf) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有對外邊界'); }
    App.select({ type: 'boundary', key: vrf });
    const blocks = $('#detail').querySelector('.detail').childNodes;
    const at = (pred) => blocks.findIndex(pred);
    const ttl = (x) => { const s = x.querySelector && (x.querySelector('summary') || x.querySelector('h3')); return s ? s.textContent : ''; };
    const iBasis = at((x) => /^對外介面與依據/.test(ttl(x)));
    const iFind = at((x) => /\bfindings-section\b/.test(x.className || ''));
    if (iBasis < 0) throw new Error('外部的詳情應有「對外介面與依據」');
    if (iFind >= 0 && iFind < iBasis) throw new Error('依據應排在檢查結果之前');
    App.select(null);
  });
  await step('設備詳情的路由表列出非作用中的路由（標「非作用中」），與 R11 對照', () => {
    const Q = App.Q;
    const dev = Q.devices().map((d) => d.key).find((k) => Q.allRoutesOf(k).some((r) => r.active === false));
    if (!dev) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有非作用中的路由（備援的預設路由）'); }
    App.select({ type: 'device', key: dev });
    const sec = $('#detail').testAll('details').find((d) => d.querySelector('summary') && d.querySelector('summary').textContent.startsWith('路由表'));
    if (!sec) throw new Error('設備詳情應有路由表');
    const n = Q.allRoutesOf(dev).filter((r) => r.active === false).length;
    if (sec.testAll('.route-inactive').length !== Math.min(n, 200) || !sec.querySelector('summary').textContent.includes(`${S.view.num(n)} 條非作用中`)) throw new Error('非作用中的路由應逐列標「非作用中」，標題寫出筆數');
    // 「非作用中」在網段欄內（最後一欄在窄的右欄看不到），整列 muted；不另設狀態欄
    if (sec.testAll('th').some((th) => th.textContent.startsWith('狀態'))) throw new Error('路由表不應另設狀態欄');
    sec.testAll('.route-inactive').forEach((c) => { let td = c; while (td && td.tagName !== 'TD') td = td.parentNode; const tr = td.parentNode;
      if (tr.childNodes.indexOf(td) !== 0 || !/\broute-off\b/.test(tr.className)) throw new Error('「非作用中」應在網段欄，整列標 route-off'); });
    if (Q.allRoutesOf(dev).length <= Q.routesOf(dev).length) throw new Error('路由表應包含作用中以外的路由');
    App.select(null);
  });
  await step('跨設備一致性：多數決判定與多數不同的設備列在檢查結果，VLAN 實體可開啟', () => {
    const all = App.snap.findings;
    const dev = all.map((f, i) => i).filter((i) => all[i].deviation && all[i].deviation.deviating.length);
    if (!dev.length && !process.env.SMOKE_INPUT) throw new Error('範例資料應有多數決判定與多數不同設備的檢查結果');
    dev.forEach((i) => {
      const f = all[i]; App.selectFinding(i);
      const box = $('#detail').testAll('.finding').find((x) => x.textContent.includes(f.message));
      if (!box || !box.textContent.includes('與多數不同（推論）：')) throw new Error(`${f.id} 應列出與多數不同的設備`);
      // 設備名可點，選取該設備（V.deviationLine 單一來源）
      const a = box.querySelector('.deviation').testAll('a').find((x) => x.getAttribute('data-dev') === f.deviation.deviating[0]);
      if (!a) throw new Error(`${f.id} 與多數不同的設備應可點`);
      if (!f.deviation.deviating.every((k) => box.textContent.includes(App.Q.devName(k)))) throw new Error(`${f.id} 與多數不同的設備不完整`);
    });
    // VLAN 實體的檢查結果開啟 VLAN 詳情；有不相連區塊時可切換區塊並回到全部
    const vi = all.findIndex((f) => f.entities[0] && f.entities[0].type === 'vlan');
    if (vi >= 0) { App.selectFinding(vi); if (App.sel.type !== 'vlan' || !text('#detail').includes('VLAN ' + all[vi].entities[0].key)) throw new Error('VLAN 的檢查結果應開啟 VLAN 詳情'); }
    App.select(null);
  });
  await step('「研判」依檢查：類別 → 檢查 → 結果，類別標題寫出各嚴重度筆數，順序取自檢查目錄；與多數不同列在結果下方', () => {
    const L = S.view.lists.findings; const VA = S.view.app; const all = App.snap.findings;
    goStep('triage'); L.reset(); L(App);
    const P = $('#pane-findings');
    // 三種嚴重度都顯示
    ['錯誤', '警告', '提醒'].forEach((t) => { const c = P.querySelector('.summary').testAll('.chip').find((x) => x.textContent.startsWith(t)); if (c && c.getAttribute('aria-pressed') !== 'true') c.click(); });
    const cats = () => P.testAll('.fcat');
    const catOf = (c) => cats().find((x) => x.getAttribute('data-cat') === c);
    // 類別與檢查的順序：S.query.rules()（CATALOG 的宣告順序）中有待處理結果的
    const pending = all.filter((f) => VA.isPending(f));
    const ids = new Set(pending.map((f) => f.id));
    const order = S.query.rules().filter((r) => ids.has(r.id));
    const wantCats = S.util.uniq(order.map((r) => r.cat));
    if (cats().map((x) => x.getAttribute('data-cat')).join() !== wantCats.join()) throw new Error('類別順序應依檢查目錄：' + cats().map((x) => x.getAttribute('data-cat')));
    if (P.childNodes.some((n) => n.className === 'fgroup')) throw new Error('依檢查時檢查群組應在類別之下');
    wantCats.forEach((c) => {
      const box = catOf(c); const head = box.querySelector('.head');
      const n = { error: 0, warn: 0, info: 0 }; pending.filter((f) => S.query.rule(f.id).cat === c).forEach((f) => { n[f.severity]++; });
      // 標題的筆數是文字 chip（不只色點），只列有筆數的嚴重度
      const chips = head.testAll('.fcat-n').map((x) => x.textContent);
      const want = ['error', 'warn', 'info'].filter((s) => n[s]).map((s) => `${S.view.SEV[s]} ${S.view.num(n[s])}`);
      if (chips.join('|') !== want.join('|')) throw new Error(`${c} 的筆數應為 ${want.join('／')}：${chips.join('／')}`);
      if (!head.testAll('.fcat-n .sev').every((d) => d.getAttribute('role') === 'img' && d.getAttribute('aria-label'))) throw new Error('嚴重度外形應有可念出的名稱');
      // 有錯誤或警告的類別預設展開到檢查層，只有提醒的收合
      const open = n.error + n.warn > 0;
      if (head.getAttribute('aria-expanded') !== String(open) || !!box.querySelector('.fcat-rules') !== open) throw new Error(`${c} 預設應${open ? '展開' : '收合'}`);
      if (!head.getAttribute('aria-label').startsWith(c + '：')) throw new Error('類別標題的名稱應寫出類別與筆數');
      if (open) {
        const got = box.testAll('.fcat-rules .fgroup .head .id').map((x) => x.textContent);
        const exp = order.filter((r) => r.cat === c).map((r) => r.id);
        if (got.join() !== exp.join()) throw new Error(`${c} 的檢查順序應依檢查目錄：${got} ≠ ${exp}`);
        if (box.testAll('.fitem').length) throw new Error('類別展開時檢查預設仍收合');
      }
    });
    // 切換類別的展開狀態跨重繪保留
    const c0 = wantCats[0];
    if (c0) {
      const was = catOf(c0).querySelector('.head').getAttribute('aria-expanded');
      catOf(c0).querySelector('.head').click(); L(App);
      if (catOf(c0).querySelector('.head').getAttribute('aria-expanded') === was) throw new Error('類別應可切換展開，並跨重繪保留');
      catOf(c0).querySelector('.head').click();
    }
    // 與多數不同（推論）：結果下方列出可點的設備；平手不列
    const dev = pending.filter((f) => f.deviation && f.deviation.basis === 'majority' && f.deviation.deviating.length);
    if (!dev.length && !process.env.SMOKE_INPUT) throw new Error('範例資料應有與多數不同設備的待處理結果');
    dev.slice(0, 5).forEach((f) => {
      const box = catOf(S.query.rule(f.id).cat); const ch = box.querySelector('.head');
      if (ch.getAttribute('aria-expanded') !== 'true') ch.click();
      const rg = () => catOf(S.query.rule(f.id).cat).testAll('.fgroup').find((g) => g.className === 'fgroup' && g.querySelector('.head .id').textContent === f.id);
      if (rg().querySelector('.head').getAttribute('aria-expanded') !== 'true') rg().querySelector('.head').click();
      const wrap = rg().testAll('.fitem-wrap').find((w) => w.querySelector('.fitem').textContent.includes(f.message));
      const line = wrap && wrap.querySelector('.deviation');
      if (!line || !line.textContent.startsWith('與多數不同（推論）：')) throw new Error(`${f.id} 的結果下方應列與多數不同`);
      const links = line.testAll('.link');
      if (links.map((a) => a.textContent).join() !== f.deviation.deviating.map((k) => App.Q.devName(k)).join()) throw new Error(`${f.id} 與多數不同的設備不符`);
      if (wrap.querySelector('.fitem').testAll('.link').length) throw new Error('設備連結不應包在可點的結果列裡');
      links[0].click();
      if (!App.sel || App.sel.type !== 'device' || App.sel.key !== f.deviation.deviating[0]) throw new Error('點與多數不同的設備應選取它');
    });
    // 單一 helper（V.deviationLine）：平手預設不顯示（詳情與列表一致），只有明確傳 { tie: true } 才寫「沒有多數」；不是多數決的不顯示
    const tie = { basis: 'majority', deviating: [], groups: [], main: null };
    if (S.view.deviationLine(App, tie) !== null || S.view.deviationLine(App, tie, { tie: false }) !== null || S.view.deviationLine(App, null) !== null || S.view.deviationLine(App, { basis: 'other', deviating: ['x'] }) !== null) throw new Error('平手或非多數決預設不應顯示');
    if (!S.view.deviationLine(App, tie, { tie: true }).textContent.includes('沒有多數')) throw new Error('明確要求時平手應寫出沒有多數');
    if (P.testAll('.deviation').some((x) => x.textContent.includes('沒有多數'))) throw new Error('列表不顯示平手');
    App.select(null); L.showProblems(App);
  });
  await step('「研判」的選取標示跟著選取走：選了檢查結果後改選設備、VLAN 或取消選取，清單不再標示那一筆（aria-current 一起拿掉）', () => {
    const all = App.snap.findings; const i = all.findIndex((f) => f.severity !== 'info');
    if (i < 0) return;
    goStep('triage');
    const marked = () => $('#pane-findings').testAll('.fitem').filter((x) => x.className.split(' ').includes('sel') || x.getAttribute('aria-current') === 'true');
    App.selectFinding(i);
    if (marked().length !== 1 || marked()[0].getAttribute('data-finding') !== String(i)) throw new Error('選取檢查結果時清單應標出那一筆');
    App.select(App.sel, { refresh: true });
    if (marked().length !== 1) throw new Error('只重新標示（refresh）時應保留清單的選取標示');
    const dev = App.snap.model.devices.find((d) => d.collected).key;
    App.select({ type: 'device', key: dev });
    if (marked().length) throw new Error('改選設備後清單不應仍標示檢查結果');
    App.selectFinding(i); App.select({ type: 'vlan', key: String(App.Q.vlanIds()[0]) });
    if (marked().length) throw new Error('改選 VLAN 後清單不應仍標示檢查結果');
    App.selectFinding(i); App.select(null);
    if (marked().length) throw new Error('取消選取後清單不應仍標示檢查結果');
    $('#vlan-filter').value = ''; $('#vlan-filter').dispatch('change');
  });
  await step('樣式：chip 不用 overflow-wrap: anywhere（表格自動排版會把 chip 欄壓成一字寬），表格內的 chip 不換行', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({ sels: m[1].split(',').map((x) => x.trim()), body: m[2] }));
    if (rules.some((r) => r.sels.some((x) => /\.chip\b/.test(x)) && /overflow-wrap:\s*anywhere/.test(r.body))) throw new Error('.chip 不可用 overflow-wrap: anywhere');
    const t = rules.find((r) => r.sels.includes('table.t .chip'));
    if (!t || !/white-space:\s*nowrap/.test(t.body)) throw new Error('table.t .chip 應為 white-space: nowrap');
  });
  await step('埠名：選取的鏈路一定畫出兩端埠名（沿線都被設備名稱蓋住時仍畫），一般埠名讓給它、不互相重疊', () => {
    const g = App.graph; const T = S.view.theme;
    const ov = (a, b) => a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5;
    const at = (sc) => { g.s = sc; g.tx = g.w / 2; g.ty = g.h / 2; };
    const edge = (id, a, b, la, lb) => ({ id, a, b, cls: '1g', count: 1, evidence: 'adjacency', labelA: la, labelB: lb });
    // 和一般埠名同一個位置（平行的兩條鏈路，只選一條）：強制的優先，一般的略過
    const nodes = [{ id: 'pl-a', label: 'A', kind: 'switch', collected: true, group: 't' }, { id: 'pl-b', label: 'B', kind: 'switch', collected: true, group: 't' }];
    withGraph(g, nodes, [edge('pl-1', 'pl-a', 'pl-b', 'ether1', 'ether2'), edge('pl-2', 'pl-a', 'pl-b', 'ether3', 'ether4')],
      new Map([['pl-a', { x: 0, y: 0 }], ['pl-b', { x: 200, y: 0 }]]), () => {
        at(2); g.setSelection([], ['pl-1']); g.draw();
        const forced = g.portLabels.filter((p) => p.forced).map((p) => p.text).sort();
        if (forced.join() !== 'ether1,ether2') throw new Error('選取的鏈路應畫出兩端埠名：' + forced);
        g.portLabels.forEach((a, i) => g.portLabels.slice(i + 1).forEach((b) => { if (ov(a, b)) throw new Error(`埠名不應重疊：${a.text} / ${b.text}`); }));
      });
    // 鏈路很短、整段都被第三台設備的名稱蓋住：沿線挪都不行時仍要畫
    const fs = T.font.labelPx / 2;
    const nodes2 = nodes.concat([{ id: 'pl-c', label: 'X'.repeat(40), kind: 'switch', collected: true, group: 't' }]);
    withGraph(g, nodes2, [edge('pl-1', 'pl-a', 'pl-b', 'ether1', 'ether2')], new Map([['pl-a', { x: 0, y: 0 }], ['pl-b', { x: 60, y: 0 }], ['pl-c', { x: 30, y: 0 }]]), () => {
        at(2); const rc = g.radius(g.nodeById.get('pl-c')); g.pos.set('pl-c', { x: 30, y: -(rc + 0.85 * fs) });
        g.setSelection([], ['pl-1']); g.draw();
        const cl = g.nodeLabels.find((l) => l.id === 'pl-c');
        if (!cl) throw new Error('測試前提：第三台設備的名稱應畫出');
        const forced = g.portLabels.filter((p) => p.forced).map((p) => p.text).sort();
        if (forced.join() !== 'ether1,ether2') throw new Error('選取的鏈路沿線都被蓋住時仍應畫出兩端埠名：' + forced);
      });
  });
  await step('點選每台設備、每條鏈路、部分介面', () => {
    App.snap.model.devices.slice(0, 300).forEach((d) => App.select({ type: 'device', key: d.key }, { focus: true }));
    const endpointDev = App.snap.model.interfaces.find((i) => i.unknownPeer);
    if (endpointDev) {
      App.select({ type: 'device', key: endpointDev.dev });
      const headings = $('#detail').testAll('h3').map((el) => el.textContent.replace(/\d+$/, ''));
      const ordered = ['檢查結果', '介面', '沒有 LLDP／CDP 鄰接的埠', '鄰居', '路由表', '收集到的原始輸出']
        .map((title) => headings.indexOf(title)).filter((i) => i >= 0);
      if (ordered.some((i, n) => n && ordered[n - 1] >= i)) throw new Error('設備詳細區塊順序不符');
    }
    App.snap.model.links.slice(0, 300).forEach((l) => App.select({ type: 'link', key: l.key }));
    App.snap.model.interfaces.slice(0, 120).forEach((i) => App.select({ type: 'interface', key: i.key }));
    const p = Array.from(App.pairs.values()).find((x) => x.links.length > 1); App.select({ type: 'pair', id: p.id, links: p.links, devs: [p.a, p.b] });
    if (!text('#detail').includes('條鏈路')) throw new Error('多鏈路明細未顯示');
  });
};
