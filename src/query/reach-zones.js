/*
 * L4 引擎：zone 與矩陣的代表位址（S.reach._.zonesPart，src/query/reach.js 的 makeEngine 呼叫）。
 *  - zone（推論）：每個 IPv4 直連網段依 ZONE_SOURCES 的順序取第一個有結果的來源（命名規則、interface list、VLAN、網段本身）；
 *  - 代表位址：每個 zone 依位址等價類取的位址（repsOf）、dst-nat 的入口（vipsOf）、虛擬 zone（外部與網路設備本身，virtualOf）。
 * 必須在 src/query/reach-eval.js 之後載入（tools/core-files.js）。
 */
(function (S) {
  'use strict';
  const IP = S.ip;
  const K = S.keys;
  const U = S.util;
  const { deepFreeze, ZONE_SOURCES, EXTERNAL_ZONE, SELF_ZONE } = S.reach._;

  /** E：reach.js 的 base 建立的 engine 物件；加上 zones、zoneOf、repsOf、vipsOf、virtualOf。 */
  S.reach._.zonesPart = function zonesPart(E) {
    const { Q, I, m, F, devOfEp, ownerOf, prefixes4, srcLocation, longest, realEp, devInfo, netDev, bounds, findAtom, externalRep, single, ownIps, l4Entries } = E;

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
      const repB = E.repB;
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
     *   外部（external）：基準以外的位址。來源從每個對外入口（l4Entries，與暴露清單相同）進入、在入口的 VRF 查路由，目的經對外介面送出（end egress-wan）；
     *     代表位址是 EXTERNAL_CANDIDATES 中第一個不在基準網段、也不屬於任何設備的位址，只代表與它同一個規則位址區段的公網位址（range）。
     *     沒有任何對外入口時沒有這個 zone。
     *   網路設備（管理）（self，只當目的）：已收集且有 /export 的設備自己的位址，走 input 與 /ip service；
     *     取 main VRF 入口介面上的位址，與每個網段的閘道介面上的位址（1000 台時不把每台設備的每個位址都算進來）；只取 IPv4。
     */
    function virtualOf(reps) {
      bounds();
      const ruleB = E.ruleB;
      const wanEps = l4Entries();
      const extIp = wanEps.length ? externalRep() : null;
      let range = null;
      if (extIp) { const i = findAtom(ruleB, IP.toInt(extIp)); range = [IP.fromInt(ruleB[i]), IP.fromInt(i + 1 < ruleB.length ? ruleB[i + 1] - 1 : 0xffffffff)]; }
      const extSrc = extIp ? wanEps.map((w) => ({ ip: extIp, vrf: w.vrf, zone: EXTERNAL_ZONE, subnet: null, range, basis: 'documentation', via: 'external', dev: w.dev, entry: w.ep })) : [];
      const extDst = extIp ? [{ ip: extIp, vrf: K.MAIN_VRF, zone: EXTERNAL_ZONE, subnet: null, range, basis: 'documentation', via: 'external', dev: null }] : [];
      const selfMap = new Map();
      const addSelf = (dev, ep, inNet) => {
        if (!devInfo(dev).config || !realEp(ep)) return;
        // 只取 IPv4（矩陣只判斷 IPv4；ownIps 也有 IPv6 位址，IPv6 見 Q.exposure 的 exposure6）
        ownIps(ep).filter((a) => IP.isIp(a.ip) && (!inNet || inNet(a))).forEach((a) => { const v = K.vrf(a.vrf); const k = K.inVrf(a.ip, v); if (!selfMap.has(k)) selfMap.set(k, { ip: a.ip, vrf: v, zone: SELF_ZONE, subnet: null, range: null, basis: 'device', via: 'device', dev }); });
      };
      wanEps.forEach((w) => { if (w.vrf === K.MAIN_VRF) addSelf(w.dev, w.ep); });
      reps.forEach((list) => list.forEach((r) => {
        const loc = srcLocation(r.ip, r.vrf); if (loc.how !== 'subnet') return;
        loc.gateways.forEach((g) => addSelf(g.dev, g.ep, (a) => IP.inNet(a.ip, loc.net, loc.len)));
      }));
      const selfDst = Array.from(selfMap.values()).sort((a, b) => U.natural(a.dev, b.dev) || IP.toInt(a.ip) - IP.toInt(b.ip));
      const zonesV = [];
      if (extIp) zonesV.push({ id: EXTERNAL_ZONE, name: '外部（Internet）', source: 'virtual', inferred: true, virtual: true, dstOnly: false, vrf: K.MAIN_VRF, subnets: [],
        devices: U.uniq(wanEps.map((w) => w.dev)).sort(U.natural), representative: extIp, range,
        basis: `基準以外的位址（推論）：代表位址 ${extIp} 是文件保留位址，只代表 ${range[0]}–${range[1]}（同一個規則位址區段）；來源從對外介面進入，目的經對外介面送出` });
      if (selfDst.length) zonesV.push({ id: SELF_ZONE, name: '網路設備（管理）', source: 'virtual', inferred: true, virtual: true, dstOnly: true, vrf: null, subnets: [],
        devices: U.uniq(selfDst.map((x) => x.dev)).sort(U.natural), representative: null, range: null,
        basis: '網路設備自己的位址（WAN 介面與各網段的閘道介面），走輸入規則（input）與管理服務（/ip service）' });
      return { extSrc, extDst, selfDst, zones: zonesV };
    }

    Object.assign(E, { zones, zoneOf, repsOf, vipsOf, virtualOf });
  };
})(globalThis.SSOT = globalThis.SSOT || {});
