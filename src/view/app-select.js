/*
 * 選取與圖上互動：選取後的圖面標示與詳情、點擊／雙擊／hover、原文檢視、路由追蹤。
 * 選取是檢視狀態，不寫進基準。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$; const K = S.keys;
  const A = V.app; const App = window.App;
  const MARK = V.theme.mark;

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
      case 'interface': {
        const i = Q.getInterface(sel.key);
        if (i) {
          const v = App.vOfEp.get(i.key);
          nodes = [i.dev].concat(v ? [v] : []);
          edges = pairsOf(Q.linksOfEp(i.key).concat(Q.inferredLinksOfEp(i.key)).map((l) => l.key));
          focus = v ? [i.dev, v] : [i.dev];
        }
        break;
      }
      // 防火牆畫面：規則鍵與服務鍵（設備|服務名）都以設備鍵開頭；規則已不在基準時仍標出設備
      case 'firewall': nodes = [sel.dev]; focus = [sel.dev]; break;
      case 'rule': case 'service': {
        const r = sel.type === 'rule' ? Q.getFirewallRule(sel.key) : null;
        const dk = r ? r.dev : K.splitEp(sel.key)[0];
        if (Q.getDevice(dk)) { nodes = [dk]; focus = [dk]; }
        break;
      }
      case 'endpoints': { const vs = App.virtualByDev.get(sel.dev) || []; nodes = [sel.dev].concat(vs); focus = [sel.dev].concat(vs); break; }
      case 'mac': {
        const m = Q.findMac(sel.key); const ds = S.util.uniq(m.edge.map(devOf).concat(m.edge.map((ep) => App.vOfEp.get(ep)).filter(Boolean)));
        const em = new Map();
        if (m.behind) { // 推定位置：錨點設備 → 推論鏈路 → 未收集交換器 → 終端（或其群組）
          const vid = ['?b|' + m.mac, '?bc|' + (m.behind.dev || devOf(m.behind.anchor))].find((v) => App.virtual.has(v));
          ds.push(devOf(m.behind.anchor), ...(m.behind.dev ? [m.behind.dev] : m.behind.via), ...(vid ? [vid] : []));
          pairsOf(Q.behindVia(m.mac).map((l) => l.key)).concat(vid ? ['v~' + vid] : []).forEach((p) => em.set(p, MARK.find));
        }
        g.setHighlight({ nodes: new Map(S.util.uniq(ds).map((d) => [d, MARK.find])), edges: em }); focus = S.util.uniq(ds); break;
      }
      case 'ip': {
        const r = Q.findIp(sel.key);
        const ds = S.util.uniq([
          ...(r.owner ? [r.owner.split('|')[0]] : []),
          ...r.locations.map((x) => devOf(x.ep)),
          ...r.locations.map((x) => App.vOfEp.get(x.ep)).filter(Boolean),
        ]);
        g.setHighlight({ nodes: new Map(ds.map((d) => [d, MARK.find])), edges: new Map() }); focus = ds; break;
      }
      case 'vlan': {
        const v = Q.vlan(sel.key); const em = new Map();
        pairsOf(v.carry.concat(v.inferred).map((l) => l.key)).forEach((p) => em.set(p, MARK.good));
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
        if (e.type === 'interface' || e.type === 'service') nm.set(devOf(e.key), MARK.bad);
        if (e.type === 'rule') { const r = Q.getFirewallRule(e.key); if (r) nm.set(r.dev, MARK.bad); }
        if (e.type === 'link') { const l = Q.getLink(e.key); if (l) { em.set(App.pairOfLink.get(l.key), MARK.bad); nm.set(devOf(l.a), MARK.bad); nm.set(devOf(l.b), MARK.bad); } }
      });
      if (nm.size || em.size) { g.setHighlight({ nodes: nm, edges: em }); focus = Array.from(nm.keys()); }
    }
    // 要聚焦的主機被隱藏時，自動顯示主機
    if (!App.showHosts && focus.some((k) => { const d = Q.getDevice(k); return d && d.kind === 'host'; })) { App.showHosts = true; A.applyVisibility(); }
    if (!App.showUnknown && focus.some((k) => String(k).startsWith('?'))) { App.showUnknown = true; A.applyVisibility(); }
    g.setSelection(nodes, edges);
    if (o.focus && focus.length) g.focus(focus);
    V.details.render(App, sel);
    if (sel && A.isNarrowScreen()) A.setWorkspace('details');
  };

  App.selectFinding = function (idx) {
    const f = App.snap.findings[idx];
    // 指向防火牆規則或服務的檢查結果，定位到該設備防火牆畫面的那一列（第一個實體通常是設備）
    const e = f.entities.find((x) => x.type === 'rule' || x.type === 'service') || f.entities[0];
    const sel = !e ? null : f.id === 'A03' ? { type: 'endpoints', dev: e.key } : { type: e.type, key: e.key };
    App.select(sel, { focus: true, findingEntities: f.id === 'A03' ? null : f.entities });
  };

  // ================================================================ 圖上互動
  const selOfVirtual = (vid) => {
    const v = App.virtual.get(vid); if (!v) return null;
    if (v.type === 'endpoints') return { type: 'endpoints', dev: v.dev };
    if (v.type === 'behind') return { type: 'device', key: v.dev };
    if (v.type === 'mac') return { type: 'mac', key: v.mac };
    return { type: 'interface', key: v.ep };
  };
  A.onGraphClick = function onGraphClick(it) {
    if (!it) return App.select(null);
    if (it.type === 'node') return App.select(String(it.id).startsWith('?') ? selOfVirtual(it.id) : { type: 'device', key: it.id });
    const p = App.pairs.get(it.id); if (!p) return;
    if (p.virtual) return App.select(selOfVirtual(p.b));
    if (p.links.length === 1 && !p.inferred.length) App.select({ type: 'link', key: p.links[0] });
    else App.select({ type: 'pair', id: p.id, links: p.links, devs: [p.a, p.b] });
  };
  A.onGraphDblClick = function onGraphDblClick(it) {
    const v = App.virtual.get(it.id);
    if (v && (v.type === 'endpoints' || v.type === 'behind')) return App.toggleExpand(v.dev);         // 群組：展開
    if (v) return App.select(selOfVirtual(it.id), { focus: true });
    App.select({ type: 'device', key: it.id }, { focus: true });
  };
  A.onHover = function onHover(ev) {
    const tip = $('#tooltip');
    if (!ev.item) { tip.classList.add('hidden'); return; }
    let text = '';
    if (ev.item.type === 'node') {
      const vn = App.graph.nodeById.get(ev.item.id);
      if (vn && vn.virtual) text = vn.tip; else { const d = App.Q.getDevice(ev.item.id); text = `${d.label || d.name}・${V.KIND[d.kind]}${d.collected ? '' : '・未收集'}`; }
    } else {
      const p = App.pairs.get(ev.item.id);
      const ends = () => `${App.Q.devName(p.a)} ${p.labelA} ⇄ ${App.Q.devName(p.b)} ${p.labelB}`;
      if (p.virtual) text = App.graph.nodeById.get(p.b).tip;
      else if (p.evidence === 'inferred') {
        const bases = S.util.uniq(App.Q.inferredLinksBetween(p.a, p.b).flatMap((l) => l.bases)).map((x) => V.INFER_BASIS[x]);
        text = `${ends()}・推論鏈路：沒有 LLDP，依 ${bases.join('、')} 推定相鄰`;
      } else text = `${ends()}${p.hasDomain ? '・另有 MNDP L2 廣播網域可達證據' : ''}`;
    }
    tip.textContent = text; tip.classList.remove('hidden');
    tip.style.left = (ev.x + 14) + 'px'; tip.style.top = (ev.y + 12) + 'px';
  };

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
  A.runTrace = function runTrace() {
    if (!App.Q) return;
    const src = $('#trace-src').value.trim(); const dst = $('#trace-dst').value.trim();
    const r = S.trace(App.Q, src, dst);
    // 回程：無狀態的 ACL 需要確認反向路徑；起點找不到時一樣明確顯示原因
    const reverse = r.ok ? S.trace(App.Q, dst, src) : null;
    $('#trace-pop').classList.add('hidden');
    App.select({ type: 'trace', result: r, reverse }, { focus: true });
  };
})(globalThis.SSOT = globalThis.SSOT || {});
