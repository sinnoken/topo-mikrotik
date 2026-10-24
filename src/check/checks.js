/*
 * 一致性檢查：基準可不可信，由這裡回答。
 * 每筆 finding：{ id, severity, cat, title, message, entities:[{type,key}], facet?, evidence:[{block,line}], deviation? }
 * facet：同一組 id＋實體可能產生多筆的規則，標示這筆檢查的是哪一個項目（例如 A12 的 dns／ntp），會進入 findingKey。
 *        只有 CATALOG 宣告 facet 的規則才有，而且每筆都有；值只取自設定的項目與正規化後的設定值，不取自訊息、設備名稱或行號。
 * severity：error（資料互相矛盾）／warn（可能有問題）／info（提醒）
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const LINK_SCOPE = S.LINK_SCOPE;

  // 規則目錄（編號、嚴重度、標題、需要的資料、常見原因與處理）在 catalog.js，須先載入
  if (!S.check || !S.check.CATALOG) throw new Error('src/check/catalog.js 必須在 src/check/checks.js 之前載入');
  const CATALOG = S.check.CATALOG;

  /** 每筆 finding 預設最多附幾筆證據；規則可用 CATALOG 的 evidenceLimit 覆寫。 */
  const EVIDENCE_LIMIT = 6;

  /** 各類設備預期要有的資料（C02），可由 build 選項 expectedData 覆寫。 */
  const EXPECTED = {
    switch: ['lldp', 'config', 'mac'],
    router: ['lldp', 'config', 'route'],
    firewall: ['lldp', 'config', 'route'],
    host: [], unknown: [],
  };
  const fmtVlans = S.util.fmtVlans;
  // 資料類別的顯示名稱；畫面透過 S.query.dataLabel 讀取
  const DATA_LABEL = Object.freeze({
    lldp: '鄰居', config: '設定', vlans: 'VLAN 成員', mac: 'MAC 表', arp: 'ARP', route: '路由表',
    ospf: 'OSPF', ipaddr: 'IP 位址', ifstatus: '介面狀態', system: '系統資訊', wifireg: 'Wi-Fi 關聯表', stp: 'RSTP 狀態',
  });

  function run(M, ctx) {
    const out = [];
    // extra：個別規則附加的欄位（例如跨設備一致性的 deviation），不可覆寫上列共通欄位；facet 另外處理（放在 entities 之後）
    // facet 有沒有要和 CATALOG 的宣告一致：規則漏給或多給都是程式錯誤，直接丟錯，不產生 findingKey 不穩定的 finding
    const add = (id, message, entities, evidence, extra) => {
      const c = CATALOG[id];
      const { facet, ...rest } = extra || {};
      if ((c.facet !== undefined) !== (facet !== undefined)) throw new Error(`${id}：${c.facet !== undefined ? 'CATALOG 宣告了 facet，finding 卻沒有' : 'CATALOG 沒有宣告 facet，finding 卻有'}`);
      if (facet !== undefined && (typeof facet !== 'string' || !facet)) throw new Error(`${id}：facet 必須是非空字串，目前是 ${JSON.stringify(facet)}`);
      const f = { id, severity: c.severity, cat: c.cat, title: c.title, message, entities: entities || [] };
      if (facet !== undefined) f.facet = facet;
      f.evidence = (evidence || []).slice(0, c.evidenceLimit ?? EVIDENCE_LIMIT);
      Object.keys(rest).forEach((k) => { if (!(k in f)) f[k] = rest[k]; });
      out.push(f);
    };
    const name = (devKey) => { const d = M.devices.get(devKey); return d ? S.infer.displayName(d) : devKey; };
    const epName = (ep) => { const [d] = K.splitEp(ep); const i = M.ifcs.get(ep); return name(d) + ' ' + (i ? i.name : K.splitEp(ep)[1]); };

    // ---- 輸入
    // 訊息中引用原文時的長度上限（I01 的錯誤訊息、I03 的無法辨識行）
    const clip = (t) => { t = String(t == null ? '' : t).trim(); return t.length > 60 ? t.slice(0, 60) + '…' : t; };
    ctx.unrecognized.forEach((b) => {
      // 整段只有 RouterOS 錯誤訊息：沒有內容是因為指令執行失敗，不是輸出格式不對
      const content = b.lines.filter((l) => l.trim());
      const rosErr = b.device !== null && content.length && content.every(S.adapters.util.rosError);
      const why = b.device === null ? '沒有設備標頭'
        : rosErr ? `指令執行錯誤：${clip(content[0])}${b.command ? `（指令：${b.command}）` : ''}；請確認 RouterOS 版本與已安裝的套件是否支援這個指令，或改用正確的指令重新收集`
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
    // 已解析區塊中認不得的行（adapters.parse）：其餘內容照常進入基準，這幾行沒有；RouterOS 錯誤訊息另外點出，代表輸出可能不完整
    const I03_SAMPLE = 3; // 訊息中列出前幾行的原文
    ctx.blocks.forEach((b) => {
      const ls = b.unrecognizedLines || []; if (!ls.length) return;
      const text = (n) => clip(b.lines[n - b.origin.startLine]);
      const quote = (n) => `第 ${n} 行「${text(n)}」`;
      const errs = ls.filter((n) => S.adapters.util.rosError(b.lines[n - b.origin.startLine]));
      const sample = ls.slice(0, I03_SAMPLE).map(quote).join('、') + (ls.length > I03_SAMPLE ? ' 等' : '');
      const err = errs.length ? `；其中 ${errs.length} 行是 RouterOS 錯誤訊息（${quote(errs[0])}），指令可能沒有完整執行，資料可能不完整` : '';
      add('I03', `${b.origin.file} 第 ${b.origin.startLine}–${b.origin.endLine} 行（${b.command || '沒有指令標記'}）：${ls.length} 行無法辨識，沒有進入基準：${sample}${err}`,
        b.devKey ? [{ type: 'device', key: b.devKey }] : [], ls.map((line) => ({ block: b.id, line })));
    });
    ctx.duplicates.forEach((d) => add('I02', `${name(d.dev)} 的「${S.adapters[d.adapter].label}」出現 ${d.blocks.length} 次，採用最後一次`,
      [{ type: 'device', key: d.dev }], d.blocks.map((b) => ({ block: b, line: ctx.blocks[b].origin.startLine })), { facet: d.adapter }));

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

    // 同一個 VLAN ID 只在同一個 VLAN 區塊內比較（A02、V06、A06 共用）；任一位置的設備不在任何區塊時，無從區分，整組比較
    // locations 是位置清單（預設為介面 ep），devOf 取出所在設備；回傳依區塊分開的位置清單
    const byDomain = (vlan, locations, devOf = (ep) => K.splitEp(ep)[0]) => {
      if (!vlan) return [locations];
      const span = M.vlanSpans.get(+vlan); if (!span) return [locations]; // VLAN 區塊由 infer 算好（vlanDomains）
      const domains = span.domains;
      const keys = locations.map((x) => (domains.find((d) => d.devices.includes(devOf(x))) || {}).key);
      if (keys.some((k) => !k)) return [locations];
      const parts = new Map(); locations.forEach((x, idx) => S.util.getOr(parts, keys[idx], () => []).push(x));
      return Array.from(parts.values());
    };

    // ---- VLAN
    M.links.forEach((l) => {
      if (!l.vlanMismatch) return; // 由 infer.linkVlans 判定：vlansDiff 是計入 V01、只在一端的 VLAN
      const diff = new Set(l.vlansDiff);
      const onlyA = l.vlansA.filter((v) => diff.has(v)); const onlyB = l.vlansB.filter((v) => diff.has(v));
      const parts = [];
      if (onlyA.length) parts.push(`只在 ${epName(l.a)}：${fmtVlans(onlyA)}`);
      if (onlyB.length) parts.push(`只在 ${epName(l.b)}：${fmtVlans(onlyB)}`);
      add('V01', parts.join('；'), [{ type: 'link', key: l.key }], [{ block: l.src[0][0], line: l.src[0][1] }]);
    });
    // native VLAN：兩端都有 PVID（聚合成員取所屬聚合介面的）且不同
    const pvidOf = (ep) => S.infer.effPvid(M, ep);
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
    // 邊界：兩端 PVID 都有且不同時，那兩個 PVID 的差異就是 V04 的同一件事，不再列入 V08；其他 VLAN 照常比較。
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
      add('V08', parts.join('；'), [{ type: 'link', key: l.key }], [{ block: l.src[0][0], line: l.src[0][1] }]);
    });
    // 未過濾的 bridge：一端在未開 vlan-filtering 的 bridge 上（VLAN 原樣轉送，V01／V04／V08 不比較），對端以 tagged 承載 VLAN。
    // 兩端都未過濾、對端沒有 VLAN 資料或只有 untagged 時不報：untagged 訊框經過未過濾的 bridge 不受影響
    const unfSeen = new Set();
    M.links.forEach((l) => {
      if (l.layer !== 'l2' || l.evidenceScope !== LINK_SCOPE.INTERFACE_ADJACENCY || l.hearsay) return;
      const ia = M.ifcs.get(l.a); const ib = M.ifcs.get(l.b);
      if (!ia || !ib || !ia.vlanUnfiltered === !ib.vlanUnfiltered) return;
      const [u, o] = ia.vlanUnfiltered ? [ia, ib] : [ib, ia];
      const od = M.devices.get(o.dev);
      if (!od || !S.infer.VLAN_DATA.some((t) => od.data.has(t))) return;
      const tagged = S.util.numSort(Array.from(S.infer.effVlanModes(M, o.key).tagged));
      if (!tagged.length) return;
      const eu = u.lag || u.key; const eo = o.lag || o.key;
      const key = [eu, eo].sort().join('~'); // 聚合的多條成員鏈路只報一次，以聚合介面稱呼
      if (unfSeen.has(key)) return; unfSeen.add(key);
      const br = S.infer.bridgeOf(M, u.key);
      const ev = [{ block: l.src[0][0], line: l.src[0][1] }].concat(br.vlanFilteringSrc ? [{ block: br.vlanFilteringSrc[0], line: br.vlanFilteringSrc[1] }] : []);
      add('V09', `${epName(eu)} 所在的 ${br.name} 沒有開啟 vlan-filtering，VLAN 原樣轉送、無法比較；${epName(eo)} 以 tagged 承載 VLAN ${fmtVlans(tagged)}`,
        [{ type: 'link', key: l.key }, { type: 'interface', key: br.key }], ev);
    });
    // 孤立 VLAN：bridge 上的 VLAN 介面，除了 bridge 本身沒有任何成員埠（只在 bridge 有 VLAN 成員資料時判斷，避免 vlan-filtering 關閉時誤報）
    const vlanOf = new Map(); M.vlans.forEach((v) => { if (v.id != null) vlanOf.set(v.dev + '|' + v.id, v); });
    const filtering = new Set(); M.vlans.forEach((v) => v.members.forEach((_, ep) => { const i = M.ifcs.get(ep); if (i && i.type !== 'bridge') filtering.add(v.dev); }));
    M.ifcs.forEach((i) => {
      if (i.type !== 'vlan' || i.encapVlan == null || !i.parent || !filtering.has(i.dev)) return;
      const parent = M.ifcs.get(i.parent); if (!parent || parent.type !== 'bridge' || parent.vlanFiltering === false) return; // 未過濾的 bridge 沒有 VLAN 成員可看
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
        byDomain(vlan, Array.from(eps).sort(S.util.natural)).forEach((locations) => {
          if (locations.length < 2) return;
          add('A02', `${K.macPretty(m.mac)} 在 ${vlan ? `VLAN ${vlan}` : 'VLAN 不明'} 的多個終端埠出現：${locations.map(epName).join('、')}`,
            [{ type: 'mac', key: m.mac }].concat(locations.map((ep) => ({ type: 'interface', key: ep }))),
            locations.map((ep) => macVlanSrc(m, ep, vlan)).filter(Boolean), { facet: vlan ? String(vlan) : 'unknown' });
        });
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
      if (bad.length) add('R05', `${name(n.dev)}：${n.network} 的閘道 ${bad.join('、')} 不在網段內`, [{ type: 'device', key: n.dev }], [{ block: n.block, line: n.line }], { facet: `${p.net}/${p.len}` });
    });
    configConsistency(M, add, name, epName, byDomain);
    // R02：OSPF 鄰居用位址、router-id、管理 IP 都對不到設備（建模時 peerBasis 為 null）
    M.ospfAdjacencies.forEach((a) => { if (!a.peerBasis) add('R02', `${name(a.dev)} ${K.splitEp(a.localEp)[1]} 的鄰居 ${a.peerId}（${a.peerIp}）`,
      [{ type: 'device', key: a.dev }, { type: 'device', key: K.dev(a.peerId) }], [{ block: a.block, line: a.line }], { facet: K.splitEp(a.localEp)[1] }); });

    firewallChecks(M, add, name);

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
    /**
     * 附加在訊息尾端的推定結果與 finding 的 deviation 欄位（平手時 deviating 為空陣列、main 為 null）。
     * groups：多數決實際用的分組（groupDevs 的結果，順序相同）；value 是該組第一台設備的顯示值（依它的設定順序），
     * key 是同位置的正規化比對值，devs 依名稱自然排序。main 是多數組在 groups 的索引。
     */
    const judge = (groups) => {
      const m = majorityOf(groups);
      return {
        note: m ? `；依多數推定偏離：${devList(m.deviating)}` : '；沒有多數，無法推定',
        extra: { deviation: { basis: 'majority', deviating: m ? m.deviating : [],
          groups: groups.map((g) => ({ value: g.vals.slice(), key: g.keys.slice(), devs: g.devs.slice() })), main: m ? groups.indexOf(m.main) : null } },
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
    // V06／V07 的 facet：比較的是哪一種屬性（/interface vlan 的 name、comment，/interface bridge vlan 的 comment）
    const ATTR_FACET = { 'VLAN 介面名稱': 'vlan-interface-name', 'VLAN 介面說明': 'vlan-interface-comment', 'bridge VLAN 說明': 'bridge-vlan-comment' };
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
          add('V06', `VLAN ${id} 的 ${attr}：${fmtGroups(groups, quote)}${j.note}`, entsOf(sel, [{ type: 'vlan', key: String(id) }]), evByGroups(groups, sel, (x) => x.dev, (x) => evsOf([x])), Object.assign({ facet: ATTR_FACET[attr] }, j.extra));
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
        add('V07', `${attr}「${sel[0].val}」：${fmtGroups(groups, fmtVlanIds)}${j.note}`, entsOf(sel, ids.map((id) => ({ type: 'vlan', key: String(id) }))), evByGroups(groups, sel, (x) => x.dev, (x) => evsOf([x])), Object.assign({ facet: ATTR_FACET[attr] + '|' + k }, j.extra));
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
      add('A07', `${net}：${fmtGroups(groups, fmtVlanIds)}${j.note}`, U.uniq(sel.map((x) => x.ep)).map((key) => ({ type: 'interface', key })), evByGroups(groups, sel, (x) => x.dev, (x) => [ev(x.src)]), Object.assign({ facet: net }, j.extra));
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
      add('A08', (parts.length === 2 ? parts.join('與 ') : parts.join('、')) + jd.note, locsBy.flat().map((l) => ({ type: 'interface', key: l.ep })), interleave(locsBy).map((l) => ev(l.src)), Object.assign({ facet: list[0].key }, jd.extra)); // facet：最外層的網段
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
      [['閘道', 'gateways', 'gateway'], ['DNS', 'dns', 'dns'], ['NTP', 'ntp', 'ntp']].forEach(([label, k, facet]) => {
        const sel = nets.filter((n) => n[k] && n[k].length);
        const perDev = new Map(); sel.forEach((n) => n[k].forEach((v) => put(perDev, n.dev, norm(v), v)));
        const groups = groupDevs(perDev);
        if (groups.length < 2) return;
        const j = judge(groups);
        add('R06', `${net} ${label}：${fmtGroups(groups, show)}${j.note}`, U.uniq(sel.map((n) => n.dev)).sort(byName).map((key) => ({ type: 'device', key })), evByGroups(groups, sel, (n) => n.dev, (n) => [{ block: n.block, line: n.line }]), Object.assign({ facet: facet + '|' + net }, j.extra));
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
        devs.sort(byName).map((key) => ({ type: 'device', key })), evByGroups(groups, sel, (b) => b.dev, (b) => [{ block: b.block, line: b.line }]), Object.assign({ facet: sel[0].section + '|' + sel[0].nameKey }, j.extra));
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
        Array.from(perDev.keys()).sort(byName).map((key) => ({ type: 'device', key })), evByGroups(groups, sel, (b) => b.dev, (b) => [{ block: b.block, line: b.line }]), Object.assign({ facet: sel[0].section + '|' + sel[0].valueKey }, j.extra));
    });

    // ---- A12：設備層級的 DNS／NTP 伺服器
    const collectedDevs = Array.from(M.devices.values()).filter((d) => d.collected);
    [['DNS 伺服器', 'dnsServers', 'dns'], ['NTP 伺服器', 'ntpServers', 'ntp']].forEach(([label, k, facet]) => {
      const sel = collectedDevs.filter((d) => d[k] && d[k].values.length);
      const perDev = new Map(); sel.forEach((d) => d[k].values.forEach((v) => put(perDev, d.key, norm(v), v)));
      const groups = groupDevs(perDev);
      if (groups.length < 2) return;
      sel.sort((a, b) => byName(a.key, b.key));
      const j = judge(groups);
      add('A12', `${label}：${fmtGroups(groups, show)}${j.note}`, sel.map((d) => ({ type: 'device', key: d.key })), evByGroups(groups, sel, (d) => d.key, (d) => d[k].src.map(ev)), Object.assign({ facet }, j.extra));
    });
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
      // F08：有規則但無法判斷 WAN；F03／F04／F07 都需要 WAN，不猜；F05 改為只看沒有限制入介面的 forward 規則（見下方 F05）
      if (!ctx.wan && active.length) {
        const why = ctx.status === 'no-wan-list' ? '沒有名稱含 WAN 的 interface list' : `WAN 清單（${ctx.wanLists.join('、')}）沒有成員`;
        add('F08', `${name(dev)}：有 ${active.length} 條防火牆規則，但${why}，無法判斷哪些介面對外；F03、F04、F07 未檢查，F05 只檢查沒有限制入介面的 forward 規則`, [{ type: 'device', key: dev }], [ruleEv(active[0])]);
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
      // F07：管理服務啟用、來源位址不受限（available-from），且從 WAN 的新連線會被 input 放行（先看 raw）。IPv4、IPv6 分開判斷：
      //   available-from 空白＝不限；有列位址時只接受清單內的，某一位址族沒有列任何前綴＝那個位址族拒絕（手冊：只有 IPv4 前綴時拒絕所有 IPv6 用戶端）
      //   IPv6 只在確定有用時才判斷（firewallZones.ipv6.status 為 used），經 /ipv6 firewall 的 raw 與 input
      const zone = M.fwZones.get(dev);
      const FAMILIES = [['ip', 'IPv4', 32n], ['ipv6', 'IPv6', 128n]];
      const openFrom = (sv, fam, bits) => {
        if (!sv.addresses.length) return true;
        return sv.addresses.some((a) => {
          if (a.includes(':') !== (fam === 'ipv6')) return false;
          const p = fw.parseVal('src-address', a);
          return p.kind === 'ranges' && p.items.some(([x, y]) => x === 0n && y === (1n << bits) - 1n);
        });
      };
      // 同一個服務的 IPv4、IPv6 併成一筆（鍵不重複）；訊息依位址族列出從哪個 WAN 介面、被哪條規則放行
      (M.fwServices.get(dev) || []).forEach((sv) => {
        if (!sv.enabled || !sv.port) return;
        const hits = [];
        FAMILIES.forEach(([fam, label, bits]) => {
          if (fam === 'ipv6' && zone.ipv6.status !== 'used') return;
          if (!openFrom(sv, fam, bits)) return;
          for (const ep of wans) {
            const res = fw.evalFilter(ctx, fam, 'input', { family: fam, in: ep, out: null, protocol: 'tcp', dstPort: sv.port, dst: undefined, state: 'new', natState: null });
            if (res.verdict === 'accept') { hits.push({ fam, label, ep, res }); break; }
          }
        });
        if (!hits.length) return;
        const ev = sv.src.map(([block, line]) => ({ block, line }));
        hits.forEach((h) => {
          if (h.res.rule) ev.push(ruleEv(h.res.rule));
          h.res.path.forEach((r) => ev.push(ruleEv(r)));
          if (h.fam === 'ipv6') zone.ipv6.src.forEach(([block, line]) => ev.push({ block, line })); // 讓 IPv6 生效的那一行
        });
        const how = hits.map((h) => `${h.label} 從 ${ifcName(h.ep)}，${h.res.rule ? `${h.res.rule.chain} 第 ${h.res.rule.position} 條放行` : 'input 沒有任何規則擋下'}`).join('；');
        add('F07', `${name(dev)}：${sv.name}（tcp/${sv.port}${sv.basis === 'default' ? '，預設值' : ''}）啟用、沒有限制來源位址（available-from），WAN 可以連入：${how}`,
          [{ type: 'device', key: dev }, { type: 'service', key: dev + '|' + sv.name }].concat(hits.filter((h) => h.res.rule).map((h) => ({ type: 'rule', key: h.res.rule.key }))), ev);
      });
    });
  }

  S.check = { run, coverage, CATALOG, EXPECTED, DATA_LABEL, fmtVlans, resolveNextHop };
})(globalThis.SSOT = globalThis.SSOT || {});
