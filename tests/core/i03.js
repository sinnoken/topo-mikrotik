// 已解析區塊中無法辨識的行（I03），以及「每一行輸入都有被處理」的不變式
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { S, ROOT, read, build, ids, count, gen, addrs, test, i03 } = require('../lib.js');
// ------------------------------------------------------------------ 已解析區塊中無法辨識的行（I03）
// 測試資料依 RouterOS 手冊的欄位撰寫，不是實機擷取；垃圾行與錯誤訊息是刻意放入的
const GARBAGE = 'GARBAGE LINE here';
// 每種 adapter 一段正常輸出：[adapter, 指令, 行]；垃圾行插在第一個資料行之後
const PER_ADAPTER = [
  ['mikrotik.neighbor', '/ip neighbor print detail without-paging', ['Flags: ', ' 0 interface=ether1 mac-address=AA:BB:CC:00:00:01 identity=SW_B', '    interface-name=ether2 platform=MikroTik']],
  ['mikrotik.config', '/export terse', ['/interface bridge add name=bridge1', '/ip address add address=10.0.0.1/24 interface=bridge1']],
  ['mikrotik.bridgehost', '/interface bridge host print detail without-paging', ['Flags: D - dynamic, L - local', ' 0 D mac-address=AA:BB:CC:00:00:05 on-interface=ether1 bridge=bridge1 vid=1']],
  ['mikrotik.vlans', '/interface bridge vlan print detail without-paging', [' 0 bridge=bridge1 vlan-ids=10 current-tagged=ether1 current-untagged=""']],
  ['mikrotik.interface', '/interface print detail without-paging', ['Flags: R - running', ' 0 R name="ether1" type="ether" mtu=1500']],
  ['mikrotik.ipaddr', '/ip address print detail without-paging', ['Flags: X - disabled, I - invalid, D - dynamic', ' 0 address=10.0.0.1/24 network=10.0.0.0 interface=ether1']],
  ['mikrotik.arp', '/ip arp print detail without-paging', [' 0 DC address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1']],
  ['mikrotik.route', '/ip route print detail without-paging', ['Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC', ' As dst-address=0.0.0.0/0 routing-table=main gateway=10.0.0.254 distance=1']],
  ['mikrotik.ospf', '/routing ospf neighbor print detail without-paging', [' 0 instance=default address=10.9.9.2 router-id=9.9.9.9 state="Full"']],
  ['mikrotik.wifireg', '/interface wifi registration-table print detail without-paging', ['Flags: A - AUTHORIZED', ' 0 A interface=wifi1 mac-address=AA:BB:CC:00:10:01 uptime=1h last-activity=1s']],
  ['mikrotik.stp', '/interface bridge port monitor [find] once', ['   interface: ether1', '        role: root-port']],
  ['mikrotik.stpbridge', '/interface bridge monitor [find] once', ['                   name: bridge1', '    current-mac-address: D4:01:C3:00:00:0A']],
  ['mikrotik.system', '/system resource print', ['     uptime: 1d', '    version: 7.12.1 (stable)', ' board-name: CRS326-24G-2S+']],
  ...[['ip', 'filter', 'input'], ['ip', 'nat', 'srcnat'], ['ip', 'raw', 'prerouting'], ['ipv6', 'filter', 'forward'], ['ipv6', 'raw', 'output']].map(([fam, table, chain]) => [`mikrotik.fwstats.${fam}-${table}`,
    `/${fam} firewall ${table} print stats detail without-paging`, ['Flags: X - disabled, I - invalid; D - dynamic', ' 0    ;;; c', `      chain=${chain} action=accept bytes=1 234 packets=12`]]),
];
const blockText = (cmd, lines) => ['SW (10.0.0.1):', `### ${cmd}`, ...lines].join('\n') + '\n';
test('I03：每種 adapter 的區塊內夾一行垃圾都會列出（行號、原文），正常輸出沒有 I03，I01 不受影響', () => {
  assert.deepStrictEqual(PER_ADAPTER.map((x) => x[0]).sort(), S.adapters.list.map((a) => a.id).sort(), '每種 adapter 都要有案例');
  PER_ADAPTER.forEach(([id, cmd, lines]) => {
    const clean = build(blockText(cmd, lines));
    assert.deepStrictEqual(clean.blocks[0].adapters, [id], id);
    assert.deepStrictEqual([i03(clean).length, count(clean, 'I01'), clean.blocks[0].unrecognizedLines], [0, 0, []], `${id} 的正常輸出不可有 I03`);
    const at = lines.findIndex((l) => /=|:\s*\S/.test(l) && !/^Flags:/i.test(l.trim())) + 1;
    const dirty = build(blockText(cmd, [...lines.slice(0, at), GARBAGE, ...lines.slice(at)]));
    const lineNo = 2 + at + 1; // 標頭、指令標記之後
    const f = i03(dirty);
    assert.strictEqual(f.length, 1, id);
    assert.strictEqual(count(dirty, 'I01'), 0, `${id}：I01 數量不變`);
    assert.deepStrictEqual(f[0].evidence.map((e) => [e.line, e.text]), [[lineNo, GARBAGE]], id);
    assert.deepStrictEqual(f[0].entities, [{ type: 'device', key: 'SW' }]);
    assert.strictEqual(f[0].severity, 'warn');
    assert.ok(f[0].message.includes(`第 ${lineNo} 行「${GARBAGE}」`) && f[0].message.includes('1 行'), f[0].message);
    assert.deepStrictEqual(dirty.blocks[0].unrecognizedLines, [lineNo], id);
    // 其他事實照常解析
    assert.deepStrictEqual(dirty.meta.factCount, clean.meta.factCount, `${id}：垃圾行不影響其他行的解析`);
  });
});
test('I03：上一輪找到的三種靜默略過（export 夾垃圾、arp 後接垃圾、neighbor 後接 RouterOS 錯誤）', () => {
  const ex = S.build([{ name: 't.txt', text: 'SW (10.0.0.1):\n### /export terse\n/interface bridge add name=bridge1\nGARBAGE LINE here\n/ip address add address=10.0.0.1/24 interface=bridge1\n' }], { now: '2026-01-01T00:00:00Z' });
  assert.deepStrictEqual([ids(ex).includes('I01'), i03(ex).map((f) => f.evidence.map((e) => e.line))], [false, [[4]]]);
  assert.deepStrictEqual(ex.blocks[0].adapters, ['mikrotik.config']);
  assert.deepStrictEqual(addrs(ex, 'SW|bridge1'), ['10.0.0.1/24'], '其他行照常進入基準');
  const arp = build('SW (10.0.0.1):\n### /ip arp print detail\n 0 DC address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1\nGARBAGE LINE here\n');
  assert.deepStrictEqual(i03(arp).map((f) => f.evidence.map((e) => [e.line, e.text])), [[[4, 'GARBAGE LINE here']]]);
  assert.strictEqual(arp.model.arps.length, 1);
  const nb = build('SW (10.0.0.1):\n### /ip neighbor print detail\n 0 interface=ether1 mac-address=AA:BB:CC:00:00:01 identity=SW_B\nerror: no such command\n');
  const f = i03(nb);
  assert.deepStrictEqual(f.map((x) => x.evidence.map((e) => [e.line, e.text])), [[[4, 'error: no such command']]]);
  assert.ok(/RouterOS 錯誤訊息/.test(f[0].message) && /不完整/.test(f[0].message), f[0].message);
});
test('I03：RouterOS 錯誤訊息一律列出，即使格式看起來像 adapter 可以略過的行（key: value、key=value）', () => {
  const errs = ['bad command name foo (line 1 column 1)', 'syntax error (line 1 column 5)', 'expected end of command (line 1 column 9)',
    'error: no such command', 'no such item', 'failure: no such item', 'input does not match any value of interface'];
  errs.forEach((e) => {
    // system 的 key: value 行原本可略過；export 的錯誤不是 add／set；monitor 的錯誤看起來像欄位行
    [['/system resource print', ['  version: 7.12.1 (stable)', e]], ['/export terse', ['/interface bridge add name=bridge1', e]],
      ['/interface bridge port monitor [find] once', ['   interface: ether1', '        role: root-port', e]],
      ['/ip arp print detail', [' 0 DC address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1', e]]].forEach(([cmd, lines]) => {
      const s = build(blockText(cmd, lines));
      const f = i03(s);
      assert.deepStrictEqual(f.map((x) => x.evidence.map((v) => v.text)), [[e]], `${cmd}：${e}`);
      assert.ok(/RouterOS 錯誤訊息/.test(f[0].message), f[0].message);
    });
  });
  assert.ok(S.adapters.util.rosError('error: no such command') && !S.adapters.util.rosError(' 0 interface=ether1 comment="syntax error"'));
});
test('I03：可忽略的行不算（Flags／Columns 說明、export 抬頭、續行、選單路徑、未使用的設定、停用與非作用中項目、bridge 重複列、;;; 註解）', () => {
  const s = build(['SW (10.0.0.1):', '### /export terse', '# 2026-10-13 10:00:00 by RouterOS 7.12.1', '# software id = AAAA-BBBB', '/interface bridge',
    'add name=bridge1 \\', '    comment="long"', '/system clock set time-zone-name=Asia/Taipei', '/ip address add address=10.0.0.9/24 interface=bridge1 disabled=yes',
    '/ip address add address=10.0.0.1/24 interface=bridge1',
    '### /ip arp print detail', 'Flags: X - disabled, I - invalid, H - DHCP, D - dynamic, P - published, C - complete',
    ' 0 X  address=10.0.0.7 mac-address=AA:BB:CC:00:00:07 interface=bridge1', ' 1 DC address=10.0.0.8 mac-address=AA:BB:CC:00:00:08', '      interface=bridge1',
    ' 2 D  address=10.0.0.6 interface=bridge1 status=failed', ' 3 DC address=169.254.1.1 mac-address=AA:BB:CC:00:00:06 interface=bridge1',
    '### /ip neighbor print detail', 'Columns: INTERFACE, ADDRESS, MAC-ADDRESS, IDENTITY', ' 0 ;;; uplink', '   interface=ether1 mac-address=AA:BB:CC:00:00:01 identity=SW_B',
    ' 1 interface=bridge1 mac-address=AA:BB:CC:00:00:01 identity=SW_B', ' 2 interface=ether1 mac-address=AA:BB:CC:00:00:01 identity=SW_B discovered-by=mndp',
    '### /ip route print detail', 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC', ' As dst-address=0.0.0.0/0 routing-table=main gateway=10.0.0.254 distance=1',
    '  s dst-address=10.5.0.0/16 routing-table=main gateway=10.0.0.9 distance=1', ' DAb dst-address=10.6.0.0/16 routing-table=vrf1 gateway=10.0.0.9 distance=20',
    '### /interface wireless registration-table print detail', ' 0 interface=wlan1 mac-address=AA:BB:CC:00:10:0F ap=yes uptime=1d last-activity=0ms',
    ' 1 interface=wlan1 mac-address=AA:BB:CC:00:10:02 ap=no uptime=2m last-activity=1s'].join('\n') + '\n');
  assert.deepStrictEqual(i03(s).map((f) => f.message), []);
  assert.deepStrictEqual(ids(s).filter((x) => x === 'I01'), []);
  assert.ok(s.blocks.every((b) => Array.isArray(b.unrecognizedLines) && !b.unrecognizedLines.length));
});
test('I03：整個區塊都認不得時仍是 I01（不重複列 I03）；區塊欄位 unrecognizedLines 只列已解析區塊', () => {
  const s = build('SW (10.0.0.1):\n### /ip arp print detail\nGARBAGE LINE here\nerror: no such command\n### /ip arp print detail\n 0 DC address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1\n');
  assert.deepStrictEqual([count(s, 'I01'), i03(s).length], [1, 0]);
  assert.deepStrictEqual(s.blocks.map((b) => b.unrecognizedLines), [[], []]);
  // 多行：訊息列出行數與前幾行，證據依 add() 的上限
  const many = build(blockText('/ip arp print detail', [' 0 DC address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1', ...Array.from({ length: 9 }, (_, k) => `junk ${k}`)]));
  const f = i03(many);
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual(many.blocks[0].unrecognizedLines, Array.from({ length: 9 }, (_, k) => 4 + k));
  assert.deepStrictEqual(f[0].evidence.map((e) => e.line), [4, 5, 6, 7, 8, 9], '證據最多 6 筆');
  assert.ok(f[0].message.includes('9 行') && f[0].message.includes('「junk 0」') && f[0].message.includes('「junk 2」') && !f[0].message.includes('「junk 3」'), f[0].message);
});

// ------------------------------------------------------------------ 每一行輸入都有被處理
/*
 * 不變式（粒度是「行」）：每個非空行屬於下列其中一種，沒有內容被靜默丟掉。
 *   ① 結構行：設備標頭「名稱 (IP):」、分隔線「_____」、指令標記（### …／[user@host] > …）、註解（# 開頭，### 與 export 抬頭除外）。
 *      bundle-v1 的標頭與分隔線依 readers/bundle-v1.js 檔頭的格式說明另外寫在這裡，當作獨立的規格，不沿用 reader 的正規式。
 *   ② 產生了事實：已解析區塊中，有事實的 line 指向這一行。
 *   ③ 被 adapter 列為可忽略（說明行、續行、停用項目、bridge 重複列…，見各 adapter），且不是 RouterOS 錯誤訊息。
 *   ④ 列在 I03（已解析區塊的 unrecognizedLines，且該區塊有 I03），或落在列為 I01 的區塊內（I01 的證據指回該區塊）。
 * ②③ 由 S.adapters.parse 重新解析同一份輸入取得（與 pipeline 共用），並確認與 Snapshot 的 unrecognizedLines 一致。
 * 另外確認區塊之間不重疊、每個區塊都是已解析或 I01，或是只有收集失敗註解的區塊（例如連線失敗；其中若有內容行，逐行檢查時仍會報出）。
 */
const BUNDLE_HEADER = /^\s*[A-Za-z0-9][\w.\-:]*\s*\(\d{1,3}(?:\.\d{1,3}){3}\)\s*:\s*$/;
const BUNDLE_SEP = /^\s*_{5,}\s*$/;
const COMMENT_LINE = /^\s*#(?!##)/;
const EXPORT_HEADER_LINE = /^\s*#\s*\S+\s+\d{2}:\d{2}:\d{2}\s+by RouterOS\b/i;
function unhandledLines(name, text) {
  const s = S.build([{ name, text }], { now: '2026-01-01T00:00:00Z' });
  const raw = S.readers.readAll([{ name, text }]).blocks;
  const reader = s.meta.sources[0].reader;
  const i01 = new Set(s.findings.filter((f) => f.id === 'I01').flatMap((f) => f.evidence.map((e) => e.block)));
  const i03 = new Set(s.findings.filter((f) => f.id === 'I03').flatMap((f) => f.evidence.map((e) => e.block)));
  const status = (b) => (b.adapters.length && !b.empty ? 'parsed' : i01.has(b.id) ? 'i01' : b.how === 'none' && b.failure ? 'notes-only' : null);
  const problems = []; const kinds = { structural: 0, fact: 0, ignored: 0, i03: 0, i01: 0 };
  s.blocks.forEach((b) => { if (!status(b)) problems.push(`區塊 ${b.id}（第 ${b.start}–${b.end} 行，${b.command || '沒有指令'}）既沒有解析也沒有列為 I01`); });
  const sorted = s.blocks.slice().sort((a, b) => a.start - b.start);
  sorted.forEach((b, k) => { if (k && b.start <= sorted[k - 1].end) problems.push(`區塊 ${sorted[k - 1].id} 與 ${b.id} 的行號範圍重疊`); });
  const owner = new Map(); s.blocks.forEach((b) => { for (let n = b.start; n <= b.end; n++) owner.set(n, b); });
  // 已解析區塊：重新解析，取得產生事實的行與可忽略的行
  const parsed = new Map();
  s.blocks.forEach((b) => {
    if (status(b) !== 'parsed') return;
    const rb = raw[b.id];
    if (!rb || rb.origin.startLine !== b.start) { problems.push(`區塊 ${b.id} 重新讀取的位置不同`); return; }
    const p = S.adapters.parse(rb, b.adapters.map((id) => S.adapters[id]));
    if (JSON.stringify(p.unrecognized) !== JSON.stringify(b.unrecognizedLines)) problems.push(`區塊 ${b.id} 的 unrecognizedLines 與重新解析的結果不同`);
    if (b.unrecognizedLines.length && !i03.has(b.id)) problems.push(`區塊 ${b.id} 有無法辨識的行，但沒有 I03`);
    p.ignored.forEach((why, n) => { if (S.adapters.util.rosError(rb.lines[n - rb.origin.startLine])) problems.push(`第 ${n} 行是 RouterOS 錯誤訊息，卻被列為可忽略（${why}）`); });
    parsed.set(b.id, { facts: new Set(p.facts.map((f) => f.line)), ignored: p.ignored, unrecognized: new Set(b.unrecognizedLines) });
  });
  const structural = (line) => S.readers._common.markerOf(line) !== null || (COMMENT_LINE.test(line) && !EXPORT_HEADER_LINE.test(line))
    || (reader === 'bundle-v1' && (BUNDLE_HEADER.test(line) || BUNDLE_SEP.test(line)));
  text.split(/\r?\n/).forEach((line, k) => {
    const n = k + 1;
    if (!line.trim()) return;
    if (structural(line)) { kinds.structural++; return; }
    const b = owner.get(n); const st = b && status(b); const p = b && parsed.get(b.id);
    const kind = st === 'i01' ? 'i01' : !p ? null : p.facts.has(n) ? 'fact' : p.unrecognized.has(n) ? 'i03' : p.ignored.has(n) ? 'ignored' : null;
    if (kind) kinds[kind]++;
    else problems.push(`第 ${n} 行${b ? `（區塊 ${b.id}：${st}）` : '不在任何區塊內'}：${line.trim().slice(0, 80)}`);
  });
  return { s, problems, kinds };
}
test('每一行輸入都有被處理：範例資料與 tests/fixtures/ 的每個非空行都是結構行、產生事實、可忽略、I03 或 I01；I03 都是 0', () => {
  const files = ['samples/sample-bundle.txt'];
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).sort((a, b) => S.util.cmp(a.name, b.name))
    .forEach((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.txt') && files.push(`${dir}/${e.name}`)));
  walk('tests/fixtures');
  assert.ok(files.length >= 8, files.join('、'));
  const total = { structural: 0, fact: 0, ignored: 0, i03: 0, i01: 0 };
  files.forEach((f) => {
    const { s, problems, kinds } = unhandledLines(path.basename(f), read(f));
    assert.deepStrictEqual(problems.slice(0, 10), [], `${f} 有內容沒被處理（共 ${problems.length} 處）`);
    Object.keys(total).forEach((k) => { total[k] += kinds[k]; });
    // 範例的 --faults 刻意放了一個 I03（見下一項測試）；其餘檔案都不可有
    if (f !== 'samples/sample-bundle.txt') assert.deepStrictEqual(i03(s).map((x) => x.message), [], `${f} 不可有 I03`);
  });
  console.log(`      ${files.length} 個檔案：結構 ${total.structural}、事實 ${total.fact}、可忽略 ${total.ignored}、I03 ${total.i03}、I01 ${total.i01} 行`);
  // 不變式本身要抓得到問題：沒有標頭的內容是 I01（算處理）；一個辨識成功但解析不出東西的區塊也是 I01
  assert.deepStrictEqual(unhandledLines('a.txt', '雜訊\nSW (10.0.0.1):\n### /ip arp print detail\n 0 DC address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1\n').problems, []);
  assert.deepStrictEqual(unhandledLines('a.txt', 'SW (10.0.0.1):\n### /ip arp print\nFlags: X\n 0 10.0.0.2 AA:BB:CC:00:00:01 bridge1\n').problems, []);
  assert.ok(unhandledLines('a.txt', 'SW (10.0.0.1):\n### /ip arp print detail\n 0 DC address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1\n').s.blocks.every((b) => b.adapters.length));
  // 已解析區塊中夾的垃圾行算 I03（有列出），不是問題；每一類都數得到
  const g = unhandledLines('a.txt', 'SW (10.0.0.1):\n### /ip arp print detail\nFlags: X - disabled\n 0 DC address=10.0.0.9 mac-address=AA:BB:CC:00:00:09\n      interface=ether1\nGARBAGE\n');
  assert.deepStrictEqual([g.problems, g.kinds], [[], { structural: 2, fact: 1, ignored: 2, i03: 1, i01: 0 }]);
});
test('範例資料：--faults 刻意放的 I03 被列出（混入 markdown 標記的那一行），其他行不受影響', () => {
  const s = build(read('samples/sample-bundle.txt'));
  const f = i03(s);
  assert.strictEqual(f.length, 1, f.map((x) => x.message).join('\n'));
  assert.deepStrictEqual(f[0].evidence.map((e) => e.text), ['```']);
  assert.ok(gen(['--sites', '1', '--access', '12']).split('\n').every((l) => l.trim() !== '```'), '沒有 --faults 時不放');
});
