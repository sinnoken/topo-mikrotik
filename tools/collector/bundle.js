'use strict';

function cleanOutput(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

function failureNote(result) {
  if (result.timedOut) return '# collection failed: timeout';
  if (result.code !== null) return `# collection failed: exit code ${result.code}`;
  return '# collection failed: ssh process error';
}

function serializeBundle(devices) {
  const out = [];
  devices.forEach((device) => {
    out.push(`${device.name} (${device.address}):`);
    device.results.forEach(({ command, result }) => {
      out.push(`### ${command.command}`);
      const body = cleanOutput(result.stdout);
      if (body) out.push(body);
      if (!result.ok) out.push(failureNote(result));
    });
    out.push('_____');
  });
  return out.join('\n') + '\n';
}

module.exports = { serializeBundle, cleanOutput };
