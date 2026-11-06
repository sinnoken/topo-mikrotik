// 位址分類 S.ip.classify：特殊用途位址表（IANA 特殊用途位址登錄、RFC 6890）與防火牆「私有位址」範圍
'use strict';
const assert = require('assert');
const { S, test } = require('../lib.js');

test('S.ip.classify：IPv4 的私有、CGNAT、loopback、link-local、群播、保留、文件用（TEST-NET 1/2/3）與公網', () => {
  const table = [
    ['10.0.0.1', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['172.32.0.1', 'public'], ['192.168.88.1', 'private'],
    ['100.64.0.1', 'cgnat'], ['100.127.255.254', 'cgnat'], ['100.128.0.1', 'public'],
    ['127.0.0.1', 'loopback'], ['169.254.1.1', 'link-local'],
    ['224.0.0.5', 'multicast'], ['239.255.255.250', 'multicast'],
    ['0.0.0.0', 'reserved'], ['0.1.2.3', 'reserved'], ['192.0.0.9', 'reserved'], ['198.18.0.1', 'reserved'], ['198.19.255.255', 'reserved'],
    ['240.0.0.1', 'reserved'], ['255.255.255.255', 'reserved'],
    ['192.0.2.1', 'documentation'], ['198.51.100.7', 'documentation'], ['203.0.113.254', 'documentation'],
    ['8.8.8.8', 'public'], ['1.1.1.1', 'public'], ['192.0.3.1', 'public'], ['203.0.114.1', 'public'], [' 8.8.4.4 ', 'public'],
  ];
  table.forEach(([a, want]) => assert.strictEqual(S.ip.classify(a), want, a));
});

test('S.ip.classify：IPv6 的 ULA、link-local、loopback、群播、文件用（2001:db8::/32）、全球單播與保留', () => {
  const table = [
    ['fd00::1', 'private'], ['fc12:3456::1', 'private'], ['FE80::1', 'link-local'], ['febf::1', 'link-local'], ['fec0::1', 'reserved'],
    ['::1', 'loopback'], ['::', 'reserved'], ['::ffff:192.0.2.1', 'reserved'], ['100::1', 'reserved'],
    ['ff02::1', 'multicast'], ['2001:db8::1', 'documentation'], ['2001:db8:ffff::1', 'documentation'], ['2001:db9::1', 'public'],
    ['2606:4700:4700::1111', 'public'], ['3fff:ffff::1', 'public'], ['4000::1', 'reserved'], ['1:2:3:4:5:6:7:8', 'reserved'],
  ];
  table.forEach(([a, want]) => assert.strictEqual(S.ip.classify(a), want, a));
  assert.ok(S.ip.classify('2001:db8::1') !== S.ip.classify('2001:db9::1'), '較長的網段優先（2001:db8::/32 在 2000::/3 內）');
});

test('S.ip.classify：不是單一位址時回 null（含 /長度、主機名稱、不合法的位址）', () => {
  ['', null, undefined, '10.0.0.0/8', '256.1.1.1', '1.2.3', 'router', '1::2::3', '12345::1', '1:2:3:4:5:6:7:8:9', ':::'].forEach((a) => assert.strictEqual(S.ip.classify(a), null, String(a)));
});

test('S.ip.SPECIAL：每一段的網段合法、類別在 CLASSES 內、網段位址已對齊遮罩，且同族內沒有重複的網段', () => {
  const seen = new Set();
  S.ip.SPECIAL.forEach(([cidr, cls, ref]) => {
    assert.ok(S.ip.CLASSES.includes(cls), cidr);
    assert.ok(ref, cidr + ' 要寫依據');
    assert.ok(!seen.has(cidr), cidr); seen.add(cidr);
    const [a] = cidr.split('/');
    if (S.ip.isIp(a)) assert.strictEqual(S.ip.parseCidr(cidr).net, a, cidr + ' 網段位址要對齊遮罩');
    else assert.notStrictEqual(S.ip.v6ToBig(a), null, cidr);
    assert.strictEqual(S.ip.classify(a), cls, cidr + ' 的網段位址本身屬於該類別');
  });
});

test('防火牆的「私有位址」範圍（!src-address 判斷）沿用 S.ip 的 private／cgnat／loopback／link-local，範圍與改用前相同', () => {
  const before = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', 'fc00::/7', 'fe80::/10', '::1/128'];
  assert.deepStrictEqual(S.ip.rangesOf(['private', 'cgnat', 'loopback', 'link-local']).slice().sort(), before.slice().sort());
});
