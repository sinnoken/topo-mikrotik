/*
 * L4 引擎：暴露清單（由外而內，S.reach._.exposurePart，src/query/reach.js 的 makeEngine 呼叫）。
 *  - Q.exposure／Q.exposureSteps：從對外入口（l4Entries）進來，連得到哪些位址、哪些服務（推論，查詢時計算，ADR-014）；
 *  - IPv6 第一階段只看邊界路由器（exposure6）：不做 IPv6 路由與 NAT66。
 * 必須在 src/query/reach-matrix.js 之後載入（tools/core-files.js）。
 */
(function (S) {
  'use strict';
  const IP = S.ip;
  const K = S.keys;
  const U = S.util;
  const { deepFreeze, SERVICES, SELF_ZONE, EXTERNAL_CANDIDATES, EXTERNAL6_CANDIDATES, EXPOSURE_ASSUMPTIONS, svcId, keyWhy, NAT_UNKNOWN, runAll, slicer } = S.reach._;

  /** E：reach.js 的 base 建立的 engine 物件；加上 exposure、exposureSteps。 */
  S.reach._.exposurePart = function exposurePart(E) {
    const { Q, I, m, F, name, ownerOf, intOf, ownerDev, longest, devInfo, netDev, ref, where, reason, bounds, externalRep, repInRange, single, ownIps, l4Entries, ipv6Devices,
      evaluate, pathsOf, rowLayers, deniedByOf, unsafeOfSum, unsafeReason, dedupeReasons, zones, zoneOf, repsOf, virtualOf, svcClasses, devClasses } = E;

    // ---- 暴露清單（由外而內）：從 WAN 進來，連得到哪些位址、哪些服務（推論，查詢時計算，ADR-014）
    const exposureCache = new Map();
    /**
     * 不會是從 WAN 進來的新連線來源（S.ip.classify）：reserved（0.0.0.0/8「this network」、240.0.0.0/4 與廣播、192.0.0.0/24、198.18.0.0/15）、loopback、multicast。
     * private、cgnat、link-local 仍算（偽造或電信業者那一側的來源可能出現在 WAN）；documentation 是代表位址本身。
     */
    const NOT_EXTERNAL_SRC = new Set(['reserved', 'loopback', 'multicast']);
    const SPECIAL_SRC = (n) => NOT_EXTERNAL_SRC.has(IP.classify(IP.fromInt(n)));
    /** 一台設備的規則（src-address）、/ip service 的 available-from 與 /routing rule 的 src-address 的區段邊界（只依事實，每份基準算一次）。 */
    let ruleBounds = null; const srcBounds = new Map();
    const addBound = (list, text) => {
      if (text === undefined) return;
      const p = F.parseVal('src-address', F.splitNeg(text).body);
      if (p.kind === 'ranges' && p.bits === 32) p.items.forEach(([x, y]) => { list.push(Number(x), Number(y) + 1); });
    };
    function srcBoundsOf(dev) {
      if (srcBounds.has(dev)) return srcBounds.get(dev);
      if (!ruleBounds) {
        ruleBounds = new Map();
        m.firewallRules.forEach((r) => { if (r.family === 'ip') addBound(U.getOr(ruleBounds, r.dev, () => []), r.match['src-address']); });
        (m.routingRules || []).forEach((r) => addBound(U.getOr(ruleBounds, r.dev, () => []), r.match['src-address']));
      }
      const list = (ruleBounds.get(dev) || []).slice();
      Q.ipServicesOf(dev).forEach((sv) => sv.addresses.forEach((a) => addBound(list, a)));
      srcBounds.set(dev, list);
      return list;
    }
    /**
     * 外部來源的代表位址：devs（入口設備；經其他入口連到設備本身時再加上目的設備）的規則（src-address）、/ip service 的 available-from 與 /routing rule 的 src-address 切出的區段，
     * 每個區段取一個不在基準網段、也不屬於任何設備的位址。第一個是矩陣外部 zone 的代表位址所在的區段（用同一個位址）。超過 max 時截斷。
     */
    function extSources(devs, extIp, max) {
      const b = new Set([0, 0x100000000]);
      devs.forEach((d) => srcBoundsOf(d).forEach((x) => b.add(x)));
      const arr = Array.from(b).sort((x, y) => x - y);
      const outside = (n) => !SPECIAL_SRC(n) && !longest(IP.fromInt(n), K.MAIN_VRF) && !ownerOf(IP.fromInt(n), K.MAIN_VRF);
      const atoms = [];
      const cands = EXTERNAL_CANDIDATES.map(intOf);
      for (let i = 0; i + 1 < arr.length; i++) {
        const lo = arr[i]; const hi = arr[i + 1] - 1;
        const rep = repInRange(lo, hi, cands, lo + Math.floor((hi - lo) / 2), outside);
        if (rep !== undefined) atoms.push({ ip: IP.fromInt(rep), range: [IP.fromInt(lo), IP.fromInt(hi)], primary: extIp != null && intOf(extIp) >= lo && intOf(extIp) <= hi });
      }
      atoms.forEach((a) => { if (a.primary) a.ip = extIp; });
      // 矩陣的代表位址所在的區段排第一，其餘依位址
      atoms.sort((x, y) => (y.primary ? 1 : 0) - (x.primary ? 1 : 0) || intOf(x.ip) - intOf(y.ip));
      return { list: atoms.slice(0, max), total: atoms.length, truncated: atoms.length > max };
    }
    /** 候選服務：預設服務 ∪ 從 WAN 進來的 input／forward 放行規則的 dst-port ∪ dst-nat 的 dst-port ∪ 入口設備 /ip service 的埠。埠範圍取第一個埠當代表，記下範圍。 */
    function exposureServices(entries) {
      const byId = new Map();
      const addSvc = (proto, port, origin, range) => {
        const s = { proto, port }; const id = svcId(s);
        const e = U.getOr(byId, id, () => ({ id, proto, port, range: null, origins: [] }));
        if (!e.origins.includes(origin)) e.origins.push(origin);
        if (range && !e.range) e.range = range;
      };
      SERVICES.forEach((s) => addSvc(s.proto, s.port, 'default'));
      const wanOf = new Map(); entries.forEach((w) => U.getOr(wanOf, w.dev, () => []).push(w.ep));
      const fromWan = (r) => ['in-interface', 'in-interface-list'].every((k) => {
        const v = r.match[k]; if (v === undefined) return true;
        const { neg, body } = F.splitNeg(v);
        const set = k === 'in-interface' ? new Set([K.ep(r.dev, body)]) : I.ctxOf(r.dev).resolve(body);
        if (!set) return true; // 無法展開的清單：可能包含 WAN，候選服務寧多勿少（判斷交給引擎）
        return wanOf.get(r.dev).some((ep) => (neg ? !set.has(ep) : set.has(ep)));
      });
      const portsOf = (r, origin) => {
        if (r.match['dst-port'] === undefined) return;
        const v = F.parseVal('dst-port', r.match['dst-port']);
        if (v.kind !== 'ranges' || v.neg) return;
        const pr = r.match.protocol !== undefined && !F.splitNeg(r.match.protocol).neg ? F.splitNeg(r.match.protocol).body.split(',').map((p) => F.protoName(p.trim().toLowerCase())) : ['tcp'];
        pr.filter((p) => F.PORT_PROTOCOLS.has(p)).forEach((p) => v.items.forEach(([a, b2]) => addSvc(p, Number(a), origin, a === b2 ? null : [Number(a), Number(b2)])));
      };
      // IPv6 的放行規則也提供候選埠（暴露清單的 IPv6 列與 IPv4 共用同一份服務）；dst-nat 只有 IPv4
      m.firewallRules.forEach((r) => {
        if ((r.family !== 'ip' && r.family !== 'ipv6') || r.disabled) return;
        if (r.family === 'ip' && r.table === 'nat' && r.chain === 'dstnat' && r.action === 'dst-nat') portsOf(r, 'dst-nat');
        else if (r.table === 'filter' && (r.chain === 'input' || r.chain === 'forward') && r.action === 'accept' && wanOf.has(r.dev) && fromWan(r)) portsOf(r, 'filter');
      });
      wanOf.forEach((_, d) => Q.ipServicesOf(d).forEach((sv) => { if (Number.isInteger(sv.port)) addSvc('tcp', sv.port, 'ip-service'); }));
      wanOf.forEach((_, d) => mgmtPorts(d).forEach((x) => addSvc(x.proto, x.port, 'mgmt')));
      const PO = ['icmp', 'tcp', 'udp'];
      return Array.from(byId.values()).sort((a, b) => (PO.indexOf(a.proto) + 1 || 9) - (PO.indexOf(b.proto) + 1 || 9) || U.cmp(a.proto, b.proto) || (a.port || 0) - (b.port || 0));
    }
    /**
     * 設備本身的其他管理服務（Q.mgmtOf，F10、F13、F14 判斷過的埠）：開著的才列。name 是畫面顯示的服務名稱，finding 是對應的檢查（facet 為 null 時同 id 的都算）。
     */
    const mgmtPorts = (dev) => {
      const g = Q.mgmtOf(dev); if (!g) return [];
      const out = [];
      if (g.dns && g.dns.allowRemote) out.push({ proto: 'udp', port: 53, name: 'dns', finding: ['F10', null] }, { proto: 'tcp', port: 53, name: 'dns', finding: ['F10', null] });
      if (g.snmp && g.snmp.enabled) out.push({ proto: 'udp', port: 161, name: 'snmp', finding: ['F13', null] });
      if (g.proxy && g.proxy.enabled) (g.proxy.ports || []).forEach((p) => { if (Number.isInteger(p)) out.push({ proto: 'tcp', port: p, name: 'web-proxy', finding: ['F14', 'proxy'] }); });
      if (g.socks && g.socks.enabled && Number.isInteger(g.socks.port)) out.push({ proto: 'tcp', port: g.socks.port, name: 'socks', finding: ['F14', 'socks'] });
      if (g.bandwidthServer && g.bandwidthServer.enabled && Number.isInteger(g.bandwidthServer.port)) out.push({ proto: 'tcp', port: g.bandwidthServer.port, name: 'bandwidth-server', finding: ['F14', 'bandwidth-server'] });
      return out;
    };
    const EXPOSURE_FINDINGS = new Set(['F03', 'F04', 'F05', 'F07', 'F10', 'F11', 'F12', 'F13', 'F14']);
    /** 一列相關的檢查（findingKey）：決定結果的規則（F03、F04；IPv6 列的 F05）、/ip service（F07）與設備的管理服務（F10、F13、F14）。 */
    const rowFindings = (dev, sum, svcName, mg) => {
      const fs = [];
      sum.decisive.forEach((x) => { if (x.key) fs.push(...Q.findingsFor('rule', x.key)); });
      if (svcName) fs.push(...Q.findingsFor('service', dev + '|' + svcName));
      if (mg) fs.push(...Q.findingsFor('device', dev).filter((f) => f.id === mg.finding[0] && (mg.finding[1] == null || f.facet === mg.finding[1])));
      return U.uniq(fs.filter((f) => EXPOSURE_FINDINGS.has(f.id)).map((f) => Q.findingKey(f))).sort(U.cmp);
    };
    // ---- 暴露清單的 IPv6（第一階段，只看邊界路由器）：不做 IPv6 路由與 NAT66。
    //   從 WAN 進入入口設備，以它的 /ipv6 firewall（raw prerouting、filter input／forward）判斷能到設備本身（self）與它直連的 LAN 側網段（routed）；
    //   規則語意全部用 S.infer.fw.decide（family ipv6），/ip service 的 available-from 也接受 IPv6 前綴
    //   （https://manual.mikrotik.com/docs/cli-reference/ip/service.md）。位址以 BigInt 表示，只在這一段使用。
    // 從 WAN 進來的 IPv6 新連線來源取全球單播（S.ip 的 public 類，2000::/3）的範圍；其中的 2001:db8::/32 是 documentation（代表位址本身），也算
    const GUA = IP.rangesOf(['public']).filter((c) => !IP.isIp(c.split('/')[0])).map((c) => F.parseVal('dst-address', c).items[0])[0];
    const GUA_LO = GUA[0]; const GUA_HI = GUA[1];
    const EXT6_CLASSES = new Set(['public', 'documentation']);
    const range6 = (text) => { const p = F.parseVal('dst-address', String(text)); return p.kind === 'ranges' && p.bits === 128 && !p.neg ? p.items : null; };
    /** BigInt → IPv6 文字（RFC 5952：小寫、省略前導 0、最長的連續 0（至少兩組）寫成 ::）。 */
    const fmt6 = (n) => {
      const g = []; for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn));
      let bs = -1; let bl = 0;
      for (let i = 0; i < 8;) { if (g[i] !== 0) { i++; continue; } let j = i; while (j < 8 && g[j] === 0) j++; if (j - i >= 2 && j - i > bl) { bs = i; bl = j - i; } i = j; }
      const hex = g.map((x) => x.toString(16));
      return bs < 0 ? hex.join(':') : hex.slice(0, bs).join(':') + '::' + hex.slice(bs + bl).join(':');
    };
    const cmpBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const linkLocal6 = (n) => IP.classify(fmt6(n)) === 'link-local'; // 只在同一個鏈路有效，不是從 WAN 進得來的目的
    /** 基準中的 IPv6 位址（ipAddresses 的 family 6，main VRF、不含鄰居宣告的）：[{ dev, ep, n, ip, len, lo, hi, prefix, src }]。 */
    let v6facts = null;
    function v6Facts() {
      if (v6facts) return v6facts;
      const addrs = [];
      (m.ipAddresses || []).forEach((a) => {
        if (a.family !== 6 || a.hearsay || !a.ep || K.vrf(a.vrf) !== K.MAIN_VRF) return;
        const t = String(a.address || ''); const cut = t.indexOf('/');
        const len = cut < 0 ? 128 : Number(t.slice(cut + 1));
        const one = range6(cut < 0 ? t : t.slice(0, cut)); const net = range6(t);
        if (!one || !net || !Number.isInteger(len) || len < 0 || len > 128) return;
        addrs.push({ dev: a.dev, ep: a.ep, n: one[0][0], ip: fmt6(one[0][0]), len, lo: net[0][0], hi: net[0][1], prefix: fmt6(net[0][0]) + '/' + len, src: (a.src || []).map((x) => x.slice()) });
      });
      addrs.sort((x, y) => U.natural(x.dev, y.dev) || U.natural(x.ep, y.ep) || cmpBig(x.n, y.n));
      v6facts = { addrs, owned: new Set(addrs.map((a) => a.n)), nets: addrs.map((a) => [a.lo, a.hi]) };
      return v6facts;
    }
    const inNets6 = (n, nets) => nets.some(([lo, hi]) => n >= lo && n <= hi);
    /** IPv6 的外部來源：這台設備 IPv6 規則的 src-address 與 /ip service 的 available-from 切出的區段（同 extSources），每段取一個全球單播、不在基準網段的位址。 */
    function extSources6(dev, max) {
      const b = new Set([0n, 1n << 128n]);
      const add = (text) => {
        if (text === undefined) return;
        const p = F.parseVal('src-address', F.splitNeg(text).body);
        if (p.kind === 'ranges' && p.bits === 128) p.items.forEach(([x, y]) => { b.add(x); b.add(y + 1n); });
      };
      m.firewallRules.forEach((r) => { if (r.family === 'ipv6' && r.dev === dev) add(r.match['src-address']); });
      Q.ipServicesOf(dev).forEach((sv) => sv.addresses.forEach(add));
      const arr = Array.from(b).sort(cmpBig);
      const nets = v6Facts().nets;
      const outside = (n) => EXT6_CLASSES.has(IP.classify(fmt6(n))) && !inNets6(n, nets);
      const cands = EXTERNAL6_CANDIDATES.map((c) => range6(c)[0][0]);
      const primary = cands.find(outside);
      const atoms = [];
      for (let i = 0; i + 1 < arr.length; i++) {
        const lo = arr[i]; const hi = arr[i + 1] - 1n;
        const a = lo > GUA_LO ? lo : GUA_LO; const z = hi < GUA_HI ? hi : GUA_HI;
        if (a > z) continue;
        const rep = repInRange(a, z, cands, a + (z - a) / 2n, outside);
        if (rep !== undefined) atoms.push({ n: rep, ip: fmt6(rep), range: [fmt6(lo), fmt6(hi)], primary: rep === primary });
      }
      atoms.sort((x, y) => (y.primary ? 1 : 0) - (x.primary ? 1 : 0) || cmpBig(x.n, y.n));
      return { list: atoms.slice(0, max), total: atoms.length, truncated: atoms.length > max };
    }
    /** LAN 側網段內的目的：這台設備 IPv6 規則的 dst-address 在網段內切出的區段，每段取一個不屬於設備的位址（略過網段的第一個位址：subnet-router anycast）。 */
    function targets6(dev, net) {
      const b = new Set([net.lo, net.hi + 1n]);
      m.firewallRules.forEach((r) => {
        if (r.family !== 'ipv6' || r.dev !== dev || r.table !== 'filter' || r.match['dst-address'] === undefined) return;
        const p = F.parseVal('dst-address', F.splitNeg(r.match['dst-address']).body);
        if (p.kind === 'ranges' && p.bits === 128) p.items.forEach(([x, y]) => { if (x > net.lo && x <= net.hi) b.add(x); if (y >= net.lo && y < net.hi) b.add(y + 1n); });
      });
      const arr = Array.from(b).sort(cmpBig); const owned = v6Facts().owned; const out = [];
      for (let i = 0; i + 1 < arr.length; i++) {
        const lo = arr[i]; const hi = arr[i + 1] - 1n;
        let rep = null;
        for (let n = lo === net.lo && hi > lo ? lo + 1n : lo, c = 0; n <= hi && c < 64; n++, c++) if (!owned.has(n)) { rep = n; break; }
        if (rep !== null) out.push({ n: rep, ip: fmt6(rep), range: [fmt6(lo), fmt6(hi)], whole: lo === net.lo && hi === net.hi });
      }
      return out;
    }
    const rc6 = (dev, d) => d.uncertain.map((u) => reason('rule-condition', dev, `${where(u.rule)}（IPv6）的條件 ${U.uniq(u.keys).join('、')} 無法判斷：${U.uniq(u.keys.map(keyWhy)).join('；')}`, { rule: ref(u.rule), keys: U.uniq(u.keys) }));
    /**
     * 一個 IPv6 組合的判斷：{ verdict, reasons, decisive（同 summary 的 decisive，給 rowFindings）, rule（決定的過濾規則或預設） }。
     * ICMP 的服務以 ICMPv6（protocol icmpv6）比對。input 放行之後再看 /ip service（停用或 available-from 不含來源就是拒絕）。
     */
    function eval6(dev, inEp, outEp, chain, svc, src, dst, noFw) {
      const ctx = I.ctxOf(dev);
      const pkt = { family: 'ipv6', reach: true, in: inEp, out: chain === 'input' ? null : outEp, protocol: svc.proto === 'icmp' ? 'icmpv6' : svc.proto, dstPort: svc.port, srcPort: null,
        src, dst, srcLocal: false, dstLocal: chain === 'input', state: 'new', natState: null, ipsec: devInfo(dev).ipsec ? null : 'none' };
      const decisive = new Map();
      const pick = (d, table, ch) => decisive.set(d.rule ? d.rule.key : `policy:${dev}|${table}|${ch}`, { key: d.rule ? d.rule.key : null, dev, table, chain: ch, policy: !d.rule, verdict: d.verdict });
      const out = (verdict, reasons, rule) => ({ verdict, reasons, decisive, rule });
      if (ctx.chain('ipv6', 'raw', 'prerouting').length) {
        const d = F.decide(ctx, 'ipv6', 'raw', 'prerouting', Object.assign({}, pkt, { out: undefined }));
        if (!d.decided) return out('unknown', rc6(dev, d), null);
        if (d.verdict === 'drop') { pick(d, 'raw', 'prerouting'); return out('deny', [], d.rule); }
        if (d.verdict === 'notrack') pkt.state = 'untracked';
      }
      const d = F.decide(ctx, 'ipv6', 'filter', chain, pkt);
      if (!d.decided) return out('unknown', rc6(dev, d), null);
      pick(d, 'filter', chain);
      if (d.verdict === 'drop') return out('deny', [], d.rule);
      const reasons = noFw ? [reason('no-ipv6-firewall', dev, `${name(dev)} 沒有 IPv6 的過濾規則（/ipv6 firewall filter），IPv6 的 ${chain} 預設放行`)] : [];
      if (chain === 'input' && svc.proto === 'tcp' && svc.port != null) {
        const sv = Q.ipServicesOf(dev).find((x) => x.port === svc.port);
        if (sv && !sv.enabled) return out('deny', [], d.rule);
        if (sv && sv.addresses.length) {
          const rs = sv.addresses.map((a) => F.parseVal('src-address', a));
          if (rs.some((p) => p.kind === 'ranges' && p.bits === 128 && p.items.some(([a, b]) => src >= a && src <= b))) return out('allow', reasons, d.rule);
          if (rs.every((p) => p.kind === 'ranges')) return out('deny', [], d.rule);
          return out('unknown', [reason('service-unknown', dev, `${name(dev)} 的 ${sv.name} 服務的 available-from（${sv.addresses.join('、')}）無法解析，是否接受 IPv6 來源無法判斷`)], d.rule);
        }
      }
      return out('allow', reasons, d.rule);
    }
    /**
     * 暴露清單的 IPv6 列：{ info（ipv6 欄）, self, routed（列與計數，併進同名的段）, evaluations, truncated }。
     * entries：WAN 入口；services：候選服務；budget：剩下的判斷次數。
     */
    function exposure6(entries, services, maxSrc, budget) {
      const used = ipv6Devices();
      const f = v6Facts();
      const fz = new Map((m.firewallZones || []).map((z) => [z.dev, z]));
      const sec = () => ({ rows: [], counts: { candidates: 0, allow: 0, unknown: 0, deny: 0, natted: 0, notEvaluated: 0 } });
      const res = { self: sec(), routed: sec(), evaluations: 0, truncated: false };
      const devs = U.uniq(entries.map((w) => w.dev)).sort(U.natural);
      const evaluated = []; const missing = [];
      const combos = new Map();
      for (const dev of devs) {
        const z = fz.get(dev);
        if (z && z.ipv6 && z.ipv6.status === 'disabled') { missing.push({ dev, reason: 'disabled' }); continue; }
        const own = f.addrs.filter((a) => a.dev === dev && !linkLocal6(a.n));
        if (!own.length) { if (z && z.ipv6 && z.ipv6.status === 'used') missing.push({ dev, reason: 'no-address' }); continue; }
        evaluated.push(dev);
        const wanEps = entries.filter((w) => w.dev === dev).map((w) => w.ep);
        const noFw = !m.firewallRules.some((r) => r.dev === dev && r.family === 'ipv6' && r.table === 'filter' && !r.disabled);
        const srcs = extSources6(dev, maxSrc);
        const selfIps = U.uniq(own.map((a) => a.n)).sort(cmpBig);
        const lans = own.filter((a) => !wanEps.includes(a.ep) && a.len < 128).filter((a, i, l) => l.findIndex((x) => x.prefix === a.prefix) === i);
        const jobs = selfIps.map((n) => ({ sec: 'self', n, ip: fmt6(n), chain: 'input', out: null }))
          .concat(lans.flatMap((a) => targets6(dev, a).map((t) => ({ sec: 'routed', n: t.n, ip: t.ip, chain: 'forward', out: a.ep, subnet: a.prefix, range: t.range, whole: t.whole }))));
        for (const j of jobs) {
          for (const svc of services) {
            const c = U.getOr(combos, [j.sec, dev, j.ip, svc.id].join('\u0000'), () => ({ dev, job: j, svc, srcs, noFw, evals: [] }));
            for (const ep of wanEps) {
              for (const a of srcs.list) {
                if (res.evaluations >= budget) { res.truncated = true; break; }
                res.evaluations++;
                c.evals.push(Object.assign({ src: a, ep }, eval6(dev, ep, j.out, j.chain, svc, a.n, j.n, noFw)));
              }
            }
          }
        }
      }
      combos.forEach((c) => {
        const s = res[c.job.sec];
        // 判斷次數上限用完、一次都沒有判斷到的組合：另計（notEvaluated），不算候選，也不算拒絕
        if (!c.evals.length) { s.counts.notEvaluated++; return; }
        s.counts.candidates++;
        const vs = c.evals.map((e) => e.verdict);
        const verdict = vs.includes('allow') ? 'allow' : vs.includes('unknown') ? 'unknown' : 'deny';
        s.counts[verdict]++;
        if (verdict === 'deny') return;
        const hit = c.evals.filter((e) => e.verdict === verdict);
        const ok = new Set(hit.map((e) => e.src.n));
        const okSrc = c.srcs.list.filter((x) => ok.has(x.n));
        const any = okSrc.length === c.srcs.list.length && !c.srcs.truncated;
        const allowedFrom = any ? { kind: 'any', ranges: [], text: '任何外部位址' }
          : { kind: 'limited', ranges: okSrc.map((x) => x.range.slice()), text: okSrc.map((x) => (x.range[0] === x.range[1] ? x.range[0] : `${x.range[0]}–${x.range[1]}`)).join('、') + (c.srcs.truncated ? '（外部區段超過上限，只列出前面的）' : '') };
        const first = hit.find((e) => e.src.primary) || hit[0];
        const ipSvc = c.job.sec === 'self' && c.svc.proto === 'tcp' ? Q.ipServicesOf(c.dev).find((x) => x.port === c.svc.port) : null;
        const mg = c.job.sec === 'self' ? mgmtPorts(c.dev).find((x) => x.proto === c.svc.proto && x.port === c.svc.port) : null;
        const ifc = Q.getInterface(first.ep);
        const r = first.rule;
        const rule = r ? Object.assign({ verdict: 'accept' }, ref(r)) : first.decisive.size ? { key: null, dev: c.dev, table: 'filter', chain: c.job.chain, policy: true, route: null, verdict: 'accept' } : null;
        const row = { family: 'ipv6', dev: c.dev, entries: U.uniq(hit.map((e) => e.ep)).sort(U.natural), entry: first.ep, inInterface: ifc ? ifc.name : K.splitEp(first.ep)[1], src: first.src.ip,
          dst: c.job.ip, ip: c.job.ip, vrf: K.MAIN_VRF, serviceName: ipSvc ? ipSvc.name : mg ? mg.name : null,
          // routed：決定的放行沒有限制目的位址（或預設放行）時，整個區段（沒有規則切開時就是整個網段）的主機都暴露
          dstAny: c.job.sec === 'routed' && (!r || (r.match['dst-address'] === undefined && r.match['dst-address-list'] === undefined)),
          findingKeys: rowFindings(c.dev, { decisive: first.decisive }, ipSvc ? ipSvc.name : null, mg),
          service: c.svc.id, proto: c.svc.proto, port: c.svc.port, portRange: c.svc.range, verdict, allowedFrom, rule,
          reasons: U.uniq(hit.flatMap((e) => e.reasons.map((x) => x.code))).sort(U.cmp), returnUnsafe: [], incomplete: verdict === 'allow' && vs.includes('unknown'),
          target: c.job.sec === 'self' ? c.dev : c.job.subnet, zone: c.job.sec === 'self' ? SELF_ZONE : null,
          // 分層結果：IPv6 不做路由（route 為 null），只有防火牆層；列只有允許與不明，沒有擋下的規則
          route: null, filter: { status: first.verdict, rule: null, reasons: dedupeReasons(first.reasons) } };
        if (c.job.sec === 'routed') Object.assign(row, { subnet: c.job.subnet, dstRange: c.job.range.slice() });
        else row.via = null; // IPv6 只看邊界路由器本身：目的一定是入口設備
        s.rows.push({ row, n: c.job.n });
      });
      const note = '只看邊界路由器：從 WAN 進入時，以 IPv6 的過濾規則（/ipv6 firewall filter 的 input／forward）判斷能到設備本身與它直連的 LAN 側網段；不做 IPv6 路由與 NAT66';
      const name6 = (l) => l.map((x) => name(x.dev)).join('、');
      const noAddr = missing.filter((x) => x.reason === 'no-address');
      res.info = evaluated.length
        ? { status: 'edge-only', message: note + (noAddr.length ? `；${name6(noAddr)} 在用 IPv6，但基準中沒有它的 IPv6 位址（/ipv6 address），未判斷` : ''), devices: used, evaluated, missing }
        : { status: 'no-ipv6-address', message: `基準中沒有 WAN 入口設備的 IPv6 位址（/ipv6 address），無法判斷從 WAN 進來的 IPv6 能到哪裡${noAddr.length ? `（${name6(noAddr)} 在用 IPv6）` : ''}；${note}`, devices: used, evaluated, missing };
      return res;
    }
    /** 預設的判斷次數上限（入口 × 外部區段 × 目的 × 服務）；超過時其餘組合不算，結果標 truncated。 */
    const EXPOSURE_MAX_EVALS = 400000;
    const EXPOSURE_MAX_SOURCES = 16;
    /**
     * 暴露清單的分段計算（generator，yield { stage: 'prepare'|'evaluate'|'summary', done, total }）；回傳值與 exposure(opts) 相同，並寫進快取。
     * opts：Q.zones 的參數，另加 maxEvaluations（判斷次數上限）、maxSources（外部區段數上限）。
     */
    function* exposureSteps(opts) {
      const o = opts || {};
      const zs = zones(o); zs.optsRaw = o;
      const maxEvals = o.maxEvaluations == null ? EXPOSURE_MAX_EVALS : o.maxEvaluations;
      const maxSrc = o.maxSources == null ? EXPOSURE_MAX_SOURCES : o.maxSources;
      if (!Number.isInteger(maxEvals) || maxEvals < 1) throw new TypeError('maxEvaluations 必須是正整數');
      if (!Number.isInteger(maxSrc) || maxSrc < 1) throw new TypeError('maxSources 必須是正整數');
      const ck = JSON.stringify([zs.opts.profHash, zs.opts.sources, maxEvals, maxSrc]);
      if (exposureCache.has(ck)) return exposureCache.get(ck);
      yield { stage: 'prepare', done: 0, total: 1 };
      bounds();
      const entries = l4Entries();
      // IPv6 只看邊界路由器（exposure6）；沒有 WAN 入口時不判斷
      const ipv6 = { status: 'no-wan', message: '沒有可辨識的 WAN 入口，IPv6 從 WAN 進來能到哪裡也無法判斷', devices: ipv6Devices(), evaluated: [], missing: [] };
      const emptySec = () => ({ rows: [], counts: { candidates: 0, allow: 0, unknown: 0, deny: 0, natted: 0, notEvaluated: 0 } });
      // 拒絕依層級分開（合計等於 denied 的同一段）：noRoute 路由沒到、filter 防火牆擋下（含 IPv6）、notNatted dst-nat 寫明的位址但這個服務沒有被改寫
      const emptyDenied = () => ({ noRoute: 0, filter: 0, notNatted: 0 });
      // noWan：有防火牆規則卻判斷不出 WAN 的設備（F08）；noFirewall：已收集、有預設路由（推論：可能是邊界路由器）卻沒有 /export 的網路設備
      const noWan = Q.findingsByRule('F08').map((f) => ({ dev: Q.findingDevice(f), findingKey: Q.findingKey(f) })).sort((a, b) => U.natural(a.dev || '', b.dev || ''));
      const noFirewall = Q.devices().filter((d) => devInfo(d.key).collected && !devInfo(d.key).host && !devInfo(d.key).config && Q.routesOf(d.key).some((r) => r.len === 0 && !r.blackhole))
        .map((d) => d.key).sort(U.natural);
      const base = { ok: true, noWan, noFirewall, wan: { entries: entries.map((w) => ({ dev: w.dev, ep: w.ep, vrf: w.vrf })), devices: U.uniq(entries.map((w) => w.dev)).sort(U.natural) }, ipv6, assumptions: EXPOSURE_ASSUMPTIONS };
      const extIp = entries.length ? externalRep() : null;
      const finishEarly = (status, message) => {
        const out = deepFreeze(JSON.parse(JSON.stringify(Object.assign({ status, message, external: null, services: [], self: emptySec(), dnat: emptySec(), routed: emptySec(),
          limits: { evaluations: 0, maxEvaluations: maxEvals, truncated: false }, denied: { self: 0, dnat: 0, routed: 0 },
          deniedBy: { self: emptyDenied(), dnat: emptyDenied(), routed: emptyDenied() } }, base))));
        exposureCache.set(ck, out); return out;
      };
      if (!entries.length) return finishEarly('no-wan', '沒有可辨識的對外入口：有 /export 的設備都沒有對外的介面（名稱含 WAN、成員不為空的 interface list，或預設路由、NAT 上網、連接埠轉送等強證據，見對外邊界），無法判斷從外部進得來什麼');
      if (!extIp) base.ipv6 = { status: 'not-evaluated', message: 'IPv4 的外部代表位址不可用，暴露清單沒有計算，IPv6 也沒有判斷', devices: ipv6.devices, evaluated: [], missing: [] };
      if (!extIp) return finishEarly('no-external-address', `外部的代表位址（${EXTERNAL_CANDIDATES.join('、')}）都在基準的網段內或屬於設備，無法代表基準以外的位址`);
      const entryDevs = new Set(entries.map((w) => w.dev));
      const srcsOf = new Map(Array.from(entryDevs).sort(U.natural).map((d) => [d, extSources([d], extIp, maxSrc)]));
      // 經其他入口連到設備本身：外部來源依入口設備與目的設備兩台的規則切區段（目的設備的 input 也可能限制來源）
      const pairSrcs = new Map();
      const srcsFor = (ed, td) => (ed === td ? srcsOf.get(ed) : U.getOr(pairSrcs, ed + '\u0000' + td, () => extSources([ed, td], extIp, maxSrc)));
      const services = exposureServices(entries);
      // 目的（各在入口的 VRF）：入口設備自己的位址與 dst-nat 寫明的 dst-address → self／dnat；內部網段的代表位址（矩陣的 repsOf） → routed
      // front：從外部看得到的入口位址（入口介面上的位址與 dst-nat 寫明的 dst-address；dst-nat 規則不分 VRF），dst-nat 只在這些位址列進 dnat；
      // 設備其他介面的位址只看 input（經 dst-nat 改寫的計入 natted，同一條 dst-nat 已在 dnat 以入口位址列出）。
      // self 段只有 main VRF 的入口（設備的服務在 main，見 l4Entries）：非 main 的入口只列 dnat
      const own = new Map(); const front = new Set();
      const devVrf = (d, v) => d + '\u0000' + v;
      U.uniq(entries.map((w) => devVrf(w.dev, w.vrf))).forEach((dv) => {
        const [d, v] = dv.split('\u0000');
        const list = [];
        const wanSet = new Set(entries.filter((w) => w.dev === d && w.vrf === v).map((w) => w.ep));
        Q.interfacesOf(d).forEach((i) => ownIps(i.key).forEach((a) => {
          if (K.vrf(a.vrf) !== v || !IP.isIp(a.ip)) return;
          if (!list.includes(a.ip)) list.push(a.ip);
          if (wanSet.has(i.key)) front.add(dv + '|' + a.ip);
        }));
        m.firewallRules.forEach((r) => {
          if (r.dev !== d || r.family !== 'ip' || r.table !== 'nat' || r.disabled || r.action !== 'dst-nat' || r.match['dst-address'] === undefined) return;
          const { neg, body } = F.splitNeg(r.match['dst-address']); const ip = neg ? null : single(body.replace(/\/32$/, ''));
          if (!ip) return;
          if (!list.includes(ip)) list.push(ip);
          front.add(dv + '|' + ip);
        });
        own.set(dv, list.sort((a, b) => intOf(a) - intOf(b)));
      });
      const reps = repsOf(zs);
      const repsByVrf = new Map(); reps.forEach((list) => list.forEach((r) => U.getOr(repsByVrf, r.vrf, () => []).push(r)));
      repsByVrf.forEach((list) => list.sort((a, b) => intOf(a.ip) - intOf(b.ip)));
      const jobs = [];
      entries.forEach((w) => own.get(devVrf(w.dev, w.vrf)).forEach((ip) => jobs.push({ kind: 'edge', w, ip })));
      entries.forEach((w) => (repsByVrf.get(w.vrf) || []).forEach((r) => jobs.push({ kind: 'routed', w, ip: r.ip, rep: r })));
      // 經 main 的入口連到網路設備本身（self 段，與矩陣「外部 → 網路設備（管理）」的目的相同，virtualOf 的 selfDst）：
      // 入口設備自己在 main 的位址已由上面的 edge 判斷；其餘（其他設備的管理位址、入口設備在其他 VRF 的閘道位址、從別的入口連到入口設備）在這裡判斷，排在最後
      // （判斷次數用完時先截掉這些）。service 依矩陣的等價類（devClasses）先以類的第一個 service 判斷，拒絕時同類都是拒絕；不是拒絕時同類逐一判斷（列與 Q.reach 相同）
      const covered = new Set(); entries.forEach((w) => { if (w.vrf === K.MAIN_VRF) own.get(devVrf(w.dev, w.vrf)).forEach((ip) => covered.add(devVrf(w.dev, K.MAIN_VRF) + '|' + ip)); });
      const mainEntries = entries.filter((w) => w.vrf === K.MAIN_VRF);
      const selfDst = virtualOf(reps).selfDst.filter((t) => IP.isIp(t.ip)); // IPv4 的判斷（IPv6 見 exposure6）
      selfDst.forEach((t) => mainEntries.forEach((w) => {
        if (w.dev === t.dev && covered.has(devVrf(t.dev, t.vrf) + '|' + t.ip)) return;
        jobs.push({ kind: 'via', w, ip: t.ip, t });
      }));
      const classes = svcClasses(services);
      const classMemo = new Map();
      const classesOf = (dev) => U.getOr(classMemo, dev, () => devClasses(classes, services, dev));
      // 進度的總數：via 以每個等價類判斷一次估計（經別台入口設備時只算代表位址；不是拒絕時另外判斷的，總數隨之增加）
      let total = jobs.reduce((n, j) => n + (j.kind === 'via' ? (j.w.dev === j.t.dev ? srcsFor(j.w.dev, j.t.dev).list.length : 1) * classesOf(j.t.dev).length : srcsOf.get(j.w.dev).list.length * services.length), 0);
      yield { stage: 'prepare', done: 1, total: 1 };
      // 每個（區段, 目的設備, 目的, 服務）一個組合，跨入口與外部區段合併
      const combos = new Map();
      const comboOf = (sec, dev, vrf, ip, svc, extra) => U.getOr(combos, [sec, dev, vrf, ip, svc.id].join('\u0000'), () => Object.assign({ sec, dev, vrf, ip, svc, evals: [] }, extra));
      let done = 0; let truncated = false;
      yield { stage: 'evaluate', done, total };
      const due = slicer();
      /** 經入口 w 的一次判斷（每一列的那一個判斷都是它，與 Q.reach(src, ip, { proto, port, entry }) 相同）。 */
      const evalOne = (a, ip, svc, w, srcs) => {
        const { b, sum } = evaluate(a.ip, ip, svc, 'exact', null, w.ep, w.vrf);
        const reasons = sum.verdict === 'unknown' ? U.uniq(sum.reasons.map((x) => x.code)) : [];
        return { src: a, ep: w.ep, edev: w.dev, srcs, verdict: sum.verdict, sum, b, reasons };
      };
      // 設備本身的目的只算真的送到那台設備那個位址的（同矩陣的 record：dst-nat 改寫、或重疊位址在入口的 VRF 送達別處時不算）
      const reachesT = (sum, t, wv) => !sum.final || (sum.final.dst === t.ip && (sum.final.vrf || wv) === t.vrf);
      outer: for (const j of jobs) {
        if (j.kind === 'via') {
          const srcs = srcsFor(j.w.dev, j.t.dev);
          // 外部區段：目的就是入口設備時逐一判斷；經別台入口設備時先以矩陣的代表位址（primary）判斷（同矩陣只用代表位址），不是拒絕才判斷其他區段（允許的列與 Q.reach 相同、allowedFrom 完整）
          const cross = j.w.dev !== j.t.dev;
          const prim = srcs.list.find((a) => a.primary) || srcs.list[0];
          const order = cross ? [prim].concat(srcs.list.filter((a) => a !== prim)) : srcs.list;
          for (const g of classesOf(j.t.dev)) {
            let open = !cross;
            for (const a of order) {
              if (!open && a !== prim) break;
              if (done >= maxEvals) { truncated = true; break outer; }
              done++; if (a !== prim && cross) total++;
              const ev0 = evalOne(a, j.ip, services[g[0]], j.w, srcs);
              if (!reachesT(ev0.sum, j.t, j.w.vrf)) continue;
              if (a === prim && ev0.verdict !== 'deny') open = true;
              for (const si of g) {
                let ev = ev0;
                if (si !== g[0]) {
                  if (ev0.verdict === 'deny') ev = Object.assign({}, ev0, { shared: true }); // 同類的 service 結果相同（矩陣的等價類）：拒絕不再逐一判斷，也不列出
                  else { if (done >= maxEvals) { truncated = true; break outer; } done++; total++; ev = evalOne(a, j.ip, services[si], j.w, srcs); if (!reachesT(ev.sum, j.t, j.w.vrf)) continue; }
                }
                comboOf('self', j.t.dev, j.t.vrf, j.ip, services[si], {}).evals.push(ev);
              }
              if (due() && done < total) yield { stage: 'evaluate', done, total };
            }
          }
          continue;
        }
        for (const svc of services) {
          for (const a of srcsOf.get(j.w.dev).list) {
            if (done >= maxEvals) { truncated = true; break outer; }
            done++;
            const wv = j.w.vrf;
            const ev = evalOne(a, j.ip, svc, j.w, srcsOf.get(j.w.dev));
            const { sum, reasons } = ev;
            if (j.kind === 'edge') {
              const natUnknown = reasons.some((c) => NAT_UNKNOWN.has(c));
              const isOwn = ownerDev(j.ip, wv) === j.w.dev;
              const isFront = front.has(devVrf(j.w.dev, wv) + '|' + j.ip);
              const selfOk = wv === K.MAIN_VRF;
              if ((sum.nat || natUnknown) && isFront) comboOf('dnat', j.w.dev, wv, j.ip, svc, {}).evals.push(ev);
              else if (sum.nat || natUnknown) { if (selfOk) comboOf('self', j.w.dev, wv, j.ip, svc, {}).evals.push(Object.assign(ev, { natted: true })); }
              else if (isOwn) { if (selfOk) comboOf('self', j.w.dev, wv, j.ip, svc, {}).evals.push(ev); }
              else comboOf('dnat', j.w.dev, wv, j.ip, svc, {}).evals.push(Object.assign(ev, { verdict: 'deny', forced: true })); // dst-nat 寫明的位址、這個服務沒有被改寫：不算進得來
            } else comboOf('routed', j.w.dev, j.w.vrf, j.ip, svc, { rep: j.rep }).evals.push(sum.nat || ev.reasons.some((c) => NAT_UNKNOWN.has(c)) ? Object.assign(ev, { natted: true }) : ev);
            if (due() && done < total) yield { stage: 'evaluate', done, total };
          }
        }
      }
      yield { stage: 'summary', done, total };
      const secs = { self: emptySec(), dnat: emptySec(), routed: emptySec() };
      const deniedBy = { self: emptyDenied(), dnat: emptyDenied(), routed: emptyDenied() };
      const fmt = (ip, pt) => ip + (pt != null ? ':' + pt : '');
      const ruleOf = (sum) => {
        const ds = Array.from(sum.decisive.values());
        const pick = ds.find((x) => x.key && x.table === 'filter') || ds.find((x) => x.key) || ds[0] || null;
        if (!pick) return null;
        return pick.key ? Object.assign({ verdict: pick.verdict }, ref(Q.getFirewallRule(pick.key))) : { key: null, dev: pick.dev, table: pick.table, chain: pick.chain, policy: !!pick.policy, route: pick.route || null, verdict: pick.verdict };
      };
      const egressBack = (e) => {
        const fin = e.sum.final;
        if (!e.sum.nat || !fin || !IP.isIp(fin.dst) || IP.classify(fin.dst) === 'public') return false;
        const ps = pathsOf(e.b).paths;
        return ps.length > 0 && ps.every((p) => p.route.code === 'egress-wan');
      };
      combos.forEach((c) => {
        const sec = secs[c.sec]; sec.counts.candidates++;
        // 經 dst-nat 改寫的組合（不是這一段的路徑）：只計數，結果在 dnat 段以入口位址列出
        const evs = c.evals.filter((e) => !e.natted);
        if (!evs.length) { sec.counts.natted++; return; }
        // dst-nat 改寫後的目的是私有位址、每條路徑都經對外介面送回外部（route.code egress-wan）：連不到基準內，不是暴露，算路由沒到（同檢查的 R09，checks.js 的 dnatTarget 的 external）
        if (c.sec === 'dnat') c.evals = evs.map((e) => (e.verdict !== 'deny' && !e.forced && egressBack(e) ? Object.assign({}, e, { verdict: 'deny', egressBack: true }) : e));
        else c.evals = evs;
        const vs = c.evals.map((e) => e.verdict);
        const verdict = vs.includes('allow') ? 'allow' : vs.includes('unknown') ? 'unknown' : 'deny';
        sec.counts[verdict]++;
        if (verdict === 'deny') {
          const real = c.evals.filter((e) => !e.forced);
          deniedBy[c.sec][!real.length ? 'notNatted' : real.every((e) => e.egressBack || deniedByOf(e.sum) === 'noRoute') ? 'noRoute' : 'filter']++;
          return;
        }
        const hit = c.evals.filter((e) => e.verdict === verdict);
        // 列的那一個判斷：目的設備自己的入口優先（via 為 null），其次矩陣的代表位址所在的外部區段，再依判斷的順序（入口、外部區段）
        const own0 = hit.filter((e) => e.edev === c.dev); const pool = own0.length ? own0 : hit;
        const first = pool.find((e) => e.src.primary) || pool[0];
        // 允許的來源：每個外部區段在同一台入口設備任一入口的結果（外部區段依入口設備切，不同入口設備的區段不能合併）；全部區段都允許（且沒有截斷）就是 any
        const srcs = first.srcs;
        const bySrc = new Map(); c.evals.forEach((e) => { if (e.srcs !== srcs) return; const k = e.src.ip; const v = bySrc.get(k); if (!v || e.verdict === 'allow' || (e.verdict === 'unknown' && v.verdict === 'deny')) bySrc.set(k, e); });
        const okSrc = srcs.list.filter((s) => bySrc.has(s.ip) && bySrc.get(s.ip).verdict === verdict);
        const any = okSrc.length === srcs.list.length && !srcs.truncated;
        const allowedFrom = any ? { kind: 'any', ranges: [], text: '任何外部位址' }
          : { kind: 'limited', ranges: okSrc.map((s) => s.range.slice()), text: okSrc.map((s) => (s.range[0] === s.range[1] ? s.range[0] : `${s.range[0]}–${s.range[1]}`)).join('、') + (srcs.truncated ? '（外部區段超過上限，只列出前面的）' : '') };
        const ipSvc = c.sec === 'self' && c.svc.proto === 'tcp' ? Q.ipServicesOf(c.dev).find((x) => x.port === c.svc.port) : null;
        const mg = c.sec === 'self' ? mgmtPorts(c.dev).find((x) => x.proto === c.svc.proto && x.port === c.svc.port) : null;
        const ifc = Q.getInterface(first.ep);
        const sum = first.sum;
        // 回程不保證（推論）：列的那一個判斷（first，與 Q.reach(src, ip, { entry }) 相同）路徑上的跳
        const unsafe = verdict === 'allow' ? unsafeOfSum(sum) : [];
        const row = { family: 'ipv4', dev: c.dev, entries: U.uniq(hit.map((e) => e.ep)).sort(U.natural), entry: first.ep, inInterface: ifc ? ifc.name : K.splitEp(first.ep)[1], src: first.src.ip,
          dst: K.inVrf(c.ip, c.vrf), ip: c.ip, vrf: c.vrf, serviceName: ipSvc ? ipSvc.name : mg ? mg.name : null, dstAny: false,
          findingKeys: rowFindings(c.dev, first.sum, ipSvc ? ipSvc.name : null, mg),
          service: c.svc.id, proto: c.svc.proto, port: c.svc.port, portRange: c.svc.range, verdict, allowedFrom, rule: ruleOf(sum),
          reasons: verdict === 'unknown' ? U.uniq(hit.flatMap((e) => e.reasons)).sort(U.cmp) : unsafe.length ? [unsafeReason(unsafe[0]).code] : [],
          returnUnsafe: unsafe.map((x) => ({ dev: x.dev, chain: x.chain, rule: x.rule, interfaces: x.interfaces ? x.interfaces.slice() : null })),
          incomplete: verdict === 'allow' && vs.includes('unknown') };
        // 分層結果（同 Q.reach(src, ip, { proto, port, entry }) 的 paths[] 彙整，rowLayers）：這一列的那一個判斷（first）
        Object.assign(row, rowLayers(first.verdict, pathsOf(first.b).paths));
        const fin = sum.final;
        const finIp = fin && fin.dst ? fin.dst : null; const finVrf = (fin && fin.vrf) || c.vrf;
        // via：目的設備就是入口設備時為 null；否則是這一列經由的入口（與 entry 相同，看路徑用 src、entry）
        if (c.sec === 'self') { row.target = c.dev; row.zone = SELF_ZONE; row.via = first.edev === c.dev ? null : { dev: first.edev, ep: first.ep }; }
        else {
          const tIp = c.sec === 'routed' ? c.ip : finIp;
          const z = tIp ? zoneOf(tIp, o, finVrf) : null;
          const od = tIp ? ownerDev(tIp, finVrf) : null;
          row.target = od && netDev(od) ? od : z ? z.key : null; row.zone = z ? z.zone : null;
          if (c.sec === 'dnat') {
            const natRule = Array.from(sum.decisive.values()).find((x) => x.key && x.table === 'nat');
            const nr = natRule ? Q.getFirewallRule(natRule.key) : null;
            row.nat = { from: fmt(c.ip, c.svc.port), to: finIp ? fmt(K.inVrf(finIp, finVrf), fin.port) : null, rule: nr ? ref(nr) : null };
            row.dstAny = !!nr && nr.match['dst-address'] === undefined && nr.match['dst-address-list'] === undefined; // dst-nat 沒限制目的位址：任何送到入口的目的都會改寫
          } else if (sum.nat) row.nat = { from: fmt(c.ip, c.svc.port), to: finIp ? fmt(K.inVrf(finIp, finVrf), fin.port) : null, rule: null };
          if (c.sec === 'routed') row.subnet = c.rep.subnet;
        }
        sec.rows.push(row);
      });
      // IPv6（只看邊界路由器）：列併進 self／routed（family 'ipv6'），判斷次數與 IPv4 共用上限
      // IPv6 不分 VRF（只看 main 的入口）
      const v6 = exposure6(entries.filter((w) => w.vrf === K.MAIN_VRF), services, maxSrc, Math.max(0, maxEvals - done));
      done += v6.evaluations; if (v6.truncated) truncated = true;
      base.ipv6 = v6.info;
      const n6 = new Map();
      ['self', 'routed'].forEach((k) => {
        v6[k].rows.forEach((x) => { n6.set(x.row, x.n); secs[k].rows.push(x.row); });
        Object.keys(v6[k].counts).forEach((c) => { secs[k].counts[c] += v6[k].counts[c]; });
        deniedBy[k].filter += v6[k].counts.deny; // IPv6 只看防火牆（不做 IPv6 路由）
      });
      const PO = new Map(services.map((s, i) => [s.id, i]));
      // 入口設備的列在前（self 段另有經入口連到的其他設備）→ 設備 → 位址族（IPv4 在前）→ 位址 → VRF → 服務
      const byIp = (a, b) => (a.family !== b.family ? (a.family === 'ipv4' ? -1 : 1) : a.family === 'ipv4' ? intOf(a.ip) - intOf(b.ip) : cmpBig(n6.get(a), n6.get(b)));
      const isEntry = (r) => (entryDevs.has(r.dev) ? 0 : 1);
      Object.values(secs).forEach((sec) => sec.rows.sort((a, b) => isEntry(a) - isEntry(b) || U.natural(a.dev, b.dev) || byIp(a, b) || U.cmp(a.vrf, b.vrf) || PO.get(a.service) - PO.get(b.service)));
      if (exposureCache.has(ck)) return exposureCache.get(ck);
      const out = deepFreeze(JSON.parse(JSON.stringify(Object.assign({
        status: 'ok', message: null,
        external: { representative: extIp, byDevice: Array.from(srcsOf, ([dev, x]) => ({ dev, sources: x.list.map((s) => ({ ip: s.ip, range: s.range })), sourceCount: x.total, truncated: x.truncated })) },
        services, self: secs.self, dnat: secs.dnat, routed: secs.routed,
        limits: { evaluations: done, maxEvaluations: maxEvals, truncated },
        denied: { self: secs.self.counts.deny, dnat: secs.dnat.counts.deny, routed: secs.routed.counts.deny }, deniedBy,
      }, base))));
      exposureCache.set(ck, out);
      return out;
    }
    const exposure = (opts) => runAll(exposureSteps(opts));

    Object.assign(E, { exposure, exposureSteps });
  };
})(globalThis.SSOT = globalThis.SSOT || {});
