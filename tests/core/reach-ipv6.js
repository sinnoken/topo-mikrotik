// 暴露清單的 IPv6（第一階段，只看邊界路由器）：從 WAN 進來，以 /ipv6 firewall filter 的 input／forward 判斷能到設備本身與直連的 LAN 網段
// 依據：https://manual.mikrotik.com/docs/firewall-and-quality-of-service/firewall/filter.md（內建 chain 沒有規則決定時放行）、
//       https://manual.mikrotik.com/docs/cli-reference/ip/service.md（available-from 接受 IPv4 與 IPv6 前綴，空的是不限）
// 測試資料依手冊的語法手寫，不是實機擷取。
// 基準目前沒有 IPv6 位址的事實（/ipv6 address 只記成「IPv6 在用」的證據），所以這裡把 IPv6 位址直接加進 Snapshot 的 ipAddresses（family 6），
// 形狀同 IPv4 的 ipAddresses；解析 /ipv6 address 由 data-model 另案處理。
'use strict';
const assert = require('assert');
const { S, build, test, sampleSnap } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
const F6 = (a) => '/ipv6 firewall filter add ' + a;
/** 邊界路由器 R：ether1 是 WAN、ether2 是 LAN。IPv6：WAN 3fff:0:1::2/64、LAN 3fff:0:2::1/64、LAN 的 link-local（3fff::/20 是文件保留位址）。 */
const router = (lines, opts) => {
  const s = build([
    'R (192.168.1.1):',
    '### /export terse',
    '/interface list add name=WAN', '/interface list add name=LAN',
    '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=ether2 list=LAN',
    '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
    '/ip address add address=192.168.1.1/24 interface=ether2 network=192.168.1.0',
    '/ip firewall filter add action=drop chain=input in-interface-list=WAN',
    '/ip firewall filter add action=drop chain=forward in-interface-list=WAN',
  ].concat(lines, [
    '### /ip route print detail without-paging', RT,
    ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
    ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=ether2 distance=0',
    ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1',
    '',
  ]).join('\n'));
  if (!(opts && opts.noAddress)) {
    [['ether1', '3fff:0:1::2/64'], ['ether2', '3fff:0:2::1/64'], ['ether2', 'fe80::1/64']].forEach(([ifc, address]) => {
      const [ip, len] = address.split('/');
      s.model.ipAddresses.push({ address, ip, len: +len, family: 6, vrf: 'main', role: null, dev: 'R', ep: 'R|' + ifc, hearsay: false, src: [[0, 0]] });
    });
  }
  return s;
};
const v6rows = (sec) => sec.rows.filter((r) => r.family === 'ipv6');
const find = (sec, ip, service) => v6rows(sec).find((r) => r.ip === ip && r.service === service);
const EST = F6('action=accept chain=forward connection-state=established,related');
const EST_IN = F6('action=accept chain=input connection-state=established,related');

test('IPv6 暴露清單：forward 只限埠、沒限目的位址（F05）時，routed 列出整個 LAN 網段（dstAny），其餘從 WAN 丟棄的只計數', () => {
  const s = router([EST, F6('action=accept chain=forward dst-port=443 protocol=tcp'), F6('action=drop chain=forward in-interface-list=WAN'),
    EST_IN, F6('action=drop chain=input in-interface-list=WAN')]);
  const Q = S.query(s); const x = Q.exposure();
  assert.strictEqual(x.ipv6.status, 'edge-only');
  assert.deepStrictEqual([x.ipv6.evaluated, x.ipv6.missing], [['R'], []]);
  assert.ok(/不做 IPv6 路由與 NAT66/.test(x.ipv6.message), x.ipv6.message);
  const web = find(x.routed, '3fff:0:2::2', 'tcp/443');
  assert.ok(web, JSON.stringify(v6rows(x.routed).map((r) => [r.ip, r.service])));
  const acc = s.model.firewallRules.find((r) => r.family === 'ipv6' && r.match['dst-port'] === '443');
  assert.deepStrictEqual([web.family, web.dev, web.verdict, web.dstAny, web.subnet, web.target, web.dstRange, web.zone, web.allowedFrom.kind, web.entry, web.inInterface, web.reasons],
    ['ipv6', 'R', 'allow', true, '3fff:0:2::/64', '3fff:0:2::/64', ['3fff:0:2::', '3fff:0:2:0:ffff:ffff:ffff:ffff'], null, 'any', 'R|ether1', 'ether1', []]);
  assert.strictEqual(web.rule.key, acc.key);
  assert.ok(/^2001:db8:/.test(web.src), '外部來源是 2001:db8::/32 的代表位址：' + web.src);
  const f05 = Q.findingsByRule('F05').map((f) => Q.findingKey(f));
  assert.ok(f05.length && f05.every((k) => web.findingKeys.includes(k)), '相關檢查有 F05');
  assert.deepStrictEqual(v6rows(x.routed).map((r) => r.service), ['tcp/443'], '其他服務被丟棄，不列');
  assert.deepStrictEqual(v6rows(x.self), [], 'input 從 WAN 丟棄');
  assert.ok(x.routed.counts.deny > 0 && x.routed.counts.candidates === x.routed.counts.allow + x.routed.counts.unknown + x.routed.counts.deny + x.routed.counts.natted);
  assert.ok(!v6rows(x.routed).some((r) => r.ip.startsWith('fe80')), 'link-local 不是目的');
  assert.ok(Object.isFrozen(web) && JSON.parse(JSON.stringify(x)), '凍結、可序列化（沒有 BigInt）');
  // IPv4 的列不變：同一台設備 IPv4 在前
  assert.ok(x.routed.rows.every((r) => r.family === 'ipv4' || r.family === 'ipv6'));
});

test('IPv6 暴露清單：forward 限定目的位址時只列那個位址（dstAny 為 false，dstRange 是那個位址），網段其他位址不列', () => {
  const s = router([EST, F6('action=accept chain=forward dst-address=3fff:0:2::10/128 dst-port=443 in-interface-list=WAN protocol=tcp'),
    F6('action=drop chain=forward in-interface-list=WAN'), EST_IN, F6('action=drop chain=input in-interface-list=WAN')]);
  const x = S.query(s).exposure();
  assert.deepStrictEqual(v6rows(x.routed).map((r) => [r.ip, r.service, r.verdict, r.dstAny, r.dstRange]), [['3fff:0:2::10', 'tcp/443', 'allow', false, ['3fff:0:2::10', '3fff:0:2::10']]]);
  assert.ok(x.services.find((v) => v.id === 'tcp/443').origins.includes('filter'), 'IPv6 放行規則的埠也是候選服務');
});

test('IPv6 暴露清單：input 放行到設備本身（self），/ip service 的 available-from 只有 IPv4 前綴時 IPv6 來源被拒絕', () => {
  const rules = [EST, F6('action=drop chain=forward in-interface-list=WAN'), EST_IN, F6('action=accept chain=input dst-port=22,8291 protocol=tcp'),
    F6('action=accept chain=input protocol=icmpv6'), F6('action=drop chain=input in-interface-list=WAN')];
  const x = S.query(router(rules.concat(['/ip service set winbox available-from=192.168.1.0/24']))).exposure();
  const ssh = find(x.self, '3fff:0:1::2', 'tcp/22');
  assert.ok(ssh, JSON.stringify(v6rows(x.self).map((r) => [r.ip, r.service])));
  assert.deepStrictEqual([ssh.verdict, ssh.target, ssh.zone, ssh.serviceName, ssh.allowedFrom.kind, ssh.dstAny], ['allow', 'R', 'self', 'ssh', 'any', false]);
  assert.ok(find(x.self, '3fff:0:2::1', 'tcp/22'), '設備在 LAN 的位址也列（從 WAN 進入）');
  assert.strictEqual(find(x.self, '3fff:0:1::2', 'tcp/8291'), undefined, 'winbox 只接受 IPv4 的 192.168.1.0/24');
  assert.strictEqual(find(x.self, '3fff:0:1::2', 'icmp').verdict, 'allow', 'ICMP 以 ICMPv6 比對');
  assert.strictEqual(find(x.self, '3fff:0:1::2', 'tcp/80'), undefined, '其他埠被丟棄');
  // available-from 有 IPv6 前綴：只允許那一段外部來源
  const y = S.query(router(rules.concat(['/ip service set winbox available-from=192.168.1.0/24,2001:db8::/48']))).exposure();
  const wb = find(y.self, '3fff:0:1::2', 'tcp/8291');
  assert.deepStrictEqual([wb.verdict, wb.allowedFrom.kind], ['allow', 'limited']);
  assert.ok(wb.allowedFrom.ranges.every(([a, b]) => a.startsWith('2001:db8:') && b.startsWith('2001:db8:')), JSON.stringify(wb.allowedFrom));
});

test('IPv6 暴露清單：available-from 經位址集合的登錄表（與 IPv4、F07 同一份）——兩個相鄰的 /49 等於一個 /48；不合法的項目不接受任何來源', () => {
  const rules = [EST, F6('action=drop chain=forward in-interface-list=WAN'), EST_IN, F6('action=accept chain=input dst-port=22,8291 protocol=tcp'), F6('action=drop chain=input in-interface-list=WAN')];
  const row = (af) => {
    const Q = S.query(router(rules.concat([`/ip service set winbox available-from=${af}`])));
    const r = find(Q.exposure().self, '3fff:0:1::2', 'tcp/8291');
    return { r, set: Q.addrSets().service('R', 'winbox', 'ipv6').set };
  };
  const whole = row('192.168.1.0/24,2001:db8::/48'); const split = row('192.168.1.0/24,2001:db8::/49,2001:db8:0:8000::/49');
  assert.deepStrictEqual([split.r.verdict, split.r.allowedFrom], [whole.r.verdict, whole.r.allowedFrom]);
  assert.deepStrictEqual(split.set.ranges, whole.set.ranges);
  const bad = row('192.168.1.0/24,not-an-address');
  assert.deepStrictEqual([bad.r, bad.set.isEmpty], [undefined, true], '沒有合法的 IPv6 項目：IPv6 來源一律拒絕（不是無法判斷）');
});

test('IPv6 暴露清單：沒有 IPv6 過濾規則的設備預設放行，本身與 LAN 的列都是 allow，reasons 標 no-ipv6-firewall', () => {
  const x = S.query(router(['/ipv6 address add address=3fff:0:2::1/64 interface=ether2'])).exposure();
  assert.strictEqual(x.ipv6.status, 'edge-only');
  const rows = v6rows(x.self).concat(v6rows(x.routed));
  assert.ok(rows.length > 0);
  rows.forEach((r) => assert.deepStrictEqual([r.verdict, r.reasons], ['allow', ['no-ipv6-firewall']], `${r.ip} ${r.service}`));
  const web = find(x.routed, '3fff:0:2::2', 'tcp/443');
  assert.deepStrictEqual([web.dstAny, web.rule.key, web.rule.policy, web.rule.chain], [true, null, true, 'forward']);
  assert.strictEqual(x.self.counts.deny + x.routed.counts.deny > 0, true, 'IPv4 的 WAN 丟棄照常計數');
  const c = S.query.reachReasonCodes().find((y) => y.code === 'no-ipv6-firewall');
  assert.ok(c && c.kind === 'reason');
  // 排序：同一台設備 IPv4 的列在前、IPv6 在後
  const fam = x.self.rows.map((r) => r.family); assert.deepStrictEqual(fam, fam.slice().sort());
});

test('IPv6 暴露清單：沒有 IPv6 位址的事實時回傳說明（範例資料的 TPE_CORE_RT_02 有 IPv6 規則但沒有位址）；IPv6 停用的設備另列', () => {
  const x = S.query(sampleSnap()).exposure();
  assert.strictEqual(x.ipv6.status, 'no-ipv6-address');
  assert.deepStrictEqual(x.ipv6.missing, [{ dev: 'TPE_CORE_RT_02', reason: 'no-address' }]);
  assert.deepStrictEqual(x.ipv6.devices.map((d) => d.dev), ['TPE_CORE_RT_02']);
  assert.ok(/IPv6 位址/.test(x.ipv6.message) && /TPE_CORE_RT_02/.test(x.ipv6.message), x.ipv6.message);
  ['self', 'dnat', 'routed'].forEach((k) => assert.deepStrictEqual(v6rows(x[k]), []));
  const off = S.query(router(['/ipv6 settings set disable-ipv6=yes'])).exposure();
  assert.deepStrictEqual([off.ipv6.status, off.ipv6.missing], ['no-ipv6-address', [{ dev: 'R', reason: 'disabled' }]]);
  const none = S.query(router([], { noAddress: true })).exposure();
  assert.deepStrictEqual([none.ipv6.status, none.ipv6.missing, none.ipv6.evaluated], ['no-ipv6-address', [], []]);
});

test('IPv6 暴露清單：判斷次數上限用完、沒有判斷到的組合另計（counts.notEvaluated），不算候選，也不算拒絕', () => {
  const lines = [EST, F6('action=drop chain=forward in-interface-list=WAN'), EST_IN, F6('action=drop chain=input in-interface-list=WAN')];
  const full = S.query(router(lines)).exposure();
  const v4 = S.query(router(lines, { noAddress: true })).exposure(); // 只有 IPv4 的判斷次數
  assert.ok(v6rows(full.self).length === 0 && full.self.counts.deny > v4.self.counts.deny, '完整計算時 IPv6 的組合都被丟棄');
  assert.deepStrictEqual([full.self.counts.notEvaluated, full.routed.counts.notEvaluated], [0, 0]);
  // 上限剛好用完 IPv4：IPv6 一個都沒有判斷
  const cut = S.query(router(lines)).exposure({ maxEvaluations: v4.limits.evaluations });
  assert.strictEqual(cut.limits.truncated, true);
  ['self', 'routed'].forEach((k) => {
    assert.deepStrictEqual([cut[k].counts.deny, cut[k].counts.candidates], [v4[k].counts.deny, v4[k].counts.candidates], `${k}：沒判斷的不算拒絕與候選`);
    assert.strictEqual(cut[k].counts.notEvaluated, full[k].counts.candidates - v4[k].counts.candidates, `${k}：另計沒判斷的組合`);
    assert.strictEqual(cut.denied[k], v4.denied[k]);
  });
});
