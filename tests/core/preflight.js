// 建立前的預檢（S.preflight）：只讀取、辨識、解析，不建模；結果必須和完整建立的已收集設備、I01、I03 一致
'use strict';
const assert = require('assert');
const { S, read, test } = require('../lib.js');

// 預檢依輸入順序列出；findings 另有排序，比對時都排序
// I01 的訊息是「結論：位置＋補充」，預檢的 reason 是「結論＋補充」：訊息去掉「：位置」就是 reason
const placeOf = (u) => S.check.placeText(u.file, u.startLine, u.endLine);
const msgOf = (u) => `${placeOf(u)}｜${u.reason}`;
const i01Of = (s, p) => s.findings.filter((f) => f.id === 'I01').map((f) => {
  const u = p.unrecognized.find((x) => f.message.includes('：' + placeOf(x)) && f.message.replace('：' + placeOf(x), '') === x.reason);
  return u ? msgOf(u) : f.message;
});
const preflightMatchesBuild = (sources, opt) => {
  const p = S.preflight(sources, opt);
  const s = S.build(sources, Object.assign({ now: '2026-01-01T00:00:00Z' }, opt));
  const collected = s.model.devices.filter((d) => d.collected);
  // 預檢的設備＝完整建立的已收集設備＋內容都認不得的設備（沒有資料、沒有收集失敗；建立時不建立，輸入畫面標「沒有可用的資料」）
  const keys = new Set(collected.map((d) => d.key));
  assert.deepStrictEqual(p.devices.filter((d) => keys.has(d.key)).map((d) => d.key), collected.map((d) => d.key), '已收集的設備都應列在預檢');
  p.devices.filter((d) => !keys.has(d.key)).forEach((d) => assert.deepStrictEqual([d.dataTypes, d.failures], [[], 0], `${d.name} 沒有建立，應是沒有資料的設備`));
  p.devices.filter((d) => keys.has(d.key)).forEach((d) => assert.deepStrictEqual(d.dataTypes, collected.find((c) => c.key === d.key).data, `${d.name} 的資料種類應與完整建立相同`));
  assert.deepStrictEqual(p.unrecognized.map(msgOf).sort(), i01Of(s, p).sort(), '無法辨識的段落應與 I01 相同');
  assert.deepStrictEqual(p.partial.map((x) => `${x.file}:${x.startLine}:${x.lines}`).sort(),
    s.blocks.filter((b) => b.unrecognizedLines.length).map((b) => `${b.file}:${b.start}:${b.unrecognizedLines.length}`).sort(), '有認不得的行的區塊應與 I03 相同');
  assert.strictEqual(p.partial.length, s.findings.filter((f) => f.id === 'I03').length);
  assert.strictEqual(p.blockCount, s.meta.blockCount);
  return p;
};

test('預檢：範例資料的設備、資料種類、無法辨識段落與完整建立一致', () => {
  const p = preflightMatchesBuild([{ name: 'sample-bundle.txt', text: read('samples/sample-bundle.txt') }]);
  assert.ok(p.devices.length > 1 && p.unrecognized.length >= 1);
  const core = p.devices.find((d) => d.name === 'TPE_CORE_RT_01');
  assert.ok(core.blocks > 1 && core.dataTypes.includes('lldp') && core.dataLabels.includes(S.query.dataLabel('lldp')), JSON.stringify(core));
});

test('預檢：壞掉的輸入（標頭前的內容、不認得的指令、非 detail 格式、指令錯誤、收集註解有誤、沒有標頭的貼上）逐段列出檔名、行號與原因', () => {
  const text = ['隨便一段文字', '', 'SW_A (10.0.0.1):', '### /ip neighbor print detail without-paging',
    ' 0 interface=ether1 address=10.0.0.2 mac-address=AA:BB:CC:00:00:02 identity="SW_B" platform="MikroTik"',
    '### /foo bar print', 'xyz',
    '### /interface bridge vlan print detail without-paging', 'garbage line that is not detail',
    '### /ip vrf print detail without-paging', 'bad command name (line 1 column 5)',
    '### /system resource print', '# collected-at: yesterday', '            version: 7.12.1 (stable)'].join('\n');
  const p = preflightMatchesBuild([{ name: 'a.txt', text }, { name: S.readers.PASTE, text: '沒有標頭的貼上\n第二行' }]);
  assert.deepStrictEqual(p.devices.map((d) => [d.name, d.blocks]), [['SW_A', 5]]);
  const u = p.unrecognized;
  assert.deepStrictEqual(u.map((x) => [x.kind, x.file, x.startLine, x.device]), [
    ['block', 'a.txt', 1, null], ['block', 'a.txt', 7, 'SW_A'], ['block', 'a.txt', 9, 'SW_A'], ['block', 'a.txt', 11, 'SW_A'],
    ['note', 'a.txt', 13, 'SW_A'], ['block', S.readers.PASTE, 1, null]]);
  assert.ok(/\/foo bar print/.test(u[1].reason) && /detail/.test(u[2].reason) && /指令執行錯誤/.test(u[3].reason) && /收集時間/.test(u[4].reason), JSON.stringify(u));
  assert.strictEqual(u[0].reason, '沒有設備標頭');
  const none = S.preflight([{ name: S.readers.PASTE, text: '' }]);
  assert.deepStrictEqual([none.devices.length, none.unrecognized.length], [0, 1], '空白輸入也要明確回報，不靜默成功');
});

test('預檢：命名規則正規化設備名時，合併後的設備鍵與完整建立相同', () => {
  const profile = { id: 't', version: '1', stripDomain: true };
  const nb = '### /ip neighbor print detail without-paging\n 0 interface=ether1 identity="X" mac-address=AA:BB:CC:00:00:09\n';
  const p = preflightMatchesBuild([{ name: 't.txt', text: 'SW_A.corp.local (10.0.0.1):\n' + nb + '_____\nSW_A (10.0.0.1):\n' + nb }], { profile });
  assert.deepStrictEqual(p.devices.map((d) => [d.key, d.blocks]), [['SW_A', 2]]);
  assert.strictEqual(S.preflight([{ name: 't.txt', text: 'SW_A.corp.local (10.0.0.1):\n' + nb + '_____\nSW_A (10.0.0.1):\n' + nb }]).devices.length, 2, '不套用命名規則時是兩台');
});

test('預檢：空的命中次數區塊算已收集（資料種類與完整建立相同）；連線失敗只有註解的區塊不算無法辨識', () => {
  const text = ['R (10.0.0.1):', '### /export terse', '/interface bridge add name=bridge1', '### /ip firewall raw print stats detail without-paging',
    '_____', 'R2 (10.0.0.2):', '# collection failed: connection timeout'].join('\n');
  const p = preflightMatchesBuild([{ name: 'f.txt', text }]);
  assert.ok(p.devices.find((d) => d.key === 'R').dataTypes.includes('fwstats'), JSON.stringify(p.devices));
  assert.ok(p.devices.some((d) => d.key === 'R2'));
  assert.deepStrictEqual(p.unrecognized, []);
});

test('預檢：已解析的區塊中有認不得的行時列在 partial（與 I03 相同），不算整段無法辨識', () => {
  const text = ['SW (10.0.0.1):', '### /ip arp print detail without-paging',
    ' 0 DC address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1', 'GARBAGE LINE here'].join('\n');
  const p = preflightMatchesBuild([{ name: 'g.txt', text }]);
  assert.deepStrictEqual(p.partial.map((x) => [x.file, x.device, x.command, x.lines]), [['g.txt', 'SW', '/ip arp print detail without-paging', 1]]);
  assert.deepStrictEqual(p.unrecognized, []);
});

test('認到設備：Q.recognizedDevices 與 S.query.preflightRecognized 是同一個判斷，排除只有檔名或標頭、沒有任何資料的設備', () => {
  const ARP = '### /ip arp print detail\n 0 DC address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1\n';
  const cases = [
    ['只有註解', [{ name: 'c.txt', text: '# 收集檔\n# 這一輪沒有輸出\n' }], []],
    ['只有位置不對的 collected-at', [{ name: 'R_X.txt', text: '# collected-at: 2026-10-24T03:00:00Z\n' }], []],
    ['沒有設備標頭、內容都認不得', [{ name: 'junk.txt', text: 'hello\nworld\n' }], []],
    ['有設備標頭、沒有資料', [{ name: 'b.txt', text: 'R_A (10.0.0.1):\nhello\n' }], []],
    ['只有收集失敗', [{ name: 'b.txt', text: 'R_B (10.0.0.2):\n# collection failed: connection\n' }], ['R_B']],
    ['正常資料', [{ name: 'SW_F.txt', text: ARP }], ['SW_F']],
    ['混合', [{ name: 'junk.txt', text: 'hello\n' }, { name: 'SW_F.txt', text: ARP }, { name: 'b.txt', text: 'R_A (10.0.0.1):\nhello\n' }], ['SW_F']],
  ];
  cases.forEach(([name, sources, want]) => {
    const Q = S.query(S.build(sources, { now: '2026-01-01T00:00:00Z' }));
    const p = preflightMatchesBuild(sources);
    assert.deepStrictEqual(Q.recognizedDevices().map((d) => d.key), want, `${name}：Q.recognizedDevices`);
    assert.deepStrictEqual(S.query.preflightRecognized(p).map((d) => d.key), want, `${name}：預檢`);
  });
  // 建立後：認不到的設備不建立（已收集的設備就是認到的設備，覆蓋率也不算它們）
  cases.forEach(([name, sources, want]) => {
    const s = S.build(sources, { now: '2026-01-01T00:00:00Z' });
    assert.deepStrictEqual(s.model.devices.filter((d) => d.collected).map((d) => d.key), want, `${name}：已收集的設備`);
    assert.deepStrictEqual(s.coverage.map((c) => c.dev), want, `${name}：覆蓋率`);
    assert.strictEqual(s.meta.stats.collected, want.length, `${name}：meta.stats.collected`);
  });
  // 範例資料：已收集的設備都認到
  const sample = [{ name: 'sample-bundle.txt', text: read('samples/sample-bundle.txt') }];
  const Q = S.query(S.build(sample, { now: '2026-01-01T00:00:00Z' }));
  assert.deepStrictEqual(Q.recognizedDevices().map((d) => d.key), Q.devices().filter((d) => d.collected).map((d) => d.key));
  assert.deepStrictEqual(S.query.preflightRecognized(S.preflight(sample)).map((d) => d.key), Q.recognizedDevices().map((d) => d.key));
});
