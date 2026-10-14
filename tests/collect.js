'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { parseInventory } = require('../tools/collector/inventory.js');
const { select } = require('../tools/collector/commands.js');
const { runCommand } = require('../tools/collector/ssh.js');
const { serializeBundle } = require('../tools/collector/bundle.js');
const { parseArgs, selectedDevices } = require('../tools/collect.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('設備清單：解析欄位、預設 port 與註解', () => {
  const devices = parseInventory('# devices\nname,address,user,port\nSW_A,10.0.0.1,admin,\n');
  assert.deepStrictEqual(devices, [{ name: 'SW_A', address: '10.0.0.1', user: 'admin', port: '22' }]);
});

test('設備清單：拒絕缺欄位與重複名稱', () => {
  assert.throws(() => parseInventory('name,address\nSW_A,10.0.0.1'), /缺少欄位/);
  assert.throws(() => parseInventory('name,address,user\nSW_A,10.0.0.1,a\nSW_A,10.0.0.2,a'), /重複/);
});

test('命令清單：可選取固定 ID，不接受任意 command', () => {
  assert.strictEqual(select('config,neighbor').length, 2);
  assert.throws(() => select('config,rm'), /未知收集指令/);
});

test('bundle serializer：固定標記、分隔線、換行與失敗註記', () => {
  const text = serializeBundle([{
    name: 'SW_A', address: '10.0.0.1',
    results: [
      { command: { command: '/export terse' }, result: { ok: true, stdout: 'a\r\nb\r\n' } },
      { command: { command: '/ip route print detail without-paging' }, result: { ok: false, stdout: '', code: 255, timedOut: false } },
    ],
  }]);
  assert.strictEqual(text, 'SW_A (10.0.0.1):\n### /export terse\na\nb\n### /ip route print detail without-paging\n# collection failed: exit code 255\n_____\n');
});

test('ssh runner：使用 BatchMode、傳遞指令，成功回傳 stdout', async () => {
  const calls = [];
  const spawnImpl = (path, args) => {
    calls.push({ path, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => { child.stdout.emit('data', 'ok'); child.emit('close', 0, null); });
    return child;
  };
  const result = await runCommand({ address: '10.0.0.1', user: 'admin', port: '22' },
    { command: '/export terse' }, { spawnImpl, timeoutMs: 1000 });
  assert.ok(result.ok);
  assert.strictEqual(result.stdout, 'ok');
  assert.deepStrictEqual(calls[0].args, ['-o', 'BatchMode=yes', '-p', '22', 'admin@10.0.0.1', '/export terse']);
});

test('ssh runner：timeout 後重試並回傳最後失敗', async () => {
  let calls = 0;
  const spawnImpl = () => {
    calls++;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    return child;
  };
  const result = await runCommand({ address: '10.0.0.1', user: 'admin', port: '22' },
    { command: '/export terse' }, { spawnImpl, timeoutMs: 10, retry: 1 });
  assert.strictEqual(calls, 2);
  assert.ok(result.timedOut);
  assert.strictEqual(result.attempts, 2);
});

test('CLI：解析輸出、timeout、retry 與 device filter', () => {
  assert.deepStrictEqual(parseArgs(['devices.csv', '--output', 'x.txt', '--timeout', '5000', '--retry', '2']),
    { inventory: 'devices.csv', output: 'x.txt', timeout: 5000, retry: 2, concurrency: 1 });
  const devices = [{ name: 'A' }, { name: 'B' }];
  assert.deepStrictEqual(selectedDevices(devices, 'B'), [{ name: 'B' }]);
  assert.match(require('../tools/collect.js').usage(), /--help/);
});

(async () => {
  let fail = 0;
  for (const item of tests) {
    try { await item.fn(); console.log(`  ✓ ${item.name}`); }
    catch (error) { fail++; console.log(`  ✗ ${item.name}\n      ${error.message}`); }
  }
  console.log(`\n${tests.length - fail} 通過，${fail} 失敗`);
  process.exitCode = fail ? 1 : 0;
})();
