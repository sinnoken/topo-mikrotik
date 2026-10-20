/*
 * MAC 前綴（OUI）→ 廠商縮寫。資料在 oui-data.js（離線、隨專案附帶，由 tools/build-oui.js 產生），第一次查詢時才展開。
 * IEEE 會把部分 6 碼區塊再細分給小廠商（MA-M 7 碼、MA-S 9 碼），這些 6 碼前綴本身登記為 IEEE Registration Authority，
 * 所以查詢時取最長符合的前綴。
 */
(function (S) {
  'use strict';
  let table = null;
  function load() {
    table = new Map();
    const p = S.data.ouiPacked;
    if (!p) return;
    const vendors = p.vendors.split('|');
    [[6, p.entries], [7, p.entries7], [9, p.entries9]].forEach(([len, packed]) => {
      if (packed) packed.split(',').forEach((e) => table.set(e.slice(0, len), vendors[parseInt(e.slice(len), 36)]));
    });
  }
  S.oui = {
    /** @param {string} macKey 12 碼大寫 MAC */
    lookup(macKey) {
      if (!table) load();
      if (!macKey) return null;
      // 本機管理位址（第一個位元組 bit1=1）通常是虛擬機或隨機 MAC
      const hit = table.get(macKey.slice(0, 9)) || table.get(macKey.slice(0, 7)) || table.get(macKey.slice(0, 6));
      if (hit) return hit;
      return parseInt(macKey.slice(0, 2), 16) & 2 ? '本機管理位址' : null;
    },
    size() { if (!table) load(); return table.size; },
    /** 資料來源（套件與版本），供畫面與文件追溯。 */
    source() { return (S.data.ouiPacked && S.data.ouiPacked.source) || null; },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
