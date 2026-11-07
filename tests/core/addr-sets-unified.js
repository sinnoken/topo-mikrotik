// 位址集合「判斷只有一個入口」：每種位址來源（位址清單、規則字面值、available-from、SNMP community、/routing rule、雙重 NAT 的 masquerade）
// 在檢查與 L4 判斷用同一份集合（S.infer.addrSets），寫法不同、集合相同時結果相同；另以結構掃描擋下新的各自實作。
// 依據：https://manual.mikrotik.com/docs/cli-reference/ip/service.md（available-from）、https://manual.mikrotik.com/docs/cli-reference/routing/rule.md（/routing rule 的位址）、
//       https://manual.mikrotik.com/docs/cli-reference/ip/firewall/address-list.md。測試資料依手冊的語法手寫，不是實機擷取。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { S, ROOT, test } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
const text = (extra, routes) => ['R (192.168.1.1):', '### /export terse',
  '/interface bridge add name=bridge1',
  '/interface list add name=WAN', '/interface list add name=LAN',
  '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=bridge1 list=LAN',
  '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0',
  '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
  ...extra,
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge1 distance=0',
  ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1', ...(routes || []), ''].join('\n');
/** 建立基準，同時取得檢查用的 model（暫時包住 S.check.run）。 */
function capture(t) {
  let M = null; const run = S.check.run;
  S.check.run = function (m) { M = m; return run.apply(this, arguments); };
  try { return { snap: S.build([{ name: 't.txt', text: t }], { now: '2026-01-01T00:00:00Z' }), M }; } finally { S.check.run = run; }
}
const R = (extra, routes) => capture(text(extra, routes));
const of = (s, id) => s.findings.filter((f) => f.id === id);

test('F07 與 L4：available-from 合併後涵蓋全部才是不限來源（兩個 /1、整段範圍也算）；檢查的集合與 L4 的 serviceOf 是同一份', () => {
  const cases = [['0.0.0.0/0', true], ['0.0.0.0/1,128.0.0.0/1', true], ['0.0.0.0-255.255.255.255', true], ['0.0.0.0/1', false], ['0.0.0.0/1,192.168.1.0/24', false]];
  cases.forEach(([af, open]) => {
    const { snap, M } = R([`/ip service set ssh address=${af}`]);
    const ssh = of(snap, 'F07').filter((f) => /：ssh（/.test(f.message));
    assert.strictEqual(ssh.length, open ? 1 : 0, af);
    const Q = S.query(snap);
    const m = M.addrSets.service('R', 'ssh', 'ip').set; const q = Q.addrSets().service('R', 'ssh', 'ip').set;
    assert.deepStrictEqual([m.ranges, m.isAll], [q.ranges, open], af + '：檢查與查詢層的集合相同');
    // L4：LAN 的來源依集合判斷；暴露清單（WAN 來源）的「允許來源」是不限時就是 F07 報的那一項
    const r = Q.reach('192.168.1.10', '192.168.1.1', { proto: 'tcp', port: 22 });
    assert.strictEqual(r.verdict, q.has('192.168.1.10') ? 'allow' : 'deny', af);
    const row = Q.exposure().self.rows.find((x) => x.ip === '198.51.100.2' && x.service === 'tcp/22');
    assert.strictEqual(row.allowedFrom.kind === 'any', open, af + '：' + row.allowedFrom.text);
  });
});

test('F07（IPv6）：available-from 的 ::/1,8000::/1 是不限來源；只有一半時不報', () => {
  const v6 = ['/ipv6 address add address=2001:db8:1::1/64 interface=bridge1', '/ipv6 firewall filter add action=accept chain=input protocol=tcp'];
  const ssh6 = (af) => of(R(v6.concat(`/ip service set ssh address=192.168.1.0/24,${af}`)).snap, 'F07').filter((f) => /：ssh（/.test(f.message));
  const all = ssh6('::/1,8000::/1');
  assert.strictEqual(all.length, 1);
  assert.ok(/IPv6 從/.test(all[0].message) && !/IPv4 從/.test(all[0].message), all[0].message);
  assert.strictEqual(ssh6('::/1').length, 0);
});

test('F13：SNMP community 的 addresses 合併後涵蓋全部才是不限來源（兩個 /1、IPv6 的兩半也算）；集合在登錄表（snmp-community）', () => {
  const cases = [['0.0.0.0/1,128.0.0.0/1', true], ['0.0.0.0-255.255.255.255', true], ['::/1,8000::/1', true], ['0.0.0.0/1', false], ['10.0.0.0/8,::/1', false]];
  cases.forEach(([addrs, open]) => {
    const { snap, M } = R(['/snmp set enabled=yes', '/snmp community set [ find default=yes ] disabled=yes', `/snmp community add addresses=${addrs} name=mon`]);
    assert.deepStrictEqual(of(snap, 'F13').map((f) => f.facet), open ? ['mon'] : [], addrs);
    const Q = S.query(snap);
    ['ip', 'ipv6'].forEach((f) => {
      const id = `R|${f}|snmp-community|mon`;
      assert.deepStrictEqual(M.addrSets.community('R', 'mon', f).set.ranges, Q.addrSets().community('R', 'mon', f).set.ranges, addrs + f);
      assert.strictEqual(Q.addressSet(id).kind, 'snmp-community');
    });
  });
});

test('/routing rule：多個網段、範圍與單一網段，集合相同時 Q.reach 相同（經路由視圖的登錄表）；IPv6 的位址不符合 IPv4 封包；否定與不合法的值無法判斷', () => {
  const reach = (rule, src) => { const { snap } = R([`/routing rule add action=drop ${rule}`]); return S.query(snap).reach(src, '8.8.8.8', { proto: 'tcp', port: 443 }); };
  ['src-address=192.168.1.0/25', 'src-address=192.168.1.0/26,192.168.1.64/26', 'src-address=192.168.1.0-192.168.1.127'].forEach((rule) => {
    assert.strictEqual(reach(rule, '192.168.1.10').verdict, 'deny', rule);
    assert.strictEqual(reach(rule, '192.168.1.200').verdict, 'allow', rule);
  });
  assert.strictEqual(reach('src-address=2001:db8::/32', '192.168.1.10').verdict, 'allow', 'IPv6 的規則不符合 IPv4 封包');
  ['src-address=!192.168.1.0/25', 'src-address=192.168.1.0/25,bogus'].forEach((rule) => {
    const r = reach(rule, '192.168.1.200');
    assert.strictEqual(r.verdict, 'unknown', rule);
  });
  // 路由視圖：查詢層與模型版都有 addrSets，同一條規則的集合相同；trace 直接用它判斷
  const { snap, M } = R(['/routing rule add action=drop src-address=192.168.1.0/26,192.168.1.64/26']);
  const Q = S.query(snap); const QV = S.trace.routingOf(Q); const RV = S.infer.routingView(M);
  const qr = QV.policyOf('R').rules[0]; const mr = RV.policyOf('R').rules[0];
  const qs = QV.addrSets().ofRoutingRule(qr, 'src-address'); const ms = RV.addrSets().ofRoutingRule(mr, 'src-address');
  assert.deepStrictEqual([qs.id, qs.set.ranges], ['R|routing-rule|1|src-address', ms.set.ranges]);
  const pkt = { src: '192.168.1.100', dst: '8.8.8.8', vrf: 'main', inEp: 'R|bridge1' };
  assert.deepStrictEqual([S.trace.routeDecision(QV, 'R', pkt).kind, S.trace.routeDecision(RV, 'R', pkt).kind], ['policy-drop', 'policy-drop']);
  // 等價類的邊界也由同一份集合產生：/25 的兩側在矩陣中是不同的代表位址，判斷與 Q.reach 一致
  const set = qs.set;
  ['192.168.1.5', '192.168.1.127', '192.168.1.128'].forEach((ip) => assert.strictEqual(Q.reach(ip, '8.8.8.8', { proto: 'tcp', port: 443 }).verdict, set.has(ip) ? 'deny' : 'allow', ip));
});

test('R12 的雙重 NAT（behindNat）：masquerade 的 src-address 合併後涵蓋網段才算在 NAT 後面（/25,/25 涵蓋 /24）；否定看有沒有交集', () => {
  const C = (net, ifc) => ` DAc dst-address=${net} routing-table=main gateway=${ifc} immediate-gw=${ifc} distance=0`;
  const D = (dst, gw, ifc) => ` As  dst-address=${dst} routing-table=main gateway=${gw} immediate-gw=${gw}%${ifc} distance=1`;
  const two = (nat) => [
    'A (10.0.0.1):', '### /export terse', '/ip address add address=10.0.0.1/30 interface=ether1', '/ip address add address=10.1.0.1/24 interface=ether2',
    ...(nat ? [`/ip firewall nat add action=masquerade chain=srcnat out-interface=ether1 ${nat}`] : []),
    '### /ip route print detail without-paging', RT, C('10.0.0.0/30', 'ether1'), C('10.1.0.0/24', 'ether2'), D('10.2.0.0/24', '10.0.0.2', 'ether1'),
    'B (10.0.0.2):', '### /export terse', '/ip address add address=10.0.0.2/30 interface=ether1', '/ip address add address=10.2.0.1/24 interface=ether2',
    '### /ip route print detail without-paging', RT, C('10.0.0.0/30', 'ether1'), C('10.2.0.0/24', 'ether2'), D('0.0.0.0/0', '10.0.0.1', 'ether1'), ''].join('\n');
  const r12 = (nat) => { const { snap, M } = capture(two(nat)); return { hit: of(snap, 'R12').some((f) => /10\.1\.0\.0\/24/.test(f.message)), M }; };
  assert.strictEqual(r12(null).hit, true, '沒有 NAT：報');
  assert.strictEqual(r12('src-address=10.1.0.0/24').hit, false);
  const split = r12('src-address=10.1.0.0/25,10.1.0.128/25');
  assert.strictEqual(split.hit, false, '兩個相鄰的 /25 合併後涵蓋 /24');
  const rule = split.M.fw.rules.find((r) => r.table === 'nat');
  assert.ok(split.M.addrSets.ofRule(rule, 'src-address').set.covers('10.1.0.0/24'), '判斷用登錄表的集合');
  assert.strictEqual(r12('src-address=10.1.0.0/25').hit, true, '只涵蓋一半');
  assert.strictEqual(r12('src-address=!10.9.0.0/16').hit, false, '否定、沒有交集：在 NAT 後面');
  assert.strictEqual(r12('src-address=!10.1.0.128/25').hit, true, '否定、有交集：不算');
});
