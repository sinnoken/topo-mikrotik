/*
 * 設定「關於」（外殼在 app-settings.js）：程式版本、資料格式的版本、離線與唯讀、第三方元件的授權、文件與原始碼。
 * 程式版本是 S.VERSION（沒有基準時也看得到；基準狀態卡的版本是建立那份基準時的版本，兩者意義不同）。
 * 資料格式的版本取自核心的常數（S.SCHEMA、S.ledger.SCHEMA、S.compare.SCHEMA_EXPECTED、S.remediate.SCHEMA、S.workpack.SCHEMA），不另寫字串。
 * 第三方元件只有分層版面用的 ELK.js：路徑取自 V.layout.ELK_SRC（elk-layout.js 的 ENGINE_SRC），不另寫一份。
 * 文件連結用 settings-help.js 的 V.settings.docLink（同一個 repo 位址）。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h;

  /** 資料格式：[名稱, schema]；schema 取自核心 */
  const formats = () => [
    ['基準（Snapshot）', S.SCHEMA],
    ['處理紀錄', S.ledger.SCHEMA],
    ['預期現況', S.compare.SCHEMA_EXPECTED],
    ['修正 patch', S.remediate.SCHEMA],
    ['工作包', S.workpack.SCHEMA],
  ];

  function render(App, el) {
    const dir = String(V.layout.ELK_SRC).replace(/\/[^/]*$/, '');
    const doc = V.settings.docLink;
    el.appendChild(h('dl', { class: 'settings-about' }, [
      h('dt', null, '程式'), h('dd', { id: 'app-version' }, 'RouterOS 網路基準 版本 ' + S.VERSION),
      ...formats().flatMap(([name, schema]) => [h('dt', null, name + '格式'), h('dd', { class: 'mono' }, schema)]),
      h('dt', null, '離線'), h('dd', null, ['全部在這個瀏覽器處理，不會把資料傳到任何地方；可以直接用 file:// 開啟，不需要伺服器。頁面的 Content-Security-Policy 以 ',
        h('code', null, "connect-src 'none'"), ' 禁止網路連線。']),
      h('dt', null, '唯讀'), h('dd', null, '不連線設備，也不改動設備：修正只產生 .rsc 文字，由你自行套用；收集腳本只執行唯讀的 /export 與 print。'),
      h('dt', null, '第三方元件'), h('dd', null, [
        'ELK.js（分層版面，第一次用到時才載入）：Eclipse Public License 2.0（EPL-2.0）。授權全文在 ',
        h('code', null, dir + '/LICENSE.md'), '。']),
      h('dt', null, '文件與原始碼'), h('dd', null, [
        h('a', { class: 'link', href: V.settings.REPO, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub：sinnoken/topo-mikrotik'), '（',
        doc('README.md', null, 'README'), '、', doc('docs/使用說明.md', null, '使用說明'), '、', doc('docs/收集清單與輸入格式.md', null, '收集清單與輸入格式'),
        '、', doc('docs/版本紀錄.md', null, '版本紀錄'), '）。連結在新分頁開啟：線上連到 GitHub 的 main，用 file:// 開啟時直接開啟 repo 裡的檔案。']),
    ]));
  }

  V.settings = V.settings || {};
  V.settings.about = { render };
})(globalThis.SSOT = globalThis.SSOT || {});
