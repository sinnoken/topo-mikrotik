// 路由表收集不完整（route 區塊有 # collection failed，例如逾時只收到前面一部分）：是事實（coverage[].incomplete），
// 查不到符合的路由時路徑追蹤與可達性回不明，「沒有路由」類的檢查對這台不報（R01：這台的下一跳；R12：要看這台的路由才能判斷的網段；R09、R10 查不到時不明）
'use strict';
const assert = require('assert');
const { S, build, count, test } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/**
 * R1：邊界路由器（WAN ether1、LAN 192.168.1.0/24、經 ether3 接 R2）；R2：LAN 192.168.2.0/24，預設路由指向 R1。
 * failed：R1 的路由表逾時，只收到前面的直連路由（預設路由、到 R2 網段的路由與一條遞迴閘道的靜態路由沒有收到）。
 * 沒有逾時時，R1 只有直連路由（同樣缺少那幾條）：R12、R01、路徑追蹤的「沒有路由」是對的。
 */
function net(failed) {
  const r1 = ['R1 (192.168.1.1):', '### /export terse', '/interface bridge add name=bridge1',
    '/interface list add name=WAN', '/interface list add name=LAN',
    '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=bridge1 list=LAN',
    '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0', '/ip address add address=10.0.12.1/30 interface=ether3 network=10.0.12.0',
    '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
    '### /ip route print detail without-paging', RT,
    ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge1 distance=0',
    ' DAc dst-address=10.0.12.0/30 routing-table=main gateway=ether3 distance=0',
    ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
    // 這條有收到，但它的閘道 10.99.0.1 要靠沒收到的路由解析
    ' As dst-address=10.50.0.0/16 routing-table=main gateway=10.99.0.1 distance=1'];
  if (failed) r1.push('# collection failed: timeout');
  const r2 = ['R2 (192.168.2.1):', '### /export terse', '/interface bridge add name=bridge1',
    '/ip address add address=192.168.2.1/24 interface=bridge1 network=192.168.2.0', '/ip address add address=10.0.12.2/30 interface=ether1 network=10.0.12.0',
    '### /ip route print detail without-paging', RT,
    ' DAc dst-address=192.168.2.0/24 routing-table=main gateway=bridge1 distance=0',
    ' DAc dst-address=10.0.12.0/30 routing-table=main gateway=ether1 distance=0',
    ' As dst-address=0.0.0.0/0 routing-table=main gateway=10.0.12.1 distance=1'];
  return build(r1.concat(r2, ['']).join('\n'));
}

test('路由表收集不完整是事實：coverage[].incomplete 列出收集失敗的資料類別，Q.routesIncomplete 與模型版路由視圖相同', () => {
  const s = net(true); const Q = S.query(s);
  const cov = Q.coverageOf('R1');
  assert.deepStrictEqual(cov.incomplete, ['route']);
  assert.ok(cov.failures.some((f) => f.reason === 'timeout' && f.dataTypes.includes('route')));
  assert.deepStrictEqual(Q.coverageOf('R2').incomplete, []);
  assert.deepStrictEqual([Q.routesIncomplete('R1'), Q.routesIncomplete('R2'), Q.routesIncomplete('NOPE')], [true, false, false]);
  assert.ok(s.model.routes.some((r) => r.dev === 'R1' && r.prefix === '10.50.0.0'), '收到的部分照常解析');
  assert.ok(count(s, 'C02') >= 1, 'C02 提醒收集失敗');
  // 3.10.0 之前的基準沒有 incomplete：改看 failures 的 dataTypes
  const old = JSON.parse(JSON.stringify(s)); old.coverage.forEach((c) => delete c.incomplete);
  assert.strictEqual(S.query(old).routesIncomplete('R1'), true);
  assert.deepStrictEqual(net(false).coverage.map((c) => c.incomplete), [[], []]);
});

test('路由表收集不完整：查不到符合的路由時 S.trace 停在 unverified、Q.reach 不明（route-data-incomplete）；收齊時才是沒有路由', () => {
  const Q = S.query(net(true));
  const lk = S.trace.lookup(S.trace.routingOf(Q), 'R1', '8.8.8.8', 'main');
  assert.strictEqual(lk.kind, 'route-data-incomplete');
  assert.strictEqual(S.trace.lookup(S.trace.routingOf(Q), 'R1', '192.168.1.9', 'main').kind, 'connected', '查得到的照常');
  const t = S.trace(Q, '192.168.1.10', '8.8.8.8');
  assert.notStrictEqual(t.status, 'unreachable');
  assert.strictEqual(t.status, 'unverified');
  assert.ok(t.ends.every((e) => e.status === 'unverified' && e.reason === 'route-data-incomplete' && e.dev === 'R1'), JSON.stringify(t.ends));
  const r = Q.reach('192.168.1.10', '8.8.8.8', { proto: 'tcp', port: 443 });
  assert.strictEqual(r.verdict, 'unknown');
  assert.ok(r.paths.some((p) => p.end.code === 'route-data-incomplete'), JSON.stringify(r.paths.map((p) => p.end.code)));
  assert.ok(S.query.reachReasonCodes().some((x) => x.code === 'route-data-incomplete' && x.assumption === null));
  // 從 R2 經 R1 到 R2 自己沒收到的網段也一樣停在 R1
  assert.strictEqual(S.trace(Q, '192.168.2.10', '8.8.8.8').status, 'unverified');
  // 對照：路由表收齊（沒有逾時）時是沒有路由
  const Q0 = S.query(net(false));
  assert.strictEqual(S.trace.lookup(S.trace.routingOf(Q0), 'R1', '8.8.8.8', 'main').kind, 'no-match');
  assert.strictEqual(S.trace(Q0, '192.168.1.10', '8.8.8.8').status, 'unreachable');
  assert.strictEqual(Q0.reach('192.168.1.10', '8.8.8.8', { proto: 'tcp', port: 443 }).verdict, 'deny');
});

/**
 * 收到的部分有較短的路由（預設路由、/16 的黑洞）：沒收到的部分可能有更長的前綴，最長前綴查找只有命中 /32 才確定。
 * R1 的路由表逾時；R2 收齊。extra 是 R1 另外收到的路由。
 */
function partial(extra, failed) {
  const r1 = ['R1 (192.168.1.1):', '### /export terse', '/interface bridge add name=bridge1',
    '/interface list add name=WAN', '/interface list add name=LAN',
    '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=bridge1 list=LAN',
    '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0', '/ip address add address=10.0.12.1/30 interface=ether3 network=10.0.12.0',
    '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
    '### /ip route print detail without-paging', RT,
    ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1',
    ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge1 distance=0'].concat(extra || []);
  if (failed !== false) r1.push('# collection failed: timeout');
  const r2 = ['R2 (192.168.2.1):', '### /export terse', '/interface bridge add name=bridge1',
    '/ip address add address=192.168.2.1/24 interface=bridge1 network=192.168.2.0', '/ip address add address=10.0.12.2/30 interface=ether1 network=10.0.12.0',
    '### /ip route print detail without-paging', RT,
    ' DAc dst-address=192.168.2.0/24 routing-table=main gateway=bridge1 distance=0',
    ' As dst-address=0.0.0.0/0 routing-table=main gateway=10.0.12.1 distance=1'];
  return build(r1.concat(r2, ['']).join('\n'));
}

test('路由表收集不完整：收到的部分只符合較短的路由（預設路由）時也是不明——沒收到的部分可能有更長的前綴；命中 /32 才確定', () => {
  const Q = S.query(partial());
  const R = S.trace.routingOf(Q);
  const lk = S.trace.lookup(R, 'R1', '192.168.2.10', 'main');
  assert.deepStrictEqual([lk.kind, lk.partial], ['route-data-incomplete', '0.0.0.0/0']);
  assert.strictEqual(S.trace.lookup(R, 'R1', '8.8.8.8', 'main').kind, 'route-data-incomplete');
  assert.strictEqual(S.trace.lookup(R, 'R1', '192.168.1.9', 'main').kind, 'connected', '直連網段照常');
  const t = S.trace(Q, '192.168.1.10', '192.168.2.10');
  assert.strictEqual(t.status, 'unverified');
  assert.ok(t.ends.every((e) => e.status === 'unverified' && e.reason === 'route-data-incomplete' && /0\.0\.0\.0\/0/.test(e.note)), JSON.stringify(t.ends));
  const r = Q.reach('192.168.1.10', '192.168.2.10', { proto: 'tcp', port: 443 });
  assert.strictEqual(r.verdict, 'unknown');
  assert.ok(r.paths.length && r.paths.every((p) => p.end.code === 'route-data-incomplete'), JSON.stringify(r.paths.map((p) => p.end.code)));
  // 命中 /32：沒有更長的前綴，結果確定
  const Q32 = S.query(partial([' As dst-address=192.168.2.10/32 routing-table=main gateway=10.0.12.2 distance=1']));
  const lk32 = S.trace.lookup(S.trace.routingOf(Q32), 'R1', '192.168.2.10', 'main');
  assert.deepStrictEqual([lk32.kind, lk32.route], ['route', '192.168.2.10/32']);
  assert.strictEqual(S.trace(Q32, '192.168.1.10', '192.168.2.10').status, 'reached');
  // 對照：收齊時預設路由就是答案
  const Q0 = S.query(partial(null, false));
  assert.strictEqual(S.trace.lookup(S.trace.routingOf(Q0), 'R1', '192.168.2.10', 'main').kind, 'route');
  assert.notStrictEqual(S.trace(Q0, '192.168.1.10', '192.168.2.10').status, 'unverified');
  // 判斷函式只有一份：S.trace.routeCertain
  assert.deepStrictEqual([S.trace.routeCertain(false, []), S.trace.routeCertain(true, []), S.trace.routeCertain(true, [{ len: 24 }]), S.trace.routeCertain(true, [{ len: 32 }])], [true, false, false, true]);
});

test('路由表收集不完整：命中 /32 但閘道要遞迴解析、只能靠較短的路由時，原因是 route-data-incomplete（不是 next-hop-outside）；收齊時照常', () => {
  const extra = [' As dst-address=192.168.2.10/32 routing-table=main gateway=10.99.0.1 distance=1'];
  const Q = S.query(partial(extra));
  assert.strictEqual(S.trace.nextOwner(S.trace.routingOf(Q), 'R1', '10.99.0.1', 'main').status, 'incomplete');
  const t = S.trace(Q, '192.168.1.10', '192.168.2.10');
  assert.strictEqual(t.status, 'unverified');
  assert.ok(t.ends.length && t.ends.every((e) => e.status === 'unverified' && e.reason === 'route-data-incomplete' && /10\.99\.0\.1/.test(e.note)), JSON.stringify(t.ends));
  const r = Q.reach('192.168.1.10', '192.168.2.10', { proto: 'tcp', port: 443 });
  assert.strictEqual(r.verdict, 'unknown');
  assert.deepStrictEqual(S.util.uniq(r.paths.map((p) => p.end.code)), ['route-data-incomplete']);
  // 收齊時：預設路由解析得到 198.51.100.1，但它不屬於任何設備，目的在基準內——下一跳不在基準內
  const Q0 = S.query(partial(extra, false));
  assert.strictEqual(S.trace.nextOwner(S.trace.routingOf(Q0), 'R1', '10.99.0.1', 'main').status, 'unknown');
  assert.deepStrictEqual(S.util.uniq(Q0.reach('192.168.1.10', '192.168.2.10', { proto: 'tcp', port: 443 }).paths.map((p) => p.end.code)), ['next-hop-outside']);
});

test('路由表收集不完整：下一跳只能靠較短的路由解析時（黑洞、迴圈、找不到）R01／R03／R04 都不報；收齊時照常', () => {
  const extra = [' As dst-address=10.50.0.0/16 routing-table=main gateway=10.99.0.1 distance=1', ' As dst-address=10.99.0.0/16 routing-table=main blackhole distance=1'];
  const ids = (s) => s.findings.filter((f) => /^R0[134]$/.test(f.id) && f.entities.some((e) => e.key === 'R1')).map((f) => f.id);
  assert.deepStrictEqual(ids(partial(extra, false)), ['R04'], '收齊時：10.99.0.1 落入黑洞');
  assert.deepStrictEqual(ids(partial(extra)), [], '不完整時：10.99.0.1 可能有沒收到的更長路由');
  const res = S.check.resolveNextHop([{ prefix: '10.99.0.0', len: 16, blackhole: true, nh: [] }], '10.99.0.1', () => null, true);
  assert.deepStrictEqual(res.map((x) => x.status), ['incomplete']);
});

test('路由表收集不完整：R01（下一跳解析不到）與 R12（網段沒有路由可以到達）對這台不報；收齊時照常', () => {
  const full = net(false); const part = net(true);
  assert.ok(full.findings.some((f) => f.id === 'R01' && /10\.99\.0\.1/.test(f.message)), '收齊時：10.99.0.1 沒有路由可解析');
  assert.ok(full.findings.some((f) => f.id === 'R12' && /192\.168\.2\.0\/24/.test(f.message)), '收齊時：R1 沒有到 R2 網段的路由');
  assert.strictEqual(count(part, 'R01'), 0);
  const r12 = (s) => s.findings.filter((f) => f.id === 'R12').map((f) => f.entities[0].key);
  // R2 的網段：要看 R1 有沒有路由，R1 的路由表不完整 → 不報；R1 的網段：要看 R2（收齊）→ 照常
  assert.deepStrictEqual([r12(full), r12(part)], [['R1', 'R2'], ['R1']]);
});
