// 檢查結果報表（S.report）的固定情境：tests/workflow/report.js 用它和同一目錄的預期輸出逐字比對。
// 預期輸出是報表移到核心之前、畫面版（src/view/export.js）的輸出；之後刻意改變報表格式時，以 regenerate() 重新產生並檢視 git diff。
// 情境涵蓋：CSV 跳脫（逗號、引號、換行、公式開頭、前後空白）、Markdown 跳脫（格式字元、行內程式碼的反引號）、
// 與多數不同（多數決、平手、不是多數決）、CATALOG 有／沒有處理建議與常見原因、處理紀錄各狀態（含不認得的狀態、豁免、備註）、依設備分組。
'use strict';
const fs = require('fs');
const path = require('path');

const NOW = '2026-01-01T00:00:00Z';
const DIR = __dirname;
// 手寫的三台設備：檢查結果換成下面的人工 finding（只透過 Q 讀取，所以換掉 findings 再建立查詢介面即可）
const INPUT = [
  'SW_B (10.0.0.2):', '### /system identity print', 'name: SW_B',
  'SW_A (10.0.0.1):', '### /system identity print', 'name: SW_A',
  'R_C (10.0.0.3):', '### /system identity print', 'name: R_C',
].join('\n') + '\n';

function snapshot(S) {
  const snap = S.build([{ name: 't.txt', text: INPUT }], { now: NOW });
  // 版本固定：升版時預期輸出不跟著變（報表只照抄 meta.version／schema）
  snap.meta = Object.assign({}, snap.meta, { version: '0.0.0-report', schema: 'ssot-snapshot/report' });
  const devs = ['SW_A', 'SW_B', 'R_C'];
  const ev = (line, text) => ({ file: 't.txt', line, text, block: 0 });
  snap.findings = [
    { id: 'I01', severity: 'error', title: '無法辨識的內容', message: '無法辨識的內容：t.txt 第 1–2 行（指令：/foo）', entities: [], evidence: [ev(1, '=x')] },
    { id: 'T01', severity: 'warn', title: '標題, "引號"', message: '第一行\r\n第二行, "x"', entities: [{ type: 'device', key: 'SW_B' }],
      evidence: [ev(3, 'a`b'), { file: 'b "x".txt', line: 9, text: '' }] },
    { id: 'I02', severity: 'warn', title: '同一設備重複提供同類資料（以後者為準）', message: '<b>*x*</b> [連結](u) | 管線 \\ 反斜線 TPE_ACC_SW_01',
      entities: [{ type: 'device', key: 'SW_A' }], facet: 'mikrotik.arp', evidence: [ev(5, '``')] },
    { id: 'T02', severity: 'warn', title: '多數決', message: '=1+1 與多數不同', entities: [{ type: 'device', key: 'SW_A' }, { type: 'device', key: 'SW_B' }],
      evidence: [], deviation: { basis: 'majority', deviating: [devs[2], devs[1]], groups: [], main: null } },
    { id: 'T03', severity: 'info', title: '平手', message: ' 前後空白 ', entities: [{ type: 'device', key: 'R_C' }], evidence: [],
      deviation: { basis: 'majority', deviating: [], groups: [], main: null } },
    { id: 'T03', severity: 'info', title: '平手', message: '不是多數決', entities: [{ type: 'device', key: 'A,B' }], evidence: [],
      deviation: { basis: 'other', deviating: [devs[0]] } },
    { id: 'I01', severity: 'error', title: '無法辨識的內容', message: '-負號開頭', entities: [{ type: 'device', key: 'R_C' }], evidence: [ev(7, 'x\ny')] },
  ];
  return snap;
}

/** 處理紀錄：依 finding 的位置給固定狀態（open、各種已處理、復發、不認得的狀態、豁免、備註） */
const LEDGER = [
  null,
  { status: 'false-positive', at: '2026-01-02T00:00:00Z', note: '=備註, "引號"', waiver: null },
  { status: 'accepted', at: null, note: '', waiver: { reason: '', until: '2026-06-01T00:00:00Z' } },
  { status: 'regressed', at: '2026-01-03T00:00:00Z', note: '復發備註', waiver: null },
  { status: 'weird', at: '2026-01-04T00:00:00Z', note: null, waiver: { reason: '原因 *x*', until: '2026-07-01T00:00:00Z' } },
  { status: 'open', at: null, note: '待處理備註', waiver: null },
  { status: 'fixed', at: '2026-01-05T00:00:00Z', note: '', waiver: null },
];

/** 情境名稱（也是預期輸出的檔名）→ 用 impl（{ findingsCsv, findingsMarkdown }）產生的文字 */
function outputs(S, impl) {
  const snap = snapshot(S); const Q = S.query(snap);
  const ledgerOf = (f) => LEDGER[snap.findings.indexOf(f)] || null;
  const out = {};
  [['plain', undefined], ['by-device', { byDevice: true }], ['ledger', { ledgerOf }], ['ledger-by-device', { ledgerOf, byDevice: true }]].forEach(([name, opts]) => {
    out[name + '.csv'] = impl.findingsCsv(Q, opts);
    out[name + '.md'] = impl.findingsMarkdown(Q, opts);
  });
  // 沒有任何檢查結果
  const empty = S.query(Object.assign({}, snap, { findings: [] }));
  out['empty.csv'] = impl.findingsCsv(empty);
  out['empty.md'] = impl.findingsMarkdown(empty);
  out['empty-by-device.md'] = impl.findingsMarkdown(empty, { byDevice: true });
  return out;
}

/** 重新產生預期輸出（刻意改變報表格式時才用；之後以 git diff 檢視） */
function regenerate(S, impl) {
  fs.mkdirSync(DIR, { recursive: true });
  Object.entries(outputs(S, impl)).forEach(([name, text]) => fs.writeFileSync(path.join(DIR, name), text));
}

module.exports = { outputs, regenerate, DIR };
