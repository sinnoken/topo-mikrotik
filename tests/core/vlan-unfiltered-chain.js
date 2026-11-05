// 兩台以上未開 vlan-filtering 的 bridge 串接：中間的鏈路也算透通（推論）
// 測試資料依 RouterOS 手冊手寫，不是從真實設備擷取：
//   https://manual.mikrotik.com/docs/bridging-and-switching.md（Bridge VLAN Filtering：vlan-filtering=no 時不看也不改 VLAN 標籤）
'use strict';
const assert = require('assert');
const { S, build, count, test, NB } = require('../lib.js');

const lldp = (local, mac, peer, port) => ` 0 interface=${local} mac-address=${mac} identity=${peer} interface-name=${port} discovered-by=lldp`;
const unfiltered = (name, ip, nbs, extra = [], ether2 = 'bridge1') => [`${name} (${ip}):`, NB(nbs), '### /export terse', '/interface bridge add name=bridge1',
  '/interface bridge add name=bridge2', '/interface bridge port add bridge=bridge1 interface=ether1', `/interface bridge port add bridge=${ether2} interface=ether2`, ...extra];
const filtered = (name, ip, nbs, vlanName) => [`${name} (${ip}):`, NB(nbs), '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes',
  '/interface bridge port add bridge=bridge1 interface=ether1', '/interface bridge vlan add bridge=bridge1 tagged=bridge1,ether1 vlan-ids=10,20',
  `/interface vlan add interface=bridge1 name=${vlanName} vlan-id=10`];

// A ether1（tagged 10、20）─ B ether1；B ether2 ─ C ether1；C ether2 ─ D ether1（tagged 10、20）。B、C 的 bridge1 沒有開 vlan-filtering
const chain = (opt = {}) => build([
  ...filtered('A', '10.0.0.1', [lldp('ether1', 'AA:00:00:00:00:B1', 'B', 'ether1')], 'vlan10'),
  ...unfiltered('B', '10.0.0.2', [lldp('ether1', 'AA:00:00:00:00:A1', 'A', 'ether1'), lldp('ether2', 'AA:00:00:00:00:C1', 'C', 'ether1')], opt.b),
  ...unfiltered('C', '10.0.0.3', [lldp('ether1', 'AA:00:00:00:00:B2', 'B', 'ether2'), lldp('ether2', 'AA:00:00:00:00:D1', 'D', 'ether1')].concat(opt.cNb || []), opt.c, opt.cEther2),
  ...filtered('D', '10.0.0.4', [lldp('ether1', 'AA:00:00:00:00:C2', 'C', 'ether2')], opt.dVlanName || 'v10-users'),
  ...(opt.tail || []),
].join('\n'));
const BC = 'B|ether2~C|ether1';

test('未過濾的 bridge 串接：B–C 鏈路（兩端都未過濾）算透通，VLAN 10／20 的 A 與 D 同一區塊', () => {
  const s = chain(); const Q = S.query(s);
  [10, 20].forEach((id) => {
    assert.deepStrictEqual(Q.vlan(id).transparent.map((l) => l.key), ['A|ether1~B|ether1', BC, 'C|ether2~D|ether1'], `VLAN ${id}`);
    assert.deepStrictEqual(Q.vlan(id).domains.map((d) => [d.key, d.devices]), [[id + '@A', ['A', 'D']]], `VLAN ${id}：B、C 不帶這個 VLAN，不列在區塊內`);
  });
  const rows = Q.vlanCarriers(10).links;
  assert.deepStrictEqual(rows.map((r) => [r.key, r.status, r.reason, r.inferred]), [
    ['A|ether1~B|ether1', 'oneSide', 'unfiltered', true], [BC, 'oneSide', 'unfiltered', true], ['C|ether2~D|ether1', 'oneSide', 'unfiltered', true]]);
  const bc = rows.find((r) => r.key === BC);
  assert.deepStrictEqual([bc.a.ep, bc.a.has, bc.b.ep, bc.b.has], ['B|ether2', null, 'C|ether1', null], '兩端都原樣轉送，無從得知（null）');
  assert.ok(bc.src.length && bc.src.every((x) => Array.isArray(x) && x.length === 2), '保留來源區塊與行號');
  assert.deepStrictEqual(Q.vlanCarriers(10).counts, { carry: 0, partial: 0, oneSide: 3, inferred: 0 });
  // 給區塊鍵時，串接的鏈路也屬於那一塊（兩端設備都不在區塊的設備清單裡）
  assert.deepStrictEqual(Q.vlan(10, '10@A').transparent.map((l) => l.key), ['A|ether1~B|ether1', BC, 'C|ether2~D|ether1']);
  assert.deepStrictEqual(Q.vlanCarriers(10, '10@A').links.map((r) => r.key), ['A|ether1~B|ether1', BC, 'C|ether2~D|ether1']);
});

test('未過濾的 bridge 串接：V01／V04／V08 不比較；V09 只報一端未過濾的 A–B、C–D；同一區塊後 V06 比較 A 與 D 的 VLAN 名稱', () => {
  const s = chain();
  assert.strictEqual(count(s, 'V01') + count(s, 'V04') + count(s, 'V08'), 0);
  assert.deepStrictEqual(s.findings.filter((f) => f.id === 'V09').map((f) => f.entities[0].key), ['A|ether1~B|ether1', 'C|ether2~D|ether1'], 'B–C 兩端都未過濾，不報 V09');
  assert.deepStrictEqual(s.findings.filter((f) => f.id === 'V06').map((f) => f.message), ['VLAN 10 的 VLAN 介面名稱：A「vlan10」；D「v10-users」'],
    'A、D 經透通的鏈路相連，屬同一區塊才比較');
  assert.strictEqual(count(chain({ dVlanName: 'vlan10' }), 'V06'), 0, '名稱相同時不報');
});

test('未過濾的 bridge 串接：不同 bridge 不相通；環狀串接也會結束；沒有接到 VLAN 的未過濾鏈路不列入', () => {
  // C 的 ether2 在另一個未過濾的 bridge2：C 的兩個 bridge 之間不轉送，A 與 D 分成兩塊
  const split = S.query(chain({ cEther2: 'bridge2' }));
  assert.deepStrictEqual(split.vlan(10).domains.map((d) => d.devices), [['A'], ['D']]);
  assert.deepStrictEqual(split.vlan(10).transparent.map((l) => l.key), ['A|ether1~B|ether1', BC, 'C|ether2~D|ether1'],
    'B–C 接到 A 那一側（C 的 bridge1）；C–D 本身是一端帶的透通鏈路');
  assert.deepStrictEqual(split.vlan(10, '10@D').transparent.map((l) => l.key), ['C|ether2~D|ether1']);
  // B ether3 ─ C ether3 第二條鏈路（同一個 bridge），形成環
  const loop = S.query(chain({
    b: ['/interface bridge port add bridge=bridge1 interface=ether3'], c: ['/interface bridge port add bridge=bridge1 interface=ether3'],
    cNb: [lldp('ether3', 'AA:00:00:00:00:B3', 'B', 'ether3')],
  }));
  assert.deepStrictEqual(loop.vlan(10).transparent.map((l) => l.key), ['A|ether1~B|ether1', BC, 'B|ether3~C|ether3', 'C|ether2~D|ether1']);
  assert.deepStrictEqual(loop.vlan(10).domains.map((d) => d.devices), [['A', 'D']]);
  // 另一組未過濾的 E–F，沒有任何一端帶 VLAN 10，也沒有接到帶的設備：不是 VLAN 10 的透通鏈路
  const iso = S.query(chain({ tail: [
    ...unfiltered('E', '10.0.0.5', [lldp('ether1', 'AA:00:00:00:00:F1', 'F', 'ether1')]),
    ...unfiltered('F', '10.0.0.6', [lldp('ether1', 'AA:00:00:00:00:E1', 'E', 'ether1')]),
  ] }));
  assert.ok(!iso.vlan(10).transparent.some((l) => l.key === 'E|ether1~F|ether1'));
  assert.ok(!iso.vlanCarriers(10).links.some((r) => r.key === 'E|ether1~F|ether1'));
});
