// 檢查結果報表（S.report）：CSV 與 Markdown 與報表移到核心之前畫面版的輸出逐字相同；用語與畫面的 V.* 相同；只透過查詢介面讀基準
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { S, read, test, sampleSnap } = require('../lib.js');
const scenarios = require('./fixtures/report/scenarios.js');

test('報表：S.report 的 CSV／Markdown 與預期輸出（畫面版 src/view/export.js 移到核心之前的輸出）逐字相同', () => {
  const got = scenarios.outputs(S, S.report);
  const files = fs.readdirSync(scenarios.DIR).filter((f) => /\.(csv|md)$/.test(f)).sort();
  assert.deepStrictEqual(Object.keys(got).sort(), files, '情境與預期輸出的檔案應一一對應');
  files.forEach((f) => assert.strictEqual(got[f], fs.readFileSync(path.join(scenarios.DIR, f), 'utf8'), `${f} 應與預期輸出逐字相同`));
});

test('報表：範例資料的 CSV 欄數一致、BOM 與 CRLF；Markdown 依嚴重度分組，每項出現的檢查都附處理建議', () => {
  const Q = S.query(sampleSnap());
  const csv = S.report.findingsCsv(Q);
  assert.ok(csv.startsWith('﻿severity,id,title,') && csv.endsWith('\r\n'));
  assert.strictEqual(csv.split('\r\n')[0].split(',').pop(), S.report.DEVIATION_LABEL);
  const md = S.report.findingsMarkdown(Q);
  const heads = S.report.SEV_ORDER.map((s) => md.indexOf(`\n## ${S.report.SEV_TEXT[s]}（`));
  assert.ok(heads.every((x, i) => x > 0 && (!i || heads[i - 1] < x)), '應依嚴重度分組並依序排列');
  S.util.uniq(Q.findings().map((f) => f.id)).filter((id) => S.report.advice(id).action).forEach((id) => {
    assert.ok(md.slice(md.indexOf(`\n### ${id} `)).split('\n').some((l) => l.startsWith('- 處理建議：')), `${id} 應附處理建議`);
  });
  const byDev = S.report.findingsMarkdown(Q, { byDevice: true });
  assert.ok(byDev.includes('\n## 附錄：處理建議與常見原因\n'));
});

test('報表：用語與畫面同名的 V.*（dom.js、remediation.js）相同，CATALOG 文字的切法也相同', () => {
  // 在獨立的 context 載入核心與畫面的 dom.js／remediation.js（只取常數與純函式，不碰 DOM），不污染其他測試的 SSOT
  const ctx = vm.createContext({ console });
  require('../../tools/core-files.js').concat(['src/view/dom.js', 'src/view/remediation.js'])
    .forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
  const V = ctx.SSOT.view; const R = S.report;
  assert.deepStrictEqual({ ...V.SEV }, { ...R.SEV_TEXT });
  assert.deepStrictEqual({ ...V.remediation.STATUS_TEXT }, { ...R.STATUS_TEXT });
  assert.deepStrictEqual([V.DEVIATION, V.DEVIATION_LABEL, V.NO_MAJORITY], [R.DEVIATION, R.DEVIATION_LABEL, R.NO_MAJORITY]);
  ['open', 'regressed', 'weird', null, ''].forEach((s) => assert.strictEqual(V.remediation.statusText(s), R.statusText(s)));
  [null, { basis: 'other', deviating: ['a'] }, { basis: 'majority', deviating: [] }, { basis: 'majority' }, { basis: 'majority', deviating: ['a', 'b'] }]
    .forEach((dv) => assert.deepStrictEqual(JSON.stringify(V.majorityDeviating(dv)), JSON.stringify(R.majorityDeviating(dv))));
  S.query.rules().forEach((r) => {
    assert.deepStrictEqual(JSON.stringify(V.remediation.advice(r.id)), JSON.stringify(R.advice(r.id)), `${r.id} 的 advice`);
    [r.action, ...(r.causes || [])].filter(Boolean).forEach((t) => assert.strictEqual(JSON.stringify(V.codeParts(t)), JSON.stringify(R.codeParts(t))));
  });
  ['沒有反引號', '`a` 與 `b`', '單一 ` 反引號', '``', '`x'].forEach((t) => assert.strictEqual(JSON.stringify(V.codeParts(t)), JSON.stringify(R.codeParts(t)), t));
});

test('報表：單向依賴——只透過查詢介面與 S.query.rule／rules、S.ledger 讀取；上游與其他下游不呼叫 S.report；不碰 DOM', () => {
  const src = read('src/report/report.js').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/\b(document|window|indexedDB|localStorage)\b|S\.(view|store|build|check|model|infer|compare|remediate|workpack)\b/.test(src), '報表不可碰 DOM、畫面或上游');
  assert.ok(!/\bsnap(shot)?\s*\./.test(src), '報表不讀 Snapshot 欄位，只用 Q');
  const core = require('../../tools/core-files.js');
  assert.ok(core.indexOf('src/report/report.js') > core.indexOf('src/ledger/ledger.js'), '報表要在 S.ledger 之後載入');
  core.filter((f) => f !== 'src/report/report.js').forEach((f) => assert.ok(!/S\.report\b/.test(read(f)), `${f} 不可呼叫 S.report`));
  assert.ok(Object.isFrozen(S.report));
});
