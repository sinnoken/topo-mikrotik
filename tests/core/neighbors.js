// 鄰居（LLDP／MNDP／CDP）與 OSPF 鄰接
'use strict';
const assert = require('assert');
const { S, build, ids, count, iface, test } = require('../lib.js');
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
  assert.deepStrictEqual([k('SW_B').kind, k('SW_B').kindBasis, k('SW_B').deviceType], ['switch', 'board', 'CRS326-24G-2S+']);
  assert.deepStrictEqual([k('SW_B').manufacturer, k('SW_B').softwareVersion, k('SW_B').caps], ['mikrotik', '7.12 (stable)', 'bridge'], '鄰居回報的版本與功能保留為設備欄位');
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
test('鄰居：兩邊都沒有對端埠名（RouterOS 6）：單一鏈路可配對；多條平行鏈路不會被誤判為同一個介面對應到多個鄰居', () => {
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
  assert.ok(claims(a).every((l) => !/\?\(/.test(l.a + l.b)), '合併後不應有未知埠名的重複鏈路');
});
test('MNDP：多個鄰居代表共享 L2 廣播網域可達，不推論直連埠、雙向確認或 VLAN／聚合差異', () => {
  const s = build('A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n'
    + ' 1 interface=ether1 mac-address=AA:00:00:00:00:03 identity=C interface-name=ether8 discovered-by=mndp\n');
  assert.strictEqual(s.model.links.length, 2);
  assert.ok(s.model.links.every((l) => l.evidenceScope === 'broadcast-domain' && l.via.includes('mndp')));
  assert.ok(s.model.links.every((l) => !l.verified && !l.hearsay));
  assert.ok(s.model.links.every((l) => l.observations.length === 1 && l.observations[0].ifc === 'ether1'));
  assert.ok(s.model.interfaces.filter((i) => i.dev !== 'A').every((i) => i.hearsay), 'MNDP 回報的對端介面只能保留為單側觀察，不能當成設備本機收集的事實');
  assert.ok(s.model.links.every((l) => !l.vlanComparable && !l.vlansA.length && !l.vlansB.length));
  assert.strictEqual(count(s, 'K01'), 0);
  assert.strictEqual(count(s, 'K02'), 0, '一個廣播網域介面看到多個鄰居不是介面直連衝突');
  assert.strictEqual(count(s, 'K03'), 0);
  assert.strictEqual(count(s, 'V01'), 0, 'MNDP 域可達證據不能當作對端埠 VLAN 比對');
  const diff = S.compare(S.query(s), {
    schema: 'ssot-expected/1', links: [{ a: 'A ether1', b: 'B ether9' }], strictLinks: true,
  });
  assert.strictEqual(diff.items[0].status, 'different', 'MNDP 廣播網域可達不能滿足預期的直連介面鏈路');
  assert.ok(!diff.items.some((i) => i.status === 'unexpected'), 'strictLinks 不應把 MNDP 廣播網域可達列為額外直連');
  const noReportedPort = S.compare(S.query(s), {
    schema: 'ssot-expected/1', links: [{ a: 'A ether1', b: 'B ether7' }],
  });
  assert.strictEqual(noReportedPort.items[0].status, 'different', '遠端回報埠不同也應辨識到只有 MNDP 廣播網域可達');

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
  assert.strictEqual(iface(aggregates, 'A|ether1').lag, 'A|bonda');
  assert.strictEqual(iface(aggregates, 'B|ether9').lag, 'B|bondb');
  assert.strictEqual(count(aggregates, 'K03'), 0, 'MNDP 廣播網域可達不檢查兩端聚合成員');
  assert.strictEqual(count(aggregates, 'V01'), 0, 'MNDP 廣播網域可達不比較對端埠 VLAN');

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
test('MNDP 觀察不應把有 MAC 的介面誤當成已確認 LLDP 鄰接而排除終端清單', () => {
  const s = build('A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=AA:BB:CC:00:00:01 on-interface=ether1 bridge=bridge1 vid=10\n'
    + 'B (10.0.0.2):\n### /export terse\n/system identity set name=B\n');
  assert.strictEqual(iface(s, 'A|ether1').unknownPeer, true, 'MNDP 是廣播網域可達證據，不可代替 LLDP／CDP 埠鄰接');
  assert.ok(S.query(s).unknownPeers('A').some((r) => r.name === 'ether1'), '介面應保留在未知對端／終端清單');
  const a03 = s.findings.find((f) => f.id === 'A03');
  assert.ok(a03 && /ether1/.test(a03.message), '沒有 LLDP／CDP 鄰接的介面應出現在 A03');
  assert.strictEqual(s.model.links.find((l) => l.via.includes('mndp')).evidenceScope, 'broadcast-domain', 'MNDP edge 仍保留為廣播網域可達資訊');
});

test('OSPF 鄰接與 LLDP edge 分開儲存；OSPF 不新增拓樸 edge 或升格為直連', () => {
  const a = 'R_A (10.0.0.1):\n### /export terse\n/ip address add address=10.254.0.1/30 interface=ether48\n/routing id add id=1.1.1.1 name=main\n/routing ospf instance add name=default router-id=main\n'
    + '### /routing ospf neighbor print detail\n 0 instance=default area=backbone address=10.254.0.2 priority=1 router-id=2.2.2.2 state=Full state-changes=5\n'
    + '### /ip neighbor print detail\n 0 interface=ether48 identity=R_B address=10.254.0.2 mac-address=AA:BB:CC:00:00:02 interface-name=ether1 discovered-by=lldp\n';
  const b = 'R_B (10.0.0.2):\n### /export terse\n/ip address add address=10.254.0.2/30 interface=ether1\n/routing ospf instance add name=default router-id=2.2.2.2\n'
    + '### /routing ospf neighbor print detail\n 0 instance=default address=10.254.0.1 router-id=1.1.1.1 interface=ether1 state=Full\n'
    + '### /ip neighbor print detail\n 0 interface=ether1 identity=R_A address=10.254.0.1 mac-address=AA:BB:CC:00:00:01 interface-name=ether48 discovered-by=lldp\n';
  const s = build(a + b);
  assert.strictEqual(s.model.links.length, 1);
  const l = s.model.links[0];
  assert.strictEqual(l.key, 'R_A|ether48~R_B|ether1');
  assert.deepStrictEqual(l.via, ['lldp']);
  assert.strictEqual(s.model.ospfAdjacencies.length, 2);
  assert.ok(s.model.ospfAdjacencies.every((x) => x.reciprocal));
  assert.strictEqual(s.meta.stats.links, 1, '拓樸 edge 數量只計入 L2 direct link');
});
