/*
 * 分診 → 修 → 驗證 的畫面輔助：都是純函式，只透過查詢介面（Q）與核心（S.ledger、S.remediate）讀取，不改寫 Snapshot。
 *   - 處理紀錄的狀態文字（STATUS_TEXT）：狀態本身與轉換規則在核心 S.ledger（見 app-ledger.js）
 *   - advice：規則的常見原因與處理（每次從 CATALOG 讀取）
 *   - sortByDevice：檢查結果依所屬設備（Q.findingDevice）排序，檢查結果分頁的「依設備」分組與匯出共用
 *   - 修正計畫的文字（LEVEL_TEXT、RISK_TEXT）與單一項目的套用指令（itemApplyLines，取自 S.remediate.renderRsc）
 *   - devicesCsvDraft：由 C01 產生 tools/collect.sh 的設備清單草稿
 */
(function (S) {
  'use strict';
  const V = S.view; const U = S.util;

  // ---------------------------------------------------------------- 處理紀錄的狀態
  /** 狀態鍵（S.ledger.STATUS）→ 顯示文字；不認得的狀態（例如較新版本寫入的）原樣顯示 */
  const STATUS_TEXT = { open: '待處理', scheduled: '已排程修復', accepted: '可接受（豁免）', 'false-positive': '誤報', fixed: '已修好', regressed: '回歸' };
  const statusText = (s) => (s ? STATUS_TEXT[s] || s : '待處理');
  /** 狀態的標籤色（DOM 的 .chip.err 等） */
  const STATUS_CHIP = { open: '', scheduled: 'info', accepted: 'ok', 'false-positive': '', fixed: 'ok', regressed: 'err' };
  /** 仍待處理的狀態：與 S.ledger.summary 的 pending（open＋regressed）相同；不在處理紀錄中的也算待處理 */
  const isPendingStatus = (s) => !s || s === 'open' || s === 'regressed';

  // ---------------------------------------------------------------- 規則的常見原因與處理
  /**
   * 規則的處理建議與常見原因：每次都從 S.check.CATALOG 讀取，不複製文字（詳情、規則清單與匯出共用）。
   * 回傳 { action: 字串或 null, causes: 字串陣列 }；欄位不存在時 action 為 null、causes 為空陣列。
   * causes 寫成單一字串時視為一條。
   */
  function advice(id) {
    const c = S.check.CATALOG[id] || {};
    const causes = Array.isArray(c.causes) ? c.causes.filter((x) => typeof x === 'string' && x) : typeof c.causes === 'string' && c.causes ? [c.causes] : [];
    return { action: typeof c.action === 'string' && c.action ? c.action : null, causes };
  }

  // ---------------------------------------------------------------- 檢查結果所屬設備
  /**
   * 依設備排序（穩定）：所屬設備（Q.findingDevice）名稱的自然順序，不屬於任何設備的排最後；同一台設備內保留原順序。
   * 回傳 [{ f, idx, dev }]。
   */
  function sortByDevice(Q, findings) {
    const rows = findings.map((f, idx) => ({ f, idx, dev: Q.findingDevice(f) }));
    return rows.sort((a, b) => {
      if (a.dev === b.dev) return a.idx - b.idx;
      if (a.dev === null || b.dev === null) return a.dev === null ? 1 : -1;
      return U.natural(Q.devName(a.dev), Q.devName(b.dev)) || U.cmp(a.dev, b.dev) || a.idx - b.idx;
    });
  }

  // ---------------------------------------------------------------- 修正計畫（S.remediate）
  const LEVEL_TEXT = { auto: '可產生指令', choice: '需選擇處理方式（第二階段）', manual: '需人工判斷' };
  const RISK_TEXT = { low: '低', medium: '中', high: '高' };
  const RISK_CHIP = { low: 'ok', medium: 'warn', high: 'err' };
  const RISK_ORDER = ['low', 'medium', 'high'];
  /** 一組 item 中最高的風險等級；沒有 item 時為 null */
  const maxRisk = (items) => items.reduce((m, it) => (RISK_ORDER.indexOf(it.risk.level) > RISK_ORDER.indexOf(m) ? it.risk.level : m), items.length ? 'low' : null);
  /**
   * 一個 item 的套用指令（修改後）：把只含這個 item 的計畫交給 S.remediate.renderRsc，取「# ---- apply」之後的指令行。
   * 指令文字只由核心產生，畫面不自己組；找不到段落時丟錯，不回傳空字串。
   */
  function itemApplyLines(plan, it) {
    const one = Object.assign({}, plan, { devices: plan.devices.filter((d) => d.key === it.dev), items: [it] });
    const lines = S.remediate.renderRsc(one, it.dev).split('\n');
    const at = lines.indexOf('# ---- apply');
    if (at < 0) throw new Error('S.remediate.renderRsc 的輸出缺少「# ---- apply」段落');
    return lines.slice(at + 1).filter((l) => l && !l.startsWith('#')).join('\n');
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

  V.remediation = { STATUS_TEXT, statusText, STATUS_CHIP, isPendingStatus, advice, sortByDevice, LEVEL_TEXT, RISK_TEXT, RISK_CHIP, maxRisk, itemApplyLines,
    devicesCsvDraft, USER_PLACEHOLDER };
})(globalThis.SSOT = globalThis.SSOT || {});
