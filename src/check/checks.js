/*
 * 一致性檢查：基準可不可信，由這裡回答。
 * 每筆 finding：{ id, severity, title, message, entities:[{type,key}], evidence:[{block,line}] }
 * severity：error（資料互相矛盾）／warn（可能有問題）／info（提醒）
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const LINK_SCOPE = S.LINK_SCOPE;

  const CATALOG = {
    I01: { severity: 'error', cat: '輸入', title: '無法辨識的內容' },
    I02: { severity: 'warn', cat: '輸入', title: '同一設備重複提供同類資料（以後者為準）' },
    C01: { severity: 'info', cat: '覆蓋', title: '網路設備僅由鄰居發現、沒有收集資料' },
    C02: { severity: 'warn', cat: '覆蓋', title: '缺少應收集的資料' },
    K01: { severity: 'warn', cat: '鏈路', title: 'LLDP 單向（對端沒有回報這條鏈路）' },
    K02: { severity: 'error', cat: '鏈路', title: '同一介面對應到多個鄰居' },
    K03: { severity: 'warn', cat: '鏈路', title: '聚合鏈路兩端成員不一致' },
    K04: { severity: 'info', cat: '鏈路', title: '對端回報的埠名稱與本機不同' },
    V01: { severity: 'warn', cat: 'VLAN', title: '鏈路兩端 VLAN 不一致' },
    V04: { severity: 'warn', cat: 'VLAN', title: '鏈路兩端 native VLAN（PVID）不一致' },
    V05: { severity: 'info', cat: 'VLAN', title: 'VLAN 介面沒有任何成員埠（孤立 VLAN）' },
    A01: { severity: 'warn', cat: '位址', title: '同一 IP 對應多個 MAC' },
    A02: { severity: 'warn', cat: '位址', title: '同一 MAC 在同一 VLAN 出現在多個終端埠' },
    A03: { severity: 'info', cat: '位址', title: '介面有學到 MAC 但沒有 LLDP／CDP 鄰接（未知對端）' },
    A04: { severity: 'info', cat: '位址', title: '單一埠學到過多 MAC（可能下掛未管理交換器或 hypervisor）' },
    A05: { severity: 'info', cat: '位址', title: 'ARP 位址不屬於該設備任何直連網段' },
    R01: { severity: 'info', cat: '路由', title: '路由下一跳不屬於任何已知設備' },
    R02: { severity: 'info', cat: '路由', title: 'OSPF 鄰居無法對應到已收集的設備' },
    R03: { severity: 'warn', cat: '路由', title: '路由下一跳形成迴圈' },
    R04: { severity: 'warn', cat: '路由', title: '路由下一跳落入黑洞路由' },
    R05: { severity: 'warn', cat: '路由', title: 'DHCP 網路的閘道不在該網段內' },
  };

  /** 各類設備預期要有的資料（C02），可由 build 選項 expectedData 覆寫。 */
  const EXPECTED = {
    switch: ['lldp', 'config', 'mac'],
    router: ['lldp', 'config', 'route'],
    firewall: ['lldp', 'config', 'route'],
    host: [], unknown: [],
  };
  const DATA_LABEL = {
    lldp: '鄰居', config: '設定', vlans: 'VLAN 成員', mac: 'MAC 表', arp: 'ARP', route: '路由表',
    ospf: 'OSPF', ipaddr: 'IP 位址', ifstatus: '介面狀態', system: '系統資訊', wifireg: 'Wi-Fi 關聯表', stp: 'RSTP 狀態',
  };

  function run(M, ctx) {
    const out = [];
    const add = (id, message, entities, evidence) => {
      const c = CATALOG[id];
      out.push({ id, severity: c.severity, cat: c.cat, title: c.title, message, entities: entities || [], evidence: (evidence || []).slice(0, 6) });
    };
    const name = (devKey) => { const d = M.devices.get(devKey); return d ? S.infer.displayName(d) : devKey; };
    const epName = (ep) => { const [d] = K.splitEp(ep); const i = M.ifcs.get(ep); return name(d) + ' ' + (i ? i.name : K.splitEp(ep)[1]); };

    // ---- 輸入
    ctx.unrecognized.forEach((b) => {
      const why = b.device === null ? '沒有設備標頭'
        : b.empty ? `解析器已辨識（${(b.adapters || []).map((a) => S.adapters[a].label).join('、')}），但解析不出任何內容；RouterOS 的 print 指令請加上 detail without-paging`
          : '沒有任何解析器認得這段內容' + (b.command ? `（指令：${b.command}）` : '');
      add('I01', `${b.origin.file} 第 ${b.origin.startLine}–${b.origin.endLine} 行：${why}`,
        b.device ? [{ type: 'device', key: b.devKey }] : [], [{ block: b.id, line: b.origin.startLine }]);
    });
    ctx.duplicates.forEach((d) => add('I02', `${name(d.dev)} 的「${S.adapters[d.adapter].label}」出現 ${d.blocks.length} 次，採用最後一次`,
      [{ type: 'device', key: d.dev }], d.blocks.map((b) => ({ block: b, line: ctx.blocks[b].origin.startLine }))));

    // ---- 覆蓋
    const expected = Object.assign({}, EXPECTED, ctx.expectedData || {});
    M.devices.forEach((d) => {
      if (!d.collected) {
        if (d.kind === 'host') return; // 主機本來就不在收集範圍
        add('C01', `${name(d.key)}：由 ${Array.from(d.seenBy).map(name).join('、')} 發現`, [{ type: 'device', key: d.key }]);
        return;
      }
      const miss = (expected[d.kind] || []).filter((t) => !d.data.has(t));
      d.missing = miss;
      if (miss.length) add('C02', `${name(d.key)}（${S.KIND_LABEL[d.kind] || d.kind}）缺少：${miss.map((t) => DATA_LABEL[t] || t).join('、')}`, [{ type: 'device', key: d.key }]);
    });

    // ---- 鏈路
    M.notes.k01.forEach((n) => add('K01',
      `${name(n.dev)} ${M.ifcs.get(K.ep(n.dev, n.ifc)).name} 看到 ${name(n.peer)} ${n.peerIfc}，但 ${name(n.peer)} 的 LLDP 沒有回報 ${name(n.dev)}`,
      [{ type: 'link', key: n.link }], [{ block: n.block, line: n.line }]));
    M.notes.k04.forEach((n) => add('K04', `${name(n.dev)} 說對端是「${n.said}」，對端自己的介面是「${n.actual}」`,
      [{ type: 'link', key: n.link }], [{ block: n.block, line: n.line }]));

    const linksByEp = new Map(); const interfaceLinksByEp = new Map();
    M.links.forEach((l) => {
      if (l.layer !== 'l2') return;
      [l.a, l.b].forEach((ep) => {
        S.util.getOr(linksByEp, ep, () => []).push(l);
        if (l.evidenceScope !== LINK_SCOPE.BROADCAST_DOMAIN) S.util.getOr(interfaceLinksByEp, ep, () => []).push(l);
      });
    });
    interfaceLinksByEp.forEach((ls, ep) => {
      if (ls.length < 2) return;
      const peers = ls.map((l) => epName(l.a === ep ? l.b : l.a));
      add('K02', `${epName(ep)} 同時對應到：${peers.join('、')}`,
        [{ type: 'interface', key: ep }].concat(ls.map((l) => ({ type: 'link', key: l.key }))), ls.map((l) => ({ block: l.src[0][0], line: l.src[0][1] })));
    });

    // 聚合：依成員鏈路推出 (A:ae, B:ae) 配對
    const lagPairs = new Map();
    M.links.forEach((l) => {
      if (l.layer !== 'l2' || l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN) return;
      const ia = M.ifcs.get(l.a); const ib = M.ifcs.get(l.b);
      if (!ia || !ib || (!ia.lag && !ib.lag)) return;
      const pa = ia.lag; const pb = ib.lag;
      const key = (pa || l.a + '(單埠)') + '⇄' + (pb || l.b + '(單埠)');
      S.util.getOr(lagPairs, key, () => ({ pa, pb, la: l.a, lb: l.b, links: [] })).links.push(l);
    });
    lagPairs.forEach((p) => {
      const ents = p.links.map((l) => ({ type: 'link', key: l.key }));
      const ev = p.links.map((l) => ({ block: l.src[0][0], line: l.src[0][1] }));
      if (!p.pa || !p.pb) {
        const lagSide = p.pa || p.pb; const other = p.pa ? p.lb : p.la;
        const od = M.devices.get(K.splitEp(other)[0]);
        if (od && od.collected && od.data.has('config')) // 聚合成員關係只來自 export（/interface bonding）
          add('K03', `${epName(lagSide)} 的成員連到 ${epName(other)}，但對端不是聚合介面成員`, ents, ev);
        return;
      }
      const ma = M.ifcs.get(p.pa).lagMembers.size; const mb = M.ifcs.get(p.pb).lagMembers.size;
      if (ma !== mb) add('K03', `${epName(p.pa)} 有 ${ma} 個成員，${epName(p.pb)} 有 ${mb} 個成員（實際連到對方的有 ${p.links.length} 條）`, ents.concat([{ type: 'interface', key: p.pa }, { type: 'interface', key: p.pb }]), ev);
    });

    // ---- VLAN
    M.links.forEach((l) => {
      if (l.layer !== 'l2' || !l.vlanComparable) return;
      if (!l.vlansA.length && !l.vlansB.length) return;
      const sb = new Set(l.vlansB); const sa = new Set(l.vlansA);
      const onlyA = l.vlansA.filter((v) => !sb.has(v)); const onlyB = l.vlansB.filter((v) => !sa.has(v));
      if (!onlyA.length && !onlyB.length) return;
      l.vlanMismatch = true;
      const parts = [];
      if (onlyA.length) parts.push(`只在 ${epName(l.a)}：${fmtVlans(onlyA)}`);
      if (onlyB.length) parts.push(`只在 ${epName(l.b)}：${fmtVlans(onlyB)}`);
      add('V01', parts.join('；'), [{ type: 'link', key: l.key }], [{ block: l.src[0][0], line: l.src[0][1] }]);
    });
    // native VLAN：兩端都有 PVID（聚合成員取所屬聚合介面的）且不同
    const pvidOf = (ep) => { const i = M.ifcs.get(ep); if (!i) return null; if (i.pvid != null) return i.pvid; const p = i.lag && M.ifcs.get(i.lag); return p ? p.pvid : null; };
    const nativeSeen = new Set();
    M.links.forEach((l) => {
      if (l.layer !== 'l2' || !l.vlanComparable) return;
      const pa = pvidOf(l.a); const pb = pvidOf(l.b);
      if (pa == null || pb == null || pa === pb) return;
      const key = [M.ifcs.get(l.a).lag || l.a, M.ifcs.get(l.b).lag || l.b].sort().join('~'); // 聚合的多條成員鏈路只報一次
      if (nativeSeen.has(key)) return; nativeSeen.add(key);
      add('V04', `${epName(l.a)} PVID ${pa}；${epName(l.b)} PVID ${pb}`, [{ type: 'link', key: l.key }], [{ block: l.src[0][0], line: l.src[0][1] }]);
    });
    // 孤立 VLAN：bridge 上的 VLAN 介面，除了 bridge 本身沒有任何成員埠（只在 bridge 有 VLAN 成員資料時判斷，避免 vlan-filtering 關閉時誤報）
    const vlanOf = new Map(); M.vlans.forEach((v) => { if (v.id != null) vlanOf.set(v.dev + '|' + v.id, v); });
    const filtering = new Set(); M.vlans.forEach((v) => v.members.forEach((_, ep) => { const i = M.ifcs.get(ep); if (i && i.type !== 'bridge') filtering.add(v.dev); }));
    M.ifcs.forEach((i) => {
      if (i.type !== 'vlan' || i.encapVlan == null || !i.parent || !filtering.has(i.dev)) return;
      const parent = M.ifcs.get(i.parent); if (!parent || parent.type !== 'bridge') return;
      const v = vlanOf.get(i.dev + '|' + i.encapVlan);
      const ports = v ? Array.from(v.members.keys()).filter((ep) => ep !== i.parent && ep !== i.key) : [];
      if (ports.length) return;
      add('V05', `${epName(i.key)}（VLAN ${i.encapVlan}）在 ${M.ifcs.get(i.parent).name} 上沒有任何成員埠`, [{ type: 'interface', key: i.key }], i.src.slice(0, 1).map(([block, line]) => ({ block, line })));
    });
    // ---- 位址
    const ipMacs = new Map();
    M.arps.forEach((a) => S.util.getOr(ipMacs, a.ip, () => new Map()).set(a.mac, a));
    ipMacs.forEach((macs, ip) => {
      if (macs.size < 2) return;
      add('A01', `${ip} 對應到 ${Array.from(macs.values()).map((a) => `${K.macPretty(a.mac)}（${name(a.dev)}）`).join('、')}`,
        [{ type: 'ip', key: ip }].concat(Array.from(macs.keys()).map((m) => ({ type: 'mac', key: m }))),
        Array.from(macs.values()).map((a) => ({ block: a.block, line: a.line })));
    });

    const edge = edgePorts(M, interfaceLinksByEp);
    M.edge = edge;
    M.macs.forEach((m) => {
      m.edge = Array.from(m.seen.keys()).filter((ep) => edge.has(ep)).sort();
      const edgeByVlan = new Map();
      m.seen.forEach((vlans, ep) => {
        if (!edge.has(ep)) return;
        vlans.forEach((vlan) => S.util.getOr(edgeByVlan, vlan, () => new Set()).add(ep));
      });
      edgeByVlan.forEach((eps, vlan) => {
        if (eps.size < 2) return;
        const locations = Array.from(eps).sort(S.util.natural);
        add('A02', `${K.macPretty(m.mac)} 在 ${vlan ? `VLAN ${vlan}` : 'VLAN 不明'} 的多個終端埠出現：${locations.map(epName).join('、')}`,
          [{ type: 'mac', key: m.mac }].concat(locations.map((ep) => ({ type: 'interface', key: ep }))));
      });
    });
    const edgeByDev = new Map();
    edge.forEach((v, ep) => { if (!v.linked) S.util.getOr(edgeByDev, K.splitEp(ep)[0], () => []).push(ep); });
    edgeByDev.forEach((eps, dev) => {
      eps.sort(S.util.natural);
      const desc = eps.slice(0, 8).map((ep) => `${M.ifcs.get(ep).name}（${M.ifcs.get(ep).macs.size}）`).join('、');
      add('A03', `${name(dev)}：${eps.length} 個介面，${desc}${eps.length > 8 ? '…' : ''}`, [{ type: 'device', key: dev }]);
    });
    manyMacPorts(M, interfaceLinksByEp).forEach(({ ep, n }) => add('A04', `${epName(ep)}：${n} 個 MAC，且沒有 LLDP／CDP 鄰接`, [{ type: 'interface', key: ep }]));
    // ARP 位址不在該設備任何直連網段（只看有介面位址資料的設備）
    const netsOf = new Map();
    M.ifcs.forEach((i) => { if (!i.hearsay) i.ips.forEach((_, c) => { const p = S.ip.parseCidr(c); if (p && p.len < 32) S.util.getOr(netsOf, i.dev, () => []).push(p); }); });
    const strayByDev = new Map();
    M.arps.forEach((a) => {
      const nets = netsOf.get(a.dev); if (!nets) return;
      if (!nets.some((p) => S.ip.inNet(a.ip, p.net, p.len))) S.util.getOr(strayByDev, a.dev, () => []).push(a);
    });
    strayByDev.forEach((list, dev) => add('A05', `${name(dev)}：${list.map((a) => `${a.ip}（${a.ifc}）`).join('、')}`,
      [{ type: 'device', key: dev }].concat(list.map((a) => ({ type: 'ip', key: a.ip }))), list.map((a) => ({ block: a.block, line: a.line }))));

    // ---- 路由
    const owner = new Map();
    M.ifcs.forEach((i) => { if (!i.hearsay) i.ips.forEach((_, c) => owner.set(c.split('/')[0], i.dev)); });
    M.devices.forEach((d) => { if (d.mgmtIp && !owner.has(d.mgmtIp)) owner.set(d.mgmtIp, d.key); });
    const routesByDev = new Map(); M.routes.forEach((r) => S.util.getOr(routesByDev, r.dev, () => []).push(r));
    // 遞迴解析後仍到不了已知設備的下一跳才提醒；經由其他路由最終落在已知設備上的不算
    // 解析不到已知設備時依原因分開回報：迴圈（R03）、落入黑洞（R04）、其他（R01），同一個下一跳只報一種
    const badNh = { R01: new Map(), R03: new Map(), R04: new Map() };
    M.routes.forEach((r) => r.nh.forEach((n) => {
      if (!n.ip) return;
      const res = resolveNextHop(routesByDev.get(r.dev) || [], n.ip, (ip) => owner.get(ip) || null);
      if (res.some((x) => x.status === 'known')) return;
      const id = res.some((x) => x.status === 'loop') ? 'R03' : res.some((x) => x.status === 'blackhole') ? 'R04' : 'R01';
      S.util.getOr(badNh[id], r.dev, () => new Map()).set(n.ip, r);
    }));
    Object.entries(badNh).forEach(([id, byDev]) => byDev.forEach((ips, dev) => add(id, `${name(dev)}：${Array.from(ips.keys()).join('、')}`, [{ type: 'device', key: dev }],
      Array.from(ips.values()).map((r) => ({ block: r.block, line: r.line })))));
    // DHCP 網路的閘道必須在該網段內
    M.dhcpNets.forEach((n) => {
      const p = S.ip.parseCidr(n.network); if (!p) return;
      const bad = n.gateways.filter((g) => S.ip.isIp(g) && !S.ip.inNet(g, p.net, p.len));
      if (bad.length) add('R05', `${name(n.dev)}：${n.network} 的閘道 ${bad.join('、')} 不在網段內`, [{ type: 'device', key: n.dev }], [{ block: n.block, line: n.line }]);
    });
    M.notes.r02.forEach((n) => add('R02', `${name(n.dev)} ${n.ifc} 的鄰居 ${n.nbrId}（${n.nbrAddr}）`,
      [{ type: 'device', key: n.dev }, { type: 'device', key: K.dev(n.nbrId) }], [{ block: n.block, line: n.line }]));

    const order = { error: 0, warn: 1, info: 2 };
    out.sort((a, b) => order[a.severity] - order[b.severity] || S.util.cmp(a.id, b.id) || S.util.natural(a.message, b.message));
    return out;
  }

  /**
   * 終端埠：已收集設備上、恰好學到一個 MAC、非 Wi-Fi、狀態不是 down 的介面，
   * 且沒有連到其他「已收集的網路設備」（連到主機或未收集設備的埠仍算終端）。
   * linksByEp 僅包含介面鄰接證據；廣播網域（MNDP）可達不代表該埠有 LLDP／CDP 鄰接。
   * 回傳 Map(ep → { linked: 是否有任何 LLDP／CDP 鄰接 })
   */
  const NON_EDGE_TYPES = new Set(['bridge', 'vlan', 'loopback', 'vrrp']);
  function edgePorts(M, adjacencyLinksByEp) {
    const out = new Map();
    const toInfra = (ep) => (adjacencyLinksByEp.get(ep) || []).some((l) => {
      const peer = M.devices.get(K.splitEp(l.a === ep ? l.b : l.a)[0]);
      return peer && peer.collected && peer.kind !== 'host';
    });
    const hasAdjacency = (ep) => adjacencyLinksByEp.has(ep);
    // 設備自己的介面 MAC（/interface print 的 mac-address）出現在轉發表時不是外部終端
    const ownMacs = new Map();
    M.ifcs.forEach((i) => { const m = i.hwMac && K.mac(i.hwMac); if (m) { if (!ownMacs.has(i.dev)) ownMacs.set(i.dev, new Set()); ownMacs.get(i.dev).add(m); } });
    M.ifcs.forEach((i, ep) => {
      // 有 RouterOS 原始 type 時依事實排除虛擬介面；無介面資料才退回名稱推論
      const virtual = i.rawType ? NON_EDGE_TYPES.has(i.rawType) : /^(irb|vlan|lo\d)/.test(i.name);
      if (i.macs.size !== 1 || i.type === 'wireless' || i.status === 'down' || i.enabled === false || virtual) return;
      if (!M.devices.get(i.dev).collected) return;
      const own = ownMacs.get(i.dev);
      if (own && own.has(Array.from(i.macs)[0])) return;
      const group = [ep];
      if (i.lag) { const p = M.ifcs.get(i.lag); if (p) group.push(p.key, ...p.lagMembers); }
      group.push(...i.lagMembers);
      if (group.some(toInfra)) return;
      out.set(ep, { linked: group.some(hasAdjacency) });
    });
    return out;
  }

  /**
   * 單一埠學到過多 MAC：已收集設備上的有線、非虛擬、非中斷介面，學到超過 MANY_MACS 個外部 MAC，
   * 且本身（含所屬聚合與成員）沒有任何 LLDP／CDP 介面鄰接，通常是下掛未管理交換器或 hypervisor。
   */
  const MANY_MACS = 5; // 規格書建議的門檻
  function manyMacPorts(M, adjacencyLinksByEp) {
    const ownMacs = new Map();
    M.ifcs.forEach((i) => { const m = i.hwMac && K.mac(i.hwMac); if (m) S.util.getOr(ownMacs, i.dev, () => new Set()).add(m); });
    const out = [];
    M.ifcs.forEach((i, ep) => {
      const virtual = i.rawType ? NON_EDGE_TYPES.has(i.rawType) : /^(irb|vlan|lo\d|bridge)/.test(i.name);
      if (virtual || i.type === 'wireless' || i.type === 'bridge' || i.type === 'lag' || i.status === 'down' || i.enabled === false) return;
      if (!M.devices.get(i.dev).collected) return;
      const own = ownMacs.get(i.dev) || new Set();
      const n = Array.from(i.macs).filter((m) => !own.has(m)).length;
      if (n <= MANY_MACS) return;
      const group = [ep];
      if (i.lag) { const p = M.ifcs.get(i.lag); if (p) group.push(p.key, ...p.lagMembers); }
      if (group.some((x) => adjacencyLinksByEp.has(x))) return;
      if (group.some((x) => M.behindAnchors && M.behindAnchors.has(x))) return; // 下面接的是已知的未收集交換器（例如 SwOS），不是不明設備
      out.push({ ep, n });
    });
    return out.sort((a, b) => S.util.natural(a.ep, b.ep));
  }

  function fmtVlans(ids) {
    const out = []; let s = null; let p = null;
    ids.forEach((v) => { if (s === null) { s = p = v; } else if (v === p + 1) { p = v; } else { out.push(s === p ? s : s + '-' + p); s = p = v; } });
    if (s !== null) out.push(s === p ? s : s + '-' + p);
    return out.join(',');
  }

  function coverage(M) {
    const linkCount = new Map();
    M.links.forEach((l) => [l.a, l.b].forEach((ep) => { const d = K.splitEp(ep)[0]; linkCount.set(d, (linkCount.get(d) || 0) + 1); }));
    const ifCount = new Map(); const macCount = new Map();
    M.ifcs.forEach((i) => { ifCount.set(i.dev, (ifCount.get(i.dev) || 0) + 1); macCount.set(i.dev, (macCount.get(i.dev) || 0) + i.macs.size); });
    return Array.from(M.devices.values()).map((d) => ({
      dev: d.key, collected: d.collected, kind: d.kind, data: Array.from(d.data).sort(), missing: d.missing || [],
      interfaces: ifCount.get(d.key) || 0, links: linkCount.get(d.key) || 0, macs: macCount.get(d.key) || 0,
    })).sort((a, b) => S.util.natural(a.dev, b.dev));
  }

  /**
   * 遞迴下一跳解析（RouterOS 的 gateway 可以是要再查路由才能到的位址，例如對端的 loopback）。
   * 先看 ip 是否為已知設備位址；否則在同一台設備的路由表以最長前綴找出它的下一跳，再往下解析。
   * routes：該設備的路由（{ prefix, len, nh }）；ownerOf(ip)：回傳擁有該 IP 的設備 key 或 null。
   * 回傳（ECMP 可有多筆）：{ status: 'known', owner, ip, chain } | { status: 'connected', ip, ifc, chain }
   *   | { status: 'unresolved', ip, chain }（沒有路由可到）| { status: 'loop', ip, chain } | { status: 'blackhole', ip, chain, route }；chain 是經過的位址。
   */
  function resolveNextHop(routes, ip, ownerOf) {
    const MAX_DEPTH = 8; // RouterOS 遞迴路由的實務深度遠小於此；超過視為迴圈
    const walk = (cur, chain, used) => {
      const owner = ownerOf(cur);
      if (owner) return [{ status: 'known', owner, ip: cur, chain }];
      if (chain.length > MAX_DEPTH) return [{ status: 'loop', ip: cur, chain }];
      let best = -1; let cands = [];
      routes.forEach((r) => {
        if (used.has(r) || !S.ip.inNet(cur, r.prefix, r.len)) return;
        if (r.len > best) { best = r.len; cands = [r]; } else if (r.len === best) cands.push(r);
      });
      if (!cands.length) return [{ status: 'unresolved', ip: cur, chain }];
      if (cands.every((r) => r.blackhole)) return [{ status: 'blackhole', ip: cur, chain, route: `${cands[0].prefix}/${cands[0].len}` }];
      const out = [];
      cands.forEach((r) => r.nh.forEach((n) => {
        const nextUsed = new Set(used).add(r);
        if (!n.ip) out.push({ status: 'connected', ip: cur, ifc: n.ifc, chain });
        // 閘道只能靠涵蓋它自己的這條路由解析（例如預設路由的閘道不在任何直連網段）：無法到達，不是迴圈
        else if (n.ip === cur) out.push({ status: 'unresolved', ip: cur, chain });
        else if (chain.includes(n.ip)) out.push({ status: 'loop', ip: n.ip, chain });
        else out.push(...walk(n.ip, chain.concat(n.ip), nextUsed));
      }));
      return out;
    };
    return walk(ip, [ip], new Set());
  }

  S.check = { run, coverage, CATALOG, EXPECTED, DATA_LABEL, fmtVlans, resolveNextHop };
})(globalThis.SSOT = globalThis.SSOT || {});
