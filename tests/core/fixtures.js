// 真實設備輸出與官方手冊的輸出範例（tests/fixtures/real、manual）
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { S, ROOT, read, build, ids, iface, test, i03 } = require('../lib.js');
test('真實設備輸出（tests/fixtures/real/）：每份都完整解析，沒有 I01', () => {
  const dir = path.join(ROOT, 'tests/fixtures/real');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  if (!files.length) console.log('      （尚無真實設備輸出；新增方式見 tests/fixtures/real/README.md）');
  files.forEach((f) => {
    const s = S.build([{ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }], { now: '2026-01-01T00:00:00Z' });
    const i01 = s.findings.filter((x) => x.id === 'I01').map((x) => x.message);
    assert.deepStrictEqual(i01, [], `${f} 有無法解析的內容`);
    s.blocks.filter((b) => b.device !== null).forEach((b) => assert.ok(b.adapters.length && !b.empty, `${f} 第 ${b.start} 行的 ${b.command || '區塊'} 沒有解析出內容`));
  });
});
test('官方手冊的輸出範例（tests/fixtures/manual/，原文照錄）：完整解析並取得關鍵欄位', () => {
  const load = (f) => build(read(`tests/fixtures/manual/${f}`));
  const stp = (s, k) => { const i = iface(s, k); return i && i.stp && [i.stp.role, i.stp.designatedBridge, i.stp.designatedPort]; };
  const two = load('routeros7-bridge-port-monitor.txt');
  assert.ok(!ids(two).includes('I01'), JSON.stringify(two.findings.filter((f) => f.id === 'I01').map((f) => f.message)));
  assert.deepStrictEqual([stp(two, 'SW_MANUAL|ether1'), stp(two, 'SW_MANUAL|ether2')],
    [['alternate-port', '64D154C73A6E', 1], ['designated-port', null, 2]], '空白欄位不可讓整行被略過，也不可錯位到別的埠');
  const one = load('routeros7-bridge-port-monitor-single.txt');
  assert.deepStrictEqual(stp(one, 'SW_MANUAL|ether1'), ['root-port', '2CC81BFF92F4', 1]);
  const pn = load('routeros7-bridge-port-monitor-port-number.txt');
  assert.deepStrictEqual([iface(pn, 'SW_MANUAL|sfp-sfpplus1').stp.role, iface(pn, 'SW_MANUAL|sfp-sfpplus1').stp.portNumber], ['designated-port', 1]);
  const br = load('routeros7-bridge-monitor.txt');
  assert.ok(br.model.devices[0].ownMacs.includes('2CC81BFF92F4'));
  assert.deepStrictEqual([br.model.devices[0].stp.rootBridge, br.model.devices[0].stp.isRoot], ['2CC81BFF92F4', true]);
  const ex = load('routeros-export-header.txt');
  assert.strictEqual(ex.model.devices[0].collectedAt, '1970-04-02T17:59:30', 'RouterOS 6 也有「年-月-日」格式的 export 抬頭');
  ['routeros7-bridge-port-monitor-single.txt', 'routeros7-bridge-monitor.txt', 'routeros-export-header.txt'].forEach((f) => assert.ok(!ids(load(f)).includes('I01'), f));
  // 第一欄是空白的行（last-topology-change）冒號仍對齊：值屬於第二欄，不是整行丟掉（I03 找到的）
  const cols = S.adapters.mikrotikMonitorColumns(S.readers.readAll([{ name: 'm.txt', text: read('tests/fixtures/manual/routeros7-bridge-port-monitor.txt') }]).blocks[0]);
  assert.deepStrictEqual(cols.map((c) => c['last-topology-change']), [undefined, '34m53s']);
  fs.readdirSync(path.join(ROOT, 'tests/fixtures/manual')).filter((f) => f.endsWith('.txt')).forEach((f) => assert.deepStrictEqual(i03(load(f)).map((x) => x.message), [], f));
});
