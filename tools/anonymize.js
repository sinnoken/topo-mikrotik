// 收集檔去識別化：把真實 RouterOS 輸出改成可以放進 repo 當測試資料的版本。
// 用法：node tools/anonymize.js <收集檔> -o <輸出檔> [--keep-names]
//
// 處理方式（同一個原始值一定換成同一個代號，所以鄰居配對、網段、路由等關係不變）：
//   MAC      保留前 3 個位元組（OUI，廠商判斷不受影響），後 3 個位元組依出現順序重新編號
//   IPv4     前兩段換成 10.101 起的 10.N（依出現順序），後兩段保留：/16 以上的網段關係不變；
//            遮罩、0.0.0.0、127/8、169.254/16、多播與保留位址不換
//   設備名   設備標頭、identity、/system identity、鄰居的 identity 換成 DEV-001…（--keep-names 時保留）
//   其他識別 SSID、DHCP 主機名、radio-name、註解、LLDP 系統描述換成代號
//   機密     eap-identity、eap-username、密碼、金鑰、序號一律換成 REDACTED
// 對照表寫到 <輸出檔>.map.json，只供自己查對，不要提交。
'use strict';
const fs = require('fs');

const MASK_OCTET = new Set([0, 128, 192, 224, 240, 248, 252, 254, 255]);
const SECRET_KEYS = /^(eap-identity|eap-username|password|passphrase|secret|.*-secret|.*-key|.*-passphrase|authentication-key|wpa2?-pre-shared-key|serial|serial-number|software-id)$/i;

function anonymize(text, opt) {
  const o = opt || {};
  const maps = { dev: new Map(), net: new Map(), mac: new Map(), ssid: new Map(), host: new Map(), comment: new Map(), radio: new Map() };
  const code = (kind, prefix, value, width) => {
    const m = maps[kind]; const k = String(value);
    if (!m.has(k)) m.set(k, `${prefix}${String(m.size + 1).padStart(width ?? 3, '0')}`);
    return m.get(k);
  };
  const dev = (name) => (o.keepNames ? name : code('dev', 'DEV-', String(name).toUpperCase()));
  const keepIp = (a) => a[0] === 0 || a[0] === 127 || a[0] >= 224 || (a[0] === 169 && a[1] === 254) || a.every((x) => MASK_OCTET.has(x));
  const ip = (s) => {
    const a = s.split('.').map(Number);
    if (a.some((x) => x > 255) || keepIp(a)) return s;
    const n = 100 + +code('net', '', a[0] + '.' + a[1], 0); // 從 10.101 起編，避免與常見內網位址重疊而看似未處理
    if (n > 255) throw new Error('超過 155 個不同的 /16 網段，無法對應到 10.N.x.x');
    return `10.${n}.${a[2]}.${a[3]}`;
  };
  const mac = (s) => {
    const sep = s[2]; const parts = s.split(sep);
    const tail = code('mac', '', parts.slice(3).join('').toUpperCase(), 6);
    const hex = (+tail).toString(16).padStart(6, '0');
    const out = parts.slice(0, 3).concat([hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)]).join(sep);
    return s === s.toLowerCase() ? out.toLowerCase() : out.toUpperCase();
  };
  const quote = (orig, value) => (orig.startsWith('"') || /\s/.test(value) ? `"${value}"` : value);

  // 1. 先收集設備名：設備標頭、identity=、/system identity；之後在全文以完整詞替換
  const names = new Set();
  text.replace(/^(\S+) \((\d{1,3}(?:\.\d{1,3}){3})\):\s*$/gm, (_, n) => names.add(n));
  text.replace(/(?:^|\s)identity=("(?:[^"\\]|\\.)*"|\S+)/g, (_, v) => names.add(v.replace(/^"|"$/g, '')));
  text.replace(/\/system identity set name=("(?:[^"\\]|\\.)*"|\S+)/g, (_, v) => names.add(v.replace(/^"|"$/g, '')));
  text.replace(/^\s*name:\s*(\S+)\s*$/gm, (_, v) => names.add(v)); // /system identity print

  let out = text;
  // 2. key=value 中的識別與機密欄位
  out = out.replace(/(^|\s)([\w-]+)=("(?:[^"\\]|\\.)*"|\S*)/gm, (all, pre, key, raw) => {
    const v = raw.replace(/^"|"$/g, '');
    if (!v) return all;
    if (SECRET_KEYS.test(key)) return `${pre}${key}=${quote(raw, 'REDACTED')}`;
    if (key === 'ssid') return `${pre}${key}=${quote(raw, code('ssid', 'SSID-', v))}`;
    if (key === 'dhcp-hostname' || key === 'host-name') return `${pre}${key}=${quote(raw, code('host', 'HOST-', v))}`;
    if (key === 'radio-name') return `${pre}${key}=${quote(raw, code('radio', 'RADIO-', v))}`;
    if (key === 'comment' || key === 'system-description') return `${pre}${key}=${quote(raw, code('comment', 'comment-', v))}`;
    return all;
  });
  out = out.replace(/;;;\s*(.+)$/gm, (_, c) => `;;; ${code('comment', 'comment-', c.trim())}`);
  out = out.replace(/^#\s*(serial number|software id)\s*=.*$/gim, (_, k) => `# ${k} = REDACTED`);
  // 3. 設備名（長的先換，避免短名稱是長名稱的一部分）
  Array.from(names).sort((a, b) => b.length - a.length).forEach((n) => {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\w.-])${esc}(?![\\w-])`, 'g'), dev(n));
  });
  // 4. MAC 與 IPv4
  out = out.replace(/\b[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}\b/g, mac);
  out = out.replace(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g, ip);

  const table = Object.fromEntries(Object.entries(maps).map(([k, m]) => [k, Object.fromEntries(m)]));
  if (o.keepNames) delete table.dev;
  return { text: out, map: table };
}

module.exports = { anonymize };

if (require.main === module) {
  const args = process.argv.slice(2);
  const src = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-o');
  const dst = args[args.indexOf('-o') + 1];
  if (!src || args.indexOf('-o') < 0 || !dst) { console.error('用法：node tools/anonymize.js <收集檔> -o <輸出檔> [--keep-names]'); process.exit(2); }
  const r = anonymize(fs.readFileSync(src, 'utf8'), { keepNames: args.includes('--keep-names') });
  fs.writeFileSync(dst, r.text);
  fs.writeFileSync(dst + '.map.json', JSON.stringify(r.map, null, 1) + '\n');
  const count = (k) => Object.keys(r.map[k] || {}).length;
  console.log(`已輸出 ${dst}：設備名 ${count('dev')}、/16 網段 ${count('net')}、MAC ${count('mac')}、SSID ${count('ssid')}、主機名 ${count('host')}、註解 ${count('comment')}`);
  console.log(`對照表：${dst}.map.json（只供自己查對，請勿提交）`);
}
