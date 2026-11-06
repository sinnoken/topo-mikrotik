// 防火牆的狀態式骨架（回程的前提）：S.infer.fw.policyBaseline、Q.policyBaseline 與 F15
// 依據：https://manual.mikrotik.com/docs/firewall-and-quality-of-service/connection-tracking.md（established／related／invalid 的意義、fasttrack-connection）
// 測試資料依手冊的 /ip firewall filter 語法手寫，不是實機擷取
'use strict';
const assert = require('assert');
const { S, test, fwBox, fws } = require('../lib.js');

// fwBox：傳入的行從第 8 行起
const FF = (a) => '/ip firewall filter add ' + a;
const EST = FF('action=accept chain=forward connection-state=established,related,untracked');
const INV = FF('action=drop chain=forward connection-state=invalid');
const pb = (s, chain) => S.query(s).policyBaseline('R').find((c) => c.chain === chain);
const lines = (f) => f.evidence.map((e) => e.line);

test('狀態式骨架：有 established 放行與 invalid 丟棄、最後全部丟棄時回程有保證，不報 F15', () => {
  const s = fwBox([EST, INV, FF('action=accept chain=forward in-interface-list=LAN'), FF('action=drop chain=forward')]);
  const c = pb(s, 'forward'); const Q = S.query(s);
  assert.deepStrictEqual([c.established.status, c.invalidDrop.status, c.invalidDrop.explicit, c.defaultAction.action, c.defaultAction.scope, c.returnSafe],
    ['accept', 'drop', true, 'drop', 'all', true]);
  assert.strictEqual(Q.getFirewallRule(c.established.rule).src[0][1], 8);
  assert.deepStrictEqual(c.src.map((x) => x[1]), [8, 9, 11]);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.established) && Object.isFrozen(c.src));
  assert.strictEqual(Q.policyBaseline('R'), Q.policyBaseline('R'), '同一台設備快取');
  assert.strictEqual(fws(s, 'F15').length, 0);
});

test('F15：forward 最後全部丟棄、沒有放行 established 時報，證據是那條 drop；invalid 由全部丟棄處理（explicit 為 false）', () => {
  const s = fwBox([FF('action=accept chain=forward connection-state=new in-interface-list=LAN'), FF('action=drop chain=forward')]);
  const c = pb(s, 'forward');
  assert.deepStrictEqual([c.established.status, c.invalidDrop.status, c.invalidDrop.explicit, c.defaultAction.action, c.returnSafe], ['drop', 'drop', false, 'drop', false]);
  const f = fws(s, 'F15');
  assert.deepStrictEqual(f.map((x) => [x.severity, lines(x), x.entities.map((e) => e.type)]), [['warn', [9], ['device', 'rule']]]);
  assert.ok(/IPv4 filter forward 沒有放行已建立的連線/.test(f[0].message) && /第 2 條/.test(f[0].message), f[0].message);
  assert.strictEqual(pb(s, 'input').returnSafe, true, 'input 沒有規則：預設放行');
});

test('F15：established 的放行排在全部丟棄之後（走不到），訊息與證據列出兩條', () => {
  const s = fwBox([FF('action=drop chain=input'), FF('action=accept chain=input connection-state=established,related')]);
  const c = pb(s, 'input');
  assert.deepStrictEqual([c.established.status, c.established.shadowed.length, c.returnSafe], ['drop', 1, false]);
  const f = fws(s, 'F15');
  assert.deepStrictEqual(f.map((x) => [lines(x), x.message.includes('input')]), [[[8, 9], true]]);
  assert.ok(/第 2 條排在它之後，走不到/.test(f[0].message), f[0].message);
});

test('F15：只以介面為條件的丟棄（drop all not coming from LAN）也算預設丟棄；沒有任何丟棄時預設放行、不報', () => {
  const s = fwBox([FF('action=accept chain=input protocol=icmp'), FF('action=drop chain=input in-interface-list=!LAN')]);
  const c = pb(s, 'input');
  assert.deepStrictEqual([c.established.status, c.defaultAction.action, c.defaultAction.scope, c.returnSafe], ['policy', 'drop', 'interface', false]);
  assert.deepStrictEqual(fws(s, 'F15').map((x) => lines(x)), [[9]]);
  // 預設 accept：只擋特定埠，回程本來就放行
  const open = fwBox([FF('action=drop chain=input dst-port=23 protocol=tcp'), FF('action=drop chain=forward connection-state=invalid')]);
  assert.deepStrictEqual(S.query(open).policyBaseline('R').map((x) => [x.chain, x.established.status, x.defaultAction.action, x.defaultAction.policy, x.returnSafe]),
    [['input', 'policy', 'accept', true, true], ['forward', 'policy', 'accept', true, true]]);
  assert.strictEqual(pb(open, 'forward').invalidDrop.status, 'drop');
  assert.strictEqual(fws(open, 'F15').length, 0);
  // 停用的 drop 不算
  assert.strictEqual(fws(fwBox([FF('action=drop chain=input disabled=yes')]), 'F15').length, 0);
});

test('狀態式骨架：established 的放行在 jump 進去的子 chain 裡也算；子 chain return 後才全部丟棄時仍報', () => {
  const ok = fwBox([FF('action=jump chain=forward jump-target=state'), FF('action=accept chain=state connection-state=established,related'),
    FF('action=drop chain=state connection-state=invalid'), FF('action=drop chain=forward')]);
  const c = pb(ok, 'forward'); const Q = S.query(ok);
  assert.deepStrictEqual([c.established.status, c.established.path.map((k) => Q.getFirewallRule(k).src[0][1]), c.invalidDrop.status, c.invalidDrop.explicit, c.returnSafe],
    ['accept', [8], 'drop', true, true]);
  assert.strictEqual(fws(ok, 'F15').length, 0);
  // 只對部分封包 jump：子 chain 的放行只算 conditional，不保證回程
  const cond = fwBox([FF('action=jump chain=forward in-interface-list=LAN jump-target=state'), FF('action=accept chain=state connection-state=established'),
    FF('action=drop chain=forward')]);
  const cc = pb(cond, 'forward');
  assert.deepStrictEqual([cc.established.status, cc.established.conditional.length, cc.returnSafe], ['drop', 1, false]);
  assert.ok(/只在部分條件下放行 established/.test(fws(cond, 'F15')[0].message));
  // 子 chain 先 return，回到 forward 後被丟棄
  const ret = fwBox([FF('action=jump chain=forward jump-target=state'), FF('action=return chain=state'), FF('action=accept chain=state connection-state=established'),
    FF('action=drop chain=forward')]);
  assert.strictEqual(pb(ret, 'forward').returnSafe, false);
});

test('狀態式骨架：fasttrack-connection 搭配 established 也算放行（hw-offload 不是比對條件）', () => {
  const s = fwBox([FF('action=fasttrack-connection chain=forward connection-state=established,related hw-offload=yes'), FF('action=drop chain=forward')]);
  const c = pb(s, 'forward');
  assert.deepStrictEqual([c.established.status, S.query(s).getFirewallRule(c.established.rule).action, c.returnSafe], ['accept', 'fasttrack-connection', true]);
  assert.strictEqual(fws(s, 'F15').length, 0);
});

test('F15：input 與 forward 各一筆，findingKey 不同（實體含決定丟棄的那條規則；同一個子 chain 被兩邊 jump 時是各自的 jump）', () => {
  const s = fwBox([FF('action=jump chain=input jump-target=deny'), FF('action=jump chain=forward jump-target=deny'), FF('action=drop chain=deny')]);
  const Q = S.query(s); const f = fws(s, 'F15');
  assert.strictEqual(f.length, 2);
  assert.strictEqual(new Set(f.map(Q.findingKey)).size, 2);
  assert.deepStrictEqual(f.map((x) => Q.getFirewallRule(x.entities[1].key).chain).sort(), ['forward', 'input']);
  assert.deepStrictEqual(f.map((x) => lines(x)).sort(), [[8, 10], [9, 10]]);
});

test('Q.policyBaseline：沒有 export 的設備為 null；IPv6 規則不影響 IPv4 的判斷', () => {
  const s = fwBox([FF('action=accept chain=forward connection-state=established'), '/ipv6 firewall filter add action=drop chain=forward']);
  assert.strictEqual(S.query(s).policyBaseline('NOPE'), null);
  assert.strictEqual(pb(s, 'forward').returnSafe, true);
  assert.strictEqual(fws(s, 'F15').length, 0);
});
