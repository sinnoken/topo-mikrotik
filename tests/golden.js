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

module.exports = { FILE, goldenSnapshot, serialize, diffPaths };
