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
const docListeners = {};
const document = { body, activeElement: body, createElement: (t) => new El(t), createTextNode: (t) => new Text_(t),
  getElementById: (id) => body.querySelector('#' + id), querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s),
  addEventListener: (t, f) => (docListeners[t] = docListeners[t] || []).push(f),
  removeEventListener: (t, f) => { docListeners[t] = (docListeners[t] || []).filter((x) => x !== f); } };
let rafQ = [];
const ctx = Object.assign(globalThis, {
  document, window: globalThis, devicePixelRatio: 1, ResizeObserver: class { observe() {} },
  requestAnimationFrame: (f) => { rafQ.push(f); return rafQ.length; }, cancelAnimationFrame: () => {},
  alert: (m) => { throw new Error('alert: ' + m); }, confirm: () => true, indexedDB: undefined, addEventListener: () => {},
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
  await step('載入範例並建立基準', async () => {
    await App.loadSample(); if (!$('#input-text').value.includes('TPE_CORE_RT_01')) throw new Error('範例未載入');
    if (process.env.SMOKE_INPUT) $('#input-text').value = fs.readFileSync(process.env.SMOKE_INPUT, 'utf8');
    const t0 = Date.now();
    $('#input-build').click(); for (let i = 0; i < 4000 && !App.snap; i++) await new Promise((r) => setTimeout(r, 5));
    if (process.env.SMOKE_INPUT) console.log('      建立＋繪製：' + (Date.now() - t0) + ' ms，節點 ' + App.graph.nodes.length);
    if (!App.snap) throw new Error('基準未建立：' + text('#input-status'));
    await new Promise((r) => setTimeout(r, 20));
    if (!process.env.SMOKE_INPUT && !text('#pane-findings').includes('LLDP 單向')) throw new Error('檢查結果未顯示');
    if (!$('#welcome').classList.contains('hidden')) throw new Error('歡迎畫面未隱藏');
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
      g.emit('click', { type: 'node', id: v[0].id }); if (App.sel.type !== 'endpoints') throw new Error('點群組應顯示末端清單'); return;
    }
    if (!v.some((n) => n.kind === 'endpoint')) throw new Error('應有單一 MAC 的未知對端');
    if (!v.every((n) => g.pos.has(n.id) && g.edgesByNode.has(n.id))) throw new Error('未知對端缺少位置或連線');
    const one = v.find((n) => n.kind === 'endpoint'); g.hover = { type: 'node', id: one.id }; g.draw(); g.hover = null;
    g.emit('click', { type: 'node', id: one.id }); if (App.sel.type !== 'interface') throw new Error('點選單一未知對端應顯示該介面');
    // 收合：上限降到 3 → 每台設備的末端合併成一個群組
    App.UNKNOWN_EXPAND_MAX = 3; App.expanded = new Set(); App.toggleExpand('TPE_ACC_SW_01'); App.toggleExpand('TPE_ACC_SW_01');
    const cl = g.nodes.filter((n) => n.kind === 'cluster'); if (!cl.length) throw new Error('超過上限時應收合成群組');
    g.draw(); g.emit('click', { type: 'node', id: cl[0].id }); if (App.sel.type !== 'endpoints' || !text('#detail').includes('個埠')) throw new Error('點群組應顯示末端清單');
    g.emit('dblclick', { type: 'node', id: cl[0].id });
    if (g.nodes.some((n) => n.id === cl[0].id)) throw new Error('雙擊群組應展開');
    if (g.nodes.filter((n) => n.virtual && n.parent === cl[0].parent && n.kind !== 'cluster').length !== 8) throw new Error('展開後應有 8 個末端');
    App.UNKNOWN_EXPAND_MAX = 8; App.expanded = new Set();
    $('#btn-unknown').click(); g.draw(); if (g.nodes.filter((n) => g.visible(n) && n.virtual).length) throw new Error('關閉開關後不應顯示未知對端');
    $('#btn-unknown').click();
    // 搜尋 MAC → 高亮未知對端節點
    const m = App.snap.model.macs.find((x) => x.edge.length === 1 && App.vOfEp.has(x.edge[0]));
    if (m) { App.select({ type: 'mac', key: m.mac }, { focus: true }); if (!g.hl.nodes.has(App.vOfEp.get(m.edge[0]))) throw new Error('MAC 搜尋應標出未知對端'); }
    // 檢查結果 A03 → 顯示末端清單
    const i = App.snap.findings.findIndex((f) => f.id === 'A03'); if (i >= 0) { App.selectFinding(i); if (App.sel.type !== 'endpoints') throw new Error('A03 應顯示末端清單'); }
  });
  await step('點選每一筆檢查結果', () => { App.snap.findings.forEach((f, i) => { App.selectFinding(i); App.graph.draw(); }); });
  await step('點選每台設備、每條連結、部分介面', () => {
    App.snap.model.devices.slice(0, 300).forEach((d) => App.select({ type: 'device', key: d.key }, { focus: true }));
    App.snap.model.links.slice(0, 300).forEach((l) => App.select({ type: 'link', key: l.key }));
    App.snap.model.interfaces.slice(0, 120).forEach((i) => App.select({ type: 'interface', key: i.key }));
    const p = Array.from(App.pairs.values()).find((x) => x.links.length > 1); App.select({ type: 'pair', id: p.id, links: p.links, devs: [p.a, p.b] });
    if (!text('#detail').includes('條連結')) throw new Error('多連結明細未顯示');
  });
  await step('MAC、IP、VLAN 查詢與圖上標示', () => {
    App.snap.model.macs.slice(0, 40).forEach((m) => App.select({ type: 'mac', key: m.mac }));
    ['10.1.20.11', '10.1.30.11', '10.255.1.1', '9.9.9.9'].forEach((ip) => App.select({ type: 'ip', key: ip }));
    App.select({ type: 'vlan', key: '30' }); App.graph.draw();
    if (!process.env.SMOKE_INPUT && !text('#detail').includes('只有一端有此 VLAN 的連結')) throw new Error('VLAN 不一致未顯示');
  });
  await step('搜尋框', async () => {
    const inp = $('#search'); inp.value = 'acc_sw_0'; inp.dispatch('input'); await new Promise((r) => setTimeout(r, 150));
    if (!text('#search-dd').includes('_ACC_SW_0')) throw new Error('搜尋結果不正確');
    inp.dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'device') throw new Error('Enter 應選取設備');
  });
  await step('路由追蹤', () => {
    $('#btn-trace').click(); $('#trace-src').value = '10.1.30.15'; $('#trace-dst').value = '8.8.8.8'; $('#trace-run').click();
    if (!text('#detail').includes('下一跳不在基準內') && !text('#detail').includes('逐跳')) throw new Error('追蹤結果未顯示');
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
    [`設備 ${m.devices.length + App.Q.endpointEntries().length}`, `介面 ${m.interfaces.length}`, `IP ${ips.length}`, `MAC ${new Set(rows.map((r) => r.mac)).size}`, `VLAN ${m.vlans.length}`].forEach((x) => { if (!t.includes(x)) throw new Error('清單缺少分類：' + x); });
    if (new Set(ips.map((r) => r.ip)).size !== ips.length) throw new Error('IP 清單應去重複');
    const macChip = document.querySelectorAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('MAC'));
    if (new Set(rows.map((r) => r.mac)).size !== App.snap.meta.stats.macs) throw new Error('清單的不重複 MAC 數應等於總覽');
    const nEnd = App.Q.endpointEntries().length; const unk = App.snap.model.interfaces.filter((i) => i.unknownPeer).length;
    if (nEnd < unk || new Set(App.Q.endpointEntries().map((e) => e.key)).size !== unk) throw new Error('末端的不重複介面數應等於未知對端介面數，且不可少於它');
    document.querySelectorAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('設備')).click();
    const t0 = text('#pane-inventory'); ['全部 ' + (m.devices.length + nEnd), '末端 ' + nEnd].forEach((x) => { if (!t0.includes(x)) throw new Error('設備清單缺少分類：' + x); });
    document.querySelectorAll('#pane-inventory .btn').find((c) => c.textContent.startsWith('末端')).click();
    if (document.querySelectorAll('#pane-inventory tbody tr').length !== Math.min(nEnd, 500)) throw new Error('末端篩選列數不符');
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
    const vars = { firewall: 'fw', switch: 'sw', router: 'rt', host: 'host', unknown: 'unk' };
    Object.entries(vars).forEach(([k, v]) => {
      const m = css.match(new RegExp('--' + v + ':\\s*(#[0-9a-fA-F]{6})'));
      if (!m || m[1].toLowerCase() !== T.kind[k].toLowerCase()) throw new Error('--' + v + ' 與 theme.kind.' + k + ' 不一致');
    });
    const legend = Array.from(document.querySelectorAll('#legend .li'));
    if (document.querySelectorAll('#legend .lg-group').length !== 4) throw new Error('圖例應分為四類');
    const groupTitles = document.querySelectorAll('#legend .lg-title').map((el) => el.textContent);
    if (groupTitles.join('|') !== '設備|末端|連線|連線註記') throw new Error('圖例分類順序應為設備、末端、連線、連線註記');
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
    const hearsay = legend.find((li) => li.textContent === '聽說'); const domain = legend.find((li) => li.textContent === 'MNDP');
    if (!hearsay || !domain) throw new Error('圖例缺少聽說或 MNDP 註記');
    const hs = sw(hearsay)[0]; const ds = sw(domain)[0];
    if (hs.style.opacity !== String(T.weakEdge.hearsay.alpha) || !hs.style.background.includes(T.weakEdge.hearsay.c)) throw new Error('聽說圖例顏色或透明度與 theme 不一致');
    if (ds.style.opacity !== String(T.weakEdge.domainOnly.alpha) || !ds.style.background.includes(T.weakEdge.domainOnly.c)) throw new Error('MNDP 圖例顏色或透明度與 theme 不一致');
    if (T.weakEdge.domainOnly.alpha !== 0.7) throw new Error('MNDP 邊透明度應為 70%');
    if (hs.style.background === ds.style.background) throw new Error('聽說與 MNDP 圖例線型應可區分');
  });
  await step('MNDP 圖例、提示與細節不暗示實體直連', async () => {
    const input = 'A (10.0.0.1):\n### /ip neighbor print detail\n'
      + ' 0 interface=ether1 mac-address=AA:00:00:00:00:02 identity=B interface-name=ether9 discovered-by=mndp\n';
    $('#input-text').value = input; $('#input-build').click();
    const hash = S.util.hash(S.readers.PASTE + '\n' + input);
    for (let i = 0; i < 4000 && (!App.snap || App.snap.meta.inputHash !== hash); i++) await new Promise((r) => setTimeout(r, 5));
    if (App.snap.meta.inputHash !== hash) throw new Error('MNDP 基準未建立');
    if (!Array.from(document.querySelectorAll('#legend .li')).some((li) => li.textContent === 'MNDP')) throw new Error('MNDP 圖例標籤應簡化為 MNDP');
    const p = Array.from(App.pairs.values()).find((x) => x.domainOnly);
    if (!p) throw new Error('MNDP device edge 未標記為 domain-only');
    App.graph.emit('hover', { item: { type: 'edge', id: p.id }, x: 0, y: 0 });
    if (!text('#tooltip').includes('不代表兩台設備直連')) throw new Error('圖上提示未明示 MNDP 的非直連語意');
    App.graph.emit('click', { type: 'edge', id: p.id });
    if (!text('#detail').includes('非直連確認')) throw new Error('MNDP 細節未明示非直連語意');
    const domainLink = App.snap.model.links.find((l) => l.evidenceScope === 'broadcast-domain');
    const remoteEp = S.keys.splitEp(domainLink.a)[0] === 'A' ? domainLink.b : domainLink.a;
    App.select({ type: 'interface', key: remoteEp });
    if (!text('#detail').includes('MNDP：L2 網域可達，非直連')) throw new Error('MNDP 回報介面的細節不應呈現為直連線');
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
      { id: 'pure-mndp', a: 'mndp-a', b: 'mndp-b', cls: 'other', count: 1, hearsay: false, domainOnly: true },
      { id: 'mixed-evidence', a: 'mixed-a', b: 'mixed-b', cls: 'other', count: 1, hearsay: false, domainOnly: false, hasDomain: true },
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
  await step('CAPsMAN Wi-Fi 多 MAC 在拓樸顯示菱形', async () => {
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
    if (!wifis.every((i) => i.status === 'up' && i.unknownPeer && i.macs.length === 2)) throw new Error('Wi-Fi running 狀態或多 MAC 末端遺失');
    const diamonds = App.graph.nodes.filter((n) => n.kind === 'downstream' && n.parent === 'SW_A');
    if (diamonds.length !== 2) throw new Error('wifi1 與 wifi8 都應畫成多 MAC 菱形');
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
    if (!v || !e) throw new Error('veth1 與 ether5 末端都應畫出');
    if (v.ifStyle || v.color === '#d81b60') throw new Error('veth 節點外觀不應改變，只識別連線');
    const ve = App.graph.edges.find((x) => x.b === v.id); const ee = App.graph.edges.find((x) => x.b === e.id);
    if (!ve || !ve.ifStyle || ve.ifStyle.c !== '#d81b60' || ee.ifStyle) throw new Error('veth 連線應帶專用色，其他連線不變');
    if (!/容器 veth/.test(v.tip)) throw new Error('提示應標示容器 veth');
    if (!Array.from(document.querySelectorAll('#legend .li')).some((el) => /容器 veth/.test(el.textContent))) throw new Error('圖例缺少 veth');
  });
  await step('Wi-Fi 連線以專用顏色識別', async () => {
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
    const w = App.graph.nodes.find((n) => n.id === '?p|SW_A|wifi1'); const l = App.graph.nodes.find((n) => n.id === '?p|SW_A|wlan1'); const e = App.graph.nodes.find((n) => n.id === '?p|SW_A|ether5');
    const wc = S.view.theme.endpoint.byType.wifi.c;
    if (!w || !l || !e) throw new Error('wifi1、wlan1、ether5 末端都應畫出');
    if (w.kind !== 'downstream' || w.color === wc || l.color === wc || w.ifStyle || l.ifStyle) throw new Error('Wi-Fi 節點外觀不應改變，只識別連線');
    const we = App.graph.edges.find((x) => x.b === w.id); const le = App.graph.edges.find((x) => x.b === l.id); const ee = App.graph.edges.find((x) => x.b === e.id);
    if (!we || !le || we.ifStyle.c !== wc || le.ifStyle.c !== wc || ee.ifStyle) throw new Error('Wi-Fi 連線應帶專用色，其他連線不變');
    if (!/Wi-Fi/.test(w.tip)) throw new Error('提示應標示 Wi-Fi');
    if (!Array.from(document.querySelectorAll('#legend .li')).some((el) => /Wi-Fi/.test(el.textContent))) throw new Error('圖例缺少 Wi-Fi');
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
  await step('清除基準', async () => { $('#btn-clear').click(); await new Promise((r) => setTimeout(r, 20)); if (App.snap) throw new Error('未清除'); });
  console.log(steps.join('\n'));
  setTimeout(() => process.exit(process.exitCode || 0), 10);
})();
