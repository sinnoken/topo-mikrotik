/*
 * SSOT 命名空間與共用工具。
 * 所有核心檔案都是一般 <script>（非 ES module），讓 index.html 可直接以 file:// 開啟；
 * 同一批檔案在 Node 上由 tests/load.js 依 tools/core-files.js 的順序載入。
 * 核心（core/readers/adapters/model/check/profile/query/compare/pipeline）不得碰 DOM 或瀏覽器儲存。
 */
(function (S) {
  'use strict';
  S.VERSION = '3.4.0';
  // ssot-snapshot/3（ADR-015）：位址、網段、ARP、路由加上 vrf，prefixes 改為每個 VRF 的每個網段一筆。
  // /2 不轉換（ADR-010：可以從輸入重建）；畫面還原時 schema 不同就用儲存的輸入重建（ADR-005）。
  S.SCHEMA = 'ssot-snapshot/3';
  S.LINK_SCOPE = Object.freeze({
    INTERFACE_ADJACENCY: 'interface-adjacency',
    BROADCAST_DOMAIN: 'broadcast-domain',
    ROUTING_ADJACENCY: 'routing-adjacency',
  });
  /** 設備類型的顯示名稱（核心訊息與畫面共用）。 */
  S.KIND_LABEL = Object.freeze({ firewall: '防火牆', switch: '交換器', router: '路由器', host: '主機', unknown: '未知' });
  /** 介面類型（封閉列舉，參考 NetBox Interface type 的分類層級）；原始 RouterOS 類型另存於 rawType。 */
  S.IFC_TYPES = Object.freeze(['physical', 'lag', 'bridge', 'vlan', 'wireless', 'virtual', 'loopback', 'other']);
  /**
   * 管理面設定（mgmtSettings，F10–F14）的出廠預設值：/export 只寫非預設值，export 沒寫的欄位以這張表補上，並標為預設值（推論）。
   * 依線上手冊（RouterOS 7.24–7.26）各選單參數的 Default；較舊的 7.x 無法以手冊確認，待真機確認（路線圖「等使用者提供資料」）。
   * 預設組態（defconf）會把 MAC server、MAC WinBox、鄰居探索設成 LAN，這些會寫進 export，不是這裡的預設值。
   * snmp.community 是設備出廠就有的那一個 community（手冊：只要沒有改或刪掉，就是可從任何位址讀取的 public）。
   */
  S.MGMT_DEFAULTS = Object.freeze({
    routerOS: '7.24–7.26（線上手冊）',
    dns: Object.freeze({ allowRemote: false }),
    macServer: Object.freeze({ allowedList: 'all' }),
    macWinbox: Object.freeze({ allowedList: 'all' }),
    discovery: Object.freeze({ list: 'static', protocols: Object.freeze(['cdp', 'lldp', 'mndp']), mode: 'tx-and-rx' }),
    snmp: Object.freeze({ enabled: false, community: Object.freeze({ name: 'public', addresses: Object.freeze(['::/0']), write: false, security: 'none', disabled: false }) }),
    upnp: Object.freeze({ enabled: false }),
    proxy: Object.freeze({ enabled: false, ports: Object.freeze([8080]) }),
    socks: Object.freeze({ enabled: false, port: 1080 }),
    bandwidthServer: Object.freeze({ enabled: true, authenticate: true, port: 2000 }),
    manual: Object.freeze({
      dns: 'https://manual.mikrotik.com/docs/cli-reference/ip/dns.md',
      macServer: 'https://manual.mikrotik.com/docs/cli-reference/tool/mac-server.md',
      macWinbox: 'https://manual.mikrotik.com/docs/cli-reference/tool/mac-server/mac-winbox.md',
      discovery: 'https://manual.mikrotik.com/docs/cli-reference/ip/neighbor/discovery-settings.md',
      snmp: 'https://manual.mikrotik.com/docs/cli-reference/snmp.md',
      community: 'https://manual.mikrotik.com/docs/cli-reference/snmp/community.md',
      upnp: 'https://manual.mikrotik.com/docs/cli-reference/ip/upnp.md',
      upnpInterfaces: 'https://manual.mikrotik.com/docs/cli-reference/ip/upnp/interfaces.md',
      proxy: 'https://manual.mikrotik.com/docs/cli-reference/ip/proxy.md',
      socks: 'https://manual.mikrotik.com/docs/cli-reference/ip/socks.md',
      bandwidthServer: 'https://manual.mikrotik.com/docs/cli-reference/tool/bandwidth-server.md',
    }),
  });
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
  /**
   * ISO 8601 時間字串（日期，或日期＋時間＋時區 Z／±hh:mm）：時間參數與欄位的唯一判斷（S.build 的 options.now、處理紀錄、工作包、CLI 的 --now）。
   * 年月日、時分秒與時區位移逐欄比對要真的存在：Date.parse 會把 2026-02-30 進位成 3/2、接受 24:00，這裡都不接受。不正規化。
   */
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2})))?$/;
  util.isIso = (v) => {
    const m = typeof v === 'string' && ISO_RE.exec(v); if (!m) return false;
    const [y, mo, d, h, mi, s, oh, om] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
    const day = new Date(0); day.setUTCFullYear(y, mo - 1, d); // 不用 Date.UTC：它把 0–99 年當成 1900 年代
    if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return false;
    return h < 24 && mi < 60 && s < 60 && oh < 24 && om < 60 && Number.isFinite(Date.parse(v));
  };
  /** 物件的鍵依字典序排列後的 JSON（陣列順序保留）：內容相同、只差鍵順序的物件得到同一個字串，用於計算雜湊。 */
  util.canonicalJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.keys(x).sort(util.cmp).reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));
  /** 自然排序（ge-0/0/2 < ge-0/0/10）。 */
  const collator = typeof Intl !== 'undefined' ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' }) : null;
  util.natural = (a, b) => (collator ? collator.compare(String(a), String(b)) : util.cmp(String(a), String(b)));
  util.sortBy = (arr, fn) => arr.sort((x, y) => util.natural(fn(x), fn(y)));
  util.uniq = (arr) => Array.from(new Set(arr));
  util.numSort = (arr) => arr.slice().sort((a, b) => a - b);
  /** VLAN 清單的精簡文字：[10, 11, 12, 20] → "10-12,20"（輸入須已由小到大排序，例如 util.ifcVlans 的結果）。核心訊息與畫面共用。 */
  util.fmtVlans = function (ids) {
    const out = []; let s = null; let p = null;
    ids.forEach((v) => { if (s === null) { s = p = v; } else if (v === p + 1) { p = v; } else { out.push(s === p ? s : s + '-' + p); s = p = v; } });
    if (s !== null) out.push(s === p ? s : s + '-' + p);
    return out.join(',');
  };
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
