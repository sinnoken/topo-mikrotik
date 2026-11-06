/*
 * 一致性檢查：基準可不可信，由這裡回答。
 * 每筆 finding：{ id, severity, cat, title, message, entities:[{type,key}], facet?, evidence:[{block,line}], deviation? }
 * facet：同一組 id＋實體可能產生多筆的檢查，標示這筆檢查的是哪一個項目（例如 A12 的 dns／ntp），會進入 findingKey。
 *        只有 CATALOG 宣告 facet 的檢查才有，而且每筆都有；值只取自設定的項目與正規化後的設定值，不取自訊息、設備名稱或行號。
 * severity：error（資料互相矛盾）／warn（可能有問題）／info（提醒）
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const LINK_SCOPE = S.LINK_SCOPE;

  // 檢查目錄（編號、嚴重度、標題、需要的資料、常見原因與處理）在 catalog.js，須先載入
  if (!S.check || !S.check.CATALOG) throw new Error('src/check/catalog.js 必須在 src/check/checks.js 之前載入');
  const CATALOG = S.check.CATALOG;

  /** 每筆 finding 預設最多附幾筆證據；檢查可用 CATALOG 的 evidenceLimit 覆寫。 */
  const EVIDENCE_LIMIT = 6;

  /** 各類設備預期要有的資料（C02），可由 build 選項 expectedData 覆寫。 */
  const EXPECTED = {
    switch: ['lldp', 'config', 'mac'],
    router: ['lldp', 'config', 'route'],
    firewall: ['lldp', 'config', 'route'],
    host: [], unknown: [],
  };
  /** 應收集的設備（C01／C02 的範圍）：已收集的設備，加上未收集但不是主機的設備；主機本來就不在收集範圍。d 是設備或 coverage 列（有 collected、kind）。 */
  const expectsCollection = (d) => !!d.collected || d.kind !== 'host';
  const fmtVlans = S.util.fmtVlans;
  // 資料類別的顯示名稱；畫面透過 S.query.dataLabel 讀取
  const DATA_LABEL = Object.freeze({
    lldp: '鄰居', config: '設定', vlans: 'VLAN 成員', mac: 'MAC 表', arp: 'ARP', route: '路由表',
    ospf: 'OSPF', ipaddr: 'IP 位址', ifstatus: '介面狀態', system: '系統資訊', wifireg: 'Wi-Fi 關聯表', stp: 'RSTP 狀態', fwstats: '防火牆命中次數', vrf: 'VRF', routerboard: 'RouterBOARD 韌體',
  });

  // 對外邊界證據（model.boundaries 的 evidence[].kind）在訊息中的名稱
  const BOUNDARY_LABEL = Object.freeze({
    'default-route': '預設路由的出介面', 'dhcp-client': 'DHCP client 加入的預設路由', 'pppoe-client': 'PPPoE client 加入的預設路由',
    'srcnat-out': 'srcnat 的出介面', 'dstnat-in': 'dst-nat 的入介面', 'wan-list': 'WAN 清單',
    'public-address': '公網位址', 'cgnat-address': 'CGNAT 位址', 'dstnat-address': 'dst-nat 的目的位址',
  });

  // 訊息中引用原文時的長度上限（I01 的錯誤訊息、I03 的無法辨識行）
  const clip = (t) => { t = String(t == null ? '' : t).trim(); return t.length > 60 ? t.slice(0, 60) + '…' : t; };
  /**
   * 訊息中的來源名稱：貼上的內容（S.readers.PASTE，半形括號，是 Snapshot 的檔名原值）在訊息中寫成全形括號；其餘原樣。
   * 這是核心訊息的唯一寫法（畫面的 V.fileName 是同一個轉換）。
   */
  const PASTE_TEXT = '（貼上的內容）';
  const sourceName = (file) => (file === S.readers.PASTE ? PASTE_TEXT : file);
  /** 訊息中的位置「檔名 第 a–b 行」：全形括號結尾的名稱後不加空白 */
  const placeText = (file, start, end) => {
    const n = sourceName(file);
    return `${n}${n.endsWith('）') ? '' : ' '}第 ${start === end ? start : `${start}–${end}`} 行`;
  };
  /**
   * 結論在前的訊息：「結論：位置＋補充」。parts 是 { what（結論）, rest（補充，接在位置後面，可為空字串）}。
   * I01 的訊息與建立前的預檢（S.preflight 的 reason＝what＋rest）由同一組 parts 產生，
   * 所以訊息去掉「：位置」就是預檢的原因。
   */
  const withPlace = (p, place) => `${p.what}：${place}${p.rest}`;
  const joinParts = (p) => p.what + p.rest;
  /** 整段無法辨識的結論與補充。b：已辨識過的區塊（how、adapters、empty）。 */
  function unrecognizedParts(b) {
    // 整段只有 RouterOS 錯誤訊息：沒有內容是因為指令執行失敗，不是輸出格式不對
    const content = b.lines.filter((l) => l.trim());
    const rosErr = b.device !== null && content.length && content.every(S.adapters.util.rosError);
    const cmd = b.command ? `（指令：${b.command}）` : '';
    return b.device === null ? { what: '沒有設備標頭', rest: '' }
      : rosErr ? { what: '指令執行錯誤', rest: `，設備回應「${clip(content[0])}」${cmd}；請確認 RouterOS 版本與已安裝的套件是否支援這個指令，或改用正確的指令重新收集` }
      : b.empty ? { what: '解析不出任何內容', rest: `（已辨識為${(b.adapters || []).map((a) => `「${S.adapters[a].label}」`).join('、')}）；RouterOS 的 print 指令請加上 detail without-paging` }
        : { what: '無法辨識的內容', rest: cmd };
  }
  /** 整段無法辨識的原因（建立前的預檢 S.preflight 用；I01 的訊息是同一段文字加上位置） */
  const unrecognizedReason = (b) => joinParts(unrecognizedParts(b));
  // 收集器註解（readers/common.js）格式或位置不對：不能確定收集時間或失敗原因，列為無法辨識
  const ISSUE = {
    'collected-at-invalid': (x) => `收集時間「${x.text}」不是 UTC ISO 8601 格式（應為 2026-10-24T03:00:00Z 這種秒精度的 UTC 時間）`,
    'collected-at-misplaced': (x) => `收集時間「${x.text}」不在指令標記的下一行，無法判斷屬於哪個指令`,
    'failure-duplicate': (x) => `同一段指令輸出有第二個收集失敗註解「${x.text}」，採用第一個`,
  };
  /** 收集器註解問題的結論與補充。x：區塊的 issues 之一 { kind, line, text }。 */
  const issueParts = (x) => ({ what: '收集器註解有誤', rest: '，' + ISSUE[x.kind](x) });
  /** 收集器註解問題的原因（S.preflight 用；I01 的訊息是同一段文字加上位置） */
  const issueReason = (x) => joinParts(issueParts(x));

  /*
   * 規則表：檢查依 RULES（檔案末端）逐一執行。每一筆是 { ids, fn }：fn(X, add) 只產生 ids 中的 finding（add 會擋下其他 id），
   * 每個 CATALOG id 恰好屬於一筆；共用前置計算的幾條檢查（例如 R01／R03／R04 共用下一跳解析）合成一筆。
   * X 是 prep() 建立的共用前置計算（索引、名稱、排序與證據的輔助），每次 run 只建立一次；只有一條檢查用到的索引留在那條檢查的函式裡。
   * 輸出順序只由 run 最後的排序決定；同一個 id 的 finding 在各自的函式內依原本的順序產生，所以表的順序不影響結果。
   */
  function prep(M, ctx) {
    const name = (devKey) => { const d = M.devices.get(devKey); return d ? S.infer.displayName(d) : devKey; };
    const epName = (ep) => { const [d] = K.splitEp(ep); const i = M.ifcs.get(ep); return name(d) + ' ' + (i ? i.name : K.splitEp(ep)[1]); };
    // 與來源檔案順序無關的排序（區塊編號隨輸入順序改變，不能當排序依據）：證據依所屬設備、檔名、行號
    const evDev = (e) => (ctx.blocks[e.block] || {}).devKey || '';
    const evFile = (e) => ((ctx.blocks[e.block] || {}).origin || {}).file || '';
    const evCmp = (a, b) => S.util.natural(evDev(a), evDev(b)) || S.util.natural(evFile(a), evFile(b)) || a.line - b.line;
    // 鏈路依鍵排序後再逐條檢查（M.links 是觀察順序；聚合成員只報一次時取哪一條要穩定）
    const links = Array.from(M.links.values()).sort((x, y) => S.util.natural(x.key, y.key));
    // 鏈路的代表證據：a 端設備觀察到的那一行優先，再來是 b 端，各端內依 evCmp
    const linkEv = (l) => {
      const side = (e) => { const d = evDev(e); return d === K.splitEp(l.a)[0] ? 0 : d === K.splitEp(l.b)[0] ? 1 : 2; };
      return l.src.map(([block, line]) => ({ block, line })).sort((x, y) => side(x) - side(y) || evCmp(x, y))[0];
    };
    // 區塊所屬的設備；內容都認不得的設備沒有建立（model/build.js），finding 不指向它（設備名仍在訊息的位置裡）。
    // 被別台的鄰居資料看到時，這台以鄰居身分建立（未收集），I01／I03 指向它，C01 不報（見覆蓋）
    const blockEnts = (b) => (b.devKey && M.devices.has(b.devKey) ? [{ type: 'device', key: b.devKey }] : []);
    // 設備在輸入中的各區塊（依輸入順序）：C02 的證據，也用來判斷 C01 的設備有沒有收集檔
    const blocksOf = new Map();
    ctx.blocks.forEach((b) => { if (b.devKey) S.util.getOr(blocksOf, b.devKey, () => []).push({ block: b.id, line: b.origin.startLine }); });
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
    // 兩端的 PVID（聚合成員取所屬聚合介面的）：V04、V08 共用
    const pvidOf = (ep) => S.infer.effPvid(M, ep);
    // 各設備的直連網段（A05 與下一跳解析共用；只看有介面位址資料的設備）
    const netsOf = new Map();
    M.ifcs.forEach((i) => { if (!i.hearsay) i.ips.forEach((_, c) => { const p = S.ip.parseCidr(c); if (p && p.len < 32) S.util.getOr(netsOf, i.dev, () => []).push(Object.assign({ vrf: i.vrf }, p)); }); });
    // MAC 表觀察的來源（每個埠第一次學到的那一行；A03、A04 共用）
    const toEv = (s) => (s ? { block: s[0], line: s[1] } : null);
    const macSrc = (mac, ep) => toEv(S.model.firstSeenSrc(M.macs.get(mac), ep));
    // 路由與對外邊界（ADR-023）：模型版的路由視圖（S.infer.routingView，交給 S.trace 的單跳轉送決定）、邊界推論、路由網域
    const RV = S.infer.routingView(M);
    const boundaryOf = new Map(M.boundaries.map((b) => [b.ep, b]));
    const isExternal = (ep) => { const b = ep && boundaryOf.get(ep); return !!b && b.status === 'external'; };
    const domainOf = new Map(); M.routingDomains.forEach((d) => d.prefixes.forEach((p) => domainOf.set(p, d)));
    /** 判定對外的依據（強證據的種類，沒有時是 WAN 清單），給訊息用：「預設路由的出介面、srcnat 的出介面」。 */
    const boundaryBasis = (ep) => {
      const b = boundaryOf.get(ep); if (!b) return '';
      const strong = S.util.uniq(b.evidence.filter((e) => e.strength === 'strong').map((e) => BOUNDARY_LABEL[e.kind] || e.kind));
      return (strong.length ? strong : S.util.uniq(b.evidence.filter((e) => e.kind === 'wan-list').map((e) => BOUNDARY_LABEL[e.kind]))).join('、');
    };
    /** 入口介面在訊息中的寫法：WAN 清單的成員只寫介面名稱；只由邊界證據判定的另寫依據（推論），例如「ether1（判定對外的依據：srcnat 的出介面）」。 */
    const entryName = (dev, ep) => {
      const e = (M.wanEntries.get(dev) || []).find((w) => w.ep === ep);
      const n = K.splitEp(ep)[1];
      return !e || e.wanList ? n : `${n}（判定對外的依據：${boundaryBasis(ep)}）`;
    };
    return {
      M, ctx, name, epName, evCmp, links, linkEv, blockEnts, blocksOf, byDomain, pvidOf, netsOf, macSrc, toEv, RV, boundaryOf, isExternal, domainOf, boundaryBasis, entryName,
      interfaceLinksByEp: M.adjacency, // 介面鄰接索引，由 infer.edgeLocations 算出（之後 M.links 不再變動）
      edge: M.edge, // 終端埠是推論，由 infer.edgeLocations 算出
      cc: consistencyKit(M, name),
    };
  }

  // ---- 輸入
  function unrecognizedBlocks(X, add) {
    const { ctx, blockEnts } = X;
    ctx.unrecognized.forEach((b) => {
      add('I01', withPlace(unrecognizedParts(b), placeText(b.origin.file, b.origin.startLine, b.origin.endLine)),
        blockEnts(b), [{ block: b.id, line: b.origin.startLine }]);
    });
    ctx.blocks.forEach((b) => (b.issues || []).forEach((x) => add('I01', withPlace(issueParts(x), placeText(b.origin.file, x.line, x.line)),
      blockEnts(b), [{ block: b.id, line: x.line }])));
  }
  function duplicateBlocks(X, add) {
    const { ctx, name } = X;
    ctx.duplicates.forEach((d) => add('I02', `${name(d.dev)} 的「${S.adapters[d.adapter].label}」出現 ${d.blocks.length} 次，採用最後一次`,
      [{ type: 'device', key: d.dev }], d.blocks.map((b) => ({ block: b, line: ctx.blocks[b].origin.startLine })), { facet: d.adapter }));
  }
  // 已解析區塊中認不得的行（adapters.parse）：其餘內容照常進入基準，這幾行沒有；RouterOS 錯誤訊息另外點出，代表輸出可能不完整
  const I03_SAMPLE = 3; // 訊息中列出前幾行的原文
  function unrecognizedLines(X, add) {
    const { ctx, blockEnts } = X;
    ctx.blocks.forEach((b) => {
      const ls = b.unrecognizedLines || []; if (!ls.length) return;
      const text = (n) => clip(b.lines[n - b.origin.startLine]);
      const quote = (n) => `第 ${n} 行「${text(n)}」`;
      const errs = ls.filter((n) => S.adapters.util.rosError(b.lines[n - b.origin.startLine]));
      const sample = ls.slice(0, I03_SAMPLE).map(quote).join('、') + (ls.length > I03_SAMPLE ? ' 等' : '');
      const err = errs.length ? `；其中 ${errs.length} 行是 RouterOS 錯誤訊息（${quote(errs[0])}），指令可能沒有完整執行，資料可能不完整` : '';
      add('I03', `${ls.length} 行無法辨識，沒有進入基準：${placeText(b.origin.file, b.origin.startLine, b.origin.endLine)}（${b.command || '沒有指令標記'}）中的${sample}${err}`,
        blockEnts(b), ls.map((line) => ({ block: b.id, line })));
    });
  }

  // ---- 覆蓋
  function uncollectedDevices(X, add) {
    const { M, name, blocksOf } = X;
    // C01 的證據：發現這台設備的鄰居資料與 OSPF 鄰居資料那幾行（依輸入順序）
    const sightings = new Map();
    M.claims.forEach((c) => S.util.getOr(sightings, c.peer, () => []).push({ block: c.block, line: c.line }));
    M.ospfAdjacencies.forEach((a) => S.util.getOr(sightings, a.peerDev, () => []).push({ block: a.block, line: a.line }));
    sightings.forEach((list) => list.sort((a, b) => a.block - b.block || a.line - b.line));
    // C01 的設備名稱與畫面同一規則（discoveryLabel）：名稱只是位址時寫出由哪種協定得知
    const linksOfDev = new Map(); const ospfPeers = new Set(M.ospfAdjacencies.map((a) => a.peerDev));
    M.links.forEach((l) => [l.a, l.b].forEach((ep) => { const arr = S.util.getOr(linksOfDev, K.splitEp(ep)[0], () => []); if (!arr.includes(l)) arr.push(l); }));
    M.devices.forEach((d) => {
      if (d.collected) return;
      // 有收集檔、但內容都認不得的設備（model/build.js 不當成已收集）：問題是輸出認不得、不是沒收集，已由 I01 指向它，不報 C01
      if (!expectsCollection(d) || blocksOf.has(d.key)) return;
      add('C01', `${discoveryLabel(name(d.key), false, linksOfDev.get(d.key) || [], ospfPeers.has(d.key))}：由 ${Array.from(d.seenBy).map(name).join('、')} 發現`, [{ type: 'device', key: d.key }], sightings.get(d.key));
    });
  }
  function incompleteDevices(X, add) {
    const { M, ctx, name, blocksOf } = X;
    const expected = Object.assign({}, EXPECTED, ctx.expectedData || {});
    const failed = failuresByDev(ctx.blocks);
    M.devices.forEach((d) => {
      if (!d.collected) return;
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
  }

  // ---- 鏈路
  // K01／K04：依建模時的 LLDP／CDP 配對結果（c.pairing，見 model/build.js）判定；只有 MNDP 的觀察沒有配對
  function oneWayNeighbors(X, add) {
    const { M, name } = X;
    M.claims.forEach((c) => {
      const p = c.pairing; if (!p || p.status !== 'one-way') return;
      add('K01',
        `${name(c.peer)} 的 LLDP 沒有回報 ${name(c.dev)}：${name(c.dev)} ${M.ifcs.get(K.ep(c.dev, c.ifc)).name} 看到 ${name(c.peer)} ${c.peerIfc}`,
        [{ type: 'link', key: p.link }], [{ block: c.block, line: c.line }]);
    });
  }
  function peerPortMismatch(X, add) {
    const { M, name } = X;
    M.claims.forEach((c) => {
      const p = c.pairing;
      // 對端埠名不明（RouterOS 6 沒有 interface-name）時無從比較
      if (p && p.status === 'reciprocal' && c.peerIfc !== '?' && K.ifc(c.peerIfc) !== p.remoteIfc) add('K04',
        `${name(c.dev)} 說對端是「${c.peerIfc}」，對端自己的介面是「${p.remoteIfc}」`, [{ type: 'link', key: p.link }], [{ block: c.block, line: c.line }]);
    });
  }
  function multiPeerPorts(X, add) {
    const { epName, linkEv, interfaceLinksByEp } = X;
    interfaceLinksByEp.forEach((ls, ep) => {
      if (ls.length < 2) return;
      const peerOf = (l) => (l.a === ep ? l.b : l.a);
      ls = ls.slice().sort((x, y) => S.util.natural(epName(peerOf(x)), epName(peerOf(y))) || S.util.natural(peerOf(x), peerOf(y)));
      const peers = ls.map((l) => epName(peerOf(l)));
      add('K02', `${epName(ep)} 同時對應到：${peers.join('、')}`,
        [{ type: 'interface', key: ep }].concat(ls.map((l) => ({ type: 'link', key: l.key }))), ls.map(linkEv));
    });
  }
  function lagMismatch(X, add) {
    const { M, epName, links, linkEv } = X;
    // 聚合：依成員鏈路推出 (A:ae, B:ae) 配對
    const lagPairs = new Map();
    links.forEach((l) => {
      if (l.layer !== 'l2' || l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN) return;
      const ia = M.ifcs.get(l.a); const ib = M.ifcs.get(l.b);
      if (!ia || !ib || (!ia.lag && !ib.lag)) return;
      const pa = ia.lag; const pb = ib.lag;
      const key = (pa || l.a + '(單埠)') + '⇄' + (pb || l.b + '(單埠)');
      S.util.getOr(lagPairs, key, () => ({ pa, pb, la: l.a, lb: l.b, links: [] })).links.push(l);
    });
    lagPairs.forEach((p) => {
      const ents = p.links.map((l) => ({ type: 'link', key: l.key }));
      const ev = p.links.map(linkEv);
      if (!p.pa || !p.pb) {
        const lagSide = p.pa || p.pb; const other = p.pa ? p.lb : p.la;
        const od = M.devices.get(K.splitEp(other)[0]);
        if (od && od.collected && od.data.has('config')) // 聚合成員關係只來自 export（/interface bonding）
          add('K03', `${epName(lagSide)} 的對端不是聚合介面成員：成員連到 ${epName(other)}`, ents, ev);
        return;
      }
      const ma = M.ifcs.get(p.pa).lagMembers.size; const mb = M.ifcs.get(p.pb).lagMembers.size;
      if (ma !== mb) add('K03', `${epName(p.pa)} 有 ${ma} 個成員，${epName(p.pb)} 有 ${mb} 個成員（實際連到對方的有 ${p.links.length} 條）`, ents.concat([{ type: 'interface', key: p.pa }, { type: 'interface', key: p.pb }]), ev);
    });
  }

  // ---- VLAN
  function linkVlanDiff(X, add) {
    const { epName, links, linkEv } = X;
    links.forEach((l) => {
      if (!l.vlanMismatch) return; // 由 infer.linkVlans 判定：vlansDiff 是計入 V01、只在一端的 VLAN
      const diff = new Set(l.vlansDiff);
      const onlyA = l.vlansA.filter((v) => diff.has(v)); const onlyB = l.vlansB.filter((v) => diff.has(v));
      const parts = [];
      if (onlyA.length) parts.push(`只在 ${epName(l.a)}：${fmtVlans(onlyA)}`);
      if (onlyB.length) parts.push(`只在 ${epName(l.b)}：${fmtVlans(onlyB)}`);
      add('V01', parts.join('；'), [{ type: 'link', key: l.key }], [linkEv(l)]);
    });
  }
  // native VLAN：兩端都有 PVID（聚合成員取所屬聚合介面的）且不同
  function nativeVlanDiff(X, add) {
    const { M, epName, links, linkEv, pvidOf } = X;
    const nativeSeen = new Set();
    links.forEach((l) => {
      if (l.layer !== 'l2' || !l.vlanComparable) return;
      const pa = pvidOf(l.a); const pb = pvidOf(l.b);
      if (pa == null || pb == null || pa === pb) return;
      const key = [M.ifcs.get(l.a).lag || l.a, M.ifcs.get(l.b).lag || l.b].sort().join('~'); // 聚合的多條成員鏈路只報一次
      if (nativeSeen.has(key)) return; nativeSeen.add(key);
      add('V04', `${epName(l.a)} PVID ${pa}；${epName(l.b)} PVID ${pb}`, [{ type: 'link', key: l.key }], [linkEv(l)]);
    });
  }
  // tagged／untagged 不一致：兩端都承載同一個 VLAN（不是 V01），但一端帶標籤、另一端不帶。
  // 邊界：兩端 PVID 都有且不同時，那兩個 PVID 的差異就是 V04 的同一件事，不再列入 V08；其他 VLAN 照常比較。
  function taggingDiff(X, add) {
    const { M, epName, links, linkEv, pvidOf } = X;
    const modeSeen = new Set();
    links.forEach((l) => {
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
      add('V08', parts.join('；'), [{ type: 'link', key: l.key }], [linkEv(l)]);
    });
  }
  // 未過濾的 bridge：一端在未開 vlan-filtering 的 bridge 上（VLAN 原樣轉送，V01／V04／V08 不比較），對端以 tagged 承載 VLAN。
  // 兩端都未過濾、對端沒有 VLAN 資料或只有 untagged 時不報：untagged 訊框經過未過濾的 bridge 不受影響
  function unfilteredBridge(X, add) {
    const { M, epName, links, linkEv } = X;
    const unfSeen = new Set();
    links.forEach((l) => {
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
      const ev = [linkEv(l)].concat(br.vlanFilteringSrc ? [{ block: br.vlanFilteringSrc[0], line: br.vlanFilteringSrc[1] }] : []);
      add('V09', `${epName(eu)} 所在的 ${br.name} 沒有開啟 vlan-filtering，VLAN 原樣轉送、無法比較；${epName(eo)} 以 tagged 承載 VLAN ${fmtVlans(tagged)}`,
        [{ type: 'link', key: l.key }, { type: 'interface', key: br.key }], ev);
    });
  }
  // 孤立 VLAN：bridge 上的 VLAN 介面，除了 bridge 本身沒有任何成員埠（只在 bridge 有 VLAN 成員資料時判斷，避免 vlan-filtering 關閉時誤報）
  function orphanVlans(X, add) {
    const { M, epName } = X;
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
  }

  // ---- 位址（以 IP 或網段為鍵的檢查只在同一個 VRF 內比較，鍵與訊息用 K.inVrf：main 不加後綴，ADR-015）
  function ipMacConflict(X, add) {
    const { M, name, evCmp } = X;
    const ipMacs = new Map();
    // 同一個 MAC 被多台設備看到時，以設備名稱排在前面的那筆 ARP 為代表；列舉依代表設備的名稱、再依 MAC
    const arpCmp = (x, y) => S.util.natural(name(x.dev), name(y.dev)) || evCmp(x, y);
    M.arps.forEach((a) => {
      const macs = S.util.getOr(ipMacs, K.inVrf(a.ip, a.vrf), () => new Map()); const cur = macs.get(a.mac);
      if (!cur || arpCmp(a, cur) < 0) macs.set(a.mac, a);
    });
    ipMacs.forEach((macs, ip) => {
      if (macs.size < 2) return;
      const arps = Array.from(macs.values()).sort((x, y) => S.util.natural(name(x.dev), name(y.dev)) || S.util.cmp(x.mac, y.mac));
      add('A01', `${ip} 對應到 ${arps.map((a) => `${K.macPretty(a.mac)}（${name(a.dev)}）`).join('、')}`,
        [{ type: 'ip', key: ip }].concat(arps.map((a) => ({ type: 'mac', key: a.mac }))),
        arps.map((a) => ({ block: a.block, line: a.line })));
    });
  }
  function macOnManyEdges(X, add) {
    const { M, epName, byDomain, edge, toEv } = X;
    // 指定 VLAN 時，MAC 表觀察的來源取該 VLAN 的那一行
    const macVlanSrc = (m, ep, vlan) => toEv(m.seen.get(ep).get(vlan));
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
  }
  function edgePorts(X, add) {
    const { M, name, edge, macSrc } = X;
    const edgeByDev = new Map();
    edge.forEach((v, ep) => { if (!v.linked) S.util.getOr(edgeByDev, K.splitEp(ep)[0], () => []).push(ep); });
    edgeByDev.forEach((eps, dev) => {
      eps.sort(S.util.natural);
      const desc = eps.slice(0, 8).map((ep) => `${M.ifcs.get(ep).name}（${M.ifcs.get(ep).macs.size}）`).join('、');
      // 終端埠恰好學到一個 MAC：證據是該 MAC 在這個埠的觀察
      add('A03', `${name(dev)}：${eps.length} 個介面學到 MAC 但沒有 LLDP／CDP 鄰接，${desc}${eps.length > 8 ? '…' : ''}`, [{ type: 'device', key: dev }],
        eps.map((ep) => macSrc(Array.from(M.ifcs.get(ep).macs)[0], ep)).filter(Boolean));
    });
  }
  function manyMacs(X, add) {
    const { M, epName, macSrc, interfaceLinksByEp } = X;
    const byLine = (a, b) => a.block - b.block || a.line - b.line;
    manyMacPorts(M, interfaceLinksByEp).forEach(({ ep, n, macs }) => add('A04', `${epName(ep)}：${n} 個 MAC，且沒有 LLDP／CDP 鄰接`, [{ type: 'interface', key: ep }],
      macs.map((mac) => macSrc(mac, ep)).filter(Boolean).sort(byLine)));
  }
  // ARP 位址不在該設備任何直連網段（只看有介面位址資料的設備；只比 ARP 所在 VRF 的直連網段）
  function strayArps(X, add) {
    const { M, name, netsOf } = X;
    const strayByDev = new Map();
    M.arps.forEach((a) => {
      const nets = netsOf.get(a.dev); if (!nets) return;
      if (!nets.some((p) => p.vrf === a.vrf && S.ip.inNet(a.ip, p.net, p.len))) S.util.getOr(strayByDev, a.dev, () => []).push(a);
    });
    strayByDev.forEach((list, dev) => add('A05', `${name(dev)}：${list.map((a) => `${K.inVrf(a.ip, a.vrf)}（${a.ifc}）`).join('、')}`,
      [{ type: 'device', key: dev }].concat(list.map((a) => ({ type: 'ip', key: K.inVrf(a.ip, a.vrf) }))), list.map((a) => ({ block: a.block, line: a.line }))));
  }

  // ---- 路由（每條路由的下一跳在它的 vrf 解析：沿那個 VRF 的路由表遞迴，擁有者依 hopOwner）
  // R01／R03／R04 共用同一次下一跳解析，每個下一跳依解析結果歸入其中一種
  // 路由表與下一跳的擁有者都經模型版的路由視圖（S.infer.routingView），和路徑追蹤、可達性的 Q.routesOf／Q.hopOwner 同一份語意
  function unreachableNextHops(X, add) {
    const { M, name, RV, isExternal, entryName } = X;
    const ownerIn = (dev, vrf) => (ip) => { const o = RV.hopOwner(dev, ip, vrf); return o ? o.dev : null; };
    // 遞迴解析後仍到不了已知設備的下一跳才提醒；經由其他路由最終落在已知設備上的不算
    // 解析不到已知設備時依原因分開回報：迴圈（R03）、落入黑洞（R04）、其他（R01），同一個下一跳只報一種
    // R01 另排除出介面判定為對外的下一跳（ADR-023 決策 7：電信業者的閘道本來就不在基準內），訊息另外列出
    const badNh = { R01: new Map(), R03: new Map(), R04: new Map() }; const isp = new Map();
    M.routes.forEach((r) => r.active && r.nh.forEach((n) => {
      if (!n.ip) return;
      const res = resolveNextHop(RV.routesOf(r.dev, n.vrf), n.ip, ownerIn(r.dev, n.vrf));
      if (res.some((x) => x.status === 'known')) return;
      const id = res.some((x) => x.status === 'loop') ? 'R03' : res.some((x) => x.status === 'blackhole') ? 'R04' : 'R01';
      const out = RV.egress(r.dev, n);
      if (id === 'R01' && isExternal(out)) { S.util.getOr(isp, r.dev, () => new Map()).set(K.inVrf(n.ip, n.vrf), out); return; }
      S.util.getOr(badNh[id], r.dev, () => new Map()).set(K.inVrf(n.ip, n.vrf), r);
    }));
    const ispText = (dev) => { const m = isp.get(dev); return m ? `（另有 ${Array.from(m.entries()).map(([ip, ep]) => `${ip} 經對外介面 ${entryName(dev, ep)}`).join('、')}，是電信業者等外部的閘道，不列）` : ''; };
    Object.entries(badNh).forEach(([id, byDev]) => byDev.forEach((ips, dev) => add(id, `${name(dev)}：${Array.from(ips.keys()).join('、')}${id === 'R01' ? ispText(dev) : ''}`, [{ type: 'device', key: dev }],
      Array.from(ips.values()).map((r) => ({ block: r.block, line: r.line })))));
  }
  // DHCP 網路的閘道必須在該網段內
  function dhcpGatewayOutside(X, add) {
    const { M, name } = X;
    M.dhcpNets.forEach((n) => {
      const p = S.ip.parseCidr(n.network); if (!p) return;
      const bad = n.gateways.filter((g) => S.ip.isIp(g) && !S.ip.inNet(g, p.net, p.len));
      if (bad.length) add('R05', `${name(n.dev)}：${n.network} 的閘道 ${bad.join('、')} 不在網段內`, [{ type: 'device', key: n.dev }], [{ block: n.block, line: n.line }], { facet: `${p.net}/${p.len}` });
    });
  }
  // R02：OSPF 鄰居用位址、router-id、管理 IP 都對不到設備（建模時 peerBasis 為 null）
  // 訊息另寫本端介面所在的 OSPF area（路由網域，ADR-023 決策 7）：對端在同一個 area，往這個 area 的設備找；本端介面沒有對應的 interface-template 時另外註明
  function unknownOspfPeers(X, add) {
    const { M, name } = X;
    const areasOf = new Map(); // ep → Set(area-id)
    M.ospfHits.forEach((hits) => hits.forEach((h) => S.util.getOr(areasOf, h.ep, () => new Set()).add(h.areaId)));
    const hasTpl = new Set(M.routingCfgOut.ospfInterfaceTemplates.filter((t) => t.disabled !== true).map((t) => t.dev));
    const areaText = (a) => {
      const set = areasOf.get(a.localEp);
      if (set) return `，本端在 OSPF area ${Array.from(set).sort(S.util.natural).join('、')}`;
      return hasTpl.has(a.dev) ? '，本端介面沒有對應的 OSPF interface-template' : '';
    };
    M.ospfAdjacencies.forEach((a) => { if (!a.peerBasis) add('R02', `${name(a.dev)} ${K.splitEp(a.localEp)[1]} 的鄰居 ${a.peerId}（${a.peerIp}）${areaText(a)}`,
      [{ type: 'device', key: a.dev }, { type: 'device', key: K.dev(a.peerId) }], [{ block: a.block, line: a.line }], { facet: K.splitEp(a.localEp)[1] }); });
  }
  // ---- 路由（R07–R15，ADR-023 決策 8）：用對外邊界（model.boundaries）、路由網域與 OSPF 設定的推論；路由查表交給 S.trace 的單跳轉送決定
  //      （S.trace.lookup，以模型版的路由視圖 S.infer.routingView 呼叫，和路徑追蹤、可達性同一套判斷，不呼叫查詢層 Q）
  const lookupIn = (RV, dev, ip, vrf) => {
    if (!S.trace || !S.trace.lookup) throw new Error('src/query/trace.js 要在建立基準之前載入（R09、R10 用它的單跳轉送決定）');
    return S.trace.lookup(RV, dev, ip, vrf);
  };
  /** 查表的結果是不是只靠出介面判定為對外的路由（電信業者那一側），也就是在基準內沒有路由。 */
  const onlyExternal = (X, dev, lk) => lk.kind === 'route' && lk.nhs.every(({ n }) => X.isExternal(X.RV.egress(dev, n)));
  const hasRouteData = (M, d) => { const x = M.devices.get(d); return !!(x && x.collected && x.data.has('route')); };
  const ROUTE_DEFAULT_ADD = new Set(['yes', 'special-classless']);
  const isBackbone = (areaId) => areaId === '0.0.0.0' || areaId === '0';
  const srcEv = (src) => src.map(([block, line]) => ({ block, line }));
  /** 接在後面的文字前加空白；以全形括號結尾時不加（中文與英數之間的空白）。 */
  const spaced = (t) => (t.endsWith('）') ? t : t + ' ');

  /**
   * srcnat（masquerade／src-nat，啟用中、沒有限制目的位址）涵蓋的出介面：{ all }（有一條不限出介面）、{ unknown }（清單無法展開）或 { eps: Set }。
   * out-interface 與 out-interface-list 都寫時取交集；開頭的 ! 是「除了這些以外」（S.infer.fw.listMembers 的寫法）。
   */
  function srcnatCoverage(M, dev) {
    const fw = S.infer.fw; const ctx = M.fwCtx.get(dev);
    const rules = M.fw.rules.filter((r) => r.dev === dev && r.family === 'ip' && r.table === 'nat' && r.chain === 'srcnat' && !r.disabled
      && (r.action === 'masquerade' || r.action === 'src-nat') && r.match['dst-address'] === undefined && r.match['dst-address-list'] === undefined);
    const eps = new Set(); let unknown = false; let all = false;
    rules.forEach((r) => {
      const one = r.match['out-interface']; const list = r.match['out-interface-list'];
      if (one === undefined && list === undefined) { all = true; return; }
      let set = null;
      if (one !== undefined) { const { neg, body } = fw.splitNeg(one); const ep = K.ep(dev, body); set = new Set(neg ? Array.from(ctx.universe).filter((x) => x !== ep) : [ep]); }
      if (list !== undefined) {
        const s = fw.listMembers(ctx, list); if (s === null) { unknown = true; return; }
        set = set ? new Set(Array.from(set).filter((x) => s.has(x))) : s;
      }
      set.forEach((x) => eps.add(x));
    });
    return { rules, all, unknown, eps };
  }
  // R07：預設路由的出口（含備援、DHCP／PPPoE client 加入的）沒有 srcnat，而設備在其他出口做 NAT 上網
  function natExitMismatch(X, add) {
    const { M, name } = X;
    const byDev = new Map(); M.boundaries.forEach((b) => S.util.getOr(byDev, b.dev, () => []).push(b));
    const EXIT = new Set(['default-route', 'dhcp-client', 'pppoe-client']);
    byDev.forEach((bs, dev) => {
      if (!M.fwCtx.has(dev)) return;
      const cov = srcnatCoverage(M, dev);
      if (!cov.rules.length || cov.all || cov.unknown) return; // 沒有 NAT 上網、全部出口都做 NAT，或清單無法展開：不判斷
      const exits = bs.filter((b) => b.evidence.some((e) => EXIT.has(e.kind) && e.strength === 'strong'));
      const bad = exits.filter((b) => !cov.eps.has(b.ep));
      // 只在設備確實在某個對外介面做 NAT 上網時判斷（srcnat 只用在內部介面的，是其他用途）
      const natAt = Array.from(cov.eps).filter((ep) => X.isExternal(ep)).sort(S.util.natural).map((ep) => K.splitEp(ep)[1]);
      if (!bad.length || !natAt.length) return;
      const how = (b) => S.util.uniq(b.evidence.filter((e) => EXIT.has(e.kind) && e.strength === 'strong').map((e) => BOUNDARY_LABEL[e.kind])).join('、');
      const ev = []; bad.forEach((b) => b.evidence.filter((e) => EXIT.has(e.kind) && e.strength === 'strong').forEach((e) => ev.push(...srcEv(e.src))));
      cov.rules.forEach((r) => ev.push({ block: r.block, line: r.line }));
      add('R07', `${name(dev)}：預設路由的出口 ${bad.map((b) => `${K.splitEp(b.ep)[1]}（${how(b)}）`).join('、')}沒有 srcnat，masquerade／src-nat 只在 ${natAt.join('、')}；改由這個出口上網時，私有位址不會轉換`,
        [{ type: 'device', key: dev }].concat(bad.map((b) => ({ type: 'interface', key: b.ep }))), ev);
    });
  }

  // R08：WAN 清單與路由證據矛盾（推論）——有對外的強證據卻不在 WAN 清單；或在 WAN 清單、預設路由卻指向基準內的設備
  function wanListConflict(X, add) {
    const { M, epName } = X;
    M.boundaries.forEach((b) => {
      const ctx = M.fwCtx.get(b.dev); if (!ctx || !ctx.wanLists.length) return; // 沒有 WAN 清單時不是矛盾（F08 的範圍）
      const inList = !!(ctx.wan && ctx.wan.has(b.ep));
      const lists = ctx.wanLists.join('、');
      const strong = b.evidence.filter((e) => e.strength === 'strong');
      const listEv = b.evidence.filter((e) => e.kind === 'wan-list').flatMap((e) => srcEv(e.src));
      if (!inList && strong.length) {
        add('R08', `${epName(b.ep)}：${S.util.uniq(strong.map((e) => BOUNDARY_LABEL[e.kind])).join('、')}（判定對外），但不在 WAN 清單（${lists}）；依 WAN 清單的防火牆規則不會套用到這個介面`,
          [{ type: 'device', key: b.dev }, { type: 'interface', key: b.ep }], strong.flatMap((e) => srcEv(e.src)));
      } else if (inList && !strong.length) {
        const inside = b.evidence.filter((e) => e.kind === 'default-route' && e.ref && e.ref.reason === 'next-hop-in-baseline');
        if (!inside.length) return;
        add('R08', `${epName(b.ep)}：在 WAN 清單（${lists}），但預設路由的下一跳 ${S.util.uniq(inside.map((e) => e.ref.gateway)).join('、')} 是基準內的設備（指向內部）`,
          [{ type: 'device', key: b.dev }, { type: 'interface', key: b.ep }], listEv.concat(inside.flatMap((e) => srcEv(e.src))));
      }
    });
  }

  /**
   * dst-nat／netmap 規則轉送的目標（to-addresses 的第一個位址）在這台設備查得到什麼路由（S.trace.lookup，入介面的 VRF，沒有時 main）：
   * { ip, vrf, status: reached（直連或基準內的路由）｜no-route（沒有符合的路由）｜blackhole｜external（私有位址只符合經對外介面的路由，會送回外部）｜unknown（沒有路由表資料）, lk }。
   * 沒有 to-addresses 或不是 IPv4 時 null。F04 與 R09 共用。
   */
  const DNAT_NO_ROUTE = new Set(['no-route', 'blackhole', 'external']);
  function dnatTarget(X, r) {
    const { M, RV } = X;
    const t = r.params['to-addresses']; if (!t) return null;
    const ip = String(t).split('-')[0].split('/')[0];
    if (!S.ip.isIp(ip)) return null;
    const one = r.match['in-interface'];
    const inIfc = one !== undefined && !S.infer.fw.splitNeg(one).neg ? M.ifcs.get(K.ep(r.dev, one)) : null;
    const vrf = K.vrf(inIfc ? inIfc.vrf : K.MAIN_VRF);
    const lk = lookupIn(RV, r.dev, ip, vrf);
    const status = lk.kind === 'connected' ? 'reached' : lk.kind === 'no-route-data' ? 'unknown' : lk.kind === 'no-match' ? 'no-route' : lk.kind === 'blackhole' ? 'blackhole'
      : lk.kind === 'route' && onlyExternal(X, r.dev, lk) && S.ip.classify(ip) !== 'public' ? 'external' : 'reached';
    return { ip, vrf, status, lk };
  }
  // R09：dst-nat 的目標沒有路由（轉送後的連線到不了，F04 不列）
  function dnatNoRoute(X, add) {
    const { M, name } = X;
    M.fw.rules.forEach((r) => {
      if (r.disabled || r.family !== 'ip' || r.table !== 'nat' || r.chain !== 'dstnat' || !/^(dst-nat|netmap)$/.test(r.action)) return;
      const tgt = dnatTarget(X, r); if (!tgt || !DNAT_NO_ROUTE.has(tgt.status)) return;
      const lk = tgt.lk;
      const why = tgt.status === 'no-route' ? `${name(r.dev)} 沒有到 ${K.inVrf(tgt.ip, tgt.vrf)} 的路由`
        : tgt.status === 'blackhole' ? `${K.inVrf(tgt.ip, tgt.vrf)} 落入黑洞路由 ${lk.route}`
          : `${K.inVrf(tgt.ip, tgt.vrf)} 是私有位址，只符合經對外介面 ${S.util.uniq(lk.nhs.map(({ n }) => K.splitEp(X.RV.egress(r.dev, n))[1])).join('、')} 的路由 ${lk.route}，會被送回外部`;
      const routeEv = lk.kind === 'route' || lk.kind === 'blackhole' ? (lk.routes || []).filter((x) => `${x.prefix}/${x.len}` === lk.route).map((x) => ({ block: x.block, line: x.line })) : [];
      add('R09', `${ruleWhere(name, r)}（${ruleText(r)}）轉送到 ${r.params['to-addresses']}，但${/^[0-9]/.test(why) ? ' ' : ''}${why}`,
        [{ type: 'device', key: r.dev }, { type: 'rule', key: r.key }], [ruleEv(r)].concat(routeEv));
    });
  }

  /**
   * R10：只有去程、沒有回程（推論，網段間）。設備 X 有一條非直連、非預設的路由，涵蓋設備 Z（有路由表資料）的直連網段 B；
   * Z 對 X 的來源網段 A 查表（S.trace.lookup，同一個 VRF）是沒有路由、黑洞，或只有經對外介面的路由時，A → B 的連線回不來。
   * 來源網段 A：X 的直連網段中，遮罩 /29 以下（/30、/31 是轉送用的點對點鏈路，不當來源）、不在對外介面上、Z 自己沒有直連的。
   * 只看第一跳（Z 自己的路由表）；回程經過其他設備時，之後的路由不判斷。每一組 X、Z 一筆。
   */
  function missingReturnRoutes(X, add) {
    const { M, name, RV, isExternal } = X;
    const devs = Array.from(M.devices.keys()).filter((d) => hasRouteData(M, d)).sort(S.util.natural);
    const byVrf = new Map();
    devs.forEach((d) => RV.subnetsOf(d).forEach((s) => S.util.getOr(byVrf, s.vrf, () => []).push({ s, start: S.ip.toInt(s.net) })));
    byVrf.forEach((list) => list.sort((a, b) => a.start - b.start));
    const hasNet = (d, s) => RV.subnetsOf(d, s.vrf).some((x) => x.net === s.net && x.len === s.len);
    const pairs = new Map();
    devs.forEach((x) => RV.routesOf(x).forEach((r) => {
      if (r.len === 0 || r.blackhole || r.proto === 'Direct' || r.vrf === null || !r.nh.some((n) => n.ip)) return;
      if (r.nh.every((n) => isExternal(RV.egress(x, n)))) return;
      const lo = S.ip.toInt(r.prefix); const hi = lo + 2 ** (32 - r.len) - 1;
      const list = byVrf.get(r.vrf) || [];
      let i = 0; let a = 0; let b = list.length; while (a < b) { const m = (a + b) >> 1; if (list[m].start < lo) a = m + 1; else b = m; } i = a;
      for (; i < list.length && list[i].start <= hi; i++) {
        const s = list[i].s;
        if (s.dev === x || s.len < r.len || hasNet(x, s)) continue;
        const p = S.util.getOr(pairs, x + '\u0000' + s.dev + '\u0000' + r.vrf, () => ({ x, z: s.dev, vrf: r.vrf, routes: [], dsts: [] }));
        if (!p.routes.includes(r)) p.routes.push(r);
        if (!p.dsts.includes(s.prefix)) p.dsts.push(s.prefix);
      }
    }));
    Array.from(pairs.values()).sort((p, q) => S.util.natural(p.x, q.x) || S.util.natural(p.z, q.z) || S.util.natural(p.vrf, q.vrf)).forEach((p) => {
      const sources = RV.subnetsOf(p.x, p.vrf).filter((s) => s.len <= 29 && !isExternal(s.ep) && !hasNet(p.z, s));
      const missing = [];
      sources.forEach((s) => {
        const lk = lookupIn(RV, p.z, s.ip, p.vrf);
        const why = lk.kind === 'no-match' ? '沒有路由' : lk.kind === 'blackhole' ? `落入黑洞路由 ${lk.route}` : lk.kind === 'route' && onlyExternal(X, p.z, lk) ? `只有經對外介面的 ${lk.route}` : null;
        if (why && !missing.some((m) => m.prefix === s.prefix)) missing.push({ prefix: s.prefix, why });
      });
      if (!missing.length) return;
      add('R10', `${name(p.x)} 有到 ${name(p.z)} 的 ${p.dsts.sort(S.util.natural).join('、')} 的路由（${p.routes.map((r) => K.inVrf(`${r.prefix}/${r.len}`, r.vrf)).join('、')}），但 ${name(p.z)} 回到 ${name(p.x)} 的 ${missing.map((m) => `${m.prefix}（${m.why}）`).join('、')}；這些網段之間的連線只有去程`,
        [{ type: 'device', key: p.x }, { type: 'device', key: p.z }], p.routes.map((r) => ({ block: r.block, line: r.line })));
    });
  }

  /**
   * R11：同一張路由表有兩條以上預設路由（含非作用中的備援、DHCP client 加入的），其中有沒有設 check-gateway 的。
   * 預設路由來自路由表（所有路由，含非作用中）與 /ip dhcp-client、/interface pppoe-client 的 add-default-route（路由表中同一個出介面的
   * DHCP／PPPoE 路由不重複算）。PPPoE 沒有 check-gateway 參數，斷線時介面停用、路由跟著失效（推論，無法以手冊確認），只計數、不列為缺少。
   */
  function multiDefaultNoCheck(X, add) {
    const { M, name, RV } = X;
    const byDev = new Map(); const put = (dev, x) => S.util.getOr(S.util.getOr(byDev, dev, () => new Map()), x.table, () => []).push(x);
    const clientEps = new Set();
    M.routingCfgOut.dhcpClients.forEach((c) => {
      if (!c.ep || c.disabled === true || !ROUTE_DEFAULT_ADD.has(c.addDefaultRoute)) return;
      clientEps.add(c.ep); put(c.dev, { table: K.MAIN_VRF, text: `DHCP client ${K.splitEp(c.ep)[1]}`, check: c.checkGateway, monitored: false, src: c.src });
    });
    M.routingCfgOut.pppoeClients.forEach((c) => {
      if (!c.ep || c.disabled !== false || c.addDefaultRoute !== true) return;
      clientEps.add(c.ep); put(c.dev, { table: K.MAIN_VRF, text: `PPPoE client ${K.splitEp(c.ep)[1]}`, check: null, monitored: true, src: c.src });
    });
    M.routes.forEach((r) => {
      if (r.len !== 0 || r.blackhole) return;
      const outs = r.nh.map((n) => RV.egress(r.dev, n));
      if (outs.length && outs.every((ep) => ep && clientEps.has(ep))) return;
      const gw = r.nh.map((n) => n.ip || n.ifc).filter(Boolean).join(',');
      put(r.dev, { table: K.vrf(r.routingTable), text: `gateway=${gw}${r.active ? '' : '（非作用中）'}`, check: r.checkGateway, monitored: false, src: [[r.block, r.line]] });
    });
    Array.from(byDev.keys()).sort(S.util.natural).forEach((dev) => {
      const parts = []; const ev = [];
      Array.from(byDev.get(dev).entries()).sort((a, b) => S.util.natural(a[0], b[0])).forEach(([table, list]) => {
        if (list.length < 2) return;
        const bad = list.filter((x) => !x.check && !x.monitored); if (!bad.length) return;
        parts.push(`路由表 ${table} 有 ${list.length} 條預設路由，${spaced(bad.map((x) => x.text).join('、'))}沒有設 check-gateway`);
        bad.forEach((x) => ev.push(...srcEv(x.src)));
      });
      if (parts.length) add('R11', `${name(dev)}：${parts.join('；')}；閘道失效但介面仍在時，路由不會自動切換`, [{ type: 'device', key: dev }], ev);
    });
  }

  /**
   * R12：網段沒有任何路由可以到達（推論）。一台設備的直連網段，基準中其他有路由表資料的設備（同一個 VRF）都沒有直連、也沒有非預設的路由涵蓋它
   * （預設路由不算：只是「其他地方」，不代表知道這個網段；路由的閘道跨 VRF 對應到這台設備時算在它的 VRF）。
   * 不檢查：其他設備也直連的網段（鏈路）、/31 與 /32、對外或可能對外的介面、有 OSPF 鄰接的介面，以及同一個 VRF 沒有其他設備有路由表資料時。
   */
  function unreachableSubnets(X, add) {
    const { M, name, RV, boundaryOf } = X;
    const known = new Map(); // len → Map(`${vrf}|${網路位址的整數}` → Set(設備))
    const mark = (vrf, net, len, dev) => S.util.getOr(S.util.getOr(known, len, () => new Map()), vrf + '|' + ((S.ip.toInt(net) & S.ip.maskOf(len)) >>> 0), () => new Set()).add(dev);
    const routers = new Map(); // vrf → Set(有路由表資料的設備)
    Array.from(M.devices.keys()).filter((d) => hasRouteData(M, d)).forEach((d) => {
      RV.subnetsOf(d).forEach((s) => { mark(s.vrf, s.net, s.len, d); S.util.getOr(routers, s.vrf, () => new Set()).add(d); });
      RV.routesOf(d).forEach((r) => {
        if (r.len === 0 || r.blackhole || r.vrf === null) return;
        mark(r.vrf, r.prefix, r.len, d); S.util.getOr(routers, r.vrf, () => new Set()).add(d);
        r.nh.forEach((n) => { if (!n.ip) return; const o = RV.hopOwner(d, n.ip, n.vrf); if (o && o.crossVrf) mark(o.vrf, r.prefix, r.len, d); });
      });
    });
    const shared = new Map(); M.devices.forEach((_, d) => RV.subnetsOf(d).forEach((s) => S.util.getOr(shared, s.net + '/' + s.len, () => new Set()).add(d)));
    const ospfEps = new Set(M.ospfAdjacencies.map((a) => a.localEp));
    Array.from(M.devices.values()).filter((d) => d.collected).map((d) => d.key).sort(S.util.natural).forEach((z) => {
      const hits = RV.subnetsOf(z).filter((s) => {
        if (s.len > 30 || shared.get(s.net + '/' + s.len).size > 1 || boundaryOf.has(s.ep) && boundaryOf.get(s.ep).status !== 'internal' || ospfEps.has(s.ep)) return false;
        const others = Array.from(routers.get(s.vrf) || []).filter((d) => d !== z);
        if (!others.length) return false;
        for (let len = s.len; len >= 1; len--) {
          const m = known.get(len); const set = m && m.get(s.vrf + '|' + ((S.ip.toInt(s.net) & S.ip.maskOf(len)) >>> 0));
          if (set && Array.from(set).some((d) => d !== z)) return false;
        }
        return true;
      });
      if (!hits.length) return;
      const ev = hits.map((s) => { const i = M.ifcs.get(s.ep); const src = i && i.ips.get(`${s.ip}/${s.len}`); return src ? { block: src[0], line: src[1] } : null; }).filter(Boolean);
      add('R12', `${name(z)}：${hits.map((s) => `${s.prefix}（${K.splitEp(s.ep)[1]}）`).join('、')}；其他有路由表的設備都沒有到這些網段的路由（預設路由不算）`, [{ type: 'device', key: z }], ev);
    });
  }

  /**
   * R13：OSPF area 不一致（路由網域，model/infer.js 的 routingDomains 與 M.ospfHits）：
   *   link：同一個網段在不同設備比對到不同的 area-id（兩端不同 area 不會建立鄰接；passive 的一端也表示這個網段被放進兩個 area）。
   *   area：OSPF 鄰接相連的一組設備有兩個以上 area，卻沒有骨幹 area 0（0.0.0.0）——非骨幹 area 要接到骨幹（手冊 areas-and-virtual-links）。
   * area-id 沒有寫出（只有 area 名稱）時，名稱只在設備內有意義，不比較。
   */
  function ospfAreaMismatch(X, add) {
    const { M, name } = X;
    Array.from(M.ospfHits.keys()).sort(S.util.natural).forEach((key) => {
      const hits = M.ospfHits.get(key);
      if (hits.some((h) => !h.areaIdKnown)) return;
      const byDev = new Map(); hits.forEach((h) => { if (!byDev.has(h.dev)) byDev.set(h.dev, h); });
      const ids = S.util.uniq(Array.from(byDev.values()).map((h) => h.areaId));
      if (byDev.size < 2 || ids.length < 2) return;
      const devs = Array.from(byDev.keys()).sort(S.util.natural);
      add('R13', `${key} 在不同設備屬於不同的 OSPF area：${devs.map((d) => `${name(d)} area ${byDev.get(d).areaId}`).join('；')}`,
        devs.map((d) => ({ type: 'device', key: d })), devs.flatMap((d) => srcEv(byDev.get(d).src)), { facet: 'link|' + key });
    });
    const groups = new Map(); // group → Map(areaId → [hit])
    const unknown = new Set();
    M.ospfHits.forEach((hits) => hits.forEach((h) => { if (!h.areaIdKnown) unknown.add(h.group); S.util.getOr(S.util.getOr(groups, h.group, () => new Map()), h.areaId, () => []).push(h); }));
    Array.from(groups.keys()).sort(S.util.natural).forEach((g) => {
      const areas = groups.get(g);
      if (unknown.has(g) || areas.size < 2 || Array.from(areas.keys()).some(isBackbone)) return;
      Array.from(areas.keys()).sort(S.util.natural).forEach((id) => {
        const hs = areas.get(id); const devs = S.util.uniq(hs.map((h) => h.dev)).sort(S.util.natural);
        add('R13', `${name(g)} 一組（OSPF 鄰接相連的設備）的 area ${id} 沒有接到骨幹 area 0：這一組有 area ${Array.from(areas.keys()).sort(S.util.natural).join('、')}，沒有 0.0.0.0`,
          devs.map((d) => ({ type: 'device', key: d })), S.util.uniq(hs.map((h) => h.src[0].join(':'))).map((k) => { const [block, line] = k.split(':').map(Number); return { block, line }; }), { facet: `area|${g}|${id}` });
      });
    });
  }

  /** interface-template 在訊息中的寫法：interfaces=…、networks=…（原值）。 */
  const tplText = (t) => [t.interfaces.length ? `interfaces=${t.interfaces.join(',')}` : null, t.networks.length ? `networks=${t.networks.join(',')}` : null].filter(Boolean).join(' ') || `area=${t.area}`;
  // R14：OSPF interface-template（啟用中、不是 passive）沒有設驗證（auth），或設了 auth 卻沒有 auth-key
  function ospfNoAuth(X, add) {
    const { M, name } = X;
    const byDev = new Map();
    M.routingCfgOut.ospfInterfaceTemplates.forEach((t) => { if (t.disabled !== true && t.area && !t.passive && (!t.auth || !t.authKey)) S.util.getOr(byDev, t.dev, () => []).push(t); });
    Array.from(byDev.keys()).sort(S.util.natural).forEach((dev) => {
      const ts = byDev.get(dev);
      add('R14', `${name(dev)}：OSPF interface-template ${ts.map((t) => `${tplText(t)}（${t.auth ? `auth=${t.auth} 沒有設 auth-key` : '沒有設 auth'}）`).join('、')}；同一個網段上的任何設備都可以送 OSPF 封包加入路由`,
        [{ type: 'device', key: dev }], ts.flatMap((t) => srcEv(t.src)));
    });
  }

  /**
   * R15：使用者網段的介面跑 OSPF 卻沒有設 passive。使用者網段（推論）：有 /ip dhcp-server network 的網段，或有終端的網段
   * （ARP 的位址在這個網段、它的 MAC 出現在終端埠，M.edge）。只有這台設備在這個網段送 OSPF（其他設備比對到的 template 都是 passive），
   * 而且介面上沒有 OSPF 鄰接時才報；兩台以上設備在這個網段送 OSPF、其中有設備沒有 OSPF 鄰居資料時，可能是刻意的鄰接，不報。
   */
  function userSubnetNotPassive(X, add) {
    const { M, name, RV, edge } = X;
    const why = new Map(); // 網段鍵 → { dhcp: [證據], host: bool }
    M.dhcpNets.forEach((n) => { const p = S.ip.parseCidr(n.network); if (p) S.util.getOr(why, K.inVrf(`${p.net}/${p.len}`, n.vrf), () => ({ dhcp: [], host: false })).dhcp.push({ block: n.block, line: n.line }); });
    const edgeMacs = new Set(); edge.forEach((_, ep) => { const i = M.ifcs.get(ep); if (i) i.macs.forEach((m) => edgeMacs.add(m)); });
    M.arps.forEach((a) => {
      if (!edgeMacs.has(a.mac)) return;
      RV.subnetsOf(a.dev, a.vrf).filter((s) => S.ip.inNet(a.ip, s.net, s.len)).forEach((s) => { S.util.getOr(why, s.prefix, () => ({ dhcp: [], host: false })).host = true; });
    });
    const adjEps = new Set(M.ospfAdjacencies.map((a) => a.localEp));
    const ospfData = (d) => { const x = M.devices.get(d); return !!(x && x.data.has('ospf')); };
    const byDev = new Map();
    Array.from(M.ospfHits.keys()).sort(S.util.natural).forEach((key) => {
      const w = why.get(key); if (!w) return;
      const speakers = M.ospfHits.get(key).filter((h) => !h.tpl.passive);
      if (!speakers.length || speakers.some((h) => adjEps.has(h.ep))) return;
      const devs = S.util.uniq(speakers.map((h) => h.dev));
      if (devs.length > 1 && devs.some((d) => !ospfData(d))) return;
      speakers.forEach((h) => { const list = S.util.getOr(byDev, h.dev, () => []); if (!list.some((x) => x.key === key)) list.push({ key, h, w }); });
    });
    Array.from(byDev.keys()).sort(S.util.natural).forEach((dev) => {
      const list = byDev.get(dev);
      const basis = (w) => [w.dhcp.length ? '有 DHCP server' : null, w.host ? '有終端' : null].filter(Boolean).join('、');
      add('R15', `${name(dev)}：${list.map((x) => `${x.key}（${K.splitEp(x.h.ep)[1]}，${basis(x.w)}）`).join('、')}是使用者網段，比對到的 OSPF interface-template（${S.util.uniq(list.map((x) => tplText(x.h.tpl))).join('、')}）沒有設 passive`,
        [{ type: 'device', key: dev }], list.flatMap((x) => srcEv(x.h.src).concat(x.w.dhcp.slice().sort(X.evCmp).slice(0, 1))));
    });
  }

  // L01：RouterBOOT 韌體 current 與 upgrade 不同（手冊：upgrade-firmware 是設備上找到的最新韌體檔，要手動套用）
  function firmwarePending(X, add) {
    const { M, name } = X;
    M.devices.forEach((d) => {
      const rb = d.routerboard;
      if (!d.collected || !rb || !rb.isRouterboard || !rb.currentFirmware || !rb.upgradeFirmware || rb.currentFirmware === rb.upgradeFirmware) return;
      add('L01', `${name(d.key)}：RouterBOOT 韌體 ${rb.currentFirmware}，可套用 ${rb.upgradeFirmware}`, [{ type: 'device', key: d.key }],
        ['currentFirmware', 'upgradeFirmware'].map((k) => d.routerboardLines[k]).map((x) => ({ block: x[0], line: x[1] })));
    });
  }

  /**
   * 跨設備組態一致性：同質不同名（V06、A07、A11）與同名不同值（V07、A06、A08、A09、A10、A12、R06）。
   * 只看已收集設備自己的設定（排除鄰居宣告的介面）；名稱比對 trim＋不分大小寫，值以集合比較（順序不計）。
   * 以 VLAN ID 為鍵的檢查（V06、A06）只比同一個 VLAN 區塊；以網段、IP 為鍵的檢查（A07、A08、A09、R06）只比同一個 VRF（不同設備上同名的 VRF
   * 視為同一個位址空間，ADR-015），鍵與 facet 用 K.inVrf（main 不加後綴）；以名稱為鍵的檢查（V07、A10–A12）與 VRF 無關，整份基準一起比。
   * 訊息依設備名稱自然排序，相同設定的設備併成一組。
   * 除 A09（重複 IP 本身就是衝突）外，各檢查以多數決判定與多數不同的設備（推論），只寫在 finding.deviation；訊息只列各組設定，不附推定結果（畫面另起一行顯示，避免重複）。
   * consistencyKit 是這些檢查共用的分組、多數決、訊息格式與介面清單（prep 建立一次，放在 X.cc）；各檢查的函式在後面。
   */
  const MAX_SHOWN = 8; // 訊息中每台設備最多列出的值，避免大型 address-list 讓訊息過長
  function consistencyKit(M, name) {
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
     * 多數決（推論）：台數最多的一組至少 2 台且多於其他每一組時成立，其餘各組的設備與多數不同。
     * 回傳 { main, deviating: [devKey，依名稱自然排序] }；平手或最多只有 1 台時回傳 null。
     */
    const majorityOf = (groups) => {
      const sorted = groups.slice().sort((a, b) => b.devs.length - a.devs.length);
      const main = sorted[0];
      if (!main || main.devs.length < 2 || (sorted[1] && sorted[1].devs.length >= main.devs.length)) return null;
      return { main, deviating: groups.filter((g) => g !== main).flatMap((g) => g.devs).sort(byName) };
    };
    /**
     * finding 的 deviation 欄位（平手時 deviating 為空陣列、main 為 null）。
     * groups：多數決實際用的分組（groupDevs 的結果，順序相同）；value 是該組第一台設備的顯示值（依它的設定順序），
     * key 是同位置的正規化比對值，devs 依名稱自然排序。main 是多數組在 groups 的索引。
     */
    const judge = (groups) => {
      const m = majorityOf(groups);
      return {
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
    // 已收集設備自己的介面（A08、A09）
    const ownIfcs = Array.from(M.ifcs.values()).filter(own).sort((a, b) => byName(a.dev, b.dev) || nat(a.name, b.name));
    const ifcNets = (i) => Array.from(i.ips.entries()).map(([c, src]) => ({ p: S.ip.parseCidr(c), src })).filter((x) => x.p && x.p.len < 32);
    const pfx = (p) => `${p.net}/${p.len}`;
    return { U, nat, byName, norm, ev, show, quote, fmtVlanIds, collected, groupDevs, devList, judge, fmtGroups, interleave, evByGroups, put, vlanIfcs, ownIfcs, ifcNets, pfx };
  }

  // ---- V06／V07：VLAN 的名稱與說明（三種屬性分開比；兩條檢查共用同一份屬性清單）
  function vlanAttrConsistency(X, add) {
    const { M, byDomain } = X;
    const { U, nat, byName, norm, ev, quote, fmtVlanIds, collected, groupDevs, judge, fmtGroups, evByGroups, put, vlanIfcs } = X.cc;
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
          add('V06', `VLAN ${id} 的 ${attr}：${fmtGroups(groups, quote)}`, entsOf(sel, [{ type: 'vlan', key: String(id) }]), evByGroups(groups, sel, (x) => x.dev, (x) => evsOf([x])), Object.assign({ facet: ATTR_FACET[attr] }, j.extra));
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
        add('V07', `${attr}「${sel[0].val}」：${fmtGroups(groups, fmtVlanIds)}`, entsOf(sel, ids.map((id) => ({ type: 'vlan', key: String(id) }))), evByGroups(groups, sel, (x) => x.dev, (x) => evsOf([x])), Object.assign({ facet: ATTR_FACET[attr] + '|' + k }, j.extra));
      });
    });
  }

  // ---- A06／A07：VLAN 介面上的網段（兩條檢查共用同一份網段清單）
  function vlanSubnetConsistency(X, add) {
    const { M, byDomain } = X;
    const { U, nat, byName, ev, show, fmtVlanIds, groupDevs, judge, fmtGroups, evByGroups, put, vlanIfcs, ifcNets, pfx } = X.cc;
    // A06：同一 VLAN（同一區塊）各設備 VLAN 介面上的網段
    const netItems = [];
    vlanIfcs.forEach((i) => ifcNets(i).forEach(({ p, src }) => netItems.push({ id: i.encapVlan, dev: i.dev, ep: i.key, p, src })));
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
        add('A06', `VLAN ${id}${mask ? ' 網段重疊但遮罩不同' : ''}：${fmtGroups(groups, show)}`,
          [{ type: 'vlan', key: String(id) }].concat(U.uniq(sel.map((x) => x.ep)).map((key) => ({ type: 'interface', key }))), evByGroups(groups, sel, (x) => x.dev, (x) => [ev(x.src)]), j.extra);
      });
    });

    // A07：同一網段在不同設備屬於不同 VLAN（只看 VLAN 介面；同一個 VRF 內比較）
    const byNet = new Map(); netItems.forEach((x) => U.getOr(byNet, K.inVrf(pfx(x.p), M.ifcs.get(x.ep).vrf), () => []).push(x));
    Array.from(byNet.keys()).sort(nat).forEach((net) => {
      const sel = byNet.get(net);
      const perDev = new Map(); sel.forEach((x) => put(perDev, x.dev, x.id, x.id));
      const groups = groupDevs(perDev);
      if (groups.length < 2) return;
      const j = judge(groups);
      add('A07', `${net}：${fmtGroups(groups, fmtVlanIds)}`, U.uniq(sel.map((x) => x.ep)).map((key) => ({ type: 'interface', key })), evByGroups(groups, sel, (x) => x.dev, (x) => [ev(x.src)]), Object.assign({ facet: net }, j.extra));
    });
  }

  // ---- A08／A09：所有直連位址（含非 VLAN 介面；同一個 VRF 內比較，鍵與 facet 用 K.inVrf）
  function overlappingPrefixes(X, add) {
    const { U, byName, ev, devList, groupDevs, judge, interleave, put, ownIfcs, ifcNets, pfx } = X.cc;
    const prefixes = new Map();
    ownIfcs.forEach((i) => ifcNets(i).forEach(({ p, src }) => {
      const key = K.inVrf(pfx(p), i.vrf);
      const e = U.getOr(prefixes, key, () => ({ key, vrf: i.vrf, p, start: S.ip.toInt(p.net), end: S.ip.toInt(p.net) + 2 ** (32 - p.len) - 1, devs: new Map() }));
      if (!e.devs.has(i.dev)) e.devs.set(i.dev, { ep: i.key, src });
    }));
    // CIDR 網段只會互相包含或不相交：依 VRF、起點排序後，同一個 VRF 中被最外層網段涵蓋的為同一組
    const vrfRank = (v) => (v === K.MAIN_VRF ? '' : '\u0001' + v);
    const sorted = Array.from(prefixes.values()).sort((a, b) => U.cmp(vrfRank(a.vrf), vrfRank(b.vrf)) || a.start - b.start || a.p.len - b.p.len);
    for (let i = 0; i < sorted.length;) {
      const top = sorted[i]; let j = i + 1;
      while (j < sorted.length && sorted[j].vrf === top.vrf && sorted[j].start <= top.end) j++;
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
      // 路由網域（ADR-023 決策 2、7；有 OSPF 網域時才寫，只有靜態與直連時每台各一組，沒有資訊）：重疊的網段在不同網域時，各網域把不同的遮罩當成自己的範圍；在同一個網域時，較長的遮罩會蓋過較短的
      const doms = list.map((x) => X.domainOf.get(x.key) || null);
      const domText = (d) => (d.kind === 'ospf' ? ` OSPF area ${d.areaId}（${X.name(d.group)}）` : `靜態與直連路由（${X.name(d.group)}）`);
      const known = doms.filter(Boolean);
      const domNote = known.length < 2 || !known.some((d) => d.kind === 'ospf') ? '' : new Set(known.map((d) => d.key)).size === 1 ? `；同在路由網域${domText(known[0])}`
        : `；分屬不同路由網域：${list.map((x, k) => (doms[k] ? `${x.key} 在${domText(doms[k])}` : null)).filter(Boolean).join('、')}`;
      add('A08', (parts.length === 2 ? parts.join('與 ') : parts.join('、')) + domNote, locsBy.flat().map((l) => ({ type: 'interface', key: l.ep })), interleave(locsBy).map((l) => ev(l.src)), Object.assign({ facet: list[0].key }, jd.extra)); // facet：最外層的網段
    }
  }
  function duplicateIps(X, add) {
    const { epName } = X;
    const { U, nat, byName, ev, ownIfcs } = X.cc;
    const byIp = new Map();
    ownIfcs.forEach((i) => {
      if (i.rawType === 'vrrp') return; // VRRP 虛擬位址本來就由多台設備共用
      i.ips.forEach((src, c) => { const p = S.ip.parseCidr(c); if (p) U.getOr(U.getOr(byIp, K.inVrf(p.ip, i.vrf), () => new Map()), i.dev, () => []).push({ ep: i.key, src }); });
    });
    Array.from(byIp.keys()).sort(nat).forEach((ip) => {
      const perDev = byIp.get(ip); if (perDev.size < 2) return; // 同一台設備重複不在此列
      const locs = Array.from(perDev.keys()).sort(byName).flatMap((d) => perDev.get(d));
      add('A09', `${ip}：${locs.map((l) => epName(l.ep)).join('、')}`, [{ type: 'ip', key: ip }].concat(locs.map((l) => ({ type: 'interface', key: l.ep }))), locs.map((l) => ev(l.src)));
    });
  }

  // ---- R06：同一 DHCP 網段的閘道、DNS、NTP（只比有設定該項的設備）
  function dhcpOptionConsistency(X, add) {
    const { M } = X;
    const { U, nat, byName, norm, show, groupDevs, judge, fmtGroups, evByGroups, put, pfx } = X.cc;
    const dhcpBy = new Map();
    M.dhcpNets.forEach((n) => { const p = S.ip.parseCidr(n.network); U.getOr(dhcpBy, K.inVrf(p ? pfx(p) : norm(n.network), n.vrf), () => []).push(n); });
    Array.from(dhcpBy.keys()).sort(nat).forEach((net) => {
      const nets = dhcpBy.get(net);
      [['閘道', 'gateways', 'gateway'], ['DNS', 'dns', 'dns'], ['NTP', 'ntp', 'ntp']].forEach(([label, k, facet]) => {
        const sel = nets.filter((n) => n[k] && n[k].length);
        const perDev = new Map(); sel.forEach((n) => n[k].forEach((v) => put(perDev, n.dev, norm(v), v)));
        const groups = groupDevs(perDev);
        if (groups.length < 2) return;
        const j = judge(groups);
        add('R06', `${net} ${label}：${fmtGroups(groups, show)}`, U.uniq(sel.map((n) => n.dev)).sort(byName).map((key) => ({ type: 'device', key })), evByGroups(groups, sel, (n) => n.dev, (n) => [{ block: n.block, line: n.line }]), Object.assign({ facet: facet + '|' + net }, j.extra));
      });
    });
  }

  // ---- A10／A11：名稱 ↔ IP 設定（同一選單內比較；兩條檢查共用同一份設定清單）
  function ipBindConsistency(X, add) {
    const { M } = X;
    const { U, nat, byName, show, quote, collected, groupDevs, devList, judge, fmtGroups, evByGroups, put } = X.cc;
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
      add('A10', `${sel[0].section}「${sel[0].name}」的 ${diff.join('，')}：${fmtGroups(groups, show)}`,
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
      add('A11', `${sel[0].section} ${sel[0].value}：${fmtGroups(groups, quote)}`,
        Array.from(perDev.keys()).sort(byName).map((key) => ({ type: 'device', key })), evByGroups(groups, sel, (b) => b.dev, (b) => [{ block: b.block, line: b.line }]), Object.assign({ facet: sel[0].section + '|' + sel[0].valueKey }, j.extra));
    });
  }

  // ---- L02：同型號（/system resource 的 board-name）的 RouterOS 版本；只比設備自報的型號與版本（鄰居回報的不算），
  // 版本比較去掉發布頻道（7.25.1 (stable) 與 7.25.1 相同），顯示原值
  function versionConsistency(X, add) {
    const { M } = X;
    const { U, nat, byName, norm, ev, show, groupDevs, judge, fmtGroups, evByGroups, put } = X.cc;
    const verKey = (v) => norm(String(v).replace(/\s*\([^)]*\)\s*$/, ''));
    const byModel = new Map();
    Array.from(M.devices.values()).filter((d) => d.collected && d.boardSrc && d.versionSrc && d.deviceType && d.softwareVersion)
      .forEach((d) => U.getOr(byModel, norm(d.deviceType), () => []).push(d));
    Array.from(byModel.keys()).sort(nat).forEach((mk) => {
      const sel = byModel.get(mk).sort((a, b) => byName(a.key, b.key));
      const perDev = new Map(); sel.forEach((d) => put(perDev, d.key, verKey(d.softwareVersion), d.softwareVersion));
      const groups = groupDevs(perDev);
      if (groups.length < 2) return;
      const j = judge(groups);
      add('L02', `型號 ${sel[0].deviceType} 的 RouterOS 版本：${fmtGroups(groups, show)}`, sel.map((d) => ({ type: 'device', key: d.key })),
        evByGroups(groups, sel, (d) => d.key, (d) => [ev(d.versionSrc)]), j.extra);
    });
  }

  // ---- A12：設備層級的 DNS／NTP 伺服器
  function serverConsistency(X, add) {
    const { M } = X;
    const { byName, norm, ev, show, groupDevs, judge, fmtGroups, evByGroups, put } = X.cc;
    const collectedDevs = Array.from(M.devices.values()).filter((d) => d.collected);
    [['DNS 伺服器', 'dnsServers', 'dns'], ['NTP 伺服器', 'ntpServers', 'ntp']].forEach(([label, k, facet]) => {
      const sel = collectedDevs.filter((d) => d[k] && d[k].values.length);
      const perDev = new Map(); sel.forEach((d) => d[k].values.forEach((v) => put(perDev, d.key, norm(v), v)));
      const groups = groupDevs(perDev);
      if (groups.length < 2) return;
      sel.sort((a, b) => byName(a.key, b.key));
      const j = judge(groups);
      add('A12', `${label}：${fmtGroups(groups, show)}`, sel.map((d) => ({ type: 'device', key: d.key })), evByGroups(groups, sel, (d) => d.key, (d) => d[k].src.map(ev)), Object.assign({ facet }, j.extra));
    });
  }

  /**
   * 單一埠學到過多 MAC：已收集設備上的有線、非虛擬、非中斷介面，學到超過 MANY_MACS 個外部 MAC，
   * 且本身（含所屬聚合與成員）沒有任何 LLDP／CDP 介面鄰接，通常是下掛非網管型交換器或 hypervisor。
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

  /**
   * 命中次數各表的對應結果：{ matched, mismatch }（表數）；這台設備沒有收集命中次數時為 null。
   * 只用在有 export 的設備（coverage[].firewall 不是 null），所以不會有 no-export；
   * 沒有 export、只有命中次數的設備由 Q.firewallStatsOf(dev) 的 status: 'no-export' 呈現。
   */
  function statsOf(M, dev) {
    const ts = Array.from(M.fw.stats.values()).filter((t) => t.dev === dev);
    if (!ts.length) return null;
    return { matched: ts.filter((t) => t.status === 'matched').length, mismatch: ts.filter((t) => t.status === 'mismatch').length };
  }
  /** F09：命中次數對不上 export 的規則（整個表不配，不猜）。 */
  const STAT_WHY = {
    count: (r) => `去掉動態（D）列後有 ${r.stats} 列，export 有 ${r.export} 條規則`,
    chain: (r) => `第 ${r.position} 列的 chain 是 ${r.stats}，export 第 ${r.position} 條是 ${r.export}`,
    action: (r) => `第 ${r.position} 列的 action 是 ${r.stats}，export 第 ${r.position} 條是 ${r.export}`,
    disabled: (r) => `第 ${r.position} 列${r.stats ? '是' : '不是'}停用（X），export 第 ${r.position} 條${r.export ? '是' : '不是'} disabled=yes`,
    comment: (r) => `第 ${r.position} 列的註解（${r.stats || '無'}）與 export 第 ${r.position} 條（${r.export || '無'}）不同`,
  };
  /** 每台設備一筆（同一台設備的多個表併在訊息裡，findingKey 不會碰撞），依位址族、表的順序。 */
  function firewallStats({ M, name }, add) {
    const FAM = { ip: 'IPv4', ipv6: 'IPv6' }; const ORDER = ['ip|filter', 'ip|nat', 'ip|raw', 'ipv6|filter', 'ipv6|raw'];
    const byDev = new Map();
    M.fw.stats.forEach((t) => { if (t.status === 'mismatch') S.util.getOr(byDev, t.dev, () => []).push(t); });
    byDev.forEach((ts, dev) => {
      ts.sort((a, b) => ORDER.indexOf(a.family + '|' + a.table) - ORDER.indexOf(b.family + '|' + b.table));
      const ev = [];
      ts.forEach((t) => {
        const r = t.reason; const e = [r.row, r.rule].filter(Boolean).map(([block, line]) => ({ block, line }));
        ev.push(...(e.length ? e : t.line !== null ? [{ block: t.block, line: t.line }] : []));
      });
      add('F09', `${name(dev)}：${ts.map((t) => `${FAM[t.family]} ${t.table} 的命中次數全部不採用（${STAT_WHY[t.reason.code](t.reason)}）`).join('；')}`,
        [{ type: 'device', key: dev }], ev);
    });
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
      // 防火牆：有設定資料的設備才有；wan 是 WAN 分類的狀態（ok／no-wan-list／empty-wan-list）；
      // stats 是命中次數（print stats）各表的對應結果（matched／mismatch 的表數，沒有收集時為 null）
      firewall: M.fwZones.has(d.key) ? { rules: fwCount.get(d.key) || 0, wan: M.fwZones.get(d.key).status, stats: statsOf(M, d.key) } : null,
    })).sort((a, b) => S.util.natural(a.dev, b.dev));
  }

  /** 列出鄰居協定的固定順序：介面鄰接（LLDP、CDP）先於廣播網域（MNDP），最後是路由鄰接（OSPF）；其他依字母。 */
  const DISCOVERY_ORDER = ['lldp', 'cdp', 'mndp', 'ospf'];
  const discoveryRank = (p) => { const i = DISCOVERY_ORDER.indexOf(p); return i < 0 ? DISCOVERY_ORDER.length : i; };
  /**
   * 給人看的設備名稱（C01 的訊息與 Q.devLabel 共用這一份）：只由鄰居得知（未收集）且名稱是 IPv4 位址的設備，
   * 單看位址認不出是什麼，加上得知它的協定（事實），例如「172.31.255.2（OSPF 鄰居）」；其他維持 name。
   * links：碰到這台設備的鏈路（protocols 為陣列或 Set）；ospfPeer：是否為某個 OSPF 鄰接的對端。協定都沒有時寫「（鄰居）」。
   * 放在 check 而不是 query：檢查訊息在 check 產生，query 已依賴 check（hopOwner），反過來會違反單向依賴。
   */
  function discoveryLabel(name, collected, links, ospfPeer) {
    if (collected || !S.ip.isIp(name)) return name;
    const seen = new Set();
    links.forEach((l) => (l.protocols || []).forEach((p) => seen.add(p)));
    if (ospfPeer) seen.add('ospf');
    const protos = Array.from(seen).sort((a, b) => discoveryRank(a) - discoveryRank(b) || S.util.cmp(a, b)).map((p) => p.toUpperCase());
    return `${name}（${protos.length ? protos.join('／') + ' ' : ''}鄰居）`;
  }

  /**
   * 遞迴下一跳解析（RouterOS 的 gateway 可以是要再查路由才能到的位址，例如對端的 loopback）。
   * 先看 ip 是否為已知設備位址；否則在同一台設備的路由表以最長前綴找出它的下一跳，再往下解析。
   * routes：該設備的路由（{ prefix, len, nh }）；ownerOf(ip)：回傳擁有該 IP 的設備 key 或 null。
   * 回傳（ECMP 可有多筆）：{ status: 'known', owner, ip, chain } | { status: 'connected', ip, ifc, chain }
   *   | { status: 'unresolved', ip, chain }（沒有路由可到）| { status: 'loop', ip, chain } | { status: 'blackhole', ip, chain, route }；chain 是經過的位址。
   */
  /**
   * 下一跳（或直連網段上的目的）位址在 vrf 中屬於誰（ADR-015；檢查 R01／R03／R04 與路徑追蹤、可達性共用這一份）：
   *  1. 同名 VRF 中擁有這個位址的設備（I.owner(ip, vrf)）。
   *  2. 沒有時（推論）：dev 在這個 VRF 有包含此位址的直連網段，而其他設備上位址相同、網段（net/len）也相同的介面恰好一個，
   *     取那個介面（VRF 名稱只在設備內有意義，例如 CE 在 main、PE 在 cust-a 的同一條鏈路）；有兩個以上時不猜，回傳 null。
   * I：{ owner(ip, vrf) → { key（介面鍵；管理 IP 為「設備|」或設備鍵）, dev } 或 null, owners(ip) → [{ ep, dev, vrf, net, len }]（所有 VRF 的自有位址）,
   *      connected(dev, vrf) → [{ net, len }] }。
   * 回傳 { key, dev, vrf（擁有者所在的 VRF）, crossVrf } 或 null。
   */
  function hopOwner(I, dev, ip, vrf) {
    const own = I.owner(ip, vrf);
    if (own) return { key: own.key, dev: own.dev, vrf, crossVrf: false };
    const nets = I.connected(dev, vrf).filter((p) => S.ip.inNet(ip, p.net, p.len));
    if (!nets.length) return null;
    const cands = I.owners(ip).filter((o) => o.vrf !== vrf && o.dev !== dev && o.net !== null && nets.some((p) => p.net === o.net && p.len === o.len));
    if (cands.length !== 1) return null;
    return { key: cands[0].ep, dev: cands[0].dev, vrf: cands[0].vrf, crossVrf: true };
  }

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

  // F01–F08 共用每台設備的規則清單與 WAN 路徑模擬，而且 F06、F05 已列的規則 F03 不再列，所以合成一筆
  function firewallRules(X, add) {
    const { M, name, entryName } = X;
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
          if (cov) add('F01', `${ruleWhere(name, j)}（${ruleText(j)}）永遠不會命中：被第 ${cov.position} 條（${ruleText(cov)}）完全涵蓋`, ents(j), [ruleEv(j), ruleEv(cov)]);
        });
      });
      const active = rules.filter((r) => !r.disabled && (r.table === 'filter' || (r.table === 'nat' && r.chain === 'dstnat')));
      // 對外入口（S.infer.fw.wanEntries）：WAN 清單成員＋對外邊界判定為 external 的介面（ADR-023 決策 7）。
      // 轉送與 dst-nat 用全部入口，F07（/ip service，視為 main）只用 main 的入口
      const entries = M.wanEntries.get(dev) || [];
      const wans = entries.map((w) => w.ep); const wansMain = fw.entriesIn(entries, K.MAIN_VRF);
      // F08：有規則但完全沒有對外證據（沒有 WAN 清單成員，邊界推論也沒有 external）；F03／F04／F07 都需要入口，不猜；F05 改為只看沒有限制入介面的 forward 規則（見下方 F05）
      if (!entries.length && active.length) {
        const list = ctx.status === 'no-wan-list' ? '沒有名稱含 WAN 的 interface list' : `WAN 清單（${ctx.wanLists.join('、')}）沒有成員`;
        const maybe = (M.boundaries || []).filter((b) => b.dev === dev && b.status === 'possible');
        const weak = maybe.length ? `；${maybe.map((b) => `${K.splitEp(b.ep)[1]} 有${S.util.uniq(b.evidence.filter((e) => e.strength === 'weak').map((e) => BOUNDARY_LABEL[e.kind] || e.kind)).join('、')}`).join('，')}，只是可能對外（弱證據），不判定` : '';
        add('F08', `${name(dev)}：無法判斷哪些介面對外（有 ${active.length} 條防火牆規則，但${list}，也沒有預設路由、DHCP／PPPoE client 的預設路由或 NAT 的出入介面可以推論${weak}）；F03、F04、F07 未檢查，F05 只檢查沒有限制入介面的 forward 規則`,
          [{ type: 'device', key: dev }], [ruleEv(active[0])]);
      }
      /** 訊息中的入口：WAN 清單的成員寫「WAN（介面）」，只由邊界證據判定的寫「對外介面（介面，依…判定對外）」。 */
      const wanText = (ep) => { const e = entries.find((w) => w.ep === ep); return e && !e.wanList ? `對外介面 ${entryName(dev, ep)}` : `WAN（${K.splitEp(ep)[1]}）`; };
      const ipsecUp = M.fw.peers.some((p) => p.dev === dev && !p.disabled) || M.fw.policies.some((p) => p.dev === dev && !p.disabled && !p.template);
      const ifcName = (ep) => K.splitEp(ep)[1];
      const viaText = (path) => (path.length ? `；經由 ${path.map((x) => `${x.chain} 第 ${x.position} 條 jump`).join('→')}` : '');
      /**
       * 從 WAN 的任一介面送出符合規則 r 的新連線：第一個確定由 r 決定的結果（raw prerouting 丟掉的不算），沒有就 null。
       * 前面有條件無法判斷的規則、會改變結果時（evalFilter 為 unknown），這個介面不算：無法判斷，不報（和 Q.reach 的「無法判斷」一致）。
       */
      const reachedBy = (r, builtins) => {
        for (const ep of wans) {
          for (const b of builtins) {
            const pkt = fw.packetFor(r, ep, b, ctx);
            const res = fw.evalFilter(ctx, r.family, b, pkt, r.table === 'nat' ? 'nat' : 'filter');
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
        if (wans.length) { hit = reachedBy(r, ['forward']); if (!hit) return; }
        else if (r.match['in-interface'] !== undefined || r.match['in-interface-list'] !== undefined || r.chain !== 'forward') return;
        f05.add(r);
        const path = hit ? hit.res.path : [];
        add('F05', `${ruleWhere(name, r)}（${ruleText(r)}）只限目的埠、沒有限目的位址：IPv6 沒有 NAT，這些埠對整個網段開放${viaText(path)}`, ents(r, ...path), [ruleEv(r)].concat(path.map(ruleEv)));
      });
      if (!wans.length) return;
      // F03：WAN 可主動建立新連線的放行（input／forward，含只被 jump 的子 chain）。排除 ICMP、只放行既有連線、F05／F06 已列的規則
      rules.forEach((r) => {
        if (r.disabled || r.table !== 'filter' || r.action !== 'accept' || r.chain === 'output' || f06.has(r) || f05.has(r) || isIcmp(r) || replyOnly(r)) return;
        const ipsec = isIpsecRule(r);
        if (ipsec && ipsecUp) return; // 有 IPsec peer／policy 時，這些放行是需要的
        const hit = reachedBy(r, filterBuiltins(r)); if (!hit) return;
        add('F03', `${ruleWhere(name, r)}（${ruleText(r)}）讓${/^WAN/.test(wanText(hit.ep)) ? ' ' : ''}${wanText(hit.ep)}可以主動建立新連線${viaText(hit.res.path)}${ipsec ? '；設備沒有 IPsec peer／policy，這條 IPsec 放行可能用不到' : ''}`,
          ents(r, ...hit.res.path), [ruleEv(r)].concat(hit.res.path.map(ruleEv)));
      });
      // F04：WAN 可連入的 dst-nat，且 forward 放行轉送後的連線
      rules.forEach((r) => {
        if (r.disabled || r.table !== 'nat' || r.chain !== 'dstnat' || !/^(dst-nat|netmap)$/.test(r.action)) return;
        const hit = reachedBy(r, ['dstnat']); if (!hit) return;
        const tgt = dnatTarget(X, r); if (tgt && DNAT_NO_ROUTE.has(tgt.status)) return; // 轉送的目標沒有路由：連不到，不是暴露，改報 R09
        const toAddr = r.params['to-addresses'] ? fw.parseVal('dst-address', r.params['to-addresses'].split('-')[0]) : null;
        const toPort = r.params['to-ports'] && /^\d+/.test(r.params['to-ports']) ? +r.params['to-ports'].match(/^\d+/)[0] : hit.pkt.dstPort;
        const fpkt = Object.assign({}, hit.pkt, { out: undefined, dstLocal: false, natState: 'dstnat', dstPort: toPort, dst: toAddr && toAddr.kind === 'ranges' ? toAddr.items[0][0] : undefined });
        const fres = fw.evalFilter(ctx, r.family, 'forward', fpkt);
        if (fres.verdict !== 'accept') return;
        const by = fres.rule;
        const hairpin = by && by.match['connection-nat-state'] !== undefined && by.match['in-interface'] === undefined && by.match['in-interface-list'] === undefined;
        const port = hit.pkt.dstPort != null ? `${hit.pkt.protocol}/${hit.pkt.dstPort}` : hit.pkt.protocol;
        const to = `${r.params['to-addresses'] || '（未指定位址）'}${r.params['to-ports'] ? ':' + r.params['to-ports'] : ''}`;
        add('F04', `${name(dev)}：${wanText(hit.ep)}的 ${port} 經 dst-nat 轉送到 ${to}，${by ? `forward 第 ${by.position} 條放行` : 'forward 沒有規則擋下'}${hairpin ? '（這條放行沒有限制入介面，可能是 hairpin NAT 需要的；收緊前先確認）' : ''}`,
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
          for (const ep of wansMain) {
            const res = fw.evalFilter(ctx, fam, 'input', fw.wanPacket(fam, ep, 'input', { dstPort: sv.port }));
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
        const how = hits.map((h) => `${h.label} 從 ${entryName(dev, h.ep)}，${h.res.rule ? `${h.res.rule.chain} 第 ${h.res.rule.position} 條放行` : 'input 沒有任何規則擋下'}`).join('；');
        add('F07', `${name(dev)}：${sv.name}（tcp/${sv.port}${sv.basis === 'default' ? '，預設值' : ''}）啟用、沒有限制來源位址（available-from），WAN 可以連入：${how}`,
          [{ type: 'device', key: dev }, { type: 'service', key: dev + '|' + sv.name }].concat(hits.filter((h) => h.res.rule).map((h) => ({ type: 'rule', key: h.res.rule.key }))), ev);
      });
    });
  }

  // ---------------------------------------------------------------- 管理面加固（F10–F14）
  /*
   * 設定是事實（mgmtSettings 的 basis export）；export 沒寫的欄位是出廠預設值（S.MGMT_DEFAULTS，推論），finding 的 basis 為 default，訊息註明。
   * WAN 沿用 firewallZones 的推論，入口是 M.wanEntries（S.infer.fw.wanEntries，含所在 VRF）：沒有 WAN 時 F10、F11、F12、F14 不檢查（F08 說明），F13 不需要 WAN。
   * 「WAN 可以連到」與 F07 相同：從某個 WAN 介面送一個新連線，經 raw 與 filter input（S.infer.fw.evalFilter）會被放行；IPv6 只在確定有用時判斷。
   */
  const MGMT_LABEL = { dns: 'DNS', macServer: 'MAC Telnet', macWinbox: 'MAC WinBox', discovery: '鄰居探索', snmp: 'SNMP', upnp: 'UPnP', proxy: 'Web Proxy', socks: 'SOCKS', bandwidthServer: 'Bandwidth Server' };
  const MGMT_FAMILIES = [['ip', 'IPv4'], ['ipv6', 'IPv6']];
  // F13 的 facet 是 mgmtSettings 每個 community 的 facet（model/build.js 的 communityFacets）：F13 與畫面用同一個值對應
  // F10–F14 共用每台設備的管理面設定與 WAN 可達性判斷，合成一筆
  function mgmtHardening({ M, name, entryName, boundaryOf }, add) {
    const fw = S.infer.fw;
    const lineEv = (src) => src.map(([block, line]) => ({ block, line }));
    const anyAddr = (a) => { const p = fw.parseVal('src-address', a); return p.kind === 'ranges' && p.items.some(([x, y]) => x === 0n && y === (1n << BigInt(p.bits)) - 1n); };
    const dflt = (area, fields) => fields.some((k) => area.defaulted.includes(k));
    // 預設值的依據：表的版本範圍；設備版本不明時註明（版本在範圍外時 model 不補預設值，不會走到這裡）
    const R = S.MGMT_DEFAULTS.versions.text;
    const verNote = (ms) => `依 RouterOS ${R} 手冊的出廠值${ms.versionInRange === null ? '，設備版本不明' : ''}`;
    // 證據依出現順序去掉重複的行（UDP、TCP 被同一條規則放行等）
    const put = (id, message, entities, ev, extra) => add(id, message, entities, ev.filter((e, i) => ev.findIndex((x) => x.block === e.block && x.line === e.line) === i), extra);
    M.mgmtSettings.forEach((ms, dev) => {
      const basisText = (isDefault) => (isDefault ? `，預設值：export 沒有寫出（${verNote(ms)}）` : '');
      const ents = [{ type: 'device', key: dev }];
      // F13：SNMP 開著，啟用中的 community 名稱是 public 或不限來源（addresses 空白或含 0.0.0.0/0、::/0）。不需要 WAN
      // 欄位是 null（沒有資料、版本不在預設值表範圍）時不判斷；facet 用 community 的 facet（model/build.js 的 communityFacets，畫面以同一個值對應）
      if (ms.snmp.enabled && ms.snmp.communities) {
        const byFacet = new Map(); // facet → [訊息, 證據, basis]；同名且內容相同的 community 無法區分，併成一筆（證據列出全部的設定行）
        ms.snmp.communities.forEach((c) => {
          if (c.disabled !== false || c.name === null) return;
          const pub = c.name === 'public'; const open = c.addresses !== null && (!c.addresses.length || c.addresses.some(anyAddr));
          if (!pub && !open) return;
          const pubDefault = pub && c.defaulted.includes('name'); const openDefault = open && c.defaulted.includes('addresses');
          const isDefault = dflt(ms.snmp, ['enabled']) || pubDefault || openDefault;
          const what = [pub ? `名稱是 public${pubDefault ? '（預設值：export 沒有寫出名稱）' : ''}` : null,
            open ? `不限來源位址（addresses=${c.addresses.join(',') || '空白'}${openDefault ? '，預設值：export 沒有寫出' : ''}）` : null].filter(Boolean).join('、');
          const same = ms.snmp.communities.filter((x) => x.name === c.name && x.disabled === false).length;
          const facet = c.facet;
          const ev = lineEv(ms.snmp.src.concat(c.src));
          if (byFacet.has(facet)) { byFacet.get(facet)[1].push(...ev); return; }
          byFacet.set(facet, [`${name(dev)}：SNMP community「${c.name}」${what}${c.write ? '，而且可以寫入（write-access=yes）' : ''}${c.security && c.security !== 'none' ? `（security=${c.security}，只接受 SNMPv3）` : ''}${c.isDefault && c.basis === 'default' ? '（出廠的預設 community，export 沒有寫出）' : ''}${same > 1 ? `（同名的 community 有 ${same} 個）` : ''}${isDefault ? `；預設值${verNote(ms)}` : ''}`,
            ev, isDefault ? 'default' : 'export']);
        });
        byFacet.forEach(([message, ev, basis], facet) => put('F13', message, ents, ev, { facet, basis }));
      }
      const ctx = M.fwCtx.get(dev);
      const entries = M.wanEntries.get(dev) || []; const wans = entries.map((w) => w.ep);
      if (!ctx || !wans.length) return;
      const zone = M.fwZones.get(dev);
      const ifcName = (ep) => entryName(dev, ep);
      // 入口的依據：WAN 清單成員是 interface list member 的那一行；只由邊界證據判定的是第一個強證據的來源行
      const wanEv = (ep) => {
        for (const n of ctx.wanLists) { const l = M.fw.lists.get(dev + '|' + n); const s = l && l.members.get(ep); if (s) return { block: s[0], line: s[1] }; }
        const b = boundaryOf.get(ep); const e = b && b.evidence.find((x) => x.strength === 'strong' && x.src.length);
        return e ? { block: e.src[0][0], line: e.src[0][1] } : null;
      };
      /**
       * 從 WAN 以 proto/port 建立新連線，各位址族第一個會被 input 放行的 WAN 介面：[{ label, ep, res }]。
       * vrf：服務只在這個 VRF 回應（DNS、SOCKS 的 vrf=，手冊）時，只看在這個 VRF 的 WAN 介面（介面的 VRF 沿用 model 的 resolveVrfs）；undefined 表示服務沒有 VRF 參數。
       */
      const reach = (proto, port, vrf) => {
        const hits = [];
        const inVrf = vrf === undefined ? wans : fw.entriesIn(entries, vrf);
        MGMT_FAMILIES.forEach(([fam, label]) => {
          if (fam === 'ipv6' && zone.ipv6.status !== 'used') return;
          for (const ep of inVrf) {
            const res = fw.evalFilter(ctx, fam, 'input', fw.wanPacket(fam, ep, 'input', { protocol: proto, dstPort: port }));
            if (res.verdict === 'accept') { hits.push({ fam, label, ep, proto, port, res }); break; }
          }
        });
        return hits;
      };
      const reachText = (hits) => hits.map((h) => `${h.label} ${h.proto}/${h.port} 從 ${ifcName(h.ep)}，${h.res.rule ? `${h.res.rule.chain} 第 ${h.res.rule.position} 條放行` : 'input 沒有任何規則擋下'}`).join('；');
      const reachEv = (hits) => {
        const ev = [];
        hits.forEach((h) => {
          const w = wanEv(h.ep); if (w && !ev.some((e) => e.block === w.block && e.line === w.line)) ev.push(w);
          if (h.res.rule) ev.push({ block: h.res.rule.block, line: h.res.rule.line });
          h.res.path.forEach((r) => ev.push({ block: r.block, line: r.line }));
          if (h.fam === 'ipv6') zone.ipv6.src.forEach(([block, line]) => ev.push({ block, line }));
        });
        return ev;
      };
      // entities 只有設備：放行的規則只列在證據，不進 findingKey（改了規則、設定的問題還在時，處理紀錄仍是同一筆）
      // F10：DNS 允許遠端查詢，WAN 進來的 UDP 或 TCP 53 會被 input 放行（手冊：allow-remote-requests 在 UDP／TCP 53 回應其他設備）
      // DNS 只在 vrf=（預設 main）的用戶端得到回應（手冊 ip/dns）：WAN 在別的 VRF 時查不到；vrf 沒有資料時不判斷
      if (ms.dns.allowRemote && ms.dns.vrf !== null) {
        const hits = reach('udp', 53, ms.dns.vrf).concat(reach('tcp', 53, ms.dns.vrf));
        if (hits.length) {
          const vrfText = ms.dns.vrf !== K.MAIN_VRF ? `（vrf=${ms.dns.vrf}）` : '';
          put('F10', `${name(dev)}：DNS 允許遠端查詢（allow-remote-requests=yes）${vrfText}，WAN 可以查詢：${reachText(hits)}`, ents, lineEv(ms.dns.src).concat(reachEv(hits)), { basis: 'export' });
        }
      }
      /** 介面清單值包含哪些 WAN 介面（WAN 埠所在的 bridge 在清單中也算，手冊：bridge 在清單中時，經由它的埠進來的也接受）。無法判斷時 null。 */
      const wanIn = (value) => {
        if (value === null) return null; // 沒有資料（部分 export、版本不在預設值表範圍）
        const set = fw.listMembers(ctx, value); if (set === null) return null;
        // 只由邊界證據得知、不在介面全集裡的入口（例如只出現在 /ip dhcp-client）：all／static 包含它，「!清單」在它不屬於該清單時包含它
        const { neg, body } = fw.splitNeg(String(value).trim());
        const outside = (ep) => (neg ? !(ctx.resolve(body) || new Set()).has(ep) : body === 'all' || body === 'static');
        return wans.filter((ep) => { const i = M.ifcs.get(ep); return set.has(ep) || (i && i.bridge && set.has(i.bridge)) || (!ctx.universe.has(ep) && outside(ep)); });
      };
      const listText = (v, isDefault) => `「${v}」${basisText(isDefault)}`;
      // F11：MAC Telnet（/tool mac-server）、MAC WinBox 的 allowed-interface-list 含 WAN 介面（IP 防火牆擋不住 MAC 連線，所以不看 filter）
      [['macServer', 'mac-telnet', '/tool mac-server'], ['macWinbox', 'mac-winbox', '/tool mac-server mac-winbox']].forEach(([k, facet, menu]) => {
        const a = ms[k]; const hit = wanIn(a.allowedList); if (!hit || !hit.length) return;
        const isDefault = dflt(a, ['allowedList']);
        put('F11', `${name(dev)}：${MGMT_LABEL[k]}（${menu}）的 allowed-interface-list 是${listText(a.allowedList, isDefault)}，包含 WAN 介面 ${hit.map(ifcName).join('、')}`,
          ents, lineEv(a.src).concat(hit.map(wanEv).filter(Boolean)), { facet, basis: isDefault ? 'default' : 'export' });
      });
      // F12：鄰居探索的 discover-interface-list 含 WAN 介面；protocol 空白（不跑任何協定）或 rx-only（只收不送）不算
      const dsc = ms.discovery;
      if (dsc.protocols !== null && dsc.mode !== null && dsc.protocols.length && dsc.mode !== 'rx-only') {
        const hit = wanIn(dsc.list);
        if (hit && hit.length) {
          const isDefault = dflt(dsc, ['list']);
          put('F12', `${name(dev)}：鄰居探索（${dsc.protocols.join(',')}）的 discover-interface-list 是${listText(dsc.list, isDefault)}，包含 WAN 介面 ${hit.map(ifcName).join('、')}`,
            ents, lineEv(dsc.src).concat(hit.map(wanEv).filter(Boolean)), { basis: isDefault ? 'default' : 'export' });
        }
      }
      // F14：UPnP 的 internal 介面是 WAN（服務在 internal 介面監聽，手冊）；web proxy、SOCKS、bandwidth-server 開著且 WAN 可以連到它的 TCP 埠
      if (ms.upnp.enabled) {
        const bad = ms.upnp.interfaces.filter((x) => !x.disabled && x.type === 'internal' && wans.includes(x.ep));
        if (bad.length) {
          put('F14', `${name(dev)}：UPnP 開著，internal 介面含 WAN 介面 ${bad.map((x) => ifcName(x.ep)).join('、')}（服務在 internal 介面監聽，WAN 上的主機可以要求開啟連接埠轉送）`,
            ents, lineEv(ms.upnp.src).concat(...bad.map((x) => lineEv(x.src))), { facet: 'upnp', basis: 'export' });
        }
      }
      // SOCKS 只在 vrf=（預設 main）監聽（手冊 ip/socks）；web proxy、bandwidth-server 的手冊沒有 vrf 參數
      [['proxy', 'proxy', ms.proxy.ports, undefined], ['socks', 'socks', ms.socks.port ? [ms.socks.port] : [], ms.socks.vrf], ['bandwidthServer', 'bandwidth-server', [ms.bandwidthServer.port], undefined]].forEach(([k, facet, ports, vrf]) => {
        const a = ms[k]; if (!a.enabled || !ports || vrf === null) return;
        const hits = []; for (const p of ports) { hits.push(...reach('tcp', p, vrf)); if (hits.length) break; }
        if (!hits.length) return;
        const isDefault = dflt(a, ['enabled']);
        const vrfText = vrf && vrf !== K.MAIN_VRF ? `（vrf=${vrf}）` : '';
        const extra = k !== 'bandwidthServer' ? ''
          : (a.authenticate === false ? '，而且不需要登入（authenticate=no）' : '') + (isDefault ? '；device-mode 為 home／basic 時這個服務不運作，export 看不出 device-mode' : '');
        put('F14', `${name(dev)}：${MGMT_LABEL[k]} 開著${vrfText}${basisText(isDefault)}，WAN 可以連入：${reachText(hits)}${extra}`,
          ents, lineEv(a.src).concat(reachEv(hits)), { facet, basis: isDefault ? 'default' : 'export' });
      });
    });
  }

  // ---------------------------------------------------------------- 狀態式骨架（F15）
  /*
   * 回程的前提：IPv4 filter 的 input、forward 沒有一定走得到的 established 放行，而且 chain 會丟棄（無條件 drop、只以介面為條件的 drop，
   * 或一定命中的丟棄排在 established 放行之前）。判斷在 S.infer.fw.policyBaseline（事實：規則），沒有丟棄時回程本來就放行，不報。
   */
  /**
   * 設備會不會轉送 IPv4（F15 的 forward 用；ADR-023 決策 7）：同一個 VRF 中有兩個以上介面設了 IPv4 網段（/32 以外）時是 true——
   * 直連路由由介面位址產生，所以這時一定有路由可以在網段之間轉送；只有一個時是 false（例如只有管理位址的交換器）；
   * 沒有任何位址的事實時是 null（不明，照常檢查）。/ip settings 的 ip-forward 沒有解析，不看。
   */
  function forwardsIpv4(M, dev, RV) {
    const subs = RV.subnetsOf(dev);
    if (!subs.length && !Array.from(M.ifcs.values()).some((i) => i.dev === dev && !i.hearsay && i.ips.size)) return null;
    const perVrf = new Map(); subs.forEach((s) => S.util.getOr(perVrf, s.vrf, () => new Set()).add(s.ep));
    return Array.from(perVrf.values()).some((eps) => eps.size >= 2);
  }
  function statefulBaseline({ M, name, RV }, add) {
    const fw = S.infer.fw;
    const where = (r) => `第 ${r.position} 條`;
    const via = (path) => (path.length ? `（經由 ${path.map((x) => `${x.chain} ${where(x)} jump`).join('→')}）` : '');
    M.fwCtx.forEach((ctx, dev) => {
      const forwards = forwardsIpv4(M, dev, RV);
      fw.policyBaseline(ctx, 'ip').forEach((c) => {
        if (c.returnSafe) return;
        if (c.chain === 'forward' && forwards === false) return; // 不在路由路徑上（不轉送），forward 的回程不影響任何連線
        const e = c.established; const d = c.defaultAction;
        const ev = [];
        const push = (r) => { if (r && !ev.some((x) => x.block === r.block && x.line === r.line)) ev.push(ruleEv(r)); };
        // 從哪些介面進來的回程不保證：介面名稱；清單無法展開或只限出介面時寫比對條件
        const fromText = (bs) => S.util.uniq(bs.map((x) => (x.interfaces ? x.interfaces.map((ep) => K.splitEp(ep)[1]).join('、')
          : fw.canonMatch(x.rule.match).filter(([k]) => /^(in|out)-interface/.test(k)).map(([k, v]) => `${k}=${v}`).join(' ')))).join('；');
        let head = '沒有放行已建立的連線（connection-state=established），回程封包可能被丟棄'; let why; let anchor;
        if (e.status === 'drop') {
          why = `${e.rule.chain} ${where(e.rule)}（${ruleText(e.rule)}）${via(e.path)}先丟棄了已建立連線的封包`
            + (e.shadowed.length ? `，放行 established 的${e.shadowed.map(where).join('、')}排在它之後，走不到` : '');
          e.path.forEach(push); push(e.rule); e.shadowed.forEach(push);
          anchor = e.path[0] || e.rule;
        } else if (e.status === 'accept') {
          // established 有放行，但前面先依介面丟棄：只有從那些介面進來的回程不保證
          const bs = e.blockedFrom; const first = bs[0];
          head = `放行已建立連線的規則之前先依介面丟棄，從 ${fromText(bs)} 進來的回程不保證`;
          why = `${bs.map((x) => `${x.rule.chain} ${where(x.rule)}（${ruleText(x.rule)}）${via(x.path)}`).join('、')}排在放行 established 的 ${e.rule.chain} ${where(e.rule)}之前`;
          bs.forEach((x) => { x.path.forEach(push); push(x.rule); }); push(e.rule);
          anchor = first.path[0] || first.rule;
        } else {
          // 一定命中的全部丟棄會讓 established 的結果是 drop（上面），這裡只剩只以介面為條件的丟棄
          // 預設動作是介面條件的丟棄時以它為準；不是時（例如丟棄另帶 connection-state）以第一條介面條件的丟棄為準
          const bs = e.blockedFrom.length ? e.blockedFrom : [{ rule: d.rule, path: [], interfaces: null }];
          const dr = d.rule && d.scope === 'interface' ? d.rule : bs[0].rule;
          why = `${dr.chain} ${where(dr)}（${ruleText(dr)}）依介面丟棄封包，前面沒有一定會走到的 established 放行，從 ${fromText(bs)} 進來的回程不保證`;
          bs.forEach((x) => { x.path.forEach(push); push(x.rule); }); push(dr);
          anchor = dr;
        }
        const cond = e.conditional.filter((r) => fw.splitNeg(r.match['connection-state'] || '').body.split(',').includes('established'));
        const condText = cond.length ? `；${cond.map((r) => `${r.chain} ${where(r)}`).join('、')}只在部分條件下放行 established` : '';
        cond.forEach(push);
        // entities：設備＋這個 chain 中決定丟棄的那一條（經 jump 時是 chain 本身的 jump 規則）；兩個 chain 各一筆、鍵不同，不需要 facet
        add('F15', `${name(dev)}：IPv4 filter ${c.chain} ${head}：${why}${condText}`,
          [{ type: 'device', key: dev }, { type: 'rule', key: anchor.key }], ev);
      });
    });
  }

  // ---------------------------------------------------------------- 規則表
  /** 依 CATALOG 順序（每筆以第一個 id 排）；每個 CATALOG id 恰好屬於一筆，載入時檢查，漏列或重複都直接丟錯。 */
  const RULES = [
    [['I01'], unrecognizedBlocks],
    [['I02'], duplicateBlocks],
    [['I03'], unrecognizedLines],
    [['C01'], uncollectedDevices],
    [['C02'], incompleteDevices],
    [['K01'], oneWayNeighbors],
    [['K02'], multiPeerPorts],
    [['K03'], lagMismatch],
    [['K04'], peerPortMismatch],
    [['V01'], linkVlanDiff],
    [['V04'], nativeVlanDiff],
    [['V05'], orphanVlans],
    [['V06', 'V07'], vlanAttrConsistency],
    [['V08'], taggingDiff],
    [['V09'], unfilteredBridge],
    [['A01'], ipMacConflict],
    [['A02'], macOnManyEdges],
    [['A03'], edgePorts],
    [['A04'], manyMacs],
    [['A05'], strayArps],
    [['A06', 'A07'], vlanSubnetConsistency],
    [['A08'], overlappingPrefixes],
    [['A09'], duplicateIps],
    [['A10', 'A11'], ipBindConsistency],
    [['A12'], serverConsistency],
    [['R01', 'R03', 'R04'], unreachableNextHops],
    [['R02'], unknownOspfPeers],
    [['R05'], dhcpGatewayOutside],
    [['R06'], dhcpOptionConsistency],
    [['R07'], natExitMismatch],
    [['R08'], wanListConflict],
    [['R09'], dnatNoRoute],
    [['R10'], missingReturnRoutes],
    [['R11'], multiDefaultNoCheck],
    [['R12'], unreachableSubnets],
    [['R13'], ospfAreaMismatch],
    [['R14'], ospfNoAuth],
    [['R15'], userSubnetNotPassive],
    [['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08'], firewallRules],
    [['F09'], firewallStats],
    [['F10', 'F11', 'F12', 'F13', 'F14'], mgmtHardening],
    [['F15'], statefulBaseline],
    [['L01'], firmwarePending],
    [['L02'], versionConsistency],
  ].map(([ids, fn]) => Object.freeze({ ids: Object.freeze(ids), name: fn.name, fn }));
  (function verifyRules() {
    const rank = new Map(Object.keys(CATALOG).map((id, n) => [id, n]));
    const owner = new Map();
    RULES.forEach((r, n) => r.ids.forEach((id, k) => {
      if (!rank.has(id)) throw new Error(`規則表的 ${r.name} 有 CATALOG 沒有的 ${id}`);
      if (owner.has(id)) throw new Error(`${id} 同時屬於規則表的 ${owner.get(id)} 與 ${r.name}`);
      owner.set(id, r.name);
      if (k && rank.get(r.ids[k - 1]) > rank.get(id)) throw new Error(`規則表的 ${r.name} 中 ${id} 沒有依 CATALOG 順序`);
      if (!k && n && rank.get(RULES[n - 1].ids[0]) > rank.get(id)) throw new Error(`規則表的 ${r.name} 沒有依 CATALOG 順序`);
    }));
    rank.forEach((_, id) => { if (!owner.has(id)) throw new Error(`CATALOG 的 ${id} 不在規則表中`); });
  })();

  function run(M, ctx) {
    const out = [];
    // extra：個別檢查附加的欄位（例如跨設備一致性的 deviation），不可覆寫上列共通欄位；facet 另外處理（放在 entities 之後）
    // facet 有沒有要和 CATALOG 的宣告一致：檢查漏給或多給都是程式錯誤，直接丟錯，不產生 findingKey 不穩定的 finding
    const emit = (id, message, entities, evidence, extra) => {
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
    const X = prep(M, ctx);
    RULES.forEach((r) => r.fn(X, (id, ...a) => {
      if (!r.ids.includes(id)) throw new Error(`${r.name} 產生了不屬於它的 ${id}`);
      emit(id, ...a);
    }));

    const order = { error: 0, warn: 1, info: 2 };
    // 訊息相同時再依 entities 排序，不依檢查產生的先後（那可能來自觀察順序）
    const entText = (f) => f.entities.map((e) => e.type + ':' + e.key).join('\n');
    out.sort((a, b) => order[a.severity] - order[b.severity] || S.util.cmp(a.id, b.id) || S.util.natural(a.message, b.message) || S.util.cmp(entText(a), entText(b)));
    return out;
  }

  S.check = { run, coverage, RULES, CATALOG, EXPECTED, DATA_LABEL, fmtVlans, resolveNextHop, hopOwner, discoveryLabel, unrecognizedReason, issueReason, sourceName, placeText, expectsCollection };
})(globalThis.SSOT = globalThis.SSOT || {});
