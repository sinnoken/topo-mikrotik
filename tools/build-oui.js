// 將 IEEE OUI 原始資料（silverwind/oui-data 格式：{"001122": "Vendor\n地址…"}）
// 轉成精簡的 src/data/oui-data.js：廠商名稱去重＋縮寫，前綴對應索引。
// 用法：node tools/build-oui.js <oui-data.json>
'use strict';
const fs = require('fs');
const path = require('path');

const ALIAS = [
  ['Hon Hai Precision', 'Foxconn'], ['Hewlett Packard Enterprise', 'HPE'], ['Hewlett-Packard', 'HP'],
  ['Hewlett Packard', 'HP'], ['International Business Machines', 'IBM'], ['Juniper Networks', 'Juniper'],
  ['Cisco Systems', 'Cisco'], ['Fortinet', 'Fortinet'], ['Dell', 'Dell'], ['VMware', 'VMware'],
  ['Super Micro', 'Supermicro'], ['Huawei', 'Huawei'], ['Arista', 'Arista'], ['Intel Corporat', 'Intel'],
  ['Microsoft', 'Microsoft'], ['Apple, Inc', 'Apple'], ['Lenovo', 'Lenovo'], ['ASUSTek', 'ASUS'],
];
const SUFFIX = /[,\s]+(Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|Limited|LLC|L\.L\.C\.|GmbH|AG|S\.A\.|B\.V\.|Co\.?|Company|Technologies|Technology|Systems|Networks?|International|Group|Electronics)\.?$/i;

function shorten(full) {
  let name = String(full).split(/[\r\n]/)[0].trim().replace(/\(.*?\)/g, '').trim();
  for (const [k, v] of ALIAS) if (name.toUpperCase().includes(k.toUpperCase())) return v;
  for (let i = 0; i < 4; i++) name = name.replace(SUFFIX, '').trim();
  return name.replace(/[,.]+$/, '').trim() || 'Unknown';
}

const src = process.argv[2];
if (!src) { console.error('usage: node tools/build-oui.js <oui-data.json>'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const vendors = []; const vIdx = new Map(); const pairs = [];
for (const [prefix, full] of Object.entries(raw)) {
  if (!/^[0-9A-F]{6}$/i.test(prefix)) continue;
  const v = shorten(full);
  if (!vIdx.has(v)) { vIdx.set(v, vendors.length); vendors.push(v); }
  pairs.push(prefix.toUpperCase() + vIdx.get(v).toString(36));
}
pairs.sort();
const out = `// 由 tools/build-oui.js 產生，請勿手動修改。來源筆數：${pairs.length}\n` +
  `(function (S) { S.data = S.data || {}; S.data.ouiPacked = {\n` +
  `  vendors: ${JSON.stringify(vendors.join('|'))},\n` +
  `  entries: ${JSON.stringify(pairs.join(','))}\n}; })(globalThis.SSOT = globalThis.SSOT || {});\n`;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'data', 'oui-data.js'), out);
console.log(`OUI: ${pairs.length} 筆前綴，${vendors.length} 個廠商，${(out.length / 1024 / 1024).toFixed(2)} MB`);
