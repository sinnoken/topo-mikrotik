/*
 * 推論：在模型上計算衍生屬性。
 *   - 設備類型（依廠牌與資料內容；沒有資料時依對端埠名稱判斷是否為主機）
 *   - 鏈路類別（聚合、管理、速率、L3）
 *   - 鏈路兩端 VLAN（含聚合成員繼承）
 *   - 分群（profile 有 group 用 profile，否則依拓樸鏈路連通元件）
 *   - 套用 profile 註解
 *   - 推論鏈路（inferLinks：沒有 LLDP／CDP 時的替代證據）
 *   - 終端埠（edgeLocations：M.edge、m.edge；介面鄰接索引 M.adjacency 供 check 使用）
 *   - Wi-Fi 客戶端位置（wifiLocations）與未收集交換器底下的終端（behindLocations），使用終端埠結果，放在 edgeLocations 之後
 * pipeline 在檢查之前呼叫 infer，檢查時所有推論都已完成。
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const LINK_SCOPE = S.LINK_SCOPE;
  const HOST_PORT = /^(eth\d|ens\d|eno\d|enp\d|bond\d|em\d+$|nic|vmnic|team|ethernet\s?\d|local area connection)/i;
  const VLAN_DATA = ['config', 'vlans'];

  function infer(M, profile) {
    inferKinds(M);
    linkClasses(M);
    linkVlans(M);
    inferLinks(M);
    vlanDomains(M); // 用到鏈路兩端 VLAN 與推論鏈路
    if (profile) applyProfile(M, profile);
    groups(M);
    edgeLocations(M); // 用到 profile 覆寫後的設備類型與推論鏈路
    wifiLocations(M); // 用到終端埠
    behindLocations(M);
    firewall(M);
  }

  /** 型號 → 類型：CRS／CSS 是交換器；CCR、RB、hAP、hEX、CHR 等是路由器。 */
  function kindFromBoard(board) {
    const b = String(board || '').toUpperCase();
    if (/^(CRS|CSS)/.test(b)) return 'switch';
    if (/^(CCR|RB|HAP|HEX|CHR|NETMETAL|KNOT|L009)/.test(b)) return 'router';
    return null;
  }
  /** 鄰居回報的功能（system-caps-enabled）→ 類型：有 router 是路由器、有 bridge 是交換器、station 是主機。 */
  function kindFromCaps(caps) {
    const c = String(caps || '').toLowerCase();
    if (!c) return null;
    if (/\brouter\b/.test(c)) return 'router';
    if (/\bbridge\b/.test(c)) return 'switch';
    if (/station|telephone|docsis|cvlan|svlan/.test(c)) return 'host';
    return null;
  }

  function inferKinds(M) {
    const peerPortsOf = new Map();
    M.claims.forEach((c) => S.util.getOr(peerPortsOf, c.peer, () => []).push(c.peerIfc));
    M.devices.forEach((d) => {
      d.manufacturer = d.vendors.has('mikrotik') ? 'mikrotik' : (d.platform && /mikrotik|routeros/i.test(d.platform) ? 'mikrotik' : null);
      const byBoard = kindFromBoard(d.deviceType);
      if (d.collected) {
        if (byBoard) { d.kind = byBoard; d.kindBasis = 'board'; return; }
        d.kindBasis = 'data';
        if (d.data.has('ospf')) d.kind = 'router';
        else if ((d.data.has('mac') || d.data.has('vlans')) && !d.data.has('route')) d.kind = 'switch';
        else if (d.data.has('route')) d.kind = 'router';
        else { d.kind = 'router'; d.kindBasis = 'vendor'; }
        return;
      }
      if (byBoard) { d.kind = byBoard; d.kindBasis = 'board'; return; }
      const byCaps = kindFromCaps(d.caps);
      if (byCaps) { d.kind = byCaps; d.kindBasis = 'caps'; return; }
      const ports = peerPortsOf.get(d.key) || [];
      if (ports.length && ports.every((p) => HOST_PORT.test(String(p).trim()))) { d.kind = 'host'; d.kindBasis = 'heuristic'; return; }
      if (d.manufacturer === 'mikrotik') { d.kind = 'router'; d.kindBasis = 'vendor'; return; }
      d.kind = 'unknown'; d.kindBasis = 'none';
    });
  }

  /** RouterOS 介面命名：ether＝1G（也可能是 2.5G、10G 銅纜埠，名稱看不出來）、sfp-sfpplus／qsfpplus 看名稱。 */
  function speedOf(name) {
    if (/^qsfp28|^qsfp28-/.test(name)) return 5;
    if (/^qsfpplus/.test(name)) return 4;
    if (/^sfp28|^sfp-sfpplus|^sfpplus/.test(name)) return 3;
    if (/^(ether|sfp\d|combo)/.test(name)) return 2;
    return 0;
  }
  function linkClasses(M) {
    M.links.forEach((l) => {
      if (l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN) { l.cls = 'other'; return; }
      const ia = M.ifcs.get(l.a); const ib = M.ifcs.get(l.b);
      const names = [ia, ib].map((i) => (i ? i.name.toLowerCase() : ''));
      if ((ia && (ia.lag || ia.type === 'lag')) || (ib && (ib.lag || ib.type === 'lag'))) l.cls = 'lag';
      else if (names.some((n) => /^(mgmt|oob|management)/.test(n))) l.cls = 'oob';
      else {
        const s = Math.max(speedOf(names[0]), speedOf(names[1]));
        l.cls = s >= 4 ? '40g' : s === 3 ? '10g' : s === 2 ? '1g' : 'other';
      }
    });
  }

  /** 介面的實際 VLAN：自己的 ∪ 所屬聚合介面的 */
  function effVlans(M, ep) {
    const i = M.ifcs.get(ep);
    if (!i) return [];
    const set = new Set(S.util.ifcVlans(i));
    if (i.lag) { const p = M.ifcs.get(i.lag); if (p) S.util.ifcVlans(p).forEach((v) => set.add(v)); }
    return S.util.numSort(Array.from(set));
  }
  /**
   * 介面的 VLAN 依出埠方式分開：untagged＝PVID ∪ untaggedVlans，tagged＝taggedVlans；聚合成員加上所屬聚合介面的值（同 effVlans）。
   * 回傳 { untagged: Set, tagged: Set }（V06 使用）。
   */
  function effVlanModes(M, ep) {
    const untagged = new Set(); const tagged = new Set();
    const i = M.ifcs.get(ep);
    const add = (x) => {
      if (x.pvid != null) untagged.add(x.pvid);
      x.untaggedVlans.forEach((v) => untagged.add(v));
      x.taggedVlans.forEach((v) => tagged.add(v));
    };
    if (i) { add(i); const p = i.lag && M.ifcs.get(i.lag); if (p) add(p); }
    return { untagged, tagged };
  }
  /**
   * 一個 VLAN ID 的承載情況與不相連區塊（推論，設計說明 §5.3「VLAN 區塊」）。內部模型與 Snapshot 共用：
   *   src = { vlans, interfaces, links, inferred（推論鏈路）, ifc(ep), collected(dev) }，集合可為陣列或 Map/Set 的迭代器。
   * domains 依承載此 VLAN 的鏈路與推論鏈路相連；只經由未收集設備相連也算同一塊，但那台設備不列入。
   */
  function vlanSpan(src, id) {
    const devOf = (ep) => K.splitEp(ep)[0];
    const entries = Array.from(src.vlans).filter((v) => v.id === id);
    const carry = []; const partial = [];
    for (const l of src.links) {
      if (l.layer !== 'l2') continue;
      const inA = l.vlansA.includes(id); const inB = l.vlansB.includes(id);
      if (inA && inB) carry.push(l); else if ((inA || inB) && l.vlanComparable !== false && l.vlanMismatch) partial.push(l);
    }
    const devs = S.util.uniq(entries.map((v) => v.dev));
    for (const i of src.interfaces) if (S.util.ifcVlans(i).includes(id) && !devs.includes(i.dev)) devs.push(i.dev);
    // 推論鏈路：已收集的每一端（或其所屬聚合）都帶這個 VLAN；未收集的一端無從得知，屬推論
    const hasVlan = (ep) => { const i = src.ifc(ep); return !!i && S.util.ifcVlans(i).includes(id); };
    const inferred = Array.from(src.inferred).filter((l) => {
      const known = [l.a, l.b].filter((ep) => src.ifc(ep) && src.collected(devOf(ep)));
      return known.length && known.every((ep) => hasVlan(ep) || Array.from(src.ifc(ep).lagMembers || []).some(hasVlan));
    });
    const devices = devs.sort(S.util.natural);
    const own = new Set(devices);
    const bridging = S.util.uniq(inferred.flatMap((l) => [devOf(l.a), devOf(l.b)])).filter((d) => !own.has(d));
    const domains = S.util.components(devices.concat(bridging), carry.concat(inferred).map((l) => [devOf(l.a), devOf(l.b)]))
      .map((ks) => ks.filter((d) => own.has(d))).filter((ks) => ks.length)
      .map((ks) => ({ key: id + '@' + ks[0], devices: ks }));
    return { entries, devices, carry, partial, inferred, domains };
  }
  /** 每個 VLAN ID 的承載情況與不相連區塊（M.vlanSpans：Map(id → vlanSpan 的結果)），check 的 A02、V06、A06 只讀這個結果。 */
  function vlanDomains(M) {
    const ids = new Set();
    M.vlans.forEach((v) => { if (v.id != null) ids.add(v.id); });
    M.ifcs.forEach((i) => S.util.ifcVlans(i).forEach((v) => ids.add(v)));
    // vlanSpan 的集合可以是迭代器，每個 VLAN 各用一組新的
    const src = () => ({ vlans: M.vlans.values(), interfaces: M.ifcs.values(), links: M.links.values(), inferred: M.inferred || [], ifc: (ep) => M.ifcs.get(ep), collected: (d) => !!(M.devices.get(d) || {}).collected });
    M.vlanSpans = new Map();
    S.util.numSort(Array.from(ids)).forEach((id) => M.vlanSpans.set(id, vlanSpan(src(), id)));
  }
  function linkVlans(M) {
    M.links.forEach((l) => {
      if (l.layer !== 'l2') return;
      if (l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN) {
        l.vlansA = []; l.vlansB = []; l.vlansCommon = []; l.vlanComparable = false; l.vlanMismatch = false;
        return;
      }
      l.vlansA = effVlans(M, l.a); l.vlansB = effVlans(M, l.b);
      const sb = new Set(l.vlansB);
      l.vlansCommon = l.vlansA.filter((v) => sb.has(v));
      const da = M.devices.get(K.splitEp(l.a)[0]); const db = M.devices.get(K.splitEp(l.b)[0]);
      const hasData = (d) => d && VLAN_DATA.some((t) => d.data.has(t));
      l.vlanComparable = hasData(da) && hasData(db) && !l.hearsay;
      // 兩端都有 VLAN 資料時，任一端有對方沒有的 VLAN 就是不一致（V01）；effVlans 已去重
      l.vlanMismatch = l.vlanComparable && (l.vlansCommon.length < l.vlansA.length || l.vlansCommon.length < l.vlansB.length);
    });
  }

  function applyProfile(M, profile) {
    M.devices.forEach((d) => {
      const name = displayName(d);
      const a = profile.annotate(name);
      if (a.kind && a.kind !== d.kind) { d.kindFromData = d.kind; d.kind = a.kind; d.kindBasis = 'profile'; }
      if (a.role) d.role = a.role;
      if (a.site) d.site = a.site;
      if (a.group) d.group = a.group;
      if (a.label) d.label = a.label;
    });
  }

  /** 未指定分群的設備依拓樸鏈路連通元件分群；名稱不代表 IP 子網或物理區域。 */
  function groups(M) {
    const keys = Array.from(M.devices.keys());
    const comps = S.util.components(keys, Array.from(M.links.values(), (l) => [K.splitEp(l.a)[0], K.splitEp(l.b)[0]]))
      .map((ks) => ks.map((k) => M.devices.get(k)));
    const sorted = comps.sort((x, y) => y.length - x.length || S.util.natural(x[0].key, y[0].key));
    sorted.forEach((members, idx) => members.forEach((d) => { d.component = idx + 1; if (!d.group) d.group = '自動群組 ' + (idx + 1); }));
  }

  /**
   * 推論鏈路（推論，不寫進 links，不影響任何檢查）：沒有 LLDP／CDP 的設備（例如只支援 MNDP 的 SwOS 交換器）用其他證據推定相鄰。
   *   subnet-p2p ：兩台已收集設備的介面位址在同一個 /30 或 /31，且該網段只有這兩台
   *   mndp-mutual：兩台已收集設備的 MNDP 互相回報對方的埠，且兩個埠都只看到對方
   *   mndp-unique：已收集設備的某埠只看到一台 MNDP 鄰居 X（X 未收集），X 也只出現在這個埠
   *   fdb        ：MAC 表。A 的 p 埠學到 X 的 MAC，且 p 這側其他已知設備都可由已收集交換器的 MAC 表證明在 X 後面或兩者之間
   * MNDP 會穿過未管理交換器，只證明 L2 可達，所以 MNDP 只當佐證：至少要有一項非 MNDP 的證據（fdb、subnet-p2p）才成立推論；
   * MNDP 同時成立時提高信心。推論的意義都是「直接相連，或中間只有未管理設備」。
   * 已有 LLDP／CDP 鏈路的設備對不推論；埠（含所屬聚合）已有 LLDP／CDP 鄰接到已收集設備時，不推論該埠後面的設備直接相連。
   */
  function inferLinks(M) {
    const devOf = (ep) => K.splitEp(ep)[0];
    const collected = (k) => { const d = M.devices.get(k); return !!(d && d.collected); };
    const pairKey = (x, y) => (x < y ? x + '~' + y : y + '~' + x);
    const adjByEp = new Map(); const lldpPairs = new Set();
    M.links.forEach((l) => {
      if (l.layer !== 'l2' || l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN) return;
      S.util.getOr(adjByEp, l.a, () => []).push(devOf(l.b)); S.util.getOr(adjByEp, l.b, () => []).push(devOf(l.a));
      lldpPairs.add(pairKey(devOf(l.a), devOf(l.b)));
    });
    const group = (ep) => { const i = M.ifcs.get(ep); if (!i) return [ep]; const p = i.lag && M.ifcs.get(i.lag); return [ep, ...i.lagMembers, ...(p ? [p.key, ...p.lagMembers] : [])]; };
    const lldpToCollected = (ep) => group(ep).some((e) => (adjByEp.get(e) || []).some(collected));
    const ifcName = (ep) => { const i = M.ifcs.get(ep); return i ? i.name : K.splitEp(ep)[1]; };
    const mndpOnly = (c) => c.protocols.length > 0 && c.protocols.every((p) => p === 'mndp');
    // 對端沒有收集資料時，對端埠用它在 MNDP 回報的埠名；沒有就標為不明
    const peerEp = (a, x) => {
      const c = M.claims.find((k) => k.dev === devOf(a) && k.peer === x && group(a).includes(K.ep(k.dev, k.ifc)) && k.peerIfc && k.peerIfc !== '?');
      return K.ep(x, c ? c.peerIfc : `?(${devOf(a)}:${ifcName(a)})`);
    };
    const out = new Map();
    const add = (a, b, basis, text, src) => {
      if (devOf(a) === devOf(b) || lldpPairs.has(pairKey(devOf(a), devOf(b)))) return;
      const key = K.link(a, b);
      const r = S.util.getOr(out, key, () => ({ key, a: a < b ? a : b, b: a < b ? b : a, bases: new Set(), evidence: [] }));
      if (r.bases.has(basis)) return;
      r.bases.add(basis); r.evidence.push({ basis, text, src: src.filter(Boolean).slice(0, 4) });
    };

    // subnet-p2p
    const byNet = new Map();
    M.ifcs.forEach((i) => {
      if (i.hearsay || !collected(i.dev)) return;
      i.ips.forEach((src, cidr) => { const p = S.ip.parseCidr(cidr); if (p && (p.len === 30 || p.len === 31)) S.util.getOr(byNet, `${p.net}/${p.len}`, () => []).push({ ep: i.key, dev: i.dev, ip: p.ip, src }); });
    });
    byNet.forEach((xs, net) => {
      if (xs.length !== 2 || xs[0].dev === xs[1].dev) return;
      add(xs[0].ep, xs[1].ep, 'subnet-p2p', `${xs[0].ip} 與 ${xs[1].ip} 在同一個點對點網段 ${net}`, [xs[0].src, xs[1].src]);
    });

    // mndp-mutual／mndp-unique
    const mndpByPort = new Map();
    M.claims.filter(mndpOnly).forEach((c) => S.util.getOr(mndpByPort, K.ep(c.dev, c.ifc), () => []).push(c));
    const peersOn = (ep) => S.util.uniq((mndpByPort.get(ep) || []).map((c) => c.peer));
    const portsSeeing = (a, x) => S.util.uniq(M.claims.filter((c) => mndpOnly(c) && c.dev === a && c.peer === x).map((c) => K.ep(c.dev, c.ifc)));
    mndpByPort.forEach((cs, ep) => {
      const a = devOf(ep); const peers = peersOn(ep);
      if (!collected(a) || lldpToCollected(ep) || peers.length !== 1 || portsSeeing(a, peers[0]).length !== 1) return;
      const x = peers[0]; const c = cs[0];
      if (collected(x)) {
        if (!c.peerIfc || c.peerIfc === '?') return;
        const q = K.ep(x, c.peerIfc); const back = mndpByPort.get(q) || [];
        if (peersOn(q).length !== 1 || peersOn(q)[0] !== a || !back.some((b) => b.peerIfc && K.ifc(b.peerIfc) === K.splitEp(ep)[1])) return;
        add(ep, q, 'mndp-mutual', `${a} ${ifcName(ep)} 與 ${x} ${ifcName(q)} 的 MNDP 互相回報對方的埠，兩個埠都只看到對方`, [[c.block, c.line], [back[0].block, back[0].line]]);
      } else {
        add(ep, peerEp(ep, x), 'mndp-unique', `${a} ${ifcName(ep)} 只看到 ${x} 一台 MNDP 鄰居，${x} 也只出現在這個埠（${x} 沒有收集資料）`, [[c.block, c.line]]);
      }
    });

    // fdb：已知 MAC 的設備＝已收集設備自己的 MAC（MAC 表的 L 項目、介面 MAC）＋鄰居表回報的 MAC
    const macOwner = new Map();
    M.devices.forEach((d) => d.ownMacs.forEach((m) => macOwner.set(m, d.key)));
    M.ifcs.forEach((i) => { const m = i.hwMac && K.mac(i.hwMac); if (m && collected(i.dev)) macOwner.set(m, i.dev); });
    M.claims.forEach((c) => { const m = c.chassis && K.mac(c.chassis); if (m && !macOwner.has(m)) macOwner.set(m, c.peer); });
    const seenOn = new Map(); const seenSrc = new Map(); const portsOf = new Map();
    M.macs.forEach((m) => {
      const owner = macOwner.get(m.mac); if (!owner) return;
      m.seen.forEach((_, ep) => {
        if (devOf(ep) === owner) return;
        S.util.getOr(seenOn, ep, () => new Set()).add(owner);
        if (!seenSrc.has(ep + '>' + owner)) seenSrc.set(ep + '>' + owner, S.model.firstSeenSrc(m, ep));
        const ports = S.util.getOr(portsOf, devOf(ep) + '>' + owner, () => []); if (!ports.includes(ep)) ports.push(ep);
      });
    });
    const hasFdb = (k) => { const d = M.devices.get(k); return !!(d && d.collected && d.data.has('mac')); };
    // 會轉送二層的設備：有 MAC 表或有 bridge 介面；未收集的設備不知道，視為可能轉送
    const bridgeDevs = new Set(); M.ifcs.forEach((i) => { if (i.type === 'bridge') bridgeDevs.add(i.dev); });
    const bridging = (k) => !collected(k) || hasFdb(k) || bridgeDevs.has(k);
    const behindSwitch = (v, a, side) => side.some((y) => y !== v && hasFdb(y) && (portsOf.get(y + '>' + a) || []).length
      && (portsOf.get(y + '>' + v) || []).some((q) => !(portsOf.get(y + '>' + a) || []).includes(q)));
    seenOn.forEach((set, ep) => {
      const a = devOf(ep); if (lldpToCollected(ep)) return;
      const side = Array.from(set);
      const cands = side.filter((v) => {
        if (behindSwitch(v, a, side)) return false;                                  // v 在已收集交換器 y 後面（y 在不朝向 a 的埠看到 v）
        if (side.length > 1 && !bridging(v)) return false;                           // 不轉送二層的設備不可能夾在中間，其他設備的 MAC 不會經過它
        if (hasFdb(v)) { const qs = portsOf.get(v + '>' + a) || []; return qs.length === 1 && !side.some((w) => w !== v && (seenOn.get(qs[0]) || new Set()).has(w)); } // 兩側看到同一台：中間還有設備
        return true;
      });
      if (cands.length !== 1) return;
      const x = cands[0];
      if (collected(x) && !hasFdb(x)) return; // 已收集但沒有 MAC 表：只能單向，不推論
      const b = hasFdb(x) ? portsOf.get(x + '>' + a)[0] : peerEp(ep, x);
      add(ep, b, 'fdb', hasFdb(x)
        ? `${a} ${ifcName(ep)} 學到 ${x} 的 MAC，${x} ${ifcName(b)} 學到 ${a} 的 MAC，兩側沒有共同的其他已知設備`
        : `${a} ${ifcName(ep)} 學到 ${x} 的 MAC，同一埠的其他已知設備都可證明在 ${x} 後面或之間（${x} 沒有收集資料）`,
      [seenSrc.get(ep + '>' + x), hasFdb(x) ? seenSrc.get(b + '>' + a) : null]);
      if (collected(x)) return;
      // x 是 a 經 p 直接相連的未收集交換器：同一埠學到、沒有 MAC 表的已收集設備（例如沒有 bridge 的路由器）推定接在 x 後面。
      // p 這側若還有其他未收集的設備，無法確定接在哪一台，不推論。
      if (side.some((w) => w !== x && !collected(w) && !behindSwitch(w, a, side))) return;
      side.filter((z) => z !== x && collected(z) && !hasFdb(z) && !behindSwitch(z, a, side)).forEach((z) => {
        const zp = portsSeeing(z, x);
        const zEp = K.ep(z, zp.length === 1 ? K.splitEp(zp[0])[1] : `?(${x})`);
        add(zEp, K.ep(x, `?(${z}:${ifcName(zEp)})`), 'fdb', `${a} ${ifcName(ep)} 已推定直接接到 ${x}，同一埠也學到 ${z} 的 MAC；${z} 沒有 MAC 表，推定接在 ${x} 後面${zp.length === 1 ? `（${z} 在 ${ifcName(zEp)} 以 MNDP 看到 ${x}）` : ''}`,
          [seenSrc.get(ep + '>' + z)]);
      });
    });

    // stp：埠的 RSTP 角色是 root／alternate／backup 時，designated-bridge 是這段網路的上游橋接器（BPDU 不會穿過 STP 橋接器，
    // 但會穿過不跑 STP 的未管理交換器，所以同樣是「直接相連，或中間只有未管理設備」）。對端也有 STP 資料時以 designated port 編號對回確切的埠。
    M.ifcs.forEach((i) => {
      const st = i.stp; if (!st || !st.designatedBridge || !/^(root|alternate|backup)/.test(st.role || '') || !collected(i.dev) || lldpToCollected(i.key)) return;
      const x = macOwner.get(st.designatedBridge); if (!x || x === i.dev) return;
      let b = null;
      if (collected(x) && st.designatedPort != null) { const q = Array.from(M.ifcs.values()).find((j) => j.dev === x && j.stp && j.stp.portNumber === st.designatedPort); if (q) b = q.key; }
      add(i.key, b || peerEp(i.key, x), 'stp', `${i.dev} ${i.name} 的 RSTP 角色是 ${st.role}，指定橋接器是 ${x}（${K.macPretty(st.designatedBridge)}）${b ? `，對方的指定埠是 ${ifcName(b)}` : ''}`, [st.src]);
    });

    // 推定位置的錨點：已收集、有 MAC 表的設備 a 的埠 p，沒有 LLDP 鄰接到已收集設備，且 p 這側有未收集的交換器或路由器
    // （例如 SwOS 的 CSS106），而且沒有被證明在別台已收集交換器後面。這個埠學到的終端推定在這些設備底下（behindLocations）。
    M.behindAnchors = new Map();
    seenOn.forEach((set, ep) => {
      const a = devOf(ep); if (!hasFdb(a) || lldpToCollected(ep)) return;
      const side = Array.from(set);
      const via = side.filter((v) => { const d = M.devices.get(v); return d && !d.collected && (d.kind === 'switch' || d.kind === 'router') && !behindSwitch(v, a, side); });
      if (via.length) M.behindAnchors.set(ep, { dev: a, via: via.sort(S.util.natural), side: side.filter(hasFdb) });
    });
    M.fdbIndex = { portsOf, macOwner }; // 供 behindLocations 使用（內部，不序列化）

    // 合併：不同依據取用的埠不同（成員埠／聚合、VLAN 介面／實體埠、不明埠代號），同一條鏈路要併成一筆，且在過濾「只有 MNDP」之前做
    const lagOf = (ep) => { const i = M.ifcs.get(ep); return i && i.lag ? i.lag : ep; };
    const unknownPort = (ep) => K.splitEp(ep)[1].startsWith('?(');
    const merged = new Map();
    out.forEach((r) => {
      let [a, b] = [r.a, r.b].map((ep) => (collected(devOf(ep)) ? lagOf(ep) : ep));
      // 對端埠不明：依合併後的本機埠重新產生代號，同一對（本機埠、對端設備）一定得到同一個代號
      if (unknownPort(a)) a = K.ep(devOf(a), `?(${devOf(b)}:${ifcName(b)})`);
      if (unknownPort(b)) b = K.ep(devOf(b), `?(${devOf(a)}:${ifcName(a)})`);
      const key = K.link(a, b);
      const m = S.util.getOr(merged, key, () => ({ key, a: a < b ? a : b, b: a < b ? b : a, bases: new Set(), evidence: [] }));
      r.evidence.forEach((e) => { if (!m.bases.has(e.basis)) { m.bases.add(e.basis); m.evidence.push(e); } });
    });
    // 已知對端埠名（例如 MNDP 有回報）時，取代同一本機埠、同一對端設備的「埠不明」那一筆
    merged.forEach((r, key) => {
      const ends = [r.a, r.b]; const u = ends.find(unknownPort); if (!u) return;
      const local = ends.find((e) => e !== u);
      const known = Array.from(merged.values()).find((x) => x !== r && [x.a, x.b].includes(local) && [x.a, x.b].some((e) => e !== local && devOf(e) === devOf(u) && !unknownPort(e)));
      if (!known) return;
      r.evidence.forEach((e) => { if (!known.bases.has(e.basis)) { known.bases.add(e.basis); known.evidence.push(e); } });
      merged.delete(key);
    });
    // 只在 VLAN／bridge 介面上的 /30 證據：同一對設備另外剛好只有一條實體埠的推論時，併進那一條（有多條時無法確定是哪一條）
    const physical = (ep) => { const i = M.ifcs.get(ep); return !i || !['vlan', 'bridge', 'virtual', 'loopback'].includes(i.type); };
    merged.forEach((r, key) => {
      if (Array.from(r.bases).some((x) => x !== 'subnet-p2p') || [r.a, r.b].every(physical)) return;
      const pair = [devOf(r.a), devOf(r.b)].sort().join('~');
      const others = Array.from(merged.values()).filter((x) => x !== r && [devOf(x.a), devOf(x.b)].sort().join('~') === pair && [x.a, x.b].every(physical));
      if (others.length !== 1) return;
      r.evidence.forEach((e) => { if (!others[0].bases.has(e.basis)) { others[0].bases.add(e.basis); others[0].evidence.push(e); } });
      merged.delete(key);
    });

    const MNDP_ONLY = new Set(['mndp-mutual', 'mndp-unique']);
    M.inferred = Array.from(merged.values()).filter((r) => Array.from(r.bases).some((b) => !MNDP_ONLY.has(b)))
      .map((r) => ({ ...r, bases: Array.from(r.bases).sort(), confidence: r.bases.size >= 2 ? 'high' : 'medium' }));
  }

  /**
   * 虛擬介面（不會是終端埠，也不列入 A04）：有 RouterOS 原始 type 時依事實判斷；沒有介面資料時才退回名稱推論。
   * 名稱規則包含 bridge，與 rawType=bridge 的結果一致（bridge 介面上學到的是 bridge 本身或本機項目，不是外部終端）。
   * 只讀 rawType 與 name，內部模型 M 與序列化後的 Snapshot 介面都適用（query 的 Wi-Fi 區段也用它）。
   */
  const NON_EDGE_TYPES = new Set(['bridge', 'vlan', 'loopback', 'vrrp']);
  const VIRTUAL_NAME = /^(irb|vlan|lo\d|bridge)/;
  function isVirtualIfc(i) {
    return i.rawType ? NON_EDGE_TYPES.has(i.rawType) : VIRTUAL_NAME.test(i.name);
  }
  /** 各設備自己的介面 MAC（/interface print 的 mac-address）：Map(dev → Set(mac))；出現在轉發表時不是外部終端。 */
  function hwMacsByDev(M) {
    const out = new Map();
    M.ifcs.forEach((i) => { const m = i.hwMac && K.mac(i.hwMac); if (m) S.util.getOr(out, i.dev, () => new Set()).add(m); });
    return out;
  }
  /** 介面鄰接索引：ep → 經過該埠的 L2 鏈路，不含只證明廣播網域可達的 MNDP 鏈路（終端埠、K02、A04 共用）。 */
  function adjacencyByEp(M) {
    const out = new Map();
    M.links.forEach((l) => {
      if (l.layer !== 'l2' || l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN) return;
      [l.a, l.b].forEach((ep) => S.util.getOr(out, ep, () => []).push(l));
    });
    return out;
  }
  /**
   * 終端埠（推論）：M.edge＝Map(ep → { linked })，m.edge＝該 MAC 出現的終端埠（排序）。
   * 介面鄰接索引存成 M.adjacency 供 check（K02、A04）直接讀：edgeLocations 是 infer 最後一步，之後 M.links 不再變動。
   */
  function edgeLocations(M) {
    M.adjacency = adjacencyByEp(M);
    const edge = edgePorts(M, M.adjacency);
    M.edge = edge;
    M.macs.forEach((m) => { m.edge = Array.from(m.seen.keys()).filter((ep) => edge.has(ep)).sort(); });
  }
  /**
   * 終端埠：已收集設備上、恰好學到一個 MAC、非 Wi-Fi、狀態不是 down 的介面，
   * 且沒有連到其他「已收集的網路設備」（連到主機或未收集設備的埠仍算終端），也沒有推論鏈路。
   * adjacencyLinksByEp（adjacencyByEp）僅包含介面鄰接證據；廣播網域（MNDP）可達不代表該埠有 LLDP／CDP 鄰接。
   * 回傳 Map(ep → { linked: 是否有任何 LLDP／CDP 鄰接 })
   */
  function edgePorts(M, adjacencyLinksByEp) {
    const out = new Map();
    const toInfra = (ep) => (adjacencyLinksByEp.get(ep) || []).some((l) => {
      const peer = M.devices.get(K.splitEp(l.a === ep ? l.b : l.a)[0]);
      return peer && peer.collected && peer.kind !== 'host';
    });
    const hasAdjacency = (ep) => adjacencyLinksByEp.has(ep);
    // 已推論接到網路設備（例如底下沒有其他終端的 CSS106，MAC 表只剩它自己）的埠不是終端埠
    const inferredEps = new Set((M.inferred || []).flatMap((r) => [r.a, r.b]));
    const ownMacs = hwMacsByDev(M);
    M.ifcs.forEach((i, ep) => {
      if (i.macs.size !== 1 || i.type === 'wireless' || i.status === 'down' || i.enabled === false || isVirtualIfc(i)) return;
      if (!M.devices.get(i.dev).collected) return;
      const own = ownMacs.get(i.dev);
      if (own && own.has(Array.from(i.macs)[0])) return;
      const group = [ep];
      if (i.lag) { const p = M.ifcs.get(i.lag); if (p) group.push(p.key, ...p.lagMembers); }
      group.push(...i.lagMembers);
      if (group.some((g) => toInfra(g) || inferredEps.has(g))) return;
      out.set(ep, { linked: group.some(hasAdjacency) });
    });
    return out;
  }

  /**
   * Wi-Fi 客戶端位置（推論）：依證據強度選一個位置，其餘列為候選。
   *   registration：關聯表（最強）。多台 AP 都有時取 last-activity 最小（最近有活動）者，其餘視為可能漫遊
   *   bridge-wifi ：已收集設備的 MAC 表在無線介面學到
   *   via-ap-port ：交換器埠的鄰居是 AP（鄰居回報 wlan-ap 功能，或型號為 cAP／wAP）且 AP 沒有收集資料；無法區分有線或無線
   * 只有出現 Wi-Fi 證據的 MAC 才有 wifi；已判定為有線終端埠的 MAC、AP 自己的 MAC 不套用 via-ap-port。
   * 使用 edgeLocations 算出的 m.edge，所以必須在 infer 之後呼叫。
   */
  const AP_BOARD = /^(cAP|wAP)/i;
  function wifiLocations(M) {
    const assocByMac = new Map(); M.assocs.forEach((a) => S.util.getOr(assocByMac, a.mac, () => []).push(a));
    const isAp = (d) => !!d && (/\bwlan-ap\b/i.test(d.caps || '') || AP_BOARD.test(d.deviceType || ''));
    const apOfEp = new Map(); // 交換器埠 → 鄰居 AP（AP 自己沒有收集資料時才需要用到）
    M.links.forEach((l) => [[l.a, l.b], [l.b, l.a]].forEach(([mine, other]) => {
      const peer = M.devices.get(K.splitEp(other)[0]);
      if (isAp(peer) && !peer.collected) apOfEp.set(mine, peer.key);
    }));
    const apChassis = new Set(M.claims.filter((c) => c.chassis && isAp(M.devices.get(c.peer))).map((c) => K.mac(c.chassis)));
    const byRecency = (a, b) => (a.lastActivity ?? Infinity) - (b.lastActivity ?? Infinity) || S.util.natural(a.ep, b.ep);
    M.macs.forEach((m) => {
      const regs = (assocByMac.get(m.mac) || []).slice().sort(byRecency);
      let basis = null; let picks = [];
      if (regs.length) { basis = 'registration'; picks = regs; }
      else {
        const eps = Array.from(m.seen.keys()).sort(S.util.natural);
        const wifiEps = eps.filter((ep) => { const i = M.ifcs.get(ep); return i && i.type === 'wireless' && M.devices.get(i.dev).collected; });
        if (wifiEps.length) { basis = 'bridge-wifi'; picks = wifiEps.map((ep) => ({ ep, dev: K.splitEp(ep)[0] })); }
        else if (!(m.edge && m.edge.length) && !apChassis.has(m.mac)) {
          const viaAp = eps.filter((ep) => apOfEp.has(ep));
          if (viaAp.length) { basis = 'via-ap-port'; picks = viaAp.map((ep) => ({ ep, dev: apOfEp.get(ep) })); }
        }
      }
      if (!basis) { m.wifi = null; return; }
      const cur = picks[0];
      m.wifi = {
        basis, dev: cur.dev, ep: cur.ep, ssid: cur.ssid || null, band: cur.band || null, vlan: cur.vlan ?? null,
        ip: cur.ip || null, hostname: cur.hostname || null, signal: cur.signal ?? null, lastActivity: cur.lastActivity ?? null,
        candidates: picks.slice(1).map((p) => p.ep), roaming: new Set(picks.map((p) => p.dev)).size > 1,
      };
    });
  }

  /**
   * 未收集交換器底下的終端（推論，位置精確到設備、埠不明）：MAC 在推定錨點的埠上學到，且
   *   - 不是已知設備自己的 MAC、沒有已確定的位置（終端埠、Wi-Fi）
   *   - 沒有在錨點那一側其他已收集交換器「不朝向錨點設備」的埠出現（否則在那台交換器後面）
   * 錨點那一側只有一台未收集設備時 dev 為該設備；有多台（例如 CSS106 再串 CSS610）時 dev 為 null，via 列出全部。
   * 同一 MAC 有多個錨點時，取那一側已收集交換器最少者（最靠近終端）。使用 edgeLocations 算出的 m.edge。
   */
  function behindLocations(M) {
    const { portsOf, macOwner } = M.fdbIndex || {};
    M.macs.forEach((m) => {
      m.behind = null;
      if (!portsOf || m.wifi || (m.edge && m.edge.length) || macOwner.has(m.mac)) return;
      const hits = Array.from(m.seen.keys()).filter((ep) => M.behindAnchors.has(ep)).filter((ep) => {
        const an = M.behindAnchors.get(ep);
        return !an.side.some((y) => { const toward = portsOf.get(y + '>' + an.dev) || []; return Array.from(m.seen.keys()).some((q) => K.splitEp(q)[0] === y && !toward.includes(q)); });
      }).sort((x, y) => M.behindAnchors.get(x).side.length - M.behindAnchors.get(y).side.length || S.util.natural(x, y));
      if (!hits.length) return;
      const an = M.behindAnchors.get(hits[0]);
      m.behind = { anchor: hits[0], via: an.via, dev: an.via.length === 1 ? an.via[0] : null, basis: 'fdb' };
    });
  }

  // ================================================================ 防火牆
  /*
   * 規則比對的語意（推論與檢查共用，也供 query 對序列化後的 Snapshot 使用，所以只讀純資料：rule.match／action／disabled）。
   *   covers(ctx, i, j)：規則 i 是否涵蓋 j（符合 j 的封包一定符合 i）。i 帶不確定的比對（limit、random…）時一律不涵蓋。
   *   evalChain(ctx, …, pkt)：一個「來自 WAN 的新連線」封包依序走過 chain（含 jump／return），回傳決定它的規則。
   *     每個條件為 true／false／null（無法判斷）；只有全部為 true 的規則才算命中，null 的規則略過（近似，見設計說明）。
   * WAN／LAN 是推論：只看名稱含 WAN／LAN 的 interface list 及其成員（/interface list member 的事實），不看介面名稱。
   */
  const FW_NONDET = new Set(['random', 'limit', 'dst-limit', 'connection-limit', 'psd', 'nth', 'per-connection-classifier']);
  const FW_PORT_KEYS = new Set(['dst-port', 'src-port', 'port']);
  const FW_ADDR_KEYS = new Set(['src-address', 'dst-address']);
  const FW_SET_KEYS = new Set(['protocol', 'connection-state', 'connection-nat-state', 'connection-type']);
  const PROTO = { 1: 'icmp', 6: 'tcp', 17: 'udp', 47: 'gre', 50: 'ipsec-esp', 51: 'ipsec-ah', 58: 'icmpv6', 132: 'sctp' };
  const PORT_PROTOCOLS = new Set(['tcp', 'udp', 'udp-lite', 'sctp', 'dccp']);
  const FW_TERMINAL = new Set(['accept', 'drop', 'reject', 'tarpit', 'return', 'dst-nat', 'src-nat', 'masquerade', 'redirect', 'netmap', 'same']);
  const FW_BUILTIN = { filter: ['input', 'forward', 'output'], nat: ['srcnat', 'dstnat'], raw: ['prerouting', 'output'] };
  const WAN_LIST = /(^|[^a-z])wan([^a-z]|$)/i;
  const LAN_LIST = /(^|[^a-z])lan([^a-z]|$)/i;
  /** RouterOS 7 的出廠預設：export 沒寫的服務就是這個狀態（不是停用）。reverse-proxy 只在有規則時才監聽，不列入。 */
  const SERVICE_DEFAULTS = [['api', 8728, true], ['api-ssl', 8729, true], ['ftp', 21, true], ['ssh', 22, true], ['telnet', 23, true],
    ['winbox', 8291, true], ['www', 80, true], ['www-ssl', 443, false]];

  const splitNeg = (v) => { const s = String(v); return s.startsWith('!') ? { neg: true, body: s.slice(1) } : { neg: false, body: s }; };
  const tokens = (body) => body.split(',').map((x) => x.trim()).filter(Boolean);
  /** 比對條件的正規形式：清單值排序（80,443 與 443,80 相同），否定保留在最前面。 */
  function canonMatch(match) {
    return Object.keys(match).sort().map((k) => { const { neg, body } = splitNeg(match[k]); return [k, (neg ? '!' : '') + tokens(body).sort().join(',')]; });
  }
  const protoName = (t) => { const x = String(t).toLowerCase(); return PROTO[x] || x; };

  // 位址：IPv4／IPv6 以 BigInt 區間表示
  function ip6Big(s) {
    let [head, tail] = s.split('::');
    const h = head ? head.split(':') : []; const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
    if (t === null && h.length !== 8) return null;
    const parts = t === null ? h : h.concat(Array(8 - h.length - t.length).fill('0'), t);
    if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/i.test(p))) return null;
    return parts.reduce((acc, p) => (acc << 16n) + BigInt(parseInt(p, 16)), 0n);
  }
  function addrRange(text) {
    const r = text.match(/^([^/\-]+)(?:\/(\d{1,3}))?(?:-([^/]+))?$/); if (!r) return null;
    const v4 = S.ip.isIp(r[1]); const bits = v4 ? 32 : 128;
    const toBig = (x) => (S.ip.isIp(x) ? BigInt(S.ip.toInt(x)) : v4 ? null : ip6Big(x));
    const lo0 = toBig(r[1]); if (lo0 === null) return null;
    if (r[3]) { const hi = toBig(r[3]); return hi === null ? null : [lo0, hi, bits]; }
    const len = r[2] === undefined ? bits : +r[2]; if (len > bits) return null;
    const span = (1n << BigInt(bits - len)) - 1n; const lo = lo0 & ~span & ((1n << BigInt(bits)) - 1n);
    return [lo, lo + span, bits];
  }
  const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', 'fc00::/7', 'fe80::/10', '::1/128'].map(addrRange);

  /** 值的解析：{ neg, kind: 'ranges'|'set'|'raw', items, raw }。 */
  function parseVal(key, value) {
    const { neg, body } = splitNeg(value);
    const raw = (neg ? '!' : '') + tokens(body).sort().join(',');
    if (FW_PORT_KEYS.has(key)) {
      const items = tokens(body).map((t) => { const m = t.match(/^(\d+)(?:-(\d+))?$/); return m ? [BigInt(m[1]), BigInt(m[2] || m[1])] : null; });
      if (items.length && items.every(Boolean)) return { neg, kind: 'ranges', items, raw };
    } else if (FW_ADDR_KEYS.has(key)) {
      const items = tokens(body).map(addrRange);
      if (items.length && items.every(Boolean)) return { neg, kind: 'ranges', items: items.map(([a, b]) => [a, b]), bits: items[0][2], raw };
    } else if (FW_SET_KEYS.has(key)) {
      return { neg, kind: 'set', items: new Set(tokens(body).map((t) => (key === 'protocol' ? protoName(t) : t.toLowerCase()))), raw };
    }
    return { neg, kind: 'raw', raw };
  }
  const inRanges = (x, rs) => rs.some(([a, b]) => x >= a && x <= b);
  const rangesWithin = (inner, outer) => inner.every(([a, b]) => {
    // 以 outer 的聯集涵蓋 [a, b]
    let cur = a; const sorted = outer.slice().sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
    for (const [c, d] of sorted) { if (c > cur) break; if (d >= cur) cur = d + 1n; if (cur > b) return true; }
    return cur > b;
  });
  const rangesDisjoint = (x, y) => x.every(([a, b]) => y.every(([c, d]) => b < c || d < a));
  /** j ⊆ i（符合 j 的值一定符合 i）。 */
  function valSubset(j, i) {
    if (i.kind !== j.kind || i.kind === 'raw') return i.raw === j.raw;
    const sub = i.kind === 'ranges' ? rangesWithin : (x, y) => Array.from(x).every((t) => y.has(t));
    const dis = i.kind === 'ranges' ? rangesDisjoint : (x, y) => Array.from(x).every((t) => !y.has(t));
    if (!i.neg && !j.neg) return sub(j.items, i.items);
    if (i.neg && !j.neg) return dis(j.items, i.items);
    if (i.neg && j.neg) return sub(i.items, j.items);
    return false;
  }

  /**
   * 比對用的設備環境。lists：[{ name, defined, include, exclude, members: [ep] }]；ifcEps：設備的介面鍵；rules：該設備的規則。
   * wan／lan：名稱含 WAN／LAN 的清單成員（Set），沒有可辨識的 WAN 清單時 wan 為 null。
   */
  function fwContext(dev, lists, ifcEps, rules) {
    const byName = new Map(lists.map((l) => [l.name, l]));
    const universe = new Set(ifcEps);
    lists.forEach((l) => l.members.forEach((ep) => universe.add(ep)));
    rules.forEach((r) => ['in-interface', 'out-interface'].forEach((k) => { if (r.match[k]) universe.add(K.ep(dev, splitNeg(r.match[k]).body)); }));
    const resolved = new Map();
    const resolve = (name, seen) => {
      if (name === 'all') return universe;
      if (name === 'none') return new Set();
      if (resolved.has(name)) return resolved.get(name);
      const l = byName.get(name);
      if (!l || !l.defined || (seen && seen.has(name))) return null; // dynamic、static 等內建清單或未定義的清單：無法判斷
      const s = new Set(seen || []); s.add(name);
      let out = new Set(l.members);
      for (const inc of l.include) { const r = resolve(inc, s); if (r === null) return null; r.forEach((x) => out.add(x)); }
      for (const exc of l.exclude) { const r = resolve(exc, s); if (r === null) return null; out = new Set(Array.from(out).filter((x) => !r.has(x))); }
      resolved.set(name, out);
      return out;
    };
    const chains = new Map();
    rules.slice().sort((a, b) => a.position - b.position).forEach((r) => S.util.getOr(chains, r.family + '|' + r.table + '|' + r.chain, () => []).push(r));
    const pick = (re) => {
      const names = lists.filter((l) => l.defined && re.test(l.name)).map((l) => l.name).sort(S.util.natural);
      const eps = new Set(); names.forEach((n) => { const r = resolve(n); if (r) r.forEach((x) => eps.add(x)); });
      return { names, eps };
    };
    const wan = pick(WAN_LIST); const lan = pick(LAN_LIST);
    const status = !wan.names.length ? 'no-wan-list' : !wan.eps.size ? 'empty-wan-list' : 'ok';
    return { dev, universe, resolve, chains, wanLists: wan.names, wan: status === 'ok' ? wan.eps : null, lanLists: lan.names, lan: lan.eps, status,
      chain: (family, table, chain) => chains.get(family + '|' + table + '|' + chain) || [] };
  }
  const UNKNOWN = Symbol('unknown');
  /** 規則在 in／out 方向允許的介面集合；沒有限制為 null，含無法判斷的清單為 UNKNOWN。 */
  function ifcSet(ctx, rule, dir) {
    let eff = null;
    for (const [k, isList] of [[dir + '-interface', false], [dir + '-interface-list', true]]) {
      const v = rule.match[k]; if (v === undefined) continue;
      const { neg, body } = splitNeg(v);
      const set = isList ? ctx.resolve(body) : new Set([K.ep(ctx.dev, body)]);
      if (set === null) return UNKNOWN;
      const base = eff || ctx.universe;
      eff = new Set(Array.from(base).filter((x) => (neg ? !set.has(x) : set.has(x))));
    }
    return eff;
  }
  /** 規則 i 是否涵蓋 j（同一個 chain；呼叫端負責 i 在 j 之前、動作會終止比對）。 */
  function covers(ctx, i, j) {
    const ki = Object.keys(i.match);
    if (ki.some((k) => FW_NONDET.has(k))) return false;
    for (const dir of ['in', 'out']) {
      const keys = [dir + '-interface', dir + '-interface-list'];
      if (!keys.some((k) => i.match[k] !== undefined)) continue;
      const ei = ifcSet(ctx, i, dir); const ej = ifcSet(ctx, j, dir);
      if (ei === UNKNOWN || ej === UNKNOWN) { if (keys.some((k) => i.match[k] !== j.match[k])) return false; continue; }
      if (!Array.from(ej || ctx.universe).every((x) => ei.has(x))) return false;
    }
    return ki.every((k) => {
      if (/^(in|out)-interface(-list)?$/.test(k)) return true;
      if (j.match[k] === undefined) return false;
      return valSubset(parseVal(k, j.match[k]), parseVal(k, i.match[k]));
    });
  }
  const sameMatch = (a, b) => JSON.stringify(canonMatch(a.match)) === JSON.stringify(canonMatch(b.match));

  /**
   * 一個條件對封包的結果：true／false／null（無法判斷）。
   * pkt：{ family, chain, in: ep, out: ep|null（沒有出介面，例如 input）|undefined（不明）, protocol, dstPort: 數字|null（不是規則提到的埠）,
   *        dst: BigInt|undefined, state: 'new', natState: null|'dstnat' }；來源是任意公網位址、來源埠由攻擊者選。
   */
  function condition(ctx, rule, key, pkt) {
    const v = rule.match[key]; const { neg, body } = splitNeg(v);
    const flip = (x) => (x === null ? null : neg ? !x : x);
    switch (key) {
      case 'protocol': return flip(protoName(body) === pkt.protocol);
      case 'dst-port': { if (pkt.dstPort == null || !PORT_PROTOCOLS.has(pkt.protocol)) return neg; const p = parseVal(key, v); return p.kind === 'ranges' ? flip(inRanges(BigInt(pkt.dstPort), p.items)) : null; }
      case 'src-port': return rule.action === 'accept' ? true : FW_TERMINAL.has(rule.action) ? false : null; // 攻擊者自選來源埠
      case 'port': { const p = parseVal(key, v); if (p.kind === 'ranges' && pkt.dstPort != null && !neg && inRanges(BigInt(pkt.dstPort), p.items)) return true; return rule.action === 'accept' ? true : FW_TERMINAL.has(rule.action) ? false : null; }
      case 'src-address': {
        const p = parseVal(key, v); if (p.kind !== 'ranges') return null;
        const bits = BigInt(p.bits); const full = rangesWithin([[0n, (1n << bits) - 1n]], p.items);
        if (!neg) return full;
        const priv = PRIVATE.filter((x) => x && BigInt(x[2]) === bits).map(([a, b]) => [a, b]);
        return rangesWithin(p.items, priv) ? true : null; // 排除私有位址＝公網來源仍符合
      }
      case 'src-address-list': return neg; // 任意攻擊者不在名單內
      case 'dst-address': { if (pkt.dst === undefined) return null; const p = parseVal(key, v); return p.kind === 'ranges' ? flip(inRanges(pkt.dst, p.items)) : null; }
      case 'dst-address-type': return pkt.chain === 'input' && body === 'local' ? !neg : null;
      case 'connection-state': return flip(tokens(body).includes(pkt.state));
      case 'connection-nat-state': return pkt.natState ? flip(tokens(body).includes(pkt.natState)) : neg;
      case 'ipsec-policy': return /ipsec/.test(body) ? neg : /none/.test(body) ? !neg : null;
      default: return null;
    }
  }
  function ruleMatches(ctx, rule, pkt) {
    let res = true;
    for (const dir of ['in', 'out']) {
      if (rule.match[dir + '-interface'] === undefined && rule.match[dir + '-interface-list'] === undefined) continue;
      const at = pkt[dir];
      if (at === undefined) { res = null; continue; }
      const e = ifcSet(ctx, rule, dir);
      if (e === UNKNOWN) { res = null; continue; }
      if (at === null) { // 沒有這個方向的介面（例如 input 沒有出介面）：只有否定條件會成立
        const negOnly = [dir + '-interface', dir + '-interface-list'].every((k) => rule.match[k] === undefined || splitNeg(rule.match[k]).neg);
        if (!negOnly) return false; continue;
      }
      if (!e.has(at)) return false;
    }
    for (const k of Object.keys(rule.match)) {
      if (/^(in|out)-interface(-list)?$/.test(k)) continue;
      const c = FW_NONDET.has(k) ? null : condition(ctx, rule, k, pkt);
      if (c === false) return false;
      if (c === null) res = null;
    }
    return res;
  }
  /** 依序走過 chain：回傳 { verdict, rule, path }；verdict 為 accept／drop／nat 動作，沒有規則決定時為 null。path 是經過的 jump 規則。 */
  function evalChain(ctx, family, table, chain, pkt, path) {
    const via = path || [];
    if (via.length > 16) return { verdict: null, rule: null, path: via };
    for (const r of ctx.chain(family, table, chain)) {
      if (r.disabled || ruleMatches(ctx, r, Object.assign({}, pkt, { chain })) !== true) continue;
      if (r.action === 'jump') {
        const target = r.params['jump-target'];
        if (!target || via.some((x) => x.params['jump-target'] === target) || target === chain) continue;
        const sub = evalChain(ctx, family, table, target, pkt, via.concat(r));
        if (sub.verdict) return sub;
        continue;
      }
      if (r.action === 'return') return { verdict: null, rule: null, path: via };
      if (r.action === 'drop' || r.action === 'reject' || r.action === 'tarpit') return { verdict: 'drop', rule: r, path: via };
      if (FW_TERMINAL.has(r.action)) return { verdict: r.action, rule: r, path: via };
    }
    return { verdict: null, rule: null, path: via };
  }
  /** 從 WAN 進來的封包：先看 raw prerouting（丟掉就到不了），再走 filter 的內建 chain；沒有規則決定時內建 chain 預設放行。 */
  function evalFilter(ctx, family, builtin, pkt) {
    const raw = evalChain(ctx, family, 'raw', 'prerouting', Object.assign({}, pkt, { out: undefined }));
    if (raw.verdict === 'drop') return { verdict: 'drop', rule: raw.rule, path: raw.path, raw: true };
    const f = evalChain(ctx, family, 'filter', builtin, pkt);
    return f.verdict ? f : { verdict: 'accept', rule: null, path: [], policy: true };
  }
  /** 由規則本身的條件組出「會符合它」的 WAN 封包（協定、第一個目的埠／位址、出介面）。 */
  function packetFor(rule, inEp, chain, ctx) {
    const first = (k) => { const v = rule.match[k]; if (v === undefined || splitNeg(v).neg) return undefined; const p = parseVal(k, v); return p.kind === 'ranges' ? p.items[0][0] : undefined; };
    const proto = rule.match.protocol && !splitNeg(rule.match.protocol).neg ? protoName(tokens(splitNeg(rule.match.protocol).body)[0]) : 'tcp';
    const dp = first('dst-port'); const dst = first('dst-address');
    const out = rule.match['out-interface'] && !splitNeg(rule.match['out-interface']).neg ? K.ep(ctx.dev, rule.match['out-interface']) : chain === 'input' ? null : undefined;
    return { family: rule.family, in: inEp, out, protocol: proto, dstPort: dp === undefined ? null : Number(dp), dst, state: 'new', natState: null };
  }

  /** 推論：每台有設定資料的設備的 WAN／LAN 分類與有效的 /ip service（含預設值）。 */
  function firewall(M) {
    M.fwZones = new Map(); M.fwServices = new Map(); M.fwCtx = new Map();
    const ifcsByDev = new Map(); M.ifcs.forEach((i) => S.util.getOr(ifcsByDev, i.dev, () => []).push(i.key));
    const listsByDev = new Map(); M.fw.lists.forEach((l) => S.util.getOr(listsByDev, l.dev, () => []).push({ name: l.name, defined: l.defined, include: l.include, exclude: l.exclude, members: Array.from(l.members.keys()) }));
    const rulesByDev = new Map(); M.fw.rules.forEach((r) => S.util.getOr(rulesByDev, r.dev, () => []).push(r));
    M.devices.forEach((d) => {
      if (!d.collected || !d.data.has('config')) return;
      const ctx = fwContext(d.key, listsByDev.get(d.key) || [], ifcsByDev.get(d.key) || [], rulesByDev.get(d.key) || []);
      M.fwCtx.set(d.key, ctx);
      M.fwZones.set(d.key, { dev: d.key, basis: ctx.status === 'ok' ? 'interface-list' : null, status: ctx.status, wanLists: ctx.wanLists, wanInterfaces: ctx.wan ? Array.from(ctx.wan).sort(S.util.natural) : [],
        lanLists: ctx.lanLists, lanInterfaces: Array.from(ctx.lan).sort(S.util.natural) });
      const svcs = new Map(SERVICE_DEFAULTS.map(([name, port, enabled]) => [name, { dev: d.key, name, enabled, port, addresses: [], basis: 'default', src: [] }]));
      M.fw.services.forEach((sv) => {
        if (sv.dev !== d.key) return;
        const base = svcs.get(sv.name) || { dev: d.key, name: sv.name, enabled: true, port: null, addresses: [], basis: 'export', src: [] };
        svcs.set(sv.name, { dev: d.key, name: sv.name, enabled: sv.disabled === null ? base.enabled : !sv.disabled, port: sv.port ?? base.port,
          addresses: sv.addresses ?? base.addresses, basis: 'export', src: sv.src.slice() });
      });
      M.fwServices.set(d.key, Array.from(svcs.values()).sort((a, b) => S.util.natural(a.name, b.name)));
    });
  }

  function displayName(d) {
    if (d.names.size) return Array.from(d.names)[0];
    return d.key;
  }

  S.infer = { infer, displayName, effVlans, effVlanModes, vlanSpan, isVirtualIfc, hwMacsByDev, wifiLocations, behindLocations };
  S.infer.fw = { canonMatch, covers, sameMatch, evalChain, evalFilter, packetFor, fwContext, parseVal, splitNeg, protoName,
    TERMINAL: FW_TERMINAL, BUILTIN: FW_BUILTIN, NONDET: FW_NONDET, PORT_PROTOCOLS };
})(globalThis.SSOT = globalThis.SSOT || {});
