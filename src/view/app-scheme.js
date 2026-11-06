/*
 * 配色：跟隨系統、淺色、深色的偏好與套用（入口在設定「一般」，app-settings.js），減少動態效果的偏好，
 * 以及匯出時暫時換配色的 A.withScheme（PNG 匯出用，app-legend.js）。圖例的重建在 app-legend.js（A.rebuildLegend）。
 * index.html 的 inline script 在首次繪製前呼叫 A.paintScheme，所以這個檔要在那段 script 之前載入。
 */
(function (S) {
  'use strict';
  const V = S.view;
  const A = V.app; const App = window.App;

  /** 使用者的「減少動態效果」偏好（瀏覽器沒有 matchMedia 時視為沒有偏好） */
  A.reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ================================================================ 配色（跟隨系統、淺色、深色）
  // 偏好（S.store.theme：system／light／dark）由設定「一般」的「配色」切換。實際的深淺（theme.mode）同時寫到 <html data-theme>，
  // CSS 只跟著這個屬性（深色變數只寫一份，不另寫 prefers-color-scheme 的複本）；跟隨系統時由這裡的 matchMedia 決定。
  // 首次繪製前 index.html 的 inline script 先呼叫 A.paintScheme 設好屬性，CSS 不閃。強制色彩模式（forced-colors）由 CSS 處理，與這裡無關。
  const SCHEME_QUERY = '(prefers-color-scheme: dark)';
  let schemeBound = false; let schemePref = 'system';
  /** 系統目前是深色（沒有 matchMedia 時視為淺色） */
  const systemDark = () => typeof window.matchMedia === 'function' && !!window.matchMedia(SCHEME_QUERY).matches;
  /** 偏好 → 實際的深淺 */
  A.resolveScheme = (pref) => (pref === 'light' || pref === 'dark' ? pref : systemDark() ? 'dark' : 'light');
  /** CSS 的深淺：<html data-theme>，與 theme.mode 一致 */
  const setSchemeAttr = (mode) => document.documentElement.setAttribute('data-theme', mode);
  /** 首次繪製前（index.html 的 inline script）：依儲存的偏好設好 CSS 的深淺；theme（Canvas）等啟動時的 A.bindColorScheme */
  A.paintScheme = function paintScheme() { setSchemeAttr(A.resolveScheme(S.store.theme.get())); };
  /** 目前的配色偏好（system／light／dark） */
  A.themePref = () => schemePref;
  /** 設定「一般」的配色單選跟著偏好（設定開著時；關著時下次開啟才畫，畫的時候讀 A.themePref） */
  const syncThemeMenu = () => A.syncSettingsControls();
  /**
   * 換配色偏好：存進 store、更新選單、套用（跟隨系統時套用系統目前的深淺）。
   * 存不進去時這次仍套用，並以通知說明關閉頁面後不會保留（不靜默）。
   */
  A.setThemePref = function setThemePref(pref) {
    if (!S.store.theme.VALUES.includes(pref)) throw new RangeError('未知的配色偏好：' + pref);
    schemePref = pref;
    const saved = S.store.theme.set(pref);
    syncThemeMenu(); A.applyColorScheme(A.resolveScheme(pref));
    if (!saved) A.banner('這個瀏覽器無法保存配色設定：這次有效，關閉頁面後不會保留。', 8000);
  };
  /**
   * 圖上存下的顏色（終端的廠商色、選取與高亮的標示、路由追蹤的疊加線）換成目前 theme 的值。
   * 標示的顏色都取自 theme.mark，同一組的值互不相同（有測試），所以可依「舊值 → 新值」換算，不必重新計算選取。
   */
  function recolorGraph(from, to) {
    A.recolorVendors();
    const g = App.graph; if (!g) return;
    const map = new Map(Object.keys(from.mark).map((k) => [from.mark[k], to.mark[k]]));
    const swap = (m) => { if (m) m.forEach((c, k) => { if (typeof c === 'string' && map.has(c)) m.set(k, map.get(c)); }); };
    if (g.hl) { swap(g.hl.nodes); swap(g.hl.edges); }
    g.overlay.forEach((o) => { if (map.has(o.color)) o.color = map.get(o.color); });
    g.redraw();
  }
  /** 套用配色並更新所有由 theme 產生的畫面：拓樸圖、圖例、面板（防火牆、L4、基準比對、收斂趨勢）。回傳是否有改變 */
  A.applyColorScheme = function applyColorScheme(mode) {
    const T = V.theme;
    if (!T.palettes[mode]) throw new RangeError('未知的配色：' + mode);
    // CSS 一律跟著（首次繪製前設的屬性可能和 theme 還沒套用的亮色不同）
    setSchemeAttr(mode);
    if (T.mode === mode) return false;
    const from = T.palettes[T.mode]; T.apply(mode);
    recolorGraph(from, T.palettes[mode]);
    A.rebuildLegend();
    // 只重畫在渲染時從 theme 讀 inline 顏色的面板（詳情含防火牆、收斂趨勢、工作畫面的修正計畫與基準比對）；
    // 左側清單不用 theme 的顏色，不重建，打到一半的處理紀錄（備註、豁免原因）與焦點才不會消失。沒有基準時只有歡迎畫面（CSS）
    if (App.snap) { V.details.render(App, App.sel); V.ledgerPane.render(App); A.renderCenter(); }
    // L4 的矩陣格子以 inline 顏色畫在畫布上方，不在 renderCenter 裡：重畫一次（用已算好的結果，不重算）
    if (App.snap && App.layer === 'l4') App.l4Job = V.l4.show(App, { rebuild: false });
    return true;
  };
  /**
   * 讀回配色偏好並套用，監聽系統深淺的 change（只在偏好是跟隨系統時套用）。監聽只綁一次（再呼叫回傳 false）。
   * 偏好是淺色或深色時直接固定該配色。跟隨系統而瀏覽器沒有 matchMedia（例如測試的模擬 DOM）時維持亮色、回傳 false；
   * matchMedia 沒有監聽 API 時也維持亮色、回傳 false，以 console.warn 與通知告知，不中止啟動（這在啟動流程中、其他 bind 之前）。
   */
  A.bindColorScheme = function bindColorScheme() {
    if (schemeBound) return false;
    schemePref = S.store.theme.get(); syncThemeMenu();
    const fixed = schemePref !== 'system';
    if (typeof window.matchMedia !== 'function') { A.applyColorScheme(fixed ? schemePref : 'light'); return false; }
    const mq = window.matchMedia(SCHEME_QUERY);
    const onChange = (e) => { if (schemePref === 'system') A.applyColorScheme(e.matches ? 'dark' : 'light'); };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onChange); // Safari 13 以前
    else {
      A.applyColorScheme(fixed ? schemePref : 'light');
      const msg = '這個瀏覽器無法偵測系統深淺的變更，跟隨系統時畫面維持亮色（可在「設定」的「一般」改成固定的淺色或深色）。';
      console.warn(msg); if (!fixed) A.banner(msg, 8000); return false;
    }
    schemeBound = true;
    A.applyColorScheme(fixed ? schemePref : mq.matches ? 'dark' : 'light');
    return true;
  };
  /** 匯出時暫時換成 mode 的配色（含圖上存下的顏色），fn 結束後一定還原 */
  A.withScheme = function withScheme(mode, fn) {
    const T = V.theme; const prev = T.mode;
    if (prev === mode) return fn();
    // 換色也在 try 內：換色途中失敗時同樣還原成目前的深淺
    try { T.apply(mode); recolorGraph(T.palettes[prev], T.palettes[mode]); return fn(); } finally { T.apply(prev); recolorGraph(T.palettes[mode], T.palettes[prev]); App.graph.draw(); }
  };
})(globalThis.SSOT = globalThis.SSOT || {});
