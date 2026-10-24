/*
 * 左側「處理紀錄」分頁：處理紀錄（S.ledger）的目前狀態、本輪變化（回歸、因收集失敗而無法判斷、豁免到期）、
 * 修復追蹤（已排程修復的項目）、最新一輪的數字，以及匯出／匯入的入口（在資料中心）。
 * 中間的「收斂趨勢」工作畫面（renderTrend）：每一輪的趨勢圖與表格檢視。
 * 數字全部來自核心（S.ledger.summary、advance 的結果）；這裡只排版與畫圖。
 * 圖的顏色與線型取自 theme.trend；一張圖只有一個軸：計數（待處理、回歸、已豁免）一張，覆蓋率（比例）與未知對端各一張（小倍數）。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h;
  const A = () => V.app;
  const R = () => V.remediation;
  const ui = { open: new Set() };

  // ---------------------------------------------------------------- 共用
  const fold = (key, title, count, body, opt) => {
    const el = h('details', { class: 'detail-fold ledger-fold', 'data-section': key, open: ui.open.has(key) || (opt && opt.open) || null }, [
      h('summary', null, [title, count == null ? null : V.chip(String(count), (opt && opt.cls) || '')]), body]);
    el.addEventListener('toggle', () => (el.open ? ui.open.add(key) : ui.open.delete(key)));
    return el;
  };
  /** 處理紀錄項目的一列：規則、設備、目前基準中的訊息（沒有時列出 findingKey）；目前基準有這筆時點一下定位 */
  function itemRow(App, key, it, extra) {
    const idx = App.Q ? App.Q.findingIndexByKey(key) : -1;
    const f = idx >= 0 ? App.Q.finding(idx) : null;
    const dev = it && it.dev ? (App.Q && App.Q.getDevice(it.dev) ? App.Q.devName(it.dev) : it.dev) : null;
    const go = idx >= 0 ? () => App.selectFinding(idx) : null;
    return h('div', { class: 'ledger-item' + (go ? ' click' : ''), 'data-key': key, role: go ? 'button' : null, tabindex: go ? '0' : null, onclick: go,
      onkeydown: go ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } } : null }, [
      h('span', { class: 'id mono' }, (it && it.id) || '?'), ' ', dev ? h('span', { class: 'muted' }, dev + '：') : null,
      f ? f.message : h('span', { class: 'mono muted' }, key), extra || null]);
  }

  // ---------------------------------------------------------------- 趨勢圖
  // 中間的「收斂趨勢」工作畫面用：一張圖的大小固定（px，不縮放，字級不會變小）；畫面比圖窄時，圖在自己的框內水平捲動
  const H = 200; const PAD = { l: 40, r: 96, t: 14, b: 26 };
  const END_GAP = 12; // 線尾文字的最小垂直間距（數值相同的線不會疊在一起）
  /** 刻度上限：取 1、2、5 × 10^n 中不小於 max 的最小值（max 為 0 時 1） */
  const niceMax = (max) => { if (max <= 0) return 1; const p = 10 ** Math.floor(Math.log10(max)); return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= max); };
  /** 外形標記：圓、方、三角，外圈是底色環；大小與線寬取自 theme.trend */
  function marker(shape, x, y, color) {
    const T = V.theme.trend; const r = T.markerSize; const ring = { stroke: V.theme.canvas.surface, 'stroke-width': T.markerRing };
    if (shape === 'square') return V.svg('rect', Object.assign({ x: x - r, y: y - r, width: 2 * r, height: 2 * r, fill: color, 'data-shape': shape }, ring));
    if (shape === 'triangle') return V.svg('path', Object.assign({ d: `M${x} ${y - r - 1}L${x + r + 1} ${y + r}L${x - r - 1} ${y + r}Z`, fill: color, 'data-shape': shape }, ring));
    return V.svg('circle', Object.assign({ cx: x, cy: y, r, fill: color, 'data-shape': 'circle' }, ring));
  }
  /** 圖例與 tooltip 的樣本：一小段細線加上這條線的外形標記（和圖上相同，不只靠顏色） */
  const swatch = (l) => V.svg('svg', { class: 'trend-swatch', width: 22, height: 12, viewBox: '0 0 22 12', 'aria-hidden': 'true' }, [
    V.svg('line', { x1: 1, x2: 21, y1: 6, y2: 6, stroke: l.color, 'stroke-width': V.theme.trend.lineWidth }), marker(l.shape, 11, 6, l.color)]);
  /** 線尾文字的位置：依 y 排序後往下推，間距至少 END_GAP；超出圖的下緣時整組往上移 */
  function spreadEnds(ends, lo, hi) {
    const list = ends.slice().sort((a, b) => a.y - b.y);
    list.forEach((e, n) => { e.ty = n ? Math.max(e.y, list[n - 1].ty + END_GAP) : e.y; });
    const over = list.length ? list[list.length - 1].ty - hi : 0;
    if (over > 0) list.forEach((e) => { e.ty = Math.max(lo, e.ty - over); });
    return list;
  }
  /**
   * 折線圖：lines = [{ key, label, color, shape, values }]，xs = 每一輪的標籤，fmt(v) = 數值文字，max = 固定的上限（比例用）。
   * opt.width 是圖寬（px），opt.subs 是每一輪的補充文字（tooltip 第二行，例如建立時間）。
   * 依 dataviz 的規則：細線與外形標記（theme.trend）、多條線時有圖例（樣本含外形）、線尾寫出名稱與數值、
   * 每一輪一個透明的 hover／focus 區顯示該輪全部線的數值（tooltip 只是加強，表格檢視有同樣的值）。
   * 鍵盤：一張圖只有一個 Tab 停點（最後一輪），左右方向鍵、Home、End 換輪次。
   */
  function lineChart(title, lines, xs, fmt, max, opt) {
    const o = opt || {}; const W = o.width || 360;
    const T = V.theme.trend; const TX = V.theme.text;
    const top = max != null ? max : niceMax(Math.max(0, ...lines.flatMap((l) => l.values.filter((v) => v != null))));
    const iw = W - PAD.l - PAD.r; const ih = H - PAD.t - PAD.b;
    const X = (i) => PAD.l + (xs.length === 1 ? iw / 2 : (iw * i) / (xs.length - 1));
    const Y = (v) => PAD.t + ih - (ih * v) / top;
    const kids = [];
    [0, top / 2, top].forEach((v) => {
      kids.push(V.svg('line', { x1: PAD.l, x2: PAD.l + iw, y1: Y(v), y2: Y(v), stroke: v ? T.grid : T.axis, 'stroke-width': 1 }));
      kids.push(V.svg('text', { x: PAD.l - 5, y: Y(v) + 4, 'text-anchor': 'end', fill: TX.muted, 'font-size': 11 }, fmt(v)));
    });
    // x 軸標籤：輪次多時只標頭尾與等距的幾個，避免重疊
    const every = Math.max(1, Math.ceil(xs.length / Math.max(2, Math.floor(iw / 56))));
    xs.forEach((x, i) => { if (i === 0 || i === xs.length - 1 || i % every === 0) kids.push(V.svg('text', { x: X(i), y: H - 7, 'text-anchor': 'middle', fill: TX.muted, 'font-size': 11 }, x)); });
    const ends = [];
    lines.forEach((l) => {
      const pts = l.values.map((v, i) => (v == null ? null : [X(i), Y(v)]));
      const d = pts.reduce((acc, p, i) => (p ? acc + `${acc && pts[i - 1] ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}` : acc), '');
      kids.push(V.svg('path', { d, fill: 'none', stroke: l.color, 'stroke-width': T.lineWidth, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'data-series': l.key, class: 'trend-line' }));
      pts.forEach((p) => { if (p) kids.push(marker(l.shape, p[0], p[1], l.color)); });
      const last = pts.map((p, i) => [p, i]).filter(([p]) => p).pop();
      if (last) ends.push({ l, x: last[0][0], y: last[0][1], v: l.values[last[1]] });
    });
    // 線尾的名稱與數值：文字用文字色（對底色 ≥ 4.5:1），身分由前面的外形標記表示
    spreadEnds(ends, PAD.t, PAD.t + ih).forEach((e) => kids.push(V.svg('text', { x: e.x + 9, y: e.ty + 4, fill: TX.body, 'font-size': 11, class: 'trend-end', 'data-series': e.l.key },
      lines.length > 1 ? `${e.l.label} ${fmt(e.v)}` : fmt(e.v))));
    const cross = V.svg('line', { x1: 0, x2: 0, y1: PAD.t, y2: PAD.t + ih, stroke: T.crosshair, 'stroke-width': 1, class: 'trend-cross', visibility: 'hidden' });
    kids.push(cross);
    const tip = h('div', { class: 'trend-tip hidden', role: 'status' });
    const step = xs.length > 1 ? iw / (xs.length - 1) : iw;
    const valText = (l, i) => (l.values[i] == null ? '—' : fmt(l.values[i]));
    const show = (i) => {
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
      V.clear(tip);
      tip.appendChild(h('div', { class: 'trend-tip-head' }, [h('b', null, xs[i]), o.subs && o.subs[i] ? h('span', { class: 'muted' }, ' ' + o.subs[i]) : null]));
      lines.forEach((l) => tip.appendChild(h('div', { class: 'trend-tip-row', 'data-series': l.key }, [swatch(l), h('b', null, valText(l, i)), ' ', l.label])));
      tip.classList.remove('hidden');
      tip.style.left = Math.round(Math.min(W - 160, Math.max(0, X(i) + 10))) + 'px';
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.classList.add('hidden'); };
    const hits = xs.map((x, i) => V.svg('rect', {
      x: X(i) - step / 2, y: PAD.t, width: step, height: ih, fill: 'transparent', tabindex: i === xs.length - 1 ? 0 : -1, class: 'trend-hit', 'data-round': i,
      role: 'img', 'aria-label': `${title}，${x}${o.subs && o.subs[i] ? '（' + o.subs[i] + '）' : ''}：` + lines.map((l) => `${l.label} ${valText(l, i)}`).join('，'),
      onpointerenter: () => show(i), onpointermove: () => show(i), onfocus: () => show(i), onpointerleave: hide, onblur: hide,
      onkeydown: (e) => {
        const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: xs.length - 1 }[e.key];
        if (n === undefined) return;
        e.preventDefault();
        const to = hits[Math.max(0, Math.min(xs.length - 1, n))];
        hits.forEach((r) => r.setAttribute('tabindex', r === to ? '0' : '-1'));
        to.focus();
      },
    }));
    hits.forEach((r) => kids.push(r));
    const legend = lines.length > 1 ? h('div', { class: 'trend-legend', role: 'list', 'aria-label': title + '的圖例' }, lines.map((l) => h('span', { class: 'trend-legend-item', role: 'listitem', 'data-series': l.key }, [
      swatch(l), l.label]))) : null;
    return h('figure', { class: 'trend-chart', 'data-chart': title }, [
      h('figcaption', { class: 'trend-title' }, title), legend,
      h('div', { class: 'trend-plot' }, [V.svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'group', 'aria-label': title + '（方向鍵切換輪次；每一輪的數值也在表格檢視）' }, kids), tip]),
    ]);
  }
  const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
  /** 最新一輪的數字（左側分頁的摘要與工作畫面共用） */
  function trendTiles(series) {
    const last = series[series.length - 1];
    const tiles = [['待處理', V.num(last.pending)], ['回歸', V.num(last.counts.regressed || 0)], ['已豁免', V.num(last.counts.accepted || 0)],
      ['覆蓋率', pct(last.coverage.ratio)], ['未知對端', V.num(last.unknownPeers)]];
    return h('div', { class: 'trend-tiles' }, tiles.map(([label, v]) => h('div', { class: 'trend-tile' }, [h('div', { class: 'muted' }, label), h('div', { class: 'trend-value' }, v)])));
  }
  /** 收斂趨勢：只有一輪時列出目前的數字，不畫圖；兩輪以上畫三張小倍數折線圖（一張一個軸），並附表格檢視 */
  function trend(series) {
    if (!series.length) return h('div', { class: 'muted pane-note' }, '建立基準後，每一輪的待處理、回歸與覆蓋會記在這裡。');
    const T = V.theme.trend;
    const tileBox = trendTiles(series);
    if (series.length < 2) return h('div', null, [h('p', { class: 'muted trend-single' }, '目前只有一輪，下一輪基準建立後才會畫出趨勢。'), tileBox]);
    const xs = series.map((r, i) => `第 ${i + 1} 輪`);
    const subs = series.map((r) => V.fmtUtc(r.at));
    const num = (v) => V.num(Math.round(v));
    const table = h('details', { class: 'trend-table' }, [h('summary', null, '表格檢視'), h('div', { class: 'work-table' }, V.table([
      { t: '輪次', f: (r) => xs[series.indexOf(r)] }, { t: '時間', f: (r) => h('span', { class: 'mono' }, V.fmtUtc(r.at)) },
      { t: '待處理', f: (r) => V.num(r.pending) }, { t: '回歸', f: (r) => V.num(r.counts.regressed || 0) }, { t: '已豁免', f: (r) => V.num(r.counts.accepted || 0) },
      { t: '覆蓋率', f: (r) => `${pct(r.coverage.ratio)}（${V.num(r.coverage.collected)}/${V.num(r.coverage.expected)}）` }, { t: '未知對端', f: (r) => V.num(r.unknownPeers) },
    ], series))]);
    return h('div', { class: 'trend' }, [tileBox,
      h('div', { class: 'trend-charts' }, [
        lineChart('待處理、回歸與已豁免（筆數）', [
          { key: 'pending', label: '待處理', color: T.pending, shape: T.marker.pending, values: series.map((r) => r.pending) },
          { key: 'regressed', label: '回歸', color: T.regressed, shape: T.marker.regressed, values: series.map((r) => r.counts.regressed || 0) },
          { key: 'accepted', label: '已豁免', color: T.accepted, shape: T.marker.accepted, values: series.map((r) => r.counts.accepted || 0) },
        ], xs, num, null, { width: 480, subs }),
        lineChart('覆蓋率（已收集／應收集）', [{ key: 'coverage', label: '覆蓋率', color: T.single, shape: 'circle', values: series.map((r) => r.coverage.ratio) }],
          xs, pct, 1, { subs }),
        lineChart('未知對端（個）', [{ key: 'unknownPeers', label: '未知對端', color: T.single, shape: 'circle', values: series.map((r) => r.unknownPeers) }], xs, num, null, { subs }),
      ]),
      table]);
  }
  /** 中間的「收斂趨勢」工作畫面（#trend-body） */
  function renderTrend(App) {
    const root = V.clear(V.$('#trend-body'));
    const st = A().ledgerState();
    if (st.blocked) { root.appendChild(h('p', { class: 'warn-line' }, '處理紀錄目前無法使用，沒有趨勢可以畫：' + st.blocked.reason + '（見左側的「處理紀錄」分頁）')); return; }
    root.appendChild(h('section', { class: 'work-card' }, [
      h('p', { class: 'muted' }, '每建立一份新的基準算一輪：待處理越少、回歸為 0、覆蓋率越高越好。滑過或用方向鍵切換輪次可以看每一輪的數值；表格檢視列出同樣的數字。'),
      trend(S.ledger.summary(st.ledger).series)]));
  }

  // ---------------------------------------------------------------- 分頁
  function render(App) {
    const root = V.clear(V.$('#pane-ledger'));
    const st = A().ledgerState(); const lg = st.ledger;
    const body = h('div', { class: 'pane-body ledger-pane' });
    root.appendChild(body);
    body.appendChild(h('p', { class: 'muted' }, '處理紀錄是你對每個檢查結果的決定與歷程（ssot-ledger/1），存在這個瀏覽器、不放進基準。每次建立基準都會推進一輪：'
      + '排程修復的項目消失時判定為已修好，又出現時標為回歸。請定期匯出保存。'));
    if (st.blocked) {
      body.appendChild(h('div', { class: 'ledger-blocked-box', role: 'alert' }, [
        h('p', { class: 'warn-line' }, '處理紀錄目前無法使用：' + st.blocked.reason),
        st.blocked.errors.length ? h('ul', { class: 'ledger-errors' }, st.blocked.errors.slice(0, 20).map((e) => h('li', { class: 'mono' }, e))) : null,
        st.blocked.errors.length > 20 ? h('p', { class: 'muted' }, `另有 ${st.blocked.errors.length - 20} 項錯誤`) : null,
        h('div', { class: 'row' }, [
          st.blocked.raw !== undefined ? h('button', { onclick: () => App.exportLedger() }, '匯出原資料') : null,
          h('button', { class: 'ledger-reset', onclick: () => App.resetLedger() }, '以空白的處理紀錄重新開始'),
        ]),
      ]));
    } else {
      const sum = S.ledger.summary(lg); const cur = sum.current;
      body.appendChild(h('div', { class: 'summary sub ledger-counts' }, S.ledger.STATUS.map((s) => V.chip(`${R().statusText(s)} ${V.num(cur.byStatus[s])}`,
        cur.byStatus[s] ? R().STATUS_CHIP[s] : '', { 'data-status': s }))));
      if (cur.waivers.missingReason) body.appendChild(h('p', { class: 'warn-line' }, `${V.num(cur.waivers.missingReason)} 項豁免沒有寫原因（例如由舊的確認標記轉換而來），請補上。`));
      if (st.saveError) body.appendChild(h('p', { class: 'warn-line' }, '最近一次儲存失敗：' + st.saveError));
      // 本輪變化（advance 的結果；同一份基準重新開啟時不顯示）
      if (st.round && App.Q) {
        const by = (r) => st.round.changes.filter((c) => c.reason === r);
        const re = by('reappeared'); const ex = by('waiver-expired'); const fixed = by('disappeared'); const neu = by('new');
        body.appendChild(h('h4', { class: 'pane-title' }, '本輪變化'));
        body.appendChild(h('div', { class: 'summary sub ledger-round-summary' }, [
          V.chip(`新出現 ${V.num(neu.length)}`, neu.length ? 'info' : ''), V.chip(`已修好 ${V.num(fixed.length)}`, fixed.length ? 'ok' : ''),
          V.chip(`回歸 ${V.num(re.length)}`, re.length ? 'err' : '', { 'data-reason': 'reappeared' }),
          V.chip(`豁免到期 ${V.num(ex.length)}`, ex.length ? 'warn' : '', { 'data-reason': 'waiver-expired' }),
          V.chip(`無法判斷 ${V.num(st.round.unobserved.length)}`, st.round.unobserved.length ? 'warn' : '', { 'data-reason': 'unobserved' }),
        ]));
        const list = (key, title, cls, keys, note) => (keys.length ? fold(key, title, keys.length, h('div', { class: 'ledger-list', 'data-reason': key }, [
          note ? h('p', { class: 'muted' }, note) : null, ...keys.slice(0, 300).map((k) => itemRow(App, k, lg.items[k]))]), { open: true, cls }) : null);
        [list('reappeared', '回歸：修好後又出現', 'err', re.map((c) => c.key), '上一輪判定為已修好，這一輪又出現。'),
          list('unobserved', '因收集失敗而無法判斷', 'warn', st.round.unobserved,
            '這些待處理項目這一輪沒有出現，但所屬設備有收集失敗或沒有收集，無法判斷是否已修好，狀態不變。補收集後再建立基準。'),
          list('waiver-expired', '豁免到期，改回待處理', 'warn', ex.map((c) => c.key), '「可接受」的到期日已過，請重新檢視。'),
          list('disappeared', '這一輪已修好', 'ok', fixed.map((c) => c.key))].forEach((x) => { if (x) body.appendChild(x); });
      }
      // 修復追蹤：已排程修復的項目，以及累計已修好的
      const keysOf = (s) => Object.keys(lg.items).filter((k) => lg.items[k].status === s);
      const sched = keysOf('scheduled'); const fixedAll = keysOf('fixed');
      const present = new Set(App.Q ? App.Q.findings().map((f) => App.Q.findingKey(f)) : []);
      body.appendChild(h('h4', { class: 'pane-title' }, '修復追蹤'));
      body.appendChild(sched.length || fixedAll.length ? h('div', { class: 'fix-tracking' }, [
        sched.length ? fold('scheduled', '已排程修復', sched.length, h('div', { class: 'ledger-list', 'data-status': 'scheduled' },
          sched.slice(0, 300).map((k) => itemRow(App, k, lg.items[k], present.has(k) ? V.chip('目前基準仍有', 'warn') : V.chip('目前基準沒有', 'info'))))) : null,
        fixedAll.length ? fold('fixed', '已修好', fixedAll.length, h('div', { class: 'ledger-list', 'data-status': 'fixed' },
          fixedAll.slice(0, 300).map((k) => itemRow(App, k, lg.items[k])))) : null,
      ]) : h('p', { class: 'muted pane-note' }, '沒有「已排程修復」的項目。在檢查結果按「處理」選「已排程修復」，下一輪基準就會在這裡追蹤。'));
      // 收斂趨勢：圖與表格在中間的「收斂趨勢」工作畫面（全寬）；這裡只列最新一輪的數字與入口
      body.appendChild(h('h4', { class: 'pane-title' }, '收斂趨勢'));
      body.appendChild(sum.series.length ? trendTiles(sum.series) : h('p', { class: 'muted pane-note' }, '建立基準後，每一輪的待處理、回歸與覆蓋會記在這裡。'));
      body.appendChild(h('div', { class: 'row' }, [
        h('button', { class: 'open-view', 'data-view': 'trend', disabled: !App.snap || null, onclick: () => App.showView('trend', { focus: true }) },
          sum.series.length > 1 ? `在中間開啟收斂趨勢（${V.num(sum.series.length)} 輪的圖與表格）` : '在中間開啟收斂趨勢'),
      ]));
    }
    // 匯出與匯入集中在資料中心（app-hub.js）；這裡只放入口
    body.appendChild(h('h4', { class: 'pane-title' }, '匯出與匯入'));
    body.appendChild(h('div', { class: 'row' }, [
      h('button', { class: 'open-hub', 'data-hub-section': 'ledger', onclick: () => App.openHub('ledger') }, '在資料中心匯出或匯入…'),
      h('span', { class: 'muted' }, '處理紀錄也會放進工作包，下一輪讀回工作包就能接著做。'),
    ]));
  }

  /**
   * 匯入處理紀錄的結果（資料中心顯示）：格式不正確時列出全部錯誤、目前的處理紀錄不變；格式正確時請使用者確認整份覆蓋。
   * 沒有進行中的匯入時回傳 null。
   */
  function importBlock(App) {
    const st = A().ledgerState(); const lg = st.ledger; const imp = st.imported;
    if (imp && imp.errors) {
      return h('div', { class: 'ledger-import-result', role: 'alert' }, [
        h('p', { class: 'warn-line' }, `${imp.name} 的格式不正確（${imp.errors.length} 項），沒有匯入，目前的處理紀錄不變：`),
        h('ul', { class: 'ledger-errors' }, imp.errors.map((e) => h('li', { class: 'mono' }, e))),
        h('button', { 'data-hub-focus': 'ledger-import', onclick: () => App.cancelImport() }, '關閉'),
      ]);
    }
    if (imp && imp.ledger) {
      return h('div', { class: 'ledger-import-result ledger-import-confirm', role: 'group', 'aria-label': '確認匯入處理紀錄' }, [
        h('p', null, `${imp.name}：${V.num(Object.keys(imp.ledger.items).length)} 項、${V.num(imp.ledger.iterations.length)} 輪。覆蓋目前的處理紀錄`
          + (st.blocked ? '' : `（${V.num(Object.keys(lg.items).length)} 項、${V.num(lg.iterations.length)} 輪）`) + '？'),
        h('p', { class: 'muted' }, '覆蓋是整份取代（不合併），之後以目前的基準推進一輪。建議覆蓋前先匯出目前的處理紀錄。'),
        h('div', { class: 'row' }, [
          st.blocked ? null : h('button', { onclick: () => App.exportLedger() }, '先匯出目前的'),
          h('button', { class: 'primary ledger-confirm-import', 'data-hub-focus': 'ledger-confirm', onclick: () => App.confirmImport() }, '覆蓋'),
          h('button', { class: 'ghost', onclick: () => App.cancelImport() }, '取消')]),
      ]);
    }
    return null;
  }

  V.ledgerPane = { render, renderTrend, importBlock, lineChart, niceMax };
})(globalThis.SSOT = globalThis.SSOT || {});
