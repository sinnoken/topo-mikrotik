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
//   IPv6     同樣依 S.ip.classify 分類、換到同類範圍；輸入的任何寫法（::、前導 0、大小寫）都認成同一個值，換過的位址以 RFC 5952 寫出。
//            前 64 位元（網段）：
//              公網 2000::/3  → 3ffe::/16（6bone 的舊測試區塊，已收回、不再分配，classify 仍是 public；2001:db8::/32 是文件用，類別不同不能用）。
//                               不同的 /32 不超過 65535 個時以 /32 為單位（3ffe:1::/32 起），否則以 /48 為單位；單位以下到 /64 保留。
//                               任何公網輸入都會換掉，所以輸出中 3ffe::/16 以外的公網 IPv6（2000::/3 本身除外）就是遺漏
//              ULA fc00::/7   → 第一個位元組（fc／fd）保留，global ID（/48）依序編號；/48 到 /64 保留
//              link-local     → fe80::/64 原樣
//            後 64 位元（介面 ID）：前 48 位元是 0 的（::1 這類手動編號）不換；EUI-64（中間是 ff:fe）由換過的 MAC 推出，
//              link-local／SLAAC 位址與 MAC 的對應不變；其他以前 48 位元為鍵依序編號、後 16 位元保留（/112 以上的關係不變）。
//            整類的網段（2000::/3、fc00::/7、fd00::/8、fe80::/10）不換；比單位短的網段、/65–/111 的網段裡換了代號的介面 ID、
//            跨代號的範圍列在警告裡。::、::1、多播、文件用與其他保留位址原樣保留；但 solicited-node 多播（ff02::1:ffXX:XXXX）
//            的後 3 個位元組是已知 MAC 的後 3 個位元組時換成同一個代號，否則等於留下 MAC；
//            內嵌 IPv4 的位址（::ffff:a.b.c.d）屬保留類別，IPv6 本身不換，其中的 IPv4 已依 IPv4 的規則換掉
//   設備名   設備標頭、identity、/system identity、鄰居的 identity 換成 DEV-001…（--keep-names 時保留）
//   其他識別 SSID、DHCP 主機名、radio-name、註解、LLDP 系統描述換成代號
//   機密     eap-identity、eap-username、密碼（password、*-password）、金鑰（key、*-key、static-key-N）、
//            secret／*-secret／secrets、passphrase、SNMP community（/snmp community 的 name、trap-community）、
//            序號（serial-number）、授權識別碼（software-id、system-id）一律換成 REDACTED；
//            RouterOS 7 的點號欄位（security.passphrase、configuration.ssid）依最後一段判斷；
//            print 的「key: value」（/system routerboard print 的 serial-number:、/system license print 的 software-id: 等）與
//            export 抬頭的「# serial number =」同樣遮蔽，鍵名的大小寫、空格或連字號與冒號前後的空白不影響
//   寬度     收集器的「# terminal-width: W」換成一般註解（行數不變）：替換後行長改變，記錄不再成立；
//            輸出沒有寬度記錄，核心只看折行的形狀（推算寬度需要原樣的硬切註解，註解換成代號後也不會推算）
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

  // 0. 收集器的終端寬度記錄：換掉名稱、註解與位址後行長會變，記錄不再成立（核心會依它判斷折行，並把超過寬度的行列為 I01）。
  //    換成一般註解而不是刪掉：行數不變，警告的行號（sampleLines）與輸出檔的行號仍對得上原檔
  text = text.replace(/^[ \t]*#[ \t]*terminal-width:[^\r\n]*/gim, '# 去識別化時移除了終端寬度的記錄（行長已改變）');

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
  // 4. MAC、IPv4、IPv6。MAC 前面不可接英數字或冒號、後面不可接英數字、冒號或連字號，才不會比對到 IPv6 位址裡剛好是兩位數的六組
  //    （2001:db8:aa:bb:cc:dd:ee:ff）。前面可以是點或連字號：bridge ID 寫成「優先權.MAC」（designated-bridge-id: 0xf000.<MAC>、
  //    root-bridge-id: 0.<MAC>），DNS 名稱常寫成 dev-aa-bb-cc-dd-ee-ff
  out = out.replace(/(?<![\w:])[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}(?![\w:-])/g, mac);
  // IPv4 先換：內嵌 IPv4 的 IPv6（::ffff:a.b.c.d）裡的 IPv4 依 IPv4 的規則換
  const ips = mapIps(out);
  // EUI-64 介面 ID 內含 MAC：後 3 個位元組用和 MAC 相同的代號（OUI 保留），link-local 與 MAC 的對應才不變
  const macTail = (hex6) => (+code('mac', '', hex6.toUpperCase(), 6)).toString(16).padStart(6, '0');
  const ip6 = mapIp6(ips.text, macTail, (hex6) => maps.mac.has(hex6.toUpperCase()));

  const table = Object.fromEntries(Object.entries(maps).map(([k, m]) => [k, Object.fromEntries(m)]));
  if (o.keepNames) delete table.dev;
  Object.assign(table, ips.map, { ipv6: ip6.map });
  return { text: ip6.text, map: table, nets: ips.nets.concat(ip6.nets), warnings: ips.warnings.concat(ip6.warnings) };
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

  const lines = sampleLines(text);
  const warnings = [];
  Object.entries(BUCKETS).forEach(([b, B]) => ['short', 'range'].forEach((kind) => {
    const xs = issues.filter((x) => x.b === b && x.kind === kind);
    if (!xs.length) return;
    const lv = levels[b];
    if (kind === 'short') {
      const lens = xs.map((x) => x.len);
      warnings.push(`${B.label}：${xs.length} 處網段短於 /${lv}（/${Math.min(...lens)}–/${Math.max(...lens)}），代號以 /${lv} 為單位編號，`
        + `這些網段在輸出中的範圍和原本不同，與其他位址的包含關係不保留（輸出第 ${lines(xs)} 行）`);
    } else {
      warnings.push(`${B.label}：${xs.length} 處位址範圍跨越不同的 /${lv} 網段，輸出的範圍和原本不同（輸出第 ${lines(xs)} 行）`);
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

/** 警告用：位置（offset）→ 前 5 個行號的文字；輸出與輸入的行數相同（位址替換不增減換行）。 */
function sampleLines(text) {
  let starts = null;
  const lineOf = (off) => {
    if (!starts) { starts = [0]; for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1); }
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const SAMPLE = 5;
  return (xs) => xs.slice(0, SAMPLE).map((x) => lineOf(x.off)).join('、') + (xs.length > SAMPLE ? '…' : '');
}

// IPv6：冒號分隔的 3–8 組（可含 :: 與結尾的點分 IPv4），前後不接英數字或冒號；再由 S.ip.v6ToBig 確認合法，
// 所以 MAC（6 組）、時間（08:00:00）、uptime（1d02:03:04）都不是位址。8 組都是兩位數的寫法（DUID 之類）第一組 < 0x100，分類是保留位址，不換
const IPV6 = /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:[0-9A-Fa-f]{1,4}|\d{1,3}(?:\.\d{1,3}){3})?(?![\w:])/g;
const M16 = 0xffffn; const M64 = (1n << 64n) - 1n;
/** 介面 ID（64 位元）的第 k 個位元組；EUI-64 是 MAC 前 3 個位元組（第一個翻轉 U/L 位元）＋ff:fe＋MAC 後 3 個位元組 */
const byteOf = (x, k) => Number((x >> BigInt(56 - 8 * k)) & 0xffn);
const isEui = (x) => byteOf(x, 3) === 0xff && byteOf(x, 4) === 0xfe;
const SOLICITED = 0xff0200000000000000000001ffn; // ff02::1:ff00:0/104
// 要換的 IPv6 類別（S.ip.classify）。whole：整類本身的網段，原樣保留；
// 公網換到 3ffe::/16（6bone 的舊測試區塊，2006 年已收回、不再分配；classify 仍是 public，不是文件用的 2001:db8::/32）
const V6_BUCKETS = {
  public6: { cls: 'public', label: '公網 IPv6', range: '3ffe::/16', whole: ['2000::/3'] },
  ula: { cls: 'private', label: 'IPv6 ULA', range: 'fc00::/7', whole: ['fc00::/7', 'fc00::/8', 'fd00::/8'] },
  ll: { cls: 'link-local', label: 'IPv6 link-local', range: 'fe80::/10', whole: ['fe80::/10'] },
};
const V6_BY_CLASS = Object.fromEntries(Object.entries(V6_BUCKETS).map(([b, B]) => [B.cls, b]));

/**
 * IPv6 換成代號（規則見檔頭）：前 64 位元依類別換網段代號，後 64 位元（介面 ID）另外換。
 * macTail(6 位 hex) 回傳 MAC 後 3 個位元組的新值（和 MAC 的代號共用）；macKnown(6 位 hex) 表示這組後 3 個位元組是否已有代號。
 * 回傳 { text, map: { public, ula, iid }, nets: [{ bucket, label, level, count }], warnings }。
 */
function mapIp6(text, macTail, macKnown) {
  const parsed = new Map();
  const parse = (s) => {
    if (!parsed.has(s)) { const n = IP.v6ToBig(s); parsed.set(s, n === null ? null : { n, b: V6_BY_CLASS[IP.classify(s)] || null }); }
    return parsed.get(s);
  };
  const lenAfter = (str, end) => { const m = /^\/(\d{1,3})(?!\d)/.exec(str.slice(end, end + 4)); return m && +m[1] <= 128 ? +m[1] : null; };
  const whole = (b, n, len) => len !== null && V6_BUCKETS[b].whole.includes(`${IP.v6FromBig(n)}/${len}`);

  // 公網：不同的 /32 不超過 65535 個就以 /32 為單位（3ffe:1::/32 起），否則以 /48 為單位；ULA 固定以 /48（global ID）為單位
  // 同一遍先登記 EUI-64 裡的 MAC，solicited-node 多播（ff02::1:ffXX:XXXX，後 3 個位元組就是 MAC 的後 3 個位元組）不論出現在前或後都換得一致
  const seen32 = new Set(); const seen48 = new Set();
  const tailHex = (n) => (n & 0xffffffn).toString(16).padStart(6, '0');
  for (const m of text.matchAll(IPV6)) {
    const p = parse(m[0]);
    if (p && p.b && isEui(p.n & M64)) macTail(tailHex(p.n));
    if (p && p.b === 'public6' && !whole(p.b, p.n, lenAfter(text, m.index + m[0].length))) { seen32.add(p.n >> 96n); seen48.add(p.n >> 80n); }
  }
  // 代號從 3ffe:1 起：不產生 3ffe::，bogon 清單常見的 3ffe::/16 原值才不會剛好出現在輸出
  const CAP32 = 65535; const CAP48 = 2 ** 32 - 1;
  const pubCode = (i, shift) => (0x3ffen << 112n) | (BigInt(i + 1) << shift);
  if (seen32.size > CAP32 && seen48.size > CAP48) {
    throw new Error(`公網 IPv6：有 ${seen32.size} 個不同的 /32、${seen48.size} 個不同的 /48 網段，超過 3ffe::/16 可容納的 ${CAP32} 個 /32 或 ${CAP48} 個 /48，`
      + '無法維持網段關係；請先切出需要的片段再去識別化');
  }
  const unitLen = { public6: seen32.size <= CAP32 ? 32 : 48, ula: 48, ll: 0 };

  const units = { public6: new Map(), ula: new Map() };
  const unitIndex = (b, u) => { const m = units[b]; if (!m.has(u)) m.set(u, m.size); return m.get(u); };
  const ULA_CAP = 2 ** 40 - 1;
  /** 前 64 位元：公網、ULA 換掉保留單位以上的位元，單位以下（子網路編號）保留；link-local 原樣 */
  const high = (b, n) => {
    const L = unitLen[b]; const hi = n & ~M64;
    if (b === 'll') return hi;
    const shift = BigInt(128 - L); const keep = hi & ((1n << shift) - 1n); const i = unitIndex(b, n >> shift);
    if (b === 'public6') return pubCode(i, shift) | keep;
    if (i >= ULA_CAP) throw new Error(`IPv6 ULA：不同的 /48 超過 ${ULA_CAP} 個，無法維持網段關係；請先切出需要的片段再去識別化`);
    return ((n >> 120n) << 120n) | (BigInt(i + 1) << shift) | keep; // fc／fd 保留，global ID 從 1 起編
  };
  // 介面 ID：前 48 位元是 0（::1、::fe 這類手動編號）不換；EUI-64 由換過的 MAC 推出；其他以前 48 位元為鍵依序編號成 0:1:N:N:xxxx，
  // 後 16 位元保留（/112 以上的關係不變）。三種輸出的形狀互不重疊，代號才不會重複：編號跳過剛好像 EUI-64（第 4、5 位元組是 ff、fe）的值
  const iidCodes = new Map(); let iidNext = 0;
  const iid = (x) => {
    if (x >> 16n === 0n) return { x, kind: 'small' };
    if (isEui(x)) return { x: ((x >> 24n) << 24n) | BigInt(parseInt(macTail([5, 6, 7].map((k) => byteOf(x, k).toString(16).padStart(2, '0')).join('')), 16)), kind: 'eui' };
    const k = x >> 16n;
    if (!iidCodes.has(k)) { let c; do { c = ++iidNext; } while (((c >> 16) & 0xff) === 0xff && ((c >> 8) & 0xff) === 0xfe); iidCodes.set(k, c); }
    return { x: (1n << 48n) | (BigInt(iidCodes.get(k)) << 16n) | (x & M16), kind: 'code' };
  };
  const conv = (p) => { const r = iid(p.n & M64); return { text: IP.v6FromBig(high(p.b, p.n) | r.x), kind: r.kind }; };

  const issues = [];
  const out = text.replace(IPV6, (s, off, str) => {
    const p = parse(s);
    if (!p) return s;
    const end = off + s.length; const len = lenAfter(str, end);
    if (!p.b && len === null && p.n >> 24n === SOLICITED && macKnown(tailHex(p.n))) return IP.v6FromBig(((p.n >> 24n) << 24n) | BigInt(parseInt(macTail(tailHex(p.n)), 16)));
    if (!p.b) return s;
    if (whole(p.b, p.n, len)) return s;
    const r = conv(p);
    if (len !== null && len < unitLen[p.b]) issues.push({ b: p.b, kind: 'short', off, len });
    if (len !== null && ((r.kind === 'code' && len > 64 && len < 112) || (r.kind === 'eui' && len > 104 && len < 128))) issues.push({ b: p.b, kind: 'iid', off, len });
    const to = /^-([0-9A-Fa-f:.]+)/.exec(str.slice(end, end + 47)); const q = to && parse(to[1]);
    const unitOf = (n) => (p.b === 'll' ? 0n : n >> BigInt(128 - unitLen[p.b])); const iidHi = (n) => (n & M64) >> 16n;
    if (q && (q.b !== p.b || unitOf(q.n) !== unitOf(p.n) || iidHi(q.n) !== iidHi(p.n))) issues.push({ b: p.b, kind: 'range', off });
    return r.text;
  });

  const lines = sampleLines(text);
  const warnings = [];
  Object.entries(V6_BUCKETS).forEach(([b, B]) => ['short', 'iid', 'range'].forEach((kind) => {
    const xs = issues.filter((x) => x.b === b && x.kind === kind);
    if (!xs.length) return;
    const lens = xs.map((x) => x.len); const span = `/${Math.min(...lens)}–/${Math.max(...lens)}`;
    if (kind === 'short') {
      warnings.push(`${B.label}：${xs.length} 處網段短於 /${unitLen[b]}（${span}），代號以 /${unitLen[b]} 為單位編號，`
        + `這些網段在輸出中的範圍和原本不同，與其他位址的包含關係不保留（輸出第 ${lines(xs)} 行）`);
    } else if (kind === 'iid') {
      warnings.push(`${B.label}：${xs.length} 處網段長於 /64（${span}），網段內的介面 ID 換成代號，與其他位址的包含關係不保留（輸出第 ${lines(xs)} 行）`);
    } else {
      warnings.push(`${B.label}：${xs.length} 處位址範圍跨越不同的網段代號或介面 ID 代號，輸出的範圍和原本不同（輸出第 ${lines(xs)} 行）`);
    }
  }));

  const prefixText = (b, u) => { const L = unitLen[b]; const sh = BigInt(128 - L); return `${IP.v6FromBig(u << sh)}/${L}`; };
  const map = { public: {}, ula: {}, iid: {} };
  ['public6', 'ula'].forEach((b) => units[b].forEach((i, u) => {
    const L = unitLen[b]; const sh = BigInt(128 - L);
    map[b === 'ula' ? 'ula' : 'public'][prefixText(b, u)] = `${IP.v6FromBig(b === 'public6' ? pubCode(i, sh) :((u >> BigInt(L - 8)) << 120n) | (BigInt(i + 1) << sh))}/${L}`;
  }));
  const hex48 = (k) => [32n, 16n, 0n].map((s) => ((k >> s) & M16).toString(16)).join(':');
  iidCodes.forEach((c, k) => { map.iid[`${hex48(k)}:x`] = `${hex48((1n << 32n) | BigInt(c))}:x`; });
  const nets = [{ bucket: 'public6', label: V6_BUCKETS.public6.label, level: unitLen.public6, count: units.public6.size },
    { bucket: 'ula', label: V6_BUCKETS.ula.label, level: 48, count: units.ula.size }];
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
  console.log(`已輸出 ${dst}：設備名 ${count('dev')}、網段（${nets}）、IPv6 介面 ID 代號 ${Object.keys(r.map.ipv6.iid).length}、MAC ${count('mac')}、SSID ${count('ssid')}、主機名 ${count('host')}、註解 ${count('comment')}`);
  r.warnings.forEach((w) => console.error(`警告：${w}`));
  console.log(`對照表：${dst}.map.json（只供自己查對，請勿提交）`);
}
