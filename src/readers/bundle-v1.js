/*
 * Reader：bundle-v1（沿用既有收集格式）
 *   設備名 (管理IP):
 *   <指令輸出…>
 *   _____                      ← 5 個以上底線，可省略（遇到下一個設備標頭也會切段）
 * 第一個設備標頭之前的非空內容會成為 device=null 的區塊（之後列為「無法辨識」）。
 */
(function (S) {
  'use strict';
  const HEADER = /^\s*([A-Za-z0-9][\w.\-:]*)\s*\((\d{1,3}(?:\.\d{1,3}){3})\)\s*:\s*$/;
  const SEP = /^\s*_{5,}\s*$/;

  S.readers['bundle-v1'] = {
    id: 'bundle-v1',
    label: '設備標頭格式（設備名 (IP): … _____）',
    /** 內容中有設備標頭即可使用。 */
    accepts: (text) => text.split(/\r?\n/, 4000).some((l) => HEADER.test(l)),
    read(text, file) {
      const out = [];
      const lines = text.split(/\r?\n/);
      let sec = null;
      const flush = () => {
        if (!sec) return;
        S.readers._common.splitByCommand({
          device: sec.device, mgmtIp: sec.mgmtIp, lines: sec.lines, file, firstLine: sec.first, push: (b) => out.push(b),
        });
        sec = null;
      };
      lines.forEach((line, i) => {
        const h = HEADER.exec(line);
        if (h) { flush(); sec = { device: h[1], mgmtIp: h[2], lines: [], first: i + 2 }; return; }
        if (SEP.test(line)) { flush(); return; }
        if (!sec) { if (/^\s*#(?!##)/.test(line) || !line.trim()) return; sec = { device: null, mgmtIp: null, lines: [], first: i + 1 }; }
        sec.lines.push(line);
      });
      flush();
      // 標頭前、或分隔線後到下一標頭前的空白段落不算
      return out.filter((b) => b.device !== null || b.lines.some((l) => l.trim()));
    },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
