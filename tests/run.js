/*
 * 測試：node tests/run.js        （加 --large 會另外跑約 1000 台的壓力測試）
 * 不需要任何套件。每個測試都在 Node 上直接載入與瀏覽器相同的核心檔案。
 * 注意：測試用的 RouterOS 輸出是依文件與慣例撰寫，不是從真實設備擷取；真實輸出請另外驗證。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const load = require('./load.js');
const S = load();
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const build = (text, opt) => S.build([{ name: 't.txt', text }], Object.assign({ now: '2026-01-01T00:00:00Z' }, opt));
const ids = (snap) => snap.findings.map((f) => f.id);
const count = (snap, id) => snap.findings.filter((f) => f.id === id).length;
const gen = (args) => execFileSync('node', [path.join(ROOT, 'tools/gen-bundle.js'), ...args], { encoding: 'utf8', maxBuffer: 5e8 });
const iface = (s, k) => s.model.interfaces.find((i) => i.key === k);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const dev = (name, body) => `${name} (10.0.0.${Math.floor(Math.random() * 200 + 1)}):\n${body}\n`;

// ------------------------------------------------------------------ 讀取
test('bundle-v1：設備標頭、分隔線可省略、兩種指令標記、註解行、行號', () => {
  const text = ['# 註解', 'SW_A (10.0.0.1):', '### /ip neighbor print detail without-paging', 'X', '_____',
    'SW_B (10.0.0.2):', '[admin@SW_B] > /interface bridge vlan print detail', 'Y', 'R_C (10.0.0.3):', '[admin@R_C] > /ip route print detail', 'Z'].join('\n');
  const { blocks } = S.readers.readAll([{ name: 'a.txt', text }]);
  assert.deepStrictEqual(blocks.map((b) => [b.device, b.command, b.origin.startLine]), [
    ['SW_A', '/ip neighbor print detail without-paging', 4], ['SW_B', '/interface bridge vlan print detail', 8], ['R_C', '/ip route print detail', 11]]);
  assert.strictEqual(blocks[0].mgmtIp, '10.0.0.1');
});
test('files-v1：沒有標頭時以檔名為設備名', () => {
  const { blocks } = S.readers.readAll([{ name: 'dir/EDGE_SW_9.txt', text: '### /ip arp print detail\nfoo' }]);
  assert.strictEqual(blocks[0].device, 'EDGE_SW_9');
  assert.strictEqual(blocks[0].reader, 'files-v1');
});
test('沒有設備標頭的內容列為無法辨識（不靜默丟棄）', () => {
  const s = build('隨便一段文字\nSW_A (10.0.0.1):\n### /ip neighbor print detail\n');
  assert.ok(ids(s).includes('I01'));
});
test('指令有辨識但輸出不是 detail 格式 → I01，並提示加 detail', () => {
  const s = build('SW_A (10.0.0.1):\n### /ip arp print\nFlags: X - disabled\n #   ADDRESS       MAC-ADDRESS       INTERFACE\n 0 DC 10.0.0.2    AA:BB:CC:00:00:01 bridge1\n');
  const f = s.findings.find((x) => x.id === 'I01');
  assert.ok(f && /detail/.test(f.message), f && f.message);
});

// ------------------------------------------------------------------ 鄰居
test('鄰居：續行、引號內空白、bridge 重複列去除、型號與功能推論類型', () => {
  const t = ['SW_A (10.0.0.1):', '[admin@SW_A] > /ip neighbor print detail without-paging', 'Flags:',
    ' 0 interface=sfp-sfpplus1 address=10.0.0.2 address4=10.0.0.2 mac-address=AA:BB:CC:00:00:01', '    identity=SW_B platform=MikroTik version="7.12 (stable)" board=CRS326-24G-2S+',
    '    interface-name=sfp-sfpplus3 system-caps=bridge system-caps-enabled=bridge',
    ' 1 interface=bridge1 address=10.0.0.2 mac-address=AA:BB:CC:00:00:01 identity=SW_B platform=MikroTik interface-name=sfp-sfpplus3',
    ' 2 interface=ether5 mac-address=AA:BB:CC:00:00:09 identity="PC 1" platform=Linux interface-name=eth0 system-caps-enabled=station-only',
    ' 3 interface=ether6 mac-address=AA:BB:CC:00:00:0A identity=AP_1 platform=MikroTik board="cAP ac" interface-name=ether1 system-caps-enabled=bridge,wlan-ap'].join('\n');
  const s = build(t);
  assert.strictEqual(s.model.links.length, 3);
  const k = (key) => s.model.devices.find((d) => d.key === key);
  assert.deepStrictEqual([k('SW_B').kind, k('SW_B').kindBasis, k('SW_B').board], ['switch', 'board', 'CRS326-24G-2S+']);
  assert.deepStrictEqual([k('PC 1').kind, k('PC 1').kindBasis], ['host', 'caps']);
  assert.strictEqual(k('AP_1').kind, 'switch');
  assert.strictEqual(k('SW_B').mgmtIp, '10.0.0.2');
});
test('鄰居：identity 和收集檔的設備名不同時，用管理 IP 對回同一台', () => {
  const a = 'A_RT (10.0.0.1):\n### /ip neighbor print detail\n 0 interface=ether1 address=10.0.0.2 mac-address=AA:BB:CC:00:00:01 identity=MikroTik interface-name=ether1\n';
  const b = 'B_SW (10.0.0.2):\n### /ip neighbor print detail\n 0 interface=ether1 address=10.0.0.1 mac-address=AA:BB:CC:00:00:02 identity=A_RT interface-name=ether1\n';
  const s = build(a + b);
  assert.ok(!s.model.devices.some((d) => d.key === 'MIKROTIK'), '不應多出一台叫 MikroTik 的設備');
  assert.strictEqual(s.model.links.length, 1); assert.ok(s.model.links[0].verified);
});
test('鄰居：兩邊都沒有對端埠名（RouterOS 6）：單一連結可配對；多條平行連結不會被誤判為同一個介面對到多個鄰居', () => {
  const one = build('A (10.0.0.1):\n### /ip neighbor print detail\n 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=B\n'
    + 'B (10.0.0.2):\n### /ip neighbor print detail\n 0 interface=ether2 mac-address=AA:00:00:00:00:02 identity=A\n');
  assert.strictEqual(one.model.links.length, 1); assert.ok(one.model.links[0].verified); assert.strictEqual(count(one, 'K01'), 0);
  const lag = build('A (10.0.0.1):\n### /ip neighbor print detail\n 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=B\n 1 interface=ether2 mac-address=AA:00:00:00:00:01 identity=B\n'
    + 'B (10.0.0.2):\n### /ip neighbor print detail\n 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=A\n 1 interface=ether2 mac-address=AA:00:00:00:00:02 identity=A\n');
  assert.strictEqual(lag.model.links.length, 2); assert.strictEqual(count(lag, 'K02'), 0);
});

test('鄰居：同一介面的 LLDP 與 MNDP/CDP 列合併為一筆，保留協定聯集；缺埠名或只有 MAC／identity 也能對上', () => {
  const claims = (t) => build(t).model.links;
  const a = 'A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=lldp\n'
    + ' 1 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B discovered-by=mndp\n'
    + ' 2 interface=ether1 mac-address=aa:00:00:00:00:02 discovered-by=cdp\n'
    + ' 3 interface=ether2 mac-address=AA:00:00:00:00:03 identity=C interface-name=p1 discovered-by=lldp\n'
    + ' 4 interface=ether2 identity=c discovered-by=mndp\n'
    + ' 5 interface=bridge1 mac-address=AA:00:00:00:00:02 identity=B discovered-by=mndp\n';
  const s = build(a);
  assert.strictEqual(s.model.links.length, 2);
  const l1 = s.model.links.find((l) => l.key.includes('A') && l.a.includes('ether1') || l.b.includes('ether1'));
  assert.deepStrictEqual(l1.protocols, ['cdp', 'lldp', 'mndp']);
  assert.strictEqual(l1.evidenceScope, 'interface-adjacency', 'LLDP/CDP 證據仍可支援介面鄰接推論');
  assert.ok(!s.model.interfaces.some((i) => /bridge1/.test(i.key)), 'bridge 觀察不應多出介面');
  assert.ok(claims(a).every((l) => !/\?\(/.test(l.a + l.b)), '合併後不應有未知埠名的重複連結');
});
test('MNDP：多個鄰居代表共享 L2 網域可達，不推論直連埠、雙向確認或 VLAN／聚合差異', () => {
  const s = build('A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n'
    + ' 1 interface=ether1 mac-address=AA:00:00:00:00:03 identity=C interface-name=ether8 discovered-by=mndp\n');
  assert.strictEqual(s.model.links.length, 2);
  assert.ok(s.model.links.every((l) => l.evidenceScope === 'broadcast-domain' && l.via.includes('mndp')));
  assert.ok(s.model.links.every((l) => !l.verified && !l.hearsay));
  assert.ok(s.model.links.every((l) => l.observations.length === 1 && l.observations[0].ifc === 'ether1'));
  assert.ok(s.model.interfaces.filter((i) => i.dev !== 'A').every((i) => i.hearsay), 'MNDP 回報的對端介面只能保留為聽說，不能當成設備本機收集的事實');
  assert.ok(s.model.links.every((l) => !l.vlanComparable && !l.vlansA.length && !l.vlansB.length));
  assert.strictEqual(count(s, 'K01'), 0);
  assert.strictEqual(count(s, 'K02'), 0, '一個廣播網域介面看到多個鄰居不是介面直連衝突');
  assert.strictEqual(count(s, 'K03'), 0);
  assert.strictEqual(count(s, 'V01'), 0, 'MNDP 域可達證據不能當作對端埠 VLAN 比對');
  const diff = S.compare(S.query(s), {
    schema: 'ssot-expected/1', links: [{ a: 'A ether1', b: 'B ether9' }], strictLinks: true,
  });
  assert.strictEqual(diff.items[0].status, 'different', 'MNDP 網域可達不能滿足預期的直連介面連結');
  assert.ok(!diff.items.some((i) => i.status === 'unexpected'), 'strictLinks 不應把 MNDP 網域可達列為額外直連');
  const noReportedPort = S.compare(S.query(s), {
    schema: 'ssot-expected/1', links: [{ a: 'A ether1', b: 'B ether7' }],
  });
  assert.strictEqual(noReportedPort.items[0].status, 'different', '遠端回報埠不同也應辨識到只有 MNDP 網域可達');

  const aggregates = build('A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n'
    + '### /export terse\n/interface bridge add name=bridgeA vlan-filtering=yes\n'
    + '/interface bonding add mode=802.3ad name=bondA slaves=ether1,ether2\n'
    + '/interface bridge port add bridge=bridgeA interface=bondA\n'
    + '/interface bridge vlan add bridge=bridgeA tagged=bondA vlan-ids=10\n'
    + 'B (10.0.0.2):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether9 mac-address=AA:00:00:00:00:01 identity=A interface-name=ether1 discovered-by=mndp\n'
    + '### /export terse\n/interface bridge add name=bridgeB vlan-filtering=yes\n'
    + '/interface bonding add mode=802.3ad name=bondB slaves=ether9,ether10\n'
    + '/interface bridge port add bridge=bridgeB interface=bondB\n'
    + '/interface bridge vlan add bridge=bridgeB tagged=bondB vlan-ids=20\n');
  assert.strictEqual(iface(aggregates, 'A|ether1').parent, 'bonda');
  assert.strictEqual(iface(aggregates, 'B|ether9').parent, 'bondb');
  assert.strictEqual(count(aggregates, 'K03'), 0, 'MNDP 網域可達不檢查兩端聚合成員');
  assert.strictEqual(count(aggregates, 'V01'), 0, 'MNDP 網域可達不比較對端埠 VLAN');

  const reciprocal = build('A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n'
    + 'B (10.0.0.2):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether9 mac-address=AA:00:00:00:00:01 identity=A interface-name=ether1 discovered-by=mndp\n');
  assert.strictEqual(reciprocal.model.links.length, 1);
  assert.strictEqual(reciprocal.model.links[0].evidenceScope, 'broadcast-domain');
  assert.strictEqual(reciprocal.model.links[0].observations.length, 2);
  assert.strictEqual(reciprocal.model.links[0].verified, false, '雙向 MNDP 回報仍不等於確認實體直連');
  assert.strictEqual(count(reciprocal, 'K01'), 0);
});

// ------------------------------------------------------------------ 設定（export）
const EXPORT_TERSE = ['SW_A (10.0.0.1):', '### /export terse', '# 2026-10-13 10:00:00 by RouterOS 7.12.1', '# model = CRS326-24G-2S+',
  '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bonding add mode=802.3ad name=bond1 slaves=ether1,ether2',
  '/interface ethernet set [ find default-name=ether3 ] name=srv3 comment="server 3"', '/interface vlan add interface=bridge1 name=vlan10 vlan-id=10',
  '/interface bridge port add bridge=bridge1 interface=bond1', '/interface bridge port add bridge=bridge1 interface=srv3 pvid=20',
  '/interface bridge vlan add bridge=bridge1 tagged=bond1,bridge1 untagged=srv3 vlan-ids=10,20-21 comment=prod',
  '/ip address add address=10.0.0.2/24 interface=vlan10', '/ip address add address=10.9.9.9/24 interface=ether9 disabled=yes',
  '/routing id add disabled=no id=1.1.1.1 name=main select-dynamic-id=""', '/routing ospf instance add disabled=no name=default router-id=main', '/system identity set name=SW_A'].join('\n');
test('export（terse）：聚合成員、改名與註解、VLAN 子介面、bridge VLAN（含範圍與 pvid）、IP、router-id、主機名', () => {
  const s = build(EXPORT_TERSE);
  assert.deepStrictEqual(iface(s, 'SW_A|bond1').members, ['SW_A|ether1', 'SW_A|ether2']);
  assert.strictEqual(iface(s, 'SW_A|bond1').type, 'aggregate');
  assert.strictEqual(iface(s, 'SW_A|srv3').desc, 'server 3');
  assert.deepStrictEqual(iface(s, 'SW_A|bond1').vlans, [1, 10, 20, 21], 'pvid 1（預設）＋ 標記 VLAN');
  assert.deepStrictEqual(iface(s, 'SW_A|srv3').vlans, [10, 20, 21]);
  assert.deepStrictEqual(iface(s, 'SW_A|vlan10').sub, { of: 'bridge1', vlan: 10 });
  assert.deepStrictEqual(iface(s, 'SW_A|vlan10').ips, ['10.0.0.2/24']);
  assert.strictEqual(iface(s, 'SW_A|ether9'), undefined, 'disabled 的位址不採用');
  assert.strictEqual(s.model.devices[0].routerId, '1.1.1.1', '/routing id 名稱要解析成位址');
  assert.strictEqual(s.model.devices[0].hostname, 'SW_A');
  assert.ok(s.model.vlans.some((v) => v.id === 20 && v.desc === 'prod'));
});
test('export（compact）：路徑標題、\\ 斷行、引號內斷行', () => {
  const t = ['R_A (10.0.0.1):', '### /export compact', '/interface bonding', 'add mode=802.3ad name=bond1 slaves=ether1,ether2 \\', '    comment="to the core \\', '    switch"',
    '/ip address', 'add address=10.1.1.1/24 interface=bridge1', '/routing ospf instance', 'set [ find default=yes ] router-id=2.2.2.2'].join('\n');
  const s = build(t);
  assert.strictEqual(iface(s, 'R_A|bond1').desc, 'to the core switch');
  assert.deepStrictEqual(iface(s, 'R_A|bridge1').ips, ['10.1.1.1/24']);
  assert.strictEqual(s.model.devices[0].routerId, '2.2.2.2');
});
test('export：bridge 沒有開 vlan-filtering 時，不產生 VLAN 成員', () => {
  const s = build('SW_A (10.0.0.1):\n### /export terse\n/interface bridge add name=bridge1\n/interface bridge port add bridge=bridge1 interface=ether1 pvid=20\n/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=10\n');
  assert.deepStrictEqual(iface(s, 'SW_A|ether1').vlans, []);
});

// ------------------------------------------------------------------ 其他 print
test('bridge host：略過 bridge 自己的 MAC（L），VLAN 取自 vid', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface bridge host print detail\nFlags: D - dynamic, L - local\n 0 DL mac-address=E4:8D:8C:00:00:02 on-interface=bridge1 bridge=bridge1 vid=0 age=3s\n 1 D  mac-address=24:6E:96:00:00:05 on-interface=ether1 bridge=bridge1 vid=20 age=3s\n');
  assert.strictEqual(s.model.macs.length, 1);
  assert.deepStrictEqual(s.model.macs[0].seen, [['SW_A|ether1', '20']]);
});
test('bridge vlan print：用實際成員（current-*），動態項目也算', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface bridge vlan print detail\n 0   ;;; prod\n     bridge=bridge1 vlan-ids=10 tagged=ether1 untagged=ether2 current-tagged=ether1,bond1 current-untagged=ether2\n 1 D bridge=bridge1 vlan-ids=1 tagged="" untagged="" current-tagged="" current-untagged=ether3,ether4\n');
  assert.deepStrictEqual(iface(s, 'SW_A|bond1').vlans, [10]);
  assert.deepStrictEqual(iface(s, 'SW_A|ether4').vlans, [1]);
  assert.ok(s.model.vlans.some((v) => v.id === 10 && v.desc === 'prod'));
});
test('interface print：running／停用／註解（含獨立一行的 ;;;）', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\nFlags: D - DYNAMIC; R - RUNNING; S - SLAVE\n 0  R  ;;; uplink\n       name="ether1" default-name="ether1" type="ether" mtu=1500\n 1     name="ether2" type="ether" mtu=1500\n 2 X   name="ether3" type="ether" mtu=1500\n 3  RS name="bond1" type="bond" mtu=1500\n');
  assert.deepStrictEqual([iface(s, 'SW_A|ether1').status, iface(s, 'SW_A|ether1').desc], ['up', 'uplink']);
  assert.strictEqual(iface(s, 'SW_A|ether2').status, 'down');
  assert.strictEqual(iface(s, 'SW_A|ether3').admin, 'down');
  assert.strictEqual(iface(s, 'SW_A|bond1').type, 'aggregate');
});
test('ARP 與 IP 位址：略過 invalid／disabled、多播、APIPA', () => {
  const s = build('R_A (10.0.0.1):\n### /ip arp print detail\n 0 DC address=10.0.0.2 mac-address=AA:BB:CC:00:00:01 interface=bridge1 complete=yes\n 1 I  address=10.0.0.3 mac-address=AA:BB:CC:00:00:02 interface=bridge1 complete=yes\n 2 DC address=169.254.1.1 mac-address=AA:BB:CC:00:00:03 interface=bridge1 complete=yes\n'
    + '### /ip address print detail\n 0   address=10.0.0.1/24 network=10.0.0.0 interface=bridge1 actual-interface=bridge1\n 1 X address=10.9.9.1/24 network=10.9.9.0 interface=ether9 actual-interface=ether9\n');
  assert.strictEqual(s.model.arps.length, 1);
  assert.deepStrictEqual(iface(s, 'R_A|bridge1').ips, ['10.0.0.1/24']);
});
test('路由：RouterOS 7（無序號）、ECMP（gateway=a,b）、連接路由、非作用中與其他路由表略過；RouterOS 6（序號、大寫旗標、pref-src）', () => {
  const v7 = ['Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC, o - OSPF',
    ' DAc dst-address=10.1.1.0/24 routing-table=main gateway=bridge1 immediate-gw=bridge1 distance=0 scope=10',
    ' DAo+ dst-address=10.2.0.0/16 routing-table=main gateway=10.0.0.2,10.0.0.6 immediate-gw=10.0.0.2%ether1,10.0.0.6%ether2 distance=110 scope=20',
    ' As  dst-address=0.0.0.0/0 routing-table=main gateway=10.0.0.254 immediate-gw=10.0.0.254%ether9 distance=1 scope=30',
    '  s  dst-address=10.5.0.0/16 routing-table=main gateway=10.0.0.9 distance=1', ' DAb dst-address=10.6.0.0/16 routing-table=vrf1 gateway=10.0.0.9 distance=20'].join('\n');
  const v6 = ['Flags: X - disabled, A - active, D - dynamic, C - connect, S - static, o - ospf', ' 0 ADC  dst-address=10.1.1.0/24 pref-src=10.1.1.1 gateway=bridge1 gateway-status=bridge1 reachable distance=0 scope=10',
    ' 1 A S  dst-address=0.0.0.0/0 gateway=10.0.0.254 gateway-status=10.0.0.254 reachable via bridge1 distance=1 scope=30', ' 2   S  dst-address=10.7.0.0/16 gateway=10.0.0.9 distance=1'].join('\n');
  const s7 = build('R_A (10.0.0.1):\n### /ip route print detail\n' + v7); const r7 = s7.model.routes;
  assert.deepStrictEqual(r7.map((r) => r.prefix + '/' + r.len + ' ' + r.proto), ['0.0.0.0/0 Static', '10.1.1.0/24 Direct', '10.2.0.0/16 OSPF']);
  assert.deepStrictEqual(r7.find((r) => r.prefix === '10.2.0.0').nh, [{ ip: '10.0.0.2', ifc: 'ether1' }, { ip: '10.0.0.6', ifc: 'ether2' }]);
  assert.deepStrictEqual(r7.find((r) => r.prefix === '10.1.1.0').nh, [{ ip: null, ifc: 'bridge1' }]);
  const s6 = build('R_A (10.0.0.1):\n### /ip route print detail\n' + v6);
  assert.deepStrictEqual(s6.model.routes.map((r) => r.prefix + ' ' + r.proto), ['0.0.0.0 Static', '10.1.1.0 Direct']);
});
test('OSPF：鄰居列沒有 interface 時，用鄰居位址落在哪個本機網段決定；對得上的設備與 router-id', () => {
  const a = 'R_A (10.0.0.1):\n### /export terse\n/ip address add address=10.254.0.1/30 interface=ether48\n/routing id add id=1.1.1.1 name=main\n/routing ospf instance add name=default router-id=main\n'
    + '### /routing ospf neighbor print detail\n 0 instance=default area=backbone address=10.254.0.2 priority=1 router-id=2.2.2.2 state=Full state-changes=5\n';
  const b = 'R_B (10.0.0.2):\n### /export terse\n/ip address add address=10.254.0.2/30 interface=ether1\n/routing ospf instance add name=default router-id=2.2.2.2\n'
    + '### /routing ospf neighbor print detail\n 0 instance=default address=10.254.0.1 router-id=1.1.1.1 interface=ether1 state=Full\n';
  const s = build(a + b);
  const l = s.model.links.find((x) => x.via.includes('ospf'));
  assert.ok(l && l.key === 'R_A|ether48~R_B|ether1' && l.verified, JSON.stringify(s.model.links));
  assert.strictEqual(count(s, 'R02'), 0);
});
test('system resource：型號決定交換器／路由器', () => {
  const s = build('X (10.0.0.1):\n### /system resource print\n  uptime: 1d\n  version: 7.12.1 (stable)\n  board-name: CRS326-24G-2S+\n');
  assert.deepStrictEqual([s.model.devices[0].kind, s.model.devices[0].board, s.model.devices[0].version], ['switch', 'CRS326-24G-2S+', '7.12.1 (stable)']);
});

// ------------------------------------------------------------------ 範例資料：每個刻意放入的問題都要被找到
test('範例資料：每項刻意放入的問題都被找到，且沒有多餘的錯誤', () => {
  const s = build(read('samples/sample-bundle.txt'));
  const expect = { I01: 1, I02: 1, C02: 1, K01: 1, K02: 1, K03: 1, K04: 1, V01: 1, A01: 1, A02: 1, R01: 2, R02: 1, C01: 2 };
  Object.entries(expect).forEach(([id, n]) => assert.strictEqual(count(s, id), n, `${id} 應有 ${n} 筆，實際 ${count(s, id)}`));
  assert.strictEqual(s.meta.stats.collected, 14);
  assert.deepStrictEqual(s.findings.filter((f) => f.severity === 'error').map((f) => f.id).sort(), ['I01', 'K02']);
  s.findings.forEach((f) => f.evidence.forEach((e) => assert.ok(typeof e.text === 'string')));
});
test('同樣輸入建立兩次，結果完全相同（建立時間除外）', () => {
  const a = build(read('samples/sample-bundle.txt')); const b = build(read('samples/sample-bundle.txt'));
  delete a.meta.timing; delete b.meta.timing;
  assert.deepStrictEqual(a, b);
});
test('連結配對：聚合成員雙向確認、沒有 LLDP 的鄰居為聽說', () => {
  const s = build(read('samples/sample-bundle.txt'));
  const l = s.model.links.find((x) => x.key === 'TPE_ACC_SW_01|sfp-sfpplus1~TPE_CORE_RT_01|sfp-sfpplus1');
  assert.ok(l && l.verified && l.cls === 'lag', JSON.stringify(l));
  assert.strictEqual(s.model.links.length, 78);
  const ap = s.model.links.find((x) => x.key.includes('TPE_AP_01'));
  assert.ok(ap && ap.hearsay);
});

// ------------------------------------------------------------------ 未知對端
test('未知對端：有 MAC、沒有 LLDP 鄰居的末端埠才會標記；有鄰居的主機埠與上行聚合埠不標', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  assert.strictEqual(iface(s, 'TPE_ACC_SW_01|bond1').unknownPeer, false, '上行聚合埠不是未知對端');
  assert.strictEqual(iface(s, 'TPE_ACC_SW_01|ether1').unknownPeer, false, '伺服器埠有 LLDP 鄰居');
  assert.strictEqual(iface(s, 'TPE_ACC_SW_01|ether1').edge, true);
  const rows = Q.unknownPeers('TPE_ACC_SW_01');
  assert.strictEqual(rows.length, 8);
  assert.ok(rows.every((r) => r.macs.length === 1 && /^10\.1\.30\./.test(r.macs[0].ips[0]) && r.macs[0].vendor), '應帶有 ARP 的 IP 與 OUI 廠商');
  assert.ok(!Q.unknownDevices().includes('TPE_ACC_SW_09'), '沒有 MAC 表的設備不會有未知對端');
});
test('未知對端：一個埠學到多個 MAC 時回報多筆（疑似下游還有設備）', () => {
  const mac = (n) => ` ${n} D mac-address=AA:BB:CC:00:00:0${n} on-interface=ether5 bridge=bridge1 vid=30 age=3s`;
  const s = build(['SW_A (10.0.0.1):', '### /interface bridge host print detail', mac(1), mac(2), mac(3)].join('\n'));
  const rows = S.query(s).unknownPeers('SW_A');
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].macs.length, 3);
});
test('未知對端不進基準的設備、連結（只是檢視）', () => {
  const s = build(read('samples/sample-bundle.txt'));
  assert.ok(!s.model.devices.some((d) => d.key.startsWith('?')));
});

// ------------------------------------------------------------------ 命名規則（可獨立、可跳過）
test('不套用命名規則時，設備類型只看資料，不看名稱', () => {
  const s = build('MY_FW_LIKE_NAME (10.0.0.1):\n### /interface bridge host print detail\n 0 D mac-address=AA:BB:CC:00:00:01 on-interface=ether1 bridge=bridge1 vid=10\n');
  assert.strictEqual(s.model.devices[0].kind, 'switch');
  assert.strictEqual(s.meta.profile, null);
});
test('命名規則：別名合併、去網域、分類、分群；只加註解不改事實', () => {
  const prof = { id: 't', classify: [{ match: '_FW_', kind: 'firewall', role: 'fw' }], group: { match: '^([A-Z]+)_', value: '$1' }, alias: { 'OLD-SW': 'SW_A' }, stripDomain: true };
  const text = 'SW_A (10.0.0.1):\n### /ip neighbor print detail\n 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=TPE_FW_01.corp.local interface-name=port1\n 1 interface=ether2 mac-address=AA:00:00:00:00:02 identity=old-sw interface-name=x\n';
  const a = build(text); const b = build(text, { profile: prof });
  assert.ok(b.model.devices.some((d) => d.key === 'TPE_FW_01' && d.kind === 'firewall' && d.kindBasis === 'profile' && d.group === 'TPE'));
  assert.ok(!b.model.devices.some((d) => d.key === 'OLD-SW'), '別名應合併');
  assert.strictEqual(a.model.devices.length, 3);
  assert.deepStrictEqual(b.meta.profile, { id: 't', version: '1' });
});
test('命名規則有錯時明確報錯', () => {
  assert.throws(() => S.profile.compile({ id: 'x', classify: [{ match: '(' }] }), /正規表示式/);
});
test('附帶的命名規則檔可載入', () => {
  const vm = require('vm');
  vm.runInThisContext(read('profiles/site-naming.js'));
  const p = S.profiles['site-naming'];
  assert.ok(p && S.profile.compile(p));
  const s = build(read('samples/sample-bundle.txt'), { profile: p });
  assert.ok(s.model.devices.filter((d) => d.group === 'TPE').length >= 14);
});

// ------------------------------------------------------------------ 查詢、追蹤、比對
test('查詢：MAC、IP、VLAN、設備、介面描述', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  const srv = s.model.macs.find((m) => m.vendor === 'Dell' && m.edge.length === 1);
  const mac = Q.findMac(S.keys.macPretty(srv.mac));
  assert.ok(mac.found && mac.edge.length === 1 && mac.ips.length === 1);
  assert.ok(Q.findMac('aa:aa:aa:aa:aa:aa').found === false);
  const ip = Q.findIp('10.1.20.11');
  assert.ok(ip.locations.length >= 1 && ip.subnets.length === 2);
  assert.ok(Q.vlan(30).partial.length === 1);
  assert.strictEqual(Q.search('core_rt')[0].type, 'device');
  assert.ok(Q.search('to TPE_ACC_SW_01').some((r) => r.type === 'interface'));
});
test('路由追蹤：直連抵達、下一跳不在基準內、跨站點 ECMP', () => {
  let Q = S.query(build(read('samples/sample-bundle.txt')));
  assert.ok(S.trace(Q, '10.1.30.15', '10.1.20.11').reached);
  const t2 = S.trace(Q, '10.1.30.15', '8.8.8.8');
  assert.ok(!t2.reached && t2.ends[0].status === 'unknown-nh', JSON.stringify(t2.ends));
  Q = S.query(build(gen(['--sites', '3', '--access', '2'])));
  const t3 = S.trace(Q, '10.1.30.15', '10.3.20.11');
  assert.ok(t3.reached, JSON.stringify(t3.ends));
  assert.ok(t3.hops.some((h) => h.ecmp));
});
test('OSPF 鄰接和 LLDP 連結合併成同一條連結（兩者佐證）', () => {
  const s = build(gen(['--sites', '2', '--access', '2']));
  const l = s.model.links.find((x) => x.key.includes('WAN_RT_01|ether1~') || x.key.endsWith('~WAN_RT_01|ether1'));
  assert.ok(l && l.via.includes('lldp') && l.via.includes('ospf') && l.verified, JSON.stringify(l));
  assert.strictEqual(s.findings.filter((f) => f.severity !== 'info').length, 0);
});
test('比對：獨立格式，結果分 ok／missing／different，且不修改基準', () => {
  const s = build(read('samples/sample-bundle.txt')); const before = JSON.stringify(s);
  const r = S.compare(S.query(s), JSON.parse(read('samples/expected-sample.json')));
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.summary.ok > 0 && r.summary.missing > 0 && r.summary.different > 0, JSON.stringify(r.summary));
  assert.strictEqual(JSON.stringify(s), before);
  assert.ok(S.compare(S.query(s), { schema: 'x' }).errors.length === 1);
});
test('index.html 載入的核心檔案與測試相同、順序一致', () => {
  const html = read('index.html');
  const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
  const core = require('../tools/core-files.js');
  assert.deepStrictEqual(scripts.slice(0, core.length), core);
});

if (process.argv.includes('--large')) {
  test('壓力：約 1000 台設備在時間內完成，且乾淨網路沒有誤報', () => {
    const text = gen(['--sites', '40', '--access', '24']);
    const t = Date.now(); const s = build(text); const ms = Date.now() - t;
    console.log(`      ${s.meta.stats.collected} 台已收集、${s.meta.stats.devices} 個節點、${s.meta.stats.links} 條連結、${s.meta.stats.macs} 個 MAC：${ms} ms`);
    assert.ok(s.meta.stats.collected >= 1000);
    assert.ok(ms < 20000);
    assert.strictEqual(s.meta.stats.findings.error + s.meta.stats.findings.warn, 0);
  });
}

let fail = 0;
for (const t of tests) {
  try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { fail++; console.log('  ✗ ' + t.name + '\n      ' + String(e.message).split('\n').join('\n      ')); }
}
console.log(`\n${tests.length - fail} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
