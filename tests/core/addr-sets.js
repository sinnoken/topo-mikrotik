// 位址集合的登錄表 S.infer.addrSets：id 穩定、判斷只有一個入口（decide 的位址條件、available-from、L4 等價類邊界都經登錄表的 S.ip.set）。
// 測試資料依 RouterOS 手冊撰寫（https://manual.mikrotik.com/docs/cli-reference/ip/firewall/address-list.md），不是實機擷取。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { S, ROOT, build, test, sampleSnap } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
const R = (extra) => build(['R (192.168.1.1):', '### /export terse',
  '/interface bridge add name=bridge1',
  '/interface list add name=WAN', '/interface list add name=LAN',
  '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=bridge1 list=LAN',
  '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0',
  '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
  ...extra,
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge1 distance=0',
  ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1', ''].join('\n'));
const reg = (s) => S.infer.addrSets({ rules: s.model.firewallRules, addressLists: s.model.addressLists, services: s.model.ipServices, routingRules: s.model.routingRules });
const ruleOf = (s, pred) => s.model.firewallRules.find(pred);

test('位址集合登錄表：每種來源的 id 規則（清單「設備|位址族|名稱」、規則字面值「規則鍵|條件」、available-from、/routing rule），插入規則不改變其他筆的 id', () => {
  const lines = [
    '/ip firewall address-list add address=10.9.0.0/16 list=BAD', '/ip firewall address-list add address=10.8.0.1-10.8.0.9 list=BAD',
    '/ip firewall filter add action=drop chain=forward src-address-list=BAD',
    '/ip firewall filter add action=accept chain=forward src-address=192.168.1.0/25,192.168.1.128/25 dst-address=!10.0.0.0/8',
    '/ip firewall nat add action=dst-nat chain=dstnat dst-port=8080 in-interface-list=WAN protocol=tcp to-addresses=192.168.1.20',
    '/ip service set ssh address=192.168.1.0/24,2001:db8::/32',
    '/routing rule add action=lookup src-address=192.168.1.64/26 table=main',
  ];
  const s = R(lines); const x = reg(s);
  const bad = x.list('R', 'ip', 'BAD');
  assert.deepStrictEqual([bad.id, bad.kind, bad.static, bad.set.ranges.length], ['R|ip|BAD', 'address-list', true, 2]);
  assert.ok(Object.isFrozen(bad) && bad.src.length === 2 && bad.src.every((y) => y.length === 2), '來源行是清單的每個啟用中項目');
  const acc = ruleOf(s, (r) => r.action === 'accept');
  const src = x.ofRule(acc, 'src-address'); const dst = x.ofRule(acc, 'dst-address');
  assert.deepStrictEqual([src.id, src.kind, src.set.ranges.length, src.set.has('192.168.1.200')], [acc.key + '|src-address', 'rule-address', 1, true], '兩個相鄰的 /25 合併成一段');
  assert.deepStrictEqual([dst.id, dst.set.has('10.1.2.3')], [acc.key + '|dst-address', true], '集合是 ! 之後的內容（否定由 decide 處理）');
  assert.deepStrictEqual(x.ofRule(acc, 'src-address-list'), null, '規則沒有這個條件');
  assert.strictEqual(x.ofRule(ruleOf(s, (r) => r.action === 'drop'), 'src-address-list'), bad, '規則引用的清單就是登錄的那一筆');
  const nat = ruleOf(s, (r) => r.action === 'dst-nat');
  assert.strictEqual(x.ofRule(nat, 'to-addresses').id, nat.key + '|to-addresses');
  assert.deepStrictEqual([x.service('R', 'ssh', 'ip').id, x.service('R', 'ssh', 'ipv6').set.has('2001:db8::1')], ['R|ip|service|ssh', true]);
  const rr = x.ofRoutingRule(s.model.routingRules[0], 'src-address');
  assert.deepStrictEqual([rr.id, rr.kind, rr.set.has('192.168.1.70')], ['R|routing-rule|1|src-address', 'routing-rule', true]);
  ['R|ip|BAD', acc.key + '|src-address', nat.key + '|to-addresses', 'R|ip|service|ssh', 'R|routing-rule|1|src-address'].forEach((id) => assert.strictEqual(x.get(id).id, id, id));
  assert.strictEqual(x.get('R|ip|NOPE'), null);
  // 在最前面插入一條規則：其他規則的鍵不含編號，id 不變
  const s2 = R(['/ip firewall filter add action=accept chain=forward connection-state=established'].concat(lines)); const x2 = reg(s2);
  const acc2 = ruleOf(s2, (r) => r.action === 'accept' && r.match['src-address']);
  assert.deepStrictEqual([x2.ofRule(acc2, 'src-address').id, x2.list('R', 'ip', 'BAD').id], [src.id, bad.id]);
});

test('位址集合登錄表：可能有動態來源的清單沒有集合（判斷不了）；字面值有一項不合法時沒有集合；查詢層的 Q.addressSet 與判斷用的是同一份', () => {
  const s = R([
    '/ip firewall address-list add address=203.0.113.5 list=DYN timeout=1d',
    '/ip firewall filter add action=drop chain=forward src-address-list=DYN',
    '/ip firewall filter add action=drop chain=forward src-address=10.0.0.0/8,bogus',
  ]);
  const x = reg(s);
  const dyn = x.list('R', 'ip', 'DYN');
  assert.deepStrictEqual([dyn.static, dyn.reasons, dyn.set], [false, ['timeout'], null]);
  const bogus = ruleOf(s, (r) => r.match['src-address']);
  assert.strictEqual(x.ofRule(bogus, 'src-address').set, null);
  const Q = S.query(s);
  assert.deepStrictEqual([Q.addressSet('R|ip|DYN').static, Q.addressSet('R|ip|DYN').ranges], [false, null]);
  assert.deepStrictEqual(Q.addressSet(bogus.key + '|src-address').ranges, null);
  assert.strictEqual(Q.addressSet('nope'), null);
  // 範例資料：TPE_CORE_RT_01 的 QUARANTINE（10.1.30.66、10.1.30.70–79，停用的一筆不算），Q.addressSet 與 Q.reach 的結果一致
  const ss = sampleSnap(); const QS = S.query(ss);
  const q = QS.addressSet('TPE_CORE_RT_01|ip|QUARANTINE');
  assert.deepStrictEqual(q.ranges, [['10.1.30.66', '10.1.30.66'], ['10.1.30.70', '10.1.30.79']]);
});

test('位址集合登錄表：起點大於終點、位址族混用的範圍（IPv4 與 IPv6）判斷不了，規則與 /routing rule 的字面值沒有集合，不當成空集合', () => {
  const s = R([
    '/ip firewall filter add action=drop chain=forward src-address=192.168.1.9-192.168.1.1',
    '/ip firewall filter add action=drop chain=forward dst-address=::1-10.0.0.1',
    '/ipv6 firewall filter add action=drop chain=forward src-address=2001:db8::9-2001:db8::1',
    '/routing rule add action=lookup src-address=192.168.1.9-192.168.1.1 table=main',
  ]);
  const x = reg(s);
  s.model.firewallRules.forEach((r) => { const k = r.match['src-address'] ? 'src-address' : 'dst-address'; assert.strictEqual(x.ofRule(r, k).set, null, r.key); });
  assert.strictEqual(x.ofRoutingRule(s.model.routingRules[0], 'src-address').set, null);
  // 判斷不了的條件：L4 回不明，不是「不符合、往下一條」
  assert.strictEqual(S.query(s).reach('192.168.1.5', '8.8.8.8', { proto: 'tcp', port: 443 }).verdict, 'unknown');
});

test('位址集合登錄表：available-from 與 SNMP community 的 addresses 空白是不限來源（涵蓋該位址族的全部位址），不是空集合', () => {
  // 手冊：available-from 空白是任何位址（https://manual.mikrotik.com/docs/cli-reference/ip/service.md）
  const s = R(['/ip service set ssh address=""', '/ip service set winbox address=192.168.1.0/24',
    '/snmp set enabled=yes', '/snmp community set [ find default=yes ] addresses="" name=nms']);
  const Q = S.query(s);
  ['ip', 'ipv6'].forEach((f) => {
    const all = f === 'ip' ? [['0.0.0.0', '255.255.255.255']] : [['::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff']];
    assert.deepStrictEqual(Q.addressSet(`R|${f}|service|ssh`).ranges, all, 'ssh ' + f);
    assert.deepStrictEqual(Q.addressSet(`R|${f}|service|telnet`).ranges, all, '沒有設定的服務是出廠值（空白）' + f);
    assert.deepStrictEqual(Q.addressSet(`R|${f}|snmp-community|nms`).ranges, all, 'snmp ' + f);
  });
  // 有寫來源時只取這個位址族的項目：只寫 IPv4 的 winbox 不接受 IPv6 來源
  assert.deepStrictEqual([Q.addressSet('R|ip|service|winbox').ranges, Q.addressSet('R|ipv6|service|winbox').ranges], [[['192.168.1.0', '192.168.1.255']], []]);
});

test('判斷只有一個入口：位址的「在不在裡面」只經 S.ip.set（登錄表），舊的各自實作已不存在', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const files = walk(path.join(ROOT, 'src')).map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')]);
  // 規則位址條件的 inRanges、清單專用的 mergeRanges／inSorted、available-from 的 afNets／inAvailableFrom、各自的位址解析 ip6Big／addrRange、ctx.addressList
  const OLD = /\b(inRanges|mergeRanges|inSorted|afNets|inAvailableFrom|ip6Big|addrRange)\b|\.addressList\(/;
  const hits = files.filter(([, t]) => OLD.test(t)).map(([f, t]) => f + '：' + t.match(OLD)[0]);
  assert.deepStrictEqual(hits, []);
  // 建立集合只在 S.ip（定義）與登錄表（S.infer.addrSets、私有位址）；L4 的等價類邊界只經 S.infer.addrBounds
  const makers = files.filter(([, t]) => /\bS\.ip\.set\(|\bIP\.set\(/.test(t)).map(([f]) => f).sort();
  assert.deepStrictEqual(makers, ['src/model/infer.js']);
  const reach = files.filter(([f]) => /^src\/query\/reach/.test(f));
  assert.ok(reach.filter(([, t]) => /S\.infer\.addrBounds\(/.test(t)).length >= 2, 'reach.js 與 reach-exposure.js 都用 S.infer.addrBounds');
  assert.deepStrictEqual(reach.filter(([, t]) => /parseVal\('(src|dst)-address', F\.splitNeg/.test(t)).map(([f]) => f), [], '等價類邊界不再各自解析規則的位址');
});

test('L4 的等價類邊界由登錄表產生：位址清單、規則字面值、available-from 的邊界都會切開代表位址，結果與逐一判斷 set.has 一致', () => {
  const s = R([
    '/ip firewall address-list add address=192.168.1.32/27 list=BLOCK',
    '/ip firewall filter add action=drop chain=forward src-address-list=BLOCK',
    '/ip firewall filter add action=drop chain=forward src-address=192.168.1.16/28 protocol=tcp dst-port=443',
    '/ip service set ssh address=192.168.1.0/26',
  ]);
  // 邊界是集合的邊界，與寫法無關：同一條規則寫成兩個相鄰的 /8 或一個 /7，外部來源的區段相同
  const ext = (addr) => S.query(R([`/ip firewall filter add action=drop chain=input src-address=${addr}`])).exposure().external.byDevice[0].sources.map((y) => y.range);
  assert.deepStrictEqual(ext('8.0.0.0/8,9.0.0.0/8'), ext('8.0.0.0/7'));
  assert.ok(ext('8.0.0.0/7').some((r) => r[0] === '8.0.0.0' && r[1] === '9.255.255.255'));
  const Q = S.query(s); const x = reg(s);
  const block = x.list('R', 'ip', 'BLOCK').set; const lit = x.ofRule(ruleOf(s, (r) => r.match['src-address']), 'src-address').set;
  ['192.168.1.10', '192.168.1.20', '192.168.1.40', '192.168.1.70'].forEach((ip) => {
    const want = block.has(ip) || lit.has(ip) ? 'deny' : 'allow';
    assert.strictEqual(Q.reach(ip, '8.8.8.8', { proto: 'tcp', port: 443 }).verdict, want, ip);
  });
});
