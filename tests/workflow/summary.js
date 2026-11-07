// 主管摘要（S.report.managerSummary）：分級沿用嚴重度；從外部進得來的是暴露清單（推論）；需要決定的事與處理順序來自 S.remediate 的等級
'use strict';
const assert = require('assert');
const { S, build, test, sampleSnap } = require('../lib.js');

const R = () => S.report;
const section = (md, title) => {
  const at = md.indexOf(`\n## ${title}`); assert.ok(at >= 0, `應有「${title}」一段`);
  const next = md.indexOf('\n## ', at + 1);
  return md.slice(at, next < 0 ? md.length : next);
};
// 只有一台設備、沒有 WAN 的小基準
const tiny = () => build(['R (10.0.0.1):', '### /system identity print', 'name: R'].join('\n'));

test('主管摘要：範例資料寫出三種嚴重度的計數、暴露清單三段（推論）、需要決定的事與處理順序', () => {
  const Q = S.query(sampleSnap()); const md = R().managerSummary(Q);
  const st = Q.meta().stats.findings;
  assert.ok(md.startsWith('# 主管摘要\n'));
  assert.ok(section(md, '整體狀態').includes(`檢查結果：錯誤 ${st.error}、警告 ${st.warn}、提醒 ${st.info}`));
  const ex = Q.exposure(); const exMd = section(md, '從外部進得來的（推論）');
  const allow = ex.self.counts.allow + ex.dnat.counts.allow + ex.routed.counts.allow;
  assert.ok(exMd.includes(`從外部連得到 ${allow} 個組合`), '結論句的數字來自 Q.exposure 的三段計數');
  [['網路設備本身', 'self'], ['經 dst-nat 轉送到內部', 'dnat'], ['直接路由到內部', 'routed']].forEach(([name, k]) => {
    const c = ex[k].counts;
    assert.ok(exMd.includes(`- ${name}：允許 ${c.allow}、無法判斷 ${c.unknown}、拒絕 ${c.deny}。`), `${name} 的計數`);
  });
  assert.ok(exMd.includes(`前提有 ${ex.assumptions.length} 條`));
  const nat = ex.dnat.rows.find((r) => r.verdict === 'allow');
  assert.ok(nat && exMd.includes(`${nat.nat.from} → ${nat.nat.to}`), 'dst-nat 的列寫出公網與內部位址');
  // 需要決定的事：每項 choice 等級的待處理檢查都列出；A12 附 S.remediate.plan 的選項
  const dec = section(md, '需要決定的事');
  S.util.uniq(Q.findings().filter((f) => S.remediate.levelOf(f.id) === 'choice').map((f) => f.id)).forEach((id) => assert.ok(dec.includes(`\n- ${id} `), `${id} 應列入需要決定的事`));
  const plan = S.remediate.plan(Q, { ids: ['A12'] });
  assert.ok(plan.choices.length, '範例資料要有 A12');
  plan.choices.forEach((c) => c.options.forEach((o) => assert.ok(dec.includes(`選項：${R().mdText(o.label)}`), `A12 的選項 ${o.id}`)));
  // 處理順序：依嚴重度，同一級裡 auto → choice → manual；筆數合計等於待處理的全部
  const order = section(md, '建議的處理順序').split('\n').filter((l) => /^\d+\. /.test(l));
  const rank = (l) => { const m = l.match(/^\d+\. (錯誤|警告|提醒)・(可直接產生修正指令|要先選擇處理方式|需要人工判斷)（(\d+) 筆）/); assert.ok(m, l); return { k: ['錯誤', '警告', '提醒'].indexOf(m[1]) * 3 + ['可直接產生修正指令', '要先選擇處理方式', '需要人工判斷'].indexOf(m[2]), n: +m[3] }; };
  const ranks = order.map(rank);
  assert.ok(ranks.every((x, i) => !i || ranks[i - 1].k < x.k), '依嚴重度與等級排序');
  assert.strictEqual(ranks.reduce((n, x) => n + x.n, 0), Q.findings().length);
  assert.ok(!/工時|分鐘|小時|評分/.test(md), '不估工時、不評分');
});

test('主管摘要：重點只列待處理的錯誤與警告，依嚴重度再依設備；超過 limit 寫「另有」；處理紀錄改變計數', () => {
  const Q = S.query(sampleSnap());
  const key = (md) => section(md, '錯誤與警告的重點').split('\n').filter((l) => l.startsWith('- **'));
  const md = R().managerSummary(Q, { limit: 3 });
  const lines = key(md);
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[0].startsWith('- **錯誤** '), '錯誤排在最前');
  const total = Q.findings().filter((f) => f.severity !== 'info').length;
  assert.ok(md.includes(`- 另有 ${total - 3} 筆`));
  assert.ok(R().managerSummary(Q, { limit: 1000 }).includes('（從外部連得到，推論）'), '範例資料至少有一筆從外部連得到');
  // 標成已修好的錯誤不再列入重點，待處理的計數減少
  const err = Q.findings().find((f) => f.severity === 'error');
  const lgOf = (f) => (f === err ? { status: 'fixed', at: null, note: '', waiver: null } : null);
  const md2 = R().managerSummary(Q, { limit: 3, ledgerOf: lgOf });
  assert.ok(!key(md2)[0].startsWith('- **錯誤** '));
  assert.ok(md2.includes(`待處理：錯誤 ${Q.meta().stats.findings.error - 1}、`));
  assert.ok(md2.includes('另有已處理的錯誤與警告 1 筆'));
  assert.throws(() => R().managerSummary(Q, { limit: -1 }), TypeError);
  assert.throws(() => R().managerSummary(Q, { exposureLimit: 1.5 }), TypeError);
});

test('主管摘要：有上一輪基準時依 S.compare.snapshots 寫變好、變差或沒有變化', () => {
  const qs = S.query(sampleSnap()); const qt = S.query(tiny());
  const worse = R().managerSummary(qs, { previous: qt });
  const d = S.compare.snapshots(qt, qs);
  const added = d.items.filter((x) => x.category === 'finding' && x.change === 'added' && x.after.severity !== 'info').length;
  const removed = d.items.filter((x) => x.category === 'finding' && x.change === 'removed' && x.before.severity !== 'info').length;
  assert.ok(added > removed, '測試前提：範例資料比小基準多錯誤與警告');
  assert.ok(worse.includes(`錯誤與警告新出現 ${added} 筆、已消失 ${removed} 筆：變差。`));
  assert.ok(R().managerSummary(qt, { previous: qs }).includes('：變好。'));
  assert.ok(R().managerSummary(qs, { previous: qs }).includes('新出現 0 筆、已消失 0 筆：沒有變化。'));
  assert.ok(!R().managerSummary(qs).includes('上一輪'), '沒有上一輪基準時不寫變化');
});

test('主管摘要：沒有 WAN 時寫出暴露清單的原因；傳入已算好的 exposure 結果相同；可重現', () => {
  const Q = S.query(tiny()); const ex = Q.exposure();
  assert.notStrictEqual(ex.status, 'ok');
  const md = R().managerSummary(Q);
  assert.ok(section(md, '從外部進得來的（推論）').includes(R().mdText(ex.message || '無法判斷從外部進得來什麼。')));
  const Qs = S.query(sampleSnap());
  const a = R().managerSummary(Qs);
  assert.strictEqual(R().managerSummary(Qs, { exposure: Qs.exposure() }), a);
  assert.strictEqual(R().managerSummary(S.query(sampleSnap())), a, '同輸入同輸出');
});
