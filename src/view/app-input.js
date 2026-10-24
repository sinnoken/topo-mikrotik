/*
 * 輸入對話框與建立基準：貼上／選擇／拖放檔案、命名規則選單、建立進度，完成後載入並存入 store。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = V.app; const App = window.App;

  const input = { files: [] };
  A.bindInputDialog = function bindInputDialog() {
    const dlg = $('#dlg-input');
    $('#input-close').onclick = () => dlg.close();
    $('#input-file').onchange = (e) => addFiles(e.target.files);
    $('#input-pick').onclick = () => $('#input-file').click();
    $('#input-sample').onclick = () => { $('#input-text').value = S.samples['sample-bundle.txt']; input.files = []; renderFiles(); };
    const drop = $('#input-drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
    $('#input-profile').onchange = async (e) => {
      if (e.target.value !== '__file') return;
      const f = await pickFile('.json,application/json'); if (!f) { e.target.value = ''; return; }
      try {
        const j = JSON.parse(await f.text()); S.profile.compile(j); S.profiles[j.id] = j;
        const saved = (await S.store.get('profiles')) || {}; saved[j.id] = j; await S.store.set('profiles', saved);
        fillProfiles(j.id);
      } catch (err) { alert(err.message); e.target.value = ''; }
    };
    $('#input-build').onclick = runBuild;
  };
  function pickFile(accept) { return new Promise((res) => { const i = h('input', { type: 'file', accept, onchange: () => res(i.files[0] || null) }); i.click(); }); }
  async function addFiles(list) {
    for (const f of Array.from(list)) input.files.push({ name: f.name, text: await f.text() });
    renderFiles();
  }
  function renderFiles() {
    const box = V.clear($('#input-files'));
    input.files.forEach((f, i) => box.appendChild(V.chip(`${f.name}（${V.num(f.text.length)} 字元）  ✕`, '', {
      title: '點一下移除', onclick: () => { input.files.splice(i, 1); renderFiles(); },
    })));
  }
  async function fillProfiles(selected) {
    const saved = (await S.store.get('profiles').catch(() => null)) || {};
    Object.assign(S.profiles, saved);
    const sel = V.clear($('#input-profile'));
    sel.appendChild(h('option', { value: '' }, '不套用（只依收集的資料判斷）'));
    Object.values(S.profiles).filter((p) => p && p.id).forEach((p) => sel.appendChild(h('option', { value: p.id }, `${p.id}${p.label ? '：' + p.label : ''}`)));
    sel.appendChild(h('option', { value: '__file' }, '載入命名規則檔（JSON）…'));
    sel.value = selected || '';
  }
  A.openInput = async function openInput() {
    const pasted = App.sources.find((s) => s.name === S.readers.PASTE);
    $('#input-text').value = pasted ? pasted.text : '';
    input.files = App.sources.filter((s) => s.name !== S.readers.PASTE).map((s) => ({ ...s }));
    renderFiles(); await fillProfiles(App.profileJson ? App.profileJson.id : '');
    $('#input-progress').classList.add('hidden'); $('#input-status').textContent = '';
    $('#dlg-input').showModal();
  };
  async function runBuild() {
    const text = $('#input-text').value;
    const sources = [];
    if (text.trim()) sources.push({ name: S.readers.PASTE, text });
    input.files.forEach((f) => sources.push({ name: f.name, text: f.text }));
    if (!sources.length) { $('#input-status').textContent = '請貼上收集檔內容，或選擇檔案。'; return; }
    const pid = $('#input-profile').value; const profile = pid && pid !== '__file' ? S.profiles[pid] : null;
    const btn = $('#input-build'); btn.disabled = true;
    const bar = $('#input-progress'); bar.classList.remove('hidden'); const fill = bar.firstElementChild;
    try {
      const snap = await S.buildAsync(sources, { profile }, (p) => {
        $('#input-status').textContent = p.stage + (p.total > 1 ? `（${p.done}/${p.total}）` : '');
        fill.style.width = (p.stage === '完成' ? 100 : p.stage === '一致性檢查' ? 92 : p.stage === '建立模型' ? 80 : 5 + 70 * (p.done / Math.max(p.total, 1))) + '%';
      });
      App.sources = sources; App.profileJson = profile;
      $('#input-status').textContent = '繪製中…';
      await new Promise((r) => setTimeout(r, 0));
      A.load(snap, null);
      await S.store.set('last', { snapshot: snap, sources, profile, positions: Object.fromEntries(App.graph.pos) })
        .catch(() => A.banner('基準太大，無法存入瀏覽器；關閉頁面後需要重新建立。'));
      $('#dlg-input').close();
      const m = App.Q.meta(); const st = m.stats;
      A.banner(`已建立基準：${V.num(st.collected)} 台已收集設備、${V.num(st.links)} 條鏈路；`
        + `錯誤 ${st.findings.error}、警告 ${st.findings.warn}（${(m.timing.ms / 1000).toFixed(1)} 秒）`, 8000);
    } catch (e) {
      $('#input-status').textContent = '建立失敗：' + e.message; console.error(e);
    } finally { btn.disabled = false; }
  }

  App.openInput = A.openInput;
  App.loadSample = async () => { await A.openInput(); $('#input-text').value = S.samples['sample-bundle.txt']; input.files = []; renderFiles(); };
})(globalThis.SSOT = globalThis.SSOT || {});
