/*
 * 唯讀查詢介面：畫面與比對模組只能透過這裡讀 Snapshot，不直接碰內部陣列。
 * const Q = SSOT.query(snapshot);
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const U = S.util;

  S.query = function (snap) {
    const m = snap.model;
    const dev = new Map(m.devices.map((d) => [d.key, d]));
    const ifc = new Map(m.interfaces.map((i) => [i.key, i]));
    const link = new Map(m.links.map((l) => [l.key, l]));
    const mac = new Map(m.macs.map((x) => [x.mac, x]));
    const ifcsByDev = new Map(); const linksByDev = new Map(); const linksByEp = new Map();
    const ospfByDev = new Map();
    m.interfaces.forEach((i) => U.getOr(ifcsByDev, i.dev, () => []).push(i));
    m.links.forEach((l) => {
      [l.a, l.b].forEach((ep) => {
        U.getOr(linksByEp, ep, () => []).push(l);
        const d = K.splitEp(ep)[0];
        const arr = U.getOr(linksByDev, d, () => []); if (!arr.includes(l)) arr.push(l);
      });
    });
    (m.ospfAdjacencies || []).forEach((a) => U.getOr(ospfByDev, a.dev, () => []).push(a));
    const ipOwner = new Map(); const subnets = [];
    m.interfaces.forEach((i) => i.ips.forEach((c) => {
      const p = S.ip.parseCidr(c); if (!p) return;
      if (!i.hearsay) ipOwner.set(p.ip, i.key);
      if (!i.hearsay && p.len < 32) subnets.push({ ep: i.key, dev: i.dev, net: p.net, len: p.len, ip: p.ip });
    }));
    m.devices.forEach((d) => { if (d.mgmtIp && !ipOwner.has(d.mgmtIp)) ipOwner.set(d.mgmtIp, d.key + '|'); });
    const arpsByIp = new Map(); m.arps.forEach((a) => U.getOr(arpsByIp, a.ip, () => []).push(a));
    const vlansById = new Map(); const vlansByDev = new Map();
    m.vlans.forEach((v) => { if (v.id != null) U.getOr(vlansById, v.id, () => []).push(v); U.getOr(vlansByDev, v.dev, () => []).push(v); });
    const routesByDev = new Map(); m.routes.forEach((r) => U.getOr(routesByDev, r.dev, () => []).push(r));
    let inv = null;
    const unkByDev = new Map();
    m.interfaces.forEach((i) => { if (i.unknownPeer) U.getOr(unkByDev, i.dev, () => []).push(i); });
    const findingsBy = new Map();
    snap.findings.forEach((f, idx) => f.entities.forEach((e) => U.getOr(findingsBy, e.type + ':' + e.key, () => []).push(idx)));
    // 介面也會繼承其連結、設備的檢查結果：在查詢時合併
    const Q = {
      snapshot: snap,
      devices: () => m.devices,
      links: () => m.links,
      getDevice: (k) => dev.get(K.dev(k)) || dev.get(k) || null,
      getInterface: (ep) => ifc.get(ep) || null,
      getLink: (k) => link.get(k) || null,
      interfacesOf: (d) => ifcsByDev.get(d) || [],
      linksOf: (d) => linksByDev.get(d) || [],
      linksOfEp: (ep) => linksByEp.get(ep) || [],
      ospfAdjacenciesOf: (d) => ospfByDev.get(d) || [],
      linkBetween(epA, epB) { return link.get(K.link(epA, epB)) || null; },
      peerOf(l, ep) { return l.a === ep ? l.b : l.a; },
      vlansOf: (d) => vlansByDev.get(d) || [],
      routesOf: (d) => routesByDev.get(d) || [],
      ipOwner: (ip) => ipOwner.get(ip) || null,
      subnets: () => subnets,
      devName(k) { const d = dev.get(k); return d ? (d.label || d.name) : k; },
      // 清單與總覽的唯一數字來源：列資料與計數一起算，畫面不得自行重算
      inventory() {
        if (inv) return inv;
        const macs = Q.macEntries(); const ips = Q.ipEntries(); const endpoints = Q.endpointEntries();
        const macSet = (f) => new Set(macs.filter(f).map((r) => r.mac)).size;
        inv = {
          rows: { devices: m.devices, endpoints, interfaces: m.interfaces, ips, macs, vlans: m.vlans },
          counts: {
            devices: m.devices.length, collected: m.devices.filter((d) => d.collected).length, hosts: m.devices.filter((d) => d.kind === 'host').length,
            endpoints: endpoints.length, endpointPorts: new Set(endpoints.map((e) => e.key)).size, interfaces: m.interfaces.length,
            ips: ips.length, arpIps: ips.filter((r) => r.from.includes('ARP')).length, ownIps: ips.filter((r) => r.from.includes('介面') || r.from.includes('管理')).length,
            heardIps: ips.filter((r) => r.from.includes('鄰居宣告')).length,
            macs: macSet(() => true), macRows: macs.length, noIpMacs: macSet((r) => r.noIp), vlans: m.vlans.length, vlanIds: new Set(m.vlans.map((v) => v.id)).size,
          },
        };
        return inv;
      },
      // 每個 (MAC, 觀察到的介面) 一列；沒有任何介面觀察的 MAC（只出現在 ARP）設備與介面為 null
      macEntries() {
        const rows = [];
        m.macs.forEach((x) => {
          const base = { mac: x.mac, vendor: x.vendor, ips: x.ips, noIp: !x.ips.length };
          if (!x.seen.length) rows.push(Object.assign({ ep: null, dev: null, ifc: null, vlan: null }, base));
          x.seen.forEach(({ ep, vlan }) => { const [d, i] = K.splitEp(ep); const f = ifc.get(ep); rows.push(Object.assign({ ep, dev: d, ifc: f ? f.name : i, vlan }, base)); });
        });
        return rows;
      },
      // 每個不重複的 IP 一列：介面位址、設備管理 IP 與 ARP 出現的 IP 合併，來源保留在 from
      ipEntries() {
        const all = new Set(ipOwner.keys()); arpsByIp.forEach((_, ip) => all.add(ip));
        const heard = new Map(); // 鄰居宣告（hearsay）的介面位址：事實但非設備自有，單獨標示來源
        m.interfaces.forEach((i) => { if (i.hearsay) i.ips.forEach((c) => { const p = S.ip.parseCidr(c); if (p) { all.add(p.ip); U.getOr(heard, p.ip, () => []).push(i.key); } }); });
        return Array.from(all).sort(U.natural).map((ip) => {
          const owner = ipOwner.get(ip) || null; const macs = U.uniq((arpsByIp.get(ip) || []).map((a) => a.mac));
          const from = [owner ? (owner.endsWith('|') ? '管理' : '介面') : null, macs.length ? 'ARP' : null, !owner && heard.has(ip) ? '鄰居宣告' : null].filter(Boolean);
          const ownerDev = owner ? K.splitEp(owner)[0] : null;
          return { ip, owner, dev: ownerDev, ifc: owner && !owner.endsWith('|') ? Q.epName(owner).slice(Q.devName(ownerDev).length + 1) : null, macs, from };
        });
      },
      epName(ep) { const [d, i] = K.splitEp(ep); const x = ifc.get(ep); return Q.devName(d) + ' ' + (x ? x.name : i); },
      findingsFor(type, key) { return (findingsBy.get(type + ':' + key) || []).map((i) => snap.findings[i]); },
      findingIndexesFor(type, key) { return findingsBy.get(type + ':' + key) || []; },
      block: (id) => snap.blocks[id] || null,
      /** 有學到 MAC、但沒有 LLDP／CDP 介面鄰接的末端埠所屬設備（MNDP 網域可達不算直連鄰接） */
      // 末端：沒有 LLDP／CDP 介面鄰接的埠後面看到的每個 MAC 一列（一個埠後有多個 MAC 就有多列）；沒有 MAC 的埠仍保留一列
      endpointEntries() {
        return Q.unknownDevices().flatMap((d) => Q.unknownPeers(d).flatMap((u) => {
          const base = { end: true, key: u.ep, dev: d, ifc: u.name, desc: u.desc, type: u.type, status: u.status, vlans: u.vlans, portMacs: u.macs.length };
          return (u.macs.length ? u.macs : [null]).map((x) => Object.assign({ mac: x ? x.mac : null, ips: x ? x.ips : [], vendors: x && x.vendor ? [x.vendor] : [] }, base));
        }));
      },
      unknownDevices: () => Array.from(unkByDev.keys()).sort(U.natural),
      /** 某設備上「沒有 LLDP／CDP 介面鄰接」的末端埠，附 MAC、IP、廠商 */
      unknownPeers(devKey) {
        return (unkByDev.get(devKey) || []).slice().sort((a, b) => U.natural(a.name, b.name)).map((i) => ({
          ep: i.key, name: i.name, desc: i.desc, status: i.status, type: i.type, vlans: i.vlans,
          macs: i.macs.map((mk) => { const x = mac.get(mk); return { mac: mk, vendor: x ? x.vendor : null, ips: x ? x.ips : [] }; }),
        }));
      },

      findMac(text) {
        const k = K.mac(text); if (!k) return null;
        const x = mac.get(k);
        return x ? Object.assign({ found: true }, x) : { found: false, mac: k, vendor: S.oui ? S.oui.lookup(k) : null, ips: [], seen: [], edge: [] };
      },
      findIp(ip) {
        if (!S.ip.isIp(ip)) return null;
        const arps = arpsByIp.get(ip) || [];
        const macs = U.uniq(arps.map((a) => a.mac));
        const nets = subnets.filter((s) => S.ip.inNet(ip, s.net, s.len)).sort((a, b) => b.len - a.len);
        const locations = [];
        macs.forEach((mk) => { const x = mac.get(mk); if (x) x.edge.forEach((ep) => locations.push({ mac: mk, ep })); });
        return { ip, owner: ipOwner.get(ip) || null, arps, macs, subnets: nets, locations };
      },
      vlan(id) {
        id = +id;
        const entries = vlansById.get(id) || [];
        const carry = []; const partial = [];
        m.links.forEach((l) => {
          if (l.layer !== 'l2') return;
          const inA = l.vlansA.includes(id); const inB = l.vlansB.includes(id);
          if (inA && inB) carry.push(l); else if ((inA || inB) && l.vlanComparable !== false && l.vlanMismatch) partial.push(l);
        });
        const devs = U.uniq(entries.map((v) => v.dev));
        m.interfaces.forEach((i) => { if (i.vlans.includes(id) && !devs.includes(i.dev)) devs.push(i.dev); });
        return { id, entries, devices: devs.sort(U.natural), carry, partial, names: U.uniq(entries.map((e) => e.name).filter(Boolean)) };
      },

      /** 一個搜尋框搜所有東西：MAC、IP、VLAN、設備、介面描述。 */
      search(text, limit) {
        const q = String(text || '').trim(); const max = limit || 20; const out = [];
        if (!q) return out;
        if (K.isMacText(q)) { const r = Q.findMac(q); out.push({ type: 'mac', key: r.mac, label: K.macPretty(r.mac), sub: r.found ? (r.vendor || '') + (r.ips.length ? ' · ' + r.ips.join(', ') : '') : '基準中沒有這個 MAC' }); }
        if (S.ip.isIp(q)) { const r = Q.findIp(q); out.push({ type: 'ip', key: q, label: q, sub: r.owner ? '介面位址 · ' + Q.epName(r.owner.endsWith('|') ? r.owner + 'mgmt' : r.owner) : r.macs.length ? 'ARP：' + r.macs.map(K.macPretty).join(', ') : r.subnets.length ? '屬於 ' + Q.epName(r.subnets[0].ep) + ' 的網段' : '基準中沒有這個 IP' }); }
        if (/^\d{1,4}$/.test(q) && +q >= 1 && +q <= 4094) { const v = Q.vlan(+q); out.push({ type: 'vlan', key: q, label: 'VLAN ' + q, sub: v.devices.length ? `${v.devices.length} 台設備 · ${v.names.join(' / ')}` : '基準中沒有這個 VLAN' }); }
        const uq = q.toUpperCase();
        for (const d of m.devices) {
          if (out.length >= max) break;
          if (d.key.includes(uq) || (d.label && d.label.toUpperCase().includes(uq)) || (d.mgmtIp && d.mgmtIp === q)) out.push({ type: 'device', key: d.key, label: d.label || d.name, sub: [d.kind, d.mgmtIp, d.collected ? '' : '未收集'].filter(Boolean).join(' · ') });
        }
        if (out.length < max && q.length >= 3) {
          const lq = q.toLowerCase();
          for (const i of m.interfaces) {
            if (out.length >= max) break;
            if (i.desc && i.desc.toLowerCase().includes(lq)) out.push({ type: 'interface', key: i.key, label: Q.epName(i.key), sub: '描述：' + i.desc });
          }
        }
        return out;
      },
    };
    return Q;
  };
})(globalThis.SSOT = globalThis.SSOT || {});
