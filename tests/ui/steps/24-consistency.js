// 畫面冒煙測試的 step：右欄（與處理紀錄、L4）的區塊一致性——區塊都經 V.section、主題區塊不在一般區塊與展開列之間切換、
// count 是純數字、狀態 chip「N＋量詞＋狀態」且 0 不顯示、預設展開只在有問題或定位時、空列表不顯示、連結在標題列、鏈路一律表格、設備名清單一律 chip-list。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { S, step, $, text, detailRoot, fwRoot, fwList, fwSide, fwText, fwTab, fwRows } = require('../helpers.js');

/** 一個元素的直接子元素（模擬 DOM 的 children 是 HTMLCollection） */
const kids = (el) => Array.from(el.children);
const isFold = (el) => el.tagName === 'DETAILS' && /\bdetail-fold\b/.test(el.className);
const isSection = (el) => /\bdetail-section\b/.test(el.className);
/** 區塊的標題列（展開列的 summary 或一般區塊的 h3） */
const headOf = (el) => kids(el).find((c) => c.tagName === 'SUMMARY' || c.tagName === 'H3');
const titleOf = (el) => headOf(el).firstChild.textContent;
/** 預設展開的理由：有問題的列、錯誤／警告的 chip、檢查結果、定位的列 */
const hasReason = (el) => el.all().some((x) => /\b(bad|finding|focus|current|bad-line)\b/.test(x.className) || /\bchip\b/.test(x.className) && /\b(err|warn)\b/.test(x.className)
  || x.getAttribute('aria-current') === 'true');

/** 詳情的各種選取（範例資料涵蓋每一種） */
function selections(Q) {
  const ds = Q.devices();
  const vids = S.util.uniq(ds.flatMap((d) => Q.vlansOf(d.key).map((v) => v.id)).filter((x) => x != null));
  const subnet = (Q.subnetGraph({ routes: true }).subnets.find((s) => s.duplicateIps.length) || {}).id;
  const fw = (Q.firewallRules()[0] || {}).dev;
  const pair = Array.from(App.pairs.values()).find((p) => p.links.length > 1) || Array.from(App.pairs.values())[0];
  const sels = [
    ...ds.filter((d) => d.collected).slice(0, 25).map((d) => ({ type: 'device', key: d.key })),
    ...ds.filter((d) => !d.collected).map((d) => ({ type: 'device', key: d.key })),
    ...Q.links().slice(0, 10).map((l) => ({ type: 'link', key: l.key })),
    { type: 'pair', id: pair.id, links: pair.links, devs: [pair.a, pair.b] },
    ...ds.flatMap((d) => Q.interfacesOf(d.key)).filter((i) => Q.linksOfEp(i.key).length).slice(0, 10).map((i) => ({ type: 'interface', key: i.key })),
    ...App.snap.model.macs.slice(0, 5).map((m) => ({ type: 'mac', key: m.mac })),
    ...vids.map((v) => ({ type: 'vlan', key: String(v) })),
    { type: 'subnet', key: subnet },
    { type: 'firewall', dev: fw, key: fw },
    // 防火牆視窗的規則詳情與服務詳情：有檢查結果的那一條（範例資料有）
    { type: 'rule', key: (Q.firewallRules().find((r) => Q.findingsFor('rule', r.key).length) || Q.firewallRules()[0] || {}).key },
    ...Q.ipServicesOf(fw).slice(0, 1).map((s) => ({ type: 'service', key: s.dev + '|' + s.name })),
    { type: 'boundary', key: Q.vrfs()[0] },
  ];
  if (sels.some((x) => x.key === undefined && x.type !== 'pair')) throw new Error('測試前提：範例資料應涵蓋每種詳情：' + JSON.stringify(sels.filter((x) => x.key === undefined)));
  return sels;
}
const label = (sel) => `${sel.type} ${sel.key || sel.id}`;
/**
 * 一個選取要檢查的詳情：右欄一定有；防火牆的選取另有視窗的右欄（總覽、規則或服務的詳情，main 用 'fw-side' 的清單）。
 * 視窗沒開時 fwSide() 直接失敗，不會在只剩摘要的右欄上空跑通過。
 */
const views = (sel) => [{ name: '右欄', el: detailRoot().firstElementChild, main: sel.type },
  ...(S.view.firewall.isSel(sel) ? [{ name: '防火牆視窗的右欄', el: fwSide().querySelector('.detail'), main: 'fw-side' }] : [])];
/** 掃描標題與展開列的容器：右欄，防火牆的選取另加整個視窗（左欄的分組也是 V.section 的展開列） */
const scanRoots = (sel) => [detailRoot(), ...(S.view.firewall.isSel(sel) ? [fwRoot()] : [])];

module.exports = async () => {
  await step('區塊一致性：主題區塊都是展開列（第一層的檢查結果與屬性、頁面主體才是一般區塊），不在一般區塊與展開列之間切換', () => {
    const Q = App.Q;
    // 一般區塊只有：檢查結果，以及「整頁就是這個主題」的主體（各頁固定，不依筆數）
    const MAIN = { link: ['VLAN'], pair: ['鏈路（LLDP／CDP／MNDP）', '推論鏈路（沒有 LLDP）'], mac: ['位置'], ip: ['這個 IP 在多個 VRF：選擇其中一個'], boundary: ['對外介面與依據'],
      // 防火牆視窗的右欄：總覽的 WAN 判斷；規則詳情的屬性、命中次數、L4 影響與修正；服務詳情的屬性
      'fw-side': ['WAN／LAN 判斷（推論）', '規則', '命中次數', 'L4 影響（推論）', '修正（停用規則）', '服務'] };
    selections(Q).forEach((sel) => {
      App.select(sel);
      views(sel).forEach((vw) => {
        const top = kids(vw.el);
        const blocks = top.filter((x) => isFold(x) || isSection(x));
        if (!blocks.length) throw new Error(`${label(sel)} 的${vw.name}應有區塊`);
        blocks.filter(isSection).forEach((x) => {
          const t = titleOf(x);
          if (t !== '檢查結果' && !(MAIN[vw.main] || []).includes(t)) throw new Error(`${label(sel)} ${vw.name}的「${t}」是主題區塊，應是展開列（不依筆數切換成一般區塊）`);
        });
        // 一般區塊不夾在展開列之間（「這是什麼？」是說明，排在屬性之後，不算）
        const seq = blocks.filter((x) => !(isFold(x) && titleOf(x) === '這是什麼？'));
        const firstFold = seq.findIndex(isFold);
        if (firstFold >= 0 && seq.slice(firstFold).some(isSection)) throw new Error(`${label(sel)} ${vw.name}的一般區塊夾在展開列之間：` + seq.map((x) => (isFold(x) ? '▸' : '■') + titleOf(x)).join(' '));
      });
      // 詳情與視窗內的 details 都經 V.section（detail-fold）；只有行內的「常見原因與處理」與前提的「詳細」例外
      scanRoots(sel).forEach((root) => root.testAll('details').forEach((d) => {
        if (!/\b(detail-fold|advice|assume-detail)\b/.test(d.className)) throw new Error(`${label(sel)} 有手組的展開列（不是 V.section）：` + d.querySelector('summary').textContent);
      }));
    });
    App.select(null);
  });

  await step('區塊一致性：count 是純數字的列數，其他的量是「N＋量詞＋狀態」的狀態 chip，0 不顯示；預設展開只在有問題或定位時', () => {
    const Q = App.Q;
    selections(Q).forEach((sel) => {
      App.select(sel);
      scanRoots(sel).flatMap((r) => r.testAll('summary').concat(r.testAll('h3'))).forEach((hd) => {
        const t = hd.firstChild.textContent;
        hd.testAll('.chip').forEach((c) => {
          const s = c.textContent;
          if (/\bcount\b/.test(c.className)) { if (!/^[\d,]+$/.test(s) || s === '0') throw new Error(`${label(sel)}「${t}」的 count 應是非 0 的純數字：${s}`); return; }
          if (/^0 /.test(s)) throw new Error(`${label(sel)}「${t}」的狀態 chip 是 0 時不顯示：${s}`);
          if (/\d/.test(s) && !/^VLAN /.test(s) && !/^[\d,]+ \S/.test(s)) throw new Error(`${label(sel)}「${t}」的數量 chip 應寫成「N＋量詞＋狀態」：${s}`);
        });
      });
      // 預設展開的展開列：裡面有問題的列、錯誤／警告、檢查結果或定位的列（不再有「一律展開」）
      scanRoots(sel).flatMap((r) => r.testAll('details')).filter(isFold).forEach((d) => {
        if (d.getAttribute('open') != null && !hasReason(d)) throw new Error(`${label(sel)}「${titleOf(d)}」沒有問題也沒有定位的列，應預設收合`);
      });
    });
    App.select(null);
  });

  await step('區塊一致性：VRF 與策略路由沒有問題時預設收合；空列表不顯示（未收集設備沒有「鄰居 0」）；管理面設定的 count 是項目數', () => {
    const Q = App.Q; const V = S.view;
    const foldOf = (t) => $('#detail').testAll('details').find((d) => isFold(d) && titleOf(d) === t);
    let vrfSeen = 0;
    Q.devices().forEach((d) => {
      if (!Q.vrfsOf(d.key).some((v) => !v.builtin)) return;
      App.select({ type: 'device', key: d.key });
      const f = foldOf('VRF'); if (!f) throw new Error(d.key + ' 有 VRF 設定時應有 VRF 區塊');
      vrfSeen++;
      if (f.getAttribute('open') != null) throw new Error(d.key + ' 的 VRF 沒有問題時應預設收合');
      const pol = Q.policyOf(d.key); const p = foldOf('策略路由');
      if (p && (p.getAttribute('open') != null) !== !!(pol.custom || pol.marks.length)) throw new Error(d.key + ' 的策略路由只在查表不明時預設展開');
    });
    if (!vrfSeen && !process.env.SMOKE_INPUT) throw new Error('測試前提：範例資料應有 VRF 設定的設備');
    // 沒有鄰居的設備不出現「鄰居」區塊
    const lonely = Q.devices().filter((d) => !Q.neighborRows(d.key).length);
    lonely.forEach((d) => { App.select({ type: 'device', key: d.key }); if (foldOf('鄰居')) throw new Error(d.key + ' 沒有鄰居時不應顯示「鄰居」區塊'); });
    // 管理面設定：count 是項目（列）數，沒有「筆檢查結果」
    const mg = Q.devices().find((d) => d.collected && Q.mgmtOf(d.key));
    if (mg) {
      App.select({ type: 'device', key: mg.key });
      const sec = $('#detail').querySelector('.mgmt-section'); const c = headOf(sec).testAll('.count')[0];
      if (!c || Number(c.textContent.replace(/,/g, '')) !== sec.testAll('.mgmt-row').length) throw new Error('管理面設定的 count 應是項目數：' + (c && c.textContent));
      if (text('#detail').includes('筆檢查結果')) throw new Error('管理面設定不再寫「N 筆檢查結果」');
    } else if (!process.env.SMOKE_INPUT) throw new Error('測試前提：範例資料應有 export 的設備');
    if (V.stateChip(0, '條有問題', 'error') !== null) throw new Error('V.stateChip 的 0 不顯示');
    if (V.stateChip(2, '條有問題', 'error').className.indexOf('err') < 0 || V.stateChip(2, '條有問題', 'warn').className.indexOf('warn') < 0) throw new Error('V.stateChip 的語氣色依最嚴重的嚴重度');
    if (V.stateChip(3, '條有問題').textContent !== '3 條有問題') throw new Error('V.stateChip 的寫法是「N＋量詞＋狀態」');
    App.select(null);
  });

  await step('區塊一致性：跳到其他畫面與改變範圍的連結在標題列；鏈路一律表格；只有名稱的設備清單一律 chip-list', () => {
    const Q = App.Q;
    const inHead = (txt) => { const a = $('#detail').testAll('a').find((x) => x.textContent === txt); if (!a) return null; for (let x = a; x; x = x.parentNode) if (x.tagName === 'SUMMARY' || x.tagName === 'H3') return true; return false; };
    // 防火牆摘要的入口
    const fwDev = Q.firewallRules()[0].dev; App.select({ type: 'device', key: fwDev });
    if (inHead('查看防火牆規則與服務') !== true) throw new Error('「查看防火牆規則與服務」應在防火牆區塊的標題列');
    // VLAN 片段：改看全部的連結
    const split = Q.vlans().find((v) => v.id != null && Q.vlan(String(v.id)).domains.length > 1);
    if (split) {
      const v = Q.vlan(String(split.id));
      App.select({ type: 'vlan', key: String(split.id), domain: v.domains[0].key });
      if (inHead('顯示所有 ' + S.view.TERMS.vlanDomain) !== true) throw new Error('「顯示所有 VLAN 片段」應在標題列');
    } else if (!process.env.SMOKE_INPUT) throw new Error('測試前提：範例資料應有分成多個片段的 VLAN');
    // 外部節點：只看一台設備時，改看整個 VRF 的連結在標題列
    const b = Q.boundaries ? Q.boundaries().find((x) => x.status !== 'internal') : null;
    if (b) { App.select({ type: 'boundary', key: b.vrf || S.keys.MAIN_VRF, dev: b.dev }); if (inHead('看這個 VRF 的全部') !== true) throw new Error('「看這個 VRF 的全部」應在標題列'); }
    // 鏈路一律表格：介面的鏈路、VLAN 的只有一端
    const ifc = Q.devices().flatMap((d) => Q.interfacesOf(d.key)).find((i) => Q.linksOfEp(i.key).length);
    App.select({ type: 'interface', key: ifc.key });
    const lk = $('#detail').testAll('details').find((d) => isFold(d) && titleOf(d) === '鏈路');
    if (!lk || lk.testAll('tbody tr').length !== Q.linksOfEp(ifc.key).length) throw new Error('介面的鏈路應是表格，每條一列');
    const pv = Q.vlans().find((v) => v.id != null && Q.vlan(String(v.id)).partial.length);
    if (pv) {
      App.select({ type: 'vlan', key: String(pv.id) });
      const p = $('#detail').testAll('details').find((d) => isFold(d) && titleOf(d) === '只有一端有此 VLAN 的鏈路');
      if (!p || p.testAll('tbody tr').length !== Q.vlan(String(pv.id)).partial.length) throw new Error('只有一端有此 VLAN 的鏈路應是表格');
    } else if (!process.env.SMOKE_INPUT) throw new Error('測試前提：範例資料應有只有一端有的 VLAN');
    // 設備名清單一律 chip-list：看到它的設備（屬性內與展開列）
    const seen = Q.devices().find((d) => d.seenBy.length);
    App.select({ type: 'device', key: seen.key });
    const list = $('#detail').testAll('.dev-chips')[0];
    if (!list || !/\bchip-list\b/.test(list.className) || list.testAll('a').length !== seen.seenBy.length) throw new Error('看到它的設備應是 chip-list');
    App.select(null);
  });

  await step('區塊一致性：處理紀錄與 L4、路由追蹤的展開列也經 V.section；前提的條數用 chip', () => {
    const V = S.view;
    // 處理紀錄：各狀態的筆數與說明
    V.ledgerPane.render(App);
    const lf = $('#ledger-body').testAll('details').filter((d) => /\bledger-fold\b/.test(d.className));
    if (!lf.length || lf.some((d) => !isFold(d) || !headOf(d).testAll('.count').length)) throw new Error('處理紀錄的展開列應經 V.section（detail-fold＋count）');
    // 路由追蹤的「其他前提」：標題旁是條數 chip，沒有括號
    const html = (el) => el.all().map((x) => (x.tagName === 'SUMMARY' ? x.textContent : '')).join('|');
    App.openTrace('10.1.30.15', '8.8.8.8', ''); $('#trace-run').click();
    if (App.sel && App.sel.type === 'trace') {
      // 路由追蹤也在區塊結構的檢查內：多起點時每個起點一段，段內是「逐跳」「結果」
      $('#detail').testAll('.trace-group').forEach((g) => { const subs = g.testAll('.trace-sub').map(titleOf); if (!subs.includes('結果')) throw new Error('每個起點一段，段內有「結果」區塊：' + subs.join('|')); });
      if (/（\d+ 條/.test(html($('#detail')))) throw new Error('前提的條數不寫在括號：' + html($('#detail')));
      const other = $('#detail').testAll('details').find((d) => /\bassume-other\b/.test(d.className));
      if (other && (!isFold(other) || !headOf(other).testAll('.count').length)) throw new Error('其他前提應經 V.section、標題旁是條數');
    } else if (!process.env.SMOKE_INPUT) throw new Error('測試前提：範例資料可追蹤 10.1.30.15 → 8.8.8.8');
    App.select(null);
  });

  await step('區塊一致性：設備對頁的鏈路與推論鏈路是主體（一般區塊），沒有問題或只有推論鏈路時也直接看得到', () => {
    const Q = App.Q;
    const pairs = Array.from(App.pairs.values()).filter((p) => !p.virtual);
    const okLinks = pairs.find((p) => p.links.length && p.links.every((k) => !Q.getLink(k).vlanMismatch && !S.view.hasProblem(Q.findingsFor('link', k))));
    // 只有推論鏈路：沒有介面鄰接的鏈路（MNDP 只證明同一廣播網域，可以有）
    const onlyInferred = pairs.find((p) => p.links.every((k) => Q.getLink(k).evidenceScope === S.LINK_SCOPE.BROADCAST_DOMAIN) && Q.inferredLinksBetween(p.a, p.b).length);
    if (!process.env.SMOKE_INPUT && (!okLinks || !onlyInferred)) throw new Error(`測試前提：範例資料應有沒有問題的設備對（${!!okLinks}）與只有推論鏈路的設備對（${!!onlyInferred}）`);
    [[okLinks, '鏈路（LLDP／CDP／MNDP）', (p) => p.links.length], [onlyInferred, '推論鏈路（沒有 LLDP）', (p) => Q.inferredLinksBetween(p.a, p.b).length]].forEach(([p, title, n]) => {
      if (!p) return;
      App.select({ type: 'pair', id: p.id, links: p.links, devs: [p.a, p.b] });
      const sec = kids($('#detail').firstElementChild).find((x) => (isFold(x) || isSection(x)) && titleOf(x) === title);
      if (!sec || !isSection(sec)) throw new Error(`設備對 ${p.id} 的「${title}」應是一般區塊（主體），不收合`);
      if (sec.testAll('tbody tr').length !== n(p)) throw new Error(`設備對 ${p.id} 的「${title}」應直接列出每一條`);
    });
    App.select(null);
  });

  await step('區塊一致性：多起點追蹤中某個起點沒有逐跳與結果時，仍有一段並寫明（不丟例外）', () => {
    const Q = App.Q;
    App.openTrace('10.1.30.15', '8.8.8.8', ''); $('#trace-run').click();
    if (!App.sel || App.sel.type !== 'trace') { if (process.env.SMOKE_INPUT) return; throw new Error('測試前提：範例資料可追蹤 10.1.30.15 → 8.8.8.8'); }
    const r = App.sel.result;
    // 加一個沒有任何逐跳與結果的起點（基準內、不在原本 starts 的設備）
    const extra = Q.devices().find((d) => !r.starts.includes(d.key) && !r.hops.some((hp) => hp.dev === d.key) && !r.ends.some((e) => (e.path || [e.dev]).includes(d.key)));
    const t = Object.assign({}, r, { starts: (r.starts && r.starts.length ? r.starts : [r.start]).concat(extra.key) });
    App.select({ type: 'trace', result: t, reverse: null, reverseSkip: null, vrf: null });
    const groups = $('#detail').testAll('.trace-group');
    if (groups.length !== t.starts.length) throw new Error(`每個起點都應有一段（${groups.length}／${t.starts.length}）`);
    const g = groups.find((x) => x.dataset.start === extra.key);
    if (!g || !g.testAll('.trace-empty').length || g.testAll('.trace-sub').length) throw new Error('沒有逐跳與結果的起點應寫一句說明，不產生空的子區塊');
    App.select(null);
  });

  await step('區塊一致性：展開列只記錄使用者的操作，建立時就展開所發的 toggle 不記成使用者的選擇', () => {
    const V = S.view;
    const state = new Map();
    // 預設展開：瀏覽器建立時就 open 也會發 toggle（open 仍是預設值）
    const a = V.section('甲', V.h('p', null, '內容'), { fold: true, open: true, state, key: 'a' });
    a.open = true; a.dispatch('toggle');
    if (state.has('a')) throw new Error('建立時就展開的 toggle 不應記成使用者的選擇');
    a.open = false; a.dispatch('toggle');
    if (state.get('a') !== false) throw new Error('使用者收合應記錄');
    a.open = true; a.dispatch('toggle');
    if (state.get('a') !== true) throw new Error('記錄後使用者再展開（回到預設）也應記錄');
    // 預設收合：使用者展開要記錄
    const b = V.section('乙', V.h('p', null, '內容'), { fold: true, state, key: 'b' });
    b.open = true; b.dispatch('toggle');
    if (state.get('b') !== true) throw new Error('使用者展開預設收合的區塊應記錄');
    // 記錄的值在重繪時優先於預設
    const a2 = V.section('甲', V.h('p', null, '內容'), { fold: true, open: false, state, key: 'a' });
    if (a2.getAttribute('open') == null) throw new Error('重繪時應依使用者的記錄展開');
  });
};
