// 其他 print（bridge host、bridge vlan、interface、ARP、路由、OSPF、system resource）
'use strict';
const assert = require('assert');
const { S, read, build, ids, count, iface, addrs, test, i03 } = require('../lib.js');
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
test('detail：引號值在行尾斷開時接上下一行（斷在 - 或 / 之後直接接，其他補一個空白），之後的欄位照樣讀到', () => {
  const rowsOf = (text) => {
    const b = S.readers.readAll([{ name: 'n.txt', text }]).blocks.find((x) => x.command);
    return S.adapters.mikrotikRows(b, () => {}).map((r) => r.kv);
  };
  // 實機輸出（tests/fixtures/real/7.25.1-neighbor-wrap.txt）：system-description 斷在「RBwAPGR-」之後
  const text = read('tests/fixtures/real/7.25.1-neighbor-wrap.txt');
  const [kv] = rowsOf(text);
  assert.deepStrictEqual([kv.board, kv['system-description'], kv['system-caps'], kv['system-caps-enabled'], kv['discovered-by'], kv['interface-name']],
    ['RBwAPGR-5HacD2HnD', 'MikroTik RouterOS 7.25.1 2026-11-02 12:39:53 RBwAPGR-5HacD2HnD', 'bridge,router', 'bridge,router', 'lldp,mndp', 'bridge/ether1']);
  const s = S.build([{ name: 'n.txt', text }], { now: '2026-01-01T00:00:00Z' });
  assert.deepStrictEqual([i03(s), ids(s).filter((x) => x === 'I01')], [[], []], JSON.stringify(i03(s).map((f) => f.message)));
  // 手寫：在空白處斷開（RouterOS 吃掉那個空白，接上時補回）、斷在 / 之後、引號內有跳脫的引號；下一列不會被併進來
  const hand = rowsOf(['SW_A (10.0.0.1):', '### /ip neighbor print detail without-paging',
    ' 0 interface=ether1 identity="core \\"A\\" room" mac-address=AA:BB:CC:00:00:01',
    '   system-description="MikroTik RouterOS 7.25.1 (stable)',
    '      CRS326-24G-2S+" interface-name="bridge/',
    '      ether3" discovered-by=lldp',
    ' 1 interface=ether2 identity="B" mac-address=AA:BB:CC:00:00:02 discovered-by=mndp'].join('\n'));
  assert.deepStrictEqual(hand.map((x) => [x.identity, x['system-description'], x['interface-name'], x['discovered-by']]),
    [['core "A" room', 'MikroTik RouterOS 7.25.1 (stable) CRS326-24G-2S+', 'bridge/ether3', 'lldp'], ['B', undefined, undefined, 'mndp']]);
  // 引號一直沒有關上：下一個列首不會被吞進去
  const broken = rowsOf(['SW_A (10.0.0.1):', '### /ip neighbor print detail without-paging',
    ' 0 interface=ether1 identity="A mac-address=AA:BB:CC:00:00:01', ' 1 interface=ether2 identity="B" mac-address=AA:BB:CC:00:00:02'].join('\n'));
  assert.deepStrictEqual(broken.map((x) => x.interface), ['ether1', 'ether2']);
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
test('路由：RouterOS 7（無序號）、ECMP（gateway=a,b）、連接路由、非作用中保留（active false，Q.routesOf 不給）、停用略過、其他路由表保留（沒有 VRF 設定時 vrf 為 null）；RouterOS 6（序號、大寫旗標、pref-src）', () => {
  const v7 = ['Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC, o - OSPF',
    ' DAc dst-address=10.1.1.0/24 routing-table=main gateway=bridge1 immediate-gw=bridge1 distance=0 scope=10',
    ' DAo+ dst-address=10.2.0.0/16 routing-table=main gateway=10.0.0.2,10.0.0.6 immediate-gw=10.0.0.2%ether1,10.0.0.6%ether2 distance=110 scope=20',
    ' As  dst-address=0.0.0.0/0 routing-table=main gateway=10.0.0.254 immediate-gw=10.0.0.254%ether9 distance=1 scope=30',
    '  s  dst-address=10.5.0.0/16 routing-table=main gateway=10.0.0.9 distance=1', ' DAb dst-address=10.6.0.0/16 routing-table=vrf1 gateway=10.0.0.9 distance=20',
    ' Xs  dst-address=10.8.0.0/16 routing-table=main gateway=10.0.0.9 distance=1'].join('\n');
  const v6 = ['Flags: X - disabled, A - active, D - dynamic, C - connect, S - static, o - ospf', ' 0 ADC  dst-address=10.1.1.0/24 pref-src=10.1.1.1 gateway=bridge1 gateway-status=bridge1 reachable distance=0 scope=10',
    ' 1 A S  dst-address=0.0.0.0/0 gateway=10.0.0.254 gateway-status=10.0.0.254 reachable via bridge1 distance=1 scope=30', ' 2   S  dst-address=10.7.0.0/16 gateway=10.0.0.9 distance=1'].join('\n');
  const s7 = build('R_A (10.0.0.1):\n### /ip route print detail\n' + v7); const r7 = s7.model.routes;
  assert.deepStrictEqual(r7.map((r) => [r.prefix + '/' + r.len + ' ' + r.proto, r.routingTable, r.vrf, r.active]),
    [['0.0.0.0/0 Static', 'main', 'main', true], ['10.1.1.0/24 Direct', 'main', 'main', true], ['10.2.0.0/16 OSPF', 'main', 'main', true],
      ['10.5.0.0/16 Static', 'main', 'main', false], ['10.6.0.0/16 BGP', 'vrf1', null, true]]);
  const Q7 = S.query(s7);
  assert.deepStrictEqual([Q7.routesOf('R_A').length, Q7.routesOf('R_A', 'main').length, Q7.routesInTable('R_A', 'main').length, Q7.allRoutesOf('R_A').length], [4, 3, 3, 5]);
  const sgRoutes = Q7.subnetGraph({ routes: true }).routes.map((r) => r.prefix);
  assert.ok(sgRoutes.includes('0.0.0.0') && !sgRoutes.includes('10.5.0.0'), 'L3 圖的路由只有作用中的：' + sgRoutes.join(','));
  assert.deepStrictEqual(i03(s7).map((x) => x.message), [], '停用的路由依格式略過');
  assert.deepStrictEqual(r7.find((r) => r.prefix === '10.2.0.0').nh, [{ ip: '10.0.0.2', ifc: 'ether1', vrf: 'main', vrfBasis: 'default' }, { ip: '10.0.0.6', ifc: 'ether2', vrf: 'main', vrfBasis: 'default' }]);
  assert.deepStrictEqual(r7.find((r) => r.prefix === '10.1.1.0').nh, [{ ip: null, ifc: 'bridge1', vrf: 'main', vrfBasis: 'interface' }]);
  const s6 = build('R_A (10.0.0.1):\n### /ip route print detail\n' + v6);
  assert.deepStrictEqual(s6.model.routes.map((r) => r.prefix + ' ' + r.proto + ' ' + r.active), ['0.0.0.0 Static true', '10.1.1.0 Direct true', '10.7.0.0 Static false']);
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
// ------------------------------------------------------------------ 實機輸出的折行（tests/fixtures/real/7.25.1-RB3011UiAS.txt、7.24.4-RB5009UG+S+.txt、7.25.1-hAPax2.txt）
const realSnap = (f) => S.build([{ name: f, text: read(`tests/fixtures/real/${f}`) }], { now: '2026-01-01T00:00:00Z' });
const rowsIn = (text, cmd) => S.adapters.mikrotikRows(S.readers.readAll([{ name: 'n.txt', text }]).blocks.find((x) => x.command && cmd.test(x.command)), () => {});
test('detail：沒有引號的清單值在逗號後折行、下一行縮排較深時接上；縮排與欄位對齊的下一行是新欄位，下一列不併入', () => {
  const real = rowsIn(read('tests/fixtures/real/7.24.4-RB5009UG+S+.txt'), /neighbor/).find((r) => r.kv['mac-address'] === 'E0:D5:5E:00:00:38').kv;
  assert.deepStrictEqual([real['system-caps'], real['system-caps-enabled'], real['discovered-by']],
    ['repeater,bridge,wlan-ap,router,telephone,docsis-cable-device,station-only', 'bridge,router', 'lldp']);
  assert.deepStrictEqual(i03(realSnap('7.24.4-RB5009UG+S+.txt')).map((f) => f.message), []);
  const hand = rowsIn(['SW_A (10.0.0.1):', '### /ip neighbor print detail without-paging',
    ' 0 interface=ether1 identity="A" mac-address=AA:BB:CC:00:00:01 system-caps=bridge,router,',
    '      wlan-ap discovered-by=lldp',
    ' 1 interface=ether2 identity="B" mac-address=AA:BB:CC:00:00:02 system-caps=bridge,',
    ' 2 interface=ether3 identity="C" mac-address=AA:BB:CC:00:00:03',
    '   system-caps=bridge,',
    '   system-caps-enabled=bridge'].join('\n'), /neighbor/).map((r) => [r.kv.identity, r.kv['system-caps'], r.kv['system-caps-enabled'], r.kv['discovered-by']]);
  assert.deepStrictEqual(hand, [['A', 'bridge,router,wlan-ap', undefined, 'lldp'], ['B', 'bridge,', undefined, undefined], ['C', 'bridge,', 'bridge', undefined]]);
});
test('detail：註解依終端寬度硬切的下一行接回註解（不補空白）；CAPsMAN 的多行說明與欄位前獨立的 ;;; 屬於同一列', () => {
  const desc = (s, k) => iface(s, k).desc;
  const cap = realSnap('7.25.1-hAPax2.txt');
  const capsman = 'managed by CAPsMAN 6C:3B:6B:00:00:05%bridge, traffic processing on CAP; mode: AP, SSID: SSID-001, channel: 2462/ax';
  assert.deepStrictEqual([desc(cap, 'DEV-004|wifi1'), desc(cap, 'DEV-004|wifi2')], [capsman, capsman + '; comment-054']);
  assert.deepStrictEqual(['wifi1', 'wifi2'].map((n) => iface(cap, `DEV-004|${n}`).status), ['up', 'up']);
  const rb = realSnap('7.25.1-RB3011UiAS.txt');
  const op = 'operated by CAP CC:2D:E0:00:00:99%bridge, traffic processing on CAP';
  assert.deepStrictEqual([desc(rb, 'DEV-006|cap1-2g'), desc(rb, 'DEV-006|cap1-2g-v-cc2de0000032')], [op, op + '; reselect-time/reselect-interval ignored for slave interface']);
  const br = realSnap('7.24.4-RB5009UG+S+.txt');
  assert.strictEqual(desc(br, 'DEV-007|bridge'), '0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, A000, B000, C000, D000, E000, F000');
  [cap, rb, br].forEach((s) => assert.deepStrictEqual(i03(s).map((f) => f.message), []));
  // 縮排沒到註解文字的欄位：不是註解的續行，留給 I03；欄位之後的獨立 ;;; 屬於下一列
  const s = build(['SW_A (10.0.0.1):', '### /interface print detail', 'Flags: X - DISABLED; R - RUNNING',
    ' 0  R  ;;; uplink', '    junk', '       name="ether1" type="ether" mtu=1500', '       ;;; next one', ' 1  R  name="ether2" type="ether" mtu=1500'].join('\n'));
  assert.deepStrictEqual([desc(s, 'SW_A|ether1'), desc(s, 'SW_A|ether2')], ['uplink', 'next one']);
  assert.deepStrictEqual(i03(s).map((f) => f.evidence.map((e) => e.text)), [['junk']]);
});
test('路由：RouterOS 7 的 blackhole 折到續行行首仍是黑洞路由（不是經 gateway 轉送）；+（ECMP）算旗標；註解裡的 blackhole 字樣不算', () => {
  const s = realSnap('7.25.1-RB3011UiAS.txt');
  const r = (p) => s.model.routes.find((x) => x.prefix + '/' + x.len === p);
  assert.deepStrictEqual([r('10.0.0.0/8').blackhole, r('10.0.0.0/8').nh, r('10.0.0.0/8').proto, r('10.0.0.0/8').active], [true, [], 'Blackhole', true]);
  assert.deepStrictEqual([r('11.4.98.107/32').blackhole, r('10.101.92.242/32').proto, r('172.17.168.0/24').proto], [true, 'OSPF', 'Direct']);
  assert.strictEqual(r('11.4.74.1/32'), undefined, '停用的路由略過');
  assert.deepStrictEqual(i03(s).map((f) => f.message), []);
  const c = build(['R_A (10.0.0.1):', '### /ip route print detail', 'Flags: D - DYNAMIC; X - DISABLED, A - ACTIVE; s - STATIC',
    ' 0  As  ;;; not a blackhole', '         dst-address=0.0.0.0/0 routing-table=main gateway=10.0.0.254 immediate-gw=10.0.0.254%ether1 distance=1'].join('\n'));
  assert.deepStrictEqual(c.model.routes.map((x) => [x.blackhole || false, x.nh.map((n) => n.ip)]), [[false, ['10.0.0.254']]]);
});
test('OSPFv3：鄰居位址是 IPv6 link-local，對端設備依 router-id 找；對端介面取對端回報的那一筆；不把 link-local 當成 IPv4 位址或網段', () => {
  const nbr = (rows) => ['### /routing ospf neighbor print detail without-paging', 'Flags: D - DYNAMIC', ...rows];
  const a = ['R_A (10.0.0.1):', '### /export terse', '/ip address add address=10.0.0.1/24 interface=bridge', '/routing ospf instance add name=v2inst router-id=1.1.1.1',
    ...nbr(['0 D instance=v2inst area=backbone_v2 interface=bridge address=10.0.0.2', '    router-id=2.2.2.2 state="Full"', '',
      '1 D instance=v3inst area=backbone_v3 interface=bridge', '    address=fe80::200:ff:fe00:2 priority=1 router-id=2.2.2.2', '    dr=2.2.2.2 bdr=1.1.1.1 state="Full"', '',
      '2 D instance=v3inst area=backbone_v3', '    address=fe80::9 router-id=9.9.9.9 state="Full"'])];
  const b = ['R_B (10.0.0.2):', '### /export terse', '/ip address add address=10.0.0.2/24 interface=ether1', '/routing ospf instance add name=v2inst router-id=2.2.2.2',
    ...nbr(['0 D instance=v2inst interface=ether1 address=10.0.0.1 router-id=1.1.1.1 state="Full"',
      '1 D instance=v3inst interface=ether1', '    address=fe80::200:ff:fe00:1 router-id=1.1.1.1 state="Full"'])];
  const s = build(a.concat(b).join('\n'));
  assert.deepStrictEqual(i03(s).map((f) => f.message), []);
  const adj = s.model.ospfAdjacencies.map((x) => [x.dev, x.localEp, x.peerDev, x.peerEp, x.peerIp, x.peerId, x.reciprocal]);
  assert.deepStrictEqual(adj, [
    ['R_A', 'R_A|?(ospffe80::9)', '9.9.9.9', '9.9.9.9|fe80::9', 'fe80::9', '9.9.9.9', false],
    ['R_A', 'R_A|bridge', 'R_B', 'R_B|ether1', '10.0.0.2', '2.2.2.2', true],
    ['R_A', 'R_A|bridge', 'R_B', 'R_B|ether1', 'fe80::200:ff:fe00:2', '2.2.2.2', true],
    ['R_B', 'R_B|ether1', 'R_A', 'R_A|bridge', '10.0.0.1', '1.1.1.1', true],
    ['R_B', 'R_B|ether1', 'R_A', 'R_A|bridge', 'fe80::200:ff:fe00:1', '1.1.1.1', true]]);
  assert.ok(!s.model.ipAddresses.some((x) => /:/.test(x.address)), '鄰居的 link-local 不可成為 IPv4 位址：' + s.model.ipAddresses.map((x) => x.address).join(','));
  assert.ok(!s.model.interfaces.some((i) => i.dev === 'R_B' && /fe80/.test(i.name)), '對端已回報時不建立 link-local 命名的介面');
  assert.deepStrictEqual(s.findings.filter((f) => f.id === 'R02').map((f) => f.message.includes('9.9.9.9（fe80::9）')), [true]);
  // 實機輸出：OSPFv2 與 v3 的列都成為鄰接
  const real = realSnap('7.25.1-RB3011UiAS.txt');
  assert.deepStrictEqual(real.model.ospfAdjacencies.map((x) => x.peerIp).sort(), ['192.168.0.6', 'fe80::2ec8:1bff:fe00:6']);
});
test('monitor：最前面的 ;;; 是各項目的註解（不是 monitor 欄位），讀到 RSTP 欄位時列為可忽略；欄式輸出被折斷時不產生錯誤的埠狀態，折出去的行留給 I03', () => {
  const rb = realSnap('7.25.1-RB3011UiAS.txt');
  assert.deepStrictEqual(['ether2', 'ether1-wan', 'ether3'].map((n) => { const i = iface(rb, `DEV-006|${n}`); return i && i.stp ? i.stp.role : null; }), ['root-port', 'designated-port', null]);
  const br = realSnap('7.24.4-RB5009UG+S+.txt');
  assert.strictEqual(br.model.devices.find((d) => d.key === 'DEV-007').stp.isRoot, true);
  [rb, br].forEach((s) => assert.deepStrictEqual(i03(s).map((f) => f.message), []));
  // 折行的形狀是推測的（這份收集檔的 monitor 沒有折行）：折出去的值沒有「key:」，不併入任何一欄
  const wrapped = build(['SW_A (10.0.0.1):', '### /interface bridge port monitor [find] once',
    '               interface: ether1                   ether2', '                          ether3',
    '                    role: root-port                designated-port', '                          designated-port'].join('\n'));
  assert.deepStrictEqual(['ether1', 'ether2', 'ether3'].map((n) => { const i = iface(wrapped, `SW_A|${n}`); return i && i.stp ? i.stp.role : null; }), ['root-port', 'designated-port', null]);
  assert.deepStrictEqual(i03(wrapped).map((f) => f.evidence.map((e) => e.text)), [['ether3', 'designated-port']]);
});
test('system resource：型號決定交換器／路由器', () => {
  const s = build('X (10.0.0.1):\n### /system resource print\n  uptime: 1d\n  version: 7.12.1 (stable)\n  board-name: CRS326-24G-2S+\n');
  assert.deepStrictEqual([s.model.devices[0].kind, s.model.devices[0].deviceType, s.model.devices[0].softwareVersion], ['switch', 'CRS326-24G-2S+', '7.12.1 (stable)']);
});
