// 對外邊界（model.boundaries、Q.boundaries）與路由網域（model.routingDomains、Q.routingDomains）：ADR-023 的推論，依路由證據判斷
'use strict';
const assert = require('assert');
const { S, build, gen, test, sampleSnap } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/** 沒有 WAN 清單的路由器 R：ether1 預設路由＋masquerade（公網位址）、ether2 只有公網位址、ether3 CGNAT 位址、ether4 只在 WAN 清單、bridge1 是 LAN。 */
const R = [
  'R (192.168.1.1):', '### /export terse',
  '/interface bridge add name=bridge1',
  '/interface list add name=ISP-WAN', '/interface list member add interface=ether4 list=ISP-WAN',
  '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0',
  '/ip address add address=81.2.3.2/30 interface=ether1 network=81.2.3.0',
  '/ip address add address=81.2.4.1/29 interface=ether2 network=81.2.4.0',
  '/ip address add address=100.64.1.2/30 interface=ether3 network=100.64.1.0',
  '/ip dhcp-client add disabled=yes interface=ether5',
  '/ip firewall nat add action=masquerade chain=srcnat out-interface=ether1',
  '/ip firewall nat add action=masquerade chain=srcnat dst-address=192.168.1.10 out-interface=bridge1',  // hairpin NAT：限了目的位址，弱證據
  '/ip firewall nat add action=dst-nat chain=dstnat disabled=yes in-interface=ether2 to-addresses=192.168.1.10', // 停用的規則不算
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=81.2.3.0/30 routing-table=main gateway=ether1 immediate-gw=ether1 distance=0',
  ' As  dst-address=0.0.0.0/0 routing-table=main gateway=81.2.3.1 immediate-gw=81.2.3.1%ether1 distance=1',
  '  s  dst-address=0.0.0.0/0 routing-table=main gateway=100.64.1.1 distance=10',  // 非作用中的備援預設路由：閘道在 ether3 的網段
];
/** R 的 LAN 上另一台路由器 R2：預設路由指向 R（基準內），不是對外。 */
const R2 = ['R2 (192.168.1.2):', '### /export terse', '/ip address add address=192.168.1.2/24 interface=ether1 network=192.168.1.0',
  '### /ip route print detail without-paging', RT, ' As  dst-address=0.0.0.0/0 routing-table=main gateway=192.168.1.1 immediate-gw=192.168.1.1%ether1 distance=1'];
const kinds = (b) => b.evidence.map((e) => `${e.kind}:${e.strength}`);

test('對外邊界：強證據（預設路由、srcnat 的出介面）單獨判定對外；公網／CGNAT 位址只是可能對外；WAN 清單名稱單獨仍判定對外；每項證據都有來源行', () => {
  const s = build(R.concat(R2).join('\n')); const Q = S.query(s);
  const of = (ifc) => Q.boundaryOf('R|' + ifc);
  assert.deepStrictEqual([of('ether1').status, kinds(of('ether1'))], ['external', ['default-route:strong', 'srcnat-out:strong', 'public-address:weak']]);
  assert.deepStrictEqual([of('ether2').status, kinds(of('ether2'))], ['possible', ['public-address:weak']]);
  // 非作用中的備援預設路由也是對外的證據（ref.active false）
  assert.deepStrictEqual([of('ether3').status, kinds(of('ether3'))], ['external', ['default-route:strong', 'cgnat-address:weak']]);
  assert.strictEqual(of('ether3').evidence[0].ref.active, false);
  assert.deepStrictEqual([of('ether4').status, kinds(of('ether4')), of('ether4').hasIfc], ['external', ['wan-list:weak'], false]);
  assert.deepStrictEqual([of('bridge1').status, kinds(of('bridge1')), of('bridge1').evidence[0].ref.reason], ['possible', ['srcnat-out:weak'], 'restricted-destination']);
  assert.deepStrictEqual([of('ether5').status, kinds(of('ether5'))], ['internal', ['dhcp-client:none']], '停用的 DHCP client 記下但不算');
  // 預設路由指向基準內的設備：不算對外
  assert.deepStrictEqual([Q.boundaryOf('R2|ether1').status, Q.boundaryOf('R2|ether1').evidence[0].ref.reason], ['internal', 'next-hop-in-baseline']);
  // 每項證據都回到輸入的行
  const lines = R.concat(R2);
  Q.boundaries().forEach((b) => b.evidence.forEach((e) => {
    assert.ok(e.src.length, `${b.ep} ${e.kind} 沒有來源行`);
    e.src.forEach(([blk, line]) => assert.ok(s.blocks[blk] && lines[line - 1] !== undefined, `${b.ep} ${e.kind} 的來源 ${blk}.${line}`));
  }));
  assert.deepStrictEqual(Q.boundaries('R').map((b) => b.ep), ['R|bridge1', 'R|ether1', 'R|ether2', 'R|ether3', 'R|ether4', 'R|ether5']);
  assert.ok(Object.isFrozen(Q.boundaries('R')) && Object.isFrozen(Q.boundaries()));
  assert.strictEqual(Q.boundaryOf('R|ether9'), null, '沒有證據的介面');
  // firewallZones 的語意不變：仍只看名稱含 WAN 的清單
  assert.deepStrictEqual(Q.firewallZone('R').wanInterfaces, ['R|ether4']);
  assert.deepStrictEqual(Q.wanEntries('R').map((w) => w.ep), ['R|ether4']);
});

test('對外邊界：dst-nat 的入介面是強證據、dst-address 是設備上的公網位址是弱證據；WAN 清單展開成員；可重現', () => {
  const t = ['G (10.0.0.1):', '### /export terse', '/interface list add name=WAN', '/interface list member add interface=ether1 list=WAN',
    '/ip address add address=81.2.3.2/30 interface=ether9 network=81.2.3.0',
    '/ip firewall nat add action=dst-nat chain=dstnat dst-port=80 in-interface-list=WAN protocol=tcp to-addresses=10.0.0.5',
    '/ip firewall nat add action=dst-nat chain=dstnat dst-address=81.2.3.2 dst-port=443 protocol=tcp to-addresses=10.0.0.5'].join('\n');
  const Q = S.query(build(t));
  assert.deepStrictEqual(kinds(Q.boundaryOf('G|ether1')), ['dstnat-in:strong', 'wan-list:weak']);
  assert.deepStrictEqual([Q.boundaryOf('G|ether9').status, kinds(Q.boundaryOf('G|ether9'))], ['possible', ['dstnat-address:weak', 'public-address:weak']]);
  assert.deepStrictEqual(build(t).model.boundaries, build(t).model.boundaries);
});

test('路由網域：OSPF interface-template（interfaces、networks）比對到的網段依「鄰接相連的設備 × area」分組；其他網段依共用網段的路由器分組；每個網段恰好一個網域', () => {
  const a = ['R_A (10.0.0.1):', '### /export terse',
    '/ip address add address=10.254.0.1/30 interface=ether48 network=10.254.0.0', '/ip address add address=10.1.1.1/24 interface=ether2 network=10.1.1.0',
    '/ip address add address=10.9.9.1/24 interface=ether3 network=10.9.9.0',
    '/routing ospf instance add name=default router-id=1.1.1.1', '/routing ospf area add area-id=0.0.0.0 instance=default name=backbone',
    '/routing ospf interface-template add area=backbone interfaces=ether48', '/routing ospf interface-template add area=backbone networks=10.1.1.0/24 passive',
    '### /routing ospf neighbor print detail', ' 0 instance=default area=backbone address=10.254.0.2 router-id=2.2.2.2 state=Full'];
  const b = ['R_B (10.0.0.2):', '### /export terse',
    '/ip address add address=10.254.0.2/30 interface=ether1 network=10.254.0.0', '/ip address add address=10.2.2.1/24 interface=ether2 network=10.2.2.0',
    '/ip address add address=10.9.9.2/24 interface=ether3 network=10.9.9.0',
    '/routing ospf instance add name=default router-id=2.2.2.2', '/routing ospf area add area-id=0.0.0.1 instance=default name=a1',
    '/routing ospf interface-template add area=a1 networks=10.2.2.0/24',
    '### /routing ospf neighbor print detail', ' 0 instance=default address=10.254.0.1 router-id=1.1.1.1 interface=ether1 state=Full'];
  const c = ['R_C (10.0.0.3):', '### /export terse', '/ip address add address=10.3.3.1/24 interface=ether1 network=10.3.3.0'];
  const s = build(a.concat(b, c).join('\n')); const Q = S.query(s);
  const dom = (p) => { const d = Q.routingDomainOf(p); return d && [d.key, d.kind, d.areaId, d.devices]; };
  assert.deepStrictEqual(dom('10.254.0.0/30'), ['ospf:R_A:0.0.0.0', 'ospf', '0.0.0.0', ['R_A', 'R_B']]);
  assert.deepStrictEqual(dom('10.1.1.0/24'), ['ospf:R_A:0.0.0.0', 'ospf', '0.0.0.0', ['R_A', 'R_B']], 'devices 是整個網域的設備');
  assert.deepStrictEqual(dom('10.2.2.0/24'), ['ospf:R_A:0.0.0.1', 'ospf', '0.0.0.1', ['R_B']], '同一組鄰接、不同 area');
  assert.deepStrictEqual(dom('10.9.9.0/24'), ['static:R_A', 'static', null, ['R_A', 'R_B']], '沒有 OSPF 的共用網段：兩台連成一組');
  assert.deepStrictEqual(dom('10.3.3.0/24'), ['static:R_C', 'static', null, ['R_C']]);
  assert.strictEqual(Q.routingDomainOf('10.8.0.0/16'), null);
  const all = Q.routingDomains().flatMap((d) => d.prefixes);
  assert.deepStrictEqual(all.slice().sort(), s.model.prefixes.map((p) => p.key).sort(), '每個直連網段恰好一個網域');
  assert.ok(Q.routingDomains().find((d) => d.key === 'ospf:R_A:0.0.0.0').evidence.every((e) => e.kind === 'ospf-template' && e.src.length));
});

test('範例資料：核心 01 的 ether45（DHCP client 加預設路由）不在 WAN 清單但判定對外；PE 的預設路由指向核心，不是對外；CE 沒有 WAN 清單，以 masquerade 判定對外', () => {
  const Q = S.query(sampleSnap());
  const st = (ep) => (Q.boundaryOf(ep) || { status: 'internal' }).status;
  assert.strictEqual(st('TPE_CORE_RT_01|ether45'), 'external');
  assert.ok(!Q.firewallZone('TPE_CORE_RT_01').wanInterfaces.includes('TPE_CORE_RT_01|ether45'), 'WAN 清單不含這個預設路由出口（之後 R08 的矛盾）');
  Q.devices().map((d) => Q.firewallZone(d.key)).filter(Boolean).forEach((z) => z.wanInterfaces.forEach((ep) => assert.strictEqual(st(ep), 'external', `WAN 清單的成員 ${ep} 判定對外`)));
  assert.strictEqual(st('TPE_PE_RT_01|ether1'), 'internal');
  const ce = Q.boundaryOf('TPE_CE_RT_01|ether1');
  assert.ok(ce && ce.status === 'external' && kinds(ce).includes('srcnat-out:strong') && Q.firewallZone('TPE_CE_RT_01').status === 'no-wan-list', JSON.stringify(ce));
  // CE 的備援預設路由（閘道不通，非作用中）：在 allRoutesOf，不在 routesOf
  const dflt = (rs) => rs.filter((r) => r.len === 0 && r.routingTable === 'main').map((r) => [r.nh[0].ip, r.active]);
  assert.deepStrictEqual([dflt(Q.allRoutesOf('TPE_CE_RT_01')), dflt(Q.routesOf('TPE_CE_RT_01'))], [[['192.168.50.1', true], ['10.255.0.1', false]], [['192.168.50.1', true]]]);
});

test('產生器的多站點資料：WAN 路由器沒有 WAN 清單，以預設路由與 masquerade 判定對外；核心往 WAN 路由器的 ether48 在 LAN 清單，不是對外', () => {
  const s = S.build([{ name: 'g.txt', text: gen(['--sites', '2', '--access', '2']) }], { now: '2026-01-01T00:00:00Z' }); const Q = S.query(s);
  // 沒有 WAN 清單的設備上判定對外的介面：只有 WAN 路由器的 ether47
  const noList = Q.boundaries().filter((b) => b.status === 'external' && Q.firewallZone(b.dev).status === 'no-wan-list');
  assert.deepStrictEqual(noList.map((b) => [b.ep, kinds(b)]), [['WAN_RT_01|ether47', ['default-route:strong', 'srcnat-out:strong']]]);
  assert.ok(!Q.boundaries().some((b) => /\|ether48$/.test(b.ep) && b.status !== 'internal'));
});
