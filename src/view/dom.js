/*
 * 畫面小工具。所有文字一律以 textContent 寫入，不使用 innerHTML 插入資料（避免設備名稱夾帶 HTML）。
 */
(function (S) {
  'use strict';
  const V = (S.view = S.view || {});

  /** h('div', {class:'x', onclick: fn}, [child, '文字']) */
  V.h = function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.entries(attrs).forEach(([k, v]) => {
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    if (tag === 'a' && attrs && String(attrs.class || '').split(/\s+/).includes('link') && !Object.prototype.hasOwnProperty.call(attrs, 'href')) {
      el.setAttribute('role', 'link'); el.setAttribute('tabindex', '0');
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
      });
    }
    (Array.isArray(children) ? children : children === undefined ? [] : [children]).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  };
  V.$ = (sel, root) => (root || document).querySelector(sel);
  V.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  V.KIND = S.KIND_LABEL;
  V.KIND_BASIS = { board: '依設備型號', data: '依收集的資料', caps: '依鄰居回報的功能', vendor: '依廠牌推測', heuristic: '依對端埠名推測', profile: '依命名規則', none: '無法判斷' };
  V.SEV = { error: '錯誤', warn: '警告', info: '提醒' };
  V.CLS = { lag: '聚合', '40g': '40G 以上', '10g': '10G', '1g': '1G', oob: '管理', other: '其他' };
  V.STATUS = { up: '連線', down: '中斷', unknown: '不明' };
  V.IFC_TYPE = { physical: '實體埠', lag: '聚合介面', bridge: 'Bridge', vlan: 'VLAN 介面', wireless: 'Wi-Fi', virtual: '虛擬介面', loopback: 'Loopback', other: '其他介面' };
  V.IFC_TYPE_BASIS = { rawType: '依 RouterOS 類型', member: '依聚合成員', name: '依介面名稱推測', default: '缺類型資料，預設為實體埠', assoc: '依 Wi-Fi 關聯表' };
  V.INFER_BASIS = { 'subnet-p2p': '/30／31 點對點網段', 'mndp-mutual': 'MNDP 雙向回報', 'mndp-unique': 'MNDP 唯一鄰居', fdb: 'MAC 表', stp: 'RSTP 指定橋接器' };
  V.CONFIDENCE = { high: '信心高（多重證據）', medium: '信心中（單一證據）' };
  V.WIFI_BASIS = { registration: '依關聯表（已確認）', 'bridge-wifi': '依 MAC 表的無線介面（推定）', 'via-ap-port': '經由 AP 所接的交換器埠（推定，無法區分有線或無線）' };
  V.MODE = { access: 'Access（untagged）', tagged: 'Tagged（trunk）' };
  V.ifcState = (i) => (i.enabled === false ? '停用' : V.STATUS[i.status]);
  // 收集失敗（blocks[].failure、coverage[].failures[]）的原因
  V.FAILURE = { timeout: '逾時', 'exit-code': '指令失敗', connection: '連線失敗', other: '其他錯誤' };
  V.failureText = (f) => (V.FAILURE[f.reason] || f.reason) + (f.exitCode == null ? '' : `（結束碼 ${f.exitCode}）`);
  /** 覆蓋率的「有缺漏」：已收集的設備缺少應收集的資料，或有指令收集失敗（只有失敗、沒有缺少也算） */
  V.coverageGap = (row) => !!row.collected && (row.missing.length > 0 || (row.failures || []).length > 0);
  /** UTC ISO 時間 → 「2026-10-24 03:00:00 UTC」（收集時間是 UTC，不轉成本機時區） */
  V.fmtUtc = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$|Z$/, '') + ' UTC' : '');
  // 鄰居發現協定（LLDP／MNDP／CDP）；L3 鏈路沒有發現協定時退回 via（如 OSPF）
  V.protoText = (l) => ((l.protocols && l.protocols.length ? l.protocols : l.via) || []).map((p) => p.toUpperCase()).join('、');

  /**
   * 反引號標出的 RouterOS 指令與欄位（CATALOG 的 causes／action 的寫法）：切成 [{ text, code }]。
   * 沒有成對的反引號保留為一般文字，不吞掉。
   */
  V.codeParts = (s) => {
    const str = String(s); const out = []; const re = /`([^`]+)`/g; let at = 0; let m;
    while ((m = re.exec(str))) {
      if (m.index > at) out.push({ text: str.slice(at, m.index), code: false });
      out.push({ text: m[1], code: true }); at = re.lastIndex;
    }
    if (at < str.length) out.push({ text: str.slice(at), code: false });
    return out;
  };
  /** 同上，組成 DOM 節點：一般文字是文字節點，反引號內是 <code>（等寬字型），都以 textContent 寫入 */
  V.codeText = (s) => V.codeParts(s).map((p) => (p.code ? V.h('code', { class: 'mono' }, p.text) : p.text));

  V.chip = (text, cls, attrs) => V.h('span', Object.assign({ class: 'chip ' + (cls || '') }, attrs || {}), text);
  V.kindChip = (k) => V.chip(V.KIND[k] || k, 'kind-' + k);
  V.sevDot = (s) => V.h('span', { class: 'sev ' + s, title: V.SEV[s] });
  V.fmtTime = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  V.num = (n) => Number(n).toLocaleString('zh-TW');

  /** 依欄位的 s(row) 排序：空值固定排最後；字串用 natural（IP 依數值順序），數字比大小。回傳新陣列。 */
  V.sortRows = function (rows, col, dir) {
    const val = (r) => { const v = col.s(r); return v == null || v === '' ? null : v; };
    return rows.slice().sort((a, b) => {
      const x = val(a); const y = val(b);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : SSOT.util.natural(String(x), String(y))) * dir;
    });
  };

  /**
   * 簡易表格：cols [{t:'標題', f:(row)=>內容, s?:(row)=>排序值}]，onRow(row) 可點擊。
   * 有 s 的欄位可點標頭排序；呼叫端不傳 onSort 時由表格自己儲存排序狀態（詳情表用），
   * 傳入 onSort／sortBy／sortDir 時由呼叫端管理（清單分頁需跨重繪保留）。
   */
  V.table = function (cols, rows, opt) {
    const o = opt || {};
    if (o.onSort || !cols.some((c) => c.s)) return renderTable(cols, rows, o);
    const box = V.h('div');
    const st = { by: -1, dir: 1 };
    const draw = () => {
      V.clear(box);
      const sorted = st.by >= 0 ? V.sortRows(rows, cols[st.by], st.dir) : rows;
      box.appendChild(renderTable(cols, sorted, Object.assign({}, o, {
        sortBy: st.by, sortDir: st.dir, onSort: (n) => { st.dir = st.by === n ? -st.dir : 1; st.by = n; draw(); },
      })));
    };
    draw();
    return box;
  };

  function renderTable(cols, rows, o) {
    const tb = V.h('tbody');
    rows.slice(0, o.limit || rows.length).forEach((r) => {
      const activate = o.onRow ? () => o.onRow(r) : null;
      // rowClass／rowStyle：呼叫端加的列樣式；顏色由呼叫端從 theme 取，套在每個儲存格（表格的底色畫在 td 上）
      const style = o.rowStyle ? o.rowStyle(r) : null;
      tb.appendChild(V.h('tr', {
        class: [activate ? 'click' : '', o.bad && o.bad(r) ? 'bad' : '', o.rowClass ? o.rowClass(r) || '' : ''].join(' '),
        onclick: activate,
        tabindex: activate ? '0' : null,
        onkeydown: activate ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } } : null,
      },
        cols.map((c) => V.h('td', { class: c.cls || null, style }, c.f(r)))));
    });
    const t = V.h('table', { class: 't' }, [V.h('thead', null, V.h('tr', null, cols.map((c, n) => V.h('th', c.s && o.onSort ? { class: 'sortable', title: '點一下排序', onclick: () => o.onSort(n) } : null, c.t + (o.sortBy === n ? (o.sortDir < 0 ? ' ▼' : ' ▲') : ''))))), tb]);
    if (o.limit && rows.length > o.limit) return V.h('div', null, [t, V.h('div', { class: 'muted table-more' }, `只顯示前 ${o.limit} 筆，共 ${V.num(rows.length)} 筆`)]);
    return t;
  }
})(globalThis.SSOT = globalThis.SSOT || {});
