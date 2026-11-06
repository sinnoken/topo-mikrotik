/*
 * 拓樸圖（自寫 Canvas 繪圖，不依賴外部函式庫，可離線使用）。
 *  - 平移（拖背景）、縮放（滾輪）、拖曳節點、點選節點／連線、滑過提示；滑鼠、觸控與觸控筆共用 pointer 事件
 *  - 鍵盤：畫布可取得焦點，N／Shift+N 輪流移到設備、Enter 開詳情、Esc 取消選取、方向鍵平移、+／- 縮放、0 全圖
 *  - 依縮放程度決定是否畫標籤與埠名，只畫畫面內的物件（1000 台以上仍流暢）
 * 資料：nodes [{id,label,kind,collected,group,sev}]、edges [{id,a,b,cls,layer,count,sev,hearsay,mismatch,labelA,labelB}]
 * L2 埠圖與 L3 子網圖（app-layers.js）另用：
 *  - node.box { w, h }：容器框（L2 的設備）或長條（L3 的子網，kind 'subnet'），命中範圍與標示環是矩形
 *  - node.anchor { parent, dx, dy, side? }：位置跟著 parent（L2 的埠）；pos 不存它，拖曳它等於拖曳 parent；
 *    side（north／south／east／west）是埠所在的框邊，埠名依它放在框外，沒有時依 dx／dy 判斷
 * 事件（on，每個事件一個處理函式）：click、dblclick、hover、moving（拖曳節點中，每個 animation frame 最多一次）、moved（拖曳節點放開）
 *  - edge.style { c, w, dash }：取代依 cls 的連線樣式；edge.arrow：在 b 端附近畫箭頭（L3 的路由）
 *  - 高亮 hl.edges 的值可以是顏色，或 { c, dash, alpha, sev, ticks }（VLAN 承載：線型、垂直短刻度與中點外形，不只靠顏色）
 */
(function (S) {
  'use strict';
  const V = (S.view = S.view || {});
  const T = V.theme; const KIND_COLOR = T.kind; const EDGE = T.edge; const SEV_COLOR = T.sev; const MARK = T.mark; const ALPHA = T.alpha;
  const EP = T.endpoint; const WEAK = T.weakEdge; const CV = T.canvas;
  const F = T.font; const W = F.weight;
  /** Canvas 字型字串（字級以目前座標單位計）；字族一律取自 theme.font */
  const font = (px, weight, mono) => `${weight || W.normal} ${px}px ${mono ? F.mono : F.sans}`;
  // 節點內的小字（廠商縮寫、數量）字級固定（世界座標），螢幕上小於 minPx 時不畫
  const INNER = { endpoint: 7, downstream: 8, cluster: 9 };
  const innerShown = (kind, s) => INNER[kind] * s >= F.minPx;
  // L3 網段長條的文字與「重疊網段」等標籤的字級（世界座標）；螢幕上小於 minPx 時不畫字
  const SUBNET_PX = { label: 11, badge: 10 };
  // reveal：節點中心離可見範圍邊緣不到這麼多（px）也算被遮住，標籤與選取環才看得到
  const REVEAL_MARGIN = 24;
  // 分群標籤的螢幕尺寸（px）：以螢幕座標排版，任何縮放程度下字級、截斷與防重疊都一致。
  // pad 是文字左右留白、inset 是標籤離群框左緣（放在框內時也離頂邊）的距離、h 是標籤高度、base 是文字基線離下緣的距離
  const GL = { pad: 4, inset: 4, h: F.groupPx + 7, base: 6 };
  const GL_FONT = font(F.groupPx, W.strong);
  // 群框的最小寬度（世界座標）：只有一兩台的小群也有寬度放簡稱（「區域 2」）。取版面的群間距（layout.js 的 GAP），兩個只有一台的鄰群往兩側各加寬後仍不重疊
  const GROUP_MIN_W = V.layout.GAP;
  // 標籤的優先順序：設備依版面的層級（layout.js 的 RANK），終端類節點排在後面
  const LABEL_RANK = Object.assign({}, V.layout.RANK, { cluster: 5, downstream: 5, endpoint: 6 });
  // 設備名稱、分群標籤離畫布左右邊緣至少 EDGE_INSET（px）
  const EDGE_INSET = 4;
  // 設備名稱的縮放門檻：倍率低於 all 時只畫核心（LABEL_RANK ≤ coreRank：防火牆、路由器）的名稱，低於 core 時都不畫
  const LABEL_MIN = { all: 0.18, core: 0.06, coreRank: 1 };
  // 埠名離節點邊緣的距離（螢幕 px）；滑過時與其他埠名重疊就沿線往外挪 PORT_SLIDE px，最多 PORT_TRIES 次
  const PORT_GAP = 26; const PORT_SLIDE = 14; const PORT_TRIES = 6;
  // 縮放範圍（滾輪、雙指、鍵盤共用）
  const ZOOM = { min: 0.02, max: 6 };
  // 全圖：畫面邊緣留白（px，另扣工具列、圖例等覆蓋層實際佔用的高度）；節點很少時的倍率上限，避免一兩台設備被放得很大
  const FIT = { pad: 32, maxOne: 1.6, max: 2.2 };
  // 聚焦（選取、檢查結果、路由追蹤）：倍率上限 1.5。埠名在 s > 1.25 才畫，1.5 讀得到埠名，又不會把一跳鄰居推出畫面；
  // 留白 pad 容納節點下方的名稱標籤（常見名稱約 120px 寬）與埠名
  // minScale：納入一跳鄰居後倍率低於它時（例如核心設備的鄰居散在整張圖），改為只聚焦選取的設備，否則等於沒有放大
  // lean：只聚焦設備本身時，畫面往鄰居方向移動的上限（可視範圍的比例；節點離畫面邊緣至少留 0.5 - lean，節點框另外整個留在畫面內、離邊緣至少 pad）
  const FOCUS = { maxScale: 1.5, pad: 64, minScale: 0.9, lean: 0.3 };
  // 覆蓋層高度超過畫布的 max 倍時不讓出空間（setOccluders）。max：沒有指定時的預設，例如展開的圖例太高時不讓，否則圖會被壓扁，使用者可收合它；
  // pinned：一定要讓開的元素（工具列、通知、半高的詳情抽屜）用這個，只有幾乎蓋滿整張圖時（全高的抽屜）才不計
  const OCCLUDER = { max: 0.4, pinned: 0.75 };
  // 觸控：手指比滑鼠粗，節點點擊半徑在螢幕上至少 hitPx（約一個指尖的一半），且至少是節點半徑外加 slopPx（大節點與容器框也好點）；
  // 連線容差 edgePx；移動超過 movePx 才算拖曳；tapMs／tapPx 內在同一節點點兩下視為雙擊（觸控沒有可靠的 dblclick）。
  // 滑鼠的 hitPx 是節點半徑外加的容差
  const TOUCH = { hitPx: 22, slopPx: 14, edgePx: 14, movePx: 8, tapMs: 400, tapPx: 24 };
  const MOUSE = { hitPx: 4, edgePx: 6, movePx: 3 };

  class GraphView {
    constructor(canvas) {
      this.cv = canvas; this.ctx = canvas.getContext('2d');
      this.nodes = []; this.edges = []; this.pos = new Map(); this.nodeById = new Map();
      this.s = 1; this.tx = 0; this.ty = 0; this.dirty = true;
      this.sel = { nodes: new Set(), edges: new Set() };
      this.hl = null; // { nodes: Map(id→color), edges: Map(id→color) }
      this.emphasis = null; // 與多數不同的設備 Set(id)；唯讀，用 setEmphasis 設定
      this.overlay = []; // [{a,b,color,label}]
      this.hover = null; this.kbd = null; this.handlers = {}; this.visible = () => true; this.showGroups = true;
      this.occluders = []; // [{ el, max, when }]：疊在畫布上方或下方的元素，全圖與聚焦時讓開（見 viewport）
      // 分群標籤：hoverGroup 是滑過的群名（強制顯示全名）；groupLabels 是上次繪製的標籤矩形（螢幕座標，唯讀，供 hover 與測試）
      this.hoverGroup = null; this.groupLabels = [];
      // 上次繪製的設備名稱與埠名矩形（螢幕座標，唯讀，供測試）：{ id／text, x0, y0, x1, y1, px }
      this.nodeLabels = []; this.portLabels = [];
      this.pendingFit = null; // 畫布尚未有尺寸（例如窄螢幕切到其他工作區）時延後的 fit 參數
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
      if (this.pendingFit && this.w >= 1 && this.h >= 1) { const a = this.pendingFit; this.pendingFit = null; this.fit(...a); }
    }
    /** 畫布剛從隱藏變成顯示（例如窄螢幕切回工作畫面）時 ResizeObserver 還沒通知：全圖、聚焦前先同步大小 */
    syncSize() { const r = this.cv.getBoundingClientRect(); if (r.width !== this.w || r.height !== this.h) this.resize(); }
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
    /** 額外標出與多數不同的設備（devKeys：設備鍵陣列；null 或空陣列清除）。與選取、高亮並存，以 theme.canvas.deviation 的虛線外圈區分。 */
    setEmphasis(devKeys) { this.emphasis = devKeys && devKeys.length ? new Set(devKeys) : null; this.dirty = true; }
    setOverlay(o) { this.overlay = o || []; this.dirty = true; }
    redraw() { this.dirty = true; }

    // ---------------- 座標
    toScreen(p) { return { x: p.x * this.s + this.tx, y: p.y * this.s + this.ty }; }
    toWorld(x, y) { return { x: (x - this.tx) / this.s, y: (y - this.ty) / this.s }; }
    /**
     * 疊在畫布上的元素（工具列、圖例、操作提示、通知、窄螢幕的詳情抽屜）：[{ el, max, when }]。全圖、聚焦與 reveal 依它們目前的位置讓出空間；
     * 元素隱藏、沒有大小、when() 為 false，或高度超過畫布的 max 倍（省略時 OCCLUDER.max；例如全高的抽屜，整張圖本來就被蓋住）時不計。
     */
    setOccluders(list) { this.occluders = (list || []).filter((o) => o && o.el); }
    /** 畫面上沒被遮住的範圍（螢幕座標）：上半部的遮擋物推下上緣，下半部的推上下緣 */
    viewport() {
      let top = 0; let bottom = this.h;
      if (this.occluders.length) {
        const cr = this.cv.getBoundingClientRect();
        this.occluders.forEach(({ el, max, when }) => {
          if (el.classList.contains('hidden') || (when && !when())) return;
          const r = el.getBoundingClientRect(); const y0 = r.top - cr.top; const y1 = y0 + r.height;
          if (!r.width || !r.height || r.height > this.h * (max == null ? OCCLUDER.max : max) || y1 <= 0 || y0 >= this.h) return;
          if (y0 + r.height / 2 < this.h / 2) top = Math.max(top, y1); else bottom = Math.min(bottom, y0);
        });
      }
      if (bottom - top < 1) { top = 0; bottom = this.h; }
      return { x0: 0, y0: top, x1: this.w, y1: bottom };
    }
    /**
     * 把 ids（省略時為所有可見節點）放進沒被遮住的範圍；pad 省略時用 FIT.pad，maxScale 省略時用全圖的上限。
     * 畫布還沒有尺寸時延到 resize。容器框（box）以四個角計算，整個框才會在畫面內。
     * fallback（{ ids, minScale }）：算出的倍率低於 minScale 時改放 fallback.ids（聚焦用）。
     */
    fit(ids, pad, maxScale, fallback) {
      this.syncSize();
      if (this.w < 1 || this.h < 1) { this.pendingFit = [ids, pad, maxScale, fallback]; return; }
      this.pendingFit = null;
      const all = !(ids && ids.length);
      const list = (all ? this.nodes.filter((n) => this.isVisible(n)).map((n) => n.id) : ids).flatMap((id) => {
        const p = this.at(id); const n = this.nodeById.get(id); if (!p) return [];
        return n && n.box ? [{ x: p.x - n.box.w / 2, y: p.y - n.box.h / 2 }, { x: p.x + n.box.w / 2, y: p.y + n.box.h / 2 }] : [p];
      });
      if (!list.length) return;
      // 全圖且畫分群時：群框整個放進來，上緣另留一列分群標籤的高度（標籤放在框上方，不必擠進框內蓋住設備名稱）
      const groups = all && this.showGroups && this.groupBoxes; const one = list.length === 1;
      if (groups) this.groupBoxes.forEach((g) => list.push({ x: g.x0, y: g.y0 }, { x: g.x1, y: g.y1 }));
      const xs = list.map((p) => p.x); const ys = list.map((p) => p.y);
      const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
      const v = this.viewport(); const vw = v.x1 - v.x0; const top = groups ? GL.h + 2 : 0; const vh = v.y1 - v.y0 - top;
      const p = Math.min(pad == null ? FIT.pad : pad, vw / 4, vh / 4);
      const s = Math.min((vw - p * 2) / Math.max(maxX - minX, 1), (vh - p * 2) / Math.max(maxY - minY, 1));
      const max = maxScale || (one ? FIT.maxOne : FIT.max);
      this.s = Math.max(ZOOM.min, Math.min(max, s));
      if (fallback && this.s < fallback.minScale) {
        this.fit(fallback.ids, pad, maxScale);
        const keep = new Set(fallback.ids); this._lean(fallback.ids, ids.filter((id) => !keep.has(id)), v, p);
        return;
      }
      this.tx = (v.x0 + v.x1) / 2 - ((minX + maxX) / 2) * this.s; this.ty = (v.y0 + top + v.y1) / 2 - ((minY + maxY) / 2) * this.s;
      this.dirty = true;
    }
    /**
     * 聚焦只放得下選取的節點時（鄰居散在整張圖）：把畫面往鄰居的方向（重心）移，最多 FOCUS.lean 倍的可視範圍，
     * 選取的節點偏到另一側，鄰居那一側露出比較多（例如最上層的核心設備放在偏上方，下面的鄰居看得到）。
     * 位移再以選取節點的包圍框（容器框以整個框計算）限制：框離畫面邊緣至少留 p，寬框（埠很多的 L2 交換器）不會被推出畫面；
     * 框本身已經超出可視範圍（倍率已到下限）時不偏移，維持 fit 的置中。
     */
    _lean(ids, others, v, p) {
      const ps = others.map((id) => this.at(id)).filter(Boolean).map((q) => this.toScreen(q));
      if (!ps.length) return;
      const box = ids.flatMap((id) => {
        const q = this.at(id); const n = this.nodeById.get(id); if (!q) return [];
        const c = this.toScreen(q); const hw = n && n.box ? (n.box.w * this.s) / 2 : 0; const hh = n && n.box ? (n.box.h * this.s) / 2 : 0;
        return [{ x: c.x - hw, y: c.y - hh }, { x: c.x + hw, y: c.y + hh }];
      });
      if (!box.length) return;
      const bx0 = Math.min(...box.map((q) => q.x)); const bx1 = Math.max(...box.map((q) => q.x));
      const by0 = Math.min(...box.map((q) => q.y)); const by1 = Math.max(...box.map((q) => q.y));
      const cx = (v.x0 + v.x1) / 2; const cy = (v.y0 + v.y1) / 2;
      const mx = ps.reduce((s, q) => s + q.x, 0) / ps.length; const my = ps.reduce((s, q) => s + q.y, 0) / ps.length;
      const kx = (v.x1 - v.x0) * FOCUS.lean; const ky = (v.y1 - v.y0) * FOCUS.lean;
      // 往鄰居方向的位移 d（畫面左移 d），夾在 [lo, hi]：lo 讓框的右／下緣不超出 v1 - p，hi 讓左／上緣不超出 v0 + p。
      // lo、hi 再分別取 ≤ 0、≥ 0：框已經超出時（倍率到下限）不偏移，但也不額外移動
      const shift = (d, k, lo, hi) => Math.max(lo, Math.min(hi, Math.max(-k, Math.min(k, d))));
      this.tx -= shift(mx - cx, kx, Math.min(0, bx1 - (v.x1 - p)), Math.max(0, bx0 - (v.x0 + p)));
      this.ty -= shift(my - cy, ky, Math.min(0, by1 - (v.y1 - p)), Math.max(0, by0 - (v.y0 + p)));
      this.dirty = true;
    }
    /**
     * 聚焦：ids 全部放進沒被遮住的範圍，倍率不超過 FOCUS.maxScale。
     * opt.neighbors 時一併納入可見的一跳鄰居，選一台設備時看得出它接在哪裡；鄰居散得太開、倍率會低於 FOCUS.minScale 時只聚焦 ids。
     */
    focus(ids, opt) {
      const set = new Set(ids);
      if (opt && opt.neighbors && this.edgesByNode) {
        ids.forEach((id) => (this.edgesByNode.get(id) || []).forEach((e) => {
          const m = e.a === id ? e.b : e.a; const n = this.nodeById.get(m); if (n && this.isVisible(n)) set.add(m);
        }));
      }
      this.fit(Array.from(set), FOCUS.pad, FOCUS.maxScale, set.size > ids.length ? { ids, minScale: FOCUS.minScale } : null);
    }
    /** 只平移、不縮放：ids 有任一個在沒被遮住的範圍外（例如被詳情抽屜蓋住）時，把它們的中心移到該範圍中央 */
    reveal(ids) {
      this.syncSize();
      if (this.w < 1 || this.h < 1) return;
      const list = (ids || []).map((id) => this.at(id)).filter(Boolean).map((p) => this.toScreen(p));
      if (!list.length) return;
      const v = this.viewport(); const m = REVEAL_MARGIN;
      if (list.every((p) => p.x >= v.x0 + m && p.x <= v.x1 - m && p.y >= v.y0 + m && p.y <= v.y1 - m)) return;
      const xs = list.map((p) => p.x); const ys = list.map((p) => p.y);
      this.tx += (v.x0 + v.x1) / 2 - (Math.min(...xs) + Math.max(...xs)) / 2;
      this.ty += (v.y0 + v.y1) / 2 - (Math.min(...ys) + Math.max(...ys)) / 2;
      this.dirty = true;
    }

    // ---------------- 互動
    // 指標事件（pointer）同時處理滑鼠、觸控與觸控筆；滑鼠行為與原本相同（拖背景平移、拖節點、點選、雙擊）。
    // 觸控沒有 hover：點一下選取，快速點兩下等同雙擊；觸控的命中範圍較大。
    _bind() {
      // pts：目前按著的觸控指標（pointerId → 螢幕座標）；兩指同時按著時是雙指縮放（pinch），不做拖曳與點選
      const cv = this.cv; let drag = null; let pinch = null; let lastTap = null; const pts = new Map();
      // 拖曳中的 'moving'：同一個 animation frame 內的多次 pointermove 只發一次（接收端可能要重算埠的位置）；放開後不再發
      let movingId = null; let movingRaf = false;
      const flushMoving = () => { movingRaf = false; const id = movingId; movingId = null; if (id != null) this.emit('moving', id); };
      const at = (ev) => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
      const mine = (ev) => drag && (ev.pointerId == null || drag.id == null || ev.pointerId === drag.id);
      const pinchState = () => {
        const [a, b] = Array.from(pts.values());
        return { d: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      };
      cv.addEventListener('wheel', (ev) => {
        ev.preventDefault(); const p = at(ev); this.zoomAt(Math.exp(-ev.deltaY * 0.0015), p);
      }, { passive: false });
      cv.addEventListener('pointerdown', (ev) => {
        const type = ev.pointerType || 'mouse';
        if (type === 'mouse' && ev.button) return; // 只用主按鍵
        const p = at(ev);
        if (cv.setPointerCapture && ev.pointerId != null) { try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* 指標已不存在：仍以 window 事件追蹤 */ } }
        if (type !== 'mouse' && ev.pointerId != null) {
          pts.set(ev.pointerId, p);
          if (pts.size === 2) { // 第二指：取消單指拖曳，改為雙指縮放（以兩指中點為中心，同時平移）
            const st = pinchState(); pinch = { d0: st.d, s0: this.s, w0: this.toWorld(st.mid.x, st.mid.y) };
            drag = null; movingId = null; cv.classList.add('dragging'); return;
          }
          if (pts.size > 2) return;
        }
        const n = this.hitNode(p, type);
        // 拖曳掛在容器上的節點（埠）等於拖曳容器；記下指標與節點中心的差，大的容器才不會跳到指標位置
        const target = n && n.anchor ? this.nodeById.get(n.anchor.parent) : n;
        const w = this.toWorld(p.x, p.y); const c = target ? this.at(target.id) : null;
        drag = { id: ev.pointerId, type, start: p, last: p, node: n, target, off: c ? { x: w.x - c.x, y: w.y - c.y } : null, moved: false };
        movingRaf = false; // 新的拖曳不等上一次可能沒執行到的 frame（例如分頁在背景時）
        cv.classList.add('dragging');
      });
      window.addEventListener('pointermove', (ev) => {
        const p = at(ev);
        if (pts.has(ev.pointerId)) pts.set(ev.pointerId, p);
        if (pinch) {
          if (pts.size >= 2) { const st = pinchState(); this.zoomTo(pinch.s0 * (st.d / pinch.d0), st.mid, pinch.w0); }
          return;
        }
        if (!drag) {
          if (ev.pointerType === 'touch') return;
          // 只有指標直接在畫布上才做 hover；在左右欄、工具列、圖例等上面時不可穿透到底下（或畫面外）的節點
          const n = ev.target === cv ? this.hitNode(p) : null; const e = n || ev.target !== cv ? null : this.hitEdge(p);
          const hv = n ? { type: 'node', id: n.id } : e ? { type: 'edge', id: e.id } : null;
          // 沒有指到節點與連線時，指到的分群（標籤或群框）顯示全名；只是檢視狀態，不經 emit
          // 只有一台的群沒有框也平常不標：滑過那台設備時顯示群名
          const hg = ev.target !== cv ? null : n ? this.soloGroupOf(n) : !hv ? this.hitGroup(p) : null;
          if (hg !== this.hoverGroup) { this.hoverGroup = hg; this.dirty = true; }
          if (JSON.stringify(hv) !== JSON.stringify(this.hover)) { this.hover = hv; this.dirty = true; this.emit('hover', { item: hv, x: p.x, y: p.y }); }
          else if (hv) this.emit('hover', { item: hv, x: p.x, y: p.y });
          return;
        }
        if (!mine(ev)) return;
        if (Math.abs(p.x - drag.start.x) + Math.abs(p.y - drag.start.y) > (drag.type === 'mouse' ? MOUSE.movePx : TOUCH.movePx)) drag.moved = true;
        if (!drag.moved) return;
        if (drag.target) {
          const w = this.toWorld(p.x, p.y); this.pos.set(drag.target.id, { x: w.x - drag.off.x, y: w.y - drag.off.y });
          movingId = drag.target.id; if (!movingRaf) { movingRaf = true; requestAnimationFrame(flushMoving); }
        }
        else { this.tx += p.x - drag.last.x; this.ty += p.y - drag.last.y; }
        drag.last = p; this.dirty = true;
      });
      const end = (ev, cancelled) => {
        const had = pts.delete(ev.pointerId);
        if (pinch && had) { // 雙指結束：剩下的手指接著平移，不觸發點選
          if (pts.size < 2) pinch = null;
          else { const st = pinchState(); pinch = { d0: st.d, s0: this.s, w0: this.toWorld(st.mid.x, st.mid.y) }; } // 三指以上放開一指：前兩指換了一組，以新的兩指重新開始，倍率不跳
          if (pts.size === 1) { const [id, q] = Array.from(pts.entries())[0]; drag = { id, type: 'touch', start: q, last: q, node: null, target: null, off: null, moved: true }; }
          else if (!pts.size) { drag = null; cv.classList.remove('dragging'); }
          return;
        }
        if (!mine(ev)) return; cv.classList.remove('dragging');
        const d = drag; drag = null; movingId = null;
        if (d.moved) { if (d.target) this.emit('moved', d.target.id); return; }
        if (cancelled || ev.target !== cv) return;
        const p = at(ev); const n = this.hitNode(p, d.type);
        if (n) {
          if (d.type !== 'mouse') { // 觸控：同一個節點快速點兩下等同雙擊（滑鼠由瀏覽器的 dblclick 處理）
            const twice = lastTap && lastTap.id === n.id && ev.timeStamp - lastTap.t < TOUCH.tapMs && Math.hypot(p.x - lastTap.p.x, p.y - lastTap.p.y) < TOUCH.tapPx;
            lastTap = twice ? null : { id: n.id, t: ev.timeStamp, p };
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
      cv.addEventListener('pointerleave', (ev) => {
        if (ev.pointerType === 'touch') return;
        if (this.hoverGroup) { this.hoverGroup = null; this.dirty = true; }
        if (this.hover && !this.kbd) { this.hover = null; this.dirty = true; this.emit('hover', { item: null }); }
      });
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
    /** 依畫面上的位置（由上而下、由左而右）輪流移到下一台可見的設備；在沒被遮住的範圍外時平移到中央（reveal） */
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
      this.reveal([n.id]); const sp = this.toScreen(this.at(n.id));
      this.dirty = true; this.emit('hover', { item: this.hover, x: sp.x, y: sp.y, keyboard: true });
    }
    /** 以畫面上的一點（預設中央）為中心縮放 f 倍 */
    zoomAt(f, at) { this.zoomTo(this.s * f, at || { x: this.w / 2, y: this.h / 2 }); }
    /** 縮放到 ns（夾在 ZOOM 範圍內），讓世界座標 w0（省略時為 p 目前指到的點）落在螢幕點 p；雙指縮放以開始時的中點為 w0，同時完成平移 */
    zoomTo(ns, p, w0) {
      const w = w0 || this.toWorld(p.x, p.y); const s = Math.max(ZOOM.min, Math.min(ZOOM.max, ns));
      this.s = s; this.tx = p.x - w.x * s; this.ty = p.y - w.y * s; this.dirty = true;
    }
    radius(n) {
      if (n.box) return Math.max(n.box.w, n.box.h) / 2;
      if (n.kind === 'port') return T.l2.port.size / 2 + 1;
      if (n.kind === 'endpoint') return 7; if (n.kind === 'cluster') return 12; if (n.kind === 'downstream') return 9;
      return n.kind === 'host' ? 6 : n.collected ? 13 : 9;
    }
    /**
     * type 是指標種類：觸控與觸控筆的點擊半徑在螢幕上至少 TOUCH.hitPx，滑鼠是節點半徑外加 MOUSE.hitPx。
     * 容器框（box）只在沒有點到其他節點（例如框上的埠）時命中
     */
    hitNode(p, type) {
      const touch = !!type && type !== 'mouse';
      const w = this.toWorld(p.x, p.y); let best = null; let bd = Infinity; let box = null; let area = Infinity; const slop = (touch ? TOUCH.slopPx : MOUSE.hitPx) / this.s;
      for (const n of this.nodes) {
        if (!this.isVisible(n)) continue; const q = this.at(n.id); if (!q) continue;
        if (n.box) {
          if (Math.abs(q.x - w.x) <= n.box.w / 2 + slop && Math.abs(q.y - w.y) <= n.box.h / 2 + slop && n.box.w * n.box.h < area) { box = n; area = n.box.w * n.box.h; }
          continue;
        }
        const d = Math.hypot(q.x - w.x, q.y - w.y); const r = touch ? Math.max(this.radius(n) + TOUCH.slopPx / this.s, TOUCH.hitPx / this.s) : this.radius(n) + slop;
        if (d < r && d < bd) { best = n; bd = d; }
      }
      return best || box;
    }
    hitEdge(p, type) {
      const w = this.toWorld(p.x, p.y); const tol = (type && type !== 'mouse' ? TOUCH.edgePx : MOUSE.edgePx) / this.s; let best = null; let bd = tol;
      for (const e of this.edges) {
        if (!this._edgeVisible(e)) continue;
        const a = this.at(e.a); const b = this.at(e.b); if (!a || !b) continue;
        const d = segDist(w, a, b); if (d < bd) { bd = d; best = e; }
      }
      return best;
    }
    /** 指標下的分群（先看標籤，再看群框；巢狀時取面積最小者），回傳群名 */
    hitGroup(p) {
      if (!this.showGroups || !this.groupBoxes) return null;
      const lb = this.groupLabels.find((r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1);
      if (lb) return lb.name;
      const w = this.toWorld(p.x, p.y); let best = null; let ba = Infinity;
      this.groupBoxes.forEach((g) => {
        if (!g.name || !g.frame || w.x < g.x0 || w.x > g.x1 || w.y < g.y0 || w.y > g.y1) return;
        const a = (g.x1 - g.x0) * (g.y1 - g.y0); if (a < ba) { ba = a; best = g.name; }
      });
      return best;
    }
    /** n 所屬的群只有它一台（不畫框）時回傳群名，否則 null */
    soloGroupOf(n) {
      if (!this.showGroups || !this.groupBoxes) return null;
      const g = this.groupBoxes.find((x) => x.name && x.name === (n.group || ''));
      return g && !g.frame ? g.name : null;
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
      const hl = this.hl; const em = this.emphasis; const dim = hl && (hl.nodes.size || hl.edges.size);
      const hoverN = this.hover && this.hover.type === 'node' ? this.hover.id : null;
      const hoverE = this.hover && this.hover.type === 'edge' ? this.hover.id : null;
      const hoverAdj = new Set();
      if (hoverN) [hoverN].concat((this.childrenOf.get(hoverN) || []).map((x) => x.id)).forEach((id) => (this.edgesByNode.get(id) || []).forEach((e) => hoverAdj.add(e.id)));
      c.save(); c.translate(this.tx, this.ty); c.scale(s, s);

      // 分群底色；標籤在螢幕座標另外排版（壓在連線下方，滑過的那一個最後畫在最上層）
      this.groupLabels = this.showGroups && this.groupBoxes ? this._layoutGroupLabels(c) : [];
      if (this.showGroups && this.groupBoxes) {
        this.groupBoxes.forEach((g) => {
          if (!g.frame) return; // 只有一台的群不畫框（看起來像空框），平常也不標；滑過那台設備時顯示群名
          c.fillStyle = CV.group.fill; c.strokeStyle = CV.group.stroke; c.lineWidth = 1 / s;
          roundRect(c, g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0, 18); c.fill(); c.stroke();
        });
        this._drawGroupLabels(c, (l) => !l.forced);
      }

      // 連線
      const drawEdge = (e, override) => {
        const a = this.at(e.a); const b = this.at(e.b); if (!a || !b) return;
        if (!inView(a) && !inView(b) && !segInView(a, b, view)) return;
        const st = e.style || EDGE[e.cls] || EDGE.other; let col = st.c; const multi = e.count > 1; let w = st.w * (multi ? T.multi.widen : 1); let alpha = 1;
        // 證據強度（query 的 devicePairs 決定）只改線型與透明度，保留速率色；連到終端的連線依介面類型換線型
        const weak = WEAK[e.evidence];
        if (weak) alpha = weak.alpha;
        // 高亮可以是顏色，或 { c, dash, alpha, sev, ticks }（VLAN 承載：線型、刻度與中點外形）
        const hv = hl && hl.edges.get(e.id); const hc = hv ? (typeof hv === 'string' ? { c: hv } : hv) : null;
        if (dim && !hc && !override) alpha = ALPHA.dimEdge;
        if (hc) { col = hc.c; w = Math.max(w, 3.5, 2.5 / s); if (hc.alpha != null) alpha = hc.alpha; }
        if (override) { col = override; w = Math.max(w, 3.5, 2.5 / s); alpha = 1; }
        // 放大超過 100% 時線寬維持 100% 的螢幕粗細（聚焦時聚合的雙線才不會變成一整片）；縮小時至少 0.8px
        if (s > 1) w /= s;
        c.globalAlpha = alpha; c.strokeStyle = col; c.lineWidth = Math.max(w, 0.8 / s);
        const dash = (hc && !override && hc.dash) || (e.ifStyle && e.ifStyle.dash) || (weak ? weak.dash : st.dash);
        c.setLineDash(dash ? dash.map((d) => d / Math.min(s, 1)) : []);
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        if (multi) { // 多條鏈路：中間一條底色細縫，看起來是雙線
          c.strokeStyle = CV.surface; c.lineWidth = Math.max(w, 0.8 / s) * T.multi.gap; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        }
        c.setLineDash([]);
        if (hc && hc.ticks && !override) ticks(c, a, b, hc.ticks, 1 / Math.min(s, 1)); // VLAN 只有一端帶：垂直短刻度（不只靠顏色）
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
        const hcol = hl && hl.nodes.get(n.id); const emph = em && em.has(n.id);
        c.globalAlpha = dim && !hcol && !emph && !this.sel.nodes.has(n.id) ? ALPHA.dimNode : 1;
        drawShape(c, n, p, r, col, s);
        if (hcol) { c.strokeStyle = hcol; c.lineWidth = 3.5; ring(n, p, r, n.kind === 'port' ? 3 : 5); }
        if (this.sel.nodes.has(n.id)) { c.strokeStyle = MARK.select; c.lineWidth = 3; ring(n, p, r, n.kind === 'port' ? 4 : 6); }
        if (emph) { // 與多數不同：比選取與高亮更外圈的虛線；縮小時線寬與虛線保持螢幕上可見
          const D = CV.deviation; const k = Math.max(1, 1 / s);
          c.strokeStyle = D.c; c.lineWidth = D.w * k; c.setLineDash(D.dash.map((d) => d * k)); ring(n, p, r, D.gap * k); c.setLineDash([]);
        }
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
        else if (s > 0.18 || forced) boxText(c, n, p, s, forced);
        c.globalAlpha = 1;
      }
      // 標籤：依重要性排序，與已畫的標籤重疊就略過（避免縮小時糊成一片）
      const cand = [];
      for (const n of this.nodes) {
        if (n.box || n.kind === 'port' || !this.isVisible(n)) continue; const p = this.at(n.id); if (!inView(p)) continue;
        const forced = this.sel.nodes.has(n.id) || n.id === hoverN;
        const marked = (hl && hl.nodes.has(n.id)) || (em && em.has(n.id));
        if (!forced && !marked && (n.kind === 'host' || n.kind === 'endpoint' || n.kind === 'downstream') && s < 0.9) continue;
        if (!forced && !marked && n.kind === 'cluster' && s < 0.45) continue;
        // 縮得很小時只留核心（防火牆／路由器）的名稱，窄螢幕全圖仍讀得到主幹；其他設備放大才出現
        if (!forced && !marked && s < LABEL_MIN.all && !(n.collected && (LABEL_RANK[n.kind] ?? 3) <= LABEL_MIN.coreRank && s >= LABEL_MIN.core)) continue;
        cand.push({ n, p, pri: forced ? -1 : (marked ? 0 : 10) + (n.collected ? 0 : 5) + (LABEL_RANK[n.kind] ?? 3) });
      }
      cand.sort((a, b) => a.pri - b.pri);
      // 設備名稱在螢幕上固定 labelPx，不隨縮小變成小字；太擠時由下方的重疊檢查與上方的縮放門檻略過
      const fs = F.labelPx / s; const placed = []; this.nodeLabels = [];
      // 標籤不出畫布左右邊緣：靠邊的節點把名稱往內推
      const wx0 = (EDGE_INSET - this.tx) / s; const wx1 = (this.w - EDGE_INSET - this.tx) / s;
      c.textAlign = 'center';
      for (const { n, p, pri } of cand) {
        // 過長的名稱截斷加「…」，完整名稱在滑過提示與詳情
        c.font = font(fs, n.collected ? W.strong : W.normal); const label = fitText(c, n.label, fs * CV.label.maxEm);
        const tw = c.measureText(label).width; const r = this.radius(n); const half = tw / 2 + fs * 0.3;
        const cx = wx1 - wx0 > half * 2 ? Math.min(Math.max(p.x, wx0 + half), wx1 - half) : p.x;
        const box = { x0: cx - half, x1: cx + half, y0: p.y + r + fs * 0.2, y1: p.y + r + fs * 1.5 };
        if (pri >= 0 && placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
        placed.push(box);
        this.nodeLabels.push({ id: n.id, text: label, x0: box.x0 * s + this.tx, x1: box.x1 * s + this.tx, y0: box.y0 * s + this.ty, y1: box.y1 * s + this.ty, px: F.labelPx });
        c.globalAlpha = dim && pri >= 10 ? ALPHA.dimLabel : 1;
        c.fillStyle = CV.label.bg; c.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
        c.fillStyle = n.collected ? CV.label.text : CV.label.textUncollected; c.fillText(label, cx, box.y1 - fs * 0.32);
      }
      c.textAlign = 'left'; c.globalAlpha = 1;
      // 埠名：螢幕上固定 portPx（比設備名小），任何縮放都一樣大。一般只在放大時畫，與已畫標籤重疊就略過；
      // 滑過、選取的連線（及滑過節點的連線）不受縮放門檻限制，先畫，避開設備名稱與彼此（沿線往外挪）；都不行時，
      // 選取或滑過的那條仍畫在最後一個位置（一定看得到），滑過節點的其他連線（可能很多條）才略過。
      // 之後才畫一般埠名，與設備名稱或強制顯示的埠名重疊就略過
      const isMust = (e) => this.sel.edges.has(e.id) || e.id === hoverE;
      const isForced = (e) => isMust(e) || hoverAdj.has(e.id);
      const edgesToLabel = this.edges.filter((e) => this._edgeVisible(e) && (portLabels || isForced(e)));
      const k = 1 / s; this.portLabels = [];
      const drawPort = (e, force, must) => {
        const a = this.at(e.a); const b = this.at(e.b);
        if (!a || !b || (!inView(a) && !inView(b))) return;
        c.font = font(F.portPx * k, W.normal, true);
        [[a, b, e.labelA, e.a], [b, a, e.labelB, e.b]].forEach(([from, to, text, id]) => {
          if (!text) return;
          const box = portLabel(c, from, to, text, this.radius(this.nodeById.get(id)) + PORT_GAP * k, placed, k, force, must);
          if (box) this.portLabels.push({ text: box.text, x0: box.x0 * s + this.tx, x1: box.x1 * s + this.tx, y0: box.y0 * s + this.ty, y1: box.y1 * s + this.ty, px: F.portPx, forced: force });
        });
      };
      edgesToLabel.filter(isMust).forEach((e) => drawPort(e, true, true));
      edgesToLabel.filter((e) => isForced(e) && !isMust(e)).forEach((e) => drawPort(e, true, false));
      edgesToLabel.filter((e) => !isForced(e)).forEach((e) => drawPort(e, false));
      c.restore();
      if (this.showGroups && this.groupBoxes) this._drawGroupLabels(c, (l) => l.forced); // 滑過的分群全名蓋在最上層
    }
    /**
     * 分群標籤排版（螢幕座標）：依群大小排序，先放群框上方、與已放的標籤重疊（或頂邊在畫面外）時改放框內左上，兩處都不行就換下一個候選；
     * 寬度不超過群框（只露出一部分時是可見的部分），放不下全名時依 fitLabels 的順序縮短（簡稱 → 尾段 → 截斷）；
     * 群框窄到放不下簡稱時，簡稱可以超出群框（排在尾段之前，窄螢幕仍看得出「分群 2」），
     * 並跳過畫面上別的群已用的文字，縮短後仍兩兩不同。滑過的群（hoverGroup）最先放、顯示全名、不受寬度限制。
     */
    _layoutGroupLabels(c) {
      const s = this.s; c.font = GL_FONT;
      const hovered = this.hoverGroup;
      // 可用範圍：畫布左右各留 EDGE_INSET，上緣在工具列等覆蓋層之下（viewport），標籤不被切到或蓋住
      const v = this.viewport(); const ex0 = EDGE_INSET; const ex1 = this.w - EDGE_INSET; const ey0 = v.y0 + EDGE_INSET; const ey1 = v.y1;
      const list = this.groupBoxes.filter((g) => g.name)
        .sort((a, b) => (b.name === hovered) - (a.name === hovered) || b.n - a.n || S.util.natural(a.name, b.name));
      const out = []; const used = new Set();
      const free = (r) => !out.some((o) => o.x0 < r.x1 && r.x0 < o.x1 && o.y0 < r.y1 && r.y0 < o.y1);
      for (const g of list) {
        const box = { x0: g.x0 * s + this.tx, y0: g.y0 * s + this.ty, x1: g.x1 * s + this.tx, y1: g.y1 * s + this.ty };
        if (box.x1 < ex0 || box.x0 > ex1 || box.y1 < ey0 || box.y0 - GL.h > ey1) continue; // 畫面外或被覆蓋層蓋住
        const forced = g.name === hovered;
        // 只有一台的群（沒畫框）平常不標，否則像一個空群；滑過那台設備時才顯示群名。
        // 群框頂邊在工具列底下或畫面外（放大、聚焦後）也不標：標籤只能貼著工具列下緣，會壓在節點與埠名上；滑過群框時才顯示
        // 左緣在畫面外（放大、聚焦後只看到群的一部分）也不標：標籤會浮在圖的中間，看不出是哪一群的範圍
        if (!forced && (!g.frame || box.y0 < ey0 || box.x0 < ex0)) continue;
        // 滑過時群框可能只露出一部分：標籤貼在可見部分的左上
        const vx0 = Math.max(box.x0, ex0); const vx1 = Math.min(box.x1, ex1); const vy0 = Math.max(box.y0, ey0);
        const texts = forced ? [g.name] : fitLabels(c, g.name, vx1 - vx0 - 2 * GL.inset - 2 * GL.pad);
        // 群框太窄、放不下簡稱（「分群 2」）時，簡稱可以超出群框（仍在畫布內），排在尾段（「2」，看不出是分群）之前
        const short = shortName(g.name);
        if (!forced && !texts.includes(short) && c.measureText(short).width <= ex1 - ex0 - 2 * GL.pad) texts.splice(texts[0] === g.name ? 1 : 0, 0, short);
        // 依序試每個候選：放得下（上方或框內）且畫面上別的群沒用過的第一個
        let r = null; let text = null;
        for (const t of texts) {
          if (!forced && used.has(t)) continue;
          // 滑過的全名、超出群框的簡稱不受群框寬度限制，但仍不出畫布右緣（往左挪）
          const tw = c.measureText(t).width + 2 * GL.pad; const x0 = Math.max(ex0, Math.min(vx0 + GL.inset, ex1 - tw)); const x1 = x0 + tw;
          const above = box.y0 - 2 - GL.h >= ey0 ? { x0, x1, y0: box.y0 - 2 - GL.h, y1: box.y0 - 2 } : null;
          const inside = { x0, x1, y0: vy0 + GL.inset, y1: vy0 + GL.inset + GL.h };
          r = above && (forced || free(above)) ? above : inside.y1 <= box.y1 - GL.inset && (forced || free(inside)) ? Object.assign(inside, { isInside: true }) : null;
          if (r) { text = t; break; }
        }
        if (!r) continue;
        used.add(text);
        const isInside = !!r.isInside; delete r.isInside;
        out.push(Object.assign(r, { name: g.name, text, forced, inside: isInside, box }));
      }
      return out;
    }
    _drawGroupLabels(c, which) {
      const ls = this.groupLabels.filter(which); if (!ls.length) return;
      c.save(); c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); c.font = GL_FONT; c.textAlign = 'left'; c.globalAlpha = 1;
      ls.forEach((l) => {
        c.fillStyle = CV.group.labelBg; roundRect(c, l.x0, l.y0, l.x1 - l.x0, l.y1 - l.y0, 4); c.fill();
        if (l.forced) { c.strokeStyle = CV.group.stroke; c.lineWidth = 1; c.stroke(); }
        c.fillStyle = CV.group.text; c.fillText(l.text, l.x0 + GL.pad, l.y1 - GL.base);
      });
      c.restore();
    }
    computeGroups() {
      const boxes = new Map();
      this.nodes.forEach((n) => {
        if (n.anchor || !this.isVisible(n)) return; const p = this.pos.get(n.id); if (!p) return;
        const g = S.util.getOr(boxes, n.group || '', () => ({ name: n.group || '', x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 }));
        g.x0 = Math.min(g.x0, p.x - 50); g.y0 = Math.min(g.y0, p.y - 50); g.x1 = Math.max(g.x1, p.x + 50); g.y1 = Math.max(g.y1, p.y + 40); g.n++;
      });
      // frame：只有一台的群不畫框，也不以框命中滑過（hitGroup 只看標籤）
      boxes.forEach((g) => { const d = GROUP_MIN_W - (g.x1 - g.x0); if (d > 0) { g.x0 -= d / 2; g.x1 += d / 2; } g.frame = g.n > 1; });
      this.groupBoxes = boxes.size > 1 ? Array.from(boxes.values()).filter((g) => g.n > 0) : null;
      this.dirty = true;
    }
  }

  /**
   * 寬度 avail 內放得下的分群標籤文字，依優先順序：全名 → 簡稱（全形／半形括號前）→ 簡稱的尾段（空白分隔的最後一段，
   * 例如「區域 2」→「2」：短名放不下時優先保留能區分的尾段）→ 字元截斷加「…」（以 Array.from 切字元，不切壞字；至少留兩個字）。
   * 回傳候選陣列（可能為空），呼叫端挑第一個畫面上沒用過的。
   */
  /** 分群名稱的簡稱：全形／半形括號前的部分（「分群 2（TPE_CORE…）」→「分群 2」） */
  const shortName = (name) => name.replace(/\s*[（(].*$/, '') || name;
  function fitLabels(c, name, avail) {
    const fits = (t) => c.measureText(t).width <= avail;
    const out = [];
    if (fits(name)) out.push(name);
    const short = shortName(name);
    if (short !== name && fits(short)) out.push(short);
    const last = short.split(/\s+/).pop();
    if (last !== short && fits(last)) out.push(last);
    const chars = Array.from(short); let lo = 0; let hi = chars.length - 1; // 二分搜尋可保留的最多字數
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(chars.slice(0, mid).join('') + '…')) lo = mid; else hi = mid - 1; }
    if (lo >= 2) out.push(chars.slice(0, lo).join('') + '…');
    return out;
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
  function boxText(c, n, p, s, forced) {
    const w = n.box.w; const h = n.box.h;
    if (n.kind === 'subnet') {
      // 網段文字與標籤的字級是世界座標：螢幕上小於 minPx 時不畫字（只剩長條與警告外形；網段在滑過提示與詳情），滑過、選取時照畫
      const N = T.l3.subnet; const readable = (px) => forced || px * s >= F.minPx;
      if (readable(SUBNET_PX.label)) {
        c.font = font(SUBNET_PX.label, W.strong, true); c.fillStyle = N.text; c.textAlign = 'center';
        c.fillText(fitText(c, n.label, w - 10), p.x, p.y + 4); c.textAlign = 'left';
      }
      (n.badges || []).forEach((b, i) => {
        const B = T.l3.badge; c.font = font(SUBNET_PX.badge, W.strong); const show = readable(SUBNET_PX.badge);
        const tw = show ? c.measureText(b).width + 18 : 14; const y = p.y + h / 2 + 4 + i * 16; const x = p.x - tw / 2;
        c.fillStyle = B.bg; c.strokeStyle = B.border; c.lineWidth = 1; roundRect(c, x, y, tw, 14, 3); c.fill(); c.stroke();
        sevMark(c, 'warn', x + 7, y + 7, 3.5);
        if (show) { c.fillStyle = B.text; c.fillText(b, x + 13, y + 10.5); }
      });
      return;
    }
    const B = T.l2.box; c.font = font(12, n.collected ? W.strong : W.normal);
    c.fillStyle = n.collected ? CV.label.text : CV.label.textUncollected;
    c.fillText(fitText(c, n.label, w - 16), p.x - w / 2 + 9, p.y - h / 2 + B.labelH - 5);
    if (n.sub && s > 0.5) { c.font = font(10); c.fillStyle = CV.label.textUncollected; c.fillText(fitText(c, n.sub, w - 16), p.x - w / 2 + 9, p.y - h / 2 + B.labelH + 9); }
  }
  /** 埠所在框邊往外的方向：anchor.side 優先；沒有時依它在框上的位置（|dy| ≥ 0.4|dx| 算上下緣） */
  const SIDE_OUT = { north: { ux: 0, uy: -1 }, south: { ux: 0, uy: 1 }, east: { ux: 1, uy: 0 }, west: { ux: -1, uy: 0 } };
  function portOut(a) {
    if (SIDE_OUT[a.side]) return SIDE_OUT[a.side];
    const len = Math.hypot(a.dx, a.dy) || 1;
    return Math.abs(a.dy) >= Math.abs(a.dx) * 0.4 ? { ux: 0, uy: a.dy / len >= 0 ? 1 : -1 } : { ux: a.dx / len, uy: 0 };
  }
  /** 埠名：放在埠往框外的方向（portOut），等寬字型 */
  function portName(c, n, p, s, forced) {
    // 世界座標 9（隨縮放），螢幕上不超過 portPx；強制顯示（滑過、選取）時螢幕上固定 portPx
    const k = forced ? F.portPx / 9 / s : Math.min(1, F.portPx / 9 / s); c.font = font(9 * k, W.normal, true);
    const text = fitText(c, n.label, 9 * k * CV.port.maxEm); const tw = c.measureText(text).width;
    const { ux, uy } = portOut(n.anchor); const vertical = !ux;
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
      if (innerShown('endpoint', s) && n.ini) { c.fillStyle = CV.outline; c.font = font(INNER.endpoint, W.strong); c.textAlign = 'center'; c.fillText(n.ini, p.x, p.y + 2.6); c.textAlign = 'left'; }
    } else if (n.kind === 'downstream') { // Wi-Fi 多 MAC：菱形只作圖面提示
      c.fillStyle = EP.downstream.fill; c.strokeStyle = EP.downstream.stroke; c.lineWidth = 2; c.setLineDash(EP.dash);
      c.beginPath(); c.moveTo(p.x, p.y - r); c.lineTo(p.x + r, p.y); c.lineTo(p.x, p.y + r); c.lineTo(p.x - r, p.y); c.closePath(); c.fill(); c.stroke(); c.setLineDash([]);
      if (innerShown('downstream', s)) { c.fillStyle = EP.downstream.text; c.font = font(INNER.downstream, W.strong); c.textAlign = 'center'; c.fillText(String(n.count || ''), p.x, p.y + 3); c.textAlign = 'left'; }
    } else { // cluster：同一台設備上很多終端，收合成一個
      c.fillStyle = EP.cluster.fill; c.strokeStyle = EP.cluster.stroke; c.lineWidth = 1.5;
      roundRect(c, p.x - r * 1.3, p.y - r * 0.8, r * 2.6, r * 1.6, 5); c.fill(); c.stroke();
      if (innerShown('cluster', s)) { c.fillStyle = EP.cluster.text; c.font = font(INNER.cluster, W.strong); c.textAlign = 'center'; c.fillText('×' + (n.count || ''), p.x, p.y + 3.2); c.textAlign = 'left'; }
    }
  }
  /**
   * 埠名標籤（目前字型已是 portPx / s；k = 1 / s，尺寸都是螢幕 px × k）。與 placed 裡的矩形重疊時：
   * 一般埠名直接略過；force（滑過、選取）時兩端太近就往線中間收，並沿線往外挪 PORT_SLIDE 再試，仍重疊就略過；
   * must（選取或滑過的那條）時仍畫在最後一個位置（一定看得到）。
   * 回傳畫出的矩形或 null。
   */
  function portLabel(c, from, to, text, dist, placed, k, force, must) {
    const len = Math.hypot(to.x - from.x, to.y - from.y); if (!len) return null;
    if (force) dist = Math.min(dist, len * 0.3); else if (len < dist * 2.2) return null;
    text = fitText(c, text, F.portPx * k * CV.port.maxEm); const tw = c.measureText(text).width;
    const hit = (b) => placed.some((o) => o.x0 < b.x1 && b.x0 < o.x1 && o.y0 < b.y1 && b.y0 < o.y1);
    let box = null; let x = 0; let y = 0;
    for (let i = 0; i <= (force ? PORT_TRIES : 0); i++) {
      const d = force ? Math.min(dist + i * PORT_SLIDE * k, len * 0.45) : dist;
      x = from.x + ((to.x - from.x) / len) * d; y = from.y + ((to.y - from.y) / len) * d;
      const b = { x0: x - tw / 2 - 3 * k, x1: x + tw / 2 + 3 * k, y0: y - 8 * k, y1: y + 7 * k };
      if (!hit(b) || (must && i === PORT_TRIES)) { box = b; break; }
    }
    if (!box) return null;
    placed.push(box);
    c.fillStyle = CV.port.bg; c.strokeStyle = CV.port.border; c.lineWidth = 0.6 * k;
    roundRect(c, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, 3 * k); c.fill(); c.stroke();
    c.fillStyle = CV.port.text; c.textAlign = 'center'; c.fillText(text, x, y + 4 * k); c.textAlign = 'left';
    return Object.assign(box, { text });
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
  /**
   * 沿 a→b 每 t.gap 畫一道垂直於線的短刻度（全長 t.len、粗 t.w），顏色與透明度沿用目前的 strokeStyle／globalAlpha。
   * k 與 dash 的縮放相同：縮小時乘上 1/s，讓刻度在螢幕上維持大小；第一道從半個間距開始，兩端留給節點。
   */
  function ticks(c, a, b, t, k) {
    const dx = b.x - a.x; const dy = b.y - a.y; const len = Math.hypot(dx, dy); const gap = t.gap * k; if (!len || !(gap > 0)) return;
    const ux = dx / len; const uy = dy / len; const hx = -uy * t.len * k / 2; const hy = ux * t.len * k / 2;
    c.lineWidth = t.w * k; c.beginPath();
    for (let d = gap / 2; d < len; d += gap) { const x = a.x + ux * d; const y = a.y + uy * d; c.moveTo(x - hx, y - hy); c.lineTo(x + hx, y + hy); }
    c.stroke();
  }
  function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function shade(hex) { const n = parseInt(hex.slice(1), 16); const f = (v) => Math.max(0, Math.floor(v * 0.75)); return '#' + ((f(n >> 16) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255)).toString(16).padStart(6, '0'); }
  function segDist(p, a, b) {
    const dx = b.x - a.x; const dy = b.y - a.y; const l2 = dx * dx + dy * dy; if (!l2) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2; t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function segInView(a, b, v) { return !(Math.max(a.x, b.x) < v.x0 || Math.min(a.x, b.x) > v.x1 || Math.max(a.y, b.y) < v.y0 || Math.min(a.y, b.y) > v.y1); }

  GraphView.LIMITS = Object.freeze({ ZOOM, FIT, FOCUS, TOUCH, MOUSE, OCCLUDER }); // 唯讀：測試核對縮放、聚焦與觸控的界線；OCCLUDER.pinned 給 setOccluders 的呼叫端
  V.GraphView = GraphView; V.sevMark = sevMark; V.fitText = fitText;
})(globalThis.SSOT = globalThis.SSOT || {});
