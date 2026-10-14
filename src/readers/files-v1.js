/*
 * Reader：files-v1（一個檔案一台設備）
 * 檔名（去副檔名）即設備名；內容可含多個指令，以指令標記分隔（見 readers/common.js）。
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
      return out;
    },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
