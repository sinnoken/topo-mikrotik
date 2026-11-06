/*
 * 設定「一般」（外殼在 app-settings.js）：配色（跟隨系統／淺色／深色）與拓樸圖的預設版面（分層／快速）。
 * 只排版與接上既有的函式：配色經 A.setThemePref（存進 S.store.theme），版面經 A.setLayoutMode（store 的 'layoutMode'）。
 * 單選是原生的 radio（方向鍵在同一組內移動），目前的值由 A.syncSettingsControls 依 data-setting 勾選。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h;
  const A = () => V.app;

  /** 配色偏好的名稱與說明（值取自 S.store.theme.VALUES；少了說明時以值本身顯示，不會漏掉選項） */
  const SCHEME = {
    system: ['跟隨系統', '依作業系統的淺色／深色設定（預設）'],
    light: ['淺色', '固定淺色，不跟系統'],
    dark: ['深色', '固定深色，不跟系統'],
  };
  const LAYOUT = {
    elk: ['分層（ELK）', '依分群與層級排列，適合看上下游（預設）'],
    builtin: ['快速（內建）', '馬上排好，不另外載入版面引擎'],
  };

  /**
   * 一組單選：fieldset＋legend 是組名，每個選項是 label 包著 radio 與文字；說明一律在名稱的下一行（換行固定，
   * 不依說明長短一下在右邊、一下在下一行）
   */
  function radios(setting, legend, values, names, onPick, note) {
    return h('fieldset', { class: 'settings-group', 'data-setting': setting }, [
      h('legend', null, legend),
      ...values.map((v) => {
        const [label, tip] = names[v] || [v, ''];
        const r = h('input', { type: 'radio', name: 'settings-' + setting, value: v, class: 'settings-radio', 'data-setting': setting, 'data-settings-focus': setting + '-' + v });
        r.addEventListener('change', () => { if (r.checked !== false) onPick(v); });
        return h('label', { class: 'settings-option' }, [r, h('span', { class: 'settings-option-text' }, [h('span', { class: 'settings-option-name' }, label),
          ...(tip ? [h('br'), h('span', { class: 'muted settings-option-tip' }, tip)] : [])])]);
      }),
      note ? h('p', { class: 'muted settings-note' }, note) : null,
    ]);
  }

  function render(App, el) {
    el.appendChild(radios('theme', '配色', S.store.theme.VALUES, SCHEME, (v) => A().setThemePref(v),
      '匯出的 PNG 一律用淺色（多半貼進報告或列印）。'));
    el.appendChild(radios('layout', '預設版面', App.LAYOUT_MODES, LAYOUT, (v) => A().setLayoutMode(v),
      `建立基準時與按「重新排列」時使用；工具列「版面 ▾」選的也會成為預設。改了不會重新排列目前的圖。網路設備超過 ${V.num(App.ELK_MAX)} 台時一律用快速版面。`));
  }

  V.settings = V.settings || {};
  V.settings.general = { render };
})(globalThis.SSOT = globalThis.SSOT || {});
