// 畫面冒煙測試的 step：詳情區塊、推論鏈路與推定位置、基準狀態、窄螢幕。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { docListeners, winListeners, document, S, fs, path, ROOT, step, stepBtn, $, text } = require('../helpers.js');

module.exports = async () => {
  await step('詳情區塊結構一致：標題只由 section() 產生，展開區塊內沒有額外標題', () => {
    const m = App.snap.model; const Q = App.Q;
    const sels = [
      { type: 'device', key: (m.devices.find((d) => d.collected && d.data.includes('route')) || {}).key },
      { type: 'device', key: (m.devices.find((d) => !d.collected) || {}).key },
      { type: 'link', key: (m.links[0] || {}).key }, { type: 'interface', key: (m.interfaces.find((i) => i.macs.length) || {}).key },
      { type: 'mac', key: (m.macs[0] || {}).mac }, { type: 'ip', key: (Q.ipEntries()[0] || {}).ip }, { type: 'vlan', key: String((m.vlans.find((v) => v.id != null) || {}).id) },
      // 防火牆畫面（panels/firewall.js）也只用 section() 產生區塊
      { type: 'firewall', dev: (m.firewallRules[0] || {}).dev, key: (m.firewallRules[0] || {}).dev },
    ];
    if (sels.some((x) => !x.key || x.key === 'undefined')) throw new Error('範例資料應涵蓋每種詳情');
    sels.forEach((sel) => {
      App.select(sel);
      $('#detail').testAll('h3').forEach((x) => {
        if (!/\bdetail-section\b/.test(x.parentNode.className)) throw new Error(`${sel.type} 詳情的標題「${x.textContent}」不是由 section() 產生`);
      });
      $('#detail').testAll('details').forEach((d) => {
        if (d.testAll('h3').length) throw new Error(`${sel.type} 詳情的展開區塊「${d.querySelector('summary').textContent}」內不應有標題`);
      });
    });
    App.select(null);
  });
  await step('詳細資料瘦身：廠商與鄰居功能用顯示名、長說明與「看到它的設備」收合、標題不用等寬字', () => {
    const V = S.view; const Q = App.Q; const m = App.snap.model;
    if (V.vendorName('mikrotik') !== 'MikroTik' || V.vendorName('Acme') !== 'Acme' || V.vendorName(null) !== '') throw new Error('V.vendorName：mikrotik → MikroTik，沒有對照的原樣');
    if (V.capsText('bridge,router') !== '橋接、路由' || V.capsText('wlan-ap') !== '無線基地台' || V.capsText('bridge,foo') !== '橋接、foo' || V.capsText(null) !== '') throw new Error('V.capsText 應翻成中文、沒有對照的保留原值');
    if (V.STATUS.unknown !== '不明') throw new Error('V.STATUS.unknown 應為「不明」');
    if (V.STATUS !== S.report.IFC_STATUS_TEXT) throw new Error('V.STATUS 應引用 S.report.IFC_STATUS_TEXT（介面狀態文字只有一份，與網路文件共用）');
    const kvOf = (k) => { const ks = $('#detail').testAll('.k'); const n = ks.findIndex((x) => x.textContent === k); if (n < 0) return null; const sib = ks[n].parentNode.childNodes; return sib[sib.indexOf(ks[n]) + 1]; };
    // 鄰居回報的功能：顯示中文，原值在 title
    const capDev = Q.devices().find((d) => d.caps && V.capsText(d.caps) !== d.caps);
    if (capDev) {
      App.select({ type: 'device', key: capDev.key }); const cell = kvOf('鄰居回報功能');
      if (!cell || cell.textContent !== V.capsText(capDev.caps) || !String(cell.querySelector('.caps').getAttribute('title')).includes(capDev.caps)) throw new Error('鄰居回報的功能應顯示中文、原值放 title：' + (cell && cell.textContent));
    } else if (!process.env.SMOKE_INPUT) throw new Error('範例資料應有鄰居回報功能的設備');
    const mt = Q.devices().find((d) => d.manufacturer);
    if (mt) { App.select({ type: 'device', key: mt.key }); const cell = kvOf('廠商'); if (!cell || cell.textContent !== V.vendorName(mt.manufacturer)) throw new Error('設備詳情的廠商應用顯示名'); }
    // 看到它的設備：5 台以內在屬性表，超過時移到預設收合的區塊（同樣的連結，數量一致）
    Q.devices().filter((d) => d.seenBy.length).forEach((d) => {
      App.select({ type: 'device', key: d.key });
      const inline = kvOf('看到它的設備'); const fold = $('#detail').testAll('.detail-fold').find((x) => x.querySelector('summary').textContent.startsWith('看到它的設備'));
      const box = inline || fold;
      if (!box || box.testAll('a').length !== d.seenBy.length) throw new Error(`${d.key} 應列出全部 ${d.seenBy.length} 台看到它的設備`);
      if ((d.seenBy.length > 5) !== !!fold || (fold && fold.getAttribute('open') !== null)) throw new Error(`${d.key} 看到它的設備超過 5 台才收合，且預設收合`);
    });
    if (!process.env.SMOKE_INPUT && !Q.devices().some((d) => d.seenBy.length > 5)) throw new Error('範例資料應有被超過 5 台看到的設備');
    // 鄰居表與鏈路表的「類別」（例如「LLDP・聚合」）不折行撐高列：該欄 td.nowrap，表格本來就在 .table-scroll 內可橫捲
    const appCss = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    if (!/table\.t td\.nowrap\s*\{[^}]*white-space:\s*nowrap/.test(appCss)) throw new Error('app.css 應有 table.t td.nowrap 不換行');
    // 不換行的「類別」放在第二欄以內：1440 寬的右欄不必橫捲就看得到
    const classCells = () => $('#detail').testAll('table').flatMap((t) => {
      const n = t.testAll('th').findIndex((th) => th.textContent.startsWith('類別')); if (n < 0) return [];
      if (n > 1) throw new Error(`「類別」應在第二欄以內，現在是第 ${n + 1} 欄`);
      return t.testAll('tbody tr').map((tr) => tr.testAll('td')[n]);
    });
    let seen = 0;
    Q.devices().slice(0, 30).forEach((d) => {
      App.select({ type: 'device', key: d.key });
      classCells().forEach((td) => { seen++; if (!/\bnowrap\b/.test(td.className)) throw new Error('鄰居表的「類別」欄應不換行（td.nowrap）：' + td.textContent); });
    });
    if (!seen) throw new Error('測試前提：應有設備的鄰居表');
    // VLAN 與終端的長說明收進預設收合的「這是什麼？」；沒有名稱時不列「名稱 —」；終端說明不出現檢查代碼
    const about = () => $('#detail').testAll('.detail-fold').find((x) => x.querySelector('summary').textContent === '這是什麼？');
    const outsideMuted = () => $('#detail').testAll('p').filter((p) => /muted/.test(p.className) && !about().contains(p)).map((p) => p.textContent).join('');
    Q.vlans().slice(0, 20).forEach((v) => {
      if (v.id == null) return; App.select({ type: 'vlan', key: String(v.id) });
      const a = about();
      if (!a || a.getAttribute('open') !== null || outsideMuted().includes('圖上（設備圖')) throw new Error(`VLAN ${v.id} 的說明應預設收合`);
      const named = Q.vlan(String(v.id)).names.length;
      if (!named && kvOf('名稱')) throw new Error(`VLAN ${v.id} 沒有名稱時不應列「名稱」`);
    });
    const epDev = Q.devices().find((d) => Q.unknownPeers(d.key).length);
    if (epDev) {
      App.select({ type: 'endpoints', dev: epDev.key }); const a = about();
      if (!a || a.getAttribute('open') !== null || outsideMuted().includes('一般終端埠') || /\bA0\d\b/.test(a.textContent)) throw new Error('終端詳情的說明應預設收合、不出現檢查代碼');
    }
    // h2 標題不用等寬字（IP、MAC、網段、介面、追蹤）
    const sels = [{ type: 'ip', key: (Q.ipEntries()[0] || {}).ip }, { type: 'mac', key: (m.macs[0] || {}).mac }, { type: 'interface', key: (m.interfaces[0] || {}).key }];
    sels.forEach((sel) => {
      App.select(sel); const h2 = $('#detail').querySelector('h2');
      if (!h2 || /\bmono\b/.test(h2.className) || h2.testAll('.mono').length) throw new Error(`${sel.type} 詳情的標題不應用等寬字`);
    });
    App.select(null);
  });
  await step('推論鏈路：沒有 LLDP 的 CSS610 以推論樣式畫出，提示與詳情說明依據', () => {
    const il = App.Q.inferredLinks(); if (process.env.SMOKE_INPUT && !il.length) return; // 大型乾淨網路沒有 CSS610
    if (!il.length) throw new Error('範例資料應有推論鏈路');
    const p = Array.from(App.pairs.values()).find((x) => x.evidence === 'inferred');
    if (!p) throw new Error('推論鏈路應以推論樣式畫在圖上');
    if (!Array.from(document.testAll('#legend .li')).some((li) => li.textContent === '推論鏈路')) throw new Error('圖例應有推論鏈路');
    App.graph.emit('hover', { item: { type: 'edge', id: p.id }, x: 0, y: 0 });
    if (!text('#tooltip').includes('推論鏈路')) throw new Error('提示應說明是推論鏈路');
    App.graph.emit('click', { type: 'edge', id: p.id });
    if (!text('#detail').includes('MAC 表') || !text('#detail').includes('信心高')) throw new Error('詳情應列出推論依據與信心');
    if (p.links.length) { // 事實在前、推論在後，鏈路表格有自己的標題，不接在推論鏈路下面
      const t = text('#detail'); const iL = t.indexOf('鏈路（LLDP／CDP／MNDP）'); const iI = t.indexOf('推論鏈路（沒有 LLDP）');
      if (iL < 0 || iI < 0 || iL > iI) throw new Error('設備對詳情應先列鏈路（有標題），再列推論鏈路');
    }
    const l = App.Q.getInferredLink(p.inferred[0]); const ep = [l.a, l.b].find((e) => App.Q.getInterface(e));
    App.select({ type: 'interface', key: ep });
    if (!App.graph.sel.edges.has(p.id)) throw new Error('選取介面時應一併標示它的推論鏈路');
    if (!text('#detail').includes('推論鏈路')) throw new Error('介面詳情應列出推論鏈路');
    // 設備圖沒有 L3（OSPF）連線：圖例中標「L3」的只有 L3 子網圖自己的節點與線
    const l3View = ['網段（L3）', '外部（L3，推論）', '路由（L3）', '對外（L3，推論）', '可能對外（L3，推論）', '網段重疊（L3）'];
    if (Array.from(document.testAll('#legend .li')).some((li) => li.textContent.includes('L3') && !l3View.some((x) => li.textContent.endsWith(x)))) throw new Error('圖上沒有 L3 連線，圖例不應列出');
    App.select(null);
  });
  await step('推定位置：CSS610 底下的主機畫回圖上，點選顯示推定位置', () => {
    const groups = App.Q.behindGroups(); if (process.env.SMOKE_INPUT && !groups.size) return; // 大型乾淨網路沒有 CSS610
    if (!groups.size) throw new Error('範例資料應有推定在 CSS610 底下的終端');
    const [dk, rows] = Array.from(groups.entries())[0];
    const n = App.graph.nodes.find((x) => x.id === '?b|' + rows[0].mac);
    if (!n || n.parent !== dk) throw new Error('推定終端應畫在所屬交換器底下');
    const e = Array.from(App.pairs.values()).find((p) => p.b === n.id);
    if (!e || e.evidence !== 'inferred') throw new Error('推定終端的連線應使用推論樣式');
    App.graph.emit('click', { type: 'node', id: n.id });
    if (App.sel.type !== 'mac' || !text('#detail').includes('推定位置') || !text('#detail').includes('埠不明')) throw new Error('點選推定終端應顯示 MAC 詳情與推定位置');
    const via = App.Q.behindVia(rows[0].mac)[0];
    if (!via || !text('#detail').includes('經由') || !text('#detail').includes('（推論鏈路）')) throw new Error('推定位置應列出經由的推論鏈路');
    const anchorName = App.Q.epName(rows[0].behind.anchor); const t = text('#detail');
    if (t.includes('上行')) throw new Error('MAC 學到的位置沒有方向依據，不應標成上行');
    if (!t.includes(anchorName + ' ⇄ ')) throw new Error('經由的推論鏈路應從錨點埠寫起，與圖上路徑方向一致');
    const pid = App.pairOfLink.get(via.key);
    if (!App.graph.hl || !App.graph.hl.edges.has(pid) || !App.graph.hl.edges.has(e.id)) throw new Error('選取推定終端應標示整段路徑：推論鏈路與終端連線');
    const p = App.pairs.get(pid); App.select({ type: 'pair', id: p.id, links: p.links, devs: [p.a, p.b] });
    if (!text('#detail').includes('推定在這條推論鏈路後面的終端')) throw new Error('推論鏈路詳情應列出後面推定的終端');
    App.select(null);
  });
  await step('基準摘要列與頁尾已移除：待處理數在步驟列「研判」，摘要在右側的基準狀態卡（收集缺漏、錯誤／警告入口仍可用）', () => {
    if ($('#baseline-summary') || $('#footer')) throw new Error('基準摘要列與頁尾已移除：數字只在步驟列、左欄與右側的基準狀態卡');
    const pc = S.view.app.problemCounts();
    if (!stepBtn('triage').textContent.includes('待處理 ' + S.view.num(pc.error + pc.warn))) throw new Error('「研判」的狀態應是待處理（錯誤＋警告）的筆數');
    App.select(null);
    const card = $('#detail').querySelector('.status-card'); if (!card) throw new Error('未選取時右欄應是基準狀態卡');
    if (/網路正常|即時/.test(card.textContent)) throw new Error('基準狀態不可宣稱即時網路健康');
    // 斷言入口與資料的關係，而非範例才有的特定問題：大型乾淨網路（SMOKE_INPUT）可能沒有缺漏或錯誤
    const expectedMissing = App.snap.coverage.filter((row) => row.collected && (row.missing.length || row.failures.length)).length;
    const gap = card.querySelector('.status-coverage').querySelector('a');
    if (!!gap !== !!expectedMissing) throw new Error('收集缺漏入口應在有缺漏時才可用');
    if (expectedMissing) {
      gap.click();
      if (!text('#pane-coverage').includes('有缺漏')) throw new Error('缺漏入口沒有切換至覆蓋率');
      if ($('#pane-coverage').testAll('tbody tr').length !== expectedMissing) throw new Error('缺漏入口應預先篩選有缺漏的設備');
      S.view.app.closeHub(); App.select(null);
    }
    const firstProblem = App.snap.findings.find((f) => f.severity !== 'info');
    const problems = $('#detail').querySelector('.status-problems');
    if (!!problems !== !!firstProblem) throw new Error('錯誤／警告入口應在有錯誤／警告時才有');
    if (firstProblem) {
      problems.click();
      if (App.step !== 'triage' || !text('#pane-findings').includes(firstProblem.title)) throw new Error('錯誤／警告入口應切到「研判」的檢查結果');
    }
  });
  await step('用字（UX #15–#17）：設備詳情的標籤不斷字、沒有英文原值；未收集設備的介面寫成鄰居看到的介面與位址；比對對象的名稱與訊息同大小寫', () => {
    const Q = App.Q; const RV = S.view.remediation;
    const core = Q.devices().find((d) => d.collected && d.routerId) || Q.devices().find((d) => d.collected);
    App.select({ type: 'device', key: core.key });
    const labels = $('#detail').testAll('.kv dt, .kv .k, dt').map((x) => x.textContent);
    const d = text('#detail');
    if (/鄰居回報的功能|取自 export|Router ID/.test(d)) throw new Error('設備詳情的用字：改「鄰居回報功能」「取自設定匯出」「路由器 ID」：' + labels.join('|'));
    if (core.routerId && !d.includes('路由器 ID')) throw new Error('應寫「路由器 ID」');
    // 未收集的設備：介面表改寫成「鄰居看到的介面與位址」，不寫「介面」「狀態 不明」
    const unc = Q.devices().find((x) => !x.collected && x.kind !== 'host' && Q.interfacesOf(x.key).length);
    if (unc) {
      App.select({ type: 'device', key: unc.key });
      const heads = $('#detail').testAll('summary').concat($('#detail').testAll('h3')); const titles = heads.map((x) => x.firstChild.textContent);
      if (titles.includes('介面') || !titles.includes('鄰居看到的介面與位址')) throw new Error('未收集設備的介面區塊應改名：' + titles.join('|'));
      const sec = heads.find((x) => x.firstChild.textContent === '鄰居看到的介面與位址').parentNode;
      if (sec.testAll('th').some((th) => th.textContent === '狀態')) throw new Error('未收集設備的介面狀態一律不明，不列狀態欄');
      Q.interfacesOf(unc.key).forEach((i) => Q.addressesOf(i.key).forEach((a) => { if (!sec.textContent.includes(a)) throw new Error('應列出鄰居看到的位址：' + a); }));
    } else if (!process.env.SMOKE_INPUT) throw new Error('範例資料應有未收集、有介面的網路設備：' + Q.devices().filter((x) => !x.collected).map((x) => x.key + ':' + x.kind + ':' + Q.interfacesOf(x.key).length).join(','));
    // 比對對象：名稱的大小寫跟著訊息（facet 是正規化後的小寫）
    Q.findings().filter((f) => f.id === 'A10' && f.facet != null).forEach((f) => {
      const t = RV.facetText(f); const name = (t.match(/「([^」]+)」/) || [])[1];
      if (name && f.message.toLowerCase().includes(`「${name.toLowerCase()}」`) && !f.message.includes(`「${name}」`)) throw new Error('比對對象的名稱應和訊息同大小寫：' + t + '／' + f.message);
    });
    App.select(null);
  });
  await step('窄螢幕工作區切換與詳情漸進展開', () => {
    window.innerWidth = 390;
    const workspaces = document.testAll('#mobile-workspaces button');
    workspaces.find((b) => b.dataset.workspace === 'checks').click();
    if ($('#main').dataset.workspace !== 'checks') throw new Error('工作區切換未顯示檢查面板');
    App.select({ type: 'device', key: App.snap.model.devices[0].key });
    if ($('#main').dataset.workspace !== 'graph' || $('#main').dataset.sheet !== 'half') throw new Error('窄螢幕從清單工作區選取應切回拓樸圖並開啟半高抽屜：' + $('#main').dataset.workspace + '／' + $('#main').dataset.sheet);
    const folds = $('#detail').testAll('details');
    if (!folds.length || !folds.some((d) => d.querySelector('summary').textContent.includes('鄰居'))) throw new Error('設備詳細資訊未提供可漸進展開的區塊');
    // 檢查兩種設備：未收集的與已收集的（已收集才有「收集到的原始輸出」等區塊）
    const noDupTitle = () => $('#detail').testAll('details').forEach((d) => {
      const title = d.querySelector('summary').firstChild.textContent;
      if (d.testAll('h3').some((x) => x.textContent.startsWith(title))) throw new Error(`展開區塊「${title}」內不應再重複同名標題`);
    });
    noDupTitle();
    App.select({ type: 'device', key: App.snap.model.devices.find((x) => x.collected && x.data.includes('route')).key });
    if (!$('#detail').testAll('summary').some((x) => x.textContent.startsWith('收集到的原始輸出'))) throw new Error('已收集設備應有原始輸出區塊');
    noDupTitle();
    App.select(null);
    window.innerWidth = 1200;
    workspaces.find((b) => b.dataset.workspace === 'graph').click();
  });
  await step('窄螢幕底部抽屜：點設備仍在拓樸圖、抽屜含詳情且可展開／收起／拖曳；Esc 收起；全圖讓開抽屜；「修正」與詳細資料工作區維持原行為；桌面不出現', () => {
    const main = $('#main'); const right = $('#right'); const g = App.graph;
    const ws = (w) => document.testAll('#mobile-workspaces button').find((b) => b.dataset.workspace === w);
    const esc = () => (docListeners.keydown || []).forEach((f) => f({ key: 'Escape', target: document.activeElement, preventDefault() {}, stopPropagation() {} }));
    const dev = App.Q.devices().find((d) => d.collected && g.pos.has(d.key));
    if (!right.querySelector('#sheet-bar') || !right.querySelector('#detail')) throw new Error('抽屜的操作列應在 #right 內，與 #detail 共用同一個詳情節點');
    if (right.getAttribute('role') !== 'region' || !right.getAttribute('aria-label')) throw new Error('抽屜應為有名稱的 region（非強制回應，圖仍可操作）');
    ['#sheet-handle', '#sheet-expand', '#sheet-close'].forEach((x) => { const b = $(x); if (b.tagName !== 'BUTTON' || !(b.getAttribute('aria-label') || b.textContent.trim())) throw new Error(x + ' 應是有名稱的按鈕'); });
    try {
      window.innerWidth = 390; App.showStep('triage'); ws('graph').click();
      const before = document.activeElement;
      g.emit('click', { type: 'node', id: dev.key });
      if (main.dataset.workspace !== 'graph') throw new Error('窄螢幕在拓樸圖點設備後應留在工作畫面：' + main.dataset.workspace);
      if (main.dataset.sheet !== 'half') throw new Error('點設備後應開啟半高抽屜');
      if (!text('#detail').includes(App.Q.devName(dev.key))) throw new Error('抽屜應顯示所選設備的詳情');
      if (document.activeElement !== before) throw new Error('從圖上點選開抽屜時不應搶走焦點');
      if (g.sel.nodes.size !== 1 || !g.sel.nodes.has(dev.key)) throw new Error('圖上應保留選取標示');
      const ex = $('#sheet-expand');
      ex.click(); if (main.dataset.sheet !== 'full' || ex.getAttribute('aria-expanded') !== 'true') throw new Error('展開鈕應切到全高');
      ex.click(); if (main.dataset.sheet !== 'half' || ex.getAttribute('aria-expanded') !== 'false') throw new Error('再按一次應回到半高');
      // 抽屜上緣在 480：全圖與聚焦扣掉它，被蓋住的選取節點只平移露出
      const rr = right.getBoundingClientRect; right.getBoundingClientRect = () => ({ left: 0, top: 480, width: 1200, height: 320 });
      try {
        if (g.viewport().y1 > 480) throw new Error('可用範圍應扣掉抽屜：' + g.viewport().y1);
        g.fit(); const ys = g.nodes.filter((n) => g.isVisible(n)).map((n) => g.toScreen(g.at(n.id)).y);
        if (Math.max(...ys) > 480) throw new Error('全圖不應把節點放到抽屜下方：' + Math.round(Math.max(...ys)));
        const s0 = g.s; const p = g.at(dev.key); g.ty = 700 - p.y * g.s; // 把設備移到抽屜下
        App.select({ type: 'device', key: dev.key });
        const y = g.toScreen(g.at(dev.key)).y;
        if (y > 480 || g.s !== s0) throw new Error('被抽屜蓋住的選取節點應只平移露出：y=' + Math.round(y) + '、縮放 ' + s0 + '→' + g.s);
        g.focus([dev.key]); if (g.toScreen(g.at(dev.key)).y > 480) throw new Error('聚焦應讓開抽屜');
        // 拖曳：上拉超過門檻成全高，點一下切回半高，下拉到底收起
        const hd = $('#sheet-handle');
        const drag = (y0, y1) => { hd.dispatch('pointerdown', { pointerId: 9, pointerType: 'touch', button: 0, clientX: 0, clientY: y0 }); const ev = { pointerId: 9, pointerType: 'touch', target: hd, clientX: 0, clientY: y1 }; (winListeners.pointermove || []).forEach((f) => f(ev)); (winListeners.pointerup || []).forEach((f) => f(ev)); };
        drag(490, 190); if (main.dataset.sheet !== 'full' || right.style.height) throw new Error('上拉抽屜應展開成全高並清掉拖曳中的高度：' + main.dataset.sheet);
        hd.click(); if (main.dataset.sheet !== 'full') throw new Error('剛拖曳完的 click 不應再切換高度');
        hd.click(); if (main.dataset.sheet !== 'half') throw new Error('點一下拖曳把手應在全高與半高間切換');
        drag(490, 760); if (main.dataset.sheet) throw new Error('下拉到底應收起抽屜');
        if (!App.sel) throw new Error('收起抽屜只是檢視狀態，不應清除選取');
      } finally { right.getBoundingClientRect = rr; }
      // Esc 收起，焦點不留在收起的抽屜內；輸入框裡的 Esc 不收
      App.select({ type: 'device', key: dev.key });
      $('#search').focus(); esc(); if (main.dataset.sheet !== 'half') throw new Error('搜尋框裡的 Esc 不應收起抽屜');
      $('#sheet-title').focus(); esc();
      if (main.dataset.sheet) throw new Error('Esc 應收起抽屜');
      if (right.contains(document.activeElement)) throw new Error('收起後焦點不應留在抽屜內');
      // 從清單工作區點檢查結果：切回工作畫面、開抽屜，焦點移到抽屜（原本的列已隱藏）
      const fi = App.snap.findings.findIndex((f) => f.entities.some((e) => e.type === 'device'));
      if (fi >= 0) {
        ws('checks').click(); App.selectFinding(fi);
        if (main.dataset.workspace !== 'graph' || main.dataset.sheet !== 'half') throw new Error('從清單工作區點檢查結果應切回工作畫面並開抽屜');
        if (document.activeElement !== $('#sheet-title')) throw new Error('從其他工作區開抽屜時焦點應移到抽屜');
      }
      $('#sheet-close').click(); if (main.dataset.sheet) throw new Error('收起鈕應關閉抽屜');
      if (right.contains(document.activeElement)) throw new Error('按收起後焦點不應留在抽屜內');
      App.select({ type: 'device', key: dev.key }); App.select(null);
      if (main.dataset.sheet) throw new Error('取消選取時抽屜應收起');
      // 「詳細資料」工作區內選取維持原行為
      ws('details').click(); App.select({ type: 'device', key: dev.key });
      if (main.dataset.workspace !== 'details' || main.dataset.sheet) throw new Error('在詳細資料工作區選取應留在詳細資料、不開抽屜');
      // 「修正」：中間不是拓樸圖，選取維持原行為（切到詳細資料）；換步時抽屜收起
      App.showStep('triage', { workspace: 'graph' }); App.select({ type: 'device', key: dev.key });
      App.showStep('fix'); if (main.dataset.sheet) throw new Error('換到沒有拓樸圖的一步時抽屜應收起');
      App.select({ type: 'device', key: dev.key });
      if (main.dataset.workspace !== 'details' || main.dataset.sheet) throw new Error('「修正」選取應切到詳細資料，不開抽屜');
      App.select(null);
      // 桌面：不出現抽屜
      window.innerWidth = 1200; App.showStep('triage'); ws('graph').click();
      g.emit('click', { type: 'node', id: dev.key });
      if (main.dataset.sheet || main.dataset.workspace !== 'graph') throw new Error('桌面版不應出現抽屜');
    } finally { window.innerWidth = 1200; App.select(null); App.showStep('triage'); ws('graph').click(); }
  });
};
