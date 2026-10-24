// 規格書 P1：收集時間、MAC 類型、路由距離與黑洞、VRRP、DHCP 網路
'use strict';
const assert = require('assert');
const { S, build, ids, count, iface, test } = require('../lib.js');
// ------------------------------------------------------------------ 規格書 P1：收集時間、MAC 類型、路由距離與黑洞、VRRP、DHCP 網路
test('export 抬頭的收集時間（RouterOS 6／7 格式）；其他 # 行仍是註解', () => {
  const s = build(['SW (10.0.0.1):', '### /export terse', '# 2026-10-13 10:00:00 by RouterOS 7.12.1', '# model = CRS326', '/system identity set name=SW',
    'R6 (10.0.0.2):', '### /export', '# oct/13/2026 09:05:01 by RouterOS 6.49.7', '/system identity set name=R6'].join('\n'));
  assert.deepStrictEqual(s.model.devices.map((d) => [d.key, d.collectedAt]), [['R6', '2026-10-13T09:05:01'], ['SW', '2026-10-13T10:00:00']]);
});
test('路由：distance、黑洞路由（RouterOS 7 單獨的 blackhole 字、RouterOS 6 的 B 旗標）；MAC 表的靜態項目', () => {
  const s = build(['R (10.0.0.1):', '### /ip route print detail without-paging', 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC',
    ' 0  As dst-address=10.94.0.0/16 routing-table=main blackhole distance=1', ' 1  As dst-address=0.0.0.0/0 routing-table=main gateway=192.0.2.1 distance=5',
    ' 2  AB dst-address=10.93.0.0/16 type=blackhole distance=1',
    '### /interface bridge host print detail without-paging', ' 0    mac-address=AA:BB:CC:00:00:01 on-interface=ether1 bridge=bridge1 vid=10'].join('\n'));
  const r = (p) => s.model.routes.find((x) => x.prefix === p);
  assert.deepStrictEqual([r('10.94.0.0').blackhole, r('10.94.0.0').nh, r('10.93.0.0').blackhole, r('0.0.0.0').distance, r('0.0.0.0').blackhole], [true, [], true, 5, false]);
  assert.strictEqual(s.model.macs[0].seen[0].static, true);
});
test('R03／R04：下一跳迴圈與落入黑洞分開回報，不重複列為 R01；路徑追蹤在黑洞路由停下', () => {
  const s = build(['R (10.0.0.1):', '### /export terse', '/ip address add address=10.0.0.1/24 interface=ether1',
    '### /ip route print detail without-paging', 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC',
    ' 0  Ac dst-address=10.0.0.0/24 routing-table=main gateway=ether1', ' 1  As dst-address=10.97.0.0/16 routing-table=main gateway=10.96.0.1',
    ' 2  As dst-address=10.96.0.0/16 routing-table=main gateway=10.97.0.1', ' 3  As dst-address=10.94.0.0/16 routing-table=main blackhole',
    ' 4  As dst-address=10.95.0.0/16 routing-table=main gateway=10.94.0.1'].join('\n'));
  assert.deepStrictEqual(['R01', 'R03', 'R04'].map((id) => count(s, id)), [0, 1, 1]);
  // 閘道只能靠自己這條路由解析（不在任何直連網段）是無法到達（R01），不是迴圈
  const self = build('W (10.0.0.9):\n### /ip route print detail without-paging\nFlags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC\n 0  As dst-address=0.0.0.0/0 routing-table=main gateway=203.0.113.1\n');
  assert.deepStrictEqual([count(self, 'R01'), count(self, 'R03')], [1, 0]);
  const t = S.trace(S.query(s), '10.0.0.9', '10.94.1.1');
  assert.deepStrictEqual(t.ends.map((e) => e.status), ['blackhole']);
});
// 兩台交換器 A、B，ports 是兩邊互連的埠（各自 LLDP 回報對方）；cfgA／cfgB 是 export 的 bridge port／vlan 行
const vlanPair = (cfgA, cfgB, ports = ['ether1']) => build([
  ['A', 'B', cfgA, 1], ['B', 'A', cfgB, 2]].map(([me, peer, cfg, n]) => [`${me} (10.0.0.${n}):`, '### /ip neighbor print detail',
  ...ports.map((p, k) => ` ${k} interface=${p} mac-address=AA:00:00:00:00:0${n === 1 ? 2 : 1} identity=${peer} interface-name=${p}`),
  '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', ...cfg].join('\n')).join('\n'));
test('V08：兩端都有同一個 VLAN，一端 tagged、另一端 untagged；V01 不受影響、PVID 不同只報 V04、聚合成員只報一次', () => {
  const s = vlanPair(['/interface bridge port add bridge=bridge1 interface=ether1', '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=20,30'],
    ['/interface bridge port add bridge=bridge1 interface=ether1', '/interface bridge vlan add bridge=bridge1 untagged=ether1 vlan-ids=20', '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=30']);
  const v08 = s.findings.filter((f) => f.id === 'V08');
  assert.strictEqual(v08.length, 1, JSON.stringify(s.findings.map((f) => f.id)));
  assert.strictEqual(v08[0].message, 'VLAN 20 在 A ether1 為 tagged、在 B ether1 為 untagged');
  assert.deepStrictEqual(v08[0].entities, [{ type: 'link', key: 'A|ether1~B|ether1' }]);
  assert.strictEqual(count(s, 'V01'), 0, '兩端都有 VLAN 20、30，不是 V01');
  assert.strictEqual(s.findings.find((f) => f.id === 'V08').severity, 'warn');
  // PVID 不同（10 對 20）：只報 V04，PVID 那兩個 VLAN 的 tagged／untagged 差異是同一件事；其他 VLAN 仍可報 V08
  const p = vlanPair(['/interface bridge port add bridge=bridge1 interface=ether1 pvid=10', '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=20,30'],
    ['/interface bridge port add bridge=bridge1 interface=ether1 pvid=20', '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=10',
      '/interface bridge vlan add bridge=bridge1 untagged=ether1 vlan-ids=30']);
  assert.strictEqual(count(p, 'V04'), 1);
  assert.deepStrictEqual(p.findings.filter((f) => f.id === 'V08').map((f) => f.message), ['VLAN 30 在 A ether1 為 tagged、在 B ether1 為 untagged']);
  // 聚合：兩條成員鏈路、VLAN 設在聚合介面上（成員繼承）→ 只報一次
  const lag = (side) => [`/interface bonding add name=bond1 slaves=ether1,ether2`, '/interface bridge port add bridge=bridge1 interface=bond1',
    `/interface bridge vlan add bridge=bridge1 ${side}=bond1 vlan-ids=40`];
  const g = vlanPair(lag('tagged'), lag('untagged'), ['ether1', 'ether2']);
  assert.strictEqual(count(g, 'V08'), 1, '同一組聚合只報一次');
  assert.ok(/bond1/.test(g.findings.find((f) => f.id === 'V08').message));
  // 一致時沒有 V08
  const ok = vlanPair(['/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=20'], ['/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=20']);
  assert.strictEqual(count(ok, 'V08'), 0);
});
test('V08：只看雙邊都有 VLAN 資料的介面鄰接，MNDP 與單側觀察的鏈路不比', () => {
  const m = build(['A (10.0.0.1):', '### /ip neighbor print detail', ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether1 discovered-by=mndp',
    '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=20',
    'B (10.0.0.2):', '### /ip neighbor print detail', ' 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=A interface-name=ether1 discovered-by=mndp',
    '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge vlan add bridge=bridge1 untagged=ether1 vlan-ids=20'].join('\n'));
  assert.strictEqual(count(m, 'V08'), 0, 'MNDP 只證明廣播網域可達');
  const h = build(['A (10.0.0.1):', '### /ip neighbor print detail', ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether1',
    '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=20'].join('\n'));
  assert.strictEqual(count(h, 'V08'), 0, '對端沒有收集資料');
});
test('VRRP 位址標示角色、網段帶出所屬 VLAN；R05 只在閘道不在網段內時回報', () => {
  const s = build(['R (10.0.0.1):', '### /export terse', '/interface vlan add interface=bridge1 name=vlan30 vlan-id=30', '/interface vrrp add interface=vlan30 name=vrrp30 vrid=30',
    '/ip address add address=10.1.30.2/24 interface=vlan30', '/ip address add address=10.1.30.1/32 interface=vrrp30',
    '/ip dhcp-server network add address=10.1.30.0/24 gateway=10.1.30.1', '/ip dhcp-server network add address=10.1.20.0/24 gateway=10.1.21.1'].join('\n'));
  assert.deepStrictEqual(s.model.ipAddresses.map((a) => [a.address, a.role]), [['10.1.30.1/32', 'vrrp'], ['10.1.30.2/24', null]]);
  assert.deepStrictEqual(s.model.prefixes.map((p) => [p.prefix, p.vlan, p.vlans]), [['10.1.30.0/24', 30, [30]]]);
  // 同一網段在不同設備設在不同 VLAN：vlan 不明確（null），vlans 列出全部
  const two = build(['R1 (10.0.0.1):', '### /export terse', '/interface vlan add interface=bridge1 name=vlan30 vlan-id=30', '/ip address add address=10.1.30.2/24 interface=vlan30',
    'R2 (10.0.0.2):', '### /export terse', '/interface vlan add interface=bridge1 name=vlan40 vlan-id=40', '/ip address add address=10.1.30.3/24 interface=vlan40'].join('\n'));
  assert.deepStrictEqual(two.model.prefixes.map((p) => [p.prefix, p.vlan, p.vlans]), [['10.1.30.0/24', null, [30, 40]]]);
  assert.strictEqual(iface(s, 'R|vrrp30').type, 'virtual');
  assert.deepStrictEqual(s.findings.filter((f) => f.id === 'R05').map((f) => f.message), ['R：10.1.20.0/24 的閘道 10.1.21.1 不在網段內']);
});
