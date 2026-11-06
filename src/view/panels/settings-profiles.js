/*
 * 設定「命名規則」（外殼在 app-settings.js）：說明、目前可用的命名規則（內建與已載入分開列）、對目前基準的套用結果，
 * 以及載入命名規則檔、下載範本、匯出、移除已載入的。
 *   內建：index.html 以 <script> 載入的 profiles/*.js；這個檔案載入時 S.profiles 裡已有的就是內建（profiles 在 src/view 之前載入）。
 *   已載入：使用者載入的 JSON，存在 store 的 'profiles'，第一次開啟這個分類時讀回並合併進 S.profiles（和建立基準對話框的做法相同）；
 *          「本機資料」還原或清除 'profiles' 後以 syncSaved 讓 S.profiles 跟上 store（store 沒有的移除）。
 *          和內建同 id 時蓋過內建的那一份；移除後恢復內建的。
 * 套用結果只經 S.profile.compile(json).coverage(Q) 計算（只讀 Q，不改寫基準）；選擇要看哪一份是檢視狀態，只在記憶體。
 * 建立基準時選擇命名規則仍在「建立基準」對話框；載入檔案的流程由 loadFile 提供，對話框也可以共用。
 */
(function (S) {
  'use strict';
  const V = S.view; const h = V.h;
  const A = () => V.app;

  /** 內建的命名規則（id → JSON）：載入這個檔案時 S.profiles 已有的 */
  const BUILTIN = new Map(Object.entries(S.profiles || {}).filter(([, p]) => p && p.id));
  /** 沒對上的名稱先列幾筆（其餘按「顯示全部」展開） */
  const UNMATCHED_MAX = 20;
  const DOC = 'docs/命名規則.md';
  /** 下載的範本：最小、可直接編譯，每一段都有範例；description 會顯示在設定的清單 */
  const TEMPLATE = {
    schema: 'ssot-profile/1', id: 'my-naming', version: '1',
    name: '站點_類型_編號',
    description: '站點_類型_編號（例：TPE_SW_01）。請改成這份規則的用途；id 改成和檔名相同，修改內容時提高 version。欄位說明見 docs/命名規則.md。',
    stripDomain: true,
    alias: { 'OLD-NAME': 'TPE_SW_01' },
    classify: [
      { match: '(^|_)FW(_|\\d|$)', kind: 'firewall', role: 'FW' },
      { match: '^([A-Z0-9]+)_SW_', kind: 'switch', role: 'SW', site: '$1' },
    ],
    group: { match: '^([A-Z0-9]+)_', value: '$1' },
    label: { match: '^[A-Z0-9]+_(.+)$', value: '$1' },
  };

  /** 檢視狀態：要看哪一份的套用結果（null 時用目前基準的那一份或第一份）、是否展開全部沒對上的名稱、最後一次動作的訊息 */
  const st = { cov: null, more: false, status: '', statusWarn: false };
  let merged = false;
  /** 套用結果的快取：同一份基準（Q）與同一個命名規則物件只算一次 */
  let cache = { Q: null, map: new Map() };

  /** 一句說明（S.profile.compile(…).describe()）；規則有誤時說明錯誤 */
  const describe = (p) => { try { return S.profile.compile(p).describe(); } catch (e) { return V.reason(e); } };
  /**
   * 規則名稱（只用於顯示）：S.profile.compile(…).name（name，或舊寫法的字串 label）；沒有名稱或規則有誤時 null。
   * 設定、建立基準對話框與資料中心共用這一個取法（V.settings.profiles.nameOf）
   */
  const nameOf = (p) => { try { return S.profile.compile(p).name || null; } catch (e) { return null; } };
  const isBuiltin = (p) => BUILTIN.get(p.id) === p;
  const all = () => Object.values(S.profiles).filter((p) => p && p.id);
  const say = (msg, warn) => { st.status = msg; st.statusWarn = !!warn; };
  const rerender = () => { if (A().settingsOpen() && A().settingsSection() === 'profiles') A().renderSettings(); };

  /**
   * 讓 S.profiles 跟上 store 的 'profiles'（設定「本機資料」還原或清除命名規則後、第一次開啟這個分類時呼叫）：
   * 已載入的換成 store 裡的那幾份，store 沒有了的移除（蓋過的內建恢復）；內建的不動。
   * 讀不到 store 時不改 S.profiles，丟出錯誤由呼叫端說明。回傳 promise。
   */
  async function syncSaved() {
    const saved = (await S.store.get('profiles')) || {};
    merged = true;
    Object.keys(S.profiles).forEach((id) => {
      const p = S.profiles[id]; if (!p || !p.id || isBuiltin(p) || Object.prototype.hasOwnProperty.call(saved, id)) return;
      if (BUILTIN.has(id)) S.profiles[id] = BUILTIN.get(id); else delete S.profiles[id];
    });
    Object.assign(S.profiles, saved);
    if (st.cov && !S.profiles[st.cov]) st.cov = null;
    cache = { Q: null, map: new Map() };
    rerender();
  }

  /** 套用結果，或 { error }（命名規則有誤、沒有基準時 null） */
  function coverageOf(App, p) {
    if (!App.Q) return null;
    if (cache.Q !== App.Q) cache = { Q: App.Q, map: new Map() };
    if (!cache.map.has(p)) {
      let r; try { r = S.profile.compile(p).coverage(App.Q); } catch (e) { r = { error: V.reason(e) }; }
      cache.map.set(p, r);
    }
    return cache.map.get(p);
  }
  /** 目前的基準是否用這一份建立（id 與內容雜湊相同；沒有基準時比對 App.round.profile 是不是同一份） */
  function usedBy(App, p) {
    const used = App.round.profile; if (!used || used.id !== p.id) return false;
    const c = coverageOf(App, p);
    return c && !c.error ? c.applied : used === p;
  }

  /**
   * 載入命名規則檔（JSON）：解析、以 S.profile.compile 驗證，通過後加入 S.profiles 並存進 store 的 'profiles'。
   * file 是 File 或 { name, text() }。回傳 { ok: true, id, replaced（蓋過同 id 的哪一種：'builtin'、'saved' 或 null） }
   * 或 { ok: false, error }（錯誤訊息含檔名；JSON 不合法、compile 的錯誤原樣列出）。不丟例外；成功或失敗都不改目前的基準。
   */
  async function loadFile(file) {
    const name = (file && file.name) || '（未命名）';
    let text;
    try { text = await file.text(); } catch (e) { return { ok: false, error: `無法讀取命名規則檔「${name}」：${V.reason(e)}` }; }
    // 文字直接交給 S.profile.compile：它先解析（擋下重複的鍵），再驗證
    let j;
    try { const c = S.profile.compile(text); j = c && c.source; } catch (e) {
      return { ok: false, error: `無法載入命名規則檔「${name}」：` + (e instanceof SyntaxError ? `不是有效的 JSON（${V.reason(e)}）` : V.reason(e)) };
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: `無法載入命名規則檔「${name}」：內容應是一個 JSON 物件` };
    const prev = S.profiles[j.id];
    const replaced = prev ? (BUILTIN.get(j.id) === prev ? 'builtin' : 'saved') : null;
    try {
      const saved = (await S.store.get('profiles')) || {}; saved[j.id] = j; await S.store.set('profiles', saved);
    } catch (e) { return { ok: false, error: `無法儲存命名規則「${j.id}」：${V.reason(e)}` }; }
    S.profiles[j.id] = j;
    return { ok: true, id: j.id, replaced };
  }

  /** 移除前的確認文字：目前基準正在用時說明不影響已建立的基準 */
  function removeMessage(App, id) {
    const p = S.profiles[id];
    const lines = [`移除載入的命名規則「${id}」？`];
    if (BUILTIN.has(id)) lines.push('移除後恢復使用內建的同名命名規則。');
    if (p && usedBy(App, p)) lines.push('目前的基準是用這份命名規則建立的：已建立的基準不受影響，但之後建立基準時不能再選它（需要時再載入一次）。');
    return lines.join('\n');
  }
  async function remove(App, id) {
    const p = S.profiles[id]; if (!p || isBuiltin(p)) return;
    if (!window.confirm(removeMessage(App, id))) return;
    try {
      const saved = (await S.store.get('profiles')) || {}; delete saved[id]; await S.store.set('profiles', saved);
    } catch (e) { say(`無法移除命名規則「${id}」：${V.reason(e)}`, true); rerender(); return; }
    if (BUILTIN.has(id)) S.profiles[id] = BUILTIN.get(id); else delete S.profiles[id];
    if (st.cov === id && !S.profiles[id]) st.cov = null;
    say(`已移除命名規則「${id}」`); rerender();
  }
  const fileName = (id) => String(id).replace(/[^\w.-]+/g, '_') + '.json';
  const exportOne = (p) => V.exporter.download(fileName(p.id), JSON.stringify(p, null, 2) + '\n', 'application/json');
  const downloadTemplate = () => V.exporter.download('naming-template.json', JSON.stringify(TEMPLATE, null, 2) + '\n', 'application/json');

  // ================================================================ 畫面
  /**
   * 6 欄的表格：包在 .table-scroll；窄螢幕時（table.t.stack）每個規則排成一塊、每格前面寫欄名（data-label），說明、來源與「匯出」不被切掉
   */
  const COLS = ['ID', '名稱', '說明', '來源', '目前的基準', ''];
  function table(App, src, list) {
    const td = (n, attrs, body) => h('td', Object.assign({ 'data-label': COLS[n] }, attrs), body);
    return h('div', { class: 'table-scroll' }, h('table', { class: 't stack settings-profiles', 'data-source': src }, [
      h('thead', null, h('tr', null, COLS.map((t) => h('th', null, t)))),
      h('tbody', null, list.map((p) => h('tr', { 'data-profile': p.id }, [
        td(0, { class: 'mono' }, p.id + (p.version != null ? ` v${p.version}` : '')),
        td(1, null, nameOf(p) || '—'),
        td(2, null, describe(p)),
        td(3, null, isBuiltin(p) ? '內建' : BUILTIN.has(p.id) ? '已載入（蓋過內建的同名規則）' : '已載入'),
        td(4, null, usedBy(App, p) ? '✓ 目前的基準使用' : h('span', { class: 'muted' }, '未使用')),
        td(5, null, h('div', { class: 'row' }, [
          h('button', { type: 'button', 'data-action': 'export', 'data-settings-focus': 'export:' + p.id, title: `下載「${p.id}」的 JSON`, onclick: () => exportOne(p) }, '匯出'),
          isBuiltin(p) ? null : h('button', { type: 'button', class: 'danger', 'data-action': 'remove', 'data-settings-focus': 'remove:' + p.id,
            title: `從這個瀏覽器移除「${p.id}」（會先確認）`, onclick: () => remove(App, p.id) }, '移除…'),
        ])),
      ]))),
    ]));
  }
  const fieldLabel = { kind: '類型', role: '角色', site: '站點', group: '分群', label: '顯示名稱' };
  function coverageBox(App, list) {
    const box = h('div', { id: 'settings-profile-coverage', class: 'settings-group' });
    box.appendChild(h('h3', null, '套用結果（目前的基準）'));
    if (!App.Q) { box.appendChild(h('p', { class: 'muted' }, '目前沒有基準；建立基準後，這裡會列出每份命名規則對上幾台、哪些名稱沒有對上。')); return box; }
    if (!list.length) { box.appendChild(h('p', { class: 'muted' }, '沒有可用的命名規則。')); return box; }
    const used = list.find((p) => usedBy(App, p));
    const cur = list.find((p) => p.id === st.cov) || used || list[0];
    const sel = h('select', { id: 'settings-profile-cov', 'data-settings-focus': 'cov', 'aria-label': '要看套用結果的命名規則',
      onchange: (e) => { st.cov = e.target.value; st.more = false; rerender(); } },
    list.map((p) => h('option', { value: p.id }, p.id + (usedBy(App, p) ? '（目前的基準使用）' : ''))));
    sel.value = cur.id;
    box.appendChild(h('div', { class: 'form-row' }, [h('label', { for: 'settings-profile-cov' }, '命名規則'), sel]));
    const c = coverageOf(App, cur);
    if (c.error) { box.appendChild(h('p', { class: 'warn-line' }, c.error)); return box; }
    box.appendChild(h('p', null, [h('b', null, `對上 ${V.num(c.matched)}／${V.num(c.total)} 台`),
      `（已收集的設備 ${V.num(c.collected.matched)}／${V.num(c.collected.total)} 台）`,
      c.renamed.length ? `；別名或去掉網域會改名 ${V.num(c.renamed.length)} 台` : '']));
    box.appendChild(h('p', { class: 'muted settings-note' }, c.applied
      ? '目前的基準就是用這份命名規則建立的。「對上」是指至少得到一個註解（類型、角色、站點、分群或顯示名稱）。'
      : '目前的基準不是用這份命名規則建立的：這是依基準中的名稱預覽，實際結果以用它重新建立的基準為準。「對上」是指至少得到一個註解。'));
    const rows = Object.keys(fieldLabel).filter((f) => c.fields[f].length).map((f) => [h('dt', null, fieldLabel[f]),
      h('dd', null, c.fields[f].map((x) => `${f === 'kind' ? (S.KIND_LABEL[x.value] || x.value) : x.value} ${V.num(x.count)}`).join('、'))]);
    if (rows.length) box.appendChild(h('dl', { class: 'settings-about' }, rows.flat()));
    if (!c.unmatched.length) box.appendChild(h('p', { class: 'muted' }, '每一台都有對上。'));
    else {
      const shown = st.more ? c.unmatched : c.unmatched.slice(0, UNMATCHED_MAX);
      box.appendChild(h('p', null, `沒對上的名稱（${V.num(c.unmatched.length)} 台）：`));
      box.appendChild(h('ul', { class: 'settings-list' }, shown.map((u) => h('li', { 'data-unmatched': u.key }, [
        h('span', { class: 'mono' }, u.name), u.collected ? '' : h('span', { class: 'muted' }, '（未收集，只由鄰居或 ARP 得知）')]))));
      if (c.unmatched.length > UNMATCHED_MAX) {
        box.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost', 'data-action': 'more', 'data-settings-focus': 'more',
          onclick: () => { st.more = !st.more; rerender(); } }, st.more ? `只顯示前 ${UNMATCHED_MAX} 筆` : `顯示全部 ${V.num(c.unmatched.length)} 筆`)));
      }
    }
    return box;
  }

  function render(App, el) {
    // 第一次開啟：讀回存過的命名規則；讀完且仍在這個分類時重畫（讀不到時照常列出內建的）
    if (!merged) { merged = true; syncSaved().catch((e) => { console.error(e); say('無法讀取載入過的命名規則：' + V.reason(e), true); rerender(); }); }
    el.appendChild(h('p', null, ['命名規則是一份 JSON：依設備名稱把別名對應到正式名稱，並加上類型、角色、站點、分群與顯示名稱等註解。',
      '它不會新增、刪除或改寫收集到的事實（介面、鏈路、VLAN、位址）；不套用時工具照常可用，類型依收集到的資料判斷，分群依連線關係。',
      '設備名稱有固定格式（例如「站點_層級_類型_編號」），想依站點分群或修正判斷錯的類型時才需要。']));
    el.appendChild(h('p', { class: 'muted' }, ['欄位、撰寫與維護流程見 ', V.settings.docLink(DOC, null, DOC),
      '。建立基準時在「建立基準」對話框的「命名規則」選擇要套用的一份。']));

    const file = h('input', { type: 'file', id: 'settings-profile-file', class: 'hidden', accept: '.json,application/json', 'aria-hidden': 'true', tabindex: '-1',
      onchange: async (e) => {
        const f = e.target.files && e.target.files[0]; e.target.value = '';
        if (!f) return;
        const r = await loadFile(f);
        if (r.ok) { st.cov = r.id; st.more = false; say(`已載入命名規則「${r.id}」` + (r.replaced === 'builtin' ? '（蓋過內建的同名規則）' : r.replaced === 'saved' ? '（取代先前載入的同名規則）' : '')); }
        else say(r.error, true);
        rerender();
      } });
    el.appendChild(h('div', { class: 'settings-action' }, [
      file,
      h('button', { type: 'button', 'data-action': 'load', 'data-settings-focus': 'load', onclick: () => file.click() }, '載入命名規則檔（JSON）…'),
      h('button', { type: 'button', 'data-action': 'template', 'data-settings-focus': 'template', title: '下載一份可直接修改的最小範本', onclick: downloadTemplate }, '下載範本'),
      h('button', { type: 'button', 'data-settings-focus': 'open-input', onclick: () => App.openInput() }, '開啟「建立基準」…'),
    ]));
    el.appendChild(h('p', { id: 'settings-profiles-status', role: 'status', class: st.statusWarn ? 'warn-line' : 'muted', style: { whiteSpace: 'pre-line' } }, st.status));

    const list = all();
    const builtin = list.filter(isBuiltin); const saved = list.filter((p) => !isBuiltin(p));
    el.appendChild(h('h3', null, '內建'));
    el.appendChild(builtin.length ? table(App, 'builtin', builtin) : h('p', { class: 'muted' }, '沒有內建的命名規則。'));
    el.appendChild(h('h3', null, '已載入'));
    el.appendChild(saved.length ? table(App, 'saved', saved) : h('p', { class: 'muted' }, '還沒有載入命名規則檔；載入後存在這個瀏覽器，下次開啟仍可選擇。'));
    el.appendChild(coverageBox(App, list));
  }

  V.settings = V.settings || {};
  V.settings.profiles = { render, loadFile, nameOf, syncSaved, removeMessage, builtinIds: () => Array.from(BUILTIN.keys()), UNMATCHED_MAX, TEMPLATE };
})(globalThis.SSOT = globalThis.SSOT || {});
