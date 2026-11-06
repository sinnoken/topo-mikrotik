#!/usr/bin/env node
// npm test：依序執行四組測試，每一組都跑完再彙總結束碼。
// 原本以 && 串接，前面一組失敗（例如本機缺 GNU timeout 的收集器端到端）時後面就不跑，會看不到其他組的結果。
// 不用 shell 的 `a || s=1` 寫法：Windows 的 cmd.exe 不支援。
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUITES = [
  ['核心', process.execPath, ['tests/run.js']],
  ['文件', process.execPath, ['tests/docs.js']],
  ['收集器', 'bash', ['tests/collect.sh']],
  ['畫面', process.execPath, ['tests/ui-smoke.js']],
];

const results = SUITES.map(([name, cmd, args]) => {
  console.log(`\n=== ${name}：${[path.basename(cmd), ...args].join(' ')} ===`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  const ok = !r.error && r.status === 0;
  if (r.error) console.error(`無法執行：${r.error.message}`);
  return { name, ok, status: r.error ? '無法執行' : r.status };
});

console.log('\n=== 彙總 ===');
results.forEach((r) => console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `（結束碼 ${r.status}）`}`));
process.exit(results.every((r) => r.ok) ? 0 : 1);
