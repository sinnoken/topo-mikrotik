/*
 * 產生測試用的 MikroTik RouterOS 收集檔（bundle-v1 格式，RouterOS 7 輸出樣式）。
 *   node tools/gen-bundle.js --sites 1 --access 12 --faults > samples/sample-bundle.txt
 *   node tools/gen-bundle.js --sites 40 --access 22 > /tmp/large.txt     （約 1000 台）
 * 每個站點：2 台核心路由器（CCR）、N 台接取交換器（CRS326）；多站點時另有 1 台 WAN 路由器（OSPF）。
 * 格式變化（用來測試解析器）：核心 01 用 compact export（含 \ 斷行），其他用 terse；
 *   鄰居列在 80 欄換行；部分鄰居同時從連接埠與 bridge 看到；核心 02 的 OSPF 鄰居列有 interface、核心 01 沒有；
 *   核心 01 用 RouterOS 7 的 /routing id，核心 02 用 6 的寫法；WAN 有 ECMP（gateway=a,b）。
 * --faults 會在第一個站點放入已知問題，用來驗證每一項檢查。
 * 注意：輸出格式依 RouterOS 7 文件與慣例撰寫，不是從真實設備擷取。
 */
'use strict';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const SITES = +opt('sites', 1); const ACC = +opt('access', 12); const SRV = +opt('servers', 3); const USERS = +opt('users', 8);
const FAULTS = !!opt('faults', false); const UPLINK_MACS = +opt('uplink-macs', 30);
let seed = +opt('seed', 7);
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pad = (n, w = 2) => String(n).padStart(w, '0');
const CODES = ['TPE', 'TCH', 'KHH', 'HSC', 'TNN', 'ILN', 'HLN', 'TTT', 'CYI', 'PIF'];
const siteCode = (s) => (s <= CODES.length ? CODES[s - 1] : 'S' + pad(s));
const OUI_SRV = ['24:6E:96', '1C:98:EC', 'AC:1F:6B']; const OUI_PC = ['6C:FE:54', '04:42:1A', '10:BF:48']; const OUI_MT = ['D4:01:C3', 'E4:8D:8C', '48:A9:8A'];
let macSeq = 1;
const hex2 = (n) => n.toString(16).padStart(2, '0').toUpperCase();
const mac = (oui) => { const n = macSeq++; return `${oui}:${hex2((n >> 16) & 255)}:${hex2((n >> 8) & 255)}:${hex2(n & 255)}`; };

// ---------------------------------------------------------------- RouterOS 輸出格式
const needQ = (v) => /[\s()]/.test(v);
/** key=value 列，超過 width 在 key=value 之間換行（續行縮排 4 格），不會切到引號內 */
function detailRow(prefix, kvs, width = 80) {
  // v === true：RouterOS 7 的單獨旗標字（例如路由的 blackhole），不是 key=value
  const toks = kvs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => (v === true ? k : `${k}=${needQ(String(v)) ? '"' + v + '"' : v}`));
  const out = []; let line = prefix; let n = 0;
  toks.forEach((t) => {
    if (n > 0 && line.length + 1 + t.length > width) { out.push(line); line = '    ' + t; n = 1; } else { line += (line.endsWith(' ') ? '' : ' ') + t; n++; }
  });
  out.push(line); return out.join('\n');
}
const FLAGS_ARP = 'Flags: X - disabled, I - invalid, H - DHCP, D - dynamic, P - published, C - complete ';
const table = (rows, legend, indexed = true) => [legend, ...rows.map((r, i) => detailRow(indexed ? ` ${i} ${r.flags || ''}`.padEnd(5) : ` ${r.flags || ''}`.padEnd(5), r.kvs))].join('\n');

const neighborText = (rows) => table(rows.map((r) => ({ flags: '', kvs: r })), 'Flags: ');
function nrow(local, p, dupViaBridge) {
  const base = (iface) => [['interface', iface], p.ip ? ['address', p.ip] : null, p.ip && p.platform === 'MikroTik' ? ['address4', p.ip] : null, ['mac-address', p.mac], ['identity', p.name],
    ['platform', p.platform || 'MikroTik'], ['version', p.version || '7.12.1 (stable)'], ['unpack', 'none'], ['age', '3m25s'], ['uptime', '2w1d4h'],
    p.board ? ['board', p.board] : null, ['ipv6', 'no'], p.port ? ['interface-name', p.port] : null, p.caps ? ['system-caps', p.caps] : null, p.caps ? ['system-caps-enabled', p.caps] : null,
    p.proto ? ['discovered-by', p.proto] : null].filter(Boolean);
  return dupViaBridge ? [base(local), base('bridge1')] : [base(local)];
}

// 設定（/export）：entries = [[路徑, add|set, 參數]]
function wrapCmd(text, width = 72) {
  const toks = []; let t = ''; let inq = false;
  for (const ch of text) { if (ch === '"') inq = !inq; if (ch === ' ' && !inq) { toks.push(t); t = ''; } else t += ch; }
  toks.push(t);
  const out = []; let line = '';
  toks.forEach((tok) => { if (line && line.length + 1 + tok.length > width) { out.push(line + ' \\'); line = '    ' + tok; } else line = line ? line + ' ' + tok : tok; });
  out.push(line); return out;
}
function exportText(name, board, entries, compact) {
  const lines = ['# 2026-10-13 10:00:00 by RouterOS 7.12.1', `# software id = ${pick(['AB12', 'CD34', 'EF56'])}-${pad(Math.floor(rnd() * 9999), 4)}`, '#', `# model = ${board}`, `# serial number = HF${Math.floor(rnd() * 1e9)}`];
  entries.push(['/system identity', 'set', `name=${name}`]);
  if (!compact) entries.forEach(([p, c, a]) => lines.push(`${p} ${c} ${a}`));
  else { let ctx = null; entries.forEach(([p, c, a]) => { if (p !== ctx) { lines.push(p); ctx = p; } lines.push(...wrapCmd(`${c} ${a}`)); }); }
  return lines.join('\n');
}
const sort = (entries) => { const order = ['/interface bridge', '/interface ethernet', '/interface bonding', '/interface vlan', '/interface vrrp', '/interface bridge port', '/interface bridge vlan', '/ip address', '/ip dhcp-server network', '/routing id', '/routing ospf instance', '/ip route',
  '/ip pool', '/ip dhcp-server lease', '/ip dns', '/ip dns static', '/ip firewall address-list', '/system ntp client',
  '/interface list', '/interface list member', '/ip firewall filter', '/ip firewall nat', '/ip firewall raw', '/ipv6 firewall filter', '/ip service']; return entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])); };

const bridgeHostText = (rows) => table(rows.map((m) => ({ flags: m.local ? 'DL' : m.static ? '' : 'D', kvs: [['mac-address', m.mac], ['on-interface', m.ifc], ['bridge', 'bridge1'], ['vid', m.vid], ['age', pick(['3s', '12s', '45s', '1m2s'])]] })), 'Flags: X - disabled, I - invalid, D - dynamic, L - local, E - external ');
const arpText = (rows) => table(rows.map((r) => ({ flags: 'DC', kvs: [['address', r.ip], ['mac-address', r.mac], ['interface', r.ifc], ['published', 'no'], ['invalid', 'no'], ['DHCP', 'no'], ['dynamic', 'yes'], ['complete', 'yes'], ['disabled', 'no']] })), FLAGS_ARP);
const addrText = (rows) => table(rows.map((r) => ({ flags: '', kvs: [['address', r.cidr], ['network', r.net], ['interface', r.ifc], ['actual-interface', r.ifc]] })), 'Flags: X - disabled, I - invalid, D - dynamic ');
const routeText = (rows) => table(rows.map((r) => ({ flags: r.flags, kvs: r.blackhole
  ? [['dst-address', r.dst], ['routing-table', 'main'], ['blackhole', true], ['distance', r.dist], ['scope', r.scope || 30]]
  : [['dst-address', r.dst], ['routing-table', 'main'], ['gateway', r.gw], ['immediate-gw', r.igw || r.gw], ['distance', r.dist], ['scope', r.scope || 10]] })), 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC, o - OSPF, b - BGP', false);
const ospfText = (rows) => table(rows.map((r) => ({ flags: '', kvs: [['instance', 'default'], ['area', 'backbone'], ['address', r.addr], r.ifc ? ['interface', r.ifc] : null, ['priority', 1], ['router-id', r.id], ['state', 'Full'], ['state-changes', 5], ['adjacency', '1d2h']].filter(Boolean) })), 'Flags: ');
const ifaceText = (rows) => ['Flags: D - DYNAMIC; R - RUNNING; S - SLAVE', ...rows.map((r, i) => [` ${i}  ${r.flags}  ;;; ${r.comment || ''}`.replace(/ ;;; $/, ''), detailRow('       ', [['name', `"${r.name}"`.replace(/^"|"$/g, '')], ['type', r.type], ['mtu', 1500]])].join('\n').replace(/name=(\S+)/, 'name="$1"').replace(/type=(\S+)/, 'type="$1"'))].join('\n');
const sysText = (board, name) => `             uptime: 2w1d4h\n            version: 7.12.1 (stable)\n         board-name: ${board}\n           platform: MikroTik\n`;

const out = [];
const device = (name, ip, cmds) => {
  out.push(`${name} (${ip}):`);
  cmds.forEach(([cmd, text]) => { out.push(`[admin@${name}] > ${cmd}`); out.push(String(text).replace(/\n+$/, '')); out.push(''); });
  out.push('_____');
};
const D = 'detail without-paging';

// ---------------------------------------------------------------- 網路模型
const CORE_BOARD = 'CCR2216-1G-12XS-2XQ'; const ACC_BOARD = 'CRS326-24G-2S+'; const WAN_BOARD = 'CCR2216-1G-12XS-2XQ';
const VL = [{ id: 10, nets: 'MGMT' }, { id: 20, nets: 'SRV' }, { id: 30, nets: 'USER' }];
const wan = { name: 'WAN_RT_01', ip: '10.0.0.1', mac: mac(OUI_MT[0]), neighbors: [], entries: [], addrs: [], routes: [], ospf: [] };

for (let s = 1; s <= SITES; s++) {
  const C = siteCode(s); const F = FAULTS && s === 1; const n = (k) => `${C}_${k}`;
  const core = [1, 2].map((c) => ({ name: n('CORE_RT_0' + c), ip: `10.${s}.10.${c + 1}`, mac: mac(OUI_MT[1]), neighbors: [], entries: [], macs: [], arps: [], rid: `10.${s}.255.${c}`, board: CORE_BOARD }));
  const siteMacs = []; const acc = [];
  for (let a = 1; a <= ACC; a++) {
    const sw = { name: n('ACC_SW_' + pad(a)), ip: `10.${s}.10.${20 + a}`, mac: mac(OUI_MT[2]), neighbors: [], entries: [], macs: [], board: ACC_BOARD, ports: [] };
    const bond = `bond${a}`; const c0 = `sfp-sfpplus${2 * a - 1}`; const c1 = `sfp-sfpplus${2 * a}`; const c2 = `ether${a}`;
    const peer = (c, port) => ({ name: c.name, ip: c.ip, mac: c.mac, board: c.board, port, caps: 'bridge,router' });
    const me = (port) => ({ name: sw.name, ip: sw.ip, mac: sw.mac, board: sw.board, port, caps: 'bridge' });
    // 鄰居（含 LAG 兩條成員鏈路；每條同時從 bridge 看到一次，用來測試去重）
    sw.neighbors.push(...nrow('sfp-sfpplus1', peer(core[0], c0), true), ...nrow('sfp-sfpplus2', peer(core[0], c1), true));
    if (!(F && a === 2)) sw.neighbors.push(...nrow('ether24', peer(core[1], c2)));                                      // K01：ACC_02 不回報 CORE_02
    core[0].neighbors.push(...nrow(c0, me(F && a === 1 ? 'Uplink-to-CORE' : 'sfp-sfpplus1')), ...nrow(c1, me('sfp-sfpplus2')));   // K04
    core[1].neighbors.push(...nrow(c2, me('ether24')));
    // 接取交換器設定
    const e = sw.entries; const slaves = ['sfp-sfpplus1', 'sfp-sfpplus2'].concat(F && a === 4 ? ['ether20'] : []);            // K03：ACC_04 的聚合多一個成員
    e.push(['/interface bridge', 'add', 'name=bridge1 vlan-filtering=yes']);
    e.push(['/interface bonding', 'add', `mode=802.3ad name=${bond} slaves=${slaves.join(',')} transmit-hash-policy=layer-2-and-3 comment="to ${core[0].name}"`]);
    e.push(['/interface vlan', 'add', `interface=bridge1 name=vlan10 vlan-id=10${F && a === 1 ? ' comment=Management' : ''}`]);           // V06：ACC_01 的 VLAN 10 說明與核心不同
    e.push(['/interface bridge port', 'add', `bridge=bridge1 interface=${bond}`]);
    e.push(['/interface bridge port', 'add', `bridge=bridge1 interface=ether24${F && a === 8 ? ' pvid=10' : ''} comment="to ${core[1].name}"`]);   // V04：ACC_08 與 CORE_02 的 native VLAN 不同
    if (F && a === 12) e.push(['/interface vlan', 'add', 'interface=bridge1 name=vlan99 vlan-id=99 comment=MGMT']);                          // V05：VLAN 99 沒有任何成員埠；V07：說明 MGMT 在核心是 VLAN 10
    if (F && a === 11) {                                                                                               // A07：10.1.20.0/24 在核心是 VLAN 20，在 ACC_11 是 VLAN 40
      e.push(['/interface vlan', 'add', 'interface=ether19 name=vlan40 vlan-id=40']);
      e.push(['/ip address', 'add', `address=10.${s}.20.250/24 interface=vlan40 network=10.${s}.20.0`]);
    }
    if (F && a === 10) e.push(['/ip firewall filter', 'add', 'action=drop chain=input dst-port=23 protocol=tcp']);           // F08：有防火牆規則但沒有 WAN interface list
    const srvPorts = []; const userPorts = [];
    for (let k = 1; k <= SRV; k++) {
      const port = `ether${k}`; const m = mac(pick(OUI_SRV)); const ip = `10.${s}.20.${(a - 1) * SRV + k + 10}`; const nm = `${C}-SRV-${pad(a)}${k}`;
      sw.neighbors.push(...nrow(port, { name: nm, ip, mac: m, platform: 'Linux', version: 'Ubuntu 22.04', port: 'eth0', caps: 'station-only' }));
      e.push(['/interface ethernet', 'set', `[ find default-name=${port} ] comment=${nm}`]); e.push(['/interface bridge port', 'add', `bridge=bridge1 interface=${port} pvid=20`]);
      srvPorts.push(port); sw.macs.push({ vid: 20, mac: m, ifc: port }); siteMacs.push({ vlan: 20, mac: m, ip });
    }
    if (F && (a === 6 || a === 7)) sw.neighbors.push(...nrow('ether22', { name: `${C}-SRV-SHARED`, mac: 'AA:BB:CC:00:00:40', platform: 'Linux', port: 'eth0', caps: 'station-only' })); // K02
    if (F && a === 6) {                                                                                                // CSS610（SwOS Lite）：不支援 LLDP、無法用 SSH 收集，只送 MNDP；由 MAC 表＋MNDP 推論鏈路
      const css = { name: `${C}_CSS_01`, ip: `10.${s}.10.210`, mac: mac(OUI_MT[0]), platform: 'MikroTik', version: '2.17', board: 'CSS610-8P-2S+', caps: 'bridge', proto: 'mndp' };
      sw.neighbors.push(...nrow('ether21', css));
      sw.macs.push({ vid: 30, mac: css.mac, ifc: 'ether21' });
      for (let k = 0; k < 3; k++) sw.macs.push({ vid: 30, mac: mac(pick(OUI_PC)), ifc: 'ether21' });
    }
    if (F && a === 5) sw.neighbors.push(...nrow('ether17', { name: `${C}_AP_01`, ip: `10.${s}.10.200`, mac: mac(OUI_MT[0]), platform: 'MikroTik', version: '7.12.1 (stable)', board: 'cAP ac', port: 'ether1', caps: 'bridge,wlan-ap' })); // C01
    for (let k = 1; k <= USERS; k++) {
      const port = `ether${8 + k}`; const m = mac(pick(OUI_PC)); const ip = `10.${s}.30.${(a - 1) * USERS + k + 10}`;
      e.push(['/interface bridge port', 'add', `bridge=bridge1 interface=${port} pvid=30`]); userPorts.push(port); sw.macs.push({ vid: 30, mac: m, ifc: port }); siteMacs.push({ vlan: 30, mac: m, ip });
    }
    if (F && a === 2) sw.macs.push({ vid: 30, mac: acc[0].macs.find((x) => x.vid === 30).mac, ifc: 'ether23' });                // A02
    if (F && a === 12) for (let k = 0; k < 8; k++) sw.macs.push({ vid: 30, mac: mac(pick(OUI_PC)), ifc: 'ether23' });            // A04：ether23 下掛未管理交換器
    if (F && a === 1) sw.macs[0].static = true;                                                                                  // 靜態 MAC 項目
    e.push(['/interface bridge vlan', 'add', 'bridge=bridge1 tagged=bond1,ether24,bridge1 vlan-ids=10'.replace('bond1', bond)]);
    e.push(['/interface bridge vlan', 'add', `bridge=bridge1 tagged=${bond},ether24 untagged=${srvPorts.join(',')} vlan-ids=20`]);
    const v30Untagged = userPorts.concat(F && a === 11 ? ['ether24'] : []);                                                     // V08：ACC_11 的 ether24 把 VLAN 30 設成 untagged（CORE_02 是 tagged）
    e.push(['/interface bridge vlan', 'add', `bridge=bridge1 tagged=${bond}${F && (a === 3 || a === 11) ? '' : ',ether24'} untagged=${v30Untagged.join(',')} vlan-ids=30`]); // V01：ACC_03 的 ether24 少了 VLAN 30
    e.push(['/ip address', 'add', `address=${sw.ip}/${F && a === 10 ? 25 : 24} interface=vlan10 network=10.${s}.10.0`]);       // A06／A08：ACC_10 的 VLAN 10 遮罩是 /25
    if (F && (a === 11 || a === 12)) e.push(['/ip address', 'add', `address=10.${s}.10.99/24 interface=vlan10 network=10.${s}.10.0`]); // A09：同一 IP 設定在兩台
    acc.push(sw);
  }
  acc.forEach((sw) => {                       // 上行學到的其他 MAC
    const own = new Set(sw.macs.map((m) => m.mac));
    siteMacs.filter((m) => !own.has(m.mac)).slice(0, UPLINK_MACS).forEach((m) => sw.macs.push({ vid: m.vlan, mac: m.mac, ifc: `bond${acc.indexOf(sw) + 1}` }));
  });
  siteMacs.forEach((m) => {
    const ai = acc.findIndex((sw) => sw.macs.some((x) => x.mac === m.mac && !/^bond/.test(x.ifc) && x.ifc !== 'ether23')) + 1;
    core[0].macs.push({ vid: m.vlan, mac: m.mac, ifc: `bond${ai}` }); core[1].macs.push({ vid: m.vlan, mac: m.mac, ifc: `ether${ai}` });
    core[0].arps.push({ ip: m.ip, mac: m.mac, ifc: `vlan${m.vlan}` });
  });
  core[1].arps = core[0].arps.map((x) => ({ ...x }));
  if (F) { const x = core[1].arps.find((r) => r.ifc === 'vlan30'); x.mac = mac(pick(OUI_PC)); }                                 // A01
  if (F) core[0].arps.push({ ip: `10.${s}.99.5`, mac: mac(pick(OUI_PC)), ifc: 'vlan30' });                                         // A05：ARP 位址不在任何直連網段

  // 核心：互連、WAN／ISP
  ['qsfpplus1-1', 'qsfpplus2-1'].forEach((p) => {
    core[0].neighbors.push(...nrow(p, { name: core[1].name, ip: core[1].ip, mac: core[1].mac, board: CORE_BOARD, port: p, caps: 'bridge,router' }));
    core[1].neighbors.push(...nrow(p, { name: core[0].name, ip: core[0].ip, mac: core[0].mac, board: CORE_BOARD, port: p, caps: 'bridge,router' }));
  });
  core.forEach((c, ci) => {
    const e = c.entries; const rt = [];
    e.push(['/interface bridge', 'add', 'name=bridge1 vlan-filtering=yes']);
    if (ci === 0) acc.forEach((sw, i) => e.push(['/interface bonding', 'add', `mode=802.3ad name=bond${i + 1} slaves=sfp-sfpplus${2 * i + 1},sfp-sfpplus${2 * i + 2} transmit-hash-policy=layer-2-and-3 comment="to ${sw.name}"`]));
    e.push(['/interface bonding', 'add', 'mode=802.3ad name=bond100 slaves=qsfpplus1-1,qsfpplus2-1 comment="core interconnect"']);
    VL.forEach((v) => e.push(['/interface vlan', 'add', `interface=bridge1 name=vlan${v.id} vlan-id=${v.id}${F && v.id === 10 ? ' comment=MGMT' : ''}`]));
    const trunk = acc.map((_, i) => (ci === 0 ? `bond${i + 1}` : `ether${i + 1}`));
    trunk.forEach((p) => e.push(['/interface bridge port', 'add', `bridge=bridge1 interface=${p}${F && ci === 1 && p === 'ether8' ? ' pvid=20' : ''}`])); // V04 e.push(['/interface bridge port', 'add', 'bridge=bridge1 interface=bond100']);
    VL.forEach((v) => e.push(['/interface bridge vlan', 'add', `bridge=bridge1 tagged=${trunk.join(',')},bond100,bridge1 vlan-ids=${v.id}`]));
    VL.forEach((v) => e.push(['/ip address', 'add', `address=10.${s}.${v.id}.${ci + 2}/24 interface=vlan${v.id} network=10.${s}.${v.id}.0`]));
    VL.forEach((v) => rt.push({ flags: 'DAc', dst: `10.${s}.${v.id}.0/24`, gw: `vlan${v.id}`, igw: `vlan${v.id}`, dist: 0 }));
    if (SITES > 1) {
      const lip = `10.254.${s}.${ci * 4 + 2}`; const wip = `10.254.${s}.${ci * 4 + 1}`;
      e.push(['/ip address', 'add', `address=${lip}/30 interface=ether48 network=10.254.${s}.${ci * 4}`]);
      rt.push({ flags: 'DAc', dst: `10.254.${s}.${ci * 4}/30`, gw: 'ether48', igw: 'ether48', dist: 0 });
      for (let t = 1; t <= SITES; t++) if (t !== s) rt.push({ flags: 'DAo', dst: `10.${t}.0.0/16`, gw: wip, igw: `${wip}%ether48`, dist: 110, scope: 20 });
      const wp = `ether${(s - 1) * 2 + ci + 1}`;
      c.neighbors.push(...nrow('ether48', { name: wan.name, ip: wan.ip, mac: wan.mac, board: WAN_BOARD, port: wp, caps: 'bridge,router' }));
      wan.neighbors.push(...nrow(wp, { name: c.name, ip: c.ip, mac: c.mac, board: CORE_BOARD, port: 'ether48', caps: 'bridge,router' }));
      wan.addrs.push({ cidr: `${wip}/30`, net: `10.254.${s}.${ci * 4}`, ifc: wp });
      wan.routes.push({ flags: 'DAc', dst: `10.254.${s}.${ci * 4}/30`, gw: wp, igw: wp, dist: 0 });
      c.ospf = [{ addr: wip, id: '10.0.0.1', ifc: ci === 1 ? 'ether48' : null }];
      wan.ospf.push({ addr: lip, id: c.rid });
    } else {
      const ispIp = `203.0.113.${ci * 4 + 2}`; const gw = `203.0.113.${ci * 4 + 1}`;
      e.push(['/ip address', 'add', `address=${ispIp}/30 interface=ether47 network=203.0.113.${ci * 4}`]);
      e.push(['/ip route', 'add', `dst-address=0.0.0.0/0 gateway=${gw}`]);
      rt.push({ flags: 'DAc', dst: `203.0.113.${ci * 4}/30`, gw: 'ether47', igw: 'ether47', dist: 0 });
      rt.push({ flags: 'As', dst: '0.0.0.0/0', gw, igw: `${gw}%ether47`, dist: 1, scope: 30 });
      c.ospf = [];
    }
    if (F && ci === 0) {                                                                                                // VRRP 閘道與正常的 DHCP 網路；R03：互相指向的兩條靜態路由
      e.push(['/interface vrrp', 'add', 'interface=vlan30 name=vrrp30 vrid=30']);
      e.push(['/ip address', 'add', `address=10.${s}.30.1/32 interface=vrrp30 network=10.${s}.30.1`]);
      e.push(['/ip dhcp-server network', 'add', `address=10.${s}.30.0/24 dns-server=10.${s}.10.2 gateway=10.${s}.30.1 ntp-server=10.${s}.10.2`]);
      rt.push({ flags: 'As', dst: '10.97.0.0/16', gw: '10.96.0.1', dist: 1, scope: 30 }, { flags: 'As', dst: '10.96.0.0/16', gw: '10.97.0.1', dist: 1, scope: 30 });
    }
    if (F && ci === 1) {                                                                                                // R04：下一跳落入黑洞路由；R05：DHCP 閘道不在網段內
      rt.push({ flags: 'As', dst: '10.94.0.0/16', blackhole: true, dist: 1 }, { flags: 'As', dst: '10.95.0.0/16', gw: '10.94.0.1', dist: 1, scope: 30 });
      e.push(['/ip dhcp-server network', 'add', `address=10.${s}.20.0/24 gateway=10.${s}.21.1`]);
      e.push(['/ip dhcp-server network', 'add', `address=10.${s}.30.0/24 dns-server=10.${s}.10.2 gateway=10.${s}.30.3`]);               // R06：同一 DHCP 網段的閘道與核心 01 不同
    }
    if (F) {                                                                                                           // 名稱 ↔ IP 設定與 DNS／NTP 伺服器
      e.push(['/ip pool', 'add', `name=pool-user ranges=10.${s}.30.100-10.${s}.30.200`]);
      if (ci === 0) e.push(['/ip dhcp-server lease', 'add', `address=10.${s}.30.20 mac-address=6C:FE:54:00:AA:01 server=dhcp-user`]);
      e.push(['/ip dns', 'set', `allow-remote-requests=yes servers=${ci === 0 ? '1.1.1.1,8.8.8.8' : '8.8.8.8'}`]);                    // A12：DNS 伺服器不同（NTP 相同）
      e.push(['/ip dns static', 'add', `address=10.${s}.10.2 name=ntp.${C.toLowerCase()}.lan`]);
      e.push(['/ip dns static', 'add', `address=10.${s}.20.50 name=${ci === 0 ? 'nas' : 'storage'}.${C.toLowerCase()}.lan`]);          // A11：同一 IP 兩個名稱
      e.push(['/ip firewall address-list', 'add', `address=10.${s}.10.0/24 list=MGMT`]);
      if (ci === 1) e.push(['/ip firewall address-list', 'add', `address=10.${s}.99.0/24 list=MGMT`]);                                  // A10：MGMT 清單內容不同
      e.push(['/system ntp client', 'set', 'enabled=yes servers=time.cloudflare.com']);
    }
    if (F && ci === 0) {                                                                                                // R02：核心 01 有一個無法對應的 OSPF 鄰居
      e.push(['/ip address', 'add', `address=172.31.1.1/30 interface=ether46 network=172.31.1.0`]);
      rt.push({ flags: 'DAc', dst: '172.31.1.0/30', gw: 'ether46', igw: 'ether46', dist: 0 });
      c.ospf.push({ addr: '172.31.1.2', id: '172.31.255.2', ifc: null });
    }
    // 防火牆：defconf 風格（WAN 只放 ISP 上行；多站點時連到 WAN 路由器的 ether48 是內部鏈路，歸在 LAN），管理服務只開給管理網段
    const FF = (a) => e.push(['/ip firewall filter', 'add', a]);
    e.push(['/interface list', 'add', 'comment=defconf name=WAN'], ['/interface list', 'add', 'comment=defconf name=LAN']);
    e.push(['/interface list member', 'add', 'comment=defconf interface=bridge1 list=LAN'], ['/interface list member', 'add', 'comment=defconf interface=ether47 list=WAN']);
    if (SITES > 1) e.push(['/interface list member', 'add', 'interface=ether48 list=LAN']);
    FF('action=accept chain=input comment="defconf: accept established,related,untracked" connection-state=established,related,untracked');
    FF('action=drop chain=input comment="defconf: drop invalid" connection-state=invalid');
    FF('action=accept chain=input comment="defconf: accept ICMP" protocol=icmp');
    if (F && ci === 0) {
      FF('action=accept chain=input comment="defconf: accept ICMP" protocol=icmp');                                          // F02：defconf 匯入兩次
      FF('action=accept chain=input comment="winbox for vendor" dst-port=8291 protocol=tcp');                                 // F03：WAN 可以連 winbox 埠
      FF('action=accept chain=input dst-port=8291 in-interface=ether47 protocol=tcp');                                        // F01：被上一條完全涵蓋
    }
    if (F && ci === 1) FF('action=accept chain=input protocol=udp src-port=53');                                              // F06：以來源埠 53 放行
    // F07：核心 02 少了最後的 drop，www-ssl 又啟用且沒有 available-from
    if (!(F && ci === 1)) FF('action=drop chain=input comment="\\E9\\98\\B2\\E7\\81\\AB\\E7\\89\\86: drop all not coming from LAN" in-interface-list=!LAN');
    FF('action=fasttrack-connection chain=forward comment="defconf: fasttrack" connection-state=established,related hw-offload=yes');
    FF('action=accept chain=forward comment="defconf: accept established,related,untracked" connection-state=established,related,untracked');
    FF('action=drop chain=forward comment="defconf: drop invalid" connection-state=invalid');
    FF('action=drop chain=forward comment="defconf: drop all from WAN not DSTNATed" connection-nat-state=!dstnat connection-state=new in-interface-list=WAN');
    e.push(['/ip firewall nat', 'add', 'action=masquerade chain=srcnat comment="defconf: masquerade" ipsec-policy=out,none out-interface-list=WAN']);
    if (F && ci === 0) e.push(['/ip firewall nat', 'add', `action=dst-nat chain=dstnat dst-port=8443 in-interface-list=WAN protocol=tcp to-addresses=10.${s}.20.11 to-ports=443`]); // F04：連接埠轉送到伺服器
    if (F && ci === 1) e.push(['/ipv6 firewall filter', 'add', 'action=accept chain=forward dst-port=443 protocol=tcp']);   // F05：IPv6 只限目的埠
    ['telnet', 'ftp', 'www', 'api', 'api-ssl'].forEach((n) => e.push(['/ip service', 'set', `${n} disabled=yes`]));
    ['ssh', 'winbox'].forEach((n) => e.push(['/ip service', 'set', `${n} address=10.${s}.10.0/24`]));
    if (F && ci === 1) e.push(['/ip service', 'set', 'www-ssl disabled=no']);
    if (ci === 0) { e.push(['/routing id', 'add', `disabled=no id=${c.rid} name=main select-dynamic-id=""`]); e.push(['/routing ospf instance', 'add', 'disabled=no name=default router-id=main']); }
    else e.push(['/routing ospf instance', 'set', `[ find default=yes ] router-id=${c.rid}`]);
    c.routes = rt;
  });

  // ---- 輸出
  core.forEach((c, ci) => {
    const ifRows = [...acc.map((_, i) => (ci === 0 ? { name: `bond${i + 1}`, type: 'bond', flags: 'R', comment: `to ${acc[i].name}` } : { name: `ether${i + 1}`, type: 'ether', flags: 'R', comment: `to ${acc[i].name}` })),
      { name: 'bond100', type: 'bond', flags: 'R', comment: 'core interconnect' }, { name: 'bridge1', type: 'bridge', flags: 'R' }];
    const cmds = [
      ['/system resource print', sysText(c.board, c.name)],
      [`/export ${ci === 0 ? 'compact' : 'terse'}`, exportText(c.name, c.board, sort(c.entries), ci === 0)],
      [`/ip neighbor print ${D}`, neighborText(c.neighbors)],
      [`/interface print ${D}`, ifaceText(ifRows)],
      [`/interface bridge host print ${D}`, bridgeHostText([{ local: true, vid: 0, mac: c.mac, ifc: 'bridge1' }, ...c.macs])],
      [`/ip arp print ${D}`, arpText(c.arps)],
      [`/ip address print ${D}`, addrText(c.entries.filter((x) => x[0] === '/ip address').map((x) => { const m = x[2].match(/address=(\S+) interface=(\S+) network=(\S+)/); return { cidr: m[1], ifc: m[2], net: m[3] }; }))],
      [`/ip route print ${D}`, routeText(c.routes)],
    ];
    if (c.ospf.length) cmds.push([`/routing ospf neighbor print ${D}`, ospfText(c.ospf)]);
    device(c.name, c.ip, cmds);
  });
  acc.forEach((sw, i) => {
    const cmds = [[`/export terse`, exportText(sw.name, sw.board, sort(sw.entries), false)], [`/ip neighbor print ${D}`, neighborText(sw.neighbors)]];
    // RSTP：依官方手冊 /interface/bridge/port/monitor 範例的排版（key 右對齊、各欄固定寬度、designated port 的 designated-bridge-id 留空）
    const stpPorts = [[`bond${i + 1}`, 'root-port', core[0].mac, 1 + i], ['ether24', 'alternate-port', core[1].mac, 1 + i]].concat(F && i === 5 ? [['ether21', 'designated-port', null, 21]] : []);
    const W = 25; const row = (k, vals) => `${k.padStart(27)}: ${vals.map((v) => String(v).padEnd(W)).join('')}`;
    cmds.push(['/interface bridge port monitor [find] once', [
      row('interface', stpPorts.map((p) => p[0])), row('status', stpPorts.map(() => 'in-bridge')), row('port-id', stpPorts.map((p, k) => '0x80.' + (k + 1))),
      row('role', stpPorts.map((p) => p[1])), row('edge-port', stpPorts.map(() => 'no')), row('point-to-point-port', stpPorts.map(() => 'yes')),
      row('sending-rstp', stpPorts.map(() => 'yes')), row('learning', stpPorts.map((p) => (p[1] === 'alternate-port' ? 'no' : 'yes'))),
      row('forwarding', stpPorts.map((p) => (p[1] === 'alternate-port' ? 'no' : 'yes'))),
      row('designated-bridge-id', stpPorts.map((p) => (p[2] ? '0x8000.' + p[2] : ''))), row('designated-port-id', stpPorts.map((p) => '0x80.' + p[3])),
    ].map((l) => l.replace(/\s+$/, '')).join('\n')]);
    cmds.push(['/interface bridge monitor [find] once', [`                   name: bridge1`, `                  state: enabled`, `    current-mac-address: ${sw.mac}`, `              bridge-id: 0x8000.${sw.mac}`,
      `            root-bridge: no`, `         root-bridge-id: 0x8000.${core[0].mac}`, `              root-port: bond${i + 1}`].join('\n')]);
    if (!(F && i === 8)) cmds.push([`/interface bridge host print ${D}`, bridgeHostText([{ local: true, vid: 0, mac: sw.mac, ifc: 'bridge1' }, ...sw.macs])       // C02：ACC_09 沒有 MAC 表
      + (F && i === 11 ? '\n```' : '')]);                                                                                // I03：ACC_12 的 MAC 表後面混入 markdown 標記（從聊天或文件貼上）；放在最後一台的最後，不移動其他行號
    if (F && i === 9) cmds.push(['/system routerboard print', 'routerboard: yes\n        model: CRS326-24G-2S+\n serial-number: HF1234567890']);                  // I01
    if (F && i === 10) cmds.push([`/interface bridge host print ${D}`, bridgeHostText([{ local: true, vid: 0, mac: sw.mac, ifc: 'bridge1' }, ...sw.macs])]);      // I02
    device(sw.name, sw.ip, cmds);
  });
}
if (SITES > 1) {
  wan.entries.push(['/ip route', 'add', 'dst-address=0.0.0.0/0 gateway=203.0.113.1']);
  wan.routes.push({ flags: 'As', dst: '0.0.0.0/0', gw: '203.0.113.1', igw: '203.0.113.1%ether47', dist: 1, scope: 30 });
  for (let s = 1; s <= SITES; s++) wan.routes.push({ flags: 'DAo+', dst: `10.${s}.0.0/16`, gw: `10.254.${s}.2,10.254.${s}.6`, igw: `10.254.${s}.2%ether${(s - 1) * 2 + 1},10.254.${s}.6%ether${(s - 1) * 2 + 2}`, dist: 110, scope: 20 });
  wan.addrs.forEach((a) => wan.entries.push(['/ip address', 'add', `address=${a.cidr} interface=${a.ifc} network=${a.net}`]));
  wan.entries.push(['/routing id', 'add', 'disabled=no id=10.0.0.1 name=main select-dynamic-id=""']);
  wan.entries.push(['/routing ospf instance', 'add', 'disabled=no name=default router-id=main']);
  device(wan.name, wan.ip, [
    [`/export terse`, exportText(wan.name, WAN_BOARD, sort(wan.entries), false)], [`/ip neighbor print ${D}`, neighborText(wan.neighbors)],
    [`/routing ospf neighbor print ${D}`, ospfText(wan.ospf)], [`/ip route print ${D}`, routeText(wan.routes)],
  ]);
}
if (FAULTS) out.unshift('# 測試用收集檔：含刻意放入的問題，用來驗證一致性檢查', '');
process.stdout.write(out.join('\n') + '\n');
