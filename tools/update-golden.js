// 更新黃金基準（tests/golden/sample-snapshot.json，以及修正 patch 的 sample-patch.json、sample-patch/*.rsc）：
// 只在「刻意改變 Snapshot 或 patch 輸出」時執行，並在提交時檢視差異。
// 用法：npm run golden:update
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../tests/load.js')();
const G = require('../tests/golden.js');

const changed = [];
const write = (file, next) => {
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (prev === next) return;
  fs.writeFileSync(file, next); changed.push(file);
};
const snap = G.goldenSnapshot(S);
write(G.FILE, G.serialize(snap));
// patch：plan 與每台設備的 .rsc；不再產生的 .rsc 刪除，讓目錄與輸出一致
const { plan, files } = G.goldenPatch(S, snap);
write(G.PATCH_FILE, G.serializePlan(plan));
fs.mkdirSync(G.PATCH_DIR, { recursive: true });
Object.keys(G.storedPatchFiles()).filter((f) => !(f in files)).forEach((f) => { fs.unlinkSync(path.join(G.PATCH_DIR, f)); changed.push(path.join(G.PATCH_DIR, f) + '（刪除）'); });
Object.entries(files).forEach(([f, text]) => write(path.join(G.PATCH_DIR, f), text));
console.log(changed.length ? `已更新（請用 git diff 檢視差異後再提交）：\n  ${changed.join('\n  ')}` : '黃金基準沒有變化');
