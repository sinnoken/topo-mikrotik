// L4（M2）：端到端可達性 Q.reach、zone、zone 矩陣、規則影響
'use strict';
const assert = require('assert');
const { S, build, test, sampleSnap } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/**
 * 手寫的兩台路由器：R1（LAN 192.168.1.0/24 在 bridge1、WAN 198.51.100.0/30 在 ether1）經 10.0.12.0/30 接 R2（192.168.2.0/24 在 bridge1）。
 * R1 的 forward：drop src-address-list=BLOCKED、放行到 192.168.2.10:22、drop 到 192.168.2.0/24；dst-nat 8080 → 192.168.2.20–21（範圍）、8081 → 192.168.2.10:22；masquerade 到 WAN。
 * R2 沒有防火牆規則（預設放行）；R3 只有路由表、沒有 export。
 */
const twoRouters = (extra) => build([
  'R1 (10.0.12.1):',
  '### /export terse',
  '/interface bridge add name=bridge1',
  '/interface list add name=WAN', '/interface list add name=LAN',
  '/interface list member add interface=bridge1 list=LAN', '/interface list member add interface=ether1 list=WAN',
  '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0',
  '/ip address add address=10.0.12.1/30 interface=ether2 network=10.0.12.0',
  '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
  ...((extra && extra.r1) || [
    '/ip firewall filter add action=drop chain=forward src-address-list=BLOCKED',
    '/ip firewall filter add action=accept chain=forward dst-address=192.168.2.10 dst-port=22 protocol=tcp',
    '/ip firewall filter add action=drop chain=forward dst-address=192.168.2.0/24',
  ]),
  '/ip firewall nat add action=dst-nat chain=dstnat dst-port=8080 in-interface-list=WAN protocol=tcp to-addresses=192.168.2.20-192.168.2.21 to-ports=80',
  '/ip firewall nat add action=dst-nat chain=dstnat dst-port=8081 in-interface-list=WAN protocol=tcp to-addresses=192.168.2.10 to-ports=22',
  '/ip firewall nat add action=masquerade chain=srcnat out-interface-list=WAN',
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge1 distance=0',
  ' DAc dst-address=10.0.12.0/30 routing-table=main gateway=ether2 distance=0',
  ' As dst-address=192.168.2.0/24 routing-table=main gateway=10.0.12.2 distance=1',
  ' As dst-address=192.168.3.0/24 routing-table=main gateway=10.0.12.2 distance=1',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1',
  '',
  'R2 (10.0.12.2):',
  '### /export terse',
  '/interface bridge add name=bridge1',
  '/ip address add address=192.168.2.1/24 interface=bridge1 network=192.168.2.0',
  '/ip address add address=10.0.12.2/30 interface=ether2 network=10.0.12.0',
  '/ip address add address=10.0.23.2/30 interface=ether3 network=10.0.23.0',
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=192.168.2.0/24 routing-table=main gateway=bridge1 distance=0',
  ' As dst-address=192.168.1.0/24 routing-table=main gateway=10.0.12.1 distance=1',
  ' As dst-address=192.168.3.0/24 routing-table=main gateway=10.0.23.3 distance=1',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=10.0.12.1 distance=1',
  '',
  'R3 (10.0.23.3):',
  '### /ip address print detail without-paging', 'Flags: X - disabled, I - invalid, D - dynamic',
  ' 0   address=10.0.23.3/30 network=10.0.23.0 interface=ether3 actual-interface=ether3',
  ' 1   address=192.168.3.1/24 network=192.168.3.0 interface=bridge1 actual-interface=bridge1',
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=192.168.3.0/24 routing-table=main gateway=bridge1 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=10.0.23.2 distance=1',
].join('\n'));
const codes = (r) => r.reasons.map((x) => x.code);

test('Q.reach：沿 L3 路徑逐跳套用 filter，回傳決定的規則與來源行；確定的放行與拒絕', () => {
  const s = twoRouters({ r1: [
    '/ip firewall filter add action=accept chain=forward dst-address=192.168.2.10 dst-port=22 protocol=tcp',
    '/ip firewall filter add action=drop chain=forward dst-address=192.168.2.0/24',
  ] });
  const Q = S.query(s);
  const ok = Q.reach('192.168.1.50', '192.168.2.10', { proto: 'tcp', port: 22 });
  assert.strictEqual(ok.verdict, 'allow', JSON.stringify(ok.reasons));
  assert.deepStrictEqual(ok.paths.map((p) => p.hops.map((h) => [h.dev, h.chain, h.in, h.out])), [[['R1', 'forward', 'R1|bridge1', 'R1|ether2'], ['R2', 'forward', 'R2|ether2', 'R2|bridge1']]]);
  const accept = s.model.firewallRules.find((r) => r.action === 'accept' && r.table === 'filter');
  const st = ok.paths[0].hops[0].stages.find((x) => x.table === 'filter');
  assert.deepStrictEqual([st.status, st.verdict, st.rule.key, st.rule.src], ['decided', 'accept', accept.key, accept.src], '每一跳列出命中的規則（鍵與來源行）');
  assert.ok(ok.paths[0].hops[1].stages.find((x) => x.table === 'filter').policy, 'R2 沒有規則：預設放行');
  assert.ok(ok.decisive.some((d) => d.key === accept.key));
  const no = Q.reach('192.168.1.50', '192.168.2.11', { proto: 'tcp', port: 22 });
  const drop = s.model.firewallRules.find((r) => r.action === 'drop');
  assert.deepStrictEqual([no.verdict, no.decisive.map((d) => d.key)], ['deny', [drop.key]]);
  assert.deepStrictEqual(no.reasons, [], 'deny／allow 沒有 unknown 的原因');
  assert.strictEqual(Q.reach('192.168.2.10', '192.168.1.50', { proto: 'tcp', port: 22 }).verdict, 'allow', '反方向走 R2 → R1，R1 forward 沒有規則擋');
  assert.strictEqual(Q.reach('192.168.1.50', '192.168.1.60', { proto: 'udp', port: 53 }).start.how, 'same-subnet', '同一網段不經過路由器');
  assert.strictEqual(Q.reach('192.168.1.50', '192.168.2.10', { proto: 'tcp', port: 22 }), ok, '同樣的查詢回傳快取（深層凍結）');
  assert.ok(Object.isFrozen(ok.paths[0].hops[0]));
});

test('Q.reach：無法判斷時回傳 unknown 與原因（address-list、未收集設備、沒有 export、下一跳在基準外、NAT 範圍），不猜', () => {
  const s = twoRouters(); const Q = S.query(s);
  const al = Q.reach('192.168.1.50', '192.168.2.10', { proto: 'tcp', port: 22 });
  assert.strictEqual(al.verdict, 'unknown');
  const r = al.reasons.find((x) => x.code === 'rule-condition');
  assert.deepStrictEqual([r.dev, r.keys, r.rule.position], ['R1', ['src-address-list'], 1], 'drop src-address-list=BLOCKED 是否命中不明（清單內容不在基準中）');
  assert.ok(/address-list/.test(r.message));
  assert.strictEqual(Q.reach('192.168.1.50', '192.168.2.11', { proto: 'tcp', port: 22 }).verdict, 'deny', '兩種可能都是 drop：仍是確定的 deny');
  // R3 沒有 export：防火牆不明，但路由照走
  const r3 = Q.reach('192.168.1.50', '192.168.3.9', { proto: 'tcp', port: 443, disabledRules: [s.model.firewallRules[0].key] });
  assert.ok(codes(r3).includes('no-firewall-data'), JSON.stringify(r3.reasons));
  assert.strictEqual(r3.verdict, 'unknown');
  // 下一跳在基準外
  const out = Q.reach('192.168.2.10', '8.8.8.8', { proto: 'tcp', port: 443 });
  assert.deepStrictEqual([out.verdict, codes(out).includes('next-hop-outside')], ['unknown', true]);
  const hop = out.paths[0].hops.find((h) => h.dev === 'R1');
  assert.deepStrictEqual([hop.nat[0].type, hop.srcOut], ['masquerade', '198.51.100.2'], 'masquerade 改寫來源為出介面的位址');
  // dst-nat 的 to-addresses 是範圍
  const rg = Q.reach('198.51.100.1', '198.51.100.2', { proto: 'tcp', port: 8080 });
  assert.deepStrictEqual([rg.verdict, codes(rg)], ['unknown', ['nat-target']]);
  // 來源不在任何網段
  const far = Q.reach('203.0.113.9', '192.168.1.50', { proto: 'tcp', port: 80 });
  assert.deepStrictEqual([far.verdict, codes(far)], ['unknown', ['src-location-unknown']]);
  const viaEntry = Q.reach('203.0.113.9', '198.51.100.2', { proto: 'tcp', port: 8081, entry: 'R1|ether1' });
  assert.strictEqual(viaEntry.final.dst, '192.168.2.10', 'entry 指定入口介面後可以判斷；dst-nat 改寫目的');
});

test('Q.reach：dst-nat 改寫目的後重新查路由，forward 依改寫後的位址判斷；參數檢查', () => {
  const s = twoRouters({ r1: ['/ip firewall filter add action=accept chain=forward connection-nat-state=dstnat', '/ip firewall filter add action=drop chain=forward in-interface-list=WAN'] });
  const Q = S.query(s);
  const r = Q.reach('198.51.100.1', '198.51.100.2', { proto: 'tcp', port: 8081 });
  assert.strictEqual(r.verdict, 'allow', JSON.stringify(r.reasons));
  assert.deepStrictEqual([r.final, r.natApplied], [{ dst: '192.168.2.10', port: 22 }, true]);
  const h = r.paths[0].hops[0];
  assert.deepStrictEqual([h.dev, h.chain, h.nat[0].type, h.nat[0].before, h.nat[0].after, h.out], ['R1', 'forward', 'dst-nat', '198.51.100.2:8081', '192.168.2.10:22', 'R1|ether2']);
  assert.strictEqual(h.nat[0].rule.src[0][1] > 0, true, 'NAT 規則附來源行');
  assert.strictEqual(Q.reach('198.51.100.1', '192.168.2.10', { proto: 'tcp', port: 22 }).verdict, 'deny', '沒有經過 dst-nat 的直接連線被 WAN 的 drop 擋下');
  assert.deepStrictEqual(Q.reach('x', '1.1.1.1', { proto: 'tcp', port: 1 }), { ok: false, error: '請輸入有效的 IPv4 位址' });
  assert.throws(() => Q.reach('192.168.1.5', '192.168.2.5', { proto: 'tcp', port: 22, vrf: 'cust-a' }), /vrf/);
  assert.throws(() => Q.reach('192.168.1.5', '192.168.2.5', { proto: 'tcp' }), /port/);
  assert.throws(() => Q.reach('192.168.1.5', '192.168.2.5', { proto: 'icmp', port: 3 }), /port/);
  assert.strictEqual(Q.reach('192.168.1.5', '192.168.2.5', { proto: 'icmp' }).proto, 'icmp');
});

test('Q.reach（範例資料）：WAN 經 dst-nat 連到伺服器、沒有 NAT 的被擋、出網段後無法判斷、目的是未收集的交換器', () => {
  const s = sampleSnap(); const Q = S.query(s);
  const dnat = s.model.firewallRules.find((r) => r.dev === 'TPE_CORE_RT_01' && r.action === 'dst-nat');
  const nat = Q.reach('203.0.113.1', '203.0.113.2', { proto: 'tcp', port: 8443 });
  assert.deepStrictEqual([nat.verdict, nat.final, nat.paths[0].hops[0].nat[0].rule.key], ['allow', { dst: '10.1.20.11', port: 443 }, dnat.key], 'F04 的連接埠轉送');
  const direct = Q.reach('203.0.113.1', '10.1.20.11', { proto: 'tcp', port: 443 });
  assert.strictEqual(direct.verdict, 'deny');
  assert.strictEqual(direct.decisive[0].comment, 'defconf: drop all from WAN not DSTNATed');
  const internet = Q.reach('10.1.30.11', '8.8.8.8', { proto: 'tcp', port: 443 });
  assert.deepStrictEqual([internet.verdict, codes(internet).includes('next-hop-outside')], ['unknown', true]);
  assert.strictEqual(internet.start.basis, 'dhcp', 'VLAN 30 的閘道取自 DHCP 網路設定（兩台核心）');
  const css = Q.reach('10.1.30.11', '10.1.10.210', { proto: 'tcp', port: 22 });
  assert.deepStrictEqual([css.verdict, codes(css)], ['unknown', ['dst-device-uncollected']]);
  const mgmt = Q.reach('10.1.30.11', '10.1.10.2', { proto: 'tcp', port: 22 });
  assert.strictEqual(mgmt.verdict, 'deny', '核心的 input：不是來自 LAN 的一律 drop（vlan30 不在 LAN 清單）');
  assert.ok(mgmt.paths.every((p) => p.hops[p.hops.length - 1].chain === 'input'));
});

test('zone：interface list → VLAN → 網段，每個網段都有 zone 並標明來源與推論；命名規則的 zones 標籤優先', () => {
  const s = sampleSnap(); const Q = S.query(s);
  const z = Q.zones();
  const by = (p) => z.subnets.find((x) => x.prefix === p);
  assert.deepStrictEqual([by('203.0.113.0/30').zone, by('203.0.113.0/30').source, by('203.0.113.0/30').inferred], ['list:WAN', 'interface-list', true]);
  assert.deepStrictEqual([by('10.1.30.0/24').zone, by('10.1.20.0/24').zone, by('172.31.1.0/30').zone], ['vlan:30', 'vlan:20', 'subnet:172.31.1.0/30']);
  assert.ok(/多數/.test(by('10.1.20.0/24').basis), '10.1.20.0/24 在 ACC_11 是 VLAN 40（A07）：取多數並說明');
  assert.strictEqual(z.subnets.length, s.model.prefixes.length);
  assert.ok(z.subnets.every((x) => x.zone && x.basis && x.vrf === null));
  assert.deepStrictEqual(Q.zoneOf('10.1.30.99'), { zone: 'vlan:30', subnet: '10.1.30.0/24', source: 'vlan', inferred: true });
  assert.strictEqual(Q.zoneOf('8.8.8.8'), null);
  assert.strictEqual(Q.zones({ sources: ['subnet'] }).zones.length, s.model.prefixes.length, '只用網段：每個網段一個 zone');
  assert.throws(() => Q.zones({ sources: ['foo'] }), /sources/);
  // 命名規則的 zones（註解，不改寫事實）：要與建立基準時的命名規則相同
  const profile = { schema: 'ssot-profile/1', id: 'zones-test', version: '1', zones: [{ on: 'vlan', match: '^30$', zone: 'USER' }, { on: 'subnet', match: '^172\\.31\\.', zone: 'LAB' }] };
  assert.throws(() => Q.zones({ profile }), /命名規則/);
  const text = require('fs').readFileSync(require('path').join(__dirname, '../../samples/sample-bundle.txt'), 'utf8');
  const sp = S.build([{ name: 'sample-bundle.txt', text }], { now: '2026-01-01T00:00:00Z', profile });
  const zp = S.query(sp).zones({ profile });
  const byp = (p) => zp.subnets.find((x) => x.prefix === p);
  assert.deepStrictEqual([byp('10.1.30.0/24').zone, byp('10.1.30.0/24').source, byp('10.1.30.0/24').inferred, byp('172.31.1.0/30').zone], ['tag:USER', 'profile', false, 'tag:LAB']);
  assert.deepStrictEqual(byp('10.1.30.0/24').alternatives.map((a) => a.zone), ['vlan:30', 'subnet:10.1.30.0/24']);
  assert.throws(() => S.profile.compile({ id: 'x', zones: [{ on: 'host', match: 'a', zone: 'Z' }] }), /zones\[0\]\.on/);
});

test('zone 矩陣：L0 的格子狀態與代表規則；L1／L2 下鑽；相同基準相同矩陣，不寫進 Snapshot', () => {
  const s = sampleSnap(); const before = JSON.stringify(s);
  const Q = S.query(s);
  const mx = Q.zoneMatrix();
  assert.strictEqual(mx.cells.length, mx.zones.length ** 2);
  const cell = (a, b) => mx.cells.find((c) => c.src === a && c.dst === b);
  const wanSrv = cell('list:WAN', 'vlan:20');
  assert.strictEqual(wanSrv.status, 'partial', 'WAN → VLAN 20：只有 dst-nat 的 tcp/8443 放行');
  assert.deepStrictEqual(wanSrv.services.filter((x) => x.counts.allow).map((x) => x.service), ['tcp/8443']);
  assert.ok(wanSrv.heterogeneous, '兩個 WAN 網段的結果不同（只有核心 01 有 dst-nat）');
  assert.strictEqual(cell('list:WAN', 'vlan:30').status, 'deny');
  assert.strictEqual(cell('vlan:30', 'vlan:20').status, 'allow');
  assert.strictEqual(cell('vlan:30', 'list:WAN').status, 'unknown');
  assert.ok(cell('vlan:30', 'list:WAN').reasons.some((r) => r.code === 'next-hop-outside'));
  assert.ok(mx.services.some((x) => x.id === 'tcp/8443'), '預設 service 加上 dst-nat 的目的埠');
  // L1／L2
  const d = Q.zoneCell('list:WAN', 'vlan:20');
  const vip = d.groups.find((g) => g.dst.via === 'nat');
  assert.deepStrictEqual([vip.dst.ip, vip.srcs.map((x) => x.ip), vip.services.map((x) => [x.service, x.verdict, x.final.dst])], ['203.0.113.2', ['203.0.113.1'], [['tcp/8443', 'allow', '10.1.20.11']]]);
  const dnat = s.model.firewallRules.find((r) => r.action === 'dst-nat');
  assert.ok(d.ruleDetails.some((r) => r.key === dnat.key && r.verdicts.allow > 0));
  // L3：同一組來源與目的的完整路徑
  assert.strictEqual(Q.reach(vip.srcs[0].ip, vip.dst.ip, { proto: 'tcp', port: 8443 }).verdict, 'allow');
  // 可重現、快取、不寫進 Snapshot
  assert.strictEqual(Q.zoneMatrix(), mx);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S.query(sampleSnap()).zoneMatrix())), JSON.parse(JSON.stringify(mx)));
  assert.strictEqual(JSON.stringify(s), before);
  assert.throws(() => Q.zoneCell('nope', 'vlan:20'), /zone/);
  assert.throws(() => Q.zoneMatrix({ services: [{ proto: 'tcp' }] }), /port/);
  const one = Q.zoneMatrix({ services: [{ proto: 'tcp', port: 8443 }] });
  assert.deepStrictEqual(one.services.map((x) => x.id), ['tcp/8443']);
});

test('Q.ruleImpact：規則牽涉的 zone 對與路徑，停用後改變的結果；被遮蔽的規則沒有影響', () => {
  const s = sampleSnap(); const Q = S.query(s);
  const dnat = s.model.firewallRules.find((r) => r.action === 'dst-nat');
  const im = Q.ruleImpact(dnat.key);
  assert.strictEqual(im.rule.key, dnat.key);
  assert.ok(im.cells.some((c) => c.src === 'list:WAN' && c.dst === 'vlan:20' && c.decides > 0));
  assert.ok(im.ifDisabled.total > 0 && im.ifDisabled.counts['allow→deny'] > 0, JSON.stringify(im.ifDisabled.counts));
  const f01 = s.findings.find((f) => f.id === 'F01');
  const shadow = Q.ruleImpact(f01.entities.find((e) => e.type === 'rule').key);
  assert.deepStrictEqual([shadow.shadowed, shadow.total.evaluations, shadow.ifDisabled.total], [true, 0, 0]);
  const f03 = s.findings.find((f) => f.id === 'F03');
  const winbox = Q.ruleImpact(f03.entities.find((e) => e.type === 'rule').key);
  assert.ok(winbox.ifDisabled.changed.every((c) => c.service === 'tcp/8291' && c.to === 'deny'), '停用 winbox 放行：只影響 tcp/8291，改為 deny');
  assert.strictEqual(Q.ruleImpact('no-such-rule'), null);
});

test('S.infer.fw.decide：條件無法判斷的規則不略過，列出所有可能的結果', () => {
  const s = twoRouters(); const Q = S.query(s);
  const ctx = S.infer.fw.fwContext('R1', Q.interfaceListsOf('R1'), Q.interfacesOf('R1').map((i) => i.key), Q.firewallRulesOf('R1'));
  const pkt = { family: 'ip', reach: true, in: 'R1|bridge1', out: 'R1|ether2', protocol: 'tcp', dstPort: 22, srcPort: null, src: BigInt(S.ip.toInt('192.168.1.5')),
    dst: BigInt(S.ip.toInt('192.168.2.10')), srcLocal: false, dstLocal: false, state: 'new', natState: null, ipsec: 'none' };
  const d = S.infer.fw.decide(ctx, 'ip', 'filter', 'forward', pkt);
  assert.deepStrictEqual([d.decided, d.outcomes.map((o) => o.verdict), d.verdict, d.rule.position, d.uncertain.map((u) => [u.rule.position, u.keys, u.verdicts])],
    [false, ['drop', 'accept'], 'accept', 2, [[1, ['src-address-list'], ['drop']]]]);
  const e = S.infer.fw.decide(ctx, 'ip', 'filter', 'forward', Object.assign({}, pkt, { dst: BigInt(S.ip.toInt('192.168.2.11')) }));
  assert.deepStrictEqual([e.decided, e.verdict, e.rule.position], [true, 'drop', 3]);
});
