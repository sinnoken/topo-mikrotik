/*
 * 版面框架：左側分頁、窄螢幕工作區切換、左右欄寬度（拖曳與還原）。
 * 欄寬是檢視狀態，存在 store 的 'layout' 鍵。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = V.app; const App = window.App;

  // 左右欄寬度是檢視狀態：存在獨立的 'layout' 鍵，清除基準時不受影響
  const PANE = { min: 240, centerMin: 320, def: { left: 330, right: 400 } };
  A.bindResizers = async function bindResizers() {
    const main = $('#main'); const sides = { left: $('#left'), right: $('#right') };
    const saved = (await S.store.get('layout').catch(() => null)) || {};
    App.layout = { left: PANE.def.left, right: PANE.def.right };
    const clamp = (side, w) => {
      const other = App.layout[side === 'left' ? 'right' : 'left']; const total = window.innerWidth || Infinity;
      return Math.round(Math.max(PANE.min, Math.min(w, total - other - PANE.centerMin)));
    };
    const apply = () => { main.style.gridTemplateColumns = `${App.layout.left}px 1fr ${App.layout.right}px`; };
    ['left', 'right'].forEach((side) => { if (Number.isFinite(saved[side])) App.layout[side] = clamp(side, saved[side]); });
    apply();
    const persist = () => S.store.set('layout', Object.assign({}, App.layout)).catch(() => {});
    ['left', 'right'].forEach((side) => {
      const grip = h('div', { class: 'grip grip-' + side, title: '拖曳調整寬度，雙擊還原' });
      sides[side].appendChild(grip);
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault(); const x0 = e.clientX; const w0 = App.layout[side];
        const move = (ev) => { App.layout[side] = clamp(side, w0 + (side === 'left' ? 1 : -1) * (ev.clientX - x0)); apply(); };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); grip.classList.remove('on'); persist(); };
        grip.classList.add('on'); document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
      grip.addEventListener('dblclick', () => { App.layout[side] = clamp(side, PANE.def[side]); apply(); persist(); });
    });
  };
  A.bindTabs = function bindTabs() {
    document.querySelectorAll('#left .tabs button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#left .tabs button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('#left .pane').forEach((p) => p.classList.toggle('hidden', p.id !== b.dataset.pane));
    }));
  };
  A.isNarrowScreen = function isNarrowScreen() { return Number(window.innerWidth) <= 900; };
  A.setWorkspace = function setWorkspace(workspace) {
    $('#main').dataset.workspace = workspace;
    document.querySelectorAll('#mobile-workspaces button').forEach((button) => {
      const active = button.dataset.workspace === workspace;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };
  A.bindMobileWorkspaces = function bindMobileWorkspaces() {
    document.querySelectorAll('#mobile-workspaces button').forEach((button) => button.addEventListener('click', () => {
      A.setWorkspace(button.dataset.workspace);
    }));
  };
  A.activatePane = function activatePane(pane) {
    A.closeHub();
    const button = Array.from(document.querySelectorAll('#left .tabs button')).find((item) => item.dataset.pane === pane);
    if (button) button.click();
    A.setWorkspace('checks');
  };
})(globalThis.SSOT = globalThis.SSOT || {});
