/*
 * 檢查結果報表（S.report）：CSV 與 Markdown。畫面的匯出（src/view/export.js）與 CLI（tools/baseline.js）共用這裡的文字。
 * 下游模組：只透過查詢介面（Q＝S.query(snapshot)）與 S.query.rule／S.query.rules 讀基準與檢查目錄，不改寫；上游不呼叫這裡。
 * 處理紀錄是使用者的資料（不在 Snapshot 裡），由呼叫端以 opts.ledgerOf 傳入；狀態判斷用 S.ledger.isPending。
 * 主管摘要（managerSummary）另在呼叫時用 Q.exposureSummary（外部的結論句）與 S.remediate.levelOf（處理方式的等級），
 * 不另寫一份計數或等級規則（S.remediate 在報表之前載入）。
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
  /** 「問題集中在哪」最多列出的類別數（CATALOG 的 cat） */
  const SUMMARY_CATEGORIES = 3;
  /** 修正 patch 的等級（S.remediate.levelOf） */
  const levelOf = (id) => S.remediate.levelOf(id);
  /** 檢查的類別（CATALOG 的 cat） */
  const catOf = (f) => (S.query.rule(f.id) || {}).cat || '其他';
  /** 依 keyOf 計數，多的在前、同數時依第一次出現的順序：[[key, n]] */
  const countBy = (xs, keyOf) => {
    const m = new Map(); xs.forEach((x) => { const k = keyOf(x); m.set(k, (m.get(k) || 0) + 1); });
    return [...m].map(([k, n], i) => ({ k, n, i })).sort((a, b) => b.n - a.n || a.i - b.i).map((x) => [x.k, x.n]);
  };
  const endStop = (s) => (/[。！？]$/.test(s) ? s : s + '。');

  /**
   * 主管摘要（Markdown）：只看方向，一個畫面讀完；細節見檢查結果報表。純對應：只重述檢查結果與暴露清單的結論（推論），不另做判斷、不評分、不估工時。
   * 第一行是結論：錯誤與警告都是 0 時「沒有錯誤與警告」，否則「錯誤 M、警告 N（待處理 X）」；有上一輪時接錯誤＋警告筆數的增減（兩份基準的 meta.stats 相減）。
   * 從外部進得來的：Q.exposureSummary 的結論句（與畫面 L4 頁首同一句，推論）。
   * 錯誤或警告不為 0 時才接（每段一句）：問題集中在哪（待處理的錯誤＋警告依 CATALOG 的 cat 計數，每類寫該類最多的檢查的處理提示 hint）、
   * 需要決定的事（S.remediate.levelOf 為 choice 的待處理檢查：數量與最多的題目）、處理順序（依嚴重度，各段筆數與可直接產生修正指令的筆數）。
   * opts：
   *   ledgerOf(f)：同 findingsMarkdown；決定哪些是待處理（沒傳時全部是待處理）
   *   zones：Q.exposure 的參數（同 siteDocTables，例如 { profile }）；exposure：已算好的 Q.exposure 結果（畫面傳入，避免重算）
   *   previous：上一輪基準的查詢介面（S.query(snapshot)）
   */
  function managerSummary(Q, opts) {
    const o = opts || {}; const lgOf = ledgerOf(o);
    const m = Q.meta(); const fc = m.stats.findings;
    const pendingOf = (f) => { const lg = lgOf(f); return S.ledger.isPending(lg ? lg.status : null); };
    const pending = Q.findings().filter(pendingOf);
    const bad = fc.error + fc.warn;
    const pendingBad = pending.filter((f) => f.severity === 'error' || f.severity === 'warn');
    let head = bad ? `錯誤 ${fc.error}、警告 ${fc.warn}（待處理 ${pendingBad.length}）` : '沒有錯誤與警告';
    if (o.previous) {
      const pf = o.previous.meta().stats.findings; const d = bad - (pf.error + pf.warn);
      head += d ? `，比上一輪${d < 0 ? '少' : '多'} ${Math.abs(d)} 筆` : '，與上一輪筆數相同';
    }
    const ex = Q.exposureSummary(o.zones, o.exposure);
    const out = ['# 主管摘要', '', `**${head}。**`, '', `- 從外部進得來的（推論）：${mdText(endStop(ex.sentence))}`];
    if (bad) {
      // 問題集中在哪：待處理的錯誤＋警告依類別
      if (!pendingBad.length) out.push('- 錯誤與警告都已處理（見處理紀錄）。');
      else {
        const cats = countBy(pendingBad, catOf); const top = cats.slice(0, SUMMARY_CATEGORIES); const rest = cats.slice(SUMMARY_CATEGORIES);
        out.push(`- 待處理的錯誤與警告集中在：${top.map(([c, n]) => `${mdText(c)} ${n} 筆`).join('、')}` +
          `${rest.length ? `，其他 ${rest.length} 類共 ${rest.reduce((s, [, n]) => s + n, 0)} 筆` : ''}。`);
        top.forEach(([c]) => {
          const [id] = countBy(pendingBad.filter((f) => catOf(f) === c), (f) => f.id)[0];
          const a = advice(id);
          out.push(`  - ${mdText(c)}（最多的是 ${id}）：${a.hint ? mdRich(a.hint) : mdText(S.query.rule(id).title)}`);
        });
      }
      // 需要決定的事：要先選擇處理方式的待處理檢查
      const choice = pending.filter((f) => levelOf(f.id) === 'choice');
      out.push(choice.length ? `- 需要決定的事：${choice.length} 項要先選擇處理方式，例如${mdText(S.query.rule(countBy(choice, (f) => f.id)[0][0]).title)}。` : '- 需要決定的事：沒有。');
      // 處理順序：依嚴重度
      const steps = SEV_ORDER.map((s) => {
        const fs = pending.filter((f) => f.severity === s); if (!fs.length) return null;
        const auto = fs.filter((f) => levelOf(f.id) === 'auto').length;
        return `${SEV_TEXT[s]} ${fs.length} 筆（${auto ? `${auto} 筆可直接產生修正指令` : '沒有可直接產生的修正指令'}）`;
      }).filter(Boolean);
      if (steps.length) out.push(`- 處理順序：先${steps.join('，再')}。`);
    }
    out.push('', `依據 ${m.createdAt} 建立的基準（設備 ${m.stats.devices} 台，已收集 ${m.stats.collected} 台）；標「推論」的部分由路由與防火牆規則推得，不是收集到的事實。細節見檢查結果報表。`);
    return out.join('\n') + '\n';
  }

  S.report = Object.freeze({
    managerSummary, SUMMARY_CATEGORIES,
    findingsCsv, ledgerOfItems, userAt, findingsMarkdown, csvCell, mdText, mdCode,
    codeParts, advice, sortByDevice, majorityDeviating, statusText,
    SEV_TEXT, SEV_ORDER, STATUS_TEXT, DEVIATION, DEVIATION_LABEL, NO_MAJORITY,
  });
})(globalThis.SSOT = globalThis.SSOT || {});
