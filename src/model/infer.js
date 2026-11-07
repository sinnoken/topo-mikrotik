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
  /** 有 VLAN 設定資料的資料類別：兩端都有其一，鏈路的 VLAN 才能比較（vlanComparable）。查詢層判斷「這一端的 VLAN 是否已知」也用它。 */
  const VLAN_DATA = Object.freeze(['config', 'vlans']);

  function infer(M, profile) {
    inferKinds(M);
    linkClasses(M);
    unfilteredPorts(M);
    linkVlans(M); // 用到 vlanUnfiltered
    inferLinks(M);
    vlanDomains(M); // 用到鏈路兩端 VLAN 與推論鏈路
    if (profile) applyProfile(M, profile);
    groups(M);
    edgeLocations(M); // 用到 profile 覆寫後的設備類型與推論鏈路
    wifiLocations(M); // 用到終端埠
    behindLocations(M);
    firewall(M);
    boundaries(M); // 用到 M.fwCtx（清單展開、WAN 清單）
    entriesOf(M); // 對外入口：WAN 清單成員＋判定為對外的邊界（用到 M.boundaries）
    routingDomains(M);
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

  /**
   * 介面所在的 bridge 介面：bridge 本身、bridge port，或所屬聚合是 bridge port（聚合成員）。不在 bridge 上為 null。
   * M 只需要 ifcs.get，Snapshot 的介面也可以直接套用。
   */
  function bridgeOf(M, ep) {
    const i = M.ifcs.get(ep); if (!i) return null;
    if (i.type === 'bridge') return i;
    const p = i.lag ? M.ifcs.get(i.lag) : null;
    const b = i.bridge || (p && p.bridge);
    return (b && M.ifcs.get(b)) || null;
  }
  /**
   * 未開 vlan-filtering 的 bridge（推論，依手冊）：bridge 不看 VLAN 標籤、不改標籤，pvid、frame-types、ingress-filtering 都沒有作用，
   * 所以 bridge 本身、它的 port 與 port 的聚合成員，VLAN 原樣轉送、無法由設定確認承載哪些 VLAN（vlanUnfiltered）。
   * 只看 vlanFiltering 為 false（export 有這個 bridge 的定義）；只由其他輸出知道的 bridge 為 null，不當成未過濾。
   * https://manual.mikrotik.com/docs/bridging-and-switching.md（Bridge VLAN Filtering；Bridge Port Settings 的 pvid、frame-types、ingress-filtering）
   */
  function unfilteredPorts(M) {
    M.ifcs.forEach((i) => { const b = bridgeOf(M, i.key); i.vlanUnfiltered = !!b && b.vlanFiltering === false; });
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
   * domains 依承載此 VLAN 的鏈路、推論鏈路與透通鏈路（transparent：一端帶、另一端在未開 vlan-filtering 的 bridge 上）相連；
   * 只經由未收集設備或未過濾的 bridge 相連也算同一塊，但那台設備（沒有這個 VLAN 時）不列入。
   * 未過濾的 bridge 串接時，兩端都未過濾、接得到這個 VLAN 會進入的未過濾 bridge 的鏈路也算 transparent（推論）。
   * linkDomain：transparent 鏈路 key → 區塊鍵（串接的鏈路兩端設備都可能不在 devices，Q.vlan(id, domain) 依它篩選）。
   * 依據：vlan-filtering=no 時 bridge 不看也不改 VLAN 標籤 https://manual.mikrotik.com/docs/bridging-and-switching.md（Bridge VLAN Filtering）
   */
  function vlanSpan(src, id) {
    const devOf = (ep) => K.splitEp(ep)[0];
    const entries = Array.from(src.vlans).filter((v) => v.id === id);
    const carry = []; const partial = []; const candidates = []; const chained = new Set();
    const unf = (ep) => { const i = src.ifc(ep); return !!(i && i.vlanUnfiltered); };
    const bm = { ifcs: { get: src.ifc } }; const brKey = (ep) => { const b = bridgeOf(bm, ep); return b ? b.key : null; };
    const seeds = new Set(); // 這個 VLAN 會進入的未過濾 bridge（串接的起點）
    for (const l of src.links) {
      if (l.layer !== 'l2') continue;
      const inA = l.vlansA.includes(id); const inB = l.vlansB.includes(id);
      if (inA && inB) { carry.push(l); [l.a, l.b].filter(unf).forEach((ep) => seeds.add(brKey(ep))); }
      // 透通（推論）：只有一端帶，另一端在未開 vlan-filtering 的 bridge 上（原樣轉送，無從確認）；連接兩側的區塊
      else if (inA !== inB && l.evidenceScope === LINK_SCOPE.INTERFACE_ADJACENCY && (unf(l.a) || unf(l.b))) { candidates.push(l); [l.a, l.b].filter(unf).forEach((ep) => seeds.add(brKey(ep))); }
      // 串接（推論）：兩端都在未過濾的 bridge 上、都不帶；只有接到這個 VLAN 會進入的未過濾 bridge 時才算透通（下面的遍歷）
      else if (!inA && !inB && l.evidenceScope === LINK_SCOPE.INTERFACE_ADJACENCY && unf(l.a) && unf(l.b)) { candidates.push(l); chained.add(l); }
      // vlansDiff：可比較時計入 V01 的 VLAN（舊版 Snapshot 沒有這個欄位時，沿用 vlanMismatch）
      else if ((inA || inB) && l.vlanComparable !== false && l.vlanMismatch && (!l.vlansDiff || l.vlansDiff.includes(id))) partial.push(l);
    }
    const devs = S.util.uniq(entries.map((v) => v.dev)); const seen = new Set(devs); // 1000 台時 includes 是 O(介面×設備)
    for (const i of src.interfaces) {
      const has = S.util.ifcVlans(i).includes(id);
      if (has && i.type === 'bridge' && i.vlanUnfiltered) seeds.add(i.key); // 未過濾的 bridge 本身（CPU 埠）帶這個 VLAN
      if (!seen.has(i.dev) && has) { seen.add(i.dev); devs.push(i.dev); }
    }
    // 未過濾的 bridge 串接（推論）：以 bridge 為節點、兩端都未過濾的鏈路為邊，從 seeds 遍歷；同一台設備的不同 bridge 之間不轉送。
    // 每個 bridge 只進佇列一次，所以環狀串接也會結束；成本是串接鏈路數的線性。
    const used = new Set();
    if (chained.size && seeds.size) {
      const adj = new Map(); chained.forEach((l) => [l.a, l.b].forEach((ep) => S.util.getOr(adj, brKey(ep), () => []).push(l)));
      const reached = new Set(seeds); const queue = Array.from(seeds);
      while (queue.length) {
        for (const l of adj.get(queue.pop()) || []) {
          if (used.has(l)) continue;
          used.add(l);
          [l.a, l.b].map(brKey).forEach((k) => { if (!reached.has(k)) { reached.add(k); queue.push(k); } });
        }
      }
    }
    const transparent = candidates.filter((l) => !chained.has(l) || used.has(l)); // 依鏈路順序
    // 推論鏈路：已收集的每一端（或其所屬聚合）都帶這個 VLAN；未收集的一端無從得知，屬推論
    const hasVlan = (ep) => { const i = src.ifc(ep); return !!i && S.util.ifcVlans(i).includes(id); };
    const inferred = Array.from(src.inferred).filter((l) => {
      const known = [l.a, l.b].filter((ep) => src.ifc(ep) && src.collected(devOf(ep)));
      return known.length && known.every((ep) => hasVlan(ep) || Array.from(src.ifc(ep).lagMembers || []).some(hasVlan));
    });
    const devices = devs.sort(S.util.natural);
    const own = new Set(devices);
    // 區塊的節點：設備；但不帶這個 VLAN 的設備在未過濾 bridge 上的一端，以那個 bridge 為節點（同一台設備的不同 bridge 之間不轉送）
    const node = (ep) => { const d = devOf(ep); return !own.has(d) && unf(ep) ? brKey(ep) : d; };
    const edges = carry.concat(inferred, transparent);
    const pairs = edges.map((l) => [node(l.a), node(l.b)]);
    const bridging = S.util.uniq(pairs.flat()).filter((d) => !own.has(d));
    // linkDomain：透通鏈路 key → 區塊鍵；串接的透通鏈路兩端設備都可能不在 devices，Q.vlan(id, domain) 依它歸屬區塊
    const nodeDomain = new Map(); const domains = [];
    S.util.components(devices.concat(bridging), pairs).forEach((all) => {
      const ks = all.filter((d) => own.has(d)); if (!ks.length) return;
      const key = id + '@' + ks[0]; all.forEach((n) => nodeDomain.set(n, key));
      domains.push({ key, devices: ks });
    });
    const linkDomain = new Map(transparent.map((l) => [l.key, nodeDomain.get(node(l.a)) || null]));
    return { entries, devices, carry, partial, inferred, transparent, domains, linkDomain };
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
  /** 介面（含所屬聚合）的 PVID；沒有為 null。 */
  function effPvid(M, ep) {
    const i = M.ifcs.get(ep); if (!i) return null;
    if (i.pvid != null) return i.pvid;
    const p = i.lag && M.ifcs.get(i.lag);
    return p ? p.pvid : null;
  }
  /**
   * 鏈路兩端 VLAN（V01、Q.vlan、Q.vlanCarriers 共用這裡的結果）：
   *   vlansA／vlansB：兩端的 effVlans；vlansCommon：交集。
   *   vlanComparable：兩端都有 VLAN 資料、不是單側觀察，而且兩端都不在未開 vlan-filtering 的 bridge 上（那一端 VLAN 原樣轉送，無從比較）。
   *   vlansDiff：可比較時只在一端、計入 V01 的 VLAN。一端不在任何 bridge 上又沒有 PVID 時（例如單臂路由的實體埠，VLAN 只靠子介面），
   *     它的 untagged 訊框由介面本身處理、沒有 VLAN ID，所以對端只以 untagged 承載、這一端沒有的 VLAN（通常是 PVID 1）不算不一致。
   *     「不在 bridge 上」要有那台設備的 export 才能確定。
   *   vlanMismatch：vlansDiff 不是空的。
   * PVID 是 bridge port 的屬性：https://manual.mikrotik.com/docs/bridging-and-switching.md（Bridge Port Settings 的 pvid）
   */
  function linkVlans(M) {
    const hasData = (d) => d && VLAN_DATA.some((t) => d.data.has(t));
    const noVlanUntagged = (ep, d) => !!d && d.data.has('config') && !bridgeOf(M, ep) && effPvid(M, ep) == null;
    const untaggedOnly = (ep) => { const md = effVlanModes(M, ep); return (v) => md.untagged.has(v) && !md.tagged.has(v); };
    M.links.forEach((l) => {
      if (l.layer !== 'l2') return;
      if (l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN) {
        l.vlansA = []; l.vlansB = []; l.vlansCommon = []; l.vlanComparable = false; l.vlanMismatch = false; l.vlansDiff = [];
        return;
      }
      l.vlansA = effVlans(M, l.a); l.vlansB = effVlans(M, l.b);
      const sa = new Set(l.vlansA); const sb = new Set(l.vlansB);
      l.vlansCommon = l.vlansA.filter((v) => sb.has(v));
      const da = M.devices.get(K.splitEp(l.a)[0]); const db = M.devices.get(K.splitEp(l.b)[0]);
      const unfiltered = [l.a, l.b].some((ep) => { const i = M.ifcs.get(ep); return !!(i && i.vlanUnfiltered); });
      l.vlanComparable = !!(hasData(da) && hasData(db)) && !l.hearsay && !unfiltered;
      let onlyA = l.vlansA.filter((v) => !sb.has(v)); let onlyB = l.vlansB.filter((v) => !sa.has(v));
      if (noVlanUntagged(l.a, da)) { const u = untaggedOnly(l.b); onlyB = onlyB.filter((v) => !u(v)); }
      if (noVlanUntagged(l.b, db)) { const u = untaggedOnly(l.a); onlyA = onlyA.filter((v) => !u(v)); }
      l.vlansDiff = l.vlanComparable ? S.util.numSort(onlyA.concat(onlyB)) : [];
      l.vlanMismatch = l.vlansDiff.length > 0;
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
    sorted.forEach((members, idx) => members.forEach((d) => { d.component = idx + 1; if (!d.group) d.group = '分群 ' + (idx + 1); }));
  }

  /**
   * 推論鏈路（推論，不寫進 links，不影響任何檢查）：沒有 LLDP／CDP 的設備（例如只支援 MNDP 的 SwOS 交換器）用其他證據推定相鄰。
   *   subnet-p2p ：兩台已收集設備的介面位址在同一個 /30 或 /31，且該網段只有這兩台
   *   mndp-mutual：兩台已收集設備的 MNDP 互相回報對方的埠，且兩個埠都只看到對方
   *   mndp-unique：已收集設備的某埠只看到一台 MNDP 鄰居 X（X 未收集），X 也只出現在這個埠
   *   fdb        ：MAC 表。A 的 p 埠學到 X 的 MAC，且 p 這側其他已知設備都可由已收集交換器的 MAC 表證明在 X 後面或兩者之間
   * MNDP 會穿過非網管型交換器，只證明 L2 可達，所以 MNDP 只當佐證：至少要有一項非 MNDP 的證據（fdb、subnet-p2p）才成立推論；
   * MNDP 同時成立時提高信心。推論的意義都是「直接相連，或中間只有非網管型設備」。
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
    // 但會穿過不跑 STP 的非網管型交換器，所以同樣是「直接相連，或中間只有非網管型設備」）。對端也有 STP 資料時以 designated port 編號對回確切的埠。
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
   *   decide(ctx, …, pkt)：封包依序走過 chain（含 jump／return）。每個條件為 true／false／null（無法判斷），無法判斷的規則不略過，
   *     列出所有可能的結果，只有一種時才算決定。Q.reach 與檢查都用它。
   *     pkt.reach 為 true 時是一個已知來源的封包（Q.reach）；沒有時是檢查的「來自 WAN 的新連線」（wanPacket），條件的判斷見 condition。
   *   evalChain／evalFilter(ctx, …, pkt)：檢查用的 decide 包裝，無法判斷時結果是 'unknown'。
   *   wanEntries(ctx, vrfOf)：對外入口（WAN 介面與所在 VRF）的唯一定義，檢查（M.wanEntries）與查詢層都用它。
   * 模擬的是 RouterOS 的處理順序（first-match、jump／return、內建 chain 沒有規則決定時放行），不是跨廠牌的共同模型（ADR-012）。
   * WAN／LAN 是推論：只看名稱含 WAN／LAN 的 interface list 及其成員（/interface list member 的事實），不看介面名稱。
   */
  const FW_NONDET = new Set(['random', 'limit', 'dst-limit', 'connection-limit', 'psd', 'nth', 'per-connection-classifier']);
  /**
   * 比對條件的分類（ruleMatches 依它決定要不要交給 condition 判斷；查詢層的「判斷的前提」與 Q.assumptionUse 讀同一份，文字與程式不會脫節）：
   *   CONDITIONS：condition 會判斷的條件（依封包仍可能無法判斷，例如來源埠、NAT 後的來源、設備有 IPsec policy 時的 ipsec-policy）；
   *   IFC_CONDITIONS：介面條件（ruleMatches 自己判斷，清單無法展開或介面不明時無法判斷）；
   *   ADDRESS_LIST：位址清單（完全靜態的清單由 condition 依項目判斷，可能有動態來源的清單無法判斷，見 ADDRESS_LIST_DYNAMIC）；NONDET：依流量、速率或機率比對；其他鍵一律無法判斷。
   */
  const FW_CONDITIONS = Object.freeze(['protocol', 'dst-port', 'port', 'src-port', 'src-address', 'dst-address', 'src-address-type', 'dst-address-type',
    'connection-state', 'connection-nat-state', 'tcp-flags', 'icmp-options', 'ipsec-policy']);
  const FW_CONDITION_SET = new Set(FW_CONDITIONS);
  const FW_IFC_CONDITIONS = Object.freeze(['in-interface', 'in-interface-list', 'out-interface', 'out-interface-list']);
  const FW_ADDRESS_LIST = Object.freeze(['src-address-list', 'dst-address-list']);
  /** 條件鍵的分類：'condition'｜'interface'｜'address-list'｜'nondet'｜'other'（見上）。 */
  const condKind = (k) => (FW_CONDITION_SET.has(k) ? 'condition' : FW_IFC_CONDITIONS.includes(k) ? 'interface' : FW_ADDRESS_LIST.includes(k) ? 'address-list' : FW_NONDET.has(k) ? 'nondet' : 'other');
  /** jump 到其他 chain 最多幾層（decide 與 walkState 共用；超過時當作那一層沒有決定）。 */
  const FW_MAX_JUMP = 16;
  /** 判斷的是新連線的第一個封包：連線狀態 new，TCP 只有 SYN 旗標，ICMP 是 echo request（type 8、code 0）。condition 與查詢層的前提文字讀同一份。 */
  const FW_FIRST_PACKET = Object.freeze({ state: 'new', tcpFlag: 'syn', icmpType: 8, icmpCode: 0 });
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

  // 位址：IPv4／IPv6 以 BigInt 區間表示，文字一律經 S.ip.range 解析，「在不在裡面」一律經 S.ip.set（見 addrSets）
  // 「!src-address=私有」視為公網來源仍符合：私有＝S.ip 位址分類的 private（含 IPv6 ULA）、cgnat、loopback、link-local
  const PRIVATE_CLASSES = ['private', 'cgnat', 'loopback', 'link-local'];
  const privateSet = (bits) => S.ip.set(S.ip.rangesOf(PRIVATE_CLASSES).filter((c) => S.ip.range(c)[2] === bits), bits);
  const PRIVATE = new Map([[32, privateSet(32)], [128, privateSet(128)]]);

  /*
   * 位址清單（/ip firewall address-list、/ipv6 firewall address-list；檢查用模型、查詢層用 Snapshot 的 addressLists，同一份判斷）。
   * 只展開「完全靜態」的清單：export 裡啟用中的項目都是位址、網段或範圍，沒有 DNS 名稱、逾時、動態項目，也沒有規則或其他設定會寫入它。
   * 依手冊（https://manual.mikrotik.com/docs/cli-reference/ip/firewall/address-list.md）：有逾時、dynamic=yes 的項目與 DNS 名稱解析出的位址是動態的，
   * 不在 export 裡；規則的 add-src-to-address-list／add-dst-to-address-list 與 DHCP 伺服器等功能也會加入動態項目。
   * ADDRESS_LIST_DYNAMIC：使整份清單「可能有動態來源」的原因（依序；source 是 entry（清單的項目）或 writer（寫入清單的來源）；查詢層的前提文字讀同一份）。
   */
  const FW_ADDRESS_LIST_DYNAMIC = Object.freeze([
    Object.freeze({ code: 'dns', source: 'entry', label: '網域名稱（DNS）' }),
    Object.freeze({ code: 'timeout', source: 'entry', label: '逾時' }),
    Object.freeze({ code: 'dynamic', source: 'entry', label: '動態項目' }),
    Object.freeze({ code: 'rule', source: 'writer', label: '由規則寫入' }), // add-src-to-address-list／add-dst-to-address-list，停用的規則也算（之前寫入的項目可能還在）
    Object.freeze({ code: 'config', source: 'writer', label: '由其他設定寫入' }), // 其他選單的 address-list／address-lists 參數（例如 PPP profile、DHCP 伺服器、mangle）
    Object.freeze({ code: 'script', source: 'writer', label: '可能由腳本寫入' }), // 文字提到 address-list、寫入哪些清單無從得知：這台設備的所有清單
  ]);
  /** 寫入位址清單的規則動作。 */
  const FW_ADDRESS_LIST_WRITE = Object.freeze(['add-src-to-address-list', 'add-dst-to-address-list']);
  /** 清單項目的位址：family 的位址、網段或範圍 → { kind: 'address', range: [lo, hi] }；其他文字（手冊：不是有效位址就當 DNS 名稱）→ { kind: 'dns', range: null }。IPv6 不接受範圍。 */
  function addressListItem(family, text) {
    const s = String(text).trim(); const r = S.ip.range(s);
    if (!r || r[2] !== (family === 'ipv6' ? 128 : 32) || (family === 'ipv6' && s.includes('-'))) return { kind: 'dns', range: null };
    return { kind: 'address', range: [r[0], r[1]] };
  }
  /**
   * 一份清單是否完全靜態。entries：[{ kind, disabled, timeout, dynamic }]（停用的項目不算）；writers：[{ kind: 'rule'|'config'|'script' }]。
   * 回傳 { static, reasons }，reasons 依 ADDRESS_LIST_DYNAMIC 的順序。
   */
  function addressListState(entries, writers) {
    const has = new Set();
    entries.forEach((e) => {
      if (e.disabled) return;
      if (e.kind === 'dns') has.add('dns');
      if (e.timeout) has.add('timeout');
      if (e.dynamic) has.add('dynamic');
    });
    writers.forEach((w) => has.add(w.kind));
    const reasons = FW_ADDRESS_LIST_DYNAMIC.map((x) => x.code).filter((c) => has.has(c));
    return { static: !reasons.length, reasons };
  }

  /** 值的解析：{ neg, kind: 'ranges'|'set'|'raw', items, raw }。 */
  function parseVal(key, value) {
    const { neg, body } = splitNeg(value);
    const raw = (neg ? '!' : '') + tokens(body).sort().join(',');
    if (FW_PORT_KEYS.has(key)) {
      const items = tokens(body).map((t) => { const m = t.match(/^(\d+)(?:-(\d+))?$/); return m ? [BigInt(m[1]), BigInt(m[2] || m[1])] : null; });
      if (items.length && items.every(Boolean)) return { neg, kind: 'ranges', items, raw };
    } else if (FW_ADDR_KEYS.has(key)) {
      const items = tokens(body).map(S.ip.range);
      if (items.length && items.every(Boolean)) return { neg, kind: 'ranges', items: items.map(([a, b]) => [a, b]), bits: items[0][2], raw };
    } else if (FW_SET_KEYS.has(key)) {
      return { neg, kind: 'set', items: new Set(tokens(body).map((t) => (key === 'protocol' ? protoName(t) : t.toLowerCase()))), raw };
    }
    return { neg, kind: 'raw', raw };
  }
  /** 埠號是否在規則的埠範圍內（parseVal 的 ranges；埠不是位址，不經 S.ip.set）。 */
  const inPortRanges = (x, rs) => rs.some(([a, b]) => x >= a && x <= b);

  /*
   * 位址集合的登錄表（單一來源）：防火牆規則的位址字面值、位址清單、/ip service 的 available-from、SNMP community 的 addresses、/routing rule 的位址都是設定寫死的值，
   * 事實只存一份（規則、Snapshot 的 addressLists、ipServices、mgmtSettings、routingRules），這裡只建「在不在裡面」的索引（S.ip.set），不進 Snapshot。
   * decide 的位址條件、/routing rule 的比對（S.trace.ruleMatches，經路由視圖的 addrSets）、F07／F13 的「不限來源」（set.isAll）一律經這裡的集合，
   * L4 的等價類邊界一律經 addrBounds（同一份 set 的 bounds()），新的位址來源只需在這裡登錄。
   * 檢查以模型（M.addrSets，S.infer.firewall 建一次）、查詢層以 Snapshot（S.query 第一次用到時建一次，依 Snapshot 快取）呼叫同一個函式。
   *
   * addrSets({ rules, addressLists, services, routingRules, mgmtSettings })：各欄位都可省略；規則與服務可以是模型或 Snapshot 的形狀（只讀 dev、family、key、match、params、
   *   name、addresses、entries、snmp.communities 與來源行）。陣列在第一次查詢時才建索引，之後不可再改。
   * 每筆（凍結）：{ id, kind, dev, family, set, static, reasons, src }
   *   id（穩定，不含行號）：
   *     address-list：「設備|位址族|名稱」（同 model.addressLists 的鍵）；
   *     rule-address：「規則鍵|條件」（規則鍵見 firewallRules.key；條件是 src-address、dst-address 或 to-addresses；沒有規則鍵的規則（測試自建）為 null）；
   *     service：「設備|位址族|service|服務名稱」（available-from，ip 與 ipv6 各一筆）；
   *     snmp-community：「設備|位址族|snmp-community|facet」（facet 見 mgmtSettings 的 snmp.communities；addresses 不明（null）的 community 沒有這一筆）；
   *     routing-rule：「設備|routing-rule|順序|條件」（順序同 routingRules.order：每台設備依設定順序從 1 起算；不是登錄時那批物件（模型版路由視圖的複本）時 id 為 null）。
   *   set：S.ip.set，或 null——清單可能有動態來源（static 為 false，reasons 依 ADDRESS_LIST_DYNAMIC）；規則的位址字面值有任何一項不是位址、網段或範圍，
   *     或位址族不一致（條件無法判斷）。available-from 與 SNMP community 只取這個位址族、而且合法的項目（其他項目不接受任何來源）。
   *   src：來源行（[[block, line]]）：規則、服務、community 與 /routing rule 是它自己的行；位址清單是啟用中項目的行。
   * 回傳（凍結）：list、ofRule、service、community、ofRoutingRule、get(id)，以及 entries()（有 id 的每一筆，依登錄順序）。
   */
  const ADDR_RULE_KEYS = Object.freeze(['src-address', 'dst-address']);
  /** 登錄表每筆的 kind（封閉列舉）。 */
  const ADDR_SET_KINDS = Object.freeze(['address-list', 'rule-address', 'service', 'snmp-community', 'routing-rule']);
  const BITS = (family) => (family === 'ipv6' ? 128 : 32);
  const srcOf = (x) => x.src || [[x.block, x.line]];
  /** 規則或 /routing rule 的位址字面值 → S.ip.set；有一項不合法或位址族不一致時 null（同 parseVal 的 ranges 才判斷）。 */
  function literalSet(text) {
    if (text === undefined) return undefined;
    const rs = tokens(splitNeg(text).body).map(S.ip.range);
    if (!rs.length || rs.some((r) => !r || r[2] !== rs[0][2])) return null;
    return S.ip.set(rs.map(([a, b]) => [a, b]), rs[0][2]);
  }
  /** 允許來源的位址清單（available-from、SNMP community 的 addresses）→ 只取這個位址族、而且合法的項目的 S.ip.set（其他項目不接受任何來源）。 */
  const legalSet = (addresses, bits) => S.ip.set(addresses.filter((a) => { const r = S.ip.range(a); return r && r[2] === bits; }), bits);
  function addrSets(input) {
    const x = input || {};
    const rules = x.rules || []; const addressLists = x.addressLists || []; const services = x.services || []; const routingRules = x.routingRules || [];
    const mgmtSettings = x.mgmtSettings || [];
    const entry = (id, kind, dev, family, set, st, reasons, src) => Object.freeze({ id, kind, dev, family, set, static: st, reasons, src });
    // 位址清單：第一次查詢時才依鍵建索引；每份清單的集合在第一次用到時才建（封鎖名單可能有十萬筆）
    let alIdx = null; const alMemo = new Map();
    const list = (dev, family, name) => {
      if (!alIdx) alIdx = new Map(addressLists.map((l) => [l.dev + '|' + l.family + '|' + l.name, l]));
      const id = dev + '|' + family + '|' + name;
      if (alMemo.has(id)) return alMemo.get(id);
      const l = alIdx.get(id); let out = null;
      if (l) {
        const items = l.entries.filter((e) => !e.disabled && e.kind === 'address');
        out = entry(id, 'address-list', l.dev, l.family, l.static ? S.ip.set(items.map((e) => e.address), BITS(l.family)) : null, l.static, l.reasons,
          Object.freeze(l.entries.filter((e) => !e.disabled).map((e) => e.src[0])));
      }
      alMemo.set(id, out);
      return out;
    };
    // 規則的位址字面值：依規則物件快取（decide 每個封包都會查）
    const ruleMemo = new WeakMap();
    const literal = (rule, key) => {
      let m = ruleMemo.get(rule); if (!m) { m = new Map(); ruleMemo.set(rule, m); }
      if (m.has(key)) return m.get(key);
      const text = key === 'to-addresses' ? rule.params && rule.params[key] : rule.match[key];
      const set = literalSet(text);
      const out = set === undefined ? null : entry(rule.key ? rule.key + '|' + key : null, 'rule-address', rule.dev, rule.family, set, true, Object.freeze([]), srcOf(rule));
      m.set(key, out);
      return out;
    };
    /** 規則的位址條件（src-address、dst-address、to-addresses、src-address-list、dst-address-list）→ 登錄的那一筆；規則沒有這個條件、或基準裡沒有這份清單時 null。 */
    const ofRule = (rule, key) => (FW_ADDRESS_LIST.includes(key) ? (rule.match[key] === undefined ? null : list(rule.dev, rule.family, splitNeg(rule.match[key]).body)) : literal(rule, key));
    // available-from：依（設備, 服務名稱）
    let svIdx = null; const svMemo = new Map();
    const service = (dev, name, family) => {
      if (!svIdx) svIdx = new Map(services.map((sv) => [sv.dev + '|' + sv.name, sv]));
      const id = dev + '|' + family + '|service|' + name;
      if (svMemo.has(id)) return svMemo.get(id);
      const sv = svIdx.get(dev + '|' + name); const bits = BITS(family);
      const out = sv ? entry(id, 'service', dev, family, legalSet(sv.addresses, bits), true, Object.freeze([]), sv.src) : null;
      svMemo.set(id, out);
      return out;
    };
    // SNMP community 的 addresses：依（設備, facet）；啟用中的 community 的 facet 只在同名而且內容相同時重複，這時集合也相同。
    // 停用的 community 可能和啟用中的同名（facet 相同、內容不同）：同一個 facet 以啟用中的為準
    let cmIdx = null; const cmMemo = new Map();
    const community = (dev, facet, family) => {
      if (!cmIdx) {
        cmIdx = new Map();
        mgmtSettings.forEach((ms) => (ms.snmp && ms.snmp.communities || []).forEach((c) => {
          const k = ms.dev + '|' + c.facet; const had = cmIdx.get(k);
          if (!had || had.disabled !== false && c.disabled === false) cmIdx.set(k, c);
        }));
      }
      const id = dev + '|' + family + '|snmp-community|' + facet;
      if (cmMemo.has(id)) return cmMemo.get(id);
      const c = cmIdx.get(dev + '|' + facet);
      const out = c && c.addresses ? entry(id, 'snmp-community', dev, family, legalSet(c.addresses, BITS(family)), true, Object.freeze([]), c.src) : null;
      cmMemo.set(id, out);
      return out;
    };
    // /routing rule：順序依設定順序（每台設備從 1 起算，同 Snapshot 的 routingRules.order）
    let rrOrder = null; const rrMemo = new WeakMap();
    const ofRoutingRule = (r, key) => {
      if (!rrOrder) { rrOrder = new Map(); const n = new Map(); routingRules.forEach((y) => { const k = (n.get(y.dev) || 0) + 1; n.set(y.dev, k); rrOrder.set(y, k); }); }
      let m = rrMemo.get(r); if (!m) { m = new Map(); rrMemo.set(r, m); }
      if (m.has(key)) return m.get(key);
      const set = literalSet(r.match[key]); const order = rrOrder.get(r);
      const out = set === undefined ? null : entry(order ? r.dev + '|routing-rule|' + order + '|' + key : null, 'routing-rule', r.dev, null, set, true, Object.freeze([]), srcOf(r));
      m.set(key, out);
      return out;
    };
    // 依 id 查（第一次呼叫時登錄全部）
    let byId = null; let listed = null;
    const all = () => {
      if (!byId) {
        byId = new Map();
        const put = (e) => { if (e && e.id) byId.set(e.id, e); };
        addressLists.forEach((l) => put(list(l.dev, l.family, l.name)));
        rules.forEach((r) => ADDR_RULE_KEYS.concat('to-addresses').forEach((k) => put(literal(r, k))));
        services.forEach((sv) => ['ip', 'ipv6'].forEach((f) => put(service(sv.dev, sv.name, f))));
        routingRules.forEach((r) => ADDR_RULE_KEYS.forEach((k) => put(ofRoutingRule(r, k))));
        mgmtSettings.forEach((ms) => (ms.snmp && ms.snmp.communities || []).forEach((c) => ['ip', 'ipv6'].forEach((f) => put(community(ms.dev, c.facet, f)))));
      }
      return byId;
    };
    const get = (id) => all().get(id) || null;
    /** 登錄的每一筆（有 id 的），依登錄順序（位址清單、規則、服務、/routing rule、SNMP community，各依輸入順序；凍結）。 */
    const entries = () => listed || (listed = Object.freeze(Array.from(all().values())));
    return Object.freeze({ list, ofRule, service, community, ofRoutingRule, get, entries });
  }
  /**
   * L4 位址等價類的邊界（唯一的產生方式）：entries（登錄表的筆，可含 null）中位址族為 bits、有集合的那些 set.bounds() 的聯集，依大小排序（BigInt）。
   * 可能有動態來源的清單（set 為 null）不切分。
   */
  function addrBounds(entries, bits) {
    const out = new Set();
    entries.forEach((e) => { if (e && e.set && e.set.bits === bits) e.set.bounds().forEach((b) => out.add(b)); });
    return Array.from(out).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

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
   * 比對用的設備環境。lists：[{ name, defined, include, exclude, members: [ep] }]；ifcEps：設備的介面鍵；rules：該設備的規則；
   * addressLists（選用）：該設備的位址清單（Snapshot 的 addressLists 形狀：{ dev, family, name, static, reasons, entries: [{ address, kind, disabled }] }）。
   * sets（選用）：位址集合的登錄表（addrSets；模型與查詢層各建一份、所有設備共用）；省略時以 rules 與 addressLists 建這台設備自己的一份（同一個函式）。
   * wan／lan：名稱含 WAN／LAN 的清單成員（Set），沒有可辨識的 WAN 清單時 wan 為 null。
   * 位址清單的查詢：sets.list(dev, family, name)——基準裡沒有這份清單（export 沒有項目，也沒有寫入它的設定）時為 null，內容無從得知，不當作空清單。
   */
  function fwContext(dev, lists, ifcEps, rules, addressLists, sets) {
    const reg = sets || addrSets({ rules, addressLists });
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
    return { dev, universe, resolve, sets: reg, chains, wanLists: wan.names, wan: status === 'ok' ? wan.eps : null, lanLists: lan.names, lan: lan.eps, status,
      chain: (family, table, chain) => chains.get(family + '|' + table + '|' + chain) || [] };
  }
  /**
   * 對外入口（唯一的定義；檢查以模型、查詢層以 Snapshot 呼叫，各自傳入 vrfOf 與 external）：ctx.wan（名稱含 WAN 的清單成員）
   * 與 external（對外邊界判定為 external 的介面鍵，boundaries 的 status，ADR-023 決策 7）的聯集，每個介面一筆。
   * 排序：WAN 清單的成員在前（依介面鍵），只由邊界證據判定的在後（依介面鍵）——檢查訊息取第一個入口時，有 WAN 清單的設備結果不變。
   * vrfOf(ep)：介面所在的 VRF；沒有介面紀錄（只出現在 /ip address 或 interface list member）時回 undefined。
   * 回傳 [{ dev, ep, vrf, hasIfc, wanList（是不是 WAN 清單的成員） }]（凍結）。VRF 的規則：
   *   - 沒有介面紀錄的成員也是入口，VRF 視為 main（hasIfc 為 false）。
   *   - 所有 VRF 的成員都是入口。封包只會到達入口所在 VRF 的位址與服務，所以連到設備本身的服務（F07、F10、F14、暴露清單「外部 → 網路設備」）
   *     只取服務所在 VRF 的入口（/ip service 有 vrf 參數，基準沒有解析，視為 main）；轉送與 dst-nat（F03、F04、F05）用全部入口，規則不分 VRF。
   *   - 只看介面清單、不經 IP 的設定（F11 MAC server、F12 鄰居探索、F14 UPnP 的介面）也用全部入口。
   */
  function wanEntries(ctx, vrfOf, external) {
    if (!ctx) return Object.freeze([]);
    const inList = ctx.wan || new Set();
    const eps = S.util.uniq(Array.from(inList).concat(external || []))
      .sort((a, b) => (inList.has(a) ? 0 : 1) - (inList.has(b) ? 0 : 1) || S.util.natural(a, b));
    return Object.freeze(eps.map((ep) => {
      const v = vrfOf(ep);
      return Object.freeze({ dev: ctx.dev, ep, vrf: v === undefined || v === null ? K.MAIN_VRF : K.vrf(v), hasIfc: v !== undefined, wanList: inList.has(ep) });
    }));
  }
  /** 入口中在 vrf 的介面鍵。 */
  const entriesIn = (entries, vrf) => entries.filter((w) => w.vrf === vrf).map((w) => w.ep);
  /**
   * 設定參數的介面清單值（例如 MAC server 的 allowed-interface-list、鄰居探索的 discover-interface-list）包含的介面（Set of ep），無法判斷時 null。
   * 和規則比對共用 ctx.resolve；另外處理設定參數才有的內建清單：none 是空的；static 是所有靜態介面——設定與 interface list 裡的介面
   * 都是靜態的，所以視為全部（推論）；dynamic 無從得知。開頭的 ! 是「除了這個清單以外」（discovery-settings 的型別允許 !）。
   */
  function listMembers(ctx, value) {
    const { neg, body } = splitNeg(String(value == null ? '' : value).trim());
    if (body === 'dynamic') return neg ? ctx.universe : null; // 「!dynamic」＝所有靜態介面
    const set = body === 'static' ? ctx.universe : ctx.resolve(body);
    if (set === null) return null;
    return neg ? new Set(Array.from(ctx.universe).filter((x) => !set.has(x))) : set;
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
  /** 介面 at 是否符合規則在 dir 方向的介面條件（呼叫端已排除無法展開的清單）；all 清單包含任何介面。 */
  function ifcIn(ctx, rule, dir, at) {
    for (const [k, isList] of [[dir + '-interface', false], [dir + '-interface-list', true]]) {
      const v = rule.match[k]; if (v === undefined) continue;
      const { neg, body } = splitNeg(v);
      const has = isList ? body === 'all' || ctx.resolve(body).has(at) : K.ep(ctx.dev, body) === at;
      if (has === neg) return false;
    }
    return true;
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

  /** 位址類型（dst-address-type／src-address-type）對一個單播封包的結果；local 由呼叫端給定（位址是不是這台設備的），其他類型無法判斷。 */
  const addrType = (body, local) => {
    const r = tokens(body).map((t) => (t === 'local' ? (local === undefined ? null : local) : t === 'unicast' ? true : t === 'broadcast' || t === 'multicast' ? false : null));
    return r.includes(true) ? true : r.includes(null) ? null : false;
  };
  /**
   * 一個條件對封包的結果：true／false／null（無法判斷）。檢查（F03–F07、F10、F14）與 Q.reach 共用這一份，兩種封包只差在來源位址：
   *   - pkt.reach 為 true（Q.reach、暴露清單）：來源是已知的位址 src: BigInt|null（null 是 NAT 後不明）。
   *   - 沒有 reach（檢查的「來自 WAN 的新連線」）：來源是基準以外、不在規則列出的任何範圍內的公網位址——src-address 只有涵蓋全部位址時符合；
   *     「!src-address=私有」視為公網來源仍符合；其他排除寫法無法判斷。
   * 其餘條件兩種封包一樣：
   *   - src-port／port 的來源埠：srcPort 是數字時比對，null（用戶端自選）無法判斷；src-address-list／dst-address-list 是完全靜態的清單時依項目判斷（同 src-address／dst-address），
   *     可能有動態來源或基準裡沒有的清單無法判斷（ctx.sets.list）。
   *   - dst-address-type／src-address-type：local 依 dstLocal／srcLocal（位址是不是這台設備的，呼叫端給定；沒給為不明），unicast 符合、broadcast／multicast 不符合。
   *   - ipsec-policy：ipsec 為 'none'（不是 IPsec 封包）才判斷；tcp-flags、icmp-options 依新連線的第一個封包（TCP SYN、ICMP echo request）判斷。
   * pkt：{ family, chain, in: ep, out: ep|null（沒有出介面，例如 input）|undefined（不明）, protocol, dstPort: 數字|null（不是規則提到的埠）, srcPort,
   *        dst: BigInt|undefined, srcLocal, dstLocal, ipsec, state: 'new'|'untracked', natState: null|'dstnat' }。
   */
  function condition(ctx, rule, key, pkt) {
    const v = rule.match[key]; const { neg, body } = splitNeg(v);
    const flip = (x) => (x === null ? null : neg ? !x : x);
    switch (key) {
      case 'protocol': return flip(protoName(body) === pkt.protocol);
      case 'dst-port': { if (pkt.dstPort == null || !PORT_PROTOCOLS.has(pkt.protocol)) return neg; const p = parseVal(key, v); return p.kind === 'ranges' ? flip(inPortRanges(BigInt(pkt.dstPort), p.items)) : null; }
      case 'src-port': case 'port': {
        if (!PORT_PROTOCOLS.has(pkt.protocol)) return neg;
        const p = parseVal(key, v); if (p.kind !== 'ranges') return null;
        if (key === 'port' && pkt.dstPort != null && inPortRanges(BigInt(pkt.dstPort), p.items)) return flip(true);
        return pkt.srcPort == null ? null : flip(inPortRanges(BigInt(pkt.srcPort), p.items));
      }
      // 位址條件：規則的字面值與完全靜態的位址清單都是登錄表的 set（同一個判斷）；可能有動態來源或基準裡沒有的清單無法判斷
      case 'src-address': return srcAddrMatch(neg, ctx.sets.ofRule(rule, key).set, pkt);
      case 'dst-address': return dstAddrMatch(neg, ctx.sets.ofRule(rule, key).set, pkt);
      case 'src-address-list': case 'dst-address-list': {
        const al = ctx.sets.list(ctx.dev, pkt.family, body);
        if (!al || !al.static) return null;
        return key === 'src-address-list' ? srcAddrMatch(neg, al.set, pkt) : dstAddrMatch(neg, al.set, pkt);
      }
      case 'dst-address-type': return flip(addrType(body, pkt.dstLocal));
      case 'src-address-type': return flip(addrType(body, pkt.srcLocal));
      case 'connection-state': return flip(tokens(body).includes(pkt.state));
      case 'connection-nat-state': return pkt.natState ? flip(tokens(body).includes(pkt.natState)) : neg;
      case 'ipsec-policy': if (pkt.ipsec !== 'none') return null; return /ipsec/.test(body) ? neg : /none/.test(body) ? !neg : null;
      case 'tcp-flags': return reachTcpFlags(v, pkt);
      case 'icmp-options': return reachIcmp(v, pkt);
      default: return null;
    }
  }
  /**
   * 來源位址條件（src-address 與展開的 src-address-list 共用）：neg 是開頭的 !，set 是登錄表的 S.ip.set（可以是空的；null 是條件無法判斷）。見 condition。
   * 涵蓋全部（set.isAll）與只有私有位址（set.within 私有位址的集合）只看集合本身，與項目寫法無關。
   */
  function srcAddrMatch(neg, set, pkt) {
    const flip = (x) => (x === null ? null : neg ? !x : x);
    if (set === null) return null;
    if (pkt.reach) {
      if (pkt.src == null || set.bits !== BITS(pkt.family)) return null;
      return flip(set.has(pkt.src));
    }
    if (!neg) return set.isAll;
    return set.within(PRIVATE.get(set.bits)) ? true : null; // 排除私有位址＝公網來源仍符合
  }
  /** 目的位址條件（dst-address 與展開的 dst-address-list 共用）。 */
  function dstAddrMatch(neg, set, pkt) {
    if (pkt.dst === undefined || set === null) return null;
    const x = set.has(pkt.dst);
    return neg ? !x : x;
  }
  /**
   * Q.reach 判斷的是新連線的第一個封包（state new）：TCP 只有 SYN 旗標，ICMP 服務是 echo request（type 8、code 0）。
   * tcp-flags（https://manual.mikrotik.com/docs/cli-reference/ip/firewall/filter.md）：每個旗標各自對 SYN 封包判斷，全部成立才算符合、全部不成立才算不符合；
   *   結果不一致（例如 syn,ack）時多個旗標是「且」還是「或」手冊沒有寫明，不猜（null）；開頭的 ! 與多個旗標並用時也一樣。
   * icmp-options：type[:code[-code]]，開頭的 ! 是否定。只在新連線、而且協定相符時判斷，其他情況 null。
   */
  const TCP_FLAGS = new Set(['fin', 'syn', 'rst', 'psh', 'ack', 'urg', 'ece', 'cwr']);
  function reachTcpFlags(v, pkt) {
    if (pkt.protocol !== 'tcp' || pkt.state !== FW_FIRST_PACKET.state) return null;
    const { neg, body } = splitNeg(v); const ts = tokens(body);
    if (!ts.length || (neg && ts.length > 1)) return null;
    const each = ts.map((t) => { const n = t.startsWith('!'); const f = n ? t.slice(1) : t; if (!TCP_FLAGS.has(f)) return null; return (f === FW_FIRST_PACKET.tcpFlag) !== n; });
    if (each.includes(null)) return null;
    const res = each.every(Boolean) ? true : each.every((x) => !x) ? false : null;
    return res === null ? null : neg ? !res : res;
  }
  function reachIcmp(v, pkt) {
    if (pkt.protocol !== 'icmp' || pkt.state !== FW_FIRST_PACKET.state) return null;
    const { neg, body } = splitNeg(v); const r = String(body).trim().match(/^(\d+)(?::(\d+)(?:-(\d+))?)?$/);
    if (!r) return null;
    const c = FW_FIRST_PACKET.icmpCode;
    const hit = +r[1] === FW_FIRST_PACKET.icmpType && (r[2] === undefined || (c >= +r[2] && c <= +(r[3] === undefined ? r[2] : r[3])));
    return neg ? !hit : hit;
  }
  /** why（選用）：結果為 null 時，收集無法判斷的條件鍵（介面不明時是 in-interface／out-interface，清單無法展開時是該清單的鍵）。 */
  function ruleMatches(ctx, rule, pkt, why) {
    let res = true;
    for (const dir of ['in', 'out']) {
      if (rule.match[dir + '-interface'] === undefined && rule.match[dir + '-interface-list'] === undefined) continue;
      const at = pkt[dir];
      if (at === undefined) { res = null; if (why) why.push(dir + '-interface'); continue; }
      const e = ifcSet(ctx, rule, dir);
      if (e === UNKNOWN) { res = null; if (why) why.push(dir + '-interface-list'); continue; }
      if (at === null) { // 沒有這個方向的介面（例如 input 沒有出介面）：只有否定條件會成立
        const negOnly = [dir + '-interface', dir + '-interface-list'].every((k) => rule.match[k] === undefined || splitNeg(rule.match[k]).neg);
        if (!negOnly) return false; continue;
      }
      // 介面不在比對環境的介面全集裡（例如只出現在 /ip dhcp-client 的對外介面）：逐一條件判斷，否定的條件對它成立
      if (!ctx.universe.has(at) ? !ifcIn(ctx, rule, dir, at) : !e.has(at)) return false;
    }
    for (const k of Object.keys(rule.match)) {
      if (/^(in|out)-interface(-list)?$/.test(k)) continue;
      const kind = condKind(k);
      const c = kind === 'condition' || kind === 'address-list' ? condition(ctx, rule, k, pkt) : null;
      if (c === false) return false;
      if (c === null) { res = null; if (why) why.push(k); }
    }
    return res;
  }
  /**
   * 檢查用的 chain 判斷：decide 的包裝（同一套 first-match、jump／return 與三值條件，Q.reach 也用 decide）。
   * 回傳 { verdict, rule, path, uncertain }：verdict 為 accept／drop／notrack（raw）／NAT 動作（nat；accept 為 none）；沒有規則決定時為 null。
   * 條件無法判斷、而且會改變結果時 verdict 為 'unknown'（rule 為 null，uncertain 列出那些規則與條件）——不再把這種規則當作不存在。
   */
  function evalChain(ctx, family, table, chain, pkt) {
    const d = decide(ctx, family, table, chain, pkt);
    if (!d.decided) return { verdict: 'unknown', rule: null, path: [], uncertain: d.uncertain };
    if (d.policy) return { verdict: null, rule: null, path: d.path, uncertain: [] };
    return { verdict: d.verdict, rule: d.rule, path: d.path, uncertain: [] };
  }
  /**
   * 從 WAN 進來的新連線：先看 raw prerouting（丟掉就到不了；notrack 之後連線狀態是 untracked，同 Q.reach），再走 table（預設 filter）的內建 chain。
   * filter 沒有規則決定時內建 chain 預設放行（policy）；nat 沒有規則決定時 verdict 為 null。raw 或 table 無法判斷時 verdict 為 'unknown'（raw 的另標 raw）。
   */
  function evalFilter(ctx, family, builtin, pkt, table) {
    const t = table || 'filter';
    const raw = evalChain(ctx, family, 'raw', 'prerouting', Object.assign({}, pkt, { out: undefined }));
    if (raw.verdict === 'unknown') return Object.assign(raw, { raw: true });
    if (raw.verdict === 'drop') return { verdict: 'drop', rule: raw.rule, path: raw.path, raw: true, uncertain: [] };
    const f = evalChain(ctx, family, t, builtin, raw.verdict === 'notrack' ? Object.assign({}, pkt, { state: 'untracked' }) : pkt);
    if (f.verdict || t !== 'filter') return f;
    return { verdict: 'accept', rule: null, path: [], policy: true, uncertain: [] };
  }
  /**
   * 三值的 chain 判斷（Q.reach 用）：和 evalChain 一樣依序走（含 jump／return），但條件無法判斷的規則不略過，而是列出所有可能的結果。
   * 回傳 { decided, verdict, rule, policy, path, hits, uncertain, outcomes }：
   *   outcomes：[{ verdict, rule, path, policy }]，verdict 依表正規化：filter／raw 為 accept／drop（raw 另有 notrack），
   *     nat 為 NAT 動作或 none（accept、沒有規則決定）；沒有規則決定時 rule 為 null、policy 為 true（內建 chain 的預設）。
   *   decided：所有可能的結果相同（nat 另要是同一條規則，因為改寫的位址可能不同）。verdict／rule／policy／path 是條件都成立時的結果：
   *     第一條確定命中的終止規則，沒有就是預設。
   *   hits：確定命中的規則（依序，含 jump 與不終止比對的動作，例如 log、passthrough）。
   *   uncertain：[{ rule, keys, verdicts }]：條件無法判斷、命中時會導向某個結果的規則；keys 是無法判斷的條件，verdicts 是它可能導向的結果。
   * skip：當作停用的規則鍵（Set；估計停用一條規則的影響用）。
   */
  function decide(ctx, family, table, chain, pkt, skip) {
    const hits = []; const uncertain = [];
    const walk = (ch, via, sure) => {
      const outs = [];
      if (via.length > FW_MAX_JUMP) { outs.push({ cont: true }); return outs; }
      const p = Object.assign({}, pkt, { chain: ch });
      for (const r of ctx.chain(family, table, ch)) {
        if (r.disabled || (skip && skip.has(r.key))) continue;
        const why = [];
        const m = ruleMatches(ctx, r, p, why);
        if (m === false) continue;
        const definite = sure && m === true;
        let res;
        if (r.action === 'jump') {
          const target = r.params['jump-target'];
          if (!target || via.some((x) => x.params['jump-target'] === target) || target === ch) continue;
          if (definite) hits.push(r);
          res = walk(target, via.concat(r), definite);
        } else if (r.action === 'return') { if (definite) hits.push(r); res = [{ ret: true }]; }
        else if (r.action === 'drop' || r.action === 'reject' || r.action === 'tarpit') { if (definite) hits.push(r); res = [{ verdict: 'drop', rule: r, path: via }]; }
        else if (FW_TERMINAL.has(r.action) || (table === 'raw' && r.action === 'notrack')) { if (definite) hits.push(r); res = [{ verdict: r.action, rule: r, path: via }]; }
        else { if (definite) hits.push(r); res = [{ cont: true }]; }
        const finals = res.filter((o) => !o.cont && !o.ret);
        if (m === null && (finals.length || res.some((o) => o.ret))) uncertain.push({ rule: r, keys: why, verdicts: S.util.uniq(finals.map((o) => norm(table, o.verdict)).concat(res.some((o) => o.ret) ? ['return'] : [])) });
        outs.push(...finals);
        if (m !== true) continue;
        if (res.some((o) => o.ret)) { outs.push({ cont: true }); return outs; } // return：這個 chain 到此結束，回到呼叫的 chain
        if (!res.some((o) => o.cont)) return outs; // 在這裡一定有結果
      }
      outs.push({ cont: true });
      return outs;
    };
    const outs = walk(chain, [], true);
    const seen = new Map();
    const outcome = (o) => {
      const verdict = o.cont ? (table === 'nat' ? 'none' : 'accept') : norm(table, o.verdict);
      return { key: table === 'nat' && verdict !== 'none' ? verdict + '|' + o.rule.key : verdict, verdict, rule: o.cont ? null : o.rule, path: o.path || [], policy: !!o.cont };
    };
    outs.forEach((o) => { const x = outcome(o); if (!seen.has(x.key)) seen.set(x.key, x); });
    const primary = outcome(outs[outs.length - 1]);
    return { decided: seen.size === 1, verdict: primary.verdict, rule: primary.rule, policy: primary.policy, path: primary.path, hits, uncertain,
      outcomes: Array.from(seen.values()).map(({ key, ...x }) => x) };
  }
  const norm = (table, verdict) => (table === 'nat' && verdict === 'accept' ? 'none' : verdict);
  /**
   * 來自 WAN 的新連線（檢查用，條件的判斷見 condition）：來源不是這台設備、不是 IPsec 封包、來源埠由用戶端自選（不明）；
   * 目的是不是這台設備：input 是、forward 不是、其他（dstnat）不明。o 覆寫其他欄位。
   */
  const wanPacket = (family, inEp, chain, o) => Object.assign({ family, in: inEp, out: chain === 'input' ? null : undefined, protocol: 'tcp', dstPort: null, srcPort: null,
    dst: undefined, srcLocal: false, dstLocal: chain === 'input' ? true : chain === 'forward' ? false : undefined, ipsec: 'none', state: 'new', natState: null }, o);
  /** 由規則本身的條件組出「會符合它」的 WAN 封包（協定、第一個目的埠／位址、出介面）。 */
  function packetFor(rule, inEp, chain, ctx) {
    const first = (k) => { const v = rule.match[k]; if (v === undefined || splitNeg(v).neg) return undefined; const p = parseVal(k, v); return p.kind === 'ranges' ? p.items[0][0] : undefined; };
    const proto = rule.match.protocol && !splitNeg(rule.match.protocol).neg ? protoName(tokens(splitNeg(rule.match.protocol).body)[0]) : 'tcp';
    const dp = first('dst-port'); const dst = first('dst-address');
    const out = rule.match['out-interface'] && !splitNeg(rule.match['out-interface']).neg ? K.ep(ctx.dev, rule.match['out-interface']) : chain === 'input' ? null : undefined;
    return wanPacket(rule.family, inEp, chain, { out, protocol: proto, dstPort: dp === undefined ? null : Number(dp), dst });
  }

  /**
   * 狀態式骨架（回程的前提，F15 與 Q.policyBaseline）：IPv4 filter 的 input、forward 各自對「已建立」與「invalid」的封包怎麼處理，以及 chain 的預設動作。
   * 依據（https://manual.mikrotik.com/docs/firewall-and-quality-of-service/connection-tracking.md）：不是 new 的封包屬於 established、related，
   *   或不屬於任何連線（invalid，多數情況應丟棄）；建議的基本規則是放行 established／related、丟棄 invalid，細部規則只看 new。
   *   fasttrack-connection 標記的連線之後的封包繞過防火牆，所以搭配 established 也算放行（手冊另建議後面接一條相同條件的 accept）。
   * 走法和 evalChain 相同（first-match、jump／return、內建 chain 沒有規則決定時放行），但封包是「任意一個該狀態的封包」：
   *   規則只有 connection-state（以及 STATE_IGNORE）條件時才算一定命中；其他條件（介面、位址、協定…）的規則只對部分封包成立，不決定結果，
   *   放行的另列為 conditional。這是事實（規則）推得的判斷，不看 WAN／LAN。
   */
  const STATE_IGNORE = new Set(['hw-offload']); // fasttrack-connection 的參數，adapter 把它放在 match，不是比對條件
  const IFC_KEYS = new Set(['in-interface', 'in-interface-list', 'out-interface', 'out-interface-list']);
  const DROP_ACTIONS = new Set(['drop', 'reject', 'tarpit']);
  /** 規則對「任意一個 state 狀態的封包」：true（一定命中）／false（一定不命中）／null（只對部分封包成立）。 */
  function stateMatch(rule, state) {
    let res = true;
    for (const k of Object.keys(rule.match)) {
      if (STATE_IGNORE.has(k)) continue;
      if (k === 'connection-state') {
        const { neg, body } = splitNeg(rule.match[k]); const has = tokens(body).map((t) => t.toLowerCase()).includes(state);
        if (has === neg) return false;
        continue;
      }
      res = null;
    }
    return res;
  }
  /** 只以介面為條件（可另有不排除這個狀態的 connection-state）的規則。 */
  const ifcOnly = (r) => { const keys = Object.keys(r.match).filter((k) => !STATE_IGNORE.has(k) && k !== 'connection-state'); return keys.length > 0 && keys.every((k) => IFC_KEYS.has(k)); };
  /**
   * 依序走 chain：{ verdict: accept|drop|null（沒有規則決定）, rule, path（jump 規則）, conditional: [{ rule, path }]（只對部分封包放行的規則）,
   *   ifcDrops: [{ rule, path }]（決定之前、一定會走到的位置上只以介面為條件的丟棄：從那些介面進來的這種封包在這裡就被丟掉） }。
   */
  function walkState(ctx, family, chain, state) {
    const conditional = []; const ifcDrops = [];
    const walk = (ch, via, sure) => {
      if (via.length > FW_MAX_JUMP) return null;
      for (const r of ctx.chain(family, 'filter', ch)) {
        if (r.disabled) continue;
        const m = stateMatch(r, state);
        if (m === false) continue;
        const definite = sure && m === true;
        if (r.action === 'jump') {
          const target = r.params['jump-target'];
          if (!target || target === ch || via.some((x) => x.params['jump-target'] === target)) continue;
          const sub = walk(target, via.concat(r), definite);
          if (sub) return sub;
          continue;
        }
        if (!definite) {
          if (r.action === 'accept' || r.action === 'fasttrack-connection') conditional.push({ rule: r, path: via });
          else if (sure && DROP_ACTIONS.has(r.action) && ifcOnly(r)) ifcDrops.push({ rule: r, path: via });
          continue;
        }
        if (r.action === 'return') return null;
        if (r.action === 'accept' || r.action === 'fasttrack-connection') return { verdict: 'accept', rule: r, path: via };
        if (DROP_ACTIONS.has(r.action)) return { verdict: 'drop', rule: r, path: via };
      }
      return null;
    };
    const res = walk(chain, [], true) || { verdict: null, rule: null, path: [] };
    return Object.assign(res, { conditional, ifcDrops });
  }
  /** 放行這個狀態的規則（connection-state 正向含這個狀態，動作是 accept 或 fasttrack-connection）。 */
  const acceptsState = (r, state) => (r.action === 'accept' || r.action === 'fasttrack-connection') && r.match['connection-state'] !== undefined
    && stateMatch(r, state) !== false && !splitNeg(r.match['connection-state']).neg;
  /**
   * 預設動作：chain 本身（不進 jump）第一條一定命中所有封包的 drop／reject／tarpit（scope all），沒有時最後一條只以介面為條件、
   * 不限 connection-state 的丟棄（scope interface，例如 defconf 的「drop all not coming from LAN」）；都沒有時是內建 chain 的預設放行。
   * 在無條件 drop 之前的無條件 accept 讓 chain 成為放行（scope all）。
   */
  function defaultAction(ctx, family, chain) {
    let ifcDrop = null;
    for (const r of ctx.chain(family, 'filter', chain)) {
      if (r.disabled) continue;
      const keys = Object.keys(r.match).filter((k) => !STATE_IGNORE.has(k));
      if (!keys.length && (DROP_ACTIONS.has(r.action) || r.action === 'accept')) return { action: r.action, scope: 'all', policy: false, rule: r };
      if (DROP_ACTIONS.has(r.action) && keys.length && keys.every((k) => IFC_KEYS.has(k))) ifcDrop = r;
    }
    return ifcDrop ? { action: ifcDrop.action, scope: 'interface', policy: false, rule: ifcDrop } : { action: 'accept', scope: null, policy: true, rule: null };
  }
  const POLICY_CHAINS = ['input', 'forward'];
  /**
   * 每個 chain 的狀態式骨架：[{ family, chain, rules（啟用中的規則數，不含 jump 進去的）, established, invalid, defaultAction, returnSafe }]。
   *   established：{ status: accept（規則放行）|policy（沒有規則決定，預設放行）|drop（先被一定命中的丟棄規則擋下）, rule, path, conditional, shadowed }；
   *     shadowed 是 status 為 drop 時，chain 中排在它之後、放行 established 的規則（走不到）；
   *     blockedFrom：[{ rule, path, interfaces }] 排在決定之前、只以介面為條件的丟棄（status 不是 drop 時），從 interfaces 進來的回程不保證。
   *   invalid：{ status: drop|accept|policy, rule, path, explicit（決定的規則是否明確比對 connection-state=invalid） }。
   *   returnSafe：false 表示已建立連線的回程封包可能被丟棄（沒有一定走得到的 established 放行而且有丟棄，或有 blockedFrom）——F15 的條件。
   * 物件內的 rule 是規則物件（呼叫端轉成鍵）。
   */
  function policyBaseline(ctx, family) {
    const fam = family || 'ip';
    return POLICY_CHAINS.map((chain) => {
      const list = ctx.chain(fam, 'filter', chain).filter((r) => !r.disabled);
      const e = walkState(ctx, fam, chain, 'established');
      const shadowed = e.verdict === 'drop' ? list.filter((r) => r.position > (e.path[0] || e.rule).position && acceptsState(r, 'established')) : [];
      // 介面條件的丟棄排在決定之前：從那些介面進來的回程不保證（in 方向的介面；只限 out 方向或清單無法展開時 interfaces 為 null）
      const blockedFrom = e.verdict === 'drop' ? [] : e.ifcDrops.map(({ rule, path }) => {
        const set = ifcSet(ctx, rule, 'in');
        return { rule, path, interfaces: set && set !== UNKNOWN ? Array.from(set).sort(S.util.natural) : null };
      });
      const established = { status: e.verdict || 'policy', rule: e.rule, path: e.path, conditional: e.conditional.map((x) => x.rule), shadowed, blockedFrom };
      const v = walkState(ctx, fam, chain, 'invalid');
      const invalid = { status: v.verdict || 'policy', rule: v.rule, path: v.path, explicit: !!(v.rule && v.rule.match['connection-state'] !== undefined) };
      const dflt = defaultAction(ctx, fam, chain);
      const returnSafe = !blockedFrom.length && (established.status === 'accept' || (established.status === 'policy' && !DROP_ACTIONS.has(dflt.action)));
      return { family: fam, chain, rules: list.length, established, invalid, defaultAction: dflt, returnSafe };
    });
  }

  /**
   * IPv6 是否在用（推論）：/ipv6 settings 停用為 disabled；有 /ipv6 address、/ipv6 dhcp-client 或 /ipv6 firewall 規則為 used（src 是第一個證據行）；
   * 都沒有為 unknown（export 只列非預設值，無從判斷 IPv6 有沒有位址，不猜）。
   */
  function ipv6Status(M, dev, rules) {
    const v = M.fw.ipv6.get(dev);
    if (v && v.disabled) return { status: 'disabled', src: [v.disabled] };
    const r = rules.find((x) => x.family === 'ipv6');
    const ev = (v ? v.use : []).concat(r ? [[r.block, r.line]] : []).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return ev.length ? { status: 'used', src: [ev[0]] } : { status: 'unknown', src: [] };
  }

  /** 推論：每台有設定資料的設備的 WAN／LAN 分類與有效的 /ip service（含預設值）。 */
  function firewall(M) {
    M.fwZones = new Map(); M.fwServices = new Map(); M.fwCtx = new Map(); M.wanEntries = new Map();
    const ifcsByDev = new Map(); M.ifcs.forEach((i) => S.util.getOr(ifcsByDev, i.dev, () => []).push(i.key));
    const listsByDev = new Map(); M.fw.lists.forEach((l) => S.util.getOr(listsByDev, l.dev, () => []).push({ name: l.name, defined: l.defined, include: l.include, exclude: l.exclude, members: Array.from(l.members.keys()) }));
    const rulesByDev = new Map(); M.fw.rules.forEach((r) => S.util.getOr(rulesByDev, r.dev, () => []).push(r));
    const alByDev = new Map(); M.addressLists.forEach((l) => S.util.getOr(alByDev, l.dev, () => []).push(l));
    // 位址集合的登錄表（所有設備共用一份；查詢層從 Snapshot 以同一個函式建）。服務在下面逐台補上，登錄表第一次查服務時才建索引
    const svcAll = [];
    M.addrSets = addrSets({ rules: M.fw.rules, addressLists: M.addressLists, services: svcAll, routingRules: M.policy.rules, mgmtSettings: Array.from(M.mgmtSettings.values()) });
    M.devices.forEach((d) => {
      if (!d.collected || !d.data.has('config')) return;
      const ctx = fwContext(d.key, listsByDev.get(d.key) || [], ifcsByDev.get(d.key) || [], rulesByDev.get(d.key) || [], alByDev.get(d.key) || [], M.addrSets);
      M.fwCtx.set(d.key, ctx); // 對外入口 M.wanEntries 要等邊界推論完成（entriesOf）
      M.fwZones.set(d.key, { dev: d.key, basis: ctx.status === 'ok' ? 'interface-list' : null, status: ctx.status, wanLists: ctx.wanLists, wanInterfaces: ctx.wan ? Array.from(ctx.wan).sort(S.util.natural) : [],
        lanLists: ctx.lanLists, lanInterfaces: Array.from(ctx.lan).sort(S.util.natural), ipv6: ipv6Status(M, d.key, rulesByDev.get(d.key) || []) });
      const svcs = new Map(SERVICE_DEFAULTS.map(([name, port, enabled]) => [name, { dev: d.key, name, enabled, port, addresses: [], basis: 'default', src: [] }]));
      M.fw.services.forEach((sv) => {
        if (sv.dev !== d.key) return;
        const base = svcs.get(sv.name) || { dev: d.key, name: sv.name, enabled: true, port: null, addresses: [], basis: 'export', src: [] };
        svcs.set(sv.name, { dev: d.key, name: sv.name, enabled: sv.disabled === null ? base.enabled : !sv.disabled, port: sv.port ?? base.port,
          addresses: sv.addresses ?? base.addresses, basis: 'export', src: sv.src.slice() });
      });
      M.fwServices.set(d.key, Array.from(svcs.values()).sort((a, b) => S.util.natural(a.name, b.name)));
      svcAll.push(...M.fwServices.get(d.key));
    });
  }

  // ================================================================ 對外邊界與路由網域（ADR-023）
  /*
   * 對外邊界（推論，M.boundaries → Snapshot model.boundaries）：每台已收集設備、每個有證據的介面一筆 { dev, ep, vrf, hasIfc, status, evidence }。
   * 證據（evidence[]：{ kind, strength, src: [[區塊, 行號]], ref }，ref 是這個證據的資料，例如路由、規則鍵）依 ADR-023「決定」第 2、3 項：
   *   強（strong，單獨就判定對外）：
   *     default-route：路由表中 0.0.0.0/0 的出介面（含非作用中的備援路由，ref.active）。下一跳是基準內設備的位址時指向內部（例如 PE 的預設路由指向核心），
   *       記為 none、不算（推論；ADR-023 沒有寫到這一點，避免內部路由器的預設路由都被當成對外）。
   *     dhcp-client：/ip dhcp-client 的 add-default-route 是 yes 或 special-classless、沒有停用（停用的記為 none）。
   *     pppoe-client：/interface pppoe-client 的 add-default-route=yes、沒有停用（介面是 PPPoE 介面本身）。
   *     兩者的強度跟著它裝進來的預設路由（ADR-023 修訂 1）：add-default-route 的預設是 yes，以 DHCP 取得管理位址的交換器／AP 也有，所以設定本身不是對外的證據。
   *       設備有路由表資料時，看出介面是這個介面的預設路由（DHCP client 只看 proto DHCP）：有下一跳不在基準內 → strong；下一跳都是基準內設備 → none（next-hop-in-baseline）；
   *       沒有路由表資料、或路由表中沒有這條預設路由（例如還沒取得位址）→ weak（no-route-data／no-installed-route，只標可能對外、不算入口）。PPPoE 是否停用不明時最多 weak。
   *     srcnat-out：srcnat 的 masquerade／src-nat 的 out-interface、out-interface-list（展開成員；否定、清單無法展開時不歸屬任何介面）。
   *       規則另限了 dst-address／dst-address-list（例如 hairpin NAT）時為 weak。
   *     dstnat-in：dstnat 的 dst-nat／netmap 的 in-interface、in-interface-list（同上）；入介面是 LAN 清單的成員時為 weak（ref.reason lan-list：從內部進來的轉送）。
   *   弱（weak）：public-address（介面上的位址是公網，S.ip.classify 為 public）、cgnat-address（100.64.0.0/10，電信業者那一側）、
   *     dstnat-address（dst-nat 的 dst-address 是這台設備介面上的公網位址）、wan-list（名稱含 WAN 的 interface list 的成員，firewallZones 的同一份判斷）。
   * status：有強證據 → external；只有弱證據但有 wan-list → external（維持名稱判斷的結果）；其他只有弱證據 → possible；證據都是 none → internal。
   * 沒有列出的介面沒有任何證據（internal）。停用的規則與停用的設定不列。firewallZones 的語意不變。
   */
  /** 證據種類（evidence[].kind）的顯示名稱：檢查的訊息與畫面（S.query.boundaryLabel）共用的唯一來源。 */
  const BOUNDARY_LABEL = Object.freeze({
    'default-route': '預設路由的出介面', 'dhcp-client': 'DHCP client 加入的預設路由', 'pppoe-client': 'PPPoE client 加入的預設路由',
    'srcnat-out': 'srcnat 的出介面', 'dstnat-in': 'dst-nat 的入介面', 'wan-list': 'WAN 清單',
    'public-address': '公網位址', 'cgnat-address': 'CGNAT 位址', 'dstnat-address': 'dst-nat 的目的位址',
  });
  const STRENGTH_ORDER = ['strong', 'weak', 'none'];
  const DEFAULT_ROUTE_ADD = new Set(['yes', 'special-classless']);
  function boundaries(M) {
    const out = new Map(); // ep → entry
    const collected = new Set(Array.from(M.devices.values()).filter((d) => d.collected).map((d) => d.key));
    // 基準內設備的位址（不分 VRF；預設路由的下一跳是不是指向內部）
    const owned = new Set();
    M.ifcs.forEach((i) => { if (!i.hearsay) i.ips.forEach((_, c) => { const p = S.ip.parseCidr(c); if (p) owned.add(p.ip); }); });
    M.devices.forEach((d) => { if (d.mgmtIp) owned.add(d.mgmtIp); });
    const ifcsByDev = new Map(); M.ifcs.forEach((i) => { if (!i.hearsay) S.util.getOr(ifcsByDev, i.dev, () => []).push(i); });
    const add = (dev, ep, kind, strength, src, ref) => {
      if (!collected.has(dev) || !ep) return;
      const e = S.util.getOr(out, ep, () => { const i = M.ifcs.get(ep); return { dev, ep, vrf: K.vrf(i ? i.vrf : null), hasIfc: !!i, status: null, evidence: [] }; });
      e.evidence.push({ kind, strength, src: src.map((x) => x.slice()), ref });
    };
    // 下一跳 → 出介面：路由視圖的 egress（寫了介面就是它，否則是同一個 VRF 中直連網段包含閘道的介面）
    const RV = routingView(M);
    M.routes.forEach((r) => {
      if (r.len !== 0 || r.blackhole) return;
      r.nh.forEach((n) => {
        const ep = RV.egress(r.dev, n);
        const inside = !!(n.ip && owned.has(n.ip));
        add(r.dev, ep, 'default-route', inside ? 'none' : 'strong', [[r.block, r.line]],
          { prefix: '0.0.0.0/0', routingTable: r.routingTable, gateway: n.ip, active: r.active, distance: r.distance, reason: inside ? 'next-hop-in-baseline' : null });
      });
    });
    // DHCP／PPPoE client 裝進來的預設路由：{ strength, reason, gateways }（見上方說明）
    const installed = (dev, ep, dhcpOnly) => {
      const d = M.devices.get(dev);
      if (!d || !d.data.has('route')) return { strength: 'weak', reason: 'no-route-data', gateways: [] };
      const nhs = [];
      M.routes.forEach((r) => {
        if (r.dev !== dev || r.len !== 0 || r.blackhole || (dhcpOnly && r.proto !== 'DHCP')) return;
        r.nh.forEach((n) => { if (RV.egress(dev, n) === ep) nhs.push(n); });
      });
      if (!nhs.length) return { strength: 'weak', reason: 'no-installed-route', gateways: [] };
      const gateways = S.util.uniq(nhs.map((n) => n.ip).filter(Boolean));
      const outside = nhs.some((n) => !n.ip || !owned.has(n.ip));
      return { strength: outside ? 'strong' : 'none', reason: outside ? null : 'next-hop-in-baseline', gateways };
    };
    M.routingCfgOut.dhcpClients.forEach((c) => {
      if (!c.ep || !DEFAULT_ROUTE_ADD.has(c.addDefaultRoute)) return;
      const r = c.disabled === true ? { strength: 'none', reason: 'disabled', gateways: [] } : installed(c.dev, c.ep, true);
      add(c.dev, c.ep, 'dhcp-client', r.strength, c.src, { name: c.name, addDefaultRoute: c.addDefaultRoute, disabled: c.disabled, gateways: r.gateways, reason: r.reason });
    });
    M.routingCfgOut.pppoeClients.forEach((c) => {
      if (!c.ep || c.addDefaultRoute !== true) return;
      let r = c.disabled === true ? { strength: 'none', reason: 'disabled', gateways: [] } : installed(c.dev, c.ep, false);
      if (c.disabled === null && r.strength === 'strong') r = Object.assign({}, r, { strength: 'weak', reason: 'disabled-unknown' });
      add(c.dev, c.ep, 'pppoe-client', r.strength, c.src, { name: c.name, interface: c.interface, disabled: c.disabled, gateways: r.gateways, reason: r.reason });
    });
    // NAT：介面或清單（展開成員）；否定與無法展開的清單不歸屬
    const natIfcs = (ctx, rule, dir) => {
      const eps = [];
      const one = rule.match[dir + '-interface']; const list = rule.match[dir + '-interface-list'];
      if (one !== undefined && !splitNeg(one).neg) eps.push(K.ep(rule.dev, one));
      if (list !== undefined && !splitNeg(list).neg && ctx) { const set = ctx.resolve(list); if (set) eps.push(...Array.from(set).sort(S.util.natural)); }
      return S.util.uniq(eps);
    };
    M.fw.rules.forEach((r) => {
      if (r.disabled || r.table !== 'nat' || r.family !== 'ip') return;
      const ctx = M.fwCtx.get(r.dev);
      if (r.chain === 'srcnat' && (r.action === 'masquerade' || r.action === 'src-nat')) {
        const narrow = r.match['dst-address'] !== undefined || r.match['dst-address-list'] !== undefined;
        natIfcs(ctx, r, 'out').forEach((ep) => add(r.dev, ep, 'srcnat-out', narrow ? 'weak' : 'strong', [[r.block, r.line]], { rule: r.key, action: r.action, reason: narrow ? 'restricted-destination' : null }));
      } else if (r.chain === 'dstnat' && (r.action === 'dst-nat' || r.action === 'netmap')) {
        // LAN 清單的成員：從 LAN 進來的 dst-nat（例如把內部的連線轉到伺服器）不是對外的證據，記為 weak（ref.reason lan-list）
        natIfcs(ctx, r, 'in').forEach((ep) => { const lan = !!(ctx && ctx.lan.has(ep)); add(r.dev, ep, 'dstnat-in', lan ? 'weak' : 'strong', [[r.block, r.line]], { rule: r.key, action: r.action, reason: lan ? 'lan-list' : null }); });
        const da = r.match['dst-address'];
        if (da !== undefined && !splitNeg(da).neg && S.ip.isIp(da) && S.ip.classify(da) === 'public') {
          (ifcsByDev.get(r.dev) || []).filter((i) => Array.from(i.ips.keys()).some((c) => { const p = S.ip.parseCidr(c); return p && p.ip === da; }))
            .forEach((i) => add(r.dev, i.key, 'dstnat-address', 'weak', [[r.block, r.line]], { rule: r.key, address: da }));
        }
      }
    });
    M.ifcs.forEach((i) => {
      if (i.hearsay) return;
      i.ips.forEach((src, c) => {
        const p = S.ip.parseCidr(c); if (!p || i.rawType === 'vrrp') return;
        const cls = S.ip.classify(p.ip);
        if (cls === 'public' || cls === 'cgnat') add(i.dev, i.key, cls === 'public' ? 'public-address' : 'cgnat-address', 'weak', [src], { address: c, class: cls });
      });
    });
    M.fwCtx.forEach((ctx, dev) => {
      if (!ctx.wan) return;
      ctx.wan.forEach((ep) => {
        const src = []; const lists = [];
        ctx.wanLists.forEach((n) => { const l = M.fw.lists.get(dev + '|' + n); const s = l && l.members.get(ep); if (s) { src.push(s); lists.push(n); } });
        add(dev, ep, 'wan-list', 'weak', src, { lists: lists.length ? lists : ctx.wanLists.slice() });
      });
    });
    out.forEach((e) => {
      e.evidence.sort((a, b) => STRENGTH_ORDER.indexOf(a.strength) - STRENGTH_ORDER.indexOf(b.strength) || S.util.cmp(a.kind, b.kind)
        || (a.src[0] ? a.src[0][0] : -1) - (b.src[0] ? b.src[0][0] : -1) || (a.src[0] ? a.src[0][1] : -1) - (b.src[0] ? b.src[0][1] : -1));
      const has = (s) => e.evidence.some((x) => x.strength === s);
      e.status = has('strong') || e.evidence.some((x) => x.kind === 'wan-list') ? 'external' : has('weak') ? 'possible' : 'internal';
    });
    M.boundaries = Array.from(out.values()).sort((a, b) => S.util.natural(a.dev, b.dev) || S.util.natural(a.ep, b.ep));
  }
  /** 對外入口（M.wanEntries，dev → 凍結陣列）：每台有比對環境的設備，WAN 清單成員＋判定為 external 的邊界（S.infer.fw.wanEntries）。 */
  function entriesOf(M) {
    const vrfOf = (ep) => { const i = M.ifcs.get(ep); return i ? i.vrf : undefined; };
    const ext = new Map(); M.boundaries.forEach((b) => { if (b.status === 'external') S.util.getOr(ext, b.dev, () => []).push(b.ep); });
    M.fwCtx.forEach((ctx, dev) => M.wanEntries.set(dev, wanEntries(ctx, vrfOf, ext.get(dev) || [])));
  }

  /*
   * 模型版的路由視圖（ADR-023「決定」第 7 項）：成員與 S.trace.ROUTING_VIEW 相同（vrfs、vrfsOf、subnetsOf、routesOf、routesInTable、hopOwner、policyOf、routesIncomplete、addrSets），
   * 語意與回傳形狀同 Q 的同名函式（docs/查詢介面.md），只是讀內部模型 M；檢查（⑥）把它交給 S.trace 的單跳轉送決定（lookup），
   * 和 L3 路由追蹤、L4 可達性用同一套判斷，不呼叫查詢層。回傳的陣列每次相同（S.trace 依陣列快取數字形式）。每個 M 建立一次。
   * 另有 egress(dev, nh)：下一跳（routes[].nh 的元素）的出介面鍵——寫了介面就是它，否則是同一個 VRF 中直連網段包含閘道的介面（依介面鍵取第一個）；
   * 找不到時 null。對外邊界的預設路由證據、R01、R07、R09–R12 共用。
   */
  const rvMemo = new WeakMap();
  function routingView(M) {
    if (rvMemo.has(M)) return rvMemo.get(M);
    const U = S.util; const MAIN = K.MAIN_VRF; const EMPTY = Object.freeze([]);
    const own = Array.from(M.ifcs.values()).filter((i) => !i.hearsay).sort((a, b) => U.natural(a.key, b.key));
    const subnets = []; const ipOwner = new Map(); const ownersByIp = new Map();
    own.forEach((i) => Array.from(i.ips.keys()).sort(U.natural).forEach((c) => {
      const p = S.ip.parseCidr(c); if (!p) return;
      const vrf = K.vrf(i.vrf);
      ipOwner.set(K.inVrf(p.ip, vrf), i.key);
      U.getOr(ownersByIp, p.ip, () => []).push({ ep: i.key, dev: i.dev, vrf, net: p.len < 32 ? p.net : null, len: p.len });
      if (p.len < 32) subnets.push(Object.freeze({ ep: i.key, dev: i.dev, net: p.net, len: p.len, ip: p.ip, vrf, prefix: K.inVrf(p.net + '/' + p.len, vrf) }));
    }));
    M.devices.forEach((d) => { if (d.mgmtIp && !ipOwner.has(d.mgmtIp)) ipOwner.set(d.mgmtIp, d.key + '|'); });
    const subnetsByDev = new Map(); subnets.forEach((s) => U.getOr(subnetsByDev, s.dev, () => []).push(s));
    subnetsByDev.forEach((v) => Object.freeze(v));
    const routesByDev = new Map(); M.routes.forEach((r) => { if (r.active !== false) U.getOr(routesByDev, r.dev, () => []).push(r); });
    routesByDev.forEach((v) => Object.freeze(v));
    const memo = new Map();
    const once = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
    let vrfNames = null;
    const vrfs = () => vrfNames || (vrfNames = (() => {
      const set = new Set([MAIN]);
      M.vrfs.forEach((defs) => defs.forEach((v) => { if (!v.disabled) set.add(v.name); }));
      M.ifcs.forEach((i) => set.add(K.vrf(i.vrf)));
      M.arps.forEach((a) => set.add(K.vrf(a.vrf)));
      M.routes.forEach((r) => { if (r.vrf != null) set.add(r.vrf); });
      return Object.freeze(Array.from(set).sort((a, b) => (a === MAIN ? -1 : b === MAIN ? 1 : U.natural(a, b))));
    })());
    const subnetsOf = (d, vrf) => (vrf === undefined ? subnetsByDev.get(d) || EMPTY
      : once('s\u0000' + d + '\u0000' + K.vrf(vrf), () => Object.freeze((subnetsByDev.get(d) || EMPTY).filter((s) => s.vrf === K.vrf(vrf)))));
    const hopI = {
      owner: (ip, vrf) => { const k = ipOwner.get(K.inVrf(ip, vrf)); return k ? { key: k, dev: K.splitEp(k)[0] } : null; },
      owners: (ip) => ownersByIp.get(ip) || EMPTY,
      connected: (d, vrf) => subnetsOf(d, vrf),
    };
    const POLICY_DEFAULT = ['mangle', 'vrf-lookup', 'vrf-unreach', 'local', 'user', 'main'];
    const rv = {
      vrfs,
      vrfsOf: (d) => M.vrfs.get(d) || EMPTY,
      subnetsOf,
      routesOf: (d, vrf) => (vrf === undefined ? routesByDev.get(d) || EMPTY
        : once('r\u0000' + d + '\u0000' + K.vrf(vrf), () => Object.freeze((routesByDev.get(d) || EMPTY).filter((r) => r.vrf === K.vrf(vrf))))),
      routesInTable: (d, table) => once('t\u0000' + d + '\u0000' + table, () => Object.freeze((routesByDev.get(d) || EMPTY).filter((r) => K.vrf(r.routingTable) === table))),
      hopOwner: (d, ip, vrf) => S.check.hopOwner(hopI, d, ip, K.vrf(vrf)),
      // 同 Q.routesIncomplete：路由表的收集失敗（逾時等），查不到符合的路由不代表沒有路由
      routesIncomplete: (d) => { const x = M.devices.get(d); return !!(x && x.incomplete.has('route')); },
      // 同 Q.addrSets：檢查用的登錄表（S.infer.firewall 建立）。policyOf 的 rules 是複本，ofRoutingRule 的 id 為 null，集合相同
      addrSets: () => M.addrSets,
      // 同 Q.policyOf：rules 的 order 與 Snapshot 的 routingRules 相同（每台設備依設定順序從 1 起算）
      policyOf: (d) => once('p\u0000' + d, () => {
        const order = new Map();
        const rules = M.policy.rules.map((r) => { const n = (order.get(r.dev) || 0) + 1; order.set(r.dev, n); return Object.assign({ order: n }, r); }).filter((r) => r.dev === d && !r.disabled);
        const marks = M.policy.marks.filter((x) => x.dev === d && !x.disabled);
        const dev = M.devices.get(d); const set = dev && dev.policyRules ? dev.policyRules.rules : null;
        const custom = !!set && set.join(',') !== POLICY_DEFAULT.join(',');
        // tables：同 Snapshot 的 routingTables（export 的 /routing table，加上每個啟用中的 VRF 的同名表）
        const tables = M.policy.tables.filter((t) => t.dev === d).map((t) => ({ dev: t.dev, name: t.name, fib: t.fib, disabled: t.disabled, source: 'export', vrf: null, src: t.src }))
          .concat((M.vrfs.get(d) || []).filter((v) => !v.disabled && !v.builtin).map((v) => ({ dev: v.dev, name: v.name, fib: true, disabled: false, source: 'vrf', vrf: v.name, src: v.src })))
          .sort((a, b) => U.natural(a.name, b.name) || U.cmp(a.source, b.source));
        return Object.freeze({ tables: Object.freeze(tables), rules: Object.freeze(rules), marks: Object.freeze(marks),
          policyRules: Object.freeze(set ? set.slice() : POLICY_DEFAULT.slice()), custom, any: !!(rules.length || marks.length || custom) });
      }),
      egress: (d, n) => {
        if (n.ifc) return K.ep(d, n.ifc);
        if (!n.ip) return null;
        const v = K.vrf(n.vrf);
        const hit = subnetsOf(d, v).filter((s) => S.ip.inNet(n.ip, s.net, s.len)).map((s) => s.ep).sort(U.natural);
        return hit.length ? hit[0] : null;
      },
    };
    Object.freeze(rv);
    rvMemo.set(M, rv);
    return rv;
  }

  /*
   * 路由網域（推論，M.routingDomains → Snapshot model.routingDomains；ADR-023 決策 2）：每個直連網段（和 prefixes 同一個鍵 K.inVrf(網段, vrf)）恰好屬於一個網域。
   *   ospf：有一台設備的 /routing ospf interface-template（啟用中）比對到這個網段所在的介面——interfaces 列了介面名稱、含它的 interface list 或 all，
   *     或 networks 包含介面上的位址。網域是「OSPF 鄰接相連的設備」×「area」：鄰接（ospfAdjacencies）相連的設備是同一組，組名取設備鍵最小的那台；
   *     area 取 /routing ospf area 的 area-id（沒有時用 area 名稱）。同一個網段比對到多個 area 時取第一個（依組名、area 排序），其餘列在 otherAreas。
   *   static：其他網段，同一個 VRF 中共用這種網段的設備連成一組（直連與靜態路由所在的路由器），組名取設備鍵最小的那台。
   * 網域：{ key, kind, vrf, group（組名的設備）, area, areaId, devices, prefixes（網段鍵）, evidence: [{ dev, kind: 'ospf-template', src }]（static 為空）, otherAreas }。
   */
  function routingDomains(M) {
    const nets = new Map(); // 網段鍵 → { key, vrf, net, len, eps: [{ dev, ep, ip }] }
    M.ifcs.forEach((i) => {
      if (i.hearsay) return;
      i.ips.forEach((_, c) => {
        const p = S.ip.parseCidr(c); if (!p || p.len >= 32) return;
        const vrf = K.vrf(i.vrf); const key = K.inVrf(p.net + '/' + p.len, vrf);
        S.util.getOr(nets, key, () => ({ key, vrf, net: p.net, len: p.len, eps: [] })).eps.push({ dev: i.dev, ep: i.key, name: i.name, ip: p.ip });
      });
    });
    // OSPF 鄰接相連的設備
    const parent = new Map();
    const find = (x) => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r); return r; };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra === rb) return; if (S.util.natural(ra, rb) < 0) parent.set(rb, ra); else parent.set(ra, rb); };
    M.ospfAdjacencies.forEach((a) => { if (a.peerDev) { parent.set(a.dev, find(a.dev)); parent.set(a.peerDev, find(a.peerDev)); union(a.dev, a.peerDev); } });
    const members = new Map(); parent.forEach((_, x) => S.util.getOr(members, find(x), () => []).push(x));
    const groupOf = new Map(); members.forEach((list) => { const g = groupName(M, list); list.forEach((x) => groupOf.set(x, g)); });
    const ospfGroup = (dev) => groupOf.get(dev) || dev;
    const areaId = new Map(); M.routingCfgOut.ospfAreas.forEach((x) => { if (x.name) areaId.set(x.dev + '|' + x.name, x.areaId || x.name); });
    const tplByDev = new Map(); M.routingCfgOut.ospfInterfaceTemplates.forEach((t) => { if (t.disabled !== true && t.area) S.util.getOr(tplByDev, t.dev, () => []).push(t); });
    const tplMatches = (t, e) => {
      const ctx = M.fwCtx.get(e.dev);
      if (t.interfaces.some((n) => n === 'all' || K.ifc(n) === K.ifc(e.name) || (ctx && (ctx.resolve(n) || new Set()).has(e.ep)))) return true;
      return t.networks.some((n) => { const p = S.ip.parseCidr(n); return p && S.ip.inNet(e.ip, p.net, p.len); });
    };
    const domains = new Map();
    const dom = (key, init) => S.util.getOr(domains, key, () => Object.assign({ key, devices: new Set(), prefixes: [], evidence: [], otherAreas: [] }, init));
    const rest = [];
    // 每個網段比對到的 interface-template（只在內部模型，R13–R15 用；不進 Snapshot）：網段鍵 → [{ dev, ep, group, area, areaId, areaIdKnown, src, tpl }]
    M.ospfHits = new Map();
    const areaIdKnown = new Set(); M.routingCfgOut.ospfAreas.forEach((x) => { if (x.name && x.areaId) areaIdKnown.add(x.dev + '|' + x.name); });
    Array.from(nets.values()).sort((a, b) => S.util.natural(a.key, b.key)).forEach((n) => {
      const hits = [];
      n.eps.forEach((e) => (tplByDev.get(e.dev) || []).forEach((t) => {
        if (tplMatches(t, e)) hits.push({ dev: e.dev, ep: e.ep, group: ospfGroup(e.dev), area: t.area, areaId: areaId.get(e.dev + '|' + t.area) || t.area, areaIdKnown: areaIdKnown.has(e.dev + '|' + t.area), src: t.src, tpl: t });
      }));
      if (hits.length) M.ospfHits.set(n.key, hits);
      if (!hits.length) { rest.push(n); return; }
      const keyOf = (h) => K.inVrf(`ospf:${h.group}:${h.areaId}`, n.vrf);
      hits.sort((a, b) => S.util.natural(keyOf(a), keyOf(b)) || S.util.natural(a.dev, b.dev));
      const h = hits[0];
      const d = dom(keyOf(h), { kind: 'ospf', vrf: n.vrf, group: h.group, area: h.area, areaId: h.areaId });
      d.prefixes.push(n.key); n.eps.forEach((e) => d.devices.add(e.dev));
      hits.filter((x) => keyOf(x) === keyOf(h)).forEach((x) => { if (!d.evidence.some((y) => y.dev === x.dev && y.src[0][0] === x.src[0][0] && y.src[0][1] === x.src[0][1])) d.evidence.push({ dev: x.dev, kind: 'ospf-template', src: x.src.map((s) => s.slice()) }); });
      S.util.uniq(hits.map(keyOf)).slice(1).forEach((k) => { if (!d.otherAreas.includes(k)) d.otherAreas.push(k); });
    });
    // static：同一個 VRF 中共用網段的設備連成一組（鍵含 VRF，不同 VRF 不相連）
    const sp = new Map();
    const sfind = (x) => { let r = x; while (sp.has(r) && sp.get(r) !== r) r = sp.get(r); return r; };
    const sunion = (a, b) => { const ra = sfind(a); const rb = sfind(b); if (ra === rb) return; if (S.util.natural(ra, rb) < 0) sp.set(rb, ra); else sp.set(ra, rb); };
    const node = (dev, vrf) => dev + '\u0000' + vrf;
    rest.forEach((n) => { const ds = S.util.uniq(n.eps.map((e) => node(e.dev, n.vrf))); ds.forEach((x) => { if (!sp.has(x)) sp.set(x, x); }); ds.slice(1).forEach((x) => sunion(ds[0], x)); });
    const smembers = new Map(); sp.forEach((_, x) => S.util.getOr(smembers, sfind(x), () => []).push(x.split('\u0000')[0]));
    const sname = new Map(); smembers.forEach((list, root) => sname.set(root, groupName(M, list)));
    rest.forEach((n) => {
      const group = sname.get(sfind(node(n.eps[0].dev, n.vrf)));
      const d = dom(K.inVrf(`static:${group}`, n.vrf), { kind: 'static', vrf: n.vrf, group, area: null, areaId: null });
      d.prefixes.push(n.key); n.eps.forEach((e) => d.devices.add(e.dev));
    });
    M.routingDomains = Array.from(domains.values()).map((d) => Object.assign(d, { devices: Array.from(d.devices).sort(S.util.natural), prefixes: d.prefixes.sort(S.util.natural) }))
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'ospf' ? -1 : 1) || S.util.natural(a.key, b.key));
  }
  /** 組名：已收集的路由器（含防火牆）中設備鍵最小的，沒有時已收集設備中最小的，再沒有時全部中最小的。 */
  function groupName(M, devs) {
    const ds = Array.from(devs).sort(S.util.natural);
    const dev = (k) => M.devices.get(k) || {};
    return ds.find((k) => dev(k).collected && (dev(k).kind === 'router' || dev(k).kind === 'firewall')) || ds.find((k) => dev(k).collected) || ds[0];
  }

  function displayName(d) {
    if (d.names.size) return Array.from(d.names)[0];
    return d.key;
  }

  S.infer = { infer, displayName, effVlans, effVlanModes, effPvid, bridgeOf, vlanSpan, VLAN_DATA, isVirtualIfc, hwMacsByDev, wifiLocations, behindLocations, boundaries, BOUNDARY_LABEL, routingDomains, routingView };
  S.infer.addrSets = addrSets;
  S.infer.ADDR_SET_KINDS = ADDR_SET_KINDS;
  S.infer.addrBounds = addrBounds;
  S.infer.fw = { canonMatch, covers, sameMatch, evalChain, evalFilter, decide, packetFor, wanPacket, wanEntries, entriesIn, fwContext, parseVal, splitNeg, protoName, listMembers, policyBaseline, addressListItem, addressListState,
    ADDRESS_LIST_DYNAMIC: FW_ADDRESS_LIST_DYNAMIC, ADDRESS_LIST_WRITE: FW_ADDRESS_LIST_WRITE,
    TERMINAL: FW_TERMINAL, BUILTIN: FW_BUILTIN, NONDET: FW_NONDET, PORT_PROTOCOLS, POLICY_CHAINS,
    condKind, CONDITIONS: FW_CONDITIONS, IFC_CONDITIONS: FW_IFC_CONDITIONS, ADDRESS_LIST: FW_ADDRESS_LIST, MAX_JUMP: FW_MAX_JUMP, FIRST_PACKET: FW_FIRST_PACKET };
})(globalThis.SSOT = globalThis.SSOT || {});
