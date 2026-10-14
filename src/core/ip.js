/* IPv4 工具：轉換、CIDR 比對、遮罩轉換。 */
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

  S.ip = ip;
})(globalThis.SSOT = globalThis.SSOT || {});
