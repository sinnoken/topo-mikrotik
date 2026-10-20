// 將 IEEE OUI 原始資料（npm 套件 oui-data 的 index.json：{"001122": "Vendor\n地址…"}）
// 轉成精簡的 src/data/oui-data.js：廠商名稱去重＋縮寫，前綴對應索引。
// 收錄 MA-L（6 碼）、MA-M（7 碼）、MA-S（9 碼）三種前綴；查詢時取最長符合者（src/data/oui.js）。
// 用法：node tools/build-oui.js <oui-data 套件的 index.json> [--source 名稱@版本]
//   取得來源：npm pack oui-data@<版本>，解開後取 package/index.json；同目錄的 package.json 會自動讀出名稱與版本
// 產物只記錄來源版本，不記錄產生時間，同一份來源一定得到同一個檔案。
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
const SUFFIX = /[,\s]+(Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|Limited|LLC|L\.L\.C\.|GmbH|AG|S\.A\.|B\.V\.|Co\.?|Company|Technologies|Technology|Systems|Networks?|International|Group|Electronics|Pty|Pte|Sdn\.?\s*Bhd\.?)\.?$/i;

function shorten(full) {
  let name = String(full).split(/[\r\n]/)[0].replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
  for (const [k, v] of ALIAS) if (name.toUpperCase().includes(k.toUpperCase())) return v;
  for (let i = 0; i < 4; i++) name = name.replace(SUFFIX, '').trim();
  return name.replace(/[,.]+$/, '').trim() || 'Unknown';
}

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const srcFlag = args.indexOf('--source');
if (!src) { console.error('usage: node tools/build-oui.js <oui-data 套件的 index.json> [--source 名稱@版本]'); process.exit(1); }
let source = srcFlag >= 0 ? args[srcFlag + 1] : null;
if (!source) {
  const pkg = path.join(path.dirname(src), 'package.json');
  if (fs.existsSync(pkg)) { const j = JSON.parse(fs.readFileSync(pkg, 'utf8')); source = `${j.name}@${j.version}（${j.license || '授權未標示'}）`; }
}
if (!source) { console.error('找不到來源版本：請把 index.json 放在原套件目錄，或用 --source 名稱@版本 指定'); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const LENGTHS = [6, 7, 9]; // MA-L、MA-M、MA-S
const vendors = []; const vIdx = new Map(); const byLen = new Map(LENGTHS.map((n) => [n, []]));
const skipped = [];
for (const [prefix, full] of Object.entries(raw)) {
  if (!/^[0-9A-F]+$/i.test(prefix) || !byLen.has(prefix.length)) { skipped.push(prefix); continue; }
  const v = shorten(full);
  if (!vIdx.has(v)) { vIdx.set(v, vendors.length); vendors.push(v); }
  byLen.get(prefix.length).push(prefix.toUpperCase() + vIdx.get(v).toString(36));
}
if (skipped.length) { console.error(`無法辨識的前綴 ${skipped.length} 筆（例：${skipped.slice(0, 5).join(', ')}）`); process.exit(1); }
byLen.forEach((list) => list.sort());
const total = LENGTHS.reduce((n, len) => n + byLen.get(len).length, 0);
const out = `// 由 tools/build-oui.js 產生，請勿手動修改。來源：${source}；前綴 ${total} 筆（MA-L ${byLen.get(6).length}、MA-M ${byLen.get(7).length}、MA-S ${byLen.get(9).length}）\n` +
  `(function (S) { S.data = S.data || {}; S.data.ouiPacked = {\n` +
  `  source: ${JSON.stringify(source)},\n` +
  `  vendors: ${JSON.stringify(vendors.join('|'))},\n` +
  LENGTHS.map((len) => `  entries${len === 6 ? '' : len}: ${JSON.stringify(byLen.get(len).join(','))},\n`).join('') +
  `}; })(globalThis.SSOT = globalThis.SSOT || {});\n`;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'data', 'oui-data.js'), out);
console.log(`OUI：${source}；前綴 ${total} 筆，${vendors.length} 個廠商，${(out.length / 1024 / 1024).toFixed(2)} MB`);
