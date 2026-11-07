// F16：forward 整批放行經 dst-nat 的連線（connection-nat-state=dstnat），之後的逐埠限制對轉送進來的連線不起作用
// 依據：https://manual.mikrotik.com/docs/cli-reference/ip/firewall/filter.md（connection-nat-state、first-match 的比對順序）
// 測試資料依手冊的 /ip firewall filter 語法手寫，不是實機擷取
'use strict';
const assert = require('assert');
const { test, fwBox, fws } = require('../lib.js');

// fwBox：傳入的行從第 8 行起；ether1 是 WAN 清單的成員
const FF = (a) => '/ip firewall filter add ' + a;
const F6 = (a) => '/ipv6 firewall filter add ' + a;
const EST = 'action=accept chain=forward connection-state=established,related,untracked';
const DEFCONF_DROP = 'action=drop chain=forward connection-nat-state=!dstnat connection-state=new in-interface-list=WAN';
const lines = (f) => f.evidence.map((e) => e.line);

test('F16：整批放行 dst-nat 之後還有從 WAN 進來、以目的埠或目的位址限制的規則時報，列出被架空的規則', () => {
  const s = fwBox([FF(EST), FF(DEFCONF_DROP), FF('action=accept chain=forward connection-nat-state=dstnat'),
    FF('action=accept chain=forward dst-address=10.0.0.20 dst-port=22 in-interface-list=WAN protocol=tcp'),
    FF('action=drop chain=forward dst-port=445 protocol=tcp'),
    FF('action=accept chain=forward dst-port=80 in-interface-list=LAN protocol=tcp'), // 從 LAN 進來：不是對外入口，不列
    FF('action=drop chain=forward in-interface-list=WAN')]); // 沒有限制埠或位址：不列
  const f = fws(s, 'F16');
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].severity, 'warn');
  assert.deepStrictEqual(lines(f[0]), [10, 11, 12]);
  assert.deepStrictEqual(f[0].entities.map((e) => e.type), ['device', 'rule']);
  assert.ok(/IPv4 filter forward 第 3 條（accept connection-nat-state=dstnat）/.test(f[0].message), f[0].message);
  assert.ok(/之後 2 條/.test(f[0].message) && /第 4 條/.test(f[0].message) && /第 5 條/.test(f[0].message), f[0].message);
  assert.ok(/L4 的「從外部進來」第 2 段/.test(f[0].message), f[0].message);
  assert.strictEqual(f[0].facet, undefined);
});

test('F16：放行另帶不排除 new 的 connection-state 時仍報；排除 new 時不報', () => {
  const tail = [FF('action=drop chain=forward dst-port=445 protocol=tcp')];
  assert.strictEqual(fws(fwBox([FF(EST), FF('action=accept chain=forward connection-nat-state=dstnat connection-state=new'), ...tail]), 'F16').length, 1);
  assert.strictEqual(fws(fwBox([FF(EST), FF('action=accept chain=forward connection-nat-state=dstnat connection-state=!new'), ...tail]), 'F16').length, 0);
});

test('F16：defconf 的「drop connection-nat-state=!dstnat」不報', () => {
  const s = fwBox([FF(EST), FF('action=drop chain=forward connection-state=invalid'), FF(DEFCONF_DROP),
    FF('action=accept chain=forward dst-port=443 in-interface-list=WAN protocol=tcp')]);
  assert.strictEqual(fws(s, 'F16').length, 0);
});

test('F16：整批放行之後沒有逐埠規則時不報', () => {
  const s = fwBox([FF(EST), FF(DEFCONF_DROP), FF('action=accept chain=forward connection-nat-state=dstnat'), FF('action=drop chain=forward in-interface-list=WAN')]);
  assert.strictEqual(fws(s, 'F16').length, 0);
});

test('F16：逐埠規則排在整批放行之前時不報（走得到的位置在前）', () => {
  const s = fwBox([FF(EST), FF('action=drop chain=forward dst-port=445 protocol=tcp'), FF('action=accept chain=forward connection-nat-state=dstnat')]);
  assert.strictEqual(fws(s, 'F16').length, 0);
});

test('F16：整批放行帶 in-interface／in-interface-list 限制時不報', () => {
  const tail = [FF('action=drop chain=forward dst-port=445 in-interface-list=WAN protocol=tcp')];
  assert.strictEqual(fws(fwBox([FF(EST), FF('action=accept chain=forward connection-nat-state=dstnat in-interface=ether1'), ...tail]), 'F16').length, 0);
  assert.strictEqual(fws(fwBox([FF(EST), FF('action=accept chain=forward connection-nat-state=dstnat in-interface-list=WAN'), ...tail]), 'F16').length, 0);
});

test('F16：IPv6 filter 也適用，訊息寫 IPv6', () => {
  const s = fwBox([F6(EST), F6('action=accept chain=forward connection-nat-state=dstnat'), F6('action=accept chain=forward dst-port=443 protocol=tcp')]);
  const f = fws(s, 'F16');
  assert.strictEqual(f.length, 1);
  assert.ok(/IPv6 filter forward 第 2 條/.test(f[0].message), f[0].message);
  assert.deepStrictEqual(lines(f[0]), [9, 10]);
});

test('F16：沒有 WAN 入口時只看不限入介面的規則', () => {
  const rules = [FF(EST), FF('action=accept chain=forward connection-nat-state=dstnat'),
    FF('action=drop chain=forward dst-port=445 in-interface=ether1 protocol=tcp'), FF('action=drop chain=forward dst-port=23 protocol=tcp')];
  const f = fws(fwBox(rules, { emptyWan: true }), 'F16');
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual(lines(f[0]), [8, 10], 'emptyWan 少一行 WAN 成員，規則從第 7 行起');
});
