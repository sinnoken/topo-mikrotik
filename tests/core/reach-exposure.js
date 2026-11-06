// L4 由外而內：暴露清單 Q.exposure（從 WAN 進來，連得到哪些位址、哪些服務；查詢時計算，不寫進 Snapshot）
'use strict';
const assert = require('assert');
const { S, build, test, sampleSnap } = require('../lib.js');

const exposureOf = (Q, o) => Q.exposure(o);
const stepsOf = (Q, o) => Q.exposureSteps(o);

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/**
 * 一台邊界路由器 R1：WAN 198.51.100.2/30（ether1）、LAN 192.168.1.0/24（bridge1）、沒有 NAT 的公網網段 203.0.113.0/29（ether3）。
 * input：Winbox 只開給 192.0.2.0/24、放行 icmp、其餘從 WAN 丟棄；forward：放行經 dst-nat 的、公網 203.0.113.2:443、
 * 203.0.113.3:25（只限 address-list，內容不在基準）、203.0.113.4:5000-5010，其餘從 WAN 丟棄；dst-nat 8080 → 192.168.1.10:80。
 * SW1 只有 LAN 的管理位址（排序測試用：與 R1 交換順序，結果相同）。
 */
const R1 = [
  'R1 (192.168.1.1):',
  '### /export terse',
  '/interface bridge add name=bridge1',
  '/interface list add name=WAN', '/interface list add name=LAN',
  '/interface list member add interface=bridge1 list=LAN', '/interface list member add interface=ether1 list=WAN',
  '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0',
  '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
  '/ip address add address=203.0.113.1/29 interface=ether3 network=203.0.113.0',
  '/ip firewall filter add action=accept chain=input dst-port=8291 in-interface-list=WAN protocol=tcp src-address=192.0.2.0/24',
  '/ip firewall filter add action=accept chain=input protocol=icmp',
  '/ip firewall filter add action=drop chain=input in-interface-list=WAN',
  '/ip firewall filter add action=accept chain=forward connection-nat-state=dstnat',
  '/ip firewall filter add action=accept chain=forward dst-address=203.0.113.2 dst-port=443 in-interface-list=WAN protocol=tcp',
  '/ip firewall filter add action=accept chain=forward dst-address=203.0.113.3 dst-port=25 in-interface-list=WAN protocol=tcp src-address-list=PARTNERS',
  '/ip firewall filter add action=accept chain=forward dst-address=203.0.113.4 dst-port=5000-5010 in-interface-list=WAN protocol=tcp',
  '/ip firewall filter add action=drop chain=forward in-interface-list=WAN',
  '/ip firewall nat add action=dst-nat chain=dstnat dst-port=8080 in-interface-list=WAN protocol=tcp to-addresses=192.168.1.10 to-ports=80',
  '/ip firewall nat add action=masquerade chain=srcnat out-interface-list=WAN',
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge1 distance=0',
  ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
  ' DAc dst-address=203.0.113.0/29 routing-table=main gateway=ether3 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1',
  '',
];
const SW1 = [
  'SW1 (192.168.1.2):',
  '### /ip address print detail without-paging', 'Flags: X - disabled, I - invalid, D - dynamic',
  ' 0   address=192.168.1.2/24 network=192.168.1.0 interface=bridge1 actual-interface=bridge1',
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge1 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=192.168.1.1 distance=1',
  '',
];
const edge = () => build(R1.concat(SW1).join('\n'));
const find = (sec, ip, service) => sec.rows.find((r) => r.ip === ip && r.service === service);

test('Q.exposure：外部 → 路由器本身（input）：Winbox 只開給特定來源時列出允許的範圍；被 drop 的不列、只計數', () => {
  const s = edge(); const Q = S.query(s);
  const x = exposureOf(Q);
  assert.strictEqual(x.status, 'ok');
  assert.deepStrictEqual(x.wan.entries, [{ dev: 'R1', ep: 'R1|ether1', vrf: 'main' }]);
  const wb = find(x.self, '198.51.100.2', 'tcp/8291');
  assert.ok(wb, JSON.stringify(x.self.rows.map((r) => [r.ip, r.service])));
  assert.deepStrictEqual([wb.dev, wb.dst, wb.target, wb.zone, wb.verdict, wb.allowedFrom.kind, wb.allowedFrom.ranges], ['R1', '198.51.100.2', 'R1', 'self', 'allow', 'limited', [['192.0.2.0', '192.0.2.255']]]);
  const acc = s.model.firewallRules.find((r) => r.chain === 'input' && r.match['dst-port'] === '8291');
  assert.deepStrictEqual([wb.rule.key, wb.rule.src], [acc.key, acc.src], '決定結果的規則附來源行');
  const icmp = find(x.self, '198.51.100.2', 'icmp');
  assert.deepStrictEqual([icmp.verdict, icmp.allowedFrom.kind], ['allow', 'any']);
  assert.strictEqual(find(x.self, '198.51.100.2', 'tcp/22'), undefined, '被 drop 的不列');
  assert.ok(x.self.counts.deny > 0 && x.self.counts.candidates === x.self.counts.allow + x.self.counts.unknown + x.self.counts.deny + x.self.counts.natted);
  assert.ok(x.self.rows.every((r) => r.verdict === 'allow' || r.verdict === 'unknown'));
  assert.strictEqual(s.model.exposure, undefined, '不寫進 Snapshot');
  assert.ok(Object.isFrozen(x) && Object.isFrozen(x.self.rows[0]));
  assert.strictEqual(exposureOf(Q), x, '同樣的參數回傳快取');
});

test('Q.exposure：外部 → 內部（dst-nat）：公網位址:埠 → 內部位址:埠，附 dst-nat 規則；只在 WAN 介面的位址列出', () => {
  const s = edge(); const x = exposureOf(S.query(s));
  assert.deepStrictEqual(x.dnat.rows.map((r) => [r.dst, r.service, r.verdict, r.nat.from, r.nat.to, r.target]), [['198.51.100.2', 'tcp/8080', 'allow', '198.51.100.2:8080', '192.168.1.10:80', '192.168.1.0/24']]);
  const dn = s.model.firewallRules.find((r) => r.action === 'dst-nat');
  assert.strictEqual(x.dnat.rows[0].nat.rule.key, dn.key);
  assert.deepStrictEqual(x.services.find((v) => v.id === 'tcp/8080').origins, ['dst-nat']);
  assert.strictEqual(x.self.rows.some((r) => r.service === 'tcp/8080'), false, '經 dst-nat 改寫的不列在本身');
  assert.ok(x.self.counts.natted > 0 && x.routed.counts.natted > 0, 'LAN 位址與內部代表位址經同一條 dst-nat 改寫的只計數');
});

test('Q.exposure：外部 → 內部（直接路由）：沒有 NAT 的公網網段放行、條件無法判斷列為 unknown、埠範圍取代表埠並記下範圍', () => {
  const x = exposureOf(S.query(edge()));
  const web = find(x.routed, '203.0.113.2', 'tcp/443');
  assert.ok(web, JSON.stringify(x.routed.rows.map((r) => [r.ip, r.service, r.verdict])));
  assert.deepStrictEqual([web.verdict, web.allowedFrom.kind, web.subnet, web.target, web.nat], ['allow', 'any', '203.0.113.0/29', '203.0.113.0/29', undefined]);
  const smtp = find(x.routed, '203.0.113.3', 'tcp/25');
  assert.deepStrictEqual([smtp.verdict, smtp.reasons], ['unknown', ['rule-condition']]);
  const codes = new Set(S.query.reachReasonCodes().map((c) => c.code));
  assert.ok(x.routed.rows.every((r) => r.reasons.every((c) => codes.has(c))), '原因代碼都在 REASON_CODES');
  assert.deepStrictEqual(x.services.find((v) => v.id === 'tcp/25').origins, ['filter']);
  const rng = x.services.find((v) => v.id === 'tcp/5000');
  assert.deepStrictEqual([rng.range, rng.origins], [[5000, 5010], ['filter']]);
  assert.strictEqual(find(x.routed, '203.0.113.4', 'tcp/5000').portRange[1], 5010);
  assert.strictEqual(x.routed.rows.some((r) => r.ip.startsWith('192.168.1.')), false, 'LAN 被 forward 的 drop 擋下，不列');
  assert.ok(x.routed.counts.deny > 0);
  // 沒有 IPv6 位址的事實：回傳說明，不是空結果（IPv6 的列見 tests/core/reach-ipv6.js）
  assert.deepStrictEqual([x.ipv6.status, typeof x.ipv6.message, x.ipv6.evaluated], ['no-ipv6-address', 'string', []]);
  assert.ok(x.routed.rows.concat(x.self.rows, x.dnat.rows).every((r) => r.family === 'ipv4'));
  assert.deepStrictEqual(x.assumptions.slice(0, S.query.reachAssumptions().length), JSON.parse(JSON.stringify(S.query.reachAssumptions())), '先列 Q.reach 的前提');
});

test('Q.exposure 的前提：在 Q.reach 的前提之後附加暴露清單另有的兩條（只出現在暴露清單，Q.reach 與 S.query.reachAssumptions 不變）', () => {
  const EXTRA = ['exposure-source-ranges', 'wan-member-no-interface'];
  const base = S.query.reachAssumptions();
  const Q = S.query(edge());
  const x = exposureOf(Q);
  assert.deepStrictEqual(x.assumptions.map((a) => a.code), base.map((a) => a.code).concat(EXTRA));
  assert.deepStrictEqual(x.assumptions.slice(0, base.length), JSON.parse(JSON.stringify(base)));
  assert.ok(Object.isFrozen(x.assumptions) && x.assumptions.every((a) => Object.isFrozen(a)), '凍結');
  // 沒有 WAN 的提早結束也帶同一份前提
  const none = exposureOf(S.query(build(R1.filter((l) => !l.includes('list=WAN') && !l.includes('name=WAN')).concat(SW1).join('\n'))));
  assert.deepStrictEqual(none.assumptions, JSON.parse(JSON.stringify(x.assumptions)));
  assert.ok(base.every((a) => !EXTRA.includes(a.code)), 'S.query.reachAssumptions 不含暴露清單的前提');
  const rc = Q.reach('192.168.1.10', '203.0.113.2', { proto: 'tcp', port: 443 });
  assert.deepStrictEqual(rc.assumptions.map((a) => a.code), base.map((a) => a.code), 'Q.reach 的前提不變');
  // 寫法同 Q.reach 的前提：括號外不出現 RouterOS 的英文原值，原值保留在括號內
  const ALLOWED = new Set(['RouterOS', 'IPv4', 'VRF', 'main']);
  x.assumptions.filter((a) => EXTRA.includes(a.code)).forEach((a) => {
    const words = (a.message.replace(/（[^（）]*）/g, '').match(/[A-Za-z@/][A-Za-z0-9_=@/.<>-]*/g) || []).filter((w) => !ALLOWED.has(w));
    assert.deepStrictEqual(words, [], `${a.code}：括號外有英文原值 ${words.join('、')}`);
  });
  const text = x.assumptions.map((a) => a.message).join('\n');
  ['src-address', 'available-from', '/routing rule', 'allowedFrom', '/ip address', '/interface list member'].forEach((w) => assert.ok(text.includes(w), '應保留原值 ' + w));
});

test('Q.exposure：沒有任何對外入口時回傳說明（不靜默）；沒有 WAN 清單、但有預設路由的出介面（對外邊界的強證據）時仍是入口', () => {
  const noList = R1.filter((l) => !l.includes('list=WAN') && !l.includes('name=WAN'));
  // 預設路由經 ether1：Q.boundaryOf 為 external，入口與矩陣的外部 zone 相同
  const Qd = S.query(build(noList.concat(SW1).join('\n')));
  const xd = exposureOf(Qd);
  assert.deepStrictEqual([xd.status, xd.wan.entries], ['ok', [{ dev: 'R1', ep: 'R1|ether1', vrf: 'main' }]]);
  assert.deepStrictEqual(Qd.wanEntries().map((w) => [w.ep, w.wanList]), [['R1|ether1', false]], '檢查用的入口與 L4 相同：WAN 清單成員＋邊界判定為 external 的介面');
  assert.deepStrictEqual(Qd.zoneMatrix().zones.find((z) => z.id === 'external').devices, ['R1']);
  // 也沒有預設路由：沒有任何證據
  const text = noList.filter((l) => !l.includes('dst-address=0.0.0.0/0')).concat(SW1).join('\n');
  const x = exposureOf(S.query(build(text)));
  assert.strictEqual(x.status, 'no-wan');
  assert.ok(x.message && x.message.includes('對外'));
  assert.deepStrictEqual([x.self.rows, x.dnat.rows, x.routed.rows, x.wan.entries], [[], [], [], []]);
});

test('Q.exposure：排序穩定，與輸入中設備的順序無關；分段計算的結果與一次算完相同', () => {
  const a = exposureOf(S.query(edge()));
  const b = exposureOf(S.query(build(SW1.concat(R1).join('\n'))));
  // 來源行號隨區塊順序改變，其餘逐字相同
  const noSrc = (v) => JSON.parse(JSON.stringify(v, (k, y) => (k === 'src' ? undefined : y)));
  assert.deepStrictEqual(noSrc(b), noSrc(a));
  const Q = S.query(edge()); const it = stepsOf(Q); let r = it.next(); const stages = [];
  while (!r.done) { stages.push(r.value.stage); r = it.next(); }
  assert.ok(stages.includes('evaluate'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.value)), JSON.parse(JSON.stringify(a)));
  assert.strictEqual(exposureOf(Q), r.value, '跑完分段之後命中快取');
  const lim = exposureOf(S.query(edge()), { maxEvaluations: 5 });
  assert.deepStrictEqual([lim.limits.truncated, lim.limits.evaluations], [true, 5], '超過上限時標示截斷');
  assert.throws(() => exposureOf(S.query(edge()), { maxEvaluations: 0 }), TypeError);
});

test('Q.exposure（範例資料）：與 zone 矩陣「外部」列一致（允許的組合不矛盾）', () => {
  const Q = S.query(sampleSnap());
  const x = exposureOf(Q); const mx = Q.zoneMatrix();
  assert.strictEqual(x.status, 'ok');
  assert.ok(x.dnat.rows.some((r) => r.service === 'tcp/8443' && r.nat.to === '10.1.20.11:443' && r.verdict === 'allow'), 'WAN 經 dst-nat 連到伺服器');
  const svc = new Set(mx.services.map((v) => v.id));
  // 矩陣「外部 → X」有允許時，暴露清單在對應的段落也有允許
  mx.cells.filter((c) => c.src === 'external' && c.counts.allow > 0).forEach((c) => {
    const rows = c.dst === 'self' ? x.self.rows : x.dnat.rows.concat(x.routed.rows).filter((r) => r.zone === c.dst);
    assert.ok(rows.some((r) => r.verdict === 'allow'), `矩陣 external → ${c.dst} 有允許，暴露清單也要有`);
  });
  // 反過來：暴露清單中以矩陣的代表位址允許、矩陣也算的 service，矩陣那一格要有允許
  x.dnat.rows.concat(x.routed.rows).filter((r) => r.verdict === 'allow' && svc.has(r.service) && r.zone).forEach((r) => {
    const c = mx.cells.find((y) => y.src === 'external' && y.dst === r.zone);
    assert.ok(c && c.services.find((v) => v.service === r.service).counts.allow > 0, `${r.dst} ${r.service} 允許，矩陣 external → ${r.zone} 也要允許`);
  });
  // 暴露清單的 self 段只列入口設備自己的位址；矩陣的「網路設備（管理）」另有各網段閘道（入口以外的設備），只比對入口設備的
  const selfCell = Q.zoneCell('external', 'self'); const entryDevs = new Set(x.wan.devices);
  selfCell.groups.filter((g) => entryDevs.has(g.dst.dev)).forEach((g) => g.services.forEach((sv) => {
    const row = find(x.self, g.dst.ip, sv.service);
    if (sv.verdict === 'allow') assert.ok(row && row.verdict === 'allow', `矩陣允許 ${g.dst.ip} ${sv.service}`);
  }));
});

const reachOf = (Q, src, dst, service, entry) => {
  const [proto, port] = service.split('/');
  return Q.reach(src, dst, Object.assign({ proto, entry }, port ? { port: +port } : {}));
};

test('Q.exposure 與 Q.reach 不矛盾：每一列以它的來源代表與入口介面查 Q.reach，結果相同（範例資料與手寫資料）', () => {
  [S.query(sampleSnap()), S.query(edge())].forEach((Q) => {
    const x = exposureOf(Q);
    // Q.reach 只算 IPv4；IPv6 的列（只看邊界路由器）不經 Q.reach
    ['self', 'dnat', 'routed'].forEach((k) => x[k].rows.filter((r) => r.family === 'ipv4').forEach((r) => {
      const rc = reachOf(Q, r.src, r.ip, r.service, r.entry);
      assert.strictEqual(rc.verdict, r.verdict, `${k} ${r.dev} ${r.ip} ${r.service}（入口 ${r.entry}）`);
    }));
  });
});

test('Q.exposure 每一列的分層結果（route／filter）與 Q.reach(src, ip, { proto, port, entry }) 的 paths[] 一致；IPv6 的列 route 為 null', () => {
  const DENY = new Set(S.trace.ROUTE_DENY);
  [S.query(sampleSnap()), S.query(edge())].forEach((Q) => {
    const x = exposureOf(Q); let n = 0;
    ['self', 'dnat', 'routed'].forEach((k) => x[k].rows.forEach((r) => {
      assert.ok(r.filter && Array.isArray(r.filter.reasons), JSON.stringify(r.filter));
      if (r.family === 'ipv6') { assert.deepStrictEqual([r.route, r.filter.status], [null, r.verdict]); return; }
      const rc = reachOf(Q, r.src, r.ip, r.service, r.entry); const at = `${k} ${r.dev} ${r.ip} ${r.service}（入口 ${r.entry}）`;
      const ss = S.util.uniq(rc.paths.map((p) => p.route.status));
      const rs = ss.length === 1 ? ss[0] : 'unknown';
      assert.deepStrictEqual([r.route.status, r.route.code], [rs, ss.length === 1 ? rc.paths[0].route.code : 'branches-differ'], at);
      assert.strictEqual(r.filter.status, DENY.has(rs) ? 'n/a' : rc.verdict, at);
      const withRule = rc.paths.find((p) => p.filter.rule);
      assert.deepStrictEqual(r.filter.rule, withRule ? withRule.filter.rule : null, at);
      // 原因是各路徑的聯集
      const codes = (list) => S.util.uniq(list.map((y) => y.code)).sort();
      assert.deepStrictEqual(codes(r.route.reasons), codes(rc.paths.flatMap((p) => p.route.reasons)), at);
      assert.deepStrictEqual(codes(r.filter.reasons), codes(rc.paths.flatMap((p) => p.filter.reasons)), at);
      n++;
    }));
    assert.ok(n > 0);
  });
  // 範例資料：經 WAN 的允許列至少有一列路由抵達、防火牆允許
  const x = exposureOf(S.query(sampleSnap()));
  assert.ok(x.routed.rows.concat(x.dnat.rows).some((r) => r.route && r.route.status === 'reached' && r.filter.status === 'allow'));
});

test('zone 矩陣「外部 → 網路設備」與 Q.reach 一致：/ip service 的埠不和沒有規則提到的埠併成同一類（RT_02 的 www-ssl tcp/443）', () => {
  const Q = S.query(sampleSnap());
  const c = Q.zoneCell('external', 'self');
  const g = c.groups.find((y) => y.dst.ip === '203.0.113.6' && y.srcs.some((s) => s.entry === 'TPE_CORE_RT_02|ether47'));
  assert.strictEqual(g.services.find((s) => s.service === 'tcp/443').verdict, 'allow', 'F07：www-ssl 從 WAN 可以連入');
  c.groups.forEach((y) => y.srcs.forEach((s) => y.services.forEach((sv) => {
    assert.strictEqual(reachOf(Q, s.ip, y.dst.ip, sv.service, s.entry).verdict, sv.verdict, `${s.entry} → ${y.dst.ip} ${sv.service}`);
  })));
  // 牽涉的規則：chain 預設（policy）的列也帶動作
  Q.zoneCell('external', 'vlan:20').ruleDetails.filter((r) => r.policy).forEach((r) => assert.ok(typeof r.verdict === 'string', JSON.stringify(r)));
});

test('Q.exposure：每列帶畫面要的欄位（服務名稱、入口介面、dst-nat 是否限制目的、相關檢查）；整體帶拒絕計數、F08 與缺防火牆的設備', () => {
  const Q = S.query(sampleSnap()); const x = exposureOf(Q);
  const ssl = find(x.self, '203.0.113.6', 'tcp/443');
  assert.deepStrictEqual([ssl.dev, ssl.serviceName, ssl.entry, ssl.inInterface, ssl.proto, ssl.port], ['TPE_CORE_RT_02', 'www-ssl', 'TPE_CORE_RT_02|ether47', 'ether47', 'tcp', 443]);
  const f07 = Q.findingsByRule('F07').filter((f) => f.entities.some((e) => e.key === 'TPE_CORE_RT_02|www-ssl')).map((f) => Q.findingKey(f));
  assert.ok(f07.length && f07.every((k) => ssl.findingKeys.includes(k)), 'F07 對到這一列');
  const proxy = find(x.self, '203.0.113.6', 'tcp/8080');
  assert.ok(proxy && proxy.serviceName === 'web-proxy' && proxy.findingKeys.some((k) => k.includes('F14')), 'F14 的 web proxy 埠在候選服務中');
  assert.ok(x.services.find((v) => v.id === 'tcp/8080').origins.includes('mgmt'));
  const dn = x.dnat.rows[0];
  assert.deepStrictEqual([dn.dstAny, dn.findingKeys.some((k) => k.includes('F04'))], [true, true]);
  assert.deepStrictEqual(x.denied, { self: x.self.counts.deny, dnat: x.dnat.counts.deny, routed: x.routed.counts.deny });
  assert.deepStrictEqual(x.noWan.map((n) => n.dev), Q.findingsByRule('F08').map((f) => Q.findingDevice(f)).sort());
  assert.ok(Array.isArray(x.noFirewall));
  const e = exposureOf(S.query(edge()));
  assert.strictEqual(find(e.self, '198.51.100.2', 'tcp/8291').inInterface, 'ether1', '沒有介面紀錄時用介面鍵的名稱');
});
