/*
 * 一致性檢查：基準可不可信，由這裡回答。
 * 每筆 finding：{ id, severity, title, message, entities:[{type,key}], evidence:[{block,line}] }
 * severity：error（資料互相矛盾）／warn（可能有問題）／info（提醒）
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const LINK_SCOPE = S.LINK_SCOPE;

  /*
   * data：規則需要的資料類別（設備的 data）。外層每一組都要有，組內任一種即可；沒有 data 的規則（輸入、覆蓋）一律會檢查。
   * 只用來區分「通過」與「沒有資料可檢查」，不影響檢查本身。
   */
  const CATALOG = {
    I01: { severity: 'error', cat: '輸入', title: '無法辨識的內容' },
    I02: { severity: 'warn', cat: '輸入', title: '同一設備重複提供同類資料（以後者為準）' },
    C01: { severity: 'info', cat: '覆蓋', title: '網路設備僅由鄰居發現、沒有收集資料' },
    C02: { severity: 'warn', cat: '覆蓋', title: '缺少應收集的資料' },
    K01: { severity: 'warn', cat: '鏈路', title: 'LLDP 單向（對端沒有回報這條鏈路）', data: [['lldp']] },
    K02: { severity: 'error', cat: '鏈路', title: '同一介面對應到多個鄰居', data: [['lldp']] },
    K03: { severity: 'warn', cat: '鏈路', title: '聚合鏈路兩端成員不一致', data: [['lldp'], ['config']] },
    K04: { severity: 'info', cat: '鏈路', title: '對端回報的埠名稱與本機不同', data: [['lldp']] },
    V01: { severity: 'warn', cat: 'VLAN', title: '鏈路兩端 VLAN 不一致', data: [['lldp'], ['config', 'vlans']] },
    V04: { severity: 'warn', cat: 'VLAN', title: '鏈路兩端 native VLAN（PVID）不一致', data: [['lldp'], ['config']] },
    V05: { severity: 'info', cat: 'VLAN', title: 'VLAN 介面沒有任何成員埠（孤立 VLAN）', data: [['config', 'vlans']] },
    V06: { severity: 'info', cat: 'VLAN', title: '同一 VLAN 在不同設備的名稱或說明不同', data: [['config']] },
    V07: { severity: 'warn', cat: 'VLAN', title: '同一名稱在不同設備對應到不同 VLAN', data: [['config']] },
    A01: { severity: 'warn', cat: '位址', title: '同一 IP 對應多個 MAC', data: [['arp']] },
    A02: { severity: 'warn', cat: '位址', title: '同一 MAC 在同一 VLAN 出現在多個終端埠', data: [['mac']] },
    A03: { severity: 'info', cat: '位址', title: '介面有學到 MAC 但沒有 LLDP／CDP 鄰接（未知對端）', data: [['mac']] },
    A04: { severity: 'info', cat: '位址', title: '單一埠學到過多 MAC（可能下掛未管理交換器或 hypervisor）', data: [['mac']] },
    A05: { severity: 'info', cat: '位址', title: 'ARP 位址不屬於該設備任何直連網段', data: [['arp'], ['config', 'ipaddr']] },
    A06: { severity: 'warn', cat: '位址', title: '同一 VLAN 在不同設備設定不同網段', data: [['config']] },
    A07: { severity: 'warn', cat: '位址', title: '同一網段在不同設備屬於不同 VLAN', data: [['config']] },
    A08: { severity: 'warn', cat: '位址', title: '重疊網段在不同設備的遮罩不同', data: [['config', 'ipaddr']] },
    A09: { severity: 'warn', cat: '位址', title: '同一 IP 位址設定在多台設備', data: [['config', 'ipaddr']] },
    A10: { severity: 'warn', cat: '位址', title: '同一名稱在不同設備對應到不同 IP', data: [['config']] },
    A11: { severity: 'info', cat: '位址', title: '同一 IP 在不同設備以不同名稱設定', data: [['config']] },
    A12: { severity: 'warn', cat: '位址', title: '各設備的 DNS／NTP 伺服器設定不同', data: [['config']] },
    R01: { severity: 'info', cat: '路由', title: '路由下一跳不屬於任何已知設備', data: [['route']] },
    R02: { severity: 'info', cat: '路由', title: 'OSPF 鄰居無法對應到已收集的設備', data: [['ospf']] },
    R03: { severity: 'warn', cat: '路由', title: '路由下一跳形成迴圈', data: [['route']] },
    R04: { severity: 'warn', cat: '路由', title: '路由下一跳落入黑洞路由', data: [['route']] },
    R05: { severity: 'warn', cat: '路由', title: 'DHCP 網路的閘道不在該網段內', data: [['config']] },
    R06: { severity: 'warn', cat: '路由', title: '同一 DHCP 網段在不同設備的閘道、DNS 或 NTP 不同', data: [['config']] },
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
    // extra：個別規則附加的欄位（例如跨設備一致性的 deviation），不可覆寫上列共通欄位
    const add = (id, message, entities, evidence, extra) => {
      const c = CATALOG[id];
      const f = { id, severity: c.severity, cat: c.cat, title: c.title, message, entities: entities || [], evidence: (evidence || []).slice(0, 6) };
      Object.keys(extra || {}).forEach((k) => { if (!(k in f)) f[k] = extra[k]; });
      out.push(f);
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

    // 同一個 VLAN ID 只在同一個 VLAN 區塊內比較（A02、V06、A06 共用）；任一位置的設備不在任何區塊時，無從區分，整組比較
    // locations 是位置清單（預設為介面 ep），devOf 取出所在設備；回傳依區塊分開的位置清單
    const vlanSrc = () => ({ vlans: M.vlans.values(), interfaces: M.ifcs.values(), links: M.links.values(), inferred: M.inferred || [], ifc: (ep) => M.ifcs.get(ep), collected: (d) => !!(M.devices.get(d) || {}).collected });
    const spans = new Map();
    const byDomain = (vlan, locations, devOf = (ep) => K.splitEp(ep)[0]) => {
      if (!vlan) return [locations];
      const domains = S.util.getOr(spans, +vlan, () => S.infer.vlanSpan(vlanSrc(), +vlan)).domains;
      const keys = locations.map((x) => (domains.find((d) => d.devices.includes(devOf(x))) || {}).key);
      if (keys.some((k) => !k)) return [locations];
      const parts = new Map(); locations.forEach((x, idx) => S.util.getOr(parts, keys[idx], () => []).push(x));
      return Array.from(parts.values());
    };

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
        byDomain(vlan, Array.from(eps).sort(S.util.natural)).forEach((locations) => {
          if (locations.length < 2) return;
          add('A02', `${K.macPretty(m.mac)} 在 ${vlan ? `VLAN ${vlan}` : 'VLAN 不明'} 的多個終端埠出現：${locations.map(epName).join('、')}`,
            [{ type: 'mac', key: m.mac }].concat(locations.map((ep) => ({ type: 'interface', key: ep }))));
        });
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
    configConsistency(M, add, name, epName, byDomain);
    M.notes.r02.forEach((n) => add('R02', `${name(n.dev)} ${n.ifc} 的鄰居 ${n.nbrId}（${n.nbrAddr}）`,
      [{ type: 'device', key: n.dev }, { type: 'device', key: K.dev(n.nbrId) }], [{ block: n.block, line: n.line }]));

    const order = { error: 0, warn: 1, info: 2 };
    out.sort((a, b) => order[a.severity] - order[b.severity] || S.util.cmp(a.id, b.id) || S.util.natural(a.message, b.message));
    return out;
  }

  /**
   * 跨設備組態一致性：同質不同名（V06、A07、A11）與同名不同值（V07、A06、A08、A09、A10、A12、R06）。
   * 只看已收集設備自己的設定（排除鄰居宣告的介面）；名稱比對 trim＋不分大小寫，值以集合比較（順序不計）。
   * 以 VLAN ID 為鍵的規則（V06、A06）只比同一個 VLAN 區塊；以名稱、網段、IP 為鍵的規則把整份基準視為同一個位址空間（尚無 VRF）。
   * 訊息依設備名稱自然排序，相同設定的設備併成一組。
   * 除 A09（重複 IP 本身就是衝突）外，各規則以多數決推定偏離的設備（推論），寫在訊息尾端與 finding.deviation。
   */
  const MAX_SHOWN = 8; // 訊息中每台設備最多列出的值，避免大型 address-list 讓訊息過長
  function configConsistency(M, add, name, epName, byDomain) {
    const U = S.util; const nat = U.natural;
    const byName = (a, b) => nat(name(a), name(b)) || nat(a, b);
    const norm = (v) => String(v).trim().toLowerCase();
    const ev = (src) => ({ block: src[0], line: src[1] });
    const show = (vals) => { const v = U.uniq(vals).sort(nat); return v.length > MAX_SHOWN ? v.slice(0, MAX_SHOWN).join('、') + `…（共 ${v.length} 個）` : v.join('、'); };
    const quote = (vals) => U.uniq(vals).sort(nat).map((v) => `「${v}」`).join('、');
    const fmtVlanIds = (ids) => 'VLAN ' + U.uniq(ids).sort((a, b) => a - b).join('、');
    const collected = (dev) => !!(M.devices.get(dev) || {}).collected;
    const own = (i) => !i.hearsay && collected(i.dev);

    /**
     * perDev：Map(dev → Map(比對鍵 → 顯示值))。值集合相同的設備併成一組，依第一台設備名稱排序。
     * 回傳 [{ devs, keys, vals }]；只有一組（全部相同）時代表一致。
     */
    const groupDevs = (perDev) => {
      const g = new Map();
      Array.from(perDev.keys()).sort(byName).forEach((dev) => {
        const m = perDev.get(dev); const k = Array.from(m.keys()).sort().join('\u0000');
        U.getOr(g, k, () => ({ devs: [], keys: Array.from(m.keys()), vals: Array.from(m.values()) })).devs.push(dev);
      });
      return Array.from(g.values());
    };
    const devList = (devs) => (devs.length > MAX_SHOWN ? devs.slice(0, MAX_SHOWN).map(name).join('、') + `…（共 ${devs.length} 台）` : devs.map(name).join('、'));
    /**
     * 多數決（推論）：台數最多的一組至少 2 台且多於其他每一組時成立，其餘各組的設備推定偏離。
     * 回傳 { main, deviating: [devKey，依名稱自然排序] }；平手或最多只有 1 台時回傳 null。
     */
    const majorityOf = (groups) => {
      const sorted = groups.slice().sort((a, b) => b.devs.length - a.devs.length);
      const main = sorted[0];
      if (!main || main.devs.length < 2 || (sorted[1] && sorted[1].devs.length >= main.devs.length)) return null;
      return { main, deviating: groups.filter((g) => g !== main).flatMap((g) => g.devs).sort(byName) };
    };
    // 附加在訊息尾端的推定結果與 finding 的 deviation 欄位（平手時 deviating 為空陣列）
    const judge = (groups) => {
      const m = majorityOf(groups);
      return {
        note: m ? `；依多數推定偏離：${devList(m.deviating)}` : '；沒有多數，無法推定',
        extra: { deviation: { basis: 'majority', deviating: m ? m.deviating : [] } },
      };
    };
    const fmtGroups = (groups, fmt) => groups.map((x) => { const v = fmt(x.vals); return devList(x.devs) + (v[0] === '「' ? '' : ' ') + v; }).join('；');
    // 證據最多 6 筆（add() 截斷）：各組輪流取，確保與多數不同的那一組也有來源行
    const interleave = (lists) => { const out = []; for (let k = 0; lists.some((l) => k < l.length); k++) lists.forEach((l) => { if (k < l.length) out.push(l[k]); }); return out; };
    const evByGroups = (groups, items, devOf, srcOf) => interleave(groups.map((g) => items.filter((x) => g.devs.includes(devOf(x))).flatMap(srcOf)));
    const put = (perDev, dev, key, val) => { U.getOr(perDev, dev, () => new Map()); if (!perDev.get(dev).has(key)) perDev.get(dev).set(key, val); };

    // VLAN 介面（/interface vlan）：已收集設備自己的定義
    const vlanIfcs = Array.from(M.ifcs.values()).filter((i) => own(i) && i.type === 'vlan' && i.encapVlan != null).sort((a, b) => byName(a.dev, b.dev) || nat(a.name, b.name));
    const netsOf = (i) => Array.from(i.ips.entries()).map(([c, src]) => ({ p: S.ip.parseCidr(c), src })).filter((x) => x.p && x.p.len < 32);
    const pfx = (p) => `${p.net}/${p.len}`;

    // ---- V06／V07：VLAN 的名稱與說明（三種屬性分開比）
    const vlanAttrs = [];
    vlanIfcs.forEach((i) => {
      vlanAttrs.push({ attr: 'VLAN 介面名稱', id: i.encapVlan, dev: i.dev, val: i.name, ent: { type: 'interface', key: i.key }, src: i.src[0] });
      if (i.desc && i.desc.trim()) vlanAttrs.push({ attr: 'VLAN 介面說明', id: i.encapVlan, dev: i.dev, val: i.desc.trim(), ent: { type: 'interface', key: i.key }, src: i.src[0] });
    });
    Array.from(M.vlans.values()).filter((v) => v.desc && v.desc.trim() && collected(v.dev)).sort((a, b) => byName(a.dev, b.dev) || a.id - b.id)
      .forEach((v) => vlanAttrs.push({ attr: 'bridge VLAN 說明', id: v.id, dev: v.dev, val: v.desc.trim(), ent: { type: 'device', key: v.dev }, src: v.src[0] }));
    const ATTR_ORDER = ['VLAN 介面名稱', 'VLAN 介面說明', 'bridge VLAN 說明'];
    const entsOf = (items, extra) => (extra || []).concat(U.uniq(items.map((x) => x.ent.type + '\u0000' + x.ent.key)).map((k) => { const [type, key] = k.split('\u0000'); return { type, key }; }));
    const evsOf = (items) => items.filter((x) => x.src).map((x) => ev(x.src));

    const attrsById = new Map(); vlanAttrs.forEach((x) => U.getOr(attrsById, x.id, () => []).push(x));
    Array.from(attrsById.keys()).sort((a, b) => a - b).forEach((id) => {
      const items = attrsById.get(id);
      byDomain(id, U.uniq(items.map((x) => x.dev)).sort(byName), (d) => d).forEach((devs) => {
        ATTR_ORDER.forEach((attr) => {
          const sel = items.filter((x) => x.attr === attr && devs.includes(x.dev));
          const perDev = new Map(); sel.forEach((x) => put(perDev, x.dev, norm(x.val), x.val));
          const groups = groupDevs(perDev);
          if (groups.length < 2) return;
          const j = judge(groups);
          add('V06', `VLAN ${id} 的 ${attr}：${fmtGroups(groups, quote)}${j.note}`, entsOf(sel, [{ type: 'vlan', key: String(id) }]), evByGroups(groups, sel, (x) => x.dev, (x) => evsOf([x])), j.extra);
        });
      });
    });
    ATTR_ORDER.forEach((attr) => {
      const byVal = new Map(); vlanAttrs.filter((x) => x.attr === attr).forEach((x) => U.getOr(byVal, norm(x.val), () => []).push(x));
      Array.from(byVal.keys()).sort(nat).forEach((k) => {
        const sel = byVal.get(k);
        const perDev = new Map(); sel.forEach((x) => put(perDev, x.dev, x.id, x.id));
        const groups = groupDevs(perDev);
        if (groups.length < 2) return;
        const ids = U.uniq(sel.map((x) => x.id)).sort((a, b) => a - b);
        const j = judge(groups);
        add('V07', `${attr}「${sel[0].val}」：${fmtGroups(groups, fmtVlanIds)}${j.note}`, entsOf(sel, ids.map((id) => ({ type: 'vlan', key: String(id) }))), evByGroups(groups, sel, (x) => x.dev, (x) => evsOf([x])), j.extra);
      });
    });

    // ---- A06：同一 VLAN（同一區塊）各設備 VLAN 介面上的網段
    const netItems = [];
    vlanIfcs.forEach((i) => netsOf(i).forEach(({ p, src }) => netItems.push({ id: i.encapVlan, dev: i.dev, ep: i.key, p, src })));
    const netsById = new Map(); netItems.forEach((x) => U.getOr(netsById, x.id, () => []).push(x));
    Array.from(netsById.keys()).sort((a, b) => a - b).forEach((id) => {
      const items = netsById.get(id);
      byDomain(id, U.uniq(items.map((x) => x.dev)).sort(byName), (d) => d).forEach((devs) => {
        const sel = items.filter((x) => devs.includes(x.dev));
        const perDev = new Map(); sel.forEach((x) => put(perDev, x.dev, pfx(x.p), pfx(x.p)));
        const groups = groupDevs(perDev);
        if (groups.length < 2) return;
        const mask = sel.some((a) => sel.some((b) => a.dev !== b.dev && a.p.len < b.p.len && S.ip.inNet(b.p.net, a.p.net, a.p.len)));
        const j = judge(groups);
        add('A06', `VLAN ${id}：${fmtGroups(groups, show)}${mask ? '（網段重疊但遮罩不同）' : ''}${j.note}`,
          [{ type: 'vlan', key: String(id) }].concat(U.uniq(sel.map((x) => x.ep)).map((key) => ({ type: 'interface', key }))), evByGroups(groups, sel, (x) => x.dev, (x) => [ev(x.src)]), j.extra);
      });
    });

    // ---- A07：同一網段在不同設備屬於不同 VLAN（只看 VLAN 介面）
    const byNet = new Map(); netItems.forEach((x) => U.getOr(byNet, pfx(x.p), () => []).push(x));
    Array.from(byNet.keys()).sort(nat).forEach((net) => {
      const sel = byNet.get(net);
      const perDev = new Map(); sel.forEach((x) => put(perDev, x.dev, x.id, x.id));
      const groups = groupDevs(perDev);
      if (groups.length < 2) return;
      const j = judge(groups);
      add('A07', `${net}：${fmtGroups(groups, fmtVlanIds)}${j.note}`, U.uniq(sel.map((x) => x.ep)).map((key) => ({ type: 'interface', key })), evByGroups(groups, sel, (x) => x.dev, (x) => [ev(x.src)]), j.extra);
    });

    // ---- A08／A09：所有直連位址（含非 VLAN 介面）
    const ownIfcs = Array.from(M.ifcs.values()).filter(own).sort((a, b) => byName(a.dev, b.dev) || nat(a.name, b.name));
    const prefixes = new Map();
    ownIfcs.forEach((i) => netsOf(i).forEach(({ p, src }) => {
      const e = U.getOr(prefixes, pfx(p), () => ({ key: pfx(p), p, start: S.ip.toInt(p.net), end: S.ip.toInt(p.net) + 2 ** (32 - p.len) - 1, devs: new Map() }));
      if (!e.devs.has(i.dev)) e.devs.set(i.dev, { ep: i.key, src });
    }));
    // CIDR 網段只會互相包含或不相交：依起點排序後，被最外層網段涵蓋的為同一組
    const sorted = Array.from(prefixes.values()).sort((a, b) => a.start - b.start || a.p.len - b.p.len);
    for (let i = 0; i < sorted.length;) {
      const top = sorted[i]; let j = i + 1;
      while (j < sorted.length && sorted[j].start <= top.end) j++;
      const group = sorted.slice(i, j); i = j;
      if (group.length < 2) continue;
      const hit = new Set();
      group.forEach((a) => group.forEach((b) => {
        if (a.p.len >= b.p.len || !S.ip.inNet(b.p.net, a.p.net, a.p.len)) return;
        const da = Array.from(a.devs.keys()); const db = Array.from(b.devs.keys());
        if (da.some((x) => db.some((y) => x !== y))) { hit.add(a); hit.add(b); }
      }));
      if (!hit.size) continue;
      const list = group.filter((x) => hit.has(x));
      const parts = list.map((x) => `${x.key}（${devList(Array.from(x.devs.keys()).sort(byName))}）`);
      const locsBy = list.map((x) => Array.from(x.devs.keys()).sort(byName).map((d) => x.devs.get(d)));
      // 多數決以「設備 → 它設定的這些網段」分組：同一台設定多個網段時，以網段組合當成它的設定值
      const perDev = new Map(); list.forEach((x) => x.devs.forEach((_, d) => put(perDev, d, x.key, x.key)));
      const jd = judge(groupDevs(perDev));
      add('A08', (parts.length === 2 ? parts.join('與 ') : parts.join('、')) + jd.note, locsBy.flat().map((l) => ({ type: 'interface', key: l.ep })), interleave(locsBy).map((l) => ev(l.src)), jd.extra);
    }
    const byIp = new Map();
    ownIfcs.forEach((i) => {
      if (i.rawType === 'vrrp') return; // VRRP 虛擬位址本來就由多台設備共用
      i.ips.forEach((src, c) => { const p = S.ip.parseCidr(c); if (p) U.getOr(U.getOr(byIp, p.ip, () => new Map()), i.dev, () => []).push({ ep: i.key, src }); });
    });
    Array.from(byIp.keys()).sort(nat).forEach((ip) => {
      const perDev = byIp.get(ip); if (perDev.size < 2) return; // 同一台設備重複不在此列
      const locs = Array.from(perDev.keys()).sort(byName).flatMap((d) => perDev.get(d));
      add('A09', `${ip}：${locs.map((l) => epName(l.ep)).join('、')}`, [{ type: 'ip', key: ip }].concat(locs.map((l) => ({ type: 'interface', key: l.ep }))), locs.map((l) => ev(l.src)));
    });

    // ---- R06：同一 DHCP 網段的閘道、DNS、NTP（只比有設定該項的設備）
    const dhcpBy = new Map();
    M.dhcpNets.forEach((n) => { const p = S.ip.parseCidr(n.network); U.getOr(dhcpBy, p ? pfx(p) : norm(n.network), () => []).push(n); });
    Array.from(dhcpBy.keys()).sort(nat).forEach((net) => {
      const nets = dhcpBy.get(net);
      [['閘道', 'gateways'], ['DNS', 'dns'], ['NTP', 'ntp']].forEach(([label, k]) => {
        const sel = nets.filter((n) => n[k] && n[k].length);
        const perDev = new Map(); sel.forEach((n) => n[k].forEach((v) => put(perDev, n.dev, norm(v), v)));
        const groups = groupDevs(perDev);
        if (groups.length < 2) return;
        const j = judge(groups);
        add('R06', `${net} ${label}：${fmtGroups(groups, show)}${j.note}`, U.uniq(sel.map((n) => n.dev)).sort(byName).map((key) => ({ type: 'device', key })), evByGroups(groups, sel, (n) => n.dev, (n) => [{ block: n.block, line: n.line }]), j.extra);
      });
    });

    // ---- A10／A11：名稱 ↔ IP 設定（同一選單內比較）
    const binds = M.ipBinds.filter((b) => collected(b.dev)).sort((a, b) => byName(a.dev, b.dev) || a.line - b.line);
    const byBindName = new Map(); binds.forEach((b) => U.getOr(byBindName, b.section + '\u0000' + b.nameKey, () => []).push(b));
    Array.from(byBindName.keys()).sort(nat).forEach((k) => {
      const sel = byBindName.get(k);
      const perDev = new Map(); sel.forEach((b) => put(perDev, b.dev, b.valueKey, b.value));
      const groups = groupDevs(perDev);
      if (groups.length < 2) return;
      // 不是每台都有的值：依「在哪些設備」分組列出
      const devs = Array.from(perDev.keys());
      const where = new Map();
      const disp = new Map(); sel.forEach((b) => { if (!disp.has(b.valueKey)) disp.set(b.valueKey, b.value); });
      Array.from(disp.keys()).forEach((vk) => {
        const has = devs.filter((d) => perDev.get(d).has(vk)).sort(byName);
        if (has.length < devs.length) U.getOr(where, has.join('\u0000'), () => ({ has, vals: [] })).vals.push(disp.get(vk));
      });
      const diff = Array.from(where.values()).sort((a, b) => nat(U.uniq(a.vals).sort(nat)[0], U.uniq(b.vals).sort(nat)[0]))
        .map((w) => `${show(w.vals)} 只在 ${devList(w.has)}`);
      const j = judge(groups);
      add('A10', `${sel[0].section}「${sel[0].name}」：${fmtGroups(groups, show)}；${diff.join('；')}${j.note}`,
        devs.sort(byName).map((key) => ({ type: 'device', key })), evByGroups(groups, sel, (b) => b.dev, (b) => [{ block: b.block, line: b.line }]), j.extra);
    });
    const byBindValue = new Map(); binds.forEach((b) => U.getOr(byBindValue, b.section + '\u0000' + b.valueKey, () => []).push(b));
    Array.from(byBindValue.keys()).sort(nat).forEach((k) => {
      const sel = byBindValue.get(k);
      const perDev = new Map(); sel.forEach((b) => put(perDev, b.dev, b.nameKey, b.name));
      if (perDev.size < 2) return;
      // 只在兩台設備的名稱完全沒有交集時才列（address-list 某台多加一個清單不算）
      const sets = Array.from(perDev.values());
      const disjoint = sets.some((a, x) => sets.some((b, y) => x < y && !Array.from(a.keys()).some((n) => b.has(n))));
      if (!disjoint) return;
      const groups = groupDevs(perDev);
      const j = judge(groups);
      add('A11', `${sel[0].section} ${sel[0].value}：${fmtGroups(groups, quote)}${j.note}`,
        Array.from(perDev.keys()).sort(byName).map((key) => ({ type: 'device', key })), evByGroups(groups, sel, (b) => b.dev, (b) => [{ block: b.block, line: b.line }]), j.extra);
    });

    // ---- A12：設備層級的 DNS／NTP 伺服器
    const collectedDevs = Array.from(M.devices.values()).filter((d) => d.collected);
    [['DNS 伺服器', 'dnsServers'], ['NTP 伺服器', 'ntpServers']].forEach(([label, k]) => {
      const sel = collectedDevs.filter((d) => d[k] && d[k].values.length);
      const perDev = new Map(); sel.forEach((d) => d[k].values.forEach((v) => put(perDev, d.key, norm(v), v)));
      const groups = groupDevs(perDev);
      if (groups.length < 2) return;
      sel.sort((a, b) => byName(a.key, b.key));
      const j = judge(groups);
      add('A12', `${label}：${fmtGroups(groups, show)}${j.note}`, sel.map((d) => ({ type: 'device', key: d.key })), evByGroups(groups, sel, (d) => d.key, (d) => d[k].src.map(ev)), j.extra);
    });
  }

  /**
   * 終端埠：已收集設備上、恰好學到一個 MAC、非 Wi-Fi、狀態不是 down 的介面，
   * 且沒有連到其他「已收集的網路設備」（連到主機或未收集設備的埠仍算終端），也沒有推論鏈路。
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
    // 已推論接到網路設備（例如底下沒有其他終端的 CSS106，MAC 表只剩它自己）的埠不是終端埠
    const inferredEps = new Set((M.inferred || []).flatMap((r) => [r.a, r.b]));
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
      if (group.some((g) => toInfra(g) || inferredEps.has(g))) return;
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
