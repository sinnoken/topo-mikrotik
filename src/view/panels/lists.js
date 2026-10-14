/*
 * 左側三個分頁：檢查結果、覆蓋率、比對。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h;

  // ---------------------------------------------------------------- 檢查結果
  const state = { sev: { error: true, warn: true, info: true }, open: new Set(), shown: new Map(), selected: -1 };
  function findings(App) {
    const root = V.clear(V.$('#pane-findings'));
    if (!App.snap) return root.appendChild(h('div', { class: 'empty-detail' }, '建立基準後，資料之間的矛盾與缺漏會列在這裡。'));
    const all = App.snap.findings; const st = App.snap.meta.stats.findings;
    root.appendChild(h('div', { class: 'summary' }, ['error', 'warn', 'info'].map((s) => V.chip(`${V.SEV[s]} ${st[s]}`, `btn ${s === 'error' ? 'err' : s} ${state.sev[s] ? 'on' : ''}`, {
      onclick: () => { state.sev[s] = !state.sev[s]; findings(App); }, title: '點一下切換顯示',
    }))));
    if (!all.length) return root.appendChild(h('div', { class: 'empty-detail' }, [h('div', { class: 'big' }, '沒有發現問題'), '所有資料彼此一致。']));
    const groups = new Map();
    all.forEach((f, idx) => { if (state.sev[f.severity]) S.util.getOr(groups, f.id, () => []).push(idx); });
    groups.forEach((idxs, id) => {
      const c = S.check.CATALOG[id]; const open = state.open.has(id);
      const g = h('div', { class: 'fgroup' }, [h('div', { class: 'head', onclick: () => { open ? state.open.delete(id) : state.open.add(id); findings(App); } }, [
        h('span', null, open ? '▾' : '▸'), V.sevDot(c.severity), h('span', { class: 'title' }, c.title), h('span', { class: 'id' }, id), V.chip(String(idxs.length)),
      ])]);
      if (open) {
        const n = state.shown.get(id) || 100;
        g.appendChild(h('div', { class: 'items' }, idxs.slice(0, n).map((i) => h('div', { class: 'fitem' + (state.selected === i ? ' sel' : ''), onclick: () => { state.selected = i; App.selectFinding(i); findings(App); } }, all[i].message))));
        if (idxs.length > n) g.appendChild(h('a', { class: 'link more', onclick: () => { state.shown.set(id, n + 200); findings(App); } }, `再顯示 200 筆（共 ${idxs.length} 筆）`));
      }
      root.appendChild(g);
    });
  }
  findings.reset = () => { state.open = new Set(); state.shown = new Map(); state.selected = -1; };
  findings.openFirst = (snap) => { const f = snap.findings.find((x) => x.severity !== 'info'); if (f) state.open.add(f.id); };

  // ---------------------------------------------------------------- 覆蓋率
  const cov = { filter: 'all' };
  function coverage(App) {
    const root = V.clear(V.$('#pane-coverage'));
    if (!App.snap) return root.appendChild(h('div', { class: 'empty-detail' }, '建立基準後，可以在這裡看到每台設備收集了哪些資料。'));
    const rows = App.snap.coverage; const Q = App.Q;
    const collected = rows.filter((r) => r.collected); const missing = collected.filter((r) => r.missing.length);
    const seenOnly = rows.filter((r) => !r.collected && r.kind !== 'host'); const hosts = rows.filter((r) => !r.collected && r.kind === 'host');
    const F = { all: ['全部已收集', collected], missing: ['有缺漏', missing], seen: ['未收集的網路設備', seenOnly], hosts: ['主機（只由 LLDP 看到）', hosts] };
    root.appendChild(h('div', { class: 'summary' }, Object.entries(F).map(([k, [label, list]]) => V.chip(`${label} ${list.length}`, `btn ${k === 'missing' && list.length ? 'err' : ''} ${cov.filter === k ? 'on' : ''}`, { onclick: () => { cov.filter = k; coverage(App); } }))));
    const list = F[cov.filter][1];
    root.appendChild(V.table([
      { t: '設備', f: (r) => Q.devName(r.dev) },
      { t: '類型', f: (r) => V.kindChip(r.kind) },
      { t: '資料', f: (r) => h('span', null, [...r.data.map((t) => V.chip(S.check.DATA_LABEL[t] || t)), ...r.missing.map((t) => V.chip('缺 ' + (S.check.DATA_LABEL[t] || t), 'err'))]) },
      { t: '連結', f: (r) => String(r.links) },
    ], list, { onRow: (r) => App.select({ type: 'device', key: r.dev }, { focus: true }), limit: 600, bad: (r) => r.missing.length > 0 }));
  }

  // ---------------------------------------------------------------- 比對
  const cmp = { report: null, name: '', filter: 'problem' };
  function compare(App) {
    const root = V.clear(V.$('#pane-compare'));
    const file = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', onchange: async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      try { const exp = JSON.parse(await f.text()); cmp.report = S.compare(App.Q, exp); cmp.name = f.name; } catch (e) { cmp.report = { errors: ['無法讀取：' + e.message], items: [], summary: {} }; cmp.name = f.name; }
      compare(App);
    } });
    root.appendChild(h('div', { style: { padding: '10px' } }, [
      h('p', { class: 'muted', style: { marginTop: 0 } }, '把「預期應該長怎樣」的資料（格式 ssot-expected/1，獨立於基準）和目前基準比對。比對只讀取基準，不會修改它。'),
      h('div', { class: 'row' }, [file, h('button', { disabled: !App.Q || null, onclick: () => file.click() }, '載入預期資料（JSON）…'), cmp.name ? h('span', { class: 'muted' }, cmp.name) : null]),
      h('details', null, [h('summary', { class: 'muted' }, '格式說明'), h('pre', { class: 'raw', style: { whiteSpace: 'pre-wrap', background: '#f7f9fb', padding: '8px', borderRadius: '6px' } },
        '{\n  "schema": "ssot-expected/1",\n  "devices": ["TPE_CORE_SW_01", {"name": "TPE_FW_01", "kind": "firewall"}],\n  "links": [{"a": "TPE_CORE_SW_01 xe-0/0/0", "b": "TPE_FW_01 port1"}],\n  "vlans": [{"device": "TPE_ACC_SW_01", "id": 20, "name": "SRV"}],\n  "strictDevices": false,\n  "strictLinks": false\n}')]),
    ]));
    const r = cmp.report; if (!r) return;
    if (r.errors.length) root.appendChild(h('div', { style: { padding: '0 10px' } }, r.errors.map((e) => h('div', { class: 'finding' }, [V.sevDot('error'), e]))));
    const ST = { ok: ['一致', 'ok'], missing: ['基準缺少', 'err'], different: ['不同', 'warn'], unexpected: ['基準多出', 'info'] };
    root.appendChild(h('div', { class: 'summary' }, [V.chip(`有差異 ${r.items.filter((i) => i.status !== 'ok').length}`, `btn ${cmp.filter === 'problem' ? 'on' : ''}`, { onclick: () => { cmp.filter = 'problem'; compare(App); } }),
      ...Object.entries(ST).map(([k, [label, cls]]) => V.chip(`${label} ${r.summary[k] || 0}`, `btn ${cls} ${cmp.filter === k ? 'on' : ''}`, { onclick: () => { cmp.filter = k; compare(App); } }))]));
    const items = r.items.filter((i) => (cmp.filter === 'problem' ? i.status !== 'ok' : i.status === cmp.filter));
    root.appendChild(V.table([{ t: '', f: (i) => V.chip(ST[i.status][0], ST[i.status][1]) }, { t: '項目', f: (i) => i.message }], items, {
      onRow: (i) => {
        if (i.type === 'device' && App.Q.getDevice(i.ref)) App.select({ type: 'device', key: i.ref }, { focus: true });
        else if (i.type === 'link' && App.Q.getLink(i.ref)) App.select({ type: 'link', key: i.ref }, { focus: true });
        else if (i.type === 'link') { const ep = i.ref.split('~')[0]; if (App.Q.getInterface(ep)) App.select({ type: 'interface', key: ep }, { focus: true }); }
      },
    }));
  }
  compare.reset = () => { cmp.report = null; cmp.name = ''; };

  V.lists = { findings, coverage, compare };
})(globalThis.SSOT = globalThis.SSOT || {});
