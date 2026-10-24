// 推論鏈路（沒有 LLDP 時）
'use strict';
const assert = require('assert');
const { S, read, build, ids, count, iface, test, NB, BH } = require('../lib.js');
// ------------------------------------------------------------------ 推論鏈路（沒有 LLDP 時）
// CSS610 等 SwOS 交換器不支援 LLDP、也無法用 SSH 收集，只送 MNDP；測試資料依 RouterOS 鄰居表與 MAC 表格式撰寫
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
