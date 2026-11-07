// 畫面冒煙測試的 step：路由表視窗（V.tableDialog 的第二個使用者）——右欄只有摘要、搜尋框 Enter 開視窗並套用搜尋字、點路由看下一跳的擁有者與原文、
// 選取換掉時視窗關閉（V.tableDialog.follow）、關閉時選取經 App.select 回到設備、窄螢幕單欄與「返回」、從網段詳情定位、追蹤；
// 以及右欄的介面表（兩行式）與鄰居表、linkTable（三欄），和視窗內表格不橫捲的樣式規則。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { S, fs, path, ROOT, step, $, document, pressKey, buildInput, detailRoot, routesRoot, routesList, routesSide, routesSummary, workEntry } = require('../helpers.js');

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
    if (!summ.querySelector('.routes-open') || !summ.querySelector('.routes-search')) throw new Error('摘要應有「查看全部路由」與搜尋框');
    // 分組與視窗一致：路由一頁放得下時視窗直接依網段列出（列數同 Q），摘要不列組；否則視窗分組（組數不超過門檻），摘要列出其中最多的 1–3 組
    const P = S.view.BIG_LIST; const nr = Q.allRoutesOf(dev).length;
    const top = summ.testAll('.routes-group');
    summ.querySelector('.routes-open').click();
    const gs = routesList().testAll('.biglist-group').filter((x) => x.getAttribute('data-group') != null);
    if (nr <= P.page) {
      if (top.length || gs.length) throw new Error('路由一頁放得下時不分組（摘要與視窗都不列組）：' + top.length + '／' + gs.length);
      if (routesList().querySelector('#tdlg-panel-routes').testAll('tbody tr').length !== nr) throw new Error('不分組時直接列出全部的路由（列數同 Q.allRoutesOf）');
    } else {
      if (!gs.length || gs.length > nr * P.groupRatio) throw new Error('分組數應不超過門檻：' + gs.length + '／' + nr);
      if (!top.length || top.length > 3 || !top.every((a) => gs.some((g) => g.getAttribute('data-group') === a.getAttribute('data-group')))) throw new Error('摘要應列出視窗裡的 1–3 組：' + top.length);
    }
    // ECMP：每個下一跳一行（不黏成一串）
    const ecmp = S.view.routes.nhCell({ vrf: 'main', nh: [{ ip: '10.0.0.2', ifc: 'ether3', vrf: 'main' }, { ip: '10.0.0.6', ifc: 'ether4', vrf: 'main' }] }, false);
    const hops = ecmp.testAll('.route-nh-one').map((x) => x.textContent);
    if (hops.join('|') !== '10.0.0.2 ether3|10.0.0.6 ether4') throw new Error('多個下一跳應每個一行：' + hops.join('|'));
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
    // 識別字與條件只在空白處折行（break-word：整個字詞一行放不下時才斷），不從字詞中間切開
    if (!/\.tdlg-list table\.t td \.mono, \.tdlg-list table\.t td \.vlanlist \{ white-space: normal; overflow-wrap: break-word; \}/.test(css)) throw new Error('視窗內的識別字與條件應在空白處折行');
    if (!/\.tdlg-list \{ padding: 0 /.test(css)) throw new Error('視窗左欄上方不留 padding（固定的表頭上面不透出被捲走的列）');
    if (!/\.detail-fold > summary::before \{ content: "▸"; color: var\(--muted\);/.test(css) || !/\.detail-fold\[open\] > summary::before \{ content: "▾"; \}/.test(css)) throw new Error('展開列應有 ▸／▾ 記號（顏色用 token）');
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
    // 防火牆摘要（工作入口的一項）：規則與服務的數量寫出單位
    const fd = Q.firewallRules()[0].dev;
    App.select({ type: 'device', key: fd });
    const fs0 = workEntry('防火牆');
    if (!fs0) throw new Error('設備詳情的工作入口應有防火牆');
    if (!fs0.textContent.includes(`${S.view.num(Q.firewallRulesOf(fd).length)} 條規則`)) throw new Error('防火牆摘要應寫「N 條規則」');
    if (Q.ipServicesOf(fd).length && !fs0.textContent.includes(`${S.view.num(Q.ipServicesOf(fd).length)} 個服務`)) throw new Error('防火牆摘要應寫「N 個服務」');
    App.select(null);
  });

  await step('路由表視窗的分頁：VRF、/routing rule、路由表、OSPF 鄰接——右欄只有一行摘要，點一項開那個分頁；分頁的列數同 Q；設備沒有的資料不列分頁', () => {
    const Q = App.Q; const V = S.view;
    // 期望（只由 Q 算）：VRF 只有內建 main 時不列；路由表只在有策略路由時列
    const want = (dev) => {
      const tables = Q.routingTables().filter((t) => t.dev === dev); const rules = Q.routingRules().filter((r) => r.dev === dev);
      const policy = Q.policyOf(dev).any || rules.length > 0 || tables.some((t) => t.vrf == null);
      return { vrfs: Q.vrfsOf(dev).some((v) => !v.builtin) ? Q.vrfsOf(dev).length : 0, rules: rules.length, tables: policy ? tables.length : 0, ospf: Q.ospfAdjacenciesOf(dev).length };
    };
    const shownRows = (n) => (n < V.BIG_LIST.min ? n : V.BIG_LIST.page);
    const seen = new Set();
    Q.devices().forEach((d) => {
      const w = want(d.key); const keys = Object.keys(w).filter((k) => w[k] > 0);
      if (!keys.length) return;
      App.select({ type: 'device', key: d.key });
      const sum = routesSummary();
      ['VRF', '策略路由', 'OSPF L3 鄰接（非實體直連）'].forEach((t) => {
        if (detailRoot().testAll('summary').some((s) => s.firstChild.textContent === t)) throw new Error(d.key + ' 的右欄不應再有「' + t + '」區塊');
      });
      const links = sum.testAll('.routes-tab');
      if (links.map((a) => a.getAttribute('data-tab')).sort().join() !== keys.slice().sort().join()) throw new Error(d.key + ' 的一行摘要應只列有資料的項目：' + links.map((a) => a.textContent).join('、'));
      keys.forEach((k) => {
        const a = sum.testAll('.routes-tab').find((x) => x.getAttribute('data-tab') === k);
        if (!a.textContent.includes(V.num(w[k]))) throw new Error(d.key + ' 的摘要「' + a.textContent + '」應寫出 ' + w[k]);
        a.click();
        const root = routesRoot();
        const tabs = root.testAll('.tdlg-tab').map((b) => b.getAttribute('data-tab'));
        const expTabs = (Q.allRoutesOf(d.key).length ? ['routes'] : []).concat(['vrfs', 'rules', 'tables', 'ospf'].filter((x) => w[x] > 0));
        if (tabs.join() !== expTabs.join()) throw new Error(d.key + ' 的分頁應是 ' + expTabs.join() + '：' + tabs.join());
        const panel = root.querySelector('#tdlg-panel-' + k);
        if (!panel || panel.getAttribute('hidden') != null) throw new Error(d.key + ' 點「' + a.textContent + '」應開 ' + k + ' 分頁');
        if (panel.testAll('tbody tr').length !== shownRows(w[k])) throw new Error(d.key + ' 的 ' + k + ' 分頁列數應同 Q：' + panel.testAll('tbody tr').length + ' / ' + w[k]);
        const chip = root.querySelector('#tdlg-tab-' + k).querySelector('.count');
        if (!chip || chip.textContent !== V.num(w[k])) throw new Error(d.key + ' 的 ' + k + ' 分頁標籤的數字應同 Q');
        seen.add(k);
        $('#tdlg-close').click();
        if (App.sel.type !== 'device' || App.sel.key !== d.key) throw new Error('關閉後回到設備');
      });
    });
    if (!process.env.SMOKE_INPUT) ['vrfs', 'rules', 'tables', 'ospf'].forEach((k) => { if (!seen.has(k)) throw new Error('測試前提：範例資料應有 ' + k + ' 的資料'); });
    App.select(null);
  });

  await step('右欄的兩行式與卡片：終端埠（介面、MAC／IP・廠商・VLAN・描述）、原始輸出（一區塊一張卡片，空的收集時間與失敗不寫）、設備對（協定併進類別）、推論鏈路後的終端、網段的位址與路由（不再寫「只顯示前」）', () => {
    const Q = App.Q; const V = S.view;
    const foldOf = (t) => detailRoot().testAll('details').find((x) => x.querySelector('summary').firstChild.textContent === t);
    // 沒有 LLDP／CDP 鄰接的埠：一欄，第一行介面與 MAC，第二行（muted）IP・廠商・VLAN・描述
    const ud = Q.devices().find((d) => Q.unknownPeers(d.key).some((r) => r.macs.length === 1 && (r.macs[0].ips.length || r.macs[0].vendor)));
    if (!ud) throw new Error('範例資料應有學到一個 MAC、有 IP 或廠商的終端埠');
    App.select({ type: 'device', key: ud.key });
    const us = foldOf('沒有 LLDP／CDP 鄰接的埠');
    if (!us || us.querySelector('table').testAll('th').length !== 1) throw new Error('終端埠是一欄的兩行式');
    Q.unknownPeers(ud.key).forEach((r) => {
      const c = us.testAll('.two-line').find((x) => x.querySelector('.l1').firstChild.textContent === r.name);
      if (!c) throw new Error('終端埠應有 ' + r.name);
      if (!c.querySelector('.l1').textContent.includes(r.macs.length === 1 ? S.keys.macPretty(r.macs[0].mac) : `${r.macs.length} 個 MAC`)) throw new Error('第一行應寫出 MAC：' + c.textContent);
      const l2 = c.querySelector('.l2'); const t2 = l2 ? l2.textContent : '';
      const parts = [...S.util.uniq([].concat(...r.macs.map((m) => m.ips))).slice(0, 3), ...S.util.uniq(r.macs.map((m) => m.vendor).filter(Boolean)).slice(0, 2),
        r.vlans && r.vlans.length ? 'VLAN ' + S.util.fmtVlans(r.vlans) : null, r.desc || null].filter(Boolean);
      if (parts.some((p) => !t2.includes(p)) || (l2 && !/\bmuted\b/.test(l2.className))) throw new Error('第二行（muted）應寫出 IP、廠商、VLAN、描述：' + t2);
    });
    // 原始輸出：一欄的卡片；指令、行號、解析器；收集時間與失敗只在有值時出現
    const bs = Q.blocksOf(ud.key);
    const bf = foldOf('收集到的原始輸出');
    if (!bf || bf.querySelector('table').testAll('th').length !== 1) throw new Error('原始輸出是一欄的卡片');
    const cards = bf.testAll('.block-card');
    if (cards.length !== Math.min(bs.length, bs.length < V.BIG_LIST.min ? bs.length : V.BIG_LIST.page)) throw new Error('一個區塊一張卡片：' + cards.length + ' / ' + bs.length);
    cards.forEach((c, n) => {
      const b = bs[n]; const t = c.textContent;
      if (!t.includes(b.command || '（未標記）') || !t.includes(`第 ${b.start}–${b.end} 行`)) throw new Error('卡片應寫出指令與行號：' + t);
      if (!!b.collectedAt !== t.includes('收集於') || (b.collectedAt && !t.includes(V.fmtUtc(b.collectedAt)))) throw new Error('收集時間只在有值時寫出：' + t);
      if (!!b.failure !== !!c.querySelector('.chip.err')) throw new Error('收集失敗的 chip 只在失敗時出現：' + t);
    });
    // 設備對：沒有「協定」欄，類別帶協定（V.linkClassText 的 proto）
    const p = Array.from(App.pairs.values()).find((x) => x.links.length && Q.inferredLinksBetween(x.a, x.b).some((l) => Q.behindUnder(l.key).length)) || Array.from(App.pairs.values()).find((x) => x.links.length);
    App.select({ type: 'pair', id: p.id, links: p.links, devs: [p.a, p.b] });
    const ls = detailRoot().testAll('.detail-section').find((x) => x.querySelector('h3').firstChild.textContent === '鏈路（LLDP／CDP／MNDP）');
    if (!ls || ls.testAll('th').some((th) => th.textContent === '協定')) throw new Error('設備對的鏈路沒有「協定」欄');
    const l0 = Q.getLink(p.links[0]);
    if (!ls.textContent.includes(V.linkClassText(l0, { proto: true }))) throw new Error('類別應帶協定：' + V.linkClassText(l0, { proto: true }));
    // 推論鏈路後的終端：兩欄，廠商與 IP 在 MAC 的第二行
    const ip = Array.from(App.pairs.values()).find((x) => Q.inferredLinksBetween(x.a, x.b).some((l) => Q.behindUnder(l.key).length));
    if (ip) {
      App.select({ type: 'pair', id: ip.id, links: ip.links, devs: [ip.a, ip.b] });
      const bh = foldOf('推定在這條推論鏈路後面的終端');
      if (!bh || bh.querySelector('table').testAll('th').length !== 2) throw new Error('推論鏈路後的終端是兩欄');
      const x = S.util.uniq(Q.inferredLinksBetween(ip.a, ip.b).flatMap((l) => Q.behindUnder(l.key))).find((m) => m.vendor || m.ips.length);
      if (x && ![x.vendor, ...x.ips].filter(Boolean).every((s) => bh.textContent.includes(s))) throw new Error('廠商與 IP 應在第二行');
    }
    // 網段：位址與路由兩欄，不寫「只顯示前」；路由點一列定位到路由表視窗（前一個 step 已驗）
    const sg = Q.subnetGraph({ routes: true });
    const sr = sg.routes.find((r) => r.via && r.via.length) || sg.routes[0];
    App.select({ type: 'subnet', key: sr.subnet });
    ['位址', '路由到這個網段'].forEach((t) => {
      const f = foldOf(t); if (!f) throw new Error('網段詳情應有「' + t + '」');
      if (f.querySelector('table').testAll('th').length !== 2) throw new Error('網段的「' + t + '」是兩欄');
      if (f.textContent.includes('只顯示前')) throw new Error('網段的「' + t + '」不再寫「只顯示前」');
    });
    const rf = foldOf('路由到這個網段');
    if (!rf.textContent.includes(Q.devLabel(sr.dev)) || (sr.via.length && !rf.textContent.includes('經由 '))) throw new Error('路由到這個網段：設備與經由的網段');
    App.select(null);
  });

  await step('路由表視窗：在視窗內點連結選到別的東西時，視窗關閉、焦點落在右欄新內容的標題；要定位的路由不在基準中時寫出說明（不靜默顯示總覽）', () => {
    const Q = App.Q; const { dev, r } = ownedRoute(Q);
    App.select({ type: 'routes', dev, route: keyOf(r) });
    const link = routesSide().testAll('.link').find((a) => a.tagName === 'A' && a.textContent === Q.devLabel(dev));
    if (!link) throw new Error('路由詳情應有設備的連結');
    link.focus(); link.click();
    if ($('#dlg-table').open) throw new Error('點連結選到設備時視窗應關閉');
    const hd = detailRoot().querySelector('h2');
    if (!hd || document.activeElement !== hd) throw new Error('視窗關閉後焦點應在右欄新內容的標題，而不是掉到 body 或已移除的元素');
    // 基準中沒有的路由：開啟時與視窗開著時改選都寫出說明
    const MISSING = '基準中沒有這條路由';
    App.select({ type: 'routes', dev, route: 'no-such-block:0' });
    if (!routesSide().textContent.includes(MISSING)) throw new Error('開啟時要定位的路由不在基準中應寫出說明：' + routesSide().textContent);
    App.select({ type: 'routes', dev, route: keyOf(r) });
    if (routesSide().textContent.includes(MISSING)) throw new Error('找得到的路由不應有說明');
    App.select({ type: 'routes', dev, route: 'no-such-block:1' });
    if (!routesSide().textContent.includes(MISSING)) throw new Error('視窗開著時改選不在基準中的路由應寫出說明');
    App.select({ type: 'routes', dev });
    if (routesSide().textContent.includes(MISSING)) throw new Error('沒有要定位的路由時不寫說明');
    App.select(null);
  });
};
