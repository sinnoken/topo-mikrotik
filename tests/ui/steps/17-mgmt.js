// 畫面冒煙測試的 step：設備詳情的管理面設定（Q.mgmtOf、S.query.mgmtDefaults）與 F10–F14 的比對對象、互相連結。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { S, step, buildInput, $, text } = require('../helpers.js');

module.exports = async () => {
  await step('管理面設定：設備詳情列出每項設定的狀態與依據（export 原文行號或出廠預設值的推論），沒有 export 時說明無法判斷，並與 F10–F14 互相連結', async () => {
    const RV = S.view.remediation; const P = S.readers.PASTE;
    // VA 有 export：DNS、SNMP、proxy、mac-server 寫出（proxy 的 port 沒寫），MAC WinBox、鄰居探索、bandwidth-server 沒寫（出廠預設值）
    // VB 已收集但沒有 /export
    const lines = ['VA (10.0.0.1):', '### /export terse', '/interface bridge add name=bridge1',
      '/interface list add name=WAN', '/interface list add name=LAN',
      '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=bridge1 list=LAN',
      '/ip address add address=203.0.113.2/30 interface=ether1',
      '/ip dns set allow-remote-requests=yes servers=1.1.1.1', '/snmp set enabled=yes', '/ip proxy set enabled=yes',
      '/tool mac-server set allowed-interface-list=LAN',
      '_____', 'VB (10.0.0.2):', '### /ip address print detail', ' 0   address=10.0.0.2/24 network=10.0.0.0 interface=ether1', ''];
    const lineOf = (s) => lines.indexOf(s) + 1;
    await buildInput(lines.join('\n') + '\n');
    const Q = App.Q; const all = Q.findings(); const D = S.query.mgmtDefaults();
    const pick = (id, facet) => all.findIndex((f) => f.id === id && (facet === undefined || f.facet === facet));
    const want = { F10: pick('F10'), F11: pick('F11', 'mac-winbox'), F13: pick('F13', 'public'), proxy: pick('F14', 'proxy'), bw: pick('F14', 'bandwidth-server') };
    Object.entries(want).forEach(([k, i]) => { if (i < 0) throw new Error('測試資料應產生 ' + k); });
    if (!Q.mgmtOf('VA') || Q.mgmtOf('VB') !== null) throw new Error('前提：VA 有管理面設定、VB 沒有（沒有 export）');

    // 比對對象（facet）的顯示文字：F11、F13、F14
    const ft = (id, facet, message) => RV.facetText({ id, facet, message });
    const expect = [['F11', 'mac-telnet', 'MAC Telnet'], ['F11', 'mac-winbox', 'MAC WinBox'], ['F14', 'upnp', 'UPnP'], ['F14', 'proxy', 'web proxy'],
      ['F14', 'socks', 'SOCKS'], ['F14', 'bandwidth-server', '頻寬測試伺服器（bandwidth-server）'], ['F13', 'public', 'community「public」']];
    expect.forEach(([id, facet, t]) => { if (ft(id, facet) !== t) throw new Error(`${id} 的 ${facet} 應顯示成「${t}」，實際是「${ft(id, facet)}」`); });
    if (ft('F14', 'other') !== 'other') throw new Error('不認得的 facet 應顯示原值');
    if (RV.facetText(all[want.F13]) !== 'community「public」') throw new Error('F13 的比對對象應是 community 名稱');

    // VA 的詳情：管理面設定一段，每項一列
    App.select({ type: 'device', key: 'VA' });
    const sec = $('#detail').testAll('.mgmt-section')[0];
    if (!sec || !sec.textContent.startsWith('管理面設定')) throw new Error('設備詳情應有「管理面設定」一段（section() 產生，標題在前）');
    const rows = sec.testAll('.mgmt-row');
    const row = (k) => { const r = rows.find((x) => x.getAttribute('data-mgmt') === k); if (!r) throw new Error('管理面設定應有 ' + k + ' 一列'); return r; };
    ['dns', 'macServer', 'macWinbox', 'discovery', 'snmp', 'upnp', 'proxy', 'socks', 'bandwidthServer'].forEach(row);
    // 寫出的值與原文連結：點了開在那一行
    const dns = row('dns');
    if (!dns.textContent.includes('allow-remote-requests=yes') || !dns.textContent.includes('允許')) throw new Error('DNS 一列應顯示狀態與寫出的值');
    const orig = App.openRaw; const opened = [];
    App.openRaw = (file, line, opt) => { opened.push([file, line]); };
    try {
      const src = dns.testAll('.mgmt-src')[0];
      if (!src || !src.textContent.includes(`第 ${lineOf('/ip dns set allow-remote-requests=yes servers=1.1.1.1')} 行`)) throw new Error('export 寫出的設定應連到原文行號');
      src.click();
      if (!opened.length || opened[0][0] !== P || opened[0][1] !== lineOf('/ip dns set allow-remote-requests=yes servers=1.1.1.1')) throw new Error('點原文連結應開在那一行');
    } finally { App.openRaw = orig; }
    // 預設值：標示推論，提示寫出依據（RouterOS 版本與手冊），沒有原文連結
    const DEF = '預設（未在 export 中，推論）';
    const win = row('macWinbox'); const chip = win.testAll('.mgmt-default')[0];
    if (!chip || chip.textContent !== DEF) throw new Error('沒寫出的設定應標「' + DEF + '」');
    const tip = chip.getAttribute('title') || '';
    if (!tip.includes(D.routerOS) || !tip.includes(D.manual.macWinbox)) throw new Error('預設值的提示應寫出 S.query.mgmtDefaults() 的版本與手冊');
    if (win.testAll('.mgmt-src').length) throw new Error('預設值沒有原文行號');
    if (!win.textContent.includes('allowed-interface-list=all')) throw new Error('預設值也要列出推定的值');
    if (row('dns').testAll('.mgmt-default').length) throw new Error('寫出的設定不應標預設');
    // 部分欄位是預設值：有原文連結，另標出哪些欄位是預設
    const px = row('proxy');
    if (!px.testAll('.mgmt-src').length || !px.testAll('.mgmt-default').length || !px.textContent.includes('port=8080')) throw new Error('proxy 寫了 enabled、沒寫 port：應有原文連結，port 標預設');
    // SNMP community：出廠的 public 一列
    const pub = rows.find((x) => x.getAttribute('data-mgmt') === 'community' && x.getAttribute('data-community') === 'public');
    if (!pub || !pub.testAll('.mgmt-default').length || !pub.textContent.includes('addresses=::/0')) throw new Error('出廠的 public community 應列出並標預設');

    // 設定 → 檢查結果：每列連到自己的 F10–F14，點了開啟那一筆
    const links = (r) => r.testAll('.mgmt-finding').map((a) => Number(a.getAttribute('data-finding-idx')));
    const pairs = [[dns, want.F10], [win, want.F11], [pub, want.F13], [px, want.proxy], [row('bandwidthServer'), want.bw]];
    pairs.forEach(([r, idx]) => { if (links(r).join() !== String(idx)) throw new Error(`${r.getAttribute('data-mgmt')} 一列應只連到 ${all[idx].id}（${all[idx].facet || ''}）`); });
    if (links(row('socks')).length || links(row('macServer')).length) throw new Error('沒有檢查結果的設定不應有連結');
    const os = App.selectFinding; const sel = [];
    App.selectFinding = (i) => { sel.push(i); return os(i); };
    try {
      win.testAll('.mgmt-finding')[0].dispatch('keydown', { key: 'Enter' });
      if (sel[0] !== want.F11) throw new Error('按 Enter 應開啟這列的檢查結果');
    } finally { App.selectFinding = os; }
    // 檢查結果 → 設定：F10–F14 的檢查結果有「管理面設定」連結，點了展開並標出那一列
    App.select({ type: 'device', key: 'VA' });
    const box = $('#detail').testAll('.finding').find((el) => el.textContent.includes(all[want.F11].message));
    const go = box && box.testAll('.mgmt-goto')[0];
    if (!go) throw new Error('F11 的檢查結果應連到管理面設定');
    go.click();
    const sec2 = $('#detail').testAll('.mgmt-section')[0];
    if (!sec2.open) throw new Error('點了應展開管理面設定');
    const focused = sec2.testAll('.mgmt-row').filter((r) => r.classList.contains('focus'));
    if (focused.length !== 1 || focused[0].getAttribute('data-mgmt') !== 'macWinbox') throw new Error('點了應標出 MAC WinBox 那一列');
    const other = $('#detail').testAll('.finding').find((el) => el.textContent.includes(all.find((f) => f.id === 'C02').message));
    if (other && other.testAll('.mgmt-goto').length) throw new Error('F10–F14 以外的檢查結果不應連到管理面設定');

    // 沒有 export 的設備：說明無法判斷，不列設定
    App.select({ type: 'device', key: 'VB' });
    const vb = $('#detail').testAll('.mgmt-section')[0];
    if (!vb || !vb.textContent.includes('沒有收集 /export，無法判斷') || vb.testAll('.mgmt-row').length) throw new Error('沒有 export 的設備應說明「沒有收集 /export，無法判斷」');
    if (text('#detail').includes(DEF)) throw new Error('沒有 export 的設備不應推定預設值');
    App.select(null);
  });
};
