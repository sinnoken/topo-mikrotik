#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { parseInventory } = require('./collector/inventory.js');
const { select } = require('./collector/commands.js');
const { runCommand } = require('./collector/ssh.js');
const { serializeBundle } = require('./collector/bundle.js');

function usage() {
  return [
    '用法：node tools/collect.js <devices.csv> [選項]',
    '',
    '選項：',
    '  --output <file>          輸出 bundle-v1 檔（預設 collection.txt）',
    '  --device <name,...>      只收集指定設備',
    '  --command <id,...>       只執行指定命令 ID',
    '  --timeout <ms>            單一 SSH 指令 timeout（預設 30000）',
    '  --retry <n>               失敗後重試次數（預設 0）',
    '  --concurrency <n>         同時收集的設備數（預設 1）',
    '  --dry-run                 只驗證清單並列出命令，不連線',
    '  --help                    顯示說明',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { output: 'collection.txt', timeout: 30000, retry: 0, concurrency: 1 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2); const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`選項 ${arg} 需要值`);
      if (key === 'output') options.output = value;
      else if (key === 'timeout' || key === 'retry' || key === 'concurrency') options[key] = Number(value);
      else if (key === 'device' || key === 'command') options[key] = value;
      else throw new Error(`未知選項：${arg}`);
    } else positional.push(arg);
  }
  if (positional.length !== 1) throw new Error('用法：node tools/collect.js <devices.csv> [選項]');
  if (!Number.isInteger(options.timeout) || options.timeout < 1000) throw new Error('--timeout 必須是至少 1000 的整數');
  if (!Number.isInteger(options.retry) || options.retry < 0) throw new Error('--retry 必須是非負整數');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency 必須是正整數');
  return { ...options, inventory: positional[0] };
}

function selectedDevices(devices, value) {
  if (!value) return devices;
  const names = new Set(value.split(',').map((name) => name.trim()).filter(Boolean));
  const result = devices.filter((device) => names.has(device.name));
  const missing = [...names].filter((name) => !devices.some((device) => device.name === name));
  if (missing.length) throw new Error(`找不到設備：${missing.join(', ')}`);
  return result;
}

async function collect(options, io = console) {
  const devices = selectedDevices(parseInventory(fs.readFileSync(options.inventory, 'utf8')), options.device);
  const commands = select(options.command);
  if (options.dryRun) {
    devices.forEach((device) => commands.forEach((command) => io.log(`${device.name}: ${command.command}`)));
    return { devices, failures: 0, dryRun: true };
  }
  const collected = new Array(devices.length);
  let next = 0;
  const worker = async () => {
    while (next < devices.length) {
      const index = next++;
      const device = devices[index];
      io.log(`收集 ${device.name} (${device.address})`);
      const results = [];
      for (const command of commands) {
        const result = await runCommand(device, command, { timeoutMs: options.timeout, retry: options.retry });
        results.push({ command, result });
        io.log(`  ${result.ok ? 'OK' : 'FAIL'} ${command.id}${result.timedOut ? ' timeout' : ''}`);
      }
      collected[index] = { ...device, results };
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, devices.length) }, worker));
  const failures = collected.reduce((count, device) => count + device.results.filter(({ result }) => !result.ok).length, 0);
  fs.writeFileSync(options.output, serializeBundle(collected), 'utf8');
  return { devices: collected, failures, output: options.output };
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exitCode = 0;
  } else collect(options).then((result) => {
    if (!result.dryRun) console.log(`\n輸出：${result.output}；失敗 ${result.failures} 個指令`);
    process.exitCode = result.failures ? 1 : 0;
  }).catch((error) => {
    console.error(`collect: ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, collect, selectedDevices, usage };
