/*
 * MikroTik RouterOS adapters（RouterOS 7 為主；6.43+ 的 bridge VLAN filtering 也盡量支援）。
 *
 * 所有 print 指令都要加 detail：`/ip neighbor print detail without-paging`。
 * detail 的 key=value 格式在各版本間最一致，也不受欄寬影響。
 *
 *   mikrotik.neighbor   /ip neighbor print detail          鄰居（LLDP／MNDP／CDP）
 *   mikrotik.config     /export terse（或 compact）          介面、bridge、bridge VLAN、bonding、IP、router-id
 *   mikrotik.bridgehost /interface bridge host print detail  MAC 表
 *   mikrotik.vlans      /interface bridge vlan print detail  bridge VLAN 實際成員（含動態）
 *   mikrotik.interface  /interface print detail             介面狀態（running／停用）
 *   mikrotik.ipaddr     /ip address print detail
 *   mikrotik.arp        /ip arp print detail
 *   mikrotik.route      /ip route print detail
 *   mikrotik.ospf       /routing ospf neighbor print detail
 *   mikrotik.wifireg    /interface wifi｜wireless registration-table、/caps-man registration-table print detail  Wi-Fi 關聯表
 *   mikrotik.system     /system resource print、/system identity print
 */
(function (S) {
  'use strict';
  const U = S.adapters.util;
  const reg = S.adapters.register;
  const at = (b, i) => b.origin.startLine + i;
  const IPRE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
  const VENDOR = 'mikrotik';
  const has = (lines, key) => { const re = new RegExp('(^|\\s)' + key + '='); return lines.some((l) => re.test(l)); };
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

  // ================================================================ detail 輸出解析
  const KVRE = /([\w.\-]+)=("(?:[^"\\]|\\.)*"|\S*)/g;
  function kvOf(text) {
    const kv = {}; let m; KVRE.lastIndex = 0;
    while ((m = KVRE.exec(text))) {
      let v = m[2];
      if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1).replace(/\\(.)/g, '$1');
      kv[m[1]] = v;
    }
    return kv;
  }
  function newRow(toks, line) {
    return { flags: toks.filter((t) => !/^\d+$/.test(t)).join(''), idx: toks.find((t) => /^\d+$/.test(t)) ?? null, kv: {}, comment: null, line };
  }
  /**
   * 把 detail 輸出切成「列」：
   *  - 列首：`序號 旗標 key=value …`（序號、旗標都可能省略）
   *  - 續行：沒有序號與旗標、直接以 key=value 開頭（終端機換行）→ 併入上一列
   *  - `;;; 註解` 屬於它所在或下一個列
   *  - 旗標說明可區分列首旗標與 CAPsMAN 等續行說明
   *  - `Flags:`、`Columns:` 說明行略過
   */
  function parseRows(b) {
    const flagChars = new Set();
    b.lines.forEach((raw) => {
      const legend = raw.match(/^\s*Flags:\s*(.*)$/i);
      if (!legend) return;
      const re = /(?:^|[;,\s])([A-Za-z])\s*-/g; let m;
      while ((m = re.exec(legend[1]))) flagChars.add(m[1]);
    });
    const rows = []; let cur = null; let pending = null;
    b.lines.forEach((raw, i) => {
      const line = raw.replace(/\r$/, ''); const t = line.trim();
      if (!t || /^(Flags|Columns):/i.test(t)) return;
      let comment = null; let body = line;
      const ci = line.indexOf(';;;');
      if (ci >= 0) { comment = line.slice(ci + 3).trim(); body = line.slice(0, ci); }
      const km = /(^|\s)([\w.\-]+)=/.exec(body);
      if (!km) {
        if (ci >= 0) {
          const toks = body.trim().split(/\s+/).filter(Boolean);
          const indexed = /^\d+$/.test(toks[0] || '');
          const flagTokens = indexed ? toks.slice(1) : toks;
          const rowPrefix = indexed || !flagChars.size || (flagTokens.length && flagTokens.every((token) =>
            Array.from(token).every((ch) => flagChars.has(ch))));
          if (toks.length && rowPrefix) { cur = newRow(toks, at(b, i)); cur.comment = comment; rows.push(cur); }
          else if (toks.length && cur) cur.comment = [cur.comment, comment].filter(Boolean).join('; ');
          else pending = comment;
        }
        return;
      }
      const prefix = body.slice(0, km.index + km[1].length).trim();
      const rest = body.slice(km.index + km[1].length);
      if (!prefix && cur) { Object.assign(cur.kv, kvOf(rest)); return; }
      cur = newRow(prefix.split(/\s+/).filter(Boolean), at(b, i));
      cur.comment = comment !== null ? comment : pending; pending = null;
      Object.assign(cur.kv, kvOf(rest)); rows.push(cur);
    });
    return rows;
  }
  S.adapters.mikrotikRows = parseRows; // 測試用

  // ================================================================ 鄰居
  const isBridgeName = (n) => /^bridge/i.test(n);
  // LLDP 的 interface-name 在 bridge 成員上為 "bridge/ether2"：前段是對端 bridge，最後一段才是對端實體埠；原文仍留在來源行
  const peerPort = (v) => { const parts = String(v || '').split('/').map((x) => x.trim()).filter(Boolean); return parts.length ? parts[parts.length - 1] : null; };
  reg({
    id: 'mikrotik.neighbor', vendor: VENDOR, dataType: 'lldp', label: 'RouterOS 鄰居（LLDP／MNDP／CDP）',
    command: /^\/?ip\s+neighbou?r\b/i,
    detect: (lines) => has(lines, 'identity') && has(lines, 'mac-address') && has(lines, 'interface'),
    parse(b, emit) {
      const rows = [];
      parseRows(b).forEach((r) => {
        const kv = r.kv;
        const locals = list(String(kv.interface || '').replace(/\//g, ','));
        if (!locals.length) return;
        const peer = kv.identity || kv['mac-address'] || kv.address4 || kv.address;
        if (!peer) return;
        const addr = [kv.address4, kv.address].find((a) => a && IPRE.test(a)) || null;
        rows.push({
          local: locals.find((x) => !isBridgeName(x)) || locals[0], viaBridge: locals.every(isBridgeName),
          peer, ident: kv.identity || null, discoveredBy: kv['discovered-by'] || '', peerIfc: peerPort(kv['interface-name']), mac: kv['mac-address'] || null, addr,
          board: kv.board || null, platform: kv.platform || null, version: kv.version || null, caps: kv['system-caps-enabled'] || kv['system-caps'] || null, line: r.line,
        });
      });
      // 同一台鄰居可能被多個協定（LLDP／MNDP／CDP）、或同時從連接埠與 bridge 看到：
      // 同一個本機介面上，MAC 或 identity 相同的列視為同一個遠端，合併協定與非空欄位；連接埠優先於 bridge
      const norm = (v) => (v ? String(v).toLowerCase() : null);
      const same = (x, y) => (x.macK && x.macK === y.macK) || (x.idK && x.idK === y.idK);
      rows.forEach((r) => {
        r.macK = norm(r.mac); r.idK = norm(r.ident);
        r.protos = list(String(r.discoveredBy || '').toLowerCase());
      });
      const physical = rows.filter((r) => !r.viaBridge);
      const groups = [];
      physical.concat(rows.filter((r) => r.viaBridge && !physical.some((p) => same(p, r)))).forEach((r) => {
        const g = groups.find((x) => x.local === r.local && x.rows.some((y) => same(y, r)));
        if (g) g.rows.push(r); else groups.push({ local: r.local, rows: [r] });
      });
      groups.forEach((g) => {
        const first = (f, rs) => { const r = rs.find((x) => x[f]); return r ? r[f] : null; };
        const lldp = g.rows.filter((r) => r.protos.includes('lldp'));
        const prefer = lldp.concat(g.rows.filter((r) => !lldp.includes(r)));
        const peerIfcs = Array.from(new Set(g.rows.map((r) => r.peerIfc).filter(Boolean)));
        const protocols = Array.from(new Set([].concat(...g.rows.map((r) => r.protos)))).sort();
        emit({
          t: 'lldp', ifc: g.local, peer: first('ident', g.rows) || first('mac', g.rows) || first('addr', g.rows),
          peerIfc: first('peerIfc', prefer), peerIfcAlt: peerIfcs.length > 1 ? peerIfcs : null, protocols,
          chassis: first('mac', prefer), peerAddr: first('addr', g.rows), board: first('board', g.rows),
          platform: first('platform', g.rows), version: first('version', g.rows), caps: first('caps', g.rows), line: g.rows[0].line,
        });
      });
    },
  });

  // ================================================================ 設定（/export）
  reg({
    id: 'mikrotik.config', vendor: VENDOR, dataType: 'config', label: 'RouterOS 設定（export）',
    command: /^\/?export\b/i,
    detect: (lines) => lines.some((l) => /^\s*(\/[\w\- ]+?\s+)?add\s+[\w\-]+=/.test(l)) && lines.some((l) => /^\s*\/(interface|ip|system|routing)\b/.test(l)),
    parse(b, emit) {
      // 還原斷行：行尾 \ 接到下一行（續行的前導空白去掉）
      const lines = []; let acc = null;
      b.lines.forEach((raw, i) => {
        const l = raw.replace(/\r$/, '');
        if (acc) acc.text += l.trim(); else acc = { text: l.trim(), line: at(b, i) };
        if (acc.text.endsWith('\\')) { acc.text = acc.text.slice(0, -1); return; }
        lines.push(acc); acc = null;
      });
      if (acc) lines.push(acc);

      let ctx = '';
      const bridges = new Map(); const ports = []; const bvlans = []; const ridNames = new Map(); let ospfRid = null; let ospfLine = 0;
      const handle = (path, cmd, argText, line) => {
        let sel = null; let args = argText;
        const sm = args.match(/^\[\s*find\s*([^\]]*)\]\s*(.*)$/);
        if (sm) { sel = kvOf(sm[1].replace(/^where\s+/, '')); args = sm[2]; }
        const kv = kvOf(args);
        switch (path) {
          case '/system identity':
            if (kv.name) emit({ t: 'hostname', name: kv.name, line });
            break;
          case '/interface ethernet': {
            if (cmd !== 'set' || !sel) break;
            const name = kv.name || sel['default-name'] || sel.name; if (!name) break;
            const f = { t: 'ifc', ifc: name, line };
            if (kv.comment) f.desc = kv.comment;
            if (kv.disabled === 'yes') f.enabled = false;
            emit(f); break;
          }
          case '/interface bridge': {
            const name = kv.name || (sel && sel.name); if (!name) break;
            const br = bridges.get(name) || { filtering: false }; bridges.set(name, br);
            if (kv['vlan-filtering']) br.filtering = kv['vlan-filtering'] === 'yes';
            const f = { t: 'ifc', ifc: name, rawType: 'bridge', line }; if (kv.comment) f.desc = kv.comment; emit(f); break;
          }
          case '/interface bridge port':
            if (cmd === 'add' && kv.interface) {
              ports.push({ bridge: kv.bridge, ifc: kv.interface, pvid: kv.pvid || '1', line });
              const f = { t: 'ifc', ifc: kv.interface, line }; if (kv.bridge) f.bridge = kv.bridge; if (kv.comment) f.desc = kv.comment; emit(f);
            }
            break;
          case '/interface bridge vlan':
            if (cmd === 'add') bvlans.push({ bridge: kv.bridge, ids: S.util.vlanTokens(kv['vlan-ids'] || ''), tagged: list(kv.tagged), untagged: list(kv.untagged), comment: kv.comment || null, line });
            break;
          case '/interface vlan':
            if (cmd === 'add' && kv.name && kv['vlan-id']) {
              const f = { t: 'ifc', ifc: kv.name, rawType: 'vlan', parent: kv.interface, encapVlan: +kv['vlan-id'], line }; if (kv.comment) f.desc = kv.comment; emit(f);
              emit({ t: 'vlan', id: +kv['vlan-id'], name: null, line });
              emit({ t: 'vmem', vlan: String(kv['vlan-id']), ifc: kv.interface, tagged: true, src: 'config', line });
            }
            break;
          case '/interface bonding':
            if (cmd === 'add' && kv.name) {
              const f = { t: 'ifc', ifc: kv.name, rawType: 'bond', line }; if (kv.comment) f.desc = kv.comment; emit(f);
              list(kv.slaves).forEach((s) => emit({ t: 'ifc', ifc: s, lag: kv.name, line }));
            }
            break;
          case '/ip address':
            if (cmd === 'add' && kv.address && kv.interface && kv.disabled !== 'yes') emit({ t: 'ifc', ifc: kv.interface, ip: kv.address, line });
            break;
          case '/routing id':
            if (cmd === 'add' && kv.name && kv.id) ridNames.set(kv.name, kv.id);
            break;
          case '/routing ospf instance':
            if (kv['router-id']) { ospfRid = kv['router-id']; ospfLine = line; }
            break;
          default: break;
        }
      };
      lines.forEach(({ text, line }) => {
        if (!text || text.startsWith('#')) return;
        if (text[0] === '/') {
          const m = text.match(/^(\/[\w\-]+(?:\s+[\w\-]+)*?)(?:\s+(add|set)\b\s*(.*))?$/);
          if (!m) return;
          const path = m[1].replace(/\s+/g, ' ');
          if (m[2]) handle(path, m[2], m[3] || '', line); else ctx = path;
          return;
        }
        const m = text.match(/^(add|set)\b\s*(.*)$/);
        if (m) handle(ctx, m[1], m[2], line);
      });

      // bridge VLAN filtering：只有開啟時，VLAN 成員才有意義
      const filtering = (name) => !!(bridges.get(name) && bridges.get(name).filtering);
      bvlans.forEach((v) => {
        if (!filtering(v.bridge)) return;
        v.ids.forEach((id) => {
          emit({ t: 'vlan', id: +id, name: null, desc: v.comment || undefined, line: v.line });
          v.tagged.forEach((ifc) => emit({ t: 'vmem', vlan: String(id), ifc, tagged: true, src: 'config', line: v.line }));
          v.untagged.forEach((ifc) => emit({ t: 'vmem', vlan: String(id), ifc, src: 'config', line: v.line }));
        });
      });
      ports.forEach((p) => { if (filtering(p.bridge)) emit({ t: 'vmem', vlan: String(p.pvid), ifc: p.ifc, pvid: true, src: 'config', line: p.line }); });
      const rid = IPRE.test(ospfRid || '') ? ospfRid : ridNames.get(ospfRid);
      if (rid && IPRE.test(rid)) emit({ t: 'rid', id: rid, line: ospfLine });
    },
  });

  // ================================================================ MAC 表
  reg({
    id: 'mikrotik.bridgehost', vendor: VENDOR, dataType: 'mac', label: 'RouterOS Bridge Host（MAC 表）',
    command: /^\/?interface\s+bridge\s+host\b/i,
    detect: (lines) => has(lines, 'mac-address') && has(lines, 'on-interface'),
    parse(b, emit) {
      parseRows(b).forEach((r) => {
        const kv = r.kv;
        if (!kv['mac-address'] || !kv['on-interface'] || r.flags.includes('L')) return; // L：bridge 自己的 MAC
        emit({ t: 'mac', vlan: kv.vid && kv.vid !== '0' ? kv.vid : null, mac: kv['mac-address'], ifc: kv['on-interface'], line: r.line });
      });
    },
  });

  // ================================================================ Bridge VLAN 實際成員
  reg({
    id: 'mikrotik.vlans', vendor: VENDOR, dataType: 'vlans', label: 'RouterOS Bridge VLAN',
    command: /^\/?interface\s+bridge\s+vlan\b/i,
    detect: (lines) => has(lines, 'vlan-ids') && has(lines, 'bridge') && (has(lines, 'tagged') || has(lines, 'untagged') || has(lines, 'current-tagged')),
    parse(b, emit) {
      parseRows(b).forEach((r) => {
        const kv = r.kv; const ids = S.util.vlanTokens(kv['vlan-ids'] || ''); if (!ids.length) return;
        const tagged = 'current-tagged' in kv ? list(kv['current-tagged']) : list(kv.tagged);
        const untagged = 'current-untagged' in kv ? list(kv['current-untagged']) : list(kv.untagged);
        ids.forEach((id) => {
          emit({ t: 'vlan', id: +id, name: null, desc: r.comment || undefined, line: r.line });
          tagged.forEach((ifc) => emit({ t: 'vmem', vlan: String(id), ifc, tagged: true, active: true, src: 'state', line: r.line }));
          untagged.forEach((ifc) => emit({ t: 'vmem', vlan: String(id), ifc, active: true, src: 'state', line: r.line }));
        });
      });
    },
  });

  // ================================================================ 介面狀態
  reg({
    id: 'mikrotik.interface', vendor: VENDOR, dataType: 'ifstatus', label: 'RouterOS 介面狀態',
    command: /^\/?interface\s+print\b/i,
    detect: (lines) => has(lines, 'name') && has(lines, 'type') && has(lines, 'mtu'),
    parse(b, emit) {
      parseRows(b).forEach((r) => {
        const kv = r.kv; if (!kv.name) return;
        const f = { t: 'ifc', ifc: kv.name, status: r.flags.includes('R') ? 'up' : 'down', line: r.line };
        f.enabled = !r.flags.includes('X');
        const desc = kv.comment || r.comment; if (desc) f.desc = desc;
        if (kv.type) f.rawType = kv.type.toLowerCase();
        if (kv['mac-address']) f.hwMac = kv['mac-address'];
        if (kv['default-name']) f.defaultName = kv['default-name'];
        ['mtu', 'actual-mtu', 'l2mtu'].forEach((k) => { if (/^\d+$/.test(kv[k] || '')) f[k.replace(/-(\w)/, (_, c) => c.toUpperCase())] = +kv[k]; });
        emit(f);
      });
    },
  });

  // ================================================================ IP 位址
  reg({
    id: 'mikrotik.ipaddr', vendor: VENDOR, dataType: 'ipaddr', label: 'RouterOS IP 位址',
    command: /^\/?ip\s+address\b/i,
    detect: (lines) => lines.some((l) => /(^|\s)address=\d+\.\d+\.\d+\.\d+\/\d+/.test(l)) && has(lines, 'network') && has(lines, 'interface'),
    parse(b, emit) {
      parseRows(b).forEach((r) => {
        const kv = r.kv;
        if (!kv.address || !kv.interface || /[XI]/.test(r.flags) || !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(kv.address)) return;
        emit({ t: 'ifc', ifc: kv['actual-interface'] || kv.interface, ip: kv.address, line: r.line });
      });
    },
  });

  // ================================================================ ARP
  reg({
    id: 'mikrotik.arp', vendor: VENDOR, dataType: 'arp', label: 'RouterOS ARP 表',
    command: /^\/?ip\s+arp\b/i,
    detect: (lines) => has(lines, 'mac-address') && has(lines, 'complete') && has(lines, 'interface'),
    parse(b, emit) {
      parseRows(b).forEach((r) => {
        const kv = r.kv;
        if (!kv.address || !kv['mac-address'] || !IPRE.test(kv.address) || /[XI]/.test(r.flags)) return;
        if (kv.address.startsWith('169.254.') || /^(22[4-9]|23\d)\./.test(kv.address)) return;
        emit({ t: 'arp', ifc: kv.interface, ip: kv.address, mac: kv['mac-address'], line: r.line });
      });
    },
  });

  // ================================================================ 路由
  reg({
    id: 'mikrotik.route', vendor: VENDOR, dataType: 'route', label: 'RouterOS 路由表',
    command: /^\/?ip\s+route\b/i,
    detect: (lines) => has(lines, 'dst-address') && (has(lines, 'gateway') || has(lines, 'immediate-gw')),
    parse(b, emit) {
      parseRows(b).forEach((r) => {
        const kv = r.kv; const m = String(kv['dst-address'] || '').match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
        if (!m || !r.flags.includes('A') || /[BUP]/.test(r.flags)) return;      // 只要作用中；排除黑洞、不可達
        if (kv['routing-table'] && kv['routing-table'] !== 'main') return;
        const f = r.flags;
        const proto = /[cC]/.test(f) ? 'Direct' : f.includes('o') ? 'OSPF' : f.includes('b') ? 'BGP' : /[sS]/.test(f) ? 'Static' : f.includes('d') ? 'DHCP' : f.includes('r') ? 'RIP' : f.includes('v') ? 'VPN' : 'Other';
        const gws = list(kv.gateway); const igws = list(kv['immediate-gw']); const nh = [];
        gws.forEach((g, idx) => {
          const [gip, gif] = g.split('%');
          if (IPRE.test(gip)) {
            let ifc = gif || null;
            if (!ifc) { const ig = igws[idx] || igws[0]; if (ig && ig.includes('%')) ifc = ig.split('%')[1]; }
            nh.push({ ip: gip, ifc });
          } else if (gip && !/^(blackhole|unreachable|prohibit)$/i.test(gip)) nh.push({ ip: null, ifc: gip });
        });
        if (!nh.length) return;
        emit({ t: 'route', prefix: m[1], len: +m[2], proto, nh, line: r.line });
      });
    },
  });

  // ================================================================ OSPF 鄰居
  reg({
    id: 'mikrotik.ospf', vendor: VENDOR, dataType: 'ospf', label: 'RouterOS OSPF 鄰居',
    command: /^\/?routing\s+ospf\s+neighbou?r\b/i,
    detect: (lines) => has(lines, 'router-id') && has(lines, 'state') && lines.some((l) => /(^|\s)address=\d/.test(l)),
    parse(b, emit) {
      parseRows(b).forEach((r) => {
        const kv = r.kv;
        if (!IPRE.test(kv.address || '') || !IPRE.test(kv['router-id'] || '')) return;
        emit({ t: 'ospf', nbrAddr: kv.address, nbrId: kv['router-id'], state: kv.state || '', ifc: kv.interface || null, line: r.line });
      });
    },
  });

  // ================================================================ Wi-Fi 關聯表（客戶端關聯在哪個無線介面）
  /** RouterOS 時間長度（1w2d3h4m5s120ms，或舊格式 01:02:03）→ 秒；格式不符回傳 null。 */
  function duration(text) {
    const t = String(text || '').trim(); if (!t) return null;
    const hms = t.match(/^(?:(\d+)d\s*)?(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    if (hms) return (+hms[1] || 0) * 86400 + hms[2] * 3600 + hms[3] * 60 + +hms[4];
    const UNIT = { w: 604800, d: 86400, h: 3600, m: 60, s: 1, ms: 0.001, us: 1e-6 };
    let sec = 0; let rest = t; let m;
    const re = /^(\d+(?:\.\d+)?)(ms|us|w|d|h|m|s)/;
    while (rest && (m = re.exec(rest))) { sec += m[1] * UNIT[m[2]]; rest = rest.slice(m[0].length); }
    return rest ? null : sec;
  }
  S.adapters.mikrotikDuration = duration; // 測試用
  const dbm = (v) => { const m = String(v || '').match(/^(-?\d+)/); return m ? +m[1] : null; };
  // RouterOS 對不存在的選單或語法錯誤的回應：不是空的關聯表，交由 I01 呈現
  const ROS_ERROR = /^\s*(bad command name|syntax error|expected end of command|no such (item|command))/i;
  reg({
    id: 'mikrotik.wifireg', vendor: VENDOR, dataType: 'wifireg', label: 'RouterOS Wi-Fi 關聯表',
    command: /^\/?(interface\s+(wifi|wireless)\s+registration-table|caps-man\s+registration-table)\b/i,
    detect: (lines) => has(lines, 'mac-address') && has(lines, 'interface') && has(lines, 'uptime') && (has(lines, 'last-activity') || has(lines, 'rx-signal')),
    parse(b, emit) {
      // eap-identity、eap-username 是使用者帳號（個資），刻意不讀取；原文仍在收集檔，見 docs/collection.md
      let rows = 0;
      parseRows(b).forEach((r) => {
        const kv = r.kv;
        if (!kv['mac-address'] || !kv.interface) return;
        if (kv.ap === 'yes' || kv.ap === 'true') return; // 舊版 wireless：對端是 AP（WDS／站台模式），不是客戶端
        rows++;
        emit({
          t: 'assoc', ifc: kv.interface, mac: kv['mac-address'], ssid: kv.ssid || null, band: kv.band || null,
          vlan: /^\d+$/.test(kv['vlan-id'] || '') ? +kv['vlan-id'] : null,
          uptime: duration(kv.uptime), lastActivity: duration(kv['last-activity']),
          signal: dbm(kv.signal ?? kv['signal-strength'] ?? kv['rx-signal']),
          ip: [kv['dhcp-address'], kv['last-ip']].find((x) => x && IPRE.test(x)) || null, hostname: kv['dhcp-hostname'] || null,
          line: r.line,
        });
      });
      // 沒有客戶端時表格只有說明行：記為「已收集、0 筆」，避免被當成無法辨識
      if (!rows && !b.lines.some((l) => ROS_ERROR.test(l))) emit({ t: 'assocTable', rows: 0, line: b.origin.startLine });
    },
  });

  // ================================================================ 系統資訊
  reg({
    id: 'mikrotik.system', vendor: VENDOR, dataType: 'system', label: 'RouterOS 系統資訊',
    command: /^\/?system\s+(resource|identity)\b/i,
    detect: (lines) => lines.some((l) => /^\s*board-name:/.test(l)),
    parse(b, emit) {
      const identity = /identity/i.test(b.command || '');
      b.lines.forEach((l, i) => {
        let m;
        if ((m = l.match(/^\s*board-name:\s*(.+?)\s*$/))) emit({ t: 'sys', board: m[1], line: at(b, i) });
        else if ((m = l.match(/^\s*version:\s*(.+?)\s*$/))) emit({ t: 'sys', version: m[1], line: at(b, i) });
        else if (identity && (m = l.match(/^\s*name:\s*(.+?)\s*$/))) emit({ t: 'hostname', name: m[1], line: at(b, i) });
      });
    },
  });
})(globalThis.SSOT = globalThis.SSOT || {});
