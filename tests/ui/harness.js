// 畫面冒煙測試的執行環境：先建立模擬 DOM，再依 index.html 的順序載入核心與畫面腳本；step 的登錄與執行器。
'use strict';
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
// Markdown 錨點規則與淘汰用詞清單（tests/docs.js 共用；lib.js 用到時才載入核心，不影響本檔載入的 globalThis.SSOT）
const MD = require('../lib.js');
const { html } = require('./dom.js');
delete globalThis.SSOT;
const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
scripts.forEach((s) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, s), 'utf8'), { filename: s }));
// 首次繪製前的 inline script（index.html 唯一沒有 src 的 <script>）：和瀏覽器一樣在所有 <script src> 之後、DOMContentLoaded 之前執行。
// 啟動前先放一個不合法的配色偏好：應被忽略（退回跟隨系統）並 console.warn，不靜默
const inlineScripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1]);
const bootWarns = [];
{
  globalThis.localStorage.setItem(globalThis.SSOT.store.theme.KEY, 'sepia');
  const warn = console.warn; console.warn = (...a) => { bootWarns.push(a.join(' ')); };
  try { inlineScripts.forEach((src) => vm.runInThisContext(src, { filename: 'index.html（inline）' })); } finally { console.warn = warn; }
}
const S = globalThis.SSOT;

// ------------------------------------------------------------ step 的登錄與執行
// step 檔載入時只登錄（step(name, fn)），全部登錄完才由 run() 依登錄順序執行；step 之間共用畫面狀態，順序就是契約。
const registered = [];
const step = (name, fn) => { registered.push({ name, fn }); };
/**
 * 前置 step：--grep 時一律帶入（在符合的 step 之前、依原本順序）。其他 step 都假設畫面已啟動、範例基準已載入。
 * 名稱必須與 step 檔完全相同；找不到時直接失敗，不靜默略過。
 */
const FIXTURE = ['啟動、顯示歡迎畫面', '載入範例並建立基準'];
/**
 * 只帶入 FIXTURE 時單跑會失敗的 step，另外要先跑的 step（實測得到：逐一以 --grep 單跑全部 step）。
 * 鍵與值都是 step 名稱的開頭，必須恰好對到一個 step，且前置 step 排在它前面；對不到時直接失敗。
 * 新增 step 後若單跑失敗、全部跑通過，把它依賴的 step 加在這裡。
 */
const NEEDS = {
  '輸入對話框：預檢即時顯示': ['輸入對話框：格式說明'],
  'L4 明細：': ['L4 zone 矩陣：'],
  'L4 可達性查詢：': ['L4 zone 矩陣：'],
  // 這兩個在範例基準上單跑會失敗，先換成一份小輸入（buildInput）後才通過；依賴的是圖的狀態，不是那個 step 的斷言
  '推論鏈路以 theme 的弱邊樣式': ['只有 MNDP 的設備對不畫線'],
  'Pointer 事件：': ['Wi-Fi 介面不列為終端'],
  '設定「本機資料」：': ['處理紀錄取代確認：'],
};

const USAGE = '用法：node tests/ui-smoke.js [--grep <文字>]（環境變數 SMOKE_INPUT=<檔案> 改用其他輸入）';
const usage = (msg) => { console.error(`tests/ui-smoke.js：${msg}\n${USAGE}`); process.exit(1); };
function parseArgs(argv) {
  const args = { grep: null };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--grep' || a.startsWith('--grep=')) {
      const v = a === '--grep' ? argv[++k] : a.slice('--grep='.length);
      if (v == null || v === '') usage('--grep 需要指定要篩選的 step 名稱文字');
      if (args.grep != null) usage('--grep 只能指定一次');
      args.grep = v;
    } else usage(`不認得的參數「${a}」`);
  }
  return args;
}

/**
 * 依序登錄每個 step 檔（[{ file, fn }]），再執行：
 * - 沒有 --grep：依登錄順序全部執行。
 * - --grep <文字>：只跑名稱含該文字的 step（區分大小寫），並自動帶入 FIXTURE 中排在它前面的前置 step（標「前置」）；
 *   沒有任何 step 符合時以失敗結束。
 * 第一個失敗之後的失敗另標「可能是連鎖失敗」：step 共用狀態，前一個失敗時畫面可能沒有回到預期的狀態。
 */
async function run(files, argv) {
  const args = parseArgs(argv);
  for (const f of files) await f.fn();
  // step 名稱是 --grep、NEEDS 與發布前檢查表引用的鍵：重複時直接失敗
  const dup = registered.map((s) => s.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) { console.error('step 名稱重複：' + dup.join('、')); process.exit(1); }
  const missing = FIXTURE.filter((n) => !registered.some((s) => s.name === n));
  if (missing.length) { console.error('找不到前置 step：' + missing.join('、')); process.exit(1); }
  const byPrefix = (p, where) => {
    const m = registered.filter((s) => s.name.startsWith(p));
    if (m.length !== 1) { console.error(`tests/ui/harness.js 的 NEEDS：${where}「${p}」應恰好對到一個 step，對到 ${m.length} 個`); process.exit(1); }
    return m[0];
  };
  const needs = new Map(Object.entries(NEEDS).map(([k, v]) => {
    const s = byPrefix(k, '鍵');
    const pre = v.map((p) => byPrefix(p, '前置'));
    pre.forEach((p) => { if (registered.indexOf(p) >= registered.indexOf(s)) { console.error(`NEEDS：「${p.name.slice(0, 30)}」應排在「${s.name.slice(0, 30)}」前面`); process.exit(1); } });
    return [s, pre];
  }));
  let plan = registered.map((s) => ({ s, pre: false }));
  if (args.grep != null) {
    const hit = registered.filter((s) => s.name.includes(args.grep));
    if (!hit.length) { console.error(`沒有任何 step 名稱含「${args.grep}」（共 ${registered.length} 個），視為失敗`); process.exit(1); }
    // 要跑的 step：符合的、它們（遞移地）依賴的 NEEDS，以及排在最後一個要跑的 step 之前的 FIXTURE；一律照原本順序
    const want = new Set();
    const add = (s) => { if (want.has(s)) return; want.add(s); (needs.get(s) || []).forEach(add); };
    hit.forEach(add);
    const last = Math.max(...Array.from(want, (s) => registered.indexOf(s)));
    registered.forEach((s, i) => { if (FIXTURE.includes(s.name) && i < last) add(s); });
    plan = registered.filter((s) => want.has(s)).map((s) => ({ s, pre: !hit.includes(s) }));
  }
  const steps = []; let firstFail = null;
  for (const { s, pre } of plan) {
    try { await s.fn(); steps.push('  ✓ ' + s.name + (pre ? '（前置）' : '')); } catch (e) {
      steps.push('  ✗ ' + s.name + (pre ? '（前置）' : '') + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n      '));
      if (firstFail) steps.push(`      （可能是連鎖失敗：前面的「${firstFail.slice(0, 40)}${firstFail.length > 40 ? '…' : ''}」已失敗，先修第一個失敗）`);
      else firstFail = s.name;
      process.exitCode = 1;
    }
  }
  if (args.grep != null) {
    const n = plan.filter((p) => !p.pre).length;
    steps.push(`\n已篩選：${n}／${registered.length}（另帶入前置 ${plan.length - n} 個）。單跑時才失敗、全部跑時通過的 step 依賴了前面沒有帶入的 step，請把它加進 tests/ui/harness.js 的 NEEDS`);
  }
  console.log(steps.join('\n'));
  setTimeout(() => process.exit(process.exitCode || 0), 10);
}

module.exports = { fs, path, vm, ROOT, MD, S, scripts, inlineScripts, bootWarns, step, run, FIXTURE };
