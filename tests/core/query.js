// 查詢、VLAN 區塊、路由追蹤、finding 穩定鍵、Q.findingDevice
'use strict';
const assert = require('assert');
const { S, read, build, ids, gen, test, NB, sampleSnap } = require('../lib.js');
// ------------------------------------------------------------------ 查詢、追蹤、比對
test('查詢：MAC、IP、VLAN、設備、介面描述', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  const srv = s.model.macs.find((m) => m.vendor === 'Dell' && m.edge.length === 1);
  const mac = Q.findMac(S.keys.macPretty(srv.mac));
  assert.ok(mac.found && mac.edge.length === 1 && mac.ips.length === 1);
  assert.ok(Q.findMac('aa:aa:aa:aa:aa:aa').found === false);
  const ip = Q.findIp('10.1.20.11');
  assert.ok(ip.locations.length >= 1, JSON.stringify(ip.locations));
  // 範例另有 ACC_11 的 VLAN 40 刻意設在同一網段（A07），所以只檢查兩台核心的 VLAN 20 都在
  assert.ok(['TPE_CORE_RT_01|vlan20', 'TPE_CORE_RT_02|vlan20'].every((ep) => ip.subnets.some((x) => x.ep === ep)), JSON.stringify(ip.subnets));
  assert.ok(Q.vlan(30).partial.length === 1);
  assert.strictEqual(Q.search('core_rt')[0].type, 'device');
  assert.ok(Q.search('to TPE_ACC_SW_01').some((r) => r.type === 'interface'));
});
test('VLAN 區塊：同一個 VLAN ID 依承載此 VLAN 的鏈路分成不相連區塊，MNDP 不算相連', () => {
  const sw = (name, ip, nb) => [`${name} (${ip}):`, NB(nb), '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes',
    '/interface bridge port add bridge=bridge1 interface=ether1', '/interface bridge port add bridge=bridge1 interface=ether2',
    '/interface bridge vlan add bridge=bridge1 tagged=ether1 untagged=ether2 vlan-ids=10'].join('\n');
  const Q = S.query(build([
    sw('SW_A', '10.0.0.1', [' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=SW_B interface-name=ether1 discovered-by=lldp']),
    sw('SW_B', '10.0.0.2', [' 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=SW_A interface-name=ether1 discovered-by=lldp']),
    sw('SW_C', '10.0.0.3', [' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=SW_B interface-name=ether2 discovered-by=mndp']),
  ].join('\n')));
  const v = Q.vlan(10);
  assert.deepStrictEqual(v.devices, ['SW_A', 'SW_B', 'SW_C'], '不指定區塊時維持整體結果');
  assert.deepStrictEqual(v.domains.map((d) => [d.key, d.devices]), [['10@SW_A', ['SW_A', 'SW_B']], ['10@SW_C', ['SW_C']]], 'SW_C 只有 MNDP 看到 SW_B，不算承載 VLAN 10');
  const c = Q.vlan(10, '10@SW_C');
  assert.deepStrictEqual([c.domain, c.devices, c.carry, c.entries.map((e) => e.dev)], ['10@SW_C', ['SW_C'], [], ['SW_C']]);
  assert.strictEqual(Q.vlan(10, '10@SW_A').carry.length, 1);
  assert.strictEqual(Q.vlan(10, '10@NOPE').domain, null, '不存在的區塊回到整體結果');
  assert.ok(Q.search('10').find((r) => r.type === 'vlan').sub.includes('2 個不相連區塊'));
  assert.deepStrictEqual(Q.vlan(99).domains, []);
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
test('遞迴路由：gateway 是對端 loopback 時沿路由表解析；R01 只提醒解析後仍到不了已知設備的下一跳', () => {
  const a = 'R_A (10.0.0.1):\n### /export terse\n/ip address add address=10.254.0.1/30 interface=ether48\n/ip address add address=10.9.9.1/32 interface=lo\n'
    + '### /ip route print detail\nFlags: A - ACTIVE; s - STATIC\n'
    + ' 0 As dst-address=172.16.0.0/16 gateway=10.99.0.2 immediate-gw=10.254.0.2%ether48 distance=1\n'
    + ' 1 As dst-address=10.99.0.0/24 gateway=10.254.0.2 distance=1\n'
    + ' 2 As dst-address=172.17.0.0/16 gateway=10.77.0.2 distance=1\n'
    + ' 3 As dst-address=172.18.0.0/16 gateway=10.88.0.2 distance=1\n'
    + ' 4 As dst-address=10.88.0.0/24 gateway=10.88.0.5 distance=1\n'
    + ' 5 As dst-address=10.254.0.0/30 gateway=ether48 distance=0\n';
  const b = 'R_B (10.0.0.2):\n### /export terse\n/ip address add address=10.254.0.2/30 interface=ether1\n';
  const s = build(a + b); const m = s.model;
  const r01 = s.findings.filter((f) => f.id === 'R01');
  const text = r01.map((f) => f.message).join(' ');
  assert.ok(!text.includes('10.99.0.2'), '10.99.0.2 經 10.99.0.0/24 → 10.254.0.2 解析到 R_B，不應提醒');
  assert.ok(text.includes('10.77.0.2'), '沒有任何路由可解析的下一跳要提醒');
  assert.ok(text.includes('10.88.0.2'), '遞迴迴圈或落在未知位址的下一跳要提醒');
  const rs = (ip, routes) => S.check.resolveNextHop(routes, ip, (x) => (x === '10.254.0.2' ? 'R_B' : null));
  const rt = m.routes.filter((r) => r.dev === 'R_A');
  const ok = rs('10.99.0.2', rt); assert.ok(ok.some((x) => x.status === 'known' && x.owner === 'R_B'), JSON.stringify(ok));
  assert.deepStrictEqual(rs('10.99.0.2', rt), rs('10.99.0.2', rt), '相同輸入結果相同');
  const loop = [{ prefix: '10.0.0.0', len: 8, nh: [{ ip: '10.0.0.9', ifc: null }] }];
  assert.strictEqual(rs('10.0.0.9', loop)[0].status, 'unresolved', '閘道只能靠涵蓋自己的路由解析：無法到達（R01），不是多條路由的迴圈（R03）');
  const pair = [{ prefix: '10.97.0.0', len: 16, nh: [{ ip: '10.96.0.1', ifc: null }] }, { prefix: '10.96.0.0', len: 16, nh: [{ ip: '10.97.0.1', ifc: null }] }];
  assert.strictEqual(rs('10.96.0.1', pair)[0].status, 'loop', '兩條路由互相指向才是迴圈');
  const Q = S.query(s); const t = S.trace(Q, '10.254.0.1', '172.16.1.1');
  assert.ok(t.hops.some((h) => h.next.some((n) => n.dev === 'R_B' && /遞迴解析/.test(n.note || ''))), JSON.stringify(t.hops));
});

test('finding 穩定鍵：由 id 與排序後的 entities 組成，不受訊息、證據與 entities 順序影響；範例資料內不碰撞', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  const keys = s.findings.map(Q.findingKey);
  assert.strictEqual(new Set(keys).size, keys.length, '範例資料的每筆 finding 鍵都不同');
  const f = { id: 'K02', message: 'x', evidence: [{ block: 1, line: 2 }], entities: [{ type: 'link', key: 'B|e1~C|e2' }, { type: 'interface', key: 'B|e1' }] };
  const g = { id: 'K02', message: '不同的訊息', evidence: [], entities: [{ type: 'interface', key: 'B|e1' }, { type: 'link', key: 'B|e1~C|e2' }] };
  assert.strictEqual(Q.findingKey(f), Q.findingKey(g));
  assert.strictEqual(Q.findingKey(f), '["K02","interface:B|e1","link:B|e1~C|e2"]');
  assert.notStrictEqual(Q.findingKey(f), Q.findingKey(Object.assign({}, f, { id: 'K01' })));
  assert.strictEqual(S.query.findingKey(f), Q.findingKey(f));
  // 同一份輸入建兩次（行號相同）、或加了註解讓行號改變：鍵都一樣
  const shifted = build('# 多一行\n' + read('samples/sample-bundle.txt'));
  assert.deepStrictEqual(shifted.findings.map(Q.findingKey).sort(), keys.slice().sort());
});

test('Q.findingDevice：依實體找到所屬設備（規則、介面、鏈路一端）；對不到時為 null', () => {
  const snap = sampleSnap(); const Q = S.query(snap);
  const f01 = snap.findings.find((f) => f.id === 'F01');
  assert.strictEqual(Q.findingDevice(f01), 'TPE_CORE_RT_01');
  assert.strictEqual(Q.findingDevice({ entities: f01.entities.filter((e) => e.type === 'rule') }), 'TPE_CORE_RT_01', '只有規則實體也對得到');
  assert.strictEqual(Q.findingDevice({ entities: [] }), null);
  assert.strictEqual(Q.findingDevice({ entities: [{ type: 'mac', key: '000000000000' }] }), null);
});
