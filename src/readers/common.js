/*
 * Reader 共用：把一段「同一台設備」的文字依指令標記切成多個 Block。
 * 指令標記（任一即可）：
 *   ### /ip neighbor print detail without-paging       ← 建議寫法，最明確
 *   [admin@TPE_SW_01] > /ip neighbor print detail      ← RouterOS 提示字元（須是絕對路徑，以 / 開頭）
 * 沒有標記的段落 command 為 null，交由 adapter.detect() 依內容判斷。
 * 以單一 # 開頭的行是註解（### 才是指令標記）；RouterOS export 的抬頭行「# 日期 時間 by RouterOS 版本」除外。
 * SSH 收集器（tools/collect.sh）另外寫兩種註解，讀進區塊但不交給 adapter：
 *   # collected-at: 2026-10-24T03:00:00Z   ← 緊接在指令標記之後；UTC ISO 8601、秒精度 → block.collectedAt
 *   # collection failed: <原因>            ← 指令輸出之後（timeout、exit code N）；設備標頭後、任何指令之前為 connection → block.failure
 * 格式不對或位置不對的這兩種註解不靜默略過，記在 block.issues，由檢查列為 I01。
 */
(function (S) {
  'use strict';
  const EXPORT_HEADER = /^\s*#\s*\S+\s+\d{2}:\d{2}:\d{2}\s+by RouterOS\b/i;
  const COLLECTED_AT = /^\s*#\s*collected-at:\s*(.*?)\s*$/i;
  const FAILED = /^\s*#\s*collection failed:\s*(.*?)\s*$/i;
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

  /**
   * @param {object} p { device, mgmtIp, lines: string[], file, firstLine (1-based), push(block) }
   */
  function splitByCommand(p) {
    let cur = null;
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
        if (cur.failure) b.failure = cur.failure;
        if (cur.issues.length) b.issues = cur.issues;
        if (cur.notes.size) b.notes = cur.notes;
        p.push(b);
      }
      cur = null;
    };
    const open = (command, start) => ({ command, lines: [], start, collectedAt: undefined, failure: null, issues: [], notes: new Map() });
    p.lines.forEach((line, i) => {
      const lineNo = p.firstLine + i;
      const at = COLLECTED_AT.exec(line); const failed = !at && FAILED.exec(line);
      if (at || failed) {
        if (!cur) cur = open(null, lineNo);
        cur.notes.set(lineNo, line.trim()); // 註解行在 lines 中是空白；證據顯示原文用
        if (at) {
          // 只認緊接在指令標記之後、該區塊的第一個 collected-at
          if (!cur.command || cur.lines.length || cur.collectedAt !== undefined) cur.issues.push({ kind: 'collected-at-misplaced', line: lineNo, text: at[1] });
          else if (validUtc(at[1])) cur.collectedAt = at[1];
          else { cur.collectedAt = null; cur.issues.push({ kind: 'collected-at-invalid', line: lineNo, text: at[1] }); }
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
  }

  S.readers._common = { splitByCommand, markerOf };
})(globalThis.SSOT = globalThis.SSOT || {});
