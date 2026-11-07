/*
 * 路由表視窗：某台設備的所有路由（Q.allRoutesOf，含非作用中的），開在共用的表格視窗 V.tableDialog（table-dialog.js），是它的第二個使用者。
 * 右欄的設備詳情只留摘要（summary）：總數、路由最多的幾組、搜尋框（Enter 開視窗並帶入搜尋字）與「查看全部路由」，
 * 以及 VRF、策略路由與 OSPF 鄰接的一行摘要（每一項開視窗的那個分頁）。
 *   分頁：路由、VRF、/routing rule、策略路由的路由表、OSPF 鄰接（EXTRA_TABS）；設備沒有的資料不列那個分頁。只有路由的列可以選。
 *   左欄：V.bigList，列依網段排序。路由一頁放得下、或分組沒有減少要看的列（V.groupsUseful）時直接列出；否則依路由表與協定分組（groups），
 *         下一跳是一欄；組內不列和組名重複的欄（inGroup: false），直接列出與搜尋結果才列。
 *         搜尋位址或網段經 Q.routesMatching（前綴由長到短），其他文字（協定、下一跳名稱）依文字比對。
 *   右欄：點選的那一條路由——屬性、每個下一跳解析的 VRF 與擁有者（Q.hopOwner）、原文，以及「從這台追蹤到這個網段」（App.openTrace）。
 * 選取是 { type: 'routes', dev, route?: 列的鍵, group?: 組的鍵, search?: 搜尋字, tab?: 分頁 }，只是檢視狀態（App.sel），不進基準。
 * 區塊一律用 V.section（details.js 的 parts.section）產生。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const K = S.keys;
  const P = () => V.details.parts;
  /** 視窗的 id：一台設備一個 */
  const DIALOG = 'routes|';
  /** 右欄摘要列出的組數（路由最多的幾組） */
  const TOP_GROUPS = 3;
  /** 視窗的狀態：這一份基準（換基準時重開）、開啟它的選取（同一個選取重畫時不重開）、是否正在處理視窗自己發出的選取、
   *  要定位的路由（sel.route；右欄沒有選取的列而它不是 null，表示基準中沒有這條路由，總覽寫出說明） */
  const rt = { Q: null, sel: null, inner: false, want: null };
  const MISSING_ROUTE = '基準中沒有這條路由（可能是舊基準才有）。';
  const missingNote = () => (rt.want != null ? h('p', { class: 'diffA routes-missing' }, MISSING_ROUTE) : null);
  const dialog = () => { const d = V.tableDialog.current(); return d && d.id.startsWith(DIALOG) ? d : null; };
  const multiVrf = (Q) => Q.vrfs().length > 1;
  /** 這台設備有 main 以外的路由表，或基準有多個 VRF：才列「路由表」 */
  const showTable = (Q, routes) => multiVrf(Q) || routes.some((r) => (r.routingTable || K.MAIN_VRF) !== K.MAIN_VRF);

  // ---------------------------------------------------------------- 路由的文字（分組、搜尋與網段詳情共用）
  /** 下一跳的文字：閘道在路由所在的 VRF 以外解析（路由洩漏、VRF 介面）時以 RouterOS 的寫法標出 @VRF */
  const nhText = (r, n) => {
    const own = r.vrf || K.MAIN_VRF; const other = n.vrf && n.vrf !== own;
    return (n.ip ? n.ip + (other ? '@' + n.vrf : '') + ' ' : '') + (n.ifc || '') + (!n.ip && other ? `（VRF ${n.vrf}）` : '');
  };
  /**
   * 下一跳的儲存格：每個下一跳一行（ECMP 的多個下一跳不黏成一串）；multi（基準有多個 VRF）時 title 寫出每個閘道在哪個 VRF 解析與依據
   * （觸控看不到的部分在路由詳情）
   */
  const nhCell = (r, multi) => h('div', { class: 'mono route-nh', title: multi ? r.nh.map((n) => `${n.ip || n.ifc || ''}：在 ${V.vrfText(n.vrf)} 解析（${V.NH_VRF_BASIS[n.vrfBasis] || n.vrfBasis || ''}）`).join('\n') : null },
    r.nh.map((n) => h('div', { class: 'route-nh-one' }, nhText(r, n).trim())));
  /** 路由的協定（黑洞路由另成一類） */
  const routeProto = (r) => (r.blackhole ? '黑洞路由' : r.proto || '（協定不明）');
  const routeNh = (r) => r.nh.map((n) => nhText(r, n).trim()).filter(Boolean).join('、');
  /** 搜尋的文字：網段、路由表、協定、下一跳 */
  const routeText = (r) => [`${r.prefix}/${r.len}`, r.routingTable || K.MAIN_VRF, routeProto(r), routeNh(r)].join(' ');
  /**
   * 列的鍵：路由的第一個來源行（區塊:行）。網段詳情的「路由到這個網段」（Q.subnetGraph 的路由，來源相同）也用它定位到這一列。
   * 沒有來源行時 null（視窗的列另以順序編號）。
   */
  const keyOf = (r) => (r.src && r.src.length ? r.src[0].join(':') : null);
  /**
   * 路由一頁放得下（V.BIG_LIST.page 條以內）時不分組：直接依網段列出（V.groupsUseful 的 flatMax）。
   * 組數超過路由數的一半時也不分組（V.groupsUseful 的 groupRatio）。視窗與右欄摘要的「路由最多的幾組」用同一個判斷。
   */
  const FLAT_MAX = V.BIG_LIST.page;
  const mainFirst = (t) => (t === K.MAIN_VRF ? 0 : 1);
  const tableOf = (r) => r.routingTable || K.MAIN_VRF;
  /** 沒有距離的排在同一個網段的最後 */
  const distOf = (r) => (r.distance == null ? Number.MAX_SAFE_INTEGER : r.distance);
  /** 列的順序：依網段（位址依數值，再依前綴長度），同一個網段 main 在前、再依路由表與距離 */
  const byPrefix = (a, b) => S.util.natural(a.prefix, b.prefix) || a.len - b.len || mainFirst(tableOf(a)) - mainFirst(tableOf(b))
    || S.util.natural(tableOf(a), tableOf(b)) || distOf(a) - distOf(b);
  /** 這台設備的路由，依網段排序（視窗的列與分組都用這個順序） */
  const sortedRoutes = (Q, dev) => Q.allRoutesOf(dev).slice().sort(byPrefix);
  /**
   * 分組：依路由表（showTable 時寫出）與協定，依路由表（main 在前）、協定排列；下一跳是組內的一欄。
   * 非作用中的路由數寫在組的標題列（V.stateChip）。
   */
  function routeGroups(routes, table) {
    const by = new Map();
    routes.forEach((r) => {
      const t = r.routingTable || K.MAIN_VRF; const proto = routeProto(r);
      S.util.getOr(by, [t, proto].join('\u0000'), () => ({ table: t, proto, rows: [] })).rows.push(r);
    });
    return Array.from(by.entries()).sort(([, a], [, b]) => mainFirst(a.table) - mainFirst(b.table) || S.util.natural(a.table, b.table)
      || S.util.natural(a.proto, b.proto))
      .map(([key, g]) => ({ key, rows: g.rows,
        title: h('span', null, [table ? h('span', { class: 'mono' }, g.table) : null, table ? '・' : null, g.proto]),
        extra: [V.stateChip(g.rows.filter((r) => r.active === false).length, '條非作用中')] }));
  }
  /** 這些路由要不要分組（視窗與右欄摘要共用） */
  const grouped = (routes, groups) => V.groupsUseful(routes.length, groups.length, FLAT_MAX);
  const INACTIVE_TIP = '目前沒有被選用（例如備援路由）；路由追蹤只看作用中的路由';
  const POLICY_TIP = '這張路由表不是 VRF：只有 /routing rule 指定時才會查';

  // ---------------------------------------------------------------- 這台設備的路由設定（視窗的分頁與右欄摘要共用同一份）
  /**
   * 視窗的分頁（路由以外）：key、分頁的標籤、右欄摘要的寫法（label＋筆數＋unit）。右欄的一行摘要與分頁的數字都取自 routing()，同一個來源。
   */
  const EXTRA_TABS = Object.freeze([
    { key: 'vrfs', label: 'VRF', summary: 'VRF', unit: '個' },
    { key: 'rules', label: '/routing rule', summary: '策略路由', unit: '條規則' },
    { key: 'tables', label: '路由表（/routing table）', summary: '策略路由的路由表', unit: '張' },
    { key: 'ospf', label: 'OSPF 鄰接', summary: 'OSPF 鄰接', unit: '個' },
  ]);
  /**
   * 這台設備的路由設定（事實）：沒有的資料是空陣列，視窗不列那個分頁、右欄不寫那一項。
   *   vrfs：Q.vrfsOf（只有內建的 main 時不列，與加入 VRF 之前相同）
   *   tables、rules：Q.routingTables()／Q.routingRules() 中這台設備的（含停用的規則）；路由表只在有策略路由（Q.policyOf().any、/routing rule
   *     或只用於策略路由的路由表）時列出
   *   ospf：Q.ospfAdjacenciesOf（L3 鄰接，非實體直連）
   *   pol：Q.policyOf；unsure：改過查表順序或有 mangle 的 mark-routing（查哪一張表不明，警告）
   */
  function routing(Q, dev) {
    const pol = Q.policyOf(dev);
    const tables = Q.routingTables().filter((t) => t.dev === dev); const rules = Q.routingRules().filter((r) => r.dev === dev);
    const policy = pol.any || rules.length > 0 || tables.some((t) => t.vrf == null);
    const vrfs = Q.vrfsOf(dev);
    return { pol, policy, unsure: pol.custom || pol.marks.length > 0,
      vrfs: vrfs.some((v) => !v.builtin) ? vrfs : [], rules, tables: policy ? tables : [], ospf: Q.ospfAdjacenciesOf(dev) };
  }
  /** 查表的設定（policy-rules 與 mangle 的 mark-routing）：視窗頁首，有策略路由時才列 */
  function policyHead(rt0) {
    const pol = rt0.pol;
    return P().kv([
      ['查表順序（policy-rules）', h('span', null, [h('span', { class: 'mono' }, pol.policyRules.join(' → ')), ' ',
        pol.custom ? V.chip('改過預設的順序：查哪一張表無法判斷', 'warn') : V.chip('預設')])],
      ['mangle mark-routing', pol.marks.length ? h('span', null, [`${V.num(pol.marks.length)} 條 `, V.chip('mangle 不在模型中：封包可能改查其他路由表，結果不明', 'warn')]) : null],
    ]);
  }

  // ---------------------------------------------------------------- 右欄的摘要（設備詳情）
  /** 開啟視窗：search 帶入搜尋字、group 展開那一組、tab 切到那個分頁 */
  const openSel = (dev, o) => Object.assign({ type: 'routes', dev }, o || {});
  /**
   * 設備詳情的「路由表」：總數（標題的 count）、非作用中的條數、路由最多的 TOP_GROUPS 組（點一下開視窗並展開那一組）、
   * 搜尋框（Enter 開視窗並帶入搜尋字）與「查看全部路由」。與相鄰的防火牆摘要同一種模式（展開列，入口在標題列）。
   * VRF、策略路由與 OSPF 鄰接只寫一行（例如「VRF 2 個、策略路由 3 條規則」），每一項開視窗的那個分頁。
   * 查哪一張表不明（改過 policy-rules 或有 mark-routing）時預設展開，標題列標出。
   */
  function summary(App, dev) {
    const Q = App.Q; const routes = Q.allRoutesOf(dev); const r0 = routing(Q, dev);
    const more = EXTRA_TABS.filter((t) => r0[t.key].length);
    if (!routes.length && !more.length && !r0.policy) return null;
    // 分組與視窗相同（routeGroups＋grouped）：視窗不分組時摘要也不列組
    const all = routes.length ? routeGroups(routes, showTable(Q, routes)) : [];
    const groups = grouped(routes, all) ? all : [];
    const top = groups.map((g, n) => ({ g, n })).sort((a, b) => b.g.rows.length - a.g.rows.length || a.n - b.n).slice(0, TOP_GROUPS).map((x) => x.g);
    const input = h('input', { type: 'search', class: 'routes-search', placeholder: '搜尋位址、網段、下一跳、協定', 'aria-label': '搜尋路由（Enter 在路由表視窗開啟結果）',
      onkeydown: (e) => { if (e.key !== 'Enter') return; e.preventDefault(); const q = String(input.value || '').trim(); App.select(openSel(dev, q ? { search: q } : null)); } });
    const line = more.length ? h('p', { class: 'routes-more' }, more.flatMap((t, n) => [n ? '、' : '',
      h('a', { class: 'link routes-tab', 'data-tab': t.key, onclick: () => App.select(openSel(dev, { tab: t.key })) }, `${t.summary} ${V.num(r0[t.key].length)} ${t.unit}`)])) : null;
    return P().section('路由表', [
      !routes.length ? h('p', { class: 'muted routes-total' }, '沒有路由（或沒有收集 /ip route）。')
        : groups.length ? h('p', { class: 'muted routes-total' }, `共 ${V.num(routes.length)} 條，依路由表與協定分成 ${V.num(groups.length)} 組`
          + (groups.length > top.length ? `；路由最多的 ${V.num(top.length)} 組：` : '：'))
          : h('p', { class: 'muted routes-total' }, `共 ${V.num(routes.length)} 條，在路由表視窗依網段列出。`),
      top.length ? h('ul', { class: 'routes-top' }, top.map((g) => h('li', null, [
        h('a', { class: 'link routes-group', 'data-group': g.key, onclick: () => App.select(openSel(dev, { group: g.key })) }, g.title), ' ',
        V.chip(V.num(g.rows.length), 'count')]))) : null,
      routes.length ? h('div', { class: 'row routes-search-row' }, input) : null,
      line,
    ], { count: routes.length, fold: true, open: r0.unsure, cls: 'routes-summary',
      extra: [V.stateChip(routes.filter((r) => r.active === false).length, '條非作用中'), r0.unsure ? V.chip('查哪一張表不明', 'warn') : null,
        h('a', { class: 'link routes-open', onclick: () => App.select(openSel(dev)) }, routes.length ? '查看全部路由' : '查看路由設定')] });
  }

  // ---------------------------------------------------------------- 視窗的左欄與右欄
  function routesTab(App, dev) {
    const Q = App.Q; const rows = sortedRoutes(Q, dev); const table = showTable(Q, rows); const multi = multiVrf(Q);
    // 列的鍵：來源行；沒有來源行時以順序編號（同一份基準內固定）
    const keys = new Map(rows.map((r, n) => [r, keyOf(r) || '#' + n]));
    return {
      // grouped：少於 BIG_LIST.min 條也交給 V.bigList（搜尋框）；分不分組由 flatMax 與 V.groupsUseful 決定（同右欄摘要）
      key: 'routes', label: '路由', count: rows.length, rows, rowKey: (r) => keys.get(r), grouped: true, flatMax: FLAT_MAX,
      empty: '這台設備沒有路由（或沒有收集 /ip route）。', unit: '條', what: '路由', placeholder: '搜尋位址、網段、下一跳、協定',
      text: routeText, match: (q) => Q.routesMatching(dev, q),
      columns: [
        // 非作用中（例如備援的預設路由）也列出，可與 R11 等檢查對照：chip 在網段欄，整列 muted（route-off）
        { t: '網段', f: (r) => h('span', null, [h('span', { class: 'mono' }, `${r.prefix}/${r.len}`),
          r.active === false ? ' ' : null, r.active === false ? V.chip('非作用中', 'route-inactive', { title: INACTIVE_TIP }) : null]), s: (r) => `${r.prefix}/${r.len}` },
        // 路由表與協定是組名：組內不列（inGroup: false），不分組與搜尋結果才列；下一跳每組都列
        ...(table ? [{ t: '路由表', f: (r) => h('span', null, [h('span', { class: 'mono' }, r.routingTable || K.MAIN_VRF), r.vrf == null ? V.chip('只用於策略路由', 'info', { title: POLICY_TIP }) : null]), s: (r) => r.routingTable, inGroup: false }] : []),
        { t: '協定', f: (r) => (r.blackhole ? h('span', { class: 'diffA' }, '黑洞路由') : r.proto), s: (r) => r.proto, inGroup: false },
        { t: '距離', f: (r) => (r.distance == null ? '' : String(r.distance)), s: (r) => r.distance },
        { t: '下一跳', f: (r) => nhCell(r, multi), s: (r) => (r.nh[0] ? r.nh[0].ip || r.nh[0].ifc : '') },
      ],
      table: { rowClass: (r) => (r.active === false ? 'route-off' : '') },
      groups: () => routeGroups(rows, table),
    };
  }
  /**
   * 路由以外的分頁（VRF、/routing rule、路由表、OSPF 鄰接）：列不能選（selectable: false），連結在格內（原文、介面、設備）。
   * 列數一般只有幾筆；欄位與原本設備詳情的表相同，視窗夠寬，900px 以下每列一塊（stack）。
   */
  function extraTabs(App, dev, r0) {
    const Q = App.Q; const { epLink, devLink } = P(); const src = (x) => V.srcLink(App, x.src);
    const tab = (key, o) => { const t = EXTRA_TABS.find((x) => x.key === key); return Object.assign({ key, label: t.label, count: r0[key].length, rows: r0[key], selectable: false, unit: t.unit }, o); };
    const byIndex = (rows) => { const m = new Map(rows.map((r, n) => [r, '#' + n])); return (r) => m.get(r); };
    const fromExport = r0.vrfs.some((v) => v.source === 'export');
    return [
      tab('vrfs', { rowKey: (v) => v.name,
        extra: [fromExport ? h('p', { class: 'muted' }, ['依 export 的 /ip vrf：export 不寫內建的 main，假設 main 在最後（比對介面時最後才輪到 main） ', V.chip('推論', 'info')]) : null,
          V.stateChip(r0.vrfs.filter((v) => v.disabled).length, '個停用')],
        columns: [
          { t: '順序', f: (v) => String(v.order), s: (v) => v.order },
          { t: 'VRF', f: (v) => h('span', null, [h('span', { class: 'mono' }, v.name), v.builtin ? V.chip('內建') : null, v.disabled ? V.chip('停用', 'warn') : null]), s: (v) => v.name },
          { t: '設定的介面', f: (v) => h('span', { class: 'mono' }, v.interfaces.join(' ') || '—') },
          { t: '成員', f: (v) => (v.members.length ? h('span', null, v.members.flatMap((ep, n) => [n ? '、' : '', epLink(App, ep)])) : '—'), s: (v) => v.members.length },
          { t: '來源', f: src },
        ] }),
      tab('rules', { rowKey: (r) => String(r.order),
        extra: [h('p', { class: 'muted' }, '依設定順序；只有 main 的封包會依序比對。判斷封包查哪一張表的是路由追蹤與可達性查詢，這裡只列設定。')],
        columns: [
          { t: '順序', f: (r) => String(r.order), s: (r) => r.order },
          { t: '條件', f: (r) => h('span', { class: 'mono' }, Object.entries(r.match).map(([k, v]) => `${k}=${v}`).join(' ') || '（沒有條件）'), cls: 'wrap' },
          { t: '動作', f: (r) => h('span', { class: 'mono' }, r.action + (r.table ? ' ' + r.table : '')) },
          { t: '狀態', f: (r) => (r.disabled ? V.chip('停用', 'warn') : '啟用') },
          { t: '備註', f: (r) => r.comment || '', cls: 'wrap' },
          { t: '來源', f: src },
        ] }),
      tab('tables', { rowKey: (t) => t.name,
        extra: [h('p', { class: 'muted' }, '/routing table 與 VRF 自動產生的表。')],
        columns: [
          { t: '路由表', f: (t) => h('span', { class: 'mono' }, t.name), s: (t) => t.name },
          { t: '用途', f: (t) => (t.vrf ? V.vrfText(t.vrf) : h('span', null, ['只用於策略路由 ', V.chip('不是 VRF', 'info', { title: POLICY_TIP })])), s: (t) => t.vrf || '' },
          { t: 'fib', f: (t) => (t.fib ? '是' : '否') },
          { t: '狀態', f: (t) => (t.disabled ? V.chip('停用', 'warn') : '啟用') },
          { t: '路由', f: (t) => V.num(Q.routesInTable(dev, t.name).length), s: (t) => Q.routesInTable(dev, t.name).length, cls: 'num' },
          { t: '來源', f: src },
        ] }),
      tab('ospf', { rowKey: byIndex(r0.ospf),
        extra: [h('p', { class: 'muted' }, 'OSPF 鄰接是 L3 的路由鄰接，不代表實體直連，也不畫成拓樸的鏈路。')],
        columns: [
          { t: '本機介面', f: (a) => epLink(App, a.localEp), s: (a) => K.splitEp(a.localEp)[1] },
          { t: '鄰居', f: (a) => devLink(App, a.peerDev), s: (a) => Q.devName(a.peerDev) },
          { t: '鄰居位址／路由器 ID', f: (a) => [a.peerIp, a.peerId].filter(Boolean).join('／'), s: (a) => a.peerIp || a.peerId },
          { t: '回報', f: (a) => (a.reciprocal ? '雙向 OSPF 鄰接' : '單向 OSPF 觀察'), s: (a) => (a.reciprocal ? '雙向' : '單向') },
          { t: '來源', f: src },
        ] }),
    ].filter((t) => t.rows.length);
  }
  /** 下一跳的擁有者（Q.hopOwner，規則同 R01 與路由追蹤）：介面或設備的管理 IP；跨 VRF 的推論標「推論」 */
  function ownerCell(App, r, n) {
    const Q = App.Q; const { epLink, devLink } = P();
    if (!n.ip) return null;
    const o = Q.hopOwner(r.dev, n.ip, n.vrf);
    if (!o) return h('span', { class: 'muted route-owner' }, '基準中沒有設備擁有這個位址');
    return h('span', { class: 'route-owner' }, [o.key.endsWith('|') ? h('span', null, [devLink(App, o.dev), '（管理 IP）']) : epLink(App, o.key),
      multiVrf(Q) || o.crossVrf ? ` 在 ${V.vrfText(o.vrf)}` : null,
      o.crossVrf ? ' ' : null, o.crossVrf ? V.chip('推論', 'info', { title: '同名的 VRF 沒有這個位址：取這個直連網段上位址相同的唯一介面（例如 CE 在 main、PE 在另一個 VRF）' }) : null]);
  }
  /** 出介面（只寫介面、沒有閘道時）：基準有這個介面時是連結 */
  function ifcCell(App, r, n) {
    if (!n.ifc) return null;
    const ep = K.ep(r.dev, n.ifc);
    return App.Q.getInterface(ep) ? P().epLink(App, ep) : h('span', { class: 'mono' }, n.ifc);
  }
  /** 追蹤的來源：這台設備在路由所在 VRF 的位址（管理 IP 在其中時用它，否則第一個）；沒有時是管理 IP 或空白（表單裡再填） */
  function traceSrc(Q, r) {
    const d = Q.getDevice(r.dev); const ips = Q.subnetsOf(r.dev, r.vrf || K.MAIN_VRF).map((s) => s.ip).filter(Boolean);
    return d && d.mgmtIp && ips.includes(d.mgmtIp) ? d.mgmtIp : ips[0] || (d && d.mgmtIp) || '';
  }
  /** 右欄：一條路由的屬性、下一跳（解析的 VRF、擁有者）、原文與追蹤 */
  function routeDetail(App, r) {
    const Q = App.Q; const { section, kv } = P(); const dev = r.dev;
    const nhs = r.nh.map((n, i) => h('div', { class: 'route-hop', 'data-hop': String(i) }, kv([
      ['閘道', n.ip ? h('span', { class: 'mono' }, nhText(r, n).trim()) : null],
      ['出介面', ifcCell(App, r, n)],
      ['解析的 VRF', h('span', null, [V.vrfText(n.vrf), h('span', { class: 'muted' }, `（${V.NH_VRF_BASIS[n.vrfBasis] || n.vrfBasis || '依據不明'}）`)])],
      ['擁有者', ownerCell(App, r, n)],
    ])));
    // 追蹤：路由追蹤表單在拓樸圖的工具列，在強制回應視窗的遮罩底下，先關視窗（選取回到設備）再開表單
    const trace = () => {
      const d = dialog(); if (d) d.close({ user: true, focus: false });
      App.openTrace(traceSrc(Q, r), r.len > 0 ? r.prefix : '', r.vrf || '');
    };
    return h('div', { class: 'detail route-detail', 'data-route': keyOf(r) }, [
      h('h2', null, `${r.prefix}/${r.len}`),
      h('div', { class: 'row' }, [r.active === false ? V.chip('非作用中', 'route-inactive', { title: INACTIVE_TIP }) : V.chip('作用中', 'ok'),
        r.blackhole ? V.chip('黑洞路由', 'warn') : null, r.vrf == null ? V.chip('只用於策略路由', 'info', { title: POLICY_TIP }) : null]),
      section('路由', kv([
        ['設備', P().devLink(App, dev)],
        ['路由表', h('span', { class: 'mono' }, r.routingTable || K.MAIN_VRF)],
        ['VRF', r.vrf == null ? '—（只用於策略路由）' : V.vrfText(r.vrf)],
        ['協定', routeProto(r)], ['距離', r.distance == null ? null : String(r.distance)],
        ['check-gateway', r.checkGateway], ['原文', V.srcLink(App, r.src)]])),
      section('下一跳', nhs.length ? nhs : h('p', { class: 'muted' }, r.blackhole ? '黑洞路由：封包在這台設備丟棄，沒有下一跳。' : '沒有下一跳的資料。'), { count: nhs.length }),
      h('div', { class: 'row spaced' }, h('button', { type: 'button', class: 'route-trace', onclick: trace,
        title: r.len > 0 ? `從 ${Q.devName(dev)} 追蹤到 ${r.prefix}（網段的位址）` : '預設路由：目的在路由追蹤的表單裡填' }, '從這台追蹤到這個網段')),
    ]);
  }
  /** 沒有選路由時的右欄：怎麼用，與每個分頁的筆數（同分頁與右欄摘要，取自 routing()） */
  function overview(App, dev) {
    const Q = App.Q; const routes = Q.allRoutesOf(dev); const r0 = routing(Q, dev);
    return h('div', { class: 'detail routes-overview' }, [
      h('h2', null, '這台設備的路由表'),
      missingNote(),
      routes.length ? h('p', { class: 'muted routes-pick-hint' }, '點「路由」分頁的一條路由，這裡改為顯示它的屬性、每個下一跳解析的 VRF 與擁有者、原文，以及從這台追蹤到那個網段。') : null,
      P().section('路由表', P().kv([['路由', V.num(routes.length)], ['非作用中', V.num(routes.filter((r) => r.active === false).length)],
        ...EXTRA_TABS.filter((t) => r0[t.key].length).map((t) => [t.summary, `${V.num(r0[t.key].length)} ${t.unit}`])])),
    ]);
  }

  // ---------------------------------------------------------------- 視窗與選取
  const isSel = (sel) => !!sel && sel.type === 'routes';
  /**
   * 開啟或更新視窗（details.render 經 V.tableDialog.follow 呼叫）：同一份基準、同一台設備的視窗開著時只換選取（左欄不重畫）；
   * 帶了搜尋字或組（右欄的入口）時重開，套用它們（同一個選取只是重畫時不重開）；從其他地方定位到某條路由（sel.route）時展開那一組並捲到那一列（initial）。
   */
  function show(App, sel) {
    const dev = sel.dev; const key = sel.route == null ? null : sel.route; rt.want = key;
    const d = dialog();
    if (d && d.id === DIALOG + dev && rt.Q === App.Q && (sel === rt.sel || (sel.search == null && sel.group == null && sel.tab == null))) {
      const now = d.selected();
      if (!rt.inner && now.key !== key) d.select('routes', key, { reveal: true, focus: true }); else d.refresh();
      return;
    }
    rt.Q = App.Q; rt.sel = sel;
    const Q = App.Q; const has = !!Q.getDevice(dev); const r0 = routing(Q, dev);
    // 分頁：路由、VRF、/routing rule、路由表、OSPF 鄰接，沒有資料的不列；全部都沒有時仍列「路由」（說明沒有路由）
    const routeTab = routesTab(App, dev);
    const tabs = (routeTab.rows.length ? [routeTab] : []).concat(extraTabs(App, dev, r0));
    V.tableDialog.open({
      id: DIALOG + dev, title: `${has ? Q.devLabel(dev) : dev} 的路由表`,
      head: () => {
        const n = Q.allRoutesOf(dev).filter((r) => r.active === false).length;
        return h('div', { class: 'routes-head' }, [n ? h('div', { class: 'row routes-status-row' }, V.stateChip(n, '條非作用中')) : null, r0.policy ? policyHead(r0) : null]);
      },
      tabs: tabs.length ? tabs : [routeTab],
      detail: (row) => routeDetail(App, row),
      empty: () => (has ? overview(App, dev) : h('div', { class: 'detail routes-overview' }, [h('h2', null, '基準中沒有這台設備'), missingNote()])),
      initial: { tab: sel.tab || 'routes', row: key, group: sel.group, search: sel.search },
      // 視窗裡選了一列：同步 App.sel（圖上的標示）；取消選取時回到這台設備的路由表
      onSelect: (rowKey) => {
        rt.inner = true;
        try { App.select(openSel(dev, rowKey == null ? null : { route: rowKey })); } finally { rt.inner = false; }
      },
      // 使用者關閉：選取回到那台設備（refresh：右欄已經是它的詳情，只重新標示圖，開啟視窗的入口留在原處）
      onClose: () => App.select(detailSel(App, sel), { refresh: true }),
      fallbackFocus: () => V.$('#detail').querySelector('.routes-open') || V.$('#detail'),
    });
  }
  const detailSel = (App, sel) => ({ type: 'device', key: sel.dev });
  V.tableDialog.owner({ idOf: (App, sel) => (isSel(sel) ? DIALOG + sel.dev : null), show, detailSel });

  V.routes = { summary, nhCell, keyOf, isSel };
})(globalThis.SSOT = globalThis.SSOT || {});
