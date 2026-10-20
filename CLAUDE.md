# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

本專案文件、測試名稱、finding 訊息與 commit message 皆使用繁體中文；新增內容請沿用。
開發原則（鐵則、工作習慣、針對性守則、驗證底線）與 GitHub Copilot 共用同一份，在此匯入：

@.github/copilot-instructions.md

## 專案概要

由 MikroTik RouterOS CLI 輸出建立網路現況基準（Snapshot）的純前端工具：零相依套件、可離線，
`index.html` 直接以 `file://` 開啟即可使用。核心把 CLI 文字轉成可追溯的純 JSON Snapshot，
畫面只是 Snapshot 的檢視。`tools/collect.sh` 是另一個獨立的 Bash SSH 收集器（產出 `bundle-v1`）。

## 指令

只需要 Node.js（CI 使用 Node 20／24），沒有 build、lint 或 format script。

```bash
npm test                 # node tests/run.js && bash tests/collect.sh && node tests/ui-smoke.js
npm run test:large       # 核心測試＋約 1000 台壓力測試
node tests/run.js        # 只跑核心測試
node tests/ui-smoke.js   # 只跑畫面冒煙測試（模擬 DOM）
bash tests/collect.sh    # 只跑 SSH 收集器測試
npm run sample           # 重新產生 samples/sample-bundle.txt 並嵌入成 sample-bundle.js
npm run oui -- <oui-data.json>   # 重新產生 src/data/oui-data.js
git diff --check         # 提交前檢查
```

`tests/run.js` 沒有篩選單一測試的參數；它是自製的 `test(name, fn)` 清單，要單跑某項時可暫時只保留該測試，
或在 Node REPL 以 `require('./tests/load.js')()` 取得 `SSOT` 命名空間直接呼叫 `S.build(...)`。
新增測試使用既有 `build(text)` helper（固定 `now: '2026-01-01T00:00:00Z'`）。

## 架構

- **非 ES module**：所有檔案都是一般 `<script>`，掛在全域 `globalThis.SSOT`（程式內慣稱 `S`）上，
  以 IIFE `(function (S) { ... })(globalThis.SSOT)` 撰寫。這是為了 `file://` 可直接開啟，不要改成 import/bundler。
- **載入順序是契約**：[tools/core-files.js](tools/core-files.js) 定義核心檔案順序，`tests/load.js` 用 `vm` 依此在 Node 載入
  與瀏覽器相同的檔案；`index.html` 的前段 `<script>` 必須與它完全一致（有測試檢查）。新增核心檔案要兩邊同步加。
  `index.html` 之後再載入 profiles、嵌入的範例與 `src/view/*`。`vendor/` 不在 `index.html` 裡，由畫面層需要時動態載入，也不列入核心載入順序。
- **管線**（[src/pipeline.js](src/pipeline.js)，`S.build(sources, options) → Snapshot`）：
  ① `readers/`（bundle-v1、files-v1，依 `readers/index.js` 的 `ORDER` 選擇）切成區塊，保留檔案與行號
  → ② `adapters/` 辨識指令 → ③ `adapters/mikrotik.js` 解析為帶 `block`/`line` 的事實
  → ④ `model/build.js` 事實→實體 → ⑤ `model/infer.js` 推論（設備類型、配對、未知對端等）
  → ⑥ `check/checks.js` 依 `CATALOG` 產生 findings（I01、K01、A02…）。
  `steps()` 是 generator，讓 UI 可顯示進度。
- **單向依賴**：核心（core/readers/adapters/model/check/profile/query/compare/pipeline）不得碰 DOM、Canvas、IndexedDB。
  View 與 compare 只透過 `SSOT.query(snapshot)`（[src/query/query.js](src/query/query.js)）讀取，不讀原始 model、不改寫 Snapshot。
  `src/view/theme.js` 是顏色／線型／透明度的唯一來源；持久化集中在 `src/view/store.js`。
- **事實 vs 推論**：收集到的設備、介面、鏈路、VLAN、位址、路由是事實；推論需標示。命名 profile（`src/profile/`）
  只能 canonicalize 或加註解，不能新增／刪除／改寫事實。
- **鏈路語意**：`S.LINK_SCOPE` 區分 interface-adjacency（LLDP／CDP）、broadcast-domain（純 MNDP，只證明 L2 可達，
  不可當直連證據）、routing-adjacency（OSPF，不作為拓樸 edge）。
- **Snapshot 模型（`ssot-snapshot/2`）**：欄位命名參考 NetBox。完整欄位表見 [docs/design-ssot.md](docs/design-ssot.md) §5.2，以下是容易用錯的地方：
  - 介面的 VLAN 分成 `pvid`／`untaggedVlans`／`taggedVlans`，取聯集用 `S.util.ifcVlans(i)`。
  - 介面之間的關係都存 ep 鍵，不共用欄位：聚合用 `lag`／`lagMembers`，bridge port 用 `bridge`，VLAN 子介面用 `parent`＋`encapVlan`。
  - `type` 是封閉列舉 `S.IFC_TYPES`，原值在 `rawType`。
  - IP 是獨立的 `ipAddresses` 實體，另有推導出的 `prefixes`；介面上沒有 `ips`。畫面用 `Q.addressesOf(ep)`／`Q.ipsOf(ep)` 取得。
  - 設備身分欄位是 `manufacturer`／`deviceType`／`softwareVersion`。
  - 內部模型 M 用 Map/Set，只在 `pipeline.js` 的 `serialize` 轉成陣列。
- **拓樸版面**：
  - [layout.js](src/view/graph/layout.js) 的 `prepare()` 負責分群、終端與分層，`shelf()` 負責書架排列，內建版面與分層版面共用。
  - 分層版面在 [elk-layout.js](src/view/graph/elk-layout.js)，使用 vendor 的 ELK.js（`vendor/elkjs-0.11.1/`，EPL-2.0）。ELK 約 1.6 MB，第一次需要時才以 `<script>` 載入（路徑定義在 `ENGINE_SRC`）；冒煙測試的模擬 DOM 會模擬這個動態載入。
  - 流程是先用內建版面同步出圖，沒有儲存位置時再於背景套用 ELK。超過 `App.ELK_MAX` 台或逾時就維持內建版面，並以 banner 說明原因。
- **可重現**：相同輸入與選項必得相同 Snapshot（`meta.createdAt`、`meta.timing` 除外）；不可用時間、隨機值或環境影響核心結果。
  `S.VERSION` 與 `S.SCHEMA` 定義於 [src/core/ns.js](src/core/ns.js)。

## 修改守則（補充匯入的開發原則）

- **擴充點**：新廠牌 → `src/adapters/` 新檔＋`S.adapters.register()`，加入 `tools/core-files.js` 與 `index.html`；
  新輸入格式 → `src/readers/` 並加入 `ORDER`；新檢查 → `CATALOG` 加一筆並實作。
- **生成檔的指令**：`samples/sample-bundle.txt`／`.js` 用 `npm run sample`，`src/data/oui-data.js` 用 `npm run oui`。
  範例資料刻意含問題；新增檢查時要在產生器放對應問題並加測試。
- 解析器依 RouterOS 文件撰寫，測試資料為手寫／產生，尚未以真實設備驗證；欄位語意以官方手冊
  <https://manual.mikrotik.com/llms.txt> 為準。
- 大型冒煙測試（`SMOKE_INPUT=samples/large-1000.txt node tests/ui-smoke.js`）的「基準摘要與行動入口」一項本來就會失敗：
  它檢查範例資料才有的「LLDP 單向」，乾淨的大型網路沒有這個問題。

## 專用流程（skills）

三個 skill 放在 `.claude/skills/`，Claude Code 會自動載入；`.github/skills/` 是同內容的 GitHub Copilot 版。
修改時兩邊一起改，`tests/run.js` 會檢查兩者一致。
- `routeros-parser-fixtures`：改 adapter／解析、新收集指令（先寫失敗測試再修）
- `snapshot-contract-change`：改 Snapshot 欄位、finding id、query API 或版本（逐層走完 adapter→model→infer/check→pipeline→query→view→compare）
- `mikrotik-neighbor-topology`：改鄰居探索（LLDP／MNDP／CDP）與拓樸
