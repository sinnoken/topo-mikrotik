/*
 * 右側：某台設備的防火牆（選取 type 為 firewall／rule／service）。
 * 規則依位址族 → 表 → chain → position 列出（Q.firewallRuleRows、Q.firewallChains），
 * 另列 WAN／LAN 判斷（推論，Q.firewallZone）、/ip service 與 interface list。
 * 區塊一律用 details.js 的 section() 產生；顏色取自 theme.firewall。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const K = S.keys;
  const T = V.theme.firewall;
  const FAMILY = { ip: 'IPv4', ipv6: 'IPv6' };
  const ZONE_STATUS = {
    ok: ['已分出 WAN／LAN', 'ok'],
    'no-wan-list': ['沒有名為 WAN 的 interface list，WAN 相關檢查未執行', 'warn'],
    'empty-wan-list': ['WAN interface list 沒有成員，WAN 相關檢查未執行', 'warn'],
  };
  const ZONE_BASIS = { 'interface-list': '依 interface list（WAN／LAN）' };
  // 規則不多時，內建 chain 預設展開；多時全部收合，展開時才產生表格（大型網路單台設備可能有上百條）
  const OPEN_ALL_MAX = 60;
  const P = () => V.details.parts;

  const kvText = (o) => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join(' ');
  /** 原文行號連結：src 是 [[block, line]]，取第一筆 */
  const srcLink = (App, src) => {
    const s = src && src[0]; const b = s && App.Q.block(s[0]);
    return b ? h('a', { class: 'link mono', onclick: (e) => { e.stopPropagation(); App.openRaw(b.file, s[1]); } }, `第 ${s[1]} 行`) : '';
  };
  /** 與某實體有關的檢查結果：代碼標籤，點一下開啟該筆檢查結果 */
  const findingChips = (App, type, key) => App.Q.findingIndexesFor(type, key).map((i) => {
    const f = App.snap.findings[i];
    return h('a', { class: 'link', title: f.message, onclick: (e) => { e.stopPropagation(); App.selectFinding(i); } },
      V.chip(f.id, f.severity === 'error' ? 'err' : f.severity));
  });
  const ruleLabel = (App, key) => {
    const r = App.Q.getFirewallRule(key);
    return r ? `${r.chain} #${r.position}` : key;
  };

  function ruleTable(App, rows, focusKey) {
    return V.table([
      { t: '#', f: (x) => String(x.rule.position), s: (x) => x.rule.position },
      { t: '動作', f: (x) => h('span', { class: 'mono', style: { color: T.action[x.rule.action] || T.action.other } },
        x.rule.action + (x.rule.action === 'jump' && x.rule.params['jump-target'] ? ' → ' + x.rule.params['jump-target'] : '')) },
      { t: '條件', f: (x) => {
        const params = Object.assign({}, x.rule.params); delete params['jump-target'];
        return h('span', { class: 'mono' }, [kvText(x.rule.match) || '（全部）', Object.keys(params).length ? h('span', { class: 'muted' }, ' ' + kvText(params)) : null]);
      } },
      { t: '註解', f: (x) => h('span', null, [
        x.rule.comment || '',
        x.rule.commentEncoding === 'undecodable' ? V.chip('註解無法解碼', 'warn', { title: '註解的位元組不是 ASCII、UTF-8 或 Big5，原文可能已損毀' }) : null,
      ]) },
      { t: '狀態', f: (x) => (x.rule.disabled ? V.chip('停用') : '') },
      { t: '檢查', f: (x) => h('span', null, findingChips(App, 'rule', x.rule.key)) },
      { t: '原文', f: (x) => srcLink(App, x.rule.src) },
    ], rows, {
      bad: (x) => x.findings.some((f) => f.severity !== 'info'),
      rowClass: (x) => [x.rule.key === focusKey ? 'focus' : '', x.rule.disabled ? 'disabled' : ''].join(' '),
      rowStyle: (x) => {
        const st = {};
        if (x.rule.disabled) st.opacity = String(T.disabledAlpha);
        if (x.rule.key === focusKey) { st.background = T.focus.bg; st.boxShadow = `inset 0 2px 0 ${T.focus.border}, inset 0 -2px 0 ${T.focus.border}`; }
        return Object.keys(st).length ? st : null;
      },
    });
  }

  /** 一個 chain：可展開區塊；收合時不產生表格，第一次展開才產生 */
  function chainSection(App, dev, c, focusKey, openAll) {
    const rows = App.Q.firewallRuleRows(dev, { family: c.family, table: c.table, chain: c.chain });
    const hasFocus = rows.some((x) => x.rule.key === focusKey);
    const bad = rows.filter((x) => x.findings.some((f) => f.severity !== 'info')).length;
    const open = hasFocus || (!focusKey && openAll && c.builtin);
    const body = h('div', { class: 'fw-chain' });
    const fill = () => {
      if (body.firstChild) return;
      if (c.jumpedFrom.length) {
        body.appendChild(h('p', { class: 'muted' }, ['由這些規則 jump 進來：', ...c.jumpedFrom.flatMap((k, n) => [n ? '、' : '',
          P().L(App, ruleLabel(App, k), { type: 'rule', key: k })])]));
      }
      body.appendChild(ruleTable(App, rows, focusKey));
    };
    if (open) fill();
    const el = P().section(c.chain, body, { count: rows.length, fold: true, open, extra: [
      c.builtin ? null : V.chip('自訂 chain', 'info'),
      c.jumpedFrom.length ? V.chip(`jump 進入 ${c.jumpedFrom.length}`, 'info') : null,
      bad ? V.chip(`有問題 ${bad}`, 'warn') : null,
    ] });
    el.addEventListener('toggle', fill);
    return el;
  }

  function render(App, sel) {
    const Q = App.Q; const { section, kv, epLink, devLink, findingsBlock } = P();
    let dev = sel.dev; let focusRule = null; let focusSvc = null; let notice = null;
    if (sel.type === 'rule') {
      const r = Q.getFirewallRule(sel.key);
      if (r) { dev = r.dev; focusRule = r.key; } else { dev = K.splitEp(sel.key)[0]; notice = '基準中沒有這條規則（可能是舊基準才有）。'; }
    } else if (sel.type === 'service') {
      dev = K.splitEp(sel.key)[0]; focusSvc = sel.key;
      if (!Q.ipServicesOf(dev).some((s) => s.dev + '|' + s.name === sel.key)) notice = '基準中沒有這個服務。';
    }
    const d = Q.getDevice(dev);
    if (!d) return h('div', { class: 'empty-detail' }, '基準中沒有這台設備');
    const chains = Q.firewallChains(dev); const zone = Q.firewallZone(dev);
    const services = Q.ipServicesOf(dev); const lists = Q.interfaceListsOf(dev);
    const rules = Q.firewallRulesOf(dev);
    const openAll = rules.length <= OPEN_ALL_MAX;
    const fwFindings = Q.findingsFor('device', dev).filter((f) => (S.check.CATALOG[f.id] || {}).cat === '防火牆');
    // 位址族 → 表：一般區塊；其下每個 chain 是可展開區塊
    const tables = [];
    chains.forEach((c) => {
      const k = c.family + '|' + c.table; let t = tables.find((x) => x.k === k);
      if (!t) { t = { k, family: c.family, table: c.table, chains: [] }; tables.push(t); }
      t.chains.push(c);
    });
    const zs = zone && (ZONE_STATUS[zone.status] || [zone.status, '']);
    const svcKey = (s) => s.dev + '|' + s.name;
    return h('div', { class: 'detail' }, [
      h('h2', null, [devLink(App, dev), ' 的防火牆']),
      h('div', { class: 'row' }, [
        V.chip(`${rules.length} 條規則`), rules.some((r) => r.disabled) ? V.chip(`停用 ${rules.filter((r) => r.disabled).length}`) : null,
        V.chip(`${services.length} 個服務`),
      ]),
      notice ? h('p', { class: 'diffA' }, notice) : null,
      findingsBlock(App, fwFindings),
      section('WAN／LAN 判斷（推論）', zone ? [
        kv([['狀態', V.chip(zs[0], zs[1])], ['依據', ZONE_BASIS[zone.basis] || zone.basis || '—'],
          ['WAN list', zone.wanLists.join('、') || '—'],
          ['WAN 介面', zone.wanInterfaces.length ? h('span', null, zone.wanInterfaces.flatMap((ep, n) => [n ? '、' : '', epLink(App, ep)])) : '—'],
          ['LAN list', zone.lanLists.join('、') || '—'],
          ['LAN 介面', zone.lanInterfaces.length ? h('span', null, zone.lanInterfaces.flatMap((ep, n) => [n ? '、' : '', epLink(App, ep)])) : '—']]),
        h('p', { class: 'muted' }, '由 interface list 的名稱推定哪些介面朝外（WAN）、哪些朝內（LAN）；F03／F04／F07 等檢查依這個判斷。'),
      ] : null),
      ...tables.map((t) => section(`${FAMILY[t.family] || t.family} ${t.table}`,
        t.chains.map((c) => chainSection(App, dev, c, focusRule, openAll)), { count: t.chains.reduce((n, c) => n + c.rules, 0) })),
      section('服務（/ip service）', services.length ? V.table([
        { t: '服務', f: (s) => h('span', { class: 'mono' }, s.name), s: (s) => s.name },
        { t: '狀態', f: (s) => (s.enabled ? V.chip('啟用', 'ok') : V.chip('停用')), s: (s) => (s.enabled ? 0 : 1) },
        { t: '埠', f: (s) => (s.port == null ? '' : String(s.port)), s: (s) => s.port },
        { t: '允許來源', f: (s) => h('span', { class: 'mono' }, s.addresses.length ? s.addresses.join(' ') : '不限') },
        { t: '來源', f: (s) => (s.basis === 'default'
          ? V.chip('預設值', 'info', { title: 'export 沒有寫出這個服務，依 RouterOS 預設值' }) : srcLink(App, s.src)) },
        { t: '檢查', f: (s) => h('span', null, findingChips(App, 'service', svcKey(s))) },
      ], services, {
        bad: (s) => Q.findingsFor('service', svcKey(s)).some((f) => f.severity !== 'info'),
        rowClass: (s) => (svcKey(s) === focusSvc ? 'focus' : ''),
        rowStyle: (s) => (svcKey(s) === focusSvc ? { background: T.focus.bg, boxShadow: `inset 0 2px 0 ${T.focus.border}, inset 0 -2px 0 ${T.focus.border}` } : null),
      }) : null, { count: services.length }),
      section('Interface list', lists.length ? V.table([
        { t: '名稱', f: (l) => h('span', { class: 'mono' }, l.name) },
        { t: '成員', f: (l) => (l.members.length ? h('span', null, l.members.flatMap((ep, n) => [n ? '、' : '', epLink(App, ep)])) : '—') },
        { t: '包含／排除', f: (l) => [l.include.length ? '包含 ' + l.include.join('、') : '', l.exclude.length ? '排除 ' + l.exclude.join('、') : ''].filter(Boolean).join('；') },
        { t: '', f: (l) => (l.defined ? '' : V.chip('未定義', 'warn', { title: '規則或設定引用了這個 list，但 export 裡沒有定義' })) },
      ], lists) : null, { count: lists.length, fold: true }),
    ]);
  }

  V.firewall = { render };
})(globalThis.SSOT = globalThis.SSOT || {});
