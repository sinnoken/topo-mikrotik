// 讀取（bundle-v1、files-v1、收集器註解、I01）與 RouterOS 7 的斜線路徑
'use strict';
const assert = require('assert');
const { S, read, build, ids, iface, test } = require('../lib.js');
// ------------------------------------------------------------------ 讀取
test('bundle-v1：設備標頭、分隔線可省略、兩種指令標記、註解行、行號', () => {
  const text = ['# 註解', 'SW_A (10.0.0.1):', '### /ip neighbor print detail without-paging', 'X', '_____',
    'SW_B (10.0.0.2):', '[admin@SW_B] > /interface bridge vlan print detail', 'Y', 'R_C (10.0.0.3):', '[admin@R_C] > /ip route print detail', 'Z'].join('\n');
  const { blocks } = S.readers.readAll([{ name: 'a.txt', text }]);
  assert.deepStrictEqual(blocks.map((b) => [b.device, b.command, b.origin.startLine]), [
    ['SW_A', '/ip neighbor print detail without-paging', 4], ['SW_B', '/interface bridge vlan print detail', 8], ['R_C', '/ip route print detail', 11]]);
  assert.strictEqual(blocks[0].mgmtIp, '10.0.0.1');
});
test('files-v1：沒有標頭時以檔名為設備名', () => {
  const { blocks } = S.readers.readAll([{ name: 'dir/EDGE_SW_9.txt', text: '### /ip arp print detail\nfoo' }]);
  assert.strictEqual(blocks[0].device, 'EDGE_SW_9');
  assert.strictEqual(blocks[0].reader, 'files-v1');
});
test('收集器註解：collected-at 與 collection failed 讀進區塊，C02／coverage 區分沒收集與收集失敗，註解不是 I01', () => {
  const s = S.build([{ name: 'c.txt', text: read('tests/fixtures/collector/collected-at-and-failures.txt') }], { now: '2026-01-01T00:00:00Z' });
  assert.ok(!ids(s).includes('I01'), JSON.stringify(s.findings.filter((f) => f.id === 'I01').map((f) => f.message)));
  assert.deepStrictEqual(s.blocks.map((b) => [b.device, b.command && b.command.split(' ')[1], b.collectedAt, b.failure && b.failure.reason]), [
    ['SW_A', 'resource', '2026-10-24T03:00:00Z', null], ['SW_A', 'neighbor', '2026-10-24T03:00:02Z', null],
    ['SW_A', 'bridge', '2026-10-24T03:00:04Z', 'timeout'], ['SW_A', 'terse', '2026-10-24T03:00:34Z', 'exit-code'], ['R_B', null, null, 'connection']]);
  assert.deepStrictEqual(s.blocks[3].failure, { reason: 'exit-code', exitCode: 255, text: 'exit code 255', line: 18 });
  // 失敗前的部分輸出照常解析（export 的 bridge1）
  assert.ok(iface(s, 'SW_A|bridge1'), '失敗區塊裡已輸出的內容仍要解析');
  // 連線失敗的設備不會消失：列為已收集、所有資料缺少，並註明失敗原因
  const rb = s.model.devices.find((d) => d.key === 'R_B');
  assert.ok(rb.collected);
  const c02 = (k) => s.findings.find((f) => f.id === 'C02' && f.entities[0].key === k);
  assert.strictEqual(c02('R_B').message, 'R_B（路由器）缺少：鄰居、設定、路由表；收集失敗：連線（connection）');
  assert.deepStrictEqual(c02('R_B').evidence.map((e) => [e.line, e.text]), [[21, '# collection failed: connection']]);
  assert.strictEqual(c02('SW_A').message, 'SW_A（交換器）缺少：MAC 表；收集失敗：/interface bridge host print detail without-paging（timeout）、/export terse（exit code 255）');
  assert.deepStrictEqual(c02('SW_A').evidence.slice(0, 2).map((e) => [e.line, e.text]), [[14, '# collection failed: timeout'], [18, '# collection failed: exit code 255']]);
  const cov = s.coverage.find((r) => r.dev === 'SW_A');
  assert.deepStrictEqual(cov.missing, ['mac']);
  assert.deepStrictEqual(cov.failures.map((x) => [x.command.split(' ')[0], x.reason, x.exitCode, x.dataTypes]), [['/interface', 'timeout', null, ['mac']], ['/export', 'exit-code', 255, ['config']]]);
  assert.deepStrictEqual(s.coverage.find((r) => r.dev === 'R_B').failures.map((x) => [x.command, x.reason]), [[null, 'connection']]);
  // files-v1 也一樣讀得到
  const f = S.build([{ name: 'SW_F.txt', text: '### /ip arp print detail\n# collected-at: 2026-10-24T03:00:00Z\n 0 DC address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1\n' }], { now: '2026-01-01T00:00:00Z' });
  assert.strictEqual(f.blocks[0].collectedAt, '2026-10-24T03:00:00Z');
});
test('收集器註解：時間格式或位置不對列為 I01（指回該行），不靜默丟棄；舊格式的區塊欄位為 null 且結果不變', () => {
  const t = (lines) => build(['SW_A (10.0.0.1):', '### /ip arp print detail', ...lines, ' 0 DC address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1'].join('\n'));
  ['2026-10-24 03:00:00', '2026-10-24T03:00:00+08:00', '2026-10-24T03:00:00.123Z', '2026-02-30T03:00:00Z', ''].forEach((bad) => {
    const s = t([`# collected-at: ${bad}`]);
    const i01 = s.findings.filter((x) => x.id === 'I01');
    assert.strictEqual(i01.length, 1, bad);
    assert.ok(/第 3 行：收集時間「.*」不是 UTC ISO 8601/.test(i01[0].message), i01[0].message);
    assert.deepStrictEqual(i01[0].evidence.map((e) => [e.line, e.text]), [[3, `# collected-at: ${bad}`.trim()]]);
    assert.strictEqual(s.blocks[0].collectedAt, null);
    assert.strictEqual(s.model.arps.length, 1, '時間格式不對不影響區塊內容的解析');
  });
  const misplaced = t(['', '# collected-at: 2026-10-24T03:00:00Z']);
  assert.ok(/不在指令標記的下一行/.test(misplaced.findings.find((x) => x.id === 'I01').message));
  assert.strictEqual(misplaced.blocks[0].collectedAt, null);
  const dup = t(['# collection failed: timeout', '# collection failed: exit code 1']);
  assert.ok(/第二個收集失敗註解/.test(dup.findings.find((x) => x.id === 'I01').message));
  assert.strictEqual(dup.blocks[0].failure.reason, 'timeout');
  const other = t(['# collection failed: 主機拒絕']);
  assert.deepStrictEqual([other.blocks[0].failure.reason, other.blocks[0].failure.text], ['other', '主機拒絕']);
  // 舊格式：沒有這兩行時區塊沒有額外內容，序列化為 null；有正確的註解時事實與檢查結果相同（只差行號）
  const old = t([]); const neu = t(['# collected-at: 2026-10-24T03:00:00Z']);
  const raw = S.readers.readAll([{ name: 'a.txt', text: 'SW_A (10.0.0.1):\n### /ip arp print detail\nX\n' }]).blocks[0];
  assert.deepStrictEqual(Object.keys(raw).sort(), ['command', 'device', 'id', 'lines', 'mgmtIp', 'origin', 'reader']);
  assert.deepStrictEqual([old.blocks[0].collectedAt, old.blocks[0].failure], [null, null]);
  assert.deepStrictEqual(ids(neu), ids(old));
  assert.deepStrictEqual(neu.model.arps.map((a) => [a.ip, a.mac]), old.model.arps.map((a) => [a.ip, a.mac]));
});
test('沒有設備標頭的內容列為無法辨識（不靜默丟棄）', () => {
  const s = build('隨便一段文字\nSW_A (10.0.0.1):\n### /ip neighbor print detail\n');
  assert.ok(ids(s).includes('I01'));
});
test('指令有辨識但輸出不是 detail 格式 → I01，並提示加 detail', () => {
  const s = build('SW_A (10.0.0.1):\n### /ip arp print\nFlags: X - disabled\n #   ADDRESS       MAC-ADDRESS       INTERFACE\n 0 DC 10.0.0.2    AA:BB:CC:00:00:01 bridge1\n');
  const f = s.findings.find((x) => x.id === 'I01');
  assert.ok(f && /detail/.test(f.message), f && f.message);
});
test('I01：區塊內容全是 RouterOS 錯誤訊息時，訊息說明指令執行錯誤（列出第一行），不提示加 detail；id／標題／嚴重度不變', () => {
  const i01 = (text) => build(text).findings.filter((x) => x.id === 'I01');
  // 解析器認得指令、但輸出只有錯誤訊息（含空行與多行錯誤）
  const known = i01('SW_A (10.0.0.1):\n### /interface wifi registration-table print detail without-paging\n\nbad command name registration-table (line 1 column 16)\nsyntax error (line 1 column 30)\n');
  assert.strictEqual(known.length, 1);
  assert.deepStrictEqual([known[0].severity, known[0].title, known[0].entities], [S.check.CATALOG.I01.severity, S.check.CATALOG.I01.title, [{ type: 'device', key: 'SW_A' }]]);
  assert.ok(/指令執行錯誤：bad command name registration-table \(line 1 column 16\)/.test(known[0].message), known[0].message);
  assert.ok(/RouterOS 版本/.test(known[0].message) && /套件/.test(known[0].message), known[0].message);
  assert.ok(!/請加上 detail/.test(known[0].message), known[0].message);
  // 沒有解析器支援的指令、輸出只有錯誤訊息：同樣說明指令執行錯誤
  const unknown = i01('SW_A (10.0.0.1):\n### /foo bar print\nexpected end of command (line 1 column 6)\n');
  assert.ok(/指令執行錯誤：expected end of command/.test(unknown[0].message) && /\/foo bar print/.test(unknown[0].message), unknown[0].message);
  // 錯誤訊息之外還有其他文字：不是「全是錯誤訊息」，維持原本的說明
  const mixed = i01('SW_A (10.0.0.1):\n### /ip arp print\nbad command name arp\n隨便一段文字\n');
  assert.ok(!/指令執行錯誤/.test(mixed[0].message) && /請加上 detail without-paging/.test(mixed[0].message), mixed[0].message);
});

test('RouterOS 7 的斜線路徑：指令標記與 export 選單路徑都視同空白分隔；提示字元可省略 >', () => {
  const s = build(['SW (10.0.0.1):', '[admin@SW] > /ip/neighbor/print detail without-paging',
    ' 0 interface=ether1 mac-address=AA:BB:CC:00:00:02 identity=R2 interface-name=ether2',
    '[admin@SW] /interface/bridge/host/print detail without-paging', ' 0 D mac-address=AA:BB:CC:00:00:09 on-interface=ether3 bridge=bridge1',
    '### /export terse', '/interface/bridge/port add bridge=bridge1 interface=ether3 pvid=30', '/interface/bridge add name=bridge1 vlan-filtering=yes'].join('\n'));
  assert.deepStrictEqual(s.blocks.map((b) => b.command), ['/ip neighbor print detail without-paging', '/interface bridge host print detail without-paging', '/export terse']);
  assert.ok(!ids(s).includes('I01'));
  assert.deepStrictEqual([iface(s, 'SW|ether3').bridge, iface(s, 'SW|ether3').pvid], ['SW|bridge1', 30]);
});
