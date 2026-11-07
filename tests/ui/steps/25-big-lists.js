// 畫面冒煙測試的 step：大量列的清單（V.bigList）——路由表視窗與防火牆的位址清單：摘要計數與 Q 相同、展開一組才畫明細、分頁、搜尋（位址與網段經 Q.routesMatching／Q.addressSetFind，其他文字依文字比對）、少量時直接列出。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { document, S, step, $, buildInput, detailRoot, fwRoot, fwList, fwSide, fwText, fwTab, fwRows, routesList, fs, path, ROOT, jsFiles } = require('../helpers.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
const ROUTES = 1500; const LIST = 600; const GWS = ['10.255.0.2', '10.255.0.3', '10.255.0.4'];
const dst = (i) => `10.${i >> 8}.${i & 255}.0/24`;
/** 一台路由很多、位址清單很長的設備（BIG），與只有幾條路由的設備（SMALL） */
const INPUT = [
  'BIG (10.255.0.1):', '### /export terse',
  '/ip address add address=10.255.0.1/24 interface=ether1 network=10.255.0.0',
  // 項目彼此不相鄰（每隔一個位址），合併後仍是一段一個位址
  ...Array.from({ length: LIST }, (_, i) => `/ip firewall address-list add address=172.16.${i >> 7}.${(i & 127) * 2} list=BLOCK`),
  '/ip firewall address-list add address=10.255.0.0/24 list=MGMT',
  '/ip firewall filter add action=drop chain=input src-address-list=BLOCK',
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=10.255.0.0/24 routing-table=main gateway=ether1 immediate-gw=ether1 distance=0',
  // 包含 10.5.200.0/24 的較短網段：搜尋位址時依前綴由長到短列出（不加預設路由，讓 192.0.2.x 找不到）
  ' As  dst-address=10.5.0.0/16 routing-table=main gateway=10.255.0.2 immediate-gw=10.255.0.2%ether1 distance=1',
  ' As  dst-address=10.0.0.0/8 routing-table=main gateway=10.255.0.2 immediate-gw=10.255.0.2%ether1 distance=1',
  // 前 10 條不是作用中（只有 s 旗標）
  ...Array.from({ length: ROUTES }, (_, i) => ` ${i < 10 ? ' s' : 'As'}  dst-address=${dst(i)} routing-table=main gateway=${GWS[i % 3]} immediate-gw=${GWS[i % 3]}%ether1 distance=1`),
  'SMALL (10.255.0.9):', '### /export terse', '/ip address add address=10.255.0.9/24 interface=ether1 network=10.255.0.0',
  '/ip firewall address-list add address=192.0.2.10 list=ALLOW', '/ip firewall address-list add address=198.51.100.0/24 list=ALLOW',
  '/ip firewall filter add action=accept chain=input src-address-list=ALLOW',
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=10.255.0.0/24 routing-table=main gateway=ether1 immediate-gw=ether1 distance=0',
  ' As  dst-address=0.0.0.0/0 routing-table=main gateway=10.255.0.1 immediate-gw=10.255.0.1%ether1 distance=1',
].join('\n');

const kids = (el) => Array.from(el.children);
/** 詳情最上層、標題為 title 的展開列 */
const foldOf = (title) => {
  const el = kids($('#detail').firstElementChild).find((x) => x.tagName === 'DETAILS' && x.querySelector('summary').firstChild.textContent === title);
  if (!el) throw new Error('詳情應有「' + title + '」');
  return el;
};
/** 展開列標題列的 count（純數字的 chip） */
const countOf = (fold) => { const c = kids(fold.querySelector('summary')).find((x) => /\bcount\b/.test(x.className)); if (!c) throw new Error('展開列應有 count'); return Number(c.textContent.replace(/,/g, '')); };
/** 防火牆視窗分頁的 count（分頁按鈕上的純數字） */
const tabCount = (key) => { const c = fwRoot().querySelector('#tdlg-tab-' + key).querySelector('.count'); if (!c) throw new Error('分頁應有 count'); return Number(c.textContent.replace(/,/g, '')); };
const groupsOf = (el) => el.testAll('.biglist-group').filter((g) => g.getAttribute('data-group') != null);
const open = (fold) => { fold.open = true; fold.dispatch('toggle'); };
const rowsOf = (el) => el.testAll('tbody tr');
const search = (big, q) => { const inp = big.querySelector('.biglist-search'); if (!inp) throw new Error('應有搜尋框'); inp.value = q; inp.dispatch('input'); };
const visible = (el) => el.getAttribute('hidden') == null;

module.exports = async () => {
  await step('大量路由：右欄只有摘要，路由表視窗先顯示分組（計數同 Q.allRoutesOf）、展開一組才畫明細並分頁、搜尋位址依前綴由長到短找到包含它的路由、其他文字依文字比對；少量時也分組', async () => {
    await buildInput(INPUT);
    const Q = App.Q; const P = S.view.BIG_LIST;
    const big = Q.devices().find((d) => d.name === 'BIG'); const small = Q.devices().find((d) => d.name === 'SMALL');
    if (!big || !small) throw new Error('測試前提：應有 BIG 與 SMALL 兩台設備');
    const all = Q.allRoutesOf(big.key);
    if (all.length < P.min * 2) throw new Error('測試前提：BIG 的路由應遠多於門檻：' + all.length);
    App.select({ type: 'device', key: big.key });
    const summ = foldOf('路由表');
    if (countOf(summ) !== all.length) throw new Error(`右欄路由表摘要的 count 應同 Q.allRoutesOf：${countOf(summ)}／${all.length}`);
    if (rowsOf(summ).length || summ.querySelector('.biglist')) throw new Error('右欄只有路由表的摘要，不列路由');
    summ.querySelector('.routes-open').click();
    const sec = routesList();
    const box = sec.querySelector('.biglist'); if (!box) throw new Error('路由表視窗應是摘要＋分組');
    const total = box.querySelector('.biglist-total');
    if (Number(total.getAttribute('data-count')) !== all.length || !total.textContent.includes(S.view.num(all.length))) throw new Error('摘要的總數應同 Q.allRoutesOf：' + total.textContent);
    // 摘要時一列明細都不畫
    if (rowsOf(sec).length) throw new Error('還沒展開任何一組時不應畫出明細：' + rowsOf(sec).length);
    const gs = groupsOf(box);
    if (!gs.length || gs.length > P.page) throw new Error('測試前提：分組應在一頁內：' + gs.length);
    const sum = gs.reduce((n, g) => n + countOf(g), 0);
    if (sum !== all.length) throw new Error(`各組的 count 合起來應是全部的路由：${sum}／${all.length}`);
    // 每組的 count 同 Q：同一個下一跳的路由數
    GWS.forEach((gw) => {
      const g = gs.find((x) => x.querySelector('summary').textContent.includes(gw));
      const want = all.filter((r) => r.nh.some((n) => n.ip === gw)).length;
      if (!g || countOf(g) !== want) throw new Error(`下一跳 ${gw} 的組應有 ${want} 條：${g ? countOf(g) : '沒有這一組'}`);
    });
    // 非作用中的路由數寫在組的標題列
    const inactive = all.filter((r) => r.active === false).length;
    if (!inactive || !gs.some((g) => g.querySelector('summary').textContent.includes('條非作用中'))) throw new Error('有非作用中路由的組應在標題列寫出條數');
    // 展開一組：只畫一頁，換頁後是下一段、焦點留在按鈕上
    const g0 = gs.find((g) => countOf(g) > P.page); open(g0);
    const page1 = rowsOf(g0);
    if (page1.length !== P.page) throw new Error(`一頁應是 ${P.page} 列：${page1.length}`);
    if (rowsOf(sec).length >= all.length) throw new Error('分頁時不應一次畫出全部的列');
    const where = g0.querySelector('.pager-where'); if (!where || where.getAttribute('role') !== 'status') throw new Error('分頁應有頁碼說明（role=status）');
    const first = page1[0].textContent;
    const next = g0.testAll('.pager-btn').find((b) => b.getAttribute('data-page') === 'next');
    if (!next) throw new Error('應有「下一頁」按鈕');
    next.click();
    const page2 = rowsOf(g0);
    if (!page2.length || page2.length > P.page || page2[0].textContent === first) throw new Error('換頁後應是下一段的列');
    if (!document.activeElement || document.activeElement.getAttribute('data-page') !== 'next') throw new Error('換頁後焦點應留在「下一頁」');
    if (!g0.querySelector('.pager-where').textContent.includes(`${S.view.num(P.page + 1)}–`)) throw new Error('頁碼說明應寫出第二頁的範圍：' + g0.querySelector('.pager-where').textContent);
    // 搜尋位址（Q.routesMatching）：找到包含它的每一條路由，最長前綴在最前面、依前綴由長到短；搜尋時摘要收起
    const target = all.find((r) => `${r.prefix}/${r.len}` === dst(ROUTES - 20));
    if (!target) throw new Error('測試前提：Q 應有 ' + dst(ROUTES - 20));
    const ip = target.prefix.replace(/\.0$/, '.7');
    const want = Q.routesMatching(big.key, ip);
    if (!want || want.length < 2 || want[0] !== target) throw new Error('測試前提：包含 ' + ip + ' 的路由應不只一條、最長的是 ' + dst(ROUTES - 20));
    const lenOf = (tr) => { const m = /\d+\.\d+\.\d+\.\d+\/(\d+)/.exec(tr.textContent); if (!m) throw new Error('列應有網段：' + tr.textContent); return Number(m[1]); };
    search(box, ip);
    const hit = rowsOf(box.querySelector('.biglist-result'));
    if (hit.length !== want.length || !hit[0].textContent.includes(dst(ROUTES - 20)) || !hit[0].textContent.includes(target.nh[0].ip)) throw new Error('搜尋位址應找到包含它的路由、最長前綴在最前面：' + hit.map((r) => r.textContent).join(' | '));
    if (hit.some((tr, k) => k && lenOf(tr) > lenOf(hit[k - 1]))) throw new Error('搜尋位址的結果應依前綴由長到短：' + hit.map(lenOf).join(','));
    if (!want.every((r, k) => hit[k].textContent.includes(`${r.prefix}/${r.len}`))) throw new Error('搜尋位址的列應與 Q.routesMatching 相同而且同順序');
    if (visible(box.querySelector('.biglist-summary')) || !box.querySelector('.biglist-status').textContent.includes(`找到 ${S.view.num(want.length)} 條`)) throw new Error('搜尋時應收起摘要、寫出找到的條數');
    // 不是位址或網段（Q.routesMatching 為 null）：改用文字比對，可搜協定與網段的一部分
    const proto = all.find((r) => r.nh.some((n) => n.ip === GWS[1])).proto; const partial = target.prefix.replace(/\.0$/, '');
    if (Q.routesMatching(big.key, proto) !== null || Q.routesMatching(big.key, partial) !== null) throw new Error('測試前提：協定名稱與不完整的位址不是位址格式');
    search(box, proto);
    const byProto = all.filter((r) => r.proto === proto).length;
    if (!box.querySelector('.biglist-status').textContent.includes(`找到 ${S.view.num(byProto)} 條`) || rowsOf(box.querySelector('.biglist-result')).length !== Math.min(P.page, byProto)) throw new Error('搜尋協定應依文字找到那些路由（分頁）');
    search(box, partial);
    const byText = rowsOf(box.querySelector('.biglist-result'));
    if (!byText.length || !byText.every((tr) => tr.textContent.includes(partial)) || !byText.some((tr) => tr.textContent.includes(dst(ROUTES - 20)))) throw new Error('不完整的位址應依文字找到含它的路由：' + byText.map((r) => r.textContent).join(' | '));
    // 位址格式正確但沒有路由包含它：寫「找不到符合的路由」
    if (!Q.routesMatching(big.key, '192.0.2.99') || Q.routesMatching(big.key, '192.0.2.99').length) throw new Error('測試前提：沒有路由包含 192.0.2.99');
    search(box, '192.0.2.99');
    if (!box.querySelector('.biglist-status').textContent.includes('找不到符合的路由') || rowsOf(box.querySelector('.biglist-result')).length) throw new Error('沒有符合時應說明找不到符合的路由：' + box.querySelector('.biglist-status').textContent);
    search(box, '');
    if (!visible(box.querySelector('.biglist-summary')) || visible(box.querySelector('.biglist-result'))) throw new Error('清掉搜尋字應回到摘要');
    // 少量時也分組（同一種資料同一種呈現），各組合起來是全部的路由
    App.select({ type: 'routes', dev: small.key });
    const n = Q.allRoutesOf(small.key).length; const sgs = groupsOf(routesList());
    if (n >= P.min || !sgs.length || sgs.reduce((k, g) => k + countOf(g), 0) !== n) throw new Error(`路由少時也依路由表、協定與下一跳分組：${n}`);
    App.select(null);
  });

  await step('大量位址清單：防火牆的位址清單取自 Q.addressSet，摘要計數相同、展開一組才畫明細並分頁、搜尋位址找到包含它的區段、其他文字依文字比對；少量時直接列出', () => {
    const Q = App.Q; const P = S.view.BIG_LIST;
    const big = Q.devices().find((d) => d.name === 'BIG');
    const lists = Q.addressSetsOf(big.key, 'address-list').map(Q.addressSet);
    const block = lists.find((s) => s.id.endsWith('|BLOCK'));
    if (!block || block.size !== 600) throw new Error('測試前提：BLOCK 應有 600 段：' + (block && block.size));
    const total = lists.reduce((n, s) => n + Math.max(1, s.size || 0), 0);
    App.select({ type: 'firewall', dev: big.key });
    const sec = fwTab('addr');
    if (tabCount('addr') !== total) throw new Error(`位址清單的 count 應同 Q.addressSet 的段數：${tabCount('addr')}／${total}`);
    const box = sec.querySelector('.biglist'); if (!box) throw new Error('位址多時應改為摘要＋分組');
    if (Number(box.querySelector('.biglist-total').getAttribute('data-count')) !== total) throw new Error('摘要的總數應同 Q.addressSet');
    const gs = groupsOf(box);
    if (gs.length !== lists.length) throw new Error('每份清單一組');
    const g = gs.find((x) => x.getAttribute('data-group') === block.id);
    if (!g || countOf(g) !== block.size) throw new Error('BLOCK 的組應有 ' + block.size + ' 段');
    if (rowsOf(sec).length) throw new Error('還沒展開時不應畫出明細');
    open(g);
    // 組內不列和組名重複的「清單」欄（inGroup: false）；搜尋結果與直接列出時仍有
    if (g.testAll('th').some((th) => th.textContent === '清單')) throw new Error('位址清單的組內不應再列「清單」欄');
    if (rowsOf(g).length !== P.page) throw new Error(`一頁應是 ${P.page} 列：${rowsOf(g).length}`);
    const want = block.ranges[300][0];
    search(box, want);
    const hit = rowsOf(box.querySelector('.biglist-result'));
    if (!hit.some((r) => r.textContent.includes('BLOCK') && r.textContent.includes(want))) throw new Error('搜尋位址應找到那一段：' + want);
    // 搜尋位址（Q.addressSetFind）：找到包含它的區段（MGMT 的 10.255.0.0/24 是一段），不是文字比對
    const mgmt = lists.find((s) => s.id.endsWith('|MGMT'));
    const inside = '10.255.0.77'; const found = Q.addressSetFind(mgmt.id, inside);
    if (!found || found.length !== 1 || mgmt.ranges[found[0]].join('–') !== '10.255.0.0–10.255.0.255') throw new Error('測試前提：MGMT 有一段包含 ' + inside);
    search(box, inside);
    const inHit = rowsOf(box.querySelector('.biglist-result'));
    if (inHit.length !== 1 || !inHit[0].textContent.includes('MGMT') || !inHit[0].textContent.includes('10.255.0.0–10.255.0.255')) throw new Error('搜尋位址應找到包含它的區段：' + inHit.map((r) => r.textContent).join(' | '));
    // 網段：找到和它重疊的每一段（計數同 Q.addressSetFind）
    const net = '172.16.2.0/24'; const byNet = lists.filter((s) => s.ranges).reduce((n, s) => n + Q.addressSetFind(s.id, net).length, 0);
    if (!byNet) throw new Error('測試前提：BLOCK 應有和 ' + net + ' 重疊的區段');
    search(box, net);
    if (!box.querySelector('.biglist-status').textContent.includes(`找到 ${S.view.num(byNet)} 段`)) throw new Error('搜尋網段應找到重疊的區段：' + box.querySelector('.biglist-status').textContent);
    // 不是位址（Q.addressSetFind 為 null）：改用文字比對，找得到清單名稱
    if (Q.addressSetFind(mgmt.id, 'MGMT') !== null) throw new Error('測試前提：清單名稱不是位址格式');
    search(box, 'MGMT');
    const byName = rowsOf(box.querySelector('.biglist-result'));
    if (byName.length !== mgmt.size || !byName.every((r) => r.textContent.includes('MGMT'))) throw new Error('搜尋清單名稱應依文字找到那份清單的區段：' + byName.map((r) => r.textContent).join(' | '));
    // 位址格式正確但沒有區段重疊：寫「找不到符合的位址」
    search(box, '192.0.2.1');
    if (!box.querySelector('.biglist-status').textContent.includes('找不到符合的位址') || rowsOf(box.querySelector('.biglist-result')).length) throw new Error('沒有重疊的區段時應說明找不到：' + box.querySelector('.biglist-status').textContent);
    // 少量時直接列出：每段一列
    const small = Q.devices().find((d) => d.name === 'SMALL');
    const few = Q.addressSetsOf(small.key, 'address-list').map(Q.addressSet);
    const n = few.reduce((k, s) => k + Math.max(1, s.size || 0), 0);
    App.select({ type: 'firewall', dev: small.key });
    const sm = fwTab('addr');
    if (!n || n >= P.min || sm.querySelector('.biglist') || rowsOf(sm).length !== n || tabCount('addr') !== n) throw new Error(`位址少時應直接列出全部：${rowsOf(sm).length}／${n}`);
    if (!sm.textContent.includes('198.51.100.0–198.51.100.255')) throw new Error('合併後的一段寫成「起–迄」：' + sm.textContent);
    App.select(null);
  });

  await step('不分組的 V.bigList：列多時分頁（不截斷、寫出總數），排序對全部的列；沒有 text 時沒有搜尋框；reveal 翻到那一列的頁；V.paged 給非表格的清單', () => {
    const V = S.view; const P = V.BIG_LIST;
    const n = P.min + P.page * 2 + 7; const rows = Array.from({ length: n }, (_, i) => ({ i, name: 'r' + i }));
    const cols = [{ t: '編號', f: (r) => String(r.i), s: (r) => r.i }, { t: '名稱', f: (r) => r.name }];
    const pagerBtn = (el, key) => { const b = el.testAll('.pager-btn').find((x) => x.getAttribute('data-page') === key); if (!b) throw new Error('應有分頁按鈕：' + key); return b; };
    const firstCell = (el) => rowsOf(el)[0].testAll('td')[0].textContent;
    const pages = Math.ceil(n / P.page);
    // 不分組、沒有 text：只有分頁，沒有搜尋框與分組
    const box = V.bigList(cols, rows, { unit: '列' });
    if (box.querySelector('.biglist-search') || groupsOf(box).length) throw new Error('沒有 text 時不放搜尋框，不分組');
    if (rowsOf(box).length !== P.page || !box.querySelector('.pager-where').textContent.includes(`共 ${V.num(n)} 列（1／${V.num(pages)} 頁）`)) throw new Error('列多時分頁並寫出總數：' + box.querySelector('.pager-where').textContent);
    pagerBtn(box, 'last').click();
    if (rowsOf(box).length !== n - P.page * (pages - 1) || firstCell(box) !== String(P.page * (pages - 1))) throw new Error('最後一頁列出其餘的列（不截斷）');
    // 排序對全部的列：降冪後第一列是最大的編號，回到第一頁
    const sortBtn = () => box.testAll('.th-sort')[0];
    sortBtn().click(); sortBtn().click();
    if (firstCell(box) !== String(n - 1) || !box.querySelector('.pager-where').textContent.includes(`（1／${V.num(pages)} 頁）`)) throw new Error('排序對全部的列，排序後回到第一頁：' + firstCell(box));
    // 有 text：搜尋框依文字找
    const withText = V.bigList(cols, rows, { text: (r) => r.name, unit: '列', what: '列' });
    search(withText, 'r1');
    const hit = rows.filter((r) => r.name.includes('r1')).length;
    if (!withText.querySelector('.biglist-status').textContent.includes(`找到 ${V.num(hit)} 列`)) throw new Error('搜尋應寫出找到的列數');
    // reveal：一開始翻到那一列所在的頁
    const target = rows[n - 3];
    const rv = V.bigList(cols, rows, { reveal: target });
    if (!rowsOf(rv).some((tr) => tr.testAll('td')[0].textContent === String(target.i))) throw new Error('reveal 應翻到那一列所在的頁');
    // 呼叫端管排序（table.onSort）：照呼叫端給的順序分頁，不自己排
    const rev = rows.slice().reverse();
    const ext = V.bigList(cols, rev, { table: { onSort: () => {}, sortBy: 0, sortDir: -1 } });
    if (firstCell(ext) !== String(n - 1) || rowsOf(ext).length !== P.page) throw new Error('呼叫端管排序時照給的順序分頁');
    // V.table 一律列出全部的列（舊的 limit 選項已拿掉）；畫面沒有呼叫端再傳 limit，列多的表格都經 V.bigList 分頁
    const all = V.table(cols, rows);
    if (all.querySelector('.table-more') || all.querySelector('.pager') || rowsOf(all).length !== n) throw new Error('V.table 應列出全部的列，不截斷');
    const viewSrc = jsFiles('src/view');
    if (!viewSrc.length) throw new Error('找不到 src/view 的檔案');
    const withLimit = viewSrc.filter((f) => /\blimit:\s*\d/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    if (withLimit.length) throw new Error('畫面不再傳 V.table 的 limit（改用 V.bigList）：' + withLimit.join('、'));
    // V.paged：非表格的清單也分頁
    const ul = V.paged(n, '段', (from, to) => V.h('ul', null, rows.slice(from, to).map((r) => V.h('li', null, r.name))));
    if (ul.testAll('li').length !== P.page || !ul.querySelector('.pager-where').textContent.includes(`共 ${V.num(n)} 段`)) throw new Error('V.paged 應分頁並寫出總數');
  });
};
