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
  /** 某設備某個 VRF 的路由表（routes[].vrf 等於它）；VRF 不在基準中（例如 @ 寫了不存在的名稱）時為空。 */
  const routesIn = (Q, dev, vrf) => (Q.vrfs().includes(vrf) ? Q.routesOf(dev, vrf) : []);
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
    const conn = Q.subnetsOf(dev, v).filter((s) => IP.inNet(dst, s.net, s.len)).sort((a, b) => b.len - a.len)[0];
    if (conn) return done({ kind: 'connected', conn });
    if (!Q.routesOf(dev).length) return done({ kind: 'no-route-data', routes: [] });
    const routes = routesIn(Q, dev, v);
    let best = -1; let cands = [];
    routes.forEach((r) => {
      if (!IP.inNet(dst, r.prefix, r.len)) return;
      if (r.len > best) { best = r.len; cands = [r]; } else if (r.len === best) cands.push(r);
    });
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
    let best = -1; let cands = [];
    routes.forEach((r) => { if (!IP.inNet(dst, r.prefix, r.len)) return; if (r.len > best) { best = r.len; cands = [r]; } else if (r.len === best) cands.push(r); });
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
    // RouterOS 自己的管理服務（/ip service 的預設埠，https://manual.mikrotik.com/docs/cli-reference/ip/service.md），配合「網路設備（管理）」的目的
    { proto: 'tcp', port: 21 }, { proto: 'tcp', port: 23 }, { proto: 'tcp', port: 8728 }, { proto: 'tcp', port: 8729 },
  ]);
  /** 矩陣的虛擬 zone（推論）：外部（基準以外、經 WAN 介面）與網路設備本身（只當目的，走 input）。 */
  const EXTERNAL_ZONE = 'external';
  const SELF_ZONE = 'self';
  /** 外部的代表位址：文件保留位址（RFC 5737 的 TEST-NET-1／2／3），取第一個不在基準網段內的；只代表與它同一個規則位址區段的公網位址。 */
  const EXTERNAL_CANDIDATES = Object.freeze(['192.0.2.10', '198.51.100.10', '203.0.113.10']);
  const svcId = (s) => s.proto + (s.port != null ? '/' + s.port : '');
  /** zone 的來源，依優先順序（同一個網段取第一個有結果的來源）。 */
  const ZONE_SOURCES = Object.freeze(['profile', 'interface-list', 'vlan', 'subnet']);
  /**
   * 可達性的前提（每次 Q.reach 都附上，畫面照列）。
   * 句子以中文敘述；RouterOS 的原值（參數、表、選單）放在括號內，可對回手冊與設定（tests/core/reach.js 檢查）。
   */
  const ASSUMPTIONS = deepFreeze([
    { code: 'new-connection', message: '判斷的是新建立的連線（connection-state=new）；回程由連線追蹤放行，不另外判斷' },
    { code: 'routeros-tables', message: '只套用 RouterOS 防火牆的原始表、位址轉換與過濾（raw、nat、filter）；封包標記與策略路由（mangle）、橋接過濾（bridge filter）、主機與服務本身的防火牆不在範圍內' },
    { code: 'ipv4-vrf', message: '只算 IPv4（RouterOS 7）；封包依入介面所屬的 VRF 查那個 VRF 的路由表，閘道指定了其他 VRF（@<VRF>）時在那個 VRF 解析（路由洩漏）' },
    { code: 'policy-routing', message: '策略路由：main 路由表的封包依路由規則（/routing rule）的順序決定查哪一張路由表，可判斷的條件是來源位址、目的位址與入介面（src-address、dst-address、interface）；有封包標記規則設定路由標記（mangle 的 mark-routing）、改過路由設定的策略規則（/routing settings 的 policy-rules），或條件無法判斷時，結果為不明，不假設查 main' },
    { code: 'src-port', message: '來源埠由用戶端自選，比對來源埠（src-port）的條件無法判斷' },
    { code: 'untracked', message: '原始表規則不追蹤連線（raw 的 notrack）時，這台設備之後的規則以連線狀態「不追蹤」（connection-state=untracked）比對，也不套用位址轉換（nat）；是否不追蹤無法判斷時，兩種情況都算，結果不同就是不明' },
    { code: 'ip-service', message: '目的是網路設備本身時，除了輸入規則（input），也看設備的管理服務（/ip service）：服務停用或來源不在允許的位址內（available-from）就是拒絕；服務所在的 VRF（vrf 參數）不在模型中，封包不在 main 時結果不明' },
    { code: 'external', message: '外部是基準以外的位址（推論）：代表位址取文件保留位址（TEST-NET），從對外介面（WAN 清單的成員）進入；送往外部的封包從對外介面送出、下一跳不在基準內時就算允許，之後由電信業者決定' },
    { code: 'static-only', message: '只看匯出設定（/export）裡的靜態規則；即插即用（UPnP、NAT-PMP）、熱點（hotspot）等功能產生的動態規則與動態位址清單不在範圍內' },
    { code: 'bridge-ip-firewall', message: '同一個網段的流量視為不經過路由器的防火牆；橋接設定讓橋接流量也走防火牆（/interface bridge settings 的 use-ip-firewall）時，橋接流量也會經過過濾規則，這種情況不在範圍內' },
  ]);
  /**
   * Q.reach 的原因代碼與結束代碼（靜態清單，S.query.reachReasonCodes() 回傳）：
   *   kind 'end'：路徑結束的代碼（paths[].end.code；結果不是允許時也會出現在 reasons，拒絕時出現在決定結果的 route）
   *   kind 'reason'：只出現在 reasons／notes／hops[].reasons 的代碼
   * 新增代碼時一定要加在這裡（reason／end 遇到不在清單的代碼會丟出錯誤，tests/core/reach.js 也會掃描本檔確認）。
   */
  const REASON_CODES = deepFreeze([
    { code: 'rule-condition', kind: 'reason', note: '規則的比對條件無法判斷（keys 列出條件）' },
    { code: 'raw-notrack', kind: 'reason', note: 'raw 規則是否 notrack 無法判斷，追蹤與不追蹤連線（untracked）的結果不同' },
    { code: 'no-firewall-data', kind: 'reason', note: '設備沒有 /export，防火牆規則不明' },
    { code: 'srcnat-ambiguous', kind: 'reason', note: 'srcnat 可能由不同的規則改寫' },
    { code: 'srcnat-address-unknown', kind: 'reason', note: 'srcnat 改寫後的來源位址不明' },
    { code: 'branches-differ', kind: 'reason', note: '多條路徑（ECMP、多個閘道）結果不同' },
    { code: 'branch-limit', kind: 'reason', note: '路徑超過上限，只列出前面幾條' },
    { code: 'nat-ambiguous', kind: 'end', note: 'dstnat 可能由不同的規則改寫；同時也是原因' },
    { code: 'nat-target', kind: 'end', note: 'dst-nat／redirect／netmap 改寫後的位址或埠不明；同時也是原因' },
    { code: 'loop', kind: 'end', note: '路由迴圈（拒絕）' },
    { code: 'ttl', kind: 'end', note: 'TTL 用盡（不明）' },
    { code: 'device-uncollected', kind: 'end', note: '路徑上的設備沒有收集（不明）' },
    { code: 'dropped', kind: 'end', note: '被規則丟棄（拒絕）' },
    { code: 'local', kind: 'end', note: '目的是設備自己的位址（送達）' },
    { code: 'no-route-data', kind: 'end', note: '設備沒有路由表資料（不明）' },
    { code: 'no-route', kind: 'end', note: '沒有符合的路由（拒絕）' },
    { code: 'blackhole', kind: 'end', note: '黑洞路由（拒絕）' },
    { code: 'next-hop-outside', kind: 'end', note: '下一跳不在基準內（不明）' },
    { code: 'dst-device-uncollected', kind: 'end', note: '目的位址屬於沒有收集的設備（不明）' },
    { code: 'host', kind: 'end', note: '送達主機（主機防火牆不在範圍內）' },
    { code: 'segment', kind: 'end', note: '送達直連網段上的主機' },
    { code: 'src-device-uncollected', kind: 'end', note: '來源位址屬於沒有收集的設備（不明）' },
    { code: 'src-location-unknown', kind: 'end', note: '找不到包含來源的網段（不明）' },
    { code: 'same-subnet', kind: 'end', note: '來源與目的在同一個網段（送達）' },
    { code: 'no-gateway', kind: 'end', note: '來源網段沒有可當閘道的已收集設備（不明）' },
    { code: 'policy-routing', kind: 'end', note: '策略路由（mangle mark-routing、改過的 policy-rules，或無法判斷的 /routing rule 條件）使查哪一張路由表不明（不明）' },
    { code: 'policy-drop', kind: 'end', note: '/routing rule 的 drop 或 unreachable（拒絕）' },
    { code: 'service-refused', kind: 'end', note: '防火牆放行，但 /ip service 停用或 available-from 不含來源（拒絕）' },
    { code: 'service-unknown', kind: 'end', note: '/ip service 是否接受這個來源無法判斷（來源經 NAT 後不明，或封包不在 main VRF）（不明）' },
    { code: 'egress-wan', kind: 'end', note: '從 WAN 介面送往基準以外的位址，之後由電信業者決定（允許）' },
    { code: 'hairpin-no-srcnat', kind: 'end', note: 'dst-nat 後的目的與來源在同一個網段，但沒有 srcnat 改寫來源（hairpin NAT），回應不經過路由器（不明）' },
  ]);
  const REASON_CODE_SET = new Set(REASON_CODES.map((x) => x.code));
  const checkCode = (code) => { if (!REASON_CODE_SET.has(code)) throw new Error(`原因代碼 ${code} 不在 REASON_CODES（src/query/trace.js）`); return code; };
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
    // 位址的擁有者都在封包所在的 VRF 查（ADR-015）
    const ownerOf = (ip, vrf) => Q.ipOwner(ip, vrf);
    const odMemo = new Map();
    const ownerDev = (ip, vrf) => { const k = K.inVrf(ip, vrf); let d = odMemo.get(k); if (d === undefined) { const o = ownerOf(ip, vrf); d = o ? devOfEp(o) : null; odMemo.set(k, d); } return d; };
    const realEp = (ep) => (ep && !ep.endsWith('|') ? ep : undefined); // 管理 IP（「設備|」）沒有介面
    /** 介面是不是這台設備 WAN 清單的成員（事實：/interface list member；清單名稱含 WAN 是推論，見 S.infer.fw）。 */
    const isWanEp = (dev, ep) => { if (!ep || !devInfo(dev).config) return false; const c = I.ctxOf(dev); return !!(c && c.wan && c.wan.has(ep)); };
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
    // position 是 chain 內從 1 起算的序號（不是 /ip firewall … print 的編號：print 依整張表從 0 起算，插入規則會改變）
    const where = (r) => `${name(r.dev)} ${r.table} ${r.chain} chain 內第 ${r.position} 條（${r.action}）`;

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
      // /routing rule 的位址條件也切開等價類：同一個區段的位址，查哪一張表的結果相同
      (m.routingRules || []).forEach((r) => {
        addRanges(rb, 'src-address', r.match['src-address']); addRanges(rb, 'dst-address', r.match['dst-address']);
      });
      const pb = new Set(rb);
      prefixes4().forEach((p) => { pb.add(p.lo); pb.add(p.hi + 1); });
      ruleB = sortedArr(rb); repB = sortedArr(pb);
    };
    const findAtom = (arr, x) => { let lo = 0; let hi = arr.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid] <= x) lo = mid; else hi = mid - 1; } return lo; };
    const atomMemo = new Map();
    const ruleAtom = (ip) => U.getOr(atomMemo, ip, () => { bounds(); return findAtom(ruleB, IP.toInt(ip)); });

    // ---- 網段（IPv4 的直連網段，每個 VRF 分開；key 是網段鍵 K.inVrf）與最長前綴
    let p4 = null;
    function prefixes4() {
      if (p4) return p4;
      p4 = (m.prefixes || []).filter((p) => (p.family || 4) === 4).map((p) => {
        const lo = IP.toInt(p.net); const hi = lo + (p.len >= 32 ? 0 : 2 ** (32 - p.len) - 1); const vrf = K.vrf(p.vrf);
        return { p, prefix: p.prefix, key: K.inVrf(p.prefix, vrf), vrf, net: p.net, len: p.len, lo, hi };
      });
      return p4;
    }
    let lens = null; let byPrefix = null;
    const longest = (ip, vrf) => {
      if (!lens) { byPrefix = new Map(prefixes4().map((x) => [x.key, x])); lens = U.uniq(prefixes4().map((x) => x.len)).sort((a, b) => b - a); }
      const n = IP.toInt(ip);
      for (const len of lens) { const x = byPrefix.get(K.inVrf(IP.fromInt((n & IP.maskOf(len)) >>> 0) + '/' + len, vrf)); if (x) return x; }
      return null;
    };

    // ---- 每一關（表＋chain）的判斷：S.infer.fw.decide，依等價類快取
    const stageMemo = new Map();
    const hasRules = (ctx, table, chain) => ctx.chain('ip', table, chain).length > 0;
    // 節點的鍵：來源是網路設備的位址時用實際位址（之後的設備判斷 src-address-type=local 要用），否則用等價類
    const srcKey = (ip, vrf) => { if (ip == null) return 'n'; const d = ownerDev(ip, vrf); return d && netDev(d) ? 'o' + ip : 'a' + ruleAtom(ip); };
    // ct：這台設備的連線追蹤狀態，'new'（預設）或 'untracked'（raw 的 notrack 之後，手冊 Connection tracking）
    function stage(dev, table, chain, st, inEp, outEp, natState, skip, ct) {
      const srcLocal = st.src != null && ownerDev(st.src, st.vrf) === dev; const dstLocal = ownerDev(st.dst, st.vrf) === dev;
      const untracked = ct === 'untracked';
      // 位址只透過等價類與「是不是這台設備的」影響判斷，所以鍵用這兩者，不用實際位址
      const lv = level(level(level(level(level(stageMemo, skip ? skip.id : ''), dev), table + chain), inEp === undefined ? '' : inEp), outEp === undefined ? '' : outEp === null ? '-' : outEp);
      const leaf = level(lv, svcNum(st) * 32 + (untracked ? 16 : 0) + (natState ? 8 : 0) + (srcLocal ? 4 : 0) + (dstLocal ? 2 : 0));
      const key = (st.src == null ? 0 : ruleAtom(st.src) + 1) * 1e7 + ruleAtom(st.dst);
      return U.getOr(leaf, key, () => {
        const ctx = I.ctxOf(dev);
        const pkt = {
          family: 'ip', reach: true, in: inEp, out: outEp, protocol: st.proto, dstPort: st.port, srcPort: null,
          src: st.src == null ? null : BigInt(IP.toInt(st.src)), dst: BigInt(IP.toInt(st.dst)), srcLocal, dstLocal,
          state: untracked ? 'untracked' : 'new', natState, ipsec: devInfo(dev).ipsec ? null : 'none',
        };
        const d = F.decide(ctx, 'ip', table, chain, pkt, skip ? skip.set : null);
        const pub = {
          table, chain, status: d.decided ? 'decided' : 'unknown', verdict: d.decided ? d.verdict : null, rule: d.decided ? ref(d.rule) : null, policy: d.decided && d.policy,
          via: d.decided ? d.path.map(ref) : [], hits: d.hits.map(ref),
          uncertain: d.uncertain.map((u) => ({ rule: ref(u.rule), keys: U.uniq(u.keys), verdicts: u.verdicts })),
          outcomes: d.outcomes.map((o) => ({ verdict: o.verdict, rule: ref(o.rule), policy: o.policy })),
        };
        pub.note = `${table} ${chain}：${!d.decided ? `可能 ${U.uniq(d.outcomes.map((o) => o.verdict)).join('／')}，無法判斷`
          : d.rule ? `chain 內第 ${d.rule.position} 條 ${d.rule.action}${d.rule.comment ? `（${d.rule.comment}）` : ''}` : table === 'nat' ? '沒有 NAT 規則命中' : '沒有規則決定，預設放行'}`;
        return { pub, d };
      });
    }
    const condReasons = (dev, sg) => sg.pub.uncertain.filter(() => sg.pub.status === 'unknown').map((u) => ({
      code: 'rule-condition', dev, rule: u.rule, keys: u.keys,
      message: `${where(u.rule)} 的條件 ${u.keys.join('、')} 無法判斷：${U.uniq(u.keys.map(keyWhy)).join('；')}`,
    }));
    const reason = (code, dev, message, extra) => Object.assign({ code: checkCode(code), dev: dev || null, message }, extra);

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
    const outEpFor = (dev, ip, vrf) => { const s = Q.subnetsOf(dev, vrf).filter((x) => IP.inNet(ip, x.net, x.len)).sort((a, b) => b.len - a.len)[0]; return s ? s.ep : undefined; };
    const lookMemo = new Map();
    const look = (dev, dst, vrf) => U.getOr(level(level(lookMemo, dev), vrf), dst, () => lookup(Q, dev, dst, vrf));
    // 轉送決定（含策略路由，routeDecision）：沒有策略路由的設備只依目的與 VRF 快取；有的時候也依入介面與來源
    const decMemo = new Map();
    const decide = (dev, st, inEp) => {
      if (!Q.policyOf(dev).any) return look(dev, st.dst, st.vrf);
      const leaf = level(level(level(level(decMemo, dev), st.vrf), inEp === undefined ? '~' : inEp === null ? '-' : inEp), st.src == null ? 'n' : st.src);
      return U.getOr(leaf, st.dst, () => routeDecision(Q, dev, { src: st.src, dst: st.dst, vrf: st.vrf, inEp }));
    };
    const end = (status, verdict, code, dev, message, extra) => Object.assign({ status, verdict, code: checkCode(code), dev: dev || null, message }, extra);
    // hop.vrf：封包在這台設備所在的 VRF（入介面的 VRF；設備自己送出時是來源位址的 VRF）
    const newHop = (dev, inEp, st, chain) => ({
      dev, name: name(dev), vrf: st.vrf, collected: devInfo(dev).collected, firewall: devInfo(dev).config ? 'export' : 'none', chain, in: inEp === undefined ? null : inEp, inKnown: inEp !== undefined,
      out: null, outKnown: true, src: st.src, dst: st.dst, proto: st.proto, port: st.port, srcOut: st.src, dstOut: st.dst, portOut: st.port,
      route: null, stages: [], nat: [], service: null, reasons: [], verdict: 'pass', conntrack: 'new',
    });
    const cloneHop = (b) => ({
      dev: b.dev, name: b.name, vrf: b.vrf, collected: b.collected, firewall: b.firewall, chain: b.chain, in: b.in, inKnown: b.inKnown, out: b.out, outKnown: b.outKnown,
      src: b.src, dst: b.dst, proto: b.proto, port: b.port, srcOut: b.srcOut, dstOut: b.dstOut, portOut: b.portOut,
      route: b.route, stages: b.stages.slice(), nat: b.nat.slice(), service: b.service, reasons: b.reasons.slice(), verdict: b.verdict, conntrack: b.conntrack,
    });

    /** 封包從 inEp（undefined＝不明）進入 dev。mode：'exact'（Q.reach，鍵用實際位址）或 'atom'（矩陣，鍵用等價類）。 */
    // 快取分層（設備 → 入介面 → 來源 → 目的與 service 的數字鍵），避免每次組長字串；計算中的鍵存 BUSY，再遇到就是同一個封包繞回來（迴圈）
    const BUSY = Symbol('busy');
    const protoIdx = new Map();
    const svcNum = (st) => U.getOr(protoIdx, st.proto, () => protoIdx.size) * 65536 + (st.port || 0);
    const level = (map, k) => { let x = map.get(k); if (!x) { x = new Map(); map.set(k, x); } return x; };
    function arrive(dev, inEp, st0, depth, ctx) {
      // 封包進入的介面決定它在哪個 VRF（RouterOS：依入介面所屬的 VRF 查路由表）；入介面不明時沿用上一跳交給它的 VRF
      const ie = realEp(inEp) && Q.getInterface(inEp);
      const st = ie && K.vrf(ie.vrf) !== st0.vrf ? Object.assign({}, st0, { vrf: K.vrf(ie.vrf) }) : st0;
      const leaf = level(level(level(level(ctx.memo, dev), st.vrf), inEp === undefined ? '' : inEp), ctx.mode === 'exact' ? (st.src == null ? 'n' : st.src) : srcKey(st.src, st.vrf));
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
      if (!info.config) {
        base.reasons.push(reason('no-firewall-data', dev, `${name(dev)} 沒有設定資料（/export），防火牆規則不明`));
        return afterRaw(dev, base, inEp, st, depth, ctx, 'new');
      }
      const ctxF = I.ctxOf(dev);
      if (!hasRules(ctxF, 'raw', 'prerouting')) return afterRaw(dev, base, inEp, st, depth, ctx, 'new');
      const sg = stage(dev, 'raw', 'prerouting', st, inEp, undefined, null, ctx.skip, 'new');
      base.stages.push(sg.pub);
      if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { base.verdict = 'deny'; return stop(base, end('dropped', 'deny', 'dropped', dev, sg.pub.note)); }
      // notrack：連線不追蹤，之後的規則以 connection-state=untracked 比對，也不做 NAT（NAT 依賴連線追蹤；手冊 Connection tracking、Packet Flow）
      if (sg.pub.status === 'decided') return afterRaw(dev, base, inEp, st, depth, ctx, sg.pub.verdict === 'notrack' ? 'untracked' : 'new');
      const vs = U.uniq(sg.d.outcomes.map((o) => o.verdict));
      const reasons = condReasons(dev, sg);
      if (!vs.includes('notrack') || vs.includes('drop')) { base.reasons.push(...reasons); return afterRaw(dev, base, inEp, st, depth, ctx, 'new'); }
      // 只差在是否 notrack：兩種狀態各算一次，結果相同就是確定的，不同就是不明（不讓其中一邊的「拒絕」蓋過另一邊）
      const tracked = afterRaw(dev, cloneHop(base), inEp, st, depth, ctx, 'new');
      const untracked = afterRaw(dev, cloneHop(base), inEp, st, depth, ctx, 'untracked');
      const vt = combine(tracked.map(summary)); const vu = combine(untracked.map(summary));
      if (vt === vu && vt !== 'unknown') return tracked;
      const why = reason('raw-notrack', dev, `${name(dev)} raw prerouting 是否不追蹤連線（notrack）無法判斷：追蹤時${V_TEXT[vt]}、不追蹤時${V_TEXT[vu]}`, { rule: (sg.pub.uncertain.find((u) => u.verdicts.includes('notrack')) || {}).rule || null });
      tracked.forEach((n) => { n.hop.reasons.push(...reasons, why); n.hop.verdict = 'unknown'; n.hop.pinned = true; sumMemo.delete(n); });
      return tracked;
    }
    const V_TEXT = { allow: '允許', deny: '拒絕', unknown: '無法判斷' };
    /** raw prerouting 之後：dstnat（不追蹤時略過）→ 送給自己（input）或轉送（forward）。ct 是這台設備的連線追蹤狀態。 */
    function afterRaw(dev, base, inEp, st, depth, ctx, ct) {
      const info = devInfo(dev);
      const stop = (hop, e) => [{ hop, next: null, end: e }];
      let cur = st; let natState = null;
      base.conntrack = ct;
      if (info.config && ct !== 'untracked' && hasRules(I.ctxOf(dev), 'nat', 'dstnat')) {
        const sg = stage(dev, 'nat', 'dstnat', cur, inEp, undefined, null, ctx.skip, ct);
        base.stages.push(sg.pub);
        if (sg.pub.status !== 'decided') {
          base.reasons.push(...condReasons(dev, sg));
          if (sg.d.outcomes.some((o) => o.verdict !== 'none')) {
            base.verdict = 'unknown';
            base.reasons.push(reason('nat-ambiguous', dev, `${name(dev)} dstnat 可能由不同的規則改寫（${sg.d.outcomes.map((o) => (o.rule ? `chain 內第 ${o.rule.position} 條 ${o.verdict}` : '不改寫')).join('、')}），改寫後的目的不明`));
            return stop(base, end('unknown', 'unknown', 'nat-ambiguous', dev, '目的 NAT 的結果不明，之後的路徑無法判斷'));
          }
        } else if (sg.pub.verdict !== 'none') {
          const res = applyDst(dev, inEp, sg.d.rule, cur);
          if (res.unknown) { base.verdict = 'unknown'; base.reasons.push(res.unknown); return stop(base, end('unknown', 'unknown', res.unknown.code, dev, res.unknown.message)); }
          base.nat.push(res.nat); cur = res.st; natState = 'dstnat';
          base.dstOut = cur.dst; base.portOut = cur.port;
        }
      }
      // 目的是這台設備自己（在封包所在的 VRF）：input，再看管理服務（/ip service）是否接受
      if (ownerDev(cur.dst, cur.vrf) === dev) {
        base.chain = 'input';
        if (info.config) {
          const sg = stage(dev, 'filter', 'input', cur, inEp, null, natState, ctx.skip, ct);
          base.stages.push(sg.pub); base.reasons.push(...condReasons(dev, sg));
          if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { base.verdict = 'deny'; return stop(base, end('dropped', 'deny', 'dropped', dev, sg.pub.note)); }
        }
        return localService(dev, base, cur);
      }
      return egress(dev, base, inEp, cur, natState, 'forward', depth, ctx, ct);
    }
    /**
     * 送到設備自己、防火牆沒有擋：依 /ip service 判斷（https://manual.mikrotik.com/docs/cli-reference/ip/service.md）。
     * 停用的服務不監聽；available-from 不含來源時，TCP 連線可以建立，但設備隨即關閉、不提供服務（埠仍看得到）；兩者都算拒絕（end service-refused）。
     * 來源不明（NAT 後）或封包不在 main（服務的 vrf 參數預設 main，模型沒有這個參數）時不明。沒有對應的服務時維持「防火牆允許」並註明。
     */
    function localService(dev, base, cur) {
      const stop = (hop, e) => [{ hop, next: null, end: e }];
      const sv = devInfo(dev).config ? serviceOf(dev, cur) : null;
      base.service = sv;
      if (sv && sv.accepts === false) {
        base.verdict = 'deny';
        return stop(base, end('refused', 'deny', 'service-refused', dev, !sv.enabled
          ? `${name(dev)} 的 ${sv.name} 服務（/ip service）已停用，沒有監聽 tcp/${sv.port}`
          : `${name(dev)} 的 ${sv.name} 服務只接受 ${sv.addresses.join('、')}（/ip service 的 available-from），來源 ${cur.src} 不在其中：連線建立後設備隨即關閉`, { service: sv.name, src: sv.src }));
      }
      if (sv && (sv.accepts === null || cur.vrf !== K.MAIN_VRF)) {
        base.verdict = 'unknown';
        return stop(base, end('unknown', 'unknown', 'service-unknown', dev, cur.vrf !== K.MAIN_VRF
          ? `${name(dev)} 的 ${sv.name} 服務所在的 VRF 不在模型中（預設 main），封包在 VRF ${cur.vrf}，是否接受無法判斷`
          : `${name(dev)} 的 ${sv.name} 服務只接受 ${sv.addresses.join('、')}，來源經 NAT 後不明，是否接受無法判斷`, { service: sv.name }));
      }
      if (base.reasons.length) base.verdict = 'unknown';
      const svText = !sv && cur.proto === 'tcp' && cur.port != null && devInfo(dev).config ? '（防火牆允許；沒有已知的管理服務（/ip service）使用這個埠）' : '';
      return stop(base, end('delivered', 'allow', 'local', dev, `目的 ${cur.dst} 是 ${name(dev)} 自己的位址${svText}`, { vrf: cur.vrf }));
    }
    /** 設備自己送出的封包（來源是設備的位址）：output。 */
    function originate(dev, st, ctx) {
      const base = newHop(dev, null, st, 'output');
      if (!devInfo(dev).config) base.reasons.push(reason('no-firewall-data', dev, `${name(dev)} 沒有設定資料（/export），防火牆規則不明`));
      if (ownerDev(st.dst, st.vrf) === dev) return [{ hop: base, next: null, end: end('delivered', 'allow', 'local', dev, `來源與目的都是 ${name(dev)} 自己的位址`, { vrf: st.vrf }) }];
      return egress(dev, base, null, st, null, 'output', 0, ctx);
    }
    /** 路由決定之後：依出介面分支，套用 filter（forward／output）與 srcnat，再交給下一台。 */
    function egress(dev, base, inEp, cur, natState, chain, depth, ctx, ct0) {
      const info = devInfo(dev);
      base.chain = chain;
      const stop = (hop, e) => [{ hop, next: null, end: e }];
      const lk = decide(dev, cur, inEp === undefined ? undefined : inEp);
      if (lk.kind === 'policy-unknown') {
        base.verdict = 'unknown';
        return stop(base, end('unknown', 'unknown', 'policy-routing', dev, `${name(dev)} 的策略路由：${lk.note}，查哪一張路由表無法判斷`, { rules: lk.rules || [] }));
      }
      if (lk.kind === 'policy-drop') {
        base.verdict = 'deny'; base.route = { prefix: null, proto: null, gateway: null, gatewayVrf: null, vrf: lk.vrf, via: lk.via, table: null, rule: lk.rule };
        return stop(base, end('policy-drop', 'deny', 'policy-drop', dev, `${name(dev)} 的策略路由：${lk.note}，封包被丟棄`, { rule: lk.rule }));
      }
      // route.vrf：查路由的 VRF（閘道是 VRF 介面時是另一個 VRF，via 列出經過的 VRF）；route.gatewayVrf：解析閘道的 VRF（寫了 @<VRF> 時就是路由洩漏）
      const rv = { vrf: lk.vrf, via: lk.via, table: lk.table || lk.vrf, rule: lk.rule || null };
      const vrfMsg = lk.vrf !== K.MAIN_VRF || lk.via.length > 1 ? `（VRF ${lk.via.join(' → ')}）` : '';
      if (lk.kind === 'no-route-data') { base.verdict = 'unknown'; return stop(base, end('unknown', 'unknown', 'no-route-data', dev, `${name(dev)} 沒有路由表資料`)); }
      if (lk.kind === 'no-match') { base.verdict = 'deny'; base.route = Object.assign({ prefix: null, proto: null, gateway: null, gatewayVrf: null }, rv); return stop(base, end('no-route', 'deny', 'no-route', dev, `${name(dev)}${vrfMsg} 沒有符合 ${cur.dst} 的路由，封包被丟棄`)); }
      if (lk.kind === 'blackhole') { base.verdict = 'deny'; base.route = Object.assign({ prefix: lk.route, proto: '黑洞路由', gateway: null, gatewayVrf: null }, rv); return stop(base, end('blackhole', 'deny', 'blackhole', dev, `${lk.route}${vrfMsg} 是黑洞路由，封包被丟棄`)); }
      const outs = lk.kind === 'connected'
        ? [{ out: lk.conn.ep, route: Object.assign({ prefix: `${lk.conn.net}/${lk.conn.len}`, proto: 'connected', gateway: null, gatewayVrf: null }, rv), nh: null, vrf: lk.vrf }]
        : lk.nhs.map(({ r, n }) => ({ out: n.ifc ? K.ep(dev, n.ifc) : n.ip ? outEpFor(dev, n.ip, n.vrf) : undefined, route: Object.assign({ prefix: lk.route, proto: r.proto, gateway: n.ip || null, gatewayVrf: n.vrf }, rv), nh: n, vrf: n.vrf }));
      return outs.map((o) => {
        const hop = cloneHop(base); hop.out = o.out === undefined ? null : o.out; hop.outKnown = o.out !== undefined; hop.route = o.route;
        let st = cur.vrf === o.vrf ? cur : Object.assign({}, cur, { vrf: o.vrf }); // 之後（送出、交給下一台）在閘道的 VRF
        let ct = ct0 || 'new';
        if (info.config) {
          const ctxF = I.ctxOf(dev);
          if (chain === 'output' && hasRules(ctxF, 'raw', 'output')) {
            const sg = stage(dev, 'raw', 'output', st, null, o.out, null, ctx.skip, ct);
            hop.stages.push(sg.pub); hop.reasons.push(...condReasons(dev, sg));
            if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { hop.verdict = 'deny'; return { hop, next: null, end: end('dropped', 'deny', 'dropped', dev, sg.pub.note) }; }
            if (sg.pub.status === 'decided' && sg.pub.verdict === 'notrack') ct = 'untracked';
            else if (sg.pub.status !== 'decided' && sg.d.outcomes.some((x) => x.verdict === 'notrack')) hop.reasons.push(reason('raw-notrack', dev, `${name(dev)} raw output 是否不追蹤連線（notrack）無法判斷，之後的連線狀態不明`));
          }
          hop.conntrack = ct;
          const sg = stage(dev, 'filter', chain, st, inEp === undefined ? undefined : inEp, o.out, natState, ctx.skip, ct);
          hop.stages.push(sg.pub); hop.reasons.push(...condReasons(dev, sg));
          if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { hop.verdict = 'deny'; return { hop, next: null, end: end('dropped', 'deny', 'dropped', dev, sg.pub.note) }; }
          if (ct !== 'untracked' && hasRules(ctxF, 'nat', 'srcnat')) {
            const sn = stage(dev, 'nat', 'srcnat', st, inEp, o.out, natState, ctx.skip, ct);
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
        const no = nextOwner(Q, dev, o.nh.ip, o.nh.vrf);
        // 外部：從 WAN 清單的介面送出、目的不在基準的任何網段（推論：送往網際網路，之後由電信業者決定）
        if (no.status === 'unknown' && isWanEp(dev, o.out) && !longest(st.dst, st.vrf)) return { hop, next: null, end: end('delivered', 'allow', 'egress-wan', dev, `從 ${Q.epName(o.out)}（WAN）送往下一跳 ${K.inVrf(o.nh.ip, o.nh.vrf)}，目的 ${st.dst} 在基準以外，之後由電信業者決定（推論）`, { ip: st.dst, vrf: st.vrf }) };
        if (no.status === 'unknown') return { hop, next: null, end: end('outside', 'unknown', 'next-hop-outside', dev, `${name(dev)} 的下一跳 ${K.inVrf(o.nh.ip, o.nh.vrf)} 不在基準內，之後的路徑無法判斷`, { ip: o.nh.ip, vrf: o.nh.vrf }) };
        const kids = no.status === 'direct' ? arrive(no.dev, realEp(no.ep), Object.assign({}, st, { vrf: no.vrf }), depth + 1, ctx)
          : no.hits.flatMap((x) => arrive(x.dev, undefined, Object.assign({}, st, { vrf: x.vrf }), depth + 1, ctx));
        return { hop, next: kids, end: null };
      });
    }
    /**
     * 目的在出介面的直連網段（封包所在的 VRF）：交給擁有目的位址的網路設備（再判斷它的 input），或送達主機。
     * 擁有者依 Q.hopOwner：同名 VRF 優先，否則是同一個網段上其他 VRF 的唯一擁有者（推論）。
     */
    function deliver(dev, hop, st, depth, ctx) {
      const own = Q.hopOwner(dev, st.dst, st.vrf); const d2 = own ? own.dev : null;
      // hairpin NAT（手冊 NAT 的 Hairpin NAT 一節，https://manual.mikrotik.com/docs/firewall-and-quality-of-service/firewall/nat.md）：
      // 這一跳 dst-nat 改寫了目的，改寫後的目的與來源在同一個直連網段，來源又沒有被 srcnat 改寫 → 伺服器直接回給來源、不經過路由器，連線建立不起來
      if (hop.nat.some((x) => x.dir === 'dst') && !hop.nat.some((x) => x.dir === 'src') && st.src != null && st.src === hop.src) {
        const net = Q.subnetsOf(dev, st.vrf).filter((x) => IP.inNet(st.dst, x.net, x.len)).sort((a, b) => b.len - a.len)[0];
        if (net && IP.inNet(st.src, net.net, net.len)) {
          hop.verdict = 'unknown';
          return { hop, next: null, end: end('unknown', 'unknown', 'hairpin-no-srcnat', dev, `dst-nat 後的目的 ${st.dst} 與來源 ${st.src} 同在 ${net.net}/${net.len}，但沒有 srcnat 改寫來源：回應會直接送回來源、不經過 ${name(dev)}，連線通常建立不起來（需要 hairpin NAT）`, { ip: st.dst, vrf: st.vrf }) };
        }
      }
      if (d2 && d2 !== dev && netDev(d2)) {
        if (!devInfo(d2).collected) return { hop, next: null, end: end('unknown', 'unknown', 'dst-device-uncollected', d2, `目的 ${st.dst} 屬於沒有收集的 ${name(d2)}，它自己的防火牆不明`, { ip: st.dst, vrf: own.vrf }) };
        return { hop, next: arrive(d2, realEp(own.key), Object.assign({}, st, { vrf: own.vrf }), depth + 1, ctx), end: null };
      }
      return { hop, next: null, end: end('delivered', 'allow', d2 ? 'host' : 'segment', dev, `送達 ${st.dst}（${d2 ? `${name(d2)}，主機本身的防火牆不在範圍內` : '直連網段上的主機'}${st.vrf !== K.MAIN_VRF ? `，VRF ${st.vrf}` : ''}）`, { ip: st.dst, vrf: st.vrf }) };
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
    /** 來源在 vrf 中的位置（memo 依 VRF 與位址）。prefix 是網段文字；非 main 的 VRF 另見 vrf。 */
    function srcLocation(src, vrf) {
      return U.getOr(locMemo, K.inVrf(src, vrf), () => {
        const own = ownerOf(src, vrf); const sd = own ? devOfEp(own) : null;
        if (sd && netDev(sd)) return { how: 'device', dev: sd, ep: realEp(own) || null, vrf };
        const nets = Q.subnets().filter((s) => s.vrf === vrf && IP.inNet(src, s.net, s.len));
        if (!nets.length) return { how: 'none', vrf };
        const len = Math.max(...nets.map((s) => s.len));
        const same = nets.filter((s) => s.len === len); const net = same[0].net; const prefix = `${net}/${len}`;
        const cands = U.uniq(same.map((s) => s.dev)).sort(U.natural);
        const epOn = (d) => same.find((s) => s.dev === d).ep;
        const dhcp = U.uniq((m.dhcpNetworks || []).filter((n) => { const p = S.ip.parseCidr(n.network); return K.vrf(n.vrf) === vrf && p && p.net === net && p.len === len; })
          .flatMap((n) => n.gateways).filter((g) => IP.isIp(g))).sort(U.natural);
        let gws = dhcp.map((g) => ({ ip: g, owner: ownerOf(g, vrf) })).filter((g) => g.owner && cands.includes(devOfEp(g.owner))).map((g) => ({ dev: devOfEp(g.owner), ep: realEp(g.owner), gateway: g.ip }));
        let basis = 'dhcp';
        if (!gws.length) {
          // 預設路由的下一跳：網段上其他設備的預設路由指向這個網段內某台設備的位址 → 那台是這個網段的預設閘道（basis next-hop）。
          // 預設路由經這個網段內的下一跳送出的設備（例如交換器的管理位址）是這個網段的用戶端，不當閘道。
          const dflt = (d) => Q.routesOf(d, vrf).filter((r) => r.len === 0 && !r.blackhole).flatMap((r) => r.nh).filter((n) => n.ip);
          const nhIn = (d) => dflt(d).filter((n) => IP.inNet(n.ip, net, len));
          const pointed = U.uniq(cands.flatMap(nhIn).map((n) => { const o = ownerOf(n.ip, vrf); return o ? devOfEp(o) : null; }).filter((d) => d && cands.includes(d))).sort(U.natural);
          const client = (d) => nhIn(d).length > 0;
          if (pointed.length) { basis = 'next-hop'; gws = pointed.map((d) => ({ dev: d, ep: epOn(d), gateway: null })); }
          else {
            // 其餘有路由表、不是用戶端的設備；其中有預設路由的優先（主機的預設閘道要能送往任何地方，basis default-route）
            const rt = cands.filter((d) => Q.routesOf(d).length && !client(d)); const withDefault = rt.filter((d) => dflt(d).length);
            basis = withDefault.length && withDefault.length < rt.length ? 'default-route' : 'routes';
            gws = (basis === 'default-route' ? withDefault : rt).map((d) => ({ dev: d, ep: epOn(d), gateway: null }));
          }
        }
        if (!gws.length) { basis = 'subnet'; gws = cands.filter((d) => devInfo(d).collected).map((d) => ({ dev: d, ep: epOn(d), gateway: null })); }
        gws = gws.filter((g, i) => gws.findIndex((x) => x.dev === g.dev && x.ep === g.ep) === i);
        return { how: 'subnet', prefix, net, len, gateways: gws, basis, vrf };
      });
    }
    /** 一次查詢的起點節點。回傳 { start, nodes, reasons }（nodes 為空時 start.end 是結束原因）。 */
    function begin(src, dst, st, ctx, entry) {
      if (entry) return { start: { how: 'entry', dev: devOfEp(entry), ep: entry, gateways: [] }, nodes: arrive(devOfEp(entry), entry, st, 0, ctx) };
      const loc = srcLocation(src, st.vrf);
      if (loc.how === 'device') {
        if (!devInfo(loc.dev).collected) return { start: { how: 'device', dev: loc.dev, ep: loc.ep, gateways: [] }, nodes: [], end: end('unknown', 'unknown', 'src-device-uncollected', loc.dev, `來源 ${src} 屬於沒有收集的 ${name(loc.dev)}，不知道它的路由與防火牆`) };
        return { start: { how: 'device', dev: loc.dev, ep: loc.ep, gateways: [] }, nodes: originate(loc.dev, st, ctx) };
      }
      if (loc.how === 'none') return { start: { how: 'none', dev: null, ep: null, gateways: [] }, nodes: [], end: end('unknown', 'unknown', 'src-location-unknown', null, `找不到包含 ${src} 的網段，不知道封包從哪台設備進入（可用 entry 指定入口介面）`) };
      const start = { how: 'gateway', prefix: loc.prefix, basis: loc.basis, dev: loc.gateways.length === 1 ? loc.gateways[0].dev : null, ep: loc.gateways.length === 1 ? loc.gateways[0].ep || null : null,
        gateways: loc.gateways.map((g) => ({ dev: g.dev, ep: g.ep || null, gateway: g.gateway })) };
      if (IP.inNet(dst, loc.net, loc.len)) { // 同一個網段：不經過路由器
        const own = ownerOf(dst, st.vrf); const d2 = own ? devOfEp(own) : null;
        start.how = 'same-subnet'; start.dev = null; start.ep = null; start.gateways = [];
        if (d2 && netDev(d2)) {
          if (!devInfo(d2).collected) return { start, nodes: [], end: end('unknown', 'unknown', 'dst-device-uncollected', d2, `目的 ${dst} 屬於沒有收集的 ${name(d2)}，它自己的防火牆不明`, { ip: dst }) };
          return { start, nodes: arrive(d2, realEp(own), st, 0, ctx) };
        }
        return { start, nodes: [], end: end('delivered', 'allow', 'same-subnet', null, `來源與目的在同一個網段 ${loc.prefix}，不經過路由器（bridge filter 與主機防火牆不在範圍內）`, { vrf: st.vrf }) };
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
      let verdict; let final = { dst: h.dstOut, port: h.portOut, vrf: (node.end && node.end.vrf) || h.vrf };
      const denyStage = h.stages.find((sg) => sg.status === 'decided' && sg.verdict === 'drop');
      if (h.verdict === 'deny' && denyStage) { pick(denyStage); verdict = 'deny'; }
      else {
        // srcnat 在 filter 之後（postrouting），只改寫來源、不決定允許或拒絕，不算決定結果的規則（逐跳的 nat 欄仍會列出）
        h.stages.forEach((sg) => { if (sg.status === 'decided' && (sg.table === 'filter' || (sg.table === 'nat' && sg.chain === 'dstnat' && sg.verdict !== 'none'))) pick(sg); });
        let v;
        if (node.end) {
          v = node.end.verdict;
          if (node.end.code !== 'local' && node.end.code !== 'host' && node.end.code !== 'segment' && node.end.code !== 'dropped' && node.end.verdict !== 'allow' && !reasons.some((x) => x.code === node.end.code)) reasons.push(reason(node.end.code, node.end.dev, node.end.message, node.end.ip ? { ip: node.end.ip } : {}));
          if (node.end.verdict === 'deny' && !denyStage) decisive.set('route:' + node.end.code + ':' + h.dev, { key: null, dev: h.dev, table: null, chain: null, policy: false, route: node.end.code, verdict: 'drop' });
        } else {
          const kids = node.next.map(summary);
          v = combine(kids);
          kids.forEach((k) => { if (k.nat) nat = true; });
          const sameFinal = kids.every((k) => k.final && kids[0].final && k.final.dst === kids[0].final.dst && k.final.port === kids[0].final.port && k.final.vrf === kids[0].final.vrf);
          final = sameFinal && kids.length ? kids[0].final : null;
          if (v === 'unknown' && U.uniq(kids.map((k) => k.verdict)).length > 1) {
            reasons.push(reason('branches-differ', h.dev, `${name(h.dev)} 之後有多條路徑（ECMP），結果不同（${U.uniq(kids.map((k) => k.verdict)).join('、')}），實際走哪一條無法判斷`));
          }
          // 決定的規則只取與結果一致的子路徑
          kids.filter((k) => k.verdict === v || v === 'unknown').forEach((k) => { k.decisive.forEach((x, id) => decisive.set(id, x)); k.reasons.forEach((x) => reasons.push(x)); });
          if (v === 'deny') { decisive.forEach((x, id) => { if (x.verdict !== 'drop') decisive.delete(id); }); }
        }
        // pinned：這一跳本身的結果不明（例如是否 notrack），之後確定的拒絕也不能決定結果
        verdict = h.verdict === 'unknown' ? (v === 'deny' && !h.pinned ? 'deny' : 'unknown') : v;
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
          final: { dst: st.dst, port: st.port, vrf: (e && e.vrf) || st.vrf }, nat: false };
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
      const sameFinal = kids.every((k) => k.final && kids[0].final && k.final.dst === kids[0].final.dst && k.final.port === kids[0].final.port && k.final.vrf === kids[0].final.vrf);
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
    const reachCache = new Map();
    const skipOf = (keys) => (keys && keys.length ? { id: keys.slice().sort().join(','), set: new Set(keys) } : null);
    /** vrf：來源所在的 VRF（封包從這個 VRF 開始查路由；有 entry 時由入介面決定）。 */
    function evaluate(src, dst, svc, mode, skip, entry, vrf) {
      const ctx = { mode, skip, memo: level(nodeMemo, mode + '\u0000' + (skip ? skip.id : '')) };
      const st = { src, dst, proto: svc.proto, port: svc.port, vrf: K.vrf(vrf) };
      const b = begin(src, dst, st, ctx, entry);
      return { b, sum: summarize(b, st) };
    }
    function reach(src, dst, opts) {
      const o = opts || {};
      if (!IP.isIp(src) || !IP.isIp(dst)) return { ok: false, error: '請輸入有效的 IPv4 位址' };
      const proto = normProto(o.proto === undefined ? 'tcp' : o.proto); const port = normPort(proto, o.port);
      const entry = o.entry == null ? null : String(o.entry);
      if (entry && !Q.getInterface(entry)) throw new TypeError(`entry 必須是基準中的介面鍵（設備|介面），收到 ${JSON.stringify(entry)}`);
      // VRF：有 entry 時是入介面的 VRF（給了不同的 vrf 是錯誤）；否則同 S.trace（給了就用，不存在時 TypeError；沒給時依來源，重疊時請使用者指定）
      let vrf;
      if (entry) {
        vrf = K.vrf(Q.getInterface(entry).vrf);
        if (o.vrf != null && K.vrf(o.vrf) !== vrf) throw new TypeError(`entry ${entry} 屬於 VRF ${vrf}，與 vrf 參數 ${JSON.stringify(String(o.vrf))} 不同`);
      } else {
        const pv = S.trace.pickVrf(Q, src, o.vrf);
        if (pv.error) return { ok: false, error: pv.error, vrfs: pv.vrfs };
        vrf = pv.vrf;
      }
      const skipKeys = o.disabledRules == null ? [] : Array.from(o.disabledRules, String);
      const ck = JSON.stringify([src, dst, proto, port, entry, skipKeys.slice().sort(), vrf]);
      if (reachCache.has(ck)) return reachCache.get(ck);
      const { b, sum } = evaluate(src, dst, { proto, port }, 'exact', skipOf(skipKeys), entry, vrf);
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
        ok: true, src, dst, proto, port, vrf, entry, verdict,
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
      // zone 依 VRF 分開（ADR-015）：非 main 的 VRF，zone 的 id 加上 @<VRF>（K.inVrf），名稱加上（VRF …）；main 的 id 與名稱和加入 VRF 之前相同
      prefixes4().forEach((x) => {
        const p = x.p; const cands = []; const vrf = x.vrf;
        const push = (c) => cands.push(Object.assign(c, { id: K.inVrf(c.id, vrf), name: vrf === K.MAIN_VRF ? c.name : `${c.name}（VRF ${vrf}）` }));
        const ownEps = p.eps.filter((ep) => devInfo(devOfEp(ep)).collected);
        const vl = vlanOfPrefix(p);
        if (zo.sources.includes('profile') && zo.prof && zo.prof.zoneOf) {
          const hit = zo.prof.zoneOf({
            subnet: p.prefix, vlans: vl ? [{ id: vl.id, names: vlanNamesOf(vl.id) }] : [],
            interfaces: ownEps.map((ep) => { const i = Q.getInterface(ep); return { name: i ? i.name : K.splitEp(ep)[1], desc: i ? i.desc : null }; }),
          });
          if (hit) push({ source: 'profile', id: 'tag:' + hit.zone, name: hit.zone, inferred: false, basis: `命名規則 ${zo.prof.id} 的 zones[${hit.rule}]（${hit.on} 符合 ${hit.match}）`, detail: { rule: hit.rule } });
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
            push({ source: 'interface-list', id: 'list:' + lists[0].name, name: lists[0].name, inferred: true,
              basis: `${Q.epName(lists[0].ep)} 是 interface list ${lists[0].name} 的成員（事實），以清單當 zone（推論）${names.length > 1 ? `；也屬於 ${names.slice(1).join('、')}，取成員最少的清單` : ''}`,
              detail: { lists: lists.map((l) => ({ name: l.name, dev: l.dev, ep: l.ep, members: l.size, src: l.src })) } });
          }
        }
        if (zo.sources.includes('vlan') && vl) {
          const names = vlanNamesOf(vl.id);
          push({ source: 'vlan', id: 'vlan:' + vl.id, name: names.length ? `VLAN ${vl.id}（${names.join('／')}）` : `VLAN ${vl.id}`, inferred: true,
            basis: vl.majority ? `網段設在 VLAN ${vl.all.join('、')} 的介面上（各設備不一致，見 A07），取多數的 VLAN ${vl.id}（推論）` : `網段設在 VLAN ${vl.id} 的介面上（推論：同一個 VLAN ID 視為同一個 zone）`,
            detail: { vlan: vl.id } });
        }
        push({ source: 'subnet', id: 'subnet:' + p.prefix, name: p.prefix, inferred: true, basis: '沒有其他來源，以網段本身當 zone（推論）', detail: {} });
        const pickC = zo.sources.map((s) => cands.find((c) => c.source === s)).find(Boolean);
        const z = zoneOfDef(pickC.id, pickC.name, pickC.source, pickC.inferred, pickC.source === 'subnet' ? pickC.basis : null);
        z.vrf = vrf; z.subnets.push(x.key); p.eps.forEach((ep) => z.devices.add(devOfEp(ep)));
        subnets.push({ prefix: p.prefix, key: x.key, net: p.net, len: p.len, vrf, zone: pickC.id, source: pickC.source, inferred: pickC.inferred, basis: pickC.basis, detail: pickC.detail,
          alternatives: cands.filter((c) => c !== pickC && zo.sources.includes(c.source)).map((c) => ({ zone: c.id, source: c.source })), eps: p.eps.slice() });
      });
      const order = (z) => ZONE_SOURCES.indexOf(z.source);
      const list = Array.from(zmap.values()).map((z) => ({
        id: z.id, name: z.name, source: z.source, inferred: z.inferred,
        basis: z.basis || { profile: '命名規則的 zones 標籤（註解，不改寫事實）', 'interface-list': 'interface list（防火牆的 zone）', vlan: 'VLAN ID' }[z.source],
        subnets: z.subnets.slice().sort(U.natural), devices: Array.from(z.devices).sort(U.natural), vrf: z.vrf,
      })).sort((a, b) => order(a) - order(b) || U.natural(a.name, b.name) || U.cmp(a.id, b.id));
      const bySubnet = new Map(subnets.map((s) => [s.key, s]));
      const out = { zones: deepFreeze(list), subnets: deepFreeze(subnets), bySubnet, byId: new Map(list.map((z) => [z.id, z])), opts: zo };
      zoneCache.set(ck, out);
      return out;
    }
    /**
     * IP 所屬的 zone（那個 VRF 最長相符的直連網段）。vrf 省略時用 opts.vrf；都沒有時依位址決定（同 S.trace，位址在多個 VRF 時 TypeError，請指定 vrf）。
     * 回傳 { zone, subnet（網段文字）, key（網段鍵）, vrf, source, inferred }；不在任何網段時為 null。
     */
    function zoneOf(ip, opts, vrf) {
      if (!IP.isIp(ip)) return null;
      let v = vrf !== undefined ? K.vrf(vrf) : null;
      if (v === null) {
        const pv = S.trace.pickVrf(Q, ip, opts && opts.vrf);
        if (pv.error) throw new TypeError(pv.error);
        v = pv.vrf;
      }
      const zs = zones(opts); const x = longest(ip, v);
      if (!x) return null;
      const s = zs.bySubnet.get(x.key);
      return { zone: s.zone, subnet: s.prefix, key: s.key, vrf: v, source: s.source, inferred: s.inferred };
    }

    // ---- zone 矩陣：每個 zone 的代表位址（等價類）× 目的（代表位址＋dst-nat 的入口）× service
    function repsOf(zs) {
      bounds();
      // ARP 的位址依 VRF 分開（代表位址只取同一個 VRF 的 ARP）
      const arpBy = new Map();
      m.arps.forEach((a) => { if (IP.isIp(a.ip)) U.getOr(arpBy, K.vrf(a.vrf), () => new Set()).add(IP.toInt(a.ip)); });
      const arpSorted = new Map(Array.from(arpBy, ([v, set]) => [v, Array.from(set).sort((a, b) => a - b)]));
      const out = new Map(); // zone → [rep]
      prefixes4().forEach((x) => {
        const s = zs.bySubnet.get(x.key);
        const arpIps = arpSorted.get(x.vrf) || [];
        const lo0 = x.len >= 31 ? x.lo : x.lo + 1; const hi0 = x.len >= 31 ? x.hi : x.hi - 1;
        let i = findAtom(repB, x.lo);
        while (i < repB.length && repB[i] <= x.hi) {
          const a = Math.max(repB[i], x.lo); const b = Math.min(i + 1 < repB.length ? repB[i + 1] - 1 : 0xffffffff, x.hi); i++;
          if (longest(IP.fromInt(a), x.vrf).key !== x.key) continue; // 屬於更長的網段
          const lo = Math.max(a, lo0); const hi = Math.min(b, hi0); if (lo > hi) continue;
          const free = (n) => { const o = ownerOf(IP.fromInt(n), x.vrf); return !o || !netDev(devOfEp(o)); };
          let rep = null; let basis = 'arp';
          let k = findAtom(Float64Array.from(arpIps.length ? arpIps : [0]), lo);
          for (; k < arpIps.length && arpIps[k] <= hi; k++) if (arpIps[k] >= lo && free(arpIps[k])) { rep = arpIps[k]; break; }
          if (rep === null) { basis = 'synthetic'; for (let n = lo, c = 0; n <= hi && c < 4096; n++, c++) if (free(n)) { rep = n; break; } }
          if (rep === null) continue;
          const ip = IP.fromInt(rep);
          // 同一個區段的第二個位址：zone 內（對角線）同網段的組合用它當目的
          let peer = null; for (let n = lo, c = 0; n <= hi && c < 4096; n++, c++) if (n !== rep && free(n)) { peer = IP.fromInt(n); break; }
          U.getOr(out, s.zone, () => []).push({ ip, vrf: x.vrf, zone: s.zone, subnet: x.key, range: [IP.fromInt(a), IP.fromInt(b)], basis, via: 'member', dev: null, peer });
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
        const ctx = I.ctxOf(r.dev);
        const dstA = r.match['dst-address'] !== undefined && !F.splitNeg(r.match['dst-address']).neg ? single(F.splitNeg(r.match['dst-address']).body.replace(/\/32$/, '')) : undefined;
        // 入口位址所在的 VRF：設備自己的位址取該介面的 VRF；dst-address 不是設備的位址時為 main。改寫後的目的在同一個 VRF 找 zone
        const vrfOfOwn = (ip) => { const a = Q.interfacesOf(r.dev).flatMap((i) => ownIps(i.key)).find((x) => x.ip === ip); return a ? K.vrf(a.vrf) : K.MAIN_VRF; };
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
        U.uniq(ips).filter((ip) => IP.isIp(ip)).sort(U.natural).forEach((ip) => {
          const vrf = vrfOfOwn(ip); const tz = zoneOf(to, zs.optsRaw, vrf); if (!tz) return;
          out.push({ ip, vrf, zone: tz.zone, subnet: tz.key, range: null, basis: 'dst-nat', via: 'nat', rule: r.key, natTo: to, dev: r.dev });
        });
      });
      return out;
    }
    /**
     * 矩陣的虛擬 zone（推論，不在 Q.zones）：
     *   外部（external）：基準以外的位址。來源從每台設備 WAN 清單的介面（entry）進入，目的經 WAN 介面送出（end egress-wan）；
     *     代表位址是 EXTERNAL_CANDIDATES 中第一個不在基準網段、也不屬於任何設備的位址，只代表與它同一個規則位址區段的公網位址（range）。
     *     沒有任何設備有可辨識的 WAN 清單時沒有這個 zone。
     *   網路設備（管理）（self，只當目的）：已收集且有 /export 的設備自己的位址，走 input 與 /ip service；
     *     取 WAN 介面上的位址，與每個網段的閘道介面上的位址（1000 台時不把每台設備的每個位址都算進來）。
     */
    function virtualOf(reps) {
      bounds();
      const wanEps = [];
      Q.devices().forEach((d) => {
        if (!devInfo(d.key).config) return;
        const c = I.ctxOf(d.key); if (!c || !c.wan) return;
        Array.from(c.wan).sort(U.natural).forEach((ep) => { const i = Q.getInterface(ep); if (i && K.vrf(i.vrf) === K.MAIN_VRF) wanEps.push({ dev: d.key, ep }); });
      });
      const extIp = wanEps.length ? EXTERNAL_CANDIDATES.find((ip) => !longest(ip, K.MAIN_VRF) && !ownerOf(ip, K.MAIN_VRF)) || null : null;
      let range = null;
      if (extIp) { const i = findAtom(ruleB, IP.toInt(extIp)); range = [IP.fromInt(ruleB[i]), IP.fromInt(i + 1 < ruleB.length ? ruleB[i + 1] - 1 : 0xffffffff)]; }
      const extSrc = extIp ? wanEps.map((w) => ({ ip: extIp, vrf: K.MAIN_VRF, zone: EXTERNAL_ZONE, subnet: null, range, basis: 'documentation', via: 'external', dev: w.dev, entry: w.ep })) : [];
      const extDst = extIp ? [{ ip: extIp, vrf: K.MAIN_VRF, zone: EXTERNAL_ZONE, subnet: null, range, basis: 'documentation', via: 'external', dev: null }] : [];
      const selfMap = new Map();
      const addSelf = (dev, ep, inNet) => {
        if (!devInfo(dev).config || !realEp(ep)) return;
        ownIps(ep).filter((a) => !inNet || inNet(a)).forEach((a) => { const v = K.vrf(a.vrf); const k = K.inVrf(a.ip, v); if (!selfMap.has(k)) selfMap.set(k, { ip: a.ip, vrf: v, zone: SELF_ZONE, subnet: null, range: null, basis: 'device', via: 'device', dev }); });
      };
      wanEps.forEach((w) => addSelf(w.dev, w.ep));
      reps.forEach((list) => list.forEach((r) => {
        const loc = srcLocation(r.ip, r.vrf); if (loc.how !== 'subnet') return;
        loc.gateways.forEach((g) => addSelf(g.dev, g.ep, (a) => IP.inNet(a.ip, loc.net, loc.len)));
      }));
      const selfDst = Array.from(selfMap.values()).sort((a, b) => U.natural(a.dev, b.dev) || IP.toInt(a.ip) - IP.toInt(b.ip));
      const zonesV = [];
      if (extIp) zonesV.push({ id: EXTERNAL_ZONE, name: '外部（Internet）', source: 'virtual', inferred: true, virtual: true, dstOnly: false, vrf: K.MAIN_VRF, subnets: [],
        devices: U.uniq(wanEps.map((w) => w.dev)).sort(U.natural), representative: extIp, range,
        basis: `基準以外的位址（推論）：代表位址 ${extIp} 是文件保留位址，只代表 ${range[0]}–${range[1]}（同一個規則位址區段）；來源從 WAN 介面進入，目的經 WAN 介面送出` });
      if (selfDst.length) zonesV.push({ id: SELF_ZONE, name: '網路設備（管理）', source: 'virtual', inferred: true, virtual: true, dstOnly: true, vrf: null, subnets: [],
        devices: U.uniq(selfDst.map((x) => x.dev)).sort(U.natural), representative: null, range: null,
        basis: '網路設備自己的位址（WAN 介面與各網段的閘道介面），走輸入規則（input）與管理服務（/ip service）' });
      return { extSrc, extDst, selfDst, zones: zonesV };
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
    /**
     * 格子的狀態：確定的允許不被「無法判斷」藏起來（暴露存在就要看得到）。
     *   允許與拒絕都有 → partial；只有允許（另有無法判斷）→ allow；沒有允許、有無法判斷 → unknown（無法判斷的可能是允許，拒絕不能當結論）。
     * 有確定的結果又有無法判斷的組合時，另以 incomplete（incompleteOf）標示「部分無法判斷」。
     */
    const STATUS = (c) => (c.allow && c.deny ? 'partial' : c.allow ? 'allow' : c.unknown ? 'unknown' : c.deny ? 'deny' : 'empty');
    const incompleteOf = (c) => c.unknown > 0 && c.allow > 0;
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
    /** 把 generator 跑完，回傳它的結果（同步版與分段版共用同一份判斷）。 */
    const runAll = (it) => { let r = it.next(); while (!r.done) r = it.next(); return r.value; };
    /**
     * 分段計算（Q.zoneMatrixSteps）每一段的時間預算：一次判斷約 0.05–0.3 ms（快取冷的時候較慢），格子的大小也差很多，
     * 用固定的次數切不出穩定的段長，所以每 SLICE_CHECK 個單位看一次經過的時間，超過 SLICE_MS 就讓出。
     * 時間只決定在哪裡讓出（yield 的次數），不影響任何結果（可重現）；1000 台時每段約 SLICE_MS 加上一個單位的時間。
     */
    const SLICE_MS = 25;
    const SLICE_CHECK = 8;
    const slicer = () => { let t0 = Date.now(); let n = 0; return () => { if (++n < SLICE_CHECK) return false; n = 0; const t = Date.now(); if (t - t0 < SLICE_MS) return false; t0 = t; return true; }; };
    function* matrixRawSteps(opts) {
      const o = opts || {};
      const zs = zones(o); zs.optsRaw = o;
      const services = servicesOf(o.services);
      const ck = JSON.stringify([zs.opts.profHash, zs.opts.sources, services.map(svcId)]);
      if (matrixCache.has(ck)) return matrixCache.get(ck);
      yield { stage: 'reps', done: 0, total: 1 };
      const reps = repsOf(zs); const vips = vipsOf(zs); const vz = virtualOf(reps);
      const realIds = zs.zones.map((z) => z.id);
      const srcReps = []; realIds.forEach((z) => (reps.get(z) || []).forEach((r) => srcReps.push(r)));
      const memberN = srcReps.length;
      vz.extSrc.forEach((r) => srcReps.push(r));
      const targets = srcReps.slice(0, memberN).concat(vips, vz.extDst, vz.selfDst);
      // 列（來源）：實際的 zone＋外部；欄（目的）：再加網路設備（管理）
      const allZones = zs.zones.concat(vz.zones);
      const rowIds = allZones.filter((z) => !z.dstOnly).map((z) => z.id); const zoneIds = allZones.map((z) => z.id);
      const cells = new Map();
      const cellOf = (a, b) => U.getOr(cells, a + '\u0000' + b, () => ({ src: a, dst: b, recs: [] }));
      const classes = svcClasses(services);
      // 判斷次數的上限（來源代表 × 目的 × service 等價類，扣掉來源與目的相同的）只用來回報進度
      const total = srcReps.length * targets.length * classes.length;
      let done = 0;
      yield { stage: 'evaluate', done, total };
      const due = slicer();
      for (let ai = 0; ai < srcReps.length; ai++) {
        const a = srcReps[ai];
        for (let ti = 0; ti < targets.length; ti++) {
          const t = targets[ti];
          for (const sis of classes) {
            done++;
            // 來源與目的是同一個代表位址：zone 內同網段的組合改用同一個區段的第二個位址（沒有就略過）
            const same = a.ip === t.ip && a.vrf === t.vrf;
            if (same && !(t.via === 'member' && t.peer)) continue;
            const rp = services[sis[0]].port;
            const { sum } = evaluate(a.ip, same ? t.peer : t.ip, services[sis[0]], 'atom', null, a.entry || null, a.vrf);
            const fv0 = (sum.final && sum.final.vrf) || t.vrf;
            // dst-nat 的入口只算真的被改寫的；設備本身的目的只算真的送到那台設備的（重疊位址在來源的 VRF 送達別處時不算）
            if (!(t.via === 'nat' && !sum.nat) && !(t.via === 'device' && (fv0 !== t.vrf || (sum.final && sum.final.dst !== t.ip)))) {
              // 目的 zone：NAT 改寫了目的時依改寫後的位址；送達的 VRF 和目的代表的 VRF 不同時（重疊的位址在來源的 VRF 就送達了）依送達的 VRF
              let dz = t.zone;
              const fv = (sum.final && sum.final.vrf) || t.vrf;
              const tip = same ? t.peer : t.ip;
              if (sum.final && (sum.final.dst !== tip || (fv !== t.vrf && sum.verdict === 'allow'))) { const z = zoneOf(sum.final.dst, o, fv); if (z) dz = z.zone; }
              const c = cellOf(a.zone, dz);
              sis.forEach((si) => c.recs.push({ ai, ti, si, sum, rp }));
            }
            if (due() && done < total) yield { stage: 'evaluate', done, total };
          }
        }
      }
      // 跑完才寫進快取：中途放棄的 generator 不會留下不完整的結果
      if (matrixCache.has(ck)) return matrixCache.get(ck);
      const byId = new Map(allZones.map((z) => [z.id, z]));
      const res = { zs, services, srcReps, targets, cells, zoneIds, rowIds, allZones, byId, memberN, vz, natN: vips.length, opts: o };
      matrixCache.set(ck, res);
      return res;
    }
    const matrixRaw = (opts) => runAll(matrixRawSteps(opts));
    /** 一格的摘要（L0 的格子）：逐筆累加（add），最後 finish；分段計算時可以在記錄之間讓出。 */
    function cellAcc(mx, c) {
      const counts = { allow: 0, deny: 0, unknown: 0, total: 0 };
      const bySvc = mx.services.map(() => ({ allow: 0, deny: 0, unknown: 0, total: 0 }));
      const rules = new Map(); const reasons = new Map();
      const byDst = new Map(); const bySrc = new Map();
      const add = (r) => {
        const v = r.sum.verdict; counts[v]++; counts.total++; bySvc[r.si][v]++; bySvc[r.si].total++;
        r.sum.decisive.forEach((x, id) => { const e = U.getOr(rules, id + '\u0000' + x.verdict, () => Object.assign({ id, count: 0 }, x)); e.count++; });
        if (v === 'unknown') r.sum.reasons.forEach((x) => reasons.set(x.code, (reasons.get(x.code) || 0) + 1));
        if (v !== 'unknown') { U.getOr(byDst, r.ti + '|' + r.si, () => new Set()).add(v); U.getOr(bySrc, r.ai + '|' + r.si, () => new Set()).add(v); }
      };
      return { add, finish: () => cellFinish(mx, c, { counts, bySvc, rules, reasons, byDst, bySrc }) };
    }
    function cellSummary(mx, c) { const acc = cellAcc(mx, c); c.recs.forEach(acc.add); return acc.finish(); }
    function cellFinish(mx, c, { counts, bySvc, rules, reasons, byDst, bySrc }) {
      const het = Array.from(byDst.values()).some((s) => s.size > 1) || Array.from(bySrc.values()).some((s) => s.size > 1);
      const ruleList = Array.from(rules.values()).sort((a, b) => b.count - a.count || U.cmp(a.id, b.id)).map(({ id, ...x }) => Object.assign({ id }, x, x.key ? { rule: ref(Q.getFirewallRule(x.key)) } : {}));
      return {
        src: c.src, dst: c.dst, diagonal: c.src === c.dst, status: STATUS(counts), incomplete: incompleteOf(counts), counts, heterogeneous: het,
        services: mx.services.map((s, i) => ({ service: svcId(s), proto: s.proto, port: s.port, status: STATUS(bySvc[i]), incomplete: incompleteOf(bySvc[i]), counts: bySvc[i] })),
        rule: ruleList.find((x) => x.key) || ruleList[0] || null, rules: ruleList.slice(0, 5), ruleCount: ruleList.length,
        reasons: Array.from(reasons.entries()).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || U.cmp(a.code, b.code)),
      };
    }
    /** IPv6 在用（推論，firewallZones[].ipv6）的設備：矩陣只算 IPv4，畫面據此提示 IPv6 未納入（F05／F07）。 */
    const ipv6Devices = () => (m.firewallZones || []).filter((z) => z.ipv6 && z.ipv6.status === 'used').map((z) => ({ dev: z.dev, src: (z.ipv6.src || []).map((x) => x.slice()) })).sort((a, b) => U.natural(a.dev, b.dev));
    const l0Cache = new Map();
    /**
     * zone 矩陣 L0 的分段計算（generator）：每一段 yield { stage: 'reps'|'evaluate'|'summary', done, total }，
     * 最後的回傳值就是 matrix(opts) 的結果，並寫進同一份快取；已有快取時不 yield、直接回傳。
     */
    function* matrixSteps(opts) {
      const mx = yield* matrixRawSteps(opts);
      const ck = JSON.stringify([mx.zs.opts.profHash, mx.zs.opts.sources, mx.services.map(svcId)]);
      if (l0Cache.has(ck)) return l0Cache.get(ck);
      const cells = [];
      // 進度以記錄數計（格子大小差很多）；空格子算一個單位
      const total = mx.rowIds.reduce((n, a) => n + mx.zoneIds.reduce((k, b) => { const c = mx.cells.get(a + '\u0000' + b); return k + (c ? Math.max(1, c.recs.length) : 1); }, 0), 0);
      let done = 0;
      yield { stage: 'summary', done, total };
      const due = slicer();
      for (const a of mx.rowIds) {
        for (const b of mx.zoneIds) {
          const c = mx.cells.get(a + '\u0000' + b);
          if (!c) {
            cells.push({ src: a, dst: b, diagonal: a === b, status: 'empty', incomplete: false, counts: { allow: 0, deny: 0, unknown: 0, total: 0 }, heterogeneous: false,
              services: mx.services.map((s) => ({ service: svcId(s), proto: s.proto, port: s.port, status: 'empty', incomplete: false, counts: { allow: 0, deny: 0, unknown: 0, total: 0 } })), rule: null, rules: [], ruleCount: 0, reasons: [] });
            done++;
          } else {
            const acc = cellAcc(mx, c);
            for (const r of c.recs) {
              acc.add(r); done++;
              if (due() && done < total) yield { stage: 'summary', done, total };
            }
            cells.push(acc.finish());
            if (!c.recs.length) done++;
          }
          if (due() && done < total) yield { stage: 'summary', done, total };
        }
      }
      if (l0Cache.has(ck)) return l0Cache.get(ck); // 兩個分段計算交錯時，先完成的為準（結果相同）
      const reps = mx.memberN; const evaluations = Array.from(mx.cells.values()).reduce((n, c) => n + c.recs.length, 0);
      const out = deepFreeze({
        vrf: null, vrfs: Q.vrfs().filter((v) => mx.zs.zones.some((z) => z.vrf === v)), zones: mx.allZones, services: mx.services.map((s) => ({ id: svcId(s), proto: s.proto, port: s.port })), cells,
        stats: { zones: mx.zoneIds.length, representatives: reps, natEntries: mx.natN, externalEntries: mx.vz.extSrc.length, deviceTargets: mx.vz.selfDst.length, evaluations },
        ipv6: ipv6Devices(),
      });
      l0Cache.set(ck, out);
      return out;
    }
    const matrix = (opts) => runAll(matrixSteps(opts));
    const recOut = (mx, r) => {
      const a = mx.srcReps[r.ai]; const t = mx.targets[r.ti]; const s = mx.services[r.si];
      return { src: a, dst: t, service: svcId(s), verdict: r.sum.verdict, final: r.sum.final && r.sum.final.port === r.rp ? { dst: r.sum.final.dst, port: s.port } : r.sum.final,
        rules: Array.from(r.sum.decisive.values()).map((x) => (x.key ? x.key : `policy:${x.dev}|${x.table}|${x.chain}`)),
        reasons: r.sum.verdict === 'unknown' ? U.uniq(r.sum.reasons.map((x) => x.code)) : [] };
    };
    function cell(srcZone, dstZone, opts) {
      const mx = matrixRaw(opts);
      if (!mx.byId.has(srcZone) || !mx.byId.has(dstZone)) throw new TypeError(`沒有這個 zone：${!mx.byId.has(srcZone) ? srcZone : dstZone}`);
      const c = mx.cells.get(srcZone + '\u0000' + dstZone) || { src: srcZone, dst: dstZone, recs: [] };
      const sm = cellSummary(mx, c);
      // L1：每個（來源代表、目的）一列，依 service 列出結果；結果相同的來源併成一組（規格書 §5.7）
      const pairs = new Map();
      c.recs.forEach((r) => {
        const p = U.getOr(pairs, r.ai + '|' + r.ti, () => ({ ai: r.ai, ti: r.ti, services: [] }));
        const x = recOut(mx, r); p.services.push({ service: x.service, verdict: x.verdict, final: x.final, rules: x.rules, reasons: x.reasons });
      });
      // 造成異質的記錄（與 cellSummary 的 heterogeneous 同一個依據）：heterogeneous 是「同一個目的與 service，不同來源的結果不同」
      // 或「同一個來源與 service，不同目的的結果不同」（unknown 不算）。在這樣一條有衝突的線上，結果是少數（平手時兩邊都算）的記錄造成差異。
      // 所以格子異質時至少有一組 divergent，不異質時沒有。
      const lineOf = new Map();
      const tally = (k, v) => { const e = U.getOr(lineOf, k, () => ({ allow: 0, deny: 0 })); e[v]++; };
      c.recs.forEach((r) => { if (r.sum.verdict !== 'unknown') { tally('d' + r.ti + '|' + r.si, r.sum.verdict); tally('s' + r.ai + '|' + r.si, r.sum.verdict); } });
      const minority = (k, v) => { const e = lineOf.get(k); return e.allow > 0 && e.deny > 0 && e[v] <= e[v === 'allow' ? 'deny' : 'allow']; };
      const divergentSvc = new Map(); // ai|ti → Set(service id)
      c.recs.forEach((r) => {
        const v = r.sum.verdict; if (v === 'unknown') return;
        if (minority('d' + r.ti + '|' + r.si, v) || minority('s' + r.ai + '|' + r.si, v)) U.getOr(divergentSvc, r.ai + '|' + r.ti, () => new Set()).add(svcId(mx.services[r.si]));
      });
      const rows = new Map();
      Array.from(pairs.values()).sort((p, q) => p.ti - q.ti || p.ai - q.ai).forEach((p) => {
        const sig = JSON.stringify(p.services.map((s) => [s.service, s.verdict, s.rules, s.reasons]));
        const row = U.getOr(rows, p.ti + '|' + sig, () => ({ dst: mx.targets[p.ti], srcs: [], services: p.services, div: new Set() }));
        row.srcs.push(mx.srcReps[p.ai]);
        (divergentSvc.get(p.ai + '|' + p.ti) || []).forEach((sv) => row.div.add(sv));
      });
      const groups = Array.from(rows.values()).map((r) => {
        const c2 = { allow: 0, deny: 0, unknown: 0 }; r.services.forEach((s) => { c2[s.verdict]++; });
        return { dst: r.dst, srcs: r.srcs, services: r.services, status: STATUS(c2), incomplete: incompleteOf(c2), counts: c2,
          srcDevices: U.uniq(r.srcs.flatMap((s) => { if (s.entry) return [s.entry]; const l = srcLocation(s.ip, s.vrf); return l.how === 'subnet' ? l.gateways.map((g) => g.ep || g.dev) : l.dev ? [l.dev] : []; })).sort(U.natural),
          divergent: r.div.size > 0, divergentServices: r.services.map((s) => s.service).filter((sv) => r.div.has(sv)) };
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
        // 這台設備的位址（每個 VRF 分開；位址鍵排序）
        const ownAll = Q.interfacesOf(rule.dev).flatMap((i) => ownIps(i.key).map((a) => ({ ip: a.ip, vrf: K.vrf(a.vrf) })));
        const own = ownAll.filter((x, i) => ownAll.findIndex((y) => y.ip === x.ip && y.vrf === x.vrf) === i).sort((x, y) => U.natural(K.inVrf(x.ip, x.vrf), K.inVrf(y.ip, y.vrf)));
        const zoneOfIp = (ip, vrf) => { const z = zoneOf(ip, o, vrf); return z ? z.zone : null; };
        const finalZone = (sum, ip, vrf) => (sum.final && sum.final.dst ? zoneOfIp(sum.final.dst, sum.final.vrf || vrf) : zoneOfIp(ip, vrf)); // zone 以 NAT 後的位址為準
        own.forEach(({ ip, vrf }) => mx.srcReps.forEach((a) => mx.services.forEach((svc) => {
          if (a.ip === ip && a.vrf === vrf) return;
          const { sum } = evaluate(a.ip, ip, svc, 'atom', null, a.entry || null, a.vrf);
          if (involves(sum, key)) recs.push({ plane: 'device', src: a, dst: { ip, vrf, zone: zoneOfIp(ip, vrf), subnet: null, via: 'device', dev: rule.dev }, svc, sum, cell: [a.zone, finalZone(sum, ip, vrf)] });
        })));
        own.forEach(({ ip, vrf }) => mx.targets.forEach((t) => mx.services.forEach((svc) => {
          if (t.ip === ip && t.vrf === vrf) return;
          const { sum } = evaluate(ip, t.ip, svc, 'atom', null, null, vrf);
          if (involves(sum, key)) recs.push({ plane: 'device', src: { ip, vrf, zone: zoneOfIp(ip, vrf), subnet: null, via: 'device', dev: rule.dev }, dst: t, svc, sum, cell: [zoneOfIp(ip, vrf), finalZone(sum, t.ip, t.vrf) || t.zone] });
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
        const alt = evaluate(r.src.ip, r.dst.via === 'member' && r.src.ip === r.dst.ip ? r.dst.peer : r.dst.ip, r.svc, 'atom', skip, r.src.entry || null, r.src.vrf).sum;
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

    return { reach, zones: (o) => ({ zones: zones(o).zones, subnets: zones(o).subnets }), zoneOf, matrix, matrixSteps, cell, ruleImpact };
  }

  // 靜態資訊（不依賴 Snapshot）：預設 service、zone 來源與可達性前提，畫面經 S.query.* 讀取
  if (S.query) {
    S.query.l4Services = () => SERVICES;
    S.query.zoneSources = () => ZONE_SOURCES;
    S.query.reachAssumptions = () => ASSUMPTIONS;
    /** Q.reach／Q.zoneMatrix／Q.zoneCell 會出現的原因與結束代碼（凍結的陣列 [{ code, kind: 'reason'|'end', note }]），畫面用來確認中文對照涵蓋每個代碼。 */
    S.query.reachReasonCodes = () => REASON_CODES;
  }
})(globalThis.SSOT = globalThis.SSOT || {});
