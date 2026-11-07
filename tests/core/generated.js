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
test('生成檔：samples/collector-files.js 是 tools/embed-sample.js 對 tools/ 的收集腳本的輸出；內容逐字相同、順序固定、陣列凍結', () => {
  const E = require('../../tools/embed-sample.js');
  const texts = E.COLLECTOR_FILES.map((f) => lf(read('tools/' + f.src)));
  const FIX = '收集腳本與 tools/ 的 collect.sh、collector-commands.sh、devices.csv 不一致：請執行 npm run sample 重新產生（生成檔不要手動修改）';
  const js = lf(read('samples/collector-files.js'));
  assert.ok(js === E.collectorFilesJs(texts), FIX);
  const ctx = {}; require('vm').runInNewContext(js, { globalThis: ctx });
  const files = ctx.SSOT.samples.collectorFiles;
  assert.deepStrictEqual(Array.from(files, (f) => f.path), ['topo-mikrotik-collector/collect.sh', 'topo-mikrotik-collector/collector-commands.sh', 'topo-mikrotik-collector/devices.csv']);
  files.forEach((f, i) => assert.ok(f.text === texts[i] && f.text.endsWith('\n'), FIX + '：' + f.path));
  assert.ok(Object.isFrozen(files) && files.every(Object.isFrozen));
});
test('黃金基準：範例資料建出的 Snapshot 與 tests/golden/sample-snapshot.json 完全相同', () => {
  const G = require('../golden.js');
  const want = JSON.parse(read('tests/golden/sample-snapshot.json'));
  const got = JSON.parse(G.serialize(G.goldenSnapshot(S)));
  const diff = G.diffPaths(want, got, 10);
  assert.deepStrictEqual(diff, [], 'Snapshot 與黃金基準不同。若是刻意的變更，執行 npm run golden:update 並檢視 git diff：\n' + diff.join('\n'));
});
test('黃金基準：範例資料的 findingKey 集合與黃金檔相同，也與 3.1.0 改寫訊息（結論在前）之前相同', () => {
  // findingKey 不含訊息：改寫 message 不可讓處理紀錄對不上。釘住的雜湊是改寫前 57 筆 findingKey 排序後以換行串接的 SHA-256；
  // 刻意新增、刪除 finding 或改變實體時才更新這個值（與 golden:update 一起檢視）
  const G = require('../golden.js');
  const keysOf = (snap) => { const Q = S.query(snap); return snap.findings.map((f) => Q.findingKey(f)).sort(); };
  const got = keysOf(G.goldenSnapshot(S));
  assert.deepStrictEqual(got, keysOf(JSON.parse(read('tests/golden/sample-snapshot.json'))));
  // 3.4.0 新增的管理面檢查（F10–F14）、3.5.0 的生命週期檢查（L01、L02）與 3.7.0 的 F15 不在改寫前的集合裡：去掉它們之後仍是原來那 57 筆
  // 3.8.0（ADR-023）：新增的路由檢查 R07–R15，以及 CE 以邊界證據判定對外後新找到的 F03、F07（原本漏報）也不在改寫前的集合裡
  // 3.9.0：新增的 F16
  const NEW_SINCE = /^\["(F1[0-6]|L0[12]|R0[7-9]|R1[0-5])"|^\["F0[37]","device:TPE_CE_RT_01"/;
  const old = got.filter((k) => !NEW_SINCE.test(k));
  const sha = require('crypto').createHash('sha256').update(old.join('\n')).digest('hex');
  assert.deepStrictEqual([old.length, sha], [57, 'da132cf19feeb45e18f7de6dd0db3d8f30d44b25320fc00549365dcca69c3faa']);
  assert.strictEqual(got.length - old.length, 9 + 11 + 2, '範例資料的 F10–F16、L01、L02 各一筆；R07–R15 共 11 筆；CE 的 F03、F07 各一筆');
});
test('index.html 載入的核心檔案與測試相同、順序一致', () => {
  const html = read('index.html');
  const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
  const core = require('../../tools/core-files.js');
  assert.deepStrictEqual(scripts.slice(0, core.length), core);
});
