// 畫面冒煙測試的極簡 DOM：載入 index.html 的 <body>、document／window 的替身、<script> 動態載入、localStorage、requestAnimationFrame。
// 只模擬畫面程式用到的部分；require 時就把 document、window 等掛到 globalThis（必須在載入畫面腳本之前）。
'use strict';
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');

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
  getAttribute(k) { return this.attrs[k] ?? null; } removeAttribute(k) { delete this.attrs[k]; if (k.startsWith('data-')) delete this.dataset[k.slice(5)]; } get id() { return this.attrs.id; } get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
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
// <html>：CSS 的深淺跟著它的 data-theme（index.html 的 inline script 在首次繪製前設一次）
const documentElement = new El('html');
// localStorage：只存配色偏好（store.js 的 S.store.theme）。Node 的 localStorage 需要旗標，這裡換成記憶體版本
const lsData = new Map();
const fakeLocalStorage = { getItem: (k) => (lsData.has(k) ? lsData.get(k) : null), setItem: (k, v) => { lsData.set(k, String(v)); }, removeItem: (k) => { lsData.delete(k); } };
Object.defineProperty(globalThis, 'localStorage', { value: fakeLocalStorage, configurable: true, writable: true });
const document = { body, head, documentElement, activeElement: body, createElement: (t) => new El(t), createElementNS: (ns, t) => Object.assign(new El(t), { namespaceURI: ns }), createTextNode: (t) => new Text_(t),
  getElementById: (id) => body.querySelector('#' + id), querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s), testAll: (s) => body.testAll(s),
  addEventListener: (t, f) => (docListeners[t] = docListeners[t] || []).push(f),
  removeEventListener: (t, f) => { docListeners[t] = (docListeners[t] || []).filter((x) => x !== f); } };
const raf = { q: [] }; // requestAnimationFrame 的佇列；放在物件上，step 才能清空或檢查它
const ctx = Object.assign(globalThis, {
  document, window: globalThis, devicePixelRatio: 1, ResizeObserver: class { observe() {} },
  requestAnimationFrame: (f) => { raf.q.push(f); return raf.q.length; }, cancelAnimationFrame: () => {},
  alert: (m) => { throw new Error('alert: ' + m); }, confirm: () => true, indexedDB: undefined, addEventListener: (t, f) => (winListeners[t] = winListeners[t] || []).push(f),
});
void ctx;
const flushRaf = (n) => { for (let i = 0; i < (n || 3); i++) { const q = raf.q; raf.q = []; q.forEach((f) => f(0)); } };

module.exports = { ClassList, Node_, Text_, El, HTMLCollection_, NodeList_, parseHtml, html, body, docListeners, winListeners, head, loadedScripts, documentElement, lsData, document, raf, flushRaf };
