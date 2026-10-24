/*
 * 拓樸圖（自寫 Canvas 繪圖，不依賴外部函式庫，可離線使用）。
 *  - 平移（拖背景）、縮放（滾輪）、拖曳節點、點選節點／連線、滑過提示；滑鼠、觸控與觸控筆共用 pointer 事件
 *  - 鍵盤：畫布可取得焦點，N／Shift+N 輪流移到設備、Enter 開詳情、Esc 取消選取、方向鍵平移、+／- 縮放、0 全圖
 *  - 依縮放程度決定是否畫標籤與埠名，只畫畫面內的物件（1000 台以上仍流暢）
 * 資料：nodes [{id,label,kind,collected,group,sev}]、edges [{id,a,b,cls,layer,count,sev,hearsay,mismatch,labelA,labelB}]
 * L2 埠圖與 L3 子網圖（app-layers.js）另用：
 *  - node.box { w, h }：容器框（L2 的設備）或長條（L3 的子網，kind 'subnet'），命中範圍與標示環是矩形
 *  - node.anchor { parent, dx, dy }：位置跟著 parent（L2 的埠）；pos 不存它，拖曳它等於拖曳 parent
 *  - edge.style { c, w, dash }：取代依 cls 的連線樣式；edge.arrow：在 b 端附近畫箭頭（L3 的路由）
 *  - 高亮 hl.edges 的值可以是顏色，或 { c, dash, alpha, sev }（VLAN 承載：線型與中點外形，不只靠顏色）
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
      this.hover = null; this.kbd = null; this.handlers = {}; this.visible = () => true; this.showGroups = true;
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
      // 掛在容器上的節點（L2 的埠）：滑過容器時一起標出它們的連線，鍵盤 N 依容器、再依它的埠輪流
      this.childrenOf = new Map(); nodes.forEach((n) => { if (n.anchor) S.util.getOr(this.childrenOf, n.anchor.parent, () => []).push(n); });
      this.dirty = true;
    }
    /** 節點的世界座標：掛在容器上的節點（anchor）是容器的位置加上偏移，其他取 pos */
    at(id) {
      const n = this.nodeById.get(id);
      if (n && n.anchor) { const p = this.pos.get(n.anchor.parent); return p ? { x: p.x + n.anchor.dx, y: p.y + n.anchor.dy } : null; }
      return this.pos.get(id);
    }
    /** 可見：通過 visible 篩選，掛在容器上的節點另要容器可見 */
    isVisible(n) {
      if (!this.visible(n)) return false;
      if (!n.anchor) return true;
      const p = this.nodeById.get(n.anchor.parent); return !!p && this.visible(p);
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
      // 容器框（box）以四個角計算，整個框才會在畫面內
      const list = (ids && ids.length ? ids : this.nodes.filter((n) => this.isVisible(n)).map((n) => n.id)).flatMap((id) => {
        const p = this.at(id); const n = this.nodeById.get(id); if (!p) return [];
        return n && n.box ? [{ x: p.x - n.box.w / 2, y: p.y - n.box.h / 2 }, { x: p.x + n.box.w / 2, y: p.y + n.box.h / 2 }] : [p];
      });
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
    // 指標事件（pointer）同時處理滑鼠、觸控與觸控筆；滑鼠行為與原本相同（拖背景平移、拖節點、點選、雙擊）。
    // 觸控沒有 hover：點一下選取，快速點兩下等同雙擊；觸控的命中範圍較大。
    _bind() {
      const cv = this.cv; let drag = null; let lastTap = null;
      const at = (ev) => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
      const mine = (ev) => drag && (ev.pointerId == null || drag.id == null || ev.pointerId === drag.id);
      cv.addEventListener('wheel', (ev) => {
        ev.preventDefault(); const p = at(ev); this.zoomAt(Math.exp(-ev.deltaY * 0.0015), p);
      }, { passive: false });
      cv.addEventListener('pointerdown', (ev) => {
        const type = ev.pointerType || 'mouse';
        if (type === 'mouse' && ev.button) return; // 只用主按鍵
        const p = at(ev); const n = this.hitNode(p, type);
        // 拖曳掛在容器上的節點（埠）等於拖曳容器；記下指標與節點中心的差，大的容器才不會跳到指標位置
        const target = n && n.anchor ? this.nodeById.get(n.anchor.parent) : n;
        const w = this.toWorld(p.x, p.y); const c = target ? this.at(target.id) : null;
        drag = { id: ev.pointerId, type, start: p, last: p, node: n, target, off: c ? { x: w.x - c.x, y: w.y - c.y } : null, moved: false };
        cv.classList.add('dragging');
        if (cv.setPointerCapture && ev.pointerId != null) { try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* 指標已不存在：仍以 window 事件追蹤 */ } }
      });
      window.addEventListener('pointermove', (ev) => {
        const p = at(ev);
        if (!drag) {
          if (ev.pointerType === 'touch') return;
          // 只有指標直接在畫布上才做 hover；在左右欄、工具列、圖例等上面時不可穿透到底下（或畫面外）的節點
          const n = ev.target === cv ? this.hitNode(p) : null; const e = n || ev.target !== cv ? null : this.hitEdge(p);
          const hv = n ? { type: 'node', id: n.id } : e ? { type: 'edge', id: e.id } : null;
          if (JSON.stringify(hv) !== JSON.stringify(this.hover)) { this.hover = hv; this.dirty = true; this.emit('hover', { item: hv, x: p.x, y: p.y }); }
          else if (hv) this.emit('hover', { item: hv, x: p.x, y: p.y });
          return;
        }
        if (!mine(ev)) return;
        if (Math.abs(p.x - drag.start.x) + Math.abs(p.y - drag.start.y) > (drag.type === 'mouse' ? 3 : 8)) drag.moved = true;
        if (!drag.moved) return;
        if (drag.target) { const w = this.toWorld(p.x, p.y); this.pos.set(drag.target.id, { x: w.x - drag.off.x, y: w.y - drag.off.y }); }
        else { this.tx += p.x - drag.last.x; this.ty += p.y - drag.last.y; }
        drag.last = p; this.dirty = true;
      });
      const end = (ev, cancelled) => {
        if (!mine(ev)) return; cv.classList.remove('dragging');
        const d = drag; drag = null;
        if (d.moved) { if (d.target) this.emit('moved', d.target.id); return; }
        if (cancelled || ev.target !== cv) return;
        const p = at(ev); const n = this.hitNode(p, d.type);
        if (n) {
          if (d.type !== 'mouse') { // 觸控：同一個節點快速點兩下等同雙擊（滑鼠由瀏覽器的 dblclick 處理）
            const twice = lastTap && lastTap.id === n.id && ev.timeStamp - lastTap.t < 400;
            lastTap = twice ? null : { id: n.id, t: ev.timeStamp };
            if (twice) return this.emit('dblclick', { type: 'node', id: n.id });
          }
          return this.emit('click', { type: 'node', id: n.id, shift: ev.shiftKey || ev.ctrlKey });
        }
        const e = this.hitEdge(p, d.type);
        if (e) return this.emit('click', { type: 'edge', id: e.id });
        this.emit('click', null);
      };
      window.addEventListener('pointerup', (ev) => end(ev, false));
      window.addEventListener('pointercancel', (ev) => end(ev, true));
      cv.addEventListener('dblclick', (ev) => { const n = this.hitNode(at(ev)); if (n) this.emit('dblclick', { type: 'node', id: n.id }); });
      cv.addEventListener('pointerleave', (ev) => { if (ev.pointerType !== 'touch' && this.hover && !this.kbd) { this.hover = null; this.dirty = true; this.emit('hover', { item: null }); } });
      cv.addEventListener('keydown', (ev) => this._key(ev));
    }
    /**
     * 鍵盤（畫布取得焦點時）：N／Shift+N 依畫面位置輪流移到下一台／上一台設備（以滑過的樣式標示並顯示提示），
     * Enter 選取並開啟詳情、Shift+Enter 聚焦（同雙擊）、Esc 取消選取、方向鍵平移（Shift 加大）、+／- 縮放、0 全圖。
     */
    _key(ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const k = ev.key; const step = ev.shiftKey ? 240 : 60;
      const pan = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[k];
      if (pan) { this.tx += pan[0]; this.ty += pan[1]; this.dirty = true; }
      else if (k === '+' || k === '=') this.zoomAt(1.25);
      else if (k === '-' || k === '_') this.zoomAt(0.8);
      else if (k === '0') this.fit();
      else if (k === 'n' || k === 'N') this.cycle(k === 'N' || ev.shiftKey ? -1 : 1);
      else if (k === 'Enter' || k === ' ') {
        if (!this.kbd || !this.nodeById.has(this.kbd)) return;
        this.emit(ev.shiftKey ? 'dblclick' : 'click', { type: 'node', id: this.kbd });
      } else if (k === 'Escape') { this.kbd = null; this.hover = null; this.dirty = true; this.emit('hover', { item: null }); this.emit('click', null); }
      else return;
      ev.preventDefault();
    }
    /** 依畫面上的位置（由上而下、由左而右）輪流移到下一台可見的設備；移出畫面時平移到中央 */
    cycle(dir) {
      // 容器依畫面位置排序，每個容器後面接著它的埠（依框上的位置）：L2 的埠也走得到
      const top = this.nodes.filter((n) => !n.anchor && this.isVisible(n) && this.pos.has(n.id));
      if (!top.length) return;
      const ROWH = 40; const key = (n) => { const p = this.pos.get(n.id); return [Math.round(p.y / ROWH), p.x]; };
      top.sort((a, b) => { const ka = key(a); const kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1] || S.util.natural(a.id, b.id); });
      const list = top.flatMap((n) => [n].concat((this.childrenOf.get(n.id) || []).filter((c) => this.isVisible(c))
        .sort((a, b) => a.anchor.dy - b.anchor.dy || a.anchor.dx - b.anchor.dx || S.util.natural(a.id, b.id))));
      const i = list.findIndex((n) => n.id === this.kbd);
      const n = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length];
      this.kbd = n.id; this.hover = { type: 'node', id: n.id };
      let sp = this.toScreen(this.at(n.id)); const m = 40;
      if (sp.x < m || sp.y < m || sp.x > this.w - m || sp.y > this.h - m) { this.tx += this.w / 2 - sp.x; this.ty += this.h / 2 - sp.y; sp = this.toScreen(this.at(n.id)); }
      this.dirty = true; this.emit('hover', { item: this.hover, x: sp.x, y: sp.y, keyboard: true });
    }
    /** 以畫面上的一點（預設中央）為中心縮放 */
    zoomAt(f, at) {
      const p = at || { x: this.w / 2, y: this.h / 2 };
      const ns = Math.max(0.02, Math.min(6, this.s * f)); const w = this.toWorld(p.x, p.y);
      this.s = ns; this.tx = p.x - w.x * ns; this.ty = p.y - w.y * ns; this.dirty = true;
    }
    radius(n) {
      if (n.box) return Math.max(n.box.w, n.box.h) / 2;
      if (n.kind === 'port') return T.l2.port.size / 2 + 1;
      if (n.kind === 'endpoint') return 7; if (n.kind === 'cluster') return 12; if (n.kind === 'downstream') return 9;
      return n.kind === 'host' ? 6 : n.collected ? 13 : 9;
    }
    /** type 是指標種類：觸控的命中範圍較大（螢幕上約多 10px）。容器框（box）只在沒有點到其他節點（例如框上的埠）時命中 */
    hitNode(p, type) {
      const w = this.toWorld(p.x, p.y); let best = null; let bd = Infinity; let box = null; let area = Infinity; const slop = (type === 'touch' ? 14 : 4) / this.s;
      for (const n of this.nodes) {
        if (!this.isVisible(n)) continue; const q = this.at(n.id); if (!q) continue;
        if (n.box) {
          if (Math.abs(q.x - w.x) <= n.box.w / 2 + slop && Math.abs(q.y - w.y) <= n.box.h / 2 + slop && n.box.w * n.box.h < area) { box = n; area = n.box.w * n.box.h; }
          continue;
        }
        const d = Math.hypot(q.x - w.x, q.y - w.y); const r = this.radius(n) + slop;
        if (d < r && d < bd) { best = n; bd = d; }
      }
      return best || box;
    }
    hitEdge(p, type) {
      const w = this.toWorld(p.x, p.y); const tol = (type === 'touch' ? 14 : 6) / this.s; let best = null; let bd = tol;
      for (const e of this.edges) {
        if (!this._edgeVisible(e)) continue;
        const a = this.at(e.a); const b = this.at(e.b); if (!a || !b) continue;
        const d = segDist(w, a, b); if (d < bd) { bd = d; best = e; }
      }
      return best;
    }
    _edgeVisible(e) { const a = this.nodeById.get(e.a); const b = this.nodeById.get(e.b); return a && b && this.isVisible(a) && this.isVisible(b); }

    // ---------------- 繪圖
    _loop() { const tick = () => { if (this.dirty) { this.dirty = false; this.draw(); } requestAnimationFrame(tick); }; requestAnimationFrame(tick); }
    draw() {
      // 先填畫布底色（與 --surface 相同），匯出的 PNG 才不是透明背景
      const c = this.ctx; c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); c.clearRect(0, 0, this.w, this.h);
      c.fillStyle = CV.surface; c.fillRect(0, 0, this.w, this.h);
      if (!this.nodes.length) return;
      const s = this.s; const view = { x0: -this.tx / s - 50, y0: -this.ty / s - 50, x1: (this.w - this.tx) / s + 50, y1: (this.h - this.ty) / s + 50 };
      const inView = (p) => p && p.x > view.x0 && p.x < view.x1 && p.y > view.y0 && p.y < view.y1;
      const hl = this.hl; const dim = hl && (hl.nodes.size || hl.edges.size);
      const hoverN = this.hover && this.hover.type === 'node' ? this.hover.id : null;
      const hoverE = this.hover && this.hover.type === 'edge' ? this.hover.id : null;
      const hoverAdj = new Set();
      if (hoverN) [hoverN].concat((this.childrenOf.get(hoverN) || []).map((x) => x.id)).forEach((id) => (this.edgesByNode.get(id) || []).forEach((e) => hoverAdj.add(e.id)));
      c.save(); c.translate(this.tx, this.ty); c.scale(s, s);

      // 分群底色
      if (this.showGroups && this.groupBoxes) {
        this.groupBoxes.forEach((g) => {
          c.fillStyle = CV.group.fill; c.strokeStyle = CV.group.stroke; c.lineWidth = 1 / s;
          roundRect(c, g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0, 18); c.fill(); c.stroke();
          if (s > 0.04) { const gf = 13 / s; c.fillStyle = CV.group.text; c.font = `600 ${gf}px ${T.font.ui}`; c.fillText(fitText(c, g.name, Math.max(g.x1 - g.x0 - 8 / s, gf * 4)), g.x0 + 4 / s, g.y0 - 5 / s); }
        });
      }

      // 連線
      const drawEdge = (e, override) => {
        const a = this.at(e.a); const b = this.at(e.b); if (!a || !b) return;
        if (!inView(a) && !inView(b) && !segInView(a, b, view)) return;
        const st = e.style || EDGE[e.cls] || EDGE.other; let col = st.c; const multi = e.count > 1; let w = st.w * (multi ? T.multi.widen : 1); let alpha = 1;
        // 證據強度（query 的 devicePairs 決定）只改線型與透明度，保留速率色；連到終端的連線依介面類型換線型
        const weak = WEAK[e.evidence];
        if (weak) alpha = weak.alpha;
        // 高亮可以是顏色，或 { c, dash, alpha, sev }（VLAN 承載：線型與中點外形）
        const hv = hl && hl.edges.get(e.id); const hc = hv ? (typeof hv === 'string' ? { c: hv } : hv) : null;
        if (dim && !hc && !override) alpha = ALPHA.dimEdge;
        if (hc) { col = hc.c; w = Math.max(w, 3.5, 2.5 / s); if (hc.alpha != null) alpha = hc.alpha; }
        if (override) { col = override; w = Math.max(w, 3.5, 2.5 / s); alpha = 1; }
        c.globalAlpha = alpha; c.strokeStyle = col; c.lineWidth = Math.max(w, 0.8 / s);
        const dash = (hc && !override && hc.dash) || (e.ifStyle && e.ifStyle.dash) || (weak ? weak.dash : st.dash);
        c.setLineDash(dash ? dash.map((d) => d / Math.min(s, 1)) : []);
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        if (multi) { // 多條鏈路：中間一條底色細縫，看起來是雙線
          c.strokeStyle = CV.surface; c.lineWidth = Math.max(w, 0.8 / s) * T.multi.gap; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        }
        c.setLineDash([]);
        if (e.arrow) arrow(c, a, b, Math.max(8, 6 / s), col, 0.8);
        const midSev = hc && hc.sev && !override ? hc.sev : e.sev && !dim && !override ? e.sev : null;
        if (midSev) { // 有問題的連線（或 VLAN 只有一端帶）：中點標記（外形同節點）
          c.globalAlpha = 1; sevMark(c, midSev, (a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(4.5, 3.5 / s));
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
        const a = this.at(o.a); const b = this.at(o.b); if (!a || !b) return;
        c.strokeStyle = o.color || MARK.trace; c.lineWidth = Math.max(6, 4 / s); c.globalAlpha = ALPHA.overlay;
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); arrow(c, a, b, Math.max(14, 10 / s), o.color || MARK.trace); c.globalAlpha = 1;
      });

      // 節點
      const portLabels = s > 1.25;
      // 標示環：一般節點是圓，容器框與子網長條是外擴的圓角矩形
      const ring = (n, p, r, extra) => {
        c.beginPath();
        if (n.box) roundRect(c, p.x - n.box.w / 2 - extra, p.y - n.box.h / 2 - extra, n.box.w + extra * 2, n.box.h + extra * 2, 6 + extra);
        else c.arc(p.x, p.y, r + extra, 0, Math.PI * 2);
        c.stroke();
      };
      const inViewNode = (n, p) => p && (inView(p) || (n.box && p.x + n.box.w / 2 > view.x0 && p.x - n.box.w / 2 < view.x1 && p.y + n.box.h / 2 > view.y0 && p.y - n.box.h / 2 < view.y1));
      for (const n of this.nodes) {
        if (!this.isVisible(n)) continue; const p = this.at(n.id); if (!inViewNode(n, p)) continue;
        const r = n.box ? 0 : this.radius(n); const col = KIND_COLOR[n.kind] || KIND_COLOR.unknown;
        const hcol = hl && hl.nodes.get(n.id);
        c.globalAlpha = dim && !hcol && !this.sel.nodes.has(n.id) ? ALPHA.dimNode : 1;
        drawShape(c, n, p, r, col, s);
        if (hcol) { c.strokeStyle = hcol; c.lineWidth = 3.5; ring(n, p, r, n.kind === 'port' ? 3 : 5); }
        if (this.sel.nodes.has(n.id)) { c.strokeStyle = MARK.select; c.lineWidth = 3; ring(n, p, r, n.kind === 'port' ? 4 : 6); }
        // 滑過：節點本身也有回饋（深色細環，與選取的藍色粗環、搜尋結果的顏色環不同）
        if (n.id === hoverN) { c.strokeStyle = MARK.hover; c.lineWidth = 2; ring(n, p, r, this.sel.nodes.has(n.id) ? 9.5 : 3.5); }
        // 嚴重度：主機與終端（較小的節點）也顯示，外形區分錯誤與警告；容器框標在右上角
        if (n.sev) {
          if (n.box) sevMark(c, n.sev, p.x + n.box.w / 2 - 2, p.y - n.box.h / 2 + 2, 5);
          else sevMark(c, n.sev, p.x + r * 0.85, p.y - r * 0.85, Math.max(4, Math.min(5, r * 0.5)));
        }
        c.globalAlpha = 1;
      }
      // 容器框、子網長條與埠的文字（畫在節點內或框邊旁，不參與下面的標籤避讓）
      for (const n of this.nodes) {
        if (!(n.box || n.kind === 'port') || !this.isVisible(n)) continue; const p = this.at(n.id); if (!inViewNode(n, p)) continue;
        const forced = this.sel.nodes.has(n.id) || n.id === hoverN || (hl && hl.nodes.has(n.id));
        c.globalAlpha = dim && !forced ? ALPHA.dimLabel : 1;
        if (n.kind === 'port') { if (s > 0.9 || forced) portName(c, n, p, s, forced); }
        else if (s > 0.18 || forced) boxText(c, n, p, s);
        c.globalAlpha = 1;
      }
      // 標籤：依重要性排序，與已畫的標籤重疊就略過（避免縮小時糊成一片）
      const RANKL = { firewall: 0, router: 1, switch: 2, unknown: 3, host: 4, cluster: 5, downstream: 5, endpoint: 6 };
      const cand = [];
      for (const n of this.nodes) {
        if (n.box || n.kind === 'port' || !this.isVisible(n)) continue; const p = this.at(n.id); if (!inView(p)) continue;
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
        // 過長的名稱截斷加「…」，完整名稱在滑過提示與詳情
        c.font = `${n.collected ? 600 : 400} ${fs}px ${T.font.ui}`; const label = fitText(c, n.label, fs * CV.label.maxEm);
        const tw = c.measureText(label).width; const r = this.radius(n);
        const box = { x0: p.x - tw / 2 - fs * 0.3, x1: p.x + tw / 2 + fs * 0.3, y0: p.y + r + fs * 0.2, y1: p.y + r + fs * 1.5 };
        if (pri >= 0 && placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
        placed.push(box);
        c.globalAlpha = dim && pri >= 10 ? ALPHA.dimLabel : 1;
        c.fillStyle = CV.label.bg; c.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
        c.fillStyle = n.collected ? CV.label.text : CV.label.textUncollected; c.fillText(label, p.x, box.y1 - fs * 0.32);
      }
      c.textAlign = 'left'; c.globalAlpha = 1;
      // 埠名：一般只在放大時畫，且與已畫標籤重疊就略過；滑過、選取的連線（及滑過節點的連線）強制顯示，不受縮放與重疊限制
      const isForced = (e) => this.sel.edges.has(e.id) || e.id === hoverE || hoverAdj.has(e.id);
      const edgesToLabel = this.edges.filter((e) => this._edgeVisible(e) && (portLabels || isForced(e)));
      const drawPort = (e, force) => {
        const a = this.at(e.a); const b = this.at(e.b);
        if (!a || !b || (!inView(a) && !inView(b))) return;
        const k = force ? Math.max(1, 1.25 / s) : 1; // 縮小時放大字級，保持螢幕上可讀
        c.font = `${10 * k}px ${T.font.mono}`;
        if (e.labelA) portLabel(c, a, b, e.labelA, this.radius(this.nodeById.get(e.a)) + 26 * k, placed, force ? k : 0);
        if (e.labelB) portLabel(c, b, a, e.labelB, this.radius(this.nodeById.get(e.b)) + 26 * k, placed, force ? k : 0);
      };
      edgesToLabel.filter((e) => !isForced(e)).forEach((e) => drawPort(e, false));
      edgesToLabel.filter(isForced).forEach((e) => drawPort(e, true));
      c.restore();
    }
    computeGroups() {
      const boxes = new Map();
      this.nodes.forEach((n) => {
        if (n.anchor || !this.isVisible(n)) return; const p = this.pos.get(n.id); if (!p) return;
        const g = S.util.getOr(boxes, n.group || '', () => ({ name: n.group || '', x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 }));
        g.x0 = Math.min(g.x0, p.x - 50); g.y0 = Math.min(g.y0, p.y - 50); g.x1 = Math.max(g.x1, p.x + 50); g.y1 = Math.max(g.y1, p.y + 40); g.n++;
      });
      this.groupBoxes = boxes.size > 1 ? Array.from(boxes.values()).filter((g) => g.n > 0) : null;
      this.dirty = true;
    }
  }

  function drawShape(c, n, p, r, col, s) {
    if (n.virtual) return drawVirtual(c, n, p, r, s);
    if (n.kind === 'subnet') return drawSubnet(c, n, p);
    if (n.box) return drawBox(c, n, p, col);
    if (n.kind === 'port') return drawPortShape(c, n, p);
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
  /** L2 的設備：容器框，外框用設備類型色（未收集是虛線），框左上角是設備名稱；框上的埠是另外的節點 */
  function drawBox(c, n, p, col) {
    const B = T.l2.box; const w = n.box.w; const h = n.box.h;
    c.fillStyle = B.fill; c.strokeStyle = col; c.lineWidth = 2;
    if (!n.collected) c.setLineDash(B.dash);
    roundRect(c, p.x - w / 2, p.y - h / 2, w, h, B.radius); c.fill(); c.stroke(); c.setLineDash([]);
    // 左側的類型色條：框很淡時也看得出設備類型（外形以外再加一個位置固定的色塊）
    c.fillStyle = col; c.fillRect(p.x - w / 2 + 1, p.y - h / 2 + 4, 4, h - 8);
  }
  /** L3 的子網：圓角長條；只由路由得知的目的網段是虛線外框 */
  function drawSubnet(c, n, p) {
    const N = T.l3.subnet; const w = n.box.w; const h = n.box.h;
    c.fillStyle = N.fill; c.strokeStyle = N.stroke; c.lineWidth = 1.6;
    if (n.routeOnly) c.setLineDash(N.routeDash);
    roundRect(c, p.x - w / 2, p.y - h / 2, w, h, h / 2); c.fill(); c.stroke(); c.setLineDash([]);
  }
  /** L2 的埠：框邊上的小方塊；聚合埠較寬，推論鏈路未收集端的未知埠是虛線 */
  function drawPortShape(c, n, p) {
    const P = T.l2.port; const w = n.lag ? P.lagW : P.size; const h = P.size;
    c.fillStyle = P.fill; c.strokeStyle = P.stroke; c.lineWidth = 1.5;
    if (n.unknown) c.setLineDash(P.dash);
    roundRect(c, p.x - w / 2, p.y - h / 2, w, h, 1.5); c.fill(); c.stroke(); c.setLineDash([]);
  }
  /** 容器框的設備名稱（左上角、框內）與子網長條的網段文字（置中）；子網的重疊、重複 IP 另在下方以警告外形加文字標示 */
  function boxText(c, n, p, s) {
    const w = n.box.w; const h = n.box.h;
    if (n.kind === 'subnet') {
      const N = T.l3.subnet; c.font = `600 11px ${T.font.mono}`; c.fillStyle = N.text; c.textAlign = 'center';
      c.fillText(fitText(c, n.label, w - 10), p.x, p.y + 4); c.textAlign = 'left';
      (n.badges || []).forEach((b, i) => {
        const B = T.l3.badge; c.font = `600 10px ${T.font.ui}`; const tw = c.measureText(b).width + 18; const y = p.y + h / 2 + 4 + i * 16; const x = p.x - tw / 2;
        c.fillStyle = B.bg; c.strokeStyle = B.border; c.lineWidth = 1; roundRect(c, x, y, tw, 14, 3); c.fill(); c.stroke();
        sevMark(c, 'warn', x + 7, y + 7, 3.5);
        c.fillStyle = B.text; c.fillText(b, x + 13, y + 10.5);
      });
      return;
    }
    const B = T.l2.box; c.font = `${n.collected ? 600 : 400} 12px ${T.font.ui}`;
    c.fillStyle = n.collected ? CV.label.text : CV.label.textUncollected;
    c.fillText(fitText(c, n.label, w - 16), p.x - w / 2 + 9, p.y - h / 2 + B.labelH - 5);
    if (n.sub && s > 0.5) { c.font = `10px ${T.font.ui}`; c.fillStyle = CV.label.textUncollected; c.fillText(fitText(c, n.sub, w - 16), p.x - w / 2 + 9, p.y - h / 2 + B.labelH + 9); }
  }
  /** 埠名：放在埠往框外的方向（依它在框上的位置），等寬字型 */
  function portName(c, n, p, s, forced) {
    const k = forced ? Math.max(1, 1 / s) : 1; c.font = `${9 * k}px ${T.font.mono}`;
    const text = fitText(c, n.label, 9 * k * CV.port.maxEm); const tw = c.measureText(text).width;
    const len = Math.hypot(n.anchor.dx, n.anchor.dy) || 1; const ux = n.anchor.dx / len; const uy = n.anchor.dy / len;
    const vertical = Math.abs(n.anchor.dy) >= Math.abs(n.anchor.dx) * 0.4;
    const x = vertical ? p.x : p.x + ux * (tw / 2 + 9 * k); const y = vertical ? p.y + (uy >= 0 ? 15 * k : -9 * k) : p.y + 3 * k;
    c.fillStyle = CV.port.bg; c.fillRect(x - tw / 2 - 2, y - 9 * k, tw + 4, 11 * k);
    c.fillStyle = CV.port.text; c.textAlign = 'center'; c.fillText(text, x, y); c.textAlign = 'left';
  }
  /**
   * 嚴重度標記：錯誤是方形、警告是三角形（theme.sevShape），外圍一圈底色環，在線上或節點上都看得清楚。
   * size 是外接圓半徑（世界座標）。警告色對淺底的對比較低，所以另描一圈警告文字色。
   */
  function sevMark(c, sev, x, y, size) {
    const shape = T.sevShape[sev]; c.beginPath();
    if (shape === 'triangle') { const k = size * 1.15; c.moveTo(x, y - k); c.lineTo(x + k, y + k * 0.8); c.lineTo(x - k, y + k * 0.8); c.closePath(); }
    else if (shape === 'square') { const k = size * 0.85; c.moveTo(x - k, y - k); c.lineTo(x + k, y - k); c.lineTo(x + k, y + k); c.lineTo(x - k, y + k); c.closePath(); }
    else c.arc(x, y, size, 0, Math.PI * 2);
    c.setLineDash([]); c.lineJoin = 'round';
    c.strokeStyle = CV.outline; c.lineWidth = size * 0.55; c.stroke();
    c.fillStyle = SEV_COLOR[sev] || CV.sevFallback; c.fill();
    if (sev === 'warn') { c.strokeStyle = T.text.warn; c.lineWidth = size * 0.18; c.stroke(); }
  }
  /** 未知對端（由 MAC 推論出來、基準裡沒有 LLDP／CDP 介面鄰接的東西）：外觀刻意和已知設備不同 */
  function drawVirtual(c, n, p, r, s) {
    if (n.kind === 'endpoint') { // 單一 MAC：圓形，顏色依廠商，近看顯示廠商縮寫
      c.fillStyle = n.color || EP.vendorFallback; c.strokeStyle = CV.outline; c.lineWidth = 1.5;
      c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fill(); c.stroke();
      if (s > 1.3 && n.ini) { c.fillStyle = CV.outline; c.font = `bold 7px ${T.font.ui}`; c.textAlign = 'center'; c.fillText(n.ini, p.x, p.y + 2.6); c.textAlign = 'left'; }
    } else if (n.kind === 'downstream') { // Wi-Fi 多 MAC：菱形只作圖面提示
      c.fillStyle = EP.downstream.fill; c.strokeStyle = EP.downstream.stroke; c.lineWidth = 2; c.setLineDash(EP.dash);
      c.beginPath(); c.moveTo(p.x, p.y - r); c.lineTo(p.x + r, p.y); c.lineTo(p.x, p.y + r); c.lineTo(p.x - r, p.y); c.closePath(); c.fill(); c.stroke(); c.setLineDash([]);
      if (s > 0.9) { c.fillStyle = EP.downstream.text; c.font = `bold 8px ${T.font.ui}`; c.textAlign = 'center'; c.fillText(String(n.count || ''), p.x, p.y + 3); c.textAlign = 'left'; }
    } else { // cluster：同一台設備上很多終端，收合成一個
      c.fillStyle = EP.cluster.fill; c.strokeStyle = EP.cluster.stroke; c.lineWidth = 1.5;
      roundRect(c, p.x - r * 1.3, p.y - r * 0.8, r * 2.6, r * 1.6, 5); c.fill(); c.stroke();
      if (s > 0.35) { c.fillStyle = EP.cluster.text; c.font = `bold 9px ${T.font.ui}`; c.textAlign = 'center'; c.fillText('×' + (n.count || ''), p.x, p.y + 3.2); c.textAlign = 'left'; }
    }
  }
  /** force（縮放倍率 k）不做重疊檢查，且兩端太近時把標籤往線中間收，確保一定看得到。 */
  function portLabel(c, from, to, text, dist, placed, force) {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    if (force) dist = Math.min(dist, len * 0.3); else if (len < dist * 2.2) return;
    const k = force || 1;
    const x = from.x + ((to.x - from.x) / len) * dist; const y = from.y + ((to.y - from.y) / len) * dist;
    text = fitText(c, text, 10 * k * CV.port.maxEm); const tw = c.measureText(text).width;
    const box = { x0: x - tw / 2 - 3 * k, x1: x + tw / 2 + 3 * k, y0: y - 7 * k, y1: y + 6 * k };
    if (!force && placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) return;
    placed.push(box);
    c.fillStyle = CV.port.bg; c.strokeStyle = CV.port.border; c.lineWidth = 0.6 * k;
    roundRect(c, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, 3 * k); c.fill(); c.stroke();
    c.fillStyle = CV.port.text; c.textAlign = 'center'; c.fillText(text, x, y + 3.5 * k); c.textAlign = 'left';
  }
  /**
   * 文字超過 maxW（目前字型下的寬度）時截斷並加「…」。以二分搜尋找最長前綴；結果依字型與寬度快取，
   * 避免每一格都重新量測（快取只存畫面用的字串，資料量超過上限時整個清掉）。
   */
  const FIT_CACHE = new Map(); const FIT_MAX = 5000;
  function fitText(c, text, maxW) {
    const str = String(text == null ? '' : text); const key = c.font + '|' + Math.round(maxW * 10) + '|' + str;
    if (FIT_CACHE.has(key)) return FIT_CACHE.get(key);
    let out = str;
    if (c.measureText(str).width > maxW) {
      const chars = Array.from(str); let lo = 0; let hi = chars.length;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (c.measureText(chars.slice(0, mid).join('') + '…').width <= maxW) lo = mid; else hi = mid - 1; }
      out = chars.slice(0, Math.max(1, lo)).join('') + '…';
    }
    if (FIT_CACHE.size >= FIT_MAX) FIT_CACHE.clear();
    FIT_CACHE.set(key, out); return out;
  }
  /** t：箭頭在 a→b 上的位置（預設 0.6） */
  function arrow(c, a, b, size, col, t) {
    const k = t == null ? 0.6 : t;
    const ang = Math.atan2(b.y - a.y, b.x - a.x); const mx = a.x + (b.x - a.x) * k; const my = a.y + (b.y - a.y) * k;
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

  V.GraphView = GraphView; V.sevMark = sevMark; V.fitText = fitText;
})(globalThis.SSOT = globalThis.SSOT || {});
