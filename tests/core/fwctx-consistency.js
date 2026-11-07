// 防火牆比對環境的一致性：檢查用的 M.fwCtx（model，S.infer 建立）與查詢層從 Snapshot 重建的 ctxOf（S.query，L4 使用）
// 在範例資料與 tests/fixtures 的每台設備上要相同（WAN／LAN 清單、清單成員展開、介面全集、chain 內的規則）。
// 兩份目前各自建立，靠「序列化前後內容相同」成立；之後改成同一份來源時，這個測試確認行為不變。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { S, ROOT, test } = require('../lib.js');

const sorted = (set) => (set ? Array.from(set).sort(S.util.natural) : null);
/** 一個比對環境的可比較內容：清單名稱取自設備上定義的 interface list，另加 all、none 與規則引用到的清單名稱。 */
function shape(ctx, listNames, addrLists) {
  const chains = {};
  Array.from(ctx.chains.keys()).sort().forEach((k) => { chains[k] = ctx.chains.get(k).map((r) => r.key); });
  const resolved = {};
  listNames.forEach((n) => { resolved[n] = sorted(ctx.resolve(n)); });
  // 位址清單（位址集合的登錄表）：id、完全靜態與否、合併後的區間（BigInt 轉成字串比較）
  const addressLists = {};
  (addrLists || []).forEach(([fam, n]) => {
    const al = ctx.sets.list(ctx.dev, fam, n);
    addressLists[fam + '|' + n] = al ? { id: al.id, static: al.static, reasons: al.reasons, items: al.set ? al.set.ranges.map(([a, b]) => a + '-' + b) : null } : null;
  });
  // 規則的位址字面值（同一個規則鍵在兩邊得到相同的 id 與區間）
  const literals = {};
  ctx.chains.forEach((rs) => rs.forEach((r) => ['src-address', 'dst-address', 'to-addresses'].forEach((k) => {
    const e = ctx.sets.ofRule(r, k); if (e) literals[e.id] = e.set ? e.set.ranges.map(([a, b]) => a + '-' + b) : null;
  })));
  return { status: ctx.status, wanLists: ctx.wanLists, lanLists: ctx.lanLists, wan: sorted(ctx.wan), lan: sorted(ctx.lan), universe: sorted(ctx.universe), resolved, chains, addressLists, literals };
}

/** 建立基準，同時取得 model 的 M.fwCtx 與查詢層的 ctxOf（暫時包住 S.check.run 與 S.reach.engine，結束後還原）。 */
function capture(sources) {
  let M = null; let I = null;
  const run = S.check.run; const engine = S.reach.engine;
  S.check.run = function (m) { M = m; return run.apply(this, arguments); };
  try {
    const snap = S.build(sources, { now: '2026-01-01T00:00:00Z' });
    S.reach.engine = (Q, i) => { I = i; return { zones: () => [] }; };
    S.query(snap).zones();
    return { snap, M, ctxOf: I.ctxOf };
  } finally { S.check.run = run; S.reach.engine = engine; }
}

function listFixtures(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFixtures(p) : e.name.endsWith('.txt') ? [p] : [];
  }).sort();
}

test('防火牆比對環境：M.fwCtx 與查詢層的 ctxOf 在範例資料與 tests/fixtures 的每台設備上相同', () => {
  const inputs = [path.join(ROOT, 'samples', 'sample-bundle.txt'), ...listFixtures(path.join(ROOT, 'tests', 'fixtures'))];
  let compared = 0; let withWan = 0;
  inputs.forEach((file) => {
    const rel = path.relative(ROOT, file);
    const { snap, M, ctxOf } = capture([{ name: path.basename(file), text: fs.readFileSync(file, 'utf8') }]);
    assert.ok(M, rel + '：沒有取得 model');
    M.fwCtx.forEach((ctx, dev) => {
      const names = new Set(['all', 'none']);
      snap.model.interfaceLists.filter((l) => l.dev === dev).forEach((l) => { names.add(l.name); l.include.forEach((n) => names.add(n)); l.exclude.forEach((n) => names.add(n)); });
      snap.model.firewallRules.filter((r) => r.dev === dev).forEach((r) => ['in-interface-list', 'out-interface-list'].forEach((k) => {
        if (r.match[k]) names.add(S.infer.fw.splitNeg(r.match[k]).body);
      }));
      const list = Array.from(names).sort();
      const al = new Set(snap.model.addressLists.filter((l) => l.dev === dev).map((l) => l.family + '|' + l.name));
      snap.model.firewallRules.filter((r) => r.dev === dev).forEach((r) => S.infer.fw.ADDRESS_LIST.forEach((k) => {
        if (r.match[k]) al.add(r.family + '|' + S.infer.fw.splitNeg(r.match[k]).body);
      }));
      const alList = Array.from(al).sort().map((x) => x.split('|'));
      assert.deepStrictEqual(shape(ctxOf(dev), list, alList), shape(ctx, list, alList), `${rel}：${dev}`);
      compared++; if (ctx.wan) withWan++;
    });
  });
  assert.ok(compared > 0 && withWan > 0, `至少要比對到有 WAN 的設備（比對 ${compared} 台，有 WAN ${withWan} 台）`);
});
