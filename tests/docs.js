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

test('docs/基準檢查.md 與 CATALOG 一致：每項檢查都有章節，總覽表的標題與嚴重度相同', () => {
  const doc = read('docs/基準檢查.md'); const SEV = { error: '錯誤', warn: '警告', info: '提醒' };
  const rows = new Map(Array.from(doc.matchAll(/^\| \[(\w\d\d)\]\(#\w\d\d\) \| [^|]+ \| ([^|]+) \| ([^|]+) \|/gm), (m) => [m[1], [m[2].trim(), m[3].trim()]]));
  assert.deepStrictEqual(Array.from(rows.keys()), Object.keys(S.check.CATALOG), '總覽表的檢查與順序應與 CATALOG 相同');
  Object.entries(S.check.CATALOG).forEach(([id, c]) => {
    assert.deepStrictEqual(rows.get(id), [c.title, SEV[c.severity]], `${id} 的標題或嚴重度與程式不同`);
    assert.ok(new RegExp(`^### ${id}$`, 'm').test(doc), `${id} 缺少說明章節`);
  });
});
// 文字不要求逐字相同（文件可加連結與補充），只檢查結構：每項檢查都有「常見原因」與「處理」，原因條數與 CATALOG 相同
test('docs/基準檢查.md 每項檢查都有「常見原因」（條數同 CATALOG 的 causes）與「處理」（對應 action）', () => {
  const doc = read('docs/基準檢查.md');
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
test('docs/基準檢查.md 每項檢查「處理」的第一句與處理提示（S.query.rule(id).hint，action 的第一句）相同', () => {
  /*
   * 比較規則：取「- **處理**：」之後到第一個「。」（含）為文件的第一句。
   * 兩邊都先去掉 Markdown 標記（反引號；連結 [文字](網址) 只留文字）與空白，再要求完全相同；
   * 除此之外不做標點轉換，全形／半形標點要一致。文件第一句之後可以加連結與補充。
   */
  const doc = read('docs/基準檢查.md');
  const plain = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`/g, '').replace(/\s+/g, '');
  const problems = [];
  S.query.rules().forEach((r) => {
    const sec = (doc.split(new RegExp(`^### ${r.id}$`, 'm'))[1] || '').split(/^#{2,3} /m)[0];
    const line = sec.split('\n').find((l) => l.startsWith('- **處理**：'));
    const m = line && /^- \*\*處理\*\*：([^。]*。)/.exec(line);
    if (!m) problems.push(`${r.id}：找不到「- **處理**：第一句。」`);
    else if (plain(m[1]) !== plain(r.hint || '')) problems.push(`${r.id}：文件「${m[1]}」／程式「${r.hint}」`);
  });
  assert.deepStrictEqual(problems, [], '「處理」的第一句是畫面上的處理提示，請與 src/check/catalog.js 的 action 第一句一致');
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

/*
 * Markdown 的相對連結與錨點都要指得到東西。範圍是 git 的檔案（含尚未 add 的新檔，不含 .gitignore 排除的），
 * 不含 tests/workflow/fixtures/：那裡是報表的逐字預期輸出，括號裡的文字不是連結。
 * 錨點規則與連結的取法在 tests/lib.js（githubSlug、markdownAnchors、linkTargets），tests/ui-smoke.js 的文件連結也用同一份。
 */
const { githubSlug, stripCodeSpans, proseLines, markdownAnchors, anchorsOf, hasAnchor, linkTargets, RETIRED_TERMS, retiredIn } = require('./lib.js');
const mdFiles = () => execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter(Boolean).filter((f) => !f.startsWith('tests/workflow/fixtures/') && fs.existsSync(path.join(ROOT, f)));

test('連結檢查的規則：角括號連結、<a href>、網址中的括號、雙反引號、大寫錨點與 setext 標題', () => {
  assert.deepStrictEqual(linkTargets('[a](<有 空白.md>) 與 [b](b.md "標題")'), ['有 空白.md', 'b.md'], '角括號連結取整段、標題不算目標');
  assert.deepStrictEqual(linkTargets('見 <a href="docs/x.md#y">x</a>、<a class="k" href=\'z.md\'>'), ['docs/x.md#y', 'z.md'], 'Markdown 內的 <a href> 也是連結');
  assert.deepStrictEqual(linkTargets('[w](https://e.org/wiki/Foo_(bar)) 之後（[c](c.md)）'), ['https://e.org/wiki/Foo_(bar)', 'c.md'], '網址中成對的括號不截斷，外層括號不算');
  assert.deepStrictEqual(linkTargets('[r]: <有 空白.md>'), ['有 空白.md'], '參考式定義的角括號');
  assert.strictEqual(stripCodeSpans('前 ``a ` [x](不是連結.md) `` 後 `b` 尾'), '前  後  尾', '雙反引號的 code span 裡可以有單一反引號');
  assert.strictEqual(githubSlug('5.5 下鑽層級（M2）'), '55-下鑽層級m2');
  assert.strictEqual(githubSlug('`S.query` 與 [Q](q.md)'), 'squery-與-q');
  const a = markdownAnchors(['# Title One', '', 'Setext 標題', '===', '', '第二個', '---', '', '- 清單項目', '---', '```', '# 不是標題', '```', '# Title One', '<a id="Raw-ID"></a>'].join('\n'));
  assert.deepStrictEqual([...a].sort(), ['Raw-ID', 'setext-標題', 'title-one', 'title-one-1', '第二個'].sort(), 'setext 標題、同名編號、程式碼區塊與清單後的 --- 不算標題');
  assert.ok(hasAnchor(a, 'Title-One') && hasAnchor(a, 'Raw-ID') && !hasAnchor(a, 'raw-id'), '標題錨點不分大小寫，<a id> 原樣比對');
  assert.deepStrictEqual(proseLines('---\nname: x\n---\n本文 `碼`\n```\n區塊\n```').map((r) => [r.no, r.line]), [[4, '本文 ']], 'front matter、程式碼區塊與行內程式碼不算本文');
});
test('Markdown 的相對連結都指得到檔案，錨點都對得到標題（GitHub 錨點規則）', () => {
  const problems = [];
  mdFiles().forEach((f) => {
    proseLines(read(f)).forEach(({ line, no }) => {
      linkTargets(line).forEach((u) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return;
        const at = u.indexOf('#');
        let p = at < 0 ? u : u.slice(0, at); let h = at < 0 ? '' : u.slice(at + 1);
        try { p = decodeURIComponent(p); h = decodeURIComponent(h); } catch (e) { problems.push(`${f}:${no}：無法解碼 ${u}`); return; }
        const target = p ? path.posix.normalize(path.posix.join(path.posix.dirname(f), p)) : f;
        if (!fs.existsSync(path.join(ROOT, target))) problems.push(`${f}:${no}：找不到檔案 ${u}`);
        else if (h && target.endsWith('.md') && !hasAnchor(anchorsOf(target), h)) problems.push(`${f}:${no}：${target} 沒有錨點 #${h}`);
      });
    });
  });
  assert.deepStrictEqual(problems, [], '請修正連結或錨點（錨點由標題產生，改標題時要一起改引用）');
});

/*
 * 文件不再出現畫面已淘汰的說法（清單在 tests/lib.js 的 RETIRED_TERMS，畫面的冒煙測試用同一份再加上只適用畫面的詞）。
 * 範圍：docs/、README.md、CLAUDE.md、.github/copilot-instructions.md、skills。歷史敘述不掃：docs/版本紀錄.md、docs/架構決策/、
 * docs/路線圖.md（已完成項目的紀錄）。不掃程式碼區塊、行內程式碼、連結網址、HTML 標籤（含舊錨點 <a id>）與刪除線；
 * 同一行明寫是舊說法（原本、取代、改名、舊稱、已淘汰、拿掉）時也不算，例如「原本的『⋯』選單拿掉了」。
 */
const TERM_SCOPE = /^(docs\/|README\.md$|CLAUDE\.md$|\.github\/copilot-instructions\.md$|\.github\/skills\/|\.claude\/skills\/)/;
const TERM_HISTORY = (f) => f === 'docs/版本紀錄.md' || f === 'docs/路線圖.md' || f.startsWith('docs/架構決策/');
const HISTORY_LINE = /原本|取代|改名|舊稱|已淘汰|拿掉/;
const prose = (line) => line.replace(/~~.*?~~/g, '').replace(/\]\([^)]*\)/g, ']').replace(/<[^>]+>/g, '');
test('文件不再出現畫面已淘汰的說法（與冒煙測試共用 RETIRED_TERMS；歷史敘述除外）', () => {
  assert.deepStrictEqual(retiredIn(prose(stripCodeSpans('頁首「⋯」選單、[a](規則目錄.md)、`規則目錄`、~~收斂趨勢~~、<a id="收斂趨勢"></a>')), RETIRED_TERMS).map((x) => x[0]), ['頁首「⋯」', '「⋯」選單'],
    '只算本文：連結網址、刪除線與 HTML 標籤不算');
  const hits = [];
  mdFiles().filter((f) => TERM_SCOPE.test(f) && !TERM_HISTORY(f)).forEach((f) => {
    proseLines(read(f)).forEach(({ line, no }) => {
      const t = prose(line); if (HISTORY_LINE.test(t)) return;
      retiredIn(t, RETIRED_TERMS).forEach(([w, now]) => hits.push(`${f}:${no}：「${w}」→ 改用「${now}」`));
    });
  });
  assert.deepStrictEqual(hits, [], '文件仍有畫面已淘汰的說法（若是合理用法，把 tests/lib.js 的詞改成更精確的片語，或移到 RETIRED_UI_TERMS）');
});

let fail = 0;
for (const t of tests) {
  try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { fail++; console.log('  ✗ ' + t.name + '\n      ' + String(e.message).split('\n').join('\n      ')); }
}
console.log(`\n${tests.length - fail} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
