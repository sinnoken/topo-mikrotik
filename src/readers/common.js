/*
 * Reader 共用：把一段「同一台設備」的文字依指令標記切成多個 Block。
 * 指令標記（任一即可）：
 *   ### /ip neighbor print detail without-paging       ← 建議寫法，最明確
 *   [admin@TPE_SW_01] > /ip neighbor print detail      ← RouterOS 提示字元（須是絕對路徑，以 / 開頭）
 * 沒有標記的段落 command 為 null，交由 adapter.detect() 依內容判斷。
 * 以單一 # 開頭的行是註解（### 才是指令標記）；RouterOS export 的抬頭行「# 日期 時間 by RouterOS 版本」除外。
 * SSH 收集器（tools/collect.sh）另外寫三種註解，讀進區塊但不交給 adapter：
 *   # collected-at: 2026-10-24T03:00:00Z   ← 緊接在指令標記之後；UTC ISO 8601、秒精度 → block.collectedAt
 *   # terminal-width: 511                  ← 緊接在 collected-at（或指令標記）之後；正整數，終端寬度 W，一行最多 W-1 字 → block.terminalWidth
 *   # collection failed: <原因>            ← 指令輸出之後（timeout、exit code N）；設備標頭後、任何指令之前為 connection → block.failure
 * 格式不對或位置不對的這些註解不靜默略過，記在 block.issues，由檢查列為 I01。
 * 每個區塊另有 block.wrap：折行判斷用的寬度（見 wrapOf；推論，只用於判斷，不寫進 Snapshot）。
 */
(function (S) {
  'use strict';
  const EXPORT_HEADER = /^\s*#\s*\S+\s+\d{2}:\d{2}:\d{2}\s+by RouterOS\b/i;
  const COLLECTED_AT = /^\s*#\s*collected-at:\s*(.*?)\s*$/i;
  const FAILED = /^\s*#\s*collection failed:\s*(.*?)\s*$/i;
  const TERMINAL_WIDTH = /^\s*#\s*terminal-width:\s*(.*?)\s*$/i;
  const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  /** 只接受真實存在的 UTC 時間（2026-02-30T… 不算）；只做格式驗證，不取目前時間。 */
  function validUtc(s) {
    if (!ISO_UTC.test(s)) return false;
    const t = Date.parse(s);
    return Number.isFinite(t) && new Date(t).toISOString() === s.replace('Z', '.000Z');
  }
  /** 收集失敗原因：timeout／exit code N／connection 之外的文字保留原文，reason 為 other。 */
  function parseFailure(text, line) {
    const exit = /^exit code (\d+)$/i.exec(text);
    const reason = exit ? 'exit-code' : /^(timeout|connection)$/i.test(text) ? text.toLowerCase() : 'other';
    return { reason, exitCode: exit ? +exit[1] : null, text, line };
  }
  const MARKERS = [
    /^\s*###\s*(\S.*?)\s*$/,
    /^\s*\[[^\]\s@]+@[^\]]+\]\s*>\s*(\S.*?)\s*$/,
    // 官方手冊常見「[admin@MikroTik] /interface/bridge/monitor bridge1」（省略 >）；只接受絕對路徑，子選單裡的相對寫法（/ip> print）不算
    /^\s*\[[^\]\s@]+@[^\]]+\]\s+(\/[^\s>]+(?:\s.*?)?)\s*$/,
  ];

  /** RouterOS 7 的斜線路徑（/interface/bridge/host/print）視同空白分隔（/interface bridge host print）。 */
  const normalizePath = (cmd) => cmd.replace(/^\/[\w\-/]+/, (p) => '/' + p.slice(1).split('/').filter(Boolean).join(' '));
  function markerOf(line) {
    for (const re of MARKERS) { const m = re.exec(line); if (m) return normalizePath(m[1]); }
    return null;
  }

  /*
   * 折行判斷用的寬度（block.wrap = { limit, basis } 或 null）：limit 是「一行最多幾字」（W-1）。
   * RouterOS 依終端寬度折行；手冊沒有折行規則（只說明登入名稱加 +<N>w 可設定寬度：
   * https://manual.mikrotik.com/docs/management-tools/console.md），以下依實機輸出推論
   * （tests/fixtures/real/ 的 7.24.4-RB5009UG+S+.txt、7.25.1-RB3011UiAS.txt、7.25.1-hAPax2.txt、7.25.1-neighbor-wrap.txt、7.x-defconf-fwstats.txt）：
   *  - 依寬度折行、每行最多 W-1 字的：print … detail 的每一行（80 欄時最長 79 字、硬切的註解剛好 79 字），
   *    以及 print stats 表格的 `;;;` 註解行（硬切）。表格的資料列與表頭不折行，不算。
   *  - 例外：一列有兩個註解時，第二個 `;;;` 接在前一個註解的續行之後，那一行可以超過寬度（RB3011 第 12 列有 86 字），
   *    所以帶 `;;;` 的行只算「序號（旗標）;;;」開頭、上一行不是註解的那種。
   *  - monitor 是多欄輸出（RB3011 的 bridge port monitor 有 88 字），export 以反斜線續行，key: value 的 print 欄位不折：都不算。
   *  - 非 ASCII 的行不算：無法確定 RouterOS 以位元組、字數或顯示寬度計算。
   * 依據的順序：
   *  1. 區塊有 `# terminal-width: W` → limit = W-1（basis 'recorded'）。這個區塊有一行（上面算的那些行）超過 W-1 時，記錄與輸出不符：
   *     列為 terminal-width-exceeded（I01），這個區塊不用寬度判斷（null，回到不看寬度的規則）。
   *  2. 沒有記錄（舊收集檔）→ 同一段（同一個設備標頭或檔案，也就是同一次連線）上面算的那些行中，最長一行的長度 L 是 W-1 的下界；
   *     最長的行之中有被硬切的註解（`;;;` 行的下一行是沒有 `;;;`、不是列首、也不是 key= 的續行）時，L 就是 W-1（basis 'inferred'）。
   *  3. 只有下界、沒有硬切的證據 → null（不用寬度判斷）。數學上下界也可以用（真正的折行超過 W-1 也就超過 L），
   *     但前提是每行長度都是 RouterOS 輸出的原樣：去識別化（tools/anonymize.js 把名稱、註解換成代號、位址換成不同長度）
   *     與手動整理的檔案保留換行位置、行長卻變了，以下界判斷會拒絕真正的折行（真實收集檔去識別化後多出 54 行 I03）。
   *     硬切的註解剛好是最長的行，表示行長是原樣（去識別化會把註解換成短代號，這個證據就不在了）。
   * 推論的寬度只用來決定要不要把下一行接回（adapters/mikrotik.js），不改寫事實、不寫進 Snapshot。
   */
  const PLAIN = /^[\x20-\x7e]*$/;
  const FOLDS = /\bprint\b(?!.*\bstats\b).*\bdetail\b/i;
  const STATS = /\bprint\b.*\bstats\b/i;
  const ROW_NOTE = /^\s*\d+(?:\s+[A-Za-z*+]+)?\s+$/;
  /** 區塊中依寬度折行的行：[{ i, len, cut（被硬切的註解）}] */
  function widthLines(b) {
    const cmd = b.command || ''; const out = [];
    const folds = FOLDS.test(cmd); const stats = !folds && STATS.test(cmd);
    if (!folds && !stats) return out;
    b.lines.forEach((l, i) => {
      if (!l.trim() || !PLAIN.test(l)) return;
      const ci = l.indexOf(';;;');
      if (stats ? ci < 0 || l.slice(0, ci).trim() : ci >= 0 && (!ROW_NOTE.test(l.slice(0, ci)) || (b.lines[i - 1] || '').includes(';;;'))) return;
      const next = b.lines[i + 1] || '';
      const cut = ci >= 0 && !!next.trim() && !/^\s*(?:\d|;;;)/.test(next) && !/^[\w.\-]+=/.test(next.trim());
      out.push({ i, len: l.length, cut });
    });
    return out;
  }
  /** 同一段的區塊（同一次連線）：設定每個區塊的 wrap；記錄與輸出不符時加 issue */
  function wrapOf(entries) {
    const lines = entries.map((e) => widthLines(e.b));
    const all = [].concat(...lines);
    const longest = all.length ? Math.max(...all.map((x) => x.len)) : null;
    const inferred = all.some((x) => x.cut && x.len === longest) ? { limit: longest, basis: 'inferred' } : null;
    entries.forEach(({ b, widthLine }, k) => {
      if (typeof b.terminalWidth !== 'number') { b.wrap = inferred; return; }
      const limit = b.terminalWidth - 1;
      const over = lines[k].find((x) => x.len > limit);
      if (!over) { b.wrap = { limit, basis: 'recorded' }; return; }
      b.wrap = null;
      (b.issues = b.issues || []).push({ kind: 'terminal-width-exceeded', line: widthLine, text: String(b.terminalWidth), at: b.origin.startLine + over.i, len: over.len });
    });
  }

  /**
   * @param {object} p { device, mgmtIp, lines: string[], file, firstLine (1-based), push(block) }
   */
  function splitByCommand(p) {
    let cur = null; const entries = [];
    const flush = () => {
      if (!cur) return;
      const text = cur.lines.join('\n');
      // 只有收集器註解的段落（例如連線失敗）也要保留，否則這台設備會整個消失
      if (text.trim() || cur.command || cur.failure || cur.issues.length) {
        const b = {
          device: p.device, mgmtIp: p.mgmtIp || null, command: cur.command,
          lines: cur.lines, origin: { file: p.file, startLine: cur.start, endLine: cur.start + cur.lines.length - 1 },
        };
        // 只有出現收集器註解時才加欄位，舊格式的區塊內容完全不變
        if (cur.collectedAt !== undefined) b.collectedAt = cur.collectedAt;
        if (cur.terminalWidth !== undefined) b.terminalWidth = cur.terminalWidth;
        if (cur.failure) b.failure = cur.failure;
        if (cur.issues.length) b.issues = cur.issues;
        if (cur.notes.size) b.notes = cur.notes;
        entries.push({ b, widthLine: cur.widthLine });
      }
      cur = null;
    };
    const open = (command, start) => ({ command, lines: [], start, collectedAt: undefined, terminalWidth: undefined, widthLine: null, failure: null, issues: [], notes: new Map() });
    p.lines.forEach((line, i) => {
      const lineNo = p.firstLine + i;
      const at = COLLECTED_AT.exec(line); const tw = !at && TERMINAL_WIDTH.exec(line); const failed = !at && !tw && FAILED.exec(line);
      if (at || tw || failed) {
        if (!cur) cur = open(null, lineNo);
        cur.notes.set(lineNo, line.trim()); // 註解行在 lines 中是空白；證據顯示原文用
        if (at) {
          // 只認緊接在指令標記之後、該區塊的第一個 collected-at
          if (!cur.command || cur.lines.length || cur.collectedAt !== undefined) cur.issues.push({ kind: 'collected-at-misplaced', line: lineNo, text: at[1] });
          else if (validUtc(at[1])) cur.collectedAt = at[1];
          else { cur.collectedAt = null; cur.issues.push({ kind: 'collected-at-invalid', line: lineNo, text: at[1] }); }
        } else if (tw) {
          // 只認緊接在指令標記之後、或緊接在該區塊第一行的 collected-at 之後的第一個 terminal-width
          // （collectedAt 有值或為 null 都表示 collected-at 就在指令標記的下一行）
          const placed = cur.command && cur.terminalWidth === undefined && (!cur.lines.length || (cur.lines.length === 1 && cur.collectedAt !== undefined));
          if (!placed) cur.issues.push({ kind: 'terminal-width-misplaced', line: lineNo, text: tw[1] });
          else if (/^[1-9]\d*$/.test(tw[1]) && Number.isSafeInteger(+tw[1])) { cur.terminalWidth = +tw[1]; cur.widthLine = lineNo; }
          else { cur.terminalWidth = null; cur.issues.push({ kind: 'terminal-width-invalid', line: lineNo, text: tw[1] }); }
        } else if (cur.failure) cur.issues.push({ kind: 'failure-duplicate', line: lineNo, text: failed[1] });
        else cur.failure = parseFailure(failed[1], lineNo);
        cur.lines.push('');
        return;
      }
      // 以 # 開頭（非 ###）是註解，保留行號但不解析；例外是 RouterOS export 的抬頭「# 日期 時間 by RouterOS 版本」，它是設備輸出的一部分
      if (/^\s*#(?!##)/.test(line) && !EXPORT_HEADER.test(line)) line = '';
      const cmd = markerOf(line);
      if (cmd) { flush(); cur = open(cmd, lineNo + 1); return; }
      if (!cur) cur = open(null, lineNo);
      cur.lines.push(line);
    });
    flush();
    wrapOf(entries);
    entries.forEach((e) => p.push(e.b));
  }

  S.readers._common = { splitByCommand, markerOf, plain: (s) => PLAIN.test(s) };
})(globalThis.SSOT = globalThis.SSOT || {});
