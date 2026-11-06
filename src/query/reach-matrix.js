/*
 * L4 引擎：zone 矩陣、格子下鑽與規則影響（S.reach._.matrixPart，src/query/reach.js 的 makeEngine 呼叫）。
 *  - Q.zoneMatrix／Q.zoneMatrixSteps（L0）：每個 zone 的代表位址 × 目的 × service 等價類的判斷，記進格子；
 *  - Q.zoneCell（L1／L2）：一格的來源組與牽涉的規則；Q.ruleImpact：牽涉到某條規則的判斷與停用它時改變的結果。
 * 必須在 src/query/reach-zones.js 之後載入（tools/core-files.js）。
 */
(function (S) {
  'use strict';
  const IP = S.ip;
  const K = S.keys;
  const U = S.util;
  const { deepFreeze, SERVICES, svcId, runAll, slicer } = S.reach._;

  /** E：reach.js 的 base 建立的 engine 物件；加上 matrix、matrixSteps、cell、ruleImpact。 */
  S.reach._.matrixPart = function matrixPart(E) {
    const { Q, m, F, ownerDev, srcLocation, netDev, ref, findAtom, ownIps, ipv6Devices, normProto, normPort,
      evaluate, skipOf, involves, deniedByOf, zones, zoneOf, repsOf, vipsOf, virtualOf } = E;

    function servicesOf(list) {
      if (list != null) {
        if (!Array.isArray(list) || !list.length) throw new TypeError('services 必須是非空陣列，例如 [{ proto: "tcp", port: 443 }]');
        return list.map((s) => { const proto = normProto(s && s.proto); return { proto, port: normPort(proto, s.port == null ? null : s.port) }; })
          .filter((s, i, a) => a.findIndex((x) => svcId(x) === svcId(s)) === i);
      }
      const extra = [];
      m.firewallRules.forEach((r) => {
        if (r.family !== 'ip' || r.table !== 'nat' || r.disabled || r.action !== 'dst-nat' || r.match['dst-port'] === undefined) return;
        const p = r.match.protocol && !F.splitNeg(r.match.protocol).neg ? F.protoName(F.splitNeg(r.match.protocol).body.split(',')[0]) : 'tcp';
        const v = F.parseVal('dst-port', r.match['dst-port']);
        if (v.kind === 'ranges' && !v.neg && F.PORT_PROTOCOLS.has(p)) extra.push({ proto: p, port: Number(v.items[0][0]) });
      });
      const all = SERVICES.map((s) => ({ proto: s.proto, port: s.port })).concat(extra);
      const PO = ['icmp', 'tcp', 'udp'];
      return all.filter((s, i, a) => a.findIndex((x) => svcId(x) === svcId(s)) === i)
        .sort((a, b) => (PO.indexOf(a.proto) + 1 || 9) - (PO.indexOf(b.proto) + 1 || 9) || U.cmp(a.proto, b.proto) || (a.port || 0) - (b.port || 0));
    }
    /**
     * 格子的狀態：確定的允許不被「無法判斷」藏起來（暴露存在就要看得到）。
     *   允許與拒絕都有 → partial；只有允許（另有無法判斷）→ allow；沒有允許、有無法判斷 → unknown（無法判斷的可能是允許，拒絕不能當結論）。
     * 有確定的結果又有無法判斷的組合時，另以 incomplete（incompleteOf）標示「部分無法判斷」。
     */
    const STATUS = (c) => (c.allow && c.deny ? 'partial' : c.allow ? 'allow' : c.unknown ? 'unknown' : c.deny ? 'deny' : 'empty');
    const incompleteOf = (c) => c.unknown > 0 && c.allow > 0;
    const matrixCache = new Map();
    /**
     * service 的等價類：協定與埠對所有規則的條件結果相同的 service 只算一次（結果完全相同，只差最後的埠）。
     * 協定：規則提到的協定各自一類，其他依有沒有埠分兩類；埠：規則的 dst-port／port 邊界切出的區段。回傳 [[service 索引]]，依第一個索引排序。
     */
    let svcBounds = null;
    function svcClasses(services) {
      if (!svcBounds) {
        const protos = new Set(); const ports = new Set([0]);
        m.firewallRules.forEach((r) => {
          if (r.family !== 'ip') return;
          if (r.match.protocol !== undefined) F.splitNeg(r.match.protocol).body.split(',').forEach((p) => protos.add(F.protoName(p.trim().toLowerCase())));
          ['dst-port', 'port'].forEach((k) => {
            if (r.match[k] === undefined) return;
            const v = F.parseVal(k, r.match[k]);
            if (v.kind === 'ranges') v.items.forEach(([a, b]) => { ports.add(Number(a)); ports.add(Number(b) + 1); }); else ports.add(NaN);
          });
        });
        svcBounds = { protos, ports: ports.has(NaN) ? null : Float64Array.from(Array.from(ports).sort((a, b) => a - b)) };
      }
      const keyOf = (s) => {
        const p = svcBounds.protos.has(s.proto) ? s.proto : F.PORT_PROTOCOLS.has(s.proto) ? '~port' : '~noport';
        const pt = s.port == null ? -1 : svcBounds.ports ? findAtom(svcBounds.ports, s.port) : s.port; // 無法解析的埠清單：每個埠各自一類
        return p + '|' + pt;
      };
      const out = new Map();
      services.forEach((s, i) => U.getOr(out, keyOf(s), () => []).push(i));
      return Array.from(out.values());
    }
    function* matrixRawSteps(opts) {
      const o = opts || {};
      const zs = zones(o); zs.optsRaw = o;
      const services = servicesOf(o.services);
      const ck = JSON.stringify([zs.opts.profHash, zs.opts.sources, services.map(svcId)]);
      if (matrixCache.has(ck)) return matrixCache.get(ck);
      yield { stage: 'reps', done: 0, total: 2 };
      // 代表位址、dst-nat 入口與虛擬 zone 各算一段（1000 台時合起來接近 100 ms，分開讓出）
      const reps = repsOf(zs);
      yield { stage: 'reps', done: 1, total: 2 };
      const vips = vipsOf(zs); const vz = virtualOf(reps);
      const realIds = zs.zones.map((z) => z.id);
      const srcReps = []; realIds.forEach((z) => (reps.get(z) || []).forEach((r) => srcReps.push(r)));
      const memberN = srcReps.length;
      vz.extSrc.forEach((r) => srcReps.push(r));
      const targets = srcReps.slice(0, memberN).concat(vips, vz.extDst, vz.selfDst);
      // 列（來源）：實際的 zone＋外部；欄（目的）：再加網路設備（管理）
      const allZones = zs.zones.concat(vz.zones);
      const rowIds = allZones.filter((z) => !z.dstOnly).map((z) => z.id); const zoneIds = allZones.map((z) => z.id);
      const cells = new Map();
      const cellOf = (a, b) => U.getOr(cells, a + '\u0000' + b, () => ({ src: a, dst: b, recs: [] }));
      const classes = svcClasses(services);
      // 目的是設備本身時，localService 依埠找那台設備的管理服務（/ip service：停用或 available-from 不含來源就拒絕），
      // 規則沒提到的埠不一定行為相同：同一類再依「這台設備在這個埠的服務」（沒有、或啟用與允許的來源）分開
      const devClassMemo = new Map();
      const svcSig = (dev, s) => { if (s.proto !== 'tcp' || s.port == null) return '-'; const sv = Q.ipServicesOf(dev).find((x) => x.port === s.port); return sv ? (sv.enabled ? '1' : '0') + '|' + sv.addresses.slice().sort().join(',') : '-'; };
      const classesFor = (t) => (t.via !== 'device' ? classes : U.getOr(devClassMemo, t.dev, () => classes.flatMap((sis) => {
        const by = new Map(); sis.forEach((si) => U.getOr(by, svcSig(t.dev, services[si]), () => []).push(si));
        return Array.from(by.values());
      })));
      // 判斷次數的上限（來源代表 × 目的 × service 等價類，扣掉來源與目的相同的）只用來回報進度
      const total = srcReps.length * targets.reduce((n, t) => n + classesFor(t).length, 0);
      let done = 0;
      /** 一個判斷（sum，service 類 group 的代表）記進它的格子。 */
      const record = (a, ai, t, ti, tip, group, sum) => {
        const rp = services[group[0]].port;
        const fv0 = (sum.final && sum.final.vrf) || t.vrf;
        // dst-nat 的入口只算真的被改寫的；設備本身的目的只算真的送到那台設備的（重疊位址在來源的 VRF 送達別處時不算）
        if ((t.via === 'nat' && !sum.nat) || (t.via === 'device' && (fv0 !== t.vrf || (sum.final && sum.final.dst !== t.ip)))) return;
        // 目的 zone：NAT 改寫了目的時依改寫後的位址；送達的 VRF 和目的代表的 VRF 不同時（重疊的位址在來源的 VRF 就送達了）依送達的 VRF
        let dz = t.zone;
        if (sum.final && (sum.final.dst !== tip || (fv0 !== t.vrf && sum.verdict === 'allow'))) { const z = zoneOf(sum.final.dst, o, fv0); if (z) dz = z.zone; }
        const c = cellOf(a.zone, dz);
        for (const si of group) c.recs.push({ ai, ti, si, sum, rp });
      };
      yield { stage: 'evaluate', done, total };
      const due = slicer();
      for (let ai = 0; ai < srcReps.length; ai++) {
        const a = srcReps[ai];
        for (let ti = 0; ti < targets.length; ti++) {
          const t = targets[ti];
          for (const sis of classesFor(t)) {
            done++;
            // 來源與目的是同一個代表位址：zone 內同網段的組合改用同一個區段的第二個位址（沒有就略過）
            const same = a.ip === t.ip && a.vrf === t.vrf;
            if (same && !(t.via === 'member' && t.peer)) continue;
            // 外部經非 main VRF 的入口：不連到設備本身的服務（服務在 main，見 l4Entries）；
            // 外部到網段：只用入口 VRF 的代表位址（同暴露清單的 routed 段；其他 VRF 的重疊位址在入口的 VRF 是另一個目的）
            if (a.via === 'external' && ((t.via === 'device' && a.vrf !== K.MAIN_VRF) || (t.via === 'member' && t.vrf !== a.vrf))) continue;
            const tip = same ? t.peer : t.ip;
            const sum0 = evaluate(a.ip, tip, services[sis[0]], 'atom', null, a.entry || null, a.vrf).sum;
            // 不是設備本身的目的，卻送到某台網路設備自己的位址（重疊網段在另一個 VRF 的擁有者、dst-nat 到設備）：
            // 那台設備的 /ip service 依埠不同，同一類再依服務分開判斷（同 classesFor 對設備本身的目的）
            const od = t.via !== 'device' && sis.length > 1 && sum0.final && sum0.final.dst ? ownerDev(sum0.final.dst, sum0.final.vrf || t.vrf) : null;
            if (od && netDev(od)) {
              const by = new Map(); sis.forEach((si) => U.getOr(by, svcSig(od, services[si]), () => []).push(si));
              Array.from(by.values()).forEach((g) => record(a, ai, t, ti, tip, g, g[0] === sis[0] ? sum0 : evaluate(a.ip, tip, services[g[0]], 'atom', null, a.entry || null, a.vrf).sum));
            } else record(a, ai, t, ti, tip, sis, sum0);
            if (due() && done < total) yield { stage: 'evaluate', done, total };
          }
        }
      }
      // 跑完才寫進快取：中途放棄的 generator 不會留下不完整的結果
      if (matrixCache.has(ck)) return matrixCache.get(ck);
      const byId = new Map(allZones.map((z) => [z.id, z]));
      const res = { zs, services, srcReps, targets, cells, zoneIds, rowIds, allZones, byId, memberN, vz, natN: vips.length, opts: o };
      matrixCache.set(ck, res);
      return res;
    }
    const matrixRaw = (opts) => runAll(matrixRawSteps(opts));
    /** 一格的摘要（L0 的格子）：逐筆累加（add），最後 finish；分段計算時可以在記錄之間讓出。 */
    function cellAcc(mx, c) {
      const counts = { allow: 0, deny: 0, unknown: 0, total: 0 };
      const bySvc = mx.services.map(() => ({ allow: 0, deny: 0, unknown: 0, total: 0 }));
      // 拒絕分成路由沒到（noRoute）與防火牆擋下（filter），合計等於 counts.deny
      const deniedBy = { noRoute: 0, filter: 0 }; const deniedBySvc = mx.services.map(() => ({ noRoute: 0, filter: 0 }));
      // 規則依（id, verdict）累計：兩層 Map，不必每筆記錄都組合字串鍵（1000 台時有數十萬筆）；攤平後的順序與「第一次出現」相同，見 flatRules
      const rules = new Map(); const reasons = new Map();
      // 同一個目的（或來源）與 service 出現過的結果：數字鍵（索引 × service 數＋service 索引）→ 位元（允許 1、拒絕 2；兩種都有是 3）。
      // 用數字不用 Set：1000 台時有數十萬個鍵，每個 Set 都是一個物件（GC 的負擔）
      const byDst = new Map(); const bySrc = new Map(); const ns = mx.services.length;
      const add = (r) => {
        const v = r.sum.verdict; counts[v]++; counts.total++; bySvc[r.si][v]++; bySvc[r.si].total++;
        if (v === 'deny') { const k = deniedByOf(r.sum); deniedBy[k]++; deniedBySvc[r.si][k]++; }
        r.sum.decisive.forEach((x, id) => {
          let byV = rules.get(id); if (!byV) { byV = new Map(); rules.set(id, byV); }
          let e = byV.get(x.verdict); if (!e) { e = Object.assign({ id, count: 0 }, x); byV.set(x.verdict, e); }
          e.count++;
        });
        if (v === 'unknown') r.sum.reasons.forEach((x) => reasons.set(x.code, (reasons.get(x.code) || 0) + 1));
        if (v !== 'unknown') { const bit = v === 'allow' ? 1 : 2; const kd = r.ti * ns + r.si; const ks = r.ai * ns + r.si; byDst.set(kd, (byDst.get(kd) | 0) | bit); bySrc.set(ks, (bySrc.get(ks) | 0) | bit); }
      };
      return { add, finish: () => cellFinish(mx, c, { counts, bySvc, deniedBy, deniedBySvc, rules: flatRules(rules), reasons, byDst, bySrc }) };
    }
    /**
     * 兩層的規則累計攤平成一層（cellFinish 只用 values()）：同一個 id 的各結果依第一次出現的順序；
     * 不同 id 之間的順序由 cellFinish 依 count 與 id 排序決定，所以結果與依「第一次出現」排列的一層 Map 相同。
     */
    const flatRules = (rules) => { const out = []; rules.forEach((byV) => byV.forEach((e) => out.push(e))); return out; };
    function cellSummary(mx, c) { const acc = cellAcc(mx, c); c.recs.forEach(acc.add); return acc.finish(); }
    function cellFinish(mx, c, { counts, bySvc, deniedBy, deniedBySvc, rules, reasons, byDst, bySrc }) {
      const het = Array.from(byDst.values()).some((b) => b === 3) || Array.from(bySrc.values()).some((b) => b === 3);
      const ruleList = Array.from(rules.values()).sort((a, b) => b.count - a.count || U.cmp(a.id, b.id)).map(({ id, ...x }) => Object.assign({ id }, x, x.key ? { rule: ref(Q.getFirewallRule(x.key)) } : {}));
      return {
        src: c.src, dst: c.dst, diagonal: c.src === c.dst, status: STATUS(counts), incomplete: incompleteOf(counts), counts, deniedBy, heterogeneous: het,
        services: mx.services.map((s, i) => ({ service: svcId(s), proto: s.proto, port: s.port, status: STATUS(bySvc[i]), incomplete: incompleteOf(bySvc[i]), counts: bySvc[i], deniedBy: deniedBySvc[i] })),
        rule: ruleList.find((x) => x.key) || ruleList[0] || null, rules: ruleList.slice(0, 5), ruleCount: ruleList.length,
        reasons: Array.from(reasons.entries()).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || U.cmp(a.code, b.code)),
      };
    }
    const l0Cache = new Map();
    /**
     * zone 矩陣 L0 的分段計算（generator）：每一段 yield { stage: 'reps'|'evaluate'|'summary', done, total }，
     * 最後的回傳值就是 matrix(opts) 的結果，並寫進同一份快取；已有快取時不 yield、直接回傳。
     */
    function* matrixSteps(opts) {
      const mx = yield* matrixRawSteps(opts);
      const ck = JSON.stringify([mx.zs.opts.profHash, mx.zs.opts.sources, mx.services.map(svcId)]);
      if (l0Cache.has(ck)) return l0Cache.get(ck);
      const cells = [];
      // 進度以記錄數計（格子大小差很多）；空格子算一個單位
      const total = mx.rowIds.reduce((n, a) => n + mx.zoneIds.reduce((k, b) => { const c = mx.cells.get(a + '\u0000' + b); return k + (c ? Math.max(1, c.recs.length) : 1); }, 0), 0);
      let done = 0;
      yield { stage: 'summary', done, total };
      const due = slicer();
      for (const a of mx.rowIds) {
        for (const b of mx.zoneIds) {
          const c = mx.cells.get(a + '\u0000' + b);
          if (!c) {
            cells.push({ src: a, dst: b, diagonal: a === b, status: 'empty', incomplete: false, counts: { allow: 0, deny: 0, unknown: 0, total: 0 }, deniedBy: { noRoute: 0, filter: 0 }, heterogeneous: false,
              services: mx.services.map((s) => ({ service: svcId(s), proto: s.proto, port: s.port, status: 'empty', incomplete: false, counts: { allow: 0, deny: 0, unknown: 0, total: 0 }, deniedBy: { noRoute: 0, filter: 0 } })), rule: null, rules: [], ruleCount: 0, reasons: [] });
            done++;
          } else {
            const acc = cellAcc(mx, c);
            for (const r of c.recs) {
              acc.add(r); done++;
              if (due() && done < total) yield { stage: 'summary', done, total };
            }
            cells.push(acc.finish());
            if (!c.recs.length) done++;
          }
          if (due() && done < total) yield { stage: 'summary', done, total };
        }
      }
      if (l0Cache.has(ck)) return l0Cache.get(ck); // 兩個分段計算交錯時，先完成的為準（結果相同）
      const reps = mx.memberN; const evaluations = Array.from(mx.cells.values()).reduce((n, c) => n + c.recs.length, 0);
      const out = deepFreeze({
        vrf: null, vrfs: Q.vrfs().filter((v) => mx.zs.zones.some((z) => z.vrf === v)), zones: mx.allZones, services: mx.services.map((s) => ({ id: svcId(s), proto: s.proto, port: s.port })), cells,
        stats: { zones: mx.zoneIds.length, representatives: reps, natEntries: mx.natN, externalEntries: mx.vz.extSrc.length, deviceTargets: mx.vz.selfDst.length, evaluations },
        ipv6: ipv6Devices(),
      });
      l0Cache.set(ck, out);
      return out;
    }
    const matrix = (opts) => runAll(matrixSteps(opts));
    const recOut = (mx, r) => {
      const a = mx.srcReps[r.ai]; const t = mx.targets[r.ti]; const s = mx.services[r.si];
      return { src: a, dst: t, service: svcId(s), verdict: r.sum.verdict, final: r.sum.final && r.sum.final.port === r.rp ? { dst: r.sum.final.dst, port: s.port } : r.sum.final,
        rules: Array.from(r.sum.decisive.values()).map((x) => (x.key ? x.key : `policy:${x.dev}|${x.table}|${x.chain}`)),
        reasons: r.sum.verdict === 'unknown' ? U.uniq(r.sum.reasons.map((x) => x.code)) : [] };
    };
    function cell(srcZone, dstZone, opts) {
      const mx = matrixRaw(opts);
      if (!mx.byId.has(srcZone) || !mx.byId.has(dstZone)) throw new TypeError(`沒有這個 zone：${!mx.byId.has(srcZone) ? srcZone : dstZone}`);
      const c = mx.cells.get(srcZone + '\u0000' + dstZone) || { src: srcZone, dst: dstZone, recs: [] };
      const sm = cellSummary(mx, c);
      // L1：每個（來源代表、目的）一列，依 service 列出結果；結果相同的來源併成一組（規格書 §5.7）
      const pairs = new Map();
      c.recs.forEach((r) => {
        const p = U.getOr(pairs, r.ai + '|' + r.ti, () => ({ ai: r.ai, ti: r.ti, services: [] }));
        const x = recOut(mx, r); p.services.push({ service: x.service, verdict: x.verdict, final: x.final, rules: x.rules, reasons: x.reasons });
      });
      // 造成異質的記錄（與 cellSummary 的 heterogeneous 同一個依據）：heterogeneous 是「同一個目的與 service，不同來源的結果不同」
      // 或「同一個來源與 service，不同目的的結果不同」（unknown 不算）。在這樣一條有衝突的線上，結果是少數（平手時兩邊都算）的記錄造成差異。
      // 所以格子異質時至少有一組 divergent，不異質時沒有。
      const lineOf = new Map();
      const tally = (k, v) => { const e = U.getOr(lineOf, k, () => ({ allow: 0, deny: 0 })); e[v]++; };
      c.recs.forEach((r) => { if (r.sum.verdict !== 'unknown') { tally('d' + r.ti + '|' + r.si, r.sum.verdict); tally('s' + r.ai + '|' + r.si, r.sum.verdict); } });
      const minority = (k, v) => { const e = lineOf.get(k); return e.allow > 0 && e.deny > 0 && e[v] <= e[v === 'allow' ? 'deny' : 'allow']; };
      const divergentSvc = new Map(); // ai|ti → Set(service id)
      c.recs.forEach((r) => {
        const v = r.sum.verdict; if (v === 'unknown') return;
        if (minority('d' + r.ti + '|' + r.si, v) || minority('s' + r.ai + '|' + r.si, v)) U.getOr(divergentSvc, r.ai + '|' + r.ti, () => new Set()).add(svcId(mx.services[r.si]));
      });
      const rows = new Map();
      Array.from(pairs.values()).sort((p, q) => p.ti - q.ti || p.ai - q.ai).forEach((p) => {
        const sig = JSON.stringify(p.services.map((s) => [s.service, s.verdict, s.rules, s.reasons]));
        const row = U.getOr(rows, p.ti + '|' + sig, () => ({ dst: mx.targets[p.ti], srcs: [], services: p.services, div: new Set() }));
        row.srcs.push(mx.srcReps[p.ai]);
        (divergentSvc.get(p.ai + '|' + p.ti) || []).forEach((sv) => row.div.add(sv));
      });
      const groups = Array.from(rows.values()).map((r) => {
        const c2 = { allow: 0, deny: 0, unknown: 0 }; r.services.forEach((s) => { c2[s.verdict]++; });
        return { dst: r.dst, srcs: r.srcs, services: r.services, status: STATUS(c2), incomplete: incompleteOf(c2), counts: c2,
          srcDevices: U.uniq(r.srcs.flatMap((s) => { if (s.entry) return [s.entry]; const l = srcLocation(s.ip, s.vrf); return l.how === 'subnet' ? l.gateways.map((g) => g.ep || g.dev) : l.dev ? [l.dev] : []; })).sort(U.natural),
          divergent: r.div.size > 0, divergentServices: r.services.map((s) => s.service).filter((sv) => r.div.has(sv)) };
      });
      // L2：牽涉的規則
      const rules = new Map();
      c.recs.forEach((r) => {
        r.sum.decisive.forEach((x, id) => {
          const e = U.getOr(rules, id, () => ({ id, key: x.key, dev: x.dev, table: x.table, chain: x.chain, policy: !!x.policy, route: x.route || null, rule: x.key ? ref(Q.getFirewallRule(x.key)) : null, verdict: x.verdict || null, verdicts: { allow: 0, deny: 0, unknown: 0 }, services: [] }));
          e.verdicts[r.sum.verdict]++; const sv = svcId(mx.services[r.si]); if (!e.services.includes(sv)) e.services.push(sv);
        });
        if (r.sum.verdict === 'unknown') r.sum.reasons.forEach((x) => {
          if (!x.rule) return;
          const e = U.getOr(rules, x.rule.key, () => ({ id: x.rule.key, key: x.rule.key, dev: x.rule.dev, table: x.rule.table, chain: x.rule.chain, policy: false, route: null, rule: x.rule, verdicts: { allow: 0, deny: 0, unknown: 0 }, services: [] }));
          e.uncertain = (e.uncertain || 0) + 1;
        });
      });
      const ruleList = Array.from(rules.values()).map((e) => Object.assign({ uncertain: 0 }, e))
        .sort((a, b) => (b.verdicts.allow + b.verdicts.deny + b.verdicts.unknown + b.uncertain) - (a.verdicts.allow + a.verdicts.deny + a.verdicts.unknown + a.uncertain) || U.cmp(a.id, b.id));
      return deepFreeze(JSON.parse(JSON.stringify(Object.assign({}, sm, { groups, ruleDetails: ruleList }))));
    }

    // ---- 規則的影響
    function ruleImpact(key, opts) {
      const rule = Q.getFirewallRule(key);
      if (!rule) return null;
      const o = opts || {};
      const mx = matrixRaw(o);
      const limit = o.limit == null ? 50 : o.limit;
      const recs = [];
      mx.cells.forEach((c) => c.recs.forEach((r) => { if (involves(r.sum, key)) recs.push({ plane: 'transit', src: mx.srcReps[r.ai], dst: mx.targets[r.ti], svc: mx.services[r.si], sum: r.sum, cell: [c.src, c.dst] }); }));
      // 設備本身（input／output）：所有代表位址 → 這台設備的位址、這台設備的位址 → 所有目的
      if (rule.table !== 'nat' || rule.chain !== 'srcnat') {
        // 這台設備的位址（每個 VRF 分開；位址鍵排序）
        const ownAll = Q.interfacesOf(rule.dev).flatMap((i) => ownIps(i.key).map((a) => ({ ip: a.ip, vrf: K.vrf(a.vrf) })));
        const own = ownAll.filter((x, i) => ownAll.findIndex((y) => y.ip === x.ip && y.vrf === x.vrf) === i).sort((x, y) => U.natural(K.inVrf(x.ip, x.vrf), K.inVrf(y.ip, y.vrf)));
        const zoneOfIp = (ip, vrf) => { const z = zoneOf(ip, o, vrf); return z ? z.zone : null; };
        const finalZone = (sum, ip, vrf) => (sum.final && sum.final.dst ? zoneOfIp(sum.final.dst, sum.final.vrf || vrf) : zoneOfIp(ip, vrf)); // zone 以 NAT 後的位址為準
        own.forEach(({ ip, vrf }) => mx.srcReps.forEach((a) => mx.services.forEach((svc) => {
          if (a.ip === ip && a.vrf === vrf) return;
          const { sum } = evaluate(a.ip, ip, svc, 'atom', null, a.entry || null, a.vrf);
          if (involves(sum, key)) recs.push({ plane: 'device', src: a, dst: { ip, vrf, zone: zoneOfIp(ip, vrf), subnet: null, via: 'device', dev: rule.dev }, svc, sum, cell: [a.zone, finalZone(sum, ip, vrf)] });
        })));
        own.forEach(({ ip, vrf }) => mx.targets.forEach((t) => mx.services.forEach((svc) => {
          if (t.ip === ip && t.vrf === vrf) return;
          const { sum } = evaluate(ip, t.ip, svc, 'atom', null, null, vrf);
          if (involves(sum, key)) recs.push({ plane: 'device', src: { ip, vrf, zone: zoneOfIp(ip, vrf), subnet: null, via: 'device', dev: rule.dev }, dst: t, svc, sum, cell: [zoneOfIp(ip, vrf), finalZone(sum, t.ip, t.vrf) || t.zone] });
        })));
      }
      const roleOf = (r) => {
        const d = Array.from(r.sum.decisive.values()).some((x) => x.key === key);
        const u = r.sum.reasons.some((x) => x.rule && x.rule.key === key);
        return d ? 'decides' : u ? 'uncertain' : 'passes';
      };
      const cellMap = new Map();
      const skip = skipOf([key]);
      const changed = [];
      recs.forEach((r) => {
        const role = roleOf(r);
        const e = U.getOr(cellMap, r.cell.join('\u0000'), () => ({ src: r.cell[0], dst: r.cell[1], plane: r.plane, services: [], decides: 0, uncertain: 0, passes: 0, verdicts: { allow: 0, deny: 0, unknown: 0 } }));
        e[role]++; e.verdicts[r.sum.verdict]++; if (!e.services.includes(svcId(r.svc))) e.services.push(svcId(r.svc));
        const alt = evaluate(r.src.ip, r.dst.via === 'member' && r.src.ip === r.dst.ip ? r.dst.peer : r.dst.ip, r.svc, 'atom', skip, r.src.entry || null, r.src.vrf).sum;
        if (alt.verdict !== r.sum.verdict) changed.push({ src: r.src.ip, dst: r.dst.ip, srcZone: r.cell[0], dstZone: r.cell[1], service: svcId(r.svc), from: r.sum.verdict, to: alt.verdict, plane: r.plane });
      });
      const sortRec = (a, b) => U.cmp(a.srcZone || '', b.srcZone || '') || U.cmp(a.dstZone || '', b.dstZone || '') || IP.toInt(a.src) - IP.toInt(b.src) || IP.toInt(a.dst) - IP.toInt(b.dst) || U.cmp(a.service, b.service);
      const paths = recs.map((r) => ({ src: r.src.ip, dst: r.dst.ip, srcZone: r.cell[0], dstZone: r.cell[1], service: svcId(r.svc), plane: r.plane, role: roleOf(r), verdict: r.sum.verdict })).sort(sortRec);
      changed.sort(sortRec);
      const changeCounts = {}; changed.forEach((c) => { const k = c.from + '→' + c.to; changeCounts[k] = (changeCounts[k] || 0) + 1; });
      const fs = Q.findingsFor('rule', key);
      return deepFreeze(JSON.parse(JSON.stringify({
        rule: Object.assign({}, ref(rule), { stats: rule.stats || null }), shadowed: fs.some((f) => f.id === 'F01'), duplicate: fs.some((f) => f.id === 'F02'), findings: fs.map((f) => Q.findingKey(f)),
        cells: Array.from(cellMap.values()).sort((a, b) => U.cmp(a.plane, b.plane) || U.cmp(a.src || '', b.src || '') || U.cmp(a.dst || '', b.dst || '')),
        total: { evaluations: recs.length, decides: paths.filter((p) => p.role === 'decides').length, uncertain: paths.filter((p) => p.role === 'uncertain').length, passes: paths.filter((p) => p.role === 'passes').length },
        paths: paths.slice(0, limit), truncated: paths.length > limit,
        ifDisabled: { changed: changed.slice(0, limit), counts: changeCounts, total: changed.length, truncated: changed.length > limit },
      })));
    }

    Object.assign(E, { matrix, matrixSteps, cell, ruleImpact });
  };
})(globalThis.SSOT = globalThis.SSOT || {});
