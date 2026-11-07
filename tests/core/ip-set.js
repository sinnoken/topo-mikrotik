// 位址集合 S.ip.set 與位址文字解析 S.ip.range（防火牆位址條件、位址清單、available-from 與 L4 等價類邊界的單一來源）
'use strict';
const assert = require('assert');
const { S, test } = require('../lib.js');

const n4 = (s) => BigInt(S.ip.toInt(s));
const rs = (set) => set.ranges.map(([a, b]) => a + '-' + b);

test('S.ip.range：位址、網段（清掉主機位元）、範圍，IPv4 與 IPv6；開頭的 ! 與不合法的文字為 null', () => {
  assert.deepStrictEqual(S.ip.range('10.0.0.1'), [n4('10.0.0.1'), n4('10.0.0.1'), 32]);
  assert.deepStrictEqual(S.ip.range('10.0.0.77/24'), [n4('10.0.0.0'), n4('10.0.0.255'), 32]);
  assert.deepStrictEqual(S.ip.range('10.0.0.5-10.0.0.9'), [n4('10.0.0.5'), n4('10.0.0.9'), 32]);
  assert.deepStrictEqual(S.ip.range('0.0.0.0/0'), [0n, 0xffffffffn, 32]);
  assert.deepStrictEqual(S.ip.range('2001:db8::/32'), [S.ip.v6ToBig('2001:db8::'), S.ip.v6ToBig('2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'), 128]);
  assert.deepStrictEqual(S.ip.range('2001:db8::1-2001:db8::9'), [S.ip.v6ToBig('2001:db8::1'), S.ip.v6ToBig('2001:db8::9'), 128]);
  ['!10.0.0.0/8', '10.0.0.0/33', '2001:db8::/129', 'example.com', '', '10.0.0.1-example', '1.2.3'].forEach((t) => assert.strictEqual(S.ip.range(t), null, t));
});

test('S.ip.set：排序、合併重疊與相鄰的區間，has 二分搜尋；isAll、isEmpty、within、bounds；與項目順序無關', () => {
  const a = S.ip.set(['10.0.1.0/24', '10.0.0.0/24', '10.0.0.128/25', '10.0.3.5-10.0.3.9', [n4('10.0.3.10'), n4('10.0.3.20')]], 32);
  assert.deepStrictEqual(rs(a), [`${n4('10.0.0.0')}-${n4('10.0.1.255')}`, `${n4('10.0.3.5')}-${n4('10.0.3.20')}`], '重疊與相鄰的合併成一段');
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.ranges) && a.ranges.every(Object.isFrozen));
  [['10.0.0.0', true], ['10.0.1.255', true], ['10.0.2.0', false], ['10.0.3.4', false], ['10.0.3.5', true], ['10.0.3.20', true], ['10.0.3.21', false]]
    .forEach(([ip, want]) => {
      assert.strictEqual(a.has(ip), want, ip);
      assert.strictEqual(a.has(n4(ip)), want, ip + '（BigInt）');
      assert.strictEqual(a.has(S.ip.toInt(ip)), want, ip + '（數字）');
    });
  assert.deepStrictEqual(a.bounds(), [n4('10.0.0.0'), n4('10.0.2.0'), n4('10.0.3.5'), n4('10.0.3.21')]);
  assert.ok(Object.isFrozen(a.bounds()) && a.bounds() === a.bounds());
  const b = S.ip.set([[n4('10.0.3.10'), n4('10.0.3.20')], '10.0.3.5-10.0.3.9', '10.0.0.128/25', '10.0.0.0/24', '10.0.1.0/24'], 32);
  assert.deepStrictEqual([rs(b), b.bounds()], [rs(a), a.bounds()], '同一組項目換順序結果相同');
  assert.deepStrictEqual([a.isAll, a.isEmpty], [false, false]);
  assert.deepStrictEqual([S.ip.set(['0.0.0.0/1', '128.0.0.0/1'], 32).isAll, S.ip.set([], 32).isEmpty, S.ip.set([], 32).has('1.2.3.4')], [true, true, false]);
  const priv = S.ip.set(['10.0.0.0/8', '192.168.0.0/16'], 32);
  assert.deepStrictEqual([a.within(priv), priv.within(a), S.ip.set([], 32).within(priv), S.ip.set(['10.0.0.0/8', '11.0.0.1'], 32).within(priv)], [true, false, true, false]);
  assert.deepStrictEqual(rs(S.ip.set(['10.0.0.9-10.0.0.5'], 32)), [], '起點大於終點的範圍不含任何位址');
});

test('S.ip.set：covers（整段都在）與 overlaps（有交集）看合併後的區段；位址族不同時丟出錯誤', () => {
  const s = S.ip.set(['10.1.0.0/25', '10.1.0.128/25', '10.3.0.0/24'], 32);
  assert.deepStrictEqual(['10.1.0.0/24', '10.1.0.64/26', '10.0.0.0/16', '10.3.0.0/23', '10.3.0.5'].map(s.covers), [true, true, false, false, true]);
  assert.deepStrictEqual(['10.0.0.0/8', '10.2.0.0/24', '10.3.0.255-10.4.0.0', '10.4.0.0/16', '9.0.0.0/8'].map(s.overlaps), [true, false, true, false, false]);
  assert.deepStrictEqual([S.ip.set([], 32).covers('1.2.3.4'), S.ip.set([], 32).overlaps('0.0.0.0/0')], [false, false]);
  const six = S.ip.set(['2001:db8::/49', '2001:db8:0:8000::/49'], 128);
  assert.deepStrictEqual([six.covers('2001:db8::/48'), six.overlaps('2001:db9::/32')], [true, false]);
  assert.throws(() => s.covers('2001:db8::/32'), TypeError);
});

test('S.ip.set：IPv6（網段、範圍、合併）；否定（!）、不合法或位址族不同的項目丟出錯誤，不靜默略過', () => {
  const v6 = S.ip.set(['2001:db8:1::/48', '2001:db8::/48', 'fd00::5-fd00::9', 'fd00::a'], 128);
  assert.strictEqual(v6.ranges.length, 2, '2001:db8::/48 與 2001:db8:1::/48 相鄰；fd00::5–9 與 fd00::a 相鄰');
  [['2001:db8::1', true], ['2001:db8:1:ffff::1', true], ['2001:db8:2::', false], ['fd00::4', false], ['fd00::a', true], ['fd00::b', false]]
    .forEach(([ip, want]) => assert.strictEqual(v6.has(ip), want, ip));
  assert.ok(S.ip.set(['::/0'], 128).isAll);
  assert.throws(() => S.ip.set(['!10.0.0.0/8'], 32), TypeError, '否定由呼叫端處理');
  assert.throws(() => S.ip.set(['example.com'], 32), TypeError);
  assert.throws(() => S.ip.set(['2001:db8::/32'], 32), TypeError, 'IPv6 項目放進 IPv4 的集合');
  assert.throws(() => S.ip.set(['10.0.0.0/8'], 128), TypeError);
  assert.throws(() => S.ip.set([], 64), TypeError);
  assert.throws(() => v6.has('10.0.0.1'), TypeError, '查的位址不是這個位址族');
  assert.throws(() => S.ip.set(['10.0.0.0/8'], 32).has('fd00::1'), TypeError);
});
