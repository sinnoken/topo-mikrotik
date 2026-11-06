/*
 * 輸入對話框與建立基準：貼上／選擇／拖放檔案、命名規則選單、建立前的預檢（S.preflight）、建立進度，完成後載入並存入 store。
 * 也提供收集指令清單（A.collectGuide，取自 S.collectCommands，由 tools/collector-commands.sh 產生；顯示在設定的「收集與建立基準」），
 * 並把歡迎畫面的說明按鈕接到那個分類。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h; const $ = V.$;
  const A = V.app; const App = window.App;

  const input = { files: [] };
  /** 對話框的狀態列（#input-status，role=status）顯示失敗原因；不用 alert（會擋住畫面，也無法被螢幕閱讀器以外的方式重看） */
  function fail(what, e) { console.error(e); $('#input-status').textContent = `${what}：${V.reason(e)}`; }
  /**
   * S.buildAsync 的進度 { stage, done, total } → 文字與百分比（建立基準與資料中心重建工作包的基準共用）。
   * 讀取各區塊佔 5–75%，之後依階段：建立模型 80%、一致性檢查 92%、完成 100%。
   */
  A.buildProgressText = (p) => p.stage + (p.total > 1 ? `（${p.done}/${p.total}）` : '');
  A.buildPercent = (p) => (p.stage === '完成' ? 100 : p.stage === '一致性檢查' ? 92 : p.stage === '建立模型' ? 80 : 5 + 70 * (p.done / Math.max(p.total, 1)));
  A.bindInputDialog = function bindInputDialog() {
    const dlg = $('#dlg-input');
    $('#input-close').onclick = () => dlg.close();
    $('#input-text').addEventListener('input', schedulePreflight);
    bindCollectGuide();
    $('#input-file').onchange = (e) => addFiles(e.target.files);
    $('#input-pick').onclick = () => $('#input-file').click();
    $('#input-sample').onclick = () => { $('#input-text').value = S.samples['sample-bundle.txt']; input.files = []; renderFiles(); };
    const drop = $('#input-drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
    // 命名規則會合併設備名（例如去掉網域），換了就重新預檢
    $('#input-profile').onchange = async (e) => {
      if (e.target.value !== '__file') { runPreflight(); return; }
      const f = await pickFile('.json,application/json'); if (!f) { e.target.value = ''; runPreflight(); return; }
      // 載入命名規則檔只有一份實作（設定的命名規則分類）：驗證、加入清單、存進 store
      const r = await V.settings.profiles.loadFile(f);
      if (r.ok) { await fillProfiles(r.id); $('#input-status').textContent = `已載入命名規則「${r.id}」`; }
      else { $('#input-status').textContent = r.error; e.target.value = ''; }
      runPreflight();
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
    // 已選的檔案：名稱是文字，移除是獨立的按鈕（鍵盤可操作、有名稱）；移除後焦點回到下一個移除鈕或檔案選擇
    input.files.forEach((f, i) => box.appendChild(V.chip([`${f.name}（${V.num(f.text.length)} 字元）`,
      h('button', { type: 'button', class: 'ghost chip-x', 'aria-label': '移除 ' + f.name, title: '移除這個檔案',
        onclick: () => { input.files.splice(i, 1); renderFiles(); const xs = box.querySelectorAll('.chip-x'); const next = xs[Math.min(i, xs.length - 1)] || $('#input-pick'); next.focus(); } },
      h('span', { 'aria-hidden': 'true' }, '✕'))], 'file-chip')));
    runPreflight();
  }
  /** 對話框目前的輸入（貼上的文字在前、檔案依加入順序），建立與預檢共用 */
  function inputSources() {
    const text = $('#input-text').value;
    const sources = [];
    if (text.trim()) sources.push({ name: S.readers.PASTE, text });
    input.files.forEach((f) => sources.push({ name: f.name, text: f.text }));
    return sources;
  }
  function selectedProfile() { const pid = $('#input-profile').value; return pid && pid !== '__file' ? S.profiles[pid] : null; }

  // ---- 建立前的預檢（S.preflight：只切塊、辨識與解析，不建模）：打字時延遲重算，選檔、載入範例、換命名規則時立即重算
  const PREFLIGHT_MS = 400; // 打字停下多久才重算：約 1000 台的收集檔預檢約需數百毫秒，不在每個按鍵都跑
  const LIST_MAX = 200; // 清單最多列出的筆數，其餘只寫總數
  // 輸入的簡短指紋：建立時若輸入在預檢後被改過（例如程式直接寫入文字框、沒有 input 事件），就重新預檢
  const inputSig = (sources, profile) => sources.map((x) => `${x.name}:${x.text.length}:${x.text.slice(0, 64)}:${x.text.slice(-64)}`).join('|') + '|' + (profile ? profile.id : '');
  function schedulePreflight() { clearTimeout(input.pfTimer); input.pfTimer = setTimeout(runPreflight, PREFLIGHT_MS); }
  function runPreflight() {
    clearTimeout(input.pfTimer);
    const sources = inputSources(); const profile = selectedProfile();
    input.sig = inputSig(sources, profile); input.pre = null; input.pfError = null;
    if (sources.length) {
      try { input.pre = S.preflight(sources, { profile }); } catch (e) { input.pfError = V.reason(e); }
    }
    renderPreflight(sources);
    return input.pre;
  }
  function renderPreflight(sources) {
    const box = V.clear($('#input-preflight')); const btn = $('#input-build');
    const block = (why) => { btn.disabled = !!why; btn.title = why || ''; };
    if (!sources.length) { box.appendChild(h('div', { class: 'muted' }, '尚未輸入：貼上收集檔內容，或選擇檔案。')); block('還沒有輸入'); return; }
    // 預檢本身失敗（例如命名規則有誤）不擋建立：建立時會以同樣的錯誤明確回報
    if (input.pfError) { box.appendChild(h('div', { class: 'pf-why' }, '預檢失敗：' + input.pfError)); block(''); return; }
    // 認到＝有資料或收集失敗紀錄（S.query.preflightRecognized，與 CLI、建立後的 Q.recognizedDevices 同一個判斷）；清單仍列出全部，沒有資料的標示出來
    const p = input.pre; const n = S.query.preflightRecognized(p).length; const m = p.unrecognized.length; const k = p.partial.length;
    box.appendChild(h('div', { class: 'pf-head' }, [
      V.chip(`認到 ${V.num(n)} 台設備`, n ? 'ok' : 'err'), V.chip(`${V.num(p.blockCount)} 個指令區塊`),
      V.chip(m ? `${V.num(m)} 段無法辨識` : '沒有無法辨識的段落', m ? 'err' : 'ok'),
      k ? V.chip(`${V.num(k)} 段有認不得的行`, 'warn') : null]));
    if (!n) box.appendChild(h('p', { class: 'pf-why' }, '沒有認到任何設備，無法建立基準：收集檔的每台設備要以「設備名 (管理 IP):」這一行開頭（見上方「格式說明」），或選擇以設備名命名的檔案。'));
    const more = (len) => (len > LIST_MAX ? h('div', { class: 'muted table-more' }, `只顯示前 ${LIST_MAX} 筆，共 ${V.num(len)} 筆`) : null);
    // 位置的寫法與 I01、I03 的訊息相同：段落寫起訖行，收集器註解（kind: 'note'）只有一行
    const at = (u) => `${V.fileName(u.file)} 第 ${u.kind === 'note' ? u.startLine : `${u.startLine}–${u.endLine}`} 行`;
    box.appendChild(h('details', { id: 'input-preflight-list', class: 'collect', open: input.pfOpen || null, ontoggle: (e) => { input.pfOpen = e.target.open; } }, [
      h('summary', null, '查看清單'),
      p.devices.length ? V.table([{ t: '設備', f: (d) => d.name }, { t: '區塊', f: (d) => V.num(d.blocks) },
        { t: '資料種類', f: (d) => h('div', { class: 'chip-list' }, d.dataLabels.length ? d.dataLabels.map((l) => V.chip(l)) : [V.chip('沒有可用的資料', 'err')]) }], p.devices, { limit: LIST_MAX }) : null,
      m ? h('div', null, '無法辨識的段落（建立後列為 I01）') : null,
      m ? h('ul', { class: 'pf-bad' }, p.unrecognized.slice(0, LIST_MAX).map((u) => h('li', null, `${at(u)}：${u.reason}`))) : null,
      m ? more(m) : null,
      k ? h('div', null, '有認不得的行的段落（其餘內容照常建立；建立後列為 I03）') : null,
      k ? h('ul', { class: 'pf-bad' }, p.partial.slice(0, LIST_MAX).map((u) => h('li', null, `${at(u)}（${u.command || '沒有指令標記'}）：${V.num(u.lines)} 行`))) : null,
      k ? more(k) : null]));
    block(n ? '' : '沒有認到任何設備');
  }

  // ---- 收集指令清單（設定的「收集與建立基準」）與格式範例（對話框）
  /** 寫入剪貼簿（V.copyText），結果寫在 status（role=status 元素） */
  async function copyText(text, status) {
    const why = await V.copyText(text);
    status.textContent = why ? `無法自動複製（${why}），請直接選取上面的文字複製` : '已複製';
  }
  A.copyText = copyText;
  /**
   * 收集指令清單（設定的「收集與建立基準」）：{ list（每行一個指令）, optional（只有部分設備才有的選單，DOM） }；
   * 指令清單未載入時是 { error }。指令清單由 tools/collector-commands.sh 產生（samples/collect-commands.js），畫面不另寫一份
   */
  A.collectGuide = function collectGuide() {
    const C = S.collectCommands;
    if (!C) return { error: '指令清單未載入（samples/collect-commands.js）' };
    return {
      list: C.default.map((c) => c.command).join('\n'),
      optional: h('span', null, ['只有部分設備才有的選單（Wi-Fi AP、CAPsMAN 控制器、RouterOS 7 的 VRF）另加：',
        ...C.optional.flatMap((c, n) => [n ? '、' : '', h('code', null, c.command)])]),
    };
  };
  function bindCollectGuide() {
    $('#input-format-copy').onclick = () => copyText($('#input-format-example').textContent, $('#input-format-copy-status'));
  }
  /**
   * 歡迎畫面的三個按鈕（CSP 不放行內嵌事件屬性，在這裡綁定）。歡迎畫面一開始就看得到：init 在第一個 await（讀 store）之前呼叫，
   * 頁面一出現就能按。說明只開啟設定的「收集與建立基準」（指令清單只在那裡出現一次）；關閉設定後焦點回到這個按鈕
   */
  A.bindWelcome = function bindWelcome() {
    const help = $('#welcome-help');
    help.onclick = () => App.openSettings('help', { opener: help });
    $('#welcome-input').onclick = () => App.openInput();
    $('#welcome-sample').onclick = () => App.loadSample();
  };
  async function fillProfiles(selected) {
    const saved = (await S.store.get('profiles').catch(() => null)) || {};
    Object.assign(S.profiles, saved);
    const sel = V.clear($('#input-profile'));
    sel.appendChild(h('option', { value: '' }, '不套用（只依收集的資料判斷）'));
    Object.values(S.profiles).filter((p) => p && p.id).forEach((p) => sel.appendChild(h('option', { value: p.id }, `${p.id}${V.settings.profiles.nameOf(p) ? '：' + V.settings.profiles.nameOf(p) : ''}`)));
    sel.appendChild(h('option', { value: '__file' }, '載入命名規則檔（JSON）…'));
    sel.value = selected || '';
  }
  A.openInput = async function openInput() {
    const pasted = App.sources.find((s) => s.name === S.readers.PASTE);
    $('#input-text').value = pasted ? pasted.text : '';
    input.files = App.sources.filter((s) => s.name !== S.readers.PASTE).map((s) => ({ ...s }));
    await fillProfiles(App.profileJson ? App.profileJson.id : ''); renderFiles();
    // 建立選項 expectedData（目前只會由工作包帶入）：有時才顯示，預設沿用；取消勾選後這次建立不使用
    const xd = App.round.expectedData;
    $('#input-xd-row').classList.toggle('hidden', !xd);
    $('#input-xd').checked = !!xd;
    $('#input-xd-note').textContent = xd ? `（${V.num(Object.keys(xd).length)} 類設備；取消勾選會建立另一份基準）` : '';
    $('#input-progress').classList.add('hidden'); $('#input-status').textContent = '';
    $('#dlg-input').showModal();
  };
  async function runBuild() {
    const sources = inputSources();
    if (!sources.length) { $('#input-status').textContent = '請貼上收集檔內容，或選擇檔案。'; return; }
    const profile = selectedProfile();
    if (input.sig !== inputSig(sources, profile)) runPreflight();
    if (input.pre && !S.query.preflightRecognized(input.pre).length) { $('#input-status').textContent = '沒有認到任何設備，請依預檢的說明修正輸入。'; return; }
    const expectedData = App.round.expectedData && $('#input-xd').checked ? App.round.expectedData : null;
    const btn = $('#input-build'); btn.disabled = true;
    const bar = $('#input-progress'); bar.classList.remove('hidden'); const fill = bar.firstElementChild;
    try {
      const snap = await S.buildAsync(sources, { profile, expectedData }, (p) => {
        $('#input-status').textContent = A.buildProgressText(p);
        fill.style.width = A.buildPercent(p) + '%';
      });
      $('#input-status').textContent = '繪製中…';
      await new Promise((r) => setTimeout(r, 0));
      // 目前的基準是由工作包帶回的上一輪：換成這一輪後，自動當成「上一輪的基準」比對（只在記憶體，和手動載入舊基準相同）
      const prev = App.round.origin && App.round.origin.kind === 'workpack' && App.snap ? { name: App.round.origin.name, Q: App.Q, snapshot: App.snap } : null;
      A.load(snap, null, { sources, profile, expectedData, origin: { kind: 'build' } });
      if (prev && prev.Q.meta().inputHash !== App.Q.meta().inputHash) V.baselineDiff.setOld(App, `${prev.name}（工作包的基準）`, prev.snapshot);
      await A.saveLast();
      $('#dlg-input').close();
      const m = App.Q.meta(); const st = m.stats;
      A.banner(`已建立基準：${V.num(st.collected)} 台已收集設備、${V.num(st.links)} 條鏈路；`
        + `錯誤 ${st.findings.error}、警告 ${st.findings.warn}（${(m.timing.ms / 1000).toFixed(1)} 秒）`, 8000);
    } catch (e) {
      fail('無法建立基準', e);
    } finally { btn.disabled = false; }
  }

  App.openInput = A.openInput;
  App.loadSample = async () => { await A.openInput(); $('#input-text').value = S.samples['sample-bundle.txt']; input.files = []; renderFiles(); };
})(globalThis.SSOT = globalThis.SSOT || {});
