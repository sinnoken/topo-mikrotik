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
// dst-nat 規則（action=dst-nat；IPv6 的欄位是 to-address）。放在最後，不改變前面規則的行號。
// 依據：https://manual.mikrotik.com/docs/cli-reference/ip/firewall/nat.md、https://manual.mikrotik.com/docs/cli-reference/ipv6/firewall/nat.md
// 目前不讀 /ipv6 firewall nat（docs/基準檢查.md 防火牆章），所以 IPv6 的 dstnat 狀態無法確認，F16 的 IPv6 部分不報。
const NAT4 = '/ip firewall nat add action=dst-nat chain=dstnat dst-port=8080 in-interface-list=WAN protocol=tcp to-addresses=10.0.0.20 to-ports=80';
const NAT6 = '/ipv6 firewall nat add action=dst-nat chain=dstnat dst-port=8080 in-interface-list=WAN protocol=tcp to-address=fd00::20/128 to-ports=80';
const box = (rules, opt) => fwBox([...rules, NAT4], opt);

test('F16：整批放行 dst-nat 之後還有從 WAN 進來、以目的埠或目的位址限制的規則時報，列出被架空的規則', () => {
  const s = box([FF(EST), FF(DEFCONF_DROP), FF('action=accept chain=forward connection-nat-state=dstnat'),
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
  assert.strictEqual(fws(box([FF(EST), FF('action=accept chain=forward connection-nat-state=dstnat connection-state=new'), ...tail]), 'F16').length, 1);
  assert.strictEqual(fws(box([FF(EST), FF('action=accept chain=forward connection-nat-state=dstnat connection-state=!new'), ...tail]), 'F16').length, 0);
});

test('F16：defconf 的「drop connection-nat-state=!dstnat」不報', () => {
  const s = box([FF(EST), FF('action=drop chain=forward connection-state=invalid'), FF(DEFCONF_DROP),
    FF('action=accept chain=forward dst-port=443 in-interface-list=WAN protocol=tcp')]);
  assert.strictEqual(fws(s, 'F16').length, 0);
});

test('F16：整批放行之後沒有逐埠規則時不報', () => {
  const s = box([FF(EST), FF(DEFCONF_DROP), FF('action=accept chain=forward connection-nat-state=dstnat'), FF('action=drop chain=forward in-interface-list=WAN')]);
  assert.strictEqual(fws(s, 'F16').length, 0);
});

test('F16：逐埠規則排在整批放行之前時不報（走得到的位置在前）', () => {
  const s = box([FF(EST), FF('action=drop chain=forward dst-port=445 protocol=tcp'), FF('action=accept chain=forward connection-nat-state=dstnat')]);
  assert.strictEqual(fws(s, 'F16').length, 0);
});

test('F16：整批放行帶 in-interface／in-interface-list 限制時不報', () => {
  const tail = [FF('action=drop chain=forward dst-port=445 in-interface-list=WAN protocol=tcp')];
  assert.strictEqual(fws(box([FF(EST), FF('action=accept chain=forward connection-nat-state=dstnat in-interface=ether1'), ...tail]), 'F16').length, 0);
  assert.strictEqual(fws(box([FF(EST), FF('action=accept chain=forward connection-nat-state=dstnat in-interface-list=WAN'), ...tail]), 'F16').length, 0);
});

test('F16：該位址族沒有啟用中的 dst-nat／redirect／netmap 時不報（IPv4）', () => {
  const v4 = [FF(EST), FF('action=accept chain=forward connection-nat-state=dstnat'), FF('action=drop chain=forward dst-port=445 in-interface-list=WAN protocol=tcp')];
  assert.strictEqual(fws(fwBox(v4), 'F16').length, 0, '沒有 nat 規則');
  assert.strictEqual(fws(fwBox([...v4, '/ip firewall nat add action=masquerade chain=srcnat out-interface-list=WAN']), 'F16').length, 0, '只有 masquerade');
  assert.strictEqual(fws(fwBox([...v4, '/ip firewall nat add action=dst-nat chain=dstnat disabled=yes dst-port=8080 protocol=tcp to-addresses=10.0.0.20']), 'F16').length, 0, '停用的 dst-nat');
  assert.strictEqual(fws(fwBox([...v4, NAT6]), 'F16').length, 0, '只有 IPv6 的 dst-nat');
  assert.strictEqual(fws(fwBox([...v4, '/ip firewall nat add action=redirect chain=dstnat dst-port=53 protocol=udp to-ports=53']), 'F16').length, 1, 'redirect 也會讓 dstnat 成立');
  assert.strictEqual(fws(fwBox([...v4, '/ip firewall nat add action=netmap chain=dstnat dst-address=203.0.113.0/24 to-addresses=10.0.0.0/24']), 'F16').length, 1, 'netmap 也會讓 dstnat 成立');
});

test('F16：IPv6 沒有讀到 dst-nat 規則時不報（IPv4 的 dst-nat 不算；目前不讀 /ipv6 firewall nat）', () => {
  const v6 = [F6(EST), F6('action=accept chain=forward connection-nat-state=dstnat'), F6('action=drop chain=forward dst-port=445 protocol=tcp')];
  assert.strictEqual(fws(fwBox(v6), 'F16').length, 0, '沒有 nat 規則');
  assert.strictEqual(fws(fwBox([...v6, NAT4]), 'F16').length, 0, '只有 IPv4 的 dst-nat：IPv6 的 dstnat 狀態不會成立');
  assert.strictEqual(fws(fwBox([...v6, NAT6]), 'F16').length, 0, '/ipv6 firewall nat 不在基準中，無法確認有 dst-nat');
});

test('F16：沒有 WAN 入口時只看不限入介面的規則', () => {
  const rules = [FF(EST), FF('action=accept chain=forward connection-nat-state=dstnat'),
    FF('action=drop chain=forward dst-port=445 in-interface=ether1 protocol=tcp'), FF('action=drop chain=forward dst-port=23 protocol=tcp')];
  const f = fws(box(rules, { emptyWan: true }), 'F16');
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual(lines(f[0]), [8, 10], 'emptyWan 少一行 WAN 成員，規則從第 7 行起');
});
