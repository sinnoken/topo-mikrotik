# 命名規則（profile）

命名規則是**獨立、可跳過**的 JSON 檔。不套用時系統完整可用：設備類型依廠牌與收集到的資料判斷，分群依連線關係。

命名規則只能做兩件事：

1. **建模前**把名稱對應到正式名稱：`alias`（別名）、`stripDomain`（去掉網域）
2. **建模後**加註解：`classify`（類型、角色、站點）、`group`（分群）、`label`（顯示名稱）

它**不能**新增、刪除或改變任何事實（介面、鏈路、VLAN、位址）。基準的 `meta.profile` 會記錄使用了哪一份規則與版本。

## 格式

命名規則是 `schema` 為 `ssot-profile/1` 的 JSON。完整範例直接看專案附帶的檔案，不在這裡另寫一份，以免和實際檔案走樣：

- [`profiles/floor-device-naming.json`](../profiles/floor-device-naming.json)：JSON 範例，格式即使用者自備規則檔的格式。
- [`profiles/site-naming.js`](../profiles/site-naming.js)：內建規則。內容是同一種 JSON 物件，只是包成 `<script>` 以便 `file://` 直接載入。

| 欄位 | 說明 |
|---|---|
| `match` | 正規表示式（預設不分大小寫，可用 `flags` 改） |
| `kind` | `firewall`、`switch`、`router`、`host`、`unknown`；第一個符合的規則生效 |
| `role`、`site`、`value` | 可用 `$1`、`$2` 帶入比對到的群組 |
| `id`、`version` | 規則識別與版本；基準的 `meta.profile` 會記錄這兩個值。`id` 應與檔名相同 |
| `stripDomain`、`alias` | 建模前：去掉名稱中第一個 `.` 之後的網域、把舊名稱對應到正式名稱 |
| `group`、`label` | 建模後：分群名稱與畫面顯示名稱，`match` 比對到時以 `value` 產生 |

**比對順序**：`classify` 由上往下比對，**類型（`kind`）與角色（`role`）各自採用第一個有給值的規則**。所以較明確的規則要排在前面。例如 `TPE_CORE_RT_01` 要先用第三段 `RT` 判斷為路由器，再讓 `CORE` 的規則只提供角色；若 `CORE` 的規則排在前面又帶了 `kind`，路由器就會被判成交換器。

**分隔符號**：同一份規則的 `classify`、`group`、`label` 應接受相同的分隔符號（例如都用 `[_-]`），否則同一台設備會只有一部分被標註。

## 使用方式

- 在「建立基準」對話框的「命名規則」選單選擇，或選「載入命名規則檔（JSON）…」。載入過的規則會儲存在這個瀏覽器。
- 專案附帶兩份規則，副檔名代表用法：

  | 檔案 | 用法 | 名稱格式 |
  |---|---|---|
  | `profiles/site-naming.js` | **內建**：`index.html` 自動載入，直接出現在選單 | 站點_層級_類型_編號（`TPE_CORE_RT_01`），相容三段的站點_角色_編號 |
  | `profiles/floor-device-naming.json` | **使用者載入**：用「載入命名規則檔（JSON）…」選取，也是自備規則的範本 | 樓層_設備型號_編號（`3F_hAP_01`、`B1F-RB5009`） |

- 要新增內建規則，照 `site-naming.js` 的方式放在 `profiles/`，並在 `index.html` 加一行 `<script>`。
- `tests/run.js` 會用範例資料與代表名稱檢查這兩份規則的標註結果；修改規則時請一併更新測試。
