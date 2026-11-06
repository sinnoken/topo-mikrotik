// 畫面冒煙測試的 step：拓樸圖的層級、VLAN 篩選、L2 埠圖、L3 網段圖、匯出 PNG。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { body, docListeners, winListeners, head, document, S, fs, path, vm, ROOT, step, captureDownloads, recordCanvas, vertices, near, tickStrokes, checkTicks, $, text, layerBtn, timed, L4 } = require('../helpers.js');

module.exports = async () => {
  // ------------------------------------------------------------ M1：L2／L3 視圖
  await step('拓樸圖的層級：設備、L2 埠、L3 網段、L4 可達性可切換（radiogroup，鍵盤可操作）；各層的位置與縮放互不干擾，設備圖的位置存檔不變', async () => {
    const g = App.graph; App.select(null); await App.ledgerJob; await App.layoutJob; // 設備圖背景的分層版面完成後才記下狀態
    const btns = document.testAll('#layer-switch button');
    if ($('#layer-switch').getAttribute('role') !== 'radiogroup' || btns.map((b) => b.getAttribute('data-layer')).join() !== 'device,l2,l3,l4' || !btns.every((b) => b.getAttribute('role') === 'radio')) throw new Error('層級切換應是 radiogroup，依序是設備、L2、L3、L4');
    if (layerBtn('l4').disabled || layerBtn('l4').getAttribute('aria-disabled') === 'true' || !layerBtn('l4').textContent.includes('L4')) throw new Error('L4 應可以使用（M2）');
    if (App.layer !== 'device' || layerBtn('device').getAttribute('aria-checked') !== 'true') throw new Error('預設是設備圖');
    // 設備圖的狀態與存檔
    await S.store.set('last', Object.assign({}, await S.store.get('last'), { positions: Object.fromEntries(App.devicePos) }));
    const paneLayout = JSON.stringify(await S.store.get('layout'));
    g.s = 0.91; g.tx = 31; g.ty = -17;
    const devState = () => JSON.stringify({ s: g.s, tx: g.tx, ty: g.ty, pos: Array.from(App.devicePos), n: App.deviceGraph.nodes.length });
    if (g.nodes !== App.deviceGraph.nodes || g.pos !== App.devicePos) throw new Error('測試前提：畫布上是設備圖的資料');
    const devBefore = devState(); const savedBefore = JSON.stringify((await S.store.get('last')).positions);
    // L2：設備是框、埠掛在框上（ELK 的 port），邊接在埠上
    await timed('切到 L2', () => layerBtn('l2').click());
    if (App.layer !== 'l2' || layerBtn('l2').getAttribute('aria-checked') !== 'true' || layerBtn('l2').getAttribute('tabindex') !== '0' || layerBtn('device').getAttribute('tabindex') !== '-1') throw new Error('點 L2 應切換，aria-checked 與 roving tabindex 跟著改');
    if (g.pos === App.devicePos) throw new Error('L2 的位置不可寫在設備圖的位置上');
    const ports = g.nodes.filter((n) => n.kind === 'port'); const boxes = g.nodes.filter((n) => n.box);
    if (!ports.length || !boxes.length) throw new Error('L2 應有設備框與埠');
    ports.forEach((p) => { const q = g.at(p.id); if (!g.nodeById.get(p.anchor.parent).box || !q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) throw new Error('埠應掛在設備框上且有座標：' + p.id); });
    if (!g.edges.every((e) => g.nodeById.get(e.a).kind === 'port' && g.nodeById.get(e.b).kind === 'port')) throw new Error('L2 的邊應接在埠上');
    const ev = new Set(g.edges.map((e) => e.evidence)); const W = S.view.theme.weakEdge;
    if (!Array.from(ev).every((x) => x === 'adjacency' || W[x])) throw new Error('L2 的邊應沿用 evidence 的線型');
    g.s = 0.66; g.tx = 5; g.ty = 7; const box0 = boxes[0].id; App.layerEntry().pos.set(box0, { x: 4321, y: 1234 });
    const l2Pos = App.layerEntry().pos;
    // 鍵盤：方向鍵切到 L3，焦點跟著移動
    layerBtn('l2').focus();
    await timed('切到 L3', () => layerBtn('l2').dispatch('keydown', { key: 'ArrowRight' }));
    if (App.layer !== 'l3' || document.activeElement !== layerBtn('l3')) throw new Error('→ 應切到 L3，焦點移到 L3 按鈕');
    if (!g.nodes.some((n) => n.kind === 'subnet')) throw new Error('L3 應有子網節點');
    const l3Pos = App.layerEntry().pos;
    g.s = 1.23; g.tx = -9; g.ty = 3;
    layerBtn('l3').dispatch('keydown', { key: 'End' });
    if (App.layer !== 'l4' || document.activeElement !== layerBtn('l4')) throw new Error('End 應切到最後一個層級（L4），焦點移到 L4 按鈕');
    if ($('#view-l4').classList.contains('hidden') || !$('#graph').inert || !$('#legend').classList.contains('hidden')) throw new Error('L4：矩陣疊在畫布上，畫布不能聚焦，圖例不顯示');
    if (g.pos !== l3Pos || g.s !== 1.23) throw new Error('切到 L4 時畫布不換資料、不動縮放');
    await App.l4Job;
    layerBtn('l4').dispatch('keydown', { key: 'Home' });
    if (!$('#view-l4').classList.contains('hidden') || $('#graph').inert) throw new Error('離開 L4 時應收起矩陣、畫布可以再聚焦');
    if (App.layer !== 'device' || document.activeElement !== layerBtn('device')) throw new Error('Home 應回到設備圖');
    if (devState() !== devBefore || g.pos !== App.devicePos) throw new Error('回到設備圖時，位置與縮放應和切換前相同：' + devState().slice(0, 80) + ' / ' + devBefore.slice(0, 80));
    layerBtn('device').dispatch('keydown', { key: 'ArrowRight' });
    if (App.layer !== 'l2' || g.s !== 0.66 || g.tx !== 5 || g.pos !== l2Pos || g.pos.get(box0).x !== 4321) throw new Error('回到 L2 時應保留 L2 自己的位置與縮放');
    layerBtn('l2').dispatch('keydown', { key: 'ArrowRight' });
    if (App.layer !== 'l3' || g.s !== 1.23 || g.pos !== l3Pos) throw new Error('回到 L3 時應保留 L3 自己的位置與縮放');
    App.showLayer('device');
    await new Promise((r) => setTimeout(r, 700)); // 拖曳後的存檔有延遲：等過它，確認沒有寫進 L2／L3 的位置
    const saved = (await S.store.get('last')).positions;
    if (JSON.stringify(saved) !== savedBefore || Object.keys(saved).some((k) => k.startsWith('net|') || l2Pos.has(k) && !App.devicePos.has(k))) throw new Error('store 的 last.positions 只存設備圖的位置');
    if (JSON.stringify(await S.store.get('layout')) !== paneLayout) throw new Error('store 的 layout（欄寬）不受層級切換影響');
    if (!/\.layer-switch \[role="radio"\]\[aria-checked="true"\]/.test(fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8').split('@media (forced-colors: active)')[1])) throw new Error('強制色彩模式下選取的層級應有系統色外框');
    try { App.showLayer('l5'); throw new Error('不應能切到未知的層級'); } catch (e) { if (!(e instanceof RangeError)) throw e; }
  });
  await step('VLAN 篩選的標示：由選取帶入的篩選在工具列旁有「VLAN n ✕」，按下或 Esc 取消、選其他東西或換基準時取消；選單選的由選單標示並保留；基準中沒有的 VLAN 不設篩選', async () => {
    const Q = App.Q; const chip = $('#vlan-chip'); const id = Q.vlanIds()[0]; const sel = $('#vlan-filter'); const VA = S.view.app;
    const shown = () => !chip.classList.contains('hidden');
    const dev = App.snap.model.devices.find((d) => d.collected).key;
    App.select(null);
    if (App.vlanFilter || shown()) throw new Error('沒有 VLAN 篩選時不應顯示標示');
    // 選單選的：選單本身就是標示，不另顯示「VLAN n ✕」（避免同一個狀態並排兩次）；選其他東西時保留，選單選「不篩選」取消
    sel.value = String(id); sel.dispatch('change');
    if (!App.vlanFilter || !App.vlanFilter.pinned || shown() || sel.value !== String(id)) throw new Error('在選單選的 VLAN 篩選由選單標示，不另顯示 chip');
    App.select({ type: 'device', key: dev });
    if (!App.vlanFilter || shown() || sel.value !== String(id)) throw new Error('在選單選的 VLAN 篩選，選其他東西時應保留');
    sel.value = ''; sel.dispatch('change');
    if (App.vlanFilter || shown() || !App.sel || App.sel.key !== dev) throw new Error('選單選「不篩選」應取消篩選、保留選取');
    // 基準中沒有的 VLAN（例如搜尋 4000 的「基準中沒有這個 VLAN」）：照樣開啟 VLAN 詳情，但不設成篩選
    const missing = [4000, 4001, 4002, 4003].find((x) => !Q.vlanIds().includes(x));
    App.select({ type: 'vlan', key: String(missing) });
    if (App.vlanFilter || shown() || sel.value !== '' || !App.sel || App.sel.type !== 'vlan') throw new Error('基準中沒有的 VLAN 不應設成篩選');
    App.select(null);
    // 檢查結果（或搜尋、詳情的連結）帶入的：標示出現，選其他東西時自動取消
    const vi = App.snap.findings.findIndex((f) => f.entities[0] && f.entities[0].type === 'vlan');
    if (vi < 0) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有指向 VLAN 的檢查結果'); }
    App.selectFinding(vi); const vid = App.snap.findings[vi].entities[0].key;
    if (!App.vlanFilter || App.vlanFilter.pinned || !shown() || chip.tagName !== 'BUTTON' || !chip.textContent.includes(`VLAN ${vid}`) || !chip.textContent.includes('✕')
      || !(chip.getAttribute('aria-label') || '').includes(`VLAN ${vid}`)) throw new Error('檢查結果帶入的 VLAN 篩選應顯示可關閉的標示：' + chip.textContent);
    // 沒有釘選時選單顯示「不篩選」：使用者在選單選這個 VLAN 才會真的改變值、觸發 change 而釘選（值沒變時瀏覽器不送 change）
    if (sel.value !== '') throw new Error('由選取帶入（沒有釘選）的 VLAN 篩選，選單應顯示「不篩選」：' + sel.value);
    // VLAN 詳情的說明與實際行為一致：選單選的保留，其他來源帶入的選別的東西或換基準時取消、可按標示取消
    App.select({ type: 'vlan', key: String(vid) });
    const about = text('#detail');
    if (about.includes('持續標示') || !about.includes('不篩選') || !about.includes('✕') || !about.includes('換基準')) throw new Error('VLAN 詳情應說明現在的篩選行為（選單選的保留、其他來源的會取消、可按 ✕ 取消）');
    App.select({ type: 'device', key: dev });
    if (App.vlanFilter || shown() || sel.value !== '') throw new Error('檢查結果帶入的 VLAN 篩選，選其他東西時應取消');
    App.selectFinding(vi); chip.click();
    if (App.vlanFilter || shown() || sel.value !== '' || document.activeElement !== sel) throw new Error('按標示應取消篩選，焦點移到 VLAN 選單');
    App.selectFinding(vi); chip.dispatch('keydown', { key: 'Escape' });
    if (App.vlanFilter || shown() || App.sel) throw new Error('在標示上按 Esc 應取消篩選（選取的是 VLAN 時一起取消）');
    // 換基準：沒釘選的篩選隨選取一起取消；選單選的保留
    const reload = async () => { VA.load(App.snap, null, { sources: App.round.sources, profile: App.round.profile }); await App.ledgerJob; await App.layoutJob; };
    App.selectFinding(vi); await reload();
    if (App.vlanFilter || shown() || sel.value !== '') throw new Error('換基準後，由選取帶入的 VLAN 篩選應取消');
    // 由選取帶入後，在選單再選同一個 VLAN：改為保留（來源由選單明確傳入，不看選單當下的值），標示改由選單呈現
    App.selectFinding(vi);
    sel.value = String(vid); sel.dispatch('change');
    if (!App.vlanFilter || !App.vlanFilter.pinned || shown()) throw new Error('在選單再選同一個 VLAN 應改為保留，chip 收起');
    App.select({ type: 'device', key: dev });
    if (!App.vlanFilter) throw new Error('改為保留的 VLAN 篩選，選其他東西時應保留');
    await reload();
    if (!App.vlanFilter || !App.vlanFilter.pinned || String(App.vlanFilter.id) !== String(vid) || sel.value !== String(vid)) throw new Error('換基準後，選單選的 VLAN 篩選應保留');
    sel.value = ''; sel.dispatch('change'); App.select(null);
  });
  await step('換基準：畫布不殘留上一份的選取環、高亮、疊加與外圈；釘選的 VLAN 篩選依新的基準重新標示', async () => {
    const g = App.graph; const VA = S.view.app; const sel = $('#vlan-filter');
    const reload = async () => { VA.load(App.snap, null, { sources: App.round.sources, profile: App.round.profile }); await App.ledgerJob; await App.layoutJob; };
    const clean = (where) => {
      if (App.sel) throw new Error(where + '：App.sel 應清空');
      if (g.sel.nodes.size || g.sel.edges.size) throw new Error(where + '：畫布不應殘留選取環：' + Array.from(g.sel.nodes).slice(0, 3));
      if (g.overlay.length) throw new Error(where + '：畫布不應殘留疊加');
      if (g.emphasis) throw new Error(where + '：畫布不應殘留與多數不同的外圈');
    };
    App.showLayer('device');
    const dev = App.Q.devices().find((d) => d.collected && g.pos.has(d.key));
    App.select({ type: 'device', key: dev.key });
    if (!g.sel.nodes.has(dev.key)) throw new Error('前置：選設備後畫布應有選取環');
    await reload(); clean('選設備後換基準');
    if (g.hl) throw new Error('沒有 VLAN 篩選時，換基準後畫布不應殘留高亮');
    const fi = App.snap.findings.findIndex((f) => f.entities.length > 1);
    if (fi >= 0) {
      App.selectFinding(fi); if (!g.hl) throw new Error('前置：選檢查結果後畫布應有高亮');
      await reload(); clean('選檢查結果後換基準');
      if (g.hl) throw new Error('換基準後畫布不應殘留檢查結果的高亮');
    }
    // 釘選的 VLAN 篩選保留：高亮是新的基準算出的（和重新選一次 VLAN 篩選相同）
    const id = App.Q.vlanIds()[0];
    if (id != null) {
      sel.value = String(id); sel.dispatch('change'); App.select({ type: 'device', key: dev.key });
      await reload(); clean('釘選 VLAN 篩選後換基準');
      const want = VA.vlanMarks(id, null);
      if (!g.hl || JSON.stringify(Array.from(g.hl.nodes.keys()).sort()) !== JSON.stringify(Array.from(want.nodes.keys()).sort())) throw new Error('換基準後，釘選的 VLAN 篩選應依新的基準重新標示');
      sel.value = ''; sel.dispatch('change');
    }
  });
  await step('分層版面計算被取消（改快速版面、換基準）時，「計算中」的通知馬上收起，不再被當遮擋物；別的通知不受影響', async () => {
    const VA = S.view.app; const b = $('#banner');
    const mode = (k) => $('#layout-mode').testAll('.menu-item').find((x) => x.dataset.layout === k);
    const computing = () => !b.classList.contains('hidden') && b.textContent.includes('計算中');
    App.showLayer('device');
    try {
      // 1. 計算中改快速版面
      VA.relayout(); const job = App.layoutJob;
      if (!computing()) throw new Error('前置：分層版面計算中應有通知：' + b.textContent);
      mode('builtin').click();
      if (computing()) throw new Error('改用快速版面後，「計算中」的通知應收起');
      await job; if (computing()) throw new Error('取消的計算結束後也不應再出現「計算中」');
      // 2. 計算中換一份有儲存位置的基準（不再計算分層版面）
      mode('elk').click(); const job2 = App.layoutJob;
      if (!computing()) throw new Error('前置：切回分層版面應開始計算');
      VA.load(App.snap, Object.fromEntries(App.devicePos), { sources: App.round.sources, profile: App.round.profile }); await App.ledgerJob;
      if (computing()) throw new Error('換基準後，上一份的「計算中」通知應收起');
      await job2; if (computing()) throw new Error('取消的計算結束後也不應再出現「計算中」');
      // 3. 別的通知蓋過「計算中」後，取消不會收掉別人的通知
      VA.relayout(); const job3 = App.layoutJob; VA.banner('其他通知');
      mode('builtin').click();
      if (b.classList.contains('hidden') || b.textContent !== '其他通知') throw new Error('取消分層版面不應收掉別的通知');
      await job3; mode('elk').click(); await App.layoutJob;
    } finally { App.layoutMode = 'elk'; }
  });
  await step('窄螢幕 Esc 一次只關最上層：路由追蹤或資料中心先關，抽屜留著，再按一次才收起抽屜；拖曳把手後鍵盤按把手仍有反應', async () => {
    const main = $('#main'); const g = App.graph;
    const ws = (w) => document.testAll('#mobile-workspaces button').find((x) => x.dataset.workspace === w);
    const esc = () => (docListeners.keydown || []).forEach((f) => f({ key: 'Escape', target: document.activeElement, preventDefault() {}, stopPropagation() {} }));
    const dev = App.Q.devices().find((d) => d.collected && g.pos.has(d.key));
    try {
      window.innerWidth = 390; App.showStep('triage'); ws('graph').click(); App.showLayer('device');
      g.emit('click', { type: 'node', id: dev.key });
      if (main.dataset.sheet !== 'half') throw new Error('前置：選設備後應開抽屜');
      App.openTrace(); $('#trace-run').focus();
      esc();
      if (!$('#trace-pop').classList.contains('hidden')) throw new Error('Esc 應關閉路由追蹤');
      if (main.dataset.sheet !== 'half') throw new Error('Esc 關閉路由追蹤時抽屜不應跟著收起');
      esc(); if (main.dataset.sheet) throw new Error('再按一次 Esc 應收起抽屜');
      g.emit('click', { type: 'node', id: dev.key });
      App.openHub();
      if (main.dataset.sheet === 'half') {
        esc();
        if (VA().hubOpen()) throw new Error('Esc 應關閉資料中心');
        if (main.dataset.sheet !== 'half') throw new Error('Esc 關閉資料中心時抽屜不應跟著收起');
        esc(); if (main.dataset.sheet) throw new Error('再按一次 Esc 應收起抽屜');
      } else S.view.app.closeHub();
      // 拖曳把手後放開在把手外（click 不會送到把手）：之後用鍵盤按把手（只有 click、沒有 pointerdown）仍要有反應
      g.emit('click', { type: 'node', id: dev.key });
      const right = $('#right'); const hd = $('#sheet-handle'); const rr = right.getBoundingClientRect;
      right.getBoundingClientRect = () => ({ left: 0, top: 480, width: 1200, height: 320 });
      try {
        hd.dispatch('pointerdown', { pointerId: 9, pointerType: 'touch', button: 0, clientX: 0, clientY: 490 });
        const ev = { pointerId: 9, pointerType: 'touch', target: main, clientX: 0, clientY: 190 };
        (winListeners.pointermove || []).forEach((f) => f(ev)); (winListeners.pointerup || []).forEach((f) => f(ev));
        if (main.dataset.sheet !== 'full') throw new Error('前置：上拉應展開成全高');
        await new Promise((r) => setTimeout(r, 5));
        hd.click(); if (main.dataset.sheet !== 'half') throw new Error('拖曳結束後，下一次用鍵盤按把手不應被吞掉');
      } finally { right.getBoundingClientRect = rr; }
    } finally { window.innerWidth = 1200; App.select(null); App.showStep('triage'); ws('graph').click(); }
    function VA() { return S.view.app; }
  });
  await step('VLAN 篩選：設備圖與 L2 埠圖依 vlanCarriers 標出承載與只有一端（外形不只靠顏色），推論以線型區分，提示說明原因；選其他東西時保留，取消後拿掉', async () => {
    const g = App.graph; const T = S.view.theme; const Q = App.Q;
    const opts = $('#vlan-filter').testAll('option').map((o) => o.getAttribute('value')).filter(Boolean);
    if (opts.join() !== Q.vlanIds().join()) throw new Error('VLAN 選單的選項應來自 Q.vlanIds()');
    const c30 = Q.vlanCarriers(30); const partial = c30.links.find((l) => l.status === 'partial'); const carry = c30.links.find((l) => l.status === 'carry');
    if (!process.env.SMOKE_INPUT && (!partial || !carry)) throw new Error('範例資料的 VLAN 30 應有承載與一條只有一端（partial）的鏈路');
    $('#vlan-filter').value = '30'; $('#vlan-filter').dispatch('change');
    if (!App.vlanFilter || App.vlanFilter.id !== 30 || App.sel.type !== 'vlan') throw new Error('選 VLAN 應設為篩選並開啟 VLAN 詳情');
    const checkDevice = () => {
      if (carry && g.hl.edges.get(App.pairOfLink.get(carry.key)) !== T.vlan.carry && g.hl.edges.get(App.pairOfLink.get(carry.key)) !== T.vlan.partial) throw new Error('設備圖應標出承載的鏈路');
      if (partial && g.hl.edges.get(App.pairOfLink.get(partial.key)) !== T.vlan.partial) throw new Error('設備圖應以 partial 樣式標出只有一端的鏈路');
    };
    checkDevice();
    if (partial) { // 只有一端：中點畫錯誤外形（不只靠顏色）
      const pid = App.pairOfLink.get(partial.key); const p = App.pairs.get(pid); const a = g.at(p.a); const b = g.at(p.b);
      const ops = recordCanvas(g.ctx, () => g.draw());
      if (!ops.some((o) => o.op === 'fill' && o.style === T.sev.error && near(o.path, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 20) && vertices(o.path) === 4)) throw new Error('只有一端的鏈路應在中點畫錯誤的方形');
      // 紅綠色盲分不出 partial 與 carry 的顏色：partial 另有垂直短刻度，縮小、100%、200% 時在螢幕上都看得到
      checkTicks(g, a, b, 'device');
      const cp = [...g.hl.edges].find(([, st]) => st === T.vlan.carry);
      if (cp) {
        const e = g.edges.find((x) => x.id === cp[0]); const ca = g.at(e.a); const cb = g.at(e.b);
        if (tickStrokes(recordCanvas(g.ctx, () => g.draw()), ca, cb, T.vlan.carry.c, null).length) throw new Error('承載（carry）的線不應有刻度');
      }
    }
    // 四種狀態的線型兩兩不同：partial 是實線加刻度，carry 是實線，inferred、oneSide 是不同的虛線／點線
    const vk = (st) => JSON.stringify([st.dash || null, st.ticks || null]);
    const vkeys = Object.values(T.vlan).map(vk);
    if (new Set(vkeys).size !== vkeys.length) throw new Error('VLAN 狀態的線型應兩兩不同：' + vkeys.join(' / '));
    if (!T.vlan.partial.ticks || T.vlan.partial.dash || ['carry', 'inferred', 'oneSide'].some((k) => T.vlan[k].ticks)) throw new Error('只有 partial 有刻度（實線加垂直短刻度）');
    if (T.vlan.inferred.dash === undefined || T.vlan.oneSide.dash === undefined || T.vlan.carry.dash) throw new Error('推論（inferred、oneSide）應以線型與承載區分');
    // 選其他東西：沒有自己的標示時仍標出 VLAN
    const dev = c30.devices[0]; App.select({ type: 'device', key: dev });
    if (!g.hl || !g.hl.edges.size || $('#vlan-filter').value !== '30') throw new Error('VLAN 篩選應持續到在選單取消');
    // 推論的原因（oneSide）：提示與詳情以中文說明
    const withOne = Q.vlanIds().map((id) => Q.vlanCarriers(id)).find((x) => x.links.some((l) => l.status === 'oneSide' && App.pairOfLink.get(l.key)));
    if (withOne) {
      const one = withOne.links.find((l) => l.status === 'oneSide' && App.pairOfLink.get(l.key));
      App.select({ type: 'vlan', key: String(withOne.id) });
      if (!text('#detail').includes('只有一端可確認的鏈路（推論）') || !text('#detail').includes(S.view.VLAN_REASON[one.reason])) throw new Error('VLAN 詳情應列出只有一端可確認的鏈路與原因');
      const pid = App.pairOfLink.get(one.key); const st = g.hl.edges.get(pid);
      if (![T.vlan.oneSide, T.vlan.carry, T.vlan.partial, T.vlan.inferred].includes(st)) throw new Error('oneSide 的鏈路應有標示');
      App.graph.emit('hover', { item: { type: 'edge', id: pid }, x: 0, y: 0 });
      if (!text('#tooltip').includes('VLAN ' + withOne.id)) throw new Error('VLAN 篩選中，提示應寫出這條線的承載狀態');
      if (st === T.vlan.oneSide && !text('#tooltip').includes(S.view.VLAN_REASON[one.reason])) throw new Error('只有一端可確認時，提示應以中文說明原因');
      App.select({ type: 'vlan', key: '30' });
    } else if (!process.env.SMOKE_INPUT) throw new Error('範例資料應有只有一端可確認（oneSide）的 VLAN 鏈路');
    // L2 埠圖：同樣的承載狀態標在埠對埠的邊上
    await timed('VLAN 篩選中切到 L2', () => App.showLayer('l2'));
    const E = App.layerEntry().index;
    if (partial && g.hl.edges.get(E.edgeOfLink.get(partial.key)) !== T.vlan.partial) throw new Error('L2 埠圖應以 partial 樣式標出只有一端的鏈路');
    if (carry && E.edgeOfLink.get(carry.key) && ![T.vlan.carry, T.vlan.partial].includes(g.hl.edges.get(E.edgeOfLink.get(carry.key)))) throw new Error('L2 埠圖應標出承載的鏈路');
    if (partial) {
      const pe = g.edges.find((x) => x.id === E.edgeOfLink.get(partial.key)); checkTicks(g, g.at(pe.a), g.at(pe.b), 'L2');
      App.graph.emit('hover', { item: { type: 'edge', id: E.edgeOfLink.get(partial.key) }, x: 0, y: 0 });
      if (!text('#tooltip').includes(S.view.VLAN_STATUS.partial)) throw new Error('L2 的提示應寫出只有一端帶這個 VLAN');
    }
    // 大型資料只畫一台設備與鄰居：圖上有帶這個 VLAN 的埠時才要求標示
    if (c30.eps.some((ep) => E.portOfEp.get(ep)) && !Array.from(g.hl.nodes.keys()).some((k) => g.nodeById.get(k).kind === 'port')) throw new Error('L2 應標出帶這個 VLAN 的埠');
    App.graph.draw();
    // 取消篩選
    $('#vlan-filter').value = ''; $('#vlan-filter').dispatch('change');
    if (App.vlanFilter || App.sel || (g.hl && (g.hl.edges.size || g.hl.nodes.size))) throw new Error('取消 VLAN 篩選後不應再標示');
    App.showLayer('device'); if (g.hl && g.hl.edges.size) throw new Error('取消後設備圖也不應再標示');
    // 圖例：四種狀態的線型與外形取自 theme.vlan
    const lg = document.testAll('#legend .li');
    Object.entries(T.vlan).forEach(([k, st]) => {
      const li = lg.find((x) => x.childNodes.some((c) => c.attrs && c.attrs['data-vlan'] === k));
      if (!li) throw new Error('圖例缺少 VLAN 狀態：' + k);
      const ln = li.childNodes.find((c) => c.attrs && c.attrs['data-vlan'] === k);
      if (!ln.style.background.includes(st.c) || !!(st.dash || st.ticks) !== ln.style.background.includes('repeating-linear-gradient')) throw new Error('VLAN 圖例的顏色或線型與 theme 不一致：' + k);
      if (st.ticks) { // 刻度的樣本：高度是刻度全長，間距與粗細同 theme（畫布 100% 時的大小）
        const t = st.ticks; const x0 = (t.gap - t.w) / 2;
        if (ln.style.height !== t.len + 'px' || !ln.style.background.includes(`${st.c} ${x0}px ${x0 + t.w}px, transparent ${x0 + t.w}px ${t.gap}px`)) throw new Error('VLAN 只有一端的圖例刻度應與 theme.vlan.partial.ticks 一致');
      }
      if (st.sev && !li.childNodes.some((c) => c.attrs && c.attrs['data-shape'] === T.sevShape[st.sev])) throw new Error('VLAN 只有一端的圖例應有錯誤外形');
    });
    // 介面在沒開 vlan-filtering 的 bridge 上：詳情標出 vlan-filtering 與 VLAN 埠設定沒有作用
    const unf = App.snap.model.interfaces.find((i) => i.vlanUnfiltered && i.vlanFiltering == null && (i.pvid != null || i.frameTypes));
    if (unf) { App.select({ type: 'interface', key: unf.key }); if (!text('#detail').includes('沒有作用（bridge 沒開 vlan-filtering）')) throw new Error('未過濾的 bridge port 應標出 VLAN 設定沒有作用'); }
    const br = App.snap.model.interfaces.find((i) => i.vlanFiltering === false);
    if (br) { App.select({ type: 'interface', key: br.key }); if (!text('#detail').includes('vlan-filtering')) throw new Error('bridge 詳情應列出 vlan-filtering'); }
    if (!process.env.SMOKE_INPUT && !br) throw new Error('範例資料應有沒開 vlan-filtering 的 bridge');
    App.select(null);
  });
  await step('L2 埠圖：聚合可收合與展開、點選埠在右側顯示介面詳情、鍵盤可走到埠、說明寫出沒畫的 MNDP；大型資料只畫一台設備與鄰居', async () => {
    const g = App.graph; const Q = App.Q;
    await timed('L2（聚合收合）', () => App.showLayer('l2'));
    const e0 = App.layerEntry();
    if (e0.info.tooBig) {
      if (e0.info.scope !== 'focus' || !$('#layer-note').textContent.includes('超過上限') || !Array.from($('#l2-scope').querySelectorAll('option')).find((o) => o.value === 'all').disabled) throw new Error('設備超過 L2_MAX 時應只畫選取的設備與鄰居，並說明原因、停用「整張圖」');
      const other = Q.devices().find((d) => d.collected && !g.nodeById.has(d.key));
      if (other) { await timed('L2 改以其他設備為中心', () => App.select({ type: 'device', key: other.key })); if (App.l2.focus !== other.key || !g.nodeById.has(other.key)) throw new Error('選取不在圖上的設備時，L2 應改以它為中心'); }
    } else if (e0.info.scope !== 'all') throw new Error('設備沒有超過上限時應畫整張圖');
    if (e0.info.omitted.domainOnly && !$('#layer-note').textContent.includes('MNDP')) throw new Error('說明應寫出沒畫的 MNDP 鏈路');
    if (!process.env.SMOKE_INPUT && !e0.info.omitted.domainOnly) throw new Error('範例資料應有只有 MNDP 的鏈路');
    const lagPort = g.nodes.find((n) => n.kind === 'port' && n.port.members.length);
    if (!lagPort) { if (process.env.SMOKE_INPUT) { App.showLayer('device'); return; } throw new Error('範例資料應有聚合介面'); }
    const collapsedPos = App.layerEntry().pos;
    $('#btn-l2-lag').click(); await App.layerJob;
    if (App.l2.lag !== 'expand' || $('#btn-l2-lag').getAttribute('aria-checked') !== 'true') throw new Error('按「展開聚合」應展開');
    const members = lagPort.port.members;
    if (!members.every((m) => g.nodeById.has(m) && g.nodeById.get(m).port.lag === lagPort.id)) throw new Error('展開後聚合的成員應各自是埠，並指向所屬聚合');
    if (g.nodeById.has(lagPort.id) && g.nodeById.get(lagPort.id).port.members.length) throw new Error('展開後聚合介面不應再列成員');
    $('#btn-l2-lag').click(); await App.layerJob;
    if (App.l2.lag !== 'collapse' || !g.nodeById.has(lagPort.id) || members.some((m) => g.nodeById.has(m)) || App.layerEntry().pos !== collapsedPos) throw new Error('再按一次應收合，並回到收合時的位置');
    // 點選埠：右側顯示介面詳情
    const port = g.nodes.find((n) => n.kind === 'port' && n.ifc);
    g.emit('click', { type: 'node', id: port.id });
    if (!App.sel || App.sel.type !== 'interface' || App.sel.key !== port.ifc || !text('#detail').includes(Q.getInterface(port.ifc).name)) throw new Error('點選埠應在右側顯示介面詳情');
    if (!g.sel.nodes.has(port.id)) throw new Error('選取的埠應在 L2 圖上標示');
    // 點選設備框：與設備圖相同的設備詳情
    const box = g.nodes.find((n) => n.box && n.collected); g.emit('click', { type: 'node', id: box.id });
    if (App.sel.type !== 'device' || App.sel.key !== box.id) throw new Error('點選設備框應開啟設備詳情');
    // 鍵盤：N 依設備框、再依它的埠輪流，Enter 開啟
    const cv = $('#graph'); cv.focus(); App.select(null);
    let reached = null; for (let i = 0; i < 400 && !reached; i++) { cv.dispatch('keydown', { key: 'n' }); const n = g.nodeById.get(g.kbd); if (n && n.kind === 'port' && n.ifc) reached = n; }
    if (!reached) throw new Error('N 應能移到埠');
    cv.dispatch('keydown', { key: 'Enter' });
    if (!App.sel || App.sel.type !== 'interface' || App.sel.key !== reached.ifc) throw new Error('在埠上按 Enter 應開啟介面詳情');
    cv.dispatch('keydown', { key: 'Escape' }); if (App.sel) throw new Error('Esc 應取消選取');
    if (!/L2/.test(cv.getAttribute('aria-label'))) throw new Error('畫布的 aria-label 應說明目前的層級');
    // 拖曳埠等於拖曳它的設備框
    const parent = reached.anchor.parent; const before = Object.assign({}, g.pos.get(parent)); const p0 = g.toScreen(g.at(reached.id));
    const fire = (t, pt) => (winListeners[t] || []).forEach((f) => f({ target: cv, clientX: pt.x, clientY: pt.y, pointerId: 3, pointerType: 'mouse', button: 0, preventDefault() {} }));
    cv.dispatch('pointerdown', { clientX: p0.x, clientY: p0.y, pointerId: 3, pointerType: 'mouse', button: 0 }); fire('pointermove', { x: p0.x + 40, y: p0.y }); fire('pointerup', { x: p0.x + 40, y: p0.y });
    if (Math.abs(g.pos.get(parent).x - before.x - 40 / g.s) > 0.01 || g.pos.has(reached.id)) throw new Error('拖曳埠應移動它的設備框，埠本身不存位置');
    App.select(null); App.showLayer('device');
  });
  await step('L2 埠圖全圖看得清楚：內建與分層版面都依目標寬高比折行（不是一條扁平橫條），直式更直長；全圖時設備框在螢幕上讀得到', async () => {
    const g = App.graph; const L = S.view.layout; const B = S.view.theme.l2.box;
    App.showLayer('l2'); await App.layerJob; const e = App.layerEntry();
    const ratio = (pos) => {
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      e.boxes.forEach((b) => { const p = pos.get(b.id); x0 = Math.min(x0, p.x - b.box.w / 2); x1 = Math.max(x1, p.x + b.box.w / 2); y0 = Math.min(y0, p.y - b.box.h / 2); y1 = Math.max(y1, p.y + b.box.h / 2); });
      return (y1 - y0) / Math.max(1, x1 - x0);
    };
    if (e.boxes.length >= 12) {
      const land = ratio(L.portLayout(e.boxes, e.ports, e.pg.edges).pos); const port = ratio(L.portLayout(e.boxes, e.ports, e.pg.edges, { portrait: true }).pos);
      const el = ratio((await L.elkPorts(e.boxes, e.ports, e.pg.edges, {})).pos); const elp = ratio((await L.elkPorts(e.boxes, e.ports, e.pg.edges, { portrait: true })).pos);
      [['內建', land], ['分層', el]].forEach(([w, r]) => { if (r < 0.35) throw new Error(`L2 ${w}版面（橫式）不應是扁平橫條：高寬比 ${r.toFixed(2)}`); });
      [['內建', land, port], ['分層', el, elp]].forEach(([w, a, b]) => { if (!(b > a) || b < 0.6) throw new Error(`L2 ${w}版面（直式）應比橫式直長：${a.toFixed(2)} → ${b.toFixed(2)}`); });
      // 1440 寬時的圖區約 710×850：全圖後設備框在螢幕上至少 10px 高
      const cv = $('#graph'); const rect = cv.getBoundingClientRect;
      try {
        cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 710, height: 850 }); g.resize(); g.fit();
        if (g.s * B.h < 10) throw new Error(`L2 全圖後設備框太小：${(g.s * B.h).toFixed(1)}px（倍率 ${g.s.toFixed(3)}）`);
      } finally { cv.getBoundingClientRect = rect; g.resize(); }
    }
    App.showLayer('device');
  });
  await step('圖上的覆蓋層：圖例展開時限制高度、內部捲動，操作提示讓位；層級說明在圖例按鈕上方；窄螢幕工具列有底色、L2 的次要選項收進「顯示 ▾」', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    const rule = (sel) => { const m = css.match(new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); return m ? m[1] : ''; };
    // 窄螢幕（max-width: 900px）的區塊：依大括號配對取出內容
    const media = (q) => { let out = ''; let i = 0; while ((i = css.indexOf('@media ' + q, i)) >= 0) { let d = 0; let j = css.indexOf('{', i); const st = j; for (; j < css.length; j++) { if (css[j] === '{') d++; else if (css[j] === '}' && !--d) break; } out += css.slice(st + 1, j); i = j; } return out; };
    const narrow = media('(max-width: 900px)');
    if (!/max-height/.test(rule('.legend'))) throw new Error('圖例應限制最大高度');
    if (!/overflow(-y)?:\s*auto/.test(rule('.legend .legend-body'))) throw new Error('圖例內容超過高度時應在內部捲動');
    const head = document.querySelector('#legend .legend-head');
    head.click(); if (!$('#legend').classList.contains('open')) throw new Error('圖例展開時應標記 open');
    if (!/\.legend\.open\s*~\s*\.hint\s*\{[^}]*(display:\s*none|visibility:\s*hidden)/.test(css)) throw new Error('圖例展開時操作提示應讓位');
    head.click(); if ($('#legend').classList.contains('open')) throw new Error('圖例收合時應拿掉 open');
    const note = rule('.layer-note');
    if (!/bottom:\s*calc\([^;]*var\(--control-h\)/.test(note)) throw new Error('層級說明應在圖例按鈕（高度 --control-h）的上方：' + note);
    if (!/max-height/.test(note) || !/overflow(-y)?:\s*auto/.test(note)) throw new Error('層級說明太長時應限制高度並捲動');
    if (!/\.toolbar\s*\{[^}]*background:\s*var\(--overlay/.test(narrow)) throw new Error('窄螢幕的工具列應有底色，圖上的文字不從按鈕之間露出');
    const vm = $('#view-menu');
    ['#btn-l2-lag', '#btn-l2-ports'].forEach((s) => {
      const b = $(s);
      if (!vm.contains(b) || b.getAttribute('role') !== 'menuitemcheckbox' || !b.classList.contains('menu-item') || b.dataset.layers !== 'l2' || b.dataset.keep === undefined) throw new Error(`${s} 應收進「顯示 ▾」（只在 L2 顯示的勾選項目）`);
    });
    App.showLayer('l2'); await App.layerJob;
    if ($('#btn-l2-lag').classList.contains('hidden') || !$('#btn-hosts').parentNode || $('#btn-unknown').classList.contains('hidden') === false) throw new Error('L2 時「顯示 ▾」應列出 L2 的選項、隱藏設備圖專用的項目');
    $('#btn-l2-ports').click(); await App.layerJob;
    if (App.l2.ports !== 'all' || $('#btn-l2-ports').getAttribute('aria-checked') !== 'true' || !$('#btn-l2-ports').classList.contains('on')) throw new Error('勾選「全部的埠」應畫全部的埠並標出勾選');
    $('#btn-l2-ports').click(); await App.layerJob;
    if (App.l2.ports !== 'linked' || $('#btn-l2-ports').getAttribute('aria-checked') !== 'false') throw new Error('再按一次應回到只有接線的埠');
    App.showLayer('device');
    if (!$('#btn-l2-lag').classList.contains('hidden')) throw new Error('設備圖時不顯示 L2 的選項');
    // 其他樣式：窄螢幕歡迎卡左右留邊、深色的原生勾選框、「依設備排序」切換鈕有框線、建立基準對話框的輸入框依視窗高度讓出下方的列
    if (!/\.welcome \.card\s*\{[^}]*(margin|width)[^}]*16px/.test(narrow)) throw new Error('窄螢幕的歡迎卡左右應留 16px');
    if (!/accent-color:\s*var\(--accent\)/.test(css)) throw new Error('原生勾選框應用強調色（accent-color）');
    if (!/\.export-by-device\s*\{[^}]*border-color:\s*var\(--line-strong\)/.test(css)) throw new Error('「依設備排序」切換鈕應有框線');
    if (!/height:\s*[^;]*calc\([^;]*vh/.test(rule('#input-text'))) throw new Error('建立基準的輸入框高度應扣掉對話框其他列，命名規則列不被按鈕列切掉');
  });
  await step('聚焦與縮放：選取的節點依鄰居方向偏移、群框左緣在畫面外時不標分群、放大時線寬不跟著變粗；窄螢幕分群標籤至少保留「分群 N」', async () => {
    const g = App.graph; const cv = $('#graph'); const rect = cv.getBoundingClientRect; const EDGE = S.view.theme.edge; const TERMS = S.view.TERMS;
    try {
      cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 710, height: 850 }); g.resize();
      const nb = (id) => (g.edgesByNode.get(id) || []).map((x) => (x.a === id ? x.b : x.a)).filter((m) => g.isVisible(g.nodeById.get(m)));
      const hub = g.nodes.filter((n) => !n.virtual && g.isVisible(n)).sort((a, b) => nb(b.id).length - nb(a.id).length)[0];
      App.select({ type: 'device', key: hub.id }, { focus: true });
      const v = g.viewport(); const c = { x: (v.x0 + v.x1) / 2, y: (v.y0 + v.y1) / 2 }; const p = g.toScreen(g.at(hub.id));
      const ns = nb(hub.id).map((id) => g.toScreen(g.at(id))); const m = { x: ns.reduce((s, q) => s + q.x, 0) / ns.length, y: ns.reduce((s, q) => s + q.y, 0) / ns.length };
      if (p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) throw new Error('聚焦的節點應在畫面內');
      if (ns.some((q) => q.x < v.x0 || q.x > v.x1 || q.y < v.y0 || q.y > v.y1) && Math.hypot(m.x - p.x, m.y - p.y) > 40 && !(Math.hypot(m.x - c.x, m.y - c.y) < Math.hypot(m.x - p.x, m.y - p.y) - 1)) {
        throw new Error(`鄰居在畫面外時，選取的節點應往鄰居的反方向偏移，讓出鄰居那一側：節點 ${Math.round(p.x)},${Math.round(p.y)}、中心 ${Math.round(c.x)},${Math.round(c.y)}、鄰居重心 ${Math.round(m.x)},${Math.round(m.y)}`);
      }
      // 群框左緣在畫面外：不標（只看到一部分，標籤會浮在圖中間）
      g.fit(); g.computeGroups(); const gb = (g.groupBoxes || []).find((x) => x.frame && x.name);
      if (gb) {
        g.s = 1.5; g.tx = -60 - gb.x0 * g.s; g.ty = v.y0 + 120 - gb.y0 * g.s; g.hoverGroup = null; g.draw();
        if (g.groupLabels.some((l) => l.name === gb.name)) throw new Error('群框左緣在畫面外時不應標分群：' + gb.name);
      }
      // 線寬：放大到 200% 時螢幕上的線寬不比 100% 粗
      const multi = g.edges.find((x) => x.count > 1 && g._edgeVisible(x) && !x.virtual);
      if (multi) {
        const st = EDGE[multi.cls] || EDGE.other; const a = g.at(multi.a); const b = g.at(multi.b);
        const widthAt = (s) => { g.s = s; g.tx = g.w / 2 - ((a.x + b.x) / 2) * s; g.ty = g.h / 2 - ((a.y + b.y) / 2) * s; const op = recordCanvas(g.ctx, () => g.draw()).find((o) => o.op === 'stroke' && o.style === st.c && o.path.length === 2); return op.width * s; };
        const w1 = widthAt(1); const w2 = widthAt(2);
        if (w2 > w1 + 1e-6) throw new Error(`放大時線寬不應跟著變粗：100% ${w1.toFixed(2)}px → 200% ${w2.toFixed(2)}px`);
      }
      // 窄螢幕：分群標籤至少留「分群 N」，不只剩數字
      cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 600 }); g.resize();
      // 設備圖的分群名稱有括號（「分群 2（設備…）」），L2 埠圖的沒有（「分群 2」）：兩種都至少保留「分群 N」
      for (const layer of ['device', 'l2']) {
        App.showLayer(layer); await App.layerJob; g.fit(); g.hoverGroup = null; g.draw();
        const bad = g.groupLabels.filter((l) => l.name.startsWith(TERMS.group) && !l.text.startsWith(TERMS.group));
        if (bad.length) throw new Error(`窄螢幕的分群標籤應保留「${TERMS.group} N」（${layer}）：` + bad.map((l) => l.text).join('、'));
      }
      App.showLayer('device');
    } finally { cv.getBoundingClientRect = rect; g.resize(); App.select(null); g.fit(); }
  });
  await step('L3 網段圖：網段文字太小時不畫；main 以外 VRF 的設備節點寫「名稱（VRF）」，不顯示 @', async () => {
    const g = App.graph; const F = S.view.theme.font; const K = S.keys;
    App.showLayer('l3'); await App.layerJob;
    const vrfNodes = g.nodes.filter((n) => n.kind !== 'subnet' && n.vrf && n.vrf !== K.MAIN_VRF);
    vrfNodes.forEach((n) => { if (n.label.includes('@') || !n.label.endsWith(`（${n.vrf}）`)) throw new Error('VRF 設備節點的標籤應是「名稱（VRF）」：' + n.label); });
    if (!process.env.SMOKE_INPUT && !vrfNodes.length) throw new Error('範例資料應有 main 以外的 VRF');
    const sn = g.nodes.find((n) => n.kind === 'subnet');
    if (sn) {
      const p = g.at(sn.id); const texts = (s) => { g.s = s; g.tx = g.w / 2 - p.x * s; g.ty = g.h / 2 - p.y * s; return recordCanvas(g.ctx, () => g.draw()).filter((o) => o.op === 'text' && o.font.includes(F.mono) && o.text.startsWith(sn.subnet.id.slice(0, 4))); };
      if (!texts(1).length) throw new Error('100% 時應畫網段文字');
      if (texts((F.minPx - 1) / 11).length) throw new Error('網段文字在螢幕上小於最小字級時不應畫');
    }
    App.showLayer('device'); g.fit();
  });
  await step('L3 網段圖：網段與設備是節點，推論的邊是弱線型；重疊網段與重複 IP 標在圖上、點選網段在右側列出位址、設備、重疊、重複 IP 與來源；可顯示路由（虛線箭頭）', async () => {
    const g = App.graph; const Q = App.Q; const T = S.view.theme;
    await timed('L3', () => App.showLayer('l3'));
    const subnets = g.nodes.filter((n) => n.kind === 'subnet');
    if (!subnets.length || !g.nodes.some((n) => n.kind !== 'subnet')) throw new Error('L3 應有子網與設備節點');
    if (!g.edges.filter((e) => e.l3).every((e) => (e.l3.inferred ? e.evidence === 'hearsay' : e.evidence === 'adjacency'))) throw new Error('推論的位址邊（鄰居、管理 IP）應用弱線型');
    const sg = Q.subnetGraph();
    const ov = sg.subnets.find((s) => s.overlaps.length); const dupS = sg.subnets.find((s) => s.duplicateIps.length);
    if (!process.env.SMOKE_INPUT) {
      const s24 = sg.subnets.find((s) => s.id === '10.1.10.0/24');
      if (!s24 || !s24.overlaps.includes('10.1.10.0/25') || !s24.duplicateIps.includes('10.1.10.99')) throw new Error('範例資料的 10.1.10.0/24 應與 /25 重疊，且有重複 IP 10.1.10.99');
    }
    if (ov) {
      const n = g.nodeById.get('net|' + ov.id);
      if (!n.badges.some((b) => b.includes('重疊'))) throw new Error('重疊的子網應有「重疊網段」標籤');
      const oe = g.edges.find((e) => e.overlap && e.overlap.includes(ov.id) && e.overlap.includes(ov.overlaps[0]));
      if (!oe || oe.style !== T.l3.overlap || oe.sev !== 'warn') throw new Error('重疊的網段之間應有警告外形的虛線');
      g.emit('click', { type: 'edge', id: oe.id }); if (!App.sel || App.sel.type !== 'subnet') throw new Error('點重疊的線應開啟子網');
      App.select(App.sel, { focus: true }); // 移到子網，畫面內才會畫
      const ops = recordCanvas(g.ctx, () => g.draw());
      if (!ops.some((o) => o.op === 'text' && o.text.startsWith('重疊網段'))) throw new Error('畫布上應寫出「重疊網段」');
    }
    if (dupS) {
      if (!g.nodeById.get('net|' + dupS.id).badges.some((b) => b.includes('重複 IP'))) throw new Error('有重複 IP 的子網應有標籤');
      g.emit('click', { type: 'node', id: 'net|' + dupS.id });
      const t = text('#detail');
      if (App.sel.type !== 'subnet' || App.sel.key !== dupS.id) throw new Error('點子網應選取子網');
      ['位址', '設備', '重複 IP', dupS.duplicateIps[0], '來源', 'VRF'].concat(dupS.overlaps.length ? ['重疊網段', dupS.overlaps[0]] : []).forEach((w) => { if (!t.includes(w)) throw new Error('子網詳情應列出：' + w); });
      if (!g.sel.nodes.has('net|' + dupS.id)) throw new Error('選取的子網應在圖上標示');
      // 重疊網段可以點：開啟另一個子網
      if (dupS.overlaps.length) {
        $('#detail').testAll('a').find((a) => a.textContent === dupS.overlaps[0]).click();
        if (App.sel.type !== 'subnet' || App.sel.key !== dupS.overlaps[0]) throw new Error('點重疊網段應開啟那個子網');
      }
      $('#detail').testAll('a').find((a) => a.textContent.startsWith(S.readers.PASTE) || /第 \d+ 行/.test(a.textContent)).click();
      if (!$('#dlg-raw').open) throw new Error('子網的來源行應可開啟原文'); $('#dlg-raw').close();
    }
    // 點選設備：與設備圖相同
    const devNode = g.nodes.find((n) => n.kind !== 'subnet' && n.collected);
    g.emit('click', { type: 'node', id: devNode.id }); if (App.sel.type !== 'device' || !text('#detail').includes(Q.getDevice(devNode.dev || devNode.id).name)) throw new Error('點設備應開啟設備詳情');
    // 鍵盤：N 走到子網，Enter 開啟子網詳情
    const cv = $('#graph'); cv.focus(); App.select(null); let sn = null;
    for (let i = 0; i < 300 && !sn; i++) { cv.dispatch('keydown', { key: 'n' }); const n = g.nodeById.get(g.kbd); if (n && n.kind === 'subnet') sn = n; }
    cv.dispatch('keydown', { key: 'Enter' }); if (!sn || App.sel.type !== 'subnet') throw new Error('N 應走到子網，Enter 開啟子網詳情');
    // 顯示路由：沿用原本的位置，只多出路由與目的網段
    const before = new Map(App.layerEntry().pos);
    $('#btn-l3-routes').click(); await App.layerJob;
    if (!App.l3.routes || $('#btn-l3-routes').getAttribute('aria-pressed') !== 'true') throw new Error('按「顯示路由」應開啟');
    const routes = g.edges.filter((e) => e.route);
    if (Q.subnetGraph({ routes: true }).routes.length && (!routes.length || !routes.every((e) => e.arrow && e.style === T.l3.route && T.l3.route.dash.length && g.nodeById.has(e.b)))) throw new Error('路由應以虛線箭頭畫到目的子網');
    if (!process.env.SMOKE_INPUT && !routes.some((e) => e.route.default)) throw new Error('範例資料應有預設路由');
    before.forEach((p, id) => { const q = App.layerEntry().pos.get(id); if (q && (q.x !== p.x || q.y !== p.y)) throw new Error('顯示路由不應重排已有的節點'); });
    // VRF 的說明只在基準有兩個以上的 VRF 時出現（只用 main 的網路與加入 VRF 之前相同）
    if (!$('#layer-note').textContent.includes('路由') || (Q.vrfs().length > 1 && !$('#layer-note').textContent.includes('VRF'))) throw new Error('L3 的說明應寫出路由（有多個 VRF 時也寫出 VRF）');
    if (routes.length) { g.emit('hover', { item: { type: 'edge', id: routes[0].id }, x: 0, y: 0 }); if (!text('#tooltip').includes('路由')) throw new Error('路由的提示應說明'); }
    App.graph.draw();
    $('#btn-l3-routes').click(); await App.layerJob;
    if (App.l3.routes || g.edges.some((e) => e.route)) throw new Error('再按一次應隱藏路由');
    App.select(null); App.showLayer('device');
  });
  await step('匯出 PNG 是目前的層級', async () => {
    const g = App.graph; const VA = S.view.app;
    const shot = async (layer) => {
      App.showLayer(layer); await App.layerJob;
      let drawn = null; const oldDraw = g.draw; g.draw = function () { drawn = this.nodes; return oldDraw.call(this); };
      try { const { files } = await captureDownloads(() => VA.exportPng()); return { files, drawn }; } finally { g.draw = oldDraw; }
    };
    const want = { device: 'topology.png', l2: 'topology-l2.png', l3: 'topology-l3.png' };
    for (const layer of ['l2', 'l3', 'device']) {
      const made = []; const oldCreate = document.createElement;
      document.createElement = (t) => { const el = oldCreate(t); if (t === 'a') made.push(el); return el; };
      let r; try { r = await shot(layer); } finally { document.createElement = oldCreate; }
      if (made.length !== 1 || made[0].download !== want[layer]) throw new Error(`${layer} 匯出的檔名應是 ${want[layer]}：${made.map((a) => a.download).join()}`);
      const kinds = new Set(r.drawn.map((n) => n.kind));
      if (layer === 'l2' && !kinds.has('port')) throw new Error('L2 匯出時畫的應是 L2 埠圖');
      if (layer === 'l3' && !kinds.has('subnet')) throw new Error('L3 匯出時畫的應是 L3 子網圖');
      if (layer === 'device' && (kinds.has('port') || kinds.has('subnet'))) throw new Error('設備圖匯出時不應畫 L2／L3');
    }
    // L4 是矩陣不是畫布：不匯出 PNG，以 banner 說明改用 CSV
    App.showLayer('l4'); await App.l4Job;
    const none = await captureDownloads(() => VA.exportPng());
    if (none.files.length || !text('#banner').includes('CSV')) throw new Error('L4 不應匯出 PNG，並說明改用 CSV');
    App.showLayer('device');
  });
};
