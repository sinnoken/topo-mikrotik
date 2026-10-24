/*
 * 測試：node tests/run.js [--large] [--grep <文字>]
 *   --large        另外跑約 1000 台的壓力測試；時間上限預設 20000 ms，可用環境變數 SSOT_LARGE_MAX_MS 覆寫
 *   --grep <文字>  只跑名稱含該文字的測試（區分大小寫）；沒有任何測試符合時以失敗結束
 * 不需要任何套件。每個測試都在 Node 上直接載入與瀏覽器相同的核心檔案。
 * 這個檔案只是執行器：測試在 tests/core/*.js（解析、建模、推論、檢查、查詢）與 tests/workflow/*.js（比對、patch、處理紀錄），
 * 共用的 helper 在 tests/lib.js。載入順序固定：core 依檔名排序 → workflow 依檔名排序 → --large 時最後才是 tests/large.js。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 命令列參數與環境變數：不合法時直接結束，不靜默改用預設
const usage = (msg) => { console.error(`tests/run.js：${msg}\n用法：node tests/run.js [--large] [--grep <文字>]`); process.exit(1); };
const ARGS = { large: false, grep: null };
for (let k = 2; k < process.argv.length; k++) {
  const a = process.argv[k];
  if (a === '--large') ARGS.large = true;
  else if (a === '--grep' || a.startsWith('--grep=')) {
    const v = a === '--grep' ? process.argv[++k] : a.slice('--grep='.length);
    if (v == null || v === '') usage('--grep 需要指定要篩選的測試名稱文字');
    if (ARGS.grep != null) usage('--grep 只能指定一次');
    ARGS.grep = v;
  } else usage(`不認得的參數「${a}」`);
}
const LARGE_MAX_MS = (() => {
  const raw = process.env.SSOT_LARGE_MAX_MS;
  if (raw == null) return 20000;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n <= 0) usage(`環境變數 SSOT_LARGE_MAX_MS 必須是大於 0 的毫秒數，目前是「${raw}」`);
  return n;
})();

// 收集測試：各目錄的 .js 依檔名排序載入，每個檔案以 lib.js 的 test() 登錄測試
const { tests } = require('./lib.js');
['core', 'workflow'].forEach((dir) => {
  const abs = path.join(__dirname, dir);
  fs.readdirSync(abs).filter((f) => f.endsWith('.js')).sort().forEach((f) => require(path.join(abs, f)));
});
if (ARGS.large) require('./large.js')(LARGE_MAX_MS);

const selected = ARGS.grep == null ? tests : tests.filter((t) => t.name.includes(ARGS.grep));
if (!selected.length) {
  console.error(`沒有任何測試名稱含「${ARGS.grep}」（共 ${tests.length} 項${ARGS.large ? '' : '；壓力測試需另加 --large'}），視為失敗`);
  process.exit(1);
}
let fail = 0;
for (const t of selected) {
  try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { fail++; console.log('  ✗ ' + t.name + '\n      ' + String(e.message).split('\n').join('\n      ')); }
}
console.log(`\n${selected.length - fail} 通過，${fail} 失敗${ARGS.grep == null ? '' : `（已篩選：${selected.length}／${tests.length}）`}`);
process.exit(fail ? 1 : 0);
