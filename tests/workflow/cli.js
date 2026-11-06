// CLI（tools/baseline.js）：以 child_process 執行，驗證結束碼、輸出檔與「CLI 與畫面得到相同的處理紀錄」
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { S, ROOT, read, test } = require('../lib.js');

const CLI = path.join(ROOT, 'tools', 'baseline.js');
const NOW = '2026-01-01T00:00:00Z';
const SAMPLE = path.join(ROOT, 'samples', 'sample-bundle.txt');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssot-cli-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
/** 執行 CLI，回傳 { code, stdout, stderr } */
const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 5e8 });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
/** 在 Node 中直接以核心建立基準並推進（與畫面相同：來源名稱是檔名、建立與推進用同一個 now） */
const direct = (file, ledger, now) => {
  const Q = S.query(S.build([{ name: path.basename(file), text: fs.readFileSync(file, 'utf8') }], { now }));
  return S.ledger.advance(ledger || S.ledger.empty(), Q, { now });
};
const CODES = () => require(CLI).EXIT;

test('CLI：結束碼常數集中定義並寫在 --help', () => {
  const r = run(['--help']);
  assert.strictEqual(r.code, 0, r.stderr);
  const E = CODES();
  assert.deepStrictEqual([E.OK, E.NOTIFY, E.FAILED], [0, 1, 2]);
  ['--ledger', '--profile', '--expected', '--now', '-o'].forEach((o) => assert.ok(r.stdout.includes(o), `--help 應說明 ${o}`));
  [E.OK, E.NOTIFY, E.FAILED].forEach((c) => assert.ok(new RegExp(`^\\s*${c}\\s`, 'm').test(r.stdout), `--help 應說明結束碼 ${c}`));
});

test('CLI：第一輪（沒有處理紀錄）有新的待處理錯誤／警告，結束碼 1；輸出基準、處理紀錄、檢查結果與摘要', () => {
  const out = tmp();
  try {
    const r = run([SAMPLE, '--now', NOW, '-o', out]);
    assert.strictEqual(r.code, CODES().NOTIFY, r.stderr);
    ['baseline.json', 'ledger.json', 'findings.json', 'findings.csv', 'findings.md', 'sitedoc.md', 'sitedoc.csv', 'summary.json'].forEach((f) => assert.ok(fs.existsSync(path.join(out, f)), `應輸出 ${f}`));
    assert.ok(!fs.existsSync(path.join(out, 'compare.json')), '沒有 --expected 時不輸出 compare.json');
    const snap = readJson(path.join(out, 'baseline.json'));
    assert.strictEqual(snap.meta.createdAt, NOW);
    assert.strictEqual(snap.meta.timing, undefined, '基準不含與執行環境有關的 meta.timing');
    const sum = readJson(path.join(out, 'summary.json'));
    assert.strictEqual(sum.exitCode, CODES().NOTIFY);
    assert.strictEqual(sum.skipped, false);
    assert.strictEqual(sum.round, 0);
    const pend = snap.findings.filter((f) => f.severity !== 'info');
    const uniq = new Set(pend.map((f) => S.query(snap).findingKey(f)));
    assert.strictEqual(sum.notify.new.length, uniq.size, '新的待處理錯誤／警告 = 所有錯誤／警告的不同 findingKey');
    assert.ok(sum.notify.new.every((x) => x.severity === 'error' || x.severity === 'warn'));
    assert.deepStrictEqual(sum.notify.regressed, []);
    assert.strictEqual(sum.pending.total, pend.length);
    const fd = readJson(path.join(out, 'findings.json'));
    assert.strictEqual(fd.items.length, snap.findings.length);
    assert.ok(fd.items.every((x) => x.status === 'open'));
  } finally { rm(out); }
});

test('CLI：同一份基準再推進一次（skipped）與沒有新項目的一輪，結束碼 0', () => {
  const a = tmp(); const b = tmp(); const c = tmp();
  try {
    assert.strictEqual(run([SAMPLE, '--now', NOW, '-o', a]).code, 1);
    const r = run([SAMPLE, '--ledger', path.join(a, 'ledger.json'), '--now', '2026-01-02T00:00:00Z', '-o', b]);
    assert.strictEqual(r.code, CODES().OK, r.stderr);
    const sum = readJson(path.join(b, 'summary.json'));
    assert.strictEqual(sum.skipped, true);
    assert.strictEqual(sum.round, 0);
    assert.deepStrictEqual(readJson(path.join(b, 'ledger.json')), readJson(path.join(a, 'ledger.json')), 'skipped 時處理紀錄原樣不動');
    // 拿掉輪次後再推進：項目都已在處理紀錄中，沒有新出現的
    const lg = readJson(path.join(a, 'ledger.json')); lg.iterations = [];
    writeJson(path.join(c, 'in.json'), lg);
    const r2 = run([SAMPLE, '--ledger', path.join(c, 'in.json'), '--now', NOW, '-o', path.join(c, 'out')]);
    assert.strictEqual(r2.code, CODES().OK, r2.stderr);
    const s2 = readJson(path.join(c, 'out', 'summary.json'));
    assert.strictEqual(s2.skipped, false);
    assert.deepStrictEqual(s2.notify, { new: [], regressed: [], waiverExpired: [] });
  } finally { rm(a); rm(b); rm(c); }
});

test('CLI：已修好（fixed）的項目又出現（復發），結束碼 1', () => {
  const d = tmp();
  try {
    const r1 = direct(SAMPLE, null, NOW);
    const Q = S.query(S.build([{ name: 'sample-bundle.txt', text: read('samples/sample-bundle.txt') }], { now: NOW }));
    const key = Q.findingKey(Q.findings().find((f) => f.severity === 'error'));
    const lg = JSON.parse(JSON.stringify(r1.ledger)); lg.items[key].status = 'fixed'; lg.iterations = [];
    writeJson(path.join(d, 'in.json'), lg);
    const r = run([SAMPLE, '--ledger', path.join(d, 'in.json'), '--now', NOW, '-o', path.join(d, 'out')]);
    assert.strictEqual(r.code, CODES().NOTIFY, r.stderr);
    const sum = readJson(path.join(d, 'out', 'summary.json'));
    assert.deepStrictEqual(sum.notify.regressed.map((x) => x.key), [key]);
    assert.deepStrictEqual(sum.notify.new, []);
    assert.strictEqual(readJson(path.join(d, 'out', 'ledger.json')).items[key].status, 'regressed');
  } finally { rm(d); }
});

test('CLI 與畫面得到相同的處理紀錄（與在 Node 中直接呼叫 S.ledger 推進的結果深度相等）', () => {
  const d = tmp();
  try {
    // 第一輪：沒有處理紀錄
    const out1 = path.join(d, 'o1');
    assert.strictEqual(run([SAMPLE, '--now', NOW, '-o', out1]).code, 1);
    const r1 = direct(SAMPLE, null, NOW);
    assert.deepStrictEqual(readJson(path.join(out1, 'ledger.json')), r1.ledger);
    // 使用者在畫面上改了幾項，第二輪的收集檔少了一條防火牆規則
    const keys = Object.keys(r1.ledger.items);
    let lg = S.ledger.set(r1.ledger, keys[0], { status: 'scheduled', note: '下週處理' }, { now: '2026-01-02T00:00:00Z' });
    lg = S.ledger.set(lg, keys[1], { status: 'accepted', waiver: { reason: '實驗室', until: '2026-01-10T00:00:00Z' } }, { now: '2026-01-02T00:00:00Z' });
    writeJson(path.join(d, 'lg.json'), lg);
    const lines = read('samples/sample-bundle.txt').split('\n');
    const f06 = lines.findIndex((l) => l.includes('chain=input protocol=udp src-port=53'));
    assert.ok(f06 >= 0);
    fs.mkdirSync(path.join(d, 'in'));
    const second = path.join(d, 'in', 'sample-bundle.txt');
    fs.writeFileSync(second, lines.filter((_, i) => i !== f06).join('\n'));
    const out2 = path.join(d, 'o2'); const T2 = '2026-01-15T00:00:00Z';
    run([second, '--ledger', path.join(d, 'lg.json'), '--now', T2, '-o', out2]);
    const r2 = direct(second, lg, T2);
    assert.ok(r2.changes.length > 0, '第二輪應有變化（豁免到期、消失）');
    assert.deepStrictEqual(readJson(path.join(out2, 'ledger.json')), r2.ledger);
    const sum = readJson(path.join(out2, 'summary.json'));
    assert.strictEqual(sum.changes.fixed, r2.changes.filter((c) => c.reason === 'disappeared').length);
    assert.strictEqual(sum.changes.waiverExpired, r2.changes.filter((c) => c.reason === 'waiver-expired').length);
  } finally { rm(d); }
});

test('CLI：相同輸入與選項的輸出完全相同', () => {
  const a = tmp(); const b = tmp();
  try {
    run([SAMPLE, '--now', NOW, '-o', a]); run([SAMPLE, '--now', NOW, '-o', b]);
    const files = fs.readdirSync(a).sort();
    assert.deepStrictEqual(files, ['baseline.json', 'findings.csv', 'findings.json', 'findings.md', 'ledger.json', 'sitedoc.csv', 'sitedoc.md', 'summary.json']);
    assert.deepStrictEqual(fs.readdirSync(b).sort(), files);
    files.forEach((f) => assert.ok(fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))), `${f} 兩次輸出不同`));
  } finally { rm(a); rm(b); }
});

test('CLI：findings.csv／findings.md 與畫面匯出同一份核心文字（S.report），處理紀錄欄位是推進後的狀態（含使用者的變更時間與備註）', () => {
  const a = tmp(); const b = tmp();
  try {
    assert.strictEqual(run([SAMPLE, '--now', NOW, '-o', a]).code, CODES().NOTIFY);
    const Q0 = S.query(readJson(path.join(a, 'baseline.json')));
    const lg0 = readJson(path.join(a, 'ledger.json'));
    const report = (dir) => [fs.readFileSync(path.join(dir, 'findings.csv'), 'utf8'), fs.readFileSync(path.join(dir, 'findings.md'), 'utf8')];
    const expect = (Q, lg) => [S.report.findingsCsv(Q, { ledgerOf: S.report.ledgerOfItems(lg, Q) }), S.report.findingsMarkdown(Q, { ledgerOf: S.report.ledgerOfItems(lg, Q) })];
    assert.deepStrictEqual(report(a), expect(Q0, lg0), '第一輪：都是待處理');
    assert.ok(report(a)[0].startsWith('\uFEFFseverity,') && report(a)[0].endsWith('\r\n'), 'CSV 有 BOM、換行 CRLF（與畫面相同）');
    // 使用者把一筆標為誤報並寫備註：下一輪（不同時間、同一份基準 skipped）報表的已處理欄位帶出變更時間與備註
    const key = Q0.findingKey(Q0.findings()[0]);
    const lg1 = S.ledger.set(lg0, key, { status: 'false-positive', note: '測試備註' }, { now: '2026-01-01T12:00:00Z' });
    writeJson(path.join(b, 'in.json'), lg1);
    run([SAMPLE, '--ledger', path.join(b, 'in.json'), '--now', '2026-01-02T00:00:00Z', '-o', path.join(b, 'out')]);
    const got = report(path.join(b, 'out'));
    assert.deepStrictEqual(got, expect(S.query(readJson(path.join(b, 'out', 'baseline.json'))), readJson(path.join(b, 'out', 'ledger.json'))));
    const row = got[0].split('\r\n')[1].split(',');
    assert.deepStrictEqual([row[6], row[7], row[8]], ['2026-01-01T12:00:00.000Z', 'false-positive', '測試備註'], '第一列的 acknowledged／ack_kind／ack_note');
    assert.ok(got[1].includes('**誤報**（2026-01-01T12:00:00.000Z）') && got[1].includes('  - 備註：測試備註'));
  } finally { rm(a); rm(b); }
});

test('CLI：--expected 輸出預期現況比對，--profile 套用命名規則', () => {
  const d = tmp();
  try {
    const r = run([SAMPLE, '--expected', path.join(ROOT, 'samples', 'expected-sample.json'), '--now', NOW, '-o', d]);
    assert.ok(r.code === 0 || r.code === 1, r.stderr);
    const cmp = readJson(path.join(d, 'compare.json'));
    assert.strictEqual(cmp.schema, 'ssot-diff/1');
    assert.deepStrictEqual(readJson(path.join(d, 'summary.json')).compare, cmp.summary);
    const prof = fs.readdirSync(path.join(ROOT, 'profiles')).find((f) => f.endsWith('.json'));
    if (prof) {
      const out = path.join(d, 'p');
      const r2 = run([SAMPLE, '--profile', path.join(ROOT, 'profiles', prof), '--now', NOW, '-o', out]);
      assert.ok(r2.code === 0 || r2.code === 1, r2.stderr);
      assert.ok(readJson(path.join(out, 'baseline.json')).meta.profile, '基準記下命名規則');
    }
  } finally { rm(d); }
});

test('CLI：執行失敗回 2，訊息寫到 stderr，out/ 不留半成品', () => {
  const d = tmp();
  try {
    const out = path.join(d, 'out');
    const cases = [
      ['壞的處理紀錄 JSON', () => { fs.writeFileSync(path.join(d, 'bad.json'), '{ 不是 JSON'); return [SAMPLE, '--ledger', path.join(d, 'bad.json')]; }],
      ['處理紀錄格式錯誤', () => { writeJson(path.join(d, 'bad2.json'), { schema: 'ssot-ledger/1', items: [], iterations: {} }); return [SAMPLE, '--ledger', path.join(d, 'bad2.json')]; }],
      ['讀不到收集檔', () => [path.join(d, '不存在.txt')]],
      ['讀不到處理紀錄', () => [SAMPLE, '--ledger', path.join(d, '不存在.json')]],
      ['命名規則格式錯誤', () => { writeJson(path.join(d, 'p.json'), { id: 'x', classify: [{ match: '(', kind: '不認得' }] }); return [SAMPLE, '--profile', path.join(d, 'p.json')]; }],
      ['預期資料格式錯誤', () => { writeJson(path.join(d, 'e.json'), { schema: 'x' }); return [SAMPLE, '--expected', path.join(d, 'e.json')]; }],
      ['--now 不是 ISO 時間', () => [SAMPLE, '--now', '昨天']],
      ['不認得的參數', () => [SAMPLE, '--bogus']],
      ['沒有收集檔', () => []],
    ];
    cases.forEach(([name, mk]) => {
      const args = mk();
      const r = run([...args, ...(args.includes('--now') ? [] : ['--now', NOW]), '-o', out]);
      assert.strictEqual(r.code, CODES().FAILED, `${name}：結束碼應為 2，得到 ${r.code}\n${r.stderr}`);
      assert.ok(r.stderr.trim(), `${name}：stderr 應有訊息`);
      assert.ok(!fs.existsSync(out) || !fs.readdirSync(out).length, `${name}：out/ 不應留下檔案`);
    });
    const r = run([SAMPLE, '-o', out]);
    assert.ok(r.code === 0 || r.code === 1, '沒有 -o 以外的選項時照常執行');
    const noOut = run([SAMPLE]);
    assert.strictEqual(noOut.code, CODES().FAILED, '沒有 -o 時失敗');
  } finally { rm(d); }
});

test('CLI：同一個輸出目錄先帶 --expected、再不帶時，刪掉上一次的 compare.json', () => {
  const d = tmp();
  try {
    assert.notStrictEqual(run([SAMPLE, '--expected', path.join(ROOT, 'samples', 'expected-sample.json'), '--now', NOW, '-o', d]).code, CODES().FAILED);
    assert.ok(fs.existsSync(path.join(d, 'compare.json')), '帶 --expected 時應有 compare.json');
    assert.notStrictEqual(run([SAMPLE, '--now', NOW, '-o', d]).code, CODES().FAILED);
    assert.ok(!fs.existsSync(path.join(d, 'compare.json')), '不帶 --expected 時不應留下上一次的 compare.json');
  } finally { rm(d); }
});

test('CLI：--now 正規化成 UTC、不存在的日期失敗；--expected／--expected-data 是 JSON null 時失敗', () => {
  const d = tmp();
  try {
    assert.notStrictEqual(run([SAMPLE, '--now', '2026-01-01T08:00:00+08:00', '-o', d]).code, CODES().FAILED);
    assert.strictEqual(readJson(path.join(d, 'baseline.json')).meta.createdAt, '2026-01-01T00:00:00.000Z', '帶時區的 --now 應正規化成 UTC');
    assert.strictEqual(run([SAMPLE, '--now', '2026-02-30T00:00:00Z', '-o', path.join(d, 'x')]).code, CODES().FAILED, '不存在的日期應失敗');
    writeJson(path.join(d, 'null.json'), null);
    assert.strictEqual(run([SAMPLE, '--expected', path.join(d, 'null.json'), '--now', NOW, '-o', path.join(d, 'y')]).code, CODES().FAILED, '--expected 為 null 應失敗');
    assert.strictEqual(run([SAMPLE, '--expected-data', path.join(d, 'null.json'), '--now', NOW, '-o', path.join(d, 'z')]).code, CODES().FAILED, '--expected-data 為 null 應失敗');
  } finally { rm(d); }
});

test('CLI：收集檔沒有認到任何設備的資料（空檔、只有空白或註解、內容都認不得）時結束碼 2，stderr 說明原因，不輸出任何檔案', () => {
  const d = tmp();
  try {
    const out = path.join(d, 'out');
    const file = (name, text) => { const f = path.join(d, name); fs.writeFileSync(f, text); return f; };
    const cases = [
      ['空檔', [file('empty.txt', '')], /沒有內容/],
      ['只有空白', [file('blank.txt', ' \n\n\t\n')], /沒有內容/],
      ['兩個空檔', [file('e1.txt', ''), file('e2.txt', '\n')], /沒有內容/],
      ['只有註解', [file('comments.txt', '# 收集檔\n# 這一輪沒有輸出\n')], /沒有認到任何設備的資料/],
      ['內容都認不得', [file('junk.txt', 'hello\nworld\n')], /沒有認到任何設備的資料.*無法辨識/],
    ];
    cases.forEach(([name, inputs, why]) => {
      const r = run([...inputs, '--now', NOW, '-o', out]);
      assert.strictEqual(r.code, CODES().FAILED, `${name}：結束碼應為 2，得到 ${r.code}\n${r.stdout}${r.stderr}`);
      assert.ok(why.test(r.stderr), `${name}：stderr 應說明原因：${r.stderr}`);
      assert.ok(!/at .*\.js:\d+/.test(r.stderr), `${name}：是預期的失敗，不印堆疊：${r.stderr}`);
      assert.ok(!fs.existsSync(out), `${name}：不應建立輸出目錄`);
    });
    // 只要有一份收集檔認到設備就照常執行（空檔只是不貢獻內容）；全部收集失敗也是有結果的一輪（由 C02 回報）
    const allFailed = run([file('failed.txt', 'R_B (10.0.0.2):\n# collection failed: connection\n'), '--now', NOW, '-o', path.join(d, 'f')]);
    assert.strictEqual(allFailed.code, CODES().NOTIFY, allFailed.stderr);
    assert.notStrictEqual(run([SAMPLE, file('empty2.txt', ''), '--now', NOW, '-o', out]).code, CODES().FAILED);
  } finally { rm(d); }
});

test('CLI：sitedoc.md／sitedoc.csv 與畫面的網路文件同一份核心文字（S.report.siteDoc*），處理紀錄是推進後的狀態', () => {
  const d = tmp();
  try {
    assert.notStrictEqual(run([SAMPLE, '--now', NOW, '-o', d]).code, CODES().FAILED);
    const ledger = readJson(path.join(d, 'ledger.json'));
    const Q = S.query(readJson(path.join(d, 'baseline.json')));
    const opts = { ledgerOf: S.report.ledgerOfItems(ledger, Q) };
    assert.strictEqual(fs.readFileSync(path.join(d, 'sitedoc.md'), 'utf8'), S.report.siteDocMarkdown(Q, opts));
    assert.strictEqual(fs.readFileSync(path.join(d, 'sitedoc.csv'), 'utf8'), S.report.siteDocCsv(Q, opts));
  } finally { rm(d); }
});
