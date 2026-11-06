/*
 * 路由追蹤（L3，查詢層，只讀 Snapshot）。L4 可達性與 zone 矩陣在 src/query/reach.js。
 *
 * 路由追蹤 S.trace(Q, src, dst)：在基準的路由表上，從來源 IP 逐跳走到目的 IP。
 *  - 起點：介面網段包含來源 IP 的設備（最長遮罩優先），即來源的閘道
 *  - 每一跳：目的在直連網段 → 抵達；否則最長前綴比對，同遮罩多條即 ECMP 分支
 *  - 下一跳 IP → 擁有該 IP 的設備；下一跳本身不屬於任何設備時，沿本機路由表遞迴解析（S.check.resolveNextHop）；找不到、沒有路由資料、黑洞路由、迴圈、TTL 用盡都會停下並註明原因
 *  每一跳的轉送決定（lookup、routeDecision、nextOwner，掛在 S.trace 上）與 L4 可達性（src/query/reach.js 的 S.reach.engine）共用，不另寫一份。
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
  /** 某設備某個 VRF 的路由表（routes[].vrf 等於它）；VRF 不在基準中（例如 @ 寫了不存在的名稱）時為空。 */
  const routesIn = (Q, dev, vrf) => (Q.vrfs().includes(vrf) ? Q.routesOf(dev, vrf) : []);
  /**
   * 路由與網段的數字形式，依查詢介面回傳的（凍結、會重用的）陣列快取：判斷式與 IP.inNet 相同，只是不必每次比對都把位址字串轉成數字
   * （1000 台時 zone 矩陣會查數萬次路由表，每次掃過整張表）。
   */
  const numMemo = new WeakMap();
  const numOf = (list, addrOf) => {
    let x = numMemo.get(list);
    if (!x) { x = list.map((e) => { const mask = IP.maskOf(e.len); return { mask, net: (IP.toInt(addrOf(e)) & mask) >>> 0 }; }); numMemo.set(list, x); }
    return x;
  };
  const netOfSubnet = (s) => s.net;
  const netOfRoute = (r) => r.prefix;
  /** list 中包含 n（IP.toInt 的結果）的元素，順序不變（同 list.filter((e) => IP.inNet(位址, …))）。 */
  const containing = (list, addrOf, n) => { const xs = numOf(list, addrOf); const out = []; for (let i = 0; i < list.length; i++) if (((n & xs[i].mask) >>> 0) === xs[i].net) out.push(list[i]); return out; };
  /** 最長前綴的路由（同遮罩多條全取，順序不變）。 */
  const longestRoutes = (routes, n) => {
    let best = -1; let cands = [];
    containing(routes, netOfRoute, n).forEach((r) => { if (r.len > best) { best = r.len; cands = [r]; } else if (r.len === best) cands.push(r); });
    return cands;
  };
  /**
   * 一台設備在某個 VRF 對目的位址的轉送決定（ADR-015：只看那個 VRF 的直連網段與路由表）：
   *   { kind: 'connected', conn }：目的在直連網段（conn 是 Q.subnets() 的元素，最長遮罩）
   *   { kind: 'no-route-data' }：沒有路由表資料（這台設備一筆路由都沒有）
   *   { kind: 'no-match', routes }：沒有符合的路由
   *   { kind: 'blackhole', route, routes }：最長前綴的路由都是黑洞
   *   { kind: 'route', route, proto, nhs: [{ r, n }], routes }：下一跳（同遮罩多條即 ECMP）；n.vrf 是解析這個閘道的 VRF
   * 每種結果都有 vrf（做出決定的 VRF）與 via（經過的 VRF，依序）：路由的閘道是 VRF 介面（下一跳 vrfBasis 為 vrf-interface，
   * 手冊：gateway=vrfTest2）時在同一台設備的那個 VRF 再查一次，via 會有兩個以上。
   */
  function lookup(Q, dev, dst, vrf, via) {
    const v = K.vrf(vrf); const seen = (via || []).concat(v);
    const done = (x) => Object.assign(x, { vrf: v, via: seen, table: v });
    const n = IP.toInt(dst);
    const conn = containing(Q.subnetsOf(dev, v), netOfSubnet, n).sort((a, b) => b.len - a.len)[0];
    if (conn) return done({ kind: 'connected', conn });
    if (!Q.routesOf(dev).length) return done({ kind: 'no-route-data', routes: [] });
    const routes = routesIn(Q, dev, v);
    const cands = longestRoutes(routes, n);
    if (!cands.length) return done({ kind: 'no-match', routes });
    const route = `${cands[0].prefix}/${cands[0].len}`;
    if (cands.every((r) => r.blackhole)) return done({ kind: 'blackhole', route, routes });
    const nhs = [];
    cands.forEach((r) => r.nh.forEach((n) => nhs.push({ r, n })));
    const leak = nhs.find(({ n }) => !n.ip && n.vrfBasis === 'vrf-interface' && n.vrf !== v);
    if (leak && !seen.includes(leak.n.vrf)) return lookup(Q, dev, dst, leak.n.vrf, seen);
    return done({ kind: 'route', route, proto: cands[0].proto, nhs, routes });
  }
  /**
   * 在一張路由表查目的：main 或這台設備的 VRF 用 lookup（含直連網段）；其他路由表（/routing table 定義的策略路由表）只有寫進那張表的路由，
   * 沒有直連網段（直連路由只在 main 與 VRF 的表）。回傳同 lookup，另有 table。
   */
  function lookupTable(Q, dev, dst, table) {
    if (table === K.MAIN_VRF || Q.vrfsOf(dev).some((v) => !v.disabled && !v.builtin && v.name === table)) return Object.assign(lookup(Q, dev, dst, table), { table });
    const routes = Q.routesInTable(dev, table);
    const cands = longestRoutes(routes, IP.toInt(dst));
    const base = { vrf: K.MAIN_VRF, via: [K.MAIN_VRF], table };
    if (!cands.length) return Object.assign({ kind: 'no-match', routes }, base);
    const route = `${cands[0].prefix}/${cands[0].len}`;
    if (cands.every((r) => r.blackhole)) return Object.assign({ kind: 'blackhole', route, routes }, base);
    const nhs = []; cands.forEach((r) => r.nh.forEach((n) => nhs.push({ r, n })));
    return Object.assign({ kind: 'route', route, proto: cands[0].proto, nhs, routes }, base);
  }
  /** 策略路由規則的參照（輸出用，含來源行）。 */
  const ruleRef = (r) => ({ dev: r.dev, order: r.order, action: r.action, table: r.table, match: Object.assign({}, r.match), comment: r.comment || null, src: r.src.map((x) => x.slice()) });
  /**
   * routing rule 的條件是否符合封包：true／false，或 null（無法判斷，keys 列出條件）。
   * 可以判斷的條件：src-address、dst-address（單一網段）、interface（入介面已知時）、routing-mark（沒有 mangle 的 mark-routing 時封包沒有標記，一定不符）。
   */
  function ruleMatches(r, pkt) {
    const unknown = []; let ok = true;
    const inNet = (ip, v) => { const p = /^[\d.]+(\/\d{1,2})?$/.test(String(v)) ? S.ip.parseCidr(v) : null; return p ? IP.inNet(ip, p.net, p.len) : null; };
    Object.keys(r.match).forEach((k) => {
      const v = r.match[k];
      if (k === 'src-address' || k === 'dst-address') {
        const ip = k === 'src-address' ? pkt.src : pkt.dst; const hit = ip == null ? null : inNet(ip, v);
        if (hit === null) unknown.push(k); else if (!hit) ok = false;
      } else if (k === 'interface') {
        if (!pkt.inEp) unknown.push(k); else if (K.ifc(v) !== K.splitEp(pkt.inEp)[1]) ok = false;
      } else if (k === 'routing-mark') ok = false;
      else if (k === 'chain' && v === 'user') { /* 預設的 user chain */ }
      else unknown.push(k);
    });
    return unknown.length ? (ok ? { match: null, keys: unknown } : { match: false, keys: [] }) : { match: ok, keys: [] };
  }
  /**
   * 一台設備的轉送決定，含策略路由（RouterOS 7 的查表順序，https://manual.mikrotik.com/docs/user-guides/routing-and-networking-protocols/routing-decision.md）：
   * 預設依序是 mangle（mark-routing）→ 入介面屬於 VRF 時查那個 VRF（查不到就拒絕）→ 送給設備自己 → /routing rule（user chain，依序）→ main。
   * 「送給設備自己」由呼叫端先判斷。這裡的做法：
   *   - 設備沒有任何 /routing rule、mark-routing，也沒改 policy-rules：就是 lookup（沒有策略路由的網路結果不變）。
   *   - 有 mangle 的 mark-routing（mangle 不在模型中），或改過 /routing settings 的 policy-rules：無法判斷查哪一張表 → { kind: 'policy-unknown' }。
   *   - 封包在 VRF：查那個 VRF（使用者的 rule 在 VRF 之後）。
   *   - 在 main：依序比對 rule；條件無法判斷 → policy-unknown；符合時 drop／unreachable → { kind: 'policy-drop', rule }，
   *     lookup → 在 table 查，查不到就看下一條；lookup-only-in-table → 只在 table 查；其他 action → policy-unknown。都沒有決定時查 main。
   * pkt：{ src（null＝不明）, dst, vrf, inEp（介面鍵；null＝設備自己送出；undefined＝不明） }。回傳同 lookup，另有 table、rule（決定查表的規則）。
   */
  function routeDecision(Q, dev, pkt) {
    const pol = Q.policyOf(dev);
    if (!pol.any) return lookup(Q, dev, pkt.dst, pkt.vrf);
    const v = K.vrf(pkt.vrf);
    if (pol.custom) return { kind: 'policy-unknown', why: 'policy-rules', vrf: v, via: [v], rules: [], note: `/routing settings 的 policy-rules 改過（${pol.policyRules.join(',')}），查表順序不在可判斷的範圍` };
    if (pol.marks.length) return { kind: 'policy-unknown', why: 'mark-routing', vrf: v, via: [v], rules: [], marks: pol.marks.map((x) => ({ chain: x.chain, mark: x.mark, src: x.src.map((s) => s.slice()) })), note: `有 ${pol.marks.length} 條 mangle mark-routing（mangle 不在模型中），封包可能改查其他路由表` };
    if (v !== K.MAIN_VRF) return lookup(Q, dev, pkt.dst, v);
    for (const r of pol.rules) {
      const m = ruleMatches(r, pkt);
      if (m.match === null) return { kind: 'policy-unknown', why: 'condition', vrf: v, via: [v], rules: [ruleRef(r)], keys: m.keys, note: `/routing rule 第 ${r.order} 條的條件 ${m.keys.join('、')} 無法判斷` };
      if (!m.match) continue;
      if (r.action === 'drop' || r.action === 'unreachable') return { kind: 'policy-drop', vrf: v, via: [v], rule: ruleRef(r), note: `/routing rule 第 ${r.order} 條 ${r.action}` };
      if ((r.action === 'lookup' || r.action === 'lookup-only-in-table') && r.table) {
        const lk = lookupTable(Q, dev, pkt.dst, K.vrf(r.table));
        if (lk.kind !== 'no-match' && lk.kind !== 'no-route-data') return Object.assign(lk, { rule: ruleRef(r) });
        if (r.action === 'lookup-only-in-table') return Object.assign(lk, { kind: 'no-match', rule: ruleRef(r) });
        continue;
      }
      return { kind: 'policy-unknown', why: 'action', vrf: v, via: [v], rules: [ruleRef(r)], note: `/routing rule 第 ${r.order} 條的 action ${r.action} 不在可判斷的範圍` };
    }
    return Object.assign(lookup(Q, dev, pkt.dst, v), { table: v });
  }

  /**
   * 下一跳 IP（在 dev 的 vrf 解析）屬於哪台設備：
   *   { status: 'direct', ep, dev, vrf, crossVrf }（某台設備的位址；vrf 是對方所在的 VRF，規則見 Q.hopOwner）
   *   { status: 'recursive', hits: [{ dev, vrf, chain }] }（不是已知位址，沿這個 VRF 的路由表遞迴解析到已知設備，例如 gateway 是對端 loopback）
   *   { status: 'unknown' }（不在基準內）。
   */
  function nextOwner(Q, dev, ip, vrf) {
    const v = K.vrf(vrf);
    const own = Q.hopOwner(dev, ip, v);
    if (own) return { status: 'direct', ep: own.key, dev: own.dev, vrf: own.vrf, crossVrf: own.crossVrf };
    const devOf = (x) => { const o = Q.hopOwner(dev, x, v); return o ? o.dev : null; };
    const hit = S.check.resolveNextHop(routesIn(Q, dev, v), ip, devOf).filter((x) => x.status === 'known');
    return hit.length ? { status: 'recursive', hits: hit.map((x) => ({ dev: x.owner, vrf: Q.hopOwner(dev, x.ip, v).vrf, chain: x.chain })) } : { status: 'unknown' };
  }
  /** 來源位址可能在哪些 VRF：擁有它，或它落在某個直連網段（Q.vrfs() 的順序）。 */
  function vrfsOfIp(Q, ip) {
    const set = new Set(Q.subnets().filter((s) => IP.inNet(ip, s.net, s.len)).map((s) => s.vrf));
    Q.vrfs().forEach((v) => { if (Q.ipOwner(ip, v)) set.add(v); });
    return Q.vrfs().filter((v) => set.has(v));
  }
  /**
   * 查詢的 VRF：給了就必須是基準中的 VRF（否則 TypeError）；沒給時依來源位址：只在一個 VRF 時用它，不在任何 VRF 時是 main，
   * 在多個 VRF（位址重疊）時回傳 { error, vrfs }，由呼叫端請使用者指定，不猜。
   */
  function pickVrf(Q, src, vrf) {
    if (vrf != null) {
      const v = K.vrf(vrf);
      if (!Q.vrfs().includes(v)) throw new TypeError(`基準中沒有 VRF ${JSON.stringify(String(vrf))}（有：${Q.vrfs().join('、')}）`);
      return { vrf: v };
    }
    const c = vrfsOfIp(Q, src);
    if (c.length > 1) return { error: `${src} 在多個 VRF（${c.join('、')}），請指定 vrf`, vrfs: c };
    return { vrf: c[0] || K.MAIN_VRF };
  }

  /**
   * 路由追蹤。opt：{ ttl, vrf（選用；省略時依來源位址決定，見 pickVrf） }。
   * 走到未收集的設備（起點、中途或終點）時以 ends[].status 'unverified' 停下：沒有它的路由表，不能判斷是否抵達，不算斷掉。
   * status：'reached'（至少一個分支抵達）｜'unverified'（沒有抵達，且每個分支都停在未收集的設備）｜'unreachable'（其他）；
   * unverified 是停在未收集設備的設備鍵（去重、依出現順序）。
   * 回傳 { ok, src, dst, vrf, start, reached, status, unverified, hops: [{ dev, vrf, via, route, proto, ecmp, next: [{ ip, ifc, dev, vrf, crossVrf, status, note }] }], ends: [{ dev, vrf, status, note, path }], edges }；
   * 位址無效或來源在多個 VRF 時 { ok: false, error（, vrfs） }。vrf 不是基準中的 VRF 時 TypeError。
   * 每一跳在它的 VRF 查路由；下一跳寫了 @<VRF>（路由洩漏）時在那個 VRF 解析閘道，下一台從擁有閘道位址的 VRF 繼續。
   */
  S.trace = function (Q, src, dst, opt) {
    const o = opt || {};
    const ttlMax = o.ttl || 32;
    if (!IP.isIp(src) || !IP.isIp(dst)) return { ok: false, error: '請輸入有效的 IPv4 位址' };
    const pv = pickVrf(Q, src, o.vrf);
    if (pv.error) return { ok: false, error: pv.error, vrfs: pv.vrfs };
    const vrf0 = pv.vrf;
    const startNets = Q.subnets().filter((s) => s.vrf === vrf0 && IP.inNet(src, s.net, s.len)).sort((a, b) => b.len - a.len);
    const ownerSrc = Q.ipOwner(src, vrf0);
    const startDev = ownerSrc ? ownerSrc.split('|')[0] : startNets.length ? startNets[0].dev : null;
    // 文字中的 VRF 在 main 時省略（與 K.inVrf、zone 名稱相同）：只用 main 的網路，文字和加入 VRF 之前相同
    const notMain = (v) => v !== K.MAIN_VRF;
    if (!startDev) return { ok: false, error: `找不到包含 ${src} 的網段${notMain(vrf0) ? `（VRF ${vrf0}）` : ''}，無法判斷起點設備` };

    const hops = []; const ends = []; const edges = new Set();
    const at = (d, v) => d + '\u0000' + v;
    const queue = [{ dev: startDev, vrf: vrf0, inEp: ownerSrc ? null : startNets[0].ep, ttl: ttlMax, path: [startDev], seen: [at(startDev, vrf0)] }];
    const expanded = new Set();
    while (queue.length) {
      const { dev, vrf, inEp, ttl, path, seen } = queue.shift();
      if (expanded.has(at(dev, vrf))) continue; // 同一設備的同一個 VRF 只展開一次（ECMP 匯合時避免重複）
      expanded.add(at(dev, vrf));
      if (ttl <= 0) { ends.push({ dev, vrf, status: 'ttl', note: 'TTL 用盡' }); continue; }
      const lk = routeDecision(Q, dev, { src, dst, vrf, inEp });
      if (lk.kind === 'policy-unknown') { ends.push({ dev, vrf, status: 'policy', note: `策略路由：${lk.note}，查哪一張路由表無法判斷`, rules: lk.rules, path }); continue; }
      if (lk.kind === 'policy-drop') { ends.push({ dev, vrf, status: 'policy-drop', note: `策略路由：${lk.note}，封包被丟棄`, rule: lk.rule, path }); continue; }
      const tableNote = lk.rule ? `（依 /routing rule 第 ${lk.rule.order} 條查路由表 ${lk.table}）` : '';
      const lv = lk.vrf; const leakNote = lk.via.length > 1 ? `（經 VRF 介面從 ${lk.via.join(' → ')}）` : '';
      if (lk.kind === 'connected') { ends.push({ dev, vrf: lv, status: 'reached', note: `目的位於直連網段 ${lk.conn.net}/${lk.conn.len}（${Q.epName(lk.conn.ep)}${notMain(lv) ? `，VRF ${lv}` : ''}）${leakNote}`, path }); continue; }
      // 未收集的設備沒有路由表：不能判斷是否抵達，以「無法驗證」停下，不算斷掉
      if (!(Q.getDevice(dev) || {}).collected) { ends.push({ dev, vrf, status: 'unverified', note: `${Q.devName(dev)} 未收集，無法再查它的路由表`, path }); continue; }
      if (lk.kind === 'no-route-data') { ends.push({ dev, vrf, status: 'noroute', note: '這台設備沒有路由表資料', path }); continue; }
      if (lk.kind === 'no-match') { ends.push({ dev, vrf: lv, status: 'noroute', note: `${lk.table && lk.table !== lv ? `路由表 ${lk.table} ` : notMain(lv) ? `VRF ${lv} ` : ''}沒有符合 ${dst} 的路由${tableNote}${leakNote}`, path }); continue; }
      if (lk.kind === 'blackhole') {
        hops.push({ dev, vrf: lv, via: lk.via, route: lk.route, proto: '黑洞路由', ecmp: false, next: [] });
        ends.push({ dev, vrf: lv, status: 'blackhole', note: `${lk.route} 是黑洞路由，封包在此被丟棄`, path }); continue;
      }
      const hop = { dev, vrf: lv, via: lk.via, table: lk.table, rule: lk.rule || null, note: tableNote || null, route: lk.route, proto: lk.proto, ecmp: lk.nhs.length > 1, next: [] };
      hops.push(hop);
      const go = (nd, nv, ne, x) => {
        if (seen.includes(at(nd, nv))) { hop.next.push(Object.assign(x, { dev: nd, vrf: nv, status: 'loop', note: '路由迴圈' })); ends.push({ dev: nd, vrf: nv, status: 'loop', note: `回到 ${Q.devName(nd)}${notMain(nv) ? `（VRF ${nv}）` : ''}，路由迴圈`, path: path.concat(nd) }); return; }
        hop.next.push(Object.assign({ dev: nd, vrf: nv, status: 'ok' }, x));
        edges.add(dev + '>' + nd);
        queue.push({ dev: nd, vrf: nv, inEp: ne, ttl: ttl - 1, path: path.concat(nd), seen: seen.concat(at(nd, nv)) });
      };
      lk.nhs.forEach(({ r, n }) => {
        if (!n.ip) { hop.next.push({ ip: null, ifc: n.ifc, vrf: n.vrf, status: 'connected', note: `經 ${n.ifc} 直接送出（${r.proto}${n.vrf !== lv ? `，VRF ${n.vrf}` : ''}）` }); ends.push({ dev, vrf: n.vrf, status: 'reached', note: `目的在 ${n.ifc} 直連`, path }); return; }
        const leak = n.vrf !== lv ? `（在 VRF ${n.vrf} 解析閘道）` : '';
        const no = nextOwner(Q, dev, n.ip, n.vrf);
        if (no.status === 'recursive') {
          no.hits.forEach((x) => go(x.dev, x.vrf, undefined, { ip: n.ip, ifc: n.ifc, crossVrf: false, note: `遞迴解析：${x.chain.join(' → ')}${leak}` }));
          return;
        }
        if (no.status === 'unknown') { hop.next.push({ ip: n.ip, ifc: n.ifc, vrf: n.vrf, status: 'unknown', note: `下一跳不屬於任何已知設備${leak}` }); ends.push({ dev, vrf: n.vrf, status: 'unknown-nh', note: `下一跳 ${K.inVrf(n.ip, n.vrf)} 不在基準內`, path }); return; }
        const cross = no.crossVrf ? `（推論：${Q.devName(no.dev)} 的這個位址在 VRF ${no.vrf}，網段相同）` : '';
        go(no.dev, no.vrf, no.ep && !no.ep.endsWith('|') ? no.ep : undefined, Object.assign({ ip: n.ip, ifc: n.ifc, crossVrf: no.crossVrf }, leak || cross ? { note: leak + cross } : {}));
      });
    }
    const reached = ends.some((e) => e.status === 'reached');
    const unverified = U.uniq(ends.filter((e) => e.status === 'unverified').map((e) => e.dev));
    const status = reached ? 'reached' : ends.length && ends.every((e) => e.status === 'unverified') ? 'unverified' : 'unreachable';
    return { ok: true, src, dst, vrf: vrf0, start: startDev, reached, status, unverified, hops, ends, edges: Array.from(edges).map((e) => e.split('>')) };
  };
  S.trace.lookup = lookup;
  S.trace.nextOwner = nextOwner;
  S.trace.pickVrf = pickVrf;
  S.trace.routeDecision = routeDecision;
  /** 直連網段的陣列（Q.subnets()、Q.subnetsOf() 的回傳值）中包含位址 n（IP.toInt 的結果）的元素，順序不變；L4 用，與 lookup 共用同一份快取。 */
  S.trace.subnetsContaining = (list, n) => containing(list, netOfSubnet, n);
})(globalThis.SSOT = globalThis.SSOT || {});
