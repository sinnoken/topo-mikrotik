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
    C02: { severity: 'warn', cat: '覆蓋', title: '缺少應收集的資料', evidenceLimit: Infinity }, // 列出全部失敗註解與已收集區塊，才能對照收了哪些
    K01: { severity: 'warn', cat: '鏈路', title: 'LLDP 單向（對端沒有回報這條鏈路）', data: [['lldp']] },
    K02: { severity: 'warn', cat: '鏈路', title: '同一介面對應到多個鄰居', data: [['lldp']] },
    K03: { severity: 'warn', cat: '鏈路', title: '聚合鏈路兩端成員不一致', data: [['lldp'], ['config']] },
    K04: { severity: 'info', cat: '鏈路', title: '對端回報的埠名稱與本機不同', data: [['lldp']] },
    V01: { severity: 'warn', cat: 'VLAN', title: '鏈路兩端 VLAN 不一致', data: [['lldp'], ['config', 'vlans']] },
    V04: { severity: 'warn', cat: 'VLAN', title: '鏈路兩端 native VLAN（PVID）不一致', data: [['lldp'], ['config']] },
    V05: { severity: 'info', cat: 'VLAN', title: 'VLAN 介面沒有任何成員埠（孤立 VLAN）', data: [['config', 'vlans']] },
    V06: { severity: 'warn', cat: 'VLAN', title: '鏈路兩端同一 VLAN 的 tagged／untagged 不一致', data: [['lldp'], ['config', 'vlans']] },
    A01: { severity: 'warn', cat: '位址', title: '同一 IP 對應多個 MAC', data: [['arp']] },
    A02: { severity: 'warn', cat: '位址', title: '同一 MAC 在同一 VLAN 出現在多個終端埠', data: [['mac']] },
    A03: { severity: 'info', cat: '位址', title: '介面有學到 MAC 但沒有 LLDP／CDP 鄰接（未知對端）', data: [['mac']] },
    A04: { severity: 'info', cat: '位址', title: '單一埠學到過多 MAC（可能下掛未管理交換器或 hypervisor）', data: [['mac']] },
    A05: { severity: 'info', cat: '位址', title: 'ARP 位址不屬於該設備任何直連網段', data: [['arp'], ['config', 'ipaddr']] },
    R01: { severity: 'info', cat: '路由', title: '路由下一跳不屬於任何已知設備', data: [['route']] },
    R02: { severity: 'info', cat: '路由', title: 'OSPF 鄰居無法對應到已收集的設備', data: [['ospf']] },
    R03: { severity: 'warn', cat: '路由', title: '路由下一跳形成迴圈', data: [['route']] },
    R04: { severity: 'warn', cat: '路由', title: '路由下一跳落入黑洞路由', data: [['route']] },
    R05: { severity: 'warn', cat: '路由', title: 'DHCP 網路的閘道不在該網段內', data: [['config']] },
    F01: { severity: 'warn', cat: '防火牆', title: '規則被前面的規則完全遮蔽，永遠不會命中', data: [['config']] },
    F02: { severity: 'info', cat: '防火牆', title: '重複的規則（比對條件與動作相同）', data: [['config']] },
    F03: { severity: 'warn', cat: '防火牆', title: 'WAN 可主動建立新連線的放行規則', data: [['config']] },
    F04: { severity: 'info', cat: '防火牆', title: 'WAN 可連入的 dst-nat（連接埠轉送）', data: [['config']] },
    F05: { severity: 'warn', cat: '防火牆', title: 'IPv6 forward 放行只限目的埠、沒有限目的位址', data: [['config']] },
    F06: { severity: 'warn', cat: '防火牆', title: '以固定來源埠放行', data: [['config']] },
    F07: { severity: 'warn', cat: '防火牆', title: '管理服務沒有限制來源位址，且 WAN 可以連入', data: [['config']] },
    F08: { severity: 'info', cat: '防火牆', title: '無法判斷 WAN 介面（WAN 相關的防火牆檢查未執行）', data: [['config']] },
  };

  /** 每筆 finding 預設最多附幾筆證據；規則可用 CATALOG 的 evidenceLimit 覆寫。 */
  const EVIDENCE_LIMIT = 6;

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
      out.push({ id, severity: c.severity, cat: c.cat, title: c.title, message, entities: entities || [], evidence: (evidence || []).slice(0, c.evidenceLimit ?? EVIDENCE_LIMIT) });
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
    // 收集器註解（readers/common.js）格式或位置不對：不能確定收集時間或失敗原因，列為無法辨識
    const ISSUE = {
      'collected-at-invalid': (x) => `收集時間「${x.text}」不是 UTC ISO 8601 格式（應為 2026-10-24T03:00:00Z 這種秒精度的 UTC 時間）`,
      'collected-at-misplaced': (x) => `收集時間「${x.text}」不在指令標記的下一行，無法判斷屬於哪個指令`,
      'failure-duplicate': (x) => `同一段指令輸出有第二個收集失敗註解「${x.text}」，採用第一個`,
    };
    ctx.blocks.forEach((b) => (b.issues || []).forEach((x) => add('I01', `${b.origin.file} 第 ${x.line} 行：${ISSUE[x.kind](x)}`,
      b.devKey ? [{ type: 'device', key: b.devKey }] : [], [{ block: b.id, line: x.line }])));
    ctx.duplicates.forEach((d) => add('I02', `${name(d.dev)} 的「${S.adapters[d.adapter].label}」出現 ${d.blocks.length} 次，採用最後一次`,
      [{ type: 'device', key: d.dev }], d.blocks.map((b) => ({ block: b, line: ctx.blocks[b].origin.startLine }))));

    // ---- 覆蓋
    const expected = Object.assign({}, EXPECTED, ctx.expectedData || {});
    // C02 的證據：該設備在輸入中的各區塊（依輸入順序），可對照實際收集了哪些指令
    const blocksOf = new Map();
    ctx.blocks.forEach((b) => { if (b.devKey) S.util.getOr(blocksOf, b.devKey, () => []).push({ block: b.id, line: b.origin.startLine }); });
    const failed = failuresByDev(ctx.blocks);
    // C01 的證據：發現這台設備的鄰居資料與 OSPF 鄰居資料那幾行（依輸入順序）
    const sightings = new Map();
    M.claims.forEach((c) => S.util.getOr(sightings, c.peer, () => []).push({ block: c.block, line: c.line }));
    M.ospfAdjacencies.forEach((a) => S.util.getOr(sightings, a.peerDev, () => []).push({ block: a.block, line: a.line }));
    sightings.forEach((list) => list.sort((a, b) => a.block - b.block || a.line - b.line));
    M.devices.forEach((d) => {
      if (!d.collected) {
        if (d.kind === 'host') return; // 主機本來就不在收集範圍
        add('C01', `${name(d.key)}：由 ${Array.from(d.seenBy).map(name).join('、')} 發現`, [{ type: 'device', key: d.key }], sightings.get(d.key));
        return;
      }
      const miss = missingData(d, expected);
      const fails = failed.get(d.key) || [];
      if (!miss.length && !fails.length) return;
      // 「沒收集」列在缺少；「收集了但失敗」另列指令與原因（輸出可能不完整，即使解析出部分資料也要提醒）
      const parts = [];
      if (miss.length) parts.push(`缺少：${miss.map((t) => DATA_LABEL[t] || t).join('、')}`);
      if (fails.length) parts.push(`收集失敗：${fails.map((x) => `${x.command || '連線'}（${x.text}）`).join('、')}`);
      // 證據：失敗註解那幾行在前，再列設備在輸入中的各區塊（依輸入順序）
      const seenEv = new Set();
      const ev = fails.map((x) => ({ block: x.block, line: x.line })).concat(blocksOf.get(d.key) || [])
        .filter((e) => !seenEv.has(e.block + ':' + e.line) && seenEv.add(e.block + ':' + e.line));
      add('C02', `${name(d.key)}（${S.KIND_LABEL[d.kind] || d.kind}）${parts.join('；')}`, [{ type: 'device', key: d.key }], ev);
    });

    // ---- 鏈路
    // K01／K04：依建模時的 LLDP／CDP 配對結果（c.pairing，見 model/build.js）判定
    M.claims.forEach((c) => {
      const p = c.pairing; if (!p) return; // 只有 MNDP 的觀察沒有配對
      if (p.status === 'one-way') add('K01',
        `${name(c.dev)} ${M.ifcs.get(K.ep(c.dev, c.ifc)).name} 看到 ${name(c.peer)} ${c.peerIfc}，但 ${name(c.peer)} 的 LLDP 沒有回報 ${name(c.dev)}`,
        [{ type: 'link', key: p.link }], [{ block: c.block, line: c.line }]);
      // 對端埠名不明（RouterOS 6 沒有 interface-name）時無從比較
      else if (p.status === 'reciprocal' && c.peerIfc !== '?' && K.ifc(c.peerIfc) !== p.remoteIfc) add('K04',
        `${name(c.dev)} 說對端是「${c.peerIfc}」，對端自己的介面是「${p.remoteIfc}」`, [{ type: 'link', key: p.link }], [{ block: c.block, line: c.line }]);
    });

    const interfaceLinksByEp = M.adjacency; // 介面鄰接索引，由 infer.edgeLocations 算出（之後 M.links 不再變動）
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
      if (!l.vlanMismatch) return; // 由 infer.linkVlans 判定
      const sb = new Set(l.vlansB); const sa = new Set(l.vlansA);
      const onlyA = l.vlansA.filter((v) => !sb.has(v)); const onlyB = l.vlansB.filter((v) => !sa.has(v));
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
    // tagged／untagged 不一致：兩端都承載同一個 VLAN（不是 V01），但一端帶標籤、另一端不帶。
    // 邊界：兩端 PVID 都有且不同時，那兩個 PVID 的差異就是 V04 的同一件事，不再列入 V06；其他 VLAN 照常比較。
    const modeSeen = new Set();
    M.links.forEach((l) => {
      if (l.layer !== 'l2' || !l.vlanComparable) return; // vlanComparable 已排除 MNDP、單側觀察與缺 VLAN 資料的一端
      const ma = S.infer.effVlanModes(M, l.a); const mb = S.infer.effVlanModes(M, l.b);
      const pa = pvidOf(l.a); const pb = pvidOf(l.b);
      const skip = new Set(pa != null && pb != null && pa !== pb ? [pa, pb] : []);
      const diff = (x, y) => S.util.numSort(Array.from(x.tagged).filter((v) => y.untagged.has(v) && !y.tagged.has(v) && !x.untagged.has(v) && !skip.has(v)));
      const aTagged = diff(ma, mb); const bTagged = diff(mb, ma);
      if (!aTagged.length && !bTagged.length) return;
      const ea = M.ifcs.get(l.a).lag || l.a; const eb = M.ifcs.get(l.b).lag || l.b;
      const key = [ea, eb].sort().join('~'); // 聚合的多條成員鏈路只報一次，以聚合介面稱呼
      if (modeSeen.has(key)) return; modeSeen.add(key);
      const parts = [];
      if (aTagged.length) parts.push(`VLAN ${fmtVlans(aTagged)} 在 ${epName(ea)} 為 tagged、在 ${epName(eb)} 為 untagged`);
      if (bTagged.length) parts.push(`VLAN ${fmtVlans(bTagged)} 在 ${epName(eb)} 為 tagged、在 ${epName(ea)} 為 untagged`);
      add('V06', parts.join('；'), [{ type: 'link', key: l.key }], [{ block: l.src[0][0], line: l.src[0][1] }]);
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

    const edge = M.edge; // 終端埠是推論，由 infer.edgeLocations 算出
    // MAC 表觀察的來源（每個埠第一次學到的那一行；指定 VLAN 時取該 VLAN 的那一行）
    const toEv = (s) => (s ? { block: s[0], line: s[1] } : null);
    const macSrc = (mac, ep) => toEv(S.model.firstSeenSrc(M.macs.get(mac), ep));
    const macVlanSrc = (m, ep, vlan) => toEv(m.seen.get(ep).get(vlan));
    const byLine = (a, b) => a.block - b.block || a.line - b.line;
    M.macs.forEach((m) => {
      const edgeByVlan = new Map();
      m.seen.forEach((vlans, ep) => {
        if (!edge.has(ep)) return;
        vlans.forEach((_, vlan) => S.util.getOr(edgeByVlan, vlan, () => new Set()).add(ep));
      });
      edgeByVlan.forEach((eps, vlan) => {
        if (eps.size < 2) return;
        const locations = Array.from(eps).sort(S.util.natural);
        add('A02', `${K.macPretty(m.mac)} 在 ${vlan ? `VLAN ${vlan}` : 'VLAN 不明'} 的多個終端埠出現：${locations.map(epName).join('、')}`,
          [{ type: 'mac', key: m.mac }].concat(locations.map((ep) => ({ type: 'interface', key: ep }))),
          locations.map((ep) => macVlanSrc(m, ep, vlan)).filter(Boolean));
      });
    });
    const edgeByDev = new Map();
    edge.forEach((v, ep) => { if (!v.linked) S.util.getOr(edgeByDev, K.splitEp(ep)[0], () => []).push(ep); });
    edgeByDev.forEach((eps, dev) => {
      eps.sort(S.util.natural);
      const desc = eps.slice(0, 8).map((ep) => `${M.ifcs.get(ep).name}（${M.ifcs.get(ep).macs.size}）`).join('、');
      // 終端埠恰好學到一個 MAC：證據是該 MAC 在這個埠的觀察
      add('A03', `${name(dev)}：${eps.length} 個介面，${desc}${eps.length > 8 ? '…' : ''}`, [{ type: 'device', key: dev }],
        eps.map((ep) => macSrc(Array.from(M.ifcs.get(ep).macs)[0], ep)).filter(Boolean));
    });
    manyMacPorts(M, interfaceLinksByEp).forEach(({ ep, n, macs }) => add('A04', `${epName(ep)}：${n} 個 MAC，且沒有 LLDP／CDP 鄰接`, [{ type: 'interface', key: ep }],
      macs.map((mac) => macSrc(mac, ep)).filter(Boolean).sort(byLine)));
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
    // R02：OSPF 鄰居用位址、router-id、管理 IP 都對不到設備（建模時 peerBasis 為 null）
    M.ospfAdjacencies.forEach((a) => { if (!a.peerBasis) add('R02', `${name(a.dev)} ${K.splitEp(a.localEp)[1]} 的鄰居 ${a.peerId}（${a.peerIp}）`,
      [{ type: 'device', key: a.dev }, { type: 'device', key: K.dev(a.peerId) }], [{ block: a.block, line: a.line }]); });

    firewallChecks(M, add, name);

    const order = { error: 0, warn: 1, info: 2 };
    out.sort((a, b) => order[a.severity] - order[b.severity] || S.util.cmp(a.id, b.id) || S.util.natural(a.message, b.message));
    return out;
  }

  /**
   * 單一埠學到過多 MAC：已收集設備上的有線、非虛擬、非中斷介面，學到超過 MANY_MACS 個外部 MAC，
   * 且本身（含所屬聚合與成員）沒有任何 LLDP／CDP 介面鄰接，通常是下掛未管理交換器或 hypervisor。
   */
  const MANY_MACS = 5; // 規格書建議的門檻
  function manyMacPorts(M, adjacencyLinksByEp) {
    const ownMacs = S.infer.hwMacsByDev(M);
    const out = [];
    M.ifcs.forEach((i, ep) => {
      if (S.infer.isVirtualIfc(i) || i.type === 'wireless' || i.type === 'bridge' || i.type === 'lag' || i.status === 'down' || i.enabled === false) return;
      if (!M.devices.get(i.dev).collected) return;
      const own = ownMacs.get(i.dev) || new Set();
      const macs = Array.from(i.macs).filter((m) => !own.has(m)); const n = macs.length;
      if (n <= MANY_MACS) return;
      const group = [ep];
      if (i.lag) { const p = M.ifcs.get(i.lag); if (p) group.push(p.key, ...p.lagMembers); }
      if (group.some((x) => adjacencyLinksByEp.has(x))) return;
      if (group.some((x) => M.behindAnchors && M.behindAnchors.has(x))) return; // 下面接的是已知的未收集交換器（例如 SwOS），不是不明設備
      out.push({ ep, n, macs });
    });
    return out.sort((a, b) => S.util.natural(a.ep, b.ep));
  }

  function fmtVlans(ids) {
    const out = []; let s = null; let p = null;
    ids.forEach((v) => { if (s === null) { s = p = v; } else if (v === p + 1) { p = v; } else { out.push(s === p ? s : s + '-' + p); s = p = v; } });
    if (s !== null) out.push(s === p ? s : s + '-' + p);
    return out.join(',');
  }

  /** 已收集設備依類型應有、但沒有收集到的資料類別（C02 與 coverage 共用）。 */
  function missingData(d, expected) {
    return (expected[d.kind] || []).filter((t) => !d.data.has(t));
  }

  /**
   * 收集失敗的區塊（readers 讀到的「# collection failed」），依設備、輸入順序：
   * { block, line, command（連線失敗為 null）, reason, exitCode, text, dataTypes（該指令對應的資料類別） }
   */
  function failuresByDev(blocks) {
    const out = new Map();
    (blocks || []).forEach((b) => {
      if (!b.failure || !b.devKey) return;
      const dataTypes = S.util.uniq((b.adapters || []).map((a) => S.adapters[a].dataType)).sort();
      S.util.getOr(out, b.devKey, () => []).push({ block: b.id, line: b.failure.line, command: b.command, reason: b.failure.reason, exitCode: b.failure.exitCode, text: b.failure.text, dataTypes });
    });
    return out;
  }

  /** expectedData：build 選項，覆寫 EXPECTED 的部分類型。blocks：讀取的區塊，用來列出收集失敗的指令。 */
  function coverage(M, expectedData, blocks) {
    const failed = failuresByDev(blocks);
    const fwCount = new Map(); M.fw.rules.forEach((r) => fwCount.set(r.dev, (fwCount.get(r.dev) || 0) + 1));
    const expected = Object.assign({}, EXPECTED, expectedData || {});
    const linkCount = new Map();
    M.links.forEach((l) => [l.a, l.b].forEach((ep) => { const d = K.splitEp(ep)[0]; linkCount.set(d, (linkCount.get(d) || 0) + 1); }));
    const ifCount = new Map(); const macCount = new Map();
    M.ifcs.forEach((i) => { ifCount.set(i.dev, (ifCount.get(i.dev) || 0) + 1); macCount.set(i.dev, (macCount.get(i.dev) || 0) + i.macs.size); });
    return Array.from(M.devices.values()).map((d) => ({
      dev: d.key, collected: d.collected, kind: d.kind, data: Array.from(d.data).sort(), missing: d.collected ? missingData(d, expected) : [],
      interfaces: ifCount.get(d.key) || 0, links: linkCount.get(d.key) || 0, macs: macCount.get(d.key) || 0,
      failures: failed.get(d.key) || [],
      // 防火牆：有設定資料的設備才有；wan 是 WAN 分類的狀態（ok／no-wan-list／empty-wan-list）
      firewall: M.fwZones.has(d.key) ? { rules: fwCount.get(d.key) || 0, wan: M.fwZones.get(d.key).status } : null,
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

  // ---------------------------------------------------------------- 防火牆（F01–F08）
  const FAMILY_LABEL = { ip: 'IPv4', ipv6: 'IPv6' };
  /** 規則的簡短說明：動作＋比對條件（正規順序），太長時截斷。 */
  function ruleText(r) {
    const m = S.infer.fw.canonMatch(r.match).map(([k, v]) => `${k}=${v}`).join(' ');
    const t = `${r.action}${r.params['jump-target'] ? '→' + r.params['jump-target'] : ''}${m ? ' ' + m : ''}`;
    return t.length > 120 ? t.slice(0, 117) + '…' : t;
  }
  const ruleWhere = (name, r) => `${name(r.dev)} ${FAMILY_LABEL[r.family]} ${r.table} ${r.chain} 第 ${r.position} 條`;
  const ruleEv = (r) => ({ block: r.block, line: r.line });
  const posVal = (r, k) => (r.match[k] !== undefined && !S.infer.fw.splitNeg(r.match[k]).neg ? S.infer.fw.splitNeg(r.match[k]).body : null);
  const protoOf = (r) => { const p = posVal(r, 'protocol'); return p === null ? null : S.infer.fw.protoName(p); };
  const isIcmp = (r) => protoOf(r) === 'icmp' || protoOf(r) === 'icmpv6';
  /** 只放行既有連線（connection-state 不含 new／untracked）：不是新連線的入口。 */
  const replyOnly = (r) => {
    const v = r.match['connection-state']; if (v === undefined) return false;
    const { neg, body } = S.infer.fw.splitNeg(v); const t = body.split(',');
    return neg ? ['new', 'untracked'].every((x) => t.includes(x)) : !t.includes('new') && !t.includes('untracked');
  };
  /** IPsec 用的放行：ESP、AH，或只限 UDP 500／4500。 */
  const isIpsecRule = (r) => {
    const p = protoOf(r);
    if (p === 'ipsec-esp' || p === 'ipsec-ah') return true;
    if (p !== 'udp' || posVal(r, 'dst-port') === null) return false;
    const v = S.infer.fw.parseVal('dst-port', r.match['dst-port']);
    return v.kind === 'ranges' && v.items.every(([a, b]) => a === b && (a === 500n || a === 4500n));
  };
  /** F05 的對象：IPv6 filter 放行有目的埠、沒有目的位址。 */
  const v6PortOnly = (r) => r.family === 'ipv6' && r.table === 'filter' && r.action === 'accept' && posVal(r, 'dst-port') !== null
    && r.match['dst-address'] === undefined && r.match['dst-address-list'] === undefined && !replyOnly(r);

  function firewallChecks(M, add, name) {
    const fw = S.infer.fw;
    const byDev = new Map(); M.fw.rules.forEach((r) => S.util.getOr(byDev, r.dev, () => []).push(r));
    const chainsOf = (rules) => { const m = new Map(); rules.forEach((r) => S.util.getOr(m, r.family + '|' + r.table + '|' + r.chain, () => []).push(r)); return m; };
    M.fwCtx.forEach((ctx, dev) => {
      const rules = byDev.get(dev) || [];
      const ents = (...rs) => [{ type: 'device', key: dev }].concat(rs.filter(Boolean).map((r) => ({ type: 'rule', key: r.key })));
      // F01／F02：同一 chain 內，前面會終止比對的規則涵蓋後面的規則（只看啟用中的規則）。完全相同（含動作）的是重複（F02），其餘是遮蔽（F01）
      chainsOf(rules).forEach((list) => {
        const on = list.filter((r) => !r.disabled).sort((a, b) => a.position - b.position);
        on.forEach((j, n) => {
          const before = on.slice(0, n);
          const dup = before.find((i) => i.action === j.action && JSON.stringify(i.params) === JSON.stringify(j.params) && fw.sameMatch(i, j));
          if (dup) { add('F02', `${ruleWhere(name, j)}與第 ${dup.position} 條的比對條件與動作相同（${ruleText(j)}）`, ents(j), [ruleEv(j), ruleEv(dup)]); return; }
          const cov = before.find((i) => fw.TERMINAL.has(i.action) && fw.covers(ctx, i, j));
          if (cov) add('F01', `${ruleWhere(name, j)}（${ruleText(j)}）被第 ${cov.position} 條（${ruleText(cov)}）完全涵蓋，永遠不會命中`, ents(j), [ruleEv(j), ruleEv(cov)]);
        });
      });
      const active = rules.filter((r) => !r.disabled && (r.table === 'filter' || (r.table === 'nat' && r.chain === 'dstnat')));
      // F08：有規則但無法判斷 WAN；F03／F04／F05（WAN 部分）／F07 都需要 WAN，不猜
      if (!ctx.wan && active.length) {
        const why = ctx.status === 'no-wan-list' ? '沒有名稱含 WAN 的 interface list' : `WAN 清單（${ctx.wanLists.join('、')}）沒有成員`;
        add('F08', `${name(dev)}：有 ${active.length} 條防火牆規則，但${why}，無法判斷哪些介面對外；F03、F04、F05、F07 未檢查`, [{ type: 'device', key: dev }], [ruleEv(active[0])]);
      }
      const wans = ctx.wan ? Array.from(ctx.wan).sort(S.util.natural) : [];
      const ipsecUp = M.fw.peers.some((p) => p.dev === dev && !p.disabled) || M.fw.policies.some((p) => p.dev === dev && !p.disabled && !p.template);
      const ifcName = (ep) => K.splitEp(ep)[1];
      const viaText = (path) => (path.length ? `；經由 ${path.map((x) => `${x.chain} 第 ${x.position} 條 jump`).join('→')}` : '');
      /** 從 WAN 的任一介面送出符合規則 r 的新連線：第一個由 r 決定的結果（raw prerouting 丟掉的不算），沒有就 null。 */
      const reachedBy = (r, builtins) => {
        for (const ep of wans) {
          for (const b of builtins) {
            const pkt = fw.packetFor(r, ep, b, ctx);
            const raw = fw.evalChain(ctx, r.family, 'raw', 'prerouting', Object.assign({}, pkt, { out: undefined }));
            if (raw.verdict === 'drop') continue;
            const res = r.table === 'nat' ? fw.evalChain(ctx, r.family, 'nat', b, pkt) : fw.evalFilter(ctx, r.family, b, pkt);
            if (res.rule === r) return { ep, res, pkt };
          }
        }
        return null;
      };
      const filterBuiltins = (r) => (r.chain === 'input' || r.chain === 'forward' ? [r.chain] : fw.BUILTIN.filter.includes(r.chain) ? [] : ['input', 'forward']);
      // F06：以固定來源埠放行（事實；output 是設備自己送出的封包，回應既有連線的也不算）
      const f06 = new Set();
      rules.forEach((r) => {
        if (r.disabled || r.table !== 'filter' || r.action !== 'accept' || r.chain === 'output' || posVal(r, 'src-port') === null || replyOnly(r)) return;
        f06.add(r);
        add('F06', `${ruleWhere(name, r)}（${ruleText(r)}）以來源埠 ${r.match['src-port']} 放行：來源埠由對方決定，攻擊者可以用這個來源埠繞過防火牆`, ents(r), [ruleEv(r)]);
      });
      // F05：IPv6 forward 只限目的埠。WAN 已知時要 WAN 的新連線真的會走到這條；不明時只看沒有限制入介面的 forward 規則
      const f05 = new Set();
      rules.forEach((r) => {
        if (r.disabled || !v6PortOnly(r) || f06.has(r) || r.chain === 'input' || r.chain === 'output') return;
        let hit = null;
        if (ctx.wan) { hit = reachedBy(r, ['forward']); if (!hit) return; }
        else if (r.match['in-interface'] !== undefined || r.match['in-interface-list'] !== undefined || r.chain !== 'forward') return;
        f05.add(r);
        const path = hit ? hit.res.path : [];
        add('F05', `${ruleWhere(name, r)}（${ruleText(r)}）只限目的埠、沒有限目的位址：IPv6 沒有 NAT，這些埠對整個網段開放${viaText(path)}`, ents(r, ...path), [ruleEv(r)].concat(path.map(ruleEv)));
      });
      if (!ctx.wan) return;
      // F03：WAN 可主動建立新連線的放行（input／forward，含只被 jump 的子 chain）。排除 ICMP、只放行既有連線、F05／F06 已列的規則
      rules.forEach((r) => {
        if (r.disabled || r.table !== 'filter' || r.action !== 'accept' || r.chain === 'output' || f06.has(r) || f05.has(r) || isIcmp(r) || replyOnly(r)) return;
        const ipsec = isIpsecRule(r);
        if (ipsec && ipsecUp) return; // 有 IPsec peer／policy 時，這些放行是需要的
        const hit = reachedBy(r, filterBuiltins(r)); if (!hit) return;
        add('F03', `${ruleWhere(name, r)}（${ruleText(r)}）讓 WAN（${ifcName(hit.ep)}）可以主動建立新連線${viaText(hit.res.path)}${ipsec ? '；設備沒有 IPsec peer／policy，這條 IPsec 放行可能用不到' : ''}`,
          ents(r, ...hit.res.path), [ruleEv(r)].concat(hit.res.path.map(ruleEv)));
      });
      // F04：WAN 可連入的 dst-nat，且 forward 放行轉送後的連線
      rules.forEach((r) => {
        if (r.disabled || r.table !== 'nat' || r.chain !== 'dstnat' || !/^(dst-nat|netmap)$/.test(r.action)) return;
        const hit = reachedBy(r, ['dstnat']); if (!hit) return;
        const toAddr = r.params['to-addresses'] ? fw.parseVal('dst-address', r.params['to-addresses'].split('-')[0]) : null;
        const toPort = r.params['to-ports'] && /^\d+/.test(r.params['to-ports']) ? +r.params['to-ports'].match(/^\d+/)[0] : hit.pkt.dstPort;
        const fpkt = Object.assign({}, hit.pkt, { out: undefined, natState: 'dstnat', dstPort: toPort, dst: toAddr && toAddr.kind === 'ranges' ? toAddr.items[0][0] : undefined });
        const fres = fw.evalFilter(ctx, r.family, 'forward', fpkt);
        if (fres.verdict !== 'accept') return;
        const by = fres.rule;
        const hairpin = by && by.match['connection-nat-state'] !== undefined && by.match['in-interface'] === undefined && by.match['in-interface-list'] === undefined;
        const port = hit.pkt.dstPort != null ? `${hit.pkt.protocol}/${hit.pkt.dstPort}` : hit.pkt.protocol;
        const to = `${r.params['to-addresses'] || '（未指定位址）'}${r.params['to-ports'] ? ':' + r.params['to-ports'] : ''}`;
        add('F04', `${name(dev)}：WAN（${ifcName(hit.ep)}）的 ${port} 經 dst-nat 轉送到 ${to}，${by ? `forward 第 ${by.position} 條放行` : 'forward 沒有規則擋下'}${hairpin ? '（這條放行沒有限制入介面，可能是 hairpin NAT 需要的；收緊前先確認）' : ''}`,
          ents(r, by), [ruleEv(r)].concat(by ? [ruleEv(by)] : []));
      });
      // F07：管理服務啟用、沒有 available-from，且從 WAN 的新連線會被 input 放行（先看 raw）
      (M.fwServices.get(dev) || []).forEach((sv) => {
        if (!sv.enabled || sv.addresses.length || !sv.port) return;
        for (const ep of wans) {
          const res = fw.evalFilter(ctx, 'ip', 'input', { family: 'ip', in: ep, out: null, protocol: 'tcp', dstPort: sv.port, dst: undefined, state: 'new', natState: null });
          if (res.verdict !== 'accept') continue;
          const ev = sv.src.map(([block, line]) => ({ block, line })).concat(res.rule ? [ruleEv(res.rule)] : [], res.path.map(ruleEv));
          add('F07', `${name(dev)}：${sv.name}（tcp/${sv.port}${sv.basis === 'default' ? '，預設值' : ''}）啟用、沒有限制來源位址（available-from），WAN（${ifcName(ep)}）可以連入：${res.rule ? `${res.rule.chain} 第 ${res.rule.position} 條放行` : 'input 沒有任何規則擋下'}`,
            [{ type: 'device', key: dev }, { type: 'service', key: dev + '|' + sv.name }].concat(res.rule ? [{ type: 'rule', key: res.rule.key }] : []), ev);
          break;
        }
      });
    });
  }

  S.check = { run, coverage, CATALOG, EXPECTED, DATA_LABEL, fmtVlans, resolveNextHop };
})(globalThis.SSOT = globalThis.SSOT || {});
