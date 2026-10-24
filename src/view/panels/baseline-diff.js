/*
 * 比對分頁的下半：新舊基準比對。
 * 讀入之前匯出的基準（Snapshot JSON）當作舊基準，以 S.compare.snapshots(SSOT.query(舊), App.Q) 比對，依類別分組列出。
 * 比對結果與舊基準的查詢介面只放在記憶體（這個檔案的 state）：舊基準可能很大，而且換了新基準就失去意義，所以不存進 store。
 * 檢查結果分頁的「只看新出現的」透過 V.baselineDiff.loaded() 讀取同一份比對結果。
 * 比對結果上方另有修復追蹤：「已排程修復」的確認在兩份基準之間是否已修復（V.remediation.fixTracking）。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const K = S.keys;
  const T = V.theme.diff;
  const CATEGORY = { device: '設備', link: '鏈路', vlan: 'VLAN', ip: 'IP', firewall: '防火牆', finding: '檢查結果' };
  const CHANGE = { added: ['新增', 'ok'], removed: ['移除', 'err'], changed: ['變更', 'warn'] };
  const EFFECT = { 'new-exposure': '新暴露', 'less-restrictive': '放寬', 'more-restrictive': '收緊' };
  const state = { report: null, qOld: null, name: '', filter: 'all' };

  /** 沒有比對就結束的報告（形狀同 ssot-snapdiff/1），errors 說明原因 */
  const empty = (msg) => ({ schema: 'ssot-snapdiff/1', errors: [msg], summary: { added: 0, removed: 0, changed: 0, byCategory: {} }, items: [] });
  /** 讀入的文字 → { report, qOld }；JSON 或基準格式不對時，報告的 errors 說明原因、qOld 為 null，不硬比 */
  function loadOld(App, text) {
    let old;
    try { old = JSON.parse(text); } catch (e) { return { report: empty('無法讀取：' + e.message), qOld: null }; }
    if (!old || typeof old !== 'object' || !old.meta || typeof old.meta !== 'object') return { report: empty('這不是基準（Snapshot JSON）：缺少 meta；請用工具列的「匯出 JSON」產生的檔案'), qOld: null };
    // schema 不同時欄位意義不同，舊檔可能連查詢介面都建不起來：只把 meta 交給核心，由核心回報不比對的原因
    if (old.meta.schema !== App.Q.meta().schema) return { report: S.compare.snapshots({ meta: () => old.meta }, App.Q), qOld: null };
    let qOld;
    try { qOld = S.query(old); } catch (e) { console.error(e); return { report: empty('舊基準的內容不完整，無法比對：' + e.message), qOld: null }; }
    const report = S.compare.snapshots(qOld, App.Q);
    return { report, qOld: report.errors.length ? null : qOld };
  }
  const diffFrom = (App, text) => loadOld(App, text).report;
  /**
   * 目前載入、可用的舊基準：{ name, report, qOld, addedFindingKeys（新出現的 finding 的 findingKey） }；沒有或比對失敗時為 null。
   */
  function loaded() {
    if (!state.report || !state.qOld || state.report.errors.length) return null;
    if (!state.addedFindingKeys) state.addedFindingKeys = new Set(state.report.items.filter((i) => i.category === 'finding' && i.change === 'added').map((i) => i.key));
    return { name: state.name, report: state.report, qOld: state.qOld, addedFindingKeys: state.addedFindingKeys };
  }

  /** 修復追蹤：「已排程修復」的確認分成已修復／仍存在／變更；可一鍵清掉已修復的確認 */
  function fixSection(App) {
    const ft = V.remediation.fixTracking(state.qOld, App.Q, V.app.ackEntries());
    const box = h('div', { class: 'fix-tracking' }, [h('div', { class: 'diff-head' }, [h('b', null, '修復追蹤'), ' ',
      h('span', { class: 'muted' }, '確認時分類為「已排程修復」的檢查結果，在兩份基準之間的變化')])]);
    const total = ft.fixed.length + ft.open.length + ft.changed.length;
    if (!total) { box.appendChild(h('div', { class: 'muted pane-note' }, '沒有「已排程修復」的確認項目出現在這兩份基準中。確認檢查結果時選「已排程修復」，之後比對就會在這裡追蹤。')); return box; }
    const GROUPS = [
      ['fixed', '已修復', 'ok', '新基準已經沒有這筆', (x) => x.before],
      ['open', '仍存在', 'warn', '新基準仍有，訊息相同', (x) => x.after],
      ['changed', '變更', 'info', '兩份基準都有，但訊息不同', (x) => x.after],
    ];
    // 類別名稱不用 diff-summary／diff-cat：那兩個是下方比對結果的結構
    box.appendChild(h('div', { class: 'summary fix-summary' }, GROUPS.map(([k, label, cls]) => V.chip(`${label} ${V.num(ft[k].length)}`, ft[k].length ? cls : '', { 'data-fix': k }))));
    GROUPS.forEach(([k, label, cls, note, pick]) => {
      if (!ft[k].length) return;
      const rows = ft[k].map((x) => ({ x, f: pick(x)[0], before: x.before[0] || null }));
      box.appendChild(h('div', { class: 'fix-group', 'data-fix': k }, [
        h('div', { class: 'diff-head' }, [V.chip(label, cls), ' ', h('span', { class: 'muted' }, note),
          k === 'fixed' ? h('button', {
            class: 'ghost clear-fixed', title: '這些項目在新基準中已經沒有，清掉它們的確認紀錄（只影響這個瀏覽器）',
            onclick: async () => { const n = await App.clearAcks(ft.fixed.map((x) => x.key)); V.app.banner(`已清掉 ${n} 筆已修復的確認。`, 4000); },
          }, `清掉已修復的確認（${V.num(ft.fixed.length)}）`) : null]),
        V.table([
          { t: '規則', f: (r) => h('span', { class: 'mono' }, r.f.id) },
          { t: '項目', f: (r) => (k === 'changed' && r.before ? h('div', null, [h('div', { class: 'muted' }, '舊：' + r.before.message), h('div', null, '新：' + r.f.message)]) : r.f.message) },
        ], rows, { limit: 300, onRow: k === 'fixed' ? null : (r) => open(App, { category: 'finding', key: r.x.key }) }),
      ]));
    });
    return box;
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

  // effect 的文字色在色盲下接近，所以前面加上與嚴重度相同的外形（theme.diff.effectSev：方形、三角形、圓形）
  const effectChip = (e) => (e ? h('span', {
    class: 'chip effect', style: { color: T.effect[e], borderColor: T.effect[e] }, title: e,
  }, [T.effectSev[e] ? h('span', { class: 'sev ' + T.effectSev[e], 'aria-hidden': 'true' }) : null, EFFECT[e] || e]) : null);

  function render(App) {
    const box = h('div', { class: 'pane-body baseline-diff' });
    const file = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', onchange: async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      let r;
      try { r = loadOld(App, await f.text()); } catch (e) { console.error(e); r = { report: empty('無法讀取：' + e.message), qOld: null }; }
      state.report = r.report; state.qOld = r.qOld; state.addedFindingKeys = null;
      state.name = f.name; state.filter = 'all';
      // 檢查結果分頁的「只看新出現的」也依這份舊基準
      V.lists.compare(App); V.lists.findings(App);
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
    if (state.qOld) box.appendChild(fixSection(App));
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

  V.baselineDiff = { render, diffFrom, loaded, reset: () => { state.report = null; state.qOld = null; state.addedFindingKeys = null; state.name = ''; state.filter = 'all'; } };
})(globalThis.SSOT = globalThis.SSOT || {});
