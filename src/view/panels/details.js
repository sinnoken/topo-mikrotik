/*
 * 右側：選中項目的詳細資料。所有內容都從查詢介面（Q）取得，並附上來源（可開啟原文）。
 * 支援：device、link、pair（同兩台設備間多條鏈路）、interface、mac、ip、vlan、subnet（L3 子網圖）、boundary（L3 的外部：對外邊界的依據）、trace、route，
 * 以及防火牆（firewall／rule／service，畫面在 panels/firewall.js）
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const K = S.keys; const LINK_SCOPE = S.LINK_SCOPE;

  function render(App, sel) {
    const root = V.clear(V.$('#detail'));
    if (!App.Q) return root.appendChild(h('div', { class: 'empty-detail' }, [h('div', { class: 'big' }, '尚未建立基準'), '建立後，點選圖上的設備或鏈路，詳細資料會顯示在這裡。']));
    if (!sel) return root.appendChild(overview(App));
    const fw = (a, s) => V.firewall.render(a, s);
    const fn = { device, link, pair, interface: iface, endpoints, mac, ip, vlan, subnet, boundary, trace, firewall: fw, rule: fw, service: fw }[sel.type];
    root.appendChild(fn ? fn(App, sel) : h('div', { class: 'empty-detail' }, '無法顯示'));
    root.scrollTop = 0;
    // 定位到某一列時（例如防火牆規則），把它捲到畫面中間；否則捲到從檢查結果選來的那一筆
    const focus = root.querySelector('.focus') || root.querySelector('.current'); if (focus) focus.scrollIntoView({ block: 'center' });
  }

  // ---------------------------------------------------------------- 共用片段
  const L = (App, text, sel) => h('a', { class: 'link', onclick: () => App.select(sel, { focus: true }) }, text);
  const devLink = (App, k) => L(App, App.Q.devLabel(k), { type: 'device', key: k });
  const epLink = (App, ep) => L(App, App.Q.epName(ep), { type: 'interface', key: ep });
  const macLink = (App, m) => L(App, K.macPretty(m), { type: 'mac', key: m });
  /** IP 的連結：vrf 省略時不分 VRF（詳情列出所有 VRF 的結果，在多個 VRF 時請使用者選擇） */
  const ipLink = (App, ip, vrf) => L(App, ip, V.ipSel(ip, vrf === undefined ? null : vrf));
  /** 基準有兩個以上的 VRF：只用 main 的網路不顯示 VRF 欄位，畫面與加入 VRF 之前相同 */
  const multiVrf = (Q) => Q.vrfs().length > 1;
  const srcLink = V.srcLink;
  /** 下一跳的文字：閘道在路由所在的 VRF 以外解析（路由洩漏、VRF 介面）時以 RouterOS 的寫法標出 @VRF；依據在 title */
  const nhText = (r, n) => {
    const own = r.vrf || K.MAIN_VRF; const other = n.vrf && n.vrf !== own;
    return (n.ip ? n.ip + (other ? '@' + n.vrf : '') + ' ' : '') + (n.ifc || '') + (!n.ip && other ? `（VRF ${n.vrf}）` : '');
  };
  /** 下一跳的儲存格；multi（基準有多個 VRF）時 title 寫出每個閘道在哪個 VRF 解析與依據 */
  const nhCell = (r, multi) => h('span', { class: 'mono', title: multi ? r.nh.map((n) => `${n.ip || n.ifc || ''}：在 ${V.vrfText(n.vrf)} 解析（${V.NH_VRF_BASIS[n.vrfBasis] || n.vrfBasis || ''}）`).join('\n') : null }, r.nh.map((n) => nhText(r, n)).join('\n'));
  /** 路由的協定（黑洞路由另成一類）與下一跳的文字：路由表摘要的分組與搜尋共用 */
  const routeProto = (r) => (r.blackhole ? '黑洞路由' : r.proto || '（協定不明）');
  const routeNh = (r) => r.nh.map((n) => nhText(r, n).trim()).filter(Boolean).join('、');
  /** 路由表搜尋的文字：網段、路由表、協定、下一跳 */
  const routeText = (r) => [`${r.prefix}/${r.len}`, r.routingTable || K.MAIN_VRF, routeProto(r), routeNh(r)].join(' ');
  /**
   * 路由表的摘要：依路由表（showTable 時）、協定與下一跳分組，依路由表（main 在前）、協定、筆數多到少排列。
   * 非作用中的路由數寫在組的標題列（V.stateChip）。
   */
  function routeGroups(routes, showTable) {
    const by = new Map();
    routes.forEach((r) => {
      const table = r.routingTable || K.MAIN_VRF; const proto = routeProto(r); const nh = routeNh(r);
      S.util.getOr(by, [table, proto, nh].join('\u0000'), () => ({ table, proto, nh, rows: [] })).rows.push(r);
    });
    const main = (t) => (t === K.MAIN_VRF ? 0 : 1);
    return Array.from(by.entries()).sort(([, a], [, b]) => main(a.table) - main(b.table) || S.util.natural(a.table, b.table)
      || S.util.natural(a.proto, b.proto) || b.rows.length - a.rows.length || S.util.natural(a.nh, b.nh))
      .map(([key, g]) => ({ key, rows: g.rows,
        title: h('span', null, [showTable ? h('span', { class: 'mono' }, g.table) : null, showTable ? '・' : null, g.proto, '・下一跳 ', h('span', { class: 'mono' }, g.nh || '—')]),
        extra: [V.stateChip(g.rows.filter((r) => r.active === false).length, '條非作用中')] }));
  }
  /** /routing rule 的文字：第幾條、條件、action 與路由表 */
  const routingRuleText = (r) => `/routing rule 第 ${r.order} 條：${Object.entries(r.match).map(([k, v]) => `${k}=${v}`).join(' ') || '（沒有條件）'} action=${r.action}${r.table ? ' table=' + r.table : ''}${r.comment ? `（${r.comment}）` : ''}`;
  const kv = (pairs) => h('div', { class: 'kv' }, pairs.filter((p) => p && p[1] !== null && p[1] !== undefined && p[1] !== '').flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', null, v)]));
  // 詳情區塊的唯一產生方式是 V.section（dom.js；規則寫在那裡）：第一層（檢查結果、屬性）是一般區塊，其餘主題一律是展開列
  const section = V.section;
  /** 一組檢查結果有錯誤或警告：主題區塊預設展開的依據 */
  const problem = V.hasProblem;
  /** 「N 條有問題」：這些檢查結果中有錯誤或警告的實體數；語氣色依最嚴重的 */
  const problemChip = (App, type, keys, unit) => {
    const fl = keys.map((k) => App.Q.findingsFor(type, k).filter((f) => f.severity !== 'info'));
    return V.stateChip(fl.filter((x) => x.length).length, unit + '有問題', V.worstSev([].concat(...fl)));
  };
  /** 說明段落（圖例、名詞解釋）：每次選取都一樣，收進預設收合的「這是什麼？」，不佔詳細資料的首屏 */
  const aboutSection = (paras) => section('這是什麼？', paras.filter(Boolean).map((t) => h('p', { class: 'muted' }, t)), { fold: true });
  const vlanText = (ids) => (ids && ids.length ? S.util.fmtVlans(ids) : '—');
  // 右欄表格：V.table 已包可橫向捲動的 .table-scroll，識別字不逐字斷行
  const table = V.table;

  /*
   * 每個詳情頁的區塊順序一致：
   *   標題 → 標籤 → 檢查結果 → 屬性 → 說明 → 主題區塊（同一主題先事實、後推論，例如鏈路 → 推論鏈路）→ 來源
   * 檢查結果放在屬性之前：選取物件多半是為了看它的問題。
   * 例外是設備：先列身分（管理 IP、型號、版本、收集的資料），再列檢查結果的前 3 筆，否則核心設備的身分會被推到首屏外。
   * 推論的區塊一律用 inferredSection 等共用元件，標題與說明只寫一次。
   * 主題區塊一律是展開列（不依筆數切換）：有錯誤／警告、收集失敗或目前定位的列時預設展開，其餘收合；列表沒有資料時整個不顯示。
   * 同種資料同一種呈現：鏈路一律表格（linkTable），只有名稱的設備清單一律 chip-list（devChips）。
   * 跳到其他畫面或改變範圍的連結放在標題列（section 的 extra）。
   */
  /** 只有名稱的設備清單：chip-list，每台是設備連結 */
  const devChips = (App, keys) => h('div', { class: 'chip-list dev-chips' }, keys.map((k) => h('span', { class: 'chip dev-chip' }, devLink(App, k))));
  /**
   * 鏈路表格（介面、VLAN 的鏈路共用；設備的鄰居、設備對的鏈路是同一種欄位）：兩端、類別、VLAN，點一列選取鏈路，有問題的列標 bad。
   * from：從這一端看（介面）時，第一欄是本端；more：接在後面的欄（例如 VLAN 的原因）
   */
  function linkTable(App, links, from, more) {
    const Q = App.Q; const dom = (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN;
    const ends = (l) => (from && l.b === from ? [l.b, l.a] : [l.a, l.b]);
    const end = (ep) => h('span', null, [Q.devLabel(K.splitEp(ep)[0]), h('span', { class: 'mono muted' }, ' ' + ifName(Q, ep))]);
    return table([
      { t: from ? '本端' : 'A 端', f: (l) => (dom(l) ? Q.devLabel(K.splitEp(ends(l)[0])[0]) : end(ends(l)[0])), s: (l) => Q.epName(ends(l)[0]) },
      { t: '類別', f: (l) => V.linkClassText(l, { proto: true }), cls: 'nowrap' },
      { t: from ? '對端' : 'B 端', f: (l) => (dom(l) ? Q.devLabel(K.splitEp(ends(l)[1])[0]) : end(ends(l)[1])), s: (l) => Q.epName(ends(l)[1]) },
      { t: 'VLAN', f: (l) => (dom(l) ? '—' : l.vlanMismatch ? h('span', { class: 'diffA' }, '不一致') : h('span', { class: 'vlanlist' }, vlanText(l.vlansCommon))) },
      ...(more || []),
    ], links, { limit: 300, onRow: (l) => App.select({ type: 'link', key: l.key }, { focus: true }), bad: (l) => l.vlanMismatch || problem(Q.findingsFor('link', l.key)) });
  }
  /** kv 中的推定值：值後面加「推論」chip，和同一張表裡收集到的事實區分 */
  const inferred = (value, tip) => h('span', null, [value, ' ', V.inferChip(tip)]);
  /** 推論鏈路區塊：說明推論的意義，列出兩端、依據與信心 */
  /** main：整頁就是這個主題（設備對頁）時用一般區塊；其他頁是附屬清單（展開列） */
  function inferredSection(App, list, from, main) {
    return section('推論鏈路（沒有 LLDP）', list.length ? [h('p', { class: 'muted' }, '依 MAC 表、MNDP、RSTP 或點對點網段推定相鄰：是直接相連，或中間只有非網管型設備。不影響任何檢查。'),
      inferredTable(App, list, from)] : null, { count: list.length, fold: !main });
  }
  function findingsBlock(App, list, opt) {
    if (!list.length) return null;
    const shown = (opt && opt.shown) || FINDINGS_SHOWN;
    const seen = new Set(); const uniq = list.filter((f) => (seen.has(f) ? false : seen.add(f)));
    const order = { error: 0, warn: 1, info: 2 };
    // 從檢查結果選來的（App.selectFinding 在選取加上 finding 鍵）：那一筆排第一、標「目前選取」（.current；沒有定位的列 .focus 時 render 捲到它）
    const curKey = App.sel && App.sel.finding; const isCur = (f) => !!curKey && App.Q.findingKey(f) === curKey;
    uniq.sort((a, b) => (isCur(b) - isCur(a)) || order[a.severity] - order[b.severity]);
    const item = (f) => h('div', { class: isCur(f) ? 'finding current' : 'finding', 'aria-current': isCur(f) ? 'true' : null }, [
      V.sevDot(f.severity),
      h('div', null, [h('div', null, [h('b', null, f.title), ...facetChip(f), isCur(f) ? ' ' : null, isCur(f) ? V.chip('目前選取', 'info') : null]), h('div', null, f.message),
        relatedLine(App, f), V.deviationLine(App, f.deviation), ledgerLine(f), mgmtGoto(App, f), V.remediation.hintLine(f.id), adviceBlock(f.id),
        f.evidence.length ? h('div', { class: f.id === 'C02' ? 'ev stack' : 'ev' }, evidenceLinks(App, f)) : null]),
    ]);
    // 先顯示最嚴重的幾筆，其餘收進同一個 section() 展開機制，避免檢查結果把屬性推到很下面
    const rest = uniq.slice(shown);
    const el = section('檢查結果', [...uniq.slice(0, shown).map(item),
      rest.length ? section(`再顯示 ${rest.length} 筆`, rest.map(item), { fold: true }) : null], { count: uniq.length });
    el.classList.add('findings-section');
    return el;
  }
  const FINDINGS_SHOWN = 5; const DEVICE_FINDINGS_SHOWN = 3;
  /** 比對對象（finding.facet，V.remediation.facetText）：標題旁的標籤（回傳子節點陣列，展開放入標題列），title 是原值；沒有 facet 時為空陣列 */
  function facetChip(f) {
    const t = V.remediation.facetText(f);
    return t ? [' ', V.chip('比對對象：' + t, 'facet', { title: '原值：' + f.facet })] : [];
  }
  /**
   * 檢查結果有兩個以上實體時（例如 R10、R13 的兩台設備、R08 的設備＋介面、R09 的設備＋規則）列出「相關：」連結：
   * 選取這筆時詳情只開第一個實體（App.selectFinding），其餘的從這裡開啟。只列設備、介面、鏈路、規則與服務，
   * 超過 RELATED_SHOWN 個時其餘寫「等 N 個」（完整的實體在圖上一起標出）。
   */
  const RELATED_SHOWN = 6;
  function relatedLine(App, f) {
    const Q = App.Q;
    // 基準中沒有那個物件時（例如只出現在 /ip dhcp-client 的介面）寫成一般文字並註明，不做成點了沒反應的連結；
    // 說法依物件種類寫具體（例如介面：基準中沒有它的介面資料，常見是只出現在 /ip dhcp-client 等設定）
    const MISSING = { device: '基準中沒有這台設備的資料', interface: '基準中沒有這個介面的介面資料', link: '基準中沒有這條鏈路', rule: '基準中沒有這條規則' };
    const MISSING_TIP = { interface: '介面清單（/interface）沒有這個介面，它只出現在其他設定（例如 /ip dhcp-client、路由或 NAT 的介面欄位）' };
    const missing = (t, type) => h('span', { class: 'related-missing', title: MISSING_TIP[type] || MISSING[type] }, `${t}（${MISSING[type]}）`);
    const link = (e) => {
      const [dk, rest] = e.type === 'device' ? [e.key, ''] : K.splitEp(e.key);
      if (e.type === 'device') return Q.getDevice(e.key) ? devLink(App, e.key) : missing(e.key, 'device');
      if (e.type === 'interface') return Q.getInterface(e.key) ? epLink(App, e.key) : missing(`${Q.devName(dk)} ${rest}`, 'interface');
      if (e.type === 'link') { const l = Q.getLink(e.key); return l ? L(App, `${Q.epName(l.a)} ⇄ ${Q.epName(l.b)}`, { type: 'link', key: l.key }) : missing(e.key, 'link'); }
      if (e.type === 'rule') return Q.getFirewallRule(e.key) ? L(App, `${Q.devName(dk)} ${V.firewall.ruleLabel(App, e.key)}`, { type: 'rule', key: e.key }) : missing(`${Q.devName(dk)} 的防火牆規則`, 'rule');
      if (e.type === 'service') return L(App, `${Q.devName(dk)} 服務 ${rest}`, { type: 'service', key: e.key });
      return null;
    };
    if (f.entities.length < 2) return null;
    const links = f.entities.map(link).filter(Boolean);
    if (links.length < 2) return null;
    const shown = links.slice(0, RELATED_SHOWN);
    return h('div', { class: 'muted finding-related' }, ['相關：', ...shown.flatMap((a, n) => (n ? ['、', a] : [a])),
      links.length > shown.length ? `等 ${V.num(links.length)} 個` : null]);
  }
  /** 處理紀錄的狀態與備註（使用者的決定，不在基準裡，見 app-ledger.js）；待處理（open）且沒有備註時不顯示 */
  function ledgerLine(f) {
    const it = V.app && V.app.ledgerItem ? V.app.ledgerItem(f) : null;
    if (!it || (it.status === 'open' && !it.note)) return null;
    const R = V.remediation;
    return h('div', { class: 'muted ack-line ledger-line' }, [V.chip(R.statusText(it.status), R.STATUS_CHIP[it.status]), ' ',
      it.waiver ? `豁免原因：${it.waiver.reason || '（未填）'}，到期 ${V.fmtUtc(it.waiver.until)}` : '',
      it.note ? (it.waiver ? '；' : '') + '備註：' + it.note : '']);
  }
  /**
   * 檢查的常見原因與處理（V.remediation.advice，文字來自 CATALOG）：預設收合的展開列，檢查結果與檢查清單共用。
   * 反引號內的指令與欄位以 <code> 顯示（V.codeText，不用 innerHTML）。兩個欄位都沒有時不顯示。
   * opt.open：預設展開；opt.ontoggle：展開狀態改變時呼叫（呼叫端要跨重繪保留時用）。
   */
  function adviceBlock(id, opt) {
    const a = V.remediation.advice(id); const o = opt || {};
    if (!a.action && !a.causes.length) return null;
    const el = h('details', { class: 'advice', 'data-rule-id': id, open: !!o.open }, [
      h('summary', null, a.action && a.causes.length ? '常見原因與處理' : a.action ? '處理建議' : '常見原因'),
      h('div', { class: 'advice-body' }, [
        a.action ? h('div', { class: 'advice-action' }, [h('span', { class: 'advice-label' }, '處理：'), ...V.codeText(a.action)]) : null,
        a.causes.length ? h('div', { class: 'advice-causes' }, [h('span', { class: 'advice-label' }, '常見原因：'),
          h('ul', null, a.causes.map((c) => h('li', null, V.codeText(c))))]) : null,
      ]),
    ]);
    if (o.ontoggle) el.addEventListener('toggle', () => o.ontoggle(!!el.open));
    return el;
  }
  /*
   * C02 的證據是該設備的各區塊（收集失敗的註解與已收集的區塊）而非缺少的資料，標示指令以免誤解；
   * 要能對照收了哪些指令，所以不截短、全部逐行列出（核心對 C02 不限證據筆數）。
   * 失敗註解那一行標「收集失敗」，其餘標「已收集」。其他檢查維持「原文 第 N 行」最多 3 筆。
   */
  /** 一筆檢查結果的各處證據（App.openRaw 的 opt.list）：原文對話框可在這些位置之間前後切換 */
  const evidenceNav = (f) => f.evidence.map((e) => ({ file: e.file, line: e.line }));
  function evidenceLinks(App, f) {
    const list = evidenceNav(f);
    const link = (e, label, attrs) => h('a', Object.assign({ class: 'link mono', onclick: () => App.openRaw(e.file, e.line, { list }) }, attrs || {}), label);
    if (f.id !== 'C02') {
      // 合併成一行「原文：第 1733、3306、1915 行」：每個行號各自可點（一般字型），對話框可在全部證據間前後切換
      const shown = f.evidence.slice(0, 3);
      const nums = shown.map((e) => h('span', null, link(e, String(e.line), { class: 'link ev-line', 'aria-label': `原文 第 ${e.line} 行`, title: `開啟原文第 ${e.line} 行` })));
      return [h('span', { class: 'ev-raw' }, ['原文：第 ', ...nums.flatMap((a, n) => (n ? ['、', a] : [a])), ' 行',
        f.evidence.length > shown.length ? `（共 ${V.num(f.evidence.length)} 處，可在原文中切換）` : ''])];
    }
    return f.evidence.map((e) => {
      const blk = App.Q.block(e.block);
      const failed = blk && blk.failure && blk.failure.line === e.line;
      const what = failed ? `收集失敗（${V.failureText(blk.failure)}）` : '已收集';
      return link(e, blk && blk.command ? `${what}：${blk.command}（第 ${e.line} 行）` : `${what}：第 ${e.line} 行`);
    });
  }
  function sourcesBlock(App, src, title) {
    if (!src || !src.length) return null;
    // 「設備 › 指令・第 N 行」（V.blockWhere，與原文對話框標題同一寫法）；原文對話框可在各來源之間前後切換
    const list = src.map(([b, line]) => ({ file: App.Q.block(b).file, line }));
    return section(title || '來源', src.map(([b, line]) => {
      const blk = App.Q.block(b);
      // 一般字型：指令與設備名是說明文字，等寬字會讓整行折成好幾段
      return h('div', null, h('a', { class: 'link', onclick: () => App.openRaw(blk.file, line, { list }) }, `${V.blockWhere(App.Q, blk)}・第 ${line} 行`));
    }), { count: src.length, fold: true });
  }

  // ---------------------------------------------------------------- 基準狀態卡（未選取時）
  /*
   * 每個數字只出現一次：錯誤／警告在狀態句、缺資料台數在收集完整度、已收集台數在數字卡；技術細節（指紋、基準鍵、
   * 解析器使用量等）預設收合。錯誤／警告只算待處理的（處理紀錄，V.app.problemCounts），已處理的另註筆數。
   */
  const SEV_ORDER = { error: 0, warn: 1 };
  /** 建議先看的 finding 索引：待處理的錯誤與警告中，嚴重度最高、檢查順序（S.query.rules）最前、再取 Snapshot 順序最前；沒有時 -1 */
  function firstProblem(App) {
    const A = V.app; const rank = new Map(S.query.rules().map((r, n) => [r.id, n]));
    const r = (id) => (rank.has(id) ? rank.get(id) : Infinity);
    let best = -1; let bf = null;
    App.Q.findings().forEach((f, i) => {
      if (!(f.severity in SEV_ORDER) || !A.isPending(f)) return;
      if (best < 0 || SEV_ORDER[f.severity] < SEV_ORDER[bf.severity] || (f.severity === bf.severity && r(f.id) < r(bf.id))) { best = i; bf = f; }
    });
    return best;
  }
  /** 有對應物件時選取它；沒有（例如無法辨識的輸入區塊）就直接開原文，避免點了沒反應 */
  function suggestLink(App, idx) {
    const f = App.Q.finding(idx); const e = f.evidence[0];
    const go = () => (!f.entities.length && e ? App.openRaw(e.file, e.line, { list: evidenceNav(f) }) : App.selectFinding(idx));
    return h('a', { class: 'link status-suggest', title: f.message, onclick: go }, f.title);
  }
  function overview(App) {
    const Q = App.Q; const T = V.TERMS; const m = Q.meta(); const st = m.stats; const C = Q.inventory().counts;
    const cs = Q.coverageSummary(); const vs = Q.vlanSummary(); const A = V.app; const pc = A.problemCounts();
    const problems = pc.total; const first = firstProblem(App);
    const counts = [pc.error ? `${V.num(pc.error)} 項錯誤` : null, pc.warn ? `${V.num(pc.warn)} 項警告` : null].filter(Boolean).join('、');
    // 錯誤／警告數連到「研判」只列錯誤與警告；建議先看連到那一筆
    const status = h('p', { class: 'status-line' }, [
      V.sevDot(pc.error ? 'error' : pc.warn ? 'warn' : 'info'),
      h('span', null, [
        problems ? h('span', null, ['待處理：', h('a', { class: 'link status-problems', title: `在「${A.STEP_LABEL.triage}」步驟只列錯誤與警告`,
          onclick: () => { V.lists.findings.showProblems(App); App.showStep('triage'); } }, counts)]) : '目前的檢查未發現待處理的錯誤或警告',
        pc.handled ? h('span', { class: 'muted' }, `（另有 ${V.num(pc.handled)} 項已處理）`) : null,
        first >= 0 ? h('span', null, ['。建議先看：', suggestLink(App, first)]) : null,
      ]),
    ]);
    // 處理紀錄的提示（復發、因收集失敗而無法判斷、接受風險到期）：點一下到「驗證」的本輪變化
    const alerts = [['regressed', 'err', '復發', '已修好的問題又出現（依處理紀錄）'],
      ['unobserved', 'warn', '無法判斷', '本輪消失的待處理項目，所屬設備有收集失敗或沒有收集，因收集失敗而無法判斷是否已修好'],
      ['waiverExpired', 'warn', '接受風險到期', '「接受風險」已到期，改回待處理']].filter(([k]) => pc[k]);
    const alertRow = alerts.length ? h('div', { class: 'row status-alerts' }, alerts.map(([k, cls, label, title]) =>
      V.chipButton(`${label} ${V.num(pc[k])} 項`, 'btn ' + cls + ' ledger-alert', { 'data-alert': k, title: `${title}；在「${A.STEP_LABEL.verify}」的本輪變化`, onclick: () => App.showStep('verify', { focus: 'round' }) }))) : null;
    // 覆蓋率只寫缺漏的台數（已收集／應收集在數字卡），和資料中心同一句（V.coverageGapText）；
    // 缺資料可點：在資料中心的覆蓋率只列有缺漏的設備
    const [gapMissing, gapUnc] = V.coverageGapParts(cs);
    const coverage = h('p', { class: 'status-coverage' }, ['覆蓋率：'].concat(gapMissing || gapUnc ? [
      gapMissing ? h('a', { class: 'link', title: `${V.COVERAGE_GAP_TIP.missing}；在資料中心的覆蓋率只列有缺漏的設備`, onclick: () => { V.lists.coverage.showMissing(App); App.openHub('coverage'); } }, gapMissing) : null,
      gapMissing && gapUnc ? '、' : null,
      gapUnc ? h('span', { title: V.COVERAGE_GAP_TIP.uncollected }, gapUnc) : null,
    ] : [V.coverageGapText(cs)]));
    const hostNote = cs.hosts ? h('p', { class: 'status-hosts muted', title: V.HOST_DEF }, V.hostsText(cs.hosts)) : null;
    const stat = (label, value) => h('div', { class: 'stat' }, [h('div', { class: 'stat-num' }, value), h('div', { class: 'stat-label' }, label)]);
    const meta = [`建立 ${V.fmtTime(m.createdAt)}`, `命名規則 ${m.profile ? `${m.profile.id} v${m.profile.version}` : '未套用'}`,
      // 全形括號開頭的名稱（貼上的內容）前不留空白
      ('來源 ' + m.sources.map((x) => V.fileName(x.name)).join('、')).replace(/^來源 （/, '來源（')].join('・');
    return h('div', { class: 'detail status-card' }, [
      h('h2', null, '基準狀態'),
      status, alertRow, coverage, hostNote,
      h('div', { class: 'stat-grid' }, [
        stat(`已收集${T.network}`, `${V.num(cs.networkCollected)}／${V.num(cs.network)}`), stat('鏈路', V.num(st.links)), stat('VLAN（相異 ID）', V.num(vs.ids)), stat('MAC', V.num(st.macs)),
      ]),
      h('p', { class: 'status-meta muted', title: m.sources.map((x) => `${V.fileName(x.name)}：${V.num(x.bytes)} 字元`).join('\n') }, meta),
      section('技術細節', [
        kv([['輸入指紋', h('span', { class: 'mono' }, m.inputHash)],
          // 基準鍵：輸入、程式版本、命名規則與預期資料的組合，處理紀錄以它判斷是不是同一輪（舊基準沒有）
          ['基準鍵', m.baselineKey ? h('span', { class: 'mono baseline-key', title: '處理紀錄以基準鍵判斷是不是同一輪：輸入、程式版本、命名規則或各類設備應收資料不同時就是新的一輪' }, m.baselineKey) : null],
          ['版本', m.version], ['介面', V.num(st.interfaces)], ['IP（ARP）', V.num(C.arpIps)], ['路由', V.num(st.routes)],
          [`${T.endpoint} MAC 位置（含 Wi-Fi 漫遊觀察）`, V.num(C.endpoints)],
          ['VLAN 定義（各設備合計）', V.num(vs.definitions)], [`不相連的 ${T.vlanDomain}`, inferred(V.num(vs.domains), '同一個 VLAN ID 依承載它的鏈路分出的不相連部分')]]),
        section('解析器使用量', table([{ t: '解析器', f: (r) => S.query.adapterLabel(r[0]) }, { t: '事實數', f: (r) => V.num(r[1]), cls: 'num' }], Object.entries(m.adapters)),
          { count: Object.keys(m.adapters).length, fold: true }),
      ], { fold: true }),
      h('p', { class: 'muted status-hint' }, '點選圖上的設備或鏈路、左側的檢查結果，或用上方搜尋（設備、MAC、IP、VLAN）。'),
    ]);
  }

  // ---------------------------------------------------------------- 未知對端（沒有 LLDP／CDP 介面鄰接的終端埠）
  function unknownTable(App, rows, bad) {
    return table([
      { t: '介面', f: (r) => h('span', { class: 'mono' }, r.name) },
      { t: 'MAC', f: (r) => (r.macs.length === 1 ? macLink(App, r.macs[0].mac) : `${r.macs.length} 個 MAC`) },
      { t: 'IP', f: (r) => h('span', { class: 'mono' }, S.util.uniq([].concat(...r.macs.map((m) => m.ips))).slice(0, 3).join(' ')) },
      { t: '廠商', f: (r) => S.util.uniq(r.macs.map((m) => m.vendor).filter(Boolean)).slice(0, 2).join(' / ') },
      { t: 'VLAN', f: (r) => h('span', { class: 'vlanlist' }, vlanText(r.vlans)) },
      { t: '描述', f: (r) => r.desc || '' },
    ], rows, { onRow: (r) => App.select({ type: 'interface', key: r.ep }, { focus: true }), limit: 300, bad: bad || ((r) => r.macs.length > 1) });
  }
  function endpoints(App, sel) {
    const Q = App.Q; const rows = Q.unknownPeers(sel.dev); const wifi = Q.inventory().rows.endpoints.filter((r) => r.dev === sel.dev && r.wifi).map((r) => ({
      ep: r.key, name: r.ifc, desc: r.desc, status: r.status, type: r.type, vlans: r.vlans, macs: [{ mac: r.mac, vendor: r.vendors[0] || null, ips: r.ips }],
    })); const d = Q.getDevice(sel.dev);
    if (!d) return h('div', { class: 'empty-detail' }, '基準中沒有這台設備');
    const macs = rows.reduce((n, r) => n + r.macs.length, 0); const multi = rows.filter((r) => r.macs.length > 1).length;
    const collapsed = App.virtual.has('?c|' + sel.dev);
    return h('div', { class: 'detail' }, [
      h('h2', null, [devLink(App, sel.dev), ' 的終端 MAC 位置']),
      h('div', { class: 'row' }, [V.chip(`${rows.length} 個終端埠`), V.chip(`${macs + wifi.length} 個終端 MAC 位置`),
        wifi.length ? V.chip(`${wifi.length} 個 Wi-Fi MAC 位置`, 'info') : null,
        multi ? V.chip(`${multi} 個終端埠有多個 MAC`, 'warn') : null,
        rows.length + wifi.length > 1 ? (collapsed || App.expanded.has(sel.dev)
          ? h('button', { onclick: () => App.toggleExpand(sel.dev) }, collapsed ? '在圖上展開' : '在圖上收合')
          : h('button', { disabled: true, title: '這台設備的終端都已逐一畫在圖上' }, '已顯示全部')) : null]),
      aboutSection(['一般終端埠只學到一個 MAC，且沒有 LLDP／CDP 介面鄰接。Wi-Fi 是一對多介面：每個觀察到的 MAC 位置會列入終端清單，但不把 Wi-Fi 介面判為終端，'
        + '也不參與「同一 MAC 出現在多個終端埠」的檢查，因為 MAC 可能隨使用者漫遊而移動。MNDP 只代表同一 L2 廣播網域可達，不算直連鄰接。']),
      // 點選 A03（未識別的終端）會來到這裡：列出這台設備的 A03，處理建議才看得到
      findingsBlock(App, Q.findingsFor('device', sel.dev).filter((f) => f.id === 'A03')),
      // 終端埠是這一頁的主體（一般區塊）；Wi-Fi 是附屬清單（展開列）
      section('終端埠', rows.length ? unknownTable(App, rows) : null, { count: rows.length }),
      section('Wi-Fi MAC 觀察（列入終端清單，不檢查重複 MAC）', wifi.length ? unknownTable(App, wifi, () => false) : null, { count: wifi.length, fold: true }),
    ]);
  }

  // ---------------------------------------------------------------- 設備
  function device(App, sel) {
    const Q = App.Q; const d = Q.getDevice(sel.key);
    if (!d) return h('div', { class: 'empty-detail' }, '基準中沒有這台設備');
    const links = Q.linksOf(d.key);
    const ospfAdjacencies = Q.ospfAdjacenciesOf(d.key);
    const cov = App.Q.coverageOf(d.key);
    const ifs = Q.interfacesOf(d.key).filter((i) => !i.hearsay || !d.collected);
    // 與多數不同（finding.deviation，推論）：這台設備列在 deviating 的檢查結果也放進來，即使實體不是它
    const dev = Q.deviationsOf(d.key).map(Q.finding);
    const fl = Q.findingsFor('device', d.key).concat(...links.map((l) => Q.findingsFor('link', l.key)), ...ifs.map((i) => Q.findingsFor('interface', i.key)), dev);
    const peerRows = Q.neighborRows(d.key).sort((x, y) => S.util.natural(x.mine, y.mine));
    const vlans = Q.vlansOf(d.key); const routes = Q.allRoutesOf(d.key); const unk = Q.unknownPeers(d.key);
    const inactive = routes.filter((r) => r.active === false).length;
    const showTable = multiVrf(Q) || routes.some((r) => (r.routingTable || K.MAIN_VRF) !== K.MAIN_VRF);
    const blocks = App.Q.blocksOf(d.key);
    const linkBad = (l) => l.vlanMismatch || problem(Q.findingsFor('link', l.key));
    const neighborHasFinding = peerRows.some((r) => r.links.some(linkBad));
    const ifcBad = (i) => problem(Q.findingsFor('interface', i.key));
    const unkBad = (r) => r.macs.length > 1 || problem(Q.findingsFor('interface', r.ep));
    const failed = blocks.filter((b) => b.failure).length;
    return h('div', { class: 'detail' }, [
      h('h2', null, Q.devLabel(d.key)),
      h('div', { class: 'row' }, [V.kindChip(d.kind), d.collected ? V.chip('已收集', 'ok') : V.chip('未收集（僅由鄰居發現）', 'warn'), d.group ? V.chip(d.group, '', { title: V.TERMS.group + '（版面用，不代表實體位置或 IP 網段）' }) : null, d.role ? V.chip('角色：' + d.role) : null,
        dev.length ? h('a', { class: 'link chip-link deviation-chip', title: '依跨設備多數決推定這台的設定與其他設備不同（推論）；點一下捲到檢查結果',
          onclick: () => { const sec = V.$('#detail .findings-section'); if (sec) sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }, V.stateChip(dev.length, '項' + V.DEVIATION, V.worstSev(dev))) : null]),
      // 已收集的設備應有的身分欄位沒有值時寫「—」；未收集的設備改以說明句交代（下一段）
      kv([['管理 IP', d.mgmtIp || (d.collected ? '—' : null)], ['型號', d.deviceType || (d.collected ? '—' : null)], ['RouterOS', d.softwareVersion || (d.collected && d.manufacturer === 'mikrotik' ? '—' : null)],
        // RouterBOOT 韌體與運作時間（/system routerboard、/system resource 的事實）；文字與網路文件共用 S.report
        ['RouterBOOT 韌體', S.report.firmwareText(d.routerboard) || null],
        // 運作時間是收集 /system resource 那一刻的值；那段輸出有收集器的收集時間時寫出，沒有時說明（和下方取自設定匯出的「收集時間」是不同的來源）
        ['運作時間', d.uptime ? `${S.report.uptimeText(d.uptime.seconds)}（${d.uptime.collectedAt ? '/system resource 收集於 ' + d.uptime.collectedAt.replace('T', ' ') : '收集 /system resource 時的值；那段輸出沒有記錄收集時間'}）` : null],
        ['廠商', d.manufacturer ? V.vendorName(d.manufacturer) : null],
        ['平台', d.manufacturer === 'mikrotik' ? null : d.platform],
        ['鄰居回報功能', d.caps ? h('span', { class: 'caps', title: '原值：' + d.caps }, V.capsText(d.caps)) : null],
        // 設備類型依據：依命名規則是使用者指定，其餘是推定
        ['類型依據', d.kindBasis === 'profile' ? V.KIND_BASIS[d.kindBasis] : inferred(V.KIND_BASIS[d.kindBasis] || d.kindBasis, '設備類型是依型號、收集的資料或鄰居回報推定的結果，不是設備直接回報')],
        ['收集時間', d.collectedAt ? `${d.collectedAt.replace('T', ' ')}（設備時間，取自設定匯出 /export 的開頭）` : null],
        ['其他名稱', d.names.length > 1 ? d.names.join('、') : null], ['路由器 ID', d.routerId],
        ['看到它的設備', d.seenBy.length && d.seenBy.length <= SEEN_INLINE ? devChips(App, d.seenBy) : null],
        ['收集的資料', d.collected ? h('div', { class: 'chip-list' }, [
          ...(cov ? cov.data : []).map((t) => V.chip(S.query.dataLabel(t), 'ok')),
          ...(cov ? cov.missing : []).map((t) => V.chip('缺 ' + S.query.dataLabel(t), 'err')),
          ...(cov && cov.failures ? cov.failures : []).map((x) => V.chip(`收集失敗：${x.command || '整台設備'}`, 'err', { title: V.failureText(x) })),
        ]) : null]]),
      // 沒收集與「收集到但是空的」分開：未收集的設備說明下面只有鄰居回報的資料（空的區塊不顯示，不寫「鄰居 0」）
      d.collected ? null : h('p', { class: 'muted uncollected-note' }, '沒有收集這台設備的輸出：下面只有鄰居回報的資料，介面、路由、防火牆等設定無法判斷。'),
      // 設備的身分（管理 IP、型號、版本、收集的資料）在首屏；核心設備常有十幾二十筆檢查結果，只先列 DEVICE_FINDINGS_SHOWN 筆
      findingsBlock(App, fl, { shown: DEVICE_FINDINGS_SHOWN }),
      section('看到它的設備', d.seenBy.length > SEEN_INLINE ? devChips(App, d.seenBy) : null, { count: d.seenBy.length, fold: true }),
      // 未收集的設備：介面只來自鄰居的回報（名稱可能是對端回報的埠名，或 OSPF 鄰居的位址），狀態一律不明
      d.collected ? null : section('鄰居看到的介面與位址', table([
        { t: '介面', f: (i) => (i.name === '?' || Q.addressesOf(i.key).some((x) => x.split('/')[0] === i.name) ? h('span', { class: 'muted', title: '鄰居沒有回報介面名稱（原值：' + i.name + '）' }, '—') : h('span', { class: 'mono' }, i.name)), s: (i) => i.name },
        { t: '位址', f: (i) => Q.addressesOf(i.key).join('  '), s: (i) => Q.addressesOf(i.key)[0] || null },
        { t: '描述', f: (i) => i.desc || '', s: (i) => i.desc || null },
      ], ifs.slice().sort((a, b) => S.util.natural(a.name, b.name)), { onRow: (i) => App.select({ type: 'interface', key: i.key }), limit: 300, bad: ifcBad }), { count: ifs.length, fold: true, open: ifs.some(ifcBad) }),
      !d.collected ? null : section('介面', table([
        { t: '介面', f: (i) => h('span', { class: 'mono' }, i.name + (i.lag ? ` → ${Q.getInterface(i.lag).name}` : '')), s: (i) => i.name },
        { t: '狀態', f: V.ifcState, s: V.ifcState },
        { t: '描述／IP', f: (i) => [i.desc, ...Q.addressesOf(i.key)].filter(Boolean).join('  '), s: (i) => Q.addressesOf(i.key)[0] || i.desc },
        { t: 'VLAN', f: (i) => h('span', { class: 'vlanlist' }, vlanText(S.util.ifcVlans(i))), s: (i) => vlanText(S.util.ifcVlans(i)) },
        { t: 'MAC', f: (i) => (i.macs.length ? String(i.macs.length) : ''), s: (i) => i.macs.length || null },
      ], ifs.sort((a, b) => S.util.natural(a.name, b.name)), { onRow: (i) => App.select({ type: 'interface', key: i.key }), limit: 300, bad: ifcBad }),
        { count: ifs.length, fold: true, open: ifs.some(ifcBad), extra: [problemChip(App, 'interface', ifs.map((i) => i.key), '個')] }),
      section('VLAN 定義', vlans.length ? table([
        { t: 'ID', f: (v) => (v.id == null ? '?' : String(v.id)) }, { t: '名稱', f: (v) => v.name || '' }, { t: '描述', f: (v) => v.desc || '' }, { t: '成員', f: (v) => String(v.members.length) },
      ], vlans, { onRow: (v) => v.id != null && App.select({ type: 'vlan', key: String(v.id) }) }) : null, { count: vlans.length, fold: true }),
      // 有問題的終端埠（例如學到多個 MAC）時預設展開
      section('沒有 LLDP／CDP 鄰接的埠', unk.length ? unknownTable(App, unk, unkBad) : null,
        { count: unk.length, fold: true, open: unk.some(unkBad),
          extra: [h('a', { class: 'link', onclick: () => App.select({ type: 'endpoints', dev: d.key }, { focus: true }) }, '在圖上看')] }),
      section('鄰居', peerRows.length ? table([
        { t: '本機介面', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? h('span', { class: 'mono' }, r.observations.length ? r.observations.map((o) => o.ifc).join('、') : '對端回報')
          : h('span', { class: 'mono' }, ifName(Q, r.mine)),
        s: (r) => (r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? (r.observations[0] ? r.observations[0].ifc : '') : ifName(Q, r.mine)) },
        // 類別不換行，放第二欄：窄的右欄不必橫捲就看得到（對端名稱較長，放後面）
        { t: '類別', f: (r) => V.linkClassText(r.l, { proto: true }),
        s: (r) => (r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? 'MNDP' : V.protoText(r.l)), cls: 'nowrap' },
        { t: '對端', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? Q.devLabel(K.splitEp(r.other)[0])
          : h('span', null, [Q.devLabel(K.splitEp(r.other)[0]), h('span', { class: 'mono muted' }, ' ' + ifName(Q, r.other))]),
        s: (r) => Q.devName(K.splitEp(r.other)[0]) },
        { t: 'VLAN', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? '—'
          : (r.l.vlanMismatch ? h('span', { class: 'diffA' }, '不一致') : h('span', { class: 'vlanlist' }, vlanText(r.l.vlansCommon))),
        s: (r) => (r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? null : r.l.vlanMismatch ? '不一致' : vlanText(r.l.vlansCommon)) },
      ], peerRows, {
        onRow: (r) => App.select({ type: 'link', key: r.l.key }, { focus: true }),
        bad: (r) => r.links.some(linkBad),
      }) : null, { count: peerRows.length, fold: true, open: neighborHasFinding, extra: [problemChip(App, 'link', links.map((l) => l.key), '條')] }),
      inferredSection(App, Q.inferredLinksOf(d.key), d.key),
      section('OSPF L3 鄰接（非實體直連）', ospfAdjacencies.length ? table([
          { t: '本機介面', f: (a) => epLink(App, a.localEp), s: (a) => K.splitEp(a.localEp)[1] },
          { t: '鄰居', f: (a) => devLink(App, a.peerDev), s: (a) => Q.devName(a.peerDev) },
          { t: '鄰居位址／路由器 ID', f: (a) => [a.peerIp, a.peerId].filter(Boolean).join('／'), s: (a) => a.peerIp || a.peerId },
          { t: '回報', f: (a) => a.reciprocal ? '雙向 OSPF 鄰接' : '單向 OSPF 觀察', s: (a) => (a.reciprocal ? '雙向' : '單向') },
          { t: '來源', f: (a) => srcLink(App, a.src) },
        ], ospfAdjacencies) : null, { count: ospfAdjacencies.length, fold: true }),
      // 路由多時（V.BIG_LIST.min 以上）先看摘要：依路由表、協定與下一跳分組，點開一組才看明細（分頁）；另可依文字搜尋
      section('路由表', routes.length ? V.bigList([
        // 非作用中（例如備援的預設路由）也列出，可與 R11 等檢查對照：chip 放在網段欄（最後一欄在窄的右欄看不到），整列 muted；
        // 路由追蹤與檢查的路由表只用作用中的
        { t: '網段', f: (r) => h('span', null, [h('span', { class: 'mono' }, `${r.prefix}/${r.len}`),
          r.active === false ? ' ' : null, r.active === false ? V.chip('非作用中', 'route-inactive', { title: '目前沒有被選用（例如備援路由）；路由追蹤只看作用中的路由' }) : null]), s: (r) => `${r.prefix}/${r.len}` },
        // 路由表（routing-table）：基準有其他 VRF 或這台設備有 main 以外的路由表時才列；只用於策略路由的路由表不屬於任何 VRF
        ...(showTable ? [{ t: '路由表', f: (r) => h('span', null, [h('span', { class: 'mono' }, r.routingTable || K.MAIN_VRF), r.vrf == null ? V.chip('只用於策略路由', 'info', { title: '這張路由表不是 VRF：只有 /routing rule 指定時才會查' }) : null]), s: (r) => r.routingTable }] : []),
        { t: '協定', f: (r) => (r.blackhole ? h('span', { class: 'diffA' }, '黑洞路由') : r.proto), s: (r) => r.proto },
        { t: '距離', f: (r) => (r.distance == null ? '' : String(r.distance)), s: (r) => r.distance },
        { t: '下一跳', f: (r) => nhCell(r, multiVrf(Q)), s: (r) => (r.nh[0] ? r.nh[0].ip || r.nh[0].ifc : '') },
      ], routes, { table: { rowClass: (r) => (r.active === false ? 'route-off' : '') }, unit: '條', what: '路由', placeholder: '搜尋網段、下一跳、協定（文字）',
        groups: () => routeGroups(routes, showTable), text: routeText }) : null, { count: routes.length, fold: true, extra: [V.stateChip(inactive, '條非作用中')] }),
      vrfSection(App, d.key),
      policySection(App, d.key),
      firewallSummary(App, d.key),
      d.collected ? mgmtSection(App, d.key) : null,
      section('收集到的原始輸出', blocks.length ? blocksTable(App, blocks) : null,
        { count: blocks.length, fold: true, open: failed > 0, extra: [V.stateChip(failed, '個收集失敗', 'error')] }),
    ]);
  }
  /** 「看到它的設備」超過這個台數時移出屬性表，改為預設收合的區塊（核心設備常被十幾台看到） */
  const SEEN_INLINE = 5;
  /** 設備詳情的防火牆摘要：規則、服務與 WAN／LAN 狀態；完整內容在防火牆畫面 */
  function firewallSummary(App, dev) {
    const Q = App.Q; const rules = Q.firewallRulesOf(dev); const services = Q.ipServicesOf(dev); const zone = Q.firewallZone(dev);
    if (!rules.length && !services.length && !zone) return null;
    const bad = problemChip(App, 'rule', rules.map((r) => r.key), '條');
    // 用語與防火牆畫面共用 firewall.js 的 zoneStatus()（該檔在本檔之後載入，render 時才取用）
    const zs = zone && V.firewall.zoneStatus(zone.status);
    // 與相鄰的路由表、管理面設定同一種模式：展開列＋標題旁的規則數；有問題的規則時預設展開；跳到防火牆畫面的連結在標題列
    return section('防火牆', kv([['規則', `${V.num(rules.length)} 條`], ['服務（/ip service）', `${V.num(services.length)} 個`],
      ['WAN／LAN 判斷', zs ? V.chip(zs.short, zs.tone, { title: zs.text }) : '—']]),
    { count: rules.length, fold: true, open: !!bad, extra: [bad, h('a', { class: 'link fw-open', onclick: () => App.select({ type: 'firewall', dev }) }, '查看防火牆規則與服務')] });
  }
  /*
   * 管理面設定（Q.mgmtOf，一台一筆；沒有 /export 的設備是 null）：每項列出狀態、值與依據。
   *   依據：export 寫出的欄位連到原文那一行；沒寫出的欄位是依出廠預設值推定（S.query.mgmtDefaults，推論），提示寫出版本與手冊。
   *   檢查結果：同一台設備的 F10–F14 依檢查與比對對象（facet）對到那一列，互相連結（mgmtGoto）。
   * 欄位 → RouterOS 參數名稱只用於顯示（核心的轉換表在 model/build.js 的 MGMT_FIELDS）。
   */
  // state 回傳 null＝決定狀態的欄位沒有資料（部分 export 沒有這個選單、版本不在預設值表範圍），顯示「無法判斷」
  const known = (...v) => v.every((x) => x !== null && x !== undefined);
  const onOff = (a) => (known(a.enabled) ? (a.enabled ? '開啟' : '關閉') : null);
  // label 只寫沒有 facet 的項目；params 是畫面列出的參數（「預設」與「無法判斷」只算這些）；dns、socks 列出 vrf，因為 F10、F14 依 vrf 判斷 WAN 能不能連到
  const MGMT_ITEMS = [
    { area: 'dns', label: 'DNS 遠端查詢', menu: '/ip dns', rule: 'F10', params: [['allowRemote', 'allow-remote-requests'], ['vrf', 'vrf']],
      state: (a) => (known(a.allowRemote) ? (a.allowRemote ? '允許' : '不允許') : null) },
    { area: 'macServer', menu: '/tool mac-server', rule: 'F11', facet: 'mac-telnet', params: [['allowedList', 'allowed-interface-list']], state: (a) => (known(a.allowedList) ? `限清單 ${a.allowedList}` : null) },
    { area: 'macWinbox', menu: '/tool mac-server mac-winbox', rule: 'F11', facet: 'mac-winbox', params: [['allowedList', 'allowed-interface-list']], state: (a) => (known(a.allowedList) ? `限清單 ${a.allowedList}` : null) },
    { area: 'discovery', label: '鄰居探索', menu: '/ip neighbor discovery-settings', rule: 'F12', params: [['list', 'discover-interface-list'], ['protocols', 'protocol'], ['mode', 'mode']],
      // 只要 protocol 是空的或 mode 是 rx-only 就確定不送出；其他情況三個欄位都要有資料
      state: (a) => ((a.protocols && !a.protocols.length) || a.mode === 'rx-only' ? '不送出' : known(a.protocols, a.mode, a.list) ? `在清單 ${a.list} 送出` : null) },
    { area: 'snmp', label: 'SNMP', menu: '/snmp', params: [['enabled', 'enabled']] },
    { area: 'upnp', menu: '/ip upnp', rule: 'F14', facet: 'upnp', params: [['enabled', 'enabled']] },
    { area: 'proxy', menu: '/ip proxy', rule: 'F14', facet: 'proxy', params: [['enabled', 'enabled'], ['ports', 'port']] },
    { area: 'socks', menu: '/ip socks', rule: 'F14', facet: 'socks', params: [['enabled', 'enabled'], ['port', 'port'], ['vrf', 'vrf']] },
    { area: 'bandwidthServer', menu: '/tool bandwidth-server', rule: 'F14', facet: 'bandwidth-server', params: [['enabled', 'enabled'], ['authenticate', 'authenticate']] },
  ].map((it) => {
    // 有 facet 的項目（F11、F14 的管理服務）名稱取自 V.remediation.FACET_ITEM，與檢查結果的比對對象同一份
    if (it.facet === undefined) return it;
    const label = V.remediation.FACET_ITEM[it.facet];
    if (!label) throw new Error('管理面設定的 facet 在 V.remediation.FACET_ITEM 沒有名稱：' + it.facet);
    return Object.assign({ label }, it);
  });
  const MGMT_COMMUNITY = [['name', 'name'], ['addresses', 'addresses'], ['write', 'write-access'], ['security', 'security'], ['disabled', 'disabled']];
  const MGMT_RULES = new Set(MGMT_ITEMS.map((x) => x.rule).filter(Boolean).concat('F13'));
  /** 這一段相關的檢查「F10 標題」：標題取自檢查目錄（S.query.rule），依代碼排序 */
  const mgmtRuleText = () => Array.from(MGMT_RULES).sort().map((id) => { const r = S.query.rule(id); return r ? `${id} ${r.title}` : id; }).join('、');
  const MGMT_FACTORY_TEXT = '出廠';
  const MGMT_FACTORY_TIP = 'RouterOS 出廠就有的 community（default=yes，名稱多半是 public）';
  const MGMT_DEFAULT_TEXT = '預設（未在 export 中，推論）';
  const MGMT_UNKNOWN_STATE = '無法判斷';
  /** 欄位沒有資料的原因（Q.mgmtOf 的 reason）→ 說明文字 */
  const mgmtReasonText = (reason) => (reason === 'not-exported' ? 'export 沒有包含這個選單，無法判斷'
    : reason === 'version' ? `設備版本不在預設值表範圍（${S.query.mgmtDefaults().versions.text}），不以預設值推定` : '沒有資料，無法判斷');
  const mgmtVal = (v) => (v === true ? 'yes' : v === false ? 'no' : Array.isArray(v) ? v.join(',') : v == null ? '?' : String(v));
  /**
   * 一列的依據：export 的原文行號（各自可點）＋沒寫出的欄位：
   *   標預設（推論，提示寫出 S.query.mgmtDefaults 的版本與手冊；設備版本不明時註明），或無法判斷（寫出原因 reason）。
   * 只算畫面列出的參數（params），核心另外補上的欄位不影響標示。
   */
  function mgmtBasis(App, ms, x, params, manual, reason) {
    const D = S.query.mgmtDefaults();
    const list = x.src.map(([b, line]) => ({ file: App.Q.block(b).file, line }));
    const srcs = x.src.map(([b, line], n) => h('a', { class: 'link mgmt-src', title: '開啟原文', onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); App.openRaw(list[n].file, line, { list }); } },
      (n ? '' : V.fileName(list[n].file) + ' ') + `第 ${line} 行`));
    const defP = params.filter(([f]) => (x.defaulted || []).includes(f)); const unkP = params.filter(([f]) => (x.unknown || []).includes(f));
    const several = x.src.length + (defP.length ? 1 : 0) + (unkP.length ? 1 : 0) > 1; // 混合時寫出是哪些參數
    const names = (ps) => (several ? h('span', { class: 'muted' }, `　${ps.map(([, p]) => p).join('、')}：`) : null);
    const noVer = ms.versionInRange === null;
    const def = defP.length ? [names(defP), V.chip(MGMT_DEFAULT_TEXT, 'info mgmt-default', {
      title: `export 不寫出預設值：依 RouterOS ${D.routerOS} 的出廠預設值推定，設備版本不同時可能不同${noVer ? '（設備版本不明）' : ''}。手冊：${D.manual[manual]}` }),
    noVer ? h('span', { class: 'muted' }, '（設備版本不明）') : null] : [];
    const unk = unkP.length ? [names(unkP), h('span', { class: 'muted mgmt-unknown' }, mgmtReasonText(reason))] : [];
    return h('span', { class: 'mgmt-basis' }, [...srcs.flatMap((a, n) => (n ? ['、', a] : [a])), ...def, ...unk]);
  }
  const findingLink = (App, f) => {
    const Q = App.Q; const idx = Q.findingIndexesByKey(Q.findingKey(f)).find((i) => Q.finding(i) === f);
    return h('a', { class: 'link mgmt-finding', 'data-finding-idx': String(idx), title: f.message, onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); App.selectFinding(idx); } },
      [V.sevDot(f.severity), ' ', `${f.id} ${f.title}`]);
  };
  /** 一列對到的檢查結果（同一台設備、同一個檢查與比對對象）：連結開啟那一筆（滑鼠與鍵盤） */
  const mgmtFindings = (fl, rule, facet) => fl.filter((f) => f.id === rule && (facet === undefined || f.facet === facet));
  /**
   * 一個 community 對到的 F13：核心在每個 community 給的 facet（Q.mgmtOf 的 communities[].facet）就是 F13 的 facet，直接以它對應；
   * 停用的與名稱沒有資料的不產生 F13。內容完全相同的同名 community 核心給同一個 facet、併成一筆，兩列都對到它。
   */
  // 只有啟用中、有名稱的 community 會有 F13（停用的同名 community 的 facet 相同，不連）
  const communityLinked = (c) => c.disabled === false && c.name !== null;
  const communityFindings = (fl, c) => (communityLinked(c) ? mgmtFindings(fl, 'F13', c.facet) : []);
  /** 設備層：export 是整機或部分、設備版本與預設值表範圍 */
  function mgmtScope(ms) {
    const R = S.query.mgmtDefaults().versions.text;
    const ver = !ms.version ? '設備版本不明（照用預設值表推定）'
      : `RouterOS ${ms.version}${ms.versionInRange ? `，在預設值表範圍（${R}）內` : `，不在預設值表範圍（${R}），沒寫出的設定不推定`}`;
    return h('p', { class: 'mgmt-scope' }, [h('span', { class: 'muted' }, '設定來源：'),
      ms.export === 'full' ? '整機 export' : '部分 export（只有出現在 export 裡的選單有資料）', '；', ver]);
  }
  function mgmtSection(App, dev) {
    const Q = App.Q; const ms = Q.mgmtOf(dev);
    const mark = (el) => { el.classList.add('mgmt-section'); return el; };
    if (!ms) return mark(section('管理面設定', h('p', { class: 'muted' }, `沒有收集 /export，無法判斷 ${MGMT_ITEMS.map((x) => x.label).join('、')} 的設定。`), { fold: true }));
    const fl = Q.findingsFor('device', dev).filter((f) => MGMT_RULES.has(f.id));
    // 右欄很窄：每項一個區塊（名稱與狀態 → 值 → 依據 → 檢查結果），不用多欄表格
    // 檢查結果 → 設定（mgmtGoto）：一般項目以 data-mgmt 找回這一列；community 以 data-facet 加上 data-linked（啟用中、有名稱，communityLinked）
    const row = (attrs, label, menu, state, params, x, manual, reason, found, more) => {
      const links = found.map((f) => findingLink(App, f));
      if (problem(found)) bad++;
      return h('div', Object.assign({ class: 'mgmt-row' + (links.length ? ' bad' : '') }, attrs), [
        h('div', { class: 'mgmt-head' }, [].concat(h('b', null, label), ' ', V.chip(state == null ? MGMT_UNKNOWN_STATE : state), h('span', { class: 'muted mono mgmt-menu' }, menu))),
        h('div', { class: 'mono mgmt-val' }, params.map(([f, p]) => `${p}=${mgmtVal(x[f])}`).join(' ')),
        h('div', { class: 'mgmt-line' }, [h('span', { class: 'muted' }, '依據：'), mgmtBasis(App, ms, x, params, manual, reason)]),
        more || null,
        links.length ? h('div', { class: 'mgmt-line' }, [h('span', { class: 'muted' }, '檢查結果：'), ...links.flatMap((a, n) => (n ? ['、', a] : [a]))]) : null,
      ]);
    };
    const rows = []; let bad = 0; // bad：有錯誤或警告的項目數（標題列的狀態 chip）
    MGMT_ITEMS.forEach((it) => {
      const a = ms[it.area];
      const state = it.state ? it.state(a) : onOff(a);
      const extra = it.area === 'upnp' && a.interfaces.length ? '　' + a.interfaces.map((i) => `${i.type}=${K.splitEp(i.ep)[1]}${i.disabled ? '（停用）' : ''}`).join(' ') : '';
      const comms = it.area === 'snmp' ? a.communities : null;
      const more = it.area === 'snmp' && comms === null ? h('div', { class: 'mgmt-line' }, [h('span', { class: 'muted' }, 'community：'), h('span', { class: 'muted mgmt-unknown' }, mgmtReasonText(a.communitiesReason))]) : null;
      rows.push(row({ 'data-mgmt': it.area }, it.label, it.menu, state == null ? null : state + extra, it.params, a, it.area, a.reason, it.rule ? mgmtFindings(fl, it.rule, it.facet) : [], more));
      (comms || []).forEach((c) => rows.push(row({ 'data-mgmt': 'community', 'data-community': c.name == null ? '' : c.name, 'data-facet': c.facet == null ? null : c.facet, 'data-linked': String(communityLinked(c)) },
        [c.name == null ? 'SNMP community（名稱沒有資料）' : `SNMP community「${c.name}」`, ...(c.isDefault ? [' ', V.chip(MGMT_FACTORY_TEXT, '', { title: MGMT_FACTORY_TIP })] : [])], '/snmp community',
        c.disabled == null ? null : c.disabled ? '停用' : '啟用',
        MGMT_COMMUNITY.filter(([f]) => f !== 'name' && f !== 'disabled'), c, 'community', a.communitiesReason, communityFindings(fl, c))));
    });
    const unmatched = ms.snmp.unmatched.length ? h('p', { class: 'warn-line' }, [`export 中有 ${ms.snmp.unmatched.length} 行 /snmp community set 找不到對象，沒有套用：`,
      ...ms.snmp.unmatched.flatMap((s, n) => [n ? '、' : '', srcLink(App, [s])])]) : null;
    const factory = (ms.snmp.communities || []).some((c) => c.isDefault);
    return mark(section('管理面設定', [
      mgmtScope(ms),
      h('p', { class: 'muted' }, 'export 只寫出改過的設定；沒寫出的項目依出廠預設值推定（推論），export 沒有包含的選單與版本不在預設值表範圍時標「無法判斷」。'
        + (factory ? `「${MGMT_FACTORY_TEXT}」是${MGMT_FACTORY_TIP}。` : '')),
      h('p', { class: 'muted mgmt-rules' }, `相關的檢查：${mgmtRuleText()}。`),
      unmatched,
      h('div', { class: 'mgmt-list' }, rows),
    ], { count: rows.length, fold: true, open: problem(fl),
      // 標題旁的數量是列數；有檢查結果的項目另以狀態 chip 寫出（0 不顯示）
      extra: [V.stateChip(bad, '項有問題', V.worstSev(fl.filter((f) => f.severity !== 'info')))] }));
  }
  /**
   * F10–F14 的檢查結果 → 管理面設定的那一列：不在這台設備的詳情時先選取設備，再展開區塊、標出並捲到那一列。
   * 沒有對應的列（例如沒有 export）時不顯示連結。
   */
  function mgmtGoto(App, f) {
    if (!MGMT_RULES.has(f.id)) return null;
    const e = f.entities.find((x) => x.type === 'device'); if (!e || !App.Q.mgmtOf(e.key)) return null;
    const area = (MGMT_ITEMS.find((it) => it.rule === f.id && (it.facet === undefined || it.facet === f.facet)) || {}).area;
    // F13：以核心的 community.facet 對應（同名時帶雜湊）；停用的同名 community 的 facet 相同，只取 data-linked 的列
    const match = (r) => (f.id === 'F13' ? r.getAttribute('data-mgmt') === 'community' && r.getAttribute('data-facet') === f.facet && r.getAttribute('data-linked') === 'true' : r.getAttribute('data-mgmt') === area);
    const go = () => {
      if (!App.sel || App.sel.type !== 'device' || App.sel.key !== e.key) App.select({ type: 'device', key: e.key }, { focus: true });
      const sec = V.$('#detail').querySelector('.mgmt-section'); if (!sec) return;
      sec.open = true;
      const T = V.theme.firewall.focus;
      Array.from(sec.querySelectorAll('.mgmt-row')).forEach((r) => {
        const on = match(r); r.classList.toggle('focus', on);
        r.style.background = on ? T.bg : ''; r.style.boxShadow = on ? `inset 3px 0 0 ${T.border}` : '';
        if (on) r.scrollIntoView({ block: 'center' });
      });
    };
    return h('div', null, h('a', { class: 'link mgmt-goto', onclick: go }, '查看管理面設定'));
  }
  /**
   * 設備的 VRF 設定（Q.vrfsOf，事實）：依設定順序，介面屬於第一個列出它（或 all）的 VRF。
   * 來源是 /ip vrf print 時含內建 main 的位置；只有 export 時 export 不寫內建 main，假設 main 在最後（推論）。
   */
  function vrfSection(App, dev) {
    const Q = App.Q; const list = Q.vrfsOf(dev);
    // 只有內建的 main（例如 /ip vrf print 只列出 main）時不顯示，與加入 VRF 之前相同
    if (!list.some((v) => !v.builtin)) return null;
    const fromExport = list.some((v) => v.source === 'export');
    return section('VRF', [
      fromExport ? h('p', { class: 'muted' }, ['依 export 的 /ip vrf：export 不寫內建的 main，假設 main 在最後（比對介面時最後才輪到 main） ', V.chip('推論', 'info')]) : null,
      table([
        { t: '順序', f: (v) => String(v.order), s: (v) => v.order },
        { t: 'VRF', f: (v) => h('span', null, [h('span', { class: 'mono' }, v.name), v.builtin ? V.chip('內建') : null, v.disabled ? V.chip('停用', 'warn') : null]), s: (v) => v.name },
        { t: '設定的介面', f: (v) => h('span', { class: 'mono' }, v.interfaces.join(' ') || '—') },
        { t: '成員', f: (v) => (v.members.length ? h('span', null, v.members.flatMap((ep, n) => [n ? '、' : '', epLink(App, ep)])) : '—'), s: (v) => v.members.length },
        { t: '來源', f: (v) => srcLink(App, v.src) },
      ], list),
    // VRF 沒有對應的檢查結果：預設收合（同其他主題區塊）；停用的 VRF 在標題列寫出
    ], { count: list.length, fold: true, extra: [V.stateChip(list.filter((v) => v.disabled).length, '個停用')] });
  }
  /**
   * 策略路由（事實）：/routing settings 的 policy-rules（查表順序）、/routing table、/routing rule 與 mangle 的 mark-routing。
   * 依據 Q.policyOf（這台設備）、Q.routingTables()／Q.routingRules()（只取這台設備的，含停用的規則）。
   * 判斷封包查哪一張表的是查詢層（路由追蹤、可達性），這裡只列設定。
   */
  function policySection(App, dev) {
    const Q = App.Q; const pol = Q.policyOf(dev);
    const tables = Q.routingTables().filter((t) => t.dev === dev); const rules = Q.routingRules().filter((r) => r.dev === dev);
    if (!pol.any && !rules.length && !tables.some((t) => t.vrf == null)) return null;
    // 改過的查表順序與 mangle 的 mark-routing 會讓路由追蹤的結果不明（警告）：這時預設展開，否則收合
    const unsure = pol.custom || pol.marks.length > 0;
    return section('策略路由', [
      kv([
        ['查表順序（policy-rules）', h('span', null, [h('span', { class: 'mono' }, pol.policyRules.join(' → ')), ' ',
          pol.custom ? V.chip('改過預設的順序：查哪一張表無法判斷', 'warn') : V.chip('預設')])],
        ['mangle mark-routing', pol.marks.length ? h('span', null, [`${V.num(pol.marks.length)} 條 `, V.chip('mangle 不在模型中：封包可能改查其他路由表，結果不明', 'warn')]) : null],
      ]),
      tables.length ? h('div', null, [h('div', { class: 'muted' }, '路由表（/routing table 與 VRF 自動產生的表）'), table([
        { t: '路由表', f: (t) => h('span', { class: 'mono' }, t.name), s: (t) => t.name },
        { t: '用途', f: (t) => (t.vrf ? V.vrfText(t.vrf) : '只用於策略路由'), s: (t) => t.vrf || '' },
        { t: 'fib', f: (t) => (t.fib ? '是' : '否') },
        { t: '狀態', f: (t) => (t.disabled ? V.chip('停用', 'warn') : '啟用') },
        { t: '路由', f: (t) => V.num(Q.routesInTable(dev, t.name).length), s: (t) => Q.routesInTable(dev, t.name).length, cls: 'num' },
        { t: '來源', f: (t) => srcLink(App, t.src) },
      ], tables)]) : null,
      rules.length ? h('div', null, [h('div', { class: 'muted' }, '/routing rule（依設定順序；只有 main 的封包會依序比對）'), table([
        { t: '順序', f: (r) => String(r.order), s: (r) => r.order },
        { t: '條件', f: (r) => h('span', { class: 'mono' }, Object.entries(r.match).map(([k, v]) => `${k}=${v}`).join(' ') || '（沒有條件）') },
        { t: '動作', f: (r) => h('span', { class: 'mono' }, r.action + (r.table ? ' ' + r.table : '')) },
        { t: '狀態', f: (r) => (r.disabled ? V.chip('停用', 'warn') : '啟用') },
        { t: '備註', f: (r) => r.comment || '' },
        { t: '來源', f: (r) => srcLink(App, r.src) },
      ], rules)]) : null,
    // 內容是設定、路由表與規則三種，沒有單一的列數：標題列寫規則條數（0 不顯示）
    ], { fold: true, open: unsure, extra: [V.stateChip(rules.length, '條 /routing rule'), unsure ? V.chip('查哪一張表不明', 'warn') : null] });
  }
  /** 收集到的原始輸出：每個區塊的指令、解析器、收集時間（UTC）與收集失敗；點一下開啟原文（失敗的區塊開在失敗那一行） */
  function blocksTable(App, bs) {
    return table([
      { t: '指令', f: (b) => b.command || '（未標記）', s: (b) => b.command || '（未標記）' },
      { t: '收集時間', f: (b) => (b.collectedAt ? h('span', { class: 'mono' }, V.fmtUtc(b.collectedAt)) : ''), s: (b) => b.collectedAt },
      { t: '失敗', f: (b) => (b.failure ? V.chip(V.failureText(b.failure), 'err', { title: b.failure.text || null }) : ''), s: (b) => (b.failure ? b.failure.reason : null) },
      // 已解析的區塊仍可能有認不得的行（I03）：標出行數，點一下開啟第一行
      { t: '解析器', f: (b) => (b.adapters.length && !b.empty ? h('span', null, [b.adapters.map(S.query.adapterLabel).join('、'),
        (b.unrecognizedLines || []).length ? h('a', { class: 'link partial-unrecognized', title: '這個區塊有認不得的行，這些行沒有進入基準；點一下開啟第一行',
          onclick: (e) => { e.stopPropagation(); App.openRaw(b.file, b.unrecognizedLines[0]); } }, `部分無法辨識（${V.num(b.unrecognizedLines.length)} 行）`) : null])
        : h('span', { class: 'diffA' }, '無法辨識')),
        s: (b) => (b.adapters.length && !b.empty ? b.adapters.map(S.query.adapterLabel).join('、') : '無法辨識') },
      { t: '行', f: (b) => `${b.start}–${b.end}`, s: (b) => b.start },
    ], bs, { onRow: (b) => App.openRaw(b.file, b.failure ? b.failure.line : b.start), bad: (b) => !!b.failure });
  }
  const ifName = (Q, ep) => { const i = Q.getInterface(ep); const n = K.splitEp(ep)[1]; return i ? i.name : n.startsWith('?(') ? '埠不明' : n; };
  /** 推論鏈路的文字連結：點選開啟所在的設備對 */
  const inferredLink = (App, l, from) => {
    const Q = App.Q; const p = App.pairs.get(App.pairOfLink.get(l.key));
    const text = (from && K.splitEp(l.b)[0] === from ? [l.b, l.a] : [l.a, l.b]).map((ep) => `${Q.devName(K.splitEp(ep)[0])} ${ifName(Q, ep)}`).join(' ⇄ ') + '（推論鏈路）';
    return p ? L(App, text, { type: 'pair', id: p.id, links: p.links, devs: [p.a, p.b] }) : text;
  };
  /** 推論鏈路清單：每條列出兩端、依據與信心，展開可看每項證據並開啟原文。 */
  function inferredTable(App, list, from) {
    const Q = App.Q;
    const ends = (l) => (from && K.splitEp(l.b)[0] === from ? [l.b, l.a] : [l.a, l.b]);
    return table([
      { t: '本端', f: (l) => h('span', null, [Q.devName(K.splitEp(ends(l)[0])[0]), h('span', { class: 'mono muted' }, ' ' + ifName(Q, ends(l)[0]))]) },
      { t: '對端', f: (l) => h('span', null, [devLink(App, K.splitEp(ends(l)[1])[0]), h('span', { class: 'mono muted' }, ' ' + ifName(Q, ends(l)[1]))]) },
      { t: '依據', f: (l) => {
        // 同一條推論鏈路的各項證據在原文對話框可前後切換
        const nav = l.evidence.flatMap((e) => e.src.map(([b, line]) => Q.block(b) && { file: Q.block(b).file, line })).filter(Boolean);
        return h('div', null, l.evidence.map((e) => h('div', null, [h('b', null, V.INFER_BASIS[e.basis] + '：'), e.text, ...e.src.map(([b, line]) => {
          const blk = Q.block(b); return blk ? h('a', { class: 'link mono', onclick: () => App.openRaw(blk.file, line, { list: nav }) }, ` 第 ${line} 行`) : null;
        })])));
      } },
      { t: '信心', f: (l) => V.chip(V.CONFIDENCE[l.confidence], l.confidence === 'high' ? 'ok' : 'info') },
    ], list);
  }

  // ---------------------------------------------------------------- 鏈路
  function link(App, sel) {
    const Q = App.Q; const l = Q.getLink(sel.key);
    if (!l) return h('div', { class: 'empty-detail' }, '基準中沒有這條鏈路');
    const sa = new Set(l.vlansA); const sb = new Set(l.vlansB);
    const onlyA = l.vlansA.filter((v) => !sb.has(v)); const onlyB = l.vlansB.filter((v) => !sa.has(v));
    const fl = Q.findingsFor('link', l.key).concat(Q.findingsFor('interface', l.a), Q.findingsFor('interface', l.b));
    const domain = l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN;
    const observedAt = (l.observations || []).map((o) => {
      const b = Q.block(o.block);
      return `${Q.devName(o.dev)} ${o.ifc}${o.peerIfc ? `（對端回報埠 ${o.peerIfc}）` : ''}${b ? `・${V.fileName(b.file)} 第 ${o.line} 行` : ''}`;
    });
    return h('div', { class: 'detail' }, [
      h('h2', null, [Q.devLabel(K.splitEp(l.a)[0]), ' ⇄ ', Q.devLabel(K.splitEp(l.b)[0])]),
      h('div', { class: 'row' }, domain
        ? [V.chip(V.DOMAIN_TEXT, 'info'), ...l.via.map((v) => V.chip(v.toUpperCase()))]
        : [V.chip(V.CLS[l.cls]), l.verified ? V.chip('雙向確認', 'ok') : l.hearsay ? V.chip(V.HEARSAY_TEXT, 'info') : V.chip(V.ONE_WAY_TEXT, 'warn'), ...l.via.map((v) => V.chip(v.toUpperCase()))]),
      findingsBlock(App, fl),
      domain
        ? kv([['關係', 'MNDP 觀察到的 L2 廣播網域可達性；不代表兩台設備之間存在直連線路。'],
          ['觀察位置', observedAt.length ? observedAt.join('；') : '詳見原始輸出']])
        : kv([['A 端', epLink(App, l.a)], ['B 端', epLink(App, l.b)], ['層級', 'L2（介面鄰接）']]),
      section('VLAN', !domain ? kv([
        ['兩端都有', h('span', { class: 'vlanlist' }, vlanText(l.vlansCommon))],
        ['只在 A 端', onlyA.length ? h('span', { class: 'vlanlist diffA' }, vlanText(onlyA)) : '—'],
        ['只在 B 端', onlyB.length ? h('span', { class: 'vlanlist diffA' }, vlanText(onlyB)) : '—'],
      ]) : null),
      sourcesBlock(App, l.src),
    ]);
  }
  function pair(App, sel) {
    const Q = App.Q; const links = sel.links.map((k) => Q.getLink(k)).filter(Boolean);
    const [a, b] = sel.devs;
    const inferredList = Q.inferredLinksBetween(a, b);
    const behind = S.util.uniq(inferredList.flatMap((l) => Q.behindUnder(l.key)));
    return h('div', { class: 'detail' }, [
      h('h2', null, [Q.devLabel(a), ' ⇄ ', Q.devLabel(b)]),
      h('div', { class: 'row' }, [links.length ? V.chip(`${links.length} 條鏈路`) : null, inferredList.length ? V.chip(`${inferredList.length} 條推論鏈路`, 'info') : null]),
      findingsBlock(App, [].concat(...links.map((l) => Q.findingsFor('link', l.key)))),
      section('鏈路（LLDP／CDP／MNDP）', links.length ? table([
        { t: Q.devName(a), f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? 'MNDP 觀察'
          : h('span', { class: 'mono' }, ifName(Q, K.splitEp(l.a)[0] === a ? l.a : l.b)) },
        { t: Q.devName(b), f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? 'L2 廣播網域可達'
          : h('span', { class: 'mono' }, ifName(Q, K.splitEp(l.a)[0] === a ? l.b : l.a)) },
        { t: '類別', f: (l) => V.linkClassText(l), cls: 'nowrap' },
        { t: '協定', f: (l) => V.protoText(l) },
        { t: 'VLAN', f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? '—'
          : (l.vlanMismatch ? h('span', { class: 'diffA' }, '不一致') : h('span', { class: 'vlanlist' }, vlanText(l.vlansCommon))) },
      ], links, { onRow: (l) => App.select({ type: 'link', key: l.key }), bad: (l) => l.vlanMismatch || problem(Q.findingsFor('link', l.key)) }) : null,
      // 設備對頁的主體是這兩台之間的鏈路（一般區塊，同終端埠頁、外部頁）：沒有問題或只有推論鏈路時也直接看得到
      { count: links.length, extra: [problemChip(App, 'link', links.map((l) => l.key), '條')] }),
      inferredSection(App, inferredList, a, true),
      section('推定在這條推論鏈路後面的終端', behind.length ? table([
        { t: 'MAC', f: (x) => macLink(App, x.mac), s: (x) => x.mac }, { t: '廠商', f: (x) => x.vendor || '' }, { t: 'IP', f: (x) => x.ips.join(', ') },
        { t: '推定位置', f: (x) => (x.behind.dev ? `在 ${Q.devName(x.behind.dev)} 底下` : `在 ${x.behind.via.map((v) => Q.devName(v)).join('、')} 或其下游`) },
      ], behind, { limit: 500 }) : null, { count: behind.length, fold: true }),
    ]);
  }

  // ---------------------------------------------------------------- 介面
  /** 在沒開 vlan-filtering 的 bridge 上（vlanUnfiltered，推論）：VLAN 的埠設定沒有作用，值旁邊標出來 */
  const unfilteredNote = (i, text) => (i.vlanUnfiltered
    ? h('span', null, [text, ' ', V.chip('沒有作用（bridge 沒開 vlan-filtering）', 'info', { title: '依 RouterOS 手冊，bridge 沒開 vlan-filtering 時不看也不改 VLAN 標籤，pvid、frame-types、ingress-filtering 都沒有作用（推論）' })])
    : text);
  /**
   * 介面所屬的 VRF 與依據（interfaces[].vrfBasis）；依 export 的 /ip vrf 判斷時是推論（標出）。
   * 只用 main 的網路不顯示（回傳 null），與加入 VRF 之前相同。
   */
  function vrfOfIfc(Q, i) {
    if (!multiVrf(Q) && K.vrf(i.vrf) === K.MAIN_VRF) return null;
    return h('span', { class: 'ifc-vrf' }, [h('span', { class: 'mono' }, K.vrf(i.vrf)), ' ',
      h('span', { class: 'muted' }, `（${V.IFC_VRF_BASIS[i.vrfBasis] || i.vrfBasis || '依據不明'}）`),
      V.IFC_VRF_INFERRED.has(i.vrfBasis) ? V.chip('推論', 'info') : null]);
  }
  function typeChip(i) {
    const label = (V.theme.endpoint.styleOf(i) || {}).label || V.IFC_TYPE[i.type];
    const guessed = i.typeBasis && i.typeBasis !== 'rawType';
    return V.chip(guessed ? `${label}（${V.TERMS.inferred}）` : label, guessed ? 'info type-inferred' : '', { title: V.IFC_TYPE_BASIS[i.typeBasis] || (guessed ? '介面類型推定' : null) });
  }
  function iface(App, sel) {
    const Q = App.Q; const i = Q.getInterface(sel.key);
    if (!i) return h('div', { class: 'empty-detail' }, '基準中沒有這個介面');
    const links = Q.linksOfEp(i.key); const inferred = Q.inferredLinksOfEp(i.key);
    const macs = i.macs.map((m) => Q.findMac(m));
    return h('div', { class: 'detail' }, [
      h('h2', null, [devLink(App, i.dev), ' ', i.name]),
      h('div', { class: 'row' }, [
        V.chip(V.ifcState(i), i.status === 'up' ? 'ok' : ''),
        // 介面類型不是 RouterOS 直接回報的類型時是推定（依名稱、聚合成員、關聯表或預設）：「推論」寫在同一個 chip 裡，看得出它修飾的是類型
        typeChip(i),
        i.hearsay ? V.chip('僅由對端回報', 'info') : null,
        i.unknownPeer ? V.chip(`沒有 LLDP／CDP 鄰接（${V.TERMS.endpoint}）`, 'warn') : i.edge ? V.chip('終端埠') : null,
      ]),
      findingsBlock(App, Q.findingsFor('interface', i.key)),
      kv([['描述', i.desc], ['RouterOS 類型', i.rawType], ['介面 MAC', i.hwMac ? K.macPretty(K.mac(i.hwMac) || i.hwMac) : null], ['預設名稱', i.defaultName && i.defaultName !== i.name ? i.defaultName : null],
        ['MTU', [['mtu', i.mtu], ['actual', i.actualMtu], ['l2mtu', i.l2mtu]].filter((x) => x[1] != null).map((x) => `${x[0]} ${x[1]}`).join('、') || null],
        ['IP', Q.addressesOf(i.key).join('、')], ['VRF', vrfOfIfc(Q, i)], ['埠模式', V.MODE[i.mode]], ['所屬聚合', i.lag ? epLink(App, i.lag) : null], ['所屬 Bridge', i.bridge ? epLink(App, i.bridge) : null],
        ['聚合成員', i.lagMembers.length ? h('span', null, i.lagMembers.flatMap((m, n) => [n ? '、' : '', epLink(App, m)])) : null],
        ['RSTP', i.stp ? [i.stp.role, i.stp.edge ? 'edge' : null, i.stp.designatedBridge ? `指定橋接器 ${K.macPretty(i.stp.designatedBridge)}` : null].filter(Boolean).join('・') : null],
        // bridge 的 vlan-filtering（事實）；介面在沒開 vlan-filtering 的 bridge 上（推論）時，pvid、frame-types、ingress-filtering 都沒有作用
        ['vlan-filtering', i.vlanFiltering == null ? null : i.vlanFiltering ? '開' : h('span', null, ['關', ' ', V.chip('VLAN 原樣轉送，不看也不改標籤', 'warn')])],
        ['所屬 bridge 的 VLAN 過濾', i.vlanUnfiltered && i.vlanFiltering == null ? h('span', null, ['沒開 vlan-filtering ', V.chip('推論', 'info')]) : null],
        ['PVID', i.pvid == null ? null : unfilteredNote(i, String(i.pvid))], ['frame-types', i.frameTypes ? unfilteredNote(i, i.frameTypes) : null],
        ['ingress-filtering', i.ingressFiltering == null ? null : unfilteredNote(i, i.ingressFiltering ? '開' : '關')],
        ['Untagged VLAN', i.untaggedVlans.length ? h('span', { class: 'vlanlist' }, vlanText(i.untaggedVlans)) : null],
        ['Tagged VLAN', i.taggedVlans.length ? h('span', { class: 'vlanlist' }, vlanText(i.taggedVlans)) : null], ['無法辨識的 VLAN', i.unresolvedVlans.join('、')],
        ['VLAN 子介面', i.parent ? h('span', null, [epLink(App, i.parent), ` 上的 VLAN ${i.encapVlan}`]) : null]]),
      section('鏈路', links.length ? linkTable(App, links, i.key) : null,
        { count: links.length, fold: true, open: links.some((l) => l.vlanMismatch || problem(Q.findingsFor('link', l.key))), extra: [problemChip(App, 'link', links.map((l) => l.key), '條')] }),
      inferredSection(App, inferred, i.dev),
      section('學到的 MAC', macs.length ? table([
        { t: 'MAC', f: (m) => macLink(App, m.mac) }, { t: '廠商', f: (m) => m.vendor || '' }, { t: 'IP', f: (m) => m.ips.join(', ') },
      ], macs, { limit: 500 }) : null, { count: macs.length, fold: true }),
      sourcesBlock(App, i.src),
    ]);
  }

  // ---------------------------------------------------------------- MAC / IP
  /*
   * MAC：事實（ARP 的 IP、Wi-Fi 關聯表與 DHCP）→ 位置（推論：終端埠、Wi-Fi 位置、推定在未收集交換器底下）→ 學到它的介面。
   * 學到它的介面只直接列出位置的錨點（終端埠、Wi-Fi 介面、推定位置的上一跳）；其餘是轉送路徑上的非終端埠，收合。
   */
  function mac(App, sel) {
    const Q = App.Q; const m = Q.findMac(sel.key);
    const place = [m.edge.length ? ['終端埠', h('span', null, m.edge.flatMap((ep, n) => [n ? '、' : '', epLink(App, ep)]))] : null,
      ...wifiPlaceRows(App, m.wifi), ...behindRows(App, m.behind, m.mac)].filter((p) => p && p[1] != null);
    const inferred = m.edge.length > 0 || !!m.behind || !!(m.wifi && m.wifi.basis !== 'registration');
    const anchor = (r) => m.edge.includes(r.ep) || (m.behind && m.behind.anchor === r.ep) || (m.wifi && m.wifi.ep === r.ep);
    const lead = m.seen.filter(anchor); const rest = m.seen.filter((r) => !anchor(r));
    // 所有列都相同的欄位不重複列：VLAN 全相同時寫在區塊標題，全部動態學到（預設）時不顯示類型欄
    const same = (f) => m.seen.every((r) => f(r) === f(m.seen[0]));
    const vlanSame = same((r) => r.vlan || ''); const typeSame = same((r) => !!r.static);
    const cols = (role) => [{ t: '設備介面', f: (r) => epLink(App, r.ep) }, vlanSame ? null : { t: 'VLAN', f: (r) => r.vlan || '' },
      typeSame ? null : { t: '類型', f: (r) => (r.static ? '靜態' : '動態') }, role ? { t: '', f: (r) => portRole(App, m, r.ep) } : null].filter(Boolean);
    const common = m.seen.length ? [vlanSame && m.seen[0].vlan ? V.chip('VLAN ' + m.seen[0].vlan) : null, typeSame && m.seen[0].static ? V.chip('靜態') : null] : [];
    return h('div', { class: 'detail' }, [
      h('h2', null, K.macPretty(m.mac)),
      h('div', { class: 'row' }, [m.found ? null : V.chip('基準中沒有這個 MAC', 'warn'), m.vendor ? V.chip(m.vendor) : V.chip('廠商不明')]),
      findingsBlock(App, Q.findingsFor('mac', m.mac)),
      kv([['IP（ARP）', m.ips.length ? h('span', null, m.ips.flatMap((x, n) => [n ? '、' : '', ipLink(App, x)])) : '—'], ...wifiFactRows(m.wifi)]),
      m.found ? section('位置', kv(place.length ? place : [['位置', '無法推定（沒有學到它的終端埠）']]),
        { extra: [inferred ? V.inferChip('依 MAC 表與鄰居資料推定，不是設備直接回報') : null] }) : null,
      // 位置在上方的屬性；學到它的介面是主題區塊（有問題時展開），轉送路徑上的非終端埠再收一層
      section('學到它的介面', m.seen.length ? [lead.length ? table(cols(true), lead) : null,
        section('其他非終端埠', rest.length ? [h('p', { class: 'muted' }, '這些埠學到多個 MAC 或接到網路設備，是轉送路徑上的埠，不是它的位置；不代表方向。'), table(cols(false), rest)] : null,
          { fold: true, count: rest.length, cls: 'mac-rest' })] : null,
      { count: m.seen.length, fold: true, open: problem(Q.findingsFor('mac', m.mac)), extra: common }),
    ]);
  }
  /** MAC 學到的位置屬於哪種埠；沒有方向依據，不標上行／下行 */
  function portRole(App, m, ep) {
    if (m.edge.includes(ep)) return V.chip('終端', 'ok');
    if (m.wifi && m.wifi.ep === ep) return V.chip('Wi-Fi', 'info');
    const b = m.behind;
    if (b && b.anchor === ep) return V.chip(`往 ${(b.dev ? [b.dev] : b.via).map((d) => App.Q.devName(d)).join('、')}（推定）`, 'info');
    return V.chip('非終端埠', '', { title: '這個埠學到多個 MAC 或接到網路設備，所以不是終端位置；不代表方向' });
  }
  /** 推定位置：在未收集交換器（例如 SwOS 的 CSS106）底下，精確到設備、埠不明。 */
  function behindRows(App, b, mk) {
    if (!b) return [];
    const where = b.dev ? h('span', null, ['在 ', devLink(App, b.dev), ' 底下（埠不明）']) : h('span', null, ['在 ', ...b.via.flatMap((v, n) => [n ? '、' : '', devLink(App, v)]), ' 或其下游（無法確定是哪一台）']);
    const via = App.Q.behindVia(mk);
    return [['推定位置', h('span', null, [where, ' ', V.chip('推定', 'info')])],
      ['推定依據', h('span', null, [epLink(App, b.anchor), ' 的 MAC 表學到它，且沒有在其他已收集交換器更下游出現；該交換器沒有收集資料，所以埠不明'])],
      ['經由', via.length ? h('span', null, via.flatMap((l, n) => [n ? '、' : '', inferredLink(App, l, K.splitEp(b.anchor)[0])])) : null]];
  }
  /** Wi-Fi 位置（位置區，推論）：依證據強度標示信心；漫遊時列出其他候選位置。 */
  function wifiPlaceRows(App, w) {
    if (!w) return [];
    const where = w.basis === 'via-ap-port' ? h('span', null, ['經由 ', devLink(App, w.dev), '（', epLink(App, w.ep), '）']) : epLink(App, w.ep);
    return [['Wi-Fi 位置', where], ['位置依據', h('span', null, [V.WIFI_BASIS[w.basis], w.roaming ? V.chip('可能漫遊', 'warn') : null])],
      ['其他候選位置', w.candidates.length ? h('span', null, w.candidates.flatMap((ep, n) => [n ? '、' : '', epLink(App, ep)])) : null]];
  }
  /** Wi-Fi 關聯表與 DHCP 收集到的事實（事實區） */
  function wifiFactRows(w) {
    if (!w) return [];
    return [['SSID／頻段', [w.ssid, w.band].filter(Boolean).join('・') || null], ['主機名稱（DHCP）', w.hostname], ['位址（DHCP）', w.ip],
      ['訊號', w.signal == null ? null : `${w.signal} dBm`]];
  }
  /**
   * IP：sel.vrf 為 null 時不分 VRF（Q.findIp(ip)，例如搜尋）；同一個 IP 在多個 VRF（位址重疊）時列出每個 VRF，請使用者選擇。
   * 選了 VRF 時只看那個 VRF（Q.findIp(ip, vrf)）。sel.vrf 不在基準中（換了基準）時改為不分 VRF並說明。
   */
  function ip(App, sel) {
    const Q = App.Q; const vrfs = Q.vrfs(); const multi = vrfs.length > 1; const MAIN = K.MAIN_VRF;
    const asked = sel.vrf == null ? null : K.vrf(sel.vrf);
    const want = asked && vrfs.includes(asked) ? asked : null;
    const r = Q.findIp(sel.key, want || undefined);
    if (!r) return h('div', { class: 'empty-detail' }, '不是有效的 IPv4 位址');
    const pick = !want && r.vrfs.length > 1; // 在多個 VRF：請使用者選擇
    const ownerText = (ep) => (ep.endsWith('|') ? h('span', null, [devLink(App, ep.slice(0, -1)), '（管理 IP）']) : epLink(App, ep));
    const vrfNote = (v) => (multi && !want ? `（${V.vrfText(v)}）` : '');
    const one = r.vrfs.length === 1 ? r.vrfs[0] : null;
    const traceVrf = want || one || '';
    const keys = (want ? [want] : r.vrfs.length ? r.vrfs : [MAIN]).map((v) => K.inVrf(r.ip, v));
    const choose = (v) => App.select(V.ipSel(r.ip, v), { focus: true });
    return h('div', { class: 'detail' }, [
      h('h2', null, want && want !== MAIN ? `${r.ip}@${want}` : r.ip),
      h('div', { class: 'row' }, [
        pick ? V.chip(`${V.num(r.vrfs.length)} 個 VRF 有這個位址（位址重疊）`, 'warn') : null,
        want && multi ? V.chip(V.vrfText(want)) : null,
        want && multi ? h('a', { class: 'link ip-all-vrfs', onclick: () => choose(null) }, '看所有 VRF') : null,
        asked && !want ? V.chip(`基準中沒有 VRF ${asked}，改列出所有 VRF`, 'warn') : null,
      ]),
      findingsBlock(App, keys.flatMap((k) => Q.findingsFor('ip', k))),
      // 同一個 IP 在多個 VRF：每個 VRF 一列（擁有者、網段、ARP），點一列只看那個 VRF
      section('這個 IP 在多個 VRF：選擇其中一個', pick ? [
        h('p', { class: 'muted' }, '不同 VRF 是不同的位址空間。點一列只看那個 VRF 的資料；路由追蹤與可達性查詢也要指定 VRF。'),
        table([
          { t: 'VRF', f: (v) => h('span', { class: 'mono' }, v) },
          { t: '設定在', f: (v) => { const o = r.owners.filter((x) => x.vrf === v); return o.length ? h('span', null, o.flatMap((x, n) => [n ? '、' : '', ownerText(x.ep)])) : '—'; } },
          { t: '所屬網段', f: (v) => h('span', { class: 'mono' }, S.util.uniq(r.subnets.filter((s) => s.vrf === v).map((s) => `${s.net}/${s.len}`)).join('、') || '—') },
          { t: 'ARP', f: (v) => V.num(r.arps.filter((a) => K.vrf(a.vrf) === v).length), cls: 'num' },
        ], r.vrfs, { onRow: (v) => choose(v), rowClass: () => 'ip-vrf-row' }),
      ] : null, { count: r.vrfs.length }),
      // 在多個 VRF 時，VRF、設定在、所屬網段已列在上方的選擇表，不再重複
      kv([['VRF', multi && !pick ? (want || r.vrfs.join('、') || '—') : null],
        ['設定在', pick ? null : r.owners.length ? h('span', null, r.owners.flatMap((x, n) => [n ? '、' : '', ownerText(x.ep), vrfNote(x.vrf)])) : '—'],
        ['所屬網段', pick ? null : r.subnets.length ? h('span', null, r.subnets.slice(0, 4).flatMap((s, n) => [n ? '、' : '', `${s.net}/${s.len}${vrfNote(s.vrf)} @ `, epLink(App, s.ep)])) : '—'],
        ['MAC（ARP）', r.macs.length ? h('span', null, r.macs.flatMap((m, n) => [n ? '、' : '', macLink(App, m)])) : '—'],
        ['位置（終端埠）', r.locations.length ? h('span', null, r.locations.flatMap((x, n) => [n ? '、' : '', epLink(App, x.ep)])) : '—']]),
      // 追蹤的 VRF 是來源的 VRF：從這個 IP 出發時，選了 VRF（或只在一個 VRF）就預先選好，在多個 VRF 又沒選時由追蹤畫面提示選擇；
      // 追蹤到這個 IP 時來源還不知道，交給來源位址決定
      h('div', { class: 'row spaced' }, [h('button', { onclick: () => App.openTrace(r.ip, '', traceVrf) }, '從這個 IP 追蹤路由'), h('button', { onclick: () => App.openTrace('', r.ip, '') }, '追蹤到這個 IP')]),
      section('ARP 紀錄', r.arps.length ? table([
        { t: '設備', f: (a) => devLink(App, a.dev) }, { t: '介面', f: (a) => a.ifc }, { t: 'MAC', f: (a) => macLink(App, a.mac) },
        ...(multi ? [{ t: 'VRF', f: (a) => K.vrf(a.vrf) }] : []),
      ], r.arps) : null, { count: r.arps.length, fold: true }),
    ]);
  }

  // ---------------------------------------------------------------- VLAN
  function vlan(App, sel) {
    const Q = App.Q; const v = Q.vlan(sel.key, sel.domain);
    const partialFl = [].concat(...v.partial.map((l) => Q.findingsFor('link', l.key)));
    const fl = Q.findingsFor('vlan', String(v.id)).concat(partialFl);
    const split = v.domains.length > 1; const at = v.domains.findIndex((d) => d.key === v.domain);
    const domainName = (d, idx) => `${V.TERMS.vlanDomain} ${idx + 1}：${d.devices.slice(0, 3).map((k) => Q.devName(k)).join('、')}`
      + (d.devices.length > 3 ? ` 等 ${d.devices.length} 台` : '');
    return h('div', { class: 'detail' }, [
      h('h2', null, 'VLAN ' + v.id + (at >= 0 ? `（${V.TERMS.vlanDomain} ${at + 1}／${v.domains.length}）` : '')),
      h('div', { class: 'row' }, [
        V.chip(`${v.devices.length} 台設備`), V.chip(`${v.carry.length} 條鏈路兩端都有此 VLAN`, '', { title: '兩端介面都設定了這個 VLAN 的鏈路數；不是檢查結果' }),
        v.inferred.length ? V.chip(`${v.inferred.length} 條推論鏈路`, 'info') : null,
        V.stateChip(v.partial.length, '條只有一端有', V.worstSev(partialFl)),
        split ? V.chip(`${v.domains.length} 個不相連的 ${V.TERMS.vlanDomain}（${V.TERMS.inferred}）`, 'warn') : null,
      ]),
      findingsBlock(App, fl),
      // 沒有任何設備設定名稱時不列（不顯示「名稱 —」）
      kv([['名稱', v.names.length ? v.names.join('、') : null]]),
      aboutSection(['圖上（設備圖與 L2 埠圖）：兩端都帶此 VLAN 的鏈路是實線，推論鏈路是長虛線（推論）；只有一端帶的是錯誤色並在中點標方形；'
        + '只有一端可確認（對端未收集、沒有 VLAN 資料或' + V.TERMS.hearsay + '）是淡色點線（推論）。'
        + '在工具列的 VLAN 選單選的篩選會保留，直到選「不篩選」；由檢查結果、搜尋或連結選的，選其他東西或換基準時取消，也可以按工具列旁的「VLAN n ✕」取消。',
      split ? '同一個 VLAN ID 的設備之間沒有承載此 VLAN 的鏈路相連，可能是各自獨立的廣播網域（例如不同站點重用 VLAN ID），'
        + '也可能只是中間有沒收集、沒有 LLDP 的設備。' + V.TERMS.vlanDomain + '是依鏈路證據的推論。' : null]),
      // 只有一端有（事實，V01）：鏈路表格，加「有此 VLAN 的一端」；兩端都有 VLAN 資料，是不一致，預設展開
      section('只有一端有此 VLAN 的鏈路', v.partial.length ? linkTable(App, v.partial, null, [{ t: '有此 VLAN 的一端', f: (l) => h('span', { class: 'mono' }, Q.epName(l.vlansA.includes(v.id) ? l.a : l.b)) }]) : null,
        { count: v.partial.length, fold: true, open: v.partial.some((l) => l.vlanMismatch || problem(Q.findingsFor('link', l.key))) }),
      oneSideSection(App, Q.vlanCarriers(v.id, sel.domain)),
      section('設備', table([
        { t: '設備', f: (d) => devLink(App, d) },
        { t: '名稱', f: (d) => (v.entries.find((e) => e.dev === d) || {}).name || '' },
        { t: '成員介面', f: (d) => String((v.entries.find((e) => e.dev === d) || { members: [] }).members.length) },
      ], v.devices),
        { count: v.devices.length, fold: true }),
      // 目前在某個片段時預設展開（定位的列）；改看全部片段的連結在標題列
      section(`不相連的 ${V.TERMS.vlanDomain}（${V.TERMS.inferred}）`, split ? v.domains.map((d, idx) => h('div', null, d.key === v.domain
        ? h('b', { 'aria-current': 'true' }, domainName(d, idx))
        : L(App, domainName(d, idx), { type: 'vlan', key: String(v.id), domain: d.key }))) : null,
      { count: v.domains.length, fold: true, open: at >= 0, extra: [at >= 0 ? L(App, '顯示所有 ' + V.TERMS.vlanDomain, { type: 'vlan', key: String(v.id) }) : null] }),
    ]);
  }

  /** VLAN 承載中屬於推論的鏈路（Q.vlanCarriers 的 oneSide）：列出兩端與原因；Q.vlan 的「只有一端有」是兩端都有資料的事實，不在這裡 */
  function oneSideSection(App, c) {
    const Q = App.Q; const rows = c.links.filter((l) => l.status === 'oneSide');
    // 鏈路一律用同一種表格（linkTable）：原因接在後面
    const reason = new Map(rows.map((l) => [l.key, l.reason])); const links = rows.map((l) => Q.getLink(l.key)).filter(Boolean);
    if (links.length !== rows.length) throw new Error('Q.vlanCarriers 的 oneSide 鏈路在基準中找不到：' + rows.filter((l) => !Q.getLink(l.key)).map((l) => l.key).join('、'));
    return section('只有一端可確認的鏈路（推論）', rows.length ? [
      h('p', { class: 'muted' }, '至少一端無從得知是否帶這個 VLAN（未開 vlan-filtering 的 bridge 串接時兩端都無從得知）：不算 VLAN 不一致（V01）。'),
      linkTable(App, links, null, [{ t: '原因', f: (l) => V.VLAN_REASON[reason.get(l.key)] || reason.get(l.key) }]),
    ] : null, { count: rows.length, fold: true });
  }

  // ---------------------------------------------------------------- L3 子網
  /** 子網的查詢結果依 Q 建一次索引（Q.subnetGraph 已快取；這裡只依網段分組，不改它的結果） */
  const subnetIndexes = new WeakMap();
  function subnetIndex(Q) {
    let x = subnetIndexes.get(Q);
    if (!x) {
      const g = Q.subnetGraph({ routes: true }); const edges = new Map(); const routes = new Map();
      g.edges.forEach((e) => S.util.getOr(edges, e.subnet, () => []).push(e));
      g.routes.forEach((r) => S.util.getOr(routes, r.subnet, () => []).push(r));
      x = { byId: new Map(g.subnets.map((s) => [s.id, s])), edges, routes };
      subnetIndexes.set(Q, x);
    }
    return x;
  }
  const subnetLink = (App, id) => L(App, id, { type: 'subnet', key: id });
  /** 子網：位址（設在哪個介面、依據與來源行）、設備與路由設備、重疊網段、重複 IP、路由到這個網段的設備 */
  function subnet(App, sel) {
    const Q = App.Q; const X = subnetIndex(Q); const s = X.byId.get(sel.key);
    if (!s) return h('div', { class: 'empty-detail' }, '基準中沒有這個網段');
    const rows = (X.edges.get(s.id) || []).flatMap((e) => e.addresses.map((a) => ({ e, a })))
      .sort((x, y) => S.util.natural(x.a.ip || '', y.a.ip || '') || S.util.natural(x.e.dev, y.e.dev));
    const dup = new Set(s.duplicateIps);
    const routes = X.routes.get(s.id) || [];
    // 檢查結果：重複 IP（A09，以 IP 為實體）與這個網段或重疊網段的 A07、A08（facet 是網段）
    const nets = new Set([s.id].concat(s.overlaps));
    // IP 實體與 A07／A08 的 facet 都是含 VRF 的鍵（K.inVrf；子網 id 就是網段鍵）
    const dupFl = s.duplicateIps.flatMap((ip) => Q.findingsFor('ip', K.inVrf(ip, s.vrf)));
    const overlapFl = ['A07', 'A08'].flatMap((id) => Q.findingsByRule(id)).filter((f) => nets.has(f.facet));
    const fl = dupFl.concat(overlapFl);
    const relation = (o) => { const x = X.byId.get(o); return x && x.len < s.len ? '包含這個網段' : '在這個網段內'; };
    const others = Array.from(X.byId.values()).filter((x) => x.prefix === s.prefix && x.id !== s.id); // 其他 VRF 的同一個網段
    const src = S.util.uniq(rows.flatMap((r) => r.a.src.map((x) => x.join(':')))).map((k) => k.split(':').map(Number));
    return h('div', { class: 'detail' }, [
      h('h2', null, s.id),
      h('div', { class: 'row' }, [
        V.chip(s.basis === 'route' ? '只由路由得知（不是直連網段）' : '直連網段', s.basis === 'route' ? 'info' : ''),
        s.vlan != null ? V.chip('VLAN ' + s.vlan) : null,
        V.chip(`${s.devices.length} 台設備`),
        s.routers.length ? V.chip(`${s.routers.length} 台路由設備（推論）`, 'info') : null,
        V.stateChip(s.overlaps.length, '個網段重疊', V.worstSev(overlapFl) || 'warn'),
        V.stateChip(s.duplicateIps.length, '個重複 IP', V.worstSev(dupFl) || 'warn'),
      ]),
      findingsBlock(App, fl),
      kv([['網段', h('span', { class: 'mono' }, s.prefix)], ['VLAN', s.vlans.length ? h('span', { class: 'vlanlist' }, vlanText(s.vlans)) : null],
        ['路由設備', s.routers.length ? h('span', null, s.routers.flatMap((d, n) => [n ? '、' : '', devLink(App, d)])) : null],
        ['閘道（DHCP 網路）', s.gateways.length ? h('span', null, s.gateways.flatMap((g, n) => [n ? '、' : '', ipLink(App, g.ip, s.vrf), `（${Q.devName(g.dev)}）`])) : null],
        // VRF 是容器（ADR-015）：同一個網段在不同 VRF 是不同的子網（id 是網段鍵，main 以外加 @<VRF>）
        ['VRF', h('span', null, [h('span', { class: 'mono' }, s.vrf), others.length ? h('span', { class: 'muted' }, ['（同一個網段也在 ', ...others.flatMap((o, n) => [n ? '、' : '', subnetLink(App, o.id)]), '，是不同的位址空間）']) : null])]]),
      section('位址', rows.length ? table([
        { t: 'IP', f: (r) => h('span', { class: dup.has(r.a.ip) ? 'mono diffA' : 'mono' }, r.a.address + (dup.has(r.a.ip) ? '（重複）' : '')), s: (r) => r.a.ip },
        { t: '設備／介面', f: (r) => (r.a.ep ? epLink(App, r.a.ep) : h('span', null, [devLink(App, r.e.dev), '（管理 IP）'])), s: (r) => Q.devName(r.e.dev) },
        { t: '依據', f: (r) => h('span', null, [V.L3_BASIS[r.e.basis], r.a.role ? `・${r.a.role.toUpperCase()}` : '', r.e.inferred ? ' ' : '', r.e.inferred ? V.chip('推論', 'info') : null,
          r.a.seenBy && r.a.seenBy.length ? h('span', { class: 'muted' }, `（由 ${r.a.seenBy.map((d) => Q.devName(d)).join('、')} 看到）`) : null]), s: (r) => r.e.basis },
        { t: '來源', f: (r) => srcLink(App, r.a.src) },
      ], rows, { limit: 500, bad: (r) => dup.has(r.a.ip) }) : null, { count: rows.length, fold: true, open: dup.size > 0 }),
      section('設備', s.devices.length ? devChips(App, s.devices) : null, { count: s.devices.length, fold: true }),
      // 重疊與重複 IP 是問題（A07–A09）：有就預設展開，列標 bad
      section('重疊網段', s.overlaps.length ? s.overlaps.map((o) => h('div', { class: 'bad-line' }, [subnetLink(App, o), h('span', { class: 'muted' }, '　' + relation(o))])) : null,
        { count: s.overlaps.length, fold: true, open: true }),
      section('重複 IP', s.duplicateIps.length ? s.duplicateIps.map((ip) => h('div', { class: 'bad-line' }, [ipLink(App, ip, s.vrf), '：',
        ...rows.filter((r) => r.a.ip === ip && r.a.ep).flatMap((r, n) => [n ? '、' : '', epLink(App, r.a.ep)])])) : null, { count: s.duplicateIps.length, fold: true, open: true }),
      section('路由到這個網段', routes.length ? table([
        { t: '設備', f: (r) => devLink(App, r.dev) },
        { t: '協定', f: (r) => (r.blackhole ? h('span', { class: 'diffA' }, '黑洞路由') : r.proto + (r.default ? '（預設路由）' : '')) },
        ...(multiVrf(Q) ? [{ t: '路由表', f: (r) => h('span', { class: 'mono' }, r.routingTable) }] : []),
        { t: '下一跳', f: (r) => nhCell(r, multiVrf(Q)) },
        { t: '經由', f: (r) => h('span', null, r.via.flatMap((v, n) => [n ? '、' : '', subnetLink(App, v)])) },
      ], routes, { limit: 200 }) : null, { count: routes.length, fold: true }),
      sourcesBlock(App, src),
    ]);
  }

  // ---------------------------------------------------------------- L3 的外部（對外邊界）
  /**
   * 外部（{ type: 'boundary', key: VRF, dev? }）：這個 VRF 中判定對外與可能對外的介面（Q.boundaries，推論，ADR-023），
   * 每個介面列出依據（Q.boundaryOf 的 evidence：種類、強弱、不算的原因與來源行）。給了 dev（點設備到外部的線）時只列那台，
   * 並可改看整個 VRF。判定的規則寫在「這是什麼？」。
   */
  function boundary(App, sel) {
    const Q = App.Q; const multi = multiVrf(Q);
    const list = V.app.boundariesOf(Q, sel).map((b) => Q.boundaryOf(b.ep) || b);
    const title = '外部' + (multi ? `（${V.vrfText(sel.key)}）` : '');
    if (!list.length) return h('div', { class: 'empty-detail' }, sel.dev ? `${Q.devName(sel.dev)} 在這個 VRF 沒有判定對外的介面` : '這個 VRF 沒有判定對外的介面');
    const ext = list.filter((b) => b.status === 'external'); const pos = list.filter((b) => b.status === 'possible');
    const fl = S.util.uniq(list.flatMap((b) => Q.findingsFor('interface', b.ep)));
    const STRENGTH_CLS = { strong: 'info', weak: '', none: '' };
    const evLine = (ev) => h('div', { class: 'boundary-ev' }, [
      h('span', null, V.boundaryEvidenceText(ev.kind)), ' ', V.chip(V.BOUNDARY_STRENGTH[ev.strength] || ev.strength, STRENGTH_CLS[ev.strength] || '', { title: '證據的強弱：強證據單獨就判定對外' }),
      ev.ref && ev.ref.reason ? h('span', { class: 'muted' }, `（${V.BOUNDARY_REASON[ev.ref.reason] || ev.ref.reason}）`) : null,
      ' ', srcLink(App, ev.src),
    ]);
    const devs = S.util.uniq(list.map((b) => b.dev));
    return h('div', { class: 'detail' }, [
      h('h2', null, [title, ' ', V.inferChip('依路由、NAT 與位址推論的對外邊界，不是收集到的事實')]),
      h('div', { class: 'row' }, [
        V.chip(`${devs.length} 台設備`),
        ext.length ? V.chip(`${V.num(ext.length)} 個介面對外`, 'info') : null,
        pos.length ? V.chip(`${V.num(pos.length)} 個介面可能對外`, 'warn') : null,
      ]),
      kv([['VRF', multi ? h('span', { class: 'mono' }, sel.key) : null],
        ['設備', sel.dev ? devLink(App, sel.dev) : null]]),
      // 點外部最想看的是為什麼判定對外：依據在檢查結果之前；這是本頁的主體（一般區塊），改看整個 VRF 的連結在標題列
      section('對外介面與依據', table([
        // 基準沒有介面紀錄的（例如只出現在 /ip dhcp-client 的介面）註明，不做成點了沒反應的連結
        { t: '介面', f: (b) => (b.hasIfc ? epLink(App, b.ep) : h('span', null, [devLink(App, b.dev), ' ', h('span', { class: 'mono' }, K.splitEp(b.ep)[1]),
          h('span', { class: 'muted boundary-noifc', title: '介面清單（/interface）沒有這個介面；它只出現在依據列出的設定（例如 /ip dhcp-client）' }, '（基準中沒有介面資料）')])), s: (b) => b.ep },
        { t: '判定', f: (b) => V.chip(V.BOUNDARY_STATUS[b.status] || b.status, b.status === 'external' ? 'info' : 'warn'), s: (b) => b.status },
        { t: '依據', f: (b) => h('div', null, b.evidence.map(evLine)) },
      ], list.slice().sort((a, b) => (a.status === b.status ? 0 : a.status === 'external' ? -1 : 1) || S.util.natural(a.ep, b.ep)), { limit: 500 }),
      { count: list.length, extra: [sel.dev ? L(App, '看這個 VRF 的全部', { type: 'boundary', key: sel.key }) : null] }),
      findingsBlock(App, fl),
      aboutSection([
        '外部是虛擬節點：基準看不到線路的另一端，依各介面的證據推論哪些介面通往外部。',
        '強證據單獨就判定對外：預設路由的出介面（下一跳不在基準內）、DHCP／PPPoE client 加入的預設路由、srcnat（masquerade／src-nat）的出介面、dst-nat 的入介面。',
        '弱證據：介面上的公網位址、CGNAT 位址、dst-nat 的目的位址、WAN 清單的名稱。只有弱證據時，WAN 清單的成員仍判定對外，其他只標「可能對外」。',
        '圖上設備到外部的線：實線是對外、長虛線是可能對外，預設路由經這裡出去時是路由的虛線加箭頭。',
      ]),
    ]);
  }

  // ---------------------------------------------------------------- 路由追蹤
  /** 策略路由規則（trace 的 hops[].rule、ends[].rule／rules）：規則文字與來源連結 */
  const ruleLine = (App, r) => h('div', { class: 'muted trace-rule' }, [routingRuleText(r), ' ', srcLink(App, r.src)]);
  /**
   * 一個方向的逐跳與結果（去程、回程共用；prefix 區分標題）。
   * 每一跳標出它的 VRF、查的路由表（不是 VRF 的表時）與決定查表的 /routing rule；基準只有 main 時不標 VRF，與加入 VRF 之前相同。
   * 策略路由不明（policy）與被 /routing rule 丟棄（policy-drop）的結果列出相關的規則。
   */
  function tracePath(App, t, prefix) {
    const Q = App.Q; const multi = multiVrf(Q); const p = prefix || '';
    const vrfChip = (v) => (multi && v ? V.chip(V.vrfText(v), 'trace-vrf') : null);
    // 下一跳的說明：正常是 muted；送往外部（推論，不是錯誤）用 info 樣式；其餘（不在基準內、迴圈…）是錯誤色
    const noteCls = (n) => (n.status === 'ok' || n.status === 'connected' ? 'muted' : n.status === 'egress' ? 'trace-egress' : 'diffA');
    const hopEl = (hp) => h('div', { class: 'hop', 'data-vrf': hp.vrf || null, 'data-dev': hp.dev }, [
      h('div', null, [h('b', null, devLink(App, hp.dev)), multi ? ' ' : null, vrfChip(hp.vrf),
        hp.table && hp.table !== hp.vrf ? V.chip(`路由表 ${hp.table}`, 'info', { title: '依 /routing rule 查的策略路由表' }) : null,
        hp.via && hp.via.length > 1 ? V.chip(`經 VRF 介面 ${hp.via.join(' → ')}`, 'info') : null,
        h('span', { class: 'mono muted' }, `  ${hp.route}（${hp.proto}）`), hp.ecmp ? V.chip('ECMP', 'info') : null]),
      hp.rule ? ruleLine(App, hp.rule) : null,
      ...hp.next.map((n) => h('div', { class: 'mono trace-next', 'data-status': n.status || null }, [
        `→ ${n.ip || ''} ${n.ifc || ''} `,
        n.dev ? devLink(App, n.dev) : null, n.dev && multi && n.vrf ? h('span', { class: 'muted' }, ` @${n.vrf}`) : null,
        n.crossVrf ? ' ' : null, n.crossVrf ? V.chip('推論', 'info', { title: '對方的這個位址在另一個 VRF，網段相同' }) : null,
        n.note ? h('span', { class: noteCls(n) }, '  ' + n.note) : null,
      ])),
    ]);
    const endEl = (e) => h('div', { class: 'hop ' + V.TRACE_END_STYLE[V.traceEndKind(e)].cls, 'data-status': e.status }, [
      h('b', null, devLink(App, e.dev)), multi && e.vrf ? `（${V.vrfText(e.vrf)}）` : '', `：${V.TRACE_END[e.status] || e.status}`, traceWhy(App, e), h('div', { class: 'muted' }, e.note),
      ...(e.rules || []).map((r) => ruleLine(App, r)), e.rule ? ruleLine(App, e.rule) : null,
    ]);
    const starts = t.starts && t.starts.length ? t.starts : [t.start];
    if (starts.length < 2) {
      return [section(`${p}逐跳`, t.hops.map(hopEl), { count: t.hops.length }), section(`${p}結果`, t.ends.map(endEl), { count: t.ends.length })];
    }
    // 多起點（同一個網段有多台閘道）：依起點分組，每個起點一段時間線（逐跳＋結果），不把兩台的單跳排成同一條看起來依序經過的線。
    // 終點的 path 第一台是它的起點；一跳屬於經過它的起點（ECMP 匯合的設備會出現在兩段）
    const why = traceStartWhy(t);
    return starts.map((s) => {
      const ends = t.ends.filter((e) => (e.path && e.path.length ? e.path[0] : e.dev) === s);
      const devs = new Set(ends.flatMap((e) => (e.path && e.path.length ? e.path : [e.dev])));
      const hops = t.hops.filter((hp) => devs.has(hp.dev));
      // 同一份資料不換結構：每個起點一段，段內是和單起點相同的「逐跳」「結果」區塊（巢狀的 section）
      // 這個起點沒有逐跳也沒有結果時（兩個子區塊都不產生）仍留一段寫明，不讓起點消失
      const subs = [section('逐跳', hops.map(hopEl), { count: hops.length, cls: 'trace-sub' }),
        section('結果', ends.map(endEl), { count: ends.length, cls: 'trace-sub' })];
      const el = section(`${p}從 ${Q.devName(s)}（${why}）`,
        subs.some(Boolean) ? subs : h('p', { class: 'muted trace-empty' }, '這個起點沒有可列出的逐跳與結果。'), { cls: 'trace-group' });
      el.setAttribute('data-start', s);
      return el;
    });
  }
  /**
   * 這次追蹤的前提（路由層，S.query.traceAssumptions）：只列這份基準有影響的（Q.assumptionUse；短句＋影響），其他收合。
   * 每條有 id（trace-assume-<code>），結果旁的「為什麼」展開這段並聚焦那一條
   */
  const traceAssume = (App) => {
    const b = V.assumeBlock(App, S.query.traceAssumptions(), { idPrefix: 'trace-assume-', none: '這份基準沒有會影響路由追蹤的前提。' });
    // 有影響的條數不是列數：標題列的狀態 chip（0 不顯示）；L4 的「這次查詢的前提」同一寫法
    return section('這次追蹤的前提', h('div', { class: 'trace-assume' }, [b.list, b.other].filter(Boolean)), { fold: true, extra: [V.stateChip(b.shown.length, '條有影響')] });
  };
  /**
   * 結果旁的「為什麼」：ends[].status 對到的前提（S.query.traceEndStatuses；策略路由依 ends[].assumption，送往外部以外的 reason 依 reasons），
   * 只連路由層的前提（這次追蹤的前提列的那幾條）
   */
  let endAssume = null;
  function traceWhy(App, e) {
    if (!endAssume) endAssume = new Map(S.query.traceEndStatuses().map((x) => [x.status, x]));
    const d = endAssume.get(e.status); if (!d) return null;
    const raw = typeof e.assumption === 'string' ? e.assumption : (d.reasons && e.reason && d.reasons[e.reason]) || d.assumption;
    const cs = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((c) => S.query.traceAssumptions().some((a) => a.code === c));
    const use = V.assumeUse(App.Q); const c = cs.find((x) => V.assumeAffects(use.get(x))) || cs[0];
    if (!c) return null;
    const w = V.whyLink(c, 'trace-why', (x) => V.revealAssume(V.$('#trace-assume-' + x)));
    return w ? h('span', null, [' ', w]) : null;
  }
  /**
   * 整體結果的標籤：分類同 V.traceEndKind（S.trace 的 status），停在未收集的設備是「無法驗證」（灰色），
   * 經 WAN 送往基準以外是「送往外部（推論）」（之後由電信業者決定），兩者都不是錯誤。
   */
  const traceChip = (App, t, prefix) => {
    const k = V.traceEndKind(t);
    return k === 'reached' ? V.chip(`${prefix}可抵達`, 'ok')
      : k === 'external' ? V.chip(`${prefix}${V.TRACE_END.egress}`, 'info', { title: '經 WAN 介面送往基準以外的下一跳，之後由電信業者決定' })
        : k === 'unverified' ? V.chip(`${prefix}無法驗證（${t.unverified.map((d) => App.Q.devName(d)).join('、')} 未收集）`, 'unverified')
          : V.chip(`${prefix}無法完整抵達`, 'err');
  };
  /**
   * 起點：S.trace 的 starts（同一個依據有多台閘道時每一台都是起點）與依據（startBasis；device 是來源設備自己的位址）。
   * 舊的結果沒有 starts 時只寫 start。
   */
  const traceStartWhy = (t) => (t.startBasis === 'device' ? V.REACH_START.device
    : '來源所在網段的閘道' + (t.startBasis ? '，' + (V.REACH_START_BASIS[t.startBasis] || t.startBasis) : ''));
  const traceStart = (App, t) => {
    const ds = t.starts && t.starts.length ? t.starts : [t.start];
    const why = traceStartWhy(t);
    return h('span', { class: 'trace-start' }, [...ds.flatMap((d, n) => [n ? '、' : '', devLink(App, d)]),
      `（${why}${ds.length > 1 ? `；${V.num(ds.length)} 台都當起點` : ''}）`]);
  };
  /**
   * 追蹤失敗的說明：起點在多個 VRF（S.trace 回傳 vrfs）時改寫成要怎麼做（在路由追蹤的 VRF 選單指定）並附開啟表單的按鈕，
   * 不顯示查詢層的原始字串；其他原因照 S.trace 的中文訊息
   */
  function traceError(App, r, what, from) {
    if (!r.vrfs) return h('p', { class: 'diffA' }, r.error);
    return h('div', { class: 'trace-error' }, [
      h('p', { class: 'warn-line' }, `${what}的起點${from ? ' ' + from : ''}在多個 VRF（${r.vrfs.map(V.vrfText).join('、')}，位址重疊），無法判斷從哪一個開始。請在路由追蹤的 VRF 選單指定 VRF，再追蹤一次。`),
      // 表單保留上次的來源與目的，只要選 VRF
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => App.openTrace() }, '指定 VRF 再追蹤…')),
    ]);
  }
  function trace(App, sel) {
    const t = sel.result; const back = sel.reverse; const multi = multiVrf(App.Q); const outside = sel.reverseSkip === 'external';
    if (!t.ok) return h('div', { class: 'detail' }, [h('h2', null, '路由追蹤'), traceError(App, t, '去程', '')]);
    // 非對稱：回程經過的設備順序和去程反過來不同
    const devs = (x) => x.hops.map((hp) => hp.dev);
    const asym = back && back.ok && devs(back).join('>') !== devs(t).slice().reverse().join('>');
    return h('div', { class: 'detail' }, [
      h('h2', null, `${t.src} → ${t.dst}`),
      h('div', { class: 'row' }, [traceChip(App, t, ''), t.hops.some((x) => x.ecmp) ? V.chip('含 ECMP', 'info') : null,
        back ? (back.ok ? traceChip(App, back, '回程') : back.vrfs ? V.chip('回程需要指定 VRF', 'warn') : V.chip('回程無法完整抵達', 'err')) : null,
        // 去程全部送往外部：回程不追（起點在基準外），中性標籤
        outside ? V.chip('回程由電信業者決定（推論）', 'info', { title: V.TRACE_RETURN_EXTERNAL }) : null, asym ? V.chip('非對稱路徑', 'warn') : null,
        t.ends.some((e) => e.status === 'policy') ? V.chip('策略路由不明', 'warn') : null]),
      kv([['起點', traceStart(App, t)],
        ['VRF', multi ? `${t.vrf}（${sel.vrf ? '指定' : '依來源位址決定'}）` : null]]),
      ...tracePath(App, t),
      back ? section(`回程（${t.dst} → ${t.src}）`, back.ok ? kv([['起點', traceStart(App, back)], ['VRF', multi ? back.vrf : null], ['說明', '無狀態的 ACL 需要確認回程也能通過']]) : traceError(App, back, '回程', t.dst)) : null,
      ...(back && back.ok ? tracePath(App, back, '回程') : []),
      outside ? section(`回程（${t.dst} → ${t.src}）`, h('p', { class: 'muted trace-return-ext' }, V.TRACE_RETURN_EXTERNAL + '。回程的起點不在基準內，沒有追蹤。')) : null,
      // 去程與回程（主體，一般區塊）之後才是收合的前提，不把一般區塊夾在展開列之間
      traceAssume(App),
    ]);
  }

  // 其他詳情畫面（panels/firewall.js）共用的片段：區塊一律經 section() 產生
  V.details = { render, parts: { section, kv, L, devLink, epLink, findingsBlock, adviceBlock } };
})(globalThis.SSOT = globalThis.SSOT || {});
