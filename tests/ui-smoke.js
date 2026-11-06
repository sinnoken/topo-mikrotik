/*
 * 畫面冒煙測試（不需要瀏覽器）：用極簡 DOM 模擬載入 index.html 的所有腳本，
 * 走過「載入範例 → 建立基準 → 點每一筆檢查結果 → 各種選取 → 搜尋 → 路由追蹤 → 比對 → 縮放繪圖」，
 * 確認沒有執行期錯誤。真正的視覺檢查仍需在瀏覽器開啟 index.html。
 *   node tests/ui-smoke.js [--grep <文字>]
 *   SMOKE_INPUT=samples/large-1000.txt node tests/ui-smoke.js   # 大型冒煙測試（先執行 npm run gen:large）
 *
 * 這個檔案只是入口：模擬 DOM 在 tests/ui/dom.js，載入核心與畫面、step 執行器與 --grep 在 tests/ui/harness.js，
 * 共用小工具在 tests/ui/helpers.js，畫面與資料的邊界掃描在 tests/ui/boundary.js，step 依主題分在 tests/ui/steps/*.js。
 * step 之間共用畫面狀態（App、store、選取），下面的順序就是執行順序，不可調換。
 */
'use strict';
const fs = require('fs'); const path = require('path');
const FILES = [
  '01-boot-input', '02-details-narrow', '03-graph', '04-triage', '05-search-source', '06-layers-l2l3', '07-l4', '08-vrf',
  '09-inventory-export', '10-ledger-firewall', '11-collect-diff', '12-rounds-fix', '13-fix-graph', '14-style-a11y', '15-toolbar-settings', '16-hub-store',
  '17-mgmt', '18-ux-review6', '19-toolbar-split', '20-l2-sides', '21-l4-exposure', '22-collector-download',
];
// 清單與目錄要一致：新增的 step 檔沒列進來就不會執行，不能靜默漏掉
const dir = path.join(__dirname, 'ui', 'steps');
const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort();
if (onDisk.join() !== FILES.slice().sort().join()) {
  console.error('tests/ui-smoke.js 的 FILES 與 tests/ui/steps 不一致：\n  清單：' + FILES.join(', ') + '\n  目錄：' + onDisk.join(', '));
  process.exit(1);
}
const { run } = require('./ui/harness.js');
run(FILES.map((f) => ({ file: f, fn: require(path.join(dir, f + '.js')) })), process.argv.slice(2));
