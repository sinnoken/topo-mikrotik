/*
 * 右側：選中項目的詳細資料。所有內容都從查詢介面（Q）取得，並附上來源（可開啟原文）。
 * 支援：device、link、pair（同兩台設備間多條連結）、interface、mac、ip、vlan、trace、route
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const K = S.keys; const LINK_SCOPE = S.LINK_SCOPE;

  function render(App, sel) {
    const root = V.clear(V.$('#detail'));
    if (!App.Q) return root.appendChild(h('div', { class: 'empty-detail' }, [h('div', { class: 'big' }, '尚未建立基準'), '建立後，點選圖上的設備或連線，詳細資料會顯示在這裡。']));
    if (!sel) return root.appendChild(overview(App));
    const fn = { device, link, pair, interface: iface, endpoints, mac, ip, vlan, trace }[sel.type];
    root.appendChild(fn ? fn(App, sel) : h('div', { class: 'empty-detail' }, '無法顯示'));
    root.scrollTop = 0;
  }

  // ---------------------------------------------------------------- 共用片段
  const L = (App, text, sel) => h('a', { class: 'link', onclick: () => App.select(sel, { focus: true }) }, text);
  const devLink = (App, k) => L(App, App.Q.devName(k), { type: 'device', key: k });
  const epLink = (App, ep) => L(App, App.Q.epName(ep), { type: 'interface', key: ep });
  const macLink = (App, m) => L(App, K.macPretty(m), { type: 'mac', key: m });
  const ipLink = (App, ip) => L(App, ip, { type: 'ip', key: ip });
  const kv = (pairs) => h('div', { class: 'kv' }, pairs.filter((p) => p && p[1] !== null && p[1] !== undefined && p[1] !== '').flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', null, v)]));
  const sec = (title, extra) => h('h3', null, [title].concat(extra || []));
  const fold = (title, count, content, open) => h('details', { class: 'detail-fold', open: !!open }, [
    h('summary', null, [title, count == null ? null : V.chip(String(count))]),
    content,
  ]);
  const vlanText = (ids) => (ids && ids.length ? S.check.fmtVlans(ids) : '—');

  function findingsBlock(App, list) {
    if (!list.length) return null;
    const seen = new Set(); const uniq = list.filter((f) => (seen.has(f) ? false : seen.add(f)));
    const order = { error: 0, warn: 1, info: 2 };
    uniq.sort((a, b) => order[a.severity] - order[b.severity]);
    return h('div', null, [sec('檢查結果', [V.chip(String(uniq.length))]), ...uniq.map((f) => h('div', { class: 'finding' }, [
      h('span', { style: { marginTop: '4px' } }, V.sevDot(f.severity)),
      h('div', null, [h('div', null, [h('b', null, f.title)]), h('div', null, f.message),
        f.evidence.length ? h('div', { class: 'ev' }, f.evidence.slice(0, 3).map((e) => h('a', { class: 'link mono', style: { marginRight: '10px' }, onclick: () => App.openRaw(e.file, e.line) }, `原文 第 ${e.line} 行`))) : null]),
    ]))]);
  }
  function sourcesBlock(App, src, title) {
    if (!src || !src.length) return null;
    return h('div', null, [sec(title || '來源'), h('div', null, src.map(([b, line]) => {
      const blk = App.Q.block(b);
      return h('div', null, h('a', { class: 'link mono', onclick: () => App.openRaw(blk.file, line) }, `${blk.devKey || '?'}｜${blk.command || '（未標記指令）'}｜第 ${line} 行`));
    }))]);
  }

  // ---------------------------------------------------------------- 總覽
  function overview(App) {
    const m = App.snap.meta; const st = m.stats; const C = App.Q.inventory().counts;
    return h('div', { class: 'detail' }, [
      h('h2', null, '總覽'),
      kv([['建立時間', V.fmtTime(m.createdAt)], ['輸入指紋', h('span', { class: 'mono' }, m.inputHash)], ['命名規則', m.profile ? `${m.profile.id} v${m.profile.version}` : '未套用'],
        ['來源', m.sources.map((s) => `${s.name}（${V.num(s.bytes)} 字元）`).join('、')]]),
      sec('內容'),
      kv([['設備', `${V.num(st.devices)}（已收集 ${V.num(st.collected)}）`], ['介面', V.num(st.interfaces)], ['連結', V.num(st.links)], ['VLAN 定義', V.num(st.vlans)],
        ['MAC', V.num(st.macs)], ['末端 MAC 位置（含 Wi-Fi 漫遊觀察）', V.num(C.endpoints)], ['IP（ARP）', V.num(C.arpIps)], ['路由', V.num(st.routes)]]),
      sec('檢查結果'),
      h('div', { class: 'row' }, [V.chip(`錯誤 ${st.findings.error}`, 'err'), V.chip(`警告 ${st.findings.warn}`, 'warn'), V.chip(`提醒 ${st.findings.info}`, 'info')]),
      sec('解析器使用量'),
      V.table([{ t: '解析器', f: (r) => (S.adapters[r[0]] ? S.adapters[r[0]].label : r[0]) }, { t: '事實數', f: (r) => V.num(r[1]) }], Object.entries(m.adapters)),
      h('p', { class: 'muted' }, '點選圖上的設備或連線、左側的檢查結果，或使用上方搜尋（設備、MAC、IP、VLAN）。'),
    ]);
  }

  // ---------------------------------------------------------------- 未知對端（沒有 LLDP／CDP 介面鄰接的末端埠）
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
      h('h2', null, [devLink(App, sel.dev), ' 的末端 MAC 位置']),
      h('div', { class: 'row' }, [V.chip(`${rows.length} 個末端埠`), V.chip(`${macs + wifi.length} 個末端 MAC 位置`),
        wifi.length ? V.chip(`${wifi.length} 個 Wi-Fi MAC 位置`, 'info') : null,
        multi ? V.chip(`${multi} 個末端埠有多個 MAC`, 'warn') : null,
        rows.length + wifi.length > 1 ? h('button', { onclick: () => App.toggleExpand(sel.dev) }, collapsed ? '在圖上展開' : (App.expanded.has(sel.dev) ? '在圖上收合' : '（已全部展開）')) : null]),
      h('p', { class: 'muted' }, '一般末端埠只學到一個 MAC，且沒有 LLDP／CDP 介面鄰接。Wi-Fi 是一對多介面：每個觀察到的 MAC 位置會列入末端清單，但不把 Wi-Fi 介面判為末端，也不參與 A02，因為 MAC 可能隨用戶漫遊而移動。MNDP 只代表同一 L2 網域可達，不算直連鄰接。'),
      rows.length ? h('div', null, [sec('末端埠'), unknownTable(App, rows)]) : null,
      wifi.length ? h('div', null, [sec('Wi-Fi MAC 觀察（列入末端清單，不參與 A02）'), unknownTable(App, wifi, () => false)]) : null,
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
    const rawBlocks = blocksOf(App, d.key);
    const neighborHasFinding = peerRows.some((r) => r.links.some((l) =>
      l.vlanMismatch || Q.findingsFor('link', l.key).some((f) => f.severity !== 'info')));
    return h('div', { class: 'detail' }, [
      h('h2', null, d.label || d.name),
      h('div', { class: 'row' }, [V.kindChip(d.kind), d.collected ? V.chip('已收集', 'ok') : V.chip('未收集（只被其他設備看到）', 'warn'), d.group ? V.chip(d.group) : null, d.role ? V.chip('角色：' + d.role) : null]),
      kv([['管理 IP', d.mgmtIp], ['型號', d.deviceType], ['RouterOS', d.softwareVersion], ['平台', d.manufacturer === 'mikrotik' ? null : d.platform], ['鄰居回報的功能', d.caps], ['類型依據', V.KIND_BASIS[d.kindBasis]],
        ['其他名稱', d.names.length > 1 ? d.names.join('、') : null], ['Router ID', d.routerId],
        ['看到它的設備', d.seenBy.length ? h('span', null, d.seenBy.flatMap((k, i) => [i ? '、' : '', devLink(App, k)])) : null],
        ['收集的資料', d.collected ? h('div', { class: 'chip-list' }, [...(cov ? cov.data : []).map((t) => V.chip(S.check.DATA_LABEL[t] || t, 'ok')), ...(cov ? cov.missing : []).map((t) => V.chip('缺 ' + (S.check.DATA_LABEL[t] || t), 'err'))]) : null]]),
      findingsBlock(App, fl),
      sec('介面', [V.chip(String(ifs.length))]),
      V.table([
        { t: '介面', f: (i) => h('span', { class: 'mono' }, i.name + (i.lag ? ` → ${Q.getInterface(i.lag).name}` : '')), s: (i) => i.name },
        { t: '狀態', f: V.ifcState, s: V.ifcState },
        { t: '描述／IP', f: (i) => [i.desc, ...Q.addressesOf(i.key)].filter(Boolean).join('  '), s: (i) => Q.addressesOf(i.key)[0] || i.desc },
        { t: 'VLAN', f: (i) => h('span', { class: 'vlanlist' }, vlanText(S.util.ifcVlans(i))), s: (i) => vlanText(S.util.ifcVlans(i)) },
        { t: 'MAC', f: (i) => (i.macs.length ? String(i.macs.length) : ''), s: (i) => i.macs.length || null },
      ], ifs.sort((a, b) => S.util.natural(a.name, b.name)), { onRow: (i) => App.select({ type: 'interface', key: i.key }), limit: 300 }),
      vlans.length ? fold('VLAN 定義', vlans.length, h('div', null, [sec('VLAN 定義'), V.table([
        { t: 'ID', f: (v) => (v.id == null ? '?' : String(v.id)) }, { t: '名稱', f: (v) => v.name || '' }, { t: '描述', f: (v) => v.desc || '' }, { t: '成員', f: (v) => String(v.members.length) },
      ], vlans, { onRow: (v) => v.id != null && App.select({ type: 'vlan', key: String(v.id) }) })]), false) : null,
      unk.length ? h('div', null, [sec('沒有 LLDP／CDP 鄰接的埠', [V.chip(String(unk.length)), h('a', { class: 'link', style: { marginLeft: '8px', fontWeight: 400 }, onclick: () => App.select({ type: 'endpoints', dev: d.key }, { focus: true }) }, '在圖上看')]), unknownTable(App, unk)]) : null,
      fold('鄰居', peerRows.length, h('div', null, [sec('鄰居'), peerRows.length ? V.table([
        { t: '本機介面', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? h('span', { class: 'mono' }, r.observations.length ? r.observations.map((o) => o.ifc).join('、') : '對端回報')
          : h('span', { class: 'mono' }, ifName(Q, r.mine)),
        s: (r) => (r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? (r.observations[0] ? r.observations[0].ifc : '') : ifName(Q, r.mine)) },
        { t: '對端', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? Q.devName(K.splitEp(r.other)[0])
          : h('span', null, [Q.devName(K.splitEp(r.other)[0]), h('span', { class: 'mono muted' }, ' ' + ifName(Q, r.other))]),
        s: (r) => Q.devName(K.splitEp(r.other)[0]) },
        { t: '類別', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? 'MNDP・同一 L2 網域可達（非直連確認）'
          : V.protoText(r.l) + '・' + V.CLS[r.l.cls] + (r.l.hearsay ? '・聽說' : '') + (!r.l.verified && !r.l.hearsay ? '・單向' : ''),
        s: (r) => (r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? 'MNDP' : V.protoText(r.l)) },
        { t: 'VLAN', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? '—'
          : (r.l.vlanMismatch ? h('span', { class: 'diffA' }, '不一致') : h('span', { class: 'vlanlist' }, vlanText(r.l.vlansCommon))),
        s: (r) => (r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? null : r.l.vlanMismatch ? '不一致' : vlanText(r.l.vlansCommon)) },
      ], peerRows, { onRow: (r) => App.select({ type: 'link', key: r.l.key }, { focus: true }), bad: (r) => r.links.some((x) => x.vlanMismatch || Q.findingsFor('link', x.key).some((f) => f.severity !== 'info')) }) : h('div', { class: 'muted' }, '沒有連結')]), neighborHasFinding),
      ospfAdjacencies.length ? fold('OSPF L3 鄰接', ospfAdjacencies.length, h('div', null, [
        sec('OSPF L3 鄰接（非實體直連）'),
        V.table([
          { t: '本機介面', f: (a) => epLink(App, a.localEp), s: (a) => K.splitEp(a.localEp)[1] },
          { t: '鄰居', f: (a) => devLink(App, a.peerDev), s: (a) => Q.devName(a.peerDev) },
          { t: '鄰居位址／Router ID', f: (a) => [a.peerIp, a.peerId].filter(Boolean).join('／'), s: (a) => a.peerIp || a.peerId },
          { t: '回報', f: (a) => a.reciprocal ? '雙向 OSPF 鄰接' : '單向 OSPF 觀察', s: (a) => (a.reciprocal ? '雙向' : '單向') },
          { t: '來源', f: (a) => {
            const [block, line] = a.src[0]; const b = Q.block(block);
            return b ? h('a', { class: 'link mono', onclick: () => App.openRaw(b.file, line) }, `${b.file} 第 ${line} 行`) : '';
          } },
        ], ospfAdjacencies),
      ]), false) : null,
      routes.length ? fold('路由表', routes.length, h('div', null, [sec('路由表'), V.table([
        { t: '網段', f: (r) => h('span', { class: 'mono' }, `${r.prefix}/${r.len}`), s: (r) => `${r.prefix}/${r.len}` }, { t: '協定', f: (r) => r.proto, s: (r) => r.proto },
        { t: '下一跳', f: (r) => h('span', { class: 'mono' }, r.nh.map((n) => (n.ip ? n.ip + ' ' : '') + (n.ifc || '')).join('\n')), s: (r) => (r.nh[0] ? r.nh[0].ip || r.nh[0].ifc : '') },
      ], routes, { limit: 200 })]), false) : null,
      rawBlocks ? fold('收集到的原始輸出', App.snap.blocks.filter((b) => b.devKey === d.key).length, rawBlocks, false) : null,
    ]);
  }
  function blocksOf(App, devKey) {
    const bs = App.snap.blocks.filter((b) => b.devKey === devKey);
    if (!bs.length) return null;
    return h('div', null, [sec('收集到的原始輸出'), V.table([
      { t: '指令', f: (b) => b.command || '（未標記）', s: (b) => b.command || '（未標記）' },
      { t: '解析器', f: (b) => (b.adapters.length && !b.empty ? b.adapters.map((a) => S.adapters[a].label).join('、') : h('span', { class: 'diffA' }, '無法辨識')),
        s: (b) => (b.adapters.length && !b.empty ? b.adapters.map((a) => S.adapters[a].label).join('、') : '無法辨識') },
      { t: '行', f: (b) => `${b.start}–${b.end}`, s: (b) => b.start },
    ], bs, { onRow: (b) => App.openRaw(b.file, b.start) })]);
  }
  const ifName = (Q, ep) => { const i = Q.getInterface(ep); return i ? i.name : K.splitEp(ep)[1]; };

  // ---------------------------------------------------------------- 連結
  function link(App, sel) {
    const Q = App.Q; const l = Q.getLink(sel.key);
    if (!l) return h('div', { class: 'empty-detail' }, '基準中沒有這條連結');
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
        : [V.chip(V.CLS[l.cls]), l.verified ? V.chip('雙向確認', 'ok') : l.hearsay ? V.chip('聽說（對端未提供 LLDP）', 'info') : V.chip('單向', 'warn'), ...l.via.map((v) => V.chip(v.toUpperCase()))]),
      domain
        ? kv([['關係', 'MNDP 觀察到的 L2 網域可達性；不代表兩台設備之間存在直連線路。'],
          ['觀察位置', observedAt.length ? observedAt.join('；') : '詳見原始輸出']])
        : kv([['A 端', epLink(App, l.a)], ['B 端', epLink(App, l.b)], ['層級', l.layer === 'l2' ? 'L2（介面鄰接）' : 'L3（路由鄰接）']]),
      l.layer === 'l2' && !domain ? h('div', null, [sec('VLAN'), kv([
        ['兩端都有', h('span', { class: 'vlanlist' }, vlanText(l.vlansCommon))],
        ['只在 A 端', onlyA.length ? h('span', { class: 'vlanlist diffA' }, vlanText(onlyA)) : '—'],
        ['只在 B 端', onlyB.length ? h('span', { class: 'vlanlist diffA' }, vlanText(onlyB)) : '—'],
      ])]) : null,
      findingsBlock(App, fl),
      sourcesBlock(App, l.src),
    ]);
  }
  function pair(App, sel) {
    const Q = App.Q; const links = sel.links.map((k) => Q.getLink(k)).filter(Boolean);
    const [a, b] = sel.devs;
    return h('div', { class: 'detail' }, [
      h('h2', null, [Q.devName(a), ' ⇄ ', Q.devName(b)]),
      h('div', { class: 'row' }, [V.chip(`${links.length} 條連結`)]),
      V.table([
        { t: Q.devName(a), f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? 'MNDP 觀察'
          : h('span', { class: 'mono' }, ifName(Q, K.splitEp(l.a)[0] === a ? l.a : l.b)) },
        { t: Q.devName(b), f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? 'L2 網域可達'
          : h('span', { class: 'mono' }, ifName(Q, K.splitEp(l.a)[0] === a ? l.b : l.a)) },
        { t: '類別', f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? 'MNDP・同一 L2 網域可達（非直連確認）'
          : V.CLS[l.cls] + (l.verified ? '' : l.hearsay ? '・聽說' : '・單向') },
        { t: '協定', f: (l) => V.protoText(l) },
        { t: 'VLAN', f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? '—'
          : (l.vlanMismatch ? h('span', { class: 'diffA' }, '不一致') : h('span', { class: 'vlanlist' }, vlanText(l.vlansCommon))) },
      ], links, { onRow: (l) => App.select({ type: 'link', key: l.key }) }),
      findingsBlock(App, [].concat(...links.map((l) => Q.findingsFor('link', l.key)))),
    ]);
  }

  // ---------------------------------------------------------------- 介面
  function iface(App, sel) {
    const Q = App.Q; const i = Q.getInterface(sel.key);
    if (!i) return h('div', { class: 'empty-detail' }, '基準中沒有這個介面');
    const links = Q.linksOfEp(i.key);
    const macs = i.macs.map((m) => Q.findMac(m));
    return h('div', { class: 'detail' }, [
      h('h2', null, [devLink(App, i.dev), ' ', h('span', { class: 'mono' }, i.name)]),
      h('div', { class: 'row' }, [V.chip(V.ifcState(i), i.status === 'up' ? 'ok' : ''), V.chip((V.theme.endpoint.styleOf(i) || {}).label || V.IFC_TYPE[i.type], '', { title: V.IFC_TYPE_BASIS[i.typeBasis] }), i.hearsay ? V.chip('僅由對端回報', 'info') : null, i.unknownPeer ? V.chip('沒有 LLDP／CDP 鄰接（未知對端）', 'warn') : i.edge ? V.chip('末端埠') : null]),
      kv([['描述', i.desc], ['RouterOS 類型', i.rawType], ['介面 MAC', i.hwMac ? K.macPretty(K.mac(i.hwMac) || i.hwMac) : null], ['預設名稱', i.defaultName && i.defaultName !== i.name ? i.defaultName : null],
        ['MTU', [['mtu', i.mtu], ['actual', i.actualMtu], ['l2mtu', i.l2mtu]].filter((x) => x[1] != null).map((x) => `${x[0]} ${x[1]}`).join('、') || null],
        ['IP', Q.addressesOf(i.key).join('、')], ['埠模式', V.MODE[i.mode]], ['所屬聚合', i.lag ? epLink(App, i.lag) : null], ['所屬 Bridge', i.bridge ? epLink(App, i.bridge) : null],
        ['聚合成員', i.lagMembers.length ? h('span', null, i.lagMembers.flatMap((m, n) => [n ? '、' : '', epLink(App, m)])) : null],
        ['PVID', i.pvid == null ? null : String(i.pvid)], ['Untagged VLAN', i.untaggedVlans.length ? h('span', { class: 'vlanlist' }, vlanText(i.untaggedVlans)) : null],
        ['Tagged VLAN', i.taggedVlans.length ? h('span', { class: 'vlanlist' }, vlanText(i.taggedVlans)) : null], ['無法辨識的 VLAN', i.unresolvedVlans.join('、')],
        ['VLAN 子介面', i.parent ? h('span', null, [epLink(App, i.parent), ` 上的 VLAN ${i.encapVlan}`]) : null]]),
      links.length ? h('div', null, [sec('連結'), ...links.map((l) => h('div', null, L(App,
        l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? `${Q.devName(K.splitEp(l.a)[0] === i.dev ? K.splitEp(l.b)[0] : K.splitEp(l.a)[0])}（MNDP：L2 網域可達，非直連）`
          : `${Q.epName(l.a)} ⇄ ${Q.epName(l.b)}`,
        { type: 'link', key: l.key })))]) : null,
      findingsBlock(App, Q.findingsFor('interface', i.key)),
      macs.length ? h('div', null, [sec('學到的 MAC', [V.chip(String(macs.length))]), V.table([
        { t: 'MAC', f: (m) => macLink(App, m.mac) }, { t: '廠商', f: (m) => m.vendor || '' }, { t: 'IP', f: (m) => m.ips.join(', ') },
      ], macs, { limit: 500 })]) : null,
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
        ['位置（末端埠）', m.edge.length ? h('span', null, m.edge.flatMap((ep, n) => [n ? '、' : '', epLink(App, ep)])) : '—']]),
      findingsBlock(App, Q.findingsFor('mac', m.mac)),
      m.seen.length ? h('div', null, [sec('在哪些介面／VLAN 學到', [V.chip(String(m.seen.length))]), V.table([
        { t: '設備介面', f: (r) => epLink(App, r.ep) }, { t: 'VLAN', f: (r) => r.vlan || '' }, { t: '', f: (r) => (m.edge.includes(r.ep) ? V.chip('末端', 'ok') : V.chip('上行')) },
      ], m.seen)]) : null,
    ]);
  }
  function ip(App, sel) {
    const Q = App.Q; const r = Q.findIp(sel.key);
    const owner = r.owner && !r.owner.endsWith('|') ? r.owner : null; const mgmt = r.owner && r.owner.endsWith('|') ? r.owner.slice(0, -1) : null;
    return h('div', { class: 'detail' }, [
      h('h2', { class: 'mono' }, r.ip),
      kv([['設定在', owner ? epLink(App, owner) : mgmt ? h('span', null, [devLink(App, mgmt), '（管理 IP）']) : '—'],
        ['所屬網段', r.subnets.length ? h('span', null, r.subnets.slice(0, 4).flatMap((s, n) => [n ? '、' : '', `${s.net}/${s.len} @ `, epLink(App, s.ep)])) : '—'],
        ['MAC（ARP）', r.macs.length ? h('span', null, r.macs.flatMap((m, n) => [n ? '、' : '', macLink(App, m)])) : '—'],
        ['位置（末端埠）', r.locations.length ? h('span', null, r.locations.flatMap((x, n) => [n ? '、' : '', epLink(App, x.ep)])) : '—']]),
      h('div', { class: 'row', style: { marginTop: '10px' } }, [h('button', { onclick: () => App.openTrace(r.ip, '') }, '從這個 IP 追蹤路由'), h('button', { onclick: () => App.openTrace('', r.ip) }, '追蹤到這個 IP')]),
      findingsBlock(App, Q.findingsFor('ip', r.ip)),
      r.arps.length ? h('div', null, [sec('ARP 紀錄'), V.table([{ t: '設備', f: (a) => devLink(App, a.dev) }, { t: '介面', f: (a) => a.ifc }, { t: 'MAC', f: (a) => macLink(App, a.mac) }], r.arps)]) : null,
    ]);
  }

  // ---------------------------------------------------------------- VLAN
  function vlan(App, sel) {
    const Q = App.Q; const v = Q.vlan(sel.key);
    const fl = Q.findingsFor('vlan', String(v.id)).concat(...v.partial.map((l) => Q.findingsFor('link', l.key)));
    return h('div', { class: 'detail' }, [
      h('h2', null, 'VLAN ' + v.id),
      h('div', { class: 'row' }, [V.chip(`${v.devices.length} 台設備`), V.chip(`通過 ${v.carry.length} 條連結`, 'ok'), v.partial.length ? V.chip(`${v.partial.length} 條只有一端`, 'err') : null]),
      kv([['名稱', v.names.length ? v.names.join('、') : '—']]),
      h('p', { class: 'muted' }, '圖上：綠色為兩端都有此 VLAN 的連結，紅色為只有一端有。'),
      findingsBlock(App, fl),
      v.partial.length ? h('div', null, [sec('只有一端有此 VLAN 的連結'), ...v.partial.map((l) => h('div', null, L(App, `${Q.epName(l.a)} ⇄ ${Q.epName(l.b)}`, { type: 'link', key: l.key })))]) : null,
      sec('設備'),
      V.table([{ t: '設備', f: (d) => devLink(App, d) }, { t: '名稱', f: (d) => (v.entries.find((e) => e.dev === d) || {}).name || '' }, { t: '成員介面', f: (d) => String((v.entries.find((e) => e.dev === d) || { members: [] }).members.length) }], v.devices),
    ]);
  }

  // ---------------------------------------------------------------- 路由追蹤
  function trace(App, sel) {
    const Q = App.Q; const t = sel.result;
    if (!t.ok) return h('div', { class: 'detail' }, [h('h2', null, '路由追蹤'), h('p', { class: 'diffA' }, t.error)]);
    const END = { reached: '抵達', noroute: '沒有路由', 'unknown-nh': '下一跳不在基準內', loop: '路由迴圈', ttl: 'TTL 用盡' };
    return h('div', { class: 'detail' }, [
      h('h2', { class: 'mono' }, `${t.src} → ${t.dst}`),
      h('div', { class: 'row' }, [t.reached ? V.chip('可抵達', 'ok') : V.chip('無法完整抵達', 'err'), t.hops.some((x) => x.ecmp) ? V.chip('含 ECMP', 'info') : null]),
      kv([['起點', h('span', null, [devLink(App, t.start), '（來源所在網段的閘道）'])]]),
      sec('逐跳'),
      ...t.hops.map((hp) => h('div', { class: 'hop' }, [
        h('div', null, [h('b', null, devLink(App, hp.dev)), h('span', { class: 'mono muted' }, `  ${hp.route}（${hp.proto}）`), hp.ecmp ? V.chip('ECMP', 'info') : null]),
        ...hp.next.map((n) => h('div', { class: 'mono', style: { fontSize: '12px' } }, [`→ ${n.ip || ''} ${n.ifc || ''} `, n.dev ? devLink(App, n.dev) : null, n.note ? h('span', { class: n.status === 'ok' || n.status === 'connected' ? 'muted' : 'diffA' }, '  ' + n.note) : null])),
      ])),
      sec('結果'),
      ...t.ends.map((e) => h('div', { class: 'hop ' + (e.status === 'reached' ? 'end-reached' : 'end-bad') }, [h('b', null, devLink(App, e.dev)), `：${END[e.status] || e.status}`, h('div', { class: 'muted' }, e.note)])),
    ]);
  }

  V.details = { render };
})(globalThis.SSOT = globalThis.SSOT || {});
