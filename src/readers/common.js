/*
 * Reader 共用：把一段「同一台設備」的文字依指令標記切成多個 Block。
 * 指令標記（任一即可）：
 *   ### /ip neighbor print detail without-paging       ← 建議寫法，最明確
 *   [admin@TPE_SW_01] > /ip neighbor print detail      ← RouterOS 提示字元（須是絕對路徑，以 / 開頭）
 * 沒有標記的段落 command 為 null，交由 adapter.detect() 依內容判斷。
 * 以單一 # 開頭的行是註解（### 才是指令標記）；RouterOS export 的抬頭行「# 日期 時間 by RouterOS 版本」除外。
 */
(function (S) {
  'use strict';
  const EXPORT_HEADER = /^\s*#\s*\S+\s+\d{2}:\d{2}:\d{2}\s+by RouterOS\b/i;
  const MARKERS = [
    /^\s*###\s*(\S.*?)\s*$/,
    /^\s*\[[^\]\s@]+@[^\]]+\]\s*>\s*(\S.*?)\s*$/,
  ];

  function markerOf(line) {
    for (const re of MARKERS) { const m = re.exec(line); if (m) return m[1]; }
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
      if (text.trim() || cur.command) {
        p.push({
          device: p.device, mgmtIp: p.mgmtIp || null, command: cur.command,
          lines: cur.lines, origin: { file: p.file, startLine: cur.start, endLine: cur.start + cur.lines.length - 1 },
        });
      }
      cur = null;
    };
    p.lines.forEach((line, i) => {
      const lineNo = p.firstLine + i;
      // 以 # 開頭（非 ###）是註解，保留行號但不解析；例外是 RouterOS export 的抬頭「# 日期 時間 by RouterOS 版本」，它是設備輸出的一部分
      if (/^\s*#(?!##)/.test(line) && !EXPORT_HEADER.test(line)) line = '';
      const cmd = markerOf(line);
      if (cmd) { flush(); cur = { command: cmd, lines: [], start: lineNo + 1 }; return; }
      if (!cur) cur = { command: null, lines: [], start: lineNo };
      cur.lines.push(line);
    });
    flush();
  }

  S.readers._common = { splitByCommand, markerOf };
})(globalThis.SSOT = globalThis.SSOT || {});
