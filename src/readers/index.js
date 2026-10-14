/*
 * Reader 登錄與選擇。新增輸入格式：在 S.readers 加一個 {id,label,accepts,read}，並放進 ORDER。
 * 選擇順序：bundle-v1（內容有設備標頭）→ files-v1（以檔名當設備名）。
 */
(function (S) {
  'use strict';
  S.readers.PASTE = '(貼上的內容)';
  const ORDER = ['bundle-v1', 'files-v1'];

  /**
   * @param {{name:string,text:string}[]} sources
   * @returns {{blocks:object[], readersUsed:object}}
   */
  S.readers.readAll = function (sources) {
    const blocks = [];
    const readersUsed = {};
    sources.forEach((src) => {
      const name = src.name || S.readers.PASTE;
      const id = ORDER.find((rid) => S.readers[rid].accepts(src.text, name));
      if (!id) {
        blocks.push({ device: null, mgmtIp: null, command: null, lines: src.text.split(/\r?\n/),
          origin: { file: name, startLine: 1, endLine: src.text.split(/\r?\n/).length }, reader: null });
        return;
      }
      readersUsed[name] = id;
      S.readers[id].read(src.text, name).forEach((b) => { b.reader = id; blocks.push(b); });
    });
    blocks.forEach((b, i) => { b.id = i; });
    return { blocks, readersUsed };
  };
})(globalThis.SSOT = globalThis.SSOT || {});
