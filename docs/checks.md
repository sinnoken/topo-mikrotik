# 基準檢查規則

這份文件說明「基準檢查」每一項規則的判斷條件、使用的資料、不檢查的情況，以及看到結果後怎麼處理。規則的實作在 [`src/check/checks.js`](../src/check/checks.js)，本文件與程式是同一份規則的兩種表述，修改時要一起改（見[維護](#維護)）。

> 檢查結果描述的是**這一份 Snapshot 的資料是否一致、是否完整**，不是即時的網路健康狀態。沒有錯誤或警告，只代表在已收集的資料裡找不到矛盾。

## 總覽

| ID | 類別 | 標題（畫面上顯示） | 嚴重度 | 主要依據的資料 |
|---|---|---|---|---|
| [I01](#i01) | 輸入 | 無法辨識的內容 | 錯誤 | 收集檔本身 |
| [I02](#i02) | 輸入 | 同一設備重複提供同類資料（以後者為準） | 警告 | 收集檔本身 |
| [C01](#c01) | 覆蓋 | 網路設備僅由鄰居發現、沒有收集資料 | 提醒 | 鄰居、OSPF 鄰居 |
| [C02](#c02) | 覆蓋 | 缺少應收集的資料 | 警告 | 各設備收集到的資料類別 |
| [K01](#k01) | 鏈路 | LLDP 單向（對端沒有回報這條鏈路） | 警告 | `/ip neighbor` |
| [K02](#k02) | 鏈路 | 同一介面對應到多個鄰居 | 錯誤 | `/ip neighbor` |
| [K03](#k03) | 鏈路 | 聚合鏈路兩端成員不一致 | 警告 | `/ip neighbor`、export 的 `/interface bonding` |
| [K04](#k04) | 鏈路 | 對端回報的埠名稱與本機不同 | 提醒 | `/ip neighbor` |
| [V01](#v01) | VLAN | 鏈路兩端 VLAN 不一致 | 警告 | `/ip neighbor`、export 的 bridge VLAN、`/interface bridge vlan` |
| [V04](#v04) | VLAN | 鏈路兩端 native VLAN（PVID）不一致 | 警告 | `/ip neighbor`、export 的 bridge port `pvid` |
| [V05](#v05) | VLAN | VLAN 介面沒有任何成員埠（孤立 VLAN） | 提醒 | export 的 `/interface vlan`、bridge VLAN |
| [A01](#a01) | 位址 | 同一 IP 對應多個 MAC | 警告 | `/ip arp` |
| [A02](#a02) | 位址 | 同一 MAC 在同一 VLAN 出現在多個終端埠 | 警告 | `/interface bridge host` |
| [A03](#a03) | 位址 | 介面有學到 MAC 但沒有 LLDP／CDP 鄰接（未知對端） | 提醒 | `/interface bridge host`、`/ip neighbor` |
| [A04](#a04) | 位址 | 單一埠學到過多 MAC（可能下掛未管理交換器或 hypervisor） | 提醒 | `/interface bridge host`、`/ip neighbor` |
| [A05](#a05) | 位址 | ARP 位址不屬於該設備任何直連網段 | 提醒 | `/ip arp`、介面位址 |
| [R01](#r01) | 路由 | 路由下一跳不屬於任何已知設備 | 提醒 | `/ip route`、介面位址 |
| [R02](#r02) | 路由 | OSPF 鄰居無法對應到已收集的設備 | 提醒 | `/routing ospf neighbor` |
| [R03](#r03) | 路由 | 路由下一跳形成迴圈 | 警告 | `/ip route` |
| [R04](#r04) | 路由 | 路由下一跳落入黑洞路由 | 警告 | `/ip route` |
| [R05](#r05) | 路由 | DHCP 網路的閘道不在該網段內 | 警告 | export 的 `/ip dhcp-server network` |

VLAN 名稱相關的兩項檢查（多廠牌版的 V02、V03）已移除，因為 RouterOS 的 bridge VLAN 沒有名稱；為避免和多廠牌版混淆，這兩個代碼不再使用，之後新增的 VLAN 檢查從 V04 起編。

## 共通說明

### 嚴重度

| 嚴重度 | 意義 | 例子 |
|---|---|---|
| 錯誤 | 資料互相矛盾，或輸入無法使用；基準在這一點上不可信 | I01、K02 |
| 警告 | 可能有問題，需要人工核實 | K01、V01、A02 |
| 提醒 | 收集範圍或推論上的缺口，通常不代表網路有錯 | C01、A03、R01 |

結果依「錯誤 → 警告 → 提醒」、再依 ID 與訊息排序，同樣的輸入一定得到同樣的順序。

### 每筆結果的內容

每筆結果包含 `id`、`severity`、`title`、`message`、`entities`（相關的設備、介面、鏈路、IP 或 MAC，畫面上點一下會定位）與 `evidence`（最多 6 個來源位置）。`evidence` 指回收集檔的檔名與行號，畫面可開啟原文並標示該行，以便回到 RouterOS 原始輸出核對。

### 沒有發現時：通過與沒有資料可檢查

每項規則在 `CATALOG` 記有需要的資料類別（`data`）。沒有任何結果的規則再分成兩種，畫面列在檢查結果分頁下方、預設收合：

- **通過**：需要的資料至少有一台已收集設備提供，而且沒有發現問題。
- **沒有資料可檢查**：需要的資料沒有任何已收集設備提供，例如沒收路由表時的 R01、R03、R04。這時 0 筆不代表沒有問題，畫面會列出缺少哪一類資料。

輸入（I）與覆蓋（C）類規則不需要特定資料，一律會檢查。這只是整網層級的判斷：某類資料只有部分設備提供時，仍算通過，個別設備缺資料由 C02 提醒。

### 判斷時用到的名詞

- **介面鄰接**：LLDP 或 CDP 觀察到的鏈路，代表本機這個埠直接連到對端。K01–K04、V01 與終端埠判定只看介面鄰接。
- **廣播網域可達**：只有 MNDP 證據的鏈路。MNDP 只證明兩台設備在同一個 L2 廣播網域，不代表直連，所以**不套用** K01、K02、K03、V01，也不會因此排除終端埠。詳見[設計說明 §5.3](design-ssot.md#53-關鍵推論)。
- **單側觀察**：本機的鄰居資料看到對端，但對端沒有提供任何 LLDP／CDP 鄰居資料，無從比對。這種鏈路只計入覆蓋率，不列為 K01。
- **終端埠**：已收集設備上，推定直接接著終端的介面。條件見 [A02](#a02) 與[設計說明 §12](design-ssot.md#12-未知對端210-新增)。這是依證據的推定，不代表已證明對端是終端主機。
- **介面承載的 VLAN**：PVID、untagged 與 tagged VLAN 的聯集（`S.util.ifcVlans`），聚合成員另外加上所屬聚合介面的 VLAN。

## 輸入

### I01

**無法辨識的內容**（錯誤）

- **條件**：收集檔中有一段內容符合下列任一情況：
  - 沒有設備標頭，不知道屬於哪台設備。
  - 沒有任何解析器認得這段內容。
  - 解析器認得指令，但解析不出任何資料。最常見的原因是 `print` 沒有加 `detail without-paging`。
- **證據**：該段內容的起始行。訊息會寫出檔名、行號範圍與原因。
- **處理**：依訊息補上設備標頭或指令標記，或改用 `detail without-paging` 重新收集。格式見[收集清單 §2](collection.md#2-收集檔格式bundle-v1)。這類內容不會被丟掉，修正前該段資料都不會進入基準。

### I02

**同一設備重複提供同類資料（以後者為準）**（警告）

- **條件**：同一台設備的同一種資料（同一個解析器）在收集檔出現兩次以上。
- **處理方式**：只採用最後一次，較早的資料不進入基準。
- **證據**：每一次出現的起始行。
- **處理**：確認最後一份是想要的資料；若是合併多次收集造成的，刪除舊的那段。

## 覆蓋

### C01

**網路設備僅由鄰居發現、沒有收集資料**（提醒）

- **條件**：某台設備出現在其他設備的鄰居資料或 OSPF 鄰居資料中，但收集檔裡沒有它自己的輸出。
- **不檢查**：設備類型推論為主機（`host`）的不列，因為主機本來就不在收集範圍。
- **訊息**：列出是由哪些設備發現的。
- **處理**：若它是應管理的網路設備，把它加入收集清單；若是不在管理範圍的設備（例如 ISP 端），可以忽略。設備名稱對不上（identity 與收集檔標頭不同）也會造成同一台設備被當成兩台，見[收集清單 §3](collection.md#3-設備名稱必須對得起來)。

### C02

**缺少應收集的資料**（警告）

- **條件**：已收集的設備缺少依其類型應有的資料：

  | 設備類型 | 應有的資料 |
  |---|---|
  | 交換器 | 鄰居（`/ip neighbor`）、設定（`/export`）、MAC 表（`/interface bridge host`） |
  | 路由器、防火牆 | 鄰居（`/ip neighbor`）、設定（`/export`）、路由表（`/ip route`） |
  | 主機、未知 | 不要求 |

- **類型的來源**：設備類型是推論（型號 → 收集到的資料 → 鄰居回報的功能），命名規則可以覆寫。類型判斷錯了，要求的資料也會跟著錯。程式呼叫 `SSOT.build` 時可用選項 `expectedData` 覆寫上表。
- **處理**：依訊息補收對應指令，指令清單見[收集清單 §1](collection.md#1-每台設備要收集的指令)。覆蓋率分頁的「有缺漏」會列出所有缺資料的設備。

## 鏈路

### K01

**LLDP 單向（對端沒有回報這條鏈路）**（警告）

- **條件**：
  1. A 的 LLDP／CDP 鄰居資料說 A 的某個埠連到 B。
  2. B 也有提供 LLDP／CDP 鄰居資料。
  3. B 的資料裡卻找不到對應回 A 這個埠的鄰居。
- **怎麼判斷「對應回來」**：比對雙方回報的埠名。bridge 本身在兩端可能分別以 `bridge` 或 `bridge/成員` 回報，視為同一介面。兩端都沒有埠名時，若數量相同，依本機介面名稱排序後一一配對。
- **不檢查**：
  - B 完全沒有 LLDP／CDP 資料：這是單側觀察，只計入覆蓋率。
  - A 這一側只有 MNDP 證據：這條是廣播網域可達，不是介面鄰接。
- **注意**：MNDP 不算對端的回報。B 有 LLDP／CDP 資料、但對 A 只有 MNDP 觀察時，仍會列為 K01；B 完全只有 MNDP 資料時，則歸為單側觀察。
- **證據**：A 那一列鄰居資料。
- **常見原因**：B 的該埠關閉了 LLDP 收送，兩次收集之間鏈路異動，或中間有不轉送 LLDP 的設備（例如部分媒體轉換器、未管理交換器）。
- **處理**：檢查 B 該埠的 neighbor discovery 設定，或重新收集兩端。

### K02

**同一介面對應到多個鄰居**（錯誤）

- **條件**：同一個本機介面有兩條以上的介面鄰接鏈路，也就是 LLDP／CDP 在同一個埠看到不同的對端埠。
- **不檢查**：只有 MNDP 證據的鏈路。一個埠在 MNDP 看到多個鄰居很正常，因為它們同屬一個廣播網域。
- **證據**：每條鏈路的來源行。
- **常見原因**：埠下掛了未管理交換器或集線器、hypervisor 的虛擬交換器把多台主機的 LLDP 轉出來，或資料在兩次收集之間改變。
- **處理**：到現場或用 MAC 表確認該埠下實際接了什麼。拓樸圖在這個埠的配對不可信。

### K03

**聚合鏈路兩端成員不一致**（警告）

- **條件**：依成員鏈路推出聚合介面兩兩成對後，符合下列任一情況：
  1. 兩端都是聚合介面，但兩邊的成員數不同。訊息會寫出各自的成員數與實際連到對方的鏈路數。
  2. 一端是聚合成員，另一端的埠卻不屬於任何聚合介面。只有在對端設備已收集、而且有設定（`/export`）時才判定，因為聚合成員關係只來自 export 的 `/interface bonding`；沒有 export 時無從得知對端是否為聚合。
- **不檢查**：只有 MNDP 證據的鏈路。
- **證據**：相關成員鏈路的來源行。
- **處理**：比對兩端的 bonding 設定（`slaves`），或確認是否有成員埠的線路未接。

### K04

**對端回報的埠名稱與本機不同**（提醒）

- **條件**：鏈路已雙向配對，但 A 的鄰居資料記錄的對端埠名，與 B 自己回報的本機埠名不同。
- **說明**：鏈路仍採用 B 自己回報的埠，所以這只是提醒。常見於對端埠改過名稱，或 LLDP 的 port ID 送的是描述或預設名稱。
- **證據**：A 那一列鄰居資料。

## VLAN

### V01

**鏈路兩端 VLAN 不一致**（警告）

- **條件**：一條介面鄰接鏈路兩端承載的 VLAN 集合不同。訊息分別列出「只在 A」與「只在 B」的 VLAN。
- **比較的內容**：
  - 每一端都取 PVID、untagged 與 tagged VLAN 的聯集；聚合成員另外加上所屬聚合介面的 VLAN。
  - 目前**不區分 tagged 與 untagged**。因此一端是 access（PVID 20）、另一端是只 tagged 20 的 trunk，也會因為集合相同而不列；反過來，PVID 不同也會列出。
- **不檢查**：
  - 只有 MNDP 證據的鏈路。
  - 單側觀察的鏈路。
  - 任一端設備沒有設定（`/export`）也沒有 VLAN 成員資料（`/interface bridge vlan`），無從比較。
  - 兩端都沒有任何 VLAN。
- **注意**：只有 bridge 開啟 `vlan-filtering=yes` 時，VLAN 成員才會計入，見[收集清單 §4](collection.md#4-routeros-特有的行為與限制)。
- **證據**：鏈路的來源行。
- **處理**：比對兩端的 `/interface bridge vlan` 與 bridge port `pvid`。

### V04

**鏈路兩端 native VLAN（PVID）不一致**（警告）

- **條件**：介面鄰接鏈路的兩端都有 PVID，而且不同。聚合成員取所屬聚合介面的 PVID；同一組聚合的多條成員鏈路只報一次。
- **和 V01 的關係**：V01 比較兩端承載的 VLAN 集合，V04 只比較 native VLAN。兩端集合相同、但 native VLAN 不同時，只有 V04 會列出；未標記的流量會進到不同 VLAN。
- **不檢查**：
  - 只有 MNDP 證據的鏈路、單側觀察的鏈路。
  - 任一端沒有 VLAN 資料。
  - 任一端沒有 PVID，例如不是 bridge port 的路由器介面。
- **證據**：鏈路的來源行。
- **處理**：比對兩端 `/interface bridge port` 的 `pvid`。

### V05

**VLAN 介面沒有任何成員埠（孤立 VLAN）**（提醒）

- **條件**：bridge 上建立了 VLAN 介面（`/interface vlan`，例如 SVI），但這個 VLAN 除了 bridge 本身，沒有任何成員埠：沒有 tagged、untagged，也沒有任何埠的 PVID 是它。這個 VLAN 介面接不到任何設備。
- **和規格書的差異**：規格書寫「有 SVI 但沒有 access port」。但管理 VLAN 只走 trunk 是常見的正常設計，照字面判斷會大量誤報，所以改成「沒有任何成員埠」。
- **不檢查**：
  - 設備上沒有 bridge VLAN 成員資料，例如 `vlan-filtering` 未開啟，無從判斷。
  - VLAN 介面直接建在實體埠上，例如 router-on-a-stick，這時實體埠本身就是成員。
- **處理**：確認 VLAN 是否已停用但沒有刪除，或漏設 bridge VLAN 成員。

## 位址

### A01

**同一 IP 對應多個 MAC**（警告）

- **條件**：彙整所有設備的 ARP 表後，同一個 IP 對應到兩個以上不同的 MAC。
- **資料範圍**：ARP 只採用有效項目，略過 invalid、disabled、多播與 APIPA（169.254.0.0/16）位址。
- **證據**：每一筆 ARP 的來源行。
- **常見原因**：IP 衝突、VRRP 或 HA 切換、proxy ARP，或兩次收集之間 DHCP 位址被重新分配。
- **處理**：用 MAC 的廠商與位置判斷是否為衝突。

### A02

**同一 MAC 在同一 VLAN 出現在多個終端埠**（警告）

- **終端埠的條件**（必須同時成立）：
  1. 設備已收集。
  2. 介面恰好學到一個 MAC，而且不是設備自己的介面 MAC。
  3. 介面不是 Wi-Fi、不是中斷或停用狀態。
  4. 介面不是 bridge、vlan、loopback、vrrp 這類虛擬介面。依 RouterOS 的介面類型判斷，缺資料時才依名稱推測。
  5. 介面本身（含所屬聚合與聚合成員）沒有 LLDP／CDP 介面鄰接到其他已收集的網路設備。
  6. 介面本身（含所屬聚合與聚合成員）沒有推論鏈路。例如底下沒有其他設備的 CSS106，上行埠的 MAC 表只有它自己的 MAC，這個埠接的是交換器，不是終端。
- **條件**：同一個 MAC 在同一個 VLAN 出現在兩個以上終端埠。VLAN 取自 bridge host 的 `vid`；VLAN 不明的位置只與其他 VLAN 不明的位置比較。
- **為什麼是待核實的警告**：不同設備上相同的 VLAN ID 不保證屬於同一個 L2 廣播網域，所以這只是可能的重複或迴圈，需要人工核實。
- **不檢查**：Wi-Fi 的 MAC 觀察。同一 MAC 出現在多個 AP 可能是漫遊。
- **常見原因**：同一台主機有兩個網路卡共用 MAC（例如部分 bonding 模式）、虛擬機遷移、L2 迴圈，或 MAC 表在兩次收集之間更新。
- **處理**：查看訊息列出的每個位置，確認是否為同一台設備。

### A03

**介面有學到 MAC 但沒有 LLDP／CDP 鄰接（未知對端）**（提醒）

- **條件**：符合終端埠條件（見 [A02](#a02)），而且這個介面完全沒有 LLDP／CDP 介面鄰接。結果依設備彙總，每台設備一筆，訊息列出前 8 個介面與各自的 MAC 數。
- **說明**：這些位置會在拓樸圖上畫成「未知對端」節點，並列入清單的終端分類。只有 MNDP 廣播網域可達不算介面鄰接。完整設計見[設計說明 §12](design-ssot.md#12-未知對端210-新增)。
- **處理**：多半是 PC、印表機、IoT 等不送 LLDP 的設備，屬於正常情況。若該埠應該接網路設備，請在對端開啟 LLDP。

### A04

**單一埠學到過多 MAC（可能下掛未管理交換器或 hypervisor）**（提醒）

- **條件**：已收集設備上的有線介面學到超過 5 個外部 MAC（不含設備自己的介面 MAC），而且這個介面（含所屬聚合與成員）沒有任何 LLDP／CDP 介面鄰接。門檻 5 依規格書建議。
- **不檢查**：
  - Wi-Fi 介面，因為一對多是常態。
  - bridge、VLAN、loopback、VRRP 等虛擬介面。
  - 聚合介面本身。
  - 停用或中斷的介面。
- **說明**：這類埠不是終端埠，所以這些 MAC 不會畫成未知對端。A04 提醒這裡可能有看不見的下游設備。
- **處理**：到現場確認是否接了未管理交換器、AP 或虛擬化主機；若是網路設備，開啟它的 LLDP 並納入收集。

### A05

**ARP 位址不屬於該設備任何直連網段**（提醒）

- **條件**：設備的 ARP 表有某個 IP，但它不在這台設備任何介面位址的直連網段內。只檢查有介面位址資料的設備。
- **常見原因**：主機設錯網段或遮罩、IP 漂移，或 proxy ARP。
- **證據**：每一筆 ARP 的來源行。
- **處理**：用 ARP 的 MAC 找出主機，確認它的位址設定。

## 路由

### R01

**路由下一跳不屬於任何已知設備**（提醒）

- **條件**：路由的下一跳 IP 經遞迴解析後，仍然到不了任何已知設備的位址；但形成迴圈的列為 [R03](#r03)，落入黑洞路由的列為 [R04](#r04)，同一個下一跳只報一種。
- **遞迴解析**：下一跳若不是已知位址，就在同一台設備的路由表用最長前綴找它的下一跳，再往下查，最多 8 層，超過視為迴圈。
- **已知位址**：設備自有的介面位址（不含鄰居宣告的位址）與管理 IP。
- **路由的範圍**：只採用 `main` 路由表中作用中的 IPv4 路由。黑洞、不可達、禁止路由會保留（`blackhole: true`），供 R04 與路徑追蹤使用。
- **訊息**：每台設備一筆，列出到不了的下一跳。
- **常見原因**：下一跳是 ISP、未收集的設備，或缺少對方設備的位址資料。
- **處理**：若下一跳應該是管理範圍內的設備，把它加入收集清單，或補收它的 `/ip address`。

### R02

**OSPF 鄰居無法對應到已收集的設備**（提醒）

- **條件**：OSPF 鄰居依序用下列方式都找不到所屬設備：
  1. 鄰居位址屬於哪個已收集介面。
  2. router-id 對應哪台設備（設備的 router-id，或 router-id 剛好是某台設備的介面位址）。
  3. router-id 等於哪台設備的管理 IP。

  找不到時，系統會建立一個以鄰居 router-id 命名的未知設備。
- **證據**：OSPF 鄰居那一列。
- **處理**：把該鄰居設備加入收集清單，或確認它的 router-id 與介面位址是否已收集。OSPF 鄰接只作為 L3 證據，不會畫成拓樸圖的直連鏈路。

### R03

**路由下一跳形成迴圈**（警告）

- **條件**：下一跳在同一台設備的路由表遞迴解析時，又回到已經走過的位址。例如 A 網段的閘道要靠 B 網段的路由，B 網段的閘道又要靠 A 網段。
- **訊息**：每台設備一筆，列出形成迴圈的下一跳。
- **處理**：檢查相關的靜態路由；常見於互相指向的兩條靜態路由，或遞迴路由少了一條。

### R04

**路由下一跳落入黑洞路由**（警告）

- **條件**：下一跳遞迴解析時，最長符合的路由是黑洞、不可達或禁止路由，封包會在這台設備被丟棄。
- **說明**：黑洞路由本身不算錯誤，常用來吸收未使用的位址；有路由的下一跳落進黑洞才需要注意。路徑追蹤遇到黑洞路由也會在該處停下並註明。
- **處理**：確認黑洞路由的範圍是否太大，或下一跳是否設錯。

### R05

**DHCP 網路的閘道不在該網段內**（警告）

- **條件**：export 的 `/ip dhcp-server network` 設定的 `gateway` 不在它的 `address` 網段內。客戶端會拿到無法直接到達的預設閘道。
- **證據**：該設定的來源行。
- **處理**：修正 DHCP 網路的閘道。閘道是 VRRP 虛擬位址時，確認它和網段一致。

## 維護

新增或調整檢查時：

1. 在 [`src/check/checks.js`](../src/check/checks.js) 的 `CATALOG` 加入或修改規則（ID、類別、嚴重度、標題），並實作判斷。
2. 寫清楚判斷依據（事實）與證據來源（行號）；推論要標示為推論。
3. 在範例資料的產生器（`tools/gen-bundle.js`）放一個對應的問題，執行 `npm run sample`，並在 `tests/run.js` 加測試。
4. 更新本文件的總覽與對應章節。
5. ID、標題、訊息與排序要保持穩定；修改既有文字前先確認沒有外部流程依賴它。

## 參考

**專案內**

- [設計說明 §5.3 關鍵推論](design-ssot.md#53-關鍵推論)：鄰居配對、OSPF 對應與設備類型的推論規則
- [設計說明 §12 未知對端](design-ssot.md#12-未知對端210-新增)：終端埠與未知對端的完整設計
- [收集清單](collection.md)：每類資料要下的指令與格式
- 實作：[`src/check/checks.js`](../src/check/checks.js)（檢查）、[`src/model/build.js`](../src/model/build.js)（鄰居配對產生 K01、K04、R02 的依據）

**RouterOS 官方手冊**（欄位語意以手冊為準）

- [Neighbor discovery](https://manual.mikrotik.com/docs/system-information-and-utilities/neighbor-discovery.md)、[`/ip neighbor`](https://manual.mikrotik.com/docs/cli-reference/ip/neighbor.md)：K01–K04、A03
- [Bonding](https://manual.mikrotik.com/docs/high-availability-solutions/bonding.md)：K03
- [Bridge VLAN Table](https://manual.mikrotik.com/docs/bridging-and-switching/user-guides/bridge-vlan-table.md)、[`/interface bridge vlan`](https://manual.mikrotik.com/docs/cli-reference/interface/bridge/vlan.md)：V01、V05
- [`/interface bridge host`](https://manual.mikrotik.com/docs/cli-reference/interface/bridge/host.md)：A02、A03、A04
- [`/ip arp`](https://manual.mikrotik.com/docs/cli-reference/ip/arp.md)：A01
- [`/ip route`](https://manual.mikrotik.com/docs/cli-reference/ip/route.md)、[Routing Decision](https://manual.mikrotik.com/docs/user-guides/routing-and-networking-protocols/routing-decision.md)、[`/ip address`](https://manual.mikrotik.com/docs/cli-reference/ip/address.md)：R01、R03、R04、A05
- [`/interface bridge port`](https://manual.mikrotik.com/docs/cli-reference/interface/bridge/port.md)：V04（`pvid`、`frame-types`、`ingress-filtering`）
- [`/ip dhcp-server network`](https://manual.mikrotik.com/docs/cli-reference/ip/dhcp-server/network.md)、[`/interface vrrp`](https://manual.mikrotik.com/docs/cli-reference/interface/vrrp.md)：R05
- [OSPF](https://manual.mikrotik.com/docs/user-guides/routing-and-networking-protocols/unicast/ospf.md)、[`/routing ospf neighbor`](https://manual.mikrotik.com/docs/cli-reference/routing/ospf/neighbor.md)：R02
- [`/system resource`](https://manual.mikrotik.com/docs/cli-reference/system/resource.md)：C02 的設備類型（型號）
