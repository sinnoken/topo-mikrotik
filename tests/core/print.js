// 其他 print（bridge host、bridge vlan、interface、ARP、路由、OSPF、system resource）
'use strict';
const assert = require('assert');
const { S, build, ids, count, iface, addrs, test, i03 } = require('../lib.js');
// ------------------------------------------------------------------ 其他 print
test('bridge host：略過 bridge 自己的 MAC（L），VLAN 取自 vid', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface bridge host print detail\nFlags: D - dynamic, L - local\n 0 DL mac-address=E4:8D:8C:00:00:02 on-interface=bridge1 bridge=bridge1 vid=0 age=3s\n 1 D  mac-address=24:6E:96:00:00:05 on-interface=ether1 bridge=bridge1 vid=20 age=3s\n');
  assert.strictEqual(s.model.macs.length, 1);
  assert.deepStrictEqual(s.model.macs[0].seen, [{ ep: 'SW_A|ether1', vlan: '20', static: false }]);
});
test('bridge vlan print：用實際成員（current-*），動態項目也算', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface bridge vlan print detail\n 0   ;;; prod\n     bridge=bridge1 vlan-ids=10 tagged=ether1 untagged=ether2 current-tagged=ether1,bond1 current-untagged=ether2\n 1 D bridge=bridge1 vlan-ids=1 tagged="" untagged="" current-tagged="" current-untagged=ether3,ether4\n');
  assert.deepStrictEqual([iface(s, 'SW_A|bond1').taggedVlans, iface(s, 'SW_A|bond1').untaggedVlans], [[10], []]);
  assert.deepStrictEqual([iface(s, 'SW_A|ether4').untaggedVlans, iface(s, 'SW_A|ether4').mode], [[1], 'access']);
  assert.ok(s.model.vlans.some((v) => v.id === 10 && v.desc === 'prod'));
});
test('interface print：running／停用／註解（含獨立一行的 ;;;）', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\nFlags: D - DYNAMIC; R - RUNNING; S - SLAVE\n 0  R  ;;; uplink\n       name="ether1" default-name="ether1" type="ether" mtu=1500\n 1     name="ether2" type="ether" mtu=1500\n 2 X   name="ether3" type="ether" mtu=1500\n 3  RS name="bond1" type="bond" mtu=1500\n');
  assert.deepStrictEqual([iface(s, 'SW_A|ether1').status, iface(s, 'SW_A|ether1').desc], ['up', 'uplink']);
  assert.strictEqual(iface(s, 'SW_A|ether2').status, 'down');
  assert.deepStrictEqual([iface(s, 'SW_A|ether3').enabled, iface(s, 'SW_A|ether2').enabled], [false, true]);
  assert.strictEqual(iface(s, 'SW_A|bond1').type, 'lag');
});
test('detail：列首只有序號與旗標、欄位在下一行時開新列，不併入上一列；不是序號開頭的雜訊不算列首', () => {
  // 範例產生器的形狀（沒有註解時列首只剩「13  R 」）；原本會把 bridge1 的欄位併進 bond100，bond100 沒有狀態、bridge1 拿到 bond100 的註解（I03 找到的）
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\nFlags: D - DYNAMIC; R - RUNNING; S - SLAVE\n 12  R  ;;; core interconnect\n       name="bond100" type="bond" mtu=1500\n 13  R \n       name="bridge1" type="bridge" mtu=1500\n 14 \n       name="ether9" type="ether" mtu=1500\n');
  assert.deepStrictEqual(['bond100', 'bridge1', 'ether9'].map((n) => [iface(s, `SW_A|${n}`).status, iface(s, `SW_A|${n}`).desc]), [['up', 'core interconnect'], ['up', null], ['down', null]]);
  assert.deepStrictEqual(i03(s), []);
  const g = build('SW_A (10.0.0.1):\n### /interface print detail\nFlags: D - DYNAMIC; R - RUNNING; S - SLAVE\n 0  R  name="ether1" type="ether" mtu=1500\nR Q\n 1 RQ\n');
  assert.deepStrictEqual(i03(g).map((f) => f.evidence.map((e) => e.text)), [['R Q', '1 RQ']], '沒有序號、或旗標不在說明行中的都不是列首');
});
test('interface print：CAPsMAN 說明續行保留 Wi-Fi running 旗標；Wi-Fi 介面本身不列為終端', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
    + ' 7    RS ;;; managed by CAPsMAN, traffic processing on\n'
    + '              CAP         ;;; mode: AP, SSID: test, channel: 2412/n\n'
    + '         name="wifi1" default-name="wifi1" type="wifi" actual-mtu=1500\n'
    + ' 9  D RS ;;; managed by CAPsMAN, traffic processing on\n'
    + '              CAP         ;;; mode: AP, SSID: test-5g, channel: 5660/ac/Ceee\n'
    + '         name="wifi8" type="wifi" actual-mtu=1500\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=14:63:93:C4:13:24 on-interface=wifi1 bridge=bridge\n'
    + ' 1 D mac-address=3C:64:CF:0C:C4:63 on-interface=wifi1 bridge=bridge\n'
    + ' 2 D mac-address=06:89:53:94:06:0F on-interface=wifi8 bridge=bridge\n'
    + ' 3 D mac-address=18:F0:E4:FF:EF:35 on-interface=wifi8 bridge=bridge\n');
  ['wifi1', 'wifi8'].forEach((name) => {
    const i = iface(s, `SW_A|${name}`);
    assert.strictEqual(i.status, 'up', `${name} 的 R 旗標不可被 CAPsMAN 說明覆蓋`);
    assert.strictEqual(i.macs.length, 2);
    assert.strictEqual(i.edge, false, `${name} 不應列為終端介面`);
    assert.strictEqual(i.unknownPeer, false, `${name} 不應列為未知對端`);
  });
});
test('interface print：type=veth 歸類為 virtual（rawType 保留 veth），unknownPeers 帶型別；其他介面不受影響', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
    + ' 0  R  name="veth1" type="veth" mtu=1500\n'
    + ' 1  R  name="ether5" type="ether" mtu=1500\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=02:AA:BB:00:00:01 on-interface=veth1 bridge=bridge1\n'
    + ' 1 D mac-address=AA:BB:CC:00:00:02 on-interface=ether5 bridge=bridge1\n');
  assert.deepStrictEqual([iface(s, 'SW_A|veth1').type, iface(s, 'SW_A|veth1').rawType], ['virtual', 'veth']);
  assert.strictEqual(iface(s, 'SW_A|ether5').type, 'physical');
  const rows = S.query(s).unknownPeers('SW_A');
  assert.strictEqual(rows.find((r) => r.name === 'veth1').rawType, 'veth');
  assert.notStrictEqual(rows.find((r) => r.name === 'ether5').rawType, 'veth');
});
test('interface print：保留 rawType／介面 MAC／MTU，並依 rawType 排除 bridge 終端', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
    + ' 0  R  name="ether1" default-name="ether1" type="ether" mtu=1500 l2mtu=1598 mac-address=AA:BB:CC:00:00:01\n'
    + ' 1  R  name="br-mgmt" type="bridge" mtu=1500 actual-mtu=1500\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=02:AA:BB:00:00:01 on-interface=ether1 bridge=br-mgmt\n'
    + ' 1 D mac-address=02:AA:BB:00:00:02 on-interface=br-mgmt bridge=br-mgmt\n');
  const e = iface(s, 'SW_A|ether1');
  assert.deepStrictEqual([e.rawType, e.hwMac, e.defaultName, e.mtu, e.l2mtu], ['ether', 'AA:BB:CC:00:00:01', 'ether1', 1500, 1598]);
  const b = iface(s, 'SW_A|br-mgmt');
  assert.deepStrictEqual([b.rawType, b.actualMtu, b.edge], ['bridge', 1500, false]);
  assert.strictEqual(e.edge, true);
});
test('介面自身的 mac-address 出現在轉發表時不算外部終端', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
    + ' 0  R  name="ether1" type="ether" mac-address=AA:BB:CC:00:00:01\n'
    + ' 1  R  name="ether2" type="ether" mac-address=AA:BB:CC:00:00:02\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=AA:BB:CC:00:00:02 on-interface=ether1 bridge=br\n'
    + ' 1 D mac-address=02:AA:BB:00:00:09 on-interface=ether2 bridge=br\n');
  assert.strictEqual(iface(s, 'SW_A|ether1').edge, false);
  assert.strictEqual(iface(s, 'SW_A|ether2').edge, true);
});
test('interface print 缺漏：改用 export 的 bridge／vlan 定義判斷，再退回名稱規則', () => {
  const s = build('SW_A (10.0.0.1):\n### /export terse\n'
    + '/interface bridge add name=br-mgmt\n/interface vlan add name=v-10 interface=ether1 vlan-id=10\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=02:AA:BB:00:00:01 on-interface=br-mgmt bridge=br-mgmt\n'
    + ' 1 D mac-address=02:AA:BB:00:00:02 on-interface=v-10 bridge=br-mgmt\n'
    + ' 2 D mac-address=02:AA:BB:00:00:03 on-interface=ether1 bridge=br-mgmt\n'
    + ' 3 D mac-address=02:AA:BB:00:00:04 on-interface=irb9 bridge=br-mgmt\n');
  assert.deepStrictEqual(['br-mgmt', 'v-10'].map((n) => iface(s, 'SW_A|' + n).rawType), ['bridge', 'vlan']);
  assert.deepStrictEqual(['br-mgmt', 'v-10', 'irb9'].map((n) => iface(s, 'SW_A|' + n).edge), [false, false, false]);
  assert.strictEqual(iface(s, 'SW_A|ether1').edge, true);
});
test('沒有介面資料時，名稱 bridge* 的介面依名稱規則視為虛擬：不是終端埠、不列入 A03／A04（與 rawType=bridge 一致）', () => {
  const many = Array.from({ length: 6 }, (_, k) => ` ${k + 2} D mac-address=02:AA:BB:00:01:0${k} on-interface=bridge2 bridge=bridge1\n`).join('');
  const s = build('SW_A (10.0.0.1):\n### /interface bridge host print detail\n'
    + ' 0 D mac-address=02:AA:BB:00:00:01 on-interface=bridge1 bridge=bridge1\n'
    + ' 1 D mac-address=02:AA:BB:00:00:02 on-interface=ether1 bridge=bridge1\n' + many);
  assert.deepStrictEqual(['bridge1', 'bridge2'].map((n) => [iface(s, 'SW_A|' + n).rawType, iface(s, 'SW_A|' + n).edge, iface(s, 'SW_A|' + n).unknownPeer]),
    [[null, false, false], [null, false, false]]);
  assert.strictEqual(iface(s, 'SW_A|ether1').edge, true);
  const a03 = s.findings.filter((f) => f.id === 'A03');
  assert.strictEqual(a03.length, 1);
  assert.ok(!/bridge1/.test(a03[0].message), a03[0].message);
  assert.strictEqual(count(s, 'A04'), 0);
});
test('LLDP interface-name 為 bridge/port：取實體埠配對，雙向確認且不產生 bridge/ 假介面', () => {
  const nb = (local, ip, mac, id, name) => ` 0 interface=${local} address=${ip} mac-address=${mac} identity="${id}" platform="MikroTik" interface-name="${name}" discovered-by=lldp,mndp\n`;
  const s = build('A (192.168.77.1):\n### /ip neighbor print detail without-paging\n' + nb('ether3,bridge', '192.168.77.9', 'D4:01:C3:4E:2D:04', 'B', 'bridge/ether2')
    + 'B (192.168.77.9):\n### /ip neighbor print detail without-paging\n' + nb('ether2,bridge', '192.168.77.1', 'AA:00:00:00:00:01', 'A', 'bridge/ether3'));
  assert.deepStrictEqual(s.model.links.map((l) => [l.a, l.b, l.verified]), [['A|ether3', 'B|ether2', true]]);
  assert.ok(!s.model.interfaces.some((i) => i.name.includes('/')));
  assert.strictEqual(count(s, 'K01'), 0);
});
test('LLDP 配對：只有 LLDP 才算回報，MNDP 不算；bridge 成員與 bridge 本身兩端名稱視為同一介面', () => {
  const nb = (ifc, ip, mac, id, name, proto) => ` 0 interface=${ifc} address=${ip} mac-address=${mac} identity="${id}" platform="MikroTik" interface-name="${name}" discovered-by=${proto}\n`;
  const head = (n, ip) => `${n} (${ip}):\n### /ip neighbor print detail without-paging\n`;
  const c = (dev) => head(dev, '10.0.0.3') + nb('ether1', '10.0.0.9', 'AA:00:00:00:00:09', 'Z', 'ether1', 'lldp');
  const mndpBack = build(head('A', '10.0.0.1') + nb('ether1', '10.0.0.2', 'AA:00:00:00:00:02', 'B', 'ether2', 'lldp,mndp')
    + head('B', '10.0.0.2') + nb('ether2', '10.0.0.1', 'AA:00:00:00:00:01', 'A', 'ether1', 'mndp') + nb('ether5', '10.0.0.3', 'AA:00:00:00:00:03', 'C', 'ether1', 'lldp') + c('C'));
  assert.ok(mndpBack.model.links.some((l) => !l.verified && l.protocols.includes('lldp')));
  assert.ok(count(mndpBack, 'K01') >= 1);
  const bridges = build(head('A', '10.0.0.1') + nb('bridge', '10.0.0.2', 'AA:00:00:00:00:02', 'B', 'bridge', 'lldp')
    + head('B', '10.0.0.2') + nb('bridge', '10.0.0.1', 'AA:00:00:00:00:01', 'A', 'bridge/ether1', 'lldp'));
  assert.deepStrictEqual(bridges.model.links.map((l) => [l.a, l.b, l.verified]), [['A|bridge', 'B|bridge', true]]);
  assert.strictEqual(count(bridges, 'K01'), 0);
});
test('鄰居表：同一對設備的 MNDP（多介面、雙向）併成一列，仍保留各 link 來源', () => {
  const nb = (ifc, ip, mac, id) => ` 0 interface=${ifc} address=${ip} mac-address=${mac} identity="${id}" platform=MikroTik discovered-by=mndp\n`;
  const s = build('A (10.0.0.1):\n### /ip neighbor print detail without-paging\n'
    + nb('ether1', '10.0.0.2', 'AA:00:00:00:00:02', 'B') + nb('ether2', '10.0.0.2', 'AA:00:00:00:00:02', 'B')
    + 'B (10.0.0.2):\n### /ip neighbor print detail without-paging\n' + nb('ether5', '10.0.0.1', 'AA:00:00:00:00:01', 'A'));
  const Q = S.query(s);
  assert.strictEqual(Q.linksOf('A').length, 3);
  const rows = Q.neighborRows('A');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].links.length, 3);
  assert.deepStrictEqual(rows[0].observations.map((o) => o.ifc), ['ether1', 'ether2']);
  assert.deepStrictEqual(Q.neighborRows('B')[0].observations.map((o) => o.ifc), ['ether5']);
});
test('interface print：type=wifi／wlan 歸類為 wireless', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
    + ' 0  R  name="wifi1" type="wifi" mtu=1500\n 1  R  name="wlan1" type="wlan" mtu=1500\n 2  R  name="ether5" type="ether" mtu=1500\n');
  assert.strictEqual(iface(s, 'SW_A|wifi1').type, 'wireless');
  assert.strictEqual(iface(s, 'SW_A|wlan1').type, 'wireless');
  assert.strictEqual(iface(s, 'SW_A|ether5').type, 'physical');
});
test('ARP 與 IP 位址：略過 invalid／disabled、多播、APIPA', () => {
  const s = build('R_A (10.0.0.1):\n### /ip arp print detail\n 0 DC address=10.0.0.2 mac-address=AA:BB:CC:00:00:01 interface=bridge1 complete=yes\n 1 I  address=10.0.0.3 mac-address=AA:BB:CC:00:00:02 interface=bridge1 complete=yes\n 2 DC address=169.254.1.1 mac-address=AA:BB:CC:00:00:03 interface=bridge1 complete=yes\n'
    + '### /ip address print detail\n 0   address=10.0.0.1/24 network=10.0.0.0 interface=bridge1 actual-interface=bridge1\n 1 X address=10.9.9.1/24 network=10.9.9.0 interface=ether9 actual-interface=ether9\n');
  assert.strictEqual(s.model.arps.length, 1);
  assert.deepStrictEqual(addrs(s, 'R_A|bridge1'), ['10.0.0.1/24']);
});
test('路由：RouterOS 7（無序號）、ECMP（gateway=a,b）、連接路由、非作用中略過、其他路由表保留（沒有 VRF 設定時 vrf 為 null）；RouterOS 6（序號、大寫旗標、pref-src）', () => {
  const v7 = ['Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC, o - OSPF',
    ' DAc dst-address=10.1.1.0/24 routing-table=main gateway=bridge1 immediate-gw=bridge1 distance=0 scope=10',
    ' DAo+ dst-address=10.2.0.0/16 routing-table=main gateway=10.0.0.2,10.0.0.6 immediate-gw=10.0.0.2%ether1,10.0.0.6%ether2 distance=110 scope=20',
    ' As  dst-address=0.0.0.0/0 routing-table=main gateway=10.0.0.254 immediate-gw=10.0.0.254%ether9 distance=1 scope=30',
    '  s  dst-address=10.5.0.0/16 routing-table=main gateway=10.0.0.9 distance=1', ' DAb dst-address=10.6.0.0/16 routing-table=vrf1 gateway=10.0.0.9 distance=20'].join('\n');
  const v6 = ['Flags: X - disabled, A - active, D - dynamic, C - connect, S - static, o - ospf', ' 0 ADC  dst-address=10.1.1.0/24 pref-src=10.1.1.1 gateway=bridge1 gateway-status=bridge1 reachable distance=0 scope=10',
    ' 1 A S  dst-address=0.0.0.0/0 gateway=10.0.0.254 gateway-status=10.0.0.254 reachable via bridge1 distance=1 scope=30', ' 2   S  dst-address=10.7.0.0/16 gateway=10.0.0.9 distance=1'].join('\n');
  const s7 = build('R_A (10.0.0.1):\n### /ip route print detail\n' + v7); const r7 = s7.model.routes;
  assert.deepStrictEqual(r7.map((r) => [r.prefix + '/' + r.len + ' ' + r.proto, r.routingTable, r.vrf]),
    [['0.0.0.0/0 Static', 'main', 'main'], ['10.1.1.0/24 Direct', 'main', 'main'], ['10.2.0.0/16 OSPF', 'main', 'main'], ['10.6.0.0/16 BGP', 'vrf1', null]]);
  assert.deepStrictEqual(r7.find((r) => r.prefix === '10.2.0.0').nh, [{ ip: '10.0.0.2', ifc: 'ether1', vrf: 'main', vrfBasis: 'default' }, { ip: '10.0.0.6', ifc: 'ether2', vrf: 'main', vrfBasis: 'default' }]);
  assert.deepStrictEqual(r7.find((r) => r.prefix === '10.1.1.0').nh, [{ ip: null, ifc: 'bridge1', vrf: 'main', vrfBasis: 'interface' }]);
  const s6 = build('R_A (10.0.0.1):\n### /ip route print detail\n' + v6);
  assert.deepStrictEqual(s6.model.routes.map((r) => r.prefix + ' ' + r.proto), ['0.0.0.0 Static', '10.1.1.0 Direct']);
});
test('OSPF：鄰居列沒有 interface 時，用鄰居位址落在哪個本機網段決定；對得上的設備與 router-id', () => {
  const a = 'R_A (10.0.0.1):\n### /export terse\n/ip address add address=10.254.0.1/30 interface=ether48\n/routing id add id=1.1.1.1 name=main\n/routing ospf instance add name=default router-id=main\n'
    + '### /routing ospf neighbor print detail\n 0 instance=default area=backbone address=10.254.0.2 priority=1 router-id=2.2.2.2 state=Full state-changes=5\n';
  const b = 'R_B (10.0.0.2):\n### /export terse\n/ip address add address=10.254.0.2/30 interface=ether1\n/routing ospf instance add name=default router-id=2.2.2.2\n'
    + '### /routing ospf neighbor print detail\n 0 instance=default address=10.254.0.1 router-id=1.1.1.1 interface=ether1 state=Full\n';
  const s = build(a + b);
  assert.strictEqual(s.model.links.length, 0, 'OSPF-only adjacency must not create a direct topology edge');
  assert.strictEqual(s.model.ospfAdjacencies.length, 2);
  const adj = s.model.ospfAdjacencies.find((x) => x.dev === 'R_A');
  assert.ok(adj && adj.localEp === 'R_A|ether48' && adj.peerEp === 'R_B|ether1' && adj.reciprocal, JSON.stringify(adj));
  assert.deepStrictEqual(adj.src, [[1, 7]], 'OSPF adjacency retains source block and line');
  assert.strictEqual(S.query(s).ospfAdjacenciesOf('R_A').length, 1);
  assert.strictEqual(count(s, 'R02'), 0);
});
test('system resource：型號決定交換器／路由器', () => {
  const s = build('X (10.0.0.1):\n### /system resource print\n  uptime: 1d\n  version: 7.12.1 (stable)\n  board-name: CRS326-24G-2S+\n');
  assert.deepStrictEqual([s.model.devices[0].kind, s.model.devices[0].deviceType, s.model.devices[0].softwareVersion], ['switch', 'CRS326-24G-2S+', '7.12.1 (stable)']);
});
