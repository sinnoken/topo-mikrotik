/*
 * L4 引擎：每一跳的判斷（S.reach._.evalPart，src/query/reach.js 的 makeEngine 呼叫）。
 *  - 逐跳的路徑展開是 S.trace.walker（與路由追蹤共用），這裡只以 hooks 在每一跳依 RouterOS 的處理順序套用 raw、nat（dst-nat／srcnat 改寫）、filter 與 /ip service（ADR-023 決策 3）；
 *  - 每個節點的摘要（allow／deny／unknown、原因、決定的規則）與分層結果（路由層、防火牆層，決策 4）；
 *  - evaluate：一次判斷（Q.reach、矩陣、規則影響與暴露清單共用）。
 * 必須在 src/query/reach.js 之後載入（tools/core-files.js）。
 */
(function (S) {
  'use strict';
  const IP = S.ip;
  const K = S.keys;
  const U = S.util;
  const { deepFreeze, MAX_PATHS, REASON_LAYER, checkCode, NAT_UNKNOWN } = S.reach._;

  /** E：reach.js 的 base 建立的 engine 物件；加上 evaluate、skipOf、pathsOf、rowLayers、deniedByOf、involves、reachesLocal、unsafeOfSum、unsafeReason、dedupeReasons。 */
  S.reach._.evalPart = function evalPart(E) {
    const { Q, I, name, devInfo, realEp, ref, where, reason, stage, hasRules, condReasons, srcKey, svcNum, level, single, ownIps } = E;

    // ---- NAT 改寫
    function applyDst(dev, inEp, r, st) {
      const tp = r.params['to-ports'];
      const port = tp === undefined ? st.port : /^\d+$/.test(String(tp).trim()) ? +tp : null;
      if (port === null) return { unknown: reason('nat-target', dev, `${where(r)} 的 to-ports（${tp}）是範圍，改寫後的埠不明`, { rule: ref(r) }) };
      let dst;
      if (r.action === 'dst-nat') {
        const to = single(r.params['to-addresses']);
        if (to === null) return { unknown: reason('nat-target', dev, `${where(r)} 的 to-addresses（${r.params['to-addresses']}）是範圍，改寫後的位址不明`, { rule: ref(r) }) };
        dst = to === undefined ? st.dst : to;
      } else if (r.action === 'redirect') {
        const own = (realEp(inEp) ? ownIps(inEp) : []).concat(Q.interfacesOf(dev).flatMap((i) => ownIps(i.key)));
        if (!own.length) return { unknown: reason('nat-target', dev, `${where(r)} 轉給設備自己，但這台設備沒有已知的位址`, { rule: ref(r) }) };
        dst = own[0].ip;
      } else if (r.action === 'netmap') {
        const p = S.ip.parseCidr(String(r.params['to-addresses'] || ''));
        if (!p) return { unknown: reason('nat-target', dev, `${where(r)} 的 to-addresses 無法解析，改寫後的位址不明`, { rule: ref(r) }) };
        const mask = IP.maskOf(p.len);
        dst = IP.fromInt(((IP.toInt(p.net) & mask) | (IP.toInt(st.dst) & ~mask)) >>> 0);
      } else return { unknown: reason('nat-target', dev, `${where(r)} 的動作 ${r.action} 不在可判斷的範圍`, { rule: ref(r) }) };
      const fmt = (ip, pt) => ip + (pt != null ? ':' + pt : '');
      return { st: Object.assign({}, st, { dst, port }), nat: { type: r.action, dir: 'dst', rule: ref(r), before: fmt(st.dst, st.port), after: fmt(dst, port) } };
    }
    function applySrc(dev, outEp, r, st, nextIp) {
      let src;
      if (r.action === 'masquerade') {
        const own = realEp(outEp) ? ownIps(outEp) : [];
        const hit = nextIp ? own.find((a) => a.len < 32 && IP.inNet(nextIp, S.ip.parseCidr(a.address).net, a.len)) : null;
        src = hit ? hit.ip : own.length ? own[0].ip : null;
      } else if (r.action === 'src-nat') src = single(r.params['to-addresses']) || null;
      else if (r.action === 'netmap') {
        const p = S.ip.parseCidr(String(r.params['to-addresses'] || ''));
        src = p && st.src ? IP.fromInt(((IP.toInt(p.net) & IP.maskOf(p.len)) | (IP.toInt(st.src) & ~IP.maskOf(p.len))) >>> 0) : null;
      } else src = null;
      const out = { st: Object.assign({}, st, { src }), nat: { type: r.action, dir: 'src', rule: ref(r), before: st.src, after: src } };
      if (src === null) out.unknown = reason('srcnat-address-unknown', dev, `${where(r)} 改寫後的來源位址不明`, { rule: ref(r) });
      return out;
    }

    // ---- 逐跳：與路由追蹤共用的路徑展開（S.trace.walker），這裡只在每一跳掛上 raw、nat、filter 與 /ip service（ADR-023 決策 3）
    //   節點：{ hop, next: [node], end }，hop 是輸出的一跳，end 是在這一跳結束的原因；一個出介面一個節點（ECMP 時同一台設備有多個節點）
    const nodeMemo = new Map();
    const end = (status, verdict, code, dev, message, extra) => Object.assign({ status, verdict, code: checkCode(code), dev: dev || null, message }, extra);
    // hop.vrf：封包在這台設備所在的 VRF（入介面的 VRF；設備自己送出時是來源位址的 VRF）
    const newHop = (dev, inEp, st, chain) => ({
      dev, name: name(dev), vrf: st.vrf, collected: devInfo(dev).collected, firewall: devInfo(dev).config ? 'export' : 'none', chain, in: inEp === undefined ? null : inEp, inKnown: inEp !== undefined,
      out: null, outKnown: true, src: st.src, dst: st.dst, proto: st.proto, port: st.port, srcOut: st.src, dstOut: st.dst, portOut: st.port,
      route: null, stages: [], nat: [], service: null, reasons: [], verdict: 'pass', conntrack: 'new',
    });
    const cloneHop = (b) => ({
      dev: b.dev, name: b.name, vrf: b.vrf, collected: b.collected, firewall: b.firewall, chain: b.chain, in: b.in, inKnown: b.inKnown, out: b.out, outKnown: b.outKnown,
      src: b.src, dst: b.dst, proto: b.proto, port: b.port, srcOut: b.srcOut, dstOut: b.dstOut, portOut: b.portOut,
      route: b.route, stages: b.stages.slice(), nat: b.nat.slice(), service: b.service, reasons: b.reasons.slice(), verdict: b.verdict, conntrack: b.conntrack,
      ...(b.returnUnsafe ? { returnUnsafe: b.returnUnsafe } : {}),
    });
    /**
     * 回程的前提（推論，Q.policyBaseline）：這一跳的 chain（input／forward）returnSafe 為 false，而且不保證的介面和這條路徑有關時，
     * 回傳 { chain, rule, interfaces }，否則 null。同一條連線之後的封包（含回程）都是 established：
     *   forward 的回程從出介面進來、同方向的後續封包從入介面進來；input 的後續封包從入介面進來（設備送出的回應走 output，不在 policyBaseline）。
     *   blockedFrom 的 interfaces 為 null（只限出介面或清單展開不了）或包含這些介面（不明的介面也算）時才算；
     *   established 被一定命中的丟棄擋下（或沒有規則決定而預設丟棄）時所有介面都算（interfaces 為 null）。
     * rule：blockedFrom 的第一條相關規則；沒有 blockedFrom 時是擋下 established 的規則（established.rule），再沒有時是 defaultAction.rule。
     */
    const ruMemo = new Map();
    // 多數設備的 input、forward 都有保證：先依設備排除，矩陣的每一跳不必組鍵
    const ruDev = new Map();
    const anyUnsafe = (dev) => U.getOr(ruDev, dev, () => { const pb = Q.policyBaseline(dev); return !!(pb && pb.some((c) => c.returnSafe === false)); });
    function returnUnsafeOf(dev, chain, inEp, outEp) {
      if (!devInfo(dev).config || (chain !== 'input' && chain !== 'forward') || !anyUnsafe(dev)) return null;
      const k = [dev, chain, inEp === undefined ? '~' : String(inEp), outEp === undefined ? '~' : String(outEp)].join('\u0000');
      return U.getOr(ruMemo, k, () => {
        const pb = Q.policyBaseline(dev); const row = pb && pb.find((c) => c.chain === chain);
        if (!row || row.returnSafe !== false) return null;
        const est = row.established;
        if (est.status === 'drop' || (est.status === 'policy' && row.defaultAction.action !== 'accept')) {
          return deepFreeze({ chain, rule: (est.status === 'drop' && est.rule) || row.defaultAction.rule, interfaces: null });
        }
        const ifs = (chain === 'forward' ? [outEp, inEp] : [inEp]).filter((x) => x !== null).map((x) => (x === undefined ? undefined : realEp(x)));
        const hits = est.blockedFrom.filter((b) => b.interfaces === null || ifs.some((x) => x === undefined || b.interfaces.includes(x)));
        if (!hits.length) return null;
        const all = hits.some((b) => b.interfaces === null) ? null : U.uniq(hits.flatMap((b) => b.interfaces)).sort(U.natural);
        return deepFreeze({ chain, rule: hits[0].rule, interfaces: all });
      });
    }
    /** 允許的路徑上回程不保證的跳（只走允許的子路徑）：[{ dev, chain, rule, interfaces }]，依出現順序、不重複。 */
    const unsafeMemo = new WeakMap();
    const unsafeOfNode = (node) => {
      if (unsafeMemo.has(node)) return unsafeMemo.get(node);
      const out = [];
      if (summary(node).verdict === 'allow') {
        if (node.hop.returnUnsafe) out.push(Object.assign({ dev: node.hop.dev }, node.hop.returnUnsafe));
        (node.next || []).forEach((k) => unsafeOfNode(k).forEach((x) => out.push(x)));
      }
      const uniq = out.filter((x, i) => out.findIndex((y) => y.dev === x.dev && y.chain === x.chain && y.rule === x.rule) === i);
      unsafeMemo.set(node, uniq);
      return uniq;
    };
    const unsafeOfSum = (sum) => { const out = []; sum.nodes.forEach((n) => unsafeOfNode(n).forEach((x) => { if (!out.some((y) => y.dev === x.dev && y.chain === x.chain && y.rule === x.rule)) out.push(x); })); return out; };
    const unsafeReason = (x) => {
      const r = x.rule ? Q.getFirewallRule(x.rule) : null;
      return reason('return-not-guaranteed', x.dev, `${name(x.dev)} 的 ${x.chain} 沒有保證放行已建立連線的封包${r ? `（${where(r)}）` : ''}${x.interfaces ? `，從 ${x.interfaces.map((ep) => Q.epName(ep)).join('、')} 進來的` : ''}：新連線允許，回程可能被丟棄（推論，見 F15）`,
        { rule: r ? ref(r) : null, chain: x.chain, interfaces: x.interfaces ? x.interfaces.slice() : null });
    };

    const stop = (hop, e) => [{ hop, next: null, end: e }]; // 節點的形狀與 walker 的相同（{ hop, next, end }）
    /** 進入設備之後（walker 的 enter）：raw prerouting（是否 notrack 無法判斷時兩種都算）→ afterRaw。 */
    function enterHook(dev, base, inEp, st, depth, ctx) {
      const info = devInfo(dev);
      if (!info.config) {
        base.reasons.push(reason('no-firewall-data', dev, `${name(dev)} 沒有設定資料（/export），防火牆規則不明`));
        return afterRaw(dev, base, inEp, st, depth, ctx, 'new');
      }
      const ctxF = I.ctxOf(dev);
      if (!hasRules(ctxF, 'raw', 'prerouting')) return afterRaw(dev, base, inEp, st, depth, ctx, 'new');
      const sg = stage(dev, 'raw', 'prerouting', st, inEp, undefined, null, ctx.skip, 'new');
      base.stages.push(sg.pub);
      if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { base.verdict = 'deny'; return stop(base, end('dropped', 'deny', 'dropped', dev, sg.pub.note)); }
      // notrack：連線不追蹤，之後的規則以 connection-state=untracked 比對，也不做 NAT（NAT 依賴連線追蹤；手冊 Connection tracking、Packet Flow）
      if (sg.pub.status === 'decided') return afterRaw(dev, base, inEp, st, depth, ctx, sg.pub.verdict === 'notrack' ? 'untracked' : 'new');
      const vs = U.uniq(sg.d.outcomes.map((o) => o.verdict));
      const reasons = condReasons(dev, sg);
      if (!vs.includes('notrack') || vs.includes('drop')) { base.reasons.push(...reasons); return afterRaw(dev, base, inEp, st, depth, ctx, 'new'); }
      // 只差在是否 notrack：兩種狀態各算一次，結果相同就是確定的，不同就是不明（不讓其中一邊的「拒絕」蓋過另一邊）
      const tracked = afterRaw(dev, cloneHop(base), inEp, st, depth, ctx, 'new');
      const untracked = afterRaw(dev, cloneHop(base), inEp, st, depth, ctx, 'untracked');
      const vt = combine(tracked.map(summary)); const vu = combine(untracked.map(summary));
      if (vt === vu && vt !== 'unknown') return tracked;
      const why = reason('raw-notrack', dev, `${name(dev)} raw prerouting 是否不追蹤連線（notrack）無法判斷：追蹤時${V_TEXT[vt]}、不追蹤時${V_TEXT[vu]}`, { rule: (sg.pub.uncertain.find((u) => u.verdicts.includes('notrack')) || {}).rule || null });
      tracked.forEach((n) => { n.hop.reasons.push(...reasons, why); n.hop.verdict = 'unknown'; n.hop.pinned = true; sumMemo.delete(n); });
      return tracked;
    }
    const V_TEXT = { allow: '允許', deny: '拒絕', unknown: '無法判斷' };
    /** raw prerouting 之後：dstnat（不追蹤時略過；改寫目的後由 walker 重新查路由）→ 送給自己（input）或轉送（forward）。ct 是這台設備的連線追蹤狀態。 */
    function afterRaw(dev, base, inEp, st, depth, ctx, ct) {
      const info = devInfo(dev);
      let cur = st; let natState = null;
      base.conntrack = ct;
      if (info.config && ct !== 'untracked' && hasRules(I.ctxOf(dev), 'nat', 'dstnat')) {
        const sg = stage(dev, 'nat', 'dstnat', cur, inEp, undefined, null, ctx.skip, ct);
        base.stages.push(sg.pub);
        if (sg.pub.status !== 'decided') {
          base.reasons.push(...condReasons(dev, sg));
          if (sg.d.outcomes.some((o) => o.verdict !== 'none')) {
            base.verdict = 'unknown';
            base.reasons.push(reason('nat-ambiguous', dev, `${name(dev)} dstnat 可能由不同的規則改寫（${sg.d.outcomes.map((o) => (o.rule ? `chain 內第 ${o.rule.position} 條 ${o.verdict}` : '不改寫')).join('、')}），改寫後的目的不明`));
            return stop(base, end('unknown', 'unknown', 'nat-ambiguous', dev, '目的 NAT 的結果不明，之後的路徑無法判斷'));
          }
        } else if (sg.pub.verdict !== 'none') {
          const res = applyDst(dev, inEp, sg.d.rule, cur);
          if (res.unknown) { base.verdict = 'unknown'; base.reasons.push(res.unknown); return stop(base, end('unknown', 'unknown', res.unknown.code, dev, res.unknown.message)); }
          base.nat.push(res.nat); cur = res.st; natState = 'dstnat';
          base.dstOut = cur.dst; base.portOut = cur.port;
        }
      }
      return W.atDevice(dev, base, inEp, cur, depth, ctx, { natState, ct });
    }
    /** 目的是這台設備自己（在封包所在的 VRF，walker 的 local）：input，再看管理服務（/ip service）是否接受。 */
    function localHook(dev, base, inEp, cur, ctx, x) {
      const info = devInfo(dev); const natState = x.natState; const ct = x.ct;
        if (info.config) {
          const sg = stage(dev, 'filter', 'input', cur, inEp, null, natState, ctx.skip, ct);
          base.stages.push(sg.pub); base.reasons.push(...condReasons(dev, sg));
          if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { base.verdict = 'deny'; return stop(base, end('dropped', 'deny', 'dropped', dev, sg.pub.note)); }
          const ru = returnUnsafeOf(dev, 'input', inEp, null); if (ru) base.returnUnsafe = ru;
        }
      return localService(dev, base, cur);
    }
    /**
     * 送到設備自己、防火牆沒有擋：依 /ip service 判斷（https://manual.mikrotik.com/docs/cli-reference/ip/service.md）。
     * 停用的服務不監聽；available-from 不含來源時，TCP 連線可以建立，但設備隨即關閉、不提供服務（埠仍看得到）；兩者都算拒絕（end service-refused）。
     * 來源不明（NAT 後）或封包不在 main（服務的 vrf 參數預設 main，模型沒有這個參數）時不明。沒有對應的服務時維持「防火牆允許」並註明。
     */
    function localService(dev, base, cur) {
      const sv = devInfo(dev).config ? serviceOf(dev, cur) : null;
      base.service = sv;
      if (sv && sv.accepts === false) {
        base.verdict = 'deny';
        return stop(base, end('refused', 'deny', 'service-refused', dev, !sv.enabled
          ? `${name(dev)} 的 ${sv.name} 服務（/ip service）已停用，沒有監聽 tcp/${sv.port}`
          : `${name(dev)} 的 ${sv.name} 服務只接受 ${sv.addresses.join('、')}（/ip service 的 available-from），來源 ${cur.src} 不在其中：連線建立後設備隨即關閉`, { service: sv.name, src: sv.src }));
      }
      if (sv && (sv.accepts === null || cur.vrf !== K.MAIN_VRF)) {
        base.verdict = 'unknown';
        return stop(base, end('unknown', 'unknown', 'service-unknown', dev, cur.vrf !== K.MAIN_VRF
          ? `${name(dev)} 的 ${sv.name} 服務所在的 VRF 不在模型中（預設 main），封包在 VRF ${cur.vrf}，是否接受無法判斷`
          : `${name(dev)} 的 ${sv.name} 服務只接受 ${sv.addresses.join('、')}，來源經 NAT 後不明，是否接受無法判斷`, { service: sv.name }));
      }
      if (base.reasons.length) base.verdict = 'unknown';
      const svText = !sv && cur.proto === 'tcp' && cur.port != null && devInfo(dev).config ? '（防火牆允許；沒有已知的管理服務（/ip service）使用這個埠）' : '';
      return stop(base, end('delivered', 'allow', 'local', dev, `目的 ${cur.dst} 是 ${name(dev)} 自己的位址${svText}`, { vrf: cur.vrf }));
    }
    /** 轉送決定之後、交給下一台之前（walker 的 out）：filter（forward／output，設備自己送出時先看 raw output）與 srcnat。 */
    function outHook(dev, hop, inEp, st0, o, chain, ctx, x) {
      const info = devInfo(dev); const ct0 = x.ct; const natState = x.natState; const cur = st0;
      let st = st0;
        let ct = ct0 === undefined ? 'new' : ct0; // 設備自己送出（originate）時沒有 raw prerouting，連線追蹤狀態是 new
        if (info.config) {
          const ctxF = I.ctxOf(dev);
          if (chain === 'output' && hasRules(ctxF, 'raw', 'output')) {
            const sg = stage(dev, 'raw', 'output', st, null, o.out, null, ctx.skip, ct);
            hop.stages.push(sg.pub); hop.reasons.push(...condReasons(dev, sg));
            if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { hop.verdict = 'deny'; return { end: end('dropped', 'deny', 'dropped', dev, sg.pub.note) }; }
            if (sg.pub.status === 'decided' && sg.pub.verdict === 'notrack') ct = 'untracked';
            else if (sg.pub.status !== 'decided' && sg.d.outcomes.some((x) => x.verdict === 'notrack')) hop.reasons.push(reason('raw-notrack', dev, `${name(dev)} raw output 是否不追蹤連線（notrack）無法判斷，之後的連線狀態不明`));
          }
          hop.conntrack = ct;
          const sg = stage(dev, 'filter', chain, st, inEp === undefined ? undefined : inEp, o.out, natState, ctx.skip, ct);
          hop.stages.push(sg.pub); hop.reasons.push(...condReasons(dev, sg));
          if (sg.pub.status === 'decided' && sg.pub.verdict === 'drop') { hop.verdict = 'deny'; return { end: end('dropped', 'deny', 'dropped', dev, sg.pub.note) }; }
          if (chain === 'forward') { const ru = returnUnsafeOf(dev, 'forward', inEp, hop.outKnown ? hop.out : undefined); if (ru) hop.returnUnsafe = ru; }
          if (ct !== 'untracked' && hasRules(ctxF, 'nat', 'srcnat')) {
            const sn = stage(dev, 'nat', 'srcnat', st, inEp, o.out, natState, ctx.skip, ct);
            hop.stages.push(sn.pub); hop.reasons.push(...condReasons(dev, sn));
            if (sn.pub.status !== 'decided' && sn.d.outcomes.some((x) => x.verdict !== 'none')) {
              hop.reasons.push(reason('srcnat-ambiguous', dev, `${name(dev)} srcnat 可能由不同的規則改寫，之後的來源位址不明`));
              st = Object.assign({}, st, { src: null });
            } else if (sn.pub.status === 'decided' && sn.pub.verdict !== 'none') {
              const res = applySrc(dev, o.out, sn.d.rule, st, o.nh ? o.nh.ip || cur.dst : cur.dst);
              hop.nat.push(res.nat); st = res.st;
              if (res.unknown) hop.reasons.push(res.unknown);
            }
          }
        }
        hop.srcOut = st.src;
        if (hop.reasons.length) hop.verdict = 'unknown';
      return { st };
    }
    /** 送達直連網段之前（walker 的 beforeDeliver）：hairpin NAT。 */
    function hairpinHook(dev, hop, st) {
      if (hop.nat.some((x) => x.dir === 'dst') && !hop.nat.some((x) => x.dir === 'src') && st.src != null && st.src === hop.src) {
        const net = S.trace.longestSubnets(Q.subnetsOf(dev, st.vrf), st.dst)[0];
        if (net && IP.inNet(st.src, net.net, net.len)) {
          hop.verdict = 'unknown';
          return end('unknown', 'unknown', 'hairpin-no-srcnat', dev, `dst-nat 後的目的 ${st.dst} 與來源 ${st.src} 同在 ${net.net}/${net.len}，但沒有 srcnat 改寫來源：回應會直接送回來源、不經過 ${name(dev)}，連線通常建立不起來（需要 hairpin NAT）`, { ip: st.dst, vrf: st.vrf });
        }
      }
      return null;
    }
    function serviceOf(dev, st) {
      if (st.proto !== 'tcp' || st.port == null) return null;
      const sv = Q.ipServicesOf(dev).find((x) => x.port === st.port);
      if (!sv) return null;
      const accepts = !sv.enabled ? false : !sv.addresses.length ? true : st.src == null ? null
        : sv.addresses.some((a) => { const p = S.ip.parseCidr(a); return p ? IP.inNet(st.src, p.net, p.len) : false; });
      return { name: sv.name, enabled: sv.enabled, port: sv.port, addresses: sv.addresses.slice(), basis: sv.basis, accepts, src: sv.src.map((x) => x.slice()) };
    }

    // 節點的鍵：來源（Q.reach 用實際位址，矩陣用等價類，見 srcKey）與 service
    const W = S.trace.walker(Q, {
      newHop, cloneHop, checkCode, followOwner: true,
      srcKey: (dev, st, ctx) => (ctx.mode === 'exact' ? (st.src == null ? 'n' : st.src) : srcKey(st.src, st.vrf)),
      pktKey: svcNum,
      enter: enterHook, local: localHook, out: outHook, beforeDeliver: hairpinHook,
      originate: (dev, base) => { if (!devInfo(dev).config) base.reasons.push(reason('no-firewall-data', dev, `${name(dev)} 沒有設定資料（/export），防火牆規則不明`)); },
    });

    // ---- 摘要：每個節點的結果（allow／deny／unknown）、原因、決定的規則、牽涉的規則、最後的目的
    const sumMemo = new WeakMap();
    // 牽涉的規則（確定命中、無法判斷、決定結果的），只在 ruleImpact 需要時才算
    const invMemo = new WeakMap();
    const involvedOf = (node) => {
      if (invMemo.has(node)) return invMemo.get(node);
      const s = new Set();
      node.hop.stages.forEach((sg) => { sg.hits.forEach((r) => s.add(r.key)); sg.uncertain.forEach((u) => s.add(u.rule.key)); if (sg.rule) s.add(sg.rule.key); });
      (node.next || []).forEach((k) => involvedOf(k).forEach((x) => s.add(x)));
      invMemo.set(node, s);
      return s;
    };
    const involves = (sum, key) => sum.nodes.some((n) => involvedOf(n).has(key));
    /**
     * 判斷有沒有走到「送給設備自己」的結束（local、service-refused、service-unknown）：只有這裡（localService 依埠找 /ip service）
     * 會讓同一個 service 等價類（svcClasses：所有規則的條件結果相同）裡的埠結果不同。沒有走到時，同類的其他埠除了訊息中的埠以外結果相同（矩陣據此共用判斷）。
     */
    const LOCAL_ENDS = new Set(['local', 'service-refused', 'service-unknown']);
    const localMemo = new WeakMap();
    const touchesLocal = (node) => {
      let x = localMemo.get(node);
      if (x === undefined) { x = node.end ? LOCAL_ENDS.has(node.end.code) : (node.next || []).some(touchesLocal); localMemo.set(node, x); }
      return x;
    };
    const reachesLocal = (sum) => (sum.nodes.length ? sum.nodes.some(touchesLocal) : true); // 沒有節點（起點就結束）時保守地當作走到
    // 每個新節點都會呼叫（1000 台的矩陣約 57 萬次）：不建中間陣列
    const combine = (list) => {
      if (!list.length) return 'unknown';
      const v0 = list[0].verdict;
      for (let i = 1; i < list.length; i++) if (list[i].verdict !== v0) return 'unknown';
      return v0;
    };
    // 決定結果的規則（decisive 的值）依關卡（stage 的 pub，同一台設備同一個鍵只有一份）共用一個物件；這些物件只讀（摘要之間本來就共用）
    const pickMemo = new WeakMap();
    const pickOf = (sg, dev) => {
      let p = pickMemo.get(sg);
      if (!p) { p = { id: sg.rule ? sg.rule.key : `policy:${dev}|${sg.table}|${sg.chain}`, x: { key: sg.rule ? sg.rule.key : null, dev, table: sg.table, chain: sg.chain, policy: !sg.rule, verdict: sg.verdict } }; pickMemo.set(sg, p); }
      return p;
    };
    const ruleId = (sg) => (sg.rule ? sg.rule.key : `policy:${sg.policyDev}|${sg.table}|${sg.chain}`);
    function summary(node) {
      const hit = sumMemo.get(node); if (hit !== undefined) return hit;
      const h = node.hop;
      const decisive = new Map(); const reasons = h.reasons.slice(); let nat = h.nat.some((x) => x.dir === 'dst');
      const pick = (sg) => { const p = pickOf(sg, h.dev); decisive.set(p.id, p.x); };
      let verdict; let final = { dst: h.dstOut, port: h.portOut, vrf: (node.end && node.end.vrf) || h.vrf };
      const denyStage = h.stages.find((sg) => sg.status === 'decided' && sg.verdict === 'drop');
      if (h.verdict === 'deny' && denyStage) { pick(denyStage); verdict = 'deny'; }
      else {
        // srcnat 在 filter 之後（postrouting），只改寫來源、不決定允許或拒絕，不算決定結果的規則（逐跳的 nat 欄仍會列出）
        h.stages.forEach((sg) => { if (sg.status === 'decided' && (sg.table === 'filter' || (sg.table === 'nat' && sg.chain === 'dstnat' && sg.verdict !== 'none'))) pick(sg); });
        let v;
        if (node.end) {
          v = node.end.verdict;
          if (node.end.code !== 'local' && node.end.code !== 'host' && node.end.code !== 'segment' && node.end.code !== 'dropped' && node.end.verdict !== 'allow' && !reasons.some((x) => x.code === node.end.code)) reasons.push(reason(node.end.code, node.end.dev, node.end.message, Object.assign(node.end.ip ? { ip: node.end.ip } : {}, node.end.assumption ? { assumption: node.end.assumption } : {})));
          if (node.end.verdict === 'deny' && !denyStage) decisive.set('route:' + node.end.code + ':' + h.dev, { key: null, dev: h.dev, table: null, chain: null, policy: false, route: node.end.code, verdict: 'drop' });
        } else {
          const kids = node.next.map(summary);
          v = combine(kids);
          kids.forEach((k) => { if (k.nat) nat = true; });
          const sameFinal = kids.every((k) => k.final && kids[0].final && k.final.dst === kids[0].final.dst && k.final.port === kids[0].final.port && k.final.vrf === kids[0].final.vrf);
          final = sameFinal && kids.length ? kids[0].final : null;
          if (v === 'unknown' && U.uniq(kids.map((k) => k.verdict)).length > 1) {
            reasons.push(reason('branches-differ', h.dev, `${name(h.dev)} 之後有多條路徑（ECMP），結果不同（${U.uniq(kids.map((k) => k.verdict)).join('、')}），實際走哪一條無法判斷`));
          }
          // 決定的規則只取與結果一致的子路徑
          for (const k of kids) if (k.verdict === v || v === 'unknown') { k.decisive.forEach((x, id) => decisive.set(id, x)); for (const x of k.reasons) reasons.push(x); }
          if (v === 'deny') { decisive.forEach((x, id) => { if (x.verdict !== 'drop') decisive.delete(id); }); }
        }
        // pinned：這一跳本身的結果不明（例如是否 notrack），之後確定的拒絕也不能決定結果
        verdict = h.verdict === 'unknown' ? (v === 'deny' && !h.pinned ? 'deny' : 'unknown') : v;
        if (verdict === 'deny') { decisive.forEach((x, id) => { if (x.verdict !== 'drop') decisive.delete(id); }); }
      }
      const s = { verdict, reasons: reasons.length < 2 ? reasons : dedupeReasons(reasons), decisive, nodes: [node], final, nat };
      sumMemo.set(node, s);
      return s;
    }
    // 0 或 1 筆時不會有重複（大多數節點）：直接複製，不組鍵（每次都回傳新的陣列）
    const dedupeReasons = (list) => { if (list.length < 2) return list.slice(); const seen = new Set(); return list.filter((r) => { const k = [r.code, r.dev, r.rule ? r.rule.key : '', r.ip || '', (r.keys || []).join(',')].join('|'); if (seen.has(k)) return false; seen.add(k); return true; }); };
    function summarize(b, st) {
      if (!b.nodes.length) {
        const e = b.end;
        return { verdict: e.verdict, reasons: e.verdict === 'unknown' ? [reason(e.code, e.dev, e.message, e.ip ? { ip: e.ip } : {})] : [], decisive: new Map(), nodes: [],
          final: { dst: st.dst, port: st.port, vrf: (e && e.vrf) || st.vrf }, nat: false };
      }
      // 只有一個起點節點時，下面的合併結果與那個節點的摘要內容相同（原因已去重、決定的規則與最後的目的照抄）：直接用它，
      // 1000 台的矩陣每次判斷少建一份摘要（記錄會保留摘要，也減少記憶體與 GC 的停頓）。摘要建立後不再修改。
      if (b.nodes.length === 1) return summary(b.nodes[0]);
      const kids = b.nodes.map(summary);
      const v = combine(kids);
      const reasons = []; const decisive = new Map(); let nat = false;
      kids.forEach((k) => { if (k.nat) nat = true; if (k.verdict === v || v === 'unknown') { k.reasons.forEach((x) => reasons.push(x)); k.decisive.forEach((x, id) => decisive.set(id, x)); } });
      if (v === 'unknown' && U.uniq(kids.map((k) => k.verdict)).length > 1) {
        reasons.unshift(reason('branches-differ', null, b.start.gateways.length > 1
          ? `來源網段 ${b.start.prefix} 有多個閘道（${b.start.gateways.map((g) => name(g.dev)).join('、')}），結果不同（${U.uniq(kids.map((k) => k.verdict)).join('、')}）；主機用哪一個閘道無法判斷`
          : `有多條路徑，結果不同（${U.uniq(kids.map((k) => k.verdict)).join('、')}），實際走哪一條無法判斷`));
      }
      const sameFinal = kids.every((k) => k.final && kids[0].final && k.final.dst === kids[0].final.dst && k.final.port === kids[0].final.port && k.final.vrf === kids[0].final.vrf);
      return { verdict: v, reasons: dedupeReasons(reasons), decisive, nodes: b.nodes, final: sameFinal ? kids[0].final : null, nat };
    }

    // ---- 結果分層：先路由、再防火牆（ADR-023 決策 4）
    const DENY_ROUTE = new Set(S.trace.ROUTE_DENY);
    const routeMemo = new WeakMap();
    /**
     * 節點之下每個結束的路由層結果 [{ status, code, dev, message }]（依出現順序、不重複）：
     *   路由決定的結束（沒有路由、黑洞、策略路由丟棄、迴圈、送達、送往外部、不明…）照 walker 的 routeOfEnd；
     *   防火牆擋下的（dropped）：從擋下的那一跳只看路由繼續走（S.trace.routeFrom，NAT 已套用的目的），路由本身到不到；
     *   目的是設備本身（input、/ip service）與 hairpin NAT：路由已經到了；目的 NAT 的結果不明：路由也不明。
     */
    function routeOfNode(node) {
      if (routeMemo.has(node)) return routeMemo.get(node);
      let out;
      const e = node.end;
      if (e) {
        const s = W.routeOfEnd(e); const h = node.hop;
        if (s !== null) out = [{ status: s, code: e.code, dev: e.dev, message: e.message }];
        else if (NAT_UNKNOWN.has(e.code)) out = [{ status: 'unknown', code: e.code, dev: e.dev, message: e.message }];
        else if (e.code === 'dropped' && h.chain !== 'input') out = S.trace.routeFrom(Q, h.dev, h.inKnown ? h.in : undefined, { src: h.src, dst: h.dstOut, vrf: h.vrf });
        else out = [{ status: 'reached', code: e.code, dev: e.dev, message: e.message }];
      } else {
        out = []; const seen = new Set();
        (node.next || []).forEach((k) => routeOfNode(k).forEach((x) => { const id = x.status + '|' + x.code + '|' + x.dev; if (!seen.has(id)) { seen.add(id); out.push(x); } }));
      }
      routeMemo.set(node, out);
      return out;
    }
    /**
     * 拒絕的判斷是路由沒到（noRoute：每個結束的路由層結果都是沒有路由、黑洞、策略路由丟棄或迴圈）還是防火牆擋下（filter）；不是拒絕時 null。
     * 節點的路由層結果有快取（routeOfNode），這裡不另外快取（矩陣有數十萬筆摘要）。
     */
    const deniedByOf = (sum) => {
      if (sum.verdict !== 'deny') return null;
      return sum.nodes.length && sum.nodes.every((n) => routeOfNode(n).every((x) => DENY_ROUTE.has(x.status))) ? 'noRoute' : 'filter';
    };
    const layerOf = (code) => (REASON_LAYER.get(code) || 'filter');
    /**
     * 一條路徑的分層結果：route（路由層）與 filter（防火牆層；路由沒到時 n/a）。v 是這條路徑原本的結論（verdict）。
     *   route：{ status: reached|no-route|blackhole|policy-drop|loop|unknown, code, reasons }——結束的路由層結果只有一種時就是它，
     *     不同時（防火牆擋下之後的 ECMP）是 unknown、code 為 branches-differ；reasons 是沒有抵達的結束
     *   filter：{ status: allow|deny|unknown|n/a, rule（擋下的規則，沒有規則決定而預設丟棄時 { key: null, policy: true }）, reasons（防火牆、NAT 與推論假設層的原因） }
     */
    function layered(v, hops, e, rl) {
      const ss = U.uniq(rl.map((x) => x.status));
      const status = ss.length === 1 ? ss[0] : 'unknown';
      const code = ss.length === 1 ? rl[0].code : 'branches-differ';
      const route = { status, code, reasons: status === 'reached' ? [] : rl.filter((x) => x.status !== 'reached').map((x) => ({ code: x.code, dev: x.dev, message: x.message })) };
      if (DENY_ROUTE.has(status)) return { route, filter: { status: 'n/a', rule: null, reasons: [] } };
      let rule = null;
      if (v === 'deny') {
        for (const h of hops) {
          const sg = h.stages.find((x) => x.status === 'decided' && x.verdict === 'drop');
          if (sg) { rule = sg.rule || { key: null, dev: h.dev, table: sg.table, chain: sg.chain, policy: true }; break; }
        }
      }
      const reasons = hops.flatMap((h) => h.reasons).filter((x) => layerOf(x.code) !== 'route');
      if (e && v !== 'allow' && layerOf(e.code) !== 'route' && e.code !== 'dropped' && !reasons.some((x) => x.code === e.code)) reasons.push({ code: e.code, dev: e.dev, message: e.message });
      return { route, filter: { status: v, rule, reasons: dedupeReasons(reasons) } };
    }

    /**
     * 展開的每一條路徑（最多 MAX_PATHS 條）與它的分層結果：Q.reach 的 paths[]，暴露清單每一列的 route／filter 也由它彙整（rowLayers）。
     * 回傳 { paths: [{ verdict, hops, end, route, filter }], truncated }。
     */
    function pathsOf(b) {
      const paths = [];
      const walk = (node, acc) => {
        if (paths.length >= MAX_PATHS) return;
        const hops = acc.concat(node.hop);
        if (node.end || !node.next || !node.next.length) { paths.push({ hops, end: node.end, node }); return; }
        node.next.forEach((k) => walk(k, hops));
      };
      b.nodes.forEach((n) => walk(n, []));
      const out = paths.map((p) => {
        const hv = p.hops.map((h) => h.verdict);
        const e = p.end;
        const v = hv.includes('deny') || (e && e.verdict === 'deny') ? 'deny' : hv.includes('unknown') || !e || e.verdict === 'unknown' ? 'unknown' : 'allow';
        return Object.assign({ verdict: v, hops: p.hops, end: e }, layered(v, p.hops, e, routeOfNode(p.node)));
      });
      if (!b.nodes.length) {
        const rs = W.routeOfEnd(b.end);
        out.push(Object.assign({ verdict: b.end.verdict, hops: [], end: b.end }, layered(b.end.verdict, [], b.end, [{ status: rs, code: b.end.code, dev: b.end.dev, message: b.end.message }])));
      }
      return { paths: out, truncated: paths.length >= MAX_PATHS };
    }
    /**
     * 一個結論（verdict，Q.reach 的 verdict）的分層結果，由它的每條路徑（pathsOf）彙整，形狀同 paths[] 的 route／filter：
     *   route：每條路徑的 route.status 只有一種時就是它（code 取第一條），不同時 unknown、code branches-differ；reasons 合併
     *   filter：路由沒到（route.status 是 no-route、blackhole、policy-drop、loop）時 n/a；否則 status 是 verdict，rule 是第一個有擋下規則的路徑的規則，reasons 合併
     */
    function rowLayers(verdict, paths) {
      const ss = U.uniq(paths.map((p) => p.route.status));
      const rStatus = ss.length === 1 ? ss[0] : 'unknown';
      const route = { status: rStatus, code: ss.length === 1 ? paths[0].route.code : 'branches-differ', reasons: dedupeReasons(paths.flatMap((p) => p.route.reasons)) };
      if (DENY_ROUTE.has(rStatus)) return { route, filter: { status: 'n/a', rule: null, reasons: [] } };
      const withRule = paths.find((p) => p.filter.rule);
      return { route, filter: { status: verdict, rule: withRule ? withRule.filter.rule : null, reasons: dedupeReasons(paths.flatMap((p) => p.filter.reasons)) } };
    }

    // ---- 一次判斷（Q.reach、矩陣、規則影響與暴露清單共用）
    const skipOf = (keys) => (keys && keys.length ? { id: keys.slice().sort().join(','), set: new Set(keys) } : null);
    /** vrf：來源所在的 VRF（封包從這個 VRF 開始查路由；有 entry 時由入介面決定）。 */
    // 每個（mode, skip）一份 context 重複使用（同 S.trace.routeFrom）：一次展開結束時 stack 一定是空的；
    // 展開中丟出例外時 stack 可能留著，下一次改建新的
    const ctxMemo = new Map();
    function evaluate(src, dst, svc, mode, skip, entry, vrf) {
      const mk = mode + '\u0000' + (skip ? skip.id : '');
      let ctx = ctxMemo.get(mk);
      if (!ctx || ctx.stack.length) { ctx = W.context({ mode, skip, memo: level(nodeMemo, mk) }); ctxMemo.set(mk, ctx); }
      const st = { src, dst, proto: svc.proto, port: svc.port, vrf: K.vrf(vrf) };
      const b = W.begin(src, dst, st, ctx, entry);
      return { b, sum: summarize(b, st) };
    }

    Object.assign(E, { evaluate, skipOf, pathsOf, rowLayers, deniedByOf, involves, reachesLocal, unsafeOfSum, unsafeReason, dedupeReasons });
  };
})(globalThis.SSOT = globalThis.SSOT || {});
