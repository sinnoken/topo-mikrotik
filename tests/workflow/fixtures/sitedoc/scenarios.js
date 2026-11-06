// 網路文件（S.report.siteDocMarkdown／siteDocCsv）的固定情境：tests/workflow/sitedoc.js 用它和同一目錄的預期輸出逐字比對。
// 刻意改變網路文件的格式時，以 regenerate() 重新產生並檢視 git diff。
// CSV 的預期輸出以 LF 存放（.gitattributes 只對 tests/workflow/fixtures/report/ 保留 CRLF），比對時把 CRLF 換成 LF，另外檢查每一行都是 CRLF。
// 情境：
//   site：兩台已收集的設備（路由器、交換器；路由器的 RouterBOOT 韌體待升級），LLDP 介面鄰接、bridge VLAN、VLAN 介面的位址、DHCP 閘道、一台只由鄰居得知的設備，
//         以及處理紀錄（待處理、復發、接受風險含豁免、已修好）；欄位內容含逗號與引號（CSV 跳脫）、| 與 *（Markdown 跳脫）。
//   empty：只有 identity 的一台設備：沒有網段、沒有 VLAN、沒有埠，每個表格寫「沒有。」。
'use strict';
const fs = require('fs');
const path = require('path');

const NOW = '2026-01-01T00:00:00Z';
const DIR = __dirname;

const SITE = [
  'R1 (10.0.0.1):',
  '### /system resource print', '# collected-at: 2026-01-01T08:00:00Z', 'version: 7.15.3 (stable)', 'board-name: RB5009UG+S+',
  '### /system routerboard print', 'routerboard: yes', 'model: RB5009UG+S+', 'current-firmware: 7.14', 'upgrade-firmware: 7.15.3',
  '### /export terse',
  '/interface vlan add interface=ether2 name=vlan10 vlan-id=10',
  '/interface ethernet set [ find default-name=ether3 ] comment="uplink, \\"ISP\\" | *A*"',
  '/ip address add address=10.0.10.1/24 interface=vlan10',
  '/ip address add address=203.0.113.2/30 interface=ether3',
  '/ip dhcp-server network add address=10.0.10.0/24 gateway=10.0.10.1',
  '### /ip neighbor print detail without-paging',
  ' 0 interface=ether2 mac-address=AA:00:00:00:00:02 identity=SW1 interface-name=ether1 discovered-by=lldp',
  ' 1 interface=ether3 mac-address=AA:00:00:00:00:09 identity=ISP_GW address=203.0.113.1 platform=MikroTik board=CCR2004 version=7.14 interface-name=sfp1 discovered-by=lldp',
  'SW1 (10.0.10.2):',
  '### /system resource print', '# collected-at: 2026-01-01T08:05:00Z', 'version: 7.15.3 (stable)', 'board-name: CRS326-24G-2S+',
  '### /export terse',
  '/interface bridge add name=bridge1 vlan-filtering=yes',
  '/interface bridge port add bridge=bridge1 interface=ether1',
  '/interface bridge port add bridge=bridge1 interface=ether5 pvid=10',
  '/interface ethernet set [ find default-name=ether8 ] disabled=yes',
  '/interface bridge vlan add bridge=bridge1 tagged=bridge1,ether1 untagged=ether5 vlan-ids=10',
  '/interface vlan add interface=bridge1 name=vlan10 vlan-id=10',
  '/ip address add address=10.0.10.2/24 interface=vlan10',
  '### /ip neighbor print detail without-paging',
  ' 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=R1 interface-name=ether2 discovered-by=lldp',
].join('\n') + '\n';

const EMPTY = ['SW_X (10.9.9.9):', '### /system identity print', 'name: SW_X'].join('\n') + '\n';

function snapshot(S, text) {
  const snap = S.build([{ name: 't.txt', text }], { now: NOW });
  // 版本固定：升版時預期輸出不跟著變（網路文件只照抄 meta.version／schema）
  snap.meta = Object.assign({}, snap.meta, { version: '0.0.0-sitedoc', schema: 'ssot-snapshot/sitedoc' });
  return snap;
}

/** 處理紀錄：依檢查代碼給固定狀態（第一筆待處理以外的狀態都有一筆） */
function ledgerOf(snap) {
  const seen = new Map();
  const plan = [null, { status: 'regressed', at: '2026-01-03T00:00:00Z', note: '又出現', waiver: null },
    { status: 'accepted', at: '2026-01-02T00:00:00Z', note: '備註, "引號"', waiver: { reason: '暫時保留 *A*', until: '2026-06-01T00:00:00Z' } },
    { status: 'fixed', at: '2026-01-04T00:00:00Z', note: '', waiver: null }];
  return (f) => {
    const i = snap.findings.indexOf(f);
    if (!seen.has(i)) seen.set(i, plan[i % plan.length]);
    return seen.get(i);
  };
}

/** 情境名稱（也是預期輸出的檔名）→ 產生的文字；CSV 的 CRLF 換成 LF（見檔頭） */
function outputs(S) {
  const out = {};
  [['site', SITE, true], ['empty', EMPTY, false]].forEach(([name, text, withLedger]) => {
    const snap = snapshot(S, text); const Q = S.query(snap);
    const opts = withLedger ? { ledgerOf: ledgerOf(snap) } : undefined;
    out[name + '.md'] = S.report.siteDocMarkdown(Q, opts);
    out[name + '.csv'] = S.report.siteDocCsv(Q, opts).replace(/\r\n/g, '\n');
  });
  return out;
}

/** 重新產生預期輸出（刻意改變格式時用）：在 Node REPL 執行 require('./tests/workflow/fixtures/sitedoc/scenarios.js').regenerate(require('./tests/load.js')()) */
function regenerate(S) {
  const out = outputs(S);
  Object.keys(out).forEach((f) => fs.writeFileSync(path.join(DIR, f), out[f]));
  return Object.keys(out);
}

module.exports = { NOW, DIR, SITE, EMPTY, snapshot, ledgerOf, outputs, regenerate };
