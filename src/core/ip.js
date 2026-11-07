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

  /** BigInt → IPv6 文字（RFC 5952：小寫、省略前導 0、最長的連續 0（至少兩組）寫成 ::）。 */
  ip.v6FromBig = (n) => {
    const g = []; for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn));
    let bs = -1; let bl = 0;
    for (let i = 0; i < 8;) { if (g[i] !== 0) { i++; continue; } let j = i; while (j < 8 && g[j] === 0) j++; if (j - i >= 2 && j - i > bl) { bs = i; bl = j - i; } i = j; }
    const hex = g.map((x) => x.toString(16));
    return bs < 0 ? hex.join(':') : hex.slice(0, bs).join(':') + '::' + hex.slice(bs + bl).join(':');
  };

  /**
   * 位址、網段或範圍的文字 → [lo, hi, bits]（BigInt 的閉區間；bits 是 32 或 128）；不合法時 null。
   * 接受 10.0.0.1、10.0.0.0/24（主機位元清掉）、10.0.0.1-10.0.0.9，IPv6 同樣寫法（2001:db8::/32、2001:db8::1-2001:db8::9）。
   * 開頭的 !（否定）不是位址的一部分，由呼叫端先拿掉；有 ! 時 null。
   * 範圍的兩端要是同一個位址族、起點不大於終點；否則 null（不當成不含任何位址的範圍，呼叫端以 ip.badRange 分辨，判為不明）。
   * 防火牆條件（S.infer.fw.parseVal）、位址清單的項目與 /ip service 的 available-from 都經這裡解析，不另寫一份。
   */
  const RANGE_RE = /^([^/\-!]+)(?:\/(\d{1,3}))?(?:-([^/]+))?$/;
  /** 一個位址的文字 → [BigInt, bits]（IPv4 是 32、IPv6 是 128）；不是位址時 null。 */
  const addrOf = (x) => { if (ip.isIp(x)) return [BigInt(ip.toInt(x)), 32]; const n = ip.v6ToBig(x); return n === null ? null : [n, 128]; };
  ip.range = (text) => {
    const r = String(text).trim().match(RANGE_RE); if (!r) return null;
    const a = addrOf(r[1]); if (!a) return null;
    const [lo0, bits] = a;
    if (r[3]) { const b = addrOf(r[3]); return b && b[1] === bits && lo0 <= b[0] ? [lo0, b[0], bits] : null; }
    const len = r[2] === undefined ? bits : +r[2]; if (len > bits) return null;
    const span = (1n << BigInt(bits - len)) - 1n; const lo = lo0 & ~span & ((1n << BigInt(bits)) - 1n);
    return [lo, lo + span, bits];
  };
  /**
   * 文字是不是「兩端都是位址、但不是合法範圍」的 a-b：起點大於終點（10.0.0.9-10.0.0.1），或兩端的位址族不同（::1-10.0.0.1）。
   * 這種項目 ip.range 回傳 null，但不是網域名稱或其他文字；位址清單把它判為不明（S.infer.fw.addressListItem 的 invalid-range）。
   */
  ip.badRange = (text) => {
    const r = String(text).trim().match(RANGE_RE); if (!r || !r[3]) return false;
    const a = addrOf(r[1]); const b = addrOf(r[3]);
    return !!a && !!b && (a[1] !== b[1] || a[0] > b[0]);
  };
  const cmpBig = (p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0);
  /**
   * 位址集合（單一來源：防火牆的位址條件、位址清單、/ip service 的 available-from 都用它判斷「位址在不在裡面」，L4 的等價類邊界也由它產生）。
   * ip.set(items, bits)：items 是 ip.range 接受的文字，或 [lo, hi]（BigInt）；bits 是 32（IPv4）或 128（IPv6）。
   * 項目依起點排序，重疊與相鄰的合併成一段（結果不重疊、不相鄰）。
   * 文字不合法（含起點大於終點、位址族混用的範圍）、[lo, hi] 的起點大於終點，或位址族與 bits 不同時丟出 TypeError（呼叫端先決定不合法的項目怎麼處理，見 S.infer.addrSets），不靜默略過。
   * 回傳（凍結）：
   *   bits、ranges（合併後的 [lo, hi]，凍結）、
   *   has(x)：x（BigInt、IPv4 的 ip.toInt 數字，或位址文字）在不在集合內，二分搜尋；文字不是這個位址族的位址時丟出 TypeError；
   *   isAll（涵蓋整個位址空間）、isEmpty、within(other)（每個位址都在 other 內；other 是同 bits 的 ip.set）、
   *   covers(x)／overlaps(x)：x（ip.range 接受的文字或 [lo, hi]）的每個位址都在集合內／至少一個位址在集合內（看合併後的區段：/25,/25 涵蓋 /24）；文字不是這個位址族時丟出 TypeError；
   *   overlapping(x)：和 x 重疊的區段在 ranges 的索引（由小到大，凍結；與 overlaps 同一個判斷）；
   *   bounds()：等價類的邊界（每段的 lo 與 hi + 1，BigInt，由小到大，凍結）——同一段相鄰邊界之間的位址對 has 的結果相同；
   *   not()：補集（同 bits 的 ip.set，第一次呼叫時建立）；and(other)：交集（other 是同 bits 的 ip.set，位址族不同時丟出 TypeError）。
   * 相同的 items 與 bits 得到相同的結果（與項目順序無關）。
   */
  ip.set = (items, bits) => {
    if (bits !== 32 && bits !== 128) throw new TypeError(`S.ip.set：bits 要是 32 或 128（${bits}）`);
    const max = (1n << BigInt(bits)) - 1n;
    const rs = (items || []).map((x) => {
      if (Array.isArray(x)) {
        if (!(x[0] <= x[1])) throw new TypeError(`S.ip.set：區間的起點大於終點（${x[0]}-${x[1]}）`);
        return [x[0], x[1]];
      }
      const r = ip.range(x);
      if (!r || r[2] !== bits) throw new TypeError(`S.ip.set：「${x}」不是 IPv${bits === 32 ? 4 : 6} 的位址、網段或範圍`);
      return [r[0], r[1]];
    }).sort(cmpBig);
    const out = [];
    for (const [a, b] of rs) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + 1n) { if (b > last[1]) last[1] = b; } else out.push([a, b]);
    }
    const ranges = Object.freeze(out.map((r) => Object.freeze(r)));
    const num = (x) => {
      if (typeof x === 'bigint') return x;
      if (typeof x === 'number') return BigInt(x);
      const s = String(x).trim(); const n = bits === 32 ? (ip.isIp(s) ? BigInt(ip.toInt(s)) : null) : ip.isIp(s) ? null : ip.v6ToBig(s);
      if (n === null) throw new TypeError(`S.ip.set：「${x}」不是 IPv${bits === 32 ? 4 : 6} 位址`);
      return n;
    };
    const has = (x) => {
      const n = num(x); let lo = 0; let hi = ranges.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1; const r = ranges[mid];
        if (n < r[0]) hi = mid - 1; else if (n > r[1]) lo = mid + 1; else return true;
      }
      return false;
    };
    // x 的區間，與第一個終點不小於 x 起點的區段（沒有時 undefined）及它的索引（沒有時為 ranges.length）
    const span = (x) => {
      let lo; let hi;
      if (Array.isArray(x)) [lo, hi] = x;
      else { const r = ip.range(x); if (!r || r[2] !== bits) throw new TypeError(`S.ip.set：「${x}」不是 IPv${bits === 32 ? 4 : 6} 的位址、網段或範圍`); [lo, hi] = r; }
      let a = 0; let z = ranges.length;
      while (a < z) { const mid = (a + z) >> 1; if (ranges[mid][1] < lo) a = mid + 1; else z = mid; }
      return [lo, hi, ranges[a], a];
    };
    let b = null; let nt = null;
    const self = Object.freeze({
      bits, ranges, has,
      covers: (x) => { const [lo, hi, r] = span(x); return !!r && r[0] <= lo && hi <= r[1]; },
      overlaps: (x) => { const [, hi, r] = span(x); return !!r && r[0] <= hi; },
      // 和 x 至少有一個共同位址的區段在 ranges 的索引（由小到大，凍結）；overlaps(x) 為 true 時至少一個，同一套 span 判斷
      overlapping(x) {
        const [, hi, , a] = span(x); const out = [];
        for (let k = a; k < ranges.length && ranges[k][0] <= hi; k++) out.push(k);
        return Object.freeze(out);
      },
      isAll: ranges.length === 1 && ranges[0][0] === 0n && ranges[0][1] === max,
      isEmpty: ranges.length === 0,
      within(other) {
        // 兩邊都已合併、排序：逐段找 other 中包含它的那一段
        let j = 0;
        return ranges.every(([a, z]) => {
          while (j < other.ranges.length && other.ranges[j][1] < a) j++;
          return j < other.ranges.length && other.ranges[j][0] <= a && other.ranges[j][1] >= z;
        });
      },
      bounds: () => b || (b = Object.freeze(ranges.flatMap(([a, z]) => [a, z + 1n]))),
      not: () => nt || (nt = complement()),
      and(other) {
        if (other.bits !== bits) throw new TypeError(`S.ip.set：位址族不同，不能取交集（${bits}／${other.bits}）`);
        return ip.set(self.not().ranges.concat(other.not().ranges), bits).not();
      },
    });
    return self;
    function complement() {
      const out = []; let cur = 0n;
      ranges.forEach(([a, z]) => { if (a > cur) out.push([cur, a - 1n]); cur = z + 1n; });
      if (cur <= max) out.push([cur, max]);
      return ip.set(out, bits);
    }
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
