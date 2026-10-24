#!/usr/bin/env node
'use strict';
/**
 * Claude Code PreToolUse hook（Bash／PowerShell）：在指令執行前擋下已知會出事的寫法。
 * 背景：2026-10-24 有 agent 執行 `find / … | head` 掃整台電腦、在背景跑了 9 小時；
 * 另一個用沒有結尾的 heredoc 加 `cat >` 改檔，卡在 stdin。規則同 .claude/agents/*.md 的「執行指令」。
 *
 * 輸入：stdin 的 hook JSON（tool_input.command）。輸出：擋下時回傳 permissionDecision: deny 與原因；
 * 放行時不輸出。讀不懂輸入時放行（hook 本身出錯不該擋住所有指令）。
 */

// 把引號內的長字串換成空字串，避免 commit 訊息、echo 的文字被當成指令（例如 -m "… find / …"）。
// 只有一個路徑、像 "/" 或 'C:\' 這種短的引號內容保留，才擋得到 find "/"。
const unquote = (c) => c.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (m) => (/^["'](\/|\/[A-Za-z]\/?|[A-Za-z]:[\\/]?)["']$/.test(m) ? m : '""'));

const RULES = [
  {
    id: 'find-root',
    // find 從根目錄或磁碟根開始：find /、find /c、find C:\、find "/" …
    test: (c) => /(^|[\s;&|(])find(\.exe)?\s+(-[HLP]\s+)*["']?(\/|\/[A-Za-z]\/?|[A-Za-z]:[\\/]?)["']?(\s|$)/.test(unquote(c)),
    reason: '不要從根目錄或磁碟根執行 find（會掃整台電腦，`| head` 也不會讓它提早結束）。' +
      '搜尋只限專案目錄、"$TEMP"/claude、~/.claude；專案內用 Grep／Glob 工具；找固定路徑用 ls -d 加萬用字元。',
  },
  {
    id: 'gci-root',
    // PowerShell：Get-ChildItem／gci／ls／dir 對磁碟根遞迴
    test: (c) => (c = unquote(c), /\b(Get-ChildItem|gci|ls|dir)\b[^|;\n]*["']?[A-Za-z]:\\?["']?(\s|$)[^|;\n]*-Recurse/i.test(c) ||
      /\b(Get-ChildItem|gci|ls|dir)\b[^|;\n]*-Recurse[^|;\n]*["']?[A-Za-z]:\\?["']?(\s|$)/i.test(c)),
    reason: '不要對整顆磁碟遞迴列檔。請限定目錄（專案、$env:TEMP\\claude、~\\.claude），或改用 Grep／Glob 工具。',
  },
  {
    id: 'heredoc-write',
    // heredoc 寫進檔案：cat > f <<EOF、cat <<EOF > f、tee f <<EOF（寫到 /dev/null 或 &N 不算）
    test: (c) => /<<-?\s*["']?\w+/.test(c) &&
      (/\b(cat|tee)\b/.test(c)) &&
      (/(^|[^0-9&>])>{1,2}\s*(?!\/dev\/null\b|&)[^\s|;&<>]+/.test(c) || /\btee\s+(-a\s+)?(?!\/dev\/null\b)[^\s|;&-][^\s|;&]*/.test(c)),
    reason: '不要用 heredoc 加 cat >／tee 改檔（少了結尾時會卡在 stdin）。請用 Edit／Write 工具。',
  },
  {
    id: 'node-eval-write',
    // node -e／--eval 在指令列裡寫檔
    test: (c) => /\bnode(\.exe)?\s+(-e|--eval|-p|--print)\b/.test(c) &&
      /\b(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|rmSync|unlinkSync|renameSync)\b/.test(c),
    reason: '不要在 node -e 裡改檔。請用 Edit／Write 工具；需要腳本時寫成 scratchpad 裡的檔案再執行。',
  },
];

function check(command) {
  if (typeof command !== 'string' || !command) return null;
  for (const r of RULES) if (r.test(command)) return r;
  return null;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw); } catch (e) { return; }
    const hit = check(input && input.tool_input && input.tool_input.command);
    if (!hit) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[check-shell:${hit.id}] ${hit.reason}`,
      },
    }));
  });
}

if (require.main === module) main();
module.exports = { check, RULES };
