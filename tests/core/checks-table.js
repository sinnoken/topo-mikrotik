// 檢查的規則表（src/check/checks.js 的 S.check.RULES）：每個 CATALOG id 恰好有一個負責函式、沒有孤兒，表依 CATALOG 順序
'use strict';
const assert = require('assert');
const { S, test, sampleSnap } = require('../lib.js');

test('規則表：每個 CATALOG id 恰好屬於一個具名函式，沒有 CATALOG 以外的 id，依 CATALOG 順序', () => {
  const { RULES, CATALOG } = S.check;
  const ids = Object.keys(CATALOG);
  const rank = new Map(ids.map((id, n) => [id, n]));
  const owner = new Map();
  RULES.forEach((r) => {
    assert.ok(typeof r.fn === 'function' && r.fn.name && r.name === r.fn.name, `規則表的每一筆要是具名函式：${r.name}`);
    assert.ok(r.ids.length > 0, `${r.name} 沒有負責任何 id`);
    r.ids.forEach((id) => {
      assert.ok(rank.has(id), `${r.name} 負責的 ${id} 不在 CATALOG`);
      assert.ok(!owner.has(id), `${id} 同時屬於 ${owner.get(id)} 與 ${r.name}`);
      owner.set(id, r.name);
    });
    assert.deepStrictEqual(r.ids.slice().sort((a, b) => rank.get(a) - rank.get(b)), r.ids.slice(), `${r.name} 的 id 要依 CATALOG 順序`);
  });
  assert.deepStrictEqual(ids.filter((id) => !owner.has(id)), [], '每個 CATALOG id 都要有負責的函式');
  const firsts = RULES.map((r) => rank.get(r.ids[0]));
  assert.deepStrictEqual(firsts, firsts.slice().sort((a, b) => a - b), '規則表要依各筆第一個 id 的 CATALOG 順序排列');
  assert.strictEqual(new Set(RULES.map((r) => r.name)).size, RULES.length, '函式名稱不重複');
  assert.ok(Object.isFrozen(RULES) || RULES.every(Object.isFrozen), '規則表的每一筆不可在執行期改動');
});

test('規則表：範例資料中每一筆規則都有產生 finding（表與函式確實接上）', () => {
  const found = new Set(sampleSnap().findings.map((f) => f.id));
  const idle = S.check.RULES.filter((r) => !r.ids.some((id) => found.has(id))).map((r) => r.name);
  assert.deepStrictEqual(idle, [], '範例資料刻意含每一種問題，沒有產生任何 finding 的規則可能沒有接上');
});
