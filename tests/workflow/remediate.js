// 修正 patch（S.remediate）與 patch 黃金檔
'use strict';
const assert = require('assert');
const { S, read, ids, test, fwBox, sampleSnap } = require('../lib.js');
// ------------------------------------------------------------------ 修正 patch（ssot-patch/1，src/remediate/patch.js）
// 只產生文字；plan 只透過 Q 讀基準。這一段集中放 patch 的測試，方便合併。
const P = () => S.remediate;
const patchOf = (s, sel) => P().plan(S.query(s), sel);
const setLines = (text) => text.split('\n').filter((l) => / set \[find where /.test(l));
const ifLines = (text) => text.split('\n').filter((l) => l.startsWith(':if '));
test('patch：範例資料的 F01／F06 產生停用規則的 auto item，F02（兩條規則完全相同）改為 manual 放進 skipped；順序依設備再依 finding', () => {
  const p = patchOf(sampleSnap(), { ids: ['F01', 'F02', 'F06'] });
  assert.strictEqual(p.schema, 'ssot-patch/1');
  assert.deepStrictEqual(Object.keys(p.baseline), ['inputHash', 'createdAt', 'version']);
  assert.deepStrictEqual(p.items.map((i) => [i.id, i.dev, i.level, i.target.position, i.target.by]), [['F01', 'TPE_CORE_RT_01', 'auto', 6, 'match'], ['F06', 'TPE_CORE_RT_02', 'auto', 4, 'match']]);
  assert.deepStrictEqual(p.items[0].ops, [{ op: 'set', path: '/ip firewall filter', where: { chain: 'input', action: 'accept', 'dst-port': '8291', 'in-interface': 'ether47', protocol: 'tcp' },
    expect: 1, props: { disabled: 'yes' }, before: { disabled: 'no' } }]);
  p.items.forEach((i) => {
    assert.deepStrictEqual(Object.keys(i), ['key', 'findingKey', 'id', 'dev', 'level', 'target', 'ops', 'evidence', 'risk', 'note', 'warnings']);
    const f = sampleSnap().findings.find((x) => S.query.findingKey(x) === i.findingKey);
    assert.ok(f && f.id === i.id, '每個 item 對得回基準的 finding');
    assert.deepStrictEqual(i.evidence, f.evidence, '證據沿用 finding 的來源行');
    assert.ok(i.note && i.risk.text && ['low', 'medium', 'high'].includes(i.risk.level));
  });
  assert.strictEqual(p.items[1].risk.level, 'medium', 'F06 停用可能影響服務');
  assert.deepStrictEqual(p.skipped.map((x) => [x.id, x.dev, x.level, x.reason]), [['F02', 'TPE_CORE_RT_01', 'manual', 'ambiguous-find']]);
  assert.ok(/find 無法區分/.test(p.skipped[0].detail) && /第 3 條/.test(p.skipped[0].detail), p.skipped[0].detail);
  assert.deepStrictEqual(p.devices, [{ key: 'TPE_CORE_RT_01', name: 'TPE_CORE_RT_01' }, { key: 'TPE_CORE_RT_02', name: 'TPE_CORE_RT_02' }]);
  // 全部 finding：auto 以外的都在 skipped，等級與原因對得上；items 與 skipped 都依設備排序，不屬於設備的最後
  const all = patchOf(sampleSnap());
  const snap = sampleSnap(); const Q = S.query(snap);
  assert.strictEqual(all.items.length + all.skipped.length, snap.findings.length, '每筆 finding 不是 item 就是 skipped，不靜默丟棄');
  all.skipped.forEach((x) => assert.strictEqual(x.level, x.reason === 'ambiguous-find' ? 'manual' : P().levelOf(x.id)));
  assert.ok(all.skipped.some((x) => x.id === 'F03' && x.level === 'choice' && x.reason === 'choice'));
  assert.ok(all.skipped.some((x) => x.id === 'K02' && x.level === 'manual' && x.reason === 'manual'));
  const rank = (d) => (d === null ? '￿' : Q.devName(d));
  const devs = all.skipped.map((x) => x.dev);
  assert.deepStrictEqual(devs, devs.slice().sort((a, b) => (a === null) - (b === null) || S.util.natural(rank(a), rank(b))), 'skipped 依設備排序');
  const idx = (x) => snap.findings.findIndex((f) => S.query.findingKey(f) === x.findingKey);
  all.skipped.forEach((x, k) => { const y = all.skipped[k + 1]; if (y && y.dev === x.dev) assert.ok(idx(x) <= idx(y), '同一台設備內依 finding 順序'); });
});
test('patch：skipped 的每一種 reason 在 SKIP_TEXT 都有非空的中文說明（畫面以它當分組標題）', () => {
  const T = P().SKIP_TEXT; const ok = (r) => typeof T[r] === 'string' && T[r].trim() !== '';
  // 範例資料（含不存在的鍵）實際出現的 reason
  const plan = patchOf(sampleSnap(), { keys: null }); const missing = patchOf(sampleSnap(), ['["X99"]']);
  const seen = S.util.uniq(plan.skipped.concat(missing.skipped).map((x) => x.reason));
  assert.ok(seen.includes('ambiguous-find') && seen.includes('not-found'), seen.join('、'));
  assert.deepStrictEqual(seen.filter((r) => !ok(r)), [], '範例資料的 plan 有 reason 沒有說明');
  // 程式中所有寫死的 reason（含範例資料沒有觸發的），以及等級本身（choice／manual）
  const src = read('src/remediate/patch.js');
  const all = S.util.uniq(Array.from(src.matchAll(/reason: '([a-z-]+)'/g), (m) => m[1]).concat(['choice', 'manual']));
  assert.ok(all.length >= 8, all.join('、'));
  assert.deepStrictEqual(all.filter((r) => !ok(r)), [], 'patch.js 有 reason 沒有說明');
});
test('patch：同樣的輸入產生的 plan 與 .rsc 完全相同', () => {
  const a = patchOf(sampleSnap()); const b = patchOf(sampleSnap());
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  assert.strictEqual(JSON.stringify(P().files(a)), JSON.stringify(P().files(b)));
  assert.strictEqual(JSON.stringify(a), JSON.stringify(JSON.parse(JSON.stringify(a))), 'plan 是純 JSON');
});
test('patch 黃金檔：範例資料的 plan 與每台 .rsc 與 tests/golden/sample-patch* 完全相同', () => {
  const G = require('../golden.js');
  const { plan, files } = G.goldenPatch(S);
  const want = JSON.parse(read('tests/golden/sample-patch.json'));
  const diff = G.diffPaths(want, JSON.parse(G.serializePlan(plan)), 10);
  assert.deepStrictEqual(diff, [], 'patch 與黃金檔不同。若是刻意的變更，執行 npm run golden:update 並檢視 git diff：\n' + diff.join('\n'));
  const stored = G.storedPatchFiles();
  assert.deepStrictEqual(Object.keys(stored).sort(), Object.keys(files).sort(), '每台設備一組 apply／rollback／verify');
  Object.entries(files).forEach(([f, text]) => assert.strictEqual(stored[f], text, `${f} 與黃金檔不同（npm run golden:update）`));
});
test('patch：前置檢查都在套用指令之前；rollback 是 apply 的反向；verify 每個 op 一條 print where 並寫出預期', () => {
  const s = fwBox(['/ip firewall filter add action=accept chain=input comment="a" dst-port=8291 protocol=tcp',
    '/ip firewall filter add action=accept chain=input comment="b" dst-port=8291 protocol=tcp',
    '/ip firewall filter add action=accept chain=input dst-port=8291 in-interface=ether2 protocol=tcp',
    '/ip firewall filter add action=accept chain=forward protocol=udp src-port=123']);
  const p = patchOf(s, { ids: ['F01', 'F02', 'F06'] });
  assert.deepStrictEqual(p.items.map((i) => [i.id, i.target.by]), [['F01', 'match'], ['F06', 'match'], ['F02', 'comment']], 'comment 不同的重複規則以 comment find；同一台設備內依 finding 順序');
  const apply = P().renderRsc(p, 'R'); const back = P().renderRollback(p, 'R'); const verify = P().renderVerify(p, 'R');
  [apply, back].forEach((t) => {
    const lines = t.split('\n');
    const lastIf = lines.map((l) => l.startsWith(':if ')).lastIndexOf(true); const firstSet = lines.findIndex((l) => / set \[find where /.test(l));
    assert.ok(lastIf >= 0 && firstSet > lastIf, '所有前置檢查都在第一條套用指令之前');
    assert.strictEqual(ifLines(t).length, setLines(t).length, '每個 op 一條前置檢查');
    ifLines(t).forEach((l) => assert.ok(/^:if \(\[:len \[\/ip firewall filter find where .+\]\] != 1\) do=\{ :error ".+" \}$/.test(l), l));
  });
  // rollback：op 倒序、props 與 before 互換；文字上是 apply 的 set 倒序、disabled=yes → no
  const ops = p.items.flatMap((i) => i.ops);
  assert.deepStrictEqual(P().rollbackOps(p, 'R').map((x) => x.op), ops.slice().reverse().map((op) => Object.assign({}, op, { props: op.before, before: op.props })));
  assert.deepStrictEqual(setLines(back), setLines(apply).reverse().map((l) => l.replace(/ disabled=yes$/, ' disabled=no')));
  assert.ok(setLines(apply).every((l) => / disabled=yes$/.test(l)));
  // verify：print where 用與 find 相同的條件
  const prints = verify.split('\n').filter((l) => / print where /.test(l));
  assert.deepStrictEqual(prints, setLines(apply).map((l) => l.replace(/ set \[find where (.*)\] disabled=yes$/, ' print where $1')));
  assert.strictEqual(verify.split('\n').filter((l) => /^# \[\d+\] .*: expect 1 rule, flagged X \(disabled\)$/.test(l)).length, prints.length);
  assert.ok(apply.includes('inputHash=' + s.meta.inputHash) && apply.includes('ssot-patch/1') && apply.includes('# device: R'));
  assert.throws(() => P().renderRsc(p, 'NOPE'), /沒有設備/);
  assert.throws(() => P().renderRsc({ schema: 'x' }, 'R'), /schema/);
});
test('patch：.rsc 只含 ASCII（註解的非 ASCII 寫成 <U+XXXX>，字串值的非 ASCII 位元組寫成 \\XX），引號、$、? 依 RouterOS 字串規則跳脫', () => {
  const s = S.build([{ name: '測試.txt', text: ['R:1 (10.0.0.1):', '### /export terse', '/interface list add name=WAN', '/interface list member add interface=ether1 list=WAN',
    '/ip firewall filter add action=accept chain=input comment="ssh" dst-port=22 protocol=tcp',
    '/ip firewall filter add action=accept chain=input comment="\\E4\\B8\\AD\\E6\\96\\87 \\$x \\"q\\" ok\\?" dst-port=22 in-interface=ether2 protocol=tcp',
    '/ip firewall filter add action=accept chain=input comment="\\A4\\A4\\A4\\E5" protocol=udp src-port=53'].join('\n') }], { now: '2026-01-01T00:00:00Z' });
  const p = patchOf(s, { ids: ['F01', 'F06'] });
  assert.deepStrictEqual(p.items.map((i) => [i.id, i.target.by]), [['F01', 'comment'], ['F06', 'match']], 'UTF-8 註解可用來 find；Big5 註解不用');
  assert.ok(p.items[1].warnings.some((w) => /ASCII／UTF-8/.test(w)));
  const f = P().files(p);
  assert.strictEqual(f.length, 1);
  assert.ok(/^R_1-[0-9a-f]{8}$/.test(f[0].base), '檔名不安全的設備鍵轉成安全檔名：' + f[0].base);
  [f[0].apply, f[0].rollback, f[0].verify].forEach((t) => {
    assert.ok(/^[\x20-\x7e\n]*$/.test(t), '整份 .rsc 都是可列印 ASCII');
    t.split('\n').filter((l) => l.startsWith('#')).forEach((l) => assert.ok(!l.endsWith('\\'), '註解不以反斜線結尾'));
  });
  assert.ok(f[0].apply.includes('(<U+6E2C><U+8A66>.txt line 6)'), '註解的非 ASCII 字元寫成 <U+XXXX>');
  assert.ok(f[0].apply.includes('comment="\\E4\\B8\\AD\\E6\\96\\87 \\$x \\"q\\" ok\\3F"'), 'UTF-8 註解還原成與 export 相同的位元組');
  assert.strictEqual(P().rosStr('a\\b\n'), '"a\\\\b\\0A"');
});
test('patch：find 可能符合多條規則時改為 manual；同一條規則有多筆 auto finding 時只停用一次', () => {
  // 第 2、3 條都被第 1 條遮蔽；第 3 條的屬性值第 2 條也都有（find 是「含有這些屬性值」），find 無法只找到第 3 條
  const amb = fwBox(['/ip firewall filter add action=accept chain=input protocol=tcp',
    '/ip firewall filter add action=accept chain=input dst-port=22 protocol=tcp src-address=10.0.0.0/8',
    '/ip firewall filter add action=accept chain=input dst-port=22 protocol=tcp']);
  const pa = patchOf(amb, { ids: ['F01'] });
  assert.deepStrictEqual(pa.items.map((i) => [i.id, i.target.position, i.ops[0].where['src-address']]), [['F01', 2, '10.0.0.0/8']]);
  assert.deepStrictEqual(pa.skipped.map((x) => [x.id, x.level, x.reason]), [['F01', 'manual', 'ambiguous-find']]);
  assert.ok(/第 2 條/.test(pa.skipped[0].detail) && /前置檢查一定會中止/.test(pa.skipped[0].detail), pa.skipped[0].detail);
  assert.ok(P().renderRsc(pa, 'R').includes('src-address="10.0.0.0/8"'), 'where 的值一律加引號（字串比對）');
  // 同一條規則：被遮蔽（F01）又以來源埠放行（F06）
  const two = fwBox(['/ip firewall filter add action=accept chain=input protocol=udp', '/ip firewall filter add action=accept chain=input protocol=udp src-port=53']);
  const pt = patchOf(two, { ids: ['F01', 'F06'] });
  assert.strictEqual(pt.items.length, 1);
  assert.deepStrictEqual(pt.skipped.map((x) => [x.level, x.reason, x.item]), [['auto', 'same-target', pt.items[0].key]]);
});
test('patch：selection 可用 findingKey 清單或 { keys, ids, devices } 交集篩選；不存在的鍵列入 skipped；格式錯誤明確丟出', () => {
  const snap = sampleSnap(); const Q = S.query(snap);
  const keyOf = (id) => S.query.findingKey(snap.findings.find((f) => f.id === id));
  assert.deepStrictEqual(P().plan(Q, [keyOf('F06')]).items.map((i) => i.id), ['F06']);
  assert.deepStrictEqual(P().plan(Q, { keys: [keyOf('F06'), keyOf('F01')] }).items.map((i) => i.id), ['F01', 'F06'], '依設備排序，不依選取順序');
  assert.deepStrictEqual(P().plan(Q, { ids: ['F01', 'F06'], devices: ['TPE_CORE_RT_02'] }).items.map((i) => [i.id, i.dev]), [['F06', 'TPE_CORE_RT_02']]);
  const byDev = P().plan(Q, { devices: ['TPE_CORE_RT_01'] });
  assert.ok(byDev.items.concat(byDev.skipped).every((x) => x.dev === 'TPE_CORE_RT_01'));
  assert.strictEqual(byDev.items.length + byDev.skipped.length, snap.findings.filter((f) => Q.findingDevice(f) === 'TPE_CORE_RT_01').length);
  const miss = P().plan(Q, ['["F99"]', keyOf('F01')]);
  assert.deepStrictEqual(miss.skipped.map((x) => [x.findingKey, x.reason, x.level]), [['["F99"]', 'not-found', null]]);
  assert.deepStrictEqual(P().plan(Q, { ids: [] }).items, [], '空清單代表不選任何 finding');
  assert.throws(() => P().plan(Q, { id: ['F01'] }), /不認得的欄位/);
  assert.throws(() => P().plan(Q, { ids: 'F01' }), /字串陣列/);
  assert.throws(() => P().plan(Q, 'F01'), /selection/);
});
test('patch facet：有 facet 的 finding 各自以 findingKey 選取與列入 skipped；舊鍵（findingBaseKey）不是目前的鍵，列為 not-found', () => {
  const snap = sampleSnap(); const Q = S.query(snap);
  const facets = snap.findings.filter((f) => f.facet != null);
  assert.ok(facets.length >= 12);
  const all = P().plan(Q);
  facets.forEach((f) => {
    const k = Q.findingKey(f);
    assert.ok(JSON.parse(k)[1] === 'facet:' + f.facet, k);
    assert.strictEqual(all.skipped.filter((x) => x.findingKey === k).length, snap.findings.filter((g) => Q.findingKey(g) === k).length, k);
    const one = P().plan(Q, [k]);
    assert.deepStrictEqual(one.skipped.map((x) => [x.findingKey, x.id]), snap.findings.filter((g) => Q.findingKey(g) === k).map(() => [k, f.id]));
  });
  const a12 = facets.find((f) => f.id === 'A12'); const base = Q.findingBaseKey(a12);
  assert.notStrictEqual(base, Q.findingKey(a12));
  assert.deepStrictEqual(P().plan(Q, [base]).skipped.map((x) => [x.findingKey, x.reason]), [[base, 'not-found']]);
});
