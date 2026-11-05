// 生成檔、黃金基準、index.html 的核心載入順序
'use strict';
const assert = require('assert');
const { S, read, gen, test, lf } = require('../lib.js');
// 生成檔一致性：產生器參數從 package.json 的 sample script 讀取（npm run sample 就是這樣產生的），兩邊不會各改各的。
const SAMPLE_FIX = '範例資料與產生器不一致：請執行 npm run sample 重新產生（生成檔不要手動修改）';
test('生成檔：samples/sample-bundle.txt 與 package.json 的 sample script 用產生器產生的結果完全相同', () => {
  const script = JSON.parse(read('package.json')).scripts.sample;
  const m = script.match(/^node tools\/gen-bundle\.js ([^>]*?)\s*>\s*samples\/sample-bundle\.txt && node tools\/embed-sample\.js$/);
  assert.ok(m, `package.json 的 sample script 格式改了，這個測試也要跟著改：${script}`);
  const want = gen(m[1].split(/\s+/).filter(Boolean));
  const got = lf(read('samples/sample-bundle.txt'));
  if (got !== want) {
    const a = got.split('\n'); const b = want.split('\n'); let k = 0; while (k < a.length && a[k] === b[k]) k++;
    assert.fail(`${SAMPLE_FIX}\n第一個不同在第 ${k + 1} 行：\n  檔案：${JSON.stringify(a[k])}\n  產生：${JSON.stringify(b[k])}`);
  }
});
test('生成檔：samples/sample-bundle.js 是 tools/embed-sample.js 對 sample-bundle.txt 的輸出', () => {
  const { embed } = require('../../tools/embed-sample.js');
  assert.ok(lf(read('samples/sample-bundle.js')) === embed(lf(read('samples/sample-bundle.txt'))), SAMPLE_FIX);
});
test('生成檔：samples/collect-commands.js 是 tools/embed-sample.js 對 tools/collector-commands.sh 的輸出；每個指令都有解析器認得', () => {
  const E = require('../../tools/embed-sample.js');
  const sh = lf(read('tools/collector-commands.sh'));
  assert.ok(lf(read('samples/collect-commands.js')) === E.collectCommandsJs(sh), '收集指令與 tools/collector-commands.sh 不一致：請執行 node tools/embed-sample.js（或 npm run sample）重新產生');
  const cmds = E.collectorCommands(sh);
  assert.ok(cmds.default.length > 0 && cmds.optional.length > 0);
  assert.ok(cmds.default.some((c) => c.command === '/export terse'));
  [...cmds.default, ...cmds.optional].forEach((c) => {
    const { blocks } = S.readers.readAll([{ name: 't.txt', text: 'SW_A (10.0.0.1):\n### ' + c.command + '\n' }]);
    assert.strictEqual(S.adapters.recognize(blocks[0]).how, 'command', `${c.id}（${c.command}）沒有解析器認得`);
  });
  assert.throws(() => E.collectorCommands('COLLECT_COMMAND_IDS=(a)\nOPTIONAL_COMMAND_IDS=()\n'), /a 沒有對應的指令/);
});
test('黃金基準：範例資料建出的 Snapshot 與 tests/golden/sample-snapshot.json 完全相同', () => {
  const G = require('../golden.js');
  const want = JSON.parse(read('tests/golden/sample-snapshot.json'));
  const got = JSON.parse(G.serialize(G.goldenSnapshot(S)));
  const diff = G.diffPaths(want, got, 10);
  assert.deepStrictEqual(diff, [], 'Snapshot 與黃金基準不同。若是刻意的變更，執行 npm run golden:update 並檢視 git diff：\n' + diff.join('\n'));
});
test('index.html 載入的核心檔案與測試相同、順序一致', () => {
  const html = read('index.html');
  const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
  const core = require('../../tools/core-files.js');
  assert.deepStrictEqual(scripts.slice(0, core.length), core);
});
