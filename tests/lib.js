// 核心測試共用的 helper 與測試清單：tests/core/*.js、tests/workflow/*.js 都由這裡取得 S 與 test()。
// 只放兩個以上測試檔都用到的 helper；只服務單一檔案的 helper 留在該檔案裡。
// 注意：測試用的 RouterOS 輸出是依文件與慣例撰寫，不是從真實設備擷取；真實輸出請另外驗證。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const load = require('./load.js');
// 所有測試檔共用同一個 SSOT 命名空間（require 會快取這個模組）
const S = load();

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const build = (text, opt) => S.build([{ name: 't.txt', text }], Object.assign({ now: '2026-01-01T00:00:00Z' }, opt));
const ids = (snap) => snap.findings.map((f) => f.id);
const count = (snap, id) => snap.findings.filter((f) => f.id === id).length;
const gen = (args) => execFileSync('node', [path.join(ROOT, 'tools/gen-bundle.js'), ...args], { encoding: 'utf8', maxBuffer: 5e8 });
const iface = (s, k) => s.model.interfaces.find((i) => i.key === k);
const addrs = (s, ep) => s.model.ipAddresses.filter((a) => a.ep === ep).map((a) => a.address);

// 測試依登錄順序執行；tests/run.js 依檔名順序載入測試檔
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const i03 = (s) => s.findings.filter((f) => f.id === 'I03');
// 鄰居表與 MAC 表的區塊（不含設備標頭）
const NB = (rows) => ['### /ip neighbor print detail without-paging', ...rows].join('\n');
const BH = (rows) => ['### /interface bridge host print detail without-paging', 'Flags: D - dynamic, L - local', ...rows].join('\n');
// 一台 WAN＝ether1、LAN＝bridge1 的路由器，加上 export 行
const fwBox = (lines, opt) => build(['R (10.0.0.1):', '### /export terse', '/interface bridge add name=bridge1',
  ...(opt && opt.noLists ? [] : ['/interface list add name=WAN', '/interface list add name=LAN', '/interface list member add interface=bridge1 list=LAN',
    ...(opt && opt.emptyWan ? [] : ['/interface list member add interface=ether1 list=WAN'])]), ...lines].join('\n'));
const fws = (s, id) => s.findings.filter((f) => f.id === id);
// 比對前把 CRLF 換成 LF：.gitattributes 已設 eol=lf，但 Windows 上若設定 core.autocrlf 等仍可能拿到 CRLF 的工作檔，換行不同不算生成檔過期。
const lf = (s) => s.replace(/\r\n/g, '\n');
// 範例資料的黃金基準 Snapshot（與 tests/golden.js、npm run golden:update 同一個產生方式）
const sampleSnap = () => require('./golden.js').goldenSnapshot(S);

module.exports = { S, ROOT, read, build, ids, count, gen, iface, addrs, tests, test, i03, NB, BH, fwBox, fws, lf, sampleSnap };
