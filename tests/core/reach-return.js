// L4 路徑的回程前提：Q.reach／Q.exposure 在 Q.policyBaseline 的 returnSafe 為 false 時標「回程未保證」（returnUnsafe、return-not-guaranteed）
// 依據：https://manual.mikrotik.com/docs/firewall-and-quality-of-service/connection-tracking.md（同一條連線之後的封包與回程都是 established）
// 測試資料依手冊的 /ip firewall filter 語法手寫，不是實機擷取
'use strict';
const assert = require('assert');
const { S, build, test, sampleSnap } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
const FF = (a) => '/ip firewall filter add ' + a;
/** 路由器 R：ether1 是 WAN（198.51.100.2/30），ether2 是 192.168.1.0/24，ether3 是 203.0.113.0/29（公網網段，沒有 NAT）。filter 由呼叫端給。 */
const router = (rules) => build([
  'R (192.168.1.1):',
  '### /export terse',
  '/interface list add name=WAN', '/interface list add name=LAN',
  '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=ether2 list=LAN',
  '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
  '/ip address add address=192.168.1.1/24 interface=ether2 network=192.168.1.0',
  '/ip address add address=203.0.113.1/29 interface=ether3 network=203.0.113.0',
].concat(rules, [
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=ether2 distance=0',
  ' DAc dst-address=203.0.113.0/29 routing-table=main gateway=ether3 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1',
  '',
]).join('\n'));
const CODE = 'return-not-guaranteed';
const hopsOf = (rc) => rc.paths.flatMap((p) => p.hops);
const exposureOf = (Q, o) => Q.exposure(o);

test('回程未保證：forward 只放行新連線、最後全部丟棄（同範例資料 TPE_ACC_SW_10）時，允許的路徑在 forward 的跳標 returnUnsafe，notes 附 return-not-guaranteed', () => {
  const s = router([FF('action=accept chain=forward connection-state=new in-interface=ether2'), FF('action=drop chain=forward')]);
  const Q = S.query(s);
  const drop = s.model.firewallRules.find((r) => r.chain === 'forward' && r.action === 'drop');
  const pb = Q.policyBaseline('R').find((c) => c.chain === 'forward');
  assert.deepStrictEqual([pb.returnSafe, pb.established.status, pb.established.rule], [false, 'drop', drop.key]);
  const rc = Q.reach('192.168.1.10', '203.0.113.2', { proto: 'tcp', port: 443 });
  assert.strictEqual(rc.verdict, 'allow', '結論仍是允許');
  const h = hopsOf(rc).find((x) => x.dev === 'R');
  assert.deepStrictEqual(h.returnUnsafe, { chain: 'forward', rule: drop.key, interfaces: null });
  const n = rc.notes.filter((x) => x.code === CODE);
  assert.strictEqual(n.length, 1);
  assert.deepStrictEqual([n[0].dev, n[0].chain, n[0].rule.key, n[0].interfaces], ['R', 'forward', drop.key, null]);
  assert.ok(/回程可能被丟棄/.test(n[0].message) && /F15/.test(n[0].message), n[0].message);
  assert.deepStrictEqual(rc.reasons, [], 'reasons 只在 unknown 時有值');
  assert.ok(Object.isFrozen(h.returnUnsafe));
  // 拒絕的路徑不標（新連線就到不了）
  const no = Q.reach('203.0.113.2', '192.168.1.10', { proto: 'tcp', port: 22 });
  assert.strictEqual(no.verdict, 'deny');
  assert.ok(!no.notes.some((x) => x.code === CODE) && !no.reasons.some((x) => x.code === CODE));
  // input 有保證（沒有規則，預設放行）：送到設備本身的路徑不標
  const self = Q.reach('192.168.1.10', '192.168.1.1', { proto: 'tcp', port: 22 });
  assert.ok(hopsOf(self).every((x) => x.returnUnsafe === undefined) && !self.notes.some((x) => x.code === CODE));
});

test('回程未保證：依介面丟棄（blockedFrom）時只在路徑的入／出介面相關時標，介面不相關的路徑不標、逐跳也沒有 returnUnsafe', () => {
  const s = router([FF('action=drop chain=forward in-interface=ether3'), FF('action=accept chain=forward connection-state=established,related'),
    FF('action=accept chain=forward')]);
  const Q = S.query(s);
  const drop = s.model.firewallRules.find((r) => r.chain === 'forward' && r.action === 'drop');
  const pb = Q.policyBaseline('R').find((c) => c.chain === 'forward');
  assert.deepStrictEqual([pb.returnSafe, pb.established.blockedFrom.map((b) => b.interfaces)], [false, [['R|ether3']]]);
  // 出介面是 ether3：回程從 ether3 進來，被第 1 條丟棄
  const out3 = Q.reach('192.168.1.10', '203.0.113.2', { proto: 'tcp', port: 443 });
  assert.strictEqual(out3.verdict, 'allow');
  assert.deepStrictEqual(hopsOf(out3).find((x) => x.dev === 'R').returnUnsafe, { chain: 'forward', rule: drop.key, interfaces: ['R|ether3'] });
  const n = out3.notes.find((x) => x.code === CODE);
  assert.ok(n && /ether3/.test(n.message), JSON.stringify(out3.notes));
  // 出介面是 ether1、入介面是 ether2：回程介面不相關，不標
  const out1 = Q.reach('192.168.1.10', '198.51.100.1', { proto: 'tcp', port: 443 });
  assert.strictEqual(out1.verdict, 'allow');
  assert.ok(hopsOf(out1).every((x) => !('returnUnsafe' in x)), '逐跳沒有 returnUnsafe 欄位（輸出與沒有這個判斷時相同）');
  assert.ok(!out1.notes.some((x) => x.code === CODE));
  // 只限出介面的丟棄（interfaces 為 null）：不知道哪些入介面，所有路徑都標
  const o = S.query(router([FF('action=drop chain=forward out-interface=ether3'), FF('action=accept chain=forward connection-state=established'), FF('action=accept chain=forward')]));
  const ob = o.policyBaseline('R').find((c) => c.chain === 'forward');
  assert.deepStrictEqual(ob.established.blockedFrom.map((b) => b.interfaces), [null]);
  const any = o.reach('192.168.1.10', '198.51.100.1', { proto: 'tcp', port: 443 });
  assert.deepStrictEqual([any.verdict, hopsOf(any).find((x) => x.dev === 'R').returnUnsafe.interfaces], ['allow', null]);
});

test('回程未保證：Q.exposure 的允許列在 reasons 帶 return-not-guaranteed、returnUnsafe 列出跳；回程有保證的列 reasons 為空', () => {
  const s = router([FF('action=accept chain=forward dst-address=203.0.113.2 dst-port=443 in-interface-list=WAN protocol=tcp'), FF('action=drop chain=forward')]);
  const Q = S.query(s); const x = exposureOf(Q);
  const drop = s.model.firewallRules.find((r) => r.chain === 'forward' && r.action === 'drop');
  const web = x.routed.rows.find((r) => r.ip === '203.0.113.2' && r.service === 'tcp/443');
  assert.ok(web, JSON.stringify(x.routed.rows.map((r) => [r.ip, r.service])));
  assert.deepStrictEqual([web.family, web.verdict, web.reasons, web.returnUnsafe], ['ipv4', 'allow', [CODE], [{ dev: 'R', chain: 'forward', rule: drop.key, interfaces: null }]]);
  const rc = Q.reach(web.src, web.ip, { proto: 'tcp', port: 443, entry: web.entry });
  assert.ok(rc.verdict === 'allow' && rc.notes.some((n) => n.code === CODE), '與 Q.reach 相同');
  // input 沒有規則（預設放行，回程有保證）：本身的列不帶
  x.self.rows.filter((r) => r.verdict === 'allow').forEach((r) => assert.deepStrictEqual([r.reasons, r.returnUnsafe], [[], []], r.service));
  const codes = new Set(S.query.reachReasonCodes().map((c) => c.code));
  assert.ok(codes.has(CODE) && S.query.reachReasonCodes().find((c) => c.code === CODE).kind === 'reason');
});

test('回程未保證（範例資料）：TPE_ACC_SW_10 的 forward 不保證（F15）、input 有保證；送到它本身的路徑不標，其餘設備的路徑也不標', () => {
  const s = sampleSnap(); const Q = S.query(s);
  const pb = Q.policyBaseline('TPE_ACC_SW_10');
  assert.deepStrictEqual(pb.map((c) => [c.chain, c.returnSafe]), [['input', true], ['forward', false]]);
  assert.ok(Q.findingsByRule('F15').some((f) => Q.findingDevice(f) === 'TPE_ACC_SW_10'));
  const rc = Q.reach('10.1.10.20', '10.1.10.30', { proto: 'tcp', port: 22 });
  assert.ok(hopsOf(rc).every((h) => !('returnUnsafe' in h)) && !rc.notes.some((n) => n.code === CODE), JSON.stringify(rc.notes));
  // 範例資料中只有 TPE_ACC_SW_10 不保證，它只有一個 L3 介面、沒有路由（沒有經過它 forward 的路徑）：暴露清單沒有任何列帶這個代碼
  const x = Q.exposure();
  ['self', 'dnat', 'routed'].forEach((k) => x[k].rows.forEach((r) => assert.ok(!r.reasons.includes(CODE) && !r.returnUnsafe.length, `${k} ${r.ip} ${r.service}`)));
  assert.deepStrictEqual(Q.routesOf('TPE_ACC_SW_10'), []);
});
