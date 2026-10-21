---
name: routeros-acl-audit
description: "Use when adding or changing RouterOS firewall analysis: parsing /ip firewall filter|nat|raw, /ipv6 firewall, /ip service, /interface list from /export; WAN/LAN classification; firewall findings (shadowed/redundant rules, WAN-reachable accepts, DNAT exposure); or firewall views and baseline comparison. Keeps rule order, provenance, and fact-vs-inference boundaries."
argument-hint: "Describe the firewall rule, check, or view being added or changed"
user-invocable: true
---

> Claude Code 版。內容與 `.github/skills/routeros-acl-audit/SKILL.md`（GitHub Copilot 版）相同，修改時兩邊一起改；`tests/docs.js` 會檢查兩者一致。

# RouterOS ACL 稽核

## 目的

把防火牆規則做成和其他資料一樣的 Snapshot 事實與 finding：可追溯到 `/export` 的行號、
結果可重現、在瀏覽器離線執行。這個 skill 只講怎麼在本專案裡做 ACL 分析；
不另外寫 Python 腳本、不產生獨立的 HTML 報表，也不接 CI 通知。

**目前狀態**：核心還沒有解析防火牆（`docs/collection.md` 的限制表、`docs/design-ssot.md` 的未支援清單）。
第一次使用時從「階段一」開始，每個階段完成後更新本節。

## 資料來源

不需要新的收集指令。收集器的 `config` 已經執行 `/export terse`，裡面含有：

| 區段 | 用途 |
|---|---|
| `/ip firewall filter`、`/ipv6 firewall filter` | 規則本體；同一個 chain 內依出現順序比對 |
| `/ip firewall raw`、`/ipv6 firewall raw` | prerouting 可能先丟掉封包，判斷是否「對外暴露」時一定要看 |
| `/ip firewall nat` | `action=dst-nat` 是 WAN 可連入點；`connection-nat-state=dstnat` 的放行規則要和它配對 |
| `/interface list member` | WAN／LAN 分類的事實來源 |
| `/ip service` | `address=`（available-from）與 `disabled`；filter 放行不等於服務接受連線 |
| `/ip ipsec peer`、`/ip ipsec policy` | 判斷 ESP／AH／UDP 500／4500 放行規則是不是還有用 |

`/export` 的兩個特性會影響判斷：

- **只匯出非預設值**：沒有出現在 `/ip service` 區段的服務是預設狀態（啟用、不限來源）。
  各版本的預設值以官方手冊 <https://manual.mikrotik.com/llms.txt> 為準，不要把「沒寫」當成「已停用」。
- **不含動態規則**（例如 UPnP 產生的 dst-nat）。報告中要寫明這一點，不可宣稱已列出全部可連入點。

## 與備份設定 repo 的銜接

這個 skill 的方法來自另一個 repo 的 ACL 稽核流程。那邊用 Python 分析固定路徑 `Backup_Configs/*.conf`，
再組成一份單頁報表；本專案則接收收集器打包的 `bundle-v1` 或使用者上傳的檔案。兩者處理的是同一種資料，可以直接接起來：

- **直接載入備份檔**：`Backup_Configs/*.conf` 是 `/export` 的輸出，在畫面上多選上傳即可，
  由 `files-v1` 讀取（檔名去掉副檔名就是設備名稱，例如 `192.168.88.253.conf` → `192.168.88.253`；
  export 開頭的日期會當成收集時間）。不需要轉檔，也不要另寫一個 reader。
- **只有備份檔時**：沒有鄰居與路由表，C02 會列出缺少的資料。這是正常的，不要為了防火牆分析關閉它。
- **CI 守門**：那邊的 `guard.py`（與核准基準比對，發現新的 WAN 可連入點就讓 CI 失敗）
  之後可以改成以 Node 載入本專案核心（方法同 `tests/load.js`），用 compare 的簽章比對取代。
  這屬於備份 repo 的工作，本專案只要提供穩定的 Snapshot 與 finding 契約。

## 分層與分工

依 `snapshot-contract-change` skill 的順序執行：data-model → frontend → docs。

1. **adapter**（`src/adapters/mikrotik.js` 的 `mikrotik.config`）：解析上表各區段，產生帶 `line` 的事實。
   保留原始比對條件（key=value，否定用 `!`）、`disabled`、`comment`，以及在 chain 內的順序。
   解析器修改依 `routeros-parser-fixtures` skill，先寫失敗的測試。
   續行與 RouterOS 7 斜線路徑已經由現有的 export 解析處理，沿用即可，不要另寫一套。
2. **model**（`src/model/build.js`）：轉成防火牆規則實體。key 包含設備、位址族（v4／v6）、表（filter／nat／raw）、
   chain 與順序。內部模型用 Map，只在 `pipeline.js` 的 `serialize` 轉成陣列。
3. **infer**（`src/model/infer.js`）：「WAN 可連入」是推論，要明確標示。
   WAN 介面只從 `/interface list member` 的事實推得；沒有可辨識的 WAN 清單時，用 coverage／C 系列 finding 說明無法判斷。
   **不要寫死** `sfp1`、`lte1`、`all-ppp` 這類介面名稱。
4. **check**（`src/check/checks.js`）：在 `CATALOG` 新增一個類別，同步 `docs/checks.md`（`tests/docs.js` 會檢查兩者一致）。
   每筆 finding 的證據指向規則所在行；遮蔽與重複類的 finding 也要附上前面那條規則的行號。
   範例資料（`npm run sample` 的產生器）要放入對應的問題，並加上測試。
5. **query → view**：畫面只透過 `SSOT.query()` 讀取，例如依 chain 順序列出規則並標示 finding。
   顏色從 `src/view/theme.js` 取。
6. **compare**：規則的簽章用「設備＋位址族＋表＋chain＋比對條件」，不用規則編號，
   這樣插入一條規則時，後面的規則不會全部顯示為變更。比對結果也要區分「新增可連入點」和「既有規則限制變多」。

## 建議的檢查（實作時再定 id 與嚴重度）

| 檢查 | 依據 | 備註 |
|---|---|---|
| 規則被前面的規則完全遮蔽，永遠不會命中 | 事實 | 前一條帶 `random`、`limit`、`dst-limit`、`connection-limit`、`psd`、`nth`、`per-connection-classifier` 時不算遮蔽；清單型欄位（`dst-port`、`connection-state`…）用子集合比較 |
| 重複規則（相同比對條件與動作） | 事實 | 常見原因是 defconf 被匯入兩次 |
| WAN 可主動建立新連線的 input／forward accept | 推論（WAN 分類） | 排除 `connection-state` 含 established／related、ICMP、帶 `ipsec-policy`、來源是私有位址或從 LAN 介面進入的規則；被 jump 的子 chain 也要算 |
| 啟用中的 dst-nat 與對應的 forward 放行 | 推論 | 沒有 in-interface 的 `connection-nat-state=dstnat` 放行可能是 hairpin NAT 需要的，處理說明要提醒 |
| IPv6 forward 放行只限 dst-port、沒有限 dst-address | 事實 | IPv6 沒有 NAT，等於整個 LAN 都開放 |
| 以固定來源埠放行（例如 `protocol=tcp src-port=500`） | 事實 | 攻擊者可以用這個來源埠繞過防火牆 |
| 管理服務啟用、沒有 available-from，且 input 放行 | 事實＋推論 | 要同時看 `/ip service`（含預設值）與 filter |

嚴重度依實際影響決定：ESP／AH 放行到沒有跑 IPsec 的主機，影響遠小於任意 TCP 埠放行。

## 判斷時容易出錯的地方

以下都是實際犯過的錯，每一條都應該有對應的測試：

- 說「對外暴露」之前沒看 raw 表。
- 說「可登入管理介面」之前沒看 `/ip service` 的 available-from。
- 跳過 output chain 與只被 jump 的子 chain；「白名單之後接全部放行」在 forward 和 output 都很常見。
- 建議停用 IPsec 規則之前，沒確認是否有 `/ip ipsec peer` 或 `policy`。
- 規則註解可能是 UTF-8／Big5 混合編碼；解碼失敗要保留原文並標示，不可默默丟掉。

## 不納入本專案的部分

- **修補指令與主管摘要**：這些需要人工判斷，不放進核心。各檢查的「處理」寫在 `docs/checks.md`。
  需要給 RouterOS 指令範例時，以 `disabled=yes` 為主，用 comment 或屬性 `find`（不要用編號），並附上驗證與回復方式。
- **寫回設備**：本工具是唯讀的基準工具，收集器只執行 print／export。
- **外部資源**：報表要遵守離線契約，不使用網路字型或 CDN。

## 驗證

`npm test`、`git diff --check`；改到範例資料時用 `npm run sample` 重新產生；
效能相關的變更（約 1000 台、每台數百條規則）再跑 `npm run test:large`。
