# topo-mikrotik 設計說明（MikroTik RouterOS 專用版）

> 這是 topo-ssot 的 **MikroTik 專用版**：核心架構、模型、檢查、畫面與多廠牌版相同，只有「輸入解析器」、設備類型推論與少數檢查不同。差異見第 13 節。以下內容以本版為準。

範圍：MikroTik RouterOS（7.x 為主）｜規模：約 1000 台已收集設備｜一次貼完、在瀏覽器即時產生｜不需網路、不需後端

---

## 1. 目的

由設備 CLI 輸出建立一份**可信的網路現況基準（Snapshot）**，並回答：

1. 網路結構是什麼？
2. 某個 MAC／IP／VLAN 在哪裡？
3. 哪些地方資料互相矛盾、哪些地方沒有收集到？

圖、表、路由追蹤都只是檢視這份基準的方式。

## 2. 原則

| # | 原則 | 實作方式 |
|---|---|---|
| P1 | 一次建立、不增量合併 | `SSOT.build(sources, options) → Snapshot`；同輸入同結果（有測試） |
| P2 | 核心與外掛分離 | 輸入格式（readers）、命名規則（profile）、比對（compare）都可拔除 |
| P3 | 依賴單向 | 外掛讀核心；核心不讀外掛；比對只透過查詢介面讀基準 |
| P4 | 每筆事實帶來源 | 事實帶「區塊、行號」；畫面可開啟原文並標示該行 |
| P5 | 不靜默失敗 | 無法辨識的內容、辨識成功卻解析不出東西的段落，都列入 I01 |
| P6 | 核心不碰畫面與儲存 | 核心可在 Node 執行（測試即如此） |

## 3. 模組

```
        ┌──────────── 外掛（可拔除）─────────────┐
        │ readers/   bundle-v1、files-v1         │
        │ profile/   命名規則引擎＋profiles/*.js  │
        │ compare/   預期資料比對（獨立格式）      │
        └──────┬────────────┬──────────┬────────┘
               ▼            ▼          ▼ 只讀
        ┌──────────────────── 核心 ─────────────────────┐
        │ adapters/  辨識＋解析 → 事實（fact）             │
        │ model/     build.js 事實→實體；infer.js 推論     │
        │ check/     一致性檢查、覆蓋率                     │
        │ core/      keys.js 唯一鍵、ip.js、ns.js           │
        │ pipeline.js  ①讀取→②辨識→③解析→④建模→⑤推論→⑥檢查 │
        │ query/     唯讀查詢、路由追蹤                     │
        └──────────────────────┬──────────────────────────┘
                               ▼
                           Snapshot（純 JSON）
                               ▼
              view/（單一畫面：檢查結果｜拓樸圖｜詳細資料）
```

所有檔案都是一般 `<script>`，以 `globalThis.SSOT` 命名空間串接；載入順序定義在 `tools/core-files.js`，測試會檢查 `index.html` 與它一致。這樣 `index.html` 可以直接雙擊開啟（瀏覽器在 `file://` 下不允許 ES module 與 Web Worker）。

## 4. 輸入

```
原始輸入 ─Reader─▶ Block[] ─辨識─▶ Block＋adapter ─Adapter─▶ Fact[]
```

- **Block**：`{ device, mgmtIp, command, lines, origin:{file,startLine,endLine} }`
- **Reader**：`bundle-v1`（設備標頭＋`_____`）、`files-v1`（檔名＝設備名）。介面：`accepts(text,file)`、`read(text,file)`。
- **指令標記**：`### 指令`、RouterOS 提示字元 `[user@id] > /指令`（須為絕對路徑）。有標記時依指令選 adapter，否則依內容判斷。
- 所有 `print` 指令都要用 `detail without-paging`（key=value 格式）。詳見 `docs/collection.md`。

### Adapter（10 個，`src/adapters/mikrotik.js`）

| ID | 指令 | 事實 |
|---|---|---|
| mikrotik.neighbor | /ip neighbor print detail | 鄰居（identity、對端埠、型號、功能）；續行、bridge 重複列、多協定重複列已處理 |
| mikrotik.config | /export terse／compact | 主機名、介面註解／停用、bridge＋pvid、bridge VLAN、VLAN 子介面、bonding、IP、router-id（含 `/routing id` 名稱解析） |
| mikrotik.bridgehost | /interface bridge host print detail | MAC 位置（略過 bridge 自己的 MAC） |
| mikrotik.vlans | /interface bridge vlan print detail | 實際 VLAN 成員（`current-*`，含動態） |
| mikrotik.interface | /interface print detail | running／停用／註解／聚合 |
| mikrotik.ipaddr | /ip address print detail | 介面 IP（略過 disabled、invalid） |
| mikrotik.arp | /ip arp print detail | MAC↔IP（略過 invalid、多播、APIPA） |
| mikrotik.route | /ip route print detail | 作用中路由、ECMP（`gateway=a,b`）；RouterOS 6／7 旗標差異已處理 |
| mikrotik.ospf | /routing ospf neighbor print detail | OSPF 鄰居（沒有 interface 時，用鄰居位址落在哪個本機網段決定） |
| mikrotik.system | /system resource print | 型號、版本 |

**detail 輸出的解析**：以「列」為單位。列首是 `序號 旗標 key=value…`（序號、旗標可省略）；直接以 key=value 開頭的行是終端機換行的續行，併入上一列；`;;; 註解` 屬於它所在或下一列。
新增廠牌：新增一支 `adapters/<vendor>.js` 呼叫 `S.adapters.register()`，其他部分不需修改。

## 5. 模型

### 5.1 唯一鍵（`core/keys.js`，與命名規則無關）

| 鍵 | 規則 |
|---|---|
| 設備 `dev` | 去空白、轉大寫 |
| 介面 `ifc` | 去空白、轉小寫 |
| 端點 `ep` | `DEV|ifc` |
| MAC | 12 碼大寫 |
| 連結 | 兩端 ep 排序後以 `~` 串接 |

### 5.2 實體（Snapshot.model）

| 實體 | 主要欄位 |
|---|---|
| devices | key、name、names、mgmtIp、vendor、kind、kindBasis、collected、data、group、role、seenBy |
| interfaces | key、dev、name、desc、admin、status、type、parent、members、mode、ips、vlans、macs、hearsay、edge |
| links | key、a、b、layer（L2）、via（lldp/mndp）、protocols、evidenceScope、observations、verified、hearsay、cls、vlansA／B／Common、vlanMismatch |
| ospfAdjacencies | dev、localEp、peerDev、peerEp、peerIp、peerId、reciprocal、src |
| vlans | dev、id、name、desc、l3、members |
| macs | mac、vendor（OUI）、ips、seen（`{ ep, vlan }` 清單）、edge（位置）、src |
| arps、routes | 原始對應與路由（含下一跳）、src |

每個由輸入事實產生的實體都帶 `src`（`[區塊, 行號]` 清單）。`src` 為空時，設備、介面、VLAN 另帶 `srcNone` 說明原因：`seen-only`（只由鄰居看到的設備）、`hearsay`（聽說的介面）、`implicit`（預設 VLAN）；有來源時為 `null`。`unrecorded` 代表應有來源卻漏記，測試禁止出現；已收集設備上的介面（含由 MAC 表隱式建立的）一定有來源。

### 5.3 關鍵推論

- **鄰居邊語意**：LLDP／CDP 的觀察走介面鄰接推論；本機介面名稱是本機端依據，對端回報的 `interface-name` 是對端埠證據，無法配對時的平行埠排序配對仍屬推測。只有 MNDP 證據時，edge 表示兩台設備在同一 L2 broadcast domain 可達，不表示兩者直連，也不將回報的對端埠名視為實際配對埠；不套用直連專用的 K01／K02／K03／V01 檢查。`evidenceScope` 使用 `interface-adjacency`、`broadcast-domain` 或 `routing-adjacency`；`observations` 保留觀察介面及來源行。MNDP 沒有 domain ID，因此模型不宣稱完整網域成員清單。
- **自動群組名稱**：未套用 profile 分群的設備依拓樸連結分成連通元件，標為「自動群組 N」。這是版面分群提示，不是依 IP prefix 推導的子網名稱，也不表示群內設備都以實體線路直接相連；純 MNDP 證據同樣可能使設備位於同一群組。
- **鄰居配對**：LLDP／CDP 對端也有可配對的鄰居資料時雙向配對（`verified`）；對端有鄰居輸出但未回報此介面鄰接為單向（K01）；對端沒提供鄰居資料則為聽說（hearsay，只計入覆蓋率）。鄰居 identity 對不上收集檔設備名時，用管理 IP 對回同一台。
- **OSPF 鄰接**：OSPF 是 IP 層鄰接證據，不加入 `links`，不作為拓樸直連 edge，也不與相同端點的 L2 edge 合併。單獨存於 `ospfAdjacencies`，設備詳細資料列出本機介面、鄰居、雙向回報狀態與來源。鄰居位址 → 擁有該 IP 的介面；找不到再用 router-id、管理 IP；都找不到建立以鄰居 ID 命名的未知設備（R02）。
- **設備類型**：型號（CRS／CSS→交換器；CCR／RB／hAP／hEX／CHR→路由器）→ 已收集設備依資料（有 OSPF→路由器；有 MAC 表且無路由→交換器）→ 未收集設備依鄰居回報的功能（router／bridge／station）→ 對端埠名像網卡→主機。命名規則可覆寫並標示依據。
- **末端埠**：有學到 MAC、沒有連到其他已收集網路設備的介面；MAC 的「位置」即其末端埠。

## 6. 命名規則（profile）

獨立 JSON，可不套用；只能做別名／去網域（建模前）與註解（建模後）。詳見 `docs/profile.md`。

## 7. 一致性檢查

| ID | 類別 | 檢查 | 嚴重度 |
|---|---|---|---|
| I01 | 輸入 | 無法辨識的內容（含辨識成功卻解析不出內容，例如沒加 detail） | 錯誤 |
| I02 | 輸入 | 同一設備重複提供同類資料（採用最後一次） | 警告 |
| C01 | 覆蓋 | 網路設備只被其他設備看到、沒有收集資料（主機不列） | 提醒 |
| C02 | 覆蓋 | 缺少應收集的資料（依類型：交換器要 鄰居＋export＋MAC 表，路由器要 鄰居＋export＋路由表） | 警告 |
| K01 | 連結 | LLDP 單向 | 警告 |
| K02 | 連結 | 同一介面對到多個鄰居 | 錯誤 |
| K03 | 連結 | 聚合兩端成員數不同，或成員連到非聚合埠 | 警告 |
| K04 | 連結 | 對端回報的埠名稱與本機不同 | 提醒 |
| V01 | VLAN | 連結兩端 VLAN 不一致（含聚合繼承） | 警告 |
| A01 | 位址 | 同一 IP 對應多個 MAC | 警告 |
| A02 | 位址 | 同一 MAC 出現在多個末端埠 | 警告 |
| A03 | 位址 | 介面有 MAC 但沒有任何 LLDP 鄰居（未知對端，依設備彙總；同時畫在圖上，見第 12 節） | 提醒 |
| R01 | 路由 | 下一跳不屬於任何已知設備 | 提醒 |
| R02 | 路由 | OSPF 鄰居無法對應到已收集設備 | 提醒 |

（VLAN 名稱相關的兩項檢查已移除：RouterOS 的 bridge VLAN 沒有名稱。）

每筆：`{ id, severity, title, message, entities:[{type,key}], evidence:[{block,line,text,file}] }`。

## 8. 比對（獨立模組）

`SSOT.compare(SSOT.query(snapshot), expected) → DiffReport`

- 預期資料格式 `ssot-expected/1`（設備、連結、VLAN），用「設備名」「設備名 介面名」指向實體，不共用 Snapshot 結構。
- 只透過查詢介面讀取；測試確認比對前後 Snapshot 完全相同。
- 結果分 ok／missing／different／unexpected（`strictDevices`、`strictLinks` 開啟時才列多出）。

## 9. 規模

實測（Node，產生的 1041 台已收集設備、3921 個節點、5920 條連結、約 1 萬個 MAC、約 1400 萬字元輸入）：建立約 3.7 秒、乾淨網路零誤報。

| 問題 | 做法 |
|---|---|
| 解析卡畫面 | 分段執行並顯示進度（`buildAsync`）；`file://` 不能用 Web Worker，故不採用 |
| 物理模擬太慢 | 預設不跑；分群＋分層配置一次算完；「自動排開」為選用的格網加速力導向 |
| 整張網路連成一片 | 沒有命名規則時，以標籤傳播依連線密度自動切出「區域」分區排列（只影響畫面，不寫回基準） |
| 主機把層拉得很寬 | 只連到一台設備的未收集末端，排在該設備正下方的小方陣 |
| 節點太多 | 主機超過 300 個時預設隱藏；只畫畫面內物件；縮小時不畫標籤與埠名 |
| 儲存空間 | IndexedDB，不用 localStorage，不自動過期 |

## 10. 與 v0.1 草案的差異

| 項目 | v0.1 | 實作 | 原因 |
|---|---|---|---|
| 背景執行 | Web Worker | 主執行緒分段＋進度 | `file://` 不允許 Worker；實測 1000 台約 3 秒可接受 |
| 圖形函式庫 | vis-network | 自寫 Canvas | 去除外部相依、可離線；1000 台以上效能可控 |
| Adapter | 7 個 | 12 個 | 補上路由、ARP、介面設定，路由追蹤與 OSPF 對應才有資料 |
| 檢查 | 13 項 | 16 項 | 新增 K04、V03、R02 |
| 比對 | 第 7 階段 | 最小可用版 | 先把邊界（獨立格式、唯讀）做實 |
| C01 | 所有未收集設備 | 排除主機 | 1000 台時主機數千個，會淹沒真正的覆蓋缺口 |

## 11. 尚未做

- 匯出（JSON、CSV、Excel）：Snapshot 已是純 JSON，日後只是轉換。目前只有「存成圖片」。
- 其他廠牌（Cisco、Arista、Juniper、Fortinet：見多廠牌版 topo-ssot）。
- RouterOS 的防火牆規則、無線、CAPsMAN、VPN、`/interface bridge port` 的 STP／邊緣埠資訊。
- 多份基準之間的變更比對（diff）。

## 12. 未知對端（2.1.0 新增）

**要解決的問題**：接取交換器下面接了幾十台沒有 LLDP 的設備（PC、印表機、IoT），只看 LLDP 的拓樸會顯示成「這台交換器只有上行」，實際上它下面有一大片沒被看見的東西。舊版工具會在這種埠畫出虛擬節點；這一版保留這個意圖，但改成不污染基準。

**判定（核心，寫進基準）**：`interfaces[].unknownPeer = true`，條件是同時成立
1. 設備是已收集的；介面有學到 MAC，狀態不是 down，不是 irb／vlan／lo
2. 該介面（含所屬聚合與聚合成員）沒有任何 LLDP 連結

有 LLDP 鄰居的伺服器埠、上行聚合埠都不算。查詢介面：`Q.unknownDevices()`、`Q.unknownPeers(設備)`（每埠附 MAC、ARP 的 IP、OUI 廠商、VLAN）。

**畫面（檢視層，不寫進基準）**：基準的設備、連結、檢查結果完全不變（有測試），虛擬節點只存在於畫面。所有顏色、線型與透明度集中在 `src/view/theme.js`，Canvas 繪圖與圖例都讀它（圖例分「設備／連線／連線註記／末端」四類，預設收合，說明文字放提示；外形、連線色、線寬、虛線與弱證據透明度由 theme 產生，有測試比對）；CSS 的設備類型變數與它的一致性也有測試。拓樸圖中純 MNDP 網域可達邊以 50% 不透明度虛線顯示；選取或 hover 高亮時維持完整不透明度。

| 情況 | 畫法 |
|---|---|
| 一個埠一個 MAC | 圓點，顏色依廠商（避開紅橘黃，以免和錯誤標記混淆），標 IP；近看顯示廠商縮寫 |
| 一個埠多個 MAC | 菱形，標 MAC 數（疑似下游還有交換器、AP 或虛擬化主機） |
| 介面 `type=veth`（容器虛擬網卡） | 連到該末端的連線用固定洋紅色（`#d81b60`），節點外觀不變；提示與介面詳細標「容器 veth」 |
| 介面 `type=wifi`／`wlan`（Wi-Fi，模型統一為 `wifi`） | 連到該末端的連線用固定青色（`#00b8d4`），節點外觀不變；提示與介面詳細標「Wi-Fi」 |

依介面 type 的識別色定義於 `theme.js` 的 `endpoint.byType`，只識別連線（收合成「末端 ×N」群組時連線維持預設色），僅視覺識別，不改變判定與檢查。
| 同一台設備超過 8 個，或全網超過 800 個 | 收合成一個「末端 ×N」群組；雙擊或在右側按「在圖上展開」 |

- 點節點或群組：右側顯示每個埠的 MAC、IP、廠商、VLAN；點一列跳到該介面。設備頁也有同樣的清單。
- 搜尋 MAC／IP 時，圖上會標出它所在的那個末端；點檢查結果 A03 會顯示該設備的末端清單。
- 左右欄邊緣可拖曳調整寬度（最小 240px，中間圖面至少 320px；雙擊還原），寬度存在獨立的 `layout` 鍵，只屬檢視狀態，不進基準。
- 工具列「未知對端」可整個關閉。位置會跟著其他節點一起保存。
- 1000 台實測：880 台設備各收成一個群組（全網超過上限），展開一台約 0.4 秒。

**刻意沒做**：「介面 up 但沒有學到任何 MAC」（閒置埠）。要可靠判斷需要 `show interfaces terse` 的狀態，不在必要收集清單內。

## 13. 與多廠牌版（Juniper＋Fortinet）的差異

| 項目 | 多廠牌版 | MikroTik 版 |
|---|---|---|
| 解析器 | 12 個（Junos 8、FortiOS 4） | 10 個（RouterOS） |
| 輸出格式 | 各廠牌不同（表格、display set、config 區塊） | 一律 `detail`（key=value）＋ export |
| 介面名稱 | 去掉 Junos 的 `.0` | 不處理（RouterOS 沒有這個慣例） |
| 鄰居對端埠 | LLDP 表格的 Port info | `interface-name`；沒有時用順序配對 |
| VLAN | 名稱＋ID | 只有 ID（無名稱）；只在 `vlan-filtering=yes` 的 bridge 才有意義 |
| 檢查 | 16 項 | 14 項（移除 V02、V03） |
| 設備類型 | 廠牌＋資料 | 型號＋資料＋鄰居回報的功能 |
| 新增的處理 | — | 鄰居 identity 對不上收集檔設備名時用管理 IP；OSPF 沒有 interface 時用網段解析；未知埠名時的連結配對 |
| 瀏覽器儲存 | `topo-ssot` | `topo-mikrotik`（兩版可並存） |

## 版本紀錄

- **1.0.0（MikroTik 版）**：由 topo-ssot 2.1.0 改寫。
