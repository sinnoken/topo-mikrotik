// 命名規則
'use strict';
const assert = require('assert');
const { S, read, build, test } = require('../lib.js');
// ------------------------------------------------------------------ 命名規則（可獨立、可跳過）
test('不套用命名規則時，設備類型只看資料，不看名稱', () => {
  const s = build('MY_FW_LIKE_NAME (10.0.0.1):\n### /interface bridge host print detail\n 0 D mac-address=AA:BB:CC:00:00:01 on-interface=ether1 bridge=bridge1 vid=10\n');
  assert.strictEqual(s.model.devices[0].kind, 'switch');
  assert.strictEqual(s.meta.profile, null);
});
test('自動連通元件群組使用不誤稱 IP 子網的名稱', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface bridge host print detail\n'
    + ' 0 D mac-address=AA:BB:CC:00:00:01 on-interface=ether1 bridge=bridge1 vid=10\n');
  assert.strictEqual(s.model.devices[0].component, 1);
  assert.strictEqual(s.model.devices[0].group, '自動群組 1');
});
test('命名規則：別名合併、去網域、分類、分群；只加註解不改事實', () => {
  const prof = { id: 't', classify: [{ match: '_FW_', kind: 'firewall', role: 'fw' }], group: { match: '^([A-Z]+)_', value: '$1' }, alias: { 'OLD-SW': 'SW_A' }, stripDomain: true };
  const text = 'SW_A (10.0.0.1):\n### /ip neighbor print detail\n 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=TPE_FW_01.corp.local interface-name=port1\n 1 interface=ether2 mac-address=AA:00:00:00:00:02 identity=old-sw interface-name=x\n';
  const a = build(text); const b = build(text, { profile: prof });
  assert.ok(b.model.devices.some((d) => d.key === 'TPE_FW_01' && d.kind === 'firewall' && d.kindBasis === 'profile' && d.group === 'TPE'));
  assert.ok(!b.model.devices.some((d) => d.key === 'OLD-SW'), '別名應合併');
  assert.strictEqual(a.model.devices.length, 3);
  assert.deepStrictEqual(b.meta.profile, { id: 't', version: '1' });
});
test('命名規則有錯時明確回報錯誤', () => {
  assert.throws(() => S.profile.compile({ id: 'x', classify: [{ match: '(' }] }), /正規表示式/);
});
test('附帶的命名規則檔可載入', () => {
  const vm = require('vm');
  vm.runInThisContext(read('profiles/site-naming.js'));
  const p = S.profiles['site-naming'];
  assert.ok(p && S.profile.compile(p));
  const base = build(read('samples/sample-bundle.txt'));
  const s = build(read('samples/sample-bundle.txt'), { profile: p });
  assert.ok(s.model.devices.filter((d) => d.group === 'TPE').length >= 14);
  // 範例的設備名是「站點_層級_類型_編號」：類型要依第三段判斷，不可因層級 CORE 把路由器判成交換器
  const kind = (snap, k) => snap.model.devices.find((d) => d.key === k).kind;
  ['TPE_CORE_RT_01', 'TPE_CORE_RT_02', 'TPE_ACC_SW_01'].forEach((k) => assert.strictEqual(kind(s, k), kind(base, k), `${k} 的類型不應被命名規則改錯`));
  assert.deepStrictEqual([kind(s, 'TPE_CORE_RT_01'), s.model.devices.find((d) => d.key === 'TPE_CORE_RT_01').role], ['router', 'CORE']);
  assert.deepStrictEqual(s.findings.filter((f) => f.id === 'C02').map((f) => f.message), base.findings.filter((f) => f.id === 'C02').map((f) => f.message), '套用內建規則不應改變應收集的資料');
  const c = S.profile.compile(p);
  assert.deepStrictEqual([c.annotate('TPE_FW_01').kind, c.annotate('TPE_RT_01').kind, c.annotate('TPE_DIST_01').kind], ['firewall', 'router', 'switch'], '相容三段名稱');
});
test('附帶的 JSON 命名規則範例可載入，分隔符號 _ 與 - 一致處理', () => {
  const c = S.profile.compile(JSON.parse(read('profiles/floor-device-naming.json')));
  const at = (n) => c.annotate(n);
  [['3F_hAP', { role: 'AP', group: '3F', label: 'hAP' }], ['3F-hAP_02', { role: 'AP', group: '3F', label: 'hAP_02' }],
    ['2F-RB5009', { kind: 'router', role: 'RTR', group: '2F', label: 'RB5009' }], ['2F_RB5009_02', { kind: 'router', role: 'RTR', group: '2F', label: 'RB5009_02' }],
    ['B1F_wAP_02', { role: 'AP', group: 'B1F', label: 'wAP_02' }], ['3F_CRS326', { group: '3F', label: 'CRS326' }]]
    .forEach(([n, want]) => assert.deepStrictEqual(at(n), want, n));
});
