// 把 samples/sample-bundle.txt 包成 samples/sample-bundle.js，讓 index.html 以 file:// 開啟時也能「載入範例資料」。
// 產生內容的 embed(text) 另外匯出，tests/run.js 用它檢查 sample-bundle.js 有沒有跟著 txt 更新。
'use strict';
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');

/** sample-bundle.txt 的內容 → sample-bundle.js 的內容。 */
function embed(text) {
  return '// 由 tools/embed-sample.js 產生，請勿手動修改\n(function (S) { S.samples = S.samples || {}; S.samples[\'sample-bundle.txt\'] = ' + JSON.stringify(text) + '; })(globalThis.SSOT = globalThis.SSOT || {});\n';
}

module.exports = { embed };

if (require.main === module) {
  const text = fs.readFileSync(path.join(root, 'samples/sample-bundle.txt'), 'utf8');
  fs.writeFileSync(path.join(root, 'samples/sample-bundle.js'), embed(text));
  console.log('samples/sample-bundle.js 已更新');
}
