// 畫面冒煙測試的 step：拓樸圖的繪圖、終端、分群標籤、聚焦、觸控與廠商色。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { winListeners, document, flushRaf, S, step, recordCanvas, $, text } = require('../helpers.js');

module.exports = async () => {
  await step('繪圖：不同縮放程度、分群、主機切換', () => {
    const g = App.graph; [0.05, 0.3, 0.8, 1.6, 3].forEach((s) => { g.s = s; g.draw(); });
    $('#btn-hosts').click(); g.draw(); $('#btn-groups').click(); g.draw(); $('#btn-groups').click(); $('#btn-relayout').click(); g.draw();
    $('#btn-force').click(); flushRaf(5); $('#btn-force').click();
  });
  await step('終端：畫在圖上、可點選、收合與展開', () => {
    const g = App.graph; const v = g.nodes.filter((n) => n.virtual);
    if (!v.length) throw new Error('圖上沒有未知對端節點');
    if (process.env.SMOKE_INPUT) { // 大型網路：全網超過上限，全部收合成群組
      if (!v.every((n) => n.kind === 'cluster')) throw new Error('超過全網上限時應全部收合');
      g.emit('click', { type: 'node', id: v[0].id }); if (App.sel.type !== 'endpoints') throw new Error('點群組應顯示終端清單'); return;
    }
    if (!v.some((n) => n.kind === 'endpoint')) throw new Error('應有單一 MAC 的未知對端');
    if (!v.every((n) => g.pos.has(n.id) && g.edgesByNode.has(n.id))) throw new Error('未知對端缺少位置或連線');
    const one = v.find((n) => n.kind === 'endpoint'); g.hover = { type: 'node', id: one.id }; g.draw(); g.hover = null;
    g.emit('click', { type: 'node', id: one.id }); if (App.sel.type !== 'interface') throw new Error('點選單一未知對端應顯示該介面');
    // 收合：上限降到 3 → 每台設備的終端合併成一個群組
    App.UNKNOWN_EXPAND_MAX = 3; App.expanded = new Set(); App.toggleExpand('TPE_ACC_SW_01'); App.toggleExpand('TPE_ACC_SW_01');
    const cl = g.nodes.filter((n) => n.kind === 'cluster'); if (!cl.length) throw new Error('超過上限時應收合成群組');
    g.draw(); g.emit('click', { type: 'node', id: cl[0].id }); if (App.sel.type !== 'endpoints' || !text('#detail').includes('終端埠')) throw new Error('點群組應顯示終端清單');
    g.emit('dblclick', { type: 'node', id: cl[0].id });
    if (g.nodes.some((n) => n.id === cl[0].id)) throw new Error('雙擊群組應展開');
    if (g.nodes.filter((n) => n.virtual && n.parent === cl[0].parent && n.kind !== 'cluster').length !== 8) throw new Error('展開後應有 8 個終端');
    App.UNKNOWN_EXPAND_MAX = 8; App.expanded = new Set();
    $('#btn-unknown').click(); g.draw(); if (g.nodes.filter((n) => g.visible(n) && n.virtual).length) throw new Error('關閉開關後不應顯示未知對端');
    $('#btn-unknown').click();
    // 搜尋 MAC → 高亮未知對端節點
    const m = App.snap.model.macs.find((x) => x.edge.length === 1 && App.vOfEp.has(x.edge[0]));
    if (m) { App.select({ type: 'mac', key: m.mac }, { focus: true }); if (!g.hl.nodes.has(App.vOfEp.get(m.edge[0]))) throw new Error('MAC 搜尋應標出未知對端'); }
    // 檢查結果 A03 → 顯示終端清單
    const i = App.snap.findings.findIndex((f) => f.id === 'A03'); if (i >= 0) { App.selectFinding(i); if (App.sel.type !== 'endpoints') throw new Error('A03 應顯示終端清單'); }
    // 已經逐一畫出（沒有收合、也不是手動展開）：按鈕停用並寫「已顯示全部」，不用括號包住狀態當按鈕文字
    const many = g.nodes.find((n) => n.virtual && n.kind === 'endpoint' && !App.expanded.has(n.parent) && g.nodes.filter((x) => x.virtual && x.parent === n.parent).length > 1);
    if (many) {
      App.select({ type: 'endpoints', dev: many.parent });
      const b = $('#detail').testAll('button').find((x) => x.textContent === '已顯示全部');
      if (!b || !(b.disabled || b.getAttribute('disabled') != null) || text('#detail').includes('已全部展開')) throw new Error('全部終端都已畫出時按鈕應停用並寫「已顯示全部」');
    }
  });
  await step('分群標籤：各種縮放下互不重疊、不超出群框、縮短後兩兩不同（先留尾段再截斷）；滑過群框或標籤顯示全名', () => {
    const g = App.graph; const cv = $('#graph'); App.select(null);
    if (!g.showGroups) throw new Error('測試前提：分群底框應為開啟');
    g.computeGroups(); if (!g.groupBoxes) throw new Error('測試前提：應有兩個以上的分群');
    g.fit(); const base = { s: g.s, tx: g.tx, ty: g.ty }; let total = 0;
    [0.25, 0.5, 1, 2, 4, 8].forEach((k) => {
      Object.assign(g, base); g.zoomAt(k); g.hoverGroup = null; g.draw();
      const ls = g.groupLabels; total += ls.length;
      if (ls.some((l) => l.forced)) throw new Error('沒有滑過時不應有強制顯示的標籤');
      ls.forEach((l) => {
        const vx0 = Math.max(l.box.x0, 0); const vx1 = Math.min(l.box.x1, g.w);
        const short = l.name.replace(/\s*[（(].*$/, '') || l.name; const tail = short.split(/\s+/).pop();
        // 簡稱（「分群 2」）比群框寬時可以超出群框（只剩尾段「2」看不出是分群），但仍在畫布內
        if (l.text === short ? (l.x0 < -0.01 || l.x1 > g.w + 0.01) : (l.x0 < vx0 - 0.01 || l.x1 > vx1 + 0.01)) throw new Error(`分群標籤超出群框寬度（縮放 ${k}）：${l.text} ${Math.round(l.x0)}–${Math.round(l.x1)}，框 ${Math.round(vx0)}–${Math.round(vx1)}`);
        const ok = [l.name, short, tail].includes(l.text) || (l.text.endsWith('…') && short.startsWith(l.text.slice(0, -1)) && Array.from(l.text).length >= 3);
        if (!ok) throw new Error(`分群標籤應是全名、簡稱、尾段或字元截斷：${l.name} → ${l.text}`);
        if (l.text.endsWith('…') && tail !== short && !ls.some((b) => b !== l && b.text === tail)) throw new Error(`短名放不下時應保留尾段「${tail}」而不是截斷：${l.text}`);
      });
      ls.forEach((a, i) => ls.slice(i + 1).forEach((b) => {
        if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) throw new Error(`分群標籤重疊（縮放 ${k}）：${a.text} / ${b.text}`);
      }));
      if (new Set(ls.map((l) => l.text)).size !== ls.length) throw new Error(`縮短後的分群標籤應兩兩不同（縮放 ${k}）：${ls.map((l) => l.text).join('、')}`);
    });
    if (!total) throw new Error('應畫出分群標籤');
    // 滑過標籤：顯示全名（不受群框寬度限制），蓋在最上層；移開畫布後恢復
    Object.assign(g, base); g.draw();
    const l = g.groupLabels.find((x) => x.text !== x.name) || g.groupLabels[0];
    const mouse = (p) => (winListeners.pointermove || []).forEach((f) => f({ pointerId: 1, pointerType: 'mouse', clientX: p.x, clientY: p.y, target: cv }));
    mouse({ x: (l.x0 + l.x1) / 2, y: (l.y0 + l.y1) / 2 });
    if (g.hoverGroup !== l.name) throw new Error('滑過分群標籤應標記這個分群：' + g.hoverGroup);
    g.draw(); const full = g.groupLabels.find((x) => x.forced);
    if (!full || full.name !== l.name || full.text !== l.name) throw new Error('滑過的分群應顯示全名');
    cv.dispatch('pointerleave', { pointerType: 'mouse' }); if (g.hoverGroup) throw new Error('指標離開畫布後應取消分群的滑過');
    // 滑過群框（不在標籤、節點上）也顯示全名
    const gb = g.groupBoxes.find((x) => x.frame); const corner = g.toScreen({ x: gb.x1 - 2, y: gb.y1 - 2 });
    if (g.hitGroup(corner) !== gb.name) throw new Error('群框內應命中這個分群');
    g.hoverGroup = null; g.draw();
  });
  await step('全圖看得清楚：分群標籤與設備名稱不出畫布、不被工具列蓋住，群框頂邊被蓋住時不標；只有一台的群不畫框也不標（滑過設備才顯示群名）', () => {
    const g = App.graph; const cv = $('#graph'); App.select(null);
    g.computeGroups(); g.fit(); const base = { s: g.s, tx: g.tx, ty: g.ty }; const one0 = (g.groupBoxes || []).filter((b) => b.n === 1);
    [1, 0.5, 2, 4].forEach((k) => {
      Object.assign(g, base); g.zoomAt(k); g.draw(); const v = g.viewport();
      g.groupLabels.forEach((l) => {
        if (l.x0 < 0 || l.x1 > g.w || l.y0 < v.y0 || l.y1 > g.h) throw new Error(`分群標籤應在畫布內、工具列之下（縮放 ${k}）：${l.text} ${Math.round(l.x0)},${Math.round(l.y0)}–${Math.round(l.x1)}，可用上緣 ${Math.round(v.y0)}`);
        // 放大、聚焦後群框頂邊在工具列底下或畫面外時不標（否則標籤貼著工具列、壓在節點與埠名上），滑過群框才顯示
        if (l.box.y0 < v.y0 - 0.5) throw new Error(`群框頂邊被蓋住時不應標分群（縮放 ${k}）：${l.text} 框頂 ${Math.round(l.box.y0)}，可用上緣 ${Math.round(v.y0)}`);
        if (one0.some((b) => b.name === l.name)) throw new Error(`只有一台的群平常不標（看起來像空群）（縮放 ${k}）：${l.text}`);
      });
      g.nodeLabels.forEach((l) => { if (l.x0 < -0.5 || l.x1 > g.w + 0.5) throw new Error(`設備名稱不應超出畫布左右（縮放 ${k}）：${l.text} ${Math.round(l.x0)}–${Math.round(l.x1)}／${g.w}`); });
    });
    Object.assign(g, base); g.draw();
    if (!g.nodeLabels.length) throw new Error('全圖應畫出設備名稱');
    // 滑過連線最多的設備：它的埠名彼此不重疊，也不蓋住設備名稱
    const hub = g.nodes.filter((n) => g.isVisible(n) && !n.box).sort((a, b) => (g.edgesByNode.get(b.id) || []).length - (g.edgesByNode.get(a.id) || []).length)[0];
    const ov = (a, b) => a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5;
    [1, 3].forEach((k) => {
      Object.assign(g, base); g.zoomAt(k); g.hover = { type: 'node', id: hub.id }; g.draw();
      const ps = g.portLabels.filter((p) => p.forced);
      if (!ps.length) throw new Error('滑過設備應畫出它的埠名');
      ps.forEach((a, i) => ps.slice(i + 1).forEach((b) => { if (ov(a, b)) throw new Error(`滑過時埠名不應重疊（縮放 ${k}）：${a.text} / ${b.text}`); }));
      ps.forEach((a) => g.nodeLabels.forEach((b) => { if (ov(a, b)) throw new Error(`滑過時埠名不應蓋住設備名稱（縮放 ${k}）：${a.text} / ${b.text}`); }));
    });
    g.hover = null; Object.assign(g, base); g.draw();
    // 群框照成員數決定：一台不畫框，兩台以上畫框
    const one = (g.groupBoxes || []).filter((b) => b.n === 1);
    if ((g.groupBoxes || []).some((b) => b.frame !== (b.n > 1))) throw new Error('只有一台的群不畫框，其他群要畫框');
    if (!one.length) { if (process.env.SMOKE_INPUT) return; throw new Error('測試前提：範例資料應有只有一台的群'); }
    const ops = recordCanvas(g.ctx, () => g.draw());
    const fills = ops.filter((o) => o.op === 'fill' && o.style === S.view.theme.canvas.group.fill).length;
    if (fills !== g.groupBoxes.length - one.length) throw new Error(`群框數應等於兩台以上的群數：${fills}／${g.groupBoxes.length - one.length}`);
    if (g.groupLabels.some((x) => one.some((b) => b.name === x.name))) throw new Error('只有一台的群平常不標');
    const ob = one[0]; const corner = g.toScreen({ x: ob.x1 - 2, y: ob.y1 - 2 });
    if (g.hitGroup(corner)) throw new Error('沒畫框的群不應以框的範圍命中滑過');
    // 滑過那一台設備時才顯示群名（全名）
    const solo = g.nodes.find((n) => g.isVisible(n) && !n.anchor && (n.group || '') === ob.name); const sp = g.toScreen(g.at(solo.id));
    (winListeners.pointermove || []).forEach((f) => f({ pointerId: 1, pointerType: 'mouse', clientX: sp.x, clientY: sp.y, target: cv }));
    if (g.hoverGroup !== ob.name) throw new Error('滑過只有一台的群的設備應顯示群名：' + g.hoverGroup);
    g.draw(); const shown = g.groupLabels.find((x) => x.name === ob.name);
    if (!shown || !shown.forced || shown.text !== ob.name) throw new Error('滑過只有一台的群的設備應顯示全名');
    cv.dispatch('pointerleave', { pointerType: 'mouse' }); g.draw();
  });
  await step('與多數不同：選多數決的檢查結果時以虛線外圈標出偏離設備；其他選取、清除時清掉，展開與切換層級保留；圖例取自 theme', () => {
    const g = App.graph; const D = S.view.theme.canvas.deviation; const Q = App.Q;
    const row = $('#legend').testAll('.li').find((li) => li.textContent === S.view.DEVIATION_LABEL);
    if (!row || row.getAttribute('title') !== D.tip || !row.all().some((e) => e.getAttribute('data-mark') === 'deviation' && String(e.style.background).includes(D.c))) throw new Error('圖例應有與多數不同（名稱同 V.DEVIATION_LABEL，說明與顏色取自 theme.canvas.deviation）');
    if (D.c === S.view.theme.mark.select || !D.dash.length || !(D.gap > 6)) throw new Error('與多數不同應是與選取不同色、比選取環更外圈的虛線');
    const idx = Q.findings().findIndex((f) => f.deviation && f.deviation.basis === 'majority' && f.deviation.deviating.length);
    if (idx < 0) { if (process.env.SMOKE_INPUT) return; throw new Error('測試前提：範例應有多數決的檢查結果'); }
    const devs = Q.finding(idx).deviation.deviating;
    App.selectFinding(idx);
    if (!g.emphasis || !devs.every((d) => g.emphasis.has(d))) throw new Error('選多數決的檢查結果應標出與多數不同的設備');
    [0.05, 0.5, 2].forEach((s) => { g.s = s; g.draw(); });
    App.select(App.sel, { refresh: true }); if (!g.emphasis) throw new Error('只重新標示（切換層級）時應保留與多數不同');
    App.select({ type: 'device', key: devs[0] }); if (g.emphasis !== null) throw new Error('選其他東西應清除與多數不同');
    App.selectFinding(idx); App.select(null); if (g.emphasis !== null) throw new Error('取消選取應清除與多數不同');
    const tie = Q.findings().findIndex((f) => f.deviation && !f.deviation.deviating.length);
    if (tie >= 0) { App.selectFinding(idx); App.selectFinding(tie); if (g.emphasis !== null) throw new Error('沒有多數時不應標出與多數不同'); }
    const plain = Q.findings().findIndex((f) => !f.deviation && f.entities.length);
    if (plain >= 0) { App.selectFinding(idx); App.selectFinding(plain); if (g.emphasis !== null) throw new Error('沒有 deviation 的檢查結果不應標出與多數不同'); }
    App.select(null); g.fit();
  });
  await step('聚焦：選設備含一跳鄰居且倍率不超過上限；選鏈路聚焦兩端；路由追蹤聚焦去程與回程', () => {
    const g = App.graph; const L = S.view.GraphView.LIMITS; const Q = App.Q;
    const inView = (ids, what) => ids.forEach((id) => {
      const p = g.toScreen(g.at(id));
      if (p.x < 0 || p.x > g.w || p.y < 0 || p.y > g.h) throw new Error(`${what}：${id} 不在可視範圍（${Math.round(p.x)},${Math.round(p.y)}）`);
    });
    const capped = (what) => { if (g.s > L.FOCUS.maxScale + 1e-9) throw new Error(`${what}的聚焦倍率 ${g.s} 超過上限 ${L.FOCUS.maxScale}`); };
    const nb = (id) => (g.edgesByNode.get(id) || []).map((e) => (e.a === id ? e.b : e.a)).filter((m) => g.isVisible(g.nodeById.get(m)));
    const devs = g.nodes.filter((n) => !n.virtual && g.isVisible(n) && nb(n.id).length).sort((a, b) => nb(a.id).length - nb(b.id).length || S.util.natural(a.id, b.id));
    // 1440 寬時圖區約 710×850（左右欄各佔一部分），用同樣的大小核對
    const cv = $('#graph'); const rect = cv.getBoundingClientRect;
    cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 710, height: 850 }); g.resize();
    try {
    if (!(L.FOCUS.minScale > 0 && L.FOCUS.minScale < L.FOCUS.maxScale)) throw new Error('FOCUS.minScale 應介於 0 與 maxScale 之間');
    g.fit(); const sAll = g.s;
    [devs[0], devs[devs.length - 1]].forEach((n) => {
      App.select({ type: 'device', key: n.id }, { focus: true }); capped('選設備');
      // 一定放大到看得清楚：倍率不低於 FOCUS.minScale（全圖已經比它大時不縮小）。鄰居散在整張圖（核心設備）時只聚焦設備本身
      if (g.s < L.FOCUS.minScale - 1e-9) throw new Error(`選設備 ${n.id} 後應放大到至少 ${L.FOCUS.minScale}：${g.s}（全圖 ${sAll}）`);
      inView([n.id], '選設備');
      // 一跳鄰居都在畫面內；否則必須是「只聚焦設備本身」（倍率達上限）
      const out = nb(n.id).filter((id) => { const p = g.toScreen(g.at(id)); return p.x < 0 || p.x > g.w || p.y < 0 || p.y > g.h; });
      if (out.length && g.s < L.FOCUS.maxScale - 1e-9) throw new Error(`選設備 ${n.id} 時鄰居 ${out.join('、')} 不在畫面內，倍率卻沒有放大到上限：${g.s}`);
    });
    // 回歸：鄰居最多的設備（範例的核心路由器）選取後要比全圖放大，鄰居散在整張圖時不能等於沒放大
    if (!process.env.SMOKE_INPUT && sAll < L.FOCUS.minScale) {
      App.select({ type: 'device', key: devs[devs.length - 1].id }, { focus: true });
      if (g.s <= sAll * 1.5) throw new Error(`鄰居最多的設備選取後應放大：${g.s}（全圖 ${sAll}）`);
    }
    // 只聚焦設備本身時往鄰居方向偏移（FOCUS.lean），但寬的節點框（埠很多的 L2 交換器）整個框仍要在畫面內：
    // 暫時把最左邊的節點換成寬框，其他節點當成鄰居（都在右邊），minScale 設為無限大一定走「只聚焦設備本身」
    const vis = g.nodes.filter((n) => !n.virtual && g.isVisible(n)).sort((a, b) => g.at(a.id).x - g.at(b.id).x);
    const wide = vis[0]; const others = vis.slice(1).map((n) => n.id); const hadBox = 'box' in wide; const oldBox = wide.box;
    const restoreBox = () => { if (hadBox) wide.box = oldBox; else delete wide.box; };
    try {
      [{ w: 3000, h: 40 }, { w: 40, h: 3000 }, { w: 3000, h: 3000 }].forEach((box) => {
        wide.box = box;
        const boxIn = () => {
          const p = g.toScreen(g.at(wide.id)); const v = g.viewport();
          const x0 = p.x - (box.w * g.s) / 2; const x1 = p.x + (box.w * g.s) / 2; const y0 = p.y - (box.h * g.s) / 2; const y1 = p.y + (box.h * g.s) / 2;
          return x0 >= v.x0 - 1e-6 && x1 <= v.x1 + 1e-6 && y0 >= v.y0 - 1e-6 && y1 <= v.y1 + 1e-6 ? null : `${Math.round(x0)}..${Math.round(x1)} × ${Math.round(y0)}..${Math.round(y1)}`;
        };
        g.fit([wide.id, ...others], L.FOCUS.pad, L.FOCUS.maxScale, { ids: [wide.id], minScale: Infinity });
        const bad = boxIn(); if (bad) throw new Error(`寬框 ${box.w}×${box.h} 聚焦後應整個在畫面內（710×850）：${bad}`);
      });
      // 小節點仍會往鄰居方向偏（不是一律置中）
      restoreBox();
      g.fit([wide.id, ...others], L.FOCUS.pad, L.FOCUS.maxScale, { ids: [wide.id], minScale: Infinity });
      if (others.length && !(g.toScreen(g.at(wide.id)).x < g.w / 2 - 1)) throw new Error('只聚焦設備本身時應往鄰居的方向偏（鄰居在右邊，設備偏左）');
    } finally { restoreBox(); }
    } finally { cv.getBoundingClientRect = rect; g.resize(); }
    const pair = Array.from(App.pairs.values()).find((p) => !p.virtual && p.links.length);
    const link = Q.getLink(pair.links[0]);
    App.select({ type: 'link', key: link.key }, { focus: true }); capped('選鏈路');
    inView([link.a, link.b].map((ep) => S.keys.splitEp(ep)[0]), '選鏈路的兩端');
    if (process.env.SMOKE_INPUT) { App.select(null); return; }
    // 路由追蹤：找一組去程與回程起點不同的位址，回程的起點也要在畫面內
    const ips = Q.ipEntries().map((x) => x.ip).slice(0, 60); let pick = null;
    for (const a of ips) {
      for (const b of ips) {
        if (a === b) continue; const t = S.trace(Q, a, b); if (!t.ok) continue;
        const r = S.trace(Q, b, a); if (r.ok && r.start && r.start !== t.start) { pick = [a, b]; break; }
      }
      if (pick) break;
    }
    if (!pick) throw new Error('測試前提：應有去程與回程起點不同的追蹤');
    App.openTrace(pick[0], pick[1], ''); $('#trace-run').click();
    const tr = App.sel.result; const back = App.sel.reverse; capped('路由追蹤');
    inView(S.util.uniq([tr.start, ...tr.hops.map((x) => x.dev), ...tr.edges.flat(), back.start, ...back.hops.map((x) => x.dev)]).filter((d) => g.nodeById.has(d)), '路由追蹤的去程與回程');
    App.select(null);
  });
  await step('全圖：扣掉工具列、圖例等覆蓋層佔用的高度；畫布沒有尺寸時延後到有尺寸再套用', () => {
    const g = App.graph; const tb = $('#toolbar'); const lg = $('#legend');
    ['#toolbar', '#legend', '#hint', '#banner'].forEach((s) => { if (!g.occluders.some((o) => o.el === $(s))) throw new Error('全圖應避開覆蓋層：' + s); });
    const old = [tb.getBoundingClientRect, lg.getBoundingClientRect];
    try {
      tb.getBoundingClientRect = () => ({ left: 10, top: 10, width: 220, height: 40 });
      lg.getBoundingClientRect = () => ({ left: 10, top: 760, width: 90, height: 30 });
      g.fit(); const ys = g.nodes.filter((n) => g.isVisible(n)).map((n) => g.toScreen(g.at(n.id)).y);
      if (Math.min(...ys) < 50 || Math.max(...ys) > 760) throw new Error(`全圖應避開工具列（下緣 50）與圖例（上緣 760）：${Math.round(Math.min(...ys))}–${Math.round(Math.max(...ys))}`);
      // 展開的圖例太高（超過 LIMITS.OCCLUDER.max）時不讓出空間，避免圖被壓扁
      lg.getBoundingClientRect = () => ({ left: 10, top: 300, width: 900, height: 490 });
      g.fit(); const ys2 = g.nodes.filter((n) => g.isVisible(n)).map((n) => g.toScreen(g.at(n.id)).y);
      if (Math.max(...ys2) < 400) throw new Error('太高的覆蓋層不應讓出空間');
    } finally { tb.getBoundingClientRect = old[0]; lg.getBoundingClientRect = old[1]; }
    const cv = $('#graph'); const rect = cv.getBoundingClientRect;
    try {
      cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 }); g.resize();
      const before = g.s; g.focus([g.nodes.find((n) => g.isVisible(n)).id]);
      if (g.s !== before || !g.pendingFit) throw new Error('畫布沒有尺寸時應延後聚焦');
    } finally { cv.getBoundingClientRect = rect; g.resize(); }
    if (g.pendingFit || g.s > S.view.GraphView.LIMITS.FOCUS.maxScale + 1e-9) throw new Error('畫布恢復尺寸後應套用延後的聚焦');
    g.fit();
  });
  await step('觸控：雙指以中點縮放並平移、放開一指接著平移且不觸發點選；觸控點擊半徑至少 22px', () => {
    const g = App.graph; const cv = $('#graph'); const L = S.view.GraphView.LIMITS;
    if (L.TOUCH.hitPx < 22) throw new Error('觸控點擊半徑應至少 22px');
    const ev = (id, x, y) => ({ pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y, target: cv, timeStamp: 9000 + id, preventDefault() {} });
    const move = (id, x, y) => (winListeners.pointermove || []).forEach((f) => f(ev(id, x, y)));
    const up = (id, x, y) => (winListeners.pointerup || []).forEach((f) => f(ev(id, x, y)));
    g.fit(); App.select(null); g.zoomTo(0.5, { x: g.w / 2, y: g.h / 2 });
    let clicks = 0; const oldClick = g.handlers.click; g.on('click', () => { clicks++; });
    try {
      const s0 = g.s; const w0 = g.toWorld(600, 400);
      cv.dispatch('pointerdown', ev(11, 550, 400)); cv.dispatch('pointerdown', ev(12, 650, 400));
      move(12, 750, 400); // 兩指距離 100 → 200，中點 600 → 650
      if (Math.abs(g.s - Math.min(L.ZOOM.max, s0 * 2)) > 1e-9) throw new Error(`雙指拉開一倍應放大一倍：${s0} → ${g.s}`);
      const w1 = g.toWorld(650, 400); if (Math.abs(w1.x - w0.x) > 1e-6 || Math.abs(w1.y - w0.y) > 1e-6) throw new Error('雙指縮放時兩指開始時中點下的位置應跟著中點移動');
      up(12, 750, 400); const tx = g.tx; move(11, 590, 400);
      if (Math.abs(g.tx - tx - 40) > 1e-6) throw new Error('放開一指後，剩下的手指應接著平移');
      up(11, 590, 400); if (clicks) throw new Error('雙指操作不應觸發點選');
      // 三指：縮放中加第三指、放開最早的一指，剩下兩指換了一組，縮放倍率不跳（以新的兩指重新開始）
      g.zoomTo(0.5, { x: g.w / 2, y: g.h / 2 });
      cv.dispatch('pointerdown', ev(21, 500, 400)); cv.dispatch('pointerdown', ev(22, 600, 400)); cv.dispatch('pointerdown', ev(23, 900, 400));
      const s1 = g.s; up(21, 500, 400); move(22, 600, 400);
      if (Math.abs(g.s - s1) > 1e-9) throw new Error(`三指放開一指後，倍率不應突變：${s1} → ${g.s}`);
      move(23, 1200, 400); // 新的兩指 300 → 600
      if (Math.abs(g.s - Math.min(L.ZOOM.max, s1 * 2)) > 1e-9) throw new Error(`換一組兩指後應依新的兩指距離縮放：${s1} → ${g.s}`);
      up(22, 600, 400); up(23, 1200, 400); if (clicks) throw new Error('多指操作不應觸發點選');
    } finally { g.on('click', oldClick); }
    // 縮小時，節點在螢幕上很小：觸控仍可在 22px 內點中，滑鼠不行
    g.zoomTo(0.5, { x: g.w / 2, y: g.h / 2 });
    const vis = g.nodes.filter((n) => g.isVisible(n) && !n.box);
    const lone = vis.find((n) => { const p = g.toScreen(g.at(n.id)); return p.x > 40 && p.x < g.w - 40 && vis.every((m) => m === n || Math.hypot(g.toScreen(g.at(m.id)).x - p.x, g.toScreen(g.at(m.id)).y - p.y) > 60); });
    if (!lone) throw new Error('測試前提：應有一個附近沒有其他節點的節點');
    const p = g.toScreen(g.at(lone.id)); const q = { x: p.x + L.TOUCH.hitPx - 1, y: p.y };
    if (g.radius(lone) * g.s + L.TOUCH.slopPx >= L.TOUCH.hitPx - 1) throw new Error('測試前提：節點在螢幕上應小於觸控半徑');
    if (g.hitNode(q, 'touch') !== lone) throw new Error('觸控在 22px 內應點中節點');
    if (g.hitNode(q, 'mouse') === lone) throw new Error('滑鼠的命中範圍不應放大到觸控的大小');
    g.fit();
  });
  await step('直式窄螢幕：內建與分層版面改直長排列', async () => {
    const VA = S.view.app; const g = App.graph; const cv = $('#graph'); const ow = window.innerWidth; const oh = window.innerHeight; const rect = cv.getBoundingClientRect;
    try {
      // 依圖實際的區域判斷：窄螢幕上圖的區域是直的才算；畫布沒有尺寸時看視窗
      window.innerWidth = 390; window.innerHeight = 844;
      cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 600 }); g.resize(); if (!VA.isPortrait()) throw new Error('390×600 的圖區應判定為直式');
      cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 300 }); g.resize(); if (VA.isPortrait()) throw new Error('視窗是直的、圖區是橫的時不應判定為直式');
      cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 }); g.resize(); if (!VA.isPortrait()) throw new Error('畫布沒有尺寸時應看視窗（390×844 是直式）');
      window.innerWidth = 1200; window.innerHeight = 1600; if (VA.isPortrait()) throw new Error('寬螢幕不應判定為直式');
    } finally { window.innerWidth = ow; window.innerHeight = oh; cv.getBoundingClientRect = rect; g.resize(); }
    const gd = VA.graphData(App.Q);
    const ratio = (pos) => { const ps = Array.from(pos.values()); const xs = ps.map((p) => p.x); const ys = ps.map((p) => p.y); return (Math.max(...ys) - Math.min(...ys)) / Math.max(1, Math.max(...xs) - Math.min(...xs)); };
    const land = ratio(S.view.layout.layout(gd.nodes, gd.edges)); const port = ratio(S.view.layout.layout(gd.nodes, gd.edges, { portrait: true }));
    if (!(port > land)) throw new Error(`直式的內建版面應比橫式直長：高寬比 ${land.toFixed(2)} → ${port.toFixed(2)}`);
    // 同一層太多台時折成多列：一台路由器接 30 台交換器（各帶終端），兩種版面的寬高都不應懸殊
    const star = [{ id: 'st-r', label: 'R', kind: 'router', collected: true, group: '' }]; const se = [];
    for (let i = 0; i < 30; i++) {
      star.push({ id: 'st-s' + i, label: 'S' + i, kind: 'switch', collected: true, group: '' }); se.push({ a: 'st-r', b: 'st-s' + i });
      for (let j = 0; j < 3; j++) { star.push({ id: `st-h${i}-${j}`, label: 'h', kind: 'host', collected: false, group: '' }); se.push({ a: 'st-s' + i, b: `st-h${i}-${j}` }); }
    }
    const rowsOf = (pos) => new Set(Array.from({ length: 30 }, (_, i) => Math.round(pos.get('st-s' + i).y))).size;
    const checkWrap = (pos, what, lo, hi) => {
      const r = ratio(pos); const rows = rowsOf(pos);
      if (rows < 2) throw new Error(`${what}：30 台同層的交換器應折成多列`);
      if (!(r >= lo && r <= hi)) throw new Error(`${what}：折行後的高寬比應在 ${lo}–${hi}：${r.toFixed(2)}（${rows} 列）`);
      return rows;
    };
    const rl = checkWrap(S.view.layout.layout(star, se), '內建版面', 0.35, 2);
    const rp = checkWrap(S.view.layout.layout(star, se, { portrait: true }), '內建直式版面', 0.6, 4);
    if (!(rp > rl)) throw new Error(`直式應折成較多列：${rl} → ${rp}`);
    const few = S.view.layout.wrapRows([1, 2, 3], () => 200, () => 100, false);
    if (few.length !== 1) throw new Error('只有幾台的層不應折行');
    const opt = { radius: (n) => g.radius(n) };
    const es = await S.view.layout.elk(star, se, opt); const esp = await S.view.layout.elk(star, se, Object.assign({ portrait: true }, opt));
    checkWrap(es.pos, '分層版面', 0.35, 2); checkWrap(esp.pos, '分層直式版面', 0.6, 4);
    if (process.env.SMOKE_INPUT) return; // 大型網路超過分層版面上限，不在這裡重算
    const e0 = await S.view.layout.elk(gd.nodes, gd.edges, opt); const e1 = await S.view.layout.elk(gd.nodes, gd.edges, Object.assign({ portrait: true }, opt));
    if (Array.from(e1.pos.values()).some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)) || e1.pos.size !== e0.pos.size) throw new Error('直式的分層版面每個節點都應有座標');
    if (!(ratio(e1.pos) > ratio(e0.pos))) throw new Error(`直式的分層版面應比橫式直長：${ratio(e0.pos).toFixed(2)} → ${ratio(e1.pos).toFixed(2)}`);
  });
  await step('廠商色最多 theme 的色數：依終端數量取前幾名，其餘歸「其他」，圖例列出同樣的對應', () => {
    const EP = S.view.theme.endpoint; const g = App.graph; const old = EP.vendor;
    const check = () => {
      const ends = g.nodes.filter((n) => n.kind === 'endpoint');
      if (App.vendorColors.size > EP.vendor.length) throw new Error('廠商色不應超過 theme 的色數');
      ends.forEach((n) => { const want = (n.vendor && App.vendorColors.get(n.vendor)) || EP.vendorFallback; if (n.color !== want) throw new Error('終端顏色應依廠商排名或歸「其他」：' + n.id); });
      const shown = document.testAll('#legend .lg-vendor').map((li) => li.textContent);
      if (shown.join('|') !== Array.from(App.vendorColors.keys()).join('|')) throw new Error('圖例的廠商應與畫面上的廠商色一致');
      return ends;
    };
    const ends = check(); if (process.env.SMOKE_INPUT) return; // 大型網路全部收合，沒有個別終端
    const vendors = S.util.uniq(ends.map((n) => n.vendor).filter(Boolean));
    if (vendors.length < 2) throw new Error('範例資料應有兩個以上廠商的終端');
    try {
      EP.vendor = old.slice(0, 1); App.toggleExpand('TPE_ACC_SW_01'); App.toggleExpand('TPE_ACC_SW_01');
      check();
      if (App.vendorColors.size !== 1 || !App.vendorOthers) throw new Error('超過色數的廠商應歸「其他」');
      if (!g.nodes.some((n) => n.kind === 'endpoint' && n.vendor && n.color === EP.vendorFallback)) throw new Error('排名之外的廠商應使用 vendorFallback');
      if (!text('#legend').includes(`其他廠商（${App.vendorOthers} 家）`)) throw new Error('圖例應註明歸為其他的廠商數');
    } finally { EP.vendor = old; App.toggleExpand('TPE_ACC_SW_01'); App.toggleExpand('TPE_ACC_SW_01'); }
    check();
  });
};
