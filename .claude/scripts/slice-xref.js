#!/usr/bin/env node
'use strict';
/**
 * 切片範圍交叉檢查（lead 派工前用）：平行切片的檔案有沒有重疊、彼此用到對方檔案定義的成員。
 *
 * 用法：node .claude/scripts/slice-xref.js <repo> <slices.json>
 *
 * slices.json：切片名稱 → 檔案清單（相對 repo；結尾 / 代表該目錄下 git 的所有檔案）。例如：
 *   {
 *     "C": ["src/check/checks.js", "src/check/catalog.js", "tools/core-files.js", "index.html"],
 *     "P": ["src/view/app-panes.js", "src/view/panels/", "src/query/query.js"],
 *     "G": ["src/view/graph/", "src/view/app-graph.js", "src/view/theme.js"]
 *   }
 *
 * 輸出：
 *   1. 檔案交集：同一個檔案出現在兩個以上的切片。
 *   2. 「A 用到 B 的定義」：A 的檔案用到 V.／A.／App.／Q.／S. 成員，而該成員只在 B 的檔案裡定義
 *      （`X.y = …`；src/query/query.js 回傳物件的鍵視為 Q.鍵）。B 若改名或改介面，A 會壞。
 *      這是文字比對的提示，不是完整分析：動態存取、解構、別名都看不到。
 * 結束碼：程式檔（.md／.txt 以外）有交集時 1，其他 0；參數或檔案錯誤 2。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [repo, cfg] = process.argv.slice(2);
if (!repo || !cfg) { console.error('用法：node .claude/scripts/slice-xref.js <repo> <slices.json>'); process.exit(2); }
let slices;
try { slices = JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch (e) { console.error(`讀不到切片設定 ${cfg}：${e.message}`); process.exit(2); }
if (!slices || typeof slices !== 'object' || Array.isArray(slices) || !Object.values(slices).every(Array.isArray)) {
  console.error('切片設定應為 { "切片名稱": ["檔案", …], … }'); process.exit(2);
}

let tracked = null;
const gitFiles = () => tracked || (tracked = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean));
const expand = (f) => (f.endsWith('/') ? gitFiles().filter((g) => g.startsWith(f)) : [f]);
const missing = [];
const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch (e) { missing.push(f); return ''; } };

const NAME = /\b(?:V|A|App|Q|S)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/g;
const DEF = /\b((?:V|A|App|Q|S)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*=(?![=>])/g;
const QUERY = 'src/query/query.js';
const names = Object.keys(slices);
const files = {}; const defs = {}; const uses = {};
for (const k of names) {
  files[k] = [...new Set(slices[k].flatMap(expand))];
  defs[k] = new Map(); uses[k] = new Set();
  for (const f of files[k]) {
    const t = read(f);
    for (const m of t.matchAll(DEF)) if (!defs[k].has(m[1])) defs[k].set(m[1], f);
    for (const m of t.matchAll(NAME)) uses[k].add(m[0]);
    if (f === QUERY) for (const m of t.matchAll(/^\s{2,6}([a-zA-Z_$][\w$]*)\s*[:(,]/gm)) if (!defs[k].has('Q.' + m[1])) defs[k].set('Q.' + m[1], f);
  }
}
if (missing.length) console.log(`注意：讀不到 ${missing.length} 個檔案（新檔或打錯路徑）：${missing.join('、')}\n`);

const owners = new Map();
for (const k of names) for (const f of files[k]) owners.set(f, (owners.get(f) || []).concat(k));
const shared = [...owners].filter(([, ks]) => ks.length > 1);
const isCode = (f) => !/\.(md|txt)$/i.test(f);
console.log(`檔案交集（${shared.length}）：`);
shared.forEach(([f, ks]) => console.log(`  ${f}：${ks.join('、')}${isCode(f) ? '' : '（文件）'}`));

console.log('\n用到其他切片定義的成員：');
let total = 0;
for (const a of names) for (const b of names) {
  if (a === b) continue;
  const hit = [...uses[a]].filter((n) => defs[b].has(n) && !defs[a].has(n)).sort();
  if (!hit.length) continue;
  total += hit.length;
  console.log(`  ${a} 用到 ${b} 的定義（${hit.length}）：${hit.map((n) => `${n}〔${defs[b].get(n)}〕`).join('、')}`);
}
console.log(`  合計 ${total}`);

const codeShared = shared.filter(([f]) => isCode(f));
if (codeShared.length) { console.log(`\n有 ${codeShared.length} 個程式檔同時屬於多個切片，請重新切分或指定負責的切片。`); process.exitCode = 1; }
