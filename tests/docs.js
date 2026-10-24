/*
 * 文件與分工的一致性測試：node tests/docs.js
 * 文件描述要和程式一致、skills 兩份要同步、每個檔案恰好由一個 agent 負責。
 * 和核心測試分開，docs agent 只需跑這支（npm run test:docs）。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./load.js')();
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('docs/基準檢查規則.md 與 CATALOG 一致：每項規則都有章節，總覽表的標題與嚴重度相同', () => {
  const doc = read('docs/基準檢查規則.md'); const SEV = { error: '錯誤', warn: '警告', info: '提醒' };
  const rows = new Map(Array.from(doc.matchAll(/^\| \[(\w\d\d)\]\(#\w\d\d\) \| [^|]+ \| ([^|]+) \| ([^|]+) \|/gm), (m) => [m[1], [m[2].trim(), m[3].trim()]]));
  assert.deepStrictEqual(Array.from(rows.keys()), Object.keys(S.check.CATALOG), '總覽表的規則與順序應與 CATALOG 相同');
  Object.entries(S.check.CATALOG).forEach(([id, c]) => {
    assert.deepStrictEqual(rows.get(id), [c.title, SEV[c.severity]], `${id} 的標題或嚴重度與程式不同`);
    assert.ok(new RegExp(`^### ${id}$`, 'm').test(doc), `${id} 缺少說明章節`);
  });
});
// 文字不要求逐字相同（文件可加連結與補充），只檢查結構：每條規則都有「常見原因」與「處理」，原因條數與 CATALOG 相同
test('docs/基準檢查規則.md 每項規則都有「常見原因」（條數同 CATALOG 的 causes）與「處理」（對應 action）', () => {
  const doc = read('docs/基準檢查規則.md');
  const problems = [];
  Object.entries(S.check.CATALOG).forEach(([id, c]) => {
    const m = new RegExp(`^### ${id}\\n([\\s\\S]*?)(?=^##)`, 'm').exec(doc);
    if (!m) { problems.push(`${id}：找不到章節`); return; }
    const lines = m[1].split('\n');
    const at = (label) => lines.reduce((a, l, k) => (l.startsWith(`- **${label}**：`) ? a.concat(k) : a), []);
    const causes = at('常見原因'); const action = at('處理');
    if (causes.length !== 1) problems.push(`${id}：「常見原因」應恰好一段，實際 ${causes.length} 段`);
    else {
      const items = [];
      for (let k = causes[0] + 1; k < lines.length && /^ {2}- \S/.test(lines[k]); k++) items.push(lines[k]);
      if (lines[causes[0]] !== '- **常見原因**：') problems.push(`${id}：「常見原因」請逐條寫成子項目，不要寫在同一行`);
      else if (items.length !== c.causes.length) problems.push(`${id}：「常見原因」有 ${items.length} 條，CATALOG 的 causes 有 ${c.causes.length} 條`);
    }
    if (action.length !== 1) problems.push(`${id}：「處理」應恰好一段，實際 ${action.length} 段`);
    else if (!lines[action[0]].slice('- **處理**：'.length).trim()) problems.push(`${id}：「處理」是空的`);
  });
  assert.deepStrictEqual(problems, [], '請依 src/check/catalog.js 的 causes／action 更新文件');
});
test('.claude/skills 與 .github/skills 的 skill 內容一致（Claude Code 版只多一行同步說明）', () => {
  const names = fs.readdirSync(path.join(ROOT, '.github/skills')).sort();
  assert.deepStrictEqual(fs.readdirSync(path.join(ROOT, '.claude/skills')).sort(), names);
  names.forEach((n) => {
    const claude = read(`.claude/skills/${n}/SKILL.md`).replace(/\n> Claude Code 版。[^\n]*\n/, '');
    assert.strictEqual(claude, read(`.github/skills/${n}/SKILL.md`), `${n} 兩個版本內容不同，請同步修改`);
  });
});
test('分工：repo 中每個檔案恰好屬於一個 agent，agent 定義與所有權表一致', () => {
  const own = JSON.parse(read('.claude/agents/ownership.json'));
  const owners = Object.keys(own).filter((k) => !k.startsWith('_'));
  const match = (file, pat) => (pat.endsWith('/') ? file.startsWith(pat) : file === pat);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));
  const problems = [];
  files.forEach((f) => {
    const who = owners.filter((o) => own[o].some((p) => match(f, p)));
    if (who.length !== 1) problems.push(`${f}：${who.length ? who.join('、') : '沒有負責者'}`);
  });
  assert.deepStrictEqual(problems, [], '每個檔案要恰好一個負責者');
  const defined = fs.readdirSync(path.join(ROOT, '.claude/agents')).filter((f) => f.endsWith('.md')).map((f) => {
    const name = (read(`.claude/agents/${f}`).match(/^name:\s*(\S+)/m) || [])[1];
    assert.strictEqual(name, f.replace(/\.md$/, ''), `${f} 的 name 應與檔名相同`);
    return name;
  }).sort();
  assert.deepStrictEqual(defined, owners.filter((o) => o !== 'lead').sort(), 'agent 定義檔要和所有權表的 agent 一一對應（lead 是主對話，不需定義檔）');
});

let fail = 0;
for (const t of tests) {
  try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { fail++; console.log('  ✗ ' + t.name + '\n      ' + String(e.message).split('\n').join('\n      ')); }
}
console.log(`\n${tests.length - fail} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
