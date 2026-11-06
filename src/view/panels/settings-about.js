/*
 * 設定「關於」（外殼在 app-settings.js）：程式版本與第三方元件的授權。
 * 程式版本是 S.VERSION（沒有基準時也看得到；基準狀態卡的版本是建立那份基準時的版本，兩者意義不同）。
 * 第三方元件只有分層版面用的 ELK.js：路徑取自 V.layout.ELK_SRC（elk-layout.js 的 ENGINE_SRC），不另寫一份。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h;

  function render(App, el) {
    const dir = String(V.layout.ELK_SRC).replace(/\/[^/]*$/, '');
    el.appendChild(h('dl', { class: 'settings-about' }, [
      h('dt', null, '程式'), h('dd', { id: 'app-version' }, 'RouterOS 網路基準 版本 ' + S.VERSION),
      h('dt', null, '基準格式'), h('dd', { class: 'mono' }, S.SCHEMA),
      h('dt', null, '執行方式'), h('dd', null, '全部在這個瀏覽器處理，不連線設備，也不會把資料傳到任何地方。'),
      h('dt', null, '第三方元件'), h('dd', null, [
        'ELK.js（分層版面，第一次用到時才載入）：Eclipse Public License 2.0（EPL-2.0）。授權全文在 ',
        h('code', null, dir + '/LICENSE.md'), '。']),
    ]));
  }

  V.settings = V.settings || {};
  V.settings.about = { render };
})(globalThis.SSOT = globalThis.SSOT || {});
