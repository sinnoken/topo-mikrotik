/*
 * 建模：事實（fact）→ 實體（device / interface / link / vlan / mac / arp / route）。
 * 只依唯一鍵（core/keys.js）合併，不看命名規則。結果是內部結構 M（Map/Set），由 pipeline 序列化成 Snapshot。
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const getOr = S.util.getOr;
  const MAX_SRC = 4;

  function addSrc(ent, f) { if (ent.src.length < MAX_SRC) ent.src.push([f.block, f.line]); }

  function newModel() {
    return {
      devices: new Map(), ifcs: new Map(), links: new Map(), vlans: new Map(), macs: new Map(),
      arps: [], routes: [], claims: [], ospf: [], vmems: [],
      notes: { k01: [], k04: [], r02: [] },
    };
  }

  function device(M, key, name) {
    const d = getOr(M.devices, key, () => ({
      key, names: new Set(), mgmtIp: null, vendors: new Set(), collected: false, data: new Set(),
      hostname: null, routerId: null, seenBy: new Set(), src: [], board: null, version: null, platform: null, caps: null,
    }));
    if (name) d.names.add(name);
    return d;
  }

  function iface(M, devKey, name) {
    const key = K.ep(devKey, name);
    return getOr(M.ifcs, key, () => ({
      key, dev: devKey, name: String(name).trim().replace(/\.0$/, ''), desc: null, admin: null, status: null,
      type: null, parent: null, mode: null, ips: new Set(), vlans: new Set(), vlanNames: new Set(),
      macs: new Set(), hearsay: false, sub: null, src: [],
    }));
  }

  /**
   * @param {object} input { blocks, facts, canon }
   *   facts: [{ t, dev, devName, adapter, dataType, vendor, block, line, ... }]
   */
  function build(input) {
    const M = newModel();
    const { canon } = input;

    // 1. 設備（每個有設備標頭的區塊都代表「有收集到這台」）
    input.blocks.forEach((b) => {
      if (b.device === null) return;
      const d = device(M, b.devKey, b.device);
      d.collected = true;
      if (b.mgmtIp && !d.mgmtIp) d.mgmtIp = b.mgmtIp;
    });

    // 管理 IP → 已收集設備（鄰居的 identity 和收集檔的設備名不同時，用 IP 對回同一台）
    const mgmtDev = new Map();
    M.devices.forEach((d) => { if (d.mgmtIp) mgmtDev.set(d.mgmtIp, d.key); });

    // 2. 逐筆事實
    input.facts.forEach((f) => {
      const d = device(M, f.dev);
      d.data.add(f.dataType);
      d.vendors.add(f.vendor);
      addSrc(d, f);
      switch (f.t) {
        case 'hostname': d.hostname = f.name; d.names.add(f.name); break;
        case 'rid': d.routerId = f.id; break;
        case 'ifc': onIfc(M, f); break;
        case 'lldp': {
          const i = iface(M, f.dev, f.ifc); addSrc(i, f);
          if (!i.status) i.status = 'up';
          if (f.parent) i.parent = K.ifc(f.parent);
          const peerName = canon(f.peer);
          let peerKey = K.dev(peerName);
          if (!M.devices.has(peerKey) && f.peerAddr && mgmtDev.has(f.peerAddr)) peerKey = mgmtDev.get(f.peerAddr);
          const pd = device(M, peerKey, peerName); pd.seenBy.add(f.dev);
          if (f.peerAddr && !pd.mgmtIp) pd.mgmtIp = f.peerAddr;
          if (f.board && !pd.board) pd.board = f.board;
          if (f.platform && !pd.platform) pd.platform = f.platform;
          if (f.caps && !pd.caps) pd.caps = f.caps;
          M.claims.push({ dev: f.dev, ifc: K.ifc(f.ifc), peer: peerKey, peerIfc: f.peerIfc || '?', chassis: f.chassis, protocols: f.protocols || [], peerIfcAlt: f.peerIfcAlt || null, block: f.block, line: f.line });
          break;
        }
        case 'sys': if (f.board) d.board = f.board; if (f.version) d.version = f.version; break;
        case 'ospf': M.ospf.push(f); if (f.ifc) iface(M, f.dev, f.ifc); break;
        case 'vlan': onVlan(M, f); break;
        case 'vmem': M.vmems.push(f); break;
        case 'mac': {
          const mk = K.mac(f.mac); if (!mk) break;
          const i = iface(M, f.dev, f.ifc); i.macs.add(mk); if (!i.status) i.status = 'up';
          const m = getOr(M.macs, mk, () => ({ mac: mk, seen: new Map(), ips: new Set() }));
          m.seen.set(i.key, f.vlan || null);
          break;
        }
        case 'arp': {
          const mk = K.mac(f.mac); if (!mk) break;
          M.arps.push({ ip: f.ip, mac: mk, dev: f.dev, ifc: K.ifc(f.ifc), phys: f.phys ? K.ifc(f.phys) : null, block: f.block, line: f.line });
          getOr(M.macs, mk, () => ({ mac: mk, seen: new Map(), ips: new Set() })).ips.add(f.ip);
          break;
        }
        case 'route':
          M.routes.push({ dev: f.dev, prefix: f.prefix, len: f.len, proto: f.proto,
            nh: f.nh.map((n) => ({ ip: n.ip, ifc: n.ifc ? K.ifc(n.ifc) : null })), block: f.block, line: f.line });
          break;
        default: break;
      }
    });

    resolveVlanMembers(M);
    buildAggregates(M);
    buildLldpLinks(M);
    buildOspfLinks(M, canon);
    return M;
  }

  function onIfc(M, f) {
    const i = iface(M, f.dev, f.ifc); addSrc(i, f);
    if (f.desc != null) i.desc = f.desc;
    if (f.admin) i.admin = f.admin;
    if (f.status) i.status = f.status;
    if (f.type) i.type = f.type;
    if (f.parent) i.parent = K.ifc(f.parent);
    if (f.mode) i.mode = f.mode;
    if (f.ip) i.ips.add(f.ip);
    if (f.sub) i.sub = { of: K.ifc(f.sub.of), vlan: f.sub.vlan };
    if (/^ae\d+$|^reth\d+$/i.test(i.name) && !i.type) i.type = 'aggregate';
  }

  function onVlan(M, f) {
    // 有名稱以名稱為鍵；只有 ID 的（RouterOS 的 bridge VLAN 沒有名稱）以 #ID 為鍵
    const vk = f.dev + '|' + (f.name ? 'n:' + f.name.toUpperCase() : 'i:' + f.id);
    const v = getOr(M.vlans, vk, () => ({ dev: f.dev, id: null, name: f.name || null, desc: null, l3: null, members: new Set(), src: [] }));
    if (f.id != null) v.id = f.id;
    if (f.desc) v.desc = f.desc;
    if (f.l3) v.l3 = K.ifc(f.l3);
    addSrc(v, f);
  }

  /** VLAN 成員：名稱 → ID（同一設備內查），掛到介面上。 */
  function resolveVlanMembers(M) {
    const byName = new Map(); const byId = new Map();
    M.vlans.forEach((v, vk) => {
      if (v.name) byName.set(v.dev + '|' + v.name.toUpperCase(), vk);
      if (v.id != null) byId.set(v.dev + '|' + v.id, vk);
    });
    M.vmems.forEach((f) => {
      const tok = String(f.vlan);
      let vk = byName.get(f.dev + '|' + tok.toUpperCase());
      if (!vk && /^\d+$/.test(tok)) {
        vk = byId.get(f.dev + '|' + tok);
        if (!vk) { // 只有數字、沒有定義：建立僅 ID 的 VLAN
          vk = f.dev + '|i:' + tok;
          if (!M.vlans.has(vk)) M.vlans.set(vk, { dev: f.dev, id: +tok, name: null, desc: null, l3: null, members: new Set(), src: [] });
          byId.set(f.dev + '|' + tok, vk);
        }
      }
      const i = iface(M, f.dev, f.ifc); addSrc(i, f);
      if (f.active && !i.status) i.status = 'up';
      if (!vk) { i.vlanNames.add(tok); return; }
      const v = M.vlans.get(vk);
      v.members.add(i.key);
      if (v.id != null) i.vlans.add(v.id); else i.vlanNames.add(v.name);
    });
  }

  function buildAggregates(M) {
    M.ifcs.forEach((i) => {
      if (!i.parent) return;
      const p = iface(M, i.dev, i.parent);
      p.type = 'aggregate';
      (p.members || (p.members = new Set())).add(i.key);
    });
  }

  function addLink(M, a, b, layer, via, src, extra) {
    const key = K.link(a, b);
    const l = getOr(M.links, key, () => {
      const [x, y] = a < b ? [a, b] : [b, a];
      return { key, a: x, b: y, layer, via: new Set(), verified: false, hearsay: false, protocols: new Set(), src: [] };
    });
    if (layer === 'l2') l.layer = 'l2';
    l.via.add(via);
    ((extra && extra.protocols) || []).forEach((p) => l.protocols.add(p));
    if (src && l.src.length < MAX_SRC) l.src.push(src);
    const { protocols, ...rest } = extra || {};
    Object.assign(l, rest);
    return l;
  }

  /**
   * LLDP 連結配對：本機介面名稱是權威，對端回報的埠名稱只是「聽說」。
   *  - 對端也有 LLDP 資料且反向找得到 → verified；兩邊埠名稱不同記 K04
   *  - 對端有 LLDP 資料但反向找不到 → K01（單向）
   *  - 對端沒有 LLDP 資料 → hearsay（只列入覆蓋率，不算錯誤）
   */
  function buildLldpLinks(M) {
    const byDev = new Map();
    M.claims.forEach((c) => getOr(byDev, c.dev, () => []).push(c));
    M.claims.forEach((c) => {
      const local = K.ep(c.dev, c.ifc);
      const peer = M.devices.get(c.peer);
      const src = [c.block, c.line];
      if (peer && peer.data.has('lldp')) {
        // 反向：對端的 LLDP 指向本機這個介面；或對端「本機介面」正是我們聽到的埠名（對端的 Port info 可能是描述）
        const unknownPort = c.peerIfc === '?';
        const said = K.ifc(c.peerIfc);
        const theirs = (byDev.get(c.peer) || []).filter((r) => r.peer === c.dev);
        let rev = theirs.find((r) => K.ifc(r.peerIfc) === c.ifc) || (unknownPort ? null : theirs.find((r) => r.ifc === said));
        // 兩邊都沒有連接埠名稱：兩邊數量相同時，依本機介面名稱排序後一一配對（單一連結一定正確；平行連結是合理推測）
        if (!rev && unknownPort) {
          const byIfc = (x, y) => S.util.natural(x.ifc, y.ifc);
          const mine = (byDev.get(c.dev) || []).filter((r) => r.peer === c.peer && r.peerIfc === '?').sort(byIfc);
          const cand = theirs.filter((r) => r.peerIfc === '?').sort(byIfc);
          if (cand.length && mine.length === cand.length) rev = cand[mine.indexOf(c)];
        }
        if (rev) {
          const remote = K.ep(c.peer, rev.ifc);
          const l = addLink(M, local, remote, 'l2', 'lldp', src, { verified: true, protocols: c.protocols });
          if (!unknownPort && said !== rev.ifc) M.notes.k04.push({ link: l.key, dev: c.dev, said: c.peerIfc, actual: rev.ifc, block: c.block, line: c.line });
          return;
        }
        const rname = unknownPort ? `?(${c.dev}:${c.ifc})` : c.peerIfc;
        const remote = K.ep(c.peer, rname);
        const existed = M.ifcs.has(remote);
        const ri = iface(M, c.peer, rname); if (!existed) ri.hearsay = true;
        const l = addLink(M, local, remote, 'l2', 'lldp', src, { protocols: c.protocols });
        M.notes.k01.push({ link: l.key, dev: c.dev, peer: c.peer, ifc: c.ifc, peerIfc: c.peerIfc, block: c.block, line: c.line });
        return;
      }
      const rname = c.peerIfc === '?' ? `?(${c.dev}:${c.ifc})` : c.peerIfc;
      const remote = K.ep(c.peer, rname);
      const existed = M.ifcs.has(remote);
      const ri = iface(M, c.peer, rname); if (!existed) ri.hearsay = true;
      addLink(M, local, ri.key, 'l2', 'lldp', src, { hearsay: true, protocols: c.protocols });
    });
    // 被權威端改寫過的「聽說」介面，若沒有任何連結參考就移除
    const used = new Set(); M.links.forEach((l) => { used.add(l.a); used.add(l.b); });
    M.ifcs.forEach((i, k) => { if (i.hearsay && !used.has(k) && M.devices.get(i.dev).collected) M.ifcs.delete(k); });
  }

  /** OSPF 鄰接：用位址找對端介面，再用 router-id、管理 IP 找對端設備；都找不到就建立以鄰居 ID 命名的未知設備。 */
  function buildOspfLinks(M, canon) {
    const ipOwner = new Map(); const ridOwner = new Map(); const mgmtOwner = new Map();
    M.ifcs.forEach((i) => i.ips.forEach((c) => ipOwner.set(c.split('/')[0], i.key)));
    M.devices.forEach((d) => { if (d.routerId) ridOwner.set(d.routerId, d.key); if (d.mgmtIp) mgmtOwner.set(d.mgmtIp, d.key); });
    const subnetsOf = new Map();
    M.ifcs.forEach((i) => i.ips.forEach((c) => { const p = S.ip.parseCidr(c); if (p && p.len < 32) getOr(subnetsOf, i.dev, () => []).push({ ep: i.key, net: p.net, len: p.len }); }));
    M.ospf.forEach((f) => {
      if (f.ifc) f.localEp = K.ep(f.dev, f.ifc);
      else {
        const hit = (subnetsOf.get(f.dev) || []).filter((x) => S.ip.inNet(f.nbrAddr, x.net, x.len)).sort((a, b) => b.len - a.len)[0];
        f.localEp = hit ? hit.ep : iface(M, f.dev, `?(ospf ${f.nbrAddr})`).key;
      }
    });
    M.ospf.forEach((f) => {
      const local = f.localEp;
      let remote = ipOwner.get(f.nbrAddr);
      let peerDev = remote ? K.splitEp(remote)[0] : ridOwner.get(f.nbrId) || ipOwner.get(f.nbrId) && K.splitEp(ipOwner.get(f.nbrId))[0] || mgmtOwner.get(f.nbrId);
      if (!peerDev) {
        const name = canon(f.nbrId); peerDev = K.dev(name);
        device(M, peerDev, name).seenBy.add(f.dev);
        M.notes.r02.push({ dev: f.dev, ifc: K.splitEp(f.localEp)[1], nbrId: f.nbrId, nbrAddr: f.nbrAddr, block: f.block, line: f.line });
      }
      if (!remote) { const ri = iface(M, peerDev, f.nbrAddr); ri.hearsay = true; ri.ips.add(f.nbrAddr + '/32'); remote = ri.key; }
      const l = addLink(M, local, remote, 'l3', 'ospf', [f.block, f.line]);
      if (M.ospf.some((g) => g.dev === peerDev && g.localEp === remote)) l.ospfBoth = true;
    });
  }

  S.model = { build };
})(globalThis.SSOT = globalThis.SSOT || {});
