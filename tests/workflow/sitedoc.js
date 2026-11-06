// 網路文件（站點說明書，S.report.siteDocTables／siteDocMarkdown／siteDocCsv）：固定情境逐字比對、範例資料的結構與關鍵內容、可重現、推論標示、空的表格
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { S, read, test, sampleSnap } = require('../lib.js');
const scenarios = require('./fixtures/sitedoc/scenarios.js');

const TITLES = ['設備清單', 'IP 規劃', 'VLAN 表', '埠表', '未結案事項', '接受風險'];

test('網路文件：固定情境的 Markdown／CSV 與預期輸出逐字相同（CSV 每一行都以 CRLF 結尾）', () => {
  const got = scenarios.outputs(S);
  const files = fs.readdirSync(scenarios.DIR).filter((f) => /\.(csv|md)$/.test(f)).sort();
  assert.deepStrictEqual(Object.keys(got).sort(), files, '情境與預期輸出的檔案應一一對應');
  files.forEach((f) => assert.strictEqual(got[f], fs.readFileSync(path.join(scenarios.DIR, f), 'utf8'), `${f} 應與預期輸出逐字相同`));
  const Q = S.query(scenarios.snapshot(S, scenarios.SITE));
  const csv = S.report.siteDocCsv(Q);
  assert.ok(csv.startsWith('﻿[設備清單]\r\n') && csv.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(csv), 'CSV 的換行都是 CRLF');
});

test('網路文件：範例資料的表格依序為設備、IP、VLAN、埠、未結案、接受風險；Markdown 與 CSV 由同一份表格轉出', () => {
  const Q = S.query(sampleSnap());
  const tables = S.report.siteDocTables(Q);
  assert.deepStrictEqual(tables.map((t) => t.title), TITLES);
  tables.forEach((t) => t.rows.forEach((r) => {
    assert.strictEqual(r.length, t.columns.length, `${t.title} 每列的欄數與欄名相同`);
    r.forEach((c) => assert.strictEqual(typeof c, 'string', `${t.title} 的儲存格都是字串`));
  }));
  const [devs, ips, vlans, ports, open] = tables;
  assert.strictEqual(devs.rows.length, Q.devices().length, '設備清單列出所有設備');
  // 設備名與畫面相同（Q.devLabel）：只由 OSPF 得知、名稱是位址的設備加上協定
  assert.ok(devs.rows.some((r) => r[0] === Q.devLabel('172.31.255.2') && r[0] !== '172.31.255.2'));
  const core = devs.rows.find((r) => r[0] === 'TPE_CORE_RT_01');
  assert.deepStrictEqual(core.slice(0, 5), ['TPE_CORE_RT_01', 'CCR2216-1G-12XS-2XQ', '7.12.1 (stable)', '10.1.10.2', '路由器（推論）']);
  assert.strictEqual(ips.rows.length, Q.prefixes().filter((p) => p.basis === 'connected').length, '每個 VRF 的每個直連網段一列');
  assert.ok(ips.rows.some((r) => r[0] === '10.1.20.0/24' && r[1] === 'cust-a'), 'VRF 的網段另列');
  assert.ok(ips.rows.some((r) => r[0] === '10.1.30.0/24' && r[4].includes('10.1.30.1（TPE_CORE_RT_01）')), 'DHCP 閘道');
  assert.deepStrictEqual(Array.from(new Set(vlans.rows.map((r) => +r[0]))), Array.from(Q.vlanIds()), 'VLAN 表涵蓋每個 VLAN ID，由小到大');
  assert.strictEqual(vlans.rows.filter((r) => r[0] === '10').length, Q.vlan(10).domains.length, '每個區塊一列');
  assert.ok(ports.rows.every((r) => Q.devices().some((d) => d.collected && Q.devLabel(d.key) === r[0])), '埠表只列已收集的設備');
  assert.ok(ports.rows.some((r) => r[0] === 'TPE_ACC_SW_01' && r[1] === 'ether1' && r[8] === 'TPE-SRV-011 eth0'), 'LLDP 對端');
  assert.ok(ports.rows.some((r) => r[9] !== ''), '範例資料有推論鏈路的對端');
  // 未結案：沒有處理紀錄時，錯誤與警告全部列出（不含提醒），依嚴重度
  assert.strictEqual(open.rows.length, Q.pendingSummary().total);
  assert.ok(open.rows.every((r, i) => ['錯誤', '警告'].includes(r[0]) && (!i || !(open.rows[i - 1][0] === '警告' && r[0] === '錯誤'))));
  const md = S.report.siteDocMarkdown(Q);
  TITLES.forEach((t, i) => assert.ok(md.includes(`\n## ${t}（${tables[i].rows.length}）\n`), `Markdown 有「${t}」一節`));
  const csv = S.report.siteDocCsv(Q).replace(/^﻿/, '');
  assert.strictEqual(csv.split('\r\n').filter((l) => /^\[.+\]$/.test(l)).length, TITLES.length, 'CSV 每個表格一個區段');
  assert.strictEqual(csv.split('\r\n').length, tables.reduce((n, t) => n + t.rows.length + 2, 0) + (TITLES.length - 1) + 1, 'CSV 每個區段：標題、欄名、資料列，區段間空一列');
});

test('網路文件：可重現（同一份基準兩次、重新建立基準都逐字相同）；不改寫基準', () => {
  const snap = sampleSnap(); const before = JSON.stringify(snap);
  const a = S.report.siteDocMarkdown(S.query(snap)); const b = S.report.siteDocMarkdown(S.query(sampleSnap()));
  assert.strictEqual(a, b);
  assert.strictEqual(S.report.siteDocCsv(S.query(snap)), S.report.siteDocCsv(S.query(sampleSnap())));
  assert.strictEqual(JSON.stringify(snap), before, '不改寫 Snapshot');
});

test('網路文件：推論的欄位在欄名標「（推論）」，事實的欄位不標；來源依列而定的欄位（設備類型、zone）在值上標；開頭說明事實與推論', () => {
  const Q = S.query(sampleSnap());
  const tables = Object.fromEntries(S.report.siteDocTables(Q).map((t) => [t.id, t]));
  const cols = Object.fromEntries(Object.values(tables).map((t) => [t.id, t.columns]));
  const inferred = (id) => cols[id].filter((c) => c.endsWith('（推論）'));
  assert.deepStrictEqual(inferred('devices'), []);
  assert.deepStrictEqual(inferred('ip'), ['路由設備（推論）']);
  assert.deepStrictEqual(inferred('vlans'), ['區塊（推論）']);
  assert.deepStrictEqual(inferred('ports'), ['對端（推論）']);
  assert.ok(cols.devices.includes('設備類型') && cols.ip.includes('zone'));
  // 沒有命名規則：設備類型與 zone 都是推論，值上標「（推論）」
  const kindCol = cols.devices.indexOf('設備類型'); const zoneCol = cols.ip.indexOf('zone');
  assert.ok(tables.devices.rows.every((r) => r[kindCol].endsWith('（推論）')));
  assert.ok(tables.ip.rows.filter((r) => r[zoneCol]).every((r) => r[zoneCol].endsWith('（推論）')) && tables.ip.rows.some((r) => r[zoneCol]));
  assert.ok(cols.ports.includes('對端（LLDP／CDP）') && !cols.ports.some((c) => /MNDP/.test(c)), '對端只用介面鄰接，MNDP 不當直連');
  assert.ok(S.report.siteDocMarkdown(Q).includes('- 事實與推論：'));
});

test('網路文件：命名規則給的設備類型與 zone 標「（命名規則）」，不標推論；其他列仍標「（推論）」', () => {
  const text = read('samples/sample-bundle.txt');
  const profile = { schema: 'ssot-profile/1', id: 'sitedoc-test', version: '1',
    classify: [{ match: '^TPE_CORE_RT_01$', kind: 'firewall' }], zones: [{ on: 'vlan', match: '^30$', zone: 'USER' }] };
  const snap = S.build([{ name: 'sample-bundle.txt', text }], { now: '2026-01-01T00:00:00Z', profile });
  const Q = S.query(snap);
  const t = Object.fromEntries(S.report.siteDocTables(Q, { zones: { profile } }).map((x) => [x.id, x]));
  const k = t.devices.columns.indexOf('設備類型'); const z = t.ip.columns.indexOf('zone');
  const core = t.devices.rows.find((r) => r[0] === 'TPE_CORE_RT_01');
  assert.strictEqual(core[k], S.KIND_LABEL.firewall + '（命名規則）');
  assert.ok(t.devices.rows.filter((r) => r !== core).every((r) => r[k].endsWith('（推論）')));
  const user = t.ip.rows.find((r) => r[0] === '10.1.30.0/24');
  assert.strictEqual(user[z], 'USER（命名規則）');
  assert.ok(t.ip.rows.filter((r) => r !== user && r[z]).every((r) => r[z].endsWith('（推論）')));
});

test('網路文件：處理紀錄——已處理的不列入未結案、復發仍列入；接受風險另列並附豁免；opts.ports 為 false 時不含埠表', () => {
  const snap = scenarios.snapshot(S, scenarios.SITE); const Q = S.query(snap);
  const ledgerOf = scenarios.ledgerOf(snap);
  const t = Object.fromEntries(S.report.siteDocTables(Q, { ledgerOf }).map((x) => [x.id, x]));
  const st = Q.findings().map((f) => (ledgerOf(f) || {}).status);
  assert.strictEqual(t.open.rows.length, Q.findings().filter((f, i) => f.severity !== 'info' && S.ledger.isPending(st[i])).length);
  assert.ok(t.open.rows.some((r) => r[5] === S.report.statusText('regressed')), '復發仍待處理');
  assert.ok(!t.open.rows.some((r) => r[5] === S.report.statusText('fixed')), '已修好的不列');
  assert.strictEqual(t.accepted.rows.length, st.filter((s) => s === 'accepted').length);
  assert.ok(t.accepted.rows.every((r) => r[5] === '暫時保留 *A*' && r[6] === '2026-06-01T00:00:00Z'));
  assert.deepStrictEqual(S.report.siteDocTables(Q, { ports: false }).map((x) => x.id), ['devices', 'ip', 'vlans', 'open', 'accepted']);
  assert.ok(!S.report.siteDocMarkdown(Q, { ports: false }).includes('## 埠表'));
});

test('網路文件：沒有網段、VLAN、埠時表格寫「沒有。」，CSV 只有標題與欄名', () => {
  const Q = S.query(scenarios.snapshot(S, scenarios.EMPTY));
  const md = S.report.siteDocMarkdown(Q);
  ['IP 規劃', 'VLAN 表', '埠表', '接受風險'].forEach((t) => assert.ok(md.includes(`\n## ${t}（0）\n\n沒有。\n`), `${t} 寫「沒有。」`));
  const csv = S.report.siteDocCsv(Q).split('\r\n');
  const at = csv.indexOf('[VLAN 表]');
  assert.deepStrictEqual(csv.slice(at, at + 3), ['[VLAN 表]', 'VLAN,名稱,區塊（推論）,承載設備', '']);
});

test('網路文件：單向依賴——只透過查詢介面、S.report 與 S.ledger 讀取；不碰 DOM；載入在 report.js 之後；S.report 原有成員是同一個參考', () => {
  const src = read('src/report/sitedoc.js').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/\b(document|window|indexedDB|localStorage)\b|S\.(view|store|build|check|model|infer|compare|remediate|workpack)\b/.test(src), '不可碰 DOM、畫面或上游');
  assert.ok(!/\bsnap(shot)?\s*\./.test(src), '不讀 Snapshot 欄位，只用 Q');
  const core = require('../../tools/core-files.js');
  assert.strictEqual(core.indexOf('src/report/sitedoc.js'), core.indexOf('src/report/report.js') + 1, '緊接在 report.js 之後載入');
  assert.ok(Object.isFrozen(S.report));
  ['findingsCsv', 'findingsMarkdown', 'csvCell', 'mdText', 'statusText'].forEach((k) => assert.strictEqual(typeof S.report[k], 'function', `S.report.${k} 仍在`));
});
