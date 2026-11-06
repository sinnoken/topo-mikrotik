// 版本一致性（tools/check-version.js，ADR-005）：黃金基準的內容改變時 S.VERSION 要升 minor
'use strict';
const assert = require('assert');
const { S, read, test } = require('../lib.js');
const { judge, versionOf } = require('../../tools/check-version.js');

const snap = (meta, rest) => Object.assign({ meta: Object.assign({ schema: 'ssot-snapshot/3', version: '3.3.0', createdAt: '2026-01-01T00:00:00Z', inputHash: 'h', baselineKey: 'k1' }, meta) },
  { findings: [{ id: 'A02', message: '舊訊息' }] }, rest);
test('版本一致性：黃金基準內容相同→通過；內容不同而版本相同→失敗；升 minor→通過；只改版本欄位→通過', () => {
  const base = snap();
  assert.strictEqual(judge({ baseSnap: base, headSnap: snap(), baseVersion: '3.3.0', headVersion: '3.3.0' }).ok, true, '內容相同應通過');
  const changed = snap({}, { findings: [{ id: 'A02', message: '新訊息' }] });
  const fail = judge({ baseSnap: base, headSnap: changed, baseVersion: '3.3.0', headVersion: '3.3.0' });
  assert.strictEqual(fail.ok, false, '內容不同而版本相同應失敗');
  assert.ok(/ADR-005/.test(fail.reason) && fail.reason.includes('3.4.0'), '失敗說明應引用 ADR-005 並建議升 minor：' + fail.reason);
  assert.strictEqual(judge({ baseSnap: base, headSnap: changed, baseVersion: '3.3.0', headVersion: '3.3.1' }).ok, false, '只升 patch 號不算');
  assert.strictEqual(judge({ baseSnap: base, headSnap: changed, baseVersion: '3.3.0', headVersion: '3.4.0' }).ok, true, '升 minor 應通過');
  assert.strictEqual(judge({ baseSnap: base, headSnap: changed, baseVersion: '3.3.0', headVersion: '4.0.0' }).ok, true, '升 major 也通過');
  const onlyVersion = snap({ version: '3.4.0', baselineKey: 'k2', createdAt: '2026-02-01T00:00:00Z', timing: { ms: 1 } });
  assert.strictEqual(judge({ baseSnap: base, headSnap: onlyVersion, baseVersion: '3.3.0', headVersion: '3.3.0' }).ok, true, '只改版本與時間欄位應通過');
  assert.strictEqual(judge({ baseSnap: base, headSnap: snap({ inputHash: 'h2' }), baseVersion: '3.3.0', headVersion: '3.3.0' }).ok, false, 'meta 的其他欄位（inputHash）改變也算內容改變');
  assert.strictEqual(judge({ baseSnap: null, headSnap: base, baseVersion: '3.3.0', headVersion: '3.3.0' }).ok, true, 'base 沒有黃金基準時不比較');
});
test('版本一致性：從 src/core/ns.js 讀出的版本就是 S.VERSION', () => {
  assert.strictEqual(versionOf(read('src/core/ns.js')), S.VERSION);
  assert.throws(() => versionOf('S.VERSION = 3;'), /S\.VERSION/);
});
test('npm test 的彙總（tools/run-all.js）：被 signal 結束時寫出 signal 名稱，不寫「結束碼 null」；載入時不執行測試', () => {
  const { failText } = require('../../tools/run-all.js');
  assert.strictEqual(failText({ status: null, signal: 'SIGKILL' }), '被 signal SIGKILL 結束');
  assert.strictEqual(failText({ status: 2, signal: null }), '結束碼 2');
  assert.strictEqual(failText({ error: new Error('spawn bash ENOENT') }), '無法執行：spawn bash ENOENT');
});
