// 防火牆命中次數（/ip|ipv6 firewall filter|nat|raw print stats detail）：解析、對應到 export 的規則、F09
// 實機的 RouterOS 7 即使加了 detail 也輸出表格（tests/fixtures/real/7.x-defconf-fwstats.txt）；key=value 格式仍支援
'use strict';
const assert = require('assert');
const { S, read, build, ids, count, test, i03, sampleSnap } = require('../lib.js');

const LEGEND = 'Flags: X - disabled, I - invalid; D - dynamic';
const EXPORT = [
  '### /export terse',
  '/ip firewall filter add action=accept chain=input comment="defconf: accept established,related,untracked" connection-state=established,related,untracked',
  '/ip firewall filter add action=drop chain=input comment="\\E9\\98\\B2\\E7\\81\\AB\\E7\\89\\86: drop all" in-interface-list=!LAN',
  '/ip firewall filter add chain=forward disabled=yes protocol=icmp',
  '/ip firewall filter add action=fasttrack-connection chain=forward connection-state=established,related',
];
// RouterOS 7：數字以空白分千位；D 列是 FastTrack 的 dummy rule；X 是停用
const V7_FILTER = ['### /ip firewall filter print stats detail without-paging', LEGEND,
  ' 0  D ;;; special dummy rule to show fasttrack counters',
  '      chain=forward action=passthrough bytes=50 507 925 242 packets=50 048 246',
  ' 1    ;;; defconf: accept established,related,untracked',
  '      chain=input action=accept connection-state=established,related,untracked bytes=9 007 199 254 740 993',
  '      packets=1 234 567',
  ' 2    ;;; 防火牆: drop all',
  '      chain=input action=drop in-interface-list=!LAN bytes=432 270 packets=9 719',
  ' 3 X  chain=forward action=accept protocol=icmp bytes=0 packets=0',
  ' 4    chain=forward action=fasttrack-connection connection-state=established,related bytes=120 packets=2'];
const box = (...blocks) => build(['R (10.0.0.1):', ...blocks.flat()].join('\n'));
const stats = (s) => s.model.firewallStats;
const ruleStats = (s) => s.model.firewallRules.map((r) => r.stats && [r.stats.bytes, r.stats.packets, r.stats.src[0][1]]);

test('命中次數：RouterOS 7 的千位空白、超過 2^53 的值以字串保存、D 列去掉後依序對到 export 的規則（含停用的 X 列）', () => {
  const s = box(EXPORT, V7_FILTER);
  assert.deepStrictEqual([ids(s).filter((x) => /^I0|F09/.test(x)), i03(s).length], [[], 0], JSON.stringify(s.findings.filter((f) => f.id.startsWith('I')).map((f) => f.message)));
  assert.deepStrictEqual(ruleStats(s), [['9007199254740993', '1234567', 11], ['432270', '9719', 14], ['0', '0', 16], ['120', '2', 17]], '每條規則的 bytes、packets 與 stats 的來源行');
  const t = stats(s)[0];
  assert.deepStrictEqual([t.dev, t.family, t.table, t.status, t.rows, t.dynamic, t.rules, t.reason, t.src], ['R', 'ip', 'filter', 'matched', 4, 1, 4, null, [[1, 8]]]);
  assert.ok(s.model.devices.find((d) => d.key === 'R').data.includes('fwstats'));
  assert.deepStrictEqual(s.coverage[0].firewall.stats, { matched: 1, mismatch: 0 });
  assert.strictEqual(S.query(s).firewallStatsOf('R').length, 1);
  assert.strictEqual(S.adapters.mikrotikStatLine('bytes=50 507 925 242 packets=7'), 'bytes=50507925242 packets=7');
});

test('命中次數：RouterOS 6 的純數字、I（invalid）列照樣佔序位、IPv6 與 raw、nat 各自對應', () => {
  const s = box(['### /export terse', '/ip firewall nat add action=masquerade chain=srcnat out-interface=ether1', '/ip firewall nat add action=dst-nat chain=dstnat dst-port=80 protocol=tcp to-addresses=10.0.0.5',
    '/ipv6 firewall filter add action=drop chain=input', '/ip firewall raw add action=drop chain=prerouting src-address=192.0.2.0/24'],
  ['### /ip firewall nat print stats detail without-paging', 'Flags: X - disabled, I - invalid, D - dynamic', ' 0    chain=srcnat action=masquerade out-interface=ether1 bytes=12345678 packets=9876',
    ' 1 I  chain=dstnat action=dst-nat dst-port=80 protocol=tcp to-addresses=10.0.0.5 bytes=0 packets=0'],
  ['### /ipv6 firewall filter print stats detail without-paging', 'Flags: X - disabled, I - invalid, D - dynamic', ' 0    chain=input action=drop bytes=64 packets=1'],
  ['### /ip firewall raw print stats detail without-paging', 'Flags: X - disabled, I - invalid, D - dynamic', ' 0    chain=prerouting action=drop src-address=192.0.2.0/24 bytes=1500 packets=1']);
  assert.deepStrictEqual(ids(s).filter((x) => /^I0|F09/.test(x)), []);
  assert.deepStrictEqual(stats(s).map((t) => [t.family, t.table, t.status, t.rows]), [['ip', 'nat', 'matched', 2], ['ip', 'raw', 'matched', 1], ['ipv6', 'filter', 'matched', 1]]);
  const by = (fam, table) => s.model.firewallRules.filter((r) => r.family === fam && r.table === table).map((r) => r.stats.packets);
  assert.deepStrictEqual([by('ip', 'nat'), by('ip', 'raw'), by('ipv6', 'filter')], [['9876', '0'], ['1'], ['1']]);
});

test('命中次數：只有說明行或沒有輸出時是已收集、0 列；沒有 ipv6 套件（bad command name）列為 I01；沒有 export 時不對應', () => {
  const s = box(['### /export terse', '/interface bridge add name=bridge1'],
    ['### /ip firewall filter print stats detail without-paging', LEGEND],
    ['### /ip firewall raw print stats detail without-paging', ''],
    ['### /ipv6 firewall filter print stats detail without-paging', 'bad command name ipv6 (line 1 column 2)']);
  assert.deepStrictEqual(stats(s).map((t) => [t.table, t.family, t.status, t.rows, t.rules]), [['filter', 'ip', 'matched', 0, 0], ['raw', 'ip', 'matched', 0, 0]]);
  assert.strictEqual(count(s, 'I01'), 1, '選單不存在：指令執行錯誤');
  assert.ok(/bad command name|ipv6/.test(JSON.stringify(s.findings.filter((f) => f.id === 'I01'))));
  assert.strictEqual(count(s, 'F09'), 0);
  const noExport = box(V7_FILTER);
  assert.deepStrictEqual([stats(noExport)[0].status, count(noExport, 'F09'), noExport.model.firewallRules.length], ['no-export', 0, 0], '沒有 export：計數器不配，也不算對不上');
  // 沒有 export 的設備 coverage[].firewall 是 null（不會有永遠是 0 的 noExport 表數）；no-export 由 Q.firewallStatsOf 呈現
  assert.strictEqual(noExport.coverage[0].firewall, null);
  assert.deepStrictEqual(S.query(noExport).firewallStatsOf('R').map((t) => t.status), ['no-export']);
  // 沒有指令標記時不猜是哪個表
  const bare = build(['R (10.0.0.1):', '### /export terse', '/interface bridge add name=bridge1', '###', ...V7_FILTER.slice(1)].join('\n'));
  assert.strictEqual(stats(bare).length, 0);
});

test('命中次數對不上（F09）：列數、chain、action、停用、註解任一不同時，整個表不配並說明第一個不符；同一台設備併成一筆', () => {
  const variants = [
    ['count', V7_FILTER.slice(0, -1), /去掉動態（D）列後有 3 列，export 有 4 條規則/],
    ['chain', V7_FILTER.map((l) => l.replace('chain=input action=drop', 'chain=forward action=drop')), /第 2 列的 chain 是 forward，export 第 2 條是 input/],
    ['action', V7_FILTER.map((l) => l.replace('chain=input action=drop', 'chain=input action=reject')), /第 2 列的 action 是 reject/],
    ['disabled', V7_FILTER.map((l) => l.replace(' 3 X  chain=forward', ' 3    chain=forward')), /第 3 列不是停用（X），export 第 3 條是 disabled=yes/],
    ['comment', V7_FILTER.map((l) => l.replace(';;; 防火牆: drop all', ';;; drop all')), /第 2 列的註解（drop all）與 export 第 2 條（防火牆: drop all）不同/],
  ];
  variants.forEach(([code, lines, re]) => {
    const s = box(EXPORT, lines);
    const t = stats(s)[0];
    assert.deepStrictEqual([t.status, t.reason.code], ['mismatch', code], code);
    assert.ok(s.model.firewallRules.every((r) => r.stats === null), `${code}：整個表都不配`);
    const f = s.findings.filter((x) => x.id === 'F09');
    assert.strictEqual(f.length, 1, code);
    assert.ok(re.test(f[0].message), f[0].message);
    assert.deepStrictEqual(f[0].entities, [{ type: 'device', key: 'R' }]);
    assert.ok(f[0].evidence.length >= 1 && f[0].evidence.every((e) => e.line > 0));
  });
  // 兩個表都對不上：同一台設備一筆，訊息依表的順序
  const two = box(['### /export terse', '/interface bridge add name=bridge1'],
    ['### /ip firewall nat print stats detail without-paging', LEGEND, ' 0    chain=srcnat action=masquerade bytes=0 packets=0'],
    ['### /ip firewall filter print stats detail without-paging', LEGEND, ' 0    chain=input action=accept bytes=0 packets=0']);
  const f = two.findings.filter((x) => x.id === 'F09');
  assert.strictEqual(f.length, 1);
  assert.ok(/^R：IPv4 filter 的命中次數全部不採用（.*）；IPv4 nat 的命中次數全部不採用（/.test(f[0].message), f[0].message);
  assert.deepStrictEqual(two.coverage[0].firewall.stats, { matched: 0, mismatch: 2 });
});

// ---- 表格格式：RouterOS 7 的 print stats 即使加了 detail 也輸出表格（實機輸出 tests/fixtures/real/7.x-defconf-fwstats.txt）
const statFacts = (id, lines) => {
  const facts = []; const ignored = [];
  S.adapters[id].parse({ lines, origin: { startLine: 1 } }, (f) => facts.push(f), (n) => ignored.push(n));
  return { facts, ignored };
};
const noLine = (fs) => fs.map((f) => Object.assign({}, f, { line: undefined }));
// export 的字串：非 ASCII 寫成 \XX（UTF-8 位元組）
const rosEsc = (s) => Array.from(Buffer.from(s, 'utf8')).map((b) => (b < 128 ? String.fromCharCode(b) : '\\' + b.toString(16).toUpperCase())).join('');
const V7_FILTER_TABLE = ['### /ip firewall filter print stats detail without-paging', LEGEND, 'Columns: CHAIN, ACTION, BYTES, PACKETS',
  ' #   CHAIN    ACTION                                  BYTES     PACKETS',
  ';;; special dummy rule to show fasttrack counters',
  ' 0 D forward  passthrough                    50 507 925 242  50 048 246',
  ';;; defconf: accept established,related,untracked',
  ' 1   input    accept                  9 007 199 254 740 993   1 234 567',
  ';;; 防火牆: drop all',
  ' 2   input    drop                                  432 270       9 719',
  ' 3 X forward  accept                                      0           0',
  ' 4   forward  fasttrack-connection                      120           2'];
// defconf 的 IPv6 filter 前 12 條（與實機輸出的 12 列一一對應）與 IPv4 nat 的 masquerade
const DEFCONF_EXPORT = ['### /export terse',
  '/ip firewall nat add action=masquerade chain=srcnat comment="defconf: masquerade" ipsec-policy=out,none out-interface-list=WAN',
  ...[['accept', 'input', 'accept established,related,untracked', 'connection-state=established,related,untracked'], ['drop', 'input', 'drop invalid', 'connection-state=invalid'],
    ['accept', 'input', 'accept ICMPv6', 'protocol=icmpv6'], ['accept', 'input', 'accept UDP traceroute', 'dst-port=33434-33534 protocol=udp'],
    ['accept', 'input', 'accept DHCPv6-Client prefix delegation.', 'dst-port=546 protocol=udp src-address=fe80::/10'], ['accept', 'input', 'accept IKE', 'dst-port=500,4500 protocol=udp'],
    ['accept', 'input', 'accept ipsec AH', 'protocol=ipsec-ah'], ['accept', 'input', 'accept ipsec ESP', 'protocol=ipsec-esp'],
    ['accept', 'input', 'accept all that matches ipsec policy', 'ipsec-policy=in,ipsec'], ['drop', 'input', 'drop everything else not coming from LAN', 'in-interface-list=!LAN'],
    ['accept', 'forward', 'accept established,related,untracked', 'connection-state=established,related,untracked'], ['drop', 'forward', 'drop invalid', 'connection-state=invalid']]
    .map(([a, c, cm, rest]) => `/ipv6 firewall filter add action=${a} chain=${c} comment="defconf: ${cm}" ${rest}`)];

test('命中次數（實機的表格輸出）：千位空白、註解對到下一列、兩位數序號、空表格算已收集 0 列；對上 export 後不報 F09', () => {
  const text = read('tests/fixtures/real/7.x-defconf-fwstats.txt');
  const s = build(text);
  assert.deepStrictEqual([ids(s).filter((x) => /^I0|F09/.test(x)), i03(s).length], [[], 0], JSON.stringify(s.findings.filter((f) => /^I0/.test(f.id)).map((f) => f.message)));
  assert.deepStrictEqual(stats(s).map((t) => [t.family, t.table, t.status, t.rows]),
    [['ip', 'filter', 'no-export', 0], ['ip', 'nat', 'no-export', 1], ['ip', 'raw', 'no-export', 0], ['ipv6', 'filter', 'no-export', 12], ['ipv6', 'raw', 'no-export', 0]]);
  const withExport = build(text + '\n' + DEFCONF_EXPORT.join('\n'));
  assert.deepStrictEqual([count(withExport, 'F09'), i03(withExport).length], [0, 0], JSON.stringify(withExport.findings.filter((f) => f.id === 'F09').map((f) => f.message)));
  assert.ok(stats(withExport).every((t) => t.status === 'matched'), JSON.stringify(stats(withExport).map((t) => [t.table, t.status, t.reason])));
  const v6 = withExport.model.firewallRules.filter((r) => r.family === 'ipv6').map((r) => [r.stats.bytes, r.stats.packets]);
  assert.deepStrictEqual([v6.length, v6[0], v6[2], v6[11]], [12, ['1112383', '15656'], ['312', '3'], ['0', '0']]);
  const { facts } = statFacts('mikrotik.fwstats.ipv6-filter', text.split(/\r?\n/).slice(20, 46));
  const rows = facts.filter((f) => f.t === 'fwStat');
  assert.deepStrictEqual([rows[10].chain, rows[10].comment, rows[11].chain, rows[11].action, rows[11].comment],
    ['forward', 'defconf: accept established,related,untracked', 'forward', 'drop', 'defconf: drop invalid'], '序號兩位數的列與它前一行的註解');
});

test('命中次數（表格）：與 key=value 格式的事實相同（行號除外）；旗標 D、X 在序號後面；對上 export 不報 F09', () => {
  const kv = statFacts('mikrotik.fwstats.ip-filter', V7_FILTER.slice(1));
  const tb = statFacts('mikrotik.fwstats.ip-filter', V7_FILTER_TABLE.slice(1));
  assert.deepStrictEqual(noLine(tb.facts), noLine(kv.facts));
  assert.deepStrictEqual(tb.facts.filter((f) => f.t === 'fwStat').map((f) => f.flags), ['D', '', '', 'X', '']);
  const s = box(EXPORT, V7_FILTER_TABLE);
  assert.deepStrictEqual([ids(s).filter((x) => /^I0|F09/.test(x)), i03(s).length], [[], 0]);
  assert.deepStrictEqual(ruleStats(s).map((x) => x.slice(0, 2)), [['9007199254740993', '1234567'], ['432270', '9719'], ['0', '0'], ['120', '2']]);
});

test('命中次數（表格）：長註解依終端寬度折行（沒有 ;;; 的續行，原樣接上）、含中文與 regex 的註解、對上 export 不報 F09', () => {
  const long = '(quake3)udplite, dccp, and sctp are built-in services of conntracking. Since these are not separately loaded modules, they cannot be disabled separately';
  const re = '#(last|frst|[0-9]+)\\.(acpt|dlst|rtrn|reject|drop)\\.(flt|nat)(4|6)';
  const lines = ['### /ip firewall filter print stats detail without-paging', LEGEND, 'Columns: CHAIN, ACTION, BYTES, PACKETS',
    ' #   CHAIN    ACTION                         BYTES  PACKETS',
    ';;; special dummy rule to show fasttrack counters',
    ' 0 D forward  passthrough               50 507 925   50 048',
    ';;; (quake3)udplite, dccp, and sctp are built-in services of conntra',
    'cking. Since these are not separately loaded modules, they cannot be',
    ' disabled separately',
    ' 1   input    accept                           312        3',
    ';;; redirect NTP 錯誤比較少',
    ' 2 X forward  add-src-to-address-list            0        0',
    ';;; #(last|frst|[0-9]+)\\.(acpt|dlst|rtrn|',
    'reject|drop)\\.(flt|nat)(4|6)',
    ' 3   forward  drop                       1 806 976   23 776'];
  const { facts } = statFacts('mikrotik.fwstats.ip-filter', lines.slice(1));
  assert.deepStrictEqual(facts.filter((f) => f.t === 'fwStat').map((f) => [f.flags, f.chain, f.action, f.comment, f.bytes, f.packets]), [
    ['D', 'forward', 'passthrough', 'special dummy rule to show fasttrack counters', '50507925', '50048'],
    ['', 'input', 'accept', long, '312', '3'],
    ['X', 'forward', 'add-src-to-address-list', 'redirect NTP 錯誤比較少', '0', '0'],
    ['', 'forward', 'drop', re, '1806976', '23776']]);
  const exp = ['### /export terse',
    `/ip firewall filter add action=accept chain=input comment="${long}" protocol=udplite`,
    `/ip firewall filter add action=add-src-to-address-list address-list=ntp chain=forward comment="${rosEsc('redirect NTP 錯誤比較少')}" disabled=yes`,
    `/ip firewall filter add action=drop chain=forward comment="${re.replace(/\\/g, '\\\\')}"`];
  const s = box(exp, lines);
  assert.deepStrictEqual([ids(s).filter((x) => /^I0|F09/.test(x)), i03(s).length], [[], 0], JSON.stringify(s.findings.filter((f) => /^I0|F09/.test(f.id)).map((f) => f.message)));
  assert.strictEqual(stats(s)[0].status, 'matched');
});

test('命中次數（表格）：旗標在第一欄的位置、只有表頭沒有 Columns、欄的順序不同、只有 Columns 沒有表頭、手冊的舊排法', () => {
  const rowsOf = (id, lines) => statFacts(id, lines).facts.filter((f) => f.t === 'fwStat').map((f) => [f.flags, f.chain, f.action, f.bytes, f.packets, f.comment]);
  // 表頭沒有為旗標留寬度：旗標與第一欄只隔一個空白，或自成一格
  assert.deepStrictEqual(rowsOf('mikrotik.fwstats.ip-nat', ['Flags: X - disabled', 'Columns: CHAIN, ACTION, BYTES, PACKETS', '# CHAIN   ACTION     BYTES  PACKETS',
    '0 X dstnat  dst-nat        0        0', '1 dstnat    dst-nat  1 806 976   23 776', '2  X  dstnat  dst-nat     0        0']),
  [['X', 'dstnat', 'dst-nat', '0', '0', null], ['', 'dstnat', 'dst-nat', '1806976', '23776', null], ['X', 'dstnat', 'dst-nat', '0', '0', null]]);
  assert.deepStrictEqual(rowsOf('mikrotik.fwstats.ip-filter', [' # ACTION  CHAIN   PACKETS  BYTES', ' 0 drop    input         3    312']), [['', 'input', 'drop', '312', '3', null]]);
  assert.deepStrictEqual(rowsOf('mikrotik.fwstats.ip-filter', ['Columns: CHAIN, ACTION, BYTES, PACKETS', ';;; defconf', '0 input  accept  1 112 383  15 656']), [['', 'input', 'accept', '1112383', '15656', 'defconf']]);
  // 手冊 Stats 範例的排法：註解接在序號與旗標之後，欄位在下一行（數值是手寫的）
  assert.deepStrictEqual(rowsOf('mikrotik.fwstats.ip-filter', ['Flags: X - disabled, I - invalid, D - dynamic', ' #    CHAIN     ACTION         BYTES   PACKETS',
    ' 0  D ;;; special dummy rule to show fasttrack counters', '      forward   passthrough    1 500        12', ' 1    input     accept           640         8']),
  [['D', 'forward', 'passthrough', '1500', '12', 'special dummy rule to show fasttrack counters'], ['', 'input', 'accept', '640', '8', null]]);
  // 只有說明行與表頭的空表：已收集、0 列，行號是第一個說明行
  const empty = statFacts('mikrotik.fwstats.ipv6-raw', ['Columns: CHAIN, ACTION, BYTES, PACKETS', '# CHAIN  ACTION  BYTES  PACKETS']);
  assert.deepStrictEqual([empty.facts, empty.ignored], [[{ t: 'fwStatTable', family: 'ipv6', table: 'raw', line: 1 }], [1, 2]]);
});

test('命中次數（表格）：切不出欄位的列與它的註解留給 I03，註解不轉給下一列', () => {
  const s = box(['### /ip firewall filter print stats detail without-paging', 'Columns: CHAIN, ACTION, BYTES, PACKETS', ' # CHAIN    ACTION  BYTES  PACKETS',
    ';;; broken', ' 0 input    accept  12', ' 1 forward  drop     0        0']);
  const bad = i03(s);
  assert.strictEqual(bad.length, 1);
  assert.ok(/^2 行無法辨識.*第 5 行「;;; broken」、第 6 行「0 input    accept  12」$/.test(bad[0].message), bad[0].message);
  const { facts } = statFacts('mikrotik.fwstats.ip-filter', ['Columns: CHAIN, ACTION, BYTES, PACKETS', ' # CHAIN    ACTION  BYTES  PACKETS', ';;; broken', ' 0 input    accept  12', ' 1 forward  drop     0        0']);
  assert.deepStrictEqual(facts.filter((f) => f.t === 'fwStat').map((f) => [f.chain, f.comment]), [['forward', null]]);
});

test('命中次數（範例資料）：核心 01 全部配上、核心 02 的 nat 多一條（F09），其他表照樣配上', () => {
  const s = sampleSnap();
  const t = (dev, fam, table) => s.model.firewallStats.find((x) => x.dev === dev && x.family === fam && x.table === table);
  assert.deepStrictEqual(['filter', 'nat', 'raw'].map((x) => t('TPE_CORE_RT_01', 'ip', x).status), ['matched', 'matched', 'matched']);
  assert.strictEqual(t('TPE_CORE_RT_01', 'ip', 'filter').dynamic, 1, 'FastTrack 的 dummy rule');
  assert.deepStrictEqual([t('TPE_CORE_RT_02', 'ip', 'nat').status, t('TPE_CORE_RT_02', 'ip', 'nat').reason.code], ['mismatch', 'count']);
  assert.strictEqual(t('TPE_CORE_RT_02', 'ipv6', 'filter').status, 'matched');
  const f = s.findings.filter((x) => x.id === 'F09');
  assert.deepStrictEqual(f.map((x) => x.entities[0].key), ['TPE_CORE_RT_02']);
  // 覆蓋率的表數要能說明每個收到的表：有 export 的設備，各狀態的表數加總等於該設備的表數（沒有永遠是 0 的欄位）；
  // 沒有 export 的設備 firewall 是 null，它的表都是 no-export
  s.coverage.forEach((c) => {
    const ts = s.model.firewallStats.filter((x) => x.dev === c.dev);
    if (!ts.length) return;
    if (c.firewall === null) { assert.ok(ts.every((x) => x.status === 'no-export'), c.dev); return; }
    assert.deepStrictEqual(Object.keys(c.firewall.stats).sort(), ['matched', 'mismatch'], c.dev);
    assert.strictEqual(c.firewall.stats.matched + c.firewall.stats.mismatch, ts.length, c.dev);
  });
  const nat2 = s.model.firewallRules.filter((r) => r.dev === 'TPE_CORE_RT_02' && r.table === 'nat');
  assert.ok(nat2.every((r) => r.stats === null));
  assert.ok(s.model.firewallRules.filter((r) => r.dev === 'TPE_CORE_RT_01').every((r) => r.stats && /^\d+$/.test(r.stats.bytes)));
  // 規則影響附上命中次數
  const dnat = s.model.firewallRules.find((r) => r.dev === 'TPE_CORE_RT_01' && r.action === 'dst-nat');
  assert.deepStrictEqual(S.query(s).ruleImpact(dnat.key).rule.stats, dnat.stats);
});
