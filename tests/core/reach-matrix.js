// zone 矩陣（Q.zoneMatrix）的計算共用：service 等價類、設備本身的子類共用判斷、記錄依類合併，結果都要與逐一判斷相同
'use strict';
const assert = require('assert');
const { S, test, sampleSnap, gen, build } = require('../lib.js');

/**
 * 每個 service 單獨算一次矩陣（只有一個 service：沒有等價類、子類與合併的記錄），
 * 每一格的這個 service 的結果（狀態、計數、拒絕的原因）要與一次算全部 service 的那一欄相同；格子的合計是各 service 的和。
 */
const perServiceEqual = (s) => {
  const Q = S.query(s);
  const all = Q.zoneMatrix();
  const svcs = all.services.map((x) => ({ proto: x.proto, port: x.port }));
  const full = S.query(s).zoneMatrix({ services: svcs });
  assert.strictEqual(JSON.stringify(full.cells), JSON.stringify(all.cells), '明確列出同一份 service 時結果相同');
  const sum = new Map(full.cells.map((c) => [c.src + '|' + c.dst, { allow: 0, deny: 0, unknown: 0, total: 0, noRoute: 0, filter: 0 }]));
  svcs.forEach((sv, i) => {
    const one = S.query(s).zoneMatrix({ services: [sv] });
    const byKey = new Map(one.cells.map((c) => [c.src + '|' + c.dst, c]));
    full.cells.forEach((c) => {
      const o = byKey.get(c.src + '|' + c.dst);
      const got = c.services[i]; const want = o ? o.services[0] : null;
      const tag = `${c.src} → ${c.dst} ${got.service}`;
      if (!want) { assert.strictEqual(got.status, 'empty', tag); return; }
      assert.deepStrictEqual([got.status, got.incomplete, got.counts, got.deniedBy], [want.status, want.incomplete, want.counts, want.deniedBy], tag);
      const e = sum.get(c.src + '|' + c.dst); ['allow', 'deny', 'unknown', 'total'].forEach((k) => { e[k] += want.counts[k]; }); e.noRoute += want.deniedBy.noRoute; e.filter += want.deniedBy.filter;
    });
  });
  full.cells.forEach((c) => {
    const e = sum.get(c.src + '|' + c.dst);
    assert.deepStrictEqual([c.counts, c.deniedBy], [{ allow: e.allow, deny: e.deny, unknown: e.unknown, total: e.total }, { noRoute: e.noRoute, filter: e.filter }], `${c.src} → ${c.dst} 的合計`);
  });
  return { all, Q };
};

test('zone 矩陣：範例資料一次算全部 service 與每個 service 單獨算的結果相同（等價類、子類共用與記錄合併不改結果）', () => {
  const { all } = perServiceEqual(sampleSnap());
  assert.ok(all.zones.some((z) => z.virtual && !z.dstOnly) && all.zones.some((z) => z.virtual && z.dstOnly), '範例資料有外部與網路設備（管理）兩個虛擬 zone');
});

test('zone 矩陣：小型產生資料（3 個站點）一次算全部 service 與每個 service 單獨算的結果相同', () => {
  perServiceEqual(build(gen(['--sites', '3', '--access', '4'])));
});

test('zone 矩陣：分段計算最後回報實際的判斷次數（evaluate 的 done），不超過上限（total），且少於「來源 × 目的 × 子類」逐一判斷', () => {
  const s = build(gen(['--sites', '3', '--access', '4']));
  const it = S.query(s).zoneMatrixSteps(); let r = it.next(); let last = null;
  while (!r.done) { if (r.value.stage === 'evaluate') last = r.value; r = it.next(); }
  assert.ok(last && last.done > 0 && last.done <= last.total, JSON.stringify(last));
  // 產生資料的設備本身目的有多個子類（/ip service 啟用與停用），從外部被 input 擋下的不必逐一判斷
  assert.ok(last.done < last.total, `判斷 ${last.done} 次，上限 ${last.total}`);
  assert.strictEqual(JSON.stringify(r.value), JSON.stringify(S.query(s).zoneMatrix()), '分段與同步的結果相同');
});

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/** 邊界路由器 R：ether1 是 WAN（198.51.100.2/30）、ether2 是 LAN（192.168.1.1/24），input 只擋 WAN；lines 加在 /export 之後。 */
const edge = (lines) => build([
  'R (192.168.1.1):',
  '### /export terse',
  '/interface list add name=WAN', '/interface list add name=LAN',
  '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=ether2 list=LAN',
  '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
  '/ip address add address=192.168.1.1/24 interface=ether2 network=192.168.1.0',
  '/ip firewall filter add action=accept chain=input in-interface-list=LAN',
  '/ip firewall filter add action=drop chain=input in-interface-list=WAN',
].concat(lines, [
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=ether2 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1',
  '',
]).join('\n'));

test('zone 矩陣：「網路設備（管理）」的目的只有 IPv4 位址（介面上的 IPv6 位址不當成 IPv4 目的判斷）', () => {
  const s = edge([]);
  // 基準目前沒有 /ipv6 address 的事實：同 tests/core/reach-ipv6.js，直接加進 ipAddresses（family 6）
  [['ether1', '3fff:0:1::2/64'], ['ether2', '3fff:0:2::1/64']].forEach(([ifc, address]) => {
    const [ip, len] = address.split('/');
    s.model.ipAddresses.push({ address, ip, len: +len, family: 6, vrf: 'main', role: null, dev: 'R', ep: 'R|' + ifc, hearsay: false, src: [[0, 0]] });
  });
  const Q = S.query(s);
  assert.ok(Q.ipsOf('R|ether1').some((a) => a.ip.includes(':')), '前提：介面上有 IPv6 位址');
  const mx = Q.zoneMatrix();
  assert.strictEqual(mx.stats.deviceTargets, 2, '198.51.100.2（入口）與 192.168.1.1（閘道）');
  const dsts = ['external', 'vlan:1', ...mx.zones.filter((z) => !z.virtual).map((z) => z.id)].flatMap((src) => (mx.zones.some((z) => z.id === src) ? Q.zoneCell(src, 'self').groups.map((g) => g.dst.ip) : []));
  assert.ok(dsts.length && dsts.every((ip) => !ip.includes(':')), JSON.stringify(dsts));
});

test('zone 矩陣：預設的 service 包含目的設備自己開著的 /ip service 埠與管理服務（SNMP 等），停用的不加', () => {
  const s = edge(['/ip service set ssh port=2222', '/ip service set telnet port=2323 disabled=yes', '/snmp set enabled=yes', '/ip dns set allow-remote-requests=yes']);
  const Q = S.query(s); const mx = Q.zoneMatrix();
  const ids = mx.services.map((x) => x.id);
  ['tcp/2222', 'udp/161', 'tcp/53', 'udp/53'].forEach((id) => assert.ok(ids.includes(id), `${id}：${ids.join('、')}`));
  assert.ok(!ids.includes('tcp/2323'), '停用的 /ip service 不加');
  // 外部 → 網路設備：WAN 的 input 丟棄，新加的服務也是拒絕；LAN → 網路設備：允許（/ip service 的 ssh 在 2222）
  const ext = mx.cells.find((c) => c.src === 'external' && c.dst === 'self');
  ['tcp/2222', 'udp/161'].forEach((id) => assert.strictEqual(ext.services.find((x) => x.service === id).status, 'deny', id));
  const lan = mx.cells.find((c) => c.src !== 'external' && c.dst === 'self' && c.counts.total);
  assert.strictEqual(lan.services.find((x) => x.service === 'tcp/2222').status, 'allow');
  // 有給 services 時照用，不另加
  assert.deepStrictEqual(Q.zoneMatrix({ services: [{ proto: 'tcp', port: 22 }] }).services.map((x) => x.id), ['tcp/22']);
});

test('zone 矩陣：下鑽（zoneCell）的摘要與 L0 的格子相同，每一組的 service 結果合計等於格子的計數', () => {
  const s = sampleSnap(); const Q = S.query(s);
  const mx = Q.zoneMatrix();
  mx.cells.filter((c) => c.status !== 'empty').forEach((c) => {
    const z = Q.zoneCell(c.src, c.dst);
    const { groups, ruleDetails, ...sm } = z;
    assert.strictEqual(JSON.stringify(sm), JSON.stringify(c), `${c.src} → ${c.dst} 的摘要`);
    const n = { allow: 0, deny: 0, unknown: 0 };
    groups.forEach((g) => g.srcs.forEach(() => g.services.forEach((x) => { n[x.verdict]++; })));
    assert.deepStrictEqual(n, { allow: c.counts.allow, deny: c.counts.deny, unknown: c.counts.unknown }, `${c.src} → ${c.dst} 的各組合計`);
  });
});
