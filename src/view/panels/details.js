/*
 * 右側：選中項目的詳細資料。所有內容都從查詢介面（Q）取得，並附上來源（可開啟原文）。
 * 支援：device、link、pair（同兩台設備間多條鏈路）、interface、mac、ip、vlan、trace、route，
 * 以及防火牆（firewall／rule／service，畫面在 panels/firewall.js）
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const K = S.keys; const LINK_SCOPE = S.LINK_SCOPE;

  function render(App, sel) {
    const root = V.clear(V.$('#detail'));
    if (!App.Q) return root.appendChild(h('div', { class: 'empty-detail' }, [h('div', { class: 'big' }, '尚未建立基準'), '建立後，點選圖上的設備或連線，詳細資料會顯示在這裡。']));
    if (!sel) return root.appendChild(overview(App));
    const fw = (a, s) => V.firewall.render(a, s);
    const fn = { device, link, pair, interface: iface, endpoints, mac, ip, vlan, trace, firewall: fw, rule: fw, service: fw }[sel.type];
    root.appendChild(fn ? fn(App, sel) : h('div', { class: 'empty-detail' }, '無法顯示'));
    root.scrollTop = 0;
    // 定位到某一列時（例如防火牆規則），把它捲到畫面中間
    const focus = root.querySelector('.focus'); if (focus) focus.scrollIntoView({ block: 'center' });
  }

  // ---------------------------------------------------------------- 共用片段
  const L = (App, text, sel) => h('a', { class: 'link', onclick: () => App.select(sel, { focus: true }) }, text);
  const devLink = (App, k) => L(App, App.Q.devName(k), { type: 'device', key: k });
  const epLink = (App, ep) => L(App, App.Q.epName(ep), { type: 'interface', key: ep });
  const macLink = (App, m) => L(App, K.macPretty(m), { type: 'mac', key: m });
  const ipLink = (App, ip) => L(App, ip, { type: 'ip', key: ip });
  const kv = (pairs) => h('div', { class: 'kv' }, pairs.filter((p) => p && p[1] !== null && p[1] !== undefined && p[1] !== '').flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', null, v)]));
  /**
   * 詳情區塊的唯一產生方式：標題與筆數只在這裡產生，內容函式只回傳內容、不自帶標題（避免標題重複）。
   *   section(標題, 內容, { count, extra, fold, open })
   *   - 內容為 null、false 或空陣列時，整個區塊不顯示
   *   - count：標題旁的筆數；列表類區塊一律提供
   *   - fold：可展開區塊（標題在展開列，open 決定預設展開）；否則為一般區塊（h3 標題）
   */
  function section(title, content, opt) {
    const o = opt || {};
    if (content == null || content === false || (Array.isArray(content) && !content.length)) return null;
    const head = [title, o.count == null ? null : V.chip(String(o.count)), ...(o.extra || [])];
    const body = Array.isArray(content) ? h('div', null, content) : content;
    return o.fold
      ? h('details', { class: 'detail-fold', open: !!o.open }, [h('summary', null, head), body])
      : h('div', { class: 'detail-section' }, [h('h3', null, head), body]);
  }
  const vlanText = (ids) => (ids && ids.length ? S.check.fmtVlans(ids) : '—');

  /*
   * 每個詳情頁的區塊順序一致：
   *   標題 → 標籤 → 屬性 → 說明 → 檢查結果 → 主題區塊（同一主題先事實、後推論，例如鏈路 → 推論鏈路）→ 來源
   * 推論的區塊一律用 inferredSection 等共用元件，標題與說明只寫一次。
   */
  /** 推論鏈路區塊：說明推論的意義，列出兩端、依據與信心 */
  function inferredSection(App, list, from, opt) {
    return section('推論鏈路（沒有 LLDP）', list.length ? [h('p', { class: 'muted' }, '依 MAC 表、MNDP、RSTP 或點對點網段推定相鄰：是直接相連，或中間只有未管理設備。不影響任何檢查。'),
      inferredTable(App, list, from)] : null, Object.assign({ count: list.length }, opt || {}));
  }
  function findingsBlock(App, list) {
    if (!list.length) return null;
    const seen = new Set(); const uniq = list.filter((f) => (seen.has(f) ? false : seen.add(f)));
    const order = { error: 0, warn: 1, info: 2 };
    uniq.sort((a, b) => order[a.severity] - order[b.severity]);
    return section('檢查結果', uniq.map((f) => h('div', { class: 'finding' }, [
      V.sevDot(f.severity),
      h('div', null, [h('div', null, [h('b', null, f.title)]), h('div', null, f.message),
        deviationLine(App, f), ackLine(f), adviceBlock(f.id),
        f.evidence.length ? h('div', { class: f.id === 'C02' ? 'ev stack' : 'ev' }, evidenceLinks(App, f)) : null]),
    ])), { count: uniq.length });
  }
  /** 已確認的分類與原因（檢視狀態，見 app-acks.js）；未確認時不顯示 */
  function ackLine(f) {
    const ack = V.app && V.app.ackOf ? V.app.ackOf(f) : null;
    if (!ack) return null;
    return h('div', { class: 'muted ack-line' }, [V.chip('已確認', 'ok'), ' ', V.remediation.ackKindText(ack.kind), ack.note ? '：' + ack.note : '']);
  }
  /**
   * 規則的常見原因與處理（V.remediation.advice，文字來自 CATALOG）：預設收合的展開列，檢查結果與規則清單共用。
   * 反引號內的指令與欄位以 <code> 顯示（V.codeText，不用 innerHTML）。兩個欄位都沒有時不顯示。
   * opt.open：預設展開；opt.ontoggle：展開狀態改變時呼叫（呼叫端要跨重繪保留時用）。
   */
  function adviceBlock(id, opt) {
    const a = V.remediation.advice(id); const o = opt || {};
    if (!a.action && !a.causes.length) return null;
    const el = h('details', { class: 'advice', 'data-rule-id': id, open: !!o.open }, [
      h('summary', null, a.action && a.causes.length ? '常見原因與處理' : a.action ? '處理建議' : '常見原因'),
      h('div', { class: 'advice-body' }, [
        a.action ? h('div', { class: 'advice-action' }, [h('span', { class: 'advice-label' }, '處理：'), ...V.codeText(a.action)]) : null,
        a.causes.length ? h('div', { class: 'advice-causes' }, [h('span', { class: 'advice-label' }, '常見原因：'),
          h('ul', null, a.causes.map((c) => h('li', null, V.codeText(c))))]) : null,
      ]),
    ]);
    if (o.ontoggle) el.addEventListener('toggle', () => o.ontoggle(!!el.open));
    return el;
  }
  /** 跨設備一致性檢查依多數決推定偏離的設備（finding.deviation，推論）；平手時 deviating 為空，不顯示 */
  function deviationLine(App, f) {
    const d = f.deviation;
    if (!d || !d.deviating || !d.deviating.length) return null;
    return h('div', { class: 'muted' }, ['依多數決推定偏離：', ...d.deviating.flatMap((k, n) => [n ? '、' : '', devLink(App, k)]), ' ', V.chip('推論', 'info')]);
  }
  /*
   * C02 的證據是該設備的各區塊（收集失敗的註解與已收集的區塊）而非缺少的資料，標示指令以免誤解；
   * 要能對照收了哪些指令，所以不截短、全部逐行列出（核心對 C02 不限證據筆數）。
   * 失敗註解那一行標「收集失敗」，其餘標「已收集」。其他檢查維持「原文 第 N 行」最多 3 筆。
   */
  function evidenceLinks(App, f) {
    const link = (e, label) => h('a', { class: 'link mono', onclick: () => App.openRaw(e.file, e.line) }, label);
    if (f.id !== 'C02') return f.evidence.slice(0, 3).map((e) => link(e, `原文 第 ${e.line} 行`));
    return f.evidence.map((e) => {
      const blk = App.Q.block(e.block);
      const failed = blk && blk.failure && blk.failure.line === e.line;
      const what = failed ? `收集失敗（${V.failureText(blk.failure)}）` : '已收集';
      return link(e, blk && blk.command ? `${what}：${blk.command}（第 ${e.line} 行）` : `${what}：第 ${e.line} 行`);
    });
  }
  function sourcesBlock(App, src, title) {
    if (!src || !src.length) return null;
    return section(title || '來源', src.map(([b, line]) => {
      const blk = App.Q.block(b);
      return h('div', null, h('a', { class: 'link mono', onclick: () => App.openRaw(blk.file, line) }, `${blk.devKey || '?'}｜${blk.command || '（未標記指令）'}｜第 ${line} 行`));
    }), { count: src.length });
  }

  // ---------------------------------------------------------------- 總覽
  function overview(App) {
    const m = App.snap.meta; const st = m.stats; const C = App.Q.inventory().counts;
    return h('div', { class: 'detail' }, [
      h('h2', null, '總覽'),
      kv([['建立時間', V.fmtTime(m.createdAt)], ['輸入指紋', h('span', { class: 'mono' }, m.inputHash)], ['命名規則', m.profile ? `${m.profile.id} v${m.profile.version}` : '未套用'],
        ['來源', m.sources.map((s) => `${s.name}（${V.num(s.bytes)} 字元）`).join('、')]]),
      section('內容', kv([['設備', `${V.num(st.devices)}（已收集 ${V.num(st.collected)}）`], ['介面', V.num(st.interfaces)], ['鏈路', V.num(st.links)], ['VLAN 定義', V.num(st.vlans)],
        ['MAC', V.num(st.macs)], ['終端 MAC 位置（含 Wi-Fi 漫遊觀察）', V.num(C.endpoints)], ['IP（ARP）', V.num(C.arpIps)], ['路由', V.num(st.routes)]])),
      section('檢查結果', h('div', { class: 'row' }, [V.chip(`錯誤 ${st.findings.error}`, 'err'), V.chip(`警告 ${st.findings.warn}`, 'warn'), V.chip(`提醒 ${st.findings.info}`, 'info')])),
      section('解析器使用量', V.table([{ t: '解析器', f: (r) => (S.adapters[r[0]] ? S.adapters[r[0]].label : r[0]) }, { t: '事實數', f: (r) => V.num(r[1]) }], Object.entries(m.adapters)),
        { count: Object.keys(m.adapters).length }),
      h('p', { class: 'muted' }, '點選圖上的設備或連線、左側的檢查結果，或使用上方搜尋（設備、MAC、IP、VLAN）。'),
    ]);
  }

  // ---------------------------------------------------------------- 未知對端（沒有 LLDP／CDP 介面鄰接的終端埠）
  function unknownTable(App, rows, bad) {
    return V.table([
      { t: '介面', f: (r) => h('span', { class: 'mono' }, r.name) },
      { t: 'MAC', f: (r) => (r.macs.length === 1 ? macLink(App, r.macs[0].mac) : `${r.macs.length} 個 MAC`) },
      { t: 'IP', f: (r) => h('span', { class: 'mono' }, S.util.uniq([].concat(...r.macs.map((m) => m.ips))).slice(0, 3).join(' ')) },
      { t: '廠商', f: (r) => S.util.uniq(r.macs.map((m) => m.vendor).filter(Boolean)).slice(0, 2).join(' / ') },
      { t: 'VLAN', f: (r) => h('span', { class: 'vlanlist' }, vlanText(r.vlans)) },
      { t: '描述', f: (r) => r.desc || '' },
    ], rows, { onRow: (r) => App.select({ type: 'interface', key: r.ep }, { focus: true }), limit: 300, bad: bad || ((r) => r.macs.length > 1) });
  }
  function endpoints(App, sel) {
    const Q = App.Q; const rows = Q.unknownPeers(sel.dev); const wifi = Q.inventory().rows.endpoints.filter((r) => r.dev === sel.dev && r.wifi).map((r) => ({
      ep: r.key, name: r.ifc, desc: r.desc, status: r.status, type: r.type, vlans: r.vlans, macs: [{ mac: r.mac, vendor: r.vendors[0] || null, ips: r.ips }],
    })); const d = Q.getDevice(sel.dev);
    if (!d) return h('div', { class: 'empty-detail' }, '基準中沒有這台設備');
    const macs = rows.reduce((n, r) => n + r.macs.length, 0); const multi = rows.filter((r) => r.macs.length > 1).length;
    const collapsed = App.virtual.has('?c|' + sel.dev);
    return h('div', { class: 'detail' }, [
      h('h2', null, [devLink(App, sel.dev), ' 的終端 MAC 位置']),
      h('div', { class: 'row' }, [V.chip(`${rows.length} 個終端埠`), V.chip(`${macs + wifi.length} 個終端 MAC 位置`),
        wifi.length ? V.chip(`${wifi.length} 個 Wi-Fi MAC 位置`, 'info') : null,
        multi ? V.chip(`${multi} 個終端埠有多個 MAC`, 'warn') : null,
        rows.length + wifi.length > 1 ? h('button', { onclick: () => App.toggleExpand(sel.dev) }, collapsed ? '在圖上展開' : (App.expanded.has(sel.dev) ? '在圖上收合' : '（已全部展開）')) : null]),
      h('p', { class: 'muted' }, '一般終端埠只學到一個 MAC，且沒有 LLDP／CDP 介面鄰接。Wi-Fi 是一對多介面：每個觀察到的 MAC 位置會列入終端清單，但不把 Wi-Fi 介面判為終端，也不參與 A02，因為 MAC 可能隨使用者漫遊而移動。MNDP 只代表同一 L2 廣播網域可達，不算直連鄰接。'),
      // 點選 A03（未知對端）會來到這裡：列出這台設備的 A03，處理建議才看得到
      findingsBlock(App, Q.findingsFor('device', sel.dev).filter((f) => f.id === 'A03')),
      section('終端埠', rows.length ? unknownTable(App, rows) : null, { count: rows.length }),
      section('Wi-Fi MAC 觀察（列入終端清單，不參與 A02）', wifi.length ? unknownTable(App, wifi, () => false) : null, { count: wifi.length }),
    ]);
  }

  // ---------------------------------------------------------------- 設備
  function device(App, sel) {
    const Q = App.Q; const d = Q.getDevice(sel.key);
    if (!d) return h('div', { class: 'empty-detail' }, '基準中沒有這台設備');
    const links = Q.linksOf(d.key);
    const ospfAdjacencies = Q.ospfAdjacenciesOf(d.key);
    const cov = App.snap.coverage.find((c) => c.dev === d.key);
    const ifs = Q.interfacesOf(d.key).filter((i) => !i.hearsay || !d.collected);
    const fl = Q.findingsFor('device', d.key).concat(...links.map((l) => Q.findingsFor('link', l.key)), ...ifs.map((i) => Q.findingsFor('interface', i.key)));
    const peerRows = Q.neighborRows(d.key).sort((x, y) => S.util.natural(x.mine, y.mine));
    const vlans = Q.vlansOf(d.key); const routes = Q.routesOf(d.key); const unk = Q.unknownPeers(d.key);
    const blocks = App.snap.blocks.filter((b) => b.devKey === d.key);
    const neighborHasFinding = peerRows.some((r) => r.links.some((l) =>
      l.vlanMismatch || Q.findingsFor('link', l.key).some((f) => f.severity !== 'info')));
    return h('div', { class: 'detail' }, [
      h('h2', null, d.label || d.name),
      h('div', { class: 'row' }, [V.kindChip(d.kind), d.collected ? V.chip('已收集', 'ok') : V.chip('未收集（僅由鄰居發現）', 'warn'), d.group ? V.chip(d.group) : null, d.role ? V.chip('角色：' + d.role) : null]),
      kv([['管理 IP', d.mgmtIp], ['型號', d.deviceType], ['RouterOS', d.softwareVersion],
        ['平台', d.manufacturer === 'mikrotik' ? null : d.platform], ['鄰居回報的功能', d.caps], ['類型依據', V.KIND_BASIS[d.kindBasis]],
        ['收集時間', d.collectedAt ? `${d.collectedAt.replace('T', ' ')}（設備時間，取自 export）` : null],
        ['其他名稱', d.names.length > 1 ? d.names.join('、') : null], ['Router ID', d.routerId],
        ['看到它的設備', d.seenBy.length ? h('span', null, d.seenBy.flatMap((k, i) => [i ? '、' : '', devLink(App, k)])) : null],
        ['收集的資料', d.collected ? h('div', { class: 'chip-list' }, [
          ...(cov ? cov.data : []).map((t) => V.chip(S.check.DATA_LABEL[t] || t, 'ok')),
          ...(cov ? cov.missing : []).map((t) => V.chip('缺 ' + (S.check.DATA_LABEL[t] || t), 'err')),
          ...(cov && cov.failures ? cov.failures : []).map((x) => V.chip(`收集失敗：${x.command || '整台設備'}`, 'err', { title: V.failureText(x) })),
        ]) : null]]),
      findingsBlock(App, fl),
      section('介面', V.table([
        { t: '介面', f: (i) => h('span', { class: 'mono' }, i.name + (i.lag ? ` → ${Q.getInterface(i.lag).name}` : '')), s: (i) => i.name },
        { t: '狀態', f: V.ifcState, s: V.ifcState },
        { t: '描述／IP', f: (i) => [i.desc, ...Q.addressesOf(i.key)].filter(Boolean).join('  '), s: (i) => Q.addressesOf(i.key)[0] || i.desc },
        { t: 'VLAN', f: (i) => h('span', { class: 'vlanlist' }, vlanText(S.util.ifcVlans(i))), s: (i) => vlanText(S.util.ifcVlans(i)) },
        { t: 'MAC', f: (i) => (i.macs.length ? String(i.macs.length) : ''), s: (i) => i.macs.length || null },
      ], ifs.sort((a, b) => S.util.natural(a.name, b.name)), { onRow: (i) => App.select({ type: 'interface', key: i.key }), limit: 300 }), { count: ifs.length }),
      section('VLAN 定義', vlans.length ? V.table([
        { t: 'ID', f: (v) => (v.id == null ? '?' : String(v.id)) }, { t: '名稱', f: (v) => v.name || '' }, { t: '描述', f: (v) => v.desc || '' }, { t: '成員', f: (v) => String(v.members.length) },
      ], vlans, { onRow: (v) => v.id != null && App.select({ type: 'vlan', key: String(v.id) }) }) : null, { count: vlans.length, fold: true }),
      section('沒有 LLDP／CDP 鄰接的埠', unk.length ? unknownTable(App, unk) : null,
        { count: unk.length, extra: [h('a', { class: 'link', onclick: () => App.select({ type: 'endpoints', dev: d.key }, { focus: true }) }, '在圖上看')] }),
      section('鄰居', peerRows.length ? V.table([
        { t: '本機介面', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? h('span', { class: 'mono' }, r.observations.length ? r.observations.map((o) => o.ifc).join('、') : '對端回報')
          : h('span', { class: 'mono' }, ifName(Q, r.mine)),
        s: (r) => (r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? (r.observations[0] ? r.observations[0].ifc : '') : ifName(Q, r.mine)) },
        { t: '對端', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? Q.devName(K.splitEp(r.other)[0])
          : h('span', null, [Q.devName(K.splitEp(r.other)[0]), h('span', { class: 'mono muted' }, ' ' + ifName(Q, r.other))]),
        s: (r) => Q.devName(K.splitEp(r.other)[0]) },
        { t: '類別', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? 'MNDP・同一 L2 廣播網域可達（非直連確認）'
          : V.protoText(r.l) + '・' + V.CLS[r.l.cls] + (r.l.hearsay ? '・單側觀察' : '') + (!r.l.verified && !r.l.hearsay ? '・單向' : ''),
        s: (r) => (r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? 'MNDP' : V.protoText(r.l)) },
        { t: 'VLAN', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? '—'
          : (r.l.vlanMismatch ? h('span', { class: 'diffA' }, '不一致') : h('span', { class: 'vlanlist' }, vlanText(r.l.vlansCommon))),
        s: (r) => (r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? null : r.l.vlanMismatch ? '不一致' : vlanText(r.l.vlansCommon)) },
      ], peerRows, {
        onRow: (r) => App.select({ type: 'link', key: r.l.key }, { focus: true }),
        bad: (r) => r.links.some((x) => x.vlanMismatch || Q.findingsFor('link', x.key).some((f) => f.severity !== 'info')),
      }) : h('div', { class: 'muted' }, '沒有鏈路'),
        { count: peerRows.length, fold: true, open: neighborHasFinding }),
      inferredSection(App, Q.inferredLinksOf(d.key), d.key, { fold: true }),
      section('OSPF L3 鄰接（非實體直連）', ospfAdjacencies.length ? V.table([
          { t: '本機介面', f: (a) => epLink(App, a.localEp), s: (a) => K.splitEp(a.localEp)[1] },
          { t: '鄰居', f: (a) => devLink(App, a.peerDev), s: (a) => Q.devName(a.peerDev) },
          { t: '鄰居位址／Router ID', f: (a) => [a.peerIp, a.peerId].filter(Boolean).join('／'), s: (a) => a.peerIp || a.peerId },
          { t: '回報', f: (a) => a.reciprocal ? '雙向 OSPF 鄰接' : '單向 OSPF 觀察', s: (a) => (a.reciprocal ? '雙向' : '單向') },
          { t: '來源', f: (a) => {
            const [block, line] = a.src[0]; const b = Q.block(block);
            return b ? h('a', { class: 'link mono', onclick: () => App.openRaw(b.file, line) }, `${b.file} 第 ${line} 行`) : '';
          } },
        ], ospfAdjacencies) : null, { count: ospfAdjacencies.length, fold: true }),
      section('路由表', routes.length ? V.table([
        { t: '網段', f: (r) => h('span', { class: 'mono' }, `${r.prefix}/${r.len}`), s: (r) => `${r.prefix}/${r.len}` },
        { t: '協定', f: (r) => (r.blackhole ? h('span', { class: 'diffA' }, '黑洞路由') : r.proto), s: (r) => r.proto },
        { t: '距離', f: (r) => (r.distance == null ? '' : String(r.distance)), s: (r) => r.distance },
        { t: '下一跳', f: (r) => h('span', { class: 'mono' }, r.nh.map((n) => (n.ip ? n.ip + ' ' : '') + (n.ifc || '')).join('\n')), s: (r) => (r.nh[0] ? r.nh[0].ip || r.nh[0].ifc : '') },
      ], routes, { limit: 200 }) : null, { count: routes.length, fold: true }),
      firewallSummary(App, d.key),
      section('收集到的原始輸出', blocks.length ? blocksTable(App, blocks) : null,
        { count: blocks.length, fold: true, open: blocks.some((b) => b.failure) }),
    ]);
  }
  /** 設備詳情的防火牆摘要：規則、服務與 WAN／LAN 狀態；完整內容在防火牆畫面 */
  function firewallSummary(App, dev) {
    const Q = App.Q; const rules = Q.firewallRulesOf(dev); const services = Q.ipServicesOf(dev); const zone = Q.firewallZone(dev);
    if (!rules.length && !services.length && !zone) return null;
    const bad = rules.filter((r) => Q.findingsFor('rule', r.key).some((f) => f.severity !== 'info')).length;
    // 用語與防火牆畫面共用 firewall.js 的 zoneStatus()（該檔在本檔之後載入，render 時才取用）
    const zs = zone && V.firewall.zoneStatus(zone.status);
    return section('防火牆', [
      h('div', { class: 'row' }, [
        V.chip(`${rules.length} 條規則`), bad ? V.chip(`${bad} 條有問題`, 'warn') : null, V.chip(`${services.length} 個服務`),
        zs ? V.chip(zs.short, zs.tone, { title: zs.text }) : null,
      ]),
      h('div', null, h('a', { class: 'link', onclick: () => App.select({ type: 'firewall', dev }) }, '查看防火牆規則與服務')),
    ]);
  }
  /** 收集到的原始輸出：每個區塊的指令、解析器、收集時間（UTC）與收集失敗；點一下開啟原文（失敗的區塊開在失敗那一行） */
  function blocksTable(App, bs) {
    return V.table([
      { t: '指令', f: (b) => b.command || '（未標記）', s: (b) => b.command || '（未標記）' },
      { t: '收集時間', f: (b) => (b.collectedAt ? h('span', { class: 'mono' }, V.fmtUtc(b.collectedAt)) : ''), s: (b) => b.collectedAt },
      { t: '失敗', f: (b) => (b.failure ? V.chip(V.failureText(b.failure), 'err', { title: b.failure.text || null }) : ''), s: (b) => (b.failure ? b.failure.reason : null) },
      { t: '解析器', f: (b) => (b.adapters.length && !b.empty ? b.adapters.map((a) => S.adapters[a].label).join('、') : h('span', { class: 'diffA' }, '無法辨識')),
        s: (b) => (b.adapters.length && !b.empty ? b.adapters.map((a) => S.adapters[a].label).join('、') : '無法辨識') },
      { t: '行', f: (b) => `${b.start}–${b.end}`, s: (b) => b.start },
    ], bs, { onRow: (b) => App.openRaw(b.file, b.failure ? b.failure.line : b.start), bad: (b) => !!b.failure });
  }
  const ifName = (Q, ep) => { const i = Q.getInterface(ep); const n = K.splitEp(ep)[1]; return i ? i.name : n.startsWith('?(') ? '埠不明' : n; };
  /** 推論鏈路的文字連結：點選開啟所在的設備對 */
  const inferredLink = (App, l, from) => {
    const Q = App.Q; const p = App.pairs.get(App.pairOfLink.get(l.key));
    const text = (from && K.splitEp(l.b)[0] === from ? [l.b, l.a] : [l.a, l.b]).map((ep) => `${Q.devName(K.splitEp(ep)[0])} ${ifName(Q, ep)}`).join(' ⇄ ') + '（推論鏈路）';
    return p ? L(App, text, { type: 'pair', id: p.id, links: p.links, devs: [p.a, p.b] }) : text;
  };
  /** 推論鏈路清單：每條列出兩端、依據與信心，展開可看每項證據並開啟原文。 */
  function inferredTable(App, list, from) {
    const Q = App.Q;
    const ends = (l) => (from && K.splitEp(l.b)[0] === from ? [l.b, l.a] : [l.a, l.b]);
    return V.table([
      { t: '本端', f: (l) => h('span', null, [Q.devName(K.splitEp(ends(l)[0])[0]), h('span', { class: 'mono muted' }, ' ' + ifName(Q, ends(l)[0]))]) },
      { t: '對端', f: (l) => h('span', null, [devLink(App, K.splitEp(ends(l)[1])[0]), h('span', { class: 'mono muted' }, ' ' + ifName(Q, ends(l)[1]))]) },
      { t: '依據', f: (l) => h('div', null, l.evidence.map((e) => h('div', null, [h('b', null, V.INFER_BASIS[e.basis] + '：'), e.text, ...e.src.map(([b, line]) => {
        const blk = Q.block(b); return blk ? h('a', { class: 'link mono', onclick: () => App.openRaw(blk.file, line) }, ` 第 ${line} 行`) : null;
      })]))) },
      { t: '信心', f: (l) => V.chip(V.CONFIDENCE[l.confidence], l.confidence === 'high' ? 'ok' : 'info') },
    ], list);
  }

  // ---------------------------------------------------------------- 鏈路
  function link(App, sel) {
    const Q = App.Q; const l = Q.getLink(sel.key);
    if (!l) return h('div', { class: 'empty-detail' }, '基準中沒有這條鏈路');
    const sa = new Set(l.vlansA); const sb = new Set(l.vlansB);
    const onlyA = l.vlansA.filter((v) => !sb.has(v)); const onlyB = l.vlansB.filter((v) => !sa.has(v));
    const fl = Q.findingsFor('link', l.key).concat(Q.findingsFor('interface', l.a), Q.findingsFor('interface', l.b));
    const domain = l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN;
    const observedAt = (l.observations || []).map((o) => {
      const b = Q.block(o.block);
      return `${Q.devName(o.dev)} ${o.ifc}${o.peerIfc ? `（對端回報埠 ${o.peerIfc}）` : ''}${b ? `・${b.file} 第 ${o.line} 行` : ''}`;
    });
    return h('div', { class: 'detail' }, [
      h('h2', null, [Q.devName(K.splitEp(l.a)[0]), ' ⇄ ', Q.devName(K.splitEp(l.b)[0])]),
      h('div', { class: 'row' }, domain
        ? [V.chip('同一 L2 broadcast domain 可達（MNDP；非直連確認）', 'info'), ...l.via.map((v) => V.chip(v.toUpperCase()))]
        : [V.chip(V.CLS[l.cls]), l.verified ? V.chip('雙向確認', 'ok') : l.hearsay ? V.chip('單側觀察（對端未提供 LLDP）', 'info') : V.chip('單向', 'warn'), ...l.via.map((v) => V.chip(v.toUpperCase()))]),
      domain
        ? kv([['關係', 'MNDP 觀察到的 L2 廣播網域可達性；不代表兩台設備之間存在直連線路。'],
          ['觀察位置', observedAt.length ? observedAt.join('；') : '詳見原始輸出']])
        : kv([['A 端', epLink(App, l.a)], ['B 端', epLink(App, l.b)], ['層級', 'L2（介面鄰接）']]),
      findingsBlock(App, fl),
      section('VLAN', !domain ? kv([
        ['兩端都有', h('span', { class: 'vlanlist' }, vlanText(l.vlansCommon))],
        ['只在 A 端', onlyA.length ? h('span', { class: 'vlanlist diffA' }, vlanText(onlyA)) : '—'],
        ['只在 B 端', onlyB.length ? h('span', { class: 'vlanlist diffA' }, vlanText(onlyB)) : '—'],
      ]) : null),
      sourcesBlock(App, l.src),
    ]);
  }
  function pair(App, sel) {
    const Q = App.Q; const links = sel.links.map((k) => Q.getLink(k)).filter(Boolean);
    const [a, b] = sel.devs;
    const inferredList = Q.inferredLinksBetween(a, b);
    const behind = S.util.uniq(inferredList.flatMap((l) => Q.behindUnder(l.key)));
    return h('div', { class: 'detail' }, [
      h('h2', null, [Q.devName(a), ' ⇄ ', Q.devName(b)]),
      h('div', { class: 'row' }, [links.length ? V.chip(`${links.length} 條鏈路`) : null, inferredList.length ? V.chip(`${inferredList.length} 條推論鏈路`, 'info') : null]),
      findingsBlock(App, [].concat(...links.map((l) => Q.findingsFor('link', l.key)))),
      section('鏈路（LLDP／CDP／MNDP）', links.length ? V.table([
        { t: Q.devName(a), f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? 'MNDP 觀察'
          : h('span', { class: 'mono' }, ifName(Q, K.splitEp(l.a)[0] === a ? l.a : l.b)) },
        { t: Q.devName(b), f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? 'L2 廣播網域可達'
          : h('span', { class: 'mono' }, ifName(Q, K.splitEp(l.a)[0] === a ? l.b : l.a)) },
        { t: '類別', f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? 'MNDP・同一 L2 廣播網域可達（非直連確認）'
          : V.CLS[l.cls] + (l.verified ? '' : l.hearsay ? '・單側觀察' : '・單向') },
        { t: '協定', f: (l) => V.protoText(l) },
        { t: 'VLAN', f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? '—'
          : (l.vlanMismatch ? h('span', { class: 'diffA' }, '不一致') : h('span', { class: 'vlanlist' }, vlanText(l.vlansCommon))) },
      ], links, { onRow: (l) => App.select({ type: 'link', key: l.key }) }) : null, { count: links.length }),
      inferredSection(App, inferredList, a),
      section('推定在這條推論鏈路後面的終端', behind.length ? V.table([
        { t: 'MAC', f: (x) => macLink(App, x.mac), s: (x) => x.mac }, { t: '廠商', f: (x) => x.vendor || '' }, { t: 'IP', f: (x) => x.ips.join(', ') },
        { t: '推定位置', f: (x) => (x.behind.dev ? `在 ${Q.devName(x.behind.dev)} 底下` : `在 ${x.behind.via.map((v) => Q.devName(v)).join('、')} 或其下游`) },
      ], behind, { limit: 500 }) : null, { count: behind.length, fold: true }),
    ]);
  }

  // ---------------------------------------------------------------- 介面
  function iface(App, sel) {
    const Q = App.Q; const i = Q.getInterface(sel.key);
    if (!i) return h('div', { class: 'empty-detail' }, '基準中沒有這個介面');
    const links = Q.linksOfEp(i.key); const inferred = Q.inferredLinksOfEp(i.key);
    const macs = i.macs.map((m) => Q.findMac(m));
    return h('div', { class: 'detail' }, [
      h('h2', null, [devLink(App, i.dev), ' ', h('span', { class: 'mono' }, i.name)]),
      h('div', { class: 'row' }, [
        V.chip(V.ifcState(i), i.status === 'up' ? 'ok' : ''),
        V.chip((V.theme.endpoint.styleOf(i) || {}).label || V.IFC_TYPE[i.type], '', { title: V.IFC_TYPE_BASIS[i.typeBasis] }),
        i.hearsay ? V.chip('僅由對端回報', 'info') : null,
        i.unknownPeer ? V.chip('沒有 LLDP／CDP 鄰接（未知對端）', 'warn') : i.edge ? V.chip('終端埠') : null,
      ]),
      kv([['描述', i.desc], ['RouterOS 類型', i.rawType], ['介面 MAC', i.hwMac ? K.macPretty(K.mac(i.hwMac) || i.hwMac) : null], ['預設名稱', i.defaultName && i.defaultName !== i.name ? i.defaultName : null],
        ['MTU', [['mtu', i.mtu], ['actual', i.actualMtu], ['l2mtu', i.l2mtu]].filter((x) => x[1] != null).map((x) => `${x[0]} ${x[1]}`).join('、') || null],
        ['IP', Q.addressesOf(i.key).join('、')], ['埠模式', V.MODE[i.mode]], ['所屬聚合', i.lag ? epLink(App, i.lag) : null], ['所屬 Bridge', i.bridge ? epLink(App, i.bridge) : null],
        ['聚合成員', i.lagMembers.length ? h('span', null, i.lagMembers.flatMap((m, n) => [n ? '、' : '', epLink(App, m)])) : null],
        ['RSTP', i.stp ? [i.stp.role, i.stp.edge ? 'edge' : null, i.stp.designatedBridge ? `指定橋接器 ${K.macPretty(i.stp.designatedBridge)}` : null].filter(Boolean).join('・') : null],
        ['PVID', i.pvid == null ? null : String(i.pvid)], ['frame-types', i.frameTypes],
        ['ingress-filtering', i.ingressFiltering == null ? null : i.ingressFiltering ? '開' : '關'],
        ['Untagged VLAN', i.untaggedVlans.length ? h('span', { class: 'vlanlist' }, vlanText(i.untaggedVlans)) : null],
        ['Tagged VLAN', i.taggedVlans.length ? h('span', { class: 'vlanlist' }, vlanText(i.taggedVlans)) : null], ['無法辨識的 VLAN', i.unresolvedVlans.join('、')],
        ['VLAN 子介面', i.parent ? h('span', null, [epLink(App, i.parent), ` 上的 VLAN ${i.encapVlan}`]) : null]]),
      findingsBlock(App, Q.findingsFor('interface', i.key)),
      section('鏈路', links.map((l) => h('div', null, L(App,
        l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? `${Q.devName(K.splitEp(l.a)[0] === i.dev ? K.splitEp(l.b)[0] : K.splitEp(l.a)[0])}（MNDP：L2 廣播網域可達，非直連）`
          : `${Q.epName(l.a)} ⇄ ${Q.epName(l.b)}`,
        { type: 'link', key: l.key }))), { count: links.length }),
      inferredSection(App, inferred, i.dev),
      section('學到的 MAC', macs.length ? V.table([
        { t: 'MAC', f: (m) => macLink(App, m.mac) }, { t: '廠商', f: (m) => m.vendor || '' }, { t: 'IP', f: (m) => m.ips.join(', ') },
      ], macs, { limit: 500 }) : null, { count: macs.length }),
      sourcesBlock(App, i.src),
    ]);
  }

  // ---------------------------------------------------------------- MAC / IP
  function mac(App, sel) {
    const Q = App.Q; const m = Q.findMac(sel.key);
    return h('div', { class: 'detail' }, [
      h('h2', { class: 'mono' }, K.macPretty(m.mac)),
      h('div', { class: 'row' }, [m.found ? null : V.chip('基準中沒有這個 MAC', 'warn'), m.vendor ? V.chip(m.vendor) : V.chip('廠商不明')]),
      kv([['IP（ARP）', m.ips.length ? h('span', null, m.ips.flatMap((x, n) => [n ? '、' : '', ipLink(App, x)])) : '—'],
        ['位置（終端埠）', m.edge.length ? h('span', null, m.edge.flatMap((ep, n) => [n ? '、' : '', epLink(App, ep)])) : '—'],
        ...wifiRows(App, m.wifi), ...behindRows(App, m.behind, m.mac)]),
      findingsBlock(App, Q.findingsFor('mac', m.mac)),
      section('在哪些介面／VLAN 學到', m.seen.length ? V.table([
        { t: '設備介面', f: (r) => epLink(App, r.ep) }, { t: 'VLAN', f: (r) => r.vlan || '' }, { t: '類型', f: (r) => (r.static ? '靜態' : '動態') }, { t: '', f: (r) => portRole(App, m, r.ep) },
      ], m.seen) : null, { count: m.seen.length }),
    ]);
  }
  /** 推定位置：在未收集交換器（例如 SwOS 的 CSS106）底下，精確到設備、埠不明。 */
  /** MAC 學到的位置屬於哪種埠；沒有方向依據，不標上行／下行 */
  function portRole(App, m, ep) {
    if (m.edge.includes(ep)) return V.chip('終端', 'ok');
    const b = m.behind;
    if (b && b.anchor === ep) return V.chip(`往 ${(b.dev ? [b.dev] : b.via).map((d) => App.Q.devName(d)).join('、')}（推定）`, 'info');
    return V.chip('非終端埠', '', { title: '這個埠學到多個 MAC 或接到網路設備，所以不是終端位置；不代表方向' });
  }
  function behindRows(App, b, mk) {
    if (!b) return [];
    const where = b.dev ? h('span', null, ['在 ', devLink(App, b.dev), ' 底下（埠不明）']) : h('span', null, ['在 ', ...b.via.flatMap((v, n) => [n ? '、' : '', devLink(App, v)]), ' 或其下游（無法確定是哪一台）']);
    const via = App.Q.behindVia(mk);
    return [['推定位置', h('span', null, [where, ' ', V.chip('推定', 'info')])],
      ['推定依據', h('span', null, [epLink(App, b.anchor), ' 的 MAC 表學到它，且沒有在其他已收集交換器更下游出現；該交換器沒有收集資料，所以埠不明'])],
      ['經由', via.length ? h('span', null, via.flatMap((l, n) => [n ? '、' : '', inferredLink(App, l, K.splitEp(b.anchor)[0])])) : null]];
  }
  /** Wi-Fi 位置：依證據強度標示信心；漫遊時列出其他候選位置。 */
  function wifiRows(App, w) {
    if (!w) return [];
    const where = w.basis === 'via-ap-port' ? h('span', null, ['經由 ', devLink(App, w.dev), '（', epLink(App, w.ep), '）']) : epLink(App, w.ep);
    return [['Wi-Fi 位置', where], ['位置依據', h('span', null, [V.WIFI_BASIS[w.basis], w.roaming ? V.chip('可能漫遊', 'warn') : null])],
      ['SSID／頻段', [w.ssid, w.band].filter(Boolean).join('・') || null], ['主機名稱（DHCP）', w.hostname], ['位址（DHCP）', w.ip],
      ['訊號', w.signal == null ? null : `${w.signal} dBm`],
      ['其他候選位置', w.candidates.length ? h('span', null, w.candidates.flatMap((ep, n) => [n ? '、' : '', epLink(App, ep)])) : null]];
  }
  function ip(App, sel) {
    const Q = App.Q; const r = Q.findIp(sel.key);
    const owner = r.owner && !r.owner.endsWith('|') ? r.owner : null; const mgmt = r.owner && r.owner.endsWith('|') ? r.owner.slice(0, -1) : null;
    return h('div', { class: 'detail' }, [
      h('h2', { class: 'mono' }, r.ip),
      kv([['設定在', owner ? epLink(App, owner) : mgmt ? h('span', null, [devLink(App, mgmt), '（管理 IP）']) : '—'],
        ['所屬網段', r.subnets.length ? h('span', null, r.subnets.slice(0, 4).flatMap((s, n) => [n ? '、' : '', `${s.net}/${s.len} @ `, epLink(App, s.ep)])) : '—'],
        ['MAC（ARP）', r.macs.length ? h('span', null, r.macs.flatMap((m, n) => [n ? '、' : '', macLink(App, m)])) : '—'],
        ['位置（終端埠）', r.locations.length ? h('span', null, r.locations.flatMap((x, n) => [n ? '、' : '', epLink(App, x.ep)])) : '—']]),
      h('div', { class: 'row spaced' }, [h('button', { onclick: () => App.openTrace(r.ip, '') }, '從這個 IP 追蹤路由'), h('button', { onclick: () => App.openTrace('', r.ip) }, '追蹤到這個 IP')]),
      findingsBlock(App, Q.findingsFor('ip', r.ip)),
      section('ARP 紀錄', r.arps.length ? V.table([
        { t: '設備', f: (a) => devLink(App, a.dev) }, { t: '介面', f: (a) => a.ifc }, { t: 'MAC', f: (a) => macLink(App, a.mac) },
      ], r.arps) : null, { count: r.arps.length }),
    ]);
  }

  // ---------------------------------------------------------------- VLAN
  function vlan(App, sel) {
    const Q = App.Q; const v = Q.vlan(sel.key, sel.domain);
    const fl = Q.findingsFor('vlan', String(v.id)).concat(...v.partial.map((l) => Q.findingsFor('link', l.key)));
    const split = v.domains.length > 1; const at = v.domains.findIndex((d) => d.key === v.domain);
    const domainName = (d, idx) => `區塊 ${idx + 1}：${d.devices.slice(0, 3).map((k) => Q.devName(k)).join('、')}`
      + (d.devices.length > 3 ? ` 等 ${d.devices.length} 台` : '');
    return h('div', { class: 'detail' }, [
      h('h2', null, 'VLAN ' + v.id + (at >= 0 ? `（區塊 ${at + 1}／${v.domains.length}）` : '')),
      h('div', { class: 'row' }, [
        V.chip(`${v.devices.length} 台設備`), V.chip(`通過 ${v.carry.length} 條鏈路`, 'ok'),
        v.inferred.length ? V.chip(`${v.inferred.length} 條推論鏈路`, 'info') : null,
        v.partial.length ? V.chip(`${v.partial.length} 條只有一端`, 'err') : null,
        split ? V.chip(`${v.domains.length} 個不相連區塊（推論）`, 'warn') : null,
      ]),
      kv([['名稱', v.names.length ? v.names.join('、') : '—']]),
      h('p', { class: 'muted' }, '圖上：綠色為兩端都有此 VLAN 的鏈路，紅色為只有一端有；推論鏈路在已收集的各端都有此 VLAN 時也標綠色（屬推論）。'),
      split ? h('p', { class: 'muted' }, '同一個 VLAN ID 的設備之間沒有承載此 VLAN 的鏈路相連，可能是各自獨立的廣播網域（例如不同站點重用 VLAN ID），'
        + '也可能只是中間有沒收集、沒有 LLDP 的設備。區塊是依鏈路證據的推論。') : null,
      findingsBlock(App, fl),
      section('只有一端有此 VLAN 的鏈路', v.partial.map((l) => h('div', null, L(App, `${Q.epName(l.a)} ⇄ ${Q.epName(l.b)}`, { type: 'link', key: l.key }))), { count: v.partial.length }),
      section('設備', V.table([
        { t: '設備', f: (d) => devLink(App, d) },
        { t: '名稱', f: (d) => (v.entries.find((e) => e.dev === d) || {}).name || '' },
        { t: '成員介面', f: (d) => String((v.entries.find((e) => e.dev === d) || { members: [] }).members.length) },
      ], v.devices),
        { count: v.devices.length }),
      section('不相連區塊（推論）', split ? [
        ...v.domains.map((d, idx) => h('div', null, d.key === v.domain
          ? h('b', null, domainName(d, idx))
          : L(App, domainName(d, idx), { type: 'vlan', key: String(v.id), domain: d.key }))),
        at >= 0 ? h('div', null, L(App, '顯示所有區塊', { type: 'vlan', key: String(v.id) })) : null,
      ] : null, { count: v.domains.length }),
    ]);
  }

  // ---------------------------------------------------------------- 路由追蹤
  const TRACE_END = { reached: '抵達', noroute: '沒有路由', 'unknown-nh': '下一跳不在基準內', loop: '路由迴圈', ttl: 'TTL 用盡', blackhole: '黑洞路由' };
  /** 一個方向的逐跳與結果（去程、回程共用；prefix 區分標題）。 */
  function tracePath(App, t, prefix) {
    return [
      section(`${prefix || ''}逐跳`, t.hops.map((hp) => h('div', { class: 'hop' }, [
        h('div', null, [h('b', null, devLink(App, hp.dev)), h('span', { class: 'mono muted' }, `  ${hp.route}（${hp.proto}）`), hp.ecmp ? V.chip('ECMP', 'info') : null]),
        ...hp.next.map((n) => h('div', { class: 'mono' }, [
          `→ ${n.ip || ''} ${n.ifc || ''} `,
          n.dev ? devLink(App, n.dev) : null,
          n.note ? h('span', { class: n.status === 'ok' || n.status === 'connected' ? 'muted' : 'diffA' }, '  ' + n.note) : null,
        ])),
      ])), { count: t.hops.length }),
      section(`${prefix || ''}結果`, t.ends.map((e) => h('div', { class: 'hop ' + (e.status === 'reached' ? 'end-reached' : 'end-bad') }, [
        h('b', null, devLink(App, e.dev)), `：${TRACE_END[e.status] || e.status}`, h('div', { class: 'muted' }, e.note),
      ])), { count: t.ends.length }),
    ];
  }
  function trace(App, sel) {
    const t = sel.result; const back = sel.reverse;
    if (!t.ok) return h('div', { class: 'detail' }, [h('h2', null, '路由追蹤'), h('p', { class: 'diffA' }, t.error)]);
    // 非對稱：回程經過的設備順序和去程反過來不同
    const devs = (x) => x.hops.map((hp) => hp.dev);
    const asym = back && back.ok && devs(back).join('>') !== devs(t).slice().reverse().join('>');
    return h('div', { class: 'detail' }, [
      h('h2', { class: 'mono' }, `${t.src} → ${t.dst}`),
      h('div', { class: 'row' }, [t.reached ? V.chip('可抵達', 'ok') : V.chip('無法完整抵達', 'err'), t.hops.some((x) => x.ecmp) ? V.chip('含 ECMP', 'info') : null,
        back ? (back.ok && back.reached ? V.chip('回程可抵達', 'ok') : V.chip('回程無法完整抵達', 'err')) : null, asym ? V.chip('非對稱路徑', 'warn') : null]),
      kv([['起點', h('span', null, [devLink(App, t.start), '（來源所在網段的閘道）'])]]),
      ...tracePath(App, t),
      back ? section(`回程（${t.dst} → ${t.src}）`, back.ok ? kv([['起點', devLink(App, back.start)], ['說明', '無狀態的 ACL 需要確認回程也能通過']]) : h('p', { class: 'diffA' }, back.error)) : null,
      ...(back && back.ok ? tracePath(App, back, '回程') : []),
    ]);
  }

  // 其他詳情畫面（panels/firewall.js）共用的片段：區塊一律經 section() 產生
  V.details = { render, parts: { section, kv, L, devLink, epLink, findingsBlock, adviceBlock } };
})(globalThis.SSOT = globalThis.SSOT || {});
