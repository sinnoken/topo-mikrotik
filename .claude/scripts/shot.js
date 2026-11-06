#!/usr/bin/env node
'use strict';
/**
 * UX 評審用的截圖矩陣（ux-review skill）：亮／暗 × 1440／390，依序截下主要畫面狀態。
 *
 * 本機選用工具：不進 CI、不列入 npm test、repo 不相依 puppeteer。需要自行安裝，例如在 scratchpad 執行
 *   npm i puppeteer-core   （或 puppeteer，會自帶 Chromium）
 * 再以 PUPPETEER_DIR 指到安裝的 node_modules 所在目錄。
 *
 * 用法：node .claude/scripts/shot.js <commit> <輸出目錄> [<repo>]
 *   commit   要截的版本（HEAD、分支或 commit）。以 git archive 解出到暫存目錄再截，
 *            不受工作樹未 commit 的改動影響；要截未 commit 的改動時先做 WIP commit。
 *   repo     預設是目前目錄。
 * 環境變數：
 *   PUPPETEER_DIR   含 node_modules/puppeteer-core 或 node_modules/puppeteer 的目錄（預設：一般 require 解析）
 *   CHROME_PATH     瀏覽器執行檔（用 puppeteer-core 時必填，例如 Chrome、Brave、Edge）
 *   SHOT_ONLY       只截名稱含這段文字的狀態，例如 SHOT_ONLY=08-
 * 輸出：<狀態>-<light|dark>-<寬度>.png、rects.json（幾個浮動元件的位置，用來找窄螢幕重疊）、errors.json（頁面錯誤）。
 * 狀態依賴 App.* 的畫面函式；畫面改名時這裡跟著改，失敗的狀態會記在 errors.json，不中斷其他狀態。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const [commit, outArg, repoArg] = process.argv.slice(2);
if (!commit || !outArg) { console.error('用法：node .claude/scripts/shot.js <commit> <輸出目錄> [<repo>]'); process.exit(2); }
const repo = path.resolve(repoArg || '.');
const out = path.resolve(outArg);

function loadPuppeteer() {
  const tries = ['puppeteer-core', 'puppeteer'];
  for (const name of tries) {
    try { return require(process.env.PUPPETEER_DIR ? path.join(process.env.PUPPETEER_DIR, 'node_modules', name) : name); } catch (e) { /* 試下一個 */ }
  }
  console.error('找不到 puppeteer-core 或 puppeteer。請在 scratchpad 安裝並設定 PUPPETEER_DIR（見檔頭）。');
  process.exit(2);
}

// 以 git archive 解出指定版本，避免截到工作樹裡別的改動
function extract() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
  const sha = execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim();
  const tar = path.join(dir, 'src.tar');
  execFileSync('git', ['archive', '--format=tar', '-o', tar, sha], { cwd: repo });
  const site = path.join(dir, 'site'); fs.mkdirSync(site);
  execFileSync('tar', ['-xf', tar, '-C', site]);
  return { dir, site, sha };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const puppeteer = loadPuppeteer();
  const { dir, site, sha } = extract();
  fs.mkdirSync(out, { recursive: true });
  const rects = {}; const errors = [];
  const only = process.env.SHOT_ONLY || '';
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: 'new', args: ['--allow-file-access-from-files'] });
  try {
    for (const scheme of ['light', 'dark']) for (const width of [1440, 390]) {
      const tag = `${scheme}-${width}`;
      const p = await browser.newPage();
      await p.setViewport({ width, height: width > 800 ? 900 : 844 });
      await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      p.on('pageerror', (e) => errors.push({ tag, error: e.message }));
      const url = 'file://' + path.join(site, 'index.html');
      // 先清掉上一輪留在 IndexedDB 的狀態，每個組合都從歡迎畫面開始
      await p.goto(url); await wait(500);
      await p.evaluate(async () => { try { for (const k of ['last', 'layout', 'layoutMode', 'ledger']) await SSOT.store.del(k); } catch (e) { /* 沒有 store 時略過 */ } });
      await p.goto(url); await wait(700);
      const ev = (fn, ...a) => p.evaluate(fn, ...a);
      const ws = (n) => ev((n) => { const b = document.querySelector(`button[data-workspace="${n}"]`); if (b && b.offsetParent) b.click(); }, n);
      const measure = () => ev(() => {
        const r = (s) => { const e = document.querySelector(s); if (!e || e.classList.contains('hidden')) return null; const x = e.getBoundingClientRect(); return { x0: x.left, y0: x.top, x1: x.right, y1: x.bottom }; };
        return { note: r('#layer-note'), legend: r('#legend'), hint: r('#hint'), toolbar: r('#toolbar'), canvas: r('#graph') };
      });
      const shot = async (name, ms, act) => {
        if (only && !name.includes(only) && !act) return;
        try {
          if (act) await act();
          if (only && !name.includes(only)) return;
          await wait(ms || 600);
          await p.screenshot({ path: path.join(out, `${name}-${tag}.png`) });
          rects[`${name}-${tag}`] = await measure();
        } catch (e) { errors.push({ tag, state: name, error: e.message }); }
      };
      // 狀態清單（與 ux-review skill 的截圖矩陣一致）
      await shot('00-welcome');
      await shot('01-build-dialog', 1200, async () => { await ev(() => App.openInput()); await wait(300); await ev(() => App.loadSample()); });
      await shot('02-graph', 1500, async () => {
        await p.click('#input-build'); await p.waitForFunction(() => App.snap, { timeout: 30000 }); await wait(5000);
        await ev(() => App.showStep('triage')); await ws('graph');
      });
      await shot('06-core-router', 1200, async () => {
        await ev(() => { App.select(null); const d = App.Q.devices().find((x) => /CORE_RT/.test(x.name || '')); if (d) App.select({ type: 'device', key: d.key }, { focus: true }); });
        await ws('graph');
      });
      for (const L of ['l2', 'l3']) {
        await shot('08-' + L, 3500, async () => { await ev(() => App.select(null)); await ev(() => App.showStep('view')); await ws('graph'); await ev((L) => App.showLayer(L), L); });
      }
      await shot('13-legend', 600, async () => { await ev(() => App.showLayer('l2')); await wait(500); await ev(() => document.querySelector('#legend .legend-head').click()); });
      await shot('14-l2-view-menu', 400, async () => { await ev(() => document.querySelector('#legend .legend-head').click()); await ev(() => document.getElementById('btn-view-menu').click()); });
      await shot('12b-hub-outputs', 800, async () => { await ev(() => App.openHub('outputs')); });
      await p.close();
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(out, 'rects.json'), JSON.stringify(rects, null, 1));
    fs.writeFileSync(path.join(out, 'errors.json'), JSON.stringify(errors, null, 1));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`完成：${sha.slice(0, 7)} → ${out}（頁面錯誤 ${errors.length} 筆，見 errors.json）`);
})().catch((e) => { console.error(e); process.exit(1); });
