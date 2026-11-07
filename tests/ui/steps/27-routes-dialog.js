// 畫面冒煙測試的 step：路由表視窗（V.tableDialog 的第二個使用者）——右欄只有摘要、搜尋框 Enter 開視窗並套用搜尋字、點路由看下一跳的擁有者與原文、
// 選取換掉時視窗關閉（V.tableDialog.follow）、關閉時選取經 App.select 回到設備、窄螢幕單欄與「返回」、從網段詳情定位、追蹤；
// 以及右欄的介面表（兩行式）與鄰居表、linkTable（三欄），和視窗內表格不橫捲的樣式規則。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { S, fs, path, ROOT, step, $, document, pressKey, buildInput, detailRoot, routesRoot, routesList, routesSide, routesSummary } = require('../helpers.js');

/** 有下一跳擁有者（Q.hopOwner）的路由：回傳 { dev, r, n, own }（範例資料一定有） */
const ownedRoute = (Q) => {
  for (const d of Q.devices()) {
    for (const r of Q.allRoutesOf(d.key)) {
      const n = r.nh.find((x) => x.ip && Q.hopOwner(d.key, x.ip, x.vrf));
      if (n) return { dev: d.key, r, n, own: Q.hopOwner(d.key, n.ip, n.vrf) };
    }
  }
  throw new Error('範例資料應有下一跳擁有者在基準內的路由');
};
const keyOf = (r) => S.view.routes.keyOf(r);
/** 視窗左欄 data-key 為 key 的列 */
const rowsOfKey = (key) => routesList().testAll('tr').filter((tr) => tr.getAttribute('data-key') === key);

module.exports = async () => {
  await step('路由表視窗：右欄只有摘要（總數、前幾組、搜尋框、入口）；搜尋框按 Enter 開視窗並套用搜尋字；點路由在右欄看下一跳的擁有者與原文', async () => {
    await buildInput(S.samples['sample-bundle.txt']);
    const Q = App.Q; const { dev, r, n, own } = ownedRoute(Q);
    App.select({ type: 'device', key: dev });
    const summ = routesSummary();
    if (summ.querySelector('table') || summ.testAll('tr').length) throw new Error('右欄的路由表只有摘要，不列路由');
    const count = summ.querySelector('summary').querySelector('.count');
    if (!count || count.textContent !== S.view.num(Q.allRoutesOf(dev).length)) throw new Error('摘要的總數應同 Q.allRoutesOf');
    const top = summ.testAll('.routes-group');
    if (!top.length || top.length > 3) throw new Error('摘要應列出前 1–3 組：' + top.length);
    if (!summ.querySelector('.routes-open') || !summ.querySelector('.routes-search')) throw new Error('摘要應有「查看全部路由」與搜尋框');
    // 點一組：開視窗並展開那一組
    top[0].click();
    const g = routesList().testAll('.biglist-group').find((x) => x.getAttribute('data-group') === top[0].getAttribute('data-group'));
    if (!g || g.getAttribute('open') == null) throw new Error('點摘要的一組應開視窗並展開那一組');
    $('#tdlg-close').click();
    if ($('#dlg-table').open) throw new Error('✕ 應關閉視窗');
    // 搜尋框 Enter：開視窗，搜尋字套用在視窗的搜尋框，結果是 Q.routesMatching 的路由
    const q = `${r.prefix}/${r.len}`;
    const inp = routesSummary().querySelector('.routes-search'); inp.value = q; pressKey('Enter', inp);
    const box = routesList().querySelector('.biglist');
    if (box.querySelector('.biglist-search').value !== q) throw new Error('視窗的搜尋框應帶入搜尋字');
    const want = Q.routesMatching(dev, q);
    if (box.querySelector('.biglist-result').getAttribute('hidden') != null || box.querySelector('.biglist-result').testAll('tbody tr').length !== Math.min(want.length, S.view.BIG_LIST.page)) throw new Error('搜尋字應套用（列出 Q.routesMatching 的路由）');
    // 點路由：右欄是那條路由，下一跳的擁有者同 Q.hopOwner，有原文連結
    const tr = rowsOfKey(keyOf(r))[0]; if (!tr) throw new Error('搜尋結果應有那條路由');
    tr.click();
    if (App.sel.type !== 'routes' || App.sel.route !== keyOf(r)) throw new Error('點路由應同步選取（App.sel）');
    const side = routesSide();
    if (!side.querySelector('h2').textContent.includes(q)) throw new Error('右欄的標題應是那條路由');
    const ownName = own.key.endsWith('|') ? Q.devLabel(own.dev) : Q.epName(own.key);
    if (!side.testAll('.route-owner').some((x) => x.textContent.includes(ownName))) throw new Error('右欄應寫出下一跳的擁有者（Q.hopOwner）：' + ownName);
    if (!side.textContent.includes(S.view.vrfText(n.vrf))) throw new Error('右欄應寫出下一跳解析的 VRF');
    const raw = side.testAll('a').find((a) => a.textContent.includes(`第 ${r.src[0][1]} 行`));
    if (!raw) throw new Error('右欄應有那條路由的原文連結');
    raw.click(); if (!$('#dlg-raw').open) throw new Error('點原文應開啟原文對話框'); $('#raw-close').click();
    if (!side.querySelector('.route-trace')) throw new Error('右欄應有「從這台追蹤到這個網段」');
    // 關閉：選取經 App.select 回到設備，右欄不重畫（入口還在、焦點回到它）
    $('#tdlg-close').click();
    if (App.sel.type !== 'device' || App.sel.key !== dev) throw new Error('關閉視窗後選取回到那台設備');
    if (!detailRoot().contains(inp)) throw new Error('關閉視窗不重畫右欄（開啟它的搜尋框還在）');
    const src = fs.readFileSync(path.join(ROOT, 'src/view/panels/routes.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'src/view/panels/firewall.js'), 'utf8');
    if (/App\.sel\s*=[^=]/.test(src)) throw new Error('視窗不直接設 App.sel，經 App.select');
    App.select(null);
  });

  await step('路由表視窗：選取換成別的東西時關閉（由 V.tableDialog 依 id 判斷）；換成防火牆時換成防火牆視窗；從網段詳情定位到某條路由；追蹤先關視窗', () => {
    const Q = App.Q; const { dev } = ownedRoute(Q);
    App.select({ type: 'routes', dev });
    routesRoot();
    App.select({ type: 'device', key: dev });
    if ($('#dlg-table').open) throw new Error('選取換成設備時視窗應關閉');
    App.select({ type: 'routes', dev }); App.select(null);
    if ($('#dlg-table').open) throw new Error('清除選取時視窗應關閉');
    const fwDev = Q.firewallRules().length ? Q.firewallRules()[0].dev : null;
    if (fwDev) {
      App.select({ type: 'routes', dev: fwDev }); App.select({ type: 'firewall', dev: fwDev });
      const d = S.view.tableDialog.current();
      if (!d || !d.id.startsWith('firewall|')) throw new Error('換成防火牆時開著的應是防火牆視窗');
      App.select(null);
    }
    const src = fs.readFileSync(path.join(ROOT, 'src/view/panels/details.js'), 'utf8');
    if (/V\.firewall\.close|V\.routes\.close/.test(src)) throw new Error('details.render 不寫死各視窗的關閉，由 V.tableDialog.follow 判斷');
    // 從網段詳情的「路由到這個網段」定位：視窗開啟、那一列是選取的、右欄是它
    const sg = Q.subnetGraph({ routes: true });
    const sr = sg.routes.find((x) => x.src.length);
    if (!sr) throw new Error('範例資料應有路由到某個網段');
    App.select({ type: 'subnet', key: sr.subnet });
    const sec = detailRoot().testAll('details').find((x) => x.querySelector('summary').textContent.startsWith('路由到這個網段'));
    sec.open = true; sec.dispatch('toggle');
    const row = sec.testAll('tbody tr').find((tr) => tr.textContent.includes(Q.devLabel(sr.dev))); row.click();
    const key = sr.src[0].join(':');
    const hit = rowsOfKey(key).find((tr) => tr.classList.contains('focus'));
    if (!hit || hit.getAttribute('aria-selected') !== 'true') throw new Error('從網段詳情應定位到那一列');
    if (routesSide().querySelector('.route-detail').getAttribute('data-route') !== key) throw new Error('定位時右欄是那條路由');
    // 追蹤：視窗先關（表單在遮罩底下），追蹤表單帶入目的
    routesSide().querySelector('.route-trace').click();
    if ($('#dlg-table').open || $('#trace-pop').classList.contains('hidden')) throw new Error('追蹤應關閉視窗並開啟路由追蹤');
    if (sr.len > 0 && $('#trace-dst').value !== sr.prefix) throw new Error('追蹤的目的應是那個網段的位址');
    S.view.app.closeTrace(false);
    App.select(null);
  });

  await step('路由表視窗：窄螢幕單欄——表格在前、點路由後只顯示詳情並有「返回」，返回保留選取；視窗內表格不橫捲（可折行、900px 以下每列一塊）、表頭固定、滑過與選取的底色不同', () => {
    const Q = App.Q; const { dev, r } = ownedRoute(Q);
    const prevW = window.innerWidth; window.innerWidth = 390;
    try {
      App.select({ type: 'routes', dev, search: `${r.prefix}/${r.len}` });
      const body = routesRoot();
      if (body.getAttribute('data-view') !== 'list') throw new Error('沒選路由時是表格');
      const tr = rowsOfKey(keyOf(r))[0]; tr.focus(); tr.click();
      if (body.getAttribute('data-view') !== 'detail' || document.activeElement !== routesSide().querySelector('h2')) throw new Error('窄螢幕點路由後只顯示詳情、焦點在標題');
      const back = routesSide().querySelector('.tdlg-back');
      if (!back || !back.textContent.includes('返回')) throw new Error('窄螢幕的詳情應有「返回」');
      back.click();
      if (body.getAttribute('data-view') !== 'list' || App.sel.route !== keyOf(r) || document.activeElement !== tr) throw new Error('返回後回到表格、保留選取、焦點回到那一列');
      if (!routesList().testAll('table').every((t) => /\bstack\b/.test(t.className))) throw new Error('視窗內的表格帶 stack（900px 以下每列一塊）');
    } finally { window.innerWidth = prevW; App.select(null); }
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    if (!/\.tdlg-list \.table-scroll \{ overflow-x: visible; \}/.test(css)) throw new Error('視窗左欄的表格不在 .table-scroll 內橫捲（表頭固定在左欄）');
    if (!/\.tdlg-list table\.t td \.mono, \.tdlg-list table\.t td \.vlanlist \{ white-space: normal; overflow-wrap: anywhere; \}/.test(css)) throw new Error('視窗內的識別字與條件應可折行');
    if (!/\.tdlg-list table\.t td\.wrap \{ max-width: /.test(css)) throw new Error('長欄位（條件、註解）應有最大寬度');
    if (!/table\.t\[role="grid"\] tbody tr\.click:hover td \{ background: var\(--surface-hover\); \}/.test(css)) throw new Error('可選取表格的滑過應用中性的底色，和選取列分得出來');
    if (!/\.tdlg-side \{ order: 1;/.test(css)) throw new Error('窄螢幕時表格在前、總覽在後');
    const fw = fs.readFileSync(path.join(ROOT, 'src/view/panels/firewall.js'), 'utf8');
    if (!/t: '條件', f: \(x\) => matchCell\(x\.rule\), cls: 'wrap'/.test(fw)) throw new Error('規則表的條件欄應可折行（cls wrap）');
  });

  await step('右欄的表格不橫捲：介面表兩行式（第一行名稱、狀態、類型，第二行 VLAN、MAC、位址），鄰居表與 linkTable 三欄；防火牆摘要寫出規則與服務的單位', () => {
    const Q = App.Q;
    const dev = Q.devices().find((d) => d.collected && Q.interfacesOf(d.key).some((x) => S.util.ifcVlans(x).length && x.macs.length));
    if (!dev) throw new Error('範例資料應有同時有 VLAN 與學到 MAC 的介面');
    App.select({ type: 'device', key: dev.key });
    const sec = detailRoot().testAll('details').find((x) => x.querySelector('summary').firstChild.textContent === '介面');
    if (!sec) throw new Error('設備詳情應有介面表');
    if (sec.querySelector('table').testAll('th').length !== 1) throw new Error('介面表是一欄的兩行式');
    const ifc = Q.interfacesOf(dev.key).find((x) => S.util.ifcVlans(x).length && x.macs.length);
    const cell = sec.testAll('.two-line').find((c) => c.querySelector('.l1').textContent.startsWith(ifc.name));
    if (!cell) throw new Error('介面表應有 ' + ifc.name);
    const l2 = cell.querySelector('.l2');
    if (!l2 || !/\bmuted\b/.test(l2.className) || !l2.textContent.includes('VLAN ' + S.util.fmtVlans(S.util.ifcVlans(ifc))) || !l2.textContent.includes(`${S.view.num(ifc.macs.length)} 個 MAC`)) throw new Error('介面表的第二行（muted）應寫出 VLAN 與 MAC：' + (l2 && l2.textContent));
    if (!cell.querySelector('.l1').textContent.includes(S.view.ifcState(ifc))) throw new Error('介面表的第一行應寫出狀態');
    // 鄰居表與 linkTable：三欄
    const nd = Q.devices().find((d) => Q.neighborRows(d.key).length);
    App.select({ type: 'device', key: nd.key });
    const nb = detailRoot().testAll('details').find((x) => x.querySelector('summary').firstChild.textContent === '鄰居');
    if (!nb || nb.querySelector('table').testAll('th').length !== 3) throw new Error('鄰居表應是三欄');
    const ep = Q.links().map((l) => l.a).find((a) => Q.getInterface(a));
    App.select({ type: 'interface', key: ep });
    const lk = detailRoot().testAll('details').find((x) => x.querySelector('summary').firstChild.textContent === '鏈路');
    if (!lk || lk.querySelector('table').testAll('th').length !== 3) throw new Error('linkTable 應是三欄');
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    if (!/\.two-line \.l2 \{[^}]*white-space: normal; overflow-wrap: anywhere;/.test(css)) throw new Error('兩行式的第二行應可折行（360px 不橫捲）');
    // 防火牆摘要：規則與服務的數量寫出單位，標籤不從詞中間折行
    const fd = Q.firewallRules()[0].dev;
    App.select({ type: 'device', key: fd });
    const fs0 = detailRoot().querySelector('.fw-summary');
    if (!fs0.textContent.includes(`${S.view.num(Q.firewallRulesOf(fd).length)} 條`)) throw new Error('防火牆摘要應寫「N 條」規則');
    if (Q.ipServicesOf(fd).length && !fs0.textContent.includes(`${S.view.num(Q.ipServicesOf(fd).length)} 個`)) throw new Error('防火牆摘要應寫服務數');
    if (!/\.fw-summary \.kv \{ grid-template-columns: max-content/.test(css)) throw new Error('防火牆摘要的標籤欄不應折行');
    App.select(null);
  });
};
