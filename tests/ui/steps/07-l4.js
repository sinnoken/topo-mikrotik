// 畫面冒煙測試的 step：L4 可達性：zone 矩陣、明細、可達性查詢、表格與分段計算、規則詳情。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { document, S, fs, path, ROOT, step, captureDownloads, parseCsv, contrastOf, forSchemes, until, $, text, layerBtn, L4, l4Cells, l4State, cellTd, svcParts, l4SvcBtn, detailRoot, fwRoot, fwList, fwSide, fwText, fwTab, fwRows } = require('../helpers.js');

/** 矩陣畫出來的格子：來源是虛擬 zone（外部）的列不畫（評審 D2：從外部進來的看上方三段），欄保留全部的 zone */
const rowCells = (mx) => { const vz = new Set(mx.zones.filter((z) => z.virtual).map((z) => z.id)); return mx.cells.filter((c) => !vz.has(c.src)); };
/**
 * 明細的逐跳路徑：每條路徑的標頭有「路由 ✓／✕／? → 防火牆 ✓／✕／?／—」（paths[].route／filter），符號不只靠顏色；
 * 路由沒到時防火牆寫「—」
 */
function checkLayers(r) {
  const V = S.view;
  const ps = $('#l4-drill').querySelector('.l4-l3').testAll('.l4-path');
  if (ps.length !== r.paths.length) throw new Error(`逐跳路徑的數目應與 paths 相同（${ps.length}／${r.paths.length}）`);
  ps.forEach((el, n) => {
    const p = r.paths[n]; const ly = el.querySelector('.l4-layers');
    if (!ly || ly.dataset.route !== p.route.status || ly.dataset.filter !== p.filter.status) throw new Error(`路徑 ${n + 1} 應標出路由 ${p.route.status} → 防火牆 ${p.filter.status}`);
    const t = ly.textContent;
    if (!/路由 [✓✕?]/.test(t) || !/防火牆 [✓✕?—]/.test(t) || t.indexOf('路由') > t.indexOf('防火牆')) throw new Error('路徑的分層結果應寫「路由 ✓ → 防火牆 ✓」：' + t);
    if ((p.filter.status === 'n/a') !== t.includes('防火牆 —')) throw new Error('路由沒到時防火牆寫「—」：' + t);
    if (!V.ROUTE_STATUS[p.route.status] || !(ly.getAttribute('title') || '').includes(V.ROUTE_STATUS[p.route.status])) throw new Error('分層結果的 title 應寫出路由結果的中文：' + p.route.status);
  });
}

/** V.l4 的對外成員與函式的參數個數（拆成 l4.js／l4-exposure.js／l4-matrix.js／l4-trace.js 之前的清單；改成員時同步改這裡） */
const L4_MEMBERS = { show: 2, MATRIX_MAX: null, zoneOpts: 1, state: 0, openCell: 3, openGroup: 3, runReach: 6, rerunWithVrf: 2, openExposure: 3,
  deniedParts: 1, deniedSentence: 3, exposureRun: 1, exposure: 0, timings: 1, runs: 1 };
const L4_FILES = ['l4.js', 'l4-exposure.js', 'l4-matrix.js', 'l4-trace.js'];

module.exports = async () => {
  await step('L4 拆檔：V.l4 的對外成員與參數個數不變、內部命名空間 V.l4._ 不列舉；四個檔依序載入，每個名稱只定義在一個檔，跨檔引用的 V.l4._ 成員都有定義', async () => {
    const V = S.view; const I = V.l4._;
    const keys = Object.keys(V.l4);
    if (keys.join() !== Object.keys(L4_MEMBERS).join()) throw new Error('V.l4 的成員應與拆檔前相同：' + keys.join());
    Object.entries(L4_MEMBERS).forEach(([k, n]) => {
      if (n === null) { if (typeof V.l4[k] === 'function') throw new Error(`V.l4.${k} 不是函式`); return; }
      if (typeof V.l4[k] !== 'function' || V.l4[k].length !== n) throw new Error(`V.l4.${k} 應是 ${n} 個參數的函式`);
    });
    if (!I || typeof I !== 'object') throw new Error('應有內部命名空間 V.l4._');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const at = L4_FILES.map((f) => html.indexOf(`<script src="src/view/panels/${f}"></script>`));
    if (at.some((x) => x < 0) || at.some((x, n) => n && x < at[n - 1])) throw new Error('index.html 應依序載入 ' + L4_FILES.join('、'));
    const IMPORTS = new Set(['V', 'h', '$', 'I']);
    const where = new Map();
    L4_FILES.forEach((f) => {
      const src = fs.readFileSync(path.join(ROOT, 'src/view/panels', f), 'utf8');
      // IIFE 第一層（兩格縮排）的宣告：function、const、let（同一行可有多個）
      src.split('\n').filter((l) => /^ {2}\S/.test(l)).forEach((l) => {
        for (const m of l.matchAll(/(?:^ {2}|;\s*)(?:function|const|let)\s+([\w$]+)/g)) {
          if (IMPORTS.has(m[1])) continue;
          if (where.has(m[1])) throw new Error(`${m[1]} 同時定義在 ${where.get(m[1])} 與 ${f}`);
          where.set(m[1], f);
        }
      });
      // 從 V.l4._ 解構的名稱與 I.xxx 的引用都要有定義（拼錯或忘了加進命名空間時，執行到才會丟錯）
      const used = new Set();
      for (const m of src.matchAll(/const \{([^}]+)\} = I;/g)) m[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((k) => used.add(k));
      for (const m of src.matchAll(/\bI\.([\w$]+)/g)) used.add(m[1]);
      used.forEach((k) => { if (I[k] === undefined) throw new Error(`${f} 用到的 V.l4._.${k} 沒有定義`); });
    });
    if (where.size < 100) throw new Error('應掃到四個檔的宣告：' + where.size);
  });

  // ------------------------------------------------------------ M2：L4 可達性（zone 矩陣、下鑽、可達性查詢）
  await step('L4 zone 矩陣：每一格有狀態的符號與文字（不只靠顏色）、empty 和 unknown 分開、標出結果不一與 zone 內；圖例、提示、zone 的來源與推論、判斷的前提', async () => {
    const Q = App.Q; const V = S.view; const G = V.theme.l4.status;
    App.select(null); layerBtn('l4').click();
    if (App.layer !== 'l4' || L4().classList.contains('hidden')) throw new Error('點 L4 應顯示 zone 矩陣');
    await App.l4Job;
    // 內部互通（zone 矩陣）在有 WAN 時預設收合，收合時不計算矩陣（App.l4Job 只等暴露清單）；以下的步驟是使用者展開它之後的操作
    { const fold = $('#l4-matrix-fold');
      if (Q.exposure().status === 'ok') {
        if (fold.open || fold.getAttribute('open') != null) throw new Error('有 WAN 時內部互通應預設收合');
        if (l4State().computing || V.l4.timings(Q).has('') || l4Cells().length) throw new Error('內部互通收合時不應計算 zone 矩陣');
      }
      fold.setAttribute('open', ''); fold.open = true; fold.dispatch('toggle');
      if (!V.l4.timings(Q).has('') && !l4State().computing) throw new Error('展開內部互通時應開始計算 zone 矩陣');
      if (!V.l4.timings(Q).has('') && !text('#l4-status').includes('計算 zone 矩陣中')) throw new Error('計算中應顯示進度');
      await App.l4MatrixJob; }
    const mx = Q.zoneMatrix(); const tds = l4Cells();
    if (!mx.zones.length) throw new Error('應有 zone');
    if (mx.zones.length <= V.l4.MATRIX_MAX && tds.length !== rowCells(mx).length) throw new Error(`每一格都應畫出（${tds.length}／${rowCells(mx).length}）`);
    // D2：外部（Internet）不當來源列（WAN（介面清單）列保留），欄保留外部與網路設備（管理）；說明指向上方三段
    const vz = mx.zones.filter((z) => z.virtual).map((z) => z.id);
    if (tds.some((t) => vz.includes(t.dataset.src))) throw new Error('矩陣不應有外部（虛擬 zone）的來源列');
    if (!process.env.SMOKE_INPUT && (!tds.some((t) => t.dataset.src === 'list:WAN') || !tds.some((t) => t.dataset.dst === 'external') || !tds.some((t) => t.dataset.dst === 'self'))) throw new Error('WAN（介面清單）列、外部與網路設備（管理）欄應保留');
    if (!text('#l4-matrix-fold').includes('從外部進來的看上方三段')) throw new Error('內部互通的說明應指向上方三段');
    if (L4().querySelector('.l4-grid').getAttribute('role') !== 'grid' || !tds.every((t) => t.getAttribute('role') === 'gridcell')) throw new Error('矩陣是 grid，格子是 gridcell');
    rowCells(mx).forEach((c) => {
      const td = cellTd(c.src, c.dst); const where = `${c.src} → ${c.dst}`;
      if (!td || td.dataset.status !== c.status) throw new Error('格子的狀態應與 Q.zoneMatrix 相同：' + where);
      if (!td.textContent.includes(G[c.status].glyph) || !td.textContent.includes(V.L4_STATUS[c.status])) throw new Error('格子應有狀態的符號與文字：' + where);
      // 格子很窄：結果不一是短標「≠」（完整說法在 title 與格子的 aria-label，UX6 M5）
      const het = td.testAll('.l4-het')[0];
      if (c.heterogeneous !== !!(het && het.textContent === '≠' && /結果不一/.test(het.getAttribute('title') || '') && /結果不一/.test(td.getAttribute('aria-label') || ''))) throw new Error('成員結果不一致的格子應標出「結果不一」：' + where);
      if (c.diagonal !== td.classList.contains('diag')) throw new Error('zone 內（對角線）應另外標示：' + where);
      // 評審 M5：格子不寫「允許／總數」的次數（只在提示與 aria-label）
      if (/\d\/\d/.test(td.textContent)) throw new Error('格子不應寫次數：' + td.textContent);
      const label = td.getAttribute('aria-label');
      if (!label.includes(V.L4_STATUS[c.status]) || (c.counts.total && !label.includes(`共 ${V.num(c.counts.total)} 組`))) throw new Error('格子的 aria-label 應讀出狀態與筆數：' + where);
    });
    if (G.empty.glyph === G.unknown.glyph || V.L4_STATUS.empty === V.L4_STATUS.unknown || G.empty.bg === G.unknown.bg || !G.empty.hatch) throw new Error('empty 與 unknown 的符號、文字與底色都應不同（empty 另有斜線底紋）');
    const statuses = new Set(mx.cells.map((c) => c.status));
    if (!process.env.SMOKE_INPUT) {
      const c = mx.cells.find((x) => x.src === 'list:WAN' && x.dst === 'vlan:20');
      if (!c || c.status !== 'partial' || !c.heterogeneous) throw new Error('範例資料的 WAN → VLAN 20 應是部分（partial）且異質');
      const td = cellTd(c.src, c.dst);
      if (!td.textContent.includes('部分') || !td.testAll('.l4-het').some((b) => /結果不一/.test(b.getAttribute('title') || ''))) throw new Error('WAN → VLAN 20 的格子應顯示「部分」與「結果不一」');
      if (!statuses.has('unknown') || !statuses.has('empty')) throw new Error('範例資料應同時有 unknown 與 empty 的格子');
    }
    // 圖例：五種狀態、異質、zone 內
    const lg = $('#l4-legend');
    Object.keys(V.L4_STATUS).forEach((k) => { const it = lg.testAll('.l4-legend-item').find((x) => x.dataset.status === k); if (!it || !it.textContent.includes(G[k].glyph) || !it.textContent.includes(V.L4_STATUS[k])) throw new Error('圖例缺少狀態：' + k); });
    if (!lg.textContent.includes('結果不一') || !lg.textContent.includes('zone 內')) throw new Error('圖例應說明結果不一與 zone 內');
    // 提示：筆數與代表規則
    const wr = rowCells(mx).find((c) => c.rule && c.counts.total);
    if (wr) {
      const td = cellTd(wr.src, wr.dst); td.dispatch('mouseenter', { clientX: 10, clientY: 10 });
      const tip = $('#l4-tip');
      if (tip.classList.contains('hidden') || !tip.textContent.includes(`允許 ${V.num(wr.counts.allow)}`) || !tip.textContent.includes(`共 ${V.num(wr.counts.total)} 組`) || !tip.textContent.includes('代表規則')) throw new Error('提示應顯示筆數與代表規則：' + tip.textContent);
      td.dispatch('mouseleave'); if (!tip.classList.contains('hidden')) throw new Error('移開後提示應收起');
      td.dispatch('focus'); if (tip.classList.contains('hidden')) throw new Error('鍵盤移到格子時也應顯示提示'); td.dispatch('blur');
    }
    // 提示與 aria-label：拒絕依 deniedBy 拆成「沒有路由 a、防火牆拒絕 b」（只寫非 0 的）
    { const dc = rowCells(mx).filter((c) => c.counts.deny);
      if (!process.env.SMOKE_INPUT && !dc.length) throw new Error('範例資料應有拒絕的格子');
      dc.slice(0, 5).forEach((c) => {
        const by = c.deniedBy;
        if (!by || by.noRoute + by.filter !== c.counts.deny) throw new Error('前提：deniedBy 的合計等於 counts.deny：' + c.src + ' → ' + c.dst);
        const want = V.l4.deniedParts(by);
        if (!want || (by.noRoute && !want.includes(`沒有路由 ${V.num(by.noRoute)}`)) || (by.filter && !want.includes(`防火牆拒絕 ${V.num(by.filter)}`)) || (!by.noRoute && want.includes('沒有路由'))) throw new Error('V.l4.deniedParts 應只寫非 0 的拒絕原因：' + want);
        const td = cellTd(c.src, c.dst); td.dispatch('mouseenter', { clientX: 10, clientY: 10 });
        const tip = $('#l4-tip').textContent; td.dispatch('mouseleave');
        if (!tip.includes(want)) throw new Error('提示應依 deniedBy 拆開拒絕：' + tip);
        if (!(td.getAttribute('aria-label') || '').includes(want)) throw new Error('格子的 aria-label 應依 deniedBy 拆開拒絕');
      }); }
    // zone 的來源與推論：表頭與「zone 的依據」
    const heads = L4().testAll('th').map((x) => x.textContent);
    mx.zones.forEach((z) => {
      if (mx.zones.length <= V.l4.MATRIX_MAX && !heads.some((t) => t.includes(z.name) && t.includes(V.ZONE_SOURCE[z.source]) && (!z.inferred || t.includes('推論')))) throw new Error('zone 名稱旁應有來源與推論標示：' + z.name);
    });
    const zt = text('#l4-zones');
    Q.zones().zones.forEach((z) => { if (!zt.includes(z.name) || (z.basis && !zt.includes(z.basis))) throw new Error('zone 的依據應列出：' + z.name); });
    // 判斷的前提
    // 判斷的前提：每條寫短句，完整說明只在收合的「詳細」裡（不再整段列出全文）
    S.query.reachAssumptions().forEach((a) => {
      const li = $('#l4-assume-' + a.code);
      if (!li || li.querySelector('.assume-short').textContent !== a.short) throw new Error('畫面應寫出判斷的前提的短句：' + a.code);
      const det = li.querySelector('.assume-detail');
      if (!det || !det.textContent.includes(a.detail) || det.getAttribute('open') != null) throw new Error('前提的完整說明應收在「詳細」：' + a.code);
    });
    // 前提預設收合（摘要一句），矩陣放在查詢之前，首屏先看到矩陣（UX #6）
    const fold = L4().querySelector('.l4-assume details');
    if (!fold || fold.open || !fold.querySelector('.l4-assume-list') || !fold.querySelector('summary')) throw new Error('判斷的前提應預設收合在 <details> 裡');
    const cards = L4().testAll('.l4-card'); const at = (sel) => cards.findIndex((c) => c.querySelector(sel));
    if (!(at('#l4-matrix') >= 0 && at('#l4-matrix') < at('#l4-run'))) throw new Error('zone 矩陣應在可達性查詢之前');
    if (/\bms\b|快取/.test(text('#l4-status')) || !text('#l4-status').includes('個 zone')) throw new Error('L4 的狀態列出 zone 等數字，不寫計算耗時與快取：' + text('#l4-status'));
    // 配色（亮、暗兩組）：文字對格子底色 ≥ 4.5:1，符號對格子底色與畫布底色 ≥ 3:1
    forSchemes((mode) => {
      Object.entries(G).forEach(([k, s]) => {
        if (contrastOf(V.theme.l4.text, s.bg) < 4.5) throw new Error(`${mode}：L4 ${k} 的文字對底色不足 4.5:1`);
        if (contrastOf(s.mark, s.bg) < 3 || contrastOf(s.mark, V.theme.canvas.surface) < 3) throw new Error(`${mode}：L4 ${k} 的符號對底色不足 3:1`);
      });
      if (contrastOf(V.theme.l4.badge.text, V.theme.l4.badge.bg) < 4.5) throw new Error(`${mode}：異質徽章的文字對底色不足 4.5:1`);
      // 部分允許是琥珀色系（色相 25–50°、彩度高），和拒絕（紅）、無法判斷（中性灰）分開；符號與文字標籤仍是主要的區分
      const hueSat = (c) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn;
        const l = (mx + mn) / 2; const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
        const hh = !d ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [(hh * 60 + 360) % 360, s]; };
      [G.partial.mark, G.partial.bg].forEach((c) => { const [hu, sa] = hueSat(c); if (hu < 25 || hu > 50 || sa < 0.5) throw new Error(`${mode}：部分允許應是琥珀色系：${c}（色相 ${hu.toFixed(0)}°、彩度 ${sa.toFixed(2)}）`); });
      if (G.partial.mark === G.deny.mark || G.partial.mark === G.unknown.mark || G.partial.bg === G.deny.bg || G.partial.bg === G.unknown.bg) throw new Error(`${mode}：部分允許不可和拒絕、無法判斷同色`);
    });
    // 「＋?」（部分無法判斷）、IPv6 提示、連線追蹤的說明有各自的樣式
    { const css4 = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
      // 評審 L2：窄螢幕時格子的提示不疊在格子上，改到矩陣框下方（position: static）
      if (!/@media \(max-width: \d+px\) \{[^@]*\.l4-matrix-box \.l4-tip \{[^}]*position: static/.test(css4)) throw new Error('窄螢幕時 L4 的提示應在矩陣框下方（position: static）');
      ['.l4-inc', '.l4-ipv6-note', '.l4-ct'].forEach((c) => { if (!new RegExp('(^|[\\s,}])' + c.replace('.', '\\.') + '[\\s,{]').test(css4)) throw new Error('app.css 應有 ' + c + ' 的樣式'); }); }
    // 強制色彩：格子有系統色外框，焦點用 Highlight
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8'); const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    if (!/\.l4-cell:focus[^{]*\{[^}]*Highlight/.test(forced) || !/\.l4-cell,[^{]*\{[^}]*CanvasText/.test(forced)) throw new Error('強制色彩模式下 L4 的格子要有系統色外框與焦點');
    if (process.env.SMOKE_INPUT) {
      const run = S.view.l4.runs(Q).get('') || {};
      console.log(`      L4 矩陣第一次計算：${S.view.l4.timings(Q).get('')} ms（${mx.zones.length} 個 zone、${mx.stats.evaluations} 次判斷）；分 ${run.steps} 段，一段最久 ${run.maxStepMs} ms，兩段之間最長 ${run.maxGapMs} ms，總共 ${run.wallMs} ms`);
    }
  });
  await step('L4 明細：方向鍵在格子間移動（roving tabindex），Enter 開位址組與牽涉的規則，點一組的服務開逐跳路徑；焦點移到明細的標題，規則可點開詳情', async () => {
    const Q = App.Q; const V = S.view; const mx = Q.zoneMatrix(); const n = mx.zones.length;
    const tds = l4Cells(); const roving = tds.filter((t) => t.getAttribute('tabindex') === '0');
    if (roving.length !== 1) throw new Error('矩陣只應有一個格子在 Tab 順序裡');
    const at = () => [+document.activeElement.dataset.r, +document.activeElement.dataset.c];
    roving[0].focus(); const [r0, c0] = at();
    if (n > 1) {
      document.activeElement.dispatch('keydown', { key: c0 < n - 1 ? 'ArrowRight' : 'ArrowLeft' });
      if (at()[1] === c0 || document.activeElement.getAttribute('tabindex') !== '0' || roving[0].getAttribute('tabindex') !== '-1') throw new Error('←／→ 應移到同一列的另一格，roving tabindex 跟著改');
      document.activeElement.dispatch('keydown', { key: r0 < n - 1 ? 'ArrowDown' : 'ArrowUp' });
      if (at()[0] === r0) throw new Error('↑／↓ 應移到另一列');
      document.activeElement.dispatch('keydown', { key: 'Home' }); if (at()[1] !== 0) throw new Error('Home 應移到這一列的第一格');
      document.activeElement.dispatch('keydown', { key: 'End' }); if (at()[1] !== n - 1) throw new Error('End 應移到這一列的最後一格');
    }
    const target = (!process.env.SMOKE_INPUT && mx.cells.find((x) => x.src === 'list:WAN' && x.dst === 'vlan:20')) || rowCells(mx).find((c) => c.counts.total);
    if (!target) throw new Error('應有可下鑽的格子');
    const td = cellTd(target.src, target.dst); td.focus(); td.dispatch('keydown', { key: 'Enter' });
    const s0 = l4State();
    if (!s0.cell || s0.cell.src !== target.src || s0.cell.dst !== target.dst) throw new Error('Enter 應開啟這一格的下鑽');
    if (document.activeElement !== $('#l4-drill-title') || !text('#l4-live').includes('明細')) throw new Error('開啟明細後焦點應移到明細的標題，並讀出開啟了哪一格');
    // 就地顯示（評審 M2）：格子的明細在矩陣的卡片裡（矩陣下面），不在頁首
    if (!L4().querySelector('.l4-matrix-card').contains($('#l4-drill'))) throw new Error('格子的明細應在矩陣下面');
    const cell = Q.zoneCell(target.src, target.dst); const d = text('#l4-drill');
    if (!d.includes('位址組') || !d.includes('牽涉的規則') || /\bL[0-3]：/.test(d)) throw new Error('明細應有「位址組」與「牽涉的規則」，標題不寫 L1／L2 編號');
    const shown = () => $('#l4-drill').testAll('.l4-group').length; const denyAll = cell.groups.filter((g) => g.status === 'deny').length;
    const divCount = cell.groups.filter((g) => g.divergent).length;
    if (cell.heterogeneous !== (divCount > 0)) throw new Error('有 divergent 的組 ⇔ 格子異質');
    // 第一句是結論：允許的服務用 IP:埠，其餘拒絕的組合數；筆數（允許 N・拒絕 N）不在畫面上，只在 title 與「這一格怎麼算的」（評審 M5）
    { const sen = ($('#l4-drill').querySelector('.l4-cell-sentence') || {}).textContent || '';
      const anyAllow = cell.groups.some((g) => g.services.some((s) => s.verdict === 'allow'));
      if (anyAllow ? !/個服務允許：\S+ [\d.]+(:\d+)?/.test(sen) : !sen.includes('沒有允許')) throw new Error('明細的第一句應是結論（允許的服務寫 IP:埠）：' + sen);
      if (cell.counts.deny && !sen.includes(`其餘 ${V.num(cell.counts.deny)} 個組合拒絕`)) throw new Error('明細的結論應寫出其餘拒絕的組合數：' + sen);
      if (cell.counts.deny && !sen.includes(V.l4.deniedParts(cell.deniedBy))) throw new Error('明細的結論應依 deniedBy 拆開拒絕（沒有路由／防火牆拒絕）：' + sen);
      if (!process.env.SMOKE_INPUT && target.src === 'list:WAN' && !sen.includes('10.1.20.11:443')) throw new Error('WAN → VLAN 20 的結論應寫出 NAT 之後的 10.1.20.11:443：' + sen);
      const how = $('#l4-drill').testAll('.l4-how')[0];
      if (!how || how.tagName !== 'DETAILS' || how.open || !how.textContent.includes('等價類')) throw new Error('等價類與「造成差異」的說明應收在「這一格怎麼算的」（預設收合，評審 M6）');
      if (cell.heterogeneous && !how.textContent.includes('造成差異是指')) throw new Error('結果不一的格子在「這一格怎麼算的」說明造成差異');
      if (/允許 [\d,]+・拒絕/.test($('#l4-drill').testAll('.row')[0].textContent)) throw new Error('明細的標頭不再寫「允許 N・拒絕 N」的次數'); }
    // 先列允許與無法判斷（評審 H5）：全部拒絕的組一律預設收起（不論是否結果不一），其他組裡拒絕的服務收成「其餘 N 個服務拒絕」
    const nonDeny = cell.groups.filter((g) => g.status !== 'deny').length;
    if (shown() !== Math.min(300, nonDeny)) throw new Error(`預設只列不是全部拒絕的組（${shown()}／${nonDeny}，全部拒絕 ${denyAll}）`);
    $('#l4-drill').testAll('.l4-group').forEach((tr) => { const bs = tr.testAll('.l4-svc'); if (bs.some((b) => /st-deny/.test(b.className))) throw new Error('預設不列拒絕的服務'); });
    { const denySvcs = cell.groups.filter((g) => g.status !== 'deny').reduce((n, g) => n + g.services.filter((s) => s.verdict === 'deny').length, 0);
      const said = $('#l4-drill').testAll('.l4-svc-denied').reduce((n, x) => n + Number((x.textContent.match(/其餘 ([\d,]+) 個服務拒絕/) || [0, '0'])[1].replace(/,/g, '')), 0);
      if (said !== denySvcs && cell.groups.length <= 300) throw new Error(`拒絕的服務應收成「其餘 N 個服務拒絕」（${said}／${denySvcs}）`);
      const hb = () => $('#l4-drill').querySelector('.l4-hide-deny');
      if ((denyAll || denySvcs) && (!hb() || hb().getAttribute('aria-pressed') !== 'true')) throw new Error('有拒絕的組合時應有「顯示拒絕的組合」');
      if (hb()) {
        hb().click();
        if (shown() !== Math.min(300, cell.groups.length) || document.activeElement !== hb() || hb().getAttribute('aria-pressed') !== 'false' || $('#l4-drill').testAll('.l4-svc-denied').length) throw new Error('「顯示拒絕的組合」後應列出全部的組與服務，焦點留在按鈕');
        // 允許的組排在前面
        const st0 = $('#l4-drill').testAll('.l4-group').map((tr) => (tr.className.match(/st-(\w+)/) || [])[1]);
        if (st0.indexOf('deny') >= 0 && st0.slice(st0.indexOf('deny')).some((s) => s !== 'deny')) throw new Error('全部拒絕的組排在最後：' + st0.join());
        hb().click();
      } }
    if (cell.heterogeneous) {
      if (!text('#l4-drill').includes('結果不一')) throw new Error('結果不一的明細應標出結果不一');
      // 造成差異的服務：按鈕上有「差異」文字（不只靠顏色），其他服務沒有
      const btns = $('#l4-drill').testAll('.l4-svc');
      cell.groups.forEach((g, i) => { if (!g.divergent) return; g.services.forEach((s) => {
        const b = btns.find((x) => x.dataset.group === String(i) && x.dataset.service === s.service);
        if (b && g.divergentServices.includes(s.service) !== b.textContent.includes('差異')) throw new Error(`造成差異的服務才標「差異」：第 ${i + 1} 組 ${s.service}`);
      }); });
      if (!cell.groups.some((g) => g.divergentServices.length)) throw new Error('divergent 的組應列出造成差異的服務');
      if (!process.env.SMOKE_INPUT && !cell.groups.some((g) => g.divergentServices.includes('tcp/8443'))) throw new Error('範例資料的 WAN → VLAN 20 應是 tcp/8443 造成差異');
    }
    if ($('#l4-drill').testAll('.l4-ruledetail').length !== Math.min(300, cell.ruleDetails.length)) throw new Error('L2 應列出 Q.zoneCell 的每一條牽涉的規則');
    // 牽涉的規則：允許的規則在前
    { const al = cell.ruleDetails.filter((x) => x.verdicts.allow).length; const rr = $('#l4-drill').testAll('.l4-ruledetail').slice(0, al);
      if (al && cell.ruleDetails.length <= 300 && rr.some((tr) => tr.childNodes[1].textContent === '0')) throw new Error('牽涉的規則應先列允許的規則'); }
    // L1 → L3：點一組的某個服務
    const gi = cell.groups.findIndex((g) => !process.env.SMOKE_INPUT ? g.services.some((s) => s.service === 'tcp/8443' && s.verdict === 'allow') : g.status !== 'deny');
    if (gi < 0) throw new Error('應有可以看 L3 的組');
    const g = cell.groups[gi]; const svc = (g.services.find((s) => s.service === 'tcp/8443' && s.verdict === 'allow') || g.services[0]).service;
    const btn = l4SvcBtn(gi, svc);
    btn.click();
    const s1 = l4State(); const p = svcParts(svc);
    if (!s1.reach || s1.reach !== Q.reach(g.srcs[0].ip, g.dst.ip, Object.assign({ proto: p.proto, port: p.port }, g.srcs[0].entry ? { entry: g.srcs[0].entry } : g.srcs[0].vrf ? { vrf: g.srcs[0].vrf } : {}))) throw new Error('L3 應是這一組代表位址的 Q.reach');
    if (document.activeElement !== $('#l4-l3-title')) throw new Error('開 L3 後焦點應移到 L3 的標題');
    const l3 = text('#l4-drill');
    s1.reach.paths.forEach((pa) => pa.hops.forEach((hp) => { if (!l3.includes(Q.devName(hp.dev))) throw new Error('L3 應列出每一跳的設備：' + hp.dev); hp.stages.forEach((sg) => { if (!l3.includes(`${sg.table} ${sg.chain}`)) throw new Error('L3 應列出每一跳的 stage'); }); }));
    if (!process.env.SMOKE_INPUT && !l3.includes('10.1.20.11:443')) throw new Error('WAN → VLAN 20 的 tcp/8443 應顯示 NAT 之後的 10.1.20.11:443');
    // 規則可以點：開啟防火牆視窗、右欄是那條規則的詳情；關閉後焦點回到那個連結
    const rl = $('#l4-drill').testAll('.l4-rule')[0];
    if (rl) {
      rl.focus(); rl.click();
      if (!App.sel || App.sel.type !== 'rule' || App.sel.key !== rl.dataset.rule || !fwSide().textContent.includes('命中次數')) throw new Error('點規則應在防火牆視窗開啟規則詳情（含命中次數）');
      $('#tdlg-close').click();
      if ($('#dlg-table').open || document.activeElement !== rl) throw new Error('關閉防火牆視窗後焦點應回到 L4 的規則連結');
    }
    if (App.layer !== 'l4') throw new Error('開規則詳情時仍停在 L4');
    // 關閉下鑽：焦點回到格子
    $('#l4-drill').querySelector('.l4-close').click();
    if (!$('#l4-drill').classList.contains('hidden') || document.activeElement !== td) throw new Error('關閉下鑽後應收起並回到格子');
    App.select(null);
  });
  await step('L4 位址組 → 逐跳路徑：與矩陣用同一個入口（外部來源的 entry），位址組的結果與逐跳路徑的結論一致', async () => {
    const Q = App.Q;
    // 外部來源的代表位址不在任何網段，矩陣以 WAN 介面當入口（srcs[].entry）；逐跳路徑沒帶入口時會變成「找不到包含來源的網段」
    const mx = Q.zoneMatrix();
    const ext = mx.cells.filter((c) => c.src === 'external' && c.counts.total && c.counts.allow);
    if (!process.env.SMOKE_INPUT && !ext.length) throw new Error('範例資料應有外部來源允許的格子');
    let checked = 0;
    for (const c of ext.slice(0, 2)) {
      // D2：外部不再是矩陣的來源列（從外部進來的看上方三段）；V.l4.openCell 與 Q.zoneCell 仍接受 external
      if (cellTd(c.src, c.dst)) throw new Error('矩陣不應畫外部來源的格子：' + c.dst);
      S.view.l4.openCell(App, c.src, c.dst);
      const cell = Q.zoneCell(c.src, c.dst);
      cell.groups.forEach((g, gi) => g.services.forEach((s) => {
        if (s.verdict !== 'allow' || checked >= 6) return;
        if (!g.srcs[0].entry) throw new Error('外部來源的代表位址應有入口介面（entry）');
        l4SvcBtn(gi, s.service).click();
        const r = l4State().reach;
        if (!r) throw new Error(`第 ${gi + 1} 組 ${s.service} 應能查詢逐跳路徑：${l4State().reachErr}`);
        if (r.entry !== g.srcs[0].entry) throw new Error(`逐跳路徑應用矩陣同一個入口 ${g.srcs[0].entry}，實際 ${r.entry}`);
        if (r.verdict !== s.verdict) throw new Error(`位址組寫 ${s.service} ${s.verdict}，逐跳路徑卻是 ${r.verdict}（${r.reasons.map((x) => x.code).join('、')}）`);
        checked++;
      }));
      $('#l4-drill').querySelector('.l4-close').click();
    }
    if (!process.env.SMOKE_INPUT && !checked) throw new Error('應至少比對一組外部來源允許的服務');
    App.select(null);
  });
  await step('L4 可達性查詢：輸入來源、目的、協定與埠，結果用同一個逐跳路徑；NAT 改寫、拒絕、參數錯誤與無法判斷的原因（中文說明）', async () => {
    const Q = App.Q; const V = S.view;
    const run = (src, dst, proto, port) => { $('#l4-src').value = src; $('#l4-dst').value = dst; $('#l4-proto').value = proto; $('#l4-proto').dispatch('change'); $('#l4-port').value = port; $('#l4-run').click(); };
    if (!process.env.SMOKE_INPUT) {
      run('203.0.113.1', '203.0.113.2', 'tcp', '8443');
      const r = l4State().reach;
      if (!r || r !== Q.reach('203.0.113.1', '203.0.113.2', { proto: 'tcp', port: 8443 }) || r.verdict !== 'allow' || r.final.dst !== '10.1.20.11' || r.final.port !== 443) throw new Error('203.0.113.1 → 203.0.113.2 tcp 8443 應允許，NAT 之後是 10.1.20.11:443');
      const d = text('#l4-drill');
      if (!d.includes(V.L4_STATUS.allow) || !d.includes('NAT 之後 10.1.20.11:443') || !d.includes('dst-nat') || !d.includes('203.0.113.2:8443 → 10.1.20.11:443')) throw new Error('L3 應寫出允許與 NAT 改寫前後：' + d.slice(0, 300));
      if (document.activeElement !== $('#l4-drill-title')) throw new Error('查詢後焦點應移到結果的標題');      run('10.1.30.11', '10.1.10.2', 'tcp', '22');
      const r2 = l4State().reach;
      if (!r2 || r2.verdict !== 'deny' || !text('#l4-drill').includes(V.L4_STATUS.deny)) throw new Error('10.1.30.11 → 10.1.10.2 tcp 22 應拒絕');
      if (!r2.decisive.some((x) => x.key) || !$('#l4-drill').testAll('.l4-rule').some((a) => r2.decisive.some((x) => x.key === a.dataset.rule))) throw new Error('拒絕時應列出決定的規則，可以點');
      checkLayers(r2);
      // 路由沒到（沒有路由）：防火牆寫「—」
      run('10.1.30.11', '10.94.1.1', 'tcp', '22');
      const r3 = l4State().reach;
      if (r3 && r3.paths.some((p) => p.filter.status === 'n/a')) checkLayers(r3);
    }
    // 參數錯誤：核心的錯誤原文顯示，不靜默
    run('10.1.30.11', '10.1.10.2', 'tcp', '');
    if (!l4State().reachErr || !text('#l4-drill').includes('無法查詢')) throw new Error('tcp 沒有埠時應顯示錯誤');
    // 就地顯示：查詢的結果在可達性查詢的卡片裡（表單下面），關閉後焦點回到「查詢」
    if (!L4().querySelector('.l4-reach-card').contains($('#l4-drill'))) throw new Error('可達性查詢的結果應在查詢表單下面');
    $('#l4-drill').querySelector('.l4-close').click();
    if (document.activeElement !== $('#l4-run')) throw new Error('關閉查詢結果後焦點應回到「查詢」');
    run('x', 'y', 'tcp', '22');
    if (!text('#l4-drill').includes('IPv4')) throw new Error('位址無效時應顯示原因');
    $('#l4-proto').value = 'icmp'; $('#l4-proto').dispatch('change');
    if (!$('#l4-port').disabled) throw new Error('icmp 沒有埠，埠欄應停用');
    // 無法判斷：每個原因代碼都有中文說明
    const mx = Q.zoneMatrix();
    mx.cells.forEach((c) => c.reasons.forEach((x) => { if (!V.REACH_REASON[x.code]) throw new Error('原因代碼沒有中文說明：' + x.code); }));
    // 查詢層的原因與結束代碼清單：每一個都有中文對照（不只範例資料出現的）
    const codes = S.query.reachReasonCodes();
    if (!codes.length || !Object.isFrozen(codes)) throw new Error('S.query.reachReasonCodes() 應是凍結的非空陣列');
    const missing = codes.filter((x) => !V.REACH_REASON[x.code]).map((x) => x.code);
    if (!codes.every((x) => V.REACH_REASON[x.code])) throw new Error('原因代碼沒有中文說明：' + missing.join('、'));
    // 閘道推定的依據（Q.reach 的 start.basis、S.trace 的 startBasis）：查詢層匯出的清單 S.query.reachStartBases()，每一個都要有中文名稱；
    // S.trace 另有 device（來源是設備自己的位址），畫面另寫「來源設備」
    { const bases = S.query.reachStartBases();
      if (!bases.length || !Object.isFrozen(bases)) throw new Error('S.query.reachStartBases() 應是凍結的非空陣列');
      const noName = bases.filter((b) => !V.REACH_START_BASIS[b]);
      if (noName.length) throw new Error('閘道推定的依據沒有中文名稱（V.REACH_START_BASIS）：' + noName.join('、'));
      const extra = Object.keys(V.REACH_START_BASIS).filter((b) => !bases.includes(b));
      if (extra.length) throw new Error('V.REACH_START_BASIS 有查詢層不會產生的依據：' + extra.join('、')); }
    const u = mx.cells.find((c) => c.status === 'unknown');
    if (!u && !process.env.SMOKE_INPUT) throw new Error('範例資料應有無法判斷的格子');
    if (u) {
      V.l4.openCell(App, u.src, u.dst);
      if (!text('#l4-drill').includes(V.reachReason(u.reasons[0].code))) throw new Error('unknown 的格子應以中文列出原因');
      const cd = Q.zoneCell(u.src, u.dst); const gi = cd.groups.findIndex((g) => g.services.some((s) => s.verdict === 'unknown'));
      const svc = cd.groups[gi].services.find((s) => s.verdict === 'unknown').service;
      l4SvcBtn(gi, svc).click();
      const r = l4State().reach;
      if (!r || r.verdict !== 'unknown' || !r.reasons.length) throw new Error('L3 應是無法判斷並附原因');
      const t = text('#l4-drill');
      r.reasons.forEach((x) => { if (!t.includes(V.reachReason(x.code))) throw new Error('L3 應以中文說明原因：' + x.code); });
      if (t.includes('沒有說明的原因代碼')) throw new Error('原因代碼都應有中文說明');
      checkLayers(r);
      // 原因依 layer 分組（路由／防火牆／NAT／前提），每組前面寫「路由：」等；每個原因在它的 layer 那一組
      const LAY = new Map(S.query.reachReasonCodes().map((x) => [x.code, x.layer]));
      const box = $('#l4-drill').querySelector('.l4-l3').querySelector('.l4-reasons');
      const groups = box ? box.testAll('.l4-reason-layer') : [];
      if (!groups.length) throw new Error('無法判斷的原因應依 layer 分組');
      groups.forEach((g) => {
        if (!V.REACH_LAYER[g.dataset.layer] || !g.textContent.startsWith(V.REACH_LAYER[g.dataset.layer] + '：')) throw new Error('原因的分組應以「路由：」等開頭：' + g.textContent.slice(0, 40));
        g.testAll('.l4-reason').forEach((li) => { if ((LAY.get(li.dataset.code) || 'filter') !== g.dataset.layer) throw new Error(`原因 ${li.dataset.code} 應在 ${LAY.get(li.dataset.code)} 那一組，不在 ${g.dataset.layer}`); });
      });
      const order = Object.keys(V.REACH_LAYER); const seq = groups.map((g) => order.indexOf(g.dataset.layer));
      if (seq.some((n, k) => k && n <= seq[k - 1])) throw new Error('原因的分組依 路由 → 防火牆 → NAT → 前提 排列，每層一組');
      if (box.testAll('.l4-reason').length !== r.reasons.length) throw new Error('分組後每個原因仍各列一次');
    }
    // 「在圖上定位」（搜尋、路由追蹤）從 L4 回到設備圖
    App.showView('graph');
    if (App.layer !== 'device' || !L4().classList.contains('hidden')) throw new Error('在圖上定位時應從 L4 回到設備圖');
  });
  await step('L4：系統切換深淺時矩陣格子換成新配色（不重算）', async () => {
    const VA = S.view.app; const T = S.view.theme; const prev = T.mode;
    App.showLayer('l4'); await App.l4Job; await App.l4MatrixJob;
    const before = l4Cells()[0]; if (!before) throw new Error('測試前提：L4 應有矩陣格子');
    const other = prev === 'dark' ? 'light' : 'dark';
    try {
      VA.applyColorScheme(other); await App.l4Job; await App.l4MatrixJob;
      const after = l4Cells()[0];
      if (!after || after.style.color !== T.l4.text || after.style.color === before.style.color) throw new Error(`切換深淺後 L4 格子的文字色應是新配色的 theme.l4.text：${before.style.color} → ${after && after.style.color}（應為 ${T.l4.text}）`);
    } finally { VA.applyColorScheme(prev); await App.l4Job; await App.l4MatrixJob; }
    App.showLayer('device');
  });
  await step('L4 表格檢視與矩陣內容一致；可選單一服務（第一次計算先顯示忙碌提示，算過的直接用快取）；下載 CSV', async () => {
    const Q = App.Q; const V = S.view; const mx = Q.zoneMatrix();
    // 矩陣的 zone 含虛擬 zone（外部、網路設備（管理）），只在 Q.zoneMatrix 的 zones
    const zn = new Map(mx.zones.map((z) => [z.id, z.name]));
    App.showLayer('l4'); await App.l4Job; await App.l4MatrixJob;
    if (text('#l4-status').includes('計算 zone 矩陣中') || $('#l4-matrix').getAttribute('aria-busy') === 'true') throw new Error('同一份基準再開矩陣時應直接使用快取（不顯示忙碌提示）');
    const modeBtn = (m) => L4().testAll('.l4-modes button').find((b) => b.dataset.mode === m);
    modeBtn('table').click(); await App.l4MatrixJob;
    if (modeBtn('table').getAttribute('aria-pressed') !== 'true' || modeBtn('matrix').getAttribute('aria-pressed') !== 'false') throw new Error('檢視方式的按鈕應標出目前的方式（aria-pressed）');
    // 評審 M2：先只列有允許或無法判斷的格子，其餘「顯示其餘 N 格」（aria-expanded），按了列出全部
    const open = rowCells(mx).filter((c) => c.counts.allow || c.counts.unknown); const allBtn = () => L4().querySelector('.l4-table-all');
    if (L4().testAll('.l4-row').length !== Math.min(3000, open.length) || L4().testAll('.l4-row').some((tr) => /st-(deny|empty)\b/.test(tr.className))) throw new Error(`表格預設只列有允許或無法判斷的格子（${L4().testAll('.l4-row').length}／${open.length}）`);
    if (open.length < rowCells(mx).length) {
      if (!allBtn() || allBtn().getAttribute('aria-expanded') !== 'false' || !allBtn().textContent.includes(`顯示其餘 ${V.num(rowCells(mx).length - open.length)} 格`)) throw new Error('表格應有「顯示其餘 N 格」');
      allBtn().click();
      if (allBtn().getAttribute('aria-expanded') !== 'true' || document.activeElement !== allBtn()) throw new Error('按「顯示其餘」後應展開，焦點留在按鈕');
    }
    const rows = L4().testAll('.l4-row');
    if (rows.length !== Math.min(3000, rowCells(mx).length)) throw new Error(`表格應每一格一列（${rows.length}／${rowCells(mx).length}）`);
    const sig = (src, dst, status, k) => [src, dst, status, k.allow, k.deny, k.unknown, k.total].join('|');
    const want = rowCells(mx).map((c) => sig(zn.get(c.src), zn.get(c.dst), c.status, c.counts)).sort();
    const got = rows.map((tr) => {
      const td = tr.childNodes; const num = (i) => Number(td[i].textContent.replace(/,/g, ''));
      return sig(td[0].textContent, td[1].textContent.replace('（zone 內）', ''), tr.querySelector('.l4-row-status').dataset.status, { allow: num(3), deny: num(4), unknown: num(5), total: num(6) });
    }).sort();
    require('assert').deepStrictEqual(got, want);
    modeBtn('matrix').click(); await App.l4MatrixJob;
    if (!l4Cells().length) throw new Error('切回矩陣檢視');
    // 單一服務：選單列出矩陣用的每個服務
    const sel = $('#l4-service'); const opts = sel.testAll('option').map((o) => o.getAttribute('value'));
    if (opts[0] !== '' || mx.services.some((s) => !opts.includes(s.id))) throw new Error('服務選單應有「全部」與矩陣的每個服務：' + opts.join());
    const svc = !process.env.SMOKE_INPUT ? 'tcp/8443' : mx.services[1].id;
    sel.value = svc; sel.dispatch('change');
    if (!text('#l4-status').includes('計算 zone 矩陣中') || $('#l4-matrix').getAttribute('aria-busy') !== 'true') throw new Error('第一次計算應先顯示忙碌提示（aria-busy）：' + text('#l4-status'));
    await App.l4MatrixJob;
    if ($('#l4-matrix').getAttribute('aria-busy') !== 'false') throw new Error('算完後應拿掉 aria-busy');
    const one = Q.zoneMatrix({ services: [svcParts(svc)] });
    rowCells(one).forEach((c) => { const td = cellTd(c.src, c.dst); if (!td || td.dataset.status !== c.status) throw new Error(`單一服務的格子應與 Q.zoneMatrix({ services }) 相同：${c.src} → ${c.dst}`); });
    if (!process.env.SMOKE_INPUT && cellTd('list:WAN', 'vlan:20').dataset.status !== one.cells.find((c) => c.src === 'list:WAN' && c.dst === 'vlan:20').status) throw new Error('tcp/8443 的 WAN → VLAN 20');
    if (process.env.SMOKE_INPUT) console.log(`      L4 單一服務（${svc}）：${S.view.l4.timings(Q).get(svc)} ms`);
    sel.value = ''; sel.dispatch('change');
    if (text('#l4-status').includes('計算 zone 矩陣中')) throw new Error('算過的服務應直接用快取，不顯示忙碌提示');
    await App.l4MatrixJob;
    // CSV：每一格一列
    const { files } = await captureDownloads(() => L4().querySelector('.l4-csv').click());
    const csv = parseCsv(files[0].text.replace(/^﻿/, ''));
    if (!files[0].name.endsWith('.csv') || csv.length - 1 !== rowCells(mx).length || !csv[0].includes('狀態') || csv.slice(1).some((r) => r[0] === zn.get('external'))) throw new Error('CSV 應每一格一列（不含外部的來源列）');
    App.showLayer('device');
  });
  await step('L4 分段計算：進度條顯示階段與進度；計算中仍可操作（切換層級、可達性查詢）；離開 L4 或換服務時放棄，不畫過期的結果、不留下半成品', async () => {
    const Q = App.Q; const V = S.view; const mx = Q.zoneMatrix();
    // 查詢層沒有快取時，分段計算的第一次 next() 不會結束（只看不算：馬上 return()）
    const notCached = (id) => { const it = Q.zoneMatrixSteps({ services: [svcParts(id)] }); const r = it.next(); it.return(); return !r.done; };
    const svc = mx.services.map((s) => s.id).find((id) => !V.l4.timings(Q).has(id) && notCached(id));
    if (!svc) throw new Error('測試前提：應有還沒算過的服務');
    const tick = () => new Promise((r) => setImmediate(r));
    const until = async (cond, what) => { for (let i = 0; i < 200000 && !cond(); i++) await tick(); if (!cond()) throw new Error('等不到：' + what); };
    const computing = () => { const c = l4State().computing; return !!(c && c.progress); };
    App.showLayer('l4'); await App.l4Job; await App.l4MatrixJob;
    const sel = $('#l4-service');
    // 1. 計算中離開 L4：馬上切換；計算在下一段之前放棄
    sel.value = svc; sel.dispatch('change'); const job1 = App.l4MatrixJob;
    await until(computing, '開始分段計算');
    const bar = $('#l4-progress');
    if (!bar || bar.getAttribute('role') !== 'progressbar' || !/(找代表位址|逐一判斷|整理格子)/.test(bar.getAttribute('aria-valuetext') || '') || bar.getAttribute('aria-valuenow') == null) throw new Error('進度條應有階段的中文與進度（aria-valuetext、aria-valuenow）');
    if (!/第 \d／3 段：(找代表位址|逐一判斷|整理格子) [\d,]+／[\d,]+/.test(text('#l4-progress-text'))) throw new Error('進度應寫出階段與 done/total：' + text('#l4-progress-text'));
    if (l4Cells().length) throw new Error('計算中不應顯示別的服務的舊矩陣');
    layerBtn('device').click();
    if (App.layer !== 'device' || !L4().classList.contains('hidden')) throw new Error('計算中仍可切換層級');
    await job1;
    if (l4State().computing || V.l4.timings(Q).has(svc) || !notCached(svc)) throw new Error('離開 L4 時應放棄計算，查詢層不留下快取');
    if ($('#l4-matrix').getAttribute('aria-busy') !== 'false' || !text('#l4-status').includes('已停止')) throw new Error('放棄後應拿掉 aria-busy，並說明已停止');
    // 2. 回到 L4 重新計算；計算中可以做可達性查詢（不中斷計算），再換服務時放棄，畫的是新服務的矩陣
    App.showLayer('l4'); const job2 = App.l4MatrixJob;
    await until(computing, '回到 L4 後重新計算');
    $('#l4-src').value = '10.1.30.11'; $('#l4-dst').value = '10.1.10.2'; $('#l4-proto').value = 'tcp'; $('#l4-proto').dispatch('change'); $('#l4-port').value = '22'; $('#l4-run').click();
    if (!l4State().reachReq || !l4State().computing) throw new Error('計算中可以做可達性查詢，而且不中斷矩陣的計算');
    sel.value = ''; sel.dispatch('change'); // 「全部服務」已算過：馬上畫
    if (l4State().computing || text('#l4-status').includes('計算 zone 矩陣中')) throw new Error('換到算過的服務時應放棄進行中的計算，直接畫');
    await job2;
    if (V.l4.timings(Q).has(svc) || !notCached(svc)) throw new Error('換服務時應放棄計算，查詢層不留下快取');
    rowCells(mx).forEach((c) => { const td = cellTd(c.src, c.dst); if (mx.zones.length <= V.l4.MATRIX_MAX && (!td || td.dataset.status !== c.status)) throw new Error(`放棄後畫的應是目前服務（全部服務）的矩陣（${c.src} → ${c.dst}：${td ? td.dataset.status : '沒有格子'}／${c.status}）`); });
    // 3. 跑完：每個階段的進度都更新過，結果與 Q.zoneMatrix 相同
    sel.value = svc; sel.dispatch('change'); const job3 = App.l4MatrixJob;
    let fin = false; job3.then(() => { fin = true; });
    const stages = new Set(); const texts = new Set();
    while (!fin) { await tick(); const b = $('#l4-progress'); if (b && b.dataset.stage) { stages.add(b.dataset.stage); texts.add(text('#l4-progress-text')); } }
    if (!['reps', 'evaluate', 'summary'].every((s) => stages.has(s)) || texts.size < 3) throw new Error('分段計算時進度應依序更新三個階段：' + Array.from(texts).join('／'));
    const one = Q.zoneMatrix({ services: [svcParts(svc)] });
    if (notCached(svc) || !V.l4.timings(Q).has(svc)) throw new Error('跑完應寫進查詢層的快取');
    rowCells(one).forEach((c) => { const td = cellTd(c.src, c.dst); if (one.zones.length <= V.l4.MATRIX_MAX && (!td || td.dataset.status !== c.status)) throw new Error('分段計算的結果應與 Q.zoneMatrix 相同'); });
    const run = V.l4.runs(Q).get(svc);
    if (!run || run.steps < 3) throw new Error('應記錄分了幾段（畫面不寫）：' + text('#l4-status'));
    if (process.env.SMOKE_INPUT) console.log(`      L4 分段計算（${svc}）：${run.ms} ms，分 ${run.steps} 段，一段最久 ${run.maxStepMs} ms，兩段之間最長 ${run.maxGapMs} ms，總共 ${run.wallMs} ms`);
    App.showLayer('device');
  });
  await step('規則詳情：命中次數（千分位）、沒有資料與對不上（F09）的說明、0 不代表沒用；L4 影響（zone 對與停用後 allow→deny）', async () => {
    const Q = App.Q; const V = S.view; const rules = App.snap.model.firewallRules;
    const big = rules.find((r) => r.stats && r.stats.packets.length >= 4) || rules.find((r) => r.stats);
    if (!big && !process.env.SMOKE_INPUT) throw new Error('範例資料應有命中次數');
    if (big) {
      App.select({ type: 'rule', key: big.key });
      const d = fwSide().textContent;
      if (!d.includes(V.bigNum(big.stats.packets)) || !d.includes(V.bigNum(big.stats.bytes)) || !d.includes('0 只代表')) throw new Error('規則詳情應以千分位顯示命中次數，並說明 0 的意思');
      if (big.stats.packets.length >= 4 && !V.bigNum(big.stats.packets).includes(',')) throw new Error('大數字應有千分位');
      if (!fwList().testAll('.fw-hits').length) throw new Error('規則表應有命中次數欄');
    }
    if (V.bigNum('18446744073709551615') !== '18,446,744,073,709,551,615') throw new Error('超過 2^53 的命中次數也應正確加上千分位');
    const mm = Q.firewallStats().find((t) => t.status === 'mismatch');
    if (!mm && !process.env.SMOKE_INPUT) throw new Error('範例資料應有 F09（命中次數對不上）');
    if (mm) {
      const r = rules.find((x) => x.dev === mm.dev && x.family === mm.family && x.table === mm.table);
      App.select({ type: 'rule', key: r.key });
      const d = fwSide().textContent;
      if (r.stats || !d.includes('對不上') || !d.includes('F09') || !d.includes('0 只代表')) throw new Error('F09 的表的規則應說明命中次數對不上、不採用');
    }
    const noTable = rules.find((x) => !x.stats && !Q.firewallStatsOf(x.dev).some((t) => t.family === x.family && t.table === x.table));
    if (noTable) { App.select({ type: 'rule', key: noTable.key }); if (!fwSide().textContent.includes('沒有命中次數資料')) throw new Error('沒有命中次數時應寫「沒有命中次數資料」'); }
    // L4 影響：按了才算
    const mx = Q.zoneMatrix();
    const pick = mx.cells.map((c) => c.rule && c.rule.key).find((k) => k && Q.getFirewallRule(k)) || (rules.find((r) => r.family === 'ip' && r.table === 'filter' && r.chain === 'forward') || {}).key;
    if (pick) {
      App.select({ type: 'rule', key: pick });
      const t0 = Date.now(); fwSide().querySelector('.fw-impact-run').click(); await App.l4ImpactJob;
      if (process.env.SMOKE_INPUT) console.log(`      規則的 L4 影響：${Date.now() - t0} ms`);
      const imp = Q.ruleImpact(pick); const d = fwSide().textContent;
      if (!d.includes(`牽涉 ${V.num(imp.cells.length)} 個 zone 對`) || !d.includes(`allow→deny ${V.num(imp.ifDisabled.counts['allow→deny'] || 0)} 筆`)) throw new Error('規則詳情應顯示影響的 zone 對與停用後的 allow→deny：' + d.slice(0, 200));
      const zn = new Map(Q.zones().zones.map((z) => [z.id, z.name]));
      imp.cells.slice(0, 20).forEach((c) => { if (c.src && !d.includes(zn.get(c.src) || c.src)) throw new Error('應列出影響的 zone 對'); });
      App.select({ type: 'device', key: Q.devices()[0].key }); App.select({ type: 'rule', key: pick });
      if (fwSide().querySelector('.fw-impact-run') || !fwSide().textContent.includes('牽涉 ')) throw new Error('算過的影響應保留到換基準');
    }
    App.select(null);
  });
  await step('L4 zone 的來源：建立基準時的命名規則有 zones 段時，以它的標籤當 zone（標「命名規則」、不標推論）；核對失敗時說明原因、不套用', async () => {
    if (process.env.SMOKE_INPUT) return; // 範例資料才知道 VLAN 20 的網段
    const VA = S.view.app; const orig = { snap: App.snap, sources: App.round.sources, profile: App.round.profile };
    const prof = Object.assign(JSON.parse(JSON.stringify(S.profiles['site-naming'])), { zones: [{ on: 'vlan', match: '^20$', zone: 'SERVERS' }] });
    try {
      const snap = S.build(orig.sources, { profile: prof, now: '2026-01-01T00:00:00Z' });
      VA.load(snap, null, { sources: orig.sources, profile: prof }); await App.ledgerJob; await App.layoutJob;
      App.showLayer('l4'); await App.l4Job; await App.l4MatrixJob;
      const z = App.Q.zones({ profile: prof }).zones.find((x) => x.name === 'SERVERS');
      if (!z || z.source !== 'profile' || z.inferred) throw new Error('測試前提：命名規則的 zones 標籤成為 zone');
      const th = L4().testAll('th').find((x) => x.textContent.includes('SERVERS'));
      if (!th || !th.textContent.includes(S.view.ZONE_SOURCE.profile) || th.textContent.includes('推論')) throw new Error('命名規則的 zone 應標「命名規則」，不標推論');
      if (!l4Cells().some((t) => t.dataset.dst === z.id)) throw new Error('矩陣應用命名規則的 zone');
      // 命名規則的內容和基準記錄的不同：查詢層丟錯，畫面不套用並說明
      const changed = Object.assign({}, prof, { zones: [{ on: 'vlan', match: '^30$', zone: 'OTHER' }] });
      VA.setRoundInputs({ profile: changed }); App.showLayer('l4', { rebuild: true }); await App.l4Job; await App.l4MatrixJob;
      if (!text('#l4-zones').includes('命名規則的 zones 段沒有套用') || L4().testAll('th').some((x) => x.textContent.includes('OTHER'))) throw new Error('命名規則核對失敗時應說明、不套用');
    } finally {
      App.showLayer('device');
      VA.load(orig.snap, null, { sources: orig.sources, profile: orig.profile }); await App.ledgerJob; await App.layoutJob;
    }
  });
};
