// 畫面冒煙測試的 step：樣式 token、文字對比、嚴重度外形、鍵盤與 Pointer、焦點與字級、配色跟隨系統。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { html, body, docListeners, winListeners, head, document, raf, flushRaf, S, fs, path, vm, ROOT, inlineScripts, step, captureDownloads, rgbOf, luminance, contrastOf, cssVars, cssDarkRoot, cssVarsOf, SCHEMES, forSchemes, jsFiles, recordCanvas, withGraph, vertices, near, buildInput, goStep, $, text, L4, routesList } = require('../helpers.js');

module.exports = async () => {
  await step('樣式 token：顏色、z-index、動效時長、圓角只用 :root 的變數；每個變數都有用到；對話框有名稱', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // :root 區塊（含 @media 內的 :root，例如觸控；以及深色的 :root[data-theme="dark"]）才可以寫色值；其他地方一律 var(--*)
    const ROOT_RE = /:root(?:\[data-theme="dark"\])?\s*\{([^}]*)\}/g;
    const roots = Array.from(css.matchAll(ROOT_RE)).map((m) => m[1]);
    const rest = css.replace(ROOT_RE, '');
    const bodies = Array.from(rest.matchAll(/([^{}]*)\{([^{}]*)\}/g)).map((m) => ({ sel: m[1].trim(), body: m[2] }));
    const bad = [];
    // 具名色（CSS Color 4 的 148 個；transparent、currentColor、inherit 與強制色彩的系統色 Canvas、Highlight 等不是具名色，可以用）
    const NAMED = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral '
      + 'cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred '
      + 'darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite '
      + 'forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen '
      + 'lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray '
      + 'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue '
      + 'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid '
      + 'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon '
      + 'sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white '
      + 'whitesmoke yellow yellowgreen').split(' '));
    const COLOR_LIT = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
    bodies.forEach(({ sel, body }) => {
      for (const m of body.matchAll(COLOR_LIT)) bad.push(`${sel}：${m[0]}`);
      for (const m of body.matchAll(/(?:^|;)\s*([\w-]+):\s*([^;]+)/g)) {
        // var(--*) 的名稱與字串、url() 不算；其餘的字詞是具名色就擋
        const words = m[2].replace(/var\(--[\w-]+/g, '').replace(/"[^"]*"|'[^']*'|url\([^)]*\)/g, '').match(/[a-zA-Z]+/g) || [];
        words.filter((w) => NAMED.has(w.toLowerCase())).forEach((w) => bad.push(`${sel}：${m[1]}: ${w}`));
      }
      // z-index 只用 --z-*；transition／animation 的時長與延遲只用 --dur-*；圓角（含分邊寫法）只用 --radius-*、0 或 50%（圓形）
      for (const m of body.matchAll(/(?:^|;)\s*z-index:\s*([^;]+)/g)) if (!/^var\(--z-[\w-]+\)$/.test(m[1].trim())) bad.push(`${sel}：z-index: ${m[1].trim()}`);
      for (const m of body.matchAll(/(?:^|;)\s*((?:transition|animation)(?:-duration|-delay)?):\s*([^;]+)/g)) if (/(?:^|[\s,(])\d*\.?\d+m?s\b/.test(m[2])) bad.push(`${sel}：${m[1]}: ${m[2].trim()}`);
      for (const m of body.matchAll(/(?:^|;)\s*(border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius):\s*([^;]+)/g)) if (m[2].trim().split(/[\s/]+/).some((x) => !/^(var\(--radius[\w-]*\)|0|50%)$/.test(x))) bad.push(`${sel}：${m[1]}: ${m[2].trim()}`);
    });
    // index.html：inline style 與 SVG 的 fill／stroke（等顏色屬性）不寫色碼；分頁圖示（<link rel="icon"> 的 data URI）在頁面之外、不跟配色，不算
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<link rel="icon"[^>]*>/, '');
    for (const m of htmlSrc.matchAll(/\b(fill|stroke|stop-color|flood-color|lighting-color|color)="([^"]*)"/g)) if (!/^(none|currentColor|inherit)?$/.test(m[2])) bad.push(`index.html：${m[1]}="${m[2]}"`);
    for (const m of htmlSrc.matchAll(/style="([^"]*)"/g)) for (const c of m[1].matchAll(COLOR_LIT)) bad.push(`index.html：style 的 ${c[0]}`);
    if (bad.length) throw new Error(':root 之外應只用變數：\n' + bad.join('\n'));
    // 深色：:root[data-theme="dark"] 重新定義亮色 :root 的每個顏色變數（--fixed-light-* 刻意不變），且只放顏色
    const isColor = (x) => /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/.test(x);
    const lightColors = Object.entries(cssVars(css)).filter(([n, x]) => isColor(x) && !n.startsWith('fixed-light-')).map(([n]) => n);
    const darkVars = Object.fromEntries(Array.from(cssDarkRoot(css).matchAll(/--([\w-]+):\s*([^;]+);/g)).map((m) => [m[1], m[2].trim()]));
    const missing = lightColors.filter((n) => !(n in darkVars)); const extra = Object.keys(darkVars).filter((n) => !lightColors.includes(n));
    if (missing.length || extra.length) throw new Error(`深色 :root 應正好重新定義亮色的顏色變數（缺 ${missing.join('、') || '無'}；多 ${extra.join('、') || '無'}）`);
    // 深色變數只定義一次：跟隨系統也由 JS（matchMedia）設定 data-theme，CSS 不另寫 prefers-color-scheme 的複本；
    // 每個顏色變數正好在兩個 :root 區塊（亮色、深色）定義
    if (/prefers-color-scheme/.test(css)) throw new Error('app.css 不應再用 prefers-color-scheme（深淺只跟著 data-theme，深色變數只寫一份）');
    if ((css.match(/:root\[data-theme="dark"\]\s*\{/g) || []).length !== 1) throw new Error('app.css 應正好有一個 :root[data-theme="dark"] 區塊');
    const twice = lightColors.filter((n) => roots.filter((r) => new RegExp('(^|[;\\s])--' + n + ':').test(r)).length !== 2);
    if (twice.length) throw new Error('顏色變數應正好在亮色與深色兩個 :root 各定義一次：' + twice.join('、'));
    // 原生控制項（捲軸、date picker）跟著 data-theme：亮色 :root 是 light，深色 :root 是 dark
    if (!/:root\s*\{[^}]*color-scheme:\s*light\s*;/.test(css) || !/color-scheme:\s*dark\s*;/.test(cssDarkRoot(css))) throw new Error(':root 應宣告 color-scheme: light，:root[data-theme="dark"] 宣告 color-scheme: dark');
    if (!/<meta name="color-scheme" content="light dark">/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'))) throw new Error('index.html 應有 color-scheme 的 meta');
    // 每個變數至少被 var() 用到一次（app.css、index.html、畫面程式）；只供測試與 theme.js 比對的變數列在例外清單
    const ONLY_COMPARED = ['fw', 'sw', 'rt', 'host', 'unk'];
    const defined = new Set(roots.flatMap((r) => Array.from(r.matchAll(/--([\w-]+):/g)).map((m) => m[1])));
    // 只在 :root 內被別的變數引用不算：從 :root 之外（樣式規則、index.html、畫面程式）的 var() 出發，沿著變數的定義往下找
    const sources = [rest, fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), ...jsFiles('src/view').map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))].join('\n');
    const refs = new Map(); roots.forEach((r) => { for (const m of r.matchAll(/--([\w-]+):\s*([^;]+);/g)) refs.set(m[1], (refs.get(m[1]) || []).concat(Array.from(m[2].matchAll(/var\(--([\w-]+)/g)).map((x) => x[1]))); });
    const used = new Set(); const todo = Array.from(sources.matchAll(/var\(--([\w-]+)/g)).map((m) => m[1]);
    while (todo.length) { const n = todo.pop(); if (used.has(n)) continue; used.add(n); todo.push(...(refs.get(n) || [])); }
    const unused = [...defined].filter((n) => !used.has(n) && !ONLY_COMPARED.includes(n));
    if (unused.length) throw new Error('沒有用到的 CSS 變數：' + unused.map((n) => '--' + n).join('、'));
    const stale = ONLY_COMPARED.filter((n) => !defined.has(n) || used.has(n));
    if (stale.length) throw new Error('例外清單的變數已不存在或已被使用，應移出清單：' + stale.join('、'));
    // 危險操作用 .danger 修飾，不用 ID 規則上色
    if (/#btn-clear\b[^{,]*\{/.test(rest)) throw new Error('清除基準的樣式應用 .danger，不用 #btn-clear');
    // 對話框：有名稱（aria-labelledby 指向對話框內的標題）、✕ 關閉鈕有 aria-label
    const dialogs = document.testAll('dialog');
    if (!dialogs.length) throw new Error('找不到對話框');
    dialogs.forEach((d) => {
      const id = d.getAttribute('aria-labelledby');
      const t = id && document.getElementById(id);
      if (!t || !d.contains(t) || !t.textContent.trim()) throw new Error(`#${d.id} 應有 aria-labelledby 指向對話框內的標題`);
      const xs = d.testAll('button').filter((b) => b.classList.contains('x'));
      if (!xs.length || xs.some((b) => !b.getAttribute('aria-label'))) throw new Error(`#${d.id} 的 ✕ 關閉鈕應有 aria-label`);
    });
  });
  await step('文字對比：每個文字色對它的底色 ≥ 4.5:1（CSS 變數、狀態標籤、theme 的文字色；亮、暗兩組）', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8'); const T = S.view.theme;
    forSchemes((mode) => {
      // 亮色的白底是 --panel（暗色換成深色的 --panel）
      const v = cssVarsOf(css, mode); const white = v.panel;
      if (mode === 'light' && white !== '#ffffff') throw new Error('亮色的 --panel 應是白色：' + white);
      // 狀態文字色的單一來源：theme.text 與 CSS 的 --*-text、--muted、--text 相同
      [['err', 'err-text'], ['warn', 'warn-text'], ['ok', 'ok-text'], ['info', 'info-text'], ['muted', 'muted'], ['body', 'text']].forEach(([k, n]) => {
        if ((v[n] || '').toLowerCase() !== T.text[k].toLowerCase()) throw new Error(`${mode}：--${n} 與 theme.text.${k} 不一致`);
    });
    const pairs = [
      ['--text', v.text, [white, v.surface, v.bg]],
      ['--muted', v.muted, [white, v.surface, v['surface-hover'], v['neutral-soft'], v['accent-soft'], v['accent-hover'], v['err-soft'], v['warn-soft']]],
      ['--accent', v.accent, [white, v.surface, v['accent-soft'], v['accent-hover']]],
      ['--err-text', v['err-text'], [white, v.surface, v['err-soft'], T.firewall.focus.bg]],
      ['--warn-text', v['warn-text'], [white, v.surface, v['warn-soft'], T.firewall.focus.bg]],
      ['--ok-text', v['ok-text'], [white, v.surface, v['ok-soft'], T.firewall.focus.bg]],
      ['--info-text', v['info-text'], [white, v.surface, v['info-soft']]],
    ];
    // 狀態與設備類型標籤：.chip.xxx { background; color }（color 可能是變數）
    Array.from(css.matchAll(/\.chip\.(err|warn|info|ok|kind-[a-z]+)\s*\{([^}]*)\}/g)).forEach((m) => {
      const val = (prop) => { const x = (m[2].match(new RegExp('(?:^|;)\\s*' + prop + ':\\s*([^;]+)')) || [])[1]; return x && x.trim().replace(/^var\(--([\w-]+)\)$/, (_, n) => v[n]); };
      pairs.push(['.chip.' + m[1], val('color'), [val('background')]]);
    });
    if (pairs.filter((p) => p[0].startsWith('.chip.kind-')).length !== Object.keys(S.view.KIND).length) throw new Error('每個設備類型都應有 .chip.kind-* 樣式');
    // theme 的文字色：防火牆動作（一般列、斑馬列、定位列）、比對 effect（白底、新暴露列）、畫布上的文字（疊在畫布底色上）
    Object.entries(T.firewall.action).forEach(([k, c]) => pairs.push(['firewall.action.' + k, c, [white, v.surface, T.firewall.focus.bg]]));
    Object.entries(T.diff.effect).forEach(([k, c]) => pairs.push(['diff.effect.' + k, c, [white, T.diff.exposureBg]]));
    const onCanvas = (bg) => '#' + rgbOf(bg, v.surface).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
    pairs.push(['canvas.group.text', T.canvas.group.text, [onCanvas(T.canvas.group.fill)]]);
    pairs.push(['canvas.label.text', T.canvas.label.text, [onCanvas(T.canvas.label.bg)]], ['canvas.label.textUncollected', T.canvas.label.textUncollected, [onCanvas(T.canvas.label.bg)]]);
    pairs.push(['canvas.port.text', T.canvas.port.text, [onCanvas(T.canvas.port.bg)]]);
    pairs.push(['endpoint.downstream.text', T.endpoint.downstream.text, [T.endpoint.downstream.fill]], ['endpoint.cluster.text', T.endpoint.cluster.text, [T.endpoint.cluster.fill]]);
    const low = [];
    pairs.forEach(([name, fg, bgs]) => {
      if (!fg) throw new Error('找不到文字色：' + name);
      bgs.forEach((bg) => { if (!bg) throw new Error('找不到底色：' + name); const r = contrastOf(fg, bg); if (r < 4.5) low.push(`${name} ${fg} 對 ${bg} 只有 ${r.toFixed(2)}:1`); });
    });
    if (low.length) throw new Error(`${mode}：文字對比不足：\n` + low.join('\n'));
    });
    // 這些文字改用文字色變數，不寫死色值：修正範例的警告列、原文行號、比對差異
    [/\.fw-fix \.warn-line\s*\{[^}]*color:\s*var\(--warn-text\)/, /pre\.raw \.ln\s*\{[^}]*color:\s*var\(--muted\)/, /\.diffA\s*\{[^}]*color:\s*var\(--err-text\)/].forEach((re) => {
      if (!re.test(css)) throw new Error('應使用文字色變數：' + re);
    });
  });
  await step('嚴重度在畫布上有外形：錯誤與警告外形不同，主機與鏈路中點也顯示', () => {
    const graph = App.graph; const T = S.view.theme;
    const nodes = [
      { id: 'sev-sw', label: 'sev-sw', kind: 'switch', collected: true, group: 't', sev: null },
      { id: 'sev-err', label: 'sev-err', kind: 'host', collected: true, group: 't', sev: 'error' },
      { id: 'sev-warn', label: 'sev-warn', kind: 'host', collected: true, group: 't', sev: 'warn' },
    ];
    const edges = [{ id: 'sev-e', a: 'sev-sw', b: 'sev-err', cls: '1g', count: 1, evidence: 'adjacency', sev: 'warn' }];
    const pos = new Map([['sev-sw', { x: 0, y: 0 }], ['sev-err', { x: 200, y: 0 }], ['sev-warn', { x: 0, y: 200 }]]);
    withGraph(graph, nodes, edges, pos, () => {
      if (graph.radius(nodes[1]) > 7) throw new Error('測試前提：主機是小節點');
      const ops = recordCanvas(graph.ctx, () => graph.draw());
      const marks = (sev, at) => ops.filter((o) => o.op === 'fill' && o.style === T.sev[sev] && near(o.path, at, 20));
      const err = marks('error', pos.get('sev-err')); const warn = marks('warn', pos.get('sev-warn'));
      if (!err.length) throw new Error('主機上的錯誤應顯示嚴重度標記');
      if (!warn.length) throw new Error('主機上的警告應顯示嚴重度標記');
      const mid = marks('warn', { x: 100, y: 0 });
      if (!mid.length) throw new Error('有問題的連線應在中點顯示嚴重度標記');
      if (vertices(err[0].path) === vertices(warn[0].path)) throw new Error('錯誤與警告的外形應不同');
      if (vertices(mid[0].path) !== vertices(warn[0].path)) throw new Error('連線中點與節點的警告外形應相同');
      const want = { square: 4, triangle: 3 };
      Object.entries(T.sevShape).forEach(([k, shape]) => { const got = vertices((k === 'error' ? err : warn)[0].path); if (want[shape] !== got) throw new Error(`${k} 應畫成 ${shape}（${want[shape]} 個頂點），實際 ${got}`); });
    });
    // 圖例：兩種嚴重度都畫出，外形與顏色取自 theme
    const items = Array.from(document.testAll('#legend .li'));
    Object.entries(T.sevShape).forEach(([k, shape]) => {
      const li = items.find((x) => x.textContent === S.view.SEV[k]); const sw = li && li.childNodes.find((c) => c.attrs && c.attrs['data-shape']);
      if (!sw) throw new Error('圖例缺少嚴重度：' + k);
      if (sw.getAttribute('data-shape') !== shape || sw.style.background !== T.sev[k]) throw new Error('圖例的嚴重度外形或顏色與 theme 不一致：' + k);
      if (shape === 'triangle' && !String(sw.style.clipPath).includes('polygon')) throw new Error('圖例的警告應畫成三角形');
    });
  });
  await step('高亮不重複：滑過、搜尋、選取、追蹤各自不同，滑過時節點本身有回饋', () => {
    const graph = App.graph; const M = S.view.theme.mark;
    forSchemes((mode) => {
      if (M.hover === M.find) throw new Error(`${mode}：滑過與搜尋結果不應同色`);
      if (M.select === M.trace) throw new Error(`${mode}：選取與路由追蹤不應同色`);
      if ([M.select, M.hover, M.find, M.trace].some((c) => c === M.bad || c === M.good || Object.values(S.view.theme.sev).includes(c))) throw new Error(`${mode}：標示色不應使用狀態色`);
    });
    const nodes = ['hv-a', 'hv-b'].map((id) => ({ id, label: id, kind: 'router', collected: true, group: 't' }));
    const pos = new Map([['hv-a', { x: 0, y: 0 }], ['hv-b', { x: 200, y: 0 }]]);
    withGraph(graph, nodes, [{ id: 'hv-e', a: 'hv-a', b: 'hv-b', cls: '1g', count: 1, evidence: 'adjacency' }], pos, () => {
      const ring = (ops) => ops.filter((o) => o.op === 'stroke' && o.style === M.hover && o.path.some((p) => p.t === 'A' && Math.hypot(p.x, p.y) < 0.01));
      if (ring(recordCanvas(graph.ctx, () => graph.draw())).length) throw new Error('沒有滑過時不應有滑過環');
      graph.hover = { type: 'node', id: 'hv-a' };
      if (!ring(recordCanvas(graph.ctx, () => graph.draw())).length) throw new Error('滑過節點時節點本身應有回饋');
    });
  });
  await step('OSPF-only 鄰接不畫拓樸 edge，仍保留 L3 設備細節與來源', async () => {
    const input = 'R_A (10.0.0.1):\n### /export terse\n/ip address add address=10.254.0.1/30 interface=ether48\n'
      + '### /routing ospf neighbor print detail\n 0 instance=default address=10.254.0.2 router-id=2.2.2.2 interface=ether48 state=Full\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    if (App.snap.meta.inputHash !== hash) throw new Error('OSPF 基準未建立');
    if (App.snap.model.links.length || App.graph.edges.length) throw new Error('OSPF-only adjacency 不應形成拓樸 edge');
    if (!App.snap.model.ospfAdjacencies.length) throw new Error('OSPF L3 鄰接資訊遺失');
    App.select({ type: 'device', key: 'R_A' });
    // 右欄只有一行摘要（OSPF 鄰接 N 個），點了開路由表視窗的 OSPF 分頁：列出鄰接與來源行
    const n = App.Q.ospfAdjacenciesOf('R_A').length;
    const link = $('#detail').testAll('.routes-tab').find((a) => a.getAttribute('data-tab') === 'ospf');
    if (!link || !link.textContent.includes(`OSPF 鄰接 ${S.view.num(n)} 個`)) throw new Error('設備細節沒有顯示獨立 OSPF 鄰接的摘要');
    link.click();
    const panel = $('#tdlg-panel-ospf');
    if (!$('#dlg-table').open || !panel || panel.getAttribute('hidden') != null || panel.testAll('tbody tr').length !== n) throw new Error('點摘要應開路由表視窗的 OSPF 分頁，列數同 Q.ospfAdjacenciesOf');
    if (!panel.textContent.includes('第 5 行')) throw new Error('OSPF 細節沒有來源行連結');
    $('#tdlg-close').click();
  });
  await step('表格可點標頭排序（路由表視窗的搜尋結果），IP 欄依數值順序', async () => {
    const input = 'R_A (10.0.0.1):\n### /ip route print detail without-paging\n'
      + 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC\n'
      + ' 0 As  dst-address=10.10.0.0/16 gateway=10.0.0.9 distance=1\n'
      + ' 1 As  dst-address=10.9.0.0/16 gateway=10.0.0.2 distance=1\n'
      + ' 2 As  dst-address=10.100.0.0/16 gateway=10.0.0.3 distance=1\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    // 三條路由的下一跳都不同（各自一組）：搜尋 10.0.0.0/8 讓三條列在同一張表
    App.select({ type: 'routes', dev: 'R_A', search: '10.0.0.0/8' });
    const res = () => routesList().querySelector('.biglist-result');
    const th = res().testAll('th').find((el) => el.textContent.startsWith('網段'));
    if (!th) throw new Error('路由表應有可排序的網段標頭');
    th.querySelector('.th-sort').click();
    const order = () => res().testAll('tbody tr').map((tr) => tr.textContent).filter((s) => /^10\.\d+\.0\.0\/16/.test(s)).map((s) => s.split('/')[0]);
    if (order().join() !== '10.9.0.0,10.10.0.0,10.100.0.0') throw new Error('網段應依 IP 數值升冪：' + order());
    res().testAll('th').find((el) => el.textContent.startsWith('網段')).querySelector('.th-sort').click();
    if (order().join() !== '10.100.0.0,10.10.0.0,10.9.0.0') throw new Error('再點一次應降冪：' + order());
    App.select(null);
  });
  await step('CAPsMAN Wi-Fi 多 MAC 保留菱形提示，MAC 位置列入終端清單', async () => {
    const input = 'SW_A (10.0.0.1):\n### /interface print detail\n'
      + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
      + ' 7    RS ;;; managed by CAPsMAN, traffic processing on\n'
      + '              CAP         ;;; mode: AP, SSID: test, channel: 2412/n\n'
      + '         name="wifi1" default-name="wifi1" type="wifi" actual-mtu=1500\n'
      + ' 9  D RS ;;; managed by CAPsMAN, traffic processing on\n'
      + '              CAP         ;;; mode: AP, SSID: test-5g, channel: 5660/ac/Ceee\n'
      + '         name="wifi8" type="wifi" actual-mtu=1500\n'
      + '### /interface bridge host print detail\n'
      + ' 0 D mac-address=14:63:93:C4:13:24 on-interface=wifi1 bridge=bridge\n'
      + ' 1 D mac-address=3C:64:CF:0C:C4:63 on-interface=wifi1 bridge=bridge\n'
      + ' 2 D mac-address=06:89:53:94:06:0F on-interface=wifi8 bridge=bridge\n'
      + ' 3 D mac-address=18:F0:E4:FF:EF:35 on-interface=wifi8 bridge=bridge\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    if (App.snap.meta.inputHash !== hash) throw new Error('Wi-Fi 基準未建立');
    const wifis = App.snap.model.interfaces.filter((i) => ['wifi1', 'wifi8'].includes(i.name));
    if (!wifis.every((i) => i.status === 'up' && !i.unknownPeer && !i.edge && i.macs.length === 2)) throw new Error('Wi-Fi 不應列為終端介面');
    const diamonds = App.graph.nodes.filter((n) => n.kind === 'downstream' && n.parent === 'SW_A');
    if (diamonds.length !== 2 || !diamonds.every((n) => n.id === '?p|SW_A|wifi1' || n.id === '?p|SW_A|wifi8')) throw new Error('Wi-Fi 多 MAC 應保留菱形圖面提示');
    const wifiRows = App.Q.inventory().rows.endpoints.filter((r) => r.wifi);
    if (wifiRows.length !== 4 || !wifiRows.every((r) => ['wifi1', 'wifi8'].includes(r.ifc))) throw new Error('每個 Wi-Fi MAC 觀察位置都應列入終端清單');
    if (App.snap.findings.some((f) => f.id === 'A02')) throw new Error('Wi-Fi 漫遊 MAC 位置不應觸發 A02');
    App.select({ type: 'endpoints', dev: 'SW_A' });
    const detail = text('#detail');
    if (!detail.includes('14:63:93:c4:13:24') || !detail.includes('18:f0:e4:ff:ef:35')) throw new Error('設備詳情應逐筆顯示 Wi-Fi MAC 位置');
  });
  await step('veth 與 Wi-Fi 鏈路以專用線型識別，顏色維持鏈路類別色', async () => {
    const input = 'SW_A (10.0.0.1):\n### /interface print detail\n'
      + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
      + ' 0  R  name="veth1" type="veth" mtu=1500\n'
      + ' 1  R  name="ether5" type="ether" mtu=1500\n'
      + '### /interface bridge host print detail\n'
      + ' 0 D mac-address=02:AA:BB:00:00:01 on-interface=veth1 bridge=bridge1\n'
      + ' 1 D mac-address=AA:BB:CC:00:00:02 on-interface=ether5 bridge=bridge1\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    if (App.snap.meta.inputHash !== hash) throw new Error('veth 基準未建立');
    const v = App.graph.nodes.find((n) => n.id === '?p|SW_A|veth1'); const e = App.graph.nodes.find((n) => n.id === '?p|SW_A|ether5');
    if (!v || !e) throw new Error('veth1 與 ether5 終端都應畫出');
    const T = S.view.theme; const vs = T.endpoint.byType.veth; const ws = T.endpoint.byType.wireless;
    if (v.ifStyle) throw new Error('veth 節點外觀不應改變，只識別連線');
    const ve = App.graph.edges.find((x) => x.b === v.id); const ee = App.graph.edges.find((x) => x.b === e.id);
    if (!ve || ve.ifStyle !== vs || ee.ifStyle) throw new Error('veth 連線應帶專用線型，其他連線不變');
    const pats = [vs.dash, ws.dash, T.weakEdge.hearsay.dash, T.weakEdge.inferred.dash, T.edge.oob.dash].map((d) => d.join());
    if (new Set(pats).size !== pats.length) throw new Error('veth、Wi-Fi、單側觀察、推論鏈路與管理線的線型應各不相同');
    const g = App.graph; const ops = recordCanvas(g.ctx, () => g.draw());
    const seg = (id) => { const a = g.pos.get('SW_A'); const b = g.pos.get(id); return ops.filter((o) => o.op === 'stroke' && o.path.length === 2 && near([o.path[0]], a, 0.01) && near([o.path[1]], b, 0.01)); };
    const ratio = (d) => d.map((x) => (x / d[0]).toFixed(3)).join();
    const vStroke = seg(v.id)[0]; const eStroke = seg(e.id)[0];
    if (!vStroke || ratio(vStroke.dash) !== ratio(vs.dash) || vStroke.style !== T.edge[ve.cls].c) throw new Error('veth 連線應以專用線型、連線類別色畫出');
    if (!eStroke || ratio(eStroke.dash) !== ratio(T.weakEdge.hearsay.dash)) throw new Error('一般終端連線應維持單側觀察線型');
    if (!/容器 veth/.test(v.tip)) throw new Error('提示應標示容器 veth');
    if (!Array.from(document.testAll('#legend .li')).some((el) => /容器 veth/.test(el.textContent))) throw new Error('圖例缺少 veth');
  });
  await step('Wi-Fi 介面不列為終端；MAC 位置與單 MAC 有線埠均列入清單', async () => {
    const input = 'SW_A (10.0.0.1):\n### /interface print detail\n'
      + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
      + ' 0  R  name="wifi1" type="wifi" mtu=1500\n'
      + ' 1  R  name="wlan1" type="wlan" mtu=1500\n'
      + ' 2  R  name="ether5" type="ether" mtu=1500\n'
      + '### /interface bridge host print detail\n'
      + ' 0 D mac-address=14:63:93:C4:13:24 on-interface=wifi1 bridge=bridge1\n'
      + ' 1 D mac-address=3C:64:CF:0C:C4:63 on-interface=wifi1 bridge=bridge1\n'
      + ' 2 D mac-address=06:89:53:94:06:0F on-interface=wlan1 bridge=bridge1\n'
      + ' 3 D mac-address=AA:BB:CC:00:00:02 on-interface=ether5 bridge=bridge1\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    if (App.snap.meta.inputHash !== hash) throw new Error('Wi-Fi 基準未建立');
    const wifis = App.snap.model.interfaces.filter((i) => ['wifi1', 'wlan1'].includes(i.name));
    const ethernet = App.snap.model.interfaces.find((i) => i.name === 'ether5');
    const endpoints = App.graph.nodes.filter((n) => n.virtual && n.parent === 'SW_A');
    if (!wifis.every((i) => !i.edge && !i.unknownPeer)) throw new Error('Wi-Fi 介面不應列為終端');
    if (!ethernet || !ethernet.edge || !ethernet.unknownPeer) throw new Error('單 MAC 有線介面應列為終端');
    if (endpoints.length !== 3 || !endpoints.some((n) => n.id === '?p|SW_A|ether5')
      || !endpoints.filter((n) => n.kind === 'downstream').every((n) => n.id === '?p|SW_A|wifi1' || n.id === '?p|SW_A|wlan1')) {
      throw new Error('Wi-Fi 多 MAC 應保留菱形提示，並與單 MAC 有線終端分別呈現');
    }
    const wifiRows = App.Q.inventory().rows.endpoints.filter((r) => r.wifi);
    if (wifiRows.length !== 3 || !wifiRows.every((r) => ['wifi1', 'wlan1'].includes(r.ifc))) throw new Error('Wi-Fi 清單應逐一列出每個 MAC 觀察位置');
  });
  await step('左右欄可拖曳調整寬度，且有下限與上限', async () => {
    const grip = document.querySelector('#left .grip-left'); const rgrip = document.querySelector('#right .grip-right');
    if (!grip || !rgrip) throw new Error('缺少拖曳把手');
    const fire = (t, ev) => (docListeners[t] || []).slice().forEach((f) => f(ev));
    const drag = (g, x0, x1) => { g.dispatch('mousedown', { clientX: x0 }); fire('mousemove', { clientX: x1 }); fire('mouseup', {}); };
    const w0 = App.layout.left; drag(grip, 330, 330 + 100);
    if (App.layout.left !== w0 + 100 || !$('#main').style.gridTemplateColumns.startsWith((w0 + 100) + 'px')) throw new Error('左欄應加寬 100px');
    drag(grip, 500, -5000); if (App.layout.left !== 240) throw new Error('左欄不應小於下限');
    const r0 = App.layout.right; drag(rgrip, 1000, 900);
    if (App.layout.right !== r0 + 100) throw new Error('右欄往左拖應加寬');
    rgrip.dispatch('dblclick'); if (App.layout.right !== 400) throw new Error('雙擊應還原預設寬度');
    grip.dispatch('dblclick');
  });
  await step('鍵盤：畫布可聚焦，N 輪流移到設備、Enter 開啟詳細資料、Esc 取消選取，方向鍵平移、+／- 縮放', () => {
    const g = App.graph; const cv = $('#graph');
    if (cv.getAttribute('tabindex') !== '0' || !/Enter/.test(cv.getAttribute('aria-label') || '')) throw new Error('畫布應可聚焦，aria-label 說明按鍵');
    const key = (k, extra) => cv.dispatch('keydown', Object.assign({ key: k }, extra || {}));
    cv.focus(); App.select(null);
    const visible = g.nodes.filter((n) => g.visible(n));
    if (visible.length < 2) throw new Error('測試前提：至少兩個可見節點');
    key('n'); const first = g.kbd;
    if (!first || !g.hover || g.hover.id !== first) throw new Error('按 N 應移到一台設備，並以滑過樣式標示');
    if ($('#tooltip').classList.contains('hidden') || !text('#graph-live')) throw new Error('鍵盤移到設備時應顯示提示，並讀給螢幕閱讀器');
    key('n'); const second = g.kbd;
    if (second === first) throw new Error('再按 N 應移到下一台');
    key('N', { shiftKey: true }); if (g.kbd !== first) throw new Error('Shift+N 應回到上一台');
    const seen = new Set(); for (let i = 0; i < visible.length; i++) { key('n'); seen.add(g.kbd); }
    if (seen.size !== visible.length) throw new Error('N 應能輪流走過每一台可見的設備');
    key('Enter');
    const n = g.nodeById.get(g.kbd);
    if (!App.sel) throw new Error('Enter 應選取設備並開啟詳情');
    if (!n.virtual && (App.sel.type !== 'device' || App.sel.key !== n.id || !text('#detail').includes(App.Q.getDevice(n.id).name))) throw new Error('Enter 應開啟這台設備的詳情');
    key('Escape'); if (App.sel || g.kbd || g.hover) throw new Error('Esc 應取消選取');
    const t0 = { tx: g.tx, ty: g.ty, s: g.s };
    key('ArrowRight'); if (!(g.tx < t0.tx)) throw new Error('方向鍵應平移畫面');
    key('ArrowDown'); if (!(g.ty < t0.ty)) throw new Error('方向鍵應平移畫面');
    key('+'); if (!(g.s > t0.s)) throw new Error('+ 應放大'); const s1 = g.s;
    key('-'); if (!(g.s < s1)) throw new Error('- 應縮小');
    let prevented = false; cv.dispatch('keydown', { key: 'n', ctrlKey: true, preventDefault() { prevented = true; } });
    if (prevented) throw new Error('帶 Ctrl 的按鍵應交給瀏覽器');
    key('0');
  });
  await step('Pointer 事件：滑鼠拖曳節點與平移、觸控點選與點兩下', () => {
    const g = App.graph; const cv = $('#graph');
    const fire = (t, target, p, extra) => (winListeners[t] || []).forEach((f) => f(Object.assign({ target, clientX: p.x, clientY: p.y, pointerId: 1, pointerType: 'mouse', button: 0, preventDefault() {} }, extra || {})));
    const down = (p, extra) => cv.dispatch('pointerdown', Object.assign({ clientX: p.x, clientY: p.y, pointerId: 1, pointerType: 'mouse', button: 0 }, extra || {}));
    const n = g.nodes.find((x) => g.visible(x) && !x.virtual); const p0 = g.toScreen(g.pos.get(n.id)); const w0 = Object.assign({}, g.pos.get(n.id));
    let moved = null; const oldMoved = g.handlers.moved; g.on('moved', (id) => { moved = id; });
    try {
      down(p0); fire('pointermove', cv, { x: p0.x + 50, y: p0.y + 30 }); fire('pointerup', cv, { x: p0.x + 50, y: p0.y + 30 });
      const w1 = g.pos.get(n.id);
      if (moved !== n.id || Math.abs(w1.x - w0.x - 50 / g.s) > 0.01 || Math.abs(w1.y - w0.y - 30 / g.s) > 0.01) throw new Error('拖曳節點應移動節點並通知儲存位置');
      g.pos.set(n.id, w0);
      const empty = { x: -5000, y: -5000 }; const tx = g.tx; moved = null;
      down(empty); fire('pointermove', cv, { x: empty.x + 40, y: empty.y }); fire('pointerup', cv, { x: empty.x + 40, y: empty.y });
      if (Math.abs(g.tx - tx - 40) > 0.01 || moved) throw new Error('拖曳背景應平移畫面，不移動節點');
      // 觸控：點一下選取（命中範圍較大），點兩下等同雙擊；沒有 hover
      App.select(null); const touch = { pointerType: 'touch', pointerId: 7 };
      const near = { x: p0.x + g.radius(n) * g.s + 8, y: p0.y };
      fire('pointermove', cv, near, touch); if (g.hover && g.hover.id === n.id) throw new Error('觸控不應觸發 hover');
      down(near, touch); fire('pointerup', cv, near, Object.assign({ timeStamp: 1000 }, touch));
      if (!App.sel || App.sel.key !== n.id) throw new Error('觸控點一下應選取設備（命中範圍包含節點外側一點）');
      let dbl = null; const oldDbl = g.handlers.dblclick; g.on('dblclick', (it) => { dbl = it; });
      try {
        down(near, touch); fire('pointerup', cv, near, Object.assign({ timeStamp: 1200 }, touch));
        if (!dbl || dbl.id !== n.id) throw new Error('觸控快速點兩下應等同雙擊');
      } finally { g.on('dblclick', oldDbl); }
      App.select(null);
    } finally { g.on('moved', oldMoved); }
  });
  await step('焦點框、篩選選項按鈕、強制色彩與減少動態效果', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    SCHEMES.forEach((mode) => {
      // 亮色的白底是 --panel（暗色換成深色的 --panel）
      const v = cssVarsOf(css, mode); const bgs = [v.panel, v.surface];
      // 焦點框的顏色（var() 展開後）對白底與表面色 ≥ 3:1
      const ring = v['focus-ring'].replace(/var\(--([\w-]+)\)/g, (_, n) => v[n]);
      const colors = (ring.match(/#[0-9a-fA-F]{6}|rgba?\([^)]*\)/g) || []);
      const outer = colors[colors.length - 1];
      if (!outer || bgs.some((bg) => contrastOf(outer, bg) < 3)) throw new Error(`${mode}：焦點框對底色應 ≥ 3:1：` + ring);
      // 按鈕、連結、清單列與表格列：2px 實線 outline（tr 的 box-shadow 在 Chrome／Safari 不會畫），顏色對白底與表面色 ≥ 3:1
      const fo = (v['focus-outline'] || '').match(/^2px solid var\(--([\w-]+)\)$/);
      if (!fo || bgs.some((bg) => contrastOf(v[fo[1]], bg) < 3)) throw new Error(`${mode}：--focus-outline 應是 2px 實線且對底色 ≥ 3:1：` + v['focus-outline']);
      // 圖形與欄位邊框（1.4.11）：警告外形、輸入框邊框對白底與表面色 ≥ 3:1
      [['--sev-warn', v['sev-warn']], ['--sev-error', v['sev-error']], ['--line-input', v['line-input']]].forEach(([n, c]) => {
        if (!c || bgs.some((bg) => contrastOf(c, bg) < 3)) throw new Error(`${mode}：${n} ${c} 對底色應 ≥ 3:1`);
      });
      if (v['sev-warn'].toLowerCase() !== S.view.theme.palettes[mode].sev.warn.toLowerCase()) throw new Error(`${mode}：--sev-warn 與 theme.sev.warn 不一致`);
    });
    if (!/#graph:focus-visible\s*\{[^}]*outline:/.test(css)) throw new Error('畫布取得焦點時應有明顯的焦點框');
    const ruleFor = (sel) => Array.from(css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)).filter((m) => m[1].split(',').map((x) => x.trim()).includes(sel)).map((m) => m[2]).join(';');
    ['tr.click:focus-visible', '.fitem:focus-visible', 'button:focus-visible', 'a:focus-visible'].forEach((sel) => { if (!/outline:\s*var\(--focus-outline\)/.test(ruleFor(sel))) throw new Error(sel + ' 聚焦應用 2px 實線 outline'); });
    if (!/\.chip\.btn:focus-visible\s*\{[^}]*outline:\s*var\(--focus-outline\)/.test(css)) throw new Error('篩選選項聚焦應用 outline');
    if (!/input\[type=text\], input\[type=search\], select, textarea \{[^}]*border: 1px solid var\(--line-input\)/.test(css)) throw new Error('輸入框邊框應用 --line-input');
    if (/\.chip \.n[^{]*\{[^}]*opacity/.test(css)) throw new Error('chip 內的筆數不應降低不透明度（對比不足）');
    // 狀態訊息讓輔助科技念出
    ['#banner', '#input-status'].forEach((id) => { if ($(id).getAttribute('role') !== 'status') throw new Error(id + ' 應有 role=status'); });
    if (!/@media \(forced-colors: active\)/.test(css)) throw new Error('應支援強制色彩模式');
    if (!/#graph\s*\{[^}]*touch-action:\s*none/.test(css)) throw new Error('畫布應自己處理觸控拖曳');
    // 篩選選項是可聚焦的按鈕
    App.select(null); goStep('triage');
    const chips = $('#pane-findings').querySelector('.summary').testAll('.chip');
    if (!chips.length || !chips.every((c) => c.tagName === 'BUTTON' && c.getAttribute('type') === 'button')) throw new Error('篩選選項應是 <button>');
    // 減少動態效果：力導向一次算完，不排動畫
    const g = App.graph; const before = JSON.stringify(Array.from(g.pos)); const oldMM = window.matchMedia;
    window.matchMedia = (q) => ({ matches: /prefers-reduced-motion:\s*reduce/.test(q) });
    try {
      raf.q = []; $('#btn-force').click();
      if ($('#btn-force').classList.contains('on') || raf.q.length) throw new Error('減少動態效果時不應播放力導向動畫');
      if (JSON.stringify(Array.from(g.pos)) === before) throw new Error('減少動態效果時應直接套用力導向的結果');
    } finally { if (oldMM) window.matchMedia = oldMM; else delete window.matchMedia; }
  });
  await step('畫布：先填滿 theme 的底色（PNG 不透明）、字型與 CSS 一致、過長標籤截斷', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8'); const v = cssVars(css); const T = S.view.theme; const g = App.graph;
    SCHEMES.forEach((mode) => { if (cssVarsOf(css, mode).surface !== T.palettes[mode].canvas.surface) throw new Error(`${mode}：theme.canvas.surface 應與 --surface 相同`); });
    // 字型堆疊單一來源：CSS 的 --font-sans／--font-mono 與 theme.font 同一串，body 用 --font-sans；canvas.js 不寫死字族或 bold
    if (v['font-sans'] !== T.font.sans) throw new Error('--font-sans 與 theme.font.sans 不一致：' + v['font-sans']);
    if (v['font-mono'] !== T.font.mono) throw new Error('--font-mono 與 theme.font.mono 不一致：' + v['font-mono']);
    if (!/(?:^|\n)body\s*\{[^}]*font:\s*var\(--fs-base\)\/var\(--lh-body\)\s+var\(--font-sans\)/.test(css)) throw new Error('body 應使用 --fs-base／--lh-body／--font-sans');
    if (v.mono !== 'var(--font-mono)') throw new Error('--mono 應指向 --font-mono');
    const canvasSrc = fs.readFileSync(path.join(ROOT, 'src/view/graph/canvas.js'), 'utf8');
    if (/sans-serif|monospace|JhengHei|PingFang|Consolas|\bbold\b|font\.ui\b/.test(canvasSrc)) throw new Error('canvas.js 的字型應取自 theme.font');
    const long = '很長的設備名稱'.repeat(8) + '-END';
    const nodes = [{ id: 'fx-a', label: long, kind: 'router', collected: true, group: 't' }, { id: 'fx-b', label: 'short', kind: 'router', collected: true, group: 't' }];
    withGraph(g, nodes, [{ id: 'fx-e', a: 'fx-a', b: 'fx-b', cls: '1g', count: 1, evidence: 'adjacency', labelA: 'ether1', labelB: 'ether2' }],
      new Map([['fx-a', { x: 0, y: 0 }], ['fx-b', { x: 600, y: 0 }]]), () => {
        g.s = 1.5; const ops = recordCanvas(g.ctx, () => g.draw());
        const bg = ops.find((o) => o.op === 'rect');
        if (!bg || ops.indexOf(bg) !== 0 || bg.style !== T.canvas.surface || bg.w < g.w || bg.h < g.h) throw new Error('繪圖應先以 theme 的畫布底色填滿畫面');
        const texts = ops.filter((o) => o.op === 'text');
        const cut = texts.find((o) => o.text.endsWith('…'));
        if (!cut || cut.text.length >= long.length || !long.startsWith(cut.text.slice(0, -1))) throw new Error('過長的標籤應截斷並加上「…」');
        if (!texts.some((o) => o.text === 'short')) throw new Error('短標籤不應截斷');
        if (!texts.every((o) => String(o.font).endsWith(T.font.sans) || String(o.font).endsWith(T.font.mono))) throw new Error('畫布文字應使用 theme 的字型清單');
        const name = texts.find((o) => o.text === 'short'); const px = name && parseFloat(String(name.font).match(/([\d.]+)px/)[1]) * g.s;
        if (!px || Math.abs(px - T.font.labelPx) > 0.01) throw new Error('設備名稱在螢幕上應為 theme.font.labelPx：' + px);
        // 埠名在螢幕上固定 portPx（比設備名小），放大、縮小、滑過都一樣
        if (!(T.font.portPx < T.font.labelPx)) throw new Error('埠名字級應比設備名稱小');
        [[1.5, null], [4, null], [0.4, { type: 'node', id: 'fx-a' }]].forEach(([sc, hv]) => {
          g.s = sc; g.tx = g.w / 2 - 100 * sc; g.ty = g.h / 2; g.hover = hv; const t2 = recordCanvas(g.ctx, () => g.draw()).filter((o) => o.op === 'text' && /^eth/.test(o.text));
          if (!t2.length) throw new Error(`縮放 ${sc} 應畫出埠名`);
          t2.forEach((o) => { const ppx = parseFloat(String(o.font).match(/([\d.]+)px/)[1]) * sc; if (Math.abs(ppx - T.font.portPx) > 0.01) throw new Error(`埠名在螢幕上應固定為 theme.font.portPx（縮放 ${sc}）：${ppx}`); });
        });
        g.hover = null;
      });
    // 匯出 PNG：匯出前重畫（畫面已有底色）
    let drew = 0; const oldDraw = g.draw; g.draw = function () { drew++; return oldDraw.call(this); };
    try { await captureDownloads(() => $('#btn-png').click()); } finally { g.draw = oldDraw; }
    if (!drew) throw new Error('匯出 PNG 前應重畫畫布');
  });
  await step('字級與 CJK 排版：字級階梯、行高、斷行規則、窄螢幕不縮小、畫面不寫死字級', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8'); const v = cssVars(css);
    const want = { 'fs-xs': '13px', 'fs-sm': '14px', 'fs-md': '14px', 'fs-base': '15px', 'fs-lg': '17px', 'fs-xl': '20px', 'fs-2xl': '24px', 'lh-body': '1.65', 'lh-prose': '1.7', 'lh-heading': '1.4' };
    Object.entries(want).forEach(([k, x]) => { if (v[k] !== x) throw new Error(`--${k} 應為 ${x}：${v[k]}`); });
    const body = (css.match(/(?:^|\n)body\s*\{([^}]*)\}/) || [])[1] || '';
    ['line-break:\\s*strict', 'word-break:\\s*normal', 'overflow-wrap:\\s*break-word', 'text-autospace:', 'text-spacing-trim:'].forEach((r) => {
      if (!new RegExp(r).test(body)) throw new Error('body 缺少 CJK 排版規則 ' + r);
    });
    if (/break-all/.test(css)) throw new Error('不用 word-break: break-all（中文與識別字都會被逐字拆開）');
    if (/letter-spacing:(?!\s*0[;\s}])/.test(css)) throw new Error('CJK 不加字距：letter-spacing 只能是 0（不用正負字距）');
    // chip 與 tooltip 可以換行（長文字不撐破版面）；chip 不被擠窄（flex-shrink: 0），短的仍是單列
    const rule = (sel) => (css.match(new RegExp('(?:^|\\n)' + sel.replace(/\./g, '\\.') + ' \\{([^}]*)\\}')) || [])[1] || '';
    if (/nowrap/.test(rule('.chip')) || !/flex-shrink: 0/.test(rule('.chip')) || !/max-width: 100%/.test(rule('.chip'))) throw new Error('chip 應可換行且不被擠窄：' + rule('.chip'));
    if (/nowrap/.test(rule('.tooltip')) || !/max-width:/.test(rule('.tooltip'))) throw new Error('tooltip 應可換行並有最大寬度：' + rule('.tooltip'));
    if (/font-weight:\s*(500|700|bold)/.test(css)) throw new Error('中文粗體只用 600（400／600 兩階）');
    if (!/(?:^|\n)h1, h2, h3, h4 \{[^}]*line-height:\s*var\(--lh-heading\)[^}]*font-weight:\s*600/.test(css)) throw new Error('標題應使用 --lh-heading 與 600');
    if (!/\.note-box[^{]*\{[^}]*line-height:\s*var\(--lh-prose\)/.test(css)) throw new Error('說明段落應使用 --lh-prose');
    // 字級只用變數（:root 之外沒有數字字級）
    const rest = css.replace(/:root\s*\{[^}]*\}/, '');
    const lits = rest.match(/font(?:-size)?:\s*\d[^;]*;/g);
    if (lits) throw new Error('字級應使用 --fs-* 變數：' + lits.join(' '));
    // 窄螢幕不縮小字級：max-width 媒體查詢內不設 font-size
    let i = 0;
    while ((i = css.indexOf('@media (max-width', i)) >= 0) {
      let d = 0; let j = css.indexOf('{', i);
      for (let k = j; k < css.length; k++) { if (css[k] === '{') d++; else if (css[k] === '}' && !--d) { j = k; break; } }
      const block = css.slice(i, j);
      if (/font-size:/.test(block)) throw new Error('窄螢幕不應改變字級：' + block.match(/[^{}]*\{[^}]*font-size:[^;]*;/)[0].trim());
      i = j;
    }
    // 表格內的識別字（.mono、VLAN 清單）不逐字斷行，表格在自己的框內橫向捲動
    if (!/table\.t \.mono, table\.t \.vlanlist \{[^}]*white-space:\s*nowrap/.test(css)) throw new Error('表格內的識別字應 nowrap');
    if (!/\.table-scroll \{[^}]*overflow-x:\s*auto/.test(css)) throw new Error('表格外層應可橫向捲動');
    const t = S.view.table([{ t: 'a', f: (r) => r }], ['x'], {});
    if (!t.classList.contains('table-scroll') || !t.querySelector('table')) throw new Error('V.table 應包在可橫向捲動的外框裡');
    // 畫面程式與 index.html 不寫死字級
    const sizeLits = [];
    jsFiles('src/view').forEach((f) => {
      const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of code.matchAll(/font-size['"]?\s*:\s*['"]?\d+|fontSize\s*[:=]\s*['"]?\d+/g)) sizeLits.push(`${f}：${m[0]}`);
    });
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    for (const m of html.matchAll(/font-size:\s*\d+px/g)) sizeLits.push('index.html：' + m[0]);
    if (sizeLits.length) throw new Error('字級應使用 CSS 變數：' + sizeLits.join('；'));
    // 顏色只在 theme.js（與 app.css 的變數）：其他畫面程式去掉註解後（字串保留，色碼多半寫在字串裡）不寫色碼，index.html 的 inline style 也不寫
    const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    const colorLits = jsFiles('src/view').filter((f) => path.basename(f) !== 'theme.js').flatMap((f) =>
      Array.from(noComments(fs.readFileSync(path.join(ROOT, f), 'utf8')).matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(/g)).map((m) => `${f}：${m[0]}`));
    for (const m of html.matchAll(/style="[^"]*(#[0-9a-fA-F]{3,6}\b|rgba?\()/g)) colorLits.push('index.html：' + m[1]);
    if (colorLits.length) throw new Error('顏色應取自 theme 或 CSS 變數：' + colorLits.join('；'));
  });
  await step('配色跟隨系統深淺：亮暗兩組形狀相同、原地套用、change 只重畫一次、圖上的標示與廠商色跟著換、PNG 固定亮色', async () => {
    const T = S.view.theme; const VA = S.view.app; const g = App.graph; const P = T.palettes;
    // 用範例資料（有 IP 位址與依廠商上色的終端），結束後換回原本的輸入，後面的步驟不受影響
    const prevInput = $('#input-text').value; const restore = App.snap && App.snap.meta.inputHash === S.util.hash(S.readers.PASTE + '\n' + prevInput);
    await buildInput(S.samples['sample-bundle.txt']);
    if (!P || !P.light || !P.dark || typeof T.apply !== 'function') throw new Error('theme 應有 palettes.light／dark 與 apply(mode)');
    // 兩組的葉節點路徑集合相同；每個葉節點都是顏色，且就是 theme 上同一路徑的值（啟動時沒有 matchMedia，視為亮色）
    const leaves = (o, pre) => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? leaves(v, pre + k + '.') : [[pre + k, v]]));
    const at = (o, p) => p.split('.').reduce((x, k) => x[k], o);
    const lk = leaves(P.light, '').map(([p]) => p).sort(); const dk = leaves(P.dark, '').map(([p]) => p).sort();
    if (!lk.length || lk.join('|') !== dk.join('|')) throw new Error('亮、暗兩組配色的鍵集合應相同');
    ['light', 'dark'].forEach((m) => leaves(P[m], '').forEach(([p, c]) => { if (!/^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(c)) throw new Error(`palettes.${m}.${p} 應是顏色：${c}`); }));
    if (!Object.isFrozen(P.light) || !Object.isFrozen(P.light.canvas)) throw new Error('配色應凍結，只能經 apply 套到 theme');
    if (T.mode !== 'light') throw new Error('沒有 matchMedia 時應是亮色：' + T.mode);
    lk.forEach((p) => { if (at(T, p) !== at(P.light, p)) throw new Error('亮色時 theme.' + p + ' 應等於 palettes.light'); });
    try { T.mode = 'dark'; } catch (e) { /* 唯讀：嚴格模式下指定會丟錯 */ }
    if (T.mode !== 'light') throw new Error('theme.mode 應唯讀，只能經 apply 改變');
    try { T.apply('sepia'); throw new Error('未知的模式應丟出 RangeError'); } catch (e) { if (!(e instanceof RangeError)) throw e; }
    // 圖上標示的顏色由 mark 的值換算：同一組 mark 的值不可重複，換算才不會混淆
    ['light', 'dark'].forEach((m) => { const vs = Object.values(P[m].mark); if (new Set(vs).size !== vs.length) throw new Error(`palettes.${m}.mark 的值應互不相同`); });
    // apply 原地改寫葉節點：子物件的參考不變（canvas.js 等在載入時存下子物件），值等於該組配色
    const refs = ['kind', 'edge', 'mark', 'canvas', 'endpoint', 'text', 'sev', 'vlan', 'l2', 'l3', 'l4', 'firewall', 'diff', 'trend'].map((k) => [k, T[k]])
      .concat([['edge.lag', T.edge.lag], ['canvas.group', T.canvas.group], ['endpoint.vendor', T.endpoint.vendor], ['l4.status.allow', T.l4.status.allow]]);
    const surface = T.canvas.surface;
    try {
      T.apply('dark');
      if (T.mode !== 'dark') throw new Error('apply("dark") 後 mode 應是 dark');
      refs.forEach(([k, r]) => { if (at(T, k) !== r) throw new Error('apply 不應換掉 theme.' + k + ' 物件'); });
      lk.forEach((p) => { if (at(T, p) !== at(P.dark, p)) throw new Error('暗色時 theme.' + p + ' 應等於 palettes.dark'); });
      T.canvas.surface = '#000000'; T.apply('light');
      if (T.canvas.surface !== P.light.canvas.surface) throw new Error('apply 應覆寫每個顏色葉節點');
    } finally { T.canvas.surface = surface; T.apply('light'); }
    // matchMedia：監聽只綁一次；change 時套用配色、重建圖例、只重畫一次
    const listeners = []; const mq = { matches: true, media: '(prefers-color-scheme: dark)', addEventListener: (t, f) => { if (t === 'change') listeners.push(f); } };
    const oldMM = window.matchMedia;
    window.matchMedia = (q) => (/prefers-color-scheme:\s*dark/.test(q) ? mq : { matches: false, media: q, addEventListener() {} });
    let draws = 0; const oldDraw = g.draw; g.draw = function () { draws++; return oldDraw.call(this); };
    try {
      flushRaf();
      // matchMedia 沒有任何監聽 API：不中止啟動，維持亮色，並以通知告知（不靜默）
      const noApi = { matches: true, media: mq.media }; window.matchMedia = () => noApi;
      const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
      try {
        if (VA.bindColorScheme() !== false || T.mode !== 'light') throw new Error('沒有監聽 API 時應維持亮色並回傳 false，不丟例外');
        if ($('#banner').classList.contains('hidden') || !text('#banner').includes('深淺') || !warned) throw new Error('沒有監聽 API 時應以通知與 console.warn 告知：' + text('#banner'));
      } finally { console.warn = warn; window.matchMedia = (q) => (/prefers-color-scheme:\s*dark/.test(q) ? mq : { matches: false, media: q, addEventListener() {} }); }
      if (VA.bindColorScheme() !== true || T.mode !== 'dark') throw new Error('有 matchMedia 時應綁定監聽並套用系統的深淺');
      if (VA.bindColorScheme() !== false || listeners.length !== 1) throw new Error('配色的監聽只綁一次');
      flushRaf();
      const head0 = $('#legend').firstChild; head0.click(); const legendText = text('#legend'); draws = 0; g.dirty = false;
      // 圖例的色塊取自目前的配色（以錯誤的嚴重度色塊為代表）
      const sevSwatch = () => { const li = Array.from(document.testAll('#legend .li')).find((x) => x.textContent === S.view.SEV.error); const sw = li && li.childNodes.find((c) => c.attrs && c.attrs['data-shape']); return sw && sw.style.background; };
      if (sevSwatch() !== P.dark.sev.error) throw new Error('暗色時圖例的色塊應是暗色：' + sevSwatch());
      mq.matches = false; listeners.forEach((f) => f({ matches: false, media: mq.media }));
      if (T.mode !== 'light') throw new Error('系統改成亮色時應套用亮色');
      // 重畫一次：change 當下不同步繪圖，只標記 dirty，由畫布的 rAF 迴圈在下一個畫格畫一次（多次 redraw() 合併）
      if (draws !== 0 || !g.dirty) throw new Error(`系統深淺改變時應標記重畫、在下一個畫格畫一次（同步繪圖 ${draws} 次、dirty=${g.dirty}）`);
      const tick = () => { if (g.dirty) { g.dirty = false; g.draw(); } }; tick(); tick();
      if (draws !== 1) throw new Error('系統深淺改變時拓樸圖應重畫一次：' + draws);
      const head1 = $('#legend').firstChild;
      if (head1 === head0 || text('#legend') !== legendText) throw new Error('系統深淺改變時應以新的配色重建圖例（內容相同）');
      if (sevSwatch() !== P.light.sev.error) throw new Error('改成亮色後圖例的色塊應是亮色：' + sevSwatch());
      if (head1.getAttribute('aria-expanded') !== 'true') throw new Error('重建圖例應保留展開狀態');
      head1.click();
      // 深淺改變時，打到一半的處理紀錄（備註）不會因重畫而消失：清單不重建，編輯器與輸入保留
      goStep('triage');
      if (!$('#pane-findings').querySelector('.ledger-edit')) $('#pane-findings').testAll('.head').filter((hd) => hd.getAttribute('aria-expanded') === 'false').forEach((hd) => { if (!$('#pane-findings').querySelector('.ledger-edit')) hd.click(); });
      const eb = $('#pane-findings').querySelector('.ledger-edit');
      if (eb) {
        eb.click(); const ed0 = $('#pane-findings').querySelector('.ledger-editor');
        const note0 = ed0.testAll('input').find((i) => i.className.includes('ledger-note')); note0.value = '打到一半的備註';
        mq.matches = true; listeners.forEach((f) => f({ matches: true, media: mq.media }));
        const ed1 = $('#pane-findings').querySelector('.ledger-editor');
        const note1 = ed1 && ed1.testAll('input').find((i) => i.className.includes('ledger-note'));
        if (!note1 || note1.value !== '打到一半的備註') throw new Error('深淺改變時，正在編輯的處理紀錄輸入不應消失');
        ed1.testAll('button').find((b) => b.textContent === '取消').click();
        mq.matches = false; listeners.forEach((f) => f({ matches: false, media: mq.media })); flushRaf();
      } else if (!process.env.SMOKE_INPUT) throw new Error('範例資料的檢查結果應可編輯處理紀錄');
      // 匯出時換色失敗（例如重畫丟例外）：配色仍還原成目前的深淺，並以通知說明失敗，不停在亮色
      mq.matches = true; listeners.forEach((f) => f({ matches: true, media: mq.media })); flushRaf();
      { const rd = g.redraw; let n = 0; g.redraw = function () { if (!n++) throw new Error('模擬重畫失敗'); return rd.call(this); };
        try { VA.exportPng(); } catch (e) { throw new Error('換色失敗時 exportPng 不應丟出例外：' + e.message); } finally { g.redraw = rd; }
        if (T.mode !== 'dark') throw new Error('匯出換色失敗後應還原成目前的深淺：' + T.mode);
        if (!text('#banner').includes('匯出失敗')) throw new Error('匯出換色失敗時應以通知說明：' + text('#banner'));
        flushRaf(); }
      mq.matches = false; listeners.forEach((f) => f({ matches: false, media: mq.media })); flushRaf();
      // 圖上存下的標示色（g.hl）：亮色時搜尋 IP，切到暗色後換成暗色的 mark；暗色時重新搜尋也是暗色的 mark。
      // 兩組 mark 沒有共同的值，所以「屬於哪一組」可以直接判斷
      const lightMarks = Object.values(P.light.mark); const darkMarks = Object.values(P.dark.mark);
      if (lightMarks.some((c) => darkMarks.includes(c))) throw new Error('亮、暗兩組的 mark 不應有相同的值（才分得出圖上的標示屬於哪一組）');
      const addr = App.Q.ipAddresses().find((x) => g.nodeById.has(x.dev)); if (!addr) throw new Error('測試前提：圖上的設備應有 IP 位址');
      const search = () => App.select({ type: 'ip', key: addr.ip });
      const hlColors = () => (g.hl ? [...g.hl.nodes.values(), ...g.hl.edges.values()].map((x) => (typeof x === 'string' ? x : x.c)) : []);
      search();
      if (!hlColors().length || !hlColors().every((c) => lightMarks.includes(c))) throw new Error('亮色時搜尋的標示應是亮色的 mark：' + hlColors().join());
      mq.matches = true; listeners.forEach((f) => f({ matches: true, media: mq.media })); flushRaf();
      if (!hlColors().length || !hlColors().every((c) => darkMarks.includes(c))) throw new Error('切到暗色後，圖上的選取標示應換成暗色的 mark：' + hlColors().join());
      App.select(null); search();
      if (!hlColors().length || !hlColors().every((c) => darkMarks.includes(c))) throw new Error('暗色時搜尋的標示應是暗色的 mark：' + hlColors().join());
      // PNG 固定用亮色：暗色時匯出，畫 PNG 的那一次是亮色（底色、終端廠商色、圖上標示），之後畫面回到暗色
      const modes = []; const ends = () => g.nodes.filter((n) => n.kind === 'endpoint' && n.vendor && App.vendorColors.has(n.vendor));
      if (!ends().length) throw new Error('測試前提：圖上應有依廠商上色的終端');
      if (!ends().every((n) => P.dark.endpoint.vendor.includes(n.color) && !P.light.endpoint.vendor.includes(n.color))) throw new Error('暗色時終端的廠商色應是暗色');
      const drawMode = g.draw; g.draw = function () { modes.push({ mode: T.mode, surface: T.canvas.surface, ends: ends().map((n) => n.color), hl: hlColors() }); return drawMode.call(this); };
      let ops = []; const made = []; const oldCreate = document.createElement;
      document.createElement = (t) => { const el = oldCreate(t); if (t === 'a') made.push(el); return el; };
      try { ops = recordCanvas(g.ctx, () => VA.exportPng()); } finally { document.createElement = oldCreate; g.draw = drawMode; }
      if (made.length !== 1) throw new Error('暗色時也應匯出 PNG');
      if (!modes.length || modes[0].mode !== 'light' || modes[0].surface !== P.light.canvas.surface) throw new Error('匯出 PNG 時應以亮色繪製');
      const lightVendors = P.light.endpoint.vendor;
      if (!modes[0].ends.length || !modes[0].ends.every((c) => lightVendors.includes(c))) throw new Error('匯出 PNG 時終端的廠商色應是亮色');
      if (!modes[0].hl.length || !modes[0].hl.every((c) => lightMarks.includes(c))) throw new Error('匯出 PNG 時圖上的標示應是亮色的 mark');
      const last = modes[modes.length - 1];
      if (!last.ends.every((c) => P.dark.endpoint.vendor.includes(c)) || !last.hl.every((c) => darkMarks.includes(c))) throw new Error('匯出後畫面的廠商色與標示應回到暗色');
      const bg = ops.find((o) => o.op === 'rect'); if (!bg || bg.style !== P.light.canvas.surface) throw new Error('PNG 的底色應是亮色的畫布底色');
      if (T.mode !== 'dark' || modes[modes.length - 1].mode !== 'dark') throw new Error('匯出後應還原成目前的深淺並重畫');

      // 主題切換（設定「一般」的單選群組）：跟隨系統／淺色／深色。CSS 跟著 <html data-theme>（＝ theme.mode），偏好存進 store
      const root = document.documentElement; const ST = S.store.theme;
      const fire = (on) => { mq.matches = on; listeners.forEach((f) => f({ matches: on, media: mq.media })); flushRaf(); };
      App.openSettings('general');
      const items = $('#settings').testAll('.settings-radio').filter((r) => r.dataset.setting === 'theme');
      const radio = (p) => items.find((r) => r.value === p);
      // 選一個選項：和瀏覽器一樣先勾選再觸發 change
      const item = (p) => ({ click: () => { const r = radio(p); r.checked = true; r.dispatch('change'); } });
      if (items.length !== ST.VALUES.length || !ST.VALUES.every(radio)) throw new Error('設定「一般」應有每個配色偏好各一個選項');
      const group = items[0].parentNode.parentNode;
      if (!items.every((r) => r.getAttribute('type') === 'radio' && r.getAttribute('name') === items[0].getAttribute('name') && group.contains(r)) || group.tagName !== 'FIELDSET'
        || !group.firstElementChild || group.firstElementChild.tagName !== 'LEGEND' || !group.firstElementChild.textContent.includes('配色')) throw new Error('配色選項應是同一組的 radio，放在有 legend 的 fieldset 內');
      if (items.some((r) => r.parentNode.tagName !== 'LABEL' || !r.parentNode.textContent.trim())) throw new Error('每個配色選項都應有標籤文字');
      const checked = () => items.filter((r) => r.checked).map((r) => r.value).join();
      const state = () => `${checked()}／mode=${T.mode}／data-theme=${root.getAttribute('data-theme')}／store=${ST.get()}`;
      const expect = (pref, mode, why) => { if (checked() !== pref || VA.themePref() !== pref || T.mode !== mode || root.getAttribute('data-theme') !== mode || ST.get() !== pref) throw new Error(why + '：' + state()); };
      expect('system', 'dark', '系統是深色、偏好跟隨系統時');
      // 切換時不重建左側清單（沿用部分重畫）
      const pane0 = $('#pane-findings').firstChild;
      fire(false); item('dark').click();
      expect('dark', 'dark', '選了深色後應固定深色並存進 store');
      if ($('#pane-findings').firstChild !== pane0) throw new Error('切換配色時不應重建左側清單');
      fire(true); fire(false); expect('dark', 'dark', '固定深色時系統的變更不應影響');
      // 重新載入（模擬）：首次繪製前的 inline script 由 store 讀回偏好，系統是淺色也套用深色
      root.removeAttribute('data-theme'); inlineScripts.forEach((src) => vm.runInThisContext(src));
      if (root.getAttribute('data-theme') !== 'dark') throw new Error('重新載入後首次繪製前應還原成深色：' + root.getAttribute('data-theme'));
      // PNG 固定淺色；匯出時 CSS（data-theme）不跟著變，之後畫面仍是深色
      { const seen = []; const d0 = g.draw; g.draw = function () { seen.push([T.mode, root.getAttribute('data-theme')]); return d0.call(this); };
        try { VA.exportPng(); } finally { g.draw = d0; }
        if (!seen.length || seen[0][0] !== 'light' || seen.some((x) => x[1] !== 'dark')) throw new Error('固定深色時匯出 PNG 應以淺色繪製、頁面不閃：' + JSON.stringify(seen));
        expect('dark', 'dark', '匯出後應回到深色'); }
      fire(true); item('light').click();
      expect('light', 'light', '選了淺色後應固定淺色');
      fire(false); fire(true); expect('light', 'light', '固定淺色時系統改成深色不應影響');
      item('system').click(); expect('system', 'dark', '選回跟隨系統時應套用系統目前的深色');
      fire(false); expect('system', 'light', '跟隨系統時應跟著系統變成淺色');
      // 存不進 localStorage（例如被瀏覽器封鎖）：這次仍套用，並以通知說明關閉後不會保留（不靜默）
      { const set0 = localStorage.setItem; localStorage.setItem = () => { throw new Error('模擬 QuotaExceededError'); };
        try { item('dark').click(); } finally { localStorage.setItem = set0; }
        if (T.mode !== 'dark' || !text('#banner').includes('配色')) throw new Error('偏好存不進去時仍應套用並以通知說明：' + text('#banner'));
        item('system').click(); expect('system', 'light', '選回跟隨系統'); }
      // 偏好在設定之外改變（A.setThemePref）時，設定裡的勾選跟著換
      VA.setThemePref('light'); if (checked() !== 'light') throw new Error('偏好改變時設定裡的勾選應跟著換：' + checked());
      VA.setThemePref('system');
      VA.closeSettings();
    } finally {
      VA.closeSettings();
      if (VA.themePref() !== 'system') VA.setThemePref('system');
      localStorage.removeItem(S.store.theme.KEY);
      g.draw = oldDraw; App.select(null);
      if (T.mode !== 'light') { mq.matches = false; listeners.forEach((f) => f({ matches: false, media: mq.media })); }
      if (oldMM) window.matchMedia = oldMM; else delete window.matchMedia;
      flushRaf();
    }
    if (restore) await buildInput(prevInput);
  });
  await step('暗色配色：亮色中共用的值在暗色也相等、與亮色不同、速率色階反轉（越快越亮）、線寬不變', () => {
    const P = S.view.theme.palettes; const at = (o, p) => p.split('.').reduce((x, k) => x[k], o);
    // 別名：亮色以參照共用同一個值的葉節點（vlan 承載 ＝ 狀態色、重疊 ＝ 警告文字色、動作與 effect ＝ 文字色、中性框線 ＝ keyInk）
    const ALIAS = [
      ['mark.good', 'vlan.carry.c', 'vlan.inferred.c', 'vlan.oneSide.c'], ['mark.bad', 'vlan.partial.c', 'sev.error'],
      ['text.warn', 'l3.overlap.c', 'l3.badge.text', 'l3.badge.border', 'diff.effect.less-restrictive'],
      ['text.err', 'firewall.action.drop', 'firewall.action.reject', 'firewall.action.tarpit', 'diff.effect.new-exposure'],
      ['text.ok', 'firewall.action.accept', 'diff.effect.more-restrictive'], ['text.info', 'firewall.action.jump'], ['text.muted', 'firewall.action.return', 'canvas.label.textUncollected'],
      ['text.body', 'l3.subnet.text', 'canvas.label.text', 'l4.text', 'l4.badge.text'],
      ['canvas.keyInk', 'l2.port.stroke', 'l3.subnet.stroke', 'l3.route.c', 'l3.boundary.c', 'l3.possible.c', 'l4.badge.border', 'l4.diagonal.border'],
      ['mark.select', 'trend.single', 'l4.focus', 'firewall.focus.border'], ['canvas.surface'],
      ['l2.box.fill', 'l2.port.fill', 'l3.subnet.fill', 'l3.badge.bg', 'l4.badge.bg', 'canvas.uncollectedFill'],
    ];
    SCHEMES.forEach((mode) => ALIAS.forEach(([head, ...rest]) => rest.forEach((p) => {
      if (at(P[mode], p) !== at(P[mode], head)) throw new Error(`${mode}：${p} 應與 ${head} 相同（${at(P[mode], p)} ≠ ${at(P[mode], head)}）`);
    })));
    // 每組別名在暗色都有自己的值（暗色不是亮色的複本）
    ALIAS.forEach(([head]) => { if (at(P.dark, head) === at(P.light, head)) throw new Error(`暗色的 ${head} 應重新給值`); });
    // 速率色階：亮色越快越深，暗色越快越亮（相對亮度）；線寬是結構，兩組相同
    const lum = (c) => luminance(rgbOf(c)); const E = (m) => ['1g', '10g', '40g'].map((k) => lum(P[m].edge[k].c));
    const [l1, l10, l40] = E('light'); const [d1, d10, d40] = E('dark');
    if (!(l1 > l10 && l10 > l40)) throw new Error('亮色的速率色階應越快越深');
    if (!(d1 < d10 && d10 < d40)) throw new Error('暗色的速率色階應越快越亮');
    const W = S.view.theme.edge; if (!(W['1g'].w < W['10g'].w && W['10g'].w < W['40g'].w && W['40g'].w < W.lag.w)) throw new Error('線寬隨速率遞增（兩組共用）');
    // 圖形標記對暗色畫布底色 ≥ 3:1（設備類型、連線、嚴重度、標示、廠商、L4 符號）
    const d = P.dark; const s = d.canvas.surface; const low = [];
    const graphic = [...Object.entries(d.kind).map(([k, c]) => ['kind.' + k, c]), ...Object.entries(d.edge).map(([k, v]) => ['edge.' + k, v.c]),
      ...Object.entries(d.sev).map(([k, c]) => ['sev.' + k, c]), ...Object.entries(d.mark).map(([k, c]) => ['mark.' + k, c]),
      ...d.endpoint.vendor.map((c, i) => [`endpoint.vendor[${i}]`, c]), ['canvas.deviation.c', d.canvas.deviation.c], ['canvas.keyInk', d.canvas.keyInk]];
    graphic.forEach(([n, c]) => { const r = contrastOf(c, s); if (r < 3) low.push(`${n} ${c} 只有 ${r.toFixed(2)}:1`); });
    if (low.length) throw new Error('暗色的圖形標記對畫布底色不足 3:1：\n' + low.join('\n'));
  });
};
