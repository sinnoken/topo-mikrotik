# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

本專案文件、測試名稱、finding 訊息與 commit message 皆使用繁體中文；新增內容請沿用。
`docs/` 下給人看的文件也用中文檔名（例如 `docs/基準檢查規則.md`）。
開發原則（鐵則、工作習慣、針對性守則、驗證底線）與 GitHub Copilot 共用同一份，在此匯入：

@.github/copilot-instructions.md

## 專案概要

由 MikroTik RouterOS CLI 輸出建立網路現況基準（Snapshot）的純前端工具：零相依套件、可離線，
`index.html` 直接以 `file://` 開啟即可使用。核心把 CLI 文字轉成可追溯的純 JSON Snapshot，
畫面只是 Snapshot 的檢視。`tools/collect.sh` 是另一個獨立的 Bash SSH 收集器（產出 `bundle-v1`）。

## 指令

只需要 Node.js（CI 使用 Node 22／24），沒有 build、lint 或 format script。

```bash
npm test                 # 全部：核心、文件、收集器、畫面
npm run test:core        # 只跑核心測試（tests/core、tests/workflow；含收集器端到端測試，需要 bash 與 GNU timeout，Windows 用 Git Bash）
npm run test:docs        # 只跑文件與分工一致性（tests/docs.js）
npm run test:collector   # 只跑 SSH 收集器測試（tests/collect.sh）
npm run test:ui          # 只跑畫面冒煙測試（tests/ui-smoke.js，模擬 DOM）
npm run test:large       # 核心測試＋約 1000 台壓力測試
npm run test:core -- --grep A02   # 只跑名稱含 A02 的測試（可與 --large 並用；沒有符合的測試時以失敗結束）
SSOT_LARGE_MAX_MS=30000 npm run test:large   # 覆寫壓力測試時間上限（預設 20000 ms；非數字或 ≤0 直接失敗）
npm run golden:update    # 刻意改變 Snapshot 後更新黃金基準（tests/golden/），提交前用 git diff 檢視
node tools/anonymize.js 收集檔.txt -o tests/fixtures/real/<版本>-<型號>.txt   # 真實輸出去識別化後當測試資料
npm run sample           # 重新產生 samples/sample-bundle.txt 並嵌入成 sample-bundle.js
npm run gen:large        # 產生 samples/large-1000.txt（已 gitignore，大型冒煙測試前需先產生）
npm run oui -- <index.json>      # 重新產生 src/data/oui-data.js（來源：npm pack oui-data@<版本>，見 README）
git diff --check         # 提交前檢查
```

`tests/run.js` 只是執行器：依檔名載入 `tests/core/*.js`（data-model）再載入 `tests/workflow/*.js`（workflow），
`--large` 時最後載入 `tests/large.js`；共用 helper 在 `tests/lib.js`（`test`、`build` 等）。新增測試放進對應模組的檔案，
從 `require('../lib.js')` 取得 helper。可用 `--grep <文字>` 只跑名稱含該文字的測試（區分大小寫），
結尾會註明「已篩選：N／總數」；沒有任何測試符合或參數不認得時以失敗結束。
也可在 Node REPL 以 `require('./tests/load.js')()` 取得 `SSOT` 命名空間直接呼叫 `S.build(...)`。
新增測試使用既有 `build(text)` helper（固定 `now: '2026-01-01T00:00:00Z'`）。

## 架構

- **非 ES module**：所有檔案都是一般 `<script>`，掛在全域 `globalThis.SSOT`（程式內慣稱 `S`）上，
  以 IIFE `(function (S) { ... })(globalThis.SSOT)` 撰寫。這是為了 `file://` 可直接開啟，不要改成 import/bundler。
- **載入順序是契約**：[tools/core-files.js](tools/core-files.js) 定義核心檔案順序，`tests/load.js` 用 `vm` 依此在 Node 載入
  與瀏覽器相同的檔案；`index.html` 的前段 `<script>` 必須與它完全一致（有測試檢查）。新增核心檔案要兩邊同步加。
  `index.html` 之後再載入 profiles、嵌入的範例與 `src/view/*`。`vendor/` 不在 `index.html` 裡，由畫面層需要時動態載入，也不列入核心載入順序。
  畫面起點是 `src/view/app.js`（建立 `App` 與 `S.view.app`，程式內稱 `A`），必須在其他 `app-*.js`
  （graph／select／panes／toolbar／input／ledger）之前載入；這些檔案載入時只定義函式，DOMContentLoaded 後才執行。
- **管線**（[src/pipeline.js](src/pipeline.js)，`S.build(sources, options) → Snapshot`）：
  ① `readers/`（bundle-v1、files-v1，依 `readers/index.js` 的 `ORDER` 選擇）切成區塊，保留檔案與行號
  → ② `adapters/` 辨識指令 → ③ `adapters/mikrotik.js` 解析為帶 `block`/`line` 的事實
  → ④ `model/build.js` 事實→實體 → ⑤ `model/infer.js` 推論（設備類型、推論鏈路、VLAN 區塊、終端埠、Wi-Fi 位置、
  防火牆 WAN／LAN 等，全部在檢查之前完成）→ ⑥ `check/checks.js` 依 `check/catalog.js` 的 `CATALOG`（I01、K01、A02、F01…）
  產生 findings，只讀模型、不寫回；`catalog.js` 必須在 `checks.js` 之前載入。
  `steps()` 是 generator，讓 UI 可顯示進度。
- **單向依賴**：核心分成上游與下游。上游（core/readers/adapters/model/check/profile/query/pipeline）產生並查詢 Snapshot；
  下游（`compare/` 比對、`remediate/` 修正 patch、`ledger/` 處理紀錄）也是核心檔案，但只透過 `SSOT.query(snapshot)` 讀基準、
  不修改基準，上游也不呼叫它們。所有核心都不得碰 DOM、Canvas、IndexedDB。View 與下游只透過 `SSOT.query(snapshot)`（[src/query/query.js](src/query/query.js)）讀取，不讀原始 model、不改寫 Snapshot。
  `src/view/theme.js` 是顏色／線型／透明度的唯一來源；持久化集中在 `src/view/store.js`。
  畫面讀 `CATALOG` 的 `causes`／`action` 只透過 `V.remediation.advice(id)`；含反引號的文字以 `V.codeText` 組成 DOM，不用 innerHTML。
- **比對與檢視狀態**：`compare/` 有預期資料比對（`S.compare`）、由基準產生預期資料（`S.compare.expectedFrom`）與
  新舊基準比對（`S.compare.snapshots`，`ssot-snapdiff/1`）。finding 的穩定鍵是 `Q.findingKey(f)`；
  處理紀錄（`S.ledger`，`ssot-ledger/1`）以它為鍵存在 store 的 `'ledger'`，是使用者的資料，不進 Snapshot；
  舊的 `'acks'` 第一次遇到基準時以 `S.ledger.fromAcks` 轉換。同一輪的判斷依 `meta.baselineKey`（輸入＋major.minor＋命名規則與預期資料）。
  修正 patch（`S.remediate`，`ssot-patch/1`）只產生 .rsc 文字，不連線設備（[ADR-001](docs/架構決策/001-工具維持唯讀.md)）。
- **事實 vs 推論**：收集到的設備、介面、鏈路、VLAN、位址、路由是事實；推論需標示。命名 profile（`src/profile/`）
  只能 canonicalize 或加註解，不能新增／刪除／改寫事實。
- **鏈路語意**：`S.LINK_SCOPE` 區分 interface-adjacency（LLDP／CDP）、broadcast-domain（純 MNDP，只證明 L2 可達，
  不可當直連證據）、routing-adjacency（OSPF，不作為拓樸 edge）。
- **Snapshot 模型（`ssot-snapshot/2`）**：欄位命名參考 NetBox。完整欄位表見 [docs/設計說明.md](docs/設計說明.md) §5.2，以下是容易用錯的地方：
  - 介面的 VLAN 分成 `pvid`／`untaggedVlans`／`taggedVlans`，取聯集用 `S.util.ifcVlans(i)`。
  - 介面之間的關係都存 ep 鍵，不共用欄位：聚合用 `lag`／`lagMembers`，bridge port 用 `bridge`，VLAN 子介面用 `parent`＋`encapVlan`。
  - `type` 是封閉列舉 `S.IFC_TYPES`，原值在 `rawType`。
  - IP 是獨立的 `ipAddresses` 實體，另有推導出的 `prefixes`；介面上沒有 `ips`。畫面用 `Q.addressesOf(ep)`／`Q.ipsOf(ep)` 取得。
  - 設備身分欄位是 `manufacturer`／`deviceType`／`softwareVersion`。
  - 防火牆規則 `firewallRules` 的 `key` 是「設備|位址族|表|chain|簽章雜湊」，不含編號（插入規則不會讓後面的鍵改變）；
    WAN／LAN 推論在 `firewallZones`，只看名稱含 WAN／LAN 的 interface list。規則比對語意集中在 `S.infer.fw`，不要另寫一套。
  - `blocks[].collectedAt`／`failure` 與 `coverage[].failures` 來自收集器的 `# collected-at:`、`# collection failed:` 註解。
  - 內部模型 M 用 Map/Set，只在 `pipeline.js` 的 `serialize` 轉成陣列。
- **拓樸版面**：
  - [layout.js](src/view/graph/layout.js) 的 `prepare()` 負責分群、終端與分層，`shelf()` 負責書架排列，內建版面與分層版面共用。
  - 分層版面在 [elk-layout.js](src/view/graph/elk-layout.js)，使用 vendor 的 ELK.js（`vendor/elkjs-0.11.1/`，EPL-2.0）。ELK 約 1.6 MB，第一次需要時才以 `<script>` 載入（路徑定義在 `ENGINE_SRC`）；冒煙測試的模擬 DOM 會模擬這個動態載入。
  - 流程是先用內建版面同步出圖，沒有儲存位置時再於背景套用 ELK。超過 `App.ELK_MAX` 台或逾時就維持內建版面，並以 banner 說明原因。
- **可重現**：相同輸入與選項必得相同 Snapshot（`meta.createdAt`、`meta.timing` 除外）；不可用時間、隨機值或環境影響核心結果。
  `S.VERSION` 與 `S.SCHEMA` 定義於 [src/core/ns.js](src/core/ns.js)。

## 修改守則（補充匯入的開發原則）

- **擴充點**：新廠牌 → `src/adapters/` 新檔＋`S.adapters.register()`，加入 `tools/core-files.js` 與 `index.html`；
  adapter 要用 `parse(block, emit, ignore)` 宣告依格式不產生事實的行，否則會成為 I03；
  新輸入格式 → `src/readers/` 並加入 `ORDER`；新檢查 → `src/check/catalog.js` 的 `CATALOG` 加一筆（含常見原因 `causes` 1–4 條與處理方式 `action`），
  在 `src/check/checks.js` 實作，並更新 [docs/基準檢查規則.md](docs/基準檢查規則.md)（有測試檢查標題、嚴重度、「常見原因」條數與「處理」段）。
- **生成檔的指令**：`samples/sample-bundle.txt`／`.js` 用 `npm run sample`（`tests/core/generated.js` 會檢查它與產生器輸出一致），`src/data/oui-data.js` 用 `npm run oui`。
  範例資料刻意含問題；新增檢查時要在產生器放對應問題並加測試。
- 解析器依 RouterOS 文件撰寫，測試資料為手寫／產生，尚未以真實設備驗證；欄位語意以官方手冊
  <https://manual.mikrotik.com/llms.txt> 為準。
- 大型冒煙測試：先 `npm run gen:large`，再 `SMOKE_INPUT=samples/large-1000.txt node tests/ui-smoke.js`，應全部通過。
  依範例資料才有的問題（例如 K01「LLDP 單向」）所寫的斷言，都依 Snapshot 是否有該 finding 判斷；範例資料必須含 K01。
- **架構決策**：影響整體的決策（唯讀、處理紀錄、findingKey、版本規則、分工方式等）記錄在 [docs/架構決策/](docs/架構決策/README.md)。
  修改相關設計前先讀對應的 ADR；決定改變時新增一份 ADR，並把舊的標為「已取代」，不改寫已接受的 ADR。

## Agent 分工（`.claude/agents/`）

大型任務可分給 subagent 平行處理。五個 agent 各自負責不重疊的檔案，所有權只定義在 [.claude/agents/ownership.json](.claude/agents/ownership.json)；`tests/docs.js` 會檢查每個檔案恰好屬於一個 agent。
核心依「單向依賴」的上下游分給 `data-model` 與 `workflow`（[ADR-013](docs/架構決策/013-新增workflow-agent依上下游分工.md)）。

| Agent | 負責 | 驗證 |
|---|---|---|
| `data-model` | 上游：解析、建模、推論、檢查、Snapshot、查詢介面、範例與 OUI 產生器 | `npm run test:core` |
| `workflow` | 下游：比對與預期資料（`compare/`）、修正 patch（`remediate/`）、處理紀錄（`ledger/`）、patch 黃金檔、之後的 CLI | `npm run test:core` |
| `frontend` | 畫面、樣式、theme、`index.html`、`vendor/` | `npm run test:ui` |
| `collector` | SSH 收集器 | `npm run test:collector` |
| `docs` | README、`docs/`、開發原則、skills、agent 定義 | `npm run test:docs` |

主對話（lead）的工作：
- 負責分派、跨領域修改（例如新增核心檔案要同時改 `tools/core-files.js` 與 `index.html`）、`package.json`、CI，以及提交與推送。
- 在 agent 之間轉交彼此報告中的「需要其他 agent 處理」與「文件影響」。

agent 之間的介面：
- **data-model ↔ frontend**：Snapshot 欄位（設計說明 §5.2）與 `SSOT.query()`。
- **data-model ↔ workflow**：同樣是 Snapshot 欄位與 `SSOT.query()`；`src/query/` 歸 data-model。workflow 需要新的查詢函式時寫進報告，由 data-model 加入。
- **workflow ↔ frontend**：`S.compare`、`S.remediate`、`S.ledger`。畫面的指令文字一律由 `S.remediate` 產生，處理紀錄只透過 `S.ledger` 存取。
- **data-model → docs**：`CATALOG`（`src/check/catalog.js`）與 `docs/基準檢查規則.md` 必須一致，包括 `causes`／`action`。
- **collector → data-model**：`bundle-v1` 格式與 `tools/collector-commands.sh` 的指令。

排程：
- 不改介面時，可以平行執行。
- 要改 Snapshot 或 query 時，依序執行：data-model → workflow（下游受影響時）→ frontend → docs。
- 只改 `S.compare`／`S.remediate`／`S.ledger` 的介面時，依序執行：workflow → frontend → docs。
- docs 最後執行，依各 agent 報告的「文件影響」更新。
- 提交前跑一次完整的 `npm test`。

## 專用流程（skills）

四個 skill 放在 `.claude/skills/`，Claude Code 會自動載入；`.github/skills/` 是同內容的 GitHub Copilot 版。
修改時兩邊一起改，`tests/docs.js` 會檢查兩者一致。
- `routeros-parser-fixtures`：改 adapter／解析、新收集指令（先寫失敗測試再修）
- `snapshot-contract-change`：改 Snapshot 欄位、finding id、query API 或版本（逐層走完 adapter→model→infer/check→pipeline→query→view→compare）
- `mikrotik-neighbor-topology`：改鄰居探索（LLDP／MNDP／CDP）與拓樸
- `routeros-acl-audit`：防火牆規則解析、WAN／LAN 分類、F01–F08 與比對（階段一已完成；資料來自既有的 `/export`）
