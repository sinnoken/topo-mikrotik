/*
 * 右側：某台設備的防火牆（選取 type 為 firewall／rule／service）。
 * 規則依位址族 → 表 → chain → position 列出（Q.firewallRuleRows、Q.firewallChains），
 * 另列 WAN／LAN 判斷（推論，Q.firewallZone）、/ip service 與 interface list，
 * 以及指向規則、核心有修正方式的檢查結果的修正指令（S.remediate.plan，只是文字；不能產生指令的列出原因）。
 * 定位到一條規則時另列命中次數（rule.stats，事實；沒有資料或對不上（F09）時說明原因）與 L4 的影響（Q.ruleImpact，推論，按了才算）。
 * 區塊一律用 details.js 的 section() 產生；顏色取自 theme.firewall。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const K = S.keys;
  const T = V.theme.firewall;
  const FAMILY = { ip: 'IPv4', ipv6: 'IPv6' };
  // 文字對照核心的判斷（infer.js fwContext）：已定義的 interface list 名稱含獨立的 WAN 字樣（不分大小寫，
  // 前後不接英文字母，例如 WAN、ISP-WAN、wan2），成員含 include／exclude 展開後的結果；LAN 同理
  // 防火牆畫面用 text，設備詳情的摘要用 short（標示推論）；兩處都經由 zoneStatus() 取用，不另寫一份
  const ZONE_STATUS = {
    ok: { text: '已找到 WAN 介面', short: '已找到 WAN 介面（推論）', tone: 'ok' },
    'no-wan-list': { text: '沒有名稱含 WAN 的 interface list，WAN 相關檢查未執行', short: '沒有 WAN interface list（推論）', tone: 'warn' },
    'empty-wan-list': { text: '名稱含 WAN 的 interface list 沒有可確定的成員，WAN 相關檢查未執行', short: 'WAN interface list 沒有成員（推論）', tone: 'warn' },
  };
  /** WAN 判斷狀態的文字與色調；未知的 status 原樣顯示，不假裝成已知狀態 */
  const zoneStatus = (status) => ZONE_STATUS[status] || { text: String(status), short: `${status}（推論）`, tone: '' };
  const ZONE_BASIS = { 'interface-list': '依名稱含 WAN／LAN 的 interface list' };
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
    const f = App.Q.finding(i);
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
      // 命中次數（print stats，事實）：封包數；沒有資料時空白（原因在規則的詳情）
      { t: '命中', f: (x) => (x.rule.stats ? h('span', { class: 'mono fw-hits', title: `${V.bigNum(x.rule.stats.packets)} 個封包、${V.bigNum(x.rule.stats.bytes)} 位元組（收集當下的累積值）` }, V.bigNum(x.rule.stats.packets)) : ''), cls: 'num' },
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

  const FIND_BY = { comment: '依註解 find', match: '依比對條件 find', 'comment+match': '依註解與比對條件 find' };
  /** 複製到剪貼簿；瀏覽器不支援或拒絕時說明，請使用者手動選取（不靜默失敗） */
  function copyText(text, what) {
    const c = globalThis.navigator && globalThis.navigator.clipboard;
    if (!c || !c.writeText) { V.app.banner('這個瀏覽器無法自動複製，請選取文字後手動複製。', 6000); return; }
    c.writeText(text).then(() => V.app.banner(`已複製${what || '指令'}；執行前請核對。`, 3000),
      (e) => V.app.banner('無法複製：' + e.message + '；請選取文字後手動複製。', 6000));
  }
  /**
   * 修正（停用規則）：定位到某條規則時只列這條規則的，否則列這台設備全部（預設收合）。
   * 對象是指向規則、核心有修正方式（S.remediate.levelOf 不是 manual）的檢查結果；計畫與指令都由 S.remediate 產生，
   * 不能產生指令的（例如 F03 要選擇處理方式、F02 的 find 無法區分）列出核心給的原因。
   */
  function fixSection(App, dev, focusRule) {
    const Q = App.Q; const RM = V.remediation;
    const fs = (focusRule ? Q.findingsFor('rule', focusRule) : Q.findingsFor('device', dev))
      .filter((f) => f.entities.some((e) => e.type === 'rule') && S.remediate.levelOf(f.id) !== 'manual');
    if (!fs.length) return null;
    const keys = S.util.uniq(fs.map((f) => Q.findingKey(f)));
    const byKey = new Map(fs.map((f) => [Q.findingKey(f), f]));
    const plan = S.remediate.plan(Q, keys);
    const hits = RM.matchFindings(Q, plan.skipped);
    const ruleOf = (k) => { const f = byKey.get(k); const e = f && f.entities.find((x) => x.type === 'rule'); return e ? e.key : null; };
    const sevCls = (id) => { const s = (S.query.rule(id) || {}).severity; return s === 'error' ? 'err' : s; };
    const ruleLink = (key) => (key ? P().L(App, ruleLabel(App, key), { type: 'rule', key }) : null);
    return P().section('修正（停用規則）', [
      h('p', { class: 'muted' }, '只產生文字，不會連線或改動設備。指令以 comment 或比對條件 find（不用規則編號）；完整的 .rsc（含前置檢查、回復與驗證）在修正計畫。'),
      h('div', { class: 'row' }, h('button', { class: 'open-patch', onclick: () => App.openPatch(keys) }, '在修正計畫中開啟（套用、回復、驗證）')),
      ...plan.items.map((it) => {
        const cmd = RM.itemApplyLines(plan, it);
        return h('div', { class: 'fw-fix', 'data-rule': it.target.key, 'data-finding': it.findingKey }, [
          h('div', { class: 'row' }, [V.chip(it.id, sevCls(it.id)), ' ', ruleLink(it.target.key), ' ', V.chip(FIND_BY[it.target.by] || it.target.by, 'info'), ' ',
            V.chip('風險 ' + (RM.RISK_TEXT[it.risk.level] || it.risk.level), RM.RISK_CHIP[it.risk.level] || '', { title: it.risk.text }), ' ',
            h('button', { class: 'ghost copy-fix', title: '複製套用指令', onclick: () => copyText(cmd, '套用指令') }, '複製')]),
          h('p', { class: 'muted' }, it.note),
          ...it.warnings.map((w) => h('p', { class: 'warn-line fix-warning' }, '警告：' + w)),
          h('pre', { class: 'note-box fix-cmd' }, cmd),
        ]);
      }),
      ...plan.skipped.map((x, n) => h('div', { class: 'fw-fix skipped', 'data-rule': x.rule || ruleOf(x.findingKey), 'data-finding': x.findingKey }, [
        h('div', { class: 'row' }, [V.chip(x.id, sevCls(x.id)), ' ', ruleLink(x.rule || ruleOf(x.findingKey)), ' ', V.chip('未產生指令', 'warn')]),
        h('p', { class: 'fix-skip-finding' }, RM.findingRef(App, hits[n], x.findingKey)),
        h('p', { class: 'warn-line fix-skip' }, x.detail),
      ])),
    ], { count: plan.items.length + plan.skipped.length, fold: !focusRule, open: !!focusRule });
  }

  // ---------------------------------------------------------------- 命中次數（print stats，事實）與 L4 的影響（Q.ruleImpact，推論）
  const STATS_NOTE = '命中次數是收集當下的累積值（設備重開或 reset-counters 後會從 0 重新計算）。0 只代表到收集時為止沒有比對到，不代表規則沒用：備援、少見的流量或剛加上的規則都可能是 0。';
  /** 對不上（F09）的第一個不符：model 的 matchFirewallStats 的 reason */
  function mismatchText(x) {
    if (!x) return '';
    const v = (s) => (s === true ? '停用' : s === false ? '啟用' : s == null || s === '' ? '（空）' : String(s));
    if (x.code === 'count') return `去掉動態（D）列後有 ${V.num(x.stats)} 列，export 有 ${V.num(x.export)} 條規則`;
    const what = { chain: 'chain', action: '動作', disabled: '停用狀態', comment: '註解' }[x.code] || x.code;
    return `第 ${x.position} 列的${what}不同（export：${v(x.export)}，print stats：${v(x.stats)}）`;
  }
  function statsSection(App, r) {
    const Q = App.Q; const { section, kv } = P();
    const note = h('p', { class: 'muted fw-stats-note' }, STATS_NOTE);
    if (r.stats) {
      return section('命中次數', [kv([
        ['封包', h('span', { class: 'mono fw-stat-packets' }, V.bigNum(r.stats.packets))],
        ['位元組', h('span', { class: 'mono fw-stat-bytes' }, V.bigNum(r.stats.bytes))],
        ['來源', srcLink(App, r.stats.src)]]), note]);
    }
    const label = `${FAMILY[r.family] || r.family} ${r.table}`;
    const t = Q.firewallStatsOf(r.dev).find((x) => x.family === r.family && x.table === r.table);
    const f09 = Q.findingIndexesFor('device', r.dev).filter((i) => Q.finding(i).id === 'F09');
    let msg;
    if (!t) msg = `沒有命中次數資料：這台設備沒有收集 ${label} 的 print stats。`;
    else if (t.status === 'mismatch') msg = `命中次數對不上 export 的規則，${label} 整個表的命中次數都不採用（F09）：${mismatchText(t.reason)}。`;
    else if (t.status === 'no-export') msg = `沒有命中次數資料：有 ${label} 的 print stats，但這台設備沒有 export，對不到規則。`;
    else msg = '沒有命中次數資料：這條規則沒有對應的 print stats 列。';
    return section('命中次數', [
      h('p', { class: t && t.status === 'mismatch' ? 'warn-line fw-stats-missing' : 'muted fw-stats-missing' }, [msg,
        t && t.reason && t.reason.row ? h('span', null, [' ', srcLink(App, [t.reason.row])]) : null]),
      f09.length ? h('div', { class: 'row' }, f09.map((i) => h('a', { class: 'link', title: Q.finding(i).message, onclick: () => App.selectFinding(i) }, V.chip('F09', 'info')))) : null,
      note,
    ]);
  }
  /** 規則影響的結果：Q → Map(規則鍵 → 結果)；計算要遍歷整個矩陣（大型網路約 1 秒），所以按了才算，結果留到換基準 */
  const impacts = new WeakMap();
  function impactSection(App, key) {
    const Q = App.Q; const { section } = P();
    const cache = impacts.get(Q); const res = cache && cache.get(key);
    const body = h('div', { class: 'fw-impact' });
    if (!res) {
      body.appendChild(h('p', { class: 'muted' }, '這條規則在 L4 的影響（推論）：牽涉到哪些 zone 對，以及停用它時哪些路徑的結果會改變。第一次計算要先算 zone 矩陣，大型網路約需數秒。'));
      const btn = h('button', { type: 'button', class: 'fw-impact-run', onclick: () => {
        btn.disabled = true; btn.textContent = '計算中…'; body.setAttribute('aria-busy', 'true');
        App.l4ImpactJob = new Promise((resolve) => setTimeout(() => {
          try {
            const r = Q.ruleImpact(key, V.l4.zoneOpts(App).opts);
            if (!impacts.has(Q)) impacts.set(Q, new Map());
            impacts.get(Q).set(key, r || { missing: true });
          } catch (e) { console.error(e); V.app.banner('無法計算規則的影響：' + e.message, 8000); }
          finally { resolve(); if (App.Q === Q && App.sel && App.sel.type === 'rule' && App.sel.key === key) V.details.render(App, App.sel); }
        }, 30));
      } }, '計算 L4 影響');
      body.appendChild(h('div', { class: 'row' }, btn));
      return section('L4 影響（推論）', body);
    }
    if (res.missing) return section('L4 影響（推論）', h('p', { class: 'muted' }, '基準中沒有這條規則。'));
    const zn = new Map(Q.zones(V.l4.zoneOpts(App).opts).zones.map((z) => [z.id, z.name]));
    const name = (id) => (id == null ? '（不在任何 zone）' : zn.get(id) || id);
    const c = res.ifDisabled.counts; const ad = c['allow→deny'] || 0;
    body.appendChild(h('div', { class: 'row' }, [
      V.chip(`牽涉 ${V.num(res.cells.length)} 個 zone 對`), V.chip(`決定結果 ${V.num(res.total.decides)}・條件無法判斷 ${V.num(res.total.uncertain)}・經過 ${V.num(res.total.passes)}`),
      res.shadowed ? V.chip('被遮蔽（F01）', 'warn') : null, res.duplicate ? V.chip('重複（F02）', 'warn') : null,
    ]));
    body.appendChild(h('p', { class: 'fw-impact-disabled' }, [h('b', null, '停用這條規則後：'),
      `allow→deny ${V.num(ad)} 筆`, ...Object.entries(c).filter(([k]) => k !== 'allow→deny').map(([k, n]) => `、${k} ${V.num(n)} 筆`),
      `（共 ${V.num(res.ifDisabled.total)} 筆結果改變${res.ifDisabled.truncated ? '，下表只列前幾筆' : ''}）`]));
    if (res.cells.length) {
      body.appendChild(V.table([
        { t: '來源 zone', f: (x) => name(x.src), s: (x) => name(x.src) },
        { t: '目的 zone', f: (x) => name(x.dst), s: (x) => name(x.dst) },
        { t: '位置', f: (x) => (x.plane === 'device' ? '設備本身（input／output）' : '轉送') },
        { t: '決定', f: (x) => V.num(x.decides), s: (x) => x.decides },
        { t: '無法判斷', f: (x) => V.num(x.uncertain), s: (x) => x.uncertain },
        { t: '經過', f: (x) => V.num(x.passes), s: (x) => x.passes },
        { t: '服務', f: (x) => h('span', { class: 'mono' }, x.services.join(' ')) },
      ], res.cells, { limit: 200 }));
    } else body.appendChild(h('p', { class: 'muted' }, '矩陣的代表位址組合都沒有經過這條規則。'));
    if (res.ifDisabled.changed.length) {
      body.appendChild(h('details', { class: 'fw-impact-changed' }, [h('summary', null, `停用後改變的路徑（${V.num(res.ifDisabled.total)}）`), V.table([
        { t: '來源', f: (x) => h('span', { class: 'mono' }, x.src) }, { t: '目的', f: (x) => h('span', { class: 'mono' }, x.dst) },
        { t: 'zone', f: (x) => `${name(x.srcZone)} → ${name(x.dstZone)}` }, { t: '服務', f: (x) => x.service },
        { t: '變化', f: (x) => `${V.VERDICT[x.from] || x.from} → ${V.VERDICT[x.to] || x.to}` },
      ], res.ifDisabled.changed)]));
    }
    return section('L4 影響（推論）', body);
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
    const fwFindings = Q.findingsFor('device', dev).filter((f) => (S.query.rule(f.id) || {}).cat === '防火牆');
    // 位址族 → 表：一般區塊；其下每個 chain 是可展開區塊
    const tables = [];
    chains.forEach((c) => {
      const k = c.family + '|' + c.table; let t = tables.find((x) => x.k === k);
      if (!t) { t = { k, family: c.family, table: c.table, chains: [] }; tables.push(t); }
      t.chains.push(c);
    });
    const zs = zone && zoneStatus(zone.status);
    const svcKey = (s) => s.dev + '|' + s.name;
    return h('div', { class: 'detail' }, [
      h('h2', null, [devLink(App, dev), ' 的防火牆']),
      h('div', { class: 'row' }, [
        V.chip(`${rules.length} 條規則`), rules.some((r) => r.disabled) ? V.chip(`停用 ${rules.filter((r) => r.disabled).length}`) : null,
        V.chip(`${services.length} 個服務`),
      ]),
      notice ? h('p', { class: 'diffA' }, notice) : null,
      findingsBlock(App, fwFindings),
      focusRule ? statsSection(App, Q.getFirewallRule(focusRule)) : null,
      focusRule ? impactSection(App, focusRule) : null,
      fixSection(App, dev, focusRule),
      section('WAN／LAN 判斷（推論）', zone ? [
        kv([['狀態', V.chip(zs.text, zs.tone)], ['依據', ZONE_BASIS[zone.basis] || zone.basis || '—'],
          ['WAN list', zone.wanLists.join('、') || '—'],
          ['WAN 介面', zone.wanInterfaces.length ? h('span', null, zone.wanInterfaces.flatMap((ep, n) => [n ? '、' : '', epLink(App, ep)])) : '—'],
          ['LAN list', zone.lanLists.join('、') || '—'],
          ['LAN 介面', zone.lanInterfaces.length ? h('span', null, zone.lanInterfaces.flatMap((ep, n) => [n ? '、' : '', epLink(App, ep)])) : '—']]),
        h('p', { class: 'muted' }, '名稱含獨立 WAN 字樣的 interface list（例如 WAN、ISP-WAN）的成員推定為朝外（WAN），含 LAN 字樣的推定為朝內（LAN）；'
          + '不看介面名稱。F03／F04／F07 等檢查依這個判斷。'),
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

  V.firewall = { render, zoneStatus };
})(globalThis.SSOT = globalThis.SSOT || {});
