/*
 * 拓樸圖的層級：設備圖（app-graph.js）、L2 埠圖（Q.portGraph）、L3 子網圖（Q.subnetGraph）、L4 可達性（panels/l4.js）。
 * 三種圖共用同一張畫布（App.graph）：切換時換掉圖資料，各自的位置與縮放分開保存，不互相覆蓋。
 * L4 不是節點與連線的圖，而是 zone 矩陣：選了 L4 時畫布保持原樣（不換資料、不動縮放），#view-l4 疊在畫布上、工具列下面，
 * 畫布、圖例與說明不能聚焦也不顯示；回到其他層級時畫布照原本的方式還原。
 *  - 設備圖的位置是 App.devicePos（存進 store 的 'last'，與基準一起還原，格式不變）
 *  - L2／L3 的位置只在記憶體：App.layers 依「層級＋選項」各存一份（版面由 ELK 或內建版面重新算得出來；
 *    埠的 id 依聚合收合或展開而不同，存進 store 還要處理失效），換基準或清除時清空
 * VLAN 篩選（App.vlanFilter）在每一層都持續標示，直到在選單取消；資料一律來自 Q，結果是凍結的，畫面另建自己的節點物件。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$; const K = S.keys;
  const A = V.app; const App = window.App;
  const T = V.theme; const MARK = T.mark;
  const LAYERS = ['device', 'l2', 'l3', 'l4'];
  const STATUS_RANK = { oneSide: 0, inferred: 1, carry: 2, partial: 3 };

  // 檢視狀態（不寫進基準、不存進 store）
  App.l2 = { lag: 'collapse', ports: 'linked', scope: 'all', focus: null };
  App.l3 = { routes: false };
  App.vlanFilter = null; // { id, domain }
  App.layers = new Map(); // 'l2|選項' 或 'l3|選項' → 圖資料、位置、縮放與索引
  let deviceView = null; let layoutToken = 0;

  const saveView = (g) => ({ s: g.s, tx: g.tx, ty: g.ty });
  const restoreView = (g, v) => { if (v) Object.assign(g, v); else g.fit(); g.redraw(); };
  /** 目前層級的圖資料（設備圖為 null） */
  App.layerEntry = A.layerEntry = () => (App.layer === 'device' || App.layer === 'l4' ? null : App.layers.get(entryKey(App.layer)) || null);
  /** 讓某一層下次顯示時重新全圖（例如背景的分層版面完成時，看的是另一層） */
  A.forgetView = (layer) => { if (layer === 'device') deviceView = null; };
  /** 設備圖的資料：看的是設備圖時直接換上畫布，否則等切回時再換 */
  A.setDeviceGraph = function setDeviceGraph(nodes, edges, pos) {
    App.deviceGraph = { nodes, edges }; App.devicePos = pos;
    if (App.layer === 'device') App.graph.setData(nodes, edges, pos);
  };
  /** 換基準或清除：清掉 L2／L3 的資料與各層的縮放；VLAN 篩選在新的基準沒有這個 VLAN 時取消 */
  A.resetLayers = function resetLayers() {
    App.layers = new Map(); deviceView = null; layoutToken++; App.l2.focus = null; App.l2.scope = 'all'; App.l2.tooBig = false;
    if (App.vlanFilter && !(App.Q && App.Q.vlanIds().includes(App.vlanFilter.id))) App.vlanFilter = null;
    if (App.vlanFilter) App.vlanFilter.domain = null;
  };

  // ================================================================ 切換層級
  /**
   * 顯示某一層。opt.rebuild：重新建立這一層的圖（選項或基準改變）；opt.focus：焦點移到畫布。
   * 切換時保留選取（在新的一層重新標示），平移與縮放各層分開。
   * L4：畫布不換資料（離開 L4 時也不記縮放），矩陣由 V.l4.show 畫；App.l4Job 是矩陣的計算（第一次在背景，測試可等待）。
   * opt.focus 在 L4 時把焦點移到 L4 的標題。
   */
  App.showLayer = A.showLayer = function showLayer(layer, opt) {
    if (!LAYERS.includes(layer)) throw new RangeError('未知的層級：' + layer);
    const o = opt || {}; const g = App.graph;
    const target = App.Q ? layer : 'device';
    // 離開的那一層：記下縮放與平移（L4 沒有畫布的狀態）
    if (App.layer === 'device') deviceView = g.nodes === App.deviceGraph.nodes ? saveView(g) : deviceView;
    else if (App.layer !== 'l4') { const cur = A.layerEntry(); if (cur && g.nodes === cur.nodes) cur.view = saveView(g); }
    App.layer = target;
    g.hover = null; g.kbd = null; g.setOverlay([]); $('#tooltip').classList.add('hidden');
    if (target === 'l4') {
      A.syncLayerUi();
      App.l4Job = V.l4.show(App, { rebuild: !!o.rebuild });
      if (o.focus) { const t = $('#l4-title'); if (t) t.focus(); }
      return;
    }
    if (target === 'device') { g.setData(App.deviceGraph.nodes, App.deviceGraph.edges, App.devicePos); A.applyVisibility(); restoreView(g, deviceView); }
    else {
      const e = ensureEntry(target, o.rebuild);
      g.setData(e.nodes, e.edges, e.pos); A.applyVisibility(); restoreView(g, e.view);
    }
    A.syncLayerUi();
    App.select(App.sel, { refresh: true });
    if (o.focus) $('#graph').focus();
  };
  /** 重新排列目前的 L2／L3（工具列的「重新排列」）：重算這一層的版面 */
  A.relayoutLayer = function relayoutLayer() {
    const e = A.layerEntry(); if (!e) return;
    e.view = null; layout(e);
    App.graph.computeGroups(); App.graph.fit();
    App.layerJob = App.layoutMode === 'elk' ? applyElk(e) : Promise.resolve();
  };

  const entryKey = (layer) => (layer === 'l2'
    ? 'l2|' + JSON.stringify([App.l2.lag, App.l2.ports, App.l2.scope, App.l2.scope === 'focus' ? App.l2.focus : null])
    : 'l3|' + JSON.stringify([App.l3.routes]));
  function ensureEntry(layer, rebuild) {
    if (layer === 'l2') resolveScope();
    const key = entryKey(layer);
    if (!rebuild && App.layers.has(key)) return App.layers.get(key);
    const e = Object.assign(layer === 'l2' ? buildL2() : buildL3(), { layer, key, view: null, token: 0 });
    App.layers.set(key, e);
    const seeded = layer === 'l3' && seedL3(e);
    if (!seeded) layout(e);
    App.layerJob = App.layoutMode === 'elk' && !seeded ? applyElk(e) : Promise.resolve();
    return e;
  }

  // ================================================================ L2 埠圖
  /** 整張圖太大時（超過 App.L2_MAX 台）改成「選取的設備與它的鄰居」；焦點設備依選取，沒有時取連線最多的網路設備 */
  function resolveScope() {
    const Q = App.Q; const full = Q.portGraph({ lag: App.l2.lag, ports: App.l2.ports });
    App.l2.total = full.devices.length; App.l2.tooBig = full.devices.length > App.L2_MAX;
    if (App.l2.tooBig) App.l2.scope = 'focus';
    if (App.l2.scope !== 'focus') return;
    const selDev = selectedDevice();
    if (!App.l2.focus || !Q.getDevice(App.l2.focus)) App.l2.focus = selDev && Q.getDevice(selDev) ? selDev : busiest(full);
  }
  function busiest(pg) {
    const rank = { firewall: 0, router: 0, switch: 1 };
    const edges = new Map(); pg.edges.forEach((e) => [e.aDev, e.bDev].forEach((d) => edges.set(d, (edges.get(d) || 0) + 1)));
    const list = pg.devices.filter((d) => d.collected).sort((a, b) => (rank[a.kind] ?? 2) - (rank[b.kind] ?? 2) || (edges.get(b.id) || 0) - (edges.get(a.id) || 0) || S.util.natural(a.id, b.id));
    return list.length ? list[0].id : (pg.devices[0] || {}).id || null;
  }
  function selectedDevice() {
    const s = App.sel; if (!s) return null;
    if (s.type === 'device') return s.key;
    if (s.type === 'interface') return K.splitEp(s.key)[0];
    if (s.type === 'firewall' || s.type === 'endpoints') return s.dev;
    return null;
  }
  const labelW = (text) => String(text || '').length * 7.4 + 30;
  function buildL2() {
    const Q = App.Q; const o = App.l2; const B = T.l2.box;
    const pg = o.scope === 'focus' && o.focus ? Q.portGraph({ lag: o.lag, ports: o.ports, devices: [o.focus] }) : Q.portGraph({ lag: o.lag, ports: o.ports });
    const sv = A.severities(Q);
    const groupOf = (d) => { const x = Q.getDevice(d); return (x && x.group) || ''; };
    const boxes = pg.devices.map((d) => ({
      id: d.id, label: d.label, kind: d.kind || 'unknown', collected: d.collected, group: groupOf(d.id), sev: sv.devSev.get(d.id) || null,
      box: { w: Math.round(Math.max(B.minW, labelW(d.label), (d.ports.length + 1) * B.portGap)), h: B.h },
      sub: `${d.ports.length} 埠${d.focus ? '' : '・鄰居'}`, focus: d.focus,
    }));
    const ports = pg.ports.map((p) => ({
      id: p.id, kind: 'port', label: p.name + (p.members.length ? ` ×${p.members.length}` : ''), name: p.name, dev: p.dev, ifc: p.ifc,
      collected: !!(Q.getDevice(p.dev) || {}).collected, unknown: p.unknown, lag: p.type === 'lag' || p.members.length > 0,
      group: groupOf(p.dev), anchor: { parent: p.dev, dx: 0, dy: 0 }, sev: sv.ifcSev.get(p.id) || null, port: p,
    }));
    const edges = pg.edges.map((e) => ({
      id: e.id, a: e.a, b: e.b, cls: e.cls, count: e.count, evidence: e.evidence, pg: e,
      sev: e.links.reduce((s, k) => { const x = sv.linkSev.get(k); return x && (!s || sv.rank[x] > sv.rank[s]) ? x : s; }, null),
    }));
    // 索引：鏈路鍵 → 邊、介面（含聚合成員）→ 埠、埠 → 邊
    const edgeOfLink = new Map(); const portOfEp = new Map(); const edgesOfPort = new Map();
    edges.forEach((e) => { e.pg.links.concat(e.pg.inferredLinks).forEach((k) => edgeOfLink.set(k, e.id)); [e.a, e.b].forEach((p) => S.util.getOr(edgesOfPort, p, () => []).push(e.id)); });
    pg.ports.forEach((p) => { portOfEp.set(p.id, p.id); p.members.forEach((m) => portOfEp.set(m, p.id)); });
    return {
      nodes: boxes.concat(ports), edges, pos: new Map(), boxes, ports, pg,
      index: { edgeOfLink, portOfEp, edgesOfPort, boxes: new Set(boxes.map((b) => b.id)), ports: new Map(ports.map((p) => [p.id, p])), edges: new Map(edges.map((e) => [e.id, e])) },
      info: { scope: o.scope, focus: o.focus, tooBig: !!o.tooBig, total: o.total, omitted: pg.omitted, lag: o.lag, portsMode: o.ports },
    };
  }

  // ================================================================ L3 子網圖
  const NET = 'net|';
  function buildL3() {
    const Q = App.Q; const N = T.l3.subnet;
    const sg = Q.subnetGraph({ routes: App.l3.routes });
    const sv = A.severities(Q);
    // 分群沿用設備圖（命名規則的 group，或大型網路自動切出的區域）；子網歸到接在它上面最多設備的那一群
    const devGroup = new Map(App.deviceGraph.nodes.map((n) => [n.id, n.group || '']));
    const majority = (devs) => {
      const c = new Map(); devs.forEach((d) => { const gname = devGroup.get(d) || ''; c.set(gname, (c.get(gname) || 0) + 1); });
      return Array.from(c.entries()).sort((a, b) => b[1] - a[1] || S.util.natural(a[0], b[0])).map((x) => x[0])[0] || '';
    };
    const nodes = sg.subnets.map((s) => {
      const label = s.id + (s.vlan != null ? `・VLAN ${s.vlan}` : '');
      const badges = [s.overlaps.length ? `重疊網段 ${s.overlaps.length}` : null, s.duplicateIps.length ? `重複 IP ${s.duplicateIps.length}` : null].filter(Boolean);
      return { id: NET + s.id, kind: 'subnet', label, collected: true, group: majority(s.devices.concat(s.routers)), box: { w: Math.round(Math.max(N.minW, label.length * 7 + 26)), h: N.h }, routeOnly: s.basis === 'route', badges, subnet: s };
    });
    const devNode = (n) => ({ id: n.dev, label: n.label, kind: n.kind || 'unknown', collected: n.collected, group: devGroup.get(n.dev) || '', sev: sv.devSev.get(n.dev) || null, l3: n });
    const devIds = new Set();
    sg.nodes.forEach((n) => { if (!devIds.has(n.id)) { devIds.add(n.id); nodes.push(devNode(n)); } });
    const edges = sg.edges.map((e) => ({ id: 'a|' + e.id, a: NET + e.subnet, b: e.node, cls: 'other', count: 1, evidence: e.inferred ? 'hearsay' : 'adjacency', l3: e }));
    sg.routes.forEach((r) => {
      if (!devIds.has(r.dev)) { const d = Q.getDevice(r.dev); devIds.add(r.dev); nodes.push({ id: r.dev, label: d ? d.label || d.name : r.dev, kind: (d && d.kind) || 'unknown', collected: !!(d && d.collected), group: devGroup.get(r.dev) || '', sev: sv.devSev.get(r.dev) || null }); }
      edges.push({ id: 'r|' + r.id, a: r.dev, b: NET + r.subnet, style: T.l3.route, arrow: true, count: 1, route: r });
    });
    const OV = T.l3.overlap;
    sg.subnets.forEach((s) => s.overlaps.forEach((o) => { if (S.util.natural(s.id, o) < 0) edges.push({ id: 'o|' + s.id + '|' + o, a: NET + s.id, b: NET + o, style: OV, sev: OV.sev, count: 1, overlap: [s.id, o] }); }));
    const edgesOf = new Map(); edges.forEach((e) => [e.a, e.b].forEach((x) => S.util.getOr(edgesOf, x, () => []).push(e)));
    return {
      nodes, edges, pos: new Map(), sg,
      index: { subnets: new Map(sg.subnets.map((s) => [s.id, s])), edgesOf, nodes: new Map(nodes.map((n) => [n.id, n])), edges: new Map(edges.map((e) => [e.id, e])) },
      info: { routes: App.l3.routes },
    };
  }
  /** 顯示路由時沿用不顯示路由的位置，只把多出來的目的網段排在路由所在設備的上方（不重排整張圖） */
  function seedL3(e) {
    const other = App.layers.get('l3|' + JSON.stringify([!App.l3.routes]));
    if (!other || !other.pos.size) return false;
    other.pos.forEach((p, id) => { if (e.index.nodes.has(id)) e.pos.set(id, p); });
    const fresh = e.nodes.filter((n) => !e.pos.has(n.id));
    const byDev = new Map();
    fresh.forEach((n) => { const r = e.edges.find((x) => x.route && x.b === n.id); S.util.getOr(byDev, r ? r.a : '', () => []).push(n); });
    byDev.forEach((list, dev) => {
      const p = e.pos.get(dev) || { x: 0, y: 0 };
      list.forEach((n, i) => e.pos.set(n.id, { x: p.x + (i - (list.length - 1) / 2) * 190, y: p.y - 110 }));
    });
    return true;
  }

  // ================================================================ 版面
  /** 內建版面（同步）：L2 用 portLayout（埠排在框的上、下緣），L3 用設備圖的分層版面 */
  function layout(e) {
    e.token++;
    if (e.layer === 'l2') {
      const r = V.layout.portLayout(e.boxes, e.ports, e.pg.edges);
      e.pos.clear(); r.pos.forEach((p, id) => e.pos.set(id, p)); setAnchors(e, r.anchor);
    } else {
      const r = V.layout.layout(e.nodes, e.edges); e.pos.clear(); r.forEach((p, id) => e.pos.set(id, p));
    }
  }
  function setAnchors(e, anchor) { e.ports.forEach((p) => { const a = anchor.get(p.id); if (a) { p.anchor.dx = a.dx; p.anchor.dy = a.dy; } }); }
  /** 分層版面（ELK）在背景計算；超過上限、逾時或失敗時保留內建版面並說明原因 */
  async function applyElk(e) {
    const snap = App.snap; const token = ++e.token; const reset = layoutToken;
    const stale = () => App.snap !== snap || e.token !== token || layoutToken !== reset;
    const name = e.layer === 'l2' ? 'L2 埠圖' : 'L3 子網圖';
    A.banner(`${name}的分層版面計算中…`);
    try {
      if (e.layer === 'l2') {
        const r = await V.layout.elkPorts(e.boxes, e.ports, e.pg.edges, { maxNodes: App.ELK_MAX, isStale: stale });
        if (stale()) return;
        e.pos.clear(); r.pos.forEach((p, id) => e.pos.set(id, p)); setAnchors(e, r.anchor);
        A.banner(`已套用${name}的分層版面（${r.stats.nodes} 台設備、${r.stats.ports} 個埠，${r.stats.ms} ms）`, 4000);
      } else {
        const r = await V.layout.elk(e.nodes, e.edges, { radius: (n) => App.graph.radius(n), maxNodes: App.ELK_MAX, isStale: stale });
        if (stale()) return;
        r.pos.forEach((p, id) => e.pos.set(id, p));
        A.banner(`已套用${name}的分層版面（${r.stats.coreNodes} 個節點，${r.stats.ms} ms）`, 4000);
      }
      if (A.layerEntry() === e) { App.graph.computeGroups(); App.graph.fit(); } else e.view = null;
    } catch (err) {
      if (err.code === 'stale') return;
      if (!err.code) console.error(err);
      A.banner(`${name}的分層版面未套用：${err.message}，維持快速版面。`, 10000);
    }
  }

  // ================================================================ 選取與標示
  /**
   * VLAN 承載的標示（Q.vlanCarriers）：設備圖標在設備對的線上、L2 標在埠對埠的邊上，同一條線有多條鏈路時取最需要注意的狀態
   * （只有一端帶 > 承載 > 推論承載 > 只有一端可確認）。L3 標出屬於這個 VLAN 的子網。回傳 { nodes, edges }（Map）
   */
  A.vlanMarks = function vlanMarks(id, domain) {
    const Q = App.Q; const nodes = new Map(); const edges = new Map();
    if (App.layer === 'l3') {
      const e = A.layerEntry();
      if (e) e.sg.subnets.forEach((s) => { if (s.vlans.includes(+id) || s.vlan === +id) nodes.set(NET + s.id, MARK.good); });
      return { nodes, edges };
    }
    const c = Q.vlanCarriers(id, domain);
    const best = new Map();
    const at = App.layer === 'l2' ? (k) => A.layerEntry().index.edgeOfLink.get(k) : (k) => App.pairOfLink.get(k);
    c.links.forEach((l) => { const eid = at(l.key); if (eid && (!best.has(eid) || STATUS_RANK[l.status] > STATUS_RANK[best.get(eid)])) best.set(eid, l.status); });
    best.forEach((st, eid) => edges.set(eid, T.vlan[st]));
    if (App.layer === 'l2') {
      const E = A.layerEntry().index;
      c.devices.forEach((d) => { if (E.boxes.has(d)) nodes.set(d, MARK.good); });
      c.eps.forEach((ep) => { const p = E.portOfEp.get(ep); if (p) nodes.set(p, MARK.good); });
    } else c.devices.forEach((d) => nodes.set(d, MARK.good));
    return { nodes, edges };
  };
  /** 某條線在目前 VLAN 篩選下的狀態文字（提示用）；沒有篩選或這條線不承載時為 null */
  function vlanTip(linkKeys) {
    const f = App.vlanFilter; if (!f) return null;
    const rows = App.Q.vlanCarriers(f.id, f.domain).links.filter((l) => linkKeys.includes(l.key));
    if (!rows.length) return `VLAN ${f.id}：不承載`;
    const r = rows.slice().sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])[0];
    return `VLAN ${f.id}：${V.VLAN_STATUS[r.status]}` + (r.reason ? `（${V.VLAN_REASON[r.reason] || r.reason}）` : '');
  }
  A.vlanTip = vlanTip;

  /**
   * 選取在 L2／L3 的標示：回傳 { nodes, edges, focus, hl, overlay }（與設備圖的 App.select 相同的形狀）。
   * 設備、介面、鏈路、VLAN、MAC、IP、路由追蹤、子網與檢查結果的實體都對應到這一層的節點或邊；對不到的不標示。
   */
  A.layerMarks = function layerMarks(sel, o) {
    const Q = App.Q; const e = A.layerEntry(); const out = { nodes: [], edges: [], focus: [], hl: null, overlay: [] };
    if (!e || !sel) return out;
    const devOf = (ep) => K.splitEp(ep)[0];
    const has = (id) => App.graph.nodeById.has(id);
    const finds = (ids, col) => { const m = new Map(); ids.filter(has).forEach((x) => m.set(x, col)); return m; };
    const l2 = e.layer === 'l2';
    const portOf = (ep) => (l2 ? e.index.portOfEp.get(ep) : null);
    const subnetsOfIp = (ip) => { const r = Q.findIp(ip); return r ? r.subnets.map((s) => NET + s.net + '/' + s.len).filter(has) : []; };
    switch (sel.type) {
      case 'device': case 'firewall': case 'endpoints': case 'rule': case 'service': {
        const r = sel.type === 'rule' ? Q.getFirewallRule(sel.key) : null;
        const d = sel.type === 'device' ? sel.key : sel.dev || (r ? r.dev : devOf(sel.key));
        if (has(d)) { out.nodes = [d]; out.focus = [d]; }
        break;
      }
      case 'interface': {
        const p = portOf(sel.key); const d = devOf(sel.key);
        if (p) { out.nodes = [p]; out.edges = e.index.edgesOfPort.get(p) || []; out.focus = [p]; }
        else if (has(d)) {
          out.nodes = [d]; out.focus = [d];
          if (!l2) out.edges = (e.index.edgesOf.get(d) || []).filter((x) => x.l3 && x.l3.eps.includes(sel.key)).map((x) => x.id);
        }
        break;
      }
      case 'link': case 'pair': {
        const keys = sel.type === 'link' ? [sel.key] : (sel.links || []).concat(Q.inferredLinksBetween(sel.devs[0], sel.devs[1]).map((l) => l.key));
        const devs = sel.type === 'pair' ? sel.devs : (() => { const l = Q.getLink(sel.key); return l ? [devOf(l.a), devOf(l.b)] : []; })();
        if (l2) { out.edges = S.util.uniq(keys.map((k) => e.index.edgeOfLink.get(k)).filter(Boolean)); out.focus = out.edges.flatMap((x) => { const ed = e.index.edges.get(x); return [ed.a, ed.b]; }); }
        else { out.nodes = devs.filter(has); out.focus = out.nodes; }
        if (!out.focus.length) out.focus = devs.filter(has);
        break;
      }
      case 'subnet': {
        const id = NET + sel.key;
        if (!l2 && has(id)) { out.nodes = [id]; out.edges = (e.index.edgesOf.get(id) || []).map((x) => x.id); out.focus = [id].concat((e.index.edgesOf.get(id) || []).filter((x) => x.l3).map((x) => x.b)); }
        else if (l2) {
          const s = Q.subnetGraph().subnets.find((x) => x.id === sel.key);
          if (s) { out.hl = { nodes: finds(s.devices, MARK.find), edges: new Map() }; out.focus = s.devices.filter(has); }
        }
        break;
      }
      case 'vlan': { const m = A.vlanMarks(sel.key, sel.domain); out.hl = m; out.focus = Array.from(m.nodes.keys()); break; }
      case 'mac': {
        const m = Q.findMac(sel.key);
        const ids = S.util.uniq(m.edge.map(devOf).concat(l2 ? m.edge.map(portOf).filter(Boolean) : []).concat(m.behind ? [devOf(m.behind.anchor)] : []));
        out.hl = { nodes: finds(ids, MARK.find), edges: new Map() }; out.focus = ids.filter(has); break;
      }
      case 'ip': {
        const r = Q.findIp(sel.key); if (!r) break;
        const ids = S.util.uniq([...(r.owner ? [r.owner.split('|')[0]] : []), ...r.locations.map((x) => devOf(x.ep)), ...(l2 ? r.locations.map((x) => portOf(x.ep)).filter(Boolean) : subnetsOfIp(sel.key))]);
        out.hl = { nodes: finds(ids, MARK.find), edges: new Map() }; out.focus = ids.filter(has); break;
      }
      case 'trace': {
        const t = sel.result; if (!t.ok) break;
        out.overlay = t.edges.filter(([a, b]) => has(a) && has(b)).map(([a, b]) => ({ a, b, color: MARK.trace }));
        const ds = S.util.uniq([t.start, ...t.hops.map((x) => x.dev), ...t.ends.map((x) => x.dev)]);
        out.hl = { nodes: new Map(ds.filter(has).map((d) => [d, t.ends.some((x) => x.dev === d && x.status !== 'reached') ? MARK.bad : MARK.trace])), edges: new Map() };
        out.focus = ds.filter(has); break;
      }
      default: break;
    }
    if (o && o.findingEntities) {
      const nm = new Map(); const em = new Map();
      o.findingEntities.forEach((x) => {
        if (x.type === 'device' && has(x.key)) nm.set(x.key, MARK.bad);
        if (x.type === 'interface' || x.type === 'service') { const p = portOf(x.key); if (p) nm.set(p, MARK.bad); else if (has(devOf(x.key))) nm.set(devOf(x.key), MARK.bad); }
        if (x.type === 'rule') { const r = Q.getFirewallRule(x.key); if (r && has(r.dev)) nm.set(r.dev, MARK.bad); }
        if (x.type === 'link') {
          const l = Q.getLink(x.key); if (!l) return;
          const eid = l2 ? e.index.edgeOfLink.get(l.key) : null; if (eid) em.set(eid, MARK.bad);
          [devOf(l.a), devOf(l.b)].filter(has).forEach((d) => nm.set(d, MARK.bad));
        }
        if (x.type === 'ip' && !l2) subnetsOfIp(x.key).forEach((s) => nm.set(s, MARK.bad));
      });
      if (nm.size || em.size) { out.hl = { nodes: nm, edges: em }; out.focus = Array.from(nm.keys()); }
    }
    return out;
  };
  /** L2 只畫一台設備與鄰居時：選了不在圖上的設備，改以那一台為中心重畫（回傳是否重畫） */
  A.recenterL2 = function recenterL2(dev) {
    if (App.layer !== 'l2' || App.l2.scope !== 'focus' || !dev || App.graph.nodeById.has(dev) || !App.Q.getDevice(dev)) return false;
    App.l2.focus = dev; A.showLayer('l2');
    return true;
  };

  // ================================================================ 圖上互動（L2／L3）
  /** 點選：L2 的設備框 → 設備、埠 → 介面（推論鏈路未收集端的未知埠 → 設備）、邊 → 鏈路或設備對；L3 的子網 → 子網、設備 → 設備、位址邊 → 介面 */
  A.layerClick = function layerClick(it) {
    const e = A.layerEntry(); if (!e) return;
    if (it.type === 'node') {
      const n = App.graph.nodeById.get(it.id); if (!n) return;
      if (n.kind === 'subnet') return App.select({ type: 'subnet', key: n.subnet.id });
      if (n.kind === 'port') return App.select(n.ifc ? { type: 'interface', key: n.ifc } : { type: 'device', key: n.dev });
      return App.select({ type: 'device', key: n.id });
    }
    const ed = e.index.edges.get(it.id); if (!ed) return;
    if (ed.pg) {
      const p = ed.pg;
      if (p.links.length === 1 && !p.inferredLinks.length) return App.select({ type: 'link', key: p.links[0] });
      const first = p.links[0] || p.inferredLinks[0];
      return App.select({ type: 'pair', id: App.pairOfLink.get(first) || p.id, links: p.links.slice(), devs: [p.aDev, p.bDev] });
    }
    if (ed.route) return App.select({ type: 'subnet', key: ed.route.subnet });
    if (ed.overlap) return App.select({ type: 'subnet', key: ed.overlap[0] });
    if (ed.l3) return App.select(ed.l3.eps.length ? { type: 'interface', key: ed.l3.eps[0] } : { type: 'subnet', key: ed.l3.subnet });
    return undefined;
  };
  /** 雙擊（Shift+Enter）：聚焦；L2 只畫一台設備時，雙擊鄰居的設備框改以它為中心 */
  A.layerDblClick = function layerDblClick(it) {
    const n = App.graph.nodeById.get(it.id); if (!n) return;
    if (App.layer === 'l2' && n.box && App.l2.scope === 'focus' && n.id !== App.l2.focus) { App.l2.focus = n.id; A.showLayer('l2'); }
    A.layerClick(it);
    App.select(App.sel, { focus: true });
  };
  /** 提示文字：設備、埠、子網與各種邊；有 VLAN 篩選時加上這條線的承載狀態與原因 */
  A.layerTip = function layerTip(item) {
    const Q = App.Q; const e = A.layerEntry(); if (!e) return '';
    if (item.type === 'node') {
      const n = App.graph.nodeById.get(item.id); if (!n) return '';
      if (n.kind === 'port') {
        const p = n.port;
        return `${Q.devName(p.dev)} ${p.name}`
          + (p.unknown ? '・未知埠（推論鏈路的未收集端）' : `・${V.IFC_TYPE[p.type] || p.type || '介面'}`)
          + (p.members.length ? `・成員 ${p.members.map((m) => K.splitEp(m)[1]).join('、')}` : '')
          + (p.lag ? `・屬於 ${K.splitEp(p.lag)[1]}` : '')
          + (p.vlans.length ? `・VLAN ${S.util.fmtVlans(p.vlans)}` : '');
      }
      if (n.kind === 'subnet') {
        const s = n.subnet;
        return `${s.id}${s.vlan != null ? `・VLAN ${s.vlan}` : ''}・${s.basis === 'route' ? '只由路由得知（不是直連網段）' : `${s.devices.length} 台設備`}`
          + (s.routers.length ? `・路由設備 ${s.routers.map((d) => Q.devName(d)).join('、')}` : '')
          + (s.overlaps.length ? `・與 ${s.overlaps.join('、')} 重疊` : '') + (s.duplicateIps.length ? `・重複 IP ${s.duplicateIps.join('、')}` : '');
      }
      const d = Q.getDevice(n.id);
      const base = d ? `${d.label || d.name}・${V.KIND[d.kind]}${d.collected ? '' : '・未收集'}` : n.label;
      if (n.l3) return base + (n.l3.router ? `・路由設備（推論：${n.l3.routerBasis === 'routes' ? '有路由表' : '設備類型'}，接 ${n.l3.subnets.length} 個子網）` : n.l3.multihomed ? `・多個子網的主機（不算路由設備）` : '');
      return base + (n.sub ? '・' + n.sub : '');
    }
    const ed = e.index.edges.get(item.id); if (!ed) return '';
    if (ed.pg) {
      const p = ed.pg; const end = (ep) => { const x = e.index.ports.get(ep); return `${Q.devName(K.splitEp(ep)[0])} ${x ? x.name : K.splitEp(ep)[1]}`; };
      const vt = vlanTip(p.links.concat(p.inferredLinks));
      return `${end(p.a)} ⇄ ${end(p.b)}・${V.PORT_EVIDENCE[p.evidence]}${p.count > 1 ? `・${p.count} 條鏈路` : ''}` + (vt ? '・' + vt : '');
    }
    if (ed.route) {
      const r = ed.route;
      return `${Q.devName(r.dev)} 的${r.default ? '預設路由' : '路由'} ${r.subnet}（${r.proto}）・下一跳 ${r.nh.map((x) => x.ip || x.ifc).filter(Boolean).join('、') || '—'}${r.blackhole ? '・黑洞路由' : ''}`;
    }
    if (ed.overlap) return `網段重疊：${ed.overlap.join(' 與 ')}`;
    if (ed.l3) {
      const x = ed.l3;
      return `${Q.devName(x.dev)} 在 ${x.subnet}：${x.addresses.map((a) => a.address).join('、')}・${V.L3_BASIS[x.basis]}`;
    }
    return '';
  };

  // ================================================================ 工具列：層級切換、VLAN 篩選、L2／L3 的選項
  const layerBtns = () => Array.from(document.querySelectorAll('#layer-switch button'));
  A.bindLayers = function bindLayers() {
    const btns = layerBtns();
    btns.forEach((b) => {
      b.addEventListener('click', () => { if (!b.disabled) App.showLayer(b.dataset.layer); });
      b.addEventListener('keydown', (ev) => {
        const usable = btns.filter((x) => !x.disabled); const at = usable.indexOf(b);
        const next = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: usable.length - 1 }[ev.key];
        if (next === undefined || at < 0) return;
        ev.preventDefault();
        const t = usable[(next + usable.length) % usable.length];
        App.showLayer(t.dataset.layer); t.focus();
      });
    });
    $('#vlan-filter').onchange = () => {
      const v = $('#vlan-filter').value;
      if (!v) { // 取消篩選：選取的是 VLAN 時一起取消，否則保留選取、只拿掉標示
        App.vlanFilter = null;
        if (App.sel && App.sel.type === 'vlan') App.select(null); else App.select(App.sel, { refresh: true });
        A.syncLayerUi(); return;
      }
      App.select({ type: 'vlan', key: v });
    };
    const toggle = (sel, fn) => { $(sel).onclick = () => { fn(); A.showLayer(App.layer); }; };
    toggle('#btn-l2-lag', () => { App.l2.lag = App.l2.lag === 'collapse' ? 'expand' : 'collapse'; });
    toggle('#btn-l2-ports', () => { App.l2.ports = App.l2.ports === 'linked' ? 'all' : 'linked'; });
    toggle('#btn-l3-routes', () => { App.l3.routes = !App.l3.routes; });
    $('#l2-scope').onchange = () => {
      App.l2.scope = $('#l2-scope').value;
      if (App.l2.scope === 'focus') App.l2.focus = selectedDevice() || App.l2.focus;
      A.showLayer('l2');
    };
  };
  let vlanOptionsOf = null;
  /** 工具列與說明跟著目前的層級：層級按鈕、各層的選項、VLAN 選單、畫布的 aria-label、說明文字 */
  A.syncLayerUi = function syncLayerUi() {
    const L = App.layer;
    layerBtns().forEach((b) => {
      const on = b.dataset.layer === L;
      b.setAttribute('aria-checked', String(on)); b.setAttribute('tabindex', on ? '0' : '-1'); b.classList.toggle('on', on);
    });
    // 只在某些層級有用的工具列群組：class layer-only，data-layers 列出層級
    document.querySelectorAll('.layer-only').forEach((el) => el.classList.toggle('hidden', !el.dataset.layers.split(' ').includes(L)));
    // L4：矩陣疊在畫布上；畫布、圖例與操作說明不顯示也不能聚焦（鍵盤不會移到底下的畫布）
    const l4 = L === 'l4' && !!App.Q;
    $('#view-l4').classList.toggle('hidden', !l4);
    $('#graph').inert = l4;
    ['#legend', '#hint'].forEach((s) => $(s).classList.toggle('hidden', !App.snap || l4));
    // VLAN 選單：選項來自 Q.vlanIds()，換基準時重建
    const sel = $('#vlan-filter');
    if (App.Q && vlanOptionsOf !== App.Q) {
      vlanOptionsOf = App.Q; V.clear(sel);
      sel.appendChild(h('option', { value: '' }, 'VLAN：不篩選'));
      App.Q.vlanIds().forEach((id) => sel.appendChild(h('option', { value: String(id) }, 'VLAN ' + id)));
    }
    sel.value = App.vlanFilter ? String(App.vlanFilter.id) : '';
    const lag = $('#btn-l2-lag'); const expanded = App.l2.lag === 'expand';
    lag.setAttribute('aria-pressed', String(expanded)); lag.classList.toggle('on', expanded);
    const pts = $('#btn-l2-ports'); const all = App.l2.ports === 'all';
    pts.setAttribute('aria-pressed', String(all)); pts.classList.toggle('on', all);
    const rt = $('#btn-l3-routes'); rt.setAttribute('aria-pressed', String(App.l3.routes)); rt.classList.toggle('on', App.l3.routes);
    const scope = $('#l2-scope'); scope.value = App.l2.scope;
    const allOpt = Array.from(scope.querySelectorAll('option')).find((x) => x.value === 'all'); if (allOpt) allOpt.disabled = !!App.l2.tooBig;
    $('#btn-force').disabled = L === 'l2';
    $('#btn-force').title = L === 'l2' ? 'L2 埠圖的埠固定在設備框上，不用力導向' : '用力導向微調位置（再按一次停止）';
    const cv = $('#graph');
    if (L !== 'l4') cv.setAttribute('aria-label', `拓樸圖（${V.LAYER[L]}）。N 下一個${L === 'l2' ? '設備或埠' : L === 'l3' ? '子網或設備' : '設備'}、Shift+N 上一個、Enter 開啟詳情、Shift+Enter 聚焦、Esc 取消選取、方向鍵平移、+ 與 - 縮放、0 全圖`);
    renderNote();
    A.renderSteps(); // 步驟列「② 檢視」的狀態是目前的層級
  };
  /** 這一層的說明：畫了多少、哪些沒畫（L2 的 MNDP、只畫一台設備時的原因），L3 的路由、重疊與 VRF */
  function renderNote() {
    const note = $('#layer-note'); const e = A.layerEntry();
    note.classList.toggle('hidden', !e);
    if (!e) { note.textContent = ''; return; }
    const Q = App.Q; const n = V.num;
    if (e.layer === 'l2') {
      const i = e.info; const omit = i.omitted;
      note.textContent = `L2 埠圖：${n(e.boxes.length)} 台設備、${n(e.ports.length)} 個埠、${n(e.edges.length)} 條連線（聚合${i.lag === 'collapse' ? '收合' : '展開'}、${i.portsMode === 'all' ? '全部的埠' : '只有連線的埠'}）。`
        + (i.scope === 'focus' ? `只畫 ${Q.devName(i.focus)} 與它的鄰居${i.tooBig ? `（整張 ${n(i.total)} 台，超過上限 ${n(App.L2_MAX)} 台）` : ''}；選取其他設備或雙擊鄰居可改看那一台。` : '')
        + (omit.domainOnly ? `另有 ${n(omit.domainOnly)} 條只有 MNDP 的鏈路沒有畫（MNDP 只證明同一廣播網域，不是直連）。` : '')
        + (omit.sameDevice ? `${n(omit.sameDevice)} 條同一台設備兩埠之間的鏈路沒有畫。` : '');
    } else {
      const ss = e.sg.subnets; const ov = ss.filter((s) => s.overlaps.length).length; const dup = ss.reduce((k, s) => k + s.duplicateIps.length, 0);
      note.textContent = `L3 子網圖：${n(ss.length)} 個網段、${n(e.sg.nodes.length)} 個設備節點；點線是推論的位址（鄰居回報、管理 IP）`
        + (e.info.routes ? `，虛線箭頭是 ${n(e.sg.routes.length)} 條靜態／預設路由` : '') + '。'
        + (ov || dup ? `有 ${n(ov)} 個網段重疊、${n(dup)} 個重複 IP（點選子網看詳情）。` : '')
        + 'M3 之前不分 VRF。';
    }
  }
  /** 匯出 PNG 的檔名：目前的層級（L4 沒有 PNG，見 A.exportPng） */
  A.layerPngName = () => (App.layer === 'device' ? 'topology.png' : `topology-${App.layer}.png`);
})(globalThis.SSOT = globalThis.SSOT || {});
