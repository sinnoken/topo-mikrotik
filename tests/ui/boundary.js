'use strict';
// ------------------------------------------------------------ 畫面與資料的邊界（靜態掃描 src/view）
/**
 * 去掉 JS 的註解，字串、template 文字與 regex 的內容換成空白（換行保留，行號不變）；template 的 ${} 內是程式碼，保留。
 * 只為邊界掃描用，不是完整的 parser：/ 依前一個有效字元判斷是除號還是 regex。
 */
function stripJs(src) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const n = src.length; const tpl = []; // 每層 template 的 ${} 內目前的大括號深度
  let out = ''; let i = 0; let prev = '';
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (c === '/' && d === '/') { const j = src.indexOf('\n', i); const e = j < 0 ? n : j; out += blank(src.slice(i, e)); i = e; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; out += blank(src.slice(i, e)); i = e; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1; while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out += c + blank(src.slice(i + 1, j)) + c; i = j + 1; prev = c; continue;
    }
    if (c === '`' || (c === '}' && tpl.length && tpl[tpl.length - 1] === 0)) {
      if (c === '}') tpl.pop();
      let j = i + 1; while (j < n && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) { if (src[j] === '\\') j++; j++; }
      out += c + blank(src.slice(i + 1, j));
      if (src[j] === '`') { out += '`'; i = j + 1; prev = '`'; } else { out += '${'; tpl.push(0); i = j + 2; prev = '{'; }
      continue;
    }
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(return|typeof|case|in|of|void)$/.test(out.trimEnd()))) {
      let j = i + 1; let cls = false;
      while (j < n && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      out += '/' + blank(src.slice(i + 1, j)) + '/'; i = j + 1; prev = '/'; continue;
    }
    if (tpl.length && c === '{') tpl[tpl.length - 1]++;
    if (tpl.length && c === '}') tpl[tpl.length - 1]--;
    out += c; if (!/\s/.test(c)) prev = c; i++;
  }
  return out;
}
/** 畫面可以使用的 SSOT 成員：查詢介面、輸入 API、常數、下游 API 與畫面自己的命名空間 */
const VIEW_S_ALLOW = new Set(['query', 'trace', 'util', 'keys', 'VERSION', 'SCHEMA', 'LINK_SCOPE', 'KIND_LABEL', 'build', 'buildAsync', 'inputHashOf',
  'preflight', 'collectCommands', // 建立前的預檢；由 tools/collector-commands.sh 產生的收集指令清單
  'profiles', 'samples', 'compare', 'remediate', 'ledger', 'workpack', 'zip', 'report', 'view', 'store']);
/** 只允許其中一個成員的核心命名空間 */
const VIEW_S_ONLY = { readers: 'PASTE', profile: 'compile' };
const VIEW_S_HINT = {
  'check.CATALOG': '(S.query.rule(id) || {}).欄位，或 S.query.rules()（causes／action 只經過 V.remediation.advice）',
  'check.DATA_LABEL': 'S.query.dataLabel(t)', 'check.fmtVlans': 'S.util.fmtVlans(ids)', adapters: 'S.query.adapterLabel(id)',
  readers: '只允許 S.readers.PASTE；建立基準用 S.build／S.buildAsync', profile: '只允許 S.profile.compile',
};
const VIEW_FIELD_HINT = {
  findings: 'Q.findings()／Q.finding(idx)／Q.findingsByRule(id)／Q.findingIndexByKey(key)',
  meta: 'Q.meta()；還沒建立查詢介面的 JSON 用 S.query.metaOf(x)',
  coverage: 'Q.coverage()／Q.coverageOf(devKey)', blocks: 'Q.blocksOf(devKey)／Q.block(id)',
  model: 'Q 的查詢函式（例如 Q.devices()、Q.getDevice(key)）',
};
const VIEW_DEFAULT_HINT = '改用 SSOT.query(snapshot) 或 S.query.* 的查詢函式；沒有合適的函式時請 data-model 新增';
/** 一個畫面檔案違反邊界的地方：[{ line, text }]，text 含檔案、行號、寫法與建議 */
function viewBoundaryViolations(file, src) {
  const out = [];
  stripJs(src).split('\n').forEach((line, n) => {
    const add = (what, hint) => out.push({ line: n + 1, text: `${file}:${n + 1}：${what} → 建議：${hint}` });
    for (const m of line.matchAll(/(?<![\w$.])(?:globalThis\s*\.\s*)?(?:S|SSOT)\s*(?:\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?|\[)/g)) {
      const [all, top, sub] = m;
      if (!top) { add(all.trim() + '…（計算的成員名稱）', '用固定的成員名稱存取允許的 API'); continue; }
      if (VIEW_S_ONLY[top]) { if (sub !== VIEW_S_ONLY[top]) add(`S.${top}${sub ? '.' + sub : ''}`, VIEW_S_HINT[top]); continue; }
      if (!VIEW_S_ALLOW.has(top)) add(`S.${top}${sub ? '.' + sub : ''}`, VIEW_S_HINT[top + '.' + sub] || VIEW_S_HINT[top] || VIEW_DEFAULT_HINT);
    }
    if (/\}\s*=\s*(?:globalThis\s*\.\s*)?(?:S|SSOT)(?![\w$])(?!\s*\.)/.test(line)) add('從 S 解構', '逐一使用允許的 S.* 成員');
    for (const m of line.matchAll(/(?<![\w$])(snap|snapshot)(?![\w$])\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[)/g)) {
      add(`${m[1]}.${m[2] || '[…]'}（讀 Snapshot 欄位）`, VIEW_FIELD_HINT[m[2]] || VIEW_DEFAULT_HINT);
    }
    if (/\bQ\s*\.\s*snapshot(?![\w$])/.test(line)) add('Q.snapshot', VIEW_DEFAULT_HINT);
  });
  return out;
}

module.exports = { stripJs, VIEW_S_ALLOW, VIEW_S_ONLY, VIEW_S_HINT, VIEW_FIELD_HINT, VIEW_DEFAULT_HINT, viewBoundaryViolations };
