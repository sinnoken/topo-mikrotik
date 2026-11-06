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
  const sv = Q.search('10').find((r) => r.type === 'vlan');
  assert.deepStrictEqual([sv.id, sv.found, sv.devices, sv.vlanDomains], [10, true, 3, 2], '搜尋結果帶 VLAN 片段數（結構化欄位，文字由畫面組成）');
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
test('Q.blockAt：依檔案與行號找到所屬的輸入區塊（設備、指令）', () => {
  const s = build(['SW_A (10.0.0.1):', '### /ip neighbor print detail without-paging', 'X', 'Y', 'SW_B (10.0.0.2):', '### /ip route print detail', 'Z'].join('\n'));
  const Q = S.query(s);
  const b = Q.blockAt('t.txt', 4);
  assert.deepStrictEqual([b.devKey, b.command, b.start <= 4 && 4 <= b.end], ['SW_A', '/ip neighbor print detail without-paging', true]);
  assert.strictEqual(b, Q.block(b.id), '回傳的就是 Q.block 的同一個物件');
  assert.strictEqual(Q.blockAt('t.txt', 7).devKey, 'SW_B');
  assert.strictEqual(Q.blockAt('t.txt', 1), null, '設備標頭不屬於任何區塊');
  assert.strictEqual(Q.blockAt('其他.txt', 4), null);
});
test('路由追蹤：終點或起點是未收集的設備時是「無法驗證」，不是無法抵達；已收集設備上斷掉仍是無法抵達', () => {
  const a = 'R_A (10.0.0.1):\n### /export terse\n/ip address add address=10.0.0.1/24 interface=ether1\n/ip address add address=10.1.0.1/24 interface=ether2\n'
    + '### /ip route print detail\nFlags: A - ACTIVE; s - STATIC\n 0 As dst-address=0.0.0.0/0 gateway=10.0.0.2 distance=1\n 1 As dst-address=10.94.0.0/16 blackhole\n'
    + '### /ip neighbor print detail\n 0 interface=ether1 identity=ISP_GW address=10.0.0.2 mac-address=AA:BB:CC:00:00:02 interface-name=ge0 discovered-by=lldp\n';
  const Q = S.query(build(a));
  // 中途／終點：預設路由的下一跳是未收集的 ISP_GW，查不到它的路由表
  const t = S.trace(Q, '10.1.0.5', '8.8.8.8');
  assert.deepStrictEqual([t.reached, t.status, t.ends.map((e) => [e.dev, e.status])], [false, 'unverified', [['ISP_GW', 'unverified']]]);
  assert.deepStrictEqual(t.unverified, ['ISP_GW']);
  assert.ok(t.ends[0].note.includes('ISP_GW') && t.ends[0].note.includes('未收集'), t.ends[0].note);
  // 起點（回程常見）：來源 IP 屬於未收集的設備
  const back = S.trace(Q, '10.0.0.2', '10.1.0.5');
  assert.deepStrictEqual([back.start, back.status, back.ends.map((e) => e.status)], ['ISP_GW', 'unverified', ['unverified']]);
  // 已收集的設備上斷掉：黑洞、直連抵達維持原狀態
  const bh = S.trace(Q, '10.1.0.5', '10.94.1.1');
  assert.deepStrictEqual([bh.status, bh.ends.map((e) => e.status), bh.unverified], ['unreachable', ['blackhole'], []]);
  const ok = S.trace(Q, '10.1.0.5', '10.0.0.9');
  assert.deepStrictEqual([ok.status, ok.reached, ok.unverified], ['reached', true, []]);
  // 範例：下一跳不在基準內仍是無法抵達
  const QS = S.query(build(read('samples/sample-bundle.txt')));
  assert.strictEqual(S.trace(QS, '10.1.30.15', '8.8.8.8').status, 'unreachable');
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
 * 會碰撞的情況：每項檢查一份輸入，在 2.9.0 之前（不含 facet）會有兩筆以上 id＋實體相同的 finding。
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

test('facet：仍會碰撞的規則（I01、I03 依輸入區塊，不是比對對象）不帶 facet，以多重集合處理', () => {
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

test('收集完整度：Q.coverageSummary 的網路設備口徑與 C01／C02 一致，主機另計', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s); const sum = Q.coverageSummary();
  const by = (id) => s.findings.filter((f) => f.id === id).length;
  assert.strictEqual(sum.devices, s.meta.stats.devices); assert.strictEqual(sum.collected, s.meta.stats.collected);
  assert.strictEqual(sum.network - sum.networkCollected, by('C01'), '未收集的網路設備數應等於 C01 筆數');
  assert.strictEqual(sum.missing, by('C02'), '缺必要資料或收集失敗的台數應等於 C02 筆數');
  assert.strictEqual(sum.networkCollected, sum.collected, '已收集的設備都屬應收集的範圍');
  assert.strictEqual(sum.network + sum.hosts, sum.devices);
  assert.ok(sum.hosts > 0 && by('C01') > 0, '範例資料有主機與未收集的網路設備');
  assert.ok(s.coverage.filter((r) => !S.check.expectsCollection(r)).every((r) => r.kind === 'host' && !r.collected), '不在收集範圍的只有未收集的主機');
  assert.ok(Object.isFrozen(sum) && Q.coverageSummary() === sum);
  // 由命名規則判為主機、但已收集的設備仍算應收集（C02 會檢查它）
  const text = 'SW_A (10.0.0.1):\n### /interface print detail\n 0 R name=ether1 type=ether\n'
    + 'HOST_B (10.0.0.2):\n### /interface print detail\n 0 R name=eth0 type=ether\n';
  const h = S.query(build(text, { profile: { id: 'test-host', classify: [{ match: '^HOST_B$', kind: 'host' }] } })).coverageSummary();
  assert.deepStrictEqual([h.network, h.networkCollected, h.hosts], [2, 2, 0]);
});

test('收集完整度：Q.coverageGap 逐列判斷「已收集但有缺漏」，coverageSummary().missing 是它的台數', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  assert.strictEqual(Q.coverage().filter(Q.coverageGap).length, Q.coverageSummary().missing);
  assert.ok(Q.coverageSummary().missing > 0, '範例資料有已收集但有缺漏的設備');
  const row = (o) => Object.assign({ collected: true, missing: [], failures: [] }, o);
  assert.strictEqual(Q.coverageGap(row({})), false, '資料齊全、沒有失敗');
  assert.strictEqual(Q.coverageGap(row({ missing: ['vlan'] })), true, '缺少應收集的資料');
  assert.strictEqual(Q.coverageGap(row({ failures: [{ reason: 'timeout' }] })), true, '只有收集失敗、沒有缺少也算');
  assert.strictEqual(Q.coverageGap(row({ failures: undefined })), false, '沒有 failures 欄位時視為沒有失敗');
  assert.strictEqual(Q.coverageGap(row({ collected: false, missing: ['vlan'] })), false, '未收集的設備不算「有缺漏」（屬 C01）');
});

test('待處理：Q.pendingSummary 只算錯誤＋警告，提醒另列，依處理紀錄排除已處理', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  const by = (sev) => s.findings.filter((f) => f.severity === sev).length;
  const all = Q.pendingSummary();
  assert.deepStrictEqual(Object.assign({}, all), { error: by('error'), warn: by('warn'), info: by('info'), total: by('error') + by('warn'), handled: 0 });
  assert.ok(Object.isFrozen(all) && all.info > 0 && all.total > 0, '範例資料有錯誤、警告與提醒');
  // 處理紀錄：剛推進的一輪全部是 open（待處理）；處理紀錄的 pending 不分嚴重度（含提醒）
  const NOW = '2026-01-01T00:00:00Z';
  let lg = S.ledger.advance(S.ledger.empty(), Q, { now: NOW }).ledger;
  const statusOf = (l) => (f) => S.ledger.isPending((l.items[Q.findingKey(f)] || {}).status);
  assert.deepStrictEqual(Q.pendingSummary(statusOf(lg)), all);
  const keys = new Set(s.findings.map((f) => Q.findingKey(f)));
  assert.strictEqual(S.ledger.summary(lg).series[0].pending, keys.size, '處理紀錄每一輪的 pending 含提醒（與 Q.pendingSummary().total 不同口徑）');
  // 一筆警告標為誤報：total 減一、handled 加一；一筆提醒標為誤報：只有 info 減一
  const w = s.findings.find((f) => f.severity === 'warn' && Q.findingIndexesByKey(Q.findingKey(f)).length === 1);
  const inf = s.findings.find((f) => f.severity === 'info' && Q.findingIndexesByKey(Q.findingKey(f)).length === 1);
  lg = S.ledger.set(lg, Q.findingKey(w), { status: 'false-positive' }, { now: NOW });
  lg = S.ledger.set(lg, Q.findingKey(inf), { status: 'false-positive' }, { now: NOW });
  const p = Q.pendingSummary(statusOf(lg));
  assert.deepStrictEqual([p.total, p.warn, p.handled, p.info], [all.total - 1, all.warn - 1, 1, all.info - 1]);
  // 待處理的規則只在 S.ledger.isPending
  assert.deepStrictEqual(S.ledger.STATUS.filter((x) => S.ledger.isPending(x)), S.ledger.PENDING);
  assert.ok(S.ledger.isPending(null) && S.ledger.isPending(undefined), '不在處理紀錄中也算待處理');
  assert.throws(() => Q.pendingSummary('open'), TypeError);
});

test('VLAN 摘要：Q.vlanSummary 的相異 ID、不相連區塊與定義筆數分開計', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s); const v = Q.vlanSummary();
  const ids = new Set(s.model.vlans.map((x) => x.id));
  assert.deepStrictEqual(Object.assign({}, v), { ids: ids.size, domains: Array.from(ids).reduce((n, id) => n + Q.vlan(id).domains.length, 0), definitions: s.meta.stats.vlans });
  assert.strictEqual(v.ids, Q.inventory().counts.vlanIds);
  assert.ok(v.ids < v.definitions && v.ids <= v.domains, '範例的 VLAN 定義分散在多台設備');
  assert.ok(Object.isFrozen(v));
});

test('查詢：搜尋支援 IP 前綴（先網段後 IP）、MAC 前綴（任一分隔符）與介面名稱', () => {
  const Q = S.query(build(read('samples/sample-bundle.txt')));
  const ips = Q.ipEntries();
  const r1 = Q.search('10.1.', 200);
  assert.ok(r1.length > 0 && r1.every((r) => r.type === 'ip' || r.type === 'subnet'), JSON.stringify(r1.slice(0, 3)));
  assert.ok(r1.every((r) => r.key.startsWith('10.1.')), '只列出以 10.1. 開頭的 IP／網段');
  const firstIp = r1.findIndex((r) => r.type === 'ip');
  assert.ok(firstIp > 0 && r1.slice(firstIp).every((r) => r.type === 'ip'), '網段排在 IP 前面');
  const graph = Q.subnetGraph().subnets.map((x) => x.id);
  assert.ok(r1.filter((r) => r.type === 'subnet').every((r) => graph.includes(r.key)), '網段結果的 key 是子網 id');
  const want = S.util.uniq(ips.filter((e) => e.ip.startsWith('10.1.')).map((e) => e.ip));
  assert.deepStrictEqual(r1.filter((r) => r.type === 'ip').map((r) => r.key), want, 'IP 結果與 IP 清單相同（同一個位址不分 VRF 只列一次）');
  assert.strictEqual(Q.search('10.1.', 5).length, 5, '數量上限沿用');
  assert.deepStrictEqual(Q.search('10.9.').filter((r) => r.type === 'ip' || r.type === 'subnet'), [], '沒有符合的前綴時不列 IP');
  assert.deepStrictEqual(Q.search('10.1').map((r) => r.key), Q.search('10.1.').map((r) => r.key), '結尾的點可省略');
  const macs = Q.macEntries().filter((e) => e.mac.startsWith('04421A'));
  assert.ok(macs.length > 0);
  for (const q of ['04:42', '04-42-1a', '0442.1a', '04421A']) {
    const r = Q.search(q, 50).filter((x) => x.type === 'mac');
    assert.ok(r.length > 0 && r.every((x) => x.key.startsWith('04421A')), q + ' 應以正規化後的前綴比對 MAC');
    assert.ok(macs.some((e) => e.mac === r[0].key), q);
  }
  assert.deepStrictEqual(Q.search('10').filter((r) => r.type === 'mac'), [], '純數字不當 MAC 前綴（保留給 VLAN／IP）');
  const ifcs = Q.search('ether10', 50).filter((r) => r.type === 'interface');
  assert.ok(ifcs.length > 0 && ifcs.every((r) => Q.getInterface(r.key) && Q.getInterface(r.key).name.toLowerCase().includes('ether10')), JSON.stringify(ifcs.slice(0, 3)));
  assert.ok(Q.search('to TPE_ACC_SW_01').some((r) => r.type === 'interface'), '介面描述仍可搜尋');
});

test('查詢：搜尋只回傳結構化欄位（不組顯示文字），VLAN 接受「vlan 30」「VLAN30」，以 0 開頭的數字不當 VLAN', () => {
  const Q = S.query(build(read('samples/sample-bundle.txt')));
  for (const q of ['30', 'vlan 30', 'VLAN30', 'Vlan  30']) {
    const v = Q.search(q, 50).filter((r) => r.type === 'vlan');
    assert.deepStrictEqual(v.map((r) => [r.key, r.label, r.id]), [['30', 'VLAN 30', 30]], q);
    assert.strictEqual(v[0].devices, Q.vlan(30).devices.length, q);
    assert.strictEqual(v[0].vlanDomains, Q.vlan(30).domains.length, q);
  }
  assert.deepStrictEqual(Q.search('0442').filter((r) => r.type === 'vlan'), [], '以 0 開頭（MAC 片段）不當 VLAN');
  assert.deepStrictEqual(Q.search('vlan 4095').filter((r) => r.type === 'vlan'), [], '超出 1–4094 不當 VLAN');
  const none = Q.search('3999').find((r) => r.type === 'vlan');
  assert.strictEqual(none.found, false, '基準中沒有的 VLAN 仍列出、found 為 false');
  const all = ['core_rt', 'ether10', '10.1.', '04:42', '10', '10.1.30.15', 'aa:aa:aa:aa:aa:aa', 'to TPE_ACC_SW_01'].flatMap((q) => Q.search(q, 50));
  assert.ok(all.length && all.every((r) => !('sub' in r)), '不回傳 sub（顯示文字由畫面組成）');
  const dev = Q.search('core_rt').find((r) => r.type === 'device');
  assert.deepStrictEqual([dev.kind, dev.mgmtIp, dev.collected], [Q.getDevice(dev.key).kind, Q.getDevice(dev.key).mgmtIp, true]);
  const ifc = Q.search('ether10').find((r) => r.type === 'interface'); const raw = Q.getInterface(ifc.key);
  assert.deepStrictEqual([ifc.match, ifc.ifType, ifc.status], ['name', raw.type, raw.status]);
  assert.strictEqual(Q.search('to TPE_ACC_SW_01').find((r) => r.type === 'interface').match, 'desc');
  const mac = Q.search('aa:aa:aa:aa:aa:aa')[0];
  assert.deepStrictEqual([mac.type, mac.found], ['mac', false]);
  const ip = Q.search('10.1.30.15').find((r) => r.type === 'ip');
  assert.ok(ip.found && Array.isArray(ip.macs) && Array.isArray(ip.vrfs), JSON.stringify(ip));
  assert.strictEqual(Q.search('203.0.113.250')[0].found, false);
});

test('查詢：Q.blockAt 依檔案與行號取得所屬區塊', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  s.blocks.slice(0, 20).forEach((b) => {
    assert.strictEqual(Q.blockAt(b.file, b.start), b); assert.strictEqual(Q.blockAt(b.file, b.end), b);
    assert.strictEqual(Q.blockAt(b.file, b.start), Q.block(b.id), '與 block(id) 是同一個物件');
  });
  assert.strictEqual(Q.blockAt('t.txt', 1), null, '第 1 行是設備標頭，不在區塊內');
  assert.strictEqual(Q.blockAt('沒有這個檔案.txt', s.blocks[0].start), null);
});

test('查詢介面：檢查目錄、資料類別、解析器名稱與 VLAN 文字（靜態，不需要 Snapshot）', () => {
  const C = S.check.CATALOG;
  assert.deepStrictEqual(S.query.rules().map((r) => r.id), Object.keys(C), '依 CATALOG 的宣告順序');
  S.query.rules().forEach((r) => {
    assert.strictEqual(S.query.rule(r.id), r);
    const { id, hint, ...rest } = r; assert.deepStrictEqual(rest, C[id], `${id} 的內容與 CATALOG 相同`);
    assert.ok(C[id].action.startsWith(hint), `${id} 的 hint 是 action 的第一句`);
  });
  assert.strictEqual(S.query.rule('ZZ99'), null); assert.strictEqual(S.query.rule('toString'), null);
  // 凍結：呼叫端改不到目錄（含巢狀的 data、causes）
  const k01 = S.query.rule('K01');
  assert.ok(Object.isFrozen(S.query.rules()) && Object.isFrozen(k01) && Object.isFrozen(k01.causes) && Object.isFrozen(C.K01) && Object.isFrozen(C.K01.causes));
  assert.throws(() => { 'use strict'; k01.title = 'x'; }, TypeError);
  assert.throws(() => { 'use strict'; C.K01.causes.push('x'); }, TypeError);
  assert.ok(Object.values(C).every((c) => !c.data || (Object.isFrozen(c.data) && c.data.every(Object.isFrozen))));
  // 資料類別：每項檢查需要的資料都有名稱；不認得的原樣回傳
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

test('檢查規則的處理提示：hint 是 action 的第一句，約 40 字寬、無連結，ruleStatus 帶出同一句', () => {
  // 寬度：全形字算 1、半形（ASCII）算 0.5，反引號不算；上限 40。hint 只有句尾一個「。」，與文件「處理」第一句一致（tests/docs.js）
  const width = (s) => Array.from(s.replace(/`/g, '')).reduce((n, c) => n + (c.charCodeAt(0) < 128 ? 0.5 : 1), 0);
  S.query.rules().forEach((r) => {
    assert.strictEqual(typeof r.hint, 'string', `${r.id} 缺少 hint（action 的第一句）`);
    assert.strictEqual(r.hint, r.action.slice(0, r.action.indexOf('。') + 1), `${r.id} 的 hint 應為 action 到第一個「。」`);
    assert.ok(width(r.hint) <= 40, `${r.id} 的處理提示太長（寬度 ${width(r.hint)}）：${r.hint}`);
    assert.ok(!/https?:|\]\(|\n/.test(r.hint), `${r.id} 的處理提示不放連結`);
    assert.strictEqual((r.hint.match(/`/g) || []).length % 2, 0, `${r.id} 的處理提示反引號要成對`);
  });
  const Q = S.query(build(read('samples/sample-bundle.txt')));
  Q.ruleStatus().forEach((r) => assert.strictEqual(r.hint, S.query.rule(r.id).hint, r.id));
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
  const srv = os.filter((r) => r.reason !== 'unfiltered');
  assert.ok(srv.length > 0 && srv.every((r) => r.reason === 'peer-uncollected' && [r.a, r.b].some((x) => x.has === null)), '範例的伺服器只由 LLDP 看到');
  // 範例的 TPE_LAB_SW_01 沒有開 vlan-filtering：與 Q.vlan(id).transparent 同一組，未過濾的一端無從得知
  [10, 20].forEach((id) => {
    const un = Q.vlanCarriers(id).links.filter((r) => r.reason === 'unfiltered');
    assert.deepStrictEqual(un.map((r) => r.key), ['TPE_BR_SW_01|ether2~TPE_LAB_SW_01|ether1'], `VLAN ${id}`);
    assert.deepStrictEqual(un.map((r) => r.key), Q.vlan(id).transparent.map((l) => l.key));
    assert.deepStrictEqual([un[0].a.has, un[0].b.has], [true, null]);
  });
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

test('L3 子網圖：子網、設備與「有位址」的邊都帶 vrf（只用 main 時都是 main，id 不加後綴）；標示路由設備、重疊網段與重複 IP', () => {
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
  // vrf：每個節點、邊、子網與路由都有；只用 main 的網路都是 main
  const r = Q.subnetGraph({ routes: true });
  [r.subnets, r.nodes, r.edges, r.routes].forEach((list) => list.forEach((x) => assert.ok(x.vrf === 'main', JSON.stringify(x))));
  assert.deepStrictEqual(r.omitted, { policyRoutes: 0 });
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
  assert.deepStrictEqual(g.subnets.filter((x) => x.basis === 'connected').map((x) => x.id), s.model.prefixes.map((p) => p.key), '每個 prefixes（每個 VRF 的每個網段）一個子網');
  assert.deepStrictEqual(g.nodes.filter((n) => n.router).map((n) => n.id), ['TPE_BR_RT_01', 'TPE_CE_RT_01', 'TPE_CORE_RT_01', 'TPE_CORE_RT_02', 'TPE_PE_RT_01', 'TPE_PE_RT_01@cust-a'], 'PE 在 main 與 cust-a 各一個節點');
  const sw11 = g.nodes.find((n) => n.id === 'TPE_ACC_SW_11');
  assert.deepStrictEqual([sw11.multihomed, sw11.router], [true, false], '交換器在兩個網段有位址，但沒有路由表，不算路由設備');
  assert.ok(g.subnets.find((x) => x.id === '10.1.10.0/24').overlaps.includes('10.1.10.0/25'));
  const nb = g.edges.find((e) => e.basis === 'neighbor');
  assert.ok(nb && nb.inferred && nb.addresses.every((a) => a.hearsay && a.src.length), '鄰居宣告的位址只接到已知網段，標為推論');
  const mg = g.edges.filter((e) => e.basis === 'mgmt');
  assert.ok(mg.length && mg.every((e) => e.inferred && e.addresses.every((a) => a.seenBy.length)), '只由鄰居看到的設備，以 seenBy 追溯');
  // 自有位址的邊恰好對應 prefixes 的 eps
  s.model.prefixes.forEach((p) => assert.deepStrictEqual(g.edges.filter((e) => e.subnet === p.key && e.basis === 'address').flatMap((e) => e.eps).sort(), p.eps.slice().sort(), p.key));
  const off = Q.subnetGraph({ hearsay: false });
  assert.ok(off.edges.every((e) => !e.inferred));
});

test('與多數不同的索引：Q.deviationsOf 列出設備出現在 deviation.deviating 的 finding 索引（依 Snapshot 順序、凍結）', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  const devs = S.util.uniq(s.findings.flatMap((f) => (f.deviation ? f.deviation.deviating : [])));
  assert.ok(devs.length, '範例資料應有被多數決判定與多數不同的設備');
  devs.forEach((d) => {
    const want = s.findings.map((f, i) => (f.deviation && f.deviation.deviating.includes(d) ? i : -1)).filter((i) => i >= 0);
    assert.deepStrictEqual(Array.from(Q.deviationsOf(d)), want, d);
    assert.ok(Object.isFrozen(Q.deviationsOf(d)), '回傳 Q 自己的索引，凍結');
  });
  // 不在任何 deviating 的設備（含平手的 finding 的實體）為空陣列
  assert.deepStrictEqual(Array.from(Q.deviationsOf('NO_SUCH_DEV')), []);
  const clean = s.model.devices.find((d) => !devs.includes(d.key));
  assert.ok(clean && Q.deviationsOf(clean.key).length === 0);
});
test('Q.devLabel：只由鄰居得知、名稱是 IP 的設備加上來源協定；其他維持 Q.devName', () => {
  const Q = S.query(sampleSnap());
  assert.strictEqual(Q.devLabel('TPE_CORE_RT_01'), Q.devName('TPE_CORE_RT_01'), '已收集的設備維持原名');
  assert.strictEqual(Q.getDevice('172.31.255.2').collected, false);
  assert.strictEqual(Q.devLabel('172.31.255.2'), '172.31.255.2（OSPF 鄰居）', '只由 OSPF 得知');
  assert.strictEqual(Q.devName('172.31.255.2'), '172.31.255.2', 'devName 維持原值');
  const Q2 = S.query(build(['SW_A (10.0.0.1):', NB([
    ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=SW_B interface-name=ether1 discovered-by=lldp',
    ' 1 interface=ether2 mac-address=AA:00:00:00:00:03 identity=10.9.9.9 interface-name=ether1 discovered-by=lldp,mndp',
    ' 2 interface=ether3 mac-address=AA:00:00:00:00:04 identity=10.9.9.8 interface-name=ether1 discovered-by=mndp']),
  ].join('\n')));
  assert.strictEqual(Q2.getDevice('SW_B').collected, false);
  assert.strictEqual(Q2.devLabel('SW_B'), 'SW_B', '未收集但名稱不是位址：維持原名');
  assert.strictEqual(Q2.devLabel('10.9.9.9'), '10.9.9.9（LLDP／MNDP 鄰居）', '多種來源依固定順序列出');
  assert.strictEqual(Q2.devLabel('10.9.9.8'), '10.9.9.8（MNDP 鄰居）');
  assert.strictEqual(Q2.devLabel('NOPE'), 'NOPE', '找不到設備時回傳鍵（同 devName）');
});
