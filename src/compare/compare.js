/*
 * 比對（獨立模組）：把「預期資料」和基準比對，產生差異報告。
 * 預期資料有自己的格式，不共用 Snapshot 結構；只透過查詢介面（S.query）讀取基準，絕不修改基準。
 *
 * 預期資料格式 ssot-expected/1：
 * {
 *   "schema": "ssot-expected/1",
 *   "devices": [ "TPE_CORE_SW_01", { "name": "TPE_FW_01", "kind": "firewall" } ],
 *   "links":   [ { "a": "TPE_CORE_SW_01 xe-0/0/0", "b": "TPE_FW_01 port1" } ],
 *   "vlans":   [ { "device": "TPE_ACC_SW_01", "id": 20, "name": "SRV" } ]
 * }
 */
(function (S) {
  'use strict';
  const K = S.keys;
  const LINK_SCOPE = S.LINK_SCOPE;

  function parseEp(s) {
    const m = String(s).trim().match(/^(\S+)\s+(\S+)$/);
    return m ? K.ep(m[1], m[2]) : null;
  }

  S.compare = function (Q, expected) {
    const errors = [];
    if (!expected || expected.schema !== 'ssot-expected/1') errors.push('預期資料的 schema 必須是 "ssot-expected/1"');
    const report = { schema: 'ssot-diff/1', errors, items: [], summary: { ok: 0, missing: 0, different: 0, unexpected: 0 } };
    if (errors.length) return report;
    const push = (status, type, ref, message) => { report.items.push({ status, type, ref, message }); report.summary[status]++; };

    const expDevs = new Set();
    (expected.devices || []).forEach((d) => {
      const o = typeof d === 'string' ? { name: d } : d;
      const k = K.dev(o.name); expDevs.add(k);
      const got = Q.getDevice(k);
      if (!got) return push('missing', 'device', k, `基準中沒有 ${o.name}`);
      if (!got.collected) return push('different', 'device', k, `${o.name} 僅由鄰居發現，沒有收集資料`);
      if (o.kind && got.kind !== o.kind) return push('different', 'device', k, `${o.name} 類型預期 ${o.kind}，基準為 ${got.kind}`);
      push('ok', 'device', k, o.name);
    });
    if (expected.devices && expected.strictDevices) {
      Q.devices().forEach((d) => { if (d.collected && !expDevs.has(d.key)) push('unexpected', 'device', d.key, `基準多出 ${d.name}`); });
    }

    const expLinks = new Set();
    (expected.links || []).forEach((l) => {
      const a = parseEp(l.a); const b = parseEp(l.b);
      if (!a || !b) { errors.push(`鏈路格式錯誤：${JSON.stringify(l)}（應為 "設備 介面"）`); return; }
      const key = K.link(a, b); expLinks.add(key);
      const got = Q.getLink(key);
      const devA = K.splitEp(a)[0]; const devB = K.splitEp(b)[0];
      const domainReachability = !!((got && got.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN)
        || Q.linksOf(devA).some((x) => x.evidenceScope === LINK_SCOPE.BROADCAST_DOMAIN
          && [K.splitEp(x.a)[0], K.splitEp(x.b)[0]].includes(devB)));
      if (domainReachability) return push('different', 'link', key, `${l.a} ⇄ ${l.b} 只有 MNDP 的 L2 廣播網域可達證據，不能確認這組介面直連`);
      if (got) return push(got.verified ? 'ok' : 'different', 'link', key, got.verified ? `${l.a} ⇄ ${l.b}` : `${l.a} ⇄ ${l.b} 存在但未經雙向確認`);
      const ga = Q.linksOfEp(a).filter((x) => x.evidenceScope !== LINK_SCOPE.BROADCAST_DOMAIN);
      const gb = Q.linksOfEp(b).filter((x) => x.evidenceScope !== LINK_SCOPE.BROADCAST_DOMAIN);
      if (ga.length || gb.length) {
        const where = ga.concat(gb).map((x) => Q.epName(x.a) + ' ⇄ ' + Q.epName(x.b)).join('；');
        return push('different', 'link', key, `${l.a} ⇄ ${l.b} 不存在，實際為：${where}`);
      }
      push('missing', 'link', key, `基準中沒有 ${l.a} ⇄ ${l.b}`);
    });
    if (expected.links && expected.strictLinks) {
      Q.links().forEach((l) => { if (l.layer === 'l2' && l.evidenceScope !== LINK_SCOPE.BROADCAST_DOMAIN && !expLinks.has(l.key)) push('unexpected', 'link', l.key, `基準多出 ${Q.epName(l.a)} ⇄ ${Q.epName(l.b)}`); });
    }

    (expected.vlans || []).forEach((v) => {
      const dk = K.dev(v.device);
      const got = Q.vlansOf(dk).find((x) => x.id === +v.id);
      if (!got) return push('missing', 'vlan', dk + '|' + v.id, `${v.device} 沒有 VLAN ${v.id}`);
      if (v.name && got.name && got.name.toUpperCase() !== String(v.name).toUpperCase()) return push('different', 'vlan', dk + '|' + v.id, `${v.device} VLAN ${v.id} 名稱預期 ${v.name}，基準為 ${got.name}`);
      push('ok', 'vlan', dk + '|' + v.id, `${v.device} VLAN ${v.id}`);
    });
    return report;
  };
})(globalThis.SSOT = globalThis.SSOT || {});
