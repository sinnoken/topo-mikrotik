// 核心測試共用的 helper 與測試清單：tests/core/*.js、tests/workflow/*.js 都由這裡取得 S 與 test()。
// 只放兩個以上測試檔都用到的 helper；只服務單一檔案的 helper 留在該檔案裡。
// 注意：測試用的 RouterOS 輸出是依文件與慣例撰寫，不是從真實設備擷取；真實輸出請另外驗證。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const load = require('./load.js');
// 所有測試檔共用同一個 SSOT 命名空間（require 會快取這個模組）。第一次用到時才載入：
// tests/docs.js、tests/ui-smoke.js 只要下面的 Markdown／用字規則，載入核心會覆蓋 ui-smoke 自己載入的 globalThis.SSOT。
let loaded = null;
const core = () => loaded || (loaded = load());

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const build = (text, opt) => core().build([{ name: 't.txt', text }], Object.assign({ now: '2026-01-01T00:00:00Z' }, opt));
const ids = (snap) => snap.findings.map((f) => f.id);
const count = (snap, id) => snap.findings.filter((f) => f.id === id).length;
const gen = (args) => execFileSync('node', [path.join(ROOT, 'tools/gen-bundle.js'), ...args], { encoding: 'utf8', maxBuffer: 5e8 });
const iface = (s, k) => s.model.interfaces.find((i) => i.key === k);
const addrs = (s, ep) => s.model.ipAddresses.filter((a) => a.ep === ep).map((a) => a.address);

// 測試依登錄順序執行；tests/run.js 依檔名順序載入測試檔
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const i03 = (s) => s.findings.filter((f) => f.id === 'I03');
// 鄰居表與 MAC 表的區塊（不含設備標頭）
const NB = (rows) => ['### /ip neighbor print detail without-paging', ...rows].join('\n');
const BH = (rows) => ['### /interface bridge host print detail without-paging', 'Flags: D - dynamic, L - local', ...rows].join('\n');
// 一台 WAN＝ether1、LAN＝bridge1 的路由器，加上 export 行
const fwBox = (lines, opt) => build(['R (10.0.0.1):', '### /export terse', '/interface bridge add name=bridge1',
  ...(opt && opt.noLists ? [] : ['/interface list add name=WAN', '/interface list add name=LAN', '/interface list member add interface=bridge1 list=LAN',
    ...(opt && opt.emptyWan ? [] : ['/interface list member add interface=ether1 list=WAN'])]), ...lines].join('\n'));
const fws = (s, id) => s.findings.filter((f) => f.id === id);
// 比對前把 CRLF 換成 LF：.gitattributes 已設 eol=lf，但 Windows 上若設定 core.autocrlf 等仍可能拿到 CRLF 的工作檔，換行不同不算生成檔過期。
const lf = (s) => s.replace(/\r\n/g, '\n');
// 範例資料的黃金基準 Snapshot（與 tests/golden.js、npm run golden:update 同一個產生方式）
const sampleSnap = () => require('./golden.js').goldenSnapshot(core());

// ---- Markdown：GitHub 的錨點規則與連結（tests/docs.js 的連結檢查、tests/ui-smoke.js 的文件連結共用這一份）
/*
 * 錨點依 GitHub 的規則由標題產生：去掉連結網址與 HTML 標籤後轉小寫，去掉字母／數字／組合記號／連接標點（_）／空白／連字號
 * 以外的字元（中文保留，「」、（）：、反引號等標點去掉），空白換成 -，同名標題依序加 -1、-2。
 * 標題認得 ATX（# 標題）與 setext（下一行是 === 或 ---），另認得 <a id|name="…">。GitHub 比對標題錨點不分大小寫。
 */
const FENCE = /^\s*(```|~~~)/;
const githubSlug = (text) => text
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').trim().toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
// 去掉行內程式碼：開頭與結尾是同樣長度的反引號（`` a ` b `` 是一段）
const stripCodeSpans = (line) => line.replace(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/g, '');
/** 不在程式碼區塊（``` 或 ~~~）與檔頭 front matter 裡的行：[{ line, no }]（no 從 1 起算）；預設去掉行內程式碼，keepCode 時保留。 */
function proseLines(text, opt) {
  const lines = text.split('\n'); const out = []; let inCode = false; let i = 0;
  if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0) i = end + 1; }
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) { inCode = !inCode; continue; }
    if (!inCode) out.push({ line: opt && opt.keepCode ? line : stripCodeSpans(line), no: i + 1 });
  }
  return out;
}
/** 一份 Markdown 的錨點集合（標題的 slug 與 <a id|name>）。 */
function markdownAnchors(text) {
  const set = new Set(); const seen = new Map();
  const add = (title) => {
    const base = githubSlug(title); const n = seen.get(base);
    seen.set(base, n == null ? 0 : n + 1);
    set.add(n == null ? base : `${base}-${n + 1}`);
  };
  const rows = proseLines(text, { keepCode: true });
  rows.forEach(({ line, no }, k) => {
    for (const a of line.matchAll(/<a\s+(?:[^>]*\s)?(?:id|name)="([^"]+)"/g)) set.add(a[1]);
    const h = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { add(h[1]); return; }
    // setext：單行段落（前一行空白）、不是清單／表格／引言／標題，下一行緊接著 === 或 ---
    const next = rows[k + 1]; const prev = rows[k - 1];
    if (next && next.no === no + 1 && /^ {0,3}(=+|-+)\s*$/.test(next.line) && line.trim() && !/^\s*([-*+>|#]|\d+[.)]\s)/.test(line)
      && !(prev && prev.no === no - 1 && prev.line.trim())) add(line);
  });
  return set;
}
const anchorCache = new Map();
/** repo 內 Markdown 檔（相對 ROOT）的錨點集合，有快取。 */
function anchorsOf(file) {
  if (!anchorCache.has(file)) anchorCache.set(file, markdownAnchors(read(file)));
  return anchorCache.get(file);
}
/** 錨點是否存在：<a id> 原樣比對，標題的錨點不分大小寫。 */
const hasAnchor = (anchors, h) => anchors.has(h) || anchors.has(h.toLowerCase());
/**
 * 一行 Markdown（已去掉行內程式碼）裡的連結目標：[文字](目標 "標題")、[文字](<含 空白 的目標>)、![圖](…)、
 * 參考式定義 [x]: 目標、HTML 的 <a href="…">。目標中成對的括號算在目標裡（例如 …/Foo_(bar)）。
 */
function linkTargets(line) {
  const out = [];
  for (let at = line.indexOf(']('); at >= 0; at = line.indexOf('](', at + 2)) {
    let k = at + 2;
    if (line[k] === '<') { const end = line.indexOf('>', k); if (end > k) out.push(line.slice(k + 1, end)); continue; }
    let depth = 0; let u = '';
    for (; k < line.length; k++) {
      const c = line[k];
      if (c === '\\' && k + 1 < line.length) { u += line[++k]; continue; }
      if (/\s/.test(c)) break;
      if (c === '(') depth++;
      else if (c === ')') { if (!depth) break; depth--; }
      u += c;
    }
    if (u) out.push(u);
  }
  const ref = /^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/.exec(line); if (ref) out.push(ref[1] || ref[2]);
  for (const a of line.matchAll(/<a\s+(?:[^>]*\s)?href=(?:"([^"]*)"|'([^']*)')/gi)) out.push(a[1] != null ? a[1] : a[2]);
  return out;
}

// ---- 用字：已淘汰的說法 → 現行說法（畫面用字的來源是 src/view/dom.js 的 V.TERMS）
// RETIRED_TERMS 畫面與文件共用；RETIRED_UI_TERMS 另外只擋畫面（文件可以寫內部 API、ADR 編號、L1／L2 等開發用語）。
// 只擋精確片語：指 CATALOG 的東西一律稱「檢查」，但防火牆規則、命名規則、/routing rule 仍叫規則。
const RETIRED_TERMS = Object.freeze({
  收斂趨勢: '改善趨勢', 修復追蹤: '修正追蹤', 已排程修復: '已排定修正', 單側觀察: '只有一端資料',
  收集完整度: '覆蓋率', 收集情形: '覆蓋率', 維護窗口: '維護時段', '建立選項 expectedData': '各類設備應收資料', 連線類別: '鏈路類別',
  非直連確認: '未確認直連', 推定偏離: '與多數不同（推論）', '可接受（豁免）': '接受風險', 標為可接受: '標為接受風險', 未管理交換器: '非網管型交換器', 自動群組: '分群',
  誤報率最高的規則: '誤報率最高的檢查', 未登錄的規則: '未登錄的檢查',
  規則目錄: '檢查目錄', 規則代碼: '檢查代碼', 規則標題: '檢查標題', 規則的常見原因: '檢查的常見原因', 規則的處理建議: '檢查的處理建議',
  // 頁首的「⋯」選單已拿掉，設定由 ⚙ 開啟
  '頁首「⋯」': '⚙ 設定', '「⋯」選單': '⚙ 設定', '「⋯」裡': '⚙ 設定',
});
// 文件另有合理用法、只在畫面擋的：規格書的「src IP 群組 × dst IP」「下鑽」、Wi-Fi「客戶端」、建立選項 expectedData 的「預期資料」、
// 防火牆的「規則品質」「這項規則」等
const RETIRED_UI_TERMS = Object.freeze(Object.assign({}, RETIRED_TERMS, {
  '群組 ×': '終端 ×N', 未知對端: '終端', 下鑽: '明細', 客戶端: '用戶端', 預期資料: '預期現況',
  規則品質: '檢查品質', 規則類別: '檢查類別', 每項規則: '每項檢查', 這項規則: '這項檢查',
  子網: '網段', 異質: '結果不一', 這一輪: '本輪', 讀入: '載入（整份取代用匯入）', 未管理: '非網管型',
  'Q.reach）': '（不寫內部 API）', 'Q.hopOwner': '（不寫內部 API）',
  'ADR-': '（不寫內部編號）', 'facet：': '原值：', '（L0）': 'zone 矩陣', 'L1：': '位址組', 'L2：牽涉': '牽涉的規則', 'L3：': '逐跳路徑',
  開啟詳情: '開啟詳細資料', 'Enter 詳情': 'Enter 開啟詳細資料', 'broadcast domain 可達': 'L2 廣播網域可達',
  全通: 'V.L4_STATUS.allow（允許）', 全擋: 'V.L4_STATUS.deny（拒絕）', 'V.VERDICT': 'V.L4_STATUS',
  // 畫面的「回歸」都是處理狀態，沒有「回歸測試」這類用法
  分診: '研判', 回歸: '復發', 依規則: '依檢查', '檢查項目：': '比對對象：',
  // 流程步驟不顯示序號（名稱引用 A.STEP_LABEL）
  '① 輸入': '輸入', '② 檢視': '檢視', '③ 研判': '研判', '④ 修正': '修正', '⑤ 驗證': '驗證',
}));
/** 文字中出現的淘汰用詞：[[舊詞, 現行說法]] */
const retiredIn = (text, terms) => Object.keys(terms).filter((w) => text.includes(w)).map((w) => [w, terms[w]]);

module.exports = { ROOT, read, build, ids, count, gen, iface, addrs, tests, test, i03, NB, BH, fwBox, fws, lf, sampleSnap,
  FENCE, githubSlug, stripCodeSpans, proseLines, markdownAnchors, anchorsOf, hasAnchor, linkTargets, RETIRED_TERMS, RETIRED_UI_TERMS, retiredIn };
Object.defineProperty(module.exports, 'S', { enumerable: true, get: core });
