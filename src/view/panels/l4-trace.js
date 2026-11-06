/*
 * L4 可達性：明細（#l4-drill）——一格的位址組（L1）與牽涉的規則（L2，Q.zoneCell），以及可達性查詢與逐跳路徑（L3，Q.reach）。
 * 共用的狀態與函式在 l4.js（V.l4._）；暴露清單的看路徑（l4-exposure.js）也用這裡的 runQuery／reachBlock。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const I = V.l4._;
  const { st, els, TH, ROW_LIMIT, PROTOS, reasonNote, layerList, layerLine, deniedParts, svcOf, optsOf, zoneName, statusText, statusMark, statusTag, cellBg, countsText, hetBadge, ruleLink, isOpen, announce } = I;
  const P = () => V.details.parts;
  const devLink = (App, d) => h('a', { class: 'link', onclick: () => App.select({ type: 'device', key: d }) }, App.Q.devLabel(d));
  const epText = (Q, ep) => (ep ? Q.epName(ep) : '不明');
  const reasonItem = (App, r) => h('li', { class: 'l4-reason', 'data-code': r.code, title: reasonNote(r.code) }, [
    h('b', null, V.reachReason(r.code)), r.message ? '：' + r.message : '',
    r.rule ? h('span', null, ['（', ruleLink(App, r.rule), '）']) : null,
  ]);

  // ---------------------------------------------------------------- 下鑽
  /** L0 → L1／L2：一格的位址組與牽涉的規則（Q.zoneCell）；焦點移到下鑽的標題 */
  function openCell(App, src, dst) {
    I.hideTip();
    st.cell = { src, dst }; st.reach = null; st.reachReq = null; st.reachErr = null; st.reachVrfs = null; st.showAllGroups = false; st.hideDeny = true;
    st.cellData = App.Q.zoneCell(src, dst, optsOf(st.service));
    renderDrill(App);
    announce(`已開啟 ${zoneName(App.Q, src)} → ${zoneName(App.Q, dst)} 的明細：${V.L4_STATUS[st.cellData.status]}`);
    focusDrill();
  }
  /** L1 → L3：某一組（來源代表 → 目的）在某個服務的逐跳路徑 */
  function openGroup(App, gi, svcId) {
    const c = st.cellData; const g = c && c.groups[gi]; if (!g) return;
    const s = svcOf(svcId || g.services[0].service);
    // 查第一個來源代表（g.srcs 的結果相同），用矩陣算它時的同一組條件：
    //   entry：外部來源不在任何網段，矩陣從 WAN 介面進入（srcs[].entry）；不帶時逐跳會變成「找不到包含來源的網段」。有 entry 時 VRF 由入介面決定
    //   vrf：代表位址的 VRF（zone 依 VRF 分開）：重疊的位址在多個 VRF，一定要帶上
    const rep = g.srcs[0];
    query(App, { src: rep.ip, dst: g.dst.ip, proto: s.proto, port: s.port, vrf: rep.entry ? null : rep.vrf || null, entry: rep.entry || null, srcCount: g.srcs.length, from: 'cell', group: gi, service: svcId || g.services[0].service });
  }
  /**
   * 可達性查詢（表單）：結果用同一個 L3 畫面；表單的查詢不屬於任何格子，關掉 L1／L2。
   * vrf：來源的 VRF（選用；空字串或省略是依來源位址決定，位址在多個 VRF 時提示選擇）
   */
  function runReach(App, src, dst, proto, port, vrf) {
    const p = PROTOS.includes(proto) ? proto : String(proto || 'tcp');
    const pt = p === 'icmp' || port === '' || port == null ? (p === 'icmp' ? null : undefined) : /^\d+$/.test(String(port)) ? Number(port) : port;
    st.cell = null; st.cellData = null;
    els.src.value = src; els.dst.value = dst; els.proto.value = p; els.port.value = pt == null ? '' : String(pt); els.port.disabled = p === 'icmp';
    if (vrf !== undefined) els.vrf.value = vrf || '';
    query(App, { src, dst, proto: p, port: pt, vrf: vrf || null, from: 'form' });
  }
  /** 一次 Q.reach：{ req, reach, err, vrfs }（明細與暴露清單的就地路徑共用） */
  function runQuery(App, req) {
    const out = { req, reach: null, err: null, vrfs: null };
    try {
      const r = App.Q.reach(req.src, req.dst, Object.assign({ proto: req.proto, port: req.port }, req.vrf ? { vrf: req.vrf } : {}, req.entry ? { entry: req.entry } : {}));
      if (r.ok) out.reach = r; else { out.err = r.error; out.vrfs = r.vrfs || null; } // vrfs：來源在多個 VRF，請使用者選擇
    } catch (e) { out.err = V.reason(e); } // 參數不合法（例如 tcp 沒有埠、不存在的 VRF）：核心丟中文的 TypeError，V.reason 原樣顯示
    return out;
  }
  function query(App, req) {
    const o = runQuery(App, req);
    st.reachReq = req; st.reach = o.reach; st.reachErr = o.err; st.reachVrfs = o.vrfs;
    renderDrill(App);
    announce(st.reach ? `逐跳路徑：${req.src} → ${req.dst} ${svcLabel(req)} ${V.L4_STATUS[st.reach.verdict]}` : st.reachVrfs ? `逐跳路徑：來源 ${req.src} 在多個 VRF，請選擇 VRF` : `逐跳路徑：查詢失敗，${st.reachErr}`);
    focusDrill(st.cell ? 'l3' : null);
  }
  /** 來源在多個 VRF 時，用選的 VRF 重新查詢（同一個請求，只換 VRF） */
  function rerunWithVrf(App, vrf) {
    const q = st.reachReq; if (!q) return;
    if (q.from === 'form') runReach(App, q.src, q.dst, q.proto, q.port == null ? '' : String(q.port), vrf);
    else query(App, Object.assign({}, q, { vrf }));
  }
  const svcLabel = (q) => q.proto + (q.port != null ? '/' + q.port : '');
  function focusDrill(part) {
    const t = part === 'l3' ? $('#l4-l3-title') : $('#l4-drill-title');
    if (t) { t.focus(); if (t.scrollIntoView) t.scrollIntoView({ block: 'start' }); }
  }

  function renderDrill(App) {
    const box = V.clear(els.drill);
    const has = !!(st.cellData || st.reach || st.reachErr);
    box.classList.toggle('hidden', !has);
    if (!has) return;
    const where = st.cellData ? els.matrixCard : els.reachCard;
    if (box.parentNode !== where) where.appendChild(box);
    const Q = App.Q;
    if (st.cellData) {
      const c = st.cellData;
      box.appendChild(h('h3', { id: 'l4-drill-title', class: 'work-card-title', tabindex: '-1' }, `明細：${zoneName(Q, c.src)} → ${zoneName(Q, c.dst)}`));
      // 第一句是結論（IP:埠）；次數（代表位址 × 目的 × 服務）只放在狀態的 title 與「這一格怎麼算的」（評審 M5）
      box.appendChild(h('p', { class: 'l4-cell-sentence' }, cellSentence(c)));
      const tag = statusTag(c.status, statusText(c)); tag.setAttribute('title', `${countsText(c.counts)}，共 ${V.num(c.counts.total)} 組（位址 × 服務）`);
      box.appendChild(h('div', { class: 'row' }, [tag, c.heterogeneous ? hetBadge() : null, c.diagonal ? V.chip('zone 內') : null,
        st.service ? V.chip('服務 ' + st.service) : V.chip('全部服務'),
        h('button', { type: 'button', class: 'ghost l4-close', onclick: () => closeDrill(App) }, '關閉明細')]));
      if (c.reasons.length) box.appendChild(h('div', { class: 'l4-reasons' }, [h('b', null, '無法判斷的原因：'),
        layerList(c.reasons, (x) => x.code, (x) => h('li', { class: 'l4-reason', 'data-code': x.code, title: reasonNote(x.code) }, `${V.reachReason(x.code)}（${V.num(x.count)} 組）`))]));
      box.appendChild(groupsBlock(App, c));
      box.appendChild(rulesBlock(App, c));
    } else {
      box.appendChild(h('h3', { id: 'l4-drill-title', class: 'work-card-title', tabindex: '-1' }, '可達性查詢的結果'));
      box.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost l4-close', onclick: () => closeDrill(App) }, '關閉')));
    }
    if (st.reach || st.reachErr) box.appendChild(reachBlock(App));
  }
  function closeDrill(App) {
    const req = st.reachReq;
    st.cell = null; st.cellData = null; st.reach = null; st.reachReq = null; st.reachErr = null; st.reachVrfs = null; renderDrill(App);
    // 焦點回到觸發的地方：可達性查詢的按鈕、矩陣的格子（矩陣收合時是它的標題）；暴露清單的看路徑在列的下方展開，不用這個明細
    if (req && req.from === 'form') { const b = $('#l4-run'); if (b) { b.focus(); return; } }
    const td = isOpen(els.matrixFold) && I.focusedCell();
    if (td) td.focus(); else { const t = $('#l4-matrix-title'); if (t) t.focus(); }
  }
  /** 重畫下鑽後把焦點放回同一個切換按鈕（按鈕是重新建立的） */
  const rerenderKeep = (App, sel) => { renderDrill(App); const b = els.drill.querySelector(sel); if (b) b.focus(); };
  /** 一組的某個服務寫成「tcp 目的:埠 → NAT 之後:埠」（用 IP:埠說話，評審 M5） */
  function svcAddr(g, s) {
    const p = svcOf(s.service); const port = p.port != null ? ':' + p.port : '';
    const nat = s.final && (s.final.dst !== g.dst.ip || s.final.port !== p.port) ? ` → ${s.final.dst}${s.final.port != null ? ':' + s.final.port : ''}` : '';
    return `${p.proto} ${g.dst.ip}${port}${nat}`;
  }
  /** 明細的第一句結論：允許的服務（IP:埠，最多列 3 個）、無法判斷的數目、其餘拒絕的組合數；筆數的單位在 title */
  function cellSentence(c) {
    // 同一個最後的目的（dst-nat 之後的 IP:埠）算一個服務：多個入口位址轉到同一台主機時寫「等 N 個位址」
    const uniq = (v) => {
      const m = new Map();
      c.groups.forEach((g) => g.services.filter((s) => s.verdict === v).forEach((s) => {
        const p = svcOf(s.service); const fin = s.final ? `${s.final.dst}:${s.final.port}` : `${g.dst.ip}:${p.port}`;
        const k = p.proto + ' ' + fin; const e = m.get(k);
        if (e) { if (!e.ips.includes(g.dst.ip)) e.ips.push(g.dst.ip); e.nat = e.nat || g.dst.via === 'nat'; } else m.set(k, { text: svcAddr(g, s), ips: [g.dst.ip], nat: g.dst.via === 'nat' });
      }));
      return Array.from(m.values()).map((e) => { const tail = [e.ips.length > 1 ? `${V.num(e.ips.length)} 個入口位址` : '', e.nat ? '經 dst-nat' : ''].filter(Boolean).join('，');
        return e.text + (tail ? `（${tail}）` : ''); });
    };
    const al = uniq('allow'); const un = uniq('unknown');
    if (!c.groups.length) return '這一格沒有可算的位址組合。';
    return (al.length ? `${V.num(al.length)} 個服務允許：${al.slice(0, 3).join('、')}${al.length > 3 ? ' 等' : ''}。` : '沒有允許的服務。')
      + (un.length ? `${V.num(un.length)} 個無法判斷。` : '')
      + (c.counts.deny ? `其餘 ${V.num(c.counts.deny)} 個組合拒絕${deniedParts(c.deniedBy) ? `（${deniedParts(c.deniedBy)}）` : ''}。` : '');
  }
  /**
   * L1：目的 × 結果相同的來源代表（Q.zoneCell 的 groups）。先列允許與無法判斷（評審 H5）：
   * 全部拒絕的組一律預設收起（不論格子是否結果不一），其他組裡拒絕的服務收成「其餘 N 個服務拒絕」；「顯示拒絕的組合」一次全部列出。
   * 結果不一的格子：造成差異的服務（divergentServices）另標「≠ 差異」文字；等價類與「造成差異」的定義收在「這一格怎麼算的」。
   */
  function groupsBlock(App, c) {
    const Q = App.Q; const all = c.groups.map((g, i) => ({ g, i }));
    const divN = all.filter((x) => x.g.divergent).length;
    const het = c.heterogeneous && divN > 0;
    const denyGroups = all.filter((x) => x.g.status === 'deny').length;
    const denySvcs = all.reduce((n, x) => n + (x.g.status === 'deny' ? 0 : x.g.services.filter((s) => s.verdict === 'deny').length), 0);
    const hide = st.hideDeny;
    const rows = hide ? all.filter((x) => x.g.status !== 'deny') : all;
    const toggle = denyGroups || denySvcs ? h('button', { type: 'button', class: 'ghost l4-hide-deny', 'aria-pressed': String(hide), onclick: () => { st.hideDeny = !st.hideDeny; rerenderKeep(App, '.l4-hide-deny'); } },
      hide ? `顯示拒絕的組合（${[denyGroups ? `${V.num(denyGroups)} 組全部拒絕` : '', denySvcs ? `其他組的 ${V.num(denySvcs)} 個服務` : ''].filter(Boolean).join('、')}）` : '收起拒絕的組合') : null;
    const how = h('details', { class: 'l4-fold l4-how' }, [h('summary', null, '這一格怎麼算的'),
      h('p', { class: 'muted l4-note' }, '每一列是一個目的與一組結果相同的來源代表；點一列或某個服務看逐跳路徑。代表位址是等價類的代表：同一個區段內的位址對所有規則的位址條件結果相同。'
        + `格子的筆數是代表位址 × 目的 × 服務各算一次（${countsText(c.counts)}，共 ${V.num(c.counts.total)} 組）。`),
      het ? h('p', { class: 'l4-note l4-div-note' }, [hetBadge(), ' ', `這一格結果不一：${V.num(all.length)} 組中有 ${V.num(divN)} 組造成差異。`,
        '造成差異是指某個服務的結果和同一個目的的其他來源、或同一批來源往其他目的的結果不同，而且是少數（平手時兩邊都算）；那個服務的按鈕標「≠ 差異」。']) : null]);
    const divMark = () => hetBadge('≠ 差異', 'l4-div-mark');
    const srcText = (g) => (g.srcs.length === 1 ? g.srcs[0].ip : `${g.srcs[0].ip} 等 ${V.num(g.srcs.length)} 個`);
    const srcTitle = (g) => g.srcs.map((s) => `${s.ip}（${s.range ? s.range.join('–') : s.subnet || ''}；${s.basis === 'arp' ? 'ARP 看到的位址' : '推算的位址'}）`).join('\n');
    // 允許 → 無法判斷 → 拒絕（組內的服務同樣排序；拒絕的服務收起時只寫數目）
    const ORDER = { allow: 0, partial: 1, unknown: 2, empty: 3, deny: 4 };
    const sorted = rows.slice().sort((a, b) => (ORDER[a.g.status] ?? 9) - (ORDER[b.g.status] ?? 9) || a.i - b.i);
    const svcsOf = (g) => g.services.slice().sort((a, b) => (ORDER[a.verdict] ?? 9) - (ORDER[b.verdict] ?? 9)).filter((s) => !hide || s.verdict !== 'deny' || g.status === 'deny');
    return h('div', { class: 'l4-sub' }, [
      h('h4', null, ['位址組 ', V.chip(String(c.groups.length))]),
      how, toggle,
      c.groups.length && !rows.length ? h('p', { class: 'muted l4-all-deny' }, `${V.num(all.length)} 組全部拒絕，已收起。`) : null,
      c.groups.length && rows.length ? V.table([
        { t: '目的', f: ({ g }) => h('span', null, [h('span', { class: 'mono' }, g.dst.ip), ' ',
          g.dst.via === 'nat' ? V.chip(`dst-nat 入口 → ${g.dst.natTo}`, 'info', { title: `${Q.devName(g.dst.dev)} 的 dst-nat 規則把這個位址改寫到 ${g.dst.natTo}` }) : null,
          h('span', { class: 'muted' }, ` ${zoneName(Q, g.dst.zone)}`)]) },
        { t: '來源（代表）', f: ({ g }) => h('span', { class: 'mono', title: srcTitle(g) }, srcText(g)) },
        { t: '結果', f: ({ g, i }) => { const nd = hide && g.status !== 'deny' ? g.services.filter((s) => s.verdict === 'deny').length : 0;
          return h('span', { class: 'l4-svcs' }, svcsOf(g).map((s) => {
          const dv = g.divergentServices.includes(s.service);
          return h('button', {
            type: 'button', class: 'l4-svc st-' + s.verdict + (dv ? ' div' : ''), 'data-service': s.service, 'data-group': String(i), 'data-divergent': dv ? 'true' : null,
            title: dv ? `${s.service} 的結果造成這一格結果不一；看逐跳路徑` : `看 ${s.service} 的逐跳路徑`,
            style: { background: cellBg(s.verdict), color: TH().text },
            onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); openGroup(App, i, s.service); },
          }, [statusMark(s.verdict), ` ${s.service} ${V.L4_STATUS[s.verdict]}`, s.final && (s.final.dst !== g.dst.ip || s.final.port !== svcOf(s.service).port) ? ` → ${s.final.dst}${s.final.port != null ? ':' + s.final.port : ''}` : '', dv ? divMark() : null]);
        }).concat(nd ? [h('span', { class: 'muted l4-svc-denied' }, `其餘 ${V.num(nd)} 個服務拒絕`)] : [])); } },
        { t: '狀態', f: ({ g }) => statusTag(g.status, statusText(g)), s: ({ g }) => g.status },
      ].concat(het ? [{ t: '造成差異的服務', f: ({ g }) => (g.divergent ? h('span', { class: 'l4-div-svcs' }, ['≠ ', h('span', { class: 'mono' }, g.divergentServices.join('、'))]) : '—'), s: ({ g }) => g.divergentServices.length }] : [], [
        { t: '閘道／入口', f: ({ g }) => g.srcDevices.map((x) => (x.includes('|') ? Q.epName(x) : Q.devName(x))).join('、') || '—' },
      ]), sorted, { stack: true, onRow: ({ i }) => openGroup(App, i), limit: ROW_LIMIT, rowClass: ({ g }) => 'l4-group st-' + g.status + (g.divergent ? ' div' : '') }) : null,
      !c.groups.length ? h('p', { class: 'muted' }, '這一格沒有可算的位址組合。') : null,
      hide && denyGroups && rows.length ? h('p', { class: 'muted' }, `另有 ${V.num(denyGroups)} 組全部拒絕，已收起。`) : null,
    ]);
  }
  /** L2：牽涉的規則（Q.zoneCell 的 ruleDetails）：決定結果的規則、chain 結尾的預設與路由，以及條件無法判斷的規則 */
  function rulesBlock(App, c) {
    // 允許的規則在前，拒絕的在後（同一類維持查詢層的順序）
    const rank = (x) => (x.verdicts.allow ? 0 : x.verdicts.unknown || x.uncertain ? 1 : 2);
    const rows = c.ruleDetails.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map((o) => o.x);
    return h('div', { class: 'l4-sub' }, [
      h('h4', null, ['牽涉的規則 ', V.chip(String(rows.length))]),
      rows.length ? V.table([
        { t: '規則', f: (x) => ruleLink(App, x) },
        { t: V.L4_STATUS.allow, f: (x) => V.num(x.verdicts.allow), s: (x) => x.verdicts.allow, cls: 'num' },
        { t: V.L4_STATUS.deny, f: (x) => V.num(x.verdicts.deny), s: (x) => x.verdicts.deny, cls: 'num' },
        { t: V.L4_STATUS.unknown, f: (x) => V.num(x.verdicts.unknown), s: (x) => x.verdicts.unknown, cls: 'num' },
        { t: '條件無法判斷', f: (x) => (x.uncertain ? V.num(x.uncertain) : ''), s: (x) => x.uncertain, cls: 'num' },
        { t: '服務', f: (x) => h('span', { class: 'mono' }, x.services.join(' ')) },
      ], rows, { limit: ROW_LIMIT, rowClass: () => 'l4-ruledetail' }) : h('p', { class: 'muted' }, '沒有牽涉的規則。'),
    ]);
  }

  // ---------------------------------------------------------------- L3：逐跳路徑
  /** 逐跳路徑的標題：結論寫在標題（「tcp 來源 → 目的:埠 → NAT 之後:埠：允許」，評審 L4） */
  function reachTitle(Q, q, r) {
    const multi = Q.vrfs().length > 1;
    const port = q.port != null ? ':' + q.port : '';
    const nat = r && r.natApplied && r.final ? ` → ${r.final.dst}${r.final.port != null ? ':' + r.final.port : ''}` : '';
    return `逐跳路徑：${q.proto} ${q.src} → ${q.dst}${port}${nat}${multi && (r || q.vrf) ? `（${V.vrfText(r ? r.vrf : q.vrf)}）` : ''}${r ? '：' + V.L4_STATUS[r.verdict] : ''}`;
  }
  /**
   * L3：Q.reach 的結果：結論、起點、NAT 之後的目的、決定的規則、無法判斷的原因與每條路徑的逐跳。
   * x：{ q（請求）, r（Q.reach 的結果）, err, vrfs（來源在多個 VRF 時可選的 VRF）, titleId, onVrf（選了 VRF 時）}；
   * 省略時是明細（#l4-drill）目前的查詢
   */
  function reachBlock(App, x) {
    const c = x || { q: st.reachReq, r: st.reach, err: st.reachErr, vrfs: st.reachVrfs, titleId: 'l4-l3-title', onVrf: (v) => rerunWithVrf(App, v) };
    const Q = App.Q; const q = c.q; const r = c.r;
    const out = [h('h4', { id: c.titleId, tabindex: '-1' }, reachTitle(Q, q, r))];
    if (!r && c.vrfs) {
      // 來源位址在多個 VRF（位址重疊）：查詢層不猜，列出可選的 VRF，選了就重新查詢
      out.push(h('p', { class: 'warn-line l4-reach-vrf' }, `來源 ${q.src} 在多個 VRF（${c.vrfs.join('、')}，位址重疊），無法判斷封包從哪一個開始：請選擇 VRF。`));
      out.push(h('div', { class: 'row l4-reach-vrfs', role: 'group', 'aria-label': '選擇來源的 VRF' }, c.vrfs.map((v) => h('button', { type: 'button', 'data-vrf': v, onclick: () => c.onVrf(v) }, `用 ${V.vrfText(v)} 查詢`))));
      return h('div', { class: 'l4-sub l4-l3' }, out);
    }
    if (!r) { out.push(h('p', { class: 'diffA l4-reach-error' }, '無法查詢：' + c.err)); return h('div', { class: 'l4-sub l4-l3' }, out); }
    const start = r.start || {};
    out.push(h('div', { class: 'row' }, [h('span', { class: 'l4-verdict', 'data-verdict': r.verdict }, statusTag(r.verdict)),
      r.natApplied && r.final ? V.chip(`NAT 之後 ${r.final.dst}${r.final.port != null ? ':' + r.final.port : ''}`, 'info', { class: 'chip info l4-final' }) : null,
      q.from === 'cell' ? V.chip(`從 ${zoneName(Q, (st.cellData || {}).src)} → ${zoneName(Q, (st.cellData || {}).dst)} 的第 ${q.group + 1} 組`) : null,
      q.from === 'cell' && q.srcCount > 1 ? h('span', { class: 'muted l4-rep' }, `這一組有 ${V.num(q.srcCount)} 個來源代表（結果相同），這裡查第一個 ${q.src}${q.entry ? `，從 ${epText(Q, q.entry)} 進入` : ''}`) : null]));
    out.push(P().kv([
      ['起點', [V.REACH_START[start.how] || start.how, start.prefix ? `（${start.prefix}${start.basis ? '，' + (V.REACH_START_BASIS[start.basis] || start.basis) : ''}）` : '',
        start.dev ? '：' : '', start.dev ? devLink(App, start.dev) : null, start.ep ? h('span', { class: 'mono muted' }, ' ' + epText(Q, start.ep)) : null,
        !start.dev && (start.gateways || []).length ? '：' + start.gateways.map((g) => Q.devName(g.dev)).join('、') : ''].filter((x) => x !== '' && x != null)],
      ['NAT 之後的目的', r.final ? h('span', { class: 'mono' }, `${r.final.dst}${r.final.port != null ? ':' + r.final.port : ''}${r.natApplied ? '' : '（沒有改寫）'}`) : '各路徑不同'],
      ['決定結果', r.decisive.length ? h('div', null, r.decisive.map((x) => h('div', null, ruleLink(App, x)))) : '—'],
    ]));
    // 原因依層級分組（路由／防火牆／NAT／前提）
    if (r.reasons.length) out.push(h('div', { class: 'l4-reasons' }, [h('b', null, '無法判斷的原因：'), layerList(r.reasons, (x) => x.code, (x) => reasonItem(App, x))]));
    if (r.notes.length) out.push(h('div', { class: 'l4-notes' }, [h('b', null, '附註：'), layerList(r.notes, (x) => x.code, (x) => reasonItem(App, x))]));
    r.paths.forEach((p, n) => out.push(pathBlock(App, p, n, r.paths.length, r.reasons)));
    out.push(h('details', { class: 'l4-fold' }, [h('summary', null, '這次查詢的前提'), h('ul', null, r.assumptions.map((a) => h('li', null, a.message)))]));
    return h('div', { class: 'l4-sub l4-l3' }, out);
  }
  /** /routing rule（策略路由）的文字：決定查表的規則、或使路由不明／丟棄的規則 */
  const routingRuleText = (r) => `/routing rule 第 ${r.order} 條（${Object.entries(r.match || {}).map(([k, v]) => `${k}=${v}`).join(' ') || '沒有條件'}，${r.action}${r.table ? ' ' + r.table : ''}）`;
  /** 這一跳的路由：VRF（基準有多個 VRF 時）、查的路由表（不是 VRF 的表時）、決定查表的規則與閘道（在別的 VRF 解析時標 @VRF） */
  function routeText(rt, multi) {
    if (!rt) return '';
    const gw = rt.gateway ? ' 經 ' + rt.gateway + (rt.gatewayVrf && rt.gatewayVrf !== rt.vrf ? '@' + rt.gatewayVrf : '') : '';
    return `・路由 ${rt.prefix || '—'}（${rt.proto || '—'}）${gw}`
      + (rt.table && rt.table !== rt.vrf ? `・路由表 ${rt.table}` : '')
      + (multi && rt.via && rt.via.length > 1 ? `・經 VRF 介面 ${rt.via.join(' → ')}` : '')
      + (rt.rule ? `・依 ${routingRuleText(rt.rule)}` : '');
  }
  /** 結束的說明和上方「無法判斷的原因」是同一句時只寫一次（評審 M3） */
  const sameReason = (reasons, end) => (reasons || []).some((x) => x.code === end.code && (x.message || '') === (end.message || ''));
  function pathBlock(App, p, n, total, reasons) {
    const Q = App.Q; const multi = Q.vrfs().length > 1;
    const addr = (ip, port) => (ip == null ? '（來源位址不明）' : ip + (port != null ? ':' + port : ''));
    const endRules = p.end ? (p.end.rules || []).concat(p.end.rule ? [p.end.rule] : []) : [];
    return h('div', { class: 'l4-path', 'data-verdict': p.verdict }, [
      h('div', { class: 'l4-path-head' }, [total > 1 ? `路徑 ${n + 1}：` : '路徑：', statusTag(p.verdict), p.route && p.filter ? ' ' : null, p.route && p.filter ? layerLine(p.route.status, p.filter.status) : null]),
      h('ol', { class: 'l4-hops' }, p.hops.map((hp) => h('li', { class: 'l4-hop', 'data-dev': hp.dev }, [
        h('div', null, [h('b', null, devLink(App, hp.dev)), multi && hp.vrf ? h('span', { class: 'mono muted l4-hop-vrf' }, ` @${hp.vrf}`) : null, hp.chain ? h('span', { class: 'muted' }, ` ${hp.chain}`) : null,
          hp.collected ? null : V.chip('未收集', 'warn'), hp.firewall === 'none' && hp.collected ? V.chip('沒有防火牆資料', 'warn') : null,
          hp.returnUnsafe ? h('span', null, [' ', I.returnTag(App, [Object.assign({ dev: hp.dev }, hp.returnUnsafe)])]) : null, ' ',
          hp.verdict === 'pass' ? statusTag('allow', '這一跳通過') : statusTag(hp.verdict)]),
        h('div', { class: 'mono l4-hop-addr' }, `${addr(hp.src, null)} → ${addr(hp.dst, hp.port)}${hp.dstOut !== hp.dst || hp.portOut !== hp.port ? `　改寫為 ${addr(hp.dstOut, hp.portOut)}` : ''}${hp.srcOut !== hp.src ? `　來源改寫為 ${addr(hp.srcOut, null)}` : ''}`),
        h('div', { class: 'muted' }, `入 ${hp.inKnown ? epText(Q, hp.in) : '不明'}・出 ${hp.outKnown ? epText(Q, hp.out) : '不明'}${routeText(hp.route, multi)}`),
        hp.stages.length ? h('ul', { class: 'l4-stages' }, hp.stages.map((sg) => h('li', { 'data-status': sg.status }, [
          h('span', { class: 'mono' }, `${sg.table} ${sg.chain}`), '：',
          sg.status === 'decided' ? (sg.rule ? ruleLink(App, sg.rule) : (sg.note || '').replace(/^[^：]*：/, '')) : `無法判斷（可能 ${S.util.uniq(sg.outcomes.map((o) => o.verdict)).join('／')}）`,
          sg.status === 'decided' && sg.verdict ? h('span', { class: 'muted' }, `　→ ${V.L4_VERDICT[sg.verdict] || sg.verdict}`) : null,
          sg.via.length ? h('span', { class: 'muted' }, ['　經由 ', ...sg.via.flatMap((x, k) => [k ? '、' : '', ruleLink(App, x)])]) : null,
        ]))) : null,
        hp.nat.length ? h('ul', { class: 'l4-nat' }, hp.nat.map((x) => h('li', null, [h('b', null, `${x.dir === 'dst' ? '目的' : '來源'} NAT（${x.type}）`), `：${x.before == null ? '不明' : x.before} → ${x.after == null ? '不明' : x.after}　`, ruleLink(App, x.rule)]))) : null,
        hp.conntrack === 'untracked' ? h('div', { class: 'muted l4-ct' }, V.L4_CONNTRACK.untracked) : null,
        hp.service ? h('div', { class: 'muted' }, `設備的服務 ${hp.service.name}（埠 ${hp.service.port}）：${hp.service.enabled ? (hp.service.accepts === false ? '來源不在允許的位址內' : hp.service.accepts == null ? '來源位址不明' : '接受') : '停用'}`) : null,
        hp.reasons.length ? h('ul', { class: 'l4-reasons' }, hp.reasons.map((x) => reasonItem(App, x))) : null,
      ]))),
      p.end ? h('div', { class: 'l4-end', 'data-code': p.end.code, title: reasonNote(p.end.code) }, [h('b', null, '結束：' + V.reachReason(p.end.code)), p.end.message && !sameReason(reasons, p.end) ? '　' + p.end.message : '',
        multi && p.end.vrf ? h('span', { class: 'muted' }, `（${V.vrfText(p.end.vrf)}）`) : null,
        // 策略路由不明（policy-routing）或被 /routing rule 丟棄（policy-drop）：列出相關的規則
        endRules.length ? h('ul', { class: 'l4-end-rules' }, endRules.map((r) => h('li', { class: 'muted' }, routingRuleText(r)))) : null]) : null,
    ]);
  }

  Object.assign(I, { openCell, openGroup, runReach, rerunWithVrf, runQuery, svcLabel, renderDrill, reachBlock });
})(globalThis.SSOT = globalThis.SSOT || {});
