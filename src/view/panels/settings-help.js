/*
 * 設定「收集與建立基準」（外殼在 app-settings.js）：收集方式與指令清單（和歡迎畫面的「怎麼收集？」同一份，
 * 指令取自 A.collectGuide，由 tools/collector-commands.sh 產生），以及建立基準的入口。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h;
  const A = () => V.app;

  function render(App, el) {
    el.appendChild(h('p', null, [h('b', null, '推薦：'), '在 WSL／Linux 執行收集腳本 ', h('code', null, './tools/collect.sh devices.csv --output collection.txt'),
      '，以 SSH 逐台收集並產生收集檔（用法見 README）。']));
    el.appendChild(h('p', null, [h('b', null, '手動：'), '在每台設備的終端機執行下列指令，把輸出存成一個檔案，每台設備前加一行「設備名 (管理 IP):」。格式範例在「建立基準」對話框的「格式說明」。']));
    const g = A().collectGuide();
    const status = h('span', { class: 'muted', role: 'status' });
    el.appendChild(h('pre', { class: 'cmd-list', id: 'settings-commands', tabindex: '0', 'aria-label': '收集指令清單' }, g.error || g.list));
    el.appendChild(h('div', { class: 'form-row' }, [
      h('button', { type: 'button', 'data-settings-focus': 'copy-commands', disabled: !!g.error || null, onclick: () => A().copyText(g.list, status) }, '複製指令清單'), status]));
    if (g.optional) el.appendChild(h('p', { class: 'muted' }, g.optional));
    el.appendChild(h('div', { class: 'row' }, [
      h('button', { type: 'button', class: 'primary', 'data-settings-focus': 'open-input', onclick: () => App.openInput() }, '建立基準…'),
      h('button', { type: 'button', 'data-settings-focus': 'sample', onclick: () => { A().closeSettings(); App.loadSample(); } }, '用範例資料試試看'),
    ]));
  }

  V.settings = V.settings || {};
  V.settings.help = { render };
})(globalThis.SSOT = globalThis.SSOT || {});
