// 畫面冒煙測試的 step：app-toolbar.js 拆成工具列、配色（app-scheme.js）、圖例與匯出（app-legend.js）三個檔之後的載入與分工，
// 以及 index.html 畫面文字的斜線用全形「／」。
'use strict';
const { S, fs, path, ROOT, step, scripts, inlineScripts } = require('../helpers.js');
const assert = require('assert');

const html = () => fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const src = (f) => fs.readFileSync(path.join(ROOT, 'src/view', f), 'utf8');
/** 檔案裡定義的 A.／App.／V. 成員（行首的指派） */
const defined = (f) => Array.from(src(f).matchAll(/^\s*((?:A|App|V)\.[A-Za-z_]+) = /gm)).map((m) => m[1]);

module.exports = async () => {
  await step('工具列拆檔：app-toolbar、app-scheme、app-legend 依序在 app.js 之後、首次繪製配色的 inline script 之前載入', async () => {
    const at = (f) => scripts.indexOf('src/view/' + f);
    ['app.js', 'app-toolbar.js', 'app-scheme.js', 'app-legend.js'].forEach((f) => assert.ok(at(f) >= 0, f + ' 沒有載入'));
    assert.ok(at('app.js') < at('app-toolbar.js') && at('app-toolbar.js') < at('app-scheme.js') && at('app-scheme.js') < at('app-legend.js'), '載入順序不對');
    // inline script 呼叫 A.paintScheme：所有 <script src> 都要在它之前（瀏覽器依文件順序執行）
    const doc = html(); const inline = doc.indexOf('<script>SSOT.view.app.paintScheme();</script>');
    assert.ok(inline > 0 && inlineScripts.some((s) => s.includes('paintScheme')), '首次繪製配色的 inline script 不見了');
    assert.ok(doc.indexOf('src="src/view/app-scheme.js"') < inline, 'app-scheme.js 要在 inline script 之前載入');
    assert.strictEqual(typeof S.view.app.paintScheme, 'function');
  });

  await step('工具列拆檔：配色、圖例與匯出各在自己的檔案，每個成員只定義一次（A.withScheme 由 PNG 匯出共用，不複製）', async () => {
    const files = ['app-toolbar.js', 'app-scheme.js', 'app-legend.js'];
    const owner = new Map();
    files.forEach((f) => defined(f).forEach((m) => { assert.ok(!owner.has(m), m + ' 在 ' + owner.get(m) + ' 與 ' + f + ' 重複定義'); owner.set(m, f); }));
    const expect = {
      'app-toolbar.js': ['A.bindMenu', 'A.bindHeader', 'A.bindToolbar', 'A.setLayoutMode', 'App.LAYOUT_MODES', 'App.clearBaseline'],
      'app-scheme.js': ['A.reducedMotion', 'A.resolveScheme', 'A.paintScheme', 'A.themePref', 'A.setThemePref', 'A.applyColorScheme', 'A.bindColorScheme', 'A.withScheme'],
      'app-legend.js': ['A.buildLegend', 'A.rebuildLegend', 'V.legendLineHeight', 'A.renderVendorLegend', 'A.exportPng', 'App.exportAs'],
    };
    Object.entries(expect).forEach(([f, ms]) => ms.forEach((m) => assert.strictEqual(owner.get(m), f, m + ' 應在 ' + f)));
    assert.ok(src('app-legend.js').includes('A.withScheme('), 'PNG 匯出要經 A.withScheme');
    assert.ok(!/function withScheme|function recolorGraph/.test(src('app-legend.js') + src('app-toolbar.js')), '配色的換算只在 app-scheme.js');
    // 凍結的簽章
    const A = S.view.app; const App = globalThis.App;
    assert.strictEqual(A.setLayoutMode.length, 1); assert.strictEqual(A.setThemePref.length, 1); assert.strictEqual(App.exportAs.length, 2);
    assert.ok(Array.isArray(App.LAYOUT_MODES) && typeof App.clearBaseline === 'function');
  });

  await step('index.html 的畫面文字用全形「／」，不用半形斜線（按鍵「/」與 <code> 內的路徑、指令除外）', async () => {
    const doc = html().replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|textarea|svg|code|kbd)\b[\s\S]*?<\/\1>/g, '');
    const texts = [];
    doc.replace(/>([^<]+)</g, (_, t) => { texts.push(t); return _; });
    for (const m of doc.matchAll(/\s(?:title|placeholder|aria-label|alt)="([^"]*)"/g)) texts.push(m[1]);
    const bad = texts.map((t) => t.replace(/按 \/ /g, '')).filter((t) => /\s\/\s|[㐀-鿿（）]\/|\/[㐀-鿿（）]/.test(t));
    assert.deepStrictEqual(bad, [], '畫面文字有半形斜線：' + bad.join('｜'));
    assert.ok(html().includes('WSL／Linux'), '收集腳本的平台寫成「WSL／Linux」');
  });
};
