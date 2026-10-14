'use strict';

const { spawn } = require('child_process');

function runOnce(device, command, options) {
  const spawnImpl = options.spawnImpl || spawn;
  const args = ['-o', 'BatchMode=yes', '-p', String(device.port), `${device.user}@${device.address}`, command.command];
  return new Promise((resolve) => {
    const child = spawnImpl(options.sshPath || 'ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false; let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer); resolve(result);
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish({ ok: false, stdout, stderr: `${stderr}${error.message}`, code: null, signal: null, timedOut: false }));
    child.once('close', (code, signal) => finish({ ok: code === 0, stdout, stderr, code, signal, timedOut: false }));
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, stdout, stderr, code: null, signal: 'SIGTERM', timedOut: true });
    }, options.timeoutMs);
  });
}

async function runCommand(device, command, options = {}) {
  const retry = Number.isInteger(options.retry) ? options.retry : 0;
  const attempts = [];
  for (let attempt = 0; attempt <= retry; attempt++) {
    const result = await runOnce(device, command, { ...options, timeoutMs: options.timeoutMs || 30000 });
    attempts.push(result);
    if (result.ok) return { ...result, attempts: attempt + 1 };
  }
  return { ...attempts[attempts.length - 1], attempts: attempts.length };
}

module.exports = { runCommand };
