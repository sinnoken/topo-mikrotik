/*
 * 右側：選中項目的詳細資料。所有內容都從查詢介面（Q）取得，並附上來源（可開啟原文）。
 * 支援：device、link、pair（同兩台設備間多條連結）、interface、mac、ip、vlan、trace、route
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const K = S.keys;

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
    const m = App.snap.meta; const st = m.stats;
    return h('div', { class: 'detail' }, [
      h('h2', null, '基準總覽'),
      kv([['建立時間', V.fmtTime(m.createdAt)], ['輸入指紋', h('span', { class: 'mono' }, m.inputHash)], ['命名規則', m.profile ? `${m.profile.id} v${m.profile.version}` : '未套用'],
        ['來源', m.sources.map((s) => `${s.name}（${V.num(s.bytes)} 字元）`).join('、')]]),
      sec('內容'),
      kv([['設備', `${V.num(st.devices)}（已收集 ${V.num(st.collected)}）`], ['介面', V.num(st.interfaces)], ['連結', V.num(st.links)], ['VLAN 定義', V.num(st.vlans)],
        ['MAC', V.num(st.macs)], ['ARP', V.num(st.arps)], ['路由', V.num(st.routes)]]),
      sec('檢查結果'),
      h('div', { class: 'row' }, [V.chip(`錯誤 ${st.findings.error}`, 'err'), V.chip(`警告 ${st.findings.warn}`, 'warn'), V.chip(`提醒 ${st.findings.info}`, 'info')]),
      sec('解析器使用量'),
      V.table([{ t: '解析器', f: (r) => (S.adapters[r[0]] ? S.adapters[r[0]].label : r[0]) }, { t: '事實數', f: (r) => V.num(r[1]) }], Object.entries(m.adapters)),
      h('p', { class: 'muted' }, '點選圖上的設備或連線、左側的檢查結果，或使用上方搜尋（設備、MAC、IP、VLAN）。'),
    ]);
  }

  // ---------------------------------------------------------------- 未知對端（沒有 LLDP 鄰居的末端埠）
  function unknownTable(App, rows) {
    return V.table([
      { t: '介面', f: (r) => h('span', { class: 'mono' }, r.name) },
      { t: 'MAC', f: (r) => (r.macs.length === 1 ? macLink(App, r.macs[0].mac) : `${r.macs.length} 個 MAC`) },
      { t: 'IP', f: (r) => h('span', { class: 'mono' }, S.util.uniq([].concat(...r.macs.map((m) => m.ips))).slice(0, 3).join(' ')) },
      { t: '廠商', f: (r) => S.util.uniq(r.macs.map((m) => m.vendor).filter(Boolean)).slice(0, 2).join(' / ') },
      { t: 'VLAN', f: (r) => h('span', { class: 'vlanlist' }, vlanText(r.vlans)) },
      { t: '描述', f: (r) => r.desc || '' },
    ], rows, { onRow: (r) => App.select({ type: 'interface', key: r.ep }, { focus: true }), limit: 300, bad: (r) => r.macs.length > 1 });
  }
  function endpoints(App, sel) {
    const Q = App.Q; const rows = Q.unknownPeers(sel.dev); const d = Q.getDevice(sel.dev);
    if (!d) return h('div', { class: 'empty-detail' }, '基準中沒有這台設備');
    const macs = rows.reduce((n, r) => n + r.macs.length, 0); const multi = rows.filter((r) => r.macs.length > 1).length;
    const collapsed = App.virtual.has('?c|' + sel.dev);
    return h('div', { class: 'detail' }, [
      h('h2', null, [devLink(App, sel.dev), ' 的未知對端']),
      h('div', { class: 'row' }, [V.chip(`${rows.length} 個埠`), V.chip(`${macs} 個 MAC`), multi ? V.chip(`${multi} 個埠有多個 MAC`, 'warn') : null,
        rows.length > 1 ? h('button', { onclick: () => App.toggleExpand(sel.dev) }, collapsed ? '在圖上展開' : (App.expanded.has(sel.dev) ? '在圖上收合' : '（已全部展開）')) : null]),
      h('p', { class: 'muted' }, '這些埠有學到 MAC，但設備沒有回報任何 LLDP 鄰居，所以基準裡沒有對端設備。圖上以 MAC、ARP 與廠商資料推論；一個埠有多個 MAC，通常表示後面還接著交換器、AP 或虛擬化主機。'),
      unknownTable(App, rows),
    ]);
  }

  // ---------------------------------------------------------------- 設備
  function device(App, sel) {
    const Q = App.Q; const d = Q.getDevice(sel.key);
    if (!d) return h('div', { class: 'empty-detail' }, '基準中沒有這台設備');
    const links = Q.linksOf(d.key);
    const cov = App.snap.coverage.find((c) => c.dev === d.key);
    const ifs = Q.interfacesOf(d.key).filter((i) => !i.hearsay || !d.collected);
    const fl = Q.findingsFor('device', d.key).concat(...links.map((l) => Q.findingsFor('link', l.key)), ...ifs.map((i) => Q.findingsFor('interface', i.key)));
    const peerRows = links.map((l) => {
      const mine = K.splitEp(l.a)[0] === d.key ? l.a : l.b; const other = Q.peerOf(l, mine);
      return { l, mine, other };
    }).sort((x, y) => S.util.natural(x.mine, y.mine));
    const vlans = Q.vlansOf(d.key); const routes = Q.routesOf(d.key); const unk = Q.unknownPeers(d.key);
    return h('div', { class: 'detail' }, [
      h('h2', null, d.label || d.name),
      h('div', { class: 'row' }, [V.kindChip(d.kind), d.collected ? V.chip('已收集', 'ok') : V.chip('未收集（只被其他設備看到）', 'warn'), d.group ? V.chip(d.group) : null, d.role ? V.chip('角色：' + d.role) : null]),
      kv([['管理 IP', d.mgmtIp], ['型號', d.board], ['RouterOS', d.version], ['平台', d.vendor === 'mikrotik' ? null : d.platform], ['類型依據', V.KIND_BASIS[d.kindBasis]],
        ['其他名稱', d.names.length > 1 ? d.names.join('、') : null], ['Router ID', d.routerId],
        ['看到它的設備', d.seenBy.length ? h('span', null, d.seenBy.flatMap((k, i) => [i ? '、' : '', devLink(App, k)])) : null],
        ['收集的資料', d.collected ? h('span', null, [...(cov ? cov.data : []).map((t) => V.chip(S.check.DATA_LABEL[t] || t, 'ok')), ...(cov ? cov.missing : []).map((t) => V.chip('缺 ' + (S.check.DATA_LABEL[t] || t), 'err'))]) : null]]),
      findingsBlock(App, fl),
      sec('鄰居', [V.chip(String(peerRows.length))]),
      peerRows.length ? V.table([
        { t: '本機介面', f: (r) => h('span', { class: 'mono' }, ifName(Q, r.mine)) },
        { t: '對端', f: (r) => h('span', null, [Q.devName(K.splitEp(r.other)[0]), h('span', { class: 'mono muted' }, ' ' + ifName(Q, r.other))]) },
        { t: '類別', f: (r) => V.CLS[r.l.cls] + (r.l.hearsay ? '・聽說' : '') + (!r.l.verified && !r.l.hearsay ? '・單向' : '') },
        { t: 'VLAN', f: (r) => (r.l.vlanMismatch ? h('span', { class: 'diffA' }, '不一致') : h('span', { class: 'vlanlist' }, vlanText(r.l.vlansCommon))) },
      ], peerRows, { onRow: (r) => App.select({ type: 'link', key: r.l.key }, { focus: true }), bad: (r) => r.l.vlanMismatch || Q.findingsFor('link', r.l.key).some((f) => f.severity !== 'info') }) : h('div', { class: 'muted' }, '沒有連結'),
      unk.length ? h('div', null, [sec('沒有 LLDP 鄰居的埠', [V.chip(String(unk.length)), h('a', { class: 'link', style: { marginLeft: '8px', fontWeight: 400 }, onclick: () => App.select({ type: 'endpoints', dev: d.key }, { focus: true }) }, '在圖上看')]), unknownTable(App, unk)]) : null,
      sec('介面', [V.chip(String(ifs.length))]),
      V.table([
        { t: '介面', f: (i) => h('span', { class: 'mono' }, i.name + (i.parent ? ` → ${i.parent}` : '')) },
        { t: '狀態', f: (i) => (i.admin === 'down' ? '停用' : V.STATUS[i.status]) },
        { t: '描述／IP', f: (i) => [i.desc, ...i.ips].filter(Boolean).join('  ') },
        { t: 'VLAN', f: (i) => h('span', { class: 'vlanlist' }, vlanText(i.vlans)) },
        { t: 'MAC', f: (i) => (i.macs.length ? String(i.macs.length) : '') },
      ], ifs.sort((a, b) => S.util.natural(a.name, b.name)), { onRow: (i) => App.select({ type: 'interface', key: i.key }), limit: 300 }),
      vlans.length ? h('div', null, [sec('VLAN 定義', [V.chip(String(vlans.length))]), V.table([
        { t: 'ID', f: (v) => (v.id == null ? '?' : String(v.id)) }, { t: '名稱', f: (v) => v.name || '' }, { t: '描述', f: (v) => v.desc || '' }, { t: '成員', f: (v) => String(v.members.length) },
      ], vlans, { onRow: (v) => v.id != null && App.select({ type: 'vlan', key: String(v.id) }) })]) : null,
      routes.length ? h('div', null, [sec('路由表', [V.chip(String(routes.length))]), V.table([
        { t: '網段', f: (r) => h('span', { class: 'mono' }, `${r.prefix}/${r.len}`) }, { t: '協定', f: (r) => r.proto },
        { t: '下一跳', f: (r) => h('span', { class: 'mono' }, r.nh.map((n) => (n.ip ? n.ip + ' ' : '') + (n.ifc || '')).join('\n')) },
      ], routes, { limit: 200 })]) : null,
      blocksOf(App, d.key),
    ]);
  }
  function blocksOf(App, devKey) {
    const bs = App.snap.blocks.filter((b) => b.devKey === devKey);
    if (!bs.length) return null;
    return h('div', null, [sec('收集到的原始輸出'), V.table([
      { t: '指令', f: (b) => b.command || '（未標記）' },
      { t: '解析器', f: (b) => (b.adapters.length && !b.empty ? b.adapters.map((a) => S.adapters[a].label).join('、') : h('span', { class: 'diffA' }, '無法辨識')) },
      { t: '行', f: (b) => `${b.start}–${b.end}` },
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
    return h('div', { class: 'detail' }, [
      h('h2', null, [Q.devName(K.splitEp(l.a)[0]), ' ⇄ ', Q.devName(K.splitEp(l.b)[0])]),
      h('div', { class: 'row' }, [V.chip(V.CLS[l.cls]), l.verified ? V.chip('雙向確認', 'ok') : l.hearsay ? V.chip('聽說（對端未提供 LLDP）', 'info') : V.chip('單向', 'warn'), ...l.via.map((v) => V.chip(v.toUpperCase()))]),
      kv([['A 端', epLink(App, l.a)], ['B 端', epLink(App, l.b)], ['層級', l.layer === 'l2' ? 'L2（實體鄰接）' : 'L3（路由鄰接）']]),
      l.layer === 'l2' ? h('div', null, [sec('VLAN'), kv([
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
        { t: Q.devName(a), f: (l) => h('span', { class: 'mono' }, ifName(Q, K.splitEp(l.a)[0] === a ? l.a : l.b)) },
        { t: Q.devName(b), f: (l) => h('span', { class: 'mono' }, ifName(Q, K.splitEp(l.a)[0] === a ? l.b : l.a)) },
        { t: '類別', f: (l) => V.CLS[l.cls] + (l.verified ? '' : l.hearsay ? '・聽說' : '・單向') },
        { t: 'VLAN', f: (l) => (l.vlanMismatch ? h('span', { class: 'diffA' }, '不一致') : h('span', { class: 'vlanlist' }, vlanText(l.vlansCommon))) },
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
      h('div', { class: 'row' }, [V.chip(i.admin === 'down' ? '停用' : V.STATUS[i.status], i.status === 'up' ? 'ok' : ''), V.chip(i.type === 'aggregate' ? '聚合介面' : '實體／邏輯介面'), i.hearsay ? V.chip('僅由對端回報', 'info') : null, i.unknownPeer ? V.chip('沒有 LLDP 鄰居（未知對端）', 'warn') : i.edge ? V.chip('末端埠') : null]),
      kv([['描述', i.desc], ['IP', i.ips.join('、')], ['模式', i.mode], ['所屬聚合', i.parent ? epLink(App, K.ep(i.dev, i.parent)) : null],
        ['成員', i.members.length ? h('span', null, i.members.flatMap((m, n) => [n ? '、' : '', epLink(App, m)])) : null],
        ['VLAN', i.vlans.length ? h('span', { class: 'vlanlist' }, vlanText(i.vlans)) : null], ['未對應的 VLAN 名稱', i.vlanNames.join('、')],
        ['VLAN 子介面', i.sub ? `${i.sub.of} 上的 VLAN ${i.sub.vlan}` : null]]),
      links.length ? h('div', null, [sec('連結'), ...links.map((l) => h('div', null, L(App, `${Q.epName(l.a)} ⇄ ${Q.epName(l.b)}`, { type: 'link', key: l.key })))]) : null,
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
      m.seen.length ? h('div', null, [sec('在哪些介面學到', [V.chip(String(m.seen.length))]), V.table([
        { t: '設備介面', f: (r) => epLink(App, r[0]) }, { t: 'VLAN', f: (r) => r[1] || '' }, { t: '', f: (r) => (m.edge.includes(r[0]) ? V.chip('末端', 'ok') : V.chip('上行')) },
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
      r.arps.length ? h('div', null, [sec('ARP 紀錄'), V.table([{ t: '設備', f: (a) => devLink(App, a.dev) }, { t: '介面', f: (a) => a.ifc + (a.phys ? ` [${a.phys}]` : '') }, { t: 'MAC', f: (a) => macLink(App, a.mac) }], r.arps)]) : null,
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
