#!/usr/bin/env node
/*
 * 版本一致性檢查：node tools/check-version.js [base]（預設 origin/main；npm run check:version -- <base>）
 * 依 ADR-005（docs/架構決策/005-版本升級規則.md）：同一份輸入建出的 Snapshot 內容改變就要升 minor。
 * 比較 base 與目前工作目錄的黃金基準 tests/golden/sample-snapshot.json（base 取 git merge-base <base> HEAD，CI 用 PR 的 base）：
 * 忽略版本與時間欄位（meta.version、meta.baselineKey、meta.createdAt、meta.timing）後內容不同，
 * 而 src/core/ns.js 的 S.VERSION 的 major.minor 沒有變，就以失敗結束。
 * 只讀 git 與檔案，不改任何東西。結束碼：0 通過、1 應升 minor、2 執行失敗（參數、git 或檔案格式）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GOLDEN = 'tests/golden/sample-snapshot.json';
const NS = 'src/core/ns.js';
/** 隨版本或建立時間改變、不算「解析結果」的 meta 欄位（baselineKey 含 major.minor 版本） */
const VOLATILE_META = Object.freeze(['version', 'baselineKey', 'createdAt', 'timing']);

/** ns.js 原始碼 → 版本字串；找不到時丟出錯誤 */
function versionOf(src) {
  const m = /\bS\.VERSION\s*=\s*'(\d+\.\d+\.\d+)'/.exec(src);
  if (!m) throw new Error(`${NS} 找不到 S.VERSION = 'x.y.z'`);
  return m[1];
}
const majorMinor = (v) => v.split('.').slice(0, 2).join('.');
/** 去掉版本與時間欄位後的 Snapshot（不改原物件） */
function strip(snap) {
  const out = Object.assign({}, snap, { meta: Object.assign({}, snap && snap.meta) });
  VOLATILE_META.forEach((k) => delete out.meta[k]);
  return out;
}
// 鍵排序後序列化：只比內容，不受欄位順序影響
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));

/**
 * 判斷：{ baseSnap, headSnap, baseVersion, headVersion } → { ok, changed, reason }。
 * baseSnap 為 null 代表 base 沒有黃金基準（新加入），視為通過。
 */
function judge({ baseSnap, headSnap, baseVersion, headVersion }) {
  if (!baseSnap) return { ok: true, changed: false, reason: `base 沒有 ${GOLDEN}，不比較` };
  const changed = canon(strip(baseSnap)) !== canon(strip(headSnap));
  if (!changed) return { ok: true, changed, reason: `黃金基準的內容沒有改變（忽略 ${VOLATILE_META.join('、')}）` };
  if (majorMinor(baseVersion) !== majorMinor(headVersion)) return { ok: true, changed, reason: `黃金基準的內容改變，版本已由 ${baseVersion} 升為 ${headVersion}` };
  return {
    ok: false, changed,
    reason: `黃金基準（${GOLDEN}）的內容改變，但 S.VERSION 的 major.minor 沒有變（${baseVersion} → ${headVersion}）。`
      + `依 ADR-005「解析結果改變就升 minor」：請在 ${NS} 升 minor（例如 ${bumpMinor(baseVersion)}），執行 npm run golden:update，並在 docs/版本紀錄.md 寫一筆。`,
  };
}
const bumpMinor = (v) => { const [a, b] = v.split('.').map(Number); return `${a}.${b + 1}.0`; };

function git(args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 5e8 }); }
function showAt(rev, file) {
  try { return git(['show', `${rev}:${file}`]); } catch (e) { return null; }
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length > 1 || args.some((a) => a.startsWith('-'))) {
    console.error('用法：node tools/check-version.js [base]（預設 origin/main）');
    return 2;
  }
  const base = args[0] || 'origin/main';
  let mergeBase;
  try { mergeBase = git(['merge-base', base, 'HEAD']).trim(); } catch (e) {
    console.error(`check-version：找不到 ${base} 與 HEAD 的共同祖先（${String(e.stderr || e.message).trim()}）；請先 git fetch，或指定 base`);
    return 2;
  }
  try {
    const baseText = showAt(mergeBase, GOLDEN);
    const nsBase = showAt(mergeBase, NS);
    if (nsBase == null) throw new Error(`${mergeBase.slice(0, 7)} 沒有 ${NS}`);
    const r = judge({
      baseSnap: baseText == null ? null : JSON.parse(baseText),
      headSnap: JSON.parse(fs.readFileSync(path.join(ROOT, GOLDEN), 'utf8')),
      baseVersion: versionOf(nsBase),
      headVersion: versionOf(fs.readFileSync(path.join(ROOT, NS), 'utf8')),
    });
    console.log(`check-version：base ${base}（merge-base ${mergeBase.slice(0, 7)}）`);
    (r.ok ? console.log : console.error)((r.ok ? '通過：' : '失敗：') + r.reason);
    return r.ok ? 0 : 1;
  } catch (e) {
    console.error('check-version：' + e.message);
    return 2;
  }
}

module.exports = { judge, versionOf, strip, VOLATILE_META };
if (require.main === module) process.exitCode = main(process.argv);
