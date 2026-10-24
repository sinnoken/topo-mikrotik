// 黃金基準：範例資料建出的完整 Snapshot（固定時間、去掉計時欄位），測試與更新工具共用同一個產生方式。
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(__dirname, 'golden', 'sample-snapshot.json');

function goldenSnapshot(S) {
  const text = fs.readFileSync(path.join(ROOT, 'samples', 'sample-bundle.txt'), 'utf8');
  const snap = S.build([{ name: 'sample-bundle.txt', text }], { now: '2026-01-01T00:00:00Z' });
  delete snap.meta.timing; // 唯一與執行環境有關的欄位
  return snap;
}
const serialize = (snap) => JSON.stringify(snap, null, 1) + '\n';

// ---- 修正 patch（ssot-patch/1）的黃金檔：範例資料的 F01／F02／F06 與 A12，plan 一份、每台設備三份 .rsc
// A12 的選擇固定：dns（沒有多數）選 TPE_CORE_RT_02 那一組；ntp 不指定，採多數
const PATCH_FILE = path.join(__dirname, 'golden', 'sample-patch.json');
const PATCH_DIR = path.join(__dirname, 'golden', 'sample-patch');
const PATCH_SELECTION = { ids: ['F01', 'F02', 'F06', 'A12'] };
const PATCH_CHOICES = { dns: 'device:TPE_CORE_RT_02' }; // facet → 選項 id（格式見 src/remediate/patch.js）
const serializePlan = (plan) => JSON.stringify(plan, null, 1) + '\n';
/** 回傳 { plan, files: { 檔名: 內容 } }（檔名依 S.remediate.files 的 base）。 */
function goldenPatch(S, snap) {
  const s = snap || goldenSnapshot(S); const Q = S.query(s);
  const choices = {};
  s.findings.filter((f) => f.id === 'A12' && PATCH_CHOICES[f.facet]).forEach((f) => { choices[Q.findingKey(f)] = PATCH_CHOICES[f.facet]; });
  if (Object.keys(choices).length !== Object.keys(PATCH_CHOICES).length) throw new Error('範例資料找不到 PATCH_CHOICES 指定的 A12 finding');
  const plan = S.remediate.plan(Q, PATCH_SELECTION, { choices });
  const files = {};
  S.remediate.files(plan).forEach((f) => { files[f.base + '.rsc'] = f.apply; files[f.base + '-rollback.rsc'] = f.rollback; files[f.base + '-verify.rsc'] = f.verify; });
  return { plan, files };
}
/** 目前存放的 patch 黃金檔：{ 檔名: 內容 }（目錄不存在時為空物件）。 */
function storedPatchFiles() {
  if (!fs.existsSync(PATCH_DIR)) return {};
  const out = {};
  fs.readdirSync(PATCH_DIR).filter((f) => f.endsWith('.rsc')).sort().forEach((f) => { out[f] = fs.readFileSync(path.join(PATCH_DIR, f), 'utf8').replace(/\r\n/g, '\n'); });
  return out;
}

/** 列出兩個 JSON 值第一批不同的路徑（最多 limit 筆），讓失敗訊息指出改到哪裡。 */
function diffPaths(a, b, limit, at, out) {
  out = out || []; at = at || '';
  if (out.length >= limit) return out;
  if (a === b) return out;
  const ta = Array.isArray(a) ? 'array' : typeof a; const tb = Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb || ta !== 'object' && ta !== 'array' || a === null || b === null) { out.push(`${at || '（根）'}：${JSON.stringify(a)} → ${JSON.stringify(b)}`.slice(0, 200)); return out; }
  if (ta === 'array' && a.length !== b.length) out.push(`${at}：長度 ${a.length} → ${b.length}`);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) { if (out.length >= limit) break; diffPaths(a[k], b[k], limit, ta === 'array' ? `${at}[${k}]` : at ? `${at}.${k}` : k, out); }
  return out;
}

module.exports = { FILE, goldenSnapshot, serialize, diffPaths, PATCH_FILE, PATCH_DIR, PATCH_SELECTION, PATCH_CHOICES, serializePlan, goldenPatch, storedPatchFiles };
