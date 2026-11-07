// 畫面冒煙測試的 step：VRF：L3 分框、IP 搜尋、路由追蹤與 L4 查詢；只有 main 的網路。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { document, S, path, step, captureDownloads, parseCsv, goStep, searchFor, pickInv, $, text, L4, l4Cells, l4State, overlapIp } = require('../helpers.js');

/** 展開 L4 的內部互通（矩陣只在展開時計算），等矩陣畫好 */
const openMatrix = async () => { const f = $('#l4-matrix-fold'); if (!(f.open || f.getAttribute('open') != null)) { f.setAttribute('open', ''); f.open = true; f.dispatch('toggle'); } await App.l4MatrixJob; };

module.exports = async () => {
  // ------------------------------------------------------------ M3：VRF（範例資料的 PE 有 VRF、與 main 重疊的位址與路由洩漏，CE 有策略路由）
  await step('VRF：L3 每個 VRF 一個框（同一個前綴在不同 VRF 是不同的網段，設備在每個 VRF 各一個節點）；說明寫出 VRF 與沒畫的策略路由；選取對到該 VRF 的節點', async () => {
    if (process.env.SMOKE_INPUT) return; // 範例資料才有 PE／CE
    const Q = App.Q; const g = App.graph; const V = S.view; const K = S.keys; const MAIN = K.MAIN_VRF;
    const PE = 'TPE_PE_RT_01';
    const vrf = Q.vrfs().find((v) => v !== MAIN);
    if (!Q.getDevice(PE) || !vrf) throw new Error('測試前提：範例資料有 PE 與 main 以外的 VRF');
    App.l3.routes = false; App.showLayer('l3'); await App.layerJob;
    const sg = Q.subnetGraph(); const e = App.layerEntry();
    if (!e.info.byVrf || e.info.vrfs[0] !== MAIN || !e.info.vrfs.includes(vrf)) throw new Error('L3 應依 VRF 分框（main 在最前）');
    // VRF 是外框（outer），框內依路由網域分群（group）；網段的群就是它的路由網域，不同 VRF 的群名不重複
    sg.subnets.forEach((s) => { const n = g.nodeById.get('net|' + s.id); if (!n || n.outer !== V.vrfText(s.vrf)) throw new Error('子網應在自己 VRF 的框裡：' + s.id); });
    sg.nodes.forEach((n) => { const x = g.nodeById.get(n.id); if (!x || x.outer !== V.vrfText(n.vrf) || x.dev !== n.dev) throw new Error('設備節點應在自己 VRF 的框裡：' + n.id); });
    const groupsByOuter = new Map(); g.nodes.forEach((n) => S.util.getOr(groupsByOuter, n.group, () => new Set()).add(n.outer));
    groupsByOuter.forEach((os, gname) => { if (os.size !== 1) throw new Error('分群不應跨 VRF 的框：' + gname); });
    sg.subnets.filter((s) => s.basis === 'connected').forEach((s) => {
      const d = Q.routingDomainOf(s.id); const n = g.nodeById.get('net|' + s.id);
      if (!d || n.domain !== d.key || !n.group) throw new Error('直連網段應在自己的路由網域群裡：' + s.id);
    });
    const peVrf = K.inVrf(PE, vrf);
    if (!g.nodeById.has(peVrf) || !g.nodeById.has(PE) || !g.nodeById.get(peVrf).label.endsWith(`（${vrf}）`)) throw new Error('PE 應在 main 與 ' + vrf + ' 各一個節點，非 main 的寫成「名稱（VRF）」');
    const same = sg.subnets.find((s) => s.vrf !== MAIN && sg.subnets.some((x) => x.vrf === MAIN && x.prefix === s.prefix));
    if (!same || !g.nodeById.has('net|' + same.id) || !g.nodeById.has('net|' + same.prefix)) throw new Error('同一個網段在不同 VRF 應是不同的子網節點');
    g.computeGroups();
    const boxes = (g.groupBoxes || []).map((b) => b.name);
    e.info.vrfs.forEach((v) => { if (!boxes.includes(V.vrfText(v))) throw new Error('畫布應畫出 VRF 的框：' + v); });
    const note = $('#layer-note').textContent;
    if (!note.includes('每個 VRF 一個框') || !e.info.vrfs.every((v) => note.includes(v))) throw new Error('L3 的說明應寫出 VRF：' + note);
    // 提示與點選：VRF 節點的提示寫出 VRF，點了開啟設備
    g.emit('hover', { item: { type: 'node', id: peVrf }, x: 0, y: 0 });
    if (!text('#tooltip').includes(V.vrfText(vrf))) throw new Error('VRF 節點的提示應寫出 VRF');
    g.emit('click', { type: 'node', id: peVrf });
    if (App.sel.type !== 'device' || App.sel.key !== PE || !g.sel.nodes.has(peVrf) || !g.sel.nodes.has(PE)) throw new Error('點 VRF 節點應開啟設備，並標出它在每個 VRF 的節點');
    // 選取介面：標出介面所在 VRF 的節點
    const ifc = Q.interfacesOf(PE).find((i) => i.vrf === vrf && Q.addressesOf(i.key).length);
    App.select({ type: 'interface', key: ifc.key });
    if (!g.sel.nodes.has(peVrf) || g.sel.nodes.has(PE)) throw new Error('選取 VRF 的介面應標出那個 VRF 的節點');
    // 子網詳情：VRF 與其他 VRF 的同一個網段
    App.select({ type: 'subnet', key: same.id });
    const sd = text('#detail');
    if (!sd.includes(vrf) || !sd.includes('同一個網段也在') || !$('#detail').testAll('a').some((a) => a.textContent === same.prefix)) throw new Error('子網詳情應寫出 VRF 與其他 VRF 的同一個網段：' + sd.slice(0, 200));
    // 顯示路由：路由接在設備在那個 VRF 的節點；洩漏的閘道標 @VRF；沒畫的策略路由寫在說明
    $('#btn-l3-routes').click(); await App.layerJob;
    const sgr = Q.subnetGraph({ routes: true });
    const leak = g.edges.find((x) => x.route && x.route.dev === PE && x.route.nh.some((n) => n.ip && n.vrf && n.vrf !== x.route.vrf));
    if (!leak || leak.a !== peVrf || leak.route.node !== peVrf) throw new Error('洩漏的路由應從 PE 在 ' + vrf + ' 的節點出發');
    const lnh = leak.route.nh.find((n) => n.ip && n.vrf !== leak.route.vrf);
    g.emit('hover', { item: { type: 'edge', id: leak.id }, x: 0, y: 0 });
    if (!text('#tooltip').includes(`${lnh.ip}@${lnh.vrf}`) || !text('#tooltip').includes('路由表 ' + leak.route.routingTable)) throw new Error('洩漏的路由提示應寫出 位址@VRF 與路由表：' + text('#tooltip'));
    if (!sgr.omitted.policyRoutes) throw new Error('測試前提：範例資料的 CE 有只用於策略路由的路由表');
    if (!$('#layer-note').textContent.includes(`${V.num(sgr.omitted.policyRoutes)} 條只用於策略路由`)) throw new Error('L3 的說明應寫出沒畫的策略路由：' + $('#layer-note').textContent);
    App.graph.draw();
    $('#btn-l3-routes').click(); await App.layerJob;
    App.select(null); App.showLayer('device');
  });
  await step('VRF：IP 搜尋時同一個 IP 在多個 VRF 列出每個 VRF 讓使用者選（鍵盤可選）；選了只看那個 VRF；介面、設備與路由的詳情顯示 VRF、路由表、下一跳的 VRF 與策略路由', async () => {
    if (process.env.SMOKE_INPUT) return;
    const Q = App.Q; const V = S.view; const K = S.keys; const MAIN = K.MAIN_VRF;
    const ip = overlapIp(Q); const all = ip && Q.findIp(ip);
    if (!ip || all.vrfs.length < 2) throw new Error('測試前提：範例資料有和 main 重疊的位址');
    await searchFor(ip); const inp = $('#search');
    if (!text('#search-dd').includes(ip)) throw new Error('搜尋應列出這個 IP');
    inp.dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'ip' || App.sel.vrf != null) throw new Error('搜尋的 IP 不分 VRF');
    const rows = () => $('#detail').testAll('.ip-vrf-row');
    if (!text('#detail').includes(`${all.vrfs.length} 個 VRF 有這個位址`) || rows().length !== all.vrfs.length) throw new Error('同一個 IP 在多個 VRF 時應每個 VRF 一列：' + text('#detail').slice(0, 200));
    all.vrfs.forEach((v) => { if (!rows().some((tr) => tr.textContent.includes(v))) throw new Error('應列出 VRF ' + v); });
    const at = all.vrfs.findIndex((v) => v !== MAIN); const want = all.vrfs[at];
    if (rows()[at].getAttribute('tabindex') !== '0') throw new Error('VRF 的列應可用鍵盤聚焦');
    rows()[at].dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'ip' || App.sel.key !== ip || App.sel.vrf !== want) throw new Error('選了 VRF 應只看那個 VRF');
    if ($('#detail').querySelector('h2').textContent !== `${ip}@${want}` || rows().length) throw new Error('選了 VRF 的標題應是 位址@VRF，不再列選擇');
    // 回到不分 VRF 的選擇表前先檢查：選擇表已列 VRF／設定在／所屬網段時，下方屬性不重複列（見下方「看所有 VRF」後）
    const own = Q.findIp(ip, want).owners[0];
    if (!text('#detail').includes(Q.epName(own.ep))) throw new Error('應列出這個 VRF 的擁有者');
    // 從這個 IP 追蹤：預先選好這個 VRF
    $('#detail').testAll('button').find((b) => b.textContent === '從這個 IP 追蹤路由').click();
    if ($('#trace-vrf').value !== want || $('#trace-vrf-row').classList.contains('hidden')) throw new Error('從某個 VRF 的 IP 追蹤時應預先選好 VRF');
    $('#trace-pop').classList.add('hidden');
    $('#detail').querySelector('.ip-all-vrfs').click();
    if (App.sel.vrf != null || rows().length !== all.vrfs.length) throw new Error('「看所有 VRF」應回到不分 VRF');
    const ks = $('#detail').testAll('.k').map((k) => k.textContent);
    if (['VRF', '設定在', '所屬網段'].some((k) => ks.includes(k))) throw new Error('在多個 VRF 時，選擇表已列出的 VRF／設定在／所屬網段不應在下方重複：' + ks.join());
    // 清單的 IP 每個 VRF 一列，點了只看那個 VRF
    const r0 = Q.inventory().rows.ips.find((r) => r.ip === ip && r.vrf === want);
    if (!r0) throw new Error('清單應有這個 IP 在 ' + want + ' 的列');
    // 介面詳情：VRF 與依據
    App.select({ type: 'interface', key: own.ep });
    const i = Q.getInterface(own.ep); const idt = text('#detail');
    if (!idt.includes('VRF') || !idt.includes(want) || !idt.includes(V.IFC_VRF_BASIS[i.vrfBasis])) throw new Error('介面詳情應寫出 VRF 與依據：' + idt.slice(0, 300));
    if (V.IFC_VRF_INFERRED.has(i.vrfBasis) !== $('#detail').querySelector('.ifc-vrf').textContent.includes('推論')) throw new Error('VRF 依據是推論時才標推論');
    // 設備詳情（PE）：VRF 設定、路由表欄、洩漏的下一跳標 @VRF
    const PE = K.splitEp(own.ep)[0]; App.select({ type: 'device', key: PE });
    const pd = text('#detail'); const defs = Q.vrfsOf(PE);
    if (!defs.length || !defs.every((v) => pd.includes(v.name)) || !$('#detail').testAll('th').some((x) => x.textContent === '路由表')) throw new Error('設備詳情應列出 VRF 設定與路由表欄');
    const leak = Q.routesOf(PE).find((r) => r.nh.some((n) => n.ip && n.vrf !== r.vrf));
    if (leak) { const n = leak.nh.find((x) => x.ip && x.vrf !== leak.vrf); if (!pd.includes(`${n.ip}@${n.vrf}`)) throw new Error('洩漏的下一跳應標 位址@VRF'); }
    // 設備詳情（有策略路由的 CE）：policy-rules、路由表、/routing rule 與來源
    const ce = Q.devices().find((d) => Q.policyOf(d.key).rules.length);
    if (!ce) throw new Error('測試前提：範例資料有 /routing rule');
    App.select({ type: 'device', key: ce.key });
    const cd = text('#detail'); const pol = Q.policyOf(ce.key);
    if (!cd.includes('策略路由') || !cd.includes(pol.policyRules.join(' → ')) || !pol.tables.every((t) => cd.includes(t.name)) || !Q.routingRules().filter((r) => r.dev === ce.key).every((r) => cd.includes(r.action))) throw new Error('設備詳情應列出策略路由的設定：' + cd.slice(0, 300));
    if (pol.tables.some((t) => t.vrf == null) && !cd.includes('只用於策略路由')) throw new Error('不是 VRF 的路由表應標「只用於策略路由」');
    App.select(null);
  });
  await step('VRF：路由追蹤可選 VRF，來源在多個 VRF 時提示選擇（不猜）；逐跳顯示 VRF、路由表與 /routing rule，策略路由不明與丟棄的結果有中文說明', async () => {
    if (process.env.SMOKE_INPUT) return;
    const Q = App.Q; const V = S.view; const K = S.keys; const MAIN = K.MAIN_VRF;
    const ip = overlapIp(Q); const vrfs = Q.findIp(ip).vrfs; const want = vrfs.find((v) => v !== MAIN);
    const dst = (Q.routesOf('TPE_PE_RT_01', want).flatMap((r) => r.nh).find((n) => n.ip && n.vrf !== want) || {}).ip; // 洩漏的閘道
    if (!dst) throw new Error('測試前提：PE 有洩漏到 main 的路由');
    App.openTrace(ip, dst, '');
    if ($('#trace-vrf-row').classList.contains('hidden')) throw new Error('基準有多個 VRF 時應顯示 VRF 選單');
    const opts = $('#trace-vrf').testAll('option').map((o) => o.getAttribute('value'));
    require('assert').deepStrictEqual(opts, [''].concat(Q.vrfs()));
    const before = App.sel;
    $('#trace-run').click();
    if ($('#trace-pop').classList.contains('hidden') || $('#trace-msg').classList.contains('hidden') || !text('#trace-msg').includes('多個 VRF') || App.sel !== before) throw new Error('來源在多個 VRF 時應留在追蹤畫面並提示選擇：' + text('#trace-msg'));
    if (document.activeElement !== $('#trace-vrf')) throw new Error('提示選擇時焦點應移到 VRF 選單');
    $('#trace-vrf').value = want; $('#trace-vrf').dispatch('keydown', { key: 'Enter' });
    const t = App.sel.result;
    if (App.sel.type !== 'trace' || !t.ok || t.vrf !== want || !$('#trace-pop').classList.contains('hidden') || !$('#trace-msg').classList.contains('hidden')) throw new Error('選了 VRF 後應追蹤那個 VRF');
    const d = text('#detail');
    if (!d.includes(V.vrfText(want)) || !d.includes('（指定）')) throw new Error('追蹤結果應寫出 VRF 與是否指定：' + d.slice(0, 200));
    t.hops.forEach((hp) => { if (!$('#detail').testAll('.hop').some((x) => x.dataset.vrf === hp.vrf)) throw new Error('每一跳應標出 VRF'); });
    const nx = t.hops.flatMap((hp) => hp.next).find((n) => n.dev && n.vrf !== want);
    if (!nx || !d.includes('@' + nx.vrf)) throw new Error('下一台在別的 VRF（路由洩漏）時應標出 @VRF');
    App.graph.draw();
    // 策略路由：可判斷的 /routing rule 查別的路由表；條件無法判斷時結果不明，列出規則
    const ce = Q.devices().find((x) => Q.policyOf(x.key).rules.length).key;
    const lan = Q.subnetsOf(ce).find((s) => Q.policyOf(ce).rules.some((r) => r.match['src-address'] && S.ip.inNet(r.match['src-address'].split('/')[0], s.net, s.len)));
    const rule1 = Q.policyOf(ce).rules.find((r) => r.match['src-address'] && r.table);
    const inRule = S.ip.fromInt(S.ip.toInt(rule1.match['src-address'].split('/')[0]) + 5);
    App.openTrace(inRule, '10.1.10.1', ''); $('#trace-run').click();
    const tp = App.sel.result;
    const hop = tp.ok && tp.hops.find((hp) => hp.rule);
    if (!hop || hop.table !== rule1.table || !text('#detail').includes('路由表 ' + rule1.table) || !text('#detail').includes(`/routing rule 第 ${rule1.order} 條`)) throw new Error('依 /routing rule 查的路由表應標在那一跳：' + text('#detail').slice(0, 300));
    const odd = Q.policyOf(ce).rules.find((r) => Object.keys(r.match).some((k) => !['src-address', 'dst-address', 'interface', 'routing-mark'].includes(k)) && r.match['dst-address']);
    if (!odd || !lan) throw new Error('測試前提：CE 有結果不明的 /routing rule');
    const outRule = S.ip.fromInt(S.ip.toInt(lan.net) + 5); const odst = S.ip.fromInt(S.ip.toInt(odd.match['dst-address'].split('/')[0]) + 5);
    App.openTrace(outRule, odst, ''); $('#trace-run').click();
    const tu = App.sel.result; const end = tu.ok && tu.ends.find((x) => x.status === 'policy');
    if (!end) throw new Error('條件無法判斷的 /routing rule 應使結果不明：' + JSON.stringify(tu.ends || tu));
    const ud = text('#detail');
    if (!ud.includes(V.TRACE_END.policy) || !ud.includes(`/routing rule 第 ${odd.order} 條`) || !ud.includes('策略路由不明')) throw new Error('策略路由不明應以中文說明並列出規則：' + ud.slice(0, 300));
    // L3 路由追蹤的前提：結果下方收合「這次追蹤的前提」，只列路由層有影響的（短句＋影響），其他收合
    {
      const use = new Map(Q.assumptionUse().map((u) => [u.code, u])); const on = (a) => ['affects', 'missing-data'].includes(use.get(a.code).status);
      const ta = $('#detail').testAll('details').find((d) => d.querySelector('summary') && d.querySelector('summary').textContent.startsWith('這次追蹤的前提'));
      if (!ta || ta.getAttribute('open') != null) throw new Error('路由追蹤的結果下方應有預設收合的「這次追蹤的前提」');
      const items = ta.testAll('li').filter((x) => /\bassume-item\b/.test(x.className));
      const other = ta.testAll('details').find((d) => /\bassume-other\b/.test(d.className));
      const top = items.filter((x) => !(other && other.contains(x)));
      const tw = S.query.traceAssumptions().filter(on);
      require('assert').deepStrictEqual(top.map((x) => x.dataset.code), tw.map((a) => a.code), '這次追蹤的前提只列有影響的路由層前提');
      if (top.some((x) => x.querySelector('.assume-short').textContent !== S.query.traceAssumptions().find((a) => a.code === x.dataset.code).short || !x.querySelector('.assume-impact'))) throw new Error('每條寫短句與影響');
      if (items.length !== S.query.traceAssumptions().length) throw new Error('其他路由層前提收在「其他前提」');
      // 策略路由不明的結束旁有「為什麼」：展開這次追蹤的前提並聚焦 policy-routing
      const w = $('#detail').testAll('a').find((a) => /\btrace-why\b/.test(a.className) && a.dataset.assume === 'policy-routing');
      if (!w) throw new Error('策略路由不明的結束旁應有「為什麼」');
      w.click();
      const li = items.find((x) => x.dataset.code === 'policy-routing');
      if (ta.getAttribute('open') == null || document.activeElement !== li || li.querySelector('.assume-detail').getAttribute('open') == null) throw new Error('「為什麼」應展開這次追蹤的前提並聚焦那一條');
    }
    // 範例資料沒有 drop 的 /routing rule：用同一份結果換上 policy-drop 的結束，確認畫面的說明與規則（畫面只顯示查詢層的結果）
    const drop = Object.assign({}, tu, { reached: false, ends: [{ dev: ce, vrf: MAIN, status: 'policy-drop', note: `策略路由：/routing rule 第 ${odd.order} 條 drop，封包被丟棄`, rule: odd, path: [ce] }] });
    App.select({ type: 'trace', result: drop, reverse: null });
    const dt = text('#detail');
    if (!V.TRACE_END['policy-drop'] || !dt.includes(V.TRACE_END['policy-drop']) || !dt.includes(`/routing rule 第 ${odd.order} 條`) || !$('#detail').testAll('.hop').some((x) => x.dataset.status === 'policy-drop' && x.className.includes('end-bad'))) throw new Error('policy-drop 應有中文說明並列出規則');
    App.select(null);
  });
  await step('VRF：L4 可達性查詢可選 VRF，來源在多個 VRF 時列出可選的 VRF；逐跳標出 VRF；策略路由不明的原因有中文說明；前提取自 S.query.reachAssumptions（ipv4-vrf、policy-routing）；zone 矩陣可依 VRF 篩選，表格與 CSV 一致', async () => {
    if (process.env.SMOKE_INPUT) return;
    const Q = App.Q; const V = S.view; const K = S.keys; const MAIN = K.MAIN_VRF;
    App.showLayer('l4'); await App.l4Job; await openMatrix();
    // 前提：ipv4-vrf、policy-routing 是路由層（S.query.traceAssumptions），L4 頁尾只寫「同 L3 路由追蹤」；範例資料兩條都有影響，列在路由那一行的展開裡，短句取自查詢層
    const use = new Map(Q.assumptionUse().map((u) => [u.code, u]));
    ['ipv4-vrf', 'policy-routing'].forEach((c) => {
      const a = S.query.traceAssumptions().find((x) => x.code === c); const li = $('#l4-assume-' + c);
      if (!a || use.get(c).status !== 'affects') throw new Error('測試前提：範例資料的 ' + c + ' 有影響');
      if (!li || !$('#l4-assume-route').contains(li) || li.querySelector('.assume-short').textContent !== a.short) throw new Error('路由層的前提 ' + c + ' 應在頁尾路由那一行的展開裡，寫查詢層的短句');
    });
    if (L4().testAll('.l4-assume-list li').some((x) => x.dataset.layer === 'route' || S.query.traceAssumptions().some((a) => a.code === x.dataset.code))) throw new Error('L4 的前提清單不列路由層');
    if (L4().querySelector('.l4-vrf-box').classList.contains('hidden')) throw new Error('基準有多個 VRF 時應顯示 VRF 選單');
    const ip = overlapIp(Q); const want = Q.findIp(ip).vrfs.find((v) => v !== MAIN);
    const dst = '10.1.30.2';
    const run = (src, d, proto, port, vrf) => { $('#l4-src').value = src; $('#l4-dst').value = d; $('#l4-proto').value = proto; $('#l4-proto').dispatch('change'); $('#l4-port').value = port; $('#l4-vrf').value = vrf; $('#l4-run').click(); };
    run(ip, dst, 'tcp', '22', '');
    const s = l4State();
    if (s.reach || !s.reachVrfs || s.reachVrfs.length < 2 || !text('#l4-drill').includes('多個 VRF')) throw new Error('來源在多個 VRF 時應提示選擇 VRF：' + text('#l4-drill').slice(0, 200));
    const btns = L4().testAll('.l4-reach-vrfs button');
    if (btns.length !== s.reachVrfs.length) throw new Error('每個可選的 VRF 一個按鈕');
    btns.find((b) => b.dataset.vrf === want).click();
    const r = l4State().reach;
    if (!r || r.vrf !== want || r !== Q.reach(ip, dst, { proto: 'tcp', port: 22, vrf: want }) || $('#l4-vrf').value !== want) throw new Error('選了 VRF 後應用那個 VRF 查詢');
    const dd = text('#l4-drill');
    if (!dd.includes(V.vrfText(want)) || !r.paths.some((p) => p.hops.some((hp) => dd.includes('@' + hp.vrf)))) throw new Error('L3 應標出查詢與每一跳的 VRF：' + dd.slice(0, 300));
    // 策略路由不明：原因有中文說明，列出規則
    const ce = Q.devices().find((x) => Q.policyOf(x.key).rules.length).key;
    const odd = Q.policyOf(ce).rules.find((x) => Object.keys(x.match).some((k) => !['src-address', 'dst-address', 'interface', 'routing-mark'].includes(k)) && x.match['dst-address']);
    // CE 的 LAN：包含 src-address 規則的網段（網段開頭的位址不在那條規則的範圍內）
    const lan = Q.subnetsOf(ce).find((x) => Q.policyOf(ce).rules.some((y) => y.match['src-address'] && S.ip.inNet(y.match['src-address'].split('/')[0], x.net, x.len)));
    run(S.ip.fromInt(S.ip.toInt(lan.net) + 5), S.ip.fromInt(S.ip.toInt(odd.match['dst-address'].split('/')[0]) + 5), 'tcp', '443', '');
    const rp = l4State().reach; const pt = text('#l4-drill');
    if (!rp || rp.verdict !== 'unknown' || !rp.reasons.some((x) => x.code === 'policy-routing')) throw new Error('條件無法判斷的 /routing rule 應使可達性不明：' + JSON.stringify(rp && rp.reasons));
    if (!pt.includes(V.REACH_REASON['policy-routing']) || pt.includes('沒有說明的原因代碼') || !pt.includes(`/routing rule 第 ${odd.order} 條`)) throw new Error('策略路由不明應以中文說明並列出規則：' + pt.slice(0, 300));
    $('#l4-vrf').value = '';
    // zone 矩陣：非 main 的 zone 名稱帶（VRF x）、id 帶 @VRF；依來源 zone 的 VRF 篩選
    const mx = Q.zoneMatrix();
    if (!mx.vrfs.includes(want)) throw new Error('測試前提：zone 矩陣有 ' + want);
    const zv = mx.zones.filter((z) => z.vrf === want);
    if (!zv.length || !zv.every((z) => z.id.endsWith('@' + want) && z.name.includes(`（VRF ${want}）`))) throw new Error('非 main 的 zone 的 id 與名稱應帶 VRF');
    if (!zv.every((z) => L4().testAll('th').some((th) => th.textContent.includes(z.name)))) throw new Error('矩陣的標頭應寫出帶 VRF 的 zone 名稱');
    const box = L4().querySelector('.l4-vrf-filter'); const fsel = $('#l4-vrf-filter');
    if (box.classList.contains('hidden')) throw new Error('zone 在多個 VRF 時應有 VRF 篩選');
    require('assert').deepStrictEqual(fsel.testAll('option').map((o) => o.getAttribute('value')), [''].concat(mx.vrfs));
    fsel.value = want; fsel.dispatch('change');
    const zi = new Map(mx.zones.map((z) => [z.id, z]));
    const cells = l4Cells();
    if (!cells.length || !cells.every((td) => zi.get(td.dataset.src).vrf === want)) throw new Error('VRF 篩選後只列來源在那個 VRF 的 zone');
    if (new Set(cells.map((td) => td.dataset.dst)).size !== mx.zones.length) throw new Error('VRF 篩選後目的保留全部的 zone（看得到跨 VRF 的格子）');
    // 鍵盤：列數與欄數不同時方向鍵照樣移動
    cells[0].dispatch('keydown', { key: 'End' }); if (document.activeElement.dataset.c !== String(mx.zones.length - 1)) throw new Error('End 應移到這一列的最後一欄');
    cells[0].dispatch('keydown', { key: 'ArrowDown' });
    const shown = mx.cells.filter((c) => zi.get(c.src).vrf === want);
    const { files } = await captureDownloads(() => L4().querySelector('.l4-csv').click());
    const csv = parseCsv(files[0].text.replace(/^﻿/, ''));
    const ci = csv[0].indexOf('來源 VRF');
    if (ci < 0 || csv[0].indexOf('目的 VRF') < 0 || csv.length - 1 !== shown.length || !csv.slice(1).every((row) => row[ci] === want) || !files[0].name.includes(want)) throw new Error('CSV 應只有篩選後的格子，並有來源與目的 VRF 欄');
    L4().testAll('.l4-modes button').find((b) => b.dataset.mode === 'table').click(); await App.l4MatrixJob;
    // 表格先只列有允許或無法判斷的格子；展開其餘的格子後比對全部
    { const b = L4().querySelector('.l4-table-all'); if (b && b.getAttribute('aria-expanded') === 'false') b.click(); }
    if (L4().testAll('.l4-row').length !== shown.length || !L4().testAll('th').some((th) => th.textContent === '來源 VRF')) throw new Error('表格檢視也依 VRF 篩選，並有 VRF 欄');
    L4().testAll('.l4-modes button').find((b) => b.dataset.mode === 'matrix').click(); await App.l4MatrixJob;
    fsel.value = ''; fsel.dispatch('change');
    if (l4Cells().length !== mx.cells.filter((c) => !zi.get(c.src).virtual).length) throw new Error('取消 VRF 篩選後列出全部的格子（外部不當來源列）');
    App.showLayer('device');
  });
  await step('只有 main 的網路：畫面與加入 VRF 之前相同（L3 不依 VRF 分框、詳情與清單沒有 VRF 欄位、追蹤與可達性沒有 VRF 選單、矩陣與 CSV 沒有 VRF 欄）', async () => {
    if (process.env.SMOKE_INPUT) return;
    const VA = S.view.app; const orig = { snap: App.snap, sources: App.round.sources, profile: App.round.profile };
    // 範例資料去掉最後的 PE 與 CE（VRF 與策略路由只在它們身上）
    const src = orig.sources.find((x) => x.text.includes('\nTPE_PE_RT_01 ('));
    const cut = src.text.indexOf('\n_____\nTPE_PE_RT_01 (');
    if (cut < 0 || src.text.slice(cut + 1).split('\n_____\n').some((b) => b.trim() && !/^(_____\n)?TPE_(PE|CE)_RT_01 \(/.test(b.trim()))) throw new Error('測試前提：PE 與 CE 是範例資料最後的兩台設備');
    const sources = orig.sources.map((x) => (x === src ? { name: x.name, text: x.text.slice(0, cut + 1) } : x));
    try {
      const snap = S.build(sources, { profile: orig.profile, now: '2026-01-01T00:00:00Z' });
      VA.load(snap, null, { sources, profile: orig.profile }); await App.ledgerJob; await App.layoutJob;
      const Q = App.Q; const g = App.graph;
      require('assert').deepStrictEqual(Array.from(Q.vrfs()), ['main']);
      // L3：不畫 VRF 的框（沒有外框），直接依路由網域分群；設備節點的 id 和加入 VRF 之前相同；說明不提 VRF
      App.showLayer('l3', { rebuild: true }); await App.layerJob;
      if (App.layerEntry().info.byVrf || g.nodes.some((n) => n.outer || String(n.group || '').startsWith('VRF '))) throw new Error('只有 main 時不依 VRF 分框');
      g.nodes.filter((n) => n.kind !== 'subnet' && n.kind !== 'external').forEach((n) => { if (n.id !== n.dev) throw new Error('只有 main 時設備節點的 id 和加入 VRF 之前相同：' + n.id); });
      const dnames = new Set(g.nodes.filter((n) => n.domain).map((n) => n.group));
      if (!Q.routingDomains().length || !dnames.size || g.nodes.filter((n) => n.kind === 'subnet' && !n.routeOnly).some((n) => n.domain !== (Q.routingDomainOf(n.subnet.id) || {}).key)) throw new Error('只有 main 時直接依路由網域分群');
      if ($('#layer-note').textContent.includes('VRF')) throw new Error('只有 main 時 L3 的說明不提 VRF');
      App.showLayer('device');
      // 詳情：介面、有路由的設備、IP 沒有 VRF 欄位
      const dev = Q.devices().find((d) => Q.routesOf(d.key).some((r) => r.nh.some((n) => n.ip)));
      App.select({ type: 'device', key: dev.key });
      if ($('#detail').testAll('th').some((th) => th.textContent === '路由表' || th.textContent === 'VRF') || text('#detail').includes('@main')) throw new Error('只有 main 時設備詳情沒有路由表與 VRF 欄');
      App.select({ type: 'interface', key: Q.interfacesOf(dev.key).find((i) => Q.addressesOf(i.key).length).key });
      if ($('#detail').querySelector('.ifc-vrf')) throw new Error('只有 main 時介面詳情沒有 VRF');
      const ipr = Q.ipEntries().find((r) => r.owner);
      App.select({ type: 'ip', key: ipr.ip });
      const kvKeys = () => $('#detail').testAll('.k').map((k) => k.textContent);
      if ($('#detail').querySelector('h2').textContent !== ipr.ip || $('#detail').testAll('.ip-vrf-row').length || kvKeys().includes('VRF') || text('#detail').includes('（VRF')) throw new Error('只有 main 時 IP 詳情沒有 VRF');
      // 清單：IP 與網段沒有 VRF 欄
      goStep('view'); pickInv('inv-kind', 'ip');
      if (document.testAll('#pane-inventory th').some((th) => th.textContent.startsWith('VRF'))) throw new Error('只有 main 時 IP 清單沒有 VRF 欄');
      // 路由追蹤：沒有 VRF 選單，結果沒有 VRF
      App.openTrace(ipr.ip, '10.1.10.1');
      if (!$('#trace-vrf-row').classList.contains('hidden')) throw new Error('只有 main 時追蹤沒有 VRF 選單');
      $('#trace-run').click();
      // 結果的說明文字來自查詢層（直連網段的說明寫出 VRF main）；畫面自己不加 VRF 的欄位與標示
      if (App.sel.type !== 'trace' || kvKeys().includes('VRF') || $('#detail').testAll('.trace-vrf').length) throw new Error('只有 main 時追蹤結果不標 VRF：' + text('#detail').slice(0, 200));
      // L4：沒有 VRF 選單、沒有 VRF 篩選；表格與 CSV 沒有 VRF 欄
      App.showLayer('l4', { rebuild: true }); await App.l4Job; await openMatrix();
      if (!L4().querySelector('.l4-vrf-box').classList.contains('hidden') || !L4().querySelector('.l4-vrf-filter').classList.contains('hidden')) throw new Error('只有 main 時 L4 沒有 VRF 選單與篩選');
      const { files } = await captureDownloads(() => L4().querySelector('.l4-csv').click());
      if (parseCsv(files[0].text.replace(/^﻿/, ''))[0].some((x) => x.includes('VRF'))) throw new Error('只有 main 時 CSV 沒有 VRF 欄');
      if (text('#l4-zones').includes('（VRF')) throw new Error('只有 main 時 zone 名稱不帶 VRF');
    } finally {
      App.showLayer('device');
      VA.load(orig.snap, null, { sources: orig.sources, profile: orig.profile }); await App.ledgerJob; await App.layoutJob;
    }
  });
};
