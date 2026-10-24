/*
 * Adapter 登錄與辨識。
 * 每個 adapter：{ id, vendor, dataType, label, command: RegExp, detect(lines): bool, parse(block, emit, ignore) }
 *  - command：比對區塊標記的指令文字（有標記時優先使用）
 *  - detect ：區塊沒有標記、或標記對不上任何 adapter 時，依內容判斷
 *  - parse  ：只把文字轉成事實（fact），每筆事實帶 line（原始輸入的行號）；不做跨設備推論
 *             ignore(line, why)：這一行依該指令的格式本來就不產生事實（說明行、續行、停用項目…），why 是簡短原因
 * 已解析區塊中的每個非空行，不是產生事實的行（fact.line），就是 adapter 列為可忽略的行；兩者都不是即為「無法辨識的行」（I03）。
 * 所以 adapter 只宣告可忽略的行，沒處理到的行一定會被列出，不會被靜默略過。
 * RouterOS 的錯誤訊息（util.rosError）一律算無法辨識，即使 adapter 列為可忽略。
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

  // RouterOS 對不存在的選單、語法錯誤或執行失敗的回應（bad command name、syntax error、expected end of command、
  // no such item、failure: …）。出現在輸出中代表指令可能沒有完整執行。只比對行首，值或註解裡的同樣字眼不算。
  const ROS_ERROR = /^\s*(?:(?:error|failure):\s*\S|(?:bad command name|syntax error|expected end of command|expected command name|no such (?:item|command)|invalid (?:value|argument)|ambiguous (?:value|command)|input does not match|not enough permissions)\b)/i;

  /**
   * 以辨識出的 adapter 解析一個區塊（pipeline 與不變式測試共用）。
   * decorate(fact, adapter)：補上設備、區塊等共通欄位。
   * 回傳 { facts, usage: {adapterId: 事實數}, ignored: Map<行號, 原因>, unrecognized: 行號[]（遞增） }。
   * 多個 adapter 時，任一個產生事實或列為可忽略的行就算有處理。
   */
  S.adapters.parse = function (block, adapters, decorate) {
    const facts = []; const usage = {}; const ignored = new Map();
    adapters.forEach((a) => {
      const before = facts.length;
      a.parse(block, (f) => { if (decorate) decorate(f, a); facts.push(f); }, (line, why) => { if (!ignored.has(line)) ignored.set(line, why); });
      usage[a.id] = facts.length - before;
    });
    const used = new Set(facts.map((f) => f.line));
    const unrecognized = [];
    block.lines.forEach((l, i) => {
      const n = block.origin.startLine + i;
      if (!l.trim() || used.has(n)) return;
      if (ROS_ERROR.test(l)) ignored.delete(n);
      if (!ignored.has(n)) unrecognized.push(n);
    });
    return { facts, usage, ignored, unrecognized };
  };

  /** 共用小工具 */
  S.adapters.util = {
    /** 去掉引號 */
    unq: (s) => String(s == null ? '' : s).trim().replace(/^"(.*)"$/, '$1'),
    /** 是否為雜訊行（空行、分頁提示） */
    noise: (l) => !l.trim() || /^\s*-- \[Q quit|^\s*---\(more/i.test(l),
    /** 是否為 RouterOS 的錯誤訊息行 */
    rosError: (l) => ROS_ERROR.test(String(l == null ? '' : l)),
    IP: '(\\d{1,3}(?:\\.\\d{1,3}){3})',
    MAC17: '([0-9a-f]{2}(?::[0-9a-f]{2}){5})',
  };
})(globalThis.SSOT = globalThis.SSOT || {});
