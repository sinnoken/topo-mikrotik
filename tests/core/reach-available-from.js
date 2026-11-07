// zone 矩陣與 /ip service 的 available-from：同一個規則等價類（ruleAtom）的來源，available-from 的結果不同時不可共用節點
'use strict';
const assert = require('assert');
const { S, test, sampleSnap, build } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/**
 * 路由器 R：ether2 上有兩個 LAN 網段（192.168.1.0/24、192.168.2.0/24，同一個 zone list:LAN、同一個入介面），
 * 防火牆沒有位址條件（兩個網段在同一個規則等價類）；lines 加在 /export 之後（/ip service 等）。
 */
const twoNets = (lines) => build([
  'R (192.168.1.1):',
  '### /export terse',
  '/interface list add name=WAN', '/interface list add name=LAN',
  '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=ether2 list=LAN',
  '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
  '/ip address add address=192.168.1.1/24 interface=ether2 network=192.168.1.0',
  '/ip address add address=192.168.2.1/24 interface=ether2 network=192.168.2.0',
  '/ip firewall filter add action=accept chain=input in-interface-list=LAN',
  '/ip firewall filter add action=drop chain=input in-interface-list=WAN',
].concat(lines, [
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=ether2 distance=0',
  ' DAc dst-address=192.168.2.0/24 routing-table=main gateway=ether2 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1',
  '',
]).join('\n'));

/** 每一格「→ 網路設備（管理）」的每個來源代表 × 目的 × service，與逐一 Q.reach 的結果相同；回傳核對的筆數與 [來源, service, 結果] 清單。 */
const selfMatchesReach = (s, opts) => {
  const Q = S.query(s); const mx = Q.zoneMatrix(opts);
  const out = [];
  mx.cells.filter((c) => c.dst === 'self' && c.counts.total).forEach((c) => {
    Q.zoneCell(c.src, 'self', opts).groups.forEach((g) => g.srcs.forEach((src) => g.services.forEach((x) => {
      const [proto, port] = x.service.split('/');
      const r = Q.reach(src.ip, g.dst.ip, Object.assign({ proto, vrf: src.vrf }, port ? { port: +port } : {}, src.entry ? { entry: src.entry } : {}));
      assert.strictEqual(x.verdict, r.verdict, `${c.src} ${src.ip} → ${g.dst.ip} ${x.service}：矩陣 ${x.verdict}、Q.reach ${r.verdict}（${r.paths.map((p) => p.end && p.end.code).join('、')}）`);
      out.push([src.ip, g.dst.ip, x.service, x.verdict]);
    })));
  });
  return out;
};

test('zone 矩陣：同一個規則等價類的兩個來源，一個在 available-from 內、一個不在，各自與 Q.reach 相同', () => {
  const s = twoNets(['/ip service set ssh address=192.168.1.0/24']);
  const rows = selfMatchesReach(s, { services: [{ proto: 'tcp', port: 22 }] });
  const of = (src) => Array.from(new Set(rows.filter((r) => r[0] === src && r[2] === 'tcp/22').map((r) => r[3])));
  assert.deepStrictEqual(of('192.168.1.2'), ['allow'], '在 available-from 內');
  assert.deepStrictEqual(of('192.168.2.2'), ['deny'], '不在 available-from 內：service-refused');
});

test('zone 矩陣：available-from 只含網段的一部分時，代表位址在兩邊各有一個', () => {
  const s = twoNets(['/ip service set ssh address=192.168.1.0/25']);
  const rows = selfMatchesReach(s, { services: [{ proto: 'tcp', port: 22 }] });
  const srcs = Array.from(new Set(rows.filter((r) => r[0].startsWith('192.168.1.')).map((r) => r[0])));
  const verdicts = new Set(rows.filter((r) => r[0].startsWith('192.168.1.')).map((r) => r[3]));
  assert.ok(srcs.length >= 2 && verdicts.has('allow') && verdicts.has('deny'), `${srcs.join('、')}：${Array.from(verdicts).join('、')}`);
});

test('zone 矩陣：有 dst-nat 時（目的可能改寫成設備自己），available-from 的判斷也與 Q.reach 相同', () => {
  const s = twoNets([
    '/ip service set ssh address=192.168.1.0/24',
    '/ip firewall nat add action=dst-nat chain=dstnat dst-address=192.168.2.1 dst-port=2222 protocol=tcp to-addresses=192.168.1.1 to-ports=22',
  ]);
  selfMatchesReach(s, { services: [{ proto: 'tcp', port: 22 }, { proto: 'tcp', port: 2222 }] });
});

test('zone 矩陣：範例資料「→ 網路設備（管理）」的每個來源代表與 Q.reach 相同（含 /ip service 的 available-from）', () => {
  assert.ok(selfMatchesReach(sampleSnap()).length > 0);
});

test('available-from 的判斷只有一份（S.reach._.inAvailableFrom，localService 與節點鍵共用）：網段內接受、網段外不接受、無法解析的項目不接受', () => {
  const { afNets, inAvailableFrom } = S.reach._;
  const nets = afNets(['192.168.1.0/24', 'not-an-ip', '10.0.0.5']);
  assert.strictEqual(nets[1], null);
  assert.deepStrictEqual(['192.168.1.7', '192.168.2.7', '10.0.0.5', '10.0.0.6'].map((ip) => inAvailableFrom(ip, nets)), [true, false, true, false]);
  assert.strictEqual(inAvailableFrom('192.168.1.7', afNets(['bogus'])), false);
});
