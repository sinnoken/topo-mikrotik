/*
 * 設定「收集與建立基準」（外殼在 app-settings.js）：給第一次用的人一頁看懂整個流程——一輪的流程、收集（收集腳本與手動）、
 * 建立基準、排程（CLI）。畫面只放要點，詳細規格以「詳見」連到文件（ADR-016），不在這裡另寫一份。
 * 指令清單取自 A.collectGuide（S.collectCommands，由 tools/collector-commands.sh 產生），整個畫面只在這裡出現一次（歡迎畫面以按鈕開啟這個分類）。
 * devices.csv 範例的每一列都取自 tools/devices.csv（冒煙測試核對），格式以 tools/collect.sh 的 --help 為準。
 * 文件連結（V.settings.docLink）也給「關於」與「命名規則」用：文件不隨網站發布（deploy-pages.yml 只發布畫面需要的檔案），所以線上連到 GitHub 上的 main；
 * 從 file:// 開啟時改連 repo 內的相對路徑（離線打得開）。連結是使用者點了才開新分頁，不是執行期的網路請求。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h;
  const A = () => V.app;

  const REPO = 'https://github.com/sinnoken/topo-mikrotik';
  /** 頁面是不是從 file:// 開啟（離線，通常就是 repo 裡的 index.html）；每次產生連結時讀，不快取 */
  const isFileProtocol = () => typeof location !== 'undefined' && !!location && location.protocol === 'file:';
  /**
   * 連到 repo 裡的文件（file 是 repo 內的路徑，anchor 是 GitHub 依標題產生的錨點），新分頁開啟。
   * 線上連到 GitHub 的 main；從 file:// 開啟時連到相對路徑（index.html 在 repo 根目錄，所以 repo 內的路徑就是相對路徑），離線也打得開、內容和正在用的版本相同
   */
  function docLink(file, anchor, label) {
    const href = (isFileProtocol() ? '' : REPO + '/blob/main/') + encodeURI(file) + (anchor ? '#' + encodeURI(anchor) : '');
    return h('a', { class: 'link doc-link', href, target: '_blank', rel: 'noopener noreferrer', title: file }, label);
  }
  /** 「詳見」一行：links 是 docLink 的結果 */
  const seeAlso = (links) => h('p', { class: 'settings-note muted' }, ['詳見 ', ...links.flatMap((a, i) => [i ? '、' : '', a]), '。']);
  const step = (title, children) => h('section', { class: 'settings-group settings-step' }, [h('h3', null, title), ...children]);
  const pre = (text, label, id) => h('pre', { class: 'cmd-list', id: id || null, tabindex: '0', 'aria-label': label }, text);

  const DEVICES_CSV = ['name,address,user,port,extra', 'TPE_CORE_RT_01,192.0.2.2,admin,22', 'TPE_AP_01,192.0.2.31,admin,22,wifi'].join('\n');
  const COLLECT_OPTIONS = [
    ['--dry-run', '只驗證設備清單並列出要執行的指令，不連線'],
    ['--device NAME', '只收集指定的設備'],
    ['--commands ID,…', '只執行指定的命令（例如只收防火牆）'],
    ['--timeout 秒數、--retry 次數', '單一指令的逾時與失敗後的重試'],
    ['--ask-password', '沒有 SSH key 的設備：每台連線一次，手動輸入密碼'],
    ['--retry-failed 上次.txt -o 新檔.txt', '只重收上次收集檔中失敗的指令'],
  ];

  function flow() {
    return step('一輪的流程', [
      h('ol', { class: 'settings-list settings-flow' }, [
        h('li', null, '收集：用收集腳本或手動，把每台設備的輸出合併成一個收集檔（見下方「1. 收集」）。'),
        h('li', null, '建立基準：貼上或選擇收集檔，產生本輪的基準（見「2. 建立基準」）。'),
        h('li', null, '研判：在「研判」看檢查結果，標為已排定修正、接受風險或誤報（處理紀錄）。'),
        h('li', null, '修正：在「修正」產生每台設備的 .rsc（套用、回復、驗證）。本工具只產生文字，不會連線設備，由你自行套用。'),
        h('li', null, '下一輪收集：套用後重新收集，再建立一次基準。'),
        h('li', null, '驗證：在「驗證」看哪些已修好、哪些復發，以及改善趨勢。'),
      ]),
      h('p', null, '工作包：資料中心的「匯出本輪工作包（ZIP）」把收集檔、基準、處理紀錄、命名規則、預期現況、報表與 patch 帶走；下一輪讀回工作包，就帶回上一輪的基準與處理紀錄，接著比對。'),
      seeAlso([docLink('docs/使用說明.md', '一輪的流程', '使用說明「一輪的流程」'), docLink('docs/使用說明.md', '輸入資料中心', '「輸入（資料中心）」')]),
    ]);
  }

  function collect() {
    const g = A().collectGuide();
    const status = h('span', { class: 'muted', role: 'status', id: 'settings-copy-status' });
    return step('1. 收集', [
      h('p', null, [h('b', null, '推薦：收集腳本 '), h('code', null, 'tools/collect.sh'),
        '。在 WSL／Linux 用系統的 ssh 與既有的 SSH key／agent 逐台執行唯讀指令，不在瀏覽器裡連線，也不儲存密碼。需要 Bash、GNU timeout 與 OpenSSH client；先用 ',
        h('code', null, 'ssh 帳號@位址'), ' 確認可以免互動登入。']),
      h('p', null, ['設備清單 ', h('code', null, 'devices.csv'), ' 每列是 ', h('code', null, 'name,address,user,port[,extra]'),
        '：port 預設 22；extra 是選用命令（wifi、wireless、capsman、vrf），留空時依介面類型與版本自動加上。']),
      pre(DEVICES_CSV, 'devices.csv 範例', 'settings-devices-csv'),
      pre(['cp tools/devices.csv devices.csv            # 改成自己的設備清單', './tools/collect.sh devices.csv --dry-run', './tools/collect.sh devices.csv --output collection.txt'].join('\n'), '收集腳本的用法'),
      h('div', null, [h('div', null, '常用選項：'), h('ul', { class: 'settings-list' }, COLLECT_OPTIONS.map(([o, t]) => h('li', null, [h('code', null, o), '：' + t])))]),
      h('p', null, ['輸出是一個 ', h('code', null, 'bundle-v1'), ' 收集檔：每個指令前寫收集時間，失敗的指令寫下原因（建立基準後列在 C02 與覆蓋率）。有設備失敗時腳本以非零結束碼結束，請看終端機的失敗摘要。']),
      h('p', null, [h('b', null, '手動：'), '在每台設備的終端機執行下列指令，把輸出存成一個檔案，每台設備前加一行「設備名 (管理 IP):」。格式範例在「建立基準」對話框的「格式說明」。']),
      pre(g.error || g.list, '收集指令清單', 'settings-commands'),
      h('div', { class: 'form-row' }, [
        h('button', { type: 'button', 'data-settings-focus': 'copy-commands', disabled: !!g.error || null, onclick: () => A().copyText(g.list, status) }, '複製指令清單'), status]),
      g.optional ? h('p', { class: 'muted' }, g.optional) : null,
      seeAlso([docLink('README.md', '快速開始', 'README「快速開始」'),
        docLink('docs/收集清單與輸入格式.md', '0-批次-ssh-收集器wsllinux', '收集清單 §0 收集腳本'),
        docLink('docs/收集清單與輸入格式.md', '1-每台設備要收集的指令', '§1 收集的指令'),
        docLink('docs/收集清單與輸入格式.md', '2-收集檔格式bundle-v1', '§2 收集檔格式')]),
    ]);
  }

  function build(App) {
    return step('2. 建立基準', [
      h('ul', { class: 'settings-list' }, [
        h('li', null, '貼上或選擇檔案：按「建立基準…」，貼上收集檔的內容，或選擇、拖放檔案（可以多個）。'),
        h('li', null, '預檢：建立前就列出認到幾台設備、幾個指令區塊與無法辨識的段落；沒有認到任何設備時不能建立。'),
        h('li', null, ['命名規則：依設備名加上站點、角色等註解，不改寫收集到的事實；在對話框選擇，可用的命名規則見 ',
          h('button', { type: 'button', class: 'ghost', 'data-settings-focus': 'to-profiles', onclick: () => A().showSettingsSection('profiles', true) }, '命名規則'), '。']),
        h('li', null, ['各類設備應收資料：每類設備應有哪些資料（不給時用內建的一份），缺少時列為 C02 與覆蓋率的缺漏；畫面上目前只會由工作包帶回，排程用 ', h('code', null, '--expected-data'), '。']),
      ]),
      h('div', { class: 'row' }, [
        h('button', { type: 'button', class: 'primary', 'data-settings-focus': 'open-input', onclick: () => App.openInput() }, '建立基準…'),
        h('button', { type: 'button', 'data-settings-focus': 'sample', onclick: () => { A().closeSettings(); App.loadSample(); } }, '用範例資料試試看'),
      ]),
      seeAlso([docLink('docs/使用說明.md', '輸入資料中心', '使用說明「輸入（資料中心）」'),
        docLink('docs/收集清單與輸入格式.md', '3-設備名稱必須對得起來', '收集清單 §3 設備名稱'),
        docLink('docs/命名規則.md', null, '命名規則')]),
    ]);
  }

  /** 輸出清單與結束碼的文字與 tools/baseline.js 的 FILES、--help 一致（瀏覽器無法載入 CLI，由 tests/ui-smoke.js 核對） */
  function schedule() {
    return step('3. 排程（CLI）', [
      h('p', null, [h('code', null, 'tools/baseline.js'), ' 用和網頁相同的核心建立基準並推進處理紀錄，只讀檔案、不連線設備（需要 Node.js）。適合在收集腳本之後放進 cron 或 Windows 的工作排程器定期執行。']),
      pre(['npm run baseline -- collection.txt -o out/                          # 第一次：從空的處理紀錄開始',
        'npm run baseline -- collection.txt --ledger out/ledger.json -o out/  # 之後每一輪：傳入上一輪的處理紀錄'].join('\n'), '排程的指令'),
      h('p', null, ['輸出到 ', h('code', null, 'out/'), '：基準 baseline.json、處理紀錄 ledger.json（可在資料中心匯入）、檢查結果 findings.json／findings.csv／findings.md、網路文件 sitedoc.md／sitedoc.csv、摘要 summary.json；有 ',
        h('code', null, '--expected'), ' 時另有比對結果 compare.json。']),
      h('div', null, '結束碼：'),
      h('dl', { class: 'settings-about settings-exit' }, [
        h('dt', { class: 'mono' }, '0'), h('dd', null, '成功，沒有復發，也沒有新的待處理錯誤／警告'),
        h('dt', { class: 'mono' }, '1'), h('dd', null, '成功，但有復發、新出現或豁免到期的待處理錯誤／警告（排程據此通知）'),
        h('dt', { class: 'mono' }, '2'), h('dd', null, '執行失敗（參數錯誤、輸入讀不到、收集檔沒有認到任何設備的資料、檔案格式錯誤）；訊息寫到 stderr，不輸出任何檔案'),
      ]),
      seeAlso([docLink('README.md', '排程執行cli', 'README「排程執行（CLI）」')]),
    ]);
  }

  function render(App, el) {
    [flow(), collect(), build(App), schedule()].forEach((x) => el.appendChild(x));
  }

  V.settings = V.settings || {};
  V.settings.help = { render };
  V.settings.docLink = docLink;
  V.settings.REPO = REPO;
})(globalThis.SSOT = globalThis.SSOT || {});
