/*
 * 唯一鍵正規化。整個系統只有這裡決定「兩個名稱是不是同一個東西」（含 VRF 的位址鍵）。
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

  /*
   * VRF（ADR-015）：沒有指定時是內建的 main（RouterOS 的寫法：沒寫 VRF 就是 main）。
   * 以 IP 或網段為鍵的地方都加上 VRF：main 不加後綴（10.0.0.1、10.0.0.0/24），其他 VRF 用 RouterOS 的 @<VRF>（10.0.0.1@cust-a）。
   * 所以只用 main 的網路，鍵（含 findingKey）與加入 VRF 之前相同。VRF 名稱照原樣（RouterOS 的名稱區分大小寫），只去頭尾空白。
   * 不同設備上名稱相同的 VRF 視為同一個位址空間（跨設備比較位址時的前提）。
   */
  keys.MAIN_VRF = 'main';
  /** VRF 名稱：去頭尾空白；null、undefined、空字串為 main。 */
  keys.vrf = (v) => { const s = v == null ? '' : String(v).trim(); return s || keys.MAIN_VRF; };
  /** 位址或網段的鍵：main 不加後綴，其他加上 @<VRF>。 */
  keys.inVrf = (base, vrf) => { const v = keys.vrf(vrf); return v === keys.MAIN_VRF ? String(base) : base + '@' + v; };
  /** keys.inVrf 的反向：[位址或網段, VRF]；沒有 @ 時是 main。IPv4 位址與網段不含 @，以最後一個 @ 切開。 */
  keys.splitVrf = (key) => { const s = String(key); const i = s.lastIndexOf('@'); return i < 0 ? [s, keys.MAIN_VRF] : [s.slice(0, i), keys.vrf(s.slice(i + 1))]; };

  S.keys = keys;
})(globalThis.SSOT = globalThis.SSOT || {});
