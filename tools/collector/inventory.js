'use strict';

function parseCsvLine(line, lineNumber) {
  const values = []; let value = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      values.push(value.trim()); value = '';
    } else value += ch;
  }
  if (quoted) throw new Error(`第 ${lineNumber} 行的 CSV 引號未閉合`);
  values.push(value.trim());
  return values;
}

function parseInventory(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = lines.map((line, i) => ({ line, number: i + 1 }))
    .filter((row) => row.line.trim() && !row.line.trim().startsWith('#'));
  if (!rows.length) throw new Error('設備清單是空的');
  const headers = parseCsvLine(rows[0].line, rows[0].number).map((h) => h.toLowerCase());
  const required = ['name', 'address', 'user'];
  const missing = required.filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`設備清單缺少欄位：${missing.join(', ')}`);
  const index = (name) => headers.indexOf(name);
  const seen = new Set();
  const devices = rows.slice(1).map((row) => {
    const values = parseCsvLine(row.line, row.number);
    const device = {
      name: values[index('name')] || '',
      address: values[index('address')] || '',
      user: values[index('user')] || '',
      port: values[index('port')] || '22',
    };
    if (!/^[A-Za-z0-9][\w.-]*$/.test(device.name)) throw new Error(`第 ${row.number} 行設備名稱無效：${device.name}`);
    if (!device.address || /[\s,]/.test(device.address)) throw new Error(`第 ${row.number} 行 address 無效：${device.address}`);
    if (!device.user || /[\s,]/.test(device.user)) throw new Error(`第 ${row.number} 行 user 無效`);
    if (!/^\d+$/.test(device.port) || +device.port < 1 || +device.port > 65535) throw new Error(`第 ${row.number} 行 port 無效：${device.port}`);
    if (seen.has(device.name)) throw new Error(`設備名稱重複：${device.name}`);
    seen.add(device.name);
    return device;
  });
  if (!devices.length) throw new Error('設備清單沒有資料列');
  return devices;
}

module.exports = { parseInventory, parseCsvLine };
