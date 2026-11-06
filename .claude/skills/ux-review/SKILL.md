---
name: ux-review
description: "Use when reviewing the UI/UX of the offline viewer: a UX or copy review, before/after screenshot comparison of a UI change, checking light/dark themes and narrow screens, or auditing CJK typography, wording consistency, inference labels and leaked internal codes. Produces a screenshot matrix and a severity-ranked report."
argument-hint: "Describe the screens or the change to review, and the commit(s) to compare"
user-invocable: true
---

> Claude Code 版。內容與 `.github/skills/ux-review/SKILL.md`（GitHub Copilot 版）相同，修改時兩邊一起改；`tests/docs.js` 會檢查兩者一致。

# UX 評審

## 何時用

- 畫面改版或切片合併前後的 UX 評審、用字審查。
- 要對照兩個版本的截圖（改版前後、main 與分支）。
- 檢查亮／暗主題、窄螢幕（手機寬度）與繁中排版。

只看程式行為對不對時用 `npm run test:ui`（模擬 DOM）；這個 skill 處理模擬 DOM 測不到的視覺與用字。

## 截圖矩陣

- 組合：亮／暗 × 1440／390（高度 900／844），共四組；每組截同一份狀態清單。
- 狀態清單（`.claude/scripts/shot.js` 依序截，檔名 `<狀態>-<主題>-<寬度>.png`）：
  - `00-welcome` 歡迎畫面
  - `01-build-dialog` 輸入對話框（已載入範例）
  - `02-graph` 研判的拓樸圖
  - `06-core-router` 選取核心路由器（詳細資料）
  - `08-l2`、`08-l3` L2 埠圖、L3 網段圖
  - `13-legend` 圖例展開
  - `14-l2-view-menu` 「顯示」選單
  - `12b-hub-outputs` 資料中心的輸出
- 評審的對象不在清單上時（新的對話框、分頁），先在 `shot.js` 加狀態再截，不要只截一張手動畫面。

## 截圖工具

- `.claude/scripts/shot.js` 是本機選用工具：不進 CI，repo 不相依 puppeteer。自行在 scratchpad 安裝 `puppeteer-core`（或 `puppeteer`），以 `PUPPETEER_DIR`、`CHROME_PATH` 指定位置。
- 用法：`node .claude/scripts/shot.js <commit> <輸出目錄>`。它以 `git archive` 解出指定 commit 再截，不受工作樹未 commit 的改動影響；要截未 commit 的改動時先做 WIP commit。
- 前後對照：同一組參數分別截兩個 commit，輸出到兩個目錄，逐張比較。
- `rects.json` 記錄浮動元件（圖層說明、圖例、提示、工具列）的位置，用來找窄螢幕重疊；`errors.json` 是頁面錯誤，有錯先回報。
- 截圖與報告放 scratchpad，不進 git。

## 評審準則

1. **繁中 CJK 排版**：全形標點（，。：「」（）），中英數之間不硬加空白、不混用半形括號；內文 15px，最小 13px，不用更小的字；字型堆疊只在一個地方定義。
2. **用字一致與舊詞**：同一個概念全畫面同一個詞，與 `docs/使用說明.md`、`docs/基準檢查.md` 一致；改名後找殘留的舊詞（按鈕、提示、空狀態、匯出檔）。
3. **推論標示**：推論（設備類型、推論鏈路、漂移、終端埠、WAN／LAN 等）要看得出是推論，不能和收集到的事實同一種呈現。
4. **內部代碼外露**：畫面不顯示內部鍵、欄位名、列舉原值、JS 錯誤字串；檢查代碼（K01、A02…）只在搭配標題時出現。
5. **窄螢幕重疊**：390 寬時浮動元件互不遮蓋、不出現水平捲動、按鈕可點；用 `rects.json` 確認，不只看圖。
6. 亮／暗主題都可讀（對比、線條、選取狀態）；顏色只來自 `src/view/theme.js` 與 CSS 變數。

## 報告格式

完整報告寫成 scratchpad 的檔案，每一項：

| 欄位 | 內容 |
|---|---|
| 嚴重度 | 高（看錯資料、無法操作、誤導事實與推論）／中（不一致、難讀）／低（細節） |
| 畫面／寬度 | 狀態名稱與組合，例如 `08-l3`，暗、390 |
| 截圖 | 檔名（前後對照時兩張都列） |
| 問題與建議 | 看到什麼、應該怎樣 |
| 建議檔案 | 要改的檔案，例如 `src/view/panels/details.js`、`assets/app.css` |

回報給 lead 限 25 行：高嚴重度逐項列出，其餘只寫數量與報告檔案路徑。
