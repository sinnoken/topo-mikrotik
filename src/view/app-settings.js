/*
 * 設定（頁首的 ⚙）：和資料中心同一種蓋住主畫面的另一層（同一格，畫布大小不變），兩者互斥。
 * 左側是分類（tablist，↑↓／←→、Home、End 切換），右側是這個分類的內容。這裡只負責外殼：開關、分類切換、焦點與重繪；
 * 各分類的內容在 panels/settings-<分類>.js，以 V.settings.<分類> = { render(App, el) } 掛上，el 是空的容器，標題與說明由這裡畫。
 * 設定的檢視狀態（是否開啟、開啟它的按鈕、目前的分類）只在記憶體，不進基準也不存進 store；設定的值各自經過既有的函式存檔
 * （配色 A.setThemePref → S.store.theme，預設版面 A.setLayoutMode → store 的 'layoutMode'）。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = V.app; const App = window.App;
  V.settings = V.settings || {};

  /** 分類（順序就是左側的順序）：id 也是 V.settings 的名稱與 panels/settings-<id>.js 的檔名；desc 是內容標題下的一句說明 */
  const SECTIONS = [
    { id: 'general', label: '一般', desc: '配色與拓樸圖的預設版面；只存在這個瀏覽器。' },
    { id: 'profiles', label: '命名規則', desc: '命名規則只依名稱加上站點、角色等註解，不會新增、刪除或改寫收集到的事實。' },
    { id: 'data', label: '本機資料', desc: '這個工具存在瀏覽器裡的資料；不會傳到任何地方。' },
    { id: 'help', label: '收集與建立基準', desc: '從收集設備輸出、建立基準到排程與一輪的流程，各步驟用的工具與做法。' },
    { id: 'about', label: '關於', desc: '' },
  ];
  A.SETTINGS_SECTIONS = SECTIONS.map((s) => s.id);
  const sectionOf = (id) => SECTIONS.find((s) => s.id === id);

  /**
   * 檢視狀態：
   *   open     是否開啟
   *   opener   開啟它的按鈕；鍵盤關閉時焦點回到它，null 時回到頁首的 ⚙
   *   section  目前的分類（關閉後保留，下次開啟回到同一個分類）
   */
  const st = { open: false, opener: null, section: 'general' };
  A.settingsOpen = () => st.open;
  A.settingsSection = () => st.section;

  // ================================================================ 開關
  A.bindSettings = function bindSettings() {
    $('#btn-settings').onclick = () => (st.open ? A.closeSettings({ focus: true }) : App.openSettings());
    // Esc 的先後由 A.onEscape（app.js）決定：設定在選單、路由追蹤、資料中心之後，抽屜之前（設定與資料中心互斥）
    A.onEscape('settings', (e) => {
      if (!st.open) return false;
      // 只處理設定內（或 ⚙、沒有焦點時）的 Esc：頁首的搜尋用 Esc 收起自己
      const root = $('#settings'); const t = e.target;
      if (t && t !== document.body && t !== $('#btn-settings') && root.contains && !root.contains(t)) return false;
      if (['#dlg-input', '#dlg-raw'].some((s) => $(s) && $(s).open)) return false; // 對話框先關
      A.closeSettings({ focus: true }); return true;
    });
  };
  /**
   * 開啟設定。section 是要顯示的分類（A.SETTINGS_SECTIONS 之一），省略時回到上次的分類並聚焦「設定」標題；有給時聚焦該分類的標題。
   * opt.opener 是開啟它的按鈕：用鍵盤關閉時焦點回到它，沒有時回到頁首的 ⚙。資料中心開著時先關閉（兩者互斥）。
   */
  App.openSettings = function (section, opt) {
    if (section && !sectionOf(section)) throw new RangeError('未知的設定分類：' + section);
    const opener = (opt && opt.opener) || (st.open ? st.opener : null);
    A.closeHub(); A.closeMenus(); A.closeTrace(false); // closeHub 也會關掉已開的設定（重新開啟時沿用 opener）
    st.open = true; st.opener = opener; if (section) st.section = section;
    $('#settings').classList.remove('hidden'); $('#app').classList.add('settings-open');
    // 和資料中心一樣：主畫面不可聚焦，鍵盤只在設定內移動
    $('#main').inert = true; $('#mobile-workspaces').inert = true;
    $('#btn-settings').setAttribute('aria-expanded', 'true'); $('#btn-settings').classList.add('on');
    render();
    // 從頂端開始、聚焦時不捲動：捲到分類標題會把左側（窄螢幕是上方）的分類列推出頁首
    $('#settings').scrollTop = 0;
    const target = $(section ? '#settings-panel-title' : '#settings-title');
    if (target) target.focus({ preventScroll: true });
  };
  /** 關閉設定；opt.focus 為 true 時焦點回到開啟它的按鈕或頁首的 ⚙（鍵盤關閉時） */
  A.closeSettings = function closeSettings(opt) {
    if (!st.open) return;
    st.open = false;
    const back = st.opener || $('#btn-settings'); st.opener = null;
    $('#settings').classList.add('hidden'); $('#app').classList.remove('settings-open');
    $('#main').inert = false; $('#mobile-workspaces').inert = false;
    $('#btn-settings').setAttribute('aria-expanded', 'false'); $('#btn-settings').classList.remove('on');
    V.clear($('#settings'));
    if (opt && opt.focus) back.focus();
  };
  /** 換分類（左側的分頁）；focus 為 true 時焦點移到新的分頁（鍵盤切換時） */
  A.showSettingsSection = function showSettingsSection(id, focus) {
    if (!sectionOf(id)) throw new RangeError('未知的設定分類：' + id);
    st.section = id;
    if (!st.open) return;
    render();
    if (focus) { const tab = $('#settings-tab-' + id); if (tab) tab.focus(); }
  };

  // ================================================================ 畫面
  /** 分頁的鍵盤操作（WAI-ARIA tabs，自動啟用）：直排時 ↑↓，窄螢幕橫排時 ←→，兩組都可以用；Home、End 到頭尾 */
  function onTabKey(e, i) {
    const n = SECTIONS.length;
    const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    A.showSettingsSection(SECTIONS[(to + n) % n].id, true);
  }
  /** 目前分類的內容：panels/settings-<id>.js 沒有載入時明確說明（不留空白） */
  function panelBody(App, id) {
    const el = h('div', { class: 'settings-content' });
    const p = V.settings[id];
    if (p && typeof p.render === 'function') p.render(App, el);
    else el.appendChild(h('p', { class: 'warn-line' }, `這個分類的內容沒有載入（src/view/panels/settings-${id}.js）。`));
    return el;
  }
  /**
   * 重繪（開啟、換分類、A.renderAll 時）：每次重建內容；有 data-settings-focus 的元素重繪後焦點回到同一個元素，
   * 鍵盤操作不會跳回開頭（同資料中心的 data-hub-focus）。關閉時不畫。
   */
  function render() {
    const root = $('#settings'); if (!root || !st.open) return;
    const ae = document.activeElement;
    const focusKey = ae && ae.getAttribute && root.contains(ae) ? ae.getAttribute('data-settings-focus') : null;
    const cur = sectionOf(st.section);
    V.clear(root);
    const tabs = SECTIONS.map((s, i) => {
      const on = s.id === cur.id;
      const b = h('button', { type: 'button', role: 'tab', id: 'settings-tab-' + s.id, class: 'settings-tab' + (on ? ' on' : ''), 'data-section': s.id,
        'aria-selected': String(on), 'aria-controls': 'settings-panel', tabindex: on ? '0' : '-1' }, s.label);
      b.addEventListener('click', () => A.showSettingsSection(s.id, true));
      b.addEventListener('keydown', (e) => onTabKey(e, i));
      return b;
    });
    root.appendChild(h('div', { class: 'settings-inner' }, [
      h('div', { class: 'settings-head' }, [
        h('h1', { id: 'settings-title', tabindex: '-1' }, '設定'),
        h('span', { class: 'muted' }, '設定只存在這個瀏覽器，不會傳到任何地方'),
        h('span', { class: 'hub-spacer' }),
        h('button', { type: 'button', class: 'ghost settings-close', 'data-settings-focus': 'close', title: '關閉設定（Esc）', 'aria-keyshortcuts': 'Escape',
          onclick: () => A.closeSettings({ focus: true }) }, '關閉'),
      ]),
      h('div', { class: 'settings-body' }, [
        h('nav', { class: 'settings-nav', 'aria-label': '設定的分類' }, h('div', { role: 'tablist', 'aria-label': '設定的分類', 'aria-orientation': 'vertical', class: 'settings-tabs' }, tabs)),
        h('section', { id: 'settings-panel', class: 'settings-panel', role: 'tabpanel', 'aria-labelledby': 'settings-tab-' + cur.id, 'data-section': cur.id }, [
          h('h2', { id: 'settings-panel-title', tabindex: '-1' }, cur.label),
          cur.desc ? h('p', { class: 'muted settings-desc' }, cur.desc) : null,
          panelBody(App, cur.id),
        ]),
      ]),
    ]));
    A.syncSettingsControls();
    if (focusKey) {
      const el = ['button', 'input', 'select'].flatMap((t) => Array.from(root.querySelectorAll(t))).find((x) => x.getAttribute('data-settings-focus') === focusKey && !x.disabled);
      if (el) el.focus(); else { const t = $('#settings-panel-title'); if (t) t.focus(); }
    }
  }
  A.renderSettings = render;
  /**
   * 設定裡的單選跟著目前的值（偏好在別處改變時，例如工具列的「版面 ▾」）：class settings-radio 的 input，
   * data-setting 是哪一個設定（theme、layout），value 是選項。設定沒開時沒有元素，什麼都不做
   */
  A.syncSettingsControls = function syncSettingsControls() {
    const root = $('#settings'); if (!root) return;
    const now = { theme: A.themePref ? A.themePref() : null, layout: App.layoutMode };
    root.querySelectorAll('.settings-radio').forEach((r) => { r.checked = r.value === now[r.getAttribute('data-setting')]; });
  };
})(globalThis.SSOT = globalThis.SSOT || {});
