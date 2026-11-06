# r17 D：命名規則的 name／label 衝突（data-model）

基準：92d43aa（git log -1 確認）。worktree：.claude/worktrees/agent-a93cb3cc632673095，分支 worktree-agent-a93cb3cc632673095，未 commit。

## 問題
floor-device-naming.json 同時有字串 label（規則名稱）與 label 規則；JSON.parse 只留後者，名稱遺失，設定清單顯示「—」。

## 決定
- 規則名稱用新欄位 `name`（字串，只用於顯示）。`description` 已是「一句說明」，不拿來當名稱。
- `label` 只用於顯示名稱規則 `{ match, value }`。字串的 `label` 保留為舊寫法的名稱（內建 site-naming.js 仍用，不改它）。
- 重複的鍵在 JSON.parse 之後無法偵測，所以新增 `S.profile.parse(text)`：JSON.parse 後掃描文字，找出同一物件內重複的鍵，有就丟 Error 列出路徑（例如 `label`、`classify[0].role`）。`compile(字串)` 也經 parse。
- compile 新增檢查：`name` 不是字串、`description` 不是字串、`label` 不是字串也不是物件（含陣列）、`name` 與字串 `label` 並存 → 錯誤。
- 順帶修正：以前字串 label 會被當成 match 為 undefined 的規則（每台設備 annotate 出 `label: ''`）；現在只有物件 label 會編譯成規則。infer.applyProfile 與 coverage 都忽略空字串，所以 Snapshot 不變（golden 無差異）。

## 新 API（相容新增）
- `S.profile.nameOf(json)` → name ‖ 字串 label ‖ null（trim）
- `S.profile.parse(text)` → json；重複鍵丟 Error，JSON 不合法丟 SyntaxError
- `compile(json).name`（= nameOf）；`compile(text)` 接受文字
- describe 不變。

## 範本
floor-device-naming.json：`label`（字串）→ `name`，version 2 → 3。

## 畫面需要改（frontend）
1. src/view/panels/settings-profiles.js:47 `nameOf` 讀 `p.label` → 改 `S.profile.compile(p).name`（或 nameOf；但 ui-smoke 邊界只允許 S.profile.compile）。
2. src/view/panels/settings-profiles.js:96 載入檔案用 `JSON.parse` → 改用會擋下重複鍵的解析：`S.profile.compile(text)` 之後取 `.source`，或把 `S.profile.parse` 加入 ui-smoke.js 的允許清單。否則文件寫的「重複的鍵會報錯」在畫面上不成立。
3. src/view/app-input.js:143 建立基準選單讀 `p.label` → 改用名稱函式。
4. src/view/panels/hub.js:70 `p.label ? '：' + p.label` → label 是物件時會顯示 `[object Object]`（既有 bug）；改用名稱函式。
5. tests/ui-smoke.js:5818 斷言 `p.label`（內建 site-naming，仍成立）；可改為名稱函式。

## 文件影響（docs）
- docs/設計說明.md §6：compile 回傳加 `name`、可接受文字；新增 `parse(text)`、`nameOf(json)` 兩項；describe 段「字串的 label 是名稱」補「新寫法是 name」。
- docs/版本紀錄.md：不升版（解析結果不變；只有新增 API 與範本）。可在下一筆記「命名規則新增 name 欄位、重複鍵報錯、範本改用 name（v3）」。
- docs/命名規則.md 已改（本任務範圍）。

## 驗證
- npm run test:core：328 通過、1 失敗（收集器端到端，預期；macOS 沒有 GNU timeout）
- npm run test:docs：6 通過
- npm run test:ui（參考）：全部通過
- npm run golden:update：黃金基準沒有變化
- git diff --check：無輸出
