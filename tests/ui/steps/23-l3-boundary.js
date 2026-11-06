// 畫面冒煙測試的 step：L3 網段圖的對外邊界與路由網域（ADR-023 決策 6）：外部節點、可能對外、預設路由的方向、由外而內、VRF 外框＋路由網域內群。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { S, step, $, text } = require('../helpers.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/**
 * 只有 main 的小網路（同 tests/core/boundaries.js 的情境）：R 的 ether1 有預設路由與 masquerade（對外）、ether2 只有公網位址（可能對外）；
 * R2 的預設路由指向 R（基準內，不算對外）；R3 只有公網位址（只可能對外）。
 */
const SMALL = [
  'R (192.168.1.1):', '### /export terse',
  '/interface bridge add name=bridge1',
  '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0',
  '/ip address add address=81.2.3.2/30 interface=ether1 network=81.2.3.0',
  '/ip address add address=81.2.4.1/29 interface=ether2 network=81.2.4.0',
  '/ip firewall nat add action=masquerade chain=srcnat out-interface=ether1',
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=81.2.3.0/30 routing-table=main gateway=ether1 immediate-gw=ether1 distance=0',
  ' As  dst-address=0.0.0.0/0 routing-table=main gateway=81.2.3.1 immediate-gw=81.2.3.1%ether1 distance=1',
  'R2 (192.168.1.2):', '### /export terse', '/ip address add address=192.168.1.2/24 interface=ether1 network=192.168.1.0',
  '/ip address add address=10.9.0.1/24 interface=ether2 network=10.9.0.0',
  '### /ip route print detail without-paging', RT, ' As  dst-address=0.0.0.0/0 routing-table=main gateway=192.168.1.1 immediate-gw=192.168.1.1%ether1 distance=1',
  'R3 (192.168.1.3):', '### /export terse', '/ip address add address=192.168.1.3/24 interface=ether2 network=192.168.1.0',
  '/ip address add address=81.2.9.1/29 interface=ether1 network=81.2.9.0',
].join('\n');

/** 圖上的外部節點與接到外部的線，逐一對照 Q.boundaries（external／possible 每台設備每個 VRF 一條線，internal 不接） */
function checkBoundaryEdges(Q, g) {
  const T = S.view.theme; const K = S.keys;
  const bs = Q.boundaries().filter((b) => b.status === 'external' || b.status === 'possible');
  const want = new Map(); bs.forEach((b) => S.util.getOr(want, K.inVrf(b.dev, b.vrf), () => []).push(b));
  const xs = g.edges.filter((e) => e.boundary);
  if (xs.length !== want.size) throw new Error(`接到外部的線應是每台有對外介面的設備（每個 VRF）一條：${xs.length}／${want.size}`);
  want.forEach((list, id) => {
    const e = g.edges.find((x) => x.id === 'x|' + id); const ext = g.nodeById.get('ext|' + list[0].vrf);
    if (!e || e.a !== id || !g.nodeById.has(id) || !ext || e.b !== ext.id) throw new Error('有對外介面的設備應接到它的 VRF 的外部節點：' + id);
    if (ext.kind !== 'external' || !ext.label.includes('推論') || ext.collected) throw new Error('外部節點應標推論、不是收集到的設備：' + ext.label);
    const external = list.some((b) => b.status === 'external');
    const dflt = list.some((b) => b.evidence.some((ev) => ev.kind === 'default-route' && ev.strength === 'strong'));
    if (dflt) { if (!e.arrow || e.style !== T.l3.route) throw new Error('預設路由經這裡出去時應用路由的虛線，箭頭指向外部：' + id); }
    else if (e.arrow) throw new Error('沒有預設路由時不畫箭頭：' + id);
    if (!dflt && external && (e.style !== T.l3.boundary || e.style.dash)) throw new Error('判定對外的線是實線：' + id);
    if (!external && (e.style !== T.l3.possible || !e.style.dash || !e.style.dash.length || e.labelB !== '可能對外')) throw new Error('只可能對外的線是虛線，標「可能對外」：' + id);
    list.forEach((b) => { if (!e.labelA.includes(K.splitEp(b.ep)[1])) throw new Error('線上應寫出對外的介面：' + b.ep); });
    if (list.some((b) => b.status === 'possible') && !e.labelA.includes('（可能對外）')) throw new Error('可能對外的介面在線上標「可能對外」：' + id);
  });
  // 只有 internal 證據的設備不接到外部
  Q.boundaries().filter((b) => b.status === 'internal' && !want.has(K.inVrf(b.dev, b.vrf))).forEach((b) => {
    if (g.edges.some((e) => e.boundary && e.boundary.dev === b.dev && e.boundary.vrf === b.vrf)) throw new Error('沒有對外證據的設備不應接到外部：' + b.ep);
  });
  return { bs, want };
}
/** 由外而內：同一個外框內，tier 小的節點都在 tier 大的節點上方（外部 tier 0 在最上） */
function checkTiers(g) {
  const byOuter = new Map(); g.nodes.forEach((n) => S.util.getOr(byOuter, n.outer || '', () => []).push(n));
  byOuter.forEach((ns, o) => {
    const tiers = Array.from(new Set(ns.map((n) => (n.tier == null ? Infinity : n.tier)))).sort((a, b) => a - b);
    for (let i = 1; i < tiers.length; i++) {
      const ys = (t) => ns.filter((n) => (n.tier == null ? Infinity : n.tier) === t).map((n) => g.pos.get(n.id).y);
      if (Math.max(...ys(tiers[i - 1])) >= Math.min(...ys(tiers[i]))) throw new Error(`外框「${o}」中 tier ${tiers[i - 1]} 應整列在 tier ${tiers[i]} 上方`);
    }
  });
}

module.exports = async () => {
  await step('L3 對外邊界（範例資料）：每個 VRF 一個「外部」節點（推論），接到有對外介面的設備；預設路由的方向是箭頭；VRF 外框裡依路由網域分群，由外而內排列', async () => {
    const Q = App.Q; const g = App.graph; const V = S.view;
    App.select(null); App.l3.routes = false; App.showLayer('l3', { rebuild: true }); await App.layerJob;
    const { bs } = checkBoundaryEdges(Q, g);
    if (!process.env.SMOKE_INPUT && !bs.some((b) => b.evidence.some((ev) => ev.kind === 'default-route' && ev.strength === 'strong'))) throw new Error('測試前提：範例資料有經預設路由對外的介面');
    const exts = g.nodes.filter((n) => n.kind === 'external');
    if (exts.length !== new Set(bs.map((b) => b.vrf)).size) throw new Error('每個有對外介面的 VRF 一個外部節點');
    exts.forEach((x) => { if (x.tier !== 0) throw new Error('外部節點是由外而內的第一層'); });
    // 有對外設備的路由網域是第 1 層
    g.edges.filter((e) => e.boundary).forEach((e) => { const n = g.nodeById.get(e.a); if (n.domain && n.tier !== 1) throw new Error('邊界路由器所在的路由網域應是第 1 層：' + n.id); });
    checkTiers(g);
    // 兩層群框：VRF 外框包住其中的路由網域群框
    const e = App.layerEntry(); g.computeGroups();
    if (e.info.byVrf) {
      const outers = g.groupBoxes.filter((b) => b.outer);
      e.info.vrfs.forEach((v) => { if (!outers.some((o) => o.name === V.vrfText(v))) throw new Error('應有 VRF 的外框：' + v); });
      g.groupBoxes.filter((b) => !b.outer).forEach((b) => {
        const n = g.nodes.find((x) => (x.group || '') === b.name); const o = outers.find((x) => x.name === n.outer);
        if (!o || b.x0 < o.x0 || b.x1 > o.x1 || b.y0 < o.y0 || b.y1 > o.y1) throw new Error('路由網域的群框應在自己 VRF 的外框內：' + b.name);
      });
    }
    // 群名：OSPF area 與靜態路由（中文）
    const names = new Set(g.nodes.filter((n) => n.domain).map((n) => n.group));
    Q.routingDomains().filter((d) => g.nodes.some((n) => n.domain === d.key)).forEach((d) => {
      const nm = g.nodes.find((n) => n.domain === d.key).group;
      if (d.kind === 'ospf' ? !nm.startsWith('OSPF area ') : !nm.endsWith('的靜態路由') && !nm.includes('的靜態路由（')) throw new Error('路由網域的群名：' + nm);
      if (d.kind === 'ospf' && d.areaId === '0.0.0.0' && !nm.includes('骨幹')) throw new Error('area 0 標骨幹：' + nm);
    });
    if (!names.size) throw new Error('應依路由網域分群');
    const note = $('#layer-note').textContent;
    if (!note.includes('路由網域') || !note.includes('外部')) throw new Error('L3 的說明應寫出路由網域分群與外部：' + note);
    // 提示：外部與接到外部的線
    const x0 = exts[0]; g.emit('hover', { item: { type: 'node', id: x0.id }, x: 0, y: 0 });
    if (!text('#tooltip').includes('推論')) throw new Error('外部節點的提示應寫推論：' + text('#tooltip'));
    const xe = g.edges.find((x) => x.boundary);
    g.emit('hover', { item: { type: 'edge', id: xe.id }, x: 0, y: 0 });
    if (!text('#tooltip').includes(Q.devName(xe.boundary.dev)) || !text('#tooltip').includes('推論')) throw new Error('接到外部的線的提示應寫設備與推論：' + text('#tooltip'));
    g.emit('hover', { item: null });
    // 點外部：詳情列出每個對外介面的依據（種類、強弱、來源行），圖上標出外部與接到它的線
    g.emit('click', { type: 'node', id: x0.id });
    if (!App.sel || App.sel.type !== 'boundary' || App.sel.key !== x0.vrf) throw new Error('點外部應選取這個 VRF 的對外邊界');
    const mine = bs.filter((b) => b.vrf === x0.vrf); const d = text('#detail');
    if (!$('#detail').testAll('.chip').some((c) => c.textContent === V.TERMS.inferred)) throw new Error('外部的詳情應標推論');
    mine.forEach((b) => {
      const full = Q.boundaryOf(b.ep);
      if (!d.includes(S.keys.splitEp(b.ep)[1])) throw new Error('詳情應列出對外介面：' + b.ep);
      full.evidence.forEach((ev) => { if (!d.includes(V.boundaryEvidenceText(ev.kind))) throw new Error('詳情應列出證據的種類：' + ev.kind); });
    });
    const srcLines = S.util.uniq(mine.flatMap((b) => Q.boundaryOf(b.ep).evidence.map((ev) => ev.src[0] && ev.src[0][1]).filter(Boolean)));
    srcLines.forEach((ln) => { if (!$('#detail').testAll('a').some((a) => a.textContent.endsWith(`第 ${ln} 行`))) throw new Error('詳情應連到證據的來源行：第 ' + ln + ' 行'); });
    if (!g.sel.nodes.has(x0.id) || !g.edges.filter((x) => x.boundary && x.b === x0.id).every((x) => g.sel.edges.has(x.id))) throw new Error('選取外部時標出外部與接到它的線');
    // 點接到外部的線：只列那台設備，可改看整個 VRF
    g.emit('click', { type: 'edge', id: xe.id });
    if (App.sel.type !== 'boundary' || App.sel.dev !== xe.boundary.dev || !g.sel.edges.has(xe.id)) throw new Error('點接到外部的線應選取那台設備的對外邊界');
    const others = bs.filter((b) => b.vrf === xe.boundary.vrf && b.dev !== xe.boundary.dev);
    if (others.some((b) => text('#detail').includes(Q.epName(b.ep)))) throw new Error('只列那台設備的對外介面');
    const all = $('#detail').testAll('a').find((a) => a.textContent === '看這個 VRF 的全部');
    if (!all) throw new Error('應可改看整個 VRF 的對外邊界'); all.click();
    if (App.sel.dev) throw new Error('改看整個 VRF 後不限設備');
    // 設備圖：選取對外邊界標出有對外介面的設備
    App.showLayer('device');
    const devs = S.util.uniq(mine.map((b) => b.dev)).filter((k) => g.nodeById.has(k));
    if (!devs.length || !devs.every((k) => g.hl && g.hl.nodes.has(k))) throw new Error('設備圖上應標出有對外介面的設備');
    App.select(null);
  });

  await step('L3 對外邊界（只有 main 的小網路）：可能對外是虛線並標「可能對外」，預設路由指向內部的設備不接到外部；直接依路由網域分群；鍵盤 N 先到最上面的外部，Enter 開依據', async () => {
    if (process.env.SMOKE_INPUT) return;
    const VA = S.view.app; const orig = { snap: App.snap, sources: App.round.sources, profile: App.round.profile };
    const sources = [{ name: 'small.txt', text: SMALL }];
    try {
      const snap = S.build(sources, { now: '2026-01-01T00:00:00Z' });
      VA.load(snap, null, { sources }); await App.ledgerJob; await App.layoutJob;
      const Q = App.Q; const g = App.graph;
      App.l3.routes = false; App.showLayer('l3', { rebuild: true }); await App.layerJob;
      const { want } = checkBoundaryEdges(Q, g);
      if (!want.has('R') || !want.has('R3') || want.has('R2')) throw new Error('測試前提：R、R3 有對外介面，R2 的預設路由指向 R');
      const r3 = g.edges.find((e) => e.id === 'x|R3');
      if (r3.boundary.status !== 'possible') throw new Error('R3 只有公網位址：可能對外');
      if (g.edges.find((e) => e.id === 'x|R').labelA.indexOf('ether2（可能對外）') < 0) throw new Error('R 的 ether2 只有公網位址，在線上標可能對外');
      if (App.layerEntry().info.byVrf || g.nodes.some((n) => n.outer)) throw new Error('只有 main 時不畫 VRF 外框');
      if (g.nodes.filter((n) => n.kind === 'subnet').some((n) => n.domain !== (Q.routingDomainOf(n.subnet.id) || {}).key)) throw new Error('網段直接依路由網域分群');
      // 外部在最上：所有節點中 y 最小
      const ext = g.nodeById.get('ext|main'); const ey = g.pos.get(ext.id).y;
      if (g.nodes.some((n) => n !== ext && g.pos.get(n.id).y <= ey)) throw new Error('外部節點應在最上方');
      checkTiers(g);
      // 圖例列出外部、對外與可能對外
      ['外部（L3，推論）', '對外（L3，推論）', '可能對外（L3，推論）'].forEach((t) => { if (!$('#legend').testAll('.li').some((li) => li.textContent.endsWith(t))) throw new Error('圖例應有：' + t); });
      // 鍵盤：N 依畫面位置由上往下，第一個是外部；Enter 開啟依據，焦點留在畫布
      const cv = $('#graph'); g.kbd = null; cv.focus(); cv.dispatch('keydown', { key: 'n' });
      if (g.kbd !== ext.id) throw new Error('N 應先到最上面的外部：' + g.kbd);
      cv.dispatch('keydown', { key: 'Enter' });
      if (!App.sel || App.sel.type !== 'boundary' || !text('#detail').includes('可能對外')) throw new Error('Enter 應開啟外部的依據（含可能對外）：' + text('#detail').slice(0, 200));
      if (!text('#detail').includes(S.view.BOUNDARY_EVIDENCE['public-address'])) throw new Error('可能對外的依據寫出公網位址');
      App.select(null);
    } finally {
      App.showLayer('device');
      VA.load(orig.snap, null, { sources: orig.sources, profile: orig.profile }); await App.ledgerJob; await App.layoutJob;
    }
  });
};
