// 收集檔去識別化：把真實 RouterOS 輸出改成可以放進 repo 當測試資料的版本。
// 用法：node tools/anonymize.js <收集檔> -o <輸出檔> [--keep-names]
//
// 處理方式（同一個原始值一定換成同一個代號，所以鄰居配對、網段、路由等關係不變）：
//   MAC      保留前 3 個位元組（OUI，廠商判斷不受影響），後 3 個位元組依出現順序重新編號
//   IPv4     依位址分類（核心的 S.ip.classify）分成下列幾類，各自換到同類的範圍內，WAN 推論與暴露分析才不受影響：
//              10/8           → 10.101.0.0–10.255.255.255（從 10.101 起，避免與常見內網位址重疊而看似未處理）
//              172.16/12      → 172.16/12 內
//              192.168/16     → 192.168/16 內（只有一個 /16，固定以 /24 為單位，第三段重新編號）
//              CGNAT 100.64/10 → 100.64/10 內（一定放得下）
//              公網           → 11.0.0.0/8；任何公網輸入都會換掉，所以輸出中 11/8 以外的公網位址就是遺漏，提交前可以據此檢查
//            每一類依出現順序以 /16 為單位編號、後兩段保留，/16 以上的網段關係不變；不同的 /16 放不下時改以 /24 為單位
//            （只保留最後一段，/24 以上的網段關係不變）；/24 也放不下就失敗。
//            整類本身的網段（10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、100.64.0.0/10，常見於 address-list）不換，包含關係不變。
//            其他比保留單位短的網段（例如 address-list 的 /22）與跨越單位的位址範圍，對應後的範圍和原本不同、包含關係不保留，
//            會列在警告裡（含輸出的行號）。只要一小段當 fixture 時，先切出片段再去識別化：網段少，比較能保留到 /16。
//            遮罩、0.0.0.0/8、loopback、link-local、多播、文件用與保留位址不換（不會識別出使用者）
//   設備名   設備標頭、identity、/system identity、鄰居的 identity 換成 DEV-001…（--keep-names 時保留）
//   其他識別 SSID、DHCP 主機名、radio-name、註解、LLDP 系統描述換成代號
//   機密     eap-identity、eap-username、密碼（password、*-password）、金鑰（key、*-key、static-key-N）、
//            secret／*-secret／secrets、passphrase、SNMP community（/snmp community 的 name、trap-community）、
//            序號（serial-number）、授權識別碼（software-id、system-id）一律換成 REDACTED；
//            RouterOS 7 的點號欄位（security.passphrase、configuration.ssid）依最後一段判斷；
//            print 的「key: value」（/system routerboard print 的 serial-number:、/system license print 的 software-id: 等）與
//            export 抬頭的「# serial number =」同樣遮蔽，鍵名的大小寫、空格或連字號與冒號前後的空白不影響
// 對照表寫到 <輸出檔>.map.json，只供自己查對，不要提交。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 位址分類用核心的 S.ip（唯一來源）；只載入 ip.js 到獨立的 context，不動呼叫端的 globalThis.SSOT
const IP = (() => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'ip.js'), 'utf8'), ctx, { filename: 'src/core/ip.js' });
  return ctx.SSOT.ip;
})();
// 要換成代號的位址類別（規則見檔頭）。cidr：整類本身的網段（不換）；first：代號範圍的第一段 << 8 | 第二段的基數；
// first16：以 /16 為單位時第二段從幾號起；cap16、cap24：以 /16、/24 為單位時最多幾個（0 表示不用這個單位）
const BUCKETS = {
  p10: { label: '私有位址 10/8', range: '10.101.0.0–10.255.255.255', cidr: '10.0.0.0/8', first: 10 << 8, first16: 101, cap16: 155, cap24: 155 * 256 },
  p172: { label: '私有位址 172.16/12', range: '172.16.0.0/12', cidr: '172.16.0.0/12', first: 172 << 8, first16: 16, cap16: 16, cap24: 16 * 256 },
  p192: { label: '私有位址 192.168/16', range: '192.168.0.0/16', cidr: '192.168.0.0/16', first: (192 << 8) | 168, first16: 0, cap16: 0, cap24: 256 },
  cgnat: { label: 'CGNAT 位址 100.64/10', range: '100.64.0.0/10', cidr: '100.64.0.0/10', first: 100 << 8, first16: 64, cap16: 64, cap24: 0 },
  public: { label: '公網位址', range: '11.0.0.0/8', cidr: null, first: 11 << 8, first16: 0, cap16: 256, cap24: 65536 },
};
const PRIVATE_BY_OCTET = { 10: 'p10', 172: 'p172', 192: 'p192' };
/** 類別 b 的第 i 個單位（以 level 為單位）換成的代號；a 是原位址的四段，保留單位以下的段。 */
function codeOf(b, level, i, a) {
  const B = BUCKETS[b];
  if (level === 16) return `${B.first >> 8}.${B.first16 + i}.${a[2]}.${a[3]}`;
  const j = (B.first16 << 8) + i; // /24 單位接在 /16 起點之後編號：第三段＋第二段的進位
  return `${B.first >> 8}.${(B.first & 255) + (j >> 8)}.${j & 255}.${a[3]}`;
}
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;

/** 連續的子網路遮罩（255.255.240.0 這種）；192.192.128.0 每段都像遮罩但不連續，是一般位址 */
const isNetmask = (a) => { const inv = ~((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0; return ((inv + 1) & inv) === 0; };
// 依 RouterOS export 會出現的欄位：/snmp community 的 authentication-password／encryption-password、/ppp secret 與各 VPN client 的 password、
// /interface wireless security-profiles 的 wpa(2)-pre-shared-key／static-key-0..3、/interface wifi security 的 passphrase、/ip ipsec identity 與 /radius 的 secret、
// /interface wireguard 的 private-key／preshared-key、OSPF／BGP 的 auth-key／tcp-md5-key、/system ntp key 的 key、/tool romon 的 secrets、/snmp 的 trap-community
const SECRET_KEYS = /^(eap-identity|eap-username|password|.*-password|passphrase|.*-passphrase|secret|secrets|.*-secret|key|.*-key|static-key-\d+|trap-community|serial|serial-number|software-id|system-id)$/i;
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
  const maps = { dev: new Map(), mac: new Map(), ssid: new Map(), host: new Map(), comment: new Map(), radio: new Map() };
  const code = (kind, prefix, value, width) => {
    const m = maps[kind]; const k = String(value);
    if (!m.has(k)) m.set(k, `${prefix}${String(m.size + 1).padStart(width ?? 3, '0')}`);
    return m.get(k);
  };
  const dev = (name) => (o.keepNames ? name : code('dev', 'DEV-', String(name).toUpperCase()));
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
  // 沒有引號的值不含行尾的 \（compact export 與 script source 的續行符號），否則換掉值時續行會斷掉
  let out = text.replace(/(^|\s)([\w.-]+)=("(?:[^"\\]|\\.)*"|(?:[^\s\\]|\\(?=\S))*)/gm, (all, pre, key, raw, offset) => {
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
  // print 的「key: value」逐行一個欄位（/system routerboard print、/system license print）；鍵可以是「serial number」這種兩個詞，
  // 以連字號正規化後用同一份 SECRET_KEYS 判斷。= 前後有空白的寫法也算（沒有空白的 key=value 已在上面處理）
  out = out.replace(/^([ \t]*)([A-Za-z][\w.-]*(?: [A-Za-z][\w.-]*)?)([ \t]*(?::|=(?=[ \t])|(?<=[ \t])=)[ \t]*)(\S[^\r\n]*?)([ \t]*\r?)$/gm,
    (all, ind, key, sep, v, tail) => (SECRET_KEYS.test(key.replace(/\s+/g, '-').replace(/^.*\./, '')) ? `${ind}${key}${sep}REDACTED${tail}` : all));
  out = out.replace(/^#\s*(serial[ -]number|software[ -]id)\s*=.*?(\r?)$/gim, (_, k, cr) => `# ${k} = REDACTED${cr}`);
  // 3. 設備名（長的先換，避免短名稱是長名稱的一部分）。空的名稱（鄰居的 identity=""）會比對到每個位置，要排除
  Array.from(names).filter((n) => n.trim()).sort((a, b) => b.length - a.length).forEach((n) => {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\w.-])${esc}(?![\\w-])`, 'g'), dev(n));
  });
  // 4. MAC 與 IPv4
  out = out.replace(/\b[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}\b/g, mac);
  const ips = mapIps(out);

  const table = Object.fromEntries(Object.entries(maps).map(([k, m]) => [k, Object.fromEntries(m)]));
  if (o.keepNames) delete table.dev;
  Object.assign(table, ips.map);
  return { text: ips.text, map: table, nets: ips.nets, warnings: ips.warnings };
}

/** 位址所屬的 BUCKETS 類別；不換的位址（遮罩、loopback、多播…）回傳 null。 */
const bucketCache = new Map();
function bucketOf(s) {
  if (bucketCache.has(s)) return bucketCache.get(s);
  const a = s.split('.').map(Number);
  const cls = a.some((x) => x > 255) || isNetmask(a) ? null : IP.classify(s);
  const b = cls === 'private' ? PRIVATE_BY_OCTET[a[0]] : BUCKETS[cls] ? cls : null;
  bucketCache.set(s, b);
  return b;
}

/**
 * IPv4 換成代號（規則見檔頭）。先掃一遍數出每一類有幾個不同的 /16（與 /24），決定保留單位，再依出現順序編號替換。
 * 回傳 { text, map: { net, cgnat, public }（原單位 → 代號單位）, nets: [{ bucket, label, level, count }], warnings: [文字] }。
 */
function mapIps(text) {
  const unit = (s, level) => s.split('.').slice(0, level / 8).join('.');
  const lenAfter = (str, end) => { const m = /^\/(\d{1,2})(?!\d)/.exec(str.slice(end, end + 3)); return m ? +m[1] : null; };
  const whole = (b, s, len) => len !== null && BUCKETS[b].cidr === `${s}/${len}`;
  const seen = {}; Object.keys(BUCKETS).forEach((b) => { seen[b] = { 16: new Set(), 24: new Set() }; });
  for (const m of text.matchAll(IPV4)) {
    const b = bucketOf(m[0]);
    if (b && !whole(b, m[0], lenAfter(text, m.index + m[0].length))) { seen[b][16].add(unit(m[0], 16)); seen[b][24].add(unit(m[0], 24)); }
  }
  const levels = {};
  Object.entries(BUCKETS).forEach(([b, B]) => {
    const n16 = seen[b][16].size; const n24 = seen[b][24].size;
    if (B.cap16 && n16 <= B.cap16) levels[b] = 16;
    else if (n24 <= B.cap24) levels[b] = 24;
    else {
      const caps = [B.cap16 && `${B.cap16} 個 /16`, `${B.cap24} 個 /24`].filter(Boolean).join(' 或 ');
      throw new Error(`${B.label}：有 ${n16} 個不同的 /16、${n24} 個不同的 /24 網段，超過 ${B.range} 可容納的 ${caps}，`
        + '無法維持網段關係；請先切出需要的片段再去識別化');
    }
  });

  const codes = {}; Object.keys(BUCKETS).forEach((b) => { codes[b] = new Map(); });
  const conv = (s, b) => {
    const level = levels[b]; const k = unit(s, level); const m = codes[b];
    if (!m.has(k)) m.set(k, m.size);
    return codeOf(b, level, m.get(k), s.split('.'));
  };
  // 比保留單位短的網段、跨單位的範圍：對應後的範圍和原本不同，記下位置（輸出與這裡的行數相同）後警告
  const issues = [];
  const out = text.replace(IPV4, (s, off, str) => {
    const b = bucketOf(s);
    if (!b) return s;
    const end = off + s.length; const len = lenAfter(str, end);
    if (whole(b, s, len)) return s;
    if (len !== null && len < levels[b]) issues.push({ b, kind: 'short', off, len });
    const to = /^-(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/.exec(str.slice(end, end + 17));
    if (to && (bucketOf(to[1]) !== b || unit(to[1], levels[b]) !== unit(s, levels[b]))) issues.push({ b, kind: 'range', off });
    return conv(s, b);
  });

  const starts = [0];
  if (issues.length) for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineOf = (off) => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
  const SAMPLE = 5;
  const warnings = [];
  Object.entries(BUCKETS).forEach(([b, B]) => ['short', 'range'].forEach((kind) => {
    const xs = issues.filter((x) => x.b === b && x.kind === kind);
    if (!xs.length) return;
    const lines = xs.slice(0, SAMPLE).map((x) => lineOf(x.off)).join('、') + (xs.length > SAMPLE ? '…' : '');
    const lv = levels[b];
    if (kind === 'short') {
      const lens = xs.map((x) => x.len);
      warnings.push(`${B.label}：${xs.length} 處網段短於 /${lv}（/${Math.min(...lens)}–/${Math.max(...lens)}），代號以 /${lv} 為單位編號，`
        + `這些網段在輸出中的範圍和原本不同，與其他位址的包含關係不保留（輸出第 ${lines} 行）`);
    } else {
      warnings.push(`${B.label}：${xs.length} 處位址範圍跨越不同的 /${lv} 網段，輸出的範圍和原本不同（輸出第 ${lines} 行）`);
    }
  }));

  // 對照表：私有的三類合在 net（原單位不會重複），另有 cgnat、public
  const map = { net: {}, cgnat: {}, public: {} };
  const nets = Object.entries(BUCKETS).map(([b, B]) => {
    const lv = levels[b]; const rest = lv === 16 ? '.x.x' : '.x';
    const into = map[b === 'cgnat' || b === 'public' ? b : 'net'];
    codes[b].forEach((i, k) => { into[k + rest] = unit(codeOf(b, lv, i, ['x', 'x', 'x', 'x']), lv) + rest; });
    return { bucket: b, label: B.label, level: lv, count: codes[b].size };
  });
  return { text: out, map, nets, warnings };
}

module.exports = { anonymize };

if (require.main === module) {
  const args = process.argv.slice(2);
  const src = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-o');
  const dst = args[args.indexOf('-o') + 1];
  if (!src || args.indexOf('-o') < 0 || !dst) { console.error('用法：node tools/anonymize.js <收集檔> -o <輸出檔> [--keep-names]'); process.exit(2); }
  let r;
  try { r = anonymize(fs.readFileSync(src, 'utf8'), { keepNames: args.includes('--keep-names') }); } catch (e) { console.error(`錯誤：${e.message}`); process.exit(1); }
  fs.writeFileSync(dst, r.text);
  fs.writeFileSync(dst + '.map.json', JSON.stringify(r.map, null, 1) + '\n');
  const count = (k) => Object.keys(r.map[k] || {}).length;
  const nets = r.nets.filter((n) => n.count).map((n) => `${n.label} ${n.count} 個 /${n.level}`).join('、') || '無';
  console.log(`已輸出 ${dst}：設備名 ${count('dev')}、網段（${nets}）、MAC ${count('mac')}、SSID ${count('ssid')}、主機名 ${count('host')}、註解 ${count('comment')}`);
  r.warnings.forEach((w) => console.error(`警告：${w}`));
  console.log(`對照表：${dst}.map.json（只供自己查對，請勿提交）`);
}
