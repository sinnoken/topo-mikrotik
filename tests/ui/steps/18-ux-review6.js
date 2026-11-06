// 畫面冒煙測試的 step：第六次 UX 評審的修正——L4 不被工具列蓋住、窄螢幕的提示與分類列、表格改直排、L4 圖例與 VRF 寫法、
// 運作時間的來源、工具列一列、修正指令的用字、路由追蹤的錯誤說明、設定不整頁捲動、沒有基準時的步驟列、歡迎畫面的綁定時機。
// 模擬 DOM 沒有版面：位置以 getBoundingClientRect 的關係與 CSS 規則斷言，實際的矩形另以截圖工具（rects.json）確認。
'use strict';
const { S, fs, path, ROOT, step, buildInput, clearBaseline, $, text, L4, stepBtn, hubBtn } = require('../helpers.js');

/** 顯示 L4、展開內部互通並等矩陣畫好（App.l4Job 只等暴露清單，矩陣在展開時才計算，放在 App.l4MatrixJob） */
async function showMatrix() {
  App.showStep('view'); App.showLayer('l4'); await App.l4Job;
  const f = $('#l4-matrix-fold'); if (!(f.open || f.getAttribute('open') != null)) { f.setAttribute('open', ''); f.open = true; f.dispatch('toggle'); }
  await App.l4MatrixJob;
  // 檢視方式是記憶體中的檢視狀態（前面的步驟可能切到表格）：這裡要看矩陣
  const mb = L4().testAll('.l4-modes button').find((b) => b.dataset.mode === 'matrix');
  if (mb.getAttribute('aria-pressed') !== 'true') { mb.click(); await App.l4MatrixJob; }
  if (!L4().testAll('.l4-grid').length) throw new Error('展開內部互通後應畫出矩陣：' + text('#l4-status'));
}
const css = () => fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** 最後一個 @media (max-width: 900px) 區塊之外，所有窄螢幕區塊的內容（依序串起來） */
function narrowCss() {
  const c = css(); const out = []; const re = /@media \(max-width: 900px\) \{/g; let m;
  while ((m = re.exec(c))) {
    let i = m.index + m[0].length; let depth = 1;
    for (; i < c.length && depth; i++) { if (c[i] === '{') depth++; else if (c[i] === '}') depth--; }
    out.push(c.slice(m.index + m[0].length, i - 1));
  }
  return out.join('\n');
}
/** 規則的宣告（選擇器完全相同的規則，依先後合併） */
function decls(src, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = {};
  for (const m of src.matchAll(new RegExp('(?:^|[}\\s])' + esc + '\\s*\\{([^}]*)\\}', 'g'))) {
    for (const d of m[1].matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) out[d[1]] = d[2].trim();
  }
  return out;
}
const rectBottom = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height; };

module.exports = async () => {
  await step('UX6 H1：L4 的捲動區從工具列下緣開始（標題與明細不被浮動工具列蓋住），底下的畫布不露出', async () => {
    await buildInput(S.samples['sample-bundle.txt']);
    await showMatrix();
    const v = L4(); const top = parseFloat(v.style.top);
    const tb = $('#toolbar'); const stage = $('#stage');
    const need = rectBottom(tb) - stage.getBoundingClientRect().top;
    if (!(top >= need)) throw new Error(`L4 的上緣（${v.style.top}）應在工具列下緣（${need}px）之下`);
    if (!stage.classList.contains('l4-on')) throw new Error('L4 時 #stage 應標 l4-on（畫布不露出）');
    const c = css();
    if (!/\.stage\.l4-on\s+#graph\s*\{[^}]*visibility:\s*hidden/.test(c)) throw new Error('L4 時畫布應隱藏（工具列旁不露出拓樸圖）');
    if (decls(c, '.l4')['padding-top'] === '50px') throw new Error('L4 不應再以固定的 padding-top 讓出工具列');
    App.showLayer('device');
    if (stage.classList.contains('l4-on')) throw new Error('離開 L4 後應拿掉 l4-on');
  });

  await step('UX6 M1、M2、M3、M14：窄螢幕的操作提示在圖例按鈕上方；設定分類換行不捲出畫面；命名規則與 L4 的表格改直排', async () => {
    const n = narrowCss();
    const hint = decls(n, '.hint');
    if (!/var\(--control-h\)/.test(hint.bottom || '')) throw new Error('窄螢幕的操作提示應在圖例按鈕（高度 --control-h）上方：' + JSON.stringify(hint));
    const tabs = decls(n, '.settings-tabs');
    if (tabs['flex-wrap'] !== 'wrap' || /auto|scroll/.test(tabs['overflow-x'] || '')) throw new Error('窄螢幕的設定分類應換行，不在列內橫向捲動（「關於」不在畫面外）：' + JSON.stringify(tabs));
    if (!/table\.t\.stack[^{]*\{[^}]*display:\s*block/.test(n) || !/td\[data-label\]::before\s*\{[^}]*content:\s*attr\(data-label\)/.test(n)) throw new Error('窄螢幕的 .stack 表格應改成直排，每格前面寫欄名');
    // V.table 的 stack：表格標 stack，每格帶欄名
    const t = S.view.table([{ t: '甲', f: (r) => r.a }, { t: '乙', f: (r) => r.b, s: (r) => r.b }], [{ a: '1', b: '2' }], { stack: true });
    const table = t.querySelector('table');
    if (!table.classList.contains('stack') || table.testAll('td').map((x) => x.getAttribute('data-label')).join() !== '甲,乙') throw new Error('V.table 的 stack 選項應標 stack 並在每格帶 data-label');
    // 命名規則的表格：每格帶欄名；「目前的基準」不留白
    App.openSettings('profiles');
    const pt = $('#settings').testAll('table').find((x) => x.classList.contains('settings-profiles'));
    if (!pt || !pt.classList.contains('stack')) throw new Error('命名規則的表格應可直排');
    const cells = pt.testAll('td');
    if (cells.some((x) => x.getAttribute('data-label') === null)) throw new Error('命名規則的每一格都應帶欄名');
    const used = cells.filter((x) => x.getAttribute('data-label') === '目前的基準');
    if (!used.length || used.some((x) => !x.textContent.trim())) throw new Error('「目前的基準」不應留白');
    S.view.app.closeSettings();
    // L4 的位址組（下鑽）是直排表格
    await showMatrix();
    const cell = L4().testAll('.l4-cell').find((x) => x.dataset.status === 'partial') || L4().testAll('.l4-cell').find((x) => x.dataset.status !== 'empty');
    if (!cell) throw new Error('範例資料的矩陣應有可下鑽的格子');
    cell.click();
    const gt = $('#l4-drill').testAll('table')[0];
    if (!gt || !gt.classList.contains('stack')) throw new Error('L4 的位址組表格應可直排（窄螢幕時結果與狀態不被切掉）');
    App.showLayer('device');
  });

  await step('UX6 M4、M5、M6：L4 圖例有「＋? 部分無法判斷」；格子的「結果不一」只用短標不蓋住數字；zone 的網段寫成（VRF …）', async () => {
    await showMatrix();
    const leg = $('#l4-legend');
    const inc = leg.testAll('.l4-legend-item').find((x) => x.getAttribute('data-legend') === 'incomplete');
    if (!inc || !inc.textContent.includes('＋?') || !inc.textContent.includes(S.view.L4_INCOMPLETE)) throw new Error('L4 圖例應有「＋? ' + S.view.L4_INCOMPLETE + '」');
    const het = L4().testAll('.l4-cell').find((x) => x.classList.contains('het'));
    if (!het) throw new Error('範例資料的矩陣應有結果不一的格子（WAN → VLAN 20）');
    { const b = het.testAll('.l4-het')[0];
      if (!b || b.textContent.trim() !== '≠' || !/結果不一/.test(b.getAttribute('title') || '')) throw new Error('格子的結果不一應是短標「≠」（完整說法在 title）：' + (b && b.textContent)); }
    const lh = leg.testAll('.l4-legend-item').find((x) => x.getAttribute('data-legend') === 'heterogeneous');
    if (!lh || lh.testAll('.l4-het')[0].textContent.trim() !== '≠' || !lh.textContent.includes('結果不一')) throw new Error('圖例的結果不一應和格子同一個短標');
    if (decls(css(), '.l4-cell .l4-het').position === 'absolute') throw new Error('格子的結果不一不應絕對定位（會蓋住數字）');
    // zone 的依據：網段不外露內部鍵（10.1.20.0/24@cust-a），寫法和 zone 名稱相同
    if (!$('#view-l4').testAll('.l4-zone-row').length) throw new Error('L4 應列出 zone 的依據');
    const zt = $('#view-l4').textContent;
    if (/\d\/\d+@[\w-]+/.test(zt)) throw new Error('zone 的依據不應外露「網段@VRF」：' + (zt.match(/\S*\d\/\d+@[\w-]+/) || [])[0]);
    const multi = App.Q.vrfs().length > 1;
    if (multi && !/\d\/\d+（VRF [\w-]+）/.test(zt)) throw new Error('main 以外的 VRF 的網段應寫成「網段（VRF 名稱）」');
    if (S.view.inVrfText('10.0.0.0/24@x') !== '10.0.0.0/24（VRF x）' || S.view.inVrfText('10.0.0.0/24') !== '10.0.0.0/24') throw new Error('V.inVrfText 應把 K.inVrf 的鍵寫成「位址（VRF 名稱）」，main 不加');
    App.showLayer('device');
  });

  await step('UX6 M8：運作時間沒有收集時間時說明來源，不寫「收集時間不明」', () => {
    const d = App.Q.devices().find((x) => x.uptime && !x.uptime.collectedAt);
    if (!d) return;
    App.select({ type: 'device', key: d.key });
    const t = text('#detail');
    if (t.includes('收集時間不明')) throw new Error('運作時間不應寫「收集時間不明」（和下方的收集時間看起來矛盾）');
    if (!t.includes('/system resource')) throw new Error('運作時間應說明是 /system resource 的值');
    App.select(null);
  });

  await step('UX6 M9：「匯出 PNG」收進「顯示 ▾」，工具列在 1440 寬時排成一列', () => {
    const png = $('#btn-png'); const vm = $('#view-menu');
    if (!vm.contains(png) || png.getAttribute('role') !== 'menuitem' || !png.classList.contains('menu-item')) throw new Error('「匯出 PNG」應是「顯示 ▾」的選單項目');
    // 設備圖時顯示的群組：層級、VLAN、圖的操作、路由追蹤（量測：1440 寬時四組合計約 690px，中間欄 710px）
    App.showLayer('device'); let shown = 0;
    for (const g of $('#toolbar').children) if (g.classList.contains('grp') && !g.classList.contains('hidden')) shown++;
    if (shown > 4) throw new Error('設備圖時工具列的群組太多：' + shown);
  });

  await step('UX6 M10：修正的產出一律叫「修正指令」，畫面不寫 patch', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const titles = Array.from(html.matchAll(/(?:title|aria-label)="([^"]*)"/g)).map((m) => m[1]).filter((x) => /\bpatch\b/i.test(x));
    if (titles.length) throw new Error('index.html 的提示不應寫 patch：' + titles.join('／'));
    const seen = [];
    ['about', 'help'].forEach((s) => { App.openSettings(s); seen.push(text('#settings')); });
    S.view.app.closeSettings();
    App.openHub(); seen.push(text('#hub')); S.view.app.closeHub();
    App.showStep('fix'); seen.push(text('#view-patch')); App.showStep('verify'); seen.push(text('#view-verify'));
    const hit = seen.join('\n').replace(/ssot-patch\/\d+|patch-summary[\w.-]*/g, '').match(/.{0,12}\bpatch\b.{0,12}/i);
    if (hit) throw new Error('畫面不應再寫 patch（統一叫「修正指令」）：' + hit[0]);
    App.openSettings('about');
    if (!/修正指令/.test(text('#settings'))) throw new Error('「關於」的資料格式應寫「修正指令」');
    S.view.app.closeSettings(); App.showStep('triage');
  });

  await step('UX6 M11：路由追蹤的錯誤寫明怎麼做（在 VRF 選單指定），不顯示查詢層的原始字串', () => {
    const Q = App.Q; const multi = Q.ipEntries().find((r) => Q.findIp(r.ip).vrfs.length > 1);
    if (!multi) return;
    const other = Q.ipEntries().find((r) => r.ip !== multi.ip && r.owner && r.vrf === S.keys.MAIN_VRF);
    const r = S.trace(Q, other.ip, multi.ip); const back = S.trace(Q, multi.ip, other.ip);
    if (back.ok || !back.vrfs) throw new Error('前提：回程的起點在多個 VRF');
    App.select({ type: 'trace', result: r.ok ? r : back, reverse: r.ok ? back : null, vrf: null });
    const t = text('#detail');
    if (/請指定 vrf/.test(t)) throw new Error('不應顯示查詢層的原始字串「請指定 vrf」');
    if (!/VRF 選單/.test(t)) throw new Error('應說明在路由追蹤的 VRF 選單指定：' + t.slice(0, 300));
    App.select(null);
  });

  await step('UX6 M12：指定分類開啟設定時，焦點移到分類標題但不捲動整頁（左側分類不被頁首切掉）', () => {
    const proto = Object.getPrototypeOf($('#graph')); const orig = proto.focus; const calls = [];
    const origScroll = proto.scrollIntoView; const scrolled = [];
    proto.focus = function (o) { calls.push({ id: this.id, o }); return orig.call(this, o); };
    proto.scrollIntoView = function (o) { scrolled.push(this.id); return origScroll.call(this, o); };
    try { App.openSettings('help'); } finally { proto.focus = orig; proto.scrollIntoView = origScroll; }
    const f = calls.find((x) => x.id === 'settings-panel-title');
    if (!f || !f.o || f.o.preventScroll !== true) throw new Error('聚焦分類標題應帶 preventScroll');
    if (scrolled.includes('settings-panel-title') || scrolled.includes('settings-title')) throw new Error('開啟設定不應把標題捲到頁首（會切掉左側分類）');
    if ($('#settings').scrollTop !== 0) throw new Error('開啟設定時從頂端開始');
    S.view.app.closeSettings();
  });

  await step('UX6 #43：F13 的「查看管理面設定」以 facet 對應啟用中的 community，不標出停用的同名 community；「關於」寫出 CSP 的 sha256', async () => {
    const lines = ['PD (10.0.2.1):', '### /export terse', '/interface list add name=WAN', '/snmp set enabled=yes',
      '/snmp community set [ find default=yes ] disabled=yes', '/snmp community add name=public addresses=10.0.0.0/8', ''];
    await buildInput(lines.join('\n') + '\n');
    const Q = App.Q; const ms = Q.mgmtOf('PD');
    const comms = ms.snmp.communities || [];
    if (comms.length !== 2 || comms.some((c) => c.facet !== 'public') || comms.filter((c) => c.disabled === false).length !== 1) throw new Error('前提：PD 有停用與啟用的兩個 public，facet 都是 public');
    const fi = Q.findings().findIndex((f) => f.id === 'F13' && f.facet === 'public');
    if (fi < 0) throw new Error('前提：啟用的 public 有 F13');
    App.select({ type: 'device', key: 'PD' });
    const go = $('#detail').testAll('.finding').filter((el) => el.textContent.includes(Q.finding(fi).message)).map((el) => el.testAll('.mgmt-goto')[0]).find(Boolean);
    if (!go) throw new Error('F13 應有「查看管理面設定」');
    go.click();
    const on = $('#detail').testAll('.mgmt-row').filter((r) => r.classList.contains('focus'));
    if (on.length !== 1 || on[0].getAttribute('data-facet') !== 'public' || !on[0].textContent.includes('啟用')) throw new Error('只標出啟用中的 public，不標停用的同名 community：' + on.map((r) => r.textContent.slice(0, 60)).join('／'));
    if ($('#detail').testAll('.mgmt-row').some((r) => r.getAttribute('data-finding-idxs') !== null)) throw new Error('community 列以 data-facet 對應，不再另記 data-finding-idxs');
    if ('communityFacet' in S.view.remediation) throw new Error('V.remediation.communityFacet 只在 facetText 內部使用，不對外公開');
    App.select(null);
    App.openSettings('about');
    if (!/sha256/.test(text('#settings'))) throw new Error('「關於」應說明 script-src 只放行內嵌配色那一段的 sha256');
    S.view.app.closeSettings();
  });

  await step('UX6 M13、r22-3：沒有基準時步驟列標「輸入」是目前的一步；歡迎畫面的按鈕在 init 的第一個 await 之前綁定', async () => {
    await clearBaseline();
    if (App.snap) throw new Error('前提：已清除基準');
    if (stepBtn('input').getAttribute('aria-current') !== 'step' || stepBtn('triage').getAttribute('aria-current') === 'step') throw new Error('沒有基準時目前的一步應是「輸入」，不是「研判」');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    if (!/id="step-input"[^>]*aria-current="step"/.test(html) || /id="step-triage"[^>]*aria-current="step"/.test(html)) throw new Error('index.html 的初始步驟列應標「輸入」');
    const src = fs.readFileSync(path.join(ROOT, 'src/view/app.js'), 'utf8');
    const init = src.slice(src.indexOf('async function init()'));
    const bind = init.indexOf('A.bindWelcome()'); const wait = init.indexOf('await ');
    if (bind < 0 || bind > wait) throw new Error('歡迎畫面的按鈕應在 init 的第一個 await 之前綁定（A.bindWelcome）');
    await buildInput(S.samples['sample-bundle.txt']);
    if (stepBtn('input').getAttribute('aria-current') === 'step') throw new Error('有基準後「輸入」不是目前的一步（資料中心沒開）');
  });

  await step('UX6 L1、L2、L3 的設定與用字：設定「一般」每個選項的說明都在名稱下一行；畫面文字用全形「／」；「本機資料」不寫技術用語', async () => {
    App.openSettings('general');
    const opts = $('#settings').testAll('.settings-option');
    if (!opts.length) throw new Error('前提：設定「一般」有選項');
    opts.forEach((o) => {
      const t = o.testAll('.settings-option-text')[0];
      const name = t && t.testAll('.settings-option-name')[0]; const tip = t && t.testAll('.settings-option-tip')[0];
      if (!t || !name || !tip || !t.testAll('br').length || t.childNodes.indexOf(name) > t.childNodes.indexOf(tip)) throw new Error('每個選項的名稱與說明應排成同一種（說明在名稱的下一行）：' + o.textContent);
    });
    const halfSlash = (s) => (s.match(/.{0,8}\S \/ \S.{0,8}/) || [])[0];
    const general = text('#settings'); S.view.app.closeSettings();
    App.openHub(); const hubText = text('#hub'); S.view.app.closeHub();
    App.showStep('view'); App.showLayer('l4'); await App.l4Job; const l4Text = text('#view-l4'); App.showLayer('device');
    [['設定・一般', general], ['資料中心', hubText], ['L4', l4Text]].forEach(([k, s]) => { const hit = halfSlash(s); if (hit) throw new Error(`${k} 的畫面文字應用全形「／」：${hit}`); });
    App.openSettings('data'); await S.view.settings.data.refresh();
    const dt = text('#settings');
    if (/localStorage）|JSON 序列化/.test(dt)) throw new Error('「本機資料」不應寫 localStorage、JSON 序列化等技術用語');
    const cap = $('#settings').testAll('caption')[0];
    if (!cap || !/^共 [\d.]+ (B|KB|MB)$/.test(cap.textContent.trim())) throw new Error('總大小只寫「共 N KB」：' + (cap && cap.textContent));
    S.view.app.closeSettings();
  });

  await step('UX6 L4：命名規則「套用結果」的選單顯示規則名稱（和表格的主要欄位一致），值仍是 ID', () => {
    App.openSettings('profiles');
    const sel = $('#settings-profile-cov');
    if (!sel) throw new Error('前提：有基準時有「套用結果」的選單');
    const P = S.view.settings.profiles;
    sel.testAll('option').forEach((o) => {
      const p = S.profiles[o.value]; const nm = P.nameOf(p);
      if (!p) throw new Error('選單的值應是命名規則的 ID：' + o.value);
      if (nm && !o.textContent.startsWith(nm)) throw new Error(`選單應顯示名稱「${nm}」：${o.textContent}`);
    });
    S.view.app.closeSettings();
  });

  await step('UX6 L5、L6：L4 只在頁首標一次推論（表頭不逐一掛徽章，輔助科技仍念得到）；種類寫「介面清單」；圖例說明虛擬 zone 與只當目的的 zone', async () => {
    await showMatrix();
    const grid = L4().testAll('.l4-grid')[0];
    if (!grid) throw new Error('範例資料的 zone 不超過上限，內部互通應是矩陣（grid）');
    if (grid.testAll('.l4-zone-inf').length) throw new Error('矩陣的表頭不應每個都掛「推論」徽章');
    { const inf = App.Q.zoneMatrix({}).zones.filter((z) => z.inferred);
      if (inf.length && !grid.testAll('th').some((th) => th.testAll('.sr-only').some((x) => x.textContent.includes('推論')))) throw new Error('推論的 zone 仍應讓輔助科技念出「推論」'); }
    const head = L4().testAll('.work-head')[0];
    if (!head || !head.testAll('.chip').some((c) => c.textContent === '推論')) throw new Error('L4 的頁首應標一次「推論」');
    if (S.view.ZONE_SOURCE['interface-list'] !== '介面清單') throw new Error('zone 種類應寫「介面清單」，不寫 RouterOS 原值 interface list');
    if (L4().testAll('.l4-zone-src').some((x) => x.textContent === 'interface list')) throw new Error('zone 種類標籤不應寫 interface list');
    const virt = App.Q.zoneMatrix({}).zones.filter((z) => z.virtual);
    const leg = $('#l4-legend').testAll('.l4-legend-item').concat($('#l4-legend').testAll('.l4-note')).find((x) => x.getAttribute('data-legend') === 'virtual');
    if (virt.length) {
      if (!leg || !leg.textContent.includes(S.view.ZONE_SOURCE.virtual)) throw new Error('圖例應說明「' + S.view.ZONE_SOURCE.virtual + '」的 zone');
      virt.forEach((z) => {
        if (!leg.textContent.includes(z.name)) throw new Error('圖例應列出虛擬 zone：' + z.name);
        if (z.dstOnly && !/只當目的/.test(leg.textContent)) throw new Error('圖例應說明「' + z.name + '」為什麼只在目的欄');
      });
    }
    App.showLayer('device');
  });

  await step('UX6 L7：管理面設定的數量寫明是檢查結果、列出 F10–F14 的標題、項目名稱大小寫一致、「出廠」有說明', async () => {
    const lines = ['PD (10.0.2.1):', '### /export terse', '/interface list add name=WAN', '/snmp set enabled=yes',
      '/snmp community set [ find default=yes ] disabled=yes', '/snmp community add name=public addresses=10.0.0.0/8', ''];
    await buildInput(lines.join('\n') + '\n');
    App.select({ type: 'device', key: 'PD' });
    const sec = $('#detail').testAll('.mgmt-section')[0];
    const n = App.Q.findingsFor('device', 'PD').filter((f) => /^F1[0-4]$/.test(f.id)).length;
    const sum = sec.testAll('summary')[0];
    if (!sum || !sum.textContent.includes(`${n} 筆檢查結果`)) throw new Error('管理面設定標題旁的數量應寫明是檢查結果：' + (sum && sum.textContent));
    ['F10', 'F11', 'F12', 'F13', 'F14'].forEach((id) => { const r = S.query.rule(id); if (!sec.textContent.includes(`${id} ${r.title}`)) throw new Error('應列出檢查的標題：' + id); });
    const labels = sec.testAll('.mgmt-row').map((r) => r.testAll('b')[0].textContent);
    const lower = labels.filter((l) => /^[a-z]/.test(l));
    if (lower.length) throw new Error('項目名稱的大小寫應一致（不以小寫英文開頭）：' + lower.join('、'));
    const chip = sec.testAll('.chip').find((c) => c.textContent === '出廠');
    if (!chip) throw new Error('前提：PD 有出廠的 community');
    if (!chip.getAttribute('title') || !/「出廠」/.test(sec.textContent.replace(chip.textContent, ''))) throw new Error('「出廠」徽章應有說明（提示與文字）');
    App.select(null);
    await buildInput(S.samples['sample-bundle.txt']);
  });

  await step('UX6 L8、L9：「依設備排序」看得出是選項（勾選框，不和匯出按鈕排在一起）；工作包內容沒用到的寫「未使用」', () => {
    App.openHub();
    const t = hubBtn('by-device'); const md = hubBtn('export-markdown');
    if (t.parentNode === md.parentNode) throw new Error('「依設備排序」不應夾在匯出按鈕之間');
    const box = () => hubBtn('by-device').testAll('.hub-check')[0];
    const before = hubBtn('by-device').getAttribute('aria-pressed') === 'true';
    if (!box() || box().textContent !== (before ? '☑' : '☐')) throw new Error('「依設備排序」應有勾選框的外形');
    hubBtn('by-device').click();
    if (box().textContent !== (before ? '☐' : '☑')) throw new Error('切換後勾選框應跟著改變');
    hubBtn('by-device').click();
    const roles = S.view.app.workpackRoles();
    roles.filter((x) => (x.role === 'profile' || x.role === 'expected-data') && !x.available).forEach((x) => {
      if (x.note !== '未使用') throw new Error(`工作包的「${x.label}」沒用到時寫「未使用」，不重複名稱：${x.note}`);
    });
    S.view.app.closeHub();
  });
};
