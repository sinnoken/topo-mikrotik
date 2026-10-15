/*
 * 拓樸圖（自寫 Canvas 繪圖，不依賴外部函式庫，可離線使用）。
 *  - 平移（拖背景）、縮放（滾輪）、拖曳節點、點選節點／連線、滑過提示
 *  - 依縮放程度決定是否畫標籤與埠名，只畫畫面內的物件（1000 台以上仍流暢）
 * 資料：nodes [{id,label,kind,collected,group,sev}]、edges [{id,a,b,cls,layer,count,sev,hearsay,mismatch,labelA,labelB}]
 */
(function (S) {
  'use strict';
  const V = (S.view = S.view || {});
  const T = V.theme; const KIND_COLOR = T.kind; const EDGE = T.edge; const SEV_COLOR = T.sev; const MARK = T.mark; const ALPHA = T.alpha;
  const EP = T.endpoint; const WEAK = T.weakEdge; const CV = T.canvas;

  class GraphView {
    constructor(canvas) {
      this.cv = canvas; this.ctx = canvas.getContext('2d');
      this.nodes = []; this.edges = []; this.pos = new Map(); this.nodeById = new Map();
      this.s = 1; this.tx = 0; this.ty = 0; this.dirty = true;
      this.sel = { nodes: new Set(), edges: new Set() };
      this.hl = null; // { nodes: Map(id→color), edges: Map(id→color) }
      this.overlay = []; // [{a,b,color,label}]
      this.hover = null; this.handlers = {}; this.visible = () => true; this.showGroups = true;
      this._bind(); this._loop();
      new ResizeObserver(() => this.resize()).observe(canvas);
      this.resize();
    }
    on(ev, fn) { this.handlers[ev] = fn; }
    emit(ev, arg) { if (this.handlers[ev]) this.handlers[ev](arg); }
    resize() {
      const r = this.cv.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
      this.w = r.width; this.h = r.height; this.cv.width = Math.max(1, r.width * dpr); this.cv.height = Math.max(1, r.height * dpr);
      this.dpr = dpr; this.dirty = true;
    }
    setData(nodes, edges, pos) {
      this.nodes = nodes; this.edges = edges; this.pos = pos; this.nodeById = new Map(nodes.map((n) => [n.id, n]));
      this.edgesByNode = new Map(); edges.forEach((e) => { [e.a, e.b].forEach((x) => S.util.getOr(this.edgesByNode, x, () => []).push(e)); });
      this.dirty = true;
    }
    setVisible(fn) { this.visible = fn; this.dirty = true; }
    setSelection(nodes, edges) { this.sel = { nodes: new Set(nodes || []), edges: new Set(edges || []) }; this.dirty = true; }
    setHighlight(h) { this.hl = h; this.dirty = true; }
    setOverlay(o) { this.overlay = o || []; this.dirty = true; }
    redraw() { this.dirty = true; }

    // ---------------- 座標
    toScreen(p) { return { x: p.x * this.s + this.tx, y: p.y * this.s + this.ty }; }
    toWorld(x, y) { return { x: (x - this.tx) / this.s, y: (y - this.ty) / this.s }; }
    fit(ids, pad) {
      const list = (ids && ids.length ? ids : this.nodes.filter((n) => this.visible(n)).map((n) => n.id)).map((id) => this.pos.get(id)).filter(Boolean);
      if (!list.length) return;
      const xs = list.map((p) => p.x); const ys = list.map((p) => p.y);
      const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
      const p = pad == null ? 60 : pad;
      const s = Math.min((this.w - p * 2) / Math.max(maxX - minX, 1), (this.h - p * 2) / Math.max(maxY - minY, 1));
      this.s = Math.max(0.03, Math.min(list.length === 1 ? 1.6 : 2.2, s));
      this.tx = this.w / 2 - ((minX + maxX) / 2) * this.s; this.ty = this.h / 2 - ((minY + maxY) / 2) * this.s;
      this.dirty = true;
    }
    focus(ids) { this.fit(ids, Math.min(this.w, this.h) * (ids.length > 1 ? 0.1 : 0.25)); }

    // ---------------- 互動
    _bind() {
      const cv = this.cv; let drag = null;
      const at = (ev) => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
      cv.addEventListener('wheel', (ev) => {
        ev.preventDefault(); const p = at(ev); const f = Math.exp(-ev.deltaY * 0.0015);
        const ns = Math.max(0.02, Math.min(6, this.s * f)); const w = this.toWorld(p.x, p.y);
        this.s = ns; this.tx = p.x - w.x * ns; this.ty = p.y - w.y * ns; this.dirty = true;
      }, { passive: false });
      cv.addEventListener('mousedown', (ev) => {
        const p = at(ev); const n = this.hitNode(p);
        drag = { start: p, last: p, node: n, moved: false };
        cv.classList.add('dragging');
      });
      window.addEventListener('mousemove', (ev) => {
        const p = at(ev);
        if (!drag) {
          const n = this.hitNode(p); const e = n ? null : this.hitEdge(p);
          const hv = n ? { type: 'node', id: n.id } : e ? { type: 'edge', id: e.id } : null;
          if (JSON.stringify(hv) !== JSON.stringify(this.hover)) { this.hover = hv; this.dirty = true; this.emit('hover', { item: hv, x: p.x, y: p.y }); }
          else if (hv) this.emit('hover', { item: hv, x: p.x, y: p.y });
          return;
        }
        if (Math.abs(p.x - drag.start.x) + Math.abs(p.y - drag.start.y) > 3) drag.moved = true;
        if (drag.node) { const w = this.toWorld(p.x, p.y); this.pos.set(drag.node.id, w); }
        else { this.tx += p.x - drag.last.x; this.ty += p.y - drag.last.y; }
        drag.last = p; this.dirty = true;
      });
      window.addEventListener('mouseup', (ev) => {
        if (!drag) return; cv.classList.remove('dragging');
        const d = drag; drag = null;
        if (d.moved) { if (d.node) this.emit('moved', d.node.id); return; }
        if (ev.target !== cv) return;
        const p = at(ev); const n = this.hitNode(p);
        if (n) return this.emit('click', { type: 'node', id: n.id, shift: ev.shiftKey || ev.ctrlKey });
        const e = this.hitEdge(p);
        if (e) return this.emit('click', { type: 'edge', id: e.id });
        this.emit('click', null);
      });
      cv.addEventListener('dblclick', (ev) => { const n = this.hitNode(at(ev)); if (n) this.emit('dblclick', { type: 'node', id: n.id }); });
      cv.addEventListener('mouseleave', () => { if (this.hover) { this.hover = null; this.dirty = true; this.emit('hover', { item: null }); } });
    }
    radius(n) {
      if (n.kind === 'endpoint') return 7; if (n.kind === 'cluster') return 12; if (n.kind === 'downstream') return 9;
      return n.kind === 'host' ? 6 : n.collected ? 13 : 9;
    }
    hitNode(p) {
      const w = this.toWorld(p.x, p.y); let best = null; let bd = Infinity;
      for (const n of this.nodes) {
        if (!this.visible(n)) continue; const q = this.pos.get(n.id); if (!q) continue;
        const d = Math.hypot(q.x - w.x, q.y - w.y); const r = this.radius(n) + 4 / this.s;
        if (d < r && d < bd) { best = n; bd = d; }
      }
      return best;
    }
    hitEdge(p) {
      const w = this.toWorld(p.x, p.y); const tol = 6 / this.s; let best = null; let bd = tol;
      for (const e of this.edges) {
        if (!this._edgeVisible(e)) continue;
        const a = this.pos.get(e.a); const b = this.pos.get(e.b); if (!a || !b) continue;
        const d = segDist(w, a, b); if (d < bd) { bd = d; best = e; }
      }
      return best;
    }
    _edgeVisible(e) { const a = this.nodeById.get(e.a); const b = this.nodeById.get(e.b); return a && b && this.visible(a) && this.visible(b); }

    // ---------------- 繪圖
    _loop() { const tick = () => { if (this.dirty) { this.dirty = false; this.draw(); } requestAnimationFrame(tick); }; requestAnimationFrame(tick); }
    draw() {
      const c = this.ctx; c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); c.clearRect(0, 0, this.w, this.h);
      if (!this.nodes.length) return;
      const s = this.s; const view = { x0: -this.tx / s - 50, y0: -this.ty / s - 50, x1: (this.w - this.tx) / s + 50, y1: (this.h - this.ty) / s + 50 };
      const inView = (p) => p && p.x > view.x0 && p.x < view.x1 && p.y > view.y0 && p.y < view.y1;
      const hl = this.hl; const dim = hl && (hl.nodes.size || hl.edges.size);
      const hoverN = this.hover && this.hover.type === 'node' ? this.hover.id : null;
      const hoverE = this.hover && this.hover.type === 'edge' ? this.hover.id : null;
      const hoverAdj = new Set(); if (hoverN) (this.edgesByNode.get(hoverN) || []).forEach((e) => hoverAdj.add(e.id));
      c.save(); c.translate(this.tx, this.ty); c.scale(s, s);

      // 分群底色
      if (this.showGroups && this.groupBoxes) {
        this.groupBoxes.forEach((g) => {
          c.fillStyle = CV.group.fill; c.strokeStyle = CV.group.stroke; c.lineWidth = 1 / s;
          roundRect(c, g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0, 18); c.fill(); c.stroke();
          if (s > 0.04) { const gf = 13 / s; c.fillStyle = CV.group.text; c.font = `600 ${gf}px "Microsoft JhengHei", sans-serif`; c.fillText(g.name, g.x0 + 4 / s, g.y0 - 5 / s); }
        });
      }

      // 連線
      const drawEdge = (e, override) => {
        const a = this.pos.get(e.a); const b = this.pos.get(e.b); if (!a || !b) return;
        if (!inView(a) && !inView(b) && !segInView(a, b, view)) return;
        const st = EDGE[e.cls] || EDGE.other; let col = st.c; let w = st.w * (e.count > 1 ? 1.25 : 1); let alpha = e.domainOnly ? WEAK.domainOnly.alpha : e.hearsay ? WEAK.hearsay.alpha : 1;
        if (e.ifStyle) col = e.ifStyle.c;
        const hc = hl && hl.edges.get(e.id);
        if (dim && !hc && !override) alpha = ALPHA.dimEdge;
        if (hc) { col = hc; w = Math.max(w, 3.5, 2.5 / s); }
        if (override) { col = override; w = Math.max(w, 3.5, 2.5 / s); alpha = 1; }
        c.globalAlpha = alpha; c.strokeStyle = col; c.lineWidth = Math.max(w, 0.8 / s);
        const dash = e.domainOnly ? WEAK.domainOnly.dash : st.dash || (e.hearsay ? WEAK.hearsay.dash : null);
        c.setLineDash(dash ? dash.map((d) => d / Math.min(s, 1)) : []);
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); c.setLineDash([]);
        if (e.sev && !dim && !override) { // 有問題的連線：中點標記
          const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
          c.fillStyle = SEV_COLOR[e.sev] || CV.sevFallback; c.beginPath(); c.arc(mx, my, Math.max(4, 3 / s), 0, Math.PI * 2); c.fill();
        }
        c.globalAlpha = 1;
      };
      for (const e of this.edges) { if (this._edgeVisible(e)) drawEdge(e); }
      // 選取／滑過的連線最後畫，蓋在上面
      for (const e of this.edges) {
        if (!this._edgeVisible(e)) continue;
        if (this.sel.edges.has(e.id)) drawEdge(e, MARK.select);
        else if (e.id === hoverE || hoverAdj.has(e.id)) drawEdge(e, MARK.hover);
      }
      // 疊加路徑（路由追蹤）
      this.overlay.forEach((o) => {
        const a = this.pos.get(o.a); const b = this.pos.get(o.b); if (!a || !b) return;
        c.strokeStyle = o.color || MARK.trace; c.lineWidth = Math.max(6, 4 / s); c.globalAlpha = ALPHA.overlay;
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); arrow(c, a, b, Math.max(14, 10 / s), o.color || MARK.trace); c.globalAlpha = 1;
      });

      // 節點
      const portLabels = s > 1.25;
      for (const n of this.nodes) {
        if (!this.visible(n)) continue; const p = this.pos.get(n.id); if (!inView(p)) continue;
        const r = this.radius(n); const col = KIND_COLOR[n.kind] || KIND_COLOR.unknown;
        const hcol = hl && hl.nodes.get(n.id);
        c.globalAlpha = dim && !hcol && !this.sel.nodes.has(n.id) ? ALPHA.dimNode : 1;
        drawShape(c, n, p, r, col, s);
        if (hcol) { c.strokeStyle = hcol; c.lineWidth = 3.5; c.beginPath(); c.arc(p.x, p.y, r + 5, 0, Math.PI * 2); c.stroke(); }
        if (this.sel.nodes.has(n.id)) { c.strokeStyle = MARK.select; c.lineWidth = 3; c.beginPath(); c.arc(p.x, p.y, r + 6, 0, Math.PI * 2); c.stroke(); }
        if (n.sev && r > 7) { c.fillStyle = SEV_COLOR[n.sev]; c.strokeStyle = CV.outline; c.lineWidth = 1.5; c.beginPath(); c.arc(p.x + r * 0.8, p.y - r * 0.8, 4.5, 0, Math.PI * 2); c.fill(); c.stroke(); }
        c.globalAlpha = 1;
      }
      // 標籤：依重要性排序，與已畫的標籤重疊就略過（避免縮小時糊成一片）
      const RANKL = { firewall: 0, router: 1, switch: 2, unknown: 3, host: 4, cluster: 5, downstream: 5, endpoint: 6 };
      const cand = [];
      for (const n of this.nodes) {
        if (!this.visible(n)) continue; const p = this.pos.get(n.id); if (!inView(p)) continue;
        const forced = this.sel.nodes.has(n.id) || n.id === hoverN;
        const marked = hl && hl.nodes.has(n.id);
        if (!forced && !marked && (n.kind === 'host' || n.kind === 'endpoint' || n.kind === 'downstream') && s < 0.9) continue;
        if (!forced && !marked && n.kind === 'cluster' && s < 0.45) continue;
        if (!forced && !marked && s < 0.18) continue;
        cand.push({ n, p, pri: forced ? -1 : (marked ? 0 : 10) + (n.collected ? 0 : 5) + (RANKL[n.kind] ?? 3) });
      }
      cand.sort((a, b) => a.pri - b.pri);
      const fs = Math.max(9, Math.min(13, 12 * s)) / s; const placed = [];
      c.textAlign = 'center';
      for (const { n, p, pri } of cand) {
        c.font = `${n.collected ? 600 : 400} ${fs}px "Microsoft JhengHei", sans-serif`;
        const tw = c.measureText(n.label).width; const r = this.radius(n);
        const box = { x0: p.x - tw / 2 - fs * 0.3, x1: p.x + tw / 2 + fs * 0.3, y0: p.y + r + fs * 0.2, y1: p.y + r + fs * 1.5 };
        if (pri >= 0 && placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
        placed.push(box);
        c.globalAlpha = dim && pri >= 10 ? ALPHA.dimLabel : 1;
        c.fillStyle = CV.label.bg; c.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
        c.fillStyle = n.collected ? CV.label.text : CV.label.textUncollected; c.fillText(n.label, p.x, box.y1 - fs * 0.32);
      }
      c.textAlign = 'left'; c.globalAlpha = 1;
      // 埠名
      if (portLabels) {
        c.font = '10px Consolas, monospace';
        const order = this.edges.filter((e) => this._edgeVisible(e)).sort((x, y) => (this.sel.edges.has(y.id) ? 1 : 0) - (this.sel.edges.has(x.id) ? 1 : 0));
        for (const e of order) {
          const a = this.pos.get(e.a); const b = this.pos.get(e.b);
          if (!a || !b || (!inView(a) && !inView(b))) continue;
          if (e.labelA) portLabel(c, a, b, e.labelA, this.radius(this.nodeById.get(e.a)) + 26, placed);
          if (e.labelB) portLabel(c, b, a, e.labelB, this.radius(this.nodeById.get(e.b)) + 26, placed);
        }
      }
      c.restore();
    }
    computeGroups() {
      const boxes = new Map();
      this.nodes.forEach((n) => {
        if (!this.visible(n)) return; const p = this.pos.get(n.id); if (!p) return;
        const g = S.util.getOr(boxes, n.group || '', () => ({ name: n.group || '', x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 }));
        g.x0 = Math.min(g.x0, p.x - 50); g.y0 = Math.min(g.y0, p.y - 50); g.x1 = Math.max(g.x1, p.x + 50); g.y1 = Math.max(g.y1, p.y + 40); g.n++;
      });
      this.groupBoxes = boxes.size > 1 ? Array.from(boxes.values()).filter((g) => g.n > 0) : null;
      this.dirty = true;
    }
  }

  function drawShape(c, n, p, r, col, s) {
    if (n.virtual) return drawVirtual(c, n, p, r, s);
    c.lineWidth = 2;
    const fill = n.collected ? col : CV.uncollectedFill;
    c.fillStyle = fill; c.strokeStyle = n.collected ? shade(col) : col;
    if (!n.collected) c.setLineDash(EP.dash);
    c.beginPath();
    const shape = T.shape[n.kind] || 'circle';
    if (shape === 'shield') { // 盾牌
      c.moveTo(p.x, p.y - r); c.lineTo(p.x + r, p.y - r * 0.55); c.quadraticCurveTo(p.x + r * 0.9, p.y + r * 0.6, p.x, p.y + r);
      c.quadraticCurveTo(p.x - r * 0.9, p.y + r * 0.6, p.x - r, p.y - r * 0.55); c.closePath();
    } else if (shape === 'wide') roundRect(c, p.x - r * 1.25, p.y - r * 0.75, r * 2.5, r * 1.5, 4);
    else if (shape === 'square') roundRect(c, p.x - r, p.y - r, r * 2, r * 2, 2);
    else c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.fill(); c.stroke(); c.setLineDash([]);
    if (!n.collected || r < 9) return;
    c.strokeStyle = CV.outline; c.lineWidth = 1.6; c.beginPath();
    if (n.kind === 'switch') { for (let i = -2; i <= 2; i++) { c.moveTo(p.x + i * r * 0.38, p.y - r * 0.2); c.lineTo(p.x + i * r * 0.38, p.y + r * 0.3); } }
    else if (n.kind === 'router') { c.moveTo(p.x - r * 0.5, p.y); c.lineTo(p.x + r * 0.5, p.y); c.moveTo(p.x, p.y - r * 0.5); c.lineTo(p.x, p.y + r * 0.5); }
    else if (n.kind === 'firewall') { c.moveTo(p.x - r * 0.45, p.y - r * 0.15); c.lineTo(p.x + r * 0.45, p.y - r * 0.15); c.moveTo(p.x - r * 0.45, p.y + r * 0.25); c.lineTo(p.x + r * 0.45, p.y + r * 0.25); c.moveTo(p.x, p.y - r * 0.15); c.lineTo(p.x, p.y + r * 0.25); }
    c.stroke();
  }
  /** 未知對端（由 MAC 推論出來、基準裡沒有 LLDP 鄰居的東西）：外觀刻意和已知設備不同 */
  function drawVirtual(c, n, p, r, s) {
    if (n.kind === 'endpoint') { // 單一 MAC：圓形，顏色依廠商，近看顯示廠商縮寫
      c.fillStyle = n.color || EP.vendorFallback; c.strokeStyle = CV.outline; c.lineWidth = 1.5;
      c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fill(); c.stroke();
      if (s > 1.3 && n.ini) { c.fillStyle = CV.outline; c.font = 'bold 7px sans-serif'; c.textAlign = 'center'; c.fillText(n.ini, p.x, p.y + 2.6); c.textAlign = 'left'; }
    } else if (n.kind === 'downstream') { // 一個埠學到多個 MAC：菱形，疑似下游還有設備
      c.fillStyle = n.ifStyle ? n.ifStyle.fill : EP.downstream.fill; c.strokeStyle = n.ifStyle ? n.ifStyle.c : EP.downstream.stroke; c.lineWidth = 2; c.setLineDash(EP.dash);
      c.beginPath(); c.moveTo(p.x, p.y - r); c.lineTo(p.x + r, p.y); c.lineTo(p.x, p.y + r); c.lineTo(p.x - r, p.y); c.closePath(); c.fill(); c.stroke(); c.setLineDash([]);
      if (s > 0.9) { c.fillStyle = n.ifStyle ? n.ifStyle.c : EP.downstream.text; c.font = 'bold 8px sans-serif'; c.textAlign = 'center'; c.fillText(String(n.count || ''), p.x, p.y + 3); c.textAlign = 'left'; }
    } else { // cluster：同一台設備上很多末端，收合成一個
      c.fillStyle = EP.cluster.fill; c.strokeStyle = EP.cluster.stroke; c.lineWidth = 1.5;
      roundRect(c, p.x - r * 1.3, p.y - r * 0.8, r * 2.6, r * 1.6, 5); c.fill(); c.stroke();
      if (s > 0.35) { c.fillStyle = EP.cluster.text; c.font = 'bold 9px sans-serif'; c.textAlign = 'center'; c.fillText('×' + (n.count || ''), p.x, p.y + 3.2); c.textAlign = 'left'; }
    }
  }
  function portLabel(c, from, to, text, dist, placed) {
    const len = Math.hypot(to.x - from.x, to.y - from.y); if (len < dist * 2.2) return;
    const x = from.x + ((to.x - from.x) / len) * dist; const y = from.y + ((to.y - from.y) / len) * dist;
    const tw = c.measureText(text).width;
    const box = { x0: x - tw / 2 - 3, x1: x + tw / 2 + 3, y0: y - 7, y1: y + 6 };
    if (placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) return;
    placed.push(box);
    c.fillStyle = CV.port.bg; c.strokeStyle = CV.port.border; c.lineWidth = 0.6;
    roundRect(c, x - tw / 2 - 3, y - 7, tw + 6, 13, 3); c.fill(); c.stroke();
    c.fillStyle = CV.port.text; c.textAlign = 'center'; c.fillText(text, x, y + 3.5); c.textAlign = 'left';
  }
  function arrow(c, a, b, size, col) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x); const mx = a.x + (b.x - a.x) * 0.6; const my = a.y + (b.y - a.y) * 0.6;
    c.fillStyle = col; c.beginPath(); c.moveTo(mx + Math.cos(ang) * size, my + Math.sin(ang) * size);
    c.lineTo(mx + Math.cos(ang + 2.5) * size, my + Math.sin(ang + 2.5) * size); c.lineTo(mx + Math.cos(ang - 2.5) * size, my + Math.sin(ang - 2.5) * size); c.closePath(); c.fill();
  }
  function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function shade(hex) { const n = parseInt(hex.slice(1), 16); const f = (v) => Math.max(0, Math.floor(v * 0.75)); return '#' + ((f(n >> 16) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255)).toString(16).padStart(6, '0'); }
  function segDist(p, a, b) {
    const dx = b.x - a.x; const dy = b.y - a.y; const l2 = dx * dx + dy * dy; if (!l2) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2; t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function segInView(a, b, v) { return !(Math.max(a.x, b.x) < v.x0 || Math.min(a.x, b.x) > v.x1 || Math.max(a.y, b.y) < v.y0 || Math.min(a.y, b.y) > v.y1); }

  V.GraphView = GraphView;
})(globalThis.SSOT = globalThis.SSOT || {});
