// 在 Node 上依序載入核心檔案，回傳 SSOT 命名空間（與瀏覽器載入的是同一批檔案）。
'use strict';
const fs = require('fs'); const path = require('path'); const vm = require('vm');
module.exports = function load() {
  delete globalThis.SSOT;
  const root = path.join(__dirname, '..');
  require('../tools/core-files.js').forEach((f) => vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f }));
  return globalThis.SSOT;
};
