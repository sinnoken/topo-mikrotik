// 主管摘要（S.report.managerSummary）：只看方向——第一行是錯誤與警告的結論，外部只寫 Q.exposureSummary 的結論句，其餘每段一句，不列逐列明細
'use strict';
const assert = require('assert');
const { S, build, test, sampleSnap } = require('../lib.js');

const R = () => S.report;
const ID = ['R (10.0.0.1):', '### /system identity print', 'name: R'].join('\n');
// 只有一台設備、沒有 WAN 的小基準：警告 1（C02 缺少應收集的資料）
const tiny = () => build(ID);
// 同一台設備、不要求任何資料：沒有錯誤與警告
const clean = () => build(ID, { expectedData: { router: [], switch: [], host: [] } });
const lines = (md) => md.split('\n');
const bullets = (md) => lines(md).filter((l) => /^\s*- /.test(l));
const catOf = (f) => S.query.rule(f.id).cat;

test('主管摘要：範例資料第一行是錯誤與警告的結論，外部只寫 Q.exposureSummary 的結論句，各段數字與資料一致', () => {
  const Q = S.query(sampleSnap()); const md = R().managerSummary(Q);
  const st = Q.meta().stats.findings; const ew = Q.findings().filter((f) => f.severity !== 'info');
  assert.ok(st.error + st.warn > 0, '測試前提：範例資料有錯誤與警告');
  const ls = lines(md);
  assert.strictEqual(ls[0], '# 主管摘要');
  assert.strictEqual(ls[2], `**錯誤 ${st.error}、警告 ${st.warn}（待處理 ${ew.length}）。**`, '標題後第一行是結論');
  // 外部：與 Q.exposureSummary 同一句（畫面 L4 頁首也讀它），數字是分組後的「服務」
  const ex = Q.exposureSummary();
  assert.ok(ls.includes(`- 從外部進得來的（推論）：${R().mdText(ex.sentence)}`), '外部只寫結論句');
  assert.ok(ex.sentence.includes(`連得到 ${ex.total.allow} 個服務`));
  // 集中在哪：依 CATALOG 的 cat，前 SUMMARY_CATEGORIES 類，筆數合計等於待處理的錯誤與警告
  const conc = ls.find((l) => l.startsWith('- 待處理的錯誤與警告集中在：'));
  assert.ok(conc, conc);
  const nums = [...conc.matchAll(/(\S+) (\d+) 筆/g)].map((m) => [m[1].replace(/^.*[：、]/, ''), +m[2]]);
  const top = nums.slice(0, R().SUMMARY_CATEGORIES);
  top.forEach(([c, n]) => assert.strictEqual(n, ew.filter((f) => catOf(f) === c).length, `${c} 的筆數`));
  assert.strictEqual(nums.reduce((s, [, n]) => s + n, 0), ew.length, '各類合計等於待處理的錯誤與警告');
  top.forEach(([c]) => assert.ok(ls.some((l) => l.startsWith(`  - ${c}（最多的是 `)), `${c} 有一句方向`));
  // 需要決定的事：只有數量與題目
  const choice = Q.findings().filter((f) => S.remediate.levelOf(f.id) === 'choice');
  assert.ok(ls.some((l) => l.startsWith(`- 需要決定的事：${choice.length} 項要先選擇處理方式，例如`)));
  // 處理順序：依嚴重度一句，各段筆數與可直接產生修正指令的筆數
  const order = ls.find((l) => l.startsWith('- 處理順序：先'));
  ['error', 'warn', 'info'].forEach((s) => {
    const fs = Q.findings().filter((f) => f.severity === s); if (!fs.length) return;
    const auto = fs.filter((f) => S.remediate.levelOf(f.id) === 'auto').length;
    assert.ok(order.includes(`${R().SEV_TEXT[s]} ${fs.length} 筆（${auto ? `${auto} 筆可直接產生修正指令` : '沒有可直接產生的修正指令'}）`), `${s} 那一段`);
  });
  // 沒有逐列明細：不列個別 finding、位址或選項；一個畫面讀完
  assert.ok(!Q.findings().some((f) => md.includes(f.message)), '不列個別 finding 的訊息');
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(md), '不列任何位址');
  assert.ok(!md.includes('選項：') && !md.includes('## '), '不展開選項、不分小節');
  assert.ok(bullets(md).length <= 10 && ls.length <= 16, `約 15 行：${ls.length}`);
  assert.ok(!/工時|分鐘|小時|評分/.test(md), '不估工時、不評分');
});

test('主管摘要：沒有錯誤與警告時只有結論行與外部結論句', () => {
  const Q = S.query(clean());
  assert.strictEqual(Q.meta().stats.findings.error + Q.meta().stats.findings.warn, 0, '測試前提');
  const md = R().managerSummary(Q);
  assert.strictEqual(lines(md)[2], '**沒有錯誤與警告。**');
  assert.deepStrictEqual(bullets(md), [`- 從外部進得來的（推論）：${R().mdText(Q.exposureSummary().sentence)}`]);
});

test('主管摘要：處理紀錄改變待處理的計數；全部處理後只寫一句已處理', () => {
  const Q = S.query(sampleSnap());
  const ew = Q.findings().filter((f) => f.severity !== 'info');
  const err = Q.findings().find((f) => f.severity === 'error');
  const md = R().managerSummary(Q, { ledgerOf: (f) => (f === err ? { status: 'fixed', at: null, note: '', waiver: null } : null) });
  assert.ok(md.includes(`（待處理 ${ew.length - 1}）`));
  const tq = S.query(tiny()); const c02 = tq.findings()[0];
  const md2 = R().managerSummary(tq, { ledgerOf: (f) => (f === c02 ? { status: 'accepted', at: null, note: '', waiver: null } : null) });
  assert.ok(md2.includes('（待處理 0）') && md2.includes('- 錯誤與警告都已處理（見處理紀錄）。'));
  assert.ok(!md2.includes('處理順序'), '沒有待處理時不寫處理順序');
});

test('主管摘要：有上一輪基準時第一行接錯誤與警告的增減', () => {
  const qs = S.query(sampleSnap()); const qt = S.query(tiny()); const qc = S.query(clean());
  const n = (q) => q.meta().stats.findings.error + q.meta().stats.findings.warn;
  assert.ok(lines(R().managerSummary(qs, { previous: qt }))[2].includes(`，比上一輪多 ${n(qs) - n(qt)} 筆。`));
  assert.ok(lines(R().managerSummary(qt, { previous: qs }))[2].includes(`，比上一輪少 ${n(qs) - n(qt)} 筆。`));
  assert.ok(lines(R().managerSummary(qs, { previous: qs }))[2].includes('，與上一輪筆數相同。'));
  assert.strictEqual(lines(R().managerSummary(qc, { previous: qt }))[2], '**沒有錯誤與警告，比上一輪少 1 筆。**');
  assert.ok(!R().managerSummary(qs).includes('上一輪'), '沒有上一輪基準時不寫變化');
});

test('主管摘要：沒有 WAN 時寫 Q.exposureSummary 的結論句；傳入已算好的 exposure 結果相同；可重現', () => {
  const Q = S.query(tiny()); const ex = Q.exposureSummary();
  assert.notStrictEqual(ex.status, 'ok');
  assert.ok(R().managerSummary(Q).includes(`- 從外部進得來的（推論）：${R().mdText(ex.sentence)}`));
  const Qs = S.query(sampleSnap());
  const a = R().managerSummary(Qs);
  assert.strictEqual(R().managerSummary(Qs, { exposure: Qs.exposure() }), a);
  assert.strictEqual(R().managerSummary(S.query(sampleSnap())), a, '同輸入同輸出');
});
