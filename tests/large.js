// 壓力測試：只在 node tests/run.js --large 時載入，排在所有測試之後。時間上限由 run.js 依 SSOT_LARGE_MAX_MS 決定後傳入。
'use strict';
const assert = require('assert');
const { S, build, count, gen, test } = require('./lib.js');

module.exports = function registerLarge(LARGE_MAX_MS) {
  test('壓力：約 1000 台設備在時間內完成，且乾淨網路沒有誤報', () => {
    const text = gen(['--sites', '40', '--access', '24']);
    const t = Date.now(); const s = build(text); const ms = Date.now() - t;
    console.log(`      ${s.meta.stats.collected} 台已收集、${s.meta.stats.devices} 個節點、${s.meta.stats.links} 條鏈路、${s.meta.stats.macs} 個 MAC：${ms} ms`);
    assert.ok(s.meta.stats.collected >= 1000);
    assert.ok(ms < LARGE_MAX_MS, `耗時 ${ms} ms，超過上限 ${LARGE_MAX_MS} ms（SSOT_LARGE_MAX_MS）`);
    assert.strictEqual(s.meta.stats.findings.error + s.meta.stats.findings.warn, 0);
    assert.deepStrictEqual([count(s, 'I03'), s.blocks.filter((b) => b.unrecognizedLines.length).length], [0, 0], '產生的輸出每一行都要認得');
    // 核心路由器都有 defconf 風格的防火牆：要真的解析到規則，且 F 類沒有任何發現
    assert.ok(s.meta.stats.firewallRules >= 80 * 9, `防火牆規則 ${s.meta.stats.firewallRules} 條`);
    assert.deepStrictEqual(s.findings.filter((f) => f.id.startsWith('F')).map((f) => f.id), []);
    assert.ok(s.model.firewallZones.filter((z) => z.status === 'ok').length >= 80, '每台核心路由器都判斷得出 WAN');
    // L2／L3 視圖的查詢（M1）：建立 Q 不預先算，第一次呼叫才算；各自都要在畫面可接受的時間內
    const time = (fn) => { const t0 = Date.now(); const r = fn(); return [r, Date.now() - t0]; };
    const [Q, qMs] = time(() => S.query(s));
    const [ids, idMs] = time(() => Q.vlanIds());
    const [vc, vcMs] = time(() => Q.vlanCarriers(ids.includes(20) ? 20 : ids[0]));
    const [pg, pgMs] = time(() => Q.portGraph());
    const [pa, paMs] = time(() => Q.portGraph({ ports: 'all' }));
    const [sg, sgMs] = time(() => Q.subnetGraph({ routes: true }));
    console.log(`      S.query ${qMs} ms；vlanIds ${idMs} ms（${ids.length} 個）；vlanCarriers ${vcMs} ms（${vc.links.length} 條）；`
      + `portGraph ${pgMs} ms（${pg.ports.length} 埠、${pg.edges.length} 邊）；ports: all ${paMs} ms（${pa.ports.length} 埠）；`
      + `subnetGraph＋routes ${sgMs} ms（${sg.subnets.length} 子網、${sg.nodes.length} 節點、${sg.edges.length} 邊、${sg.routes.length} 路由）`);
    [vcMs, pgMs, paMs, sgMs].forEach((x) => assert.ok(x < LARGE_MAX_MS / 4, `L2／L3 查詢耗時 ${x} ms`));
    assert.ok(pg.edges.length > 1000 && sg.subnets.length > 100);
    // L4（M2）：zone、可達性、zone 矩陣（L0）與下鑽、規則影響；查詢時計算，不寫進 Snapshot
    const [zs, zMs] = time(() => Q.zones());
    const [rc, rMs] = time(() => Q.reach('10.1.30.11', '10.40.20.11', { proto: 'tcp', port: 443 }));
    const [mx, mMs] = time(() => Q.zoneMatrix());
    const [cell, cMs] = time(() => Q.zoneCell('vlan:30', 'vlan:20'));
    const fwd = Q.firewallRules().find((r) => r.chain === 'forward' && r.action === 'drop' && r.match['in-interface-list'] === 'WAN');
    const [im, iMs] = time(() => Q.ruleImpact(fwd.key));
    console.log(`      zones ${zMs} ms（${zs.zones.length} 個 zone、${zs.subnets.length} 個網段）；reach ${rMs} ms（${rc.verdict}，${rc.paths.length} 條路徑）；`
      + `zoneMatrix ${mMs} ms（${mx.stats.representatives} 個代表位址、${mx.stats.evaluations} 次判斷）；zoneCell ${cMs} ms（${cell.groups.length} 列）；ruleImpact ${iMs} ms（${im.total.evaluations} 筆）`);
    assert.strictEqual(rc.verdict, 'allow');
    assert.ok(mx.stats.evaluations > 50000);
    assert.ok(mx.cells.filter((c) => c.status !== 'empty').every((c) => c.status === 'allow'), '乾淨網路的內部 VLAN 之間全通');
    [zMs, rMs, mMs, cMs, iMs].forEach((x) => assert.ok(x < LARGE_MAX_MS / 4, `L4 查詢耗時 ${x} ms`));
    assert.strictEqual(s.model.zoneMatrix, undefined, '矩陣不寫進 Snapshot');
  });
};
