# 收集清單與輸入格式（MikroTik RouterOS）

基準的品質取決於輸入。這份文件規定「每台設備要下哪些指令」與「怎麼合併成一個收集檔」。

> **重要**：所有 `print` 指令都要加 **`detail without-paging`**。detail 的 `key=value` 格式在各版本間最一致，也不受欄寬影響；沒加 detail 的表格式輸出**不支援**，會列為「解析器已辨識，但解析不出內容」。

> **版本**：以 RouterOS 7.x 為主，6.43 以上（有 bridge VLAN filtering）大致可用。解析器依文件與慣例撰寫，**尚未用真實設備輸出驗證**，遇到無法解析的輸出請回報。

## 0. 批次 SSH 收集器（WSL/Linux）

專案提供輕量 Node.js CLI，使用作業系統的 `ssh` 逐台執行以下唯讀指令，
最後產生一個可直接上傳網站的 `bundle-v1` 檔。它不在瀏覽器內執行，也不保存
密碼或引入 SSH library。

前置條件：

- WSL/Linux（macOS 也可）、Node.js 與 OpenSSH client
- 已設定 SSH key/agent 與 known_hosts；不要把密碼寫進設備清單
- 先用 `ssh admin@<address>` 確認可免互動登入

設備清單使用 CSV，欄位為 `name,address,user,port`；`port` 可省略，預設 22：

```csv
name,address,user,port
TPE_CORE_RT_01,10.1.10.2,admin,22
TPE_ACC_SW_01,10.1.10.21,admin,22
```

執行：

```bash
npm run collect -- devices.csv --output collection.txt
```

常用選項：

```bash
npm run collect -- devices.csv --dry-run
npm run collect -- devices.csv --device TPE_CORE_RT_01 --command config,neighbor
npm run collect -- devices.csv --timeout 60000 --retry 1 --output collection.txt
```

收集器預設使用 `BatchMode=yes`、逐台執行，失敗時會保留成功區塊並以非零
exit code 結束。請查看終端的設備/指令失敗摘要，不要把部分成功的檔案當成
完整基準。SSH stderr 不會混入 RouterOS stdout，也不會寫入輸出檔；設備 host
key 驗證交由系統 SSH，禁止用 `StrictHostKeyChecking=no`。

CLI 只執行本節列出的唯讀收集指令，不執行設定變更。輸出檔仍由網站正常走
reader、adapter、model 與 check pipeline；收集器不解析或修改 RouterOS 內容。

## 1. 每台設備要收集的指令

| 資料類別 | 指令 | 用途 | 交換器 | 路由器 |
|---|---|---|:-:|:-:|
| 設定 | `/export terse`（`compact` 也可） | 介面註解、bridge、bridge VLAN、bonding、IP、router-id、主機名 | 必要 | 必要 |
| 鄰居 | `/ip neighbor print detail without-paging` | 實體連結（LLDP／MNDP／CDP） | 必要 | 必要 |
| MAC 表 | `/interface bridge host print detail without-paging` | MAC 位置 | 必要 | — |
| 路由表 | `/ip route print detail without-paging` | 路由追蹤 | 有 L3 時 | 必要 |
| ARP | `/ip arp print detail without-paging` | MAC↔IP | 建議 | 建議 |
| 系統資訊 | `/system resource print` | 型號（決定交換器／路由器）、版本 | 建議 | 建議 |
| Bridge VLAN 實際成員 | `/interface bridge vlan print detail without-paging` | 含動態成員（pvid 自動產生的項目） | 選用 | — |
| 介面狀態 | `/interface print detail without-paging` | running／停用／註解 | 選用 | 選用 |
| IP 位址 | `/ip address print detail without-paging` | 含動態位址（DHCP client 等）；靜態的 export 已有 | 選用 | 選用 |
| OSPF 鄰居 | `/routing ospf neighbor print detail without-paging` | L3 鄰接 | 有跑 OSPF 時 | 有跑 OSPF 時 |

「必要」項目缺少時，檢查結果會出現 **C02 缺少應收集的資料**。

**安全**：不要使用 `show-sensitive`。RouterOS 7 的 `/export` 預設不輸出密碼與金鑰（6.x 請用 `hide-sensitive`）。收集檔只應包含拓樸資訊。

## 2. 收集檔格式（bundle-v1）

一個文字檔放所有設備。每台設備以標頭開始、以 `_____`（5 個以上底線）結束；分隔線可省略，遇到下一個標頭也會自動切段。

```
TPE_CORE_RT_01 (10.1.10.2):
[admin@TPE_CORE_RT_01] > /export terse
…輸出…
[admin@TPE_CORE_RT_01] > /ip neighbor print detail without-paging
…輸出…
_____
TPE_ACC_SW_01 (10.1.10.21):
### /interface bridge host print detail without-paging
…輸出…
_____
```

### 指令標記

每段輸出前要有一行標記指令，兩種寫法：

| 寫法 | 例子 |
|---|---|
| 明確標記（建議） | `### /ip neighbor print detail without-paging` |
| RouterOS 提示字元 | `[admin@TPE_SW_01] > /ip neighbor print detail without-paging` |

- 指令必須是**絕對路徑**（以 `/` 開頭）。`[admin@x] /ip> print` 這種相對路徑的提示字元不支援。
- 沒有標記時，系統會依內容判斷是哪一種輸出；判斷不出來的段落列為 **I01 無法辨識的內容**，不會被丟掉。

### 其他規則

- 以單一 `#` 開頭的行是註解（`###` 才是指令標記）。RouterOS export 開頭的 `# 日期 by RouterOS…` 就是這種註解。
- 同一台設備的同一種資料出現兩次時，採用**最後一次**，並列出 **I02**。
- 也可以一個檔案一台設備（`files-v1`）：檔名（去副檔名）就是設備名，內容同樣用指令標記分段。
- 同時貼上與選擇多個檔案時，會一次全部讀入建立同一份基準。

## 3. 設備名稱必須對得起來

- 標頭的設備名（`TPE_CORE_RT_01 (…)`）建議與 `/system identity` 相同；其他設備的鄰居列會用 identity 稱呼它。
- 若兩者不同，系統會用**管理 IP**對回同一台（標頭的 IP 要等於該設備在鄰居列中的 `address`）；都對不上就會被當成兩台不同的設備。
- 鄰居的 identity 若帶網域，可在命名規則加上 `"stripDomain": true`；其他對不上的用 `alias`。

## 4. RouterOS 特有的行為與限制

| 項目 | 說明 |
|---|---|
| 對端埠名 | 鄰居列的 `interface-name`（來自 LLDP）才是對端的埠名。沒有時，單一連結仍可配對；**平行連結（例如 LACP）會依本機介面名稱排序後一一配對**，這是推測，不保證正確 |
| 同一鄰居多列 | 同一台鄰居可能同時從連接埠與 `bridge` 出現，或被多個協定各列一次；系統優先採用連接埠，重複的丟掉 |
| Bridge VLAN | 只有 bridge 開了 `vlan-filtering=yes` 才計入 VLAN 成員；每個 bridge 連接埠的 `pvid`（預設 1）算是該 VLAN 的未標記成員 |
| VLAN 名稱 | RouterOS 的 bridge VLAN 沒有名稱，所以沒有「同一 VLAN 名稱不同」這類檢查 |
| 聚合 | `/interface bonding` 的 `slaves` 視為聚合成員，兩端成員數不同會列為 K03 |
| 設備類型 | 依型號：CRS／CSS 為交換器、CCR／RB／hAP／hEX／CHR 為路由器；沒有型號時，已收集的設備看有哪些資料，未收集的設備看鄰居回報的功能（`system-caps-enabled`） |
| 防火牆 | 不解析防火牆規則 |
| 無線、CAPsMAN、VPN | 不解析 |
