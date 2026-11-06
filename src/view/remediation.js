/*
 * 研判 → 修 → 驗證 的畫面輔助：都是純函式，只透過查詢介面（Q）與核心（S.ledger、S.remediate）讀取，不改寫 Snapshot。
 *   - 處理紀錄的狀態文字（STATUS_TEXT）：狀態本身與轉換規則在核心 S.ledger（見 app-ledger.js）
 *   - advice：檢查的常見原因與處理（每次從檢查目錄 S.query.rule 讀取）；hintLine：一句處理提示
 *   - sortByDevice：檢查結果依所屬設備（Q.findingDevice）排序，檢查結果分頁的「依設備」分組與匯出共用
 *   - 修正計畫的文字（LEVEL_TEXT、RISK_TEXT、targetText、choiceText）與單一項目的套用指令（itemApplyLines，取自 S.remediate.renderRsc）
 *   - matchFindings／findingRef：未產生指令的項目以 findingKey 對回檢查結果，列出訊息並可點擊開啟
 *   - facetText：檢查結果的比對對象（finding.facet）的顯示文字，詳情與修正計畫的逐筆勾選共用
 *   - devicesCsvDraft：由 C01 產生 tools/collect.sh 的設備清單草稿
 */
(function (S) {
  'use strict';
  const V = S.view; const U = S.util;

  // ---------------------------------------------------------------- 處理紀錄的狀態
  /** 狀態鍵（S.ledger.STATUS）→ 顯示文字；不認得的狀態（例如較新版本寫入的）原樣顯示。單一來源是 S.report（匯出的報表共用） */
  const STATUS_TEXT = S.report.STATUS_TEXT;
  const statusText = S.report.statusText;
  /** 狀態的標籤色（DOM 的 .chip.err 等） */
  const STATUS_CHIP = { open: '', scheduled: 'info', accepted: 'ok', 'false-positive': '', fixed: 'ok', regressed: 'err' };

  // ---------------------------------------------------------------- 檢查的常見原因與處理
  /**
   * 檢查的處理建議與常見原因：每次都從檢查目錄（S.query.rule）讀取，不複製文字（詳情、檢查清單與匯出共用）。
   * 畫面讀 causes／action 一律經這裡；實作就是 S.report.advice（匯出的報表用同一個）。
   * 回傳 { action: 字串或 null, hint: 字串或 null, causes: 字串陣列 }；欄位不存在時 action／hint 為 null、causes 為空陣列。
   * hint 是 action 的第一句（S.query.rule 推導，畫面不自己切句）。causes 寫成單一字串時視為一條。
   */
  const advice = S.report.advice;
  /**
   * 檢查的一句處理提示「處理：…」（advice(id).hint）：「研判」展開的檢查群組與詳情的檢查結果卡片共用。
   * 反引號內以 <code> 顯示（V.codeText）；沒有提示時為 null。cls 是額外的 class。
   */
  function hintLine(id, cls) {
    const t = advice(id).hint;
    return t ? V.h('div', { class: 'rule-hint muted' + (cls ? ' ' + cls : ''), 'data-rule-id': id }, ['處理：', ...V.codeText(t)]) : null;
  }

  // ---------------------------------------------------------------- 檢查結果所屬設備
  /**
   * 依設備排序（穩定）：所屬設備（Q.findingDevice）名稱的自然順序，不屬於任何設備的排最後；同一台設備內保留原順序。
   * 回傳 [{ f, idx, dev }]。實作在 S.report（匯出依設備排序用同一個，畫面分組與報表順序才一致）。
   */
  const sortByDevice = S.report.sortByDevice;

  // ---------------------------------------------------------------- 修正計畫（S.remediate）
  const LEVEL_TEXT = { auto: '可產生指令', choice: '需選擇處理方式（已支援的檢查在修正計畫中選擇要採用的值；其他檢查尚未產生指令）', manual: '需人工判斷' };
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

  /**
   * item 的修改對象（plan.items[].target）的顯示文字，修正計畫與總表共用：
   *   rule（F 系列）：「ip filter input 第 6 條」；servers（A12）：「NTP 伺服器（/system ntp client servers）」。
   * 不認得的 type 原樣顯示 type 與 key，不顯示 undefined。
   */
  function targetText(t) {
    if (t.type === 'rule') return `${t.family} ${t.table} ${t.chain} 第 ${t.position} 條`;
    if (t.type === 'servers') return `${FACET_ITEM[t.facet] || t.facet}（${t.menu}）`;
    return `${t.type} ${t.key}`;
  }
  /** plan.choices 的一筆目前的選擇：{ option（選到的選項或 null）, text（顯示文字） }；總表與畫面共用 */
  function choiceText(c) {
    const option = c.options.find((o) => o.id === c.chosen) || null;
    if (!option) return { option, text: '沒有多數，尚未選擇（不產生指令）' };
    const by = c.chosenBy === 'default' ? '（預設：多數決，推論）' : '（使用者選擇）';
    return { option, text: option.label + by };
  }

  /** findingKey 對不到目前基準的檢查結果時的說明（例如 skipped 的 not-found） */
  const MISSING_FINDING_TEXT = '基準中找不到這筆檢查結果';
  const FINDING_TEXT_MAX = 120; // 清單中訊息的最多字數；完整訊息放在 title
  /** 過長的訊息截斷並加上「…」 */
  const clipText = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  /**
   * 修正計畫的 skipped（或 items）逐筆對回 Q.findings() 中的檢查結果：回傳與 list 等長的陣列，每筆是 { idx, f } 或 null（基準中沒有，例如 not-found）。
   * idx 與 App.selectFinding 的索引相同。比對對象不同的已經以 facet 區分（例如 A12 的 DNS 與 NTP 是不同的鍵），
   * 但依輸入區塊產生的 I01、I03 不帶 facet，同一台設備的多段仍共用一個 findingKey（ADR-003）。
   * 這種情況的退路是依位置對應：同一個鍵的第 n 筆對到基準中這個鍵的第 n 筆（S.remediate.plan 對同一個鍵的列依 finding 在基準中的順序排列）。
   */
  function matchFindings(Q, list) {
    const used = new Map();
    return list.map((x) => {
      const n = used.get(x.findingKey) || 0; const idx = Q.findingIndexesByKey(x.findingKey)[n];
      used.set(x.findingKey, n + 1);
      return idx === undefined ? null : { idx, f: Q.finding(idx) };
    });
  }
  /**
   * 修正計畫中「未產生指令」的一筆所對應的檢查結果（matchFindings 的一筆）：找得到時是可點擊（滑鼠與鍵盤）的訊息連結，
   * 過長時截斷、完整訊息在 title，點了在右側的詳細資料開啟該筆檢查結果（修正計畫留在中間）；
   * 找不到時明確說明，findingKey 放在 title。label 有值時連結文字改用它（訊息已另外以一般文字列出時，例如修正計畫的選擇）。
   */
  function findingRef(App, hit, key, label) {
    if (!hit) return V.h('span', { class: 'warn-line finding-missing', title: key }, MISSING_FINDING_TEXT);
    const msg = String(hit.f.message || '');
    return V.h('a', { class: 'link finding-ref', title: msg, 'data-finding-idx': String(hit.idx),
      onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); App.selectFinding(hit.idx); } }, label || clipText(msg, FINDING_TEXT_MAX));
  }

  // ---------------------------------------------------------------- 比對對象（finding.facet）
  /** facet 中項目代碼的顯示文字（A12、R06 的 dns／ntp／gateway，V06、V07 比較的屬性，F11、F14 的管理服務；產品名稱沿用 RouterOS 的寫法） */
  const FACET_ITEM = { dns: 'DNS 伺服器', ntp: 'NTP 伺服器', gateway: '閘道',
    'vlan-interface-name': 'VLAN 介面名稱', 'vlan-interface-comment': 'VLAN 介面說明', 'bridge-vlan-comment': 'bridge VLAN 說明',
    'mac-telnet': 'MAC Telnet', 'mac-winbox': 'MAC WinBox', upnp: 'UPnP', proxy: 'web proxy', socks: 'SOCKS', 'bandwidth-server': '頻寬測試伺服器（bandwidth-server）' };
  const facetItem = (s) => FACET_ITEM[s] || s;
  /** 「a|b」格式的 facet 拆成第一段與其餘（其餘部分可能含 |，原樣保留） */
  const facetSplit = (v) => { const at = v.indexOf('|'); return at < 0 ? [v, ''] : [v.slice(0, at), v.slice(at + 1)]; };
  /** 有格式的 facet 依檢查轉成可讀文字（格式見 CATALOG 的 facet）；第二段缺少時回傳 null，改顯示原值 */
  /**
   * facet 的名稱是正規化後的小寫：訊息裡有同一個名稱（不分大小寫，在「」內）時改用訊息的寫法，避免看起來像兩個名稱。
   */
  const asInMessage = (f, name) => {
    const msg = String((f && f.message) || ''); const at = msg.toLowerCase().indexOf(`「${String(name).toLowerCase()}」`);
    return at < 0 ? name : msg.slice(at + 1, at + 1 + String(name).length);
  };
  /**
   * F13 的 facet：就是 community 的 facet（model/build.js 的 communityFacets，放在 mgmtSettings 的 communities[].facet，checks.js 直接沿用）。
   * 名稱不重複時是 community 名稱；啟用中的有同名時在後面加「#」與內容雜湊的前 8 碼。
   * 這裡只用於顯示比對對象（拆出名稱與雜湊）；管理面設定的列與 F13 的對應直接比 facet（panels/details.js），不從 facet 拆名稱。
   * 只拆掉結尾的 #8 碼十六進位，名稱本身含 # 時不截斷。回傳 [名稱, 雜湊或空字串]。
   */
  const communityFacet = (v) => { const m = /^(.*)#([0-9a-f]{8})$/.exec(String(v)); return m ? [m[1], m[2]] : [String(v), '']; };
  const FACET_FORMAT = {
    I02: (v) => S.query.adapterLabel(v),
    V06: facetItem,
    V07: (v, f) => { const [a, b] = facetSplit(v); return b ? `${facetItem(a)}「${asInMessage(f, b)}」` : null; },
    A02: (v) => (v === 'unknown' ? 'VLAN 不明' : `VLAN ${v}`),
    A07: (v) => `網段 ${v}`,
    A08: (v) => `網段 ${v}（最外層）`,
    A10: (v, f) => { const [a, b] = facetSplit(v); return b ? `${a}「${asInMessage(f, b)}」` : null; },
    A11: (v) => { const [a, b] = facetSplit(v); return b ? `${a} ${b}` : null; },
    A12: facetItem,
    R02: (v) => `本端介面 ${v}`,
    R05: (v) => `網段 ${v}`,
    R06: (v) => { const [a, b] = facetSplit(v); return b ? `${facetItem(a)}（${b}）` : null; },
    F11: facetItem,
    F13: (v) => { const [name, tag] = communityFacet(v); return tag ? `community「${name}」（同名 #${tag}）` : `community「${name}」`; },
    F14: facetItem,
  };
  /**
   * 檢查結果的比對對象（finding.facet）的顯示文字：同一組檢查＋實體可能有多筆時，標示這筆檢查的是哪一個項目。
   * 沒有 facet 時為 null；檢查沒有對應的格式或格式不符時顯示原值，不隱藏。
   */
  function facetText(f) {
    if (!f || f.facet == null) return null;
    const v = String(f.facet); const fmt = FACET_FORMAT[f.id];
    return (fmt && fmt(v, f)) || v;
  }

  // ---------------------------------------------------------------- C01 → devices.csv 草稿
  /*
   * 格式依 tools/collect.sh 的 load_inventory：name,address,user,port[,extra]，第一個資料列是標題列；
   * 開頭是 # 的列（含標題列之前）與空白列會略過，所以說明與無法使用的設備都寫成註解列。
   * collect.sh 只檢查 user 不為空、不含空白與逗號，無法擋下佔位值，所以佔位值要明顯，並在開頭說明。
   */
  const USER_PLACEHOLDER = 'CHANGE_ME';
  const COLLECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/; // 與 collect.sh 的設備名稱規則相同
  /** Q 是基準的查詢介面。回傳 { text, rows: [{ dev, name, address, basis, ok, reason }] }；address 依序取管理 IP、鄰居回報的位址 */
  function devicesCsvDraft(Q) {
    const one = (s) => String(s).replace(/[\r\n]+/g, ' ');
    const devs = U.uniq(Q.findingsByRule('C01').map((f) => (f.entities.find((e) => e.type === 'device') || {}).key).filter(Boolean));
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
    const m = Q.meta();
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

  V.remediation = { STATUS_TEXT, statusText, STATUS_CHIP, advice, hintLine, sortByDevice, LEVEL_TEXT, RISK_TEXT, RISK_CHIP, maxRisk, itemApplyLines, targetText, choiceText,
    MISSING_FINDING_TEXT, FINDING_TEXT_MAX, clipText, matchFindings, findingRef, FACET_ITEM, FACET_RULES: Object.keys(FACET_FORMAT), facetText, communityFacet,devicesCsvDraft, USER_PLACEHOLDER };
})(globalThis.SSOT = globalThis.SSOT || {});
