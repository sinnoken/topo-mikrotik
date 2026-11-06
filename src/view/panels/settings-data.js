/*
 * 設定「本機資料」（外殼在 app-settings.js）：這個工具存在瀏覽器裡的資料，以及「清除基準…」（App.clearBaseline，先確認）。
 * 清除只清基準與輸入；處理紀錄是使用者的資料，不在這裡清（匯出與匯入在資料中心）。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h;

  function render(App, el) {
    const has = !!App.snap;
    el.appendChild(h('ul', { class: 'settings-list' }, [
      h('li', null, '基準與本輪的輸入（收集檔、命名規則、拓樸圖的位置）：重新開啟頁面時還原。'),
      h('li', null, '處理紀錄：跨輪保留；匯出與匯入在資料中心。'),
      h('li', null, '載入過的命名規則、配色與預設版面。'),
    ]));
    el.appendChild(h('div', { class: 'settings-action' }, [
      h('button', { type: 'button', id: 'btn-clear', class: 'danger', 'data-settings-focus': 'clear', disabled: !has || null,
        title: '清除這個工具儲存的基準與輸入（會先確認）', onclick: () => App.clearBaseline() }, '清除基準…'),
      h('span', { class: 'muted' }, has ? '清除目前的基準與輸入；處理紀錄保留。' : '目前沒有基準。'),
    ]));
  }

  V.settings = V.settings || {};
  V.settings.data = { render };
})(globalThis.SSOT = globalThis.SSOT || {});
