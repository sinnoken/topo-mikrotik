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
const document = { body, head, activeElement: body, createElement: (t) => new El(t), createTextNode: (t) => new Text_(t),
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
/** 在輸入框貼上文字並建立基準，等到新的基準載入 */
async function buildInput(input) {
  $('#input-text').value = input; $('#input-build').click();
  const hash = S.util.hash(S.readers.PASTE + '\n' + input);
  for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
  if (App.snap.meta.inputHash !== hash) throw new Error('基準未建立：' + text('#input-status'));
  await App.layoutJob;
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
    if (rows[0].join() !== 'severity,id,title,message,entities,evidence,acknowledged,ack_kind,ack_note,device,action') throw new Error('CSV 標頭不符：' + rows[0]);
    if (rows.length - 1 !== App.snap.findings.length) throw new Error('CSV 每筆檢查結果應恰好一列');
    App.snap.findings.forEach((f, i) => {
      const r = rows[i + 1]; const ack = S.view.app.ackOf(f) || {};
      if (r[0] !== f.severity || r[1] !== f.id || r[3].replace(/^'/, '') !== f.message) throw new Error(`CSV 第 ${i + 2} 列與 ${f.id} 不符`);
      if (!f.entities.every((e) => r[4].includes(e.type + ':' + e.key))) throw new Error(`CSV ${f.id} 缺少相關實體`);
      if (r[5] !== f.evidence.map((e) => `${e.file}:${e.line}`).join('; ')) throw new Error(`CSV ${f.id} 的證據應合在同一格`);
      if (r[6] !== (ack.at || '')) throw new Error(`CSV ${f.id} 的 acknowledged 應為確認時間（未確認為空白）`);
      if (r[7] !== (ack.kind || '') || r[8].replace(/^'/, '') !== (ack.note || '')) throw new Error(`CSV ${f.id} 的 ack_kind／ack_note 應為確認的分類與原因`);
      if (r[9] !== (S.view.remediation.findingDevice(App.Q, f) || '')) throw new Error('CSV ' + f.id + ' 的 device 應為所屬設備');
      if (r[10].replace(/^'/, '') !== S.check.CATALOG[f.id].action) throw new Error('CSV ' + f.id + ' 的 action 應與 CATALOG 一致（原文照錄）');
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
    const tricky = { meta: App.snap.meta, findings: [{ id: 'T01', severity: 'warn', title: '標題, "引號"', message: '第一行\r\n第二行, "x"',
      entities: [{ type: 'device', key: 'A,B' }], evidence: [{ file: 'a.txt', line: 3, text: '' }, { file: 'b "x".txt', line: 9, text: '' }] }] };
    const tr = parseCsv(X.findingsCsv(tricky).replace(/^\uFEFF/, ''));
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
    const tmd = X.findingsMarkdown(tricky);
    if (!tmd.includes('標題, "引號"') || !tmd.includes('第一行 第二行')) throw new Error('Markdown 訊息應保留文字並把換行併成一行');
    tricky.findings[0].message = '<b>*x*</b>'; tricky.findings[0].evidence[0].text = 'a`b';
    const emd = X.findingsMarkdown(tricky);
    if (!emd.includes('\\<b\\>\\*x\\*\\</b\\>') || !emd.includes('`` a`b ``')) throw new Error('Markdown 應跳脫格式字元與行內程式碼的反引號');
  });
  let ackedKey = null; // 已確認的 finding 鍵：清除基準後要仍然存在
  await step('已確認的檢查結果：選分類與原因、另列分組、可修改、摘要排除並註明、匯出標示、舊格式相容、可取消', async () => {
    const Q = App.Q; const all = App.snap.findings;
    const problems = () => all.filter((f) => f.severity !== 'info' && !App.isAcked(f));
    const before = problems();
    if (!before.length) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有錯誤或警告'); }
    const f = before[0]; const g = before.find((x) => Q.findingKey(x) !== Q.findingKey(f));
    const KIND = S.view.remediation.ACK_KIND;
    document.querySelectorAll('#left .tabs button')[0].click();
    const group = (id) => document.querySelectorAll('#pane-findings .fgroup').find((x) => {
      const el = x.querySelector('.head .id'); return el && el.textContent === id && !x.className.includes('acked');
    });
    const ackButton = (x, label) => document.querySelectorAll('#pane-findings .ack').find((b) => b.getAttribute('aria-label') === label + x.message);
    const editor = () => $('#pane-findings').querySelector('.ack-editor');
    /** 在分類與原因的欄位填值後儲存 */
    const fillAck = async (x, kind, note) => {
      const ed = editor(); if (!ed) throw new Error('按「確認」或「修改」後應出現分類與原因的欄位');
      const sel = ed.querySelector('select');
      const values = sel.querySelectorAll('option').map((o) => o.getAttribute('value'));
      if (!['', ...Object.keys(KIND)].every((k) => values.includes(k))) throw new Error('分類應可選未分類與三種分類：' + values);
      sel.value = kind; ed.querySelector('input').value = note;
      ed.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === '儲存確認：' + x.message).click();
      await new Promise((r) => setTimeout(r, 10));
    };
    if (!ackButton(f, '確認：')) group(f.id).querySelector('.head').click();
    const snapBefore = JSON.stringify(App.snap);
    ackButton(f, '確認：').click();
    if (App.isAcked(f)) throw new Error('按「確認」只開啟分類與原因的欄位，儲存後才確認');
    // 取消：欄位關閉，不確認
    editor().querySelectorAll('button').find((b) => b.textContent === '取消').click();
    if (editor() || App.isAcked(f)) throw new Error('按「取消」應關閉欄位且不確認');
    ackButton(f, '確認：').click();
    const note1 = '設計如此, 見 "變更單" 123';
    await fillAck(f, 'accepted', note1);
    if (!App.isAcked(f)) throw new Error('儲存後應標為已確認');
    if (JSON.stringify(App.snap) !== snapBefore) throw new Error('確認是檢視狀態，不可改寫基準');
    let saved = await S.store.get('acks'); ackedKey = Q.findingKey(f);
    if (!saved || !saved[ackedKey] || !/^\d{4}-\d\d-\d\dT/.test(saved[ackedKey].at)) throw new Error('確認應以 findingKey 存進 store 的 acks，並記錄確認時間');
    if (saved[ackedKey].kind !== 'accepted' || saved[ackedKey].note !== note1) throw new Error('確認應存下分類與原因：' + JSON.stringify(saved[ackedKey]));
    const at = saved[ackedKey].at;
    // 已確認分組：預設收合，展開後列出這一筆、確認時間、分類與原因；原本的分組不再列出它
    const ackedGroup = () => document.querySelectorAll('#pane-findings .fgroup').find((x) => x.className.split(' ').includes('acked'));
    if (!ackedGroup()) throw new Error('應有「已確認」分組');
    if (ackedGroup().querySelectorAll('.fitem').length) throw new Error('「已確認」分組預設應收合');
    const nAcked = all.filter((x) => App.isAcked(x)).length;
    if (!ackedGroup().querySelector('.head').textContent.includes(String(nAcked))) throw new Error('「已確認」分組應顯示筆數');
    ackedGroup().querySelector('.head').click();
    const gt = ackedGroup().textContent;
    if (!gt.includes(f.message) || !gt.includes('已確認：')) throw new Error('展開「已確認」應列出該筆與確認時間');
    if (!gt.includes(KIND.accepted) || !gt.includes('原因：' + note1)) throw new Error('已確認的項目應顯示分類與原因');
    const others = document.querySelectorAll('#pane-findings .fgroup').filter((x) => !x.className.includes('acked'));
    if (others.some((x) => x.textContent.includes(f.message) && all.filter((y) => y.message === f.message).length === 1)) throw new Error('已確認的項目不應留在原本的分組');
    // 修改：分類與原因可改，確認時間不變
    ackButton(f, '修改確認：').click();
    if (editor().querySelector('select').value !== 'accepted' || editor().querySelector('input').value !== note1) throw new Error('修改時應帶出原本的分類與原因');
    const note2 = '=SUM(A1) 是誤判';
    await fillAck(f, 'false-positive', note2);
    saved = await S.store.get('acks');
    if (saved[ackedKey].at !== at || saved[ackedKey].kind !== 'false-positive' || saved[ackedKey].note !== note2) throw new Error('修改後應更新分類與原因、保留確認時間：' + JSON.stringify(saved[ackedKey]));
    if (!ackedGroup().textContent.includes(KIND['false-positive'])) throw new Error('修改後應顯示新的分類');
    // 詳情的檢查結果區塊也標出確認的分類
    App.selectFinding(all.indexOf(f));
    if (text('#detail').includes(f.message) && !text('#detail').includes(KIND['false-positive'])) throw new Error('詳情的檢查結果應標出確認的分類');
    document.querySelectorAll('#left .tabs button')[0].click();
    if (ackedGroup().querySelectorAll('.fitem').length) ackedGroup().querySelector('.head').click();
    // 基準摘要：錯誤／警告排除已確認，並註明已確認筆數
    const summary = text('#baseline-summary'); const left = problems();
    const err = left.filter((x) => x.severity === 'error').length; const warn = left.filter((x) => x.severity === 'warn').length;
    if (left.length !== before.length - 1) throw new Error('確認一筆後，待處理的問題應少一筆');
    if (left.length && !summary.includes(`${err} 項錯誤、${warn} 項警告`)) throw new Error('基準摘要的計數應排除已確認：' + summary);
    if (!summary.includes(`另有 ${nAcked} 項已確認`)) throw new Error('基準摘要應註明已確認筆數：' + summary);
    // 匯出：CSV 的 acknowledged／ack_kind／ack_note 欄，Markdown 標示已確認、分類與原因
    const X = S.view.exporter; const opts = { acked: S.view.app.ackOf };
    const rows = parseCsv(X.findingsCsv(App.snap, opts).replace(/^﻿/, ''));
    const rowOf = (x) => rows[all.indexOf(x) + 1];
    if (rowOf(f)[6] !== at || all.filter((x) => !App.isAcked(x)).some((x) => rowOf(x)[6] !== '')) throw new Error('CSV 的 acknowledged 欄應只在已確認的列填確認時間');
    if (rowOf(f)[7] !== 'false-positive' || rowOf(f)[8] !== "'" + note2) throw new Error('CSV 的 ack_kind／ack_note 應為分類與原因（公式開頭加 \'）：' + rowOf(f));
    if (all.filter((x) => !App.isAcked(x)).some((x) => rowOf(x)[7] !== '' || rowOf(x)[8] !== '')) throw new Error('未確認的列 ack_kind／ack_note 應為空白');
    const md = X.findingsMarkdown(App.snap, opts);
    if (!md.includes(`**已確認**（${at}）［${KIND['false-positive']}］`) || !md.includes(`- 已確認：${nAcked}`)) throw new Error('Markdown 應標示已確認的項目、分類與筆數');
    if (!md.includes('確認原因：' + note2)) throw new Error('Markdown 應列出確認原因');
    // 舊格式相容：{ at } 讀成未分類，不出錯也不丟掉；未知的分類與其他欄位原樣保留
    if (g) {
      const legacyAt = '2025-01-02T00:00:00.000Z';
      const futureKey = JSON.stringify(['ZZ99', 'device:不在這份基準']);
      await S.store.set('acks', Object.assign({}, saved, { [Q.findingKey(g)]: { at: legacyAt }, [futureKey]: { at: legacyAt, kind: 'future-kind', extra: 1 } }));
      await S.view.app.loadAcks(); S.view.app.renderAll();
      const la = S.view.app.ackOf(g);
      if (!la || la.at !== legacyAt || la.kind !== null || la.note !== '') throw new Error('舊格式 { at } 應讀成未分類：' + JSON.stringify(la));
      if (!App.isAcked(f) || S.view.app.ackOf(f).kind !== 'false-positive') throw new Error('重新讀取後新格式的確認應保留');
      if (!ackedGroup().querySelectorAll('.fitem').length) ackedGroup().querySelector('.head').click();
      if (!ackedGroup().textContent.includes('未分類')) throw new Error('舊格式的確認應顯示「未分類」');
      const lr = parseCsv(X.findingsCsv(App.snap, opts).replace(/^﻿/, ''))[all.indexOf(g) + 1];
      if (lr[6] !== legacyAt || lr[7] !== '' || lr[8] !== '') throw new Error('舊格式的確認：acknowledged 為確認時間，ack_kind／ack_note 為空白：' + lr);
      // 舊格式也可補上分類
      ackButton(g, '修改確認：').click(); await fillAck(g, 'scheduled', '');
      saved = await S.store.get('acks');
      if (saved[Q.findingKey(g)].at !== legacyAt || saved[Q.findingKey(g)].kind !== 'scheduled') throw new Error('舊格式補上分類後應保留原本的確認時間');
      if (!saved[futureKey] || saved[futureKey].kind !== 'future-kind' || saved[futureKey].extra !== 1) throw new Error('寫回 store 時不可丟掉其他確認紀錄或未知欄位：' + JSON.stringify(saved[futureKey]));
      // 取消：回到原本的分組
      if (!ackedGroup().querySelectorAll('.fitem').length) ackedGroup().querySelector('.head').click();
      ackButton(g, '取消確認：').click(); await new Promise((r) => setTimeout(r, 10));
      if (App.isAcked(g) || (await S.store.get('acks'))[Q.findingKey(g)]) throw new Error('取消確認後應移除紀錄');
      if (problems().length !== left.length) throw new Error('取消確認後應算回待處理的問題');
      await App.clearAcks([futureKey]);
    }
  });
  await step('檢查結果依設備分組：依第一個設備實體或實體所屬設備，不屬於任何設備的另一組；匯出可依設備排序', async () => {
    const Q = App.Q; const all = App.snap.findings; const R = S.view.remediation; const K = S.keys;
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
    R.sortByDevice(Q, all).forEach((r) => { if (!App.isAcked(r.f)) S.util.getOr(want, r.dev, () => []).push(r.idx); });
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
  await step('防火牆修正範例：F01／F02／F06（與 F03）產生停用指令，以 comment 或屬性 find，附驗證、回復與多條符合的警告', () => {
    const Q = App.Q; const all = App.snap.findings; const R = S.view.remediation;
    const idxs = all.map((f, i) => i).filter((i) => R.DISABLE_FIX[all[i].id] && all[i].entities.some((e) => e.type === 'rule'));
    if (!process.env.SMOKE_INPUT && !['F01', 'F02', 'F03', 'F06'].every((id) => idxs.some((i) => all[i].id === id))) throw new Error('範例資料應有 F01、F02、F03、F06');
    let warnedOnce = false;
    idxs.forEach((i) => {
      const f = all[i]; const rule = Q.getFirewallRule(f.entities.find((e) => e.type === 'rule').key);
      App.selectFinding(i);
      if (!text('#detail').includes('修正範例（停用規則）')) throw new Error(`${f.id} 的防火牆畫面應有修正範例`);
      const box = $('#detail').querySelectorAll('.fw-fix').find((b) => b.getAttribute('data-rule') === rule.key);
      if (!box) throw new Error(`${f.id} 的修正範例應對應它指向的規則`);
      const cmd = box.querySelector('.fix-cmd').textContent;
      const path = `/${rule.family} firewall ${rule.table}`;
      const lines = cmd.split('\n').filter((l) => l && !l.startsWith('#'));
      if (!cmd.startsWith('# 範例，執行前請核對')) throw new Error('指令應標示「範例，執行前請核對」');
      if (lines.length !== 3) throw new Error('應有停用、驗證、回復三行指令：' + cmd);
      const where = lines[1].slice((path + ' print where ').length);
      if (!lines[1].startsWith(path + ' print where ')) throw new Error('驗證應是 print where，路徑依位址族與表：' + lines[1]);
      if (lines[0] !== `${path} set [find where ${where}] disabled=yes`) throw new Error('停用應以 find 設定 disabled=yes：' + lines[0]);
      if (lines[2] !== `${path} set [find where ${where}] disabled=no`) throw new Error('回復應以同一個 find 設定 disabled=no：' + lines[2]);
      if (lines.some((l) => /numbers=|\bset \d/.test(l)) || where.includes('position')) throw new Error('不可用規則編號');
      if (!where.startsWith('chain=' + R.quote(rule.chain) + ' ')) throw new Error('find 應限定 chain');
      // find 的條件來自規則本身：comment，或比對條件（action＋match）
      const byComment = where.includes(' comment='); const byMatch = where.includes(' action=');
      if (!byComment && !byMatch) throw new Error('find 應用 comment 或比對條件');
      if (byComment && !where.includes('comment=' + R.quote(rule.comment))) throw new Error('comment find 應使用規則的註解');
      if (byMatch && !Object.entries(rule.match).every(([k, v]) => where.includes(`${k}=${R.quote(v)}`))) throw new Error('沒有 comment 時應以規則的 match 欄位組 find');
      if (!rule.comment && !byMatch) throw new Error('沒有 comment 的規則應以比對條件 find');
      // 多條符合的警告：與用 Q.firewallRulesOf 自行檢查的結果一致
      const others = Q.firewallRulesOf(rule.dev, { family: rule.family, table: rule.table, chain: rule.chain }).filter((r) => r.key !== rule.key
        && (!byComment || r.comment === rule.comment)
        && (!byMatch || (r.action === rule.action && Object.entries(rule.match).every(([k, v]) => r.match[k] === v) && Object.entries(rule.params).every(([k, v]) => r.params[k] === v))));
      const warned = box.textContent.includes('這個 find 可能符合多條規則');
      if (warned !== others.length > 0) throw new Error(`${f.id} 的多條符合警告應與同 chain 的規則一致（另有 ${others.length} 條）`);
      if (warned && !others.every((r) => box.textContent.includes(`第 ${r.position} 條`))) throw new Error('警告應列出也符合的規則');
      warnedOnce = warnedOnce || warned;
      if ((f.id === 'F03') !== box.textContent.includes('確認 WAN 已不需要')) throw new Error('只有 F03 需要註明先確認不需要再停用');
    });
    if (!process.env.SMOKE_INPUT && !warnedOnce) throw new Error('範例資料的 F02（重複規則）應警告 find 可能符合多條規則');
    // 不適用停用處理的檢查不產生指令
    const other = all.find((f) => f.entities.some((e) => e.type === 'rule') && !R.DISABLE_FIX[f.id]);
    if (other && R.disableRuleFix(Q, other) !== null) throw new Error(`${other.id} 不應產生停用指令`);
    if (idxs.length) {
      // 複製：模擬環境沒有剪貼簿，應說明請手動複製（不靜默失敗）
      $('#detail').querySelector('.copy-fix').click();
      if (!text('#banner').includes('複製')) throw new Error('複製後應有提示：' + text('#banner'));
      // 設備的防火牆畫面：收合列出這台設備全部的修正範例
      const dev = Q.getFirewallRule(all[idxs[0]].entities.find((e) => e.type === 'rule').key).dev;
      App.select({ type: 'firewall', dev, key: dev });
      const n = Q.findingsFor('device', dev).filter((f) => R.disableRuleFix(Q, f)).length;
      const fold = $('#detail').querySelectorAll('details').find((d) => d.querySelector('summary').textContent.startsWith('修正範例'));
      if (!fold || fold.querySelector('summary .chip').textContent !== String(n)) throw new Error('設備的防火牆畫面應收合列出全部修正範例與筆數');
    }
    // 跳脫與路徑：IPv6 raw、含引號與 $ 的註解、否定與逗號清單的值
    const r6 = { key: 'X|ipv6|raw|prerouting|a', dev: 'X', family: 'ipv6', table: 'raw', chain: 'prerouting', position: 2, action: 'drop',
      match: { 'in-interface-list': '!LAN', 'dst-port': '80,443', protocol: 'tcp' }, params: {}, comment: 'say "hi" $x', commentEncoding: 'utf-8', src: [] };
    const wider = Object.assign({}, r6, { key: 'X|ipv6|raw|prerouting|b', position: 1, comment: 'other', match: Object.assign({ 'src-address': '2001:db8::/32' }, r6.match) });
    const stub = { getFirewallRule: (k) => [r6, wider].find((r) => r.key === k) || null, firewallRulesOf: () => [wider, r6], devName: (k) => k, block: () => null };
    const x = R.disableRuleFix(stub, { id: 'F01', entities: [{ type: 'rule', key: r6.key }] });
    if (x.path !== '/ipv6 firewall raw' || !x.text.includes('/ipv6 firewall raw set [find where chain=prerouting comment="say \\"hi\\" \\$x"] disabled=yes')) throw new Error('IPv6 raw 的路徑與註解跳脫不正確：\n' + x.text);
    if (x.warnings.length) throw new Error('註解唯一時不應警告');
    r6.commentEncoding = 'big5';
    const y = R.disableRuleFix(stub, { id: 'F01', entities: [{ type: 'rule', key: r6.key }] });
    if (y.by !== 'match' || !y.where.includes('in-interface-list="!LAN"') || !y.where.includes('dst-port="80,443"')) throw new Error('無法比對的註解應改用比對條件，否定與清單的值要加引號：' + y.where);
    if (y.others.length !== 1 || !y.text.includes('可能符合多條規則')) throw new Error('條件更寬的規則也符合 find 時應警告');
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
      const dr = R.devicesCsvDraft(clone, S.query(clone)); const r2 = collectInventory(dr.text);
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
    if (document.querySelectorAll('#legend .lg-group').length !== 4) throw new Error('圖例應分為四類');
    const groupTitles = document.querySelectorAll('#legend .lg-title').map((el) => el.textContent);
    if (groupTitles.join('|') !== '設備|終端|連線|連線註記') throw new Error('圖例分類順序應為設備、終端、連線、連線註記');
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
      if (!l.style.background.includes(st.c) || l.style.height !== Math.max(2, Math.round(st.w)) + 'px') throw new Error('圖例連線色或線寬與 theme 不一致：' + k);
      if (!!st.dash !== l.style.background.includes('repeating-linear-gradient')) throw new Error('圖例連線虛線與 theme 不一致：' + k);
    });
    const edgeLegend = (k) => legend.find((li) => li.textContent === S.view.CLS[k]);
    const oneG = edgeLegend('1g'); const other = edgeLegend('other');
    if (!oneG || !other || !oneG.getAttribute('title').includes('不代表實際協商速率')) throw new Error('1G 圖例需說明其為介面名稱推估，而非實際協商速率');
    if (T.edge['1g'].c === T.edge.other.c || T.edge['1g'].w <= T.edge.other.w) throw new Error('1G 連線樣式應明顯區別於其他連線');
    let keyboardLinkActivated = false;
    const keyboardLink = S.view.h('a', { class: 'link', onclick: () => { keyboardLinkActivated = true; } }, '鍵盤連結');
    if (keyboardLink.getAttribute('tabindex') !== '0' || keyboardLink.getAttribute('role') !== 'link') throw new Error('動態連結需具備鍵盤焦點與連結語意');
    keyboardLink.dispatch('keydown', { key: 'Enter' });
    if (!keyboardLinkActivated) throw new Error('動態連結按 Enter 應觸發操作');
    const hearsay = legend.find((li) => li.textContent === '單側觀察'); const inferred = legend.find((li) => li.textContent === '推論鏈路');
    if (!hearsay || !inferred) throw new Error('圖例缺少單側觀察或推論鏈路註記');
    if (legend.some((li) => li.textContent === 'MNDP')) throw new Error('MNDP 不畫在圖上，圖例不應列出');
    const hs = sw(hearsay)[0]; const is = sw(inferred)[0];
    if (hs.style.opacity !== String(T.weakEdge.hearsay.alpha) || !hs.style.background.includes(T.weakEdge.hearsay.c)) throw new Error('單側觀察圖例顏色或透明度與 theme 不一致');
    if (is.style.opacity !== String(T.weakEdge.inferred.alpha) || !is.style.background.includes(T.weakEdge.inferred.c)) throw new Error('推論鏈路圖例顏色或透明度與 theme 不一致');
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
  await step('只看新出現的與修復追蹤：依舊基準篩選新出現的檢查結果；已排程修復分成已修復／仍存在／變更，可清掉已修復的確認', async () => {
    const Q = App.Q; const all = App.snap.findings; const key = Q.findingKey;
    const loadOld = async (name, body) => {
      document.querySelectorAll('#left .tabs button')[3].click();
      const inp = $('#pane-compare').querySelectorAll('input')[1];
      inp.files = [{ name, text: async () => body }]; inp.dispatch('change', { target: inp }); await new Promise((r) => setTimeout(r, 20));
      document.querySelectorAll('#left .tabs button')[0].click();
    };
    const onlyNew = () => $('#pane-findings').querySelectorAll('.chip').find((c) => c.textContent.startsWith('只看新出現的'));
    // 沒有可用的舊基準（上一步最後載入的是壞掉的 JSON）：停用並說明原因
    document.querySelectorAll('#left .tabs button')[0].click();
    if (!onlyNew() || onlyNew().getAttribute('aria-disabled') !== 'true') throw new Error('沒有舊基準時「只看新出現的」應停用');
    if (!text('#pane-findings').includes('載入舊基準後')) throw new Error('停用時應說明原因');
    // 舊基準：由目前的基準改出來，讓每一組的關係都確定
    const count = new Map(); all.forEach((f) => count.set(key(f), (count.get(key(f)) || 0) + 1));
    const uniq = all.filter((f) => count.get(key(f)) === 1);
    if (uniq.length < 4) throw new Error('測試資料應有足夠的檢查結果');
    const [addedF, changedF, openF, acceptedF] = uniq;
    const fake = { id: openF.id, severity: openF.severity, cat: openF.cat, title: openF.title, message: '只在舊基準的問題', entities: [{ type: 'device', key: '已移除的設備' }], evidence: [] };
    const old = JSON.parse(JSON.stringify(App.snap));
    old.findings = old.findings.filter((f) => key(f) !== key(addedF)).map((f) => (key(f) === key(changedF) ? Object.assign({}, f, { message: f.message + '（舊訊息）' }) : f)).concat([fake]);
    await App.ackFinding(changedF, true, { kind: 'scheduled' }); await App.ackFinding(openF, true, { kind: 'scheduled', note: '下次維護' });
    await App.ackFinding(fake, true, { kind: 'scheduled' }); await App.ackFinding(acceptedF, true, { kind: 'accepted' });
    await loadOld('old-modified.json', JSON.stringify(old));
    // 修復追蹤在比對結果上方，三組各自列出
    const pane = $('#pane-compare').querySelector('.baseline-diff'); const kids = pane.childNodes;
    const ft = pane.querySelector('.fix-tracking');
    if (!ft || kids.indexOf(ft) < 0 || kids.indexOf(ft) > kids.indexOf(pane.querySelector('.diff-summary'))) throw new Error('修復追蹤應在比對結果上方');
    const grp = (k) => ft.querySelectorAll('.fix-group').find((g) => g.getAttribute('data-fix') === k);
    const summary = ft.querySelector('.fix-summary').textContent;
    if (!['已修復 1', '仍存在 1', '變更 1'].every((s) => summary.includes(s))) throw new Error('修復追蹤的摘要不符：' + summary);
    if (!grp('fixed').textContent.includes(fake.message)) throw new Error('新基準已沒有的應列為已修復');
    if (!grp('open').textContent.includes(openF.message)) throw new Error('訊息相同的應列為仍存在');
    if (!grp('changed').textContent.includes(changedF.message + '（舊訊息）') || !grp('changed').textContent.includes(changedF.message)) throw new Error('訊息不同的應列為變更，並列出新舊訊息');
    if (ft.textContent.includes(acceptedF.message)) throw new Error('只追蹤「已排程修復」的確認');
    // 點仍存在的項目定位到目前基準的那一筆
    grp('open').querySelector('tbody tr').click();
    if (!App.sel) throw new Error('點修復追蹤的項目應定位');
    // 清掉已修復的確認：只清已修復的，其他確認保留
    ft.querySelectorAll('button').find((b) => b.textContent.startsWith('清掉已修復的確認')).click(); await new Promise((r) => setTimeout(r, 10));
    const saved = await S.store.get('acks');
    if (saved[key(fake)]) throw new Error('已修復的確認應被清掉');
    if (!saved[key(openF)] || !saved[key(changedF)] || !saved[key(acceptedF)]) throw new Error('其他確認應保留');
    const ft2 = $('#pane-compare').querySelector('.fix-tracking');
    if (ft2.querySelectorAll('.fix-group').some((g) => g.getAttribute('data-fix') === 'fixed') || !ft2.textContent.includes('已修復 0')) throw new Error('清掉後已修復應為 0');
    // 只看新出現的：依 S.compare.snapshots 的 finding added
    const added = new Set(S.compare.snapshots(S.query(old), Q).items.filter((i) => i.category === 'finding' && i.change === 'added').map((i) => i.key));
    if (!added.has(key(addedF))) throw new Error('測試資料：舊基準拿掉的檢查結果應是新出現的');
    if (onlyNew().getAttribute('aria-disabled') === 'true') throw new Error('載入舊基準後「只看新出現的」應可用');
    const nNew = all.filter((f) => added.has(key(f))).length;
    if (!onlyNew().textContent.includes(String(nNew))) throw new Error('「只看新出現的」應顯示新出現的筆數');
    if (!text('#pane-findings').includes('新出現')) throw new Error('未篩選時新出現的項目應標示');
    onlyNew().click();
    if (onlyNew().getAttribute('aria-pressed') !== 'true') throw new Error('「只看新出現的」應可切換');
    // 展開全部分組（不含已確認與規則狀態），列出的都要是新出現的
    for (let n = 0; n < 200; n++) {
      const head = $('#pane-findings').querySelectorAll('.fgroup').filter((g) => !/\b(acked|rules)\b/.test(g.className)).map((g) => g.querySelector('.head')).find((x) => x.getAttribute('aria-expanded') === 'false');
      if (!head) break; head.click();
    }
    const shown = $('#pane-findings').querySelectorAll('.fgroup').filter((g) => !/\b(acked|rules)\b/.test(g.className)).flatMap((g) => g.querySelectorAll('.fitem'));
    const newMsgs = new Set(all.filter((f) => added.has(key(f)) && !App.isAcked(f)).map((f) => f.message));
    if (!shown.length || shown.some((it) => !Array.from(newMsgs).some((m) => it.textContent.includes(m)))) throw new Error('篩選後只應列出新出現的檢查結果');
    if (!shown.some((it) => it.textContent.includes(addedF.message))) throw new Error('篩選後應列出新出現的那一筆');
    // 舊基準變成不可用：篩選自動關閉並停用
    await loadOld('bad.json', '{not json');
    if (onlyNew().getAttribute('aria-disabled') !== 'true' || $('#pane-findings').querySelectorAll('.fitem').length === 0 && all.length) throw new Error('舊基準不可用時篩選應關閉並停用');
    await App.clearAcks([key(openF), key(changedF), key(acceptedF)]);
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
      if (!pure.some((s) => s.alpha === weak.inferred.alpha && s.color === weak.inferred.c && s.dash.join() === weak.inferred.dash.join())) throw new Error('推論鏈路應使用 theme 指定的顏色、透明度與虛線');
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
  await step('veth 連線以專用顏色識別', async () => {
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
    if (v.ifStyle || v.color === '#d81b60') throw new Error('veth 節點外觀不應改變，只識別連線');
    const ve = App.graph.edges.find((x) => x.b === v.id); const ee = App.graph.edges.find((x) => x.b === e.id);
    if (!ve || !ve.ifStyle || ve.ifStyle.c !== '#d81b60' || ee.ifStyle) throw new Error('veth 連線應帶專用色，其他連線不變');
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
  await step('滑過左右欄與工具列時不會穿透觸發拓樸圖 hover', () => {
    const g = App.graph; const cv = $('#graph');
    const move = (target, p) => (winListeners.mousemove || []).forEach((f) => f({ target, clientX: p.x, clientY: p.y }));
    const n = g.nodes.find((x) => g.visible(x)); const p = g.toScreen(g.pos.get(n.id));
    move(cv, p); if (!g.hover || g.hover.id !== n.id) throw new Error('畫布上的節點應可 hover');
    [$('#left'), $('#right'), $('#btn-fit')].forEach((el) => {
      move(el, p);
      if (g.hover) throw new Error(`指標在 #${el.id} 上時不應 hover 到底下的節點`);
      if (!$('#tooltip').classList.contains('hidden')) throw new Error('指標離開畫布時提示應隱藏');
    });
  });
  await step('清除基準（已確認的檢查結果不受影響）', async () => {
    $('#btn-clear').click(); await new Promise((r) => setTimeout(r, 20)); if (App.snap) throw new Error('未清除');
    if (ackedKey && !((await S.store.get('acks')) || {})[ackedKey]) throw new Error('清除基準不應清掉已確認的檢查結果');
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
