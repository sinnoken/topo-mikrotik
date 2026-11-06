/*
 * 設定「本機資料」（外殼在 app-settings.js）：這個工具存在瀏覽器裡的每一項資料（名稱、用途、大小、最後更新），
 * 每列可以個別清除（先確認，寫出會失去什麼；處理紀錄特別警告），以及下載全部、從備份還原、重設畫面偏好。
 * 鍵的名稱、用途與會失去什麼只取自 S.store.KEYS；列舉、大小、備份與還原都在 store.js，這裡只排版、確認與讓畫面跟上。
 * 清除基準沿用 App.clearBaseline（它自己確認）。清單是 S.store.inventory() 的結果，非同步讀回後快取在模組內：
 * 每次重繪先用快取同步畫好（焦點能回到同一個按鈕），讀回的內容不同時再重繪一次。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h;
  const A = () => V.app;

  /** 模組內的檢視狀態：inv 是最近一次的 inventory；restoreMsg 是最近一次還原的結果 { name, errors } 或 { name, keys } */
  const st = { inv: null, job: null, restoreMsg: null };

  /** 位元組換成 B／KB／MB（1024 進位，一位小數） */
  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const descOf = (k) => S.store.KEYS.find((d) => d.key === k) || null;

  /** 重新讀清單；和快取不同時重繪設定。回傳 promise（測試可以等） */
  function refresh() {
    if (st.job) return st.job;
    st.job = S.store.inventory().then((inv) => {
      const changed = JSON.stringify(inv) !== JSON.stringify(st.inv);
      st.inv = inv; st.job = null;
      if (changed && A().settingsOpen() && A().settingsSection() === 'data') A().renderSettings();
    }, (e) => { st.job = null; console.error(e); A().banner('無法讀取本機資料的清單：' + V.reason(e), 8000); });
    return st.job;
  }
  /** 動作做完：重讀清單並重繪 */
  const after = async () => { await refresh(); A().renderAll(); };

  // ================================================================ 清除
  /** 確認對話框的文字：清除哪一項、會失去什麼；無法重建的另外警告並建議先備份 */
  function clearMessage(d) {
    let m = `清除「${d.label}」？\n會失去：${d.loss}`;
    if (d.critical) m += '\n\n注意：處理紀錄是你的判斷紀錄（處理狀態、備註、接受風險的理由），無法從收集檔重建。建議先按「下載全部（JSON）」或在資料中心匯出處理紀錄，留一份備份。';
    return m;
  }
  /** 清除一列；回傳是否清除了 */
  async function clearKey(App, key) {
    const VA = A();
    if (key === 'last' && App.snap) { const ok = await App.clearBaseline(); await after(); return ok; } // 有基準時沿用清除基準（它自己確認）
    const d = descOf(key) || { label: key, loss: '這個鍵的內容（這個版本不使用）。' };
    if (!confirm(clearMessage(d))) return false;
    try {
      if (key === 'theme') { VA.setThemePref('system'); await S.store.clear('theme'); } else await S.store.clear(key);
      if (key === 'ledger') {
        // 畫面中的處理紀錄一起換成空白；有基準時以它開始新的一輪（寫回 store）
        VA.adoptLedger(S.ledger.empty());
        if (App.Q) await VA.advanceLedger(App.Q);
      }
      if (key === 'layoutMode') { App.layoutMode = App.LAYOUT_MODES[0]; VA.syncLayoutMode(); } // 沒有存值時的預設（app.js 啟動時同一個值）
    } catch (e) { console.error(e); VA.banner(`無法清除「${d.label}」：` + V.reason(e), 10000); await after(); return false; }
    VA.banner(`已清除「${d.label}」`, 5000);
    await after();
    return true;
  }
  /** 重設畫面偏好：只清 kind 'pref' 的鍵（欄寬、版面、配色），基準與處理紀錄不動 */
  async function resetPrefs(App) {
    const VA = A(); const prefs = S.store.KEYS.filter((d) => d.kind === 'pref');
    const keep = S.store.KEYS.filter((d) => d.kind === 'data').map((d) => d.label);
    if (!confirm(`重設畫面偏好？會清除：${prefs.map((d) => d.label).join('、')}。\n${keep.join('、')}不受影響。`)) return false;
    try {
      VA.setThemePref('system');
      App.layoutMode = App.LAYOUT_MODES[0]; VA.syncLayoutMode();
      await S.store.resetPrefs();
    } catch (e) { console.error(e); VA.banner('無法重設畫面偏好：' + V.reason(e), 10000); await after(); return false; }
    VA.banner('已重設畫面偏好（欄寬在下次開啟頁面時回到預設）', 6000);
    await after();
    return true;
  }

  // ================================================================ 備份與還原
  const fileName = (now) => `topo-mikrotik-localdata-${String(now).replace(/\.\d+Z$/, 'Z').replace(/[^0-9A-Za-z]/g, '')}.json`;
  async function exportAll() {
    try {
      const now = new Date().toISOString();
      const b = await S.store.exportAll(now);
      V.exporter.download(fileName(now), JSON.stringify(b, null, 2) + '\n', 'application/json');
    } catch (e) { console.error(e); A().banner('無法下載本機資料：' + V.reason(e), 10000); }
  }
  /** 載入備份檔的文字：驗證 → 列出將覆蓋的項目並確認 → 寫回 → 讓畫面跟上。不合法時列出原因，什麼都不寫 */
  async function restoreText(App, name, text) {
    const VA = A();
    let obj;
    try { obj = JSON.parse(text); } catch (e) { st.restoreMsg = { name, errors: ['不是 JSON：' + V.reason(e)] }; await after(); return false; }
    const extra = { layoutMode: (v) => (App.LAYOUT_MODES.includes(v) ? null : `應是 ${App.LAYOUT_MODES.join('／')} 之一`) };
    const v = S.store.validateBackup(obj, extra);
    if (!v.ok) { st.restoreMsg = { name, errors: v.errors }; await after(); return false; }
    const labels = v.keys.map((k) => descOf(k).label);
    let msg = `從 ${name} 還原？以下項目會被備份的內容取代：\n${labels.map((l) => '・' + l).join('\n')}\n備份裡沒有的項目不變。`;
    if (v.keys.includes('ledger')) msg += '\n\n注意：目前的處理紀錄會被取代，建議先按「下載全部（JSON）」留一份目前的備份。';
    if (obj.exportedAt) msg += `\n（備份時間：${V.fmtTime(obj.exportedAt)}）`;
    if (!confirm(msg)) return false;
    let r;
    try { r = await S.store.restore(obj, extra); } catch (e) {
      console.error(e); st.restoreMsg = { name, errors: ['寫入失敗：' + V.reason(e)] }; await after(); return false;
    }
    if (!r.ok) { st.restoreMsg = { name, errors: r.errors }; await after(); return false; }
    // 畫面跟上寫回的內容（同啟動時的讀法）
    const it = obj.items;
    if (r.keys.includes('theme')) VA.setThemePref(S.store.theme.get());
    if (r.keys.includes('layoutMode')) { App.layoutMode = it.layoutMode; VA.syncLayoutMode(); }
    if (r.keys.includes('layout') && App.layout) { ['left', 'right'].forEach((s) => { if (Number.isFinite(it.layout[s])) App.layout[s] = it.layout[s]; }); VA.applyColumns(); }
    if (r.keys.includes('ledger')) VA.adoptLedger(it.ledger);
    if (r.keys.includes('last')) { await App.restore(); await App.ledgerJob; } else if (r.keys.includes('ledger') && App.Q) await VA.advanceLedger(App.Q);
    if (r.keys.includes('ledger')) await VA.persistLedger(); // 同一份基準已在備份的紀錄中時 advance 會略過，一律再寫一次
    r.warnings.forEach((w) => VA.banner(w, 8000));
    st.restoreMsg = { name, keys: r.keys };
    VA.banner(`已從 ${name} 還原 ${r.keys.length} 項`, 6000);
    await after();
    return true;
  }

  // ================================================================ 畫面
  function row(App, d, item) {
    const present = item ? item.present : null; // null：清單還沒讀回
    const isLast = d.key === 'last';
    const can = isLast ? !!App.snap || !!present : !!present;
    const status = isLast && !App.snap ? (present ? '目前沒有基準（儲存的基準無法還原，可以清除）' : '目前沒有基準。') : present === false ? '沒有資料' : '';
    const attrs = { type: 'button', class: 'settings-clear' + (d.kind === 'data' || d.kind === 'other' ? ' danger' : ''), 'data-store-key': d.key,
      'data-settings-focus': isLast ? 'clear' : 'clear-' + d.key, disabled: !can || null, onclick: () => clearKey(App, d.key) };
    if (isLast) Object.assign(attrs, { id: 'btn-clear', title: '清除這個工具儲存的基準與輸入（會先確認）' });
    return h('tr', { 'data-store-key': d.key }, [
      h('td', null, [
        h('div', { class: 'settings-data-name' }, [d.label, d.critical ? h('strong', { class: 'settings-data-critical' }, '（無法從收集檔重建）') : null, d.where === 'localStorage' ? h('span', { class: 'muted' }, '（localStorage）') : null]),
        h('div', { class: 'muted' }, d.purpose),
        status ? h('div', { class: 'muted' }, status) : null,
      ]),
      h('td', { class: 'num' }, item ? (item.present ? fmtBytes(item.bytes) : '—') : '…'),
      h('td', null, item && item.updatedAt ? V.fmtTime(item.updatedAt) : item && item.present ? '沒有記錄' : '—'),
      h('td', null, h('button', attrs, isLast ? '清除基準…' : `清除${d.label}…`)),
    ]);
  }

  function render(App, el) {
    const inv = st.inv;
    if (inv && inv.storage === 'memory') {
      el.appendChild(h('p', { class: 'warn-line' }, '這個瀏覽器無法使用 IndexedDB（例如隱私模式或被封鎖），資料只在記憶體：關閉頁面後全部消失。要保留時請按「下載全部（JSON）」。'));
    }
    if (inv && inv.themeStorage === 'memory') el.appendChild(h('p', { class: 'warn-line' }, '這個瀏覽器無法使用 localStorage：配色只在記憶體，關閉頁面後回到跟隨系統。'));
    const items = inv ? inv.items : [];
    const descs = S.store.KEYS.concat(items.filter((i) => i.kind === 'other').map((i) => ({ key: i.key, label: i.label, purpose: i.purpose, loss: i.loss, kind: 'other', where: i.where })));
    const total = items.reduce((n, i) => n + (i.present ? i.bytes : 0), 0);
    el.appendChild(h('table', { class: 't settings-data' }, [
      h('caption', { class: 'muted' }, inv ? `共 ${fmtBytes(total)}（JSON 序列化後的大小）` : '讀取中…'),
      h('thead', null, h('tr', null, ['項目', '大小', '最後更新', ''].map((t, i) => h('th', i === 3 ? { 'aria-label': '操作' } : null, t)))),
      h('tbody', null, descs.map((d) => row(App, d, items.find((i) => i.key === d.key) || null))),
    ]));

    // 備份、還原、重設偏好
    const file = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', 'aria-hidden': 'true', tabindex: '-1' });
    file.addEventListener('change', async (e) => {
      const f = (e.target || file).files[0]; if (!f) return;
      let text; try { text = await f.text(); } catch (err) { st.restoreMsg = { name: f.name, errors: ['無法讀取：' + V.reason(err)] }; await after(); return; }
      await restoreText(App, f.name, text);
    });
    el.appendChild(h('div', { class: 'settings-action' }, [
      h('button', { type: 'button', 'data-action': 'localdata-export', 'data-settings-focus': 'localdata-export', onclick: () => exportAll(),
        title: '把上面所有的資料下載成一個 JSON 檔（ssot-localdata/1）' }, '下載全部（JSON）'),
      h('button', { type: 'button', 'data-action': 'localdata-restore', 'data-settings-focus': 'localdata-restore', onclick: () => file.click(),
        title: '選擇「下載全部」產生的檔案，先列出會取代的項目再確認' }, '從備份還原…'),
      h('button', { type: 'button', 'data-action': 'localdata-reset-prefs', 'data-settings-focus': 'localdata-reset-prefs', onclick: () => resetPrefs(App),
        title: '只清除欄寬、預設版面與配色；基準、處理紀錄與命名規則不動' }, '重設畫面偏好…'),
      file,
    ]));
    const m = st.restoreMsg;
    if (m && m.errors) {
      el.appendChild(h('div', { class: 'warn-line', role: 'alert' }, [
        h('p', null, `無法從 ${m.name} 還原，沒有寫入任何資料：`),
        h('ul', null, m.errors.map((e) => h('li', null, e))),
      ]));
    } else if (m && m.keys) el.appendChild(h('p', { class: 'muted', role: 'status' }, `已從 ${m.name} 還原：${m.keys.map((k) => descOf(k).label).join('、')}。`));
    el.appendChild(h('p', { class: 'muted settings-note' }, '清除基準不影響處理紀錄；處理紀錄的匯出與匯入也在資料中心。'));
    refresh();
  }

  V.settings = V.settings || {};
  V.settings.data = { render, refresh, restoreText };
})(globalThis.SSOT = globalThis.SSOT || {});
