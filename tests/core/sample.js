// 範例資料的刻意問題、可重現、基準鍵 meta.baselineKey
'use strict';
const assert = require('assert');
const { S, read, build, count, test } = require('../lib.js');
// ------------------------------------------------------------------ 範例資料：每個刻意放入的問題都要被找到
test('範例資料：每項刻意放入的問題都被找到，且沒有多餘的錯誤', () => {
  const s = build(read('samples/sample-bundle.txt'));
  const expect = { I01: 1, I02: 1, C02: 1, K01: 1, K02: 1, K03: 1, K04: 1, V01: 1, V04: 1, V05: 1, V06: 1, V07: 1, A01: 1, A02: 1, A04: 1, A05: 1,
    A06: 1, A07: 1, A08: 1, A09: 1, A10: 1, A11: 1, A12: 1, R01: 2, R02: 1, R03: 1, R04: 1, R05: 1, R06: 1, C01: 3,
    V08: 1, F01: 1, F02: 1, F03: 1, F04: 1, F05: 1, F06: 1, F07: 1, F08: 1 };
  Object.entries(expect).forEach(([id, n]) => assert.strictEqual(count(s, id), n, `${id} 應有 ${n} 筆，實際 ${count(s, id)}`));
  assert.strictEqual(s.meta.stats.collected, 14);
  const css = s.model.inferredLinks.find((l) => l.a.startsWith('TPE_CSS_01|') || l.b.startsWith('TPE_CSS_01|'));
  assert.ok(css && css.confidence === 'high' && css.bases.join('+') === 'fdb+mndp-unique', '範例的 CSS610 應以 MAC 表＋MNDP 推論到 ACC_06 ether21');
  assert.deepStrictEqual(s.findings.filter((f) => f.severity === 'error').map((f) => f.id).sort(), ['I01']);
  assert.strictEqual(s.findings.find((f) => f.id === 'K02').severity, 'warn', 'K02 是警告：可能是鄰居表過時或中間有未管理交換器，不一定是資料矛盾');
  s.findings.forEach((f) => f.evidence.forEach((e) => assert.ok(typeof e.text === 'string')));
  const v01 = s.findings.find((f) => f.id === 'V01').entities.find((e) => e.type === 'link');
  assert.strictEqual(s.model.links.find((l) => l.key === v01.key).vlanComparable, true, 'vlanComparable 必須序列化，查詢層才能判斷是否可比對');
});
test('同樣輸入建立兩次，結果完全相同（建立時間除外）', () => {
  const a = build(read('samples/sample-bundle.txt')); const b = build(read('samples/sample-bundle.txt'));
  delete a.meta.timing; delete b.meta.timing;
  assert.deepStrictEqual(a, b);
});
test('鏈路配對：聚合成員雙向確認、沒有 LLDP 的鄰居為單側觀察', () => {
  const s = build(read('samples/sample-bundle.txt'));
  const l = s.model.links.find((x) => x.key === 'TPE_ACC_SW_01|sfp-sfpplus1~TPE_CORE_RT_01|sfp-sfpplus1');
  assert.ok(l && l.verified && l.cls === 'lag', JSON.stringify(l));
  assert.strictEqual(s.model.links.length, 78, 'OSPF adjacencies no longer count as direct topology links（78 含範例中 CSS610 的 MNDP 鏈路）');
  const ap = s.model.links.find((x) => x.key.includes('TPE_AP_01'));
  assert.ok(ap && ap.hearsay);
});

test('基準鍵 meta.baselineKey：由 inputHash、major.minor 版本、命名規則與預期資料組成；不含建立時間，鍵的順序不影響', () => {
  const text = read('samples/sample-bundle.txt');
  const prof = { id: 't', classify: [{ match: '_FW_', kind: 'firewall' }] };
  const key = (opt) => S.build([{ name: 't.txt', text }], Object.assign({ now: '2026-01-01T00:00:00Z' }, opt)).meta;
  const base = key();
  assert.ok(/^[0-9a-f]{16}$/.test(base.baselineKey) && base.baselineKey !== base.inputHash, base.baselineKey);
  const ver = S.VERSION.split('.').slice(0, 2).join('.');
  assert.strictEqual(base.baselineKey, S.util.hash(JSON.stringify([base.inputHash, ver, null, null])), '定義：[inputHash, major.minor, profileHash, expectedDataHash]');
  assert.strictEqual(key({ now: '2027-06-01T00:00:00Z' }).baselineKey, base.baselineKey, '建立時間不影響');
  const named = key({ profile: prof });
  assert.deepStrictEqual([named.inputHash === base.inputHash, named.baselineKey === base.baselineKey], [true, false], '換命名規則：輸入指紋不變、基準鍵不同');
  assert.strictEqual(key({ profile: { classify: prof.classify, id: 't' } }).baselineKey, named.baselineKey, '命名規則的鍵順序不影響');
  assert.notStrictEqual(key({ profile: { id: 't', classify: [{ match: '_RT_', kind: 'firewall' }] } }).baselineKey, named.baselineKey, '同一個 id 與 version、內容不同的命名規則要區分');
  const exp = key({ expectedData: { switch: ['lldp'], router: ['route'] } });
  assert.deepStrictEqual([exp.inputHash === base.inputHash, exp.baselineKey === base.baselineKey], [true, false], '換預期資料：基準鍵不同');
  assert.strictEqual(key({ expectedData: { router: ['route'], switch: ['lldp'] } }).baselineKey, exp.baselineKey, '預期資料的鍵順序不影響');
});
