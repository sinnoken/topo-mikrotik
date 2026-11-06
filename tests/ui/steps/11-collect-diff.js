// 畫面冒煙測試的 step：樣式單一來源、收集時間與失敗、新舊基準比對。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { body, head, document, S, fs, path, ROOT, step, captureDownloads, cssVarsOf, SCHEMES, buildInput, hubBtn, goStep, $, text } = require('../helpers.js');

module.exports = async () => {
  await step('樣式單一來源：CSS 設備類型變數與 theme 一致，圖例取自 theme', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8'); const T = S.view.theme;
    [
      ['共用控制項高度（至少 36px）', /--control-h:\s*(3[6-9]|[4-9]\d)px/],
      ['觸控裝置的控制項高度 44px', /@media \(pointer: coarse\)\s*\{[^}]*--control-h:\s*44px/],
      ['鍵盤焦點樣式', /button:focus-visible/],
      ['清除操作風險提示（.danger 修飾，不用 ID 規則）', /\.danger:hover/],
      ['表格交錯列', /table\.t tbody tr:nth-child\(even\) td/],
      ['表格互動高亮', /table\.t tbody tr\.click:hover td/],
      ['檢查結果卡片樣式', /\.finding\s*\{[^}]*border:/],
      ['狀態標籤層次', /\.chip\.err\s*\{[^}]*border-color:/],
      ['減少動態效果偏好', /prefers-reduced-motion:\s*reduce/],
      ['資料標籤間距與換行', /\.chip-list\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*gap:\s*4px/],
      ['首頁 Grid 明確指定主內容列', /#main\s*\{\s*grid-row:\s*3;/],
    ].forEach(([label, pattern]) => { if (!pattern.test(css)) throw new Error('缺少 ' + label); });
    // 設備類型色與嚴重度色：亮、暗兩組都與 CSS 對應的 :root 一致
    const vars = { firewall: 'fw', switch: 'sw', router: 'rt', host: 'host', unknown: 'unk' };
    SCHEMES.forEach((mode) => {
      const cv = cssVarsOf(css, mode); const P = T.palettes[mode];
      Object.entries(vars).forEach(([k, v]) => { if ((cv[v] || '').toLowerCase() !== P.kind[k].toLowerCase()) throw new Error(`${mode}：--${v} 與 theme.kind.${k} 不一致`); });
      ['error', 'warn'].forEach((k) => { if ((cv['sev-' + k] || '').toLowerCase() !== P.sev[k].toLowerCase()) throw new Error(`${mode}：--sev-${k} 與 theme.sev.${k} 不一致`); });
    });
    // 樣式一致性：畫面用到的 class 都要有定義；字重只用 400／600／700（中文字型沒有 550／650）
    ['pane-filter', 'pane-body', 'pane-section', 'pane-note', 'note-box', 'table-more', 'row'].forEach((c) => {
      if (!new RegExp('\\.' + c + '\\b[^{]*\\{').test(css)) throw new Error('缺少 .' + c + ' 樣式');
    });
    if (/font-weight:\s*(550|650)/.test(css)) throw new Error('字重只用 400／600／700');
    const legend = Array.from(document.testAll('#legend .li'));
    if (document.testAll('#legend .lg-group').length !== 5) throw new Error('圖例應分為五類');
    const groupTitles = document.testAll('#legend .lg-title').map((el) => el.textContent);
    if (groupTitles.join('|') !== '設備|終端|鏈路|鏈路註記|標示') throw new Error('圖例分類順序應為設備、終端、鏈路、鏈路註記、標示');
    if (!document.querySelector('#legend .legend-body').classList.contains('hidden')) throw new Error('圖例預設應收合');
    document.querySelector('#legend .legend-head').click();
    if (document.querySelector('#legend .legend-body').classList.contains('hidden')) throw new Error('點圖例標題應展開');
    document.querySelector('#legend .legend-head').click();
    if (legend.length < Object.keys(T.edge).length + Object.keys(S.view.KIND).length) throw new Error('圖例缺項');
    const sw = (li) => li.childNodes.filter((c) => c.style && c.attrs.class);
    const kinds = Object.keys(S.view.KIND);
    kinds.forEach((k, i) => { const d = sw(legend[i])[0]; if (d.style.background !== T.kind[k]) throw new Error('圖例設備色與 theme 不一致：' + k); });
    Object.entries(T.edge).forEach(([k, st]) => {
      const row = legend.find((li) => li.textContent === S.view.CLS[k]); const l = row && sw(row)[0];
      if (!l) throw new Error('圖例缺少連線類別：' + k);
      if (!l.style.background.includes(st.c) || l.style.height !== S.view.legendLineHeight(st.w)) throw new Error('圖例連線色或線寬與 theme 不一致：' + k);
      if (!!st.dash !== l.style.background.includes('repeating-linear-gradient')) throw new Error('圖例連線虛線與 theme 不一致：' + k);
    });
    const edgeLegend = (k) => legend.find((li) => li.textContent === S.view.CLS[k]);
    const oneG = edgeLegend('1g'); const other = edgeLegend('other');
    if (!oneG || !other || !oneG.getAttribute('title').includes('不代表實際協商速率')) throw new Error('1G 圖例需說明其為介面名稱推估，而非實際協商速率');
    if (T.edge['1g'].c === T.edge.other.c || T.edge['1g'].w <= T.edge.other.w) throw new Error('1G 連線樣式應明顯區別於其他連線');
    // 線寬隨速率遞增（畫布與圖例都是）；多條鏈路的雙線另有圖例
    const speeds = ['1g', '10g', '40g'];
    speeds.slice(1).forEach((k, i) => {
      if (T.edge[k].w <= T.edge[speeds[i]].w) throw new Error(`${k} 線寬應大於 ${speeds[i]}`);
      if (parseFloat(S.view.legendLineHeight(T.edge[k].w)) <= parseFloat(S.view.legendLineHeight(T.edge[speeds[i]].w))) throw new Error(`圖例的 ${k} 應比 ${speeds[i]} 粗`);
    });
    if (!legend.some((li) => li.textContent.includes('多條鏈路') && li.querySelector('.ln') && li.querySelector('.ln').getAttribute('data-multi') !== null)) throw new Error('圖例應說明多條鏈路的雙線');
    // 標示：選取、滑過、搜尋結果、路由追蹤的圖例顏色取自 theme.mark
    ['select', 'hover', 'find', 'trace'].forEach((k) => {
      const swatch = legend.flatMap((li) => li.childNodes).find((c) => c.attrs && c.attrs['data-mark'] === k);
      if (!swatch) throw new Error('圖例缺少標示：' + k);
      const st = swatch.style; if (!String(st.border || st.background).includes(T.mark[k])) throw new Error('圖例標示色與 theme 不一致：' + k);
    });
    let keyboardLinkActivated = false;
    const keyboardLink = S.view.h('a', { class: 'link', onclick: () => { keyboardLinkActivated = true; } }, '鍵盤連結');
    if (keyboardLink.getAttribute('tabindex') !== '0' || keyboardLink.getAttribute('role') !== 'link') throw new Error('動態連結需具備鍵盤焦點與連結語意');
    keyboardLink.dispatch('keydown', { key: 'Enter' });
    if (!keyboardLinkActivated) throw new Error('動態連結按 Enter 應觸發操作');
    const hearsay = legend.find((li) => li.textContent === S.view.TERMS.hearsay); const inferred = legend.find((li) => li.textContent === '推論鏈路');
    if (!hearsay || !inferred) throw new Error('圖例缺少「只有一端資料」或推論鏈路註記');
    if (legend.some((li) => li.textContent === 'MNDP')) throw new Error('MNDP 不畫在圖上，圖例不應列出');
    const hs = sw(hearsay)[0]; const is = sw(inferred)[0];
    // 證據強度只改線型與透明度（畫布保留速率色），圖例用中性線色只表達線型
    const dashOf = (d) => d.reduce((acc, n) => { acc.pos += n; acc.out.push(acc.pos + 'px'); return acc; }, { pos: 0, out: [] }).out;
    [[hs, T.weakEdge.hearsay], [is, T.weakEdge.inferred]].forEach(([el, st]) => {
      if (el.style.opacity !== String(st.alpha) || !el.style.background.includes(T.canvas.keyInk) || !dashOf(st.dash).every((x) => el.style.background.includes(x))) throw new Error('證據強度圖例的線型或透明度與 theme 不一致');
    });
    if (hs.style.background === is.style.background) throw new Error('單側觀察與推論鏈路圖例線型應可區分');
  });
  await step('收集時間與失敗：原始輸出列出收集時間與失敗，覆蓋率把失敗算進「有缺漏」並顯示原因', async () => {
    await buildInput(fs.readFileSync(path.join(ROOT, 'tests/fixtures/collector/collected-at-and-failures.txt'), 'utf8'));
    const blocks = App.snap.blocks;
    if (!blocks.some((b) => b.collectedAt) || !blocks.some((b) => b.failure)) throw new Error('測試資料應有收集時間與失敗');
    const devs = S.util.uniq(blocks.filter((b) => b.devKey && (b.collectedAt || b.failure)).map((b) => b.devKey));
    devs.forEach((dk) => {
      App.select({ type: 'device', key: dk });
      const fold = $('#detail').testAll('details').find((d) => d.querySelector('summary').textContent.startsWith('收集到的原始輸出'));
      if (!fold) throw new Error(dk + ' 應有原始輸出區塊');
      const t = fold.textContent;
      blocks.filter((b) => b.devKey === dk).forEach((b) => {
        if (b.collectedAt && !t.includes(S.view.fmtUtc(b.collectedAt))) throw new Error(`${dk} 的原始輸出應列出收集時間 ${b.collectedAt}`);
        if (b.failure && !t.includes(S.view.failureText(b.failure))) throw new Error(`${dk} 的原始輸出應列出失敗原因`);
      });
    });
    // 只有失敗、沒有缺少的設備也算「有缺漏」：以基準的副本把缺少清空、保留失敗來驗證畫面的判斷
    const clone = JSON.parse(JSON.stringify(App.snap));
    const row = clone.coverage.find((r) => r.collected && r.failures.length);
    row.missing = [];
    S.view.app.load(clone, null);
    const gaps = clone.coverage.filter((r) => r.collected && (r.missing.length || r.failures.length));
    goStep('input');
    if (!text('#pane-coverage').includes('有缺漏 ' + gaps.length)) throw new Error('有缺漏應包含只有收集失敗的設備');
    App.select(null);
    const b = $('#detail').querySelector('.status-coverage').querySelector('a');
    if (!b) throw new Error('只有收集失敗時，收集缺漏入口也應可用');
    if (!b.textContent.includes(`${gaps.length} 台`)) throw new Error('基準狀態的缺漏數應包含收集失敗：' + b.textContent);
    b.click();
    const tr = $('#pane-coverage').testAll('tbody tr');
    if (tr.length !== gaps.length) throw new Error('缺漏篩選列數應等於有缺漏的設備數');
    const t = text('#pane-coverage');
    gaps.forEach((r) => r.failures.forEach((x) => {
      if (!t.includes(S.view.failureText(x)) || !t.includes(x.command || '整台設備')) throw new Error('覆蓋率應顯示失敗原因與指令');
    }));
    if (document.activeElement !== $('#hub-sec-coverage')) throw new Error('「查看收集缺漏」應在資料中心聚焦覆蓋率');
    S.view.app.closeHub();
  });
  await step('防火牆畫面：停用規則、無法解碼的註解、jump 來源與預設值服務', async () => {
    await buildInput(fs.readFileSync(path.join(ROOT, 'tests/fixtures/firewall/edge-router.txt'), 'utf8'));
    const Q = App.Q; const dev = Q.firewallRules()[0].dev;
    const disabled = Q.firewallRules().find((r) => r.disabled);
    if (!disabled) throw new Error('測試資料應有停用的規則');
    App.select({ type: 'rule', key: disabled.key });
    const row = $('#detail').querySelector('.focus');
    if (!row || !row.className.includes('disabled') || !row.textContent.includes('停用')) throw new Error('停用的規則應標示');
    if (row.testAll('td')[0].style.opacity !== String(S.view.theme.firewall.disabledAlpha)) throw new Error('停用規則的透明度應取自 theme');
    const jumped = Q.firewallChains(dev).find((c) => c.jumpedFrom.length);
    if (jumped) {
      App.select({ type: 'firewall', dev });
      const d = $('#detail').testAll('details').find((x) => x.querySelector('summary').firstChild.textContent === jumped.chain);
      d.dispatch('toggle');
      const a = d.testAll('a').find((x) => x.textContent.startsWith(Q.getFirewallRule(jumped.jumpedFrom[0]).chain + ' #'));
      if (!a) throw new Error('jump 來源應可點選');
      a.click(); if (App.sel.type !== 'rule' || App.sel.key !== jumped.jumpedFrom[0]) throw new Error('點 jump 來源應定位到那條規則');
    }
    App.select({ type: 'firewall', dev });
    const defaults = Q.ipServicesOf(dev).filter((s) => s.basis === 'default');
    const svcRows = $('#detail').testAll('tbody tr').filter((tr) => Q.ipServicesOf(dev).some((s) => tr.testAll('td')[0].textContent === s.name));
    if (svcRows.filter((tr) => tr.textContent.includes('預設值')).length !== defaults.length) throw new Error('只有 basis 為 default 的服務標示「預設值」');
    // 無法解碼的註解：以基準副本標記一條規則
    const clone = JSON.parse(JSON.stringify(App.snap));
    const r = clone.model.firewallRules.find((x) => x.comment); r.commentEncoding = 'undecodable';
    S.view.app.load(clone, null);
    App.select({ type: 'rule', key: r.key });
    if (!$('#detail').querySelector('.focus').textContent.includes('註解無法解碼')) throw new Error('commentEncoding 為 undecodable 時應標示');
  });
  await step('新舊基準比對：依類別分組、摘要在上、新暴露醒目，schema 不同時顯示原因，可匯出預期現況', async () => {
    const full = fs.readFileSync(path.join(ROOT, 'tests/fixtures/firewall/edge-router.txt'), 'utf8');
    // 舊基準少了幾條放行規則：新基準多出的 WAN 可連入規則應標成新暴露
    const oldInput = full.split('\n').filter((l) => !/dst-port=8291/.test(l) || /in-interface-list/.test(l)).join('\n');
    await buildInput(oldInput);
    const oldJson = S.view.exporter.snapshotJson(App.snap);
    await buildInput(full);
    const expect = S.compare.snapshots(S.query(JSON.parse(oldJson)), App.Q);
    if (!expect.items.some((i) => i.effect === 'new-exposure')) throw new Error('測試資料應產生新暴露');
    App.showView('compare');
    const load = async (name, body) => {
      const inp = $('#compare-body').querySelector('.baseline-diff').querySelector('input');
      inp.files = [{ name, text: async () => body }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
    };
    const keysBefore = JSON.stringify(await S.store.get('last'));
    await load('old.json', oldJson);
    const pane = () => $('#compare-body').querySelector('.baseline-diff');
    // 資料中心的「上一輪的基準」：新舊基準比對的摘要（同一份比對結果）；新暴露的筆數在驗證畫面的摘要
    const sumText = $('#hub').testAll('.hub-row').find((r) => r.getAttribute('data-item') === 'previous').textContent;
    if (!sumText.includes('old.json') || !sumText.includes(`新增 ${S.view.num(expect.summary.added)}`)) throw new Error('資料中心應列出新舊基準比對的筆數：' + sumText);
    const t = pane().textContent;
    if (!t.includes(`新暴露 ${S.view.num(expect.items.filter((i) => i.effect === 'new-exposure').length)}`)) throw new Error('驗證畫面的比對摘要應列出新暴露的筆數');
    Object.entries({ added: '新增', removed: '移除', changed: '變更' }).forEach(([k, label]) => {
      if (!t.includes(`${label} ${expect.summary[k]}`)) throw new Error('摘要應列出' + label + '筆數');
    });
    const cats = pane().testAll('.diff-cat').map((x) => x.getAttribute('data-category'));
    const wantCats = ['device', 'link', 'vlan', 'ip', 'firewall', 'finding'].filter((c) => expect.items.some((i) => i.category === c));
    if (cats.join() !== wantCats.join()) throw new Error('應依類別分組並依序列出：' + cats);
    const kids = pane().childNodes;
    if (kids.indexOf(pane().querySelector('.diff-summary')) > kids.indexOf(pane().querySelector('.diff-cat'))) throw new Error('摘要應在分組上方');
    expect.items.forEach((i) => { if (!t.includes(i.message)) throw new Error('缺少差異：' + i.message); });
    const exposureRows = pane().testAll('tbody tr').filter((tr) => tr.className.includes('exposure'));
    if (exposureRows.length !== expect.items.filter((i) => i.effect === 'new-exposure').length) throw new Error('每個新暴露都應醒目標示');
    if (!exposureRows.every((tr) => tr.testAll('td')[0].style.background === S.view.theme.diff.exposureBg && tr.textContent.includes('新暴露'))) throw new Error('新暴露的顏色應取自 theme');
    exposureRows[0].click();
    if (App.sel.type !== 'rule' || !App.Q.getFirewallRule(App.sel.key)) throw new Error('點新暴露的規則應定位到防火牆規則');
    if (App.centerView !== 'verify' || !$('#detail').querySelector('.focus')) throw new Error('點比對的一列時，比對留在中間、右側顯示那條規則');
    const filterBtn = pane().testAll('button').find((b) => b.textContent.startsWith('新暴露'));
    filterBtn.click();
    if (pane().testAll('tbody tr').some((tr) => !tr.className.includes('exposure'))) throw new Error('新暴露篩選應只列新暴露');
    if (JSON.stringify(await S.store.get('last')) !== keysBefore) throw new Error('比對結果不應存進 store');
    // schema 不同：顯示核心回報的原因，不比對
    const old1 = JSON.parse(oldJson); old1.meta.schema = 'ssot-snapshot/1'; old1.model = {};
    await load('old-v1.json', JSON.stringify(old1));
    if (!pane().textContent.includes('schema') || pane().testAll('.diff-cat').length) throw new Error('schema 不同時應顯示原因、不比對');
    await load('bad.json', '{not json');
    if (!pane().textContent.includes('無法讀取')) throw new Error('JSON 錯誤時應說明');
    // 匯出預期資料：ssot-expected/1，和同一份基準比對全部一致
    const { files } = await captureDownloads(() => {
      hubBtn('export-expected').click(); // 由基準產生預期資料是這一輪的輸出，入口在資料中心
    });
    if (files.length !== 1 || !/^expected-.*\.json$/.test(files[0].name)) throw new Error('應下載預期資料 JSON：' + files.map((f) => f.name));
    const exp = JSON.parse(files[0].text);
    if (exp.schema !== 'ssot-expected/1') throw new Error('預期資料的 schema 應為 ssot-expected/1');
    require('assert').deepStrictEqual(exp, S.compare.expectedFrom(App.Q));
    App.showView('compare');
    const inp = $('#compare-body').querySelector('input');
    inp.files = [{ name: files[0].name, text: async () => files[0].text }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
    if (!text('#compare-body').includes('有差異 0')) throw new Error('匯出的預期資料和同一份基準比對應全部一致');
    App.showView('graph');
  });
  await step('只看新出現的：依舊基準篩選；版本不同時比對結果與篩選都提示「新出現的可能來自新版檢查」，版本相同時沒有提示', async () => {
    const Q = App.Q; const all = App.snap.findings; const key = Q.findingKey;
    const loadOld = async (name, body) => {
      App.showView('compare');
      const inp = $('#compare-body').querySelector('.baseline-diff').querySelector('input');
      inp.files = [{ name, text: async () => body }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
      goStep('triage');
    };
    const onlyNew = () => $('#pane-findings').testAll('.chip').find((c) => c.textContent.startsWith('只看新出現的'));
    const versionHint = () => $('#pane-findings').querySelector('.only-new-version');
    const diffWarnings = () => $('#compare-body').testAll('.diff-warning');
    // 沒有可用的舊基準（上一步最後載入的是壞掉的 JSON）：不顯示這個篩選，也不佔位置說明
    goStep('triage');
    if (onlyNew()) throw new Error('沒有舊基準時不應顯示「只看新出現的」');
    const count = new Map(); all.forEach((f) => count.set(key(f), (count.get(key(f)) || 0) + 1));
    const addedF = all.find((f) => count.get(key(f)) === 1);
    const old = JSON.parse(JSON.stringify(App.snap));
    old.findings = old.findings.filter((f) => key(f) !== key(addedF));
    // 版本相同：沒有提示
    await loadOld('old-same.json', JSON.stringify(old));
    if (versionHint() || diffWarnings().length) throw new Error('版本與命名規則都相同時不應有提示');
    // 只看新出現的：依 S.compare.snapshots 的 finding added
    const added = new Set(S.compare.snapshots(S.query(old), Q).items.filter((i) => i.category === 'finding' && i.change === 'added').map((i) => i.key));
    if (!added.has(key(addedF))) throw new Error('測試資料：舊基準拿掉的檢查結果應是新出現的');
    const nNew = all.filter((f) => added.has(key(f))).length;
    if (!onlyNew().textContent.includes(String(nNew))) throw new Error('「只看新出現的」應顯示新出現的筆數');
    if (!text('#pane-findings').includes('新出現')) throw new Error('未篩選時新出現的項目應標示');
    onlyNew().click();
    if (onlyNew().getAttribute('aria-pressed') !== 'true') throw new Error('「只看新出現的」應可切換');
    for (let n = 0; n < 200; n++) {
      const head = $('#pane-findings').testAll('.fgroup').filter((g) => !/\b(handled|rules)\b/.test(g.className)).map((g) => g.querySelector('.head')).find((x) => x.getAttribute('aria-expanded') === 'false');
      if (!head) break; head.click();
    }
    const shown = $('#pane-findings').testAll('.fgroup').filter((g) => !/\b(handled|rules)\b/.test(g.className)).flatMap((g) => g.testAll('.fitem'));
    if (!shown.length || !shown.some((it) => it.textContent.includes(addedF.message))) throw new Error('篩選後應列出新出現的那一筆');
    // 版本不同：比對結果上方與篩選旁都提示
    old.meta.version = '0.0.1';
    await loadOld('old-version.json', JSON.stringify(old));
    const warn = S.compare.snapshots(S.query(old), Q).warnings.find((w) => w.kind === 'version');
    if (!warn) throw new Error('測試資料：版本不同時核心應有 version 的提醒');
    App.showView('compare');
    const dw = diffWarnings().find((d) => d.getAttribute('data-kind') === 'version');
    if (!dw || !dw.textContent.includes(warn.message)) throw new Error('比對結果上方應顯示版本不同的提醒');
    const kids = $('#compare-body').querySelector('.baseline-diff').childNodes;
    if (kids.indexOf($('#compare-body').querySelector('.diff-warnings')) > kids.indexOf($('#compare-body').querySelector('.diff-summary'))) throw new Error('提醒應在比對結果上方');
    goStep('triage');
    if (!versionHint() || !versionHint().textContent.includes('新出現的可能來自新版檢查')) throw new Error('只看新出現的應提示新出現的可能來自新版檢查');
    // 舊基準變成不可用：篩選自動關閉並隱藏，提示一併消失
    await loadOld('bad.json', '{not json');
    if (onlyNew() || versionHint()) throw new Error('舊基準不可用時篩選應關閉並隱藏');
    App.showView('graph');
  });
};
