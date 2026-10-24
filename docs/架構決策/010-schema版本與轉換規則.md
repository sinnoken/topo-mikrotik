# ADR-010：schema 版本與轉換規則

- **狀態**：已接受
- **日期**：2026-10-24
- **決策者**：使用者

## 背景

工具讀寫的 JSON 格式都以 `schema` 欄位標示版本，但各格式遇到不同版本時的處理方式不一致，也沒有共同的規則。程式中目前的格式：

| 格式 | 產生者 | 讀取時的版本處理 | 可以從輸入重新產生 |
|---|---|---|---|
| `ssot-snapshot/2` | `S.build`（`src/pipeline.js`） | 畫面還原時 schema 或版本不同就用儲存的輸入重建（[ADR-005](005-版本升級規則.md)）；`S.compare.snapshots` 遇到不同 schema 不比對 | 是 |
| `ssot-ledger/1` | `S.ledger`（`src/ledger/ledger.js`） | `validate` 要求 schema 完全相同，否則報錯；不認得的欄位保留。新增過選用欄位 `iterations[].baseline.baselineKey`、`items[].devs`、`history[].fromKey`、`history[].superseded`，相容讀取，不升 schema | 否，是使用者的決定 |
| `ssot-patch/1` | `S.remediate.plan`（`src/remediate/patch.js`） | 輸出 `.rsc` 時要求 schema 完全相同 | 是 |
| `ssot-expected/1` | `S.compare.expectedFrom`，或使用者手寫 | `S.compare(Q, expected)` 要求 schema 完全相同 | 否，使用者會修改 |
| `ssot-snapdiff/1` | `S.compare.snapshots` | 只輸出，不讀入 | 是 |
| `ssot-diff/1` | `S.compare(Q, expected)`（預期資料與基準的比對結果） | 只輸出，不讀入 | 是 |
| `ssot-profile/1` | 使用者手寫的命名 profile | `S.profile.compile` 不檢查 `schema` 欄位 | 否 |
| `ssot-workpack/1` | `S.workpack.build`（`src/workpack/workpack.js`，2026-10-24 新增，[ADR-017](017-工作包ssot-workpack-1.md)） | `read` 拒絕比程式新的 major 與不認得的版本；不認得的欄位保留，不認得的角色列為警告、檔案保留。屬於使用者長期保存的格式 | 否，內含處理紀錄、命名規則與預期資料 |

另外，收集檔的 `bundle-v1`、`files-v1` 是輸入格式，由 `src/readers/` 依內容辨識，不在本 ADR 範圍。

## 決策

- **統一的版本規則**：
  - 名稱一律是 `ssot-<種類>/<整數>`。
  - 相容修改（新增選用欄位，並寫明沒有這個欄位時的意義）不改版本。讀取時保留不認得的欄位，不丟棄。
  - 破壞性修改（改名、刪除、改變欄位意義）才把整數加一。
  - 讀到比程式新的版本時，明確報錯並說明要用新版工具，不猜測。
- **使用者長期保存的格式一定要「讀舊版、寫新版」**：`ssot-ledger`、`ssot-expected`，以及命名 profile `ssot-profile`。
  - 每次升版附一個轉換函式（舊版 → 新版），讀入時自動轉換，寫出時一律是新版。
  - 每個舊版保留一份範例檔，測試它能轉換成新版且內容不遺失。
  - `S.profile.compile` 開始檢查 `schema` 欄位。
- **可以重新產生的格式不需要轉換**：`ssot-snapshot`、`ssot-patch`、`ssot-snapdiff`、`ssot-diff`。遇到舊版時明確告知，從原始輸入重新產生。

**相容修改的實例**：`ssot-ledger/1` 新增下列選用欄位，都**不升 schema**（見 [ADR-002](002-處理紀錄放在基準之外.md) 的「修訂」）：

- `iterations[].baseline.baselineKey`：沒有這個欄位的舊紀錄照常讀取，判斷時退回用 inputHash，不轉換、不改寫。
- `items[].devs`：沒有這個欄位的舊紀錄照常讀取，推不出設備的項目保守地列為 unobserved，不轉換、不改寫。
- `history[].fromKey`、`history[].superseded`：只有舊鍵轉換（`reason` 為 `facet-split`）的那一筆歷程才有；沒有這兩個欄位的歷程就不是轉換。舊紀錄不需要轉換格式。

另外，`S.ledger.advance` 的回傳值多了 `split`（這一輪由舊鍵轉換到新鍵的項目）。這是函式的回傳值，不是保存的格式；呼叫端不讀它時行為不變。

舊版程式讀到新紀錄時保留不認得的欄位。這符合上面「新增選用欄位，並寫明沒有這個欄位時的意義」的規則。

## 考慮過的選項

| 選項 | 優點 | 缺點 | 結論 |
|---|---|---|---|
| A. 維持現狀，各格式各自處理 | 不用改 | 規則不一致；長期保存的格式一升版，使用者的資料就讀不進來 | 不採用 |
| B. 所有格式都讀舊版、寫新版 | 一致 | 可重新產生的格式也要寫轉換函式，維護成本高，而且重建比轉換可靠 | 不採用 |
| C. 依「能不能重新產生」分兩類 | 只為使用者的資料寫轉換；重建的結果一定和目前程式一致 | 要清楚標示每種格式屬於哪一類 | **採用** |

## 後果

### 變容易的

- 使用者的處理紀錄、預期資料與命名 profile 在升版後仍能使用。
- 新增格式時有固定的規則可循。

### 變困難的

- 長期保存的格式每次破壞性修改，都要寫轉換函式與舊版範例測試。
- 使用者匯出的舊版基準 JSON 無法轉換，只能從原始輸入重建；沒有保留輸入的使用者，舊基準只能用同一版工具比對。

### 之後要回頭看的

- **以 JSDoc 加 `// @ts-check` 做型別檢查**：可以在編輯器與 CI 中檢查各格式與查詢介面的型別，減少欄位用錯。代價是要引入 TypeScript 編譯器當開發相依套件，打破目前零相依的原則（執行時仍然零相依）。等格式的轉換規則確定後，再評估是否值得。

## 待辦

- ~~使用者：決定是否採用。~~ **已完成**：2026-10-24 接受。接受前，`ssot-ledger/1` 已經照這份規則做過相容修改：新增 `baselineKey` 與 `devs`，以及 facet 的舊鍵轉換新增的歷程欄位，都沒有升 schema，見上方「相容修改的實例」。
- workflow 為 `ssot-ledger`、`ssot-expected` 補上版本檢查、轉換函式的架構與舊版範例測試（依 ADR-013 改由 workflow 負責）；data-model 為 `ssot-profile` 補上同樣的內容；docs 在設計說明列出每種格式屬於哪一類。
