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
    (Array.isArray(children) ? children : children === undefined ? [] : [children]).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  };
  V.$ = (sel, root) => (root || document).querySelector(sel);
  V.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  V.KIND = { firewall: '防火牆', switch: '交換器', router: '路由器', host: '主機', unknown: '未知' };
  V.KIND_BASIS = { board: '依設備型號', data: '依收集的資料', caps: '依鄰居回報的功能', vendor: '依廠牌推測', heuristic: '依對端埠名推測', profile: '依命名規則', none: '無法判斷' };
  V.SEV = { error: '錯誤', warn: '警告', info: '提醒' };
  V.CLS = { lag: '聚合', '40g': '40G 以上', '10g': '10G', '1g': '1G', oob: '管理', l3: 'L3（OSPF）', other: '其他' };
  V.STATUS = { up: '連線', down: '中斷', unknown: '不明' };
  // 鄰居發現協定（LLDP／MNDP／CDP）；L3 連結沒有發現協定時退回 via（如 OSPF）
  V.protoText = (l) => ((l.protocols && l.protocols.length ? l.protocols : l.via) || []).map((p) => p.toUpperCase()).join('、');

  V.chip = (text, cls, attrs) => V.h('span', Object.assign({ class: 'chip ' + (cls || '') }, attrs || {}), text);
  V.kindChip = (k) => V.chip(V.KIND[k] || k, 'kind-' + k);
  V.sevDot = (s) => V.h('span', { class: 'sev ' + s, title: V.SEV[s] });
  V.fmtTime = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  V.num = (n) => Number(n).toLocaleString('zh-TW');

  /** 簡易表格：cols [{t:'標題', f:(row)=>內容}]，onRow(row) 可點擊 */
  V.table = function (cols, rows, opt) {
    const o = opt || {};
    const tb = V.h('tbody');
    rows.slice(0, o.limit || rows.length).forEach((r) => {
      tb.appendChild(V.h('tr', { class: [o.onRow ? 'click' : '', o.bad && o.bad(r) ? 'bad' : ''].join(' '), onclick: o.onRow ? () => o.onRow(r) : null },
        cols.map((c) => V.h('td', { class: c.cls || null }, c.f(r)))));
    });
    const t = V.h('table', { class: 't' }, [V.h('thead', null, V.h('tr', null, cols.map((c, n) => V.h('th', c.s && o.onSort ? { class: 'sortable', title: '點一下排序', onclick: () => o.onSort(n) } : null, c.t + (o.sortBy === n ? (o.sortDir < 0 ? ' ▼' : ' ▲') : ''))))), tb]);
    if (o.limit && rows.length > o.limit) return V.h('div', null, [t, V.h('div', { class: 'muted', style: { padding: '6px 8px' } }, `只顯示前 ${o.limit} 筆，共 ${V.num(rows.length)} 筆`)]);
    return t;
  };
})(globalThis.SSOT = globalThis.SSOT || {});
