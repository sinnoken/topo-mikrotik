/*
 * SSOT 命名空間與共用工具。
 * 所有核心檔案都是一般 <script>（非 ES module），讓 index.html 可直接以 file:// 開啟；
 * 同一批檔案在 Node 上由 tests/load.js 依 tools/core-files.js 的順序載入。
 * 核心（core/readers/adapters/model/check/profile/query/compare/pipeline）不得碰 DOM 或瀏覽器儲存。
 */
(function (S) {
  'use strict';
  S.VERSION = '2.6.0';
  S.SCHEMA = 'ssot-snapshot/2';
  S.LINK_SCOPE = Object.freeze({
    INTERFACE_ADJACENCY: 'interface-adjacency',
    BROADCAST_DOMAIN: 'broadcast-domain',
    ROUTING_ADJACENCY: 'routing-adjacency',
  });
  /** 設備類型的顯示名稱（核心訊息與畫面共用）。 */
  S.KIND_LABEL = Object.freeze({ firewall: '防火牆', switch: '交換器', router: '路由器', host: '主機', unknown: '未知' });
  /** 介面類型（封閉列舉，參考 NetBox Interface type 的分類層級）；原始 RouterOS 類型另存於 rawType。 */
  S.IFC_TYPES = Object.freeze(['physical', 'lag', 'bridge', 'vlan', 'wireless', 'virtual', 'loopback', 'other']);
  S.readers = S.readers || {};
  S.adapters = S.adapters || {};
  S.data = S.data || {};
  S.profiles = S.profiles || {};

  const util = {};

  /** FNV-1a 雙 32 位元，回傳 16 位十六進位字串（輸入指紋，用於判斷是否同一份輸入）。 */
  util.hash = function (str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x5bd1e995);
      h2 ^= h2 >>> 13;
    }
    return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
  };

  util.cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  /** 自然排序（ge-0/0/2 < ge-0/0/10）。 */
  const collator = typeof Intl !== 'undefined' ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' }) : null;
  util.natural = (a, b) => (collator ? collator.compare(String(a), String(b)) : util.cmp(String(a), String(b)));
  util.sortBy = (arr, fn) => arr.sort((x, y) => util.natural(fn(x), fn(y)));
  util.uniq = (arr) => Array.from(new Set(arr));
  util.numSort = (arr) => arr.slice().sort((a, b) => a - b);
  /** 介面承載的所有 VLAN（PVID ∪ untagged ∪ tagged），由小到大；模型（Set）與 Snapshot（陣列）皆可用。 */
  util.ifcVlans = (i) => util.numSort(util.uniq([i.pvid, ...i.untaggedVlans, ...i.taggedVlans].filter((v) => v != null)));

  /**
   * 連通元件：nodes 為鍵的清單，pairs 為 [a, b]；端點不在 nodes 的邊略過。
   * 回傳元件陣列，元件內與元件之間都依 nodes 的順序（取決於輸入，不受 Map 雜湊影響）。
   */
  util.components = function (nodes, pairs) {
    const parent = new Map(nodes.map((n) => [n, n]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    pairs.forEach(([a, b]) => { if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b)); });
    const comps = new Map();
    nodes.forEach((n) => util.getOr(comps, find(n), () => []).push(n));
    return Array.from(comps.values());
  };

  /** 以 Map 取得或建立。 */
  util.getOr = function (map, key, make) {
    let v = map.get(key);
    if (v === undefined) { v = make(); map.set(key, v); }
    return v;
  };

  /** 解析 VLAN 清單（"10 20-22" / "[ v10 v20 ]" / 陣列），回傳 token 陣列；數字範圍會展開（上限 4094）。 */
  util.vlanTokens = function (text) {
    const out = [];
    String(text).replace(/[\[\]"]/g, ' ').split(/[\s,]+/).filter(Boolean).forEach((t) => {
      const m = t.match(/^(\d{1,4})-(\d{1,4})$/);
      if (m) {
        const a = +m[1], b = Math.min(+m[2], 4094);
        for (let i = a; i <= b && out.length < 5000; i++) out.push(String(i));
      } else out.push(t);
    });
    return out;
  };

  S.util = util;
})(globalThis.SSOT = globalThis.SSOT || {});
