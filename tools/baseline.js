#!/usr/bin/env node
/*
 * 排程用的 CLI：建立基準 → 推進處理紀錄 → 輸出到 out/（處理紀錄第四階段，見 docs/路線圖.md 的「CLI（tools/baseline.js）」）。
 * 核心以 tests/load.js 載入（tools/core-files.js 的順序、vm），和瀏覽器用的是同一批檔案；這裡不另寫任何解析或判斷規則。
 * 唯讀（ADR-001）：只讀收集檔、寫 out/，不連線設備。處理紀錄是使用者的資料，不放進基準（ADR-002）。
 * 可重現：相同輸入與選項（含 --now）輸出的每個檔案位元組都相同；基準去掉與執行環境有關的 meta.timing。
 * 執行失敗時先算完全部內容再寫檔，所以失敗不會留下不完整的輸出。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** 結束碼：排程依它決定是否通知（唯一定義處，--help 也由這裡產生） */
const EXIT = Object.freeze({
  OK: 0, // 成功，沒有復發，也沒有新的待處理錯誤／警告
  NOTIFY: 1, // 成功，但有復發、新出現或豁免到期的待處理錯誤／警告
  FAILED: 2, // 執行失敗：參數錯誤、輸入讀不到或沒有認到任何設備的資料、處理紀錄／命名規則／預期資料格式錯誤；不輸出任何檔案
});
/** out/ 中的檔名 */
const FILES = Object.freeze({
  baseline: 'baseline.json', ledger: 'ledger.json', findings: 'findings.json', summary: 'summary.json', compare: 'compare.json',
  findingsCsv: 'findings.csv', findingsMd: 'findings.md',
});
const SUMMARY_SCHEMA = 'ssot-cli-summary/1';
const FINDINGS_SCHEMA = 'ssot-cli-findings/1';
/** 通知只看錯誤與警告（與畫面的「待處理」相同，不含提醒） */
const NOTIFY_SEVERITIES = ['error', 'warn'];
const SEV_RANK = { error: 0, warn: 1, info: 2 };
/** 會讓項目成為新的待處理的推進原因（S.ledger.advance 的 changes[].reason）→ summary.notify 的欄位 */
const NOTIFY_REASONS = Object.freeze({ new: 'new', reappeared: 'regressed', 'waiver-expired': 'waiverExpired' });
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const HELP = `用法：node tools/baseline.js <收集檔…> -o <輸出目錄> [選項]

由 RouterOS 收集檔建立基準，推進處理紀錄，輸出到輸出目錄。只讀檔案，不連線設備。

選項：
  -o, --out <目錄>          輸出目錄（必填；不存在時建立，同名檔案覆蓋）
  --ledger <檔案>           上一輪的處理紀錄（ssot-ledger/1）；省略時從空的處理紀錄開始（第一次執行）
  --profile <檔案>          命名規則（ssot-profile JSON）
  --expected-data <檔案>    各類設備應收資料（S.build 的 expectedData，{ 設備類型: [資料類別…] }）
  --expected <檔案>         預期現況（ssot-expected/1），輸出比對結果 ${FILES.compare}
  --now <ISO 8601>          基準的建立時間與推進時間；省略時用目前時間（要可重現時指定）
  -h, --help                顯示這段說明

輸出：
  ${FILES.baseline}   基準（Snapshot，不含 meta.timing）
  ${FILES.ledger}     推進後的處理紀錄（下一輪以 --ledger 傳入）
  ${FILES.findings}   檢查結果與處理狀態（${FINDINGS_SCHEMA}）
  ${FILES.findingsCsv}    檢查結果 CSV（與畫面「匯出 CSV」相同；處理紀錄欄位是推進後的狀態）
  ${FILES.findingsMd}     檢查結果 Markdown 報表（與畫面「匯出 Markdown」的依檢查分組相同）
  ${FILES.summary}    摘要（${SUMMARY_SCHEMA}）：新出現、復發、豁免到期、待處理錯誤／警告數與結束碼
  ${FILES.compare}    預期現況比對（ssot-diff/1，只有 --expected 時）

結束碼：
  ${EXIT.OK}  成功，沒有復發，也沒有新的待處理錯誤／警告
  ${EXIT.NOTIFY}  成功，但有復發、新出現或豁免到期的待處理錯誤／警告（排程據此通知）
  ${EXIT.FAILED}  執行失敗（參數錯誤、輸入讀不到、收集檔沒有認到任何設備的資料、處理紀錄／命名規則／預期資料格式錯誤）；訊息寫到 stderr，不輸出任何檔案
`;

class CliError extends Error {}
const fail = (msg) => { throw new CliError(msg); };

/** 參數：位置參數是收集檔；選項可寫成 --x 值 或 --x=值，每個只能出現一次 */
function parseArgs(argv) {
  const OPTS = { '-o': 'out', '--out': 'out', '--ledger': 'ledger', '--profile': 'profile', '--expected': 'expected', '--expected-data': 'expectedData', '--now': 'now' };
  const a = { inputs: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '-h' || s === '--help') { a.help = true; continue; }
    if (s === '--') { a.inputs.push(...argv.slice(i + 1)); break; }
    if (!s.startsWith('-') || s === '-') { a.inputs.push(s); continue; }
    const eq = s.indexOf('=');
    const name = s.startsWith('--') && eq > 0 ? s.slice(0, eq) : s;
    const key = OPTS[name];
    if (!key) fail(`不認得的參數「${s}」（用 --help 查看用法）`);
    const v = name !== s ? s.slice(eq + 1) : argv[++i];
    if (v == null || v === '') fail(`${name} 需要一個值`);
    if (a[key] !== undefined) fail(`${name} 只能指定一次`);
    a[key] = v;
  }
  return a;
}

/** 讀成文字：和瀏覽器的 File.text() 相同（UTF-8，去掉開頭的 BOM），基準的 inputHash 才會和畫面一致 */
const decoder = new TextDecoder('utf-8');
function readText(file, what) {
  try { return decoder.decode(fs.readFileSync(file)); } catch (e) { return fail(`無法讀取${what}「${file}」：${e.message}`); }
}
function readJson(file, what) {
  const t = readText(file, what);
  try { return JSON.parse(t); } catch (e) { return fail(`${what}「${file}」不是合法的 JSON：${e.message}`); }
}
const json = (v) => JSON.stringify(v, null, 2) + '\n';

/**
 * 計算全部輸出（不寫檔）。回傳 { files: [{ name, text }], code }。
 * 規則都在核心：建立 S.build、推進 S.ledger.advance、待處理 S.ledger.isPending、比對 S.compare。
 */
function compute(S, a) {
  if (!a.inputs.length) fail('至少要指定一個收集檔（用 --help 查看用法）');
  if (!a.out) fail('必須以 -o 指定輸出目錄');
  if (a.now !== undefined && !(ISO_RE.test(a.now) && Number.isFinite(Date.parse(a.now)))) fail(`--now 必須是 ISO 8601 時間（例如 2026-01-01T00:00:00Z），目前是「${a.now}」`);
  if (a.now !== undefined) {
    // 不存在的日期（例如 2026-02-30）Date.parse 會自動進位，這裡要求年月日原樣成立
    const [y, mo, d] = a.now.slice(0, 10).split('-').map(Number); const day = new Date(Date.UTC(y, mo - 1, d));
    if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) fail(`--now 的日期不存在：「${a.now}」`);
  }
  // 帶時區位移的時間正規化成 UTC，基準、摘要與處理紀錄的時間才一致；已是 UTC（Z）的照原樣，與畫面傳入的值相同
  const now = a.now === undefined ? new Date().toISOString() : /Z$/.test(a.now) ? a.now : new Date(a.now).toISOString();

  // 來源名稱用檔名（和畫面相同）；檔名重複時證據的檔案會分不清，直接失敗
  const sources = a.inputs.map((f) => ({ name: path.basename(f), text: readText(f, '收集檔') }));
  const dup = sources.map((s) => s.name).filter((n, i, all) => all.indexOf(n) !== i);
  if (dup.length) fail(`收集檔的檔名重複：${[...new Set(dup)].join('、')}（來源以檔名區分，請改名）`);
  // 什麼都沒收到不是「網路乾淨」：先擋下沒有內容的輸入（S.build 也會以 RangeError 拒絕），訊息才指得出是哪些檔案
  if (!sources.some((s) => s.text.trim())) fail(`收集檔沒有內容（${a.inputs.join('、')} 都是空的或只有空白），不建立基準`);

  const LG = S.ledger;
  let ledger = LG.empty();
  if (a.ledger !== undefined) {
    ledger = readJson(a.ledger, '處理紀錄');
    const v = LG.validate(ledger);
    if (!v.ok) fail(`處理紀錄「${a.ledger}」格式不正確（${v.errors.length} 項）：\n  ${v.errors.join('\n  ')}`);
  }
  let profile = null;
  if (a.profile !== undefined) {
    profile = readJson(a.profile, '命名規則');
    // S.profile.compile 收到 null 等假值時回傳 null（等於不套用），這裡要求是物件，不靜默略過
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) fail(`命名規則「${a.profile}」必須是 JSON 物件`);
    try { S.profile.compile(profile); } catch (e) { fail(`命名規則「${a.profile}」格式不正確：${e.message}`); }
  }
  const expectedData = a.expectedData !== undefined ? readJson(a.expectedData, '各類設備應收資料') : null;
  if (a.expectedData !== undefined && !(expectedData && typeof expectedData === 'object' && !Array.isArray(expectedData)
    && Object.values(expectedData).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string')))) {
    fail(`各類設備應收資料「${a.expectedData}」必須是 { 設備類型: [資料類別…] }`);
  }
  const expected = a.expected !== undefined ? readJson(a.expected, '預期現況') : null;
  if (a.expected !== undefined && (!expected || typeof expected !== 'object' || Array.isArray(expected))) fail(`預期現況「${a.expected}」必須是 JSON 物件`);

  const snap = S.build(sources, { profile, expectedData, now });
  delete snap.meta.timing; // 唯一與執行環境有關的欄位
  const Q = S.query(snap);
  // 沒有認到任何設備的資料（只有註解、內容都認不得）：建得出基準，但排程會把它當成「沒有待處理項目」，所以視為執行失敗。
  // 認到＝已收集的設備有任何一類資料，或有收集失敗的紀錄（全部連線失敗仍是一次有結果的收集，由 C02 回報）。
  // 沒有設備標頭的檔案會以檔名當設備名（files-v1），所以不能只看 stats.collected。
  const failed = new Set(Q.coverage().filter((r) => r.failures && r.failures.length).map((r) => r.dev));
  if (!Q.devices().some((d) => d.collected && (d.data.length || failed.has(d.key)))) {
    const i01 = Q.findings().filter((f) => f.id === 'I01').length;
    fail(`收集檔沒有認到任何設備的資料（${sources.length} 個檔案${i01 ? `；無法辨識的段落 ${i01} 處（I01）` : ''}），不建立基準：`
      + '請確認收集檔是 tools/collect.sh 的輸出，或含設備標頭（名稱 (位址):）與 ### 指令標記的 RouterOS 輸出');
  }
  let compare = null;
  if (a.expected !== undefined) {
    compare = S.compare(Q, expected);
    if (compare.errors.length) fail(`預期現況「${a.expected}」格式不正確：\n  ${compare.errors.join('\n  ')}`);
  }

  const r = LG.advance(ledger, Q, { now });
  const next = r.ledger;
  // 每個 findingKey 的代表 finding（嚴重度取最高）
  const byKey = new Map();
  Q.findings().forEach((f) => {
    const k = Q.findingKey(f); const cur = byKey.get(k);
    if (!cur || SEV_RANK[f.severity] < SEV_RANK[cur.severity]) byKey.set(k, f);
  });
  const statusOf = (k) => (next.items[k] ? next.items[k].status : null);
  const notify = { new: [], regressed: [], waiverExpired: [] };
  r.changes.forEach((c) => {
    const field = NOTIFY_REASONS[c.reason]; const f = byKey.get(c.key);
    if (!field || !f || !NOTIFY_SEVERITIES.includes(f.severity) || !LG.isPending(c.to)) return;
    notify[field].push({ key: c.key, id: f.id, severity: f.severity, device: Q.findingDevice(f), message: f.message });
  });
  const count = (reason) => r.changes.filter((c) => c.reason === reason).length;
  const code = notify.new.length || notify.regressed.length || notify.waiverExpired.length ? EXIT.NOTIFY : EXIT.OK;
  const m = Q.meta();
  const summary = {
    schema: SUMMARY_SCHEMA, toolVersion: S.VERSION, createdAt: now,
    baseline: { schema: m.schema, inputHash: m.inputHash, baselineKey: m.baselineKey, createdAt: m.createdAt, profile: m.profile },
    round: LG.roundOf(next, m), skipped: r.skipped,
    findings: m.stats.findings,
    pending: Object.assign({}, Q.pendingSummary((f) => LG.isPending(statusOf(Q.findingKey(f))))),
    changes: { new: count('new'), regressed: count('reappeared'), fixed: count('disappeared'), waiverExpired: count('waiver-expired'),
      unobserved: r.unobserved.length, split: r.split.length },
    notify,
    compare: compare ? compare.summary : null,
    exitCode: code,
  };
  const findings = {
    schema: FINDINGS_SCHEMA, baselineKey: m.baselineKey,
    items: Q.findings().map((f) => {
      const k = Q.findingKey(f); const it = next.items[k] || null;
      return { key: k, id: f.id, severity: f.severity, title: f.title, message: f.message, device: Q.findingDevice(f),
        facet: f.facet != null ? f.facet : null, status: it ? it.status : null, note: it ? it.note : '', waiver: it ? it.waiver : null,
        evidence: f.evidence.map((e) => ({ file: e.file, line: e.line })) };
    }),
  };
  const files = [
    { name: FILES.baseline, text: json(snap) },
    { name: FILES.ledger, text: json(next) },
    { name: FILES.findings, text: json(findings) },
    // 檢查結果報表：與畫面的匯出同一份核心文字（S.report），處理紀錄用推進後的這一份
    { name: FILES.findingsCsv, text: S.report.findingsCsv(Q, { ledgerOf: S.report.ledgerOfItems(next, Q) }) },
    { name: FILES.findingsMd, text: S.report.findingsMarkdown(Q, { ledgerOf: S.report.ledgerOfItems(next, Q) }) },
    ...(compare ? [{ name: FILES.compare, text: json(compare) }] : []),
    { name: FILES.summary, text: json(summary) },
  ];
  // 這一輪沒有預期現況時，刪掉上一次留下的比對結果，輸出目錄才和這一輪的基準一致
  return { files, code, remove: compare ? [] : [FILES.compare] };
}

/** 寫檔：先寫成暫存檔，全部成功才改名；失敗時刪掉暫存檔（與這次建立的目錄） */
function writeAll(dir, files, remove) {
  const created = !fs.existsSync(dir);
  const tmps = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    files.forEach((f) => { const t = path.join(dir, `.${f.name}.${process.pid}.tmp`); tmps.push(t); fs.writeFileSync(t, f.text); });
    files.forEach((f, i) => fs.renameSync(tmps[i], path.join(dir, f.name)));
    (remove || []).forEach((n) => fs.rmSync(path.join(dir, n), { force: true }));
  } catch (e) {
    tmps.forEach((t) => { try { fs.rmSync(t, { force: true }); } catch (_) { /* 盡力清理 */ } });
    if (created) { try { fs.rmdirSync(dir); } catch (_) { /* 目錄不是空的就留著 */ } }
    fail(`無法寫入輸出目錄「${dir}」：${e.message}`);
  }
}

/** 執行一次，回傳結束碼（不呼叫 process.exit，方便測試與讓輸出寫完） */
function main(argv, io) {
  const err = (io && io.stderr) || process.stderr; const out = (io && io.stdout) || process.stdout;
  try {
    const a = parseArgs(argv);
    if (a.help) { out.write(HELP); return EXIT.OK; }
    const S = require('../tests/load.js')();
    const r = compute(S, a);
    writeAll(a.out, r.files, r.remove);
    const s = JSON.parse(r.files.find((f) => f.name === FILES.summary).text);
    out.write(`基準 ${s.baseline.baselineKey}：第 ${s.round + 1} 輪${s.skipped ? '（已推進過，處理紀錄不變）' : ''}；`
      + `待處理錯誤 ${s.pending.error}、警告 ${s.pending.warn}；新出現 ${s.notify.new.length}、復發 ${s.notify.regressed.length}、豁免到期 ${s.notify.waiverExpired.length}\n`);
    return r.code;
  } catch (e) {
    err.write(`tools/baseline.js：${e instanceof CliError ? e.message : (e && e.stack) || e}\n`);
    return EXIT.FAILED;
  }
}

module.exports = { EXIT, FILES, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
