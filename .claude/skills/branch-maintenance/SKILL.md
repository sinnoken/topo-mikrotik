---
name: branch-maintenance
description: "Use when starting a round of work, creating a branch, dispatching parallel agents in worktrees, merging their results, opening or merging a PR, or cleaning up branches. The lead keeps every branch based on the latest main so parallel work never diverges silently."
argument-hint: "Describe the work about to start or the branch to merge"
user-invocable: true
---

> Claude Code 版。內容與 `.github/skills/branch-maintenance/SKILL.md`（GitHub Copilot 版）相同，修改時兩邊一起改；`tests/docs.js` 會檢查兩者一致。

# Branch Maintenance

## Purpose

主對話（lead）負責維護分支：工作不建立在過期的基準上，平行工作不互相分岔。

## 每輪開工前

1. `git fetch --prune`，`git log --oneline HEAD..origin/main` 有 commit 時先告訴使用者，再決定 rebase 或先整合；main 已前進時不繼續疊新功能。
2. 新分支從最新的 `origin/main` 開：`git switch -c <type>/<name> origin/main`，再 `git branch --unset-upstream`。
3. 開分支前用 `git ls-remote --heads origin <name>` 查遠端同名分支；有就換名字。
4. 同一個區域（例如畫面的資訊架構）同時只讓一條線改。

## 提案原則

- 先給最小可行版本，使用者確認方向後再擴充。
- 文件與畫面上呈現的事實、數字、條件清單與前提，由程式常數或同一個查詢產生，不另寫一份。

## 平行 agent 與 worktree

- 順序：開分支 → `git push origin <branch>` → 才派工。worktree 預設從 `origin/main` 開出，所以任務說明寫明「worktree 建好後 `git fetch origin && git reset --hard origin/<branch>`，確認 HEAD 是 <sha>」，不符就在改檔前停下回報。
- agent 回報的基準與預期不符時，追查來源（是不是 main 前進了），不要只叫它 reset。
- 每合併一次 main，進行中的分支都 `git merge origin/main` 並 push；分支前進時通知進行中的 agent「origin/<branch> 已前進到 <sha>，合併前 rebase」，它會自己 rebase。
- 同時跑的重型 agent（跑 `test:large`、大型冒煙或改大檔）最多 3 個。
- 大重構前先派一個唯讀的技術債盤點，列出必須先還的項目。
- 審查問題優先用 SendMessage 交回原切片 agent。session 中斷時先查各 worktree 的 commit（`git -C <worktree> log --oneline <基準>..`）與未提交修改（`git -C <worktree> status --short`），再用 SendMessage 續行。
- 收到回報後確認追加項有沒有做（`git -C <worktree> show --stat`、grep commit 的內容）；訊息在 agent 回報前才送達時可能被略過，沒做就再送一次。
- 進行中的細節（切片範圍、交接、待辦）只寫在 scratchpad 的交接檔，不進 git。

## 派工模板

每份任務說明都包含：

1. 基準：分支與「確認 HEAD 是 <sha>」；合併前 rebase 到最新的分支。
2. 範圍：可改的檔案、凍結的名稱與簽章（見「切片範圍實測」）；超出範圍的改動另列在回報。
3. 自我檢查清單（挑適用的）：
   - 換基準、離開畫面時，進行中的計算會停。
   - Promise 一定結束（成功、失敗、取消都有出口）。
   - 焦點與 aria：操作後焦點有去處，狀態有 aria 標示。
   - 排序與收合不會把重要項目藏起來。
   - view 只透過 Q／`S.query` 讀資料。
   - 和相鄰區塊用同一種模式（詳情區塊一律用 `src/view/dom.js` 的 `V.section`）。
   - 同一個數字在畫面各處來自同一個查詢。
   - 測試找不到元素就失敗，不用 `if` 略過。

測試範圍與回報格式已寫在各 agent 定義（「驗證」「最後報告格式」），任務說明只寫本輪不同的地方。

## 切片範圍實測

- 派工前：把各切片預計改的檔案寫成 slices.json（格式見 `.claude/scripts/slice-xref.js` 檔頭），執行 `node .claude/scripts/slice-xref.js . <slices.json>`。程式檔有交集時結束碼 1，先重新切分；「A 用到 B 的定義」列出的成員，在任務說明裡寫明不可改名或改介面，或讓兩個切片依序執行。
- 合併前：`git -C <worktree> add -A` 後以 `git -C <worktree> diff --cached --name-only <基準>` 列出實際改動的檔案，與派工時的範圍比對；超出範圍的檔案先問清楚再合併。

## 合併切片

- `.claude/scripts/merge-slice.sh <worktree> <基準>`（在主工作目錄執行）以 `git apply --3way` 套用切片相對基準的改動，輸出兩邊都改過的檔案、衝突檔案與結果；不 commit、不刪 worktree。用法與結束碼見腳本檔頭。
- 衝突時兩邊都要的就合併，重複實作只留一份；解完再跑一次測試。
- `.gitattributes` 標 `-text` 的檔案由腳本直接複製以保留 CRLF。新增 CRLF fixture 時，同一個切片要在 `.gitattributes` 加 `-text`（必要時加 `-whitespace`）。
- 每輪合併前做一次 code review（`engineering:code-review`，對象是本輪合併後、commit 前的 diff）；高嚴重度的問題當輪修完再 commit，其餘記到交接檔。
- 每合併一個切片：跑測試 → commit → push。之後 `.claude/scripts/merge-slice.sh --cleanup <worktree>`（或 `--cleanup-all`）刪掉已合併的 worktree 與 `worktree-agent-*` 分支：切片內容在目前工作目錄或基準之後的任一個 commit 就算已合併，之後主分支再改過也一樣；被鎖住的（agent 執行中）略過並印出原因。
- `git worktree list` 最後應只剩主工作目錄。

## 測試與 commit

- 各 suite 的分工與 `test:large`、大型冒煙的時機見[開發指南 §3](../../../docs/開發指南.md#3-測試)。合併後 lead 跑 `test:core`、`test:ui`、`test:docs` 與 `git diff --check`。
- 先看測試結果，確認沒有失敗再 commit；不要用 `&&` 把測試和 commit 串成一行。
- 改檔只用編輯工具（`.claude/hooks/check-shell.js` 會擋 heredoc 寫檔、`node -e` 與 python 的 heredoc／`-c`），lead 也一樣；PR 說明先寫到暫存檔，再 `gh pr create --body-file`。

## PR 與合併

- 一律經 PR 合併到 main：`gh pr create --base main --head <branch> --body-file <file>`。
- 每輪合併時更新 `docs/路線圖.md` 的狀態與預排，和本輪的改動放在同一個 PR。
- `gh pr checks <n> --watch` 等 CI 全部通過。使用者授權「沒有問題就合併」時才 `gh pr merge <n> --merge --delete-branch`；沒有授權就停下來回報。
- `gh pr merge` 遇到 GitHub 的暫時性錯誤（`Something went wrong`、502、timeout）時，間隔 15 秒重試，最多 4 次；每次重試前用 `gh pr view <n> --json state` 確認還沒合併，確認前不刪本機分支。
- 合併後：`git switch main && git pull --ff-only && git fetch --prune`，刪掉本機已合併的分支。

## 收尾檢查

- `git branch -a` 只剩 main 與進行中的分支；已移植或已合併的舊分支，經使用者同意後刪除（本機 `git branch -D`、遠端 `git push origin --delete`）。
- 回報：目前分支、與 main 的距離、未合併的 PR、還留著的分支與原因。
