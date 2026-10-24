// 查詢、VLAN 區塊、路由追蹤、finding 穩定鍵（含 facet）、Q.findingDevice
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
// ------------------------------------------------------------------ finding 的 facet：同一組 id＋實體會產生多筆的規則，以 facet 區分（ADR-003）
// 測試資料依 RouterOS 手冊的欄位撰寫，不是實機擷取

// 兩台交換器（SW_A、SW_B）各自的 /export；linked 時兩台以 ether1 互相 LLDP（同一個 VLAN 區塊）
const pair = (a, b, linked = true, names = ['SW_A', 'SW_B']) => {
  const sw = (name, ip, peer, lines, mac) => [`${name} (${ip}):`,
    NB(linked ? [` 0 interface=ether1 mac-address=AA:00:00:00:00:0${mac} identity=${peer} interface-name=ether1 discovered-by=lldp`] : []),
    '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge port add bridge=bridge1 interface=ether1',
    '/interface bridge vlan add bridge=bridge1 tagged=ether1,bridge1 vlan-ids=10', ...lines].join('\n');
  return build([sw(names[0], '10.0.0.1', names[1], a, 2), sw(names[1], '10.0.0.2', names[0], b, 1)].join('\n'));
};
const VIF = (name, id, extra = '') => `/interface vlan add interface=bridge1 name=${name} vlan-id=${id}${extra}`;
const ip = (c, i) => `/ip address add address=${c} interface=${i}`;
const net = (a, extra) => `/ip dhcp-server network add address=${a} ${extra}`;
const bvlan = (id, comment) => `/interface bridge vlan add bridge=bridge1 tagged=ether2 vlan-ids=${id} comment=${comment}`;
const MAC = 'AA:BB:CC:00:00:01';
const host = (rows) => build('SW_A (10.0.0.1):\n### /interface bridge host print detail\n'
  + rows.map(([ifc, vid], k) => ` ${k} D mac-address=${MAC} on-interface=${ifc} bridge=bridge1 vid=${vid}\n`).join(''));

/**
 * 會碰撞的情況：每條規則一份輸入，在 2.9.0 之前（不含 facet）會有兩筆以上 id＋實體相同的 finding。
 * facets 是這條規則在這份輸入中產生的 facet（依 finding 順序）。
 */
const COLLISIONS = {
  I02: { input: () => build(['SW_A (10.0.0.1):',
    '### /ip arp print detail', ' 0 address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1', '### /ip arp print detail', ' 0 address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1',
    '### /ip address print detail', ' 0 address=10.0.0.1/24 network=10.0.0.0 interface=ether1', '### /ip address print detail', ' 0 address=10.0.0.1/24 network=10.0.0.0 interface=ether1'].join('\n')),
  facets: ['mikrotik.arp', 'mikrotik.ipaddr'] },
  V06: { input: (n) => pair([VIF('vlan10', 10, ' comment=MGMT')], [VIF('mgmt', 10, ' comment=office')], true, n), facets: ['vlan-interface-comment', 'vlan-interface-name'] },
  // 名稱與說明同字（同一組介面、VLAN），以及 bridge VLAN 說明 x／y 交叉對到 VLAN 20／30（同一組設備、VLAN）
  V07: { input: (n) => pair([VIF('mgmt', 10, ' comment=mgmt'), bvlan(20, 'x'), bvlan(30, 'y')], [VIF('mgmt', 20, ' comment=mgmt'), bvlan(20, 'y'), bvlan(30, 'x')], false, n),
    facets: ['bridge-vlan-comment|x', 'bridge-vlan-comment|y', 'vlan-interface-comment|mgmt', 'vlan-interface-name|mgmt'] },
  A02: { input: () => host([['ether1', 10], ['ether2', 10], ['ether1', 20], ['ether2', 20]]), facets: ['10', '20'] },
  A07: { input: (n) => pair([VIF('vlan10', 10), ip('10.0.10.1/24', 'vlan10'), ip('10.0.11.1/24', 'vlan10')], [VIF('vlan20', 20), ip('10.0.10.2/24', 'vlan20'), ip('10.0.11.2/24', 'vlan20')], false, n),
    facets: ['10.0.10.0/24', '10.0.11.0/24'] },
  A08: { input: (n) => pair([ip('10.0.10.1/24', 'ether5'), ip('10.0.20.1/24', 'ether5')], [ip('10.0.10.2/25', 'ether5'), ip('10.0.20.2/25', 'ether5')], true, n),
    facets: ['10.0.10.0/24', '10.0.20.0/24'] },
  A10: { input: (n) => pair(['/ip firewall address-list add address=10.0.10.0/24 list=MGMT', '/ip firewall address-list add address=10.0.20.0/24 list=SRV'],
    ['/ip firewall address-list add address=10.0.99.0/24 list=MGMT', '/ip firewall address-list add address=10.0.98.0/24 list=SRV'], true, n),
  facets: ['/ip firewall address-list|mgmt', '/ip firewall address-list|srv'] },
  A11: { input: (n) => pair(['/ip dns static add address=10.0.0.5 name=a.lan', '/ip dns static add address=10.0.0.6 name=c.lan'], ['/ip dns static add address=10.0.0.5 name=b.lan', '/ip dns static add address=10.0.0.6 name=d.lan'], true, n),
    facets: ['/ip dns static|10.0.0.5', '/ip dns static|10.0.0.6'] },
  A12: { input: (n) => pair(['/ip dns set servers=1.1.1.1', '/system ntp client set enabled=yes servers=10.0.0.1'], ['/ip dns set servers=8.8.8.8', '/system ntp client set enabled=yes servers=10.0.0.2'], true, n),
    facets: ['dns', 'ntp'] },
  R02: { input: () => build(['R1 (10.0.0.1):', '### /ip address print detail', ' 0 address=10.9.9.1/30 network=10.9.9.0 interface=ether1', ' 1 address=10.9.8.1/30 network=10.9.8.0 interface=ether2',
    '### /routing ospf neighbor print detail', ' 0 instance=default area=backbone address=10.9.9.2 router-id=10.255.0.9 state=Full', ' 1 instance=default area=backbone address=10.9.8.2 router-id=10.255.0.9 state=Full'].join('\n')),
  facets: ['ether1', 'ether2'] },
  R05: { input: () => build(['R (10.0.0.1):', '### /export terse', net('10.1.30.0/24', 'gateway=10.1.31.1'), net('10.1.20.0/24', 'gateway=10.1.21.1')].join('\n')),
    facets: ['10.1.20.0/24', '10.1.30.0/24'] },
  R06: { input: (n) => pair([net('10.0.30.0/24', 'gateway=10.0.30.1 dns-server=1.1.1.1 ntp-server=10.0.0.1'), net('10.0.40.0/24', 'gateway=10.0.40.1')],
    [net('10.0.30.0/24', 'gateway=10.0.30.2 dns-server=8.8.8.8 ntp-server=10.0.0.2'), net('10.0.40.0/24', 'gateway=10.0.40.2')], true, n),
  facets: ['dns|10.0.30.0/24', 'gateway|10.0.30.0/24', 'gateway|10.0.40.0/24', 'ntp|10.0.30.0/24'] },
};
const of = (s, id) => s.findings.filter((f) => f.id === id);
const group = (fs, keyOf) => { const m = new Map(); fs.forEach((f) => { const k = keyOf(f); m.set(k, (m.get(k) || []).concat([f])); }); return m; };

test('facet：CATALOG 有宣告 facet 的規則就是會碰撞的規則；每條都有一份不含 facet 時會碰撞的輸入', () => {
  const declared = Object.keys(S.check.CATALOG).filter((id) => S.check.CATALOG[id].facet !== undefined);
  assert.deepStrictEqual(declared, Object.keys(COLLISIONS).sort((a, b) => Object.keys(S.check.CATALOG).indexOf(a) - Object.keys(S.check.CATALOG).indexOf(b)));
  declared.forEach((id) => assert.ok(typeof S.check.CATALOG[id].facet === 'string' && S.check.CATALOG[id].facet, `${id} 的 CATALOG facet 說明`));
  Object.entries(COLLISIONS).forEach(([id, c]) => {
    const fs = of(c.input(), id);
    const base = group(fs, S.query.findingBaseKey);
    assert.ok(Array.from(base.values()).some((g) => g.length > 1), `${id}：不含 facet 時應有兩筆以上 id＋實體相同`);
    assert.deepStrictEqual(fs.map((f) => f.facet).sort(), c.facets, `${id} 的 facet`);
  });
});

test('facet：每條會碰撞的規則，findingKey 都能區分（每個鍵只對到一筆），facet 在鍵的第 2 個元素', () => {
  Object.entries(COLLISIONS).forEach(([id, c]) => {
    const s = c.input(); const Q = S.query(s); const fs = of(s, id);
    const keys = fs.map(Q.findingKey);
    assert.strictEqual(new Set(keys).size, fs.length, `${id}：${keys.join(' ')}`);
    fs.forEach((f) => {
      const a = JSON.parse(Q.findingKey(f));
      assert.deepStrictEqual(a.slice(0, 2), [id, 'facet:' + f.facet]);
      assert.deepStrictEqual(a.slice(2), JSON.parse(S.query.findingBaseKey(f)).slice(1), `${id}：facet 之後是排序後的實體，和不含 facet 的鍵相同`);
    });
  });
  const a12 = of(COLLISIONS.A12.input(), 'A12');
  assert.deepStrictEqual(a12.map(S.query.findingKey), ['["A12","facet:dns","device:SW_A","device:SW_B"]', '["A12","facet:ntp","device:SW_A","device:SW_B"]']);
  assert.deepStrictEqual(a12.map(S.query.findingBaseKey), ['["A12","device:SW_A","device:SW_B"]', '["A12","device:SW_A","device:SW_B"]'], '舊鍵（2.9.0 之前）兩筆相同');
});

test('facet：只有 CATALOG 宣告的規則才有、而且每筆都有；沒有 facet 的 finding，findingKey 和 2.9.0 之前完全相同', () => {
  const snaps = [sampleSnap()].concat(Object.values(COLLISIONS).map((c) => c.input()));
  const legacy = (f) => JSON.stringify([f.id].concat(S.util.uniq(f.entities.map((e) => e.type + ':' + e.key)).sort(S.util.cmp)));
  snaps.forEach((s) => s.findings.forEach((f) => {
    assert.strictEqual('facet' in f, S.check.CATALOG[f.id].facet !== undefined, `${f.id} 的 facet 欄位`);
    if ('facet' in f) assert.ok(typeof f.facet === 'string' && f.facet, `${f.id} 的 facet 必須是非空字串`);
    else assert.strictEqual(S.query.findingKey(f), legacy(f), `${f.id}：沒有 facet 時鍵不變`);
    assert.strictEqual(S.query.findingBaseKey(f), legacy(f));
    assert.ok(f.entities.every((e) => e.type !== 'facet'), 'entity 的 type 不可以是 facet，否則會和 facet 元素混淆');
  }));
  const k02 = sampleSnap().findings.find((f) => f.id === 'K02');
  assert.strictEqual(S.query(sampleSnap()).findingKey(k02), legacy(k02));
});

test('facet：同樣的輸入得到同樣的 facet 與鍵；設備改名、訊息改變不影響 facet', () => {
  Object.entries(COLLISIONS).forEach(([id, c]) => {
    const k1 = of(c.input(), id).map(S.query.findingKey); const k2 = of(c.input(), id).map(S.query.findingKey);
    assert.deepStrictEqual(k1, k2, `${id} 可重現`);
    if (c.input.length === 0) return; // 只有兩台交換器的案例可以改設備名稱
    const renamed = of(c.input(['ZZ_1', 'AA_2']), id);
    assert.deepStrictEqual(renamed.map((f) => f.facet).sort(), c.facets, `${id}：設備改名後 facet 相同`);
    assert.notDeepStrictEqual(renamed.map((f) => f.message).sort(), of(c.input(), id).map((f) => f.message).sort(), `${id}：訊息含設備名稱，會改變`);
  });
});

test('facet：仍會碰撞的規則（I01、I03 依輸入區塊，不是檢查項目）不帶 facet，以多重集合處理', () => {
  const s = build(['SW_A (10.0.0.1):', '### /ip arp print detail', ' 0 address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1', 'GARBAGE LINE one',
    '### /ip address print detail', ' 0 address=10.0.0.1/24 network=10.0.0.0 interface=ether1', 'GARBAGE LINE two'].join('\n'));
  const i03 = of(s, 'I03');
  assert.strictEqual(i03.length, 2);
  assert.ok(i03.every((f) => !('facet' in f)));
  assert.strictEqual(new Set(i03.map(S.query.findingKey)).size, 1, 'I03 同一台設備的多段仍共用一個鍵（ADR-003）');
});
