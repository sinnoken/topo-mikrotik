/*
 * 檢查結果報表（S.report）：CSV 與 Markdown。畫面的匯出（src/view/export.js）與 CLI（tools/baseline.js）共用這裡的文字。
 * 下游模組：只透過查詢介面（Q＝S.query(snapshot)）與 S.query.rule／S.query.rules 讀基準與檢查目錄，不改寫；上游不呼叫這裡。
 * 處理紀錄是使用者的資料（不在 Snapshot 裡），由呼叫端以 opts.ledgerOf 傳入；狀態判斷用 S.ledger.isPending。
 * 主管摘要（managerSummary）另在呼叫時用 S.compare.snapshots（與上一輪相比）與 S.remediate.levelOf／plan（處理方式的等級與選項），
 * 不另寫一份比對或等級規則；兩者都在報表之前載入。
 * 不碰 DOM：組字邏輯都是純函式。
 */
(function (S) {
  'use strict';
  const U = S.util;

  // ---------------------------------------------------------------- 報表用語（單一來源；畫面同名的 V.* 應與這些相同）
  /** 嚴重度的顯示名稱，與輸出順序 */
  const SEV_TEXT = Object.freeze({ error: '錯誤', warn: '警告', info: '提醒' });
  const SEV_ORDER = Object.freeze(['error', 'warn', 'info']);
  /** 處理紀錄的狀態鍵（S.ledger 的狀態）→ 顯示文字；不認得的狀態（例如較新版本寫入的）原樣顯示 */
  const STATUS_TEXT = Object.freeze({ open: '待處理', scheduled: '已排定修正', accepted: '接受風險', 'false-positive': '誤報', fixed: '已修好', regressed: '復發' });
  const statusText = (s) => (s ? STATUS_TEXT[s] || s : '待處理');
  /** 與多數不同（finding.deviation，多數決的推論）的標籤與平手的說法 */
  const DEVIATION = '與多數不同';
  const DEVIATION_LABEL = DEVIATION + '（推論）';
  const NO_MAJORITY = '沒有多數';
  /** 多數決判定與多數不同的設備鍵：不是多數決（或沒有 deviation）時 null，平手時空陣列 */
  const majorityDeviating = (dv) => (dv && dv.basis === 'majority' ? dv.deviating || [] : null);

  /**
   * 反引號標出的 RouterOS 指令與欄位（CATALOG 的 causes／action 的寫法）：切成 [{ text, code }]。
   * 沒有成對的反引號保留為一般文字，不吞掉。
   */
  function codeParts(s) {
    const str = String(s); const out = []; const re = /`([^`]+)`/g; let at = 0; let m;
    while ((m = re.exec(str))) {
      if (m.index > at) out.push({ text: str.slice(at, m.index), code: false });
      out.push({ text: m[1], code: true }); at = re.lastIndex;
    }
    if (at < str.length) out.push({ text: str.slice(at), code: false });
    return out;
  }

  /**
   * 檢查的處理建議與常見原因：每次都從檢查目錄（S.query.rule）讀取，不複製文字。
   * 回傳 { action: 字串或 null, hint: 字串或 null, causes: 字串陣列 }；欄位不存在時 action／hint 為 null、causes 為空陣列。
   * causes 寫成單一字串時視為一條。
   */
  function advice(id) {
    const c = S.query.rule(id) || {};
    const causes = Array.isArray(c.causes) ? c.causes.filter((x) => typeof x === 'string' && x) : typeof c.causes === 'string' && c.causes ? [c.causes] : [];
    return { action: typeof c.action === 'string' && c.action ? c.action : null, hint: typeof c.hint === 'string' && c.hint ? c.hint : null, causes };
  }

  /**
   * 依設備排序（穩定）：所屬設備（Q.findingDevice）名稱的自然順序，不屬於任何設備的排最後；同一台設備內保留原順序。
   * 回傳 [{ f, idx, dev }]。
   */
  function sortByDevice(Q, findings) {
    const rows = findings.map((f, idx) => ({ f, idx, dev: Q.findingDevice(f) }));
    return rows.sort((a, b) => {
      if (a.dev === b.dev) return a.idx - b.idx;
      if (a.dev === null || b.dev === null) return a.dev === null ? 1 : -1;
      return U.natural(Q.devName(a.dev), Q.devName(b.dev)) || U.cmp(a.dev, b.dev) || a.idx - b.idx;
    });
  }

  // ---------------------------------------------------------------- 共用
  // 開頭是這些字元的儲存格會被試算表當成公式執行（CSV 公式注入），前面加 ' 讓它保持文字
  const FORMULA_START = /^[=+\-@\t\r]/;
  const entityText = (e) => `${e.type}:${e.key}`;
  const evidenceText = (e) => `${e.file}:${e.line}`;
  /** 與多數不同的設備名，以 sep 連接：平手為 NO_MAJORITY；不是多數決或沒有 deviation 時 null */
  const deviationText = (Q, f, sep) => {
    const devs = majorityDeviating(f.deviation);
    return !devs ? null : devs.length ? devs.map((k) => Q.devName(k)).join(sep) : NO_MAJORITY;
  };

  /** 單一 CSV 儲存格：含逗號、引號、換行或前後空白時加引號，引號重複一次（RFC 4180） */
  function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    if (FORMULA_START.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * opts.ledgerOf(f) → 處理紀錄 { status, at, note, waiver } 或 null（at 是使用者最後一次變更的時間，沒有時為 null）。
   * 沒傳時視為都不在處理紀錄中（待處理）。
   */
  const ledgerOf = (opts) => (opts && opts.ledgerOf ? opts.ledgerOf : () => null);
  /** 已處理（不是待處理）時的處理紀錄，否則 null：舊欄位 acknowledged／ack_kind／ack_note 與 Markdown 的已處理標示用 */
  const handledOf = (lg) => (lg && !S.ledger.isPending(lg.status) ? lg : null);
  /** 輸出的順序：預設保留 Snapshot 的順序；opts.byDevice 時依設備（sortByDevice） */
  const ordered = (Q, opts) => (opts && opts.byDevice
    ? sortByDevice(Q, Q.findings())
    : Q.findings().map((f, idx) => ({ f, idx, dev: Q.findingDevice(f) })));

  /**
   * 檢查結果 CSV：一筆 finding 一列；多個相關實體、多筆證據各自合在同一格，以「; 」分隔。
   * 處理紀錄的欄位（舊的確認標記改由處理紀錄對應，欄名與位置不變，供舊的試算表沿用）：
   *   acknowledged：已處理（狀態不是 open／regressed）時，使用者最後一次變更的時間（UTC ISO）；待處理時空白
   *   ack_kind    ：已處理時的狀態（scheduled／accepted／false-positive／fixed）；待處理時空白
   *   ack_note    ：已處理時的備註；待處理時空白
   *   status      ：處理紀錄的狀態（open／scheduled／accepted／false-positive／fixed／regressed）；不在處理紀錄中時空白
   *   note        ：備註（不論狀態）；waiver_reason／waiver_until：接受風險的豁免原因與到期日（UTC ISO）
   * device 是所屬設備鍵（Q.findingDevice；不屬於任何設備為空白）。
   * action 是檢查的處理建議（CATALOG，advice），原文照錄（反引號保留）；檢查沒有處理建議時為空白。
   * facet 是比對對象（finding.facet 原值，例如 A12 的 dns／ntp，會進入 findingKey）；檢查沒有 facet 時空白。
   *   放原值而不是顯示文字：給試算表篩選與對照 findingKey 用，訊息本身已經寫出項目。
   * 常見原因不放進 CSV：每列都會重複同一段多句文字，合在一格也不好篩選；Markdown 報表有。
   * 最後一欄（欄名 DEVIATION_LABEL）是與多數不同的設備名（推論，以「; 」分隔）；平手寫 NO_MAJORITY，不是多數決的檢查空白。
   * 新欄位一律加在最後，既有欄位的位置不變。
   * 開頭加 UTF-8 BOM，Excel 才會以 UTF-8 讀取中文；換行用 CRLF。
   */
  function findingsCsv(Q, opts) {
    const lgOf = ledgerOf(opts);
    const head = ['severity', 'id', 'title', 'message', 'entities', 'evidence', 'acknowledged', 'ack_kind', 'ack_note', 'device', 'action',
      'status', 'note', 'waiver_reason', 'waiver_until', 'facet', DEVIATION_LABEL];
    const rows = ordered(Q, opts).map(({ f, dev }) => {
      const lg = lgOf(f); const done = handledOf(lg) || {}; const w = (lg && lg.waiver) || {};
      return [
        f.severity, f.id, f.title, f.message,
        f.entities.map(entityText).join('; '),
        f.evidence.map(evidenceText).join('; '),
        done.at || '', done.status || '', done.note || '', dev || '',
        advice(f.id).action || '',
        lg ? lg.status : '', lg ? lg.note || '' : '', w.reason || '', w.until || '',
        f.facet != null ? String(f.facet) : '',
        deviationText(Q, f, '; ') || '',
      ];
    });
    return '\uFEFF' + [head].concat(rows).map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  /**
   * Markdown 行內文字：跳脫會被當成格式或 HTML 的標點，換行改成空白。
   * 底線不跳脫：設備名稱常見的字中底線（TPE_ACC_SW_01）不會形成強調，跳脫反而難讀。
   */
  const mdText = (s) => String(s).replace(/\r?\n/g, ' ').replace(/([\\`*[\]<>|])/g, '\\$1');
  /** Markdown 行內程式碼：用比內容最長的連續反引號再多一個來包住 */
  const mdCode = (s) => {
    const t = String(s).replace(/\r?\n/g, ' ');
    const run = Math.max(0, ...(t.match(/`+/g) || []).map((x) => x.length));
    const fence = '`'.repeat(run + 1); const pad = run ? ' ' : '';
    return fence + pad + t + pad + fence;
  };
  /** CATALOG 文字：反引號內的指令與欄位轉成行內程式碼（codeParts），其餘照 mdText 跳脫 */
  const mdRich = (s) => codeParts(s).map((p) => (p.code ? mdCode(p.text) : mdText(p.text))).join('');
  /** 檢查的處理建議與常見原因（advice，文字來自 CATALOG）：欄位不存在時不輸出 */
  const catalogLines = (id) => {
    const a = advice(id); const out = [];
    if (a.action) out.push(`- 處理建議：${mdRich(a.action)}`);
    if (a.causes.length) out.push('- 常見原因：', ...a.causes.map((c) => `  - ${mdRich(c)}`));
    return out.length ? out.concat('') : out;
  };

  /**
   * 檢查結果 Markdown 報表。已處理的項目加註狀態與時間，豁免與備註另起一行；復發的項目標示「復發」。
   *   預設：依嚴重度分組，組內依檢查代碼分段，保留 Snapshot 的排列順序。
   *   opts.byDevice：依設備分組（Q.findingDevice），不屬於任何設備的最後一組；組內保留原順序。
   *     同一項檢查會出現在很多台設備，處理建議與常見原因只在報表最後的附錄列一次（依 CATALOG 的順序）。
   */
  function findingsMarkdown(Q, opts) {
    const lgOf = ledgerOf(opts);
    const m = Q.meta(); const st = m.stats; const all = Q.findings();
    const counts = {};
    all.forEach((f) => { const lg = lgOf(f); if (lg && lg.status !== 'open') counts[lg.status] = (counts[lg.status] || 0) + 1; });
    const statusLine = Object.keys(STATUS_TEXT).filter((s) => counts[s]).map((s) => `${statusText(s)} ${counts[s]}`)
      .concat(Object.keys(counts).filter((s) => !STATUS_TEXT[s]).map((s) => `${s} ${counts[s]}`)).join('、') || '沒有';
    const out = [
      '# 基準檢查報表', '',
      `- 建立時間：${m.createdAt}`,
      `- 版本：${m.version}（${m.schema}）`,
      `- 輸入指紋：${mdCode(m.inputHash)}`,
      `- 命名規則：${m.profile ? mdText(m.profile.id) : '未套用'}`,
      `- 設備：${st.devices}（已收集 ${st.collected}）`,
      `- 檢查結果：${SEV_ORDER.map((s) => `${SEV_TEXT[s]} ${st.findings[s]}`).join('、')}`,
      `- 處理紀錄：${mdText(statusLine)}`,
    ];
    /** 一筆 finding：已處理時「**狀態**（時間）」、復發時「**復發**」；豁免與備註另起一行 */
    const item = (f, prefix) => {
      const lg = lgOf(f); const done = handledOf(lg);
      const mark = done ? `**${mdText(statusText(done.status))}**${done.at ? `（${done.at}）` : ''} ` : lg && lg.status === 'regressed' ? '**復發** ' : '';
      out.push(`- ${mark}${prefix || ''}${mdText(f.message)}`);
      if (lg && lg.waiver) out.push(`  - 豁免：${mdText(lg.waiver.reason || '（未填原因）')}，到期 ${lg.waiver.until}`);
      if (lg && lg.note) out.push(`  - 備註：${mdText(lg.note)}`);
      const dv = deviationText(Q, f, '、');
      if (dv) out.push(`  - ${DEVIATION_LABEL}：${mdText(dv)}`);
      if (f.entities.length) out.push(`  - 相關實體：${f.entities.map((e) => mdCode(entityText(e))).join('、')}`);
      f.evidence.forEach((e) => out.push(`  - 證據：${mdText(e.file)} 第 ${e.line} 行：${mdCode(e.text)}`));
    };
    if (opts && opts.byDevice) {
      const groups = new Map();
      sortByDevice(Q, all).forEach((r) => U.getOr(groups, r.dev, () => []).push(r.f));
      groups.forEach((fs, dev) => {
        if (out[out.length - 1] !== '') out.push('');
        out.push(`## ${dev === null ? '不屬於任何設備' : mdText(Q.devName(dev))}（${fs.length}）`, '');
        fs.forEach((f) => item(f, `${SEV_TEXT[f.severity]} ${f.id} ${mdText(f.title)}：`));
      });
      if (!groups.size) out.push('', '沒有檢查結果。');
      const used = new Set(all.map((f) => f.id));
      const rules = S.query.rules().filter((r) => used.has(r.id) && catalogLines(r.id).length);
      if (rules.length) {
        if (out[out.length - 1] !== '') out.push('');
        out.push('## 附錄：處理建議與常見原因', '');
        rules.forEach((r) => out.push(`### ${r.id} ${mdText(r.title)}`, '', ...catalogLines(r.id)));
      }
      return out.join('\n').replace(/\n+$/, '') + '\n';
    }
    SEV_ORDER.forEach((sev) => {
      const list = all.filter((f) => f.severity === sev);
      if (out[out.length - 1] !== '') out.push('');
      out.push(`## ${SEV_TEXT[sev]}（${list.length}）`, '');
      if (!list.length) { out.push('沒有。'); return; }
      const byId = new Map();
      list.forEach((f) => U.getOr(byId, f.id, () => []).push(f));
      byId.forEach((fs, id) => {
        out.push(`### ${id} ${mdText(fs[0].title)}（${fs.length}）`, '');
        out.push(...catalogLines(id));
        fs.forEach((f) => item(f));
        out.push('');
      });
    });
    return out.join('\n').replace(/\n+$/, '') + '\n';
  }

  /** 處理紀錄項目中使用者最後一次變更的時間（歷程中最後一筆 by user）；沒有時為 null */
  const userAt = (it) => { const h = ((it && it.history) || []).filter((x) => x.by === 'user'); return h.length ? h[h.length - 1].at : null; };
  /**
   * 由處理紀錄（ssot-ledger/1）產生 opts.ledgerOf：f → { status, at（使用者最後一次變更）, note, waiver }；不在處理紀錄中時為 null。
   * CLI 用它；畫面的 A.ledgerExport 是同一個對應（另外處理處理紀錄被擋下的情況）。
   */
  const ledgerOfItems = (ledger, Q) => (f) => {
    const it = (ledger && ledger.items && ledger.items[Q.findingKey(f)]) || null;
    return it ? { status: it.status, at: userAt(it), note: it.note, waiver: it.waiver } : null;
  };

  // ---------------------------------------------------------------- 主管摘要
  /** 重點與暴露清單預設列出的筆數 */
  const SUMMARY_LIMIT = 10;
  const EXPOSURE_LIMIT = 5;
  /** 暴露清單的三段（Q.exposure 的欄位）與摘要中的名稱 */
  const EXPOSURE_SECTIONS = Object.freeze([['self', '網路設備本身'], ['dnat', '經 dst-nat 轉送到內部'], ['routed', '直接路由到內部']]);
  /** 修正 patch 的等級（S.remediate.levelOf）的說法與處理順序：可直接產生指令的先做 */
  const LEVEL_TEXT = Object.freeze({ auto: '可直接產生修正指令', choice: '要先選擇處理方式', manual: '需要人工判斷' });
  const LEVEL_ORDER = Object.freeze(['auto', 'choice', 'manual']);
  const levelOf = (id) => S.remediate.levelOf(id);
  const plural = (n) => `${n} 筆`;
  /** 檢查代碼與筆數：F01（2）、R03（1），依第一次出現的順序 */
  const idCounts = (fs) => {
    const m = new Map(); fs.forEach((f) => m.set(f.id, (m.get(f.id) || 0) + 1));
    return [...m].map(([id, n]) => `${id}（${n}）`).join('、');
  };

  /** 與上一輪基準相比的錯誤與警告（S.compare.snapshots 的 finding 類別）；無法比對時寫出原因 */
  function changeLines(prev, Q) {
    const d = S.compare.snapshots(prev, Q);
    const pm = prev.meta();
    if (d.errors.length) return [`- 無法與上一輪基準（${pm.createdAt}）比對：${mdText(d.errors.join('；'))}`];
    const of = (change) => d.items.filter((x) => x.category === 'finding' && x.change === change && SEV_ORDER.indexOf(
      (x.after || x.before).severity) < 2);
    const added = of('added'); const removed = of('removed'); const net = added.length - removed.length;
    const verdict = net < 0 ? '變好' : net > 0 ? '變差' : added.length ? '筆數持平，但內容有變' : '沒有變化';
    const out = [`- 與上一輪基準（${pm.createdAt}）相比，錯誤與警告新出現 ${added.length} 筆、已消失 ${removed.length} 筆：${verdict}。`];
    d.warnings.forEach((w) => out.push(`  - ${mdText(w.message)}`));
    return out;
  }

  /** 暴露清單的一列：目的、服務、允許的來源 */
  function exposureRow(Q, sec, r) {
    const dst = sec === 'self' ? `${Q.devName(r.dev)} ${r.ip}` : sec === 'dnat' && r.nat ? `${r.nat.from} → ${r.nat.to}` : r.ip;
    const svc = r.serviceName ? `${r.service}（${r.serviceName}）` : r.service;
    const note = r.incomplete ? '（部分來源或入口無法判斷）' : '';
    return `  - ${mdText(dst)}，${mdText(svc)}：允許 ${mdText(r.allowedFrom.text)}${note}`;
  }

  /**
   * 主管摘要（Markdown）：給不看技術細節的人一分鐘讀完。只用基準的事實與推論（推論標示），不評分、不估工時。
   * 分級沿用檢查的嚴重度（錯誤／警告／提醒）；「從外部進得來的」是暴露清單（Q.exposure，推論），與嚴重度分開呈現，不改變分級。
   * opts：
   *   ledgerOf(f)：同 findingsMarkdown；已處理的不列入重點、需要決定的事與處理順序（沒傳時全部是待處理）
   *   zones：Q.exposure 的參數（同 siteDocTables，例如 { profile }）；exposure：已算好的 Q.exposure 結果（畫面傳入，避免重算）
   *   previous：上一輪基準的查詢介面（S.query(snapshot)）；有時以 S.compare.snapshots 寫出錯誤與警告變好或變差
   *   limit：重點最多列幾筆（預設 SUMMARY_LIMIT）；exposureLimit：暴露清單每段最多列幾列（預設 EXPOSURE_LIMIT）
   */
  function managerSummary(Q, opts) {
    const o = opts || {}; const lgOf = ledgerOf(o);
    const limit = o.limit === undefined ? SUMMARY_LIMIT : o.limit;
    const exLimit = o.exposureLimit === undefined ? EXPOSURE_LIMIT : o.exposureLimit;
    [['limit', limit], ['exposureLimit', exLimit]].forEach(([k, v]) => {
      if (!Number.isInteger(v) || v < 0) throw new TypeError(`S.report.managerSummary：${k} 必須是非負整數`);
    });
    const m = Q.meta(); const st = m.stats; const all = Q.findings();
    const pendingOf = (f) => { const lg = lgOf(f); return S.ledger.isPending(lg ? lg.status : null); };
    const ps = Q.pendingSummary(pendingOf);
    const out = ['# 主管摘要', '', `依據 ${m.createdAt} 建立的基準（設備 ${st.devices} 台，已收集 ${st.collected} 台）。` +
      '分級沿用檢查的嚴重度；標「推論」的部分由路由與防火牆規則推得，不是收集到的事實。', ''];

    // 整體狀態
    out.push('## 整體狀態', '');
    out.push(`- 檢查結果：${SEV_ORDER.map((s) => `${SEV_TEXT[s]} ${st.findings[s]}`).join('、')}；` +
      `待處理：${SEV_ORDER.map((s) => `${SEV_TEXT[s]} ${ps[s]}`).join('、')}${ps.handled ? `（另有已處理的錯誤與警告 ${ps.handled} 筆）` : ''}。`);
    if (o.previous) out.push(...changeLines(o.previous, Q));
    out.push('');

    // 從外部進得來的（推論）
    out.push('## 從外部進得來的（推論）', '');
    const ex = o.exposure || Q.exposure(o.zones);
    const reachable = new Set();
    if (ex.status !== 'ok') {
      out.push(`- ${mdText(ex.message || '無法判斷從外部進得來什麼。')}`);
    } else {
      const c = (k) => ex[k].counts;
      const allow = EXPOSURE_SECTIONS.reduce((n, [k]) => n + c(k).allow, 0);
      const unknown = EXPOSURE_SECTIONS.reduce((n, [k]) => n + c(k).unknown, 0);
      out.push(`- ${allow ? `從外部連得到 ${allow} 個組合（目的位址 × 服務）` : '從外部連不到任何服務'}` +
        `${unknown ? `，另有 ${unknown} 個無法判斷` : ''}。`);
      EXPOSURE_SECTIONS.forEach(([k, name]) => {
        const rows = ex[k].rows.filter((r) => r.verdict === 'allow');
        rows.forEach((r) => r.findingKeys.forEach((fk) => reachable.add(fk)));
        out.push(`- ${name}：允許 ${c(k).allow}、無法判斷 ${c(k).unknown}、拒絕 ${c(k).deny}。`);
        rows.slice(0, exLimit).forEach((r) => out.push(exposureRow(Q, k, r)));
        if (rows.length > exLimit && exLimit) out.push(`  - 另有 ${rows.length - exLimit} 個允許的組合`);
      });
      if (ex.noFirewall && ex.noFirewall.length) {
        out.push(`- 無法判斷：${ex.noFirewall.map((d) => mdText(Q.devName(typeof d === 'string' ? d : d.dev))).join('、')}（沒有防火牆資料，缺 /export）。`);
      }
      if (ex.limits && ex.limits.truncated) out.push(`- 判斷次數超過上限（${ex.limits.maxEvaluations} 次），只算到一部分。`);
      out.push(`- 這是推論，前提有 ${ex.assumptions.length} 條（畫面 L4 頁尾的「前提」）。`);
    }
    out.push('');

    // 重點：待處理的錯誤與警告，依嚴重度、再依設備
    const pending = all.filter(pendingOf);
    const sevRows = (sevs) => sevs.flatMap((s) => sortByDevice(Q, pending.filter((f) => f.severity === s)));
    const key = sevRows(['error', 'warn']);
    out.push(`## 錯誤與警告的重點（待處理 ${plural(key.length)}）`, '');
    if (!key.length) out.push('- 沒有待處理的錯誤與警告。');
    key.slice(0, limit).forEach(({ f, dev }) => {
      const a = advice(f.id);
      const where = dev === null ? '' : `${mdText(Q.devName(dev))}：`;
      const ext = reachable.has(Q.findingKey(f)) ? '（從外部連得到，推論）' : '';
      out.push(`- **${SEV_TEXT[f.severity]}** ${f.id} ${where}${mdText(f.message)}${ext}${a.hint ? `；處理：${mdRich(a.hint)}` : ''}`);
    });
    if (key.length > limit) out.push(`- 另有 ${plural(key.length - limit)}（見檢查結果報表）。`);
    out.push('');

    // 需要決定的事：修正 patch 中要先選擇處理方式的檢查
    const choice = sevRows(SEV_ORDER).map((r) => r.f).filter((f) => levelOf(f.id) === 'choice');
    out.push('## 需要決定的事', '');
    if (!choice.length) out.push('- 沒有。');
    const plan = choice.length ? S.remediate.plan(Q, choice.map((f) => Q.findingKey(f))) : null;
    const optsByKey = new Map(plan ? plan.choices.map((c) => [c.findingKey, c]) : []);
    const byId = new Map(); choice.forEach((f) => U.getOr(byId, f.id, () => []).push(f));
    byId.forEach((fs, id) => {
      const a = advice(id);
      out.push(`- ${id} ${mdText(fs[0].title)}（${plural(fs.length)}）${a.hint ? `：${mdRich(a.hint)}` : ''}`);
      fs.forEach((f) => {
        const c = optsByKey.get(Q.findingKey(f));
        if (c) out.push(`  - ${mdText(f.message)}`, ...c.options.map((x) => `    - 選項：${mdText(x.label)}${x.inferred ? '（推論）' : ''}`));
      });
    });
    out.push('');

    // 建議的處理順序：依嚴重度，同一級裡可直接產生修正指令的先做
    out.push('## 建議的處理順序', '');
    let n = 0;
    SEV_ORDER.forEach((s) => LEVEL_ORDER.forEach((lv) => {
      const fs = pending.filter((f) => f.severity === s && levelOf(f.id) === lv);
      if (fs.length) out.push(`${++n}. ${SEV_TEXT[s]}・${LEVEL_TEXT[lv]}（${plural(fs.length)}）：${idCounts(fs)}`);
    }));
    if (!n) out.push('沒有待處理的檢查結果。');
    return out.join('\n').replace(/\n+$/, '') + '\n';
  }

  S.report = Object.freeze({
    managerSummary, SUMMARY_LIMIT, EXPOSURE_LIMIT,
    findingsCsv, ledgerOfItems, userAt, findingsMarkdown, csvCell, mdText, mdCode,
    codeParts, advice, sortByDevice, majorityDeviating, statusText,
    SEV_TEXT, SEV_ORDER, STATUS_TEXT, DEVIATION, DEVIATION_LABEL, NO_MAJORITY,
  });
})(globalThis.SSOT = globalThis.SSOT || {});
