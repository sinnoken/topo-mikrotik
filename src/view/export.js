/*
 * 匯出：基準 Snapshot（JSON）、檢查結果（CSV、Markdown）、預期資料（ssot-expected/1 JSON）。
 * 組字邏輯都是純函式（只讀傳入的 Snapshot，不改寫），下載只在本機以 Blob 產生，不經過網路。
 */
(function (S) {
  'use strict';
  const V = S.view;
  const SEV_ORDER = ['error', 'warn', 'info'];
  // 開頭是這些字元的儲存格會被試算表當成公式執行（CSV 公式注入），前面加 ' 讓它保持文字
  const FORMULA_START = /^[=+\-@\t\r]/;

  /** 檔名用的建立時間：ISO 時間去掉分隔符號與毫秒（20260101T000000Z），只留英數字 */
  const stamp = (snap) => String(snap.meta.createdAt || '')
    .replace(/\.\d+(?=Z$)/, '')
    .replace(/[^0-9A-Za-z]/g, '') || 'unknown';
  const baseName = (snap) => `${stamp(snap)}-${snap.meta.stats.devices}dev`;

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
   * opts.acked(f) → 已確認紀錄 { at } 或 null。確認是檢視狀態（不在 Snapshot 裡），由畫面傳入；沒傳時視為都未確認。
   */
  const ackOf = (opts) => (opts && opts.acked ? opts.acked : () => null);

  /**
   * 檢查結果 CSV：一筆 finding 一列；多個相關實體、多筆證據各自合在同一格，以「; 」分隔。
   * acknowledged 欄是確認時間（UTC ISO），未確認為空白。
   * 開頭加 UTF-8 BOM，Excel 才會以 UTF-8 讀取中文；換行用 CRLF。
   */
  function findingsCsv(snap, opts) {
    const acked = ackOf(opts);
    const head = ['severity', 'id', 'title', 'message', 'entities', 'evidence', 'acknowledged'];
    const rows = snap.findings.map((f) => [
      f.severity, f.id, f.title, f.message,
      f.entities.map(entityText).join('; '),
      f.evidence.map(evidenceText).join('; '),
      (acked(f) || {}).at || '',
    ]);
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

  /** 檢查結果 Markdown 報表：依嚴重度分組，組內依規則代碼分段，保留 Snapshot 的排列順序；已確認的項目加註確認時間 */
  function findingsMarkdown(snap, opts) {
    const acked = ackOf(opts);
    const m = snap.meta; const st = m.stats;
    const nAcked = snap.findings.filter((f) => acked(f)).length;
    const out = [
      '# 基準檢查報表', '',
      `- 建立時間：${m.createdAt}`,
      `- 版本：${m.version}（${m.schema}）`,
      `- 輸入指紋：${mdCode(m.inputHash)}`,
      `- 命名規則：${m.profile ? mdText(m.profile.id) : '未套用'}`,
      `- 設備：${st.devices}（已收集 ${st.collected}）`,
      `- 檢查結果：${SEV_ORDER.map((s) => `${V.SEV[s]} ${st.findings[s]}`).join('、')}`,
      `- 已確認：${nAcked}`,
    ];
    SEV_ORDER.forEach((sev) => {
      const list = snap.findings.filter((f) => f.severity === sev);
      if (out[out.length - 1] !== '') out.push('');
      out.push(`## ${V.SEV[sev]}（${list.length}）`, '');
      if (!list.length) { out.push('沒有。'); return; }
      const byId = new Map();
      list.forEach((f) => S.util.getOr(byId, f.id, () => []).push(f));
      byId.forEach((fs, id) => {
        out.push(`### ${id} ${mdText(fs[0].title)}（${fs.length}）`, '');
        fs.forEach((f) => {
          const ack = acked(f);
          out.push(`- ${ack ? `**已確認**（${ack.at}）` : ''}${mdText(f.message)}`);
          if (f.entities.length) out.push(`  - 相關實體：${f.entities.map((e) => mdCode(entityText(e))).join('、')}`);
          f.evidence.forEach((e) => out.push(`  - 證據：${mdText(e.file)} 第 ${e.line} 行：${mdCode(e.text)}`));
        });
        out.push('');
      });
    });
    return out.join('\n').replace(/\n+$/, '') + '\n';
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
    snapshotJson, findingsCsv, findingsMarkdown, csvCell, download,
    /** 匯出種類 → 檔名、內容與 MIME；畫面的按鈕都經過這裡 */
    KINDS: {
      snapshot: { name: (s) => `baseline-${baseName(s)}.json`, text: snapshotJson, type: 'application/json' },
      csv: { name: (s) => `findings-${baseName(s)}.csv`, text: findingsCsv, type: 'text/csv;charset=utf-8' },
      markdown: { name: (s) => `findings-${baseName(s)}.md`, text: findingsMarkdown, type: 'text/markdown;charset=utf-8' },
      // 預期資料（ssot-expected/1）由核心的 S.compare.expectedFrom 產生；opts.Q 是目前基準的查詢介面
      expected: {
        name: (s) => `expected-${baseName(s)}.json`,
        text: (s, opts) => JSON.stringify(S.compare.expectedFrom(opts.Q), null, 2) + '\n',
        type: 'application/json',
      },
    },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
