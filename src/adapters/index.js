/*
 * Adapter 登錄與辨識。
 * 每個 adapter：{ id, vendor, dataType, label, command: RegExp, detect(lines): bool, parse(block, emit) }
 *  - command：比對區塊標記的指令文字（有標記時優先使用）
 *  - detect ：區塊沒有標記、或標記對不上任何 adapter 時，依內容判斷
 *  - parse  ：只把文字轉成事實（fact），每筆事實帶 line（原始輸入的行號）；不做跨設備推論
 * 新增廠牌：新增一支 adapters/<vendor>-<what>.js 並呼叫 S.adapters.register()，核心其他部分不需修改。
 */
(function (S) {
  'use strict';
  const list = [];
  S.adapters.list = list;
  S.adapters.register = (a) => { list.push(a); S.adapters[a.id] = a; };

  /** 回傳此區塊適用的 adapter 陣列（可能 0 個 → 無法辨識）。 */
  S.adapters.recognize = function (block) {
    if (block.device === null) return { adapters: [], how: 'no-device' };
    if (block.command) {
      const byCmd = list.filter((a) => a.command.test(block.command));
      if (byCmd.length) return { adapters: byCmd, how: 'command' };
    }
    const byContent = list.filter((a) => a.detect(block.lines));
    return { adapters: byContent, how: byContent.length ? 'content' : 'none' };
  };

  /** 共用小工具 */
  S.adapters.util = {
    /** 去掉引號 */
    unq: (s) => String(s == null ? '' : s).trim().replace(/^"(.*)"$/, '$1'),
    /** 是否為雜訊行（空行、分頁提示） */
    noise: (l) => !l.trim() || /^\s*-- \[Q quit|^\s*---\(more/i.test(l),
    IP: '(\\d{1,3}(?:\\.\\d{1,3}){3})',
    MAC17: '([0-9a-f]{2}(?::[0-9a-f]{2}){5})',
  };
})(globalThis.SSOT = globalThis.SSOT || {});
