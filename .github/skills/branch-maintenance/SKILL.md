---
name: branch-maintenance
description: "Use when starting a round of work, creating a branch, dispatching parallel agents in worktrees, merging their results, opening or merging a PR, or cleaning up branches. The lead keeps every branch based on the latest main so parallel work never diverges silently."
argument-hint: "Describe the work about to start or the branch to merge"
user-invocable: true
---

# Branch Maintenance

## Purpose

主對話（lead）負責維護分支。目標是不讓工作建立在過期的基準上，也不讓平行工作互相分岔。
曾經發生過的事：一條分支在過期十天的基準上做了 18 個 commit，同時 main 已有 124 個 commit
與另一版 UI 改版；兩套設計互斥，只能放棄合併、改以移植重做。以下步驟就是為了避免這件事。

## 每輪開工前

1. `git fetch --prune`，比對 `origin/main` 與目前分支：
   - `git log --oneline HEAD..origin/main` 有 commit 時，先告訴使用者，再決定 rebase 到最新 main 或先整合。
   - 不要在 main 已前進的情況下繼續疊新功能。
2. 新分支一律從最新的 `origin/main` 開：`git switch -c <type>/<name> origin/main`，之後 `git branch --unset-upstream`（不要追蹤 main）。
3. 開分支前查遠端有沒有同名分支：`git ls-remote --heads origin <name>`；有就換名字。同名會讓兩條線看起來像同一條。
4. 同一個區域（例如畫面的資訊架構）同時只讓一條線改；兩邊都想改時先決定由誰負責。

## 平行 agent 與 worktree

- 順序：開分支 → `git push origin <branch>` → 才派工。worktree 預設從 `origin/main` 開出，不一定是目前分支；任務說明寫明「worktree 建好後 `git fetch origin && git reset --hard origin/<branch>`，確認 HEAD 是 <sha>」，不符就在改檔前停下回報。
- agent 回報的基準與預期不符時，追查來源（是不是 main 前進了），不要只叫它 reset。
- 每合併一次 main：進行中的分支都 `git merge origin/main` 並 push，再通知進行中的 agent「origin/<branch> 已前進到 <sha>」，請它重新疊上（WIP commit → reset → cherry-pick -n）。後合併的切片改到先合併切片的區域時也一樣。
- 同時跑的重型 agent（會跑 `test:large` 或大型冒煙、或改大檔）最多 3 個。
- 大重構前先派一個唯讀的技術債盤點，列出必須先還的項目，排在重構之前。
- 審查問題優先用 SendMessage 交回原切片 agent，不另派新的。session 中斷時先查各 worktree 的 commit（`git -C <worktree> log --oneline <基準>..`）與未提交修改（`git -C <worktree> status --short`），再用 SendMessage 續行。
- 收到回報後確認追加項有沒有做（例如 `git -C <worktree> show --stat`、grep commit 的內容）；訊息在 agent 回報前才送達時可能被略過，沒做就再送一次。
- 進行中的細節（切片範圍、交接、待辦）只寫在 scratchpad 的交接檔，不進 git。

## 派工模板

每份任務說明都包含：

1. 基準：分支與「確認 HEAD 是 <sha>」。
2. 範圍：可改的檔案、凍結的名稱與簽章（見「切片範圍實測」）；超出範圍的改動另列在回報。
3. 測試：只跑自己的 suite（見「測試與 commit」）。
4. 自我檢查清單（挑適用的）：
   - 換基準、離開畫面時，進行中的計算會停。
   - Promise 一定結束（成功、失敗、取消都有出口）。
   - 焦點與 aria：操作後焦點有去處，狀態有 aria 標示。
   - 排序與收合不會把重要項目藏起來。
   - view 只透過 Q／`S.query` 讀資料。
   - 測試找不到元素就失敗，不用 `if` 略過。
5. 回報硬性 ≤15 行：commit、改動檔、測試、需要 lead 處理、文件影響；細節寫到 scratchpad 的檔案。

## 切片範圍實測

- 派工前：把各切片預計改的檔案寫成 slices.json（格式見 `.claude/scripts/slice-xref.js` 檔頭），執行 `node .claude/scripts/slice-xref.js . <slices.json>`。程式檔有交集時結束碼 1，先重新切分；「A 用到 B 的定義」列出的成員，在任務說明裡寫明不可改名或改介面，或讓兩個切片依序執行。
- 合併前：`git -C <worktree> add -A` 後以 `git -C <worktree> diff --cached --name-only <基準>` 列出實際改動的檔案，與派工時的範圍比對；超出範圍的檔案先問清楚再合併。

## 合併切片

- 用 `.claude/scripts/merge-slice.sh <worktree> <基準>`（在主工作目錄執行）。它把切片相對基準的改動（含新檔、二進位檔，排除 `samples/large-1000.txt`）以 `git apply --3way` 套用，只輸出：與目前分支都改過的檔案、衝突檔案、成功或失敗。不 commit、不刪 worktree。
- 衝突時兩邊都要的就合併，重複實作只留一份；解完再跑一次測試。
- `.gitattributes` 標 `-text` 的檔案（CRLF 的報表 fixture 等）不經 patch，由腳本直接複製，保留 CRLF。新增 CRLF fixture 時，要在同一個切片的 `.gitattributes` 加上 `-text`（必要時加 `-whitespace`），否則 `* text=auto eol=lf` 會把它轉成 LF。
- 每輪合併前做一次 code review（`engineering:code-review`，對象是本輪合併後、commit 前的 diff）；高嚴重度的問題當輪修完再 commit，其餘記到交接檔。
- 每合併一個切片：跑測試 → commit → push → `.claude/scripts/merge-slice.sh --cleanup <worktree> <基準>`。它只在切片的改動都已套用（或沒有改動）時才刪 worktree 與 `worktree-agent-*` 分支。
- `.claude/worktrees/` 已在 `.gitignore`；`git worktree list` 應只剩主工作目錄。

## 測試與 commit

- 切片只跑自己的 suite：data-model 與 workflow 跑 `test:core`，frontend 跑 `test:ui`，docs 跑 `test:docs`，collector 跑 `test:collector`。
- 合併後 lead 跑 `npm run test:core`、`npm run test:ui`、`npm run test:docs`、`git diff --check`。`test:large` 與大型冒煙只在合併前由 lead 跑一次，或交給 CI；兩者結果不同時以 CI 為準（指令與 heap 見[開發指南 §2](../../../docs/開發指南.md#2-指令)）。
- 測試與 commit 不要用 `&&` 串成一行就送出：先看測試結果，確認沒有失敗再 commit。
- 本機缺 `timeout`／`gtimeout` 時收集器端到端測試會失敗，屬環境問題；以 CI 結果為準，回報時寫明。
- 改檔只用編輯工具（`.claude/hooks/check-shell.js` 會擋 heredoc 加 `cat >`／`tee`、`node -e` 與 python 的 heredoc／`-c` 寫檔）；lead 也一樣。PR 說明先用編輯工具寫到暫存檔，再 `gh pr create --body-file`。

## PR 與合併

- 一律經 PR 合併到 main，不直接推 main。`gh pr create --base main --head <branch> --body-file <file>`。
- 每輪合併時更新 `docs/路線圖.md` 的狀態（本輪完成的項目）與預排（下一輪要做的），和本輪的改動放在同一個 PR。
- `gh pr checks <n> --watch` 等 CI 全部通過。使用者授權「沒有問題就合併」時，CI 全過才 `gh pr merge <n> --merge --delete-branch`；沒有授權就停下來回報。
- `gh pr merge` 遇到 GitHub GraphQL 的暫時性錯誤（例如 `Something went wrong`、502、timeout）時，間隔 15 秒重試，最多 4 次；每次重試前用 `gh pr view <n> --json state` 確認還沒合併。重試期間不要先刪本機分支，`--delete-branch` 失敗時合併可能已完成，確認後再手動刪。
- 合併後：`git switch main && git pull --ff-only && git fetch --prune`，刪掉本機已合併的分支。

## 收尾檢查

- `git branch -a` 只剩 main 與正在進行的分支；已移植或已合併的舊分支，經使用者同意後刪除（本機 `git branch -D`、遠端 `git push origin --delete`）。
- 回報時列出：目前分支、與 main 的距離、未合併的 PR、還留著的分支與原因。
