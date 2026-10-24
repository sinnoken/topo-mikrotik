/*
 * 分層版面（ELK.js，vendor/elkjs-*，EPL-2.0）：只當版面引擎，繪圖仍是 canvas.js 與 theme。
 *  - 分群、終端與層級沿用 layout.js 的 prepare()，與內建版面一致；終端不送進 ELK，仍排在所屬設備下方
 *  - 每群各自用 ELK layered 做多輪交叉最小化與節點擺放，再沿用內建的書架排列
 *  - 節點框預留終端方陣與標籤的空間，ELK 擺放時就不會和其他設備重疊
 * ELK 在 file:// 下沒有 Worker 可用，會在主執行緒計算；群與群之間讓出主執行緒，超過上限或逾時就停止並回報原因。
 * ELK 檔案約 1.6 MB，第一次需要分層版面時才以 <script> 載入（file:// 下一般 script 可正常載入）。
 */
(function (S) {
  'use strict';
  const V = S.view;
  const L = V.layout;
  const LABEL_H = 18; const LEAF_R = 10;
  const ENGINE_SRC = 'vendor/elkjs-0.11.1/elk.bundled.js';
  const OPTIONS = {
    'elk.algorithm': 'layered',
    'elk.direction': 'DOWN',
    'elk.randomSeed': '1',
    'elk.spacing.nodeNode': '48',
    'elk.layered.spacing.nodeNodeBetweenLayers': '72',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.separateConnectedComponents': 'true',
  };

  /** 版面失敗的原因（畫面依 code 顯示說明）。 */
  class ElkLayoutError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  let loading = null;
  function loadEngine() {
    if (typeof globalThis.ELK === 'function') return Promise.resolve();
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script'); s.src = ENGINE_SRC;
        s.onload = () => (typeof globalThis.ELK === 'function' ? resolve() : reject(new ElkLayoutError('unavailable', `${ENGINE_SRC} 載入後找不到 ELK`)));
        s.onerror = () => reject(new ElkLayoutError('unavailable', `無法載入 ${ENGINE_SRC}`));
        (document.head || document.body).appendChild(s);
      }).catch((e) => { loading = null; throw e; }); // 失敗後下次可重試
    }
    return loading;
  }

  /**
   * @param nodes, edges 與 layout() 相同的圖資料
   * @param opt { radius(node) → 半徑, maxNodes, deadlineMs, isStale() → true 時中止 }
   * @returns Promise<{ pos: Map(id→{x,y}), stats: { groups, coreNodes, ms } }>
   */
  async function elk(nodes, edges, opt) {
    const o = Object.assign({ maxNodes: 1500, deadlineMs: 20000, isStale: () => false }, opt);
    const groups = L.prepare(nodes, edges);
    const coreNodes = groups.reduce((n, g) => n + g.core.length, 0);
    if (coreNodes > o.maxNodes) throw new ElkLayoutError('too-large', `網路設備 ${coreNodes} 台，超過分層版面上限 ${o.maxNodes} 台`);
    await loadEngine();
    const engine = new globalThis.ELK();
    const t0 = Date.now(); const boxes = [];
    for (const g of groups) {
      await new Promise((r) => setTimeout(r, 0)); // 讓出主執行緒，畫面才能更新
      if (o.isStale()) throw new ElkLayoutError('stale', '基準已更換，取消分層版面');
      if (Date.now() - t0 > o.deadlineMs) throw new ElkLayoutError('timeout', `分層版面超過 ${Math.round(o.deadlineMs / 1000)} 秒`);
      boxes.push(await layoutGroup(engine, g, o.radius));
    }
    return { pos: L.shelf(boxes), stats: { groups: groups.length, coreNodes, ms: Date.now() - t0 } };
  }

  async function layoutGroup(engine, g, radius) {
    const size = new Map();
    const children = g.core.map((n) => {
      const r = radius(n); const rows = L.leafRows(g, n.id);
      const width = Math.max(2 * r, L.slotW(g, n.id) - 40);
      const height = rows ? r + L.LEAF_DY + (rows - 1) * L.LDY + LEAF_R : 2 * r + LABEL_H;
      size.set(n.id, { width, r });
      return { id: n.id, width, height };
    });
    // 方向依 prepare() 的層級：上層 → 下層；同層依名稱，結果可重現
    const seen = new Set(); const elkEdges = [];
    g.core.forEach((n) => g.adj.get(n.id).forEach((m) => {
      if (!g.inCore.has(m)) return;
      const ln = g.level.get(n.id); const lm = g.level.get(m);
      const [src, dst] = ln < lm || (ln === lm && S.util.natural(n.id, m) < 0) ? [n.id, m] : [m, n.id];
      const k = src + '\u0000' + dst; if (seen.has(k)) return;
      seen.add(k); elkEdges.push({ id: 'e' + elkEdges.length, sources: [src], targets: [dst] });
    }));
    const res = await engine.layout({ id: 'g', layoutOptions: OPTIONS, children, edges: elkEdges });
    const w = res.width || 0; const pos = new Map();
    res.children.forEach((c) => { const s = size.get(c.id); pos.set(c.id, { x: c.x + s.width / 2 - w / 2, y: c.y + s.r }); });
    L.placeLeaves(g, pos);
    return { name: g.name, pos, w: Math.max(w, 1), h: Math.max(res.height || 0, 1), n: g.members.length };
  }

  /**
   * L2 埠圖的分層版面：設備是 ELK 的節點、埠是它的 ports（固定在 portPrepare 決定的上、下緣，同一邊由 ELK 排序以減少交叉），
   * 邊接在埠上。分群與內建版面相同，各群各算一次再以書架排列。
   * @param devs, ports, edges 同 V.layout.portLayout
   * @param opt { maxNodes, deadlineMs, isStale() }
   * @returns Promise<{ pos: Map(dev→{x,y}), anchor: Map(port→{dx,dy}), stats: { groups, nodes, ports, ms } }>
   */
  async function elkPorts(devs, ports, edges, opt) {
    const o = Object.assign({ maxNodes: 1500, deadlineMs: 20000, isStale: () => false }, opt);
    if (devs.length > o.maxNodes) throw new ElkLayoutError('too-large', `設備 ${devs.length} 台，超過分層版面上限 ${o.maxNodes} 台`);
    const P = L.portPrepare(devs, ports, edges);
    await loadEngine();
    const engine = new globalThis.ELK();
    const t0 = Date.now(); const boxes = []; const anchor = new Map();
    const byDev = new Map(); ports.forEach((p) => S.util.getOr(byDev, p.dev, () => []).push(p));
    const box = new Map(devs.map((d) => [d.id, d.box]));
    const PS = V.theme.l2.port.size;
    for (const g of P.groups) {
      await new Promise((r) => setTimeout(r, 0));
      if (o.isStale()) throw new ElkLayoutError('stale', '基準已更換，取消分層版面');
      if (Date.now() - t0 > o.deadlineMs) throw new ElkLayoutError('timeout', `分層版面超過 ${Math.round(o.deadlineMs / 1000)} 秒`);
      const inG = new Set(g.members.map((n) => n.id));
      const children = g.members.map((n) => ({
        id: n.id, width: box.get(n.id).w, height: box.get(n.id).h,
        layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE', 'elk.spacing.portPort': '10' },
        ports: (byDev.get(n.id) || []).map((p) => ({ id: p.id, width: PS, height: PS, layoutOptions: { 'elk.port.side': P.side.get(p.id) === 'north' ? 'NORTH' : 'SOUTH' } })),
      }));
      const elkEdges = [];
      edges.forEach((e) => {
        if (!inG.has(e.aDev) || !inG.has(e.bDev) || e.aDev === e.bDev) return;
        const la = P.level.get(e.aDev) || 0; const lb = P.level.get(e.bDev) || 0;
        const [src, dst] = la < lb || (la === lb && S.util.natural(e.aDev, e.bDev) <= 0) ? [e.a, e.b] : [e.b, e.a];
        elkEdges.push({ id: 'e' + elkEdges.length, sources: [src], targets: [dst] });
      });
      const res = await engine.layout({ id: 'g', layoutOptions: OPTIONS, children, edges: elkEdges });
      const w = res.width || 0; const pos = new Map();
      res.children.forEach((c) => {
        const b = box.get(c.id); pos.set(c.id, { x: c.x + b.w / 2 - w / 2, y: c.y + b.h / 2 });
        // ELK 把埠放在框外緣：y 改成框的上、下緣（邊在 portPrepare 已決定），x 用 ELK 排好的順序
        (c.ports || []).forEach((p) => anchor.set(p.id, { dx: Math.max(-b.w / 2, Math.min(b.w / 2, p.x + PS / 2 - b.w / 2)), dy: P.side.get(p.id) === 'north' ? -b.h / 2 : b.h / 2 }));
      });
      boxes.push({ name: g.name, pos, w: Math.max(w, 1), h: Math.max(res.height || 0, 1), n: g.members.length });
    }
    return { pos: L.shelf(boxes), anchor, stats: { groups: P.groups.length, nodes: devs.length, ports: ports.length, ms: Date.now() - t0 } };
  }

  L.elk = elk;
  L.elkPorts = elkPorts;
  L.ELK_SRC = ENGINE_SRC;
  L.ElkLayoutError = ElkLayoutError;
})(globalThis.SSOT = globalThis.SSOT || {});
