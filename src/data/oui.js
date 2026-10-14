/* MAC 前綴（OUI）→ 廠商縮寫。資料在 oui-data.js（離線、隨專案附帶），第一次查詢時才展開。 */
(function (S) {
  'use strict';
  let table = null;
  function load() {
    table = new Map();
    const p = S.data.ouiPacked;
    if (!p) return;
    const vendors = p.vendors.split('|');
    p.entries.split(',').forEach((e) => table.set(e.slice(0, 6), vendors[parseInt(e.slice(6), 36)]));
  }
  S.oui = {
    /** @param {string} macKey 12 碼大寫 MAC */
    lookup(macKey) {
      if (!table) load();
      if (!macKey) return null;
      // 本機管理位址（第一個位元組 bit1=1）通常是虛擬機或隨機 MAC
      if (parseInt(macKey.slice(0, 2), 16) & 2) return table.get(macKey.slice(0, 6)) || '本機管理位址';
      return table.get(macKey.slice(0, 6)) || null;
    },
    size() { if (!table) load(); return table.size; },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
