// 防火牆語意的性質測試（S.infer.fw）
'use strict';
const assert = require('assert');
const { S, gen, test, fwBox, fws } = require('../lib.js');
// ------------------------------------------------------------------ 防火牆語意的性質測試（S.infer.fw）
// 固定種子的亂數產生規則組合；失敗時訊息帶種子與規則，用同一個種子就能重現。
const mulberry32 = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (rnd, xs) => xs[Math.floor(rnd() * xs.length)];
const FWGEN = {
  protocol: ['tcp', 'udp', 'icmp', '6', '17'],
  'dst-port': ['22', '80', '443', '80,443', '443,80', '22,80,443', '1000-2000', '1500', '1-65535', '22,8000-8100', '8000-8050'],
  'src-address': ['10.0.0.0/8', '10.1.0.0/16', '10.1.2.3', '192.168.1.0/24', '0.0.0.0/0', '203.0.113.0/24', '10.0.0.1-10.0.0.50', '10.0.0.10'],
  'in-interface': ['ether1', 'ether2', 'bridge1'],
  'in-interface-list': ['WAN', 'LAN', 'all', 'dynamic'], // dynamic 是內建清單，export 看不到成員：無法判斷
  'connection-state': ['new', 'established,related', 'invalid', 'established,related,untracked', 'related,established', 'new,invalid'],
};
const FW_NONDET_GEN = { limit: '10,5:packet', random: '50', nth: '2,1' };
/** 一組比對條件：每個欄位約 3 成機率出現，其中約 2 成加 !。 */
function genMatch(rnd) {
  const m = {};
  Object.keys(FWGEN).forEach((k) => { if (rnd() < 0.3) m[k] = (rnd() < 0.2 ? '!' : '') + pick(rnd, FWGEN[k]); });
  return m;
}
const fwRuleText = (r) => `/ip firewall filter add action=${r.action} chain=${r.chain}${Object.keys(r.match).map((k) => ` ${k}=${r.match[k]}`).join('')}`;
// 和 fwBox 相同的設備：WAN＝ether1、LAN＝bridge1（另加 ether2）
const FW_LISTS = [['WAN', ['ether1']], ['LAN', ['bridge1', 'ether2']]];
const K_EP = (d, i) => S.keys.ep(d, i);
const fwPropCtx = (rules) => S.infer.fw.fwContext('R', FW_LISTS.map(([name, m]) => ({ name, defined: true, include: [], exclude: [], members: m.map((x) => K_EP('R', x)) })),
  ['ether1', 'ether2', 'ether3', 'bridge1'].map((x) => K_EP('R', x)), rules);
const fwProp = (match, action = 'accept', chain = 'input') => ({ dev: 'R', family: 'ip', table: 'filter', chain, action, match, params: {}, disabled: false });
const hasUnknownList = (r) => ['in-interface-list', 'out-interface-list'].some((k) => r.match[k] !== undefined && S.infer.fw.splitNeg(r.match[k]).body === 'dynamic');
test('防火牆性質：covers 自反、遞移；前一條帶 limit／random／nth 時一律不涵蓋（固定種子，數百組規則）', () => {
  const fw = S.infer.fw;
  let rules = 0; let chains = 0; let skipped = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const rnd = mulberry32(seed);
    const rs = Array.from({ length: 32 }, () => fwProp(genMatch(rnd)));
    const ctx = fwPropCtx(rs);
    const cov = rs.map((a) => rs.map((b) => fw.covers(ctx, a, b)));
    const show = (...xs) => `種子 ${seed}：` + xs.map((r) => JSON.stringify(r.match)).join(' ／ ');
    rs.forEach((a, i) => {
      rules++;
      assert.ok(cov[i][i], `covers(a, a) 不成立；${show(a)}`);
      rs.forEach((b, j) => {
        if (!cov[i][j]) return;
        rs.forEach((c, k) => {
          if (!cov[j][k]) return;
          // 只計入非平凡的鏈：a 有條件，且 a、b、c 的條件兩兩不同（空條件的規則涵蓋一切，不算測到遞移）
          const ms = [a, b, c].map((r) => JSON.stringify(r.match));
          if (ms[0] !== '{}' && new Set(ms).size === 3) chains++;
          // 例外（依設計）：c 用了無法展開成員的清單（例如內建的 dynamic）時，covers 只接受字面相同的介面條件，
          // 不推導「a 不限介面（或 all）→ 一定涵蓋」。這是保守的近似：只會少判涵蓋（少報 F01），不會誤判。
          if (!cov[i][k] && hasUnknownList(c) && !hasUnknownList(a)) { skipped++; return; }
          assert.ok(cov[i][k], `遞移不成立：covers(a,b) 且 covers(b,c)，但 covers(a,c) 為否；${show(a, b, c)}`);
        });
      });
      // 帶不確定比對（limit、random、nth）的規則不會被當成涵蓋任何規則，包括和自己完全相同的規則
      Object.entries(FW_NONDET_GEN).forEach(([k, v]) => {
        const nd = fwProp(Object.assign({}, a.match, { [k]: v }));
        rs.concat([nd, fwProp(Object.assign({}, nd.match))]).forEach((b) => assert.strictEqual(fw.covers(ctx, nd, b), false, `${k} 的規則不可涵蓋；${show(nd, b)}`));
      });
    });
  }
  console.log(`      ${rules} 組規則、${chains} 組非平凡的涵蓋鏈；${skipped} 組因 c 用了無法展開的清單而不遞移（依設計）`);
  assert.ok(rules >= 800, `只產生 ${rules} 組規則`);
  assert.ok(chains >= 300, `只有 ${chains} 組非平凡的 a→b→c 涵蓋鏈，遞移性測得不夠（調整產生器的機率）`);
  // 上面例外的具體案例：結果是「不涵蓋」，不是錯誤的涵蓋
  const ctx = fwPropCtx([]); const any = fwProp({ 'in-interface-list': 'all' }); const none = fwProp({}); const dyn = fwProp({ 'in-interface-list': 'dynamic' });
  assert.deepStrictEqual([fw.covers(ctx, any, none), fw.covers(ctx, none, dyn), fw.covers(ctx, any, dyn), fw.covers(ctx, dyn, dyn)], [true, true, false, true]);
});
test('防火牆性質：在 chain 任意位置插入規則，其他規則的 key 不變；在 input 最前面插入 drop，F03 不會增加；不確定比對不產生 F01', () => {
  const fw = S.infer.fw;
  const ACTIONS = ['accept', 'accept', 'drop', 'reject'];
  const rulesOf = (s) => s.model.firewallRules.filter((r) => r.dev === 'R' && r.table === 'filter');
  let f03Before = 0; let f03Dropped = 0; let dupInserts = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const rnd = mulberry32(1000 + seed);
    // 約 15% 的規則帶不確定比對（limit／random／nth）
    const withNondet = (m) => { const k = pick(rnd, Object.keys(FW_NONDET_GEN)); return Object.assign(m, { [k]: FW_NONDET_GEN[k] }); };
    const gen = (chain) => fwProp(rnd() < 0.15 ? withNondet(genMatch(rnd)) : genMatch(rnd), pick(rnd, ACTIONS), chain);
    const base = Array.from({ length: 3 + Math.floor(rnd() * 5) }, () => gen(rnd() < 0.7 ? 'input' : 'forward'));
    const where = (s) => `種子 ${1000 + seed}：\n        ${s.join('\n        ')}`;
    const s0 = fwBox(base.map(fwRuleText)); const r0 = rulesOf(s0);
    // 插入：同一 chain 內任意位置；有時與既有規則的比對條件相同（簽章相同、動作可不同）
    const chain = pick(rnd, ['input', 'forward']);
    const same = base.filter((r) => r.chain === chain);
    const ins = same.length && rnd() < 0.25 ? fwProp(Object.assign({}, pick(rnd, same).match), pick(rnd, ACTIONS), chain) : gen(chain);
    const at = Math.floor(rnd() * (base.length + 1));
    const lines1 = base.map(fwRuleText); lines1.splice(at, 0, fwRuleText(ins));
    const s1 = fwBox(lines1); const r1 = rulesOf(s1);
    const added = r1[at]; assert.strictEqual(added.src[0][1] - r0[0].src[0][1], at, where(lines1));
    const rest = r1.filter((_, k) => k !== at);
    rest.forEach((n, k) => {
      const o = r0[k];
      assert.strictEqual(n.signature, o.signature, where(lines1));
      if (o.signature !== added.signature) assert.strictEqual(n.key, o.key, `插入規則後，簽章不同的規則鍵改變：${o.key} → ${n.key}\n${where(lines1)}`);
    });
    // 依設計：同一 chain 簽章相同的規則依出現順序加 #n，插在它們前面時 #n 會往後移（compare.js 已註明）；整組的鍵只多出下一個編號
    const grp0 = r0.filter((r) => r.signature === added.signature).map((r) => r.key);
    const grp1 = r1.filter((r) => r.signature === added.signature).map((r) => r.key);
    if (grp0.length) dupInserts++;
    assert.deepStrictEqual(grp1.slice(0, grp0.length).sort(), grp0.slice().sort(), where(lines1));
    assert.strictEqual(grp1.length, grp0.length + 1);
    assert.strictEqual(new Set(r1.map((r) => r.key)).size, r1.length, `規則鍵重複\n${where(lines1)}`);
    // 不確定比對：被當成「前面的規則」的 F01 都不可帶 limit／random／nth
    [s0, s1].forEach((s) => fws(s, 'F01').forEach((f) => {
      const by = rulesOf(s).find((r) => r.src[0][1] === f.evidence[1].line); // F01 的第二筆證據是涵蓋它的前一條規則
      assert.ok(!Object.keys(by.match).some((k) => fw.NONDET.has(k)), `${f.message}\n${where(lines1)}`);
    }));
    // input 最前面插入 drop：F03 只會變少；留下的 F03 都是原本就有的規則（以表內順序對回）
    const drop = fwProp(rnd() < 0.3 ? {} : genMatch(rnd), 'drop', 'input');
    const lines2 = [fwRuleText(drop)].concat(base.map(fwRuleText));
    const s2 = fwBox(lines2);
    const f03Orders = (s, shift) => fws(s, 'F03').map((f) => s.model.firewallRules.find((r) => r.key === f.entities[1].key).order - shift);
    const before = f03Orders(s0, 0); const after = f03Orders(s2, 1);
    assert.ok(after.length <= before.length, `F03 從 ${before.length} 筆增加到 ${after.length} 筆\n${where(lines2)}`);
    after.forEach((o) => assert.ok(before.includes(o), `插入 drop 後出現原本沒有的 F03（表內第 ${o} 條）\n${where(lines2)}`));
    f03Before += before.length; f03Dropped += before.length - after.length;
  }
  console.log(`      120 組 chain：F03 ${f03Before} 筆，插入 drop 後擋下 ${f03Dropped} 筆；${dupInserts} 次插入與既有規則簽章相同`);
  assert.ok(f03Before > 20 && f03Dropped > 0, `F03 ${f03Before} 筆、被 drop 擋下 ${f03Dropped} 筆：產生的規則太少觸發 F03，性質測得不夠`);
  assert.ok(dupInserts > 5, `只有 ${dupInserts} 次插入與既有規則簽章相同的規則`);
});
