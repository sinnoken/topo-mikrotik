// L3（S.trace）與 L4（Q.reach）的路由結果對照（ADR-023 決策 3）：同一份基準、同一對位址，兩邊的起點、逐跳與結束原因要一致；
// L4 只多了防火牆。每個情境同時呼叫兩者，結果寫成一列表格，不一致的地方明確標出（PENDING：預期在走法統一時改變）。
'use strict';
const assert = require('assert');
const { S, build, read, test } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/**
 * 三台：A0（192.168.1.254，只有直連）、R1（LAN 192.168.1.1、對 R2 的 10.0.12.1/30、WAN 198.51.100.2/30）、R2（LAN 192.168.2.1）。
 * opt：dhcp（R1 的 DHCP 閘道）、wan（R1 的 WAN 清單與預設路由）、r1（R1 另加的路由列）、r2（R2 另加的路由列）。
 */
function net(opt) {
  const o = opt || {};
  return S.query(build([
    'A0 (192.168.1.254):', '### /export terse',
    '/ip address add address=192.168.1.254/24 interface=ether1 network=192.168.1.0',
    '### /ip route print detail without-paging', RT,
    ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=ether1 distance=0',
    '',
    'R1 (10.0.12.1):', '### /export terse',
    ...(o.wan ? ['/interface list add name=WAN', '/interface list member add interface=ether3 list=WAN'] : []),
    '/ip address add address=192.168.1.1/24 interface=ether1 network=192.168.1.0',
    '/ip address add address=10.0.12.1/30 interface=ether2 network=10.0.12.0',
    '/ip address add address=198.51.100.2/30 interface=ether3 network=198.51.100.0',
    ...(o.dhcp ? ['/ip dhcp-server network add address=192.168.1.0/24 gateway=192.168.1.1'] : []),
    ...(o.fw || []),
    '### /ip route print detail without-paging', RT,
    ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=ether1 distance=0',
    ' DAc dst-address=10.0.12.0/30 routing-table=main gateway=ether2 distance=0',
    ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether3 distance=0',
    ' As dst-address=192.168.2.0/24 routing-table=main gateway=10.0.12.2 distance=1',
    ...(o.wan ? [' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1'] : []),
    ...(o.r1 || []),
    '### /ip neighbor print detail',
    ' 0 interface=ether2 identity=R2 address=10.0.12.2 mac-address=AA:BB:CC:00:00:02 interface-name=ether2 discovered-by=lldp',
    ...(o.r2 === null ? [] : [
      '',
      'R2 (10.0.12.2):', '### /export terse',
      '/ip address add address=192.168.2.1/24 interface=ether1 network=192.168.2.0',
      '/ip address add address=10.0.12.2/30 interface=ether2 network=10.0.12.0',
      '### /ip route print detail without-paging', RT,
      ' DAc dst-address=192.168.2.0/24 routing-table=main gateway=ether1 distance=0',
      ' DAc dst-address=10.0.12.0/30 routing-table=main gateway=ether2 distance=0',
      ' As dst-address=192.168.1.0/24 routing-table=main gateway=10.0.12.1 distance=1',
      ...(o.r2 || []),
    ]),
  ].join('\n')));
}
/** 兩邊的結果摘要：L3 的整體狀態與每個終點（狀態:設備），L4 的結論、起點的設備與每條路徑的結束代碼（代碼:設備）。 */
function pair(Q, src, dst) {
  const t = S.trace(Q, src, dst);
  const r = Q.reach(src, dst, { proto: 'tcp', port: 22 });
  const startsOf = (x) => (x.start.gateways && x.start.gateways.length ? x.start.gateways.map((g) => g.dev) : x.start.dev ? [x.start.dev] : []);
  return {
    l3: t.ok ? { status: t.status, start: t.start, ends: t.ends.map((e) => e.status + ':' + e.dev) } : { error: true },
    l4: r.ok ? { verdict: r.verdict, starts: startsOf(r), ends: r.paths.map((p) => p.end.code + ':' + p.end.dev) } : { error: true },
  };
}

test('單跳轉送決定只讀路由視圖（S.trace.ROUTING_VIEW）：Q 提供全部成員；只有這些成員的物件得到相同結果', () => {
  const Q = net({ dhcp: true, wan: true });
  S.trace.ROUTING_VIEW.forEach((k) => assert.strictEqual(typeof Q[k], 'function', k));
  const R = S.trace.routingOf(Q);
  assert.strictEqual(S.trace.routingOf(Q), R, '每個 Q 一份');
  assert.deepStrictEqual(Object.keys(R), S.trace.ROUTING_VIEW.slice());
  const only = {}; S.trace.ROUTING_VIEW.forEach((k) => { only[k] = (...a) => Q[k](...a); });
  ['192.168.2.10', '8.8.8.8', '192.168.1.9'].forEach((dst) => {
    const a = S.trace.routeDecision(R, 'R1', { src: '192.168.1.50', dst, vrf: 'main', inEp: 'R1|ether1' });
    const b = S.trace.routeDecision(only, 'R1', { src: '192.168.1.50', dst, vrf: 'main', inEp: 'R1|ether1' });
    assert.deepStrictEqual([a.kind, a.route, a.vrf], [b.kind, b.route, b.vrf], dst);
  });
  assert.strictEqual(S.trace.nextOwner(R, 'R1', '10.0.12.2', 'main').dev, 'R2');
});

test('L3／L4 對照：DHCP 閘道明確、沒有防火牆時，起點、終點相同（抵達＝送達網段）', () => {
  const x = pair(net({ dhcp: true }), '192.168.1.50', '192.168.2.10');
  assert.deepStrictEqual(x, {
    l3: { status: 'reached', start: 'R1', ends: ['reached:R2'] },
    l4: { verdict: 'allow', starts: ['R1'], ends: ['segment:R2'] },
  });
});

test('L3／L4 對照：路由迴圈與黑洞，兩邊都停在同一台設備（迴圈：第一台重複經過的設備，不看入介面）', () => {
  const loop = pair(net({ dhcp: true, r1: [' As dst-address=192.168.7.0/24 routing-table=main gateway=10.0.12.2 distance=1'], r2: [' As dst-address=192.168.7.0/24 routing-table=main gateway=10.0.12.1 distance=1'] }), '192.168.1.50', '192.168.7.1');
  assert.deepStrictEqual(loop.l3, { status: 'unreachable', start: 'R1', ends: ['loop:R1'] });
  assert.deepStrictEqual([loop.l4.verdict, loop.l4.ends], ['deny', ['loop:R1']]);
  const bh = pair(net({ dhcp: true, r1: [' As dst-address=192.168.2.0/25 routing-table=main blackhole distance=1'] }), '192.168.1.50', '192.168.2.10');
  assert.deepStrictEqual(bh.l3, { status: 'unreachable', start: 'R1', ends: ['blackhole:R1'] });
  assert.deepStrictEqual([bh.l4.verdict, bh.l4.ends], ['deny', ['blackhole:R1']]);
});

test('L3／L4 對照：下一跳是未收集的設備時兩邊都是不明（L3 無法驗證、L4 device-uncollected）', () => {
  const x = pair(net({ dhcp: true, r2: null }), '192.168.1.50', '192.168.2.10');
  assert.deepStrictEqual(x.l3, { status: 'unverified', start: 'R1', ends: ['unverified:R2'] });
  assert.deepStrictEqual([x.l4.verdict, x.l4.ends], ['unknown', ['device-uncollected:R2']]);
});

test('L3／L4 對照：下一跳不在基準、出介面不是 WAN 時，兩邊都不能判斷（L3 unknown-nh、L4 next-hop-outside）', () => {
  const x = pair(net({ dhcp: true, r1: [' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1'] }), '192.168.1.50', '8.8.8.8');
  assert.deepStrictEqual(x.l3, { status: 'unreachable', start: 'R1', ends: ['unknown-nh:R1'] });
  assert.deepStrictEqual([x.l4.verdict, x.l4.ends], ['unknown', ['next-hop-outside:R1']]);
});

// 稽核（2026-11-06）找到的兩個不一致，走法統一之後兩邊同一個規則
test('L3／L4 對照：經 WAN 預設路由送往基準以外——兩邊都是送往外部（推論；L3 egress／external，L4 egress-wan）', () => {
  const x = pair(net({ dhcp: true, wan: true }), '192.168.1.50', '8.8.8.8');
  assert.deepStrictEqual(x.l3, { status: 'external', start: 'R1', ends: ['egress:R1'] });
  assert.deepStrictEqual([x.l4.verdict, x.l4.ends], ['allow', ['egress-wan:R1']]);
});
test('L3／L4 對照：同網段兩台路由器、沒有 DHCP 閘道——兩邊都把兩台當起點（主機用哪一個閘道無法判斷，不依輸入順序挑一台）', () => {
  const x = pair(net({}), '192.168.1.50', '192.168.2.10');
  // L3：至少一個分支抵達就是抵達，另一個分支的「沒有路由」照列；L4：兩個起點的結果不同，結論不明
  assert.deepStrictEqual(x.l3, { status: 'reached', start: 'A0', ends: ['noroute:A0', 'reached:R2'] });
  assert.deepStrictEqual(x.l4, { verdict: 'unknown', starts: ['A0', 'R1'], ends: ['no-route:A0', 'segment:R2'] });
  const t = S.trace(net({}), '192.168.1.50', '192.168.2.10');
  assert.deepStrictEqual([t.starts, t.startBasis], [['A0', 'R1'], 'routes']);
  // 有 DHCP 閘道時只有那一台
  assert.deepStrictEqual(S.trace(net({ dhcp: true }), '192.168.1.50', '192.168.2.10').starts, ['R1']);
});

// ---- 結果分層：先路由、再防火牆（ADR-023 決策 4）
const layers = (r) => r.paths.map((p) => [p.route.status, p.route.code, p.filter.status]);
const DROP_FWD = '/ip firewall filter add action=drop chain=forward dst-address=192.168.2.0/24';

test('分層結果：路由到了、防火牆擋下——route reached、filter deny（附擋下的規則）；L3 照樣抵達', () => {
  const Q = net({ dhcp: true, fw: [DROP_FWD] });
  const r = Q.reach('192.168.1.50', '192.168.2.10', { proto: 'tcp', port: 22 });
  assert.deepStrictEqual([r.verdict, layers(r)], ['deny', [['reached', 'segment', 'deny']]]);
  const rule = Q.snapshot.model.firewallRules.find((x) => x.dev === 'R1' && x.chain === 'forward');
  assert.strictEqual(r.paths[0].filter.rule.key, rule.key);
  assert.deepStrictEqual(r.paths[0].route.reasons, []);
  assert.strictEqual(S.trace(Q, '192.168.1.50', '192.168.2.10').status, 'reached', 'L3 不看防火牆');
});

test('分層結果：路由沒到時防火牆是 n/a——黑洞在擋下之前（R1 本身）與之後（擋下的那一跳之後只看路由，R2 沒有路由）都算路由沒到', () => {
  const bh = net({ dhcp: true, fw: [DROP_FWD], r1: [' As dst-address=192.168.2.0/25 routing-table=main blackhole distance=1'] })
    .reach('192.168.1.50', '192.168.2.10', { proto: 'tcp', port: 22 });
  assert.deepStrictEqual([bh.verdict, layers(bh)], ['deny', [['blackhole', 'blackhole', 'n/a']]]);
  // R1 有往 192.168.5.0/24 的路由、轉送時被擋；只看路由的話 R2 沒有這個網段的路由
  const Q = net({ dhcp: true, fw: ['/ip firewall filter add action=drop chain=forward dst-address=192.168.5.0/24'], r1: [' As dst-address=192.168.5.0/24 routing-table=main gateway=10.0.12.2 distance=1'] });
  const nr = Q.reach('192.168.1.50', '192.168.5.10', { proto: 'tcp', port: 22 });
  assert.deepStrictEqual([nr.verdict, nr.paths.map((p) => p.end.code), layers(nr)], ['deny', ['dropped'], [['no-route', 'no-route', 'n/a']]]);
  assert.strictEqual(nr.paths[0].route.reasons[0].dev, 'R2');
  const t = S.trace(Q, '192.168.1.50', '192.168.5.10');
  assert.deepStrictEqual(t.ends.map((e) => e.status + ':' + e.dev), ['noroute:R2'], 'L3 的結果相同');
});

test('分層結果：送往外部是路由抵達（推論的層級是 assumption）；下一跳不在基準是路由不明、防火牆也不明', () => {
  const ext = net({ dhcp: true, wan: true }).reach('192.168.1.50', '8.8.8.8', { proto: 'tcp', port: 443 });
  assert.deepStrictEqual(layers(ext), [['reached', 'egress-wan', 'allow']]);
  const out = net({ dhcp: true, r1: [' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1'] }).reach('192.168.1.50', '8.8.8.8', { proto: 'tcp', port: 443 });
  assert.deepStrictEqual(layers(out), [['unknown', 'next-hop-outside', 'unknown']]);
  const byCode = new Map(S.query.reachReasonCodes().map((x) => [x.code, x.layer]));
  assert.deepStrictEqual(['egress-wan', 'next-hop-outside', 'dropped', 'nat-target', 'return-not-guaranteed'].map((c) => byCode.get(c)), ['assumption', 'route', 'filter', 'nat', 'assumption']);
});

test('原因代碼的層級：REASON_CODES 每筆都有 layer（route／filter／nat／assumption）', () => {
  S.query.reachReasonCodes().forEach((x) => assert.ok(['route', 'filter', 'nat', 'assumption'].includes(x.layer), JSON.stringify(x)));
});

test('分層計數：zone 矩陣的格子與暴露清單把拒絕分成路由沒到與防火牆擋下（稽核 E11：R1 加黑洞路由），合計等於原本的拒絕數', () => {
  const WANFW = [
    '/ip firewall filter add action=drop chain=input in-interface-list=WAN',
    '/ip firewall filter add action=drop chain=forward in-interface-list=WAN dst-address=192.168.2.128/25',
  ];
  const before = net({ dhcp: true, wan: true, fw: WANFW }).exposure();
  const after = net({ dhcp: true, wan: true, fw: WANFW, r1: [' As dst-address=192.168.2.0/25 routing-table=main blackhole distance=1'] }).exposure();
  ['self', 'dnat', 'routed'].forEach((k) => [before, after].forEach((x) => {
    const d = x.deniedBy[k];
    assert.strictEqual(d.noRoute + d.filter + d.notNatted, x.denied[k], `${k} 的合計`);
  }));
  assert.strictEqual(before.deniedBy.routed.noRoute, 0);
  assert.ok(after.deniedBy.routed.noRoute > 0 && after.deniedBy.routed.filter > 0, JSON.stringify(after.deniedBy));
  assert.ok(before.deniedBy.self.filter > 0, '設備本身被 input 擋下');
  const Q = net({ dhcp: true, wan: true, fw: WANFW, r1: [' As dst-address=192.168.2.0/25 routing-table=main blackhole distance=1'] });
  const mx = Q.zoneMatrix();
  mx.cells.forEach((c) => {
    assert.strictEqual(c.deniedBy.noRoute + c.deniedBy.filter, c.counts.deny, `${c.src} → ${c.dst}`);
    c.services.forEach((sv) => assert.strictEqual(sv.deniedBy.noRoute + sv.deniedBy.filter, sv.counts.deny));
  });
  assert.ok(mx.cells.some((c) => c.deniedBy.noRoute > 0) && mx.cells.some((c) => c.deniedBy.filter > 0));
});

test('閘道推定的依據：S.query.reachStartBases() 就是共用展開的 srcLocation 會產生的 basis（掃描 trace.js），Q.reach 的 start.basis 與 S.trace 的 startBasis 都在其中', () => {
  const list = S.query.reachStartBases();
  assert.ok(Object.isFrozen(list));
  const src = read('src/query/trace.js'); const i0 = src.indexOf('function srcLocation('); const i1 = src.indexOf('X = { RV', i0);
  assert.ok(i0 > 0 && i1 > i0, 'trace.js 找不到 srcLocation');
  const body = src.slice(i0, i1); const lits = (t) => Array.from(t.matchAll(/'([a-z][a-z-]*)'/g), (m) => m[1]);
  const found = new Set([...body.matchAll(/\bbasis\s*=\s*([^;]+);/g)].flatMap((m) => lits(m[1])).concat([...body.matchAll(/\bbasis\s*===\s*'([^']+)'/g)].map((m) => m[1])));
  assert.deepStrictEqual([...found].sort(), list.slice().sort());
  assert.ok(list.includes(net({}).reach('192.168.1.50', '192.168.2.10', { proto: 'tcp', port: 22 }).start.basis));
  assert.ok(list.includes(S.trace(net({ dhcp: true }), '192.168.1.50', '192.168.2.10').startBasis));
});
