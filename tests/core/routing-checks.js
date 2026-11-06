// ADR-023 階段 3b：現有檢查改用對外邊界與路由網域（F03／F04／F07／F08／F15、R01、R02、A08），新增路由檢查 R07–R15，
// 以及檢查與 L4（暴露清單、Q.reach）結論的一致性。手寫的 RouterOS 輸出依手冊撰寫，不是從真實設備擷取。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { S, ROOT, build, test, sampleSnap } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/** 一台設備：export 的行，與（選用的）路由表。 */
const dev = (name, ip, exp, routes) => [`${name} (${ip}):`, '### /export terse', ...exp].concat(routes ? ['### /ip route print detail without-paging', RT, ...routes] : []);
const C = (net, ifc) => ` DAc dst-address=${net} routing-table=main gateway=${ifc} immediate-gw=${ifc} distance=0`;
const R = (dst, gw, ifc, extra) => ` As  dst-address=${dst} routing-table=main gateway=${gw} immediate-gw=${gw}%${ifc} distance=1${extra ? ' ' + extra : ''}`;
const addr = (cidr, ifc) => `/ip address add address=${cidr} interface=${ifc}`;
const of = (s, id) => s.findings.filter((f) => f.id === id);
const msgs = (s, id) => of(s, id).map((f) => f.message);
const T = (...devs) => build(devs.map((d) => d.join('\n')).join('\n'));

// ---------------------------------------------------------------- 現有檢查改用同一份推論（決策 7）
test('F08 只在完全沒有對外證據時報；沒有 WAN 清單、但有預設路由的出介面時，F03 以它為入口，訊息寫出判定的依據', () => {
  const base = [addr('192.168.1.1/24', 'bridge1'), addr('81.2.3.2/30', 'ether1'), '/ip firewall filter add action=accept chain=input dst-port=8291 protocol=tcp'];
  const s = T(dev('R', '192.168.1.1', base, [C('192.168.1.0/24', 'bridge1'), C('81.2.3.0/30', 'ether1'), R('0.0.0.0/0', '81.2.3.1', 'ether1')]));
  assert.deepStrictEqual(of(s, 'F08'), []);
  assert.deepStrictEqual(msgs(s, 'F03'), ['R IPv4 filter input 第 1 條（accept dst-port=8291 protocol=tcp）讓對外介面 ether1（判定對外的依據：預設路由的出介面）可以主動建立新連線']);
  // 沒有路由表：只有公網位址（弱證據），F08 說明找邊界的依據都沒有，列出可能對外的介面
  const weak = T(dev('R', '192.168.1.1', base));
  assert.deepStrictEqual([of(weak, 'F03').length, of(weak, 'F08').length], [0, 1]);
  assert.ok(/也沒有預設路由、DHCP／PPPoE client 的預設路由或 NAT 的出入介面可以推論；ether1 有公網位址，只是可能對外（弱證據），不判定/.test(of(weak, 'F08')[0].message), of(weak, 'F08')[0].message);
});

test('F04：dst-nat 的目標沒有路由時不列（改報 R09）；目標在直連網段時照常列', () => {
  const exp = (to) => ['/interface list add name=WAN', '/interface list member add interface=ether1 list=WAN', addr('192.168.1.1/24', 'bridge1'), addr('81.2.3.2/30', 'ether1'),
    `/ip firewall nat add action=dst-nat chain=dstnat dst-port=8080 in-interface-list=WAN protocol=tcp to-addresses=${to}`];
  const routes = [C('192.168.1.0/24', 'bridge1'), C('81.2.3.0/30', 'ether1'), R('0.0.0.0/0', '81.2.3.1', 'ether1')];
  const ok = T(dev('R', '192.168.1.1', exp('192.168.1.10'), routes));
  assert.deepStrictEqual([of(ok, 'F04').length, of(ok, 'R09').length], [1, 0]);
  // 私有位址只符合往 ISP 的預設路由：會被送回外部
  const gone = T(dev('R', '192.168.1.1', exp('10.9.9.9'), routes));
  assert.deepStrictEqual([of(gone, 'F04').length, msgs(gone, 'R09')],
    [0, ['R IPv4 nat dstnat 第 1 條（dst-nat dst-port=8080 in-interface-list=WAN protocol=tcp）轉送到 10.9.9.9，但 10.9.9.9 是私有位址，只符合經對外介面 ether1 的路由 0.0.0.0/0，會被送回外部']]);
  assert.deepStrictEqual(of(gone, 'R09')[0].entities.map((e) => e.type), ['device', 'rule']);
  // 沒有符合的路由、黑洞
  const none = T(dev('R', '192.168.1.1', exp('10.9.9.9'), routes.slice(0, 2)));
  assert.ok(/R 沒有到 10\.9\.9\.9 的路由/.test(msgs(none, 'R09')[0]), msgs(none, 'R09')[0]);
  const bh = T(dev('R', '192.168.1.1', exp('10.9.9.9'), routes.concat([' As  dst-address=10.9.0.0/16 routing-table=main blackhole distance=1'])));
  assert.ok(/落入黑洞路由 10\.9\.0\.0\/16/.test(msgs(bh, 'R09')[0]), msgs(bh, 'R09')[0]);
  // 沒有路由表資料：無法判斷，不報 R09，F04 照常
  const nodata = T(dev('R', '192.168.1.1', exp('10.9.9.9')));
  assert.deepStrictEqual([of(nodata, 'F04').length, of(nodata, 'R09').length], [1, 0]);
});

test('F15：forward 只在會轉送的設備報（同一個 VRF 有兩個以上 L3 介面）；只有管理位址的交換器不報 forward，input 照常', () => {
  const rules = ['/ip firewall filter add action=accept chain=forward connection-state=new in-interface=vlan10', '/ip firewall filter add action=drop chain=forward',
    '/ip firewall filter add action=drop chain=input'];
  const one = T(dev('SW', '10.0.0.2', [addr('10.0.0.2/24', 'vlan10'), ...rules]));
  assert.deepStrictEqual(of(one, 'F15').map((f) => /filter (\w+)/.exec(f.message)[1]), ['input']);
  const two = T(dev('R', '10.0.0.1', [addr('10.0.0.1/24', 'vlan10'), addr('10.0.1.1/24', 'vlan11'), ...rules]));
  assert.deepStrictEqual(of(two, 'F15').map((f) => /filter (\w+)/.exec(f.message)[1]).sort(), ['forward', 'input']);
  // 沒有任何位址的事實：不明，照常檢查
  const none = T(dev('R', '10.0.0.1', rules));
  assert.strictEqual(of(none, 'F15').length, 2);
});

test('R01：出介面判定為對外的下一跳（ISP 閘道）不列，訊息另外註明；其他到不了已知設備的下一跳照常列', () => {
  const s = T(dev('R', '192.168.1.1', [addr('192.168.1.1/24', 'bridge1'), addr('81.2.3.2/30', 'ether1')],
    [C('192.168.1.0/24', 'bridge1'), C('81.2.3.0/30', 'ether1'), R('0.0.0.0/0', '81.2.3.1', 'ether1'), R('10.200.0.0/16', '192.168.1.254', 'bridge1')]));
  assert.deepStrictEqual(msgs(s, 'R01'), ['R：192.168.1.254（另有 81.2.3.1 經對外介面 ether1（判定對外的依據：預設路由的出介面），是電信業者等外部的閘道，不列）']);
  const isp = T(dev('R', '192.168.1.1', [addr('81.2.3.2/30', 'ether1')], [C('81.2.3.0/30', 'ether1'), R('0.0.0.0/0', '81.2.3.1', 'ether1')]));
  assert.deepStrictEqual(of(isp, 'R01'), []);
});

// ---------------------------------------------------------------- 新增路由檢查 R07–R15（決策 8）
/** 邊界路由器：WAN 清單只有 ether1、masquerade 走 WAN 清單；ether2 有 DHCP client（加預設路由、沒有 check-gateway）。 */
const EDGE = (extra, routes, dhcpRoute = true) => dev('E', '192.168.1.1', ['/interface bridge add name=bridge1', '/interface list add name=WAN', '/interface list add name=LAN',
  '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=bridge1 list=LAN',
  addr('192.168.1.1/24', 'bridge1'), addr('81.2.3.2/30', 'ether1'), '/ip dhcp-client add interface=ether2',
  '/ip firewall nat add action=masquerade chain=srcnat out-interface-list=WAN', ...(extra || [])],
[C('192.168.1.0/24', 'bridge1'), C('81.2.3.0/30', 'ether1'), R('0.0.0.0/0', '81.2.3.1', 'ether1', 'check-gateway=ping'),
  ...(dhcpRoute ? [' Dd  dst-address=0.0.0.0/0 routing-table=main gateway=100.64.9.1 immediate-gw=100.64.9.1%ether2 distance=5'] : []), ...(routes || [])]); // DHCP client 裝進來的備援預設路由（下一跳不在基準）

test('R07：預設路由的出口（DHCP client）沒有 srcnat；不限出介面的 masquerade、沒有 NAT 時不報', () => {
  const s = T(EDGE());
  assert.deepStrictEqual(msgs(s, 'R07'), ['E：預設路由的出口 ether2（預設路由的出介面、DHCP client 加入的預設路由）沒有 srcnat，masquerade／src-nat 只在 ether1；改由這個出口上網時，私有位址不會轉換']);
  assert.deepStrictEqual(of(s, 'R07')[0].entities, [{ type: 'device', key: 'E' }, { type: 'interface', key: 'E|ether2' }]);
  assert.strictEqual(of(T(EDGE(['/ip firewall nat add action=masquerade chain=srcnat'])), 'R07').length, 0, '不限出介面：全部出口都做 NAT');
  assert.strictEqual(of(T(EDGE(['/ip firewall nat add action=masquerade chain=srcnat out-interface=ether2'])), 'R07').length, 0);
});

test('R08：有對外強證據卻不在 WAN 清單；在 WAN 清單、預設路由卻指向基準內的設備', () => {
  const s = T(EDGE());
  assert.deepStrictEqual(msgs(s, 'R08'), ['E ether2：預設路由的出介面、DHCP client 加入的預設路由（判定對外），但不在 WAN 清單（WAN）；依 WAN 清單的防火牆規則不會套用到這個介面']);
  // B 的 WAN 清單是 ether1，預設路由經 ether1 指向 E（基準內）
  const b = dev('B', '192.168.1.2', ['/interface list add name=WAN', '/interface list member add interface=ether1 list=WAN', addr('192.168.1.2/24', 'ether1')],
    [C('192.168.1.0/24', 'ether1'), R('0.0.0.0/0', '192.168.1.1', 'ether1')]);
  const s2 = T(EDGE(), b);
  assert.ok(msgs(s2, 'R08').includes('B ether1：在 WAN 清單（WAN），但預設路由的下一跳 192.168.1.1 是基準內的設備（指向內部）'), JSON.stringify(msgs(s2, 'R08')));
  assert.strictEqual(of(T(dev('X', '10.0.0.1', [addr('10.0.0.1/24', 'ether2'), '/ip dhcp-client add interface=ether2'])), 'R08').length, 0, '沒有 WAN 清單時不是矛盾');
});

test('R11：同一張路由表兩條以上預設路由，有沒設 check-gateway 的（含 DHCP client、非作用中的備援）；只有一條或都有設時不報', () => {
  assert.deepStrictEqual(msgs(T(EDGE()), 'R11'), ['E：路由表 main 有 2 條預設路由，DHCP client ether2 沒有設 check-gateway；閘道失效但介面仍在時，路由不會自動切換']);
  const backup = T(dev('R', '10.0.0.1', [addr('10.0.0.1/30', 'ether1'), addr('10.0.1.1/30', 'ether2')],
    [C('10.0.0.0/30', 'ether1'), C('10.0.1.0/30', 'ether2'), R('0.0.0.0/0', '10.0.0.2', 'ether1'), '  s  dst-address=0.0.0.0/0 routing-table=main gateway=10.0.1.2 distance=10']));
  assert.deepStrictEqual(msgs(backup, 'R11'), ['R：路由表 main 有 2 條預設路由，gateway=10.0.0.2、gateway=10.0.1.2（非作用中）沒有設 check-gateway；閘道失效但介面仍在時，路由不會自動切換']);
  assert.strictEqual(of(T(EDGE(['/ip dhcp-client set [ find interface=ether2 ] check-gateway=ping'])), 'R11').length, 0);
  assert.strictEqual(of(T(EDGE(['/ip dhcp-client set [ find interface=ether2 ] add-default-route=no'], [], false)), 'R11').length, 0, '只有一條');
});

/** 兩台路由器：A 有到 B 的 10.2.0.0/24 的靜態路由；B 只有直連（沒有回到 A 的 10.1.0.0/24）。 */
const AB = (bRoutes) => [dev('A', '10.0.0.1', [addr('10.0.0.1/30', 'ether1'), addr('10.1.0.1/24', 'ether2')], [C('10.0.0.0/30', 'ether1'), C('10.1.0.0/24', 'ether2'), R('10.2.0.0/24', '10.0.0.2', 'ether1')]),
  dev('B', '10.0.0.2', [addr('10.0.0.2/30', 'ether1'), addr('10.2.0.1/24', 'ether2')], [C('10.0.0.0/30', 'ether1'), C('10.2.0.0/24', 'ether2')].concat(bRoutes || []))];

test('R10：只有去程、沒有回程（推論）；/30 鏈路不當來源；補上回程或預設路由指向基準內時不報', () => {
  const s = T(...AB());
  assert.deepStrictEqual(msgs(s, 'R10'), ['A 有到 B 的 10.2.0.0/24 的路由（10.2.0.0/24），但 B 回到 A 的 10.1.0.0/24（沒有路由）；這些網段之間的連線只有去程']);
  assert.deepStrictEqual(of(s, 'R10')[0].entities, [{ type: 'device', key: 'A' }, { type: 'device', key: 'B' }]);
  assert.strictEqual(of(T(...AB([R('10.1.0.0/24', '10.0.0.1', 'ether1')])), 'R10').length, 0);
  assert.strictEqual(of(T(...AB([R('0.0.0.0/0', '10.0.0.1', 'ether1')])), 'R10').length, 0, '預設路由指向 A（基準內）也是回程');
});

test('R12：網段沒有任何其他設備的路由（預設路由不算）；鏈路網段、有路由的網段不報', () => {
  const s = T(...AB([R('0.0.0.0/0', '10.0.0.1', 'ether1')]));
  // B 的 10.2.0.0/24：A 有靜態路由 → 不報；A 的 10.1.0.0/24：B 只有預設路由 → 報
  assert.deepStrictEqual(msgs(s, 'R12'), ['A：10.1.0.0/24（ether2）；其他有路由表的設備都沒有到這些網段的路由（預設路由不算）']);
  assert.strictEqual(of(T(...AB([R('10.1.0.0/24', '10.0.0.1', 'ether1')])), 'R12').length, 0);
  assert.strictEqual(of(T(AB()[0]), 'R12').length, 0, '沒有其他有路由表的設備時不比較');
});

test('R12：雙重 NAT——A 對上游做 masquerade 時，A 後面的網段不需要上游的回程路由，不報；限了目的位址（hairpin 之類）、來源不含這個網段、停用的規則仍報', () => {
  const up = R('0.0.0.0/0', '10.0.0.1', 'ether1');
  // A 的 export 是 dev() 的第 3、4 行（兩個位址），NAT 規則插在它們之後
  const nat = (r) => { const [a, b] = AB([up]); a.splice(4, 0, `/ip firewall nat add ${r}`); return T(a, b); };
  assert.strictEqual(of(T(...AB([up])), 'R12').length, 1, '對照：沒有 NAT 時報');
  assert.strictEqual(of(nat('action=masquerade chain=srcnat out-interface=ether1'), 'R12').length, 0);
  assert.strictEqual(of(nat('action=src-nat chain=srcnat src-address=10.1.0.0/16 to-addresses=10.0.0.1'), 'R12').length, 0, '來源涵蓋這個網段');
  assert.strictEqual(of(nat('action=masquerade chain=srcnat dst-address=10.2.0.10 out-interface=ether1'), 'R12').length, 1, '限了目的位址（hairpin 之類）不算');
  assert.strictEqual(of(nat('action=masquerade chain=srcnat src-address=10.9.0.0/24 out-interface=ether1'), 'R12').length, 1, '來源不含這個網段');
  assert.strictEqual(of(nat('action=masquerade chain=srcnat disabled=yes out-interface=ether1'), 'R12').length, 1, '停用的規則不算');
});

test('對外邊界（ADR-023 修訂 1）：以 DHCP client 取得管理位址的交換器，預設路由的下一跳是基準內的路由器——不是對外，F07／F11／F12／F14 不報；ISP 的 DHCP 仍判定對外', () => {
  const gw = dev('GW', '192.168.88.1', ['/interface bridge add name=bridge1', '/interface list add name=WAN', '/interface list add name=LAN',
    '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=bridge1 list=LAN', addr('192.168.88.1/24', 'bridge1'), addr('81.2.3.2/30', 'ether1'),
    '/ip firewall nat add action=masquerade chain=srcnat out-interface-list=WAN', '/ip firewall filter add action=drop chain=input in-interface-list=WAN'],
  [C('192.168.88.0/24', 'bridge1'), R('0.0.0.0/0', '81.2.3.1', 'ether1')]);
  const sw = (dhcpRoute, exp) => dev('SW', '192.168.88.2', ['/interface bridge add name=bridge', '/ip dhcp-client add interface=bridge', '/ip firewall filter add action=accept chain=input protocol=icmp', ...(exp || [])],
    dhcpRoute === undefined ? undefined : [' DAc dst-address=192.168.88.0/24 routing-table=main gateway=bridge immediate-gw=bridge distance=0',
      ...(dhcpRoute ? [` DAd dst-address=0.0.0.0/0 routing-table=main gateway=${dhcpRoute} immediate-gw=${dhcpRoute}%bridge distance=1`] : [])]);
  const ev = (s) => { const b = S.query(s).boundaryOf('SW|bridge'); return b && [b.status, b.evidence.filter((e) => e.kind === 'dhcp-client').map((e) => `${e.strength}:${e.ref.reason}`)]; };
  const mgmt = T(gw, sw('192.168.88.1', [addr('192.168.88.2/24', 'bridge')]));
  assert.deepStrictEqual(ev(mgmt), ['internal', ['none:next-hop-in-baseline']]);
  ['F07', 'F11', 'F12', 'F14'].forEach((id) => assert.deepStrictEqual(msgs(mgmt, id).filter((m) => m.startsWith('SW')), [], id));
  // 沒有路由表資料、或路由表沒有 DHCP 的預設路由：只是可能對外，不是入口
  assert.deepStrictEqual(ev(T(gw, sw(undefined))), ['possible', ['weak:no-route-data']]);
  assert.deepStrictEqual(ev(T(gw, sw(null))), ['possible', ['weak:no-installed-route']]);
  assert.deepStrictEqual(S.query(T(gw, sw(null))).wanEntries('SW'), []);
  // ISP 的 DHCP：下一跳不在基準 → 強證據，判定對外
  const isp = T(dev('E', '10.0.0.1', ['/ip dhcp-client add interface=ether1', addr('192.168.1.1/24', 'bridge1')],
    [C('192.168.1.0/24', 'bridge1'), ' DAd dst-address=0.0.0.0/0 routing-table=main gateway=100.64.0.1 immediate-gw=100.64.0.1%ether1 distance=1']));
  const e = S.query(isp).boundaryOf('E|ether1');
  assert.deepStrictEqual([e.status, e.evidence.find((x) => x.kind === 'dhcp-client').strength, e.evidence.find((x) => x.kind === 'dhcp-client').ref.gateways], ['external', 'strong', ['100.64.0.1']]);
});

/** OSPF：A 與 B 在 10.0.0.0/30 相連（area-id 各自設定），A 另有使用者網段 10.1.0.0/24（DHCP server）。 */
const OSPF = (aArea, bArea, aExtra, bExtra) => [
  dev('A', '10.0.0.1', [addr('10.0.0.1/30', 'ether1'), addr('10.1.0.1/24', 'ether2'), '/ip dhcp-server network add address=10.1.0.0/24 gateway=10.1.0.1',
    `/routing ospf area add area-id=${aArea} instance=default name=x`, '/routing ospf interface-template add area=x networks=10.0.0.0/30,10.1.0.0/24', ...(aExtra || [])]),
  dev('B', '10.0.0.2', [addr('10.0.0.2/30', 'ether1'), `/routing ospf area add area-id=${bArea} instance=default name=y`, '/routing ospf interface-template add area=y interfaces=ether1', ...(bExtra || [])]),
];

test('R13：同一個網段兩端的 area-id 不同（facet link|網段）；area-id 相同時不報；沒寫 area-id 時不比較', () => {
  const s = T(...OSPF('0.0.0.0', '0.0.0.1'));
  assert.deepStrictEqual(of(s, 'R13').map((f) => [f.facet, f.message]), [['link|10.0.0.0/30', '10.0.0.0/30 在不同設備屬於不同的 OSPF area：A area 0.0.0.0；B area 0.0.0.1']]);
  assert.strictEqual(of(T(...OSPF('0.0.0.0', '0.0.0.0')), 'R13').length, 0);
  const noId = T(...OSPF('0.0.0.0', '0.0.0.1').map((d) => d.map((l) => l.replace(/area-id=\S+ /, ''))));
  assert.strictEqual(of(noId, 'R13').length, 0);
});

test('R13：OSPF 鄰接相連的一組設備有兩個以上 area、卻沒有骨幹 area 0（facet area|組名|area-id）', () => {
  const nb = ['### /routing ospf neighbor print detail without-paging', ' 0 instance=default area=y address=10.0.0.2 router-id=10.0.0.2 state=Full'];
  const a = [`A (10.0.0.1):`, '### /export terse', addr('10.0.0.1/30', 'ether1'), addr('10.1.0.1/24', 'ether2'),
    '/routing ospf area add area-id=0.0.0.1 instance=default name=one', '/routing ospf area add area-id=0.0.0.2 instance=default name=two',
    '/routing ospf interface-template add area=one interfaces=ether1', '/routing ospf interface-template add area=two interfaces=ether2', ...nb];
  const b = dev('B', '10.0.0.2', [addr('10.0.0.2/30', 'ether1'), '/routing ospf area add area-id=0.0.0.1 instance=default name=one', '/routing ospf interface-template add area=one interfaces=ether1']);
  const s = T(a, b);
  assert.deepStrictEqual(of(s, 'R13').map((f) => f.facet).sort(), ['area|A|0.0.0.1', 'area|A|0.0.0.2']);
  assert.ok(of(s, 'R13').every((f) => /沒有接到骨幹 area 0/.test(f.message)));
});

test('R14：不是 passive 的 interface-template 沒有 auth 或沒有 auth-key；passive 與有驗證的不報', () => {
  const s = T(...OSPF('0.0.0.0', '0.0.0.0', [], ['/routing ospf interface-template add area=y auth=md5 interfaces=ether3', '/routing ospf interface-template add area=y auth=md5 auth-key=k interfaces=ether4',
    '/routing ospf interface-template add area=y interfaces=ether5 passive']));
  assert.deepStrictEqual(msgs(s, 'R14'), [
    'A：OSPF interface-template networks=10.0.0.0/30,10.1.0.0/24（沒有設 auth）；同一個網段上的任何設備都可以送 OSPF 封包加入路由',
    'B：OSPF interface-template interfaces=ether1（沒有設 auth）、interfaces=ether3（auth=md5 沒有設 auth-key）；同一個網段上的任何設備都可以送 OSPF 封包加入路由']);
  assert.ok(!JSON.stringify(s).includes('auth-key=k'), '金鑰的值不進基準');
});

test('R15：使用者網段（有 DHCP server）比對到不是 passive 的 template；設了 passive、或網段上有 OSPF 鄰接時不報', () => {
  const s = T(...OSPF('0.0.0.0', '0.0.0.0'));
  assert.deepStrictEqual(msgs(s, 'R15'), ['A：10.1.0.0/24（ether2，有 DHCP server）是使用者網段，比對到的 OSPF interface-template（networks=10.0.0.0/30,10.1.0.0/24）沒有設 passive']);
  const both = '/routing ospf interface-template add area=x networks=10.0.0.0/30,10.1.0.0/24';
  const passive = T(...OSPF('0.0.0.0', '0.0.0.0').map((d) => d.flatMap((l) => (l === both
    ? ['/routing ospf interface-template add area=x networks=10.0.0.0/30', '/routing ospf interface-template add area=x networks=10.1.0.0/24 passive'] : [l]))));
  assert.strictEqual(of(passive, 'R15').length, 0);
  // 網段上有 OSPF 鄰接（A 在 ether2 有鄰居）：可能是刻意的鄰接，不報
  const adj = T(OSPF('0.0.0.0', '0.0.0.0')[0].concat(['### /routing ospf neighbor print detail without-paging', ' 0 instance=default area=x address=10.1.0.9 router-id=10.1.0.9 state=Full']), OSPF('0.0.0.0', '0.0.0.0')[1]);
  assert.strictEqual(of(adj, 'R15').length, 0);
});

test('R02：訊息寫出本端介面所在的 OSPF area', () => {
  const s = T([`A (10.0.0.1):`, '### /export terse', addr('10.9.9.1/30', 'ether1'), '/routing ospf area add area-id=0.0.0.0 instance=default name=backbone',
    '/routing ospf interface-template add area=backbone interfaces=ether1',
    '### /routing ospf neighbor print detail without-paging', ' 0 instance=default area=backbone address=10.9.9.2 router-id=10.255.0.9 state=Full']);
  assert.ok(/的鄰居 10\.255\.0\.9（10\.9\.9\.2），本端在 OSPF area 0\.0\.0\.0$/.test(msgs(s, 'R02')[0]), msgs(s, 'R02')[0]);
});

// ---------------------------------------------------------------- 單一來源：路由視圖、入口
/** 建立基準，同時取得 model（暫時包住 S.check.run）。 */
function capture(text) {
  let M = null; const run = S.check.run;
  S.check.run = function (m) { M = m; return run.apply(this, arguments); };
  try { return { snap: S.build([{ name: 't.txt', text }], { now: '2026-01-01T00:00:00Z' }), M }; } finally { S.check.run = run; }
}

test('模型版的路由視圖（S.infer.routingView）與查詢層的 Q 在範例資料上給 S.trace.lookup 相同的結果；成員就是 S.trace.ROUTING_VIEW', () => {
  const { snap, M } = capture(fs.readFileSync(path.join(ROOT, 'samples', 'sample-bundle.txt'), 'utf8'));
  const Q = S.query(snap); const RV = S.infer.routingView(M); const QV = S.trace.routingOf(Q);
  S.trace.ROUTING_VIEW.forEach((k) => assert.strictEqual(typeof RV[k], 'function', k));
  assert.deepStrictEqual(RV.vrfs(), Q.vrfs());
  const shape = (x) => JSON.stringify({ kind: x.kind, vrf: x.vrf, via: x.via, route: x.route || null, conn: x.conn ? x.conn.prefix + '|' + x.conn.ep : null,
    nhs: (x.nhs || []).map(({ r, n }) => `${r.prefix}/${r.len}>${n.ip || ''}%${n.ifc || ''}@${n.vrf}`) });
  const dsts = ['8.8.8.8', '10.1.10.50', '10.1.20.11', '10.1.30.15', '10.1.50.9', '10.9.9.9', '172.16.10.5', '192.168.50.9', '10.96.1.1', '10.95.0.1', '10.200.1.1'];
  let n = 0;
  Q.devices().filter((d) => d.collected).forEach((d) => Q.vrfs().forEach((v) => dsts.forEach((ip) => {
    assert.strictEqual(shape(S.trace.lookup(RV, d.key, ip, v)), shape(S.trace.lookup(QV, d.key, ip, v)), `${d.key} ${v} ${ip}`); n++;
    assert.deepStrictEqual(RV.hopOwner(d.key, ip, v), Q.hopOwner(d.key, ip, v));
  })));
  assert.ok(n > 100);
  Q.devices().forEach((d) => assert.deepStrictEqual(JSON.parse(JSON.stringify(RV.policyOf(d.key))), JSON.parse(JSON.stringify(Q.policyOf(d.key))), d.key));
  // 入口：檢查用的 M.wanEntries 與 Q.wanEntries 相同
  M.wanEntries.forEach((list, d) => assert.deepStrictEqual(list, Q.wanEntries(d), d));
});

// ---------------------------------------------------------------- 檢查與 L4 的結論一致（決策 7 的一致性測試）
const portOf = (f) => +/tcp\/(\d+)/.exec(f.message)[1];
/** F07 報的服務在暴露清單的 self 段一定是允許；F04 的規則在 dnat 段一定有允許的列，dnat 段允許的規則都有 F04；F03（input）用 Q.reach 不會被防火牆拒絕。 */
function consistent(s) {
  const Q = S.query(s); const x = Q.exposure();
  assert.strictEqual(x.status, 'ok');
  of(s, 'F07').forEach((f) => {
    const d = f.entities[0].key;
    assert.ok(x.self.rows.some((r) => r.dev === d && r.service === `tcp/${portOf(f)}` && r.verdict === 'allow'), `F07 ${f.message} 不在暴露清單 self 段`);
  });
  const f04 = new Set(of(s, 'F04').map((f) => f.entities.find((e) => e.type === 'rule').key));
  const r09 = new Set(of(s, 'R09').map((f) => f.entities[1].key));
  // dst-nat 之後經對外介面送回外部的（R09）在暴露清單算路由沒到，不是允許
  const dnatAllowed = new Set(x.dnat.rows.filter((r) => r.verdict === 'allow' && r.rule).map((r) => r.rule.key));
  r09.forEach((k) => assert.ok(!x.dnat.rows.some((r) => r.nat && r.nat.rule && r.nat.rule.key === k), `R09 的 dst-nat 規則不在暴露清單 dnat 段：${k}`));
  assert.deepStrictEqual(Array.from(f04).sort(), Array.from(dnatAllowed).sort(), 'F04 與暴露清單 dnat 段允許的規則相同');
  r09.forEach((k) => assert.ok(!dnatAllowed.has(k), `R09 的規則不會是暴露清單的允許：${k}`));
  of(s, 'F03').forEach((f) => {
    const rule = s.model.firewallRules.find((r) => r.key === f.entities.find((e) => e.type === 'rule').key);
    if (rule.chain !== 'input' || !rule.match['dst-port']) return;
    const ifc = (/WAN（([^）]+)）/.exec(f.message) || /對外介面 (\S+?)（/.exec(f.message))[1];
    const entry = `${rule.dev}|${ifc}`;
    const ip = Q.ipsOf(entry).map((a) => a.ip).find(Boolean) || Q.subnets().find((n) => n.dev === rule.dev).ip;
    const r = Q.reach('192.0.2.10', ip, { proto: S.infer.fw.protoName(rule.match.protocol || 'tcp'), port: +String(rule.match['dst-port']).split(/[,-]/)[0], entry });
    assert.ok(!r.decisive.some((d) => d.key && d.table === 'filter' && d.verdict === 'drop'), `F03 ${f.message}：L4 由防火牆拒絕 ${JSON.stringify(r.decisive)}`);
    if (r.verdict === 'allow') assert.ok(r.decisive.some((d) => d.key === rule.key), `F03 ${f.message}：L4 允許但不是這條規則`);
  });
}

test('一致性（範例資料）：F07 ⊆ 暴露清單 self 段；F04 ＝ dnat 段允許的規則；R09 不是允許；F03 不被 L4 的防火牆拒絕', () => {
  consistent(sampleSnap());
});

test('一致性（手寫，沒有 WAN 清單、以邊界證據判定入口）：同上', () => {
  const s = T(dev('R', '192.168.1.1', [addr('192.168.1.1/24', 'bridge1'), addr('81.2.3.2/30', 'ether1'),
    '/ip firewall nat add action=masquerade chain=srcnat out-interface=ether1',
    '/ip firewall nat add action=dst-nat chain=dstnat dst-port=8080 in-interface=ether1 protocol=tcp to-addresses=192.168.1.10 to-ports=80',
    '/ip firewall nat add action=dst-nat chain=dstnat dst-port=3389 in-interface=ether1 protocol=tcp to-addresses=10.9.9.9',
    '/ip firewall filter add action=accept chain=input connection-state=established,related', '/ip firewall filter add action=accept chain=input dst-port=22 protocol=tcp',
    '/ip firewall filter add action=drop chain=input in-interface=ether1'],
  [C('192.168.1.0/24', 'bridge1'), C('81.2.3.0/30', 'ether1'), R('0.0.0.0/0', '81.2.3.1', 'ether1')]));
  assert.deepStrictEqual(['F03', 'F04', 'F07', 'R09', 'F08'].map((id) => of(s, id).length), [1, 1, 1, 1, 0]);
  consistent(s);
});
