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
    if (!process.env.SMOKE_INPUT && !text('#pane-findings').includes('LLDP 單向')) throw new Error('檢查結果未顯示');
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
    const expectedMissing = App.snap.coverage.filter((row) => row.collected && row.missing.length).length;
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
  await step('點選每一筆檢查結果', () => { App.snap.findings.forEach((f, i) => { App.selectFinding(i); App.graph.draw(); }); });
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
    const hearsay = legend.find((li) => li.textContent === '單側觀察'); const domain = legend.find((li) => li.textContent === 'MNDP');
    if (!hearsay || !domain) throw new Error('圖例缺少單側觀察或 MNDP 註記');
    const hs = sw(hearsay)[0]; const ds = sw(domain)[0];
    if (hs.style.opacity !== String(T.weakEdge.hearsay.alpha) || !hs.style.background.includes(T.weakEdge.hearsay.c)) throw new Error('單側觀察圖例顏色或透明度與 theme 不一致');
    if (ds.style.opacity !== String(T.weakEdge.domainOnly.alpha) || !ds.style.background.includes(T.weakEdge.domainOnly.c)) throw new Error('MNDP 圖例顏色或透明度與 theme 不一致');
    if (T.weakEdge.domainOnly.alpha !== 0.7) throw new Error('MNDP 邊透明度應為 70%');
    if (hs.style.background === ds.style.background) throw new Error('單側觀察與 MNDP 圖例線型應可區分');
  });
  await step('MNDP 圖例、提示與細節不暗示實體直連', async () => {
    const input = 'A (10.0.0.1):\n### /ip neighbor print detail\n'
      + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    if (App.snap.meta.inputHash !== hash) throw new Error('MNDP 基準未建立');
    if (!Array.from(document.querySelectorAll('#legend .li')).some((li) => li.textContent === 'MNDP')) throw new Error('MNDP 圖例標籤應簡化為 MNDP');
    const p = Array.from(App.pairs.values()).find((x) => x.evidence === 'domainOnly');
    if (!p) throw new Error('MNDP device edge 未標記為 domain-only');
    if (p.labelA !== 'MNDP' || p.labelB !== 'MNDP') throw new Error('純 MNDP edge label 應只顯示 MNDP');
    App.graph.emit('hover', { item: { type: 'edge', id: p.id }, x: 0, y: 0 });
    if (!text('#tooltip').includes('不代表兩台設備直連')) throw new Error('圖上提示未明示 MNDP 的非直連語意');
    App.graph.emit('click', { type: 'edge', id: p.id });
    if (!text('#detail').includes('非直連確認')) throw new Error('MNDP 細節未明示非直連語意');
    const domainLink = App.snap.model.links.find((l) => l.evidenceScope === 'broadcast-domain');
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
  await step('純 MNDP 邊以專用點劃線呈現，高亮不淡化', () => {
    const graph = App.graph; const ctx = graph.ctx; const weak = S.view.theme.weakEdge;
    const old = {
      nodes: graph.nodes, edges: graph.edges, pos: graph.pos, sel: graph.sel, hl: graph.hl, hover: graph.hover,
      s: graph.s, tx: graph.tx, ty: graph.ty, stroke: ctx.stroke, setLineDash: ctx.setLineDash,
      moveTo: ctx.moveTo, lineTo: ctx.lineTo,
    };
    const nodes = ['mndp-a', 'mndp-b', 'mixed-a', 'mixed-b'].map((id) => ({
      id, label: id, kind: 'switch', collected: true, group: 'test',
    }));
    const edges = [
      { id: 'pure-mndp', a: 'mndp-a', b: 'mndp-b', cls: 'other', count: 1, evidence: 'domainOnly' },
      { id: 'mixed-evidence', a: 'mixed-a', b: 'mixed-b', cls: 'other', count: 1, evidence: 'adjacency', hasDomain: true },
    ];
    const pos = new Map([['mndp-a', { x: 0, y: 0 }], ['mndp-b', { x: 180, y: 0 }], ['mixed-a', { x: 0, y: 180 }], ['mixed-b', { x: 180, y: 180 }]]);
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
      const pure = segmentStrokes('mndp-a', 'mndp-b');
      if (!pure.some((s) => s.alpha === 0.7 && s.color === weak.domainOnly.c && s.dash.join() === weak.domainOnly.dash.join())) throw new Error('純 MNDP 邊應以灰色、70% 不透明度使用 theme 指定的高辨識點劃線');
      const mixed = segmentStrokes('mixed-a', 'mixed-b');
      if (!mixed.length || mixed.some((s) => s.alpha === 0.5)) throw new Error('混合證據邊不應套用 MNDP-only 透明度');
      graph.setSelection([], ['pure-mndp']); strokes.length = 0; graph.draw();
      if (!segmentStrokes('mndp-a', 'mndp-b').some((s) => s.alpha === 1)) throw new Error('選取高亮應維持完整不透明度');
      graph.setSelection([], []); graph.hover = { type: 'edge', id: 'pure-mndp' }; strokes.length = 0; graph.draw();
      if (!segmentStrokes('mndp-a', 'mndp-b').some((s) => s.alpha === 1)) throw new Error('hover 高亮應維持完整不透明度');
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
  await step('清除基準', async () => { $('#btn-clear').click(); await new Promise((r) => setTimeout(r, 20)); if (App.snap) throw new Error('未清除'); });
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
