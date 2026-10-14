// 把 samples/sample-bundle.txt 包成 samples/sample-bundle.js，讓 index.html 以 file:// 開啟時也能「載入範例資料」。
'use strict';
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const text = fs.readFileSync(path.join(root, 'samples/sample-bundle.txt'), 'utf8');
fs.writeFileSync(path.join(root, 'samples/sample-bundle.js'),
  '// 由 tools/embed-sample.js 產生，請勿手動修改\n(function (S) { S.samples = S.samples || {}; S.samples[\'sample-bundle.txt\'] = ' + JSON.stringify(text) + '; })(globalThis.SSOT = globalThis.SSOT || {});\n');
console.log('samples/sample-bundle.js 已更新');
