/*
 * 路由追蹤（純函式）：在基準的路由表上，從來源 IP 逐跳走到目的 IP。
 *  - 起點：介面網段包含來源 IP 的設備（最長遮罩優先），即來源的閘道
 *  - 每一跳：目的在直連網段 → 抵達；否則最長前綴比對，同遮罩多條即 ECMP 分支
 *  - 下一跳 IP → 擁有該 IP 的設備；下一跳本身不屬於任何設備時，沿本機路由表遞迴解析（S.check.resolveNextHop）；找不到、沒有路由資料、迴圈、TTL 用盡都會停下並註明原因
 */
(function (S) {
  'use strict';
  const IP = S.ip;

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
      const stepKey = dev + '>' + path.length;
      if (expanded.has(dev)) continue; // 同一設備只展開一次（ECMP 匯流時避免重複）
      expanded.add(dev);
      if (ttl <= 0) { ends.push({ dev, status: 'ttl', note: 'TTL 用盡' }); continue; }
      // 直連
      const conn = Q.subnets().filter((s) => s.dev === dev && IP.inNet(dst, s.net, s.len)).sort((a, b) => b.len - a.len)[0];
      if (conn) { ends.push({ dev, status: 'reached', note: `目的位於直連網段 ${conn.net}/${conn.len}（${Q.epName(conn.ep)}）`, path }); continue; }
      const routes = Q.routesOf(dev);
      if (!routes.length) { ends.push({ dev, status: 'noroute', note: '這台設備沒有路由表資料', path }); continue; }
      let best = -1; let cands = [];
      routes.forEach((r) => {
        if (r.proto === 'Local') return;
        if (!IP.inNet(dst, r.prefix, r.len)) return;
        if (r.len > best) { best = r.len; cands = [r]; } else if (r.len === best) cands.push(r);
      });
      if (!cands.length) { ends.push({ dev, status: 'noroute', note: `沒有符合 ${dst} 的路由`, path }); continue; }
      const nhs = [];
      cands.forEach((r) => r.nh.forEach((n) => nhs.push({ r, n })));
      const hop = { dev, route: `${cands[0].prefix}/${cands[0].len}`, proto: cands[0].proto, ecmp: nhs.length > 1, next: [] };
      hops.push(hop);
      nhs.forEach(({ r, n }) => {
        if (!n.ip) { hop.next.push({ ip: null, ifc: n.ifc, status: 'connected', note: `經 ${n.ifc} 直接送出（${r.proto}）` }); ends.push({ dev, status: 'reached', note: `目的在 ${n.ifc} 直連`, path }); return; }
        const devOf = (ip) => { const o = Q.ipOwner(ip); return o ? o.split('|')[0] : null; };
        // 下一跳本身不是已知位址時，沿本機路由表遞迴解析（例如 gateway 是對端 loopback）
        const rec = S.check.resolveNextHop(routes, n.ip, devOf);
        const hit = rec.filter((x) => x.status === 'known');
        if (!Q.ipOwner(n.ip) && hit.length) {
          hit.forEach((x) => {
            if (path.includes(x.owner)) { hop.next.push({ ip: n.ip, ifc: n.ifc, dev: x.owner, status: 'loop', note: '路由迴圈' }); ends.push({ dev: x.owner, status: 'loop', note: `回到 ${Q.devName(x.owner)}，路由迴圈`, path: path.concat(x.owner) }); return; }
            hop.next.push({ ip: n.ip, ifc: n.ifc, dev: x.owner, status: 'ok', note: `遞迴解析：${x.chain.join(' → ')}` });
            edges.add(dev + '>' + x.owner);
            queue.push({ dev: x.owner, ttl: ttl - 1, path: path.concat(x.owner) });
          });
          return;
        }
        const owner = Q.ipOwner(n.ip);
        if (!owner) { hop.next.push({ ip: n.ip, ifc: n.ifc, status: 'unknown', note: '下一跳不屬於任何已知設備' }); ends.push({ dev, status: 'unknown-nh', note: `下一跳 ${n.ip} 不在基準內`, path }); return; }
        const nd = owner.split('|')[0];
        if (path.includes(nd)) { hop.next.push({ ip: n.ip, ifc: n.ifc, dev: nd, status: 'loop', note: '路由迴圈' }); ends.push({ dev: nd, status: 'loop', note: `回到 ${Q.devName(nd)}，路由迴圈`, path: path.concat(nd) }); return; }
        hop.next.push({ ip: n.ip, ifc: n.ifc, dev: nd, status: 'ok' });
        edges.add(dev + '>' + nd);
        queue.push({ dev: nd, ttl: ttl - 1, path: path.concat(nd) });
      });
      void stepKey;
    }
    const reached = ends.some((e) => e.status === 'reached');
    return { ok: true, src, dst, start: startDev, reached, hops, ends, edges: Array.from(edges).map((e) => e.split('>')) };
  };
})(globalThis.SSOT = globalThis.SSOT || {});
