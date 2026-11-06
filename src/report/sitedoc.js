/*
 * 網路文件（站點說明書）：設備清單、IP 規劃、VLAN 表、埠表與未結案事項，輸出 Markdown 與 CSV。畫面的匯出與 CLI 共用這裡的文字。
 * 下游模組：只透過查詢介面（Q＝S.query(snapshot)）讀基準，不改寫；上游不呼叫這裡。處理紀錄由呼叫端以 opts.ledgerOf 傳入（同 S.report）。
 * 表格只在 siteDocTables 組一次，Markdown 與 CSV 都由它轉出，兩者的欄位與列一致。
 * 欄名或內容加「（推論）」的是推論；其餘是收集到的事實（或命名規則的註解，欄名寫明）。
 * 不碰 DOM：都是純函式；相同的基準與選項輸出逐字相同。
 */
(function (S) {
  'use strict';
  const U = S.util; const K = S.keys; const R = S.report;
  const INFERRED = '（推論）';
  /** 介面狀態的顯示文字（與畫面的 V.STATUS 相同）；停用的介面另寫「停用」 */
  const IFC_STATUS_TEXT = Object.freeze({ up: 'up', down: 'down', unknown: '不明' });
  /** 埠表收的介面類型：實體埠、聚合與無線（VLAN 介面、bridge 等邏輯介面不是埠） */
  const PORT_TYPES = Object.freeze(['physical', 'lag', 'wireless']);
  const vlansText = (ids) => (ids && ids.length ? U.fmtVlans(U.numSort(ids)) : '');
  const byName = (Q) => (a, b) => U.natural(Q.devName(a), Q.devName(b)) || U.cmp(a, b);
  const portName = (Q, ep) => { const i = Q.getInterface(ep); const p = K.splitEp(ep)[1]; return i ? i.name : p.startsWith('?(') ? '（未知埠）' : p; };
  const epText = (Q, ep) => `${Q.devLabel(K.splitEp(ep)[0])} ${portName(Q, ep)}`;

  /** 設備清單：所有設備，依名稱的自然順序 */
  function deviceTable(Q) {
    const rows = Q.devices().slice().sort((a, b) => byName(Q)(a.key, b.key)).map((d) => {
      const cov = Q.coverageOf(d.key);
      const state = !d.collected ? '未收集' : cov && Q.coverageGap(cov) ? '已收集（有缺漏）' : '已收集';
      return [
        Q.devLabel(d.key), d.deviceType || '', d.softwareVersion || '',
        d.mgmtIp ? d.mgmtIp + (d.collected ? '' : '（鄰居宣告）') : '',
        S.KIND_LABEL[d.kind] || d.kind || '',
        d.role || '', d.site || '', state, d.collectedAt || '',
      ];
    });
    return { id: 'devices', title: '設備清單', columns: ['設備', '型號', 'RouterOS 版本', '管理 IP', '設備類型' + INFERRED, '角色（命名規則）', '站點（命名規則）', '收集狀態', '收集時間'], rows };
  }

  /**
   * IP 規劃：每個 VRF 的每個直連網段一列（Q.subnetGraph 的網段，順序同 Q.prefixes）。
   * 介面位址是事實；路由設備與它在網段上的位址、zone 是推論；DHCP 閘道是 DHCP 網路設定（事實）。
   */
  function ipTable(Q, opts) {
    const g = Q.subnetGraph();
    const zones = Q.zones((opts && opts.zones) || {});
    const zoneName = new Map(zones.zones.map((z) => [z.id, z.name]));
    const zoneOf = new Map(zones.subnets.map((s) => [s.key, s.zone]));
    const own = (s, ep) => Q.ipsOf(ep).filter((a) => !a.hearsay && a.vrf === s.vrf && S.ip.inNet(a.ip, s.net, s.len)).map((a) => a.address);
    const rows = g.subnets.filter((s) => s.basis === 'connected').map((s) => {
      const routers = new Set(s.routers);
      const gw = s.eps.filter((ep) => routers.has(K.splitEp(ep)[0])).flatMap((ep) => own(s, ep).map((a) => `${epText(Q, ep)} ${a}`));
      const z = zoneOf.get(s.id);
      return [
        s.prefix, s.vrf, s.vlan == null ? '' : String(s.vlan),
        s.eps.flatMap((ep) => own(s, ep).map((a) => `${epText(Q, ep)} ${a}`)).join('; '),
        s.gateways.map((x) => `${x.ip}（${Q.devLabel(x.dev)}）`).join('; '),
        gw.join('; '), z ? zoneName.get(z) || z : '',
      ];
    });
    return { id: 'ip', title: 'IP 規劃', columns: ['網段', 'VRF', 'VLAN', '介面位址', 'DHCP 閘道', '路由設備' + INFERRED, 'zone' + INFERRED], rows };
  }

  /**
   * VLAN 表：每個 VLAN ID（Q.vlanIds）的每個不相連區塊一列（Q.vlan(id).domains，推論：區塊依承載的鏈路劃分）。
   * 名稱是 VLAN 定義的名稱（事實，多個以「; 」分隔）；承載設備是這個區塊內有這個 VLAN 的設備。
   * 沒有區塊時一列，區塊欄空白，承載設備是有這個 VLAN 的設備。
   */
  function vlanTable(Q) {
    const defs = new Map();
    Q.vlans().forEach((v) => { if (v.id != null && v.name) U.getOr(defs, v.id, () => []).push(v.name); });
    const list = (devs) => U.uniq(devs).sort(byName(Q)).map((k) => Q.devLabel(k)).join('; ');
    const rows = [];
    Q.vlanIds().forEach((id) => {
      const v = Q.vlan(id);
      const names = U.uniq((defs.get(id) || []).concat(v.names)).sort(U.natural).join('; ');
      if (!v.domains.length) { rows.push([String(id), names, '', list(v.devices)]); return; }
      v.domains.forEach((d, n) => rows.push([String(id), names, `${n + 1}／${v.domains.length}`, list(d.devices)]));
    });
    return { id: 'vlans', title: 'VLAN 表', columns: ['VLAN', '名稱', '區塊' + INFERRED, '承載設備'], rows };
  }

  /**
   * 埠表：已收集設備的實體埠、聚合與無線介面（不含只由鄰居得知的介面），依設備、介面名稱的自然順序。
   * VLAN 是介面本身的設定；聚合成員的 VLAN 設在聚合上，所屬欄寫出聚合。
   * 對端：LLDP／CDP 介面鄰接（事實；MNDP 只證明同一廣播網域，不列），推論鏈路另一欄。
   */
  function portTable(Q) {
    const rows = [];
    Q.devices().filter((d) => d.collected).map((d) => d.key).sort(byName(Q)).forEach((dk) => {
      Q.interfacesOf(dk).filter((i) => !i.hearsay && PORT_TYPES.includes(i.type)).slice().sort((a, b) => U.natural(a.name, b.name) || U.cmp(a.key, b.key)).forEach((i) => {
        const peers = Q.linksOfEp(i.key).filter((l) => l.evidenceScope === S.LINK_SCOPE.INTERFACE_ADJACENCY).map((l) => epText(Q, Q.peerOf(l, i.key)));
        const inferred = Q.inferredLinksOfEp(i.key).map((l) => epText(Q, l.a === i.key ? l.b : l.a));
        const parent = [i.lag ? `聚合 ${portName(Q, i.lag)}` : '', i.bridge ? `bridge ${portName(Q, i.bridge)}` : ''].filter(Boolean).join('; ');
        rows.push([
          Q.devLabel(dk), i.name, i.enabled === false ? '停用' : IFC_STATUS_TEXT[i.status] || i.status || '', parent, i.mode || '',
          i.pvid == null ? '' : String(i.pvid), vlansText(i.untaggedVlans), vlansText(i.taggedVlans),
          U.uniq(peers).sort(U.natural).join('; '), U.uniq(inferred).sort(U.natural).join('; '), i.desc || '',
        ]);
      });
    });
    return { id: 'ports', title: '埠表', columns: ['設備', '介面', '狀態', '所屬', '模式', 'PVID', 'untagged', 'tagged', '對端（LLDP／CDP）', '對端' + INFERRED, '描述'], rows };
  }

  /**
   * 未結案事項：待處理（S.ledger.isPending：不在處理紀錄、open、regressed）的錯誤與警告，依嚴重度、再依 Snapshot 的順序；
   * 接受風險：狀態為 accepted 的項目（不論嚴重度），附豁免原因與到期日。狀態的用語同 S.report.statusText。
   */
  function openTables(Q, opts) {
    const lgOf = opts && opts.ledgerOf ? opts.ledgerOf : () => null;
    const dev = (f) => { const d = Q.findingDevice(f); return d === null ? '' : Q.devLabel(d); };
    const all = Q.findings().map((f) => ({ f, lg: lgOf(f) }));
    const pending = R.SEV_ORDER.filter((s) => s !== 'info').flatMap((sev) => all.filter((x) => x.f.severity === sev && S.ledger.isPending(x.lg && x.lg.status)));
    const accepted = all.filter((x) => x.lg && x.lg.status === 'accepted');
    return [
      { id: 'open', title: '未結案事項', columns: ['嚴重度', '代碼', '檢查', '設備', '訊息', '處理狀態', '備註'],
        rows: pending.map(({ f, lg }) => [R.SEV_TEXT[f.severity], f.id, f.title, dev(f), f.message, R.statusText(lg && lg.status), (lg && lg.note) || '']) },
      { id: 'accepted', title: '接受風險', columns: ['嚴重度', '代碼', '檢查', '設備', '訊息', '豁免原因', '豁免到期', '備註'],
        rows: accepted.map(({ f, lg }) => { const w = lg.waiver || {}; return [R.SEV_TEXT[f.severity] || f.severity, f.id, f.title, dev(f), f.message, w.reason || '', w.until || '', lg.note || '']; }) },
    ];
  }

  /**
   * 網路文件的表格（Markdown 與 CSV 共用）：[{ id, title, columns, rows（字串的二維陣列）}]，依 devices、ip、vlans、ports、open、accepted 的順序。
   * opts：ledgerOf(f)（同 S.report；沒傳時都視為待處理）、zones（Q.zones 的參數，例如 { profile }；畫面傳入與 zone 矩陣相同的選項）、
   *   ports（false 時不含埠表，1000 台規模時埠表很大）。
   */
  function siteDocTables(Q, opts) {
    const o = opts || {};
    const out = [deviceTable(Q), ipTable(Q, o), vlanTable(Q)];
    if (o.ports !== false) out.push(portTable(Q));
    return out.concat(openTables(Q, o));
  }

  /** 收集時間的範圍（已收集設備的 collectedAt，字串排序）；都沒有時 null */
  const collectedRange = (Q) => {
    const at = Q.devices().map((d) => d.collectedAt).filter(Boolean).sort(U.cmp);
    return at.length ? (at[0] === at[at.length - 1] ? at[0] : `${at[0]}～${at[at.length - 1]}`) : null;
  };

  /** Markdown 的表格儲存格：mdText 跳脫（含 |），空白寫「—」 */
  const mdCell = (s) => (s === '' || s == null ? '—' : R.mdText(s));

  /** 網路文件 Markdown：開頭是基準的資訊與事實／推論的說明，接著每個表格一節；沒有資料的表格寫「沒有。」 */
  function siteDocMarkdown(Q, opts) {
    const m = Q.meta(); const st = m.stats; const range = collectedRange(Q);
    const out = [
      '# 網路文件', '',
      `- 建立時間：${m.createdAt}`,
      `- 版本：${m.version}（${m.schema}）`,
      `- 輸入指紋：${R.mdCode(m.inputHash)}`,
      `- 命名規則：${m.profile ? R.mdText(m.profile.id) : '未套用'}`,
      `- 設備：${st.devices}（已收集 ${st.collected}）`,
      `- 收集時間：${range ? R.mdText(range) : '沒有紀錄'}`,
      `- 事實與推論：欄名或內容標「${INFERRED}」的是工具依收集資料的推論，其餘是收集到的事實；「（命名規則）」是命名規則加的註解。`,
    ];
    siteDocTables(Q, opts).forEach((t) => {
      out.push('', `## ${t.title}（${t.rows.length}）`, '');
      if (!t.rows.length) { out.push('沒有。'); return; }
      out.push(`| ${t.columns.map(mdCell).join(' | ')} |`, `|${t.columns.map(() => '---').join('|')}|`);
      t.rows.forEach((r) => out.push(`| ${r.map(mdCell).join(' | ')} |`));
    });
    return out.join('\n') + '\n';
  }

  /**
   * 網路文件 CSV：一個檔案、多個區段（Excel 一次開啟，CLI 也只寫一個檔）。每個區段是「[標題]」一列、欄名一列、資料列，區段之間空一列；
   * 沒有資料的區段只有標題與欄名。跳脫用 S.report.csvCell；開頭加 UTF-8 BOM、換行用 CRLF（同檢查結果 CSV）。
   */
  function siteDocCsv(Q, opts) {
    const lines = [];
    siteDocTables(Q, opts).forEach((t, n) => {
      if (n) lines.push('');
      lines.push(R.csvCell(`[${t.title}]`), t.columns.map(R.csvCell).join(','), ...t.rows.map((r) => r.map(R.csvCell).join(',')));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  // S.report 已凍結（report.js），在原有成員之外加上網路文件的函式，再凍結一次；原有成員是同一個參考
  S.report = Object.freeze(Object.assign({}, S.report, { siteDocTables, siteDocMarkdown, siteDocCsv, IFC_STATUS_TEXT }));
})(globalThis.SSOT = globalThis.SSOT || {});
