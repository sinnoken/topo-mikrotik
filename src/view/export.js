/*
 * 匯出：基準 Snapshot（JSON）、檢查結果（CSV、Markdown）、預期資料（ssot-expected/1 JSON）、未收集設備的 devices.csv 草稿、
 * 修正計畫的總表（Markdown）。
 * 組字邏輯都是純函式，透過傳入的查詢介面（Q）讀取基準、不改寫；只有基準 JSON 需要整份 Snapshot（原樣序列化）。
 * 下載只在本機以 Blob 產生，不經過網路。
 */
(function (S) {
  'use strict';
  const V = S.view;
  const SEV_ORDER = ['error', 'warn', 'info'];
  // 開頭是這些字元的儲存格會被試算表當成公式執行（CSV 公式注入），前面加 ' 讓它保持文字
  const FORMULA_START = /^[=+\-@\t\r]/;

  /** 檔名用的建立時間：ISO 時間去掉分隔符號與毫秒（20260101T000000Z），只留英數字 */
  const stamp = (Q) => String(Q.meta().createdAt || '')
    .replace(/\.\d+(?=Z$)/, '')
    .replace(/[^0-9A-Za-z]/g, '') || 'unknown';
  const baseName = (Q) => `${stamp(Q)}-${Q.meta().stats.devices}dev`;

  const entityText = (e) => `${e.type}:${e.key}`;
  const evidenceText = (e) => `${e.file}:${e.line}`;

  /** 基準 JSON：原樣序列化，不增刪欄位 */
  function snapshotJson(snap) { return JSON.stringify(snap, null, 2); }

  /** 單一 CSV 儲存格：含逗號、引號、換行或前後空白時加引號，引號重複一次（RFC 4180） */
  function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    if (FORMULA_START.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * opts.ledgerOf(f) → 處理紀錄 { status, at, note, waiver } 或 null（at 是使用者最後一次變更的時間，沒有時為 null）。
   * 處理紀錄是使用者的資料（不在 Snapshot 裡），由畫面傳入；沒傳時視為都不在處理紀錄中（待處理）。
   * Q：目前基準的查詢介面（檢查結果、meta 與所屬設備 Q.findingDevice 都由它讀取）；opts.byDevice 為 true 時依設備排序。
   */
  const ledgerOf = (opts) => (opts && opts.ledgerOf ? opts.ledgerOf : () => null);
  const R = () => V.remediation;
  /** 已處理（不是待處理）時的處理紀錄，否則 null：舊欄位 acknowledged／ack_kind／ack_note 與 Markdown 的已處理標示用 */
  const handledOf = (lg) => (lg && !R().isPendingStatus(lg.status) ? lg : null);
  /** 匯出的順序：預設保留 Snapshot 的順序；依設備時用 V.remediation.sortByDevice（與畫面分組同一個判斷） */
  const ordered = (Q, opts) => (opts && opts.byDevice
    ? R().sortByDevice(Q, Q.findings())
    : Q.findings().map((f, idx) => ({ f, idx, dev: Q.findingDevice(f) })));

  /**
   * 檢查結果 CSV：一筆 finding 一列；多個相關實體、多筆證據各自合在同一格，以「; 」分隔。
   * 處理紀錄的欄位（舊的確認標記改由處理紀錄對應，欄名與位置不變，供舊的試算表沿用）：
   *   acknowledged：已處理（狀態不是 open／regressed）時，使用者最後一次變更的時間（UTC ISO）；待處理時空白
   *   ack_kind    ：已處理時的狀態（scheduled／accepted／false-positive／fixed）；待處理時空白
   *   ack_note    ：已處理時的備註；待處理時空白
   *   status      ：處理紀錄的狀態（open／scheduled／accepted／false-positive／fixed／regressed）；不在處理紀錄中時空白
   *   note        ：備註（不論狀態）；waiver_reason／waiver_until：可接受的豁免原因與到期日（UTC ISO）
   * device 是所屬設備鍵（Q.findingDevice；不屬於任何設備為空白）。
   * action 是規則的處理建議（CATALOG，V.remediation.advice），原文照錄（反引號保留）；規則沒有處理建議時為空白。
   * facet 是檢查項目（finding.facet 原值，例如 A12 的 dns／ntp，會進入 findingKey）；規則沒有 facet 時空白。
   *   放原值而不是畫面的顯示文字：給試算表篩選與對照 findingKey 用，訊息本身已經寫出項目。
   * 常見原因不放進 CSV：每列都會重複同一段多句文字，合在一格也不好篩選；Markdown 報表與畫面上有。
   * 新欄位一律加在最後，既有欄位的位置不變。
   * 開頭加 UTF-8 BOM，Excel 才會以 UTF-8 讀取中文；換行用 CRLF。
   */
  function findingsCsv(Q, opts) {
    const lgOf = ledgerOf(opts);
    const head = ['severity', 'id', 'title', 'message', 'entities', 'evidence', 'acknowledged', 'ack_kind', 'ack_note', 'device', 'action',
      'status', 'note', 'waiver_reason', 'waiver_until', 'facet'];
    const rows = ordered(Q, opts).map(({ f, dev }) => {
      const lg = lgOf(f); const done = handledOf(lg) || {}; const w = (lg && lg.waiver) || {};
      return [
        f.severity, f.id, f.title, f.message,
        f.entities.map(entityText).join('; '),
        f.evidence.map(evidenceText).join('; '),
        done.at || '', done.status || '', done.note || '', dev || '',
        R().advice(f.id).action || '',
        lg ? lg.status : '', lg ? lg.note || '' : '', w.reason || '', w.until || '',
        f.facet != null ? String(f.facet) : '',
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

  /** CATALOG 文字：反引號內的指令與欄位轉成行內程式碼（V.codeParts，與畫面同一個切法），其餘照 mdText 跳脫 */
  const mdRich = (s) => V.codeParts(s).map((p) => (p.code ? mdCode(p.text) : mdText(p.text))).join('');
  /** 規則的處理建議與常見原因（V.remediation.advice，文字來自 CATALOG）：欄位不存在時不輸出 */
  const catalogLines = (id) => {
    const a = R().advice(id); const out = [];
    if (a.action) out.push(`- 處理建議：${mdRich(a.action)}`);
    if (a.causes.length) out.push('- 常見原因：', ...a.causes.map((c) => `  - ${mdRich(c)}`));
    return out.length ? out.concat('') : out;
  };

  /**
   * 檢查結果 Markdown 報表。已處理的項目加註狀態與時間，豁免與備註另起一行；回歸的項目標示「回歸」。
   *   預設：依嚴重度分組，組內依規則代碼分段，保留 Snapshot 的排列順序。
   *   opts.byDevice：依設備分組（Q.findingDevice），不屬於任何設備的最後一組；組內保留原順序。
   *     同一條規則會出現在很多台設備，處理建議與常見原因只在報表最後的附錄列一次（依 CATALOG 的順序）。
   */
  function findingsMarkdown(Q, opts) {
    const lgOf = ledgerOf(opts);
    const m = Q.meta(); const st = m.stats; const all = Q.findings();
    const counts = {};
    all.forEach((f) => { const lg = lgOf(f); if (lg && lg.status !== 'open') counts[lg.status] = (counts[lg.status] || 0) + 1; });
    const statusLine = Object.keys(R().STATUS_TEXT).filter((s) => counts[s]).map((s) => `${R().statusText(s)} ${counts[s]}`)
      .concat(Object.keys(counts).filter((s) => !R().STATUS_TEXT[s]).map((s) => `${s} ${counts[s]}`)).join('、') || '沒有';
    const out = [
      '# 基準檢查報表', '',
      `- 建立時間：${m.createdAt}`,
      `- 版本：${m.version}（${m.schema}）`,
      `- 輸入指紋：${mdCode(m.inputHash)}`,
      `- 命名規則：${m.profile ? mdText(m.profile.id) : '未套用'}`,
      `- 設備：${st.devices}（已收集 ${st.collected}）`,
      `- 檢查結果：${SEV_ORDER.map((s) => `${V.SEV[s]} ${st.findings[s]}`).join('、')}`,
      `- 處理紀錄：${mdText(statusLine)}`,
    ];
    /** 一筆 finding：已處理時「**狀態**（時間）」、回歸時「**回歸**」；豁免與備註另起一行 */
    const item = (f, prefix) => {
      const lg = lgOf(f); const done = handledOf(lg);
      const mark = done ? `**${mdText(R().statusText(done.status))}**${done.at ? `（${done.at}）` : ''} ` : lg && lg.status === 'regressed' ? '**回歸** ' : '';
      out.push(`- ${mark}${prefix || ''}${mdText(f.message)}`);
      if (lg && lg.waiver) out.push(`  - 豁免：${mdText(lg.waiver.reason || '（未填原因）')}，到期 ${lg.waiver.until}`);
      if (lg && lg.note) out.push(`  - 備註：${mdText(lg.note)}`);
      if (f.entities.length) out.push(`  - 相關實體：${f.entities.map((e) => mdCode(entityText(e))).join('、')}`);
      f.evidence.forEach((e) => out.push(`  - 證據：${mdText(e.file)} 第 ${e.line} 行：${mdCode(e.text)}`));
    };
    if (opts && opts.byDevice) {
      const groups = new Map();
      R().sortByDevice(Q, all).forEach((r) => S.util.getOr(groups, r.dev, () => []).push(r.f));
      groups.forEach((fs, dev) => {
        if (out[out.length - 1] !== '') out.push('');
        out.push(`## ${dev === null ? '不屬於任何設備' : mdText(Q.devName(dev))}（${fs.length}）`, '');
        fs.forEach((f) => item(f, `${V.SEV[f.severity]} ${f.id} ${mdText(f.title)}：`));
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
      out.push(`## ${V.SEV[sev]}（${list.length}）`, '');
      if (!list.length) { out.push('沒有。'); return; }
      const byId = new Map();
      list.forEach((f) => S.util.getOr(byId, f.id, () => []).push(f));
      byId.forEach((fs, id) => {
        out.push(`### ${id} ${mdText(fs[0].title)}（${fs.length}）`, '');
        out.push(...catalogLines(id));
        fs.forEach((f) => item(f));
        out.push('');
      });
    });
    return out.join('\n').replace(/\n+$/, '') + '\n';
  }

  /**
   * 修正計畫的總表（Markdown）：多台設備逐檔下載時一起下載，列出每台設備的檔名、項目與風險、需要選擇的項目目前的選擇，以及沒有產生指令的項目與原因。
   * plan 是 S.remediate.plan 的結果，files 是 S.remediate.files(plan)（檔名用它的 base）；Q 用來顯示設備名稱。
   * 第二階段的變更說明文件由核心產生後，這份總表改由它取代。
   */
  function patchSummaryMarkdown(plan, files, Q) {
    const RM = R(); const b = plan.baseline;
    const risk = (l) => (l ? RM.RISK_TEXT[l] || l : '—');
    const name = (dev) => (dev ? mdText(Q.devName(dev)) : '不屬於任何設備');
    const out = [
      '# 修正計畫總表', '',
      '- 本工具只產生文字，不會連線或改動任何設備。請逐行審查，自行以 `/import` 套用；套用後重新收集、建立基準確認結果。',
      `- 基準：輸入指紋 ${mdCode(b.inputHash)}、建立時間 ${b.createdAt}、版本 ${b.version}`,
      `- 格式：${plan.schema}`,
      `- 設備 ${plan.devices.length} 台、修正 ${plan.items.length} 項、未產生指令 ${plan.skipped.length} 項`,
      '', '## 檔案', '',
    ];
    if (files.length) {
      out.push('| 設備 | 套用 | 回復 | 驗證 | 項目 | 最高風險 |', '|---|---|---|---|---|---|');
      files.forEach((x) => {
        const items = plan.items.filter((i) => i.dev === x.dev);
        out.push(`| ${mdText(x.name)} | ${mdCode(x.base + '.rsc')} | ${mdCode(x.base + '-rollback.rsc')} | ${mdCode(x.base + '-verify.rsc')} | ${items.length} | ${risk(RM.maxRisk(items))} |`);
      });
      out.push('', '執行順序：每台設備先套用 `.rsc`（前置檢查不通過時不會改到任何設定），再執行 `-verify.rsc` 確認；需要還原時執行 `-rollback.rsc`。');
    } else out.push('沒有可以產生指令的項目。');
    files.forEach((x) => {
      out.push('', `## ${mdText(x.name)}`, '');
      plan.items.filter((i) => i.dev === x.dev).forEach((it, n) => {
        out.push(`${n + 1}. ${it.id} ${mdText(RM.targetText(it.target))}（風險：${risk(it.risk.level)}）：${mdText(it.note)}`);
        out.push(`   - 風險說明：${mdText(it.risk.text)}`);
        it.warnings.forEach((w) => out.push(`   - 警告：${mdText(w)}`));
        it.evidence.forEach((e) => out.push(`   - 修改前：${mdText(e.file)} 第 ${e.line} 行：${mdCode(e.text)}`));
      });
    });
    // 需要選擇的項目（plan.choices）：每筆目前的選擇，與預設（多數決，推論）或使用者選擇
    if ((plan.choices || []).length) {
      out.push('', '## 需要選擇的項目', '');
      plan.choices.forEach((c) => out.push(`- ${c.id} ${mdText(c.title)}：${mdText(RM.choiceText(c).text)}`));
    }
    if (plan.skipped.length) {
      out.push('', '## 未產生指令的項目', '');
      plan.skipped.forEach((x) => out.push(`- ${x.id || '（基準中沒有）'} ${name(x.dev)}：${mdText(x.detail)}`));
    }
    return out.join('\n') + '\n';
  }

  /** 在本機下載文字檔：Blob → object URL → <a download>，點擊後下一輪釋放 URL */
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = V.h('a', { href: url, download: name, class: 'hidden' });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // click() 會同步開始下載，下一輪事件循環釋放即可
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  V.exporter = {
    snapshotJson, findingsCsv, findingsMarkdown, patchSummaryMarkdown, csvCell, download, baseName,
    /**
     * 匯出種類 → 檔名 name(Q)、內容 text(Q, opts) 與 MIME；畫面的按鈕都經過這裡。Q 是目前基準的查詢介面。
     * 基準 JSON 要原樣序列化整份 Snapshot，由 opts.snapshot 傳入（只序列化，不讀欄位）。
     */
    KINDS: {
      snapshot: { name: (Q) => `baseline-${baseName(Q)}.json`, text: (Q, opts) => snapshotJson(opts.snapshot), type: 'application/json' },
      csv: { name: (Q) => `findings-${baseName(Q)}.csv`, text: findingsCsv, type: 'text/csv;charset=utf-8' },
      markdown: { name: (Q) => `findings-${baseName(Q)}.md`, text: findingsMarkdown, type: 'text/markdown;charset=utf-8' },
      // 預期資料（ssot-expected/1）由核心的 S.compare.expectedFrom 產生
      expected: {
        name: (Q) => `expected-${baseName(Q)}.json`,
        text: (Q) => JSON.stringify(S.compare.expectedFrom(Q), null, 2) + '\n',
        type: 'application/json',
      },
      // tools/collect.sh 的設備清單草稿（C01）：不加 BOM、換行用 LF，collect.sh 以 bash read 逐行讀取
      devicesCsv: {
        name: (Q) => `devices-draft-${baseName(Q)}.csv`,
        text: (Q) => V.remediation.devicesCsvDraft(Q).text,
        type: 'text/csv;charset=utf-8',
      },
    },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
