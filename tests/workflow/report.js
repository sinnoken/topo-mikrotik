// 檢查結果報表（S.report）：CSV 與 Markdown 與報表移到核心之前畫面版的輸出逐字相同；畫面的同名 V.* 直接引用這裡的成員；只透過查詢介面讀基準
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
  assert.ok(csv.startsWith('\uFEFFseverity,id,title,') && csv.endsWith('\r\n'));
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

test('報表：畫面同名的 V.*（dom.js、remediation.js、app-ledger.js）就是 S.report 的成員（同一個參考），不另寫一份', () => {
  // 在獨立的 context 載入核心與畫面的 dom.js／remediation.js（只取常數與純函式，不碰 DOM），不污染其他測試的 SSOT
  const ctx = vm.createContext({ console });
  require('../../tools/core-files.js').concat(['src/view/dom.js', 'src/view/remediation.js'])
    .forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
  const V = ctx.SSOT.view; const R = ctx.SSOT.report; const RV = V.remediation;
  const same = [
    [V.SEV, R.SEV_TEXT, 'V.SEV'], [RV.STATUS_TEXT, R.STATUS_TEXT, 'STATUS_TEXT'], [RV.statusText, R.statusText, 'statusText'],
    [RV.advice, R.advice, 'advice'], [RV.sortByDevice, R.sortByDevice, 'sortByDevice'],
    [V.majorityDeviating, R.majorityDeviating, 'majorityDeviating'], [V.codeParts, R.codeParts, 'codeParts'],
    [V.DEVIATION, R.DEVIATION, 'DEVIATION'], [V.DEVIATION_LABEL, R.DEVIATION_LABEL, 'DEVIATION_LABEL'], [V.NO_MAJORITY, R.NO_MAJORITY, 'NO_MAJORITY'],
  ];
  same.forEach(([v, r, name]) => assert.ok(r !== undefined && v === r, `${name} 應直接引用 S.report 的同名成員`));
  // 畫面原始碼不另寫這些用語與函式（只能是引用 S.report）
  const dom = read('src/view/dom.js'); const rem = read('src/view/remediation.js'); const lg = read('src/view/app-ledger.js');
  assert.ok(!/'與多數不同'|'沒有多數'|error: '錯誤'/.test(dom), 'dom.js 不另寫報表用語');
  assert.ok(!/scheduled: '已排定修正'|function (advice|sortByDevice)\b/.test(rem), 'remediation.js 不另寫狀態文字、advice、sortByDevice');
  assert.ok(!/x\.by === 'user'/.test(lg) && /S\.report\.userAt/.test(lg) && /S\.report\.ledgerOfItems/.test(lg), 'app-ledger.js 的 ledgerUserAt／ledgerExport 用 S.report.userAt／ledgerOfItems');
});

test('報表：sortByDevice 依設備排序（穩定，不屬於設備的排最後）；userAt／ledgerOfItems 取使用者最後一次變更', () => {
  const Q = S.query(sampleSnap()); const fs0 = Q.findings();
  const rows = S.report.sortByDevice(Q, fs0);
  assert.strictEqual(rows.length, fs0.length);
  assert.deepStrictEqual(rows.map((r) => r.idx).sort((a, b) => a - b), fs0.map((_, i) => i), '每筆恰好出現一次');
  rows.forEach((r) => { assert.strictEqual(r.f, fs0[r.idx]); assert.strictEqual(r.dev, Q.findingDevice(r.f)); });
  const firstNull = rows.findIndex((r) => r.dev === null);
  if (firstNull >= 0) assert.ok(rows.slice(firstNull).every((r) => r.dev === null), '不屬於任何設備的排最後');
  rows.forEach((r, i) => {
    const p = rows[i - 1]; if (!p) return;
    if (p.dev === r.dev) assert.ok(p.idx < r.idx, '同一台設備內保留原順序');
    else if (p.dev !== null && r.dev !== null) assert.ok(S.util.natural(Q.devName(p.dev), Q.devName(r.dev)) <= 0, '依設備名稱的自然順序');
  });
  assert.ok(rows.some((r, i) => i && rows[i - 1].dev !== r.dev), '範例資料應有多台設備的檢查結果');
  // userAt：歷程中最後一筆 by user；沒有歷程或只有系統紀錄時 null
  assert.strictEqual(S.report.userAt(null), null);
  assert.strictEqual(S.report.userAt({ history: [{ by: 'system', at: 'x' }] }), null);
  assert.strictEqual(S.report.userAt({ history: [{ by: 'user', at: 'a' }, { by: 'system', at: 'b' }, { by: 'user', at: 'c' }, { by: 'system', at: 'd' }] }), 'c');
  const f = fs0[0]; const key = Q.findingKey(f);
  const it = { status: 'accepted', note: 'n', waiver: { reason: 'r', until: null }, history: [{ by: 'user', at: 't1' }, { by: 'system', at: 't2' }] };
  const of = S.report.ledgerOfItems({ items: { [key]: it } }, Q);
  assert.deepStrictEqual(of(f), { status: 'accepted', at: 't1', note: 'n', waiver: it.waiver });
  assert.ok(fs0.filter((x) => Q.findingKey(x) !== key).every((x) => of(x) === null), '不在處理紀錄中為 null');
  assert.strictEqual(S.report.ledgerOfItems(null, Q)(f), null, '沒有處理紀錄時為 null');
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
