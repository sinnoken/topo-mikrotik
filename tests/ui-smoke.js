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
  querySelectorAll(sel) { const parts = sel.trim().split(/\s+/); let set = [this];
    parts.forEach((p) => { const next = []; set.forEach((r) => r.all().forEach((e) => { if (e.matches(p) && !next.includes(e)) next.push(e); })); set = next; }); return set; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getContext() { return new Proxy({}, { get: (t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 7 }) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }); }
  toDataURL() { return 'data:,'; }
}
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
  getElementById: (id) => body.querySelector('#' + id), querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s),
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

/** 在輸入框貼上文字並建立基準，等到新的基準載入 */
async function buildInput(input) {
  $('#input-text').value = input; $('#input-build').click();
  const hash = S.util.hash(S.readers.PASTE + '\n' + input);
  for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
  if (App.snap.meta.inputHash !== hash) throw new Error('基準未建立：' + text('#input-status'));
  await App.layoutJob;
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
    if (!$('#detail .chip-list') || !$('#detail .chip-list').querySelectorAll('.chip').length) throw new Error('設備收集資料標籤應使用可間隔換行的 chip-list');
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
      $('#detail').querySelectorAll('h3').forEach((x) => {
        if (!/\bdetail-section\b/.test(x.parentNode.className)) throw new Error(`${sel.type} 詳情的標題「${x.textContent}」不是由 section() 產生`);
      });
      $('#detail').querySelectorAll('details').forEach((d) => {
        if (d.querySelectorAll('h3').length) throw new Error(`${sel.type} 詳情的展開區塊「${d.querySelector('summary').textContent}」內不應有標題`);
      });
    });
    App.select(null);
  });
  await step('推論鏈路：沒有 LLDP 的 CSS610 以推論樣式畫出，提示與詳情說明依據', () => {
    const il = App.Q.inferredLinks(); if (process.env.SMOKE_INPUT && !il.length) return; // 大型乾淨網路沒有 CSS610
    if (!il.length) throw new Error('範例資料應有推論鏈路');
    const p = Array.from(App.pairs.values()).find((x) => x.evidence === 'inferred');
    if (!p) throw new Error('推論鏈路應以推論樣式畫在圖上');
    if (!Array.from(document.querySelectorAll('#legend .li')).some((li) => li.textContent === '推論鏈路')) throw new Error('圖例應有推論鏈路');
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
    if (Array.from(document.querySelectorAll('#legend .li')).some((li) => li.textContent.includes('L3'))) throw new Error('圖上沒有 L3 連線，圖例不應列出');
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
    const button = (t) => $('#baseline-summary').querySelectorAll('button').find((b) => b.textContent === t);
    const off = (b) => b.getAttribute('disabled') !== null; // 模擬 DOM 的 setAttribute 不會同步 .disabled
    const missing = button('查看收集缺漏');
    const expectedMissing = App.snap.coverage.filter((row) => row.collected && (row.missing.length || row.failures.length)).length;
    if (!missing || off(missing) !== !expectedMissing) throw new Error('收集缺漏入口應在有缺漏時才可用');
    if (expectedMissing) {
      missing.click();
      if (!text('#pane-coverage').includes('有缺漏')) throw new Error('缺漏入口沒有切換至覆蓋率');
      if ($('#pane-coverage').querySelectorAll('tbody tr').length !== expectedMissing) throw new Error('缺漏入口應預先篩選有缺漏的設備');
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
    const workspaces = document.querySelectorAll('#mobile-workspaces button');
    workspaces.find((b) => b.dataset.workspace === 'checks').click();
    if ($('#main').dataset.workspace !== 'checks') throw new Error('工作區切換未顯示檢查面板');
    App.select({ type: 'device', key: App.snap.model.devices[0].key });
    if ($('#main').dataset.workspace !== 'details') throw new Error('選取資料後應切換至詳細資料工作區');
    const folds = $('#detail').querySelectorAll('details');
    if (!folds.length || !folds.some((d) => d.querySelector('summary').textContent.includes('鄰居'))) throw new Error('設備詳細資訊未提供可漸進展開的區塊');
    // 檢查兩種設備：未收集的與已收集的（已收集才有「收集到的原始輸出」等區塊）
    const noDupTitle = () => $('#detail').querySelectorAll('details').forEach((d) => {
      const title = d.querySelector('summary').firstChild.textContent;
      if (d.querySelectorAll('h3').some((x) => x.textContent.startsWith(title))) throw new Error(`展開區塊「${title}」內不應再重複同名標題`);
    });
    noDupTitle();
    App.select({ type: 'device', key: App.snap.model.devices.find((x) => x.collected && x.data.includes('route')).key });
    if (!$('#detail').querySelectorAll('summary').some((x) => x.textContent.startsWith('收集到的原始輸出'))) throw new Error('已收集設備應有原始輸出區塊');
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
      const shown = document.querySelectorAll('#legend .lg-vendor').map((li) => li.textContent);
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
    const head = () => document.querySelectorAll('#pane-findings .fgroup').find((g) => g.className.split(' ').includes('pass'));
    if (!head()) throw new Error('應有「通過」區塊');
    if (head().querySelectorAll('.rule').length) throw new Error('「通過」區塊預設應收合');
    head().querySelector('.head').click();
    if (head().querySelectorAll('.rule').length !== pass.length || !text('#pane-findings').includes(pass[0].title)) throw new Error('展開後應列出每一條通過的規則');
    // 每一條規則都能看到 CATALOG 的處理建議（預設收合，反引號內是等寬元素）
    const plain = (t) => String(t).replace(/`([^`]+)`/g, '$1');
    const rows = () => head().querySelectorAll('.rule');
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
    const nd = () => document.querySelectorAll('#pane-findings .fgroup').find((g) => g.className.split(' ').includes('nodata'));
    if (nodata.length) {
      nd().querySelector('.head').click();
      nd().querySelectorAll('.rule').forEach((row, n) => {
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
      const blocks = $('#detail').querySelectorAll('.advice').filter((d) => d.getAttribute('data-rule-id') === id);
      if (!blocks.length) throw new Error(id + ' 的詳情應有常見原因與處理');
      blocks.forEach((d) => {
        if (d.tagName !== 'DETAILS' || d.getAttribute('open') !== null) throw new Error(id + ' 的常見原因與處理應預設收合');
        const t = d.textContent;
        if (!t.includes(plain(C[id].action))) throw new Error(id + ' 的詳情應顯示 CATALOG 的 action：' + C[id].action);
        if (!C[id].causes.every((c) => d.querySelectorAll('li').some((li) => li.textContent === plain(c)))) throw new Error(id + ' 的常見原因應逐條列出');
        if (t.includes('`')) throw new Error(id + ' 的處理建議不應顯示反引號');
        const shown = d.querySelectorAll('code').map((c) => c.textContent);
        const want = codes(C[id].action).concat(...C[id].causes.map(codes));
        if (shown.join('\n') !== want.join('\n')) throw new Error(id + ' 反引號內的片段應依序成為等寬元素：' + JSON.stringify(shown) + ' / ' + JSON.stringify(want));
        if (d.querySelectorAll('code').some((c) => !c.classList.contains('mono') || c.childNodes.some((n) => n instanceof El))) throw new Error(id + ' 的等寬元素應為純文字的 code.mono');
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
      const box = $('#detail').querySelectorAll('.finding').find((x) => x.textContent.includes(f.message));
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
      const headings = $('#detail').querySelectorAll('h3').map((el) => el.textContent.replace(/\d+$/, ''));
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
  await step('清單分頁列出設備、介面、MAC、VLAN，並可篩缺 IP；總覽顯示去重複的 IP（ARP）', () => {
    const C = App.Q.inventory().counts; const st = App.snap.meta.stats;
    const same = [['devices', st.devices], ['interfaces', st.interfaces], ['macs', st.macs], ['vlans', st.vlans]];
    same.forEach(([k, v]) => { if (C[k] !== v) throw new Error(`清單與總覽的 ${k} 不一致：${C[k]} vs ${v}`); });
    if (C.arpIps !== new Set(App.snap.model.arps.map((x) => x.ip)).size) throw new Error('IP（ARP）應為去重複的 ARP IP 數');
    if (C.ips < C.arpIps || C.ips !== new Set(App.Q.inventory().rows.ips.map((r) => r.ip)).size) throw new Error('IP 清單應去重複且涵蓋 ARP');
    const rows = App.Q.macEntries(); if (!rows.length) throw new Error('清單應有資料');
    const noIp = App.snap.model.macs.filter((x) => !x.ips.length).length;
    if (rows.filter((r) => r.noIp).length < noIp) throw new Error('缺 IP 筆數不符');
    document.querySelectorAll('#left .tabs button')[2].click();
    const m = App.snap.model; const ips = App.Q.ipEntries();
    const t = text('#pane-inventory');
    [`設備 ${m.devices.length + App.Q.endpointEntries().length}`, `介面 ${m.interfaces.length}`, `IP ${ips.length}`, `網段 ${m.prefixes.length}`, `MAC ${new Set(rows.map((r) => r.mac)).size}`, `VLAN ${m.vlans.length}`].forEach((x) => { if (!t.includes(x)) throw new Error('清單缺少分類：' + x); });
    if (new Set(ips.map((r) => r.ip)).size !== ips.length) throw new Error('IP 清單應去重複');
    document.querySelectorAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('網段')).click();
    const pre = App.Q.inventory().rows.prefixes;
    if (!pre.length || document.querySelectorAll('#pane-inventory tbody tr').length !== pre.length) throw new Error('網段清單列數應等於推導出的網段數');
    pre.forEach((p) => { if (p.ipCount !== ips.filter((r) => S.ip.inNet(r.ip, p.net, p.len)).length) throw new Error('網段的 IP 數應等於清單中落在網段內的 IP'); });
    document.querySelector('#pane-inventory tbody tr').dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'interface' || !pre[0].eps.includes(App.sel.key)) throw new Error('點網段應選取設定該網段的介面');
    const macChip = document.querySelectorAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('MAC'));
    if (new Set(rows.map((r) => r.mac)).size !== App.snap.meta.stats.macs) throw new Error('清單的不重複 MAC 數應等於總覽');
    const nEnd = App.Q.endpointEntries().length; const unk = App.snap.model.interfaces.filter((i) => i.unknownPeer).length;
    if (nEnd < unk || new Set(App.Q.endpointEntries().map((e) => e.key)).size !== unk) throw new Error('終端的不重複介面數應等於未知對端介面數，且不可少於它');
    document.querySelectorAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('設備')).click();
    const t0 = text('#pane-inventory'); ['全部 ' + (m.devices.length + nEnd), '終端 ' + nEnd].forEach((x) => { if (!t0.includes(x)) throw new Error('設備清單缺少分類：' + x); });
    // 兩層選項：清單種類是分段按鈕，種類內是篩選選項；0 筆的篩選停用
    const seg = $('#pane-inventory .seg'); if (!seg || seg.querySelectorAll('button').length !== 6) throw new Error('清單種類應為分段按鈕');
    const sub = document.querySelectorAll('#pane-inventory .summary').find((x) => x.className.split(' ').includes('sub'));
    if (!sub) throw new Error('種類內的篩選應是第二層');
    const zero = sub.querySelectorAll('.chip').find((c) => / 0$/.test(c.textContent));
    if (zero && (!zero.className.includes('off') || zero.getAttribute('aria-disabled') !== 'true')) throw new Error('0 筆的篩選應停用');
    const firstRow = document.querySelector('#pane-inventory tbody tr');
    if (!firstRow || firstRow.getAttribute('tabindex') !== '0') throw new Error('可點選清單列應可透過鍵盤聚焦');
    firstRow.dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'device') throw new Error('清單列按 Enter 應選取設備');
    document.querySelectorAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('終端')).click();
    if (document.querySelectorAll('#pane-inventory tbody tr').length !== Math.min(nEnd, 500)) throw new Error('終端篩選列數不符');
    const ipChip = document.querySelectorAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('IP')); ipChip.click();
    document.querySelectorAll('#pane-inventory th')[0].dispatch('click');
    const col = () => document.querySelectorAll('#pane-inventory tbody tr').map((tr) => tr.querySelectorAll('td')[0].textContent);
    const asc = col(); const num = (x) => x.split('.').reduce((n, p) => n * 256 + +p, 0);
    if (!asc.length || asc.some((x, i) => i && num(asc[i - 1]) > num(x))) throw new Error('IP 清單應依 IP 數值升冪');
    document.querySelectorAll('#pane-inventory th')[0].dispatch('click');
    const desc = col(); if (asc.length > 1 && desc[0] === asc[0]) throw new Error('再點一次應反向排序');
    document.querySelectorAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('MAC')).click();
    macChip.click(); const t2 = text('#pane-inventory'); if (!t2.includes('缺 IP ' + new Set(rows.filter((r) => r.noIp).map((r) => r.mac)).size) || !t2.includes('全部 ' + App.snap.meta.stats.macs)) throw new Error('缺 IP 摘要不正確');
    App.select(null); const ov = text('#right'); const uniq = new Set(App.snap.model.arps.map((x) => x.ip)).size;
    if (!ov.includes('IP（ARP）' + uniq.toLocaleString()) && !ov.includes('IP（ARP）')) throw new Error('總覽缺少 IP（ARP）');
  });
  await step('覆蓋率分頁', () => { document.querySelectorAll('#left .tabs button')[1].click(); if (!text('#pane-coverage').includes(process.env.SMOKE_INPUT ? '有缺漏 0' : '有缺漏 1')) throw new Error('覆蓋率摘要不正確'); });
  await step('比對分頁', async () => {
    const inp = $('#pane-compare').querySelector('input'); inp.files = [{ name: 'expected-sample.json', text: async () => fs.readFileSync(path.join(ROOT, 'samples/expected-sample.json'), 'utf8') }];
    inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
    if (!text('#pane-compare').includes('有差異')) throw new Error('比對結果未顯示');
  });
  await step('匯出：基準 JSON 與檢查結果 CSV／Markdown 在本機產生，下載後釋放 URL，不改寫基準', async () => {
    const before = JSON.stringify(App.snap);
    const { made, revoked, anchors, files } = await captureDownloads(() => {
      $('#btn-json').click();
      const button = (t) => $('#pane-findings').querySelectorAll('button').find((b) => b.textContent === t);
      if (!button('CSV') || !button('Markdown')) throw new Error('檢查結果分頁應有 CSV 與 Markdown 匯出按鈕');
      button('CSV').click(); button('Markdown').click();
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
    document.querySelectorAll('#left .tabs button')[0].click();
    const group = (id) => document.querySelectorAll('#pane-findings .fgroup').find((x) => {
      const el = x.querySelector('.head .id'); return el && el.textContent === id && !x.className.includes('handled');
    });
    const editBtn = (x) => document.querySelectorAll('#pane-findings .ledger-edit').find((b) => b.getAttribute('aria-label') === '處理：' + x.message);
    const editor = () => $('#pane-findings').querySelector('.ledger-editor');
    const errText = () => { const e = editor() && editor().querySelector('.ledger-error'); return e && !e.classList.contains('hidden') ? e.textContent : ''; };
    const fill = async (status, o) => {
      const ed = editor(); if (!ed) throw new Error('按「處理」後應出現狀態欄位');
      ed.querySelector('select').value = status;
      const set = (cls, v) => { if (v !== undefined) ed.querySelectorAll('input').find((i) => i.className.includes(cls)).value = v; };
      set('ledger-note', o.note); set('ledger-waiver-reason', o.reason); set('ledger-waiver-until', o.until);
      ed.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === '儲存處理狀態：' + f.message).click();
      await new Promise((r) => setTimeout(r, 10));
    };
    if (!editBtn(f)) group(f.id).querySelector('.head').click();
    const snapBefore = JSON.stringify(App.snap);
    editBtn(f).click();
    const opts = editor().querySelector('select').querySelectorAll('option').map((o) => o.getAttribute('value'));
    const it0 = VA.ledgerItem(f);
    if (opts.join() !== [it0.status].concat(LG.USER_TO[it0.status]).join()) throw new Error('可選的狀態應是目前狀態加上 USER_TO：' + opts);
    editor().querySelectorAll('button').find((b) => b.textContent === '取消').click();
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
    const handled = (s) => document.querySelectorAll('#pane-findings .fgroup').find((x) => x.className.includes('handled') && x.getAttribute('data-status') === s);
    if (!handled('accepted')) throw new Error('應有「可接受」的已處理分組');
    if (handled('accepted').querySelectorAll('.fitem').length) throw new Error('已處理分組預設應收合');
    handled('accepted').querySelector('.head').click();
    const gt = handled('accepted').textContent;
    if (!gt.includes(f.message) || !gt.includes('豁免原因：' + reason1) || !gt.includes('備註：備註一')) throw new Error('已處理的項目應顯示原因與備註');
    // 摘要：排除已處理並註明
    const left = problems(); const summary = text('#baseline-summary');
    if (left.length !== before.length - 1) throw new Error('處理一筆後，待處理的問題應少一筆');
    const nHandled = all.filter((x) => x.severity !== 'info' && !VA.isPending(x)).length;
    if (!summary.includes(`另有 ${nHandled} 項已處理`)) throw new Error('基準摘要應註明已處理筆數：' + summary);
    // 改為誤報：備註以公式開頭，CSV 要防公式注入；規則品質列出這條規則
    document.querySelectorAll('#pane-findings .ledger-edit').find((b) => b.getAttribute('aria-label') === '處理：' + f.message).click();
    const note2 = '=SUM(A1) 是誤判';
    await fill('false-positive', { note: note2 });
    const it2 = VA.ledgerItem(f);
    if (it2.status !== 'false-positive' || it2.waiver !== null || it2.note !== note2) throw new Error('應改為誤報、移除豁免：' + JSON.stringify(it2));
    if (it2.history[it2.history.length - 1].waiver.reason !== reason1) throw new Error('被移除的豁免應記在歷程');
    App.selectFinding(all.indexOf(f));
    if (text('#detail').includes(f.message) && !text('#detail').includes(RV.statusText('false-positive'))) throw new Error('詳情的檢查結果應標出處理狀態');
    document.querySelectorAll('#left .tabs button')[0].click();
    const fp = document.querySelectorAll('#pane-findings .fgroup').find((x) => x.className.includes('fp-rules'));
    if (!fp) throw new Error('有誤報時應列出誤報率最高的規則');
    fp.querySelector('.head').click();
    const fpRow = document.querySelectorAll('#pane-findings .fp-rules .rule').find((r) => r.getAttribute('data-rule-id') === f.id);
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
    document.querySelectorAll('#pane-findings .fgroup').filter((x) => x.className.includes('handled') && !x.querySelectorAll('.fitem').length).forEach((g) => g.querySelector('.head').click());
    document.querySelectorAll('#pane-findings .ledger-edit').find((b) => b.getAttribute('aria-label') === '處理：' + f.message).click();
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
    document.querySelectorAll('#left .tabs button')[0].click();
    // 打開全部嚴重度，再切到依設備
    for (let n = 0; n < 3; n++) {
      const off = $('#pane-findings').querySelector('.summary').querySelectorAll('.chip').find((c) => c.getAttribute('aria-pressed') === 'false' && c.getAttribute('aria-disabled') !== 'true');
      if (off) off.click();
    }
    const seg = (k) => $('#pane-findings').querySelectorAll('button').find((b) => b.getAttribute('data-group-by') === k);
    seg('device').click();
    if (seg('device').getAttribute('aria-pressed') !== 'true') throw new Error('「依設備」應標示為選取');
    const groups = () => $('#pane-findings').querySelectorAll('.fgroup').filter((g) => g.className.split(' ').includes('by-device'));
    const want = new Map();
    R.sortByDevice(Q, all).forEach((r) => { if (S.view.app.isPending(r.f)) S.util.getOr(want, r.dev, () => []).push(r.idx); });
    const keys = Array.from(want.keys());
    const gs = groups();
    if (gs.length !== want.size) throw new Error(`依設備的分組數應等於設備數：${gs.length} / ${want.size}`);
    gs.forEach((g, n) => {
      const name = keys[n] === null ? '不屬於任何設備' : Q.devName(keys[n]);
      if (g.querySelector('.head .title').textContent !== name) throw new Error('分組應依設備名稱排列：' + g.querySelector('.head .title').textContent);
      const chips = g.querySelector('.head').querySelectorAll('.chip');
      if (chips[chips.length - 1].textContent !== String(want.get(keys[n]).length)) throw new Error(`${name} 的筆數不符`);
    });
    if (want.has(null) && !gs[gs.length - 1].className.includes('no-device')) throw new Error('不屬於任何設備的應在最後一組');
    if (!process.env.SMOKE_INPUT && !want.has(null)) throw new Error('範例資料應有不屬於任何設備的檢查結果（例如 A01）');
    // 展開一組：每筆標出規則代碼，且都屬於這台設備
    gs[0].querySelector('.head').click();
    const items = groups()[0].querySelectorAll('.fitem');
    if (items.length !== Math.min(100, want.get(keys[0]).length)) throw new Error('展開後應列出這台設備的檢查結果');
    items.forEach((it, n) => {
      const f = all[want.get(keys[0])[n]];
      if (!it.querySelector('.id') || it.querySelector('.id').textContent.trim() !== f.id || !it.textContent.includes(f.message)) throw new Error('依設備分組時每筆應標出規則代碼與訊息');
    });
    groups()[0].querySelector('.head').click();
    // 匯出：可選依設備排序；CSV 的 device 欄依分組順序，Markdown 依設備分組
    const toggle = () => $('#pane-findings').querySelectorAll('button').find((b) => b.textContent === '依設備排序');
    toggle().click();
    if (toggle().getAttribute('aria-pressed') !== 'true') throw new Error('「依設備排序」應可切換');
    const button = (t) => $('#pane-findings').querySelectorAll('button').find((b) => b.textContent === t);
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
    if (groups().length || !$('#pane-findings').querySelectorAll('.fgroup .head .id').length) throw new Error('切回「依規則」應恢復依規則代碼分組');
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
      if (row.querySelectorAll('td')[0].style.background !== S.view.theme.firewall.focus.bg) throw new Error('定位列的顏色應取自 theme');
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
    const link = $('#detail').querySelectorAll('a').find((a) => a.textContent === '查看防火牆規則與服務');
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
    const folds = $('#detail').querySelectorAll('details').filter((d) => d.querySelector('.fw-chain'));
    if (folds.map((d) => d.querySelector('summary').firstChild.textContent).join('|') !== chains.map((c) => c.chain).join('|')) throw new Error('chain 的順序應與 Q.firewallChains 一致');
    const heads = $('#detail').querySelectorAll('h3').map((x) => x.firstChild.textContent);
    const fams = S.util.uniq(chains.map((c) => c.family + ' ' + c.table));
    const famIdx = fams.map((k) => heads.findIndex((x) => x === k.replace(/^ip /, 'IPv4 ').replace(/^ipv6 /, 'IPv6 ')));
    if (famIdx.some((i) => i < 0) || famIdx.some((x, i) => i && famIdx[i - 1] > x)) throw new Error('位址族與表的分組應依序列出：' + heads.join('|'));
    folds.forEach((d, n) => {
      d.dispatch('toggle');
      const trs = d.querySelectorAll('tbody tr'); const c = chains[n];
      if (trs.length !== c.rules) throw new Error(`${c.chain} 的列數應等於規則數`);
      const pos = trs.map((tr) => Number(tr.querySelectorAll('td')[0].textContent));
      if (pos.some((x, i) => i && pos[i - 1] > x)) throw new Error(`${c.chain} 應依 position 排列`);
      const rows = Q.firewallRuleRows(dev, { family: c.family, table: c.table, chain: c.chain });
      trs.forEach((tr, i) => {
        const r = rows[i].rule; const act = tr.querySelectorAll('td')[1].firstChild;
        const want = S.view.theme.firewall.action[r.action] || S.view.theme.firewall.action.other;
        if (act.style.color !== want) throw new Error('規則動作的顏色應取自 theme');
        if (!tr.textContent.includes(`第 ${r.src[0][1]} 行`)) throw new Error('每列應有原文行號');
      });
      if (c.jumpedFrom.length && !d.textContent.includes('由這些規則 jump 進來')) throw new Error('有規則 jump 進來的 chain 應列出來源規則');
    });
    // 原文行號可開啟
    const a = $('#detail').querySelectorAll('.fw-chain a').find((x) => /^第 \d+ 行$/.test(x.textContent));
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
      const box = $('#detail').querySelectorAll('.fw-fix').find((b) => b.getAttribute('data-finding') === key);
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
      const fold = $('#detail').querySelectorAll('details').find((d) => d.querySelector('summary').textContent.startsWith('修正'));
      if (!fold || fold.querySelector('summary .chip').textContent !== String(plan.items.length + plan.skipped.length)) throw new Error('設備的防火牆畫面應收合列出全部修正與筆數');
      // 在修正計畫中開啟：選取就是這些 findingKey
      fold.querySelector('.open-patch').click();
      if (!$('#dlg-patch').open || Array.from(S.view.patchView.state.keys).sort().join() !== keys.slice().sort().join()) throw new Error('「在修正計畫中開啟」應以這些檢查結果開啟修正計畫');
      $('#dlg-patch').close();
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
    document.querySelectorAll('#left .tabs button')[1].click();
    const btn = $('#pane-coverage').querySelectorAll('button').find((b) => b.textContent === '匯出未收集設備的 devices.csv 草稿');
    const devs = S.util.uniq(all.filter((f) => f.id === 'C01').map((f) => f.entities.find((e) => e.type === 'device').key)).map((k) => Q.getDevice(k));
    if (!btn) throw new Error('覆蓋率分頁應有匯出 devices.csv 草稿的按鈕');
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
    const legend = Array.from(document.querySelectorAll('#legend .li'));
    if (document.querySelectorAll('#legend .lg-group').length !== 5) throw new Error('圖例應分為五類');
    const groupTitles = document.querySelectorAll('#legend .lg-title').map((el) => el.textContent);
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
      const fold = $('#detail').querySelectorAll('details').find((d) => d.querySelector('summary').textContent.startsWith('收集到的原始輸出'));
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
    document.querySelectorAll('#left .tabs button')[1].click();
    if (!text('#pane-coverage').includes('有缺漏 ' + gaps.length)) throw new Error('有缺漏應包含只有收集失敗的設備');
    const b = $('#baseline-summary').querySelectorAll('button').find((x) => x.textContent === '查看收集缺漏');
    if (b.getAttribute('disabled') !== null) throw new Error('只有收集失敗時，收集缺漏入口也應可用');
    if (!text('#baseline-summary').includes(`${gaps.length} 台有必要資料缺漏`)) throw new Error('基準摘要的缺漏數應包含收集失敗');
    b.click();
    const tr = $('#pane-coverage').querySelectorAll('tbody tr');
    if (tr.length !== gaps.length) throw new Error('缺漏篩選列數應等於有缺漏的設備數');
    const t = text('#pane-coverage');
    gaps.forEach((r) => r.failures.forEach((x) => {
      if (!t.includes(S.view.failureText(x)) || !t.includes(x.command || '整台設備')) throw new Error('覆蓋率應顯示失敗原因與指令');
    }));
  });
  await step('防火牆畫面：停用規則、無法解碼的註解、jump 來源與預設值服務', async () => {
    await buildInput(fs.readFileSync(path.join(ROOT, 'tests/fixtures/firewall/edge-router.txt'), 'utf8'));
    const Q = App.Q; const dev = Q.firewallRules()[0].dev;
    const disabled = Q.firewallRules().find((r) => r.disabled);
    if (!disabled) throw new Error('測試資料應有停用的規則');
    App.select({ type: 'rule', key: disabled.key });
    const row = $('#detail').querySelector('.focus');
    if (!row || !row.className.includes('disabled') || !row.textContent.includes('停用')) throw new Error('停用的規則應標示');
    if (row.querySelectorAll('td')[0].style.opacity !== String(S.view.theme.firewall.disabledAlpha)) throw new Error('停用規則的透明度應取自 theme');
    const jumped = Q.firewallChains(dev).find((c) => c.jumpedFrom.length);
    if (jumped) {
      App.select({ type: 'firewall', dev });
      const d = $('#detail').querySelectorAll('details').find((x) => x.querySelector('summary').firstChild.textContent === jumped.chain);
      d.dispatch('toggle');
      const a = d.querySelectorAll('a').find((x) => x.textContent.startsWith(Q.getFirewallRule(jumped.jumpedFrom[0]).chain + ' #'));
      if (!a) throw new Error('jump 來源應可點選');
      a.click(); if (App.sel.type !== 'rule' || App.sel.key !== jumped.jumpedFrom[0]) throw new Error('點 jump 來源應定位到那條規則');
    }
    App.select({ type: 'firewall', dev });
    const defaults = Q.ipServicesOf(dev).filter((s) => s.basis === 'default');
    const svcRows = $('#detail').querySelectorAll('tbody tr').filter((tr) => Q.ipServicesOf(dev).some((s) => tr.querySelectorAll('td')[0].textContent === s.name));
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
    document.querySelectorAll('#left .tabs button')[3].click();
    const load = async (name, body) => {
      const inp = $('#pane-compare').querySelectorAll('input')[1];
      inp.files = [{ name, text: async () => body }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
    };
    const keysBefore = JSON.stringify(await S.store.get('last'));
    await load('old.json', oldJson);
    const pane = () => $('#pane-compare').querySelector('.baseline-diff');
    const t = pane().textContent;
    Object.entries({ added: '新增', removed: '移除', changed: '變更' }).forEach(([k, label]) => {
      if (!t.includes(`${label} ${expect.summary[k]}`)) throw new Error('摘要應列出' + label + '筆數');
    });
    const cats = pane().querySelectorAll('.diff-cat').map((x) => x.getAttribute('data-category'));
    const wantCats = ['device', 'link', 'vlan', 'ip', 'firewall', 'finding'].filter((c) => expect.items.some((i) => i.category === c));
    if (cats.join() !== wantCats.join()) throw new Error('應依類別分組並依序列出：' + cats);
    const kids = pane().childNodes;
    if (kids.indexOf(pane().querySelector('.diff-summary')) > kids.indexOf(pane().querySelector('.diff-cat'))) throw new Error('摘要應在分組上方');
    expect.items.forEach((i) => { if (!t.includes(i.message)) throw new Error('缺少差異：' + i.message); });
    const exposureRows = pane().querySelectorAll('tbody tr').filter((tr) => tr.className.includes('exposure'));
    if (exposureRows.length !== expect.items.filter((i) => i.effect === 'new-exposure').length) throw new Error('每個新暴露都應醒目標示');
    if (!exposureRows.every((tr) => tr.querySelectorAll('td')[0].style.background === S.view.theme.diff.exposureBg && tr.textContent.includes('新暴露'))) throw new Error('新暴露的顏色應取自 theme');
    exposureRows[0].click();
    if (App.sel.type !== 'rule' || !App.Q.getFirewallRule(App.sel.key)) throw new Error('點新暴露的規則應定位到防火牆規則');
    const filterBtn = pane().querySelectorAll('button').find((b) => b.textContent.startsWith('新暴露'));
    filterBtn.click();
    if (pane().querySelectorAll('tbody tr').some((tr) => !tr.className.includes('exposure'))) throw new Error('新暴露篩選應只列新暴露');
    if (JSON.stringify(await S.store.get('last')) !== keysBefore) throw new Error('比對結果不應存進 store');
    // schema 不同：顯示核心回報的原因，不比對
    const old1 = JSON.parse(oldJson); old1.meta.schema = 'ssot-snapshot/1'; old1.model = {};
    await load('old-v1.json', JSON.stringify(old1));
    if (!pane().textContent.includes('schema') || pane().querySelectorAll('.diff-cat').length) throw new Error('schema 不同時應顯示原因、不比對');
    await load('bad.json', '{not json');
    if (!pane().textContent.includes('無法讀取')) throw new Error('JSON 錯誤時應說明');
    // 匯出預期資料：ssot-expected/1，和同一份基準比對全部一致
    const { files } = await captureDownloads(() => {
      $('#pane-compare').querySelectorAll('button').find((b) => b.textContent === '匯出預期資料').click();
    });
    if (files.length !== 1 || !/^expected-.*\.json$/.test(files[0].name)) throw new Error('應下載預期資料 JSON：' + files.map((f) => f.name));
    const exp = JSON.parse(files[0].text);
    if (exp.schema !== 'ssot-expected/1') throw new Error('預期資料的 schema 應為 ssot-expected/1');
    require('assert').deepStrictEqual(exp, S.compare.expectedFrom(App.Q));
    const inp = $('#pane-compare').querySelector('input');
    inp.files = [{ name: files[0].name, text: async () => files[0].text }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
    if (!text('#pane-compare').includes('有差異 0')) throw new Error('匯出的預期資料和同一份基準比對應全部一致');
  });
  await step('只看新出現的：依舊基準篩選；版本不同時比對結果與篩選都提示「新出現的可能來自新版檢查」，版本相同時沒有提示', async () => {
    const Q = App.Q; const all = App.snap.findings; const key = Q.findingKey;
    const loadOld = async (name, body) => {
      document.querySelectorAll('#left .tabs button')[3].click();
      const inp = $('#pane-compare').querySelectorAll('input')[1];
      inp.files = [{ name, text: async () => body }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
      document.querySelectorAll('#left .tabs button')[0].click();
    };
    const onlyNew = () => $('#pane-findings').querySelectorAll('.chip').find((c) => c.textContent.startsWith('只看新出現的'));
    const versionHint = () => $('#pane-findings').querySelector('.only-new-version');
    const diffWarnings = () => $('#pane-compare').querySelectorAll('.diff-warning');
    // 沒有可用的舊基準（上一步最後載入的是壞掉的 JSON）：停用並說明原因
    document.querySelectorAll('#left .tabs button')[0].click();
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
      const head = $('#pane-findings').querySelectorAll('.fgroup').filter((g) => !/\b(handled|rules)\b/.test(g.className)).map((g) => g.querySelector('.head')).find((x) => x.getAttribute('aria-expanded') === 'false');
      if (!head) break; head.click();
    }
    const shown = $('#pane-findings').querySelectorAll('.fgroup').filter((g) => !/\b(handled|rules)\b/.test(g.className)).flatMap((g) => g.querySelectorAll('.fitem'));
    if (!shown.length || !shown.some((it) => it.textContent.includes(addedF.message))) throw new Error('篩選後應列出新出現的那一筆');
    // 版本不同：比對結果上方與篩選旁都提示
    old.meta.version = '0.0.1';
    await loadOld('old-version.json', JSON.stringify(old));
    const warn = S.compare.snapshots(S.query(old), Q).warnings.find((w) => w.kind === 'version');
    if (!warn) throw new Error('測試資料：版本不同時核心應有 version 的提醒');
    document.querySelectorAll('#left .tabs button')[3].click();
    const dw = diffWarnings().find((d) => d.getAttribute('data-kind') === 'version');
    if (!dw || !dw.textContent.includes(warn.message)) throw new Error('比對結果上方應顯示版本不同的提醒');
    const kids = $('#pane-compare').querySelector('.baseline-diff').childNodes;
    if (kids.indexOf($('#pane-compare').querySelector('.diff-warnings')) > kids.indexOf($('#pane-compare').querySelector('.diff-summary'))) throw new Error('提醒應在比對結果上方');
    document.querySelectorAll('#left .tabs button')[0].click();
    if (!versionHint() || !versionHint().textContent.includes('新出現的可能來自新版檢查')) throw new Error('只看新出現的應提示新出現的可能來自新版檢查');
    // 舊基準變成不可用：篩選自動關閉並停用，提示一併消失
    await loadOld('bad.json', '{not json');
    if (onlyNew().getAttribute('aria-disabled') !== 'true' || versionHint()) throw new Error('舊基準不可用時篩選應關閉並停用');
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
    document.querySelectorAll('#left .tabs button')[4].click();
    const fixedList = $('#pane-ledger').querySelectorAll('.ledger-list').find((l) => l.getAttribute('data-reason') === 'disappeared');
    if (!fixedList || !fixedList.querySelectorAll('.ledger-item').some((x) => x.getAttribute('data-key') === key)) throw new Error('本輪變化應列出已修好的項目');
    // 第三輪：又出現 → 回歸
    await buildInput(sample + '\n# round-3\n'); await App.ledgerJob;
    if (VA.ledger().items[key].status !== 'regressed') throw new Error('已修好又出現時應標為回歸');
    const nReg = Object.values(VA.ledger().items).filter((it) => it.status === 'regressed' && App.snap.findings.some((f) => App.Q.findingKey(f) === key)).length;
    const alert = $('#baseline-summary').querySelectorAll('button').find((b) => b.getAttribute('data-alert') === 'regressed');
    if (!alert || !alert.textContent.includes(`回歸 ${nReg} 項`) || !alert.className.includes('err')) throw new Error('基準摘要應醒目提示回歸筆數：' + text('#baseline-summary'));
    alert.click();
    if ($('#pane-ledger').classList.contains('hidden')) throw new Error('點回歸提示應開啟處理紀錄分頁');
    const reList = $('#pane-ledger').querySelectorAll('.ledger-list').find((l) => l.getAttribute('data-reason') === 'reappeared');
    if (!reList || !reList.textContent.includes(f06.message)) throw new Error('處理紀錄分頁應列出回歸的項目');
    reList.querySelector('.ledger-item').click();
    if (!App.sel) throw new Error('點回歸的項目應定位到那筆檢查結果');
    // 回歸的項目在檢查結果也有標示
    document.querySelectorAll('#left .tabs button')[0].click();
    const g06 = document.querySelectorAll('#pane-findings .fgroup').find((x) => { const el = x.querySelector('.head .id'); return el && el.textContent === 'F06'; });
    if (g06.querySelector('.head').getAttribute('aria-expanded') === 'false') g06.querySelector('.head').click();
    if (!$('#pane-findings').querySelectorAll('.ledger-chip').some((c) => c.getAttribute('data-status') === 'regressed')) throw new Error('檢查結果應標示回歸');
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
    const un = $('#baseline-summary').querySelectorAll('button').find((b) => b.getAttribute('data-alert') === 'unobserved');
    if (!un || !un.textContent.includes(`無法判斷 ${st.round.unobserved.length} 項`)) throw new Error('基準摘要應提示無法判斷的筆數');
    document.querySelectorAll('#left .tabs button')[4].click();
    const unList = $('#pane-ledger').querySelectorAll('.ledger-list').find((l) => l.getAttribute('data-reason') === 'unobserved');
    if (!unList || !unList.parentNode.textContent.includes('因收集失敗而無法判斷') || unList.querySelectorAll('.ledger-item').length !== Math.min(300, st.round.unobserved.length)) throw new Error('處理紀錄分頁應說明因收集失敗而無法判斷');
    // 趨勢：多輪時畫三張圖（一張一個軸），顏色取自 theme，hover 顯示該輪全部數值，表格列出每一輪
    const series = S.ledger.summary(VA.ledger()).series;
    const charts = $('#pane-ledger').querySelectorAll('.trend-chart');
    if (charts.length !== 3) throw new Error('應有三張小倍數折線圖：' + charts.length);
    const T = S.view.theme.trend;
    const lines = charts[0].querySelectorAll('path').filter((p) => p.className.includes('trend-line'));
    if (lines.map((p) => p.getAttribute('stroke')).join() !== [T.pending, T.regressed, T.accepted].join()) throw new Error('計數圖的三條線應用 theme.trend 的顏色');
    if (charts[0].querySelectorAll('.trend-legend-item').length !== 3 || charts[1].querySelector('.trend-legend')) throw new Error('多條線的圖要有圖例，單一條線的不需要');
    const hits = charts[0].querySelectorAll('rect').filter((r) => r.className.includes('trend-hit'));
    if (hits.length !== series.length) throw new Error('每一輪應有一個 hover 區');
    hits[hits.length - 1].dispatch('pointerenter');
    const tip = charts[0].querySelector('.trend-tip');
    const lastS = series[series.length - 1];
    if (tip.classList.contains('hidden') || !tip.textContent.includes(String(lastS.pending)) || !tip.textContent.includes('待處理')) throw new Error('hover 應顯示該輪的數值：' + tip.textContent);
    hits[hits.length - 1].dispatch('pointerleave');
    if (!tip.classList.contains('hidden')) throw new Error('離開時應隱藏 tooltip');
    if ($('#pane-ledger').querySelector('.trend-table').querySelectorAll('tbody tr').length !== series.length) throw new Error('表格檢視應列出每一輪');
    // 之後的步驟以範例資料進行（範例的第一輪已在處理紀錄中，不會再推進）
    await buildInput(sample); await App.ledgerJob;
  });
  await step('處理紀錄：只有一輪時顯示目前的數字、不畫圖', () => {
    const lg = S.view.app.ledger(); const one = Object.assign({}, lg, { iterations: lg.iterations.slice(-1) });
    const st = S.view.app.ledgerState(); const keep = st.ledger;
    st.ledger = one; S.view.ledgerPane.render(App);
    try {
      if ($('#pane-ledger').querySelectorAll('.trend-chart').length || !$('#pane-ledger').querySelector('.trend-single')) throw new Error('只有一輪時不應畫圖');
      if ($('#pane-ledger').querySelectorAll('.trend-tile').length !== 5) throw new Error('應列出待處理、回歸、已豁免、覆蓋率、未知對端');
    } finally { st.ledger = keep; S.view.ledgerPane.render(App); }
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
      if (!$('#pane-findings').querySelector('.ledger-blocked') || !text('#pane-ledger').includes('無法轉換')) throw new Error('檢查結果與處理紀錄分頁應說明處理紀錄無法使用');
      const btn = document.querySelectorAll('#pane-findings .ledger-edit')[0];
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
    document.querySelectorAll('#left .tabs button')[4].click();
    const btn = (cls) => $('#pane-ledger').querySelector('.' + cls);
    const { files } = await captureDownloads(() => btn('ledger-export').click());
    if (files.length !== 1 || !/^ledger-\d{8}T\d{6}Z\.json$/.test(files[0].name)) throw new Error('應下載 ledger-時間.json：' + (files[0] || {}).name);
    const exported = JSON.parse(files[0].text);
    require('assert').deepStrictEqual(exported, VA.ledger());
    if (!S.ledger.validate(exported).ok) throw new Error('匯出的處理紀錄應通過 validate');
    const importText = async (name, body) => {
      const inp = $('#pane-ledger').querySelector('.ledger-file');
      inp.files = [{ name, text: async () => body }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 10));
    };
    const before = JSON.stringify(VA.ledger());
    await importText('bad.json', JSON.stringify({ schema: 'ssot-ledger/0', items: [], iterations: {} }));
    const res = $('#pane-ledger').querySelector('.ledger-import-result');
    if (!res || !res.textContent.includes('schema') || res.querySelectorAll('li').length < 2) throw new Error('不合法時應列出 validate 的錯誤');
    if (JSON.stringify(VA.ledger()) !== before) throw new Error('不合法時不可覆蓋現有的處理紀錄');
    await importText('broken.json', '{not json');
    if (!text('#pane-ledger').includes('不是 JSON')) throw new Error('不是 JSON 時應說明');
    // 合法：先確認，按「覆蓋」才取代
    const k = Object.keys(exported.items)[0];
    const mod = JSON.parse(JSON.stringify(exported)); mod.items[k].note = '匯入的備註';
    await importText('good.json', JSON.stringify(mod));
    if (!$('#pane-ledger').querySelector('.ledger-import-confirm')) throw new Error('合法時應請使用者確認覆蓋');
    if (VA.ledger().items[k].note === '匯入的備註') throw new Error('確認前不可覆蓋');
    $('#pane-ledger').querySelector('.ledger-confirm-import').click(); await new Promise((r) => setTimeout(r, 10));
    if (VA.ledger().items[k].note !== '匯入的備註' || (await S.store.get('ledger')).items[k].note !== '匯入的備註') throw new Error('確認後應覆蓋並存進 store');
    // 還原
    await importText('restore.json', JSON.stringify(exported));
    $('#pane-ledger').querySelector('.ledger-confirm-import').click(); await new Promise((r) => setTimeout(r, 10));
  });
  await step('修正計畫：依規則、依設備或逐筆選取，依設備列出修改前（原文行號）與修改後（指令），三份 .rsc 與核心一致，下載檔名用 files() 的 base', async () => {
    const Q = App.Q; const RM = S.remediate; const RV = S.view.remediation; const PV = S.view.patchView;
    document.querySelectorAll('#left .tabs button')[0].click();
    $('#pane-findings').querySelector('.open-patch').click();
    if (!$('#dlg-patch').open) throw new Error('應開啟修正計畫');
    if (!text('#patch-body').includes('不會連線')) throw new Error('應標示本工具只產生文字，不會連線設備');
    // 同一份基準再開啟時保留上次的選取（例如從防火牆畫面開啟的）；全部清除後沒有計畫
    if (PV.state.keys.size) $('#patch-body').querySelector('.patch-clear').click();
    if (!$('#patch-body').querySelector('.patch-empty')) throw new Error('沒有選取時應說明如何選取');
    const autoIds = S.util.uniq(App.snap.findings.map((f) => f.id)).filter((id) => RM.levelOf(id) === 'auto');
    if (!autoIds.length) { if (process.env.SMOKE_INPUT) { $('#dlg-patch').close(); return; } throw new Error('範例資料應有 auto 修正'); }
    const chip = (id) => $('#patch-body').querySelectorAll('.patch-rule').find((c) => c.getAttribute('data-rule-id') === id);
    autoIds.forEach((id) => chip(id).click());
    if (chip('F03')) chip('F03').click();
    const keys = Array.from(PV.state.keys).sort(S.util.cmp);
    const want = S.util.uniq(App.snap.findings.filter((f) => autoIds.includes(f.id) || f.id === 'F03').map((f) => Q.findingKey(f))).sort(S.util.cmp);
    if (keys.join() !== want.join()) throw new Error('依規則選取應選到這些規則的全部檢查結果');
    const plan = RM.plan(Q, keys); const files = RM.files(plan);
    const devs = $('#patch-body').querySelectorAll('.patch-dev');
    if (devs.map((d) => d.getAttribute('data-dev')).join() !== plan.devices.map((d) => d.key).join()) throw new Error('應依 plan.devices 的順序分台列出');
    plan.items.forEach((it) => {
      const box = $('#patch-body').querySelectorAll('.patch-item').find((b) => b.getAttribute('data-key') === it.key);
      if (!box) throw new Error('每個 item 都應列出：' + it.key);
      if (box.querySelector('.patch-cmd').textContent !== RV.itemApplyLines(plan, it)) throw new Error('修改後應是核心產生的套用指令');
      const links = box.querySelector('.patch-before').querySelectorAll('a');
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
    const pre = () => $('#patch-body').querySelectorAll('.patch-dev')[0].querySelector('.patch-file');
    if (pre().textContent !== RM.renderRsc(plan, f0.dev)) throw new Error('預設顯示套用檔，內容應與 renderRsc 相同');
    [['rollback', RM.renderRollback], ['verify', RM.renderVerify], ['apply', RM.renderRsc]].forEach(([k, fn]) => {
      $('#patch-body').querySelectorAll('.patch-dev')[0].querySelectorAll('button').find((b) => b.getAttribute('data-kind') === k).click();
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
      const btns = $('#patch-body').querySelector('.patch-download-all').querySelectorAll('.patch-download');
      const { files: got } = await captureDownloads(() => btns.forEach((b) => b.click()));
      if (got.map((x) => x.name).join() !== [fs1[0].base + '.rsc', fs1[0].base + '-rollback.rsc', fs1[0].base + '-verify.rsc'].join()) throw new Error('單台應下載三個 .rsc：' + got.map((x) => x.name));
      if (got[0].text !== RM.renderRsc(p1, fs1[0].dev)) throw new Error('單台下載的套用檔應與 renderRsc 相同');
    }
    // 逐筆勾選
    $('#patch-body').querySelector('.patch-clear').click();
    const grp = $('#patch-body').querySelectorAll('.patch-group').find((g) => g.getAttribute('data-rule-id') === autoIds[0]);
    grp.open = true; grp.dispatch('toggle');
    const cb = grp.querySelector('.patch-pick'); cb.checked = true; cb.dispatch('change');
    if (!PV.state.keys.has(cb.getAttribute('data-key')) || PV.state.keys.size !== 1) throw new Error('逐筆勾選應加入選取');
    if (!$('#patch-body').querySelectorAll('.patch-item').length && !$('#patch-body').querySelector('.patch-skipped')) throw new Error('勾選後應產生計畫');
    $('#dlg-patch').close();
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
      const block = (k) => body().querySelectorAll('.patch-choice').find((b) => b.getAttribute('data-finding') === k);
      const radio = (k, id) => block(k).querySelectorAll('.patch-choice-opt').find((r) => r.value === id);
      const noUndefined = (where) => { if (text('#patch-body').includes('undefined')) throw new Error(where + '：修正計畫不應出現 undefined'); };
      /** 計畫中這筆選擇產生的 item 都顯示在所屬設備下：對象是伺服器（不是規則）、修改前→後、警告與核心產生的指令 */
      const checkItems = (plan, c) => c.items.map((k) => {
        const it = plan.items.find((i) => i.key === k);
        const box = body().querySelectorAll('.patch-dev').find((b) => b.getAttribute('data-dev') === it.dev).querySelectorAll('.patch-item').find((b) => b.getAttribute('data-key') === k);
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
      const majRow = block(ntpKey).querySelectorAll('.patch-choice-row').find((r) => r.getAttribute('data-option') === 'majority');
      if (!majRow.querySelector('.patch-inferred') || !majRow.textContent.includes('推論') || !majRow.textContent.includes(`${maj.basis.total} 台中 ${maj.basis.agree} 台`)) throw new Error('多數選項應標示推論與依據');
      if (!block(ntpKey).querySelector('.patch-choice-default')) throw new Error('預設採多數時應說明');
      const ntpDevs = checkItems(plan0, ntp);
      if (!ntpDevs.length || ntpDevs.some((d) => maj.basis.devs.includes(d))) throw new Error('採多數時應修改不在多數組的設備');
      if (!ntpDevs.includes('TPE_ACC_SW_12')) throw new Error('範例資料的 NTP 應修改偏離的 TPE_ACC_SW_12');
      // DNS：沒有多數時明確提示，沒有預設的選擇，也不產生指令
      const dns0 = plan0.choices.find((c) => c.findingKey === dnsKey);
      if (dns0.reason !== 'needs-choice') throw new Error('範例資料的 DNS 應沒有多數');
      if (!block(dnsKey).querySelector('.patch-choice-need').textContent.includes('沒有多數') || block(dnsKey).querySelectorAll('.patch-choice-opt').some((r) => r.checked)) throw new Error('沒有多數時應提示選擇，且沒有預選');
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
      files.forEach((f) => { if (body().querySelectorAll('.patch-dev').find((b) => b.getAttribute('data-dev') === f.dev).querySelector('.patch-file').textContent !== f.apply) throw new Error('預覽應是依選擇產生的檔案'); });
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
      if (!$('#dlg-patch').open || !block(dnsKey).querySelector('.patch-accept-done')) throw new Error('標為可接受後修正計畫應維持開啟並顯示處理紀錄的狀態');
      noUndefined('標為可接受後');
    } finally {
      PV.state.choices.clear(); $('#dlg-patch').close();
      App.importLedger('restore.json', savedLedger); await App.confirmImport();
    }
  });
  await step('原始輸出：已解析但有認不得的行時標示「部分無法辨識（N 行）」，點一下開啟第一行', () => {
    const b = App.snap.blocks.find((x) => x.adapters.length && !x.empty && x.unrecognizedLines.length && x.devKey && App.Q.getDevice(x.devKey));
    if (!b) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有部分無法辨識的區塊'); }
    App.select({ type: 'device', key: b.devKey });
    const link = $('#detail').querySelectorAll('.partial-unrecognized').find((a) => a.textContent === `部分無法辨識（${b.unrecognizedLines.length} 行）`);
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
    const link = $('#detail').querySelectorAll('a').find((x) => x.textContent.startsWith('區塊 2：'));
    if (!link) throw new Error('應可點選其他區塊');
    link.click();
    if (App.sel.domain !== ds[1].key || !text('#detail').includes(`（區塊 2／${ds.length}）`)) throw new Error('點區塊應切換到該區塊');
    if (Array.from(App.graph.hl.nodes.keys()).join() !== ds[1].devices.join()) throw new Error('圖上應只標出該區塊的設備');
    $('#detail').querySelectorAll('a').find((x) => x.textContent === '顯示所有區塊').click();
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
      const box = $('#detail').querySelectorAll('.finding').find((el) => el.textContent.includes(f.message));
      const chip = box && box.querySelector('.facet');
      if (!chip || chip.textContent !== '檢查項目：' + RV.facetText(f) || chip.getAttribute('title') !== 'facet：' + f.facet) throw new Error('詳情應在 ' + f.message + ' 的標題旁標示檢查項目');
      if (a12.some((o) => o.f !== f && box.textContent.includes('檢查項目：' + RV.facetText(o.f)))) throw new Error('每一筆只標示自己的檢查項目');
    });
    const plain = all.findIndex((f) => f.facet == null);
    if (plain >= 0) {
      App.selectFinding(plain);
      const box = $('#detail').querySelectorAll('.finding').find((el) => el.textContent.includes(all[plain].message));
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
        if (!$('#dlg-patch').open) PV.open(App);
        const rows = $('#patch-body').querySelectorAll('.patch-skip').filter((r) => r.getAttribute('data-finding') === x.key);
        if (rows.length !== 1) throw new Error('每一個鍵應恰好一列');
        if (!rows[0].textContent.includes(x.f.message) || a12.some((o) => o !== x && rows[0].textContent.includes(o.f.message))) throw new Error('每一列只列出自己的訊息');
        const link = rows[0].querySelector('.finding-ref');
        if (!link || link.getAttribute('title') !== x.f.message) throw new Error('訊息連結的 title 應是完整訊息');
        if (n === 0) link.click(); else link.dispatch('keydown', { key: 'Enter' });
        if (opened[opened.length - 1] !== x.idx) throw new Error('點擊應開啟這一筆的檢查結果');
        if ($('#dlg-patch').open) throw new Error('開啟檢查結果時應關閉修正計畫，讓詳情可見');
      });
    } finally { App.selectFinding = orig; }
    // 原因只在分組標題：每一筆不再重複寫原因或等級
    PV.open(App);
    const sk = plan.skipped.find((s) => s.findingKey === a12[0].key);
    const group = $('#patch-body').querySelectorAll('.patch-skip-group').find((g) => g.getAttribute('data-reason') === sk.reason);
    if (!group.querySelector('.patch-label').textContent.includes(RM.SKIP_TEXT[sk.reason])) throw new Error('分組標題應是 SKIP_TEXT');
    if ($('#patch-body').querySelectorAll('.patch-skip').some((r) => r.textContent.includes(RM.SKIP_TEXT[sk.reason]) || r.textContent.includes(RV.LEVEL_TEXT[sk.level]))) throw new Error('每一筆不應重複寫原因');
    // 基準中沒有的鍵：明確說明，不是空白
    const nf = $('#patch-body').querySelectorAll('.patch-skip').find((r) => r.getAttribute('data-finding') === MISSING_KEY);
    if (!nf || !nf.querySelector('.finding-missing') || nf.querySelector('.finding-missing').textContent !== RV.MISSING_FINDING_TEXT) throw new Error('基準中沒有的鍵應說明「' + RV.MISSING_FINDING_TEXT + '」');
    if (nf.querySelector('.finding-ref')) throw new Error('基準中沒有的鍵不應有連結');
    // 逐筆勾選：每一筆 A12 各一個勾選框，標示檢查項目；勾一個只加入那一筆
    $('#patch-body').querySelector('.patch-clear').click();
    const g = $('#patch-body').querySelectorAll('.patch-group').find((x) => x.getAttribute('data-rule-id') === 'A12');
    g.open = true; g.dispatch('toggle');
    const picks = g.querySelectorAll('.patch-pick');
    if (picks.map((cb) => cb.getAttribute('data-key')).sort().join('\n') !== a12.map((x) => x.key).sort().join('\n')) throw new Error('每一筆 A12 應各有一個勾選框');
    a12.forEach((x) => {
      const row = g.querySelectorAll('.patch-pick-row').find((r) => r.querySelector('.patch-pick').getAttribute('data-key') === x.key);
      if (!row.textContent.includes(x.f.message) || !row.querySelector('.facet') || row.querySelector('.facet').textContent !== RV.facetText(x.f)) throw new Error('勾選列應列出自己的訊息與檢查項目');
    });
    const ntp = byFacet.get('ntp').key;
    const pick = picks.find((cb) => cb.getAttribute('data-key') === ntp);
    pick.checked = true; pick.dispatch('change');
    if (PV.state.keys.size !== 1 || !PV.state.keys.has(ntp)) throw new Error('勾選 NTP 只應加入 NTP 那一筆');
    const after = $('#patch-body').querySelectorAll('.patch-skip').map((r) => r.getAttribute('data-finding'));
    if (after.join() !== ntp) throw new Error('只勾選 NTP 時，計畫只應有 NTP 那一筆：' + after.join('｜'));
    $('#dlg-patch').close();
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
    const rowsOf = () => $('#patch-body').querySelectorAll('.patch-skip').filter((r) => r.getAttribute('data-finding') === key);
    const rows = rowsOf();
    if (rows.length !== i03.length) throw new Error('每一筆未產生指令的項目都應列出');
    if (!rows.every((r, n) => r.textContent.includes(i03[n].f.message) && i03.every((o, m) => m === n || !r.textContent.includes(o.f.message)))) throw new Error('每一列應列出自己那一筆的訊息');
    const group = $('#patch-body').querySelectorAll('.patch-skip-group').find((x) => x.getAttribute('data-reason') === sk[0].reason);
    if (!group.querySelector('.patch-label').textContent.includes(RM.SKIP_TEXT[sk[0].reason])) throw new Error('分組標題應是 SKIP_TEXT');
    if (rows.some((r) => r.textContent.includes(RM.SKIP_TEXT[sk[0].reason]) || r.textContent.includes(RV.LEVEL_TEXT[sk[0].level]))) throw new Error('每一筆不應重複寫原因');
    const orig = App.selectFinding; const opened = [];
    App.selectFinding = (i) => { opened.push(i); return orig(i); };
    try {
      i03.forEach((x, n) => {
        if (!$('#dlg-patch').open) PV.open(App);
        const link = rowsOf()[n].querySelector('.finding-ref');
        if (!link || link.getAttribute('title') !== x.f.message) throw new Error('訊息連結的 title 應是完整訊息');
        if (n === 0) link.click(); else link.dispatch('keydown', { key: 'Enter' });
        if (opened[opened.length - 1] !== x.idx) throw new Error('點擊應開啟這一筆的檢查結果');
        if ($('#dlg-patch').open) throw new Error('開啟檢查結果時應關閉修正計畫，讓詳情可見');
      });
      if (new Set(opened).size !== i03.length) throw new Error('不同的列應開啟不同的檢查結果');
    } finally { App.selectFinding = orig; }
    // 逐筆勾選以鍵為單位：共用鍵的多段只有一個勾選框（計畫也以鍵為單位）
    PV.open(App);
    const g = $('#patch-body').querySelectorAll('.patch-group').find((x) => x.getAttribute('data-rule-id') === 'I03');
    g.open = true; g.dispatch('toggle');
    const picks = g.querySelectorAll('.patch-pick').map((cb) => cb.getAttribute('data-key'));
    if (picks.join() !== key) throw new Error('共用鍵的 I03 應只有一個勾選框：' + picks.join('｜'));
    $('#dlg-patch').close();
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
    const items = Array.from(document.querySelectorAll('#legend .li'));
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
    const th = $('#detail').querySelectorAll('th').find((el) => el.textContent.startsWith('網段'));
    if (!th) throw new Error('路由表應有可排序的網段標頭');
    th.dispatch('click');
    const order = () => $('#detail').querySelectorAll('tbody tr').map((tr) => tr.textContent).filter((s) => /^10\.\d+\.0\.0\/16/.test(s)).map((s) => s.split('/')[0]);
    if (order().join() !== '10.9.0.0,10.10.0.0,10.100.0.0') throw new Error('網段應依 IP 數值升冪：' + order());
    $('#detail').querySelectorAll('th').find((el) => el.textContent.startsWith('網段')).dispatch('click');
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
    if (!Array.from(document.querySelectorAll('#legend .li')).some((el) => /容器 veth/.test(el.textContent))) throw new Error('圖例缺少 veth');
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
    App.select(null); document.querySelectorAll('#left .tabs button')[0].click();
    const chips = $('#pane-findings').querySelector('.summary').querySelectorAll('.chip');
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
  await step('深層凍結的基準：選設備、選檢查結果、開詳情、開修正計畫、匯出，都不改寫基準也不因凍結出錯', async () => {
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
      document.querySelectorAll('#left .tabs button').forEach((b) => b.click());
      document.querySelectorAll('#left .tabs button')[0].click();
      $('#pane-findings').querySelector('.open-patch').click();
      if (!$('#dlg-patch').open) throw new Error('應開啟修正計畫');
      $('#patch-body').querySelectorAll('.patch-rule').forEach((c) => c.click());
      $('#dlg-patch').close();
      const kinds = Object.keys(S.view.exporter.KINDS);
      const { files } = await captureDownloads(() => { kinds.forEach((k) => App.exportAs(k)); App.exportAs('csv', { byDevice: true }); App.exportAs('markdown', { byDevice: true }); });
      if (files.length !== kinds.length + 2) throw new Error(`每種匯出都應產生下載（${files.length}／${kinds.length + 2}）`);
      require('assert').deepStrictEqual(JSON.parse(files[kinds.indexOf('snapshot')].text), JSON.parse(before));
      if (JSON.stringify(frozen) !== before) throw new Error('畫面不可改寫基準');
      if (errors.length) throw new Error('凍結的基準不應造成錯誤：\n' + errors.join('\n'));
    } finally {
      console.error = origError;
      VA.load(orig, null); await App.ledgerJob; await App.layoutJob;
    }
  });
  await step('清除基準（處理紀錄不受影響）', async () => {
    $('#btn-clear').click(); await new Promise((r) => setTimeout(r, 20)); if (App.snap) throw new Error('未清除');
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
