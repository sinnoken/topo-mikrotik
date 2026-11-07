/* IP 工具：IPv4 轉換、CIDR 比對、遮罩轉換；IPv4／IPv6 位址分類（S.ip.classify）。 */
(function (S) {
  'use strict';
  const ip = {};
  const RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

  ip.isIp = (s) => {
    const m = RE.exec(String(s || '').trim());
    return !!m && m.slice(1).every((o) => +o <= 255);
  };
  ip.toInt = (s) => s.split('.').reduce((acc, o) => ((acc << 8) + (+o)) >>> 0, 0) >>> 0;
  ip.fromInt = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  ip.maskOf = (len) => (len <= 0 ? 0 : (0xffffffff << (32 - len)) >>> 0);
  ip.maskToLen = (mask) => {
    if (/^\d+$/.test(mask)) return +mask;
    let n = ip.toInt(mask), len = 0;
    while (n & 0x80000000) { len++; n = (n << 1) >>> 0; }
    return len;
  };
  /** "10.0.0.1/24" → {ip, len, net}；也接受 "10.0.0.1 255.255.255.0"。 */
  ip.parseCidr = (s) => {
    const m = String(s).trim().match(/^(\d+\.\d+\.\d+\.\d+)\s*(?:\/(\d{1,2})|\s+(\d+\.\d+\.\d+\.\d+))?$/);
    if (!m || !ip.isIp(m[1])) return null;
    const len = m[2] !== undefined ? +m[2] : m[3] ? ip.maskToLen(m[3]) : 32;
    if (len < 0 || len > 32) return null;
    const net = ip.fromInt((ip.toInt(m[1]) & ip.maskOf(len)) >>> 0);
    return { ip: m[1], len, net };
  };
  ip.inNet = (addr, net, len) => ((ip.toInt(addr) & ip.maskOf(len)) >>> 0) === ((ip.toInt(net) & ip.maskOf(len)) >>> 0);

  /**
   * 最長前綴查表的索引（路由表與直連網段共用；model 層的檢查（下一跳解析）與查詢層的路徑追蹤、可達性都經 ip.prefixIndex，不另寫一份）：
   * 依前綴長度分桶，每桶以網路位址（數字）為鍵，查一次最多看 33 個桶，不必掃過整張表。
   * 依（陣列, 欄位）快取：陣列建立索引後不可再改（查詢介面與路由視圖回傳的凍結陣列）。
   */
  const pxMemo = new WeakMap();
  /**
   * ip.prefixIndex(list, field) → { lookup(n, keep?) }（凍結；同一個 list、field 回傳同一份，第一次呼叫時建立）。
   * list：元素有 len 與 field 欄位（網路位址字串），例如路由 { prefix, len }（field 'prefix'）、網段 { net, len }（field 'net'）。
   * lookup(n, keep)：包含 n（ip.toInt 的結果）、前綴最長的元素；同長度多筆全取，順序同 list。keep(e)（選用）為 false 的元素不算
   * （例如只看某個 VRF、跳過已用過的路由）。結果同「list.filter((e) => keep(e) && ip.inNet(位址, e[field], e.len))，再取 len 最大的」；
   * 沒有時為空陣列（每次都是新陣列，呼叫端可修改）。
   */
  ip.prefixIndex = (list, field) => {
    let byField = pxMemo.get(list);
    if (!byField) { byField = new Map(); pxMemo.set(list, byField); }
    let x = byField.get(field);
    if (!x) {
      const buckets = new Map();
      list.forEach((e) => {
        let b = buckets.get(e.len);
        if (!b) { b = { len: e.len, mask: ip.maskOf(e.len), nets: new Map() }; buckets.set(e.len, b); }
        const net = (ip.toInt(e[field]) & b.mask) >>> 0;
        const xs = b.nets.get(net); if (xs) xs.push(e); else b.nets.set(net, [e]);
      });
      // 長度由長到短；不是數字的長度（不會出現）排除，與逐筆比較「len > 目前最長」時永遠不入選相同
      const idx = Array.from(buckets.values()).filter((b) => typeof b.len === 'number' && b.len >= 0).sort((a, b) => b.len - a.len);
      x = Object.freeze({
        lookup(n, keep) {
          for (let i = 0; i < idx.length; i++) {
            const xs = idx[i].nets.get((n & idx[i].mask) >>> 0);
            if (!xs) continue;
            const out = keep ? xs.filter(keep) : xs.slice();
            if (out.length) return out;
          }
          return [];
        },
      });
      byField.set(field, x);
    }
    return x;
  };
  /** ip.prefixIndex(list, field).lookup(n, keep) 的簡寫。 */
  ip.longestPrefix = (list, field, n, keep) => ip.prefixIndex(list, field).lookup(n, keep);

  /** IPv6 位址文字 → BigInt（支援 :: 縮寫與結尾的點分 IPv4，例如 ::ffff:192.0.2.1）；不合法時 null。 */
  ip.v6ToBig = (s) => {
    let t = String(s || '').trim().toLowerCase();
    const v4 = t.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) { if (!ip.isIp(v4[2])) return null; const n = ip.toInt(v4[2]); t = v4[1] + (n >>> 16).toString(16) + ':' + (n & 0xffff).toString(16); }
    const halves = t.split('::'); if (halves.length > 2) return null;
    const h = halves[0] ? halves[0].split(':') : []; const tl = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
    if (tl === null && h.length !== 8) return null;
    if (tl !== null && h.length + tl.length > 7) return null;
    const parts = tl === null ? h : h.concat(Array(8 - h.length - tl.length).fill('0'), tl);
    if (parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
    return parts.reduce((acc, p) => (acc << 16n) + BigInt(parseInt(p, 16)), 0n);
  };

  /*
   * 特殊用途位址表（位址分類的唯一來源）：[網段, 類別, 依據]。依據以 IANA 特殊用途位址登錄（RFC 6890 及其更新）為主：
   * https://www.iana.org/assignments/iana-ipv4-special-registry/ 、https://www.iana.org/assignments/iana-ipv6-special-registry/
   * 不在表內的 IPv4 是 public；IPv6 只有 2000::/3（RFC 4291 的全球單播）是 public，其餘未分配的空間是 reserved。
   * 同一個位址落在多段時取最長的網段（例如 2001:db8::/32 在 2000::/3 內）。
   */
  ip.SPECIAL = Object.freeze([
    ['0.0.0.0/8', 'reserved', 'RFC 791／RFC 6890「this network」'],
    ['10.0.0.0/8', 'private', 'RFC 1918'],
    ['100.64.0.0/10', 'cgnat', 'RFC 6598'],
    ['127.0.0.0/8', 'loopback', 'RFC 1122'],
    ['169.254.0.0/16', 'link-local', 'RFC 3927'],
    ['172.16.0.0/12', 'private', 'RFC 1918'],
    ['192.0.0.0/24', 'reserved', 'RFC 6890 IETF 協定用途'],
    ['192.0.2.0/24', 'documentation', 'RFC 5737 TEST-NET-1'],
    ['192.168.0.0/16', 'private', 'RFC 1918'],
    ['198.18.0.0/15', 'reserved', 'RFC 2544 效能測試'],
    ['198.51.100.0/24', 'documentation', 'RFC 5737 TEST-NET-2'],
    ['203.0.113.0/24', 'documentation', 'RFC 5737 TEST-NET-3'],
    ['224.0.0.0/4', 'multicast', 'RFC 5771'],
    ['240.0.0.0/4', 'reserved', 'RFC 1112（含 255.255.255.255 廣播，RFC 919）'],
    ['::/128', 'reserved', 'RFC 4291 未指定位址'],
    ['::1/128', 'loopback', 'RFC 4291'],
    ['::ffff:0:0/96', 'reserved', 'RFC 4291 IPv4 對應位址'],
    ['100::/64', 'reserved', 'RFC 6666 discard-only'],
    ['2000::/3', 'public', 'RFC 4291 全球單播'],
    ['2001:db8::/32', 'documentation', 'RFC 3849'],
    ['fc00::/7', 'private', 'RFC 4193 ULA（唯一本地位址，視同私有）'],
    ['fe80::/10', 'link-local', 'RFC 4291'],
    ['ff00::/8', 'multicast', 'RFC 4291'],
  ].map((x) => Object.freeze(x)));
  ip.CLASSES = Object.freeze(['private', 'cgnat', 'loopback', 'link-local', 'multicast', 'reserved', 'documentation', 'public']);
  const SPECIAL_RANGES = ip.SPECIAL.map(([cidr, cls]) => {
    const [a, l] = cidr.split('/'); const v4 = ip.isIp(a); const bits = v4 ? 32 : 128; const len = +l;
    const lo = v4 ? BigInt(ip.toInt(a)) : ip.v6ToBig(a); const span = (1n << BigInt(bits - len)) - 1n;
    return { v4, len, lo, hi: lo + span, cls };
  });
  /**
   * 單一位址（不含 /長度）的類別：CLASSES 其中之一；不是合法的 IPv4／IPv6 位址時 null。
   * 例：10.1.1.1 → private、100.64.0.1 → cgnat、198.51.100.7 → documentation、2001:db8::1 → documentation、fd00::1 → private。
   */
  ip.classify = (addr) => {
    const s = String(addr == null ? '' : addr).trim();
    const v4 = ip.isIp(s); const n = v4 ? BigInt(ip.toInt(s)) : ip.v6ToBig(s);
    if (n === null) return null;
    let best = null;
    SPECIAL_RANGES.forEach((r) => { if (r.v4 === v4 && n >= r.lo && n <= r.hi && (!best || r.len > best.len)) best = r; });
    return best ? best.cls : v4 ? 'public' : 'reserved';
  };
  /** 屬於指定類別的特殊用途網段（CIDR 文字，依 SPECIAL 的順序）；例如 rangesOf(['private', 'cgnat']) 。 */
  ip.rangesOf = (classes) => { const want = new Set(classes); return ip.SPECIAL.filter((x) => want.has(x[1])).map((x) => x[0]); };

  S.ip = ip;
})(globalThis.SSOT = globalThis.SSOT || {});
