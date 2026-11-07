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
  const { deepFreeze, SERVICES, SELF_ZONE, EXTERNAL_CANDIDATES, EXTERNAL6_CANDIDATES, EXPOSURE_ASSUMPTIONS, EXPOSURE_MAX_SOURCES, svcId, keyWhy, NAT_UNKNOWN, runAll, slicer } = S.reach._;

  /** E：reach.js 的 base 建立的 engine 物件；加上 exposure、exposureSteps。 */
  S.reach._.exposurePart = function exposurePart(E) {
    const { Q, I, m, F, name, ownerOf, intOf, ownerDev, longest, devInfo, netDev, ref, where, reason, bounds, externalRep, repInRange, single, ownIps, l4Entries, ipv6Devices,
      evaluate, pathsOf, rowLayers, deniedByOf, reachesLocal, unsafeOfSum, unsafeReason, dedupeReasons, zones, zoneOf, repsOf, virtualOf, svcClasses, devClasses, mgmtPorts, deviceServices } = E;

    // ---- 暴露清單（由外而內）：從 WAN 進來，連得到哪些位址、哪些服務（推論，查詢時計算，ADR-014）
    const exposureCache = new Map();
    /**
     * 不會是從 WAN 進來的新連線來源（S.ip.classify）：reserved（0.0.0.0/8「this network」、240.0.0.0/4 與廣播、192.0.0.0/24、198.18.0.0/15）、loopback、multicast。
     * private、cgnat、link-local 仍算（偽造或電信業者那一側的來源可能出現在 WAN）；documentation 是代表位址本身。
     */
    const NOT_EXTERNAL_SRC = new Set(['reserved', 'loopback', 'multicast']);
    const SPECIAL_SRC = (n) => NOT_EXTERNAL_SRC.has(IP.classify(IP.fromInt(n)));
    /** 一台設備的規則（src-address）、/ip service 的 available-from 與 /routing rule 的 src-address 的區段邊界（只依事實，每份基準算一次）。 */
    /*
     * 外部來源的區段邊界的來源（位址集合的登錄表 S.infer.addrSets 的筆；邊界一律由 S.infer.addrBounds 產生，同 reach.js 的等價類）：
     * 這台設備 family 的規則的 src-address 與 src-address-list（完全靜態的清單；可能有動態來源的不切分）、這個位址族的 /ip service available-from，
     * IPv4 另加 /routing rule 的 src-address。只依事實，每台設備、每個位址族算一次。
     */
    let byDevIx = null; const srcEntryMemo = new Map();
    const byDev = () => byDevIx || (byDevIx = {
      rules: m.firewallRules.reduce((o, r) => { U.getOr(o, r.dev, () => []).push(r); return o; }, new Map()),
      routing: (m.routingRules || []).reduce((o, r) => { U.getOr(o, r.dev, () => []).push(r); return o; }, new Map()),
    });
    const srcEntries = (dev, family) => U.getOr(srcEntryMemo, dev + '|' + family, () => {
      const R = I.addrSets(); const es = [];
      (byDev().rules.get(dev) || []).forEach((r) => { if (r.family === family) es.push(R.ofRule(r, 'src-address'), R.ofRule(r, 'src-address-list')); });
      if (family === 'ip') (byDev().routing.get(dev) || []).forEach((r) => es.push(R.ofRoutingRule(r, 'src-address')));
      Q.ipServicesOf(dev).forEach((sv) => es.push(R.service(dev, sv.name, family)));
      return es;
    });
    const srcBounds = new Map();
    const srcBoundsOf = (dev) => U.getOr(srcBounds, dev, () => S.infer.addrBounds(srcEntries(dev, 'ip'), 32).map(Number));
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
    /**
     * 候選服務：預設服務 ∪ 從 WAN 進來的 input／forward 放行規則的 dst-port ∪ dst-nat 的 dst-port ∪ self 段目的設備（selfDevs：入口設備與矩陣「網路設備（管理）」的設備）
     * 自己開著的服務（E.deviceServices：啟用中的 /ip service 與 mgmt 埠，與矩陣相同）。埠範圍取第一個埠當代表，記下範圍。
     */
    function exposureServices(entries, selfDevs) {
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
      selfDevs.forEach((d) => deviceServices(d).forEach((x) => addSvc(x.proto, x.port, x.origin)));
      const PO = ['icmp', 'tcp', 'udp'];
      return Array.from(byId.values()).sort((a, b) => (PO.indexOf(a.proto) + 1 || 9) - (PO.indexOf(b.proto) + 1 || 9) || U.cmp(a.proto, b.proto) || (a.port || 0) - (b.port || 0));
    }
    // 設備的管理服務（mgmtPorts）與開著的服務（deviceServices）在 reach-matrix.js，矩陣與暴露清單共用
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
    const GUA = IP.rangesOf(['public']).map(IP.range).find((r) => r && r[2] === 128);
    const GUA_LO = GUA[0]; const GUA_HI = GUA[1];
    const EXT6_CLASSES = new Set(['public', 'documentation']);
    /** IPv6 的位址、網段或範圍文字 → [lo, hi]（BigInt，S.ip.range）；不是 IPv6 或不合法時 null。 */
    const range6 = (text) => { const r = IP.range(String(text)); return r && r[2] === 128 ? [r[0], r[1]] : null; };
    const fmt6 = IP.v6FromBig;
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
        addrs.push({ dev: a.dev, ep: a.ep, n: one[0], ip: fmt6(one[0]), len, lo: net[0], hi: net[1], net: fmt6(net[0]), prefix: fmt6(net[0]) + '/' + len, src: (a.src || []).map((x) => x.slice()) });
      });
      addrs.sort((x, y) => U.natural(x.dev, y.dev) || U.natural(x.ep, y.ep) || cmpBig(x.n, y.n));
      // nets：基準網段的索引（S.ip.prefixIndex6，依前綴長度分桶），判斷「在不在基準網段」不必逐一掃過
      v6facts = { addrs, owned: new Set(addrs.map((a) => a.n)), nets: IP.prefixIndex6(addrs, 'net') };
      return v6facts;
    }
    const inNets6 = (n, nets) => nets.lookup(n).length > 0;
    /** IPv6 的外部來源：這台設備 IPv6 規則的 src-address 與 /ip service 的 available-from 切出的區段（同 extSources），每段取一個全球單播、不在基準網段的位址。 */
    function extSources6(dev, max) {
      const b = new Set([0n, 1n << 128n]);
      S.infer.addrBounds(srcEntries(dev, 'ipv6'), 128).forEach((x) => b.add(x));
      const arr = Array.from(b).sort(cmpBig);
      const nets = v6Facts().nets;
      const outside = (n) => EXT6_CLASSES.has(IP.classify(fmt6(n))) && !inNets6(n, nets);
      const cands = EXTERNAL6_CANDIDATES.map((c) => range6(c)[0]);
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
      // 邊界同 extSources6：登錄表的 dst-address 字面值（S.infer.addrBounds），只取網段內的
      const R = I.addrSets();
      const es = (byDev().rules.get(dev) || []).filter((r) => r.family === 'ipv6' && r.table === 'filter').map((r) => R.ofRule(r, 'dst-address'));
      S.infer.addrBounds(es, 128).forEach((x) => { if (x > net.lo && x <= net.hi) b.add(x); });
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
        // available-from：登錄表的 set（IPv4 的 serviceOf 與 F07 用同一份；不合法的項目不接受任何來源）
        if (sv && sv.addresses.length) return I.addrSets().service(dev, sv.name, 'ipv6').set.has(src) ? out('allow', reasons, d.rule) : out('deny', [], d.rule);
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
      // 訊息：先寫結論，再寫原因；方法（只看邊界路由器、不做 IPv6 路由與 NAT66）只在有判斷時寫
      const name6 = (l) => l.map((x) => name(x.dev)).join('、');
      const noAddr = missing.filter((x) => x.reason === 'no-address');
      const noAddrText = noAddr.length ? `${name6(noAddr)} 在用 IPv6，但基準中沒有它的 IPv6 位址（/ipv6 address），未判斷。` : '';
      res.info = evaluated.length
        ? { status: 'edge-only', message: `IPv6 只判斷邊界路由器：從 WAN 進入時，依 IPv6 的過濾規則（/ipv6 firewall filter 的 input／forward）判斷能否到達設備本身與它直連的 LAN 側網段，不做 IPv6 路由與 NAT66。${noAddrText}`, devices: used, evaluated, missing }
        : { status: 'no-ipv6-address', message: `IPv6 未判斷：WAN 入口設備${noAddr.length ? ` ${name6(noAddr)} ` : ''}沒有 IPv6 位址的資料（/ipv6 address）。`, devices: used, evaluated, missing };
      return res;
    }
    /**
     * 預設的判斷次數上限（入口 × 外部區段 × 目的 × 服務等價類）；超過時其餘組合不算，結果標 truncated。
     * 約 1000 台（tests/large.js）實測約 8 萬次（同類的拒絕共用之後；之前逐一判斷約 32 萬次），上限約為它的 2.5 倍。
     */
    const EXPOSURE_MAX_EVALS = 200000;
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
      // self 段的目的設備（矩陣「網路設備（管理）」的目的，virtualOf 的 selfDst，只取 IPv4；IPv6 見 exposure6）：先算，候選服務含這些設備開著的服務
      const reps = repsOf(zs);
      const selfDst = virtualOf(reps).selfDst.filter((t) => IP.isIp(t.ip));
      const services = exposureServices(entries, U.uniq(Array.from(entryDevs).concat(selfDst.map((t) => t.dev))).sort(U.natural));
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
      selfDst.forEach((t) => mainEntries.forEach((w) => {
        if (w.dev === t.dev && covered.has(devVrf(t.dev, t.vrf) + '|' + t.ip)) return;
        jobs.push({ kind: 'via', w, ip: t.ip, t });
      }));
      const classes = svcClasses(services);
      const classMemo = new Map(); const subsMemo = new Map();
      const classesOf = (dev) => U.getOr(classMemo, dev, () => devClasses(classes, services, dev));
      // via：每個 svcClasses 的類一組 [子類]（子類依目的設備的 /ip service 分開，同矩陣的 classesFor）
      const subsOf = (dev) => U.getOr(subsMemo, dev, () => classes.map((sis) => devClasses([sis], services, dev)));
      // 進度的總數：每個等價類判斷一次估計（via 經別台入口設備時只算代表位址；不能共用而另外判斷的，總數隨之增加）
      let total = jobs.reduce((n, j) => n + (j.kind === 'via' ? (j.w.dev === j.t.dev ? srcsFor(j.w.dev, j.t.dev).list.length : 1) * subsOf(j.t.dev).length
        : srcsOf.get(j.w.dev).list.length * (j.kind === 'edge' ? classesOf(j.w.dev).length : classes.length)), 0);
      yield { stage: 'prepare', done: 1, total: 1 };
      // 每個（區段, 目的設備, 目的, 服務）一個組合，跨入口與外部區段合併
      const combos = new Map();
      const comboKey = (sec, dev, vrf, ip, svc) => [sec, dev, vrf, ip, svc.id].join('\u0000');
      const comboOf = (sec, dev, vrf, ip, svc, extra) => U.getOr(combos, comboKey(sec, dev, vrf, ip, svc), () => Object.assign({ sec, dev, vrf, ip, svc, evals: [] }, extra));
      let done = 0; let truncated = false;
      yield { stage: 'evaluate', done, total };
      const due = slicer();
      // 一次性的節點快取（evaluate 的 once）：暴露清單的節點鍵（實際來源位址）幾乎不重複，算完就丟，不留在 engine
      const once = {};
      /** 經入口 w 的一次判斷（每一列的那一個判斷都是它，與 Q.reach(src, ip, { proto, port, entry }) 相同）。 */
      const evalOne = (a, ip, svc, w, srcs) => {
        const { b, sum } = evaluate(a.ip, ip, svc, 'exact', null, w.ep, w.vrf, once);
        const reasons = sum.verdict === 'unknown' ? U.uniq(sum.reasons.map((x) => x.code)) : [];
        return { src: a, ep: w.ep, edev: w.dev, srcs, verdict: sum.verdict, sum, b, reasons };
      };
      const share = (ev) => Object.assign({}, ev, { shared: true });
      // 設備本身的目的只算真的送到那台設備那個位址的（同矩陣的 record：dst-nat 改寫、或重疊位址在入口的 VRF 送達別處時不算）
      const reachesT = (sum, t, wv) => !sum.final || (sum.final.dst === t.ip && (sum.final.vrf || wv) === t.vrf);
      /**
       * edge／routed：類 g 的第一個 service 被拒絕時，哪些 service 可以共用這個判斷（回傳 [[service 索引]]，第一組含 g[0]，每組共用組內第一個的拒絕）。
       * 同類對所有規則（含 dst-nat 的埠）的條件結果相同，只差設備自己的 /ip service（reachesLocal，同矩陣）：
       *   沒有走到「送給設備自己」→ 整類共用；走到了且沒有 NAT → 依那台設備（目的位址的擁有者）的 /ip service 再分（devClasses，同矩陣對落到網路設備的目的）；
       *   走到了又有 NAT（改寫後的埠可能依服務不同）→ 逐一判斷。
       */
      const denyGroups = (g, sum, wv) => {
        if (g.length < 2 || !reachesLocal(sum)) return [g];
        const fin = sum.final;
        const od = !sum.nat && fin && fin.dst ? ownerDev(fin.dst, fin.vrf || wv) : null;
        return od && netDev(od) ? devClasses([g], services, od) : g.map((si) => [si]);
      };
      // 判斷次數用完時，還沒判斷到的（目的, 服務）：jb 之後的目的全部、jb 這個目的裡 touched 以外的服務（notEvaluated 用）
      let jb = jobs.length; let touched = null;
      const edgeSec = (j, ev) => {
        const wv = j.w.vrf;
        const natUnknown = ev.reasons.some((c) => NAT_UNKNOWN.has(c));
        const isOwn = ownerDev(j.ip, wv) === j.w.dev;
        const isFront = front.has(devVrf(j.w.dev, wv) + '|' + j.ip);
        const selfOk = wv === K.MAIN_VRF;
        if ((ev.sum.nat || natUnknown) && isFront) return ['dnat', null];
        if (ev.sum.nat || natUnknown) return selfOk ? ['self', { natted: true }] : null;
        if (isOwn) return selfOk ? ['self', null] : null;
        return ['dnat', { verdict: 'deny', forced: true }]; // dst-nat 寫明的位址、這個服務沒有被改寫：不算進得來
      };
      /** edge／routed 的一個判斷記進它的組合（ev 不修改，另建一份）。 */
      const emit = (j, si, ev) => {
        touched.add(si);
        const svc = services[si];
        if (j.kind === 'edge') {
          const x = edgeSec(j, ev);
          if (x) comboOf(x[0], j.w.dev, j.w.vrf, j.ip, svc, {}).evals.push(x[1] ? Object.assign({}, ev, x[1]) : ev);
        } else comboOf('routed', j.w.dev, j.w.vrf, j.ip, svc, { rep: j.rep }).evals.push(ev.sum.nat || ev.reasons.some((c) => NAT_UNKNOWN.has(c)) ? Object.assign({}, ev, { natted: true }) : ev);
      };
      outer: for (let ji = 0; ji < jobs.length; ji++) {
        const j = jobs[ji];
        jb = ji; touched = new Set();
        if (j.kind === 'via') {
          const srcs = srcsFor(j.w.dev, j.t.dev);
          // 外部區段：目的就是入口設備時逐一判斷；經別台入口設備時先以矩陣的代表位址（primary）判斷（同矩陣只用代表位址），不是拒絕才判斷其他區段（允許的列與 Q.reach 相同、allowedFrom 完整）
          const cross = j.w.dev !== j.t.dev;
          const prim = srcs.list.find((a) => a.primary) || srcs.list[0];
          const order = cross ? [prim].concat(srcs.list.filter((a) => a !== prim)) : srcs.list;
          for (const subs of subsOf(j.t.dev)) {
            // 同一類有多個子類（只差目的設備的 /ip service）：第一個子類的判斷沒有走到「送給設備自己」、也沒有 NAT，而且是拒絕或沒有送到這個位址時，
            // 其他子類的結果相同（同矩陣的 reachesLocal 共用），整類共用；否則子類各自判斷（列與 Q.reach 相同）
            const shareAt = new Map();
            for (let k = 0; k < subs.length; k++) {
              const g = subs[k];
              let open = !cross;
              for (const a of order) {
                if (!open && a !== prim) break;
                let ev0 = k > 0 ? shareAt.get(a) : undefined;
                if (ev0) ev0 = share(ev0);
                else {
                  if (done >= maxEvals) { truncated = true; break outer; }
                  done++; if (k > 0 || (a !== prim && cross)) total++;
                  ev0 = evalOne(a, j.ip, services[g[0]], j.w, srcs);
                  const s0 = ev0.sum;
                  if (k === 0 && subs.length > 1 && !s0.nat && s0.final && s0.final.port === services[g[0]].port && !reachesLocal(s0) && (ev0.verdict === 'deny' || !reachesT(s0, j.t, j.w.vrf))) shareAt.set(a, ev0);
                }
                g.forEach((si) => touched.add(si));
                if (!reachesT(ev0.sum, j.t, j.w.vrf)) continue;
                if (a === prim && ev0.verdict !== 'deny') open = true;
                for (const si of g) {
                  let ev = ev0;
                  if (si !== g[0]) {
                    if (ev0.verdict === 'deny') ev = share(ev0); // 同類的 service 結果相同（矩陣的等價類）：拒絕不再逐一判斷，也不列出
                    else { if (done >= maxEvals) { truncated = true; break outer; } done++; total++; ev = evalOne(a, j.ip, services[si], j.w, srcs); if (!reachesT(ev.sum, j.t, j.w.vrf)) continue; }
                  }
                  comboOf('self', j.t.dev, j.t.vrf, j.ip, services[si], {}).evals.push(ev);
                }
                if (due() && done < total) yield { stage: 'evaluate', done, total };
              }
            }
          }
          continue;
        }
        // edge（目的是入口設備自己的位址或 dst-nat 寫明的位址）用入口設備的 devClasses，routed 用 svcClasses：
        // 類的第一個 service 被拒絕時依 denyGroups 共用（拒絕只計數、不列出）；不是拒絕時同類逐一判斷（列與 Q.reach 相同）
        const srcs = srcsOf.get(j.w.dev);
        for (const g of (j.kind === 'edge' ? classesOf(j.w.dev) : classes)) {
          for (const a of srcs.list) {
            if (done >= maxEvals) { truncated = true; break outer; }
            done++;
            const ev0 = evalOne(a, j.ip, services[g[0]], j.w, srcs);
            emit(j, g[0], ev0);
            if (g.length > 1) {
              const groups = ev0.verdict === 'deny' ? denyGroups(g, ev0.sum, j.w.vrf) : g.map((si) => [si]);
              for (const h of groups) {
                let hev = h[0] === g[0] ? ev0 : null;
                for (const si of h) {
                  if (si === g[0]) continue;
                  if (hev && hev.verdict === 'deny') { emit(j, si, share(hev)); continue; }
                  if (done >= maxEvals) { truncated = true; break outer; }
                  done++; total++;
                  const ev = evalOne(a, j.ip, services[si], j.w, srcs);
                  emit(j, si, ev);
                  if (!hev) hev = ev;
                }
              }
            }
            if (due() && done < total) yield { stage: 'evaluate', done, total };
          }
        }
      }
      // 判斷次數用完：沒有判斷到的（目的, 服務）組合另計 notEvaluated（同 IPv6），不算候選，也不算拒絕。
      // 這些組合沒有判斷結果，區段依目的推估：via 與入口設備自己在 main 的位址算 self、routed 算 routed，其餘（dst-nat 寫明的位址、非 main 的入口位址）算 dnat
      const notEval = new Map();
      if (truncated) {
        for (let ji = jb; ji < jobs.length; ji++) {
          const j = jobs[ji];
          services.forEach((svc, si) => {
            if (ji === jb && touched.has(si)) return;
            let k;
            if (j.kind === 'via') k = comboKey('self', j.t.dev, j.t.vrf, j.ip, svc);
            else if (j.kind === 'routed') k = comboKey('routed', j.w.dev, j.w.vrf, j.ip, svc);
            else {
              const isOwn = ownerDev(j.ip, j.w.vrf) === j.w.dev;
              const sec = isOwn && j.w.vrf === K.MAIN_VRF ? 'self' : !isOwn || front.has(devVrf(j.w.dev, j.w.vrf) + '|' + j.ip) ? 'dnat' : null;
              if (!sec) return;
              k = comboKey(sec, j.w.dev, j.w.vrf, j.ip, svc);
            }
            if (!combos.has(k)) notEval.set(k, k.slice(0, k.indexOf('\u0000')));
          });
        }
      }
      yield { stage: 'summary', done: 0, total: combos.size };
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
      notEval.forEach((sec) => { secs[sec].counts.notEvaluated++; });
      // 整理結果：1000 台時組合有數萬個，分段讓出（同判斷）
      let sDone = 0;
      for (const c of combos.values()) {
        sDone++;
        if (due() && sDone < combos.size) yield { stage: 'summary', done: sDone, total: combos.size };
        const sec = secs[c.sec]; sec.counts.candidates++;
        // 經 dst-nat 改寫的組合（不是這一段的路徑）：只計數，結果在 dnat 段以入口位址列出
        const evs = c.evals.filter((e) => !e.natted);
        if (!evs.length) { sec.counts.natted++; continue; }
        // dst-nat 改寫後的目的是私有位址、每條路徑都經對外介面送回外部（route.code egress-wan）：連不到基準內，不是暴露，算路由沒到（同檢查的 R09，checks.js 的 dnatTarget 的 external）
        if (c.sec === 'dnat') c.evals = evs.map((e) => (e.verdict !== 'deny' && !e.forced && egressBack(e) ? Object.assign({}, e, { verdict: 'deny', egressBack: true }) : e));
        else c.evals = evs;
        const vs = c.evals.map((e) => e.verdict);
        const verdict = vs.includes('allow') ? 'allow' : vs.includes('unknown') ? 'unknown' : 'deny';
        sec.counts[verdict]++;
        if (verdict === 'deny') {
          const real = c.evals.filter((e) => !e.forced);
          deniedBy[c.sec][!real.length ? 'notNatted' : real.every((e) => e.egressBack || deniedByOf(e.sum) === 'noRoute') ? 'noRoute' : 'filter']++;
          continue;
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
      }
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

  // ---- 暴露清單的結論（Q.exposureSummary）：畫面頁首與主管摘要共用的分組、計數與結論句（單一來源）
  /** 三段的鍵（Q.exposure 的欄位，順序同畫面） */
  const SUMMARY_SECS = Object.freeze(['self', 'dnat', 'routed']);
  /** 數字的千分位（同畫面 V.num 的 zh-TW 寫法；核心不依執行環境的 locale） */
  const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  /**
   * 一段的分組（不改判斷）：同一台設備、同一個服務、結果、允許來源、依據與入口都相同的列併成一列（例如設備每個介面位址的 icmp）。
   * 這就是結論的計數單位「服務」。順序：允許 → 無法判斷（同結果內保留 Q.exposure 的順序）；
   * 第 1 段（列有 via）再依目的設備分組：有允許的設備在前、只有無法判斷的在後，同一類裡入口設備（有 via 為 null 的列）在前，再依第一次出現的位置。
   * 回傳 [{ row（第一列）, index（它在 rows 的位置）, ips（併進來的位址，依 rows 的順序）, entryDev（第 1 段：目的設備是不是入口設備；其他段 null） }]
   */
  function exposureGroups(rows) {
    const m = new Map(); let out = [];
    rows.forEach((x, i) => {
      const k = [x.family || '', x.dev, x.src, x.entries.join(','), x.service, x.verdict, x.incomplete, x.allowedFrom.text, x.rule ? x.rule.key || `${x.rule.table}|${x.rule.chain}` : '', x.entry, x.target || '', x.subnet || '', x.nat ? x.nat.to : '', x.serviceName || '', x.reasons.join(','), x.findingKeys.join(','), (x.returnUnsafe || []).map((u) => u.dev + '|' + u.chain + '|' + u.rule).join(',')].join('\u0000');
      const g = m.get(k); if (g) { g.ips.push(x.ip); return; }
      const ng = { row: x, index: i, ips: [x.ip], entryDev: null }; m.set(k, ng); out.push(ng);
    });
    const rank = (v) => (v === 'allow' ? 0 : v === 'unknown' ? 1 : 2);
    out = out.map((g, n) => ({ g, n })).sort((a, b) => rank(a.g.row.verdict) - rank(b.g.row.verdict) || a.n - b.n).map((o) => o.g);
    if (rows.some((x) => x.via !== undefined)) {
      const at = new Map(); out.forEach((g, n) => { if (!at.has(g.row.dev)) at.set(g.row.dev, n); });
      const entryDevs = new Set(rows.filter((x) => x.via === null).map((x) => x.dev));
      const allowDevs = new Set(out.filter((g) => g.row.verdict === 'allow').map((g) => g.row.dev));
      const devRank = (d) => (allowDevs.has(d) ? 0 : 2) + (entryDevs.has(d) ? 0 : 1);
      out = out.map((g, n) => ({ g, n })).sort((a, b) => devRank(a.g.row.dev) - devRank(b.g.row.dev) || at.get(a.g.row.dev) - at.get(b.g.row.dev) || a.n - b.n).map((o) => o.g);
      out.forEach((g) => { g.entryDev = entryDevs.has(g.row.dev); });
    }
    return Object.freeze(out.map((g) => { Object.freeze(g.ips); return Object.freeze(g); }));
  }
  /**
   * Q.exposureSummary 的內容（ex 是 Q.exposure 的結果）。計數有兩種單位，欄位分開、不混用：
   *   allow／unknown：分組後的列數（「服務」，exposureGroups）；結論句只用這一種。
   *   combos：Q.exposure 的 counts（「組合」＝目的位址 × 服務，未分組）；拒絕與沒判斷沒有列，只有這種單位。
   */
  S.reach._.exposureSummary = function exposureSummary(Q, ex) {
    const sections = {};
    const total = { allow: 0, unknown: 0 };
    const combos = { allow: 0, unknown: 0, deny: 0, notEvaluated: 0 };
    SUMMARY_SECS.forEach((k) => {
      const s = ex[k]; const c = s.counts;
      const groups = exposureGroups(s.rows);
      const allow = groups.filter((g) => g.row.verdict === 'allow').length;
      const sec = { allow, unknown: groups.length - allow, groups,
        combos: Object.freeze({ candidates: c.candidates, allow: c.allow, unknown: c.unknown, deny: c.deny, natted: c.natted, notEvaluated: c.notEvaluated || 0 }),
        deniedBy: ex.deniedBy ? ex.deniedBy[k] : null };
      total.allow += sec.allow; total.unknown += sec.unknown;
      Object.keys(combos).forEach((x) => { combos[x] += sec.combos[x]; });
      sections[k] = Object.freeze(sec);
    });
    const noFirewall = Object.freeze((ex.noFirewall || []).map((d) => (typeof d === 'string' ? d : d.dev)));
    let sentence;
    if (ex.status !== 'ok') sentence = ex.status === 'no-wan' ? '找不到 WAN 介面，無法判斷從外部進得來什麼。' : ex.message || '無法判斷從外部進得來什麼。';
    else {
      const part = (n) => (n ? `${num(n)} 個` : '沒有');
      const a = (k) => sections[k].allow;
      sentence = (total.allow ? `從外部進來，連得到 ${num(total.allow)} 個服務：網路設備本身 ${part(a('self'))}、轉送到內部 ${part(a('dnat'))}、直接路由 ${part(a('routed'))}。` : '從外部進來，連不到任何服務。')
        + (total.unknown ? `另有 ${num(total.unknown)} 個無法判斷。` : '')
        + (noFirewall.length ? `另有 ${noFirewall.map((d) => Q.devName(d)).join('、')} 無法判斷（沒有防火牆資料，缺 /export）。` : '');
    }
    return Object.freeze({ status: ex.status, message: ex.message, unit: '服務', total: Object.freeze(total), combos: Object.freeze(combos),
      sections: Object.freeze(sections), noFirewall, truncated: !!(ex.limits && ex.limits.truncated), sentence });
  };
})(globalThis.SSOT = globalThis.SSOT || {});
