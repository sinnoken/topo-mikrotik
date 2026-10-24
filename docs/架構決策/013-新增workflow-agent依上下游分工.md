# ADR-013：新增 workflow agent，依上下游分工

- **狀態**：已接受
- **日期**：2026-10-24
- **決策者**：使用者

## 背景

[ADR-008](008-大型任務用多個subagent平行開發.md) 把工作分給四個 agent 與主對話（lead），檔案的所有權定義在 [.claude/agents/ownership.json](../../.claude/agents/ownership.json)。實際使用後發現 data-model 的範圍太大：

- data-model 原本負責 25 項（目錄或檔案），從解析、建模、推論、檢查、查詢介面，到比對、修正 patch、處理紀錄、範例與黃金檔都在裡面。
- 這一輪同時開了 3 個 data-model（I03、修正 patch、處理紀錄），各自在 worktree 開發。合併時三個分支都改到 `tests/run.js` 與 `tools/core-files.js`，互相衝突。
- `tests/run.js` 只有一個檔案，所有核心測試都在裡面；合併後（ebbce7d）已有 2753 行。

比對（`src/compare/`）、修正 patch（`src/remediate/`）、處理紀錄（`src/ledger/`）有共同的性質：它們是核心檔案，但只透過 `SSOT.query(snapshot)` 讀基準、不修改基準，上游也不呼叫它們（見 [CLAUDE.md](../../CLAUDE.md) 的「單向依賴」）。這條邊界已經存在，可以直接拿來分工。

## 決策

- **新增 `workflow` agent**（[.claude/agents/workflow.md](../../.claude/agents/workflow.md)），負責下游模組：
  - `src/compare/`（新舊比對、預期資料）、`src/remediate/`（修正 patch）、`src/ledger/`（處理紀錄）。
  - patch 黃金檔（`tests/golden/sample-patch*`）與 `tests/workflow/` 的測試。
  - 之後的 CLI（`tools/baseline.js`、`tools/patch.js`）。
- **data-model 只負責上游**：解析、建模、推論、檢查、查詢介面、Snapshot 序列化、範例與 OUI 產生器，以及 `tests/core/` 的測試。
- **`src/query/` 仍歸 data-model**：它是上下游之間的介面。workflow 需要新的查詢函式時寫進報告，由 lead 分派給 data-model 加入。
- **`tests/run.js` 拆檔**：`tests/run.js` 只留執行器，測試搬到 `tests/core/`（data-model）與 `tests/workflow/`（workflow）；搬移前後的測試數必須相同。
- frontend 不拆，collector、docs 維持原樣。
- 實際的檔案清單以 [ownership.json](../../.claude/agents/ownership.json) 為準，`tests/docs.js` 檢查每個檔案恰好屬於一個負責者、agent 定義檔與所有權表一一對應。分工與排程見 [CLAUDE.md](../../CLAUDE.md) 的「Agent 分工」。

## 考慮過的選項

| 選項 | 優點 | 缺點 | 結論 |
|---|---|---|---|
| A. 維持現狀 | 不用改分工與定義檔 | data-model 範圍太大；平行的 data-model 分支持續在同一批檔案衝突 | 不採用 |
| B. 依上下游拆分：上游歸 data-model，下游歸新的 workflow | 沿用已有的單向依賴邊界，介面就是 `SSOT.query`；下游三個模組可以和上游平行開發 | query 的變更多一道協調；下游之間仍在同一個 agent | **採用** |
| C. 依功能拆成更多 agent（例如解析、檢查、比對、patch、處理紀錄各一個） | 每個 agent 範圍最小 | agent 之間的介面變多，很多修改要跨好幾個 agent；`CATALOG`、query 這類共用檔案仍會衝突 | 不採用 |
| D. 拆 frontend（例如拓樸圖與面板分開） | 畫面也可以平行 | 兩邊共用 `src/view/theme.js` 與 `assets/app.css`，拆開後仍會改到同一組檔案 | 不採用 |

## 後果

### 變容易的

- 上游（解析、檢查）與下游（比對、patch、處理紀錄）可以由不同 agent 平行開發，各自的測試檔分開，合併衝突變少。
- 每個 agent 的範圍與規則更明確：workflow 的定義檔集中寫出唯讀（[ADR-001](001-工具維持唯讀.md)）、處理紀錄不進 Snapshot（[ADR-002](002-處理紀錄放在基準之外.md)）、格式相容（[ADR-010](010-schema版本與轉換規則.md)）這些下游才有的規則。

### 變困難的

- query 的變更多一道協調：workflow 需要新的查詢函式時，要先由 data-model 加入，才能在下游使用。
- 新增下游的核心檔案時，`tools/core-files.js`（data-model）與 `index.html`（frontend）仍要由 lead 同步。

### 之後要回頭看的

- **`tests/ui-smoke.js` 也很大**：合併後（ebbce7d）有 1928 行。frontend 不拆，但平行的 frontend 分支仍會在這裡衝突；是否依畫面拆檔，之後再評估。

## 待辦

- ~~lead：依拆檔後的實際檔案清單更新 `ownership.json`、`package.json` 與 `tests/run.js` 的執行器。~~ **已完成**（2d87fab）：`tests/run.js` 依檔名載入 `tests/core/*.js` 再載入 `tests/workflow/*.js`；`ownership.json` 已列入兩個目錄與 `tests/lib.js`；`package.json` 的指令不需要改。
- ~~data-model 與 workflow：各自把測試搬到 `tests/core/`、`tests/workflow/`，搬移前後測試數相同。~~ **已完成**（2d87fab）：`tests/core/` 135 項、`tests/workflow/` 24 項，搬移前後的測試名稱清單相同。
- ~~docs：新增 `.claude/agents/workflow.md`，更新另外四個 agent 定義與 CLAUDE.md 的「Agent 分工」。~~ **已完成**。
