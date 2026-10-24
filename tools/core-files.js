// 核心檔案載入順序（index.html 與 tests/load.js 共用；測試會檢查兩邊一致）
module.exports = [
  'src/core/ns.js', 'src/core/ip.js', 'src/core/keys.js',
  'src/readers/common.js', 'src/readers/bundle-v1.js', 'src/readers/files-v1.js', 'src/readers/index.js',
  'src/adapters/index.js', 'src/adapters/mikrotik.js',
  'src/data/oui-data.js', 'src/data/oui.js',
  'src/profile/profile.js', 'src/model/build.js', 'src/model/infer.js', 'src/check/catalog.js', 'src/check/checks.js',
  'src/pipeline.js', 'src/query/query.js', 'src/query/trace.js', 'src/compare/compare.js',
  // 處理紀錄（ssot-ledger/1），不屬於 Snapshot
  'src/ledger/ledger.js',
];
