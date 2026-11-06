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
  assert.strictEqual(s.model.devices[0].group, '分群 1');
});
test('命名規則：別名合併、去網域、分類、分群；只加註解不改事實', () => {
  const prof = { id: 't', classify: [{ match: '_FW_', kind: 'firewall', role: 'fw' }], group: { match: '^([A-Z]+)_', value: '$1' }, alias: { 'OLD-SW': 'SW_A' }, stripDomain: true };
  const text = 'SW_A (10.0.0.1):\n### /ip neighbor print detail\n 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=TPE_FW_01.corp.local interface-name=port1\n 1 interface=ether2 mac-address=AA:00:00:00:00:02 identity=old-sw interface-name=x\n';
  const a = build(text); const b = build(text, { profile: prof });
  assert.ok(b.model.devices.some((d) => d.key === 'TPE_FW_01' && d.kind === 'firewall' && d.kindBasis === 'profile' && d.group === 'TPE'));
  assert.ok(!b.model.devices.some((d) => d.key === 'OLD-SW'), '別名應合併');
  assert.strictEqual(a.model.devices.length, 3);
  assert.deepStrictEqual(b.meta.profile, { id: 't', version: '1', hash: S.profile.hash(prof) });
  assert.notStrictEqual(build(text, { profile: Object.assign({}, prof, { stripDomain: false }) }).meta.profile.hash, b.meta.profile.hash, '同一個 id 與 version、內容不同：雜湊不同');
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
  // 規則名稱在 name，顯示名稱規則在 label：兩者都要留下（字串 label 與 label 規則並存時 JSON.parse 只留後者）
  const text = read('profiles/floor-device-naming.json');
  assert.strictEqual(c.name, '樓層_設備型號_編號（例：3F_hAP_01、B1F-RB5009）');
  assert.strictEqual(S.profile.nameOf(JSON.parse(text)), c.name);
  assert.deepStrictEqual(S.profile.parse(text), JSON.parse(text), '範本沒有重複的鍵');
  assert.strictEqual(S.profile.compile(text).name, c.name, 'compile 也接受文字（經 parse）');
  assert.strictEqual(S.profile.describe(JSON.parse(text)), '去掉網域、分類規則 2 條、分群、顯示名稱');
});
test('命名規則的名稱：name 優先，舊寫法的字串 label 仍可用；物件的 label 不是名稱', () => {
  const vm = require('vm');
  vm.runInThisContext(read('profiles/site-naming.js'));
  const site = S.profiles['site-naming'];
  assert.strictEqual(S.profile.compile(site).name, site.label, '內建規則仍以字串 label 當名稱');
  assert.strictEqual(S.profile.compile(site).annotate('TPE_CORE_RT_01').label, undefined, '字串 label 不是顯示名稱規則');
  assert.strictEqual(S.profile.nameOf({ id: 'x', name: ' 名稱 ' }), '名稱');
  assert.strictEqual(S.profile.nameOf({ id: 'x', label: { match: '(.*)' } }), null);
  assert.strictEqual(S.profile.nameOf({ id: 'x' }), null);
  assert.strictEqual(S.profile.compile({ id: 'x', name: 'n', label: { match: '^A_(.+)$' } }).annotate('A_B').label, 'B');
});
test('命名規則：名稱與顯示名稱規則衝突時明確回報錯誤', () => {
  // JSON 文字中同一個物件有重複的鍵：parse／compile(文字) 丟錯並列出位置，不靜默留下最後一個
  const dup = '{ "id": "x", "label": "名稱", "classify": [{ "match": "a", "role": "R", "role": "S" }], "label": { "match": "(.*)" } }';
  assert.throws(() => S.profile.parse(dup), (e) => /重複的鍵「label」/.test(e.message) && /重複的鍵「classify\[0\]\.role」/.test(e.message));
  assert.throws(() => S.profile.compile(dup), /重複的鍵「label」/);
  assert.throws(() => S.profile.parse('{ nope'), SyntaxError);
  // 字串裡的括號、跳脫的引號不影響判斷；不同物件的同名鍵不算重複
  assert.doesNotThrow(() => S.profile.parse('{ "id": "a\\"{,", "group": { "match": "[{]", "value": "$1" }, "label": { "match": "x", "value": "$1" } }'));
  // 物件形式：name 與字串 label 並存、label 型別不對、name 不是字串
  assert.throws(() => S.profile.compile({ id: 'x', name: 'n', label: '名稱' }), /同時有 name 與字串的 label/);
  assert.throws(() => S.profile.compile({ id: 'x', label: ['a'] }), /label 必須是/);
  assert.throws(() => S.profile.compile({ id: 'x', label: 3 }), /label 必須是/);
  assert.throws(() => S.profile.compile({ id: 'x', name: 3 }), /name（規則名稱）必須是字串/);
});
// ------------------------------------------------------------------ 套用結果（設定畫面的「命名規則」）：只讀 Q，不改寫基準
test('命名規則套用結果：對上台數、沒對上的名稱與各欄位分布；可重現、不改寫基準', () => {
  const prof = { id: 'cov', version: '3', classify: [{ match: '_FW_', kind: 'firewall', role: 'FW' }, { match: '^([A-Z]+)_SW_', role: 'SW', site: '$1' }],
    group: { match: '^([A-Z]+)_', value: '$1' }, alias: { 'OLD-SW': 'TPE_SW_09' }, stripDomain: true };
  const text = 'TPE_SW_01 (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=TPE_FW_01.corp.local interface-name=port1\n'
    + ' 1 interface=ether2 mac-address=AA:00:00:00:00:02 identity=old-sw interface-name=x\n'
    + ' 2 interface=ether3 mac-address=AA:00:00:00:00:03 identity=lab-box interface-name=y\n';
  const snap = build(text); const Q = S.query(snap); const before = JSON.stringify(snap);
  const c = S.profile.coverage(prof, Q);
  assert.strictEqual(JSON.stringify(snap), before, '統計不可改寫基準');
  assert.deepStrictEqual(c, S.profile.coverage(JSON.parse(JSON.stringify(prof)), S.query(build(text))), '相同輸入得到相同結果');
  assert.strictEqual(c.total, 4); assert.strictEqual(c.matched, 3);
  assert.deepStrictEqual(c.collected, { total: 1, matched: 1 });
  // 名稱先經這份規則的 alias／stripDomain（canon），再比對；沒對上的列出基準中的名稱
  assert.deepStrictEqual(c.unmatched, [{ key: 'LAB-BOX', name: 'lab-box', collected: false }]);
  assert.deepStrictEqual(c.renamed.map((r) => [r.name, r.canon]), [['old-sw', 'TPE_SW_09'], ['TPE_FW_01.corp.local', 'TPE_FW_01']].sort((a, b) => S.util.natural(a[0], b[0])));
  assert.deepStrictEqual(c.fields.kind, [{ value: 'firewall', count: 1 }]);
  assert.deepStrictEqual(c.fields.group, [{ value: 'TPE', count: 3 }]);
  assert.deepStrictEqual(c.fields.site, [{ value: 'TPE', count: 2 }]);
  assert.deepStrictEqual(c.fields.role, [{ value: 'SW', count: 2 }, { value: 'FW', count: 1 }], '依台數多到少，同數依名稱');
  assert.deepStrictEqual(c.fields.label, []);
  assert.strictEqual(c.applied, false, '建立基準時沒有套用這份規則');
  // 用這份規則建立的基準：applied 為 true；同 id 但內容不同：false
  const s2 = build(text, { profile: prof });
  assert.strictEqual(S.profile.coverage(prof, S.query(s2)).applied, true);
  assert.strictEqual(S.profile.coverage(Object.assign({}, prof, { stripDomain: false }), S.query(s2)).applied, false);
  // 編譯後的物件也有同一個函式（畫面只用 S.profile.compile）
  assert.deepStrictEqual(S.profile.compile(prof).coverage(Q), c);
  assert.throws(() => S.profile.coverage({ classify: [] }, Q), /缺少 id/, '規則有錯時丟出 compile 的錯誤');
  assert.throws(() => S.profile.coverage(prof, null), TypeError, '沒有基準時明確丟錯');
});
test('命名規則的說明：有 description 用它，沒有時依規則內容推出一句', () => {
  assert.strictEqual(S.profile.describe({ id: 'x', description: '我的規則' }), '我的規則');
  assert.strictEqual(S.profile.describe({ id: 'x', classify: [{ match: 'a' }, { match: 'b' }], group: { match: '^(.)' }, alias: { A: 'B' }, stripDomain: true }),
    '去掉網域、別名 1 個、分類規則 2 條、分群');
  assert.strictEqual(S.profile.describe({ id: 'x', zones: [{ on: 'vlan', match: '1', zone: 'Z' }], label: { match: '(.*)' } }), '顯示名稱、zone 標籤 1 條');
  assert.strictEqual(S.profile.describe({ id: 'x' }), '沒有任何規則（只記錄 id）');
  assert.strictEqual(S.profile.describe({ id: 'x', label: '名稱', group: { match: '(.)' } }), '分群', '字串的 label 是名稱，不是顯示名稱規則');
  assert.strictEqual(S.profile.compile({ id: 'x', description: 'd' }).describe(), 'd');
});
