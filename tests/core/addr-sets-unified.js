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
