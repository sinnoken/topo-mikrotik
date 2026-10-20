/*
 * 畫面組裝：輸入 → 建立基準 → 圖、檢查結果、覆蓋率、比對、詳細資料。
 * 畫面只透過 SSOT.query() 讀取基準；所有邏輯（解析、建模、檢查、追蹤、比對）都在核心，不在這裡。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$; const K = S.keys; const LINK_SCOPE = S.LINK_SCOPE;
  const App = {
    snap: null, Q: null, sources: [], profileJson: null, graph: null, pairOfLink: new Map(), pairs: new Map(), sel: null, showHosts: true,
    // 未知對端（沒有 LLDP／CDP 介面鄰接、只由 MAC 推論出來的末端）：只存在於畫面，不寫進基準
    showUnknown: true, expanded: new Set(), virtual: new Map(), vOfEp: new Map(), virtualByDev: new Map(),
    UNKNOWN_EXPAND_MAX: 8, UNKNOWN_TOTAL_CAP: 800,
    // 版面模式：elk（分層，預設）或 builtin（快速）；網路設備超過 ELK_MAX 台時分層版面不執行
    layoutMode: 'elk', layoutJob: Promise.resolve(), ELK_MAX: 1500,
  };
  window.App = App;

  // ================================================================ 啟動
  async function init() {
    App.graph = new V.GraphView($('#graph'));
    App.graph.on('click', onGraphClick);
    App.graph.on('dblclick', onGraphDblClick);
    App.graph.on('hover', onHover);
    let saveT = null;
    App.graph.on('moved', () => { clearTimeout(saveT); saveT = setTimeout(savePositions, 600); App.graph.computeGroups(); });
    App.layoutMode = (await S.store.get('layoutMode').catch(() => null)) || 'elk';
    bindHeader(); bindToolbar(); bindInputDialog(); bindTabs(); bindMobileWorkspaces(); await bindResizers();
    if (!(await S.store.available())) banner('這個瀏覽器無法使用本機儲存，關閉頁面後基準不會保留。');
    await App.restore();
  }

  /** 還原上次的基準：schema 或版本不同時用保存的輸入重建；無法還原時明確告知，不靜默略過。 */
  App.restore = async function () {
    const last = await S.store.get('last').catch(() => null);
    const saved = last && last.snapshot && last.snapshot.meta ? last.snapshot : null;
    if (saved) {
      App.sources = last.sources || []; App.profileJson = last.profile || null;
      const sameSchema = saved.meta.schema === S.SCHEMA;
      let snap = sameSchema ? saved : null; let msg = `已還原上次建立的基準（${V.fmtTime(saved.meta.createdAt)}）`;
      if ((!sameSchema || saved.meta.version !== S.VERSION) && App.sources.length) { // 程式更新過：用保存的輸入重建，欄位才會完整
        try { snap = await S.buildAsync(App.sources, { profile: App.profileJson }); msg = '程式已更新，已用保存的輸入重新建立基準'; } catch (e) {
          console.error(e);
          if (!sameSchema) msg = `上次的基準格式（${saved.meta.schema}）已不相容，重新建立失敗：${e.message}。請重新建立基準。`;
        }
      } else if (!sameSchema) msg = `上次的基準格式（${saved.meta.schema}）已不相容，且沒有保存輸入，請重新建立基準。`;
      if (snap) load(snap, last.positions); else renderAll();
      banner(msg, 6000);
    } else renderAll();
  };

  // ================================================================ 載入基準
  function load(snap, positions) {
    App.snap = snap; App.Q = S.query(snap); App.sel = null; App.expanded = new Set();
    V.lists.findings.reset(); V.lists.compare.reset(); V.lists.findings.openFirst(snap);
    const g = graphData(App.Q, snap);
    const hostCount = g.nodes.filter((n) => n.kind === 'host').length;
    App.showHosts = hostCount <= 300;
    const pos = new Map();
    const auto = V.layout.layout(g.nodes, g.edges);
    const fresh = [];
    g.nodes.forEach((n) => {
      const saved = positions && positions[n.id];
      if (saved) pos.set(n.id, saved);
      else if (positions && n.virtual && positions[n.parent]) fresh.push(n); // 還原舊位置時，新出現的未知對端排在它所屬設備下方
      else pos.set(n.id, auto.get(n.id) || { x: 0, y: 0 });
    });
    placeLeaves(fresh, g.nodes, g.edges, pos);
    App.graph.setData(g.nodes, g.edges, pos);
    applyVisibility();
    App.graph.fit();
    renderAll();
    // 先以內建版面立即出圖；沒有保存位置時再於背景套用分層版面
    App.layoutJob = App.layoutMode === 'elk' && !(positions && Object.keys(positions).length) ? applyElk(g) : Promise.resolve();
  }

  /** 分層版面（ELK）：在背景計算，完成後替換位置；超過上限、逾時或失敗時保留現有版面並說明原因。 */
  async function applyElk(g) {
    const snap = App.snap; const token = (App.layoutToken = (App.layoutToken || 0) + 1);
    banner('分層版面計算中…');
    try {
      const r = await V.layout.elk(g.nodes, g.edges, {
        radius: (n) => App.graph.radius(n), maxNodes: App.ELK_MAX, isStale: () => App.snap !== snap || App.layoutToken !== token,
      });
      if (App.snap !== snap || App.layoutToken !== token) return;
      r.pos.forEach((p, id) => App.graph.pos.set(id, p));
      App.graph.computeGroups(); App.graph.fit(); savePositions();
      banner(`已套用分層版面（${r.stats.coreNodes} 台網路設備，${r.stats.ms} ms）`, 4000);
    } catch (e) {
      if (e.code === 'stale') return;
      if (!e.code) console.error(e); // 超過上限、逾時是預期情況，只顯示提示
      banner(`分層版面未套用：${e.message}，維持快速版面。可在工具列改用「快速（內建）」。`, 10000);
    }
  }

  /** 基準 → 圖：同兩台設備之間的多條連結合併成一條線 */
  function graphData(Q, snap) {
    const sevRank = { error: 2, warn: 1 };
    const devSev = new Map(); const linkSev = new Map();
    const bump = (map, k, s) => { if (!sevRank[s]) return; if (!map.has(k) || sevRank[s] > sevRank[map.get(k)]) map.set(k, s); };
    snap.findings.forEach((f) => f.entities.forEach((e) => {
      if (e.type === 'device') bump(devSev, e.key, f.severity);
      else if (e.type === 'link') bump(linkSev, e.key, f.severity);
      else if (e.type === 'interface') bump(devSev, K.splitEp(e.key)[0], f.severity);
    }));
    const nodes = snap.model.devices.map((d) => ({ id: d.key, label: d.label || d.name, kind: d.kind, collected: d.collected, group: d.group, sev: devSev.get(d.key) || null }));
    const pairs = new Map(); App.pairOfLink = new Map();
    const CLS_RANK = ['lag', '40g', '10g', '1g', 'oob', 'other', 'l3'];
    snap.model.links.forEach((l) => {
      if (l.layer !== 'l2') return;
      const da = K.splitEp(l.a)[0]; const db = K.splitEp(l.b)[0];
      if (da === db) return;
      const [a, b] = da < db ? [da, db] : [db, da]; const id = a + '~' + b;
      const p = S.util.getOr(pairs, id, () => ({ id, a, b, links: [], cls: 'l3', count: 0, hearsay: true, sev: null, domainOnly: true, hasDomain: false }));
      p.links.push(l.key); App.pairOfLink.set(l.key, id);
      if (CLS_RANK.indexOf(l.cls) < CLS_RANK.indexOf(p.cls)) p.cls = l.cls;
      if (l.layer === 'l2') p.count++;
      if (!l.hearsay) p.hearsay = false;
      if (l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN) p.hasDomain = true;
      else p.domainOnly = false;
      const s = linkSev.get(l.key); if (s && (!p.sev || sevRank[s] > sevRank[p.sev])) p.sev = s;
    });
    pairs.forEach((p) => {
      const ls = p.links.map((k) => Q.getLink(k));
      const interfaceLinks = ls.filter((l) => l.evidenceScope !== LINK_SCOPE.BROADCAST_DOMAIN);
      const side = (dev) => {
        if (!interfaceLinks.length) return 'MNDP';
        const eps = interfaceLinks.map((l) => (K.splitEp(l.a)[0] === dev ? l.a : l.b)).map((ep) => Q.getInterface(ep));
        const parents = S.util.uniq(eps.map((i) => (i ? (i.lag ? Q.getInterface(i.lag).name : i.name) : '?')));
        const labels = parents.length === 1 ? parents[0] + (eps.length > 1 ? ` ×${eps.length}` : '') : `${eps.length} 條`;
        return labels + (p.hasDomain ? ' + MNDP' : '');
      };
      p.labelA = side(p.a); p.labelB = side(p.b);
    });
    App.pairs = pairs;
    addUnknownPeers(Q, nodes, pairs);
    const edges = Array.from(pairs.values());
    // 沒有命名規則時，大型網路依連線密度自動分區（只影響版面）
    if (!snap.meta.profile) { const cm = V.layout.communities(nodes, edges); if (cm) nodes.forEach((n) => { n.group = cm.get(n.id) || n.group; }); }
    return { nodes, edges };
  }

  // ---------------------------------------------------------------- 未知對端
  const EP = V.theme.endpoint; const MARK = V.theme.mark; const WEAK = V.theme.weakEdge; const CV = V.theme.canvas;
  const vendorColor = (v) => (v ? EP.vendor[Array.from(v).reduce((a, ch) => a + ch.charCodeAt(0), 0) % EP.vendor.length] : EP.vendorFallback);
  const vendorIni = (v) => (v ? v.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '').slice(0, 2).toUpperCase() : '?');

  /**
   * 末端埠與 Wi-Fi MAC 觀察 → 畫成「未知對端」節點。
   * 單一 MAC：圓形；多 MAC 的 Wi-Fi：菱形（僅為圖面提示，不視為末端或參與 A02）。
   *  - 一台設備上超過 UNKNOWN_EXPAND_MAX 個（或全網超過上限）：收合成一個群組節點，雙擊展開
   */
  function addUnknownPeers(Q, nodes, pairs) {
    App.virtual = new Map(); App.vOfEp = new Map(); App.virtualByDev = new Map();
    const devs = Q.visualUnknownDevices();
    const total = devs.reduce((n, d) => n + Q.visualUnknownPeers(d).length, 0);
    const forceCollapse = total > App.UNKNOWN_TOTAL_CAP;
    const link = (dk, vid, labelA, extra) => {
      const id = 'v~' + vid;
      pairs.set(id, Object.assign({ id, a: dk, b: vid, links: [], cls: 'other', count: 1, hearsay: true, virtual: true, sev: null, labelA, labelB: '' }, extra || {}));
      S.util.getOr(App.virtualByDev, dk, () => []).push(vid);
    };
    devs.forEach((dk) => {
      const dev = Q.getDevice(dk); const rows = Q.visualUnknownPeers(dk);
      const expand = App.expanded.has(dk) || (!forceCollapse && rows.length <= App.UNKNOWN_EXPAND_MAX);
      if (!expand) {
        const vid = '?c|' + dk; const macs = rows.reduce((n, r) => n + r.macs.length, 0);
        nodes.push({ id: vid, label: `末端 ×${rows.length}`, kind: 'cluster', collected: false, virtual: true, parent: dk, group: dev.group, count: rows.length,
          tip: `${Q.devName(dk)}：${rows.length} 個埠沒有 LLDP／CDP 介面鄰接（${macs} 個 MAC）・雙擊展開` });
        App.virtual.set(vid, { type: 'endpoints', dev: dk }); rows.forEach((r) => App.vOfEp.set(r.ep, vid));
        link(dk, vid, `${rows.length} 埠`);
        return;
      }
      rows.forEach((r) => {
        const vid = '?p|' + r.ep; const m0 = r.macs[0]; const ip = m0.ips[0];
        const multiWifi = r.visualOnly && r.type === 'wireless' && r.macs.length > 1; const ifStyle = EP.styleOf(r);
        const label = r.desc || ip || m0.vendor || K.macPretty(m0.mac).slice(-8);
        nodes.push({ id: vid, label: multiWifi ? `${r.macs.length} 個 MAC` : label, kind: multiWifi ? 'downstream' : 'endpoint', collected: false, virtual: true, parent: dk, group: dev.group,
          count: r.macs.length, color: vendorColor(m0.vendor), ini: vendorIni(m0.vendor),
          tip: `${Q.devName(dk)} ${r.name}${multiWifi ? '（Wi-Fi・多個 MAC）' : ''}${ifStyle ? '（' + ifStyle.label + '）' : ''}：${multiWifi ? `${r.macs.length} 個 MAC` : K.macPretty(m0.mac)}${ip ? '・' + ip : ''}${m0.vendor ? '・' + m0.vendor : ''}${r.vlans.length ? '・VLAN ' + r.vlans.join(',') : ''}` });
        App.virtual.set(vid, { type: 'interface', ep: r.ep }); App.vOfEp.set(r.ep, vid);
        link(dk, vid, r.name, { ifStyle });
      });
    });
  }

  /** 新出現的葉節點，排在所屬設備下方的小方陣（避開該設備已有的葉節點） */
  function placeLeaves(fresh, allNodes, edges, pos) {
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
      list.sort((a, b) => S.util.natural(a.id, b.id)).forEach((n, i) => pos.set(n.id, { x: pp.x + ((i % cols) - (cols - 1) / 2) * LDX, y: startY + Math.floor(i / cols) * LDY }));
    });
  }

  /** 展開／收合後重建圖資料，保留使用者已調整的位置 */
  function refreshGraph() {
    const g = graphData(App.Q, App.snap); const old = App.graph.pos; const pos = new Map(); const fresh = [];
    g.nodes.forEach((n) => { const q = old.get(n.id); if (q) pos.set(n.id, q); else fresh.push(n); });
    placeLeaves(fresh, g.nodes, g.edges, pos);
    fresh.forEach((n) => { if (!pos.has(n.id)) pos.set(n.id, { x: 0, y: 0 }); });
    App.graph.setData(g.nodes, g.edges, pos);
    applyVisibility();
    App.select(App.sel, {});
    savePositions();
  }
  App.toggleExpand = function (dk) {
    if (App.expanded.has(dk)) App.expanded.delete(dk); else App.expanded.add(dk);
    refreshGraph();
  };

  function applyVisibility() {
    App.graph.setVisible((n) => (App.showHosts || n.kind !== 'host') && (App.showUnknown || !n.virtual));
    $('#btn-unknown').classList.toggle('on', App.showUnknown);
    App.graph.computeGroups();
    $('#btn-hosts').classList.toggle('on', App.showHosts);
  }

  async function savePositions() {
    if (!App.snap) return;
    const last = await S.store.get('last'); if (!last) return;
    last.positions = Object.fromEntries(App.graph.pos); await S.store.set('last', last);
  }

  // ================================================================ 選取
  App.select = function (sel, opt) {
    App.sel = sel; const o = opt || {}; const g = App.graph; const Q = App.Q;
    g.setOverlay([]); g.setHighlight(null);
    let nodes = []; let edges = []; let focus = [];
    if (!sel) { g.setSelection([], []); V.details.render(App, null); return; }
    const pairsOf = (linkKeys) => S.util.uniq(linkKeys.map((k) => App.pairOfLink.get(k)).filter(Boolean));
    const devOf = (ep) => K.splitEp(ep)[0];
    switch (sel.type) {
      case 'device': nodes = [sel.key]; focus = [sel.key]; break;
      case 'link': { const l = Q.getLink(sel.key); if (l) { edges = pairsOf([l.key]); focus = [devOf(l.a), devOf(l.b)]; } break; }
      case 'pair': edges = [sel.id]; focus = sel.devs; break;
      case 'interface': { const i = Q.getInterface(sel.key); if (i) { const v = App.vOfEp.get(i.key); nodes = [i.dev].concat(v ? [v] : []); edges = pairsOf(Q.linksOfEp(i.key).map((l) => l.key)); focus = v ? [i.dev, v] : [i.dev]; } break; }
      case 'endpoints': { const vs = App.virtualByDev.get(sel.dev) || []; nodes = [sel.dev].concat(vs); focus = [sel.dev].concat(vs); break; }
      case 'mac': { const m = Q.findMac(sel.key); const ds = S.util.uniq(m.edge.map(devOf).concat(m.edge.map((ep) => App.vOfEp.get(ep)).filter(Boolean))); g.setHighlight({ nodes: new Map(ds.map((d) => [d, MARK.find])), edges: new Map() }); focus = ds; break; }
      case 'ip': { const r = Q.findIp(sel.key); const ds = S.util.uniq([...(r.owner ? [r.owner.split('|')[0]] : []), ...r.locations.map((x) => devOf(x.ep)), ...r.locations.map((x) => App.vOfEp.get(x.ep)).filter(Boolean)]); g.setHighlight({ nodes: new Map(ds.map((d) => [d, MARK.find])), edges: new Map() }); focus = ds; break; }
      case 'vlan': {
        const v = Q.vlan(sel.key); const em = new Map();
        pairsOf(v.carry.map((l) => l.key)).forEach((p) => em.set(p, MARK.good));
        pairsOf(v.partial.map((l) => l.key)).forEach((p) => em.set(p, MARK.bad));
        g.setHighlight({ nodes: new Map(v.devices.map((d) => [d, MARK.good])), edges: em }); focus = v.devices; break;
      }
      case 'trace': {
        const t = sel.result; if (t.ok) {
          g.setOverlay(t.edges.map(([a, b]) => ({ a, b, color: MARK.trace })));
          const ds = S.util.uniq([t.start, ...t.hops.map((x) => x.dev), ...t.ends.map((e) => e.dev)]);
          g.setHighlight({ nodes: new Map(ds.map((d) => [d, t.ends.some((e) => e.dev === d && e.status !== 'reached') ? MARK.bad : MARK.trace])), edges: new Map() }); focus = ds;
        }
        break;
      }
      default: break;
    }
    if (o.findingEntities) {
      const nm = new Map(); const em = new Map();
      o.findingEntities.forEach((e) => {
        if (e.type === 'device') nm.set(e.key, MARK.bad);
        if (e.type === 'interface') nm.set(devOf(e.key), MARK.bad);
        if (e.type === 'link') { const l = Q.getLink(e.key); if (l) { em.set(App.pairOfLink.get(l.key), MARK.bad); nm.set(devOf(l.a), MARK.bad); nm.set(devOf(l.b), MARK.bad); } }
      });
      if (nm.size || em.size) { g.setHighlight({ nodes: nm, edges: em }); focus = Array.from(nm.keys()); }
    }
    // 要聚焦的主機被隱藏時，自動顯示主機
    if (!App.showHosts && focus.some((k) => { const d = Q.getDevice(k); return d && d.kind === 'host'; })) { App.showHosts = true; applyVisibility(); }
    if (!App.showUnknown && focus.some((k) => String(k).startsWith('?'))) { App.showUnknown = true; applyVisibility(); }
    g.setSelection(nodes, edges);
    if (o.focus && focus.length) g.focus(focus);
    V.details.render(App, sel);
    if (sel && isNarrowScreen()) setWorkspace('details');
  };

  App.selectFinding = function (idx) {
    const f = App.snap.findings[idx]; const e = f.entities[0];
    const sel = !e ? null : f.id === 'A03' ? { type: 'endpoints', dev: e.key } : { type: e.type, key: e.key };
    App.select(sel, { focus: true, findingEntities: f.id === 'A03' ? null : f.entities });
  };

  const selOfVirtual = (vid) => { const v = App.virtual.get(vid); return v ? (v.type === 'endpoints' ? { type: 'endpoints', dev: v.dev } : { type: 'interface', key: v.ep }) : null; };
  function onGraphClick(it) {
    if (!it) return App.select(null);
    if (it.type === 'node') return App.select(String(it.id).startsWith('?') ? selOfVirtual(it.id) : { type: 'device', key: it.id });
    const p = App.pairs.get(it.id); if (!p) return;
    if (p.virtual) return App.select(selOfVirtual(p.b));
    if (p.links.length === 1) App.select({ type: 'link', key: p.links[0] });
    else App.select({ type: 'pair', id: p.id, links: p.links, devs: [p.a, p.b] });
  }
  function onGraphDblClick(it) {
    const v = App.virtual.get(it.id);
    if (v && v.type === 'endpoints') return App.toggleExpand(v.dev);         // 群組：展開
    if (v) return App.select(selOfVirtual(it.id), { focus: true });
    App.select({ type: 'device', key: it.id }, { focus: true });
  }
  function onHover(ev) {
    const tip = $('#tooltip');
    if (!ev.item) { tip.classList.add('hidden'); return; }
    let text = '';
    if (ev.item.type === 'node') {
      const vn = App.graph.nodeById.get(ev.item.id);
      if (vn && vn.virtual) text = vn.tip; else { const d = App.Q.getDevice(ev.item.id); text = `${d.label || d.name}・${V.KIND[d.kind]}${d.collected ? '' : '・未收集'}`; }
    } else {
      const p = App.pairs.get(ev.item.id);
      if (p.virtual) text = App.graph.nodeById.get(p.b).tip;
      else if (p.domainOnly) text = `${App.Q.devName(p.a)} ⇄ ${App.Q.devName(p.b)}・MNDP 觀察到同一 L2 broadcast domain 可達；不代表兩台設備直連`;
      else text = `${App.Q.devName(p.a)} ${p.labelA} ⇄ ${App.Q.devName(p.b)} ${p.labelB}${p.hasDomain ? '・另有 MNDP L2 網域可達證據' : ''}`;
    }
    tip.textContent = text; tip.classList.remove('hidden');
    tip.style.left = (ev.x + 14) + 'px'; tip.style.top = (ev.y + 12) + 'px';
  }

  // ================================================================ 原文檢視
  App.openRaw = function (file, line) {
    const src = App.sources.find((s) => s.name === file);
    const dlg = $('#dlg-raw'); const body = V.clear($('#raw-body'));
    $('#raw-title').textContent = `${file}　第 ${line} 行`;
    if (!src) body.appendChild(h('p', { class: 'muted' }, '找不到原始輸入（可能是從舊版本還原的基準）。'));
    else {
      const lines = src.text.split(/\r?\n/); const from = Math.max(1, line - 12); const to = Math.min(lines.length, line + 25);
      const pre = h('pre', { class: 'raw' });
      for (let i = from; i <= to; i++) pre.appendChild(h('span', { class: i === line ? 'hl' : null }, [h('span', { class: 'ln' }, String(i)), lines[i - 1] + '\n']));
      body.appendChild(pre);
    }
    dlg.showModal();
    const hl = body.querySelector('.hl'); if (hl) hl.scrollIntoView({ block: 'center' });
  };

  // ================================================================ 路由追蹤
  App.openTrace = function (src, dst) {
    const pop = $('#trace-pop'); pop.classList.remove('hidden');
    if (src !== undefined) $('#trace-src').value = src; if (dst !== undefined) $('#trace-dst').value = dst;
    ($('#trace-src').value ? $('#trace-dst') : $('#trace-src')).focus();
  };
  function runTrace() {
    if (!App.Q) return;
    const r = S.trace(App.Q, $('#trace-src').value.trim(), $('#trace-dst').value.trim());
    $('#trace-pop').classList.add('hidden');
    App.select({ type: 'trace', result: r }, { focus: true });
  }

  // ================================================================ 頁首、工具列、分頁
  function bindHeader() {
    $('#btn-input').onclick = () => openInput();
    $('#btn-trace').onclick = () => { const p = $('#trace-pop'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) $('#trace-src').focus(); };
    $('#trace-run').onclick = runTrace;
    ['#trace-src', '#trace-dst'].forEach((s) => $(s).addEventListener('keydown', (e) => { if (e.key === 'Enter') runTrace(); if (e.key === 'Escape') $('#trace-pop').classList.add('hidden'); }));
    $('#btn-clear').onclick = async () => {
      if (!App.snap || !confirm('清除目前的基準與輸入？（只清除這個工具的資料）')) return;
      await S.store.del('last'); App.snap = null; App.Q = null; App.sources = []; App.graph.setData([], [], new Map()); renderAll();
    };
    // 搜尋
    const inp = $('#search'); const dd = $('#search-dd'); let results = []; let active = 0;
    const show = () => {
      V.clear(dd); if (!App.Q || !inp.value.trim()) { dd.classList.add('hidden'); return; }
      results = App.Q.search(inp.value, 15); active = 0;
      if (!results.length) dd.appendChild(h('div', { class: 'empty' }, '找不到符合的設備、MAC、IP 或 VLAN'));
      const T = { device: '設備', mac: 'MAC', ip: 'IP', vlan: 'VLAN', interface: '介面' };
      results.forEach((r, i) => dd.appendChild(h('div', { class: 'item' + (i === active ? ' active' : ''), onmousedown: (e) => { e.preventDefault(); pick(r); } }, [V.chip(T[r.type]), h('span', null, r.label), h('span', { class: 'sub' }, r.sub || '')])));
      dd.classList.remove('hidden');
    };
    const pick = (r) => { dd.classList.add('hidden'); inp.blur(); App.select({ type: r.type, key: r.key }, { focus: true }); };
    let t = null;
    inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(show, 120); });
    inp.addEventListener('focus', show);
    inp.addEventListener('blur', () => setTimeout(() => dd.classList.add('hidden'), 150));
    inp.addEventListener('keydown', (e) => {
      const items = dd.querySelectorAll('.item');
      if (e.key === 'Enter' && results[active]) pick(results[active]);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, Math.min(results.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1))); items.forEach((el, i) => el.classList.toggle('active', i === active)); }
      else if (e.key === 'Escape') { dd.classList.add('hidden'); inp.blur(); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); inp.focus(); } });
  }
  function bindToolbar() {
    $('#btn-fit').onclick = () => App.graph.fit();
    $('#btn-relayout').onclick = () => {
      if (!App.snap) return;
      const g = graphData(App.Q, App.snap);
      if (App.layoutMode === 'elk') { App.layoutJob = applyElk(g); return; }
      App.layoutToken = (App.layoutToken || 0) + 1; // 取消進行中的分層版面
      const auto = V.layout.layout(g.nodes, g.edges);
      auto.forEach((p, id) => App.graph.pos.set(id, p)); App.graph.computeGroups(); App.graph.fit(); savePositions();
    };
    $('#layout-mode').value = App.layoutMode;
    $('#layout-mode').onchange = () => {
      App.layoutMode = $('#layout-mode').value;
      S.store.set('layoutMode', App.layoutMode).catch(() => {});
      $('#btn-relayout').click();
    };
    let running = null;
    $('#btn-force').onclick = () => {
      if (running) { cancelAnimationFrame(running); running = null; $('#btn-force').classList.remove('on'); savePositions(); return; }
      const nodes = App.graph.nodes.filter((n) => App.graph.visible(n)); const ids = new Set(nodes.map((n) => n.id));
      const edges = App.graph.edges.filter((e) => ids.has(e.a) && ids.has(e.b)); let temp = 60; let it = 0;
      $('#btn-force').classList.add('on');
      const step = () => {
        const per = nodes.length > 1500 ? 1 : 3;
        for (let k = 0; k < per; k++) { V.layout.forceStep(nodes, edges, App.graph.pos, temp); temp *= 0.985; it++; }
        App.graph.computeGroups();
        if (it < 360 && temp > 1) running = requestAnimationFrame(step); else { running = null; $('#btn-force').classList.remove('on'); savePositions(); }
      };
      running = requestAnimationFrame(step);
    };
    $('#btn-hosts').onclick = () => { App.showHosts = !App.showHosts; applyVisibility(); };
    $('#btn-unknown').onclick = () => { App.showUnknown = !App.showUnknown; applyVisibility(); };
    $('#btn-groups').onclick = () => { App.graph.showGroups = !App.graph.showGroups; $('#btn-groups').classList.toggle('on', App.graph.showGroups); App.graph.redraw(); };
    $('#btn-png').onclick = () => { const a = document.createElement('a'); a.download = 'topology.png'; a.href = $('#graph').toDataURL('image/png'); a.click(); };
    // 圖例
    const lg = $('#legend');
    // 圖例的外形、顏色、線寬、虛線與透明度全部取自 theme，與 Canvas 繪圖同一來源
    // 分四類，預設收合只顯示標題列；細節說明放 title，避免圖例太長
    const head = h('button', { class: 'legend-head', title: '展開／收合圖例' }, '圖例 ▸');
    const body = h('div', { class: 'legend-body hidden' });
    head.onclick = () => { const open = body.classList.contains('hidden'); body.classList.toggle('hidden', !open); head.textContent = open ? '圖例 ▾' : '圖例 ▸'; };
    lg.appendChild(head); lg.appendChild(body);
    let grp = null;
    const group = (title) => { grp = h('div', { class: 'lg-group' }, [h('div', { class: 'lg-title' }, title)]); body.appendChild(grp); };
    const item = (swatches, label, tip) => grp.appendChild(h('div', { class: 'li', title: tip || null }, swatches.concat(label)));
    const LEG = 12;
    const SHAPE_CSS = {
      shield: { clipPath: 'polygon(50% 0, 100% 22%, 90% 70%, 50% 100%, 10% 70%, 0 22%)' },
      wide: { width: Math.round(LEG * 1.4) + 'px', height: Math.round(LEG * 0.85) + 'px', borderRadius: '2px' },
      square: { borderRadius: '2px' },
      circle: {},
    };
    const dot = (style) => h('span', { class: 'sev', style: Object.assign({ width: LEG + 'px', height: LEG + 'px' }, style) });
    const line = (color, w, dash, alpha) => h('span', { class: 'ln', style: {
      borderTopWidth: '0', height: Math.max(2, Math.round(w)) + 'px', opacity: String(alpha == null ? 1 : alpha),
      background: dash ? `repeating-linear-gradient(90deg, ${dash.reduce((stops, n, i) => {
        const next = (stops.pos || 0) + n; const shade = i % 2 ? 'transparent' : color;
        stops.parts.push(`${shade} ${stops.pos || 0}px`, `${shade} ${next}px`); stops.pos = next; return stops;
      }, { parts: [], pos: 0 }).parts.join(', ')})` : color,
    } });
    group('設備');
    Object.entries(V.KIND).forEach(([k, label]) => item([dot(Object.assign({ background: V.KIND_COLOR[k] }, SHAPE_CSS[V.theme.shape[k]]))], label));
    item([dot(Object.assign({ background: CV.uncollectedFill, border: '2px dashed ' + V.KIND_COLOR.unknown }, SHAPE_CSS.circle))], '未收集', '基準裡沒有收集檔的設備（虛線外框）');
    group('末端');
    item([dot({ background: EP.vendorFallback, border: '1.5px solid ' + CV.outline })], '單一 MAC', '未知對端：一個埠一個 MAC，依廠商上色');
    item([dot({ background: EP.downstream.fill, border: '2px dashed ' + EP.downstream.stroke, transform: 'rotate(45deg)', borderRadius: '0' })], 'Wi-Fi 多 MAC', 'Wi-Fi MAC 觀察位置列入末端清單；Wi-Fi 介面不算末端埠，且不參與 A02');
    item([dot({ background: EP.cluster.fill, border: '1.5px solid ' + EP.cluster.stroke, width: Math.round(LEG * 1.3) + 'px', height: Math.round(LEG * 0.8) + 'px', borderRadius: '3px' })], '群組 ×N', '同一台設備末端過多時收合，雙擊展開');
    item([h('span', { class: 'sev error' })], '錯誤／警告');
    group('連線');
    Object.entries(V.EDGE_STYLE).forEach(([k, st]) => item([line(st.c, st.w, st.dash)], V.CLS[k],
      k === '1g' ? '推論分類：ether、sfp1、combo 等介面名稱歸為 1G；不代表實際協商速率，ether 也可能是 2.5G 或 10G。' : null));
    group('連線註記');
    item([line(WEAK.hearsay.c, V.EDGE_STYLE.other.w, WEAK.hearsay.dash, WEAK.hearsay.alpha)], '聽說', '紫色點線：對端沒有提供 LLDP 鄰居資料，屬單向觀察');
    item([line(WEAK.domainOnly.c, V.EDGE_STYLE.other.w, WEAK.domainOnly.dash, WEAK.domainOnly.alpha)], 'MNDP', '灰色點劃線：MNDP 表示同一 L2 網域可達，不代表兩台設備直連');
    Object.values(EP.byType).forEach((t) => item([line(t.c, V.EDGE_STYLE.other.w, WEAK.hearsay.dash, WEAK.hearsay.alpha)], t.label, '連到 ' + t.label + ' 介面末端的連線'));
  }
  // 左右欄寬度是檢視狀態：存在獨立的 'layout' 鍵，清除基準時不受影響
  const PANE = { min: 240, centerMin: 320, def: { left: 330, right: 400 } };
  async function bindResizers() {
    const main = $('#main'); const sides = { left: $('#left'), right: $('#right') };
    const saved = (await S.store.get('layout').catch(() => null)) || {};
    App.layout = { left: PANE.def.left, right: PANE.def.right };
    const clamp = (side, w) => {
      const other = App.layout[side === 'left' ? 'right' : 'left']; const total = window.innerWidth || Infinity;
      return Math.round(Math.max(PANE.min, Math.min(w, total - other - PANE.centerMin)));
    };
    const apply = () => { main.style.gridTemplateColumns = `${App.layout.left}px 1fr ${App.layout.right}px`; };
    ['left', 'right'].forEach((side) => { if (Number.isFinite(saved[side])) App.layout[side] = clamp(side, saved[side]); });
    apply();
    const persist = () => S.store.set('layout', Object.assign({}, App.layout)).catch(() => {});
    ['left', 'right'].forEach((side) => {
      const grip = h('div', { class: 'grip grip-' + side, title: '拖曳調整寬度，雙擊還原' });
      sides[side].appendChild(grip);
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault(); const x0 = e.clientX; const w0 = App.layout[side];
        const move = (ev) => { App.layout[side] = clamp(side, w0 + (side === 'left' ? 1 : -1) * (ev.clientX - x0)); apply(); };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); grip.classList.remove('on'); persist(); };
        grip.classList.add('on'); document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
      grip.addEventListener('dblclick', () => { App.layout[side] = clamp(side, PANE.def[side]); apply(); persist(); });
    });
  }
  function bindTabs() {
    document.querySelectorAll('#left .tabs button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#left .tabs button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('#left .pane').forEach((p) => p.classList.toggle('hidden', p.id !== b.dataset.pane));
    }));
  }
  function isNarrowScreen() { return Number(window.innerWidth) <= 900; }
  function setWorkspace(workspace) {
    $('#main').dataset.workspace = workspace;
    document.querySelectorAll('#mobile-workspaces button').forEach((button) => {
      const active = button.dataset.workspace === workspace;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  function bindMobileWorkspaces() {
    document.querySelectorAll('#mobile-workspaces button').forEach((button) => button.addEventListener('click', () => {
      setWorkspace(button.dataset.workspace);
    }));
  }
  function activatePane(pane) {
    const button = document.querySelectorAll('#left .tabs button').find((item) => item.dataset.pane === pane);
    if (button) button.click();
    setWorkspace('checks');
  }

  // ================================================================ 輸入對話框
  const input = { files: [] };
  function bindInputDialog() {
    const dlg = $('#dlg-input');
    $('#input-close').onclick = () => dlg.close();
    $('#input-file').onchange = (e) => addFiles(e.target.files);
    $('#input-pick').onclick = () => $('#input-file').click();
    $('#input-sample').onclick = () => { $('#input-text').value = S.samples['sample-bundle.txt']; input.files = []; renderFiles(); };
    const drop = $('#input-drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
    $('#input-profile').onchange = async (e) => {
      if (e.target.value !== '__file') return;
      const f = await pickFile('.json,application/json'); if (!f) { e.target.value = ''; return; }
      try { const j = JSON.parse(await f.text()); S.profile.compile(j); S.profiles[j.id] = j; const saved = (await S.store.get('profiles')) || {}; saved[j.id] = j; await S.store.set('profiles', saved); fillProfiles(j.id); }
      catch (err) { alert(err.message); e.target.value = ''; }
    };
    $('#input-build').onclick = runBuild;
  }
  function pickFile(accept) { return new Promise((res) => { const i = h('input', { type: 'file', accept, onchange: () => res(i.files[0] || null) }); i.click(); }); }
  async function addFiles(list) {
    for (const f of Array.from(list)) input.files.push({ name: f.name, text: await f.text() });
    renderFiles();
  }
  function renderFiles() {
    const box = V.clear($('#input-files'));
    input.files.forEach((f, i) => box.appendChild(V.chip(`${f.name}（${V.num(f.text.length)} 字元）  ✕`, '', { title: '點一下移除', style: { cursor: 'pointer' }, onclick: () => { input.files.splice(i, 1); renderFiles(); } })));
  }
  async function fillProfiles(selected) {
    const saved = (await S.store.get('profiles').catch(() => null)) || {};
    Object.assign(S.profiles, saved);
    const sel = V.clear($('#input-profile'));
    sel.appendChild(h('option', { value: '' }, '不套用（只依收集的資料判斷）'));
    Object.values(S.profiles).filter((p) => p && p.id).forEach((p) => sel.appendChild(h('option', { value: p.id }, `${p.id}${p.label ? '：' + p.label : ''}`)));
    sel.appendChild(h('option', { value: '__file' }, '載入命名規則檔（JSON）…'));
    sel.value = selected || '';
  }
  async function openInput() {
    const pasted = App.sources.find((s) => s.name === S.readers.PASTE);
    $('#input-text').value = pasted ? pasted.text : '';
    input.files = App.sources.filter((s) => s.name !== S.readers.PASTE).map((s) => ({ ...s }));
    renderFiles(); await fillProfiles(App.profileJson ? App.profileJson.id : '');
    $('#input-progress').classList.add('hidden'); $('#input-status').textContent = '';
    $('#dlg-input').showModal();
  }
  async function runBuild() {
    const text = $('#input-text').value;
    const sources = [];
    if (text.trim()) sources.push({ name: S.readers.PASTE, text });
    input.files.forEach((f) => sources.push({ name: f.name, text: f.text }));
    if (!sources.length) { $('#input-status').textContent = '請貼上收集檔內容，或選擇檔案。'; return; }
    const pid = $('#input-profile').value; const profile = pid && pid !== '__file' ? S.profiles[pid] : null;
    const btn = $('#input-build'); btn.disabled = true;
    const bar = $('#input-progress'); bar.classList.remove('hidden'); const fill = bar.firstElementChild;
    try {
      const snap = await S.buildAsync(sources, { profile }, (p) => {
        $('#input-status').textContent = p.stage + (p.total > 1 ? `（${p.done}/${p.total}）` : '');
        fill.style.width = (p.stage === '完成' ? 100 : p.stage === '一致性檢查' ? 92 : p.stage === '建立模型' ? 80 : 5 + 70 * (p.done / Math.max(p.total, 1))) + '%';
      });
      App.sources = sources; App.profileJson = profile;
      $('#input-status').textContent = '繪製中…';
      await new Promise((r) => setTimeout(r, 0));
      load(snap, null);
      await S.store.set('last', { snapshot: snap, sources, profile, positions: Object.fromEntries(App.graph.pos) }).catch(() => banner('基準太大，無法存入瀏覽器；關閉頁面後需要重新建立。'));
      $('#dlg-input').close();
      const st = snap.meta.stats;
      banner(`已建立基準：${V.num(st.collected)} 台已收集設備、${V.num(st.links)} 條連結；錯誤 ${st.findings.error}、警告 ${st.findings.warn}（${(snap.meta.timing.ms / 1000).toFixed(1)} 秒）`, 8000);
    } catch (e) {
      $('#input-status').textContent = '建立失敗：' + e.message; console.error(e);
    } finally { btn.disabled = false; }
  }

  // ================================================================ 其他
  function banner(text, ms) {
    const b = $('#banner'); b.textContent = text; b.classList.remove('hidden');
    clearTimeout(banner.t); if (ms) banner.t = setTimeout(() => b.classList.add('hidden'), ms);
  }
  function renderAll() {
    const has = !!App.snap;
    $('#welcome').classList.toggle('hidden', has);
    ['#toolbar', '#legend', '#hint'].forEach((s) => $(s).classList.toggle('hidden', !has));
    renderBaselineSummary();
    $('#btn-trace').disabled = !has; $('#search').disabled = !has; $('#btn-clear').disabled = !has;
    const f = V.clear($('#footer'));
    if (has) {
      const m = App.snap.meta;
      f.appendChild(h('span', null, `建立：${V.fmtTime(m.createdAt)}`));
      f.appendChild(h('span', null, `設備 ${V.num(m.stats.devices)}（已收集 ${V.num(m.stats.collected)}）・連結 ${V.num(m.stats.links)}・MAC ${V.num(m.stats.macs)}`));
      f.appendChild(h('span', null, `命名規則：${m.profile ? m.profile.id : '未套用'}`));
      f.appendChild(h('span', { class: 'mono' }, `輸入指紋 ${m.inputHash}`));
      f.appendChild(h('span', null, `版本 ${m.version}`));
    } else f.appendChild(h('span', null, `網路基準 ${S.VERSION}・資料只在這個瀏覽器處理，不會傳到任何地方`));
    V.lists.findings(App); V.lists.coverage(App); V.lists.compare(App); V.lists.inventory(App);
    V.details.render(App, App.sel);
  }
  function renderBaselineSummary() {
    const root = V.clear($('#baseline-summary'));
    const has = !!App.snap;
    root.classList.toggle('hidden', !has);
    if (!has) return;
    const stats = App.snap.meta.stats;
    const missing = App.snap.coverage.filter((row) => row.collected && row.missing.length).length;
    const problems = stats.findings.error + stats.findings.warn;
    root.appendChild(h('div', { class: 'baseline-state' }, [
      h('strong', null, '基準檢查'),
      h('span', { class: 'baseline-message' }, problems
        ? `目前規則找到 ${V.num(stats.findings.error)} 項錯誤、${V.num(stats.findings.warn)} 項警告`
        : '目前規則未發現錯誤或警告'),
      h('span', { class: 'baseline-coverage' }, `收集完整度：${V.num(stats.collected)} / ${V.num(stats.devices)} 台設備已收集；${V.num(missing)} 台有必要資料缺漏`),
    ]));
    const actions = h('div', { class: 'baseline-actions' });
    actions.appendChild(h('button', {
      disabled: !problems,
      onclick: () => {
        V.lists.findings.showProblems(App);
        activatePane('pane-findings');
      },
    }, '查看錯誤／警告'));
    actions.appendChild(h('button', {
      disabled: !missing,
      onclick: () => {
        V.lists.coverage.showMissing(App);
        activatePane('pane-coverage');
      },
    }, '查看收集缺漏'));
    actions.appendChild(h('button', { onclick: () => App.openTrace() }, '路由追蹤'));
    actions.appendChild(h('button', { onclick: () => $('#search').focus() }, '搜尋定位'));
    root.appendChild(actions);
  }
  App.openInput = openInput;
  App.loadSample = async () => { await openInput(); $('#input-text').value = S.samples['sample-bundle.txt']; input.files = []; renderFiles(); };

  document.addEventListener('DOMContentLoaded', init);
})(globalThis.SSOT = globalThis.SSOT || {});
