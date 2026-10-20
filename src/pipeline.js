/*
 * 建立基準：build(sources, options) → Snapshot
 *   ① Reader 切段 → ② 辨識指令 → ③ Adapter 產生事實 → ④ 建模 → ⑤ 推論 → ⑥ 檢查 → Snapshot
 * 同樣的輸入與選項，必定得到同樣的 Snapshot（meta.createdAt、meta.timing 除外）。
 *
 * sources : [{ name, text }]
 * options : { profile?: profile JSON, expectedData?: {kind:[dataType]}, now?: ISO 字串 }
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const U = S.util;

  function* steps(sources, options) {
    const opt = options || {};
    const t0 = Date.now();
    const profile = opt.profile ? S.profile.compile(opt.profile) : null;
    const canon = profile ? (n) => profile.canon(n) : (n) => String(n || '').trim();

    // ① 讀取
    yield { stage: '讀取輸入', done: 0, total: 1 };
    const { blocks, readersUsed } = S.readers.readAll(sources);
    blocks.forEach((b) => { b.devKey = b.device === null ? null : K.dev(canon(b.device)); });

    // ②③ 辨識與解析
    const factsByBlock = new Map();
    const unrecognized = [];
    const usage = {};
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const r = S.adapters.recognize(b);
      b.how = r.how;
      b.adapters = r.adapters.map((a) => a.id);
      if (!r.adapters.length) { unrecognized.push(b); continue; }
      const facts = [];
      r.adapters.forEach((a) => {
        const before = facts.length;
        a.parse(b, (f) => { f.dev = b.devKey; f.adapter = a.id; f.dataType = a.dataType; f.vendor = a.vendor; f.block = b.id; facts.push(f); });
        usage[a.id] = (usage[a.id] || 0) + (facts.length - before);
      });
      // 有標記指令、辨識成功但完全沒有解析出內容 → 也算無法辨識（避免靜默得到空結果）
      if (!facts.length && b.lines.some((l) => l.trim())) { b.empty = true; unrecognized.push(b); continue; }
      factsByBlock.set(b.id, facts);
      if (i % 200 === 199) yield { stage: '解析設備輸出', done: i + 1, total: blocks.length };
    }

    // 同一設備、同一種資料出現多次：採用最後一次
    const lastOf = new Map(); const seen = new Map();
    blocks.forEach((b) => {
      if (!factsByBlock.has(b.id)) return;
      b.adapters.forEach((a) => {
        const k = b.devKey + '\u0000' + a;
        U.getOr(seen, k, () => []).push(b.id);
        lastOf.set(k, b.id);
      });
    });
    const duplicates = [];
    seen.forEach((ids, k) => {
      if (ids.length < 2) return;
      const [dev, adapter] = k.split('\u0000');
      duplicates.push({ dev, adapter, blocks: ids });
    });
    const facts = [];
    blocks.forEach((b) => {
      const fs = factsByBlock.get(b.id);
      if (fs) fs.forEach((f) => { if (lastOf.get(f.dev + '\u0000' + f.adapter) === b.id) facts.push(f); });
    });

    // ④⑤⑥
    yield { stage: '建立模型', done: 0, total: 1 };
    const M = S.model.build({ blocks, facts, canon });
    S.infer.infer(M, profile);
    yield { stage: '一致性檢查', done: 0, total: 1 };
    const findings = S.check.run(M, { blocks, unrecognized, duplicates, expectedData: opt.expectedData });
    const coverage = S.check.coverage(M);

    const snap = serialize(M, { blocks, findings, coverage, facts, usage, readersUsed, sources, profile, opt, t0 });
    yield { stage: '完成', done: 1, total: 1, snapshot: snap };
    return snap;
  }

  function lineText(blocks, ref) {
    const b = blocks[ref.block]; if (!b) return '';
    const idx = ref.line - b.origin.startLine;
    return (b.lines[idx] || '').trim().slice(0, 200);
  }

  function serialize(M, c) {
    const nat = U.natural;
    const name = (d) => S.infer.displayName(d);
    const devices = Array.from(M.devices.values()).map((d) => ({
      key: d.key, name: name(d), names: Array.from(d.names), mgmtIp: d.mgmtIp, manufacturer: d.manufacturer, kind: d.kind, kindBasis: d.kindBasis,
      collected: d.collected, data: Array.from(d.data).sort(), hostname: d.hostname, routerId: d.routerId,
      group: d.group, component: d.component, role: d.role || null, site: d.site || null, label: d.label || null,
      deviceType: d.deviceType, softwareVersion: d.softwareVersion, platform: d.platform, caps: d.caps,
      seenBy: Array.from(d.seenBy).sort(), src: d.src, srcNone: d.src.length ? null : 'seen-only',
    })).sort((a, b) => nat(a.key, b.key));

    const interfaces = Array.from(M.ifcs.values()).map((i) => ({
      key: i.key, dev: i.dev, name: i.name, desc: i.desc, enabled: i.enabled, status: i.status || 'unknown', type: i.type, typeBasis: i.typeBasis,
      rawType: i.rawType, hwMac: i.hwMac, defaultName: i.defaultName, mtu: i.mtu, actualMtu: i.actualMtu, l2mtu: i.l2mtu,
      lag: i.lag, lagMembers: Array.from(i.lagMembers).sort(nat), bridge: i.bridge, parent: i.parent, encapVlan: i.encapVlan,
      mode: i.mode, pvid: i.pvid, untaggedVlans: U.numSort(Array.from(i.untaggedVlans)), taggedVlans: U.numSort(Array.from(i.taggedVlans)),
      unresolvedVlans: Array.from(i.unresolvedVlans).sort(nat), macs: Array.from(i.macs).sort(),
      hearsay: i.hearsay, edge: M.edge.has(i.key), unknownPeer: M.edge.has(i.key) && !M.edge.get(i.key).linked, src: i.src, srcNone: i.src.length ? null : i.hearsay ? 'hearsay' : 'unrecorded',
    })).sort((a, b) => nat(a.key, b.key));

    const links = Array.from(M.links.values()).map((l) => ({
      key: l.key, a: l.a, b: l.b, layer: l.layer, via: Array.from(l.via).sort(), protocols: Array.from(l.protocols || []).sort(), verified: !!l.verified, hearsay: l.hearsay,
      evidenceScope: l.evidenceScope, observations: (l.observations || []).slice().sort((a, b) => nat(a.dev, b.dev) || nat(a.ifc, b.ifc) || nat(a.peerIfc || '', b.peerIfc || '') || nat(a.block, b.block) || a.line - b.line),
      cls: l.cls, vlansA: l.vlansA || [], vlansB: l.vlansB || [], vlansCommon: l.vlansCommon || [], vlanComparable: !!l.vlanComparable, vlanMismatch: !!l.vlanMismatch, src: l.src,
    })).sort((a, b) => nat(a.key, b.key));

    const vlans = Array.from(M.vlans.values()).map((v) => ({
      dev: v.dev, id: v.id, name: v.name, desc: v.desc, src: v.src, srcNone: v.src.length ? null : 'implicit',
      members: Array.from(v.members, ([ep, tagged]) => ({ ep, tagged })).sort((a, b) => nat(a.ep, b.ep)),
    })).sort((a, b) => nat(a.dev, b.dev) || (a.id || 0) - (b.id || 0) || nat(a.name || '', b.name || ''));

    const macs = Array.from(M.macs.values()).map((m) => ({
      mac: m.mac, vendor: S.oui ? S.oui.lookup(m.mac) : null, ips: Array.from(m.ips).sort(nat),
      seen: Array.from(m.seen.entries()).flatMap(([ep, vlans]) => Array.from(vlans, (vlan) => ({ ep, vlan })))
        .sort((x, y) => nat(x.ep, y.ep) || nat(x.vlan || '', y.vlan || '')), edge: m.edge || [], src: m.src,
    })).sort((a, b) => U.cmp(a.mac, b.mac));

    // IP 位址（參考 NetBox IPAddress）：每個介面上的每個位址一筆；VRF 尚未收集，固定為 null
    const ipAddresses = Array.from(M.ifcs.values()).flatMap((i) => Array.from(i.ips, ([address, src]) => {
      const p = S.ip.parseCidr(address);
      return { address, ip: p ? p.ip : null, len: p ? p.len : null, family: 4, vrf: null, dev: i.dev, ep: i.key, hearsay: i.hearsay, src: [src] };
    })).sort((a, b) => nat(a.ip || a.address, b.ip || b.address) || nat(a.ep, b.ep));
    // 前綴（參考 NetBox Prefix）：由設備自有的位址推導的直連網段，屬於推論
    const prefixMap = new Map();
    ipAddresses.forEach((a) => {
      if (a.hearsay || a.ip === null || a.len >= 32) return;
      const net = S.ip.parseCidr(a.address).net; const prefix = net + '/' + a.len;
      const p = U.getOr(prefixMap, prefix, () => ({ prefix, net, len: a.len, family: 4, vrf: null, basis: 'connected', eps: [] }));
      if (!p.eps.includes(a.ep)) p.eps.push(a.ep);
    });
    const prefixes = Array.from(prefixMap.values()).map((p) => Object.assign(p, { eps: p.eps.sort(nat) }))
      .sort((a, b) => nat(a.net, b.net) || a.len - b.len);

    const arps = M.arps.map((a) => ({ ip: a.ip, mac: a.mac, dev: a.dev, ifc: a.ifc, phys: a.phys, src: [[a.block, a.line]] }))
      .sort((a, b) => nat(a.ip, b.ip) || nat(a.dev, b.dev) || U.cmp(a.mac, b.mac));
    const routes = M.routes.map((r) => ({ dev: r.dev, prefix: r.prefix, len: r.len, proto: r.proto, nh: r.nh, src: [[r.block, r.line]] }))
      .sort((a, b) => nat(a.dev, b.dev) || nat(a.prefix, b.prefix) || a.len - b.len);
    const ospfAdjacencies = M.ospfAdjacencies.map((a) => ({
      dev: a.dev, localEp: a.localEp, peerDev: a.peerDev, peerEp: a.peerEp,
      peerIp: a.peerIp, peerId: a.peerId, reciprocal: a.reciprocal, src: [[a.block, a.line]],
    })).sort((a, b) => nat(a.dev, b.dev) || nat(a.localEp, b.localEp) || nat(a.peerDev, b.peerDev) || nat(a.peerIp, b.peerIp) || a.src[0][1] - b.src[0][1]);

    c.findings.forEach((f) => f.evidence.forEach((e) => { e.text = lineText(c.blocks, e); e.file = (c.blocks[e.block] || { origin: {} }).origin.file; }));

    const blocks = c.blocks.map((b) => ({
      id: b.id, device: b.device, devKey: b.devKey, command: b.command, reader: b.reader, adapters: b.adapters || [], how: b.how,
      file: b.origin.file, start: b.origin.startLine, end: b.origin.endLine, empty: !!b.empty,
    }));

    const sev = { error: 0, warn: 0, info: 0 };
    c.findings.forEach((f) => { sev[f.severity]++; });
    const inputText = c.sources.map((s) => (s.name || '') + '\n' + s.text).join('\n\u0000\n');
    return {
      meta: {
        schema: S.SCHEMA, version: S.VERSION,
        createdAt: c.opt.now || new Date().toISOString(),
        inputHash: U.hash(inputText),
        sources: c.sources.map((s) => ({ name: s.name || S.readers.PASTE, reader: c.readersUsed[s.name || S.readers.PASTE] || null, bytes: s.text.length, hash: U.hash(s.text) })),
        adapters: c.usage, blockCount: c.blocks.length, factCount: c.facts.length,
        profile: c.profile ? { id: c.profile.id, version: c.profile.version } : null,
        stats: {
          devices: devices.length, collected: devices.filter((d) => d.collected).length, interfaces: interfaces.length,
          links: links.length, ipAddresses: ipAddresses.length, prefixes: prefixes.length, ospfAdjacencies: ospfAdjacencies.length, vlans: vlans.length, macs: macs.length, arps: arps.length, routes: routes.length,
          findings: sev,
        },
        timing: { ms: Date.now() - c.t0 },
      },
      model: { devices, interfaces, links, ospfAdjacencies, vlans, ipAddresses, prefixes, macs, arps, routes },
      findings: c.findings,
      coverage: c.coverage,
      blocks,
    };
  }

  /** 同步建立（Node、測試用）。 */
  S.build = function (sources, options) {
    const it = steps(sources, options);
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
  };

  /** 非同步建立（瀏覽器用）：每個階段讓出主執行緒並回報進度。 */
  S.buildAsync = async function (sources, options, onProgress) {
    const it = steps(sources, options);
    let r = it.next();
    while (!r.done) {
      if (onProgress) onProgress(r.value);
      await new Promise((res) => setTimeout(res, 0));
      r = it.next();
    }
    return r.value;
  };
})(globalThis.SSOT = globalThis.SSOT || {});
