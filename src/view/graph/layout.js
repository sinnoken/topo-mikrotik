/*
 * 版面配置（不跑物理模擬，1000 台以上也能一次算完）：
 *  1. 依分群（命名規則的 group，或連通元件）切開；節點另有 outer（外框，例如 L3 的 VRF）時是兩層分群：外框裡再分內群
 *  2. 每群做分層：防火牆／路由器在最上層，往下依 BFS 距離排；同層依上層位置的重心排序，減少交叉
 *  3. 太寬的層依目標長寬比折成多列（wrapRows，內建與 ELK 共用）；各群以「書架」方式排成接近正方形。
 *     兩層分群或內群有 tier（由外而內的層次，例如 L3 的外部 → 邊界路由網域 → 內部）時改用 arrange：
 *     同一個外框裡依 tier 由上往下一列一列排（同一列內仍是書架），外框再以書架排列
 * forceStep() 提供選用的力導向微調（逐步執行，可看到動畫）。
 */
(function (S) {
  'use strict';
  const V = (S.view = S.view || {});
  const DX = 185; const DY = 130; const ROW = 24; const WRAP_DY = 80; const GAP = 220;
  const LCOLS = 4; const LDX = 44; const LDY = 40; const LEAF_DY = 64; // 終端（主機）排列
  // external：L3 的「外部」虛擬節點（推論的對外邊界），排在最上層
  const RANK = { external: -1, firewall: 0, router: 1, switch: 2, unknown: 3, host: 4 };
  // 書架寬度係數（各群總面積開根號的倍數）。直式畫面（窄螢幕、高大於寬）時書架寬度係數改小，
  // 圖接近直長：全圖時以寬度為限，又扁又寬的圖在直式手機上會縮到看不清
  const SHELF_W = 1.4; const PORTRAIT = { shelfW: 0.8 };
  // 同一層的折行（wrapRows）：每列台數讓這一層接近目標寬高比 aspect，但至少 min 台、至多 max 台。
  // 橫式至少 6 台才折（只有兩三台的上層不會被拆開）；直式目標接近手機圖區（約 390×490），每列 2～6 台
  const WRAP = { land: { aspect: 1.4, min: 6, max: ROW }, portrait: { aspect: 0.8, min: 2, max: 6 } };
  // L2 埠圖：設備框上下列之間的距離（埠名與連線的空間）
  const PORT_GAP_Y = 120;

  /**
   * 分群與終端：每群拆成「核心」與「終端」（只連到一台已收集設備、本身沒有收集資料，之後排在該設備下方），
   * 並依層級規則替核心節點分層。內建版面與 ELK 版面共用這一步，結果一致。
   * 群以「外框＋內群」區分（節點的 outer、group）；回傳的每群另帶 outer、tier（成員 tier 的最小值，沒有時 null）
   * 與 outerRank（成員 outerRank 的最小值，外框的先後），給 arrange 排列。
   */
  function prepare(nodes, edges) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const adj = new Map(nodes.map((n) => [n.id, new Set()]));
    edges.forEach((e) => { if (adj.has(e.a) && adj.has(e.b) && e.a !== e.b) { adj.get(e.a).add(e.b); adj.get(e.b).add(e.a); } });
    const groups = new Map();
    nodes.forEach((n) => S.util.getOr(groups, (n.outer || '') + '\u0000' + (n.group || ''), () => []).push(n));
    const minOf = (members, k) => members.reduce((m, n) => (n[k] == null ? m : m == null ? n[k] : Math.min(m, n[k])), null);
    return Array.from(groups, ([gkey, members]) => {
      const gname = gkey.slice(gkey.indexOf('\u0000') + 1); const outer = members[0].outer || '';
      const inG = new Set(members.map((n) => n.id));
      const leafOf = new Map();
      members.forEach((n) => {
        if (n.collected) return;
        const nb = Array.from(adj.get(n.id)).filter((x) => inG.has(x));
        if (nb.length === 1 && byId.get(nb[0]).collected) leafOf.set(n.id, nb[0]);
      });
      const leaves = new Map();
      leafOf.forEach((p, id) => S.util.getOr(leaves, p, () => []).push(id));
      leaves.forEach((ids) => ids.sort(S.util.natural));
      const core = members.filter((n) => !leafOf.has(n.id));
      const inCore = new Set(core.map((n) => n.id));
      const level = new Map();
      const remaining = new Set(inCore);
      while (remaining.size) {
        const comp = []; const stack = [remaining.values().next().value]; const seen = new Set(stack);
        while (stack.length) { const x = stack.pop(); comp.push(x); adj.get(x).forEach((y) => { if (inCore.has(y) && !seen.has(y)) { seen.add(y); stack.push(y); } }); }
        comp.forEach((x) => remaining.delete(x));
        // 第 0 層：防火牆／路由器；第 1 層：核心節點（連線數接近最大者，例如核心交換器）；其餘依距離往下
        const deg = (x) => Array.from(adj.get(x)).filter((y) => inCore.has(y)).length;
        const maxDeg = Math.max(...comp.map(deg));
        const tops = comp.filter((x) => (RANK[byId.get(x).kind] ?? 3) <= 1);
        const hubs = comp.filter((x) => !tops.includes(x) && maxDeg >= 4 && deg(x) >= maxDeg * 0.6);
        const seeds = new Map();
        tops.forEach((x) => seeds.set(x, 0));
        hubs.forEach((x) => seeds.set(x, tops.length ? 1 : 0));
        if (!seeds.size) seeds.set(comp.reduce((a, b) => (deg(b) > deg(a) ? b : a)), 0);
        const buckets = [];
        seeds.forEach((l, x) => { level.set(x, l); (buckets[l] || (buckets[l] = [])).push(x); });
        for (let l = 0; l < buckets.length; l++) {
          (buckets[l] || []).forEach((x) => adj.get(x).forEach((y) => {
            if (inCore.has(y) && !level.has(y)) { level.set(y, l + 1); (buckets[l + 1] || (buckets[l + 1] = [])).push(y); }
          }));
        }
        comp.forEach((x) => { if (!level.has(x)) level.set(x, buckets.length); });
      }
      return { name: gname, outer, tier: minOf(members, 'tier'), outerRank: minOf(members, 'outerRank'), members, core, inCore, leaves, level, byId, adj };
    });
  }
  /** prepare 的一群排好之後的框：{ name, pos, w, h, n } 加上 arrange 用的 outer、tier、outerRank */
  const groupBox = (g, pos, w, h) => ({ name: g.name, outer: g.outer, tier: g.tier, outerRank: g.outerRank, pos, w, h, n: g.members.length });

  // 每個節點佔的寬度＝自己或其終端群的寬度
  const leafCols = (g, id) => Math.min(LCOLS, (g.leaves.get(id) || []).length);
  const leafRows = (g, id) => Math.ceil((g.leaves.get(id) || []).length / LCOLS);
  const slotW = (g, id) => Math.max(DX, leafCols(g, id) * LDX + 40);

  /** 終端排在所屬設備下方的小方陣。 */
  function placeLeaves(g, pos) {
    g.leaves.forEach((ids, p) => {
      const pp = pos.get(p); if (!pp) return;
      const cols = Math.min(LCOLS, ids.length);
      ids.forEach((id, i) => pos.set(id, { x: pp.x + ((i % cols) - (cols - 1) / 2) * LDX, y: pp.y + LEAF_DY + Math.floor(i / cols) * LDY }));
    });
  }

  /**
   * 同一層太多台時折成多列：items 依原順序（重心或 ELK 的交叉最小化結果）切成幾段，每段台數平均。
   * w(item)、h(item) 是每台佔的寬與列高（含間距）；回傳 [[item…]…]。
   */
  function wrapRows(items, w, h, portrait) {
    const n = items.length; if (n < 2) return [items.slice()];
    const R = portrait ? WRAP.portrait : WRAP.land;
    const avgW = items.reduce((s, x) => s + w(x), 0) / n; const rowH = Math.max(...items.map(h));
    const cols = Math.max(R.min, Math.min(R.max, Math.round(Math.sqrt((n * R.aspect * rowH) / Math.max(avgW, 1)))));
    const rows = Math.ceil(n / cols); const per = Math.ceil(n / rows); const out = [];
    for (let i = 0; i < n; i += per) out.push(items.slice(i, i + per));
    return out;
  }

  /** 各群以「書架」方式排成接近正方形（opt.portrait 時偏直長）；box：{ name, pos（群內座標，x 以 0 為中心）, w, h, n }。 */
  function shelf(boxes, opt) { return shelfPlace(boxes, opt).pos; }
  /** shelf 的本體：另回傳整個書架的寬高（左上是 0,0）。opt.ordered：依傳入的順序，不依大小重排 */
  function shelfPlace(boxes, opt) {
    if (!(opt && opt.ordered)) boxes.sort((a, b) => b.n - a.n || S.util.natural(a.name, b.name));
    const area = boxes.reduce((s, b) => s + (b.w + GAP) * (b.h + GAP), 0);
    const maxW = Math.max(Math.sqrt(area) * (opt && opt.portrait ? PORTRAIT.shelfW : SHELF_W), ...boxes.map((b) => b.w));
    const out = new Map(); let cx = 0; let cy = 0; let shelfH = 0; let w = 0;
    boxes.forEach((b) => {
      if (cx > 0 && cx + b.w > maxW) { cx = 0; cy += shelfH + GAP; shelfH = 0; }
      b.pos.forEach((p, id) => out.set(id, { x: p.x + cx + b.w / 2, y: p.y + cy }));
      cx += b.w + GAP; w = Math.max(w, cx - GAP); shelfH = Math.max(shelfH, b.h);
    });
    return { pos: out, w, h: cy + shelfH };
  }
  /**
   * 兩層分群與由外而內的排列（內建版面與 ELK 共用）：boxes 是各內群排好的框（groupBox）。
   * 沒有任何框帶 outer 或 tier 時就是 shelf（設備圖、L2 不受影響）。否則：
   *  - 同一個外框（outer）的內群依 tier 由小到大一列一列往下排（沒有 tier 的排在最後），同一列以書架排列、置中；
   *  - 外框依 outerRank（再依名稱）以書架排列，不依大小重排（例如 L3 的 VRF main 在最前）。
   */
  function arrange(boxes, opt) {
    if (!boxes.some((b) => b.outer || b.tier != null)) return shelf(boxes, opt);
    const outers = new Map();
    boxes.forEach((b) => S.util.getOr(outers, b.outer || '', () => []).push(b));
    const rank = (list) => list.reduce((m, b) => (b.outerRank == null ? m : Math.min(m, b.outerRank)), Infinity);
    const framed = Array.from(outers, ([name, list]) => {
      const tiers = new Map();
      list.forEach((b) => S.util.getOr(tiers, b.tier == null ? Infinity : b.tier, () => []).push(b));
      const rows = Array.from(tiers.keys()).sort((a, b) => a - b).map((k) => shelfPlace(tiers.get(k), opt));
      const pos = new Map(); let y = 0;
      rows.forEach((r) => { r.pos.forEach((p, id) => pos.set(id, { x: p.x - r.w / 2, y: p.y + y })); y += r.h + GAP; });
      return { name, rank: rank(list), pos, w: Math.max(...rows.map((r) => r.w), 1), h: Math.max(y - GAP, 1), n: list.reduce((s, b) => s + b.n, 0) };
    }).sort((a, b) => a.rank - b.rank || S.util.natural(a.name, b.name));
    return shelf(framed, Object.assign({}, opt, { ordered: true }));
  }

  /** 內建版面：BFS 分層＋一輪重心排序＋太寬折行（同步，1000 台以上也能一次算完）。opt.portrait：直式畫面，改直長排列。 */
  function layout(nodes, edges, opt) {
    const portrait = !!(opt && opt.portrait);
    return arrange(prepare(nodes, edges).map((g) => {
      const { core, level, byId, adj } = g;
      const layers = [];
      core.forEach((n) => { const l = level.get(n.id) || 0; (layers[l] || (layers[l] = [])).push(n.id); });
      // 重心排序
      const order = new Map();
      layers.forEach((ids, l) => {
        if (!ids) return;
        if (l === 0) ids.sort((a, b) => (RANK[byId.get(a).kind] ?? 3) - (RANK[byId.get(b).kind] ?? 3) || S.util.natural(a, b));
        else {
          const bc = (id) => { const ps = Array.from(adj.get(id)).filter((p) => level.get(p) === l - 1 && order.has(p)); return ps.length ? ps.reduce((s2, p) => s2 + order.get(p), 0) / ps.length : 1e9; };
          const w = new Map(ids.map((id) => [id, bc(id)]));
          ids.sort((a, b) => w.get(a) - w.get(b) || S.util.natural(a, b));
        }
        ids.forEach((id, i) => order.set(id, i));
      });
      const pos = new Map(); let y = 0; let width = 0;
      layers.forEach((ids) => {
        if (!ids || !ids.length) return;
        wrapRows(ids, (id) => slotW(g, id), (id) => WRAP_DY + leafRows(g, id) * LDY, portrait).forEach((row) => {
          const total = row.reduce((s2, id) => s2 + slotW(g, id), 0); let x = -total / 2;
          row.forEach((id) => { pos.set(id, { x: x + slotW(g, id) / 2, y }); x += slotW(g, id); });
          width = Math.max(width, total);
          const extra = Math.max(0, ...row.map((id) => leafRows(g, id))) * LDY;
          y += WRAP_DY + extra;
        });
        y += DY - WRAP_DY;
      });
      placeLeaves(g, pos);
      return groupBox(g, pos, Math.max(width, DX), Math.max(y - (DY - WRAP_DY), DY / 2));
    }), opt);
  }

  /** 力導向微調一步（格網加速的 Fruchterman–Reingold）。回傳本步最大位移。 */
  function forceStep(nodes, edges, pos, temp) {
    const k = 110; const cell = k * 2; const grid = new Map(); const disp = new Map();
    nodes.forEach((n) => { const p = pos.get(n.id); disp.set(n.id, { x: 0, y: 0 }); const key = Math.floor(p.x / cell) + ',' + Math.floor(p.y / cell); S.util.getOr(grid, key, () => []).push(n.id); });
    nodes.forEach((n) => {
      const p = pos.get(n.id); const gx = Math.floor(p.x / cell); const gy = Math.floor(p.y / cell); const d = disp.get(n.id);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) (grid.get((gx + i) + ',' + (gy + j)) || []).forEach((m) => {
        if (m === n.id) return; const q = pos.get(m); let dx = p.x - q.x; let dy = p.y - q.y; let dist = Math.hypot(dx, dy);
        if (dist < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist = 0.5; }
        if (dist > cell) return; const f = (k * k) / dist; d.x += (dx / dist) * f; d.y += (dy / dist) * f;
      });
    });
    edges.forEach((e) => {
      const p = pos.get(e.a); const q = pos.get(e.b); if (!p || !q) return;
      const dx = p.x - q.x; const dy = p.y - q.y; const dist = Math.max(Math.hypot(dx, dy), 0.01); const f = (dist * dist) / k;
      const da = disp.get(e.a); const db = disp.get(e.b); if (!da || !db) return;
      da.x -= (dx / dist) * f; da.y -= (dy / dist) * f; db.x += (dx / dist) * f; db.y += (dy / dist) * f;
    });
    let maxMove = 0;
    nodes.forEach((n) => {
      if (n.pinned) return;
      const d = disp.get(n.id); const len = Math.hypot(d.x, d.y); if (!len) return;
      const m = Math.min(len, temp); const p = pos.get(n.id);
      pos.set(n.id, { x: p.x + (d.x / len) * m, y: p.y + (d.y / len) * m }); maxMove = Math.max(maxMove, m);
    });
    return maxMove;
  }

  /**
   * L2 埠圖的共用步驟：設備層級（prepare 的分層，終端排在所屬設備的下一層）與層級規則的初始邊。
   * 對端在較上層的埠放在框的上緣（north），其餘放下緣（south）。這個 side 只給 ELK 的 port 約束與排位置用；
   * 埠最後在哪一邊由設備位置排好後的 portSides 決定（內建版面、ELK 與拖曳共用）。
   *   devs [{ id, kind, collected, group, box: { w, h } }]、ports [{ id, dev }]、edges [{ a, b, aDev, bDev }]
   * 回傳 { groups（prepare 的結果）, level: Map(dev→層), side: Map(port→'north'|'south'), peers: Map(port→[對端設備]) }
   */
  function portPrepare(devs, ports, edges) {
    const seen = new Set(); const devEdges = [];
    edges.forEach((e) => { const k = e.aDev < e.bDev ? e.aDev + '\u0000' + e.bDev : e.bDev + '\u0000' + e.aDev; if (e.aDev !== e.bDev && !seen.has(k)) { seen.add(k); devEdges.push({ a: e.aDev, b: e.bDev }); } });
    const groups = prepare(devs, devEdges);
    const level = new Map();
    groups.forEach((g) => { g.level.forEach((l, id) => level.set(id, l)); g.leaves.forEach((ids, p) => ids.forEach((id) => level.set(id, (g.level.get(p) || 0) + 1))); });
    const peers = portPeers(edges);
    const side = new Map();
    ports.forEach((p) => {
      const mine = level.get(p.dev) || 0; const ps = peers.get(p.id) || [];
      side.set(p.id, ps.length && ps.every((d) => (level.get(d) || 0) < mine) ? 'north' : 'south');
    });
    return { groups, level, side, peers };
  }
  /** 每個埠的對端設備：edges [{ a, b, aDev, bDev }] → Map(port→[對端設備])（LAG、一埠看到多台時有多個） */
  function portPeers(edges) {
    const peers = new Map();
    edges.forEach((e) => { S.util.getOr(peers, e.a, () => []).push(e.bDev); S.util.getOr(peers, e.b, () => []).push(e.aDev); });
    return peers;
  }
  /** 對端的平均位置與自己框中心的向量；沒有對端（或對端都沒有位置、或就是自己）時為 null */
  function peerVec(p, peers, pos) {
    const c = pos.get(p.dev); if (!c) return null;
    const ps = (peers.get(p.id) || []).filter((d) => d !== p.dev).map((d) => pos.get(d)).filter(Boolean);
    if (!ps.length) return null;
    const x = ps.reduce((s, q) => s + q.x, 0) / ps.length; const y = ps.reduce((s, q) => s + q.y, 0) / ps.length;
    return x === c.x && y === c.y ? null : { dx: x - c.x, dy: y - c.y, x, y };
  }
  // 選邊的遲滯（弧度，約 8°）：埠已在某一邊時，對端方向要越過框的對角線這麼多才換邊，拖曳時埠不會在對角線附近來回跳
  const SIDE_HYST = 0.14;
  const VERTICAL = { north: true, south: true }; const HORIZONTAL = { east: true, west: true };
  /**
   * L2 埠依鏈路方向選邊（設備位置排好後）：框中心到對端框中心（多個對端取平均）的向量 (dx, dy)，
   * 角度比框的對角線陡（|dy|/|dx| > h/w）放上下緣（依 dy），否則放左右緣（依 dx）；沒有對端的埠放下緣。
   * 對角線的 h 用主題的基本框高（theme.l2.box.h），不用 portAnchors 加高後的框高：否則加高→對角線變陡→更多埠到左右→再加高，
   * 同樣的位置重算會得到不同的邊。
   * prev（選用，Map(port→邊)）：前一次的邊，越過對角線 SIDE_HYST 以上才換邊。內建版面、ELK 與拖曳共用。
   *   devs [{ id, box: { w, h } }]、ports [{ id, dev }]、peers（portPeers 的結果）、pos Map(dev→{x,y})
   * 回傳 Map(port→'north'|'south'|'east'|'west')
   */
  function portSides(devs, ports, peers, pos, prev) {
    const box = new Map(devs.map((d) => [d.id, d.box])); const side = new Map();
    const baseH = V.theme && V.theme.l2 && V.theme.l2.box && V.theme.l2.box.h;
    ports.forEach((p) => {
      const v = peerVec(p, peers, pos); const b = box.get(p.dev);
      if (!v || !b) { side.set(p.id, 'south'); return; }
      const was = prev && prev.get(p.id);
      const diag = Math.atan2(baseH || b.h, b.w) + (VERTICAL[was] ? -SIDE_HYST : HORIZONTAL[was] ? SIDE_HYST : 0);
      const vertical = Math.atan2(Math.abs(v.dy), Math.abs(v.dx)) > diag;
      side.set(p.id, vertical ? (v.dy < 0 ? 'north' : 'south') : (v.dx < 0 ? 'west' : 'east'));
    });
    return side;
  }
  /** 依框的大小把埠平均排在各邊（上下緣沿 x、左右緣沿 y）；order 決定同一邊的先後（預設依埠名） */
  function placePorts(devs, ports, side, order) {
    const anchor = new Map(); const byDev = new Map();
    ports.forEach((p) => S.util.getOr(byDev, p.dev + '\u0000' + side.get(p.id), () => []).push(p));
    const box = new Map(devs.map((d) => [d.id, d.box]));
    byDev.forEach((list, k) => {
      const [dev, sd] = k.split('\u0000'); const b = box.get(dev); if (!b) return;
      list.sort(order || ((x, y) => S.util.natural(x.name || x.id, y.name || y.id)));
      const at = (i, len) => -len / 2 + ((i + 1) * len) / (list.length + 1);
      list.forEach((p, i) => anchor.set(p.id, HORIZONTAL[sd]
        ? { dx: sd === 'west' ? -b.w / 2 : b.w / 2, dy: at(i, b.h) }
        : { dx: at(i, b.w), dy: sd === 'north' ? -b.h / 2 : b.h / 2 }));
    });
    return anchor;
  }
  /**
   * 選邊與埠的位置（portSides＋placePorts）：同一邊依對端在該邊的投影排序（上下緣依 x、左右緣依 y），線比較少交叉；
   * 左右緣的埠多時框加高（至少 (埠數＋1)×portGap，不低於主題的框高）。
   * opt { prev（前一次的邊，遲滯用）, minH, gap }。回傳 { side, anchor, box: Map(dev→{w,h}) }（box 是新的框大小，呼叫端套用）
   */
  function portAnchors(devs, ports, peers, pos, opt) {
    const o = opt || {}; const B = (V.theme && V.theme.l2 && V.theme.l2.box) || {};
    const minH = o.minH ?? B.h; const gap = o.gap ?? B.portGap;
    const side = portSides(devs, ports, peers, pos, o.prev);
    const sideN = new Map();
    ports.forEach((p) => { const s = side.get(p.id); if (HORIZONTAL[s]) { const k = p.dev + '\u0000' + s; sideN.set(k, (sideN.get(k) || 0) + 1); } });
    const box = new Map(devs.map((d) => {
      const n = Math.max(sideN.get(d.id + '\u0000east') || 0, sideN.get(d.id + '\u0000west') || 0);
      return [d.id, { w: d.box.w, h: Math.max(minH ?? d.box.h, n ? (n + 1) * gap : 0) }];
    }));
    const key = new Map(ports.map((p) => { const v = peerVec(p, peers, pos); return [p.id, v ? (HORIZONTAL[side.get(p.id)] ? v.y : v.x) : Infinity]; }));
    const anchor = placePorts(devs.map((d) => ({ id: d.id, box: box.get(d.id) })), ports, side,
      (a, b) => key.get(a.id) - key.get(b.id) || S.util.natural(a.name || a.id, b.name || b.id));
    return { side, anchor, box };
  }
  /**
   * L2 埠圖的內建版面（同步）：設備框依層級逐列排開（太寬時折行），各群以書架排列；排好後由 portAnchors 依鏈路方向選邊。
   * 回傳 { pos: Map(dev→{x,y}), anchor: Map(port→{dx,dy}), side: Map(port→邊), box: Map(dev→{w,h}) }
   */
  function portLayout(devs, ports, edges, opt) {
    const portrait = !!(opt && opt.portrait);
    const P = portPrepare(devs, ports, edges); const GAPX = 60; const GAPY = PORT_GAP_Y; const MAXW = 2600;
    const byId = new Map(devs.map((d) => [d.id, d]));
    const boxes = P.groups.map((g) => {
      const layers = [];
      g.members.forEach((n) => { const l = P.level.get(n.id) || 0; (layers[l] || (layers[l] = [])).push(n.id); });
      const pos = new Map(); let y = 0; let width = 0;
      layers.forEach((ids) => {
        if (!ids || !ids.length) return;
        ids.sort((a, b) => (RANK[byId.get(a).kind] ?? 3) - (RANK[byId.get(b).kind] ?? 3) || S.util.natural(a, b));
        // 一層太多台時依目標寬高比折行（與設備圖同一個 wrapRows），每列仍不超過 MAXW：整張圖才不會是一條扁平橫條
        const rows = [];
        wrapRows(ids, (id) => byId.get(id).box.w + GAPX, (id) => byId.get(id).box.h + GAPY, portrait).forEach((part) => {
          let row = []; let rowW = 0;
          part.forEach((id) => { const w = byId.get(id).box.w; if (row.length && rowW + w > MAXW) { rows.push(row); row = []; rowW = 0; } rowW += (row.length ? GAPX : 0) + w; row.push(id); });
          if (row.length) rows.push(row);
        });
        rows.forEach((row) => {
          const rowW = row.reduce((s, id) => s + byId.get(id).box.w, 0) + GAPX * (row.length - 1);
          let x = -rowW / 2; const h = Math.max(...row.map((id) => byId.get(id).box.h));
          row.forEach((id) => { const w = byId.get(id).box.w; pos.set(id, { x: x + w / 2, y: y + h / 2 }); x += w + GAPX; });
          width = Math.max(width, rowW); y += h + GAPY;
        });
      });
      return { name: g.name, pos, w: Math.max(width, 1), h: Math.max(y - GAPY, 1), n: g.members.length };
    });
    const pos = shelf(boxes, { portrait });
    return Object.assign({ pos }, portAnchors(devs, ports, P.peers, pos));
  }

  V.layout = { layout, forceStep, prepare, groupBox, placeLeaves, shelf, arrange, wrapRows, slotW, leafRows, RANK, GAP, LDY, LEAF_DY, portPrepare, placePorts, portLayout, portPeers, portSides, portAnchors, SIDE_HYST };
})(globalThis.SSOT = globalThis.SSOT || {});

/*
 * 社群偵測（標籤傳播）：沒有命名規則、而整張網路又連成一大片時，
 * 用鏈路密度自動切出「分群」，讓版面分區排列（只影響畫面，不寫回基準）。
 */
(function (S) {
  'use strict';
  const V = S.view;
  V.layout.communities = function (nodes, edges, opt) {
    const minSize = (opt && opt.minComponent) || 120;
    const ids = nodes.map((n) => n.id); const byId = new Map(nodes.map((n) => [n.id, n]));
    const w = new Map(ids.map((id) => [id, new Map()]));
    edges.forEach((e) => {
      if (!w.has(e.a) || !w.has(e.b) || e.a === e.b) return;
      const k = e.count || 1;
      w.get(e.a).set(e.b, (w.get(e.a).get(e.b) || 0) + k); w.get(e.b).set(e.a, (w.get(e.b).get(e.a) || 0) + k);
    });
    const label = new Map(ids.map((id) => [id, id]));
    const core = ids.filter((id) => byId.get(id).collected).sort((a, b) => w.get(b).size - w.get(a).size || S.util.natural(a, b));
    for (let round = 0; round < 25; round++) {
      let changed = 0;
      core.forEach((id) => {
        const score = new Map();
        w.get(id).forEach((wt, nb) => { if (byId.get(nb).collected) score.set(label.get(nb), (score.get(label.get(nb)) || 0) + wt); });
        if (!score.size) return;
        let best = null; let bs = -1;
        score.forEach((sc, l) => { if (sc > bs || (sc === bs && (l === label.get(id) || (best !== label.get(id) && l < best)))) { best = l; bs = sc; } });
        if (best !== label.get(id)) { label.set(id, best); changed++; }
      });
      if (!changed) break;
    }
    // 未收集的終端跟著鄰居
    ids.forEach((id) => { if (!byId.get(id).collected) { const nb = Array.from(w.get(id).keys()).find((x) => byId.get(x).collected); if (nb) label.set(id, label.get(nb)); } });
    // 依大小命名：以群內層級最高的設備當名稱
    const RANK = V.layout.RANK;
    const groups = new Map();
    ids.forEach((id) => S.util.getOr(groups, label.get(id), () => []).push(id));
    if (groups.size < 2 || nodes.length < minSize) return null;
    const out = new Map(); let n = 0;
    Array.from(groups.values()).sort((a, b) => b.length - a.length).forEach((members) => {
      const top = members.slice().sort((a, b) => (RANK[byId.get(a).kind] ?? 3) - (RANK[byId.get(b).kind] ?? 3) || w.get(b).size - w.get(a).size || S.util.natural(a, b))[0];
      const name = `${V.TERMS.group} ${++n}（${byId.get(top).label}…）`;
      members.forEach((id) => out.set(id, name));
    });
    return out;
  };
})(globalThis.SSOT = globalThis.SSOT || {});
