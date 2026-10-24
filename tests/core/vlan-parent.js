// VLAN 子介面讓 parent 承載 tagged VLAN（單臂路由）；未開 vlan-filtering 的 bridge（VLAN 透通，V09）
// 測試資料依 RouterOS 手冊手寫，不是從真實設備擷取：
//   https://manual.mikrotik.com/docs/bridging-and-switching/vlan.md
//   https://manual.mikrotik.com/docs/bridging-and-switching.md（vlan-filtering、pvid、frame-types、ingress-filtering）
'use strict';
const assert = require('assert');
const { S, build, count, iface, test, NB } = require('../lib.js');

const lldp = (local, mac, peer, port) => ` 0 interface=${local} mac-address=${mac} identity=${peer} interface-name=${port} discovered-by=lldp`;
const fw = (s, id) => s.findings.filter((f) => f.id === id);

// ------------------------------------------------------------------ 解析：bridge 的 vlan-filtering
test('export：bridge 的 vlan-filtering 記在 bridge 介面（預設 no；set 改值；非 bridge 為 null）', () => {
  const s = build(['SW_A (10.0.0.1):', '### /export terse',
    '/interface bridge add name=br-off', '/interface bridge add name=br-on vlan-filtering=yes', '/interface bridge add name=br-set',
    '/interface bridge set [ find name=br-set ] vlan-filtering=yes', '/interface bridge set br-on protocol-mode=none',
    '/interface bridge port add bridge=br-off interface=ether1'].join('\n'));
  assert.deepStrictEqual(['br-off', 'br-on', 'br-set', 'ether1'].map((n) => iface(s, 'SW_A|' + n).vlanFiltering), [false, true, true, null]);
  // 只由 /interface print 知道的 bridge：沒有設定資料，無從得知
  const p = build(['SW_B (10.0.0.2):', '### /interface print detail without-paging', 'Flags: R - RUNNING', ' 0  R  name="bridge1" type="bridge" mtu=1500'].join('\n'));
  assert.strictEqual(iface(p, 'SW_B|bridge1').vlanFiltering, null);
});

// ------------------------------------------------------------------ 缺口 1：VLAN 子介面的 parent
const stick = (routerLines) => build([
  'R1 (10.0.0.1):', NB([lldp('ether2', 'AA:00:00:00:00:B1', 'SW_B', 'ether1')]), '### /export terse', ...routerLines,
  'SW_B (10.0.0.2):', NB([lldp('ether1', 'AA:00:00:00:00:A1', 'R1', 'ether2')]),
  '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge port add bridge=bridge1 interface=ether1',
  '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=10,20',
].join('\n'));

test('單臂路由：實體埠上的 VLAN 子介面讓實體埠以 tagged 承載；對端的 PVID 1 不算不一致（V01、Q.vlan、vlanCarriers 一致）', () => {
  const s = stick(['/interface vlan add interface=ether2 name=vlan10 vlan-id=10', '/interface vlan add interface=ether2 name=vlan20 vlan-id=20',
    '/ip address add address=10.1.10.1/24 interface=vlan10']);
  const e2 = iface(s, 'R1|ether2');
  assert.deepStrictEqual([e2.taggedVlans, e2.pvid, e2.mode], [[10, 20], null, 'tagged']);
  const l = s.model.links.find((x) => x.key === 'R1|ether2~SW_B|ether1');
  assert.deepStrictEqual([l.vlansA, l.vlansB, l.vlanComparable, l.vlanMismatch, l.vlansDiff], [[10, 20], [1, 10, 20], true, false, []],
    'R1 ether2 不在 bridge 上、沒有 PVID：untagged 訊框由介面本身處理，對端只以 untagged 承載的 VLAN 1 不比較');
  assert.strictEqual(count(s, 'V01'), 0);
  const Q = S.query(s);
  [10, 20].forEach((id) => {
    assert.deepStrictEqual(Q.vlan(id).carry.map((x) => x.key), [l.key], `VLAN ${id}`);
    const r = Q.vlanCarriers(id).links;
    assert.deepStrictEqual(r.map((x) => [x.status, x.a.via, x.a.mode, x.b.mode]), [['carry', 'self', 'tagged', 'tagged']], `VLAN ${id}`);
  });
  assert.deepStrictEqual(Q.vlanCarriers(1).links, [], 'VLAN 1 不是 partial');
  assert.deepStrictEqual(Q.vlan(10).devices, ['R1', 'SW_B']);
});

test('單臂路由：真的少一個 VLAN 時仍報 V01；停用的 VLAN 子介面不讓 parent 承載', () => {
  const s = stick(['/interface vlan add interface=ether2 name=vlan10 vlan-id=10', '/interface vlan add disabled=yes interface=ether2 name=vlan20 vlan-id=20']);
  assert.deepStrictEqual(iface(s, 'R1|ether2').taggedVlans, [10], '停用的 VLAN 介面不收送 tagged 訊框');
  assert.strictEqual(iface(s, 'R1|vlan20').enabled, false);
  assert.deepStrictEqual(fw(s, 'V01').map((f) => f.message), ['只在 SW_B ether1：20']);
  const l = s.model.links[0];
  assert.deepStrictEqual(l.vlansDiff, [20]);
  assert.deepStrictEqual(S.query(s).vlanCarriers(20).links.map((r) => [r.status, r.a.has, r.b.has]), [['partial', false, true]]);
  assert.deepStrictEqual(S.query(s).vlanCarriers(1).links, []);
});

test('VLAN 子介面的 parent：聚合時成員經聚合承載；bridge 時只有 bridge 本身（CPU 埠），成員埠不帶', () => {
  const bond = stick(['/interface bonding add mode=802.3ad name=bond1 slaves=ether2,ether3', '/interface vlan add interface=bond1 name=vlan10 vlan-id=10']);
  assert.deepStrictEqual([iface(bond, 'R1|bond1').taggedVlans, S.infer.effVlans({ ifcs: new Map(bond.model.interfaces.map((i) => [i.key, i])) }, 'R1|ether2')], [[10], [10]]);
  assert.deepStrictEqual(fw(bond, 'V01').map((f) => f.message), ['只在 SW_B ether1：20'], '聚合成員 ether2 不在 bridge 上，PVID 1 不比較');
  // bridge（vlan-filtering=yes）：手冊「Adding a VLAN interface to a bridge with vlan-filtering enabled will automatically tag the bridge interface」
  const br = build(['SW (10.0.0.1):', '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes',
    '/interface bridge port add bridge=bridge1 interface=ether1', '/interface vlan add interface=bridge1 name=vlan10 vlan-id=10'].join('\n'));
  assert.deepStrictEqual([iface(br, 'SW|bridge1').taggedVlans, iface(br, 'SW|ether1').taggedVlans, iface(br, 'SW|ether1').pvid], [[10], [], 1]);
});

// ------------------------------------------------------------------ 缺口 2：未開 vlan-filtering 的 bridge
// SW_A ether1（tagged 10、20）─ LAB ether1；LAB ether2 ─ SW_C ether1（tagged 10）。LAB 的 bridge1 沒有開 vlan-filtering
const lab = (labExtra = []) => build([
  'SW_A (10.0.0.1):', NB([lldp('ether1', 'AA:00:00:00:00:F1', 'LAB', 'ether1')]),
  '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge port add bridge=bridge1 interface=ether1',
  '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=10,20',
  'LAB (10.0.0.9):', NB([lldp('ether1', 'AA:00:00:00:00:A1', 'SW_A', 'ether1'), lldp('ether2', 'AA:00:00:00:00:C1', 'SW_C', 'ether1')]),
  '### /export terse', '/interface bridge add name=bridge1', '/interface bonding add mode=balance-rr name=bond1 slaves=ether7,ether8',
  '/interface bridge port add bridge=bridge1 interface=ether1 frame-types=admit-only-vlan-tagged pvid=30', '/interface bridge port add bridge=bridge1 interface=ether2',
  '/interface bridge port add bridge=bridge1 interface=bond1', '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=99', ...labExtra,
  'SW_C (10.0.0.3):', NB([lldp('ether1', 'AA:00:00:00:00:F2', 'LAB', 'ether2')]),
  '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge port add bridge=bridge1 interface=ether1',
  '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=10',
].join('\n'));

test('未開 vlan-filtering 的 bridge：bridge、bridge port 與聚合成員標為 vlanUnfiltered；PVID 與 VLAN 表沒有作用', () => {
  const s = lab();
  assert.deepStrictEqual(['bridge1', 'ether1', 'ether2', 'bond1', 'ether7'].map((n) => iface(s, 'LAB|' + n).vlanUnfiltered), [true, true, true, true, true]);
  assert.deepStrictEqual(['bridge1', 'ether1'].map((n) => iface(s, 'SW_A|' + n).vlanUnfiltered), [false, false]);
  const e1 = iface(s, 'LAB|ether1');
  assert.deepStrictEqual([e1.pvid, e1.taggedVlans, e1.frameTypes], [null, [], 'admit-only-vlan-tagged'], 'frame-types 照設定保留（事實），但 vlan-filtering=no 時沒有作用');
});

test('未開 vlan-filtering 的 bridge：V01／V04／V08 不比較，改報 V09（提醒）；對端只有 untagged 時不報', () => {
  const s = lab();
  assert.strictEqual(count(s, 'V01') + count(s, 'V04') + count(s, 'V08'), 0);
  s.model.links.forEach((l) => assert.deepStrictEqual([l.vlanComparable, l.vlanMismatch, l.vlansDiff], [false, false, []], l.key));
  const v09 = fw(s, 'V09');
  assert.deepStrictEqual(v09.map((f) => f.message), [
    'LAB ether1 所在的 bridge1 沒有開啟 vlan-filtering，VLAN 原樣轉送、無法比較；SW_A ether1 以 tagged 承載 VLAN 10,20',
    'LAB ether2 所在的 bridge1 沒有開啟 vlan-filtering，VLAN 原樣轉送、無法比較；SW_C ether1 以 tagged 承載 VLAN 10']);
  assert.strictEqual(v09[0].severity, 'info');
  assert.deepStrictEqual(v09[0].entities.map((e) => [e.type, e.key]), [['link', 'LAB|ether1~SW_A|ether1'], ['interface', 'LAB|bridge1']]);
  assert.ok(v09[0].evidence.some((e) => /\/interface bridge add name=bridge1$/.test(e.text)), '證據含 bridge 的設定行（沒有 vlan-filtering=yes）');
  // 對端只有 PVID（untagged）：untagged 訊框經過未過濾的 bridge 沒有問題，不報
  const u = build(['SW_A (10.0.0.1):', NB([lldp('ether1', 'AA:00:00:00:00:F1', 'LAB', 'ether1')]),
    '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge port add bridge=bridge1 interface=ether1 pvid=20',
    'LAB (10.0.0.9):', NB([lldp('ether1', 'AA:00:00:00:00:A1', 'SW_A', 'ether1')]), '### /export terse', '/interface bridge add name=bridge1',
    '/interface bridge port add bridge=bridge1 interface=ether1'].join('\n'));
  assert.strictEqual(count(u, 'V09') + count(u, 'V01'), 0);
});

test('未開 vlan-filtering 的 bridge：vlanCarriers 列為 oneSide（reason unfiltered），與 Q.vlan(id).transparent 相同；透通的鏈路讓兩側成為同一區塊', () => {
  const s = lab(); const Q = S.query(s);
  const c10 = Q.vlanCarriers(10);
  assert.deepStrictEqual(c10.links.map((r) => [r.key, r.status, r.reason, r.inferred]), [
    ['LAB|ether1~SW_A|ether1', 'oneSide', 'unfiltered', true], ['LAB|ether2~SW_C|ether1', 'oneSide', 'unfiltered', true]]);
  const lab1 = c10.links[0].a;
  assert.deepStrictEqual([lab1.dev, lab1.has, c10.links[0].b.has], ['LAB', null, true], '未過濾的一端無從得知（null），不是沒有（false）');
  assert.deepStrictEqual(Q.vlan(10).transparent.map((l) => l.key), c10.links.map((r) => r.key));
  assert.deepStrictEqual(Q.vlan(10).domains.map((d) => [d.key, d.devices]), [['10@SW_A', ['SW_A', 'SW_C']]], 'LAB 不帶 VLAN 10，但原樣轉送，SW_A 與 SW_C 同一區塊');
  assert.deepStrictEqual(Q.vlan(20).transparent.map((l) => l.key), ['LAB|ether1~SW_A|ether1']);
  assert.deepStrictEqual(Q.vlanCarriers(20).counts, { carry: 0, partial: 0, oneSide: 1, inferred: 0 });
  // LAB 在 bridge 上建 VLAN 10 介面：bridge 本身（CPU 埠）參與 VLAN 10，LAB 成為 VLAN 10 的設備
  const w = S.query(lab(['/interface vlan add interface=bridge1 name=vlan10 vlan-id=10']));
  assert.deepStrictEqual(w.vlan(10).domains.map((d) => d.devices), [['LAB', 'SW_A', 'SW_C']]);
  assert.deepStrictEqual(w.vlan(10).carry, [], '成員埠不因 bridge 上的 VLAN 介面而帶 VLAN 10');
});

test('V05：VLAN 介面建在未開 vlan-filtering 的 bridge 上時不判斷（同設備另一個 bridge 有 VLAN 成員也一樣）', () => {
  const s = build(['SW (10.0.0.1):', '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge add name=bridge2',
    '/interface bridge port add bridge=bridge1 interface=ether1', '/interface bridge port add bridge=bridge2 interface=ether2',
    '/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=10', '/interface vlan add interface=bridge2 name=vlan30 vlan-id=30'].join('\n'));
  assert.strictEqual(count(s, 'V05'), 0);
});

// ------------------------------------------------------------------ L3 子網圖：路由新增的子網也計入重疊
test('L3 子網圖：路由新增的子網（basis route）也列在 overlaps；預設路由不列', () => {
  const s = build(['R1 (10.0.0.1):', '### /export terse', '/ip address add address=10.1.1.1/24 interface=ether1', '/ip address add address=10.2.0.1/30 interface=ether2',
    '### /ip route print detail', 'Flags: A - ACTIVE; s - STATIC', ' 0 As dst-address=10.1.0.0/16 gateway=10.2.0.2 distance=1',
    ' 1 As dst-address=10.1.1.128/25 gateway=10.2.0.2 distance=1', ' 2 As dst-address=0.0.0.0/0 gateway=10.2.0.2 distance=1'].join('\n'));
  const g = S.query(s).subnetGraph({ routes: true }); const sub = (id) => g.subnets.find((x) => x.id === id);
  assert.deepStrictEqual([sub('10.1.0.0/16').basis, sub('10.1.0.0/16').overlaps], ['route', ['10.1.1.0/24', '10.1.1.128/25']]);
  assert.deepStrictEqual(sub('10.1.1.0/24').overlaps, ['10.1.0.0/16', '10.1.1.128/25']);
  assert.deepStrictEqual(sub('10.1.1.128/25').overlaps, ['10.1.0.0/16', '10.1.1.0/24']);
  assert.deepStrictEqual(sub('0.0.0.0/0').overlaps, [], '預設路由包含所有網段，不列');
  assert.ok(!g.subnets.some((x) => x.overlaps.includes('0.0.0.0/0')));
  assert.deepStrictEqual(g.routes.find((r) => r.subnet === '10.1.1.128/25').via, ['10.2.0.0/30'], 'via 仍只取直連網段');
  assert.deepStrictEqual(S.query(s).subnetGraph().subnets.find((x) => x.id === '10.1.1.0/24').overlaps, [], '不含路由時只比直連網段');
});
