// 畫面冒煙測試的 step：L2 埠依鏈路方向選邊（框的上下左右四邊；內建版面、ELK 與拖曳共用 V.layout.portSides）。
'use strict';
const { S, winListeners, step, $, flushRaf, recordCanvas, withGraph } = require('../helpers.js');
const assert = require('assert');

const L = () => S.view.layout;
const BOX = () => ({ w: 120, h: S.view.theme.l2.box.h });
/** 合成的小圖：devs 的 id 與 kind、links [[埠, 設備, 埠, 設備]] */
function graph(devs, links) {
  const ds = devs.map(([id, kind]) => ({ id, kind, collected: true, group: '', box: BOX() }));
  const ports = []; const edges = [];
  links.forEach(([a, ad, b, bd]) => { ports.push({ id: a, dev: ad, name: a }, { id: b, dev: bd, name: b }); edges.push({ a, b, aDev: ad, bDev: bd }); });
  return { devs: ds, ports, edges };
}
/** anchor 所在的邊 */
function sideOf(a, box) {
  if (Math.abs(a.dy + box.h / 2) < 1e-6) return 'north';
  if (Math.abs(a.dy - box.h / 2) < 1e-6) return 'south';
  if (Math.abs(a.dx + box.w / 2) < 1e-6) return 'west';
  if (Math.abs(a.dx - box.w / 2) < 1e-6) return 'east';
  return '?';
}

module.exports = async () => {
  await step('L2 埠選邊：同層兩台互連時兩端的埠在相對的左右邊，對端在正上方時在上緣、正下方在下緣，沒有對端維持下緣', async () => {
    const G = graph([['R', 'router'], ['S1', 'switch'], ['S2', 'switch']], [['r1', 'R', 's1u', 'S1'], ['r2', 'R', 's2u', 'S2'], ['s1x', 'S1', 's2x', 'S2']]);
    G.ports.push({ id: 'lone', dev: 'S1', name: 'lone' });
    const r = L().portLayout(G.devs, G.ports, G.edges);
    assert.ok(Math.abs(r.pos.get('S1').y - r.pos.get('S2').y) < 1e-6, '測試前提：S1、S2 在同一層');
    const left = r.pos.get('S1').x < r.pos.get('S2').x ? 'S1' : 'S2';
    assert.strictEqual(r.side.get(left === 'S1' ? 's1x' : 's2x'), 'east', '左邊那台的互連埠應在右緣');
    assert.strictEqual(r.side.get(left === 'S1' ? 's2x' : 's1x'), 'west', '右邊那台的互連埠應在左緣');
    assert.strictEqual(r.side.get('lone'), 'south', '沒有對端的埠維持下緣');
    // 依 anchor 確認實際的位置與選的邊一致
    G.ports.forEach((p) => assert.strictEqual(sideOf(r.anchor.get(p.id), r.box.get(p.dev)), r.side.get(p.id), '埠的位置應在選的邊上：' + p.id));
    // 對端正上方／正下方
    const pos = new Map([['A', { x: 0, y: 0 }], ['B', { x: 0, y: -400 }]]);
    const P = L().portPeers([{ a: 'a', b: 'b', aDev: 'A', bDev: 'B' }]);
    const sd = L().portSides([{ id: 'A', box: BOX() }, { id: 'B', box: BOX() }], [{ id: 'a', dev: 'A' }, { id: 'b', dev: 'B' }], P, pos);
    assert.strictEqual(sd.get('a'), 'north', '對端在正上方時放上緣');
    assert.strictEqual(sd.get('b'), 'south', '對端在正下方時放下緣');
  });

  await step('L2 埠選邊：同一邊依對端的投影排序（上下緣依 x、左右緣依 y）；左右邊的埠多時框加高；接近對角線有遲滯', async () => {
    // 中間一台 C，右邊上下各一台：C 的兩個埠都在右緣，依對端的 y 排
    const devs = ['C', 'U', 'D'].map((id) => ({ id, box: BOX() }));
    const ports = [{ id: 'cd', dev: 'C', name: 'a' }, { id: 'cu', dev: 'C', name: 'b' }, { id: 'u', dev: 'U' }, { id: 'd', dev: 'D' }];
    const peers = L().portPeers([{ a: 'cu', b: 'u', aDev: 'C', bDev: 'U' }, { a: 'cd', b: 'd', aDev: 'C', bDev: 'D' }]);
    const pos = new Map([['C', { x: 0, y: 0 }], ['U', { x: 600, y: -40 }], ['D', { x: 600, y: 40 }]]);
    const r = L().portAnchors(devs, ports, peers, pos);
    assert.strictEqual(r.side.get('cu'), 'east'); assert.strictEqual(r.side.get('cd'), 'east');
    assert.ok(r.anchor.get('cu').dy < r.anchor.get('cd').dy, '右緣的埠依對端的 y 由上而下排');
    const many = Array.from({ length: 6 }, (_, i) => ({ id: 'm' + i, dev: 'C' }));
    const mp = new Map(many.map((p, i) => [p.id, ['P' + i]]));
    const mpos = new Map([['C', { x: 0, y: 0 }]].concat(many.map((p, i) => ['P' + i, { x: 500, y: (i - 2.5) * 30 }])));
    const m = L().portAnchors([{ id: 'C', box: BOX() }].concat(many.map((p, i) => ({ id: 'P' + i, box: BOX() }))), many, mp, mpos);
    const B = S.view.theme.l2.box;
    assert.ok(m.box.get('C').h >= (many.length + 1) * B.portGap, '右緣有 6 個埠時框高要夠排開：' + m.box.get('C').h);
    many.forEach((p) => assert.ok(Math.abs(m.anchor.get(p.id).dy) < m.box.get('C').h / 2, '左右緣的埠在框高之內'));
    // 遲滯：對端在對角線外一點點時，原本在右緣的維持右緣，沒有前一個邊時依對角線
    const b = BOX(); const diag = Math.atan2(b.h, b.w); const k = 1000;
    const at = (ang) => new Map([['A', { x: 0, y: 0 }], ['B', { x: Math.cos(ang) * k, y: -Math.sin(ang) * k }]]);
    const one = [{ id: 'A', box: b }, { id: 'B', box: b }]; const pp = [{ id: 'a', dev: 'A' }];
    const pr = new Map([['a', ['B']]]);
    assert.strictEqual(L().portSides(one, pp, pr, at(diag + 0.03)).get('a'), 'north', '越過對角線放上緣');
    assert.strictEqual(L().portSides(one, pp, pr, at(diag + 0.03), new Map([['a', 'east']])).get('a'), 'east', '剛越過對角線時維持原本的邊');
    assert.strictEqual(L().portSides(one, pp, pr, at(diag + 0.4), new Map([['a', 'east']])).get('a'), 'north', '越過對角線夠多才換邊');
    assert.strictEqual(L().portSides(one, pp, pr, at(diag - 0.03), new Map([['a', 'north']])).get('a'), 'north', '往回也有遲滯');
  });

  await step('L2 埠選邊：同樣的位置重算必得同樣的邊與框高（加高後的框不讓對角線變陡、把更多埠推到左右）', async () => {
    // 一台核心接下一列 30 台：左右緣的埠多、框會加高；套用新框高後在同樣的位置重算多次，結果不變
    const devs = [{ id: 'core', box: BOX() }]; const ports = []; const edges = []; const pos = new Map([['core', { x: 0, y: 0 }]]);
    for (let i = 0; i < 30; i++) {
      const id = 'a' + i; devs.push({ id, box: BOX() }); pos.set(id, { x: -1300 + i * 90, y: 166 });
      ports.push({ id: 'core|p' + i, dev: 'core', name: 'p' + i }, { id: id + '|up', dev: id, name: 'up' });
      edges.push({ a: 'core|p' + i, b: id + '|up', aDev: 'core', bDev: id });
    }
    const peers = L().portPeers(edges); let prev; const runs = [];
    for (let k = 0; k < 4; k++) {
      const r = L().portAnchors(devs, ports, peers, pos, { prev });
      runs.push(JSON.stringify({ side: Array.from(r.side), h: r.box.get('core').h }));
      devs.forEach((d) => { d.box.h = r.box.get(d.id).h; }); prev = r.side;
    }
    assert.ok(devs[0].box.h > S.view.theme.l2.box.h, '測試前提：核心的框有加高');
    runs.forEach((x, k) => assert.strictEqual(x, runs[0], `第 ${k + 1} 次重算的邊或框高和第一次不同`));
  });

  await step('L2 埠選邊：分層版面（ELK）只決定設備位置，埠的邊與位置和內建版面用同一個選邊函式算出', async () => {
    App.showLayer('l2'); await App.layerJob; const e = App.layerEntry();
    const r = await L().elkPorts(e.boxes, e.ports, e.pg.edges, {});
    const same = L().portAnchors(e.boxes, e.ports, L().portPeers(e.pg.edges), r.pos);
    e.ports.forEach((p) => {
      assert.strictEqual(r.side.get(p.id), same.side.get(p.id), 'ELK 的邊應與選邊函式一致：' + p.id);
      assert.deepStrictEqual(r.anchor.get(p.id), same.anchor.get(p.id), 'ELK 的埠位置應與選邊函式一致：' + p.id);
    });
    // 畫面上的埠：都在自己的框邊上，左右緣的埠數不超過框高
    const B = S.view.theme.l2.box;
    e.boxes.forEach((b) => {
      const mine = e.ports.filter((p) => p.dev === b.id);
      mine.forEach((p) => assert.notStrictEqual(sideOf(p.anchor, b.box), '?', '埠應在框的某一邊上：' + p.id));
      ['east', 'west'].forEach((s) => { const n = mine.filter((p) => sideOf(p.anchor, b.box) === s).length; if (n) assert.ok(b.box.h >= (n + 1) * B.portGap - 1e-6, `${b.id} 的${s}有 ${n} 個埠，框高 ${b.box.h} 不夠`); });
    });
  });

  await step('L2 埠選邊：埠名依 anchor 的邊放在框外（左右緣靠近角落的埠也在左右）；沒有邊時沿用依位置的判斷', async () => {
    const g = App.graph;
    // 框加高後，左右緣靠近角落的埠 |dy| 會超過 0.4|dx|：舊的判斷會把它的標籤當成上下緣放
    const box = { w: 120, h: 220 };
    const dev = { id: 'D', kind: 'switch', label: 'D', collected: true, box };
    const mk = (id, dx, dy, side) => ({ id, kind: 'port', label: id, name: id, dev: 'D', anchor: Object.assign({ parent: 'D', dx, dy }, side ? { side } : {}) });
    const ports = [mk('pe', 60, -90, 'east'), mk('pw', -60, 90, 'west'), mk('pn', 20, -110, 'north'), mk('ps', -20, 110, 'south'), mk('qx', 60, -90)];
    const pos = new Map([['D', { x: 0, y: 0 }]]);
    const ops = withGraph(g, [dev].concat(ports), [], pos, () => {
      g.setSelection(ports.map((p) => p.id), []); g.s = 2; g.tx = g.w / 2; g.ty = g.h / 2;
      return recordCanvas(g.ctx, () => g.draw());
    });
    const label = (id) => { const o = ops.find((x) => x.op === 'text' && x.text === id); assert.ok(o, '應畫出埠名：' + id); return o; };
    const at = (id) => { const p = ports.find((x) => x.id === id).anchor; return { x: p.dx, y: p.dy }; };
    assert.ok(label('pe').x > at('pe').x, '右緣的埠名在框的右邊');
    assert.ok(Math.abs(label('pe').y - at('pe').y) < 10, '右緣的埠名與埠同高');
    assert.ok(label('pw').x < at('pw').x, '左緣的埠名在框的左邊');
    assert.ok(Math.abs(label('pw').y - at('pw').y) < 10, '左緣的埠名與埠同高');
    assert.ok(label('pn').y < at('pn').y && Math.abs(label('pn').x - at('pn').x) < 1e-6, '上緣的埠名在上方');
    assert.ok(label('ps').y > at('ps').y && Math.abs(label('ps').x - at('ps').x) < 1e-6, '下緣的埠名在下方');
    assert.ok(label('qx').y < at('qx').y && Math.abs(label('qx').x - at('qx').x) < 1e-6, '沒有邊時沿用依位置的判斷（|dy| ≥ 0.4|dx| 放上下）');
  });

  await step('L2 埠選邊：拖曳設備框後依新的位置重新選邊；切走再回來時依保留的位置選邊', async () => {
    // 前面的 step 可能把 L2 留在某台設備為中心或其他選項：回到預設（太大時由 busiest 選中心）
    const saved = Object.assign({}, App.l2);
    App.select(null); Object.assign(App.l2, { lag: 'collapse', ports: 'linked', scope: 'all', focus: null }); App.showLayer('l2'); await App.layerJob;
    const g = App.graph; const e = App.layerEntry(); const cv = $('#graph');
    // 找一條邊：拖曳的這一端（a）只連到對端設備；對端的埠也只連回來時另外檢查對端的邊
    const peersOf = L().portPeers(e.pg.edges);
    const only = (p, d) => (peersOf.get(p) || []).every((x) => x === d);
    const flip = (x) => ({ a: x.b, b: x.a, aDev: x.bDev, bDev: x.aDev });
    const cands = e.pg.edges.filter((x) => x.aDev !== x.bDev).flatMap((x) => [x, flip(x)]).filter((x) => e.index.boxes.has(x.aDev) && only(x.a, x.bDev));
    const edge = cands.find((x) => only(x.b, x.aDev)) || cands[0];
    // 以 --grep 篩選時，前面的 step 可能留下沒有 L2 鏈路的基準：沒有設備之間的鏈路時，拖曳這段無從檢查
    if (!e.pg.edges.some((x) => x.aDev !== x.bDev)) { Object.assign(App.l2, saved); App.showLayer('device'); return; }
    assert.ok(edge, '測試前提：有一端只連到對端設備的邊');
    const both = only(edge.b, edge.aDev);
    const port = e.index.ports.get(edge.a); const peer = e.index.ports.get(edge.b);
    const drag = (dev, to) => {
      const from = g.toScreen(g.pos.get(dev)); const sp = g.toScreen(to);
      const fire = (t, pt) => (winListeners[t] || []).forEach((f) => f({ target: cv, clientX: pt.x, clientY: pt.y, pointerId: 7, pointerType: 'mouse', button: 0, preventDefault() {} }));
      cv.dispatch('pointerdown', { clientX: from.x, clientY: from.y, pointerId: 7, pointerType: 'mouse', button: 0 });
      fire('pointermove', { x: sp.x, y: sp.y }); fire('pointerup', { x: sp.x, y: sp.y });
    };
    const bp = g.pos.get(edge.bDev); const hb = e.boxes.find((b) => b.id === edge.aDev).box;
    // 拖到對端正上方很遠：這一端在下緣、對端在上緣
    drag(edge.aDev, { x: bp.x, y: bp.y - 3000 });
    assert.ok(Math.abs(g.pos.get(edge.aDev).x - bp.x) < 2, '測試前提：拖曳把框移到對端正上方');
    assert.strictEqual(sideOf(port.anchor, hb), 'south', '對端在正下方時埠應換到下緣');
    if (both) assert.strictEqual(sideOf(peer.anchor, e.boxes.find((b) => b.id === edge.bDev).box), 'north', '對端的埠應換到上緣');
    // 拖到對端正右方：這一端在左緣
    drag(edge.aDev, { x: bp.x + 3000, y: bp.y });
    assert.strictEqual(sideOf(port.anchor, hb), 'west', '對端在正左方時埠應換到左緣');
    // 拖曳中（還沒放開）：每個 animation frame 最多發一次 'moving'，埠即時換到面向對端的邊
    {
      let n = 0; const ids = []; const h = g.handlers.moving;
      assert.ok(h, '畫布應有拖曳中（moving）的處理函式');
      g.on('moving', (id) => { n++; ids.push(id); h(id); });
      try {
        flushRaf(1);
        const from = g.toScreen(g.pos.get(edge.aDev));
        const ev = (pt) => ({ target: cv, clientX: pt.x, clientY: pt.y, pointerId: 8, pointerType: 'mouse', button: 0, preventDefault() {} });
        const fire = (t, pt) => (winListeners[t] || []).forEach((f) => f(ev(pt)));
        cv.dispatch('pointerdown', { clientX: from.x, clientY: from.y, pointerId: 8, pointerType: 'mouse', button: 0 });
        const up = g.toScreen({ x: bp.x, y: bp.y - 3000 });
        fire('pointermove', { x: (from.x + up.x) / 2, y: (from.y + up.y) / 2 }); fire('pointermove', up);
        assert.strictEqual(n, 0, '移動當下不立即重算，等下一個 animation frame');
        flushRaf(1);
        assert.strictEqual(n, 1, '同一個 frame 內的多次移動只重算一次：' + n);
        assert.deepStrictEqual(ids, [edge.aDev], 'moving 帶拖曳中的設備');
        assert.strictEqual(sideOf(port.anchor, hb), 'south', '拖曳中（放開前）埠就換到面向對端的下緣');
        if (both) assert.strictEqual(sideOf(peer.anchor, e.boxes.find((b) => b.id === edge.bDev).box), 'north', '拖曳中對端的埠也換到上緣');
        fire('pointerup', up); flushRaf(1);
        assert.strictEqual(n, 1, '放開後不再發 moving（由 moved 收尾）');
      } finally { g.on('moving', h); }
    }
    // 保留的位置：直接改位置（例如之前拖過）後切走再回來，依位置重新選邊
    g.pos.set(edge.aDev, { x: bp.x, y: bp.y + 3000 });
    App.showLayer('device'); App.showLayer('l2');
    assert.strictEqual(App.layerEntry(), e, '測試前提：回到同一份 L2');
    assert.strictEqual(sideOf(port.anchor, hb), 'north', '回到 L2 時依保留的位置重新選邊');
    Object.assign(App.l2, saved); App.showLayer('device');
  });
};
