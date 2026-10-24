/*
 * 版面配置（不跑物理模擬，1000 台以上也能一次算完）：
 *  1. 依分群（命名規則的 group，或連通元件）切開
 *  2. 每群做分層：防火牆／路由器在最上層，往下依 BFS 距離排；同層依上層位置的重心排序，減少交叉
 *  3. 太寬的層自動折行；各群以「書架」方式排成接近正方形
 * forceStep() 提供選用的力導向微調（逐步執行，可看到動畫）。
 */
(function (S) {
  'use strict';
  const V = (S.view = S.view || {});
  const DX = 185; const DY = 130; const ROW = 24; const WRAP_DY = 80; const GAP = 220;
  const LCOLS = 4; const LDX = 44; const LDY = 40; const LEAF_DY = 64; // 終端（主機）排列
  const RANK = { firewall: 0, router: 1, switch: 2, unknown: 3, host: 4 };

  /**
   * 分群與終端：每群拆成「核心」與「終端」（只連到一台已收集設備、本身沒有收集資料，之後排在該設備下方），
   * 並依層級規則替核心節點分層。內建版面與 ELK 版面共用這一步，結果一致。
   */
  function prepare(nodes, edges) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const adj = new Map(nodes.map((n) => [n.id, new Set()]));
    edges.forEach((e) => { if (adj.has(e.a) && adj.has(e.b) && e.a !== e.b) { adj.get(e.a).add(e.b); adj.get(e.b).add(e.a); } });
    const groups = new Map();
    nodes.forEach((n) => S.util.getOr(groups, n.group || '', () => []).push(n));
    return Array.from(groups, ([gname, members]) => {
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
      return { name: gname, members, core, inCore, leaves, level, byId, adj };
    });
  }

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

  /** 各群以「書架」方式排成接近正方形；box：{ name, pos（群內座標，x 以 0 為中心）, w, h, n }。 */
  function shelf(boxes) {
    boxes.sort((a, b) => b.n - a.n || S.util.natural(a.name, b.name));
    const area = boxes.reduce((s, b) => s + (b.w + GAP) * (b.h + GAP), 0);
    const maxW = Math.max(Math.sqrt(area) * 1.4, ...boxes.map((b) => b.w));
    const out = new Map(); let cx = 0; let cy = 0; let shelfH = 0;
    boxes.forEach((b) => {
      if (cx > 0 && cx + b.w > maxW) { cx = 0; cy += shelfH + GAP; shelfH = 0; }
      b.pos.forEach((p, id) => out.set(id, { x: p.x + cx + b.w / 2, y: p.y + cy }));
      cx += b.w + GAP; shelfH = Math.max(shelfH, b.h);
    });
    return out;
  }

  /** 內建版面：BFS 分層＋一輪重心排序＋太寬折行（同步，1000 台以上也能一次算完）。 */
  function layout(nodes, edges) {
    return shelf(prepare(nodes, edges).map((g) => {
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
        for (let r = 0; r * ROW < ids.length; r++) {
          const row = ids.slice(r * ROW, (r + 1) * ROW);
          const total = row.reduce((s2, id) => s2 + slotW(g, id), 0); let x = -total / 2;
          row.forEach((id) => { pos.set(id, { x: x + slotW(g, id) / 2, y }); x += slotW(g, id); });
          width = Math.max(width, total);
          const extra = Math.max(0, ...row.map((id) => leafRows(g, id))) * LDY;
          y += WRAP_DY + extra;
        }
        y += DY - WRAP_DY;
      });
      placeLeaves(g, pos);
      return { name: g.name, pos, w: Math.max(width, DX), h: Math.max(y - (DY - WRAP_DY), DY / 2), n: g.members.length };
    }));
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
   * L2 埠圖的共用步驟：設備層級（prepare 的分層，終端排在所屬設備的下一層）與每個埠在框的哪一邊。
   * 對端在較上層的埠放在框的上緣（north），其餘放下緣（south）；內建版面與 ELK 共用，結果一致。
   *   devs [{ id, kind, collected, group, box: { w, h } }]、ports [{ id, dev }]、edges [{ a, b, aDev, bDev }]
   * 回傳 { groups（prepare 的結果）, level: Map(dev→層), side: Map(port→'north'|'south'), peers: Map(port→[對端設備]) }
   */
  function portPrepare(devs, ports, edges) {
    const seen = new Set(); const devEdges = [];
    edges.forEach((e) => { const k = e.aDev < e.bDev ? e.aDev + '\u0000' + e.bDev : e.bDev + '\u0000' + e.aDev; if (e.aDev !== e.bDev && !seen.has(k)) { seen.add(k); devEdges.push({ a: e.aDev, b: e.bDev }); } });
    const groups = prepare(devs, devEdges);
    const level = new Map();
    groups.forEach((g) => { g.level.forEach((l, id) => level.set(id, l)); g.leaves.forEach((ids, p) => ids.forEach((id) => level.set(id, (g.level.get(p) || 0) + 1))); });
    const peers = new Map();
    edges.forEach((e) => { S.util.getOr(peers, e.a, () => []).push(e.bDev); S.util.getOr(peers, e.b, () => []).push(e.aDev); });
    const side = new Map();
    ports.forEach((p) => {
      const mine = level.get(p.dev) || 0; const ps = peers.get(p.id) || [];
      side.set(p.id, ps.length && ps.every((d) => (level.get(d) || 0) < mine) ? 'north' : 'south');
    });
    return { groups, level, side, peers };
  }
  /** 依框的大小把埠平均排在上、下緣；order 決定同一邊的先後（預設依埠名） */
  function placePorts(devs, ports, side, order) {
    const anchor = new Map(); const byDev = new Map();
    ports.forEach((p) => S.util.getOr(byDev, p.dev + '\u0000' + side.get(p.id), () => []).push(p));
    const box = new Map(devs.map((d) => [d.id, d.box]));
    byDev.forEach((list, k) => {
      const [dev, sd] = k.split('\u0000'); const b = box.get(dev); if (!b) return;
      list.sort(order || ((x, y) => S.util.natural(x.name || x.id, y.name || y.id)));
      list.forEach((p, i) => anchor.set(p.id, { dx: -b.w / 2 + ((i + 1) * b.w) / (list.length + 1), dy: sd === 'north' ? -b.h / 2 : b.h / 2 }));
    });
    return anchor;
  }
  /**
   * L2 埠圖的內建版面（同步）：設備框依層級逐列排開（太寬時折行），各群以書架排列；埠排在框的上、下緣，
   * 同一邊依對端設備的 x 排序，線比較少交叉。回傳 { pos: Map(dev→{x,y}), anchor: Map(port→{dx,dy}) }
   */
  function portLayout(devs, ports, edges) {
    const P = portPrepare(devs, ports, edges); const GAPX = 60; const GAPY = 120; const MAXW = 2600;
    const byId = new Map(devs.map((d) => [d.id, d]));
    const boxes = P.groups.map((g) => {
      const layers = [];
      g.members.forEach((n) => { const l = P.level.get(n.id) || 0; (layers[l] || (layers[l] = [])).push(n.id); });
      const pos = new Map(); let y = 0; let width = 0;
      layers.forEach((ids) => {
        if (!ids || !ids.length) return;
        ids.sort((a, b) => (RANK[byId.get(a).kind] ?? 3) - (RANK[byId.get(b).kind] ?? 3) || S.util.natural(a, b));
        let row = []; let rowW = 0;
        const flush = () => {
          if (!row.length) return;
          let x = -rowW / 2; const h = Math.max(...row.map((id) => byId.get(id).box.h));
          row.forEach((id) => { const w = byId.get(id).box.w; pos.set(id, { x: x + w / 2, y: y + h / 2 }); x += w + GAPX; });
          width = Math.max(width, rowW); y += h + GAPY; row = []; rowW = 0;
        };
        ids.forEach((id) => { const w = byId.get(id).box.w; if (row.length && rowW + w > MAXW) flush(); rowW += (row.length ? GAPX : 0) + w; row.push(id); });
        flush();
      });
      return { name: g.name, pos, w: Math.max(width, 1), h: Math.max(y - GAPY, 1), n: g.members.length };
    });
    const pos = shelf(boxes);
    const peerX = (p) => { const ps = P.peers.get(p.id) || []; return ps.length ? ps.reduce((s, d) => s + ((pos.get(d) || { x: 0 }).x), 0) / ps.length : Infinity; };
    const anchor = placePorts(devs, ports, P.side, (a, b) => peerX(a) - peerX(b) || S.util.natural(a.name || a.id, b.name || b.id));
    return { pos, anchor };
  }

  V.layout = { layout, forceStep, prepare, placeLeaves, shelf, slotW, leafRows, RANK, LDY, LEAF_DY, portPrepare, placePorts, portLayout };
})(globalThis.SSOT = globalThis.SSOT || {});

/*
 * 社群偵測（標籤傳播）：沒有命名規則、而整張網路又連成一大片時，
 * 用連線密度自動切出「區域」，讓版面分區排列（只影響畫面，不寫回基準）。
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
    const RANK = { firewall: 0, router: 1, switch: 2, unknown: 3, host: 4 };
    const groups = new Map();
    ids.forEach((id) => S.util.getOr(groups, label.get(id), () => []).push(id));
    if (groups.size < 2 || nodes.length < minSize) return null;
    const out = new Map(); let n = 0;
    Array.from(groups.values()).sort((a, b) => b.length - a.length).forEach((members) => {
      const top = members.slice().sort((a, b) => (RANK[byId.get(a).kind] ?? 3) - (RANK[byId.get(b).kind] ?? 3) || w.get(b).size - w.get(a).size || S.util.natural(a, b))[0];
      const name = `區域 ${++n}（${byId.get(top).label}…）`;
      members.forEach((id) => out.set(id, name));
    });
    return out;
  };
})(globalThis.SSOT = globalThis.SSOT || {});
