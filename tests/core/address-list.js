// 位址清單（address-list）在判斷時展開：完全靜態的清單依項目判斷，可能有動態來源的清單維持不明。
// 檢查（F 系列）與 L4（Q.reach、暴露清單）都經 S.infer.fw.decide，結果一致；前提文字與 Q.assumptionUse 依同一份狀態。
// 測試資料依 RouterOS 手冊撰寫（https://manual.mikrotik.com/docs/cli-reference/ip/firewall/address-list.md、
// https://manual.mikrotik.com/docs/firewall-and-quality-of-service/firewall/address-lists.md），不是實機擷取。
'use strict';
const assert = require('assert');
const { S, build, test, fws, i03, sampleSnap } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/** 邊界路由器 R：WAN ether1（198.51.100.2/30）、LAN bridge1（192.168.1.0/24）、預設路由經 198.51.100.1；extra 是另加的 export 行。 */
const R = (extra) => build(['R (192.168.1.1):', '### /export terse',
  '/interface bridge add name=bridge1',
  '/interface list add name=WAN', '/interface list add name=LAN',
  '/interface list member add interface=ether1 list=WAN', '/interface list member add interface=bridge1 list=LAN',
  '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0',
  '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
  ...extra,
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge1 distance=0',
  ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1', ''].join('\n'));
const AL = (list, address, more) => `/ip firewall address-list add address=${address} list=${list}${more ? ' ' + more : ''}`;
const FWD = (m) => `/ip firewall filter add action=drop chain=forward ${m}`;
const OUT = '8.8.8.8';
const fwd = (Q, src, dst) => Q.reach(src, dst || OUT, { proto: 'tcp', port: 443 }).verdict;
const use = (Q, code) => Q.assumptionUse().find((a) => a.code === code);
const listOf = (s, name, family) => S.query(s).addressListOf('R', family || 'ip', name);

test('位址清單：export 的項目（位址、網段、範圍、DNS 名稱、停用、逾時、dynamic）與寫入來源成為 model.addressLists，不是 I03', () => {
  const s = R([
    AL('A', '192.168.1.10'), AL('A', '192.168.1.0/28'), AL('A', '192.168.1.100-192.168.1.110'), AL('A', '192.168.1.200', 'disabled=yes'),
    AL('B', 'office.example.com'), AL('C', '203.0.113.5', 'timeout=1d'), AL('D', '203.0.113.6', 'dynamic=yes'),
    AL('E', '203.0.113.1-254'), // 手冊：不是有效的位址就當 DNS 名稱（短寫的範圍什麼都不符合）
    '/ipv6 firewall address-list add address=2001:db8::/48 list=A',
    '/ip firewall filter add action=add-src-to-address-list address-list=K address-list-timeout=1m chain=input dst-port=7000 protocol=tcp',
    '/ip firewall filter add action=add-dst-to-address-list address-list=A chain=forward disabled=yes',
    '/ppp profile add address-list=P name=vpn',
    '/system script add name=s1 source="/ip firewall address-list add list=X address=1.2.3.4"',
  ]);
  assert.deepStrictEqual(i03(s), []);
  const L = s.model.addressLists;
  assert.deepStrictEqual(L.map((l) => [l.family, l.name, l.static, l.reasons]), [
    ['ip', 'A', false, ['rule', 'script']], ['ip', 'B', false, ['dns', 'script']], ['ip', 'C', false, ['timeout', 'script']], ['ip', 'D', false, ['dynamic', 'script']],
    ['ip', 'E', false, ['dns', 'script']], ['ip', 'K', false, ['rule', 'script']], ['ip', 'P', false, ['config', 'script']], ['ipv6', 'A', false, ['script']],
    ['ipv6', 'P', false, ['config', 'script']], // /ppp profile 不在 /ip、/ipv6 之下：兩個位址族都算寫入
  ]);
  const a = L.find((l) => l.family === 'ip' && l.name === 'A');
  assert.deepStrictEqual(a.entries.map((e) => [e.address, e.kind, e.disabled]), [['192.168.1.10', 'address', false], ['192.168.1.0/28', 'address', false],
    ['192.168.1.100-192.168.1.110', 'address', false], ['192.168.1.200', 'address', true]]);
  assert.ok(a.entries.every((e) => e.src.length === 1 && e.src[0][1] > 0), '每個項目有來源行');
  assert.deepStrictEqual(Object.keys(a.entries[0]), ['address', 'kind', 'disabled', 'src'], '項目只留必要欄位（清單可能有十萬筆）');
  const c = L.find((l) => l.name === 'C'); const cLine = c.entries[0].src[0];
  assert.deepStrictEqual(c.reasonSrc.map((x) => [x.reason, x.src[0][1] === cLine[1]]), [['timeout', true], ['script', false]], '每個原因指出第一個來源行');
  assert.deepStrictEqual(a.writers.map((w) => [w.kind, !!w.rule, w.section]), [['rule', true, null], ['script', false, '/system script']], '停用的寫入規則也算');
  assert.ok(S.query(s).getFirewallRule(a.writers[0].rule), '寫入規則的鍵指向基準內的規則');
  assert.deepStrictEqual(L.find((l) => l.name === 'P').writers.map((w) => [w.kind, w.section]), [['config', '/ppp profile'], ['script', '/system script']]);
  // 沒有腳本時：只有項目的清單是完全靜態的；停用的 DNS 名稱不算
  const t = R([AL('A', '192.168.1.10'), AL('B', 'office.example.com', 'disabled=yes'), '/ip firewall filter add action=drop chain=forward src-address-list=A']);
  assert.deepStrictEqual(t.model.addressLists.map((l) => [l.name, l.static, l.reasons]), [['A', true, []], ['B', true, []]]);
  // 比對條件（src-address-list=）、規則動作（add-src-to-address-list）不是寫入其他清單的腳本
  assert.deepStrictEqual(R([AL('A', '1.1.1.1'), '/ip firewall mangle add action=mark-connection chain=prerouting new-connection-mark=x src-address-list=A']).model.addressLists[0].reasons, []);
});

test('位址清單：完全靜態時依項目判斷命中與不命中（位址、網段、範圍；停用的項目不算）', () => {
  const Q = S.query(R([AL('BAD', '192.168.1.10'), AL('BAD', '192.168.1.32/28'), AL('BAD', '192.168.1.100-192.168.1.110'), AL('BAD', '192.168.1.200', 'disabled=yes'),
    FWD('src-address-list=BAD')]));
  assert.deepStrictEqual(['192.168.1.10', '192.168.1.40', '192.168.1.105', '192.168.1.20', '192.168.1.111', '192.168.1.200'].map((ip) => fwd(Q, ip)),
    ['deny', 'deny', 'deny', 'allow', 'allow', 'allow']);
  assert.strictEqual(use(Q, 'address-list').status, 'not-used', '完全靜態的清單不影響判斷');
  // 目的位址清單
  const Qd = S.query(R([AL('DST', '8.8.8.0/24'), FWD('dst-address-list=DST')]));
  assert.deepStrictEqual([fwd(Qd, '192.168.1.10', '8.8.8.8'), fwd(Qd, '192.168.1.10', '1.1.1.1')], ['deny', 'allow']);
  // 只有停用項目的清單：什麼都不符合
  const Qe = S.query(R([AL('E', '192.168.1.0/24', 'disabled=yes'), FWD('src-address-list=E')]));
  assert.strictEqual(fwd(Qe, '192.168.1.10'), 'allow');
});

test('位址清單：否定（!）——不在清單內的才符合', () => {
  const Q = S.query(R([AL('OK', '192.168.1.10'), FWD('src-address-list=!OK')]));
  assert.deepStrictEqual([fwd(Q, '192.168.1.10'), fwd(Q, '192.168.1.20')], ['allow', 'deny']);
  const Qd = S.query(R([AL('OUT', '8.8.8.8'), FWD('dst-address-list=!OUT')]));
  assert.deepStrictEqual([fwd(Qd, '192.168.1.10', '8.8.8.8'), fwd(Qd, '192.168.1.10', '1.1.1.1')], ['allow', 'deny']);
});

test('位址清單：DNS 名稱、逾時、dynamic、由規則或其他設定寫入、基準裡沒有的清單——整份清單不明（原因對到前提 address-list）', () => {
  const cases = {
    dns: [AL('BAD', '192.168.1.10'), AL('BAD', 'bad.example.com')],
    timeout: [AL('BAD', '192.168.1.10'), AL('BAD', '192.168.1.11', 'timeout=1h')],
    dynamic: [AL('BAD', '192.168.1.10'), AL('BAD', '192.168.1.11', 'dynamic=yes')],
    // 起點大於終點、位址族混用的範圍：不能當成不含任何位址（也不是網域名稱），整份清單不明
    'invalid-range': [AL('BAD', '192.168.1.10'), AL('BAD', '192.168.1.30-192.168.1.1')],
    rule: [AL('BAD', '192.168.1.10'), '/ip firewall filter add action=add-src-to-address-list address-list=BAD address-list-timeout=1d chain=forward dst-port=23 protocol=tcp'],
    config: [AL('BAD', '192.168.1.10'), '/ip dhcp-server add address-lists=BAD interface=bridge1 name=d1'],
    script: [AL('BAD', '192.168.1.10'), '/system scheduler add name=x on-event="/ip firewall address-list add list=BAD address=1.2.3.4"'],
    missing: [],
  };
  Object.entries(cases).forEach(([why, lines]) => {
    const s = R(lines.concat([FWD('src-address-list=BAD')])); const Q = S.query(s);
    const l = Q.addressListOf('R', 'ip', 'BAD');
    if (why === 'missing') assert.strictEqual(l, null);
    else assert.deepStrictEqual([l.static, l.reasons], [false, [why]], why);
    // 192.168.1.20 不在 export 的項目內，仍是不明：動態來源可能加入它
    const r = Q.reach('192.168.1.20', OUT, { proto: 'tcp', port: 443 });
    assert.strictEqual(r.verdict, 'unknown', why);
    const rc = r.reasons.find((x) => x.code === 'rule-condition');
    assert.deepStrictEqual([rc.keys, S.query.reasonAssumptions('rule-condition', rc)], [['src-address-list'], ['address-list']], why);
    const u = use(Q, 'address-list'); const rule = Q.firewallRulesOf('R').find((x) => x.match['src-address-list']);
    assert.deepStrictEqual([u.status, u.ruleKeys], ['affects', [rule.key]], why);
  });
  // 位址族混用（IPv4 清單、IPv6 清單都一樣）與 IPv6 起點大於終點：項目是 invalid-range，原因有說明文字與來源行
  const mixed = S.query(R([AL('BAD', '::1-192.168.1.1'), '/ipv6 firewall address-list add address=2001:db8::9-2001:db8::1 list=B6',
    '/ipv6 firewall address-list add address=192.168.1.1-::1 list=M6', FWD('src-address-list=BAD')]));
  [['ip', 'BAD'], ['ipv6', 'B6'], ['ipv6', 'M6']].forEach(([fam, name]) => {
    const l = mixed.addressListOf('R', fam, name);
    assert.deepStrictEqual([l.static, l.reasons, l.entries.map((e) => e.kind), l.reasonSrc.map((x) => x.reason)], [false, ['invalid-range'], ['invalid-range'], ['invalid-range']], name);
    assert.strictEqual(mixed.addressSet(`R|${fam}|${name}`).ranges, null, name);
  });
  assert.ok(S.query.addressListReasons().some((x) => x.code === 'invalid-range' && x.source === 'entry' && /起點大於終點/.test(x.label)));
  // IPv4 與 IPv6 的清單分開：同名的 IPv6 清單是靜態的，不影響 IPv4 規則
  const v = S.query(R(['/ipv6 firewall address-list add address=2001:db8::/48 list=BAD', FWD('src-address-list=BAD')]));
  assert.strictEqual(v.addressListOf('R', 'ip', 'BAD'), null);
  assert.strictEqual(fwd(v, '192.168.1.20'), 'unknown');
});

test('位址清單：F 檢查與 Q.reach 經同一個 decide——靜態清單時兩邊都確定，可能有動態來源時兩邊都不明', () => {
  // input 的 drop 只擋清單內的來源，沒有最後的 drop：靜態清單（只列一個公網位址）時來自 WAN 的新連線仍可連 www（F07 報）
  const fw = (lines) => R(lines.concat(['/ip service set telnet disabled=yes', '/ip service set ftp disabled=yes', '/ip service set api disabled=yes',
    '/ip service set api-ssl disabled=yes', '/ip service set ssh disabled=yes', '/ip service set winbox disabled=yes',
    '/ip firewall filter add action=drop chain=input src-address-list=BLOCK']));
  const www = (s) => fws(s, 'F07').filter((f) => /：www（/.test(f.message)).length;
  const viaWan = (s, src) => S.query(s).reach(src, '198.51.100.2', { proto: 'tcp', port: 80, entry: 'R|ether1' }).verdict;
  const st = fw([AL('BLOCK', '203.0.113.66')]);
  assert.deepStrictEqual([www(st), viaWan(st, '192.0.2.10'), viaWan(st, '203.0.113.66')], [1, 'allow', 'deny']);
  const dyn = fw([AL('BLOCK', '203.0.113.66'), AL('BLOCK', 'bad.example.com')]);
  assert.deepStrictEqual([www(dyn), viaWan(dyn, '192.0.2.10'), viaWan(dyn, '203.0.113.66')], [0, 'unknown', 'unknown']);
  // 暴露清單：入口設備的外部來源依靜態清單的項目切段，清單內的區段不在允許的範圍內
  const row = S.query(st).exposure().self.rows.find((rw) => rw.ip === '198.51.100.2' && rw.service === 'tcp/80');
  assert.ok(row && row.verdict === 'allow' && row.allowedFrom.kind === 'limited', JSON.stringify(row && row.allowedFrom));
  const inList = ([lo, hi]) => S.ip.toInt(lo) <= S.ip.toInt('203.0.113.66') && S.ip.toInt(hi) >= S.ip.toInt('203.0.113.66');
  assert.ok(!row.allowedFrom.ranges.some(inList), JSON.stringify(row.allowedFrom.ranges));
  // 檢查用的比對環境與查詢層的一致
  const ctx = S.query(st); assert.strictEqual(ctx.addressListsOf('R').length, 1);
});

test('位址清單：前提文字由 S.infer.fw.ADDRESS_LIST_DYNAMIC 產生；S.query.addressListReasons 是同一份；範例資料的靜態清單確定、port knocking 不明', () => {
  const F = S.infer.fw;
  const a = S.query.reachAssumptions().find((x) => x.code === 'address-list');
  assert.ok(/只展開匯出設定中寫死的位址清單/.test(a.detail) && /算不明/.test(a.detail), a.detail);
  F.ADDRESS_LIST_DYNAMIC.forEach((x) => assert.ok(a.detail.includes(x.label), `前提列出 ${x.label}`));
  F.ADDRESS_LIST.concat(F.ADDRESS_LIST_WRITE).forEach((k) => assert.ok(a.detail.includes(k), `前提列出 ${k}`));
  assert.strictEqual(S.query.addressListReasons(), F.ADDRESS_LIST_DYNAMIC);
  assert.ok(Object.isFrozen(F.ADDRESS_LIST_DYNAMIC) && F.ADDRESS_LIST_DYNAMIC.every(Object.isFrozen));
  // 範例資料：TPE_CORE_RT_01 的 QUARANTINE 是完全靜態的（drop 結果確定），knock1／knock-ok 由規則寫入（放行 ssh 的那條不明）
  const s = sampleSnap(); const Q = S.query(s);
  const lists = Q.addressListsOf('TPE_CORE_RT_01');
  assert.deepStrictEqual(lists.map((l) => [l.name, l.static, l.reasons]), [['knock-ok', false, ['rule']], ['knock1', false, ['rule']], ['MGMT', true, []], ['QUARANTINE', true, []]]);
  assert.ok(Object.isFrozen(lists));
  const q = lists.find((l) => l.name === 'QUARANTINE');
  assert.deepStrictEqual(q.entries.map((e) => e.disabled), [false, false, true]);
  const u = use(Q, 'address-list');
  const knock = Q.firewallRulesOf('TPE_CORE_RT_01').find((r) => r.match['src-address-list'] === 'knock-ok' && r.action === 'accept');
  assert.deepStrictEqual([u.status, u.devices, u.ruleKeys], ['affects', ['TPE_CORE_RT_01'], [knock.key]]);
  // 隔離的主機（10.1.30.66、10.1.30.70–79）經 TPE_CORE_RT_01 轉送時被丟棄；用同一份基準拿掉 addressLists（清單一律不明）時是不明
  const drop = Q.firewallRulesOf('TPE_CORE_RT_01').find((r) => r.match['src-address-list'] === 'QUARANTINE');
  const ctx = F.fwContext('TPE_CORE_RT_01', Q.interfaceListsOf('TPE_CORE_RT_01'), Q.interfacesOf('TPE_CORE_RT_01').map((i) => i.key), Q.firewallRulesOf('TPE_CORE_RT_01'), lists);
  const pkt = (src) => ({ reach: true, family: 'ip', chain: 'forward', in: undefined, out: undefined, protocol: 'tcp', dstPort: 443, srcPort: null,
    src: BigInt(S.ip.toInt(src)), dst: BigInt(S.ip.toInt('8.8.8.8')), state: 'new', natState: null, ipsec: 'none' });
  const hit = F.decide(ctx, 'ip', 'filter', 'forward', pkt('10.1.30.75'));
  assert.ok(hit.decided && hit.hits.includes(drop) && hit.verdict === 'drop', JSON.stringify([hit.decided, hit.verdict]));
  const none = F.fwContext('TPE_CORE_RT_01', Q.interfaceListsOf('TPE_CORE_RT_01'), Q.interfacesOf('TPE_CORE_RT_01').map((i) => i.key), Q.firewallRulesOf('TPE_CORE_RT_01'), []);
  assert.ok(F.decide(none, 'ip', 'filter', 'forward', pkt('10.1.30.75')).uncertain.some((x) => x.rule === drop), '沒有清單資料時是不明');
});
