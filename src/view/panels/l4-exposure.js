/*
 * L4 可達性：由外而內的三段暴露清單（Q.exposureSteps 分段計算）。共用的狀態與函式在 l4.js（V.l4._），
 * 看路徑的逐跳路徑由 l4-trace.js 的 runQuery／reachBlock 查詢與畫出；沒有 WAN 時展開內部互通（l4-matrix.js 的 openMatrix）。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const I = V.l4._;
  const { st, els, EX_LIMIT, ROW_LIMIT, BUSY_DELAY, layerOf, layerText, layerLine, deniedParts, zo, statusTag, decisiveText, ruleLink, isOpen, announce } = I;

  /**
   * 暴露清單一列的分層結果 [route, filter]：查詢層的列有 route／filter 時照用；還沒有時依結論與原因的層級推定——
   * 允許是路由抵達、防火牆允許；無法判斷時有路由層的原因是路由不明（防火牆也不明，同 Q.reach 的 layered），否則路由抵達、防火牆不明
   */
  function rowLayers(x) {
    if (x.route && x.filter) return [x.route.status, x.filter.status];
    if (x.verdict === 'allow') return ['reached', 'allow'];
    return [x.reasons.some((c) => layerOf(c) === 'route') ? 'unknown' : 'reached', x.verdict];
  }
  /** 暴露清單一段的「其餘 N 個組合拒絕：…」，判斷次數上限用完、沒判斷到的組合（counts.notEvaluated）另寫；都沒有時是空字串 */
  function deniedSentence(denied, by, notEvaluated) {
    const dp = deniedParts(by);
    return (denied ? `其餘 ${V.num(denied)} 個組合（服務 × 位址）拒絕${dp ? '：' + dp : ''}。` : '')
      + (notEvaluated ? `另有 ${V.num(notEvaluated)} 個沒判斷（上限）。` : '');
  }

  // ---------------------------------------------------------------- 由外而內：暴露清單（Q.exposure）
  /** 暴露清單的分段計算：與矩陣分開（換 service 不重算）；紀錄 Q → { ms, wallMs, steps, maxStepMs, maxGapMs } */
  const exRuns = new WeakMap();
  let exJob = null;
  const EX_STAGES = ['prepare', 'evaluate', 'summary'];
  const EX_STAGE_LABEL = { prepare: '找入口與外部區段', evaluate: '逐一判斷', summary: '整理結果' };
  /** 三段：鍵、標題、沒有時的說明 */
  const EX_SECS = [
    { key: 'self', title: '① 外部 → 網路設備本身', none: '沒有從外部連得到的管理服務或設備本身的服務。' },
    { key: 'dnat', title: '② 外部 → 內部（dst-nat）', none: '沒有經 dst-nat 轉送到內部的服務。', noCand: '這些邊界路由器沒有 dst-nat 規則。' },
    { key: 'routed', title: '③ 外部 → 內部（直接路由）', none: '沒有不經 NAT、直接路由到內部的服務。' },
  ];
  function stopEx() { const j = exJob; if (!j) return; exJob = null; if (j.it) { try { j.it.return(); } catch (e) { console.error(e); } } }
  function exposure(App) {
    const Q = App.Q;
    if (exJob && exJob.Q === Q && exJob.zo === st.zo) return exJob.promise;
    stopEx();
    if (st.ex && st.exQ === Q && st.exZo === st.zo) { renderExposure(App); return Promise.resolve(); }
    st.ex = null; st.exErr = null; st.exPath = null;
    const j = { Q, zo: st.zo, it: null, steps: 0, ms: 0, maxStepMs: 0, maxGapMs: 0, t0: Date.now(), last: 0, progress: null };
    exJob = j; renderExposure(App);
    j.promise = new Promise((resolve) => {
      const tick = () => {
        if (exJob !== j) { resolve(); return; }
        if (App.Q !== Q || App.layer !== 'l4') { stopEx(); renderExposure(App); resolve(); return; }
        const s0 = Date.now(); if (j.last) j.maxGapMs = Math.max(j.maxGapMs, s0 - j.last);
        let r;
        try { if (!j.it) j.it = Q.exposureSteps(zo()); r = j.it.next(); } catch (e) { console.error(e); exJob = null; st.exErr = V.reason(e); try { safeRender(App); } finally { resolve(); } return; }
        const ms = Date.now() - s0; j.last = Date.now(); j.steps++; j.ms += ms; j.maxStepMs = Math.max(j.maxStepMs, ms);
        if (!r.done) { j.progress = r.value; exProgress(r.value); setTimeout(tick, 0); return; }
        exJob = null;
        exRuns.set(Q, { ms: j.ms, wallMs: Date.now() - j.t0, steps: j.steps, maxStepMs: j.maxStepMs, maxGapMs: j.maxGapMs });
        st.ex = r.value; st.exQ = Q; st.exZo = j.zo;
        try { safeRender(App); } finally { resolve(); }
      };
      setTimeout(tick, BUSY_DELAY);
    });
    return j.promise;
  }
  /**
   * 畫暴露清單；畫的時候丟出例外時改畫錯誤（st.exErr），連錯誤都畫不出來時直接在段落寫出兩次的原因（role=alert）。
   * 不再往外丟：呼叫端的 Promise（App.l4Job）一定會結束
   */
  function safeRender(App) {
    try { renderExposure(App); return; } catch (e) { console.error(e); st.exErr = V.reason(e); }
    try { renderExposure(App); } catch (e2) {
      console.error(e2);
      if (els.root) {
        V.clear(els.exHead).appendChild(h('span', null, '無法顯示從外部進得來什麼。'));
        V.clear(els.ex).appendChild(h('p', { class: 'diffA l4-ex-error', role: 'alert' }, `無法顯示：${st.exErr}；顯示錯誤時又發生：${V.reason(e2)}`));
      }
    }
  }
  function exProgress(p) {
    const bar = $('#l4-ex-progress'); const t = $('#l4-ex-progress-text'); if (!bar) return;
    const n = EX_STAGES.indexOf(p.stage) + 1; const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    const txt = `第 ${n || '?'}／${EX_STAGES.length} 段：${EX_STAGE_LABEL[p.stage] || p.stage} ${V.num(p.done)}／${V.num(p.total)}`;
    bar.classList.remove('indeterminate'); bar.setAttribute('aria-valuenow', String(pct)); bar.setAttribute('aria-valuetext', txt); bar.dataset.stage = p.stage;
    if (bar.firstChild) bar.firstChild.style.width = pct + '%';
    if (t) t.textContent = txt;
  }
  /** 檢查結果的連結：「代碼 標題」，點了開那一筆（findingKey → idx） */
  function findingLink(App, key, chip) {
    const Q = App.Q; const idx = Q.findingIndexByKey(key); if (idx < 0) return null;
    const f = Q.finding(idx); const r = S.query.rule(f.id); const full = `${f.id} ${r ? r.title : ''}`.trim();
    // chip：只寫代碼，標題在 title 與 aria-label（依據欄下面一行）
    return h('a', { class: 'link l4-finding' + (chip ? ' chip' : ''), 'data-finding': key, href: '#', title: chip ? full : null, 'aria-label': chip ? full : null,
      onclick: (e) => { if (e && e.preventDefault) e.preventDefault(); if (e && e.stopPropagation) e.stopPropagation(); App.selectFinding(idx); } }, chip ? f.id : full);
  }
  const exPort = (x) => (x.portRange ? `${x.portRange[0]}–${x.portRange[1]}` : x.port != null ? String(x.port) : '');
  const exSvc = (x) => x.proto + (exPort(x) ? ' ' + exPort(x) : '');
  // IPv6 位址加埠時寫成 [位址]:埠
  const withPort = (ip, x) => (exPort(x) ? (ip.includes(':') ? `[${ip}]` : ip) + ':' + exPort(x) : ip);
  /**
   * 一列的目的：self 是設備的位址；dnat 是「公網:埠 → 內部:埠」（沒限制目的位址時寫入口介面上的任何位址）；routed 是內部位址與網段。
   * IPv6 的列（family 'ipv6'，只看邊界路由器）：dstAny 時是「整個網段 x 的主機」
   */
  function exDst(App, sec, x) {
    const Q = App.Q;
    if (sec === 'self') return h('span', null, [h('span', { class: 'mono' }, withPort(x.ip, x)), ' ', h('span', { class: 'muted' }, Q.devName(x.dev) + (x.serviceName ? '・' + x.serviceName : ''))]);
    if (x.family === 'ipv6' && x.dstAny) return h('span', null, h('span', { class: 'mono' }, `整個網段 ${x.subnet} 的主機`));
    const to = x.nat && x.nat.to ? V.inVrfText(x.nat.to) : null;
    const from = sec === 'dnat' && x.dstAny ? withPort(`${x.inInterface} 上的任何位址`, x) : withPort(x.ip, x);
    const where = sec === 'routed' && x.subnet ? V.inVrfText(x.subnet) : '';
    return h('span', null, [h('span', { class: 'mono' }, from + (to ? ' → ' + to : '')), where ? h('span', { class: 'muted' }, ' ' + where) : null]);
  }
  function exResult(App, x) {
    const t = V.L4_STATUS[x.verdict] + (x.incomplete ? `（${V.L4_INCOMPLETE}）` : '');
    // 回程不保證用短標（returnTag），不再寫原因的長句
    const rs = x.reasons.filter((c) => c !== RETURN_CODE);
    // 第二行：分層結果（IPv6 只看邊界路由器，不判斷路由，只寫防火牆）
    const [rt, fl] = rowLayers(x);
    return h('span', { class: 'l4-ex-verdict', 'data-verdict': x.verdict }, [statusTag(x.verdict, t), h('span', { class: 'sr-only' }, '（推論）'),
      (x.returnUnsafe || []).length ? h('span', null, [' ', returnTag(App, x.returnUnsafe)]) : null,
      rs.length ? h('span', { class: 'muted l4-ex-reasons' }, ' ' + layerText(rs, (c) => c, (c) => V.reachReason(c))) : null,
      h('span', { class: 'l4-ex-layers' }, layerLine(x.family === 'ipv6' ? null : rt, fl))]);
  }
  const RETURN_CODE = 'return-not-guaranteed';
  /**
   * 「⚠ 回程不保證」短標（推論，F15）：list 是 [{ dev, chain, rule（規則鍵）, interfaces }]（Q.exposure 的 returnUnsafe、Q.reach 逐跳的 returnUnsafe 加上 dev）。
   * 說明（設備、chain、規則、介面）在 title；後面接擋下回程的規則連結（點了在右側開規則詳情）
   */
  function returnTag(App, list) {
    const Q = App.Q;
    const one = (u) => { const r = u.rule ? Q.getFirewallRule(u.rule) : null;
      return `${Q.devName(u.dev)} 的 ${u.chain} 沒有保證放行已建立連線的封包${r ? `（${decisiveText(Q, r)}）` : ''}${u.interfaces ? `，從 ${u.interfaces.map((ep) => Q.epName(ep)).join('、')} 進來的回程` : ''}`; };
    const title = list.map(one).join('\n') + '\n新連線允許，回程可能被丟棄（推論，見 F15）';
    const rules = S.util.uniq(list.map((u) => u.rule).filter((k) => k && Q.getFirewallRule(k)));
    return h('span', { class: 'l4-return' }, [V.chip('⚠ 回程不保證', 'warn', { title }),
      ...rules.map((k) => { const a = ruleLink(App, Q.getFirewallRule(k), true); a.classList.add('l4-return-rule'); return h('span', { class: 'l4-return-rules' }, [' ', a]); })]);
  }
  /**
   * 看路徑：用這一列的外部代表位址與入口介面查 Q.reach（和暴露清單算這一列時的條件相同），結果在這一列的下方就地展開；
   * 同一列再按一次收起。展開後焦點到路徑的標題，收起（再按一次或 Esc）回到這一列的按鈕
   */
  function openExposure(App, sec, i) {
    const x = st.ex && st.ex[sec] && st.ex[sec].rows[i]; if (!x || x.family === 'ipv6') return; // IPv6 沒有逐跳路徑
    const p = st.exPath;
    if (p && p.sec === sec && p.row === i) { closeExposure(App); return; }
    const req = { src: x.src, dst: x.ip, proto: x.proto, port: x.port, vrf: null, entry: x.entry, from: 'exposure', sec, row: i };
    st.exPath = Object.assign({ sec, row: i }, I.runQuery(App, req));
    // 那一列在收起的部分（超過 EX_LIMIT 列）時先展開那一段
    if (!exShown(exGroups(st.ex[sec].rows), EX_LIMIT).some((g) => g.i === i)) st.exAll.add(sec);
    renderExposure(App);
    const r = st.exPath.reach;
    announce(r ? `逐跳路徑：${req.src} → ${req.dst} ${I.svcLabel(req)} ${V.L4_STATUS[r.verdict]}` : `逐跳路徑：查詢失敗，${st.exPath.err}`);
    const t = $('#l4-ex-path-title'); if (t) { t.focus(); if (t.scrollIntoView) t.scrollIntoView({ block: 'nearest' }); }
  }
  function closeExposure(App) {
    const p = st.exPath; if (!p) return;
    st.exPath = null; renderExposure(App);
    const btn = Array.from(els.ex.querySelectorAll('.l4-ex-path')).find((b) => b.dataset.sec === p.sec && b.dataset.row === String(p.row));
    if (btn) btn.focus();
  }
  /**
   * 顯示用的分組（不改判斷）：同一台設備、同一個服務、結果、允許來源、依據與入口都相同的列併成一列（例如設備每個介面位址的 icmp），
   * 位址列在 title；回傳 [{ x（第一列）, i（它在 rows 的位置）, ips }]
   */
  const exGroupsCache = new WeakMap();
  function exGroups(rows) {
    let out = exGroupsCache.get(rows); if (out) return out;
    const m = new Map(); out = [];
    rows.forEach((x, i) => {
      const k = [x.family || '', x.dev, x.src, x.entries.join(','), x.service, x.verdict, x.incomplete, x.allowedFrom.text, x.rule ? x.rule.key || `${x.rule.table}|${x.rule.chain}` : '', x.entry, x.target || '', x.subnet || '', x.nat ? x.nat.to : '', x.serviceName || '', x.reasons.join(','), x.findingKeys.join(','), (x.returnUnsafe || []).map((u) => u.dev + '|' + u.chain + '|' + u.rule).join(',')].join('\u0000');
      const g = m.get(k); if (g) { g.ips.push(x.ip); return; }
      const ng = { x, i, ips: [x.ip] }; m.set(k, ng); out.push(ng);
    });
    // 查詢層只依設備 → 位址族 → 位址 → 服務排序：先列允許、再列無法判斷（同結果內保留查詢層的順序），前 EX_LIMIT 列才不會把允許的收起來
    const rank = (v) => (v === 'allow' ? 0 : v === 'unknown' ? 1 : 2);
    out = out.map((g, n) => ({ g, n })).sort((a, b) => rank(a.g.x.verdict) - rank(b.g.x.verdict) || a.n - b.n).map((o) => o.g);
    // 第 1 段（列有 via）：依目的設備分組。有允許的設備在前、只有無法判斷的在後；同一類裡入口設備（有 via 為 null 的列）在前，
    // 再依上面排序後第一次出現的位置；設備內保留允許 → 無法判斷的順序。收合時顯示哪幾列另由 exShown 決定（允許優先）
    if (rows.some((x) => x.via !== undefined)) {
      const at = new Map(); out.forEach((g, n) => { if (!at.has(g.x.dev)) at.set(g.x.dev, n); });
      const entryDevs = new Set(rows.filter((x) => x.via === null).map((x) => x.dev));
      const allowDevs = new Set(out.filter((g) => g.x.verdict === 'allow').map((g) => g.x.dev));
      const devRank = (d) => (allowDevs.has(d) ? 0 : 2) + (entryDevs.has(d) ? 0 : 1);
      out = out.map((g, n) => ({ g, n })).sort((a, b) => devRank(a.g.x.dev) - devRank(b.g.x.dev) || at.get(a.g.x.dev) - at.get(b.g.x.dev) || a.n - b.n).map((o) => o.g);
      out.forEach((g) => { g.entryDev = entryDevs.has(g.x.dev); });
    }
    exGroupsCache.set(rows, out);
    return out;
  }
  /**
   * 收合（limit 列）時顯示的分組：先挑允許、再挑無法判斷（各自保留 gs 的順序）取前 limit 個，再依 gs 的順序排列。
   * 第 1 段依設備分組後允許可能排在別台設備的無法判斷之後，這樣挑才不會把允許的列收起來；其他段 gs 本來就允許在前，結果等於 gs.slice(0, limit)
   */
  function exShown(gs, limit) {
    if (gs.length <= limit) return gs;
    const pick = new Set(gs.filter((g) => g.x.verdict === 'allow').concat(gs.filter((g) => g.x.verdict !== 'allow')).slice(0, limit));
    return gs.filter((g) => pick.has(g));
  }
  /**
   * 怎麼進來（目的的第二行）：入口就在目的設備上時寫「設備 · 介面」；第 1 段經別台入口設備進來的列（via 不是 null）寫「經 <入口設備> 的 <介面>」
   */
  function entryText(App, x) {
    const more = x.entries.length > 1 ? ` 等 ${V.num(x.entries.length)} 個介面` : '';
    return x.via ? `經 ${App.Q.devName(x.via.dev)} 的 ${x.inInterface}${more}` : `${App.Q.devName(x.dev)} · ${x.inInterface}${more}`;
  }
  function exSection(App, def) {
    const xr = st.ex; const s = xr[def.key]; const denied = xr.denied ? xr.denied[def.key] : s.counts.deny;
    const deniedNote = deniedSentence(denied, xr.deniedBy ? xr.deniedBy[def.key] : null, s.counts.notEvaluated || 0);
    const gs = exGroups(s.rows);
    const nAllow = gs.filter((g) => g.x.verdict === 'allow').length; const nUnk = gs.length - nAllow;
    const sentence = s.rows.length ? `${V.num(nAllow)} 個服務允許${nUnk ? `、${V.num(nUnk)} 個無法判斷` : ''}。` : '沒有。' + (def.noCand && !s.counts.candidates ? def.noCand : def.none);
    const id = 'l4-ex-' + def.key + '-title';
    // 5 欄（1440 不水平捲動）：怎麼進來是目的的第二行；相關檢查是依據下面一行的代碼 chip（標題在 title）；看路徑在結果下方
    const cols = [
      { t: '目的', f: ({ x, ips }) => h('span', { class: 'l4-ex-dst', title: ips.length > 1 ? ips.join('\n') : null }, [exDst(App, def.key, x), ips.length > 1 ? h('span', { class: 'muted l4-ex-more' }, ` 等 ${V.num(ips.length)} 個位址`) : null,
        h('span', { class: 'muted l4-ex-entry' }, entryText(App, x))]) },
      { t: '服務', f: ({ x }) => h('span', { class: 'mono' }, exSvc(x)) },
      { t: '允許來源', f: ({ x }) => (x.allowedFrom.kind === 'any' ? V.chip('⚠ ' + x.allowedFrom.text, 'warn') : h('span', { class: 'mono' }, x.allowedFrom.text)) },
      { t: '結果', f: ({ x, i }) => { const on = !!(st.exPath && st.exPath.sec === def.key && st.exPath.row === i);
        // IPv6 只看邊界路由器（查詢層不做 IPv6 路由）：沒有逐跳路徑，不呼叫 Q.reach
        if (x.family === 'ipv6') return h('span', { class: 'l4-ex-res' }, [exResult(App, x), h('span', { class: 'muted l4-ex-nopath' }, 'IPv6 只看邊界路由器，沒有逐跳路徑')]);
        return h('span', { class: 'l4-ex-res' }, [exResult(App, x),
          h('button', { type: 'button', class: 'ghost l4-ex-path', 'data-sec': def.key, 'data-row': String(i), 'aria-expanded': String(on), 'aria-controls': on ? 'l4-ex-path-box' : null,
            onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); openExposure(App, def.key, i); } }, on ? '收起路徑' : '看路徑')]); } },
      { t: '依據', f: ({ x }) => { const ls = x.findingKeys.map((k) => findingLink(App, k, true)).filter(Boolean);
        return h('span', { class: 'l4-ex-basis' }, [x.rule ? ruleLink(App, x.rule, true) : h('span', null, '—'), ls.length ? h('span', { class: 'l4-ex-findings' }, ls) : null]); } },
    ];
    // 每段最多先列 EX_LIMIT 列，其餘「顯示全部（N）」（同一段只有一個按鈕在 Tab 順序裡）
    const all = st.exAll.has(def.key); let shown = exShown(gs, all ? ROW_LIMIT : EX_LIMIT);
    // 看路徑的那一列在顯示上限（ROW_LIMIT）之後時，另外接在最後（路徑與焦點才有地方放）
    const op = st.exPath && st.exPath.sec === def.key ? gs.find((g) => g.i === st.exPath.row) : null;
    const extra = op && !shown.includes(op) ? op : null;
    if (extra) shown = shown.concat([extra]);
    const more = gs.length > EX_LIMIT ? h('button', { type: 'button', class: 'ghost l4-ex-all', 'data-sec': def.key, 'aria-expanded': String(all),
      onclick: () => { if (all) st.exAll.delete(def.key); else st.exAll.add(def.key); renderExposure(App); const b = Array.from(els.ex.querySelectorAll('.l4-ex-all')).find((x) => x.dataset.sec === def.key); if (b) b.focus(); } },
    all ? `只顯示前 ${EX_LIMIT} 列` : `顯示全部（${V.num(gs.length)}）`) : null;
    return h('section', { class: 'l4-ex-sec', 'data-sec': def.key, 'aria-labelledby': id }, [
      h('h4', { id, class: 'l4-ex-title' }, [def.title, ' ', V.chip(V.num(gs.length))]),
      h('p', { class: 'l4-ex-sentence' }, sentence),
      s.rows.length ? exTable(App, def, cols, shown) : null,
      all && gs.length > ROW_LIMIT ? h('div', { class: 'muted table-more' }, `只顯示前 ${ROW_LIMIT} 列，共 ${V.num(gs.length)} 列${extra ? `；看路徑的第 ${V.num(gs.indexOf(extra) + 1)} 列另接在最後` : ''}`) : null,
      more,
      deniedNote ? h('p', { class: 'muted l4-ex-denied', title: s.counts.notEvaluated ? '沒判斷（上限）：判斷次數的上限用完，這些組合沒有判斷，不算拒絕' : null }, deniedNote) : null,
    ]);
  }
  /**
   * 暴露清單的表格（依 exGroups 的順序：允許 → 無法判斷，表頭不排序）；和 V.table 的 stack 一樣窄螢幕時每列排成一塊、每格前面寫欄名。
   * 看路徑的那一列下方多一列（colspan），放逐跳路徑
   */
  function exTable(App, def, cols, groups) {
    const tb = h('tbody'); let lastDev = null;
    groups.forEach((g) => {
      // 第 1 段依設備分組（exGroups 已排好）：每台設備前一列標題，寫出它是入口設備或要經別台入口設備
      if (g.entryDev !== undefined && g.x.dev !== lastDev) {
        lastDev = g.x.dev;
        tb.appendChild(h('tr', { class: 'l4-ex-devrow', 'data-dev': g.x.dev }, h('th', { colspan: String(cols.length), scope: 'colgroup' },
          [App.Q.devName(g.x.dev), ' ', V.chip(g.entryDev ? '入口設備' : '經其他入口設備', g.entryDev ? 'info' : '')])));
      }
      tb.appendChild(h('tr', { class: 'l4-ex-row st-' + g.x.verdict, 'data-family': g.x.family || null, 'data-row': String(g.i) }, cols.map((c) => h('td', { 'data-label': c.t }, c.f(g)))));
      const p = st.exPath;
      if (p && p.sec === def.key && p.row === g.i) {
        const onVrf = (v) => { st.exPath = Object.assign({ sec: p.sec, row: p.row }, I.runQuery(App, Object.assign({}, p.req, { vrf: v }))); renderExposure(App); const t = $('#l4-ex-path-title'); if (t) t.focus(); };
        const box = h('div', { id: 'l4-ex-path-box', class: 'l4-ex-pathbox', onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); closeExposure(App); } } },
          I.reachBlock(App, { q: p.req, r: p.reach, err: p.err, vrfs: p.vrfs, titleId: 'l4-ex-path-title', onVrf }));
        tb.appendChild(h('tr', { class: 'l4-ex-pathrow' }, h('td', { colspan: String(cols.length) }, box)));
      }
    });
    return h('div', { class: 'table-scroll' }, h('table', { class: 't stack' }, [h('thead', null, h('tr', null, cols.map((c) => h('th', null, c.t)))), tb]));
  }
  /**
   * IPv6 的說明：照列 Q.exposure().ipv6 的 message（狀態 edge-only／no-ipv6-address／no-wan／not-evaluated 由查詢層決定），
   * 沒有判斷的入口設備（missing）逐台寫出原因
   */
  function ipv6Note(App, xr) {
    const Q = App.Q; const v = xr.ipv6;
    if (!v) return h('p', { id: 'l4-ex-ipv6', class: 'muted l4-ex-notes' }, '依 IPv4 的防火牆與 NAT 推論；IPv6 未納入。');
    const miss = (v.missing || []).map((m) => `${Q.devName(m.dev)}：${V.L4_IPV6_MISSING[m.reason] || m.reason}`);
    return h('p', { id: 'l4-ex-ipv6', class: 'muted l4-ex-notes', 'data-status': v.status }, [v.message || '',
      miss.length ? h('span', { class: 'l4-ex-ipv6-missing' }, `　沒有判斷 IPv6 的入口設備：${miss.join('；')}。`) : null]);
  }
  /** 頁尾的判斷的前提：有暴露清單時用它的 assumptions（含暴露清單另加的前提），否則用 S.query.reachAssumptions */
  function fillAssume(list) {
    els.assumeSum.textContent = `判斷的前提（${V.num(list.length)} 條）`;
    V.clear(els.assumeList);
    list.forEach((a) => els.assumeList.appendChild(h('li', { 'data-code': a.code }, a.message)));
  }
  function openAssume() {
    els.assumeFold.setAttribute('open', ''); els.assumeFold.open = true;
    const sm = els.assumeFold.querySelector('summary'); if (sm) { sm.focus(); if (sm.scrollIntoView) sm.scrollIntoView({ block: 'start' }); }
  }
  /** 頁首的結論句與三段；沒有 WAN 時合併成一張說明並展開內部互通 */
  function renderExposure(App) {
    if (!els.root) return;
    const box = V.clear(els.ex); const Q = App.Q; const hd = V.clear(els.exHead);
    // 第一句結論在頁首（h2 下面），後面接頁面唯一的推論標示與「前提」連結（各段、各列只有給輔助科技念的「（推論）」）
    const tail = () => [' ', V.chip('推論', 'info', { title: '依基準的路由與防火牆規則推論，不寫進基準；前提見頁尾' }), ' ',
      h('a', { class: 'link l4-ex-assume', href: '#l4-assume-fold', onclick: (e) => { if (e && e.preventDefault) e.preventDefault(); openAssume(); } }, '前提')];
    const head = (children) => children.concat(tail()).forEach((c) => { if (c) hd.appendChild(typeof c === 'string' ? h('span', null, c) : c); });
    box.appendChild(h('h3', { id: 'l4-ex-title', class: 'work-card-title' }, '從外部進來'));
    if (st.exErr) { head(['無法計算從外部進得來什麼。']); box.appendChild(h('p', { class: 'diffA l4-ex-error', role: 'alert' }, '無法計算：' + st.exErr)); return; }
    if (!st.ex) {
      if (!exJob) { head(['已停止計算（離開了 L4）；回到 L4 時重新計算。']); return; }
      head(['計算中…']);
      box.appendChild(h('div', { class: 'l4-busy' }, [
        h('div', { id: 'l4-ex-progress', class: 'progress indeterminate', role: 'progressbar', 'aria-label': '從外部進來的計算進度', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuetext': '準備中' }, h('div')),
        h('span', { id: 'l4-ex-progress-text', class: 'l4-progress-text', 'aria-hidden': 'true' }, '準備中')]));
      return;
    }
    const xr = st.ex;
    fillAssume(Array.isArray(xr.assumptions) && xr.assumptions.length ? xr.assumptions : S.query.reachAssumptions());
    if (xr.status !== 'ok') {
      const nw = (xr.noWan || []).map((x) => findingLink(App, x.findingKey)).filter(Boolean);
      head([xr.status === 'no-wan' ? '找不到 WAN 介面，無法判斷從外部進得來什麼。' : xr.message || '無法判斷從外部進得來什麼。']);
      box.appendChild(h('p', { class: 'muted l4-ex-nowan' }, [xr.status === 'no-wan' ? '用 interface list 把對外的介面放進名稱含 WAN 的清單（F08）。' : '', ...nw.flatMap((l) => [' ', l])]));
      if (xr.ipv6) box.appendChild(ipv6Note(App, xr));
      // 這時內部互通是唯一有內容的段：預設展開（並開始計算矩陣）
      if (!isOpen(els.matrixFold)) I.openMatrix(App);
      return;
    }
    const allow = (k) => exGroups(xr[k].rows).filter((g) => g.x.verdict === 'allow').length;
    const unk = EX_SECS.reduce((n, d) => n + exGroups(xr[d.key].rows).length - allow(d.key), 0);
    const total = EX_SECS.reduce((n, d) => n + allow(d.key), 0);
    const part = (n) => (n ? `${V.num(n)} 個` : '沒有');
    const noFw = (xr.noFirewall || []).map((d) => Q.devName(typeof d === 'string' ? d : d.dev));
    head([total ? `從外部進來，連得到 ${V.num(total)} 個服務：網路設備本身 ${part(allow('self'))}、轉送到內部 ${part(allow('dnat'))}、直接路由 ${part(allow('routed'))}。` : '從外部進來，連不到任何服務。',
      unk ? `另有 ${V.num(unk)} 個無法判斷。` : '',
      noFw.length ? `另有 ${noFw.join('、')} 無法判斷（沒有防火牆資料，缺 /export）。` : '']);
    box.appendChild(ipv6Note(App, xr));
    if (xr.limits && xr.limits.truncated) box.appendChild(h('p', { class: 'muted l4-ex-notes' }, `判斷次數超過上限（${V.num(xr.limits.maxEvaluations)} 次），只算到一部分。`));
    EX_SECS.forEach((d) => box.appendChild(exSection(App, d)));
  }

  Object.assign(I, { deniedSentence, exRuns, stopEx, exposure, returnTag, openExposure, exGroups, fillAssume });
})(globalThis.SSOT = globalThis.SSOT || {});
