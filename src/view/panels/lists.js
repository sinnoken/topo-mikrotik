/*
 * 左側三個分頁：檢查結果、覆蓋率、比對。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const K = S.keys;

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

  // ---------------------------------------------------------------- 清單：設備、介面、IP、MAC、VLAN
  const inv = { kind: 'device', filter: 'all', q: '', sortBy: -1, sortDir: 1 };
  function inventory(App) {
    const root = V.clear(V.$('#pane-inventory'));
    if (!App.snap) return root.appendChild(h('div', { class: 'empty-detail' }, '建立基準後，所有設備、介面、IP、MAC 與 VLAN 會列在這裡。'));
    const Q = App.Q; const m = App.snap.model; const ipRows = Q.ipEntries(); const macRows = Q.macEntries();
    const ends = Q.endpointEntries(); const devRows = m.devices.concat(ends.map((e) => Object.assign({ end: true }, e)));
    const nMac = new Set(macRows.map((r) => r.mac)).size; // 清單一個 MAC 可能有多列（每個觀察到它的介面一列）
    const nameOf = (r) => (r.end ? r.desc || r.vendors[0] || (r.macs.length === 1 ? K.macPretty(r.macs[0].mac) : `${r.macs.length} 個 MAC`) : Q.devName(r.key));
    const ipOf = (r) => (r.end ? r.ips[0] : r.mgmtIp); const vendorOf = (r) => (r.end ? r.vendors.join(' / ') : r.vendor);
    const dn = (d) => (d ? Q.devName(d) : '—'); const mono = (t) => h('span', { class: 'mono' }, t || '—');
    const T = {
      device: ['設備', devRows, [
        { t: '設備', f: (r) => nameOf(r), s: nameOf }, { t: '類型', f: (r) => (r.end ? V.chip('末端', 'kind-unknown') : V.kindChip(r.kind)), s: (r) => (r.end ? '末端' : V.KIND[r.kind] || r.kind) },
        { t: '管理 IP', f: (r) => mono(ipOf(r)), s: ipOf }, { t: '廠商', f: (r) => vendorOf(r) || '', s: vendorOf },
        { t: '連接於', f: (r) => (r.end ? `${dn(r.dev)} ${r.ifc}` : ''), s: (r) => (r.end ? dn(r.dev) + ' ' + r.ifc : null) },
        { t: '收集', f: (r) => (r.end ? '' : r.collected ? '是' : '否'), s: (r) => (r.end ? null : r.collected ? '是' : '否') }],
      (r) => (r.end ? { type: 'interface', key: r.key } : { type: 'device', key: r.key }), (r) => [nameOf(r), ipOf(r), vendorOf(r), r.kind, r.end ? dn(r.dev) + ' ' + r.ifc : null]],
      interface: ['介面', m.interfaces, [
        { t: '設備', f: (r) => dn(r.dev), s: (r) => dn(r.dev) }, { t: '介面', f: (r) => mono(r.name), s: (r) => r.name }, { t: '狀態', f: (r) => r.status, s: (r) => r.status },
        { t: 'IP', f: (r) => mono(r.ips.slice(0, 2).join(' ')), s: (r) => r.ips[0] }, { t: 'VLAN', f: (r) => h('span', { class: 'vlanlist' }, r.vlans.length ? S.check.fmtVlans(r.vlans) : '—'), s: (r) => r.vlans.join(' ') }],
      (r) => ({ type: 'interface', key: r.key }), (r) => [dn(r.dev), r.name, r.desc, r.ips.join(' '), r.vlans.join(' ')]],
      ip: ['IP', ipRows, [
        { t: 'IP', f: (r) => mono(r.ip), s: (r) => r.ip }, { t: '設備', f: (r) => dn(r.dev), s: (r) => r.dev && dn(r.dev) }, { t: '介面', f: (r) => mono(r.ifc), s: (r) => r.ifc },
        { t: 'MAC', f: (r) => mono(r.macs.slice(0, 2).map(K.macPretty).join(' ')), s: (r) => r.macs[0] }, { t: '來源', f: (r) => r.from.join('、'), s: (r) => r.from.join('、') }],
      (r) => ({ type: 'ip', key: r.ip }), (r) => [r.ip, dn(r.dev), r.ifc, r.macs.map(K.macPretty).join(' ')]],
      mac: ['MAC', macRows, [
        { t: '設備', f: (r) => dn(r.dev), s: (r) => r.dev && dn(r.dev) }, { t: '介面', f: (r) => mono(r.ifc), s: (r) => r.ifc }, { t: 'MAC', f: (r) => mono(K.macPretty(r.mac)), s: (r) => r.mac },
        { t: 'VLAN', f: (r) => r.vlan || '—', s: (r) => r.vlan }, { t: 'IP', f: (r) => (r.ips.length ? r.ips.slice(0, 2).join(' ') : V.chip('缺 IP', 'warn')), s: (r) => r.ips[0] }],
      (r) => ({ type: 'mac', key: r.mac }), (r) => [dn(r.dev), r.ifc, K.macPretty(r.mac), r.vlan, r.ips.join(' ')]],
      vlan: ['VLAN', m.vlans, [
        { t: '設備', f: (r) => dn(r.dev), s: (r) => dn(r.dev) }, { t: 'VLAN', f: (r) => (r.id == null ? '—' : String(r.id)), s: (r) => r.id }, { t: '名稱', f: (r) => r.name || r.desc || '', s: (r) => r.name || r.desc },
        { t: '成員', f: (r) => String(r.members.length), s: (r) => r.members.length }],
      (r) => (r.id == null ? { type: 'device', key: r.dev } : { type: 'vlan', key: String(r.id) }), (r) => [dn(r.dev), r.id, r.name, r.desc]],
    };
    root.appendChild(h('div', { class: 'summary' }, Object.entries(T).map(([k, [label, rows]]) => V.chip(`${label} ${k === 'mac' ? nMac : k === 'device' ? m.devices.length : rows.length}`, `btn ${inv.kind === k ? 'on' : ''}`, {
      onclick: () => { inv.kind = k; inv.filter = 'all'; inv.sortBy = -1; inv.sortDir = 1; inventory(App); }, title: label + '清單' }))));
    const [, rows0, cols, sel, text] = T[inv.kind];
    const FILTERS = {
      ip: [['all', '全部', () => true], ['arp', 'ARP', (r) => r.from.includes('ARP')], ['own', '設備自有', (r) => r.from.some((x) => x === '介面' || x === '管理')], ['heard', '鄰居宣告', (r) => r.from.includes('鄰居宣告')]],
      mac: [['all', '全部', () => true], ['noip', '缺 IP', (r) => r.noIp]],
      device: [['all', '全部設備', (r) => !r.end], ['net', '網路設備', (r) => !r.end && r.kind !== 'host'], ['host', '主機', (r) => !r.end && r.kind === 'host'], ['end', '末端', (r) => r.end]],
    };
    const flt = FILTERS[inv.kind];
    if (flt) {
      const uniq = (k, rows) => (k === 'mac' ? new Set(rows.map((r) => r.mac)).size : rows.length);
      const base = { mac: macRows, ip: ipRows, device: devRows }[inv.kind];
      root.appendChild(h('div', { class: 'summary' }, flt.map(([k, label, f]) => { const c = uniq(inv.kind, base.filter(f));
        return V.chip(`${label} ${c}`, `btn ${k === 'noip' && c ? 'warn' : ''} ${inv.filter === k ? 'on' : ''}`, { onclick: () => { inv.filter = k; inventory(App); }, title: '點一下切換篩選' }); })));
    }
    const box = h('input', { type: 'search', placeholder: '篩選：名稱、IP、MAC、VLAN…', value: inv.q, class: 'pane-filter' });
    const body = h('div');
    const draw = () => {
      const t = inv.q.trim().toLowerCase();
      const rows = rows0.filter((r) => (!flt || flt.find((x) => x[0] === inv.filter)[2](r)) && (!t || text(r).filter((x) => x != null).join(' ').toLowerCase().includes(t)));
      const sc = cols[inv.sortBy] && cols[inv.sortBy].s ? cols[inv.sortBy] : null;
      if (sc) { // 空值固定排最後；字串用 natural 排序，因此 IP 依數值順序
        const val = (r) => { const v = sc.s(r); return v == null || v === '' ? null : v; };
        rows.sort((a, b) => { const x = val(a); const y = val(b); if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
          return (typeof x === 'number' && typeof y === 'number' ? x - y : S.util.natural(String(x), String(y))) * inv.sortDir; });
      }
      const note = inv.kind === 'mac' ? `共 ${rows.length} 列（同一個 MAC 在每個觀察到的介面各一列，不重複的 MAC ${new Set(rows.map((r) => r.mac)).size} 個）` : inv.kind === 'vlan' ? `共 ${rows.length} 筆（每台設備的每個 VLAN 定義一筆，不重複的 VLAN ID ${new Set(rows.map((r) => r.id)).size} 個）` : '';
      V.clear(body); if (note) body.appendChild(h('div', { class: 'muted', style: { padding: '4px 8px' } }, note));
      body.appendChild(V.table(cols, rows, { onRow: (r) => App.select(sel(r), { focus: true }), limit: 500, sortBy: sc ? inv.sortBy : -1, sortDir: inv.sortDir,
        onSort: (n) => { inv.sortDir = inv.sortBy === n ? -inv.sortDir : 1; inv.sortBy = n; draw(); } }));
    };
    box.addEventListener('input', () => { inv.q = box.value; draw(); });
    root.appendChild(box); root.appendChild(body); draw();
  }
  V.lists = { findings, coverage, compare, inventory };
})(globalThis.SSOT = globalThis.SSOT || {});
