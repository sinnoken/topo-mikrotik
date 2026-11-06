// 範例資料的刻意問題、可重現、基準鍵 meta.baselineKey
'use strict';
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { S, ROOT, read, build, count, test } = require('../lib.js');
// ------------------------------------------------------------------ 範例資料：每個刻意放入的問題都要被找到
test('範例資料：每項刻意放入的問題都被找到，且沒有多餘的錯誤', () => {
  const s = build(read('samples/sample-bundle.txt'));
  const expect = { I01: 1, I02: 1, C02: 1, K01: 1, K02: 1, K03: 1, K04: 1, V01: 1, V04: 1, V05: 1, V06: 1, V07: 1, A01: 1, A02: 1, A04: 1, A05: 1,
    A06: 1, A07: 1, A08: 1, A09: 1, A10: 1, A11: 1, A12: 2, R01: 2, R02: 1, R03: 1, R04: 1, R05: 1, R06: 1, R07: 1, R08: 1, R09: 1, R10: 2, R11: 2, R12: 1, R13: 1, R14: 1, R15: 1, C01: 3,
    V08: 1, V09: 1, F01: 1, F02: 1, F03: 2, F04: 1, F05: 1, F06: 1, F07: 2, F08: 1, F10: 1, F11: 1, F12: 1, F13: 1, F14: 1, F15: 1, L01: 1, L02: 1 };
  Object.entries(expect).forEach(([id, n]) => assert.strictEqual(count(s, id), n, `${id} 應有 ${n} 筆，實際 ${count(s, id)}`));
  assert.strictEqual(s.meta.stats.collected, 19); // 含 VRF 的 PE 與 CE 路由器
  // 分支站點：單臂路由的實體埠只靠 VLAN 子介面承載（停用的 VLAN 30 不算），交換器的 PVID 1 不算不一致；LAB 的 bridge 沒有開 vlan-filtering
  const stick = s.model.links.find((l) => l.key === 'TPE_BR_RT_01|ether2~TPE_BR_SW_01|ether1');
  assert.deepStrictEqual([stick.vlansA, stick.vlansB, stick.vlanComparable, stick.vlansDiff], [[10, 20], [1, 10, 20], true, []]);
  assert.ok(!s.findings.some((f) => f.id === 'V01' && f.entities.some((e) => e.key === stick.key)));
  assert.deepStrictEqual(s.findings.find((f) => f.id === 'V09').entities.map((e) => e.key), ['TPE_BR_SW_01|ether2~TPE_LAB_SW_01|ether1', 'TPE_LAB_SW_01|bridge1']);
  const css = s.model.inferredLinks.find((l) => l.a.startsWith('TPE_CSS_01|') || l.b.startsWith('TPE_CSS_01|'));
  assert.ok(css && css.confidence === 'high' && css.bases.join('+') === 'fdb+mndp-unique', '範例的 CSS610 應以 MAC 表＋MNDP 推論到 ACC_06 ether21');
  assert.deepStrictEqual(s.findings.filter((f) => f.severity === 'error').map((f) => f.id).sort(), ['I01']);
  assert.strictEqual(s.findings.find((f) => f.id === 'K02').severity, 'warn', 'K02 是警告：可能是鄰居表過時或中間有非網管型交換器，不一定是資料矛盾');
  s.findings.forEach((f) => f.evidence.forEach((e) => assert.ok(typeof e.text === 'string')));
  const v01 = s.findings.find((f) => f.id === 'V01').entities.find((e) => e.type === 'link');
  assert.strictEqual(s.model.links.find((l) => l.key === v01.key).vlanComparable, true, 'vlanComparable 必須序列化，查詢層才能判斷是否可比對');
});
test('同樣輸入建立兩次，結果完全相同（建立時間除外）', () => {
  const a = build(read('samples/sample-bundle.txt')); const b = build(read('samples/sample-bundle.txt'));
  delete a.meta.timing; delete b.meta.timing;
  assert.deepStrictEqual(a, b);
});
test('建立時間 options.now：必須是 ISO 8601（與處理紀錄、工作包同一個判斷 S.util.isIso），不合法時丟錯，不原樣寫進 meta.createdAt', () => {
  const src = [{ name: 't.txt', text: 'SW_A (10.0.0.1):\n### /system identity print\nname: SW_A\n' }];
  ['xx', '', '2026-01-01 00:00:00', '2026-13-01T00:00:00Z', '01/02/2026'].forEach((now) => {
    assert.throws(() => S.build(src, { now }), (e) => e instanceof RangeError && /now 必須是 ISO 8601/.test(e.message) && e.message.includes(JSON.stringify(now)), now);
  });
  [123, {}, true].forEach((now) => assert.throws(() => S.build(src, { now }), TypeError, String(now)));
  // 合法值原樣寫入（不正規化，與既有基準相同）；省略或 null 時用目前時間（UTC 的 toISOString）
  ['2026-01-01T00:00:00Z', '2026-01-01T08:00:00+08:00', '2026-01-01'].forEach((now) => assert.strictEqual(S.build(src, { now }).meta.createdAt, now));
  [undefined, null].forEach((now) => assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(S.build(src, { now }).meta.createdAt)));
  assert.ok(/Z$/.test(S.build(src).meta.createdAt));
  assert.deepStrictEqual(['2026-01-01T00:00:00Z', '2026-01-01', 'x', 1].map(S.util.isIso), [true, true, false, false]);
  // 不存在的日期與時間（Date.parse 會自動進位）：逐欄比對，不接受
  const bad = ['2026-02-30', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T23:60Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00+24:00', '2026-00-10'];
  assert.deepStrictEqual(bad.map(S.util.isIso), bad.map(() => false));
  assert.deepStrictEqual(['2028-02-29', '2026-12-31T23:59:59.999Z', '2026-01-01T00:00-12:00', '2026-01-01T00:00+14:00'].map(S.util.isIso), [true, true, true, true]);
  bad.slice(0, 2).forEach((now) => assert.throws(() => S.build(src, { now }), RangeError, now));
});
test('可重現：時區（TZ）與語系（LANG／LC_ALL）不同時，範例基準除 meta.createdAt、meta.timing 外完全相同', () => {
  // 子行程：環境變數只在行程啟動時生效。不傳 now，同時驗證 createdAt 一律是 UTC
  const script = `const S = require(${JSON.stringify(path.join(ROOT, 'tests/load.js'))})();
    const s = S.build([{ name: 'sample-bundle.txt', text: require('fs').readFileSync(${JSON.stringify(path.join(ROOT, 'samples/sample-bundle.txt'))}, 'utf8') }]);
    const o = Intl.DateTimeFormat().resolvedOptions();
    process.stdout.write(JSON.stringify({ tz: o.timeZone, locale: o.locale, snap: s }));`;
  const envs = [
    { TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }, { TZ: 'Asia/Taipei', LANG: 'C', LC_ALL: 'C' },
    { TZ: 'UTC', LANG: 'zh_TW.UTF-8', LC_ALL: 'zh_TW.UTF-8' }, { TZ: 'Asia/Taipei', LANG: 'zh_TW.UTF-8', LC_ALL: 'zh_TW.UTF-8' },
  ];
  const runs = envs.map((e) => JSON.parse(execFileSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, e), encoding: 'utf8', maxBuffer: 5e8 })));
  // 環境確實生效（否則這個測試沒有意義）
  assert.deepStrictEqual(runs.map((r) => r.tz), envs.map((e) => e.TZ));
  assert.notStrictEqual(runs[0].locale, runs[2].locale, `語系應不同：${runs.map((r) => r.locale).join('、')}`);
  runs.forEach((r) => {
    assert.ok(/Z$/.test(r.snap.meta.createdAt), r.snap.meta.createdAt);
    delete r.snap.meta.createdAt; delete r.snap.meta.timing;
  });
  runs.slice(1).forEach((r, i) => assert.ok(JSON.stringify(r.snap) === JSON.stringify(runs[0].snap), `${JSON.stringify(envs[i + 1])} 與 ${JSON.stringify(envs[0])} 的基準不同`));
});
test('可重現：來源檔案的順序反過來時，模型（去掉來源位置）與 findings（訊息、entities、代表證據）完全相同', () => {
  // 範例資料依設備標頭拆成多個檔案（開頭的註解併入第一個檔案）
  const parts = [];
  read('samples/sample-bundle.txt').split('\n').forEach((l) => {
    const m = /^([A-Za-z0-9_.-]+) \([0-9.]+\):$/.exec(l);
    if (m || !parts.length) parts.push({ name: (m ? m[1] : 'head') + '.txt', lines: [] });
    parts[parts.length - 1].lines.push(l);
  });
  const src = parts.map((p) => ({ name: p.name, text: p.lines.join('\n') + '\n' }));
  assert.ok(src.length >= 10, `應拆成多個檔案，實際 ${src.length}`);
  const a = S.build(src, { now: '2026-01-01T00:00:00Z' }); const b = S.build(src.slice().reverse(), { now: '2026-01-01T00:00:00Z' });
  const Qa = S.query(a); const Qb = S.query(b);
  // 可變：輸入指紋與基準鍵（順序有意義，見 S.inputHashOf）、meta.sources 與 blocks 的順序、區塊編號
  assert.notStrictEqual(a.meta.inputHash, b.meta.inputHash);
  assert.deepStrictEqual(b.meta.sources.map((x) => x.name), src.map((x) => x.name).reverse());
  // 不可變：去掉來源位置（src／srcNone 與 firewallStats 的 reason.row，內容是 [區塊編號, 行號]）後，模型的每個集合連順序都相同
  const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'src' || k === 'srcNone' || k === 'row' || k === 'block' ? undefined : x)));
  assert.ok(JSON.stringify(strip(a.model)) === JSON.stringify(strip(b.model)), '去掉來源位置後模型應相同');
  assert.deepStrictEqual(b.coverage, a.coverage);
  assert.deepStrictEqual(b.meta.stats, a.meta.stats);
  // 不可變：findings 的 findingKey 依序相同；訊息、entities（連順序）、證據（檔案、行號與原文，連順序）也完全相同。
  // 同一個問題涉及多台設備時（A01 的 MAC、K02 的鄰居）依設備名稱與介面排序列舉，鏈路類 finding 的代表證據固定取鏈路 a 端那一側
  assert.deepStrictEqual(b.findings.map((f) => Qb.findingKey(f)), a.findings.map((f) => Qa.findingKey(f)));
  const view = (f) => ({ id: f.id, severity: f.severity, message: f.message, entities: f.entities, facet: f.facet, deviation: f.deviation,
    evidence: f.evidence.map((e) => [e.file, e.line, e.text]) });
  b.findings.forEach((f, i) => assert.deepStrictEqual(view(f), view(a.findings[i]), `${f.id}：${a.findings[i].message}`));
});
test('鏈路配對：聚合成員雙向確認、沒有 LLDP 的鄰居為單側觀察', () => {
  const s = build(read('samples/sample-bundle.txt'));
  const l = s.model.links.find((x) => x.key === 'TPE_ACC_SW_01|sfp-sfpplus1~TPE_CORE_RT_01|sfp-sfpplus1');
  assert.ok(l && l.verified && l.cls === 'lag', JSON.stringify(l));
  assert.strictEqual(s.model.links.length, 81, 'OSPF adjacencies no longer count as direct topology links（81 含範例中 CSS610 的 MNDP 鏈路、分支站點的兩條與 PE－CE 的一條）');
  const ap = s.model.links.find((x) => x.key.includes('TPE_AP_01'));
  assert.ok(ap && ap.hearsay);
});

test('基準鍵 meta.baselineKey：由 inputHash、major.minor 版本、命名規則與預期資料組成；不含建立時間，鍵的順序不影響', () => {
  const text = read('samples/sample-bundle.txt');
  const prof = { id: 't', classify: [{ match: '_FW_', kind: 'firewall' }] };
  const key = (opt) => S.build([{ name: 't.txt', text }], Object.assign({ now: '2026-01-01T00:00:00Z' }, opt)).meta;
  const base = key();
  assert.ok(/^[0-9a-f]{16}$/.test(base.baselineKey) && base.baselineKey !== base.inputHash, base.baselineKey);
  const ver = S.VERSION.split('.').slice(0, 2).join('.');
  assert.strictEqual(base.baselineKey, S.util.hash(JSON.stringify([base.inputHash, ver, null, null])), '定義：[inputHash, major.minor, profileHash, expectedDataHash]');
  assert.strictEqual(key({ now: '2027-06-01T00:00:00Z' }).baselineKey, base.baselineKey, '建立時間不影響');
  const named = key({ profile: prof });
  assert.deepStrictEqual([named.inputHash === base.inputHash, named.baselineKey === base.baselineKey], [true, false], '換命名規則：輸入指紋不變、基準鍵不同');
  assert.strictEqual(key({ profile: { classify: prof.classify, id: 't' } }).baselineKey, named.baselineKey, '命名規則的鍵順序不影響');
  assert.notStrictEqual(key({ profile: { id: 't', classify: [{ match: '_RT_', kind: 'firewall' }] } }).baselineKey, named.baselineKey, '同一個 id 與 version、內容不同的命名規則要區分');
  const exp = key({ expectedData: { switch: ['lldp'], router: ['route'] } });
  assert.deepStrictEqual([exp.inputHash === base.inputHash, exp.baselineKey === base.baselineKey], [true, false], '換預期資料：基準鍵不同');
  assert.strictEqual(key({ expectedData: { router: ['route'], switch: ['lldp'] } }).baselineKey, exp.baselineKey, '預期資料的鍵順序不影響');
});

test('輸入指紋：S.inputHashOf 與 meta.inputHash 相同（不重建也能核對）；meta.sources 的 bytes、hash 依各檔文字計算', () => {
  const a = read('samples/sample-bundle.txt');
  const cases = [
    [{ name: 'a.txt', text: a }],
    [{ text: a }], // 沒有名稱：inputHash 以空字串計算，meta.sources 的 name 是 S.readers.PASTE
    [{ name: 'x.txt', text: 'SW_A (10.0.0.1):\n### /system identity print\nname: SW_A\n' }, { name: 'y.txt', text: 'SW_B (10.0.0.2):\n### /system identity print\nname: SW_B\n' }],
  ];
  cases.forEach((src) => {
    const s = S.build(src, { now: '2026-01-01T00:00:00Z' });
    assert.strictEqual(S.inputHashOf(src), s.meta.inputHash);
    assert.deepStrictEqual(s.meta.sources.map((x) => [x.name, x.bytes, x.hash]), src.map((x) => [x.name || S.readers.PASTE, x.text.length, S.util.hash(x.text)]));
    assert.ok(s.meta.sources.every((x) => typeof x.reader === 'string' || x.reader === null));
  });
  assert.notStrictEqual(S.inputHashOf([{ text: a }]), S.inputHashOf([{ name: S.readers.PASTE, text: a }]), '沒有名稱與名稱為 PASTE 的指紋不同（與 2.9.0 之前相同）');
  const two = cases[2];
  assert.notStrictEqual(S.inputHashOf(two), S.inputHashOf(two.slice().reverse()), '順序有意義');
  [null, 'x', [{}], [{ name: 'a', text: 1 }], [null]].forEach((bad) => assert.throws(() => S.inputHashOf(bad), TypeError, JSON.stringify(bad)));
});
// ------------------------------------------------------------------ 用字：核心產生給人看的文字不用已淘汰的說法
test('用字：檢查目錄的標題、常見原因、處理與範例資料的 finding 訊息、群名不出現已淘汰的說法', () => {
  // 畫面層另有 tests/ui-smoke.js 的淘汰用詞檢查；這裡只管核心產生、會原樣顯示在畫面與匯出的文字
  const RETIRED = { 未管理交換器: '非網管型交換器', 自動群組: '分群', 推定偏離: '與多數不同', 未知對端: '未識別的終端' };
  const hits = [];
  const scan = (where, t) => Object.keys(RETIRED).filter((w) => String(t || '').includes(w)).forEach((w) => hits.push(`${where}：「${w}」→「${RETIRED[w]}」`));
  Object.entries(S.check.CATALOG).forEach(([id, c]) => { scan(id + ' 標題', c.title); (c.causes || []).forEach((x) => scan(id + ' 常見原因', x)); scan(id + ' 處理', c.action); });
  const s = build(read('samples/sample-bundle.txt'));
  s.findings.forEach((f) => { scan(f.id + ' 訊息', f.message); scan(f.id + ' 標題', f.title); });
  s.model.devices.forEach((d) => scan(d.key + ' 群名', d.group));
  assert.ok(s.model.devices.some((d) => /^分群 \d+$/.test(d.group || '')), '範例資料應有自動分群的設備（「分群 N」）');
  assert.deepStrictEqual(hits, []);
});
