// 防火牆命中次數（/ip|ipv6 firewall filter|nat|raw print stats detail）：解析、對應到 export 的規則、F09
// 輸出格式依手冊（firewall/common-firewall-matchers-and-actions 的 Stats）推定，stats＋detail 並用的寫法尚未以真實設備確認
'use strict';
const assert = require('assert');
const { S, build, ids, count, test, i03, sampleSnap } = require('../lib.js');

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
  assert.ok(/IPv4 filter（.*）；IPv4 nat（/.test(f[0].message), f[0].message);
  assert.deepStrictEqual(two.coverage[0].firewall.stats, { matched: 0, mismatch: 2 });
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
