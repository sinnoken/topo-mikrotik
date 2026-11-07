// 畫面冒煙測試的 step：大量列的清單（V.bigList）——設備詳情的路由表與防火牆的位址清單：摘要計數與 Q 相同、展開一組才畫明細、分頁、文字搜尋、少量時直接列出。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { document, S, step, $, buildInput } = require('../helpers.js');

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
const groupsOf = (el) => el.testAll('.biglist-group').filter((g) => g.getAttribute('data-group') != null);
const open = (fold) => { fold.open = true; fold.dispatch('toggle'); };
const rowsOf = (el) => el.testAll('tbody tr');
const search = (big, q) => { const inp = big.querySelector('.biglist-search'); if (!inp) throw new Error('應有搜尋框'); inp.value = q; inp.dispatch('input'); };
const visible = (el) => el.getAttribute('hidden') == null;

module.exports = async () => {
  await step('大量路由：路由表先顯示摘要（計數同 Q.allRoutesOf）、展開一組才畫明細並分頁、文字搜尋找得到指定的路由；少量時直接列出', async () => {
    await buildInput(INPUT);
    const Q = App.Q; const P = S.view.BIG_LIST;
    const big = Q.devices().find((d) => d.name === 'BIG'); const small = Q.devices().find((d) => d.name === 'SMALL');
    if (!big || !small) throw new Error('測試前提：應有 BIG 與 SMALL 兩台設備');
    const all = Q.allRoutesOf(big.key);
    if (all.length < P.min * 2) throw new Error('測試前提：BIG 的路由應遠多於門檻：' + all.length);
    App.select({ type: 'device', key: big.key });
    const sec = foldOf('路由表');
    if (countOf(sec) !== all.length) throw new Error(`路由表的 count 應同 Q.allRoutesOf：${countOf(sec)}／${all.length}`);
    const box = sec.querySelector('.biglist'); if (!box) throw new Error('路由多時應改為摘要＋分組');
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
    // 搜尋：找得到指定的路由，搜尋時摘要收起；清掉搜尋字回到摘要
    const target = all.find((r) => `${r.prefix}/${r.len}` === dst(ROUTES - 20));
    if (!target) throw new Error('測試前提：Q 應有 ' + dst(ROUTES - 20));
    search(box, dst(ROUTES - 20));
    const hit = rowsOf(box.querySelector('.biglist-result'));
    if (hit.length !== 1 || !hit[0].textContent.includes(dst(ROUTES - 20)) || !hit[0].textContent.includes(target.nh[0].ip)) throw new Error('搜尋網段應找到那一條路由：' + hit.map((r) => r.textContent).join(' | '));
    if (visible(box.querySelector('.biglist-summary')) || !box.querySelector('.biglist-status').textContent.includes('找到 1 條')) throw new Error('搜尋時應收起摘要、寫出找到的條數');
    search(box, GWS[1]);
    const byGw = all.filter((r) => r.nh.some((n) => n.ip === GWS[1])).length;
    if (!box.querySelector('.biglist-status').textContent.includes(`找到 ${S.view.num(byGw)} 條`) || rowsOf(box.querySelector('.biglist-result')).length !== Math.min(P.page, byGw)) throw new Error('搜尋下一跳應找到那些路由（分頁）');
    search(box, '192.0.2.99');
    if (!box.querySelector('.biglist-status').textContent.includes('找不到') || rowsOf(box.querySelector('.biglist-result')).length) throw new Error('沒有符合時應說明找不到');
    search(box, '');
    if (!visible(box.querySelector('.biglist-summary')) || visible(box.querySelector('.biglist-result'))) throw new Error('清掉搜尋字應回到摘要');
    // 少量時直接列出（與原本相同）
    App.select({ type: 'device', key: small.key });
    const sm = foldOf('路由表'); const n = Q.allRoutesOf(small.key).length;
    if (n >= P.min || sm.querySelector('.biglist') || rowsOf(sm).length !== n) throw new Error(`路由少時應直接列出全部：${rowsOf(sm).length}／${n}`);
    App.select(null);
  });

  await step('大量位址清單：防火牆的位址清單取自 Q.addressSet，摘要計數相同、展開一組才畫明細並分頁、文字搜尋找得到位址；少量時直接列出', () => {
    const Q = App.Q; const P = S.view.BIG_LIST;
    const big = Q.devices().find((d) => d.name === 'BIG');
    const lists = Q.addressListsOf(big.key).map((l) => Q.addressSet(Q.addrSets().list(l.dev, l.family, l.name).id));
    const block = lists.find((s) => s.id.endsWith('|BLOCK'));
    if (!block || block.size !== 600) throw new Error('測試前提：BLOCK 應有 600 段：' + (block && block.size));
    const total = lists.reduce((n, s) => n + Math.max(1, s.size || 0), 0);
    App.select({ type: 'firewall', dev: big.key });
    const sec = foldOf('位址清單');
    if (countOf(sec) !== total) throw new Error(`位址清單的 count 應同 Q.addressSet 的段數：${countOf(sec)}／${total}`);
    const box = sec.querySelector('.biglist'); if (!box) throw new Error('位址多時應改為摘要＋分組');
    if (Number(box.querySelector('.biglist-total').getAttribute('data-count')) !== total) throw new Error('摘要的總數應同 Q.addressSet');
    const gs = groupsOf(box);
    if (gs.length !== lists.length) throw new Error('每份清單一組');
    const g = gs.find((x) => x.getAttribute('data-group') === block.id);
    if (!g || countOf(g) !== block.size) throw new Error('BLOCK 的組應有 ' + block.size + ' 段');
    if (rowsOf(sec).length) throw new Error('還沒展開時不應畫出明細');
    open(g);
    if (rowsOf(g).length !== P.page) throw new Error(`一頁應是 ${P.page} 列：${rowsOf(g).length}`);
    const want = block.ranges[300][0];
    search(box, want);
    const hit = rowsOf(box.querySelector('.biglist-result'));
    if (!hit.some((r) => r.textContent.includes('BLOCK') && r.textContent.includes(want))) throw new Error('搜尋位址應找到那一段：' + want);
    // 少量時直接列出：每段一列
    const small = Q.devices().find((d) => d.name === 'SMALL');
    const few = Q.addressListsOf(small.key).map((l) => Q.addressSet(Q.addrSets().list(l.dev, l.family, l.name).id));
    const n = few.reduce((k, s) => k + Math.max(1, s.size || 0), 0);
    App.select({ type: 'firewall', dev: small.key });
    const sm = foldOf('位址清單');
    if (!n || n >= P.min || sm.querySelector('.biglist') || rowsOf(sm).length !== n || countOf(sm) !== n) throw new Error(`位址少時應直接列出全部：${rowsOf(sm).length}／${n}`);
    if (!sm.textContent.includes('198.51.100.0–198.51.100.255')) throw new Error('合併後的一段寫成「起–迄」：' + sm.textContent);
    App.select(null);
  });
};
