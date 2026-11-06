// 畫面冒煙測試的 step：啟動、離線契約、邊界掃描、歡迎畫面、輸入對話框與載入範例。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { html, body, docListeners, head, loadedScripts, document, S, fs, path, ROOT, inlineScripts, bootWarns, step, jsFiles, goStep, $, text, stripJs, viewBoundaryViolations } = require('../helpers.js');

module.exports = async () => {
  await step('啟動、顯示歡迎畫面', async () => { (docListeners.DOMContentLoaded || []).forEach((f) => f()); await new Promise((r) => setTimeout(r, 20)); if ($('#welcome').classList.contains('hidden')) throw new Error('應顯示歡迎畫面'); });
  await step('配色偏好的啟動：首次繪製前由 inline script 設定 data-theme；不合法的偏好忽略並警告一次、退回跟隨系統', () => {
    const ST = S.store.theme; const VA = S.view.app; const T = S.view.theme;
    if (!ST || JSON.stringify(ST.VALUES) !== '["system","light","dark"]' || typeof ST.KEY !== 'string') throw new Error('store 應集中定義配色偏好的鍵與值（S.store.theme.KEY／VALUES）');
    // inline script 只呼叫畫面的函式，不自己寫鍵或讀 localStorage（store.js 是唯一來源）
    if (inlineScripts.length !== 1 || inlineScripts[0].includes(ST.KEY) || /localStorage/.test(inlineScripts[0])) throw new Error('index.html 應只有一段首次繪製前的 inline script，經 store 讀偏好：' + inlineScripts.join('|'));
    const ih = html.indexOf('<script>'); if (ih < html.lastIndexOf('<script src=') || ih > html.indexOf('</head>')) throw new Error('inline script 應在所有 <script src> 之後、</head> 之前（首次繪製前）');
    if (bootWarns.filter((w) => w.includes('sepia')).length !== 1) throw new Error('不合法的配色偏好應 console.warn 一次（說明被忽略的值）：' + bootWarns.join('|'));
    if (ST.get() !== 'system' || VA.themePref() !== 'system') throw new Error('不合法的配色偏好應退回跟隨系統');
    if (document.documentElement.getAttribute('data-theme') !== T.mode) throw new Error('<html data-theme> 應與 theme.mode 一致：' + document.documentElement.getAttribute('data-theme'));
    App.openSettings('general');
    const checked = $('#settings').testAll('.settings-radio').filter((r) => r.dataset.setting === 'theme' && r.checked).map((r) => r.value);
    S.view.app.closeSettings();
    if (checked.join() !== 'system') throw new Error('啟動後設定「一般」的配色應勾選跟隨系統：' + checked.join());
    try { ST.set('sepia'); throw new Error('寫入不合法的偏好應丟出 RangeError'); } catch (e) { if (!(e instanceof RangeError)) throw e; }
    if (localStorage.getItem(ST.KEY) !== 'sepia') throw new Error('不合法的偏好只忽略，不改寫使用者的資料');
    localStorage.removeItem(ST.KEY);
  });
  await step('離線契約：CSP 禁止網路連線，程式碼不使用網路 API', () => {
    const csp = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
    // script-src 只放行 index.html 內嵌 script 的 sha256（不用 'unsafe-inline'）：改了 inline script 沒更新雜湊時，這裡比對實際內容會失敗
    const hashes = inlineScripts.map((src) => `'sha256-${require('crypto').createHash('sha256').update(src, 'utf8').digest('base64')}'`);
    if (!hashes.length) throw new Error('index.html 應有首次繪製前的 inline script');
    // 內嵌事件屬性（onclick= 等）不受 sha256 放行、會被 CSP 擋下：一律在 src/view 以 JS 綁定（去掉註解後掃描標籤內的屬性）
    const handlers = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').match(/<[a-zA-Z][^>]*?\son[a-z]+\s*=[^>]*>/g);
    if (handlers) throw new Error('index.html 不可有內嵌事件屬性（改在 JS 綁定）：' + handlers.join(' | '));
    // 逐項比對每個指令的完整來源清單：放寬（多一個來源）或漏掉指令都會失敗；要調整時同步改 index.html 的說明註解與開發原則第 11 條
    const want = {
      'default-src': "'none'", 'script-src': ["'self'", ...hashes].join(' '), 'style-src': "'self' 'unsafe-inline'", 'img-src': "'self' data: blob:",
      'font-src': "'self'", 'connect-src': "'none'", 'media-src': "'none'", 'manifest-src': "'none'", 'form-action': "'none'",
      'object-src': "'none'", 'frame-src': "'none'", 'worker-src': "'none'", 'base-uri': "'none'",
    };
    const got = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v.join(' ')]));
    Object.entries(want).forEach(([k, v]) => { if (got[k] !== v) throw new Error(`CSP 的 ${k} 應為「${v}」，目前是「${got[k]}」`); });
    Object.keys(got).forEach((k) => { if (!(k in want)) throw new Error('CSP 多了沒有檢查的指令 ' + k); });
    if (/https?:|wss?:|\*|'unsafe-eval'/.test(csp) || /script-src[^;]*'unsafe-inline'/.test(csp)) throw new Error('CSP 不可允許網路來源、萬用字元或 unsafe-eval：' + csp);
    if (html.indexOf('Content-Security-Policy') > html.indexOf('<script')) throw new Error('CSP 必須在第一個 <script> 之前');
    jsFiles('src').forEach((f) => {
      const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const hit = code.match(/\bfetch\(|XMLHttpRequest|new WebSocket|sendBeacon|EventSource/);
      if (hit) throw new Error(`${f} 使用了網路 API：${hit[0]}`);
    });
  });
  await step('畫面與資料的邊界：src/view 只用允許的 S.* 成員，不讀 Snapshot 欄位（去掉註解後掃描）', () => {
    // 掃描器本身：註解、字串與 regex 內的文字不算；template 的 ${} 內算程式碼
    const probe = [
      '// S.check.CATALOG 與 App.snap.findings 寫在註解中', "const a = '字串中的 App.snap.findings'; const r = /S.check/.test(x);",
      'const b = S.check.CATALOG[id];', 'const c = App.snap.findings[0]; const t = `x ${S.adapters[id].label} y`;',
      'const ok = S.query.rule(id) && S.readers.PASTE && S.profile.compile && S.inputHashOf && SSOT.util.natural && JSON.stringify(snap);',
      'const bad = S.readers.ORDER + S.profile.load; const { check } = S; const m = last.snapshot.meta; const z = Q.snapshot;',
    ].join('\n');
    const got = viewBoundaryViolations('probe.js', probe);
    const lines = got.map((v) => v.line).join();
    if (lines !== '3,4,4,6,6,6,6,6') throw new Error('邊界掃描器的判斷不符（行號 ' + lines + '）：\n' + got.map((v) => v.text).join('\n'));
    if (!got[0].text.includes('probe.js:3') || !got[0].text.includes('S.query.rule')) throw new Error('違規訊息應列出檔案、行號與建議的寫法：' + got[0].text);
    const files = jsFiles('src/view');
    if (!files.length) throw new Error('應掃描到 src/view 的檔案');
    const bad = files.flatMap((f) => viewBoundaryViolations(f.split(path.sep).join('/'), fs.readFileSync(path.join(ROOT, f), 'utf8')));
    if (bad.length) throw new Error(`畫面直接讀核心內部或 Snapshot 欄位 ${bad.length} 處：\n` + bad.map((v) => '        ' + v.text).join('\n'));
  });
  await step('NodeList／HTMLCollection：src/view 不對 querySelectorAll、children、childNodes 直接呼叫陣列方法（先 Array.from），也不用測試專用的 testAll', () => {
    // 執行期由模擬 DOM 的 NodeList_／HTMLCollection_ 抓；這裡靜態掃描，涵蓋冒煙測試沒走到的分支
    const probe = "a.querySelectorAll('x').find(f); Array.from(a.querySelectorAll('x')).find(f); a.querySelectorAll('x').forEach(f); el.children.map(f); el.testAll('x');";
    const scan = (src) => stripJs(src).split('\n').flatMap((line, n) => [
      ...Array.from(line.matchAll(/(querySelectorAll\s*\([^()]*\)|\.children|\.childNodes)\s*\.\s*(find|findIndex|filter|map|flatMap|some|every|reduce|indexOf|includes|slice|concat|join|sort)\b/g)).map((m) => `${n + 1}：${m[0]}`),
      ...(/\.testAll\s*\(/.test(line) ? [`${n + 1}：testAll`] : [])]);
    if (scan(probe).length !== 3) throw new Error('掃描器的判斷不符：' + scan(probe).join('、'));
    const bad = jsFiles('src/view').flatMap((f) => scan(fs.readFileSync(path.join(ROOT, f), 'utf8')).map((x) => `${f.split(path.sep).join('/')}:${x}`));
    if (bad.length) throw new Error('瀏覽器的 NodeList／HTMLCollection 沒有這些陣列方法，請先 Array.from：\n        ' + bad.join('\n        '));
    const nl = document.querySelectorAll('button');
    if (Array.isArray(nl) || typeof nl.find === 'function' || typeof nl.forEach !== 'function' || typeof body.children.forEach === 'function') throw new Error('模擬 DOM 應回傳 NodeList（有 forEach、沒有 find）與 HTMLCollection（沒有 forEach）');
  });
  await step('ELK 不在啟動時載入', () => { if (globalThis.ELK || loadedScripts.length) throw new Error('ELK 應在第一次需要分層版面時才載入'); });
  await step('歡迎畫面：三步驟的引導；收集只寫一句並以按鈕開啟設定的「收集與建立基準」（指令清單只在那裡出現一次）；複製指令清單', async () => {
    const w = $('#welcome');
    const cmds = S.collectCommands.default.map((c) => c.command);
    if (!cmds.includes('/export terse')) throw new Error('指令清單應取自 samples/collect-commands.js');
    if (w.querySelector('ol').testAll('li').length !== 3) throw new Error('歡迎畫面應保留三步驟的引導');
    if (!w.textContent.includes('collect.sh')) throw new Error('歡迎畫面應提到收集腳本 collect.sh');
    // 單一來源：歡迎畫面不再有指令清單（也沒有收集指引的展開區塊）
    const listShown = (root) => root.testAll('pre').filter((p) => p.textContent === cmds.join('\n'));
    if (listShown(w).length || w.querySelector('details') || cmds.slice(1).some((c) => w.textContent.includes(c))) throw new Error('歡迎畫面不應再列出指令清單（只在設定的「收集與建立基準」）');
    const helpBtn = $('#welcome-help');
    if (!helpBtn || helpBtn.tagName !== 'BUTTON' || helpBtn.getAttribute('type') !== 'button' || !helpBtn.textContent.includes('收集與建立基準')) throw new Error('歡迎畫面應有「看收集與建立基準的說明」按鈕');
    if (!w.querySelector('ol').testAll('li')[0].contains(helpBtn)) throw new Error('說明按鈕應在第一步（收集）');
    helpBtn.focus(); helpBtn.click();
    if ($('#settings').classList.contains('hidden') || S.view.app.settingsSection() !== 'help' || document.activeElement !== $('#settings-panel-title')) throw new Error('按鈕應開啟設定的「收集與建立基準」並聚焦它的標題');
    if (document.testAll('pre').filter((p) => p.textContent === cmds.join('\n')).length !== 1) throw new Error('指令清單在整個畫面應只出現一次');
    if (text('#settings-commands') !== cmds.join('\n')) throw new Error('「收集與建立基準」的指令清單應取自 samples/collect-commands.js：' + text('#settings-commands'));
    if (!S.collectCommands.optional.every((c) => text('#settings-panel').includes(c.command))) throw new Error('應列出選用指令');
    const copyBtn = $('#settings').testAll('button').find((b) => b.getAttribute('data-settings-focus') === 'copy-commands');
    if (!copyBtn || !copyBtn.textContent.includes('複製')) throw new Error('複製指令清單應是按鈕');
    // 觸控用語：歡迎畫面與操作提示各有滑鼠與觸控兩份，觸控（pointer: coarse）只顯示「點一下、拖曳、雙指縮放」那份；不寫只適用寬螢幕的「左側／右側」
    const touch = (sel) => $(sel).querySelector('.for-touch'); const mouse = (sel) => $(sel).querySelector('.for-mouse');
    if (!touch('#welcome') || !mouse('#welcome') || !/點一下/.test(touch('#welcome').textContent) || !/雙指縮放/.test(touch('#welcome').textContent)) throw new Error('歡迎畫面應有觸控用語');
    if (!touch('#hint') || !mouse('#hint') || !/雙指縮放/.test(touch('#hint').textContent) || /滾輪|鍵盤|雙擊/.test(touch('#hint').textContent) || !/滾輪/.test(mouse('#hint').textContent)) throw new Error('操作提示的觸控版應寫雙指縮放，不寫滾輪、鍵盤');
    if (/左側|右側/.test(w.textContent)) throw new Error('歡迎畫面不應寫只適用寬螢幕的左側／右側');
    const css0 = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    if (!/\n\.for-touch \{ display: none; \}/.test(css0) || !/@media \(pointer: coarse\) \{[^}]*\}\s*\.for-mouse \{ display: none; \}\s*\.for-touch \{ display: inline; \}/.test(css0)) throw new Error('觸控裝置應改顯示觸控用語');
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); let copied = null;
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied = t; } } }, configurable: true, writable: true });
    try {
      copyBtn.click(); await new Promise((r) => setTimeout(r, 5));
      if (copied !== cmds.join('\n') || !text('#settings-copy-status').includes('已複製')) throw new Error('複製指令清單應寫入剪貼簿並提示');
      $('#input-format-copy').click(); await new Promise((r) => setTimeout(r, 5));
      if (copied !== text('#input-format-example') || !text('#input-format-copy-status').includes('已複製')) throw new Error('複製範例應寫入格式範例全文');
      globalThis.navigator = {}; copyBtn.click(); await new Promise((r) => setTimeout(r, 5));
      if (!text('#settings-copy-status').includes('無法自動複製')) throw new Error('不能複製時應明確告知：' + text('#settings-copy-status'));
    } finally { if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator; }
    // 關閉後焦點回到歡迎畫面的按鈕
    $('#settings').querySelector('.settings-close').click();
    if (!$('#settings').classList.contains('hidden') || document.activeElement !== helpBtn) throw new Error('關閉設定後焦點應回到歡迎畫面的說明按鈕');
  });
  await step('輸入對話框：格式說明是可展開、可複製的範例，範例本身認得；placeholder 只是提示', async () => {
    await App.openInput();
    if (($('#input-text').getAttribute('placeholder') || '').includes('_____')) throw new Error('placeholder 不應再放格式範例');
    if (!$('#input-text').getAttribute('aria-label')) throw new Error('文字框應有 aria 名稱');
    if ($('#input-format').tagName !== 'DETAILS' || !$('#input-format-copy')) throw new Error('格式說明應為可展開、可複製的區塊');
    const p = S.preflight([{ name: S.readers.PASTE, text: text('#input-format-example') }]);
    if (p.devices.length !== 2 || p.unrecognized.length || p.partial.length) throw new Error('格式範例本身應完全認得：' + JSON.stringify([p.unrecognized, p.partial]));
  });
  await step('輸入對話框：預檢即時顯示認到幾台、哪些段落無法辨識（可展開清單）；0 台時停用建立並說明', async () => {
    const t = $('#input-text'); const btn = $('#input-build'); const pf = () => text('#input-preflight');
    const type = async (v) => { t.value = v; t.dispatch('input'); await new Promise((r) => setTimeout(r, 450)); };
    if (!btn.disabled || !pf().includes('尚未輸入')) throw new Error('沒有輸入時應停用建立：' + pf());
    await type('隨便一段文字');
    if (!pf().includes('認到 0 台設備') || !pf().includes('1 段無法辨識') || !btn.disabled) throw new Error('0 台設備時應停用並說明：' + pf());
    if (!pf().includes('設備名 (管理 IP):') || !pf().includes(`${S.view.fileName(S.readers.PASTE)} 第 1–1 行：沒有設備標頭`)) throw new Error('應說明原因並列出檔名與行號：' + pf());
    if ($('#input-preflight-list').tagName !== 'DETAILS') throw new Error('清單應可展開');
    await type(text('#input-format-example') + '\n### /foo bar print\nxyz\n');
    if (!pf().includes('認到 2 台設備') || !pf().includes('1 段無法辨識') || btn.disabled) throw new Error('有設備時應可建立：' + pf());
    if (!pf().includes('TPE_CORE_RT_01') || !pf().includes(S.query.dataLabel('system')) || !pf().includes('/foo bar print')) throw new Error('清單應列出設備、資料種類與無法辨識的段落：' + pf());
    // 展開狀態跨重算保留
    const list = $('#input-preflight-list'); list.open = true; list.dispatch('toggle');
    await type(text('#input-format-example'));
    if ($('#input-preflight-list').getAttribute('open') === null || !pf().includes('沒有無法辨識的段落')) throw new Error('重算後清單應保持展開：' + pf());
    t.value = '還是沒有標頭'; btn.click(); await new Promise((r) => setTimeout(r, 20)); // 程式直接改文字、沒有 input 事件：建立時也要重新預檢
    if (App.snap || !text('#input-status').includes('沒有認到任何設備')) throw new Error('0 台設備時不應建立：' + text('#input-status'));
    await type('');
    $('#input-file').dispatch('change', { target: { files: [{ name: 'EDGE_SW_9.txt', text: async () => '### /ip arp print detail without-paging\n 0 address=10.0.0.2 mac-address=AA:BB:CC:00:00:01 interface=bridge1\n' }] } });
    await new Promise((r) => setTimeout(r, 20));
    if (!pf().includes('認到 1 台設備') || !pf().includes('EDGE_SW_9')) throw new Error('選檔後應立即預檢：' + pf());
    const rm = $('#input-files').querySelector('.chip-x');
    if (!rm || rm.tagName !== 'BUTTON' || rm.getAttribute('aria-label') !== '移除 EDGE_SW_9.txt') throw new Error('已選檔案的移除應是有名稱的按鈕');
    rm.click();
    if (!pf().includes('尚未輸入')) throw new Error('移除檔案後應重新預檢：' + pf());
    if (document.activeElement !== $('#input-pick')) throw new Error('移除最後一個檔案後焦點應回到「選擇檔案…」');
    // 沒有設備標頭、內容都認不得的檔案：以檔名當設備名，但沒有資料，不算認到（S.query.preflightRecognized，與 CLI 同一個判斷）
    $('#input-file').dispatch('change', { target: { files: [{ name: 'junk.txt', text: async () => 'hello\nworld\n' }] } });
    await new Promise((r) => setTimeout(r, 20));
    if (!pf().includes('認到 0 台設備') || !btn.disabled || !pf().includes('沒有可用的資料')) throw new Error('只有檔名、沒有資料的設備不算認到：' + pf());
    $('#input-files').querySelector('.chip-x').click();
    await App.loadSample();
    const sp = S.preflight([{ name: S.readers.PASTE, text: S.samples['sample-bundle.txt'] }]);
    if (!pf().includes(`認到 ${S.view.num(sp.devices.length)} 台設備`) || !pf().includes(`${S.view.num(sp.unrecognized.length)} 段無法辨識`) || btn.disabled) throw new Error('載入範例後應立即預檢：' + pf());
    // 建立失敗：在對話框的狀態列以中文說明（程式錯誤的英文訊息只放在括號說明內），不用 alert（模擬的 alert 會丟例外）
    const realBuild = S.buildAsync; S.buildAsync = async () => { throw new TypeError('x is not a function'); };
    const ce = console.error; console.error = () => {};
    try { btn.click(); await new Promise((r) => setTimeout(r, 20)); } finally { S.buildAsync = realBuild; console.error = ce; }
    if (!text('#input-status').startsWith('無法建立基準：程式發生未預期的錯誤') || !text('#input-status').includes('x is not a function')) throw new Error('建立失敗應以中文說明：' + text('#input-status'));
    S.buildAsync = async () => { throw new Error('命名規則檔有誤：\n- id 必填'); }; console.error = () => {};
    try { btn.click(); await new Promise((r) => setTimeout(r, 20)); } finally { S.buildAsync = realBuild; console.error = ce; }
    if (text('#input-status') !== '無法建立基準：命名規則檔有誤：\n- id 必填') throw new Error('核心的中文錯誤應原樣顯示：' + text('#input-status'));
    // 畫面層不用 alert（擋住畫面、不在狀態列留下紀錄）；例外轉成使用者訊息只經 V.reason（dom.js），不直接把 e.message／String(e) 放進畫面
    if (S.view.reason(new SyntaxError('Unexpected token')) !== '檔案不是有效的 JSON（Unexpected token）') throw new Error('V.reason 應說明 JSON 格式錯誤');
    ['src/view'].forEach((dir) => (function walk(d) {
      fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).forEach((e) => {
        const p = path.join(d, e.name); if (e.isDirectory()) return walk(p);
        if (!/\.js$/.test(e.name)) return;
        const src = fs.readFileSync(path.join(ROOT, p), 'utf8');
        if (/(^|[^.\w])alert\(/.test(src)) throw new Error('畫面不應使用 alert()：' + p);
        if (p !== path.join('src', 'view', 'dom.js') && /\b(e|err|error|ex)\.message\b|String\((e|err|error|ex)\)/.test(src)) throw new Error('例外訊息應經 V.reason(e) 轉成中文：' + p);
      });
    })(dir));
    $('#dlg-input').close();
  });
  await step('歡迎畫面的「建立基準…」與「用範例資料試試看」在 JS 綁定（CSP 不放行內嵌事件屬性）', async () => {
    const open = $('#welcome-input'); const sample = $('#welcome-sample');
    [open, sample].forEach((b) => { if (!b || b.tagName !== 'BUTTON' || b.getAttribute('type') !== 'button' || b.getAttribute('onclick') !== null) throw new Error('歡迎畫面的按鈕應是 type=button、沒有 onclick 屬性'); });
    $('#input-text').value = ''; open.click(); await new Promise((r) => setTimeout(r, 20));
    if (!$('#dlg-input').open || $('#input-text').value.includes('TPE_CORE_RT_01')) throw new Error('「建立基準…」應開啟輸入對話框（不帶範例）');
    $('#dlg-input').close(); sample.click(); await new Promise((r) => setTimeout(r, 20));
    if (!$('#dlg-input').open || $('#input-text').value !== S.samples['sample-bundle.txt']) throw new Error('「用範例資料試試看」應開啟輸入對話框並填入範例');
    $('#dlg-input').close();
  });
  await step('載入範例並建立基準', async () => {
    await App.loadSample(); if (!$('#input-text').value.includes('TPE_CORE_RT_01')) throw new Error('範例未載入');
    if (process.env.SMOKE_INPUT) $('#input-text').value = fs.readFileSync(process.env.SMOKE_INPUT, 'utf8');
    const t0 = Date.now();
    $('#input-build').click(); for (let i = 0; i < 4000 && !App.snap; i++) await new Promise((r) => setTimeout(r, 5));
    if (process.env.SMOKE_INPUT) console.log('      建立＋繪製：' + (Date.now() - t0) + ' ms，節點 ' + App.graph.nodes.length);
    if (!App.snap) throw new Error('基準未建立：' + text('#input-status'));
    await App.layoutJob;
    await new Promise((r) => setTimeout(r, 20));
    // 依輸入判斷：範例資料刻意含 K01（LLDP 單向），乾淨的大型網路可能沒有
    const k01 = App.snap.findings.find((f) => f.id === 'K01');
    if (!process.env.SMOKE_INPUT && !k01) throw new Error('範例資料應有 K01（LLDP 單向）');
    if (k01 && !text('#pane-findings').includes(k01.title)) throw new Error('檢查結果未顯示');
    if (!k01 && text('#pane-findings').includes(S.check.CATALOG.K01.title)) throw new Error('沒有 K01 時不應列出 LLDP 單向');
    if (!$('#welcome').classList.contains('hidden')) throw new Error('歡迎畫面未隱藏');
    const collected = App.snap.model.devices.find((device) => device.collected);
    App.select({ type: 'device', key: collected.key });
    if (!$('#detail .chip-list') || !$('#detail .chip-list').testAll('.chip').length) throw new Error('設備收集資料標籤應使用可間隔換行的 chip-list');
  });
  await step('「驗證」本輪變化：「新出現」含提醒時寫明（和只算錯誤與警告的「待處理」口徑不同），title 說明', () => {
    const VA = S.view.app; const round = VA.ledgerState().round; goStep('verify');
    const neu = round ? round.changes.filter((c) => c.reason === 'new') : [];
    const nInfo = neu.filter((c) => { const i = App.Q.findingIndexByKey(c.key); return i >= 0 && App.Q.finding(i).severity === 'info'; }).length;
    // 第一輪沒有上一輪可比對：不寫「新出現 N」（全部都會算新出現，容易誤會），改寫第一輪（UX #18）
    const first = $('#round-body').querySelector('.round-first');
    if (VA.ledgerRoundIndex() === 0) {
      if (!first || !first.textContent.includes('第一輪，沒有可比對的上一輪') || $('#round-body').testAll('.chip').some((c) => c.textContent.startsWith('新出現'))) throw new Error('第一輪應寫「第一輪，沒有可比對的上一輪」，不列新出現：' + text('#round-body').slice(0, 200));
      if (!first.textContent.includes(`${S.view.num(neu.length)} 項`)) throw new Error('第一輪寫出記進處理紀錄的筆數：' + first.textContent);
    } else if (first) throw new Error('第二輪以後不寫第一輪');
    // 用字：「接受風險」「接受風險到期」，和處理紀錄的狀態同一個詞
    if (/豁免到期|已豁免/.test(text('#view-verify'))) throw new Error('驗證頁應寫「接受風險」「接受風險到期」：' + (text('#view-verify').match(/.{0,20}(豁免到期|已豁免).{0,20}/) || [])[0]);
    const chip = first || $('#round-body').testAll('.chip').find((c) => c.textContent.startsWith('新出現'));
    if (!chip) throw new Error('本輪變化應有「新出現」');
    if (nInfo && (!chip.textContent.includes(`（含提醒 ${nInfo}`) || !String(chip.getAttribute('title')).includes('提醒不算進待處理'))) throw new Error('「新出現」含提醒時應寫明並在 title 說明：' + chip.textContent);
    if (!nInfo && chip.textContent.includes('提醒')) throw new Error('沒有提醒時不應標示含提醒：' + chip.textContent);
    if (!process.env.SMOKE_INPUT && !nInfo) throw new Error('測試前提：範例第一輪的新出現應含提醒');
    App.showView('graph');
  });
  await step('分層版面（ELK）：所有節點都有座標、各群外框不重疊、完成後有提示', async () => {
    if (App.layoutMode !== 'elk') throw new Error('預設應為分層版面');
    if (loadedScripts.join() !== S.view.layout.ELK_SRC) throw new Error('需要分層版面時應載入一次 ELK：' + loadedScripts.join());
    if (process.env.SMOKE_INPUT) console.log('      ' + text('#banner'));
    else if (!text('#banner').includes('已套用分層版面')) throw new Error('分層版面完成後應提示：' + text('#banner'));
    // 通知不寫耗時；台數和基準狀態卡、資料中心同一個口徑（Q.coverageSummary 的網路設備）
    if (!process.env.SMOKE_INPUT && (/\bms\b|毫秒/.test(text('#banner')) || !text('#banner').includes(`${S.view.num(App.Q.coverageSummary().network)} 台網路設備`))) throw new Error('分層版面的通知不寫耗時、台數用網路設備口徑：' + text('#banner'));
    const g = App.graph; const box = new Map();
    g.nodes.forEach((n) => {
      const p = g.pos.get(n.id);
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('節點沒有座標：' + n.id);
      const b = S.util.getOr(box, n.group || '', () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
      b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y); b.x1 = Math.max(b.x1, p.x); b.y1 = Math.max(b.y1, p.y);
    });
    const bs = Array.from(box.entries());
    bs.forEach(([na, a], i) => bs.slice(i + 1).forEach(([nb, b]) => {
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) throw new Error(`分群外框重疊：${na} / ${nb}`);
    }));
  });
  await step('分層版面超過上限時退回現有版面並說明原因', async () => {
    const before = JSON.stringify(Array.from(App.graph.pos));
    const max = App.ELK_MAX; App.ELK_MAX = 1;
    try { $('#btn-relayout').click(); await App.layoutJob; } finally { App.ELK_MAX = max; }
    if (!text('#banner').includes('超過分層版面上限')) throw new Error('應說明分層版面未套用的原因：' + text('#banner'));
    if (JSON.stringify(Array.from(App.graph.pos)) !== before) throw new Error('未套用時不應改動現有位置');
    // 版面▾ 選單的單選項目（menuitemradio）：選了就依新的版面重新排列，aria-checked 跟著換
    const mode = (k) => $('#layout-mode').testAll('.menu-item').find((b) => b.dataset.layout === k);
    mode('builtin').click(); await App.layoutJob;
    if (App.layoutMode !== 'builtin') throw new Error('應可切換為快速版面');
    if (mode('builtin').getAttribute('aria-checked') !== 'true' || mode('elk').getAttribute('aria-checked') !== 'false') throw new Error('版面的單選項目應標出目前的版面');
    mode('elk').click(); await App.layoutJob;
  });
};
