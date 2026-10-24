/*
 * 修正計畫（對話框 #dlg-patch）：選取檢查結果 → S.remediate.plan → 依設備列出修改前（證據原文）與修改後（套用指令），
 * 每台設備的套用、回復、驗證三份 .rsc 可以檢視、複製與下載；沒有產生指令的項目依原因分組，列出檢查結果的訊息（點了開啟該筆）。
 * 計畫與指令文字全部由核心 S.remediate 產生，這裡只負責選取、預覽與下載。本工具只產生文字，不會連線設備（ADR-001）。
 * 選取是檢視狀態（findingKey 的集合），只在記憶體，不存進 store；換基準時清空。
 * choice 等級的修正（目前是 A12）：plan.choices 每筆以 radio 列出選項，選擇（findingKey → 選項 id）同樣是記憶體中的檢視狀態，
 * 以 S.remediate.plan(Q, selection, { choices }) 重新產生計畫，預覽與下載都跟著更新；換基準時清空。
 * 選「不修改」時 remediate 不碰處理紀錄，由這裡以 App.setLedger（S.ledger.set）標為可接受（原因與到期日）。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const R = () => V.remediation;
  const RM = () => S.remediate;
  const GROUP_MAX = 200; // 逐筆勾選時每條規則最多列出的筆數
  const KIND = { apply: ['套用', ''], rollback: ['回復', '-rollback'], verify: ['驗證', '-verify'] };
  const DAY_MS = 86400000;
  const state = { keys: new Set(), view: new Map(), choices: new Map(), inputHash: null, plan: null, files: null };
  /** 換基準時清空所有檢視狀態（選取、每台設備檢視的檔案、選擇） */
  function resetFor(App) {
    if (state.inputHash === App.Q.meta().inputHash) return;
    state.keys.clear(); state.view.clear(); state.choices.clear(); state.inputHash = App.Q.meta().inputHash;
  }

  /** 檔名：files() 的 base 加上種類的後綴（base.rsc、base-rollback.rsc、base-verify.rsc） */
  const fileName = (f, kind) => `${f.base}${KIND[kind][1]}.rsc`;
  /** 總表的檔名：patch-summary-<建立時間>-<N>dev.md（對話框的下載與工作包共用） */
  const summaryName = (App) => `patch-summary-${V.exporter.baseName(App.Q)}.md`;
  const download = (name, text) => V.exporter.download(name, text, 'text/plain;charset=utf-8');
  function copyText(text, what) {
    const c = globalThis.navigator && globalThis.navigator.clipboard;
    if (!c || !c.writeText) { V.app.banner('這個瀏覽器無法自動複製，請選取文字後手動複製。', 6000); return; }
    c.writeText(text).then(() => V.app.banner(`已複製${what}；執行前請逐行核對。`, 3000),
      (e) => V.app.banner('無法複製：' + e.message + '；請選取文字後手動複製。', 6000));
  }

  /**
   * 目前基準的檢查結果，依 findingKey 去重複：[{ key, f, idx, dev }]（同一個鍵只取第一筆，計畫也以鍵為單位）。
   * 檢查項目不同的（finding.facet，例如 A12 的 DNS 與 NTP）是不同的鍵，各自一列；仍共用鍵的只有依輸入區塊的 I01、I03。
   */
  function rows(App) {
    const seen = new Set(); const out = [];
    App.Q.findings().forEach((f, idx) => {
      const key = App.Q.findingKey(f); if (seen.has(key)) return; seen.add(key);
      out.push({ key, f, idx, dev: App.Q.findingDevice(f) });
    });
    return out;
  }
  /** 依目前的選取與選擇產生計畫（選取為空時為 null）；只傳選取範圍內的選擇 */
  function compute(App) {
    if (!state.keys.size) { state.plan = null; state.files = []; return; }
    const sel = Array.from(state.keys).sort(S.util.cmp);
    const choices = {}; state.choices.forEach((id, k) => { if (state.keys.has(k)) choices[k] = id; });
    try { state.plan = RM().plan(App.Q, sel, { choices }); } catch (e) {
      if (!(e instanceof RangeError) || !Object.keys(choices).length) throw e;
      // 選項已不存在（例如核心的選項改變）：清掉選擇改回預設，並說明原因
      state.choices.clear(); V.app.banner('先前的選擇已不適用，改回預設：' + e.message, 8000);
      state.plan = RM().plan(App.Q, sel);
    }
    state.files = RM().files(state.plan);
  }

  // ---------------------------------------------------------------- 選取
  function selection(App) {
    const all = rows(App); const Q = App.Q;
    const byId = new Map(); all.forEach((r) => S.util.getOr(byId, r.f.id, () => []).push(r));
    const ids = Array.from(byId.keys()).sort(S.util.natural);
    const toggleKeys = (keys, on) => { keys.forEach((k) => (on ? state.keys.add(k) : state.keys.delete(k))); refreshOpen(App); };
    const allIn = (list) => list.length && list.every((r) => state.keys.has(r.key));
    // 依規則：可產生指令的排前面
    const order = { auto: 0, choice: 1, manual: 2 };
    const ruleChips = ids.slice().sort((a, b) => order[RM().levelOf(a)] - order[RM().levelOf(b)] || S.util.natural(a, b)).map((id) => {
      const list = byId.get(id); const lv = RM().levelOf(id); const on = allIn(list);
      return V.chipButton([id + ' ', h('span', { class: 'n' }, String(list.length))], `btn patch-rule ${lv === 'auto' ? 'ok' : ''} ${on ? 'on' : ''}`, {
        'data-rule-id': id, 'data-level': lv, 'aria-pressed': String(!!on),
        title: `${(S.query.rule(id) || {}).title || id}：${R().LEVEL_TEXT[lv] || lv}。點一下選取或取消這條規則的全部`,
        onclick: () => toggleKeys(list.map((r) => r.key), !on),
      });
    });
    // 依設備
    const devs = S.util.uniq(all.map((r) => r.dev).filter(Boolean)).sort((a, b) => S.util.natural(Q.devName(a), Q.devName(b)));
    const devSel = h('select', { class: 'patch-device', 'aria-label': '依設備選取' }, devs.map((d) => h('option', { value: d }, `${Q.devName(d)}（${all.filter((r) => r.dev === d).length}）`)));
    const groups = ids.map((id) => {
      const list = byId.get(id);
      const box = h('details', { class: 'patch-group', 'data-rule-id': id }, [h('summary', null, [
        h('span', { class: 'mono' }, id), ' ', (S.query.rule(id) || {}).title || '', ' ', V.chip(`${list.filter((r) => state.keys.has(r.key)).length}/${list.length}`)])]);
      // 展開時才產生清單（大型網路的檢查結果很多）
      box.addEventListener('toggle', () => {
        if (!box.open || box.querySelector('.patch-pick')) return;
        box.appendChild(h('div', { class: 'patch-picks' }, list.slice(0, GROUP_MAX).map((r) => {
          const cb = h('input', { type: 'checkbox', class: 'patch-pick', 'data-key': r.key, checked: state.keys.has(r.key) || null });
          cb.checked = state.keys.has(r.key);
          cb.addEventListener('change', () => toggleKeys([r.key], cb.checked));
          const facet = R().facetText(r.f);
          return h('label', { class: 'patch-pick-row' }, [cb, ' ', r.dev ? h('span', { class: 'muted' }, Q.devName(r.dev) + '：') : null,
            facet ? V.chip(facet, 'facet', { title: 'facet：' + r.f.facet }) : null, facet ? ' ' : null, r.f.message]);
        })));
        if (list.length > GROUP_MAX) box.appendChild(h('div', { class: 'muted' }, `只列出前 ${GROUP_MAX} 筆（共 ${list.length} 筆）；其餘請用「依規則」或「依設備」選取`));
      });
      return box;
    });
    return h('div', { class: 'patch-select' }, [
      h('h4', { class: 'pane-title' }, `選取檢查結果（已選 ${V.num(state.keys.size)} 項）`),
      h('div', { class: 'row' }, [h('span', { class: 'muted' }, '依規則：'), ...ruleChips]),
      h('div', { class: 'row' }, [h('span', { class: 'muted' }, '依設備：'), devSel,
        h('button', { class: 'patch-add-device', disabled: !devs.length || null, onclick: () => toggleKeys(all.filter((r) => r.dev === devSel.value).map((r) => r.key), true) }, '加入這台的全部'),
        h('button', { class: 'ghost patch-clear', disabled: !state.keys.size || null, onclick: () => { state.keys.clear(); refreshOpen(App); } }, '全部清除')]),
      h('div', { class: 'patch-groups' }, groups),
    ]);
  }

  // ---------------------------------------------------------------- 計畫
  function itemBlock(App, plan, it) {
    const t = it.target;
    return h('div', { class: 'patch-item', 'data-key': it.key, 'data-finding': it.findingKey }, [
      h('div', { class: 'row' }, [V.chip(it.id), ' ', h('span', { class: 'mono patch-target' }, R().targetText(t)), ' ',
        it.level === 'choice' ? V.chip('依選擇', 'info', { title: '這項指令依「需要選擇的項目」中的選擇產生' }) : null, it.level === 'choice' ? ' ' : null,
        V.chip('風險 ' + (R().RISK_TEXT[it.risk.level] || it.risk.level), R().RISK_CHIP[it.risk.level] || '', { class: 'chip patch-risk ' + (R().RISK_CHIP[it.risk.level] || '') })]),
      h('p', null, it.note),
      h('p', { class: 'muted' }, '風險：' + it.risk.text),
      ...it.warnings.map((w) => h('p', { class: 'warn-line' }, '警告：' + w)),
      h('div', { class: 'patch-before' }, [h('div', { class: 'patch-label' }, '修改前（基準的原文）'),
        ...it.evidence.map((e) => h('div', { class: 'patch-ev' }, [
          h('a', { class: 'link mono', onclick: () => App.openRaw(e.file, e.line) }, `${e.file} 第 ${e.line} 行`), ' ',
          h('code', { class: 'mono' }, e.text)]))]),
      h('div', { class: 'patch-after' }, [h('div', { class: 'patch-label' }, '修改後（套用指令）'), h('pre', { class: 'note-box patch-cmd' }, R().itemApplyLines(plan, it))]),
    ]);
  }
  function deviceBlock(App, plan, f) {
    const items = plan.items.filter((i) => i.dev === f.dev);
    const kind = state.view.get(f.dev) || 'apply';
    const risk = R().maxRisk(items);
    return h('div', { class: 'patch-dev', 'data-dev': f.dev }, [
      h('h4', null, [f.name, ' ', V.chip(`${items.length} 項`), ' ', V.chip('最高風險 ' + (R().RISK_TEXT[risk] || risk), R().RISK_CHIP[risk] || '')]),
      ...items.map((it) => itemBlock(App, plan, it)),
      h('div', { class: 'patch-files' }, [
        h('div', { class: 'row' }, [
          h('div', { class: 'seg', role: 'group', 'aria-label': '檢視的檔案' }, Object.entries(KIND).map(([k, [label]]) => h('button', {
            class: `btn ${kind === k ? 'on' : ''}`, 'aria-pressed': String(kind === k), 'data-kind': k,
            onclick: () => { state.view.set(f.dev, k); render(App); } }, label))),
          h('button', { class: 'ghost patch-copy', onclick: () => copyText(f[kind], fileName(f, kind)) }, '複製'),
          ...Object.keys(KIND).map((k) => h('button', { class: 'patch-download', 'data-file': fileName(f, k), onclick: () => download(fileName(f, k), f[k]) }, '下載 ' + fileName(f, k))),
        ]),
        h('pre', { class: 'note-box patch-file', 'data-kind': kind }, f[kind]),
      ]),
    ]);
  }
  // ---------------------------------------------------------------- 選擇（choice）
  /** 選擇一個選項：存進檢視狀態後重新產生計畫，焦點留在剛選的 radio（鍵盤以方向鍵切換時不會跳走） */
  function choose(App, key, id) {
    state.choices.set(key, id); refreshOpen(App);
    const r = Array.from($('#patch-body').querySelectorAll('.patch-choice-opt')).find((x) => x.getAttribute('data-finding') === key && x.value === id);
    if (r) r.focus();
  }
  /** 選「不修改」時：處理紀錄已是可接受就顯示豁免內容，否則填原因與到期日後標為可接受（App.setLedger → S.ledger.set） */
  function acceptBox(App, c, hit) {
    const A = V.app; const LG = S.ledger;
    const blocked = A.ledgerState().blocked;
    if (blocked) return h('p', { class: 'warn-line patch-accept-blocked' }, '處理紀錄目前無法使用，不能標為可接受：' + blocked.reason);
    if (!hit) return h('p', { class: 'warn-line' }, R().MISSING_FINDING_TEXT + '，無法寫入處理紀錄');
    const it = A.ledgerItem(hit.f);
    if (it && it.status === 'accepted') {
      return h('p', { class: 'patch-accept-done' }, [V.chip(R().statusText('accepted'), R().STATUS_CHIP.accepted), ' ',
        `處理紀錄已標為可接受，到期日 ${String(it.waiver.until).slice(0, 10)}：${it.waiver.reason}`]);
    }
    // 轉換規則在核心（S.ledger.USER_TO）：不允許時先說明，不顯示會失敗的表單
    if (it && !(LG.USER_TO[it.status] || []).includes('accepted')) {
      return h('p', { class: 'warn-line patch-accept-blocked' }, `處理紀錄中這筆目前是「${R().statusText(it.status)}」，不能手動改為可接受。`);
    }
    const reason = h('input', { type: 'text', class: 'patch-accept-reason', maxlength: '500', 'aria-label': '可接受的原因', placeholder: '可接受的原因（必填），例如：兩台各自使用 ISP 的 DNS' });
    const until = h('input', { type: 'date', class: 'patch-accept-until', 'aria-label': '豁免到期日',
      value: new Date(Date.now() + LG.WAIVER_DAYS * DAY_MS).toISOString().slice(0, 10) });
    const err = h('div', { class: 'ledger-error hidden', role: 'alert' });
    const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
    const save = async () => {
      if (!reason.value.trim()) { fail('可接受需要填寫原因'); return; }
      const r = await App.setLedger(hit.f, { status: 'accepted', waiver: { reason: reason.value, until: until.value ? until.value + 'T00:00:00Z' : undefined } });
      if (!r.ok) { fail('無法變更：' + r.error); return; }
      V.app.banner(`已把這筆${c.title}的檢查結果標為可接受（處理紀錄）`, 4000);
    };
    reason.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    return h('div', { class: 'patch-accept' }, [
      h('p', { class: 'muted' }, `不產生指令；在處理紀錄把這筆標為可接受（目前：${R().statusText(it ? it.status : null)}）。`),
      h('div', { class: 'row' }, [reason, h('label', null, ['到期日 ', until]),
        h('button', { class: 'primary patch-accept-save', onclick: save }, '標為可接受')]),
      err]);
  }
  /** plan.choices 的一筆：標題（規則、項目、檢查結果的訊息）、狀態說明、選項的 radio 群組；選不修改時加上處理紀錄的欄位 */
  function choiceBlock(App, c, hit, n, closeDlg) {
    const status = c.reason === 'needs-choice'
      ? h('p', { class: 'warn-line patch-choice-need', role: 'status' }, '沒有多數，請選擇要採用的值，或選「不修改」標為可接受；選擇前不會產生指令。')
      : c.chosenBy === 'default' ? h('p', { class: 'muted patch-choice-default' }, '預設採用多數設備的值（推論）；可以改選其他組，或選「不修改」。') : null;
    const rows = c.options.map((o) => {
      const on = c.chosen === o.id;
      const input = h('input', { type: 'radio', name: `patch-choice-${n}`, value: o.id, class: 'patch-choice-opt', 'data-finding': c.findingKey, checked: on || null });
      input.checked = on;
      input.addEventListener('change', () => { if (input.checked) choose(App, c.findingKey, o.id); });
      const basis = o.inferred && o.basis ? `依多數決推定：${o.basis.total} 台中 ${o.basis.agree} 台的值相同` : null;
      return h('label', { class: 'patch-choice-row' + (on ? ' on' : ''), 'data-option': o.id }, [input, ' ',
        o.inferred ? V.chip('推論', 'info', { class: 'chip info patch-inferred', title: basis }) : null, o.inferred ? ' ' : null, o.label]);
    });
    const items = c.items.length ? h('p', { class: 'muted patch-choice-items' }, `產生 ${c.items.length} 台設備的指令（見下方各設備）`)
      : c.reason === null ? h('p', { class: 'muted patch-choice-items' }, '沒有需要修改的設備，不產生指令') : null;
    return h('div', { class: 'patch-choice', 'data-finding': c.findingKey, 'data-reason': c.reason || '' }, [
      h('div', { class: 'row' }, [V.chip(c.id), ' ', h('b', null, c.title), ' ', R().findingRef(App, hit, c.findingKey, closeDlg)]),
      status,
      h('fieldset', { class: 'patch-choice-set' }, [h('legend', null, `${c.title}：要採用的值`), ...rows]),
      c.chosen === 'accept' ? acceptBox(App, c, hit) : items,
    ]);
  }
  /** 需要選擇的項目（plan.choices）；沒有時為 null */
  function choicesView(App, plan, closeDlg) {
    const list = plan.choices || [];
    if (!list.length) return null;
    const hits = R().matchFindings(App.Q, list);
    const need = list.filter((c) => c.reason === 'needs-choice').length;
    return h('div', { class: 'patch-choices' }, [
      h('h4', null, ['需要選擇的項目 ', V.chip(String(list.length)), need ? ' ' : null, need ? V.chip(`尚未選擇 ${need} 項`, 'warn') : null]),
      ...list.map((c, n) => choiceBlock(App, c, hits[n], n, closeDlg)),
    ]);
  }

  function planView(App) {
    const plan = state.plan;
    if (!plan) return h('p', { class: 'muted patch-empty' }, '先在上方選取檢查結果；可以依規則、依設備一次選取，或展開規則逐筆勾選。');
    const files = state.files;
    const all = () => {
      files.forEach((f) => Object.keys(KIND).forEach((k) => download(fileName(f, k), f[k])));
      download(summaryName(App), V.exporter.patchSummaryMarkdown(plan, files, App.Q));
    };
    const hits = R().matchFindings(App.Q, plan.skipped);
    const closeDlg = () => { const d = $('#dlg-patch'); if (d && d.open) d.close(); };
    const skippedByReason = new Map(); plan.skipped.forEach((x, n) => S.util.getOr(skippedByReason, x.reason, () => []).push({ x, hit: hits[n] }));
    return h('div', { class: 'patch-plan' }, [
      h('div', { class: 'summary sub patch-summary' }, [
        V.chip(`可產生指令 ${V.num(plan.items.length)} 項（${V.num(plan.devices.length)} 台設備）`, plan.items.length ? 'ok' : ''),
        V.chip(`未產生指令 ${V.num(plan.skipped.length)} 項`, plan.skipped.length ? 'warn' : ''),
      ]),
      choicesView(App, plan, closeDlg),
      files.length ? h('div', { class: 'row patch-download-all' }, files.length === 1
        ? [h('span', { class: 'muted' }, '單台設備：下載三個 .rsc')].concat(Object.keys(KIND).map((k) => h('button', { class: 'patch-download', 'data-file': fileName(files[0], k),
          onclick: () => download(fileName(files[0], k), files[0][k]) }, '下載 ' + fileName(files[0], k))))
        : [h('button', { class: 'primary patch-download-every', onclick: all }, `逐檔下載全部（${files.length * 3 + 1} 個檔案）`),
          h('button', { class: 'patch-download-summary', onclick: () => download(summaryName(App), V.exporter.patchSummaryMarkdown(plan, files, App.Q)) }, '只下載總表（Markdown）'),
          h('span', { class: 'muted' }, '瀏覽器可能會詢問是否允許下載多個檔案；要一個檔案帶走，可以在資料中心匯出工作包（ZIP，含這裡選取的 patch 與總表）。總表列出每台設備的檔名、項目與風險。')]) : null,
      ...files.map((f) => deviceBlock(App, plan, f)),
      plan.skipped.length ? h('div', { class: 'patch-skipped' }, [
        h('h4', null, ['沒有產生指令的項目 ', V.chip(String(plan.skipped.length), 'warn')]),
        ...Array.from(skippedByReason.entries()).map(([reason, list]) => h('div', { class: 'patch-skip-group', 'data-reason': reason }, [
          h('div', { class: 'patch-label' }, RM().SKIP_TEXT[reason] || reason),
          // 每一筆列出檢查結果的訊息（同一台設備可能有多筆相同規則），點了開啟該筆；原因已在分組標題，detail 不同時才另外列出
          ...list.map(({ x, hit }) => h('div', { class: 'patch-skip', 'data-finding': x.findingKey }, [
            V.chip(x.id || '—'), ' ', x.dev ? h('span', { class: 'muted' }, App.Q.devName(x.dev) + '：') : null,
            R().findingRef(App, hit, x.findingKey, closeDlg),
            x.detail && x.detail !== (RM().SKIP_TEXT[reason] || reason) ? h('div', { class: 'muted patch-skip-detail' }, x.detail) : null])),
        ])),
      ]) : null,
    ]);
  }

  function render(App) {
    const body = V.clear($('#patch-body'));
    if (!App.snap) { body.appendChild(h('p', { class: 'muted' }, '建立基準後才能產生修正計畫。')); return; }
    body.appendChild(h('p', { class: 'patch-readonly' }, [h('b', null, '本工具只產生文字，不會連線或改動任何設備。'),
      ' 指令依基準的事實產生；套用前請逐行審查，自行以 /import 執行（前置檢查不通過時不會改到任何設定），之後重新收集、建立基準確認結果。']));
    body.appendChild(selection(App));
    body.appendChild(h('h4', { class: 'pane-title' }, '修正計畫'));
    body.appendChild(planView(App));
  }
  function refreshOpen(App) { compute(App); render(App); }

  /** 開啟修正計畫；keys 給定時以它取代目前的選取（例如防火牆畫面的「在修正計畫中開啟」） */
  function open(App, keys) {
    if (!App.snap) return;
    resetFor(App);
    if (keys) { state.keys = new Set(keys); }
    compute(App); render(App);
    const dlg = $('#dlg-patch'); if (!dlg.open) dlg.showModal();
  }
  /** 重繪時（換基準）：對話框開著才更新；基準不同時清空選取 */
  function refresh(App) {
    const dlg = $('#dlg-patch'); if (!dlg || !dlg.open) return;
    if (!App.snap) { dlg.close(); return; }
    resetFor(App);
    compute(App); render(App);
  }

  /**
   * 工作包用：目前修正計畫的選取所產生的檔案 { plan, files, list: [{ name, text }] }（每台設備的套用、回復、驗證 .rsc，加上總表）。
   * 沒有選取（或換了基準、選取已清空）時為 null。內容和對話框的下載相同，都由 S.remediate 產生。
   */
  function current(App) {
    if (!App.snap) return null;
    resetFor(App);
    if (!state.keys.size) return null;
    compute(App);
    const plan = state.plan; const files = state.files;
    const list = [];
    files.forEach((f) => Object.keys(KIND).forEach((k) => list.push({ name: fileName(f, k), text: f[k] })));
    list.push({ name: summaryName(App), text: V.exporter.patchSummaryMarkdown(plan, files, App.Q) });
    return { plan, files, list };
  }

  /** 目前修正計畫選取的項目數（換了基準時先清空）；沒有基準時 0 */
  function selectedCount(App) { if (!App.snap) return 0; resetFor(App); return state.keys.size; }

  V.patchView = { open, refresh, render, state, fileName, current, selectedCount };
  window.App.openPatch = (keys) => open(window.App, keys);
})(globalThis.SSOT = globalThis.SSOT || {});
