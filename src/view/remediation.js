/*
 * 分診 → 修 → 驗證 的畫面輔助：都是純函式，只透過查詢介面（Q）讀取基準，不改寫 Snapshot。
 *   - 確認的分類（ACK_KIND）：檢視狀態，存在 store 的 'acks'（見 app-acks.js）
 *   - findingDevice：檢查結果歸到哪台設備（檢查結果分頁的「依設備」分組與匯出排序共用）
 *   - disableRuleFix：防火牆規則的停用指令範例（只產生文字，不連線、不寫回設備）
 *   - devicesCsvDraft：由 C01 產生 tools/collect.sh 的設備清單草稿
 *   - fixTracking：新舊基準之間，「已排程修復」的檢查結果是否已修復
 */
(function (S) {
  'use strict';
  const V = S.view; const K = S.keys; const U = S.util;

  // ---------------------------------------------------------------- 確認的分類
  /** 分類鍵 → 顯示文字；舊格式（只有 at）或未選分類時 kind 為 null，顯示「未分類」 */
  const ACK_KIND = { accepted: '可接受（設計如此）', scheduled: '已排程修復', 'false-positive': '誤報' };
  /** 未知的分類（例如較新版本寫入的值）原樣顯示，不當成未分類 */
  const ackKindText = (kind) => (kind ? ACK_KIND[kind] || kind : '未分類');

  // ---------------------------------------------------------------- 檢查結果所屬設備
  /**
   * 第一個 device 實體；沒有時取第一個能對到設備的實體（介面、鏈路一端、規則、服務、設備自有的 IP）。
   * 回傳基準中存在的設備鍵，都對不到時為 null（例如沒有設備標頭的 I01、只涉及 MAC 或 VLAN 的檢查）。
   */
  function findingDevice(Q, f) {
    const known = (d) => { const x = d && Q.getDevice(d); return x ? x.key : null; };
    const dev = f.entities.find((e) => e.type === 'device');
    if (dev && known(dev.key)) return known(dev.key);
    for (const e of f.entities) {
      let d = null;
      if (e.type === 'interface') d = (Q.getInterface(e.key) || {}).dev || K.splitEp(e.key)[0];
      else if (e.type === 'link') { const l = Q.getLink(e.key); d = K.splitEp(l ? l.a : String(e.key).split('~')[0])[0]; }
      else if (e.type === 'rule') d = (Q.getFirewallRule(e.key) || {}).dev;
      else if (e.type === 'service') d = K.splitEp(e.key)[0];
      else if (e.type === 'ip') { const o = Q.ipOwner(e.key); d = o && K.splitEp(o)[0]; }
      if (known(d)) return known(d);
    }
    return null;
  }
  /**
   * 依設備排序（穩定）：設備名稱的自然順序，不屬於任何設備的排最後；同一台設備內保留原順序。
   * 回傳 [{ f, idx, dev }]。
   */
  function sortByDevice(Q, findings) {
    const rows = findings.map((f, idx) => ({ f, idx, dev: findingDevice(Q, f) }));
    return rows.sort((a, b) => {
      if (a.dev === b.dev) return a.idx - b.idx;
      if (a.dev === null || b.dev === null) return a.dev === null ? 1 : -1;
      return U.natural(Q.devName(a.dev), Q.devName(b.dev)) || U.cmp(a.dev, b.dev) || a.idx - b.idx;
    });
  }

  // ---------------------------------------------------------------- 防火牆：停用規則的指令範例
  /*
   * 適合以「停用規則」處理的檢查。F03 的放行可能仍有需要，只在確認不需要後才停用。
   * 依 routeros-acl-audit skill：用 disabled=yes，以 comment 或屬性 find（不用規則編號），附回復與驗證。
   */
  const DISABLE_FIX = {
    F01: { why: '這條規則被前面的規則完全遮蔽，停用不會改變防火牆行為' },
    F02: { why: '這條規則與前面的規則重複，停用不會改變防火牆行為' },
    F06: { why: '以固定來源埠放行可被繞過；停用後若有服務需要，改用連線狀態或目的埠放行' },
    F03: { why: '這條放行讓 WAN 可以主動建立新連線', confirm: '先確認 WAN 已不需要連入這個服務，再停用；仍需要時改為限制來源位址（例如 src-address-list），不要直接停用' },
  };
  // 不需要加引號的值：英數字與 _ . : / -。含 ! 的否定、逗號清單、空白與其他字元一律加引號；
  // 引號內的 \ " $ 要跳脫（$ 在 RouterOS 字串中會被當成變數）
  const quote = (v) => {
    const s = String(v);
    return /^[A-Za-z0-9_.:/-]+$/.test(s) ? s : '"' + s.replace(/[\\"$]/g, '\\$&') + '"';
  };
  const sortedEntries = (o) => Object.entries(o || {}).sort((a, b) => U.cmp(a[0], b[0]));
  // 只有能在設備上原樣比對的註解才拿來 find：Big5 等轉碼後的文字可能與設備內的位元組不同
  const usableComment = (r) => !!r.comment && (r.commentEncoding === 'ascii' || r.commentEncoding === 'utf-8');

  /**
   * 這筆 finding 的停用指令範例；不適用時為 null。
   * find 的條件依序嘗試：comment、比對條件（action＋match＋params）、兩者合併，取同一個 chain 中沒有其他規則符合的第一個；
   * 都有其他規則符合時取符合最少的，並警告。
   * 回傳 { id, rule, path, where, by: 'comment'|'match'|'comment+match', others（同 chain 也符合 find 的其他規則）, warnings, confirm, text }。
   */
  function disableRuleFix(Q, f) {
    const fix = DISABLE_FIX[f.id]; if (!fix) return null;
    const e = f.entities.find((x) => x.type === 'rule');
    const rule = e && Q.getFirewallRule(e.key); if (!rule) return null;
    const path = `/${rule.family} firewall ${rule.table}`;
    const chainRules = Q.firewallRulesOf(rule.dev, { family: rule.family, table: rule.table, chain: rule.chain }).filter((r) => r.key !== rule.key);
    // find 比對的是「含有這些屬性值」：其他規則多出的屬性不影響，所以同 chain 的其他規則（含停用的）也可能符合
    const sameMatch = (r) => r.action === rule.action && sortedEntries(rule.match).every(([k, v]) => r.match[k] === v)
      && sortedEntries(rule.params).every(([k, v]) => r.params[k] === v);
    const matchConds = [['action', rule.action], ...sortedEntries(rule.match), ...sortedEntries(rule.params)];
    const comment = usableComment(rule);
    const candidates = [
      comment ? { by: 'comment', conds: [['comment', rule.comment]], hits: (r) => r.comment === rule.comment } : null,
      { by: 'match', conds: matchConds, hits: sameMatch },
      comment ? { by: 'comment+match', conds: [['comment', rule.comment], ...matchConds], hits: (r) => r.comment === rule.comment && sameMatch(r) } : null,
    ].filter(Boolean).map((c) => Object.assign(c, { others: chainRules.filter(c.hits) }));
    const pick = candidates.find((c) => !c.others.length) || candidates.slice().sort((a, b) => a.others.length - b.others.length)[0];
    const { by, others } = pick;
    const where = [['chain', rule.chain], ...pick.conds].map(([k, v]) => `${k}=${quote(v)}`).join(' ');
    const warnings = [];
    if (others.length) {
      warnings.push(`這個 find 可能符合多條規則：同一個 chain 另有 ${others.length} 條符合同樣的條件（第 ${others.map((r) => r.position).join('、')} 條），執行前先用驗證指令確認只列出一條`);
      if (f.id === 'F02') warnings.push('重複的規則條件相同，find 無法區分：先在 WinBox／WebFig 為要停用的這條加上不同的 comment，再以 comment find');
    }
    if (rule.comment && !comment) warnings.push('註解不是 ASCII／UTF-8，無法確定與設備內的文字相同，改用規則的比對條件 find');
    const src = rule.src && rule.src[0] && Q.block(rule.src[0][0]);
    const family = rule.family === 'ipv6' ? 'IPv6' : 'IPv4';
    const one = (s) => String(s).replace(/[\r\n]+/g, ' ');
    const lines = [
      '# 範例，執行前請核對（本工具只產生文字，不會連線或寫回設備）',
      `# ${one(Q.devName(rule.dev))}：${f.id} ${family} ${rule.table} ${rule.chain} 第 ${rule.position} 條${src ? `（${one(src.file)} 第 ${rule.src[0][1]} 行）` : ''}`,
      `# ${fix.why}`,
      fix.confirm ? `# ${f.id}：${fix.confirm}` : null,
      ...warnings.map((w) => '# 警告：' + w),
      '# 停用',
      `${path} set [find where ${where}] disabled=yes`,
      '# 驗證：應只列出一條，且前面標 X（已停用）',
      `${path} print where ${where}`,
      '# 回復',
      `${path} set [find where ${where}] disabled=no`,
    ].filter((x) => x !== null);
    return { id: f.id, rule, path, where, by, others, warnings, confirm: fix.confirm || null, text: lines.join('\n') + '\n' };
  }

  // ---------------------------------------------------------------- C01 → devices.csv 草稿
  /*
   * 格式依 tools/collect.sh 的 load_inventory：name,address,user,port[,extra]，第一個資料列是標題列；
   * 開頭是 # 的列（含標題列之前）與空白列會略過，所以說明與無法使用的設備都寫成註解列。
   * collect.sh 只檢查 user 不為空、不含空白與逗號，無法擋下佔位值，所以佔位值要明顯，並在開頭說明。
   */
  const USER_PLACEHOLDER = 'CHANGE_ME';
  const COLLECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/; // 與 collect.sh 的設備名稱規則相同
  /** 回傳 { text, rows: [{ dev, name, address, basis, ok, reason }] }；address 依序取管理 IP、鄰居回報的位址 */
  function devicesCsvDraft(snap, Q) {
    const one = (s) => String(s).replace(/[\r\n]+/g, ' ');
    const devs = U.uniq(snap.findings.filter((f) => f.id === 'C01').map((f) => (f.entities.find((e) => e.type === 'device') || {}).key).filter(Boolean));
    const seen = new Set();
    const rows = devs.map((k) => Q.getDevice(k)).filter(Boolean).map((d) => {
      const heard = Q.ipAddresses().filter((a) => a.dev === d.key && a.hearsay).map((a) => a.ip);
      const address = d.mgmtIp || heard[0] || '';
      const basis = d.mgmtIp ? '管理 IP' : heard.length ? '鄰居回報的位址' : null;
      let reason = null;
      if (!address) reason = '沒有管理 IP 或鄰居回報的位址，請補上 address';
      else if (/[\s,]/.test(address)) reason = 'address 含空白或逗號，collect.sh 不接受';
      else if (!COLLECT_NAME.test(d.name)) reason = '名稱不符合 collect.sh 的規則（開頭英數字，其餘只能用英數字與 _ . : -），請改名';
      else if (seen.has(d.name)) reason = '名稱重複，collect.sh 不接受';
      if (!reason) seen.add(d.name);
      return { dev: d.key, name: d.name, address, basis, ok: !reason, reason };
    });
    const m = snap.meta;
    const out = [
      '# devices.csv 草稿：由 topo-mikrotik 依 C01（只被鄰居發現、沒有收集資料的網路設備）產生',
      `# 基準建立時間 ${m.createdAt}，輸入指紋 ${m.inputHash}`,
      `# user 欄是佔位值 ${USER_PLACEHOLDER}：collect.sh 不會擋下它，請先改成實際的 SSH 帳號`,
      '# port 預設 22，請依設備修改；extra 留空時 collect.sh 會依介面類型自動加上選用命令',
      '# 開頭是 # 的列會被 collect.sh 略過：無法直接使用的設備寫成註解，修正後移除 # 即可',
      '# 建議先執行：tools/collect.sh devices.csv --dry-run',
      'name,address,user,port,extra',
    ];
    rows.forEach((r) => {
      if (r.ok) out.push(`# ${one(r.name)}：address 取自${r.basis}`, `${r.name},${r.address},${USER_PLACEHOLDER},22`);
      else out.push(`# ${one(r.name)}：${r.reason}`, `# ${one(r.name).replace(/,/g, ' ')},${r.address},${USER_PLACEHOLDER},22`);
    });
    if (!rows.length) out.push('# 目前的基準沒有 C01（未收集的網路設備）');
    return { text: out.join('\n') + '\n', rows };
  }

  // ---------------------------------------------------------------- 修復追蹤
  /**
   * 「已排程修復」的確認（findingKey 在兩份基準之間穩定）分成三組：
   *   fixed：舊基準有、新基準沒有；open：新基準仍有，訊息相同（或舊基準沒有）；changed：兩邊都有、訊息不同。
   * acks 是 [[findingKey, { kind, ... }]]。兩份基準都沒有的鍵（其他網路的確認）略過。
   */
  function fixTracking(qOld, qNew, acks) {
    const byKey = (q) => { const m = new Map(); q.findings().forEach((f) => U.getOr(m, q.findingKey(f), () => []).push(f)); return m; };
    const fo = byKey(qOld); const fn = byKey(qNew);
    const out = { fixed: [], open: [], changed: [] };
    const msgs = (list) => list.map((f) => f.message).sort().join('\n');
    acks.filter(([, v]) => v && v.kind === 'scheduled').map(([k]) => k).sort(U.cmp).forEach((key) => {
      const before = fo.get(key) || []; const after = fn.get(key) || [];
      if (!before.length && !after.length) return;
      if (!after.length) out.fixed.push({ key, before, after });
      else if (before.length && msgs(before) !== msgs(after)) out.changed.push({ key, before, after });
      else out.open.push({ key, before, after });
    });
    return out;
  }

  V.remediation = { ACK_KIND, ackKindText, findingDevice, sortByDevice, DISABLE_FIX, disableRuleFix, quote, devicesCsvDraft, USER_PLACEHOLDER, fixTracking };
})(globalThis.SSOT = globalThis.SSOT || {});
