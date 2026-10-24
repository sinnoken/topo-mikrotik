// 新舊比對（S.compare.snapshots）、預期資料（S.compare、expectedFrom）與比對的性質測試
'use strict';
const assert = require('assert');
const { S, read, build, ids, count, test } = require('../lib.js');
test('基準比對（firewall）：簽章不含規則編號；插入規則只列一筆；區分新增可連入點與既有規則限制變多', () => {
  const text = read('tests/fixtures/firewall/edge-router.txt');
  const b = (t) => S.build([{ name: 'edge.txt', text: t }], { now: '2026-01-01T00:00:00Z' });
  const o = b(text);
  const fwItems = (n) => S.compare.snapshots(S.query(o), S.query(n)).items.filter((i) => i.category === 'firewall');
  // 在最前面插入一條新的 WAN 放行
  const opened = fwItems(b(text.replace('/ip firewall filter add action=accept chain=input comment="defconf: accept est', '/ip firewall filter add action=accept chain=input dst-port=3389 protocol=tcp\n/ip firewall filter add action=accept chain=input comment="defconf: accept est')));
  assert.deepStrictEqual(opened.map((i) => [i.change, i.effect]), [['added', 'new-exposure']]);
  assert.ok(/3389/.test(opened[0].message));
  // 既有放行加上來源限制
  const narrowed = fwItems(b(text.replace('comment="winbox from anywhere" dst-port=8291 protocol=tcp', 'comment="winbox from anywhere" dst-port=8291 protocol=tcp src-address=198.51.100.0/24')));
  assert.deepStrictEqual(narrowed.map((i) => [i.change, i.field, i.effect]), [['changed', 'match', 'more-restrictive']]);
  // drop 改成 accept、停用 drop
  const loosened = fwItems(b(text.replace('action=drop chain=input comment="defconf: drop invalid"', 'action=accept chain=input comment="defconf: drop invalid"')));
  assert.deepStrictEqual(loosened.map((i) => [i.change, i.field, i.effect, i.before, i.after]), [['changed', 'action', 'less-restrictive', 'drop', 'accept']]);
  const disabled = fwItems(b(text.replace('action=accept chain=input comment="winbox from anywhere"', 'action=accept chain=input comment="winbox from anywhere" disabled=yes')));
  assert.ok(disabled.some((i) => i.field === 'disabled' && i.effect === 'more-restrictive'), JSON.stringify(disabled));
  assert.deepStrictEqual(fwItems(b(text)), [], '同一份沒有差異');
});

test('比對：獨立格式，結果分 ok／missing／different，且不修改基準', () => {
  const s = build(read('samples/sample-bundle.txt')); const before = JSON.stringify(s);
  const r = S.compare(S.query(s), JSON.parse(read('samples/expected-sample.json')));
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.summary.ok > 0 && r.summary.missing > 0 && r.summary.different > 0, JSON.stringify(r.summary));
  assert.strictEqual(JSON.stringify(s), before);
  assert.ok(S.compare(S.query(s), { schema: 'x' }).errors.length === 1);
});
// 兩台設備 A、B 的小網路：ver（A 的軟體版本）、port（A↔B 的埠）、vid、ipPort（A 的位址所在介面）、rev（B 是否回報 A）
const pairNet = ({ ver = '7.12.1 (stable)', port = 'ether1', vid = 10, ipPort = 'ether1', rev = true, extra = '' } = {}) => build(['A (10.0.0.1):', '### /system resource print', `  version: ${ver}`, '  board-name: CRS326-24G-2S+',
  '### /ip neighbor print detail', ` 0 interface=${port} mac-address=AA:00:00:00:00:02 identity=B interface-name=${port}`,
  '### /export terse', '/interface bridge add name=bridge1 vlan-filtering=yes', `/interface bridge port add bridge=bridge1 interface=${port} pvid=${vid}`,
  `/interface bridge vlan add bridge=bridge1 untagged=${port} vlan-ids=${vid}`, `/ip address add address=10.0.0.1/24 interface=${ipPort} network=10.0.0.0`,
  'B (10.0.0.2):', '### /ip neighbor print detail',
  rev ? ` 0 interface=${port} mac-address=AA:00:00:00:00:01 identity=A interface-name=${port}` : ' 0 interface=ether9 mac-address=AA:00:00:00:00:03 identity=C interface-name=ether1', extra].join('\n'));
test('基準比對（ssot-snapdiff/1）：設備、介面鄰接鏈路、VLAN、IP、finding 的新增／移除／改變，排序穩定且不修改基準', () => {
  const o = pairNet(); const n = pairNet({ ver: '7.13 (stable)', port: 'ether2', vid: 20, ipPort: 'ether2', rev: false });
  const before = JSON.stringify([o, n]);
  const r = S.compare.snapshots(S.query(o), S.query(n));
  assert.strictEqual(r.schema, 'ssot-snapdiff/1');
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.items.map((i) => [i.category, i.change, i.key, i.field]), [
    ['device', 'changed', 'A', 'softwareVersion'], ['device', 'added', 'C', null],
    ['link', 'removed', 'A|ether1~B|ether1', null], ['link', 'added', 'A|ether2~B|ether2', null], ['link', 'added', 'B|ether9~C|ether1', null],
    ['vlan', 'removed', 'A|10', null], ['vlan', 'added', 'A|20', null],
    ['ip', 'changed', '10.0.0.1', 'interface'],
    ['finding', 'added', '["C01","device:C"]', null], ['finding', 'added', '["K01","link:A|ether2~B|ether2"]', null]]);
  const ver = r.items[0];
  assert.deepStrictEqual([ver.before, ver.after, ver.message], ['7.12.1 (stable)', '7.13 (stable)', 'A 軟體版本：7.12.1 (stable) → 7.13 (stable)']);
  assert.deepStrictEqual(r.items.find((i) => i.category === 'ip').after, [{ ep: 'A|ether2', address: '10.0.0.1/24' }]);
  assert.deepStrictEqual([r.summary.added, r.summary.removed, r.summary.changed, r.summary.byCategory.finding.added], [6, 2, 2, 2]);
  assert.strictEqual(JSON.stringify([o, n]), before, '比對不可修改基準');
  // 反向比對：新增與移除互換
  const back = S.compare.snapshots(S.query(n), S.query(o));
  assert.deepStrictEqual([back.summary.added, back.summary.removed, back.summary.changed], [2, 6, 2]);
  // 同一份基準：沒有差異（行號改變不算）
  const s = build(read('samples/sample-bundle.txt'));
  assert.deepStrictEqual(S.compare.snapshots(S.query(s), S.query(build('# 多一行\n' + read('samples/sample-bundle.txt')))).items, []);
});
test('基準比對：MNDP 廣播網域與鄰居宣告的位址不比；finding 以鍵的多重集合比對；schema 不同時明確回報錯誤', () => {
  const mndp = ' 1 interface=ether7 mac-address=AA:00:00:00:00:09 identity=M interface-name=ether1 discovered-by=mndp';
  const o = pairNet(); const n = pairNet({ extra: mndp });
  const r = S.compare.snapshots(S.query(o), S.query(n));
  assert.ok(!r.items.some((i) => i.category === 'link'), 'MNDP 只證明廣播網域可達，不是直連鏈路的新增');
  assert.ok(r.items.some((i) => i.category === 'device' && i.key === 'M'), '鄰居發現的設備仍列為新增設備');
  // 同一台設備兩段無法辨識的內容（I01 鍵相同）：舊 1 筆、新 2 筆 → 只多 1 筆
  const junk = (k) => Array.from({ length: k }, (_, j) => `### /foo bar${j}\nxyz${j}`).join('\n');
  const a = build(`SW (10.0.0.1):\n${junk(1)}\n`); const b = build(`SW (10.0.0.1):\n${junk(2)}\n`);
  assert.strictEqual(count(a, 'I01') + 1, count(b, 'I01'));
  const fd = S.compare.snapshots(S.query(a), S.query(b)).items.filter((i) => i.category === 'finding');
  assert.deepStrictEqual(fd.map((i) => [i.change, i.after.id]), [['added', 'I01']]);
  assert.ok(/bar1/.test(fd[0].message), '訊息相同的先配對，多出來的是第二段');
  const hearsayIp = S.query(o).ipAddresses().filter((x) => x.hearsay);
  assert.ok(S.compare.snapshots(S.query(o), S.query(o)).items.every((i) => i.category !== 'ip') && Array.isArray(hearsayIp));
  // schema 不同
  const old = JSON.parse(JSON.stringify(o)); old.meta.schema = 'ssot-snapshot/1';
  const bad = S.compare.snapshots(S.query(old), S.query(o));
  assert.strictEqual(bad.errors.length, 1);
  assert.ok(/schema 不同（舊：ssot-snapshot\/1，新：ssot-snapshot\/2）/.test(bad.errors[0]), bad.errors[0]);
  assert.deepStrictEqual(bad.items, []);
  assert.deepStrictEqual(bad.warnings, [], 'schema 不同時不比對，也沒有提示');
});
test('基準比對：版本或命名規則不同時照常比對，warnings 依 version、profile 的順序說明；相同時 warnings 為空', () => {
  const o = pairNet(); const n = pairNet({ ver: '7.13 (stable)' });
  const same = S.compare.snapshots(S.query(o), S.query(n));
  assert.deepStrictEqual(same.warnings, []);
  // 程式版本不同：items 與版本相同時一樣，只多提示
  const old = JSON.parse(JSON.stringify(o)); old.meta.version = '2.7.0';
  const v = S.compare.snapshots(S.query(old), S.query(n));
  assert.deepStrictEqual([v.errors, v.items], [[], same.items]);
  assert.deepStrictEqual(v.warnings.map((w) => [w.kind, w.before, w.after]), [['version', '2.7.0', S.VERSION]]);
  assert.strictEqual(v.warnings[0].message, `版本不同（2.7.0 → ${S.VERSION}）：新版才有的檢查會顯示為新出現，不代表網路改變`);
  // 命名規則不同（沒有 → 有、id 或 version 不同）；舊基準沒有 version 欄位時寫「未標示」
  const text = 'SW_A (10.0.0.1):\n### /ip neighbor print detail\n 0 interface=ether1 mac-address=AA:00:00:00:00:01 identity=TPE_FW_01 interface-name=port1\n';
  const plain = build(text); const named = build(text, { profile: { id: 't', classify: [{ match: '_FW_', kind: 'firewall' }] } });
  const p = S.compare.snapshots(S.query(plain), S.query(named));
  assert.deepStrictEqual(p.warnings.map((w) => [w.kind, w.before, w.after]), [['profile', null, { id: 't', version: '1' }]]);
  assert.ok(/^命名規則不同（沒有 → t（版本 1））：/.test(p.warnings[0].message), p.warnings[0].message);
  const named2 = JSON.parse(JSON.stringify(named)); named2.meta.profile.version = '2'; delete named2.meta.version;
  const both = S.compare.snapshots(S.query(named2), S.query(named));
  assert.deepStrictEqual(both.warnings.map((w) => [w.kind, w.before, w.after]), [['version', null, S.VERSION], ['profile', { id: 't', version: '2' }, { id: 't', version: '1' }]]);
  assert.ok(/^版本不同（未標示 → /.test(both.warnings[0].message) && /t（版本 2） → t（版本 1）/.test(both.warnings[1].message), JSON.stringify(both.warnings));
  assert.deepStrictEqual(S.compare.snapshots(S.query(named), S.query(JSON.parse(JSON.stringify(named)))).warnings, [], '內容相同的 profile 不提示');
});
test('由基準產生預期資料（ssot-expected/1）：已收集設備、雙向確認的鏈路、VLAN；和同一份基準比對全部 ok', () => {
  const s = build(read('samples/sample-bundle.txt')); const Q = S.query(s);
  const e = JSON.parse(JSON.stringify(S.compare.expectedFrom(Q)));
  assert.strictEqual(e.schema, 'ssot-expected/1');
  assert.strictEqual(e.devices.length, s.meta.stats.collected);
  assert.ok(e.devices.every((d) => d.kind));
  assert.strictEqual(e.links.length, s.model.links.filter((l) => l.verified && l.evidenceScope === 'interface-adjacency').length);
  assert.strictEqual(e.vlans.length, s.model.vlans.length);
  const r = S.compare(Q, e);
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.items.length > 0 && r.items.every((i) => i.status === 'ok'), JSON.stringify(r.items.filter((i) => i.status !== 'ok').slice(0, 3)));
  assert.deepStrictEqual(S.compare.expectedFrom(Q), S.compare.expectedFrom(S.query(build(read('samples/sample-bundle.txt')))), '可重現');
  // 同一對設備另有 MNDP 觀察（例如在 bridge 上）時，LLDP 確認的鏈路仍是 ok；改過的設備與鏈路比得出差異
  const p = pairNet({ extra: ' 1 interface=ether5 mac-address=AA:00:00:00:00:11 identity=A interface-name=ether5 discovered-by=mndp' });
  assert.ok(p.model.links.some((l) => l.evidenceScope === 'broadcast-domain' && l.a.startsWith('A|') && l.b.startsWith('B|')), '同一對設備要另有 MNDP 鏈路');
  const pe = S.compare.expectedFrom(S.query(p));
  assert.deepStrictEqual(pe.links, [{ a: 'A ether1', b: 'B ether1' }]);
  assert.ok(S.compare(S.query(p), pe).items.every((i) => i.status === 'ok'));
  const moved = S.compare(S.query(pairNet({ port: 'ether2' })), pe);
  assert.ok(moved.items.some((i) => i.type === 'link' && i.status !== 'ok'));
  assert.deepStrictEqual(Object.keys(S.compare.expectedFrom(Q, { strict: true })).filter((k) => k.startsWith('strict')), ['strictDevices', 'strictLinks']);
});

// ------------------------------------------------------------------ 新舊比對的性質測試（S.compare.snapshots）
/** 字串替換，且必須恰好替換一次（範例資料改版時明確失敗，而不是悄悄沒改到）。 */
const replaceOnce = (text, from, to, what) => {
  const n = text.split(from).length - 1;
  assert.strictEqual(n, 1, `${what}：範例資料中「${String(from).slice(0, 60)}」應恰好出現 1 次，實際 ${n} 次`);
  return text.replace(from, to);
};
/** 從範例資料改出的「新」基準：刪一條鏈路（兩端的 LLDP 項目）、改一個 VLAN、改一個遮罩、加一條 WAN 可連入的 accept、收窄一條既有放行。 */
function mutatedSample() {
  let t = read('samples/sample-bundle.txt');
  // TPE_CORE_RT_01 qsfpplus2-1 ⇄ TPE_CORE_RT_02 qsfpplus2-1：兩端各一筆鄰居項目（編號行＋縮排的續行）
  t = t.replace(/^ +\d+ +interface=qsfpplus2-1 address=10\.1\.10\.[23] [^\n]*\n(?: {4}[^\n]*\n)*/gm, (m) => { mutatedSample.dropped++; return ''; });
  // TPE_ACC_SW_01 的 VLAN 30 → 31、管理位址 /24 → /25（這兩行相鄰，合起來在範例中唯一）
  const VLAN30 = 'untagged=ether9,ether10,ether11,ether12,ether13,ether14,ether15,ether16 vlan-ids=';
  t = replaceOnce(t, `${VLAN30}30\n/ip address add address=10.1.10.21/24 interface=vlan10`, `${VLAN30}31\n/ip address add address=10.1.10.21/25 interface=vlan10`, 'VLAN 與遮罩');
  t = replaceOnce(t, '/ip firewall filter\nadd action=accept chain=input \\\n', '/ip firewall filter\nadd action=accept chain=input dst-port=3389 in-interface-list=WAN protocol=tcp\nadd action=accept chain=input \\\n', '防火牆');
  // 既有的 winbox 放行加上來源限制（條件變窄 → firewall 的 match 改變）
  t = replaceOnce(t, 'dst-port=8291 in-interface=ether47 \\\n    protocol=tcp\n', 'dst-port=8291 in-interface=ether47 \\\n    protocol=tcp src-address=198.51.100.0/24\n', '防火牆條件');
  return t;
}
mutatedSample.dropped = 0;
test('比對性質：自己比自己為 0；A→B 的新增／移除與 B→A 互換、改變互相對應；只改 finding 訊息不算差異；新增 WAN 放行是 new-exposure', () => {
  const A = build(read('samples/sample-bundle.txt'));
  mutatedSample.dropped = 0; const B = build(mutatedSample());
  assert.strictEqual(mutatedSample.dropped, 2, '要刪掉兩端各一筆鄰居項目');
  const QA = S.query(A); const QB = S.query(B);
  const diff = (x, y) => { const r = S.compare.snapshots(x, y); assert.deepStrictEqual(r.errors, []); return r; };
  // 同一份：0 個 item（兩份都試）
  assert.deepStrictEqual(diff(QA, QA).items, []);
  assert.deepStrictEqual(diff(QB, QB).items, []);
  assert.deepStrictEqual(diff(QA, S.query(build(read('samples/sample-bundle.txt')))).items, [], '重新建立的同一份輸入也是 0');
  const ab = diff(QA, QB); const ba = diff(QB, QA);
  const keysOf = (r, change) => r.items.filter((i) => i.change === change).map((i) => `${i.category}|${i.key}`).sort();
  // 刻意的改變都有出現
  const has = (cat, change, key) => ab.items.some((i) => i.category === cat && i.change === change && (key === undefined || i.key === key));
  assert.ok(has('link', 'removed', 'TPE_CORE_RT_01|qsfpplus2-1~TPE_CORE_RT_02|qsfpplus2-1'), '刪掉的鏈路');
  // 埠的 pvid 仍是 30，所以 VLAN 30 仍在（隱含的 VLAN）；只多出 31
  assert.ok(has('vlan', 'added', 'TPE_ACC_SW_01|31') && !has('vlan', 'removed', 'TPE_ACC_SW_01|30'), '改掉的 VLAN');
  assert.ok(ab.items.some((i) => i.category === 'ip' && i.change === 'changed' && i.key === '10.1.10.21' && i.field === 'address'), '改掉的遮罩');
  assert.ok(ab.items.some((i) => i.category === 'firewall' && i.change === 'changed' && i.field === 'match' && i.before.key !== i.key), '收窄的防火牆規則');
  assert.ok(has('firewall', 'added') && has('finding', 'added') && has('finding', 'removed'), JSON.stringify(ab.summary));
  // A→B 的新增＝B→A 的移除（鍵完全相同，含重複的 finding 鍵）
  assert.deepStrictEqual(keysOf(ab, 'added'), keysOf(ba, 'removed'));
  assert.deepStrictEqual(keysOf(ab, 'removed'), keysOf(ba, 'added'));
  assert.deepStrictEqual([ab.summary.added, ab.summary.removed, ab.summary.changed], [ba.summary.removed, ba.summary.added, ba.summary.changed]);
  // 改變：同類別、同欄位、before／after 互換。防火牆 match 改變的鍵是「新」規則的鍵、舊的在 before.key，所以反向時兩者互換
  const chg = (r) => r.items.filter((i) => i.change === 'changed').map((i) => (i.category === 'firewall' && i.field === 'match'
    ? JSON.stringify([i.category, i.field, i.before.key, i.key]) : JSON.stringify([i.category, i.field, i.key, i.before, i.after]))).sort();
  const chgRev = (r) => r.items.filter((i) => i.change === 'changed').map((i) => (i.category === 'firewall' && i.field === 'match'
    ? JSON.stringify([i.category, i.field, i.key, i.before.key]) : JSON.stringify([i.category, i.field, i.key, i.after, i.before]))).sort();
  assert.ok(chg(ab).length > 0, '至少要有一筆改變');
  assert.deepStrictEqual(chg(ab), chgRev(ba));
  // 只改 finding 的訊息：findingKey 不變，比對沒有任何 finding 的新增或移除
  const A2 = JSON.parse(JSON.stringify(A)); A2.findings.forEach((f) => { f.message += '（訊息改寫）'; });
  const QA2 = S.query(A2);
  assert.deepStrictEqual(A2.findings.map(QA2.findingKey), A.findings.map(QA.findingKey));
  const m = diff(QA, QA2);
  assert.deepStrictEqual(m.items.filter((i) => i.category === 'finding'), []);
  assert.deepStrictEqual(m.summary.byCategory.finding, { added: 0, removed: 0, changed: 0 });
  // 新增的 WAN 放行：對應的 item 是 new-exposure，且新基準有一筆指向它的 F03
  const fwAdded = ab.items.filter((i) => i.category === 'firewall' && i.change === 'added');
  assert.deepStrictEqual(fwAdded.map((i) => [i.after.match, i.effect]), [[{ 'dst-port': '3389', 'in-interface-list': 'WAN', protocol: 'tcp' }, 'new-exposure']]);
  assert.ok(B.findings.some((f) => f.id === 'F03' && f.entities.some((e) => e.type === 'rule' && e.key === fwAdded[0].key)));
  // 反向（拿掉這條）是移除、放行變少，不是 new-exposure
  assert.deepStrictEqual(ba.items.filter((i) => i.category === 'firewall' && i.change !== 'changed').map((i) => [i.change, i.key, i.effect]), [['removed', fwAdded[0].key, 'more-restrictive']]);
});
