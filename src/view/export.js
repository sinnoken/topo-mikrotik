/*
 * 匯出：基準 Snapshot（JSON）、檢查結果（CSV、Markdown）、預期資料（ssot-expected/1 JSON）、未收集設備的 devices.csv 草稿、
 * 修正計畫的總表（Markdown）。
 * 組字邏輯都是純函式，透過傳入的查詢介面（Q）讀取基準、不改寫；只有基準 JSON 需要整份 Snapshot（原樣序列化）。
 * 下載只在本機以 Blob 產生，不經過網路。
 */
(function (S) {
  'use strict';
  const V = S.view;

  /** 檔名用的建立時間：ISO 時間去掉分隔符號與毫秒（20260101T000000Z），只留英數字 */
  const stamp = (Q) => String(Q.meta().createdAt || '')
    .replace(/\.\d+(?=Z$)/, '')
    .replace(/[^0-9A-Za-z]/g, '') || 'unknown';
  const baseName = (Q) => `${stamp(Q)}-${Q.meta().stats.devices}dev`;

  /** 基準 JSON：原樣序列化，不增刪欄位 */
  function snapshotJson(snap) { return JSON.stringify(snap, null, 2); }

  /**
   * 檢查結果的 CSV 與 Markdown 報表由核心的 S.report 產生（CLI 的 tools/baseline.js 用同一份）：欄位、跳脫與排序的說明見 src/report/report.js。
   * opts.ledgerOf(f) → 處理紀錄或 null（處理紀錄是使用者的資料，由畫面傳入）；opts.byDevice 為 true 時依設備排序／分組。
   */
  const csvCell = (value) => S.report.csvCell(value);
  const findingsCsv = (Q, opts) => S.report.findingsCsv(Q, opts);
  const findingsMarkdown = (Q, opts) => S.report.findingsMarkdown(Q, opts);
  const mdText = (s) => S.report.mdText(s);
  const mdCode = (s) => S.report.mdCode(s);
  const R = () => V.remediation;

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
