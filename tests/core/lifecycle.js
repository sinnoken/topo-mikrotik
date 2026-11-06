// 設備生命週期：/system routerboard（韌體）、/system resource 的 uptime、L01 韌體待升級、L02 同型號 RouterOS 版本不同
'use strict';
const assert = require('assert');
const { S, build, count, test, i03 } = require('../lib.js');
// 測試資料依官方手冊的 print 範例撰寫，不是實機擷取：
//   https://manual.mikrotik.com/docs/hardware/routerboard.md（/system/routerboard/print 的 key: value 排版）
//   https://manual.mikrotik.com/docs/cli-reference/system/routerboard.md（Conditions: !i386 —— x86／CHR 沒有這個選單）
//   https://manual.mikrotik.com/docs/cli-reference/system/resource.md（uptime 是 time 型別）
const RB = (current, upgrade, extra = []) => ['       routerboard: yes', '             model: CCR2116-12G-4S+', '     serial-number: MT123456789',
  '     firmware-type: al64v3', '  minimum-firmware: 7.8', `  current-firmware: ${current}`, `  upgrade-firmware: ${upgrade}`, ...extra];
const box = (name, ip, cmds) => [`${name} (${ip}):`, ...cmds.flatMap(([c, lines]) => [`### ${c}`, ...lines])].join('\n') + '\n';
const dev = (s, key) => s.model.devices.find((d) => d.key === key);

test('routerboard print：型號與韌體寫進設備（事實、帶來源行），序號不寫入基準', () => {
  const s = build(box('R', '10.0.0.1', [['/system routerboard print', RB('7.22.2', '7.22.2')]]));
  const d = dev(s, 'R');
  assert.deepStrictEqual(d.routerboard, { isRouterboard: true, basis: 'print', model: 'CCR2116-12G-4S+', firmwareType: 'al64v3', factoryFirmware: '7.8',
    currentFirmware: '7.22.2', upgradeFirmware: '7.22.2', src: [[0, 3], [0, 4], [0, 6], [0, 7], [0, 8], [0, 9]] });
  assert.ok(!JSON.stringify(s).includes('MT123456789'), '序號不可出現在 Snapshot');
  assert.deepStrictEqual(i03(s), []);
  assert.ok(d.data.includes('routerboard'));
  assert.strictEqual(count(s, 'I01'), 0);
});
test('routerboard print：RouterOS 6 的 factory-firmware 與 minimum-firmware 同義；欄位不分前後空白', () => {
  const s = build(box('R', '10.0.0.1', [['/system routerboard print', ['  routerboard: yes', '        model: 951Ui-2HnD', '  factory-firmware: 3.0', '  current-firmware: 6.49.10', '  upgrade-firmware: 6.49.10']]]));
  assert.strictEqual(dev(s, 'R').routerboard.factoryFirmware, '3.0');
  assert.deepStrictEqual(i03(s), []);
});
test('routerboard print：非 RouterBOARD（routerboard: no）與沒有這個選單（CHR／x86 的 bad command name）都辨識為「不是 RouterBOARD」，不是 I01／I03', () => {
  const no = build(box('CHR', '10.0.0.2', [['/system routerboard print', ['  routerboard: no']]]));
  assert.deepStrictEqual(dev(no, 'CHR').routerboard, { isRouterboard: false, basis: 'print', model: null, firmwareType: null, factoryFirmware: null,
    currentFirmware: null, upgradeFirmware: null, src: [[0, 3]] });
  const x86 = build(box('CHR', '10.0.0.2', [['/system routerboard print', ['bad command name routerboard (line 1 column 9)']]]));
  assert.deepStrictEqual([dev(x86, 'CHR').routerboard.isRouterboard, dev(x86, 'CHR').routerboard.basis, dev(x86, 'CHR').routerboard.src], [false, 'no-menu', [[0, 3]]]);
  [no, x86].forEach((s) => assert.deepStrictEqual([count(s, 'I01'), i03(s).length, count(s, 'L01')], [0, 0, 0]));
  // 其他錯誤（權限不足等）仍是 I01：只有「沒有 routerboard 這個選單」代表不是 RouterBOARD
  const perm = build(box('R', '10.0.0.1', [['/system routerboard print', ['not enough permissions (9)']]]));
  assert.strictEqual(dev(perm, 'R').routerboard, null);
  assert.ok(count(perm, 'I01') + i03(perm).length > 0, '權限不足不可當成不是 RouterBOARD');
});
test('routerboard：沒有收集時為 null；settings print 不是這個指令', () => {
  const s = build(box('R', '10.0.0.1', [['/system resource print', ['    version: 7.25.1 (stable)', ' board-name: RB5009UG+S+']]]));
  assert.strictEqual(dev(s, 'R').routerboard, null);
  assert.ok(!S.adapters['mikrotik.routerboard'].command.test('/system routerboard settings print'));
});
test('system resource：uptime 解析成秒，連同該區塊的 collected-at；格式不認得時列為 I03、不猜', () => {
  const s = build(box('R', '10.0.0.1', [['/system resource print', ['# collected-at: 2026-01-01T00:00:00Z', '             uptime: 2w1d4h5m6s', '            version: 7.25.1 (stable)', '         board-name: RB5009UG+S+']]]));
  assert.deepStrictEqual(dev(s, 'R').uptime, { seconds: 2 * 604800 + 86400 + 4 * 3600 + 5 * 60 + 6, collectedAt: '2026-01-01T00:00:00Z', src: [[0, 4]] });
  const noAt = build(box('R', '10.0.0.1', [['/system resource print', ['  uptime: 1d', '  version: 7.25.1 (stable)']]]));
  assert.deepStrictEqual(dev(noAt, 'R').uptime, { seconds: 86400, collectedAt: null, src: [[0, 3]] });
  const bad = build(box('R', '10.0.0.1', [['/system resource print', ['  uptime: soon', '  version: 7.25.1 (stable)']]]));
  assert.strictEqual(dev(bad, 'R').uptime, null);
  assert.strictEqual(i03(bad).length, 1, '認不得的 uptime 不可靜默略過');
  assert.strictEqual(dev(build(box('R', '10.0.0.1', [['/export terse', ['/system identity set name=R']]])), 'R').uptime, null);
});
test('RouterOS 時間長度：單位寫法、d＋hh:mm:ss、hh:mm:ss、w＋d＋hh:mm:ss 都解析成秒；格式不符回傳 null', () => {
  const D = S.adapters.mikrotikDuration;
  assert.strictEqual(D('1w2d3h4m5s'), 604800 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.strictEqual(D('15d04:05:06'), 15 * 86400 + 4 * 3600 + 5 * 60 + 6);
  assert.strictEqual(D('00:05:01'), 301);
  assert.strictEqual(D('1w2d03:04:05'), 604800 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5, ':put [/system resource get uptime] 的寫法');
  assert.strictEqual(D('1w03:04:05'), 604800 + 3 * 3600 + 4 * 60 + 5);
  ['soon', '1w2d03:04', 'd03:04:05', ''].forEach((x) => assert.strictEqual(D(x), null, `${x} 不可解析`));
  const s = build(box('R', '10.0.0.1', [['/system resource print', ['  uptime: 1w2d03:04:05', '  version: 7.25.1 (stable)']]]));
  assert.strictEqual(dev(s, 'R').uptime.seconds, 604800 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.deepStrictEqual(i03(s), []);
});
test('L01：RouterBOOT 韌體 current 與 upgrade 不同時列出（每台一筆，證據是兩行）；相同或不是 RouterBOARD 時不列', () => {
  const s = build(box('R1', '10.0.0.1', [['/system routerboard print', RB('7.24.2', '7.25.1')]]) + box('R2', '10.0.0.2', [['/system routerboard print', RB('7.25.1', '7.25.1')]]));
  const f = s.findings.filter((x) => x.id === 'L01');
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual(f[0].entities, [{ type: 'device', key: 'R1' }]);
  assert.match(f[0].message, /R1.*7\.24\.2.*7\.25\.1/);
  assert.deepStrictEqual(f[0].evidence.map((e) => e.text), ['current-firmware: 7.24.2', 'upgrade-firmware: 7.25.1']);
  assert.strictEqual(f[0].severity, S.check.CATALOG.L01.severity);
});
test('L02：同型號（board-name）的 RouterOS 版本不同時列出，多數決標出與多數不同的設備；只比設備自報的版本', () => {
  const sys = (ver, board) => [['/system resource print', [`  version: ${ver}`, ` board-name: ${board}`]]];
  const s = build(box('A', '10.0.0.1', sys('7.25.1 (stable)', 'RB5009UG+S+')) + box('B', '10.0.0.2', sys('7.25.1', 'RB5009UG+S+'))
    + box('C', '10.0.0.3', sys('7.24.2 (stable)', 'RB5009UG+S+')) + box('D', '10.0.0.4', sys('7.20 (stable)', 'hEX S'))
    + box('E', '10.0.0.5', sys('7.25.1 (stable)', 'hEX S')));
  const f = s.findings.filter((x) => x.id === 'L02').sort((a, b) => a.message.localeCompare(b.message));
  assert.strictEqual(f.length, 2, '每個型號一筆；發布頻道（stable）不算不同');
  const rb = f.find((x) => x.message.includes('RB5009UG+S+'));
  assert.deepStrictEqual(rb.entities.map((e) => e.key), ['A', 'B', 'C']);
  assert.deepStrictEqual(rb.deviation.deviating, ['C']);
  assert.deepStrictEqual(rb.evidence.map((e) => e.text).sort(), ['version: 7.24.2 (stable)', 'version: 7.25.1', 'version: 7.25.1 (stable)']);
  const hex = f.find((x) => x.message.includes('hEX S'));
  assert.deepStrictEqual(hex.deviation.deviating, [], '兩台各一個版本：沒有多數');
  // 版本相同、只有一台、或版本是鄰居回報的（沒收集 /system resource）都不列
  const same = build(box('A', '10.0.0.1', sys('7.25.1 (stable)', 'RB5009UG+S+')) + box('B', '10.0.0.2', sys('7.25.1 (stable)', 'RB5009UG+S+')));
  assert.strictEqual(count(same, 'L02'), 0);
});
