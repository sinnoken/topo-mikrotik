/*
 * 比對分頁的下半：新舊基準比對。
 * 讀入之前匯出的基準（Snapshot JSON）當作舊基準，以 S.compare.snapshots(SSOT.query(舊), App.Q) 比對，依類別分組列出。
 * 比對結果只放在記憶體：舊基準可能很大，而且換了新基準就失去意義，所以不存進 store。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const K = S.keys;
  const T = V.theme.diff;
  const CATEGORY = { device: '設備', link: '鏈路', vlan: 'VLAN', ip: 'IP', firewall: '防火牆', finding: '檢查結果' };
  const CHANGE = { added: ['新增', 'ok'], removed: ['移除', 'err'], changed: ['變更', 'warn'] };
  const EFFECT = { 'new-exposure': '新暴露', 'less-restrictive': '放寬', 'more-restrictive': '收緊' };
  const state = { report: null, name: '', filter: 'all' };

  /** 沒有比對就結束的報告（形狀同 ssot-snapdiff/1），errors 說明原因 */
  const empty = (msg) => ({ schema: 'ssot-snapdiff/1', errors: [msg], summary: { added: 0, removed: 0, changed: 0, byCategory: {} }, items: [] });
  /** 讀入的文字 → 比對報告；JSON 或基準格式不對時，報告的 errors 說明原因，不硬比 */
  function diffFrom(App, text) {
    let old;
    try { old = JSON.parse(text); } catch (e) { return empty('無法讀取：' + e.message); }
    if (!old || typeof old !== 'object' || !old.meta || typeof old.meta !== 'object') return empty('這不是基準（Snapshot JSON）：缺少 meta；請用工具列的「匯出 JSON」產生的檔案');
    // schema 不同時欄位意義不同，舊檔可能連查詢介面都建不起來：只把 meta 交給核心，由核心回報不比對的原因
    if (old.meta.schema !== App.Q.meta().schema) return S.compare.snapshots({ meta: () => old.meta }, App.Q);
    let qOld;
    try { qOld = S.query(old); } catch (e) { console.error(e); return empty('舊基準的內容不完整，無法比對：' + e.message); }
    return S.compare.snapshots(qOld, App.Q);
  }

  /** 差異項目 → 目前基準中可定位的選取；只在舊基準中的項目回傳 null */
  function selOf(App, it) {
    const Q = App.Q;
    switch (it.category) {
      case 'device': return Q.getDevice(it.key) ? { type: 'device', key: it.key } : null;
      case 'link': return Q.getLink(it.key) ? { type: 'link', key: it.key } : null;
      case 'vlan': {
        const id = it.key.split('|').pop();
        return Q.vlans().some((v) => String(v.id) === id) ? { type: 'vlan', key: id } : null;
      }
      case 'ip': return { type: 'ip', key: it.key };
      case 'firewall': {
        if (Q.getFirewallRule(it.key)) return { type: 'rule', key: it.key };
        const dev = K.splitEp(it.key)[0];
        return Q.getDevice(dev) ? { type: 'firewall', dev } : null;
      }
      default: return null;
    }
  }
  function open(App, it) {
    if (it.category === 'finding') {
      const idx = App.snap.findings.findIndex((f) => App.Q.findingKey(f) === it.key);
      if (idx >= 0) { App.selectFinding(idx); return; }
    } else {
      const sel = selOf(App, it);
      if (sel) { App.select(sel, { focus: true }); return; }
    }
    V.app.banner('這個項目只在舊基準中，目前的基準沒有可以定位的對象。', 4000);
  }

  const effectChip = (e) => (e ? h('span', {
    class: 'chip effect', style: { color: T.effect[e], borderColor: T.effect[e] }, title: e,
  }, EFFECT[e] || e) : null);

  function render(App) {
    const box = h('div', { class: 'pane-body baseline-diff' });
    const file = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', onchange: async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      try { state.report = diffFrom(App, await f.text()); } catch (e) { console.error(e); state.report = empty('無法讀取：' + e.message); }
      state.name = f.name; state.filter = 'all';
      V.lists.compare(App);
    } });
    box.appendChild(h('h4', { class: 'pane-title' }, '與舊基準比對'));
    box.appendChild(h('p', { class: 'muted' }, '載入之前匯出的基準（工具列「匯出 JSON」），列出設備、鏈路、VLAN、IP、防火牆規則與檢查結果的變化。只讀取兩份基準，比對結果不會儲存。'));
    box.appendChild(h('div', { class: 'row' }, [file,
      h('button', { disabled: !App.Q || null, onclick: () => file.click() }, '載入舊基準（JSON）…'),
      state.name ? h('span', { class: 'muted' }, state.name) : null]));
    const r = state.report; if (!r || !App.Q) return box;
    if (r.errors.length) {
      box.appendChild(h('div', { class: 'diff-errors' }, r.errors.map((e) => h('div', { class: 'finding' }, [V.sevDot('error'), e]))));
      return box;
    }
    const exposure = r.items.filter((i) => i.effect === 'new-exposure');
    // 摘要：變更種類與新暴露；新暴露可單獨篩選
    box.appendChild(h('div', { class: 'summary diff-summary' }, [
      ...Object.entries(CHANGE).map(([k, [label, cls]]) => V.chip(`${label} ${V.num(r.summary[k])}`, r.summary[k] ? cls : '')),
      h('button', {
        class: 'ghost' + (state.filter === 'new-exposure' ? ' on' : ''), disabled: !exposure.length || null,
        style: exposure.length ? { color: T.effect['new-exposure'] } : null, 'aria-pressed': String(state.filter === 'new-exposure'),
        onclick: () => { state.filter = state.filter === 'new-exposure' ? 'all' : 'new-exposure'; V.lists.compare(App); },
      }, `新暴露 ${V.num(exposure.length)}`),
    ]));
    if (!r.items.length) { box.appendChild(h('div', { class: 'muted pane-note' }, '兩份基準沒有差異。')); return box; }
    const items = state.filter === 'new-exposure' ? exposure : r.items;
    Object.keys(CATEGORY).forEach((cat) => {
      const list = items.filter((i) => i.category === cat); if (!list.length) return;
      const c = r.summary.byCategory[cat] || {};
      box.appendChild(h('div', { class: 'diff-cat', 'data-category': cat }, [
        h('div', { class: 'diff-head' }, [h('b', null, CATEGORY[cat]), ' ',
          ...Object.entries(CHANGE).filter(([k]) => c[k]).map(([k, [label, cls]]) => V.chip(`${label} ${V.num(c[k])}`, cls))]),
        V.table([
          { t: '', f: (i) => V.chip(CHANGE[i.change][0], CHANGE[i.change][1]) },
          { t: '項目', f: (i) => i.message },
          { t: '影響', f: (i) => effectChip(i.effect) },
        ], list, {
          limit: 300, onRow: (i) => open(App, i),
          rowClass: (i) => (i.effect === 'new-exposure' ? 'exposure' : ''),
          rowStyle: (i) => (i.effect === 'new-exposure' ? { background: T.exposureBg } : null),
        }),
      ]));
    });
    return box;
  }

  V.baselineDiff = { render, diffFrom, reset: () => { state.report = null; state.name = ''; state.filter = 'all'; } };
})(globalThis.SSOT = globalThis.SSOT || {});
