/*
 * 路由追蹤與 L4 可達性（查詢層，只讀 Snapshot）。
 *
 * 路由追蹤 S.trace(Q, src, dst)：在基準的路由表上，從來源 IP 逐跳走到目的 IP。
 *  - 起點：介面網段包含來源 IP 的設備（最長遮罩優先），即來源的閘道
 *  - 每一跳：目的在直連網段 → 抵達；否則最長前綴比對，同遮罩多條即 ECMP 分支
 *  - 下一跳 IP → 擁有該 IP 的設備；下一跳本身不屬於任何設備時，沿本機路由表遞迴解析（S.check.resolveNextHop）；找不到、沒有路由資料、黑洞路由、迴圈、TTL 用盡都會停下並註明原因
 *  每一跳的轉送決定（lookup、nextOwner）與 L4 可達性共用，不另寫一份。
 *
 * L4 可達性與 zone 矩陣（M2，S.reach.engine，由 Q.reach／Q.zones／Q.zoneMatrix／Q.zoneCell／Q.ruleImpact 呼叫）：
 *  - 沿上面的路徑，逐跳依 RouterOS 的處理順序套用 raw、nat（dst-nat 改寫目的後重新查路由）、filter、srcnat，規則語意全部用 S.infer.fw.decide。
 *  - 結果是推論，不寫進 Snapshot（ADR-014）；同一份基準與參數一定得到相同結果，快取只在記憶體。
 *  - 無法判斷就回傳 unknown 並列出原因，不猜（見 REASON）。
 */
(function (S) {
  'use strict';
  const IP = S.ip;
  const K = S.keys;
  const U = S.util;

  /**
   * 一台設備對目的位址的轉送決定：
   *   { kind: 'connected', conn }：目的在直連網段（conn 是 Q.subnets() 的元素，最長遮罩）
   *   { kind: 'no-route-data' }：沒有路由表資料
   *   { kind: 'no-match', routes }：沒有符合的路由
   *   { kind: 'blackhole', route, routes }：最長前綴的路由都是黑洞
   *   { kind: 'route', route, proto, nhs: [{ r, n }], routes }：下一跳（同遮罩多條即 ECMP）
   */
  function lookup(Q, dev, dst) {
    const conn = Q.subnetsOf(dev).filter((s) => IP.inNet(dst, s.net, s.len)).sort((a, b) => b.len - a.len)[0];
    if (conn) return { kind: 'connected', conn };
    const routes = Q.routesOf(dev);
    if (!routes.length) return { kind: 'no-route-data', routes };
    let best = -1; let cands = [];
    routes.forEach((r) => {
      if (!IP.inNet(dst, r.prefix, r.len)) return;
      if (r.len > best) { best = r.len; cands = [r]; } else if (r.len === best) cands.push(r);
    });
    if (!cands.length) return { kind: 'no-match', routes };
    const route = `${cands[0].prefix}/${cands[0].len}`;
    if (cands.every((r) => r.blackhole)) return { kind: 'blackhole', route, routes };
    const nhs = [];
    cands.forEach((r) => r.nh.forEach((n) => nhs.push({ r, n })));
    return { kind: 'route', route, proto: cands[0].proto, nhs, routes };
  }
  /**
   * 下一跳 IP 屬於哪台設備：{ status: 'direct', ep, dev }（某台設備的位址）、{ status: 'recursive', hits: [{ dev, chain }] }
   * （不是已知位址，沿本機路由表遞迴解析到已知設備，例如 gateway 是對端 loopback）、{ status: 'unknown' }（不在基準內）。
   */
  function nextOwner(Q, routes, ip) {
    const own = Q.ipOwner(ip);
    if (own) return { status: 'direct', ep: own, dev: K.splitEp(own)[0] };
    const devOf = (x) => { const o = Q.ipOwner(x); return o ? K.splitEp(o)[0] : null; };
    const hit = S.check.resolveNextHop(routes, ip, devOf).filter((x) => x.status === 'known');
    return hit.length ? { status: 'recursive', hits: hit.map((x) => ({ dev: x.owner, chain: x.chain })) } : { status: 'unknown' };
  }

  S.trace = function (Q, src, dst, opt) {
    const ttlMax = (opt && opt.ttl) || 32;
    if (!IP.isIp(src) || !IP.isIp(dst)) return { ok: false, error: '請輸入有效的 IPv4 位址' };
    const startNets = Q.subnets().filter((s) => IP.inNet(src, s.net, s.len)).sort((a, b) => b.len - a.len);
    const ownerSrc = Q.ipOwner(src);
    const startDev = ownerSrc ? ownerSrc.split('|')[0] : startNets.length ? startNets[0].dev : null;
    if (!startDev) return { ok: false, error: `找不到包含 ${src} 的網段，無法判斷起點設備` };

    const hops = []; const ends = []; const edges = new Set();
    const queue = [{ dev: startDev, ttl: ttlMax, path: [startDev] }];
    const expanded = new Set();
    while (queue.length) {
      const { dev, ttl, path } = queue.shift();
      if (expanded.has(dev)) continue; // 同一設備只展開一次（ECMP 匯合時避免重複）
      expanded.add(dev);
      if (ttl <= 0) { ends.push({ dev, status: 'ttl', note: 'TTL 用盡' }); continue; }
      const lk = lookup(Q, dev, dst);
      if (lk.kind === 'connected') { ends.push({ dev, status: 'reached', note: `目的位於直連網段 ${lk.conn.net}/${lk.conn.len}（${Q.epName(lk.conn.ep)}）`, path }); continue; }
      if (lk.kind === 'no-route-data') { ends.push({ dev, status: 'noroute', note: '這台設備沒有路由表資料', path }); continue; }
      if (lk.kind === 'no-match') { ends.push({ dev, status: 'noroute', note: `沒有符合 ${dst} 的路由`, path }); continue; }
      if (lk.kind === 'blackhole') {
        hops.push({ dev, route: lk.route, proto: '黑洞路由', ecmp: false, next: [] });
        ends.push({ dev, status: 'blackhole', note: `${lk.route} 是黑洞路由，封包在此被丟棄`, path }); continue;
      }
      const hop = { dev, route: lk.route, proto: lk.proto, ecmp: lk.nhs.length > 1, next: [] };
      hops.push(hop);
      lk.nhs.forEach(({ r, n }) => {
        if (!n.ip) { hop.next.push({ ip: null, ifc: n.ifc, status: 'connected', note: `經 ${n.ifc} 直接送出（${r.proto}）` }); ends.push({ dev, status: 'reached', note: `目的在 ${n.ifc} 直連`, path }); return; }
        const no = nextOwner(Q, lk.routes, n.ip);
        if (no.status === 'recursive') {
          no.hits.forEach((x) => {
            if (path.includes(x.dev)) { hop.next.push({ ip: n.ip, ifc: n.ifc, dev: x.dev, status: 'loop', note: '路由迴圈' }); ends.push({ dev: x.dev, status: 'loop', note: `回到 ${Q.devName(x.dev)}，路由迴圈`, path: path.concat(x.dev) }); return; }
            hop.next.push({ ip: n.ip, ifc: n.ifc, dev: x.dev, status: 'ok', note: `遞迴解析：${x.chain.join(' → ')}` });
            edges.add(dev + '>' + x.dev);
            queue.push({ dev: x.dev, ttl: ttl - 1, path: path.concat(x.dev) });
          });
          return;
        }
        if (no.status === 'unknown') { hop.next.push({ ip: n.ip, ifc: n.ifc, status: 'unknown', note: '下一跳不屬於任何已知設備' }); ends.push({ dev, status: 'unknown-nh', note: `下一跳 ${n.ip} 不在基準內`, path }); return; }
        const nd = no.dev;
        if (path.includes(nd)) { hop.next.push({ ip: n.ip, ifc: n.ifc, dev: nd, status: 'loop', note: '路由迴圈' }); ends.push({ dev: nd, status: 'loop', note: `回到 ${Q.devName(nd)}，路由迴圈`, path: path.concat(nd) }); return; }
        hop.next.push({ ip: n.ip, ifc: n.ifc, dev: nd, status: 'ok' });
        edges.add(dev + '>' + nd);
        queue.push({ dev: nd, ttl: ttl - 1, path: path.concat(nd) });
      });
    }
    const reached = ends.some((e) => e.status === 'reached');
    return { ok: true, src, dst, start: startDev, reached, hops, ends, edges: Array.from(edges).map((e) => e.split('>')) };
  };
  S.trace.lookup = lookup;
  S.trace.nextOwner = nextOwner;

  // ================================================================ L4：端到端可達性、zone、zone 矩陣（M2）
  const fw = () => S.infer.fw;
  const deepFreeze = (o) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
    return o;
  };
  const TTL = 32;
  /** 一次查詢最多展開的路徑數（ECMP、多個閘道）；超過時其餘路徑不算，結果為 unknown（branch-limit）。 */
  const MAX_PATHS = 32;
  /** 矩陣預設的 service：常見的管理與應用埠，另加 dst-nat 規則的目的埠（見 servicesOf）。 */
  const SERVICES = deepFreeze([
    { proto: 'icmp', port: null }, { proto: 'tcp', port: 22 }, { proto: 'tcp', port: 80 }, { proto: 'tcp', port: 443 },
    { proto: 'tcp', port: 3389 }, { proto: 'tcp', port: 8291 }, { proto: 'udp', port: 53 },
  ]);
  const svcId = (s) => s.proto + (s.port != null ? '/' + s.port : '');
  /** zone 的來源，依優先順序（同一個網段取第一個有結果的來源）。 */
  const ZONE_SOURCES = Object.freeze(['profile', 'interface-list', 'vlan', 'subnet']);
  /** 可達性的前提（每次 Q.reach 都附上，畫面照列）。 */
  const ASSUMPTIONS = deepFreeze([
    { code: 'new-connection', message: '判斷的是新連線（connection-state=new）；回程由連線追蹤放行，不另外判斷' },
    { code: 'routeros-tables', message: '只套用 RouterOS 的 raw、nat、filter；mangle（標記、策略路由）、bridge filter、主機與服務本身的防火牆不在範圍內' },
    { code: 'ipv4-main', message: '只算 IPv4 與 main 路由表（vrf 固定為 null，VRF 在 M3）' },
    { code: 'src-port', message: '來源埠由用戶端自選，比對來源埠的條件無法判斷' },
  ]);
  /** 無法判斷的條件鍵 → 原因。 */
  const KEY_WHY = {
    'src-address-list': 'address-list 的內容不在基準中（export 只有名稱與靜態項目，不展開，也沒有動態項目）',
    'dst-address-list': 'address-list 的內容不在基準中（export 只有名稱與靜態項目，不展開，也沒有動態項目）',
    'in-interface': '入介面不明（下一跳經遞迴路由解析）', 'out-interface': '出介面不明（路由沒有寫出介面）',
    'in-interface-list': 'interface list 無法展開（動態、內建或未定義的清單）', 'out-interface-list': 'interface list 無法展開（動態、內建或未定義的清單）',
    'src-port': '來源埠由用戶端自選', port: '來源埠由用戶端自選',
    'connection-mark': 'mangle 的標記不在範圍內', 'packet-mark': 'mangle 的標記不在範圍內', 'routing-mark': 'mangle 的標記不在範圍內',
    'ipsec-policy': '設備有啟用中的 IPsec policy，封包是否經 IPsec 不明', 'src-address': 'NAT 後的來源位址不明',
    'dst-address-type': '位址類型不明', 'src-address-type': '位址類型不明',
  };
  const keyWhy = (k) => KEY_WHY[k] || (S.infer.fw.NONDET.has(k) ? '依流量、速率或機率比對' : '這個條件不在可判斷的範圍');

  S.reach = {
    SERVICES, ZONE_SOURCES, ASSUMPTIONS, svcId,
    /** 每份基準一個（由 S.query 第一次呼叫 L4 函式時建立）；I：{ ctxOf(dev) }（查詢層的防火牆比對環境）。 */
    engine(Q, I) { return makeEngine(Q, I); },
  };

  function makeEngine(Q, I) {
    const m = Q.snapshot.model;
    const F = fw();
    const name = (d) => Q.devName(d);
    const devOfEp = (ep) => K.splitEp(ep)[0];
    const ownerOf = (ip) => Q.ipOwner(ip);
    const odMemo = new Map();
    const ownerDev = (ip) => { let d = odMemo.get(ip); if (d === undefined) { const o = ownerOf(ip); d = o ? devOfEp(o) : null; odMemo.set(ip, d); } return d; };
    const realEp = (ep) => (ep && !ep.endsWith('|') ? ep : undefined); // 管理 IP（「設備|」）沒有介面
    const infoMemo = new Map();
    const devInfo = (d) => U.getOr(infoMemo, d, () => {
      const x = Q.getDevice(d);
      const pol = Q.ipsecOf(d).policies;
      return { exists: !!x, collected: !!(x && x.collected), config: !!(x && x.collected && x.data.includes('config')), host: !!x && x.kind === 'host',
        ipsec: pol.some((p) => !p.disabled && !p.template) };
    });
    const netDev = (d) => { const x = devInfo(d); return x.exists && !x.host; };

    // ---- 規則的參照（輸出用，含來源行）
    const refMemo = new Map();
    const ref = (r) => (r ? U.getOr(refMemo, r.key, () => ({ key: r.key, dev: r.dev, family: r.family, table: r.table, chain: r.chain, position: r.position,
      action: r.action, comment: r.comment, src: r.src.map((x) => x.slice()) })) : null);
    const where = (r) => `${name(r.dev)} ${r.table} ${r.chain} 第 ${r.position} 條（${r.action}）`;

    // ---- 位址等價類：規則的位址邊界把位址空間切成區段，同一區段內的位址對所有規則的位址條件結果相同（規格書 §7）
    let ruleB = null; let repB = null;
    const toNum = (x) => Number(x);
    const addRanges = (set, key, text) => {
      if (text === undefined) return;
      const p = F.parseVal(key, F.splitNeg(text).body);
      if (p.kind === 'ranges' && p.bits === 32) p.items.forEach(([a, b]) => { set.add(toNum(a)); set.add(toNum(b) + 1); });
    };
    const sortedArr = (set) => Float64Array.from(Array.from(set).sort((a, b) => a - b));
    const bounds = () => {
      if (ruleB) return;
      const rb = new Set([0]);
      m.firewallRules.forEach((r) => {
        if (r.family !== 'ip') return;
        addRanges(rb, 'src-address', r.match['src-address']); addRanges(rb, 'dst-address', r.match['dst-address']);
        addRanges(rb, 'dst-address', r.params['to-addresses']);
      });
      const pb = new Set(rb);
      prefixes4().forEach((p) => { pb.add(p.lo); pb.add(p.hi + 1); });
      ruleB = sortedArr(rb); repB = sortedArr(pb);
    };
    const findAtom = (arr, x) => { let lo = 0; let hi = arr.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid] <= x) lo = mid; else hi = mid - 1; } return lo; };
    const atomMemo = new Map();
    const ruleAtom = (ip) => U.getOr(atomMemo, ip, () => { bounds(); return findAtom(ruleB, IP.toInt(ip)); });

    // ---- 網段（IPv4 的直連網段）與最長前綴
    let p4 = null;
    function prefixes4() {
      if (p4) return p4;
      p4 = (m.prefixes || []).filter((p) => (p.family || 4) === 4 && p.vrf == null).map((p) => {
        const lo = IP.toInt(p.net); const hi = lo + (p.len >= 32 ? 0 : 2 ** (32 - p.len) - 1);
        return { p, prefix: p.prefix, net: p.net, len: p.len, lo, hi };
      });
      return p4;
    }
    let lens = null; let byPrefix = null;
    const longest = (ip) => {
      if (!lens) { byPrefix = new Map(prefixes4().map((x) => [x.prefix, x])); lens = U.uniq(prefixes4().map((x) => x.len)).sort((a, b) => b - a); }
      const n = IP.toInt(ip);
      for (const len of lens) { const x = byPrefix.get(IP.fromInt((n & IP.maskOf(len)) >>> 0) + '/' + len); if (x) return x; }
      return null;
    };

    // ---- 每一關（表＋chain）的判斷：S.infer.fw.decide，依等價類快取
    const stageMemo = new Map();
    const hasRules = (ctx, table, chain) => ctx.chain('ip', table, chain).length > 0;
    // 節點的鍵：來源是網路設備的位址時用實際位址（之後的設備判斷 src-address-type=local 要用），否則用等價類
    const srcKey = (ip) => { if (ip == null) return 'n'; const d = ownerDev(ip); return d && netDev(d) ? 'o' + ip : 'a' + ruleAtom(ip); };
    function stage(dev, table, chain, st, inEp, outEp, natState, skip) {
      const srcLocal = st.src != null && ownerDev(st.src) === dev; const dstLocal = ownerDev(st.dst) === dev;
      // 位址只透過等價類與「是不是這台設備的」影響判斷，所以鍵用這兩者，不用實際位址
      const lv = level(level(level(level(level(stageMemo, skip ? skip.id : ''), dev), table + chain), inEp === undefined ? '' : inEp), outEp === undefined ? '' : outEp === null ? '-' : outEp);
      const leaf = level(lv, svcNum(st) * 16 + (natState ? 8 : 0) + (srcLocal ? 4 : 0) + (dstLocal ? 2 : 0));
      const key = (st.src == null ? 0 : ruleAtom(st.src) + 1) * 1e7 + ruleAtom(st.dst);
      return U.getOr(leaf, key, () => {
        const ctx = I.ctxOf(dev);
        const pkt = {
          family: 'ip', reach: true, in: inEp, out: outEp, protocol: st.proto, dstPort: st.port, srcPort: null,
          src: st.src == null ? null : BigInt(IP.toInt(st.src)), dst: BigInt(IP.toInt(st.dst)), srcLocal, dstLocal,
          state: 'new', natState, ipsec: devInfo(dev).ipsec ? null : 'none',
        };
        const d = F.decide(ctx, 'ip', table, chain, pkt, skip ? skip.set : null);
        const pub = {
          table, chain, status: d.decided ? 'decided' : 'unknown', verdict: d.decided ? d.verdict : null, rule: d.decided ? ref(d.rule) : null, policy: d.decided && d.policy,
          via: d.decided ? d.path.map(ref) : [], hits: d.hits.map(ref),
          uncertain: d.uncertain.map((u) => ({ rule: ref(u.rule), keys: U.uniq(u.keys), verdicts: u.verdicts })),
          outcomes: d.outcomes.map((o) => ({ verdict: o.verdict, rule: ref(o.rule), policy: o.policy })),
        };
        pub.note = `${table} ${chain}：${!d.decided ? `可能 ${U.uniq(d.outcomes.map((o) => o.verdict)).join('／')}，無法判斷`
          : d.rule ? `第 ${d.rule.position} 條 ${d.rule.action}${d.rule.comment ? `（${d.rule.comment}）` : ''}` : table === 'nat' ? '沒有 NAT 規則命中' : '沒有規則決定，預設放行'}`;
        return { pub, d };
      });
    }
    const condReasons = (dev, sg) => sg.pub.uncertain.filter(() => sg.pub.status === 'unknown').map((u) => ({
      code: 'rule-condition', dev, rule: u.rule, keys: u.keys,
      message: `${where(u.rule)} 的條件 ${u.keys.join('、')} 無法判斷：${U.uniq(u.keys.map(keyWhy)).join('；')}`,
    }));
    const reason = (code, dev, message, extra) => Object.assign({ code, dev: dev || null, message }, extra);

    // ---- NAT 改寫
    const single = (text) => { if (text === undefined) return undefined; const t = String(text).trim(); if (IP.isIp(t)) return t; const r = t.match(/^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$/); return r && r[1] === r[2] && IP.isIp(r[1]) ? r[1] : null; };
    const ownIps = (ep) => Q.ipsOf(ep).filter((a) => !a.hearsay && a.ip).map((a) => a);
    function applyDst(dev, inEp, r, st) {
      const tp = r.params['to-ports'];
      const port = tp === undefined ? st.port : /^\d+$/.test(String(tp).trim()) ? +tp : null;
      if (port === null) return { unknown: reason('nat-target', dev, `${where(r)} 的 to-ports（${tp}）是範圍，改寫後的埠不明`, { rule: ref(r) }) };
      let dst;
      if (r.action === 'dst-nat') {
        const to = single(r.params['to-addresses']);
        if (to === null) return { unknown: reason('nat-target', dev, `${where(r)} 的 to-addresses（${r.params['to-addresses']}）是範圍，改寫後的位址不明`, { rule: ref(r) }) };
        dst = to === undefined ? st.dst : to;
      } else if (r.action === 'redirect') {
        const own = (realEp(inEp) ? ownIps(inEp) : []).concat(Q.interfacesOf(dev).flatMap((i) => ownIps(i.key)));
        if (!own.length) return { unknown: reason('nat-target', dev, `${where(r)} 轉給設備自己，但這台設備沒有已知的位址`, { rule: ref(r) }) };
        dst = own[0].ip;
      } else if (r.action === 'netmap') {
        const p = S.ip.parseCidr(String(r.params['to-addresses'] || ''));
        if (!p) return { unknown: reason('nat-target', dev, `${where(r)} 的 to-addresses 無法解析，改寫後的位址不明`, { rule: ref(r) }) };
        const mask = IP.maskOf(p.len);
        dst = IP.fromInt(((IP.toInt(p.net) & mask) | (IP.toInt(st.dst) & ~mask)) >>> 0);
      } else return { unknown: reason('nat-target', dev, `${where(r)} 的動作 ${r.action} 不在可判斷的範圍`, { rule: ref(r) }) };
      const fmt = (ip, pt) => ip + (pt != null ? ':' + pt : '');
      return { st: Object.assign({}, st, { dst, port }), nat: { type: r.action, dir: 'dst', rule: ref(r), before: fmt(st.dst, st.port), after: fmt(dst, port) } };
    }
    function applySrc(dev, outEp, r, st, nextIp) {
      let src;
      if (r.action === 'masquerade') {
        const own = realEp(outEp) ? ownIps(outEp) : [];
        const hit = nextIp ? own.find((a) => a.len < 32 && IP.inNet(nextIp, S.ip.parseCidr(a.address).net, a.len)) : null;
        src = hit ? hit.ip : own.length ? own[0].ip : null;
      } else if (r.action === 'src-nat') src = single(r.params['to-addresses']) || null;
      else if (r.action === 'netmap') {
        const p = S.ip.parseCidr(String(r.params['to-addresses'] || ''));
        src = p && st.src ? IP.fromInt(((IP.toInt(p.net) & IP.maskOf(p.len)) | (IP.toInt(st.src) & ~IP.maskOf(p.len))) >>> 0) : null;
      } else src = null;
      const out = { st: Object.assign({}, st, { src }), nat: { type: r.action, dir: 'src', rule: ref(r), before: st.src, after: src } };
      if (src === null) out.unknown = reason('srcnat-address-unknown', dev, `${where(r)} 改寫後的來源位址不明`, { rule: ref(r) });
      return out;
    }

    // ---- 逐跳：節點是一台設備的處理（一個出介面一個節點；ECMP 時同一台設備有多個節點）
    //   node：{ hop, next: [node], end }，hop 是輸出的一跳，end 是在這一跳結束的原因
    const nodeMemo = new Map();
    const outEpFor = (dev, ip) => { const s = Q.subnetsOf(dev).filter((x) => IP.inNet(ip, x.net, x.len)).sort((a, b) => b.len - a.len)[0]; return s ? s.ep : undefined; };
    const lookMemo = new Map();
    const look = (dev, dst) => U.getOr(level(lookMemo, dev), dst, () => lookup(Q, dev, dst));
    const end = (status, verdict, code, dev, message, extra) => Object.assign({ status, verdict, code, dev: dev || null, message }, extra);
    const newHop = (dev, inEp, st, chain) => ({
      dev, name: name(dev), collected: devInfo(dev).collected, firewall: devInfo(dev).config ? 'export' : 'none', chain, in: inEp === undefined ? null : inEp, inKnown: inEp !== undefined,
      out: null, outKnown: true, src: st.src, dst: st.dst, proto: st.proto, port: st.port, srcOut: st.src, dstOut: st.dst, portOut: st.port,
      route: null, stages: [], nat: [], service: null, reasons: [], verdict: 'pass',
    });
    const cloneHop = (b) => ({
      dev: b.dev, name: b.name, collected: b.collected, firewall: b.firewall, chain: b.chain, in: b.in, inKnown: b.inKnown, out: b.out, outKnown: b.outKnown,
      src: b.src, dst: b.dst, proto: b.proto, port: b.port, srcOut: b.srcOut, dstOut: b.dstOut, portOut: b.portOut,
      route: b.route, stages: b.stages.slice(), nat: b.nat.slice(), service: b.service, reasons: b.reasons.slice(), verdict: b.verdict,
    });

    /** 封包從 inEp（undefined＝不明）進入 dev。mode：'exact'（Q.reach，鍵用實際位址）或 'atom'（矩陣，鍵用等價類）。 */
    // 快取分層（設備 → 入介面 → 來源 → 目的與 service 的數字鍵），避免每次組長字串；計算中的鍵存 BUSY，再遇到就是同一個封包繞回來（迴圈）
    const BUSY = Symbol('busy');
    const protoIdx = new Map();
    const svcNum = (st) => U.getOr(protoIdx, st.proto, () => protoIdx.size) * 65536 + (st.port || 0);
    const level = (map, k) => { let x = map.get(k); if (!x) { x = new Map(); map.set(k, x); } return x; };
    function arrive(dev, inEp, st, depth, ctx) {
      const leaf = level(level(level(ctx.memo, dev), inEp === undefined ? '' : inEp), ctx.mode === 'exact' ? (st.src == null ? 'n' : st.src) : srcKey(st.src));
      const nk = IP.toInt(st.dst) * 1e6 + svcNum(st);
      const hit = leaf.get(nk);
      if (hit === BUSY) {
        const hop = newHop(dev, inEp, st, null); hop.verdict = 'deny';
        return [{ hop, next: null, end: end('loop', 'deny', 'loop', dev, `回到 ${name(dev)}（同樣的封包），路由迴圈，封包到不了`) }];
      }
      if (hit) return hit;
      leaf.set(nk, BUSY);
      const out = arriveRaw(dev, inEp, st, depth, ctx);
      leaf.set(nk, out);
      return out;
    }
    function arriveRaw(dev, inEp, st, depth, ctx) {
      const info = devInfo(dev);
      const base = newHop(dev, inEp, st, null);
      const stop = (hop, e) => [{ hop, next: null, end: e }];
      if (depth > TTL) { base.verdict = 'unknown'; return stop(base, end('ttl', 'unknown', 'ttl', dev, `超過 ${TTL} 跳，TTL 用盡`)); }
      if (!info.collected) {
        base.verdict = 'unknown';
        return stop(base, end('unknown', 'unknown', 'device-uncollected', dev, `${name(dev)} 沒有收集，不知道它的路由與防火牆`));
      }
      let cur = st; let natState = null;
      if (info.config) {
        const ctxF = I.ctxOf(dev);
        if (hasRules(ctxF, 'raw', 'prerouting')) {
          const sg = stage(dev, 'raw', 'prerouting', cur, inEp, undefined, null, ctx.skip);
          base.stages.push(sg.pub);
          if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { base.verdict = 'deny'; return stop(base, end('dropped', 'deny', 'dropped', dev, sg.pub.note)); }
          if (sg.pub.status === 'decided' && sg.pub.verdict === 'notrack') base.reasons.push(reason('raw-notrack', dev, `${where(sg.d.rule)} 不追蹤連線（notrack），之後以 connection-state 比對的規則結果不明`, { rule: sg.pub.rule }));
          base.reasons.push(...condReasons(dev, sg));
        }
        if (hasRules(ctxF, 'nat', 'dstnat')) {
          const sg = stage(dev, 'nat', 'dstnat', cur, inEp, undefined, null, ctx.skip);
          base.stages.push(sg.pub);
          if (sg.pub.status !== 'decided') {
            base.reasons.push(...condReasons(dev, sg));
            if (sg.d.outcomes.some((o) => o.verdict !== 'none')) {
              base.verdict = 'unknown';
              base.reasons.push(reason('nat-ambiguous', dev, `${name(dev)} dstnat 可能由不同的規則改寫（${sg.d.outcomes.map((o) => (o.rule ? `第 ${o.rule.position} 條 ${o.verdict}` : '不改寫')).join('、')}），改寫後的目的不明`));
              return stop(base, end('unknown', 'unknown', 'nat-ambiguous', dev, '目的 NAT 的結果不明，之後的路徑無法判斷'));
            }
          } else if (sg.pub.verdict !== 'none') {
            const res = applyDst(dev, inEp, sg.d.rule, cur);
            if (res.unknown) { base.verdict = 'unknown'; base.reasons.push(res.unknown); return stop(base, end('unknown', 'unknown', res.unknown.code, dev, res.unknown.message)); }
            base.nat.push(res.nat); cur = res.st; natState = 'dstnat';
            base.dstOut = cur.dst; base.portOut = cur.port;
          }
        }
      } else base.reasons.push(reason('no-firewall-data', dev, `${name(dev)} 沒有設定資料（/export），防火牆規則不明`));
      // 目的是這台設備自己：input
      if (ownerDev(cur.dst) === dev) {
        base.chain = 'input';
        if (info.config) {
          const sg = stage(dev, 'filter', 'input', cur, inEp, null, natState, ctx.skip);
          base.stages.push(sg.pub); base.reasons.push(...condReasons(dev, sg));
          if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { base.verdict = 'deny'; return stop(base, end('dropped', 'deny', 'dropped', dev, sg.pub.note)); }
        }
        base.service = serviceOf(dev, cur);
        if (base.reasons.length) base.verdict = 'unknown';
        return stop(base, end('delivered', 'allow', 'local', dev, `目的 ${cur.dst} 是 ${name(dev)} 自己的位址`));
      }
      return egress(dev, base, inEp, cur, natState, 'forward', depth, ctx);
    }
    /** 設備自己送出的封包（來源是設備的位址）：output。 */
    function originate(dev, st, ctx) {
      const base = newHop(dev, null, st, 'output');
      if (!devInfo(dev).config) base.reasons.push(reason('no-firewall-data', dev, `${name(dev)} 沒有設定資料（/export），防火牆規則不明`));
      if (ownerDev(st.dst) === dev) return [{ hop: base, next: null, end: end('delivered', 'allow', 'local', dev, `來源與目的都是 ${name(dev)} 自己的位址`) }];
      return egress(dev, base, null, st, null, 'output', 0, ctx);
    }
    /** 路由決定之後：依出介面分支，套用 filter（forward／output）與 srcnat，再交給下一台。 */
    function egress(dev, base, inEp, cur, natState, chain, depth, ctx) {
      const info = devInfo(dev);
      base.chain = chain;
      const stop = (hop, e) => [{ hop, next: null, end: e }];
      const lk = look(dev, cur.dst);
      if (lk.kind === 'no-route-data') { base.verdict = 'unknown'; return stop(base, end('unknown', 'unknown', 'no-route-data', dev, `${name(dev)} 沒有路由表資料`)); }
      if (lk.kind === 'no-match') { base.verdict = 'deny'; base.route = { prefix: null, proto: null, gateway: null }; return stop(base, end('no-route', 'deny', 'no-route', dev, `${name(dev)} 沒有符合 ${cur.dst} 的路由，封包被丟棄`)); }
      if (lk.kind === 'blackhole') { base.verdict = 'deny'; base.route = { prefix: lk.route, proto: '黑洞路由', gateway: null }; return stop(base, end('blackhole', 'deny', 'blackhole', dev, `${lk.route} 是黑洞路由，封包被丟棄`)); }
      const outs = lk.kind === 'connected'
        ? [{ out: lk.conn.ep, route: { prefix: `${lk.conn.net}/${lk.conn.len}`, proto: 'connected', gateway: null }, nh: null }]
        : lk.nhs.map(({ r, n }) => ({ out: n.ifc ? K.ep(dev, n.ifc) : n.ip ? outEpFor(dev, n.ip) : undefined, route: { prefix: lk.route, proto: r.proto, gateway: n.ip || null }, nh: n, routes: lk.routes }));
      return outs.map((o) => {
        const hop = cloneHop(base); hop.out = o.out === undefined ? null : o.out; hop.outKnown = o.out !== undefined; hop.route = o.route;
        let st = cur;
        if (info.config) {
          const ctxF = I.ctxOf(dev);
          if (chain === 'output' && hasRules(ctxF, 'raw', 'output')) {
            const sg = stage(dev, 'raw', 'output', st, null, o.out, null, ctx.skip);
            hop.stages.push(sg.pub); hop.reasons.push(...condReasons(dev, sg));
            if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { hop.verdict = 'deny'; return { hop, next: null, end: end('dropped', 'deny', 'dropped', dev, sg.pub.note) }; }
          }
          const sg = stage(dev, 'filter', chain, st, inEp === undefined ? undefined : inEp, o.out, natState, ctx.skip);
          hop.stages.push(sg.pub); hop.reasons.push(...condReasons(dev, sg));
          if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { hop.verdict = 'deny'; return { hop, next: null, end: end('dropped', 'deny', 'dropped', dev, sg.pub.note) }; }
          if (hasRules(ctxF, 'nat', 'srcnat')) {
            const sn = stage(dev, 'nat', 'srcnat', st, inEp, o.out, natState, ctx.skip);
            hop.stages.push(sn.pub); hop.reasons.push(...condReasons(dev, sn));
            if (sn.pub.status !== 'decided' && sn.d.outcomes.some((x) => x.verdict !== 'none')) {
              hop.reasons.push(reason('srcnat-ambiguous', dev, `${name(dev)} srcnat 可能由不同的規則改寫，之後的來源位址不明`));
              st = Object.assign({}, st, { src: null });
            } else if (sn.pub.status === 'decided' && sn.pub.verdict !== 'none') {
              const res = applySrc(dev, o.out, sn.d.rule, st, o.nh ? o.nh.ip || cur.dst : cur.dst);
              hop.nat.push(res.nat); st = res.st;
              if (res.unknown) hop.reasons.push(res.unknown);
            }
          }
        }
        hop.srcOut = st.src;
        if (hop.reasons.length) hop.verdict = 'unknown';
        // 交給下一台
        if (!o.nh || !o.nh.ip) return deliver(dev, hop, st, depth, ctx);
        const no = nextOwner(Q, o.routes, o.nh.ip);
        if (no.status === 'unknown') return { hop, next: null, end: end('outside', 'unknown', 'next-hop-outside', dev, `${name(dev)} 的下一跳 ${o.nh.ip} 不在基準內，之後的路徑無法判斷`, { ip: o.nh.ip }) };
        const kids = no.status === 'direct' ? arrive(no.dev, realEp(no.ep), st, depth + 1, ctx) : no.hits.flatMap((x) => arrive(x.dev, undefined, st, depth + 1, ctx));
        return { hop, next: kids, end: null };
      });
    }
    /** 目的在出介面的直連網段：交給擁有目的位址的網路設備（再判斷它的 input），或送達主機。 */
    function deliver(dev, hop, st, depth, ctx) {
      const own = ownerOf(st.dst); const d2 = own ? devOfEp(own) : null;
      if (d2 && d2 !== dev && netDev(d2)) {
        if (!devInfo(d2).collected) return { hop, next: null, end: end('unknown', 'unknown', 'dst-device-uncollected', d2, `目的 ${st.dst} 屬於沒有收集的 ${name(d2)}，它自己的防火牆不明`, { ip: st.dst }) };
        return { hop, next: arrive(d2, realEp(own), st, depth + 1, ctx), end: null };
      }
      return { hop, next: null, end: end('delivered', 'allow', d2 ? 'host' : 'segment', dev, `送達 ${st.dst}（${d2 ? `${name(d2)}，主機本身的防火牆不在範圍內` : '直連網段上的主機'}）`, { ip: st.dst }) };
    }
    function serviceOf(dev, st) {
      if (st.proto !== 'tcp' || st.port == null) return null;
      const sv = Q.ipServicesOf(dev).find((x) => x.port === st.port);
      if (!sv) return null;
      const accepts = !sv.enabled ? false : !sv.addresses.length ? true : st.src == null ? null
        : sv.addresses.some((a) => { const p = S.ip.parseCidr(a); return p ? IP.inNet(st.src, p.net, p.len) : false; });
      return { name: sv.name, enabled: sv.enabled, port: sv.port, addresses: sv.addresses.slice(), basis: sv.basis, accepts, src: sv.src.map((x) => x.slice()) };
    }

    // ---- 起點：來源是網路設備自己的位址 → output；否則找來源所在的網段與閘道
    const locMemo = new Map();
    function srcLocation(src) {
      return U.getOr(locMemo, src, () => {
        const own = ownerOf(src); const sd = own ? devOfEp(own) : null;
        if (sd && netDev(sd)) return { how: 'device', dev: sd, ep: realEp(own) || null };
        const nets = Q.subnets().filter((s) => IP.inNet(src, s.net, s.len));
        if (!nets.length) return { how: 'none' };
        const len = Math.max(...nets.map((s) => s.len));
        const same = nets.filter((s) => s.len === len); const net = same[0].net; const prefix = `${net}/${len}`;
        const cands = U.uniq(same.map((s) => s.dev)).sort(U.natural);
        const epOn = (d) => same.find((s) => s.dev === d).ep;
        const dhcp = U.uniq((m.dhcpNetworks || []).filter((n) => { const p = S.ip.parseCidr(n.network); return p && p.net === net && p.len === len; })
          .flatMap((n) => n.gateways).filter((g) => IP.isIp(g))).sort(U.natural);
        let gws = dhcp.map((g) => ({ ip: g, owner: ownerOf(g) })).filter((g) => g.owner && cands.includes(devOfEp(g.owner))).map((g) => ({ dev: devOfEp(g.owner), ep: realEp(g.owner), gateway: g.ip }));
        let basis = 'dhcp';
        if (!gws.length) { basis = 'routes'; gws = cands.filter((d) => Q.routesOf(d).length).map((d) => ({ dev: d, ep: epOn(d), gateway: null })); }
        if (!gws.length) { basis = 'subnet'; gws = cands.filter((d) => devInfo(d).collected).map((d) => ({ dev: d, ep: epOn(d), gateway: null })); }
        gws = gws.filter((g, i) => gws.findIndex((x) => x.dev === g.dev && x.ep === g.ep) === i);
        return { how: 'subnet', prefix, net, len, gateways: gws, basis };
      });
    }
    /** 一次查詢的起點節點。回傳 { start, nodes, reasons }（nodes 為空時 start.end 是結束原因）。 */
    function begin(src, dst, st, ctx, entry) {
      if (entry) return { start: { how: 'entry', dev: devOfEp(entry), ep: entry, gateways: [] }, nodes: arrive(devOfEp(entry), entry, st, 0, ctx) };
      const loc = srcLocation(src);
      if (loc.how === 'device') {
        if (!devInfo(loc.dev).collected) return { start: { how: 'device', dev: loc.dev, ep: loc.ep, gateways: [] }, nodes: [], end: end('unknown', 'unknown', 'src-device-uncollected', loc.dev, `來源 ${src} 屬於沒有收集的 ${name(loc.dev)}，不知道它的路由與防火牆`) };
        return { start: { how: 'device', dev: loc.dev, ep: loc.ep, gateways: [] }, nodes: originate(loc.dev, st, ctx) };
      }
      if (loc.how === 'none') return { start: { how: 'none', dev: null, ep: null, gateways: [] }, nodes: [], end: end('unknown', 'unknown', 'src-location-unknown', null, `找不到包含 ${src} 的網段，不知道封包從哪台設備進入（可用 entry 指定入口介面）`) };
      const start = { how: 'gateway', prefix: loc.prefix, basis: loc.basis, dev: loc.gateways.length === 1 ? loc.gateways[0].dev : null, ep: loc.gateways.length === 1 ? loc.gateways[0].ep || null : null,
        gateways: loc.gateways.map((g) => ({ dev: g.dev, ep: g.ep || null, gateway: g.gateway })) };
      if (IP.inNet(dst, loc.net, loc.len)) { // 同一個網段：不經過路由器
        const own = ownerOf(dst); const d2 = own ? devOfEp(own) : null;
        start.how = 'same-subnet'; start.dev = null; start.ep = null; start.gateways = [];
        if (d2 && netDev(d2)) {
          if (!devInfo(d2).collected) return { start, nodes: [], end: end('unknown', 'unknown', 'dst-device-uncollected', d2, `目的 ${dst} 屬於沒有收集的 ${name(d2)}，它自己的防火牆不明`, { ip: dst }) };
          return { start, nodes: arrive(d2, realEp(own), st, 0, ctx) };
        }
        return { start, nodes: [], end: end('delivered', 'allow', 'same-subnet', null, `來源與目的在同一個網段 ${loc.prefix}，不經過路由器（bridge filter 與主機防火牆不在範圍內）`) };
      }
      if (!loc.gateways.length) return { start, nodes: [], end: end('unknown', 'unknown', 'no-gateway', null, `網段 ${loc.prefix} 上沒有可當閘道的已收集設備`) };
      return { start, nodes: loc.gateways.flatMap((g) => arrive(g.dev, g.ep, st, 0, ctx)) };
    }

    // ---- 摘要：每個節點的結果（allow／deny／unknown）、原因、決定的規則、牽涉的規則、最後的目的
    const sumMemo = new WeakMap();
    // 牽涉的規則（確定命中、無法判斷、決定結果的），只在 ruleImpact 需要時才算
    const invMemo = new WeakMap();
    const involvedOf = (node) => {
      if (invMemo.has(node)) return invMemo.get(node);
      const s = new Set();
      node.hop.stages.forEach((sg) => { sg.hits.forEach((r) => s.add(r.key)); sg.uncertain.forEach((u) => s.add(u.rule.key)); if (sg.rule) s.add(sg.rule.key); });
      (node.next || []).forEach((k) => involvedOf(k).forEach((x) => s.add(x)));
      invMemo.set(node, s);
      return s;
    };
    const involves = (sum, key) => sum.nodes.some((n) => involvedOf(n).has(key));
    const combine = (list) => {
      const vs = U.uniq(list.map((s) => s.verdict));
      return vs.length === 1 ? vs[0] : 'unknown';
    };
    const ruleId = (sg) => (sg.rule ? sg.rule.key : `policy:${sg.policyDev}|${sg.table}|${sg.chain}`);
    function summary(node) {
      if (sumMemo.has(node)) return sumMemo.get(node);
      const h = node.hop;
      const decisive = new Map(); const reasons = h.reasons.slice(); let nat = h.nat.some((x) => x.dir === 'dst');
      const pick = (sg) => { const id = sg.rule ? sg.rule.key : `policy:${h.dev}|${sg.table}|${sg.chain}`; decisive.set(id, { key: sg.rule ? sg.rule.key : null, dev: h.dev, table: sg.table, chain: sg.chain, policy: !sg.rule, verdict: sg.verdict }); };
      let verdict; let final = { dst: h.dstOut, port: h.portOut };
      const denyStage = h.stages.find((sg) => sg.status === 'decided' && sg.verdict === 'drop');
      if (h.verdict === 'deny' && denyStage) { pick(denyStage); verdict = 'deny'; }
      else {
        h.stages.forEach((sg) => { if (sg.status === 'decided' && (sg.table === 'filter' || (sg.table === 'nat' && sg.verdict !== 'none'))) pick(sg); });
        let v;
        if (node.end) {
          v = node.end.verdict;
          if (node.end.code !== 'local' && node.end.code !== 'host' && node.end.code !== 'segment' && node.end.code !== 'dropped' && node.end.verdict !== 'allow' && !reasons.some((x) => x.code === node.end.code)) reasons.push(reason(node.end.code, node.end.dev, node.end.message, node.end.ip ? { ip: node.end.ip } : {}));
          if (node.end.verdict === 'deny' && !denyStage) decisive.set('route:' + node.end.code + ':' + h.dev, { key: null, dev: h.dev, table: null, chain: null, policy: false, route: node.end.code, verdict: 'drop' });
        } else {
          const kids = node.next.map(summary);
          v = combine(kids);
          kids.forEach((k) => { if (k.nat) nat = true; });
          const sameFinal = kids.every((k) => k.final && kids[0].final && k.final.dst === kids[0].final.dst && k.final.port === kids[0].final.port);
          final = sameFinal && kids.length ? kids[0].final : null;
          if (v === 'unknown' && U.uniq(kids.map((k) => k.verdict)).length > 1) {
            reasons.push(reason('branches-differ', h.dev, `${name(h.dev)} 之後有多條路徑（ECMP），結果不同（${U.uniq(kids.map((k) => k.verdict)).join('、')}），實際走哪一條無法判斷`));
          }
          // 決定的規則只取與結果一致的子路徑
          kids.filter((k) => k.verdict === v || v === 'unknown').forEach((k) => { k.decisive.forEach((x, id) => decisive.set(id, x)); k.reasons.forEach((x) => reasons.push(x)); });
          if (v === 'deny') { decisive.forEach((x, id) => { if (x.verdict !== 'drop') decisive.delete(id); }); }
        }
        verdict = h.verdict === 'unknown' ? (v === 'deny' ? 'deny' : 'unknown') : v;
        if (verdict === 'deny') { decisive.forEach((x, id) => { if (x.verdict !== 'drop') decisive.delete(id); }); }
      }
      const s = { verdict, reasons: dedupeReasons(reasons), decisive, nodes: [node], final, nat };
      sumMemo.set(node, s);
      return s;
    }
    const dedupeReasons = (list) => { const seen = new Set(); return list.filter((r) => { const k = [r.code, r.dev, r.rule ? r.rule.key : '', r.ip || '', (r.keys || []).join(',')].join('|'); if (seen.has(k)) return false; seen.add(k); return true; }); };
    function summarize(b, st) {
      if (!b.nodes.length) {
        const e = b.end;
        return { verdict: e.verdict, reasons: e.verdict === 'unknown' ? [reason(e.code, e.dev, e.message, e.ip ? { ip: e.ip } : {})] : [], decisive: new Map(), nodes: [],
          final: { dst: st.dst, port: st.port }, nat: false };
      }
      const kids = b.nodes.map(summary);
      const v = combine(kids);
      const reasons = []; const decisive = new Map(); let nat = false;
      kids.forEach((k) => { if (k.nat) nat = true; if (k.verdict === v || v === 'unknown') { k.reasons.forEach((x) => reasons.push(x)); k.decisive.forEach((x, id) => decisive.set(id, x)); } });
      if (v === 'unknown' && U.uniq(kids.map((k) => k.verdict)).length > 1) {
        reasons.unshift(reason('branches-differ', null, b.start.gateways.length > 1
          ? `來源網段 ${b.start.prefix} 有多個閘道（${b.start.gateways.map((g) => name(g.dev)).join('、')}），結果不同（${U.uniq(kids.map((k) => k.verdict)).join('、')}）；主機用哪一個閘道無法判斷`
          : `有多條路徑，結果不同（${U.uniq(kids.map((k) => k.verdict)).join('、')}），實際走哪一條無法判斷`));
      }
      const sameFinal = kids.every((k) => k.final && kids[0].final && k.final.dst === kids[0].final.dst && k.final.port === kids[0].final.port);
      return { verdict: v, reasons: dedupeReasons(reasons), decisive, nodes: b.nodes, final: sameFinal ? kids[0].final : null, nat };
    }

    // ---- Q.reach
    const normProto = (p) => {
      if (p === undefined || p === null) throw new TypeError('proto 必須指定（例如 tcp、udp、icmp）');
      return S.infer.fw.protoName(String(p).trim().toLowerCase());
    };
    const normPort = (proto, port) => {
      if (!S.infer.fw.PORT_PROTOCOLS.has(proto)) { if (port != null) throw new TypeError(`${proto} 沒有埠，port 必須省略`); return null; }
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError(`${proto} 需要 port（1–65535 的整數），收到 ${JSON.stringify(port)}`);
      return port;
    };
    const checkVrf = (v) => { if (v != null) throw new TypeError('vrf 目前只能是 null（main 路由表；VRF 在 M3 支援）'); };
    const reachCache = new Map();
    const skipOf = (keys) => (keys && keys.length ? { id: keys.slice().sort().join(','), set: new Set(keys) } : null);
    function evaluate(src, dst, svc, mode, skip, entry) {
      const ctx = { mode, skip, memo: level(nodeMemo, mode + '\u0000' + (skip ? skip.id : '')) };
      const st = { src, dst, proto: svc.proto, port: svc.port };
      const b = begin(src, dst, st, ctx, entry);
      return { b, sum: summarize(b, st) };
    }
    function reach(src, dst, opts) {
      const o = opts || {};
      checkVrf(o.vrf);
      if (!IP.isIp(src) || !IP.isIp(dst)) return { ok: false, error: '請輸入有效的 IPv4 位址' };
      const proto = normProto(o.proto === undefined ? 'tcp' : o.proto); const port = normPort(proto, o.port);
      const entry = o.entry == null ? null : String(o.entry);
      if (entry && !Q.getInterface(entry)) throw new TypeError(`entry 必須是基準中的介面鍵（設備|介面），收到 ${JSON.stringify(entry)}`);
      const skipKeys = o.disabledRules == null ? [] : Array.from(o.disabledRules, String);
      const ck = JSON.stringify([src, dst, proto, port, entry, skipKeys.slice().sort()]);
      if (reachCache.has(ck)) return reachCache.get(ck);
      const { b, sum } = evaluate(src, dst, { proto, port }, 'exact', skipOf(skipKeys), entry);
      const paths = [];
      const walk = (node, acc) => {
        if (paths.length >= MAX_PATHS) return;
        const hops = acc.concat(node.hop);
        if (node.end || !node.next || !node.next.length) { const s = summary(node); paths.push({ hops, end: node.end, verdictAtEnd: s.verdict }); return; }
        node.next.forEach((k) => walk(k, hops));
      };
      b.nodes.forEach((n) => walk(n, []));
      const pathOut = paths.map((p) => {
        const hv = p.hops.map((h) => h.verdict);
        const e = p.end;
        const v = hv.includes('deny') || (e && e.verdict === 'deny') ? 'deny' : hv.includes('unknown') || !e || e.verdict === 'unknown' ? 'unknown' : 'allow';
        return { verdict: v, hops: p.hops, end: e };
      });
      if (!b.nodes.length) pathOut.push({ verdict: b.end.verdict, hops: [], end: b.end });
      const reasons = sum.reasons.slice();
      if (paths.length >= MAX_PATHS) reasons.push(reason('branch-limit', null, `路徑超過 ${MAX_PATHS} 條，只列出前 ${MAX_PATHS} 條`));
      const verdict = paths.length >= MAX_PATHS && sum.verdict !== 'deny' ? 'unknown' : sum.verdict;
      const out = deepFreeze(JSON.parse(JSON.stringify({
        ok: true, src, dst, proto, port, vrf: null, entry, verdict,
        final: sum.final, natApplied: sum.nat, start: b.start,
        reasons: verdict === 'unknown' ? reasons : [],
        notes: verdict === 'unknown' ? [] : reasons,
        decisive: Array.from(sum.decisive.values()).map((x) => (x.key ? Object.assign({ policy: false, verdict: x.verdict }, Q.getFirewallRule(x.key) ? ref(Q.getFirewallRule(x.key)) : { key: x.key }) : x)),
        paths: pathOut, assumptions: ASSUMPTIONS,
      })));
      reachCache.set(ck, out);
      return out;
    }

    // ---- zone
    const zoneCache = new Map();
    let vlanNames = null;
    const vlanNamesOf = (id) => {
      if (!vlanNames) { vlanNames = new Map(); m.vlans.forEach((v) => { if (v.id != null && v.name) { const a = U.getOr(vlanNames, v.id, () => []); if (!a.includes(v.name)) a.push(v.name); } }); vlanNames.forEach((a) => a.sort(U.natural)); }
      return vlanNames.get(id) || [];
    };
    /** 網段所屬的 VLAN：prefixes 的 vlan；各設備不一致（A07）時取多數的介面，平手為 null。 */
    const vlanOfPrefix = (p) => {
      if (p.vlan != null) return { id: p.vlan, majority: false };
      const count = new Map();
      p.eps.forEach((ep) => { const i = Q.getInterface(ep); if (i && i.encapVlan != null) count.set(i.encapVlan, (count.get(i.encapVlan) || 0) + 1); });
      const best = Array.from(count.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      if (!best.length || (best[1] && best[1][1] === best[0][1])) return null;
      return { id: best[0][0], majority: true, all: best.map((x) => x[0]) };
    };
    function zoneOpts(opts) {
      const o = opts || {};
      let prof = null; let profHash = null;
      if (o.profile != null) {
        prof = S.profile.compile(o.profile);
        const meta = Q.meta().profile;
        if (!meta || meta.id !== prof.id || String(meta.version) !== prof.version) {
          throw new TypeError(`命名規則（${prof.id} 版本 ${prof.version}）與建立基準時的不同（${meta ? `${meta.id} 版本 ${meta.version}` : '沒有套用命名規則'}）；請用同一份命名規則重新建立基準`);
        }
        // id 與 version 相同、內容不同（例如改了 zones 段卻沒改 version）時，算出的 zone 會和這一輪的基準不一致：比對全文雜湊
        profHash = S.profile.hash(o.profile);
        if (meta.hash == null) {
          throw new TypeError(`基準沒有記錄命名規則（${prof.id} 版本 ${prof.version}）的內容雜湊（2.11.0 以前建立），無法確認是同一份命名規則；請重新建立基準`);
        }
        if (meta.hash !== profHash) {
          throw new TypeError(`命名規則（${prof.id} 版本 ${prof.version}）的內容與建立基準時的不同（id 與 version 相同，但內容雜湊不一致，例如改了 zones 段卻沒改 version）；請用同一份命名規則重新建立基準，或修改命名規則時一併提高 version`);
        }
      }
      const sources = o.sources == null ? ZONE_SOURCES.slice() : Array.from(o.sources, String);
      sources.forEach((s) => { if (!ZONE_SOURCES.includes(s)) throw new TypeError(`sources 只能包含 ${ZONE_SOURCES.join('、')}，收到 ${JSON.stringify(s)}`); });
      if (!sources.includes('subnet')) sources.push('subnet'); // 最後一定以網段本身當 zone，每個網段都有 zone
      return { prof, profHash, sources: ZONE_SOURCES.filter((s) => sources.includes(s)) };
    }
    function zones(opts) {
      const zo = zoneOpts(opts);
      const ck = JSON.stringify([zo.profHash, zo.sources]);
      if (zoneCache.has(ck)) return zoneCache.get(ck);
      const zmap = new Map(); const subnets = [];
      const zoneOfDef = (id, nm, source, inferred, basis) => U.getOr(zmap, id, () => ({ id, name: nm, source, inferred, basis, subnets: [], devices: new Set() }));
      prefixes4().forEach((x) => {
        const p = x.p; const cands = [];
        const ownEps = p.eps.filter((ep) => devInfo(devOfEp(ep)).collected);
        const vl = vlanOfPrefix(p);
        if (zo.sources.includes('profile') && zo.prof && zo.prof.zoneOf) {
          const hit = zo.prof.zoneOf({
            subnet: p.prefix, vlans: vl ? [{ id: vl.id, names: vlanNamesOf(vl.id) }] : [],
            interfaces: ownEps.map((ep) => { const i = Q.getInterface(ep); return { name: i ? i.name : K.splitEp(ep)[1], desc: i ? i.desc : null }; }),
          });
          if (hit) cands.push({ source: 'profile', id: 'tag:' + hit.zone, name: hit.zone, inferred: false, basis: `命名規則 ${zo.prof.id} 的 zones[${hit.rule}]（${hit.on} 符合 ${hit.match}）`, detail: { rule: hit.rule } });
        }
        if (zo.sources.includes('interface-list')) {
          const lists = [];
          ownEps.forEach((ep) => {
            const d = devOfEp(ep); if (!devInfo(d).config) return;
            const ctx = I.ctxOf(d);
            Q.interfaceListsOf(d).forEach((l) => {
              if (!l.defined) return;
              const set = ctx.resolve(l.name);
              if (set && set.has(ep)) lists.push({ name: l.name, dev: d, ep, size: set.size, src: l.src.map((s) => s.slice()) });
            });
          });
          lists.sort((a, b) => a.size - b.size || U.natural(a.name, b.name) || U.natural(a.dev, b.dev));
          if (lists.length) {
            const names = U.uniq(lists.map((l) => l.name));
            cands.push({ source: 'interface-list', id: 'list:' + lists[0].name, name: lists[0].name, inferred: true,
              basis: `${Q.epName(lists[0].ep)} 是 interface list ${lists[0].name} 的成員（事實），以清單當 zone（推論）${names.length > 1 ? `；也屬於 ${names.slice(1).join('、')}，取成員最少的清單` : ''}`,
              detail: { lists: lists.map((l) => ({ name: l.name, dev: l.dev, ep: l.ep, members: l.size, src: l.src })) } });
          }
        }
        if (zo.sources.includes('vlan') && vl) {
          const names = vlanNamesOf(vl.id);
          cands.push({ source: 'vlan', id: 'vlan:' + vl.id, name: names.length ? `VLAN ${vl.id}（${names.join('／')}）` : `VLAN ${vl.id}`, inferred: true,
            basis: vl.majority ? `網段設在 VLAN ${vl.all.join('、')} 的介面上（各設備不一致，見 A07），取多數的 VLAN ${vl.id}（推論）` : `網段設在 VLAN ${vl.id} 的介面上（推論：同一個 VLAN ID 視為同一個 zone）`,
            detail: { vlan: vl.id } });
        }
        cands.push({ source: 'subnet', id: 'subnet:' + p.prefix, name: p.prefix, inferred: true, basis: '沒有其他來源，以網段本身當 zone（推論）', detail: {} });
        const pickC = zo.sources.map((s) => cands.find((c) => c.source === s)).find(Boolean);
        const z = zoneOfDef(pickC.id, pickC.name, pickC.source, pickC.inferred, pickC.source === 'subnet' ? pickC.basis : null);
        z.subnets.push(p.prefix); p.eps.forEach((ep) => z.devices.add(devOfEp(ep)));
        subnets.push({ prefix: p.prefix, net: p.net, len: p.len, vrf: null, zone: pickC.id, source: pickC.source, inferred: pickC.inferred, basis: pickC.basis, detail: pickC.detail,
          alternatives: cands.filter((c) => c !== pickC && zo.sources.includes(c.source)).map((c) => ({ zone: c.id, source: c.source })), eps: p.eps.slice() });
      });
      const order = (z) => ZONE_SOURCES.indexOf(z.source);
      const list = Array.from(zmap.values()).map((z) => ({
        id: z.id, name: z.name, source: z.source, inferred: z.inferred,
        basis: z.basis || { profile: '命名規則的 zones 標籤（註解，不改寫事實）', 'interface-list': 'interface list（防火牆的 zone）', vlan: 'VLAN ID' }[z.source],
        subnets: z.subnets.slice().sort(U.natural), devices: Array.from(z.devices).sort(U.natural), vrf: null,
      })).sort((a, b) => order(a) - order(b) || U.natural(a.name, b.name) || U.cmp(a.id, b.id));
      const bySubnet = new Map(subnets.map((s) => [s.prefix, s]));
      const out = { zones: deepFreeze(list), subnets: deepFreeze(subnets), bySubnet, byId: new Map(list.map((z) => [z.id, z])), opts: zo };
      zoneCache.set(ck, out);
      return out;
    }
    function zoneOf(ip, opts) {
      if (!IP.isIp(ip)) return null;
      const zs = zones(opts); const x = longest(ip);
      if (!x) return null;
      const s = zs.bySubnet.get(x.prefix);
      return { zone: s.zone, subnet: s.prefix, source: s.source, inferred: s.inferred };
    }

    // ---- zone 矩陣：每個 zone 的代表位址（等價類）× 目的（代表位址＋dst-nat 的入口）× service
    function repsOf(zs) {
      bounds();
      const arpIps = Array.from(new Set(m.arps.map((a) => a.ip))).filter((ip) => IP.isIp(ip)).map((ip) => IP.toInt(ip)).sort((a, b) => a - b);
      const out = new Map(); // zone → [rep]
      prefixes4().forEach((x) => {
        const s = zs.bySubnet.get(x.prefix);
        const lo0 = x.len >= 31 ? x.lo : x.lo + 1; const hi0 = x.len >= 31 ? x.hi : x.hi - 1;
        let i = findAtom(repB, x.lo);
        while (i < repB.length && repB[i] <= x.hi) {
          const a = Math.max(repB[i], x.lo); const b = Math.min(i + 1 < repB.length ? repB[i + 1] - 1 : 0xffffffff, x.hi); i++;
          if (longest(IP.fromInt(a)).prefix !== x.prefix) continue; // 屬於更長的網段
          const lo = Math.max(a, lo0); const hi = Math.min(b, hi0); if (lo > hi) continue;
          const free = (n) => { const o = ownerOf(IP.fromInt(n)); return !o || !netDev(devOfEp(o)); };
          let rep = null; let basis = 'arp';
          let k = findAtom(Float64Array.from(arpIps.length ? arpIps : [0]), lo);
          for (; k < arpIps.length && arpIps[k] <= hi; k++) if (arpIps[k] >= lo && free(arpIps[k])) { rep = arpIps[k]; break; }
          if (rep === null) { basis = 'synthetic'; for (let n = lo, c = 0; n <= hi && c < 4096; n++, c++) if (free(n)) { rep = n; break; } }
          if (rep === null) continue;
          const ip = IP.fromInt(rep);
          U.getOr(out, s.zone, () => []).push({ ip, zone: s.zone, subnet: x.prefix, range: [IP.fromInt(a), IP.fromInt(b)], basis, via: 'member', dev: null });
        }
      });
      out.forEach((list) => list.sort((p, q) => IP.toInt(p.ip) - IP.toInt(q.ip)));
      return out;
    }
    function vipsOf(zs) {
      const out = [];
      m.firewallRules.forEach((r) => {
        if (r.family !== 'ip' || r.table !== 'nat' || r.disabled || r.action !== 'dst-nat') return;
        const to = single(r.params['to-addresses']); if (!to) return;
        const tz = zoneOf(to, zs.optsRaw); if (!tz) return;
        const ctx = I.ctxOf(r.dev);
        const dstA = r.match['dst-address'] !== undefined && !F.splitNeg(r.match['dst-address']).neg ? single(F.splitNeg(r.match['dst-address']).body.replace(/\/32$/, '')) : undefined;
        let ips;
        if (dstA) ips = [dstA];
        else {
          const okEp = (ep) => ['in-interface', 'in-interface-list'].every((k) => {
            const v = r.match[k]; if (v === undefined) return true;
            const { neg, body } = F.splitNeg(v);
            const set = k === 'in-interface' ? new Set([K.ep(r.dev, body)]) : ctx.resolve(body);
            if (!set) return false;
            return neg ? !set.has(ep) : set.has(ep);
          });
          ips = Q.interfacesOf(r.dev).filter((i) => okEp(i.key)).flatMap((i) => ownIps(i.key).map((a) => a.ip));
        }
        U.uniq(ips).filter((ip) => IP.isIp(ip)).sort(U.natural).forEach((ip) => out.push({ ip, zone: tz.zone, subnet: tz.subnet, range: null, basis: 'dst-nat', via: 'nat', rule: r.key, natTo: to, dev: r.dev }));
      });
      return out;
    }
    function servicesOf(list) {
      if (list != null) {
        if (!Array.isArray(list) || !list.length) throw new TypeError('services 必須是非空陣列，例如 [{ proto: "tcp", port: 443 }]');
        return list.map((s) => { const proto = normProto(s && s.proto); return { proto, port: normPort(proto, s.port == null ? null : s.port) }; })
          .filter((s, i, a) => a.findIndex((x) => svcId(x) === svcId(s)) === i);
      }
      const extra = [];
      m.firewallRules.forEach((r) => {
        if (r.family !== 'ip' || r.table !== 'nat' || r.disabled || r.action !== 'dst-nat' || r.match['dst-port'] === undefined) return;
        const p = r.match.protocol && !F.splitNeg(r.match.protocol).neg ? F.protoName(F.splitNeg(r.match.protocol).body.split(',')[0]) : 'tcp';
        const v = F.parseVal('dst-port', r.match['dst-port']);
        if (v.kind === 'ranges' && !v.neg && F.PORT_PROTOCOLS.has(p)) extra.push({ proto: p, port: Number(v.items[0][0]) });
      });
      const all = SERVICES.map((s) => ({ proto: s.proto, port: s.port })).concat(extra);
      const PO = ['icmp', 'tcp', 'udp'];
      return all.filter((s, i, a) => a.findIndex((x) => svcId(x) === svcId(s)) === i)
        .sort((a, b) => (PO.indexOf(a.proto) + 1 || 9) - (PO.indexOf(b.proto) + 1 || 9) || U.cmp(a.proto, b.proto) || (a.port || 0) - (b.port || 0));
    }
    const STATUS = (c) => (c.allow && c.deny ? 'partial' : c.unknown ? 'unknown' : c.allow ? 'allow' : c.deny ? 'deny' : 'empty');
    const matrixCache = new Map();
    /**
     * service 的等價類：協定與埠對所有規則的條件結果相同的 service 只算一次（結果完全相同，只差最後的埠）。
     * 協定：規則提到的協定各自一類，其他依有沒有埠分兩類；埠：規則的 dst-port／port 邊界切出的區段。回傳 [[service 索引]]，依第一個索引排序。
     */
    let svcBounds = null;
    function svcClasses(services) {
      if (!svcBounds) {
        const protos = new Set(); const ports = new Set([0]);
        m.firewallRules.forEach((r) => {
          if (r.family !== 'ip') return;
          if (r.match.protocol !== undefined) F.splitNeg(r.match.protocol).body.split(',').forEach((p) => protos.add(F.protoName(p.trim().toLowerCase())));
          ['dst-port', 'port'].forEach((k) => {
            if (r.match[k] === undefined) return;
            const v = F.parseVal(k, r.match[k]);
            if (v.kind === 'ranges') v.items.forEach(([a, b]) => { ports.add(Number(a)); ports.add(Number(b) + 1); }); else ports.add(NaN);
          });
        });
        svcBounds = { protos, ports: ports.has(NaN) ? null : Float64Array.from(Array.from(ports).sort((a, b) => a - b)) };
      }
      const keyOf = (s) => {
        const p = svcBounds.protos.has(s.proto) ? s.proto : F.PORT_PROTOCOLS.has(s.proto) ? '~port' : '~noport';
        const pt = s.port == null ? -1 : svcBounds.ports ? findAtom(svcBounds.ports, s.port) : s.port; // 無法解析的埠清單：每個埠各自一類
        return p + '|' + pt;
      };
      const out = new Map();
      services.forEach((s, i) => U.getOr(out, keyOf(s), () => []).push(i));
      return Array.from(out.values());
    }
    function matrixRaw(opts) {
      const o = opts || {};
      const zs = zones(o); zs.optsRaw = o;
      const services = servicesOf(o.services);
      const ck = JSON.stringify([zs.opts.profHash, zs.opts.sources, services.map(svcId)]);
      if (matrixCache.has(ck)) return matrixCache.get(ck);
      const reps = repsOf(zs); const vips = vipsOf(zs);
      const zoneIds = zs.zones.map((z) => z.id);
      const srcReps = []; zoneIds.forEach((z) => (reps.get(z) || []).forEach((r) => srcReps.push(r)));
      const targets = srcReps.concat(vips);
      const cells = new Map();
      const cellOf = (a, b) => U.getOr(cells, a + '\u0000' + b, () => ({ src: a, dst: b, recs: [] }));
      const classes = svcClasses(services);
      srcReps.forEach((a, ai) => targets.forEach((t, ti) => {
        if (a.ip === t.ip) return;
        classes.forEach((sis) => {
          const rp = services[sis[0]].port;
          const { sum } = evaluate(a.ip, t.ip, services[sis[0]], 'atom', null, null);
          if (t.via === 'nat' && !sum.nat) return; // dst-nat 的入口只算真的被改寫的
          let dz = t.zone;
          if (sum.final && sum.final.dst !== t.ip) { const z = zoneOf(sum.final.dst, o); if (z) dz = z.zone; }
          const c = cellOf(a.zone, dz);
          sis.forEach((si) => c.recs.push({ ai, ti, si, sum, rp }));
        });
      }));
      const res = { zs, services, srcReps, targets, cells, zoneIds, opts: o };
      matrixCache.set(ck, res);
      return res;
    }
    function cellSummary(mx, c) {
      const counts = { allow: 0, deny: 0, unknown: 0, total: 0 };
      const bySvc = mx.services.map(() => ({ allow: 0, deny: 0, unknown: 0, total: 0 }));
      const rules = new Map(); const reasons = new Map();
      const byDst = new Map(); const bySrc = new Map();
      c.recs.forEach((r) => {
        const v = r.sum.verdict; counts[v]++; counts.total++; bySvc[r.si][v]++; bySvc[r.si].total++;
        r.sum.decisive.forEach((x, id) => { const e = U.getOr(rules, id + '\u0000' + x.verdict, () => Object.assign({ id, count: 0 }, x)); e.count++; });
        if (v === 'unknown') r.sum.reasons.forEach((x) => reasons.set(x.code, (reasons.get(x.code) || 0) + 1));
        if (v !== 'unknown') { U.getOr(byDst, r.ti + '|' + r.si, () => new Set()).add(v); U.getOr(bySrc, r.ai + '|' + r.si, () => new Set()).add(v); }
      });
      const het = Array.from(byDst.values()).some((s) => s.size > 1) || Array.from(bySrc.values()).some((s) => s.size > 1);
      const ruleList = Array.from(rules.values()).sort((a, b) => b.count - a.count || U.cmp(a.id, b.id)).map(({ id, ...x }) => Object.assign({ id }, x, x.key ? { rule: ref(Q.getFirewallRule(x.key)) } : {}));
      return {
        src: c.src, dst: c.dst, diagonal: c.src === c.dst, status: STATUS(counts), counts, heterogeneous: het,
        services: mx.services.map((s, i) => ({ service: svcId(s), proto: s.proto, port: s.port, status: STATUS(bySvc[i]), counts: bySvc[i] })),
        rule: ruleList.find((x) => x.key) || ruleList[0] || null, rules: ruleList.slice(0, 5), ruleCount: ruleList.length,
        reasons: Array.from(reasons.entries()).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || U.cmp(a.code, b.code)),
      };
    }
    const l0Cache = new Map();
    function matrix(opts) {
      const mx = matrixRaw(opts);
      const ck = JSON.stringify([mx.zs.opts.profHash, mx.zs.opts.sources, mx.services.map(svcId)]);
      if (l0Cache.has(ck)) return l0Cache.get(ck);
      const cells = [];
      mx.zoneIds.forEach((a) => mx.zoneIds.forEach((b) => {
        const c = mx.cells.get(a + '\u0000' + b);
        cells.push(c ? cellSummary(mx, c) : { src: a, dst: b, diagonal: a === b, status: 'empty', counts: { allow: 0, deny: 0, unknown: 0, total: 0 }, heterogeneous: false,
          services: mx.services.map((s) => ({ service: svcId(s), proto: s.proto, port: s.port, status: 'empty', counts: { allow: 0, deny: 0, unknown: 0, total: 0 } })), rule: null, rules: [], ruleCount: 0, reasons: [] });
      }));
      const reps = mx.srcReps.length; const evaluations = Array.from(mx.cells.values()).reduce((n, c) => n + c.recs.length, 0);
      const out = deepFreeze({
        vrf: null, zones: mx.zs.zones, services: mx.services.map((s) => ({ id: svcId(s), proto: s.proto, port: s.port })), cells,
        stats: { zones: mx.zoneIds.length, representatives: reps, natEntries: mx.targets.length - reps, evaluations },
      });
      l0Cache.set(ck, out);
      return out;
    }
    const recOut = (mx, r) => {
      const a = mx.srcReps[r.ai]; const t = mx.targets[r.ti]; const s = mx.services[r.si];
      return { src: a, dst: t, service: svcId(s), verdict: r.sum.verdict, final: r.sum.final && r.sum.final.port === r.rp ? { dst: r.sum.final.dst, port: s.port } : r.sum.final,
        rules: Array.from(r.sum.decisive.values()).map((x) => (x.key ? x.key : `policy:${x.dev}|${x.table}|${x.chain}`)),
        reasons: r.sum.verdict === 'unknown' ? U.uniq(r.sum.reasons.map((x) => x.code)) : [] };
    };
    function cell(srcZone, dstZone, opts) {
      const mx = matrixRaw(opts);
      if (!mx.zs.byId.has(srcZone) || !mx.zs.byId.has(dstZone)) throw new TypeError(`沒有這個 zone：${!mx.zs.byId.has(srcZone) ? srcZone : dstZone}`);
      const c = mx.cells.get(srcZone + '\u0000' + dstZone) || { src: srcZone, dst: dstZone, recs: [] };
      const sm = cellSummary(mx, c);
      // L1：每個（來源代表、目的）一列，依 service 列出結果；結果相同的來源併成一組（規格書 §5.7）
      const pairs = new Map();
      c.recs.forEach((r) => {
        const p = U.getOr(pairs, r.ai + '|' + r.ti, () => ({ ai: r.ai, ti: r.ti, services: [] }));
        const x = recOut(mx, r); p.services.push({ service: x.service, verdict: x.verdict, final: x.final, rules: x.rules, reasons: x.reasons });
      });
      const rows = new Map();
      Array.from(pairs.values()).sort((p, q) => p.ti - q.ti || p.ai - q.ai).forEach((p) => {
        const sig = JSON.stringify(p.services.map((s) => [s.service, s.verdict, s.rules, s.reasons]));
        const row = U.getOr(rows, p.ti + '|' + sig, () => ({ dst: mx.targets[p.ti], srcs: [], services: p.services }));
        row.srcs.push(mx.srcReps[p.ai]);
      });
      const groups = Array.from(rows.values()).map((r) => {
        const c2 = { allow: 0, deny: 0, unknown: 0 }; r.services.forEach((s) => { c2[s.verdict]++; });
        return Object.assign(r, { status: STATUS(c2), counts: c2,
          srcDevices: U.uniq(r.srcs.flatMap((s) => { const l = srcLocation(s.ip); return l.how === 'subnet' ? l.gateways.map((g) => g.ep || g.dev) : l.dev ? [l.dev] : []; })).sort(U.natural) });
      });
      // L2：牽涉的規則
      const rules = new Map();
      c.recs.forEach((r) => {
        r.sum.decisive.forEach((x, id) => {
          const e = U.getOr(rules, id, () => ({ id, key: x.key, dev: x.dev, table: x.table, chain: x.chain, policy: !!x.policy, route: x.route || null, rule: x.key ? ref(Q.getFirewallRule(x.key)) : null, verdicts: { allow: 0, deny: 0, unknown: 0 }, services: [] }));
          e.verdicts[r.sum.verdict]++; const sv = svcId(mx.services[r.si]); if (!e.services.includes(sv)) e.services.push(sv);
        });
        if (r.sum.verdict === 'unknown') r.sum.reasons.forEach((x) => {
          if (!x.rule) return;
          const e = U.getOr(rules, x.rule.key, () => ({ id: x.rule.key, key: x.rule.key, dev: x.rule.dev, table: x.rule.table, chain: x.rule.chain, policy: false, route: null, rule: x.rule, verdicts: { allow: 0, deny: 0, unknown: 0 }, services: [] }));
          e.uncertain = (e.uncertain || 0) + 1;
        });
      });
      const ruleList = Array.from(rules.values()).map((e) => Object.assign({ uncertain: 0 }, e))
        .sort((a, b) => (b.verdicts.allow + b.verdicts.deny + b.verdicts.unknown + b.uncertain) - (a.verdicts.allow + a.verdicts.deny + a.verdicts.unknown + a.uncertain) || U.cmp(a.id, b.id));
      return deepFreeze(JSON.parse(JSON.stringify(Object.assign({}, sm, { groups, ruleDetails: ruleList }))));
    }

    // ---- 規則的影響
    function ruleImpact(key, opts) {
      const rule = Q.getFirewallRule(key);
      if (!rule) return null;
      const o = opts || {};
      const mx = matrixRaw(o);
      const limit = o.limit == null ? 50 : o.limit;
      const recs = [];
      mx.cells.forEach((c) => c.recs.forEach((r) => { if (involves(r.sum, key)) recs.push({ plane: 'transit', src: mx.srcReps[r.ai], dst: mx.targets[r.ti], svc: mx.services[r.si], sum: r.sum, cell: [c.src, c.dst] }); }));
      // 設備本身（input／output）：所有代表位址 → 這台設備的位址、這台設備的位址 → 所有目的
      if (rule.table !== 'nat' || rule.chain !== 'srcnat') {
        const own = U.uniq(Q.interfacesOf(rule.dev).flatMap((i) => ownIps(i.key).map((a) => a.ip))).sort(U.natural);
        const zoneOfIp = (ip) => { const z = zoneOf(ip, o); return z ? z.zone : null; };
        const finalZone = (sum, ip) => zoneOfIp(sum.final && sum.final.dst ? sum.final.dst : ip); // zone 以 NAT 後的位址為準
        own.forEach((ip) => mx.srcReps.forEach((a) => mx.services.forEach((svc) => {
          if (a.ip === ip) return;
          const { sum } = evaluate(a.ip, ip, svc, 'atom', null, null);
          if (involves(sum, key)) recs.push({ plane: 'device', src: a, dst: { ip, zone: zoneOfIp(ip), subnet: null, via: 'device', dev: rule.dev }, svc, sum, cell: [a.zone, finalZone(sum, ip)] });
        })));
        own.forEach((ip) => mx.targets.forEach((t) => mx.services.forEach((svc) => {
          if (t.ip === ip) return;
          const { sum } = evaluate(ip, t.ip, svc, 'atom', null, null);
          if (involves(sum, key)) recs.push({ plane: 'device', src: { ip, zone: zoneOfIp(ip), subnet: null, via: 'device', dev: rule.dev }, dst: t, svc, sum, cell: [zoneOfIp(ip), finalZone(sum, t.ip)] });
        })));
      }
      const roleOf = (r) => {
        const d = Array.from(r.sum.decisive.values()).some((x) => x.key === key);
        const u = r.sum.reasons.some((x) => x.rule && x.rule.key === key);
        return d ? 'decides' : u ? 'uncertain' : 'passes';
      };
      const cellMap = new Map();
      const skip = skipOf([key]);
      const changed = [];
      recs.forEach((r) => {
        const role = roleOf(r);
        const e = U.getOr(cellMap, r.cell.join('\u0000'), () => ({ src: r.cell[0], dst: r.cell[1], plane: r.plane, services: [], decides: 0, uncertain: 0, passes: 0, verdicts: { allow: 0, deny: 0, unknown: 0 } }));
        e[role]++; e.verdicts[r.sum.verdict]++; if (!e.services.includes(svcId(r.svc))) e.services.push(svcId(r.svc));
        const alt = evaluate(r.src.ip, r.dst.ip, r.svc, 'atom', skip, null).sum;
        if (alt.verdict !== r.sum.verdict) changed.push({ src: r.src.ip, dst: r.dst.ip, srcZone: r.cell[0], dstZone: r.cell[1], service: svcId(r.svc), from: r.sum.verdict, to: alt.verdict, plane: r.plane });
      });
      const sortRec = (a, b) => U.cmp(a.srcZone || '', b.srcZone || '') || U.cmp(a.dstZone || '', b.dstZone || '') || IP.toInt(a.src) - IP.toInt(b.src) || IP.toInt(a.dst) - IP.toInt(b.dst) || U.cmp(a.service, b.service);
      const paths = recs.map((r) => ({ src: r.src.ip, dst: r.dst.ip, srcZone: r.cell[0], dstZone: r.cell[1], service: svcId(r.svc), plane: r.plane, role: roleOf(r), verdict: r.sum.verdict })).sort(sortRec);
      changed.sort(sortRec);
      const changeCounts = {}; changed.forEach((c) => { const k = c.from + '→' + c.to; changeCounts[k] = (changeCounts[k] || 0) + 1; });
      const fs = Q.findingsFor('rule', key);
      return deepFreeze(JSON.parse(JSON.stringify({
        rule: Object.assign({}, ref(rule), { stats: rule.stats || null }), shadowed: fs.some((f) => f.id === 'F01'), duplicate: fs.some((f) => f.id === 'F02'), findings: fs.map((f) => Q.findingKey(f)),
        cells: Array.from(cellMap.values()).sort((a, b) => U.cmp(a.plane, b.plane) || U.cmp(a.src || '', b.src || '') || U.cmp(a.dst || '', b.dst || '')),
        total: { evaluations: recs.length, decides: paths.filter((p) => p.role === 'decides').length, uncertain: paths.filter((p) => p.role === 'uncertain').length, passes: paths.filter((p) => p.role === 'passes').length },
        paths: paths.slice(0, limit), truncated: paths.length > limit,
        ifDisabled: { changed: changed.slice(0, limit), counts: changeCounts, total: changed.length, truncated: changed.length > limit },
      })));
    }

    return { reach, zones: (o) => ({ zones: zones(o).zones, subnets: zones(o).subnets }), zoneOf, matrix, cell, ruleImpact };
  }

  // 靜態資訊（不依賴 Snapshot）：預設 service、zone 來源與可達性前提，畫面經 S.query.* 讀取
  if (S.query) {
    S.query.l4Services = () => SERVICES;
    S.query.zoneSources = () => ZONE_SOURCES;
    S.query.reachAssumptions = () => ASSUMPTIONS;
  }
})(globalThis.SSOT = globalThis.SSOT || {});
