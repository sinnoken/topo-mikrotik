/*
 * 基準 → 圖：設備對合併成線、未知對端節點、新葉節點擺放、展開收合、可見度，以及版面排程（ELK 分層／內建快速）。
 * 圖資料只用於畫面，不寫進基準。
 */
(function (S) {
  'use strict';
  const V = S.view; const $ = V.$; const K = S.keys; const LINK_SCOPE = S.LINK_SCOPE;
  const A = V.app; const App = window.App;
  const EP = V.theme.endpoint;
  const vendorColor = (v) => (v && App.vendorColors.get(v)) || EP.vendorFallback;
  const isMultiWifi = (r) => r.visualOnly && r.type === 'wireless' && r.macs.length > 1;
  const vendorIni = (v) => (v ? v.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '').slice(0, 2).toUpperCase() : '?');

  // ================================================================ 版面排程
  /** 分層版面（ELK）：在背景計算，完成後替換位置；超過上限、逾時或失敗時保留現有版面並說明原因。 */
  A.applyElk = async function applyElk(g) {
    const snap = App.snap; const token = (App.layoutToken = (App.layoutToken || 0) + 1);
    A.banner('分層版面計算中…');
    try {
      const r = await V.layout.elk(g.nodes, g.edges, {
        radius: (n) => App.graph.radius(n), maxNodes: App.ELK_MAX, isStale: () => App.snap !== snap || App.layoutToken !== token,
      });
      if (App.snap !== snap || App.layoutToken !== token) return;
      r.pos.forEach((p, id) => App.graph.pos.set(id, p));
      App.graph.computeGroups(); App.graph.fit(); A.savePositions();
      A.banner(`已套用分層版面（${r.stats.coreNodes} 台網路設備，${r.stats.ms} ms）`, 4000);
    } catch (e) {
      if (e.code === 'stale') return;
      if (!e.code) console.error(e); // 超過上限、逾時是預期情況，只顯示提示
      A.banner(`分層版面未套用：${e.message}，維持快速版面。可在工具列改用「快速（內建）」。`, 10000);
    }
  };

  /** 依目前的版面模式重新排列（工具列的「重新排列」與切換版面模式） */
  A.relayout = function relayout() {
    if (!App.snap) return;
    const g = A.graphData(App.Q);
    if (App.layoutMode === 'elk') { App.layoutJob = A.applyElk(g); return; }
    App.layoutToken = (App.layoutToken || 0) + 1; // 取消進行中的分層版面
    const auto = V.layout.layout(g.nodes, g.edges);
    auto.forEach((p, id) => App.graph.pos.set(id, p)); App.graph.computeGroups(); App.graph.fit(); A.savePositions();
  };

  // ================================================================ 圖資料
  /** 基準 → 圖：同兩台設備之間的多條鏈路合併成一條線 */
  A.graphData = function graphData(Q) {
    const sevRank = { error: 2, warn: 1 };
    const devSev = new Map(); const linkSev = new Map();
    const bump = (map, k, s) => { if (!sevRank[s]) return; if (!map.has(k) || sevRank[s] > sevRank[map.get(k)]) map.set(k, s); };
    Q.findings().forEach((f) => f.entities.forEach((e) => {
      if (e.type === 'device') bump(devSev, e.key, f.severity);
      else if (e.type === 'link') bump(linkSev, e.key, f.severity);
      else if (e.type === 'interface') bump(devSev, K.splitEp(e.key)[0], f.severity);
    }));
    const nodes = Q.devices().map((d) => ({
      id: d.key, label: d.label || d.name, kind: d.kind, collected: d.collected, group: d.group, sev: devSev.get(d.key) || null,
    }));
    // 設備對與證據強度由 query 決定；這裡只加上檢視用的嚴重度與兩端標籤。
    // 只有 MNDP 的設備對不畫：MNDP 只證明同一廣播網域，推論鏈路已涵蓋可以推定相鄰的情況；MNDP 仍列在詳情
    const pairs = new Map(); App.pairOfLink = new Map();
    Q.devicePairs().forEach((p) => {
      if (p.evidence === 'domainOnly') return;
      pairs.set(p.id, p);
      p.links.concat(p.inferred).forEach((k) => App.pairOfLink.set(k, p.id));
      p.sev = p.links.reduce((s, k) => { const x = linkSev.get(k); return x && (!s || sevRank[x] > sevRank[s]) ? x : s; }, null);
    });
    const inferredPort = (dev, keys) => S.util.uniq(keys.map((k) => Q.getInferredLink(k)).flatMap((l) => [l.a, l.b])
      .filter((ep) => K.splitEp(ep)[0] === dev)
      .map((ep) => (K.splitEp(ep)[1].startsWith('?(') ? '?' : (Q.getInterface(ep) || { name: K.splitEp(ep)[1] }).name)));
    pairs.forEach((p) => {
      const interfaceLinks = p.links.map((k) => Q.getLink(k)).filter((l) => l.evidenceScope !== LINK_SCOPE.BROADCAST_DOMAIN);
      const side = (dev) => {
        if (p.evidence === 'inferred') { const ports = inferredPort(dev, p.inferred); return (ports.length === 1 ? ports[0] : `${ports.length} 埠`) + '（推論）'; }
        const eps = interfaceLinks.map((l) => (K.splitEp(l.a)[0] === dev ? l.a : l.b)).map((ep) => Q.getInterface(ep));
        const parents = S.util.uniq(eps.map((i) => (i ? (i.lag ? Q.getInterface(i.lag).name : i.name) : '?')));
        const labels = parents.length === 1 ? parents[0] + (eps.length > 1 ? ` ×${eps.length}` : '') : `${eps.length} 條`;
        return labels;
      };
      p.labelA = side(p.a); p.labelB = side(p.b);
    });
    App.pairs = pairs;
    addUnknownPeers(Q, nodes, pairs);
    const edges = Array.from(pairs.values());
    // 沒有命名規則時，大型網路依連線密度自動分區（只影響版面）
    if (!Q.meta().profile) { const cm = V.layout.communities(nodes, edges); if (cm) nodes.forEach((n) => { n.group = cm.get(n.id) || n.group; }); }
    return { nodes, edges };
  };

  // ---------------------------------------------------------------- 未知對端
  /**
   * 終端埠與 Wi-Fi MAC 觀察 → 畫成「未知對端」節點。
   * 單一 MAC：圓形；多 MAC 的 Wi-Fi：菱形（僅為圖面提示，不視為終端或參與 A02）。
   *  - 一台設備上超過 UNKNOWN_EXPAND_MAX 個（或全網超過上限）：收合成一個群組節點，雙擊展開
   */
  /**
   * 廠商色：theme 只有 8 色，依終端數量取前 8 個廠商（同數量依名稱），其餘與不明廠商歸「其他」（vendorFallback）。
   * 數量取自全部未知對端與推定終端，不受展開／收合影響，所以同一份基準裡廠商的顏色固定。
   */
  function vendorPalette(Q) {
    const n = new Map(); const add = (v) => { if (v) n.set(v, (n.get(v) || 0) + 1); };
    Q.visualUnknownDevices().forEach((d) => Q.visualUnknownPeers(d).forEach((r) => { if (!isMultiWifi(r)) add(r.macs[0].vendor); }));
    Q.behindGroups().forEach((rows) => rows.forEach((x) => add(x.vendor)));
    const ranked = Array.from(n.entries()).sort((a, b) => b[1] - a[1] || S.util.natural(a[0], b[0]));
    App.vendorColors = new Map(ranked.slice(0, EP.vendor.length).map(([v], i) => [v, EP.vendor[i]]));
    App.vendorOthers = ranked.length - App.vendorColors.size;
    if (A.renderVendorLegend) A.renderVendorLegend();
  }

  function addUnknownPeers(Q, nodes, pairs) {
    App.virtual = new Map(); App.vOfEp = new Map(); App.virtualByDev = new Map();
    vendorPalette(Q);
    const devs = Q.visualUnknownDevices();
    const total = devs.reduce((n, d) => n + Q.visualUnknownPeers(d).length, 0);
    const forceCollapse = total > App.UNKNOWN_TOTAL_CAP;
    const link = (dk, vid, labelA, extra) => {
      const id = 'v~' + vid;
      pairs.set(id, Object.assign({
        id, a: dk, b: vid, links: [], inferred: [], cls: 'other', count: 1, evidence: 'hearsay', virtual: true, sev: null, labelA, labelB: '',
      }, extra || {}));
      S.util.getOr(App.virtualByDev, dk, () => []).push(vid);
    };
    devs.forEach((dk) => {
      const dev = Q.getDevice(dk); const rows = Q.visualUnknownPeers(dk);
      const expand = App.expanded.has(dk) || (!forceCollapse && rows.length <= App.UNKNOWN_EXPAND_MAX);
      if (!expand) {
        const vid = '?c|' + dk; const macs = rows.reduce((n, r) => n + r.macs.length, 0);
        nodes.push({ id: vid, label: `終端 ×${rows.length}`, kind: 'cluster', collected: false, virtual: true, parent: dk, group: dev.group, count: rows.length,
          tip: `${Q.devName(dk)}：${rows.length} 個埠沒有 LLDP／CDP 介面鄰接（${macs} 個 MAC）・雙擊展開` });
        App.virtual.set(vid, { type: 'endpoints', dev: dk }); rows.forEach((r) => App.vOfEp.set(r.ep, vid));
        link(dk, vid, `${rows.length} 埠`);
        return;
      }
      rows.forEach((r) => {
        const vid = '?p|' + r.ep; const m0 = r.macs[0]; const ip = m0.ips[0];
        const multiWifi = isMultiWifi(r); const ifStyle = EP.styleOf(r);
        const label = r.desc || ip || m0.vendor || K.macPretty(m0.mac).slice(-8);
        const tip = `${Q.devName(dk)} ${r.name}`
          + (multiWifi ? '（Wi-Fi・多個 MAC）' : '')
          + (ifStyle ? '（' + ifStyle.label + '）' : '')
          + `：${multiWifi ? `${r.macs.length} 個 MAC` : K.macPretty(m0.mac)}`
          + (ip ? '・' + ip : '')
          + (m0.vendor ? '・' + m0.vendor : '')
          + (r.vlans.length ? '・VLAN ' + r.vlans.join(',') : '');
        nodes.push({ id: vid, label: multiWifi ? `${r.macs.length} 個 MAC` : label, kind: multiWifi ? 'downstream' : 'endpoint', collected: false, virtual: true, parent: dk, group: dev.group,
          count: r.macs.length, vendor: m0.vendor || null, color: vendorColor(m0.vendor), ini: vendorIni(m0.vendor), tip });
        App.virtual.set(vid, { type: 'interface', ep: r.ep }); App.vOfEp.set(r.ep, vid);
        link(dk, vid, r.name, { ifStyle });
      });
    });
    // 推定在未收集交換器（例如 SwOS 的 CSS106）底下的終端：掛在該交換器下，連線用推論樣式，埠不明
    Q.behindGroups().forEach((rows, dk) => {
      const dev = Q.getDevice(dk); if (!dev) return;
      const where = (x) => (x.behind.dev ? `在 ${Q.devName(x.behind.dev)} 底下（埠不明）` : `在 ${x.behind.via.map((v) => Q.devName(v)).join('、')} 或其下游`);
      const via = (x) => `依 ${Q.epName(x.behind.anchor)} 的 MAC 表推定`;
      if (!App.expanded.has(dk) && (forceCollapse || rows.length > App.UNKNOWN_EXPAND_MAX)) {
        const vid = '?bc|' + dk;
        nodes.push({ id: vid, label: `推定終端 ×${rows.length}`, kind: 'cluster', collected: false, virtual: true, parent: dk, group: dev.group, count: rows.length,
          tip: `${rows.length} 個終端${where(rows[0])}・${via(rows[0])}・雙擊展開` });
        App.virtual.set(vid, { type: 'behind', dev: dk });
        link(dk, vid, '埠不明', { evidence: 'inferred' });
        return;
      }
      rows.forEach((x) => {
        const vid = '?b|' + x.mac; const ip = x.ips[0];
        nodes.push({ id: vid, label: ip || x.vendor || K.macPretty(x.mac).slice(-8), kind: 'endpoint', collected: false, virtual: true, parent: dk, group: dev.group, count: 1,
          vendor: x.vendor || null, color: vendorColor(x.vendor), ini: vendorIni(x.vendor),
          tip: `推定位置：${K.macPretty(x.mac)}${ip ? '・' + ip : ''}${x.vendor ? '・' + x.vendor : ''} ${where(x)}・${via(x)}` });
        App.virtual.set(vid, { type: 'mac', mac: x.mac });
        link(dk, vid, '埠不明', { evidence: 'inferred' });
      });
    });
  }

  /** 新出現的葉節點，排在所屬設備下方的小方陣（避開該設備已有的葉節點） */
  A.placeLeaves = function placeLeaves(fresh, allNodes, edges, pos) {
    if (!fresh.length) return;
    const LCOLS = 4; const LDX = 44; const LDY = 40; const byParent = new Map();
    fresh.forEach((n) => S.util.getOr(byParent, n.parent, () => []).push(n));
    const kids = new Map(); edges.forEach((e) => { S.util.getOr(kids, e.a, () => []).push(e.b); });
    byParent.forEach((list, dk) => {
      const pp = pos.get(dk); if (!pp) { list.forEach((n) => pos.set(n.id, { x: 0, y: 0 })); return; }
      const freshIds = new Set(list.map((n) => n.id));
      let startY = pp.y + 64;
      (kids.get(dk) || []).forEach((k) => { if (!freshIds.has(k) && pos.has(k)) { const q = pos.get(k); if (q.y > pp.y + 30) startY = Math.max(startY, q.y + LDY); } });
      const cols = Math.min(LCOLS, list.length);
      list.sort((a, b) => S.util.natural(a.id, b.id))
        .forEach((n, i) => pos.set(n.id, { x: pp.x + ((i % cols) - (cols - 1) / 2) * LDX, y: startY + Math.floor(i / cols) * LDY }));
    });
  };

  /** 展開／收合後重建圖資料，保留使用者已調整的位置 */
  function refreshGraph() {
    const g = A.graphData(App.Q); const old = App.graph.pos; const pos = new Map(); const fresh = [];
    g.nodes.forEach((n) => { const q = old.get(n.id); if (q) pos.set(n.id, q); else fresh.push(n); });
    A.placeLeaves(fresh, g.nodes, g.edges, pos);
    fresh.forEach((n) => { if (!pos.has(n.id)) pos.set(n.id, { x: 0, y: 0 }); });
    App.graph.setData(g.nodes, g.edges, pos);
    A.applyVisibility();
    App.select(App.sel, {});
    A.savePositions();
  }
  App.toggleExpand = function (dk) {
    if (App.expanded.has(dk)) App.expanded.delete(dk); else App.expanded.add(dk);
    refreshGraph();
  };

  A.applyVisibility = function applyVisibility() {
    App.graph.setVisible((n) => (App.showHosts || n.kind !== 'host') && (App.showUnknown || !n.virtual));
    $('#btn-unknown').classList.toggle('on', App.showUnknown);
    App.graph.computeGroups();
    $('#btn-hosts').classList.toggle('on', App.showHosts);
  };
})(globalThis.SSOT = globalThis.SSOT || {});
