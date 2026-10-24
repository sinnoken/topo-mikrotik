// 檢查規則的證據與 CATALOG（A02、C01、C02…）
'use strict';
const assert = require('assert');
const { S, read, build, ids, count, test, NB, BH } = require('../lib.js');
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
test('C01 的證據指回發現它的鄰居資料與 OSPF 鄰居資料（依輸入順序，最多 6 筆）', () => {
  const nb = (dev, ports) => [`${dev} (10.0.0.${dev === 'SW_A' ? 1 : 2}):`, '### /ip neighbor print detail',
    ...ports.map((p, k) => ` ${k} interface=${p} mac-address=AA:00:00:00:00:09 identity=X_RT interface-name=ether${k + 1}`)];
  const s = build(nb('SW_B', ['ether1', 'ether2', 'ether3', 'ether4']).concat(nb('SW_A', ['ether5', 'ether6', 'ether7'])).join('\n'));
  const c01 = s.findings.find((f) => f.id === 'C01' && f.entities[0].key === 'X_RT');
  assert.ok(c01, '應有 X_RT 的 C01');
  assert.deepStrictEqual(c01.evidence.map((e) => e.line), [3, 4, 5, 6, 9, 10], '依輸入順序（SW_B 在前），最多 6 筆');
  assert.ok(c01.evidence.every((e) => /identity=X_RT/.test(e.text)));
  const o = build(['R1 (10.0.0.1):', '### /ip address print detail', ' 0 address=10.9.9.1/30 network=10.9.9.0 interface=ether1',
    '### /routing ospf neighbor print detail', ' 0 instance=default area=backbone address=10.9.9.2 router-id=10.255.0.9 state=Full'].join('\n'));
  const oc = o.findings.find((f) => f.id === 'C01');
  assert.ok(oc, 'OSPF 鄰居對不到設備時也應有 C01');
  assert.deepStrictEqual(oc.evidence.map((e) => e.line), [5]);
});
test('A02／A03／A04／C02 的證據指回 MAC 表觀察與設備區塊（A02 取同一 VLAN 的那一行，最多 6 筆）', () => {
  const many = Array.from({ length: 7 }, (_, k) => ` ${k + 4} D mac-address=02:AA:BB:00:01:0${k} vid=10 on-interface=ether3 bridge=bridge1\n`).join('');
  const s = build('SW_A (10.0.0.1):\n### /interface bridge host print detail\n'
    + ' 0 D mac-address=02:AA:BB:00:00:01 vid=20 on-interface=ether1 bridge=bridge1\n'
    + ' 1 D mac-address=02:AA:BB:00:00:01 vid=10 on-interface=ether1 bridge=bridge1\n'
    + ' 2 D mac-address=02:AA:BB:00:00:01 vid=10 on-interface=ether2 bridge=bridge1\n'
    + ' 3 D mac-address=02:AA:BB:00:00:05 vid=10 on-interface=ether9 bridge=bridge1\n' + many
    + '### /ip arp print detail\n 0 address=10.0.0.9 mac-address=02:AA:BB:00:00:05 interface=bridge1\n');
  const ev = (id) => { const f = s.findings.find((x) => x.id === id); assert.ok(f, `應有 ${id}`); return f.evidence; };
  const lines = (id) => ev(id).map((e) => e.line);
  // A02：VLAN 10 的兩個終端埠，ether1 指向 vid=10 那一行（第 4 行），不是先出現的 vid=20（第 3 行）
  assert.deepStrictEqual(lines('A02'), [4, 5]);
  assert.ok(ev('A02').every((e) => / vid=10 /.test(e.text) && e.file === 't.txt'));
  // A03：每個未知對端的終端埠一筆，依埠名排序
  assert.deepStrictEqual(lines('A03'), [3, 5, 6]);
  // A04：該埠學到的外部 MAC，依輸入順序取前 6 筆
  assert.deepStrictEqual(lines('A04'), [7, 8, 9, 10, 11, 12]);
  assert.ok(ev('A04').every((e) => /on-interface=ether3/.test(e.text)));
  // C02：設備在輸入中的各區塊開頭
  assert.deepStrictEqual(ev('C02').map((e) => [e.block, e.line]), [[0, 3], [1, 15]]);
});
test('C02 的證據不限 6 筆：列出全部失敗註解與已收集區塊；其他規則仍最多 6 筆', () => {
  const cmds = Array.from({ length: 8 }, (_, k) => `### /ip arp print detail\n\n# collection failed: exit code ${k + 1}`).join('\n');
  const s = build(`SW (10.0.0.1):\n${cmds}\n`);
  const c02 = s.findings.find((f) => f.id === 'C02');
  assert.strictEqual(c02.evidence.length, 16, '8 個失敗註解＋8 個區塊');
  assert.ok(c02.evidence.slice(0, 8).every((e) => /collection failed/.test(e.text)));
  assert.strictEqual(S.check.CATALOG.C02.evidenceLimit, Infinity);
  assert.ok(Object.entries(S.check.CATALOG).every(([id, c]) => id === 'C02' || c.evidenceLimit === undefined));
});
test('每條檢查規則都有常見原因（1–4 條，皆非空）與處理方式，且只放在 CATALOG、不複製到 finding', () => {
  const ids = Object.keys(S.check.CATALOG);
  assert.strictEqual(ids.length, 42);
  Object.entries(S.check.CATALOG).forEach(([id, c]) => {
    assert.ok(typeof c.action === 'string' && c.action.trim() !== '', `${id} 缺少處理方式（action）`);
    assert.ok(Array.isArray(c.causes) && c.causes.length >= 1 && c.causes.length <= 4, `${id} 的常見原因（causes）應有 1–4 條`);
    c.causes.forEach((x, k) => assert.ok(typeof x === 'string' && x.trim() !== '', `${id} 的第 ${k + 1} 條常見原因是空的`));
  });
  const s = build(read('samples/sample-bundle.txt'));
  assert.ok(s.findings.length > 0);
  assert.ok(s.findings.every((f) => !('causes' in f) && !('action' in f)), 'finding 不帶 causes／action，畫面從 CATALOG 讀');
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
