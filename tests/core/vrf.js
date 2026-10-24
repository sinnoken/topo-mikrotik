// VRF（ADR-015，ssot-snapshot/3）：解析、事實與鍵、檢查只在同一個 VRF 內比較、查詢與路徑追蹤、只用 main 的網路鍵不變
// 測試資料依 RouterOS 手冊 VRF 撰寫（https://manual.mikrotik.com/docs/user-guides/routing-and-networking-protocols/vrf.md），不是實機擷取。
// 只支援 RouterOS 7（以手冊 7.24–7.26 為準）；RouterOS 6 的 VRF（/ip route vrf、routing-mark）不在範圍內。策略路由見下方的 /routing table、/routing rule 測試。
'use strict';
const assert = require('assert');
const { S, read, build, count, test, i03, sampleSnap } = require('../lib.js');

const FLAGS7 = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
// PE：VRF cust-a（ether2、ether3），10.1.20.0/24 與 CORE 的 main 重疊；CE 在 main，經 PE 的 cust-a 上網；cust-a 的預設路由洩漏到 main
const CORE = ['CORE (10.0.0.254):', '### /export terse',
  '/ip address add address=10.0.0.254/24 interface=ether1 network=10.0.0.0', '/ip address add address=10.1.20.2/24 interface=vlan20 network=10.1.20.0',
  '### /ip arp print detail without-paging', ' 0 DC address=10.1.20.11 mac-address=AA:00:00:00:00:01 interface=vlan20',
  '### /ip route print detail without-paging', FLAGS7,
  ' DAc dst-address=10.0.0.0/24 routing-table=main gateway=ether1 immediate-gw=ether1 distance=0',
  ' DAc dst-address=10.1.20.0/24 routing-table=main gateway=vlan20 immediate-gw=vlan20 distance=0'];
const PE = (vrfLines) => ['PE (10.0.0.1):', '### /export terse', ...(vrfLines || ['/ip vrf add interfaces=ether2,ether3 name=cust-a']),
  '/ip address add address=10.0.0.1/24 interface=ether1 network=10.0.0.0', '/ip address add address=10.1.20.2/24 interface=ether2 network=10.1.20.0',
  '/ip address add address=192.168.50.1/24 interface=ether3 network=192.168.50.0',
  '### /ip arp print detail without-paging', ' 0 DC address=10.1.20.11 mac-address=AA:00:00:00:00:02 interface=ether2',
  '### /ip route print detail without-paging', FLAGS7,
  ' DAc dst-address=10.0.0.0/24 routing-table=main gateway=ether1 immediate-gw=ether1 distance=0',
  ' DAc dst-address=10.1.20.0/24 routing-table=cust-a gateway=ether2@cust-a immediate-gw=ether2 distance=0',
  ' DAc dst-address=192.168.50.0/24 routing-table=cust-a gateway=ether3@cust-a immediate-gw=ether3 distance=0',
  ' As dst-address=172.16.10.0/24 routing-table=cust-a gateway=192.168.50.254@cust-a immediate-gw=192.168.50.254%ether3@cust-a distance=1',
  ' As dst-address=0.0.0.0/0 routing-table=cust-a gateway=10.0.0.254@main immediate-gw=10.0.0.254%ether1 distance=1',
  ' As dst-address=10.9.0.0/16 routing-table=isp2 gateway=10.0.0.253 distance=1'];
const CE = ['CE (192.168.50.254):', '### /export terse',
  '/ip address add address=192.168.50.254/24 interface=ether1 network=192.168.50.0', '/ip address add address=172.16.10.1/24 interface=ether2 network=172.16.10.0',
  '### /ip route print detail without-paging', FLAGS7,
  ' DAc dst-address=172.16.10.0/24 routing-table=main gateway=ether2 immediate-gw=ether2 distance=0',
  ' DAc dst-address=192.168.50.0/24 routing-table=main gateway=ether1 immediate-gw=ether1 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=192.168.50.1 immediate-gw=192.168.50.1%ether1 distance=1'];
const NET = (pe) => [...CORE, ...(pe || PE()), ...CE].join('\n') + '\n';
const keys = (s) => { const Q = S.query(s); return s.findings.map(Q.findingKey).sort(); };

test('VRF：鍵的寫法只在 src/core/keys.js（main 不加後綴，其他 VRF 加 @<VRF>）', () => {
  const K = S.keys;
  assert.deepStrictEqual([K.vrf(null), K.vrf(''), K.vrf(' cust-a ')], ['main', 'main', 'cust-a']);
  assert.deepStrictEqual([K.inVrf('10.0.0.1', 'main'), K.inVrf('10.0.0.1', null), K.inVrf('10.0.0.0/24', 'cust-a')], ['10.0.0.1', '10.0.0.1', '10.0.0.0/24@cust-a']);
  assert.deepStrictEqual([K.splitVrf('10.0.0.1'), K.splitVrf('10.0.0.0/24@cust-a')], [['10.0.0.1', 'main'], ['10.0.0.0/24', 'cust-a']]);
  assert.deepStrictEqual([S.SCHEMA, S.VERSION], ['ssot-snapshot/3', '3.0.0']);
});

test('VRF（RouterOS 7）：/ip vrf 的介面、位址、網段、ARP 與路由都帶 vrf；非 main 路由表是事實；閘道的 @<VRF> 保留為下一跳的屬性', () => {
  const s = build(NET());
  assert.deepStrictEqual(i03(s).map((f) => f.message), []);
  assert.deepStrictEqual(s.model.vrfs.map((v) => [v.dev, v.name, v.order, v.source, v.disabled, v.builtin, v.interfaces, v.members]),
    [['PE', 'cust-a', 1, 'export', false, false, ['ether2', 'ether3'], ['PE|ether2', 'PE|ether3']]]);
  assert.ok(s.model.vrfs[0].src[0][1] > 0, '保留來源行');
  const ifc = (k) => s.model.interfaces.find((i) => i.key === k);
  assert.deepStrictEqual(['PE|ether1', 'PE|ether2', 'CE|ether1'].map((k) => [ifc(k).vrf, ifc(k).vrfBasis]), [['main', 'default'], ['cust-a', 'export'], ['main', 'default']]);
  assert.deepStrictEqual(s.model.ipAddresses.filter((a) => a.ip === '10.1.20.2').map((a) => [a.ep, a.vrf]), [['CORE|vlan20', 'main'], ['PE|ether2', 'cust-a']]);
  assert.deepStrictEqual(s.model.prefixes.filter((p) => p.prefix === '10.1.20.0/24').map((p) => [p.key, p.vrf, p.eps]),
    [['10.1.20.0/24', 'main', ['CORE|vlan20']], ['10.1.20.0/24@cust-a', 'cust-a', ['PE|ether2']]], '每個 VRF 的每個網段一筆');
  assert.deepStrictEqual(s.model.arps.map((a) => [a.dev, a.ip, a.vrf]), [['CORE', '10.1.20.11', 'main'], ['PE', '10.1.20.11', 'cust-a']]);
  const r = (p, t) => s.model.routes.find((x) => x.dev === 'PE' && x.prefix + '/' + x.len === p && x.routingTable === t);
  assert.deepStrictEqual([r('0.0.0.0/0', 'cust-a').vrf, r('0.0.0.0/0', 'cust-a').nh], ['cust-a', [{ ip: '10.0.0.254', ifc: 'ether1', vrf: 'main', vrfBasis: 'explicit' }]], '路由洩漏：@main');
  assert.deepStrictEqual(r('172.16.10.0/24', 'cust-a').nh, [{ ip: '192.168.50.254', ifc: 'ether3', vrf: 'cust-a', vrfBasis: 'explicit' }], 'immediate-gw 的 %介面@VRF 只取介面');
  assert.deepStrictEqual(r('10.1.20.0/24', 'cust-a').nh, [{ ip: null, ifc: 'ether2', vrf: 'cust-a', vrfBasis: 'explicit' }], '連接路由 gateway=ether2@cust-a：介面不含 @');
  assert.deepStrictEqual([r('10.9.0.0/16', 'isp2').vrf, r('10.9.0.0/16', 'isp2').nh[0].vrf, r('10.9.0.0/16', 'isp2').nh[0].vrfBasis], [null, 'main', 'default'],
    '只用於策略路由的路由表：vrf 為 null；沒寫 @ 的閘道在 main 解析（手冊）');
  assert.strictEqual(s.meta.stats.vrfs, 1);
});

test('VRF：/ip vrf print 的順序（內建 main 排在前面時後面的 VRF 拿不到介面）優先於 export；設備回報的 vrf= 再優先', () => {
  const vprint = (rows) => ['### /ip vrf print detail without-paging', 'Flags: X - disabled; * - builtin', ...rows];
  // 手冊的錯誤順序：main 在前，myVrf 拿不到 lo_vrf；停用的 old 不比對
  const bad = build(['R (10.0.0.1):', '### /export terse', '/ip vrf add interfaces=lo_vrf name=myVrf', '/ip address add address=10.5.0.1/24 interface=lo_vrf network=10.5.0.0',
    ...vprint([' 0  * name="main" interfaces=all', ' 1    name="myVrf" interfaces=lo_vrf', ' 2 X  name="old" interfaces=ether9'])].join('\n') + '\n');
  assert.deepStrictEqual(i03(bad).map((f) => f.message), []);
  const i = bad.model.interfaces.find((x) => x.key === 'R|lo_vrf');
  assert.deepStrictEqual([i.vrf, i.vrfBasis], ['main', 'vrf-print'], 'print 的順序是事實，export 看不出 main 的位置');
  assert.deepStrictEqual(bad.model.vrfs.map((v) => [v.name, v.order, v.source, v.builtin, v.disabled]), [['main', 1, 'print', true, false], ['myVrf', 2, 'print', false, false], ['old', 3, 'print', false, true]]);
  assert.deepStrictEqual(S.query(bad).vrfs(), ['main', 'myVrf'], '停用的 VRF 不算');
  const good = build(['R (10.0.0.1):', '### /ip address print detail without-paging', ' 0   address=10.5.0.1/24 network=10.5.0.0 interface=lo_vrf actual-interface=lo_vrf vrf=myVrf',
    ...vprint([' 0  * name="main" interfaces=all', ' 1    name="myVrf" interfaces=lo_vrf'])].join('\n') + '\n');
  const g = good.model.interfaces.find((x) => x.key === 'R|lo_vrf');
  assert.deepStrictEqual([g.vrf, g.vrfBasis, good.model.ipAddresses[0].vrf], ['myVrf', 'reported', 'myVrf'], '/ip address 的 vrf= 由設備回報，優先');
  // ARP 列的 vrf= 也是設備回報；沒有 /ip vrf 也知道 routing-table=cust-b 是 VRF
  const arp = build(['R (10.0.0.1):', '### /ip arp print detail without-paging', ' 0 DC address=10.0.0.10 mac-address=02:00:00:00:00:0A interface=ether2 status="reachable" vrf=cust-b',
    '### /ip route print detail without-paging', FLAGS7, ' DAc dst-address=10.0.0.0/24 routing-table=cust-b gateway=ether2@cust-b immediate-gw=ether2 distance=0 scope=10 local-address=10.0.0.1%ether2@cust-b'].join('\n') + '\n');
  assert.deepStrictEqual([arp.model.arps[0].vrf, arp.model.routes[0].vrf], ['cust-b', 'cust-b']);
});

test('VRF：不同 VRF 的同一個 IP、網段不是衝突（A01、A05、A09）；同一個 VRF 內仍是，鍵加上 @<VRF>', () => {
  const s = build(NET());
  assert.deepStrictEqual([count(s, 'A01'), count(s, 'A05'), count(s, 'A08'), count(s, 'A09')], [0, 0, 0, 0]);
  // R01：只有策略路由表 isp2 的閘道到不了已知設備；CE 的閘道 192.168.50.1 在 PE 的 cust-a（網段相同，推論為同一條鏈路）
  assert.deepStrictEqual(s.findings.filter((f) => /^R0/.test(f.id)).map((f) => [f.id, f.message]), [['R01', 'PE：10.0.0.253']]);
  const PE2 = ['PE2 (10.0.0.2):', '### /export terse', '/ip vrf add interfaces=ether2 name=cust-a', '/ip address add address=10.1.20.2/24 interface=ether2 network=10.1.20.0',
    '### /ip arp print detail without-paging', ' 0 DC address=10.1.20.11 mac-address=AA:00:00:00:00:03 interface=ether2'];
  const dup = build(NET() + PE2.join('\n') + '\n'); const Q = S.query(dup);
  assert.deepStrictEqual(dup.findings.filter((f) => f.id === 'A09' || f.id === 'A01').map(Q.findingKey), [
    '["A01","ip:10.1.20.11@cust-a","mac:AA0000000002","mac:AA0000000003"]',
    '["A09","interface:PE2|ether2","interface:PE|ether2","ip:10.1.20.2@cust-a"]']);
  assert.ok(['PE', 'PE2'].includes(Q.findingDevice(dup.findings.find((f) => f.id === 'A09'))), 'ip 實體的位址鍵對得回擁有者');
});

test('VRF：查詢以位址鍵分開（ipOwner、findIp、ipEntries、prefixEntries、routesOf、subnetsOf）；不存在的 VRF 丟出錯誤', () => {
  const s = build(NET()); const Q = S.query(s);
  assert.deepStrictEqual(Q.vrfs(), ['main', 'cust-a']);
  assert.deepStrictEqual([Q.ipOwner('10.1.20.2'), Q.ipOwner('10.1.20.2@cust-a'), Q.ipOwner('10.1.20.2', 'cust-a')], ['CORE|vlan20', 'PE|ether2', 'PE|ether2']);
  const all = Q.findIp('10.1.20.2');
  assert.deepStrictEqual([all.vrf, all.vrfs, all.owner, all.owners], [null, ['main', 'cust-a'], 'CORE|vlan20', [{ vrf: 'main', ep: 'CORE|vlan20' }, { vrf: 'cust-a', ep: 'PE|ether2' }]]);
  const one = Q.findIp('10.1.20.11', 'cust-a');
  assert.deepStrictEqual([one.owner, one.arps.map((a) => a.dev), one.subnets.map((x) => x.prefix)], [null, ['PE'], ['10.1.20.0/24@cust-a']]);
  assert.throws(() => Q.findIp('10.1.20.2', 'nope'), /VRF/);
  assert.deepStrictEqual(Q.ipEntries().filter((r) => r.ip === '10.1.20.2').map((r) => [r.key, r.vrf, r.owner]), [['10.1.20.2', 'main', 'CORE|vlan20'], ['10.1.20.2@cust-a', 'cust-a', 'PE|ether2']]);
  assert.deepStrictEqual(Q.prefixEntries().filter((p) => p.prefix === '10.1.20.0/24').map((p) => [p.key, p.ipCount]), [['10.1.20.0/24', 2], ['10.1.20.0/24@cust-a', 2]]);
  assert.deepStrictEqual(Q.routesOf('PE', 'cust-a').map((r) => r.prefix + '/' + r.len), ['0.0.0.0/0', '10.1.20.0/24', '172.16.10.0/24', '192.168.50.0/24']);
  assert.strictEqual(Q.routesOf('PE').length, 6, '不給 vrf 時是所有路由表');
  assert.throws(() => Q.routesOf('PE', 'isp2'), /VRF/, '策略路由表不是 VRF');
  assert.deepStrictEqual(Q.subnetsOf('PE', 'cust-a').map((x) => x.prefix), ['10.1.20.0/24@cust-a', '192.168.50.0/24@cust-a']);
  assert.deepStrictEqual(Q.hopOwner('CE', '192.168.50.1', 'main'), { key: 'PE|ether3', dev: 'PE', vrf: 'cust-a', crossVrf: true });
});

test('VRF：S.trace 在 VRF 的路由表追蹤；@main 的閘道換到 main；位址重疊時要指定 vrf', () => {
  const s = build(NET()); const Q = S.query(s);
  const t = S.trace(Q, '172.16.10.10', '10.1.20.50');
  assert.strictEqual(t.vrf, 'main');
  assert.deepStrictEqual(t.hops.map((h) => [h.dev, h.vrf]), [['CE', 'main']]);
  assert.deepStrictEqual(t.hops[0].next.map((n) => [n.dev, n.vrf, n.crossVrf]), [['PE', 'cust-a', true]], 'CE 在 main、PE 的同一個網段在 cust-a');
  assert.deepStrictEqual(t.ends.map((e) => [e.dev, e.vrf, e.status]), [['PE', 'cust-a', 'reached']], '在 cust-a 的 10.1.20.0/24 送達，不是 CORE 的 main');
  const amb = S.trace(Q, '10.1.20.50', '8.8.8.8');
  assert.deepStrictEqual([amb.ok, amb.vrfs], [false, ['main', 'cust-a']]);
  const leak = S.trace(Q, '10.1.20.50', '10.0.0.77', { vrf: 'cust-a' });
  assert.deepStrictEqual(leak.hops.map((h) => [h.dev, h.vrf, h.route]), [['PE', 'cust-a', '0.0.0.0/0']]);
  assert.deepStrictEqual(leak.hops[0].next.map((n) => [n.ip, n.dev, n.vrf]), [['10.0.0.254', 'CORE', 'main']]);
  assert.deepStrictEqual(leak.ends.map((e) => [e.dev, e.vrf, e.status]), [['CORE', 'main', 'reached']]);
  assert.throws(() => S.trace(Q, '10.1.20.50', '8.8.8.8', { vrf: 'nope' }), TypeError);
});

test('VRF：只用 main 的網路，S.trace 與 Q.reach 的輸出和 2.11.0 相同（文字不寫 VRF main；tests/fixtures/vrf/trace-2.11-main-only.json）', () => {
  const fx = JSON.parse(read('tests/fixtures/vrf/trace-2.11-main-only.json'));
  const s = build(fx.input.join('\n') + '\n'); const Q = S.query(s);
  assert.deepStrictEqual([i03(s).length, Q.vrfs()], [0, ['main']]);
  // M3 新增的欄位（只用 main 時是固定值）另外檢查，其餘必須和 2.11.0 完全相同
  const M3 = { vrf: 'main', via: ['main'], table: 'main', rule: null, crossVrf: false, note: null };
  const strip = (o, at) => Array.isArray(o) ? o.map((x) => strip(x, at)) : o && typeof o === 'object'
    ? Object.keys(o).reduce((a, k) => {
      if (k in M3 && (k !== 'note' || o[k] === null)) { assert.deepStrictEqual(o[k], M3[k], `${at}.${k}`); return a; }
      a[k] = strip(o[k], at + '.' + k); return a;
    }, {}) : o;
  const TEXT = new Set(['note', 'error', 'message', 'detail']);
  const texts = (o, out) => {
    if (Array.isArray(o)) o.forEach((x) => texts(x, out));
    else if (o && typeof o === 'object') Object.keys(o).forEach((k) => { if (k !== 'assumptions') { if (typeof o[k] === 'string' && TEXT.has(k)) out.push(o[k]); else texts(o[k], out); } });
    return out;
  };
  fx.cases.forEach(([src, dst], n) => {
    assert.deepStrictEqual(strip(S.trace(Q, src, dst), `${src}→${dst}`), fx.expected[n].trace, `trace ${src}→${dst}`);
    assert.deepStrictEqual(texts(Q.reach(src, dst, { proto: 'tcp', port: 22 }), []), fx.expected[n].reach, `reach ${src}→${dst}`);
  });
  assert.ok(fx.expected.some((e) => e.trace.ends && e.trace.ends.some((x) => x.status === 'loop')) && fx.expected.some((e) => !e.trace.ok), '涵蓋直連、迴圈與找不到起點');
});

test('VRF：Q.search 的 IP 副標，位址在多個 VRF 時寫出數量與名稱；只在 main 時與 2.11.0 相同', () => {
  const Q = S.query(build(NET()));
  const sub = (ip) => Q.search(ip).find((r) => r.type === 'ip').sub;
  assert.strictEqual(sub('10.1.20.2'), '介面位址 · ' + Q.epName('CORE|vlan20') + ' · 在 2 個 VRF：main、cust-a', '重疊的位址');
  assert.strictEqual(sub('10.1.20.11'), 'ARP：aa:00:00:00:00:01, aa:00:00:00:00:02 · 在 2 個 VRF：main、cust-a');
  assert.strictEqual(sub('192.168.50.1'), '介面位址 · ' + Q.epName('PE|ether3') + ' · 在 2 個 VRF：main、cust-a', 'CE 的 main 也有這個網段（同 Q.findIp 的 vrfs；S.trace 也要指定 vrf）');
  const only = S.query(build(['R (10.0.0.1):', '### /export terse', '/ip vrf add interfaces=ether2 name=cust-b',
    '/ip address add address=10.0.0.1/24 interface=ether1 network=10.0.0.0', '/ip address add address=10.8.0.1/24 interface=ether2 network=10.8.0.0'].join('\n') + '\n'));
  assert.strictEqual(only.search('10.8.0.1')[0].sub, '介面位址 · ' + only.epName('R|ether2') + ' · VRF cust-b', '只在一個非 main 的 VRF');
  assert.strictEqual(sub('10.0.0.254'), '介面位址 · ' + Q.epName('CORE|ether1'), '只在 main：不寫 VRF');
  assert.strictEqual(sub('203.0.113.1'), '基準中沒有這個 IP');
  const fx = JSON.parse(read('tests/fixtures/vrf/trace-2.11-main-only.json'));
  const main = S.query(build(fx.input.join('\n') + '\n'));
  // 2.11.0 的文字
  assert.deepStrictEqual(['10.0.12.1', '192.168.1.10'].map((ip) => main.search(ip)[0].sub), ['介面位址 · A ether1', '屬於 A ether2 的網段']);
});

test('VRF：Q.reach、zone、L3 子網圖依 VRF 分開', () => {
  const s = build(NET()); const Q = S.query(s);
  const r = Q.reach('172.16.10.10', '10.1.20.50', { proto: 'tcp', port: 22 });
  assert.deepStrictEqual([r.verdict, r.vrf, r.final], ['allow', 'main', { dst: '10.1.20.50', port: 22, vrf: 'cust-a' }]);
  assert.deepStrictEqual(r.paths[0].hops.map((h) => [h.dev, h.vrf]), [['CE', 'main'], ['PE', 'cust-a']]);
  const leak = Q.reach('10.1.20.50', '10.0.0.77', { proto: 'icmp', vrf: 'cust-a' });
  assert.deepStrictEqual([leak.verdict, leak.final.vrf, leak.paths[0].hops.map((h) => [h.dev, h.vrf, h.route.gatewayVrf])], ['allow', 'main', [['PE', 'cust-a', 'main'], ['CORE', 'main', null]]]);
  assert.deepStrictEqual(Q.reach('10.1.20.50', '8.8.8.8', { proto: 'icmp' }).vrfs, ['main', 'cust-a']);
  assert.throws(() => Q.reach('10.1.20.50', '8.8.8.8', { proto: 'icmp', vrf: 'nope' }), TypeError);
  assert.ok(Q.reach('10.1.20.50', '8.8.8.8', { proto: 'icmp', entry: 'PE|ether2' }).vrf === 'cust-a', 'entry 決定 VRF');
  assert.throws(() => Q.reach('10.1.20.50', '8.8.8.8', { proto: 'icmp', entry: 'PE|ether2', vrf: 'main' }), TypeError);
  const z = Q.zones();
  const sub = z.subnets.filter((x) => x.prefix === '10.1.20.0/24').map((x) => [x.key, x.vrf, x.zone]);
  assert.deepStrictEqual(sub, [['10.1.20.0/24', 'main', 'subnet:10.1.20.0/24'], ['10.1.20.0/24@cust-a', 'cust-a', 'subnet:10.1.20.0/24@cust-a']]);
  assert.strictEqual(z.zones.find((x) => x.id === 'subnet:10.1.20.0/24@cust-a').name, '10.1.20.0/24（VRF cust-a）');
  assert.deepStrictEqual(Q.zoneOf('10.1.20.50', { vrf: 'cust-a' }).zone, 'subnet:10.1.20.0/24@cust-a');
  assert.throws(() => Q.zoneOf('10.1.20.50'), /VRF/, '重疊的位址要指定 vrf');
  const mx = Q.zoneMatrix();
  assert.deepStrictEqual(mx.vrfs, ['main', 'cust-a']);
  const g = Q.subnetGraph({ routes: true });
  assert.deepStrictEqual(g.subnets.filter((x) => x.prefix === '10.1.20.0/24').map((x) => [x.id, x.vrf, x.devices]), [['10.1.20.0/24', 'main', ['CORE']], ['10.1.20.0/24@cust-a', 'cust-a', ['PE']]]);
  assert.deepStrictEqual(g.nodes.filter((n) => n.dev === 'PE').map((n) => [n.id, n.vrf]), [['PE', 'main'], ['PE@cust-a', 'cust-a']], '設備在每個 VRF 各一個節點');
  assert.deepStrictEqual(g.routes.filter((x) => x.dev === 'PE').map((x) => [x.subnet, x.node, x.vrf]), [['0.0.0.0/0@cust-a', 'PE@cust-a', 'cust-a'], ['172.16.10.0/24@cust-a', 'PE@cust-a', 'cust-a']]);
  assert.deepStrictEqual(g.omitted, { policyRoutes: 1 });
});

test('VRF 介面當閘道的路由洩漏（tests/fixtures/vrf/routeros7-vrf-interface-leak.txt，依手冊 VRF 的寫法自行撰寫）：兩行旗標說明、gateway 是 VRF 介面時換到那個 VRF', () => {
  const s = build(read('tests/fixtures/vrf/routeros7-vrf-interface-leak.txt'));
  assert.deepStrictEqual([i03(s).map((f) => f.message), count(s, 'I01')], [[], 0]);
  assert.deepStrictEqual(s.model.routes.map((r) => [r.prefix + '/' + r.len, r.vrf, r.nh.map((n) => [n.ifc, n.vrf, n.vrfBasis])]), [
    ['10.31.0.0/24', 'blue', [['ether5', 'blue', 'explicit']]], ['10.31.0.0/24', 'green', [['blue', 'blue', 'vrf-interface']]],
    ['10.32.0.0/24', 'blue', [['green', 'green', 'vrf-interface']]], ['10.32.0.0/24', 'green', [['ether6', 'green', 'explicit']]]]);
  const t = S.trace(S.query(s), '10.32.0.2', '10.31.0.2');
  assert.deepStrictEqual([t.vrf, t.ends.map((e) => [e.vrf, e.status])], ['green', [['blue', 'reached']]]);
});

// 策略路由（RouterOS 7）：/routing table、/routing rule、mangle mark-routing（https://manual.mikrotik.com/docs/cli-reference/routing/rule.md、
// https://manual.mikrotik.com/docs/cli-reference/routing/table.md、https://manual.mikrotik.com/docs/user-guides/routing-and-networking-protocols/routing-decision.md）
const POL = (extra) => ['R (10.0.0.1):', '### /export terse',
  '/ip address add address=10.0.0.1/24 interface=ether1 network=10.0.0.0', '/ip address add address=10.8.0.1/24 interface=ether8 network=10.8.0.0',
  '/ip address add address=192.168.1.1/24 interface=ether2 network=192.168.1.0',
  '/routing table add disabled=no fib name=isp2', ...(extra || []),
  '### /ip route print detail without-paging', FLAGS7,
  ' DAc dst-address=10.0.0.0/24 routing-table=main gateway=ether1 immediate-gw=ether1 distance=0',
  ' DAc dst-address=10.8.0.0/24 routing-table=main gateway=ether8 immediate-gw=ether8 distance=0',
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=ether2 immediate-gw=ether2 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=10.0.0.254 immediate-gw=10.0.0.254%ether1 distance=1',
  ' As dst-address=0.0.0.0/0 routing-table=isp2 gateway=10.8.0.254 immediate-gw=10.8.0.254%ether8 distance=1'].join('\n') + '\n';
test('策略路由：/routing table、/routing rule 是事實；沒有 rule 時路由表 isp2 不影響結果', () => {
  const s = build(POL());
  assert.deepStrictEqual(i03(s).map((f) => f.message), []);
  assert.deepStrictEqual(s.model.routingTables.map((t) => [t.dev, t.name, t.fib, t.source, t.vrf]), [['R', 'isp2', true, 'export', null]]);
  assert.deepStrictEqual(s.model.routes.filter((r) => r.routingTable === 'isp2').map((r) => r.vrf), [null], '策略路由表不是 VRF');
  const Q = S.query(s);
  assert.strictEqual(Q.policyOf('R').any, false);
  const t = S.trace(Q, '192.168.1.10', '8.8.8.8');
  assert.deepStrictEqual(t.hops.map((h) => [h.dev, h.table, h.route, h.next.map((n) => n.ip)]), [['R', 'main', '0.0.0.0/0', ['10.0.0.254']]]);
});
test('策略路由：src-address 的 rule 改查 isp2；條件無法判斷、mark-routing、改過 policy-rules 時為不明（policy-routing），不假設查 main', () => {
  const s = build(POL(['/routing rule add action=lookup-only-in-table src-address=192.168.1.128/25 table=isp2', '/routing rule add action=drop dst-address=10.66.0.0/16']));
  const Q = S.query(s);
  assert.deepStrictEqual(s.model.routingRules.map((r) => [r.order, r.action, r.table, r.match]), [[1, 'lookup-only-in-table', 'isp2', { 'src-address': '192.168.1.128/25' }], [2, 'drop', null, { 'dst-address': '10.66.0.0/16' }]]);
  const viaIsp2 = S.trace(Q, '192.168.1.200', '8.8.8.8');
  assert.deepStrictEqual(viaIsp2.hops.map((h) => [h.table, h.rule && h.rule.order, h.next.map((n) => n.ip)]), [['isp2', 1, ['10.8.0.254']]]);
  assert.deepStrictEqual(S.trace(Q, '192.168.1.10', '8.8.8.8').hops.map((h) => [h.table, h.next.map((n) => n.ip)]), [['main', ['10.0.0.254']]], '不符合 rule 的來源查 main');
  assert.deepStrictEqual(S.trace(Q, '192.168.1.10', '10.66.1.1').ends.map((e) => e.status), ['policy-drop']);
  const r1 = Q.reach('192.168.1.200', '8.8.8.8', { proto: 'tcp', port: 443 });
  assert.deepStrictEqual([r1.paths[0].hops[0].route.table, r1.paths[0].hops[0].route.gateway], ['isp2', '10.8.0.254']);
  assert.deepStrictEqual(Q.reach('192.168.1.10', '10.66.1.1', { proto: 'icmp' }).verdict, 'deny');
  // 條件無法判斷（min-prefix）：不明
  const odd = S.query(build(POL(['/routing rule add action=lookup dst-address=8.8.8.0/24 min-prefix=0 table=main'])));
  assert.deepStrictEqual(S.trace(odd, '192.168.1.10', '8.8.8.8').ends.map((e) => e.status), ['policy']);
  const r2 = odd.reach('192.168.1.10', '8.8.8.8', { proto: 'tcp', port: 443 });
  assert.deepStrictEqual([r2.verdict, r2.reasons.map((x) => x.code)], ['unknown', ['policy-routing']]);
  assert.strictEqual(S.trace(odd, '192.168.1.10', '1.1.1.1').hops[0].table, 'main', '條件明確不符時照常查 main');
  // mangle mark-routing（mangle 不在模型中）與改過的 policy-rules：這台設備的查表都不明
  const mk = S.query(build(POL(['/ip firewall mangle add action=mark-routing chain=prerouting new-routing-mark=isp2 src-address=192.168.1.0/24 passthrough=no'])));
  assert.deepStrictEqual([mk.policyOf('R').marks.length, S.trace(mk, '192.168.1.10', '8.8.8.8').ends[0].status], [1, 'policy']);
  const ps = S.query(build(POL(['/routing settings set policy-rules=vrf-lookup,vrf-unreach,local,user,mangle,main'])));
  assert.deepStrictEqual([ps.policyOf('R').custom, ps.reach('192.168.1.10', '8.8.8.8', { proto: 'icmp' }).verdict], [true, 'unknown']);
  assert.ok(S.query.reachReasonCodes().some((x) => x.code === 'policy-routing') && S.query.reachAssumptions().some((x) => x.code === 'policy-routing'));
});
test('策略路由：封包在 VRF 時查那個 VRF，使用者的 rule 在 VRF 之後（routing-decision 的預設順序）', () => {
  const s = build(NET(PE(['/ip vrf add interfaces=ether2,ether3 name=cust-a', '/routing rule add action=drop src-address=172.16.10.0/24']))); const Q = S.query(s);
  assert.deepStrictEqual(S.trace(Q, '172.16.10.10', '10.1.20.50').ends.map((e) => [e.dev, e.vrf, e.status]), [['PE', 'cust-a', 'reached']], 'CE 的封包進 PE 的 cust-a，不經過 rule');
  assert.deepStrictEqual(S.trace(Q, '10.0.0.77', '172.16.10.10').ends.map((e) => e.status).includes('policy-drop'), false);
});


test('VRF：只用 main 的網路，findingKey 與加入 VRF 之前（2.11.0）相同；範例資料的 VRF 部分不產生誤報', () => {
  const s = sampleSnap(); const Q = S.query(s);
  const before = JSON.parse(read('tests/fixtures/vrf/sample-2.11-finding-keys.json')).keys;
  assert.deepStrictEqual(keys(s), before, '範例資料加入 VRF 路由器後，finding 與 2.11.0 完全相同（重疊的 IP 不是 A01／A09）');
  assert.ok(Q.vrfs().includes('cust-a'), '範例資料要有 VRF');
  const main = build(['A (10.0.0.1):', '### /export terse', '/ip address add address=10.0.10.1/24 interface=ether5',
    'B (10.0.0.2):', '### /export terse', '/ip address add address=10.0.10.1/24 interface=ether5'].join('\n') + '\n');
  assert.deepStrictEqual(keys(main).filter((k) => k.startsWith('["A09"')), ['["A09","interface:A|ether5","interface:B|ether5","ip:10.0.10.1"]'], 'main 不加後綴');
  // 範例資料：trace／reach 在 VRF 內查到正確的路由表
  const ce = S.trace(Q, '172.16.10.10', '10.1.20.50');
  assert.deepStrictEqual(ce.ends.map((e) => [e.dev, e.vrf, e.status]), [['TPE_PE_RT_01', 'cust-a', 'reached']]);
  const leak = Q.reach('10.1.20.50', '10.1.30.11', { proto: 'tcp', port: 443, vrf: 'cust-a' });
  assert.deepStrictEqual(leak.paths[0].hops.map((h) => [h.dev, h.vrf]), [['TPE_PE_RT_01', 'cust-a'], ['TPE_CORE_RT_01', 'main']], '預設路由洩漏到 main');
  assert.strictEqual(Q.reach('10.1.20.50', '10.1.30.11', { proto: 'tcp', port: 443, vrf: 'main' }).paths[0].hops[0].dev !== 'TPE_PE_RT_01', true);
  // 範例資料的策略路由（CE）：172.16.10.128/25 只查 to-isp2；往 203.0.113.0/24 的 rule 有 min-prefix，無法判斷
  assert.deepStrictEqual(S.trace(Q, '172.16.10.200', '8.8.8.8').hops[0].table, 'to-isp2');
  assert.deepStrictEqual(S.trace(Q, '172.16.10.10', '8.8.8.8').hops[0].table, 'main');
  const pr = Q.reach('172.16.10.10', '203.0.113.9', { proto: 'icmp' });
  assert.deepStrictEqual([pr.verdict, pr.reasons.map((x) => x.code)], ['unknown', ['policy-routing']]);
  assert.deepStrictEqual(s.model.routingRules.map((r) => [r.dev, r.order, r.action]), [['TPE_CE_RT_01', 1, 'lookup-only-in-table'], ['TPE_CE_RT_01', 2, 'lookup']]);
});
