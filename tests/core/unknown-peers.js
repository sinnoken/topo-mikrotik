// 未知對端與終端位置
'use strict';
const assert = require('assert');
const { S, read, build, count, iface, test } = require('../lib.js');
// ------------------------------------------------------------------ 未知對端
test('未知對端：有 MAC、沒有 LLDP 鄰居的終端埠才會標記；有鄰居的主機埠與上行聚合埠不標', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  assert.strictEqual(iface(s, 'TPE_ACC_SW_01|bond1').unknownPeer, false, '上行聚合埠不是未知對端');
  assert.strictEqual(iface(s, 'TPE_ACC_SW_01|ether1').unknownPeer, false, '伺服器埠有 LLDP 鄰居');
  assert.strictEqual(iface(s, 'TPE_ACC_SW_01|ether1').edge, true);
  const rows = Q.unknownPeers('TPE_ACC_SW_01');
  assert.strictEqual(rows.length, 8);
  assert.ok(rows.every((r) => r.macs.length === 1 && /^10\.1\.30\./.test(r.macs[0].ips[0]) && r.macs[0].vendor), '應帶有 ARP 的 IP 與 OUI 廠商');
  assert.ok(!Q.unknownDevices().includes('TPE_ACC_SW_09'), '沒有 MAC 表的設備不會有未知對端');
});
test('未知對端：連到已收集主機的介面仍是終端位置，不當作網路設備上行埠排除', () => {
  const mac = 'AA:BB:CC:00:00:01';
  const text = 'SW_A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:BB:CC:00:00:02 identity=HOST_B platform=Linux interface-name=eth0 system-caps=station-only system-caps-enabled=station-only\n'
    + '### /interface bridge host print detail\n'
    + ` 0 D mac-address=${mac} on-interface=ether1 bridge=bridge1 vid=10\n`
    + 'HOST_B (10.0.0.2):\n### /interface print detail\n 0 R name=eth0 type=ether\n';
  const s = build(text, { profile: { id: 'test-host', classify: [{ match: '^HOST_B$', kind: 'host' }] } });
  assert.strictEqual(s.model.devices.find((d) => d.key === 'HOST_B').kind, 'host');
  assert.strictEqual(iface(s, 'SW_A|ether1').edge, true);
});
test('清單：Q.inventory 的列與計數一致，且與基準統計對得上', () => {
  const s = build(read('samples/sample-bundle.txt')); const { rows, counts: C } = S.query(s).inventory();
  const st = s.meta.stats;
  assert.deepStrictEqual([C.devices, C.interfaces, C.macs, C.vlans], [st.devices, st.interfaces, st.macs, st.vlans]);
  assert.strictEqual(new Set(rows.ips.map((r) => r.key)).size, rows.ips.length, 'IP 清單必須去重複（每個 VRF 的每個 IP 一列）');
  assert.strictEqual(C.arpIps, new Set(s.model.arps.map((a) => S.keys.inVrf(a.ip, a.vrf))).size);
  assert.strictEqual(new Set(rows.macs.map((r) => r.mac)).size, C.macs);
  assert.strictEqual(C.endpointPorts, new Set(rows.endpoints.map((e) => e.key)).size, '終端位置數應依清單中的介面位置計算，包含 Wi-Fi MAC 觀察位置');
  assert.ok(rows.endpoints.every((e) => e.end === true) && rows.devices.every((d) => !d.end));
  assert.deepStrictEqual(S.query(s).inventory().counts, C, '相同輸入結果相同');
});
test('可追溯：MAC、ARP 與已收集設備的介面都帶來源', () => {
  const s = build(read('samples/sample-bundle.txt')); const m = s.model;
  assert.ok(m.macs.every((x) => x.src.length && x.src.every(([b, l]) => b != null && l > 0)), '每個 MAC 都要有來源');
  assert.ok(m.arps.every((a) => a.src.length === 1 && a.src[0][1] > 0), '每筆 ARP 都要有來源');
  const collected = new Set(m.devices.filter((d) => d.collected).map((d) => d.key));
  const lost = m.interfaces.filter((i) => collected.has(i.dev) && !i.hearsay && !i.src.length).map((i) => i.key);
  assert.deepStrictEqual(lost, [], '已收集設備的介面不可沒有來源');
  [['devices', m.devices], ['interfaces', m.interfaces], ['vlans', m.vlans]].forEach(([name, list]) => list.forEach((x) => {
    assert.ok(x.src.length ? x.srcNone === null : typeof x.srcNone === 'string', `${name} 沒有來源時必須說明原因：${x.key || x.dev}`);
  }));
  assert.ok(!m.interfaces.some((i) => i.srcNone === 'unrecorded'), '不可有「應有來源卻沒記錄」的介面');
});
test('未知對端：學到多個 MAC 的介面不列為終端', () => {
  const mac = (n) => ` ${n} D mac-address=AA:BB:CC:00:00:0${n} on-interface=ether5 bridge=bridge1 vid=30 age=3s`;
  const s = build(['SW_A (10.0.0.1):', '### /interface bridge host print detail', mac(1), mac(2), mac(3)].join('\n'));
  const rows = S.query(s).unknownPeers('SW_A');
  assert.strictEqual(rows.length, 0, '學到多個 MAC 的介面不列為終端');
  assert.strictEqual(iface(s, 'SW_A|ether5').edge, false);
});
test('未知對端：Wi-Fi 介面不列為終端，但每個 MAC 觀察位置列入終端清單且不觸發 A02', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING\n 0 R name="wifi1" type="wifi"\n 1 R name="wifi2" type="wifi"\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=AA:BB:CC:00:00:01 on-interface=wifi1 bridge=bridge1 vid=10\n'
    + ' 1 D mac-address=AA:BB:CC:00:00:01 on-interface=wifi2 bridge=bridge1 vid=10\n'
    + ' 2 D mac-address=AA:BB:CC:00:00:02 on-interface=ether1 bridge=bridge1 vid=10\n');
  assert.strictEqual(iface(s, 'SW_A|wifi1').macs.length, 1);
  assert.strictEqual(iface(s, 'SW_A|wifi1').edge, false);
  assert.strictEqual(iface(s, 'SW_A|ether1').edge, true, '一般單 MAC 介面仍列為終端');
  assert.deepStrictEqual(S.query(s).unknownPeers('SW_A').map((p) => p.name), ['ether1']);
  assert.strictEqual(count(s, 'A02'), 0, '重複出現在 Wi-Fi 介面的 MAC 不觸發 A02');
  const Q = S.query(s);
  assert.deepStrictEqual(Q.visualUnknownPeers('SW_A').filter((p) => p.visualOnly).map((p) => p.name), ['wifi1', 'wifi2']);
  const wifiEndpoints = Q.inventory().rows.endpoints.filter((p) => p.wifi);
  assert.deepStrictEqual(wifiEndpoints.map((p) => [p.ifc, p.mac]), [
    ['wifi1', 'AABBCC000001'], ['wifi2', 'AABBCC000001'],
  ], 'Wi-Fi 每個 MAC 觀察位置都應列入終端清單');
});
test('查詢的 Wi-Fi 區段與終端埠共用 isVirtualIfc：有 rawType 時依類型，不再以名稱排除', () => {
  // rawType=wifi 的介面即使名稱以 vlan 開頭也是無線介面（舊版查詢以名稱排除它）
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING\n 0 R name="vlan30-guest" type="wifi"\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=AA:BB:CC:00:00:01 on-interface=vlan30-guest bridge=bridge1 vid=30\n');
  const i = iface(s, 'SW_A|vlan30-guest');
  assert.strictEqual(i.type, 'wireless');
  assert.strictEqual(S.infer.isVirtualIfc(i), false, '序列化後的介面也能直接套用');
  assert.deepStrictEqual(S.query(s).visualUnknownPeers('SW_A').filter((p) => p.visualOnly).map((p) => p.name), ['vlan30-guest']);
});

test('未知對端不進基準的設備、鏈路（只是檢視）', () => {
  const s = build(read('samples/sample-bundle.txt'));
  assert.ok(!s.model.devices.some((d) => d.key.startsWith('?')));
});
