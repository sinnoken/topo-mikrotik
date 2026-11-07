// 判斷的前提（L3 路由層＋L4 防火牆層與推論假設）：文字與程式同一套邏輯。
// 每條前提一個最小可執行範例（程式的行為與文字一致）、原因與前提雙向對應、文字中的常數由程式常數產生、Q.assumptionUse 在範例資料與手寫資料的結果。
// 測試資料依 RouterOS 手冊撰寫（防火牆 https://manual.mikrotik.com/docs/cli-reference/ip/firewall/filter.md、
// 策略路由 https://manual.mikrotik.com/docs/user-guides/routing-and-networking-protocols/routing-decision.md），不是實機擷取。
'use strict';
const assert = require('assert');
const { S, read, build, test, sampleSnap } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/** 邊界路由器 R：WAN ether1（198.51.100.2/30）、LAN bridge1（192.168.1.0/24）、第二條出口 ether8 與路由表 isp2；extra 是另加的 export 行。 */
const R = (extra, routes) => ['R (192.168.1.1):', '### /export terse',
  '/interface bridge add name=bridge1',
  '/interface list add name=WAN', '/interface list member add interface=ether1 list=WAN',
  '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0',
  '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
  '/ip address add address=10.8.0.1/24 interface=ether8 network=10.8.0.0',
  '/routing table add disabled=no fib name=isp2',
  ...(extra || []),
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge1 distance=0',
  ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
  ' DAc dst-address=10.8.0.0/24 routing-table=main gateway=ether8 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1',
  ' As dst-address=0.0.0.0/0 routing-table=isp2 gateway=10.8.0.254 distance=1', ...(routes || []), ''];
/** LAN 上另一台有 /export 的路由器 R2（192.168.1.3），是 10.20.0.0/24 的閘道（10.20.0.1），只讓 203.0.113.0/24 連 SSH。R 經 192.168.1.3 到 10.20.0.0/24。 */
const R2 = ['R2 (192.168.1.3):', '### /export terse',
  '/ip address add address=192.168.1.3/24 interface=ether1 network=192.168.1.0',
  '/ip address add address=10.20.0.1/24 interface=ether2 network=10.20.0.0',
  '/ip firewall filter add action=drop chain=input src-address=203.0.113.0/24',
  '/ip firewall filter add action=accept chain=input dst-port=22 protocol=tcp',
  '/ip firewall filter add action=drop chain=input',
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=ether1 distance=0',
  ' DAc dst-address=10.20.0.0/24 routing-table=main gateway=ether2 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=192.168.1.1 distance=1', ''];
const TO_R2 = ' As dst-address=10.20.0.0/24 routing-table=main gateway=192.168.1.3 distance=1';
const net = (extra, more, routes) => S.query(build(R(extra, routes).concat(more || []).join('\n')));
const FWD = (m) => `/ip firewall filter add action=drop chain=forward ${m}`;
const use = (Q, code) => Q.assumptionUse().find((a) => a.code === code);
const allAssumptions = () => S.query.traceAssumptions().concat(S.query.reachAssumptions(), S.query.exposureAssumptions());
const reasonsOf = (r) => r.reasons.concat(r.notes);
/** 原因實際對到的前提（每個原因各自的）。 */
const linked = (r) => reasonsOf(r).map((x) => [x.code, S.query.reasonAssumptions(x.code, x)]);
const LAN = '192.168.1.10'; const OUT = '8.8.8.8';

test('前提分層：路由層在 S.trace.ASSUMPTIONS（L3 與 L4 共用），L4 只有防火牆層與推論假設；每條有 short（一句、≤25 字、括號外沒有參數名）與 detail', () => {
  const tr = S.query.traceAssumptions(); const l4 = S.query.reachAssumptions();
  assert.strictEqual(tr, S.trace.ASSUMPTIONS);
  assert.deepStrictEqual(tr.map((a) => a.code), ['ipv4-vrf', 'policy-routing', 'mark-routing', 'bridge-ip-firewall']);
  assert.ok(tr.every((a) => a.layer === 'route') && l4.every((a) => a.layer === 'filter' || a.layer === 'assumption'));
  assert.ok(S.query.exposureAssumptions().every((a) => a.layer === 'assumption'));
  const ALLOWED = new Set(['RouterOS', 'IPv4', 'VRF', 'main']);
  const all = allAssumptions();
  assert.strictEqual(new Set(all.map((a) => a.code)).size, all.length, 'code 不重複');
  all.forEach((a) => {
    assert.ok(Object.isFrozen(a), `${a.code} 凍結`);
    assert.ok(typeof a.short === 'string' && a.short.length > 0 && Array.from(a.short).length <= 25, `${a.code} 的 short 不超過 25 字：${a.short}`);
    assert.ok(!/[。；]/.test(a.short), `${a.code} 的 short 是一句`);
    const words = (a.short.replace(/（[^（）]*）/g, '').match(/[A-Za-z@/][A-Za-z0-9_=@/.<>-]*/g) || []).filter((w) => !ALLOWED.has(w));
    assert.deepStrictEqual(words, [], `${a.code} 的 short 括號外有參數名：${a.short}`);
    assert.ok(a.detail.length > a.short.length && a.message === a.detail, `${a.code}：detail 是完整說明，message 同 detail`);
  });
  // Q.reach 與 Q.exposure 的結果仍列出完整的前提（路由層＋L4；暴露清單另加兩條），畫面相容
  const Q = net();
  assert.deepStrictEqual(Q.reach(LAN, OUT, { proto: 'tcp', port: 443 }).assumptions.map((a) => a.code), tr.concat(l4).map((a) => a.code));
  assert.deepStrictEqual(Q.exposure().assumptions.map((a) => a.code), all.map((a) => a.code));
  assert.ok(/L3 路由追蹤/.test(S.query.reachDefinition()) && /raw → nat → filter/.test(S.query.reachDefinition()) && /「\?」/.test(S.query.reachDefinition()));
});

test('文字中的常數由程式常數產生：可判斷的條件、限速類條件、jump 層數、第一個封包、TTL、外部區段上限、/routing rule 的條件', () => {
  const F = S.infer.fw; const msg = (c) => allAssumptions().find((a) => a.code === c).detail;
  const cond = msg('conditions');
  F.CONDITIONS.filter((k) => k !== 'src-port').concat(F.IFC_CONDITIONS).forEach((k) => assert.ok(cond.includes(k), `conditions 列出可判斷的 ${k}`));
  assert.ok(msg('src-port').includes('src-port') && msg('src-port').includes('port'));
  Array.from(F.NONDET).forEach((k) => assert.ok(cond.includes(k), `conditions 列出 ${k}`));
  assert.ok(cond.includes(`最多 ${F.MAX_JUMP} 層`));
  F.ADDRESS_LIST.forEach((k) => assert.ok(msg('address-list').includes(k)));
  const fp = F.FIRST_PACKET;
  assert.ok(msg('new-connection').includes(`connection-state=${fp.state}`) && msg('new-connection').includes(fp.tcpFlag.toUpperCase()) && msg('new-connection').includes(`type ${fp.icmpType} code ${fp.icmpCode}`));
  assert.ok(msg('ipv4-vrf').includes(`${S.trace.TTL} 跳`));
  assert.ok(msg('exposure-source-ranges').includes(`最多 ${S.reach._.EXPOSURE_MAX_SOURCES} 段`) && S.query.exposureAssumptions()[0].short.includes(`${S.reach._.EXPOSURE_MAX_SOURCES} 段`));
  S.trace.RULE_CONDITIONS.forEach((c) => assert.ok(msg('policy-routing').includes(c.key) && msg('policy-routing').includes(c.label)));
  // 原始碼中前提的文字不手寫這些數字（改常數時文字跟著變）
  const src = read('src/query/reach.js') + read('src/query/trace.js');
  [/最多 16 層/, /最多 16 段/, /最多逐跳走 32/, /type 8 code 0/, /只有 SYN 旗標/].forEach((re) => assert.ok(!re.test(src), `原始碼不應手寫 ${re}`));
  // 條件的分類就是 decide 用的那一份：分類為 condition 的才交給 condition 判斷
  ['protocol', 'dst-port', 'ipsec-policy', 'tcp-flags'].forEach((k) => assert.strictEqual(F.condKind(k), 'condition'));
  assert.deepStrictEqual(['src-address-list', 'in-interface-list', 'limit', 'time', 'packet-mark'].map(F.condKind), ['address-list', 'interface', 'nondet', 'other', 'other']);
});

test('jump 最多 S.infer.fw.MAX_JUMP 層：剛好在上限內的 drop 生效，超過上限的那一層當作沒有決定', () => {
  const F = S.infer.fw;
  const chainOf = (depth) => {
    const chains = new Map();
    let cur = 'forward';
    for (let i = 1; i <= depth; i++) { const next = 'c' + i; chains.set(cur, [{ key: cur, match: {}, action: 'jump', params: { 'jump-target': next }, disabled: false }]); cur = next; }
    chains.set(cur, [{ key: cur, match: {}, action: 'drop', params: {}, disabled: false }]);
    return { dev: 'X', universe: new Set(), resolve: () => null, chain: (fam, table, ch) => chains.get(ch) || [] };
  };
  const pkt = { family: 'ip', reach: true, in: undefined, out: undefined, protocol: 'tcp', dstPort: 22, srcPort: null, src: null, dst: 1n, srcLocal: false, dstLocal: false, state: 'new', natState: null, ipsec: 'none' };
  assert.strictEqual(F.decide(chainOf(F.MAX_JUMP), 'ip', 'filter', 'forward', pkt).verdict, 'drop');
  assert.strictEqual(F.decide(chainOf(F.MAX_JUMP + 1), 'ip', 'filter', 'forward', pkt).verdict, 'accept');
});

test('前提 address-list：用到位址清單的規則是不明，原因對到 address-list；Q.assumptionUse 列出這條規則', () => {
  const Q0 = net(); assert.strictEqual(Q0.reach(LAN, OUT, { proto: 'tcp', port: 443 }).verdict, 'allow');
  assert.strictEqual(use(Q0, 'address-list').status, 'not-used');
  const Q = net([FWD('src-address-list=BAD')]);
  const r = Q.reach(LAN, OUT, { proto: 'tcp', port: 443 });
  assert.strictEqual(r.verdict, 'unknown');
  assert.deepStrictEqual(linked(r), [['rule-condition', ['address-list']]]);
  const u = use(Q, 'address-list'); const rule = Q.firewallRulesOf('R').find((x) => x.match['src-address-list']);
  assert.deepStrictEqual([u.status, u.devices, u.ruleKeys, u.count, u.layer], ['affects', ['R'], [rule.key], 1, 'filter']);
});

test('前提 src-port：比對來源埠的規則是不明（Q.reach 的封包沒有來源埠），原因對到 src-port', () => {
  const Q = net([FWD('protocol=tcp src-port=1024-65535')]);
  const r = Q.reach(LAN, OUT, { proto: 'tcp', port: 443 });
  assert.deepStrictEqual([r.verdict, linked(r)], ['unknown', [['rule-condition', ['src-port']]]]);
  assert.deepStrictEqual([use(Q, 'src-port').status, use(Q, 'src-port').count], ['affects', 1]);
});

test('前提 conditions：判斷不了的條件（例如封包大小、限速）是不明，原因對到 conditions；記錄類（不導向結果）的規則不算', () => {
  const Q = net([FWD('packet-size=0-100'), '/ip firewall filter add action=log chain=forward limit=10,5:packet']);
  const r = Q.reach(LAN, OUT, { proto: 'tcp', port: 443 });
  assert.deepStrictEqual([r.verdict, linked(r)], ['unknown', [['rule-condition', ['conditions']]]]);
  const u = use(Q, 'conditions');
  assert.deepStrictEqual([u.status, u.ruleKeys.length], ['affects', 1], 'log 規則不導向結果，不影響（同 decide）');
  // 設備有啟用中的 IPsec policy 時，ipsec-policy 判斷不了（同 decide 的封包 ipsec 為不明）
  const Qi = net(['/ip ipsec policy add dst-address=10.9.0.0/16 src-address=192.168.1.0/24 tunnel=yes', FWD('ipsec-policy=in,ipsec')]);
  assert.deepStrictEqual(linked(Qi.reach(LAN, OUT, { proto: 'tcp', port: 443 })), [['rule-condition', ['conditions']]]);
  assert.strictEqual(use(Qi, 'conditions').status, 'affects');
  assert.strictEqual(use(net([FWD('ipsec-policy=in,ipsec')]), 'conditions').status, 'not-used', '沒有 IPsec policy 時可以判斷');
});

test('前提 routeros-tables：依封包標記比對的規則是不明，原因對到 routeros-tables', () => {
  const Q = net([FWD('packet-mark=foo')]);
  const r = Q.reach(LAN, OUT, { proto: 'tcp', port: 443 });
  assert.deepStrictEqual([r.verdict, linked(r)], ['unknown', [['rule-condition', ['routeros-tables']]]]);
  assert.strictEqual(use(Q, 'routeros-tables').status, 'affects');
  assert.strictEqual(use(net(), 'routeros-tables').status, 'always', '其他 mangle 動作與 bridge filter 不在模型中，每份基準都適用');
});

test('前提 untracked：raw 的 notrack 之後以 untracked 比對；Q.assumptionUse 列出 notrack 規則', () => {
  const drop = FWD('connection-state=untracked');
  assert.strictEqual(net([drop]).reach(LAN, OUT, { proto: 'tcp', port: 443 }).verdict, 'allow');
  const Q = net(['/ip firewall raw add action=notrack chain=prerouting src-address=192.168.1.0/24', drop]);
  assert.strictEqual(Q.reach(LAN, OUT, { proto: 'tcp', port: 443 }).verdict, 'deny');
  assert.deepStrictEqual([use(Q, 'untracked').status, use(Q, 'untracked').count], ['affects', 1]);
  // 是否 notrack 無法判斷：原因 raw-notrack 對到 untracked
  const Qu = net(['/ip firewall raw add action=notrack chain=prerouting src-address-list=X', drop]);
  const r = Qu.reach(LAN, OUT, { proto: 'tcp', port: 443 });
  assert.ok(linked(r).some(([c, a]) => c === 'raw-notrack' && a.includes('untracked')), JSON.stringify(linked(r)));
});

test('前提 mark-routing：有 mark-routing 的設備轉送是不明（L3 與 L4 相同），原因與 S.trace 的結束都對到 mark-routing', () => {
  const Q = net(['/ip firewall mangle add action=mark-routing chain=prerouting new-routing-mark=isp2 src-address=192.168.1.0/24 passthrough=no']);
  const t = S.trace(Q, LAN, OUT);
  assert.deepStrictEqual(t.ends.map((e) => [e.status, e.assumption]), [['policy', 'mark-routing']]);
  const r = Q.reach(LAN, OUT, { proto: 'tcp', port: 443 });
  assert.deepStrictEqual([r.verdict, linked(r)], ['unknown', [['policy-routing', ['mark-routing']]]]);
  assert.deepStrictEqual([use(Q, 'mark-routing').status, use(Q, 'mark-routing').count, use(Q, 'mark-routing').layer], ['affects', 1, 'route']);
  assert.strictEqual(use(Q, 'policy-routing').status, 'not-used');
});

test('前提 policy-routing：/routing rule 依順序決定路由表；條件判斷不了（S.trace.RULE_CONDITIONS 以外）時不明，對到 policy-routing', () => {
  const ok = net(['/routing rule add action=lookup-only-in-table src-address=192.168.1.128/25 table=isp2']);
  assert.deepStrictEqual(S.trace(ok, '192.168.1.200', OUT).hops.map((h) => h.table), ['isp2']);
  assert.deepStrictEqual([use(ok, 'policy-routing').status, use(ok, 'policy-routing').count, use(ok, 'policy-routing').unit], ['affects', 1, 'rules'], '只有 1 條 /routing rule 時也標出數的是規則');
  const odd = net(['/routing rule add action=lookup dst-address=8.8.8.0/24 min-prefix=0 table=main']);
  assert.deepStrictEqual(S.trace(odd, LAN, OUT).ends.map((e) => [e.status, e.assumption]), [['policy', 'policy-routing']]);
  assert.deepStrictEqual(linked(odd.reach(LAN, OUT, { proto: 'tcp', port: 443 })), [['policy-routing', ['policy-routing']]]);
  // 可判斷的條件就是 ruleMatches 判斷的那幾個
  const pkt = { src: LAN, dst: OUT, inEp: 'R|bridge1' };
  const R = { addrSets: () => S.infer.addrSets({}) };
  S.trace.RULE_CONDITIONS.forEach((c) => assert.notStrictEqual(S.trace.ruleMatches(R, { match: { [c.key]: c.key === 'interface' ? 'bridge1' : '0.0.0.0/0' } }, pkt).match, null, c.key));
  assert.strictEqual(S.trace.ruleMatches(R, { match: { 'min-prefix': '0' } }, pkt).match, null);
});

test('前提 bridge-ip-firewall：有 bridge 與過濾規則的設備，use-ip-firewall 沒有收集，是 missing-data；同網段送達對到它', () => {
  assert.strictEqual(use(net(), 'bridge-ip-firewall').status, 'not-used', '沒有過濾規則');
  const Q = net([FWD('src-address=10.66.0.0/16')]);
  assert.deepStrictEqual([use(Q, 'bridge-ip-firewall').status, use(Q, 'bridge-ip-firewall').devices], ['missing-data', ['R']]);
  assert.deepStrictEqual(S.query.reasonAssumptions('same-subnet'), ['bridge-ip-firewall']);
});

test('前提 static-only：UPnP 啟用（Q.mgmtOf）時動態規則會影響結果；沒有時是判斷方式（always）', () => {
  assert.deepStrictEqual([use(net(), 'static-only').status, use(net(), 'static-only').count, use(net(), 'static-only').unit], ['always', 0, null]);
  const Q = net(['/ip upnp set enabled=yes', '/ip upnp interfaces add interface=ether1 type=external']);
  assert.deepStrictEqual([use(Q, 'static-only').status, use(Q, 'static-only').devices, use(Q, 'static-only').count, use(Q, 'static-only').unit], ['affects', ['R'], 1, 'devices']);
});

test('前提 return-path 與 new-connection：沒有放行已建立連線的設備，回程不保證（原因 return-not-guaranteed 對到 return-path）', () => {
  assert.strictEqual(use(net(), 'new-connection').status, 'always');
  const Q = net(['/ip firewall filter add action=accept chain=forward connection-state=new', '/ip firewall filter add action=drop chain=forward']);
  const r = Q.reach(LAN, OUT, { proto: 'tcp', port: 443 });
  assert.strictEqual(r.verdict, 'allow');
  assert.ok(linked(r).some(([c, a]) => c === 'return-not-guaranteed' && a[0] === 'return-path'), JSON.stringify(linked(r)));
  assert.strictEqual(use(Q, 'return-path').status, 'affects');
});

test('前提 exposure-source-ranges：外部來源依入口設備的規則切段；經入口連到另一台設備本身時，另依那台目的設備的規則切', () => {
  const Q = net([], R2, [TO_R2]);
  const x = Q.exposure();
  const row = x.self.rows.find((rw) => rw.ip === '10.20.0.1' && rw.service === 'tcp/22');
  assert.ok(row, JSON.stringify(x.self.rows.map((rw) => [rw.ip, rw.service, rw.verdict])));
  // R（入口）沒有依來源位址的規則：允許的範圍只能由 R2（目的設備）的 src-address 切出——203.0.113.0/24 被 R2 丟棄，不在允許的範圍內
  const inBad = ([lo, hi]) => S.ip.toInt(lo) <= S.ip.toInt('203.0.113.255') && S.ip.toInt(hi) >= S.ip.toInt('203.0.113.0');
  assert.deepStrictEqual([row.verdict, row.allowedFrom.kind], ['allow', 'limited'], JSON.stringify(row.allowedFrom));
  assert.ok(row.allowedFrom.ranges.length > 0 && !row.allowedFrom.ranges.some(inBad), JSON.stringify(row.allowedFrom.ranges));
  assert.strictEqual(Q.reach('203.0.113.10', '10.20.0.1', { proto: 'tcp', port: 22, entry: 'R|ether1' }).verdict, 'deny');
  assert.strictEqual(use(Q, 'exposure-source-ranges').status, 'always');
  assert.ok(/另依那台目的設備/.test(S.query.exposureAssumptions()[0].detail));
  // 區段上限是 maxSources 的預設
  assert.strictEqual(JSON.stringify(Q.exposure({ maxSources: S.reach._.EXPOSURE_MAX_SOURCES })), JSON.stringify(x));
});

test('Q.assumptionUse：範例資料上用得到的前提（每條一筆、依前提順序、深層凍結、依 Q 快取；Snapshot 不變）', () => {
  const s = sampleSnap(); const before = JSON.stringify(s); const Q = S.query(s);
  const u = Q.assumptionUse();
  assert.strictEqual(Q.assumptionUse(), u, '同一個 Q 快取');
  assert.ok(Object.isFrozen(u) && u.every((a) => Object.isFrozen(a) && Object.isFrozen(a.devices) && Object.isFrozen(a.ruleKeys)));
  assert.deepStrictEqual(u.map((a) => a.code), allAssumptions().map((a) => a.code));
  u.forEach((a) => {
    assert.ok(['affects', 'missing-data', 'not-used', 'always'].includes(a.status), a.code);
    assert.ok(a.devices.every((d) => Q.getDevice(d)) && a.ruleKeys.every((k) => Q.getFirewallRule(k)), `${a.code} 的設備與規則都在基準內`);
    assert.strictEqual(a.status === 'affects' || a.status === 'missing-data', a.devices.length > 0, `${a.code}：有影響的才列設備`);
    assert.strictEqual(a.unit, a.count === 0 ? null : a.ruleKeys.length ? 'rules' : a.unit, `${a.code}：count 為 0 時 unit 是 null；有規則鍵時數的是規則`);
    if (a.unit === 'devices') assert.strictEqual(a.count, a.devices.length, `${a.code}：數設備時 count 是設備數`);
  });
  const st = Object.fromEntries(u.map((a) => [a.code, a.status]));
  // 範例資料：有策略路由、在用 IPv6、非 main 的 VRF、UPnP、沒有介面紀錄的 WAN 成員、比對來源埠的規則、由規則寫入的位址清單（port knocking）；沒有 mark-routing、notrack
  assert.deepStrictEqual(['policy-routing', 'ipv4-vrf', 'ip-service', 'static-only', 'wan-member-no-interface', 'src-port', 'return-path', 'address-list'].map((c) => st[c]), Array(8).fill('affects'));
  assert.deepStrictEqual(['mark-routing', 'untracked'].map((c) => st[c]), Array(2).fill('not-used'));
  assert.strictEqual(st['bridge-ip-firewall'], 'missing-data');
  assert.strictEqual(JSON.stringify(s), before, 'Snapshot 不變');
});

test('原因與前提雙向對應：每個原因代碼都有 assumption（前提 code、陣列或 null）；每條不是 always 的前提至少有一個原因或判斷對到', () => {
  const codes = new Set(allAssumptions().map((a) => a.code));
  const asList = (a) => (a === null ? [] : Array.isArray(a) ? a : [a]);
  const fromReasons = new Set();
  S.query.reachReasonCodes().forEach((x) => {
    assert.ok(Object.prototype.hasOwnProperty.call(x, 'assumption'), `${x.code} 有 assumption`);
    asList(x.assumption).forEach((c) => { assert.ok(codes.has(c), `${x.code} → ${c} 是前提`); fromReasons.add(c); });
    assert.deepStrictEqual(S.query.reasonAssumptions(x.code), asList(x.assumption).filter((c, i, a) => a.indexOf(c) === i).sort((p, q) => [...codes].indexOf(p) - [...codes].indexOf(q)));
  });
  S.query.traceEndStatuses().forEach((x) => asList(x.assumption).concat(Object.values(x.reasons || {})).forEach((c) => { assert.ok(codes.has(c)); fromReasons.add(c); }));
  // rule-condition 依條件鍵對到前提
  assert.deepStrictEqual(['src-address-list', 'src-port', 'port', 'packet-mark', 'time', 'in-interface-list'].map((k) => S.query.reasonAssumptions('rule-condition', { keys: [k] })[0]),
    ['address-list', 'src-port', 'src-port', 'routeros-tables', 'conditions', 'conditions']);
  assert.throws(() => S.query.reasonAssumptions('no-such-code'), TypeError);
  // 原因沒有對到的前提，都由 Q.assumptionUse 的判斷對到（範例資料或手寫資料中至少有一次 affects／missing-data）
  const seen = new Set();
  [sampleSnap(), build(R([FWD('src-address-list=X'), '/ip firewall raw add action=notrack chain=prerouting',
    '/ip firewall mangle add action=mark-routing chain=prerouting new-routing-mark=isp2 passthrough=no']).join('\n'))]
    .forEach((s) => S.query(s).assumptionUse().forEach((a) => { if (a.status === 'affects' || a.status === 'missing-data') seen.add(a.code); }));
  allAssumptions().filter((a) => !['new-connection', 'exposure-source-ranges'].includes(a.code))
    .forEach((a) => assert.ok(fromReasons.has(a.code) || seen.has(a.code), `${a.code} 沒有原因或判斷對到`));
  ['address-list', 'untracked', 'mark-routing'].forEach((c) => assert.ok(seen.has(c), `${c} 在手寫資料上是 affects`));
});
