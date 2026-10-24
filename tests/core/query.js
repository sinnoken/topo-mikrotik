// 查詢、VLAN 區塊、路由追蹤、finding 穩定鍵（含 facet）、Q.findingDevice
'use strict';
const assert = require('assert');
const { S, read, build, ids, gen, test, NB, BH, sampleSnap } = require('../lib.js');
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

// ------------------------------------------------------------------ 畫面用的查詢（不直接讀 Snapshot 欄位與 S.check）
test('查詢介面：finding 依 idx 與 findingKey 取得；碰撞的鍵回傳全部索引，第一筆依 Snapshot 順序', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  assert.strictEqual(Q.findings(), s.findings, 'findings() 回傳 Snapshot 的陣列本身，不複製');
  s.findings.forEach((f, idx) => {
    assert.strictEqual(Q.finding(idx), f);
    const all = Q.findingIndexesByKey(Q.findingKey(f));
    assert.ok(all.includes(idx), `${f.id} 的索引在同鍵清單中`);
    assert.strictEqual(Q.findingIndexByKey(Q.findingKey(f)), s.findings.findIndex((x) => Q.findingKey(x) === Q.findingKey(f)), '與畫面原本的 findIndex 相同');
  });
  [-1, s.findings.length, 1.5, '0', null, undefined].forEach((x) => assert.strictEqual(Q.finding(x), null, `無效索引 ${String(x)}`));
  assert.deepStrictEqual(Q.findingIndexesByKey('["NOPE"]'), []);
  assert.strictEqual(Q.findingIndexByKey('["NOPE"]'), -1);
  // 碰撞：同一台設備兩段無法辨識的行（I03 共用一個鍵）
  const c = build(['SW_A (10.0.0.1):', '### /ip arp print detail', ' 0 address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1', 'GARBAGE LINE one',
    '### /ip address print detail', ' 0 address=10.0.0.1/24 network=10.0.0.0 interface=ether1', 'GARBAGE LINE two'].join('\n'));
  const Qc = S.query(c); const i03 = c.findings.map((f, idx) => [f, idx]).filter(([f]) => f.id === 'I03').map(([, idx]) => idx);
  assert.strictEqual(i03.length, 2);
  assert.deepStrictEqual(Array.from(Qc.findingIndexesByKey(Qc.findingKey(c.findings[i03[0]]))), i03);
  assert.strictEqual(Qc.findingIndexByKey(Qc.findingKey(c.findings[i03[1]])), i03[0]);
  assert.ok(Object.isFrozen(Qc.findingIndexesByKey(Qc.findingKey(c.findings[i03[0]]))), '索引陣列是 Q 的，凍結');
});

test('查詢介面：findingsByRule、blocksOf、coverageOf 與直接讀 Snapshot 的結果相同', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  const ruleIds = S.util.uniq(s.findings.map((f) => f.id));
  assert.ok(ruleIds.includes('C01') && ruleIds.includes('K01'), '範例資料含 C01、K01');
  ruleIds.forEach((id) => assert.deepStrictEqual(Array.from(Q.findingsByRule(id)), s.findings.filter((f) => f.id === id), id));
  assert.deepStrictEqual(Q.findingsByRule('ZZ99'), []);
  assert.ok(Object.isFrozen(Q.findingsByRule('C01')) && Object.isFrozen(Q.findingsByRule('ZZ99')));
  s.model.devices.forEach((d) => {
    assert.deepStrictEqual(Array.from(Q.blocksOf(d.key)), s.blocks.filter((b) => b.devKey === d.key), `${d.key} 的區塊`);
    assert.strictEqual(Q.coverageOf(d.key), s.coverage.find((c) => c.dev === d.key) || null, `${d.key} 的覆蓋`);
  });
  assert.ok(Q.blocksOf(s.model.devices.find((d) => d.collected).key).length > 0);
  assert.deepStrictEqual(Q.blocksOf('NOPE'), []); assert.strictEqual(Q.coverageOf('NOPE'), null);
  assert.ok(Q.blocksOf(s.model.devices[0].key).every((b) => Q.block(b.id) === b), 'blocksOf 的元素與 block(id) 是同一個物件');
  assert.strictEqual(Q.meta(), s.meta); assert.strictEqual(Q.coverage(), s.coverage); assert.strictEqual(Q.devices(), s.model.devices);
});

test('查詢介面：規則目錄、資料類別、解析器名稱與 VLAN 文字（靜態，不需要 Snapshot）', () => {
  const C = S.check.CATALOG;
  assert.deepStrictEqual(S.query.rules().map((r) => r.id), Object.keys(C), '依 CATALOG 的宣告順序');
  S.query.rules().forEach((r) => {
    assert.strictEqual(S.query.rule(r.id), r);
    const { id, ...rest } = r; assert.deepStrictEqual(rest, C[id], `${id} 的內容與 CATALOG 相同`);
  });
  assert.strictEqual(S.query.rule('ZZ99'), null); assert.strictEqual(S.query.rule('toString'), null);
  // 凍結：呼叫端改不到目錄（含巢狀的 data、causes）
  const k01 = S.query.rule('K01');
  assert.ok(Object.isFrozen(S.query.rules()) && Object.isFrozen(k01) && Object.isFrozen(k01.causes) && Object.isFrozen(C.K01) && Object.isFrozen(C.K01.causes));
  assert.throws(() => { 'use strict'; k01.title = 'x'; }, TypeError);
  assert.throws(() => { 'use strict'; C.K01.causes.push('x'); }, TypeError);
  assert.ok(Object.values(C).every((c) => !c.data || (Object.isFrozen(c.data) && c.data.every(Object.isFrozen))));
  // 資料類別：每條規則需要的資料都有名稱；不認得的原樣回傳
  Object.values(C).forEach((c) => (c.data || []).flat().forEach((t) => assert.notStrictEqual(S.query.dataLabel(t), t, t)));
  assert.strictEqual(S.query.dataLabel('lldp'), S.check.DATA_LABEL.lldp);
  assert.strictEqual(S.query.dataLabel('nope'), 'nope');
  assert.ok(Object.isFrozen(S.check.DATA_LABEL));
  // 解析器名稱：已登錄的 adapter 用 label；不認得的 id 與登錄表本身的方法名稱都原樣回傳
  S.adapters.list.forEach((a) => assert.strictEqual(S.query.adapterLabel(a.id), a.label));
  ['nope', 'list', 'register', 'parse', 'constructor'].forEach((x) => assert.strictEqual(S.query.adapterLabel(x), x));
  // VLAN 文字：核心訊息與畫面同一個實作
  assert.strictEqual(S.check.fmtVlans, S.util.fmtVlans);
  assert.strictEqual(S.util.fmtVlans([1, 2, 3, 5, 7, 8, 4094]), '1-3,5,7-8,4094');
  assert.strictEqual(S.util.fmtVlans([]), '');
  assert.strictEqual(S.util.fmtVlans([10]), '10');
});

test('查詢介面：metaOf 只在 JSON 像 Snapshot 時回傳 meta', () => {
  const s = build(read('samples/sample-bundle.txt'));
  assert.strictEqual(S.query.metaOf(s), s.meta);
  const j = JSON.parse(JSON.stringify(s));
  assert.deepStrictEqual(S.query.metaOf(j), s.meta);
  assert.strictEqual(S.query.metaOf(j).schema, S.SCHEMA);
  [null, undefined, 0, 'x', [], { meta: null }, { meta: 'x' }, { meta: [] }, {}].forEach((x) => assert.strictEqual(S.query.metaOf(x), null, JSON.stringify(x)));
});

test('查詢介面：第一次呼叫才建立索引，不改動 Snapshot（建立前後 JSON 相同）', () => {
  const s = build(read('samples/sample-bundle.txt')); const before = JSON.stringify(s); const Q = S.query(s);
  Q.findingIndexesByKey('x'); Q.findingsByRule('C01'); Q.blocksOf('x'); Q.coverageOf('x');
  assert.strictEqual(JSON.stringify(s), before);
  assert.ok(!Object.isFrozen(s.findings) && !Object.isFrozen(s.blocks), 'Snapshot 本身不凍結（靠約定唯讀；畫面會存進 IndexedDB 與匯出）');
});

// ------------------------------------------------------------------ L2／L3 視圖（M1）
// SW_A 以 bond1（ether1、ether2）接 SW_B 的 bond1；ether3 接未收集的 HOST1（VLAN 20 access）；ether4 接 SW_C（SW_C 沒有 VLAN 10）；
// ether5 只以 MNDP 看到 SW_D（不算直連）
const l2Lab = () => build([
  'SW_A (10.0.0.1):', NB([
    ' 0 interface=ether1 mac-address=AA:00:00:00:00:B1 identity=SW_B interface-name=ether1 discovered-by=lldp',
    ' 1 interface=ether2 mac-address=AA:00:00:00:00:B2 identity=SW_B interface-name=ether2 discovered-by=lldp',
    ' 2 interface=ether3 mac-address=AA:00:00:00:00:E1 identity=HOST1 interface-name=eth0 discovered-by=lldp',
    ' 3 interface=ether4 mac-address=AA:00:00:00:00:C1 identity=SW_C interface-name=ether1 discovered-by=lldp',
    ' 4 interface=ether5 mac-address=AA:00:00:00:00:D1 identity=SW_D interface-name=ether1 discovered-by=mndp']),
  '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bonding add mode=802.3ad name=bond1 slaves=ether1,ether2',
  '/interface vlan add interface=bridge1 name=vlan10 vlan-id=10',
  '/interface bridge port add bridge=bridge1 interface=bond1', '/interface bridge port add bridge=bridge1 interface=ether3 pvid=20',
  '/interface bridge port add bridge=bridge1 interface=ether4', '/interface bridge port add bridge=bridge1 interface=ether5',
  '/interface bridge vlan add bridge=bridge1 tagged=bridge1,bond1,ether4,ether5 vlan-ids=10', '/interface bridge vlan add bridge=bridge1 untagged=ether3 vlan-ids=20',
  'SW_B (10.0.0.2):', NB([
    ' 0 interface=ether1 mac-address=AA:00:00:00:00:A1 identity=SW_A interface-name=ether1 discovered-by=lldp',
    ' 1 interface=ether2 mac-address=AA:00:00:00:00:A2 identity=SW_A interface-name=ether2 discovered-by=lldp']),
  '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bonding add mode=802.3ad name=bond1 slaves=ether1,ether2',
  '/interface bridge port add bridge=bridge1 interface=bond1', '/interface bridge vlan add bridge=bridge1 tagged=bond1 vlan-ids=10',
  'SW_C (10.0.0.3):', NB([' 0 interface=ether1 mac-address=AA:00:00:00:00:A4 identity=SW_A interface-name=ether4 discovered-by=lldp']),
  '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge port add bridge=bridge1 interface=ether1',
  '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=30',
  'SW_D (10.0.0.4):', NB([' 0 interface=ether1 mac-address=AA:00:00:00:00:A5 identity=SW_A interface-name=ether5 discovered-by=mndp']),
  '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge port add bridge=bridge1 interface=ether1',
  '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=10',
].join('\n'));
const isDeepFrozen = (o) => !o || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o).every(isDeepFrozen));
// 衍生結果凍結時不能連帶凍結到 Snapshot 的物件（衍生結果不引用 Snapshot 的陣列）
const anyFrozen = (o) => !!o && typeof o === 'object' && (Object.isFrozen(o) || Object.values(o).some(anyFrozen));

test('VLAN 承載鏈路：兩端都帶為 carry（含所屬聚合），只有一端帶時依另一端是否已知分成 partial 與 oneSide；MNDP 不列入', () => {
  const s = l2Lab(); const Q = S.query(s);
  const vs = Array.from(Q.vlanIds());
  assert.deepStrictEqual(vs, vs.slice().sort((x, y) => x - y), 'vlanIds 由小到大');
  assert.ok([10, 20, 30].every((v) => vs.includes(v)) && Object.isFrozen(Q.vlanIds()));
  const c10 = Q.vlanCarriers(10);
  const by = (st) => c10.links.filter((r) => r.status === st);
  assert.deepStrictEqual(by('carry').map((r) => r.key), ['SW_A|ether1~SW_B|ether1', 'SW_A|ether2~SW_B|ether2'], '聚合成員經所屬聚合帶 VLAN 10');
  by('carry').forEach((r) => [r.a, r.b].forEach((x) => assert.deepStrictEqual([x.has, x.via, x.mode], [true, 'lag', 'tagged'], r.key)));
  assert.deepStrictEqual(by('partial').map((r) => [r.key, r.a.has, r.b.has, r.inferred]), [['SW_A|ether4~SW_C|ether1', true, false, false]], 'SW_C 有 VLAN 資料但沒有 VLAN 10：事實上的不一致');
  assert.deepStrictEqual(by('oneSide'), []);
  assert.ok(!c10.links.some((r) => r.key.includes('SW_D')), 'MNDP 只證明同一廣播網域，不算承載');
  assert.deepStrictEqual(c10.counts, { carry: 2, partial: 1, oneSide: 0, inferred: 0 });
  assert.ok(c10.eps.includes('SW_A|ether1') && c10.eps.includes('SW_A|ether4') && !c10.eps.includes('SW_C|ether1'), 'eps 只列帶這個 VLAN 的一端');
  assert.ok(c10.links.every((r) => r.kind === 'link' && Q.getLink(r.key) && r.src.length > 0), '每一列都可以回到鏈路與來源行');
  // 只有一端有資料：未收集的 HOST1 那一端無從得知（has 為 null），列為推論
  const one = Q.vlanCarriers(20).links;
  assert.deepStrictEqual(one.map((r) => [r.key, r.status, r.reason, r.inferred, r.hearsay]), [['HOST1|eth0~SW_A|ether3', 'oneSide', 'peer-uncollected', true, true]]);
  assert.deepStrictEqual([one[0].a.has, one[0].b.has, one[0].b.mode], [null, true, 'untagged']);
  // 與 Q.vlan 同一套判斷；區塊篩選
  assert.deepStrictEqual(by('carry').map((r) => r.key), Q.vlan(10).carry.map((l) => l.key));
  assert.deepStrictEqual(Q.vlanCarriers(10, '10@SW_D').links, [], 'SW_D 自成一塊，沒有承載鏈路');
  assert.strictEqual(Q.vlanCarriers(10), c10, '同樣的參數回傳同一份快取');
  assert.ok(isDeepFrozen(c10)); assert.ok(!anyFrozen(s), 'Snapshot 沒有被凍結');
});

test('VLAN 承載鏈路：推論鏈路在已收集端帶這個 VLAN 時列為 inferred，未收集端無從得知', () => {
  const css = ' 0 interface=ether5 mac-address=CC:2D:E0:00:01:06 identity=CSS106_1 board="CSS106-1G-4P-1S" discovered-by=mndp';
  const Q = S.query(build(['SW_A (10.0.0.1):', NB([css]), '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge port add bridge=bridge1 interface=ether5',
    '/interface bridge vlan add bridge=bridge1 tagged=ether5 vlan-ids=20',
    BH([' 0 DL mac-address=D4:01:C3:00:00:0A on-interface=bridge1', ' 1 D mac-address=CC:2D:E0:00:01:06 on-interface=ether5'])].join('\n')));
  const rows = Q.vlanCarriers(20).links;
  assert.deepStrictEqual(rows.map((r) => [r.key, r.kind, r.status, r.inferred]), Q.inferredLinks().map((l) => [l.key, 'inferred', 'inferred', true]));
  const sw = [rows[0].a, rows[0].b].find((x) => x.dev === 'SW_A'); const css1 = [rows[0].a, rows[0].b].find((x) => x.dev !== 'SW_A');
  assert.deepStrictEqual([sw.has, sw.via, sw.mode, css1.has, css1.collected], [true, 'self', 'tagged', null, false]);
  assert.strictEqual(Q.getInferredLink(rows[0].key).key, rows[0].key, '以 Q.getInferredLink 取回推論鏈路');
  assert.deepStrictEqual(Q.vlanCarriers(30).links, []);
});

test('VLAN 承載鏈路：範例資料與 Q.vlan 一致；只有一端的鏈路標為推論並說明原因', () => {
  const Q = S.query(build(read('samples/sample-bundle.txt')));
  Q.vlanIds().forEach((id) => {
    const c = Q.vlanCarriers(id); const v = Q.vlan(id); const keys = (st) => c.links.filter((r) => r.status === st).map((r) => r.key);
    assert.deepStrictEqual([keys('carry'), keys('partial'), keys('inferred')], [v.carry, v.partial, v.inferred].map((ls) => ls.map((l) => l.key)), `VLAN ${id}`);
    c.links.forEach((r) => {
      assert.strictEqual(r.inferred, r.status === 'oneSide' || r.status === 'inferred');
      const l = r.kind === 'link' ? Q.getLink(r.key) : Q.getInferredLink(r.key);
      assert.ok(l && l.evidenceScope !== S.LINK_SCOPE.BROADCAST_DOMAIN, r.key);
    });
  });
  assert.strictEqual(Q.vlanCarriers(30).counts.partial, 1);
  const os = Q.vlanCarriers(20).links.filter((r) => r.status === 'oneSide');
  assert.ok(os.length > 0 && os.every((r) => r.reason === 'peer-uncollected' && [r.a, r.b].some((x) => x.has === null)), '範例的伺服器只由 LLDP 看到');
});

test('埠層級 L2 圖：聚合成員預設併成聚合埠，可展開；只畫介面鄰接，MNDP 列在 omitted', () => {
  const s = l2Lab(); const before = JSON.stringify(s); const Q = S.query(s);
  const g = Q.portGraph();
  assert.deepStrictEqual(g.edges.map((e) => [e.id, e.evidence, e.count]), [
    ['HOST1|eth0~SW_A|ether3', 'hearsay', 1], ['SW_A|bond1~SW_B|bond1', 'adjacency', 2], ['SW_A|ether4~SW_C|ether1', 'adjacency', 1]]);
  const lag = g.edges.find((e) => e.id === 'SW_A|bond1~SW_B|bond1');
  assert.deepStrictEqual([lag.links, lag.cls, lag.inferred, lag.vlansCommon], [['SW_A|ether1~SW_B|ether1', 'SW_A|ether2~SW_B|ether2'], 'lag', false, [1, 10]]);
  assert.ok(g.edges.find((e) => e.evidence === 'hearsay').inferred, '單側觀察是推論');
  assert.deepStrictEqual(g.omitted, { domainOnly: 1, sameDevice: 0, inferred: 0 });
  const bond = g.ports.find((p) => p.id === 'SW_A|bond1');
  assert.deepStrictEqual([bond.members, bond.type, bond.bridge, bond.vlans, bond.edges], [['SW_A|ether1', 'SW_A|ether2'], 'lag', 'SW_A|bridge1', [1, 10], 1]);
  assert.ok(!g.ports.some((p) => p.id === 'SW_A|ether1'), '收合時成員不是獨立的埠');
  const a = g.devices.find((d) => d.id === 'SW_A');
  assert.deepStrictEqual(a.ports, ['SW_A|bond1', 'SW_A|ether3', 'SW_A|ether4']);
  assert.deepStrictEqual(a.bridges.map((b) => [b.ep, b.ports, b.vlanIfcs]), [['SW_A|bridge1', ['SW_A|bond1', 'SW_A|ether3', 'SW_A|ether4'], ['SW_A|vlan10']]], 'VLAN 子介面收在所屬 bridge');
  assert.ok(!g.devices.some((d) => d.id === 'SW_D'), 'SW_D 只有 MNDP，不出現');
  assert.ok(g.devices.find((d) => d.id === 'HOST1').collected === false);
  // 展開：成員各自是埠，lag 指向聚合
  const x = Q.portGraph({ lag: 'expand' });
  assert.deepStrictEqual(x.edges.map((e) => e.id).filter((id) => id.includes('SW_B')), ['SW_A|ether1~SW_B|ether1', 'SW_A|ether2~SW_B|ether2']);
  assert.strictEqual(x.ports.find((p) => p.id === 'SW_A|ether1').lag, 'SW_A|bond1');
  assert.deepStrictEqual(x.ports.find((p) => p.id === 'SW_A|ether1').vlans, [1, 10], '成員的 VLAN 含所屬聚合（bridge port 預設 PVID 1）');
  // 全部埠、只看部分設備
  assert.ok(Q.portGraph({ ports: 'all' }).ports.some((p) => p.id === 'SW_A|ether5' && p.edges === 0), 'ports: all 也列沒有邊的埠');
  const f = Q.portGraph({ devices: ['SW_C'] });
  assert.deepStrictEqual([f.edges.map((e) => e.id), f.devices.map((d) => [d.id, d.focus])], [['SW_A|ether4~SW_C|ether1'], [['SW_A', false], ['SW_C', true]]]);
  assert.throws(() => Q.portGraph({ lag: 'fold' }), TypeError); assert.throws(() => Q.portGraph({ devices: 'SW_A' }), TypeError);
  assert.strictEqual(Q.portGraph(), g); assert.strictEqual(Q.portGraph({ lag: 'collapse', ports: 'linked', inferred: true }), g, '預設值與明寫相同時共用快取');
  assert.ok(isDeepFrozen(g) && isDeepFrozen(x));
  assert.strictEqual(JSON.stringify(s), before, '不改動 Snapshot'); assert.ok(!anyFrozen(s), 'Snapshot 沒有被凍結');
});

test('埠層級 L2 圖：範例資料的每條介面鄰接鏈路恰好在一條邊；推論鏈路的未知埠標為 unknown', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s); const g = Q.portGraph();
  const adj = s.model.links.filter((l) => l.evidenceScope === S.LINK_SCOPE.INTERFACE_ADJACENCY).map((l) => l.key).sort();
  assert.deepStrictEqual(g.edges.flatMap((e) => e.links).sort(), adj);
  assert.strictEqual(g.omitted.domainOnly, s.model.links.filter((l) => l.evidenceScope === S.LINK_SCOPE.BROADCAST_DOMAIN).length);
  assert.deepStrictEqual(g.edges.flatMap((e) => e.inferredLinks).sort(), s.model.inferredLinks.map((l) => l.key).sort());
  assert.ok(g.edges.some((e) => e.id === 'TPE_ACC_SW_01|bond1~TPE_CORE_RT_01|bond1' && e.links.length === 2 && e.cls === 'lag'));
  const ie = g.edges.find((e) => e.evidence === 'inferred');
  assert.ok(ie && ie.inferred && [ie.a, ie.b].some((p) => g.ports.find((x) => x.id === p).unknown), '推論鏈路未收集的一端是未知埠');
  assert.ok(g.ports.filter((p) => p.unknown).every((p) => p.ifc === null && p.name === '?'));
  const ids = new Set(g.ports.map((p) => p.id));
  assert.ok(g.edges.every((e) => ids.has(e.a) && ids.has(e.b)), '每條邊的兩端都在 ports');
  assert.deepStrictEqual(Q.portGraph({ inferred: false }).omitted.inferred, s.model.inferredLinks.length);
});

const l3Lab = () => build([
  'R1 (10.0.0.1):', '### /export terse',
  '/ip address add address=10.1.0.1/24 interface=ether1', '/ip address add address=10.2.0.1/24 interface=ether2', '/ip address add address=10.9.9.1/32 interface=lo',
  '### /ip route print detail', 'Flags: A - ACTIVE; s - STATIC', ' 0 As dst-address=0.0.0.0/0 gateway=10.2.0.254 distance=1',
  'R2 (10.0.0.2):', '### /export terse',
  '/ip address add address=10.1.0.2/25 interface=ether1', '/ip address add address=10.2.0.1/24 interface=ether2',
].join('\n'));

test('L3 子網圖：子網、設備與「有位址」的邊都帶 vrf（目前為 null）；標示路由設備、重疊網段與重複 IP', () => {
  const s = l3Lab(); const before = JSON.stringify(s); const Q = S.query(s);
  const g = Q.subnetGraph();
  assert.deepStrictEqual(g.subnets.map((x) => [x.id, x.devices, x.basis]), [
    ['10.1.0.0/24', ['R1'], 'connected'], ['10.1.0.0/25', ['R2'], 'connected'], ['10.2.0.0/24', ['R1', 'R2'], 'connected']]);
  assert.deepStrictEqual(g.subnets.map((x) => x.overlaps), [['10.1.0.0/25'], ['10.1.0.0/24'], []], '位址重疊的網段互相列出');
  assert.deepStrictEqual(g.subnets.find((x) => x.id === '10.2.0.0/24').duplicateIps, ['10.2.0.1']);
  const r1 = g.nodes.find((n) => n.id === 'R1');
  assert.deepStrictEqual([r1.router, r1.routerBasis, r1.multihomed, r1.subnets, r1.hostAddresses.map((h) => h.address)], [true, 'routes', true, ['10.1.0.0/24', '10.2.0.0/24'], ['10.9.9.1/32']]);
  assert.deepStrictEqual(g.subnets.find((x) => x.id === '10.2.0.0/24').routers.includes('R1'), true);
  const e = g.edges.find((x) => x.id === '10.1.0.0/24~R1');
  assert.deepStrictEqual([e.eps, e.basis, e.inferred, e.addresses.map((a) => a.address)], [['R1|ether1'], 'address', false, ['10.1.0.1/24']]);
  assert.ok(e.addresses[0].src.length === 1 && s.blocks[e.addresses[0].src[0][0]], '邊可以回到位址的來源行');
  // vrf：每個節點、邊、子網與路由都有，M3 之前固定為 null
  const r = Q.subnetGraph({ routes: true });
  [r.subnets, r.nodes, r.edges, r.routes].forEach((list) => list.forEach((x) => assert.ok('vrf' in x && x.vrf === null, JSON.stringify(x))));
  const def = r.routes.find((x) => x.default);
  assert.deepStrictEqual([def.dev, def.subnet, def.via, def.proto], ['R1', '0.0.0.0/0', ['10.2.0.0/24'], 'Static']);
  assert.strictEqual(r.subnets.find((x) => x.id === '0.0.0.0/0').basis, 'route', '路由的目的不是已知網段時新增節點');
  assert.deepStrictEqual(g.routes, [], '預設不含路由');
  // 介面節點
  const i = Q.subnetGraph({ nodes: 'interface' });
  assert.deepStrictEqual(i.nodes.filter((n) => n.dev === 'R1').map((n) => [n.id, n.name, n.router]), [['R1|ether1', 'ether1', true], ['R1|ether2', 'ether2', true]]);
  assert.throws(() => Q.subnetGraph({ nodes: 'vrf' }), TypeError);
  assert.strictEqual(Q.subnetGraph(), g); assert.ok(isDeepFrozen(g) && isDeepFrozen(r) && isDeepFrozen(i));
  assert.strictEqual(JSON.stringify(s), before, '不改動 Snapshot'); assert.ok(!anyFrozen(s), 'Snapshot 沒有被凍結');
});

test('L3 子網圖：範例資料的路由設備、多網段的交換器、鄰居宣告與管理 IP 的推論邊', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s); const g = Q.subnetGraph();
  assert.deepStrictEqual(g.subnets.filter((x) => x.basis === 'connected').map((x) => x.id), s.model.prefixes.map((p) => p.prefix), '每個 prefixes 一個子網');
  assert.deepStrictEqual(g.nodes.filter((n) => n.router).map((n) => n.id), ['TPE_CORE_RT_01', 'TPE_CORE_RT_02']);
  const sw11 = g.nodes.find((n) => n.id === 'TPE_ACC_SW_11');
  assert.deepStrictEqual([sw11.multihomed, sw11.router], [true, false], '交換器在兩個網段有位址，但沒有路由表，不算路由設備');
  assert.ok(g.subnets.find((x) => x.id === '10.1.10.0/24').overlaps.includes('10.1.10.0/25'));
  const nb = g.edges.find((e) => e.basis === 'neighbor');
  assert.ok(nb && nb.inferred && nb.addresses.every((a) => a.hearsay && a.src.length), '鄰居宣告的位址只接到已知網段，標為推論');
  const mg = g.edges.filter((e) => e.basis === 'mgmt');
  assert.ok(mg.length && mg.every((e) => e.inferred && e.addresses.every((a) => a.seenBy.length)), '只由鄰居看到的設備，以 seenBy 追溯');
  // 自有位址的邊恰好對應 prefixes 的 eps
  s.model.prefixes.forEach((p) => assert.deepStrictEqual(g.edges.filter((e) => e.subnet === p.prefix && e.basis === 'address').flatMap((e) => e.eps).sort(), p.eps.slice().sort(), p.prefix));
  const off = Q.subnetGraph({ hearsay: false });
  assert.ok(off.edges.every((e) => !e.inferred));
});
