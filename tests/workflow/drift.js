// 預期資料的漂移（S.compare.drift，ssot-drift/1）：預期資料可能已過時 vs 網路偏離預期
'use strict';
const assert = require('assert');
const { S, read, build, test } = require('../lib.js');

/**
 * 三台設備 A—B—C 的小網路（RouterOS 7 的 /ip neighbor print detail 與 /export terse，自行撰寫）：
 *   port：B 接 A ether1 的埠（改成別的埠＝改接）；withC：是否有 C（B ether3 ↔ C ether1）；vids：A 上的 VLAN；
 *   failB：B 有一個指令收集失敗；note：加一行註解（讓輸入不同、基準鍵不同，其他不變）。
 * 每一輪用不同的 now，createdAt 才有先後。
 */
const netText = ({ port = 'ether1', withC = true, vids = [10], failB = false, note = '' } = {}) => [
  ...(note ? [`# ${note}`] : []),
  'A (10.0.0.1):', '### /ip neighbor print detail', ` 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=${port}`,
  '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', '/interface bridge port add bridge=bridge1 interface=ether1',
  ...vids.map((v) => `/interface bridge vlan add bridge=bridge1 tagged=ether1 vlan-ids=${v}`),
  'B (10.0.0.2):', '### /ip neighbor print detail', ` 0 interface=${port} mac-address=AA:00:00:00:00:01 identity=A interface-name=ether1`,
  ...(withC ? [' 1 interface=ether3 mac-address=AA:00:00:00:00:03 identity=C interface-name=ether1'] : []),
  ...(failB ? ['### /interface bridge vlan print detail', '', '# collection failed: timeout'] : []),
  ...(withC ? ['C (10.0.0.3):', '### /ip neighbor print detail', ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether3'] : []),
].join('\n') + '\n';
const net = (o = {}) => build(netText(o), { now: o.now || '2026-01-01T00:00:00Z' });
const T = (n) => `2026-01-0${n}T00:00:00Z`;
const Q = (o) => S.query(net(o));
const brief = (list) => list.map((i) => [i.type, i.change, i.ref, i.rounds]);
const AB = 'A|ether1~B|ether1'; const BC = 'B|ether3~C|ether1';

test('預期資料漂移：expectedFrom 寫入 source（產生它的基準）；之後的基準沒有改變時沒有漂移；同一份基準只算一次', () => {
  const q0 = Q({ now: T(1) });
  const e = S.compare.expectedFrom(q0);
  const m = q0.meta();
  assert.deepStrictEqual(e.source, { baselineKey: m.baselineKey, inputHash: m.inputHash, schema: S.SCHEMA, createdAt: T(1) });
  assert.deepStrictEqual(Object.keys(e), ['schema', '_說明', 'source', 'devices', 'links', 'vlans']);
  assert.ok(S.compare(q0, e).items.every((i) => i.status === 'ok'), 'source 不影響 S.compare');
  const r = S.compare.drift(Q({ note: 'r3', now: T(3) }), e, { history: [q0, Q({ note: 'r2', now: T(2) })] });
  assert.strictEqual(r.schema, 'ssot-drift/1');
  assert.deepStrictEqual([r.errors, r.warnings, r.stale, r.drifted, r.unobserved], [[], [], [], [], []]);
  assert.deepStrictEqual(r.summary, { stale: 0, drifted: 0, unobserved: 0 });
  assert.deepStrictEqual([r.basis.rounds, r.basis.source, r.basis.sourceInHistory, r.basis.extras], [2, e.source, true, { device: 'source', link: 'source', vlan: 'source' }]);
  assert.deepStrictEqual(r.basis.history.map((h) => [h.createdAt, h.used, h.reason]), [[T(1), true, null], [T(2), true, null], [T(3), true, null]]);
  // 輸入相同（只差 now）的基準鍵相同：只算第一次
  const dup = S.compare.drift(Q({ now: T(3) }), e, { history: [q0, Q({ now: T(2) })] });
  assert.deepStrictEqual(dup.basis.history.map((h) => [h.used, h.reason]), [[true, null], [false, 'duplicate'], [false, 'duplicate']]);
  assert.deepStrictEqual(dup.warnings.map((w) => w.kind), ['too-few-rounds']);
});

test('預期資料漂移：同一次收集（inputHash 相同）以不同的建立選項重建，基準鍵不同仍只算一輪；since 仍記基準鍵', () => {
  // 例如升級後以儲存的輸入重建，或改了命名規則／expectedData 再建立，再載入同一次收集舊版匯出的基準當「上一輪」
  const first = Q({ now: T(1) });
  const same = S.query(build(netText(), { now: T(2), expectedData: { switch: ['lldp'] } }));
  assert.strictEqual(first.meta().inputHash, same.meta().inputHash, '測試資料：同一份輸入');
  assert.notStrictEqual(first.meta().baselineKey, same.meta().baselineKey, '測試資料：建立選項不同，基準鍵不同');
  const hand = { schema: 'ssot-expected/1', devices: ['A', 'B', 'Z'] };
  const r = S.compare.drift(same, hand, { history: [first] });
  assert.deepStrictEqual(r.basis.history.map((h) => [h.used, h.reason]), [[true, null], [false, 'duplicate']]);
  assert.deepStrictEqual(r.stale, [], '只觀察一次，不可推論為過時');
  assert.deepStrictEqual(brief(r.drifted), [['device', 'missing', 'Z', 1]]);
  assert.deepStrictEqual(r.drifted[0].since, { baselineKey: first.meta().baselineKey, inputHash: first.meta().inputHash, createdAt: T(1) });
  assert.deepStrictEqual(r.warnings.map((w) => w.kind), ['no-source', 'too-few-rounds']);
  // 來源基準也依 inputHash 對應：由 first 產生的預期資料，same 是同一次收集，仍算「來源在 history 中」
  const e = S.compare.expectedFrom(first);
  const r2 = S.compare.drift(same, e);
  assert.deepStrictEqual([r2.basis.sourceInHistory, r2.basis.history.map((h) => [h.used, h.reason])], [true, [[true, null]]]);
});

test('預期資料漂移：strict 時多出的鏈路與 S.compare 同一個規則（含未經雙向確認的鏈路）', () => {
  // A⇄B 雙向；B ether3 看到 C，但 C 沒有回報（單向 LLDP，未經雙向確認），連續兩輪
  const txt = ['A (10.0.0.1):', '### /ip neighbor print detail', ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether1',
    'B (10.0.0.2):', '### /ip neighbor print detail', ' 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=A interface-name=ether1',
    ' 1 interface=ether3 mac-address=AA:00:00:00:00:03 identity=C interface-name=ether1'].join('\n') + '\n';
  const b = (n) => S.query(build(txt + `# round ${n}\n`, { now: T(n) }));
  const q1 = b(1); const q2 = b(2);
  assert.ok(q2.getLink(BC) && !q2.getLink(BC).verified, '測試資料：B—C 未經雙向確認');
  const e = { schema: 'ssot-expected/1', devices: ['A', 'B'], links: [{ a: 'A ether1', b: 'B ether1' }], strictDevices: true, strictLinks: true };
  const unexpected = S.compare(q2, e).items.filter((i) => i.status === 'unexpected');
  assert.deepStrictEqual(unexpected.map((i) => [i.type, i.ref]), [['link', BC]]);
  const d = S.compare.drift(q2, e, { history: [q1] });
  assert.deepStrictEqual(brief(d.stale), [['link', 'unexpected', BC, 2]]);
  assert.strictEqual(d.stale[0].message, unexpected[0].message, '訊息與 S.compare 相同');
  assert.deepStrictEqual(d.drifted, []);
  // 只有 source（不是 strict）時仍依 expectedFrom 的納入規則：未經雙向確認的鏈路不寫進預期資料，也不算多出
  const gen = S.compare.expectedFrom(q1);
  assert.ok(!gen.links.some((l) => /C/.test(l.a + l.b)));
  const ds = S.compare.drift(q2, gen, { history: [q1] });
  assert.deepStrictEqual([ds.stale, ds.drifted], [[], []]);
});

test('預期資料漂移：設備移除——只有一輪是 drifted（網路偏離預期），連續兩輪是 stale（預期資料可能已過時）；不修改基準與預期資料', () => {
  const s0 = net({ now: T(1) }); const e = S.compare.expectedFrom(S.query(s0));
  const s1 = net({ withC: false, now: T(2) });
  const before = JSON.stringify([s0, s1, e]);
  const once = S.compare.drift(S.query(s1), e, { history: [S.query(s0)] });
  assert.deepStrictEqual(brief(once.drifted), [['device', 'missing', 'C', 1], ['link', 'missing', BC, 1]]);
  assert.deepStrictEqual(once.stale, []);
  assert.strictEqual(once.drifted[0].message, '基準中沒有 C');
  assert.deepStrictEqual(once.drifted[0].since, { baselineKey: s1.meta.baselineKey, inputHash: s1.meta.inputHash, createdAt: T(2) });
  assert.strictEqual(once.drifted[0].observed, 2);
  // 再一輪仍然沒有 C，同時多出 VLAN 99（只有一輪、預期資料不是 strict：不算偏離，也還不到過時）
  const s2 = net({ withC: false, vids: [10, 99], now: T(3) });
  const twice = S.compare.drift(S.query(s2), e, { history: [S.query(s0), S.query(s1)] });
  assert.deepStrictEqual(brief(twice.stale), [['device', 'missing', 'C', 2], ['link', 'missing', BC, 2]]);
  assert.strictEqual(twice.stale[0].since.createdAt, T(2), '連續不符的第一輪');
  assert.deepStrictEqual(twice.drifted, []);
  assert.strictEqual(JSON.stringify([s0, s1, e]), before, '不可修改基準與預期資料');
  assert.deepStrictEqual(S.compare.drift(S.query(s2), e, { history: [S.query(s0), S.query(s1)] }), twice, '可重現');
  // rounds 調高為 3：兩輪不符仍是 drifted
  const r3 = S.compare.drift(S.query(s2), e, { history: [S.query(s0), S.query(s1)], rounds: 3 });
  assert.deepStrictEqual([brief(r3.drifted), r3.stale, r3.basis.rounds], [[['device', 'missing', 'C', 2], ['link', 'missing', BC, 2]], [], 3]);
});

test('預期資料漂移：鏈路改接——預期的鏈路是 different，改接後的鏈路是多出的實體；中間恢復一輪就重新計算', () => {
  const q0 = Q({ now: T(1) }); const e = S.compare.expectedFrom(q0);
  const q1 = Q({ port: 'ether2', now: T(2) }); const q2 = Q({ port: 'ether2', vids: [10, 20], now: T(3) });
  const r = S.compare.drift(q2, e, { history: [q0, q1] });
  assert.deepStrictEqual(brief(r.stale), [['link', 'different', AB, 2], ['link', 'unexpected', 'A|ether1~B|ether2', 2]]);
  assert.strictEqual(r.stale[0].message, 'A ether1 ⇄ B ether1 不存在，實際為：A ether1 ⇄ B ether2');
  assert.strictEqual(r.stale[1].message, '基準多出 A ether1 ⇄ B ether2');
  assert.ok(!r.stale.concat(r.drifted).some((i) => i.type === 'vlan'), 'VLAN 20 只有一輪、非 strict：不列');
  // 改回去再改接：從最新一輪往回數只有 1 輪不符 → drifted；多出的鏈路中間有一輪不在，非 strict 時不列
  const back = Q({ vids: [10, 30], now: T(3) });
  const again = Q({ port: 'ether2', vids: [10, 40], now: T(4) });
  const r2 = S.compare.drift(again, e, { history: [q0, q1, back] });
  assert.deepStrictEqual(brief(r2.drifted), [['link', 'different', AB, 1]]);
  assert.deepStrictEqual(r2.stale, []);
  assert.strictEqual(r2.drifted[0].observed, 4);
});

test('預期資料漂移：strict 時多出的設備與鏈路一輪就是 drifted；VLAN 新增依 source 判斷，連續兩輪是 stale', () => {
  const q0 = Q({ withC: false, now: T(1) });
  const e = S.compare.expectedFrom(q0, { strict: true });
  const r = S.compare.drift(Q({ vids: [10, 20], now: T(2) }), e, { history: [q0] });
  assert.deepStrictEqual(r.basis.extras, { device: 'strict', link: 'strict', vlan: 'source' });
  assert.deepStrictEqual(brief(r.drifted), [['device', 'unexpected', 'C', 1], ['link', 'unexpected', BC, 1]]);
  assert.strictEqual(r.drifted[0].message, '基準多出 C');
  // 兩輪都有 C 與 VLAN 20：三者都是 stale；VLAN 30 只在上一輪出現、最新一輪不在：不列
  const twice = S.compare.drift(Q({ vids: [10, 20], now: T(3) }), e, { history: [q0, Q({ vids: [10, 20, 30], now: T(2) })] });
  assert.deepStrictEqual(brief(twice.stale), [['device', 'unexpected', 'C', 2], ['link', 'unexpected', BC, 2], ['vlan', 'unexpected', 'A|20', 2]]);
  assert.strictEqual(twice.stale[2].message, '基準多出 A VLAN 20');
  assert.deepStrictEqual(twice.drifted, []);
});

test('預期資料漂移：設備有收集失敗時，該設備的項目這一輪不算（不計入、也不中斷連續）', () => {
  const q0 = Q({ now: T(1) }); const e = S.compare.expectedFrom(q0);
  const q1 = Q({ withC: false, now: T(2) });
  const failed = net({ withC: false, failB: true, now: T(3) });
  assert.ok(failed.coverage.some((c) => c.dev === 'B' && c.failures.length), '測試資料：B 要有收集失敗');
  const r = S.compare.drift(S.query(failed), e, { history: [q0, q1] });
  // C 本身沒有收集失敗（整台不在），兩輪都不在 → stale；B—C 的鏈路在 B 失敗的那一輪不算，只有 1 輪 → drifted
  assert.deepStrictEqual(brief(r.stale), [['device', 'missing', 'C', 2]]);
  assert.deepStrictEqual(brief(r.drifted), [['link', 'missing', BC, 1]]);
  assert.strictEqual(r.drifted[0].observed, 2);
  // 只有失敗的那一輪：B 的不符項目都未觀察；ok 的項目不受影響
  const only = S.compare.drift(S.query(net({ withC: false, failB: true, port: 'ether2', now: T(2) })), e);
  assert.deepStrictEqual(only.unobserved, [{ type: 'link', ref: AB }, { type: 'link', ref: BC }]);
  assert.deepStrictEqual(brief(only.drifted), [['device', 'missing', 'C', 1]]);
  assert.strictEqual(only.summary.unobserved, 2);
});

test('預期資料漂移：沒有 source 的預期資料（手寫或舊檔）照常判斷，但不檢查多出的實體；source 格式錯誤時提示並視為沒有', () => {
  const q0 = Q({ now: T(1) }); const gen = S.compare.expectedFrom(q0);
  const old = JSON.parse(JSON.stringify(gen)); delete old.source;
  const q1 = Q({ port: 'ether2', withC: false, now: T(2) });
  const r = S.compare.drift(q1, old, { history: [q0] });
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.warnings.map((w) => w.kind), ['no-source']);
  assert.deepStrictEqual([r.basis.source, r.basis.sourceInHistory, r.basis.extras], [null, null, { device: null, link: null, vlan: null }]);
  assert.deepStrictEqual(brief(r.drifted), [['device', 'missing', 'C', 1], ['link', 'different', AB, 1], ['link', 'missing', BC, 1]]);
  // 手寫的範例預期資料：沒有 source，只有一輪時 S.compare 不符的項目都是 drifted
  const sample = JSON.parse(read('samples/expected-sample.json'));
  const qs = S.query(build(read('samples/sample-bundle.txt')));
  const rs = S.compare.drift(qs, sample);
  assert.deepStrictEqual(rs.errors, []);
  const notOk = S.compare(qs, sample).items.filter((i) => i.status !== 'ok').map((i) => i.type + '|' + i.ref).sort();
  assert.ok(notOk.length > 0);
  assert.deepStrictEqual(rs.drifted.map((i) => i.type + '|' + i.ref).sort(), notOk);
  assert.deepStrictEqual(rs.warnings.map((w) => w.kind), ['no-source', 'too-few-rounds']);
  // source 格式錯誤
  [{ createdAt: 5 }, 'x', { schema: 'ssot-snapshot/3' }].forEach((source) => {
    const w = S.compare.drift(q1, Object.assign({}, gen, { source }), { history: [q0] });
    assert.deepStrictEqual([w.warnings.map((x) => x.kind), w.basis.source], [['source-invalid'], null], JSON.stringify(source));
  });
});

test('預期資料漂移：來源基準之前的基準不算；參數或預期資料錯誤時以 errors 回報', () => {
  const q0 = Q({ withC: false, now: T(1) }); const q1 = Q({ now: T(2) });
  const e = S.compare.expectedFrom(q1);
  // q0 排在來源 q1 之前（也比它早），不算：q0 沒有 C，算進來的話 C 會是「恢復後又不見」
  const q2 = Q({ withC: false, port: 'ether2', now: T(3) });
  const r = S.compare.drift(q2, e, { history: [q0, q1] });
  assert.deepStrictEqual(r.basis.history.map((h) => h.reason), ['before-source', null, null]);
  assert.deepStrictEqual(r.drifted.map((i) => i.ref), ['C', AB, BC]);
  // 來源不在 history 中：依 createdAt 切
  const r2 = S.compare.drift(q2, e, { history: [q0] });
  assert.deepStrictEqual([r2.basis.sourceInHistory, r2.basis.history.map((h) => h.reason)], [false, ['before-source', null]]);
  // 全部早於來源
  const r3 = S.compare.drift(q0, e);
  assert.deepStrictEqual([r3.warnings.map((w) => w.kind), r3.stale, r3.drifted], [['no-rounds'], [], []]);
  // 錯誤：其他欄位為空
  const bad = S.compare.drift(q0, { schema: 'x' });
  assert.ok(/schema/.test(bad.errors[0]) && bad.basis === null && bad.stale.length === 0);
  assert.ok(/rounds/.test(S.compare.drift(q0, e, { rounds: 0 }).errors[0]));
  assert.ok(/rounds/.test(S.compare.drift(q0, e, { rounds: 1.5 }).errors[0]));
  assert.ok(/history/.test(S.compare.drift(q0, e, { history: q0 }).errors[0]));
  assert.ok(/查詢介面/.test(S.compare.drift(q0, e, { history: [{}] }).errors[0]));
  const err = S.compare.drift(q0, { schema: 'ssot-expected/1', links: [{ a: 'X', b: 'Y z' }] });
  assert.ok(/鏈路格式錯誤/.test(err.errors[0]) && err.basis === null);
  // rounds: 1 → 一輪不符就推論為過時
  assert.deepStrictEqual(brief(S.compare.drift(q2, e, { history: [q1], rounds: 1 }).stale).map((x) => x[2]), ['C', AB, 'A|ether1~B|ether2', BC]);
});

test('預期資料漂移：範例資料的 expectedFrom 再和重新建立的範例資料比對沒有漂移；strict 時多出的只有 S.compare 也列出的（未經雙向確認的鏈路）', () => {
  const text = read('samples/sample-bundle.txt');
  const q = S.query(build(text));
  [false, true].forEach((strict) => {
    const e = JSON.parse(JSON.stringify(S.compare.expectedFrom(q, { strict })));
    const qn = S.query(build('# 下一輪\n' + text, { now: '2026-02-01T00:00:00Z' }));
    const r = S.compare.drift(qn, e, { history: [q] });
    assert.deepStrictEqual([r.errors, r.warnings], [[], []], `strict=${strict}`);
    assert.deepStrictEqual(r.basis.history.map((h) => h.used), [true, true]);
    // strict：expectedFrom 不寫未經雙向確認的鏈路，S.compare 的 strict 會把它們列為 unexpected；漂移必須列出同一組（兩輪都有 → stale）
    const unexpected = S.compare(qn, e).items.filter((i) => i.status === 'unexpected');
    assert.strictEqual(unexpected.length > 0, strict, `測試資料：範例資料要有未經雙向確認的鏈路（strict=${strict}）`);
    assert.ok(unexpected.every((i) => i.type === 'link' && !qn.getLink(i.ref).verified));
    assert.deepStrictEqual(r.stale.map((i) => [i.type, i.change, i.ref, i.message]), unexpected.map((i) => [i.type, 'unexpected', i.ref, i.message]), `strict=${strict}`);
    assert.deepStrictEqual([r.drifted, r.unobserved], [[], []], `strict=${strict}`);
  });
});
