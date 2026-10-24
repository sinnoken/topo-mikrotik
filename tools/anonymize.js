// 收集檔去識別化：把真實 RouterOS 輸出改成可以放進 repo 當測試資料的版本。
// 用法：node tools/anonymize.js <收集檔> -o <輸出檔> [--keep-names]
//
// 處理方式（同一個原始值一定換成同一個代號，所以鄰居配對、網段、路由等關係不變）：
//   MAC      保留前 3 個位元組（OUI，廠商判斷不受影響），後 3 個位元組依出現順序重新編號
//   IPv4     前兩段換成 10.101 起的 10.N（依出現順序），後兩段保留：/16 以上的網段關係不變；
//            遮罩、0.0.0.0、127/8、169.254/16、多播與保留位址不換
//   設備名   設備標頭、identity、/system identity、鄰居的 identity 換成 DEV-001…（--keep-names 時保留）
//   其他識別 SSID、DHCP 主機名、radio-name、註解、LLDP 系統描述換成代號
//   機密     eap-identity、eap-username、密碼（password、*-password）、金鑰（key、*-key、static-key-N）、
//            secret／*-secret／secrets、passphrase、SNMP community（/snmp community 的 name、trap-community）、序號一律換成 REDACTED；
//            RouterOS 7 的點號欄位（security.passphrase、configuration.ssid）依最後一段判斷
// 對照表寫到 <輸出檔>.map.json，只供自己查對，不要提交。
'use strict';
const fs = require('fs');

const MASK_OCTET = new Set([0, 128, 192, 224, 240, 248, 252, 254, 255]);
// 依 RouterOS export 會出現的欄位：/snmp community 的 authentication-password／encryption-password、/ppp secret 與各 VPN client 的 password、
// /interface wireless security-profiles 的 wpa(2)-pre-shared-key／static-key-0..3、/interface wifi security 的 passphrase、/ip ipsec identity 與 /radius 的 secret、
// /interface wireguard 的 private-key／preshared-key、OSPF／BGP 的 auth-key／tcp-md5-key、/system ntp key 的 key、/tool romon 的 secrets、/snmp 的 trap-community
const SECRET_KEYS = /^(eap-identity|eap-username|password|.*-password|passphrase|.*-passphrase|secret|secrets|.*-secret|key|.*-key|static-key-\d+|trap-community|serial|serial-number|software-id)$/i;
// SNMP v1/v2c 的 community 名稱本身就是密碼：/snmp community 底下的 name 也要遮蔽
const SNMP_COMMUNITY = /^\/\s*snmp[\s/]+community\b/i;
const MENU_MARKER = /^\s*(?:###\s*|\[[^\]]*\]\s*>?\s*)(\/\S.*)$/;

/** RouterOS export 字串值的跳脫（\XX 位元組依 UTF-8、\" \\ 等單字元）→ 文字；解不出 UTF-8 時原樣回傳。 */
function rosDecode(v) {
  if (!v.includes('\\')) return v;
  const bytes = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && i + 1 < v.length) {
      const h = v.slice(i + 1, i + 3);
      if (/^[0-9A-F]{2}$/i.test(h)) { bytes.push(parseInt(h, 16)); i += 2; } else bytes.push(...Buffer.from(v[++i], 'utf8'));
      continue;
    }
    bytes.push(...Buffer.from(v[i], 'utf8'));
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch (e) { return v; }
}

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
  // /system identity print 的「name: X」才是設備名；其他 monitor 輸出（例如 bridge 的 name: bridge1）不是
  let inIdentity = false;
  text.split('\n').forEach((line) => {
    if (/^\s*(###|\[[^\]]*\]\s*>)/.test(line) || /^\S+ \(\d{1,3}(?:\.\d{1,3}){3}\):\s*$/.test(line)) inIdentity = /system\s+identity\s+print/i.test(line);
    const m = inIdentity && line.match(/^\s*name:\s*(\S+)\s*$/);
    if (m) names.add(m[1]);
  });

  // 2. key=value 中的識別與機密欄位。逐行追蹤目前的選單（指令標記或 export 的 /路徑；compact export 的續行沿用上一個路徑），
  //    在 /snmp community 底下時 name 也是機密
  //    引號內的值可以跨行（compact export 在引號內以 \ 斷行），所以仍對全文比對，再以位置對回所在行的選單
  const lineStarts = [0]; const community = [];
  let menu = '';
  text.split('\n').forEach((raw) => {
    lineStarts.push(lineStarts[lineStarts.length - 1] + raw.length + 1);
    const line = raw.replace(/\r$/, '');
    const mk = MENU_MARKER.exec(line);
    if (mk) menu = mk[1];
    else if (/^\s*\//.test(line)) menu = line.trim();
    else if (/^\S+ \(\d{1,3}(?:\.\d{1,3}){3}\):\s*$/.test(line)) menu = '';
    community.push(SNMP_COMMUNITY.test(menu));
  });
  const inCommunity = (offset) => {
    let lo = 0; let hi = community.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return community[lo];
  };
  let out = text.replace(/(^|\s)([\w.-]+)=("(?:[^"\\]|\\.)*"|\S*)/gm, (all, pre, key, raw, offset) => {
    const v = raw.replace(/^"|"$/g, '');
    if (!v) return all;
    const k = key.replace(/^.*\./, ''); // RouterOS 7 的點號欄位（security.passphrase、configuration.ssid）依最後一段判斷
    if (SECRET_KEYS.test(k) || (k === 'name' && inCommunity(offset + pre.length))) return `${pre}${key}=${quote(raw, 'REDACTED')}`;
    if (k === 'ssid') return `${pre}${key}=${quote(raw, code('ssid', 'SSID-', v))}`;
    if (k === 'dhcp-hostname' || k === 'host-name') return `${pre}${key}=${quote(raw, code('host', 'HOST-', v))}`;
    if (k === 'radio-name') return `${pre}${key}=${quote(raw, code('radio', 'RADIO-', v))}`;
    // export 的註解以 \XX 位元組與 \" 跳脫，print 的 ;;; 是解碼後的文字：解碼後當鍵，兩邊同一個註解換成同一個代號（命中次數靠註解對應規則）
    if (k === 'comment' || k === 'system-description') return `${pre}${key}=${quote(raw, code('comment', 'comment-', k === 'comment' ? rosDecode(v) : v))}`;
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
