/*
 * 右側：選中項目的詳細資料。所有內容都從查詢介面（Q）取得，並附上來源（可開啟原文）。
 * 支援：device、link、pair（同兩台設備間多條鏈路）、interface、mac、ip、vlan、subnet（L3 子網圖）、trace、route，
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
    const fn = { device, link, pair, interface: iface, endpoints, mac, ip, vlan, subnet, trace, firewall: fw, rule: fw, service: fw }[sel.type];
    root.appendChild(fn ? fn(App, sel) : h('div', { class: 'empty-detail' }, '無法顯示'));
    root.scrollTop = 0;
    // 定位到某一列時（例如防火牆規則），把它捲到畫面中間
    const focus = root.querySelector('.focus'); if (focus) focus.scrollIntoView({ block: 'center' });
  }

  // ---------------------------------------------------------------- 共用片段
  const L = (App, text, sel) => h('a', { class: 'link', onclick: () => App.select(sel, { focus: true }) }, text);
  const devLink = (App, k) => L(App, App.Q.devName(k), { type: 'device', key: k });
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
  /** /routing rule 的文字：第幾條、條件、action 與路由表 */
  const routingRuleText = (r) => `/routing rule 第 ${r.order} 條：${Object.entries(r.match).map(([k, v]) => `${k}=${v}`).join(' ') || '（沒有條件）'} action=${r.action}${r.table ? ' table=' + r.table : ''}${r.comment ? `（${r.comment}）` : ''}`;
  const kv = (pairs) => h('div', { class: 'kv' }, pairs.filter((p) => p && p[1] !== null && p[1] !== undefined && p[1] !== '').flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', null, v)]));
  /**
   * 詳情區塊的唯一產生方式：標題與筆數只在這裡產生，內容函式只回傳內容、不自帶標題（避免標題重複）。
   *   section(標題, 內容, { count, extra, fold, open })
   *   - 內容為 null、false 或空陣列時，整個區塊不顯示
   *   - count：標題旁的筆數；列表類區塊一律提供
   *   - fold：可展開區塊（標題在展開列，open 決定預設展開）；否則為一般區塊（h3 標題）
   *   - long：長列表；count 超過 LONG_ROWS 時改為預設收合的展開區塊，只在展開列顯示筆數
   */
  const LONG_ROWS = 8;
  function section(title, content, opt) {
    const o = opt || {};
    if (content == null || content === false || (Array.isArray(content) && !content.length)) return null;
    const fold = o.fold || (o.long && o.count > LONG_ROWS);
    // 展開列內的連結（例如「在圖上看」）只執行自己的動作，不順便切換展開
    const extra = (o.extra || []).map((x) => (fold && x ? h('span', { onclick: (e) => { if (e && e.preventDefault) e.preventDefault(); } }, x) : x));
    const head = [title, o.count == null ? null : V.chip(String(o.count)), ...extra];
    const body = Array.isArray(content) ? h('div', null, content) : content;
    return fold
      ? h('details', { class: 'detail-fold', open: !!o.open }, [h('summary', null, head), body])
      : h('div', { class: 'detail-section' }, [h('h3', null, head), body]);
  }
  /** 說明段落（圖例、名詞解釋）：每次選取都一樣，收進預設收合的「這是什麼？」，不佔詳細資料的首屏 */
  const aboutSection = (paras) => section('這是什麼？', paras.filter(Boolean).map((t) => h('p', { class: 'muted' }, t)), { fold: true });
  const vlanText = (ids) => (ids && ids.length ? S.util.fmtVlans(ids) : '—');
  // 右欄表格：V.table 已包可橫向捲動的 .table-scroll，識別字不逐字斷行
  const table = V.table;

  /*
   * 每個詳情頁的區塊順序一致：
   *   標題 → 標籤 → 檢查結果 → 屬性 → 說明 → 主題區塊（同一主題先事實、後推論，例如鏈路 → 推論鏈路）→ 來源
   * 檢查結果放在屬性之前：選取物件多半是為了看它的問題。
   * 推論的區塊一律用 inferredSection 等共用元件，標題與說明只寫一次；列表類區塊加 long，超過 LONG_ROWS 筆時預設收合。
   */
  /** kv 中的推定值：值後面加「推論」chip，和同一張表裡收集到的事實區分 */
  const inferred = (value, tip) => h('span', null, [value, ' ', V.inferChip(tip)]);
  /** 推論鏈路區塊：說明推論的意義，列出兩端、依據與信心 */
  function inferredSection(App, list, from, opt) {
    return section('推論鏈路（沒有 LLDP）', list.length ? [h('p', { class: 'muted' }, '依 MAC 表、MNDP、RSTP 或點對點網段推定相鄰：是直接相連，或中間只有非網管型設備。不影響任何檢查。'),
      inferredTable(App, list, from)] : null, Object.assign({ count: list.length }, opt || {}));
  }
  function findingsBlock(App, list) {
    if (!list.length) return null;
    const seen = new Set(); const uniq = list.filter((f) => (seen.has(f) ? false : seen.add(f)));
    const order = { error: 0, warn: 1, info: 2 };
    uniq.sort((a, b) => order[a.severity] - order[b.severity]);
    const item = (f) => h('div', { class: 'finding' }, [
      V.sevDot(f.severity),
      h('div', null, [h('div', null, [h('b', null, f.title), ...facetChip(f)]), h('div', null, f.message),
        V.deviationLine(App, f.deviation), ledgerLine(f), V.remediation.hintLine(f.id), adviceBlock(f.id),
        f.evidence.length ? h('div', { class: f.id === 'C02' ? 'ev stack' : 'ev' }, evidenceLinks(App, f)) : null]),
    ]);
    // 先顯示最嚴重的幾筆，其餘收進同一個 section() 展開機制，避免檢查結果把屬性推到很下面
    const rest = uniq.slice(FINDINGS_SHOWN);
    const el = section('檢查結果', [...uniq.slice(0, FINDINGS_SHOWN).map(item),
      rest.length ? section(`再顯示 ${rest.length} 筆`, rest.map(item), { fold: true }) : null], { count: uniq.length });
    el.classList.add('findings-section');
    return el;
  }
  const FINDINGS_SHOWN = 5;
  /** 檢查項目（finding.facet，V.remediation.facetText）：標題旁的標籤（回傳子節點陣列，展開放入標題列），title 是原值；沒有 facet 時為空陣列 */
  function facetChip(f) {
    const t = V.remediation.facetText(f);
    return t ? [' ', V.chip('檢查項目：' + t, 'facet', { title: '原值：' + f.facet })] : [];
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
   * 規則的常見原因與處理（V.remediation.advice，文字來自 CATALOG）：預設收合的展開列，檢查結果與規則清單共用。
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
    }), { count: src.length, long: true });
  }

  // ---------------------------------------------------------------- 基準狀態卡（未選取時）
  /*
   * 每個數字只出現一次：錯誤／警告在狀態句、缺資料台數在收集完整度、已收集台數在數字卡；技術細節（指紋、基準鍵、
   * 解析器使用量等）預設收合。錯誤／警告只算待處理的（處理紀錄，V.app.problemCounts），已處理的另註筆數。
   */
  const SEV_ORDER = { error: 0, warn: 1 };
  /** 建議先看的 finding 索引：待處理的錯誤與警告中，嚴重度最高、規則順序（S.query.rules）最前、再取 Snapshot 順序最前；沒有時 -1 */
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
    const cs = Q.coverageSummary(); const vs = Q.vlanSummary(); const pc = V.app.problemCounts();
    const problems = pc.total; const first = firstProblem(App);
    const counts = [pc.error ? `${V.num(pc.error)} 項錯誤` : null, pc.warn ? `${V.num(pc.warn)} 項警告` : null].filter(Boolean).join('、');
    // 錯誤／警告數連到「③ 分診」只列錯誤與警告；建議先看連到那一筆
    const status = h('p', { class: 'status-line' }, [
      V.sevDot(pc.error ? 'error' : pc.warn ? 'warn' : 'info'),
      h('span', null, [
        problems ? h('span', null, ['待處理：', h('a', { class: 'link status-problems', title: '在「③ 分診」只列錯誤與警告',
          onclick: () => { V.lists.findings.showProblems(App); App.showStep('triage'); } }, counts)]) : '目前規則未發現待處理的錯誤或警告',
        pc.handled ? h('span', { class: 'muted' }, `（另有 ${V.num(pc.handled)} 項已處理）`) : null,
        first >= 0 ? h('span', null, ['。建議先看：', suggestLink(App, first)]) : null,
      ]),
    ]);
    // 處理紀錄的提示（回歸、因收集失敗而無法判斷、豁免到期）：點一下到「⑤ 驗證」的本輪變化
    const alerts = [['regressed', 'err', '回歸', '已修好的問題又出現（依處理紀錄）'],
      ['unobserved', 'warn', '無法判斷', '本輪消失的待處理項目，所屬設備有收集失敗或沒有收集，因收集失敗而無法判斷是否已修好'],
      ['waiverExpired', 'warn', '豁免到期', '「可接受」的豁免已到期，改回待處理']].filter(([k]) => pc[k]);
    const alertRow = alerts.length ? h('div', { class: 'row status-alerts' }, alerts.map(([k, cls, label, title]) =>
      V.chipButton(`${label} ${V.num(pc[k])} 項`, 'btn ' + cls + ' ledger-alert', { 'data-alert': k, title: title + '；在「⑤ 驗證」的本輪變化', onclick: () => App.showStep('verify', { focus: 'round' }) }))) : null;
    // 覆蓋率只寫缺資料的台數（已收集台數在數字卡）；點一下在「① 輸入」的覆蓋率只列有缺漏的設備
    const coverage = h('p', { class: 'status-coverage' }, ['覆蓋率：',
      cs.missing ? h('a', { class: 'link', title: '在「① 輸入」的覆蓋率只列有缺漏的設備', onclick: () => { V.lists.coverage.showMissing(App); App.openHub('coverage'); } },
        `${V.num(cs.missing)} 台${T.network}缺資料或收集失敗`) : `已收集的${T.network}資料齊全`]);
    const hostNote = cs.hosts ? h('p', { class: 'status-hosts muted' }, `另有 ${V.num(cs.hosts)} 台${T.host}（${V.HOST_DEF}）`) : null;
    const stat = (label, value) => h('div', { class: 'stat' }, [h('div', { class: 'stat-num' }, value), h('div', { class: 'stat-label' }, label)]);
    const meta = [`建立 ${V.fmtTime(m.createdAt)}`, `命名規則 ${m.profile ? `${m.profile.id} v${m.profile.version}` : '未套用'}`,
      `來源 ${m.sources.map((x) => V.fileName(x.name)).join('、')}`].join('・');
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
      // 點選 A03（未知對端）會來到這裡：列出這台設備的 A03，處理建議才看得到
      findingsBlock(App, Q.findingsFor('device', sel.dev).filter((f) => f.id === 'A03')),
      section('終端埠', rows.length ? unknownTable(App, rows) : null, { count: rows.length, long: true }),
      section('Wi-Fi MAC 觀察（列入終端清單，不檢查重複 MAC）', wifi.length ? unknownTable(App, wifi, () => false) : null, { count: wifi.length, long: true }),
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
    // 推定偏離（finding.deviation，推論）：這台設備列在 deviating 的檢查結果也放進來，即使實體不是它
    const dev = Q.deviationsOf(d.key).map(Q.finding);
    const fl = Q.findingsFor('device', d.key).concat(...links.map((l) => Q.findingsFor('link', l.key)), ...ifs.map((i) => Q.findingsFor('interface', i.key)), dev);
    const peerRows = Q.neighborRows(d.key).sort((x, y) => S.util.natural(x.mine, y.mine));
    const vlans = Q.vlansOf(d.key); const routes = Q.routesOf(d.key); const unk = Q.unknownPeers(d.key);
    const showTable = multiVrf(Q) || routes.some((r) => (r.routingTable || K.MAIN_VRF) !== K.MAIN_VRF);
    const blocks = App.Q.blocksOf(d.key);
    const neighborHasFinding = peerRows.some((r) => r.links.some((l) =>
      l.vlanMismatch || Q.findingsFor('link', l.key).some((f) => f.severity !== 'info')));
    return h('div', { class: 'detail' }, [
      h('h2', null, d.label || d.name),
      h('div', { class: 'row' }, [V.kindChip(d.kind), d.collected ? V.chip('已收集', 'ok') : V.chip('未收集（僅由鄰居發現）', 'warn'), d.group ? V.chip(d.group, '', { title: V.TERMS.group + '（版面用，不代表實體位置或 IP 網段）' }) : null, d.role ? V.chip('角色：' + d.role) : null,
        dev.length ? h('a', { class: 'link chip-link deviation-chip', title: '依跨設備多數決推定這台的設定與其他設備不同（推論）；點一下捲到檢查結果',
          onclick: () => { const sec = V.$('#detail .findings-section'); if (sec) sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }, V.chip(`推定偏離 ${dev.length} 項`, 'warn')) : null]),
      findingsBlock(App, fl),
      kv([['管理 IP', d.mgmtIp], ['型號', d.deviceType], ['RouterOS', d.softwareVersion],
        ['廠商', d.manufacturer ? V.vendorName(d.manufacturer) : null],
        ['平台', d.manufacturer === 'mikrotik' ? null : d.platform],
        ['鄰居回報的功能', d.caps ? h('span', { class: 'caps', title: '原值：' + d.caps }, V.capsText(d.caps)) : null],
        // 設備類型依據：依命名規則是使用者指定，其餘是推定
        ['類型依據', d.kindBasis === 'profile' ? V.KIND_BASIS[d.kindBasis] : inferred(V.KIND_BASIS[d.kindBasis] || d.kindBasis, '設備類型是依型號、收集的資料或鄰居回報推定的結果，不是設備直接回報')],
        ['收集時間', d.collectedAt ? `${d.collectedAt.replace('T', ' ')}（設備時間，取自 export）` : null],
        ['其他名稱', d.names.length > 1 ? d.names.join('、') : null], ['Router ID', d.routerId],
        ['看到它的設備', d.seenBy.length && d.seenBy.length <= SEEN_INLINE ? seenByLinks(App, d.seenBy) : null],
        ['收集的資料', d.collected ? h('div', { class: 'chip-list' }, [
          ...(cov ? cov.data : []).map((t) => V.chip(S.query.dataLabel(t), 'ok')),
          ...(cov ? cov.missing : []).map((t) => V.chip('缺 ' + S.query.dataLabel(t), 'err')),
          ...(cov && cov.failures ? cov.failures : []).map((x) => V.chip(`收集失敗：${x.command || '整台設備'}`, 'err', { title: V.failureText(x) })),
        ]) : null]]),
      section('看到它的設備', d.seenBy.length > SEEN_INLINE ? seenByLinks(App, d.seenBy) : null, { count: d.seenBy.length, fold: true }),
      section('介面', table([
        { t: '介面', f: (i) => h('span', { class: 'mono' }, i.name + (i.lag ? ` → ${Q.getInterface(i.lag).name}` : '')), s: (i) => i.name },
        { t: '狀態', f: V.ifcState, s: V.ifcState },
        { t: '描述／IP', f: (i) => [i.desc, ...Q.addressesOf(i.key)].filter(Boolean).join('  '), s: (i) => Q.addressesOf(i.key)[0] || i.desc },
        { t: 'VLAN', f: (i) => h('span', { class: 'vlanlist' }, vlanText(S.util.ifcVlans(i))), s: (i) => vlanText(S.util.ifcVlans(i)) },
        { t: 'MAC', f: (i) => (i.macs.length ? String(i.macs.length) : ''), s: (i) => i.macs.length || null },
      ], ifs.sort((a, b) => S.util.natural(a.name, b.name)), { onRow: (i) => App.select({ type: 'interface', key: i.key }), limit: 300 }), { count: ifs.length, long: true }),
      section('VLAN 定義', vlans.length ? table([
        { t: 'ID', f: (v) => (v.id == null ? '?' : String(v.id)) }, { t: '名稱', f: (v) => v.name || '' }, { t: '描述', f: (v) => v.desc || '' }, { t: '成員', f: (v) => String(v.members.length) },
      ], vlans, { onRow: (v) => v.id != null && App.select({ type: 'vlan', key: String(v.id) }) }) : null, { count: vlans.length, fold: true }),
      section('沒有 LLDP／CDP 鄰接的埠', unk.length ? unknownTable(App, unk) : null,
        { count: unk.length, long: true, extra: [h('a', { class: 'link', onclick: () => App.select({ type: 'endpoints', dev: d.key }, { focus: true }) }, '在圖上看')] }),
      section('鄰居', peerRows.length ? table([
        { t: '本機介面', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? h('span', { class: 'mono' }, r.observations.length ? r.observations.map((o) => o.ifc).join('、') : '對端回報')
          : h('span', { class: 'mono' }, ifName(Q, r.mine)),
        s: (r) => (r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? (r.observations[0] ? r.observations[0].ifc : '') : ifName(Q, r.mine)) },
        { t: '對端', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? Q.devName(K.splitEp(r.other)[0])
          : h('span', null, [Q.devName(K.splitEp(r.other)[0]), h('span', { class: 'mono muted' }, ' ' + ifName(Q, r.other))]),
        s: (r) => Q.devName(K.splitEp(r.other)[0]) },
        { t: '類別', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? 'MNDP・同一 L2 廣播網域可達（未確認直連）'
          : V.protoText(r.l) + '・' + V.CLS[r.l.cls] + (r.l.hearsay ? '・' + V.TERMS.hearsay : '') + (!r.l.verified && !r.l.hearsay ? '・LLDP 單向' : ''),
        s: (r) => (r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? 'MNDP' : V.protoText(r.l)), cls: 'nowrap' },
        { t: 'VLAN', f: (r) => r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? '—'
          : (r.l.vlanMismatch ? h('span', { class: 'diffA' }, '不一致') : h('span', { class: 'vlanlist' }, vlanText(r.l.vlansCommon))),
        s: (r) => (r.l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? null : r.l.vlanMismatch ? '不一致' : vlanText(r.l.vlansCommon)) },
      ], peerRows, {
        onRow: (r) => App.select({ type: 'link', key: r.l.key }, { focus: true }),
        bad: (r) => r.links.some((x) => x.vlanMismatch || Q.findingsFor('link', x.key).some((f) => f.severity !== 'info')),
      }) : h('div', { class: 'muted' }, '沒有鏈路'),
        { count: peerRows.length, fold: true, open: neighborHasFinding }),
      inferredSection(App, Q.inferredLinksOf(d.key), d.key, { fold: true }),
      section('OSPF L3 鄰接（非實體直連）', ospfAdjacencies.length ? table([
          { t: '本機介面', f: (a) => epLink(App, a.localEp), s: (a) => K.splitEp(a.localEp)[1] },
          { t: '鄰居', f: (a) => devLink(App, a.peerDev), s: (a) => Q.devName(a.peerDev) },
          { t: '鄰居位址／Router ID', f: (a) => [a.peerIp, a.peerId].filter(Boolean).join('／'), s: (a) => a.peerIp || a.peerId },
          { t: '回報', f: (a) => a.reciprocal ? '雙向 OSPF 鄰接' : '單向 OSPF 觀察', s: (a) => (a.reciprocal ? '雙向' : '單向') },
          { t: '來源', f: (a) => srcLink(App, a.src) },
        ], ospfAdjacencies) : null, { count: ospfAdjacencies.length, fold: true }),
      section('路由表', routes.length ? table([
        { t: '網段', f: (r) => h('span', { class: 'mono' }, `${r.prefix}/${r.len}`), s: (r) => `${r.prefix}/${r.len}` },
        // 路由表（routing-table）：基準有其他 VRF 或這台設備有 main 以外的路由表時才列；只用於策略路由的路由表不屬於任何 VRF
        ...(showTable ? [{ t: '路由表', f: (r) => h('span', null, [h('span', { class: 'mono' }, r.routingTable || K.MAIN_VRF), r.vrf == null ? V.chip('只用於策略路由', 'info', { title: '這張路由表不是 VRF：只有 /routing rule 指定時才會查' }) : null]), s: (r) => r.routingTable }] : []),
        { t: '協定', f: (r) => (r.blackhole ? h('span', { class: 'diffA' }, '黑洞路由') : r.proto), s: (r) => r.proto },
        { t: '距離', f: (r) => (r.distance == null ? '' : String(r.distance)), s: (r) => r.distance },
        { t: '下一跳', f: (r) => nhCell(r, multiVrf(Q)), s: (r) => (r.nh[0] ? r.nh[0].ip || r.nh[0].ifc : '') },
      ], routes, { limit: 200 }) : null, { count: routes.length, fold: true }),
      vrfSection(App, d.key),
      policySection(App, d.key),
      firewallSummary(App, d.key),
      section('收集到的原始輸出', blocks.length ? blocksTable(App, blocks) : null,
        { count: blocks.length, fold: true, open: blocks.some((b) => b.failure) }),
    ]);
  }
  /** 「看到它的設備」超過這個台數時移出屬性表，改為預設收合的區塊（核心設備常被十幾台看到） */
  const SEEN_INLINE = 5;
  const seenByLinks = (App, keys) => h('span', { class: 'seen-by' }, keys.flatMap((k, i) => [i ? '、' : '', devLink(App, k)]));
  /** 設備詳情的防火牆摘要：規則、服務與 WAN／LAN 狀態；完整內容在防火牆畫面 */
  function firewallSummary(App, dev) {
    const Q = App.Q; const rules = Q.firewallRulesOf(dev); const services = Q.ipServicesOf(dev); const zone = Q.firewallZone(dev);
    if (!rules.length && !services.length && !zone) return null;
    const bad = rules.filter((r) => Q.findingsFor('rule', r.key).some((f) => f.severity !== 'info')).length;
    // 用語與防火牆畫面共用 firewall.js 的 zoneStatus()（該檔在本檔之後載入，render 時才取用）
    const zs = zone && V.firewall.zoneStatus(zone.status);
    return section('防火牆', [
      h('div', { class: 'row' }, [
        V.chip(`${rules.length} 條規則`), bad ? V.chip(`${bad} 條有問題`, 'warn') : null, V.chip(`${services.length} 個服務`),
        zs ? V.chip(zs.short, zs.tone, { title: zs.text }) : null,
      ]),
      h('div', null, h('a', { class: 'link', onclick: () => App.select({ type: 'firewall', dev }) }, '查看防火牆規則與服務')),
    ]);
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
    ], { count: list.length, fold: true, open: true });
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
    ], { count: rules.length, fold: true, open: true });
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
      h('h2', null, [Q.devName(K.splitEp(l.a)[0]), ' ⇄ ', Q.devName(K.splitEp(l.b)[0])]),
      h('div', { class: 'row' }, domain
        ? [V.chip('同一 L2 廣播網域可達（MNDP，未確認直連）', 'info'), ...l.via.map((v) => V.chip(v.toUpperCase()))]
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
      h('h2', null, [Q.devName(a), ' ⇄ ', Q.devName(b)]),
      h('div', { class: 'row' }, [links.length ? V.chip(`${links.length} 條鏈路`) : null, inferredList.length ? V.chip(`${inferredList.length} 條推論鏈路`, 'info') : null]),
      findingsBlock(App, [].concat(...links.map((l) => Q.findingsFor('link', l.key)))),
      section('鏈路（LLDP／CDP／MNDP）', links.length ? table([
        { t: Q.devName(a), f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? 'MNDP 觀察'
          : h('span', { class: 'mono' }, ifName(Q, K.splitEp(l.a)[0] === a ? l.a : l.b)) },
        { t: Q.devName(b), f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? 'L2 廣播網域可達'
          : h('span', { class: 'mono' }, ifName(Q, K.splitEp(l.a)[0] === a ? l.b : l.a)) },
        { t: '類別', f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? 'MNDP・同一 L2 廣播網域可達（未確認直連）'
          : V.CLS[l.cls] + (l.verified ? '' : l.hearsay ? '・' + V.TERMS.hearsay : '・LLDP 單向') , cls: 'nowrap' },
        { t: '協定', f: (l) => V.protoText(l) },
        { t: 'VLAN', f: (l) => l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN ? '—'
          : (l.vlanMismatch ? h('span', { class: 'diffA' }, '不一致') : h('span', { class: 'vlanlist' }, vlanText(l.vlansCommon))) },
      ], links, { onRow: (l) => App.select({ type: 'link', key: l.key }) }) : null, { count: links.length, long: true }),
      inferredSection(App, inferredList, a),
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
      section('鏈路', links.map((l) => h('div', null, L(App,
        l.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          ? `${Q.devName(K.splitEp(l.a)[0] === i.dev ? K.splitEp(l.b)[0] : K.splitEp(l.a)[0])}（MNDP：L2 廣播網域可達，非直連）`
          : `${Q.epName(l.a)} ⇄ ${Q.epName(l.b)}`,
        { type: 'link', key: l.key }))), { count: links.length, long: true }),
      inferredSection(App, inferred, i.dev),
      section('學到的 MAC', macs.length ? table([
        { t: 'MAC', f: (m) => macLink(App, m.mac) }, { t: '廠商', f: (m) => m.vendor || '' }, { t: 'IP', f: (m) => m.ips.join(', ') },
      ], macs, { limit: 500 }) : null, { count: macs.length, long: true }),
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
      section('學到它的介面', m.seen.length ? [lead.length ? table(cols(true), lead) : null,
        rest.length ? h('details', { class: 'detail-fold mac-rest' }, [h('summary', null, `另在 ${rest.length} 個非終端埠學到`),
          h('p', { class: 'muted' }, '這些埠學到多個 MAC 或接到網路設備，是轉送路徑上的埠，不是它的位置；不代表方向。'), table(cols(false), rest)]) : null] : null,
      { count: m.seen.length, extra: common }),
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
        pick ? V.chip(`在 ${r.vrfs.length} 個 VRF（位址重疊）`, 'warn') : null,
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
      ], r.arps) : null, { count: r.arps.length, long: true }),
    ]);
  }

  // ---------------------------------------------------------------- VLAN
  function vlan(App, sel) {
    const Q = App.Q; const v = Q.vlan(sel.key, sel.domain);
    const fl = Q.findingsFor('vlan', String(v.id)).concat(...v.partial.map((l) => Q.findingsFor('link', l.key)));
    const split = v.domains.length > 1; const at = v.domains.findIndex((d) => d.key === v.domain);
    const domainName = (d, idx) => `${V.TERMS.vlanDomain} ${idx + 1}：${d.devices.slice(0, 3).map((k) => Q.devName(k)).join('、')}`
      + (d.devices.length > 3 ? ` 等 ${d.devices.length} 台` : '');
    return h('div', { class: 'detail' }, [
      h('h2', null, 'VLAN ' + v.id + (at >= 0 ? `（${V.TERMS.vlanDomain} ${at + 1}／${v.domains.length}）` : '')),
      h('div', { class: 'row' }, [
        V.chip(`${v.devices.length} 台設備`), V.chip(`兩端都有此 VLAN 的鏈路 ${v.carry.length} 條`, '', { title: '兩端介面都設定了這個 VLAN 的鏈路數；不是檢查結果' }),
        v.inferred.length ? V.chip(`${v.inferred.length} 條推論鏈路`, 'info') : null,
        v.partial.length ? V.chip(`${v.partial.length} 條只有一端`, 'err') : null,
        split ? V.chip(`${v.domains.length} 個不相連的 ${V.TERMS.vlanDomain}（${V.TERMS.inferred}）`, 'warn') : null,
      ]),
      findingsBlock(App, fl),
      // 沒有任何設備設定名稱時不列（不顯示「名稱 —」）
      kv([['名稱', v.names.length ? v.names.join('、') : null]]),
      aboutSection(['圖上（設備圖與 L2 埠圖）：兩端都帶此 VLAN 的鏈路是實線，推論鏈路是長虛線（推論）；只有一端帶的是錯誤色並在中點標方形；'
        + '只有一端可確認（對端未收集、沒有 VLAN 資料或' + V.TERMS.hearsay + '）是淡色點線（推論）。選了 VLAN 後會持續標示，在工具列的 VLAN 選單取消。',
      split ? '同一個 VLAN ID 的設備之間沒有承載此 VLAN 的鏈路相連，可能是各自獨立的廣播網域（例如不同站點重用 VLAN ID），'
        + '也可能只是中間有沒收集、沒有 LLDP 的設備。' + V.TERMS.vlanDomain + '是依鏈路證據的推論。' : null]),
      section('只有一端有此 VLAN 的鏈路', v.partial.map((l) => h('div', null, L(App, `${Q.epName(l.a)} ⇄ ${Q.epName(l.b)}`, { type: 'link', key: l.key }))), { count: v.partial.length, long: true }),
      oneSideSection(App, Q.vlanCarriers(v.id, sel.domain)),
      section('設備', table([
        { t: '設備', f: (d) => devLink(App, d) },
        { t: '名稱', f: (d) => (v.entries.find((e) => e.dev === d) || {}).name || '' },
        { t: '成員介面', f: (d) => String((v.entries.find((e) => e.dev === d) || { members: [] }).members.length) },
      ], v.devices),
        { count: v.devices.length, long: true }),
      section(`不相連的 ${V.TERMS.vlanDomain}（${V.TERMS.inferred}）`, split ? [
        ...v.domains.map((d, idx) => h('div', null, d.key === v.domain
          ? h('b', null, domainName(d, idx))
          : L(App, domainName(d, idx), { type: 'vlan', key: String(v.id), domain: d.key }))),
        at >= 0 ? h('div', null, L(App, '顯示所有 ' + V.TERMS.vlanDomain, { type: 'vlan', key: String(v.id) })) : null,
      ] : null, { count: v.domains.length }),
    ]);
  }

  /** VLAN 承載中屬於推論的鏈路（Q.vlanCarriers 的 oneSide）：列出兩端與原因；Q.vlan 的「只有一端有」是兩端都有資料的事實，不在這裡 */
  function oneSideSection(App, c) {
    const Q = App.Q; const rows = c.links.filter((l) => l.status === 'oneSide');
    return section('只有一端可確認的鏈路（推論）', rows.length ? [
      h('p', { class: 'muted' }, '一端帶這個 VLAN，另一端無從得知（原因見右欄）：不算 VLAN 不一致（V01）。'),
      table([
        { t: '鏈路', f: (l) => L(App, `${Q.epName(l.a.ep)} ⇄ ${Q.epName(l.b.ep)}`, { type: 'link', key: l.key }) },
        { t: '原因', f: (l) => V.VLAN_REASON[l.reason] || l.reason },
      ], rows, { limit: 300 }),
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
    const fl = s.duplicateIps.flatMap((ip) => Q.findingsFor('ip', K.inVrf(ip, s.vrf))).concat(['A07', 'A08'].flatMap((id) => Q.findingsByRule(id)).filter((f) => nets.has(f.facet)));
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
        s.overlaps.length ? V.chip(`與 ${s.overlaps.length} 個網段重疊`, 'warn') : null,
        s.duplicateIps.length ? V.chip(`重複 IP ${s.duplicateIps.length} 個`, 'warn') : null,
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
      ], rows, { limit: 500, bad: (r) => dup.has(r.a.ip) }) : null, { count: rows.length, long: true }),
      section('設備', s.devices.length ? h('div', { class: 'chip-list' }, s.devices.map((d) => devLink(App, d))) : null, { count: s.devices.length, fold: true }),
      section('重疊網段', s.overlaps.length ? s.overlaps.map((o) => h('div', null, [subnetLink(App, o), h('span', { class: 'muted' }, '　' + relation(o))])) : null, { count: s.overlaps.length }),
      section('重複 IP', s.duplicateIps.length ? s.duplicateIps.map((ip) => h('div', null, [ipLink(App, ip, s.vrf), '：',
        ...rows.filter((r) => r.a.ip === ip && r.a.ep).flatMap((r, n) => [n ? '、' : '', epLink(App, r.a.ep)])])) : null, { count: s.duplicateIps.length }),
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

  // ---------------------------------------------------------------- 路由追蹤
  /** 策略路由規則（trace 的 hops[].rule、ends[].rule／rules）：規則文字與來源連結 */
  const ruleLine = (App, r) => h('div', { class: 'muted trace-rule' }, [routingRuleText(r), ' ', srcLink(App, r.src)]);
  /**
   * 一個方向的逐跳與結果（去程、回程共用；prefix 區分標題）。
   * 每一跳標出它的 VRF、查的路由表（不是 VRF 的表時）與決定查表的 /routing rule；基準只有 main 時不標 VRF，與加入 VRF 之前相同。
   * 策略路由不明（policy）與被 /routing rule 丟棄（policy-drop）的結果列出相關的規則。
   */
  function tracePath(App, t, prefix) {
    const multi = multiVrf(App.Q);
    const vrfChip = (v) => (multi && v ? V.chip(V.vrfText(v), 'trace-vrf') : null);
    return [
      section(`${prefix || ''}逐跳`, t.hops.map((hp) => h('div', { class: 'hop', 'data-vrf': hp.vrf || null }, [
        h('div', null, [h('b', null, devLink(App, hp.dev)), multi ? ' ' : null, vrfChip(hp.vrf),
          hp.table && hp.table !== hp.vrf ? V.chip(`路由表 ${hp.table}`, 'info', { title: '依 /routing rule 查的策略路由表' }) : null,
          hp.via && hp.via.length > 1 ? V.chip(`經 VRF 介面 ${hp.via.join(' → ')}`, 'info') : null,
          h('span', { class: 'mono muted' }, `  ${hp.route}（${hp.proto}）`), hp.ecmp ? V.chip('ECMP', 'info') : null]),
        hp.rule ? ruleLine(App, hp.rule) : null,
        ...hp.next.map((n) => h('div', { class: 'mono' }, [
          `→ ${n.ip || ''} ${n.ifc || ''} `,
          n.dev ? devLink(App, n.dev) : null, n.dev && multi && n.vrf ? h('span', { class: 'muted' }, ` @${n.vrf}`) : null,
          n.crossVrf ? ' ' : null, n.crossVrf ? V.chip('推論', 'info', { title: '對方的這個位址在另一個 VRF，網段相同' }) : null,
          n.note ? h('span', { class: n.status === 'ok' || n.status === 'connected' ? 'muted' : 'diffA' }, '  ' + n.note) : null,
        ])),
      ])), { count: t.hops.length }),
      section(`${prefix || ''}結果`, t.ends.map((e) => h('div', { class: 'hop ' + V.TRACE_END_STYLE[V.traceEndKind(e)].cls, 'data-status': e.status }, [
        h('b', null, devLink(App, e.dev)), multi && e.vrf ? `（${V.vrfText(e.vrf)}）` : '', `：${V.TRACE_END[e.status] || e.status}`, h('div', { class: 'muted' }, e.note),
        ...(e.rules || []).map((r) => ruleLine(App, r)), e.rule ? ruleLine(App, e.rule) : null,
      ])), { count: t.ends.length }),
    ];
  }
  /** 整體結果的標籤：分類同 V.traceEndKind（S.trace 的 status），停在未收集的設備是「無法驗證」（灰色），不是錯誤。 */
  const traceChip = (App, t, prefix) => {
    const k = V.traceEndKind(t);
    return k === 'reached' ? V.chip(`${prefix}可抵達`, 'ok')
      : k === 'unverified' ? V.chip(`${prefix}無法驗證（${t.unverified.map((d) => App.Q.devName(d)).join('、')} 未收集）`, 'unverified')
        : V.chip(`${prefix}無法完整抵達`, 'err');
  };
  function trace(App, sel) {
    const t = sel.result; const back = sel.reverse; const multi = multiVrf(App.Q);
    if (!t.ok) return h('div', { class: 'detail' }, [h('h2', null, '路由追蹤'), h('p', { class: 'diffA' }, t.error)]);
    // 非對稱：回程經過的設備順序和去程反過來不同
    const devs = (x) => x.hops.map((hp) => hp.dev);
    const asym = back && back.ok && devs(back).join('>') !== devs(t).slice().reverse().join('>');
    return h('div', { class: 'detail' }, [
      h('h2', null, `${t.src} → ${t.dst}`),
      h('div', { class: 'row' }, [traceChip(App, t, ''), t.hops.some((x) => x.ecmp) ? V.chip('含 ECMP', 'info') : null,
        back ? (back.ok ? traceChip(App, back, '回程') : V.chip('回程無法完整抵達', 'err')) : null, asym ? V.chip('非對稱路徑', 'warn') : null,
        t.ends.some((e) => e.status === 'policy') ? V.chip('策略路由不明', 'warn') : null]),
      kv([['起點', h('span', null, [devLink(App, t.start), '（來源所在網段的閘道）'])],
        ['VRF', multi ? `${t.vrf}（${sel.vrf ? '指定' : '依來源位址決定'}）` : null]]),
      ...tracePath(App, t),
      back ? section(`回程（${t.dst} → ${t.src}）`, back.ok ? kv([['起點', devLink(App, back.start)], ['VRF', multi ? back.vrf : null], ['說明', '無狀態的 ACL 需要確認回程也能通過']]) : h('p', { class: 'diffA' }, back.error)) : null,
      ...(back && back.ok ? tracePath(App, back, '回程') : []),
    ]);
  }

  // 其他詳情畫面（panels/firewall.js）共用的片段：區塊一律經 section() 產生
  V.details = { render, parts: { section, kv, L, devLink, epLink, findingsBlock, adviceBlock } };
})(globalThis.SSOT = globalThis.SSOT || {});
