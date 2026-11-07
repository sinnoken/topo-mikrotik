// 查詢層的搜尋：Q.routesMatching（位址或網段找路由）、Q.addressSetFind（位址集合裡找重疊的區段）、Q.addressSetsOf（登錄表依設備與類別列出 id）。
// 只讀 Snapshot，不改基準。路由的旗標與欄位依 https://manual.mikrotik.com/docs/cli-reference/ip/route.md；測試資料依手冊的語法手寫，不是實機擷取。
'use strict';
const assert = require('assert');
const { S, build, test } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
const box = (routes, extra) => build(['R (192.168.1.1):', '### /export terse',
  '/interface bridge add name=bridge1',
  '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0',
  '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
  ...(extra || []),
  '### /ip route print detail without-paging', RT, ...routes, ''].join('\n'));
const ROUTES = [
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge1 distance=0',
  ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1',
  '  s dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.9 distance=5',
  ' As dst-address=10.0.0.0/8 routing-table=main gateway=198.51.100.1 distance=1',
  ' As dst-address=10.1.0.0/16 routing-table=main gateway=198.51.100.1 distance=1',
  ' As dst-address=10.1.2.0/24 routing-table=main gateway=198.51.100.1 distance=1',
  ' As dst-address=10.1.2.0/24 routing-table=t2 gateway=198.51.100.1 distance=1',
  ' As dst-address=10.1.2.3/32 routing-table=main gateway=198.51.100.1 distance=1',
  ' As dst-address=10.1.3.0/24 routing-table=main gateway=198.51.100.1 distance=1',
  ' As dst-address=10.2.0.0/16 routing-table=main gateway=198.51.100.1 distance=1',
];
const fmt = (rs) => rs.map((r) => `${r.prefix}/${r.len}@${r.routingTable}${r.active === false ? '(inactive)' : ''}`);

test('Q.routesMatching：位址回傳包含它的每一筆路由（含非作用中、各路由表），前綴由長到短、同長度依 allRoutesOf 的順序', () => {
  const Q = S.query(box(ROUTES));
  assert.deepStrictEqual(fmt(Q.routesMatching('R', '10.1.2.3')),
    ['10.1.2.3/32@main', '10.1.2.0/24@main', '10.1.2.0/24@t2', '10.1.0.0/16@main', '10.0.0.0/8@main', '0.0.0.0/0@main', '0.0.0.0/0@main(inactive)']);
  assert.deepStrictEqual(fmt(Q.routesMatching('R', '10.1.2.4')),
    ['10.1.2.0/24@main', '10.1.2.0/24@t2', '10.1.0.0/16@main', '10.0.0.0/8@main', '0.0.0.0/0@main', '0.0.0.0/0@main(inactive)']);
  // 和逐筆掃描（allRoutesOf ＋ S.ip.range）的結果相同
  const all = Q.allRoutesOf('R');
  ['10.1.2.3', '192.168.1.77', '8.8.8.8', '10.2.255.255'].forEach((ip) => {
    const n = S.ip.range(ip)[0];
    const want = all.filter((r) => { const q = S.ip.range(r.prefix + '/' + r.len); return q[0] <= n && n <= q[1]; })
      .map((r) => [r, all.indexOf(r)]).sort((a, b) => b[0].len - a[0].len || a[1] - b[1]).map((x) => x[0]);
    assert.deepStrictEqual(Q.routesMatching('R', ip), want, ip);
  });
  assert.ok(Object.isFrozen(Q.routesMatching('R', '10.1.2.3')));
});

test('Q.routesMatching：網段回傳包含它（含相同網段）與被它包含的路由；主機位元清掉；table 只看那張路由表', () => {
  const Q = S.query(box(ROUTES));
  assert.deepStrictEqual(fmt(Q.routesMatching('R', '10.1.0.0/16')),
    ['10.1.2.3/32@main', '10.1.2.0/24@main', '10.1.2.0/24@t2', '10.1.3.0/24@main', '10.1.0.0/16@main', '10.0.0.0/8@main', '0.0.0.0/0@main', '0.0.0.0/0@main(inactive)']);
  assert.deepStrictEqual(fmt(Q.routesMatching('R', '10.1.9.9/16')), fmt(Q.routesMatching('R', '10.1.0.0/16')), '主機位元清掉');
  assert.deepStrictEqual(fmt(Q.routesMatching('R', '10.1.2.0/23')),
    ['10.1.2.3/32@main', '10.1.2.0/24@main', '10.1.2.0/24@t2', '10.1.3.0/24@main', '10.1.0.0/16@main', '10.0.0.0/8@main', '0.0.0.0/0@main', '0.0.0.0/0@main(inactive)']);
  assert.strictEqual(Q.routesMatching('R', '0.0.0.0/0').length, Q.allRoutesOf('R').length, '/0 包含全部');
  assert.deepStrictEqual(fmt(Q.routesMatching('R', '10.1.2.3', { table: 't2' })), ['10.1.2.0/24@t2']);
  assert.deepStrictEqual(fmt(Q.routesMatching('R', '10.1.0.0/16', { table: 'main' })).filter((x) => /t2/.test(x)), []);
  assert.deepStrictEqual(Q.routesMatching('R', '10.1.2.3', { table: 'nope' }), []);
});

test('Q.routesMatching：不合法、範圍與否定為 null（格式不對）；IPv6、沒有路由的設備為空陣列（找不到）；table 不是字串時 TypeError', () => {
  const Q = S.query(box(ROUTES));
  ['', 'abc', '10.1.2', '10.1.2.300', '10.0.0.0/33', '10.0.0.1-10.0.0.9', '!10.0.0.0/8', null, undefined].forEach((x) => assert.strictEqual(Q.routesMatching('R', x), null, String(x)));
  assert.deepStrictEqual(Q.routesMatching('R', '2001:db8::1'), []);
  assert.deepStrictEqual(Q.routesMatching('R', '2001:db8::/32'), []);
  assert.deepStrictEqual(Q.routesMatching('nope', '10.1.2.3'), []);
  assert.strictEqual(Q.routesMatching('nope', 'bad'), null);
  assert.throws(() => Q.routesMatching('R', '10.1.2.3', { table: 5 }), TypeError);
});

test('Q.routesMatching：10 萬筆路由的設備只建一次索引（S.query 時不建；之後每次查詢只解析輸入）', () => {
  const snap = box(ROUTES.slice(0, 3));
  const base = snap.model.routes[0];
  for (let k = 0; k < 100000; k++) {
    const net = `10.${(k >> 8) & 255}.${k & 255}.0`;
    snap.model.routes.push(Object.assign({}, base, { prefix: net, len: 24, routingTable: k % 2 ? 'main' : 't2', active: k % 3 !== 0 }));
  }
  const px = S.ip.prefixIndex; const range = S.ip.range; let nPx = 0; let nRange = 0;
  S.ip.prefixIndex = function () { nPx++; return px.apply(this, arguments); };
  S.ip.range = function () { nRange++; return range.apply(this, arguments); };
  try {
    const Q = S.query(snap);
    assert.deepStrictEqual([nPx, nRange], [0, 0], 'S.query 時不建');
    const hit = Q.routesMatching('R', '10.1.2.3');
    assert.deepStrictEqual(fmt(hit), ['10.1.2.0/24@t2(inactive)', '10.1.2.0/24@t2', '0.0.0.0/0@main']);
    assert.strictEqual(nPx, 1);
    const built = nRange;
    assert.ok(built > 100000, '建索引時每筆路由解析一次');
    for (let k = 0; k < 50; k++) Q.routesMatching('R', `10.${k}.0.0/16`, k % 2 ? { table: 'main' } : undefined);
    assert.strictEqual(Q.routesMatching('R', '10.0.0.0/8').length, 100001);
    assert.deepStrictEqual([nPx, nRange - built], [1, 51], '之後每次查詢只解析一次輸入，不重建索引');
  } finally { S.ip.prefixIndex = px; S.ip.range = range; }
});

const LISTS = ['/ip firewall address-list add address=10.0.0.0/25 list=BAD', '/ip firewall address-list add address=10.0.0.128/25 list=BAD',
  '/ip firewall address-list add address=10.0.2.0/24 list=BAD', '/ip firewall address-list add address=10.0.9.1-10.0.9.5 list=BAD',
  '/ip firewall address-list add address=172.16.0.0/12 list=OK', '/ipv6 firewall address-list add address=2001:db8::/32 list=BAD',
  '/ip firewall filter add action=drop chain=input src-address=203.0.113.0/24'];

test('Q.addressSetFind：回傳和 text 重疊的合併區段索引（依 Q.addressSet(id).ranges）；位址、網段、範圍都可以；不合法時 null、找不到時空陣列', () => {
  const Q = S.query(box(ROUTES.slice(0, 3), LISTS));
  const id = 'R|ip|BAD';
  assert.deepStrictEqual(Q.addressSet(id).ranges, [['10.0.0.0', '10.0.0.255'], ['10.0.2.0', '10.0.2.255'], ['10.0.9.1', '10.0.9.5']]);
  assert.deepStrictEqual(Q.addressSetFind(id, '10.0.0.200'), [0]);
  assert.deepStrictEqual(Q.addressSetFind(id, '10.0.0.0/16'), [0, 1, 2]);
  assert.deepStrictEqual(Q.addressSetFind(id, '10.0.1.0/24'), [], '兩段之間');
  assert.deepStrictEqual(Q.addressSetFind(id, '10.0.2.255-10.0.9.1'), [1, 2], '範圍的兩端剛好碰到');
  assert.deepStrictEqual(Q.addressSetFind(id, '10.0.9.6'), []);
  assert.deepStrictEqual(Q.addressSetFind(id, '2001:db8::1'), [], '另一個位址族：找不到');
  ['', '   ', 'abc', '10.0.0.300', '!10.0.0.0/8', '10.0.0.0/40', null].forEach((t) => assert.strictEqual(Q.addressSetFind(id, t), null, String(t)));
  assert.deepStrictEqual(Q.addressSetFind('R|ipv6|BAD', '2001:db8:1::/48'), [0]);
  assert.ok(Object.isFrozen(Q.addressSetFind(id, '10.0.0.0/16')));
  // 每一個索引都確實和 text 重疊（與 overlaps 同一個判斷）
  const set = Q.addrSets().get(id).set;
  Q.addressSetFind(id, '10.0.0.0/16').forEach((k) => assert.ok(set.overlaps(set.ranges[k])));
  assert.throws(() => Q.addressSetFind('R|ip|NOPE', '10.0.0.1'), TypeError);
});

test('Q.addressSetsOf：依設備與類別列出登錄表的 id（依登錄順序，凍結）；類別不合法時 TypeError', () => {
  const Q = S.query(box(ROUTES.slice(0, 3), LISTS.concat('/ip service set ssh address=192.168.1.0/24')));
  assert.deepStrictEqual(Q.addressSetsOf('R', 'address-list'), ['R|ip|BAD', 'R|ip|OK', 'R|ipv6|BAD']);
  assert.ok(Q.addressSetsOf('R', 'service').includes('R|ip|service|ssh'));
  const rule = Q.addressSetsOf('R', 'rule-address');
  assert.strictEqual(rule.length, 1); assert.ok(/\|src-address$/.test(rule[0]), rule[0]);
  Q.addressSetsOf('R', 'address-list').forEach((id) => assert.strictEqual(Q.addressSet(id).dev, 'R'));
  // name：清單與服務有名稱（畫面不必拆 id），其他種類為 null
  assert.deepStrictEqual(Q.addressSetsOf('R', 'address-list').map((id) => Q.addressSet(id).name), ['BAD', 'OK', 'BAD']);
  assert.strictEqual(Q.addressSet('R|ip|service|ssh').name, 'ssh');
  assert.strictEqual(Q.addressSet(rule[0]).name, null);
  assert.deepStrictEqual(Q.addressSetsOf('nope', 'address-list'), []);
  assert.deepStrictEqual(Q.addressSetsOf('R', 'routing-rule'), []);
  assert.ok(Object.isFrozen(Q.addressSetsOf('R', 'address-list')));
  assert.deepStrictEqual(Q.addressSetsOf('R', 'address-list'), S.query(box(ROUTES.slice(0, 3), LISTS.concat('/ip service set ssh address=192.168.1.0/24'))).addressSetsOf('R', 'address-list'), '相同輸入相同順序');
  assert.throws(() => Q.addressSetsOf('R', 'nope'), TypeError);
});
