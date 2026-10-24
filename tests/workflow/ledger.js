// 處理紀錄（S.ledger）
'use strict';
const assert = require('assert');
const { S, read, build, test } = require('../lib.js');
// ------------------------------------------------------------------ 處理紀錄（ssot-ledger/1，不屬於 Snapshot）
// 三輪：① 範例 ② 刪掉 F06 那條規則、檔頭多一行雜訊（新的 I01）③ 範例加一行註解（內容同 ①、inputHash 不同）
const LEDGER = (() => {
  const text = read('samples/sample-bundle.txt');
  const lines = text.split('\n');
  const f06 = lines.findIndex((l) => l.includes('chain=input protocol=udp src-port=53'));
  const q = (t) => S.query(build(t));
  return {
    q1: () => q(text),
    q2: () => q('雜訊行\n' + lines.filter((_, i) => i !== f06).join('\n')),
    q3: () => q('# 第三輪\n' + text),
    keyOf: (Q, id) => Q.findings().filter((f) => f.id === id).map(Q.findingKey)[0],
  };
})();
/** 跑完整的三輪，回傳每一輪的結果與用到的鍵 */
function ledgerRounds() {
  const L = S.ledger; const q1 = LEDGER.q1(); const q2 = LEDGER.q2(); const q3 = LEDGER.q3();
  const k = { F06: LEDGER.keyOf(q1, 'F06'), R03: LEDGER.keyOf(q1, 'R03'), F01: LEDGER.keyOf(q1, 'F01'), A04: LEDGER.keyOf(q1, 'A04'), I01new: LEDGER.keyOf(q2, 'I01') };
  const r1 = L.advance(L.empty(), q1, { now: '2026-01-01T00:00:00Z' });
  let lg = L.set(r1.ledger, k.F06, { status: 'scheduled', patch: 'patch:F06' }, { now: '2026-01-02T00:00:00Z' });
  lg = L.set(lg, k.R03, { status: 'accepted', waiver: { reason: '實驗室路由', until: '2026-02-01' } }, { now: '2026-01-02T00:00:00Z' });
  lg = L.set(lg, k.F01, { status: 'false-positive', note: '廠商專用' }, { now: '2026-01-02T00:00:00Z' });
  const r2 = L.advance(lg, q2, { now: '2026-01-15T00:00:00Z' });
  const r3 = L.advance(r2.ledger, q3, { now: '2026-03-01T00:00:00Z' });
  return { q1, q2, q3, k, r1, r2, r3 };
}
test('處理紀錄：三輪推進判定新增、fixed、regressed、豁免到期，誤報不變', () => {
  const { q1, q2, q3, k, r1, r2, r3 } = ledgerRounds();
  const nKeys = new Set(q1.findings().map(q1.findingKey)).size;
  assert.ok(k.I01new && !q1.findings().some((f) => q1.findingKey(f) === k.I01new), '第二輪要有第一輪沒有的 I01');
  assert.ok(!q2.findings().some((f) => f.id === 'F06'), '第二輪刪掉了 F06 的規則');
  // ① 全部新增為 open
  assert.strictEqual(r1.changes.length, nKeys);
  assert.ok(r1.changes.every((c) => c.from === null && c.to === 'open' && c.reason === 'new'));
  assert.deepStrictEqual(r1.ledger.iterations[0].counts, { new: nKeys, fixed: 0, open: nKeys, scheduled: 0, regressed: 0, accepted: 0, falsePositive: 0, waiverExpired: 0, unobserved: 0 });
  const unknown = q1.unknownDevices().reduce((n, d) => n + q1.unknownPeers(d).length, 0);
  const c01 = q1.findings().filter((f) => f.id === 'C01').length;
  assert.deepStrictEqual([r1.ledger.iterations[0].coverage, r1.ledger.iterations[0].unknownPeers],
    [{ collected: q1.meta().stats.collected, expected: q1.meta().stats.collected + c01 }, unknown]);
  assert.deepStrictEqual(r1.ledger.iterations[0].baseline, { inputHash: q1.meta().inputHash, baselineKey: q1.meta().baselineKey, createdAt: '2026-01-01T00:00:00Z' });
  const f06 = r1.ledger.items[k.F06];
  assert.deepStrictEqual([f06.status, f06.id, f06.dev, f06.firstSeen, f06.lastSeen], ['open', 'F06', 'TPE_CORE_RT_02', q1.meta().baselineKey, q1.meta().baselineKey]);
  // ② 排程的 F06 消失 → fixed；新的 I01 → open；豁免未到期、誤報不變
  assert.deepStrictEqual(r2.changes.map((c) => [c.key, c.from, c.to, c.reason]), [[k.F06, 'scheduled', 'fixed', 'disappeared'], [k.I01new, null, 'open', 'new']].sort((a, b) => S.util.cmp(a[0], b[0])));
  assert.strictEqual(r2.ledger.items[k.F06].lastSeen, q1.meta().baselineKey, 'F06 最後出現在第一輪');
  assert.strictEqual(r2.ledger.items[k.F06].patch, 'patch:F06');
  assert.deepStrictEqual(['R03', 'F01'].map((id) => r2.ledger.items[k[id]].status), ['accepted', 'false-positive']);
  assert.strictEqual(r2.ledger.items[k.A04].lastSeen, q2.meta().baselineKey);
  assert.deepStrictEqual([r2.ledger.iterations[1].counts.new, r2.ledger.iterations[1].counts.fixed, r2.ledger.iterations[1].counts.accepted, r2.ledger.iterations[1].counts.falsePositive], [1, 1, 1, 1]);
  // ③ F06 再出現 → regressed；I01 消失 → fixed；R03 豁免到期 → open，原本的豁免記在歷程
  assert.deepStrictEqual(r3.changes.map((c) => [c.key, c.from, c.to, c.reason]), [
    [k.F06, 'fixed', 'regressed', 'reappeared'], [k.I01new, 'open', 'fixed', 'disappeared'], [k.R03, 'accepted', 'open', 'waiver-expired']].sort((a, b) => S.util.cmp(a[0], b[0])));
  const r03 = r3.ledger.items[k.R03];
  assert.deepStrictEqual([r03.status, r03.waiver], ['open', null]);
  assert.deepStrictEqual(r03.history[r03.history.length - 1], { at: '2026-03-01T00:00:00.000Z', from: 'accepted', to: 'open', by: 'advance', baseline: q3.meta().baselineKey, reason: 'waiver-expired',
    waiver: { reason: '實驗室路由', until: '2026-02-01T00:00:00.000Z' } });
  assert.deepStrictEqual(r3.ledger.items[k.F06].history.map((h) => [h.from, h.to, h.by]), [[null, 'open', 'advance'], ['open', 'scheduled', 'user'], ['scheduled', 'fixed', 'advance'], ['fixed', 'regressed', 'advance']]);
  assert.strictEqual(r3.ledger.items[k.F01].status, 'false-positive');
  const c3 = r3.ledger.iterations[2].counts;
  assert.deepStrictEqual([c3.new, c3.fixed, c3.regressed, c3.waiverExpired, c3.accepted, c3.falsePositive, c3.open], [0, 1, 1, 1, 0, 1, nKeys - 2]);
  // 統計
  const sum = S.ledger.summary(r3.ledger);
  assert.deepStrictEqual(sum.series.map((p) => p.pending), [nKeys, nKeys - 2, nKeys - 1]);
  assert.deepStrictEqual(sum.current.byStatus, { open: nKeys - 2, scheduled: 0, fixed: 1, accepted: 0, 'false-positive': 1, regressed: 1 });
  const f01 = S.ledger.ruleStats(r3.ledger).find((r) => r.id === 'F01');
  assert.deepStrictEqual([f01.total, f01.falsePositive, f01.rate], [1, 1, 1]);
  assert.ok(S.ledger.validate(r3.ledger).ok, S.ledger.validate(r3.ledger).errors.join('\n'));
});
test('處理紀錄：同一份基準重複推進是冪等的；結果可重現、不修改傳入的資料與 Snapshot', () => {
  const L = S.ledger; const a = ledgerRounds(); const b = ledgerRounds();
  assert.strictEqual(JSON.stringify(a.r3), JSON.stringify(b.r3), '同樣的輸入與 now 要得到完全相同的結果');
  const before = JSON.stringify(a.r3.ledger); const snapBefore = JSON.stringify(a.q3.snapshot);
  [a.q3, a.q1, a.q2].forEach((q) => {
    const again = L.advance(a.r3.ledger, q, { now: '2026-04-01T00:00:00Z' });
    assert.deepStrictEqual([again.skipped, again.changes, again.unobserved], [true, [], []]);
    assert.strictEqual(JSON.stringify(again.ledger), before, '已推進過的基準不新增一輪、不寫 history');
  });
  assert.strictEqual(JSON.stringify(a.r3.ledger), before, '傳入的 ledger 不被修改');
  assert.strictEqual(JSON.stringify(a.q3.snapshot), snapBefore, 'Snapshot 不被修改');
  // set 沒有任何改變時不寫 history
  const same = L.set(a.r3.ledger, a.k.F01, { status: 'false-positive', note: '廠商專用' }, { now: '2026-04-01T00:00:00Z' });
  assert.strictEqual(JSON.stringify(same), before);
});
test('處理紀錄：設備收集失敗時，消失的問題不判為 fixed（unobserved）', () => {
  const L = S.ledger; const q1 = LEDGER.q1(); const q2 = LEDGER.q2();
  const k = LEDGER.keyOf(q1, 'F06');
  const r1 = L.advance(L.empty(), q1, { now: '2026-01-01T00:00:00Z' });
  // 第二輪假設 TPE_CORE_RT_02 有一個指令收集失敗：F06 消失可能只是沒收到資料
  const failed = Object.assign({}, q2, { coverage: () => q2.coverage().map((r) => (r.dev === 'TPE_CORE_RT_02' ? Object.assign({}, r, { failures: [{ reason: 'timeout' }] }) : r)) });
  const r2 = L.advance(r1.ledger, failed, { now: '2026-01-15T00:00:00Z' });
  assert.strictEqual(r2.ledger.items[k].status, 'open');
  assert.ok(r2.unobserved.includes(k));
  assert.ok(!r2.changes.some((c) => c.key === k));
  assert.strictEqual(r2.ledger.iterations[1].counts.unobserved, r2.unobserved.length);
  // 不屬於任何設備的問題（第二輪新增的 I01）：基準中有任何收集失敗時也不判斷
  const kI01 = LEDGER.keyOf(q2, 'I01');
  const r3 = L.advance(r2.ledger, Object.assign({}, LEDGER.q1(), { coverage: failed.coverage, meta: () => ({ inputHash: 'h3', createdAt: null }) }), { now: '2026-02-01T00:00:00Z' });
  assert.deepStrictEqual([r3.ledger.items[kI01].status, r3.unobserved.includes(kI01)], ['open', true]);
  assert.deepStrictEqual(S.ledger.devicesOfKey('["A01","ip:10.1.30.11","mac:10BF48000008"]'), []);
  assert.deepStrictEqual(S.ledger.devicesOfKey('["K01","link:SW_B|ether24~R_A|ether2"]'), ['R_A', 'SW_B']);
  // 可以判斷時同一輪就是 fixed
  assert.strictEqual(L.advance(r1.ledger, q2, { now: '2026-01-15T00:00:00Z' }).ledger.items[k].status, 'fixed');
});
test('處理紀錄：不屬於任何設備的問題（A01）依證據所在區塊的設備判斷；換成另一個網路時列為 unobserved，不判為 fixed、之後也不是 regressed', () => {
  const L = S.ledger; const text = read('samples/sample-bundle.txt');
  const q1 = S.query(build(text));
  const kA01 = LEDGER.keyOf(q1, 'A01');
  assert.deepStrictEqual(L.devicesOfKey(kA01), [], 'A01 的實體只有 IP 與 MAC');
  const r1 = L.advance(L.empty(), q1, { now: '2026-01-01T00:00:00Z' });
  // 證據所在區塊的設備記在項目的 devs；findingKey 本身有設備的項目不記
  assert.deepStrictEqual(r1.ledger.items[kA01].devs, ['TPE_CORE_RT_01', 'TPE_CORE_RT_02']);
  assert.ok(!('devs' in r1.ledger.items[LEDGER.keyOf(q1, 'F06')]));
  // 完全不同的網路：A01 的設備不在基準中 → unobserved
  const edge = S.query(build('EDGE_RT (10.9.0.1):\n### /ip arp print detail without-paging\n 0 DC address=10.9.0.2 mac-address=AA:BB:CC:00:00:01 interface=ether1\n'));
  const r2 = L.advance(r1.ledger, edge, { now: '2026-01-15T00:00:00Z' });
  assert.deepStrictEqual([r2.ledger.items[kA01].status, r2.unobserved.includes(kA01), r2.changes.some((c) => c.key === kA01)], ['open', true, false]);
  // 再回到範例：A01 仍是 open，不是 regressed
  const r3 = L.advance(r2.ledger, S.query(build('# 第三輪\n' + text)), { now: '2026-02-01T00:00:00Z' });
  assert.deepStrictEqual([r3.ledger.items[kA01].status, r3.changes.filter((c) => c.key === kA01)], ['open', []]);
  // 相關設備都已收集、沒有失敗，而且衝突的 ARP 項目不見了 → fixed
  const lines = text.split('\n');
  const conflict = lines.findIndex((l) => l.includes('address=10.1.30.11 mac-address=6C:FE:54:00:00:A1'));
  const gone = S.query(build(lines.filter((_, i) => i !== conflict).join('\n')));
  assert.ok(!gone.findings().some((f) => f.id === 'A01'));
  const fixed = L.advance(r1.ledger, gone, { now: '2026-01-15T00:00:00Z' });
  assert.deepStrictEqual(fixed.changes.filter((c) => c.key === kA01).map((c) => [c.from, c.to, c.reason]), [['open', 'fixed', 'disappeared']]);
  // 其中一台設備收集失敗 → unobserved
  const failed = Object.assign({}, gone, { coverage: () => gone.coverage().map((r) => (r.dev === 'TPE_CORE_RT_02' ? Object.assign({}, r, { failures: [{ reason: 'timeout' }] }) : r)) });
  assert.ok(L.advance(r1.ledger, failed, { now: '2026-01-15T00:00:00Z' }).unobserved.includes(kA01));
  // 舊紀錄（沒有 devs）：推不出設備，保守列為 unobserved；再出現時補上 devs
  const legacy = JSON.parse(JSON.stringify(r1.ledger)); delete legacy.items[kA01].devs;
  assert.ok(L.validate(legacy).ok);
  const lr = L.advance(legacy, gone, { now: '2026-01-15T00:00:00Z' });
  assert.deepStrictEqual([lr.ledger.items[kA01].status, lr.unobserved.includes(kA01)], ['open', true]);
  assert.deepStrictEqual(L.advance(legacy, S.query(build('# 再一次\n' + text)), { now: '2026-01-15T00:00:00Z' }).ledger.items[kA01].devs, ['TPE_CORE_RT_01', 'TPE_CORE_RT_02']);
  // devs 的格式
  const bad = JSON.parse(JSON.stringify(r1.ledger)); bad.items[kA01].devs = ['TPE_CORE_RT_01', 3];
  assert.ok(L.validate(bad).errors.some((e) => /\.devs：/.test(e)), L.validate(bad).errors.join('\n'));
});
test('處理紀錄：set 寫入歷程、accepted 預設豁免半年，不合法的轉換丟出錯誤', () => {
  const L = S.ledger; const { q1, k, r1, r3 } = ledgerRounds();
  const now = { now: '2026-01-02T00:00:00Z' };
  const lg = L.set(r1.ledger, k.A04, { status: 'accepted', waiver: { reason: '交換器在機櫃內' }, note: '已知' }, now);
  const it = lg.items[k.A04];
  assert.deepStrictEqual([it.status, it.waiver, it.note], ['accepted', { reason: '交換器在機櫃內', until: '2026-07-03T00:00:00.000Z' }, '已知']);
  assert.deepStrictEqual(it.history[1], { at: '2026-01-02T00:00:00.000Z', from: 'open', to: 'accepted', by: 'user', baseline: q1.meta().baselineKey, reason: null });
  // 修改原因（狀態不變）也寫一筆歷程，舊的豁免保留在歷程
  const lg2 = L.set(lg, k.A04, { waiver: { reason: '新原因', until: '2026-12-31' } }, now);
  assert.deepStrictEqual(lg2.items[k.A04].history[2].reason, 'edit');
  assert.deepStrictEqual(lg2.items[k.A04].history[2].waiver, it.waiver);
  // 離開 accepted 時清掉豁免，記在歷程
  const lg3 = L.set(lg2, k.A04, { status: 'scheduled' }, now);
  assert.deepStrictEqual([lg3.items[k.A04].waiver, lg3.items[k.A04].history[3].waiver.reason], [null, '新原因']);
  const bad = (fn, re) => assert.throws(fn, re);
  bad(() => L.set(r1.ledger, k.A04, { status: 'accepted' }, now), /waiver/);
  bad(() => L.set(r1.ledger, k.A04, { status: 'accepted', waiver: { reason: 'x', until: '2025-12-31' } }, now), /必須晚於 now/);
  bad(() => L.set(r1.ledger, k.A04, { status: 'scheduled', waiver: { reason: 'x' } }, now), /只有 accepted/);
  bad(() => L.set(r1.ledger, k.A04, { status: 'regressed' }, now), /regressed 只由 advance/);
  bad(() => L.set(r1.ledger, k.A04, { status: 'fixed' }, now), /仍出現在最新一輪/);
  bad(() => L.set(r1.ledger, k.A04, { status: 'done' }, now), /不認得的狀態/);
  bad(() => L.set(r1.ledger, '["Z99"]', { status: 'open' }, now), /沒有這個項目/);
  bad(() => L.set(r1.ledger, k.A04, { status: 'open' }, {}), /now/);
  bad(() => L.set(r1.ledger, k.A04, { note: 3 }, now), /note/);
  // fixed 只由 advance 判定，使用者不能改狀態；不在最新一輪的項目可以手動標 fixed
  bad(() => L.set(r3.ledger, k.I01new, { status: 'open' }, now), /不能由 fixed 手動改為 open/);
  assert.strictEqual(L.set(r3.ledger, k.I01new, { note: '已確認' }, now).items[k.I01new].note, '已確認');
  const gone = L.advance(L.set(r1.ledger, k.F06, { status: 'scheduled' }, now), LEDGER.q2(), { now: '2026-01-15T00:00:00Z' });
  assert.strictEqual(gone.ledger.items[k.F06].status, 'fixed');
  assert.throws(() => L.advance(L.empty(), q1, { now: 'yesterday' }), /now 必須是 ISO 8601/);
});
test('處理紀錄：fromAcks 依分類轉換舊確認標記，保留原始紀錄並推進一輪', () => {
  const L = S.ledger; const q1 = LEDGER.q1();
  const k = (id) => LEDGER.keyOf(q1, id);
  const acks = {
    [k('A04')]: { at: '2025-06-01T08:00:00.000Z', kind: 'accepted', note: ' 監控用交換器 ' },
    [k('F06')]: { at: '2025-06-02T08:00:00.000Z', kind: 'scheduled', note: '' },
    [k('F01')]: { at: '2025-06-03T08:00:00.000Z', kind: 'false-positive', note: '' },
    [k('R03')]: { at: '2025-06-04T08:00:00.000Z', kind: null, note: '' },
    [k('R01')]: { at: '2025-06-05T08:00:00.000Z', kind: 'later-kind', note: '', extra: 1 },
    '["C02","device:GONE_SW"]': { at: '2025-06-06T08:00:00.000Z', kind: 'scheduled', note: '' },
  };
  const r = L.fromAcks(acks, q1, { now: '2026-01-01T00:00:00Z' });
  const st = (key) => r.ledger.items[key].status;
  assert.deepStrictEqual(['A04', 'F06', 'F01', 'R03', 'R01'].map((id) => st(k(id))), ['accepted', 'scheduled', 'false-positive', 'accepted', 'accepted']);
  assert.deepStrictEqual(r.ledger.items[k('A04')].waiver, { reason: '監控用交換器', until: '2026-07-02T00:00:00.000Z' });
  assert.deepStrictEqual(r.ledger.items[k('R01')].history[0], { at: '2025-06-05T08:00:00.000Z', from: null, to: 'accepted', by: 'user', baseline: null, reason: 'from-ack',
    ack: { at: '2025-06-05T08:00:00.000Z', kind: 'later-kind', note: '', extra: 1 } });
  assert.strictEqual(r.ledger.items[k('F06')].firstSeen, q1.meta().baselineKey, '推進後補上 firstSeen');
  // 不在基準中、設備也不在基準中的排程項目：無法判斷，維持 scheduled
  assert.deepStrictEqual([st('["C02","device:GONE_SW"]'), r.unobserved], ['scheduled', ['["C02","device:GONE_SW"]']]);
  // 其他 finding 新增為 open；轉換結果可以通過驗證
  assert.strictEqual(r.ledger.iterations.length, 1);
  assert.strictEqual(r.changes.filter((c) => c.reason === 'new').length, new Set(q1.findings().map(q1.findingKey)).size - 5);
  assert.ok(L.validate(r.ledger).ok);
  // Map 也可以；格式不對的確認標記全部列出並丟錯
  assert.strictEqual(JSON.stringify(L.fromAcks(new Map(Object.entries(acks)), q1, { now: '2026-01-01T00:00:00Z' })), JSON.stringify(r));
  assert.throws(() => L.fromAcks({ 'not-json': { at: '2025-01-01T00:00:00Z' }, '["A04"]': { at: 5 } }, q1, { now: '2026-01-01T00:00:00Z' }),
    (e) => /2 筆格式不正確/.test(e.message) && /acks\[not-json\]/.test(e.message) && /acks\[\["A04"\]\]\.at/.test(e.message));
});

/** 以指定的 S.VERSION 建立基準（只在這個呼叫內改版本號，結束後還原） */
function buildAtVersion(version, text, opt) {
  const keep = S.VERSION; S.VERSION = version;
  try { return S.build([{ name: 't.txt', text }], Object.assign({ now: '2026-01-01T00:00:00Z' }, opt)); } finally { S.VERSION = keep; }
}
test('處理紀錄：依 baselineKey 判斷冪等；換命名規則或 minor 版本會推進一輪，只差 patch 版本不推進', () => {
  const L = S.ledger; const text = read('samples/sample-bundle.txt');
  const [maj, min] = S.VERSION.split('.').map(Number);
  const q = (v, opt) => S.query(buildAtVersion(v, text, opt));
  const base = q(`${maj}.${min}.0`);
  const r1 = L.advance(L.empty(), base, { now: '2026-01-01T00:00:00Z' });
  assert.deepStrictEqual(r1.ledger.iterations[0].baseline, { inputHash: base.meta().inputHash, baselineKey: base.meta().baselineKey, createdAt: '2026-01-01T00:00:00Z' });
  const any = Object.values(r1.ledger.items)[0];
  assert.deepStrictEqual([any.firstSeen, any.lastSeen, any.history[0].baseline], [base.meta().baselineKey, base.meta().baselineKey, base.meta().baselineKey]);
  // 冪等：同一個基準鍵（重新建立、建立時間不同）不推進
  assert.strictEqual(L.advance(r1.ledger, S.query(buildAtVersion(`${maj}.${min}.0`, text, { now: '2027-01-01T00:00:00Z' })), { now: '2026-02-01T00:00:00Z' }).skipped, true);
  // 只差 patch 版本：基準鍵相同，不推進
  const patch = q(`${maj}.${min}.9`);
  assert.strictEqual(patch.meta().baselineKey, base.meta().baselineKey);
  assert.strictEqual(L.advance(r1.ledger, patch, { now: '2026-02-01T00:00:00Z' }).skipped, true);
  // minor 版本不同：推進一輪（inputHash 相同），之後同一個基準鍵冪等
  const minor = q(`${maj}.${min + 1}.0`);
  assert.strictEqual(minor.meta().inputHash, base.meta().inputHash);
  const r2 = L.advance(r1.ledger, minor, { now: '2026-02-01T00:00:00Z' });
  assert.deepStrictEqual([r2.skipped, r2.changes, r2.ledger.iterations.length], [false, [], 2], '內容相同，推進一輪但沒有變化');
  assert.strictEqual(L.advance(r2.ledger, minor, { now: '2026-03-01T00:00:00Z' }).skipped, true);
  // 同一份輸入換命名規則：推進一輪
  const named = q(`${maj}.${min}.0`, { profile: { id: 't', classify: [{ match: '_FW_', kind: 'firewall' }] } });
  const r3 = L.advance(r1.ledger, named, { now: '2026-02-01T00:00:00Z' });
  assert.deepStrictEqual([r3.skipped, r3.ledger.iterations.map((r) => r.baseline.inputHash === base.meta().inputHash)], [false, [true, true]]);
  assert.ok(L.validate(r3.ledger).ok, L.validate(r3.ledger).errors.join('\n'));
  assert.ok(L.validate(r2.ledger).ok, L.validate(r2.ledger).errors.join('\n'));
  // 仍出現在最新一輪的項目不能手動標為 fixed（比較 lastSeen 與最新一輪的基準鍵）
  const f06 = LEDGER.keyOf(minor, 'F06');
  assert.strictEqual(r2.ledger.items[f06].lastSeen, minor.meta().baselineKey);
  assert.throws(() => L.set(r2.ledger, f06, { status: 'fixed' }, { now: '2026-02-02T00:00:00Z' }), /仍出現在最新一輪/);
  assert.strictEqual(L.set(r2.ledger, f06, { status: 'scheduled' }, { now: '2026-02-02T00:00:00Z' }).items[f06].history[1].baseline, minor.meta().baselineKey);
});
test('處理紀錄：舊格式（沒有 baselineKey，以 inputHash 記錄）退回用 inputHash 判斷，推進與手動變更的結果與新格式相同', () => {
  const L = S.ledger; const { q1, q2, k } = ledgerRounds();
  const h1 = q1.meta().inputHash; const b1 = q1.meta().baselineKey;
  const r1 = L.advance(L.empty(), q1, { now: '2026-01-01T00:00:00Z' });
  // 改成舊格式：iterations 沒有 baselineKey，firstSeen／lastSeen／history 記的是 inputHash
  const legacy = JSON.parse(JSON.stringify(r1.ledger).split(b1).join(h1));
  legacy.iterations.forEach((r) => { delete r.baseline.baselineKey; });
  assert.ok(!JSON.stringify(legacy).includes(b1) && L.validate(legacy).ok, L.validate(legacy).errors.join('\n'));
  // 手動變更：最新一輪退回用 inputHash，仍能判斷「還在最新一輪」
  assert.throws(() => L.set(legacy, k.F06, { status: 'fixed' }, { now: '2026-01-02T00:00:00Z' }), /仍出現在最新一輪/);
  assert.strictEqual(L.set(legacy, k.F06, { status: 'scheduled' }, { now: '2026-01-02T00:00:00Z' }).items[k.F06].history[1].baseline, h1);
  // 推進另一份輸入：判定與新格式相同；新的一輪記 baselineKey，舊的一輪不改
  const neu = L.advance(r1.ledger, q2, { now: '2026-01-15T00:00:00Z' });
  const old = L.advance(legacy, q2, { now: '2026-01-15T00:00:00Z' });
  assert.deepStrictEqual(old.changes, neu.changes);
  assert.deepStrictEqual(old.ledger.iterations.map((r) => r.baseline), [{ inputHash: h1, createdAt: '2026-01-01T00:00:00Z' }, neu.ledger.iterations[1].baseline]);
  assert.strictEqual(old.ledger.items[k.F06].lastSeen, h1, '沒出現的項目保留舊的 inputHash');
  assert.strictEqual(old.ledger.items[k.A04].lastSeen, q2.meta().baselineKey);
  assert.ok(L.validate(old.ledger).ok, L.validate(old.ledger).errors.join('\n'));
  // 舊的一輪只有 inputHash，與新基準的 baselineKey 不同：同一份輸入以新程式重建時推進一輪（沒有變化），之後冪等
  const again = L.advance(legacy, q1, { now: '2026-01-15T00:00:00Z' });
  assert.deepStrictEqual([again.skipped, again.changes], [false, []]);
  assert.strictEqual(L.advance(again.ledger, q1, { now: '2026-01-16T00:00:00Z' }).skipped, true);
  // 舊基準（沒有 baselineKey 的 Snapshot）退回用 inputHash：和舊格式的那一輪相同，不推進
  const oldSnap = JSON.parse(JSON.stringify(q1.snapshot)); delete oldSnap.meta.baselineKey;
  assert.strictEqual(L.advance(legacy, S.query(oldSnap), { now: '2026-01-15T00:00:00Z' }).skipped, true);
});
test('處理紀錄：validate 對錯誤的格式逐項回報、不修改資料', () => {
  const L = S.ledger; const { r3 } = ledgerRounds();
  assert.deepStrictEqual(L.validate(L.empty()), { ok: true, errors: [] });
  assert.deepStrictEqual(L.validate(null).ok, false);
  const bad = JSON.parse(JSON.stringify(r3.ledger));
  const keys = Object.keys(bad.items);
  bad.schema = 'ssot-ledger/0';
  bad.items[keys[0]].status = 'done';
  bad.items[keys[1]].id = 'X99';
  bad.items[keys[2]].history[0].by = 'robot';
  bad.items[keys[3]].status = 'accepted';
  bad.items['oops'] = { status: 'open' };
  bad.iterations[1].baseline.baselineKey = bad.iterations[0].baseline.baselineKey;
  bad.iterations[2].counts.open = -1;
  const copy = JSON.stringify(bad);
  const v = L.validate(bad);
  assert.strictEqual(v.ok, false);
  [/^schema：/, new RegExp(`^items\\[${keys[0].replace(/[[\]|.]/g, '\\$&')}\\]\\.status：`), /\.id：與鍵的規則 id/, /\.history\[0\]\.by：/, /accepted 必須有豁免/,
    /^items\[oops\]：鍵不是 findingKey/, /^iterations\[1\]\.baseline\.baselineKey：與前面的一輪重複/, /^iterations\[2\]\.counts\.open：必須是非負整數/]
    .forEach((re) => assert.ok(v.errors.some((e) => re.test(e)), `${re} 沒有回報：\n${v.errors.join('\n')}`));
  assert.strictEqual(JSON.stringify(bad), copy, 'validate 不修改資料');
  assert.throws(() => L.advance(bad, LEDGER.q1(), { now: '2026-01-01T00:00:00Z' }), /處理紀錄格式不正確/);
});

// ------------------------------------------------------------------ facet（2.9.0）：舊鍵（findingBaseKey）轉換到新鍵
// 兩台設備的 DNS 與 NTP 伺服器都不同：2.9.0 起 A12 是 dns／ntp 兩筆（facet 不同），2.8.0 以前兩筆共用同一個鍵
const FACET_TEXT = [['SW_A', '10.0.0.1', '1.1.1.1', '10.0.0.11'], ['SW_B', '10.0.0.2', '8.8.8.8', '10.0.0.12']]
  .map(([n, ip, dns, ntp]) => [`${n} (${ip}):`, '### /export terse', `/ip dns set servers=${dns}`, `/system ntp client set enabled=yes servers=${ntp}`].join('\n')).join('\n');
/** 2.8.0 的基準：程式還沒有 facet，所以 finding 沒有 facet 欄位、版本是 2.8.0（findingKey 等於 findingBaseKey） */
function snapAt280(text) {
  const s = JSON.parse(JSON.stringify(buildAtVersion('2.8.0', text)));
  s.findings.forEach((f) => { delete f.facet; });
  return s;
}
const facetQs = (text) => ({ q28: S.query(snapAt280(text)), q29: S.query(build(text)) });
const a12Keys = (Q) => Q.findings().filter((f) => f.id === 'A12').map((f) => [f.facet, Q.findingKey(f), Q.findingBaseKey(f)]);
const uniqSorted = (a) => S.util.uniq(a).sort(S.util.cmp);

test('處理紀錄 facet：2.8.0 的紀錄推進 2.9.0 的基準，A12 舊鍵分成 dns／ntp 兩筆，狀態、說明、豁免、patch 都保留；舊項目移除，不判為 fixed、不重複計數', () => {
  const L = S.ledger; const { q28, q29 } = facetQs(FACET_TEXT);
  const [[f1, dnsKey, base], [f2, ntpKey, base2]] = a12Keys(q29);
  assert.deepStrictEqual([f1, f2, base2], ['dns', 'ntp', base], '2.9.0 有 dns／ntp 兩筆，舊鍵相同');
  assert.deepStrictEqual(a12Keys(q28).map((x) => x[1]), [base, base], '2.8.0 的兩筆共用舊鍵');
  const r1 = L.advance(L.empty(), q28, { now: '2026-01-01T00:00:00Z' });
  const old = L.set(r1.ledger, base, { status: 'accepted', note: '分站自管', patch: 'patch:a12', waiver: { reason: '分站各自的 DNS／NTP', until: '2026-12-01' } }, { now: '2026-01-02T00:00:00Z' });
  const r2 = L.advance(old, q29, { now: '2026-02-01T00:00:00Z' });
  const lg = r2.ledger;
  assert.strictEqual(lg.items[base], undefined, '舊項目已轉換到新鍵，不再留在處理紀錄');
  [dnsKey, ntpKey].forEach((k) => {
    const it = lg.items[k];
    assert.deepStrictEqual([it.status, it.note, it.patch, it.waiver, it.id, it.dev, it.firstSeen, it.lastSeen],
      ['accepted', '分站自管', 'patch:a12', old.items[base].waiver, 'A12', null, q28.meta().baselineKey, q29.meta().baselineKey]);
    assert.deepStrictEqual(it.history.slice(0, -1), old.items[base].history, '舊項目的歷程保留在每一筆新項目');
    assert.deepStrictEqual(it.history[it.history.length - 1],
      { at: '2026-02-01T00:00:00.000Z', from: 'accepted', to: 'accepted', by: 'advance', baseline: q29.meta().baselineKey, reason: 'facet-split', fromKey: base });
  });
  assert.deepStrictEqual(r2.split, [{ from: base, to: uniqSorted([dnsKey, ntpKey]), reason: 'facet-split' }]);
  assert.deepStrictEqual(r2.changes, [], '同一份輸入：沒有新出現、也沒有消失（舊鍵不判為 fixed）');
  assert.deepStrictEqual(r2.unobserved, []);
  assert.strictEqual(r2.ledger.iterations[1].counts.accepted, 2, 'dns／ntp 各算一筆，舊項目不再計數');
  assert.strictEqual(L.summary(lg).current.total, Object.keys(r1.ledger.items).length + 1);
  assert.ok(L.validate(lg).ok, L.validate(lg).errors.join('\n'));
  // 轉換後可以分開處理
  const one = L.set(lg, ntpKey, { status: 'open' }, { now: '2026-02-02T00:00:00Z' });
  assert.deepStrictEqual([one.items[dnsKey].status, one.items[ntpKey].status], ['accepted', 'open']);
});

test('處理紀錄 facet：轉換是冪等的；同一份基準再推進不重複轉換，之後的基準也不再轉換', () => {
  const L = S.ledger; const { q28, q29 } = facetQs(FACET_TEXT);
  const old = L.advance(L.empty(), q28, { now: '2026-01-01T00:00:00Z' }).ledger;
  const copy = JSON.stringify(old);
  const a = L.advance(old, q29, { now: '2026-02-01T00:00:00Z' });
  const b = L.advance(old, q29, { now: '2026-02-01T00:00:00Z' });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b), '同樣的輸入得到同樣的結果');
  assert.strictEqual(JSON.stringify(old), copy, '不修改傳入的處理紀錄');
  const again = L.advance(a.ledger, q29, { now: '2026-02-02T00:00:00Z' });
  assert.deepStrictEqual([again.skipped, again.split, JSON.stringify(again.ledger)], [true, [], JSON.stringify(a.ledger)]);
  // 下一份 2.9.0 的基準（輸入不同）：已經是新鍵，不再轉換，各筆仍是 open
  const next = L.advance(a.ledger, S.query(build('# 下一輪\n' + FACET_TEXT)), { now: '2026-03-01T00:00:00Z' });
  assert.deepStrictEqual([next.skipped, next.split, next.changes], [false, [], []]);
  const splits = (lg) => Object.values(lg.items).reduce((n, it) => n + it.history.filter((h) => h.reason === 'facet-split').length, 0);
  assert.deepStrictEqual([splits(a.ledger), splits(next.ledger)], [2, 2]);
});

test('處理紀錄 facet：新鍵已有項目時以新鍵為準，舊項目內容記在歷程；問題已不存在的舊鍵照常判為 fixed', () => {
  const L = S.ledger; const { q28, q29 } = facetQs(FACET_TEXT);
  const [[, dnsKey, base], [, ntpKey]] = a12Keys(q29);
  let old = L.advance(L.empty(), q28, { now: '2026-01-01T00:00:00Z' }).ledger;
  old = L.set(old, base, { status: 'scheduled', note: '舊的' }, { now: '2026-01-02T00:00:00Z' });
  // 混用版本時才會有：新鍵已經有自己的項目
  const mixed = JSON.parse(JSON.stringify(old));
  mixed.items[dnsKey] = Object.assign(JSON.parse(JSON.stringify(old.items[base])), { status: 'false-positive', note: '新的' });
  const r = L.advance(mixed, q29, { now: '2026-02-01T00:00:00Z' });
  const dns = r.ledger.items[dnsKey]; const last = dns.history[dns.history.length - 1];
  assert.deepStrictEqual([dns.status, dns.note, r.ledger.items[ntpKey].status, r.ledger.items[ntpKey].note, r.ledger.items[base]], ['false-positive', '新的', 'scheduled', '舊的', undefined]);
  assert.deepStrictEqual([last.reason, last.fromKey, last.from, last.to, last.superseded], ['facet-split', base, 'false-positive', 'false-positive', old.items[base]]);
  assert.ok(L.validate(r.ledger).ok, L.validate(r.ledger).errors.join('\n'));
  // DNS／NTP 改成一致後：2.9.0 沒有 A12，舊鍵沒有可轉換的 finding，照常判為 fixed
  const same = S.query(build(FACET_TEXT.replace('8.8.8.8', '1.1.1.1').replace('10.0.0.12', '10.0.0.11')));
  assert.deepStrictEqual(a12Keys(same), []);
  const fixed = L.advance(old, same, { now: '2026-02-01T00:00:00Z' });
  assert.deepStrictEqual([fixed.split, fixed.ledger.items[base].status, fixed.changes.find((c) => c.key === base).reason], [[], 'fixed', 'disappeared']);
});

test('處理紀錄 facet：範例資料以 2.8.0 的紀錄推進 2.9.0，12 條有 facet 的規則都對得上；沒有 facet 的規則不受影響', () => {
  const L = S.ledger; const text = read('samples/sample-bundle.txt');
  const { q28, q29 } = facetQs(text);
  const facetIds = uniqSorted(q29.findings().filter((f) => f.facet != null).map((f) => f.id));
  assert.deepStrictEqual(facetIds, ['A02', 'A07', 'A08', 'A10', 'A11', 'A12', 'I02', 'R02', 'R05', 'R06', 'V06', 'V07']);
  const r1 = L.advance(L.empty(), q28, { now: '2026-01-01T00:00:00Z' });
  const r2 = L.advance(r1.ledger, q29, { now: '2026-02-01T00:00:00Z' });
  assert.deepStrictEqual([r2.changes, r2.unobserved], [[], []], '同一份輸入升版：不出現新增、fixed 或無法判斷');
  assert.deepStrictEqual(Object.keys(r2.ledger.items), uniqSorted(q29.findings().map(q29.findingKey)), '項目就是 2.9.0 的鍵，沒有殘留的舊鍵');
  // 沒有 facet 的規則：鍵不變，項目原樣（只更新 lastSeen）
  q29.findings().filter((f) => f.facet == null).forEach((f) => {
    const k = q29.findingKey(f);
    assert.strictEqual(k, q29.findingBaseKey(f));
    assert.deepStrictEqual(Object.assign({}, r2.ledger.items[k], { lastSeen: null }), Object.assign({}, r1.ledger.items[k], { lastSeen: null }), k);
  });
  assert.strictEqual(r2.split.length, uniqSorted(q29.findings().filter((f) => f.facet != null).map(q29.findingBaseKey)).length);
});

test('處理紀錄 facet：fromAcks 的舊確認標記（舊鍵）轉換到 dns／ntp 兩筆新鍵', () => {
  const L = S.ledger; const { q29 } = facetQs(FACET_TEXT);
  const [[, dnsKey, base], [, ntpKey]] = a12Keys(q29);
  const ack = { at: '2025-06-01T08:00:00.000Z', kind: 'scheduled', note: '改成同一組' };
  const r = L.fromAcks({ [base]: ack }, q29, { now: '2026-01-01T00:00:00Z' });
  assert.strictEqual(r.ledger.items[base], undefined);
  [dnsKey, ntpKey].forEach((k) => {
    const it = r.ledger.items[k];
    assert.deepStrictEqual([it.status, it.note, it.history.map((h) => h.reason)], ['scheduled', '改成同一組', ['from-ack', 'facet-split']]);
    assert.deepStrictEqual(it.history[0].ack, ack);
    assert.strictEqual(it.history[1].fromKey, base);
  });
  assert.deepStrictEqual(r.split, [{ from: base, to: uniqSorted([dnsKey, ntpKey]), reason: 'facet-split' }]);
  assert.ok(!r.changes.some((c) => c.key === dnsKey || c.key === ntpKey || c.key === base), '轉換的項目不算新出現或消失');
  assert.ok(L.validate(r.ledger).ok, L.validate(r.ledger).errors.join('\n'));
});
