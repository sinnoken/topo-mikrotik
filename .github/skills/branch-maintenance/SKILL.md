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

- worktree 預設從 `origin/main` 開出，不一定是目前分支。派工時在任務說明寫明基準 commit，要求 agent 第一步 `git log --oneline -1` 確認，不符就在改檔前 `git reset --hard <基準>`。
- agent 回報的基準與預期不符時，追查來源（是不是 main 前進了），不要只叫它 reset。
- 後合併的切片若改到先合併切片的區域，先把新基準 commit 告訴還在跑的 agent，請它重新疊上（WIP commit → reset → cherry-pick -n，或 stash）。
- 合併方式：`git -C <worktree> add -N .`，`git -C <worktree> diff <基準> -- . ':!samples/large-1000.txt' > patch`，在主工作目錄 `git apply --3way patch`。衝突兩邊都要的就合併，重複實作只留一份。
- 每合併一個切片：跑測試 → commit → push → `git worktree remove --force <path>` 與 `git branch -D worktree-agent-*`。
- `.claude/worktrees/` 已在 `.gitignore`；`git worktree list` 應只剩主工作目錄。

## 測試與 commit

- 合併後跑 `npm run test:core`、`npm run test:ui`、`npm run test:docs`、`git diff --check`；改到範例、效能或版面時加 `npm run test:large` 與 `SMOKE_INPUT=samples/large-1000.txt node tests/ui-smoke.js`。
- 測試與 commit 不要用 `&&` 串成一行就送出：先看測試結果，確認沒有失敗再 commit。
- 本機缺 GNU `timeout` 時收集器端到端測試會失敗，屬環境問題；以 CI 結果為準，回報時寫明。
- 不要用 heredoc 加 `cat >`／`tee` 寫檔（`.claude/hooks/check-shell.js` 會擋）；PR 說明先用編輯工具寫到暫存檔，再 `gh pr create --body-file`。

## PR 與合併

- 一律經 PR 合併到 main，不直接推 main。`gh pr create --base main --head <branch> --body-file <file>`。
- `gh pr checks <n> --watch` 等 CI 全部通過。使用者授權「沒有問題就合併」時，CI 全過才 `gh pr merge <n> --merge --delete-branch`；沒有授權就停下來回報。
- 合併後：`git switch main && git pull --ff-only && git fetch --prune`，刪掉本機已合併的分支。

## 收尾檢查

- `git branch -a` 只剩 main 與正在進行的分支；已移植或已合併的舊分支，經使用者同意後刪除（本機 `git branch -D`、遠端 `git push origin --delete`）。
- 回報時列出：目前分支、與 main 的距離、未合併的 PR、還留著的分支與原因。
