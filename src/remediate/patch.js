/*
 * 修正 patch（ssot-patch/1）：由基準的 finding 產生結構化的修正計畫，再輸出成 RouterOS .rsc 文字。
 * 工具維持唯讀：這裡只產生文字，不連線、不套用到設備。
 *
 *   const Q = SSOT.query(snapshot);
 *   const plan = SSOT.remediate.plan(Q, selection);   // 純 JSON，可重現（只用 Snapshot 的事實）
 *   SSOT.remediate.renderRsc(plan, dev);              // 套用：前置檢查全部通過後才改設定
 *   SSOT.remediate.renderRollback(plan, dev);         // 依 before（基準的事實）還原
 *   SSOT.remediate.renderVerify(plan, dev);           // print where …，並寫出預期結果
 *
 * level：auto（可直接產生指令）、choice（要使用者選擇，第二階段）、manual（需要人工判斷）。
 * 這一階段只實作 auto：F01／F02／F06 以 disabled=yes 停用規則；其他 finding 放進 skipped 並附原因。
 *
 * RouterOS 語法依據（官方手冊）：
 *   - find where／print where、set、:if、:len、:error：https://manual.mikrotik.com/docs/developer-guides/scripting.md
 *   - where 的值要加引號才是字串比對（未加引號的 10.0.0.0/24 會轉成 ip-prefix，和字串屬性比不到）：
 *     https://manual.mikrotik.com/docs/developer-guides/scripting/scripting-tips-and-tricks.md
 *   - /import 逐行執行到第一個錯誤為止（沒有交易），所以前置檢查全部寫在套用指令之前：
 *     https://manual.mikrotik.com/docs/getting-started/configuration-management.md
 *   - 字串跳脫 \" \\ \$ 與 \XX（兩位大寫十六進位）：同上 scripting.md 的 Constant Escape Sequences。
 * 手冊沒有說明 /import 對非 ASCII 位元組的處理，所以輸出的 .rsc 全部是 ASCII：字串中的非 ASCII 位元組寫成 \XX
 * （與 RouterOS export 的寫法相同），註解中的非 ASCII 字元寫成 <U+XXXX>。中文說明放在 item 的 note／risk／warnings。
 */
(function (S) {
  'use strict';
  const U = S.util;
  const SCHEMA = 'ssot-patch/1';

  // ---------------------------------------------------------------- 等級與 auto 修正的說明
  /** finding id → 等級。未列出的是 manual。choice 的修正在第二階段實作，這一階段放進 skipped。 */
  const LEVEL = {
    F01: 'auto', F02: 'auto', F06: 'auto',
    F03: 'choice', V01: 'choice', V08: 'choice', R06: 'choice',
    A06: 'choice', A07: 'choice', A08: 'choice', A09: 'choice', A10: 'choice', A11: 'choice', A12: 'choice',
  };
  const levelOf = (id) => LEVEL[id] || 'manual';
  /** auto 修正：停用規則。why 是 note（中文）；risk 依規則停用後對防火牆行為的影響。 */
  const DISABLE = {
    F01: { why: '這條規則被前面的規則完全遮蔽，停用不會改變防火牆行為', risk: { level: 'low', text: '依基準的事實，前面的規則已涵蓋這條；export 不含動態規則，套用前以前置檢查確認只找到一條' } },
    F02: { why: '這條規則與前面的規則重複，停用不會改變防火牆行為', risk: { level: 'low', text: '前面相同的規則仍會處理同樣的封包；套用前以前置檢查確認只找到一條' } },
    F06: { why: '以固定來源埠放行可被繞過；停用後若有服務需要，改用連線狀態或目的埠放行', risk: { level: 'medium', text: '依賴這條放行的流量改由後面的規則處理，可能被擋下；先確認沒有服務需要它，或先加上以 connection-state 或 dst-port 放行的規則' } },
  };
  const SKIP_TEXT = {
    choice: '這項修正需要選擇處理方式，第二階段才產生指令',
    manual: '這項檢查需要人工判斷，沒有自動修正；處理方式見規則的處理建議',
    'no-rule': '找不到這筆檢查結果指向的防火牆規則',
    'already-disabled': '基準中這條規則已經停用',
    'same-target': '同一條規則已由前面的修正停用',
    'not-found': '基準中沒有這個 findingKey',
    'unsafe-property': '規則的屬性名稱不是 RouterOS 的屬性格式，無法安全地寫成 find 條件',
    'ambiguous-find': 'find 條件可能符合多條規則，無法確定只停用這一條；先為這條規則加上可區分的 comment，再重新收集',
  };

  // ---------------------------------------------------------------- 選取
  const strList = (v, name) => {
    if (v == null) return null;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new TypeError(`S.remediate.plan：selection.${name} 必須是字串陣列`);
    return v;
  };
  /**
   * selection：省略或 null 為全部；字串陣列為 findingKey 清單；物件 { keys?, ids?, devices? } 為交集篩選。
   * 回傳 { rows: [{ f, idx, key, dev }], missing: [findingKey] }（missing 是基準中沒有的鍵，排序後列出）。
   */
  function select(Q, selection) {
    const all = Q.findings().map((f, idx) => ({ f, idx, key: Q.findingKey(f), dev: Q.findingDevice(f) }));
    if (selection == null) return { rows: all, missing: [] };
    const sel = Array.isArray(selection) ? { keys: selection } : selection;
    if (typeof sel !== 'object') throw new TypeError('S.remediate.plan：selection 必須是 findingKey 陣列或 { keys, ids, devices }');
    const known = new Set(['keys', 'ids', 'devices']);
    const extra = Object.keys(sel).filter((k) => !known.has(k));
    if (extra.length) throw new TypeError(`S.remediate.plan：selection 不認得的欄位 ${extra.join('、')}`);
    const keys = strList(sel.keys, 'keys'); const ids = strList(sel.ids, 'ids'); const devs = strList(sel.devices, 'devices');
    const keySet = keys && new Set(keys); const idSet = ids && new Set(ids);
    const devSet = devs && new Set(devs.map((d) => { const x = Q.getDevice(d); return x ? x.key : d; }));
    const rows = all.filter((r) => (!keySet || keySet.has(r.key)) && (!idSet || idSet.has(r.f.id)) && (!devSet || devSet.has(r.dev)));
    const present = new Set(all.map((r) => r.key));
    const missing = keys ? U.uniq(keys.filter((k) => !present.has(k))).sort(U.cmp) : [];
    return { rows, missing };
  }

  // ---------------------------------------------------------------- 停用規則（F01／F02／F06）
  const sortedEntries = (o) => Object.entries(o || {}).sort((a, b) => U.cmp(a[0], b[0]));
  // 只有能在設備上原樣比對的註解才拿來 find：Big5 等轉碼後的文字可能與設備內的位元組不同
  const usableComment = (r) => !!r.comment && (r.commentEncoding === 'ascii' || r.commentEncoding === 'utf-8');
  const PROP = /^[a-z0-9][a-z0-9-]*$/;
  const nonAscii = (s) => /[^\x00-\x7f]/.test(String(s));

  /**
   * 這條規則的 find 條件。依序嘗試 comment、比對條件（action＋match＋params）、兩者合併，
   * 取同一個 chain 中沒有其他規則符合的第一個；都有其他規則符合時取符合最少的（others 不為空）。
   * find where 比對的是「含有這些屬性值」：其他規則多出的屬性不影響，所以同 chain 的其他規則（含停用的）也可能符合。
   */
  function findTarget(Q, rule) {
    const chainRules = Q.firewallRulesOf(rule.dev, { family: rule.family, table: rule.table, chain: rule.chain }).filter((r) => r.key !== rule.key);
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
    const where = {};
    [['chain', rule.chain], ...pick.conds].forEach(([k, v]) => { where[k] = String(v); });
    return { by: pick.by, where, others: pick.others, commentUsable: comment };
  }

  /** 一筆 F01／F02／F06 → { item } 或 { skip: { level, reason, detail } }。 */
  function disableItem(Q, row) {
    const { f } = row; const fix = DISABLE[f.id];
    const e = f.entities.find((x) => x.type === 'rule');
    const rule = e && Q.getFirewallRule(e.key);
    if (!rule) return { skip: { level: 'manual', reason: 'no-rule' } };
    if (rule.disabled) return { skip: { level: 'manual', reason: 'already-disabled' } };
    const t = findTarget(Q, rule);
    if (!Object.keys(t.where).every((k) => PROP.test(k))) return { skip: { level: 'manual', reason: 'unsafe-property' } };
    if (t.others.length) {
      const pos = t.others.map((r) => r.position).join('、');
      const detail = f.id === 'F02'
        ? `重複的規則條件相同，find 無法區分（同一個 chain 第 ${pos} 條也符合）：先在 WinBox／WebFig 為要停用的這條加上不同的 comment，再重新收集`
        : `find 條件可能符合多條規則（同一個 chain 第 ${pos} 條也符合），前置檢查一定會中止：先為這條加上可區分的 comment，再重新收集`;
      return { skip: { level: 'manual', reason: 'ambiguous-find', detail, rule: rule.key } };
    }
    const warnings = [];
    if (rule.comment && !t.commentUsable) warnings.push('註解不是 ASCII／UTF-8，無法確定與設備內的文字相同，改用規則的比對條件 find');
    if (Object.entries(t.where).some(([k, v]) => k !== 'comment' && nonAscii(v))) warnings.push('find 條件含非 ASCII 文字，原始編碼不明（以 UTF-8 輸出）；設備上找不到時前置檢查會中止');
    const path = `/${rule.family} firewall ${rule.table}`;
    return {
      item: {
        key: 'disable-rule:' + rule.key,
        findingKey: row.key, id: f.id, dev: rule.dev, level: 'auto',
        target: { type: 'rule', key: rule.key, family: rule.family, table: rule.table, chain: rule.chain, position: rule.position, by: t.by },
        ops: [{ op: 'set', path, where: t.where, expect: 1, props: { disabled: 'yes' }, before: { disabled: 'no' } }],
        evidence: (f.evidence || []).map((x) => Object.assign({}, x)),
        risk: Object.assign({}, fix.risk),
        note: fix.why,
        warnings,
      },
    };
  }

  // ---------------------------------------------------------------- plan
  /**
   * 回傳 { schema: 'ssot-patch/1', baseline: { inputHash, createdAt, version }, devices: [{ key, name }], items, skipped }。
   * items 依設備（名稱的自然順序，再依鍵）、再依 finding 在基準中的順序；skipped 同樣排序，不屬於任何設備的最後，基準中沒有的鍵最後。
   */
  function plan(Q, selection) {
    const { rows, missing } = select(Q, selection);
    const devOrder = (a, b) => {
      if (a.dev === b.dev) return a.idx - b.idx;
      if (a.dev === null || b.dev === null) return a.dev === null ? 1 : -1;
      return U.natural(Q.devName(a.dev), Q.devName(b.dev)) || U.cmp(a.dev, b.dev) || a.idx - b.idx;
    };
    const items = []; const skipped = []; const byTarget = new Map();
    const skip = (row, s) => skipped.push(Object.assign({ findingKey: row.key, id: row.f.id, dev: row.dev, level: s.level, reason: s.reason, detail: s.detail || SKIP_TEXT[s.reason] },
      s.rule ? { rule: s.rule } : {}, s.item ? { item: s.item } : {}));
    rows.slice().sort(devOrder).forEach((row) => {
      const level = levelOf(row.f.id);
      if (level !== 'auto') { skip(row, { level, reason: level }); return; }
      const r = disableItem(Q, row);
      if (r.skip) { skip(row, r.skip); return; }
      const prev = byTarget.get(r.item.target.key);
      if (prev) { skip(row, { level: 'auto', reason: 'same-target', item: prev.key, rule: r.item.target.key }); return; }
      byTarget.set(r.item.target.key, r.item); items.push(r.item);
    });
    missing.forEach((k) => skipped.push({ findingKey: k, id: null, dev: null, level: null, reason: 'not-found', detail: SKIP_TEXT['not-found'] }));
    const m = Q.meta();
    const devices = U.uniq(items.map((i) => i.dev)).map((key) => ({ key, name: Q.devName(key) }));
    return { schema: SCHEMA, baseline: { inputHash: m.inputHash, createdAt: m.createdAt, version: m.version }, devices, items, skipped };
  }

  // ---------------------------------------------------------------- RouterOS 文字
  /** UTF-8 位元組（不依賴 TextEncoder，結果與環境無關）。 */
  function utf8(s) {
    const out = [];
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
  /**
   * RouterOS 字串常值（一律加引號，where 才是字串比對）：\" \\ \$ 用手冊的跳脫；? 與控制字元、非 ASCII 位元組寫成 \XX。
   * 結果只含可列印 ASCII。
   */
  function rosStr(v) {
    let out = '"';
    utf8(v).forEach((b) => {
      if (b === 0x22) out += '\\"'; else if (b === 0x5c) out += '\\\\'; else if (b === 0x24) out += '\\$';
      else if (b === 0x3f || b < 0x20 || b > 0x7e) out += '\\' + hex2(b);
      else out += String.fromCharCode(b);
    });
    return out + '"';
  }
  /** 註解用的 ASCII 文字：可列印 ASCII（反斜線除外）原樣，其他字元（含換行）寫成 <U+XXXX>。 */
  function asciiText(s) {
    let out = '';
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      out += c >= 0x20 && c <= 0x7e && c !== 0x5c ? ch : '<U+' + c.toString(16).toUpperCase().padStart(4, '0') + '>';
    }
    return out;
  }
  const whereExpr = (where) => Object.entries(where).map(([k, v]) => `${k}=${rosStr(v)}`).join(' ');
  const propVal = (v) => (/^[A-Za-z0-9_.-]+$/.test(String(v)) ? String(v) : rosStr(v));
  const propsExpr = (props) => Object.entries(props).map(([k, v]) => `${k}=${propVal(v)}`).join(' ');
  const findExpr = (op) => `[find where ${whereExpr(op.where)}]`;

  function itemsOf(plan, dev) {
    if (!plan || plan.schema !== SCHEMA) throw new TypeError(`S.remediate：plan 的 schema 必須是 ${SCHEMA}`);
    const d = plan.devices.find((x) => x.key === dev);
    if (!d) throw new RangeError(`S.remediate：plan 中沒有設備 ${dev} 的修正`);
    return { d, items: plan.items.filter((i) => i.dev === dev) };
  }
  /** item 的一行標題：[n] F01 ip filter input rule 6 (檔案 line 行號) */
  function itemTitle(it, n) {
    const t = it.target; const ev = it.evidence[0];
    return asciiText(`[${n}] ${it.id} ${t.family} ${t.table} ${t.chain} rule ${t.position}${ev && ev.file ? ` (${ev.file} line ${ev.line})` : ''}`);
  }
  function header(plan, d, kind, lines) {
    const b = plan.baseline;
    return [
      `# topo-mikrotik ${plan.schema} ${kind}`,
      asciiText(`# device: ${d.name} (key ${d.key})`),
      asciiText(`# baseline: inputHash=${b.inputHash} createdAt=${b.createdAt} version=${b.version}`),
      '# Text only: topo-mikrotik never connects to or changes a device. Review every line before use.',
      ...lines,
    ];
  }
  function precheck(op, label) {
    const msg = rosStr(`topo-mikrotik pre-check failed: ${label} must match exactly ${op.expect} rule(s)`);
    return `:if ([:len [${op.path} find where ${whereExpr(op.where)}]] != ${op.expect}) do={ :error ${msg} }`;
  }
  const label = (it, n) => asciiText(`[${n}] ${it.id} ${it.target.family} ${it.target.table} ${it.target.chain} rule ${it.target.position}`);
  const prechecks = (items) => items.flatMap((it, k) => it.ops.map((op) => precheck(op, label(it, k + 1))));
  const finish = (lines) => lines.join('\n') + '\n';

  /** 套用用的 .rsc：所有前置檢查在前（任一失敗就 :error 中止，不會改到設定），再依序套用。 */
  function renderRsc(plan, dev) {
    const { d, items } = itemsOf(plan, dev);
    const out = header(plan, d, 'apply', [
      `# items: ${items.length}`,
      '# Run: /import file-name=<this file> (add verbose=yes dry-run first to catch syntax errors).',
      '# /import runs line by line and stops at the first error, so every pre-check comes before any change.',
      '',
      '# ---- pre-checks',
      ...prechecks(items),
      '',
      '# ---- apply',
    ]);
    items.forEach((it, k) => it.ops.forEach((op) => {
      out.push(`# ${itemTitle(it, k + 1)}: before ${propsExpr(op.before)}`, `${op.path} set ${findExpr(op)} ${propsExpr(op.props)}`);
    }));
    return finish(out);
  }
  /** 還原的 op：套用的反向（item 與 op 都倒序，props 與 before 互換）；回傳 [{ item, n, op }]，n 是 item 在這台設備的序號。 */
  function rollbackOps(plan, dev) {
    const { items } = itemsOf(plan, dev);
    const out = [];
    items.forEach((it, k) => it.ops.forEach((op) => out.push({ item: it, n: k + 1, op: Object.assign({}, op, { props: Object.assign({}, op.before), before: Object.assign({}, op.props) }) })));
    return out.reverse();
  }
  /** 還原用的 .rsc：依基準的 before 還原（倒序）。前置檢查同樣在前。 */
  function renderRollback(plan, dev) {
    const { d, items } = itemsOf(plan, dev);
    const ops = rollbackOps(plan, dev);
    const out = header(plan, d, 'rollback', [
      `# items: ${items.length}`,
      '# Restores the values recorded in the baseline (before), in reverse order of the apply file.',
      '',
      '# ---- pre-checks',
      ...ops.map(({ item, n, op }) => precheck(op, label(item, n))),
      '',
      '# ---- rollback',
    ]);
    ops.forEach(({ item, n, op }) => out.push(`# ${itemTitle(item, n)}: restore ${propsExpr(op.props)}`, `${op.path} set ${findExpr(op)} ${propsExpr(op.props)}`));
    return finish(out);
  }
  /** 驗證用的 .rsc：每個 op 一條 print where，註解寫出預期結果。 */
  function renderVerify(plan, dev) {
    const { d, items } = itemsOf(plan, dev);
    const out = header(plan, d, 'verify', [`# items: ${items.length}`, '# Run after the apply file. Each print must list exactly the number of rules stated.', '']);
    items.forEach((it, k) => it.ops.forEach((op) => {
      const flag = op.props.disabled === 'yes' ? ', flagged X (disabled)' : op.props.disabled === 'no' ? ', not flagged X' : '';
      out.push(`# ${itemTitle(it, k + 1)}: expect ${op.expect} rule${flag}`, `${op.path} print where ${whereExpr(op.where)}`);
    }));
    return finish(out);
  }

  /** 每台設備的檔名基底：設備鍵只含 A-Z a-z 0-9 _ . - 且不重複時直接用，否則替換後加上鍵的雜湊。 */
  function fileBase(plan, dev) {
    const safe = (k) => k.replace(/[^A-Za-z0-9_.-]/g, '_');
    const s = safe(dev);
    const clash = plan.devices.some((x) => x.key !== dev && safe(x.key) === s);
    return s === dev && !clash ? s : `${s}-${U.hash(dev).slice(0, 8)}`;
  }
  /** 多台設備：每台一組 { dev, name, base, apply, rollback, verify }（檔名為 base.rsc、base-rollback.rsc、base-verify.rsc），依 plan.devices 的順序。 */
  function files(plan) {
    return plan.devices.map((d) => ({ dev: d.key, name: d.name, base: fileBase(plan, d.key),
      apply: renderRsc(plan, d.key), rollback: renderRollback(plan, d.key), verify: renderVerify(plan, d.key) }));
  }

  S.remediate = { SCHEMA, LEVEL, levelOf, DISABLE, SKIP_TEXT, plan, renderRsc, renderRollback, renderVerify, rollbackOps, files, fileBase, rosStr, asciiText };
})(globalThis.SSOT = globalThis.SSOT || {});
