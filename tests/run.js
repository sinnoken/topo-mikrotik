/*
 * 測試：node tests/run.js        （加 --large 會另外跑約 1000 台的壓力測試）
 * 不需要任何套件。每個測試都在 Node 上直接載入與瀏覽器相同的核心檔案。
 * 注意：測試用的 RouterOS 輸出是依文件與慣例撰寫，不是從真實設備擷取；真實輸出請另外驗證。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const load = require('./load.js');
const S = load();
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const build = (text, opt) => S.build([{ name: 't.txt', text }], Object.assign({ now: '2026-01-01T00:00:00Z' }, opt));
const ids = (snap) => snap.findings.map((f) => f.id);
const count = (snap, id) => snap.findings.filter((f) => f.id === id).length;
const gen = (args) => execFileSync('node', [path.join(ROOT, 'tools/gen-bundle.js'), ...args], { encoding: 'utf8', maxBuffer: 5e8 });
const iface = (s, k) => s.model.interfaces.find((i) => i.key === k);
const addrs = (s, ep) => s.model.ipAddresses.filter((a) => a.ep === ep).map((a) => a.address);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const dev = (name, body) => `${name} (10.0.0.${Math.floor(Math.random() * 200 + 1)}):\n${body}\n`;

// ------------------------------------------------------------------ 讀取
test('bundle-v1：設備標頭、分隔線可省略、兩種指令標記、註解行、行號', () => {
  const text = ['# 註解', 'SW_A (10.0.0.1):', '### /ip neighbor print detail without-paging', 'X', '_____',
    'SW_B (10.0.0.2):', '[admin@SW_B] > /interface bridge vlan print detail', 'Y', 'R_C (10.0.0.3):', '[admin@R_C] > /ip route print detail', 'Z'].join('\n');
  const { blocks } = S.readers.readAll([{ name: 'a.txt', text }]);
  assert.deepStrictEqual(blocks.map((b) => [b.device, b.command, b.origin.startLine]), [
    ['SW_A', '/ip neighbor print detail without-paging', 4], ['SW_B', '/interface bridge vlan print detail', 8], ['R_C', '/ip route print detail', 11]]);
  assert.strictEqual(blocks[0].mgmtIp, '10.0.0.1');
});
test('files-v1：沒有標頭時以檔名為設備名', () => {
  const { blocks } = S.readers.readAll([{ name: 'dir/EDGE_SW_9.txt', text: '### /ip arp print detail\nfoo' }]);
  assert.strictEqual(blocks[0].device, 'EDGE_SW_9');
  assert.strictEqual(blocks[0].reader, 'files-v1');
});
test('沒有設備標頭的內容列為無法辨識（不靜默丟棄）', () => {
  const s = build('隨便一段文字\nSW_A (10.0.0.1):\n### /ip neighbor print detail\n');
  assert.ok(ids(s).includes('I01'));
});
test('指令有辨識但輸出不是 detail 格式 → I01，並提示加 detail', () => {
  const s = build('SW_A (10.0.0.1):\n### /ip arp print\nFlags: X - disabled\n #   ADDRESS       MAC-ADDRESS       INTERFACE\n 0 DC 10.0.0.2    AA:BB:CC:00:00:01 bridge1\n');
  const f = s.findings.find((x) => x.id === 'I01');
  assert.ok(f && /detail/.test(f.message), f && f.message);
});

// ------------------------------------------------------------------ 鄰居
test('鄰居：續行、引號內空白、bridge 重複列去除、型號與功能推論類型', () => {
  const t = ['SW_A (10.0.0.1):', '[admin@SW_A] > /ip neighbor print detail without-paging', 'Flags:',
    ' 0 interface=sfp-sfpplus1 address=10.0.0.2 address4=10.0.0.2 mac-address=AA:BB:CC:00:00:01', '    identity=SW_B platform=MikroTik version="7.12 (stable)" board=CRS326-24G-2S+',
    '    interface-name=sfp-sfpplus3 system-caps=bridge system-caps-enabled=bridge',
    ' 1 interface=bridge1 address=10.0.0.2 mac-address=AA:BB:CC:00:00:01 identity=SW_B platform=MikroTik interface-name=sfp-sfpplus3',
    ' 2 interface=ether5 mac-address=AA:BB:CC:00:00:09 identity="PC 1" platform=Linux interface-name=eth0 system-caps-enabled=station-only',
    ' 3 interface=ether6 mac-address=AA:BB:CC:00:00:0A identity=AP_1 platform=MikroTik board="cAP ac" interface-name=ether1 system-caps-enabled=bridge,wlan-ap'].join('\n');
  const s = build(t);
  assert.strictEqual(s.model.links.length, 3);
  const k = (key) => s.model.devices.find((d) => d.key === key);
  assert.deepStrictEqual([k('SW_B').kind, k('SW_B').kindBasis, k('SW_B').deviceType], ['switch', 'board', 'CRS326-24G-2S+']);
  assert.deepStrictEqual([k('SW_B').manufacturer, k('SW_B').softwareVersion, k('SW_B').caps], ['mikrotik', '7.12 (stable)', 'bridge'], '鄰居回報的版本與功能保留為設備欄位');
  assert.deepStrictEqual([k('PC 1').kind, k('PC 1').kindBasis], ['host', 'caps']);
  assert.strictEqual(k('AP_1').kind, 'switch');
  assert.strictEqual(k('SW_B').mgmtIp, '10.0.0.2');
});
test('鄰居：identity 和收集檔的設備名不同時，用管理 IP 對回同一台', () => {
  const a = 'A_RT (10.0.0.1):\n### /ip neighbor print detail\n 0 interface=ether1 address=10.0.0.2 mac-address=AA:BB:CC:00:00:01 identity=MikroTik interface-name=ether1\n';
  const b = 'B_SW (10.0.0.2):\n### /ip neighbor print detail\n 0 interface=ether1 address=10.0.0.1 mac-address=AA:BB:CC:00:00:02 identity=A_RT interface-name=ether1\n';
  const s = build(a + b);
  assert.ok(!s.model.devices.some((d) => d.key === 'MIKROTIK'), '不應多出一台叫 MikroTik 的設備');
  assert.strictEqual(s.model.links.length, 1); assert.ok(s.model.links[0].verified);
});
test('鄰居：兩邊都沒有對端埠名（RouterOS 6）：單一鏈路可配對；多條平行鏈路不會被誤判為同一個介面對應到多個鄰居', () => {
  const one = build('A (10.0.0.1):\n### /ip neighbor print detail\n 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=B\n'
    + 'B (10.0.0.2):\n### /ip neighbor print detail\n 0 interface=ether2 mac-address=AA:00:00:00:00:02 identity=A\n');
  assert.strictEqual(one.model.links.length, 1); assert.ok(one.model.links[0].verified); assert.strictEqual(count(one, 'K01'), 0);
  const lag = build('A (10.0.0.1):\n### /ip neighbor print detail\n 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=B\n 1 interface=ether2 mac-address=AA:00:00:00:00:01 identity=B\n'
    + 'B (10.0.0.2):\n### /ip neighbor print detail\n 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=A\n 1 interface=ether2 mac-address=AA:00:00:00:00:02 identity=A\n');
  assert.strictEqual(lag.model.links.length, 2); assert.strictEqual(count(lag, 'K02'), 0);
});

test('鄰居：同一介面的 LLDP 與 MNDP/CDP 列合併為一筆，保留協定聯集；缺埠名或只有 MAC／identity 也能對上', () => {
  const claims = (t) => build(t).model.links;
  const a = 'A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=lldp\n'
    + ' 1 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B discovered-by=mndp\n'
    + ' 2 interface=ether1 mac-address=aa:00:00:00:00:02 discovered-by=cdp\n'
    + ' 3 interface=ether2 mac-address=AA:00:00:00:00:03 identity=C interface-name=p1 discovered-by=lldp\n'
    + ' 4 interface=ether2 identity=c discovered-by=mndp\n'
    + ' 5 interface=bridge1 mac-address=AA:00:00:00:00:02 identity=B discovered-by=mndp\n';
  const s = build(a);
  assert.strictEqual(s.model.links.length, 2);
  const l1 = s.model.links.find((l) => l.key.includes('A') && l.a.includes('ether1') || l.b.includes('ether1'));
  assert.deepStrictEqual(l1.protocols, ['cdp', 'lldp', 'mndp']);
  assert.strictEqual(l1.evidenceScope, 'interface-adjacency', 'LLDP/CDP 證據仍可支援介面鄰接推論');
  assert.ok(!s.model.interfaces.some((i) => /bridge1/.test(i.key)), 'bridge 觀察不應多出介面');
  assert.ok(claims(a).every((l) => !/\?\(/.test(l.a + l.b)), '合併後不應有未知埠名的重複鏈路');
});
test('MNDP：多個鄰居代表共享 L2 廣播網域可達，不推論直連埠、雙向確認或 VLAN／聚合差異', () => {
  const s = build('A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n'
    + ' 1 interface=ether1 mac-address=AA:00:00:00:00:03 identity=C interface-name=ether8 discovered-by=mndp\n');
  assert.strictEqual(s.model.links.length, 2);
  assert.ok(s.model.links.every((l) => l.evidenceScope === 'broadcast-domain' && l.via.includes('mndp')));
  assert.ok(s.model.links.every((l) => !l.verified && !l.hearsay));
  assert.ok(s.model.links.every((l) => l.observations.length === 1 && l.observations[0].ifc === 'ether1'));
  assert.ok(s.model.interfaces.filter((i) => i.dev !== 'A').every((i) => i.hearsay), 'MNDP 回報的對端介面只能保留為單側觀察，不能當成設備本機收集的事實');
  assert.ok(s.model.links.every((l) => !l.vlanComparable && !l.vlansA.length && !l.vlansB.length));
  assert.strictEqual(count(s, 'K01'), 0);
  assert.strictEqual(count(s, 'K02'), 0, '一個廣播網域介面看到多個鄰居不是介面直連衝突');
  assert.strictEqual(count(s, 'K03'), 0);
  assert.strictEqual(count(s, 'V01'), 0, 'MNDP 域可達證據不能當作對端埠 VLAN 比對');
  const diff = S.compare(S.query(s), {
    schema: 'ssot-expected/1', links: [{ a: 'A ether1', b: 'B ether9' }], strictLinks: true,
  });
  assert.strictEqual(diff.items[0].status, 'different', 'MNDP 廣播網域可達不能滿足預期的直連介面鏈路');
  assert.ok(!diff.items.some((i) => i.status === 'unexpected'), 'strictLinks 不應把 MNDP 廣播網域可達列為額外直連');
  const noReportedPort = S.compare(S.query(s), {
    schema: 'ssot-expected/1', links: [{ a: 'A ether1', b: 'B ether7' }],
  });
  assert.strictEqual(noReportedPort.items[0].status, 'different', '遠端回報埠不同也應辨識到只有 MNDP 廣播網域可達');

  const aggregates = build('A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n'
    + '### /export terse\n/interface bridge add name=bridgeA vlan-filtering=yes\n'
    + '/interface bonding add mode=802.3ad name=bondA slaves=ether1,ether2\n'
    + '/interface bridge port add bridge=bridgeA interface=bondA\n'
    + '/interface bridge vlan add bridge=bridgeA tagged=bondA vlan-ids=10\n'
    + 'B (10.0.0.2):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether9 mac-address=AA:00:00:00:00:01 identity=A interface-name=ether1 discovered-by=mndp\n'
    + '### /export terse\n/interface bridge add name=bridgeB vlan-filtering=yes\n'
    + '/interface bonding add mode=802.3ad name=bondB slaves=ether9,ether10\n'
    + '/interface bridge port add bridge=bridgeB interface=bondB\n'
    + '/interface bridge vlan add bridge=bridgeB tagged=bondB vlan-ids=20\n');
  assert.strictEqual(iface(aggregates, 'A|ether1').lag, 'A|bonda');
  assert.strictEqual(iface(aggregates, 'B|ether9').lag, 'B|bondb');
  assert.strictEqual(count(aggregates, 'K03'), 0, 'MNDP 廣播網域可達不檢查兩端聚合成員');
  assert.strictEqual(count(aggregates, 'V01'), 0, 'MNDP 廣播網域可達不比較對端埠 VLAN');

  const reciprocal = build('A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n'
    + 'B (10.0.0.2):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether9 mac-address=AA:00:00:00:00:01 identity=A interface-name=ether1 discovered-by=mndp\n');
  assert.strictEqual(reciprocal.model.links.length, 1);
  assert.strictEqual(reciprocal.model.links[0].evidenceScope, 'broadcast-domain');
  assert.strictEqual(reciprocal.model.links[0].observations.length, 2);
  assert.strictEqual(reciprocal.model.links[0].verified, false, '雙向 MNDP 回報仍不等於確認實體直連');
  assert.strictEqual(count(reciprocal, 'K01'), 0);
});
test('MNDP 觀察不應把有 MAC 的介面誤當成已確認 LLDP 鄰接而排除終端清單', () => {
  const s = build('A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=AA:BB:CC:00:00:01 on-interface=ether1 bridge=bridge1 vid=10\n'
    + 'B (10.0.0.2):\n### /export terse\n/system identity set name=B\n');
  assert.strictEqual(iface(s, 'A|ether1').unknownPeer, true, 'MNDP 是廣播網域可達證據，不可代替 LLDP／CDP 埠鄰接');
  assert.ok(S.query(s).unknownPeers('A').some((r) => r.name === 'ether1'), '介面應保留在未知對端／終端清單');
  const a03 = s.findings.find((f) => f.id === 'A03');
  assert.ok(a03 && /ether1/.test(a03.message), '沒有 LLDP／CDP 鄰接的介面應出現在 A03');
  assert.strictEqual(s.model.links.find((l) => l.via.includes('mndp')).evidenceScope, 'broadcast-domain', 'MNDP edge 仍保留為廣播網域可達資訊');
});

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
  assert.deepStrictEqual([a.ip, a.len, a.family, a.vrf, a.dev, a.ep, a.hearsay, a.src[0][1]], ['10.0.0.1', 24, 4, null, 'R_A', 'R_A|ether1', false, 3]);
  assert.deepStrictEqual(s.model.prefixes.map((p) => [p.prefix, p.basis, p.eps]), [['10.0.0.0/24', 'connected', ['R_A|ether1', 'R_A|ether2']]], '/32 與鄰居宣告的位址不產生前綴');
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
  assert.ok(!('dns' in s.model.dhcpNetworks[0]) && !('dnsServers' in s.model.devices[0]), '新資料只在內部模型，Snapshot 欄位不變');
});
test('export：bridge 沒有開 vlan-filtering 時，不產生 VLAN 成員', () => {
  const s = build('SW_A (10.0.0.1):\n### /export terse\n/interface bridge add name=bridge1\n/interface bridge port add bridge=bridge1 interface=ether1 pvid=20\n/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=10\n');
  const e1 = iface(s, 'SW_A|ether1');
  assert.deepStrictEqual([e1.pvid, e1.untaggedVlans, e1.taggedVlans, e1.mode, e1.bridge], [null, [], [], null, 'SW_A|bridge1']);
});

// ------------------------------------------------------------------ 其他 print
test('bridge host：略過 bridge 自己的 MAC（L），VLAN 取自 vid', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface bridge host print detail\nFlags: D - dynamic, L - local\n 0 DL mac-address=E4:8D:8C:00:00:02 on-interface=bridge1 bridge=bridge1 vid=0 age=3s\n 1 D  mac-address=24:6E:96:00:00:05 on-interface=ether1 bridge=bridge1 vid=20 age=3s\n');
  assert.strictEqual(s.model.macs.length, 1);
  assert.deepStrictEqual(s.model.macs[0].seen, [{ ep: 'SW_A|ether1', vlan: '20', static: false }]);
});
test('bridge vlan print：用實際成員（current-*），動態項目也算', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface bridge vlan print detail\n 0   ;;; prod\n     bridge=bridge1 vlan-ids=10 tagged=ether1 untagged=ether2 current-tagged=ether1,bond1 current-untagged=ether2\n 1 D bridge=bridge1 vlan-ids=1 tagged="" untagged="" current-tagged="" current-untagged=ether3,ether4\n');
  assert.deepStrictEqual([iface(s, 'SW_A|bond1').taggedVlans, iface(s, 'SW_A|bond1').untaggedVlans], [[10], []]);
  assert.deepStrictEqual([iface(s, 'SW_A|ether4').untaggedVlans, iface(s, 'SW_A|ether4').mode], [[1], 'access']);
  assert.ok(s.model.vlans.some((v) => v.id === 10 && v.desc === 'prod'));
});
test('interface print：running／停用／註解（含獨立一行的 ;;;）', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\nFlags: D - DYNAMIC; R - RUNNING; S - SLAVE\n 0  R  ;;; uplink\n       name="ether1" default-name="ether1" type="ether" mtu=1500\n 1     name="ether2" type="ether" mtu=1500\n 2 X   name="ether3" type="ether" mtu=1500\n 3  RS name="bond1" type="bond" mtu=1500\n');
  assert.deepStrictEqual([iface(s, 'SW_A|ether1').status, iface(s, 'SW_A|ether1').desc], ['up', 'uplink']);
  assert.strictEqual(iface(s, 'SW_A|ether2').status, 'down');
  assert.deepStrictEqual([iface(s, 'SW_A|ether3').enabled, iface(s, 'SW_A|ether2').enabled], [false, true]);
  assert.strictEqual(iface(s, 'SW_A|bond1').type, 'lag');
});
test('interface print：CAPsMAN 說明續行保留 Wi-Fi running 旗標；Wi-Fi 介面本身不列為終端', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
    + ' 7    RS ;;; managed by CAPsMAN, traffic processing on\n'
    + '              CAP         ;;; mode: AP, SSID: test, channel: 2412/n\n'
    + '         name="wifi1" default-name="wifi1" type="wifi" actual-mtu=1500\n'
    + ' 9  D RS ;;; managed by CAPsMAN, traffic processing on\n'
    + '              CAP         ;;; mode: AP, SSID: test-5g, channel: 5660/ac/Ceee\n'
    + '         name="wifi8" type="wifi" actual-mtu=1500\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=14:63:93:C4:13:24 on-interface=wifi1 bridge=bridge\n'
    + ' 1 D mac-address=3C:64:CF:0C:C4:63 on-interface=wifi1 bridge=bridge\n'
    + ' 2 D mac-address=06:89:53:94:06:0F on-interface=wifi8 bridge=bridge\n'
    + ' 3 D mac-address=18:F0:E4:FF:EF:35 on-interface=wifi8 bridge=bridge\n');
  ['wifi1', 'wifi8'].forEach((name) => {
    const i = iface(s, `SW_A|${name}`);
    assert.strictEqual(i.status, 'up', `${name} 的 R 旗標不可被 CAPsMAN 說明覆蓋`);
    assert.strictEqual(i.macs.length, 2);
    assert.strictEqual(i.edge, false, `${name} 不應列為終端介面`);
    assert.strictEqual(i.unknownPeer, false, `${name} 不應列為未知對端`);
  });
});
test('interface print：type=veth 歸類為 virtual（rawType 保留 veth），unknownPeers 帶型別；其他介面不受影響', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
    + ' 0  R  name="veth1" type="veth" mtu=1500\n'
    + ' 1  R  name="ether5" type="ether" mtu=1500\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=02:AA:BB:00:00:01 on-interface=veth1 bridge=bridge1\n'
    + ' 1 D mac-address=AA:BB:CC:00:00:02 on-interface=ether5 bridge=bridge1\n');
  assert.deepStrictEqual([iface(s, 'SW_A|veth1').type, iface(s, 'SW_A|veth1').rawType], ['virtual', 'veth']);
  assert.strictEqual(iface(s, 'SW_A|ether5').type, 'physical');
  const rows = S.query(s).unknownPeers('SW_A');
  assert.strictEqual(rows.find((r) => r.name === 'veth1').rawType, 'veth');
  assert.notStrictEqual(rows.find((r) => r.name === 'ether5').rawType, 'veth');
});
test('interface print：保留 rawType／介面 MAC／MTU，並依 rawType 排除 bridge 終端', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
    + ' 0  R  name="ether1" default-name="ether1" type="ether" mtu=1500 l2mtu=1598 mac-address=AA:BB:CC:00:00:01\n'
    + ' 1  R  name="br-mgmt" type="bridge" mtu=1500 actual-mtu=1500\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=02:AA:BB:00:00:01 on-interface=ether1 bridge=br-mgmt\n'
    + ' 1 D mac-address=02:AA:BB:00:00:02 on-interface=br-mgmt bridge=br-mgmt\n');
  const e = iface(s, 'SW_A|ether1');
  assert.deepStrictEqual([e.rawType, e.hwMac, e.defaultName, e.mtu, e.l2mtu], ['ether', 'AA:BB:CC:00:00:01', 'ether1', 1500, 1598]);
  const b = iface(s, 'SW_A|br-mgmt');
  assert.deepStrictEqual([b.rawType, b.actualMtu, b.edge], ['bridge', 1500, false]);
  assert.strictEqual(e.edge, true);
});
test('介面自身的 mac-address 出現在轉發表時不算外部終端', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
    + ' 0  R  name="ether1" type="ether" mac-address=AA:BB:CC:00:00:01\n'
    + ' 1  R  name="ether2" type="ether" mac-address=AA:BB:CC:00:00:02\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=AA:BB:CC:00:00:02 on-interface=ether1 bridge=br\n'
    + ' 1 D mac-address=02:AA:BB:00:00:09 on-interface=ether2 bridge=br\n');
  assert.strictEqual(iface(s, 'SW_A|ether1').edge, false);
  assert.strictEqual(iface(s, 'SW_A|ether2').edge, true);
});
test('interface print 缺漏：改用 export 的 bridge／vlan 定義判斷，再退回名稱規則', () => {
  const s = build('SW_A (10.0.0.1):\n### /export terse\n'
    + '/interface bridge add name=br-mgmt\n/interface vlan add name=v-10 interface=ether1 vlan-id=10\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=02:AA:BB:00:00:01 on-interface=br-mgmt bridge=br-mgmt\n'
    + ' 1 D mac-address=02:AA:BB:00:00:02 on-interface=v-10 bridge=br-mgmt\n'
    + ' 2 D mac-address=02:AA:BB:00:00:03 on-interface=ether1 bridge=br-mgmt\n'
    + ' 3 D mac-address=02:AA:BB:00:00:04 on-interface=irb9 bridge=br-mgmt\n');
  assert.deepStrictEqual(['br-mgmt', 'v-10'].map((n) => iface(s, 'SW_A|' + n).rawType), ['bridge', 'vlan']);
  assert.deepStrictEqual(['br-mgmt', 'v-10', 'irb9'].map((n) => iface(s, 'SW_A|' + n).edge), [false, false, false]);
  assert.strictEqual(iface(s, 'SW_A|ether1').edge, true);
});
test('LLDP interface-name 為 bridge/port：取實體埠配對，雙向確認且不產生 bridge/ 假介面', () => {
  const nb = (local, ip, mac, id, name) => ` 0 interface=${local} address=${ip} mac-address=${mac} identity="${id}" platform="MikroTik" interface-name="${name}" discovered-by=lldp,mndp\n`;
  const s = build('A (192.168.77.1):\n### /ip neighbor print detail without-paging\n' + nb('ether3,bridge', '192.168.77.9', 'D4:01:C3:4E:2D:04', 'B', 'bridge/ether2')
    + 'B (192.168.77.9):\n### /ip neighbor print detail without-paging\n' + nb('ether2,bridge', '192.168.77.1', 'AA:00:00:00:00:01', 'A', 'bridge/ether3'));
  assert.deepStrictEqual(s.model.links.map((l) => [l.a, l.b, l.verified]), [['A|ether3', 'B|ether2', true]]);
  assert.ok(!s.model.interfaces.some((i) => i.name.includes('/')));
  assert.strictEqual(count(s, 'K01'), 0);
});
test('LLDP 配對：只有 LLDP 才算回報，MNDP 不算；bridge 成員與 bridge 本身兩端名稱視為同一介面', () => {
  const nb = (ifc, ip, mac, id, name, proto) => ` 0 interface=${ifc} address=${ip} mac-address=${mac} identity="${id}" platform="MikroTik" interface-name="${name}" discovered-by=${proto}\n`;
  const head = (n, ip) => `${n} (${ip}):\n### /ip neighbor print detail without-paging\n`;
  const c = (dev) => head(dev, '10.0.0.3') + nb('ether1', '10.0.0.9', 'AA:00:00:00:00:09', 'Z', 'ether1', 'lldp');
  const mndpBack = build(head('A', '10.0.0.1') + nb('ether1', '10.0.0.2', 'AA:00:00:00:00:02', 'B', 'ether2', 'lldp,mndp')
    + head('B', '10.0.0.2') + nb('ether2', '10.0.0.1', 'AA:00:00:00:00:01', 'A', 'ether1', 'mndp') + nb('ether5', '10.0.0.3', 'AA:00:00:00:00:03', 'C', 'ether1', 'lldp') + c('C'));
  assert.ok(mndpBack.model.links.some((l) => !l.verified && l.protocols.includes('lldp')));
  assert.ok(count(mndpBack, 'K01') >= 1);
  const bridges = build(head('A', '10.0.0.1') + nb('bridge', '10.0.0.2', 'AA:00:00:00:00:02', 'B', 'bridge', 'lldp')
    + head('B', '10.0.0.2') + nb('bridge', '10.0.0.1', 'AA:00:00:00:00:01', 'A', 'bridge/ether1', 'lldp'));
  assert.deepStrictEqual(bridges.model.links.map((l) => [l.a, l.b, l.verified]), [['A|bridge', 'B|bridge', true]]);
  assert.strictEqual(count(bridges, 'K01'), 0);
});
test('鄰居表：同一對設備的 MNDP（多介面、雙向）併成一列，仍保留各 link 來源', () => {
  const nb = (ifc, ip, mac, id) => ` 0 interface=${ifc} address=${ip} mac-address=${mac} identity="${id}" platform=MikroTik discovered-by=mndp\n`;
  const s = build('A (10.0.0.1):\n### /ip neighbor print detail without-paging\n'
    + nb('ether1', '10.0.0.2', 'AA:00:00:00:00:02', 'B') + nb('ether2', '10.0.0.2', 'AA:00:00:00:00:02', 'B')
    + 'B (10.0.0.2):\n### /ip neighbor print detail without-paging\n' + nb('ether5', '10.0.0.1', 'AA:00:00:00:00:01', 'A'));
  const Q = S.query(s);
  assert.strictEqual(Q.linksOf('A').length, 3);
  const rows = Q.neighborRows('A');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].links.length, 3);
  assert.deepStrictEqual(rows[0].observations.map((o) => o.ifc), ['ether1', 'ether2']);
  assert.deepStrictEqual(Q.neighborRows('B')[0].observations.map((o) => o.ifc), ['ether5']);
});
test('interface print：type=wifi／wlan 歸類為 wireless', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
    + ' 0  R  name="wifi1" type="wifi" mtu=1500\n 1  R  name="wlan1" type="wlan" mtu=1500\n 2  R  name="ether5" type="ether" mtu=1500\n');
  assert.strictEqual(iface(s, 'SW_A|wifi1').type, 'wireless');
  assert.strictEqual(iface(s, 'SW_A|wlan1').type, 'wireless');
  assert.strictEqual(iface(s, 'SW_A|ether5').type, 'physical');
});
test('ARP 與 IP 位址：略過 invalid／disabled、多播、APIPA', () => {
  const s = build('R_A (10.0.0.1):\n### /ip arp print detail\n 0 DC address=10.0.0.2 mac-address=AA:BB:CC:00:00:01 interface=bridge1 complete=yes\n 1 I  address=10.0.0.3 mac-address=AA:BB:CC:00:00:02 interface=bridge1 complete=yes\n 2 DC address=169.254.1.1 mac-address=AA:BB:CC:00:00:03 interface=bridge1 complete=yes\n'
    + '### /ip address print detail\n 0   address=10.0.0.1/24 network=10.0.0.0 interface=bridge1 actual-interface=bridge1\n 1 X address=10.9.9.1/24 network=10.9.9.0 interface=ether9 actual-interface=ether9\n');
  assert.strictEqual(s.model.arps.length, 1);
  assert.deepStrictEqual(addrs(s, 'R_A|bridge1'), ['10.0.0.1/24']);
});
test('路由：RouterOS 7（無序號）、ECMP（gateway=a,b）、連接路由、非作用中與其他路由表略過；RouterOS 6（序號、大寫旗標、pref-src）', () => {
  const v7 = ['Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC, o - OSPF',
    ' DAc dst-address=10.1.1.0/24 routing-table=main gateway=bridge1 immediate-gw=bridge1 distance=0 scope=10',
    ' DAo+ dst-address=10.2.0.0/16 routing-table=main gateway=10.0.0.2,10.0.0.6 immediate-gw=10.0.0.2%ether1,10.0.0.6%ether2 distance=110 scope=20',
    ' As  dst-address=0.0.0.0/0 routing-table=main gateway=10.0.0.254 immediate-gw=10.0.0.254%ether9 distance=1 scope=30',
    '  s  dst-address=10.5.0.0/16 routing-table=main gateway=10.0.0.9 distance=1', ' DAb dst-address=10.6.0.0/16 routing-table=vrf1 gateway=10.0.0.9 distance=20'].join('\n');
  const v6 = ['Flags: X - disabled, A - active, D - dynamic, C - connect, S - static, o - ospf', ' 0 ADC  dst-address=10.1.1.0/24 pref-src=10.1.1.1 gateway=bridge1 gateway-status=bridge1 reachable distance=0 scope=10',
    ' 1 A S  dst-address=0.0.0.0/0 gateway=10.0.0.254 gateway-status=10.0.0.254 reachable via bridge1 distance=1 scope=30', ' 2   S  dst-address=10.7.0.0/16 gateway=10.0.0.9 distance=1'].join('\n');
  const s7 = build('R_A (10.0.0.1):\n### /ip route print detail\n' + v7); const r7 = s7.model.routes;
  assert.deepStrictEqual(r7.map((r) => r.prefix + '/' + r.len + ' ' + r.proto), ['0.0.0.0/0 Static', '10.1.1.0/24 Direct', '10.2.0.0/16 OSPF']);
  assert.deepStrictEqual(r7.find((r) => r.prefix === '10.2.0.0').nh, [{ ip: '10.0.0.2', ifc: 'ether1' }, { ip: '10.0.0.6', ifc: 'ether2' }]);
  assert.deepStrictEqual(r7.find((r) => r.prefix === '10.1.1.0').nh, [{ ip: null, ifc: 'bridge1' }]);
  const s6 = build('R_A (10.0.0.1):\n### /ip route print detail\n' + v6);
  assert.deepStrictEqual(s6.model.routes.map((r) => r.prefix + ' ' + r.proto), ['0.0.0.0 Static', '10.1.1.0 Direct']);
});
test('OSPF：鄰居列沒有 interface 時，用鄰居位址落在哪個本機網段決定；對得上的設備與 router-id', () => {
  const a = 'R_A (10.0.0.1):\n### /export terse\n/ip address add address=10.254.0.1/30 interface=ether48\n/routing id add id=1.1.1.1 name=main\n/routing ospf instance add name=default router-id=main\n'
    + '### /routing ospf neighbor print detail\n 0 instance=default area=backbone address=10.254.0.2 priority=1 router-id=2.2.2.2 state=Full state-changes=5\n';
  const b = 'R_B (10.0.0.2):\n### /export terse\n/ip address add address=10.254.0.2/30 interface=ether1\n/routing ospf instance add name=default router-id=2.2.2.2\n'
    + '### /routing ospf neighbor print detail\n 0 instance=default address=10.254.0.1 router-id=1.1.1.1 interface=ether1 state=Full\n';
  const s = build(a + b);
  assert.strictEqual(s.model.links.length, 0, 'OSPF-only adjacency must not create a direct topology edge');
  assert.strictEqual(s.model.ospfAdjacencies.length, 2);
  const adj = s.model.ospfAdjacencies.find((x) => x.dev === 'R_A');
  assert.ok(adj && adj.localEp === 'R_A|ether48' && adj.peerEp === 'R_B|ether1' && adj.reciprocal, JSON.stringify(adj));
  assert.deepStrictEqual(adj.src, [[1, 7]], 'OSPF adjacency retains source block and line');
  assert.strictEqual(S.query(s).ospfAdjacenciesOf('R_A').length, 1);
  assert.strictEqual(count(s, 'R02'), 0);
});
test('system resource：型號決定交換器／路由器', () => {
  const s = build('X (10.0.0.1):\n### /system resource print\n  uptime: 1d\n  version: 7.12.1 (stable)\n  board-name: CRS326-24G-2S+\n');
  assert.deepStrictEqual([s.model.devices[0].kind, s.model.devices[0].deviceType, s.model.devices[0].softwareVersion], ['switch', 'CRS326-24G-2S+', '7.12.1 (stable)']);
});

// ------------------------------------------------------------------ 範例資料：每個刻意放入的問題都要被找到
test('範例資料：每項刻意放入的問題都被找到，且沒有多餘的錯誤', () => {
  const s = build(read('samples/sample-bundle.txt'));
  const expect = { I01: 1, I02: 1, C02: 1, K01: 1, K02: 1, K03: 1, K04: 1, V01: 1, V04: 1, V05: 1, V06: 1, V07: 1, A01: 1, A02: 1, A04: 1, A05: 1,
    A06: 1, A07: 1, A08: 1, A09: 1, A10: 1, A11: 1, A12: 1, R01: 2, R02: 1, R03: 1, R04: 1, R05: 1, R06: 1, C01: 3 };
  Object.entries(expect).forEach(([id, n]) => assert.strictEqual(count(s, id), n, `${id} 應有 ${n} 筆，實際 ${count(s, id)}`));
  assert.strictEqual(s.meta.stats.collected, 14);
  const css = s.model.inferredLinks.find((l) => l.a.startsWith('TPE_CSS_01|') || l.b.startsWith('TPE_CSS_01|'));
  assert.ok(css && css.confidence === 'high' && css.bases.join('+') === 'fdb+mndp-unique', '範例的 CSS610 應以 MAC 表＋MNDP 推論到 ACC_06 ether21');
  assert.deepStrictEqual(s.findings.filter((f) => f.severity === 'error').map((f) => f.id).sort(), ['I01', 'K02']);
  s.findings.forEach((f) => f.evidence.forEach((e) => assert.ok(typeof e.text === 'string')));
  const v01 = s.findings.find((f) => f.id === 'V01').entities.find((e) => e.type === 'link');
  assert.strictEqual(s.model.links.find((l) => l.key === v01.key).vlanComparable, true, 'vlanComparable 必須序列化，查詢層才能判斷是否可比對');
});
test('同樣輸入建立兩次，結果完全相同（建立時間除外）', () => {
  const a = build(read('samples/sample-bundle.txt')); const b = build(read('samples/sample-bundle.txt'));
  delete a.meta.timing; delete b.meta.timing;
  assert.deepStrictEqual(a, b);
});
test('鏈路配對：聚合成員雙向確認、沒有 LLDP 的鄰居為單側觀察', () => {
  const s = build(read('samples/sample-bundle.txt'));
  const l = s.model.links.find((x) => x.key === 'TPE_ACC_SW_01|sfp-sfpplus1~TPE_CORE_RT_01|sfp-sfpplus1');
  assert.ok(l && l.verified && l.cls === 'lag', JSON.stringify(l));
  assert.strictEqual(s.model.links.length, 78, 'OSPF adjacencies no longer count as direct topology links（78 含範例中 CSS610 的 MNDP 鏈路）');
  const ap = s.model.links.find((x) => x.key.includes('TPE_AP_01'));
  assert.ok(ap && ap.hearsay);
});

// ------------------------------------------------------------------ 未知對端
test('未知對端：有 MAC、沒有 LLDP 鄰居的終端埠才會標記；有鄰居的主機埠與上行聚合埠不標', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  assert.strictEqual(iface(s, 'TPE_ACC_SW_01|bond1').unknownPeer, false, '上行聚合埠不是未知對端');
  assert.strictEqual(iface(s, 'TPE_ACC_SW_01|ether1').unknownPeer, false, '伺服器埠有 LLDP 鄰居');
  assert.strictEqual(iface(s, 'TPE_ACC_SW_01|ether1').edge, true);
  const rows = Q.unknownPeers('TPE_ACC_SW_01');
  assert.strictEqual(rows.length, 8);
  assert.ok(rows.every((r) => r.macs.length === 1 && /^10\.1\.30\./.test(r.macs[0].ips[0]) && r.macs[0].vendor), '應帶有 ARP 的 IP 與 OUI 廠商');
  assert.ok(!Q.unknownDevices().includes('TPE_ACC_SW_09'), '沒有 MAC 表的設備不會有未知對端');
});
test('未知對端：連到已收集主機的介面仍是終端位置，不當作網路設備上行埠排除', () => {
  const mac = 'AA:BB:CC:00:00:01';
  const text = 'SW_A (10.0.0.1):\n### /ip neighbor print detail\n'
    + ' 0 interface=ether1 mac-address=AA:BB:CC:00:00:02 identity=HOST_B platform=Linux interface-name=eth0 system-caps=station-only system-caps-enabled=station-only\n'
    + '### /interface bridge host print detail\n'
    + ` 0 D mac-address=${mac} on-interface=ether1 bridge=bridge1 vid=10\n`
    + 'HOST_B (10.0.0.2):\n### /interface print detail\n 0 R name=eth0 type=ether\n';
  const s = build(text, { profile: { id: 'test-host', classify: [{ match: '^HOST_B$', kind: 'host' }] } });
  assert.strictEqual(s.model.devices.find((d) => d.key === 'HOST_B').kind, 'host');
  assert.strictEqual(iface(s, 'SW_A|ether1').edge, true);
});
test('清單：Q.inventory 的列與計數一致，且與基準統計對得上', () => {
  const s = build(read('samples/sample-bundle.txt')); const { rows, counts: C } = S.query(s).inventory();
  const st = s.meta.stats;
  assert.deepStrictEqual([C.devices, C.interfaces, C.macs, C.vlans], [st.devices, st.interfaces, st.macs, st.vlans]);
  assert.strictEqual(new Set(rows.ips.map((r) => r.ip)).size, rows.ips.length, 'IP 清單必須去重複');
  assert.strictEqual(C.arpIps, new Set(s.model.arps.map((a) => a.ip)).size);
  assert.strictEqual(new Set(rows.macs.map((r) => r.mac)).size, C.macs);
  assert.strictEqual(C.endpointPorts, new Set(rows.endpoints.map((e) => e.key)).size, '終端位置數應依清單中的介面位置計算，包含 Wi-Fi MAC 觀察位置');
  assert.ok(rows.endpoints.every((e) => e.end === true) && rows.devices.every((d) => !d.end));
  assert.deepStrictEqual(S.query(s).inventory().counts, C, '相同輸入結果相同');
});
test('可追溯：MAC、ARP 與已收集設備的介面都帶來源', () => {
  const s = build(read('samples/sample-bundle.txt')); const m = s.model;
  assert.ok(m.macs.every((x) => x.src.length && x.src.every(([b, l]) => b != null && l > 0)), '每個 MAC 都要有來源');
  assert.ok(m.arps.every((a) => a.src.length === 1 && a.src[0][1] > 0), '每筆 ARP 都要有來源');
  const collected = new Set(m.devices.filter((d) => d.collected).map((d) => d.key));
  const lost = m.interfaces.filter((i) => collected.has(i.dev) && !i.hearsay && !i.src.length).map((i) => i.key);
  assert.deepStrictEqual(lost, [], '已收集設備的介面不可沒有來源');
  [['devices', m.devices], ['interfaces', m.interfaces], ['vlans', m.vlans]].forEach(([name, list]) => list.forEach((x) => {
    assert.ok(x.src.length ? x.srcNone === null : typeof x.srcNone === 'string', `${name} 沒有來源時必須說明原因：${x.key || x.dev}`);
  }));
  assert.ok(!m.interfaces.some((i) => i.srcNone === 'unrecorded'), '不可有「應有來源卻沒記錄」的介面');
});
test('未知對端：學到多個 MAC 的介面不列為終端', () => {
  const mac = (n) => ` ${n} D mac-address=AA:BB:CC:00:00:0${n} on-interface=ether5 bridge=bridge1 vid=30 age=3s`;
  const s = build(['SW_A (10.0.0.1):', '### /interface bridge host print detail', mac(1), mac(2), mac(3)].join('\n'));
  const rows = S.query(s).unknownPeers('SW_A');
  assert.strictEqual(rows.length, 0, '學到多個 MAC 的介面不列為終端');
  assert.strictEqual(iface(s, 'SW_A|ether5').edge, false);
});
test('未知對端：Wi-Fi 介面不列為終端，但每個 MAC 觀察位置列入終端清單且不觸發 A02', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface print detail\n'
    + 'Flags: D - DYNAMIC; R - RUNNING\n 0 R name="wifi1" type="wifi"\n 1 R name="wifi2" type="wifi"\n'
    + '### /interface bridge host print detail\n'
    + ' 0 D mac-address=AA:BB:CC:00:00:01 on-interface=wifi1 bridge=bridge1 vid=10\n'
    + ' 1 D mac-address=AA:BB:CC:00:00:01 on-interface=wifi2 bridge=bridge1 vid=10\n'
    + ' 2 D mac-address=AA:BB:CC:00:00:02 on-interface=ether1 bridge=bridge1 vid=10\n');
  assert.strictEqual(iface(s, 'SW_A|wifi1').macs.length, 1);
  assert.strictEqual(iface(s, 'SW_A|wifi1').edge, false);
  assert.strictEqual(iface(s, 'SW_A|ether1').edge, true, '一般單 MAC 介面仍列為終端');
  assert.deepStrictEqual(S.query(s).unknownPeers('SW_A').map((p) => p.name), ['ether1']);
  assert.strictEqual(count(s, 'A02'), 0, '重複出現在 Wi-Fi 介面的 MAC 不觸發 A02');
  const Q = S.query(s);
  assert.deepStrictEqual(Q.visualUnknownPeers('SW_A').filter((p) => p.visualOnly).map((p) => p.name), ['wifi1', 'wifi2']);
  const wifiEndpoints = Q.inventory().rows.endpoints.filter((p) => p.wifi);
  assert.deepStrictEqual(wifiEndpoints.map((p) => [p.ifc, p.mac]), [
    ['wifi1', 'AABBCC000001'], ['wifi2', 'AABBCC000001'],
  ], 'Wi-Fi 每個 MAC 觀察位置都應列入終端清單');
});
test('A02：不同 VLAN 的終端埠不視為同一 MAC 重複位置', () => {
  const mac = 'AA:BB:CC:00:00:01';
  const s = build('SW_A (10.0.0.1):\n### /interface bridge host print detail\n'
    + ` 0 D mac-address=${mac} on-interface=ether1 bridge=bridge1 vid=10\n`
    + ` 1 D mac-address=${mac} on-interface=ether2 bridge=bridge1 vid=20\n`);
  assert.strictEqual(count(s, 'A02'), 0);
  assert.deepStrictEqual(s.model.macs[0].seen, [
    { ep: 'SW_A|ether1', vlan: '10', static: false }, { ep: 'SW_A|ether2', vlan: '20', static: false },
  ]);
});
test('A02：同介面多 VLAN 觀察完整保留，並只比較相同 VLAN 的終端埠', () => {
  const mac = 'AA:BB:CC:00:00:01';
  const s = build('SW_A (10.0.0.1):\n### /interface bridge host print detail\n'
    + ` 0 D mac-address=${mac} on-interface=ether1 bridge=bridge1 vid=10\n`
    + ` 1 D mac-address=${mac} on-interface=ether1 bridge=bridge1 vid=20\n`
    + ` 2 D mac-address=${mac} on-interface=ether2 bridge=bridge1 vid=20\n`);
  assert.deepStrictEqual(s.model.macs[0].seen, [
    { ep: 'SW_A|ether1', vlan: '10', static: false }, { ep: 'SW_A|ether1', vlan: '20', static: false }, { ep: 'SW_A|ether2', vlan: '20', static: false },
  ]);
  const finding = s.findings.find((f) => f.id === 'A02');
  assert.ok(finding && finding.message.includes('VLAN 20'), finding && finding.message);
  assert.deepStrictEqual(finding.entities.filter((e) => e.type === 'interface').map((e) => e.key), ['SW_A|ether1', 'SW_A|ether2']);
});
test('A02：同一個 VLAN ID 只在同一個 VLAN 區塊內比較，不相連的區塊（例如各站點重用 VLAN ID）不報', () => {
  const mac = 'AA:BB:CC:00:00:01';
  const sw = (name, ip, nb) => [`${name} (${ip}):`, NB(nb), '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes',
    '/interface bridge port add bridge=bridge1 interface=ether1', '/interface bridge port add bridge=bridge1 interface=ether2',
    '/interface bridge vlan add bridge=bridge1 tagged=ether1 untagged=ether2 vlan-ids=10', BH([` 0 D mac-address=${mac} on-interface=ether2 bridge=bridge1 vid=10`])].join('\n');
  const lldp = (peer) => [` 0 interface=ether1 mac-address=AA:00:00:00:00:0${peer === 'SW_A' ? 1 : 2} identity=${peer} interface-name=ether1 discovered-by=lldp`];
  const split = build([sw('SW_A', '10.0.0.1', []), sw('SW_C', '10.0.0.3', [])].join('\n'));
  assert.strictEqual(S.query(split).vlan(10).domains.length, 2);
  assert.strictEqual(count(split, 'A02'), 0, '兩台之間沒有承載 VLAN 10 的鏈路，是不同區塊');
  const joined = build([sw('SW_A', '10.0.0.1', lldp('SW_B')), sw('SW_B', '10.0.0.2', lldp('SW_A'))].join('\n'));
  assert.strictEqual(S.query(joined).vlan(10).domains.length, 1);
  const f = joined.findings.find((x) => x.id === 'A02');
  assert.ok(f, '同一個區塊內照常比較');
  assert.deepStrictEqual(f.entities.filter((e) => e.type === 'interface').map((e) => e.key), ['SW_A|ether2', 'SW_B|ether2']);
});
test('未知對端不進基準的設備、鏈路（只是檢視）', () => {
  const s = build(read('samples/sample-bundle.txt'));
  assert.ok(!s.model.devices.some((d) => d.key.startsWith('?')));
});

// ------------------------------------------------------------------ 命名規則（可獨立、可跳過）
test('不套用命名規則時，設備類型只看資料，不看名稱', () => {
  const s = build('MY_FW_LIKE_NAME (10.0.0.1):\n### /interface bridge host print detail\n 0 D mac-address=AA:BB:CC:00:00:01 on-interface=ether1 bridge=bridge1 vid=10\n');
  assert.strictEqual(s.model.devices[0].kind, 'switch');
  assert.strictEqual(s.meta.profile, null);
});
test('自動連通元件群組使用不誤稱 IP 子網的名稱', () => {
  const s = build('SW_A (10.0.0.1):\n### /interface bridge host print detail\n'
    + ' 0 D mac-address=AA:BB:CC:00:00:01 on-interface=ether1 bridge=bridge1 vid=10\n');
  assert.strictEqual(s.model.devices[0].component, 1);
  assert.strictEqual(s.model.devices[0].group, '自動群組 1');
});
test('命名規則：別名合併、去網域、分類、分群；只加註解不改事實', () => {
  const prof = { id: 't', classify: [{ match: '_FW_', kind: 'firewall', role: 'fw' }], group: { match: '^([A-Z]+)_', value: '$1' }, alias: { 'OLD-SW': 'SW_A' }, stripDomain: true };
  const text = 'SW_A (10.0.0.1):\n### /ip neighbor print detail\n 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=TPE_FW_01.corp.local interface-name=port1\n 1 interface=ether2 mac-address=AA:00:00:00:00:02 identity=old-sw interface-name=x\n';
  const a = build(text); const b = build(text, { profile: prof });
  assert.ok(b.model.devices.some((d) => d.key === 'TPE_FW_01' && d.kind === 'firewall' && d.kindBasis === 'profile' && d.group === 'TPE'));
  assert.ok(!b.model.devices.some((d) => d.key === 'OLD-SW'), '別名應合併');
  assert.strictEqual(a.model.devices.length, 3);
  assert.deepStrictEqual(b.meta.profile, { id: 't', version: '1' });
});
test('命名規則有錯時明確回報錯誤', () => {
  assert.throws(() => S.profile.compile({ id: 'x', classify: [{ match: '(' }] }), /正規表示式/);
});
test('附帶的命名規則檔可載入', () => {
  const vm = require('vm');
  vm.runInThisContext(read('profiles/site-naming.js'));
  const p = S.profiles['site-naming'];
  assert.ok(p && S.profile.compile(p));
  const base = build(read('samples/sample-bundle.txt'));
  const s = build(read('samples/sample-bundle.txt'), { profile: p });
  assert.ok(s.model.devices.filter((d) => d.group === 'TPE').length >= 14);
  // 範例的設備名是「站點_層級_類型_編號」：類型要依第三段判斷，不可因層級 CORE 把路由器判成交換器
  const kind = (snap, k) => snap.model.devices.find((d) => d.key === k).kind;
  ['TPE_CORE_RT_01', 'TPE_CORE_RT_02', 'TPE_ACC_SW_01'].forEach((k) => assert.strictEqual(kind(s, k), kind(base, k), `${k} 的類型不應被命名規則改錯`));
  assert.deepStrictEqual([kind(s, 'TPE_CORE_RT_01'), s.model.devices.find((d) => d.key === 'TPE_CORE_RT_01').role], ['router', 'CORE']);
  assert.deepStrictEqual(s.findings.filter((f) => f.id === 'C02').map((f) => f.message), base.findings.filter((f) => f.id === 'C02').map((f) => f.message), '套用內建規則不應改變應收集的資料');
  const c = S.profile.compile(p);
  assert.deepStrictEqual([c.annotate('TPE_FW_01').kind, c.annotate('TPE_RT_01').kind, c.annotate('TPE_DIST_01').kind], ['firewall', 'router', 'switch'], '相容三段名稱');
});
test('附帶的 JSON 命名規則範例可載入，分隔符號 _ 與 - 一致處理', () => {
  const c = S.profile.compile(JSON.parse(read('profiles/floor-device-naming.json')));
  const at = (n) => c.annotate(n);
  [['3F_hAP', { role: 'AP', group: '3F', label: 'hAP' }], ['3F-hAP_02', { role: 'AP', group: '3F', label: 'hAP_02' }],
    ['2F-RB5009', { kind: 'router', role: 'RTR', group: '2F', label: 'RB5009' }], ['2F_RB5009_02', { kind: 'router', role: 'RTR', group: '2F', label: 'RB5009_02' }],
    ['B1F_wAP_02', { role: 'AP', group: 'B1F', label: 'wAP_02' }], ['3F_CRS326', { group: '3F', label: 'CRS326' }]]
    .forEach(([n, want]) => assert.deepStrictEqual(at(n), want, n));
});

// ------------------------------------------------------------------ 規格書 P1：收集時間、MAC 類型、路由距離與黑洞、VRRP、DHCP 網路
test('export 抬頭的收集時間（RouterOS 6／7 格式）；其他 # 行仍是註解', () => {
  const s = build(['SW (10.0.0.1):', '### /export terse', '# 2026-10-13 10:00:00 by RouterOS 7.12.1', '# model = CRS326', '/system identity set name=SW',
    'R6 (10.0.0.2):', '### /export', '# oct/13/2026 09:05:01 by RouterOS 6.49.7', '/system identity set name=R6'].join('\n'));
  assert.deepStrictEqual(s.model.devices.map((d) => [d.key, d.collectedAt]), [['R6', '2026-10-13T09:05:01'], ['SW', '2026-10-13T10:00:00']]);
});
test('路由：distance、黑洞路由（RouterOS 7 單獨的 blackhole 字、RouterOS 6 的 B 旗標）；MAC 表的靜態項目', () => {
  const s = build(['R (10.0.0.1):', '### /ip route print detail without-paging', 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC',
    ' 0  As dst-address=10.94.0.0/16 routing-table=main blackhole distance=1', ' 1  As dst-address=0.0.0.0/0 routing-table=main gateway=192.0.2.1 distance=5',
    ' 2  AB dst-address=10.93.0.0/16 type=blackhole distance=1',
    '### /interface bridge host print detail without-paging', ' 0    mac-address=AA:BB:CC:00:00:01 on-interface=ether1 bridge=bridge1 vid=10'].join('\n'));
  const r = (p) => s.model.routes.find((x) => x.prefix === p);
  assert.deepStrictEqual([r('10.94.0.0').blackhole, r('10.94.0.0').nh, r('10.93.0.0').blackhole, r('0.0.0.0').distance, r('0.0.0.0').blackhole], [true, [], true, 5, false]);
  assert.strictEqual(s.model.macs[0].seen[0].static, true);
});
test('R03／R04：下一跳迴圈與落入黑洞分開回報，不重複列為 R01；路徑追蹤在黑洞路由停下', () => {
  const s = build(['R (10.0.0.1):', '### /export terse', '/ip address add address=10.0.0.1/24 interface=ether1',
    '### /ip route print detail without-paging', 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC',
    ' 0  Ac dst-address=10.0.0.0/24 routing-table=main gateway=ether1', ' 1  As dst-address=10.97.0.0/16 routing-table=main gateway=10.96.0.1',
    ' 2  As dst-address=10.96.0.0/16 routing-table=main gateway=10.97.0.1', ' 3  As dst-address=10.94.0.0/16 routing-table=main blackhole',
    ' 4  As dst-address=10.95.0.0/16 routing-table=main gateway=10.94.0.1'].join('\n'));
  assert.deepStrictEqual(['R01', 'R03', 'R04'].map((id) => count(s, id)), [0, 1, 1]);
  // 閘道只能靠自己這條路由解析（不在任何直連網段）是無法到達（R01），不是迴圈
  const self = build('W (10.0.0.9):\n### /ip route print detail without-paging\nFlags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC\n 0  As dst-address=0.0.0.0/0 routing-table=main gateway=203.0.113.1\n');
  assert.deepStrictEqual([count(self, 'R01'), count(self, 'R03')], [1, 0]);
  const t = S.trace(S.query(s), '10.0.0.9', '10.94.1.1');
  assert.deepStrictEqual(t.ends.map((e) => e.status), ['blackhole']);
});
test('VRRP 位址標示角色、網段帶出所屬 VLAN；R05 只在閘道不在網段內時回報', () => {
  const s = build(['R (10.0.0.1):', '### /export terse', '/interface vlan add interface=bridge1 name=vlan30 vlan-id=30', '/interface vrrp add interface=vlan30 name=vrrp30 vrid=30',
    '/ip address add address=10.1.30.2/24 interface=vlan30', '/ip address add address=10.1.30.1/32 interface=vrrp30',
    '/ip dhcp-server network add address=10.1.30.0/24 gateway=10.1.30.1', '/ip dhcp-server network add address=10.1.20.0/24 gateway=10.1.21.1'].join('\n'));
  assert.deepStrictEqual(s.model.ipAddresses.map((a) => [a.address, a.role]), [['10.1.30.1/32', 'vrrp'], ['10.1.30.2/24', null]]);
  assert.deepStrictEqual(s.model.prefixes.map((p) => [p.prefix, p.vlan, p.vlans]), [['10.1.30.0/24', 30, [30]]]);
  // 同一網段在不同設備設在不同 VLAN：vlan 不明確（null），vlans 列出全部
  const two = build(['R1 (10.0.0.1):', '### /export terse', '/interface vlan add interface=bridge1 name=vlan30 vlan-id=30', '/ip address add address=10.1.30.2/24 interface=vlan30',
    'R2 (10.0.0.2):', '### /export terse', '/interface vlan add interface=bridge1 name=vlan40 vlan-id=40', '/ip address add address=10.1.30.3/24 interface=vlan40'].join('\n'));
  assert.deepStrictEqual(two.model.prefixes.map((p) => [p.prefix, p.vlan, p.vlans]), [['10.1.30.0/24', null, [30, 40]]]);
  assert.strictEqual(iface(s, 'R|vrrp30').type, 'virtual');
  assert.deepStrictEqual(s.findings.filter((f) => f.id === 'R05').map((f) => f.message), ['R：10.1.20.0/24 的閘道 10.1.21.1 不在網段內']);
});

// ------------------------------------------------------------------ 跨設備組態一致性（同質不同名、同名不同值）
// 兩台交換器以 ether1 互相 LLDP，ether1 tagged VLAN 10（同一個 VLAN 區塊）；linked=false 時沒有鏈路（不同區塊）
const cfgPair = (a, b, linked = true) => {
  const sw = (name, ip, peer, lines) => [`${name} (${ip}):`,
    NB(linked ? [` 0 interface=ether1 mac-address=AA:00:00:00:00:0${peer === 'SW_A' ? 1 : 2} identity=${peer} interface-name=ether1 discovered-by=lldp`] : []),
    '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge port add bridge=bridge1 interface=ether1',
    '/interface bridge vlan add bridge=bridge1 tagged=ether1,bridge1 vlan-ids=10', ...lines].join('\n');
  return build([sw('SW_A', '10.0.0.1', 'SW_B', a), sw('SW_B', '10.0.0.2', 'SW_A', b)].join('\n'));
};
const msgs = (s, id) => s.findings.filter((f) => f.id === id).map((f) => f.message);
const VIF = (name, id, extra = '') => `/interface vlan add interface=bridge1 name=${name} vlan-id=${id}${extra}`;
test('V06：同一 VLAN 區塊內，VLAN 介面名稱、說明不同才列；只比較有該屬性的設備、不分大小寫、不同區塊不比', () => {
  const s = cfgPair([VIF('vlan10', 10, ' comment=MGMT')], [VIF('mgmt', 10, ' comment=mgmt')]);
  assert.deepStrictEqual(msgs(s, 'V06'), ['VLAN 10 的 VLAN 介面名稱：SW_A「vlan10」；SW_B「mgmt」；沒有多數，無法推定']);
  const f = s.findings.find((x) => x.id === 'V06');
  assert.deepStrictEqual(f.entities.map((e) => e.type + ':' + e.key), ['vlan:10', 'interface:SW_A|vlan10', 'interface:SW_B|mgmt']);
  assert.ok(f.evidence.length === 2 && f.evidence.every((e) => e.line > 0));
  assert.deepStrictEqual(msgs(cfgPair([VIF('vlan10', 10, ' comment=MGMT')], [VIF('VLAN10 ', 10)]), 'V06'), [], '名稱不分大小寫；只有一台有說明不比');
  const bv = cfgPair(['/interface bridge vlan add bridge=bridge1 tagged=ether2 vlan-ids=10 comment=prod'], ['/interface bridge vlan add bridge=bridge1 tagged=ether2 vlan-ids=10 comment=office']);
  assert.deepStrictEqual(msgs(bv, 'V06'), ['VLAN 10 的 bridge VLAN 說明：SW_A「prod」；SW_B「office」；沒有多數，無法推定']);
  assert.deepStrictEqual(msgs(cfgPair([VIF('vlan10', 10)], [VIF('mgmt', 10)], false), 'V06'), [], '不同 VLAN 區塊（例如各站點重用 VLAN ID）不比');
});
test('V07：同一名稱或說明在不同設備對應到不同 VLAN ID；同一 ID 不列', () => {
  const s = cfgPair([VIF('mgmt', 10)], [VIF('MGMT', 20)], false);
  assert.deepStrictEqual(msgs(s, 'V07'), ['VLAN 介面名稱「mgmt」：SW_A VLAN 10；SW_B VLAN 20；沒有多數，無法推定']);
  assert.deepStrictEqual(msgs(cfgPair([VIF('vlan10', 10, ' comment=users')], [VIF('vlan30', 30, ' comment=Users')], false), 'V07'), ['VLAN 介面說明「users」：SW_A VLAN 10；SW_B VLAN 30；沒有多數，無法推定']);
  assert.deepStrictEqual(msgs(cfgPair([VIF('mgmt', 10)], [VIF('mgmt', 10)]), 'V07'), []);
});
test('A06：同一 VLAN 區塊內各設備 VLAN 介面的網段不同；同網址不同遮罩會點明；不同區塊不比', () => {
  const ip = (a) => `/ip address add address=${a} interface=vlan10`;
  const s = cfgPair([VIF('vlan10', 10), ip('10.0.10.1/24')], [VIF('vlan10', 10), ip('10.0.20.2/24')]);
  assert.deepStrictEqual(msgs(s, 'A06'), ['VLAN 10：SW_A 10.0.10.0/24；SW_B 10.0.20.0/24；沒有多數，無法推定']);
  assert.ok(s.findings.find((f) => f.id === 'A06').entities.some((e) => e.type === 'interface' && e.key === 'SW_B|vlan10'));
  const m = cfgPair([VIF('vlan10', 10), ip('10.0.10.1/24')], [VIF('vlan10', 10), ip('10.0.10.2/25')]);
  assert.deepStrictEqual(msgs(m, 'A06'), ['VLAN 10：SW_A 10.0.10.0/24；SW_B 10.0.10.0/25（網段重疊但遮罩不同）；沒有多數，無法推定']);
  assert.deepStrictEqual(msgs(cfgPair([VIF('vlan10', 10), ip('10.0.10.1/24')], [VIF('vlan10', 10), ip('10.0.20.2/24')], false), 'A06'), [], '不同區塊不比');
  assert.deepStrictEqual(msgs(cfgPair([VIF('vlan10', 10), ip('10.0.10.1/24')], [VIF('vlan10', 10), ip('10.0.10.2/24')]), 'A06'), []);
});
test('A07：同一網段在不同設備的 VLAN 介面屬於不同 VLAN；非 VLAN 介面不比', () => {
  const s = cfgPair([VIF('vlan10', 10), '/ip address add address=10.0.10.1/24 interface=vlan10'], [VIF('vlan20', 20), '/ip address add address=10.0.10.2/24 interface=vlan20'], false);
  assert.deepStrictEqual(msgs(s, 'A07'), ['10.0.10.0/24：SW_A VLAN 10；SW_B VLAN 20；沒有多數，無法推定']);
  assert.deepStrictEqual(msgs(cfgPair([VIF('vlan10', 10), '/ip address add address=10.0.10.1/24 interface=vlan10'], ['/ip address add address=10.0.10.2/24 interface=ether5']), 'A07'), []);
});
test('A08：重疊網段在不同設備的遮罩不同；同一台設備內、不重疊的網段不列', () => {
  const s = cfgPair(['/ip address add address=10.0.10.1/24 interface=ether5'], ['/ip address add address=10.0.10.2/25 interface=ether5']);
  assert.deepStrictEqual(msgs(s, 'A08'), ['10.0.10.0/24（SW_A）與 10.0.10.0/25（SW_B）；沒有多數，無法推定']);
  assert.deepStrictEqual(s.findings.find((f) => f.id === 'A08').evidence.map((e) => e.line), [8, 16]);
  assert.deepStrictEqual(msgs(cfgPair(['/ip address add address=10.0.10.1/24 interface=ether5', '/ip address add address=10.0.10.129/25 interface=ether6'], []), 'A08'), [], '同一台設備內不列');
  assert.deepStrictEqual(msgs(cfgPair(['/ip address add address=10.0.10.1/24 interface=ether5'], ['/ip address add address=10.0.11.2/25 interface=ether5']), 'A08'), []);
});
test('A09：同一 IP 設定在多台設備；VRRP 虛擬位址、同一台設備重複、鄰居宣告的位址不列', () => {
  const s = cfgPair(['/ip address add address=10.0.10.1/24 interface=ether5'], ['/ip address add address=10.0.10.1/25 interface=ether6']);
  assert.deepStrictEqual(msgs(s, 'A09'), ['10.0.10.1：SW_A ether5、SW_B ether6']);
  assert.ok(s.findings.find((f) => f.id === 'A09').entities.some((e) => e.type === 'ip' && e.key === '10.0.10.1'));
  const vrrp = ['/interface vrrp add interface=ether5 name=vrrp1 vrid=1', '/ip address add address=10.0.10.254/32 interface=vrrp1'];
  assert.deepStrictEqual(msgs(cfgPair(vrrp, vrrp), 'A09'), []);
  assert.deepStrictEqual(msgs(cfgPair(['/ip address add address=10.0.10.1/24 interface=ether5', '/ip address add address=10.0.10.1/24 interface=ether6'], []), 'A09'), []);
});
test('R06：同一 DHCP 網段在不同設備的閘道、DNS、NTP 不同；只比較有設定該項的設備', () => {
  const net = (extra) => [`/ip dhcp-server network add address=10.0.30.0/24 ${extra}`];
  const s = cfgPair(net('gateway=10.0.30.1 dns-server=10.0.10.53'), net('gateway=10.0.30.2 dns-server=10.0.10.53 ntp-server=10.0.10.123'));
  assert.deepStrictEqual(msgs(s, 'R06'), ['10.0.30.0/24 閘道：SW_A 10.0.30.1；SW_B 10.0.30.2；沒有多數，無法推定']);
  const d = cfgPair(net('gateway=10.0.30.1 dns-server=10.0.10.53,10.0.10.54'), net('gateway=10.0.30.1 dns-server=10.0.10.54,10.0.10.53 ntp-server=10.0.10.123'));
  assert.deepStrictEqual(msgs(d, 'R06'), [], '順序不同、只有一台設定 NTP 不列');
  assert.deepStrictEqual(msgs(cfgPair(net('gateway=10.0.30.1'), net('gateway=10.0.30.1 dns-server=10.0.10.53')), 'R06'), []);
});
test('A10：同一選單內同一名稱在不同設備對應到不同 IP（名稱不分大小寫）；集合相同或只有一台不列', () => {
  const al = (list, addr) => `/ip firewall address-list add address=${addr} list=${list}`;
  const s = cfgPair([al('MGMT', '10.0.10.0/24')], [al('mgmt', '10.0.10.0/24'), al('mgmt', '10.0.99.0/24')]);
  assert.deepStrictEqual(msgs(s, 'A10'), ['/ip firewall address-list「MGMT」：SW_A 10.0.10.0/24；SW_B 10.0.10.0/24、10.0.99.0/24；10.0.99.0/24 只在 SW_B；沒有多數，無法推定']);
  const dns = cfgPair(['/ip dns static add address=10.0.0.5 name=nas.lan'], ['/ip dns static add address=10.0.0.6 name=NAS.lan']);
  assert.deepStrictEqual(msgs(dns, 'A10'), ['/ip dns static「nas.lan」：SW_A 10.0.0.5；SW_B 10.0.0.6；10.0.0.5 只在 SW_A；10.0.0.6 只在 SW_B；沒有多數，無法推定']);
  assert.deepStrictEqual(msgs(cfgPair([al('MGMT', '10.0.10.0/24')], [al('MGMT', '10.0.10.0/24')]), 'A10'), []);
  assert.deepStrictEqual(msgs(cfgPair([al('MGMT', '10.0.10.0/24')], [al('OTHER', '10.0.20.0/24')]), 'A10'), []);
});
test('A11：同一選單內同一 IP 在不同設備的名稱完全不同；名稱有交集不列', () => {
  const s = cfgPair(['/ip dns static add address=10.0.0.5 name=nas.lan'], ['/ip dns static add address=10.0.0.5 name=storage.lan']);
  assert.deepStrictEqual(msgs(s, 'A11'), ['/ip dns static 10.0.0.5：SW_A「nas.lan」；SW_B「storage.lan」；沒有多數，無法推定']);
  const al = (list) => `/ip firewall address-list add address=10.0.10.0/24 list=${list}`;
  assert.deepStrictEqual(msgs(cfgPair([al('MGMT'), al('ADMIN')], [al('MGMT')]), 'A11'), [], '某台多一個清單不算');
});
test('A12：有設定 DNS／NTP 伺服器的設備之間不同；順序不同、只有一台設定不列', () => {
  const s = cfgPair(['/ip dns set servers=1.1.1.1,8.8.8.8', '/system ntp client set enabled=yes servers=10.0.0.123'],
    ['/ip dns set servers=8.8.8.8', '/system ntp client set enabled=yes primary-ntp=10.0.0.123 secondary-ntp=0.0.0.0']);
  assert.deepStrictEqual(msgs(s, 'A12'), ['DNS 伺服器：SW_A 1.1.1.1、8.8.8.8；SW_B 8.8.8.8；沒有多數，無法推定']);
  assert.deepStrictEqual(msgs(cfgPair(['/ip dns set servers=1.1.1.1,8.8.8.8'], ['/ip dns set servers=8.8.8.8,1.1.1.1']), 'A12'), []);
  assert.deepStrictEqual(msgs(cfgPair(['/ip dns set servers=1.1.1.1'], []), 'A12'), []);
});
// 三台設備各自只有 /export（不需要鏈路：A08、A12 不分 VLAN 區塊）
const cfgTrio = (a, b, c) => build([['SW_A', '10.0.0.1', a], ['SW_B', '10.0.0.2', b], ['SW_C', '10.0.0.3', c]]
  .map(([n, ip, lines]) => [`${n} (${ip}):`, '### /export terse', ...lines].join('\n')).join('\n'));
test('多數決：最多的一組至少 2 台且多於其他每一組才推定偏離；平手寫明沒有多數；A09 不套用', () => {
  const dns = (v) => [`/ip dns set servers=${v}`];
  const two = cfgTrio(dns('8.8.8.8'), dns('1.1.1.1'), dns('8.8.8.8'));
  assert.deepStrictEqual(msgs(two, 'A12'), ['DNS 伺服器：SW_A、SW_C 8.8.8.8；SW_B 1.1.1.1；依多數推定偏離：SW_B']);
  assert.deepStrictEqual(two.findings.find((f) => f.id === 'A12').deviation, { basis: 'majority', deviating: ['SW_B'] });
  const tie = cfgTrio(dns('8.8.8.8'), dns('1.1.1.1'), dns('9.9.9.9'));
  assert.ok(msgs(tie, 'A12')[0].endsWith('；沒有多數，無法推定'), '1 對 1 對 1 平手');
  assert.deepStrictEqual(tie.findings.find((f) => f.id === 'A12').deviation, { basis: 'majority', deviating: [] });
  const pair = cfgPair(dns('8.8.8.8'), dns('1.1.1.1'));
  assert.deepStrictEqual(pair.findings.find((f) => f.id === 'A12').deviation, { basis: 'majority', deviating: [] }, '1 對 1 平手');
  // A08：同一台設定多個網段時，以網段組合當成它的設定值
  const ipa = (c, ifc = 'ether5') => `/ip address add address=${c} interface=${ifc}`;
  const a08 = cfgTrio([ipa('10.0.10.1/24'), ipa('10.0.10.129/25', 'ether6')], [ipa('10.0.10.2/24')], [ipa('10.0.10.3/24')]);
  const f08 = a08.findings.find((f) => f.id === 'A08');
  assert.ok(f08.message.endsWith('；依多數推定偏離：SW_A'), f08.message);
  assert.deepStrictEqual(f08.deviation, { basis: 'majority', deviating: ['SW_A'] });
  const a09 = cfgPair([ipa('10.0.10.1/24')], [ipa('10.0.10.1/24', 'ether6')]).findings.find((f) => f.id === 'A09');
  assert.ok(a09 && !('deviation' in a09) && !a09.message.includes('多數'), 'A09 重複 IP 本身就是衝突，不套用多數決');
});
test('多數決：範例資料中 A06 推定 TPE_ACC_SW_10 偏離，A12 兩台核心沒有多數', () => {
  const s = build(read('samples/sample-bundle.txt'));
  const a06 = s.findings.find((f) => f.id === 'A06');
  assert.ok(a06.message.endsWith('（網段重疊但遮罩不同）；依多數推定偏離：TPE_ACC_SW_10'), a06.message);
  assert.deepStrictEqual(a06.deviation, { basis: 'majority', deviating: ['TPE_ACC_SW_10'] });
  const a12 = s.findings.find((f) => f.id === 'A12');
  assert.strictEqual(a12.message, 'DNS 伺服器：TPE_CORE_RT_01 1.1.1.1、8.8.8.8；TPE_CORE_RT_02 8.8.8.8；沒有多數，無法推定');
  assert.deepStrictEqual(a12.deviation, { basis: 'majority', deviating: [] });
  const withDev = ['V06', 'V07', 'A06', 'A07', 'A08', 'A10', 'A11', 'A12', 'R06'];
  s.findings.forEach((f) => assert.strictEqual('deviation' in f, withDev.includes(f.id), `${f.id} 的 deviation 欄位`));
});

// ------------------------------------------------------------------ 推論鏈路（沒有 LLDP 時）
// CSS610 等 SwOS 交換器不支援 LLDP、也無法用 SSH 收集，只送 MNDP；測試資料依 RouterOS 鄰居表與 MAC 表格式撰寫
const NB = (rows) => ['### /ip neighbor print detail without-paging', ...rows].join('\n');
const BH = (rows) => ['### /interface bridge host print detail without-paging', 'Flags: D - dynamic, L - local', ...rows].join('\n');
const inferred = (s) => s.model.inferredLinks.map((l) => [l.a, l.b, l.bases.join('+'), l.confidence]);
test('推論鏈路：CSS610（只送 MNDP、未收集）接在 RouterOS 交換器下 → MNDP 唯一＋MAC 表，信心高', () => {
  const s = build(['SW_A (10.0.0.1):',
    NB([' 0 interface=ether5,bridge1 mac-address=CC:2D:E0:00:00:01 identity=CSS_1 platform=MikroTik board="CSS610-8P-2S+" discovered-by=mndp']),
    BH([' 0 DL mac-address=D4:01:C3:00:00:0A on-interface=bridge1 bridge=bridge1', ' 1 D mac-address=CC:2D:E0:00:00:01 on-interface=ether5 bridge=bridge1',
      ' 2 D mac-address=24:6E:96:00:00:01 on-interface=ether5 bridge=bridge1', ' 3 D mac-address=24:6E:96:00:00:02 on-interface=ether5 bridge=bridge1'])].join('\n'));
  assert.deepStrictEqual(s.model.devices.find((d) => d.key === 'SW_A').ownMacs, ['D401C300000A'], 'MAC 表的 L 項目保留為設備自己的 MAC');
  assert.deepStrictEqual(inferred(s), [['CSS_1|?(sw_a:ether5)', 'SW_A|ether5', 'fdb+mndp-unique', 'high']]);
  assert.strictEqual(s.model.links.length, 1, '推論鏈路不寫進 links');
});
test('推論鏈路：CSS610 夾在兩台 RouterOS 之間 → 各自推論到 CSS610，不誤判兩台直連', () => {
  const s = build(['SW_A (10.0.0.1):',
    NB([' 0 interface=ether5 mac-address=CC:2D:E0:00:00:01 identity=CSS_1 board="CSS610-8P-2S+" discovered-by=mndp', ' 1 interface=ether5 mac-address=D4:01:C3:00:00:0B identity=SW_B discovered-by=mndp interface-name=ether1']),
    BH([' 0 DL mac-address=D4:01:C3:00:00:0A on-interface=bridge1', ' 1 D mac-address=CC:2D:E0:00:00:01 on-interface=ether5', ' 2 D mac-address=D4:01:C3:00:00:0B on-interface=ether5']),
    'SW_B (10.0.0.2):',
    NB([' 0 interface=ether1 mac-address=CC:2D:E0:00:00:01 identity=CSS_1 board="CSS610-8P-2S+" discovered-by=mndp', ' 1 interface=ether1 mac-address=D4:01:C3:00:00:0A identity=SW_A discovered-by=mndp interface-name=ether5']),
    BH([' 0 DL mac-address=D4:01:C3:00:00:0B on-interface=bridge1', ' 1 D mac-address=CC:2D:E0:00:00:01 on-interface=ether1', ' 2 D mac-address=D4:01:C3:00:00:0A on-interface=ether1'])].join('\n'));
  assert.deepStrictEqual(inferred(s), [['CSS_1|?(sw_a:ether5)', 'SW_A|ether5', 'fdb', 'medium'], ['CSS_1|?(sw_b:ether1)', 'SW_B|ether1', 'fdb', 'medium']]);
});
test('推論鏈路：CSS106 在中間、下面接兩台 RouterOS 交換器與一台沒有 bridge 的路由器（同一個 /24）', () => {
  // MNDP 會被 CSS106 轉送，所以每台都看到全部鄰居（MNDP 唯一不成立），只能靠 MAC 表
  const mn = (ifc, rows) => NB(rows.map(([id, m], k) => ` ${k} interface=${ifc} mac-address=${m} identity=${id} discovered-by=mndp`));
  const CSS = ['CSS_9', 'CC:2D:E0:00:00:09']; const A = ['SW_A', 'D4:01:C3:00:00:0A']; const B = ['SW_B', 'D4:01:C3:00:00:0B']; const R = ['R_C', 'D4:01:C3:00:00:0C'];
  const s = build(['SW_A (10.0.0.1):', mn('ether5', [CSS, B, R]), '### /export terse', '/interface bridge add name=bridge1',
    BH([' 0 DL mac-address=D4:01:C3:00:00:0A on-interface=bridge1', ' 1 D mac-address=CC:2D:E0:00:00:09 on-interface=ether5', ' 2 D mac-address=D4:01:C3:00:00:0B on-interface=ether5', ' 3 D mac-address=D4:01:C3:00:00:0C on-interface=ether5']),
    'SW_B (10.0.0.2):', mn('ether1', [CSS, A, R]), '### /export terse', '/interface bridge add name=bridge1',
    BH([' 0 DL mac-address=D4:01:C3:00:00:0B on-interface=bridge1', ' 1 D mac-address=CC:2D:E0:00:00:09 on-interface=ether1', ' 2 D mac-address=D4:01:C3:00:00:0A on-interface=ether1', ' 3 D mac-address=D4:01:C3:00:00:0C on-interface=ether1']),
    'R_C (10.0.0.3):', mn('ether2', [CSS, A, B]), '### /interface print detail without-paging', ' 0 R name="ether2" type="ether" mac-address=D4:01:C3:00:00:0C mtu=1500',
    '### /export terse', '/ip address add address=10.0.0.3/24 interface=ether2'].join('\n'));
  assert.deepStrictEqual(inferred(s), [
    ['CSS_9|?(r_c:ether2)', 'R_C|ether2', 'fdb', 'medium'], ['CSS_9|?(sw_a:ether5)', 'SW_A|ether5', 'fdb', 'medium'], ['CSS_9|?(sw_b:ether1)', 'SW_B|ether1', 'fdb', 'medium'],
  ], '每台都推論接到 CSS_9，兩台交換器之間、交換器與路由器之間都不誤判直連');
});
test('推論鏈路：CSS106 底下沒有終端（MAC 表只剩它自己）時，上行埠不算終端埠，圖上不重複畫成未知對端', () => {
  const css = ' 0 interface=ether5 mac-address=CC:2D:E0:00:01:06 identity=CSS106_1 board="CSS106-1G-4P-1S" discovered-by=mndp';
  const s = build(['SW_A (10.0.0.1):', NB([css]), BH([' 0 DL mac-address=D4:01:C3:00:00:0A on-interface=bridge1', ' 9 D mac-address=CC:2D:E0:00:01:06 on-interface=ether5'])].join('\n'));
  assert.deepStrictEqual(s.model.inferredLinks.map((l) => [l.a, l.b]), [['CSS106_1|?(sw_a:ether5)', 'SW_A|ether5']]);
  const i = iface(s, 'SW_A|ether5');
  assert.strictEqual(i.edge, false); assert.strictEqual(i.unknownPeer, false);
});
test('推定位置：CSS106 底下的終端（埠不明）；串接兩台未收集交換器時不指定哪一台；在已收集交換器後面的不算；A04 不再誤報', () => {
  const css106 = ' 0 interface=ether5 mac-address=CC:2D:E0:00:01:06 identity=CSS106_1 board="CSS106-1G-4P-1S" discovered-by=mndp';
  const hosts = (ifc, n, base) => Array.from({ length: n }, (_, k) => ` ${k + 1} D mac-address=24:6E:96:00:${base}:${String(k + 1).padStart(2, '0')} on-interface=${ifc}`);
  const one = build(['SW_A (10.0.0.1):', NB([css106]), BH([' 0 DL mac-address=D4:01:C3:00:00:0A on-interface=bridge1', ' 9 D mac-address=CC:2D:E0:00:01:06 on-interface=ether5', ...hosts('ether5', 7, '01')])].join('\n'));
  const b = (mk) => one.model.macs.find((m) => m.mac === mk).behind;
  assert.deepStrictEqual(b('246E96000101'), { anchor: 'SW_A|ether5', via: ['CSS106_1'], dev: 'CSS106_1', basis: 'fdb' });
  assert.strictEqual(b('CC2DE0000106'), null, '交換器自己的 MAC 不是終端');
  assert.strictEqual(count(one, 'A04'), 0, '埠後面是已知的 CSS106，不報 A04');
  const chain = build(['SW_A (10.0.0.1):', NB([css106, ' 1 interface=ether5 mac-address=CC:2D:E0:00:06:10 identity=CSS610_1 board="CSS610-8P-2S+" discovered-by=mndp']),
    BH([' 9 D mac-address=CC:2D:E0:00:01:06 on-interface=ether5', ' 8 D mac-address=CC:2D:E0:00:06:10 on-interface=ether5', ...hosts('ether5', 2, '02')])].join('\n'));
  assert.deepStrictEqual(chain.model.macs.find((m) => m.mac === '246E96000201').behind, { anchor: 'SW_A|ether5', via: ['CSS106_1', 'CSS610_1'], dev: null, basis: 'fdb' });
  const behindB = build(['SW_A (10.0.0.1):', NB([css106]), BH([' 9 D mac-address=CC:2D:E0:00:01:06 on-interface=ether5', ' 8 D mac-address=D4:01:C3:00:00:0B on-interface=ether5', ...hosts('ether5', 2, '03')]),
    'SW_B (10.0.0.2):', BH([' 0 DL mac-address=D4:01:C3:00:00:0B on-interface=bridge1', ' 9 D mac-address=D4:01:C3:00:00:0A on-interface=ether1', ...hosts('ether3', 2, '03')])].join('\n'));
  assert.strictEqual(behindB.model.macs.find((m) => m.mac === '246E96000301').behind, null, 'SW_B 在非朝向 SW_A 的埠學到 → 在 SW_B 後面，不是 CSS106 底下');
});
// RSTP 的 monitor 輸出依手冊欄位撰寫（欄式：每行 key: 值1 值2…），不是實機擷取
const STP = (rows) => ['### /interface bridge port monitor [find] once', ...rows].join('\n');
test('RSTP：欄式 monitor 輸出（RouterOS 7／6 欄位名稱）、bridge 自己的 MAC', () => {
  const s = build(['SW_A (10.0.0.1):', STP(['              interface: ether1                      ether5                      ether7',
    '                   role: root-port                   designated-port             alternate-port',
    '              edge-port: no                          no                          no',
    '   designated-bridge-id: 0x8000.CC:2D:E0:00:01:06    0x8000.D4:01:C3:00:00:0A    0x8000.CC:2D:E0:00:01:06',
    '     designated-port-id: 0x80.3                      0x80.5                      0x80.4',
    '                port-id: 0x80.1                      0x80.5                      0x80.7']),
    '### /interface bridge monitor [find] once', '                   name: bridge1', '    current-mac-address: D4:01:C3:00:00:0A', '         root-bridge-id: 0x8000.CC:2D:E0:00:00:01',
    'R6 (10.0.0.2):', '### /interface bridge port monitor [find] once', '      interface: ether2', '           role: root-port', '  designated-bridge: 0x8000.D4:01:C3:00:00:0A', '  designated-port-number: 5'].join('\n'));
  assert.deepStrictEqual(['SW_A|ether1', 'SW_A|ether5', 'R6|ether2'].map((k) => { const x = iface(s, k).stp; return [x.role, x.designatedBridge, x.designatedPort]; }),
    [['root-port', 'CC2DE0000106', 3], ['designated-port', 'D401C300000A', 5], ['root-port', 'D401C300000A', 5]]);
  assert.ok(s.model.devices.find((d) => d.key === 'SW_A').ownMacs.includes('D401C300000A'), 'bridge 的 current-mac-address 是設備自己的 MAC');
  assert.ok(!ids(s).includes('I01'));
});
test('推論鏈路（RSTP）：CSS106 是上游時，RouterOS 的 root／alternate 埠指向它；兩台都收集時對回確切的埠；指定埠、不明 MAC 不推論', () => {
  const css = NB([' 0 interface=ether1 mac-address=CC:2D:E0:00:01:06 identity=CSS106_1 board="CSS106-1G-4P-1S" discovered-by=mndp']);
  const up = build(['SW_A (10.0.0.1):', css, STP(['  interface: ether1      ether9', '       role: root-port   alternate-port',
    '  designated-bridge-id: 0x8000.CC:2D:E0:00:01:06  0x8000.AA:AA:AA:00:00:99'])].join('\n'));
  assert.deepStrictEqual(inferred(up), [['CSS106_1|?(sw_a:ether1)', 'SW_A|ether1', 'mndp-unique+stp', 'high']], 'STP 指向 CSS106、MNDP 也唯一 → 信心高；ether9 的指定橋接器不是已知設備，不推論');
  const pair = build(['SW_A (10.0.0.1):', STP(['  interface: ether5', '  role: designated-port', '  designated-bridge-id: 0x8000.D4:01:C3:00:00:0A', '  port-id: 0x80.5']),
    '### /interface bridge monitor [find] once', '  name: bridge1', '  current-mac-address: D4:01:C3:00:00:0A',
    'SW_B (10.0.0.2):', STP(['  interface: ether2', '  role: root-port', '  designated-bridge-id: 0x8000.D4:01:C3:00:00:0A', '  designated-port-id: 0x80.5'])].join('\n'));
  assert.deepStrictEqual(inferred(pair), [['SW_A|ether5', 'SW_B|ether2', 'stp', 'medium']], 'designated-port-id 對回 SW_A 的 ether5（port-id 5）');
});
test('設備對：證據強度依序為介面鄰接、單側觀察、推論、只有 MNDP；每條鏈路與推論鏈路都屬於一對設備', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s); const pairs = Q.devicePairs();
  const of = (p) => p.links.map((k) => Q.getLink(k));
  pairs.forEach((p) => {
    const ls = of(p); const ifl = ls.filter((l) => l.evidenceScope !== S.LINK_SCOPE.BROADCAST_DOMAIN);
    const want = ifl.some((l) => !l.hearsay) ? 'adjacency' : ifl.length ? 'hearsay' : p.inferred.length ? 'inferred' : 'domainOnly';
    assert.strictEqual(p.evidence, want, p.id);
  });
  assert.strictEqual(pairs.reduce((n, p) => n + p.links.length, 0), Q.links().length);
  assert.strictEqual(pairs.reduce((n, p) => n + p.inferred.length, 0), Q.inferredLinks().length);
  assert.ok(pairs.some((p) => p.evidence === 'inferred') && pairs.some((p) => p.evidence === 'hearsay') && pairs.some((p) => p.evidence === 'adjacency'));
  // VLAN：推論鏈路在已收集端帶這個 VLAN 時列入 vlan().inferred
  const css = ' 0 interface=ether5 mac-address=CC:2D:E0:00:01:06 identity=CSS106_1 board="CSS106-1G-4P-1S" discovered-by=mndp';
  const v = S.query(build(['SW_A (10.0.0.1):', NB([css]), '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge port add bridge=bridge1 interface=ether5',
    '/interface bridge vlan add bridge=bridge1 tagged=ether5 vlan-ids=20',
    BH([' 0 DL mac-address=D4:01:C3:00:00:0A on-interface=bridge1', ' 1 D mac-address=CC:2D:E0:00:01:06 on-interface=ether5'])].join('\n')));
  assert.strictEqual(v.inferredLinks().length, 1);
  assert.deepStrictEqual(v.vlan(20).inferred, v.inferredLinks()); assert.deepStrictEqual(v.vlan(30).inferred, []);
});
test('推定位置與推論鏈路對回同一段路徑：終端經由哪條推論鏈路、推論鏈路後面有哪些終端', () => {
  const Q = S.query(build(read('samples/sample-bundle.txt')));
  const behind = Q.snapshot.model.macs.filter((x) => x.behind); assert.ok(behind.length);
  behind.forEach((x) => {
    const via = Q.behindVia(x.mac); assert.strictEqual(via.length, 1, x.mac);
    assert.ok([via[0].a, via[0].b].includes(x.behind.anchor), '推論鏈路的本端就是錨點埠');
    assert.ok([via[0].a, via[0].b].some((ep) => S.keys.splitEp(ep)[0] === x.behind.dev), '推論鏈路的對端就是推定所在的設備');
    assert.ok(Q.behindUnder(via[0].key).includes(x));
  });
  assert.deepStrictEqual(Q.behindVia('000000000000'), []);
});
test('檢查規則狀態：有發現、通過（需要的資料有收到）、沒有資料可檢查（列出缺少的資料）', () => {
  Object.entries(S.check.CATALOG).forEach(([id, c]) => (c.data || []).flat().forEach((t) => assert.ok(S.check.DATA_LABEL[t], `${id} 需要的資料類別 ${t} 沒有名稱`)));
  const Q = S.query(build('SW_A (10.0.0.1):\n' + NB([' 0 interface=ether1 mac-address=D4:01:C3:00:00:0B identity=SW_B interface-name=ether2 discovered-by=lldp'])));
  const st = new Map(Q.ruleStatus().map((r) => [r.id, r]));
  assert.strictEqual(st.size, Object.keys(S.check.CATALOG).length);
  assert.strictEqual(st.get('K02').status, 'pass', '有鄰居資料、沒有發現 → 通過');
  assert.strictEqual(st.get('R03').status, 'nodata', '沒有路由表 → 沒有資料可檢查');
  assert.deepStrictEqual(st.get('R03').missing, [['route']]);
  assert.strictEqual(st.get('I01').status, 'pass', '輸入類規則一律會檢查');
  Q.ruleStatus().forEach((r) => assert.strictEqual(r.status === 'found', r.count > 0, r.id));
  const ids = Q.ruleStatus().map((r) => r.id); assert.deepStrictEqual(ids, ids.slice().sort(S.util.natural), '依規則編號排序');
  const sample = S.query(build(read('samples/sample-bundle.txt'))).ruleStatus();
  assert.ok(sample.some((r) => r.status === 'found') && !sample.some((r) => r.status === 'nodata'), '範例資料每類資料都有收集');
});
test('推論鏈路合併：成員埠歸到聚合、不明埠代號一致、VLAN 介面上的 /30 併到唯一的實體鏈路', () => {
  // CSS106 接在 SW_A 的 bond1（ether1＋ether2）：MNDP 在成員埠、MAC 表與 RSTP 在 bond1 → 合併成一筆
  const lag = build(['SW_A (10.0.0.1):', '### /export terse', '/interface bonding add name=bond1 slaves=ether1,ether2',
    NB([' 0 interface=ether1 mac-address=CC:2D:E0:00:01:06 identity=CSS106_1 board="CSS106-1G-4P-1S" discovered-by=mndp']),
    BH([' 0 DL mac-address=D4:01:C3:00:00:0A on-interface=bridge1', ' 1 D mac-address=CC:2D:E0:00:01:06 on-interface=bond1']),
    STP(['  interface: bond1', '       role: root-port', '  designated-bridge-id: 0x8000.CC:2D:E0:00:01:06'])].join('\n'));
  assert.deepStrictEqual(inferred(lag), [['CSS106_1|?(sw_a:bond1)', 'SW_A|bond1', 'fdb+mndp-unique+stp', 'high']]);
  const LQ = S.query(lag);
  assert.deepStrictEqual(LQ.inferredLinksOfEp('SW_A|ether2').map((l) => l.key), LQ.inferredLinks().map((l) => l.key), '查成員埠也找得到記在聚合上的推論鏈路');
  assert.deepStrictEqual(LQ.devicePairs().map((p) => [p.id, p.evidence, p.links.length, p.inferred.length]), [['CSS106_1~SW_A', 'inferred', 1, 1]], 'MNDP 與推論鏈路併成一對設備，以推論樣式呈現');
  // 兩台已收集路由器：/30 在 vlan99 上、MAC 表在 ether3／ether4 → 併成一筆實體鏈路
  const l3 = build(['R1 (10.0.0.1):', '### /export terse', '/interface vlan add interface=ether3 name=vlan99 vlan-id=99', '/ip address add address=10.9.9.1/30 interface=vlan99',
    BH([' 0 DL mac-address=D4:01:C3:00:00:01 on-interface=bridge1', ' 1 D mac-address=D4:01:C3:00:00:02 on-interface=ether3']),
    'R2 (10.0.0.2):', '### /export terse', '/interface vlan add interface=ether4 name=vlan99 vlan-id=99', '/ip address add address=10.9.9.2/30 interface=vlan99',
    BH([' 0 DL mac-address=D4:01:C3:00:00:02 on-interface=bridge1', ' 1 D mac-address=D4:01:C3:00:00:01 on-interface=ether4'])].join('\n'));
  assert.deepStrictEqual(inferred(l3), [['R1|ether3', 'R2|ether4', 'fdb+subnet-p2p', 'high']]);
});
test('推論鏈路：/30 點對點網段、MNDP 雙向；兩台設備已有 LLDP 鏈路或埠已有 LLDP 鄰接時不推論', () => {
  const p2p = build('R1 (10.0.0.1):\n### /export terse\n/ip address add address=10.9.9.1/30 interface=ether1\nR2 (10.0.0.2):\n### /export terse\n/ip address add address=10.9.9.2/30 interface=ether2\n');
  assert.deepStrictEqual(inferred(p2p), [['R1|ether1', 'R2|ether2', 'subnet-p2p', 'medium']]);
  const mutual = build(['SW_A (10.0.0.1):', NB([' 0 interface=ether3 mac-address=D4:01:C3:00:00:0B identity=SW_B discovered-by=mndp interface-name=ether4']),
    'SW_B (10.0.0.2):', NB([' 0 interface=ether4 mac-address=D4:01:C3:00:00:0A identity=SW_A discovered-by=mndp interface-name=ether3'])].join('\n'));
  assert.deepStrictEqual(inferred(mutual), [], 'MNDP 只證明 L2 可達，只有 MNDP 證據時不成立推論鏈路');
  const corroborated = build(['SW_A (10.0.0.1):', '### /export terse', '/ip address add address=10.9.9.1/31 interface=ether3',
    NB([' 0 interface=ether3 mac-address=D4:01:C3:00:00:0B identity=SW_B discovered-by=mndp interface-name=ether4']),
    'SW_B (10.0.0.2):', '### /export terse', '/ip address add address=10.9.9.0/31 interface=ether4',
    NB([' 0 interface=ether4 mac-address=D4:01:C3:00:00:0A identity=SW_A discovered-by=mndp interface-name=ether3'])].join('\n'));
  assert.deepStrictEqual(inferred(corroborated), [['SW_A|ether3', 'SW_B|ether4', 'mndp-mutual+subnet-p2p', 'high']], 'MNDP 雙向可佐證其他證據，提高信心');
  const lldp = build(['R1 (10.0.0.1):', '### /export terse', '/ip address add address=10.9.9.1/30 interface=ether1',
    NB([' 0 interface=ether1 mac-address=D4:01:C3:00:00:0B identity=R2 discovered-by=lldp interface-name=ether2']),
    BH([' 0 D mac-address=CC:2D:E0:00:00:01 on-interface=ether1']),
    'R2 (10.0.0.2):', '### /export terse', '/ip address add address=10.9.9.2/30 interface=ether2',
    NB([' 0 interface=ether2 mac-address=D4:01:C3:00:00:0A identity=R1 discovered-by=lldp interface-name=ether1', ' 1 interface=ether3 mac-address=CC:2D:E0:00:00:01 identity=CSS_1 discovered-by=mndp'])].join('\n'));
  assert.deepStrictEqual(inferred(lldp).filter((l) => l[0].startsWith('R')), [], '已有 LLDP 鏈路的設備對不推論');
  assert.ok(!inferred(lldp).some((l) => l[1] === 'R1|ether1'), 'R1 ether1 已有 LLDP 鄰接到已收集設備，後面的 CSS_1 不推論為直接相連');
});

// ------------------------------------------------------------------ OUI 廠商
test('OUI：取最長符合的前綴（MA-S 9 碼 → MA-M 7 碼 → MA-L 6 碼），並記錄資料來源', () => {
  const p = S.data.ouiPacked; const vendors = p.vendors.split('|');
  const v6 = new Map(p.entries.split(',').map((e) => [e.slice(0, 6), vendors[parseInt(e.slice(6), 36)]]));
  [[7, p.entries7], [9, p.entries9]].forEach(([len, packed]) => {
    const e = packed.split(',')[0]; const prefix = e.slice(0, len); const want = vendors[parseInt(e.slice(len), 36)];
    assert.strictEqual(S.oui.lookup((prefix + '000000').slice(0, 12)), want, `${len} 碼前綴 ${prefix} 應查到 ${want}`);
    assert.strictEqual(v6.get(prefix.slice(0, 6)), 'IEEE Registration Authority', '細分區塊的 6 碼前綴登記為 IEEE，不能拿來當廠商');
  });
  assert.strictEqual(S.oui.lookup('3C5AB4000001'), 'Google');
  assert.strictEqual(S.oui.lookup('020000000001'), '本機管理位址');
  assert.ok(/^oui-data@\d+\.\d+\.\d+/.test(S.oui.source()), S.oui.source());
});

// ------------------------------------------------------------------ Wi-Fi 關聯表與位置
// 測試資料依 RouterOS 手冊的欄位撰寫（/interface wifi｜wireless registration-table、/caps-man registration-table），不是實機擷取
const WIFI7 = ['AP_1 (10.0.0.11):', '### /interface wifi registration-table print detail without-paging', 'Flags: A - AUTHORIZED',
  ' 0 A interface=wifi1 ssid="Corp" mac-address=AA:BB:CC:00:10:01 uptime=1h2m3s last-activity=120ms signal=-58 band=5ghz-ax',
  '     auth-type=wpa2-eap eap-identity="alice@corp" eap-username="alice" vlan-id=30 dhcp-address=10.1.30.11 dhcp-hostname="alice-nb"'].join('\n');
test('Wi-Fi 關聯表（RouterOS 7）：續行、時間與訊號、DHCP 主機名；帳號欄位不寫進基準', () => {
  const s = build(WIFI7);
  assert.deepStrictEqual(s.model.wifiAssociations.map((a) => [a.ep, a.mac, a.ssid, a.band, a.vlan, a.uptime, a.lastActivity, a.signal, a.ip, a.hostname]),
    [['AP_1|wifi1', 'AABBCC001001', 'Corp', '5ghz-ax', 30, 3723, 0.12, -58, '10.1.30.11', 'alice-nb']]);
  assert.ok(!/alice@corp|"alice"/.test(JSON.stringify(s)), 'eap-identity／eap-username 不可進入基準');
  const w = s.model.macs.find((m) => m.mac === 'AABBCC001001').wifi;
  assert.deepStrictEqual([w.basis, w.dev, w.ep, w.ssid, w.roaming], ['registration', 'AP_1', 'AP_1|wifi1', 'Corp', false]);
  assert.deepStrictEqual([iface(s, 'AP_1|wifi1').type, iface(s, 'AP_1|wifi1').typeBasis], ['wireless', 'assoc']);
  assert.ok(s.model.devices.find((d) => d.key === 'AP_1').data.includes('wifireg'));
  assert.ok(!ids(s).includes('I01'));
});
test('Wi-Fi 關聯表（舊版 wireless、CAPsMAN）：signal-strength、last-ip；略過 ap=yes 的對端 AP', () => {
  const s = build(['AP_2 (10.0.0.12):', '### /interface wireless registration-table print detail without-paging',
    ' 0 interface=wlan1 mac-address=AA:BB:CC:00:10:02 ap=no wds=no signal-strength=-62dBm@6Mbps uptime=2m last-activity=1s last-ip=10.1.30.12',
    ' 1 interface=wlan1 mac-address=AA:BB:CC:00:10:0F ap=yes wds=no signal-strength=-50dBm@6Mbps uptime=1d last-activity=0ms',
    'CAPSMAN (10.0.0.13):', '### /caps-man registration-table print detail without-paging',
    ' 0 interface=cap1 ssid="Guest" mac-address=AA:BB:CC:00:10:04 rx-signal=-70 uptime=5m last-ip=10.1.40.5'].join('\n'));
  assert.deepStrictEqual(s.model.wifiAssociations.map((a) => [a.ep, a.mac, a.signal, a.ip, a.ssid, a.lastActivity]),
    [['AP_2|wlan1', 'AABBCC001002', -62, '10.1.30.12', null, 1], ['CAPSMAN|cap1', 'AABBCC001004', -70, '10.1.40.5', 'Guest', null]]);
});
test('Wi-Fi 漫遊：多台 AP 的關聯表都有同一 MAC 時取 last-activity 最近者，其餘列為候選', () => {
  const s = build(WIFI7.replace('last-activity=120ms', 'last-activity=5s') + '\n' + ['AP_2 (10.0.0.12):', '### /interface wifi registration-table print detail without-paging',
    ' 0 A interface=wifi2 ssid="Corp" mac-address=AA:BB:CC:00:10:01 uptime=10s last-activity=200ms signal=-61 band=5ghz-ax'].join('\n'));
  const w = s.model.macs.find((m) => m.mac === 'AABBCC001001').wifi;
  assert.deepStrictEqual([w.basis, w.ep, w.candidates, w.roaming], ['registration', 'AP_2|wifi2', ['AP_1|wifi1'], true]);
});
test('Wi-Fi 關聯表：沒有客戶端（只有說明行）記為已收集；指令不存在的錯誤回應列為 I01', () => {
  const empty = build('AP_1 (10.0.0.11):\n### /interface wifi registration-table print detail without-paging\nFlags: A - AUTHORIZED\n');
  assert.ok(!ids(empty).includes('I01'));
  assert.ok(empty.model.devices[0].data.includes('wifireg'));
  const bad = build('SW_A (10.0.0.1):\n### /interface wifi registration-table print detail without-paging\nbad command name registration-table (line 1 column 16)\n');
  assert.ok(ids(bad).includes('I01'));
});
test('Wi-Fi 位置推定：無線介面的 MAC 表、經由 AP 的交換器埠；有線終端與 AP 自己的 MAC 不套用', () => {
  const ap = build(['AP_1 (10.0.0.11):', '### /interface print detail without-paging', ' 0 R name="wifi1" type="wifi" mtu=1500',
    '### /interface bridge host print detail without-paging', ' 0 D mac-address=AA:BB:CC:00:20:01 on-interface=wifi1 bridge=bridge1 vid=0'].join('\n'));
  assert.deepStrictEqual(Object.values(ap.model.macs.find((m) => m.mac === 'AABBCC002001').wifi).slice(0, 3), ['bridge-wifi', 'AP_1', 'AP_1|wifi1']);
  const sw = build(['SW_A (10.0.0.1):', '### /ip neighbor print detail without-paging',
    ' 0 interface=ether5 mac-address=AA:BB:CC:00:00:A9 identity=AP_9 platform=MikroTik board="cAP ac" interface-name=ether1 system-caps-enabled=bridge,wlan-ap',
    '### /interface bridge host print detail without-paging',
    ' 0 D mac-address=AA:BB:CC:00:00:A9 on-interface=ether5 bridge=bridge1 vid=0', ' 1 D mac-address=AA:BB:CC:00:20:02 on-interface=ether5 bridge=bridge1 vid=0',
    ' 2 D mac-address=AA:BB:CC:00:20:03 on-interface=ether6 bridge=bridge1 vid=0', ' 3 D mac-address=AA:BB:CC:00:20:03 on-interface=ether5 bridge=bridge1 vid=0'].join('\n'));
  const wifi = (mk) => sw.model.macs.find((m) => m.mac === mk).wifi;
  assert.deepStrictEqual([wifi('AABBCC002002').basis, wifi('AABBCC002002').dev, wifi('AABBCC002002').ep], ['via-ap-port', 'AP_9', 'SW_A|ether5']);
  assert.strictEqual(wifi('AABBCC0000A9'), null, 'AP 自己的 MAC 不是 Wi-Fi 客戶端');
  assert.strictEqual(wifi('AABBCC002003'), null, '同時是有線終端埠（ether6）的 MAC，即使也出現在 AP 埠也不推定為 Wi-Fi');
});

// ------------------------------------------------------------------ 查詢、追蹤、比對
test('查詢：MAC、IP、VLAN、設備、介面描述', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  const srv = s.model.macs.find((m) => m.vendor === 'Dell' && m.edge.length === 1);
  const mac = Q.findMac(S.keys.macPretty(srv.mac));
  assert.ok(mac.found && mac.edge.length === 1 && mac.ips.length === 1);
  assert.ok(Q.findMac('aa:aa:aa:aa:aa:aa').found === false);
  const ip = Q.findIp('10.1.20.11');
  assert.ok(ip.locations.length >= 1, JSON.stringify(ip.locations));
  // 範例另有 ACC_11 的 VLAN 40 刻意設在同一網段（A07），所以只檢查兩台核心的 VLAN 20 都在
  assert.ok(['TPE_CORE_RT_01|vlan20', 'TPE_CORE_RT_02|vlan20'].every((ep) => ip.subnets.some((x) => x.ep === ep)), JSON.stringify(ip.subnets));
  assert.ok(Q.vlan(30).partial.length === 1);
  assert.strictEqual(Q.search('core_rt')[0].type, 'device');
  assert.ok(Q.search('to TPE_ACC_SW_01').some((r) => r.type === 'interface'));
});
test('VLAN 區塊：同一個 VLAN ID 依承載此 VLAN 的鏈路分成不相連區塊，MNDP 不算相連', () => {
  const sw = (name, ip, nb) => [`${name} (${ip}):`, NB(nb), '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes',
    '/interface bridge port add bridge=bridge1 interface=ether1', '/interface bridge port add bridge=bridge1 interface=ether2',
    '/interface bridge vlan add bridge=bridge1 tagged=ether1 untagged=ether2 vlan-ids=10'].join('\n');
  const Q = S.query(build([
    sw('SW_A', '10.0.0.1', [' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=SW_B interface-name=ether1 discovered-by=lldp']),
    sw('SW_B', '10.0.0.2', [' 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=SW_A interface-name=ether1 discovered-by=lldp']),
    sw('SW_C', '10.0.0.3', [' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=SW_B interface-name=ether2 discovered-by=mndp']),
  ].join('\n')));
  const v = Q.vlan(10);
  assert.deepStrictEqual(v.devices, ['SW_A', 'SW_B', 'SW_C'], '不指定區塊時維持整體結果');
  assert.deepStrictEqual(v.domains.map((d) => [d.key, d.devices]), [['10@SW_A', ['SW_A', 'SW_B']], ['10@SW_C', ['SW_C']]], 'SW_C 只有 MNDP 看到 SW_B，不算承載 VLAN 10');
  const c = Q.vlan(10, '10@SW_C');
  assert.deepStrictEqual([c.domain, c.devices, c.carry, c.entries.map((e) => e.dev)], ['10@SW_C', ['SW_C'], [], ['SW_C']]);
  assert.strictEqual(Q.vlan(10, '10@SW_A').carry.length, 1);
  assert.strictEqual(Q.vlan(10, '10@NOPE').domain, null, '不存在的區塊回到整體結果');
  assert.ok(Q.search('10').find((r) => r.type === 'vlan').sub.includes('2 個不相連區塊'));
  assert.deepStrictEqual(Q.vlan(99).domains, []);
});
test('路由追蹤：直連抵達、下一跳不在基準內、跨站點 ECMP', () => {
  let Q = S.query(build(read('samples/sample-bundle.txt')));
  assert.ok(S.trace(Q, '10.1.30.15', '10.1.20.11').reached);
  const t2 = S.trace(Q, '10.1.30.15', '8.8.8.8');
  assert.ok(!t2.reached && t2.ends[0].status === 'unknown-nh', JSON.stringify(t2.ends));
  Q = S.query(build(gen(['--sites', '3', '--access', '2'])));
  const t3 = S.trace(Q, '10.1.30.15', '10.3.20.11');
  assert.ok(t3.reached, JSON.stringify(t3.ends));
  assert.ok(t3.hops.some((h) => h.ecmp));
});
test('遞迴路由：gateway 是對端 loopback 時沿路由表解析；R01 只提醒解析後仍到不了已知設備的下一跳', () => {
  const a = 'R_A (10.0.0.1):\n### /export terse\n/ip address add address=10.254.0.1/30 interface=ether48\n/ip address add address=10.9.9.1/32 interface=lo\n'
    + '### /ip route print detail\nFlags: A - ACTIVE; s - STATIC\n'
    + ' 0 As dst-address=172.16.0.0/16 gateway=10.99.0.2 immediate-gw=10.254.0.2%ether48 distance=1\n'
    + ' 1 As dst-address=10.99.0.0/24 gateway=10.254.0.2 distance=1\n'
    + ' 2 As dst-address=172.17.0.0/16 gateway=10.77.0.2 distance=1\n'
    + ' 3 As dst-address=172.18.0.0/16 gateway=10.88.0.2 distance=1\n'
    + ' 4 As dst-address=10.88.0.0/24 gateway=10.88.0.5 distance=1\n'
    + ' 5 As dst-address=10.254.0.0/30 gateway=ether48 distance=0\n';
  const b = 'R_B (10.0.0.2):\n### /export terse\n/ip address add address=10.254.0.2/30 interface=ether1\n';
  const s = build(a + b); const m = s.model;
  const r01 = s.findings.filter((f) => f.id === 'R01');
  const text = r01.map((f) => f.message).join(' ');
  assert.ok(!text.includes('10.99.0.2'), '10.99.0.2 經 10.99.0.0/24 → 10.254.0.2 解析到 R_B，不應提醒');
  assert.ok(text.includes('10.77.0.2'), '沒有任何路由可解析的下一跳要提醒');
  assert.ok(text.includes('10.88.0.2'), '遞迴迴圈或落在未知位址的下一跳要提醒');
  const rs = (ip, routes) => S.check.resolveNextHop(routes, ip, (x) => (x === '10.254.0.2' ? 'R_B' : null));
  const rt = m.routes.filter((r) => r.dev === 'R_A');
  const ok = rs('10.99.0.2', rt); assert.ok(ok.some((x) => x.status === 'known' && x.owner === 'R_B'), JSON.stringify(ok));
  assert.deepStrictEqual(rs('10.99.0.2', rt), rs('10.99.0.2', rt), '相同輸入結果相同');
  const loop = [{ prefix: '10.0.0.0', len: 8, nh: [{ ip: '10.0.0.9', ifc: null }] }];
  assert.strictEqual(rs('10.0.0.9', loop)[0].status, 'unresolved', '閘道只能靠涵蓋自己的路由解析：無法到達（R01），不是多條路由的迴圈（R03）');
  const pair = [{ prefix: '10.97.0.0', len: 16, nh: [{ ip: '10.96.0.1', ifc: null }] }, { prefix: '10.96.0.0', len: 16, nh: [{ ip: '10.97.0.1', ifc: null }] }];
  assert.strictEqual(rs('10.96.0.1', pair)[0].status, 'loop', '兩條路由互相指向才是迴圈');
  const Q = S.query(s); const t = S.trace(Q, '10.254.0.1', '172.16.1.1');
  assert.ok(t.hops.some((h) => h.next.some((n) => n.dev === 'R_B' && /遞迴解析/.test(n.note || ''))), JSON.stringify(t.hops));
});
test('OSPF 鄰接與 LLDP edge 分開儲存；OSPF 不新增拓樸 edge 或升格為直連', () => {
  const a = 'R_A (10.0.0.1):\n### /export terse\n/ip address add address=10.254.0.1/30 interface=ether48\n/routing id add id=1.1.1.1 name=main\n/routing ospf instance add name=default router-id=main\n'
    + '### /routing ospf neighbor print detail\n 0 instance=default area=backbone address=10.254.0.2 priority=1 router-id=2.2.2.2 state=Full state-changes=5\n'
    + '### /ip neighbor print detail\n 0 interface=ether48 identity=R_B address=10.254.0.2 mac-address=AA:BB:CC:00:00:02 interface-name=ether1 discovered-by=lldp\n';
  const b = 'R_B (10.0.0.2):\n### /export terse\n/ip address add address=10.254.0.2/30 interface=ether1\n/routing ospf instance add name=default router-id=2.2.2.2\n'
    + '### /routing ospf neighbor print detail\n 0 instance=default address=10.254.0.1 router-id=1.1.1.1 interface=ether1 state=Full\n'
    + '### /ip neighbor print detail\n 0 interface=ether1 identity=R_A address=10.254.0.1 mac-address=AA:BB:CC:00:00:01 interface-name=ether48 discovered-by=lldp\n';
  const s = build(a + b);
  assert.strictEqual(s.model.links.length, 1);
  const l = s.model.links[0];
  assert.strictEqual(l.key, 'R_A|ether48~R_B|ether1');
  assert.deepStrictEqual(l.via, ['lldp']);
  assert.strictEqual(s.model.ospfAdjacencies.length, 2);
  assert.ok(s.model.ospfAdjacencies.every((x) => x.reciprocal));
  assert.strictEqual(s.meta.stats.links, 1, '拓樸 edge 數量只計入 L2 direct link');
});
test('比對：獨立格式，結果分 ok／missing／different，且不修改基準', () => {
  const s = build(read('samples/sample-bundle.txt')); const before = JSON.stringify(s);
  const r = S.compare(S.query(s), JSON.parse(read('samples/expected-sample.json')));
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.summary.ok > 0 && r.summary.missing > 0 && r.summary.different > 0, JSON.stringify(r.summary));
  assert.strictEqual(JSON.stringify(s), before);
  assert.ok(S.compare(S.query(s), { schema: 'x' }).errors.length === 1);
});
test('去識別化：關係與檢查結果不變，設備名與 IP 不殘留，機密欄位遮蔽，結果可重現', () => {
  const { anonymize } = require('../tools/anonymize.js');
  const raw = read('samples/sample-bundle.txt'); const a = anonymize(raw);
  const shape = (snap) => JSON.stringify({ st: snap.meta.stats, f: ids(snap).sort(), k: snap.model.devices.map((d) => d.kind).sort(),
    v: snap.model.macs.map((m) => m.vendor).sort(), l: snap.model.links.map((l) => [l.verified, l.hearsay, l.cls].join()).sort() });
  const s0 = build(raw); const s1 = build(a.text);
  assert.strictEqual(shape(s1), shape(s0), '去識別化不可改變網路結構、廠商判斷與檢查結果');
  s0.model.devices.forEach((d) => assert.ok(!a.text.toUpperCase().includes(d.key), `設備名 ${d.key} 不應殘留`));
  assert.ok(!/(?<![\d.])10\.1\.10\.2(?![\d.])/.test(a.text), '原始 IP 不應殘留');
  assert.strictEqual(anonymize(raw).text, a.text, '同一份輸入應得到同一份輸出');
  const w = anonymize('AP_1 (192.168.5.11):\n### /interface wifi registration-table print detail\n 0 A interface=wifi1 ssid="Corp" mac-address=AA:BB:CC:00:10:01 uptime=1h last-activity=1s\n     eap-identity="alice@corp" eap-username="alice" dhcp-hostname="alice-nb"\n### /export terse\n# serial number = HE0123\n/interface wireless security-profiles add name=p1 wpa2-pre-shared-key=topsecret\n').text;
  ['alice', 'Corp"', 'HE0123', 'topsecret', 'AP_1', '192.168'].forEach((x) => assert.ok(!w.includes(x), `${x} 應被去識別化`));
  const id = anonymize('SW (10.0.0.1):\n### /system identity print\n  name: SW\n### /interface bridge monitor [find] once\n  name: bridge1\n').text;
  assert.ok(id.includes('name: bridge1') && !/name: SW\b/.test(id), '只有 /system identity print 的 name 是設備名，bridge 名稱不換');
  assert.ok(w.includes('AA:BB:CC:'), '保留 OUI，廠商判斷不受影響');
});
test('真實設備輸出（tests/fixtures/real/）：每份都完整解析，沒有 I01', () => {
  const dir = path.join(ROOT, 'tests/fixtures/real');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  if (!files.length) console.log('      （尚無真實設備輸出；新增方式見 tests/fixtures/real/README.md）');
  files.forEach((f) => {
    const s = S.build([{ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }], { now: '2026-01-01T00:00:00Z' });
    const i01 = s.findings.filter((x) => x.id === 'I01').map((x) => x.message);
    assert.deepStrictEqual(i01, [], `${f} 有無法解析的內容`);
    s.blocks.filter((b) => b.device !== null).forEach((b) => assert.ok(b.adapters.length && !b.empty, `${f} 第 ${b.start} 行的 ${b.command || '區塊'} 沒有解析出內容`));
  });
});
test('官方手冊的輸出範例（tests/fixtures/manual/，原文照錄）：完整解析並取得關鍵欄位', () => {
  const load = (f) => build(read(`tests/fixtures/manual/${f}`));
  const stp = (s, k) => { const i = iface(s, k); return i && i.stp && [i.stp.role, i.stp.designatedBridge, i.stp.designatedPort]; };
  const two = load('routeros7-bridge-port-monitor.txt');
  assert.ok(!ids(two).includes('I01'), JSON.stringify(two.findings.filter((f) => f.id === 'I01').map((f) => f.message)));
  assert.deepStrictEqual([stp(two, 'SW_MANUAL|ether1'), stp(two, 'SW_MANUAL|ether2')],
    [['alternate-port', '64D154C73A6E', 1], ['designated-port', null, 2]], '空白欄位不可讓整行被略過，也不可錯位到別的埠');
  const one = load('routeros7-bridge-port-monitor-single.txt');
  assert.deepStrictEqual(stp(one, 'SW_MANUAL|ether1'), ['root-port', '2CC81BFF92F4', 1]);
  const pn = load('routeros7-bridge-port-monitor-port-number.txt');
  assert.deepStrictEqual([iface(pn, 'SW_MANUAL|sfp-sfpplus1').stp.role, iface(pn, 'SW_MANUAL|sfp-sfpplus1').stp.portNumber], ['designated-port', 1]);
  const br = load('routeros7-bridge-monitor.txt');
  assert.ok(br.model.devices[0].ownMacs.includes('2CC81BFF92F4'));
  assert.deepStrictEqual([br.model.devices[0].stp.rootBridge, br.model.devices[0].stp.isRoot], ['2CC81BFF92F4', true]);
  const ex = load('routeros-export-header.txt');
  assert.strictEqual(ex.model.devices[0].collectedAt, '1970-04-02T17:59:30', 'RouterOS 6 也有「年-月-日」格式的 export 抬頭');
  ['routeros7-bridge-port-monitor-single.txt', 'routeros7-bridge-monitor.txt', 'routeros-export-header.txt'].forEach((f) => assert.ok(!ids(load(f)).includes('I01'), f));
});
test('RouterOS 7 的斜線路徑：指令標記與 export 選單路徑都視同空白分隔；提示字元可省略 >', () => {
  const s = build(['SW (10.0.0.1):', '[admin@SW] > /ip/neighbor/print detail without-paging',
    ' 0 interface=ether1 mac-address=AA:BB:CC:00:00:02 identity=R2 interface-name=ether2',
    '[admin@SW] /interface/bridge/host/print detail without-paging', ' 0 D mac-address=AA:BB:CC:00:00:09 on-interface=ether3 bridge=bridge1',
    '### /export terse', '/interface/bridge/port add bridge=bridge1 interface=ether3 pvid=30', '/interface/bridge add name=bridge1 vlan-filtering=yes'].join('\n'));
  assert.deepStrictEqual(s.blocks.map((b) => b.command), ['/ip neighbor print detail without-paging', '/interface bridge host print detail without-paging', '/export terse']);
  assert.ok(!ids(s).includes('I01'));
  assert.deepStrictEqual([iface(s, 'SW|ether3').bridge, iface(s, 'SW|ether3').pvid], ['SW|bridge1', 30]);
});
test('黃金基準：範例資料建出的 Snapshot 與 tests/golden/sample-snapshot.json 完全相同', () => {
  const G = require('./golden.js');
  const want = JSON.parse(read('tests/golden/sample-snapshot.json'));
  const got = JSON.parse(G.serialize(G.goldenSnapshot(S)));
  const diff = G.diffPaths(want, got, 10);
  assert.deepStrictEqual(diff, [], 'Snapshot 與黃金基準不同。若是刻意的變更，執行 npm run golden:update 並檢視 git diff：\n' + diff.join('\n'));
});
test('index.html 載入的核心檔案與測試相同、順序一致', () => {
  const html = read('index.html');
  const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
  const core = require('../tools/core-files.js');
  assert.deepStrictEqual(scripts.slice(0, core.length), core);
});

if (process.argv.includes('--large')) {
  test('壓力：約 1000 台設備在時間內完成，且乾淨網路沒有誤報', () => {
    const text = gen(['--sites', '40', '--access', '24']);
    const t = Date.now(); const s = build(text); const ms = Date.now() - t;
    console.log(`      ${s.meta.stats.collected} 台已收集、${s.meta.stats.devices} 個節點、${s.meta.stats.links} 條鏈路、${s.meta.stats.macs} 個 MAC：${ms} ms`);
    assert.ok(s.meta.stats.collected >= 1000);
    assert.ok(ms < 20000);
    assert.strictEqual(s.meta.stats.findings.error + s.meta.stats.findings.warn, 0);
  });
}

let fail = 0;
for (const t of tests) {
  try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { fail++; console.log('  ✗ ' + t.name + '\n      ' + String(e.message).split('\n').join('\n      ')); }
}
console.log(`\n${tests.length - fail} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
