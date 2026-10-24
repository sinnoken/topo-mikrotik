// 設定（/export）
'use strict';
const assert = require('assert');
const { S, build, ids, iface, addrs, test } = require('../lib.js');
// ------------------------------------------------------------------ 設定（/export）
const EXPORT_TERSE = ['SW_A (10.0.0.1):', '### /export terse', '# 2026-10-13 10:00:00 by RouterOS 7.12.1', '# model = CRS326-24G-2S+',
  '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bonding add mode=802.3ad name=bond1 slaves=ether1,ether2',
  '/interface ethernet set [ find default-name=ether3 ] name=srv3 comment="server 3"', '/interface vlan add interface=bridge1 name=vlan10 vlan-id=10',
  '/interface bridge port add bridge=bridge1 interface=bond1', '/interface bridge port add bridge=bridge1 interface=srv3 pvid=20',
  '/interface bridge vlan add bridge=bridge1 tagged=bond1,bridge1 untagged=srv3 vlan-ids=10,20-21 comment=prod',
  '/ip address add address=10.0.0.2/24 interface=vlan10', '/ip address add address=10.9.9.9/24 interface=ether9 disabled=yes',
  '/routing id add disabled=no id=1.1.1.1 name=main select-dynamic-id=""', '/routing ospf instance add disabled=no name=default router-id=main', '/system identity set name=SW_A'].join('\n');
test('export（terse）：聚合成員、改名與註解、VLAN 子介面、bridge VLAN（含範圍與 pvid）、IP、router-id、主機名', () => {
  const s = build(EXPORT_TERSE);
  assert.deepStrictEqual(iface(s, 'SW_A|bond1').lagMembers, ['SW_A|ether1', 'SW_A|ether2']);
  assert.deepStrictEqual([iface(s, 'SW_A|ether1').lag, iface(s, 'SW_A|bond1').type, iface(s, 'SW_A|bond1').typeBasis], ['SW_A|bond1', 'lag', 'rawType']);
  assert.strictEqual(iface(s, 'SW_A|srv3').desc, 'server 3');
  const bond = iface(s, 'SW_A|bond1'); const srv = iface(s, 'SW_A|srv3');
  assert.deepStrictEqual([bond.mode, bond.pvid, bond.untaggedVlans, bond.taggedVlans, bond.bridge], ['tagged', 1, [], [10, 20, 21], 'SW_A|bridge1'], 'pvid 1（預設）與 tagged VLAN 分開儲存');
  assert.deepStrictEqual([srv.mode, srv.pvid, srv.untaggedVlans, srv.taggedVlans], ['access', 20, [10, 20, 21], []]);
  assert.deepStrictEqual(S.util.ifcVlans(bond), [1, 10, 20, 21]);
  assert.deepStrictEqual([iface(s, 'SW_A|vlan10').type, iface(s, 'SW_A|vlan10').parent, iface(s, 'SW_A|vlan10').encapVlan], ['vlan', 'SW_A|bridge1', 10]);
  const v20 = s.model.vlans.find((v) => v.id === 20);
  assert.deepStrictEqual(v20.members.filter((x) => x.ep !== 'SW_A|bridge1'), [{ ep: 'SW_A|bond1', tagged: true }, { ep: 'SW_A|srv3', tagged: false }]);
  assert.deepStrictEqual(addrs(s, 'SW_A|vlan10'), ['10.0.0.2/24']);
  assert.strictEqual(iface(s, 'SW_A|ether9'), undefined, 'disabled 的位址不採用');
  assert.strictEqual(s.model.devices[0].routerId, '1.1.1.1', '/routing id 名稱要解析成位址');
  assert.strictEqual(s.model.devices[0].hostname, 'SW_A');
  assert.ok(s.model.vlans.some((v) => v.id === 20 && v.desc === 'prod'));
});
test('IP 位址與前綴實體：位址帶來源行、前綴由設備自有位址推導、鄰居宣告不產生前綴', () => {
  const s = build(['R_A (10.0.0.1):', '### /export terse', '/ip address add address=10.0.0.1/24 interface=ether1', '/ip address add address=10.0.0.9/24 interface=ether2',
    '/ip address add address=192.0.2.1/32 interface=lo', '### /routing ospf neighbor print detail', ' 0 instance=default area=backbone address=10.9.9.2 router-id=9.9.9.9 state="Full"'].join('\n'));
  const a = s.model.ipAddresses.find((x) => x.address === '10.0.0.1/24');
  assert.deepStrictEqual([a.ip, a.len, a.family, a.vrf, a.dev, a.ep, a.hearsay, a.src[0][1]], ['10.0.0.1', 24, 4, 'main', 'R_A', 'R_A|ether1', false, 3]);
  assert.deepStrictEqual(s.model.prefixes.map((p) => [p.key, p.prefix, p.vrf, p.basis, p.eps]), [['10.0.0.0/24', '10.0.0.0/24', 'main', 'connected', ['R_A|ether1', 'R_A|ether2']]], '/32 與鄰居宣告的位址不產生前綴');
  assert.ok(s.model.ipAddresses.some((x) => x.address === '10.9.9.2/32' && x.hearsay), 'OSPF 鄰居位址保留為鄰居宣告');
  const Q = S.query(s);
  assert.deepStrictEqual([Q.ipOwner('10.0.0.9'), Q.addressesOf('R_A|ether1'), Q.prefixes().length], ['R_A|ether2', ['10.0.0.1/24'], 1]);
  assert.strictEqual(s.meta.stats.prefixes, 1);
});
test('export（compact）：路徑標題、\\ 斷行、引號內斷行', () => {
  const t = ['R_A (10.0.0.1):', '### /export compact', '/interface bonding', 'add mode=802.3ad name=bond1 slaves=ether1,ether2 \\', '    comment="to the core \\', '    switch"',
    '/ip address', 'add address=10.1.1.1/24 interface=bridge1', '/routing ospf instance', 'set [ find default=yes ] router-id=2.2.2.2'].join('\n');
  const s = build(t);
  assert.strictEqual(iface(s, 'R_A|bond1').desc, 'to the core switch');
  assert.deepStrictEqual(addrs(s, 'R_A|bridge1'), ['10.1.1.1/24']);
  assert.strictEqual(s.model.devices[0].routerId, '2.2.2.2');
});
// 依 RouterOS 手冊（/ip firewall address-list、/ip dns、/ip dns static、/ip pool、/ip dhcp-server lease／network、/system ntp client）手寫，非真實設備擷取
const configFacts = (text) => {
  const { blocks } = S.readers.readAll([{ name: 't.txt', text }]);
  const out = [];
  blocks.forEach((b) => S.adapters['mikrotik.config'].parse(b, (f) => out.push(f)));
  return out;
};
const configModel = (text) => {
  const { blocks } = S.readers.readAll([{ name: 't.txt', text }]);
  blocks.forEach((b) => { b.devKey = b.device === null ? null : S.keys.dev(b.device); });
  const facts = [];
  blocks.forEach((b) => S.adapters['mikrotik.config'].parse(b, (f) => { Object.assign(f, { dev: b.devKey, adapter: 'mikrotik.config', dataType: 'config', vendor: 'mikrotik', block: b.id }); facts.push(f); }));
  return S.model.build({ blocks, facts, canon: (n) => String(n || '').trim() });
};
const BIND_EXPORT = ['R_A (10.0.0.1):', '### /export compact', '# 2026-10-13 10:00:00 by RouterOS 7.12.1',
  '/ip pool', 'add name=pool-user ranges=10.1.30.100-10.1.30.200,10.1.31.0/24',
  '/ip dhcp-server lease', 'add address=10.1.30.5 mac-address=aa:bb:cc:00:00:05 server=dhcp1', 'add address=10.1.30.6 disabled=yes mac-address=AA:BB:CC:00:00:06 server=dhcp1',
  '/ip dhcp-server network', 'add address=10.1.30.0/24 dns-server=10.1.10.53,10.1.10.54 gateway=10.1.30.1 \\', '    ntp-server=10.1.10.123',
  '/ip dns', 'set allow-remote-requests=yes servers=1.1.1.1,8.8.8.8',
  '/ip dns static', 'add address=10.1.10.53 name=DNS1.lan', 'add cname=dns1.lan name=ns.lan type=CNAME', 'add address=10.1.10.99 disabled=yes name=old.lan',
  '/ip firewall address-list', 'add address=10.1.10.0/24 comment="mgmt \\', '    net" list=MGMT', 'add address=192.0.2.9 disabled=yes list=blocked',
  '/ip/firewall/address-list add address=10.1.20.0/24 list=MGMT',
  '/system ntp client', 'set enabled=yes servers=10.1.10.123',
  '/system/ntp/client/servers add address=10.1.10.124', '/system ntp client servers add address=10.1.10.125 disabled=yes'].join('\n');
test('export：名稱 ↔ IP 綁定（address-list、DNS static、pool、靜態租約）帶行號；停用與非位址項目略過；斜線路徑與續行', () => {
  const binds = configFacts(BIND_EXPORT).filter((f) => f.t === 'ipBind').map((f) => [f.section, f.name, f.value, f.line]);
  assert.deepStrictEqual(binds, [
    ['/ip pool', 'pool-user', '10.1.30.100-10.1.30.200', 5], ['/ip pool', 'pool-user', '10.1.31.0/24', 5],
    ['/ip dhcp-server lease', 'aa:bb:cc:00:00:05', '10.1.30.5', 7],
    ['/ip dns static', 'DNS1.lan', '10.1.10.53', 15],
    ['/ip firewall address-list', 'MGMT', '10.1.10.0/24', 19],
    ['/ip firewall address-list', 'MGMT', '10.1.20.0/24', 22],
  ]);
});
test('export：DNS／NTP 伺服器（servers=、RouterOS 7 servers 子選單、RouterOS 6 primary-ntp／secondary-ntp）、DHCP 網路的 DNS／NTP', () => {
  const f = configFacts(BIND_EXPORT);
  assert.deepStrictEqual(f.filter((x) => x.t === 'dnsServers').map((x) => [x.servers, x.line]), [[['1.1.1.1', '8.8.8.8'], 13]]);
  assert.deepStrictEqual(f.filter((x) => x.t === 'ntpServers').map((x) => [x.servers, x.line]), [[['10.1.10.123'], 24], [['10.1.10.124'], 25]]);
  assert.deepStrictEqual(f.filter((x) => x.t === 'dhcpNet').map((x) => [x.network, x.gateways, x.dns, x.ntp, x.line]),
    [['10.1.30.0/24', ['10.1.30.1'], ['10.1.10.53', '10.1.10.54'], ['10.1.10.123'], 10]]);
  const v6 = configFacts(['R_B (10.0.0.2):', '### /export', '/system ntp client', 'set enabled=yes primary-ntp=10.1.10.123 secondary-ntp=0.0.0.0'].join('\n'));
  assert.deepStrictEqual(v6.filter((x) => x.t === 'ntpServers').map((x) => x.servers), [['10.1.10.123']], '0.0.0.0 代表未設定');
  const sp = configFacts(['R_C (10.0.0.3):', '### /export', '/system ntp client', 'set enabled=yes servers="10.1.10.123 pool.ntp.org"'].join('\n'));
  assert.deepStrictEqual(sp.filter((x) => x.t === 'ntpServers').map((x) => x.servers), [['10.1.10.123', 'pool.ntp.org']], '空白分隔也要切開');
  const M = configModel(BIND_EXPORT); const d = M.devices.get('R_A');
  assert.deepStrictEqual([d.dnsServers.values, d.ntpServers.values], [['1.1.1.1', '8.8.8.8'], ['10.1.10.123', '10.1.10.124']]);
  assert.deepStrictEqual(M.ipBinds.map((b) => [b.section, b.nameKey, b.valueKey]).slice(2, 4), [['/ip dhcp-server lease', 'AABBCC000005', '10.1.30.5'], ['/ip dns static', 'dns1.lan', '10.1.10.53']]);
  assert.deepStrictEqual([M.dhcpNets[0].dns, M.dhcpNets[0].ntp], [['10.1.10.53', '10.1.10.54'], ['10.1.10.123']]);
  const s = build(BIND_EXPORT);
  assert.ok(!('dns' in s.model.dhcpNetworks[0]), 'DHCP 網路的 DNS／NTP 只在內部模型');
});
// 設備層級的 DNS／NTP 伺服器（devices[].dnsServers／ntpServers）：記錄是從哪個選單、哪個參數收集到的
const srvOf = (text, key) => {
  const s = build(text); const d = s.model.devices.find((x) => x.key === key);
  const strip = (v) => v && { values: v.values, menu: v.menu, param: v.param, lines: v.src.map((x) => x[1]) };
  return { s, dns: strip(d.dnsServers), ntp: strip(d.ntpServers) };
};
test('export：設備的 DNS／NTP 伺服器進入 Snapshot，記錄來源選單與參數；同一台有多種 NTP 來源時依優先序取來源、值依出現順序合併', () => {
  // facts 帶 menu／param
  const f = configFacts(BIND_EXPORT);
  assert.deepStrictEqual(f.filter((x) => x.t === 'dnsServers' || x.t === 'ntpServers').map((x) => [x.t, x.menu, x.param, x.line]),
    [['dnsServers', '/ip dns', 'servers', 13], ['ntpServers', '/system ntp client', 'servers', 24], ['ntpServers', '/system ntp client servers', 'address', 25]]);
  // RouterOS 7：servers= 與 servers 子選單同時出現時，來源取 /system ntp client 的 servers（手冊：servers 是靜態設定，子選單同時列出它與動態項目）；值依出現順序合併，停用的子選單項目不算
  const a = srvOf(BIND_EXPORT, 'R_A');
  assert.deepStrictEqual(a.dns, { values: ['1.1.1.1', '8.8.8.8'], menu: '/ip dns', param: 'servers', lines: [13] });
  assert.deepStrictEqual(a.ntp, { values: ['10.1.10.123', '10.1.10.124'], menu: '/system ntp client', param: 'servers', lines: [24, 25] });
  // 子選單在 servers= 之前出現，來源仍是 servers=（優先序，不是出現順序）
  const rev = srvOf(['R_D (10.0.0.4):', '### /export', '/system ntp client servers add address=10.1.10.124', '/system ntp client set enabled=yes servers=10.1.10.123'].join('\n'), 'R_D');
  assert.deepStrictEqual(rev.ntp, { values: ['10.1.10.124', '10.1.10.123'], menu: '/system ntp client', param: 'servers', lines: [3, 4] });
  // 只有子選單：每筆 add 是一個伺服器，依 add 的順序
  const sub = srvOf(['R_B (10.0.0.2):', '### /export', '/system ntp client set enabled=yes', '/system ntp client servers', 'add address=time.cloudflare.com', 'add address=10.1.10.2'].join('\n'), 'R_B');
  assert.deepStrictEqual(sub.ntp, { values: ['time.cloudflare.com', '10.1.10.2'], menu: '/system ntp client servers', param: 'address', lines: [5, 6] });
  // RouterOS 6：primary-ntp／secondary-ntp（values 依 primary、secondary 的順序；0.0.0.0 是未設定）
  const v6 = srvOf(['R_C (10.0.0.3):', '### /export', '/system ntp client', 'set enabled=yes primary-ntp=10.1.10.123 secondary-ntp=10.1.10.124'].join('\n'), 'R_C');
  assert.deepStrictEqual(v6.ntp, { values: ['10.1.10.123', '10.1.10.124'], menu: '/system ntp client', param: 'primary-ntp/secondary-ntp', lines: [4] });
  // dynamic-servers 是唯讀（DHCP 等其他服務學到的），不是設定值，不和 servers 混在一起
  const dyn = srvOf(['R_E (10.0.0.5):', '### /export', '/ip dns set servers=1.1.1.1 dynamic-servers=9.9.9.9'].join('\n'), 'R_E');
  assert.deepStrictEqual(dyn.dns, { values: ['1.1.1.1'], menu: '/ip dns', param: 'servers', lines: [3] });
  const only = build(['R_E (10.0.0.5):', '### /export', '/ip dns set allow-remote-requests=yes dynamic-servers=9.9.9.9'].join('\n'));
  assert.strictEqual(only.model.devices[0].dnsServers, null, '只有 dynamic-servers 不算有設定 servers');
  // 沒有設定：null；查詢介面 Q.serversOf 回傳 { dns, ntp }，找不到的設備兩者皆 null
  assert.strictEqual(sub.dns, null);
  const Q = S.query(a.s);
  assert.deepStrictEqual(Q.serversOf('R_A'), { dns: a.s.model.devices.find((x) => x.key === 'R_A').dnsServers, ntp: a.s.model.devices.find((x) => x.key === 'R_A').ntpServers });
  assert.deepStrictEqual(Q.serversOf('NOPE'), { dns: null, ntp: null });
  assert.deepStrictEqual(S.query(sub.s).serversOf('R_B').dns, null);
});
test('export：bridge 沒有開 vlan-filtering 時，不產生 VLAN 成員', () => {
  const s = build('SW_A (10.0.0.1):\n### /export terse\n/interface bridge add name=bridge1\n/interface bridge port add bridge=bridge1 interface=ether1 pvid=20\n/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=10\n');
  const e1 = iface(s, 'SW_A|ether1');
  assert.deepStrictEqual([e1.pvid, e1.untaggedVlans, e1.taggedVlans, e1.mode, e1.bridge], [null, [], [], null, 'SW_A|bridge1']);
});
