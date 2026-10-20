/*
 * 唯一鍵正規化。整個系統只有這裡決定「兩個名稱是不是同一個東西」。
 * 規則刻意保守：不依命名格式推測（命名規則屬於 profile，見 src/profile/）。
 */
(function (S) {
  'use strict';
  const keys = {};

  /** 設備：去頭尾空白、轉大寫。 */
  keys.dev = (name) => String(name || '').trim().toUpperCase();

  /** 介面：去空白、轉小寫（RouterOS 介面名稱區分大小寫，但同一台設備不會有只差大小寫的兩個介面）。 */
  keys.ifc = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, '');

  /** 介面全域識別：DEV|ifc。 */
  keys.ep = (dev, ifc) => keys.dev(dev) + '|' + keys.ifc(ifc);
  keys.splitEp = (ep) => { const i = ep.indexOf('|'); return [ep.slice(0, i), ep.slice(i + 1)]; };

  /** MAC：去分隔符、12 碼大寫；格式不符回傳 null。 */
  keys.mac = (s) => {
    const h = String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
    return h.length === 12 ? h : null;
  };
  /** 顯示用 MAC：aa:bb:cc:dd:ee:ff。 */
  keys.macPretty = (k) => (k ? k.toLowerCase().match(/.{2}/g).join(':') : '');
  keys.isMacText = (s) => /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^([0-9a-f]{4}\.){2}[0-9a-f]{4}$|^[0-9a-f]{12}$/i.test(String(s).trim());

  /** 鏈路：兩端 ep 排序後以 "~" 串接，方向無關。 */
  keys.link = (a, b) => (a < b ? a + '~' + b : b + '~' + a);

  S.keys = keys;
})(globalThis.SSOT = globalThis.SSOT || {});
