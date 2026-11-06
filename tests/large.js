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
    // 規則影響要量一條真的有影響的規則：乾淨網路的內部流量在 forward 都沒有命中任何規則（預設放行），
    // forward 規則的影響都是 0 筆；input 的「!LAN 一律丟棄」會被所有代表位址往設備位址的判斷命中
    const busy = Q.firewallRules().find((r) => r.chain === 'input' && r.action === 'drop' && r.match['in-interface-list'] === '!LAN');
    const [im, iMs] = time(() => Q.ruleImpact(busy.key));
    assert.ok(im.total.evaluations > 1000 && im.total.decides > 0, `選到的規則要有影響（${im.total.evaluations} 筆）`);
    console.log(`      zones ${zMs} ms（${zs.zones.length} 個 zone、${zs.subnets.length} 個網段）；reach ${rMs} ms（${rc.verdict}，${rc.paths.length} 條路徑）；`
      + `zoneMatrix ${mMs} ms（${mx.stats.representatives} 個代表位址、${mx.stats.evaluations} 次判斷）；zoneCell ${cMs} ms（${cell.groups.length} 列）；ruleImpact ${iMs} ms（${im.total.evaluations} 筆）`);
    assert.strictEqual(rc.verdict, 'allow');
    assert.ok(mx.stats.evaluations > 50000);
    // 只看實際的 zone 之間（虛擬 zone「網路設備（管理）」另依 /ip service 判斷，出廠停用的 www-ssl 是拒絕）
    const virt = new Set(mx.zones.filter((z) => z.virtual).map((z) => z.id));
    assert.ok(mx.cells.filter((c) => c.status !== 'empty' && !virt.has(c.src) && !virt.has(c.dst)).every((c) => c.status === 'allow'), '乾淨網路的內部 VLAN 之間全通');
    [zMs, rMs, mMs, cMs, iMs].forEach((x) => assert.ok(x < LARGE_MAX_MS / 4, `L4 查詢耗時 ${x} ms`));
    // zoneMatrix 本身另有較緊的上限（預設 3333 ms，CI 的 SSOT_LARGE_MAX_MS 較大時跟著放寬）：本機約 1.2–1.6 s，改善前約 1.9–3.8 s，退化時會被抓到
    assert.ok(mMs < LARGE_MAX_MS / 6, `zoneMatrix 耗時 ${mMs} ms，超過 ${Math.round(LARGE_MAX_MS / 6)} ms（SSOT_LARGE_MAX_MS / 6）`);
    assert.strictEqual(s.model.zoneMatrix, undefined, '矩陣不寫進 Snapshot');
    // 分段計算（畫面用，不卡住主執行緒）：新的查詢介面從頭算，量每一段（兩次 next() 之間）的時間；目標每段 ≤ 50 ms
    // 每段另以 v8.GCProfiler 量那一段裡 GC 停頓的時間（矩陣的快取有數百 MB，偶爾一段會碰上 200–300 ms 的 Mark-Compact，與分段的粒度無關）
    const v8 = require('v8');
    const measure = () => {
      const Qn = S.query(s); const it = Qn.zoneMatrixSteps();
      const segs = []; const nets = []; const byStage = {}; let gcAll = 0;
      let prev = '(開始)'; let gp = new v8.GCProfiler(); gp.start(); let t1 = Date.now(); let r = it.next();
      for (;;) {
        const ms = Date.now() - t1; const gc = Math.round(gp.stop().statistics.reduce((n, x) => n + x.cost, 0) / 1000);
        segs.push(ms); nets.push(Math.max(0, ms - gc)); gcAll += gc;
        const e = byStage[prev] = byStage[prev] || { n: 0, max: 0 }; e.n++; e.max = Math.max(e.max, ms);
        if (r.done) break;
        prev = r.value.stage; gp = new v8.GCProfiler(); gp.start(); t1 = Date.now(); r = it.next();
      }
      return { Qn, r, segs, nets, byStage, gcAll, max: Math.max(...segs), netMax: Math.max(...nets) };
    };
    let run = measure();
    const report = (x) => {
      const total = x.segs.reduce((n, v) => n + v, 0); const p95 = x.segs.slice().sort((a, b) => a - b)[Math.floor(x.segs.length * 0.95)];
      console.log(`      zoneMatrixSteps ${x.segs.length} 段、共 ${total} ms（其中 GC ${x.gcAll} ms）；每段 p95 ${p95} ms、最長 ${x.max} ms、扣掉 GC 最長 ${x.netMax} ms（${Object.keys(x.byStage).map((k) => `${k} ${x.byStage[k].n} 段、最長 ${x.byStage[k].max} ms`).join('；')}）`);
      return p95;
    };
    let p95 = report(run);
    // 單段上限（扣掉 GC）：預設 100 ms，隨 SSOT_LARGE_MAX_MS 放寬（CI 是 200 ms）。機器同時跑別的行程時，偶爾一段會被搶走 CPU
    // （量過一次 430 ms，其他段都在 35 ms 內），所以超過時重量一次、取較好的一次；分段太粗的退化每次都會超過
    const SEG_MAX = Math.max(100, LARGE_MAX_MS / 200);
    if (run.netMax > SEG_MAX) { run = measure(); p95 = report(run); }
    const { Qn: Q2, r, segs } = run;
    assert.strictEqual(Q2.zoneMatrix(), r.value, '跑完分段之後 zoneMatrix 命中快取');
    assert.strictEqual(JSON.stringify(r.value), JSON.stringify(mx), '分段與同步的結果相同');
    assert.ok(run.netMax <= SEG_MAX, `分段計算扣掉 GC 最長一段 ${run.netMax} ms，超過 ${SEG_MAX} ms`);
    // p95 的上限放寬並隨 SSOT_LARGE_MAX_MS 調整（預設 200 ms），避免慢的 CI 誤判，但能抓到沒有分段的退化
    assert.ok(p95 <= Math.max(50, LARGE_MAX_MS / 100), `分段計算的 p95 是 ${p95} ms`);
    assert.ok(segs.length > 10, `只有 ${segs.length} 段`);
  });
  test('壓力：約 1000 台的暴露清單（Q.exposure）在時間內完成，且乾淨網路從 WAN 直接路由進不了內部', () => {
    // 另起一個測試、從頭算（新的 Q，沒有矩陣的快取）：放在上一個測試裡時，矩陣與分段量測的快取加上暴露清單會超過 Node 預設的 heap 上限
    // 上限預設 3600 ms（SSOT_LARGE_MAX_MS × 0.18，CI 較大時跟著放寬）：本機 80 個 WAN 入口、約 22 萬次判斷，
    // 從頭算約 0.7–1.3 s、碰上 GC 時最慢 1.8 s；上限約為一般情況的 3 倍、最慢一次的 2 倍
    const s = build(gen(['--sites', '40', '--access', '24']));
    const Q = S.query(s);
    const time = (fn) => { const t0 = Date.now(); const r = fn(); return [r, Date.now() - t0]; };
    const exposureOf = (q) => (q.exposure ? q.exposure() : S.reach.of(q).exposure());
    const [ex, eMs] = time(() => exposureOf(Q));
    console.log(`      exposure ${eMs} ms（${ex.wan.entries.length} 個 WAN 入口、${ex.limits.evaluations} 次判斷；允許 本身 ${ex.self.counts.allow}、dst-nat ${ex.dnat.counts.allow}、路由 ${ex.routed.counts.allow}）`);
    assert.deepStrictEqual([ex.status, ex.limits.truncated], ['ok', false]);
    assert.ok(ex.wan.entries.length >= 80 && ex.limits.evaluations > 100000, `判斷次數 ${ex.limits.evaluations}`);
    assert.strictEqual(ex.routed.counts.allow + ex.routed.counts.unknown, 0, '乾淨網路從 WAN 直接路由進不了內部');
    assert.ok(eMs < LARGE_MAX_MS * 0.18, `exposure 耗時 ${eMs} ms，超過 ${Math.round(LARGE_MAX_MS * 0.18)} ms（SSOT_LARGE_MAX_MS × 0.18）`);
  });
  test('壓力：約 1000 台的預檢（S.preflight）比完整建立快，且設備數與無法辨識段落相同', () => {
    const src = [{ name: 'large.txt', text: gen(['--sites', '40', '--access', '24']) }];
    let t = Date.now(); const p = S.preflight(src); const pm = Date.now() - t;
    t = Date.now(); const s = S.build(src); const bm = Date.now() - t;
    console.log(`      預檢 ${pm} ms、完整建立 ${bm} ms（${p.devices.length} 台、${p.blockCount} 個區塊）`);
    assert.strictEqual(p.devices.length, s.meta.stats.collected);
    assert.strictEqual(p.unrecognized.length, count(s, 'I01'));
    assert.ok(pm < bm, `預檢 ${pm} ms 應比完整建立 ${bm} ms 快`);
  });
};
