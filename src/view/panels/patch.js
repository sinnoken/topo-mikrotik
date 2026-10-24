/*
 * 修正計畫（對話框 #dlg-patch）：選取檢查結果 → S.remediate.plan → 依設備列出修改前（證據原文）與修改後（套用指令），
 * 每台設備的套用、回復、驗證三份 .rsc 可以檢視、複製與下載；沒有產生指令的項目列出核心給的原因。
 * 計畫與指令文字全部由核心 S.remediate 產生，這裡只負責選取、預覽與下載。本工具只產生文字，不會連線設備（ADR-001）。
 * 選取是檢視狀態（findingKey 的集合），只在記憶體，不存進 store；換基準時清空。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const R = () => V.remediation;
  const RM = () => S.remediate;
  const GROUP_MAX = 200; // 逐筆勾選時每條規則最多列出的筆數
  const KIND = { apply: ['套用', ''], rollback: ['回復', '-rollback'], verify: ['驗證', '-verify'] };
  const state = { keys: new Set(), view: new Map(), inputHash: null, plan: null, files: null };

  /** 檔名：files() 的 base 加上種類的後綴（base.rsc、base-rollback.rsc、base-verify.rsc） */
  const fileName = (f, kind) => `${f.base}${KIND[kind][1]}.rsc`;
  const download = (name, text) => V.exporter.download(name, text, 'text/plain;charset=utf-8');
  function copyText(text, what) {
    const c = globalThis.navigator && globalThis.navigator.clipboard;
    if (!c || !c.writeText) { V.app.banner('這個瀏覽器無法自動複製，請選取文字後手動複製。', 6000); return; }
    c.writeText(text).then(() => V.app.banner(`已複製${what}；執行前請逐行核對。`, 3000),
      (e) => V.app.banner('無法複製：' + e.message + '；請選取文字後手動複製。', 6000));
  }

  /** 目前基準的檢查結果，依 findingKey 去重複：[{ key, f, idx, dev }]（同一個鍵只取第一筆，計畫也以鍵為單位） */
  function rows(App) {
    const seen = new Set(); const out = [];
    App.snap.findings.forEach((f, idx) => {
      const key = App.Q.findingKey(f); if (seen.has(key)) return; seen.add(key);
      out.push({ key, f, idx, dev: App.Q.findingDevice(f) });
    });
    return out;
  }
  /** 依目前的選取產生計畫（選取為空時為 null） */
  function compute(App) {
    state.plan = state.keys.size ? RM().plan(App.Q, Array.from(state.keys).sort(S.util.cmp)) : null;
    state.files = state.plan ? RM().files(state.plan) : [];
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
        title: `${(S.check.CATALOG[id] || {}).title || id}：${R().LEVEL_TEXT[lv] || lv}。點一下選取或取消這條規則的全部`,
        onclick: () => toggleKeys(list.map((r) => r.key), !on),
      });
    });
    // 依設備
    const devs = S.util.uniq(all.map((r) => r.dev).filter(Boolean)).sort((a, b) => S.util.natural(Q.devName(a), Q.devName(b)));
    const devSel = h('select', { class: 'patch-device', 'aria-label': '依設備選取' }, devs.map((d) => h('option', { value: d }, `${Q.devName(d)}（${all.filter((r) => r.dev === d).length}）`)));
    const groups = ids.map((id) => {
      const list = byId.get(id);
      const box = h('details', { class: 'patch-group', 'data-rule-id': id }, [h('summary', null, [
        h('span', { class: 'mono' }, id), ' ', (S.check.CATALOG[id] || {}).title || '', ' ', V.chip(`${list.filter((r) => state.keys.has(r.key)).length}/${list.length}`)])]);
      // 展開時才產生清單（大型網路的檢查結果很多）
      box.addEventListener('toggle', () => {
        if (!box.open || box.querySelector('.patch-pick')) return;
        box.appendChild(h('div', { class: 'patch-picks' }, list.slice(0, GROUP_MAX).map((r) => {
          const cb = h('input', { type: 'checkbox', class: 'patch-pick', 'data-key': r.key, checked: state.keys.has(r.key) || null });
          cb.checked = state.keys.has(r.key);
          cb.addEventListener('change', () => toggleKeys([r.key], cb.checked));
          return h('label', { class: 'patch-pick-row' }, [cb, ' ', r.dev ? h('span', { class: 'muted' }, Q.devName(r.dev) + '：') : null, r.f.message]);
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
      h('div', { class: 'row' }, [V.chip(it.id), ' ', h('span', { class: 'mono' }, `${t.family} ${t.table} ${t.chain} 第 ${t.position} 條`), ' ',
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
  function planView(App) {
    const plan = state.plan;
    if (!plan) return h('p', { class: 'muted patch-empty' }, '先在上方選取檢查結果；可以依規則、依設備一次選取，或展開規則逐筆勾選。');
    const files = state.files;
    const all = () => {
      files.forEach((f) => Object.keys(KIND).forEach((k) => download(fileName(f, k), f[k])));
      download(`patch-summary-${V.exporter.baseName(App.snap)}.md`, V.exporter.patchSummaryMarkdown(plan, files, App.Q));
    };
    const SKIP_LEVEL = (x) => (x.level ? R().LEVEL_TEXT[x.level] || x.level : '');
    const skippedByReason = new Map(); plan.skipped.forEach((x) => S.util.getOr(skippedByReason, x.reason, () => []).push(x));
    return h('div', { class: 'patch-plan' }, [
      h('div', { class: 'summary sub patch-summary' }, [
        V.chip(`可產生指令 ${V.num(plan.items.length)} 項（${V.num(plan.devices.length)} 台設備）`, plan.items.length ? 'ok' : ''),
        V.chip(`未產生指令 ${V.num(plan.skipped.length)} 項`, plan.skipped.length ? 'warn' : ''),
      ]),
      files.length ? h('div', { class: 'row patch-download-all' }, files.length === 1
        ? [h('span', { class: 'muted' }, '單台設備：下載三個 .rsc')].concat(Object.keys(KIND).map((k) => h('button', { class: 'patch-download', 'data-file': fileName(files[0], k),
          onclick: () => download(fileName(files[0], k), files[0][k]) }, '下載 ' + fileName(files[0], k))))
        : [h('button', { class: 'primary patch-download-every', onclick: all }, `逐檔下載全部（${files.length * 3 + 1} 個檔案）`),
          h('button', { class: 'patch-download-summary', onclick: () => download(`patch-summary-${V.exporter.baseName(App.snap)}.md`, V.exporter.patchSummaryMarkdown(plan, files, App.Q)) }, '只下載總表（Markdown）'),
          h('span', { class: 'muted' }, '目前沒有 ZIP（第二階段提供）；瀏覽器可能會詢問是否允許下載多個檔案。總表列出每台設備的檔名、項目與風險。')]) : null,
      ...files.map((f) => deviceBlock(App, plan, f)),
      plan.skipped.length ? h('div', { class: 'patch-skipped' }, [
        h('h4', null, ['沒有產生指令的項目 ', V.chip(String(plan.skipped.length), 'warn')]),
        ...Array.from(skippedByReason.entries()).map(([reason, list]) => h('div', { class: 'patch-skip-group', 'data-reason': reason }, [
          h('div', { class: 'patch-label' }, RM().SKIP_TEXT[reason] || reason),
          ...list.map((x) => h('div', { class: 'patch-skip', 'data-finding': x.findingKey }, [
            V.chip(x.id || '—'), ' ', x.dev ? h('span', { class: 'muted' }, App.Q.devName(x.dev) + '：') : null,
            x.detail !== RM().SKIP_TEXT[reason] ? x.detail : SKIP_LEVEL(x)])),
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
    if (state.inputHash !== App.snap.meta.inputHash) { state.keys.clear(); state.view.clear(); state.inputHash = App.snap.meta.inputHash; }
    if (keys) { state.keys = new Set(keys); }
    compute(App); render(App);
    const dlg = $('#dlg-patch'); if (!dlg.open) dlg.showModal();
  }
  /** 重繪時（換基準）：對話框開著才更新；基準不同時清空選取 */
  function refresh(App) {
    const dlg = $('#dlg-patch'); if (!dlg || !dlg.open) return;
    if (!App.snap) { dlg.close(); return; }
    if (state.inputHash !== App.snap.meta.inputHash) { state.keys.clear(); state.view.clear(); state.inputHash = App.snap.meta.inputHash; }
    compute(App); render(App);
  }

  V.patchView = { open, refresh, render, state, fileName };
  window.App.openPatch = (keys) => open(window.App, keys);
})(globalThis.SSOT = globalThis.SSOT || {});
