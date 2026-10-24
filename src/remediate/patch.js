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
 * level：auto（可直接產生指令）、choice（要使用者選擇）、manual（需要人工判斷）。
 * auto：F01／F02／F06 以 disabled=yes 停用規則。choice：目前實作 A12（DNS／NTP 伺服器，見 serversChoice），
 *   選擇由呼叫端以 plan(Q, selection, { choices: { findingKey: 選項 id } }) 傳入；其他 choice 規則與 manual 放進 skipped 並附原因。
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
    'needs-choice': '沒有多數，無法推定要改成哪一組；請選擇要採用的值，或標為可接受',
    'accepted-choice': '已選擇不修改；請在處理紀錄把這筆檢查結果標為可接受',
    'ntp-v6': '這台設備以 RouterOS 6 的 primary-ntp／secondary-ntp 設定 NTP，目前的官方手冊無法查證這個寫法，沒有自動修正',
    'unsafe-value': '伺服器的值含有無法確認寫法的字元（例如 @vrf、%介面），沒有自動修正',
    'no-servers': '基準中沒有這台設備的伺服器設定來源，無法產生指令',
    'no-groups': '這筆檢查結果沒有分組資料（deviation.groups），無法列出選項',
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

  // ---------------------------------------------------------------- A12：DNS／NTP 伺服器（choice）
  /*
   * 一筆 A12（facet 為 dns 或 ntp）是一個選擇：改成多數的值、改成某一組的值，或不改（accept）。
   * 要修改的是值與選擇不同的設備，每台一個 item；各台依自己收集到的來源（Q.serversOf 的 menu＋param）產生指令。
   * RouterOS 語法依據（官方手冊）：
   *   - /ip dns 的 servers：multi，依順序嘗試：https://manual.mikrotik.com/docs/cli-reference/ip/dns.md
   *   - /system ntp client 的 servers：multi；靜態伺服器可用它設定，或在子選單 /system ntp client servers 以 address 逐筆 add，
   *     兩者是同一份靜態清單；DHCP 學到的是動態項目，不能修改：
   *     https://manual.mikrotik.com/docs/cli-reference/system/ntp/client.md、https://manual.mikrotik.com/docs/cli-reference/system/ntp/client/servers.md
   *   - 設定選單的 get（例如 [/system/resource/get version]）、:len（陣列的元素數）、:pick <陣列> <n>（取一個元素）、:tostr：
   *     https://manual.mikrotik.com/docs/developer-guides/scripting.md
   * 前置檢查逐項比對：先比 [:len]，再以 [:tostr [:pick …]] 逐一比對字串。手冊沒有陣列轉字串的分隔規則，所以不比整串；
   *   這個寫法手冊沒有完整範例，.rsc 與 warnings 都註明先在測試機確認。
   * 子選單（/system ntp client servers＋address）的設備改子選單本身：逐筆 set address，保留 min-poll、max-poll、iburst、auth-key；
   *   多的 remove、少的 add。不改用 client 的 servers=：它以整份清單取代靜態項目，手冊沒有說明子選單項目的其他屬性會不會保留。
   * RouterOS 6 的 primary-ntp／secondary-ntp：目前的官方手冊（v7）沒有這兩個參數，無法查證 → manual。
   */
  const SERVER_FACET = { dns: 'DNS 伺服器', ntp: 'NTP 伺服器' };
  // IPv4、IPv6、網域名稱。@vrf、%介面 等後綴的寫法與 :tostr 的結果無法確認，不產生指令
  const SERVER_VALUE = /^[A-Za-z0-9_.:-]+$/;
  const NTP_SUB = '/system ntp client servers';
  const SERVER_RISK = {
    dns: { level: 'medium', text: '這台設備本身與以它為 DNS 的用戶端改用新的上游伺服器；新伺服器連不到時名稱解析會失敗。先確認這台設備連得到新伺服器' },
    ntp: { level: 'low', text: '時間來源改變；新伺服器連不到時時間不再同步，依賴時間的憑證、排程與記錄會受影響。先確認這台設備連得到新伺服器' },
  };
  const devListText = (Q, devs) => devs.map((d) => Q.devName(d)).join('、');
  /** finding 的選項，依序：majority（有多數時）、每一組一個 device:<該組第一台>、accept */
  function serverOptions(Q, f) {
    const dv = f.deviation; const total = dv.groups.reduce((n, g) => n + g.devs.length, 0);
    const out = [];
    if (dv.main != null) {
      const g = dv.groups[dv.main];
      out.push({ id: 'majority', label: `改成多數設備的值：${g.value.join('、')}（推論：${total} 台中 ${g.devs.length} 台，${devListText(Q, g.devs)}）`,
        value: g.value.slice(), basis: { agree: g.devs.length, total, devs: g.devs.slice() }, inferred: true });
    }
    dv.groups.forEach((g) => out.push({ id: 'device:' + g.devs[0], label: `改成 ${devListText(Q, g.devs)} 的值：${g.value.join('、')}`, value: g.value.slice(), devs: g.devs.slice() }));
    out.push({ id: 'accept', label: '不修改，標為可接受' });
    return out;
  }
  /** 選項 id → 目標組在 deviation.groups 的索引；device:<dev> 可以是組內任一台。沒有多數時的 majority、不認得的 id 為 -1 */
  function groupOf(dv, id) {
    if (id === 'majority') return dv.main == null ? -1 : dv.main;
    if (id.startsWith('device:')) { const d = id.slice('device:'.length); return dv.groups.findIndex((g) => g.devs.includes(d)); }
    return -1;
  }
  /** 一台設備的伺服器（Q.serversOf 的一項）改成 value 的 ops；不能產生指令時回傳 { skip: reason } */
  function serverOps(s, value) {
    if (s.param === 'primary-ntp/secondary-ntp') return { skip: 'ntp-v6' };
    if (!s.values.concat(value).every((v) => SERVER_VALUE.test(v))) return { skip: 'unsafe-value' };
    if (s.menu === NTP_SUB && s.param === 'address') {
      const gone = s.values.filter((v) => !value.includes(v)); const fresh = value.filter((v) => !s.values.includes(v));
      const n = Math.min(gone.length, fresh.length); const ops = [];
      for (let i = 0; i < n; i++) ops.push({ op: 'set', path: NTP_SUB, where: { address: gone[i] }, expect: 1, props: { address: fresh[i] }, before: { address: gone[i] } });
      gone.slice(n).forEach((v) => ops.push({ op: 'remove', path: NTP_SUB, where: { address: v }, expect: 1, before: { address: v } }));
      fresh.slice(n).forEach((v) => ops.push({ op: 'add', path: NTP_SUB, where: { address: v }, expect: 0, props: { address: v } }));
      return { ops };
    }
    if ((s.menu === '/ip dns' || s.menu === '/system ntp client') && s.param === 'servers') {
      return { ops: [{ op: 'set-list', path: s.menu, param: 'servers', value: value.slice(), before: s.values.slice() }] };
    }
    return { skip: 'no-servers' };
  }
  /** finding 中這台設備的證據（區塊屬於這台的） */
  const evidenceOf = (Q, f, dev) => (f.evidence || []).filter((e) => { const b = Q.block(e.block); return !!b && b.devKey === dev; }).map((e) => Object.assign({}, e));
  /**
   * 一筆 A12 → { choice, items, skips }。choiceId 是呼叫端的選擇（null＝沒有指定：有多數用 majority，否則 needs-choice）。
   * skips 的每筆是 { dev, level, reason, options? }。
   */
  function serversChoice(Q, row, choiceId) {
    const f = row.f; const dv = f.deviation; const label = SERVER_FACET[f.facet];
    if (!label || !dv || !Array.isArray(dv.groups) || dv.groups.length < 2) return { choice: null, items: [], skips: [{ dev: row.dev, level: 'manual', reason: 'no-groups' }] };
    const options = serverOptions(Q, f);
    const chosen = choiceId != null ? choiceId : dv.main != null ? 'majority' : null;
    const choice = { findingKey: row.key, id: f.id, facet: f.facet, title: label, options, chosen, chosenBy: choiceId != null ? 'user' : chosen ? 'default' : null, value: null, items: [], reason: null };
    if (chosen === null) { choice.reason = 'needs-choice'; return { choice, items: [], skips: [{ dev: row.dev, level: 'choice', reason: 'needs-choice', options }] }; }
    if (chosen === 'accept') { choice.reason = 'accepted-choice'; return { choice, items: [], skips: [{ dev: row.dev, level: 'choice', reason: 'accepted-choice' }] }; }
    const gi = groupOf(dv, chosen);
    if (gi < 0) throw new RangeError(`S.remediate.plan：${row.key} 沒有選項 ${chosen}（可用：${options.map((o) => o.id).join('、')}）`);
    const g = dv.groups[gi];
    if (chosen !== 'majority') choice.chosen = 'device:' + g.devs[0];
    choice.value = g.value.slice();
    const opt = options.find((o) => o.id === choice.chosen);
    const items = []; const skips = [];
    dv.groups.forEach((other, i) => {
      if (i === gi) return;
      other.devs.forEach((dev) => {
        const s = Q.serversOf(dev)[f.facet];
        const r = s ? serverOps(s, g.value) : { skip: 'no-servers' };
        if (r.skip) { skips.push({ dev, level: 'manual', reason: r.skip }); return; }
        if (!r.ops.length) return;
        const warnings = [];
        if (r.ops.some((o) => o.op === 'set-list')) warnings.push('前置檢查以 :len 與 :pick／:tostr 逐項比對目前的值，手冊沒有完整範例，建議先在測試機確認');
        if (r.ops.some((o) => o.op === 'remove')) warnings.push('移除的子選單項目在 rollback 只能以 address 加回：min-poll、max-poll、iburst、auth-key 不在基準中，會回到預設值');
        if (s.src.length > 1) warnings.push(`基準中這台的${label}來自 ${s.src.length} 行設定，前置檢查以合併後的值比對；與設備不符時會中止`);
        items.push({
          key: `set-servers:${f.facet}:${dev}`, findingKey: row.key, id: f.id, dev, level: 'choice', choice: choice.chosen,
          target: { type: 'servers', key: dev, facet: f.facet, menu: s.menu, param: s.param },
          ops: r.ops, evidence: evidenceOf(Q, f, dev), risk: Object.assign({}, SERVER_RISK[f.facet]),
          note: `${Q.devName(dev)} 的 ${label}：${s.values.join('、')} → ${g.value.join('、')}（${opt.label}）`,
          warnings,
        });
      });
    });
    choice.items = items.map((it) => it.key);
    return { choice, items, skips };
  }
  /** choice 等級中已實作的規則；其他 choice 規則仍放進 skipped（reason: choice） */
  const CHOICE = { A12: serversChoice };


  // ---------------------------------------------------------------- plan
  /**
   * 回傳 { schema: 'ssot-patch/1', baseline: { inputHash, createdAt, version }, devices: [{ key, name }], items, skipped, choices }。
   * items 依設備（名稱的自然順序，再依鍵）、再依 finding 在基準中的順序；skipped 同樣排序，不屬於任何設備的最後，基準中沒有的鍵最後。
   * choices：已實作 choice 的 finding（A12）每筆一個，依 finding 在基準中的順序：
   *   { findingKey, id, facet, title, options: [{ id, label, value?, devs?, basis?, inferred? }], chosen, chosenBy: 'user'|'default'|null,
   *     value（目標值，needs-choice／accept 時為 null）, items: [item key], reason: null|'needs-choice'|'accepted-choice' }
   *   選項 id：majority（有多數時，inferred: true，basis: { agree, total, devs }）、device:<組內第一台>（組內任一台也可）、accept。
   *   沒有指定時：有多數用 majority，否則 needs-choice（不產生指令，skipped 附 options）；accept 不產生指令，skipped 的 reason 是 accepted-choice。
   * opts：{ choices: { findingKey: 選項 id } }；不認得的選項 id 丟錯，選取範圍外的 findingKey 不使用。新增欄位 choices 與第三個參數都是相容修改。
   */
  /** opts：省略或 null；{ choices?: { findingKey: 選項 id } }。格式不對就丟錯。 */
  function choicesOf(opts) {
    if (opts == null) return {};
    if (typeof opts !== 'object' || Array.isArray(opts)) throw new TypeError('S.remediate.plan：第三個參數必須是 { choices }');
    const extra = Object.keys(opts).filter((k) => k !== 'choices');
    if (extra.length) throw new TypeError(`S.remediate.plan：opts 不認得的欄位 ${extra.join('、')}`);
    const c = opts.choices == null ? {} : opts.choices;
    if (typeof c !== 'object' || Array.isArray(c) || Object.values(c).some((v) => typeof v !== 'string')) throw new TypeError('S.remediate.plan：choices 必須是 { findingKey: 選項 id（字串） }');
    return c;
  }
  function plan(Q, selection, opts) {
    const choices = choicesOf(opts);
    const { rows, missing } = select(Q, selection);
    const byDev = (a, b) => {
      if (a === b) return 0;
      if (a === null || b === null) return a === null ? 1 : -1;
      return U.natural(Q.devName(a), Q.devName(b)) || U.cmp(a, b);
    };
    const devOrder = (a, b) => byDev(a.dev, b.dev) || a.idx - b.idx;
    const items = []; const skipped = []; const byTarget = new Map(); const choiceList = [];
    const skip = (row, s) => skipped.push(Object.assign({ findingKey: row.key, id: row.f.id, dev: s.dev !== undefined ? s.dev : row.dev, level: s.level, reason: s.reason, detail: s.detail || SKIP_TEXT[s.reason] },
      s.rule ? { rule: s.rule } : {}, s.item ? { item: s.item } : {}, s.options ? { options: s.options } : {}));
    rows.slice().sort(devOrder).forEach((row) => {
      const level = levelOf(row.f.id);
      if (level === 'choice' && CHOICE[row.f.id]) {
        const r = CHOICE[row.f.id](Q, row, Object.prototype.hasOwnProperty.call(choices, row.key) ? choices[row.key] : null);
        if (r.choice) choiceList.push({ c: r.choice, idx: row.idx });
        r.skips.forEach((s) => skip(row, s));
        items.push(...r.items);
        return;
      }
      if (level !== 'auto') { skip(row, { level, reason: level }); return; }
      const r = disableItem(Q, row);
      if (r.skip) { skip(row, r.skip); return; }
      const prev = byTarget.get(r.item.target.key);
      if (prev) { skip(row, { level: 'auto', reason: 'same-target', item: prev.key, rule: r.item.target.key }); return; }
      byTarget.set(r.item.target.key, r.item); items.push(r.item);
    });
    // 跨設備的 finding（A12）產生的是各台設備的 item 與 skipped：依設備重新排列，同一台設備內維持原本的順序
    const stableByDev = (list) => list.map((x, i) => ({ x, i })).sort((a, b) => byDev(a.x.dev, b.x.dev) || a.i - b.i).map((o) => o.x);
    const sortedItems = stableByDev(items); const sortedSkipped = stableByDev(skipped);
    missing.forEach((k) => sortedSkipped.push({ findingKey: k, id: null, dev: null, level: null, reason: 'not-found', detail: SKIP_TEXT['not-found'] }));
    const m = Q.meta();
    const devices = U.uniq(sortedItems.map((i) => i.dev)).map((key) => ({ key, name: Q.devName(key) }));
    return { schema: SCHEMA, baseline: { inputHash: m.inputHash, createdAt: m.createdAt, version: m.version }, devices, items: sortedItems, skipped: sortedSkipped, choices: choiceList.sort((a, b) => a.idx - b.idx).map((x) => x.c) };
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
  /** item 的對象：防火牆規則為 ip filter input rule 6；伺服器為 dns servers /ip dns */
  const targetText = (t) => (t.type === 'servers' ? `${t.facet} servers ${t.menu}` : `${t.family} ${t.table} ${t.chain} rule ${t.position}`);
  /** 數量的單位：防火牆規則為 rule，其他（子選單的項目）為 entry */
  const unit = (it) => (it.target.type === 'servers' ? 'entry' : 'rule');
  /** item 的一行標題：[n] F01 ip filter input rule 6 (檔案 line 行號) */
  function itemTitle(it, n) {
    const ev = it.evidence[0];
    return asciiText(`[${n}] ${it.id} ${targetText(it.target)}${ev && ev.file ? ` (${ev.file} line ${ev.line})` : ''}`);
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
  /*
   * op 的種類：
   *   set     ：path set [find where where] props；前置檢查 find 的數量＝expect；before 是修改前的 props
   *   remove  ：path remove [find where where]；前置檢查 find 的數量＝expect（1）；before 是被移除項目的屬性
   *   add     ：path add props；前置檢查 find where where 的數量＝expect（0，避免重複）
   *   set-list：path set param=value（multi 的整份清單）；前置檢查以 :len 與 :pick／:tostr 逐項比對 before
   */
  const listExpr = (values) => values.join(',');
  const getExpr = (op) => `[${op.path} get ${op.param}]`;
  function precheck(op, label, it) {
    if (op.op === 'set-list') {
      const msg = rosStr(`topo-mikrotik pre-check failed: ${label} ${op.param} differ from the baseline`);
      return [
        asciiText(`# ${label}: compare ${op.param} item by item with :len, :pick and :tostr (confirm on a test router first)`),
        `:if ([:len ${getExpr(op)}] != ${op.before.length}) do={ :error ${msg} }`,
        ...op.before.map((v, i) => `:if ([:tostr [:pick ${getExpr(op)} ${i}]] != ${rosStr(v)}) do={ :error ${msg} }`),
      ];
    }
    const msg = rosStr(`topo-mikrotik pre-check failed: ${label} must match exactly ${op.expect} ${unit(it)}(s)`);
    return [`:if ([:len [${op.path} find where ${whereExpr(op.where)}]] != ${op.expect}) do={ :error ${msg} }`];
  }
  /** 這個 op 的修改指令 */
  function changeLine(op) {
    if (op.op === 'set-list') return `${op.path} set ${op.param}=${listExpr(op.value)}`;
    if (op.op === 'remove') return `${op.path} remove ${findExpr(op)}`;
    if (op.op === 'add') return `${op.path} add ${propsExpr(op.props)}`;
    return `${op.path} set ${findExpr(op)} ${propsExpr(op.props)}`;
  }
  /** 修改前的值（註解用） */
  function beforeText(op) {
    if (op.op === 'set-list') return `${op.param}=${listExpr(op.before)}`;
    if (op.op === 'add') return `no entry where ${whereExpr(op.where)}`;
    return propsExpr(op.before);
  }
  /** where 中被 props 改到的鍵換成修改後的值（套用後要用新值才 find 得到）；props 不在 where 的鍵不加入 */
  const whereAfter = (op) => { const w = {}; Object.keys(op.where).forEach((k) => { w[k] = op.props && k in op.props ? op.props[k] : op.where[k]; }); return w; };
  /** 反向的 op（rollback 用）：set 互換 props 與 before（where 改用套用後的值）、remove 與 add 互換、set-list 互換 value 與 before */
  function inverse(op) {
    if (op.op === 'set-list') return Object.assign({}, op, { value: op.before.slice(), before: op.value.slice() });
    if (op.op === 'remove') return { op: 'add', path: op.path, where: Object.assign({}, op.where), expect: 0, props: Object.assign({}, op.before) };
    if (op.op === 'add') return { op: 'remove', path: op.path, where: Object.assign({}, op.where), expect: 1, before: Object.assign({}, op.props) };
    return Object.assign({}, op, { where: whereAfter(op), props: Object.assign({}, op.before), before: Object.assign({}, op.props) });
  }
  const label = (it, n) => asciiText(`[${n}] ${it.id} ${targetText(it.target)}`);
  const prechecks = (items) => items.flatMap((it, k) => it.ops.flatMap((op) => precheck(op, label(it, k + 1), it)));
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
      out.push(`# ${itemTitle(it, k + 1)}: before ${beforeText(op)}`, changeLine(op));
    }));
    return finish(out);
  }
  /** 還原的 op：套用的反向（item 與 op 都倒序，各 op 見 inverse）；回傳 [{ item, n, op }]，n 是 item 在這台設備的序號。 */
  function rollbackOps(plan, dev) {
    const { items } = itemsOf(plan, dev);
    const out = [];
    items.forEach((it, k) => it.ops.forEach((op) => out.push({ item: it, n: k + 1, op: inverse(op) })));
    return out.reverse();
  }
  /** 還原的值（註解用） */
  function restoreText(op) {
    if (op.op === 'set-list') return `${op.param}=${listExpr(op.value)}`;
    if (op.op === 'remove') return `remove the entry where ${whereExpr(op.where)}`;
    return propsExpr(op.props);
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
      ...ops.flatMap(({ item, n, op }) => precheck(op, label(item, n), item)),
      '',
      '# ---- rollback',
    ]);
    ops.forEach(({ item, n, op }) => out.push(`# ${itemTitle(item, n)}: restore ${restoreText(op)}`, changeLine(op)));
    return finish(out);
  }
  /** 驗證用的 .rsc：每個 op 一條 print where（set-list 為 :put get），註解寫出預期結果。 */
  function renderVerify(plan, dev) {
    const { d, items } = itemsOf(plan, dev);
    const out = header(plan, d, 'verify', [`# items: ${items.length}`, '# Run after the apply file. Each print must list exactly the number of rules stated.', '']);
    items.forEach((it, k) => it.ops.forEach((op) => {
      const title = itemTitle(it, k + 1);
      if (op.op === 'set-list') { out.push(`# ${title}: expect ${op.param} ${listExpr(op.value)} (in this order)`, `:put ${getExpr(op)}`); return; }
      if (op.op === 'remove') { out.push(`# ${title}: expect no ${unit(it)}`, `${op.path} print where ${whereExpr(op.where)}`); return; }
      const flag = op.props.disabled === 'yes' ? ', flagged X (disabled)' : op.props.disabled === 'no' ? ', not flagged X' : '';
      const where = op.op === 'add' ? op.where : whereAfter(op);
      out.push(`# ${title}: expect ${op.op === 'add' ? 1 : op.expect} ${unit(it)}${flag}`, `${op.path} print where ${whereExpr(where)}`);
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
