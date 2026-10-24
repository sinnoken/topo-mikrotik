/*
 * 畫面冒煙測試（不需要瀏覽器）：用極簡 DOM 模擬載入 index.html 的所有腳本，
 * 走過「載入範例 → 建立基準 → 點每一筆檢查結果 → 各種選取 → 搜尋 → 路由追蹤 → 比對 → 縮放繪圖」，
 * 確認沒有執行期錯誤。真正的視覺檢查仍需在瀏覽器開啟 index.html。
 *   node tests/ui-smoke.js
 */
'use strict';
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------ 極簡 DOM
class ClassList { constructor(el) { this.el = el; } get set() { return new Set((this.el.attrs.class || '').split(/\s+/).filter(Boolean)); }
  _w(s) { this.el.attrs.class = Array.from(s).join(' '); } add(...c) { const s = this.set; c.forEach((x) => s.add(x)); this._w(s); } remove(...c) { const s = this.set; c.forEach((x) => s.delete(x)); this._w(s); }
  toggle(c, f) { const s = this.set; const on = f === undefined ? !s.has(c) : f; on ? s.add(c) : s.delete(c); this._w(s); return on; } contains(c) { return this.set.has(c); } }
class Node_ { constructor() { this.childNodes = []; this.parentNode = null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); c.parentNode = null; return c; }
  get firstChild() { return this.childNodes[0] || null; } get firstElementChild() { return this.childNodes.find((c) => c instanceof El) || null; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(t) { this.childNodes = []; if (t !== '') this.appendChild(new Text_(String(t))); } }
class Text_ extends Node_ { constructor(t) { super(); this.t = t; } get textContent() { return this.t; } }
class El extends Node_ {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.attrs = {}; this.style = {}; this.listeners = {}; this.classList = new ClassList(this); this.value = ''; this.dataset = {}; this.disabled = false; this.files = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; } get id() { return this.attrs.id; } get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); } removeEventListener() {}
  set onclick(f) { this.listeners.click = [f]; } set onchange(f) { this.listeners.change = [f]; }
  dispatch(t, ev) { (this.listeners[t] || []).forEach((f) => f(Object.assign({ target: this, preventDefault() {}, stopPropagation() {} }, ev || {}))); }
  click() { this.dispatch('click'); }
  focus() { document.activeElement = this; this.dispatch('focus'); } blur() { this.dispatch('blur'); }
  showModal() { this.open = true; } close() { this.open = false; }
  scrollIntoView() {} getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800 }; }
  all() { const out = []; const walk = (n) => n.childNodes.forEach((c) => { if (c instanceof El) { out.push(c); walk(c); } }); walk(this); return out; }
  matches(sel) { if (sel.startsWith('#')) return this.id === sel.slice(1); if (sel.startsWith('.')) return this.classList.contains(sel.slice(1)); return this.tagName === sel.toUpperCase(); }
  // testAll：只給測試程式用的陣列版本。畫面程式用的 querySelectorAll 回傳和瀏覽器一樣的 NodeList（不是陣列），children 是 HTMLCollection
  testAll(sel) { const parts = sel.trim().split(/\s+/); let set = [this];
    parts.forEach((p) => { const next = []; set.forEach((r) => r.all().forEach((e) => { if (e.matches(p) && !next.includes(e)) next.push(e); })); set = next; }); return set; }
  querySelectorAll(sel) { return new NodeList_(this.testAll(sel)); }
  querySelector(sel) { return this.testAll(sel)[0] || null; }
  get children() { return new HTMLCollection_(this.childNodes.filter((c) => c instanceof El)); }
  getContext() { return new Proxy({}, { get: (t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 7 }) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }); }
  toDataURL() { return 'data:,'; }
}
/**
 * 瀏覽器的 NodeList（querySelectorAll）只有 length、索引、item、forEach 與迭代；HTMLCollection（children）連 forEach 都沒有。
 * 模擬 DOM 照這個形狀回傳：畫面程式直接對它呼叫 find、filter、map 等陣列方法時，測試會和瀏覽器一樣丟錯（要先 Array.from）。
 */
class HTMLCollection_ {
  constructor(list) { list.forEach((x, i) => { this[i] = x; }); Object.defineProperty(this, 'length', { value: list.length }); }
  item(i) { return this[i] === undefined ? null : this[i]; }
  [Symbol.iterator]() { let i = 0; return { next: () => (i < this.length ? { value: this[i++], done: false } : { value: undefined, done: true }) }; }
}
class NodeList_ extends HTMLCollection_ { forEach(fn, self) { for (let i = 0; i < this.length; i++) fn.call(self, this[i], i, this); } }
const VOID = new Set(['meta', 'link', 'input', 'br', 'img']);
function parseHtml(html, root) {
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  const re = /<\/?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g; const stack = [root]; let m;
  while ((m = re.exec(html))) {
    if (m[3]) { if (m[3].trim()) stack[stack.length - 1].appendChild(new Text_(m[3])); continue; }
    if (m[0].startsWith('</')) { stack.pop(); continue; }
    const el = new El(m[1]); (m[2].match(/[\w-]+(="[^"]*")?/g) || []).forEach((a) => { const [k, v] = a.split(/=(.*)/s); el.setAttribute(k, v ? v.slice(1, -1) : ''); });
    stack[stack.length - 1].appendChild(el); if (!VOID.has(m[1].toLowerCase()) && !m[0].endsWith('/>')) stack.push(el);
  }
}
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const body = new El('body'); parseHtml(html.split('<body>')[1], body);
const docListeners = {}; const winListeners = {};
// <script src> 動態載入：模擬瀏覽器在下一個事件循環執行檔案並觸發 onload／onerror
const head = new El('head'); const headAppend = head.appendChild.bind(head); const loadedScripts = [];
head.appendChild = (c) => {
  headAppend(c);
  if (c.tagName === 'SCRIPT') setTimeout(() => {
    try { vm.runInThisContext(fs.readFileSync(path.join(ROOT, c.src), 'utf8'), { filename: c.src }); loadedScripts.push(c.src); } catch (e) { return c.onerror && c.onerror(e); }
    if (c.onload) c.onload();
  }, 0);
  return c;
};
const document = { body, head, activeElement: body, createElement: (t) => new El(t), createElementNS: (ns, t) => Object.assign(new El(t), { namespaceURI: ns }), createTextNode: (t) => new Text_(t),
  getElementById: (id) => body.querySelector('#' + id), querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s), testAll: (s) => body.testAll(s),
  addEventListener: (t, f) => (docListeners[t] = docListeners[t] || []).push(f),
  removeEventListener: (t, f) => { docListeners[t] = (docListeners[t] || []).filter((x) => x !== f); } };
let rafQ = [];
const ctx = Object.assign(globalThis, {
  document, window: globalThis, devicePixelRatio: 1, ResizeObserver: class { observe() {} },
  requestAnimationFrame: (f) => { rafQ.push(f); return rafQ.length; }, cancelAnimationFrame: () => {},
  alert: (m) => { throw new Error('alert: ' + m); }, confirm: () => true, indexedDB: undefined, addEventListener: (t, f) => (winListeners[t] = winListeners[t] || []).push(f),
});
void ctx;
delete globalThis.SSOT;
const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
scripts.forEach((s) => vm.runInThisContext(fs.readFileSync(path.join(ROOT, s), 'utf8'), { filename: s }));
const S = globalThis.SSOT; const $ = (s) => document.querySelector(s);
const flushRaf = (n) => { for (let i = 0; i < (n || 3); i++) { const q = rafQ; rafQ = []; q.forEach((f) => f(0)); } };
const text = (sel) => $(sel).textContent;
const steps = [];
const step = async (name, fn) => { try { await fn(); steps.push('  ✓ ' + name); } catch (e) { steps.push('  ✗ ' + name + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n      ')); process.exitCode = 1; } };

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
  $('#input-text').value = input; $('#input-build').click();
  const hash = S.util.hash(S.readers.PASTE + '\n' + input);
  for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
  if (App.snap.meta.inputHash !== hash) throw new Error('基準未建立：' + text('#input-status'));
  await App.layoutJob;
}

/** 資料中心（#hub）裡 data-action 為 action 的按鈕；輸入與輸出的入口集中在這裡 */
const hubBtn = (action) => $('#hub').testAll('button').find((b) => b.getAttribute('data-action') === action);
/** 流程步驟（#steps）的按鈕：input、view、triage、fix、verify；goStep 和使用者一樣點一下切換 */
const stepBtn = (s) => document.testAll('#steps button').find((b) => b.dataset.step === s);
const goStep = (s) => stepBtn(s).click();
/** 等到條件成立（非同步的建立、讀入、重建）；逾時時丟錯並說明在等什麼 */
async function until(cond, what) {
  for (let i = 0; i < 8000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error('逾時：' + what);
}

// ------------------------------------------------------------ 畫面與資料的邊界（靜態掃描 src/view）
/**
 * 去掉 JS 的註解，字串、template 文字與 regex 的內容換成空白（換行保留，行號不變）；template 的 ${} 內是程式碼，保留。
 * 只為邊界掃描用，不是完整的 parser：/ 依前一個有效字元判斷是除號還是 regex。
 */
function stripJs(src) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const n = src.length; const tpl = []; // 每層 template 的 ${} 內目前的大括號深度
  let out = ''; let i = 0; let prev = '';
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (c === '/' && d === '/') { const j = src.indexOf('\n', i); const e = j < 0 ? n : j; out += blank(src.slice(i, e)); i = e; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; out += blank(src.slice(i, e)); i = e; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1; while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out += c + blank(src.slice(i + 1, j)) + c; i = j + 1; prev = c; continue;
    }
    if (c === '`' || (c === '}' && tpl.length && tpl[tpl.length - 1] === 0)) {
      if (c === '}') tpl.pop();
      let j = i + 1; while (j < n && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) { if (src[j] === '\\') j++; j++; }
      out += c + blank(src.slice(i + 1, j));
      if (src[j] === '`') { out += '`'; i = j + 1; prev = '`'; } else { out += '${'; tpl.push(0); i = j + 2; prev = '{'; }
      continue;
    }
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(return|typeof|case|in|of|void)$/.test(out.trimEnd()))) {
      let j = i + 1; let cls = false;
      while (j < n && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      out += '/' + blank(src.slice(i + 1, j)) + '/'; i = j + 1; prev = '/'; continue;
    }
    if (tpl.length && c === '{') tpl[tpl.length - 1]++;
    if (tpl.length && c === '}') tpl[tpl.length - 1]--;
    out += c; if (!/\s/.test(c)) prev = c; i++;
  }
  return out;
}
/** 畫面可以使用的 SSOT 成員：查詢介面、輸入 API、常數、下游 API 與畫面自己的命名空間 */
const VIEW_S_ALLOW = new Set(['query', 'trace', 'util', 'keys', 'VERSION', 'SCHEMA', 'LINK_SCOPE', 'KIND_LABEL', 'build', 'buildAsync', 'inputHashOf',
  'profiles', 'samples', 'compare', 'remediate', 'ledger', 'workpack', 'zip', 'view', 'store']);
/** 只允許其中一個成員的核心命名空間 */
const VIEW_S_ONLY = { readers: 'PASTE', profile: 'compile' };
const VIEW_S_HINT = {
  'check.CATALOG': '(S.query.rule(id) || {}).欄位，或 S.query.rules()（causes／action 只經過 V.remediation.advice）',
  'check.DATA_LABEL': 'S.query.dataLabel(t)', 'check.fmtVlans': 'S.util.fmtVlans(ids)', adapters: 'S.query.adapterLabel(id)',
  readers: '只允許 S.readers.PASTE；建立基準用 S.build／S.buildAsync', profile: '只允許 S.profile.compile',
};
const VIEW_FIELD_HINT = {
  findings: 'Q.findings()／Q.finding(idx)／Q.findingsByRule(id)／Q.findingIndexByKey(key)',
  meta: 'Q.meta()；還沒建立查詢介面的 JSON 用 S.query.metaOf(x)',
  coverage: 'Q.coverage()／Q.coverageOf(devKey)', blocks: 'Q.blocksOf(devKey)／Q.block(id)',
  model: 'Q 的查詢函式（例如 Q.devices()、Q.getDevice(key)）',
};
const VIEW_DEFAULT_HINT = '改用 SSOT.query(snapshot) 或 S.query.* 的查詢函式；沒有合適的函式時請 data-model 新增';
/** 一個畫面檔案違反邊界的地方：[{ line, text }]，text 含檔案、行號、寫法與建議 */
function viewBoundaryViolations(file, src) {
  const out = [];
  stripJs(src).split('\n').forEach((line, n) => {
    const add = (what, hint) => out.push({ line: n + 1, text: `${file}:${n + 1}：${what} → 建議：${hint}` });
    for (const m of line.matchAll(/(?<![\w$.])(?:globalThis\s*\.\s*)?(?:S|SSOT)\s*(?:\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?|\[)/g)) {
      const [all, top, sub] = m;
      if (!top) { add(all.trim() + '…（計算的成員名稱）', '用固定的成員名稱存取允許的 API'); continue; }
      if (VIEW_S_ONLY[top]) { if (sub !== VIEW_S_ONLY[top]) add(`S.${top}${sub ? '.' + sub : ''}`, VIEW_S_HINT[top]); continue; }
      if (!VIEW_S_ALLOW.has(top)) add(`S.${top}${sub ? '.' + sub : ''}`, VIEW_S_HINT[top + '.' + sub] || VIEW_S_HINT[top] || VIEW_DEFAULT_HINT);
    }
    if (/\}\s*=\s*(?:globalThis\s*\.\s*)?(?:S|SSOT)(?![\w$])(?!\s*\.)/.test(line)) add('從 S 解構', '逐一使用允許的 S.* 成員');
    for (const m of line.matchAll(/(?<![\w$])(snap|snapshot)(?![\w$])\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[)/g)) {
      add(`${m[1]}.${m[2] || '[…]'}（讀 Snapshot 欄位）`, VIEW_FIELD_HINT[m[2]] || VIEW_DEFAULT_HINT);
    }
    if (/\bQ\s*\.\s*snapshot(?![\w$])/.test(line)) add('Q.snapshot', VIEW_DEFAULT_HINT);
  });
  return out;
}

(async () => {
  await step('啟動、顯示歡迎畫面', async () => { (docListeners.DOMContentLoaded || []).forEach((f) => f()); await new Promise((r) => setTimeout(r, 20)); if ($('#welcome').classList.contains('hidden')) throw new Error('應顯示歡迎畫面'); });
  await step('離線契約：CSP 禁止網路連線，程式碼不使用網路 API', () => {
    const csp = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
    ["connect-src 'none'", "form-action 'none'", "object-src 'none'", "worker-src 'none'"].forEach((d) => { if (!csp.includes(d)) throw new Error('CSP 缺少 ' + d); });
    if (html.indexOf('Content-Security-Policy') > html.indexOf('<script')) throw new Error('CSP 必須在第一個 <script> 之前');
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
    walk('src').forEach((f) => {
      const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const hit = code.match(/\bfetch\(|XMLHttpRequest|new WebSocket|sendBeacon|EventSource/);
      if (hit) throw new Error(`${f} 使用了網路 API：${hit[0]}`);
    });
  });
  await step('畫面與資料的邊界：src/view 只用允許的 S.* 成員，不讀 Snapshot 欄位（去掉註解後掃描）', () => {
    // 掃描器本身：註解、字串與 regex 內的文字不算；template 的 ${} 內算程式碼
    const probe = [
      '// S.check.CATALOG 與 App.snap.findings 寫在註解中', "const a = '字串中的 App.snap.findings'; const r = /S.check/.test(x);",
      'const b = S.check.CATALOG[id];', 'const c = App.snap.findings[0]; const t = `x ${S.adapters[id].label} y`;',
      'const ok = S.query.rule(id) && S.readers.PASTE && S.profile.compile && S.inputHashOf && SSOT.util.natural && JSON.stringify(snap);',
      'const bad = S.readers.ORDER + S.profile.load; const { check } = S; const m = last.snapshot.meta; const z = Q.snapshot;',
    ].join('\n');
    const got = viewBoundaryViolations('probe.js', probe);
    const lines = got.map((v) => v.line).join();
    if (lines !== '3,4,4,6,6,6,6,6') throw new Error('邊界掃描器的判斷不符（行號 ' + lines + '）：\n' + got.map((v) => v.text).join('\n'));
    if (!got[0].text.includes('probe.js:3') || !got[0].text.includes('S.query.rule')) throw new Error('違規訊息應列出檔案、行號與建議的寫法：' + got[0].text);
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
    const files = walk('src/view');
    if (!files.length) throw new Error('應掃描到 src/view 的檔案');
    const bad = files.flatMap((f) => viewBoundaryViolations(f.split(path.sep).join('/'), fs.readFileSync(path.join(ROOT, f), 'utf8')));
    if (bad.length) throw new Error(`畫面直接讀核心內部或 Snapshot 欄位 ${bad.length} 處：\n` + bad.map((v) => '        ' + v.text).join('\n'));
  });
  await step('NodeList／HTMLCollection：src/view 不對 querySelectorAll、children、childNodes 直接呼叫陣列方法（先 Array.from），也不用測試專用的 testAll', () => {
    // 執行期由模擬 DOM 的 NodeList_／HTMLCollection_ 抓；這裡靜態掃描，涵蓋冒煙測試沒走到的分支
    const probe = "a.querySelectorAll('x').find(f); Array.from(a.querySelectorAll('x')).find(f); a.querySelectorAll('x').forEach(f); el.children.map(f); el.testAll('x');";
    const scan = (src) => stripJs(src).split('\n').flatMap((line, n) => [
      ...Array.from(line.matchAll(/(querySelectorAll\s*\([^()]*\)|\.children|\.childNodes)\s*\.\s*(find|findIndex|filter|map|flatMap|some|every|reduce|indexOf|includes|slice|concat|join|sort)\b/g)).map((m) => `${n + 1}：${m[0]}`),
      ...(/\.testAll\s*\(/.test(line) ? [`${n + 1}：testAll`] : [])]);
    if (scan(probe).length !== 3) throw new Error('掃描器的判斷不符：' + scan(probe).join('、'));
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
    const bad = walk('src/view').flatMap((f) => scan(fs.readFileSync(path.join(ROOT, f), 'utf8')).map((x) => `${f.split(path.sep).join('/')}:${x}`));
    if (bad.length) throw new Error('瀏覽器的 NodeList／HTMLCollection 沒有這些陣列方法，請先 Array.from：\n        ' + bad.join('\n        '));
    const nl = document.querySelectorAll('button');
    if (Array.isArray(nl) || typeof nl.find === 'function' || typeof nl.forEach !== 'function' || typeof body.children.forEach === 'function') throw new Error('模擬 DOM 應回傳 NodeList（有 forEach、沒有 find）與 HTMLCollection（沒有 forEach）');
  });
  await step('ELK 不在啟動時載入', () => { if (globalThis.ELK || loadedScripts.length) throw new Error('ELK 應在第一次需要分層版面時才載入'); });
  await step('載入範例並建立基準', async () => {
    await App.loadSample(); if (!$('#input-text').value.includes('TPE_CORE_RT_01')) throw new Error('範例未載入');
    if (process.env.SMOKE_INPUT) $('#input-text').value = fs.readFileSync(process.env.SMOKE_INPUT, 'utf8');
    const t0 = Date.now();
    $('#input-build').click(); for (let i = 0; i < 4000 && !App.snap; i++) await new Promise((r) => setTimeout(r, 5));
    if (process.env.SMOKE_INPUT) console.log('      建立＋繪製：' + (Date.now() - t0) + ' ms，節點 ' + App.graph.nodes.length);
    if (!App.snap) throw new Error('基準未建立：' + text('#input-status'));
    await App.layoutJob;
    await new Promise((r) => setTimeout(r, 20));
    // 依輸入判斷：範例資料刻意含 K01（LLDP 單向），乾淨的大型網路可能沒有
    const k01 = App.snap.findings.find((f) => f.id === 'K01');
    if (!process.env.SMOKE_INPUT && !k01) throw new Error('範例資料應有 K01（LLDP 單向）');
    if (k01 && !text('#pane-findings').includes(k01.title)) throw new Error('檢查結果未顯示');
    if (!k01 && text('#pane-findings').includes(S.check.CATALOG.K01.title)) throw new Error('沒有 K01 時不應列出 LLDP 單向');
    if (!$('#welcome').classList.contains('hidden')) throw new Error('歡迎畫面未隱藏');
    const collected = App.snap.model.devices.find((device) => device.collected);
    App.select({ type: 'device', key: collected.key });
    if (!$('#detail .chip-list') || !$('#detail .chip-list').testAll('.chip').length) throw new Error('設備收集資料標籤應使用可間隔換行的 chip-list');
  });
  await step('分層版面（ELK）：所有節點都有座標、各群外框不重疊、完成後有提示', async () => {
    if (App.layoutMode !== 'elk') throw new Error('預設應為分層版面');
    if (loadedScripts.join() !== S.view.layout.ELK_SRC) throw new Error('需要分層版面時應載入一次 ELK：' + loadedScripts.join());
    if (process.env.SMOKE_INPUT) console.log('      ' + text('#banner'));
    else if (!text('#banner').includes('已套用分層版面')) throw new Error('分層版面完成後應提示：' + text('#banner'));
    const g = App.graph; const box = new Map();
    g.nodes.forEach((n) => {
      const p = g.pos.get(n.id);
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('節點沒有座標：' + n.id);
      const b = S.util.getOr(box, n.group || '', () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
      b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y); b.x1 = Math.max(b.x1, p.x); b.y1 = Math.max(b.y1, p.y);
    });
    const bs = Array.from(box.entries());
    bs.forEach(([na, a], i) => bs.slice(i + 1).forEach(([nb, b]) => {
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) throw new Error(`分群外框重疊：${na} / ${nb}`);
    }));
  });
  await step('分層版面超過上限時退回現有版面並說明原因', async () => {
    const before = JSON.stringify(Array.from(App.graph.pos));
    const max = App.ELK_MAX; App.ELK_MAX = 1;
    try { $('#btn-relayout').click(); await App.layoutJob; } finally { App.ELK_MAX = max; }
    if (!text('#banner').includes('超過分層版面上限')) throw new Error('應說明分層版面未套用的原因：' + text('#banner'));
    if (JSON.stringify(Array.from(App.graph.pos)) !== before) throw new Error('未套用時不應改動現有位置');
    const sel = $('#layout-mode'); sel.value = 'builtin'; sel.dispatch('change'); await App.layoutJob;
    if (App.layoutMode !== 'builtin') throw new Error('應可切換為快速版面');
    sel.value = 'elk'; sel.dispatch('change'); await App.layoutJob;
  });
  await step('詳情區塊結構一致：標題只由 section() 產生，展開區塊內沒有額外標題', () => {
    const m = App.snap.model; const Q = App.Q;
    const sels = [
      { type: 'device', key: (m.devices.find((d) => d.collected && d.data.includes('route')) || {}).key },
      { type: 'device', key: (m.devices.find((d) => !d.collected) || {}).key },
      { type: 'link', key: (m.links[0] || {}).key }, { type: 'interface', key: (m.interfaces.find((i) => i.macs.length) || {}).key },
      { type: 'mac', key: (m.macs[0] || {}).mac }, { type: 'ip', key: (Q.ipEntries()[0] || {}).ip }, { type: 'vlan', key: String((m.vlans.find((v) => v.id != null) || {}).id) },
      // 防火牆畫面（panels/firewall.js）也只用 section() 產生區塊
      { type: 'firewall', dev: (m.firewallRules[0] || {}).dev, key: (m.firewallRules[0] || {}).dev },
    ];
    if (sels.some((x) => !x.key || x.key === 'undefined')) throw new Error('範例資料應涵蓋每種詳情');
    sels.forEach((sel) => {
      App.select(sel);
      $('#detail').testAll('h3').forEach((x) => {
        if (!/\bdetail-section\b/.test(x.parentNode.className)) throw new Error(`${sel.type} 詳情的標題「${x.textContent}」不是由 section() 產生`);
      });
      $('#detail').testAll('details').forEach((d) => {
        if (d.testAll('h3').length) throw new Error(`${sel.type} 詳情的展開區塊「${d.querySelector('summary').textContent}」內不應有標題`);
      });
    });
    App.select(null);
  });
  await step('推論鏈路：沒有 LLDP 的 CSS610 以推論樣式畫出，提示與詳情說明依據', () => {
    const il = App.Q.inferredLinks(); if (process.env.SMOKE_INPUT && !il.length) return; // 大型乾淨網路沒有 CSS610
    if (!il.length) throw new Error('範例資料應有推論鏈路');
    const p = Array.from(App.pairs.values()).find((x) => x.evidence === 'inferred');
    if (!p) throw new Error('推論鏈路應以推論樣式畫在圖上');
    if (!Array.from(document.testAll('#legend .li')).some((li) => li.textContent === '推論鏈路')) throw new Error('圖例應有推論鏈路');
    App.graph.emit('hover', { item: { type: 'edge', id: p.id }, x: 0, y: 0 });
    if (!text('#tooltip').includes('推論鏈路')) throw new Error('提示應說明是推論鏈路');
    App.graph.emit('click', { type: 'edge', id: p.id });
    if (!text('#detail').includes('MAC 表') || !text('#detail').includes('信心高')) throw new Error('詳情應列出推論依據與信心');
    if (p.links.length) { // 事實在前、推論在後，鏈路表格有自己的標題，不接在推論鏈路下面
      const t = text('#detail'); const iL = t.indexOf('鏈路（LLDP／CDP／MNDP）'); const iI = t.indexOf('推論鏈路（沒有 LLDP）');
      if (iL < 0 || iI < 0 || iL > iI) throw new Error('設備對詳情應先列鏈路（有標題），再列推論鏈路');
    }
    const l = App.Q.getInferredLink(p.inferred[0]); const ep = [l.a, l.b].find((e) => App.Q.getInterface(e));
    App.select({ type: 'interface', key: ep });
    if (!App.graph.sel.edges.has(p.id)) throw new Error('選取介面時應一併標示它的推論鏈路');
    if (!text('#detail').includes('推論鏈路')) throw new Error('介面詳情應列出推論鏈路');
    // 設備圖沒有 L3（OSPF）連線：圖例中標「L3」的只有 L3 子網圖自己的節點與線
    const l3View = ['子網（L3）', '路由（L3）', '網段重疊（L3）'];
    if (Array.from(document.testAll('#legend .li')).some((li) => li.textContent.includes('L3') && !l3View.some((x) => li.textContent.endsWith(x)))) throw new Error('圖上沒有 L3 連線，圖例不應列出');
    App.select(null);
  });
  await step('推定位置：CSS610 底下的主機畫回圖上，點選顯示推定位置', () => {
    const groups = App.Q.behindGroups(); if (process.env.SMOKE_INPUT && !groups.size) return; // 大型乾淨網路沒有 CSS610
    if (!groups.size) throw new Error('範例資料應有推定在 CSS610 底下的終端');
    const [dk, rows] = Array.from(groups.entries())[0];
    const n = App.graph.nodes.find((x) => x.id === '?b|' + rows[0].mac);
    if (!n || n.parent !== dk) throw new Error('推定終端應畫在所屬交換器底下');
    const e = Array.from(App.pairs.values()).find((p) => p.b === n.id);
    if (!e || e.evidence !== 'inferred') throw new Error('推定終端的連線應使用推論樣式');
    App.graph.emit('click', { type: 'node', id: n.id });
    if (App.sel.type !== 'mac' || !text('#detail').includes('推定位置') || !text('#detail').includes('埠不明')) throw new Error('點選推定終端應顯示 MAC 詳情與推定位置');
    const via = App.Q.behindVia(rows[0].mac)[0];
    if (!via || !text('#detail').includes('經由') || !text('#detail').includes('（推論鏈路）')) throw new Error('推定位置應列出經由的推論鏈路');
    const anchorName = App.Q.epName(rows[0].behind.anchor); const t = text('#detail');
    if (t.includes('上行')) throw new Error('MAC 學到的位置沒有方向依據，不應標成上行');
    if (!t.includes(anchorName + ' ⇄ ')) throw new Error('經由的推論鏈路應從錨點埠寫起，與圖上路徑方向一致');
    const pid = App.pairOfLink.get(via.key);
    if (!App.graph.hl || !App.graph.hl.edges.has(pid) || !App.graph.hl.edges.has(e.id)) throw new Error('選取推定終端應標示整段路徑：推論鏈路與終端連線');
    const p = App.pairs.get(pid); App.select({ type: 'pair', id: p.id, links: p.links, devs: [p.a, p.b] });
    if (!text('#detail').includes('推定在這條推論鏈路後面的終端')) throw new Error('推論鏈路詳情應列出後面推定的終端');
    App.select(null);
  });
  await step('基準摘要與行動入口', () => {
    const summary = text('#baseline-summary');
    if (!summary.includes('基準檢查') || !summary.includes('收集完整度')) throw new Error('缺少基準狀態與收集完整度摘要');
    if (summary.includes('網路正常') || summary.includes('即時')) throw new Error('基準摘要不可宣稱即時網路健康');
    // 斷言入口與資料的關係，而非範例才有的特定問題：大型乾淨網路（SMOKE_INPUT）可能沒有缺漏或錯誤
    const button = (t) => $('#baseline-summary').testAll('button').find((b) => b.textContent === t);
    const off = (b) => b.getAttribute('disabled') !== null; // 模擬 DOM 的 setAttribute 不會同步 .disabled
    const missing = button('查看收集缺漏');
    const expectedMissing = App.snap.coverage.filter((row) => row.collected && (row.missing.length || row.failures.length)).length;
    if (!missing || off(missing) !== !expectedMissing) throw new Error('收集缺漏入口應在有缺漏時才可用');
    if (expectedMissing) {
      missing.click();
      if (!text('#pane-coverage').includes('有缺漏')) throw new Error('缺漏入口沒有切換至覆蓋率');
      if ($('#pane-coverage').testAll('tbody tr').length !== expectedMissing) throw new Error('缺漏入口應預先篩選有缺漏的設備');
    }
    const problems = button('查看錯誤／警告');
    const firstProblem = App.snap.findings.find((f) => f.severity !== 'info');
    if (!problems || off(problems) !== !firstProblem) throw new Error('問題入口應在有錯誤／警告時才可用');
    if (firstProblem) {
      problems.click();
      if (!text('#pane-findings').includes(firstProblem.title)) throw new Error('問題入口沒有切換至檢查結果');
    }
  });
  await step('窄螢幕工作區切換與詳情漸進展開', () => {
    window.innerWidth = 390;
    const workspaces = document.testAll('#mobile-workspaces button');
    workspaces.find((b) => b.dataset.workspace === 'checks').click();
    if ($('#main').dataset.workspace !== 'checks') throw new Error('工作區切換未顯示檢查面板');
    App.select({ type: 'device', key: App.snap.model.devices[0].key });
    if ($('#main').dataset.workspace !== 'details') throw new Error('選取資料後應切換至詳細資料工作區');
    const folds = $('#detail').testAll('details');
    if (!folds.length || !folds.some((d) => d.querySelector('summary').textContent.includes('鄰居'))) throw new Error('設備詳細資訊未提供可漸進展開的區塊');
    // 檢查兩種設備：未收集的與已收集的（已收集才有「收集到的原始輸出」等區塊）
    const noDupTitle = () => $('#detail').testAll('details').forEach((d) => {
      const title = d.querySelector('summary').firstChild.textContent;
      if (d.testAll('h3').some((x) => x.textContent.startsWith(title))) throw new Error(`展開區塊「${title}」內不應再重複同名標題`);
    });
    noDupTitle();
    App.select({ type: 'device', key: App.snap.model.devices.find((x) => x.collected && x.data.includes('route')).key });
    if (!$('#detail').testAll('summary').some((x) => x.textContent.startsWith('收集到的原始輸出'))) throw new Error('已收集設備應有原始輸出區塊');
    noDupTitle();
    window.innerWidth = 1200;
    workspaces.find((b) => b.dataset.workspace === 'graph').click();
  });
  await step('繪圖：不同縮放程度、分群、主機切換', () => {
    const g = App.graph; [0.05, 0.3, 0.8, 1.6, 3].forEach((s) => { g.s = s; g.draw(); });
    $('#btn-hosts').click(); g.draw(); $('#btn-groups').click(); g.draw(); $('#btn-groups').click(); $('#btn-relayout').click(); g.draw();
    $('#btn-force').click(); flushRaf(5); $('#btn-force').click();
  });
  await step('未知對端：畫在圖上、可點選、收合與展開', () => {
    const g = App.graph; const v = g.nodes.filter((n) => n.virtual);
    if (!v.length) throw new Error('圖上沒有未知對端節點');
    if (process.env.SMOKE_INPUT) { // 大型網路：全網超過上限，全部收合成群組
      if (!v.every((n) => n.kind === 'cluster')) throw new Error('超過全網上限時應全部收合');
      g.emit('click', { type: 'node', id: v[0].id }); if (App.sel.type !== 'endpoints') throw new Error('點群組應顯示終端清單'); return;
    }
    if (!v.some((n) => n.kind === 'endpoint')) throw new Error('應有單一 MAC 的未知對端');
    if (!v.every((n) => g.pos.has(n.id) && g.edgesByNode.has(n.id))) throw new Error('未知對端缺少位置或連線');
    const one = v.find((n) => n.kind === 'endpoint'); g.hover = { type: 'node', id: one.id }; g.draw(); g.hover = null;
    g.emit('click', { type: 'node', id: one.id }); if (App.sel.type !== 'interface') throw new Error('點選單一未知對端應顯示該介面');
    // 收合：上限降到 3 → 每台設備的終端合併成一個群組
    App.UNKNOWN_EXPAND_MAX = 3; App.expanded = new Set(); App.toggleExpand('TPE_ACC_SW_01'); App.toggleExpand('TPE_ACC_SW_01');
    const cl = g.nodes.filter((n) => n.kind === 'cluster'); if (!cl.length) throw new Error('超過上限時應收合成群組');
    g.draw(); g.emit('click', { type: 'node', id: cl[0].id }); if (App.sel.type !== 'endpoints' || !text('#detail').includes('終端埠')) throw new Error('點群組應顯示終端清單');
    g.emit('dblclick', { type: 'node', id: cl[0].id });
    if (g.nodes.some((n) => n.id === cl[0].id)) throw new Error('雙擊群組應展開');
    if (g.nodes.filter((n) => n.virtual && n.parent === cl[0].parent && n.kind !== 'cluster').length !== 8) throw new Error('展開後應有 8 個終端');
    App.UNKNOWN_EXPAND_MAX = 8; App.expanded = new Set();
    $('#btn-unknown').click(); g.draw(); if (g.nodes.filter((n) => g.visible(n) && n.virtual).length) throw new Error('關閉開關後不應顯示未知對端');
    $('#btn-unknown').click();
    // 搜尋 MAC → 高亮未知對端節點
    const m = App.snap.model.macs.find((x) => x.edge.length === 1 && App.vOfEp.has(x.edge[0]));
    if (m) { App.select({ type: 'mac', key: m.mac }, { focus: true }); if (!g.hl.nodes.has(App.vOfEp.get(m.edge[0]))) throw new Error('MAC 搜尋應標出未知對端'); }
    // 檢查結果 A03 → 顯示終端清單
    const i = App.snap.findings.findIndex((f) => f.id === 'A03'); if (i >= 0) { App.selectFinding(i); if (App.sel.type !== 'endpoints') throw new Error('A03 應顯示終端清單'); }
  });
  await step('廠商色最多 theme 的色數：依終端數量取前幾名，其餘歸「其他」，圖例列出同樣的對應', () => {
    const EP = S.view.theme.endpoint; const g = App.graph; const old = EP.vendor;
    const check = () => {
      const ends = g.nodes.filter((n) => n.kind === 'endpoint');
      if (App.vendorColors.size > EP.vendor.length) throw new Error('廠商色不應超過 theme 的色數');
      ends.forEach((n) => { const want = (n.vendor && App.vendorColors.get(n.vendor)) || EP.vendorFallback; if (n.color !== want) throw new Error('終端顏色應依廠商排名或歸「其他」：' + n.id); });
      const shown = document.testAll('#legend .lg-vendor').map((li) => li.textContent);
      if (shown.join('|') !== Array.from(App.vendorColors.keys()).join('|')) throw new Error('圖例的廠商應與畫面上的廠商色一致');
      return ends;
    };
    const ends = check(); if (process.env.SMOKE_INPUT) return; // 大型網路全部收合，沒有個別終端
    const vendors = S.util.uniq(ends.map((n) => n.vendor).filter(Boolean));
    if (vendors.length < 2) throw new Error('範例資料應有兩個以上廠商的終端');
    try {
      EP.vendor = old.slice(0, 1); App.toggleExpand('TPE_ACC_SW_01'); App.toggleExpand('TPE_ACC_SW_01');
      check();
      if (App.vendorColors.size !== 1 || !App.vendorOthers) throw new Error('超過色數的廠商應歸「其他」');
      if (!g.nodes.some((n) => n.kind === 'endpoint' && n.vendor && n.color === EP.vendorFallback)) throw new Error('排名之外的廠商應使用 vendorFallback');
      if (!text('#legend').includes(`其他廠商（${App.vendorOthers} 家）`)) throw new Error('圖例應註明歸為其他的廠商數');
    } finally { EP.vendor = old; App.toggleExpand('TPE_ACC_SW_01'); App.toggleExpand('TPE_ACC_SW_01'); }
    check();
  });
  await step('檢查結果：沒有發現的規則分成「通過」與「沒有資料可檢查」，預設收合', () => {
    const pass = App.Q.ruleStatus().filter((r) => r.status === 'pass'); if (!pass.length) return;
    const head = () => document.testAll('#pane-findings .fgroup').find((g) => g.className.split(' ').includes('pass'));
    if (!head()) throw new Error('應有「通過」區塊');
    if (head().testAll('.rule').length) throw new Error('「通過」區塊預設應收合');
    head().querySelector('.head').click();
    if (head().testAll('.rule').length !== pass.length || !text('#pane-findings').includes(pass[0].title)) throw new Error('展開後應列出每一條通過的規則');
    // 每一條規則都能看到 CATALOG 的處理建議（預設收合，反引號內是等寬元素）
    const plain = (t) => String(t).replace(/`([^`]+)`/g, '$1');
    const rows = () => head().testAll('.rule');
    rows().forEach((row, n) => {
      const id = pass[n].id; const adv = row.querySelector('.advice');
      if (row.querySelector('.id').textContent !== id) throw new Error('通過的規則應依 ruleStatus 的順序列出');
      if (!adv || adv.getAttribute('open') !== null || !adv.textContent.includes(plain(S.check.CATALOG[id].action))) throw new Error('通過的 ' + id + ' 應附上預設收合的處理建議');
      if (S.check.CATALOG[id].action.includes('`') && !adv.querySelector('code')) throw new Error(id + ' 的處理建議應以等寬元素顯示指令');
    });
    // 展開狀態跨重繪保留，收合後也保留
    const toggleAdvice = (on) => { const d = rows()[0].querySelector('.advice'); d.open = on; d.dispatch('toggle'); };
    const reopen = () => { head().querySelector('.head').click(); head().querySelector('.head').click(); };
    toggleAdvice(true); reopen();
    if (rows()[0].querySelector('.advice').getAttribute('open') === null) throw new Error('展開的處理建議重繪後應保持展開');
    toggleAdvice(false); reopen();
    if (rows()[0].querySelector('.advice').getAttribute('open') !== null) throw new Error('收合的處理建議重繪後應保持收合');
    head().querySelector('.head').click();
    const nodata = App.Q.ruleStatus().filter((r) => r.status === 'nodata');
    const nd = () => document.testAll('#pane-findings .fgroup').find((g) => g.className.split(' ').includes('nodata'));
    if (nodata.length) {
      nd().querySelector('.head').click();
      nd().testAll('.rule').forEach((row, n) => {
        const adv = row.querySelector('.advice');
        if (!adv || !adv.textContent.includes(plain(S.check.CATALOG[nodata[n].id].action))) throw new Error('沒有資料可檢查的 ' + nodata[n].id + ' 也應附上處理建議');
      });
      nd().querySelector('.head').click();
    }
  });
  await step('C02 的證據標示為已收集的指令，而不是缺少的資料', () => {
    const i = App.snap.findings.findIndex((f) => f.id === 'C02' && f.evidence.length);
    if (i < 0) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有帶證據的 C02'); }
    const f = App.snap.findings[i]; App.selectFinding(i);
    const t = text('#detail');
    if (!t.includes('已收集：')) throw new Error('C02 詳情應標示「已收集：」');
    const cmds = f.evidence.map((e) => App.Q.block(e.block)).filter((b) => b && b.command).map((b) => b.command);
    if (!cmds.length || !cmds.some((c) => t.includes(c))) throw new Error('C02 詳情應顯示已收集區塊的指令');
    if (f.evidence.length > 3 && !f.evidence.every((e) => t.includes(`第 ${e.line} 行`))) throw new Error('C02 的證據應全部列出');
    const other = App.snap.findings.findIndex((x) => x.id !== 'C02' && x.evidence.length && x.entities.length && x.entities.every((e) => !App.Q.findingsFor(e.type, e.key).some((y) => y.id === 'C02')));
    if (other >= 0) { App.selectFinding(other); if (!text('#detail').includes('原文 第 ')) throw new Error('其他檢查的證據應維持「原文 第 N 行」'); }
  });
  await step('點選每一筆檢查結果', () => { App.snap.findings.forEach((f, i) => { App.selectFinding(i); App.graph.draw(); }); });
  await step('詳情的檢查結果附上 CATALOG 的常見原因與處理：預設收合，反引號內的指令以等寬元素顯示', () => {
    const all = App.snap.findings; const C = S.check.CATALOG;
    // 反引號內的片段與去掉反引號後看到的文字（以正規式另外取出，不經過畫面的切法）
    const codes = (t) => Array.from(String(t).matchAll(/`([^`]+)`/g)).map((m) => m[1]);
    const plain = (t) => String(t).replace(/`([^`]+)`/g, '$1');
    const ids = S.util.uniq(all.map((f) => f.id));
    if (!process.env.SMOKE_INPUT && !ids.some((id) => codes(C[id].action).length)) throw new Error('範例資料應有處理建議含反引號指令的檢查結果');
    ids.forEach((id) => {
      // 沒有相關實體的檢查結果沒有詳情畫面可顯示（選取後是總覽），取第一筆有實體的
      const i = all.findIndex((f) => f.id === id && f.entities.length); if (i < 0) return;
      const f = all[i]; App.selectFinding(i);
      if (!text('#detail').includes(f.message)) throw new Error(id + ' 的詳情應列出這筆檢查結果');
      const blocks = $('#detail').testAll('.advice').filter((d) => d.getAttribute('data-rule-id') === id);
      if (!blocks.length) throw new Error(id + ' 的詳情應有常見原因與處理');
      blocks.forEach((d) => {
        if (d.tagName !== 'DETAILS' || d.getAttribute('open') !== null) throw new Error(id + ' 的常見原因與處理應預設收合');
        const t = d.textContent;
        if (!t.includes(plain(C[id].action))) throw new Error(id + ' 的詳情應顯示 CATALOG 的 action：' + C[id].action);
        if (!C[id].causes.every((c) => d.testAll('li').some((li) => li.textContent === plain(c)))) throw new Error(id + ' 的常見原因應逐條列出');
        if (t.includes('`')) throw new Error(id + ' 的處理建議不應顯示反引號');
        const shown = d.testAll('code').map((c) => c.textContent);
        const want = codes(C[id].action).concat(...C[id].causes.map(codes));
        if (shown.join('\n') !== want.join('\n')) throw new Error(id + ' 反引號內的片段應依序成為等寬元素：' + JSON.stringify(shown) + ' / ' + JSON.stringify(want));
        if (d.testAll('code').some((c) => !c.classList.contains('mono') || c.childNodes.some((n) => n instanceof El))) throw new Error(id + ' 的等寬元素應為純文字的 code.mono');
      });
    });
    // 反引號沒有成對時保留原樣，不吞掉文字；內容以文字寫入，不解析 HTML
    const parts = S.view.codeParts('a `b` c `d');
    if (JSON.stringify(parts) !== JSON.stringify([{ text: 'a ', code: false }, { text: 'b', code: true }, { text: ' c `d', code: false }])) throw new Error('codeParts 切法不符：' + JSON.stringify(parts));
    const nodes = S.view.codeText('<b>x</b> `<i>`');
    if (nodes[0] !== '<b>x</b> ' || nodes[1].tagName !== 'CODE' || nodes[1].textContent !== '<i>' || nodes[1].childNodes.some((n) => n instanceof El)) throw new Error('codeText 應以文字寫入，不解析 HTML');
  });
  await step('跨設備一致性：多數決推定偏離的設備列在檢查結果，VLAN 實體可開啟', () => {
    const all = App.snap.findings;
    const dev = all.map((f, i) => i).filter((i) => all[i].deviation && all[i].deviation.deviating.length);
    if (!dev.length && !process.env.SMOKE_INPUT) throw new Error('範例資料應有多數決推定偏離設備的檢查結果');
    dev.forEach((i) => {
      const f = all[i]; App.selectFinding(i);
      const box = $('#detail').testAll('.finding').find((x) => x.textContent.includes(f.message));
      if (!box || !box.textContent.includes('依多數決推定偏離')) throw new Error(`${f.id} 應列出推定偏離的設備`);
      if (!f.deviation.deviating.every((k) => box.textContent.includes(App.Q.devName(k)))) throw new Error(`${f.id} 推定偏離的設備不完整`);
    });
    // VLAN 實體的檢查結果開啟 VLAN 詳情；有不相連區塊時可切換區塊並回到全部
    const vi = all.findIndex((f) => f.entities[0] && f.entities[0].type === 'vlan');
    if (vi >= 0) { App.selectFinding(vi); if (App.sel.type !== 'vlan' || !text('#detail').includes('VLAN ' + all[vi].entities[0].key)) throw new Error('VLAN 的檢查結果應開啟 VLAN 詳情'); }
    App.select(null);
  });
  await step('點選每台設備、每條鏈路、部分介面', () => {
    App.snap.model.devices.slice(0, 300).forEach((d) => App.select({ type: 'device', key: d.key }, { focus: true }));
    const endpointDev = App.snap.model.interfaces.find((i) => i.unknownPeer);
    if (endpointDev) {
      App.select({ type: 'device', key: endpointDev.dev });
      const headings = $('#detail').testAll('h3').map((el) => el.textContent.replace(/\d+$/, ''));
      const ordered = ['檢查結果', '介面', '沒有 LLDP／CDP 鄰接的埠', '鄰居', '路由表', '收集到的原始輸出']
        .map((title) => headings.indexOf(title)).filter((i) => i >= 0);
      if (ordered.some((i, n) => n && ordered[n - 1] >= i)) throw new Error('設備詳細區塊順序不符');
    }
    App.snap.model.links.slice(0, 300).forEach((l) => App.select({ type: 'link', key: l.key }));
    App.snap.model.interfaces.slice(0, 120).forEach((i) => App.select({ type: 'interface', key: i.key }));
    const p = Array.from(App.pairs.values()).find((x) => x.links.length > 1); App.select({ type: 'pair', id: p.id, links: p.links, devs: [p.a, p.b] });
    if (!text('#detail').includes('條鏈路')) throw new Error('多鏈路明細未顯示');
  });
  await step('MAC、IP、VLAN 查詢與圖上標示', () => {
    App.snap.model.macs.slice(0, 40).forEach((m) => App.select({ type: 'mac', key: m.mac }));
    ['10.1.20.11', '10.1.30.11', '10.255.1.1', '9.9.9.9'].forEach((ip) => App.select({ type: 'ip', key: ip }));
    App.select({ type: 'vlan', key: '30' }); App.graph.draw();
    if (!process.env.SMOKE_INPUT && !text('#detail').includes('只有一端有此 VLAN 的鏈路')) throw new Error('VLAN 不一致未顯示');
    const ds = App.Q.vlan(30).domains;
    App.select({ type: 'vlan', key: '30', domain: ds[0].key }); App.graph.draw();
    if (!text('#detail').includes(`區塊 1／${ds.length}`)) throw new Error('選取 VLAN 區塊時標題未標示區塊');
  });
  await step('搜尋框', async () => {
    const inp = $('#search'); inp.value = 'acc_sw_0'; inp.dispatch('input'); await new Promise((r) => setTimeout(r, 150));
    if (!text('#search-dd').includes('_ACC_SW_0')) throw new Error('搜尋結果不正確');
    inp.dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'device') throw new Error('Enter 應選取設備');
  });
  await step('路由追蹤', () => {
    $('#btn-trace').click(); $('#trace-src').value = '10.1.30.15'; $('#trace-dst').value = '8.8.8.8'; $('#trace-run').click();
    if (App.sel.result.ok && (!App.sel.reverse || !text('#detail').includes('回程（8.8.8.8 → 10.1.30.15）'))) throw new Error('去程成功時應同時顯示回程');
    const r = App.sel.result; // 沒有任何逐跳時「逐跳」區塊不顯示，但一定有「結果」或錯誤說明
    if (r.ok ? !text('#detail').includes('結果') : !text('#detail').includes(r.error)) throw new Error('追蹤結果未顯示');
    App.graph.draw();
  });
  await step('原文檢視', () => { App.openRaw(S.readers.PASTE, 10); if (!$('#dlg-raw').open || !text('#raw-body').includes('/export')) throw new Error('原文未顯示'); });
  // ------------------------------------------------------------ M1：L2／L3 視圖
  const layerBtn = (l) => document.testAll('#layer-switch button').find((b) => b.getAttribute('data-layer') === l);
  const timed = async (label, fn) => { const t0 = Date.now(); await fn(); await App.layerJob; if (process.env.SMOKE_INPUT) console.log(`      ${label}：${Date.now() - t0} ms`); };
  await step('拓樸圖的層級：設備、L2 埠、L3 子網、L4 可達性可切換（radiogroup，鍵盤可操作）；各層的位置與縮放互不干擾，設備圖的位置存檔不變', async () => {
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
    if (App.l2.lag !== 'expand' || $('#btn-l2-lag').getAttribute('aria-pressed') !== 'true') throw new Error('按「展開聚合」應展開');
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
  await step('L3 子網圖：子網與設備是節點，推論的邊是弱線型；重疊網段與重複 IP 標在圖上、點選子網在右側列出位址、設備、重疊、重複 IP 與來源；可顯示路由（虛線箭頭）', async () => {
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
  await step('L4 zone 矩陣（L0）：每一格有狀態的符號與文字（不只靠顏色）、empty 和 unknown 分開、標出異質與 zone 內；圖例、提示、zone 的來源與推論、判斷的前提', async () => {
    const Q = App.Q; const V = S.view; const G = V.theme.l4.status;
    App.select(null); layerBtn('l4').click();
    if (App.layer !== 'l4' || L4().classList.contains('hidden')) throw new Error('點 L4 應顯示 zone 矩陣');
    await App.l4Job;
    const mx = Q.zoneMatrix(); const tds = l4Cells();
    if (!mx.zones.length) throw new Error('應有 zone');
    if (mx.zones.length <= V.l4.MATRIX_MAX && tds.length !== mx.cells.length) throw new Error(`每一格都應畫出（${tds.length}／${mx.cells.length}）`);
    if (L4().querySelector('table').getAttribute('role') !== 'grid' || !tds.every((t) => t.getAttribute('role') === 'gridcell')) throw new Error('矩陣是 grid，格子是 gridcell');
    mx.cells.forEach((c) => {
      const td = cellTd(c.src, c.dst); const where = `${c.src} → ${c.dst}`;
      if (!td || td.dataset.status !== c.status) throw new Error('格子的狀態應與 Q.zoneMatrix 相同：' + where);
      if (!td.textContent.includes(G[c.status].glyph) || !td.textContent.includes(V.L4_STATUS[c.status])) throw new Error('格子應有狀態的符號與文字：' + where);
      if (c.heterogeneous !== td.textContent.includes('異質')) throw new Error('異質的格子應標出「異質」：' + where);
      if (c.diagonal !== td.classList.contains('diag')) throw new Error('zone 內（對角線）應另外標示：' + where);
      const label = td.getAttribute('aria-label');
      if (!label.includes(V.L4_STATUS[c.status]) || (c.counts.total && !label.includes(`共 ${V.num(c.counts.total)} 組`))) throw new Error('格子的 aria-label 應讀出狀態與筆數：' + where);
    });
    if (G.empty.glyph === G.unknown.glyph || V.L4_STATUS.empty === V.L4_STATUS.unknown || G.empty.bg === G.unknown.bg || !G.empty.hatch) throw new Error('empty 與 unknown 的符號、文字與底色都應不同（empty 另有斜線底紋）');
    const statuses = new Set(mx.cells.map((c) => c.status));
    if (!process.env.SMOKE_INPUT) {
      const c = mx.cells.find((x) => x.src === 'list:WAN' && x.dst === 'vlan:20');
      if (!c || c.status !== 'partial' || !c.heterogeneous) throw new Error('範例資料的 WAN → VLAN 20 應是部分（partial）且異質');
      const td = cellTd(c.src, c.dst);
      if (!td.textContent.includes('部分') || !td.textContent.includes('異質')) throw new Error('WAN → VLAN 20 的格子應顯示「部分」與「異質」');
      if (!statuses.has('unknown') || !statuses.has('empty')) throw new Error('範例資料應同時有 unknown 與 empty 的格子');
    }
    // 圖例：五種狀態、異質、zone 內
    const lg = $('#l4-legend');
    Object.keys(V.L4_STATUS).forEach((k) => { const it = lg.testAll('.l4-legend-item').find((x) => x.dataset.status === k); if (!it || !it.textContent.includes(G[k].glyph) || !it.textContent.includes(V.L4_STATUS[k])) throw new Error('圖例缺少狀態：' + k); });
    if (!lg.textContent.includes('異質') || !lg.textContent.includes('zone 內')) throw new Error('圖例應說明異質與 zone 內');
    // 提示：筆數與代表規則
    const wr = mx.cells.find((c) => c.rule && c.counts.total);
    if (wr) {
      const td = cellTd(wr.src, wr.dst); td.dispatch('mouseenter', { clientX: 10, clientY: 10 });
      const tip = $('#l4-tip');
      if (tip.classList.contains('hidden') || !tip.textContent.includes(`允許 ${V.num(wr.counts.allow)}`) || !tip.textContent.includes(`共 ${V.num(wr.counts.total)} 組`) || !tip.textContent.includes('代表規則')) throw new Error('提示應顯示筆數與代表規則：' + tip.textContent);
      td.dispatch('mouseleave'); if (!tip.classList.contains('hidden')) throw new Error('移開後提示應收起');
      td.dispatch('focus'); if (tip.classList.contains('hidden')) throw new Error('鍵盤移到格子時也應顯示提示'); td.dispatch('blur');
    }
    // zone 的來源與推論：表頭與「zone 的依據」
    const heads = L4().testAll('th').map((x) => x.textContent);
    mx.zones.forEach((z) => {
      if (mx.zones.length <= V.l4.MATRIX_MAX && !heads.some((t) => t.includes(z.name) && t.includes(V.ZONE_SOURCE[z.source]) && (!z.inferred || t.includes('推論')))) throw new Error('zone 名稱旁應有來源與推論標示：' + z.name);
    });
    const zt = text('#l4-zones');
    Q.zones().zones.forEach((z) => { if (!zt.includes(z.name) || (z.basis && !zt.includes(z.basis))) throw new Error('zone 的依據應列出：' + z.name); });
    // 判斷的前提
    S.query.reachAssumptions().forEach((a) => { if (!text('#view-l4').includes(a.message)) throw new Error('畫面應寫出判斷的前提：' + a.message); });
    if (!/計算 [\d,]+ ms|使用快取/.test(text('#l4-status'))) throw new Error('應說明計算時間或使用快取：' + text('#l4-status'));
    // 配色：文字對格子底色 ≥ 4.5:1，符號對格子底色與畫布底色 ≥ 3:1
    Object.entries(G).forEach(([k, s]) => {
      if (contrastOf(V.theme.l4.text, s.bg) < 4.5) throw new Error(`L4 ${k} 的文字對底色不足 4.5:1`);
      if (contrastOf(s.mark, s.bg) < 3 || contrastOf(s.mark, V.theme.canvas.surface) < 3) throw new Error(`L4 ${k} 的符號對底色不足 3:1`);
    });
    if (contrastOf(V.theme.l4.badge.text, V.theme.l4.badge.bg) < 4.5) throw new Error('異質徽章的文字對底色不足 4.5:1');
    // 強制色彩：格子有系統色外框，焦點用 Highlight
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8'); const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    if (!/\.l4-cell:focus[^{]*\{[^}]*Highlight/.test(forced) || !/\.l4-cell,[^{]*\{[^}]*CanvasText/.test(forced)) throw new Error('強制色彩模式下 L4 的格子要有系統色外框與焦點');
    if (process.env.SMOKE_INPUT) {
      const run = S.view.l4.runs(Q).get('') || {};
      console.log(`      L4 矩陣第一次計算：${S.view.l4.timings(Q).get('')} ms（${mx.zones.length} 個 zone、${mx.stats.evaluations} 次判斷）；分 ${run.steps} 段，一段最久 ${run.maxStepMs} ms，兩段之間最長 ${run.maxGapMs} ms，總共 ${run.wallMs} ms`);
    }
  });
  await step('L4 下鑽：方向鍵在格子間移動（roving tabindex），Enter 開 L1／L2，點一組的服務開 L3；焦點移到下鑽的標題，規則可點開詳情', async () => {
    const Q = App.Q; const V = S.view; const mx = Q.zoneMatrix(); const n = mx.zones.length;
    const tds = l4Cells(); const roving = tds.filter((t) => t.getAttribute('tabindex') === '0');
    if (roving.length !== 1) throw new Error('矩陣只應有一個格子在 Tab 順序裡');
    const at = () => [+document.activeElement.dataset.r, +document.activeElement.dataset.c];
    roving[0].focus(); const [r0, c0] = at();
    if (n > 1) {
      document.activeElement.dispatch('keydown', { key: c0 < n - 1 ? 'ArrowRight' : 'ArrowLeft' });
      if (at()[1] === c0 || document.activeElement.getAttribute('tabindex') !== '0' || roving[0].getAttribute('tabindex') !== '-1') throw new Error('←／→ 應移到同一列的另一格，roving tabindex 跟著改');
      document.activeElement.dispatch('keydown', { key: r0 < n - 1 ? 'ArrowDown' : 'ArrowUp' });
      if (at()[0] === r0) throw new Error('↑／↓ 應移到另一列');
      document.activeElement.dispatch('keydown', { key: 'Home' }); if (at()[1] !== 0) throw new Error('Home 應移到這一列的第一格');
      document.activeElement.dispatch('keydown', { key: 'End' }); if (at()[1] !== n - 1) throw new Error('End 應移到這一列的最後一格');
    }
    const target = (!process.env.SMOKE_INPUT && mx.cells.find((x) => x.src === 'list:WAN' && x.dst === 'vlan:20')) || mx.cells.find((c) => c.counts.total);
    if (!target) throw new Error('應有可下鑽的格子');
    const td = cellTd(target.src, target.dst); td.focus(); td.dispatch('keydown', { key: 'Enter' });
    const s0 = l4State();
    if (!s0.cell || s0.cell.src !== target.src || s0.cell.dst !== target.dst) throw new Error('Enter 應開啟這一格的下鑽');
    if (document.activeElement !== $('#l4-drill-title') || !text('#l4-live').includes('下鑽')) throw new Error('下鑽後焦點應移到下鑽的標題，並讀出開啟了哪一格');
    const cell = Q.zoneCell(target.src, target.dst); const d = text('#l4-drill');
    if (!d.includes('L1') || !d.includes('L2')) throw new Error('下鑽應有 L1（位址組）與 L2（牽涉的規則）');
    const shown = () => $('#l4-drill').testAll('.l4-group').length; const denyAll = cell.groups.filter((g) => g.status === 'deny').length;
    const divCount = cell.groups.filter((g) => g.divergent).length;
    if (cell.heterogeneous !== (divCount > 0)) throw new Error('有 divergent 的組 ⇔ 格子異質');
    if (cell.heterogeneous) {
      // 異質（規格書 §5.7）：預設只列造成差異的組；「顯示全部（N 組）」可切換，焦點留在切換按鈕
      if (shown() !== Math.min(300, divCount)) throw new Error(`異質的格子預設只顯示造成差異的組（${shown()}／divergent ${divCount}）`);
      if (!text('#l4-drill').includes('異質')) throw new Error('異質的下鑽應說明只列出造成差異的組');
      const sa = () => $('#l4-drill').querySelector('.l4-show-all');
      if (divCount < cell.groups.length) {
        if (!sa() || sa().getAttribute('aria-pressed') !== 'false' || !sa().textContent.includes(`顯示全部（${V.num(cell.groups.length)} 組）`)) throw new Error('異質的下鑽應有「顯示全部（N 組）」');
        sa().click();
        if (shown() !== Math.min(300, cell.groups.length) || sa().getAttribute('aria-pressed') !== 'true' || document.activeElement !== sa()) throw new Error('「顯示全部」後應列出全部的組，焦點留在切換按鈕');
        sa().click();
        if (shown() !== Math.min(300, divCount) || sa().getAttribute('aria-pressed') !== 'false') throw new Error('再按一次應回到只顯示造成差異的組');
      }
      // 造成差異的服務：按鈕上有「差異」文字（不只靠顏色），其他服務沒有
      const btns = $('#l4-drill').testAll('.l4-svc');
      cell.groups.forEach((g, i) => { if (!g.divergent) return; g.services.forEach((s) => {
        const b = btns.find((x) => x.dataset.group === String(i) && x.dataset.service === s.service);
        if (b && g.divergentServices.includes(s.service) !== b.textContent.includes('差異')) throw new Error(`造成差異的服務才標「差異」：第 ${i + 1} 組 ${s.service}`);
      }); });
      if (!cell.groups.some((g) => g.divergentServices.length)) throw new Error('divergent 的組應列出造成差異的服務');
      if (!process.env.SMOKE_INPUT && !cell.groups.some((g) => g.divergentServices.includes('tcp/8443'))) throw new Error('範例資料的 WAN → VLAN 20 應是 tcp/8443 造成差異');
    } else {
      if (shown() !== Math.min(300, cell.groups.some((g) => g.status !== 'deny') ? cell.groups.length - denyAll : cell.groups.length)) throw new Error(`L1 的組數不符（${shown()}／${cell.groups.length}，全部拒絕 ${denyAll}）`);
      const hide = $('#l4-drill').querySelector('.l4-hide-deny');
      if (hide) { hide.click(); if (shown() !== Math.min(300, cell.groups.length)) throw new Error('「顯示全部拒絕的組」後應列出全部'); $('#l4-drill').querySelector('.l4-hide-deny').click(); }
    }
    if ($('#l4-drill').testAll('.l4-ruledetail').length !== Math.min(300, cell.ruleDetails.length)) throw new Error('L2 應列出 Q.zoneCell 的每一條牽涉的規則');
    // L1 → L3：點一組的某個服務
    const gi = cell.groups.findIndex((g) => !process.env.SMOKE_INPUT ? g.services.some((s) => s.service === 'tcp/8443' && s.verdict === 'allow') : g.status !== 'deny');
    if (gi < 0) throw new Error('應有可以看 L3 的組');
    const g = cell.groups[gi]; const svc = (g.services.find((s) => s.service === 'tcp/8443' && s.verdict === 'allow') || g.services[0]).service;
    const btn = l4SvcBtn(gi, svc);
    btn.click();
    const s1 = l4State(); const p = svcParts(svc);
    if (!s1.reach || s1.reach !== Q.reach(g.srcs[0].ip, g.dst.ip, { proto: p.proto, port: p.port })) throw new Error('L3 應是這一組代表位址的 Q.reach');
    if (document.activeElement !== $('#l4-l3-title')) throw new Error('開 L3 後焦點應移到 L3 的標題');
    const l3 = text('#l4-drill');
    s1.reach.paths.forEach((pa) => pa.hops.forEach((hp) => { if (!l3.includes(Q.devName(hp.dev))) throw new Error('L3 應列出每一跳的設備：' + hp.dev); hp.stages.forEach((sg) => { if (!l3.includes(`${sg.table} ${sg.chain}`)) throw new Error('L3 應列出每一跳的 stage'); }); }));
    if (!process.env.SMOKE_INPUT && !l3.includes('10.1.20.11:443')) throw new Error('WAN → VLAN 20 的 tcp/8443 應顯示 NAT 之後的 10.1.20.11:443');
    // 規則可以點：右側開啟規則詳情
    const rl = $('#l4-drill').testAll('.l4-rule')[0];
    if (rl) { rl.click(); if (!App.sel || App.sel.type !== 'rule' || App.sel.key !== rl.dataset.rule || !text('#detail').includes('命中次數')) throw new Error('點規則應在右側開啟規則詳情（含命中次數）'); }
    if (App.layer !== 'l4') throw new Error('開規則詳情時仍停在 L4');
    // 關閉下鑽：焦點回到格子
    $('#l4-drill').querySelector('.l4-close').click();
    if (!$('#l4-drill').classList.contains('hidden') || document.activeElement !== td) throw new Error('關閉下鑽後應收起並回到格子');
    App.select(null);
  });
  await step('L4 可達性查詢：輸入來源、目的、協定與埠，結果用同一個 L3；NAT 改寫、拒絕、參數錯誤與無法判斷的原因（中文說明）', async () => {
    const Q = App.Q; const V = S.view;
    const run = (src, dst, proto, port) => { $('#l4-src').value = src; $('#l4-dst').value = dst; $('#l4-proto').value = proto; $('#l4-proto').dispatch('change'); $('#l4-port').value = port; $('#l4-run').click(); };
    if (!process.env.SMOKE_INPUT) {
      run('203.0.113.1', '203.0.113.2', 'tcp', '8443');
      const r = l4State().reach;
      if (!r || r !== Q.reach('203.0.113.1', '203.0.113.2', { proto: 'tcp', port: 8443 }) || r.verdict !== 'allow' || r.final.dst !== '10.1.20.11' || r.final.port !== 443) throw new Error('203.0.113.1 → 203.0.113.2 tcp 8443 應允許，NAT 之後是 10.1.20.11:443');
      const d = text('#l4-drill');
      if (!d.includes(V.VERDICT.allow) || !d.includes('NAT 之後 10.1.20.11:443') || !d.includes('dst-nat') || !d.includes('203.0.113.2:8443 → 10.1.20.11:443')) throw new Error('L3 應寫出允許與 NAT 改寫前後：' + d.slice(0, 300));
      if (document.activeElement !== $('#l4-drill-title')) throw new Error('查詢後焦點應移到結果的標題');      run('10.1.30.11', '10.1.10.2', 'tcp', '22');
      const r2 = l4State().reach;
      if (!r2 || r2.verdict !== 'deny' || !text('#l4-drill').includes(V.VERDICT.deny)) throw new Error('10.1.30.11 → 10.1.10.2 tcp 22 應拒絕');
      if (!r2.decisive.some((x) => x.key) || !$('#l4-drill').testAll('.l4-rule').some((a) => r2.decisive.some((x) => x.key === a.dataset.rule))) throw new Error('拒絕時應列出決定的規則，可以點');
    }
    // 參數錯誤：核心的錯誤原文顯示，不靜默
    run('10.1.30.11', '10.1.10.2', 'tcp', '');
    if (!l4State().reachErr || !text('#l4-drill').includes('無法查詢')) throw new Error('tcp 沒有埠時應顯示錯誤');
    run('x', 'y', 'tcp', '22');
    if (!text('#l4-drill').includes('IPv4')) throw new Error('位址無效時應顯示原因');
    $('#l4-proto').value = 'icmp'; $('#l4-proto').dispatch('change');
    if (!$('#l4-port').disabled) throw new Error('icmp 沒有埠，埠欄應停用');
    // 無法判斷：每個原因代碼都有中文說明
    const mx = Q.zoneMatrix();
    mx.cells.forEach((c) => c.reasons.forEach((x) => { if (!V.REACH_REASON[x.code]) throw new Error('原因代碼沒有中文說明：' + x.code); }));
    // 查詢層的原因與結束代碼清單：每一個都有中文對照（不只範例資料出現的）
    const codes = S.query.reachReasonCodes();
    if (!codes.length || !Object.isFrozen(codes)) throw new Error('S.query.reachReasonCodes() 應是凍結的非空陣列');
    const missing = codes.filter((x) => !V.REACH_REASON[x.code]).map((x) => x.code);
    if (!codes.every((x) => V.REACH_REASON[x.code])) throw new Error('原因代碼沒有中文說明：' + missing.join('、'));
    const u = mx.cells.find((c) => c.status === 'unknown');
    if (!u && !process.env.SMOKE_INPUT) throw new Error('範例資料應有無法判斷的格子');
    if (u) {
      V.l4.openCell(App, u.src, u.dst);
      if (!text('#l4-drill').includes(V.reachReason(u.reasons[0].code))) throw new Error('unknown 的格子應以中文列出原因');
      const cd = Q.zoneCell(u.src, u.dst); const gi = cd.groups.findIndex((g) => g.services.some((s) => s.verdict === 'unknown'));
      const svc = cd.groups[gi].services.find((s) => s.verdict === 'unknown').service;
      l4SvcBtn(gi, svc).click();
      const r = l4State().reach;
      if (!r || r.verdict !== 'unknown' || !r.reasons.length) throw new Error('L3 應是無法判斷並附原因');
      const t = text('#l4-drill');
      r.reasons.forEach((x) => { if (!t.includes(V.reachReason(x.code))) throw new Error('L3 應以中文說明原因：' + x.code); });
      if (t.includes('未翻譯')) throw new Error('原因代碼都應有中文說明');
    }
    // 「在圖上定位」（搜尋、路由追蹤）從 L4 回到設備圖
    App.showView('graph');
    if (App.layer !== 'device' || !L4().classList.contains('hidden')) throw new Error('在圖上定位時應從 L4 回到設備圖');
  });
  await step('L4 表格檢視與矩陣內容一致；可選單一服務（第一次計算先顯示忙碌提示，算過的直接用快取）；下載 CSV', async () => {
    const Q = App.Q; const V = S.view; const mx = Q.zoneMatrix();
    const zn = new Map(Q.zones().zones.map((z) => [z.id, z.name]));
    App.showLayer('l4'); await App.l4Job;
    if (!text('#l4-status').includes('使用快取')) throw new Error('同一份基準再開矩陣時應直接使用快取');
    const modeBtn = (m) => L4().testAll('.l4-modes button').find((b) => b.dataset.mode === m);
    modeBtn('table').click(); await App.l4Job;
    if (modeBtn('table').getAttribute('aria-pressed') !== 'true' || modeBtn('matrix').getAttribute('aria-pressed') !== 'false') throw new Error('檢視方式的按鈕應標出目前的方式（aria-pressed）');
    const rows = L4().testAll('.l4-row');
    if (rows.length !== mx.cells.length) throw new Error(`表格應每一格一列（${rows.length}／${mx.cells.length}）`);
    const sig = (src, dst, status, k) => [src, dst, status, k.allow, k.deny, k.unknown, k.total].join('|');
    const want = mx.cells.map((c) => sig(zn.get(c.src), zn.get(c.dst), c.status, c.counts)).sort();
    const got = rows.map((tr) => {
      const td = tr.childNodes; const num = (i) => Number(td[i].textContent.replace(/,/g, ''));
      return sig(td[0].textContent, td[1].textContent.replace('（zone 內）', ''), tr.querySelector('.l4-row-status').dataset.status, { allow: num(3), deny: num(4), unknown: num(5), total: num(6) });
    }).sort();
    require('assert').deepStrictEqual(got, want);
    modeBtn('matrix').click(); await App.l4Job;
    if (!l4Cells().length) throw new Error('切回矩陣檢視');
    // 單一服務：選單列出矩陣用的每個服務
    const sel = $('#l4-service'); const opts = sel.testAll('option').map((o) => o.getAttribute('value'));
    if (opts[0] !== '' || mx.services.some((s) => !opts.includes(s.id))) throw new Error('服務選單應有「全部」與矩陣的每個服務：' + opts.join());
    const svc = !process.env.SMOKE_INPUT ? 'tcp/8443' : mx.services[1].id;
    sel.value = svc; sel.dispatch('change');
    if (!text('#l4-status').includes('計算 zone 矩陣中') || $('#l4-matrix').getAttribute('aria-busy') !== 'true') throw new Error('第一次計算應先顯示忙碌提示（aria-busy）：' + text('#l4-status'));
    await App.l4Job;
    if ($('#l4-matrix').getAttribute('aria-busy') !== 'false') throw new Error('算完後應拿掉 aria-busy');
    const one = Q.zoneMatrix({ services: [svcParts(svc)] });
    one.cells.forEach((c) => { const td = cellTd(c.src, c.dst); if (!td || td.dataset.status !== c.status) throw new Error(`單一服務的格子應與 Q.zoneMatrix({ services }) 相同：${c.src} → ${c.dst}`); });
    if (!process.env.SMOKE_INPUT && cellTd('list:WAN', 'vlan:20').dataset.status !== one.cells.find((c) => c.src === 'list:WAN' && c.dst === 'vlan:20').status) throw new Error('tcp/8443 的 WAN → VLAN 20');
    if (process.env.SMOKE_INPUT) console.log(`      L4 單一服務（${svc}）：${S.view.l4.timings(Q).get(svc)} ms`);
    sel.value = ''; sel.dispatch('change');
    if (text('#l4-status').includes('計算 zone 矩陣中')) throw new Error('算過的服務應直接用快取，不顯示忙碌提示');
    await App.l4Job;
    // CSV：每一格一列
    const { files } = await captureDownloads(() => L4().querySelector('.l4-csv').click());
    const csv = parseCsv(files[0].text.replace(/^﻿/, ''));
    if (!files[0].name.endsWith('.csv') || csv.length - 1 !== mx.cells.length || !csv[0].includes('狀態')) throw new Error('CSV 應每一格一列');
    App.showLayer('device');
  });
  await step('L4 分段計算：進度條顯示階段與進度；計算中仍可操作（切換層級、可達性查詢）；離開 L4 或換服務時放棄，不畫過期的結果、不留下半成品', async () => {
    const Q = App.Q; const V = S.view; const mx = Q.zoneMatrix();
    // 查詢層沒有快取時，分段計算的第一次 next() 不會結束（只看不算：馬上 return()）
    const notCached = (id) => { const it = Q.zoneMatrixSteps({ services: [svcParts(id)] }); const r = it.next(); it.return(); return !r.done; };
    const svc = mx.services.map((s) => s.id).find((id) => !V.l4.timings(Q).has(id) && notCached(id));
    if (!svc) throw new Error('測試前提：應有還沒算過的服務');
    const tick = () => new Promise((r) => setImmediate(r));
    const until = async (cond, what) => { for (let i = 0; i < 200000 && !cond(); i++) await tick(); if (!cond()) throw new Error('等不到：' + what); };
    const computing = () => { const c = l4State().computing; return !!(c && c.progress); };
    App.showLayer('l4'); await App.l4Job;
    const sel = $('#l4-service');
    // 1. 計算中離開 L4：馬上切換；計算在下一段之前放棄
    sel.value = svc; sel.dispatch('change'); const job1 = App.l4Job;
    await until(computing, '開始分段計算');
    const bar = $('#l4-progress');
    if (!bar || bar.getAttribute('role') !== 'progressbar' || !/(找代表位址|逐一判斷|整理格子)/.test(bar.getAttribute('aria-valuetext') || '') || bar.getAttribute('aria-valuenow') == null) throw new Error('進度條應有階段的中文與進度（aria-valuetext、aria-valuenow）');
    if (!/第 \d／3 段：(找代表位址|逐一判斷|整理格子) [\d,]+／[\d,]+/.test(text('#l4-progress-text'))) throw new Error('進度應寫出階段與 done/total：' + text('#l4-progress-text'));
    if (l4Cells().length) throw new Error('計算中不應顯示別的服務的舊矩陣');
    layerBtn('device').click();
    if (App.layer !== 'device' || !L4().classList.contains('hidden')) throw new Error('計算中仍可切換層級');
    await job1;
    if (l4State().computing || V.l4.timings(Q).has(svc) || !notCached(svc)) throw new Error('離開 L4 時應放棄計算，查詢層不留下快取');
    if ($('#l4-matrix').getAttribute('aria-busy') !== 'false' || !text('#l4-status').includes('已停止')) throw new Error('放棄後應拿掉 aria-busy，並說明已停止');
    // 2. 回到 L4 重新計算；計算中可以做可達性查詢（不中斷計算），再換服務時放棄，畫的是新服務的矩陣
    App.showLayer('l4'); const job2 = App.l4Job;
    await until(computing, '回到 L4 後重新計算');
    $('#l4-src').value = '10.1.30.11'; $('#l4-dst').value = '10.1.10.2'; $('#l4-proto').value = 'tcp'; $('#l4-proto').dispatch('change'); $('#l4-port').value = '22'; $('#l4-run').click();
    if (!l4State().reachReq || !l4State().computing) throw new Error('計算中可以做可達性查詢，而且不中斷矩陣的計算');
    sel.value = ''; sel.dispatch('change'); // 「全部服務」已算過：馬上畫
    if (l4State().computing || text('#l4-status').includes('計算 zone 矩陣中')) throw new Error('換到算過的服務時應放棄進行中的計算，直接畫');
    await job2;
    if (V.l4.timings(Q).has(svc) || !notCached(svc)) throw new Error('換服務時應放棄計算，查詢層不留下快取');
    mx.cells.forEach((c) => { const td = cellTd(c.src, c.dst); if (mx.zones.length <= V.l4.MATRIX_MAX && (!td || td.dataset.status !== c.status)) throw new Error('放棄後畫的應是目前服務（全部服務）的矩陣'); });
    // 3. 跑完：每個階段的進度都更新過，結果與 Q.zoneMatrix 相同
    sel.value = svc; sel.dispatch('change'); const job3 = App.l4Job;
    let fin = false; job3.then(() => { fin = true; });
    const stages = new Set(); const texts = new Set();
    while (!fin) { await tick(); const b = $('#l4-progress'); if (b && b.dataset.stage) { stages.add(b.dataset.stage); texts.add(text('#l4-progress-text')); } }
    if (!['reps', 'evaluate', 'summary'].every((s) => stages.has(s)) || texts.size < 3) throw new Error('分段計算時進度應依序更新三個階段：' + Array.from(texts).join('／'));
    const one = Q.zoneMatrix({ services: [svcParts(svc)] });
    if (notCached(svc) || !V.l4.timings(Q).has(svc)) throw new Error('跑完應寫進查詢層的快取');
    one.cells.forEach((c) => { const td = cellTd(c.src, c.dst); if (one.zones.length <= V.l4.MATRIX_MAX && (!td || td.dataset.status !== c.status)) throw new Error('分段計算的結果應與 Q.zoneMatrix 相同'); });
    const run = V.l4.runs(Q).get(svc);
    if (!run || run.steps < 3 || !text('#l4-status').includes(`分 ${V.num(run.steps)} 段`)) throw new Error('應記錄並寫出分了幾段：' + text('#l4-status'));
    if (process.env.SMOKE_INPUT) console.log(`      L4 分段計算（${svc}）：${run.ms} ms，分 ${run.steps} 段，一段最久 ${run.maxStepMs} ms，兩段之間最長 ${run.maxGapMs} ms，總共 ${run.wallMs} ms`);
    App.showLayer('device');
  });
  await step('規則詳情：命中次數（千分位）、沒有資料與對不上（F09）的說明、0 不代表沒用；L4 影響（zone 對與停用後 allow→deny）', async () => {
    const Q = App.Q; const V = S.view; const rules = App.snap.model.firewallRules;
    const big = rules.find((r) => r.stats && r.stats.packets.length >= 4) || rules.find((r) => r.stats);
    if (!big && !process.env.SMOKE_INPUT) throw new Error('範例資料應有命中次數');
    if (big) {
      App.select({ type: 'rule', key: big.key });
      const d = text('#detail');
      if (!d.includes(V.bigNum(big.stats.packets)) || !d.includes(V.bigNum(big.stats.bytes)) || !d.includes('0 只代表')) throw new Error('規則詳情應以千分位顯示命中次數，並說明 0 的意思');
      if (big.stats.packets.length >= 4 && !V.bigNum(big.stats.packets).includes(',')) throw new Error('大數字應有千分位');
      if (!$('#detail').testAll('.fw-hits').length) throw new Error('規則表應有命中次數欄');
    }
    if (V.bigNum('18446744073709551615') !== '18,446,744,073,709,551,615') throw new Error('超過 2^53 的命中次數也應正確加上千分位');
    const mm = Q.firewallStats().find((t) => t.status === 'mismatch');
    if (!mm && !process.env.SMOKE_INPUT) throw new Error('範例資料應有 F09（命中次數對不上）');
    if (mm) {
      const r = rules.find((x) => x.dev === mm.dev && x.family === mm.family && x.table === mm.table);
      App.select({ type: 'rule', key: r.key });
      const d = text('#detail');
      if (r.stats || !d.includes('對不上') || !d.includes('F09') || !d.includes('0 只代表')) throw new Error('F09 的表的規則應說明命中次數對不上、不採用');
    }
    const noTable = rules.find((x) => !x.stats && !Q.firewallStatsOf(x.dev).some((t) => t.family === x.family && t.table === x.table));
    if (noTable) { App.select({ type: 'rule', key: noTable.key }); if (!text('#detail').includes('沒有命中次數資料')) throw new Error('沒有命中次數時應寫「沒有命中次數資料」'); }
    // L4 影響：按了才算
    const mx = Q.zoneMatrix();
    const pick = mx.cells.map((c) => c.rule && c.rule.key).find((k) => k && Q.getFirewallRule(k)) || (rules.find((r) => r.family === 'ip' && r.table === 'filter' && r.chain === 'forward') || {}).key;
    if (pick) {
      App.select({ type: 'rule', key: pick });
      const t0 = Date.now(); $('#detail').querySelector('.fw-impact-run').click(); await App.l4ImpactJob;
      if (process.env.SMOKE_INPUT) console.log(`      規則的 L4 影響：${Date.now() - t0} ms`);
      const imp = Q.ruleImpact(pick); const d = text('#detail');
      if (!d.includes(`牽涉 ${V.num(imp.cells.length)} 個 zone 對`) || !d.includes(`allow→deny ${V.num(imp.ifDisabled.counts['allow→deny'] || 0)} 筆`)) throw new Error('規則詳情應顯示影響的 zone 對與停用後的 allow→deny：' + d.slice(0, 200));
      const zn = new Map(Q.zones().zones.map((z) => [z.id, z.name]));
      imp.cells.slice(0, 20).forEach((c) => { if (c.src && !d.includes(zn.get(c.src) || c.src)) throw new Error('應列出影響的 zone 對'); });
      App.select({ type: 'device', key: Q.devices()[0].key }); App.select({ type: 'rule', key: pick });
      if ($('#detail').querySelector('.fw-impact-run')) throw new Error('算過的影響應保留到換基準');
    }
    App.select(null);
  });
  await step('L4 zone 的來源：建立基準時的命名規則有 zones 段時，以它的標籤當 zone（標「命名規則」、不標推論）；核對失敗時說明原因、不套用', async () => {
    if (process.env.SMOKE_INPUT) return; // 範例資料才知道 VLAN 20 的網段
    const VA = S.view.app; const orig = { snap: App.snap, sources: App.round.sources, profile: App.round.profile };
    const prof = Object.assign(JSON.parse(JSON.stringify(S.profiles['site-naming'])), { zones: [{ on: 'vlan', match: '^20$', zone: 'SERVERS' }] });
    try {
      const snap = S.build(orig.sources, { profile: prof, now: '2026-01-01T00:00:00Z' });
      VA.load(snap, null, { sources: orig.sources, profile: prof }); await App.ledgerJob; await App.layoutJob;
      App.showLayer('l4'); await App.l4Job;
      const z = App.Q.zones({ profile: prof }).zones.find((x) => x.name === 'SERVERS');
      if (!z || z.source !== 'profile' || z.inferred) throw new Error('測試前提：命名規則的 zones 標籤成為 zone');
      const th = L4().testAll('th').find((x) => x.textContent.includes('SERVERS'));
      if (!th || !th.textContent.includes(S.view.ZONE_SOURCE.profile) || th.textContent.includes('推論')) throw new Error('命名規則的 zone 應標「命名規則」，不標推論');
      if (!l4Cells().some((t) => t.dataset.dst === z.id)) throw new Error('矩陣應用命名規則的 zone');
      // 命名規則的內容和基準記錄的不同：查詢層丟錯，畫面不套用並說明
      const changed = Object.assign({}, prof, { zones: [{ on: 'vlan', match: '^30$', zone: 'OTHER' }] });
      VA.setRoundInputs({ profile: changed }); App.showLayer('l4', { rebuild: true }); await App.l4Job;
      if (!text('#l4-zones').includes('命名規則的 zones 段沒有套用') || L4().testAll('th').some((x) => x.textContent.includes('OTHER'))) throw new Error('命名規則核對失敗時應說明、不套用');
    } finally {
      App.showLayer('device');
      VA.load(orig.snap, null, { sources: orig.sources, profile: orig.profile }); await App.ledgerJob; await App.layoutJob;
    }
  });
  // ------------------------------------------------------------ M3：VRF（範例資料的 PE 有 VRF、與 main 重疊的位址與路由洩漏，CE 有策略路由）
  /** 範例資料中，非 main 的 VRF 裡也出現在 main 的 IP（位址重疊） */
  const overlapIp = (Q) => (Q.ipEntries().find((r) => r.vrf !== S.keys.MAIN_VRF && r.owner && Q.findIp(r.ip).vrfs.length > 1) || {}).ip;
  await step('VRF：L3 每個 VRF 一個框（同一個網段在不同 VRF 是不同的子網，設備在每個 VRF 各一個節點）；說明寫出 VRF 與沒畫的策略路由；選取對到該 VRF 的節點', async () => {
    if (process.env.SMOKE_INPUT) return; // 範例資料才有 PE／CE
    const Q = App.Q; const g = App.graph; const V = S.view; const K = S.keys; const MAIN = K.MAIN_VRF;
    const PE = 'TPE_PE_RT_01';
    const vrf = Q.vrfs().find((v) => v !== MAIN);
    if (!Q.getDevice(PE) || !vrf) throw new Error('測試前提：範例資料有 PE 與 main 以外的 VRF');
    App.l3.routes = false; App.showLayer('l3'); await App.layerJob;
    const sg = Q.subnetGraph(); const e = App.layerEntry();
    if (!e.info.byVrf || e.info.vrfs[0] !== MAIN || !e.info.vrfs.includes(vrf)) throw new Error('L3 應依 VRF 分框（main 在最前）');
    sg.subnets.forEach((s) => { const n = g.nodeById.get('net|' + s.id); if (!n || n.group !== V.vrfText(s.vrf)) throw new Error('子網應在自己 VRF 的框裡：' + s.id); });
    sg.nodes.forEach((n) => { const x = g.nodeById.get(n.id); if (!x || x.group !== V.vrfText(n.vrf) || x.dev !== n.dev) throw new Error('設備節點應在自己 VRF 的框裡：' + n.id); });
    const peVrf = K.inVrf(PE, vrf);
    if (!g.nodeById.has(peVrf) || !g.nodeById.has(PE) || !g.nodeById.get(peVrf).label.endsWith('@' + vrf)) throw new Error('PE 應在 main 與 ' + vrf + ' 各一個節點，非 main 的標 @VRF');
    const same = sg.subnets.find((s) => s.vrf !== MAIN && sg.subnets.some((x) => x.vrf === MAIN && x.prefix === s.prefix));
    if (!same || !g.nodeById.has('net|' + same.id) || !g.nodeById.has('net|' + same.prefix)) throw new Error('同一個網段在不同 VRF 應是不同的子網節點');
    g.computeGroups();
    const boxes = (g.groupBoxes || []).map((b) => b.name);
    e.info.vrfs.forEach((v) => { if (!boxes.includes(V.vrfText(v))) throw new Error('畫布應畫出 VRF 的框：' + v); });
    const note = $('#layer-note').textContent;
    if (!note.includes('每個 VRF 一個框') || !e.info.vrfs.every((v) => note.includes(v))) throw new Error('L3 的說明應寫出 VRF：' + note);
    // 提示與點選：VRF 節點的提示寫出 VRF，點了開啟設備
    g.emit('hover', { item: { type: 'node', id: peVrf }, x: 0, y: 0 });
    if (!text('#tooltip').includes(V.vrfText(vrf))) throw new Error('VRF 節點的提示應寫出 VRF');
    g.emit('click', { type: 'node', id: peVrf });
    if (App.sel.type !== 'device' || App.sel.key !== PE || !g.sel.nodes.has(peVrf) || !g.sel.nodes.has(PE)) throw new Error('點 VRF 節點應開啟設備，並標出它在每個 VRF 的節點');
    // 選取介面：標出介面所在 VRF 的節點
    const ifc = Q.interfacesOf(PE).find((i) => i.vrf === vrf && Q.addressesOf(i.key).length);
    App.select({ type: 'interface', key: ifc.key });
    if (!g.sel.nodes.has(peVrf) || g.sel.nodes.has(PE)) throw new Error('選取 VRF 的介面應標出那個 VRF 的節點');
    // 子網詳情：VRF 與其他 VRF 的同一個網段
    App.select({ type: 'subnet', key: same.id });
    const sd = text('#detail');
    if (!sd.includes(vrf) || !sd.includes('同一個網段也在') || !$('#detail').testAll('a').some((a) => a.textContent === same.prefix)) throw new Error('子網詳情應寫出 VRF 與其他 VRF 的同一個網段：' + sd.slice(0, 200));
    // 顯示路由：路由接在設備在那個 VRF 的節點；洩漏的閘道標 @VRF；沒畫的策略路由寫在說明
    $('#btn-l3-routes').click(); await App.layerJob;
    const sgr = Q.subnetGraph({ routes: true });
    const leak = g.edges.find((x) => x.route && x.route.dev === PE && x.route.nh.some((n) => n.ip && n.vrf && n.vrf !== x.route.vrf));
    if (!leak || leak.a !== peVrf || leak.route.node !== peVrf) throw new Error('洩漏的路由應從 PE 在 ' + vrf + ' 的節點出發');
    const lnh = leak.route.nh.find((n) => n.ip && n.vrf !== leak.route.vrf);
    g.emit('hover', { item: { type: 'edge', id: leak.id }, x: 0, y: 0 });
    if (!text('#tooltip').includes(`${lnh.ip}@${lnh.vrf}`) || !text('#tooltip').includes('路由表 ' + leak.route.routingTable)) throw new Error('洩漏的路由提示應寫出 位址@VRF 與路由表：' + text('#tooltip'));
    if (!sgr.omitted.policyRoutes) throw new Error('測試前提：範例資料的 CE 有只用於策略路由的路由表');
    if (!$('#layer-note').textContent.includes(`${V.num(sgr.omitted.policyRoutes)} 條只用於策略路由`)) throw new Error('L3 的說明應寫出沒畫的策略路由：' + $('#layer-note').textContent);
    App.graph.draw();
    $('#btn-l3-routes').click(); await App.layerJob;
    App.select(null); App.showLayer('device');
  });
  await step('VRF：IP 搜尋時同一個 IP 在多個 VRF 列出每個 VRF 讓使用者選（鍵盤可選）；選了只看那個 VRF；介面、設備與路由的詳情顯示 VRF、路由表、下一跳的 VRF 與策略路由', async () => {
    if (process.env.SMOKE_INPUT) return;
    const Q = App.Q; const V = S.view; const K = S.keys; const MAIN = K.MAIN_VRF;
    const ip = overlapIp(Q); const all = ip && Q.findIp(ip);
    if (!ip || all.vrfs.length < 2) throw new Error('測試前提：範例資料有和 main 重疊的位址');
    const inp = $('#search'); inp.value = ip; inp.dispatch('input'); await new Promise((r) => setTimeout(r, 150));
    if (!text('#search-dd').includes(ip)) throw new Error('搜尋應列出這個 IP');
    inp.dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'ip' || App.sel.vrf != null) throw new Error('搜尋的 IP 不分 VRF');
    const rows = () => $('#detail').testAll('.ip-vrf-row');
    if (!text('#detail').includes(`在 ${all.vrfs.length} 個 VRF`) || rows().length !== all.vrfs.length) throw new Error('同一個 IP 在多個 VRF 時應每個 VRF 一列：' + text('#detail').slice(0, 200));
    all.vrfs.forEach((v) => { if (!rows().some((tr) => tr.textContent.includes(v))) throw new Error('應列出 VRF ' + v); });
    const at = all.vrfs.findIndex((v) => v !== MAIN); const want = all.vrfs[at];
    if (rows()[at].getAttribute('tabindex') !== '0') throw new Error('VRF 的列應可用鍵盤聚焦');
    rows()[at].dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'ip' || App.sel.key !== ip || App.sel.vrf !== want) throw new Error('選了 VRF 應只看那個 VRF');
    if ($('#detail').querySelector('h2').textContent !== `${ip}@${want}` || rows().length) throw new Error('選了 VRF 的標題應是 位址@VRF，不再列選擇');
    const own = Q.findIp(ip, want).owners[0];
    if (!text('#detail').includes(Q.epName(own.ep))) throw new Error('應列出這個 VRF 的擁有者');
    // 從這個 IP 追蹤：預先選好這個 VRF
    $('#detail').testAll('button').find((b) => b.textContent === '從這個 IP 追蹤路由').click();
    if ($('#trace-vrf').value !== want || $('#trace-vrf-row').classList.contains('hidden')) throw new Error('從某個 VRF 的 IP 追蹤時應預先選好 VRF');
    $('#trace-pop').classList.add('hidden');
    $('#detail').querySelector('.ip-all-vrfs').click();
    if (App.sel.vrf != null || rows().length !== all.vrfs.length) throw new Error('「看所有 VRF」應回到不分 VRF');
    // 清單的 IP 每個 VRF 一列，點了只看那個 VRF
    const r0 = Q.inventory().rows.ips.find((r) => r.ip === ip && r.vrf === want);
    if (!r0) throw new Error('清單應有這個 IP 在 ' + want + ' 的列');
    // 介面詳情：VRF 與依據
    App.select({ type: 'interface', key: own.ep });
    const i = Q.getInterface(own.ep); const idt = text('#detail');
    if (!idt.includes('VRF') || !idt.includes(want) || !idt.includes(V.IFC_VRF_BASIS[i.vrfBasis])) throw new Error('介面詳情應寫出 VRF 與依據：' + idt.slice(0, 300));
    if (V.IFC_VRF_INFERRED.has(i.vrfBasis) !== $('#detail').querySelector('.ifc-vrf').textContent.includes('推論')) throw new Error('VRF 依據是推論時才標推論');
    // 設備詳情（PE）：VRF 設定、路由表欄、洩漏的下一跳標 @VRF
    const PE = K.splitEp(own.ep)[0]; App.select({ type: 'device', key: PE });
    const pd = text('#detail'); const defs = Q.vrfsOf(PE);
    if (!defs.length || !defs.every((v) => pd.includes(v.name)) || !$('#detail').testAll('th').some((x) => x.textContent === '路由表')) throw new Error('設備詳情應列出 VRF 設定與路由表欄');
    const leak = Q.routesOf(PE).find((r) => r.nh.some((n) => n.ip && n.vrf !== r.vrf));
    if (leak) { const n = leak.nh.find((x) => x.ip && x.vrf !== leak.vrf); if (!pd.includes(`${n.ip}@${n.vrf}`)) throw new Error('洩漏的下一跳應標 位址@VRF'); }
    // 設備詳情（有策略路由的 CE）：policy-rules、路由表、/routing rule 與來源
    const ce = Q.devices().find((d) => Q.policyOf(d.key).rules.length);
    if (!ce) throw new Error('測試前提：範例資料有 /routing rule');
    App.select({ type: 'device', key: ce.key });
    const cd = text('#detail'); const pol = Q.policyOf(ce.key);
    if (!cd.includes('策略路由') || !cd.includes(pol.policyRules.join(' → ')) || !pol.tables.every((t) => cd.includes(t.name)) || !Q.routingRules().filter((r) => r.dev === ce.key).every((r) => cd.includes(r.action))) throw new Error('設備詳情應列出策略路由的設定：' + cd.slice(0, 300));
    if (pol.tables.some((t) => t.vrf == null) && !cd.includes('只用於策略路由')) throw new Error('不是 VRF 的路由表應標「只用於策略路由」');
    App.select(null);
  });
  await step('VRF：路由追蹤可選 VRF，來源在多個 VRF 時提示選擇（不猜）；逐跳顯示 VRF、路由表與 /routing rule，策略路由不明與丟棄的結果有中文說明', async () => {
    if (process.env.SMOKE_INPUT) return;
    const Q = App.Q; const V = S.view; const K = S.keys; const MAIN = K.MAIN_VRF;
    const ip = overlapIp(Q); const vrfs = Q.findIp(ip).vrfs; const want = vrfs.find((v) => v !== MAIN);
    const dst = (Q.routesOf('TPE_PE_RT_01', want).flatMap((r) => r.nh).find((n) => n.ip && n.vrf !== want) || {}).ip; // 洩漏的閘道
    if (!dst) throw new Error('測試前提：PE 有洩漏到 main 的路由');
    App.openTrace(ip, dst, '');
    if ($('#trace-vrf-row').classList.contains('hidden')) throw new Error('基準有多個 VRF 時應顯示 VRF 選單');
    const opts = $('#trace-vrf').testAll('option').map((o) => o.getAttribute('value'));
    require('assert').deepStrictEqual(opts, [''].concat(Q.vrfs()));
    const before = App.sel;
    $('#trace-run').click();
    if ($('#trace-pop').classList.contains('hidden') || $('#trace-msg').classList.contains('hidden') || !text('#trace-msg').includes('多個 VRF') || App.sel !== before) throw new Error('來源在多個 VRF 時應留在追蹤畫面並提示選擇：' + text('#trace-msg'));
    if (document.activeElement !== $('#trace-vrf')) throw new Error('提示選擇時焦點應移到 VRF 選單');
    $('#trace-vrf').value = want; $('#trace-vrf').dispatch('keydown', { key: 'Enter' });
    const t = App.sel.result;
    if (App.sel.type !== 'trace' || !t.ok || t.vrf !== want || !$('#trace-pop').classList.contains('hidden') || !$('#trace-msg').classList.contains('hidden')) throw new Error('選了 VRF 後應追蹤那個 VRF');
    const d = text('#detail');
    if (!d.includes(V.vrfText(want)) || !d.includes('（指定）')) throw new Error('追蹤結果應寫出 VRF 與是否指定：' + d.slice(0, 200));
    t.hops.forEach((hp) => { if (!$('#detail').testAll('.hop').some((x) => x.dataset.vrf === hp.vrf)) throw new Error('每一跳應標出 VRF'); });
    const nx = t.hops.flatMap((hp) => hp.next).find((n) => n.dev && n.vrf !== want);
    if (!nx || !d.includes('@' + nx.vrf)) throw new Error('下一台在別的 VRF（路由洩漏）時應標出 @VRF');
    App.graph.draw();
    // 策略路由：可判斷的 /routing rule 查別的路由表；條件無法判斷時結果不明，列出規則
    const ce = Q.devices().find((x) => Q.policyOf(x.key).rules.length).key;
    const lan = Q.subnetsOf(ce).find((s) => Q.policyOf(ce).rules.some((r) => r.match['src-address'] && S.ip.inNet(r.match['src-address'].split('/')[0], s.net, s.len)));
    const rule1 = Q.policyOf(ce).rules.find((r) => r.match['src-address'] && r.table);
    const inRule = S.ip.fromInt(S.ip.toInt(rule1.match['src-address'].split('/')[0]) + 5);
    App.openTrace(inRule, '10.1.10.1', ''); $('#trace-run').click();
    const tp = App.sel.result;
    const hop = tp.ok && tp.hops.find((hp) => hp.rule);
    if (!hop || hop.table !== rule1.table || !text('#detail').includes('路由表 ' + rule1.table) || !text('#detail').includes(`/routing rule 第 ${rule1.order} 條`)) throw new Error('依 /routing rule 查的路由表應標在那一跳：' + text('#detail').slice(0, 300));
    const odd = Q.policyOf(ce).rules.find((r) => Object.keys(r.match).some((k) => !['src-address', 'dst-address', 'interface', 'routing-mark'].includes(k)) && r.match['dst-address']);
    if (!odd || !lan) throw new Error('測試前提：CE 有結果不明的 /routing rule');
    const outRule = S.ip.fromInt(S.ip.toInt(lan.net) + 5); const odst = S.ip.fromInt(S.ip.toInt(odd.match['dst-address'].split('/')[0]) + 5);
    App.openTrace(outRule, odst, ''); $('#trace-run').click();
    const tu = App.sel.result; const end = tu.ok && tu.ends.find((x) => x.status === 'policy');
    if (!end) throw new Error('條件無法判斷的 /routing rule 應使結果不明：' + JSON.stringify(tu.ends || tu));
    const ud = text('#detail');
    if (!ud.includes(V.TRACE_END.policy) || !ud.includes(`/routing rule 第 ${odd.order} 條`) || !ud.includes('策略路由不明')) throw new Error('策略路由不明應以中文說明並列出規則：' + ud.slice(0, 300));
    // 範例資料沒有 drop 的 /routing rule：用同一份結果換上 policy-drop 的結束，確認畫面的說明與規則（畫面只顯示查詢層的結果）
    const drop = Object.assign({}, tu, { reached: false, ends: [{ dev: ce, vrf: MAIN, status: 'policy-drop', note: `策略路由：/routing rule 第 ${odd.order} 條 drop，封包被丟棄`, rule: odd, path: [ce] }] });
    App.select({ type: 'trace', result: drop, reverse: null });
    const dt = text('#detail');
    if (!V.TRACE_END['policy-drop'] || !dt.includes(V.TRACE_END['policy-drop']) || !dt.includes(`/routing rule 第 ${odd.order} 條`) || !$('#detail').testAll('.hop').some((x) => x.dataset.status === 'policy-drop' && x.className.includes('end-bad'))) throw new Error('policy-drop 應有中文說明並列出規則');
    App.select(null);
  });
  await step('VRF：L4 可達性查詢可選 VRF，來源在多個 VRF 時列出可選的 VRF；逐跳標出 VRF；策略路由不明的原因有中文說明；前提取自 S.query.reachAssumptions（ipv4-vrf、policy-routing）；zone 矩陣可依 VRF 篩選，表格與 CSV 一致', async () => {
    if (process.env.SMOKE_INPUT) return;
    const Q = App.Q; const V = S.view; const K = S.keys; const MAIN = K.MAIN_VRF;
    App.showLayer('l4'); await App.l4Job;
    // 前提：照列查詢層的前提
    const as = S.query.reachAssumptions(); const lis = L4().testAll('.l4-assume-list li');
    require('assert').deepStrictEqual(lis.map((x) => x.dataset.code), as.map((a) => a.code));
    if (!['ipv4-vrf', 'policy-routing'].every((c) => lis.some((x) => x.dataset.code === c && x.textContent === as.find((a) => a.code === c).message))) throw new Error('前提應有 ipv4-vrf 與 policy-routing，文字取自查詢層');
    if (L4().querySelector('.l4-vrf-box').classList.contains('hidden')) throw new Error('基準有多個 VRF 時應顯示 VRF 選單');
    const ip = overlapIp(Q); const want = Q.findIp(ip).vrfs.find((v) => v !== MAIN);
    const dst = '10.1.30.2';
    const run = (src, d, proto, port, vrf) => { $('#l4-src').value = src; $('#l4-dst').value = d; $('#l4-proto').value = proto; $('#l4-proto').dispatch('change'); $('#l4-port').value = port; $('#l4-vrf').value = vrf; $('#l4-run').click(); };
    run(ip, dst, 'tcp', '22', '');
    const s = l4State();
    if (s.reach || !s.reachVrfs || s.reachVrfs.length < 2 || !text('#l4-drill').includes('多個 VRF')) throw new Error('來源在多個 VRF 時應提示選擇 VRF：' + text('#l4-drill').slice(0, 200));
    const btns = L4().testAll('.l4-reach-vrfs button');
    if (btns.length !== s.reachVrfs.length) throw new Error('每個可選的 VRF 一個按鈕');
    btns.find((b) => b.dataset.vrf === want).click();
    const r = l4State().reach;
    if (!r || r.vrf !== want || r !== Q.reach(ip, dst, { proto: 'tcp', port: 22, vrf: want }) || $('#l4-vrf').value !== want) throw new Error('選了 VRF 後應用那個 VRF 查詢');
    const dd = text('#l4-drill');
    if (!dd.includes(V.vrfText(want)) || !r.paths.some((p) => p.hops.some((hp) => dd.includes('@' + hp.vrf)))) throw new Error('L3 應標出查詢與每一跳的 VRF：' + dd.slice(0, 300));
    // 策略路由不明：原因有中文說明，列出規則
    const ce = Q.devices().find((x) => Q.policyOf(x.key).rules.length).key;
    const odd = Q.policyOf(ce).rules.find((x) => Object.keys(x.match).some((k) => !['src-address', 'dst-address', 'interface', 'routing-mark'].includes(k)) && x.match['dst-address']);
    // CE 的 LAN：包含 src-address 規則的網段（網段開頭的位址不在那條規則的範圍內）
    const lan = Q.subnetsOf(ce).find((x) => Q.policyOf(ce).rules.some((y) => y.match['src-address'] && S.ip.inNet(y.match['src-address'].split('/')[0], x.net, x.len)));
    run(S.ip.fromInt(S.ip.toInt(lan.net) + 5), S.ip.fromInt(S.ip.toInt(odd.match['dst-address'].split('/')[0]) + 5), 'tcp', '443', '');
    const rp = l4State().reach; const pt = text('#l4-drill');
    if (!rp || rp.verdict !== 'unknown' || !rp.reasons.some((x) => x.code === 'policy-routing')) throw new Error('條件無法判斷的 /routing rule 應使可達性不明：' + JSON.stringify(rp && rp.reasons));
    if (!pt.includes(V.REACH_REASON['policy-routing']) || pt.includes('未翻譯') || !pt.includes(`/routing rule 第 ${odd.order} 條`)) throw new Error('策略路由不明應以中文說明並列出規則：' + pt.slice(0, 300));
    $('#l4-vrf').value = '';
    // zone 矩陣：非 main 的 zone 名稱帶（VRF x）、id 帶 @VRF；依來源 zone 的 VRF 篩選
    const mx = Q.zoneMatrix();
    if (!mx.vrfs.includes(want)) throw new Error('測試前提：zone 矩陣有 ' + want);
    const zv = mx.zones.filter((z) => z.vrf === want);
    if (!zv.length || !zv.every((z) => z.id.endsWith('@' + want) && z.name.includes(`（VRF ${want}）`))) throw new Error('非 main 的 zone 的 id 與名稱應帶 VRF');
    if (!zv.every((z) => L4().testAll('th').some((th) => th.textContent.includes(z.name)))) throw new Error('矩陣的標頭應寫出帶 VRF 的 zone 名稱');
    const box = L4().querySelector('.l4-vrf-filter'); const fsel = $('#l4-vrf-filter');
    if (box.classList.contains('hidden')) throw new Error('zone 在多個 VRF 時應有 VRF 篩選');
    require('assert').deepStrictEqual(fsel.testAll('option').map((o) => o.getAttribute('value')), [''].concat(mx.vrfs));
    fsel.value = want; fsel.dispatch('change');
    const zi = new Map(mx.zones.map((z) => [z.id, z]));
    const cells = l4Cells();
    if (!cells.length || !cells.every((td) => zi.get(td.dataset.src).vrf === want)) throw new Error('VRF 篩選後只列來源在那個 VRF 的 zone');
    if (new Set(cells.map((td) => td.dataset.dst)).size !== mx.zones.length) throw new Error('VRF 篩選後目的保留全部的 zone（看得到跨 VRF 的格子）');
    // 鍵盤：列數與欄數不同時方向鍵照樣移動
    cells[0].dispatch('keydown', { key: 'End' }); if (document.activeElement.dataset.c !== String(mx.zones.length - 1)) throw new Error('End 應移到這一列的最後一欄');
    cells[0].dispatch('keydown', { key: 'ArrowDown' });
    const shown = mx.cells.filter((c) => zi.get(c.src).vrf === want);
    const { files } = await captureDownloads(() => L4().querySelector('.l4-csv').click());
    const csv = parseCsv(files[0].text.replace(/^﻿/, ''));
    const ci = csv[0].indexOf('來源 VRF');
    if (ci < 0 || csv[0].indexOf('目的 VRF') < 0 || csv.length - 1 !== shown.length || !csv.slice(1).every((row) => row[ci] === want) || !files[0].name.includes(want)) throw new Error('CSV 應只有篩選後的格子，並有來源與目的 VRF 欄');
    L4().testAll('.l4-modes button').find((b) => b.dataset.mode === 'table').click(); await App.l4Job;
    if (L4().testAll('.l4-row').length !== shown.length || !L4().testAll('th').some((th) => th.textContent === '來源 VRF')) throw new Error('表格檢視也依 VRF 篩選，並有 VRF 欄');
    L4().testAll('.l4-modes button').find((b) => b.dataset.mode === 'matrix').click(); await App.l4Job;
    fsel.value = ''; fsel.dispatch('change');
    if (l4Cells().length !== mx.cells.length) throw new Error('取消 VRF 篩選後列出全部的格子');
    App.showLayer('device');
  });
  await step('只有 main 的網路：畫面與加入 VRF 之前相同（L3 不依 VRF 分框、詳情與清單沒有 VRF 欄位、追蹤與可達性沒有 VRF 選單、矩陣與 CSV 沒有 VRF 欄）', async () => {
    if (process.env.SMOKE_INPUT) return;
    const VA = S.view.app; const orig = { snap: App.snap, sources: App.round.sources, profile: App.round.profile };
    // 範例資料去掉最後的 PE 與 CE（VRF 與策略路由只在它們身上）
    const src = orig.sources.find((x) => x.text.includes('\nTPE_PE_RT_01 ('));
    const cut = src.text.indexOf('\n_____\nTPE_PE_RT_01 (');
    if (cut < 0 || src.text.slice(cut + 1).split('\n_____\n').some((b) => b.trim() && !/^(_____\n)?TPE_(PE|CE)_RT_01 \(/.test(b.trim()))) throw new Error('測試前提：PE 與 CE 是範例資料最後的兩台設備');
    const sources = orig.sources.map((x) => (x === src ? { name: x.name, text: x.text.slice(0, cut + 1) } : x));
    try {
      const snap = S.build(sources, { profile: orig.profile, now: '2026-01-01T00:00:00Z' });
      VA.load(snap, null, { sources, profile: orig.profile }); await App.ledgerJob; await App.layoutJob;
      const Q = App.Q; const g = App.graph;
      require('assert').deepStrictEqual(Array.from(Q.vrfs()), ['main']);
      // L3：分群沿用設備圖，不畫 VRF 的框，說明不提 VRF
      App.showLayer('l3', { rebuild: true }); await App.layerJob;
      const groupOf = new Map(App.deviceGraph.nodes.map((n) => [n.id, n.group || '']));
      if (App.layerEntry().info.byVrf || g.nodes.some((n) => String(n.group || '').startsWith('VRF '))) throw new Error('只有 main 時不依 VRF 分框');
      g.nodes.filter((n) => n.kind !== 'subnet').forEach((n) => { if (n.id !== n.dev || n.group !== (groupOf.get(n.dev) || '')) throw new Error('只有 main 時設備節點的 id 與分群和加入 VRF 之前相同：' + n.id); });
      if ($('#layer-note').textContent.includes('VRF')) throw new Error('只有 main 時 L3 的說明不提 VRF');
      App.showLayer('device');
      // 詳情：介面、有路由的設備、IP 沒有 VRF 欄位
      const dev = Q.devices().find((d) => Q.routesOf(d.key).some((r) => r.nh.some((n) => n.ip)));
      App.select({ type: 'device', key: dev.key });
      if ($('#detail').testAll('th').some((th) => th.textContent === '路由表' || th.textContent === 'VRF') || text('#detail').includes('@main')) throw new Error('只有 main 時設備詳情沒有路由表與 VRF 欄');
      App.select({ type: 'interface', key: Q.interfacesOf(dev.key).find((i) => Q.addressesOf(i.key).length).key });
      if ($('#detail').querySelector('.ifc-vrf')) throw new Error('只有 main 時介面詳情沒有 VRF');
      const ipr = Q.ipEntries().find((r) => r.owner);
      App.select({ type: 'ip', key: ipr.ip });
      const kvKeys = () => $('#detail').testAll('.k').map((k) => k.textContent);
      if ($('#detail').querySelector('h2').textContent !== ipr.ip || $('#detail').testAll('.ip-vrf-row').length || kvKeys().includes('VRF') || text('#detail').includes('（VRF')) throw new Error('只有 main 時 IP 詳情沒有 VRF');
      // 清單：IP 與網段沒有 VRF 欄
      goStep('view'); document.testAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('IP')).click();
      if (document.testAll('#pane-inventory th').some((th) => th.textContent.startsWith('VRF'))) throw new Error('只有 main 時 IP 清單沒有 VRF 欄');
      // 路由追蹤：沒有 VRF 選單，結果沒有 VRF
      App.openTrace(ipr.ip, '10.1.10.1');
      if (!$('#trace-vrf-row').classList.contains('hidden')) throw new Error('只有 main 時追蹤沒有 VRF 選單');
      $('#trace-run').click();
      // 結果的說明文字來自查詢層（直連網段的說明寫出 VRF main）；畫面自己不加 VRF 的欄位與標示
      if (App.sel.type !== 'trace' || kvKeys().includes('VRF') || $('#detail').testAll('.trace-vrf').length) throw new Error('只有 main 時追蹤結果不標 VRF：' + text('#detail').slice(0, 200));
      // L4：沒有 VRF 選單、沒有 VRF 篩選；表格與 CSV 沒有 VRF 欄
      App.showLayer('l4', { rebuild: true }); await App.l4Job;
      if (!L4().querySelector('.l4-vrf-box').classList.contains('hidden') || !L4().querySelector('.l4-vrf-filter').classList.contains('hidden')) throw new Error('只有 main 時 L4 沒有 VRF 選單與篩選');
      const { files } = await captureDownloads(() => L4().querySelector('.l4-csv').click());
      if (parseCsv(files[0].text.replace(/^﻿/, ''))[0].some((x) => x.includes('VRF'))) throw new Error('只有 main 時 CSV 沒有 VRF 欄');
      if (text('#l4-zones').includes('（VRF')) throw new Error('只有 main 時 zone 名稱不帶 VRF');
    } finally {
      App.showLayer('device');
      VA.load(orig.snap, null, { sources: orig.sources, profile: orig.profile }); await App.ledgerJob; await App.layoutJob;
    }
  });
  await step('清單分頁列出設備、介面、MAC、VLAN，並可篩缺 IP；總覽顯示去重複的 IP（ARP）', () => {
    const C = App.Q.inventory().counts; const st = App.snap.meta.stats;
    const same = [['devices', st.devices], ['interfaces', st.interfaces], ['macs', st.macs], ['vlans', st.vlans]];
    same.forEach(([k, v]) => { if (C[k] !== v) throw new Error(`清單與總覽的 ${k} 不一致：${C[k]} vs ${v}`); });
    // 位址鍵（S.keys.inVrf）：同一個 IP 在兩個 VRF 是兩筆
    if (C.arpIps !== new Set(App.snap.model.arps.map((x) => S.keys.inVrf(x.ip, x.vrf))).size) throw new Error('IP（ARP）應為去重複的 ARP 位址鍵數');
    if (C.ips < C.arpIps || C.ips !== new Set(App.Q.inventory().rows.ips.map((r) => r.key)).size) throw new Error('IP 清單應依位址鍵去重複且涵蓋 ARP');
    const rows = App.Q.macEntries(); if (!rows.length) throw new Error('清單應有資料');
    const noIp = App.snap.model.macs.filter((x) => !x.ips.length).length;
    if (rows.filter((r) => r.noIp).length < noIp) throw new Error('缺 IP 筆數不符');
    goStep('view'); // 清單在「② 檢視」的左側
    if ($('#pane-inventory').classList.contains('hidden') || !$('#pane-findings').classList.contains('hidden')) throw new Error('② 檢視的左側應是清單');
    const m = App.snap.model; const ips = App.Q.ipEntries();
    const t = text('#pane-inventory');
    [`設備 ${m.devices.length + App.Q.endpointEntries().length}`, `介面 ${m.interfaces.length}`, `IP ${ips.length}`, `網段 ${m.prefixes.length}`, `MAC ${new Set(rows.map((r) => r.mac)).size}`, `VLAN ${m.vlans.length}`].forEach((x) => { if (!t.includes(x)) throw new Error('清單缺少分類：' + x); });
    if (new Set(ips.map((r) => r.key)).size !== ips.length) throw new Error('IP 清單應依位址鍵去重複');
    document.testAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('網段')).click();
    const pre = App.Q.inventory().rows.prefixes;
    if (!pre.length || document.testAll('#pane-inventory tbody tr').length !== pre.length) throw new Error('網段清單列數應等於推導出的網段數');
    pre.forEach((p) => { if (p.ipCount !== ips.filter((r) => r.vrf === p.vrf && S.ip.inNet(r.ip, p.net, p.len)).length) throw new Error('網段的 IP 數應等於清單中同一個 VRF、落在網段內的 IP'); });
    document.querySelector('#pane-inventory tbody tr').dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'interface' || !pre[0].eps.includes(App.sel.key)) throw new Error('點網段應選取設定該網段的介面');
    const macChip = document.testAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('MAC'));
    if (new Set(rows.map((r) => r.mac)).size !== App.snap.meta.stats.macs) throw new Error('清單的不重複 MAC 數應等於總覽');
    const nEnd = App.Q.endpointEntries().length; const unk = App.snap.model.interfaces.filter((i) => i.unknownPeer).length;
    if (nEnd < unk || new Set(App.Q.endpointEntries().map((e) => e.key)).size !== unk) throw new Error('終端的不重複介面數應等於未知對端介面數，且不可少於它');
    document.testAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('設備')).click();
    const t0 = text('#pane-inventory'); ['全部 ' + (m.devices.length + nEnd), '終端 ' + nEnd].forEach((x) => { if (!t0.includes(x)) throw new Error('設備清單缺少分類：' + x); });
    // 兩層選項：清單種類是分段按鈕，種類內是篩選選項；0 筆的篩選停用
    const seg = $('#pane-inventory .seg'); if (!seg || seg.testAll('button').length !== 6) throw new Error('清單種類應為分段按鈕');
    const sub = document.testAll('#pane-inventory .summary').find((x) => x.className.split(' ').includes('sub'));
    if (!sub) throw new Error('種類內的篩選應是第二層');
    const zero = sub.testAll('.chip').find((c) => / 0$/.test(c.textContent));
    if (zero && (!zero.className.includes('off') || zero.getAttribute('aria-disabled') !== 'true')) throw new Error('0 筆的篩選應停用');
    const firstRow = document.querySelector('#pane-inventory tbody tr');
    if (!firstRow || firstRow.getAttribute('tabindex') !== '0') throw new Error('可點選清單列應可透過鍵盤聚焦');
    firstRow.dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'device') throw new Error('清單列按 Enter 應選取設備');
    document.testAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('終端')).click();
    if (document.testAll('#pane-inventory tbody tr').length !== Math.min(nEnd, 500)) throw new Error('終端篩選列數不符');
    const ipChip = document.testAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('IP')); ipChip.click();
    document.testAll('#pane-inventory th')[0].dispatch('click');
    const col = () => document.testAll('#pane-inventory tbody tr').map((tr) => tr.testAll('td')[0].textContent);
    const asc = col(); const num = (x) => x.split('.').reduce((n, p) => n * 256 + +p, 0);
    if (!asc.length || asc.some((x, i) => i && num(asc[i - 1]) > num(x))) throw new Error('IP 清單應依 IP 數值升冪');
    document.testAll('#pane-inventory th')[0].dispatch('click');
    const desc = col(); if (asc.length > 1 && desc[0] === asc[0]) throw new Error('再點一次應反向排序');
    document.testAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('MAC')).click();
    macChip.click(); const t2 = text('#pane-inventory'); if (!t2.includes('缺 IP ' + new Set(rows.filter((r) => r.noIp).map((r) => r.mac)).size) || !t2.includes('全部 ' + App.snap.meta.stats.macs)) throw new Error('缺 IP 摘要不正確');
    App.select(null); const ov = text('#right'); const uniq = new Set(App.snap.model.arps.map((x) => x.ip)).size;
    if (!ov.includes('IP（ARP）' + uniq.toLocaleString()) && !ov.includes('IP（ARP）')) throw new Error('總覽缺少 IP（ARP）');
  });
  await step('覆蓋率在「① 輸入」（資料中心）', () => {
    goStep('input');
    if ($('#hub').classList.contains('hidden') || !$('#hub').contains($('#pane-coverage'))) throw new Error('覆蓋率應在資料中心（① 輸入）');
    if (!text('#pane-coverage').includes(process.env.SMOKE_INPUT ? '有缺漏 0' : '有缺漏 1')) throw new Error('覆蓋率摘要不正確');
    S.view.app.closeHub();
  });
  await step('比對：在「⑤ 驗證」全寬顯示，資料中心的「預期資料」列出同一份比對的摘要', async () => {
    goStep('verify');
    if (App.step !== 'verify' || App.centerView !== 'verify' || $('#view-verify').classList.contains('hidden') || document.activeElement !== $('#verify-title')) throw new Error('⑤ 驗證應在中間開啟並聚焦標題');
    if (!$('#view-verify').contains($('#compare-body')) || !$('#left').classList.contains('hidden')) throw new Error('比對在中間的驗證畫面，⑤ 沒有左側清單');
    const inp = $('#compare-body').querySelector('input'); inp.files = [{ name: 'expected-sample.json', text: async () => fs.readFileSync(path.join(ROOT, 'samples/expected-sample.json'), 'utf8') }];
    inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
    if (!text('#compare-body').includes('有差異')) throw new Error('比對結果未顯示');
    // 資料中心的摘要和驗證畫面的結果是同一份比對（筆數依關係，不寫死）
    const rep = S.view.lists.compare.report(App); const nDiff = rep.items.filter((i) => i.status !== 'ok').length;
    const hubRow = $('#hub').testAll('.hub-row').find((r) => r.getAttribute('data-item') === 'expected');
    if (!hubRow.textContent.includes('expected-sample.json') || !hubRow.textContent.includes(`有差異 ${S.view.num(nDiff)} 項`)) throw new Error('資料中心應列出預期資料的檔名與差異筆數：' + hubRow.textContent);
    // 點一列：詳情在右側，比對留在中間
    const row = $('#compare-body').testAll('tbody tr').find((tr) => tr.getAttribute('tabindex') === '0');
    if (row) {
      App.select(null); row.click();
      if (App.centerView !== 'verify') throw new Error('點比對的一列時，比對應留在中間');
    }
    App.showView('graph');
  });
  await step('匯出：基準 JSON 與檢查結果 CSV／Markdown 在本機產生（入口在資料中心），下載後釋放 URL，不改寫基準', async () => {
    const before = JSON.stringify(App.snap);
    if ($('#btn-json')) throw new Error('基準 JSON 的匯出已移到資料中心，工具列不應再有「匯出 JSON」');
    const { made, revoked, anchors, files } = await captureDownloads(() => {
      if (!hubBtn('export-snapshot') || !hubBtn('export-csv') || !hubBtn('export-markdown')) throw new Error('資料中心應有基準 JSON、CSV 與 Markdown 的匯出按鈕');
      hubBtn('export-snapshot').click(); hubBtn('export-csv').click(); hubBtn('export-markdown').click();
    });
    if (made.length !== 3 || anchors.length !== 3) throw new Error('三種匯出各應產生一個下載');
    if (revoked.join() !== made.map((b, i) => 'blob:smoke/' + (i + 1)).join()) throw new Error('下載後應釋放每一個 object URL');
    if (anchors.some((a) => a.parentNode)) throw new Error('下載用的連結應在點擊後移除');
    const names = anchors.map((a) => a.getAttribute('download'));
    const devs = String(App.snap.meta.stats.devices);
    if (!/\.json$/.test(names[0]) || !/\.csv$/.test(names[1]) || !/\.md$/.test(names[2])) throw new Error('副檔名不符：' + names);
    if (!names.every((n) => n.includes(devs + 'dev') && /\d{8}T\d{6}Z/.test(n))) throw new Error('檔名應含設備數與建立時間：' + names);
    if (JSON.stringify(App.snap) !== before) throw new Error('匯出不可改寫基準');
    const bytes = files.map((f) => f.bytes);
    const [json, csv, md] = files.map((f) => f.text);
    require('assert').deepStrictEqual(JSON.parse(json), App.snap);
    // CSV：UTF-8 BOM 開頭（bytes EF BB BF），內容依 RFC 4180 解析回來要和每筆 finding 對得上
    if (bytes[1].subarray(0, 3).toString('hex') !== 'efbbbf') throw new Error('CSV 應以 UTF-8 BOM 開頭');
    const rows = parseCsv(csv.replace(/^\uFEFF/, ''));
    if (rows[0].join() !== 'severity,id,title,message,entities,evidence,acknowledged,ack_kind,ack_note,device,action,status,note,waiver_reason,waiver_until,facet') throw new Error('CSV 標頭不符：' + rows[0]);
    if (rows.length - 1 !== App.snap.findings.length) throw new Error('CSV 每筆檢查結果應恰好一列');
    App.snap.findings.forEach((f, i) => {
      const r = rows[i + 1]; const lg = S.view.app.ledgerExport(f); const ack = lg && !S.view.remediation.isPendingStatus(lg.status) ? lg : {};
      if (r[0] !== f.severity || r[1] !== f.id || r[3].replace(/^'/, '') !== f.message) throw new Error(`CSV 第 ${i + 2} 列與 ${f.id} 不符`);
      if (!f.entities.every((e) => r[4].includes(e.type + ':' + e.key))) throw new Error(`CSV ${f.id} 缺少相關實體`);
      if (r[5] !== f.evidence.map((e) => `${e.file}:${e.line}`).join('; ')) throw new Error(`CSV ${f.id} 的證據應合在同一格`);
      if (r[6] !== (ack.at || '')) throw new Error(`CSV ${f.id} 的 acknowledged 應為確認時間（未確認為空白）`);
      if (r[7] !== (ack.status || '') || r[8].replace(/^'/, '') !== (ack.note || '')) throw new Error(`CSV ${f.id} 的 ack_kind／ack_note 應為已處理的狀態與備註`);
      if (r[11] !== (lg ? lg.status : '')) throw new Error(`CSV ${f.id} 的 status 應為處理紀錄的狀態`);
      if (r[9] !== (App.Q.findingDevice(f) || '')) throw new Error('CSV ' + f.id + ' 的 device 應為所屬設備');
      if (r[10].replace(/^'/, '') !== S.check.CATALOG[f.id].action) throw new Error('CSV ' + f.id + ' 的 action 應與 CATALOG 一致（原文照錄）');
      if (r[15].replace(/^'/, '') !== (f.facet != null ? String(f.facet) : '')) throw new Error('CSV ' + f.id + ' 的 facet 應為檢查項目的原值（沒有時空白）');
      if (r.length !== rows[0].length) throw new Error('CSV 第 ' + (i + 2) + ' 列的欄數應與標頭相同');
    });
    // Markdown（依規則）：每條出現的規則附處理建議與逐條的常見原因，反引號內是行內程式碼（不被跳脫）
    S.util.uniq(App.snap.findings.map((f) => f.id)).forEach((id) => {
      const sec = md.slice(md.indexOf('\n### ' + id + ' ')); const c = S.check.CATALOG[id];
      const line = sec.split('\n').find((x) => x.startsWith('- 處理建議：'));
      if (!line) throw new Error('Markdown 的 ' + id + ' 應附處理建議');
      Array.from(c.action.matchAll(/`[^`]+`/g)).forEach((m) => { if (!line.includes(m[0])) throw new Error('Markdown 的 ' + id + ' 應以行內程式碼呈現 ' + m[0] + '：' + line); });
      if (line.includes('\\`')) throw new Error('Markdown 的 ' + id + ' 處理建議不應跳脫指令的反引號');
      const lines = sec.split('\n'); const from = lines.indexOf('- 常見原因：');
      const causeLines = from < 0 ? [] : lines.slice(from + 1, from + 1 + c.causes.length);
      if (causeLines.length !== c.causes.length || causeLines.some((x, n) => !x.startsWith('  - ')
        || !Array.from(c.causes[n].matchAll(/`[^`]+`/g)).every((m) => x.includes(m[0])))) throw new Error('Markdown 的 ' + id + ' 應逐條列出常見原因（指令為行內程式碼）');
    });
    // 跳脫：逗號、引號、換行、公式開頭；以人工 finding 走一次完整組字再解析回來
    const X = S.view.exporter;
    [['a,b', '"a,b"'], ['說 "hi"', '"說 ""hi"""'], ['x\ny', '"x\ny"'], ['=1+1', "'=1+1"], [' 空白', '" 空白"'], ['一般', '一般']].forEach(([v, want]) => {
      if (X.csvCell(v) !== want) throw new Error(`csvCell(${JSON.stringify(v)}) 應為 ${want}，實際 ${X.csvCell(v)}`);
    });
    // 匯出的組字函式只透過 Q 讀取：以目前基準的副本換上人工 finding，再建立查詢介面
    const tricky = { ...JSON.parse(JSON.stringify(App.snap)), findings: [{ id: 'T01', severity: 'warn', title: '標題, "引號"', message: '第一行\r\n第二行, "x"',
      entities: [{ type: 'device', key: 'A,B' }], evidence: [{ file: 'a.txt', line: 3, text: '' }, { file: 'b "x".txt', line: 9, text: '' }] }] };
    const tr = parseCsv(X.findingsCsv(S.query(tricky)).replace(/^\uFEFF/, ''));
    if (tr.length !== 2 || tr[1][2] !== '標題, "引號"' || tr[1][3] !== '第一行\r\n第二行, "x"' || tr[1][4] !== 'device:A,B'
      || tr[1][5] !== 'a.txt:3; b "x".txt:9') throw new Error('CSV 跳脫後應能完整解析回原值：' + JSON.stringify(tr[1]));
    // Markdown：依嚴重度分組（錯誤 → 警告 → 提醒），每筆 finding 的規則與證據行號都在
    const heads = ['error', 'warn', 'info'].map((s) => md.indexOf(`\n## ${S.view.SEV[s]}（`));
    if (heads.some((x) => x < 0) || heads.some((x, i) => i && heads[i - 1] > x)) throw new Error('Markdown 應依嚴重度分組並依序排列');
    App.snap.findings.forEach((f) => {
      const sev = ['error', 'warn', 'info'].indexOf(f.severity); const at = md.indexOf(`\n### ${f.id} `, heads[sev]);
      if (at < 0 || (sev < 2 && at > heads[sev + 1])) throw new Error(`Markdown 的 ${f.id} 應在「${S.view.SEV[f.severity]}」分組下`);
      if (!f.evidence.every((e) => md.includes(` 第 ${e.line} 行：`))) throw new Error(`Markdown 缺少 ${f.id} 的證據行號`);
    });
    const tmd = X.findingsMarkdown(S.query(tricky));
    if (!tmd.includes('標題, "引號"') || !tmd.includes('第一行 第二行')) throw new Error('Markdown 訊息應保留文字並把換行併成一行');
    tricky.findings[0].message = '<b>*x*</b>'; tricky.findings[0].evidence[0].text = 'a`b';
    const emd = X.findingsMarkdown(S.query(tricky));
    if (!emd.includes('\\<b\\>\\*x\\*\\</b\\>') || !emd.includes('`` a`b ``')) throw new Error('Markdown 應跳脫格式字元與行內程式碼的反引號');
  });
  let ackedKey = null; // 處理紀錄中已處理的 finding 鍵：清除基準後要仍然存在
  await step('處理紀錄取代確認：每筆檢查結果都在處理紀錄中，可變更狀態與備註，不合法的變更顯示錯誤，已處理另列分組並從摘要排除，匯出對應欄位', async () => {
    const Q = App.Q; const all = App.snap.findings; const VA = S.view.app; const RV = S.view.remediation; const LG = S.ledger;
    if (all.some((f) => !VA.ledgerItem(f))) throw new Error('建立基準後每筆檢查結果都應在處理紀錄中（advance）');
    if (VA.ledgerRoundIndex() < 0) throw new Error('處理紀錄應有這份基準的一輪');
    const saved0 = await S.store.get('ledger');
    if (!saved0 || !LG.validate(saved0).ok) throw new Error('處理紀錄應存進 store 的 ledger 且格式正確');
    const problems = () => all.filter((f) => f.severity !== 'info' && VA.isPending(f));
    const before = problems();
    if (!before.length) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有錯誤或警告'); }
    const f = before[0]; const key = Q.findingKey(f);
    goStep('triage');
    const group = (id) => document.testAll('#pane-findings .fgroup').find((x) => {
      const el = x.querySelector('.head .id'); return el && el.textContent === id && !x.className.includes('handled');
    });
    const editBtn = (x) => document.testAll('#pane-findings .ledger-edit').find((b) => b.getAttribute('aria-label') === '處理：' + x.message);
    const editor = () => $('#pane-findings').querySelector('.ledger-editor');
    const errText = () => { const e = editor() && editor().querySelector('.ledger-error'); return e && !e.classList.contains('hidden') ? e.textContent : ''; };
    const fill = async (status, o) => {
      const ed = editor(); if (!ed) throw new Error('按「處理」後應出現狀態欄位');
      ed.querySelector('select').value = status;
      const set = (cls, v) => { if (v !== undefined) ed.testAll('input').find((i) => i.className.includes(cls)).value = v; };
      set('ledger-note', o.note); set('ledger-waiver-reason', o.reason); set('ledger-waiver-until', o.until);
      ed.testAll('button').find((b) => b.getAttribute('aria-label') === '儲存處理狀態：' + f.message).click();
      await new Promise((r) => setTimeout(r, 10));
    };
    if (!editBtn(f)) group(f.id).querySelector('.head').click();
    const snapBefore = JSON.stringify(App.snap);
    editBtn(f).click();
    const opts = editor().querySelector('select').testAll('option').map((o) => o.getAttribute('value'));
    const it0 = VA.ledgerItem(f);
    if (opts.join() !== [it0.status].concat(LG.USER_TO[it0.status]).join()) throw new Error('可選的狀態應是目前狀態加上 USER_TO：' + opts);
    editor().testAll('button').find((b) => b.textContent === '取消').click();
    if (editor()) throw new Error('按「取消」應關閉欄位');
    // 不合法：仍出現在最新一輪的項目不能手動標為 fixed；核心的錯誤要顯示，處理紀錄不變
    editBtn(f).click();
    const ledgerBefore = JSON.stringify(VA.ledger());
    await fill('fixed', { note: '' });
    if (!errText().includes('不能手動標為 fixed')) throw new Error('S.ledger.set 的錯誤應顯示在欄位下方：' + errText());
    if (JSON.stringify(VA.ledger()) !== ledgerBefore || VA.ledgerStatus(f) !== it0.status) throw new Error('不合法的變更不可改動處理紀錄');
    // 可接受沒有原因：畫面要求填寫
    await fill('accepted', { reason: '  ' });
    if (!errText().includes('原因')) throw new Error('可接受沒有原因時應提示');
    // 可接受：原因與預設到期日（WAIVER_DAYS 天後）
    const reason1 = '設計如此, 見 "變更單" 123';
    await fill('accepted', { reason: reason1, note: '備註一' });
    if (editor()) throw new Error('儲存成功後應關閉欄位');
    const it1 = VA.ledgerItem(f);
    if (it1.status !== 'accepted' || it1.waiver.reason !== reason1 || it1.note !== '備註一') throw new Error('應設為可接受並記下原因與備註：' + JSON.stringify(it1));
    const days = (Date.parse(it1.waiver.until) - Date.now()) / 86400000;
    if (days < LG.WAIVER_DAYS - 2 || days > LG.WAIVER_DAYS + 1) throw new Error('豁免到期日預設應約 WAIVER_DAYS 天後：' + it1.waiver.until);
    if (JSON.stringify(App.snap) !== snapBefore) throw new Error('處理紀錄不可改寫基準');
    let saved = await S.store.get('ledger'); ackedKey = key;
    if (!saved.items[key] || saved.items[key].status !== 'accepted') throw new Error('變更應存進 store 的 ledger');
    // 已處理分組：依狀態，預設收合
    const handled = (s) => document.testAll('#pane-findings .fgroup').find((x) => x.className.includes('handled') && x.getAttribute('data-status') === s);
    if (!handled('accepted')) throw new Error('應有「可接受」的已處理分組');
    if (handled('accepted').testAll('.fitem').length) throw new Error('已處理分組預設應收合');
    handled('accepted').querySelector('.head').click();
    const gt = handled('accepted').textContent;
    if (!gt.includes(f.message) || !gt.includes('豁免原因：' + reason1) || !gt.includes('備註：備註一')) throw new Error('已處理的項目應顯示原因與備註');
    // 摘要：排除已處理並註明
    const left = problems(); const summary = text('#baseline-summary');
    if (left.length !== before.length - 1) throw new Error('處理一筆後，待處理的問題應少一筆');
    const nHandled = all.filter((x) => x.severity !== 'info' && !VA.isPending(x)).length;
    if (!summary.includes(`另有 ${nHandled} 項已處理`)) throw new Error('基準摘要應註明已處理筆數：' + summary);
    // 改為誤報：備註以公式開頭，CSV 要防公式注入；規則品質列出這條規則
    document.testAll('#pane-findings .ledger-edit').find((b) => b.getAttribute('aria-label') === '處理：' + f.message).click();
    const note2 = '=SUM(A1) 是誤判';
    await fill('false-positive', { note: note2 });
    const it2 = VA.ledgerItem(f);
    if (it2.status !== 'false-positive' || it2.waiver !== null || it2.note !== note2) throw new Error('應改為誤報、移除豁免：' + JSON.stringify(it2));
    if (it2.history[it2.history.length - 1].waiver.reason !== reason1) throw new Error('被移除的豁免應記在歷程');
    App.selectFinding(all.indexOf(f));
    if (text('#detail').includes(f.message) && !text('#detail').includes(RV.statusText('false-positive'))) throw new Error('詳情的檢查結果應標出處理狀態');
    goStep('triage');
    const fp = document.testAll('#pane-findings .fgroup').find((x) => x.className.includes('fp-rules'));
    if (!fp) throw new Error('有誤報時應列出誤報率最高的規則');
    fp.querySelector('.head').click();
    const fpRow = document.testAll('#pane-findings .fp-rules .rule').find((r) => r.getAttribute('data-rule-id') === f.id);
    const st = LG.ruleStats(VA.ledger()).find((r) => r.id === f.id);
    if (!fpRow || !fpRow.textContent.includes(`誤報 ${st.falsePositive} / ${st.total}`)) throw new Error('誤報率應與 S.ledger.ruleStats 一致');
    // 匯出：舊欄位由處理紀錄對應；Markdown 標示狀態
    const X = S.view.exporter; const opts2 = { ledgerOf: VA.ledgerExport };
    const rows = parseCsv(X.findingsCsv(App.Q, opts2).replace(/^﻿/, ''));
    const row = rows[all.indexOf(f) + 1]; const userAt = VA.ledgerUserAt(it2);
    if (row[6] !== userAt || row[7] !== 'false-positive' || row[8] !== "'" + note2 || row[11] !== 'false-positive' || row[12] !== "'" + note2) throw new Error('CSV 的處理紀錄欄位不符：' + row);
    if (all.filter((x) => VA.isPending(x)).some((x) => rows[all.indexOf(x) + 1][6] !== '' || rows[all.indexOf(x) + 1][7] !== '')) throw new Error('待處理的列 acknowledged／ack_kind 應為空白');
    const md = X.findingsMarkdown(App.Q, opts2);
    if (!md.includes(`**${RV.statusText('false-positive')}**（${userAt}）`) || !md.includes('備註：') || !md.includes('- 處理紀錄：')) throw new Error('Markdown 應標示處理狀態與備註');
    // 改回待處理：回到原本的分組
    document.testAll('#pane-findings .fgroup').filter((x) => x.className.includes('handled') && !x.testAll('.fitem').length).forEach((g) => g.querySelector('.head').click());
    document.testAll('#pane-findings .ledger-edit').find((b) => b.getAttribute('aria-label') === '處理：' + f.message).click();
    await fill('open', { note: '' });
    if (VA.ledgerStatus(f) !== 'open' || problems().length !== before.length) throw new Error('改回待處理後應算回待處理的問題');
  });
  await step('檢查結果依設備分組：依第一個設備實體或實體所屬設備，不屬於任何設備的另一組；匯出可依設備排序', async () => {
    const Q = App.Q; const all = App.snap.findings; const R = Object.assign({}, S.view.remediation, { findingDevice: (q, f) => q.findingDevice(f) }); const K = S.keys;
    // 歸屬規則：有 device 實體時是第一個；否則是某個實體所屬的設備；都對不到時為 null
    const owns = (d, e) => (e.type === 'interface' && K.splitEp(e.key)[0] === d) || (e.type === 'link' && String(e.key).split('~').some((ep) => K.splitEp(ep)[0] === d))
      || (e.type === 'rule' && (Q.getFirewallRule(e.key) || {}).dev === d) || (e.type === 'service' && K.splitEp(e.key)[0] === d)
      || (e.type === 'ip' && !!Q.ipOwner(e.key) && K.splitEp(Q.ipOwner(e.key))[0] === d);
    all.forEach((f) => {
      const d = R.findingDevice(Q, f); const first = f.entities.find((e) => e.type === 'device' && Q.getDevice(e.key));
      if (first && d !== Q.getDevice(first.key).key) throw new Error(`${f.id} 有設備實體時應歸到第一個設備`);
      if (!first && d !== null && !f.entities.some((e) => owns(d, e))) throw new Error(`${f.id} 應歸到實體所屬的設備`);
      if (!first && d === null && Q.devices().some((x) => f.entities.some((e) => owns(x.key, e)))) throw new Error(`${f.id} 的實體屬於某台設備，不應列為不屬於任何設備`);
    });
    if (R.findingDevice(Q, { entities: [] }) !== null || R.findingDevice(Q, { entities: [{ type: 'mac', key: '000000000000' }] }) !== null) throw new Error('沒有實體或只有 MAC 的檢查結果不屬於任何設備');
    goStep('triage');
    // 打開全部嚴重度，再切到依設備
    for (let n = 0; n < 3; n++) {
      const off = $('#pane-findings').querySelector('.summary').testAll('.chip').find((c) => c.getAttribute('aria-pressed') === 'false' && c.getAttribute('aria-disabled') !== 'true');
      if (off) off.click();
    }
    const seg = (k) => $('#pane-findings').testAll('button').find((b) => b.getAttribute('data-group-by') === k);
    seg('device').click();
    if (seg('device').getAttribute('aria-pressed') !== 'true') throw new Error('「依設備」應標示為選取');
    const groups = () => $('#pane-findings').testAll('.fgroup').filter((g) => g.className.split(' ').includes('by-device'));
    const want = new Map();
    R.sortByDevice(Q, all).forEach((r) => { if (S.view.app.isPending(r.f)) S.util.getOr(want, r.dev, () => []).push(r.idx); });
    const keys = Array.from(want.keys());
    const gs = groups();
    if (gs.length !== want.size) throw new Error(`依設備的分組數應等於設備數：${gs.length} / ${want.size}`);
    gs.forEach((g, n) => {
      const name = keys[n] === null ? '不屬於任何設備' : Q.devName(keys[n]);
      if (g.querySelector('.head .title').textContent !== name) throw new Error('分組應依設備名稱排列：' + g.querySelector('.head .title').textContent);
      const chips = g.querySelector('.head').testAll('.chip');
      if (chips[chips.length - 1].textContent !== String(want.get(keys[n]).length)) throw new Error(`${name} 的筆數不符`);
    });
    if (want.has(null) && !gs[gs.length - 1].className.includes('no-device')) throw new Error('不屬於任何設備的應在最後一組');
    if (!process.env.SMOKE_INPUT && !want.has(null)) throw new Error('範例資料應有不屬於任何設備的檢查結果（例如 A01）');
    // 展開一組：每筆標出規則代碼，且都屬於這台設備
    gs[0].querySelector('.head').click();
    const items = groups()[0].testAll('.fitem');
    if (items.length !== Math.min(100, want.get(keys[0]).length)) throw new Error('展開後應列出這台設備的檢查結果');
    items.forEach((it, n) => {
      const f = all[want.get(keys[0])[n]];
      if (!it.querySelector('.id') || it.querySelector('.id').textContent.trim() !== f.id || !it.textContent.includes(f.message)) throw new Error('依設備分組時每筆應標出規則代碼與訊息');
    });
    groups()[0].querySelector('.head').click();
    // 匯出：可選依設備排序；CSV 的 device 欄依分組順序，Markdown 依設備分組
    // 報表的匯出在資料中心（檢查結果分頁只有入口）；依設備排序的切換也在那裡
    const toggle = () => hubBtn('by-device');
    toggle().click();
    if (toggle().getAttribute('aria-pressed') !== 'true') throw new Error('「依設備排序」應可切換');
    const button = (t) => hubBtn(t === 'CSV' ? 'export-csv' : 'export-markdown');
    const { files } = await captureDownloads(() => { button('CSV').click(); button('Markdown').click(); });
    const rows = parseCsv(files[0].text.replace(/^﻿/, '')).slice(1);
    if (rows.length !== all.length) throw new Error('依設備排序仍應輸出全部檢查結果');
    const order = rows.map((r) => r[9] || null);
    const allKeys = []; R.sortByDevice(Q, all).forEach((r) => { if (!allKeys.includes(r.dev)) allKeys.push(r.dev); });
    if (order.some((d, n) => n && allKeys.indexOf(order[n - 1]) > allKeys.indexOf(d))) throw new Error('CSV 應依設備排序，不屬於任何設備的在最後');
    const md = files[1].text;
    const heads = allKeys.map((d) => md.indexOf(`\n## ${d === null ? '不屬於任何設備' : Q.devName(d)}（`));
    if (heads.some((x) => x < 0) || heads.some((x, n) => n && heads[n - 1] > x)) throw new Error('Markdown 應依設備分組並依序排列');
    // 處理建議只在最後的附錄列一次：每條出現的規則一段，依 CATALOG 的順序，設備分組內不重複
    const appendix = md.indexOf('\n## 附錄：處理建議與常見原因');
    if (appendix < 0 || appendix < Math.max(...heads)) throw new Error('依設備分組的 Markdown 應在最後附上處理建議的附錄');
    const usedIds = Object.keys(S.check.CATALOG).filter((id) => all.some((f) => f.id === id));
    const at = usedIds.map((id) => md.indexOf('\n### ' + id + ' ', appendix));
    if (at.some((x) => x < 0) || at.some((x, n) => n && at[n - 1] > x)) throw new Error('附錄應依 CATALOG 的順序列出每條出現的規則');
    if (usedIds.some((id) => md.split('\n### ' + id + ' ').length !== 2)) throw new Error('每條規則在附錄只列一次');
    if (md.split('\n- 處理建議：').length - 1 !== usedIds.length || md.lastIndexOf('\n- 處理建議：', appendix) >= 0) throw new Error('處理建議只應出現在附錄，每條規則一次');
    toggle().click();
    const { files: f2 } = await captureDownloads(() => button('CSV').click());
    const plain = parseCsv(f2[0].text.replace(/^﻿/, '')).slice(1);
    if (plain.some((r, n) => r[1] !== all[n].id || r[3].replace(/^'/, '') !== all[n].message)) throw new Error('取消依設備排序後應回到基準的順序');
    seg('rule').click();
    if (groups().length || !$('#pane-findings').testAll('.fgroup .head .id').length) throw new Error('切回「依規則」應恢復依規則代碼分組');
  });
  await step('防火牆：點選指向規則或服務的檢查結果，定位到該設備防火牆畫面的那一列', () => {
    const Q = App.Q; const all = App.snap.findings;
    const idxs = all.map((f, i) => i).filter((i) => all[i].entities.some((e) => e.type === 'rule' || e.type === 'service'));
    if (!idxs.length) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有指向防火牆規則或服務的檢查結果'); }
    const types = new Set();
    idxs.forEach((i) => {
      const f = all[i]; const e = f.entities.find((x) => x.type === 'rule' || x.type === 'service'); types.add(e.type);
      App.selectFinding(i);
      if (!App.sel || App.sel.type !== e.type || App.sel.key !== e.key) throw new Error(`${f.id} 應選取它指向的${e.type === 'rule' ? '規則' : '服務'}`);
      const dev = e.type === 'rule' ? Q.getFirewallRule(e.key).dev : S.keys.splitEp(e.key)[0];
      if (!App.graph.sel.nodes.has(dev)) throw new Error(`${f.id} 應在圖上選取規則所在的設備`);
      const row = $('#detail').querySelector('.focus');
      if (!row) throw new Error(`${f.id} 應在詳情標出定位的列`);
      if (!row.textContent.includes(f.id)) throw new Error(`${f.id} 定位的列應標出這筆檢查結果`);
      if (e.type === 'rule' && !row.textContent.includes(Q.getFirewallRule(e.key).action)) throw new Error('定位的列應是那條規則');
      if (e.type === 'service' && !row.textContent.includes(S.keys.splitEp(e.key)[1])) throw new Error('定位的列應是那個服務');
      if (row.testAll('td')[0].style.background !== S.view.theme.firewall.focus.bg) throw new Error('定位列的顏色應取自 theme');
    });
    if (!process.env.SMOKE_INPUT && !(types.has('rule') && types.has('service'))) throw new Error('範例資料應同時有指向規則與服務的檢查結果');
    // 找不到的規則或服務：不報錯，說明原因並標出設備
    const dev = Q.firewallRules()[0].dev;
    App.select({ type: 'rule', key: dev + '|ip|filter|input|nope' });
    if (!text('#detail').includes('基準中沒有這條規則') || !App.graph.sel.nodes.has(dev)) throw new Error('找不到的規則應說明，並標出設備');
    App.select({ type: 'service', key: dev + '|nope' });
    if (!text('#detail').includes('基準中沒有這個服務')) throw new Error('找不到的服務應說明');
    App.select(null);
  });
  await step('防火牆畫面：依位址族 → 表 → chain → position 列出，標出 WAN／LAN 判斷、服務與原文行號', () => {
    const Q = App.Q; const rules = Q.firewallRules();
    if (!rules.length) throw new Error('應有防火牆規則');
    const dev = rules.reduce((best, r) => (Q.firewallRulesOf(r.dev).length > Q.firewallRulesOf(best).length ? r.dev : best), rules[0].dev);
    App.select({ type: 'device', key: dev });
    const link = $('#detail').testAll('a').find((a) => a.textContent === '查看防火牆規則與服務');
    if (!link) throw new Error('設備詳情應有防火牆摘要與入口');
    // WAN 狀態用語：摘要與防火牆畫面共用 V.firewall.zoneStatus()；三種狀態都可區分且標示推論
    const ZS = S.view.firewall.zoneStatus; const zoneNow = Q.firewallZone(dev);
    const known = ['ok', 'no-wan-list', 'empty-wan-list'].map(ZS);
    if (new Set(known.map((z) => z.short)).size !== known.length || new Set(known.map((z) => z.text)).size !== known.length) throw new Error('三種 WAN 狀態的文字應可區分');
    if (known.some((z) => !z.short.includes('（推論）') || !z.tone)) throw new Error('WAN 狀態摘要應標示（推論）並有色調');
    if (Q.devices().some((d) => { const z = Q.firewallZone(d.key); return z && !known.includes(ZS(z.status)); })) throw new Error('基準中的 WAN 狀態都應有對應用語');
    if (zoneNow && !text('#detail').includes(ZS(zoneNow.status).short)) throw new Error('設備詳情的防火牆摘要應顯示 WAN 狀態（與防火牆畫面同一來源）');
    link.click();
    if (zoneNow && !text('#detail').includes(ZS(zoneNow.status).text)) throw new Error('防火牆畫面應顯示 WAN 狀態的完整說明');
    if (App.sel.type !== 'firewall' || App.sel.dev !== dev) throw new Error('入口應開啟該設備的防火牆畫面');
    // chain 依 Q.firewallChains 的順序，每個 chain 一個可展開區塊；展開後列數等於規則數，position 由小到大
    const chains = Q.firewallChains(dev);
    const folds = $('#detail').testAll('details').filter((d) => d.querySelector('.fw-chain'));
    if (folds.map((d) => d.querySelector('summary').firstChild.textContent).join('|') !== chains.map((c) => c.chain).join('|')) throw new Error('chain 的順序應與 Q.firewallChains 一致');
    const heads = $('#detail').testAll('h3').map((x) => x.firstChild.textContent);
    const fams = S.util.uniq(chains.map((c) => c.family + ' ' + c.table));
    const famIdx = fams.map((k) => heads.findIndex((x) => x === k.replace(/^ip /, 'IPv4 ').replace(/^ipv6 /, 'IPv6 ')));
    if (famIdx.some((i) => i < 0) || famIdx.some((x, i) => i && famIdx[i - 1] > x)) throw new Error('位址族與表的分組應依序列出：' + heads.join('|'));
    folds.forEach((d, n) => {
      d.dispatch('toggle');
      const trs = d.testAll('tbody tr'); const c = chains[n];
      if (trs.length !== c.rules) throw new Error(`${c.chain} 的列數應等於規則數`);
      const pos = trs.map((tr) => Number(tr.testAll('td')[0].textContent));
      if (pos.some((x, i) => i && pos[i - 1] > x)) throw new Error(`${c.chain} 應依 position 排列`);
      const rows = Q.firewallRuleRows(dev, { family: c.family, table: c.table, chain: c.chain });
      trs.forEach((tr, i) => {
        const r = rows[i].rule; const act = tr.testAll('td')[1].firstChild;
        const want = S.view.theme.firewall.action[r.action] || S.view.theme.firewall.action.other;
        if (act.style.color !== want) throw new Error('規則動作的顏色應取自 theme');
        if (!tr.textContent.includes(`第 ${r.src[0][1]} 行`)) throw new Error('每列應有原文行號');
      });
      if (c.jumpedFrom.length && !d.textContent.includes('由這些規則 jump 進來')) throw new Error('有規則 jump 進來的 chain 應列出來源規則');
    });
    // 原文行號可開啟
    const a = $('#detail').testAll('.fw-chain a').find((x) => /^第 \d+ 行$/.test(x.textContent));
    $('#dlg-raw').close(); a.click();
    if (!$('#dlg-raw').open || !text('#raw-title').includes(a.textContent.replace(/\D/g, ''))) throw new Error('點原文行號應開啟原文');
    $('#dlg-raw').close();
    // WAN／LAN 判斷與服務
    const zone = Q.firewallZone(dev); const t = text('#detail');
    if (zone && (!t.includes('WAN／LAN 判斷（推論）') || !zone.wanLists.every((x) => t.includes(x)))) throw new Error('應顯示 WAN／LAN 判斷與依據');
    const svc = Q.ipServicesOf(dev);
    if (svc.length && !svc.every((x) => t.includes(x.name))) throw new Error('應列出 /ip service');
    if (svc.some((x) => x.basis === 'default') && !t.includes('預設值')) throw new Error('basis 為 default 的服務應標示「預設值」');
  });
  await step('防火牆修正：指令由 S.remediate 產生（畫面不自己組），F03 等不能產生指令的列出核心的原因', () => {
    const Q = App.Q; const all = App.snap.findings; const RV = S.view.remediation; const RM = S.remediate;
    // 畫面不再自己組指令：舊的組字函式已移除，防火牆畫面的原始碼沒有 RouterOS 指令片段
    ['DISABLE_FIX', 'disableRuleFix', 'quote', 'findingDevice', 'fixTracking', 'ACK_KIND'].forEach((k) => { if (k in RV) throw new Error('V.remediation 不應再有 ' + k); });
    const fwSrc = fs.readFileSync(path.join(ROOT, 'src/view/panels/firewall.js'), 'utf8');
    if (/disabled=yes|find where|print where/.test(fwSrc)) throw new Error('防火牆畫面不應自己組 RouterOS 指令');
    const idxs = all.map((f, i) => i).filter((i) => all[i].entities.some((e) => e.type === 'rule') && RM.levelOf(all[i].id) !== 'manual');
    if (!process.env.SMOKE_INPUT && !['F01', 'F02', 'F03', 'F06'].every((id) => idxs.some((i) => all[i].id === id))) throw new Error('範例資料應有 F01、F02、F03、F06');
    const seen = { item: 0, skipped: 0 };
    idxs.forEach((i) => {
      const f = all[i]; const key = Q.findingKey(f);
      App.selectFinding(i);
      if (!text('#detail').includes('修正（停用規則）')) throw new Error(`${f.id} 的防火牆畫面應有修正區塊`);
      const box = $('#detail').testAll('.fw-fix').find((b) => b.getAttribute('data-finding') === key);
      if (!box) throw new Error(`${f.id} 的修正應對應它的 findingKey`);
      const plan = RM.plan(Q, [key]);
      const it = plan.items.find((x) => x.findingKey === key);
      if (it) {
        seen.item++;
        const cmd = box.querySelector('.fix-cmd').textContent;
        if (cmd !== RV.itemApplyLines(plan, it)) throw new Error(`${f.id} 的指令應與 S.remediate 產生的相同`);
        const apply = RM.renderRsc(plan, it.dev);
        if (!cmd.split('\n').every((l) => apply.split('\n').includes(l))) throw new Error(`${f.id} 的指令應是套用檔的一部分`);
        if (box.getAttribute('data-rule') !== it.target.key) throw new Error('修正應標出規則');
        if (!box.textContent.includes(it.note) || !it.warnings.every((w) => box.textContent.includes(w))) throw new Error('應列出說明與警告');
      } else {
        seen.skipped++;
        const sk = plan.skipped.find((x) => x.findingKey === key);
        if (!box.className.includes('skipped') || !box.textContent.includes(sk.detail)) throw new Error(`${f.id} 沒有產生指令時應列出原因：${sk.detail}`);
        const ref = box.querySelector('.finding-ref');
        if (!ref || ref.getAttribute('title') !== f.message) throw new Error(`${f.id} 沒有產生指令時應列出檢查結果的訊息`);
        if (box.querySelector('.fix-cmd')) throw new Error(`${f.id} 沒有產生指令時不應有指令`);
      }
      if (f.id === 'F03' && (it || box.textContent.includes('disabled=yes'))) throw new Error('F03 在核心是 choice，畫面不可產生停用指令');
    });
    if (!process.env.SMOKE_INPUT && (!seen.item || !seen.skipped)) throw new Error('範例資料應同時有產生指令與未產生指令的修正');
    if (idxs.length) {
      const withCmd = $('#detail').querySelector('.copy-fix');
      if (withCmd) { withCmd.click(); if (!text('#banner').includes('複製')) throw new Error('複製後應有提示：' + text('#banner')); }
      // 設備的防火牆畫面：收合列出這台設備全部的修正與筆數（items＋skipped）
      const dev = Q.getFirewallRule(all[idxs[0]].entities.find((e) => e.type === 'rule').key).dev;
      App.select({ type: 'firewall', dev, key: dev });
      const keys = S.util.uniq(Q.findingsFor('device', dev).filter((f) => f.entities.some((e) => e.type === 'rule') && RM.levelOf(f.id) !== 'manual').map((f) => Q.findingKey(f)));
      const plan = RM.plan(Q, keys);
      const fold = $('#detail').testAll('details').find((d) => d.querySelector('summary').textContent.startsWith('修正'));
      if (!fold || fold.querySelector('summary .chip').textContent !== String(plan.items.length + plan.skipped.length)) throw new Error('設備的防火牆畫面應收合列出全部修正與筆數');
      // 在修正計畫中開啟：選取就是這些 findingKey
      fold.querySelector('.open-patch').click();
      if (!S.view.patchView.isOpen(App) || Array.from(S.view.patchView.state.keys).sort().join() !== keys.slice().sort().join()) throw new Error('「在修正計畫中開啟」應以這些檢查結果在中間開啟修正計畫');
      if (document.activeElement !== $('#patch-title')) throw new Error('從防火牆畫面開啟修正計畫時，焦點應移到修正計畫的標題');
      App.showView('graph');
    }
    App.select(null);
  });
  await step('覆蓋率：由 C01 匯出 tools/collect.sh 的 devices.csv 草稿（格式與 collect.sh 的讀法一致）', async () => {
    const Q = App.Q; const all = App.snap.findings; const R = S.view.remediation;
    // 依 tools/collect.sh 的 load_inventory：略過空白與 # 開頭的列，第一個資料列是標題列，其餘逐欄檢查
    const collectInventory = (t) => {
      const rows = []; let header = false;
      t.split('\n').forEach((line, n) => {
        const [name = '', address = '', user = '', port = ''] = line.split(',').map((s) => s.trim());
        if (!name || name.startsWith('#')) return;
        if (!header) { if (name !== 'name' || address !== 'address' || user !== 'user') throw new Error(`第 ${n + 1} 行：第一個資料列必須是標題列`); header = true; return; }
        if (!address || !user) throw new Error(`第 ${n + 1} 行：name、address、user 不可為空`);
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(name)) throw new Error(`第 ${n + 1} 行：設備名稱無效`);
        if (/[\s,]/.test(address) || /[\s,]/.test(user)) throw new Error(`第 ${n + 1} 行：address 或 user 無效`);
        const p = port || '22'; if (!/^\d+$/.test(p) || +p < 1 || +p > 65535) throw new Error(`第 ${n + 1} 行：port 無效`);
        if (rows.some((r) => r.name === name)) throw new Error(`第 ${n + 1} 行：設備名稱重複`);
        rows.push({ name, address, user, port: p });
      });
      if (!header) throw new Error('缺少標題列');
      return rows;
    };
    goStep('input'); // 覆蓋率與 devices.csv 草稿在「① 輸入」（資料中心）
    const btn = hubBtn('devices-csv');
    S.view.app.closeHub();
    const devs = S.util.uniq(all.filter((f) => f.id === 'C01').map((f) => f.entities.find((e) => e.type === 'device').key)).map((k) => Q.getDevice(k));
    if (!btn || !/devices\.csv 草稿/.test(btn.textContent)) throw new Error('① 輸入的覆蓋率應有匯出 devices.csv 草稿的按鈕');
    if ((btn.getAttribute('disabled') !== null) !== !devs.length) throw new Error('沒有 C01 時按鈕應停用');
    if (!devs.length) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有 C01'); }
    const { files } = await captureDownloads(() => btn.click());
    if (files.length !== 1 || !/^devices-draft-.*\.csv$/.test(files[0].name)) throw new Error('應下載 devices.csv 草稿：' + files.map((f) => f.name));
    if (files[0].bytes.subarray(0, 3).toString('hex') === 'efbbbf' || files[0].text.includes('\r')) throw new Error('草稿不可有 BOM 或 CR：collect.sh 以 bash read 逐行讀取');
    const t = files[0].text; const rows = collectInventory(t);
    devs.forEach((d) => {
      const heard = Q.ipAddresses().filter((a) => a.dev === d.key && a.hearsay).map((a) => a.ip);
      const row = rows.find((r) => r.name === d.name);
      if (row && row.address !== (d.mgmtIp || heard[0])) throw new Error(`${d.name} 的 address 應取管理 IP 或鄰居回報的位址`);
      if (!row && !t.split('\n').some((l) => l.startsWith('# ' + d.name + '：'))) throw new Error(`${d.name} 沒有列出，也沒有註解說明原因`);
    });
    if (rows.length !== devs.length && !process.env.SMOKE_INPUT) throw new Error('範例資料的 C01 設備都應有位址可列出');
    if (rows.some((r) => r.user !== R.USER_PLACEHOLDER) || !t.includes(`user 欄是佔位值 ${R.USER_PLACEHOLDER}`)) throw new Error('user 不可猜，應是明顯的佔位值並加註解');
    // 沒有位址、名稱不符合 collect.sh 規則的設備寫成註解列，草稿仍能被 collect.sh 讀取
    if (devs.length >= 2) {
      const clone = JSON.parse(JSON.stringify(App.snap));
      const d1 = clone.model.devices.find((d) => d.key === devs[0].key); const d2 = clone.model.devices.find((d) => d.key === devs[1].key);
      d1.mgmtIp = null; clone.model.ipAddresses = clone.model.ipAddresses.filter((a) => a.dev !== d1.key); d2.name = 'BAD NAME';
      const dr = R.devicesCsvDraft(S.query(clone)); const r2 = collectInventory(dr.text);
      if (r2.some((r) => r.name === d1.name) || !dr.text.includes(`# ${d1.name}：沒有管理 IP`)) throw new Error('沒有位址的設備應寫成註解列並說明');
      if (r2.some((r) => r.name === 'BAD NAME') || !dr.text.includes('# BAD NAME：名稱不符合')) throw new Error('名稱不符合 collect.sh 規則的設備應寫成註解列並說明');
      if (r2.length !== rows.length - 2) throw new Error('其他設備應照常列出');
    }
  });
  await step('樣式單一來源：CSS 設備類型變數與 theme 一致，圖例取自 theme', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8'); const T = S.view.theme;
    [
      ['共用控制項高度', /--control-h:\s*34px/],
      ['鍵盤焦點樣式', /button:focus-visible/],
      ['清除操作風險提示', /#btn-clear:hover/],
      ['表格交錯列', /table\.t tbody tr:nth-child\(even\) td/],
      ['表格互動高亮', /table\.t tbody tr\.click:hover td/],
      ['檢查結果卡片樣式', /\.finding\s*\{[^}]*border:/],
      ['狀態標籤層次', /\.chip\.err\s*\{[^}]*border-color:/],
      ['減少動態效果偏好', /prefers-reduced-motion:\s*reduce/],
      ['資料標籤間距與換行', /\.chip-list\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*gap:\s*4px/],
      ['首頁 Grid 明確指定主內容列', /#main\s*\{\s*grid-row:\s*4;/],
    ].forEach(([label, pattern]) => { if (!pattern.test(css)) throw new Error('缺少 ' + label); });
    const vars = { firewall: 'fw', switch: 'sw', router: 'rt', host: 'host', unknown: 'unk' };
    Object.entries(vars).forEach(([k, v]) => {
      const m = css.match(new RegExp('--' + v + ':\\s*(#[0-9a-fA-F]{6})'));
      if (!m || m[1].toLowerCase() !== T.kind[k].toLowerCase()) throw new Error('--' + v + ' 與 theme.kind.' + k + ' 不一致');
    });
    ['error', 'warn'].forEach((k) => {
      const m = css.match(new RegExp('--sev-' + k + ':\\s*(#[0-9a-fA-F]{6})'));
      if (!m || m[1].toLowerCase() !== T.sev[k].toLowerCase()) throw new Error('--sev-' + k + ' 與 theme.sev.' + k + ' 不一致');
    });
    // 樣式一致性：畫面用到的 class 都要有定義；字重只用 400／600／700（中文字型沒有 550／650）
    ['pane-filter', 'pane-body', 'pane-section', 'pane-note', 'note-box', 'table-more', 'row'].forEach((c) => {
      if (!new RegExp('\\.' + c + '\\b[^{]*\\{').test(css)) throw new Error('缺少 .' + c + ' 樣式');
    });
    if (/font-weight:\s*(550|650)/.test(css)) throw new Error('字重只用 400／600／700');
    const legend = Array.from(document.testAll('#legend .li'));
    if (document.testAll('#legend .lg-group').length !== 5) throw new Error('圖例應分為五類');
    const groupTitles = document.testAll('#legend .lg-title').map((el) => el.textContent);
    if (groupTitles.join('|') !== '設備|終端|連線|連線註記|標示') throw new Error('圖例分類順序應為設備、終端、連線、連線註記、標示');
    if (!document.querySelector('#legend .legend-body').classList.contains('hidden')) throw new Error('圖例預設應收合');
    document.querySelector('#legend .legend-head').click();
    if (document.querySelector('#legend .legend-body').classList.contains('hidden')) throw new Error('點圖例標題應展開');
    document.querySelector('#legend .legend-head').click();
    if (legend.length < Object.keys(T.edge).length + Object.keys(S.view.KIND).length) throw new Error('圖例缺項');
    const sw = (li) => li.childNodes.filter((c) => c.style && c.attrs.class);
    const kinds = Object.keys(S.view.KIND);
    kinds.forEach((k, i) => { const d = sw(legend[i])[0]; if (d.style.background !== T.kind[k]) throw new Error('圖例設備色與 theme 不一致：' + k); });
    Object.entries(T.edge).forEach(([k, st]) => {
      const row = legend.find((li) => li.textContent === S.view.CLS[k]); const l = row && sw(row)[0];
      if (!l) throw new Error('圖例缺少連線類別：' + k);
      if (!l.style.background.includes(st.c) || l.style.height !== S.view.legendLineHeight(st.w)) throw new Error('圖例連線色或線寬與 theme 不一致：' + k);
      if (!!st.dash !== l.style.background.includes('repeating-linear-gradient')) throw new Error('圖例連線虛線與 theme 不一致：' + k);
    });
    const edgeLegend = (k) => legend.find((li) => li.textContent === S.view.CLS[k]);
    const oneG = edgeLegend('1g'); const other = edgeLegend('other');
    if (!oneG || !other || !oneG.getAttribute('title').includes('不代表實際協商速率')) throw new Error('1G 圖例需說明其為介面名稱推估，而非實際協商速率');
    if (T.edge['1g'].c === T.edge.other.c || T.edge['1g'].w <= T.edge.other.w) throw new Error('1G 連線樣式應明顯區別於其他連線');
    // 線寬隨速率遞增（畫布與圖例都是）；多條鏈路的雙線另有圖例
    const speeds = ['1g', '10g', '40g'];
    speeds.slice(1).forEach((k, i) => {
      if (T.edge[k].w <= T.edge[speeds[i]].w) throw new Error(`${k} 線寬應大於 ${speeds[i]}`);
      if (parseFloat(S.view.legendLineHeight(T.edge[k].w)) <= parseFloat(S.view.legendLineHeight(T.edge[speeds[i]].w))) throw new Error(`圖例的 ${k} 應比 ${speeds[i]} 粗`);
    });
    if (!legend.some((li) => li.textContent.includes('多條鏈路') && li.querySelector('.ln') && li.querySelector('.ln').getAttribute('data-multi') !== null)) throw new Error('圖例應說明多條鏈路的雙線');
    // 標示：選取、滑過、搜尋結果、路由追蹤的圖例顏色取自 theme.mark
    ['select', 'hover', 'find', 'trace'].forEach((k) => {
      const swatch = legend.flatMap((li) => li.childNodes).find((c) => c.attrs && c.attrs['data-mark'] === k);
      if (!swatch) throw new Error('圖例缺少標示：' + k);
      const st = swatch.style; if (!String(st.border || st.background).includes(T.mark[k])) throw new Error('圖例標示色與 theme 不一致：' + k);
    });
    let keyboardLinkActivated = false;
    const keyboardLink = S.view.h('a', { class: 'link', onclick: () => { keyboardLinkActivated = true; } }, '鍵盤連結');
    if (keyboardLink.getAttribute('tabindex') !== '0' || keyboardLink.getAttribute('role') !== 'link') throw new Error('動態連結需具備鍵盤焦點與連結語意');
    keyboardLink.dispatch('keydown', { key: 'Enter' });
    if (!keyboardLinkActivated) throw new Error('動態連結按 Enter 應觸發操作');
    const hearsay = legend.find((li) => li.textContent === '單側觀察'); const inferred = legend.find((li) => li.textContent === '推論鏈路');
    if (!hearsay || !inferred) throw new Error('圖例缺少單側觀察或推論鏈路註記');
    if (legend.some((li) => li.textContent === 'MNDP')) throw new Error('MNDP 不畫在圖上，圖例不應列出');
    const hs = sw(hearsay)[0]; const is = sw(inferred)[0];
    // 證據強度只改線型與透明度（畫布保留速率色），圖例用中性線色只表達線型
    const dashOf = (d) => d.reduce((acc, n) => { acc.pos += n; acc.out.push(acc.pos + 'px'); return acc; }, { pos: 0, out: [] }).out;
    [[hs, T.weakEdge.hearsay], [is, T.weakEdge.inferred]].forEach(([el, st]) => {
      if (el.style.opacity !== String(st.alpha) || !el.style.background.includes(T.canvas.keyInk) || !dashOf(st.dash).every((x) => el.style.background.includes(x))) throw new Error('證據強度圖例的線型或透明度與 theme 不一致');
    });
    if (hs.style.background === is.style.background) throw new Error('單側觀察與推論鏈路圖例線型應可區分');
  });
  await step('收集時間與失敗：原始輸出列出收集時間與失敗，覆蓋率把失敗算進「有缺漏」並顯示原因', async () => {
    await buildInput(fs.readFileSync(path.join(ROOT, 'tests/fixtures/collector/collected-at-and-failures.txt'), 'utf8'));
    const blocks = App.snap.blocks;
    if (!blocks.some((b) => b.collectedAt) || !blocks.some((b) => b.failure)) throw new Error('測試資料應有收集時間與失敗');
    const devs = S.util.uniq(blocks.filter((b) => b.devKey && (b.collectedAt || b.failure)).map((b) => b.devKey));
    devs.forEach((dk) => {
      App.select({ type: 'device', key: dk });
      const fold = $('#detail').testAll('details').find((d) => d.querySelector('summary').textContent.startsWith('收集到的原始輸出'));
      if (!fold) throw new Error(dk + ' 應有原始輸出區塊');
      const t = fold.textContent;
      blocks.filter((b) => b.devKey === dk).forEach((b) => {
        if (b.collectedAt && !t.includes(S.view.fmtUtc(b.collectedAt))) throw new Error(`${dk} 的原始輸出應列出收集時間 ${b.collectedAt}`);
        if (b.failure && !t.includes(S.view.failureText(b.failure))) throw new Error(`${dk} 的原始輸出應列出失敗原因`);
      });
    });
    // 只有失敗、沒有缺少的設備也算「有缺漏」：以基準的副本把缺少清空、保留失敗來驗證畫面的判斷
    const clone = JSON.parse(JSON.stringify(App.snap));
    const row = clone.coverage.find((r) => r.collected && r.failures.length);
    row.missing = [];
    S.view.app.load(clone, null);
    const gaps = clone.coverage.filter((r) => r.collected && (r.missing.length || r.failures.length));
    goStep('input');
    if (!text('#pane-coverage').includes('有缺漏 ' + gaps.length)) throw new Error('有缺漏應包含只有收集失敗的設備');
    const b = $('#baseline-summary').testAll('button').find((x) => x.textContent === '查看收集缺漏');
    if (b.getAttribute('disabled') !== null) throw new Error('只有收集失敗時，收集缺漏入口也應可用');
    if (!text('#baseline-summary').includes(`${gaps.length} 台有必要資料缺漏`)) throw new Error('基準摘要的缺漏數應包含收集失敗');
    b.click();
    const tr = $('#pane-coverage').testAll('tbody tr');
    if (tr.length !== gaps.length) throw new Error('缺漏篩選列數應等於有缺漏的設備數');
    const t = text('#pane-coverage');
    gaps.forEach((r) => r.failures.forEach((x) => {
      if (!t.includes(S.view.failureText(x)) || !t.includes(x.command || '整台設備')) throw new Error('覆蓋率應顯示失敗原因與指令');
    }));
    if (document.activeElement !== $('#hub-sec-coverage')) throw new Error('「查看收集缺漏」應在資料中心聚焦覆蓋率');
    S.view.app.closeHub();
  });
  await step('防火牆畫面：停用規則、無法解碼的註解、jump 來源與預設值服務', async () => {
    await buildInput(fs.readFileSync(path.join(ROOT, 'tests/fixtures/firewall/edge-router.txt'), 'utf8'));
    const Q = App.Q; const dev = Q.firewallRules()[0].dev;
    const disabled = Q.firewallRules().find((r) => r.disabled);
    if (!disabled) throw new Error('測試資料應有停用的規則');
    App.select({ type: 'rule', key: disabled.key });
    const row = $('#detail').querySelector('.focus');
    if (!row || !row.className.includes('disabled') || !row.textContent.includes('停用')) throw new Error('停用的規則應標示');
    if (row.testAll('td')[0].style.opacity !== String(S.view.theme.firewall.disabledAlpha)) throw new Error('停用規則的透明度應取自 theme');
    const jumped = Q.firewallChains(dev).find((c) => c.jumpedFrom.length);
    if (jumped) {
      App.select({ type: 'firewall', dev });
      const d = $('#detail').testAll('details').find((x) => x.querySelector('summary').firstChild.textContent === jumped.chain);
      d.dispatch('toggle');
      const a = d.testAll('a').find((x) => x.textContent.startsWith(Q.getFirewallRule(jumped.jumpedFrom[0]).chain + ' #'));
      if (!a) throw new Error('jump 來源應可點選');
      a.click(); if (App.sel.type !== 'rule' || App.sel.key !== jumped.jumpedFrom[0]) throw new Error('點 jump 來源應定位到那條規則');
    }
    App.select({ type: 'firewall', dev });
    const defaults = Q.ipServicesOf(dev).filter((s) => s.basis === 'default');
    const svcRows = $('#detail').testAll('tbody tr').filter((tr) => Q.ipServicesOf(dev).some((s) => tr.testAll('td')[0].textContent === s.name));
    if (svcRows.filter((tr) => tr.textContent.includes('預設值')).length !== defaults.length) throw new Error('只有 basis 為 default 的服務標示「預設值」');
    // 無法解碼的註解：以基準副本標記一條規則
    const clone = JSON.parse(JSON.stringify(App.snap));
    const r = clone.model.firewallRules.find((x) => x.comment); r.commentEncoding = 'undecodable';
    S.view.app.load(clone, null);
    App.select({ type: 'rule', key: r.key });
    if (!$('#detail').querySelector('.focus').textContent.includes('註解無法解碼')) throw new Error('commentEncoding 為 undecodable 時應標示');
  });
  await step('新舊基準比對：依類別分組、摘要在上、新暴露醒目，schema 不同時顯示原因，可匯出預期資料', async () => {
    const full = fs.readFileSync(path.join(ROOT, 'tests/fixtures/firewall/edge-router.txt'), 'utf8');
    // 舊基準少了幾條放行規則：新基準多出的 WAN 可連入規則應標成新暴露
    const oldInput = full.split('\n').filter((l) => !/dst-port=8291/.test(l) || /in-interface-list/.test(l)).join('\n');
    await buildInput(oldInput);
    const oldJson = S.view.exporter.snapshotJson(App.snap);
    await buildInput(full);
    const expect = S.compare.snapshots(S.query(JSON.parse(oldJson)), App.Q);
    if (!expect.items.some((i) => i.effect === 'new-exposure')) throw new Error('測試資料應產生新暴露');
    App.showView('compare');
    const load = async (name, body) => {
      const inp = $('#compare-body').querySelector('.baseline-diff').querySelector('input');
      inp.files = [{ name, text: async () => body }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
    };
    const keysBefore = JSON.stringify(await S.store.get('last'));
    await load('old.json', oldJson);
    const pane = () => $('#compare-body').querySelector('.baseline-diff');
    // 資料中心的「上一輪的基準」：新舊基準比對的摘要（同一份比對結果）；新暴露的筆數在驗證畫面的摘要
    const sumText = $('#hub').testAll('.hub-row').find((r) => r.getAttribute('data-item') === 'previous').textContent;
    if (!sumText.includes('old.json') || !sumText.includes(`新增 ${S.view.num(expect.summary.added)}`)) throw new Error('資料中心應列出新舊基準比對的筆數：' + sumText);
    const t = pane().textContent;
    if (!t.includes(`新暴露 ${S.view.num(expect.items.filter((i) => i.effect === 'new-exposure').length)}`)) throw new Error('驗證畫面的比對摘要應列出新暴露的筆數');
    Object.entries({ added: '新增', removed: '移除', changed: '變更' }).forEach(([k, label]) => {
      if (!t.includes(`${label} ${expect.summary[k]}`)) throw new Error('摘要應列出' + label + '筆數');
    });
    const cats = pane().testAll('.diff-cat').map((x) => x.getAttribute('data-category'));
    const wantCats = ['device', 'link', 'vlan', 'ip', 'firewall', 'finding'].filter((c) => expect.items.some((i) => i.category === c));
    if (cats.join() !== wantCats.join()) throw new Error('應依類別分組並依序列出：' + cats);
    const kids = pane().childNodes;
    if (kids.indexOf(pane().querySelector('.diff-summary')) > kids.indexOf(pane().querySelector('.diff-cat'))) throw new Error('摘要應在分組上方');
    expect.items.forEach((i) => { if (!t.includes(i.message)) throw new Error('缺少差異：' + i.message); });
    const exposureRows = pane().testAll('tbody tr').filter((tr) => tr.className.includes('exposure'));
    if (exposureRows.length !== expect.items.filter((i) => i.effect === 'new-exposure').length) throw new Error('每個新暴露都應醒目標示');
    if (!exposureRows.every((tr) => tr.testAll('td')[0].style.background === S.view.theme.diff.exposureBg && tr.textContent.includes('新暴露'))) throw new Error('新暴露的顏色應取自 theme');
    exposureRows[0].click();
    if (App.sel.type !== 'rule' || !App.Q.getFirewallRule(App.sel.key)) throw new Error('點新暴露的規則應定位到防火牆規則');
    if (App.centerView !== 'verify' || !$('#detail').querySelector('.focus')) throw new Error('點比對的一列時，比對留在中間、右側顯示那條規則');
    const filterBtn = pane().testAll('button').find((b) => b.textContent.startsWith('新暴露'));
    filterBtn.click();
    if (pane().testAll('tbody tr').some((tr) => !tr.className.includes('exposure'))) throw new Error('新暴露篩選應只列新暴露');
    if (JSON.stringify(await S.store.get('last')) !== keysBefore) throw new Error('比對結果不應存進 store');
    // schema 不同：顯示核心回報的原因，不比對
    const old1 = JSON.parse(oldJson); old1.meta.schema = 'ssot-snapshot/1'; old1.model = {};
    await load('old-v1.json', JSON.stringify(old1));
    if (!pane().textContent.includes('schema') || pane().testAll('.diff-cat').length) throw new Error('schema 不同時應顯示原因、不比對');
    await load('bad.json', '{not json');
    if (!pane().textContent.includes('無法讀取')) throw new Error('JSON 錯誤時應說明');
    // 匯出預期資料：ssot-expected/1，和同一份基準比對全部一致
    const { files } = await captureDownloads(() => {
      hubBtn('export-expected').click(); // 由基準產生預期資料是這一輪的輸出，入口在資料中心
    });
    if (files.length !== 1 || !/^expected-.*\.json$/.test(files[0].name)) throw new Error('應下載預期資料 JSON：' + files.map((f) => f.name));
    const exp = JSON.parse(files[0].text);
    if (exp.schema !== 'ssot-expected/1') throw new Error('預期資料的 schema 應為 ssot-expected/1');
    require('assert').deepStrictEqual(exp, S.compare.expectedFrom(App.Q));
    App.showView('compare');
    const inp = $('#compare-body').querySelector('input');
    inp.files = [{ name: files[0].name, text: async () => files[0].text }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
    if (!text('#compare-body').includes('有差異 0')) throw new Error('匯出的預期資料和同一份基準比對應全部一致');
    App.showView('graph');
  });
  await step('只看新出現的：依舊基準篩選；版本不同時比對結果與篩選都提示「新出現的可能來自新版檢查」，版本相同時沒有提示', async () => {
    const Q = App.Q; const all = App.snap.findings; const key = Q.findingKey;
    const loadOld = async (name, body) => {
      App.showView('compare');
      const inp = $('#compare-body').querySelector('.baseline-diff').querySelector('input');
      inp.files = [{ name, text: async () => body }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
      goStep('triage');
    };
    const onlyNew = () => $('#pane-findings').testAll('.chip').find((c) => c.textContent.startsWith('只看新出現的'));
    const versionHint = () => $('#pane-findings').querySelector('.only-new-version');
    const diffWarnings = () => $('#compare-body').testAll('.diff-warning');
    // 沒有可用的舊基準（上一步最後載入的是壞掉的 JSON）：停用並說明原因
    goStep('triage');
    if (!onlyNew() || onlyNew().getAttribute('aria-disabled') !== 'true') throw new Error('沒有舊基準時「只看新出現的」應停用');
    if (!text('#pane-findings').includes('載入舊基準後')) throw new Error('停用時應說明原因');
    const count = new Map(); all.forEach((f) => count.set(key(f), (count.get(key(f)) || 0) + 1));
    const addedF = all.find((f) => count.get(key(f)) === 1);
    const old = JSON.parse(JSON.stringify(App.snap));
    old.findings = old.findings.filter((f) => key(f) !== key(addedF));
    // 版本相同：沒有提示
    await loadOld('old-same.json', JSON.stringify(old));
    if (versionHint() || diffWarnings().length) throw new Error('版本與命名規則都相同時不應有提示');
    // 只看新出現的：依 S.compare.snapshots 的 finding added
    const added = new Set(S.compare.snapshots(S.query(old), Q).items.filter((i) => i.category === 'finding' && i.change === 'added').map((i) => i.key));
    if (!added.has(key(addedF))) throw new Error('測試資料：舊基準拿掉的檢查結果應是新出現的');
    const nNew = all.filter((f) => added.has(key(f))).length;
    if (!onlyNew().textContent.includes(String(nNew))) throw new Error('「只看新出現的」應顯示新出現的筆數');
    if (!text('#pane-findings').includes('新出現')) throw new Error('未篩選時新出現的項目應標示');
    onlyNew().click();
    if (onlyNew().getAttribute('aria-pressed') !== 'true') throw new Error('「只看新出現的」應可切換');
    for (let n = 0; n < 200; n++) {
      const head = $('#pane-findings').testAll('.fgroup').filter((g) => !/\b(handled|rules)\b/.test(g.className)).map((g) => g.querySelector('.head')).find((x) => x.getAttribute('aria-expanded') === 'false');
      if (!head) break; head.click();
    }
    const shown = $('#pane-findings').testAll('.fgroup').filter((g) => !/\b(handled|rules)\b/.test(g.className)).flatMap((g) => g.testAll('.fitem'));
    if (!shown.length || !shown.some((it) => it.textContent.includes(addedF.message))) throw new Error('篩選後應列出新出現的那一筆');
    // 版本不同：比對結果上方與篩選旁都提示
    old.meta.version = '0.0.1';
    await loadOld('old-version.json', JSON.stringify(old));
    const warn = S.compare.snapshots(S.query(old), Q).warnings.find((w) => w.kind === 'version');
    if (!warn) throw new Error('測試資料：版本不同時核心應有 version 的提醒');
    App.showView('compare');
    const dw = diffWarnings().find((d) => d.getAttribute('data-kind') === 'version');
    if (!dw || !dw.textContent.includes(warn.message)) throw new Error('比對結果上方應顯示版本不同的提醒');
    const kids = $('#compare-body').querySelector('.baseline-diff').childNodes;
    if (kids.indexOf($('#compare-body').querySelector('.diff-warnings')) > kids.indexOf($('#compare-body').querySelector('.diff-summary'))) throw new Error('提醒應在比對結果上方');
    goStep('triage');
    if (!versionHint() || !versionHint().textContent.includes('新出現的可能來自新版檢查')) throw new Error('只看新出現的應提示新出現的可能來自新版檢查');
    // 舊基準變成不可用：篩選自動關閉並停用，提示一併消失
    await loadOld('bad.json', '{not json');
    if (onlyNew().getAttribute('aria-disabled') !== 'true' || versionHint()) throw new Error('舊基準不可用時篩選應關閉並停用');
    App.showView('graph');
  });
  await step('處理紀錄多輪推進：修好判定已修好、又出現標為回歸並醒目提示，收集不到的設備列為無法判斷，趨勢圖與表格', async () => {
    const VA = S.view.app; const sample = S.samples['sample-bundle.txt'];
    // 範例的 F06（TPE_CORE_RT_02 以來源埠放行）：拿掉那一行就會消失
    const F06_LINE = '/ip firewall filter add action=accept chain=input protocol=udp src-port=53';
    if (!sample.includes(F06_LINE + '\n')) throw new Error('測試資料：範例應有 F06 的那一行');
    await buildInput(sample + '\n# round-1\n'); await App.ledgerJob;
    const f06 = App.snap.findings.find((f) => f.id === 'F06'); const key = App.Q.findingKey(f06);
    await App.setLedger(f06, { status: 'scheduled', note: '下次維護' });
    if (VA.ledger().items[key].status !== 'scheduled') throw new Error('應可標為已排程修復');
    // 第二輪：修好了
    await buildInput(sample.replace(F06_LINE + '\n', '') + '\n# round-2\n'); await App.ledgerJob;
    if (VA.ledger().items[key].status !== 'fixed') throw new Error('已排程修復的項目消失時應判定為已修好');
    goStep('verify'); // 本輪變化與修復追蹤在「⑤ 驗證」的中間
    const fixedList = $('#round-body').testAll('.ledger-list').find((l) => l.getAttribute('data-reason') === 'disappeared');
    if (!fixedList || !fixedList.testAll('.ledger-item').some((x) => x.getAttribute('data-key') === key)) throw new Error('本輪變化應列出已修好的項目');
    const fixedTrack = $('#tracking-body').testAll('.ledger-list').find((l) => l.getAttribute('data-status') === 'fixed');
    if (!fixedTrack || !fixedTrack.testAll('.ledger-item').some((x) => x.getAttribute('data-key') === key)) throw new Error('修復追蹤應列出累計已修好的項目');
    // 第三輪：又出現 → 回歸
    await buildInput(sample + '\n# round-3\n'); await App.ledgerJob;
    if (VA.ledger().items[key].status !== 'regressed') throw new Error('已修好又出現時應標為回歸');
    const nReg = Object.values(VA.ledger().items).filter((it) => it.status === 'regressed' && App.snap.findings.some((f) => App.Q.findingKey(f) === key)).length;
    const alert = $('#baseline-summary').testAll('button').find((b) => b.getAttribute('data-alert') === 'regressed');
    if (!alert || !alert.textContent.includes(`回歸 ${nReg} 項`) || !alert.className.includes('err')) throw new Error('基準摘要應醒目提示回歸筆數：' + text('#baseline-summary'));
    goStep('triage');
    alert.click();
    if (App.step !== 'verify' || $('#view-verify').classList.contains('hidden') || document.activeElement !== $('#round-title')) throw new Error('點回歸提示應到「⑤ 驗證」並聚焦本輪變化');
    if (!stepBtn('verify').textContent.includes(`回歸 ${nReg}`)) throw new Error('⑤ 的狀態應寫出回歸筆數：' + stepBtn('verify').textContent);
    const reList = $('#round-body').testAll('.ledger-list').find((l) => l.getAttribute('data-reason') === 'reappeared');
    if (!reList || !reList.textContent.includes(f06.message)) throw new Error('本輪變化應列出回歸的項目');
    reList.querySelector('.ledger-item').click();
    if (!App.sel || App.step !== 'verify') throw new Error('點回歸的項目應定位到那筆檢查結果（詳情在右側，留在驗證）');
    // 回歸的項目在檢查結果也有標示
    goStep('triage');
    const g06 = document.testAll('#pane-findings .fgroup').find((x) => { const el = x.querySelector('.head .id'); return el && el.textContent === 'F06'; });
    if (g06.querySelector('.head').getAttribute('aria-expanded') === 'false') g06.querySelector('.head').click();
    if (!$('#pane-findings').testAll('.ledger-chip').some((c) => c.getAttribute('data-status') === 'regressed')) throw new Error('檢查結果應標示回歸');
    // 同一份基準再開一次：skipped，不顯示變化
    const iters = VA.ledger().iterations.length;
    A_load: { S.view.app.load(App.snap, null); await App.ledgerJob; }
    if (VA.ledger().iterations.length !== iters || VA.ledgerState().round) throw new Error('同一份基準重新載入時不應推進，也不顯示變化');
    // 第四輪：只收集第一台設備，其他設備的待處理項目無法判斷
    const first = sample.split(/\n_{5,}\n/)[0];
    await buildInput(first + '\n# round-4\n'); await App.ledgerJob;
    const st = VA.ledgerState();
    if (!st.round || !st.round.unobserved.length) throw new Error('沒有收集的設備，消失的待處理項目應列為無法判斷');
    if (st.round.unobserved.some((k) => VA.ledger().items[k].status === 'fixed')) throw new Error('無法判斷的項目不可判定為已修好');
    const un = $('#baseline-summary').testAll('button').find((b) => b.getAttribute('data-alert') === 'unobserved');
    if (!un || !un.textContent.includes(`無法判斷 ${st.round.unobserved.length} 項`)) throw new Error('基準摘要應提示無法判斷的筆數');
    goStep('verify');
    const unList = $('#round-body').testAll('.ledger-list').find((l) => l.getAttribute('data-reason') === 'unobserved');
    if (!unList || !unList.parentNode.textContent.includes('因收集失敗而無法判斷') || unList.testAll('.ledger-item').length !== Math.min(300, st.round.unobserved.length)) throw new Error('本輪變化應說明因收集失敗而無法判斷');
    // 趨勢：和本輪變化、修復追蹤、比對一起在「⑤ 驗證」；步驟的狀態是處理紀錄的第幾輪
    const series = S.ledger.summary(VA.ledger()).series;
    if (!stepBtn('verify').textContent.includes(`第 ${VA.ledgerRoundIndex() + 1} 輪`)) throw new Error('⑤ 的狀態應寫出目前是第幾輪：' + stepBtn('verify').textContent);
    App.showView('trend', { focus: true });
    if (App.centerView !== 'verify' || $('#view-verify').classList.contains('hidden') || document.activeElement !== $('#trend-title')) throw new Error('收斂趨勢的入口應開啟驗證並聚焦收斂趨勢的標題');
    if (!$('#view-verify').contains($('#trend-body')) || !$('#view-verify').contains($('#round-body')) || !$('#view-verify').contains($('#tracking-body'))) throw new Error('收斂趨勢、本輪變化、修復追蹤都在驗證畫面');
    // 多輪時畫三張圖（一張一個軸），顏色與線寬取自 theme，hover 顯示該輪全部數值，表格列出每一輪
    const charts = $('#trend-body').testAll('.trend-chart');
    if (charts.length !== 3) throw new Error('應有三張小倍數折線圖：' + charts.length);
    const T = S.view.theme.trend;
    const lines = charts[0].testAll('path').filter((p) => p.className.includes('trend-line'));
    if (lines.map((p) => p.getAttribute('stroke')).join() !== [T.pending, T.regressed, T.accepted].join()) throw new Error('計數圖的三條線應用 theme.trend 的顏色');
    if (charts.some((c) => c.testAll('path').filter((p) => p.className.includes('trend-line')).some((p) => p.getAttribute('stroke-width') !== String(T.lineWidth)))) throw new Error('折線應是 theme.trend.lineWidth 的細線');
    if (charts[0].testAll('.trend-legend-item').length !== 3 || charts[1].querySelector('.trend-legend')) throw new Error('多條線的圖要有圖例，單一條線的不需要');
    // 不只靠顏色：圖例的樣本畫出和線上相同的外形；線尾寫出名稱與數值，數值相同的線不會疊在一起
    charts[0].testAll('.trend-legend-item').forEach((it) => {
      const k = it.getAttribute('data-series'); const sw = it.querySelector('.trend-swatch');
      if (!sw || !sw.all().some((x) => x.getAttribute('data-shape') === T.marker[k])) throw new Error('圖例的樣本應畫出 ' + k + ' 的外形');
    });
    const ends = charts[0].testAll('text').filter((t) => t.className.includes('trend-end'));
    if (ends.length !== 3 || !ends.every((e) => e.textContent.startsWith({ pending: '待處理', regressed: '回歸', accepted: '已豁免' }[e.getAttribute('data-series')]))) throw new Error('線尾應寫出名稱與數值');
    const ys = ends.map((e) => +e.getAttribute('y')).sort((a, b) => a - b);
    if (ys.some((y, i) => i && y - ys[i - 1] < 11)) throw new Error('線尾的文字不應重疊：' + ys.join());
    // 文字（座標軸、線尾、tooltip）對圖的底色 ≥ 4.5:1
    const TX = S.view.theme.text;
    [TX.body, TX.muted].forEach((c) => ['#ffffff', S.view.theme.canvas.surface].forEach((bg) => { if (contrastOf(c, bg) < 4.5) throw new Error(`趨勢圖的文字 ${c} 對 ${bg} 只有 ${contrastOf(c, bg).toFixed(2)}:1`); }));
    if (!charts[0].testAll('text').every((t) => [TX.body, TX.muted].includes(t.getAttribute('fill')))) throw new Error('趨勢圖的文字應用 theme.text 的文字色，不用資料色');
    const hits = charts[0].testAll('rect').filter((r) => r.className.includes('trend-hit'));
    if (hits.length !== series.length) throw new Error('每一輪應有一個 hover 區');
    hits[hits.length - 1].dispatch('pointerenter');
    const tip = charts[0].querySelector('.trend-tip');
    const lastS = series[series.length - 1];
    if (tip.classList.contains('hidden') || !tip.textContent.includes(S.view.num(lastS.pending)) || !tip.textContent.includes('待處理') || !tip.textContent.includes(S.view.fmtUtc(lastS.at))) throw new Error('hover 應顯示該輪的數值與時間：' + tip.textContent);
    if (tip.testAll('.trend-swatch').length !== 3) throw new Error('tooltip 的每一列應有和圖例相同的樣本');
    hits[hits.length - 1].dispatch('pointerleave');
    if (!tip.classList.contains('hidden')) throw new Error('離開時應隱藏 tooltip');
    // 鍵盤：一張圖只有一個 Tab 停點（最後一輪），方向鍵換輪次並顯示該輪的數值
    if (hits.filter((r) => r.getAttribute('tabindex') === '0').length !== 1 || hits[hits.length - 1].getAttribute('tabindex') !== '0') throw new Error('一張圖只有一個 Tab 停點（最後一輪）');
    hits[hits.length - 1].dispatch('keydown', { key: 'ArrowLeft' });
    const prev = hits[hits.length - 2]; const prevS = series[series.length - 2];
    if (document.activeElement !== prev || prev.getAttribute('tabindex') !== '0' || hits[hits.length - 1].getAttribute('tabindex') !== '-1') throw new Error('左方向鍵應移到上一輪');
    if (tip.classList.contains('hidden') || !tip.textContent.includes(S.view.num(prevS.pending))) throw new Error('鍵盤移到的輪次應顯示它的數值：' + tip.textContent);
    hits[hits.length - 2].dispatch('keydown', { key: 'End' });
    if (document.activeElement !== hits[hits.length - 1]) throw new Error('End 應移到最後一輪');
    if ($('#trend-body').querySelector('.trend-table').testAll('tbody tr').length !== series.length) throw new Error('表格檢視應列出每一輪');
    App.showView('graph');
    // 之後的步驟以範例資料進行（範例的第一輪已在處理紀錄中，不會再推進）
    await buildInput(sample); await App.ledgerJob;
  });
  await step('處理紀錄：只有一輪時顯示目前的數字、不畫圖', () => {
    const lg = S.view.app.ledger(); const one = Object.assign({}, lg, { iterations: lg.iterations.slice(-1) });
    const st = S.view.app.ledgerState(); const keep = st.ledger;
    st.ledger = one; S.view.ledgerPane.render(App); S.view.ledgerPane.renderTrend(App);
    try {
      if ($('#trend-body').testAll('.trend-chart').length || !$('#trend-body').querySelector('.trend-single')) throw new Error('只有一輪時不應畫圖');
      if ($('#trend-body').testAll('.trend-tile').length !== 5) throw new Error('應列出待處理、回歸、已豁免、覆蓋率、未知對端');
    } finally { st.ledger = keep; S.view.ledgerPane.render(App); S.view.ledgerPane.renderTrend(App); }
  });
  await step('舊的確認標記轉換成處理紀錄：寫入成功後才刪 acks；轉換失敗或寫入失敗時保留 acks 並說明', async () => {
    const VA = S.view.app; const Q = App.Q; const all = App.snap.findings;
    const keep = JSON.parse(JSON.stringify(VA.ledger()));
    const [f1, f2] = S.util.uniq(all.map((f) => Q.findingKey(f))).slice(0, 2);
    const acks = { [f1]: { at: '2025-01-02T00:00:00.000Z', kind: 'scheduled', note: '舊的' }, [f2]: { at: '2025-01-03T00:00:00.000Z' } };
    const realError = console.error; console.error = () => {}; // 預期中的錯誤（轉換、寫入失敗）不印出
    try {
      // 轉換成功
      await S.store.del('ledger'); await S.store.set('acks', acks);
      await VA.loadLedger(); await VA.advanceLedger(Q); VA.renderAll();
      const lg = await S.store.get('ledger');
      if (!lg || !S.ledger.validate(lg).ok) throw new Error('轉換後應寫入格式正確的 ledger');
      if (lg.items[f1].status !== 'scheduled' || lg.items[f2].status !== 'accepted' || lg.items[f1].history[0].ack.note !== '舊的') throw new Error('應依舊分類轉換並保留原始紀錄');
      if (await S.store.get('acks')) throw new Error('寫入成功後應刪掉 acks');
      if (!text('#banner').includes('轉換成處理紀錄')) throw new Error('轉換後應提示');
      // 轉換失敗：保留 acks、不寫 ledger，畫面說明
      await S.store.del('ledger'); const bad = { [f1]: { at: 'not-a-date' } }; await S.store.set('acks', bad);
      await VA.loadLedger(); await VA.advanceLedger(Q); VA.renderAll();
      if (JSON.stringify(await S.store.get('acks')) !== JSON.stringify(bad)) throw new Error('轉換失敗時 acks 應原樣保留');
      if (await S.store.get('ledger')) throw new Error('轉換失敗時不應寫入 ledger');
      if (!text('#banner').includes('無法轉換')) throw new Error('轉換失敗應以 banner 說明：' + text('#banner'));
      if (!$('#pane-findings').querySelector('.ledger-blocked') || !text('#ledger-body').includes('無法轉換') || !text('#round-body').includes('無法轉換')) throw new Error('檢查結果與驗證的處理紀錄應說明處理紀錄無法使用');
      if (!stepBtn('verify').textContent.includes('處理紀錄停用')) throw new Error('⑤ 的狀態應說明處理紀錄停用');
      const btn = document.testAll('#pane-findings .ledger-edit')[0];
      if (btn && btn.getAttribute('disabled') === null) throw new Error('處理紀錄無法使用時「處理」應停用');
      // 寫入失敗：acks 保留，之後寫入成功才刪
      await S.store.del('ledger'); await S.store.set('acks', acks);
      const realSet = S.store.set;
      S.store.set = async (k, v) => { if (k === 'ledger') throw new Error('模擬寫入失敗'); return realSet.call(S.store, k, v); };
      try { await VA.loadLedger(); await VA.advanceLedger(Q); } finally { S.store.set = realSet; }
      if (!(await S.store.get('acks')) || await S.store.get('ledger')) throw new Error('寫入失敗時應保留 acks');
      if (!text('#banner').includes('無法儲存處理紀錄') || !text('#banner').includes('保留不刪')) throw new Error('寫入失敗應說明：' + text('#banner'));
      const fx = all.find((f) => Q.findingKey(f) === f1);
      const r = await App.setLedger(fx, { note: '再寫一次' });
      if (!r.ok || !(await S.store.get('ledger')) || await S.store.get('acks')) throw new Error('之後寫入成功時才刪掉 acks');
    } finally {
      console.error = realError;
      await S.store.del('acks'); await S.store.set('ledger', keep); await VA.loadLedger(); VA.renderAll();
    }
  });
  await step('處理紀錄匯出與匯入：匯出 ssot-ledger/1；匯入先 validate，不合法列出錯誤且不覆蓋，合法時確認後才覆蓋', async () => {
    const VA = S.view.app;
    goStep('verify');
    // 匯出與匯入在資料中心；驗證畫面的處理紀錄只有入口，按了會開啟資料中心的處理紀錄那一列
    $('#ledger-body').querySelector('.open-hub').click();
    if ($('#hub').classList.contains('hidden') || document.activeElement !== $('#hub-sec-ledger')) throw new Error('驗證畫面的處理紀錄入口應開啟資料中心並聚焦處理紀錄');
    if (stepBtn('input').getAttribute('aria-current') !== 'step') throw new Error('資料中心開著時目前的一步是「① 輸入」');
    const btn = (cls) => $('#hub').querySelector('.' + cls);
    const { files } = await captureDownloads(() => btn('ledger-export').click());
    if (files.length !== 1 || !/^ledger-\d{8}T\d{6}Z\.json$/.test(files[0].name)) throw new Error('應下載 ledger-時間.json：' + (files[0] || {}).name);
    const exported = JSON.parse(files[0].text);
    require('assert').deepStrictEqual(exported, VA.ledger());
    if (!S.ledger.validate(exported).ok) throw new Error('匯出的處理紀錄應通過 validate');
    const importText = async (name, body) => {
      const inp = $('#hub').querySelector('.hub-file-ledger');
      inp.files = [{ name, text: async () => body }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 10));
    };
    const before = JSON.stringify(VA.ledger());
    await importText('bad.json', JSON.stringify({ schema: 'ssot-ledger/0', items: [], iterations: {} }));
    const res = $('#hub').querySelector('.ledger-import-result');
    if (!res || !res.textContent.includes('schema') || res.testAll('li').length < 2) throw new Error('不合法時應列出 validate 的錯誤');
    if (JSON.stringify(VA.ledger()) !== before) throw new Error('不合法時不可覆蓋現有的處理紀錄');
    await importText('broken.json', '{not json');
    if (!text('#hub').includes('不是 JSON')) throw new Error('不是 JSON 時應說明');
    // 合法：先確認，按「覆蓋」才取代
    const k = Object.keys(exported.items)[0];
    const mod = JSON.parse(JSON.stringify(exported)); mod.items[k].note = '匯入的備註';
    await importText('good.json', JSON.stringify(mod));
    if (!$('#hub').querySelector('.ledger-import-confirm')) throw new Error('合法時應請使用者確認覆蓋');
    if (VA.ledger().items[k].note === '匯入的備註') throw new Error('確認前不可覆蓋');
    $('#hub').querySelector('.ledger-confirm-import').click(); await new Promise((r) => setTimeout(r, 10));
    if (VA.ledger().items[k].note !== '匯入的備註' || (await S.store.get('ledger')).items[k].note !== '匯入的備註') throw new Error('確認後應覆蓋並存進 store');
    // 還原
    await importText('restore.json', JSON.stringify(exported));
    $('#hub').querySelector('.ledger-confirm-import').click(); await new Promise((r) => setTimeout(r, 10));
    S.view.app.closeHub();
  });
  await step('修正計畫：依規則、依設備或逐筆選取，依設備列出修改前（原文行號）與修改後（指令），三份 .rsc 與核心一致，下載檔名用 files() 的 base', async () => {
    const Q = App.Q; const RM = S.remediate; const RV = S.view.remediation; const PV = S.view.patchView;
    goStep('triage');
    $('#pane-findings').querySelector('.open-patch').click();
    // 修正計畫在中間的工作畫面（不是對話框）：分頁選取、拓樸圖被蓋住時 inert，焦點移到標題
    if (!PV.isOpen(App) || $('#view-patch').classList.contains('hidden') || $('#dlg-patch')) throw new Error('應在中間開啟修正計畫（不是對話框）');
    if (App.step !== 'fix' || stepBtn('fix').getAttribute('aria-current') !== 'step' || !$('#view-graph').inert || !$('#left').classList.contains('hidden')) throw new Error('修正計畫是「④ 修正」（目前的一步，沒有左側清單），底下的拓樸圖不可聚焦');
    if (document.activeElement !== $('#patch-title') || !$('#view-patch').contains($('#patch-body'))) throw new Error('開啟後焦點應移到修正計畫的標題');
    if (!text('#patch-body').includes('不會連線')) throw new Error('應標示本工具只產生文字，不會連線設備');
    // 同一份基準再開啟時保留上次的選取（例如從防火牆畫面開啟的）；全部清除後沒有計畫
    if (PV.state.keys.size) $('#patch-body').querySelector('.patch-clear').click();
    if (!$('#patch-body').querySelector('.patch-empty')) throw new Error('沒有選取時應說明如何選取');
    const autoIds = S.util.uniq(App.snap.findings.map((f) => f.id)).filter((id) => RM.levelOf(id) === 'auto');
    if (!autoIds.length) { if (process.env.SMOKE_INPUT) { App.showView('graph'); return; } throw new Error('範例資料應有 auto 修正'); }
    const chip = (id) => $('#patch-body').testAll('.patch-rule').find((c) => c.getAttribute('data-rule-id') === id);
    // 選取與計畫兩欄都在同一個工作畫面；用鍵盤按規則時，重繪後焦點留在同一個規則按鈕
    if (!$('#patch-body').querySelector('.patch-layout') || !$('#patch-body').querySelector('.patch-select') || !$('#patch-body').querySelector('.patch-main')) throw new Error('修正計畫應有「要修正哪些」與計畫兩欄');
    chip(autoIds[0]).focus(); chip(autoIds[0]).click();
    if (document.activeElement !== chip(autoIds[0])) throw new Error('重繪後焦點應留在剛按的規則按鈕');
    autoIds.slice(1).forEach((id) => chip(id).click());
    if (chip('F03')) chip('F03').click();
    const keys = Array.from(PV.state.keys).sort(S.util.cmp);
    const want = S.util.uniq(App.snap.findings.filter((f) => autoIds.includes(f.id) || f.id === 'F03').map((f) => Q.findingKey(f))).sort(S.util.cmp);
    if (keys.join() !== want.join()) throw new Error('依規則選取應選到這些規則的全部檢查結果');
    const plan = RM.plan(Q, keys); const files = RM.files(plan);
    const devs = $('#patch-body').testAll('.patch-dev');
    if (devs.map((d) => d.getAttribute('data-dev')).join() !== plan.devices.map((d) => d.key).join()) throw new Error('應依 plan.devices 的順序分台列出');
    plan.items.forEach((it) => {
      const box = $('#patch-body').testAll('.patch-item').find((b) => b.getAttribute('data-key') === it.key);
      if (!box) throw new Error('每個 item 都應列出：' + it.key);
      if (box.querySelector('.patch-cmd').textContent !== RV.itemApplyLines(plan, it)) throw new Error('修改後應是核心產生的套用指令');
      const links = box.querySelector('.patch-before').testAll('a');
      if (links.length !== it.evidence.length || !it.evidence.every((e, n) => links[n].textContent === `${e.file} 第 ${e.line} 行`)) throw new Error('修改前應列出 evidence 的原文行號');
    });
    // 修改前可點開原文
    const ev = plan.items[0].evidence[0];
    $('#patch-body').querySelector('.patch-before a').click();
    if (!$('#dlg-raw').open || !text('#raw-title').includes(`第 ${ev.line} 行`)) throw new Error('點修改前應開啟原文');
    $('#dlg-raw').close();
    // 沒有產生指令的：F03（choice）與 find 無法區分的 F02 列出原因
    const skipBox = $('#patch-body').querySelector('.patch-skipped');
    plan.skipped.forEach((x) => { if (!skipBox.textContent.includes(x.detail === RM.SKIP_TEXT[x.reason] ? RM.SKIP_TEXT[x.reason] : x.detail)) throw new Error('未產生指令的項目應說明原因：' + x.detail); });
    if (!process.env.SMOKE_INPUT && !plan.skipped.some((x) => x.id === 'F03' && x.reason === 'choice')) throw new Error('F03 應列為 choice，等第二階段');
    // 三份文字：與核心一致，可切換
    const f0 = files[0];
    const pre = () => $('#patch-body').testAll('.patch-dev')[0].querySelector('.patch-file');
    if (pre().textContent !== RM.renderRsc(plan, f0.dev)) throw new Error('預設顯示套用檔，內容應與 renderRsc 相同');
    [['rollback', RM.renderRollback], ['verify', RM.renderVerify], ['apply', RM.renderRsc]].forEach(([k, fn]) => {
      $('#patch-body').testAll('.patch-dev')[0].testAll('button').find((b) => b.getAttribute('data-kind') === k).click();
      if (pre().textContent !== fn(plan, f0.dev)) throw new Error(k + ' 的內容應與核心相同');
    });
    $('#patch-body').querySelector('.patch-copy').click();
    if (!text('#banner').includes('複製')) throw new Error('複製應有提示');
    // 多台：逐檔下載全部＋總表
    if (files.length > 1) {
      const { files: got } = await captureDownloads(() => $('#patch-body').querySelector('.patch-download-every').click());
      const names = files.flatMap((x) => [x.base + '.rsc', x.base + '-rollback.rsc', x.base + '-verify.rsc']);
      if (got.slice(0, -1).map((x) => x.name).join() !== names.join()) throw new Error('逐檔下載的檔名應用 files() 的 base：' + got.map((x) => x.name));
      files.forEach((x, n) => {
        if (got[n * 3].text !== x.apply || got[n * 3 + 1].text !== x.rollback || got[n * 3 + 2].text !== x.verify) throw new Error('下載內容應與 S.remediate 一致');
      });
      const md = got[got.length - 1];
      if (!/^patch-summary-.*\.md$/.test(md.name) || !names.every((n) => md.text.includes(n)) || !md.text.includes('不會連線')) throw new Error('總表應列出每台設備的檔名');
      if (!plan.items.every((it) => md.text.includes(it.risk.text)) || !plan.skipped.every((x) => md.text.includes(x.detail))) throw new Error('總表應列出風險與未產生指令的原因');
    } else if (!process.env.SMOKE_INPUT) throw new Error('範例資料的 auto 修正應涵蓋多台設備');
    // 單台：依設備選取，三個 .rsc
    $('#patch-body').querySelector('.patch-clear').click();
    if (PV.state.keys.size) throw new Error('全部清除後選取應為空');
    const sel = $('#patch-body').querySelector('.patch-device'); sel.value = f0.dev;
    $('#patch-body').querySelector('.patch-add-device').click();
    const devKeys = S.util.uniq(App.snap.findings.filter((f) => Q.findingDevice(f) === f0.dev).map((f) => Q.findingKey(f)));
    if (Array.from(PV.state.keys).sort().join() !== devKeys.sort().join()) throw new Error('依設備應選到這台設備的全部檢查結果');
    const p1 = RM.plan(Q, Array.from(PV.state.keys).sort(S.util.cmp)); const fs1 = RM.files(p1);
    if (fs1.length === 1) {
      const btns = $('#patch-body').querySelector('.patch-download-all').testAll('.patch-download');
      const { files: got } = await captureDownloads(() => btns.forEach((b) => b.click()));
      if (got.map((x) => x.name).join() !== [fs1[0].base + '.rsc', fs1[0].base + '-rollback.rsc', fs1[0].base + '-verify.rsc'].join()) throw new Error('單台應下載三個 .rsc：' + got.map((x) => x.name));
      if (got[0].text !== RM.renderRsc(p1, fs1[0].dev)) throw new Error('單台下載的套用檔應與 renderRsc 相同');
    }
    // 逐筆勾選
    $('#patch-body').querySelector('.patch-clear').click();
    const grp = $('#patch-body').testAll('.patch-group').find((g) => g.getAttribute('data-rule-id') === autoIds[0]);
    grp.open = true; grp.dispatch('toggle');
    const cb = grp.querySelector('.patch-pick'); cb.focus(); cb.checked = true; cb.dispatch('change');
    if (!PV.state.keys.has(cb.getAttribute('data-key')) || PV.state.keys.size !== 1) throw new Error('逐筆勾選應加入選取');
    if (!$('#patch-body').testAll('.patch-item').length && !$('#patch-body').querySelector('.patch-skipped')) throw new Error('勾選後應產生計畫');
    // 重繪後展開的規則仍展開，焦點留在剛勾選的那一筆
    const grp2 = $('#patch-body').testAll('.patch-group').find((g) => g.getAttribute('data-rule-id') === autoIds[0]);
    const cb2 = grp2.testAll('.patch-pick').find((x) => x.getAttribute('data-key') === cb.getAttribute('data-key'));
    if (grp2.getAttribute('open') === null || !cb2 || !cb2.checked || document.activeElement !== cb2) throw new Error('勾選後展開的規則應保持展開，焦點留在同一筆');
    // 點未產生指令的一筆：在右側開啟該筆，修正計畫留在中間
    const ref = $('#patch-body').querySelector('.finding-ref');
    if (ref) {
      App.select(null); ref.click();
      const f = App.Q.finding(+ref.getAttribute('data-finding-idx'));
      if (!PV.isOpen(App) || (f.entities.length && !App.sel)) throw new Error('點修正計畫中的檢查結果時，修正計畫應留在中間，右側顯示詳情');
    }
    App.showView('graph');
  });
  await step('修正計畫的選擇（A12）：NTP 預設採多數（推論）並修改偏離的設備，DNS 沒有多數時提示選擇，選了某一組才產生指令，選「不修改」寫入處理紀錄；畫面與總表沒有 undefined', async () => {
    const Q = App.Q; const RM = S.remediate; const RV = S.view.remediation; const PV = S.view.patchView; const VA = S.view.app;
    const a12 = new Map(Q.findings().filter((f) => f.id === 'A12').map((f) => [f.facet, f]));
    if (!a12.has('dns') || !a12.has('ntp')) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有 A12 的 DNS 與 NTP'); }
    const dnsF = a12.get('dns'); const dnsKey = Q.findingKey(dnsF); const ntpKey = Q.findingKey(a12.get('ntp'));
    // 前面的步驟（匯入與還原處理紀錄）留下的狀態不一定允許改為可接受：以空白的處理紀錄進行，結束時還原
    const savedLedger = VA.ledgerJson();
    App.importLedger('empty.json', JSON.stringify(S.ledger.empty())); await App.confirmImport();
    if (VA.ledgerStatus(dnsF) !== 'open') throw new Error('前提：空白的處理紀錄推進後 DNS 這筆是待處理');
    try {
      PV.open(App, [dnsKey, ntpKey]);
      const body = () => $('#patch-body');
      const block = (k) => body().testAll('.patch-choice').find((b) => b.getAttribute('data-finding') === k);
      const radio = (k, id) => block(k).testAll('.patch-choice-opt').find((r) => r.value === id);
      const noUndefined = (where) => { if (text('#patch-body').includes('undefined')) throw new Error(where + '：修正計畫不應出現 undefined'); };
      /** 計畫中這筆選擇產生的 item 都顯示在所屬設備下：對象是伺服器（不是規則）、修改前→後、警告與核心產生的指令 */
      const checkItems = (plan, c) => c.items.map((k) => {
        const it = plan.items.find((i) => i.key === k);
        const box = body().testAll('.patch-dev').find((b) => b.getAttribute('data-dev') === it.dev).testAll('.patch-item').find((b) => b.getAttribute('data-key') === k);
        if (!box) throw new Error('選擇產生的指令應列在 ' + it.dev + ' 下');
        const tgt = box.querySelector('.patch-target').textContent;
        if (tgt !== RV.targetText(it.target) || !tgt.includes(RV.FACET_ITEM[c.facet]) || !tgt.includes(it.target.menu)) throw new Error('對象應顯示伺服器的項目與設定選單：' + tgt);
        if (!box.textContent.includes(it.note) || !it.warnings.every((w) => box.textContent.includes(w))) throw new Error('應顯示修改前→後（note）與警告');
        if (box.querySelector('.patch-cmd').textContent !== RV.itemApplyLines(plan, it)) throw new Error('指令應由核心產生');
        return it.dev;
      });
      noUndefined('開啟時');
      // NTP：有多數時預設採多數，標示推論與依據，修改不在多數組的設備
      const plan0 = PV.state.plan; const ntp = plan0.choices.find((c) => c.findingKey === ntpKey);
      const maj = ntp.options.find((o) => o.id === 'majority');
      if (!maj || ntp.chosen !== 'majority' || ntp.chosenBy !== 'default' || !radio(ntpKey, 'majority').checked) throw new Error('有多數時預設應選多數');
      const majRow = block(ntpKey).testAll('.patch-choice-row').find((r) => r.getAttribute('data-option') === 'majority');
      if (!majRow.querySelector('.patch-inferred') || !majRow.textContent.includes('推論') || !majRow.textContent.includes(`${maj.basis.total} 台中 ${maj.basis.agree} 台`)) throw new Error('多數選項應標示推論與依據');
      if (!block(ntpKey).querySelector('.patch-choice-default')) throw new Error('預設採多數時應說明');
      const ntpDevs = checkItems(plan0, ntp);
      if (!ntpDevs.length || ntpDevs.some((d) => maj.basis.devs.includes(d))) throw new Error('採多數時應修改不在多數組的設備');
      if (!ntpDevs.includes('TPE_ACC_SW_12')) throw new Error('範例資料的 NTP 應修改偏離的 TPE_ACC_SW_12');
      // DNS：沒有多數時明確提示，沒有預設的選擇，也不產生指令
      const dns0 = plan0.choices.find((c) => c.findingKey === dnsKey);
      if (dns0.reason !== 'needs-choice') throw new Error('範例資料的 DNS 應沒有多數');
      if (!block(dnsKey).querySelector('.patch-choice-need').textContent.includes('沒有多數') || block(dnsKey).testAll('.patch-choice-opt').some((r) => r.checked)) throw new Error('沒有多數時應提示選擇，且沒有預選');
      if (plan0.items.some((i) => i.findingKey === dnsKey)) throw new Error('選擇前不應產生 DNS 的指令');
      // 選一組（不含 RT_01 的那組）：其他組的設備（含 RT_01）產生指令；焦點留在剛選的 radio
      const pick = dns0.options.find((o) => o.devs && !o.devs.includes('TPE_CORE_RT_01'));
      const r = radio(dnsKey, pick.id); r.checked = true; r.dispatch('change');
      if (PV.state.choices.get(dnsKey) !== pick.id) throw new Error('選擇應存在修正計畫的檢視狀態');
      const plan1 = PV.state.plan; const dns1 = plan1.choices.find((c) => c.findingKey === dnsKey);
      if (dns1.chosenBy !== 'user' || dns1.chosen !== pick.id || !radio(dnsKey, pick.id).checked) throw new Error('應以選擇重新產生計畫');
      if (document.activeElement !== radio(dnsKey, pick.id)) throw new Error('重新產生後焦點應留在剛選的 radio（鍵盤操作）');
      const dnsDevs = checkItems(plan1, dns1);
      const others = dns0.options.filter((o) => o.devs && o.id !== pick.id).flatMap((o) => o.devs);
      if (dnsDevs.slice().sort().join() !== others.slice().sort().join() || !dnsDevs.includes('TPE_CORE_RT_01')) throw new Error('選一組後應修改其他組的設備（範例資料是 TPE_CORE_RT_01）');
      // 預覽與下載都跟著選擇：每台設備的檔案就是 files(plan) 的內容，總表列出選擇
      const files = RM.files(plan1);
      files.forEach((f) => { if (body().testAll('.patch-dev').find((b) => b.getAttribute('data-dev') === f.dev).querySelector('.patch-file').textContent !== f.apply) throw new Error('預覽應是依選擇產生的檔案'); });
      noUndefined('選擇後');
      const md = S.view.exporter.patchSummaryMarkdown(plan1, files, Q);
      if (md.includes('undefined') || !md.includes('需要選擇的項目') || !md.includes(RV.choiceText(dns1).text)) throw new Error('總表應列出目前的選擇，且沒有 undefined');
      // 選「不修改」：不產生指令，畫面填原因後以 S.ledger 標為可接受
      const acc = radio(dnsKey, 'accept'); acc.checked = true; acc.dispatch('change');
      const plan2 = PV.state.plan;
      if (plan2.choices.find((c) => c.findingKey === dnsKey).reason !== 'accepted-choice' || plan2.items.some((i) => i.findingKey === dnsKey)) throw new Error('選不修改時不應產生指令');
      const ledgerBefore = JSON.stringify(VA.ledger());
      block(dnsKey).querySelector('.patch-accept-save').click(); await new Promise((res) => setTimeout(res, 10));
      if (JSON.stringify(VA.ledger()) !== ledgerBefore || block(dnsKey).querySelector('.ledger-error').classList.contains('hidden')) throw new Error('沒有原因時應顯示錯誤，處理紀錄不變');
      block(dnsKey).querySelector('.patch-accept-reason').value = '兩台各自使用不同的上游 DNS';
      block(dnsKey).querySelector('.patch-accept-save').click(); await new Promise((res) => setTimeout(res, 10));
      const it = VA.ledgerItem(dnsF);
      if (it.status !== 'accepted' || it.waiver.reason !== '兩台各自使用不同的上游 DNS' || (await S.store.get('ledger')).items[dnsKey].status !== 'accepted') throw new Error('選不修改後處理紀錄應變成可接受並存進 store');
      if (!PV.isOpen(App) || !block(dnsKey).querySelector('.patch-accept-done')) throw new Error('標為可接受後修正計畫應維持開啟並顯示處理紀錄的狀態');
      noUndefined('標為可接受後');
    } finally {
      PV.state.choices.clear(); App.showView('graph');
      App.importLedger('restore.json', savedLedger); await App.confirmImport();
    }
  });
  await step('原始輸出：已解析但有認不得的行時標示「部分無法辨識（N 行）」，點一下開啟第一行', () => {
    const b = App.snap.blocks.find((x) => x.adapters.length && !x.empty && x.unrecognizedLines.length && x.devKey && App.Q.getDevice(x.devKey));
    if (!b) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有部分無法辨識的區塊'); }
    App.select({ type: 'device', key: b.devKey });
    const link = $('#detail').testAll('.partial-unrecognized').find((a) => a.textContent === `部分無法辨識（${b.unrecognizedLines.length} 行）`);
    if (!link) throw new Error('應標示部分無法辨識的行數');
    link.click();
    if (!$('#dlg-raw').open || !text('#raw-title').includes(`第 ${b.unrecognizedLines[0]} 行`)) throw new Error('點一下應開啟第一個認不得的行');
    $('#dlg-raw').close(); App.select(null);
  });
  await step('趨勢圖的顏色：theme.trend 對畫布底色 ≥ 3:1，與嚴重度色不同', () => {
    const T = S.view.theme.trend; const surface = S.view.theme.canvas.surface;
    ['pending', 'regressed', 'accepted', 'single'].forEach((k) => {
      const c = contrastOf(T[k], surface); if (c < 3) throw new Error(`trend.${k} 對底色只有 ${c.toFixed(2)}:1`);
    });
    if (Object.values(S.view.theme.sev).some((c) => [T.pending, T.regressed, T.accepted].includes(c))) throw new Error('趨勢圖的類別色不應使用嚴重度色');
  });
  await step('VLAN 不相連區塊：詳情標示區塊、可切換區塊並回到全部，圖上只標該區塊', async () => {
    const dev = (n, ip) => `${n} (${ip}):\n### /export terse\n/interface bridge add name=bridge1\n/interface vlan add interface=bridge1 name=vlan50 vlan-id=50\n`;
    await buildInput(dev('VA', '10.0.0.1') + '_____\n' + dev('VB', '10.0.0.2'));
    const ds = App.Q.vlan(50).domains;
    if (ds.length < 2) throw new Error('測試資料應有不相連的 VLAN 區塊');
    App.select({ type: 'vlan', key: '50' });
    if (!text('#detail').includes(`${ds.length} 個不相連區塊（推論）`)) throw new Error('應標示不相連區塊');
    const link = $('#detail').testAll('a').find((x) => x.textContent.startsWith('區塊 2：'));
    if (!link) throw new Error('應可點選其他區塊');
    link.click();
    if (App.sel.domain !== ds[1].key || !text('#detail').includes(`（區塊 2／${ds.length}）`)) throw new Error('點區塊應切換到該區塊');
    if (Array.from(App.graph.hl.nodes.keys()).join() !== ds[1].devices.join()) throw new Error('圖上應只標出該區塊的設備');
    $('#detail').testAll('a').find((x) => x.textContent === '顯示所有區塊').click();
    if (App.sel.domain != null || App.graph.hl.nodes.size !== App.Q.vlan(50).devices.length) throw new Error('應可回到所有區塊');
  });
  await step('修正計畫：A12 的 DNS 與 NTP 依 facet 是不同的 findingKey，各自列出自己的訊息、各自可以勾選，詳情標示檢查項目', async () => {
    const RM = S.remediate; const RV = S.view.remediation; const PV = S.view.patchView;
    // 兩台的 DNS 與 NTP 都不一致：同一組設備有兩筆 A12（choice），實體相同、檢查項目（facet）不同
    const dev = (n, ip, dns, ntp) => `${n} (${ip}):\n### /export terse\n/ip dns set servers=${dns}\n/system ntp client set enabled=yes servers=${ntp}\n`;
    await buildInput(dev('VA', '10.0.0.1', '1.1.1.1', '10.9.9.1') + '_____\n' + dev('VB', '10.0.0.2', '8.8.8.8', '10.9.9.2'));
    const Q = App.Q; const all = Q.findings();
    const a12 = all.map((f, idx) => ({ f, idx, key: Q.findingKey(f) })).filter((x) => x.f.id === 'A12');
    if (a12.length < 2) throw new Error('測試資料應有同一組設備的多筆 A12');
    if (new Set(a12.map((x) => Q.findingBaseKey(x.f))).size !== 1) throw new Error('前提：這幾筆 A12 的規則與實體相同（不含 facet 的鍵相同）');
    if (new Set(a12.map((x) => x.key)).size !== a12.length) throw new Error('檢查項目不同的 A12 應是不同的 findingKey');
    // 檢查項目的顯示文字：有對應的轉成可讀文字，沒有對應或格式不符時顯示原值，沒有 facet 時不顯示
    const byFacet = new Map(a12.map((x) => [x.f.facet, x]));
    if (!byFacet.has('dns') || !byFacet.has('ntp')) throw new Error('A12 應各有 DNS 與 NTP 一筆');
    if (RV.facetText(byFacet.get('dns').f) !== 'DNS 伺服器' || RV.facetText(byFacet.get('ntp').f) !== 'NTP 伺服器') throw new Error('A12 的 dns／ntp 應顯示成「DNS 伺服器」「NTP 伺服器」');
    if (RV.facetText({ id: 'ZZ99', facet: 'raw|value' }) !== 'raw|value' || RV.facetText({ id: 'R06', facet: 'dns' }) !== 'dns') throw new Error('沒有對應或格式不符的 facet 應顯示原值');
    if (RV.facetText({ id: 'I03' }) !== null) throw new Error('沒有 facet 時不應有檢查項目');
    const declared = Object.keys(S.check.CATALOG).filter((id) => S.check.CATALOG[id].facet !== undefined);
    if (!declared.length || declared.some((id) => !RV.FACET_RULES.includes(id))) throw new Error('CATALOG 宣告 facet 的規則都應有顯示格式：' + declared.filter((id) => !RV.FACET_RULES.includes(id)).join('、'));
    // 詳情：每一筆在標題旁標示自己的檢查項目，title 是原值
    a12.forEach(({ f, idx }) => {
      App.selectFinding(idx);
      const box = $('#detail').testAll('.finding').find((el) => el.textContent.includes(f.message));
      const chip = box && box.querySelector('.facet');
      if (!chip || chip.textContent !== '檢查項目：' + RV.facetText(f) || chip.getAttribute('title') !== 'facet：' + f.facet) throw new Error('詳情應在 ' + f.message + ' 的標題旁標示檢查項目');
      if (a12.some((o) => o.f !== f && box.textContent.includes('檢查項目：' + RV.facetText(o.f)))) throw new Error('每一筆只標示自己的檢查項目');
    });
    const plain = all.findIndex((f) => f.facet == null);
    if (plain >= 0) {
      App.selectFinding(plain);
      const box = $('#detail').testAll('.finding').find((el) => el.textContent.includes(all[plain].message));
      if (box && box.querySelector('.facet')) throw new Error('沒有 facet 的檢查結果不應標示檢查項目');
    }
    App.select(null);
    // 未產生指令：每一個鍵各一列，列出自己的訊息，點了（或按 Enter）開啟自己那一筆
    const MISSING_KEY = JSON.stringify(['A12', 'device:不存在的設備']);
    PV.open(App, a12.map((x) => x.key).concat([MISSING_KEY]));
    const plan = RM.plan(Q, Array.from(PV.state.keys).sort(S.util.cmp));
    if (!a12.every((x) => plan.skipped.filter((s) => s.findingKey === x.key).length === 1)) throw new Error('每一筆 A12 應各有一個未產生指令的項目');
    const orig = App.selectFinding; const opened = [];
    App.selectFinding = (i) => { opened.push(i); return orig(i); };
    try {
      a12.forEach((x, n) => {
        const rows = $('#patch-body').testAll('.patch-skip').filter((r) => r.getAttribute('data-finding') === x.key);
        if (rows.length !== 1) throw new Error('每一個鍵應恰好一列');
        if (!rows[0].textContent.includes(x.f.message) || a12.some((o) => o !== x && rows[0].textContent.includes(o.f.message))) throw new Error('每一列只列出自己的訊息');
        const link = rows[0].querySelector('.finding-ref');
        if (!link || link.getAttribute('title') !== x.f.message) throw new Error('訊息連結的 title 應是完整訊息');
        if (n === 0) link.click(); else link.dispatch('keydown', { key: 'Enter' });
        if (opened[opened.length - 1] !== x.idx) throw new Error('點擊應開啟這一筆的檢查結果');
        // 修正計畫在中間、詳情在右側：開啟檢查結果時修正計畫留著，右側顯示這一筆
        if (!PV.isOpen(App) || !text('#detail').includes(x.f.message)) throw new Error('開啟檢查結果時修正計畫應留在中間，右側的詳情顯示這一筆');
      });
    } finally { App.selectFinding = orig; }
    // 原因只在分組標題：每一筆不再重複寫原因或等級
    PV.open(App);
    const sk = plan.skipped.find((s) => s.findingKey === a12[0].key);
    const group = $('#patch-body').testAll('.patch-skip-group').find((g) => g.getAttribute('data-reason') === sk.reason);
    if (!group.querySelector('.patch-label').textContent.includes(RM.SKIP_TEXT[sk.reason])) throw new Error('分組標題應是 SKIP_TEXT');
    if ($('#patch-body').testAll('.patch-skip').some((r) => r.textContent.includes(RM.SKIP_TEXT[sk.reason]) || r.textContent.includes(RV.LEVEL_TEXT[sk.level]))) throw new Error('每一筆不應重複寫原因');
    // 基準中沒有的鍵：明確說明，不是空白
    const nf = $('#patch-body').testAll('.patch-skip').find((r) => r.getAttribute('data-finding') === MISSING_KEY);
    if (!nf || !nf.querySelector('.finding-missing') || nf.querySelector('.finding-missing').textContent !== RV.MISSING_FINDING_TEXT) throw new Error('基準中沒有的鍵應說明「' + RV.MISSING_FINDING_TEXT + '」');
    if (nf.querySelector('.finding-ref')) throw new Error('基準中沒有的鍵不應有連結');
    // 逐筆勾選：每一筆 A12 各一個勾選框，標示檢查項目；勾一個只加入那一筆
    $('#patch-body').querySelector('.patch-clear').click();
    const g = $('#patch-body').testAll('.patch-group').find((x) => x.getAttribute('data-rule-id') === 'A12');
    g.open = true; g.dispatch('toggle');
    const picks = g.testAll('.patch-pick');
    if (picks.map((cb) => cb.getAttribute('data-key')).sort().join('\n') !== a12.map((x) => x.key).sort().join('\n')) throw new Error('每一筆 A12 應各有一個勾選框');
    a12.forEach((x) => {
      const row = g.testAll('.patch-pick-row').find((r) => r.querySelector('.patch-pick').getAttribute('data-key') === x.key);
      if (!row.textContent.includes(x.f.message) || !row.querySelector('.facet') || row.querySelector('.facet').textContent !== RV.facetText(x.f)) throw new Error('勾選列應列出自己的訊息與檢查項目');
    });
    const ntp = byFacet.get('ntp').key;
    const pick = picks.find((cb) => cb.getAttribute('data-key') === ntp);
    pick.checked = true; pick.dispatch('change');
    if (PV.state.keys.size !== 1 || !PV.state.keys.has(ntp)) throw new Error('勾選 NTP 只應加入 NTP 那一筆');
    const after = $('#patch-body').testAll('.patch-skip').map((r) => r.getAttribute('data-finding'));
    if (after.join() !== ntp) throw new Error('只勾選 NTP 時，計畫只應有 NTP 那一筆：' + after.join('｜'));
    App.showView('graph');
    // 過長的訊息截斷，完整內容在 title
    const long = 'x'.repeat(RV.FINDING_TEXT_MAX + 30);
    const el = RV.findingRef(App, { idx: 0, f: { message: long } }, 'k');
    if (el.textContent.length !== RV.FINDING_TEXT_MAX || !el.textContent.endsWith('…') || el.getAttribute('title') !== long) throw new Error('過長的訊息應截斷，完整內容放在 title');
  });
  await step('修正計畫的未產生指令：仍共用 findingKey 的 I03（同一份收集檔多段無法辨識）依位置對應，各列出自己的訊息，點了開啟該筆', async () => {
    const RM = S.remediate; const RV = S.view.remediation; const PV = S.view.patchView;
    await buildInput(['SW_A (10.0.0.1):', '### /ip arp print detail', ' 0 address=10.0.0.9 mac-address=AA:BB:CC:00:00:09 interface=ether1', 'GARBAGE LINE one',
      '### /ip address print detail', ' 0 address=10.0.0.1/24 network=10.0.0.0 interface=ether1', 'GARBAGE LINE two', ''].join('\n'));
    const Q = App.Q; const all = Q.findings();
    const i03 = all.map((f, idx) => ({ f, idx, key: Q.findingKey(f) })).filter((x) => x.f.id === 'I03');
    if (i03.length < 2) throw new Error('測試資料應有同一台設備的多段 I03');
    if (new Set(i03.map((x) => x.key)).size !== 1 || i03.some((x) => x.f.facet != null)) throw new Error('前提：I03 不帶 facet，同一台設備的多段共用一個鍵');
    if (new Set(i03.map((x) => x.f.message)).size !== i03.length) throw new Error('前提：各段的訊息不同');
    const key = i03[0].key;
    PV.open(App, [key]);
    const sk = RM.plan(Q, [key]).skipped.filter((x) => x.findingKey === key);
    if (sk.length !== i03.length) throw new Error('共用鍵的每一筆都應是一個未產生指令的項目');
    // 依位置對應：同一個鍵的第 n 筆對到基準中這個鍵的第 n 筆
    if (RV.matchFindings(Q, sk).map((m) => m && m.idx).join() !== i03.map((x) => x.idx).join()) throw new Error('共用鍵時應依位置對回基準中的每一筆');
    const rowsOf = () => $('#patch-body').testAll('.patch-skip').filter((r) => r.getAttribute('data-finding') === key);
    const rows = rowsOf();
    if (rows.length !== i03.length) throw new Error('每一筆未產生指令的項目都應列出');
    if (!rows.every((r, n) => r.textContent.includes(i03[n].f.message) && i03.every((o, m) => m === n || !r.textContent.includes(o.f.message)))) throw new Error('每一列應列出自己那一筆的訊息');
    const group = $('#patch-body').testAll('.patch-skip-group').find((x) => x.getAttribute('data-reason') === sk[0].reason);
    if (!group.querySelector('.patch-label').textContent.includes(RM.SKIP_TEXT[sk[0].reason])) throw new Error('分組標題應是 SKIP_TEXT');
    if (rows.some((r) => r.textContent.includes(RM.SKIP_TEXT[sk[0].reason]) || r.textContent.includes(RV.LEVEL_TEXT[sk[0].level]))) throw new Error('每一筆不應重複寫原因');
    const orig = App.selectFinding; const opened = [];
    App.selectFinding = (i) => { opened.push(i); return orig(i); };
    try {
      i03.forEach((x, n) => {
        const link = rowsOf()[n].querySelector('.finding-ref');
        if (!link || link.getAttribute('title') !== x.f.message) throw new Error('訊息連結的 title 應是完整訊息');
        if (n === 0) link.click(); else link.dispatch('keydown', { key: 'Enter' });
        if (opened[opened.length - 1] !== x.idx) throw new Error('點擊應開啟這一筆的檢查結果');
        if (!PV.isOpen(App)) throw new Error('開啟檢查結果時修正計畫應留在中間（詳情在右側）');
      });
      if (new Set(opened).size !== i03.length) throw new Error('不同的列應開啟不同的檢查結果');
    } finally { App.selectFinding = orig; }
    // 逐筆勾選以鍵為單位：共用鍵的多段只有一個勾選框（計畫也以鍵為單位）
    PV.open(App);
    const g = $('#patch-body').testAll('.patch-group').find((x) => x.getAttribute('data-rule-id') === 'I03');
    g.open = true; g.dispatch('toggle');
    const picks = g.testAll('.patch-pick').map((cb) => cb.getAttribute('data-key'));
    if (picks.join() !== key) throw new Error('共用鍵的 I03 應只有一個勾選框：' + picks.join('｜'));
    App.showView('graph');
  });
  await step('只有 MNDP 的設備對不畫線；詳情仍說明是廣播網域可達、非直連', async () => {
    const input = 'A (10.0.0.1):\n### /ip neighbor print detail\n'
      + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    if (App.snap.meta.inputHash !== hash) throw new Error('MNDP 基準未建立');
    const domainLink = App.snap.model.links.find((l) => l.evidenceScope === 'broadcast-domain');
    if (!domainLink) throw new Error('MNDP 仍應保留在基準的鏈路中');
    if (Array.from(App.pairs.values()).some((x) => !x.virtual)) throw new Error('只有 MNDP 的設備對不應畫線');
    App.select({ type: 'device', key: 'A' });
    if (!text('#detail').includes('非直連確認')) throw new Error('設備鄰居表仍應列出 MNDP，並說明非直連');
    App.select({ type: 'link', key: domainLink.key });
    if (!text('#detail').includes('非直連確認')) throw new Error('MNDP 細節未明示非直連語意');
    const remoteEp = S.keys.splitEp(domainLink.a)[0] === 'A' ? domainLink.b : domainLink.a;
    App.select({ type: 'interface', key: remoteEp });
    if (!text('#detail').includes('MNDP：L2 廣播網域可達，非直連')) throw new Error('MNDP 回報介面的細節不應呈現為直連線');
  });
  await step('連線埠名：縮小時隱藏，滑過連線或節點時強制顯示', () => {
    const graph = App.graph; const ctx = graph.ctx;
    const old = { nodes: graph.nodes, edges: graph.edges, pos: graph.pos, sel: graph.sel, hl: graph.hl, hover: graph.hover, fillText: ctx.fillText };
    const nodes = ['pa', 'pb'].map((id) => ({ id, label: id, kind: 'switch', collected: true, group: 'test' }));
    const edges = [{ id: 'pe', a: 'pa', b: 'pb', cls: 'other', count: 1, evidence: 'adjacency', labelA: 'etherA1', labelB: 'etherB1' }];
    const texts = [];
    try {
      ctx.fillText = (s) => { texts.push(String(s)); };
      graph.setData(nodes, edges, new Map([['pa', { x: 0, y: 0 }], ['pb', { x: 400, y: 0 }]])); graph.hl = null; graph.setSelection([], []); graph.fit();
      graph.s = 0.5; graph.hover = null; texts.length = 0; graph.draw();
      if (texts.some((s) => s.startsWith('ether'))) throw new Error('縮小且未滑過時不應顯示埠名');
      graph.hover = { type: 'edge', id: 'pe' }; texts.length = 0; graph.draw();
      if (!texts.includes('etherA1') || !texts.includes('etherB1')) throw new Error('滑過連線時應顯示兩端埠名');
      graph.hover = { type: 'node', id: 'pa' }; texts.length = 0; graph.draw();
      if (!texts.includes('etherA1')) throw new Error('滑過節點時應顯示相鄰連線的埠名');
    } finally {
      Object.assign(graph, { nodes: old.nodes, edges: old.edges, pos: old.pos, sel: old.sel, hl: old.hl, hover: old.hover }); ctx.fillText = old.fillText;
    }
  });
  await step('推論鏈路以 theme 的弱邊樣式呈現，高亮不淡化', () => {
    const graph = App.graph; const ctx = graph.ctx; const weak = S.view.theme.weakEdge;
    const old = {
      nodes: graph.nodes, edges: graph.edges, pos: graph.pos, sel: graph.sel, hl: graph.hl, hover: graph.hover,
      s: graph.s, tx: graph.tx, ty: graph.ty, stroke: ctx.stroke, setLineDash: ctx.setLineDash,
      moveTo: ctx.moveTo, lineTo: ctx.lineTo,
    };
    const nodes = ['weak-a', 'weak-b', 'mixed-a', 'mixed-b'].map((id) => ({
      id, label: id, kind: 'switch', collected: true, group: 'test',
    }));
    const edges = [
      { id: 'weak-edge', a: 'weak-a', b: 'weak-b', cls: 'other', count: 1, evidence: 'inferred' },
      { id: 'mixed-evidence', a: 'mixed-a', b: 'mixed-b', cls: 'other', count: 1, evidence: 'adjacency', hasDomain: true },
    ];
    const pos = new Map([['weak-a', { x: 0, y: 0 }], ['weak-b', { x: 180, y: 0 }], ['mixed-a', { x: 0, y: 180 }], ['mixed-b', { x: 180, y: 180 }]]);
    const strokes = []; let dash = []; let from = null; let to = null;
    const samePoint = (a, b) => a && b && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
    const segmentStrokes = (aId, bId) => strokes.filter((s) =>
      (samePoint(s.from, pos.get(aId)) && samePoint(s.to, pos.get(bId))) ||
      (samePoint(s.from, pos.get(bId)) && samePoint(s.to, pos.get(aId))));
    try {
      ctx.setLineDash = (pattern) => { dash = pattern.slice(); };
      ctx.moveTo = (x, y) => { from = { x, y }; to = null; };
      ctx.lineTo = (x, y) => { to = { x, y }; };
      ctx.stroke = () => { strokes.push({ alpha: ctx.globalAlpha, color: ctx.strokeStyle, dash: dash.slice(), from, to }); };
      graph.setData(nodes, edges, pos); graph.hl = null; graph.hover = null; graph.setSelection([], []); graph.fit(); graph.draw();
      const pure = segmentStrokes('weak-a', 'weak-b');
      if (!pure.some((s) => s.alpha === weak.inferred.alpha && s.color === S.view.theme.edge.other.c && s.dash.join() === weak.inferred.dash.join())) throw new Error('推論鏈路應保留連線類別色，只改 theme 指定的透明度與虛線');
      const mixed = segmentStrokes('mixed-a', 'mixed-b');
      if (!mixed.length || mixed.some((s) => s.alpha !== 1)) throw new Error('有介面鄰接的邊不應套用弱邊透明度');
      graph.setSelection([], ['weak-edge']); strokes.length = 0; graph.draw();
      if (!segmentStrokes('weak-a', 'weak-b').some((s) => s.alpha === 1)) throw new Error('選取高亮應維持完整不透明度');
      graph.setSelection([], []); graph.hover = { type: 'edge', id: 'weak-edge' }; strokes.length = 0; graph.draw();
      if (!segmentStrokes('weak-a', 'weak-b').some((s) => s.alpha === 1)) throw new Error('hover 高亮應維持完整不透明度');
    } finally {
      ctx.stroke = old.stroke; ctx.setLineDash = old.setLineDash; ctx.moveTo = old.moveTo; ctx.lineTo = old.lineTo;
      graph.setData(old.nodes, old.edges, old.pos); graph.setSelection(old.sel.nodes, old.sel.edges);
      graph.setHighlight(old.hl); graph.hover = old.hover; graph.s = old.s; graph.tx = old.tx; graph.ty = old.ty; graph.redraw();
    }
  });
  await step('文字對比：每個文字色對它的底色 ≥ 4.5:1（CSS 變數、狀態標籤、theme 的文字色）', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8'); const v = cssVars(css); const T = S.view.theme;
    const white = '#ffffff';
    // 狀態文字色的單一來源：theme.text 與 CSS 的 --*-text、--muted、--text 相同
    [['err', 'err-text'], ['warn', 'warn-text'], ['ok', 'ok-text'], ['info', 'info-text'], ['muted', 'muted'], ['body', 'text']].forEach(([k, n]) => {
      if ((v[n] || '').toLowerCase() !== T.text[k].toLowerCase()) throw new Error(`--${n} 與 theme.text.${k} 不一致`);
    });
    const pairs = [
      ['--text', v.text, [white, v.surface, v.bg]],
      ['--muted', v.muted, [white, v.surface, v['surface-hover'], v['neutral-soft'], v['accent-soft'], v['accent-hover'], v['err-soft'], v['warn-soft']]],
      ['--accent', v.accent, [white, v.surface, v['accent-soft'], v['accent-hover']]],
      ['--err-text', v['err-text'], [white, v.surface, v['err-soft'], T.firewall.focus.bg]],
      ['--warn-text', v['warn-text'], [white, v.surface, v['warn-soft'], T.firewall.focus.bg]],
      ['--ok-text', v['ok-text'], [white, v.surface, v['ok-soft'], T.firewall.focus.bg]],
      ['--info-text', v['info-text'], [white, v.surface, v['info-soft']]],
    ];
    // 狀態與設備類型標籤：.chip.xxx { background; color }（color 可能是變數）
    Array.from(css.matchAll(/\.chip\.(err|warn|info|ok|kind-[a-z]+)\s*\{([^}]*)\}/g)).forEach((m) => {
      const val = (prop) => { const x = (m[2].match(new RegExp('(?:^|;)\\s*' + prop + ':\\s*([^;]+)')) || [])[1]; return x && x.trim().replace(/^var\(--([\w-]+)\)$/, (_, n) => v[n]); };
      pairs.push(['.chip.' + m[1], val('color'), [val('background')]]);
    });
    if (pairs.filter((p) => p[0].startsWith('.chip.kind-')).length !== Object.keys(S.view.KIND).length) throw new Error('每個設備類型都應有 .chip.kind-* 樣式');
    // theme 的文字色：防火牆動作（一般列、斑馬列、定位列）、比對 effect（白底、新暴露列）、畫布上的文字（疊在畫布底色上）
    Object.entries(T.firewall.action).forEach(([k, c]) => pairs.push(['firewall.action.' + k, c, [white, v.surface, T.firewall.focus.bg]]));
    Object.entries(T.diff.effect).forEach(([k, c]) => pairs.push(['diff.effect.' + k, c, [white, T.diff.exposureBg]]));
    const onCanvas = (bg) => '#' + rgbOf(bg, v.surface).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
    pairs.push(['canvas.group.text', T.canvas.group.text, [onCanvas(T.canvas.group.fill)]]);
    pairs.push(['canvas.label.text', T.canvas.label.text, [onCanvas(T.canvas.label.bg)]], ['canvas.label.textUncollected', T.canvas.label.textUncollected, [onCanvas(T.canvas.label.bg)]]);
    pairs.push(['canvas.port.text', T.canvas.port.text, [onCanvas(T.canvas.port.bg)]]);
    pairs.push(['endpoint.downstream.text', T.endpoint.downstream.text, [T.endpoint.downstream.fill]], ['endpoint.cluster.text', T.endpoint.cluster.text, [T.endpoint.cluster.fill]]);
    const low = [];
    pairs.forEach(([name, fg, bgs]) => {
      if (!fg) throw new Error('找不到文字色：' + name);
      bgs.forEach((bg) => { if (!bg) throw new Error('找不到底色：' + name); const r = contrastOf(fg, bg); if (r < 4.5) low.push(`${name} ${fg} 對 ${bg} 只有 ${r.toFixed(2)}:1`); });
    });
    if (low.length) throw new Error('文字對比不足：\n' + low.join('\n'));
    // 這些文字改用文字色變數，不寫死色值：修正範例的警告列、原文行號、比對差異
    [/\.fw-fix \.warn-line\s*\{[^}]*color:\s*var\(--warn-text\)/, /pre\.raw \.ln\s*\{[^}]*color:\s*var\(--muted\)/, /\.diffA\s*\{[^}]*color:\s*var\(--err-text\)/].forEach((re) => {
      if (!re.test(css)) throw new Error('應使用文字色變數：' + re);
    });
  });
  await step('嚴重度在畫布上有外形：錯誤與警告外形不同，主機與連線中點也顯示', () => {
    const graph = App.graph; const T = S.view.theme;
    const nodes = [
      { id: 'sev-sw', label: 'sev-sw', kind: 'switch', collected: true, group: 't', sev: null },
      { id: 'sev-err', label: 'sev-err', kind: 'host', collected: true, group: 't', sev: 'error' },
      { id: 'sev-warn', label: 'sev-warn', kind: 'host', collected: true, group: 't', sev: 'warn' },
    ];
    const edges = [{ id: 'sev-e', a: 'sev-sw', b: 'sev-err', cls: '1g', count: 1, evidence: 'adjacency', sev: 'warn' }];
    const pos = new Map([['sev-sw', { x: 0, y: 0 }], ['sev-err', { x: 200, y: 0 }], ['sev-warn', { x: 0, y: 200 }]]);
    withGraph(graph, nodes, edges, pos, () => {
      if (graph.radius(nodes[1]) > 7) throw new Error('測試前提：主機是小節點');
      const ops = recordCanvas(graph.ctx, () => graph.draw());
      const marks = (sev, at) => ops.filter((o) => o.op === 'fill' && o.style === T.sev[sev] && near(o.path, at, 20));
      const err = marks('error', pos.get('sev-err')); const warn = marks('warn', pos.get('sev-warn'));
      if (!err.length) throw new Error('主機上的錯誤應顯示嚴重度標記');
      if (!warn.length) throw new Error('主機上的警告應顯示嚴重度標記');
      const mid = marks('warn', { x: 100, y: 0 });
      if (!mid.length) throw new Error('有問題的連線應在中點顯示嚴重度標記');
      if (vertices(err[0].path) === vertices(warn[0].path)) throw new Error('錯誤與警告的外形應不同');
      if (vertices(mid[0].path) !== vertices(warn[0].path)) throw new Error('連線中點與節點的警告外形應相同');
      const want = { square: 4, triangle: 3 };
      Object.entries(T.sevShape).forEach(([k, shape]) => { const got = vertices((k === 'error' ? err : warn)[0].path); if (want[shape] !== got) throw new Error(`${k} 應畫成 ${shape}（${want[shape]} 個頂點），實際 ${got}`); });
    });
    // 圖例：兩種嚴重度都畫出，外形與顏色取自 theme
    const items = Array.from(document.testAll('#legend .li'));
    Object.entries(T.sevShape).forEach(([k, shape]) => {
      const li = items.find((x) => x.textContent === S.view.SEV[k]); const sw = li && li.childNodes.find((c) => c.attrs && c.attrs['data-shape']);
      if (!sw) throw new Error('圖例缺少嚴重度：' + k);
      if (sw.getAttribute('data-shape') !== shape || sw.style.background !== T.sev[k]) throw new Error('圖例的嚴重度外形或顏色與 theme 不一致：' + k);
      if (shape === 'triangle' && !String(sw.style.clipPath).includes('polygon')) throw new Error('圖例的警告應畫成三角形');
    });
  });
  await step('高亮不重複：滑過、搜尋、選取、追蹤各自不同，滑過時節點本身有回饋', () => {
    const graph = App.graph; const M = S.view.theme.mark;
    if (M.hover === M.find) throw new Error('滑過與搜尋結果不應同色');
    if (M.select === M.trace) throw new Error('選取與路由追蹤不應同色');
    if ([M.select, M.hover, M.find, M.trace].some((c) => c === M.bad || c === M.good || Object.values(S.view.theme.sev).includes(c))) throw new Error('標示色不應使用狀態色');
    const nodes = ['hv-a', 'hv-b'].map((id) => ({ id, label: id, kind: 'router', collected: true, group: 't' }));
    const pos = new Map([['hv-a', { x: 0, y: 0 }], ['hv-b', { x: 200, y: 0 }]]);
    withGraph(graph, nodes, [{ id: 'hv-e', a: 'hv-a', b: 'hv-b', cls: '1g', count: 1, evidence: 'adjacency' }], pos, () => {
      const ring = (ops) => ops.filter((o) => o.op === 'stroke' && o.style === M.hover && o.path.some((p) => p.t === 'A' && Math.hypot(p.x, p.y) < 0.01));
      if (ring(recordCanvas(graph.ctx, () => graph.draw())).length) throw new Error('沒有滑過時不應有滑過環');
      graph.hover = { type: 'node', id: 'hv-a' };
      if (!ring(recordCanvas(graph.ctx, () => graph.draw())).length) throw new Error('滑過節點時節點本身應有回饋');
    });
  });
  await step('OSPF-only 鄰接不畫拓樸 edge，仍保留 L3 設備細節與來源', async () => {
    const input = 'R_A (10.0.0.1):\n### /export terse\n/ip address add address=10.254.0.1/30 interface=ether48\n'
      + '### /routing ospf neighbor print detail\n 0 instance=default address=10.254.0.2 router-id=2.2.2.2 interface=ether48 state=Full\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    if (App.snap.meta.inputHash !== hash) throw new Error('OSPF 基準未建立');
    if (App.snap.model.links.length || App.graph.edges.length) throw new Error('OSPF-only adjacency 不應形成拓樸 edge');
    if (!App.snap.model.ospfAdjacencies.length) throw new Error('OSPF L3 鄰接資訊遺失');
    App.select({ type: 'device', key: 'R_A' });
    if (!text('#detail').includes('OSPF L3 鄰接（非實體直連）')) throw new Error('設備細節沒有顯示獨立 OSPF 鄰接');
    if (!text('#detail').includes('第 5 行')) throw new Error('OSPF 細節沒有來源行連結');
  });
  await step('設備詳情表可點標頭排序，IP 欄依數值順序', async () => {
    const input = 'R_A (10.0.0.1):\n### /ip route print detail without-paging\n'
      + 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC\n'
      + ' 0 As  dst-address=10.10.0.0/16 gateway=10.0.0.9 distance=1\n'
      + ' 1 As  dst-address=10.9.0.0/16 gateway=10.0.0.2 distance=1\n'
      + ' 2 As  dst-address=10.100.0.0/16 gateway=10.0.0.3 distance=1\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    App.select({ type: 'device', key: 'R_A' });
    const th = $('#detail').testAll('th').find((el) => el.textContent.startsWith('網段'));
    if (!th) throw new Error('路由表應有可排序的網段標頭');
    th.dispatch('click');
    const order = () => $('#detail').testAll('tbody tr').map((tr) => tr.textContent).filter((s) => /^10\.\d+\.0\.0\/16/.test(s)).map((s) => s.split('/')[0]);
    if (order().join() !== '10.9.0.0,10.10.0.0,10.100.0.0') throw new Error('網段應依 IP 數值升冪：' + order());
    $('#detail').testAll('th').find((el) => el.textContent.startsWith('網段')).dispatch('click');
    if (order().join() !== '10.100.0.0,10.10.0.0,10.9.0.0') throw new Error('再點一次應降冪：' + order());
  });
  await step('CAPsMAN Wi-Fi 多 MAC 保留菱形提示，MAC 位置列入終端清單', async () => {
    const input = 'SW_A (10.0.0.1):\n### /interface print detail\n'
      + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
      + ' 7    RS ;;; managed by CAPsMAN, traffic processing on\n'
      + '              CAP         ;;; mode: AP, SSID: test, channel: 2412/n\n'
      + '         name="wifi1" default-name="wifi1" type="wifi" actual-mtu=1500\n'
      + ' 9  D RS ;;; managed by CAPsMAN, traffic processing on\n'
      + '              CAP         ;;; mode: AP, SSID: test-5g, channel: 5660/ac/Ceee\n'
      + '         name="wifi8" type="wifi" actual-mtu=1500\n'
      + '### /interface bridge host print detail\n'
      + ' 0 D mac-address=14:63:93:C4:13:24 on-interface=wifi1 bridge=bridge\n'
      + ' 1 D mac-address=3C:64:CF:0C:C4:63 on-interface=wifi1 bridge=bridge\n'
      + ' 2 D mac-address=06:89:53:94:06:0F on-interface=wifi8 bridge=bridge\n'
      + ' 3 D mac-address=18:F0:E4:FF:EF:35 on-interface=wifi8 bridge=bridge\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    if (App.snap.meta.inputHash !== hash) throw new Error('Wi-Fi 基準未建立');
    const wifis = App.snap.model.interfaces.filter((i) => ['wifi1', 'wifi8'].includes(i.name));
    if (!wifis.every((i) => i.status === 'up' && !i.unknownPeer && !i.edge && i.macs.length === 2)) throw new Error('Wi-Fi 不應列為終端介面');
    const diamonds = App.graph.nodes.filter((n) => n.kind === 'downstream' && n.parent === 'SW_A');
    if (diamonds.length !== 2 || !diamonds.every((n) => n.id === '?p|SW_A|wifi1' || n.id === '?p|SW_A|wifi8')) throw new Error('Wi-Fi 多 MAC 應保留菱形圖面提示');
    const wifiRows = App.Q.inventory().rows.endpoints.filter((r) => r.wifi);
    if (wifiRows.length !== 4 || !wifiRows.every((r) => ['wifi1', 'wifi8'].includes(r.ifc))) throw new Error('每個 Wi-Fi MAC 觀察位置都應列入終端清單');
    if (App.snap.findings.some((f) => f.id === 'A02')) throw new Error('Wi-Fi 漫遊 MAC 位置不應觸發 A02');
    App.select({ type: 'endpoints', dev: 'SW_A' });
    const detail = text('#detail');
    if (!detail.includes('14:63:93:c4:13:24') || !detail.includes('18:f0:e4:ff:ef:35')) throw new Error('設備詳情應逐筆顯示 Wi-Fi MAC 位置');
  });
  await step('veth 與 Wi-Fi 連線以專用線型識別，顏色維持連線類別色', async () => {
    const input = 'SW_A (10.0.0.1):\n### /interface print detail\n'
      + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
      + ' 0  R  name="veth1" type="veth" mtu=1500\n'
      + ' 1  R  name="ether5" type="ether" mtu=1500\n'
      + '### /interface bridge host print detail\n'
      + ' 0 D mac-address=02:AA:BB:00:00:01 on-interface=veth1 bridge=bridge1\n'
      + ' 1 D mac-address=AA:BB:CC:00:00:02 on-interface=ether5 bridge=bridge1\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    if (App.snap.meta.inputHash !== hash) throw new Error('veth 基準未建立');
    const v = App.graph.nodes.find((n) => n.id === '?p|SW_A|veth1'); const e = App.graph.nodes.find((n) => n.id === '?p|SW_A|ether5');
    if (!v || !e) throw new Error('veth1 與 ether5 終端都應畫出');
    const T = S.view.theme; const vs = T.endpoint.byType.veth; const ws = T.endpoint.byType.wireless;
    if (v.ifStyle) throw new Error('veth 節點外觀不應改變，只識別連線');
    const ve = App.graph.edges.find((x) => x.b === v.id); const ee = App.graph.edges.find((x) => x.b === e.id);
    if (!ve || ve.ifStyle !== vs || ee.ifStyle) throw new Error('veth 連線應帶專用線型，其他連線不變');
    const pats = [vs.dash, ws.dash, T.weakEdge.hearsay.dash, T.weakEdge.inferred.dash, T.edge.oob.dash].map((d) => d.join());
    if (new Set(pats).size !== pats.length) throw new Error('veth、Wi-Fi、單側觀察、推論鏈路與管理線的線型應各不相同');
    const g = App.graph; const ops = recordCanvas(g.ctx, () => g.draw());
    const seg = (id) => { const a = g.pos.get('SW_A'); const b = g.pos.get(id); return ops.filter((o) => o.op === 'stroke' && o.path.length === 2 && near([o.path[0]], a, 0.01) && near([o.path[1]], b, 0.01)); };
    const ratio = (d) => d.map((x) => (x / d[0]).toFixed(3)).join();
    const vStroke = seg(v.id)[0]; const eStroke = seg(e.id)[0];
    if (!vStroke || ratio(vStroke.dash) !== ratio(vs.dash) || vStroke.style !== T.edge[ve.cls].c) throw new Error('veth 連線應以專用線型、連線類別色畫出');
    if (!eStroke || ratio(eStroke.dash) !== ratio(T.weakEdge.hearsay.dash)) throw new Error('一般終端連線應維持單側觀察線型');
    if (!/容器 veth/.test(v.tip)) throw new Error('提示應標示容器 veth');
    if (!Array.from(document.testAll('#legend .li')).some((el) => /容器 veth/.test(el.textContent))) throw new Error('圖例缺少 veth');
  });
  await step('Wi-Fi 介面不列為終端；MAC 位置與單 MAC 有線埠均列入清單', async () => {
    const input = 'SW_A (10.0.0.1):\n### /interface print detail\n'
      + 'Flags: D - DYNAMIC; R - RUNNING; S - SLAVE\n'
      + ' 0  R  name="wifi1" type="wifi" mtu=1500\n'
      + ' 1  R  name="wlan1" type="wlan" mtu=1500\n'
      + ' 2  R  name="ether5" type="ether" mtu=1500\n'
      + '### /interface bridge host print detail\n'
      + ' 0 D mac-address=14:63:93:C4:13:24 on-interface=wifi1 bridge=bridge1\n'
      + ' 1 D mac-address=3C:64:CF:0C:C4:63 on-interface=wifi1 bridge=bridge1\n'
      + ' 2 D mac-address=06:89:53:94:06:0F on-interface=wlan1 bridge=bridge1\n'
      + ' 3 D mac-address=AA:BB:CC:00:00:02 on-interface=ether5 bridge=bridge1\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    if (App.snap.meta.inputHash !== hash) throw new Error('Wi-Fi 基準未建立');
    const wifis = App.snap.model.interfaces.filter((i) => ['wifi1', 'wlan1'].includes(i.name));
    const ethernet = App.snap.model.interfaces.find((i) => i.name === 'ether5');
    const endpoints = App.graph.nodes.filter((n) => n.virtual && n.parent === 'SW_A');
    if (!wifis.every((i) => !i.edge && !i.unknownPeer)) throw new Error('Wi-Fi 介面不應列為終端');
    if (!ethernet || !ethernet.edge || !ethernet.unknownPeer) throw new Error('單 MAC 有線介面應列為終端');
    if (endpoints.length !== 3 || !endpoints.some((n) => n.id === '?p|SW_A|ether5')
      || !endpoints.filter((n) => n.kind === 'downstream').every((n) => n.id === '?p|SW_A|wifi1' || n.id === '?p|SW_A|wlan1')) {
      throw new Error('Wi-Fi 多 MAC 應保留菱形提示，並與單 MAC 有線終端分別呈現');
    }
    const wifiRows = App.Q.inventory().rows.endpoints.filter((r) => r.wifi);
    if (wifiRows.length !== 3 || !wifiRows.every((r) => ['wifi1', 'wlan1'].includes(r.ifc))) throw new Error('Wi-Fi 清單應逐一列出每個 MAC 觀察位置');
  });
  await step('左右欄可拖曳調整寬度，且有下限與上限', async () => {
    const grip = document.querySelector('#left .grip-left'); const rgrip = document.querySelector('#right .grip-right');
    if (!grip || !rgrip) throw new Error('缺少拖曳把手');
    const fire = (t, ev) => (docListeners[t] || []).slice().forEach((f) => f(ev));
    const drag = (g, x0, x1) => { g.dispatch('mousedown', { clientX: x0 }); fire('mousemove', { clientX: x1 }); fire('mouseup', {}); };
    const w0 = App.layout.left; drag(grip, 330, 330 + 100);
    if (App.layout.left !== w0 + 100 || !$('#main').style.gridTemplateColumns.startsWith((w0 + 100) + 'px')) throw new Error('左欄應加寬 100px');
    drag(grip, 500, -5000); if (App.layout.left !== 240) throw new Error('左欄不應小於下限');
    const r0 = App.layout.right; drag(rgrip, 1000, 900);
    if (App.layout.right !== r0 + 100) throw new Error('右欄往左拖應加寬');
    rgrip.dispatch('dblclick'); if (App.layout.right !== 400) throw new Error('雙擊應還原預設寬度');
    grip.dispatch('dblclick');
  });
  await step('鍵盤：畫布可聚焦，N 輪流移到設備、Enter 開啟詳情、Esc 取消選取，方向鍵平移、+／- 縮放', () => {
    const g = App.graph; const cv = $('#graph');
    if (cv.getAttribute('tabindex') !== '0' || !/Enter/.test(cv.getAttribute('aria-label') || '')) throw new Error('畫布應可聚焦，aria-label 說明按鍵');
    const key = (k, extra) => cv.dispatch('keydown', Object.assign({ key: k }, extra || {}));
    cv.focus(); App.select(null);
    const visible = g.nodes.filter((n) => g.visible(n));
    if (visible.length < 2) throw new Error('測試前提：至少兩個可見節點');
    key('n'); const first = g.kbd;
    if (!first || !g.hover || g.hover.id !== first) throw new Error('按 N 應移到一台設備，並以滑過樣式標示');
    if ($('#tooltip').classList.contains('hidden') || !text('#graph-live')) throw new Error('鍵盤移到設備時應顯示提示，並讀給螢幕閱讀器');
    key('n'); const second = g.kbd;
    if (second === first) throw new Error('再按 N 應移到下一台');
    key('N', { shiftKey: true }); if (g.kbd !== first) throw new Error('Shift+N 應回到上一台');
    const seen = new Set(); for (let i = 0; i < visible.length; i++) { key('n'); seen.add(g.kbd); }
    if (seen.size !== visible.length) throw new Error('N 應能輪流走過每一台可見的設備');
    key('Enter');
    const n = g.nodeById.get(g.kbd);
    if (!App.sel) throw new Error('Enter 應選取設備並開啟詳情');
    if (!n.virtual && (App.sel.type !== 'device' || App.sel.key !== n.id || !text('#detail').includes(App.Q.getDevice(n.id).name))) throw new Error('Enter 應開啟這台設備的詳情');
    key('Escape'); if (App.sel || g.kbd || g.hover) throw new Error('Esc 應取消選取');
    const t0 = { tx: g.tx, ty: g.ty, s: g.s };
    key('ArrowRight'); if (!(g.tx < t0.tx)) throw new Error('方向鍵應平移畫面');
    key('ArrowDown'); if (!(g.ty < t0.ty)) throw new Error('方向鍵應平移畫面');
    key('+'); if (!(g.s > t0.s)) throw new Error('+ 應放大'); const s1 = g.s;
    key('-'); if (!(g.s < s1)) throw new Error('- 應縮小');
    let prevented = false; cv.dispatch('keydown', { key: 'n', ctrlKey: true, preventDefault() { prevented = true; } });
    if (prevented) throw new Error('帶 Ctrl 的按鍵應交給瀏覽器');
    key('0');
  });
  await step('Pointer 事件：滑鼠拖曳節點與平移、觸控點選與點兩下', () => {
    const g = App.graph; const cv = $('#graph');
    const fire = (t, target, p, extra) => (winListeners[t] || []).forEach((f) => f(Object.assign({ target, clientX: p.x, clientY: p.y, pointerId: 1, pointerType: 'mouse', button: 0, preventDefault() {} }, extra || {})));
    const down = (p, extra) => cv.dispatch('pointerdown', Object.assign({ clientX: p.x, clientY: p.y, pointerId: 1, pointerType: 'mouse', button: 0 }, extra || {}));
    const n = g.nodes.find((x) => g.visible(x) && !x.virtual); const p0 = g.toScreen(g.pos.get(n.id)); const w0 = Object.assign({}, g.pos.get(n.id));
    let moved = null; const oldMoved = g.handlers.moved; g.on('moved', (id) => { moved = id; });
    try {
      down(p0); fire('pointermove', cv, { x: p0.x + 50, y: p0.y + 30 }); fire('pointerup', cv, { x: p0.x + 50, y: p0.y + 30 });
      const w1 = g.pos.get(n.id);
      if (moved !== n.id || Math.abs(w1.x - w0.x - 50 / g.s) > 0.01 || Math.abs(w1.y - w0.y - 30 / g.s) > 0.01) throw new Error('拖曳節點應移動節點並通知儲存位置');
      g.pos.set(n.id, w0);
      const empty = { x: -5000, y: -5000 }; const tx = g.tx; moved = null;
      down(empty); fire('pointermove', cv, { x: empty.x + 40, y: empty.y }); fire('pointerup', cv, { x: empty.x + 40, y: empty.y });
      if (Math.abs(g.tx - tx - 40) > 0.01 || moved) throw new Error('拖曳背景應平移畫面，不移動節點');
      // 觸控：點一下選取（命中範圍較大），點兩下等同雙擊；沒有 hover
      App.select(null); const touch = { pointerType: 'touch', pointerId: 7 };
      const near = { x: p0.x + g.radius(n) * g.s + 8, y: p0.y };
      fire('pointermove', cv, near, touch); if (g.hover && g.hover.id === n.id) throw new Error('觸控不應觸發 hover');
      down(near, touch); fire('pointerup', cv, near, Object.assign({ timeStamp: 1000 }, touch));
      if (!App.sel || App.sel.key !== n.id) throw new Error('觸控點一下應選取設備（命中範圍包含節點外側一點）');
      let dbl = null; const oldDbl = g.handlers.dblclick; g.on('dblclick', (it) => { dbl = it; });
      try {
        down(near, touch); fire('pointerup', cv, near, Object.assign({ timeStamp: 1200 }, touch));
        if (!dbl || dbl.id !== n.id) throw new Error('觸控快速點兩下應等同雙擊');
      } finally { g.on('dblclick', oldDbl); }
      App.select(null);
    } finally { g.on('moved', oldMoved); }
  });
  await step('焦點框、篩選選項按鈕、強制色彩與減少動態效果', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8'); const v = cssVars(css);
    // 焦點框的顏色（var() 展開後）對白底與表面色 ≥ 3:1
    const ring = v['focus-ring'].replace(/var\(--([\w-]+)\)/g, (_, n) => v[n]);
    const colors = (ring.match(/#[0-9a-fA-F]{6}|rgba?\([^)]*\)/g) || []);
    const outer = colors[colors.length - 1];
    if (!outer || ['#ffffff', v.surface].some((bg) => contrastOf(outer, bg) < 3)) throw new Error('焦點框對底色應 ≥ 3:1：' + ring);
    if (!/#graph:focus-visible\s*\{[^}]*outline:/.test(css)) throw new Error('畫布取得焦點時應有明顯的焦點框');
    if (!/@media \(forced-colors: active\)/.test(css)) throw new Error('應支援強制色彩模式');
    if (!/#graph\s*\{[^}]*touch-action:\s*none/.test(css)) throw new Error('畫布應自己處理觸控拖曳');
    // 篩選選項是可聚焦的按鈕
    App.select(null); goStep('triage');
    const chips = $('#pane-findings').querySelector('.summary').testAll('.chip');
    if (!chips.length || !chips.every((c) => c.tagName === 'BUTTON' && c.getAttribute('type') === 'button')) throw new Error('篩選選項應是 <button>');
    // 減少動態效果：力導向一次算完，不排動畫
    const g = App.graph; const before = JSON.stringify(Array.from(g.pos)); const oldMM = window.matchMedia;
    window.matchMedia = (q) => ({ matches: /prefers-reduced-motion:\s*reduce/.test(q) });
    try {
      rafQ = []; $('#btn-force').click();
      if ($('#btn-force').classList.contains('on') || rafQ.length) throw new Error('減少動態效果時不應播放力導向動畫');
      if (JSON.stringify(Array.from(g.pos)) === before) throw new Error('減少動態效果時應直接套用力導向的結果');
    } finally { if (oldMM) window.matchMedia = oldMM; else delete window.matchMedia; }
  });
  await step('畫布：先填滿 theme 的底色（PNG 不透明）、字型與 CSS 一致、過長標籤截斷', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8'); const v = cssVars(css); const T = S.view.theme; const g = App.graph;
    if (v.surface !== T.canvas.surface) throw new Error('theme.canvas.surface 應與 --surface 相同');
    const bodyFont = (css.match(/(?:^|\n)body\s*\{[^}]*font:\s*\S+\s+([^;]+);/) || [])[1]; // font: 字級/行高 字型清單
    if (!bodyFont || bodyFont.trim() !== T.font.ui) throw new Error('畫布字型應與 body 相同：' + bodyFont);
    if (v.mono !== T.font.mono) throw new Error('畫布等寬字型應與 --mono 相同');
    const long = '很長的設備名稱'.repeat(8) + '-END';
    const nodes = [{ id: 'fx-a', label: long, kind: 'router', collected: true, group: 't' }, { id: 'fx-b', label: 'short', kind: 'router', collected: true, group: 't' }];
    withGraph(g, nodes, [{ id: 'fx-e', a: 'fx-a', b: 'fx-b', cls: '1g', count: 1, evidence: 'adjacency', labelA: 'ether1', labelB: 'ether2' }],
      new Map([['fx-a', { x: 0, y: 0 }], ['fx-b', { x: 600, y: 0 }]]), () => {
        g.s = 1.5; const ops = recordCanvas(g.ctx, () => g.draw());
        const bg = ops.find((o) => o.op === 'rect');
        if (!bg || ops.indexOf(bg) !== 0 || bg.style !== T.canvas.surface || bg.w < g.w || bg.h < g.h) throw new Error('繪圖應先以 theme 的畫布底色填滿畫面');
        const texts = ops.filter((o) => o.op === 'text');
        const cut = texts.find((o) => o.text.endsWith('…'));
        if (!cut || cut.text.length >= long.length || !long.startsWith(cut.text.slice(0, -1))) throw new Error('過長的標籤應截斷並加上「…」');
        if (!texts.some((o) => o.text === 'short')) throw new Error('短標籤不應截斷');
        if (!texts.every((o) => String(o.font).includes(T.font.ui) || String(o.font).includes(T.font.mono))) throw new Error('畫布文字應使用 theme 的字型清單');
      });
    // 匯出 PNG：匯出前重畫（畫面已有底色）
    let drew = 0; const oldDraw = g.draw; g.draw = function () { drew++; return oldDraw.call(this); };
    try { await captureDownloads(() => $('#btn-png').click()); } finally { g.draw = oldDraw; }
    if (!drew) throw new Error('匯出 PNG 前應重畫畫布');
  });
  await step('滑過左右欄與工具列時不會穿透觸發拓樸圖 hover', () => {
    const g = App.graph; const cv = $('#graph');
    const move = (target, p) => (winListeners.pointermove || []).forEach((f) => f({ target, clientX: p.x, clientY: p.y, pointerType: 'mouse' }));
    const n = g.nodes.find((x) => g.visible(x)); const p = g.toScreen(g.pos.get(n.id));
    move(cv, p); if (!g.hover || g.hover.id !== n.id) throw new Error('畫布上的節點應可 hover');
    [$('#left'), $('#right'), $('#btn-fit')].forEach((el) => {
      move(el, p);
      if (g.hover) throw new Error(`指標在 #${el.id} 上時不應 hover 到底下的節點`);
      if (!$('#tooltip').classList.contains('hidden')) throw new Error('指標離開畫布時提示應隱藏');
    });
  });
  await step('流程步驟：①–⑤ 都能切換（nav、aria-current="step"），左側清單與中間的工作畫面跟著換、焦點移到這一步的標題；切換不丟失畫布的位置、縮放與選取，也不重新排列；PNG 照常', async () => {
    const g = App.graph; const VA = S.view.app;
    const nav = $('#steps'); const btns = document.testAll('#steps button');
    if (nav.tagName !== 'NAV' || nav.getAttribute('aria-label') !== '流程步驟' || !nav.querySelector('ol')) throw new Error('流程步驟應是有名稱的 nav（ol 列出步驟）');
    if (btns.map((b) => b.dataset.step).join() !== 'input,view,triage,fix,verify') throw new Error('步驟應依序是 ① 輸入 ② 檢視 ③ 分診 ④ 修正 ⑤ 驗證：' + btns.map((b) => b.textContent).join('、'));
    if (!btns.every((b) => b.getAttribute('type') === 'button' && b.getAttribute('tabindex') === null && /^[①②③④⑤]/.test(b.textContent))) throw new Error('每一步是可以 Tab 到的按鈕，文字以步驟號碼開頭');
    if (document.testAll('#center-views').length || document.testAll('#left .tabs').length) throw new Error('左側五個分頁與中間的分頁已由流程步驟取代');
    // 每一步的左側清單與中間的工作畫面（④、⑤ 沒有左側清單，中間全寬）
    const EXPECT = { view: ['pane-inventory', 'graph', '清單'], triage: ['pane-findings', 'graph', '檢查結果'], fix: [null, 'patch'], verify: [null, 'verify'] };
    const check = (s) => {
      const cur = btns.filter((b) => b.getAttribute('aria-current') === 'step');
      if (cur.length !== 1 || cur[0] !== stepBtn(s) || !btns.every((b) => ['step', 'false'].includes(b.getAttribute('aria-current')))) throw new Error('只有目前的一步是 aria-current="step"：' + s);
      if (!stepBtn(s).classList.contains('on')) throw new Error('目前的一步應有選取的樣式');
      if (s === 'input') {
        if ($('#hub').classList.contains('hidden') || document.activeElement !== $('#hub-title') || !$('#main').inert) throw new Error('① 輸入是資料中心：開啟、聚焦標題、主畫面 inert');
        return;
      }
      if (!$('#hub').classList.contains('hidden') || $('#main').inert) throw new Error('換到 ②–⑤ 時應關閉資料中心');
      const [left, center, title] = EXPECT[s];
      if (App.step !== s || App.centerView !== center || $('#center').dataset.view !== center || $('#main').dataset.step !== s) throw new Error(`${s} 的中間應是 ${center}`);
      if ($('#left').classList.contains('hidden') !== !left) throw new Error(`${s} 的左側清單應${left ? '顯示' : '隱藏'}`);
      ['pane-findings', 'pane-inventory'].forEach((id) => { if ($('#' + id).classList.contains('hidden') !== (id !== left)) throw new Error(`${s} 的左側應只顯示 ${left}`); });
      if (left && $('#left-title').textContent !== title) throw new Error(`${s} 的左側標題應是「${title}」`);
      ['patch', 'verify'].forEach((x) => { if ($('#view-' + x).classList.contains('hidden') !== (x !== center)) throw new Error('只顯示目前的工作畫面：' + x); });
      if (!!$('#view-graph').inert !== (center !== 'graph')) throw new Error('工作畫面蓋住拓樸圖時，拓樸圖應是 inert');
      if ($('#view-graph').classList.contains('hidden')) throw new Error('拓樸圖不可隱藏（display: none 會讓畫布變成 0 大小）');
      if (!$('#main').style.gridTemplateColumns.startsWith(left ? App.layout.left + 'px' : '0px')) throw new Error('沒有左側清單時左欄寬度為 0：' + $('#main').style.gridTemplateColumns);
      const focusTo = left ? $('#left-title') : $('#' + center + '-title');
      if (document.activeElement !== focusTo) throw new Error(`點 ${s} 後焦點應移到這一步的標題`);
    };
    // 先在圖上留下狀態：選取一台設備、平移與縮放、移動一個節點
    const dev = App.Q.devices().find((d) => g.nodeById.has(d.key));
    App.select({ type: 'device', key: dev.key });
    g.s = 1.37; g.tx = 123; g.ty = -45; const moved = { x: 777, y: 333 }; g.pos.set(dev.key, moved);
    const snapState = () => JSON.stringify({ s: g.s, tx: g.tx, ty: g.ty, pos: Array.from(g.pos), sel: App.sel, nodes: Array.from(g.sel.nodes), w: g.w, h: g.h, n: g.nodes.length });
    const before = snapState();
    // 切換期間不可重新排列或全圖（spy：版面計算、fit、ELK）
    const calls = []; const spy = (obj, k) => { const o = obj[k]; obj[k] = function (...a) { calls.push(k); return o.apply(this, a); }; return () => { obj[k] = o; }; };
    const undo = [spy(S.view.layout, 'layout'), spy(g, 'fit'), spy(VA, 'applyElk'), spy(VA, 'relayout')];
    try {
      // 每一步都能切換（含從資料中心直接到其他步、同一步再點一次）；鍵盤的 Enter／空白鍵在按鈕上就是 click
      ['input', 'view', 'triage', 'fix', 'verify', 'triage', 'input', 'fix', 'fix', 'verify', 'input', 'view'].forEach((s) => { goStep(s); check(s); });
      // 資料中心的「回到…」與 Esc：回到開啟前的那一步，焦點回到開啟它的步驟按鈕
      goStep('input');
      if (!hubBtn('close-hub').textContent.includes('② 檢視')) throw new Error('資料中心的關閉按鈕應寫出要回到哪一步：' + hubBtn('close-hub').textContent);
      (docListeners.keydown || []).forEach((f) => f({ key: 'Escape', preventDefault() {} }));
      if (!$('#hub').classList.contains('hidden') || App.step !== 'view' || document.activeElement !== stepBtn('input') || stepBtn('view').getAttribute('aria-current') !== 'step') throw new Error('Esc 關閉資料中心後應回到 ② 檢視，焦點回到 ① 的按鈕');
      // PNG：在工作畫面也匯出同一張圖（畫布沒有被隱藏，大小不變）
      App.showStep('verify');
      let drew = 0; const oldDraw = g.draw; g.draw = function () { drew++; return oldDraw.call(this); };
      const made = []; const oldCreate = document.createElement;
      document.createElement = (t) => { const el = oldCreate(t); if (t === 'a') made.push(el); return el; };
      try { VA.exportPng(); } finally { g.draw = oldDraw; document.createElement = oldCreate; }
      if (!drew || made.length !== 1 || made[0].download !== 'topology.png' || !String(made[0].href).startsWith('data:')) throw new Error('在工作畫面時也應能匯出拓樸 PNG（同一張畫布）');
      App.showView('graph');
    } finally { undo.forEach((f) => f()); }
    if (calls.length) throw new Error('切換步驟不應重新排列或全圖：' + calls.join('、'));
    if (snapState() !== before) throw new Error('切換步驟後畫布的位置、縮放與選取應保留');
    // 從其他地方開啟（App.showView）：patch 是 ④，trend、compare 是 ⑤ 的區塊；graph 回到上一次看圖的那一步（這裡是 ②）
    App.showView('trend', { focus: true }); if (App.step !== 'verify' || document.activeElement !== $('#trend-title')) throw new Error('開啟收斂趨勢時應到 ⑤，焦點移到收斂趨勢的標題');
    App.showView('compare', { focus: true }); if (App.step !== 'verify' || document.activeElement !== $('#compare-title')) throw new Error('開啟比對時應到 ⑤，焦點移到比對的標題');
    App.showView('patch', { focus: true }); if (App.step !== 'fix' || document.activeElement !== $('#patch-title')) throw new Error('開啟修正計畫時應到 ④，焦點移到標題');
    App.showView('graph', { focus: true }); if (App.step !== 'view' || document.activeElement !== $('#graph')) throw new Error('回到拓樸圖時應回到上一次看圖的 ②，焦點移到畫布');
    try { App.showStep('nope'); throw new Error('未知的步驟應丟出 RangeError'); } catch (e) { if (!(e instanceof RangeError)) throw e; }
    // 在工作畫面點選設備：詳情在右側，工作畫面不切換；搜尋是在圖上定位，會切回拓樸圖
    goStep('triage'); App.showStep('verify'); App.select({ type: 'device', key: dev.key });
    if (App.centerView !== 'verify' || !text('#detail').includes(dev.name)) throw new Error('在工作畫面選取時，右側顯示詳情、工作畫面不切換');
    const inp = $('#search'); inp.value = dev.name; inp.dispatch('input'); await new Promise((r) => setTimeout(r, 150));
    inp.dispatch('keydown', { key: 'Enter' });
    if (App.centerView !== 'graph' || App.step !== 'triage' || !App.sel) throw new Error('搜尋選取後應回到上一次看圖的 ③');
    // 資料中心開著時切換工作畫面：先關閉資料中心
    App.openHub(); App.showView('patch');
    if (!$('#hub').classList.contains('hidden') || App.centerView !== 'patch') throw new Error('切到工作畫面時應關閉資料中心');
    // 窄螢幕：工作區依流程排列（清單 → 工作畫面 → 詳細資料），標籤跟著步驟；有清單的步驟先看清單，④、⑤ 看工作畫面
    window.innerWidth = 390;
    const ws = () => document.testAll('#mobile-workspaces button');
    if (ws().map((b) => b.dataset.workspace).join() !== 'checks,graph,details') throw new Error('窄螢幕的工作區應依流程排列：清單、工作畫面、詳細資料');
    goStep('triage'); if ($('#main').dataset.workspace !== 'checks' || ws()[0].textContent !== '檢查結果' || ws()[1].textContent !== '拓樸圖') throw new Error('窄螢幕的 ③ 應先顯示檢查結果');
    goStep('view'); if ($('#main').dataset.workspace !== 'checks' || ws()[0].textContent !== '清單') throw new Error('窄螢幕的 ② 應先顯示清單');
    goStep('fix'); if ($('#main').dataset.workspace !== 'graph' || !ws()[0].classList.contains('hidden') || ws()[1].textContent !== '修正計畫') throw new Error('窄螢幕的 ④ 沒有清單，顯示修正計畫');
    VA.setWorkspace('checks'); if ($('#main').dataset.workspace !== 'graph') throw new Error('沒有左側清單時不能切到清單工作區');
    VA.setWorkspace('details'); App.showView('compare');
    if ($('#main').dataset.workspace !== 'graph' || ws()[1].textContent !== '驗證') throw new Error('窄螢幕切到工作畫面時應顯示中間的工作區');
    window.innerWidth = 1200; goStep('triage'); VA.setWorkspace('graph'); App.showView('graph');
    // CSS：工作畫面疊在拓樸圖上、不水平捲動；寬表格在自己的框內捲動；強制色彩下目前的一步有系統色外框
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    if (!/\.work \{[^}]*position: absolute[^}]*overflow-x: hidden/.test(css)) throw new Error('工作畫面應疊在拓樸圖上，且不水平捲動');
    if (!/\.work-table \{[^}]*overflow-x: auto/.test(css)) throw new Error('寬的表格應在自己的框內捲動');
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    if (!/\.steps button\[aria-current="step"\]/.test(forced.slice(0, forced.indexOf('\n}')))) throw new Error('強制色彩模式下目前的一步應有系統色外框');
    // 步驟的文字色對底色 ≥ 4.5:1：目前的一步（強調色／淺強調底）、其他步驟（次要文字色／頁首白底）
    const cv = cssVars(css);
    [[cv.accent, cv['accent-soft']], [cv.muted, '#ffffff'], [cv.text, cv['surface-hover']]].forEach(([fg, bg]) => {
      if (contrastOf(fg, bg) < 4.5) throw new Error(`步驟的文字 ${fg} 對 ${bg} 只有 ${contrastOf(fg, bg).toFixed(2)}:1`);
    });
    // 目前的一步不只靠顏色：粗體與底線
    if (!/\.steps button\[aria-current="step"\] \{[^}]*font-weight: 700[^}]*box-shadow: inset 0 -2px/.test(css)) throw new Error('目前的一步除了顏色，還要有粗體與底線');
    if (!/\.patch-layout \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/.test(css) || !/\.verify-layout \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/.test(css) || !/@container \(min-width: \d+px\)/.test(css)) throw new Error('修正計畫與驗證預設單欄，工作畫面夠寬時才分兩欄');
    // 窄螢幕的步驟列：五步等寬、可以換行（不出現水平捲動），放在一般樣式之後
    const narrow = css.slice(css.indexOf('@media (max-width: 900px)'));
    if (!/\.steps ol \{ display: grid; grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/.test(narrow) || !/\.steps button \{[^}]*white-space: normal/.test(narrow)) throw new Error('窄螢幕時步驟列應五步等寬且可換行');
  });
  await step('每一項舊功能都還找得到（左側五個分頁、中間四個分頁 → 流程步驟）', () => {
    // [舊位置, 新的一步, 檢查新位置有這個功能]
    const has = (sel, what) => { const el = $(sel); if (!el || !el.textContent.trim()) throw new Error(what + '：' + sel + ' 沒有內容'); return el; };
    const visible = (el) => { for (let x = el; x && x !== document.body; x = x.parentNode) if (x.classList && x.classList.contains('hidden')) return false; return true; };
    const MOVES = [
      ['左：檢查結果（篩選、分組、處理、匯出報表、修正計畫的入口）', 'triage', () => {
        const p = has('#pane-findings', '檢查結果');
        if (!p.querySelector('.findings-view') || !p.querySelector('.open-hub') || !p.querySelector('.open-patch') || !p.testAll('.fgroup').length) throw new Error('檢查結果的篩選與入口');
        return p; }],
      ['左：覆蓋率（每台設備、缺漏與收集失敗、devices.csv 草稿）', 'input', () => {
        const p = has('#pane-coverage', '覆蓋率');
        if (!$('#hub').contains(p) || !p.querySelector('table') || !hubBtn('devices-csv') || !hubBtn('open-coverage')) throw new Error('覆蓋率在資料中心，有表格與 devices.csv 草稿');
        return p; }],
      ['左：清單（設備、介面、IP、網段、MAC、VLAN）', 'view', () => { const p = has('#pane-inventory', '清單'); if (p.querySelector('.seg').testAll('button').length !== 6) throw new Error('清單的六種'); return p; }],
      ['左：比對（摘要與入口）→ 驗證的比對與資料中心的摘要', 'verify', () => {
        const p = has('#compare-body', '比對');
        if (!p.querySelector('.cmp-expected') || !p.querySelector('.cmp-baseline') || !p.querySelector('.cmp-load-expected') || !p.querySelector('.cmp-load-previous')) throw new Error('預期資料比對與新舊基準比對');
        if (!$('#hub').testAll('.hub-row').some((r) => r.getAttribute('data-item') === 'previous') || !hubBtn('load-expected')) throw new Error('資料中心的比對摘要與載入');
        return p; }],
      ['左：處理紀錄的本輪變化', 'verify', () => has('#round-body', '本輪變化')],
      ['左：處理紀錄的修復追蹤', 'verify', () => has('#tracking-body', '修復追蹤')],
      ['左：處理紀錄的各狀態筆數與匯出／匯入的入口', 'verify', () => {
        const p = has('#ledger-body', '處理紀錄');
        if (!p.querySelector('.ledger-counts') || !p.querySelector('.open-hub') || !hubBtn('export-ledger') || !hubBtn('import-ledger')) throw new Error('處理紀錄的筆數與匯出／匯入');
        return p; }],
      ['中：拓樸圖（層級切換、VLAN 篩選）', 'view', () => { if (!visible($('#layer-switch')) || $('#view-graph').inert) throw new Error('② 的拓樸圖與層級切換'); return $('#layer-switch'); }],
      ['中：拓樸圖（③ 也看得到層級切換）', 'triage', () => { if (!visible($('#layer-switch')) || $('#view-graph').inert) throw new Error('③ 的拓樸圖與層級切換'); return $('#layer-switch'); }],
      ['中：修正計畫', 'fix', () => { const p = has('#patch-body', '修正計畫'); if (!p.querySelector('.patch-select') || !p.querySelector('.patch-main')) throw new Error('修正計畫的選取與計畫'); return p; }],
      ['中：比對', 'verify', () => has('#compare-body', '比對')],
      ['中：收斂趨勢', 'verify', () => { const p = has('#trend-body', '收斂趨勢'); if (!p.testAll('.trend-tile').length) throw new Error('收斂趨勢的數字'); return p; }],
    ];
    MOVES.forEach(([old, s, find]) => {
      goStep(s);
      let el; try { el = find(); } catch (e) { throw new Error(`「${old}」在 ${S.view.app.STEP_LABEL[s]} 找不到：${e.message}`); }
      if (!visible(el)) throw new Error(`「${old}」在 ${S.view.app.STEP_LABEL[s]} 應看得到`);
    });
    goStep('triage');
  });
  await step('步驟的狀態會隨資料更新（文字，不只靠顏色）', async () => {
    const VA = S.view.app; const NUM = S.view.num; const st = (s) => stepBtn(s).querySelector('.step-st').textContent;
    const m = App.Q.meta();
    if (st('input') !== `${NUM(m.stats.collected)} 台`) throw new Error('① 應寫出已收集的台數：' + st('input'));
    const pc0 = VA.problemCounts();
    if (st('triage') !== `待處理 ${NUM(pc0.error + pc0.warn)}`) throw new Error('③ 應寫出待處理筆數：' + st('triage'));
    if (!st('verify').startsWith(`第 ${NUM(VA.ledgerRoundIndex() + 1)} 輪`)) throw new Error('⑤ 應寫出處理紀錄的第幾輪：' + st('verify'));
    // ②：拓樸圖的層級
    if (st('view') !== S.view.LAYER[App.layer]) throw new Error('② 應寫出目前的層級：' + st('view'));
    App.showLayer('l3'); await App.layerJob;
    if (st('view') !== S.view.LAYER.l3) throw new Error('換層級後 ② 的狀態應更新：' + st('view'));
    App.showLayer('device');
    // ④：修正計畫已選的項目數
    App.openPatch(); const PV = S.view.patchView;
    if (PV.state.keys.size) $('#patch-body').querySelector('.patch-clear').click();
    if (st('fix') !== '已選 0') throw new Error('④ 應寫出已選的項目數：' + st('fix'));
    const rule = $('#patch-body').testAll('.patch-rule')[0]; rule.click();
    if (!PV.state.keys.size || st('fix') !== `已選 ${NUM(PV.state.keys.size)}`) throw new Error('選取後 ④ 的狀態應更新：' + st('fix'));
    $('#patch-body').querySelector('.patch-clear').click();
    if (st('fix') !== '已選 0') throw new Error('清除選取後 ④ 的狀態應更新');
    // ③：把一筆待處理的錯誤／警告標為誤報後，待處理減一（處理紀錄是使用者的資料，結束後還原）
    const keep = JSON.parse(JSON.stringify(VA.ledger()));
    const f = App.Q.findings().find((x) => x.severity !== 'info' && S.view.remediation.isPendingStatus(VA.ledgerStatus(x)) && (S.ledger.USER_TO[VA.ledgerItem(x).status] || []).includes('false-positive'));
    if (f) {
      const r = await App.setLedger(f, { status: 'false-positive' });
      if (!r.ok) throw new Error('應可標為誤報：' + r.error);
      const pc1 = VA.problemCounts();
      if (pc1.error + pc1.warn !== pc0.error + pc0.warn - 1 || st('triage') !== `待處理 ${NUM(pc1.error + pc1.warn)}`) throw new Error('標為誤報後 ③ 的待處理應減一：' + st('triage'));
      await S.store.set('ledger', keep); await VA.loadLedger(); VA.renderAll();
      if (st('triage') !== `待處理 ${NUM(pc0.error + pc0.warn)}`) throw new Error('還原處理紀錄後 ③ 應回到原本的筆數');
    } else if (!process.env.SMOKE_INPUT) throw new Error('範例資料應有可標為誤報的待處理項目');
    App.showView('graph');
  });
  await step('資料中心：列出這一輪所有的輸入與輸出與各自的狀態，鍵盤可開關（Esc 關閉後焦點回到按鈕），蓋住主畫面時主畫面不可聚焦', async () => {
    const VA = S.view.app; const NUM = S.view.num; const btnHub = $('#btn-hub');
    if (!btnHub || $('#btn-input')) throw new Error('頁首應有「資料中心」，建立基準改由資料中心的「讀入收集檔…」進入');
    btnHub.click();
    if ($('#hub').classList.contains('hidden') || btnHub.getAttribute('aria-expanded') !== 'true') throw new Error('按「資料中心」應開啟資料中心');
    if (document.activeElement !== $('#hub-title')) throw new Error('開啟後焦點應移到資料中心的標題');
    if (!$('#main').inert || !$('#app').classList.contains('hub-open')) throw new Error('資料中心開啟時主畫面應是 inert（鍵盤不會跑到被蓋住的圖上）');
    const row = (k) => $('#hub').testAll('.hub-row').find((r) => r.getAttribute('data-item') === k);
    ['sources', 'previous', 'ledger', 'profile', 'expected-data', 'expected', 'coverage'].forEach((k) => {
      const r = row(k);
      if (!r) throw new Error('資料中心應列出輸入：' + k);
      const stx = r.querySelector('.hub-st');
      if (!stx || !stx.textContent.trim()) throw new Error(`${k} 應有狀態文字（不只靠顏色）`);
      if (/hub-st-(ok|warn|err)/.test(stx.className) && !/^[✓!✗] /.test(stx.textContent)) throw new Error(`${k} 的狀態色應搭配符號`);
    });
    ['read-workpack', 'read-sources', 'load-previous', 'import-ledger', 'change-profile', 'load-expected', 'devices-csv',
      'download-workpack', 'export-snapshot', 'export-ledger', 'open-patch', 'export-markdown', 'export-csv', 'by-device', 'export-png', 'export-devices-csv', 'export-expected']
      .forEach((a) => { if (!hubBtn(a)) throw new Error('資料中心缺少入口：' + a); });
    // 狀態和目前的資料一致（依關係，不寫死筆數）
    const m = App.Q.meta();
    if (!row('sources').textContent.includes(`已收集 ${NUM(m.stats.collected)} 台`)) throw new Error('收集檔應列出已收集的台數：' + row('sources').textContent);
    const idx = VA.ledgerRoundIndex();
    if (idx < 0 || !row('ledger').textContent.includes(`第 ${NUM(idx + 1)} 輪`)) throw new Error('處理紀錄應列出目前是第幾輪：' + row('ledger').textContent);
    if (!row('profile').textContent.includes(m.profile ? '已套用' : '未套用')) throw new Error('命名規則的狀態應依基準');
    const rep = S.view.lists.compare.report(App);
    if (!!App.round.expected !== !row('expected').textContent.includes('未載入')) throw new Error('預期資料的狀態應依是否載入');
    if (rep && !rep.errors.length && !row('expected').textContent.includes('已比對')) throw new Error('預期資料載入後應列出比對結果');
    const nC01 = App.Q.findingsByRule('C01').length;
    if ((hubBtn('devices-csv').getAttribute('disabled') !== null) !== !nC01) throw new Error('沒有 C01 時 devices.csv 草稿應停用');
    // 工作包的角色：收集檔與基準一定放（不能取消）；命名規則用過就一定放
    const roleBox = (r) => $('#hub').testAll('.hub-pack-role').find((x) => x.getAttribute('data-role') === r);
    ['source', 'snapshot'].forEach((r) => { const cb = roleBox(r); if (!cb || !cb.checked || !cb.disabled) throw new Error(r + ' 是工作包的必要內容，應勾選且不能取消'); });
    if (App.round.profile && (!roleBox('profile').checked || !roleBox('profile').disabled)) throw new Error('基準用了命名規則時，命名規則一定要放進工作包');
    // 勾選可選的角色後，焦點留在同一個核取方塊（重繪不會讓鍵盤跳回開頭）
    const lgBox = roleBox('ledger'); lgBox.focus(); lgBox.checked = false; lgBox.dispatch('change');
    if (roleBox('ledger').checked || document.activeElement !== roleBox('ledger')) throw new Error('取消勾選後應保持取消，焦點留在同一個核取方塊');
    roleBox('ledger').checked = true; roleBox('ledger').dispatch('change');
    // Esc 關閉，焦點回到頁首的按鈕
    (docListeners.keydown || []).forEach((f) => f({ key: 'Escape', preventDefault() {} }));
    if (!$('#hub').classList.contains('hidden') || document.activeElement !== btnHub || $('#main').inert || btnHub.getAttribute('aria-expanded') !== 'false') throw new Error('Esc 應關閉資料中心並把焦點還給按鈕');
    // 檢查結果分頁的「匯出報表…」開啟資料中心的報表區塊
    goStep('triage');
    $('#pane-findings').querySelector('.open-hub').click();
    if ($('#hub').classList.contains('hidden') || document.activeElement !== $('#hub-sec-reports')) throw new Error('「匯出報表…」應開啟資料中心並聚焦報表');
    // 選取（例如從搜尋進來）要在圖與詳情看到結果：關閉資料中心
    App.select({ type: 'device', key: App.Q.devices()[0].key });
    if (!$('#hub').classList.contains('hidden')) throw new Error('選取設備後應關閉資料中心');
    // 窄螢幕：資料中心的列與輸出卡片改成單欄（覆蓋一般樣式，所以要寫在它之後），不產生水平捲動
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    const base = css.indexOf('.hub-row { display: grid;'); const narrow = css.lastIndexOf('@media (max-width: 900px)');
    const tail = css.slice(narrow);
    if (base < 0 || narrow < base || !/\.hub-row \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(tail) || !/\.hub-outs \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(tail)) throw new Error('窄螢幕時資料中心應改成單欄，且規則要在一般樣式之後');
    if (!/\.hub \{[^}]*overflow-x: hidden/.test(css)) throw new Error('資料中心不應水平捲動');
  });
  await step('工作包：下載後讀回，基準、處理紀錄、命名規則與預期資料都帶回；壞掉的工作包列出全部問題，目前的資料不變', async () => {
    const VA = S.view.app; const WP = S.workpack; const HS = () => VA.hubState(); const deep = require('assert').deepStrictEqual;
    // 這一輪：範例資料（或 SMOKE_INPUT）＋命名規則
    const input = process.env.SMOKE_INPUT ? fs.readFileSync(process.env.SMOKE_INPUT, 'utf8') : S.samples['sample-bundle.txt'];
    const pid = Object.keys(S.profiles).find((k) => S.profiles[k] && S.profiles[k].id);
    if (!pid) throw new Error('測試前提：應有內建的命名規則');
    await App.openInput(); $('#input-profile').value = pid; $('#input-text').value = input + '\n# workpack\n'; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input + '\n# workpack\n');
    await until(() => App.snap && App.snap.meta.inputHash === hash && App.round.profile === S.profiles[pid], '建立有命名規則的基準');
    await App.layoutJob; await App.ledgerJob;
    if (!App.snap.meta.profile) throw new Error('測試前提：基準應套用命名規則');
    // 處理紀錄改一筆備註；載入預期資料（比對用）；修正計畫選一條可產生指令的規則
    const f0 = App.snap.findings.find((f) => VA.ledgerItem(f));
    if ((await App.setLedger(f0, { note: '工作包測試' })).ok !== true) throw new Error('應可寫入處理紀錄');
    App.openHub('inputs');
    const expInput = $('#hub').querySelector('.hub-file-expected');
    expInput.files = [{ name: 'expected-sample.json', text: async () => fs.readFileSync(path.join(ROOT, 'samples/expected-sample.json'), 'utf8') }];
    expInput.dispatch('change', { target: expInput });
    await until(() => App.round.expected && App.round.expected.name === 'expected-sample.json', '載入預期資料');
    App.openPatch();
    if (!$('#hub').classList.contains('hidden') || !S.view.patchView.isOpen(App)) throw new Error('從資料中心開啟修正計畫時應關閉資料中心，修正計畫在中間');
    const auto = $('#patch-body').testAll('.patch-rule').find((c) => c.getAttribute('data-level') === 'auto');
    if (auto) auto.click();
    App.showView('graph');
    App.openHub('outputs');
    const patchBox = $('#hub').testAll('.hub-pack-role').find((x) => x.getAttribute('data-role') === 'patch');
    if (!!auto !== patchBox.checked) throw new Error('修正計畫有選取時 patch 才放進工作包');
    // 下載：按鈕開始後立刻顯示忙碌提示並停用操作，完成後下載一個 ZIP
    const { files } = await captureDownloads(async () => {
      hubBtn('download-workpack').click();
      if (!HS().busy || $('#hub-busy').classList.contains('hidden') || $('#hub').getAttribute('aria-busy') !== 'true') throw new Error('建立工作包時應先顯示忙碌提示');
      if (hubBtn('download-workpack').getAttribute('disabled') === null) throw new Error('進行中應停用下載按鈕');
      await until(() => !HS().busy, '建立工作包');
    });
    if (HS().buildErrors) throw new Error('建立工作包失敗：' + HS().buildErrors.map((e) => e.message).join('；'));
    if (files.length !== 1 || !/^workpack-\d{8}T\d{6}Z-\d+dev\.zip$/.test(files[0].name)) throw new Error('應下載 workpack-<建立時間>-<N>dev.zip：' + files.map((f) => f.name));
    const bytes = new Uint8Array(files[0].bytes);
    const pack = WP.read(bytes);
    const roles = (r) => pack.files.filter((f) => f.role === r);
    deep(pack.snapshot, JSON.parse(JSON.stringify(App.snap)));
    deep(pack.sources, App.round.sources.map((s) => ({ name: s.name, text: s.text })));
    deep(pack.ledger, VA.ledger()); deep(pack.profile, App.round.profile); deep(pack.expected, App.round.expected.data);
    const K = S.view.exporter.KINDS;
    if (roles('report').map((f) => f.name).join() !== [K.csv.name(App.Q), K.markdown.name(App.Q)].join()) throw new Error('報表應依匯出的檔名放進工作包');
    const cur = S.view.patchView.current(App);
    if (roles('patch').map((f) => f.name).join() !== (cur ? cur.list.map((f) => f.name).join() : '')) throw new Error('patch 應是修正計畫選取的 .rsc 與總表');
    if (cur && !roles('patch').every((f, i) => Buffer.from(f.bytes).toString('utf8') === cur.list[i].text)) throw new Error('patch 的內容應和修正計畫下載的相同（S.remediate 產生）');
    const saved = { snap: App.snap, ledger: JSON.parse(JSON.stringify(VA.ledger())), profile: App.round.profile, findings: App.snap.findings.length };

    // 讀入壞掉的工作包：列出全部問題（和核心回報的筆數相同），目前的資料不變
    const readPack = async (name, b) => {
      App.cancelWorkpack();
      const inp = $('#hub').querySelector('.hub-file-workpack');
      inp.files = [{ name, arrayBuffer: async () => b }]; inp.dispatch('change', { target: inp });
      await until(() => !HS().busy && HS().read, '讀入工作包 ' + name);
    };
    const enc = (o) => S.zip.utf8.encode(JSON.stringify(o));
    const crcBad = bytes.slice(); const src0 = S.zip.read(bytes).entries.find((e) => e.path.startsWith('sources/'));
    crcBad[Buffer.from(bytes).indexOf(Buffer.from(src0.bytes.subarray(0, 64))) + 10] ^= 0x20;
    // 收集檔順序不同：兩份收集檔的工作包，manifest 中兩份對調（各自的雜湊仍正確）
    const edge = fs.readFileSync(path.join(ROOT, 'tests/fixtures/firewall/edge-router.txt'), 'utf8');
    const two = [{ name: 'a.txt', text: edge }, { name: 'b.txt', text: edge + '\n# second\n' }];
    const now2 = '2026-01-01T00:00:00Z'; const snap2 = S.build(two, { now: now2 });
    const z2 = S.zip.read(WP.build(two.map((s) => ({ role: 'source', name: s.name, text: s.text })).concat([{ role: 'snapshot', name: 'b.json', text: JSON.stringify(snap2) }]), { now: now2 }));
    const mf = JSON.parse(S.zip.utf8.decode(z2.entries[0].bytes)); const si = mf.files.map((f, i) => [f, i]).filter(([f]) => f.role === 'source').map(([, i]) => i);
    [mf.files[si[0]], mf.files[si[1]]] = [mf.files[si[1]], mf.files[si[0]]];
    const swapped = S.zip.write([{ path: 'manifest.json', bytes: enc(mf) }].concat(z2.entries.slice(1).map((e) => ({ path: e.path, bytes: e.bytes }))));
    for (const [name, bad] of [['truncated.zip', bytes.slice(0, bytes.length - 30)], ['crc.zip', crcBad], ['order.zip', swapped]]) {
      let want = null; try { WP.read(bad); } catch (e) { want = e.errors; }
      if (!want || !want.length) throw new Error(name + '：測試資料應讓 S.workpack.read 失敗');
      const ledgerBefore = JSON.stringify(VA.ledger());
      await readPack(name, bad);
      const box = $('#hub').querySelector('.wp-read-error');
      if (!box || !box.textContent.includes(name) || box.querySelector('.wp-errors').testAll('li').length !== want.length) throw new Error(`${name}：應列出全部 ${want.length} 項問題`);
      if (!want.every((e) => box.textContent.includes(e.message))) throw new Error(name + '：應列出核心的訊息');
      if (App.snap !== saved.snap || JSON.stringify(VA.ledger()) !== ledgerBefore) throw new Error(name + '：讀入失敗時目前的基準與處理紀錄都不可改變');
    }
    const orderText = $('#hub').querySelector('.wp-read-error').textContent;
    if (!orderText.includes('source-mismatch') && !orderText.includes('input-hash')) throw new Error('順序不同時應列出收集檔不符：' + orderText);

    // 換成另一份基準，並讓目前的處理紀錄多出工作包沒有的內容
    await buildInput(edge); await App.ledgerJob;
    await App.setLedger(App.snap.findings.find((f) => VA.ledgerItem(f)), { note: '工作包之後才改的' });
    App.openHub('inputs');
    await readPack(files[0].name, bytes);
    const w = HS().read;
    if (!w.pack || !$('#hub').querySelector('.wp-read-confirm')) throw new Error('讀入成功時應請使用者確認要帶回的內容');
    if (!w.loss || !$('#hub').querySelector('.wp-loss')) throw new Error('目前的處理紀錄有工作包沒有的內容時應明確提示');
    if ($('#hub').querySelector('.wp-profile').value !== 'pack') throw new Error('命名規則預設應用工作包附的');
    // 沒有勾選確認就不取代
    hubBtn('apply-workpack').click(); await new Promise((r) => setTimeout(r, 10));
    if (App.snap.meta.inputHash === saved.snap.meta.inputHash || !$('#hub').textContent.includes('請先勾選確認')) throw new Error('取代處理紀錄前應先確認');
    const ack = $('#hub').testAll('.wp-choose').find((x) => x.getAttribute('data-choose') === 'ack');
    ack.checked = true; ack.dispatch('change');
    // 重建用 validateAsync：每次回報進度時，忙碌提示裡的進度條與文字跟著更新（記下每一次的畫面）
    const seen = []; const origProgress = VA.hubProgress;
    VA.hubProgress = (pr) => { origProgress(pr); const bar = $('#hub-busy').querySelector('.progress');
      seen.push({ stage: pr.stage, text: text('#hub-busy'), now: bar && bar.getAttribute('aria-valuenow'), width: bar && bar.firstElementChild.style.width }); };
    try {
      hubBtn('apply-workpack').click();
      if (!HS().busy || !text('#hub-busy').includes('重建')) throw new Error('重建核對時應顯示忙碌提示');
      await until(() => HS().read && HS().read.done, '帶回工作包');
    } finally { VA.hubProgress = origProgress; }
    if (!seen.length) throw new Error('重建期間應回報進度');
    seen.forEach((x) => {
      if (!x.text.includes('重建') || !x.text.includes(x.stage) || !/^\d+$/.test(x.now || '') || x.width !== x.now + '%') throw new Error('進度應顯示在忙碌提示中（階段、進度條）：' + JSON.stringify(x));
    });
    if (seen.some((x, i) => i && +x.now < +seen[i - 1].now)) throw new Error('進度不應倒退');
    if (!$('#hub-busy').classList.contains('hidden')) throw new Error('完成後應收起忙碌提示');
    await App.ledgerJob; await App.layoutJob;
    // 基準相同（依關係比對）；處理紀錄、命名規則、預期資料都帶回
    if (App.snap.meta.inputHash !== saved.snap.meta.inputHash || App.snap.meta.baselineKey !== saved.snap.meta.baselineKey) throw new Error('讀回的基準應和匯出前相同（inputHash、baselineKey）');
    if (App.snap.findings.length !== saved.findings) throw new Error('讀回的基準的檢查結果筆數應和匯出前相同');
    const qSaved = S.query(saved.snap);
    deep(App.snap.findings.map((f) => App.Q.findingKey(f)), saved.snap.findings.map((f) => qSaved.findingKey(f)));
    deep(VA.ledger(), saved.ledger); deep(await S.store.get('ledger'), saved.ledger);
    deep(App.round.profile, saved.profile); deep(App.round.expected.data, pack.expected);
    deep(App.round.sources, pack.sources);
    const last = await S.store.get('last'); deep(last.profile, saved.profile); deep(last.sources, pack.sources);
    if (!App.round.origin || App.round.origin.kind !== 'workpack') throw new Error('應記下基準來自工作包');
    if (!$('#hub').querySelector('.wp-read-done') || !text('#hub').includes('上一輪的基準')) throw new Error('應列出帶回的內容');
    // 再讀入這一輪的收集檔：自動和工作包的基準比對
    await buildInput(edge + '\n# next\n');
    const st = S.view.baselineDiff.status();
    if (!st || !st.name.includes(files[0].name) || st.report.errors.length) throw new Error('讀入這一輪的收集檔後，應自動以工作包的基準當上一輪比對');
    App.cancelWorkpack(); VA.closeHub();
  });
  await step('深層凍結的基準：選設備、選檢查結果、開詳情、開修正計畫、匯出、建立工作包，都不改寫基準也不因凍結出錯', async () => {
    const VA = S.view.app; const orig = App.snap;
    const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
    const frozen = deepFreeze(JSON.parse(JSON.stringify(orig))); const before = JSON.stringify(frozen);
    // 畫面捕捉的例外（例如匯出失敗）只寫 console.error 與 banner：一併收集，凍結造成的寫入錯誤不會被吞掉
    const errors = []; const origError = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ')); };
    try {
      VA.load(frozen, null); await App.ledgerJob; await App.layoutJob;
      if (App.snap !== frozen) throw new Error('應載入凍結的基準');
      const Q = App.Q;
      Q.devices().slice(0, 50).forEach((d) => App.select({ type: 'device', key: d.key }, { focus: true }));
      const d0 = Q.devices().find((d) => d.collected) || Q.devices()[0];
      App.select({ type: 'device', key: d0.key }, { focus: true });
      if (!text('#detail').includes(d0.name)) throw new Error('凍結的基準也應顯示設備詳情');
      Q.links().slice(0, 50).forEach((l) => App.select({ type: 'link', key: l.key }));
      // 每條規則至少選一筆（大型資料只取前 200 筆再補上其他規則的第一筆）
      const idxs = new Set(Q.findings().slice(0, 200).map((f, i) => i));
      S.util.uniq(Q.findings().map((f) => f.id)).forEach((id) => idxs.add(Q.findings().findIndex((f) => f.id === id)));
      idxs.forEach((i) => { App.selectFinding(i); App.graph.draw(); });
      App.select(null); App.graph.draw();
      ['input', 'view', 'triage', 'fix', 'verify'].forEach(goStep);
      goStep('triage');
      $('#pane-findings').querySelector('.open-patch').click();
      if (!S.view.patchView.isOpen(App)) throw new Error('應開啟修正計畫');
      $('#patch-body').testAll('.patch-rule').forEach((c) => c.click());
      // 比對與收斂趨勢的工作畫面也只讀基準
      App.showView('compare'); App.showView('trend');
      App.showView('graph');
      // L2／L3 視圖與 VLAN 篩選也只讀基準（Q 的結果另建畫面自己的節點）
      App.select({ type: 'vlan', key: String(Q.vlanIds()[0]) });
      for (const l of ['l2', 'l3', 'device']) { App.showLayer(l); await App.layerJob; App.graph.draw(); }
      $('#btn-l3-routes').click(); App.showLayer('l3'); await App.layerJob; App.graph.draw(); $('#btn-l3-routes').click();
      const sn = Q.subnetGraph().subnets[0]; if (sn) App.select({ type: 'subnet', key: sn.id });
      App.showLayer('device'); $('#vlan-filter').value = ''; $('#vlan-filter').dispatch('change');
      // L4：矩陣、下鑽、可達性查詢、規則的命中次數與影響（查詢層的推論只在記憶體，不寫回基準）
      App.showLayer('l4'); await App.l4Job;
      const mxF = Q.zoneMatrix(); const cF = mxF.cells.find((c) => c.counts.total);
      if (cF) {
        S.view.l4.openCell(App, cF.src, cF.dst);
        const b = $('#l4-drill').testAll('.l4-svc')[0]; if (b) b.click();
        const rl = $('#l4-drill').testAll('.l4-rule')[0];
        if (rl) { rl.click(); const run = $('#detail').querySelector('.fw-impact-run'); if (run) { run.click(); await App.l4ImpactJob; } }
      }
      L4().testAll('.l4-modes button').forEach((x) => { x.click(); }); // 表格、再回矩陣
      await App.l4Job;
      App.showLayer('device');
      const kinds = Object.keys(S.view.exporter.KINDS);
      const { files } = await captureDownloads(() => { kinds.forEach((k) => App.exportAs(k)); App.exportAs('csv', { byDevice: true }); App.exportAs('markdown', { byDevice: true }); });
      if (files.length !== kinds.length + 2) throw new Error(`每種匯出都應產生下載（${files.length}／${kinds.length + 2}）`);
      require('assert').deepStrictEqual(JSON.parse(files[kinds.indexOf('snapshot')].text), JSON.parse(before));
      // 資料中心的狀態與工作包（基準、報表、patch 都從凍結的基準組出來）
      App.openHub();
      const wp = await captureDownloads(() => App.downloadWorkpack());
      if (wp.files.length !== 1 || VA.hubState().buildErrors) throw new Error('凍結的基準也應能建立工作包：' + JSON.stringify(VA.hubState().buildErrors));
      require('assert').deepStrictEqual(S.workpack.read(new Uint8Array(wp.files[0].bytes)).snapshot, JSON.parse(before));
      VA.closeHub();
      if (JSON.stringify(frozen) !== before) throw new Error('畫面不可改寫基準');
      if (errors.length) throw new Error('凍結的基準不應造成錯誤：\n' + errors.join('\n'));
    } finally {
      console.error = origError;
      VA.load(orig, null); await App.ledgerJob; await App.layoutJob;
    }
  });
  await step('清除基準（處理紀錄不受影響）；沒有基準時 ④、⑤ 停用，中間只有拓樸圖（歡迎畫面）', async () => {
    App.showView('patch');
    $('#btn-clear').click(); await new Promise((r) => setTimeout(r, 20)); if (App.snap) throw new Error('未清除');
    if (App.step !== 'triage' || App.centerView !== 'graph' || !$('#view-patch').classList.contains('hidden') || $('#view-graph').inert) throw new Error('清除基準後應回到「③ 分診」的拓樸圖');
    if (!['fix', 'verify'].every((s) => stepBtn(s).getAttribute('aria-disabled') === 'true') || ['input', 'view', 'triage'].some((s) => stepBtn(s).getAttribute('aria-disabled') !== 'false')) throw new Error('沒有基準時只有 ④、⑤ 停用（aria-disabled，仍可聚焦）');
    if (!stepBtn('input').textContent.includes('未載入') || !stepBtn('fix').textContent.includes('建立基準後')) throw new Error('沒有基準時步驟的狀態應說明：' + text('#steps'));
    goStep('verify'); if (App.step !== 'triage' || !text('#banner').includes('建立基準後')) throw new Error('停用的步驟按了不切換，並說明原因');
    App.showView('trend'); if (App.centerView !== 'graph' || App.step !== 'triage') throw new Error('沒有基準時不能切到其他工作畫面');
    goStep('view'); if (App.step !== 'view' || !text('#pane-inventory').includes('建立基準後')) throw new Error('沒有基準時 ② 仍可開啟並說明');
    goStep('triage');
    const lg = await S.store.get('ledger');
    if (!lg || (ackedKey && !lg.items[ackedKey])) throw new Error('清除基準不應清掉處理紀錄');
  });
  await step('還原舊 schema 的基準：有儲存輸入時重建，沒有時明確告知', async () => {
    const sources = [{ name: 'sample-bundle.txt', text: S.samples['sample-bundle.txt'] }];
    const old = { meta: { schema: 'ssot-snapshot/1', version: '1.3.2', createdAt: '2026-01-01T00:00:00Z' }, model: {} };
    await S.store.set('last', { snapshot: old, sources, profile: null });
    await App.restore();
    if (!App.snap || App.snap.meta.schema !== S.SCHEMA) throw new Error('舊 schema 應以儲存的輸入重建');
    $('#btn-clear').click(); await new Promise((r) => setTimeout(r, 20));
    await S.store.set('last', { snapshot: old, sources: [], profile: null });
    await App.restore();
    if (App.snap) throw new Error('沒有輸入時不應載入不相容的基準');
    if (!document.body.textContent.includes('已不相容')) throw new Error('應提示上次的基準格式不相容');
    $('#btn-clear').click(); await new Promise((r) => setTimeout(r, 20));
  });
  console.log(steps.join('\n'));
  setTimeout(() => process.exit(process.exitCode || 0), 10);
})();
