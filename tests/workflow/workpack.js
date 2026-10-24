// 不壓縮 ZIP（S.zip）與工作包（S.workpack，ssot-workpack/1）
'use strict';
const assert = require('assert');
const zlib = require('zlib');
const { S, read, test, sampleSnap } = require('../lib.js');

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const NOW = '2026-01-02T03:04:05Z';
/** 丟出的錯誤要有指定代碼（errors 列出全部問題） */
function throwsCode(fn, code, name) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, `應該丟錯（${code}）`);
  assert.strictEqual(err.name, name || (err.name === 'ZipError' ? 'ZipError' : 'WorkpackError'), err.message);
  assert.ok(Array.isArray(err.errors) && err.errors.some((e) => e.code === code), `應該有 ${code}：${JSON.stringify(err.errors)}`);
  return err;
}
/** 把 bytes 中所有出現的 from 換成等長的 to（同時改到 local header 與 central directory 的檔名） */
function replaceBytes(bytes, from, to) {
  const a = enc(from); const b = enc(to); assert.strictEqual(a.length, b.length);
  const out = bytes.slice(); let n = 0;
  for (let i = 0; i + a.length <= out.length; i++) {
    if (a.every((x, k) => out[i + k] === x)) { out.set(b, i); n++; }
  }
  assert.ok(n >= 2, `應該在 local header 與 central directory 各找到一次 ${from}`);
  return out;
}
/** central directory 第 k 筆的位置 */
function cdOffset(bytes, k) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22; while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let p = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < k; i++) p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  return { dv, p };
}
const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
// Python 3 zipfile（ZIP_STORED、固定時間 2026-01-02 03:04:06）寫出的 ZIP：a.txt＝"hello\n"、資料/b.txt＝"中文\n"（UTF-8 檔名、bit 11）
const PY_STORED = 'UEsDBBQAAAAAAIMYIlwgMDo2BgAAAAYAAAAFAAAAYS50eHRoZWxsbwpQSwMEFAAACAAAgxgiXHGqMIoHAAAABwAAAAwAAADos4fmlpkvYi50eHTkuK3mlocKUEsBAhQAFAAAAAAAgxgiXCAwOjYGAAAABgAAAAUAAAAAAAAAAAAAAIABAAAAAGEudHh0UEsBAhQAFAAACAAAgxgiXHGqMIoHAAAABwAAAAwAAAAAAAAAAAAAAIABKQAAAOizh+aWmS9iLnR4dFBLBQYAAAAAAgACAG0AAABaAAAAAAA=';
// Python 3 zipfile（ZIP_DEFLATED）寫出的 ZIP：d.txt＝"x"×100
const PY_DEFLATED = 'UEsDBBQAAAAIALmEWF2PXQ5eBgAAAGQAAAAFAAAAZC50eHSrqKA9AABQSwECFAAUAAAACAC5hFhdj10OXgYAAABkAAAABQAAAAAAAAAAAAAAgAEAAAAAZC50eHRQSwUGAAAAAAEAAQAzAAAAKQAAAAAA';

// ------------------------------------------------------------------ ZIP
test('zip：寫出再讀回，內容、順序、時間與 CRC 都相同；空檔、二進位、中文路徑', () => {
  const bin = new Uint8Array(256).map((_, i) => i);
  const entries = [{ path: 'a.txt', bytes: enc('hello\n') }, { path: '資料/中文 檔名.txt', bytes: enc('中文\r\n') }, { path: 'empty', bytes: new Uint8Array(0) }, { path: 'd/bin.dat', bytes: bin }];
  const z = S.zip.write(entries, { mtime: '2026-01-02T03:04:05Z' });
  const r = S.zip.read(z);
  assert.deepStrictEqual(r.entries.map((e) => e.path), entries.map((e) => e.path));
  r.entries.forEach((e, i) => { assert.deepStrictEqual(Array.from(e.bytes), Array.from(entries[i].bytes)); assert.strictEqual(e.crc32, S.zip.crc32(entries[i].bytes)); });
  assert.ok(r.entries.every((e) => e.mtime === '2026-01-02T03:04:04Z'), 'MS-DOS 時間是 2 秒精度，以 UTC 寫入');
  assert.deepStrictEqual(r.dirs, []);
  assert.ok(r.entries[0].bytes.buffer !== z.buffer, '讀回的內容是複本');
  assert.strictEqual(S.zip.read(S.zip.write(entries)).entries[0].mtime, '1980-01-01T00:00:00Z', '沒給時間時用固定值');
  // 檔名一律是 UTF-8（bit 11）、不壓縮（method 0）
  const { dv, p } = cdOffset(z, 1);
  assert.strictEqual(dv.getUint16(p + 8, true), 0x0800); assert.strictEqual(dv.getUint16(p + 10, true), 0);
  assert.strictEqual(S.zip.read(S.zip.write([])).entries.length, 0, '空的 ZIP 也可以讀回');
});
test('zip：CRC-32 和標準值、Node zlib 一致', () => {
  assert.strictEqual(S.zip.crc32(enc('123456789')), 0xcbf43926, 'CRC-32/ISO-HDLC 的標準檢查值');
  assert.strictEqual(S.zip.crc32(new Uint8Array(0)), 0);
  if (typeof zlib.crc32 === 'function') { // Node 22.2 起才有
    [enc('hello\n'), enc('中文'.repeat(1000)), new Uint8Array(70000).map((_, i) => i * 7)].forEach((b) => assert.strictEqual(S.zip.crc32(b), zlib.crc32(b)));
  }
});
test('zip：讀得了其他工具（Python zipfile）寫出的不壓縮 ZIP；壓縮過的明確拒絕', () => {
  const r = S.zip.read(b64(PY_STORED));
  assert.deepStrictEqual(r.entries.map((e) => [e.path, dec(e.bytes), e.mtime]), [['a.txt', 'hello\n', '2026-01-02T03:04:06Z'], ['資料/b.txt', '中文\n', '2026-01-02T03:04:06Z']]);
  const e = throwsCode(() => S.zip.read(b64(PY_DEFLATED)), 'compressed');
  assert.ok(/method 8/.test(e.message) && e.errors[0].path === 'd.txt', e.message);
});
test('zip：拒絕加密、不安全路徑、重複檔名、CRC 不符、大小或 offset 超出範圍，錯誤列出全部問題', () => {
  const base = () => S.zip.write([{ path: 'xx/a.txt', bytes: enc('AAAA') }, { path: 'b1.txt', bytes: enc('BBBB') }, { path: 'b2.txt', bytes: enc('CCCC') }]);
  // 加密（bit 0）、strong encryption（bit 6）
  [0x0001, 0x0040].forEach((bit) => {
    const z = base(); const { dv, p } = cdOffset(z, 1); dv.setUint16(p + 8, 0x0800 | bit, true);
    throwsCode(() => S.zip.read(z), 'encrypted');
  });
  // 路徑：..、以 / 開頭、反斜線、磁碟代號
  [['xx/a.txt', '../a.txt'], ['xx/a.txt', '/x/a.txt'], ['xx/a.txt', 'xx\\a.txt'], ['xx/a.txt', 'C:/a.txt']].forEach(([a, b]) => {
    const e = throwsCode(() => S.zip.read(replaceBytes(base(), a, b)), 'unsafe-path');
    assert.strictEqual(e.errors[0].path, b);
  });
  // 重複的檔名（完全相同、只差大小寫）
  throwsCode(() => S.zip.read(replaceBytes(base(), 'b2.txt', 'b1.txt')), 'duplicate');
  throwsCode(() => S.zip.read(replaceBytes(base(), 'b2.txt', 'B1.txt')), 'duplicate');
  // CRC 不符：改一個資料位元組
  { const z = base(); const i = z.indexOf(0x43); z[i] = 0x44; const e = throwsCode(() => S.zip.read(z), 'crc'); assert.strictEqual(e.errors[0].path, 'b2.txt'); }
  // 大小超出範圍、local header 的 offset 超出範圍
  { const z = base(); const { dv, p } = cdOffset(z, 0); dv.setUint32(p + 20, 1e6, true); dv.setUint32(p + 24, 1e6, true); throwsCode(() => S.zip.read(z), 'out-of-range'); }
  { const z = base(); const { dv, p } = cdOffset(z, 2); dv.setUint32(p + 42, z.length, true); throwsCode(() => S.zip.read(z), 'out-of-range'); }
  // 項目重疊：第三筆指向第二筆的 local header
  { const z = base(); const a = cdOffset(z, 1); const b = cdOffset(z, 2); b.dv.setUint32(b.p + 42, a.dv.getUint32(a.p + 42, true), true); throwsCode(() => S.zip.read(z), 'local-mismatch'); }
  // 截斷、不是 ZIP、central directory 位置不對
  throwsCode(() => S.zip.read(base().slice(0, -5)), 'no-eocd');
  throwsCode(() => S.zip.read(enc('not a zip file at all, just some text')), 'no-eocd');
  { const z = base(); const dv = new DataView(z.buffer); dv.setUint32(z.length - 6, 3, true); throwsCode(() => S.zip.read(z), 'out-of-range'); }
  throwsCode(() => S.zip.read('PK'), 'not-bytes');
  // 同一份 ZIP 有兩個問題時兩個都列出
  { const z = replaceBytes(base(), 'b2.txt', 'b1.txt'); z[z.indexOf(0x41)] = 0x42; const e = throwsCode(() => S.zip.read(z), 'duplicate'); assert.ok(e.errors.some((x) => x.code === 'crc'), JSON.stringify(e.errors)); }
});
test('zip：寫入時拒絕不安全或重複的路徑、非 Uint8Array 與超出範圍的時間', () => {
  ['../a', '/a', 'a\\b', 'a//b', 'a/./b', 'C:/a', 'a:b', 'CON', 'x/nul.txt', 'a.', 'a/', '', 'a\u0001'].forEach((p) => {
    assert.throws(() => S.zip.write([{ path: p, bytes: new Uint8Array(0) }]), TypeError, p);
  });
  assert.throws(() => S.zip.write([{ path: 'a', bytes: new Uint8Array(0) }, { path: 'A', bytes: new Uint8Array(0) }]), /重複/);
  assert.throws(() => S.zip.write([{ path: 'a', bytes: 'text' }]), /Uint8Array/);
  assert.throws(() => S.zip.write([{ path: 'a', bytes: new Uint8Array(0), x: 1 }]), /不認得/);
  assert.throws(() => S.zip.write([], { mtime: '1979-12-31T00:00:00Z' }), RangeError);
  assert.throws(() => S.zip.write([], { mtime: 'yesterday' }), TypeError);
  assert.throws(() => S.zip.write([], { time: NOW }), /不認得/);
  assert.strictEqual(S.zip.checkPath('sources/貼上的內容', false), null);
});
test('zip：safeSegment 把任何名稱轉成安全的路徑段落', () => {
  ['../../etc/passwd', '/abs', 'C:\\x', 'CON', 'nul.txt', '.hidden', 'a. ', '', 'a<b>c|d?*', '\uD800x', 'x'.repeat(300)].forEach((n) => {
    const s = S.zip.safeSegment(n);
    assert.strictEqual(S.zip.checkPath(s, false), null, `${JSON.stringify(n)} → ${s}`);
    assert.ok(!s.includes('/') && s.length <= 121);
  });
  assert.strictEqual(S.zip.safeSegment('sample-bundle.txt'), 'sample-bundle.txt', '安全的名稱不變');
  assert.strictEqual(S.zip.safeSegment('報表.csv'), '報表.csv', '保留中文字');
});

// ------------------------------------------------------------------ 工作包
const SAMPLE = read('samples/sample-bundle.txt');
const PROFILE = JSON.parse(read('profiles/floor-device-naming.json'));
const EXPECTED_DATA = { switch: ['lldp', 'mac'] };
const EXTRA = { name: S.readers.PASTE, text: '\uFEFF# 第二份收集檔（貼上的內容）\r\n' };
/** 一整輪：兩份收集檔（順序有意義）、命名規則、expectedData、基準、處理紀錄、預期資料、報表與 patch */
const ROUND = (() => {
  let cache = null;
  return () => {
    if (cache) return cache;
    const sources = [{ name: 'sample-bundle.txt', text: SAMPLE }, EXTRA];
    const snap = S.build(sources, { profile: PROFILE, expectedData: EXPECTED_DATA, now: '2026-01-01T00:00:00Z' });
    delete snap.meta.timing;
    const Q = S.query(snap);
    const ledger = S.ledger.advance(S.ledger.empty(), Q, { now: '2026-01-01T00:00:00Z' }).ledger;
    const plan = S.remediate.plan(Q, { ids: ['F01', 'F06'] });
    const patches = S.remediate.files(plan).flatMap((f) => [{ role: 'patch', name: f.base + '.rsc', text: f.apply }, { role: 'patch', name: f.base + '-rollback.rsc', text: f.rollback }]);
    const parts = [
      { role: 'report', name: 'findings-20260101T000000Z.csv', text: '\uFEFFseverity,id\r\nerror,F01\r\n' },
      ...sources.map((s) => ({ role: 'source', name: s.name, text: s.text })),
      { role: 'snapshot', name: 'snapshot-20260101T000000Z.json', text: JSON.stringify(snap, null, 2) },
      { role: 'ledger', name: 'ledger.json', text: JSON.stringify(ledger) },
      { role: 'profile', name: 'floor-device-naming.json', text: JSON.stringify(PROFILE) },
      { role: 'expected-data', name: 'expected-data.json', text: JSON.stringify(EXPECTED_DATA) },
      { role: 'expected', name: 'expected.json', text: JSON.stringify(S.compare.expectedFrom(Q)) },
      { role: 'report', name: 'graph.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]) },
      ...patches,
    ];
    cache = { sources, snap, ledger, parts };
    return cache;
  };
})();
const clone = (parts) => parts.map((p) => Object.assign({}, p));
const without = (parts, role) => parts.filter((p) => p.role !== role);
const swap = (parts, role, text) => parts.map((p) => (p.role === role ? { role, name: p.name, text } : p));
/** 讀出 ZIP、改 manifest 或檔案後重新寫回（模擬被手動修改的工作包） */
function repack(bytes, fn) {
  const entries = S.zip.read(bytes).entries.map((e) => ({ path: e.path, bytes: e.bytes }));
  const m = JSON.parse(dec(entries[0].bytes));
  const out = fn(m, entries) || entries;
  out[0] = { path: 'manifest.json', bytes: enc(JSON.stringify(m)) };
  return S.zip.write(out, { mtime: NOW });
}
const rehash = (m, entries, path, bytes) => {
  entries.find((e) => e.path === path).bytes = bytes;
  const f = m.files.find((x) => x.path === path); f.bytes = bytes.length; f.sha256 = S.workpack.sha256(bytes);
};

test('workpack：SHA-256 和標準值一致', () => {
  assert.strictEqual(S.workpack.sha256(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.strictEqual(S.workpack.sha256(enc('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.strictEqual(S.workpack.sha256(enc('a'.repeat(1000000))), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  assert.strictEqual(S.workpack.sha256(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1', '跨兩個區塊');
});
test('workpack：範例資料建立工作包再讀回，基準、處理紀錄、命名規則、預期資料與收集檔都和匯出前相同', () => {
  const R = ROUND();
  const z = S.workpack.build(R.parts, { now: NOW });
  const pack = S.workpack.read(z);
  assert.deepStrictEqual(pack.warnings, []);
  const m = pack.manifest;
  assert.strictEqual(m.schema, 'ssot-workpack/1'); assert.strictEqual(m.toolVersion, S.VERSION); assert.strictEqual(m.createdAt, '2026-01-02T03:04:05.000Z');
  assert.strictEqual(m.inputHash, R.snap.meta.inputHash); assert.strictEqual(m.baselineKey, R.snap.meta.baselineKey);
  assert.deepStrictEqual(m.baseline, { schema: S.SCHEMA, version: S.VERSION, createdAt: '2026-01-01T00:00:00Z', profile: R.snap.meta.profile });
  // 檔案依角色排序（同角色保留呼叫端的順序），每個檔案有角色、路徑、原名、大小與 SHA-256
  assert.deepStrictEqual(m.files.map((f) => f.role), ['source', 'source', 'snapshot', 'ledger', 'profile', 'expected-data', 'expected', 'report', 'report', 'patch', 'patch', 'patch', 'patch']);
  assert.deepStrictEqual(Object.keys(m.files[0]), ['role', 'path', 'name', 'bytes', 'sha256']);
  assert.deepStrictEqual(m.files.slice(0, 3).map((f) => f.path), ['sources/sample-bundle.txt', `sources/${S.zip.safeSegment(S.readers.PASTE)}-${S.util.hash(S.readers.PASTE).slice(0, 8)}`, 'baseline/snapshot-20260101T000000Z.json'],
    '安全的名稱直接當路徑；替換過字元的名稱加上原名雜湊的前 8 碼');
  assert.strictEqual(m.files[1].name, S.readers.PASTE, 'manifest 保存原名');
  assert.deepStrictEqual(S.zip.read(z).entries.map((e) => e.path), ['manifest.json'].concat(m.files.map((f) => f.path)), 'manifest 是第一個項目');
  // 內容
  assert.deepStrictEqual(pack.sources, R.sources, '收集檔的名稱、內容（含 BOM 與 CRLF）與順序不變');
  assert.deepStrictEqual(pack.snapshot, R.snap);
  assert.deepStrictEqual(pack.ledger, R.ledger);
  assert.deepStrictEqual(pack.profile, PROFILE);
  assert.deepStrictEqual(pack.expectedData, EXPECTED_DATA);
  assert.strictEqual(pack.expected.schema, 'ssot-expected/1');
  const png = pack.files.find((f) => f.name === 'graph.png');
  assert.deepStrictEqual(Array.from(png.bytes), [0x89, 0x50, 0x4e, 0x47, 0, 255], '報表可以是 bytes，不解讀');
  assert.ok(pack.files.filter((f) => f.role === 'patch').every((f) => dec(f.bytes).startsWith('#')), 'patch 原樣保存');
  // 重建：以工作包的命名規則與 expectedData，得到相同的 Snapshot（meta.createdAt 與 meta.timing 除外）
  const v = S.workpack.validate(pack, { now: '2027-05-05T00:00:00Z', profile: pack.profile, expectedData: pack.expectedData });
  assert.deepStrictEqual([v.ok, v.errors, v.warnings], [true, [], []]);
  const strip = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.meta.createdAt; delete c.meta.timing; return c; };
  assert.strictEqual(v.snapshot.meta.createdAt, '2027-05-05T00:00:00Z');
  assert.deepStrictEqual(strip(v.snapshot), strip(R.snap));
  // 讀回後再推進同一份基準：處理紀錄認得是同一輪
  assert.strictEqual(S.ledger.advance(pack.ledger, S.query(v.snapshot), { now: NOW }).skipped, true);
});
test('workpack：相同的 parts 與 now 產生完全相同的 bytes；不修改傳入的 parts', () => {
  const R = ROUND();
  const parts = clone(R.parts); const before = JSON.stringify(parts.map((p) => Object.assign({}, p, p.bytes ? { bytes: Array.from(p.bytes) } : {})));
  const a = S.workpack.build(parts, { now: NOW });
  const b = S.workpack.build(clone(R.parts), { now: NOW });
  assert.ok(Buffer.from(a).equals(Buffer.from(b)), '兩次的 bytes 完全相同');
  assert.strictEqual(JSON.stringify(parts.map((p) => Object.assign({}, p, p.bytes ? { bytes: Array.from(p.bytes) } : {}))), before, 'parts 沒有被修改');
  const c = S.workpack.build(clone(R.parts), { now: '2026-01-03T00:00:00Z' });
  assert.ok(!Buffer.from(a).equals(Buffer.from(c)), 'now 不同時 bytes 不同');
  const ma = S.workpack.read(a).manifest; const mc = S.workpack.read(c).manifest;
  assert.deepStrictEqual(Object.assign({}, mc, { createdAt: ma.createdAt }), ma, '只有 createdAt 不同');
});
test('workpack：檔名不會造成路徑問題；原名保存在 manifest，收集檔讀回時名稱不變', () => {
  const R = ROUND();
  const names = ['../../etc/passwd', 'CON', 'a/b', '.hidden', 'x.txt', 'x.txt', 'X.TXT', '貼上 的內容?'];
  const parts = clone(R.parts).concat(names.map((n) => ({ role: 'report', name: n, text: n })));
  const pack = S.workpack.read(S.workpack.build(parts, { now: NOW }));
  const reps = pack.manifest.files.filter((f) => f.role === 'report').slice(2);
  assert.deepStrictEqual(reps.map((f) => f.name), names);
  reps.forEach((f) => { assert.strictEqual(S.zip.checkPath(f.path, false), null, f.path); assert.ok(f.path.startsWith('reports/') && f.path.split('/').length === 2, f.path); });
  assert.strictEqual(new Set(pack.manifest.files.map((f) => f.path.toLowerCase())).size, pack.manifest.files.length, '路徑不分大小寫也不重複');
  assert.ok(reps.every((f) => dec(pack.files.find((x) => x.path === f.path).bytes) === f.name));
});
test('workpack：build 的參數形狀不對時丟出 TypeError', () => {
  const R = ROUND(); const ok = clone(R.parts);
  assert.throws(() => S.workpack.build(ok), /now/);
  assert.throws(() => S.workpack.build(ok, { now: 'today' }), /ISO 8601/);
  assert.throws(() => S.workpack.build(ok, { now: NOW, x: 1 }), /不認得/);
  assert.throws(() => S.workpack.build(ok.concat({ role: 'secret', name: 'a', text: '' }), { now: NOW }), /role 必須是/);
  assert.throws(() => S.workpack.build(ok.concat({ role: 'report', name: '', text: '' }), { now: NOW }), /name/);
  assert.throws(() => S.workpack.build(ok.concat({ role: 'report', name: 'a', text: '', bytes: new Uint8Array(0) }), { now: NOW }), /恰好/);
  assert.throws(() => S.workpack.build(ok.concat({ role: 'report', name: 'a' }), { now: NOW }), /恰好/);
  assert.throws(() => S.workpack.build(ok.concat({ role: 'report', name: 'a', text: '\uD800' }), { now: NOW }), /代理字元/);
  assert.throws(() => S.workpack.build(ok.concat({ role: 'report', name: 'a', text: '', note: 1 }), { now: NOW }), /不認得/);
});
test('workpack：build 的內容問題全部列出（份數、JSON、命名規則、處理紀錄不是同一輪）', () => {
  const R = ROUND();
  // 沒有基準、兩份處理紀錄
  let e = throwsCode(() => S.workpack.build(without(R.parts, 'snapshot').concat(R.parts.find((p) => p.role === 'ledger')), { now: NOW }), 'count');
  assert.strictEqual(e.errors.filter((x) => x.code === 'count').length, 2, JSON.stringify(e.errors));
  throwsCode(() => S.workpack.build(without(R.parts, 'source'), { now: NOW }), 'count');
  throwsCode(() => S.workpack.build(swap(R.parts, 'ledger', '{'), { now: NOW }), 'json');
  throwsCode(() => S.workpack.build(R.parts.map((p) => (p.role === 'ledger' ? { role: 'ledger', name: 'l', bytes: new Uint8Array([0xff]) } : p)), { now: NOW }), 'encoding');
  // 基準用了命名規則，工作包卻沒有附上；附的不是同一份
  throwsCode(() => S.workpack.build(without(R.parts, 'profile'), { now: NOW }), 'profile-mismatch');
  throwsCode(() => S.workpack.build(swap(R.parts, 'profile', JSON.stringify(Object.assign({}, PROFILE, { version: '99' }))), { now: NOW }), 'profile-mismatch');
  throwsCode(() => S.workpack.build(swap(R.parts, 'profile', JSON.stringify({ classify: [{ match: '(' }] })), { now: NOW }), 'profile');
  throwsCode(() => S.workpack.build(swap(R.parts, 'expected', JSON.stringify({ schema: 'ssot-expected/9' })), { now: NOW }), 'expected');
  throwsCode(() => S.workpack.build(swap(R.parts, 'expected-data', JSON.stringify({ switch: 'lldp' })), { now: NOW }), 'expected-data');
  // 收集檔和基準不一致（多一行、順序對調）
  throwsCode(() => S.workpack.build(R.parts.map((p) => (p.role === 'source' && p.name === 'sample-bundle.txt' ? Object.assign({}, p, { text: p.text + '\n' }) : p)), { now: NOW }), 'source-mismatch');
  const srcs = R.parts.filter((p) => p.role === 'source');
  throwsCode(() => S.workpack.build(without(R.parts, 'source').concat([srcs[1], srcs[0]]), { now: NOW }), 'source-mismatch');
  // 處理紀錄：格式錯誤；沒有推進過這份基準
  throwsCode(() => S.workpack.build(swap(R.parts, 'ledger', JSON.stringify({ schema: 'ssot-ledger/1', items: [], iterations: [] })), { now: NOW }), 'ledger');
  throwsCode(() => S.workpack.build(swap(R.parts, 'ledger', JSON.stringify(S.ledger.empty())), { now: NOW }), 'ledger-baseline');
  const other = S.query(S.build([{ name: 'x.txt', text: '# 另一份\n' + SAMPLE }], { now: '2026-01-01T00:00:00Z' }));
  const otherLedger = S.ledger.advance(S.ledger.empty(), other, { now: NOW }).ledger;
  throwsCode(() => S.workpack.build(swap(R.parts, 'ledger', JSON.stringify(otherLedger)), { now: NOW }), 'ledger-baseline');
  // 兩個問題一起列出
  e = throwsCode(() => S.workpack.build(swap(without(R.parts, 'profile'), 'ledger', JSON.stringify(otherLedger)), { now: NOW }), 'ledger-baseline');
  assert.ok(e.errors.some((x) => x.code === 'profile-mismatch'), JSON.stringify(e.errors));
  // 推進過這份基準、之後又推進其他基準：可以建立，讀回時是警告
  const newer = S.ledger.advance(R.ledger, other, { now: NOW }).ledger;
  const pack = S.workpack.read(S.workpack.build(swap(R.parts, 'ledger', JSON.stringify(newer)), { now: NOW }));
  assert.deepStrictEqual(pack.warnings.map((w) => w.code), ['ledger-newer']);
});
test('workpack：read 拒絕沒有 manifest、未知的 major 版本、雜湊或大小不符、缺檔與重複的路徑', () => {
  const R = ROUND(); const z = S.workpack.build(R.parts, { now: NOW });
  throwsCode(() => S.workpack.read(S.zip.write([{ path: 'a.txt', bytes: enc('a') }])), 'no-manifest');
  throwsCode(() => S.workpack.read(repack(z, (m) => { m.schema = 'ssot-workpack/2'; })), 'schema-newer');
  throwsCode(() => S.workpack.read(repack(z, (m) => { m.schema = 'ssot-ledger/1'; })), 'schema');
  throwsCode(() => S.workpack.read(repack(z, (m) => { m.schema = 'ssot-workpack/0'; })), 'schema');
  // 內容被改、manifest 沒有跟著改
  throwsCode(() => S.workpack.read(repack(z, (m, es) => { const e = es.find((x) => x.path === m.files[0].path); e.bytes = e.bytes.slice(); e.bytes[0] ^= 1; })), 'hash');
  throwsCode(() => S.workpack.read(repack(z, (m, es) => { const e = es.find((x) => x.path === m.files[0].path); e.bytes = e.bytes.slice(1); })), 'size');
  throwsCode(() => S.workpack.read(repack(z, (m, es) => es.filter((x) => x.path !== m.files[3].path))), 'missing-file');
  throwsCode(() => S.workpack.read(repack(z, (m) => { m.files.push(Object.assign({}, m.files[0])); })), 'duplicate-path');
  throwsCode(() => S.workpack.read(repack(z, (m) => { m.files[0].path = '../x'; })), 'manifest');
  throwsCode(() => S.workpack.read(repack(z, (m) => { m.inputHash = 'x'; })), 'baseline-mismatch');
  throwsCode(() => S.workpack.read(repack(z, (m) => { m.baselineKey = 'x'; })), 'baseline-mismatch');
  throwsCode(() => S.workpack.read(repack(z, (m) => { m.createdAt = 'yesterday'; })), 'manifest');
  // ZIP 本身的錯誤原樣丟出 ZipError
  throwsCode(() => S.workpack.read(z.slice(0, 100)), 'no-eocd', 'ZipError');
  // 錯誤列出全部問題
  const e = throwsCode(() => S.workpack.read(repack(z, (m, es) => { m.files[0].sha256 = '0'.repeat(64); m.files[1].bytes = 1; })), 'hash');
  assert.ok(e.errors.some((x) => x.code === 'size'), JSON.stringify(e.errors));
});
test('workpack：不認得的角色與 manifest 沒列出的檔案是警告，資料保留；不認得的欄位保留', () => {
  const R = ROUND(); const z = S.workpack.build(R.parts, { now: NOW });
  const z2 = repack(z, (m, es) => {
    m.futureField = { a: 1 };
    const b = enc('new'); es.push({ path: 'future/x.bin', bytes: b }, { path: 'stray.txt', bytes: enc('?') });
    m.files.push({ role: 'future-role', path: 'future/x.bin', name: 'x.bin', bytes: b.length, sha256: S.workpack.sha256(b) });
  });
  const pack = S.workpack.read(z2);
  assert.deepStrictEqual(pack.warnings.map((w) => [w.code, w.path]), [['unknown-role', 'future/x.bin'], ['unlisted-file', 'stray.txt']]);
  assert.deepStrictEqual(pack.manifest.futureField, { a: 1 });
  assert.strictEqual(dec(pack.files.find((f) => f.role === 'future-role').bytes), 'new');
  // 較舊版本建立的工作包：版本不同是警告
  assert.deepStrictEqual(S.workpack.read(repack(z, (m) => { m.toolVersion = '2.8.0'; })).warnings.map((w) => w.code), ['tool-version']);
});
test('workpack：validate 重建後 inputHash 不同是錯誤；命名規則或 expectedData 換了是警告；三者都相同卻不同是錯誤', () => {
  const R = ROUND(); const z = S.workpack.build(R.parts, { now: NOW });
  const pack = S.workpack.read(z);
  // 呼叫端換了命名規則：基準鍵不同，處理紀錄會當成新的一輪
  let v = S.workpack.validate(pack, { now: NOW, profile: null, expectedData: pack.expectedData });
  assert.deepStrictEqual([v.ok, v.errors, v.warnings.map((w) => w.code)], [true, [], ['baseline-key']]);
  assert.ok(/命名規則/.test(v.warnings[0].message) && !/expectedData/.test(v.warnings[0].message), v.warnings[0].message);
  v = S.workpack.validate(pack, { now: NOW, profile: pack.profile, expectedData: null });
  assert.ok(/expectedData/.test(v.warnings[0].message), v.warnings[0].message);
  // 收集檔被換掉、基準沒有 meta.sources 可核對：read 只警告，validate 以 inputHash 抓出
  const z2 = repack(z, (m, es) => {
    const snapPath = m.files.find((f) => f.role === 'snapshot').path;
    const snap = JSON.parse(dec(es.find((e) => e.path === snapPath).bytes)); delete snap.meta.sources;
    rehash(m, es, snapPath, enc(JSON.stringify(snap)));
    rehash(m, es, m.files[0].path, enc(SAMPLE + '\n'));
  });
  const p2 = S.workpack.read(z2);
  assert.deepStrictEqual(p2.warnings.map((w) => w.code), ['snapshot-sources']);
  v = S.workpack.validate(p2, { now: NOW, profile: p2.profile, expectedData: p2.expectedData });
  assert.deepStrictEqual([v.ok, v.errors.map((x) => x.code)], [false, ['input-hash']]);
  // manifest 與基準的 baselineKey 一起被改：版本、命名規則、expectedData 都相同卻對不上 → 錯誤
  const z3 = repack(z, (m, es) => {
    const snapPath = m.files.find((f) => f.role === 'snapshot').path;
    const snap = JSON.parse(dec(es.find((e) => e.path === snapPath).bytes)); snap.meta.baselineKey = 'ffffffffffffffff'; m.baselineKey = 'ffffffffffffffff';
    rehash(m, es, snapPath, enc(JSON.stringify(snap)));
    m.files = m.files.filter((f) => f.role !== 'ledger'); return es.filter((e) => !e.path.startsWith('ledger/'));
  });
  const p3 = S.workpack.read(z3);
  v = S.workpack.validate(p3, { now: NOW, profile: p3.profile, expectedData: p3.expectedData });
  assert.deepStrictEqual([v.ok, v.errors.map((x) => x.code)], [false, ['baseline-key']]);
  // 重建失敗（例如呼叫端給了錯的命名規則）列為錯誤，不丟例外
  v = S.workpack.validate(pack, { now: NOW, profile: { id: 'bad', classify: [{ match: '(' }] }, expectedData: null });
  assert.deepStrictEqual([v.ok, v.errors.map((x) => x.code), v.snapshot], [false, ['rebuild'], null]);
  // 參數一定要明確
  assert.throws(() => S.workpack.validate(pack, { now: NOW }), /明確指定/);
  assert.throws(() => S.workpack.validate({}, { now: NOW, profile: null, expectedData: null }), /S.workpack.read/);
});
test('workpack：沒有命名規則與處理紀錄的最小工作包（範例資料）也能往返', () => {
  const snap = sampleSnap();
  const parts = [{ role: 'source', name: 'sample-bundle.txt', text: SAMPLE }, { role: 'snapshot', name: 's.json', text: JSON.stringify(snap) }];
  const pack = S.workpack.read(S.workpack.build(parts, { now: NOW }));
  assert.deepStrictEqual([pack.ledger, pack.profile, pack.expectedData, pack.expected, pack.warnings], [null, null, null, null, []]);
  const v = S.workpack.validate(pack, { now: '2026-01-01T00:00:00Z', profile: null, expectedData: null });
  assert.ok(v.ok, JSON.stringify(v.errors));
  delete v.snapshot.meta.timing;
  assert.deepStrictEqual(v.snapshot, snap, '固定 now 時與黃金基準完全相同');
});
test('ledger：roundOf 回傳這份基準是第幾輪，沒有推進過時為 -1', () => {
  const R = ROUND(); const L = S.ledger;
  assert.strictEqual(L.roundOf(R.ledger, R.snap.meta), 0);
  assert.strictEqual(L.roundOf(L.empty(), R.snap.meta), -1);
  assert.strictEqual(L.roundOf(R.ledger, { inputHash: R.snap.meta.inputHash }), -1, '有 baselineKey 的一輪不以 inputHash 對應（和 advance 相同）');
  assert.throws(() => L.roundOf({ schema: 'x' }, R.snap.meta), /格式不正確/);
  assert.throws(() => L.roundOf(R.ledger, {}), /baselineKey 或 inputHash/);
});
