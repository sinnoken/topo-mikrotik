/*
 * 設定「命名規則」（外殼在 app-settings.js）：目前可用的命名規則（S.profiles：內建的與載入過的）。
 * 選擇與載入命名規則檔仍在「建立基準」對話框；這裡只列出，並標出這一輪的基準用的是哪一份（App.round.profile）。
 * 載入過的命名規則存在 store 的 'profiles'，開啟這個分類時讀回並合併進 S.profiles（和建立基準對話框的做法相同）後重畫一次。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h;
  const A = () => V.app;

  let merged = false;
  function render(App, el) {
    // 第一次開啟：讀回存過的命名規則；讀完且仍在這個分類時重畫（讀不到時照常列出內建的）
    if (!merged) {
      merged = true;
      S.store.get('profiles').then((saved) => {
        if (saved && Object.keys(saved).length) { Object.assign(S.profiles, saved); if (A().settingsOpen() && A().settingsSection() === 'profiles') A().renderSettings(); }
      }, () => {});
    }
    const list = Object.values(S.profiles).filter((p) => p && p.id);
    const used = App.round.profile;
    if (!list.length) el.appendChild(h('p', { class: 'muted' }, '沒有可用的命名規則。'));
    else {
      el.appendChild(h('table', { class: 't settings-profiles' }, [
        h('thead', null, h('tr', null, ['ID', '名稱', '本輪'].map((t) => h('th', null, t)))),
        h('tbody', null, list.map((p) => h('tr', { 'data-profile': p.id }, [
          h('td', { class: 'mono' }, p.id + (p.version != null ? ` v${p.version}` : '')),
          h('td', null, p.label || '—'),
          h('td', null, used && used.id === p.id ? '✓ 目前的基準使用' : ''),
        ]))),
      ]));
    }
    el.appendChild(h('p', { class: 'muted' }, '要選擇或載入命名規則檔（JSON），請在「建立基準」對話框的「命名規則」。'));
    el.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', 'data-settings-focus': 'open-input', onclick: () => App.openInput() }, '開啟「建立基準」…')));
  }

  V.settings = V.settings || {};
  V.settings.profiles = { render };
})(globalThis.SSOT = globalThis.SSOT || {});
