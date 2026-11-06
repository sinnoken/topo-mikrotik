// 畫面冒煙測試的 step：原始輸出、趨勢圖、VLAN 片段、路由追蹤終點、修正計畫細節、鏈路樣式。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { body, S, step, contrastOf, forSchemes, buildInput, $, text } = require('../helpers.js');

module.exports = async () => {
  await step('原始輸出：已解析但有認不得的行時標示「部分無法辨識（N 行）」，點一下開啟第一行', () => {
    const b = App.snap.blocks.find((x) => x.adapters.length && !x.empty && x.unrecognizedLines.length && x.devKey && App.Q.getDevice(x.devKey));
    if (!b) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有部分無法辨識的區塊'); }
    App.select({ type: 'device', key: b.devKey });
    const link = $('#detail').testAll('.partial-unrecognized').find((a) => a.textContent === `部分無法辨識（${b.unrecognizedLines.length} 行）`);
    if (!link) throw new Error('應標示部分無法辨識的行數');
    link.click();
    if (!$('#dlg-raw').open || !text('#raw-title').includes(`第 ${b.unrecognizedLines[0]} 行`)) throw new Error('點一下應開啟第一個認不得的行');
    $('#dlg-raw').close(); App.select(null);
  });
  await step('趨勢圖的顏色：theme.trend 對畫布底色 ≥ 3:1，與嚴重度色不同', () => {
    forSchemes((mode) => {
      const T = S.view.theme.trend; const surface = S.view.theme.canvas.surface;
      ['pending', 'regressed', 'accepted', 'single'].forEach((k) => {
        const c = contrastOf(T[k], surface); if (c < 3) throw new Error(`${mode}：trend.${k} 對底色只有 ${c.toFixed(2)}:1`);
      });
      if (Object.values(S.view.theme.sev).some((c) => [T.pending, T.regressed, T.accepted].includes(c))) throw new Error(`${mode}：趨勢圖的類別色不應使用嚴重度色`);
    });
  });
  await step('VLAN 不相連的片段：詳情標示 VLAN 片段、可切換片段並回到全部，圖上只標該片段', async () => {
    const dev = (n, ip) => `${n} (${ip}):\n### /export terse\n/interface bridge add name=bridge1\n/interface vlan add interface=bridge1 name=vlan50 vlan-id=50\n`;
    await buildInput(dev('VA', '10.0.0.1') + '_____\n' + dev('VB', '10.0.0.2'));
    const ds = App.Q.vlan(50).domains;
    if (ds.length < 2) throw new Error('測試資料應有不相連的 VLAN 區塊');
    App.select({ type: 'vlan', key: '50' });
    if (!text('#detail').includes(`${ds.length} 個不相連的 VLAN 片段（推論）`)) throw new Error('應標示不相連的 VLAN 片段');
    const link = $('#detail').testAll('a').find((x) => x.textContent.startsWith('VLAN 片段 2：'));
    if (!link) throw new Error('應可點選其他區塊');
    link.click();
    if (App.sel.domain !== ds[1].key || !text('#detail').includes(`（VLAN 片段 2／${ds.length}）`)) throw new Error('點片段應切換到該片段');
    if (Array.from(App.graph.hl.nodes.keys()).join() !== ds[1].devices.join()) throw new Error('圖上應只標出該區塊的設備');
    $('#detail').testAll('a').find((x) => x.textContent === '顯示所有 VLAN 片段').click();
    if (App.sel.domain != null || App.graph.hl.nodes.size !== App.Q.vlan(50).devices.length) throw new Error('應可回到所有區塊');
  });
  await step('路由追蹤停在未收集的設備：結果是「無法驗證」（灰色），不是無法抵達；圖上與詳情用同一個終點分類', async () => {
    const V = S.view; const M = V.theme.mark;
    forSchemes((mode) => {
      if (contrastOf(M.unverified, V.theme.canvas.surface) < 3) throw new Error(`${mode}：mark.unverified 對畫布底色應 ≥ 3:1`);
      if ([M.bad, M.trace].includes(M.unverified)) throw new Error(`${mode}：無法驗證不應與錯誤色或追蹤色相同`);
    });
    await buildInput('R_A (10.0.0.1):\n### /export terse\n/ip address add address=10.0.0.1/24 interface=ether1\n/ip address add address=10.1.0.1/24 interface=ether2\n'
      + '### /ip route print detail\nFlags: A - ACTIVE; s - STATIC\n 0 As dst-address=0.0.0.0/0 gateway=10.0.0.2 distance=1\n 1 As dst-address=10.94.0.0/16 blackhole\n'
      + '### /ip neighbor print detail\n 0 interface=ether1 identity=ISP_GW address=10.0.0.2 mac-address=AA:BB:CC:00:00:02 interface-name=ge0 discovered-by=lldp\n');
    App.openTrace('10.1.0.5', '8.8.8.8', ''); $('#trace-run').click();
    const t = App.sel.result;
    if (App.sel.type !== 'trace' || t.status !== 'unverified') throw new Error('前提：這條追蹤停在未收集的 ISP_GW');
    const d = text('#detail');
    if (!d.includes('無法驗證（ISP_GW 未收集）') || d.includes('無法完整抵達（') || d.split('回程')[0].includes('無法完整抵達')) throw new Error('去程應標示「無法驗證」，不是無法完整抵達：' + d.slice(0, 200));
    const ends = $('#detail').testAll('.hop').filter((x) => x.dataset.status === 'unverified');
    if (!ends.length || !ends.every((x) => x.className.split(' ').includes(V.TRACE_END_STYLE.unverified.cls))) throw new Error('無法驗證的結果列應用 end-unverified');
    if (!ends[0].textContent.includes(V.TRACE_END.unverified)) throw new Error('結果列應寫出「無法驗證」');
    const isp = App.graph.nodes.find((n) => n.id === 'ISP_GW');
    if (isp && App.graph.hl.nodes.get('ISP_GW') !== M.unverified) throw new Error('圖上停在未收集設備的節點應用 mark.unverified');
    if (App.graph.hl.nodes.get('R_A') !== M.trace) throw new Error('中途經過的設備維持追蹤色');
    // 已收集的設備上斷掉（黑洞）仍是錯誤
    App.openTrace('10.1.0.5', '10.94.1.1', ''); $('#trace-run').click();
    if (App.sel.result.status !== 'unreachable' || !text('#detail').includes('無法完整抵達') || App.graph.hl.nodes.get('R_A') !== M.bad) throw new Error('黑洞仍是無法抵達（錯誤色）');
    // 分類 helper 本身
    if (V.traceEndWorst([]) !== 'reached' || V.traceEndWorst([{ status: 'unverified' }, { status: 'loop' }]) !== 'bad' || V.traceEndKind({ status: 'unverified' }) !== 'unverified') throw new Error('V.traceEndKind／traceEndWorst 分類不符');
    App.select(null);
  });
  await step('修正計畫：A12 的 DNS 與 NTP 依 facet 是不同的 findingKey，各自列出自己的訊息、各自可以勾選，詳情標示比對對象', async () => {
    const RM = S.remediate; const RV = S.view.remediation; const PV = S.view.patchView;
    // 兩台的 DNS 與 NTP 都不一致：同一組設備有兩筆 A12（choice），實體相同、比對對象（facet）不同
    const dev = (n, ip, dns, ntp) => `${n} (${ip}):\n### /export terse\n/ip dns set servers=${dns}\n/system ntp client set enabled=yes servers=${ntp}\n`;
    await buildInput(dev('VA', '10.0.0.1', '1.1.1.1', '10.9.9.1') + '_____\n' + dev('VB', '10.0.0.2', '8.8.8.8', '10.9.9.2'));
    const Q = App.Q; const all = Q.findings();
    const a12 = all.map((f, idx) => ({ f, idx, key: Q.findingKey(f) })).filter((x) => x.f.id === 'A12');
    if (a12.length < 2) throw new Error('測試資料應有同一組設備的多筆 A12');
    if (new Set(a12.map((x) => Q.findingBaseKey(x.f))).size !== 1) throw new Error('前提：這幾筆 A12 的檢查與實體相同（不含 facet 的鍵相同）');
    if (new Set(a12.map((x) => x.key)).size !== a12.length) throw new Error('比對對象不同的 A12 應是不同的 findingKey');
    // 比對對象的顯示文字：有對應的轉成可讀文字，沒有對應或格式不符時顯示原值，沒有 facet 時不顯示
    const byFacet = new Map(a12.map((x) => [x.f.facet, x]));
    if (!byFacet.has('dns') || !byFacet.has('ntp')) throw new Error('A12 應各有 DNS 與 NTP 一筆');
    if (RV.facetText(byFacet.get('dns').f) !== 'DNS 伺服器' || RV.facetText(byFacet.get('ntp').f) !== 'NTP 伺服器') throw new Error('A12 的 dns／ntp 應顯示成「DNS 伺服器」「NTP 伺服器」');
    if (RV.facetText({ id: 'ZZ99', facet: 'raw|value' }) !== 'raw|value' || RV.facetText({ id: 'R06', facet: 'dns' }) !== 'dns') throw new Error('沒有對應或格式不符的 facet 應顯示原值');
    if (RV.facetText({ id: 'I03' }) !== null) throw new Error('沒有 facet 時不應有比對對象');
    // R13 的兩種 facet：中文說法、不外露原始鍵；組名（設備鍵）含 | 時 area-id 取最後一段；格式不符時顯示原值
    const r13 = (facet) => RV.facetText({ id: 'R13', facet });
    if (r13('link|10.1.30.0/24') !== '網段 10.1.30.0/24' || r13('area|R_A|0.0.0.1') !== 'R_A 一組的 area 0.0.0.1' || r13('area|a|b|0.0.0.2') !== 'a|b 一組的 area 0.0.0.2') throw new Error('R13 的 facet 顯示不符：' + [r13('link|10.1.30.0/24'), r13('area|R_A|0.0.0.1')].join('／'));
    if (r13('area|R_A') !== 'area|R_A' || r13('link|') !== 'link|' || r13('zzz|x') !== 'zzz|x') throw new Error('R13 格式不符的 facet 應顯示原值');
    const declared = Object.keys(S.check.CATALOG).filter((id) => S.check.CATALOG[id].facet !== undefined);
    if (!declared.length || declared.some((id) => !RV.FACET_RULES.includes(id))) throw new Error('CATALOG 宣告 facet 的檢查都應有顯示格式：' + declared.filter((id) => !RV.FACET_RULES.includes(id)).join('、'));
    // 詳情：每一筆在標題旁標示自己的比對對象，title 是原值
    a12.forEach(({ f, idx }) => {
      App.selectFinding(idx);
      const box = $('#detail').testAll('.finding').find((el) => el.textContent.includes(f.message));
      const chip = box && box.querySelector('.facet');
      if (!chip || chip.textContent !== '比對對象：' + RV.facetText(f) || chip.getAttribute('title') !== '原值：' + f.facet) throw new Error('詳情應在 ' + f.message + ' 的標題旁標示比對對象');
      if (a12.some((o) => o.f !== f && box.textContent.includes('比對對象：' + RV.facetText(o.f)))) throw new Error('每一筆只標示自己的比對對象');
    });
    const plain = all.findIndex((f) => f.facet == null);
    if (plain >= 0) {
      App.selectFinding(plain);
      const box = $('#detail').testAll('.finding').find((el) => el.textContent.includes(all[plain].message));
      if (box && box.querySelector('.facet')) throw new Error('沒有 facet 的檢查結果不應標示比對對象');
    }
    App.select(null);
    // 未產生指令：每一個鍵各一列，列出自己的訊息，點了（或按 Enter）開啟自己那一筆
    const MISSING_KEY = JSON.stringify(['A12', 'device:不存在的設備']);
    PV.open(App, a12.map((x) => x.key).concat([MISSING_KEY]));
    const plan = RM.plan(Q, Array.from(PV.state.keys).sort(S.util.cmp));
    if (!a12.every((x) => plan.skipped.filter((s) => s.findingKey === x.key).length === 1)) throw new Error('每一筆 A12 應各有一個未產生指令的項目');
    const orig = App.selectFinding; const opened = [];
    App.selectFinding = (i) => { opened.push(i); return orig(i); };
    try {
      a12.forEach((x, n) => {
        const rows = $('#patch-body').testAll('.patch-skip').filter((r) => r.getAttribute('data-finding') === x.key);
        if (rows.length !== 1) throw new Error('每一個鍵應恰好一列');
        if (!rows[0].textContent.includes(x.f.message) || a12.some((o) => o !== x && rows[0].textContent.includes(o.f.message))) throw new Error('每一列只列出自己的訊息');
        const link = rows[0].querySelector('.finding-ref');
        if (!link || link.getAttribute('title') !== x.f.message) throw new Error('訊息連結的 title 應是完整訊息');
        if (n === 0) link.click(); else link.dispatch('keydown', { key: 'Enter' });
        if (opened[opened.length - 1] !== x.idx) throw new Error('點擊應開啟這一筆的檢查結果');
        // 修正計畫在中間、詳情在右側：開啟檢查結果時修正計畫留著，右側顯示這一筆
        if (!PV.isOpen(App) || !text('#detail').includes(x.f.message)) throw new Error('開啟檢查結果時修正計畫應留在中間，右側的詳情顯示這一筆');
      });
    } finally { App.selectFinding = orig; }
    // 原因只在分組標題：每一筆不再重複寫原因或等級
    PV.open(App);
    const sk = plan.skipped.find((s) => s.findingKey === a12[0].key);
    const group = $('#patch-body').testAll('.patch-skip-group').find((g) => g.getAttribute('data-reason') === sk.reason);
    if (!group.querySelector('.patch-label').textContent.includes(RM.SKIP_TEXT[sk.reason])) throw new Error('分組標題應是 SKIP_TEXT');
    if ($('#patch-body').testAll('.patch-skip').some((r) => r.textContent.includes(RM.SKIP_TEXT[sk.reason]) || r.textContent.includes(RV.LEVEL_TEXT[sk.level]))) throw new Error('每一筆不應重複寫原因');
    // 基準中沒有的鍵：明確說明，不是空白
    const nf = $('#patch-body').testAll('.patch-skip').find((r) => r.getAttribute('data-finding') === MISSING_KEY);
    if (!nf || !nf.querySelector('.finding-missing') || nf.querySelector('.finding-missing').textContent !== RV.MISSING_FINDING_TEXT) throw new Error('基準中沒有的鍵應說明「' + RV.MISSING_FINDING_TEXT + '」');
    if (nf.querySelector('.finding-ref')) throw new Error('基準中沒有的鍵不應有連結');
    // 逐筆勾選：每一筆 A12 各一個勾選框，標示比對對象；勾一個只加入那一筆
    $('#patch-body').querySelector('.patch-clear').click();
    const g = $('#patch-body').testAll('.patch-group').find((x) => x.getAttribute('data-rule-id') === 'A12');
    g.open = true; g.dispatch('toggle');
    const picks = g.testAll('.patch-pick');
    if (picks.map((cb) => cb.getAttribute('data-key')).sort().join('\n') !== a12.map((x) => x.key).sort().join('\n')) throw new Error('每一筆 A12 應各有一個勾選框');
    a12.forEach((x) => {
      const row = g.testAll('.patch-pick-row').find((r) => r.querySelector('.patch-pick').getAttribute('data-key') === x.key);
      if (!row.textContent.includes(x.f.message) || !row.querySelector('.facet') || row.querySelector('.facet').textContent !== RV.facetText(x.f)) throw new Error('勾選列應列出自己的訊息與比對對象');
    });
    const ntp = byFacet.get('ntp').key;
    const pick = picks.find((cb) => cb.getAttribute('data-key') === ntp);
    pick.checked = true; pick.dispatch('change');
    if (PV.state.keys.size !== 1 || !PV.state.keys.has(ntp)) throw new Error('勾選 NTP 只應加入 NTP 那一筆');
    const after = $('#patch-body').testAll('.patch-skip').map((r) => r.getAttribute('data-finding'));
    if (after.join() !== ntp) throw new Error('只勾選 NTP 時，計畫只應有 NTP 那一筆：' + after.join('｜'));
    App.showView('graph');
    // 過長的訊息截斷，完整內容在 title
    const long = 'x'.repeat(RV.FINDING_TEXT_MAX + 30);
    const el = RV.findingRef(App, { idx: 0, f: { message: long } }, 'k');
    if (el.textContent.length !== RV.FINDING_TEXT_MAX || !el.textContent.endsWith('…') || el.getAttribute('title') !== long) throw new Error('過長的訊息應截斷，完整內容放在 title');
  });
  await step('修正計畫的未產生指令：仍共用 findingKey 的 I03（同一份收集檔多段無法辨識）依位置對應，各列出自己的訊息，點了開啟該筆', async () => {
    const RM = S.remediate; const RV = S.view.remediation; const PV = S.view.patchView;
    await buildInput(['SW_A (10.0.0.1):', '### /ip arp print detail', ' 0 address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1', 'GARBAGE LINE one',
      '### /ip address print detail', ' 0 address=10.0.0.1/24 network=10.0.0.0 interface=ether1', 'GARBAGE LINE two', ''].join('\n'));
    const Q = App.Q; const all = Q.findings();
    const i03 = all.map((f, idx) => ({ f, idx, key: Q.findingKey(f) })).filter((x) => x.f.id === 'I03');
    if (i03.length < 2) throw new Error('測試資料應有同一台設備的多段 I03');
    if (new Set(i03.map((x) => x.key)).size !== 1 || i03.some((x) => x.f.facet != null)) throw new Error('前提：I03 不帶 facet，同一台設備的多段共用一個鍵');
    if (new Set(i03.map((x) => x.f.message)).size !== i03.length) throw new Error('前提：各段的訊息不同');
    const key = i03[0].key;
    PV.open(App, [key]);
    const sk = RM.plan(Q, [key]).skipped.filter((x) => x.findingKey === key);
    if (sk.length !== i03.length) throw new Error('共用鍵的每一筆都應是一個未產生指令的項目');
    // 依位置對應：同一個鍵的第 n 筆對到基準中這個鍵的第 n 筆
    if (RV.matchFindings(Q, sk).map((m) => m && m.idx).join() !== i03.map((x) => x.idx).join()) throw new Error('共用鍵時應依位置對回基準中的每一筆');
    const rowsOf = () => $('#patch-body').testAll('.patch-skip').filter((r) => r.getAttribute('data-finding') === key);
    const rows = rowsOf();
    if (rows.length !== i03.length) throw new Error('每一筆未產生指令的項目都應列出');
    if (!rows.every((r, n) => r.textContent.includes(i03[n].f.message) && i03.every((o, m) => m === n || !r.textContent.includes(o.f.message)))) throw new Error('每一列應列出自己那一筆的訊息');
    const group = $('#patch-body').testAll('.patch-skip-group').find((x) => x.getAttribute('data-reason') === sk[0].reason);
    if (!group.querySelector('.patch-label').textContent.includes(RM.SKIP_TEXT[sk[0].reason])) throw new Error('分組標題應是 SKIP_TEXT');
    if (rows.some((r) => r.textContent.includes(RM.SKIP_TEXT[sk[0].reason]) || r.textContent.includes(RV.LEVEL_TEXT[sk[0].level]))) throw new Error('每一筆不應重複寫原因');
    const orig = App.selectFinding; const opened = [];
    App.selectFinding = (i) => { opened.push(i); return orig(i); };
    try {
      i03.forEach((x, n) => {
        const link = rowsOf()[n].querySelector('.finding-ref');
        if (!link || link.getAttribute('title') !== x.f.message) throw new Error('訊息連結的 title 應是完整訊息');
        if (n === 0) link.click(); else link.dispatch('keydown', { key: 'Enter' });
        if (opened[opened.length - 1] !== x.idx) throw new Error('點擊應開啟這一筆的檢查結果');
        if (!PV.isOpen(App)) throw new Error('開啟檢查結果時修正計畫應留在中間（詳情在右側）');
      });
      if (new Set(opened).size !== i03.length) throw new Error('不同的列應開啟不同的檢查結果');
    } finally { App.selectFinding = orig; }
    // 逐筆勾選以鍵為單位：共用鍵的多段只有一個勾選框（計畫也以鍵為單位）
    PV.open(App);
    const g = $('#patch-body').testAll('.patch-group').find((x) => x.getAttribute('data-rule-id') === 'I03');
    g.open = true; g.dispatch('toggle');
    const picks = g.testAll('.patch-pick').map((cb) => cb.getAttribute('data-key'));
    if (picks.join() !== key) throw new Error('共用鍵的 I03 應只有一個勾選框：' + picks.join('｜'));
    App.showView('graph');
  });
  await step('只有 MNDP 的設備對不畫線；詳情仍說明是 L2 廣播網域可達、未確認直連', async () => {
    const input = 'A (10.0.0.1):\n### /ip neighbor print detail\n'
      + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    if (App.snap.meta.inputHash !== hash) throw new Error('MNDP 基準未建立');
    const domainLink = App.snap.model.links.find((l) => l.evidenceScope === 'broadcast-domain');
    if (!domainLink) throw new Error('MNDP 仍應保留在基準的鏈路中');
    if (Array.from(App.pairs.values()).some((x) => !x.virtual)) throw new Error('只有 MNDP 的設備對不應畫線');
    App.select({ type: 'device', key: 'A' });
    if (!text('#detail').includes('未確認直連')) throw new Error('設備鄰居表仍應列出 MNDP，並說明非直連');
    App.select({ type: 'link', key: domainLink.key });
    if (!text('#detail').includes('未確認直連')) throw new Error('MNDP 細節未明示非直連語意');
    const remoteEp = S.keys.splitEp(domainLink.a)[0] === 'A' ? domainLink.b : domainLink.a;
    App.select({ type: 'interface', key: remoteEp });
    if (!text('#detail').includes('MNDP：L2 廣播網域可達，非直連')) throw new Error('MNDP 回報介面的細節不應呈現為直連線');
  });
  await step('鏈路埠名：縮小時隱藏，滑過鏈路或節點時強制顯示', () => {
    const graph = App.graph; const ctx = graph.ctx;
    const old = { nodes: graph.nodes, edges: graph.edges, pos: graph.pos, sel: graph.sel, hl: graph.hl, hover: graph.hover, fillText: ctx.fillText };
    const nodes = ['pa', 'pb'].map((id) => ({ id, label: id, kind: 'switch', collected: true, group: 'test' }));
    const edges = [{ id: 'pe', a: 'pa', b: 'pb', cls: 'other', count: 1, evidence: 'adjacency', labelA: 'etherA1', labelB: 'etherB1' }];
    const texts = [];
    try {
      ctx.fillText = (s) => { texts.push(String(s)); };
      graph.setData(nodes, edges, new Map([['pa', { x: 0, y: 0 }], ['pb', { x: 400, y: 0 }]])); graph.hl = null; graph.setSelection([], []); graph.fit();
      graph.s = 0.5; graph.hover = null; texts.length = 0; graph.draw();
      if (texts.some((s) => s.startsWith('ether'))) throw new Error('縮小且未滑過時不應顯示埠名');
      graph.hover = { type: 'edge', id: 'pe' }; texts.length = 0; graph.draw();
      if (!texts.includes('etherA1') || !texts.includes('etherB1')) throw new Error('滑過連線時應顯示兩端埠名');
      graph.hover = { type: 'node', id: 'pa' }; texts.length = 0; graph.draw();
      if (!texts.includes('etherA1')) throw new Error('滑過節點時應顯示相鄰連線的埠名');
    } finally {
      Object.assign(graph, { nodes: old.nodes, edges: old.edges, pos: old.pos, sel: old.sel, hl: old.hl, hover: old.hover }); ctx.fillText = old.fillText;
    }
  });
  await step('推論鏈路以 theme 的弱邊樣式呈現，高亮不淡化', () => {
    const graph = App.graph; const ctx = graph.ctx; const weak = S.view.theme.weakEdge;
    const old = {
      nodes: graph.nodes, edges: graph.edges, pos: graph.pos, sel: graph.sel, hl: graph.hl, hover: graph.hover,
      s: graph.s, tx: graph.tx, ty: graph.ty, stroke: ctx.stroke, setLineDash: ctx.setLineDash,
      moveTo: ctx.moveTo, lineTo: ctx.lineTo,
    };
    const nodes = ['weak-a', 'weak-b', 'mixed-a', 'mixed-b'].map((id) => ({
      id, label: id, kind: 'switch', collected: true, group: 'test',
    }));
    const edges = [
      { id: 'weak-edge', a: 'weak-a', b: 'weak-b', cls: 'other', count: 1, evidence: 'inferred' },
      { id: 'mixed-evidence', a: 'mixed-a', b: 'mixed-b', cls: 'other', count: 1, evidence: 'adjacency', hasDomain: true },
    ];
    const pos = new Map([['weak-a', { x: 0, y: 0 }], ['weak-b', { x: 180, y: 0 }], ['mixed-a', { x: 0, y: 180 }], ['mixed-b', { x: 180, y: 180 }]]);
    const strokes = []; let dash = []; let from = null; let to = null;
    const samePoint = (a, b) => a && b && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
    const segmentStrokes = (aId, bId) => strokes.filter((s) =>
      (samePoint(s.from, pos.get(aId)) && samePoint(s.to, pos.get(bId))) ||
      (samePoint(s.from, pos.get(bId)) && samePoint(s.to, pos.get(aId))));
    try {
      ctx.setLineDash = (pattern) => { dash = pattern.slice(); };
      ctx.moveTo = (x, y) => { from = { x, y }; to = null; };
      ctx.lineTo = (x, y) => { to = { x, y }; };
      ctx.stroke = () => { strokes.push({ alpha: ctx.globalAlpha, color: ctx.strokeStyle, dash: dash.slice(), from, to }); };
      graph.setData(nodes, edges, pos); graph.hl = null; graph.hover = null; graph.setSelection([], []); graph.fit(); graph.draw();
      const pure = segmentStrokes('weak-a', 'weak-b');
      if (!pure.some((s) => s.alpha === weak.inferred.alpha && s.color === S.view.theme.edge.other.c && s.dash.join() === weak.inferred.dash.join())) throw new Error('推論鏈路應保留連線類別色，只改 theme 指定的透明度與虛線');
      const mixed = segmentStrokes('mixed-a', 'mixed-b');
      if (!mixed.length || mixed.some((s) => s.alpha !== 1)) throw new Error('有介面鄰接的邊不應套用弱邊透明度');
      graph.setSelection([], ['weak-edge']); strokes.length = 0; graph.draw();
      if (!segmentStrokes('weak-a', 'weak-b').some((s) => s.alpha === 1)) throw new Error('選取高亮應維持完整不透明度');
      graph.setSelection([], []); graph.hover = { type: 'edge', id: 'weak-edge' }; strokes.length = 0; graph.draw();
      if (!segmentStrokes('weak-a', 'weak-b').some((s) => s.alpha === 1)) throw new Error('hover 高亮應維持完整不透明度');
    } finally {
      ctx.stroke = old.stroke; ctx.setLineDash = old.setLineDash; ctx.moveTo = old.moveTo; ctx.lineTo = old.lineTo;
      graph.setData(old.nodes, old.edges, old.pos); graph.setSelection(old.sel.nodes, old.sel.edges);
      graph.setHighlight(old.hl); graph.hover = old.hover; graph.s = old.s; graph.tx = old.tx; graph.ty = old.ty; graph.redraw();
    }
  });
};
