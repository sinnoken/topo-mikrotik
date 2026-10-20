// 更新黃金基準（tests/golden/sample-snapshot.json）：只在「刻意改變 Snapshot」時執行，並在提交時檢視差異。
// 用法：npm run golden:update
'use strict';
const fs = require('fs');
const S = require('../tests/load.js')();
const { FILE, goldenSnapshot, serialize } = require('../tests/golden.js');
const next = serialize(goldenSnapshot(S));
const prev = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;
fs.writeFileSync(FILE, next);
console.log(prev === next ? '黃金基準沒有變化' : `已更新 ${FILE}（請用 git diff 檢視差異後再提交）`);
