# 命名規則（profile）

命名規則是**獨立、可跳過**的 JSON 檔。不套用時系統完整可用：設備類型依廠牌與收集到的資料判斷，分群依連線關係。

命名規則只能做兩件事：

1. **建模前**把名稱對到正式名稱：`alias`（別名）、`stripDomain`（去掉網域）
2. **建模後**加註解：`classify`（類型、角色、站點）、`group`（分群）、`label`（顯示名稱）

它**不能**新增、刪除或改變任何事實（介面、連結、VLAN、位址）。基準的 `meta.profile` 會記錄使用了哪一份規則與版本。

## 格式

```json
{
  "schema": "ssot-profile/1",
  "id": "site-naming",
  "version": "1",
  "label": "站點_角色_編號",
  "stripDomain": true,
  "alias": { "OLD-CORE-1": "TPE_CORE_SW_01" },
  "classify": [
    { "match": "(^|_)(FW|FG|FGT)(_|\\d|$)", "kind": "firewall", "role": "FW" },
    { "match": "^[A-Z0-9]{2,5}_(CORE|DIST|ACC)_", "kind": "switch", "role": "$1" }
  ],
  "group": { "match": "^([A-Z0-9]{2,5})[_-]", "value": "$1" },
  "label": { "match": "^[A-Z0-9]+_(.*)$", "value": "$1" }
}
```

| 欄位 | 說明 |
|---|---|
| `match` | 正規表示式（預設不分大小寫，可用 `flags` 改） |
| `kind` | `firewall`、`switch`、`router`、`host`、`unknown`；第一個符合的規則生效 |
| `role`、`site`、`value` | 可用 `$1`、`$2` 帶入比對到的群組 |

## 使用方式

- 在「建立基準」對話框的「命名規則」選單選擇，或選「載入命名規則檔（JSON）…」。載入過的規則會保存在這個瀏覽器。
- 專案附帶 `profiles/site-naming.js`（舊版 `GROUP_RULES` 搬過來的範例）及 `profiles/floor-device-naming.json`（可從介面載入的 JSON 範例）。要新增內建規則，照同樣方式放在 `profiles/` 並在 `index.html` 加一行 `<script>`。
