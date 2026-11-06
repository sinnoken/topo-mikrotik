// 畫面冒煙測試的 step：工具列與選單、設定、流程步驟與步驟狀態。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { html, body, docListeners, winListeners, document, S, MD, fs, path, ROOT, step, contrastOf, cssVarsOf, SCHEMES, hubBtn, stepBtn, goStep, settingsTab, searchFor, $, text, L4 } = require('../helpers.js');

module.exports = async () => {
  await step('滑過左右欄與工具列時不會穿透觸發拓樸圖 hover', () => {
    const g = App.graph; const cv = $('#graph');
    const move = (target, p) => (winListeners.pointermove || []).forEach((f) => f({ target, clientX: p.x, clientY: p.y, pointerType: 'mouse' }));
    const n = g.nodes.find((x) => g.visible(x)); const p = g.toScreen(g.pos.get(n.id));
    move(cv, p); if (!g.hover || g.hover.id !== n.id) throw new Error('畫布上的節點應可 hover');
    [$('#left'), $('#right'), $('#btn-fit')].forEach((el) => {
      move(el, p);
      if (g.hover) throw new Error(`指標在 #${el.id} 上時不應 hover 到底下的節點`);
      if (!$('#tooltip').classList.contains('hidden')) throw new Error('指標離開畫布時提示應隱藏');
    });
  });
  await step('工具列的路由追蹤、匯出 PNG 與選單：只有一個路由追蹤入口；方向鍵移動、Esc 關閉並還焦點、點外面關閉；勾選與單選以 aria-checked 標示；通知不遮工具列', () => {
    const pop = $('#trace-pop'); const tr = $('#btn-trace');
    const esc = () => (docListeners.keydown || []).forEach((f) => f({ key: 'Escape', preventDefault() {} }));
    const outside = (target) => (docListeners.mousedown || []).forEach((f) => f({ target }));
    App.showStep('triage'); App.showLayer('device');
    // 頁首只有資料中心與 ⚙ 設定；路由追蹤與匯出 PNG 在拓樸圖的工具列（id 不變），表單也在工具列
    if ($('#btn-more') || $('#more-menu')) throw new Error('頁首不應再有「⋯」選單');
    if (!['#btn-trace', '#btn-png', '#trace-pop'].every((x) => $('#toolbar').contains($(x)))) throw new Error('路由追蹤、匯出 PNG 與追蹤表單應在拓樸圖的工具列');
    const traceEntries = document.testAll('button').filter((b) => /路由追蹤/.test(b.textContent) && !$('#detail').contains(b) && !$('#hub').contains(b));
    if (traceEntries.length !== 1 || traceEntries[0] !== tr) throw new Error('只留一個路由追蹤入口：' + traceEntries.map((b) => b.textContent).join('、'));
    if (tr.getAttribute('aria-haspopup') !== 'dialog' || tr.getAttribute('aria-controls') !== 'trace-pop' || pop.getAttribute('role') !== 'dialog') throw new Error('「路由追蹤…」應是開啟對話框的按鈕');
    // PNG 只有拓樸圖的層級（L4 是矩陣，有自己的 CSV）；路由追蹤每一層都可用
    App.showLayer('l4'); if (!$('#btn-png').classList.contains('hidden') || tr.classList.contains('hidden')) throw new Error('L4 時隱藏匯出 PNG、保留路由追蹤');
    App.showLayer('device'); if ($('#btn-png').classList.contains('hidden') || $('#btn-png').disabled || tr.disabled) throw new Error('設備圖時匯出 PNG 與路由追蹤可用');
    // 開啟：焦點到輸入框、aria-expanded；Esc 關閉後焦點回到「路由追蹤…」；再按一次按鈕關閉；點外面也關閉
    tr.click();
    if (pop.classList.contains('hidden') || tr.getAttribute('aria-expanded') !== 'true' || ![$('#trace-src'), $('#trace-dst')].includes(document.activeElement)) throw new Error('「路由追蹤…」應開啟表單並聚焦輸入框');
    esc(); if (!pop.classList.contains('hidden') || document.activeElement !== tr || tr.getAttribute('aria-expanded') !== 'false') throw new Error('Esc 應關閉路由追蹤並把焦點還給「路由追蹤…」');
    tr.click(); tr.click(); if (!pop.classList.contains('hidden')) throw new Error('再按一次「路由追蹤…」應關閉表單');
    App.openTrace(); outside(tr); if (pop.classList.contains('hidden')) throw new Error('按「路由追蹤…」本身不算點外面');
    outside($('#graph')); if (!pop.classList.contains('hidden')) throw new Error('點外面應關閉路由追蹤');
    // 從「修正」開啟（例如詳情的「追蹤路由」）：先回到拓樸圖，表單才看得到
    App.showStep('fix'); App.openTrace();
    if (App.centerView !== 'graph' || pop.classList.contains('hidden')) throw new Error('從工作畫面開啟路由追蹤時應回到拓樸圖');
    S.view.app.closeTrace(false);
    // 版面▾：開啟時焦點到第一項，↓／End 移動並循環，Esc 關閉並還焦點；點外面、文件層級的 Esc 也關閉
    const lb = $('#btn-layout-menu'); const lm = $('#layout-menu');
    const lmItems = Array.from(lm.querySelectorAll('.menu-item'));
    lb.click();
    if (lm.classList.contains('hidden') || lb.getAttribute('aria-expanded') !== 'true' || document.activeElement !== lmItems[0]) throw new Error('開啟版面選單後焦點應在第一項');
    lm.dispatch('keydown', { key: 'ArrowDown' }); if (document.activeElement !== lmItems[1]) throw new Error('↓ 應移到下一項');
    lm.dispatch('keydown', { key: 'End' }); if (document.activeElement !== lmItems[lmItems.length - 1]) throw new Error('End 應移到最後一項');
    lm.dispatch('keydown', { key: 'ArrowDown' }); if (document.activeElement !== lmItems[0]) throw new Error('↓ 在最後一項時應繞回第一項');
    lm.dispatch('keydown', { key: 'Escape' });
    if (!lm.classList.contains('hidden') || lb.getAttribute('aria-expanded') !== 'false' || document.activeElement !== lb) throw new Error('Esc 應關閉選單並把焦點還給按鈕');
    lb.click(); outside($('#graph')); if (!lm.classList.contains('hidden')) throw new Error('點選單外面應關閉');
    lb.click(); esc(); if (!lm.classList.contains('hidden') || document.activeElement !== lb) throw new Error('文件層級的 Esc 也應關閉選單並還焦點');
    // ↑ 開啟時焦點到最後一項；單選的版面與力導向都是選單項目
    lb.dispatch('keydown', { key: 'ArrowUp' });
    if (lm.classList.contains('hidden') || document.activeElement !== $('#btn-force')) throw new Error('↑ 開啟版面選單時焦點應在最後一項');
    if ($('#layout-mode').testAll('.menu-item').some((b) => b.getAttribute('role') !== 'menuitemradio')) throw new Error('版面應是單選的選單項目');
    lm.dispatch('keydown', { key: 'Escape' }); if (document.activeElement !== lb || !lm.classList.contains('hidden')) throw new Error('Esc 應關閉版面選單並還焦點');
    // 顯示▾：勾選項目（data-keep）按了不關閉，aria-checked 跟著狀態
    const vb = $('#btn-view-menu'); const vm_ = $('#view-menu'); const hosts = $('#btn-hosts');
    vb.click(); const was = App.showHosts;
    if (hosts.getAttribute('aria-checked') !== String(was)) throw new Error('主機的勾選狀態應與畫面一致');
    hosts.click(); vm_.dispatch('click', { target: hosts });
    if (App.showHosts === was || hosts.getAttribute('aria-checked') !== String(!was) || vm_.classList.contains('hidden')) throw new Error('勾選項目按了應切換並保持選單開啟');
    hosts.click(); if (App.showHosts !== was) throw new Error('再按一次應還原');
    $('#btn-fit').click(); vm_.dispatch('click', { target: $('#btn-fit') });
    // 換層級時選單收起；L2 只有主機（未知對端、分群只在設備圖）
    App.showLayer('l2'); if (!vm_.classList.contains('hidden')) throw new Error('換層級時應收起選單');
    if (!$('#btn-unknown').classList.contains('hidden') || !$('#btn-groups').classList.contains('hidden') || $('#btn-hosts').classList.contains('hidden')) throw new Error('L2 的顯示選單只有主機');
    App.showLayer('device');
    if ($('#btn-unknown').classList.contains('hidden')) throw new Error('設備圖的顯示選單應有未知對端');
    // 通知在圖的下方中央（不遮左上角的工具列），數秒後淡出；操作提示也會淡出
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    const bannerRule = (css.match(/\n\.banner \{([^}]*)\}/) || [])[1] || '';
    if (/(^|;)\s*top:/.test(bannerRule) || !/bottom:/.test(bannerRule)) throw new Error('通知應在圖的下方，不遮工具列：' + bannerRule);
    if (!/\.banner\.fading, \.hint\.fading \{[^}]*opacity: 0/.test(css)) throw new Error('通知與操作提示應淡出');
    // 窄螢幕：圖上方最多兩列——頁首只有流程步驟（不換行），搜尋與 ⚙ 移到工作區列的右端；清除不再單獨佔一列
    const narrow = css.slice(css.lastIndexOf('@media (max-width: 900px) {', css.indexOf('#app { height: 100dvh')));
    // 依選擇器取出規則的宣告（屬性 → 值；同一個選擇器有多條規則時依先後合併），比對屬性與值，不比對空白與屬性的先後
    const decl = (src, sel) => {
      const ms = Array.from(src.matchAll(new RegExp('(?:^|[\\n}])\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')));
      if (!ms.length) throw new Error('窄螢幕的 CSS 缺少規則：' + sel);
      return Object.assign({}, ...ms.map((m) => Object.fromEntries(m[1].split(';').map((s) => s.trim()).filter(Boolean).map((s) => { const i = s.indexOf(':'); return [s.slice(0, i).trim(), s.slice(i + 1).trim().replace(/\s+/g, ' ')]; }))));
    };
    const has = (sel, want, msg) => { const d = decl(narrow, sel); Object.entries(want).forEach(([k, v]) => { const got = d[k] || ''; if (v instanceof RegExp ? !v.test(got) : got !== v) throw new Error(`${msg}（${sel} 的 ${k}：${got || '沒有'}）`); }); };
    const hdrMsg = '窄螢幕的頁首應只有步驟，搜尋與 ⚙ 在工作區列右端';
    has('header', { 'flex-wrap': 'nowrap' }, hdrMsg); has('.steps', { flex: /^1 1 100%/ }, hdrMsg);
    has('.search, .header-actions', { position: 'absolute', top: /^calc\(100% \+ 6px\)/ }, hdrMsg);
    has('.mobile-workspaces', { display: 'flex', padding: /^5px calc\(/ }, hdrMsg);
    if (/#btn-clear \{ margin-left/.test(css)) throw new Error(hdrMsg);
    // 搜尋收成圖示：平常是一格寬、看不到 placeholder，聚焦時展開蓋住整列（純 CSS）；有無障礙名稱
    const searchMsg = '窄螢幕的搜尋應收成圖示、聚焦時展開';
    has('.search', { flex: 'none', width: /var\(--control-h\)/ }, searchMsg); has('.search input::placeholder', { color: 'transparent' }, searchMsg);
    has('.search:focus-within', { left: '8px', right: '8px' }, searchMsg);
    if ($('#search').getAttribute('aria-label') !== '搜尋') throw new Error('收成圖示的搜尋框應有無障礙名稱');
    // 品牌只給螢幕閱讀器、資料中心按鈕由「輸入」取代；資料中心或設定開啟時搜尋與 ⚙ 隱藏（不疊在上面）
    const brandMsg = '窄螢幕的頁首應隱藏品牌與資料中心按鈕';
    has('header .brand', { position: 'absolute', width: '1px' }, brandMsg); has('header .hub-btn', { display: 'none' }, brandMsg);
    has('#app.hub-open header .search, #app.hub-open header .header-actions', { display: 'none' }, brandMsg);
    has('#app.settings-open header .search, #app.settings-open header .header-actions', { display: 'none' }, '窄螢幕的設定開著時，搜尋與 ⚙ 不疊在設定上');
    // 頁首可見的控制項：每一步一個按鈕＋搜尋＋⚙；工作區列每個工作區一個按鈕（不重複）
    const steps = $('#steps').testAll('button').map((b) => b.dataset.step);
    const STEP_LABEL = S.view.app.STEP_LABEL;
    if (steps.length !== Object.keys(STEP_LABEL).length || steps.some((s) => !STEP_LABEL[s])) throw new Error('步驟列應每一步一個按鈕：' + steps);
    const wss = $('#mobile-workspaces').testAll('button').map((b) => b.dataset.workspace);
    if (!wss.length || new Set(wss).size !== wss.length) throw new Error('工作區列應每個工作區一個按鈕：' + wss);
  });
  await step('設定（⚙）：開關與焦點、五個分類可用滑鼠與鍵盤切換、Esc 關閉並還焦點、與資料中心互斥；一般、命名規則、本機資料、收集、關於各有實際內容', async () => {
    const VA = S.view.app; const gear = $('#btn-settings'); const box = $('#settings');
    const esc = (target) => (docListeners.keydown || []).forEach((f) => f({ key: 'Escape', target, preventDefault() {} }));
    App.showStep('triage');
    if (!gear || gear.textContent.trim() !== '⚙' || gear.getAttribute('aria-label') !== '設定' || !gear.getAttribute('title') || gear.getAttribute('aria-controls') !== 'settings') throw new Error('頁首應有 ⚙（aria-label「設定」、有 title、控制 #settings）');
    if (!$('#app').querySelector('.header-actions').contains(gear)) throw new Error('⚙ 應在頁首右側');
    // 開啟：蓋住主畫面（主畫面 inert）、焦點到「設定」標題
    gear.click();
    if (box.classList.contains('hidden') || gear.getAttribute('aria-expanded') !== 'true' || !$('#main').inert || !$('#app').classList.contains('settings-open')) throw new Error('按 ⚙ 應開啟設定並蓋住主畫面');
    if (document.activeElement !== $('#settings-title')) throw new Error('開啟後焦點應移到「設定」標題');
    // 五個分類：tablist，順序固定，一次只選一個；分類內容的標題與分頁同名
    const tabs = box.testAll('.settings-tab');
    const LABELS = ['一般', '命名規則', '本機資料', '收集與建立基準', '關於'];
    if (tabs.map((b) => b.textContent).join() !== LABELS.join() || tabs.some((b) => b.getAttribute('role') !== 'tab') || tabs[0].parentNode.getAttribute('role') !== 'tablist') throw new Error('設定應有五個分類的分頁：' + tabs.map((b) => b.textContent).join());
    if (JSON.stringify(VA.SETTINGS_SECTIONS) !== JSON.stringify(tabs.map((b) => b.dataset.section))) throw new Error('分頁應與 A.SETTINGS_SECTIONS 一致');
    const selected = () => box.testAll('.settings-tab').filter((b) => b.getAttribute('aria-selected') === 'true');
    const check = (id, why) => {
      const sel = selected(); const panel = $('#settings-panel');
      if (sel.length !== 1 || sel[0].dataset.section !== id || panel.getAttribute('aria-labelledby') !== sel[0].id || panel.getAttribute('role') !== 'tabpanel') throw new Error(why + '：' + sel.map((b) => b.dataset.section).join());
      if (text('#settings-panel-title') !== sel[0].textContent) throw new Error('內容的標題應與分頁同名');
      if (box.testAll('.settings-tab').some((b) => b.getAttribute('tabindex') !== (b === sel[0] ? '0' : '-1'))) throw new Error('只有選取的分頁在 Tab 順序內（roving tabindex）');
      if (!$('#settings-panel').querySelector('.settings-content').childNodes.length) throw new Error(id + ' 應有內容');
    };
    check('general', '預設是「一般」');
    // 鍵盤：↓／→ 下一個、↑／← 上一個（循環）、Home、End；焦點跟著選取的分頁
    const key = (k) => { const cur = selected()[0]; cur.dispatch('keydown', { key: k }); };
    key('ArrowDown'); check('profiles', '↓ 應換到下一個分類'); if (document.activeElement !== selected()[0]) throw new Error('鍵盤切換後焦點應在新的分頁');
    key('ArrowRight'); check('data', '→ 也應換到下一個分類');
    key('End'); check('about', 'End 應到最後一個分類');
    key('ArrowDown'); check('general', '↓ 在最後一個時應繞回第一個');
    key('ArrowUp'); check('about', '↑ 在第一個時應繞到最後一個');
    key('Home'); check('general', 'Home 應到第一個分類');
    // 滑鼠：點分頁換分類
    LABELS.forEach((l, i) => { tabs[i] && settingsTab(VA.SETTINGS_SECTIONS[i]).click(); check(VA.SETTINGS_SECTIONS[i], '點「' + l + '」應換到該分類'); });
    // 一般：預設版面（store 的 'layoutMode'，與工具列「版面 ▾」同一個值，不重新排列目前的圖）
    settingsTab('general').click();
    const lay = (v) => box.testAll('.settings-radio').find((r) => r.dataset.setting === 'layout' && r.value === v);
    if (!App.LAYOUT_MODES.every(lay) || !lay(App.layoutMode).checked) throw new Error('「一般」應有每個版面各一個選項，勾選目前的版面');
    const mode0 = App.layoutMode; const other = App.LAYOUT_MODES.find((m) => m !== mode0); const pos0 = JSON.stringify(Array.from(App.graph.pos.entries()));
    lay(other).focus(); lay(other).checked = true; lay(other).dispatch('change'); await new Promise((r) => setTimeout(r, 5));
    if (App.layoutMode !== other || (await S.store.get('layoutMode')) !== other) throw new Error('預設版面應存進 store 的 layoutMode');
    const menuItem = $('#layout-mode').testAll('.menu-item').find((b) => b.dataset.layout === other);
    if (menuItem.getAttribute('aria-checked') !== 'true') throw new Error('工具列「版面 ▾」的勾選應跟著預設版面');
    if (JSON.stringify(Array.from(App.graph.pos.entries())) !== pos0) throw new Error('改預設版面不應重新排列目前的圖');
    // 重繪後焦點留在同一個選項（data-settings-focus）
    VA.renderSettings(); if (document.activeElement !== lay(other)) throw new Error('重繪後焦點應留在同一個選項');
    // 工具列改版面時，設定裡的勾選跟著換
    $('#layout-mode').testAll('.menu-item').find((b) => b.dataset.layout === mode0).click(); await App.layoutJob;
    if (!lay(mode0).checked || lay(other).checked) throw new Error('工具列改版面時設定裡的勾選應跟著換');
    // 命名規則：列出每一份 S.profiles 的 id 與名稱
    settingsTab('profiles').click();
    const rows = $('#settings-panel').testAll('tr').filter((r) => r.dataset.profile);
    const ids = Object.values(S.profiles).filter((p) => p && p.id).map((p) => p.id);
    if (!ids.length || rows.map((r) => r.dataset.profile).join() !== ids.join()) throw new Error('命名規則應列出每一份可用的命名規則：' + rows.map((r) => r.dataset.profile).join());
    ids.forEach((id) => { const p = S.profiles[id]; const r = rows.find((x) => x.dataset.profile === id); if (p.label && !r.textContent.includes(p.label)) throw new Error('命名規則應列出名稱：' + id); });
    // 收集與建立基準：指令清單與歡迎畫面同一份（S.collectCommands）
    settingsTab('help').click();
    const cmds = S.collectCommands.default.map((c) => c.command).join('\n');
    if (text('#settings-commands') !== cmds) throw new Error('「收集與建立基準」的指令清單應取自 S.collectCommands');
    if (!S.collectCommands.optional.every((c) => text('#settings-panel').includes(c.command))) throw new Error('應列出只有部分設備才有的選單');
    const helpP = $('#settings-panel'); const helpT = helpP.textContent;
    // 收集：collect.sh 的用法與 devices.csv 範例；範例的標題列與每一列都取自 repo 的 tools/devices.csv（collect.sh 的實際格式）
    const csvRepo = fs.readFileSync(path.join(ROOT, 'tools/devices.csv'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    const csv = $('#settings-devices-csv'); const csvLines = csv ? csv.textContent.split('\n').filter(Boolean) : [];
    if (!csv || csvLines[0] !== csvRepo[0] || csvLines.length < 2 || !csvLines.every((l) => csvRepo.includes(l))) throw new Error('devices.csv 範例應取自 tools/devices.csv（標題列＋至少一列）：' + (csv && csv.textContent));
    if (!/tools\/collect\.sh devices\.csv --dry-run/.test(helpT) || !/tools\/collect\.sh devices\.csv (-o|--output) \S+/.test(helpT)) throw new Error('應寫出 collect.sh 的 --dry-run 與輸出檔的用法');
    ['--device', '--commands', '--ask-password', '--retry-failed'].forEach((o) => { if (!helpT.includes(o)) throw new Error('應列出 collect.sh 的常用選項 ' + o); });
    if (!helpT.includes('bundle-v1') || !helpT.includes('設備名 (管理 IP):')) throw new Error('應說明輸出是 bundle-v1 收集檔與手動收集的「設備名 (管理 IP):」標頭');
    // 排程：npm run baseline 與三種結束碼（每個結束碼各一列）
    if (!/npm run baseline -- \S+ --ledger \S+ -o \S+/.test(helpT)) throw new Error('應寫出排程用的 npm run baseline 指令');
    const exits = helpP.testAll('.settings-exit dt').map((d) => d.textContent.trim());
    if (exits.join() !== '0,1,2') throw new Error('應列出 baseline 的三種結束碼：' + exits.join());
    // 輸出清單與結束碼 2 的說明與 CLI 同一份（tools/baseline.js 的 FILES 與 --help；瀏覽器無法載入 CLI，在這裡核對）
    const CLI = require(path.join(ROOT, 'tools/baseline.js'));
    const missing = Object.values(CLI.FILES).filter((f) => !helpT.includes(f));
    if (missing.length) throw new Error('排程說明的輸出清單應列出 tools/baseline.js 的每個輸出檔：缺 ' + missing.join('、'));
    if (!helpT.includes('網路文件')) throw new Error('排程說明應寫出 sitedoc.md／sitedoc.csv 是網路文件');
    const exitDd = helpP.testAll('.settings-exit dd').map((d) => d.textContent);
    const NO_DEVICE = '收集檔沒有認到任何設備的資料';
    let helpOut = ''; CLI.main(['--help'], { stdout: { write: (x) => { helpOut += x; } }, stderr: { write: () => {} } });
    if (!helpOut.includes(NO_DEVICE)) throw new Error('前提：baseline.js --help 的結束碼 2 說明應含「' + NO_DEVICE + '」');
    if (!exitDd[2] || !exitDd[2].includes(NO_DEVICE)) throw new Error('結束碼 2 的說明應與 --help 一致，含「' + NO_DEVICE + '」：' + exitDd[2]);
    if (!/cron|工作排程器/.test(helpT)) throw new Error('應說明可以放進 cron／工作排程器');
    // 一輪的流程：收集 → 建立基準 → 研判 → 修正 → 下一輪收集 → 驗證，修正只產生 .rsc 不連線設備，工作包帶走帶回
    const flow = helpP.querySelector('.settings-flow');
    const flowT = flow ? flow.testAll('li').map((l) => l.textContent) : [];
    const order = ['收集', '建立基準', '研判', '修正', '下一輪', '驗證'].map((w) => flowT.findIndex((t) => t.startsWith(w)));
    if (order.some((i) => i < 0) || order.some((i, n) => n && i <= order[n - 1])) throw new Error('應依序列出一輪的流程：' + flowT.join(' / '));
    if (!/\.rsc/.test(helpT) || !/不(會)?連線(任何)?設備/.test(helpT) || !helpT.includes('工作包')) throw new Error('應說明修正只產生 .rsc、不連線設備，以及工作包');
    // 每段的詳細規格以連結到文件（檔案存在、錨點對得到標題），新分頁開啟
    // 錨點依 GitHub 的規則（tests/lib.js 的 markdownAnchors，和 tests/docs.js 的連結檢查同一份）
    const checkDocLinks = (root, need) => {
      const links = root.testAll('a').filter((a) => a.classList.contains('doc-link'));
      need.forEach((f) => { if (!links.some((a) => decodeURI(a.getAttribute('href')).includes('/' + f))) throw new Error('應連到 ' + f); });
      links.forEach((a) => {
        const href = decodeURI(a.getAttribute('href')); const m = href.match(/\/blob\/main\/([^#]+)(?:#(.+))?$/);
        if (!m || !fs.existsSync(path.join(ROOT, m[1]))) throw new Error('文件連結應指向 repo 裡的檔案：' + href);
        if (m[2] && m[1].endsWith('.md') && !MD.hasAnchor(MD.anchorsOf(m[1]), m[2])) throw new Error('文件連結的錨點對不到標題：' + href);
        if (a.getAttribute('target') !== '_blank' || !/noopener/.test(a.getAttribute('rel') || '')) throw new Error('文件連結應在新分頁開啟（rel=noopener）：' + href);
      });
      return links;
    };
    checkDocLinks(helpP, ['README.md', 'docs/收集清單與輸入格式.md', 'docs/使用說明.md']);
    // 命名規則：連到設定的命名規則分類
    const toProfiles = helpP.testAll('button').find((b) => b.getAttribute('data-settings-focus') === 'to-profiles');
    if (!toProfiles) throw new Error('應有前往命名規則分類的按鈕');
    toProfiles.click(); check('profiles', '按鈕應換到命名規則分類'); settingsTab('help').click();
    // 關於：程式版本、各資料格式的版本（取自核心的常數）、離線與唯讀、ELK.js 的授權（路徑取自 V.layout.ELK_SRC）、文件與原始碼
    settingsTab('about').click();
    const aboutT = text('#settings-panel');
    if (!text('#app-version').includes(S.VERSION) || !aboutT.includes('EPL-2.0') || !aboutT.includes(S.view.layout.ELK_SRC.replace(/\/[^/]*$/, ''))) throw new Error('「關於」應列出版本與 ELK.js 的 EPL-2.0 授權：' + aboutT);
    [S.SCHEMA, S.ledger.SCHEMA, S.remediate.SCHEMA, S.workpack.SCHEMA].forEach((x) => { if (!aboutT.includes(x)) throw new Error('「關於」應列出資料格式 ' + x); });
    if (!aboutT.includes("connect-src 'none'") || !/不(會)?連線(任何)?設備/.test(aboutT)) throw new Error('「關於」應說明離線（CSP 禁止網路連線）與唯讀');
    const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
    if (!csp.includes("connect-src 'none'")) throw new Error('index.html 的 CSP 應含 connect-src none');
    const srcLink = checkDocLinks($('#settings-panel'), ['README.md']);
    if (!$('#settings-panel').testAll('a').some((a) => /^https:\/\/github\.com\/sinnoken\/topo-mikrotik\/?$/.test(a.getAttribute('href') || '')) || !srcLink.length) throw new Error('「關於」應連到文件與原始碼');
    [S.compare.SCHEMA_EXPECTED].forEach((x) => { if (typeof x !== 'string' || !aboutT.includes(x)) throw new Error('「關於」應列出預期現況的格式（S.compare.SCHEMA_EXPECTED）：' + x); });
    // 從 file:// 開啟（離線）：文件連結改連 repo 內的相對路徑（以 index.html 所在的 repo 根目錄為準），檔案存在；線上（https）仍連 GitHub 的 main
    { const loc0 = Object.getOwnPropertyDescriptor(globalThis, 'location');
      const offlineLinks = (cat) => { settingsTab(cat).click(); return $('#settings-panel').testAll('a').filter((a) => a.classList.contains('doc-link')); };
      try {
        Object.defineProperty(globalThis, 'location', { value: { protocol: 'file:', href: 'file://' + path.join(ROOT, 'index.html') }, configurable: true, writable: true });
        ['help', 'about', 'profiles'].forEach((cat) => {
          const ls = offlineLinks(cat); if (!ls.length) throw new Error(`離線時「${cat}」也應有文件連結`);
          ls.forEach((a) => {
            const href = a.getAttribute('href'); const file = decodeURI(href.split('#')[0]);
            if (/^[a-z]+:/i.test(href) || href.startsWith('/') || !fs.existsSync(path.join(ROOT, file))) throw new Error('離線時文件連結應是 repo 內存在的相對路徑：' + href);
            if (a.getAttribute('target') !== '_blank' || !/noopener/.test(a.getAttribute('rel') || '')) throw new Error('離線的文件連結也在新分頁開啟：' + href);
          });
        });
        globalThis.location = { protocol: 'https:', href: 'https://sinnoken.github.io/topo-mikrotik/' };
        offlineLinks('help').forEach((a) => { if (!a.getAttribute('href').startsWith('https://github.com/sinnoken/topo-mikrotik/blob/main/')) throw new Error('線上時文件連結應連到 GitHub 的 main：' + a.getAttribute('href')); });
      } finally { if (loc0) Object.defineProperty(globalThis, 'location', loc0); else delete globalThis.location; }
      settingsTab('about').click(); }
    // 搜尋框的 Esc 不關設定（只收起搜尋）；設定內的 Esc 關閉，焦點回到 ⚙
    esc($('#search')); if (box.classList.contains('hidden')) throw new Error('設定外的元素的 Esc 不應關閉設定');
    esc(settingsTab('about'));
    if (!box.classList.contains('hidden') || document.activeElement !== gear || $('#main').inert || gear.getAttribute('aria-expanded') !== 'false' || $('#app').classList.contains('settings-open')) throw new Error('Esc 應關閉設定並把焦點還給 ⚙');
    // 再開啟回到上次的分類；⚙ 再按一次關閉
    gear.click(); check('about', '再開啟時應回到上次的分類'); gear.click();
    if (!box.classList.contains('hidden') || document.activeElement !== gear) throw new Error('再按一次 ⚙ 應關閉設定並還焦點');
    // 指定分類與 opener：焦點到分類的標題，關閉後回到 opener
    const opener = $('#btn-fit');
    App.openSettings('help', { opener });
    if (document.activeElement !== $('#settings-panel-title')) throw new Error('指定分類開啟時焦點應到分類的標題');
    box.querySelector('.settings-close').click(); if (document.activeElement !== opener) throw new Error('「關閉」應把焦點還給開啟它的按鈕');
    try { App.openSettings('nope'); throw new Error('未知的分類應丟出 RangeError'); } catch (e) { if (!(e instanceof RangeError)) throw e; }
    // 與資料中心互斥：開一個就關另一個；換步驟、選取時也關閉
    App.openSettings(); App.openHub();
    if (!box.classList.contains('hidden') || $('#hub').classList.contains('hidden') || !$('#main').inert) throw new Error('開啟資料中心時應關閉設定');
    App.openSettings();
    if (box.classList.contains('hidden') || !$('#hub').classList.contains('hidden') || !$('#main').inert || $('#btn-hub').getAttribute('aria-expanded') !== 'false') throw new Error('開啟設定時應關閉資料中心');
    goStep('view'); if (!box.classList.contains('hidden') || $('#main').inert) throw new Error('換步驟時應關閉設定');
    App.openSettings(); App.select({ type: 'device', key: App.Q.devices()[0].key });
    if (!box.classList.contains('hidden')) throw new Error('選取時應關閉設定');
    App.select(null); goStep('triage');
    // 窄螢幕：單欄、分類改成上方一列（覆蓋一般樣式，寫在它之後）；不水平捲動
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    const base = css.indexOf('.settings-body { display: grid;'); const tail = css.slice(css.lastIndexOf('@media (max-width: 900px)'));
    if (base < 0 || css.lastIndexOf('@media (max-width: 900px)') < base || !/\.settings-body \{ grid-template-columns: minmax\(0, 1fr\);/.test(tail) || !/\.settings-tabs \{ flex-direction: row;/.test(tail)) throw new Error('窄螢幕時設定應改成單欄、分類在上方一列，且規則要在一般樣式之後');
    if (!/\.settings \{[^}]*overflow-x: hidden/.test(css)) throw new Error('設定不應水平捲動');
    if (!/\.settings-tab\.on \{[^}]*font-weight: 600/.test(css)) throw new Error('選取的分類除了顏色還要有粗體');
  });
  await step('流程步驟：五步都能切換（nav、aria-current="step"），左側清單與中間的工作畫面跟著換、焦點移到這一步的標題；切換不丟失畫布的位置、縮放與選取，也不重新排列；PNG 照常', async () => {
    const g = App.graph; const VA = S.view.app;
    const nav = $('#steps'); const btns = document.testAll('#steps button');
    if (nav.tagName !== 'NAV' || nav.getAttribute('aria-label') !== '流程步驟' || !nav.querySelector('ol')) throw new Error('流程步驟應是有名稱的 nav（ol 列出步驟）');
    if (btns.map((b) => b.dataset.step).join() !== 'input,view,triage,fix,verify') throw new Error('步驟應依序是 輸入、檢視、研判、修正、驗證：' + btns.map((b) => b.textContent).join('、'));
    if (!btns.every((b) => b.getAttribute('type') === 'button' && b.getAttribute('tabindex') === null && b.textContent.startsWith(VA.STEP_LABEL[b.dataset.step]) && !/[①-⑳]/.test(b.textContent))) throw new Error('每一步是可以 Tab 到的按鈕，文字以步驟名稱（VA.STEP_LABEL）開頭，不顯示序號：' + btns.map((b) => b.textContent).join('、'));
    if (document.testAll('#center-views').length || document.testAll('#left .tabs').length) throw new Error('左側五個分頁與中間的分頁已由流程步驟取代');
    // 每一步的左側清單與中間的工作畫面（「修正」、「驗證」沒有左側清單，中間全寬）
    const EXPECT = { view: ['pane-inventory', 'graph', '清單'], triage: ['pane-findings', 'graph', '檢查結果'], fix: [null, 'patch'], verify: [null, 'verify'] };
    const check = (s) => {
      const cur = btns.filter((b) => b.getAttribute('aria-current') === 'step');
      if (cur.length !== 1 || cur[0] !== stepBtn(s) || !btns.every((b) => ['step', 'false'].includes(b.getAttribute('aria-current')))) throw new Error('只有目前的一步是 aria-current="step"：' + s);
      if (!stepBtn(s).classList.contains('on')) throw new Error('目前的一步應有選取的樣式');
      if (s === 'input') {
        if ($('#hub').classList.contains('hidden') || document.activeElement !== $('#hub-title') || !$('#main').inert) throw new Error('「輸入」是資料中心：開啟、聚焦標題、主畫面 inert');
        return;
      }
      if (!$('#hub').classList.contains('hidden') || $('#main').inert) throw new Error('換到其他步驟時應關閉資料中心');
      const [left, center, title] = EXPECT[s];
      if (App.step !== s || App.centerView !== center || $('#center').dataset.view !== center || $('#main').dataset.step !== s) throw new Error(`${s} 的中間應是 ${center}`);
      if ($('#left').classList.contains('hidden') !== !left) throw new Error(`${s} 的左側清單應${left ? '顯示' : '隱藏'}`);
      ['pane-findings', 'pane-inventory'].forEach((id) => { if ($('#' + id).classList.contains('hidden') !== (id !== left)) throw new Error(`${s} 的左側應只顯示 ${left}`); });
      if (left && $('#left-title').textContent !== title) throw new Error(`${s} 的左側標題應是「${title}」`);
      ['patch', 'verify'].forEach((x) => { if ($('#view-' + x).classList.contains('hidden') !== (x !== center)) throw new Error('只顯示目前的工作畫面：' + x); });
      if (!!$('#view-graph').inert !== (center !== 'graph')) throw new Error('工作畫面蓋住拓樸圖時，拓樸圖應是 inert');
      if ($('#view-graph').classList.contains('hidden')) throw new Error('拓樸圖不可隱藏（display: none 會讓畫布變成 0 大小）');
      if (!$('#main').style.gridTemplateColumns.startsWith(left ? App.layout.left + 'px' : '0px')) throw new Error('沒有左側清單時左欄寬度為 0：' + $('#main').style.gridTemplateColumns);
      const focusTo = left ? $('#left-title') : $('#' + center + '-title');
      if (document.activeElement !== focusTo) throw new Error(`點 ${s} 後焦點應移到這一步的標題`);
    };
    // 先在圖上留下狀態：選取一台設備、平移與縮放、移動一個節點
    const dev = App.Q.devices().find((d) => g.nodeById.has(d.key));
    App.select({ type: 'device', key: dev.key });
    g.s = 1.37; g.tx = 123; g.ty = -45; const moved = { x: 777, y: 333 }; g.pos.set(dev.key, moved);
    const snapState = () => JSON.stringify({ s: g.s, tx: g.tx, ty: g.ty, pos: Array.from(g.pos), sel: App.sel, nodes: Array.from(g.sel.nodes), w: g.w, h: g.h, n: g.nodes.length });
    const before = snapState();
    // 切換期間不可重新排列或全圖（spy：版面計算、fit、ELK）
    const calls = []; const spy = (obj, k) => { const o = obj[k]; obj[k] = function (...a) { calls.push(k); return o.apply(this, a); }; return () => { obj[k] = o; }; };
    const undo = [spy(S.view.layout, 'layout'), spy(g, 'fit'), spy(VA, 'applyElk'), spy(VA, 'relayout')];
    try {
      // 每一步都能切換（含從資料中心直接到其他步、同一步再點一次）；鍵盤的 Enter／空白鍵在按鈕上就是 click
      ['input', 'view', 'triage', 'fix', 'verify', 'triage', 'input', 'fix', 'fix', 'verify', 'input', 'view'].forEach((s) => { goStep(s); check(s); });
      // 資料中心的「回到…」與 Esc：回到開啟前的那一步，焦點回到開啟它的步驟按鈕
      goStep('input');
      if (hubBtn('close-hub').textContent !== `回到「${VA.STEP_LABEL.view}」`) throw new Error('資料中心的關閉按鈕應寫出要回到哪一步：' + hubBtn('close-hub').textContent);
      (docListeners.keydown || []).forEach((f) => f({ key: 'Escape', preventDefault() {} }));
      if (!$('#hub').classList.contains('hidden') || App.step !== 'view' || document.activeElement !== stepBtn('input') || stepBtn('view').getAttribute('aria-current') !== 'step') throw new Error('Esc 關閉資料中心後應回到「檢視」，焦點回到「輸入」的按鈕');
      // PNG：在工作畫面也匯出同一張圖（畫布沒有被隱藏，大小不變）
      App.showStep('verify');
      let drew = 0; const oldDraw = g.draw; g.draw = function () { drew++; return oldDraw.call(this); };
      const made = []; const oldCreate = document.createElement;
      document.createElement = (t) => { const el = oldCreate(t); if (t === 'a') made.push(el); return el; };
      try { VA.exportPng(); } finally { g.draw = oldDraw; document.createElement = oldCreate; }
      if (!drew || made.length !== 1 || made[0].download !== 'topology.png' || !String(made[0].href).startsWith('data:')) throw new Error('在工作畫面時也應能匯出拓樸 PNG（同一張畫布）');
      App.showView('graph');
    } finally { undo.forEach((f) => f()); }
    if (calls.length) throw new Error('切換步驟不應重新排列或全圖：' + calls.join('、'));
    if (snapState() !== before) throw new Error('切換步驟後畫布的位置、縮放與選取應保留');
    // 從其他地方開啟（App.showView）：patch 是「修正」，trend、compare 是「驗證」的區塊；graph 回到上一次看圖的那一步（這裡是「檢視」）
    App.showView('trend', { focus: true }); if (App.step !== 'verify' || document.activeElement !== $('#trend-title')) throw new Error('開啟收斂趨勢時應到「驗證」，焦點移到收斂趨勢的標題');
    App.showView('compare', { focus: true }); if (App.step !== 'verify' || document.activeElement !== $('#compare-title')) throw new Error('開啟比對時應到「驗證」，焦點移到比對的標題');
    App.showView('patch', { focus: true }); if (App.step !== 'fix' || document.activeElement !== $('#patch-title')) throw new Error('開啟修正計畫時應到「修正」，焦點移到標題');
    App.showView('graph', { focus: true }); if (App.step !== 'view' || document.activeElement !== $('#graph')) throw new Error('回到拓樸圖時應回到上一次看圖的「檢視」，焦點移到畫布');
    try { App.showStep('nope'); throw new Error('未知的步驟應丟出 RangeError'); } catch (e) { if (!(e instanceof RangeError)) throw e; }
    // 在工作畫面點選設備：詳情在右側，工作畫面不切換；搜尋是在圖上定位，會切回拓樸圖
    goStep('triage'); App.showStep('verify'); App.select({ type: 'device', key: dev.key });
    if (App.centerView !== 'verify' || !text('#detail').includes(dev.name)) throw new Error('在工作畫面選取時，右側顯示詳情、工作畫面不切換');
    await searchFor(dev.name); const inp = $('#search');
    inp.dispatch('keydown', { key: 'Enter' });
    if (App.centerView !== 'graph' || App.step !== 'triage' || !App.sel) throw new Error('搜尋選取後應回到上一次看圖的「研判」');
    // 資料中心開著時切換工作畫面：先關閉資料中心
    App.openHub(); App.showView('patch');
    if (!$('#hub').classList.contains('hidden') || App.centerView !== 'patch') throw new Error('切到工作畫面時應關閉資料中心');
    // 窄螢幕：工作區依流程排列（清單 → 工作畫面 → 詳細資料），標籤跟著步驟；有清單的步驟先看清單，「修正」、「驗證」看工作畫面
    window.innerWidth = 390;
    const ws = () => document.testAll('#mobile-workspaces button');
    if (ws().map((b) => b.dataset.workspace).join() !== 'checks,graph,details') throw new Error('窄螢幕的工作區應依流程排列：清單、工作畫面、詳細資料');
    goStep('triage'); if ($('#main').dataset.workspace !== 'checks' || ws()[0].textContent !== '檢查結果' || ws()[1].textContent !== '拓樸圖') throw new Error('窄螢幕的「研判」應先顯示檢查結果');
    goStep('view'); if ($('#main').dataset.workspace !== 'checks' || ws()[0].textContent !== '清單') throw new Error('窄螢幕的「檢視」應先顯示清單');
    goStep('fix'); if ($('#main').dataset.workspace !== 'graph' || !ws()[0].classList.contains('hidden') || ws()[1].textContent !== '修正計畫') throw new Error('窄螢幕的「修正」沒有清單，顯示修正計畫');
    VA.setWorkspace('checks'); if ($('#main').dataset.workspace !== 'graph') throw new Error('沒有左側清單時不能切到清單工作區');
    VA.setWorkspace('details'); App.showView('compare');
    if ($('#main').dataset.workspace !== 'graph' || ws()[1].textContent !== '驗證') throw new Error('窄螢幕切到工作畫面時應顯示中間的工作區');
    window.innerWidth = 1200; goStep('triage'); VA.setWorkspace('graph'); App.showView('graph');
    // CSS：工作畫面疊在拓樸圖上、不水平捲動（寬表格在 V.table 的 .table-scroll 內捲動，另有測試）；強制色彩下目前的一步有系統色外框
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    if (!/\.work \{[^}]*position: absolute[^}]*overflow-x: hidden/.test(css)) throw new Error('工作畫面應疊在拓樸圖上，且不水平捲動');
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    if (!/\.steps button\[aria-current="step"\]/.test(forced.slice(0, forced.indexOf('\n}')))) throw new Error('強制色彩模式下目前的一步應有系統色外框');
    // 步驟的文字色對底色 ≥ 4.5:1：目前的一步（強調色／淺強調底）、其他步驟（次要文字色／頁首白底）
    SCHEMES.forEach((mode) => {
      const cv = cssVarsOf(css, mode);
      [[cv.accent, cv['accent-soft']], [cv.muted, cv.panel], [cv.text, cv['surface-hover']]].forEach(([fg, bg]) => {
        if (contrastOf(fg, bg) < 4.5) throw new Error(`${mode}：步驟的文字 ${fg} 對 ${bg} 只有 ${contrastOf(fg, bg).toFixed(2)}:1`);
      });
    });
    // 目前的一步不只靠顏色：粗體與底線
    if (!/\.steps button\[aria-current="step"\] \{[^}]*font-weight: 600[^}]*box-shadow: inset 0 -2px/.test(css)) throw new Error('目前的一步除了顏色，還要有粗體與底線');
    if (!/\.patch-layout \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/.test(css) || !/\.verify-layout \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/.test(css) || !/@container \(min-width: \d+px\)/.test(css)) throw new Error('修正計畫與驗證預設單欄，工作畫面夠寬時才分兩欄');
    // 窄螢幕的步驟列：五步等寬、可以換行（不出現水平捲動，目前的一步一定看得到），放在一般樣式之後
    const narrow = css.slice(css.indexOf('@media (max-width: 900px)'));
    if (!/\.steps ol \{ display: grid; grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/.test(narrow) || !/\.steps button \{[^}]*white-space: normal/.test(narrow)) throw new Error('窄螢幕時步驟列應五步等寬且可換行');
  });
  await step('每一項舊功能都還找得到（左側五個分頁、中間四個分頁 → 流程步驟）', () => {
    // [舊位置, 新的一步, 檢查新位置有這個功能]
    const has = (sel, what) => { const el = $(sel); if (!el || !el.textContent.trim()) throw new Error(what + '：' + sel + ' 沒有內容'); return el; };
    const visible = (el) => { for (let x = el; x && x !== document.body; x = x.parentNode) if (x.classList && x.classList.contains('hidden')) return false; return true; };
    const MOVES = [
      ['左：檢查結果（篩選、分組、處理、匯出報表、修正計畫的入口）', 'triage', () => {
        const p = has('#pane-findings', '檢查結果');
        if (!p.querySelector('.findings-view') || !p.querySelector('.open-hub') || !p.querySelector('.open-patch') || !p.testAll('.fgroup').length) throw new Error('檢查結果的篩選與入口');
        return p; }],
      ['左：覆蓋率（每台設備、缺漏與收集失敗、devices.csv 草稿）', 'input', () => {
        const p = has('#pane-coverage', '覆蓋率');
        if (!$('#hub').contains(p) || !p.querySelector('table') || !hubBtn('devices-csv') || !hubBtn('open-coverage')) throw new Error('覆蓋率在資料中心，有表格與 devices.csv 草稿');
        return p; }],
      ['左：清單（設備、介面、IP、網段、MAC、VLAN）', 'view', () => { const p = has('#pane-inventory', '清單'); if (p.querySelector('.inv-kind').testAll('option').length !== 6) throw new Error('清單的六種'); return p; }],
      ['左：比對（摘要與入口）→ 驗證的比對與資料中心的摘要', 'verify', () => {
        const p = has('#compare-body', '比對');
        if (!p.querySelector('.cmp-expected') || !p.querySelector('.cmp-baseline') || !p.querySelector('.cmp-load-expected') || !p.querySelector('.cmp-load-previous')) throw new Error('預期資料比對與新舊基準比對');
        if (!$('#hub').testAll('.hub-row').some((r) => r.getAttribute('data-item') === 'previous') || !hubBtn('load-expected')) throw new Error('資料中心的比對摘要與載入');
        return p; }],
      ['左：處理紀錄的本輪變化', 'verify', () => has('#round-body', '本輪變化')],
      ['左：處理紀錄的修復追蹤', 'verify', () => has('#tracking-body', '修復追蹤')],
      ['左：處理紀錄的各狀態筆數與匯出／匯入的入口', 'verify', () => {
        const p = has('#ledger-body', '處理紀錄');
        if (!p.querySelector('.ledger-counts') || !p.querySelector('.open-hub') || !hubBtn('export-ledger') || !hubBtn('import-ledger')) throw new Error('處理紀錄的筆數與匯出／匯入');
        return p; }],
      ['中：拓樸圖（層級切換、VLAN 篩選）', 'view', () => { if (!visible($('#layer-switch')) || $('#view-graph').inert) throw new Error('「檢視」的拓樸圖與層級切換'); return $('#layer-switch'); }],
      ['中：拓樸圖（「研判」也看得到層級切換）', 'triage', () => { if (!visible($('#layer-switch')) || $('#view-graph').inert) throw new Error('「研判」的拓樸圖與層級切換'); return $('#layer-switch'); }],
      ['中：修正計畫', 'fix', () => { const p = has('#patch-body', '修正計畫'); if (!p.querySelector('.patch-select') || !p.querySelector('.patch-main')) throw new Error('修正計畫的選取與計畫'); return p; }],
      ['中：比對', 'verify', () => has('#compare-body', '比對')],
      ['中：收斂趨勢', 'verify', () => { const p = has('#trend-body', '收斂趨勢'); if (!p.testAll('.trend-tile').length) throw new Error('收斂趨勢的數字'); return p; }],
    ];
    MOVES.forEach(([old, s, find]) => {
      goStep(s);
      let el; try { el = find(); } catch (e) { throw new Error(`「${old}」在 ${S.view.app.STEP_LABEL[s]} 找不到：${e.message}`); }
      if (!visible(el)) throw new Error(`「${old}」在 ${S.view.app.STEP_LABEL[s]} 應看得到`);
    });
    goStep('triage');
  });
  await step('步驟的狀態會隨資料更新（文字，不只靠顏色）', async () => {
    const VA = S.view.app; const NUM = S.view.num; const st = (s) => stepBtn(s).querySelector('.step-st').textContent;
    const m = App.Q.meta();
    if (st('input') !== `${NUM(m.stats.collected)} 台`) throw new Error('「輸入」應寫出已收集的台數：' + st('input'));
    const pc0 = VA.problemCounts();
    if (st('triage') !== `待處理 ${NUM(pc0.error + pc0.warn)}`) throw new Error('「研判」應寫出待處理筆數：' + st('triage'));
    // 「待處理」全站同一個數字：步驟列「研判」、基準狀態卡、「驗證」改善趨勢都是 Q.pendingSummary 的 total（錯誤＋警告，不含提醒）
    const ps = App.Q.pendingSummary(VA.isPending);
    if (pc0.error + pc0.warn !== ps.total || ps.total !== ps.error + ps.warn) throw new Error('problemCounts 應等於 Q.pendingSummary');
    App.select(null);
    const line = $('#detail').querySelector('.status-line'); const lt = line ? line.textContent : '';
    const cardSum = [/([\d,]+) 項錯誤/, /([\d,]+) 項警告/].reduce((n, re) => n + Number(((lt.match(re) || [])[1] || '0').replace(/,/g, '')), 0);
    if (cardSum !== ps.total) throw new Error(`基準狀態卡的待處理（${cardSum}）應等於步驟列「研判」（${ps.total}）：${lt}`);
    App.showView('trend'); S.view.ledgerPane.renderTrend(App);
    const tile = $('#trend-body').testAll('.trend-tile').find((x) => x.getAttribute('data-tile') === 'pending');
    const info = $('#trend-body').testAll('.trend-tile').find((x) => x.getAttribute('data-tile') === 'info');
    if (VA.ledgerState().blocked) { /* 處理紀錄停用時沒有趨勢 */ } else if (!tile || tile.querySelector('.trend-value').textContent !== NUM(ps.total)) throw new Error('「驗證」的待處理應與「研判」相同：' + (tile && tile.textContent));
    else if (!info || info.querySelector('.trend-value').textContent !== NUM(ps.info)) throw new Error('「驗證」應另列提醒的筆數：' + (info && info.textContent));
    // 「驗證」同一屏「復發」的狀態 chip 只在本輪變化出現
    const shown = (el) => { for (let x = el.parentNode; x && x !== document.body; x = x.parentNode) if (String(x.tagName).toLowerCase() === 'details' && !x.open && x.getAttribute('open') == null) return false; return true; };
    const reg = ['#trend-body', '#ledger-body', '#tracking-body'].map((sel) => $(sel).testAll('.chip').filter((c) => c.textContent.startsWith('復發') && shown(c)).length);
    if (reg.some((n) => n)) throw new Error('「復發」的狀態 chip 只在本輪變化出現：' + reg.join());
    App.showView('graph');
    if (!st('verify').startsWith(`第 ${NUM(VA.ledgerRoundIndex() + 1)} 輪`)) throw new Error('「驗證」應寫出處理紀錄的第幾輪：' + st('verify'));
    // 「檢視」：拓樸圖的層級
    if (st('view') !== S.view.LAYER[App.layer]) throw new Error('「檢視」應寫出目前的層級：' + st('view'));
    App.showLayer('l3'); await App.layerJob;
    if (st('view') !== S.view.LAYER.l3) throw new Error('換層級後「檢視」的狀態應更新：' + st('view'));
    App.showLayer('device');
    // 「修正」：修正計畫已選的項目數
    App.openPatch(); const PV = S.view.patchView;
    if (PV.state.keys.size) $('#patch-body').querySelector('.patch-clear').click();
    if (st('fix') !== '已選 0') throw new Error('「修正」應寫出已選的項目數：' + st('fix'));
    const rule = $('#patch-body').testAll('.patch-rule')[0]; rule.click();
    if (!PV.state.keys.size || st('fix') !== `已選 ${NUM(PV.state.keys.size)}`) throw new Error('選取後「修正」的狀態應更新：' + st('fix'));
    $('#patch-body').querySelector('.patch-clear').click();
    if (st('fix') !== '已選 0') throw new Error('清除選取後「修正」的狀態應更新');
    // 「研判」：把一筆待處理的錯誤／警告標為誤報後，待處理減一（處理紀錄是使用者的資料，結束後還原）
    const keep = JSON.parse(JSON.stringify(VA.ledger()));
    const f = App.Q.findings().find((x) => x.severity !== 'info' && S.ledger.isPending(VA.ledgerStatus(x)) && (S.ledger.USER_TO[VA.ledgerItem(x).status] || []).includes('false-positive'));
    if (f) {
      const r = await App.setLedger(f, { status: 'false-positive' });
      if (!r.ok) throw new Error('應可標為誤報：' + r.error);
      const pc1 = VA.problemCounts();
      if (pc1.error + pc1.warn !== pc0.error + pc0.warn - 1 || st('triage') !== `待處理 ${NUM(pc1.error + pc1.warn)}`) throw new Error('標為誤報後「研判」的待處理應減一：' + st('triage'));
      await S.store.set('ledger', keep); await VA.loadLedger(); VA.renderAll();
      if (st('triage') !== `待處理 ${NUM(pc0.error + pc0.warn)}`) throw new Error('還原處理紀錄後「研判」應回到原本的筆數');
    } else if (!process.env.SMOKE_INPUT) throw new Error('範例資料應有可標為誤報的待處理項目');
    App.showView('graph');
  });
};
