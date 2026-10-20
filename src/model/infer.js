/*
 * 推論：在模型上計算衍生屬性。
 *   - 設備類型（依廠牌與資料內容；沒有資料時依對端埠名稱判斷是否為主機）
 *   - 鏈路類別（聚合、管理、速率、L3）
 *   - 鏈路兩端 VLAN（含聚合成員繼承）
 *   - 分群（profile 有 group 用 profile，否則依拓樸鏈路連通元件）
 *   - 套用 profile 註解
 *   - Wi-Fi 客戶端位置（wifiLocations，須在 check.run 之後呼叫）
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
    if (profile) applyProfile(M, profile);
    groups(M);
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
      if (l.layer === 'l3') l.cls = 'l3';
      else if ((ia && (ia.lag || ia.type === 'lag')) || (ib && (ib.lag || ib.type === 'lag'))) l.cls = 'lag';
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
  function linkVlans(M) {
    M.links.forEach((l) => {
      if (l.layer !== 'l2') return;
      if (l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN) {
        l.vlansA = []; l.vlansB = []; l.vlansCommon = []; l.vlanComparable = false;
        return;
      }
      l.vlansA = effVlans(M, l.a); l.vlansB = effVlans(M, l.b);
      const sb = new Set(l.vlansB);
      l.vlansCommon = l.vlansA.filter((v) => sb.has(v));
      const da = M.devices.get(K.splitEp(l.a)[0]); const db = M.devices.get(K.splitEp(l.b)[0]);
      const hasData = (d) => d && VLAN_DATA.some((t) => d.data.has(t));
      l.vlanComparable = hasData(da) && hasData(db) && !l.hearsay;
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
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    M.devices.forEach((d) => parent.set(d.key, d.key));
    M.links.forEach((l) => {
      const a = K.splitEp(l.a)[0]; const b = K.splitEp(l.b)[0];
      if (!parent.has(a) || !parent.has(b)) return;
      parent.set(find(a), find(b));
    });
    const comps = new Map();
    M.devices.forEach((d) => S.util.getOr(comps, find(d.key), () => []).push(d));
    const sorted = Array.from(comps.values()).sort((x, y) => y.length - x.length || S.util.natural(x[0].key, y[0].key));
    sorted.forEach((members, idx) => members.forEach((d) => { d.component = idx + 1; if (!d.group) d.group = '自動群組 ' + (idx + 1); }));
  }

  /**
   * Wi-Fi 客戶端位置（推論）：依證據強度選一個位置，其餘列為候選。
   *   registration：關聯表（最強）。多台 AP 都有時取 last-activity 最小（最近有活動）者，其餘視為可能漫遊
   *   bridge-wifi ：已收集設備的 MAC 表在無線介面學到
   *   via-ap-port ：交換器埠的鄰居是 AP（鄰居回報 wlan-ap 功能，或型號為 cAP／wAP）且 AP 沒有收集資料；無法區分有線或無線
   * 只有出現 Wi-Fi 證據的 MAC 才有 wifi；已判定為有線終端埠的 MAC、AP 自己的 MAC 不套用 via-ap-port。
   * 使用 check.run 算出的 m.edge，所以必須在檢查之後呼叫。
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

  function displayName(d) {
    if (d.names.size) return Array.from(d.names)[0];
    return d.key;
  }

  S.infer = { infer, displayName, effVlans, wifiLocations };
})(globalThis.SSOT = globalThis.SSOT || {});
