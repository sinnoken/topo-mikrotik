// 防火牆解析與檢查（F01–F08）、防火牆查詢
'use strict';
const assert = require('assert');
const { S, read, ids, test, fwBox, fws } = require('../lib.js');
// ------------------------------------------------------------------ 防火牆
const edgeFw = () => S.build([{ name: 'edge.txt', text: read('tests/fixtures/firewall/edge-router.txt') }], { now: '2026-01-01T00:00:00Z' });
const fwLines = (s, id) => fws(s, id).map((f) => f.evidence.map((e) => e.line));
test('防火牆解析：filter／nat／raw、IPv6、chain 內順序、否定、disabled、comment、行號；interface list、ip service、IPsec', () => {
  const s = edgeFw();
  assert.ok(!ids(s).includes('I01'), JSON.stringify(s.findings.filter((f) => f.id === 'I01')));
  const rules = s.model.firewallRules;
  const input = rules.filter((r) => r.family === 'ip' && r.table === 'filter' && r.chain === 'input');
  assert.deepStrictEqual(input.map((r) => r.position), input.map((_, k) => k + 1), 'chain 內依出現順序編號');
  assert.deepStrictEqual(input.map((r) => r.src[0][1]), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 29]);
  const est = input[0];
  assert.deepStrictEqual([est.action, est.match['connection-state'], est.comment, est.disabled], ['accept', 'established,related,untracked', 'defconf: accept established,related,untracked', false]);
  assert.strictEqual(input[10].match['in-interface-list'], '!LAN', '否定保留 ! 前綴');
  assert.strictEqual(input[11].disabled, true);
  assert.deepStrictEqual(input[9].params, { 'jump-target': 'mgmt' });
  assert.ok(!('chain' in est.match) && !('comment' in est.match) && !('action' in est.match), 'match 只放比對條件');
  const dnat = rules.find((r) => r.table === 'nat' && r.action === 'dst-nat');
  assert.deepStrictEqual([dnat.chain, dnat.params['to-addresses'], dnat.params['to-ports'], dnat.order], ['dstnat', '192.168.88.10', '80', 2]);
  assert.ok(rules.some((r) => r.table === 'raw' && r.chain === 'prerouting'));
  assert.strictEqual(rules.filter((r) => r.family === 'ipv6').length, 2);
  assert.deepStrictEqual(s.model.interfaceLists.map((l) => [l.name, l.members]), [['LAN', ['EDGE|bridge1']], ['WAN', ['EDGE|ether1']]]);
  const svc = (n) => s.model.ipServices.find((x) => x.dev === 'EDGE' && x.name === n);
  assert.deepStrictEqual([svc('telnet').enabled, svc('telnet').basis], [false, 'export']);
  assert.deepStrictEqual([svc('ssh').addresses, svc('ssh').basis, svc('ssh').port], [['192.168.88.0/24'], 'export', 22], '[ find name=ssh ] 也認得');
  assert.deepStrictEqual([svc('winbox').enabled, svc('winbox').addresses, svc('winbox').basis, svc('winbox').port], [true, [], 'default', 8291], '沒出現在 export 的服務是預設值，不是停用');
  assert.deepStrictEqual([svc('www-ssl').enabled, svc('www-ssl').basis], [false, 'default']);
  const zone = s.model.firewallZones.find((z) => z.dev === 'EDGE');
  assert.deepStrictEqual([zone.status, zone.wanLists, zone.wanInterfaces, zone.lanInterfaces], ['ok', ['WAN'], ['EDGE|ether1'], ['EDGE|bridge1']]);
  // 同一份輸入兩次結果相同，規則鍵不含序號：在最前面插入一條規則，其他規則的鍵不變
  const keys = rules.map((r) => r.key);
  const ins = S.build([{ name: 'edge.txt', text: read('tests/fixtures/firewall/edge-router.txt').replace('/ip firewall filter add action=accept chain=input comment="defconf: accept est', '/ip firewall filter add action=drop chain=input src-address=198.51.100.9\n/ip firewall filter add action=accept chain=input comment="defconf: accept est') }], { now: '2026-01-01T00:00:00Z' });
  assert.deepStrictEqual(keys.filter((k) => !ins.model.firewallRules.some((r) => r.key === k)), [], '插入規則後既有規則的鍵不變');
  assert.ok(new Set(keys).size === keys.length, '規則鍵唯一');
});
test('防火牆解析：RouterOS export 的註解編碼（\\XX 位元組）依 UTF-8、Big5 解碼；都失敗時保留原文並標示', () => {
  const s = fwBox(['/ip firewall filter add action=accept chain=input comment="\\E4\\B8\\AD\\E6\\96\\87 ok" protocol=icmp',
    '/ip firewall filter add action=accept chain=input comment="\\A4\\A4\\A4\\E5" protocol=icmp',
    '/ip firewall filter add action=accept chain=input comment="bad \\FF\\FE" protocol=icmp',
    '/ip firewall filter add action=accept chain=input comment="say \\"hi\\"" protocol=icmp']);
  const c = s.model.firewallRules.map((r) => [r.comment, r.commentEncoding]);
  assert.deepStrictEqual(c, [['中文 ok', 'utf-8'], ['中文', 'big5'], ['bad \\FF\\FE', 'undecodable'], ['say "hi"', 'ascii']]);
});
test('F01／F02：被前面規則完全遮蔽、重複規則；限速等不確定比對不算遮蔽；output chain 也檢查；證據含前一條規則', () => {
  const s = edgeFw();
  assert.deepStrictEqual(fwLines(s, 'F02'), [[15, 14]], '8291 的重複規則（comment 不同仍是重複）');
  assert.deepStrictEqual(fwLines(s, 'F01'), [[17, 14], [28, 27]], 'in-interface=ether1 那條被 8291 全部放行遮蔽；output 的 10.1/16 被 10/8 遮蔽');
  assert.ok(/第 4 條/.test(fws(s, 'F01')[0].message), fws(s, 'F01')[0].message);
  const lim = fwBox(['/ip firewall filter add action=accept chain=input dst-port=22 limit=10,5:packet protocol=tcp', '/ip firewall filter add action=drop chain=input dst-port=22 protocol=tcp',
    '/ip firewall filter add action=accept chain=input dst-port=80,443 protocol=tcp', '/ip firewall filter add action=drop chain=input dst-port=443 protocol=tcp',
    '/ip firewall filter add action=drop chain=input dst-port=443,8443 protocol=tcp', '/ip firewall filter add action=drop chain=input connection-state=!established',
    '/ip firewall filter add action=drop chain=input connection-state=new']);
  assert.deepStrictEqual(fwLines(lim, 'F01'), [[11, 10], [14, 13]], '帶 limit 不遮蔽；dst-port 清單用子集合；!established 涵蓋 new');
  assert.strictEqual(fws(lim, 'F01')[0].severity, 'warn');
  assert.strictEqual(S.check.CATALOG.F02.severity, 'info');
});
test('F03：WAN 可主動建立新連線的 input／forward 放行；被 jump 的子 chain 也算；排除 established、ICMP、LAN、私有來源、IPsec（有 peer 時）', () => {
  const s = edgeFw();
  const f03 = fws(s, 'F03');
  assert.deepStrictEqual(f03.map((f) => f.evidence.map((e) => e.line)), [[14], [19], [22, 20]], 'winbox 放行、ESP（沒有 IPsec）、mgmt 子 chain（附 jump 那一行）');
  assert.ok(/IPsec peer／policy/.test(f03[1].message), f03[1].message);
  assert.ok(/mgmt/.test(f03[2].message) && /jump/.test(f03[2].message), f03[2].message);
  assert.ok(f03.every((f) => f.entities.some((e) => e.type === 'rule')));
  const priv = fwBox(['/ip firewall filter add action=accept chain=input src-address=192.168.0.0/16 dst-port=22 protocol=tcp',
    '/ip firewall filter add action=accept chain=input in-interface-list=LAN dst-port=23 protocol=tcp', '/ip firewall filter add action=accept chain=input protocol=icmp',
    '/ip firewall filter add action=accept chain=input connection-state=established,related', '/ip firewall filter add action=accept chain=input ipsec-policy=in,ipsec',
    '/ip firewall filter add action=drop chain=input in-interface-list=WAN', '/ip firewall filter add action=accept chain=input dst-port=80 protocol=tcp']);
  assert.strictEqual(fws(priv, 'F03').length, 0, '私有來源、LAN、ICMP、established、ipsec-policy、被 drop 擋下的都不算');
  const ipsec = (extra) => fwBox(['/ip firewall filter add action=accept chain=input protocol=ipsec-esp', '/ip firewall filter add action=accept chain=input dst-port=500,4500 protocol=udp', ...extra]);
  assert.strictEqual(fws(ipsec([]), 'F03').length, 2);
  assert.strictEqual(fws(ipsec(['/ip ipsec peer add address=198.51.100.1/32 name=p1']), 'F03').length, 0, '有 IPsec peer 時 IPsec 放行是需要的');
  assert.strictEqual(fws(ipsec(['/ip ipsec policy add dst-address=10.9.0.0/16 src-address=192.168.88.0/24 tunnel=yes']), 'F03').length, 0, '有 IPsec policy 也算');
  assert.strictEqual(fws(ipsec(['/ip ipsec peer add address=198.51.100.1/32 disabled=yes name=p1']), 'F03').length, 2, '停用的 peer 不算');
  // 白名單之後接全部放行（forward）
  const wl = fwBox(['/ip firewall filter add action=accept chain=forward src-address-list=office', '/ip firewall filter add action=accept chain=forward']);
  assert.deepStrictEqual(fwLines(wl, 'F03'), [[9]]);
});
test('raw 表：prerouting 先丟掉的封包不算對外暴露（F03、F07）', () => {
  const base = ['/ip firewall filter add action=accept chain=input dst-port=8291 protocol=tcp'];
  assert.strictEqual(fws(fwBox(base), 'F03').length, 1);
  const raw = fwBox(base.concat(['/ip firewall raw add action=drop chain=prerouting in-interface-list=WAN']));
  assert.strictEqual(fws(raw, 'F03').length, 0);
  assert.strictEqual(fws(raw, 'F07').length, 0);
  const s = edgeFw();
  assert.ok(!fws(s, 'F07').some((f) => /：api（/.test(f.message) && /IPv4 從/.test(f.message)), 'api（8728）的 IPv4 被 raw 擋下');
});
test('F04：WAN 可連入的 dst-nat 與對應的 forward 放行；沒有 in-interface 的 dstnat 放行附 hairpin 提醒', () => {
  const s = edgeFw();
  const f04 = fws(s, 'F04');
  assert.deepStrictEqual(f04.map((f) => f.evidence.map((e) => e.line)), [[31, 25]]);
  assert.ok(/192\.168\.88\.10/.test(f04[0].message) && /hairpin/.test(f04[0].message), f04[0].message);
  const blocked = fwBox(['/ip firewall nat add action=dst-nat chain=dstnat dst-port=8080 in-interface-list=WAN protocol=tcp to-addresses=192.168.88.10',
    '/ip firewall filter add action=drop chain=forward in-interface-list=WAN']);
  assert.strictEqual(fws(blocked, 'F04').length, 0, 'forward 擋下時不是可連入點');
  const lan = fwBox(['/ip firewall nat add action=dst-nat chain=dstnat dst-port=8080 in-interface-list=LAN protocol=tcp to-addresses=192.168.88.10']);
  assert.strictEqual(fws(lan, 'F04').length, 0, '只從 LAN 進來的 dst-nat 不算');
});
test('F05：IPv6 forward 放行只限 dst-port、沒有限 dst-address；F06：以固定來源埠放行', () => {
  const s = edgeFw();
  assert.deepStrictEqual(fwLines(s, 'F05'), [[38]]);
  assert.ok(!fws(s, 'F03').some((f) => f.evidence[0].line === 38), 'F05 的規則不再重複列 F03');
  const v6 = fwBox(['/ipv6 firewall filter add action=accept chain=forward dst-address=2001:db8::10/128 dst-port=443 protocol=tcp',
    '/ipv6 firewall filter add action=accept chain=forward dst-port=443 in-interface-list=LAN protocol=tcp']);
  assert.strictEqual(fws(v6, 'F05').length, 0);
  assert.deepStrictEqual(fwLines(s, 'F06'), [[18]]);
  assert.ok(!fws(s, 'F03').some((f) => f.evidence[0].line === 18), 'F06 的規則不再重複列 F03');
  const out = fwBox(['/ip firewall filter add action=accept chain=output protocol=udp src-port=53', '/ip firewall filter add action=accept chain=input connection-state=established protocol=udp src-port=53']);
  assert.strictEqual(fws(out, 'F06').length, 0, 'output 是設備自己送出、established 是回應');
});
test('F07：管理服務啟用、沒有 available-from，且 input 放行（含預設值與沒有任何 drop 的情況）', () => {
  const s = edgeFw();
  const svc = (f) => [f.message.split('：')[1].split('（')[0], f.message.match(/IPv[46](?= 從)/g), f.evidence.map((e) => e.line)];
  // IPv4：winbox 被 input 第 4 條放行；IPv6：/ipv6 firewall 的 input 沒有規則（預設放行），沒有限制來源的 winbox、api 都可連；
  // www、ssh 的 available-from 只列 IPv4 位址，IPv6 不能連（手冊：只有 IPv4 前綴時拒絕所有 IPv6 用戶端）。證據是讓 IPv6 生效的那一行
  assert.deepStrictEqual(fws(s, 'F07').map(svc), [['api', ['IPv6'], [38]], ['winbox', ['IPv4', 'IPv6'], [14, 38]]], '同一服務的 IPv4、IPv6 併成一筆');
  const open = fwBox([]); // 沒有任何防火牆規則：預設全部放行
  assert.deepStrictEqual(fws(open, 'F07').map((f) => f.message.split('：')[1].split('（')[0]).sort(), ['api', 'api-ssl', 'ftp', 'ssh', 'telnet', 'winbox', 'www'].sort());
  const af = fwBox(['/ip service set winbox available-from=192.168.88.0/24', '/ip service set ssh disabled=yes', '/ip firewall filter add action=drop chain=input in-interface-list=!LAN']);
  assert.strictEqual(fws(af, 'F07').length, 0, 'available-from（7.x 名稱）限制來源也算');
});
test('F07（IPv6）：有 IPv6 設定時經 /ipv6 firewall 的 raw 與 input 判斷；available-from 依位址族分開；停用 IPv6 或沒有 IPv6 設定時不檢查', () => {
  const v6 = (lines) => fwBox(['/ip firewall filter add action=drop chain=input in-interface-list=!LAN', '/ip service set ssh disabled=yes',
    '/ip service set telnet disabled=yes', '/ip service set ftp disabled=yes', '/ip service set www disabled=yes', '/ip service set api disabled=yes', '/ip service set api-ssl disabled=yes', ...lines]);
  const f07 = (s) => fws(s, 'F07').flatMap((f) => f.message.match(/IPv[46](?= 從)/g).map((fam) => `${f.message.split('：')[1].split('（')[0]} ${fam}`));
  // IPv4 已被 drop 擋下；/ipv6 address 在 WAN 上、IPv6 沒有任何防火牆規則 → winbox 從 IPv6 可以連入
  const addr = v6(['/ipv6 address add address=2001:db8::1/64 interface=ether1']);
  assert.deepStrictEqual(f07(addr), ['winbox IPv6']);
  const f = fws(addr, 'F07')[0];
  assert.ok(/IPv6 從 ether1，input 沒有任何規則擋下/.test(f.message), f.message);
  assert.deepStrictEqual(f.evidence.map((e) => e.line), [15], '證據指向讓 IPv6 生效的 /ipv6 address');
  assert.deepStrictEqual(f07(v6(['/ipv6 dhcp-client add interface=ether1 request=address,prefix'])), ['winbox IPv6'], 'DHCPv6 client 也算有 IPv6');
  assert.deepStrictEqual(f07(v6([])), [], '沒有任何 IPv6 設定時無從判斷，不報');
  assert.deepStrictEqual(f07(v6(['/ipv6 address add address=2001:db8::1/64 interface=ether1', '/ipv6 settings set disable-ipv6=yes'])), [], '停用 IPv6');
  // /ipv6 firewall 擋下（input 或 raw）
  assert.deepStrictEqual(f07(v6(['/ipv6 firewall filter add action=drop chain=input in-interface-list=!LAN'])), [], 'IPv6 input 擋下');
  assert.deepStrictEqual(f07(v6(['/ipv6 address add address=2001:db8::1/64 interface=ether1', '/ipv6 firewall raw add action=drop chain=prerouting in-interface-list=WAN'])), [], 'IPv6 raw 擋下');
  // available-from 依位址族：只列 IPv4 → IPv6 拒絕；只列 IPv6 → IPv4 拒絕；::/0、0.0.0.0/0 等於不限
  const af = (v, extra) => f07(fwBox(['/ip service set ssh disabled=yes', '/ip service set telnet disabled=yes', '/ip service set ftp disabled=yes', '/ip service set www disabled=yes',
    '/ip service set api disabled=yes', '/ip service set api-ssl disabled=yes', `/ip service set winbox available-from=${v}`, '/ipv6 address add address=2001:db8::1/64 interface=ether1', ...(extra || [])]));
  assert.deepStrictEqual(af('192.168.88.0/24'), []);
  assert.deepStrictEqual(af('2001:db8:1::/48'), []);
  assert.deepStrictEqual(af('::/0'), ['winbox IPv6']);
  assert.deepStrictEqual(af('0.0.0.0/0'), ['winbox IPv4']);
  assert.deepStrictEqual(af('0.0.0.0/0,::/0').sort(), ['winbox IPv4', 'winbox IPv6']);
});
test('F08：有防火牆規則但無法判斷 WAN（沒有 WAN 清單或清單沒有成員）；coverage 標示 WAN 狀態', () => {
  const rule = ['/ip firewall filter add action=accept chain=input dst-port=8291 protocol=tcp'];
  const none = fwBox(rule, { noLists: true });
  assert.strictEqual(fws(none, 'F08').length, 1);
  assert.ok(/沒有名稱含 WAN 的 interface list/.test(fws(none, 'F08')[0].message), fws(none, 'F08')[0].message);
  assert.strictEqual(fws(none, 'F03').length + fws(none, 'F07').length, 0, '無法判斷 WAN 時不猜');
  // 訊息要和行為一致：F05 仍檢查沒有限制入介面的 forward 規則
  assert.ok(/F03、F04、F07 未檢查，F05 只檢查沒有限制入介面的 forward 規則/.test(fws(none, 'F08')[0].message), fws(none, 'F08')[0].message);
  const v6 = (extra) => fwBox(['/ipv6 firewall filter add action=accept chain=forward dst-port=443 protocol=tcp' + extra], { noLists: true });
  assert.strictEqual(fws(v6(''), 'F05').length, 1, 'WAN 不明時，沒有限制入介面的 IPv6 forward 規則照樣檢查');
  assert.strictEqual(fws(v6(' in-interface=ether1'), 'F05').length, 0, 'WAN 不明時，有限制入介面的不猜');
  assert.deepStrictEqual(none.coverage[0].firewall, { rules: 1, wan: 'no-wan-list' });
  const empty = fwBox(rule, { emptyWan: true });
  assert.ok(/沒有成員/.test(fws(empty, 'F08')[0].message));
  assert.strictEqual(fws(fwBox([], { noLists: true }), 'F08').length, 0, '沒有任何防火牆規則時不提醒');
  assert.deepStrictEqual(edgeFw().coverage[0].firewall, { rules: 24, wan: 'ok' });
});
test('防火牆查詢：依設備、位址族、表、chain 排序列出規則並附 finding；chain 清單與 jump 關係', () => {
  const s = edgeFw(); const Q = S.query(s);
  const chains = Q.firewallChains('EDGE');
  assert.deepStrictEqual(chains.map((c) => [c.family, c.table, c.chain, c.rules]), [
    ['ip', 'filter', 'input', 12], ['ip', 'filter', 'forward', 3], ['ip', 'filter', 'output', 2], ['ip', 'filter', 'mgmt', 2],
    ['ip', 'nat', 'srcnat', 1], ['ip', 'nat', 'dstnat', 1], ['ip', 'raw', 'prerouting', 1], ['ipv6', 'filter', 'forward', 2]]);
  assert.deepStrictEqual([chains[3].builtin, chains[3].jumpedFrom.length], [false, 1]);
  const rows = Q.firewallRuleRows('EDGE', { family: 'ip', table: 'filter', chain: 'input' });
  assert.deepStrictEqual(rows.map((r) => r.rule.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepStrictEqual(rows[3].findings.map((f) => f.id).sort(), ['F03', 'F07']);
  assert.deepStrictEqual(rows[4].findings.map((f) => f.id), ['F02'], '重複與遮蔽只標在後面那條（前一條的行號在證據裡）');
  assert.strictEqual(Q.getFirewallRule(rows[0].rule.key), rows[0].rule);
  assert.strictEqual(Q.firewallRules().length, s.model.firewallRules.length);
  assert.strictEqual(Q.firewallZone('EDGE').status, 'ok');
  assert.strictEqual(Q.ipServicesOf('EDGE').length, 8);
  assert.deepStrictEqual(Q.ipsecOf('EDGE'), { peers: [], policies: [] });
  assert.deepStrictEqual(Q.interfaceListsOf('EDGE').map((l) => l.name), ['LAN', 'WAN']);
});
