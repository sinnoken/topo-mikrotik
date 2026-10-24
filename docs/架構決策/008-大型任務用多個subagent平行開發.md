# ADR-008：大型任務用多個 subagent，各自在 worktree 平行開發

- **狀態**：已接受
- **日期**：2026-10-24
- **決策者**：使用者

## 背景

一個功能常常要同時改核心、畫面與文件（例如修正 patch：核心計畫、修正計畫畫面、設計說明）。在同一個對話中循序完成很慢；多個 agent 在同一個工作目錄同時修改，又會互相覆蓋檔案。

## 決策

- 分成四個 agent（data-model、frontend、collector、docs）與主對話（lead），定義在 `.claude/agents/`。**檔案的所有權只定義在 [.claude/agents/ownership.json](../../.claude/agents/ownership.json)**，`tests/docs.js` 檢查 repo 中每個檔案恰好屬於一個負責者，agent 定義檔與所有權表一一對應。
- 每個 agent 只改自己的檔案。需要別人配合時寫進報告的「需要其他 agent 處理」，需要改文件時寫「文件影響」，由 lead 轉交。
- **順序**：不改介面時可以平行；要改 Snapshot 或查詢介面時，依 data-model → frontend → docs 依序執行。docs 最後執行，依各 agent 報告更新文件。
- **以 worktree 隔離**：平行的 agent 各自在自己的 git worktree 與分支開發（`.claude/worktrees/`，已列入 `.gitignore`），由 lead 合併。
- lead 負責分派、跨領域修改（例如新增核心檔案時同時改 `tools/core-files.js` 與 `index.html`）、`package.json`、CI，以及提交與推送。提交前跑一次完整的 `npm test`。
- 分工細節見 [CLAUDE.md](../../CLAUDE.md) 的「Agent 分工」一節。

## 考慮過的選項

| 選項 | 優點 | 缺點 | 結論 |
|---|---|---|---|
| A. 單一對話循序完成 | 沒有合併衝突 | 慢；一個對話要記住所有領域的細節 | 不採用（小任務仍用這種方式） |
| B. 多個 agent 共用同一個工作目錄 | 不需要合併 | 同時修改會互相覆蓋；一方的測試失敗會擋住另一方 | 不採用 |
| C. 依檔案分工，各自在 worktree 開發，由 lead 合併 | 可以平行；所有權有測試把關；每個分支可以單獨驗證 | 要合併；跨領域的檔案需要 lead 處理 | **採用** |
| D. 依功能分工（每個 agent 負責一個功能的全部層） | 一個功能由一個 agent 完成 | 多個 agent 會改到同一批檔案，衝突更多 | 不採用 |

## 後果

### 變容易的

- 核心、畫面、文件可以同時進行，例如修正 patch 核心與處理紀錄核心、I03 平行開發後依序合併。
- 每個 agent 的驗證範圍明確（`test:core`、`test:ui`、`test:collector`、`test:docs`）。

### 變困難的

- 實務上的衝突點：
  - `tests/run.js`：核心測試只有一個檔案，平行的 data-model 分支都會在這裡加測試，合併時常常衝突。
  - `tools/core-files.js` 與 `index.html`：新增核心檔案要兩邊同步，兩者分屬 data-model 與 frontend，由 lead 補上另一邊（例如 `src/remediate/patch.js`）。
- **plan mode 會讓 agent 無法寫檔**：派工時不要在 plan mode 下啟動 agent，否則 agent 只能讀不能改。
- 平行的分支之間看不到彼此的修改；介面改變必須照順序，不能平行。

### 之後要回頭看的

- **`tests/run.js` 依模組拆檔**（例如解析、建模、檢查、比對、patch、處理紀錄各一個檔案），減少合併衝突。要同時調整 `npm run test:core` 與 `tests/load.js` 的用法，由 data-model 與 lead（`package.json`）一起處理。**已處理**：依 [ADR-013](013-新增workflow-agent依上下游分工.md) 拆檔（2d87fab），`tests/run.js` 只留執行器，測試在 `tests/core/` 與 `tests/workflow/`，共用 helper 在 `tests/lib.js`；`npm run test:core` 的用法不變。

## 修訂

### 2026-10-24：新增 workflow agent，依上下游分工

- **原因**：data-model 負責的範圍太大；同時開了 3 個 data-model（I03、修正 patch、處理紀錄），合併時在 `tests/run.js` 與 `tools/core-files.js` 互相衝突。
- **修改**：見 [ADR-013](013-新增workflow-agent依上下游分工.md)。
  - 新增第五個 agent `workflow`，負責下游模組（`src/compare/`、`src/remediate/`、`src/ledger/`）、patch 黃金檔、`tests/workflow/` 與之後的 CLI。
  - data-model 只負責上游；`src/query/` 仍歸 data-model，是上下游之間的介面。
  - 上面「之後要回頭看的」`tests/run.js` 拆檔改由 data-model 與 workflow 各自搬移測試（`tests/core/`、`tests/workflow/`），lead 調整執行器與 `package.json`。
- **不變的部分**：依檔案分工、所有權只定義在 `ownership.json`、以 worktree 隔離、由 lead 合併，以及「改介面時依序執行、docs 最後執行」的原則都不變。順序中的「data-model → frontend → docs」，改下游介面時加入 workflow（data-model → workflow → frontend → docs）。

## 待辦

- ~~data-model＋lead：評估 `tests/run.js` 拆檔。~~ **已完成**：見上方「之後要回頭看的」。
