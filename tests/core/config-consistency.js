// 跨設備組態一致性
'use strict';
const assert = require('assert');
const { S, read, build, ids, test, NB } = require('../lib.js');
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
  assert.deepStrictEqual(two.findings.find((f) => f.id === 'A12').deviation, { basis: 'majority', deviating: ['SW_B'],
    groups: [{ value: ['8.8.8.8'], key: ['8.8.8.8'], devs: ['SW_A', 'SW_C'] }, { value: ['1.1.1.1'], key: ['1.1.1.1'], devs: ['SW_B'] }], main: 0 });
  const tie = cfgTrio(dns('8.8.8.8'), dns('1.1.1.1'), dns('9.9.9.9'));
  assert.ok(msgs(tie, 'A12')[0].endsWith('；沒有多數，無法推定'), '1 對 1 對 1 平手');
  assert.deepStrictEqual(tie.findings.find((f) => f.id === 'A12').deviation, { basis: 'majority', deviating: [],
    groups: [{ value: ['8.8.8.8'], key: ['8.8.8.8'], devs: ['SW_A'] }, { value: ['1.1.1.1'], key: ['1.1.1.1'], devs: ['SW_B'] }, { value: ['9.9.9.9'], key: ['9.9.9.9'], devs: ['SW_C'] }], main: null });
  const pair = cfgPair(dns('8.8.8.8'), dns('1.1.1.1'));
  assert.deepStrictEqual(pair.findings.find((f) => f.id === 'A12').deviation, { basis: 'majority', deviating: [],
    groups: [{ value: ['8.8.8.8'], key: ['8.8.8.8'], devs: ['SW_A'] }, { value: ['1.1.1.1'], key: ['1.1.1.1'], devs: ['SW_B'] }], main: null }, '1 對 1 平手');
  // A08：同一台設定多個網段時，以網段組合當成它的設定值
  const ipa = (c, ifc = 'ether5') => `/ip address add address=${c} interface=${ifc}`;
  const a08 = cfgTrio([ipa('10.0.10.1/24'), ipa('10.0.10.129/25', 'ether6')], [ipa('10.0.10.2/24')], [ipa('10.0.10.3/24')]);
  const f08 = a08.findings.find((f) => f.id === 'A08');
  assert.ok(f08.message.endsWith('；依多數推定偏離：SW_A'), f08.message);
  assert.deepStrictEqual(f08.deviation, { basis: 'majority', deviating: ['SW_A'],
    groups: [{ value: ['10.0.10.0/24', '10.0.10.128/25'], key: ['10.0.10.0/24', '10.0.10.128/25'], devs: ['SW_A'] }, { value: ['10.0.10.0/24'], key: ['10.0.10.0/24'], devs: ['SW_B', 'SW_C'] }], main: 1 });
  const a09 = cfgPair([ipa('10.0.10.1/24')], [ipa('10.0.10.1/24', 'ether6')]).findings.find((f) => f.id === 'A09');
  assert.ok(a09 && !('deviation' in a09) && !a09.message.includes('多數'), 'A09 重複 IP 本身就是衝突，不套用多數決');
});
test('多數決的分組（deviation.groups／main）：顯示值取該組第一台設備的設定順序，key 是比對用的正規化值；分組不計順序、不分大小寫', () => {
  const ntp = (v) => [`/system ntp client set enabled=yes servers=${v}`];
  const s = cfgTrio(ntp('Time.Cloudflare.com,10.0.0.1'), ntp('10.0.0.1,time.cloudflare.com'), ntp('10.0.0.9'));
  const f = s.findings.find((x) => x.id === 'A12' && x.facet === 'ntp');
  assert.deepStrictEqual(f.deviation, { basis: 'majority', deviating: ['SW_C'],
    groups: [{ value: ['Time.Cloudflare.com', '10.0.0.1'], key: ['time.cloudflare.com', '10.0.0.1'], devs: ['SW_A', 'SW_B'] }, { value: ['10.0.0.9'], key: ['10.0.0.9'], devs: ['SW_C'] }], main: 0 });
});
test('多數決：範例資料中 A06 推定 TPE_ACC_SW_10 偏離；A12 的 DNS 兩台核心沒有多數，NTP 推定 TPE_ACC_SW_12 偏離', () => {
  const s = build(read('samples/sample-bundle.txt'));
  const a06 = s.findings.find((f) => f.id === 'A06');
  assert.ok(a06.message.endsWith('（網段重疊但遮罩不同）；依多數推定偏離：TPE_ACC_SW_10'), a06.message);
  assert.deepStrictEqual([a06.deviation.basis, a06.deviation.deviating], ['majority', ['TPE_ACC_SW_10']]);
  const a12 = s.findings.find((f) => f.id === 'A12' && f.facet === 'dns');
  assert.strictEqual(a12.message, 'DNS 伺服器：TPE_CORE_RT_01 1.1.1.1、8.8.8.8；TPE_CORE_RT_02 8.8.8.8；沒有多數，無法推定');
  assert.deepStrictEqual(a12.deviation, { basis: 'majority', deviating: [],
    groups: [{ value: ['1.1.1.1', '8.8.8.8'], key: ['1.1.1.1', '8.8.8.8'], devs: ['TPE_CORE_RT_01'] }, { value: ['8.8.8.8'], key: ['8.8.8.8'], devs: ['TPE_CORE_RT_02'] }], main: null });
  const ntp = s.findings.find((f) => f.id === 'A12' && f.facet === 'ntp');
  assert.strictEqual(ntp.message, 'NTP 伺服器：TPE_ACC_SW_12 10.1.10.2；TPE_CORE_RT_01、TPE_CORE_RT_02 time.cloudflare.com；依多數推定偏離：TPE_ACC_SW_12');
  assert.deepStrictEqual(ntp.deviation, { basis: 'majority', deviating: ['TPE_ACC_SW_12'],
    groups: [{ value: ['10.1.10.2'], key: ['10.1.10.2'], devs: ['TPE_ACC_SW_12'] }, { value: ['time.cloudflare.com'], key: ['time.cloudflare.com'], devs: ['TPE_CORE_RT_01', 'TPE_CORE_RT_02'] }], main: 1 });
  // 兩種 NTP 寫法：核心用 servers=，ACC_SW_12 用 RouterOS 7 的 servers 子選單
  const Q = S.query(s);
  assert.deepStrictEqual(['TPE_CORE_RT_01', 'TPE_ACC_SW_12'].map((k) => { const n = Q.serversOf(k).ntp; return [n.menu, n.param]; }),
    [['/system ntp client', 'servers'], ['/system ntp client servers', 'address']]);
  const withDev = ['V06', 'V07', 'A06', 'A07', 'A08', 'A10', 'A11', 'A12', 'R06'];
  s.findings.forEach((f) => assert.strictEqual('deviation' in f, withDev.includes(f.id), `${f.id} 的 deviation 欄位`));
  // 每條多數決規則的分組都一致：至少兩組、每台設備只在一組；有多數時 deviating 是其餘各組的設備，沒有多數時 main 為 null、deviating 為空
  s.findings.filter((f) => f.deviation).forEach((f) => {
    const d = f.deviation; const all = d.groups.flatMap((g) => g.devs);
    assert.ok(d.groups.length >= 2 && new Set(all).size === all.length, f.id);
    d.groups.forEach((g) => assert.ok(g.devs.length && g.value.length === g.key.length, f.id));
    if (d.main === null) assert.deepStrictEqual(d.deviating, [], f.id);
    else assert.deepStrictEqual(d.deviating.slice().sort(), d.groups.filter((g, i) => i !== d.main).flatMap((g) => g.devs).sort(), f.id);
  });
});
