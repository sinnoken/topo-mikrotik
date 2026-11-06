/*
 * Reader：files-v1（一個檔案一台設備）
 * 檔名（去副檔名）即設備名；內容可含多個指令，以指令標記分隔（見 readers/common.js）。
 * 只有註解（沒有指令標記、內容或收集失敗）的檔案沒有設備資料，區塊的 device 為 null。
 */
(function (S) {
  'use strict';
  S.readers['files-v1'] = {
    id: 'files-v1',
    label: '單一設備檔案（檔名＝設備名）',
    accepts: (text, file) => !!file && file !== S.readers.PASTE,
    read(text, file) {
      const out = [];
      const device = String(file).replace(/^.*[\\/]/, '').replace(/\.(txt|log|cfg|conf|out)$/i, '');
      S.readers._common.splitByCommand({
        device, mgmtIp: null, lines: text.split(/\r?\n/), file, firstLine: 1, push: (b) => out.push(b),
      });
      // 設備名只來自檔名：整個檔案沒有指令標記、沒有內容也沒有收集失敗（例如只有位置不對的 collected-at）時，
      // 沒有任何這台設備的資料，不以檔名建立設備；註解問題仍留在區塊的 issues，由 I01 指出
      const hasData = (b) => b.command || b.failure || b.lines.some((l) => l.trim());
      if (!out.some(hasData)) out.forEach((b) => { b.device = null; });
      return out;
    },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
