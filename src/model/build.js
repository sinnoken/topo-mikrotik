/*
 * 建模：事實（fact）→ 實體（device / interface / link / vlan / mac / arp / route）。
 * 只依唯一鍵（core/keys.js）合併，不看命名規則。結果是內部結構 M（Map/Set），由 pipeline 序列化成 Snapshot。
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const LINK_SCOPE = S.LINK_SCOPE;
  const getOr = S.util.getOr;
  const MAX_SRC = 4;

  function addSrc(ent, f) { if (ent.src.length < MAX_SRC) ent.src.push([f.block, f.line]); }

  function newModel() {
    return {
      devices: new Map(), ifcs: new Map(), links: new Map(), vlans: new Map(), macs: new Map(),
      arps: [], routes: [], claims: [], ospf: [], ospfAdjacencies: [], vmems: [],
      notes: { k01: [], k04: [], r02: [] },
    };
  }

  function device(M, key, name) {
    const d = getOr(M.devices, key, () => ({
      key, names: new Set(), mgmtIp: null, vendors: new Set(), collected: false, data: new Set(),
      hostname: null, routerId: null, seenBy: new Set(), src: [], deviceType: null, softwareVersion: null, platform: null, caps: null,
    }));
    if (name) d.names.add(name);
    return d;
  }

  function iface(M, devKey, name) {
    const key = K.ep(devKey, name);
    return getOr(M.ifcs, key, () => ({
      key, dev: devKey, name: String(name).trim().replace(/\.0$/, ''), desc: null, enabled: null, status: null,
      type: null, typeBasis: null, rawType: null, hwMac: null, defaultName: null, mtu: null, actualMtu: null, l2mtu: null,
      lag: null, lagMembers: new Set(), bridge: null, parent: null, encapVlan: null,
      mode: null, pvid: null, untaggedVlans: new Set(), taggedVlans: new Set(), unresolvedVlans: new Set(),
      ips: new Map(), macs: new Set(), hearsay: false, src: [], // ips：CIDR → 來源 [區塊, 行號]
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
          const peerName = canon(f.peer);
          let peerKey = K.dev(peerName);
          if (!M.devices.has(peerKey) && f.peerAddr && mgmtDev.has(f.peerAddr)) peerKey = mgmtDev.get(f.peerAddr);
          const pd = device(M, peerKey, peerName); pd.seenBy.add(f.dev);
          if (f.peerAddr && !pd.mgmtIp) pd.mgmtIp = f.peerAddr;
          if (f.board && !pd.deviceType) pd.deviceType = f.board;
          if (f.version && !pd.softwareVersion) pd.softwareVersion = f.version;
          if (f.platform && !pd.platform) pd.platform = f.platform;
          if (f.caps && !pd.caps) pd.caps = f.caps;
          M.claims.push({ dev: f.dev, ifc: K.ifc(f.ifc), peer: peerKey, peerIfc: f.peerIfc || '?', chassis: f.chassis, protocols: f.protocols || [], peerIfcAlt: f.peerIfcAlt || null, block: f.block, line: f.line });
          break;
        }
        case 'sys': if (f.board) d.deviceType = f.board; if (f.version) d.softwareVersion = f.version; break; // 設備自報優先於鄰居回報
        case 'ospf': M.ospf.push(f); if (f.ifc) iface(M, f.dev, f.ifc); break;
        case 'vlan': onVlan(M, f); break;
        case 'vmem': M.vmems.push(f); break;
        case 'mac': {
          const mk = K.mac(f.mac); if (!mk) break;
          const i = iface(M, f.dev, f.ifc); i.macs.add(mk); if (!i.status) i.status = 'up'; addSrc(i, f);
          const m = getOr(M.macs, mk, () => ({ mac: mk, seen: new Map(), ips: new Set(), src: [] }));
          const vlans = getOr(m.seen, i.key, () => new Set());
          vlans.add(f.vlan || null); addSrc(m, f);
          break;
        }
        case 'arp': {
          const mk = K.mac(f.mac); if (!mk) break;
          M.arps.push({ ip: f.ip, mac: mk, dev: f.dev, ifc: K.ifc(f.ifc), block: f.block, line: f.line });
          const am = getOr(M.macs, mk, () => ({ mac: mk, seen: new Map(), ips: new Set(), src: [] })); am.ips.add(f.ip); addSrc(am, f);
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
    classifyInterfaces(M);
    buildInterfaceAdjacencyLinks(M);
    buildMndpLinks(M);
    resolveOspfAdjacencies(M, canon);
    return M;
  }

  function onIfc(M, f) {
    const i = iface(M, f.dev, f.ifc); addSrc(i, f);
    if (f.desc != null) i.desc = f.desc;
    if (f.enabled === false) i.enabled = false; // 任一來源停用即為停用
    else if (f.enabled === true && i.enabled === null) i.enabled = true;
    if (f.status) i.status = f.status;
    if (f.lag) i.lag = K.ep(f.dev, f.lag);
    if (f.bridge) i.bridge = K.ep(f.dev, f.bridge);
    if (f.parent) i.parent = K.ep(f.dev, f.parent);
    if (f.encapVlan != null) i.encapVlan = f.encapVlan;
    ['rawType', 'hwMac', 'defaultName', 'mtu', 'actualMtu', 'l2mtu'].forEach((k) => { if (f[k] != null) i[k] = f[k]; });
    if (f.ip && !i.ips.has(f.ip)) i.ips.set(f.ip, [f.block, f.line]);
  }

  /** VLAN 以設備內的 ID 為鍵（RouterOS 的 bridge VLAN 只有 ID）。 */
  const VID = /^\d{1,4}$/;
  const newVlan = (dev, id) => ({ dev, id, name: null, desc: null, members: new Map(), src: [] });
  function onVlan(M, f) {
    if (!VID.test(String(f.id))) return;
    const v = getOr(M.vlans, f.dev + '|' + f.id, () => newVlan(f.dev, +f.id));
    if (f.name) v.name = f.name;
    if (f.desc) v.desc = f.desc;
    addSrc(v, f);
  }

  /**
   * VLAN 成員掛到介面（參考 NetBox Interface 的 untagged／tagged VLAN）：
   * PVID（ingress 預設 VLAN）、untagged、tagged 分開保存；不是數字的 VLAN 記在 unresolvedVlans，不丟棄。
   * VLAN 實體的 members 以 ep → tagged 保存，同一介面有任一 tagged 觀察即為 tagged。
   */
  function resolveVlanMembers(M) {
    M.vmems.forEach((f) => {
      const tok = String(f.vlan).trim();
      const i = iface(M, f.dev, f.ifc); addSrc(i, f);
      if (f.active && !i.status) i.status = 'up';
      if (!VID.test(tok)) { i.unresolvedVlans.add(tok); return; }
      const id = +tok;
      const v = getOr(M.vlans, f.dev + '|' + id, () => newVlan(f.dev, id)); // 只有成員、沒有定義：建立僅 ID 的 VLAN
      v.members.set(i.key, !!f.tagged || !!v.members.get(i.key));
      if (f.pvid) i.pvid = id;
      else if (f.tagged) i.taggedVlans.add(id);
      else i.untaggedVlans.add(id);
    });
    // 埠模式是推論：有 tagged 成員為 tagged（trunk），只有 PVID／untagged 為 access
    M.ifcs.forEach((i) => {
      if (i.taggedVlans.size) i.mode = 'tagged';
      else if (i.untaggedVlans.size || i.pvid != null) i.mode = 'access';
    });
  }

  function buildAggregates(M) {
    M.ifcs.forEach((i) => { if (i.lag) iface(M, i.dev, K.splitEp(i.lag)[1]).lagMembers.add(i.key); });
  }

  /** RouterOS 介面類型 → 封閉列舉（S.IFC_TYPES）。 */
  const RAW_TYPE = [
    [/^ether$/, 'physical'], [/^bridge$/, 'bridge'], [/^vlan$/, 'vlan'], [/^bond(ing)?$/, 'lag'],
    [/^(wifi|wlan|wifiwave2)$/, 'wireless'], [/^loopback$/, 'loopback'],
    [/^(veth|vrrp|eoip|eoipv6|gre|gre6|ipip|ipipv6|vxlan|wg|wireguard|vpls|mesh|ovpn-.*|l2tp-.*|pptp-.*|sstp-.*|pppoe-.*|ppp-.*)$/, 'virtual'],
  ];
  /** 介面類型與依據：rawType（/interface print 或 export 的定義）→ 有聚合成員 → 名稱慣例 → 預設實體埠。 */
  function classifyInterfaces(M) {
    M.ifcs.forEach((i) => {
      if (i.rawType) {
        const hit = RAW_TYPE.find(([re]) => re.test(i.rawType));
        i.type = hit ? hit[1] : 'other'; i.typeBasis = 'rawType';
      } else if (i.lagMembers.size) { i.type = 'lag'; i.typeBasis = 'member'; }
      else if (/^(ae|reth)\d+$/i.test(i.name)) { i.type = 'lag'; i.typeBasis = 'name'; }
      else if (/^bridge/i.test(i.name)) { i.type = 'bridge'; i.typeBasis = 'name'; }
      else { i.type = 'physical'; i.typeBasis = 'default'; }
    });
  }

  function addLink(M, a, b, layer, via, src, extra) {
    const key = K.link(a, b);
    const l = getOr(M.links, key, () => {
      const [x, y] = a < b ? [a, b] : [b, a];
      return { key, a: x, b: y, layer, via: new Set(), verified: false, hearsay: false, protocols: new Set(), evidenceScope: null, observations: [], src: [] };
    });
    if (layer === 'l2') l.layer = 'l2';
    l.via.add(via);
    ((extra && extra.protocols) || []).forEach((p) => l.protocols.add(p));
    if (src && l.src.length < MAX_SRC) l.src.push(src);
    const { protocols, evidenceScope, observations, ...rest } = extra || {};
    if (layer === 'l2') {
      const scope = evidenceScope || (via === 'mndp' ? LINK_SCOPE.BROADCAST_DOMAIN : LINK_SCOPE.INTERFACE_ADJACENCY);
      if (scope === LINK_SCOPE.INTERFACE_ADJACENCY || !l.evidenceScope || l.evidenceScope === LINK_SCOPE.ROUTING_ADJACENCY) l.evidenceScope = scope;
    } else if (!l.evidenceScope) l.evidenceScope = LINK_SCOPE.ROUTING_ADJACENCY;
    if (observations) {
      observations.forEach((observation) => {
        const key = [observation.dev, observation.ifc, observation.peerIfc || '', observation.block, observation.line].join('\u0000');
        if (!l.observations.some((x) => [x.dev, x.ifc, x.peerIfc || '', x.block, x.line].join('\u0000') === key)) l.observations.push(observation);
      });
    }
    Object.assign(l, rest);
    return l;
  }

  /**
   * LLDP/CDP interface-adjacency claims: the local interface is authoritative;
   * MNDP-only observations are handled separately as broadcast-domain reachability.
   */
  const BRIDGE_NAME = /^bridge/i;
  const isBridgeIfc = (M, dev, name) => {
    const i = M.ifcs.get(K.ep(dev, name));
    return i && i.rawType ? i.rawType === 'bridge' : BRIDGE_NAME.test(name);
  };

  function buildInterfaceAdjacencyLinks(M) {
    const byDev = new Map();
    const isMndpOnly = (c) => c.protocols.length > 0 && c.protocols.every((p) => p === 'mndp');
    M.claims.forEach((c) => { if (!isMndpOnly(c)) getOr(byDev, c.dev, () => []).push(c); });
    M.claims.forEach((c) => {
      if (isMndpOnly(c)) return;
      const local = K.ep(c.dev, c.ifc);
      const src = [c.block, c.line];
      if (byDev.has(c.peer)) {
        // 反向：對端的 LLDP 指向本機這個介面；或對端「本機介面」正是我們聽到的埠名（對端的 Port info 可能是描述）
        const unknownPort = c.peerIfc === '?';
        const said = K.ifc(c.peerIfc);
        const theirs = (byDev.get(c.peer) || []).filter((r) => r.peer === c.dev);
        // bridge 本身（如 bridge、bridge1）在兩端可能分別以 bridge 或 bridge/成員回報；兩邊都落在 bridge 視為同一個介面
        const sameIfc = (x, y) => x === y || (isBridgeIfc(M, c.dev, x) && isBridgeIfc(M, c.peer, y)) || (isBridgeIfc(M, c.peer, x) && isBridgeIfc(M, c.dev, y));
        let rev = theirs.find((r) => sameIfc(K.ifc(r.peerIfc), c.ifc)) || (unknownPort ? null : theirs.find((r) => sameIfc(r.ifc, said)));
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

  /** MNDP observes devices in a shared L2 broadcast domain; it does not prove a direct port-to-port link. */
  function buildMndpLinks(M) {
    M.claims.forEach((c) => {
      if (!c.protocols.length || !c.protocols.every((p) => p === 'mndp')) return;
      const local = K.ep(c.dev, c.ifc);
      const rname = c.peerIfc || `?(mndp ${c.dev}:${c.ifc})`;
      const remote = K.ep(c.peer, rname);
      const existed = M.ifcs.has(remote);
      const ri = iface(M, c.peer, rname);
      if (!existed) ri.hearsay = true;
      const src = [c.block, c.line];
      addLink(M, local, remote, 'l2', 'mndp', src, {
        evidenceScope: LINK_SCOPE.BROADCAST_DOMAIN,
        protocols: c.protocols,
        observations: [{
          dev: c.dev, ifc: c.ifc, peerIfc: c.peerIfc || null, block: c.block, line: c.line,
        }],
      });
    });
  }

  /** OSPF 鄰接：用位址找對端介面，再用 router-id、管理 IP 找對端設備；都找不到就建立以鄰居 ID 命名的未知設備。 */
  function resolveOspfAdjacencies(M, canon) {
    const ipOwner = new Map(); const ridOwner = new Map(); const mgmtOwner = new Map();
    M.ifcs.forEach((i) => i.ips.forEach((_, c) => ipOwner.set(c.split('/')[0], i.key)));
    M.devices.forEach((d) => { if (d.routerId) ridOwner.set(d.routerId, d.key); if (d.mgmtIp) mgmtOwner.set(d.mgmtIp, d.key); });
    const subnetsOf = new Map();
    M.ifcs.forEach((i) => i.ips.forEach((_, c) => { const p = S.ip.parseCidr(c); if (p && p.len < 32) getOr(subnetsOf, i.dev, () => []).push({ ep: i.key, net: p.net, len: p.len }); }));
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
      if (!remote) { const ri = iface(M, peerDev, f.nbrAddr); ri.hearsay = true; ri.ips.set(f.nbrAddr + '/32', [f.block, f.line]); remote = ri.key; }
      M.ospfAdjacencies.push({
        dev: f.dev, localEp: local, peerDev, peerEp: remote,
        peerIp: f.nbrAddr, peerId: f.nbrId, block: f.block, line: f.line,
      });
    });
    M.ospfAdjacencies.forEach((a) => {
      a.reciprocal = M.ospfAdjacencies.some((b) =>
        b.dev === a.peerDev && b.peerDev === a.dev && b.localEp === a.peerEp && b.peerEp === a.localEp);
    });
  }

  S.model = { build };
})(globalThis.SSOT = globalThis.SSOT || {});
