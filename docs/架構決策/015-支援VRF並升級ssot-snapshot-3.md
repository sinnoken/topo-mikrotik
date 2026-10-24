# ADR-015：支援 VRF：位址、路由、ARP 加上 vrf，升級為 ssot-snapshot/3

- **狀態**：提議
- **日期**：2026-10-24
- **決策者**：使用者

## 背景

使用者的網路有用 VRF，所以規格書的 M3（VRF）要做（[規格書 §11](../多層網路架構圖_實作規格書.md#11-實作階段)）。目前程式把整份基準當成同一個位址空間：

- **位址與網段**：`ipAddresses[].vrf`、`prefixes[].vrf` 已預留，但固定為 null（`src/pipeline.js`）；`prefixes` 以網段字串為鍵合併，不同 VRF 的同一個網段會被併成一筆。
- **路由**：`routing-table` 不是 `main` 的路由，解析時以「非 main 路由表」列為略過（`src/adapters/mikrotik.js` 的 `mikrotik.route`），不進入基準，也不會列在 I03（`tests/core/i03.js` 以 `routing-table=vrf1` 的路由確認）。`routes` 沒有路由表或 VRF 欄位。
- **ARP**：`arps` 沒有 VRF 欄位。
- **VRF 設定**：export 若有 `/ip vrf`，目前列為「未使用的設定」略過。
- **查詢與檢查**：查詢層以 IP 為鍵建索引（`src/query/query.js` 的 `ipOwner`、`arpsByIp`），路徑追蹤（`S.trace`，`src/query/trace.js`）與 R01／R03／R04 只有 main 表可用；以名稱、網段或 IP 為鍵的檢查把整份基準視為同一個位址空間（[路線圖「M3：VRF」](../路線圖.md#m3vrf)）。

所以位址在不同 VRF 重疊時：

- 路徑追蹤與之後的可達性查詢（`Q.reach`，M2）會查錯路由表，或把另一個 VRF 的設備當成下一跳。
- `Q.findIp` 只會找到其中一個擁有者；A01、A09 把不同 VRF 的同一個 IP 當成衝突，屬於誤報。
- VRF 內的路由完全看不到。

RouterOS 的 VRF 語意（[RouterOS 手冊：VRF](https://manual.mikrotik.com/docs/user-guides/routing-and-networking-protocols/vrf.md)）：

- `/ip vrf` 的每一筆有 `name` 與 `interfaces`，依序比對；內建的 `main` 涵蓋其餘介面。
- 每個 VRF 對應一個同名的路由表，路由以 `routing-table=<VRF 名稱>` 放進該 VRF。
- VRF 以介面劃分：位址與 ARP 依所在的介面屬於該 VRF，`/ip address`、`/ip arp` 本身不指定 VRF。
- 沒有指定 VRF 時，服務與閘道都屬於 `main`；`gateway=<IP>@<VRF>` 表示在另一個 VRF 解析閘道（路由洩漏）。`/ip service` 另有 `vrf` 屬性。

## 決策（建議）

- **收集**：export 已含 `/ip vrf` 的設定，adapter 改為解析它（data-model）。collector 評估是否另收 `/ip vrf print detail without-paging` 或 `/routing table print detail without-paging`，取得動態項目與路由表的狀態。目前的 `/ip route print detail without-paging` 已包含其他路由表的路由，不必另收。
- **事實**：
  - 介面依 `/ip vrf` 的 `interfaces` 得到所屬的 VRF（沒有列在任何一筆時為 `main`）。
  - 位址、網段、ARP 的 `vrf` 取介面所屬的 VRF；欄位一律寫出名稱，`main` 也寫成 `'main'`，不再用 null。
  - 路由新增路由表（`routing-table` 原值）與 `vrf`（路由表對應到 VRF 時；只用於策略路由、沒有對應 VRF 的路由表為 null）。下一跳的 `@<VRF>` 保留為下一跳的屬性。
  - 非 main 路由表的路由改為事實，不再略過。
- **鍵**：查詢與檢查中以 IP 或網段為鍵的地方都加上 VRF。
  - 實體鍵的寫法：`main` 不加後綴，維持現在的 `10.0.0.1`、`10.0.0.0/24`；其他 VRF 加上 RouterOS 的寫法 `@<VRF>`，例如 `10.0.0.1@cust-a`。這讓只用 main 的網路，findingKey 與處理紀錄都不變（見下方「findingKey 與處理紀錄」）。
  - 寫法定義在 `src/core/keys.js`，是唯一的來源。
- **schema 升為 `ssot-snapshot/3`**：`prefixes` 由「每個網段一筆」改為「每個 VRF 的每個網段一筆」，`vrf` 由「固定 null」改為一定有值，屬於改變欄位意義的破壞性修改（[ADR-010](010-schema版本與轉換規則.md) 的版本規則），依 [ADR-005](005-版本升級規則.md) 升 major（3.0.0）。
- **轉換規則**（依 ADR-010 的分類）：
  - `ssot-snapshot/2`：可以從輸入重建，不寫轉換函式。畫面還原時已有「schema 不同就用儲存的輸入重建」的處理（ADR-005）。
  - `ssot-patch`、`ssot-snapdiff`、`ssot-diff`：可以重新產生，不轉換。
  - `ssot-expected/1`：只有設備、鏈路與 VLAN（`S.compare.expectedFrom`），不含位址與路由，不受影響。
  - `ssot-profile/1`：不受影響。
  - `ssot-ledger/1`：格式不變，但部分項目的 findingKey 會改變，需要一次鍵的對應，見下一節。
- **查詢與畫面**：
  - `S.trace` 與 `Q.reach`（M2）加上 vrf 參數，沿 VRF 的路由表追蹤，遇到 `@<VRF>` 的下一跳時換到那個路由表。
  - `Q.findIp` 等以 IP 查詢的函式加上 vrf 參數；不給 vrf 時回傳所有 VRF 的結果並標出 VRF。
  - L3 子網圖（M1 先不分 VRF）改以 VRF 為容器。
  - 以網段或 IP 為鍵的檢查（A01、A05、A07、A08、A09、R06）只在同一個 VRF 內比較；R01、R03、R04 依路由所在的 VRF 解析下一跳。以名稱為鍵的檢查（V07、A10–A12）和 VRF 無直接關係，實作時逐項確認。

### findingKey 與處理紀錄

finding 的實體中，只有 `ip` 類型帶 IP：A01（IP＋MAC）、A05（設備＋IP）、A09（IP＋介面）。設備、介面、鏈路、MAC、VLAN、防火牆規則與服務的鍵都不含 VRF，不受影響。

| 情況 | findingKey | 處理紀錄的影響 |
|---|---|---|
| 只用 main 的網路 | 不變（main 不加後綴） | 不需要轉換 |
| A01、A05、A09 的 IP 在非 main 的 VRF | `ip:10.0.0.1` 變成 `ip:10.0.0.1@cust-a` | 舊項目在下一輪消失（open、scheduled、regressed 改為 fixed，其他狀態留在舊鍵）；新項目列為 open，原本的狀態（scheduled、accepted 與豁免、false-positive）與備註不會帶過去 |
| 不同 VRF 的同一個 IP 被 A01、A09 當成衝突 | 改為分 VRF 比較後不再產生 | 舊項目消失、被判為 fixed，但它其實是誤報，網路沒有改變 |
| 以群組為實體的檢查（A07、A08、A09 的介面，R06 的設備）因分 VRF 而拆成多組 | 實體變少，鍵改變 | 一個舊項目對應到多個新項目；拆開後只剩一個位置的組不再產生，舊項目被判為 fixed |

評估：

- **只靠處理紀錄無法轉換**：處理紀錄只存 findingKey 與狀態，不知道某個 IP 屬於哪個 VRF；要等第一份 `/3` 基準建立時，才能把舊鍵對應到新鍵。
- **建議的對應方式**：在第一次以 `/3` 基準推進時（`meta.baselineKey` 含 major.minor，升 3.0.0 一定是新的一輪），對每個在新基準消失的舊鍵：
  - 找出規則 id 相同、而且「把新鍵的 `@<VRF>` 去掉後等於舊鍵」或「實體是舊鍵子集合」的新鍵。
  - 找到時，把狀態、豁免與備註複製到每個新鍵，兩邊都記一筆歷程（舊鍵、新鍵、原因是 VRF），舊鍵不判為 fixed。
  - 找不到時，舊鍵維持原狀態並記下「規則因 VRF 改變」，不判為 fixed；畫面列出這些項目讓使用者處理。
- 這和 findingKey 區分 facet 時「一個舊鍵分裂成多個新鍵」是同一種轉換，應共用同一套做法，不另寫一份。
- `ssot-ledger` 不必升 schema：格式不變，改變的是 findingKey 的內容（[ADR-003](003-findingKey的組成.md) 的「變困難的」已指出這類修改要說明對處理紀錄的影響）。

## 考慮過的選項

| 選項 | 優點 | 缺點 | 結論 |
|---|---|---|---|
| A. 只把 vrf 當成欄位，不放進鍵 | 相容修改，不必升 schema；findingKey 完全不變 | 位址重疊時查詢索引仍會互相覆蓋，`prefixes` 仍會合併不同 VRF 的網段；路徑追蹤與可達性仍會算錯，沒有解決問題 | 不建議 |
| B. vrf 放進鍵，main 不加後綴 | 位址重疊時各自獨立；只用 main 的網路 findingKey 不變；寫法沿用 RouterOS 的 `@<VRF>` 與「沒寫就是 main」 | 鍵有兩種寫法（有、沒有後綴），解析鍵時要處理；非 main 的 IP 相關項目仍要對應一次 | **建議** |
| C. vrf 放進鍵，所有 VRF 都加（包括 `@main`） | 寫法一致 | 所有 A01、A05、A09 的 findingKey 都會改變，每份處理紀錄都要轉換；新舊比對的 IP 類別也全部變成新增與移除 | 不建議 |
| D. 把每個非 main 的 VRF 當成一台虛擬設備 | 沿用以設備為範圍的邏輯，改動少 | 偽造設備，違反「不改寫事實」；覆蓋率、設備清單與 `Q.findingDevice` 都會出錯 | 不建議 |
| E. 維持現狀，只在文件說明限制 | 不用改 | 使用者的網路有 VRF，路徑追蹤與 L4 可達性的結果不可信 | 不建議 |

另一個取捨是路由表與 VRF 是否要分開：RouterOS 的路由表不一定對應 VRF（策略路由用的路由表沒有 VRF）。建議兩個都存（路由表原值與 `vrf`），路徑追蹤只沿 VRF 的路由表；策略路由要依 mangle 的 `routing-mark` 判斷，不在這次範圍內。

## 後果

### 變容易的

- 位址重疊的網路，路徑追蹤、可達性查詢與位址相關檢查都會在各自的 VRF 內計算，不再誤報。
- VRF 內的路由成為事實，可以追溯到來源行。
- L3 子網圖可以依 VRF 分開呈現，L4 的 zone 可以用 VRF 當來源（規格書 §5.4）。

### 變困難的

- 舊版匯出的 `/2` 基準 JSON 不能和 `/3` 比對（`S.compare.snapshots` 遇到不同 schema 不比對，並請使用者從原始輸入重新建立），要從原始輸入重建。
- 以 IP 為鍵的地方都要改：查詢索引、`Q.findingDevice` 的 `ip` 實體、新舊比對的 IP 類別（`src/compare/compare.js` 以 IP 為鍵）、畫面的 IP 搜尋與詳情。
- 處理紀錄要做一次 findingKey 的對應，並有測試確認狀態不遺失。

### 之後要回頭看的

- 策略路由（`routing-mark` 與非 VRF 的路由表）是否納入路徑追蹤。
- `/ip service` 的 `vrf` 屬性：F07 判斷 WAN 能否連入管理服務時，是否要考慮服務所在的 VRF。
- 防火牆規則與 VRF 的關係（例如以 VRF 介面為 `in-interface`），在 M2 的 `Q.reach` 跨 VRF 時再確認。
- [ADR-010](010-schema版本與轉換規則.md) 仍是提議；這份 ADR 的轉換規則以它的分類為前提，兩者要一起決定。

## 待辦

- 使用者：決定是否採用，以及選項 B 的鍵寫法。
- 採用時：
  - collector：評估另收 `/ip vrf` 或 `/routing table` 的 print；同步 `docs/收集清單與輸入格式.md`。
  - data-model：解析 `/ip vrf`、非 main 路由表改為事實、`src/core/keys.js` 的 VRF 鍵、升 `ssot-snapshot/3` 與 3.0.0、查詢與檢查分 VRF、`S.trace` 與 `Q.reach` 支援 vrf；先寫失敗的測試（含位址重疊的範例）。
  - workflow：處理紀錄的鍵對應（與 facet 的轉換共用）與舊版範例測試；新舊比對的 IP 類別加上 VRF。
  - frontend：L3 子網圖的 VRF 容器、IP 搜尋與詳情顯示 VRF。
  - docs：設計說明 §5.2 與版本紀錄、基準檢查規則中 VRF 相關的說明、規格書的狀態。
