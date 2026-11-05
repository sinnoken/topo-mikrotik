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
  /**
   * 選取：圖上的標示依目前的層級（設備圖在這裡，L2／L3 在 app-layers.js 的 A.layerMarks），詳情在右側。
   * opt.focus：圖移到選取的位置；opt.findingEntities：標出檢查結果的實體；
   * opt.refresh：只在圖上重新標示（切換層級、取消 VLAN 篩選時），不重繪詳情、不切換工作區，也保留與多數不同的標示；
   * opt.emphasis：與多數不同的設備鍵（檢查結果的 deviation，推論），以虛線外圈另外標出；其他選取與清除時清掉
   * opt.pinFilter：工具列的 VLAN 選單選的，VLAN 篩選保留到取消
   * 選了 VLAN 時同時設為 VLAN 篩選（App.vlanFilter）：之後選其他東西，沒有自己的標示時仍標出這個 VLAN。
   * 只有在工具列的 VLAN 選單選的（pinned）會保留到取消；由檢查結果、搜尋或詳情的連結選 VLAN 順帶設的篩選不是使用者主動要的，
   * 選其他東西時一起取消（否則之後選的設備看起來像帶著自己的 VLAN 標示）。
   */
  App.select = function (sel, opt) {
    App.sel = sel; const o = opt || {}; const g = App.graph; const Q = App.Q;
    g.setOverlay([]); g.setHighlight(null);
    if (!o.refresh) g.setEmphasis(o.emphasis || null);
    // 清單上「已選取」的檢查結果：改選其他東西時拿掉（App.selectFinding 在這之後由 findings.reveal 重新標出）
    if (!o.refresh) V.lists.findings.unmark();
    // 基準中沒有的 VLAN（例如搜尋到「基準中沒有這個 VLAN」）只開詳情，不設成篩選：選單沒有這個選項，圖上也沒有可標的
    if (sel && sel.type === 'vlan' && Q && Q.vlanIds().includes(+sel.key)) {
      const id = +sel.key; const prev = App.vlanFilter;
      // 由 VLAN 選單來的（opt.pinFilter）保留；其他來源選同一個 VLAN 時沿用原本的保留狀態
      const pinned = !!o.pinFilter || (!!prev && prev.id === id && prev.pinned);
      App.vlanFilter = { id, domain: sel.domain == null ? null : sel.domain, pinned };
      if (!o.refresh) A.syncLayerUi();
    } else if (!o.refresh && App.vlanFilter && !App.vlanFilter.pinned) { App.vlanFilter = null; A.syncLayerUi(); }
    const filterMarks = () => (App.vlanFilter && Q ? A.vlanMarks(App.vlanFilter.id, App.vlanFilter.domain) : null);
    if (!sel) { g.setSelection([], []); g.setHighlight(filterMarks()); if (!o.refresh) { A.closeSheet(); V.details.render(App, null); } return; }
    if (!o.refresh) {
      A.closeHub(); // 選取要在圖與詳細資料上看到結果（例如從搜尋或摘要進來）
      // L2 只畫一台設備與鄰居時，選了不在圖上的設備就改看那一台
      const d = sel.type === 'device' ? sel.key : sel.type === 'interface' ? K.splitEp(sel.key)[0] : null;
      A.recenterL2(d);
    }
    // 步驟與中間的工作畫面（④ 修正計畫、⑤ 驗證）不切換：詳情在右側顯示，圖的選取也更新，回到拓樸圖時就看得到
    const r = App.layer === 'device' ? deviceMarks(sel, o) : A.layerMarks(sel, o);
    if (r.overlay.length) g.setOverlay(r.overlay);
    g.setHighlight(r.hl || filterMarks());
    const focus = r.focus;
    // 要聚焦的主機被隱藏時，自動顯示主機
    if (!App.showHosts && focus.some((k) => { const d = Q.getDevice(k); return d && d.kind === 'host'; })) { App.showHosts = true; A.applyVisibility(); }
    if (!App.showUnknown && focus.some((k) => String(k).startsWith('?'))) { App.showUnknown = true; A.applyVisibility(); }
    g.setSelection(r.nodes, r.edges);
    // 窄螢幕：在拓樸圖選取時開底部抽屜（先開，聚焦與 reveal 才會讓開它）；中間是修正計畫或驗證、或已在「詳細資料」時切到詳細資料
    const sheet = !o.refresh && A.openSheetFor();
    if (o.focus && focus.length) g.focus(focus, { neighbors: !!r.neighbors });
    else if (sheet) g.reveal(focus);
    if (o.refresh) return;
    V.details.render(App, sel);
    if (!sheet && A.isNarrowScreen()) A.setWorkspace('details');
  };
  /** 設備圖上的標示：回傳 { nodes, edges, focus, hl, overlay } */
  function deviceMarks(sel, o) {
    const g = App.graph; const Q = App.Q;
    // neighbors：聚焦時一併納入一跳鄰居（只選一台設備時，看得出它接在哪裡）
    let nodes = []; let edges = []; let focus = []; let hl = null; let overlay = []; let neighbors = false;
    const setHl = (x) => { hl = x; };
    const pairsOf = (linkKeys) => S.util.uniq(linkKeys.map((k) => App.pairOfLink.get(k)).filter(Boolean));
    const devOf = (ep) => K.splitEp(ep)[0];
    switch (sel.type) {
      case 'device': nodes = [sel.key]; focus = [sel.key]; neighbors = true; break;
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
        setHl({ nodes: new Map(S.util.uniq(ds).map((d) => [d, MARK.find])), edges: em }); focus = S.util.uniq(ds); break;
      }
      case 'ip': {
        // sel.vrf：null／undefined 是不分 VRF（搜尋），列出所有 VRF 的擁有者
        const r = Q.findIp(sel.key, sel.vrf == null ? undefined : sel.vrf);
        const ds = S.util.uniq([
          ...r.owners.map((x) => devOf(x.ep)),
          ...r.locations.map((x) => devOf(x.ep)),
          ...r.locations.map((x) => App.vOfEp.get(x.ep)).filter(Boolean),
        ]);
        setHl({ nodes: new Map(ds.map((d) => [d, MARK.find])), edges: new Map() }); focus = ds; break;
      }
      // VLAN：每條鏈路的承載狀態由 Q.vlanCarriers 決定（線型與外形見 theme.vlan），A.vlanMarks 與 L2 埠圖共用
      case 'vlan': { const m = A.vlanMarks(sel.key, sel.domain); setHl(m); focus = Array.from(m.nodes.keys()); break; }
      // 子網（從 L3 子網圖或詳情來）：標出接在這個子網的設備
      case 'subnet': {
        const s = Q.subnetGraph().subnets.find((x) => x.id === sel.key);
        if (s) { setHl({ nodes: new Map(s.devices.filter((d) => g.nodeById.has(d)).map((d) => [d, MARK.find])), edges: new Map() }); focus = s.devices; }
        break;
      }
      case 'trace': {
        const t = sel.result; if (t.ok) {
          overlay = t.edges.map(([a, b]) => ({ a, b, color: MARK.trace }));
          const ds = S.util.uniq([t.start, ...t.hops.map((x) => x.dev), ...t.ends.map((e) => e.dev)]);
          // 設備的顏色依它的終點分類（V.traceEndKind，與詳情的結果列同一來源）：停在未收集設備只是無法驗證，用灰色而不是錯誤色
          setHl({ nodes: new Map(ds.map((d) => [d, MARK[V.TRACE_END_STYLE[V.traceEndWorst(t.ends.filter((e) => e.dev === d))].mark]])), edges: new Map() });
          // 聚焦整條路徑：去程的每一跳與疊加線段兩端，加上回程的起點與經過的設備（來回兩端都在畫面內）
          const rv = sel.reverse && sel.reverse.ok ? sel.reverse : null;
          const back = rv ? [rv.start, ...rv.hops.map((x) => x.dev), ...rv.ends.map((e) => e.dev)] : [];
          focus = S.util.uniq(ds.concat(t.edges.flat(), back)).filter((d) => g.nodeById.has(d));
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
      if (nm.size || em.size) { setHl({ nodes: nm, edges: em }); focus = Array.from(nm.keys()); neighbors = nm.size === 1; }
    }
    return { nodes, edges, focus, hl, overlay, neighbors };
  }

  /** 取消 VLAN 篩選（工具列的標示 ✕、VLAN 選單的「不篩選」）：選取的是 VLAN 時一起取消，否則保留選取、只拿掉標示 */
  A.clearVlanFilter = function clearVlanFilter() {
    App.vlanFilter = null;
    if (App.sel && App.sel.type === 'vlan') App.select(null); else App.select(App.sel, { refresh: true });
    A.syncLayerUi();
  };
  App.selectFinding = function (idx) {
    const f = App.Q.finding(idx);
    // 指向防火牆規則或服務的檢查結果，定位到該設備防火牆畫面的那一列（第一個實體通常是設備）
    const e = f.entities.find((x) => x.type === 'rule' || x.type === 'service') || f.entities[0];
    const sel = !e ? null : f.id === 'A03' ? { type: 'endpoints', dev: e.key } : e.type === 'ip' ? V.ipSel(e.key) : { type: e.type, key: e.key };
    // 多數決判定與多數不同的設備（推論）另以虛線外圈標出；平手（basis 不是 majority）或 deviating 為空時不標
    const emphasis = V.majorityDeviating(f.deviation);
    App.select(sel, { focus: true, findingEntities: f.id === 'A03' ? null : f.entities, emphasis });
    // 不論從哪個入口選取，③ 的檢查結果清單都展開到這一筆並標出選取
    V.lists.findings.reveal(App, idx);
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
    if (App.layer !== 'device') return A.layerClick(it);
    if (it.type === 'node') return App.select(String(it.id).startsWith('?') ? selOfVirtual(it.id) : { type: 'device', key: it.id });
    const p = App.pairs.get(it.id); if (!p) return;
    if (p.virtual) return App.select(selOfVirtual(p.b));
    if (p.links.length === 1 && !p.inferred.length) App.select({ type: 'link', key: p.links[0] });
    else App.select({ type: 'pair', id: p.id, links: p.links, devs: [p.a, p.b] });
  };
  A.onGraphDblClick = function onGraphDblClick(it) {
    if (App.layer !== 'device') return A.layerDblClick(it);
    const v = App.virtual.get(it.id);
    if (v && (v.type === 'endpoints' || v.type === 'behind')) return App.toggleExpand(v.dev);         // 群組：展開
    if (v) return App.select(selOfVirtual(it.id), { focus: true });
    App.select({ type: 'device', key: it.id }, { focus: true });
  };
  A.onHover = function onHover(ev) {
    const tip = $('#tooltip');
    if (!ev.item) { tip.classList.add('hidden'); return; }
    let text = '';
    if (App.layer !== 'device') text = A.layerTip(ev.item);
    else if (ev.item.type === 'node') {
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
      // VLAN 篩選中：這條線的承載狀態與原因（推論的原因以中文說明）
      const vt = !p.virtual && A.vlanTip(p.links.concat(p.inferred));
      if (vt) text += '・' + vt;
    }
    tip.textContent = text; tip.classList.remove('hidden');
    tip.style.left = (ev.x + 14) + 'px'; tip.style.top = (ev.y + 12) + 'px';
    // 鍵盤移到的設備也讀給螢幕閱讀器（aria-live）
    if (ev.keyboard) $('#graph-live').textContent = text + '。按 Enter 開啟詳細資料';
  };

  // ================================================================ 原文檢視
  // 標題寫出該行所屬的設備與指令（Q.blockAt、V.blockWhere）；opt.list 給多處證據（[{ file, line }]）時，
  // 可用「上一處／下一處」或左右方向鍵切換（頭尾相接）
  // 顯示的範圍：標出的那一行往上 RAW_BEFORE、往下 RAW_AFTER 行；「顯示前面／後面」每次多 RAW_MORE 行（切換到另一處時回到預設）
  const RAW_BEFORE = 12; const RAW_AFTER = 25; const RAW_MORE = 100;
  let rawNav = { list: [], at: 0, before: RAW_BEFORE, after: RAW_AFTER, copy: null };
  App.openRaw = function (file, line, opt) {
    const list = opt && opt.list && opt.list.length ? opt.list : [{ file, line }];
    rawNav = { list, at: Math.max(0, list.findIndex((e) => e.file === file && e.line === line)), before: RAW_BEFORE, after: RAW_AFTER, copy: null };
    bindRawNav(); showRaw();
    $('#dlg-raw').showModal();
    scrollRawHl();
  };
  const scrollRawHl = () => { const hl = $('#raw-body').querySelector('.hl'); if (hl) hl.scrollIntoView({ block: 'center' }); };
  function bindRawNav() {
    const dlg = $('#dlg-raw'); if (dlg.dataset.nav) return; dlg.setAttribute('data-nav', '1');
    $('#raw-prev').addEventListener('click', () => stepRaw(-1)); $('#raw-next').addEventListener('click', () => stepRaw(1));
    // 複製的結果寫在對話框的狀態列（同輸入對話框）：banner 在強制回應對話框底下，窄螢幕完全被蓋住
    $('#raw-copy').addEventListener('click', async () => {
      const c = rawNav.copy; const why = await V.copyText(c.text);
      if (rawNav.copy !== c) return; // 複製期間換到另一段或重新開啟：結果屬於舊的那一段，不寫到新的狀態列
      $('#raw-copy-status').textContent = why ? `無法自動複製（${why}），請直接選取下面的文字複製` : `已複製 ${c.lines} 行`;
    });
    dlg.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || rawNav.list.length < 2) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepRaw(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); stepRaw(1); }
    });
  }
  function stepRaw(d) {
    const n = rawNav.list.length; if (n < 2) return;
    Object.assign(rawNav, { at: (rawNav.at + d + n) % n, before: RAW_BEFORE, after: RAW_AFTER }); showRaw(); scrollRawHl();
  }
  function showRaw() {
    const { file, line } = rawNav.list[rawNav.at]; const n = rawNav.list.length;
    const src = App.sources.find((s) => s.name === file);
    const body = V.clear($('#raw-body'));
    // 區塊之間的標記行（例如設備或指令的分隔行）不屬於任何區塊：它標示的是下一個區塊，標題用下一行所屬的區塊
    const blk = App.Q ? App.Q.blockAt(file, line) || App.Q.blockAt(file, line + 1) : null;
    const title = $('#raw-title'); const at = `${V.fileName(file)} 第 ${line} 行`;
    title.textContent = blk ? `${V.blockWhere(App.Q, blk)}（第 ${line} 行）` : at; title.setAttribute('title', at);
    $('#raw-nav').classList.toggle('hidden', n < 2);
    $('#raw-pos').textContent = `${rawNav.at + 1}／${n}`;
    $('#raw-copy').classList.toggle('hidden', !src); $('#raw-copy-status').textContent = '';
    if (!src) { body.appendChild(h('p', { class: 'muted' }, '找不到原始輸入（可能是從舊版本還原的基準）。')); return; }
    const lines = src.text.split(/\r?\n/); const from = Math.max(1, line - rawNav.before); const to = Math.min(lines.length, line + rawNav.after);
    // 「複製這段」：有所屬區塊時複製整個區塊（一個指令的輸出），否則複製畫面上顯示的這幾行
    const [cf, ct] = blk ? [blk.start, Math.min(blk.end, lines.length)] : [from, to];
    rawNav.copy = { text: lines.slice(cf - 1, ct).join('\n'), lines: ct - cf + 1 };
    $('#raw-copy').setAttribute('title', `複製${blk ? V.blockWhere(App.Q, blk) : V.fileName(file)} 第 ${cf}–${ct} 行的原文`);
    // 按下後重畫：焦點回到同一側的按鈕（已經全部顯示時落在對話框的標題列）
    const more = (side, count) => h('button', { type: 'button', class: 'ghost raw-more', 'data-side': side, onclick: () => {
      rawNav[side] += RAW_MORE; showRaw();
      const next = Array.from($('#raw-body').querySelectorAll('.raw-more')).find((x) => x.dataset.side === side); (next || $('#raw-copy')).focus();
    } }, `${side === 'before' ? '顯示前面' : '顯示後面'} ${Math.min(RAW_MORE, count)} 行` + (count > RAW_MORE ? `（還有 ${count} 行）` : ''));
    if (from > 1) body.appendChild(more('before', from - 1));
    const pre = h('pre', { class: 'raw' });
    for (let i = from; i <= to; i++) pre.appendChild(h('span', { class: i === line ? 'hl' : null }, [h('span', { class: 'ln' }, String(i)), lines[i - 1] + '\n']));
    body.appendChild(pre);
    if (to < lines.length) body.appendChild(more('after', lines.length - to));
  }

  // ================================================================ 路由追蹤
  /**
   * VRF 選單：基準只有 main 時不顯示（畫面與加入 VRF 之前相同）；否則列出 Q.vrfs()，預設「依來源位址決定」。
   * 提示（#trace-msg）只在來源位址在多個 VRF、需要選擇時顯示。
   */
  A.syncTraceVrf = function syncTraceVrf(value) {
    const vrfs = App.Q ? App.Q.vrfs() : [];
    $('#trace-vrf-row').classList.toggle('hidden', vrfs.length < 2);
    V.fillVrfSelect($('#trace-vrf'), vrfs, value === undefined ? $('#trace-vrf').value : value);
  };
  const traceMsg = (text) => { const m = $('#trace-msg'); m.textContent = text || ''; m.classList.toggle('hidden', !text); };
  /** 開啟路由追蹤。vrf：預先選好的 VRF（例如從某個 VRF 的 IP 詳情來）；省略時保留選單目前的值 */
  App.openTrace = function (src, dst, vrf) {
    A.closeHub(); A.closeMenus();
    const pop = $('#trace-pop'); pop.classList.remove('hidden');
    if (src !== undefined) $('#trace-src').value = src; if (dst !== undefined) $('#trace-dst').value = dst;
    A.syncTraceVrf(vrf === undefined ? undefined : vrf || ''); traceMsg('');
    ($('#trace-src').value ? $('#trace-dst') : $('#trace-src')).focus();
  };
  A.runTrace = function runTrace() {
    if (!App.Q) return;
    const src = $('#trace-src').value.trim(); const dst = $('#trace-dst').value.trim();
    A.syncTraceVrf();
    const vrf = $('#trace-vrf').value || undefined; // 空字串：依來源位址決定
    const r = S.trace(App.Q, src, dst, vrf ? { vrf } : undefined);
    // 來源位址在多個 VRF（位址重疊）：查詢層不猜，請使用者選擇；彈出視窗留著，焦點移到 VRF 選單
    if (!r.ok && r.vrfs) {
      $('#trace-pop').classList.remove('hidden'); $('#trace-vrf-row').classList.remove('hidden');
      traceMsg(`來源 ${src} 在多個 VRF（${r.vrfs.join('、')}，位址重疊），無法判斷從哪一個開始：請在 VRF 選單選擇其中一個，再按「追蹤」。`);
      $('#trace-vrf').focus();
      return;
    }
    traceMsg('');
    // 回程：無狀態的 ACL 需要確認反向路徑；起點找不到時一樣明確顯示原因。
    // 回程的 VRF：去程抵達的 VRF 只有一個時用它，否則用使用者選的（都沒有時依位址決定，位址在多個 VRF 時回程顯示原因）
    const reached = r.ok ? S.util.uniq(r.ends.filter((e) => e.status === 'reached').map((e) => e.vrf)) : [];
    const backVrf = reached.length === 1 ? reached[0] : vrf;
    const reverse = r.ok ? S.trace(App.Q, dst, src, backVrf ? { vrf: backVrf } : undefined) : null;
    A.closeTrace(false);
    App.showView('graph'); // 路由追蹤的路徑畫在拓樸圖上：工作畫面開著時切回拓樸圖
    App.select({ type: 'trace', result: r, reverse, vrf: vrf || null }, { focus: true });
  };
})(globalThis.SSOT = globalThis.SSOT || {});
