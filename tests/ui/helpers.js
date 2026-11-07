// 畫面冒煙測試的共用小工具。step 檔只從這裡取得名稱（也轉出 dom.js、harness.js、boundary.js 的匯出）。
'use strict';
const dom = require('./dom.js');
const harness = require('./harness.js');
const boundary = require('./boundary.js');
const { document } = dom;
const { fs, path, ROOT, S } = harness;
const $ = (s) => document.querySelector(s);
const text = (sel) => $(sel).textContent;

// 攔下本機下載：模擬 URL.createObjectURL／revokeObjectURL 與 <a download>，讀回每個下載的檔名與內容。
// Node 沒有 Blob 時補一個最小實作
if (!globalThis.Blob) globalThis.Blob = class { constructor(parts, o) { this.buf = Buffer.from(parts.join(''), 'utf8'); this.type = o.type; } async arrayBuffer() { return this.buf; } };
async function captureDownloads(fn) {
  const made = []; const revoked = []; const anchors = [];
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, append: document.body.appendChild };
  URL.createObjectURL = (b) => { made.push(b); return 'blob:smoke/' + made.length; };
  URL.revokeObjectURL = (u) => revoked.push(u);
  document.body.appendChild = function (c) { if (c.tagName === 'A') anchors.push(c); return orig.append.call(this, c); };
  try { await fn(); await new Promise((r) => setTimeout(r, 5)); } finally {
    URL.createObjectURL = orig.create; URL.revokeObjectURL = orig.revoke; document.body.appendChild = orig.append;
  }
  const bytes = await Promise.all(made.map(async (b) => Buffer.from(await b.arrayBuffer())));
  return { made, revoked, anchors, files: anchors.map((a, i) => ({ name: a.getAttribute('download'), bytes: bytes[i], text: bytes[i] ? bytes[i].toString('utf8') : '' })) };
}
/** 依 RFC 4180 解析 CSV（引號內可有逗號、引號與換行） */
const parseCsv = (t) => {
  const rows = [[]]; let cell = ''; let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { rows[rows.length - 1].push(cell); cell = ''; }
    else if (c === '\r' && t[i + 1] === '\n') { rows[rows.length - 1].push(cell); cell = ''; rows.push([]); i++; }
    else cell += c;
  }
  if (rows[rows.length - 1].length === 0 && cell === '') rows.pop(); else rows[rows.length - 1].push(cell);
  return rows;
};
/** WCAG 2 對比：'#rrggbb' 或 'rgba(r,g,b,a)'（半透明色先疊在 base 上） */
const rgbOf = (c, base) => {
  const m = String(c).match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (m) { const a = m[4] == null ? 1 : +m[4]; const b = base ? rgbOf(base) : [255, 255, 255]; return [1, 2, 3].map((i) => +m[i] * a + b[i - 1] * (1 - a)); }
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error('無法解析的顏色：' + c);
  const n = parseInt(c.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255];
};
const luminance = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrastOf = (fg, bg, base) => { const [a, b] = [luminance(rgbOf(fg, base)), luminance(rgbOf(bg, base))].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); };
/** 讀 app.css 的 :root 變數 */
const cssVars = (css) => Object.fromEntries(Array.from(css.match(/:root\s*\{([^}]*)\}/)[1].matchAll(/--([\w-]+):\s*([^;]+);/g)).map((m) => [m[1], m[2].trim()]));
/** 深色的 :root 變數（:root[data-theme="dark"]，由 A.applyColorScheme 設定），沒有覆寫的沿用亮色 */
const cssDarkRoot = (css) => { const m = css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/); if (!m) throw new Error('app.css 應有 :root[data-theme="dark"]'); return m[1]; };
const cssVarsOf = (css, mode) => (mode === 'dark'
  ? Object.assign(cssVars(css), Object.fromEntries(Array.from(cssDarkRoot(css).matchAll(/--([\w-]+):\s*([^;]+);/g)).map((m) => [m[1], m[2].trim()])))
  : cssVars(css));
const SCHEMES = ['light', 'dark'];
/** 依序套用亮、暗兩組配色執行 fn(mode)（只改 theme 的值，不重畫），結束後一定回到原本的配色 */
function forSchemes(fn) {
  const T = globalThis.SSOT.view.theme; const prev = T.mode;
  try { SCHEMES.forEach((m) => { T.apply(m); fn(m); }); } finally { T.apply(prev); }
}
/** dir（相對於專案根目錄）底下所有 .js 檔的相對路徑（靜態掃描用） */
const jsFiles = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? jsFiles(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
/** CATALOG 文字去掉反引號（畫面把反引號內的指令改成 <code>，textContent 不含反引號） */
const unticked = (t) => String(t).replace(/`([^`]+)`/g, '$1');
/** 記錄 Canvas 的路徑與填色／描邊（模擬 context 的方法本身不做事）：回傳每次 fill／stroke 的樣式與路徑點 */
function recordCanvas(ctx, fn) {
  const names = ['beginPath', 'moveTo', 'lineTo', 'arc', 'closePath', 'fill', 'stroke', 'fillText', 'fillRect', 'setLineDash'];
  const old = Object.fromEntries(names.map((k) => [k, ctx[k]])); const ops = []; let path = []; let dash = [];
  ctx.setLineDash = (d) => { dash = d.slice(); };
  ctx.beginPath = () => { path = []; };
  ctx.moveTo = (x, y) => path.push({ t: 'M', x, y }); ctx.lineTo = (x, y) => path.push({ t: 'L', x, y });
  ctx.arc = (x, y, r) => path.push({ t: 'A', x, y, r }); ctx.closePath = () => path.push({ t: 'Z' });
  ctx.fill = () => ops.push({ op: 'fill', style: ctx.fillStyle, alpha: ctx.globalAlpha, path: path.slice() });
  ctx.stroke = () => ops.push({ op: 'stroke', style: ctx.strokeStyle, width: ctx.lineWidth, alpha: ctx.globalAlpha, dash: dash.slice(), path: path.slice() });
  ctx.fillText = (s, x, y) => ops.push({ op: 'text', text: String(s), style: ctx.fillStyle, font: ctx.font, x, y });
  ctx.fillRect = (x, y, w, h) => ops.push({ op: 'rect', style: ctx.fillStyle, x, y, w, h });
  try { fn(); } finally { Object.assign(ctx, old); }
  return ops;
}
/** 暫時換成測試用的圖資料，結束後還原 */
function withGraph(graph, nodes, edges, pos, fn) {
  const old = { nodes: graph.nodes, edges: graph.edges, pos: graph.pos, sel: graph.sel, hl: graph.hl, hover: graph.hover, s: graph.s, tx: graph.tx, ty: graph.ty, visible: graph.visible, groupBoxes: graph.groupBoxes };
  try { graph.setData(nodes, edges, pos); graph.hl = null; graph.hover = null; graph.visible = () => true; graph.groupBoxes = null; graph.setSelection([], []); graph.fit(); return fn(); } finally {
    graph.setData(old.nodes, old.edges, old.pos); graph.setSelection(old.sel.nodes, old.sel.edges); graph.setHighlight(old.hl);
    Object.assign(graph, { hover: old.hover, s: old.s, tx: old.tx, ty: old.ty, visible: old.visible, groupBoxes: old.groupBoxes }); graph.redraw();
  }
}
/** 路徑的頂點數（arc 記為 0，代表圓形） */
const vertices = (path) => (path.some((p) => p.t === 'A') ? 0 : path.filter((p) => p.t === 'M' || p.t === 'L').length);
const near = (path, q, d) => path.length && path.every((p) => p.t === 'Z' || Math.hypot(p.x - q.x, p.y - q.y) <= d);
/** 畫在 a→b 上、垂直於線的短刻度（每段 M→L 垂直於線、中點落在線上），顏色為 color */
function tickStrokes(ops, a, b, color) {
  const dx = b.x - a.x; const dy = b.y - a.y; const L = Math.hypot(dx, dy); if (!L) return [];
  return ops.filter((o) => o.op === 'stroke' && o.style === color && o.path.length >= 2 && o.path.length % 2 === 0 && o.path.every((p, i) => p.t === (i % 2 ? 'L' : 'M')) &&
    o.path.every((p, i) => {
      if (i % 2) return true; const q = o.path[i + 1]; const sx = q.x - p.x; const sy = q.y - p.y; const sl = Math.hypot(sx, sy);
      const mx = (p.x + q.x) / 2; const my = (p.y + q.y) / 2; const t = ((mx - a.x) * dx + (my - a.y) * dy) / (L * L);
      const off = Math.abs((mx - a.x) * dy - (my - a.y) * dx) / L;
      return sl > 0 && Math.abs(sx * dx + sy * dy) / (sl * L) < 0.02 && t >= 0 && t <= 1 && off < 0.01 * L + 0.5;
    }));
}
/** VLAN 只有一端（partial）的線在縮小、100%、200% 時都有刻度，螢幕上的刻度長度比線寬明顯長（看得出來） */
function checkTicks(g, a, b, where) {
  const T = S.view.theme; const st = T.vlan.partial; const t = st.ticks; const old = { s: g.s, tx: g.tx, ty: g.ty };
  try {
    for (const s of [0.5, 1, 2]) {
      g.s = s; g.tx = g.w / 2 - ((a.x + b.x) / 2) * s; g.ty = g.h / 2 - ((a.y + b.y) / 2) * s;
      const ops = recordCanvas(g.ctx, () => g.draw()); const ts = tickStrokes(ops, a, b, st.c);
      if (!ts.length) throw new Error(`${where}：縮放 ${s * 100}% 時，只有一端的鏈路應畫垂直短刻度`);
      const k = Math.max(s, 1); const o = ts[0]; const seg = Math.hypot(o.path[1].x - o.path[0].x, o.path[1].y - o.path[0].y);
      if (Math.abs(o.width * s - t.w * k) > 1e-6 || Math.abs(seg * s - t.len * k) > 1e-6) throw new Error(`${where}：縮放 ${s * 100}% 時刻度大小應同 theme.vlan.partial.ticks（縮小時維持螢幕大小）`);
      const line = ops.find((x) => x.op === 'stroke' && x.style === st.c && x.path.length === 2 && x.path[0].t === 'M' && near(x.path.slice(0, 1), a, 1e-6) && near(x.path.slice(1), b, 1e-6));
      if (!line || line.dash.length) throw new Error(`${where}：只有一端的鏈路本身應是實線`);
      if (seg * s < line.width * s * 1.5) throw new Error(`${where}：縮放 ${s * 100}% 時刻度應明顯長於線寬`);
    }
  } finally { Object.assign(g, old); g.redraw(); }
}

/** 在輸入框貼上文字並建立基準，等到新的基準載入 */
async function buildInput(input) {
  // 建立進行中時 #input-build 是 disabled（runBuild 在第一個 await 前設定、finally 才解除）。模擬 DOM 的 click 不看 disabled，
  // 所以先等前一次建立完成再按，並等這次建立完成才返回；否則前一次晚到的建立會在返回後換掉基準
  const btn = $('#input-build');
  const idle = async (what) => {
    for (let i = 0; i < 4000 && btn.disabled; i++) await new Promise((r) => setTimeout(r, 5));
    if (btn.disabled) throw new Error('逾時：' + what + '：' + text('#input-status'));
  };
  await idle('等前一次建立完成');
  $('#input-text').value = input; btn.click();
  await idle('等這次建立完成');
  const hash = S.util.hash(S.readers.PASTE + '\n' + input);
  if (!App.snap || App.snap.meta.inputHash !== hash) throw new Error('基準未建立：' + text('#input-status'));
  await App.layoutJob;
}

/** 資料中心（#hub）裡 data-action 為 action 的按鈕；輸入與輸出的入口集中在這裡 */
const hubBtn = (action) => $('#hub').testAll('button').find((b) => b.getAttribute('data-action') === action);
/** 流程步驟（#steps）的按鈕：input、view、triage、fix、verify；goStep 和使用者一樣點一下切換 */
const stepBtn = (s) => document.testAll('#steps button').find((b) => b.dataset.step === s);
const goStep = (s) => stepBtn(s).click();
/** 設定（#settings）的分頁；clearBaseline 和使用者一樣在設定「本機資料」按「清除基準…」（confirm 由模擬的 window 回答），之後關閉設定 */
const settingsTab = (id) => $('#settings').testAll('.settings-tab').find((b) => b.dataset.section === id);
const clearBaseline = async () => {
  App.openSettings('data'); $('#btn-clear').click(); await new Promise((r) => setTimeout(r, 20)); S.view.app.closeSettings();
};
/** 在頁首搜尋框輸入並等下拉更新，回傳下拉的項目 */
const searchFor = async (v) => { const inp = $('#search'); inp.value = v; inp.dispatch('input'); await new Promise((r) => setTimeout(r, 150)); return $('#search-dd').testAll('.item'); };
/** 「檢視」清單的下拉（.inv-kind 清單種類、.inv-filter 種類內篩選）：選取 value 並觸發 change */
const pickInv = (cls, value) => { const el = $('#pane-inventory .' + cls); if (!el) throw new Error('清單缺少下拉 ' + cls); el.value = value; el.dispatch('change'); };
/** 等到條件成立（非同步的建立、讀入、重建）；逾時時丟錯並說明在等什麼 */
async function until(cond, what) {
  for (let i = 0; i < 8000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error('逾時：' + what);
}

// ------------------------------------------------------------ 主題之間共用的小工具（原本寫在 step 之間）
// ------------------------------------------------------------ M1：L2／L3 視圖
const layerBtn = (l) => document.testAll('#layer-switch button').find((b) => b.getAttribute('data-layer') === l);
const timed = async (label, fn) => { const t0 = Date.now(); await fn(); await App.layerJob; if (process.env.SMOKE_INPUT) console.log(`      ${label}：${Date.now() - t0} ms`); };
// ------------------------------------------------------------ M2：L4 可達性（zone 矩陣、下鑽、可達性查詢）
const L4 = () => $('#view-l4');
const l4Cells = () => L4().testAll('.l4-cell');
const l4State = () => S.view.l4.state();
const cellTd = (src, dst) => l4Cells().find((t) => t.dataset.src === src && t.dataset.dst === dst);
const svcParts = (id) => { const [proto, port] = id.split('/'); return { proto, port: port === undefined ? null : Number(port) }; };
/** 下鑽中某一組的服務按鈕；那一組收起時（異質格子只列造成差異的組、或全部拒絕的組）先按顯示全部 */
const l4SvcBtn = (gi, svc) => {
  const find = () => $('#l4-drill').testAll('.l4-svc').find((b) => b.dataset.group === String(gi) && b.dataset.service === svc);
  if (!find()) { const t = $('#l4-drill').querySelector('.l4-show-all') || $('#l4-drill').querySelector('.l4-hide-deny'); if (t) t.click(); }
  if (!find()) throw new Error(`下鑽應有第 ${gi + 1} 組 ${svc} 的按鈕`);
  return find();
};
// ------------------------------------------------------------ M3：VRF（範例資料的 PE 有 VRF、與 main 重疊的位址與路由洩漏，CE 有策略路由）
/** 範例資料中，非 main 的 VRF 裡也出現在 main 的 IP（位址重疊） */
const overlapIp = (Q) => (Q.ipEntries().find((r) => r.vrf !== S.keys.MAIN_VRF && r.owner && Q.findIp(r.ip).vrfs.length > 1) || {}).ip;
/** 跨 step 檔的狀態：ackedKey 是處理紀錄中已處理的 finding 鍵（10-ledger-firewall 記下，16-hub-store 確認清除基準後仍在） */
const shared = { ackedKey: null };
/** 所有 step 檔的原始碼（用字檢查掃 step 名稱用）；tests/ui/steps 依檔名排序 */
const stepSources = () => fs.readdirSync(path.join(__dirname, 'steps')).filter((f) => f.endsWith('.js')).sort()
  .map((f) => fs.readFileSync(path.join(__dirname, 'steps', f), 'utf8')).join('\n');

// ------------------------------------------------------------ 右欄詳情與表格視窗（防火牆）的容器
// 斷言一律經這些 helper，不直接寫 '#detail'：防火牆搬進視窗後，否定斷言才不會在只剩摘要的右欄上空跑通過
/** 右欄的詳細資料 */
const detailRoot = () => $('#detail');
/** 表格視窗（V.tableDialog）的內容；視窗沒開時直接失敗 */
const fwRoot = () => { if (!$('#dlg-table').open) throw new Error('表格視窗（防火牆）應是開著的'); return $('#tdlg-body'); };
/** 視窗的左欄（分頁與表格）與右欄（選取那一列的詳情或總覽） */
const fwList = () => fwRoot().querySelector('#tdlg-list');
const fwSide = () => fwRoot().querySelector('#tdlg-side');
const fwText = () => fwRoot().textContent;
/** 視窗的分頁：切到 key 那一頁並回傳它的內容（找不到就失敗） */
const fwTab = (key) => {
  const b = fwRoot().testAll('.tdlg-tab').find((x) => x.getAttribute('data-tab') === key);
  if (!b) throw new Error('表格視窗應有分頁 ' + key);
  b.click(); return fwRoot().querySelector('#tdlg-panel-' + key);
};
/** 視窗左欄 data-key 為 key 的列（可能有多列：組內與搜尋結果） */
const fwRows = (key) => fwList().testAll('tr').filter((tr) => tr.getAttribute('data-key') === key);
/** 路由表視窗（同一個 V.tableDialog）：開著而且是路由表時回傳視窗內容，否則失敗；左欄、右欄同 fwList／fwSide */
const routesRoot = () => {
  const root = fwRoot(); const d = globalThis.SSOT.view.tableDialog.current();
  if (!d || !d.id.startsWith('routes|')) throw new Error('開著的表格視窗應是路由表：' + (d ? d.id : '沒有'));
  return root;
};
const routesList = () => routesRoot().querySelector('#tdlg-list');
const routesSide = () => routesRoot().querySelector('#tdlg-side');
/** 右欄設備詳情的「路由表」摘要（展開列）；找不到就失敗 */
const routesSummary = () => {
  const el = detailRoot().testAll('.routes-summary')[0];
  if (!el) throw new Error('設備詳情應有路由表的摘要');
  return el;
};

/** 右欄設備詳情的工作入口（nav.work-entries）；找不到就失敗 */
const workEntries = () => {
  const el = detailRoot().querySelector('.work-entries');
  if (!el) throw new Error('設備詳情應有工作入口（路由表、防火牆、管理面設定）');
  return el;
};
/** 工作入口中標籤為 label（「路由表」「防火牆」「管理面設定」）的那一項的值；沒有這一項時 null */
const workEntry = (label) => {
  const ks = workEntries().querySelector('.kv').childNodes;
  const at = ks.findIndex((x) => x.textContent === label);
  return at < 0 ? null : ks[at + 1];
};

/**
 * 清單列出的總筆數：V.bigList／V.paged 分頁時一頁只畫 BIG_LIST.page 列，取那一列所在分頁的頁碼說明「共 N」；
 * 沒有分頁時數畫出來的列。rowSel 是列的選擇器，root 裡第一個符合的列決定是哪一份清單（找不到列時 0）。
 */
const listedTotal = (root, rowSel) => {
  const rows = root.testAll(rowSel); if (!rows.length) return 0;
  let box = rows[0]; while (box && box !== root && !(box.classList && box.classList.contains('biglist-page'))) box = box.parentNode;
  if (!box || box === root) return rows.length;
  const where = box.querySelector('.pager-where');
  if (!where) return box.testAll(rowSel).length;
  const m = where.textContent.match(/共 ([\d,]+)/);
  if (!m) throw new Error('分頁的頁碼說明應寫出總數：' + where.textContent);
  return Number(m[1].replace(/,/g, ''));
};

module.exports = Object.assign({}, dom, harness, boundary, {
  listedTotal, detailRoot, fwRoot, fwList, fwSide, fwText, fwTab, fwRows, routesRoot, routesList, routesSide, routesSummary, workEntries, workEntry,
  captureDownloads, parseCsv, rgbOf, luminance, contrastOf, cssVars, cssDarkRoot, cssVarsOf, SCHEMES, forSchemes, jsFiles, unticked,
  recordCanvas, withGraph, vertices, near, tickStrokes, checkTicks, buildInput, hubBtn, stepBtn, goStep, settingsTab, clearBaseline,
  searchFor, pickInv, until, $, text, stepSources, shared,
  layerBtn, timed, L4, l4Cells, l4State, cellTd, svcParts, l4SvcBtn, overlapIp,
});
