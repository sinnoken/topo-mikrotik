// 畫面冒煙測試的 step：查詢與搜尋、覆蓋率與基準狀態卡、名詞與用字、路由追蹤、原文。
// 由 tests/ui-smoke.js 依檔名順序載入；step 之間共用畫面狀態（App、store、選取），順序不可調換。
'use strict';
const { html, body, S, MD, fs, path, ROOT, step, jsFiles, goStep, searchFor, $, text, stepSources, L4 } = require('../helpers.js');

module.exports = async () => {
  await step('MAC、IP、VLAN 查詢與圖上標示', () => {
    App.snap.model.macs.slice(0, 40).forEach((m) => App.select({ type: 'mac', key: m.mac }));
    ['10.1.20.11', '10.1.30.11', '10.255.1.1', '9.9.9.9'].forEach((ip) => App.select({ type: 'ip', key: ip }));
    App.select({ type: 'vlan', key: '30' }); App.graph.draw();
    if (!process.env.SMOKE_INPUT && !text('#detail').includes('只有一端有此 VLAN 的鏈路')) throw new Error('VLAN 不一致未顯示');
    const ds = App.Q.vlan(30).domains;
    App.select({ type: 'vlan', key: '30', domain: ds[0].key }); App.graph.draw();
    if (!text('#detail').includes(`${S.view.TERMS.vlanDomain} 1／${ds.length}`)) throw new Error('選取 VLAN 片段時標題未標示片段');
  });
  await step('搜尋框', async () => {
    await searchFor('acc_sw_0'); const inp = $('#search');
    if (!text('#search-dd').includes('_ACC_SW_0')) throw new Error('搜尋結果不正確');
    inp.dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'device') throw new Error('Enter 應選取設備');
  });
  await step('覆蓋率與 VLAN 數：網路設備為分母、主機另列，VLAN 以相異 ID 計（基準狀態卡同一口徑）', () => {
    const NUM = S.view.num; const cs = App.Q.coverageSummary(); const vs = App.Q.vlanSummary();
    if (cs.network - cs.networkCollected !== App.Q.findingsByRule('C01').length) throw new Error('未收集的網路設備數應等於 C01 筆數');
    const sel = App.sel; App.select(null);
    const covLine = $('#detail').querySelector('.status-coverage').textContent;
    // 和資料中心同一套說法：「N 台缺資料、M 台未收集」（已收集／應收集在數字卡，UX #11）
    const unc = cs.network - cs.networkCollected; const gapText = S.view.coverageGapText(cs);
    if (cs.missing && !gapText.includes(`${NUM(cs.missing)} 台缺資料`)) throw new Error('缺資料的台數：' + gapText);
    if (unc && !gapText.includes(`${NUM(unc)} 台未收集`)) throw new Error('未收集的台數：' + gapText);
    if (!cs.missing && !unc && !gapText.includes('資料齊全')) throw new Error('沒有缺漏時寫資料齊全：' + gapText);
    if (!covLine.includes(gapText) || /缺資料或收集失敗/.test(covLine)) throw new Error('狀態卡的覆蓋率應用同一句：' + covLine);
    App.openHub('coverage');
    const hubCov = $('#hub').testAll('.hub-row').find((r) => r.getAttribute('data-item') === 'coverage');
    if (!hubCov || !hubCov.textContent.includes(gapText)) throw new Error('資料中心的覆蓋率應用同一句：' + hubCov.textContent);
    S.view.app.closeHub(); App.select(null);
    const hostLine = $('#detail').querySelector('.status-hosts');
    if (!!cs.hosts !== !!(hostLine && hostLine.textContent.includes(`另有 ${NUM(cs.hosts)} 台主機不在收集範圍`))) throw new Error('有主機時另列，沒有時不寫');
    if (hostLine && /（[^）]*（/.test(hostLine.textContent)) throw new Error('主機說明不要括號套括號（UX #20）：' + hostLine.textContent);
    const metaLine = $('#detail').querySelector('.status-meta').textContent;
    if (/ （/.test(metaLine)) throw new Error('全形括號前不留空白（UX #20）：' + metaLine);
    // 基準狀態卡：數字卡是「數字＋名稱」，技術細節是 kv
    const stats = $('#detail').testAll('.stat').map((x) => [x.querySelector('.stat-label').textContent, x.querySelector('.stat-num').textContent]);
    const want = [['已收集網路設備', `${NUM(cs.networkCollected)}／${NUM(cs.network)}`], ['鏈路', NUM(App.Q.meta().stats.links)], ['VLAN（相異 ID）', NUM(vs.ids)], ['MAC', NUM(App.Q.meta().stats.macs)]];
    if (JSON.stringify(stats) !== JSON.stringify(want)) throw new Error('狀態卡的四個數字卡不符：' + JSON.stringify(stats));
    const d = text('#detail');
    if (!d.includes('VLAN 定義（各設備合計）' + NUM(vs.definitions))) throw new Error('技術細節應分開列出 VLAN 定義：' + d.slice(0, 300));
    App.select(sel);
  });
  await step('基準狀態卡（未選取時）：一句話狀態只算待處理、建議先看、覆蓋率可點、技術細節收合；每個數字只出現一次', () => {
    const Q = App.Q; const VA = S.view.app; const NUM = S.view.num; const cs = Q.coverageSummary();
    App.select(null);
    const card = $('#detail').querySelector('.status-card'); if (!card) throw new Error('未選取時右欄應是基準狀態卡');
    const t = card.textContent;
    ['網路正常', '即時'].forEach((w) => { if (t.includes(w)) throw new Error(`狀態卡不應出現「${w}」`); });
    const pc = VA.problemCounts();
    const line = card.querySelector('.status-line').textContent;
    if (pc.error && !line.includes(`${NUM(pc.error)} 項錯誤`)) throw new Error('狀態句應寫出待處理的錯誤數：' + line);
    if (pc.warn && !line.includes(`${NUM(pc.warn)} 項警告`)) throw new Error('狀態句應寫出待處理的警告數：' + line);
    // 建議先看：待處理的錯誤／警告中嚴重度最高、檢查順序最前、再取 Snapshot 順序
    const rank = new Map(S.query.rules().map((r, n) => [r.id, n])); const sev = { error: 0, warn: 1 };
    const cand = Q.findings().map((f, i) => ({ f, i })).filter((x) => x.f.severity in sev && VA.isPending(x.f))
      .sort((a, b) => sev[a.f.severity] - sev[b.f.severity] || rank.get(a.f.id) - rank.get(b.f.id) || a.i - b.i);
    const sug = card.querySelector('.status-suggest');
    if (cand.length ? !sug || sug.textContent !== cand[0].f.title : sug) throw new Error('「建議先看」應連到嚴重度最高、檢查順序最前的待處理結果：' + (sug && sug.textContent));
    if (cand.length) {
      const first = cand.find((x) => x.f.entities.length);
      if (first && first === cand[0]) { sug.click(); if (!App.sel) throw new Error('點「建議先看」應選取那一筆的物件'); App.select(null); }
    }
    // 收集完整度：缺資料台數可點，開資料中心的覆蓋率（只列有缺漏）
    const cov = $('#detail').querySelector('.status-coverage');
    if (cs.missing) {
      const a = cov.querySelector('a'); if (!a || !a.textContent.includes(`${NUM(cs.missing)} 台`)) throw new Error('收集完整度應寫出缺資料的台數並可點：' + cov.textContent);
      a.click();
      if ($('#hub').classList.contains('hidden')) throw new Error('點缺資料台數應開啟資料中心的覆蓋率');
      if (!text('#pane-coverage').includes('有缺漏')) throw new Error('覆蓋率應切到「有缺漏」');
      goStep('triage'); App.select(null);
    }
    if (!!cs.hosts !== !!$('#detail').querySelector('.status-hosts')) throw new Error('有主機時另起一行淡色說明，沒有時不寫');
    // 技術細節預設收合，內含指紋、基準鍵、版本與解析器使用量
    const tech = $('#detail').testAll('.detail-fold').find((x) => x.querySelector('summary').textContent.startsWith('技術細節'));
    if (!tech || tech.getAttribute('open') !== null) throw new Error('技術細節應預設收合');
    const m = Q.meta();
    [m.inputHash, '解析器使用量', '版本', 'IP（ARP）', '路由', '介面'].forEach((w) => { if (!tech.textContent.includes(w)) throw new Error('技術細節應有 ' + w); });
    if (t.indexOf(m.inputHash) !== t.lastIndexOf(m.inputHash)) throw new Error('輸入指紋只出現一次');
    // 每個數字只出現一次：已收集台數只在數字卡，不在收集完整度那一行
    if (cov.textContent.includes(`${NUM(cs.networkCollected)}／`) || cov.textContent.includes(`${NUM(cs.network)} 台`)) throw new Error('收集完整度那一行不重複已收集台數：' + cov.textContent);
  });
  await step('詳情：設備先列身分再列檢查結果、超過 3 筆先顯示 3 筆；與多數不同的設備有 chip；平手不多一行；長表格預設收合', () => {
    const Q = App.Q; const SHOWN = 3;
    // 檢查結果超過 3 筆的設備：先顯示 3 筆，其餘在「再顯示 N 筆」（預設收合）
    const many = Q.devices().find((d) => { App.select({ type: 'device', key: d.key }); const sec = $('#detail').querySelector('.findings-section'); return sec && sec.testAll('.finding').length > SHOWN; });
    if (many) {
      const sec = $('#detail').querySelector('.findings-section');
      const more = sec.testAll('.detail-fold').find((x) => x.querySelector('summary').textContent.startsWith('再顯示'));
      const total = sec.testAll('.finding').length;
      if (!more || more.getAttribute('open') !== null || more.testAll('.finding').length !== total - SHOWN || !more.querySelector('summary').textContent.startsWith(`再顯示 ${total - SHOWN} 筆`)) throw new Error(`超過 ${SHOWN} 筆時其餘應收在「再顯示 N 筆」`);
    } else if (!process.env.SMOKE_INPUT) throw new Error(`範例資料應有檢查結果超過 ${SHOWN} 筆的設備`);
    // 設備的身分（管理 IP、型號、RouterOS、收集的資料）在檢查結果之前：核心設備的檢查結果很多，身分不能被推到首屏外
    const d0 = Q.devices().find((d) => d.collected && Q.findingsFor('device', d.key).length);
    App.select({ type: 'device', key: d0.key });
    const kids = $('#detail').querySelector('.detail').childNodes;
    const fi = kids.findIndex((x) => x.classList && x.classList.contains('findings-section')); const ki = kids.findIndex((x) => x.classList && x.classList.contains('kv'));
    if (fi < 0 || ki < 0 || ki > fi) throw new Error('設備的屬性（身分）應在檢查結果之前');
    if (d0.mgmtIp && !kids[ki].textContent.includes(d0.mgmtIp)) throw new Error('設備屬性的第一段應有管理 IP');
    if (!kids[ki].textContent.includes('收集的資料')) throw new Error('設備屬性應列收集的資料');
    // RouterBOOT 韌體與運作時間（/system routerboard、/system resource 的事實）：文字與網路文件共用 S.report
    const rbDev = Q.devices().find((d) => d.collected && d.routerboard && d.routerboard.currentFirmware && d.uptime);
    if (rbDev) {
      App.select({ type: 'device', key: rbDev.key });
      const kv = $('#detail').querySelector('.kv').textContent;
      if (!kv.includes('RouterBOOT 韌體') || !kv.includes(S.report.firmwareText(rbDev.routerboard))) throw new Error('設備屬性應列 RouterBOOT 韌體：' + kv);
      if (!kv.includes('運作時間') || !kv.includes(S.report.uptimeText(rbDev.uptime.seconds))) throw new Error('設備屬性應列運作時間：' + kv);
      if (rbDev.routerboard.upgradeFirmware !== rbDev.routerboard.currentFirmware && !kv.includes('可套用 ' + rbDev.routerboard.upgradeFirmware)) throw new Error('韌體待升級時應寫出可套用的版本');
    } else if (!process.env.SMOKE_INPUT) throw new Error('範例資料應有收集了 /system routerboard 與 uptime 的設備');
    const noRb = Q.devices().find((d) => d.collected && !d.routerboard && !d.uptime);
    if (noRb) { App.select({ type: 'device', key: noRb.key }); const kv = $('#detail').querySelector('.kv').textContent; if (kv.includes('RouterBOOT 韌體') || kv.includes('運作時間')) throw new Error('沒有收集時不列 RouterBOOT 韌體與運作時間'); }
    // 與多數不同：設備在任何 finding.deviation.deviating 中時，標題下有「與多數不同 N 項」
    const devs = S.util.uniq(Q.findings().flatMap((f) => (f.deviation ? f.deviation.deviating : [])));
    devs.forEach((k) => {
      App.select({ type: 'device', key: k });
      const n = Q.deviationsOf(k).length;
      if (!$('#detail').testAll('.chip').some((c) => c.textContent === `與多數不同 ${n} 項`)) throw new Error(`${k} 應有「與多數不同 ${n} 項」`);
      if (!Q.deviationsOf(k).every((i) => text('#detail').includes(Q.finding(i).message))) throw new Error(`${k} 的檢查結果應包含與多數不同的那幾筆`);
    });
    if (!devs.length && !process.env.SMOKE_INPUT) throw new Error('範例資料應有與多數不同的設備');
    const clean = Q.devices().find((d) => !devs.includes(d.key)); App.select({ type: 'device', key: clean.key });
    if ($('#detail').testAll('.chip').some((c) => c.textContent.startsWith('與多數不同'))) throw new Error('沒有與多數不同的設備不應有 chip');
    // 平手：詳情和左欄一樣不顯示額外的「沒有多數」行（訊息本身仍在）
    const tie = Q.findings().findIndex((f) => f.deviation && f.deviation.basis === 'majority' && !f.deviation.deviating.length && f.entities.length);
    if (tie >= 0) {
      App.selectFinding(tie);
      const box = $('#detail').testAll('.finding').find((x) => x.textContent.includes(Q.finding(tie).message));
      if (!box || box.querySelector('.deviation')) throw new Error('平手時詳情不應多一行與多數不同');
    }
    if (!process.env.SMOKE_INPUT && tie < 0) throw new Error('範例資料應有多數決平手的檢查結果');
    if (Q.devices().some((d) => { App.select({ type: 'device', key: d.key }); return text('#detail').includes('沒有多數'); })) throw new Error('設備詳情不應出現「沒有多數」');
    // 長表格：超過 8 列預設收合，只在展開列顯示筆數
    const big = Q.devices().find((d) => d.collected && Q.interfacesOf(d.key).filter((i) => !i.hearsay).length > 8);
    App.select({ type: 'device', key: big.key });
    const ifSec = $('#detail').testAll('.detail-fold').find((x) => x.querySelector('summary').textContent.startsWith('介面'));
    if (!ifSec || ifSec.getAttribute('open') !== null) throw new Error('超過 8 列的介面表應預設收合');
    const small = Q.devices().find((d) => d.collected && Q.interfacesOf(d.key).filter((i) => !i.hearsay).length > 0 && Q.interfacesOf(d.key).filter((i) => !i.hearsay).length <= 8);
    if (small) { App.select({ type: 'device', key: small.key }); if (!$('#detail').testAll('h3').some((x) => x.textContent.startsWith('介面'))) throw new Error('8 列以內的介面表不收合'); }
    App.select(null);
  });
  await step('名詞與推論：V.TERMS 是畫面名詞的單一來源；推定欄位標「推論」；VLAN 鏈路數用中性色', () => {
    const V = S.view; const Q = App.Q;
    if (!Object.isFrozen(V.TERMS) || V.TERMS.network !== '網路設備' || V.TERMS.inferred !== '推論') throw new Error('V.TERMS 應凍結並定義網路設備、推論等名詞');
    const c = V.inferChip('依據'); if (c.textContent !== V.TERMS.inferred || c.getAttribute('title') !== '依據') throw new Error('V.inferChip 應寫「推論」並把依據放在 title');
    App.select({ type: 'vlan', key: '30' });
    const v = Q.vlan(30); const chip = $('#detail').testAll('.chip').find((x) => x.textContent === `兩端都有此 VLAN 的鏈路 ${v.carry.length} 條`);
    if (!chip || chip.classList.contains('ok')) throw new Error('VLAN 詳情應寫中性色的「兩端都有此 VLAN 的鏈路 N 條」');
    if ($('#detail').testAll('.chip').some((x) => x.textContent.startsWith('通過 '))) throw new Error('VLAN 詳情不應寫「通過 N 條鏈路」');
    const d = Q.devices().find((x) => x.kindBasis && x.kindBasis !== 'profile');
    App.select({ type: 'device', key: d.key });
    const kvEl = $('#detail').querySelector('.kv'); const ks = kvEl.childNodes;
    const at = ks.findIndex((x) => x.textContent === '類型依據');
    if (at < 0 || !ks[at + 1].testAll('.chip').some((x) => x.textContent === V.TERMS.inferred)) throw new Error('設備類型依據應標「推論」');
    const i = App.snap.model.interfaces.find((x) => x.typeBasis && x.typeBasis !== 'rawType');
    if (i) { App.select({ type: 'interface', key: i.key }); if (!$('#detail').querySelector('.row').testAll('.chip').some((x) => x.textContent.endsWith(`（${V.TERMS.inferred}）`))) throw new Error('推定的介面類型應在同一個 chip 標「（推論）」'); }
    App.select(null);
    // 介面狀態用 up／down（「連線」只用於防火牆的 TCP 連線與 SSH 連線）
    if (V.STATUS.up !== 'up' || V.STATUS.down !== 'down') throw new Error('介面狀態應寫 up／down');
    // 主機的定義只有一句（V.HOST_DEF）：顯示選單、覆蓋率篩選與狀態卡共用
    if (!($('#btn-hosts').getAttribute('title') || '').includes(V.HOST_DEF)) throw new Error('顯示選單「主機」的說明應使用 V.HOST_DEF');
    const hostsLine = $('#detail').querySelector('.status-hosts');
    if (hostsLine && !(hostsLine.getAttribute('title') || '').includes(V.HOST_DEF)) throw new Error('狀態卡的主機說明（title）應使用 V.HOST_DEF：' + hostsLine.textContent);
    if (!/hosts: \[V\.TERMS\.host, hosts, V\.HOST_DEF\]/.test(fs.readFileSync(path.join(ROOT, 'src/view/panels/lists.js'), 'utf8'))) throw new Error('覆蓋率的「主機」篩選應以 V.HOST_DEF 為說明');
    if ($('#btn-unknown').textContent !== V.TERMS.endpoint || $('#btn-groups').textContent !== V.TERMS.group) throw new Error('顯示選單應寫「終端」「分群」（V.TERMS）');
  });
  await step('用字：畫面程式、index.html 與本檔的 step 名稱不再出現已淘汰的說法（去掉註解後掃描字串）', () => {
    // 舊說法 → 現行說法（V.TERMS 等）；只掃畫面層，核心的 finding 訊息與 Snapshot 字串不在這裡。清單在 tests/lib.js（文件的檢查 tests/docs.js 共用 RETIRED_TERMS）
    const RETIRED = MD.RETIRED_UI_TERMS;
    // 清單裡的現行說法是字面文字，要和畫面的單一來源相同
    if (RETIRED.單側觀察 !== S.view.TERMS.hearsay || RETIRED.自動群組 !== S.view.TERMS.group || RETIRED.推定偏離 !== S.view.DEVIATION_LABEL) throw new Error('tests/lib.js 的 RETIRED_TERMS 現行說法應與 V.TERMS／V.DEVIATION_LABEL 相同');
    const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
    const sources = jsFiles('src/view').map((f) => [f.split(path.sep).join('/'), noComments(fs.readFileSync(path.join(ROOT, f), 'utf8'))])
      .concat([['index.html', html.replace(/<!--[\s\S]*?-->/g, '')]]);
    const hits = sources.flatMap(([f, src]) => Object.keys(RETIRED).filter((w) => src.includes(w)).map((w) => `${f}：「${w}」→ 改用「${RETIRED[w]}」`));
    // 本檔的 step 名稱也是給人看的（發布前檢查表逐字引用）：只掃名稱，不掃斷言字串（斷言可能要寫出舊詞來確認它不存在）。
    // 名稱另外不寫 L4 明細的舊層級代號，「連線」只用於網路／TCP／SSH 連線，拓樸的邊叫鏈路
    const STEP_RETIRED = Object.assign({}, RETIRED, { 'L1／L2': '位址組與牽涉的規則', '開 L3': '逐跳路徑', '同一個 L3': '逐跳路徑' });
    const names = [...stepSources().matchAll(/\bstep\('([^']+)'/g)].map((m) => m[1]);
    if (names.length < 50) throw new Error('應讀到本檔的 step 名稱，只讀到 ' + names.length + ' 個');
    names.forEach((n) => {
      Object.keys(STEP_RETIRED).filter((w) => n.includes(w)).forEach((w) => hits.push(`step「${n.slice(0, 30)}…」：「${w}」→ 改用「${STEP_RETIRED[w]}」`));
      if (/(?<!網路|TCP |SSH )連線/.test(n)) hits.push(`step「${n.slice(0, 30)}…」：拓樸的邊改用「${S.view.TERMS.link}」`);
    });
    if (hits.length) throw new Error('畫面或測試名稱仍有已淘汰的說法：\n        ' + hits.join('\n        '));
  });
  await step('用字：「驗證」的可見文字不出現內部格式代碼（ssot-…/N 只在 title 與格式說明的檔案範例）', () => {
    App.showStep('verify');
    const body = $('#verify-body'); let t = body.textContent;
    const fmt = body.querySelector('.expected-format');
    if (!fmt || !fmt.querySelector('.expected-fields')) throw new Error('預期現況的格式說明應先用中文列出各欄位');
    t = t.split(fmt.textContent).join('');
    const codes = t.match(/ssot-[a-z]+\/\d+/g);
    if (codes) throw new Error('驗證頁可見文字不應有格式代碼：' + S.util.uniq(codes).join('、'));
    App.showStep('triage');
  });
  await step('搜尋框：IP／MAC 前綴與介面名有結果，選介面、網段結果會選到它；路由追蹤有 IP 自動完成', async () => {
    const inp = $('#search'); const dd = $('#search-dd'); const type = searchFor;
    const pre = App.Q.ipEntries()[0].ip.split('.').slice(0, 2).join('.') + '.';
    if (!(await type(pre)).length || !text('#search-dd').includes(pre)) throw new Error('IP 前綴應有結果：' + pre);
    const first = App.Q.search(pre, 15)[0];
    inp.dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== first.type || App.sel.key !== first.key) throw new Error('Enter 應選取第一筆前綴結果：' + JSON.stringify(App.sel));
    if (first.type === 'subnet' && text('#detail').includes('基準中沒有這個網段')) throw new Error('網段結果應能開啟子網詳情');
    const mac = App.Q.macEntries()[0].mac; const macPre = mac.slice(0, 2) + ':' + mac.slice(2, 4);
    if (!(await type(macPre)).length || !text('#search-dd').toLowerCase().includes(macPre.toLowerCase())) throw new Error('MAC 前綴應有結果：' + macPre);
    const ifc = App.Q.interfacesOf(App.Q.devices().find((x) => x.collected).key).find((i) => i.name.length >= 3);
    if (!(await type(ifc.name)).length || dd.testAll('.empty').length) throw new Error('介面名應有結果：' + ifc.name);
    const at = App.Q.search(ifc.name, 15).findIndex((r) => r.type === 'interface');
    for (let k = 0; k < at; k++) inp.dispatch('keydown', { key: 'ArrowDown' });
    inp.dispatch('keydown', { key: 'Enter' });
    if (App.sel.type !== 'interface' || !App.Q.getInterface(App.sel.key) || !App.Q.getInterface(App.sel.key).name.includes(ifc.name)) throw new Error('應選取該介面：' + JSON.stringify(App.sel));
    const dl = $('#trace-ips'); const ips = new Set(App.Q.ipEntries().map((e) => e.ip));
    if (!dl || dl.tagName.toLowerCase() !== 'datalist') throw new Error('路由追蹤應有 IP 的 datalist');
    const opts = dl.testAll('option').map((o) => o.getAttribute('value'));
    if (opts.length !== ips.size || !opts.every((v) => ips.has(v))) throw new Error('datalist 每個 IP 一個選項（不分 VRF）');
    ['trace-src', 'trace-dst'].forEach((id) => { if ($('#' + id).getAttribute('list') !== 'trace-ips') throw new Error(id + ' 應掛上 datalist'); });
    const title = inp.getAttribute('title') || '';
    if (!title.includes('前綴') || !title.includes('介面名稱')) throw new Error('搜尋框的 title 應說明支援前綴與介面名稱');
    App.select(null);
  });
  await step('搜尋下拉的副標由畫面組成：類型、狀態、設備種類與 VLAN 片段用畫面的名詞，不出現英文列舉與舊詞；「vlan 30」「VLAN30」也找得到', async () => {
    const inp = $('#search'); const dd = $('#search-dd'); const type = async (v) => { await searchFor(v); return text('#search-dd'); };
    if ((inp.getAttribute('placeholder') || '').length > 16) throw new Error('搜尋框的提示字應簡短：' + inp.getAttribute('placeholder'));
    const vid = App.Q.vlanIds()[0];
    for (const q of [`vlan ${vid}`, `VLAN${vid}`]) if (!(await type(q)).includes('VLAN ' + vid)) throw new Error(q + ' 應找到 VLAN ' + vid);
    const dev = App.Q.devices().find((d) => d.collected); const ifc = App.Q.interfacesOf(dev.key).find((i) => i.name.length >= 3);
    const multi = App.Q.vlanIds().find((id) => App.Q.vlan(id).domains.length > 1);
    const subs = [];
    for (const q of [dev.label || dev.key, ifc.name, String(vid), multi ? String(multi) : null].filter(Boolean)) { await type(q); subs.push(...dd.testAll('.sub').map((e) => e.textContent)); }
    const bad = subs.filter((t) => /\b(switch|router|firewall|host|physical|lag|bridge|virtual|unknown)\b/.test(t) || t.includes('區塊'));
    if (bad.length) throw new Error('副標不應出現英文列舉或「區塊」：' + bad.slice(0, 3).join('｜'));
    if (!subs.some((t) => t.includes(S.view.KIND[dev.kind]))) throw new Error('設備的副標應寫出設備種類：' + S.view.KIND[dev.kind]);
    if (!subs.some((t) => t.includes(S.view.IFC_TYPE[ifc.type]))) throw new Error('介面的副標應寫出介面類型：' + S.view.IFC_TYPE[ifc.type]);
    if (multi && !subs.some((t) => t.includes(S.view.TERMS.vlanDomain))) throw new Error('有多個片段的 VLAN 應寫出「' + S.view.TERMS.vlanDomain + '」');
    await searchFor('');
  });
  await step('路由追蹤', () => {
    $('#btn-trace').click(); $('#trace-src').value = '8.8.8.8'; $('#trace-dst').value = '10.1.30.15';
    // 對調：交換來源與目的；說明文字用使用者的話（不寫 ECMP）
    const swap = $('#trace-swap');
    if (swap.tagName !== 'BUTTON' || !swap.textContent.includes('對調') || !/來源.*目的/.test(swap.getAttribute('aria-label') || '')) throw new Error('路由追蹤應有「對調」按鈕並有 aria 名稱');
    swap.click();
    if ($('#trace-src').value !== '10.1.30.15' || $('#trace-dst').value !== '8.8.8.8') throw new Error('對調應交換來源與目的');
    if (/ECMP/.test(text('#trace-pop')) || !text('#trace-pop').includes('等價多路徑')) throw new Error('路由追蹤的說明應寫「等價多路徑」而不是 ECMP：' + text('#trace-pop'));
    $('#trace-run').click();
    if (App.sel.result.ok && (!App.sel.reverse || !text('#detail').includes('回程（8.8.8.8 → 10.1.30.15）'))) throw new Error('去程成功時應同時顯示回程');
    const r = App.sel.result; // 沒有任何逐跳時「逐跳」區塊不顯示，但一定有「結果」或錯誤說明
    if (r.ok ? !text('#detail').includes('結果') : !text('#detail').includes(r.error)) throw new Error('追蹤結果未顯示');
    App.graph.draw();
  });
  await step('原文檢視', () => {
    App.openRaw(S.readers.PASTE, 10); if (!$('#dlg-raw').open || !text('#raw-body').includes('/export')) throw new Error('原文未顯示');
    if (!$('#raw-nav').classList.contains('hidden') || !text('#raw-title').includes('（第 10 行）')) throw new Error('只有一處時不顯示前後切換，標題寫出行號：' + text('#raw-title'));
    // opt.list 不含指定的那一行：仍顯示呼叫者要的那一行（加進清單的第一處），不靜默改顯示清單的第一筆
    $('#dlg-raw').close(); App.openRaw(S.readers.PASTE, 10, { list: [{ file: S.readers.PASTE, line: 12 }] });
    if (!text('#raw-title').includes('（第 10 行）') || text('#raw-pos') !== '1／2') throw new Error('清單不含指定行時應顯示指定行並列入清單：' + text('#raw-title') + '／' + text('#raw-pos'));
    $('#dlg-raw').close(); App.openRaw(S.readers.PASTE, 10);
    // 長行預設自動換行（窄螢幕不必橫捲），可切回不換行、橫向捲動（#raw-wrap → #dlg-raw.raw-nowrap，純 CSS）
    const wrap = $('#raw-wrap'); const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    if (!wrap || wrap.getAttribute('type') !== 'checkbox' || wrap.getAttribute('checked') === null || wrap.getAttribute('onchange') !== null) throw new Error('原文應有預設勾選的「自動換行」切換（在 JS 綁定，不用內嵌事件屬性）');
    wrap.checked = false; wrap.dispatch('change');
    if (!$('#dlg-raw').classList.contains('raw-nowrap')) throw new Error('取消「自動換行」應改為不換行');
    wrap.checked = true; wrap.dispatch('change');
    if ($('#dlg-raw').classList.contains('raw-nowrap')) throw new Error('勾回「自動換行」應恢復換行');
    const x = $('#raw-close');
    if (!x || x.getAttribute('onclick') !== null || x.getAttribute('aria-label') !== '關閉') throw new Error('原文的關閉鈕應有名稱、在 JS 綁定');
    x.click(); if ($('#dlg-raw').open) throw new Error('按關閉應關閉原文對話框');
    App.openRaw(S.readers.PASTE, 10);
    if (!/pre\.raw \{[^}]*white-space: pre-wrap;/.test(css) || !/#dlg-raw\.raw-nowrap pre\.raw \{ white-space: pre;/.test(css) || !/pre\.raw > span \{[^}]*text-indent: -56px/.test(css)) throw new Error('原文預設換行（懸掛縮排），不換行時橫向捲動');
    $('#dlg-raw').close();
  });
  await step('原文對話框的標題：區塊之間的標記行用下一行的區塊，都對不到時寫「檔名 第 N 行」，不出現兩組括號；可複製這段、顯示更多', async () => {
    const Q = App.Q; const P = S.readers.PASTE; const V = S.view;
    const lines = App.sources.find((s) => s.name === P).text.split(/\r?\n/);
    const nums = lines.map((_, i) => i + 1);
    const marker = nums.find((l) => !Q.blockAt(P, l) && Q.blockAt(P, l + 1));
    const orphan = nums.find((l) => !Q.blockAt(P, l) && !Q.blockAt(P, l + 1));
    if (marker) {
      App.openRaw(P, marker);
      if (!text('#raw-title').startsWith(V.blockWhere(Q, Q.blockAt(P, marker + 1))) || !text('#raw-title').endsWith(`（第 ${marker} 行）`)) throw new Error('標記行的標題應用下一行所屬的區塊：' + text('#raw-title'));
    }
    if (orphan) {
      App.openRaw(P, orphan);
      if (text('#raw-title') !== `${V.fileName(P)} 第 ${orphan} 行`) throw new Error('對不到區塊時標題應寫「檔名 第 N 行」：' + text('#raw-title'));
    }
    [marker, orphan, 10].filter(Boolean).forEach((l) => { App.openRaw(P, l); if (/）（/.test(text('#raw-title'))) throw new Error('原文標題不應有兩組相連的括號：' + text('#raw-title')); });
    // 複製這段：有所屬區塊時複製整個區塊的原文，結果寫在對話框的狀態列
    const line = nums.find((l) => { const b = Q.blockAt(P, l); return b && l - b.start > 15 && lines.length - l > 40; });
    if (!line) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有長的區塊'); }
    App.openRaw(P, line); const blk = Q.blockAt(P, line);
    const copyBtn = $('#raw-copy');
    if (copyBtn.tagName !== 'BUTTON' || copyBtn.classList.contains('hidden') || !copyBtn.textContent.includes('複製這段')) throw new Error('原文應有「複製這段」按鈕');
    if (copyBtn.classList.contains('ghost')) throw new Error('「複製這段」應用一般按鈕樣式（不是 ghost），看得出是按鈕');
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); let copied = null;
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied = t; } } }, configurable: true, writable: true });
    try {
      copyBtn.click(); await new Promise((r) => setTimeout(r, 5));
      if (copied !== lines.slice(blk.start - 1, blk.end).join('\n') || text('#raw-copy-status') !== `已複製 ${blk.end - blk.start + 1} 行`) throw new Error('複製這段應複製整個區塊的原文並在對話框提示：' + text('#raw-copy-status'));
      if ($('#raw-copy-status').getAttribute('role') !== 'status') throw new Error('複製結果應寫在 role=status 的狀態列');
      globalThis.navigator = {}; copyBtn.click(); await new Promise((r) => setTimeout(r, 5));
      if (!text('#raw-copy-status').includes('無法自動複製')) throw new Error('不能複製時應明確告知：' + text('#raw-copy-status'));
      // 複製還沒完成就換到另一段：舊的結果不可寫到新的一段
      let done = null; globalThis.navigator = { clipboard: { writeText: () => new Promise((r) => { done = r; }) } };
      copyBtn.click(); App.openRaw(P, line + 1);
      if (text('#raw-copy-status') !== '') throw new Error('換到另一段時狀態列應清空');
      done(); await new Promise((r) => setTimeout(r, 5));
      if (text('#raw-copy-status') !== '') throw new Error('舊一段的複製結果不應寫到新的一段：' + text('#raw-copy-status'));
      App.openRaw(P, line);
    } finally { if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator; }
    // 顯示更多：前後各有按鈕，按下後多顯示幾行，標出的那一行不變；切到另一處時回到預設範圍
    const shown = () => $('#raw-body').testAll('pre .ln').map((x) => +x.textContent);
    const more = (side) => $('#raw-body').testAll('.raw-more').find((b) => b.getAttribute('data-side') === side);
    const before = shown();
    if (!before.length || !more('before') || !more('after') || before[0] <= 1 || before[before.length - 1] >= lines.length) throw new Error('只顯示部分時前後應有「顯示更多」');
    // 按鈕寫出按下後會多顯示的實際範圍（UX #24）
    const range = (side) => (side === 'before' ? [Math.max(1, before[0] - 100), before[0] - 1] : [before[before.length - 1] + 1, Math.min(lines.length, before[before.length - 1] + 100)]);
    ['before', 'after'].forEach((sd) => { const [x, y] = range(sd); if (!more(sd).textContent.includes(`第 ${x}–${y} 行`)) throw new Error("「顯示更多」應寫出實際範圍：" + more(sd).textContent); });
    more('after').click(); const a1 = shown();
    if (a1[a1.length - 1] !== range('after')[1]) throw new Error('按下後顯示到按鈕寫的那一行');
    if (a1[0] !== before[0] || a1[a1.length - 1] <= before[before.length - 1] || $('#raw-body').querySelector('.hl').firstChild.textContent !== String(line)) throw new Error('「顯示後面」應往後多顯示，標出的行不變');
    more('before').click(); const a2 = shown();
    if (a2[0] >= a1[0] || a2[a2.length - 1] !== a1[a1.length - 1]) throw new Error('「顯示前面」應往前多顯示');
    if (!!more('before') !== (a2[0] > 1)) throw new Error('前面還有沒顯示的行時才有「顯示前面」');
    App.openRaw(P, line); if (shown().length !== before.length) throw new Error('重新開啟時回到預設的範圍');
    $('#dlg-raw').close();
  });
  await step('原文對話框：標題是「設備 › 指令（第 N 行）」；多處證據可用上一處／下一處或 ←→ 切換（頭尾相接）', () => {
    const Q = App.Q; const all = App.snap.findings;
    const i = all.findIndex((f) => f.id !== 'C02' && f.entities.length && f.evidence.length >= 2);
    if (i < 0) { if (process.env.SMOKE_INPUT) return; throw new Error('範例資料應有多處證據的檢查結果'); }
    const f = all[i]; const n = f.evidence.length; App.selectFinding(i);
    const link = $('#detail').testAll('.finding a').find((a) => a.getAttribute('aria-label') === `原文 第 ${f.evidence[1].line} 行`);
    if (!link) throw new Error('詳情應有第二處證據的原文連結');
    link.click();
    const blk = Q.blockAt(f.evidence[1].file, f.evidence[1].line);
    if (!$('#dlg-raw').open || !text('#raw-title').includes(`（第 ${f.evidence[1].line} 行）`) || (blk && !text('#raw-title').startsWith(S.view.blockWhere(Q, blk)))) throw new Error('原文標題應顯示「設備 › 指令（第 N 行）」：' + text('#raw-title'));
    if (blk && !text('#raw-title').includes(' › ')) throw new Error('原文標題應有「設備 › 指令」');
    const hlLine = () => $('#raw-body').querySelector('.hl').firstChild.textContent;
    if ($('#raw-nav').classList.contains('hidden') || text('#raw-pos') !== `2／${n}` || hlLine() !== String(f.evidence[1].line)) throw new Error('多處證據應顯示位置 i／n 並高亮該行：' + text('#raw-pos'));
    $('#dlg-raw').dispatch('keydown', { key: 'ArrowLeft' });
    if (text('#raw-pos') !== `1／${n}` || hlLine() !== String(f.evidence[0].line) || !text('#raw-title').includes(`第 ${f.evidence[0].line} 行`)) throw new Error('← 應切到上一處');
    $('#raw-prev').click();
    if (text('#raw-pos') !== `${n}／${n}` || hlLine() !== String(f.evidence[n - 1].line)) throw new Error('上一處應從第一處繞到最後一處');
    $('#raw-next').click(); if (text('#raw-pos') !== `1／${n}`) throw new Error('下一處應從最後一處繞回第一處');
    $('#dlg-raw').dispatch('keydown', { key: 'ArrowRight', shiftKey: true });
    if (text('#raw-pos') !== `1／${n}`) throw new Error('加了修飾鍵的方向鍵不應切換');
    $('#dlg-raw').dispatch('keydown', { key: 'ArrowRight' }); if (text('#raw-pos') !== `2／${n}`) throw new Error('→ 應切到下一處');
    if (!['raw-prev', 'raw-next'].every((id) => $('#' + id).tagName === 'BUTTON' && $('#' + id).textContent)) throw new Error('上一處／下一處應是有名稱的按鈕');
    $('#dlg-raw').close();
    // 長行在 pre 內橫向捲動，行號不換行且固定在左邊
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    if (!/pre\.raw\s*\{[^}]*overflow-x:\s*auto/.test(css) || !/pre\.raw \.ln\s*\{[^}]*white-space:\s*nowrap[^}]*position:\s*sticky[^}]*left:\s*0/.test(css)) throw new Error('原文長行應在 pre 內橫向捲動，行號不換行且固定在左邊');
    App.select(null);
  });
  await step('詳情的表格包在 .table-scroll：識別字不逐字斷行，放不下時橫向捲動', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    if (/\.hscroll/.test(css)) throw new Error('表格捲動外框只用 V.table 的 .table-scroll，不另包一層');
    const d0 = App.snap.model.devices.find((d) => d.collected);
    const l = App.snap.model.links.find((x) => x.src && x.src.length);
    [{ type: 'device', key: d0.key }, { type: 'link', key: l.key }].forEach((sel) => {
      App.select(sel);
      const tables = $('#detail').testAll('table'); const wrapped = $('#detail').testAll('.table-scroll table');
      if (sel.type === 'device' && !tables.length) throw new Error('設備詳情應有表格');
      if (tables.some((t) => !wrapped.includes(t))) throw new Error(`${sel.type} 詳情的表格應包在 .table-scroll 內`);
    });
    // 來源列與原文標題同一寫法（V.blockWhere）
    const [b0, line0] = l.src[0]; const blk = App.Q.block(b0);
    if (!text('#detail').includes(`${S.view.blockWhere(App.Q, blk)}・第 ${line0} 行`)) throw new Error('來源列應寫成「設備 › 指令・第 N 行」');
    App.select(null);
  });
};
