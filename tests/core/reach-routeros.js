// L4 可達性：依 RouterOS 手冊修正的情境（raw notrack、/ip service、外部與網路設備本身的 zone、hairpin NAT、閘道推定、格子狀態）
'use strict';
const assert = require('assert');
const { S, build, test, sampleSnap } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/** 單台路由器 R1：LAN 192.168.1.0/24（bridge1）、DMZ 192.168.9.0/24（ether3）、WAN 198.51.100.0/30（ether1），預設路由往 ISP。 */
const one = (rules, extra) => S.query(build([
  'R1 (192.168.1.1):',
  '### /export terse',
  '/interface bridge add name=bridge1',
  '/interface list add name=WAN', '/interface list add name=LAN',
  '/interface list member add interface=bridge1 list=LAN', '/interface list member add interface=ether1 list=WAN',
  '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0',
  '/ip address add address=192.168.9.1/24 interface=ether3 network=192.168.9.0',
  '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
  ...(extra || []),
  ...rules,
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge1 distance=0',
  ' DAc dst-address=192.168.9.0/24 routing-table=main gateway=ether3 distance=0',
  ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1',
].join('\n')));
/** RouterOS 7 的出廠預設防火牆（defconf）的主要規則。 */
const DEF = [
  '/ip firewall filter add action=accept chain=input connection-state=established,related,untracked',
  '/ip firewall filter add action=drop chain=input connection-state=invalid',
  '/ip firewall filter add action=accept chain=input protocol=icmp',
  '/ip firewall filter add action=drop chain=input in-interface-list=!LAN',
  '/ip firewall filter add action=fasttrack-connection chain=forward connection-state=established,related',
  '/ip firewall filter add action=accept chain=forward connection-state=established,related,untracked',
  '/ip firewall filter add action=drop chain=forward connection-state=invalid',
  '/ip firewall filter add action=drop chain=forward connection-nat-state=!dstnat connection-state=new in-interface-list=WAN',
  '/ip firewall nat add action=masquerade chain=srcnat out-interface-list=WAN',
];
const ends = (r) => S.util.uniq(r.paths.map((p) => p.end && p.end.code));
const codes = (r) => r.reasons.map((x) => x.code);

test('L4 raw notrack：之後以 connection-state=untracked 比對（defconf 的 accept untracked 放行），也不套用 NAT', () => {
  const Q = one(DEF.concat([
    '/ip firewall raw add action=notrack chain=prerouting src-address=192.168.1.0/24 dst-address=192.168.9.0/24',
    '/ip firewall filter add action=drop chain=forward src-address=192.168.1.0/24 dst-address=192.168.9.0/24',
  ]));
  const r = Q.reach('192.168.1.50', '192.168.9.10', { proto: 'tcp', port: 22 });
  assert.strictEqual(r.verdict, 'allow', JSON.stringify(r.reasons));
  const h = r.paths[0].hops[0];
  assert.strictEqual(h.conntrack, 'untracked');
  const fwd = h.stages.find((x) => x.table === 'filter');
  assert.deepStrictEqual([fwd.verdict, fwd.rule.position], ['accept', 2], 'forward chain 內第 2 條 accept connection-state=…,untracked');
  // 不追蹤的連線不做 NAT：往 WAN 的 masquerade 不套用
  const Q2 = one(DEF.concat(['/ip firewall raw add action=notrack chain=prerouting src-address=192.168.1.0/24']));
  const out = Q2.reach('192.168.1.50', '8.8.8.8', { proto: 'tcp', port: 443 });
  const h2 = out.paths[0].hops[0];
  assert.deepStrictEqual([h2.conntrack, h2.nat, h2.srcOut, h2.stages.some((x) => x.table === 'nat')], ['untracked', [], '192.168.1.50', false]);
  // 沒有 notrack 時，同樣的規則是確定的拒絕
  const Q3 = one(DEF.concat(['/ip firewall filter add action=drop chain=forward src-address=192.168.1.0/24 dst-address=192.168.9.0/24']));
  assert.strictEqual(Q3.reach('192.168.1.50', '192.168.9.10', { proto: 'tcp', port: 22 }).verdict, 'deny');
});

test('L4 raw notrack 不確定（條件無法判斷）：追蹤與不追蹤各算一次，結果不同就是 unknown（raw-notrack），不讓拒絕蓋過', () => {
  const Q = one(DEF.concat([
    '/ip firewall raw add action=notrack chain=prerouting src-address-list=FAST',
    '/ip firewall filter add action=drop chain=forward src-address=192.168.1.0/24 dst-address=192.168.9.0/24',
  ]));
  const r = Q.reach('192.168.1.50', '192.168.9.10', { proto: 'tcp', port: 22 });
  assert.deepStrictEqual([r.verdict, codes(r).includes('raw-notrack')], ['unknown', true], JSON.stringify(r.reasons));
  // 兩種狀態結果相同（都放行）：確定的允許
  const Q2 = one(DEF.concat(['/ip firewall raw add action=notrack chain=prerouting src-address-list=FAST']));
  assert.strictEqual(Q2.reach('192.168.1.50', '192.168.9.10', { proto: 'tcp', port: 22 }).verdict, 'allow');
});

test('L4 送到設備本身：防火牆放行後依 /ip service 判斷（停用、available-from），沒有對應服務時註明', () => {
  const ALL = ['/ip firewall filter add action=accept chain=input'];
  const Q = one(ALL, ['/ip service set telnet disabled=yes', '/ip service set winbox address=192.168.1.0/24']);
  const tel = Q.reach('192.168.1.50', '192.168.1.1', { proto: 'tcp', port: 23 });
  assert.deepStrictEqual([tel.verdict, ends(tel)], ['deny', ['service-refused']]);
  assert.ok(tel.decisive.some((d) => d.route === 'service-refused'), JSON.stringify(tel.decisive));
  const wb = Q.reach('198.51.100.1', '198.51.100.2', { proto: 'tcp', port: 8291 });
  assert.deepStrictEqual([wb.verdict, ends(wb)], ['deny', ['service-refused']], '來源不在 available-from');
  assert.ok(/available-from/.test(wb.paths[0].end.message));
  assert.strictEqual(Q.reach('192.168.1.50', '192.168.1.1', { proto: 'tcp', port: 8291 }).verdict, 'allow', '來源在 available-from 內');
  const none = Q.reach('192.168.1.50', '192.168.1.1', { proto: 'tcp', port: 3389 });
  assert.deepStrictEqual([none.verdict, /沒有已知的管理服務/.test(none.paths[0].end.message)], ['allow', true]);
  // 預設：www-ssl 出廠停用（SERVICE_DEFAULTS）
  assert.strictEqual(Q.reach('192.168.1.50', '192.168.1.1', { proto: 'tcp', port: 443 }).verdict, 'deny');
});

test('L4 zone 矩陣：外部（Internet）與網路設備（管理）兩個虛擬 zone（推論），WAN → 設備管理服務的暴露看得到', () => {
  const Q = one(DEF.slice(0, 3).concat(['/ip firewall filter add action=accept chain=input in-interface-list=WAN dst-port=8291 protocol=tcp'], DEF.slice(3)));
  const mx = Q.zoneMatrix();
  const ext = mx.zones.find((z) => z.id === 'external'); const self = mx.zones.find((z) => z.id === 'self');
  assert.ok(ext && self && ext.inferred && self.dstOnly && !ext.dstOnly);
  assert.ok(['192.0.2.10', '203.0.113.10'].includes(ext.representative), '代表位址是文件保留位址（198.51.100.0/24 有一段在基準內時跳過）');
  const cell = (a, b) => mx.cells.find((c) => c.src === a && c.dst === b);
  assert.ok(!mx.cells.some((c) => c.src === 'self'), '網路設備（管理）只當目的');
  // LAN → 外部：masquerade 經 WAN 送出，允許
  assert.strictEqual(cell('list:LAN', 'external').status, 'allow');
  // 外部 → LAN：defconf 擋下不是 dst-nat 的新連線
  assert.strictEqual(cell('external', 'list:LAN').status, 'deny');
  // 外部 → 設備本身：defconf 放行 icmp，加上 WAN 的 winbox（tcp/8291）
  const ws = cell('external', 'self');
  assert.strictEqual(ws.status, 'partial');
  assert.deepStrictEqual(ws.services.filter((s) => s.counts.allow).map((s) => s.service), ['icmp', 'tcp/8291']);
  const d = Q.zoneCell('external', 'self');
  assert.ok(d.groups.every((g) => g.srcDevices.length), '外部來源以入口介面當來源設備');
});

test('L4 hairpin NAT：同網段經 dst-nat 連伺服器、沒有 hairpin srcnat 時為 unknown（hairpin-no-srcnat）；有 srcnat 時允許', () => {
  const NAT = '/ip firewall nat add action=dst-nat chain=dstnat dst-address=198.51.100.2 dst-port=443 protocol=tcp to-addresses=192.168.1.20';
  const Q = one(DEF.concat([NAT]));
  const r = Q.reach('192.168.1.50', '198.51.100.2', { proto: 'tcp', port: 443 });
  assert.deepStrictEqual([r.verdict, ends(r)], ['unknown', ['hairpin-no-srcnat']]);
  const Q2 = one(DEF.concat([NAT, '/ip firewall nat add action=masquerade chain=srcnat src-address=192.168.1.0/24 dst-address=192.168.1.20']));
  assert.strictEqual(Q2.reach('192.168.1.50', '198.51.100.2', { proto: 'tcp', port: 443 }).verdict, 'allow');
  // 不同網段的用戶端不是 hairpin
  assert.strictEqual(Q.reach('192.168.9.50', '198.51.100.2', { proto: 'tcp', port: 443 }).verdict, 'allow');
});

test('L4 閘道推定（範例資料）：預設路由指向網段內位址的設備是用戶端；有預設路由的優先', () => {
  const Q = S.query(sampleSnap());
  const r = Q.reach('10.1.20.50', '8.8.8.8', { proto: 'tcp', port: 443, vrf: 'main' });
  assert.strictEqual(r.start.basis, 'default-route');
  assert.ok(r.start.gateways.every((g) => g.dev !== 'TPE_BR_RT_01'), '沒有預設路由的分支路由器不當這個網段的閘道');
  assert.deepStrictEqual([r.verdict, ends(r)], ['allow', ['egress-wan']]);
});

test('L4 格子狀態：有確定的允許時不顯示成「無法判斷」，另以 incomplete 標示部分無法判斷', () => {
  const mx = S.query(sampleSnap()).zoneMatrix();
  const bad = mx.cells.filter((c) => c.counts.allow > 0 && c.status === 'unknown');
  assert.deepStrictEqual(bad.map((c) => c.src + '→' + c.dst), []);
  mx.cells.forEach((c) => assert.strictEqual(c.incomplete, c.counts.allow > 0 && c.counts.unknown > 0, c.src + '→' + c.dst));
  assert.ok(mx.cells.some((c) => c.incomplete), '範例資料有部分無法判斷的格子');
});

test('L4 對角線：zone 內同網段的組合以同一區段的第二個位址計算（same-subnet），不留白', () => {
  const Q = one(DEF);
  const c = Q.zoneMatrix().cells.find((x) => x.src === 'list:LAN' && x.dst === 'list:LAN');
  assert.strictEqual(c.status, 'allow');
  assert.ok(Q.zoneCell('list:LAN', 'list:LAN').groups.length > 0);
});

test('L4 tcp-flags=syn 與 icmp-options=8:0：新連線的第一個封包可以判斷（只在 Q.reach，不影響 F 檢查）', () => {
  const Q = one(['/ip firewall filter add action=accept chain=forward protocol=tcp tcp-flags=syn', '/ip firewall filter add action=accept chain=forward protocol=icmp icmp-options=8:0',
    '/ip firewall filter add action=drop chain=forward']);
  assert.strictEqual(Q.reach('192.168.1.50', '192.168.9.10', { proto: 'tcp', port: 22 }).verdict, 'allow');
  assert.strictEqual(Q.reach('192.168.1.50', '192.168.9.10', { proto: 'icmp' }).verdict, 'allow');
  const Q2 = one(['/ip firewall filter add action=accept chain=forward protocol=tcp tcp-flags=syn,ack', '/ip firewall filter add action=drop chain=forward']);
  assert.strictEqual(Q2.reach('192.168.1.50', '192.168.9.10', { proto: 'tcp', port: 22 }).verdict, 'unknown', 'syn,ack 是「且」還是「或」手冊沒寫明：不猜');
  const Q3 = one(['/ip firewall filter add action=drop chain=forward protocol=icmp icmp-options=!8:0']);
  assert.strictEqual(Q3.reach('192.168.1.50', '192.168.9.10', { proto: 'icmp' }).verdict, 'allow');
});

test('L4 決定結果不含 srcnat；矩陣附上 IPv6 在用的設備', () => {
  const Q = one(DEF);
  const r = Q.reach('192.168.1.50', '8.8.8.8', { proto: 'tcp', port: 443 });
  assert.ok(r.decisive.every((d) => d.chain !== 'srcnat'), JSON.stringify(r.decisive));
  assert.ok(r.paths[0].hops[0].nat.some((n) => n.dir === 'src'), 'masquerade 仍列在逐跳的 NAT');
  assert.deepStrictEqual(one(DEF).zoneMatrix().ipv6, []);
  const v6 = one(DEF, ['/ipv6 address add address=2001:db8::1/64 interface=bridge1']);
  assert.deepStrictEqual(v6.zoneMatrix().ipv6.map((x) => x.dev), ['R1']);
});
