/*
 * 左側「處理紀錄」分頁：處理紀錄（S.ledger）的目前狀態、本輪變化（回歸、因收集失敗而無法判斷、豁免到期）、
 * 修復追蹤（已排程修復的項目）、收斂趨勢圖，以及匯出／匯入（ssot-ledger/1 JSON）。
 * 數字全部來自核心（S.ledger.summary、advance 的結果）；這裡只排版與畫圖。
 * 圖的顏色取自 theme.trend；一張圖只有一個軸：計數（待處理、回歸、已豁免）一張，覆蓋率（比例）與未知對端各一張（小倍數）。
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
    const idx = App.snap ? App.snap.findings.findIndex((f) => App.Q.findingKey(f) === key) : -1;
    const f = idx >= 0 ? App.snap.findings[idx] : null;
    const dev = it && it.dev ? (App.Q && App.Q.getDevice(it.dev) ? App.Q.devName(it.dev) : it.dev) : null;
    const go = idx >= 0 ? () => App.selectFinding(idx) : null;
    return h('div', { class: 'ledger-item' + (go ? ' click' : ''), 'data-key': key, role: go ? 'button' : null, tabindex: go ? '0' : null, onclick: go,
      onkeydown: go ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } } : null }, [
      h('span', { class: 'id mono' }, (it && it.id) || '?'), ' ', dev ? h('span', { class: 'muted' }, dev + '：') : null,
      f ? f.message : h('span', { class: 'mono muted' }, key), extra || null]);
  }

  // ---------------------------------------------------------------- 趨勢圖
  const W = 300; const H = 132; const PAD = { l: 34, r: 56, t: 10, b: 22 };
  /** 刻度上限：取 1、2、5 × 10^n 中不小於 max 的最小值（max 為 0 時 1） */
  const niceMax = (max) => { if (max <= 0) return 1; const p = 10 ** Math.floor(Math.log10(max)); return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= max); };
  /** 外形標記：圓（r=4）、方、三角，外圈是 2px 底色環（dataviz 規格） */
  function marker(shape, x, y, color) {
    const ring = V.theme.canvas.surface;
    if (shape === 'square') return V.svg('rect', { x: x - 4, y: y - 4, width: 8, height: 8, fill: color, stroke: ring, 'stroke-width': 2 });
    if (shape === 'triangle') return V.svg('path', { d: `M${x} ${y - 5}L${x + 5} ${y + 4}L${x - 5} ${y + 4}Z`, fill: color, stroke: ring, 'stroke-width': 2 });
    return V.svg('circle', { cx: x, cy: y, r: 4, fill: color, stroke: ring, 'stroke-width': 2 });
  }
  /**
   * 折線圖：lines = [{ key, label, color, shape, values }]，xs = 每一輪的標籤，fmt(v) = 數值文字，max = 固定的上限（比例用）。
   * 每一輪有一條透明的 hover／focus 區（寬度為整個間隔），顯示該輪全部線的數值（tooltip 只是加強，表格有同樣的值）。
   */
  function lineChart(title, lines, xs, fmt, max) {
    const T = V.theme.trend; const TX = V.theme.text;
    const top = max != null ? max : niceMax(Math.max(0, ...lines.flatMap((l) => l.values.filter((v) => v != null))));
    const iw = W - PAD.l - PAD.r; const ih = H - PAD.t - PAD.b;
    const X = (i) => PAD.l + (xs.length === 1 ? iw / 2 : (iw * i) / (xs.length - 1));
    const Y = (v) => PAD.t + ih - (ih * v) / top;
    const kids = [];
    [0, top / 2, top].forEach((v) => {
      kids.push(V.svg('line', { x1: PAD.l, x2: PAD.l + iw, y1: Y(v), y2: Y(v), stroke: v ? T.grid : T.axis, 'stroke-width': 1 }));
      kids.push(V.svg('text', { x: PAD.l - 4, y: Y(v) + 4, 'text-anchor': 'end', fill: TX.muted, 'font-size': 10 }, fmt(v)));
    });
    xs.forEach((x, i) => { if (i === 0 || i === xs.length - 1 || xs.length <= 6) kids.push(V.svg('text', { x: X(i), y: H - 6, 'text-anchor': 'middle', fill: TX.muted, 'font-size': 10 }, x)); });
    lines.forEach((l) => {
      const pts = l.values.map((v, i) => (v == null ? null : [X(i), Y(v)]));
      const d = pts.reduce((acc, p, i) => (p ? acc + `${acc && pts[i - 1] ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}` : acc), '');
      kids.push(V.svg('path', { d, fill: 'none', stroke: l.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'data-series': l.key, class: 'trend-line' }));
      pts.forEach((p) => { if (p) kids.push(marker(l.shape, p[0], p[1], l.color)); });
      const last = pts.map((p, i) => [p, i]).filter(([p]) => p).pop();
      // 線尾的數值與名稱：文字用文字色，身分由旁邊的標記表示
      if (last) kids.push(V.svg('text', { x: last[0][0] + 8, y: last[0][1] + 4, fill: TX.body, 'font-size': 10, class: 'trend-end' }, fmt(l.values[last[1]])));
    });
    const cross = V.svg('line', { x1: 0, x2: 0, y1: PAD.t, y2: PAD.t + ih, stroke: T.crosshair, 'stroke-width': 1, class: 'trend-cross', visibility: 'hidden' });
    kids.push(cross);
    const tip = h('div', { class: 'trend-tip hidden', role: 'status' });
    const step = xs.length > 1 ? iw / (xs.length - 1) : iw;
    const show = (i) => {
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
      V.clear(tip);
      tip.appendChild(h('div', { class: 'muted' }, xs[i]));
      lines.forEach((l) => tip.appendChild(h('div', { class: 'trend-tip-row' }, [
        h('span', { class: 'trend-key', style: { background: l.color } }), h('b', null, l.values[i] == null ? '—' : fmt(l.values[i])), ' ', l.label])));
      tip.classList.remove('hidden');
      tip.style.left = Math.min(W - 120, Math.max(0, X(i) + 8)) + 'px';
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.classList.add('hidden'); };
    xs.forEach((x, i) => kids.push(V.svg('rect', {
      x: X(i) - step / 2, y: PAD.t, width: step, height: ih, fill: 'transparent', tabindex: 0, class: 'trend-hit', 'data-round': i,
      'aria-label': `${x}：` + lines.map((l) => `${l.label} ${l.values[i] == null ? '—' : fmt(l.values[i])}`).join('，'),
      onpointerenter: () => show(i), onpointermove: () => show(i), onfocus: () => show(i), onpointerleave: hide, onblur: hide,
    })));
    const legend = lines.length > 1 ? h('div', { class: 'trend-legend' }, lines.map((l) => h('span', { class: 'trend-legend-item', 'data-series': l.key }, [
      h('span', { class: 'trend-key', style: { background: l.color } }), l.label]))) : null;
    return h('div', { class: 'trend-chart', 'data-chart': title }, [
      h('div', { class: 'trend-title' }, title), legend,
      h('div', { class: 'trend-plot' }, [V.svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': title + '（每一輪的數值見下方表格）' }, kids), tip]),
    ]);
  }
  const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
  /** 收斂趨勢：只有一輪時列出目前的數字，不畫圖；兩輪以上畫三張小倍數折線圖，並附表格檢視 */
  function trend(series) {
    if (!series.length) return h('div', { class: 'muted pane-note' }, '建立基準後，每一輪的待處理、回歸與覆蓋會記在這裡。');
    const T = V.theme.trend; const last = series[series.length - 1];
    const tiles = [['待處理', V.num(last.pending)], ['回歸', V.num(last.counts.regressed || 0)], ['已豁免', V.num(last.counts.accepted || 0)],
      ['覆蓋率', pct(last.coverage.ratio)], ['未知對端', V.num(last.unknownPeers)]];
    const tileBox = h('div', { class: 'trend-tiles' }, tiles.map(([label, v]) => h('div', { class: 'trend-tile' }, [h('div', { class: 'muted' }, label), h('div', { class: 'trend-value' }, v)])));
    if (series.length < 2) return h('div', null, [h('p', { class: 'muted trend-single' }, '目前只有一輪，下一輪基準建立後才會畫出趨勢。'), tileBox]);
    const xs = series.map((r, i) => `第 ${i + 1} 輪`);
    const num = (v) => V.num(Math.round(v));
    const table = h('details', { class: 'trend-table' }, [h('summary', null, '表格檢視'), V.table([
      { t: '輪次', f: (r) => xs[series.indexOf(r)] }, { t: '時間', f: (r) => h('span', { class: 'mono' }, V.fmtUtc(r.at)) },
      { t: '待處理', f: (r) => V.num(r.pending) }, { t: '回歸', f: (r) => V.num(r.counts.regressed || 0) }, { t: '已豁免', f: (r) => V.num(r.counts.accepted || 0) },
      { t: '覆蓋率', f: (r) => `${pct(r.coverage.ratio)}（${V.num(r.coverage.collected)}/${V.num(r.coverage.expected)}）` }, { t: '未知對端', f: (r) => V.num(r.unknownPeers) },
    ], series)]);
    return h('div', { class: 'trend' }, [tileBox,
      lineChart('待處理、回歸與已豁免（筆數）', [
        { key: 'pending', label: '待處理', color: T.pending, shape: T.marker.pending, values: series.map((r) => r.pending) },
        { key: 'regressed', label: '回歸', color: T.regressed, shape: T.marker.regressed, values: series.map((r) => r.counts.regressed || 0) },
        { key: 'accepted', label: '已豁免', color: T.accepted, shape: T.marker.accepted, values: series.map((r) => r.counts.accepted || 0) },
      ], xs, num),
      lineChart('覆蓋率（已收集／應收集）', [{ key: 'coverage', label: '覆蓋率', color: T.single, shape: 'circle', values: series.map((r) => r.coverage.ratio) }],
        xs, pct, 1),
      lineChart('未知對端（個）', [{ key: 'unknownPeers', label: '未知對端', color: T.single, shape: 'circle', values: series.map((r) => r.unknownPeers) }], xs, num),
      table]);
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
      body.appendChild(h('h4', { class: 'pane-title' }, '收斂趨勢'));
      body.appendChild(trend(sum.series));
    }
    // 匯出與匯入
    const file = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden ledger-file', onchange: async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      let text; try { text = await f.text(); } catch (e) { App.importLedger(f.name, ''); return; }
      App.importLedger(f.name, text);
    } });
    body.appendChild(h('h4', { class: 'pane-title' }, '匯出與匯入'));
    body.appendChild(h('div', { class: 'row' }, [file,
      h('button', { class: 'ledger-export', disabled: st.blocked && st.blocked.raw === undefined ? true : null, onclick: () => App.exportLedger() }, '匯出處理紀錄（JSON）'),
      h('button', { class: 'ledger-import', onclick: () => file.click() }, '匯入處理紀錄…')]));
    body.appendChild(h('p', { class: 'muted' }, '匯入會先檢查格式；格式正確時，確認後以匯入的內容覆蓋目前的處理紀錄（不合併），再以目前的基準推進一輪。建議覆蓋前先匯出目前的處理紀錄。'));
    const imp = st.imported;
    if (imp && imp.errors) {
      body.appendChild(h('div', { class: 'ledger-import-result', role: 'alert' }, [
        h('p', { class: 'warn-line' }, `${imp.name} 的格式不正確（${imp.errors.length} 項），沒有匯入，目前的處理紀錄不變：`),
        h('ul', { class: 'ledger-errors' }, imp.errors.slice(0, 30).map((e) => h('li', { class: 'mono' }, e))),
        h('button', { onclick: () => App.cancelImport() }, '關閉'),
      ]));
    } else if (imp && imp.ledger) {
      body.appendChild(h('div', { class: 'ledger-import-result ledger-import-confirm' }, [
        h('p', null, `${imp.name}：${V.num(Object.keys(imp.ledger.items).length)} 項、${V.num(imp.ledger.iterations.length)} 輪。覆蓋目前的處理紀錄`
          + (st.blocked ? '' : `（${V.num(Object.keys(lg.items).length)} 項、${V.num(lg.iterations.length)} 輪）`) + '？'),
        h('div', { class: 'row' }, [
          st.blocked ? null : h('button', { onclick: () => App.exportLedger() }, '先匯出目前的'),
          h('button', { class: 'primary ledger-confirm-import', onclick: () => App.confirmImport() }, '覆蓋'),
          h('button', { class: 'ghost', onclick: () => App.cancelImport() }, '取消')]),
      ]));
    }
  }

  V.ledgerPane = { render, lineChart, niceMax };
})(globalThis.SSOT = globalThis.SSOT || {});
