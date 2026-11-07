// 本機的真實資料回歸：用 private/ 裡的真實收集檔建立基準，和上次存下的基準比較。
// private/ 不進版本（.git/info/exclude），CI 沒有這些檔案，所以這支只在本機執行；沒有檔案時略過、結束碼 0。
//
// 用法：npm run test:real [-- --update]
//   private/*.txt（*.anon.txt 除外）每一份都檢查：
//   1. 無法辨識的行（I01、I03）依指令列出行數；比存下的基準多就失敗。
//   2. 可重現：同一份輸入建兩次，除 meta.createdAt、meta.timing 外完全相同。
//   3. 和存下的基準（private/.baseline/<名稱>.snapshot.json）比較：各類事實的筆數、各檢查代號的筆數、
//      S.compare.snapshots 的差異摘要；只報告，不判定失敗（解析器修正本來就會讓事實改變）。
//   4. 有同名的 <名稱>.anon.txt 時，比對原檔與去識別化檔：設備、鏈路與無法辨識的行數不同就失敗，各檢查代號的筆數差異列出。
//   --update：把這次的基準存成新的比較對象（第一次執行沒有基準時也會存）。
// 輸出只有數量、檢查代號與指令名稱，不印出位址、設備名稱等真實資料。
'use strict';
const fs = require('fs');
const path = require('path');
const load = require('./load.js');

const ROOT = path.join(__dirname, '..');
// REAL_DIR：改用別處的收集檔（例如在另一個 worktree 以舊版程式建立比較用的基準）
const DIR = process.env.REAL_DIR ? path.resolve(process.env.REAL_DIR) : path.join(ROOT, 'private');
const BASE = path.join(DIR, '.baseline');
const NOW = '2026-01-01T00:00:00Z';
const update = process.argv.includes('--update');

const S = load();
const build = (name, text) => S.build([{ name, text }], { now: NOW });
const stable = (snap) => JSON.stringify(Object.assign({}, snap, { meta: Object.assign({}, snap.meta, { createdAt: null, timing: null }) }));

/** 無法辨識的行：I01 整段（區塊行數）與 I03 的行，依指令加總 */
function unknownByCommand(snap) {
  const out = new Map();
  const add = (cmd, n) => out.set(cmd, (out.get(cmd) || 0) + n);
  const i01 = new Set(snap.findings.filter((f) => f.id === 'I01').flatMap((f) => (f.evidence || []).map((e) => e.block)));
  snap.blocks.forEach((b) => {
    const cmd = b.command || '（沒有指令標記）';
    if (i01.has(b.id)) add(`I01 ${cmd}`, b.lines.length);
    if (b.unrecognizedLines && b.unrecognizedLines.length) add(`I03 ${cmd}`, b.unrecognizedLines.length);
  });
  return out;
}
const total = (m) => [...m.values()].reduce((a, b) => a + b, 0);
/** 各類事實的筆數（model 的陣列）與各檢查代號的筆數 */
function counts(snap) {
  const c = {};
  Object.keys(snap.model || {}).sort().forEach((k) => { if (Array.isArray(snap.model[k])) c[`model.${k}`] = snap.model[k].length; });
  snap.findings.forEach((f) => { c[`finding ${f.id}`] = (c[`finding ${f.id}`] || 0) + 1; });
  return c;
}
function countDiff(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => (a[k] || 0) !== (b[k] || 0)).map((k) => `${k}：${a[k] || 0} → ${b[k] || 0}`);
}
const links = (snap) => S.query(snap).links().length;

function checkOne(file) {
  const name = path.basename(file, '.txt');
  const text = fs.readFileSync(file, 'utf8');
  const problems = [];
  const t0 = Date.now();
  const snap = build(path.basename(file), text);
  const ms = Date.now() - t0;
  console.log(`\n== ${name}：${text.split('\n').length} 行，設備 ${snap.model.devices.length}、findings ${snap.findings.length}，建立 ${ms} ms`);

  const unknown = unknownByCommand(snap);
  console.log(`無法辨識的行：${total(unknown)}`);
  [...unknown.entries()].sort((x, y) => y[1] - x[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));

  if (stable(build(path.basename(file), text)) !== stable(snap)) problems.push('同一份輸入建兩次的結果不同（不可重現）');

  const basePath = path.join(BASE, `${name}.snapshot.json`);
  if (fs.existsSync(basePath)) {
    const old = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    const oldUnknown = unknownByCommand(old);
    if (total(unknown) > total(oldUnknown)) problems.push(`無法辨識的行比存下的基準多（${total(oldUnknown)} → ${total(unknown)}）`);
    [...new Set([...oldUnknown.keys(), ...unknown.keys()])].sort().forEach((k) => {
      if ((oldUnknown.get(k) || 0) < (unknown.get(k) || 0)) problems.push(`${k}：無法辨識的行 ${oldUnknown.get(k) || 0} → ${unknown.get(k)}`);
    });
    const d = countDiff(counts(old), counts(snap));
    console.log(`和存下的基準（${old.meta.version}）相比，筆數改變 ${d.length} 項${d.length ? '：' : ''}`);
    d.forEach((x) => console.log(`  ${x}`));
    if (old.meta.schema === snap.meta.schema) {
      const diff = S.compare.snapshots(S.query(old), S.query(snap));
      const by = Object.entries(diff.summary.byCategory).filter(([, v]) => v.added || v.removed || v.changed)
        .map(([k, v]) => `${k} +${v.added} -${v.removed} ~${v.changed}`);
      console.log(`差異（S.compare.snapshots）：${by.length ? by.join('、') : '沒有'}`);
    } else {
      console.log(`存下的基準是 ${old.meta.schema}，現在是 ${snap.meta.schema}，不做逐項比較；請用 --update 重存`);
    }
  } else {
    console.log('還沒有存下的基準，這次的結果存成比較對象');
  }
  if (update || !fs.existsSync(basePath)) {
    fs.mkdirSync(BASE, { recursive: true });
    fs.writeFileSync(basePath, JSON.stringify(snap));
    console.log(`已存下基準：private/.baseline/${name}.snapshot.json`);
  }

  const anonPath = path.join(DIR, `${name}.anon.txt`);
  if (fs.existsSync(anonPath)) {
    const anon = build(path.basename(anonPath), fs.readFileSync(anonPath, 'utf8'));
    const same = (label, a, b) => { if (a !== b) problems.push(`去識別化後${label}不同：${a} → ${b}`); };
    same('設備數', snap.model.devices.length, anon.model.devices.length);
    same('鏈路數', links(snap), links(anon));
    same('無法辨識的行數', total(unknown), total(unknownByCommand(anon)));
    const d = countDiff(counts(snap), counts(anon)).filter((x) => x.startsWith('finding '));
    console.log(`去識別化檔：檢查代號筆數不同 ${d.length} 項${d.length ? '（請對照 tools/anonymize.js 的警告確認原因）：' : ''}`);
    d.forEach((x) => console.log(`  ${x}`));
  }
  problems.forEach((p) => console.log(`✗ ${p}`));
  return problems.length;
}

const files = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => f.endsWith('.txt') && !f.endsWith('.anon.txt')).sort().map((f) => path.join(DIR, f))
  : [];
if (!files.length) {
  console.log('private/ 沒有真實收集檔，略過');
  process.exit(0);
}
const failed = files.reduce((n, f) => n + checkOne(f), 0);
console.log(`\n${files.length} 份收集檔，${failed ? `${failed} 個問題` : '沒有問題'}`);
process.exit(failed ? 1 : 0);
