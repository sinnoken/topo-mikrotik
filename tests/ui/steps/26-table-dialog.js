// 畫面冒煙測試的 step：表格視窗（V.tableDialog）與防火牆視窗——開啟與關閉（✕、Esc、遮罩）、焦點歸還、點列看詳情、單選與鍵盤、
// 從檢查結果定位、窄螢幕的單欄與「返回」、狀態列、選取列的樣式只在 CSS、A.modalOpen。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { S, fs, path, ROOT, step, $, text, document, cssVarsOf, SCHEMES, pressKey, buildInput, detailRoot, fwRoot, fwList, fwSide, fwTab, fwRows, workEntry } = require('../helpers.js');

/** 範例基準中規則最多、而且有命中次數的設備 */
const fwDevice = (Q) => {
  const devs = S.util.uniq(Q.firewallRules().map((r) => r.dev));
  return devs.sort((a, b) => Q.firewallRulesOf(b).length - Q.firewallRulesOf(a).length)[0];
};
/** 打開設備詳情，從摘要的入口開防火牆視窗；回傳入口 */
const openFrom = (dev) => {
  App.select({ type: 'device', key: dev });
  const link = detailRoot().querySelector('.fw-open'); if (!link) throw new Error('設備詳情的工作入口應有防火牆');
  link.focus(); link.click();
  if (!$('#dlg-table').open) throw new Error('入口應開啟防火牆視窗');
  return link;
};

/** 收合的組（<details>）是否展開：畫面程式設 open 屬性或 property（模擬 DOM 兩者不連動） */
const isOpen = (d) => d.open === true || (d.open === undefined && d.getAttribute('open') != null);
/** root 裡 data-key 為 key、看得到的列（上層沒有 hidden，所在的組都展開）；沒有時 null */
const shownRow = (root, key) => root.testAll('tr').find((tr) => {
  if (tr.getAttribute('data-key') !== key) return false;
  for (let x = tr.parentNode; x && x !== root; x = x.parentNode) {
    if (x.getAttribute('hidden') != null) return false;
    if (x.tagName === 'DETAILS' && !isOpen(x)) return false;
  }
  return true;
}) || null;

module.exports = async () => {
  await step('表格視窗：設備詳情只剩摘要，規則表在視窗內；點規則在右欄看命中次數與原文，單選（aria-selected）、↑↓ 移動、只有一個 Tab 停留點', async () => {
    await buildInput(S.samples['sample-bundle.txt']);
    const Q = App.Q; const dev = fwDevice(Q);
    openFrom(dev);
    // 右欄只剩摘要；規則表的列都在視窗的左欄
    if (detailRoot().querySelector('table.t[role="grid"]') || detailRoot().querySelector('.fw-hits') || detailRoot().testAll('tr').some((tr) => tr.getAttribute('data-key') && Q.getFirewallRule(tr.getAttribute('data-key')))) throw new Error('右欄不應有規則表');
    const panel = fwTab('rules');
    const grp = panel.testAll('.biglist-group').find((g) => g.getAttribute('data-group') != null);
    grp.open = true; grp.dispatch('toggle');
    const trs = grp.testAll('tbody tr');
    if (!trs.length || !trs.every((tr) => Q.getFirewallRule(tr.getAttribute('data-key')))) throw new Error('規則表的每一列應帶規則鍵（data-key）');
    if (grp.querySelector('table').getAttribute('role') !== 'grid' || trs.some((tr) => tr.getAttribute('aria-selected') !== 'false')) throw new Error('可選取的表格是 role=grid，沒選時每列 aria-selected=false');
    if (trs.filter((tr) => tr.getAttribute('tabindex') === '0').length !== 1) throw new Error('沒選時只有第一列是 Tab 停留點');
    // ↓ 移到下一列（焦點），Enter 選取
    if (trs.length > 1) {
      trs[0].focus(); pressKey('ArrowDown', trs[0]);
      if (document.activeElement !== trs[1]) throw new Error('↓ 應把焦點移到下一列');
    }
    const pick = trs[trs.length > 1 ? 1 : 0]; const key = pick.getAttribute('data-key'); const r = Q.getFirewallRule(key);
    pick.focus(); pressKey('Enter', pick);
    if (App.sel.type !== 'rule' || App.sel.key !== key) throw new Error('Enter 應選取那條規則（App.sel）');
    if (pick.getAttribute('aria-selected') !== 'true' || !pick.classList.contains('focus') || trs.filter((tr) => tr.getAttribute('aria-selected') === 'true').length !== 1) throw new Error('只有選取的列 aria-selected=true、class focus');
    if (pick.getAttribute('tabindex') !== '0' || trs.filter((tr) => tr.getAttribute('tabindex') === '0').length !== 1) throw new Error('選取的列是唯一的 Tab 停留點');
    if (document.activeElement !== pick) throw new Error('寬螢幕選取後焦點留在那一列');
    if (!grp.parentNode || grp.getAttribute('data-group') == null || !panel.contains(pick)) throw new Error('選取時左欄不重畫');
    // 右欄：命中次數與原文
    const side = fwSide();
    if (!side.querySelector('h2').textContent.endsWith('#' + r.position)) throw new Error('右欄的標題應是那條規則');
    if (!side.textContent.includes('命中次數') || !side.querySelector('.fw-stats-note')) throw new Error('右欄應有那條規則的命中次數');
    if (r.stats && !side.textContent.includes(S.view.bigNum(r.stats.packets))) throw new Error('右欄的命中次數應是那條規則的');
    const raw = side.testAll('a').find((a) => a.textContent.endsWith(`第 ${r.src[0][1]} 行`));
    if (!raw) throw new Error('右欄應有那條規則的原文連結');
    raw.click(); if (!$('#dlg-raw').open) throw new Error('點原文應開啟原文對話框（疊在視窗上）');
    // 原文開著時 Esc 只關原文（最上層），表格視窗還在
    pressKey('Escape', $('#raw-close'));
    if ($('#dlg-raw').open || !$('#dlg-table').open) throw new Error('Esc 應只關最上層的原文對話框');
    if (!S.view.app.modalOpen()) throw new Error('表格視窗開著時 A.modalOpen() 應為 true');
    $('#tdlg-close').click();
    if (S.view.app.modalOpen()) throw new Error('關閉後 A.modalOpen() 應為 false');
  });

  await step('表格視窗：從檢查結果定位到規則（展開那一組、捲到那一列、右欄是它）；點遮罩關閉，焦點回到開啟它的元素；Esc 不會連帶收起底下的抽屜', () => {
    const Q = App.Q; const all = Q.findings();
    const i = all.findIndex((f) => f.entities.some((e) => e.type === 'rule'));
    if (i < 0) throw new Error('範例資料應有指向規則的檢查結果');
    const f = all[i]; const key = f.entities.find((e) => e.type === 'rule').key;
    App.selectFinding(i);
    const row = fwRows(key).find((tr) => tr.classList.contains('focus'));
    if (!row) throw new Error('從檢查結果應定位到那一列');
    let g = row; while (g && !(g.classList && g.classList.contains('biglist-group'))) g = g.parentNode;
    const r = Q.getFirewallRule(key);
    if (!g || g.getAttribute('data-group') !== `${r.family}|${r.table}|${r.chain}` || g.getAttribute('open') == null) throw new Error('定位的列所在的 chain 應展開');
    if (!fwSide().textContent.includes(f.message) || document.activeElement !== fwSide().querySelector('h2')) throw new Error('從外部定位時右欄是那條規則，焦點在右欄的標題');
    // 點遮罩（dialog 本身）關閉
    $('#dlg-table').dispatch('click', { target: $('#dlg-table') });
    if ($('#dlg-table').open) throw new Error('點遮罩應關閉視窗');
    if (App.sel.type !== 'device') throw new Error('關閉視窗後選取回到那台設備');
    // 窄螢幕的底部抽屜開著時：Esc 只關視窗，抽屜還在
    const dev = r.dev;
    const prevW = window.innerWidth; window.innerWidth = 390;
    try {
      App.showView('graph'); S.view.app.setWorkspace('graph');
      App.select({ type: 'device', key: dev });
      const sheetBefore = S.view.app.sheetState();
      if (!sheetBefore) throw new Error('測試前提：窄螢幕在拓樸圖選取設備時開底部抽屜');
      const link = detailRoot().querySelector('.fw-open'); link.focus(); link.click();
      pressKey('Escape', fwRoot().querySelector('#tdlg-tab-rules'));
      if ($('#dlg-table').open) throw new Error('Esc 應關閉視窗');
      if (S.view.app.sheetState() !== sheetBefore) throw new Error('同一次 Esc 不應連帶收起抽屜');
      if (document.activeElement !== link) throw new Error('Esc 關閉後焦點應回到開啟它的元素');
    } finally { window.innerWidth = prevW; App.select(null); }
  });

  await step('表格視窗：窄螢幕單欄——點規則後只顯示詳情並有「返回」；返回保留選取、展開的組與頁碼，焦點回到那一列；寬螢幕的「返回」取消選取', () => {
    const Q = App.Q; const dev = fwDevice(Q);
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    const media = css.slice(css.indexOf('#dlg-table { width: 90vw'));
    if (!/@media \(max-width: 900px\) \{\s*#dlg-table \{ width: 100vw; height: 100dvh;/.test(media)) throw new Error('900px 以下視窗應是全螢幕');
    if (!/\.tdlg-cols\[data-view="detail"\] \.tdlg-list \{ display: none; \}/.test(media) || !/\.tdlg-cols \{ display: flex; flex-direction: column;/.test(media)) throw new Error('900px 以下應是單欄，看詳情時表格不顯示');
    if (!/\.tdlg-list, \.tdlg-side \{[^}]*overflow-x: hidden/.test(css)) throw new Error('視窗的兩欄不應整頁橫捲（表格在 .table-scroll 內橫捲）');
    const prevW = window.innerWidth; window.innerWidth = 390;
    try {
      openFrom(dev);
      const body = fwRoot();
      if (body.getAttribute('data-view') !== 'list') throw new Error('沒選列時是表格');
      const panel = fwTab('rules');
      const grp = panel.testAll('.biglist-group').find((g) => g.getAttribute('data-group') != null);
      grp.open = true; grp.dispatch('toggle');
      const tr = grp.testAll('tbody tr')[0]; const key = tr.getAttribute('data-key');
      tr.focus(); tr.click();
      if (body.getAttribute('data-view') !== 'detail') throw new Error('窄螢幕點規則後只顯示詳情（data-view=detail）');
      if (document.activeElement !== fwSide().querySelector('h2')) throw new Error('窄螢幕選取後焦點移到詳情的標題');
      const back = fwSide().querySelector('.tdlg-back');
      if (!back || !back.textContent.includes('返回')) throw new Error('詳情應有「返回」');
      back.click();
      if (body.getAttribute('data-view') !== 'list' || body.getAttribute('data-selected') == null) throw new Error('返回後回到表格，選取保留');
      if (App.sel.type !== 'rule' || App.sel.key !== key) throw new Error('窄螢幕的返回不取消選取');
      if (!grp.parentNode || !panel.contains(tr) || document.activeElement !== tr || !tr.classList.contains('focus')) throw new Error('返回後同一組還展開、焦點回到那一列');
      $('#tdlg-close').click();
      // 寬螢幕的「返回」：取消選取，右欄回到總覽，焦點回到那一列
      window.innerWidth = 1200;
      App.select({ type: 'rule', key });
      fwSide().querySelector('.tdlg-back').click();
      if (App.sel.type !== 'firewall' || fwSide().querySelector('.tdlg-back') || !fwSide().textContent.includes('這台設備的防火牆')) throw new Error('寬螢幕的返回應取消選取、右欄回到總覽');
      if (document.activeElement.getAttribute('data-key') !== key) throw new Error('寬螢幕返回後焦點回到那一列');
    } finally { window.innerWidth = prevW; App.select(null); }
  });

  await step('表格視窗：分頁可用 ←→ 切換；視窗裡的訊息寫在狀態列（role=status）不用 banner；選取列的顏色只在 CSS（--row-focus-* 同 theme）', async () => {
    const Q = App.Q; const dev = fwDevice(Q);
    openFrom(dev);
    const tabs = fwRoot().testAll('.tdlg-tab');
    if (tabs.length > 1) {
      tabs[0].focus(); pressKey('ArrowRight', tabs[0]);
      if (document.activeElement !== tabs[1] || tabs[1].getAttribute('aria-selected') !== 'true' || fwRoot().querySelector('#' + tabs[1].getAttribute('aria-controls')).getAttribute('hidden') != null) throw new Error('→ 應切到下一個分頁並顯示它');
      fwTab('rules');
    }
    if ($('#tdlg-status').getAttribute('role') !== 'status') throw new Error('視窗的狀態列應是 role=status');
    // 修正的「複製」：結果在狀態列
    const fi = Q.findings().findIndex((f) => f.entities.some((e) => e.type === 'rule' && Q.getFirewallRule(e.key)) && S.remediate.levelOf(f.id) !== 'manual'
      && S.remediate.plan(Q, [Q.findingKey(f)]).items.length);
    if (fi < 0) throw new Error('範例資料應有可以產生指令的修正');
    App.selectFinding(fi);
    const banner0 = text('#banner');
    fwSide().querySelector('.copy-fix').click(); await new Promise((r) => setTimeout(r, 5));
    if (!text('#tdlg-status').includes('複製') || text('#banner') !== banner0) throw new Error('視窗裡複製的結果應寫在視窗的狀態列，不用 banner：' + text('#tdlg-status'));
    // 選取列：只有 class，沒有 inline 的底色
    const sel = fwList().testAll('tr').find((tr) => tr.classList.contains('focus'));
    if (!sel || sel.testAll('td').some((td) => td.style.background || td.style.boxShadow)) throw new Error('選取列的樣式只在 CSS，不寫 inline style');
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    if (!/table\.t tbody tr\.focus td[^{]*\{ background: var\(--row-focus-bg\); box-shadow: inset 0 2px 0 var\(--row-focus-line\)/.test(css)) throw new Error('選取列的 CSS 應用 --row-focus-*');
    SCHEMES.forEach((mode) => {
      const v = cssVarsOf(css, mode); const T = S.view.theme.palettes[mode].firewall.focus;
      if (v['row-focus-bg'] !== T.bg || v['row-focus-line'] !== T.border) throw new Error(`${mode}：--row-focus-bg／--row-focus-line 應同 theme.firewall.focus`);
    });
    const src = fs.readFileSync(path.join(ROOT, 'src/view/panels/firewall.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'src/view/panels/details.js'), 'utf8');
    if (/focus\.bg|focus\.border|inset 3px 0 0 \$\{/.test(src)) throw new Error('畫面程式不應再以 theme.firewall.focus 組 inline style');
    // 「N 條有問題」只有一種算法：右欄摘要與視窗頁首相同
    App.select({ type: 'device', key: dev });
    const st = S.view.firewall.statusChips(App, dev);
    if (st.bad && !workEntry('防火牆').textContent.includes(st.bad.textContent)) throw new Error('右欄工作入口的「N 條有問題」應同 statusChips');
    App.select(null);
  });

  await step('表格視窗：從外部定位到收合的組裡的列時展開那一組；搜尋結果沒有它時清掉搜尋字回到摘要，搜尋結果有它時在結果中定位（保留搜尋字）', () => {
    const Q = App.Q; const dev = fwDevice(Q);
    openFrom(dev);
    const panel = fwTab('rules');
    const grp = panel.testAll('.biglist-group').find((g) => g.getAttribute('data-group') != null);
    grp.open = true; grp.dispatch('toggle');
    const key = grp.testAll('tbody tr')[0].getAttribute('data-key');
    // 使用者收起那一組：列還在 DOM 裡，但看不到
    grp.open = false; grp.removeAttribute('open');
    App.select({ type: 'rule', key });
    const at = shownRow(panel, key);
    if (!at || !at.classList.contains('focus') || !isOpen(grp)) throw new Error('定位到收合的組裡的列時應展開那一組，那一列是選取的');
    // 搜尋結果沒有它：清掉搜尋字，摘要回來，那一列看得到
    App.select({ type: 'firewall', dev });
    const q = panel.querySelector('.biglist-search');
    q.value = 'zzzz-沒有這種規則'; q.dispatch('input');
    if (shownRow(panel, key)) throw new Error('測試前提：搜尋結果沒有那條規則時，那一列看不到');
    App.select({ type: 'rule', key });
    if (panel.querySelector('.biglist-search').value !== '' || !shownRow(panel, key) || !shownRow(panel, key).classList.contains('focus')) throw new Error('搜尋結果沒有要定位的列時應清掉搜尋字，那一列看得到並是選取的');
    // 搜尋結果有它：保留搜尋字，在結果中定位
    App.select({ type: 'firewall', dev });
    const r = Q.getFirewallRule(key); const word = `#${r.position} ${r.action}`;
    q.value = word; q.dispatch('input');
    const inResult = (tr) => { for (let x = tr; x; x = x.parentNode) if (x.classList && x.classList.contains('biglist-result')) return true; return false; };
    if (!shownRow(panel, key) || !inResult(shownRow(panel, key))) throw new Error('測試前提：搜尋「' + word + '」的結果應有那條規則');
    App.select({ type: 'rule', key });
    const hit = shownRow(panel, key);
    if (panel.querySelector('.biglist-search').value !== word || !hit || !inResult(hit) || !hit.classList.contains('focus')) throw new Error('搜尋結果有要定位的列時保留搜尋字，在結果中選取它');
    App.select(null);
  });
};
