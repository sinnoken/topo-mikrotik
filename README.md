# RouterOS 網路基準（topo-mikrotik）

由 **MikroTik RouterOS** 的 CLI 輸出，一次建立網路現況基準（Single Source of Truth）：拓樸、介面、VLAN、MAC／IP 位置、路由、防火牆規則，並列出資料之間的矛盾與缺漏。

- 純前端、**零相依套件**（不需安裝；分層版面用的 ELK.js 已放在 `vendor/`）、可**完全離線**：直接雙擊 `index.html` 即可使用
- 資料只在瀏覽器內處理，不會傳到任何地方
- 約 1000 台設備一次建立約 3 秒
- 每筆資料都能回溯到原始輸出的檔案與行號；推論結果會標示為推論

## 快速開始

1. 開啟 `index.html`（`file://` 即可，不需伺服器）。`main` 分支也會由 [deploy-pages.yml](.github/workflows/deploy-pages.yml) 部署到 GitHub Pages（<https://sinnoken.github.io/topo-mikrotik/>），一樣只在瀏覽器內處理。
2. 按 **建立基準…** → **載入範例資料**。範例刻意放了幾個問題，可以先看檢查結果長什麼樣子。
3. 要用自己的網路：依 [收集清單](docs/收集清單與輸入格式.md) 收集每台 RouterOS 的輸出（**所有 print 都要加 `detail without-paging`**），合併成一個收集檔後貼上或選擇檔案。多台設備可用 [SSH 批次收集](#ssh-批次收集選用)。

## 使用

### 畫面

畫面分三塊：

**左：檢查結果／覆蓋率／清單／比對**

- 點任一筆，圖上會定位並標紅。沒有發現的規則列在下方，分成「通過」與「沒有資料可檢查」（預設收合）；這些規則也可以展開「常見原因與處理」，看處理建議。
- 每筆旁邊的「確認」可標記為已確認，並可選分類（可接受（設計如此）、已排程修復、誤報，或不分類）與填寫原因；已確認的項目按「修改」可改分類與原因，按「取消確認」移回原本的分組。已確認的項目另列一組，顯示確認時間、分類與原因，不計入上方與頂端摘要的筆數（摘要會註明另有幾項已確認）。確認紀錄只存在這個瀏覽器，不改變基準；按「清除」不會清掉它，之後重新建立同一份網路的基準時仍然有效。舊版只有確認時間的紀錄仍可讀入，視為未分類。
- 檢查結果可切換「依規則」或「依設備」分組；依設備時，不屬於任何設備的檢查結果（例如沒有設備標頭的 I01）排在最後一組。
- 在「比對」分頁載入舊基準後，可按「只看新出現的」，只列出舊基準沒有的檢查結果；沒有按下時，新出現的那幾筆會標「新出現」。沒有載入舊基準（或比對失敗）時這個選項停用；建立或載入新的基準後，要重新載入舊基準。
- 「匯出全部檢查結果」可下載 CSV 或 Markdown 報表，不受上方篩選影響；按下「依設備排序」後，CSV 依設備排序、Markdown 依設備分組。
  - CSV：UTF-8 含 BOM，Excel 可直接開啟；除了檢查結果本身，另有確認時間、分類、原因、所屬設備與處理建議（`action`，照規則目錄原文，指令保留反引號）。常見原因不放進 CSV，因為同一段文字會在每一列重複。欄位見[設計說明 §14](docs/設計說明.md#14-檢視狀態與匯出)。
  - Markdown 依規則分組時，每條規則先列處理建議與逐條的常見原因，指令寫成行內程式碼；依設備分組時，處理建議與常見原因集中在報表最後的「附錄：處理建議與常見原因」，每條規則只列一次。
- 「覆蓋率」列出每台設備收集了哪些資料；「有缺漏」包括缺少應收集的資料與有指令收集失敗的設備，失敗的指令與原因可點開原文。有未收集的網路設備（C01）時，可按「匯出未收集設備的 devices.csv 草稿」，產生 [SSH 批次收集](#ssh-批次收集選用)用的設備清單：`user` 欄是佔位值 `CHANGE_ME`，使用前要改成實際的帳號；沒有位址或名稱不合規則等不能直接使用的設備寫成註解列，修正後移除開頭的 `#`。
- 「清單」分設備、介面、IP、網段、MAC、VLAN 六份完整清單，可文字篩選；IP 已去重複，MAC 清單可篩「缺 IP」。
  - 網段是由設備自有介面位址推導的直連網段，列出設定的設備／介面與落在網段內的 IP 數。
  - 設備清單另有「終端」分類：一般非 Wi-Fi 介面須恰好學到一個 MAC，且沒有 LLDP／CDP 介面鄰接。
  - Wi-Fi 介面本身不算終端介面，但每個 Wi-Fi MAC 觀察位置仍列入終端清單，且不參與 A02（MAC 可能因漫遊出現在多個 AP）。
  - 同一 MAC 的一般終端位置只在 VLAN 相同、或兩端皆未記錄 VLAN 時比較；同一個 VLAN ID 分成多個不相連區塊時（例如各站點重用），只比較同一塊內的位置。區塊是依鏈路證據的推論，所以 A02 是待核實的警告。
  - 純 MNDP 廣播網域可達不算直連鄰接，不計入總覽的設備數。
- 「比對」可載入「預期應該長怎樣」的 JSON（格式 `ssot-expected/1`，範例見 [`samples/expected-sample.json`](samples/expected-sample.json)）與目前基準比對；「匯出預期資料」由目前的基準產生這種檔案，之後可拿來和新的基準比對。
- 「與舊基準比對」可載入之前用「匯出 JSON」存下的基準，依設備、鏈路、VLAN、IP、防火牆、檢查結果分組列出新增、移除與變更；防火牆規則讓 WAN 多出可連入點的標示為「新暴露」，可單獨篩選。比對結果上方的「修復追蹤」列出確認時分類為「已排程修復」的檢查結果，分成「已修復」（新基準已經沒有）、「仍存在」與「變更」（兩份都有、但訊息不同）；按「清掉已修復的確認」可清除已修復那些項目的確認紀錄。比對結果不會儲存，兩種比對都只讀取基準，不會修改它。

**中：拓樸圖**

- 版面預設為「分層（ELK）」：先以快速版面出圖，再於背景用 ELK 做多輪交叉最小化後替換。網路設備超過 1500 台或計算失敗時維持快速版面並提示原因；可在工具列切換「快速（內建）」。
- 只畫 L2 鄰接，同兩台設備間的多條鏈路合併成一條線。
- 只有 MNDP 的設備對不畫線（MNDP 只證明同一 L2 廣播網域可達，不代表直連），但仍列在設備的鄰居表與鏈路詳情。OSPF 鄰接也不作為拓樸 edge。
- 沒有 LLDP 的設備（例如 SwOS 的 CSS106、CSS610）依 MAC 表、點對點網段推定「推論鏈路」，以綠色長虛線表示，點選可看依據與信心。接在這類交換器底下的終端依上一跳的 MAC 表推定位置（埠不明），畫在該交換器下。
- 連線兩端埠名在放大時顯示；滑過連線或節點（及選取連線）時，不受縮放與重疊限制強制顯示。
- 符合終端條件的位置以「未知對端」節點畫在所屬設備下方（可收合、可關閉）。Wi-Fi MAC 觀察位置也保留圖面提示，多 MAC 以菱形呈現。

**右：詳細資料**

- 鄰居（含類別與 LLDP／MNDP／CDP 協定）、OSPF L3 鄰接、介面（埠模式、PVID、untagged／tagged VLAN、所屬聚合／bridge）、VLAN、MAC、路由表。
- 設備的「收集到的原始輸出」列出每個指令的收集時間（UTC，收集器記錄的）與收集失敗；有失敗時預設展開。
- **防火牆**：設備詳情的「防火牆」摘要規則數、有問題的規則數與 WAN 判斷狀態（「已找到 WAN 介面（推論）」「沒有 WAN interface list（推論）」或「WAN interface list 沒有成員（推論）」，和防火牆畫面用同一份用語）；點「查看防火牆規則與服務」進入防火牆畫面，依位址族、表、chain 列出規則與相關的檢查結果，另列 WAN／LAN 判斷（推論）、`/ip service` 與 interface list。點選 F01–F07 的檢查結果時，會直接開啟防火牆畫面並定位到那條規則或服務。
- **修正範例**：防火牆畫面的「修正範例（停用規則）」為 F01、F02、F03、F06 指向的規則產生停用指令，附驗證與回復指令，可按「複製」。指令以 comment 或規則的比對條件 `find`，不用規則編號；`find` 可能符合同一個 chain 的多條規則時會警告，執行前請先用驗證指令確認只列出一條。這只是文字範例，本工具不會連線或寫回設備。規則見[設計說明 §14](docs/設計說明.md#14-檢視狀態與匯出)。
- 跨設備一致性的檢查結果，詳情會列出「依多數決推定偏離」的設備（推論）。
- 詳情裡的每筆檢查結果都有預設收合的「常見原因與處理」，內容取自規則目錄，與[基準檢查規則](docs/基準檢查規則.md)各章的「常見原因」「處理」一致；RouterOS 指令與欄位以等寬字型顯示。
- 點 A03（未知對端）會開啟該設備的終端 MAC 位置畫面，終端埠清單前面列出這台設備的 A03 與它的常見原因與處理。
- 每筆都能開啟原文並標示行號；VLAN、鄰居、OSPF、路由與原始輸出可按需要展開。

窄螢幕可切換「拓樸／檢查／詳細資料」工作區。

### 搜尋與路由追蹤

- 上方搜尋可直接輸入設備名、MAC、IP、VLAN ID 或介面描述。
- 選取 VLAN 時，若同一個 VLAN ID 在幾群彼此沒有承載此 VLAN 鏈路相連的設備中出現（例如各站點重用 VLAN ID），詳情會列出這些「不相連區塊」，可只看其中一塊。區塊是依鏈路證據的推論。
- **路由追蹤**輸入來源與目的 IP，逐跳顯示（含 ECMP），同時列出回程並標示非對稱路徑，遇到黑洞路由會停下。

### 基準摘要

建立基準後，頂端摘要會顯示檢查規則發現的錯誤／警告（不含已確認的項目）與收集缺漏（含收集失敗），並提供直接跳到問題、覆蓋率、搜尋或路由追蹤的入口。每項規則的判斷條件與處理建議見 [基準檢查規則](docs/基準檢查規則.md)。

這些是該份 Snapshot 的檢查結果與收集完整度，**不代表即時網路健康狀態**。

### 儲存

基準會儲存在這個瀏覽器（IndexedDB），下次開啟自動還原；程式更新後若基準格式不同，會用儲存的輸入重新建立。按「清除」只清除本工具儲存的基準與輸入；已確認的檢查結果、版面寬度等檢視設定不受影響。

工具列的「匯出 JSON」下載目前的基準（Snapshot 原樣，不改寫），可留作之後「與舊基準比對」的舊基準；「匯出 PNG」下載目前的拓樸圖畫面。

### SSH 批次收集（選用）

在 WSL／Linux 可用 [`tools/collect.sh`](tools/collect.sh) 透過 SSH 收集多台設備。先複製
[`tools/devices.csv`](tools/devices.csv) 為自己的設備清單，並把範例的文件保留 IP
（`192.0.2.0/24`）改為實際位址：

```bash
cp tools/devices.csv devices.csv
```

設備清單第一列必須是 `name,address,user,port`，可再加選填的第五欄 `extra`；`name` 應唯一，且建議與設備的
`/system identity` 相同。`port` 可留空，預設為 `22`。Wi-Fi AP 或 CAPsMAN 控制器可在 `extra` 填 `wifi`、`wireless`
或 `capsman`，只對這些設備加收 Wi-Fi 關聯表（判斷客戶端連在哪台 AP）。`extra` 留空、也沒有用 `--commands` 時，收集器會依 `/interface print` 的介面 type 自動加上 `wifi`（`type=wifi`，需 RouterOS 7.13 以上）或 `wireless`（`type=wlan`），終端機標示 `AUTO` 與依據；不要自動判斷時加 `--no-auto`。詳見 [收集清單 §0](docs/收集清單與輸入格式.md#0-批次-ssh-收集器wsllinux)。

先驗證設備清單與將執行的唯讀命令，不建立連線：

```bash
./tools/collect.sh devices.csv --dry-run
```

收集全部支援資料並產生可直接載入的 `bundle-v1` 檔：

```bash
./tools/collect.sh devices.csv --output collection.txt
```

若只需要基本 L2 拓樸，可限縮為設定、鄰居、MAC 表與系統資訊：

```bash
./tools/collect.sh devices.csv \
  --commands config,neighbor,bridgehost,system \
  --output topology.txt
```

- 收集器預設使用既有 SSH key 或 ssh-agent，並保留系統的 host-key 驗證；不要略過 host-key 檢查。
- 不要在 CSV 放入密碼或私鑰。RouterOS 6.x 設備的收集檔會含密碼與金鑰（收集器不加 `hide-sensitive`）；收集檔請自行保管，分享或當測試資料前先去識別化，見[收集清單的「安全」](docs/收集清單與輸入格式.md#1-每台設備要收集的指令)。
- 沒有設定 SSH key 時，可加 `--ask-password`：每台設備互動連線一次（輸入密碼、確認 host key），其餘命令共用該連線；密碼不會寫入任何檔案。
- 每次執行都會覆蓋輸出檔，要保留舊結果請用 `-o` 指定其他檔名。
- 收集檔會記錄每個指令的收集時間與失敗原因；有指令失敗時收集器以非零 exit code 結束，建立基準後失敗也會列在 C02 與覆蓋率。

有指令失敗時，可以只重收失敗的部分，產生合併好的新收集檔（必須用 `-o` 指定新檔，上次的收集檔不會被修改）：

```bash
./tools/collect.sh devices.csv --retry-failed collection.txt -o collection-retry.txt
```

失敗的區塊換成這次的結果，其他內容逐字保留，所以建立基準時只要讀入新檔，不必連同舊檔一起讀入，也不會出現 I02。先加 `--dry-run` 可列出會重收的指令與上次失敗的原因。可搭配的選項、結束碼與限制見[收集清單 §0「只重收失敗的指令」](docs/收集清單與輸入格式.md#只重收失敗的指令)。

完整收集清單、輸入格式與所有可用的命令 ID 見 [`docs/收集清單與輸入格式.md`](docs/收集清單與輸入格式.md)。

## 專案結構

```
index.html            單一畫面（載入順序：核心 → 命名規則 → 範例 → 畫面）
assets/app.css
src/
  core/               命名空間、IP 工具、唯一鍵
  readers/            輸入格式：bundle-v1、files-v1
  adapters/           mikrotik.js（13 個）
  model/              build.js（事實→實體）、infer.js（推論）
  check/              catalog.js（規則目錄：標題、嚴重度、常見原因與處理）、checks.js（一致性檢查、覆蓋率）
  profile/            命名規則引擎
  pipeline.js         建立基準
  query/              唯讀查詢（含防火牆規則）、路由追蹤
  compare/            預期資料比對、由基準產生預期資料（expectedFrom）、新舊基準比對（snapshots）
  data/               OUI 廠商資料（離線）
  view/               畫面：
    dom.js、theme.js    DOM 小工具；theme 是顏色／線型／透明度的唯一來源
    store.js            儲存（IndexedDB）
    export.js           匯出 JSON、CSV、Markdown、預期資料、devices.csv 草稿
    remediation.js      確認分類、檢查結果所屬設備、防火牆修正範例、devices.csv 草稿、修復追蹤
    graph/              版面、ELK 分層版面、Canvas
    panels/             details（詳細資料）、firewall（防火牆畫面）、lists（左側分頁）、baseline-diff（新舊基準比對）
    app.js              畫面起點（App 狀態、啟動、載入基準），要在其他 app-*.js 之前載入
    app-graph.js、app-select.js、app-panes.js、app-toolbar.js、app-input.js、app-acks.js
                        圖資料與版面排程、選取與原文、左側分頁與欄寬、頁首與工具列（含匯出）、輸入對話框、已確認的檢查結果
vendor/               第三方函式庫（elkjs，EPL-2.0；第一次需要分層版面時才由畫面層載入）
profiles/             命名規則範例（可不套用）
samples/              範例收集檔（含刻意放入的問題）、預期資料範例
tools/                SSH 收集器、去識別化、產生測試資料、更新 OUI、嵌入範例
tests/                核心、文件、收集器、畫面冒煙測試；golden/ 黃金基準；fixtures/ 手冊與真實設備輸出
docs/                 設計說明、檢查規則、收集清單、命名規則、發布前檢查表、多層架構圖規格
```

處理流程：reader 切成區塊（保留檔案與行號）→ adapter 解析為事實 → model 建立實體 → 推論 → 檢查 → Snapshot（`ssot-snapshot/2`）。畫面與比對只透過 `SSOT.query()` 唯讀存取 Snapshot。細節見 [docs/設計說明.md](docs/設計說明.md)。

## 開發

只需要 Node.js（CI 使用 Node 22／24），不需安裝任何套件，也沒有 build 步驟：

```bash
npm test                 # 全部：核心、文件、SSH 收集器、畫面冒煙測試
npm run test:core        # 只跑核心測試（含收集器端到端測試，需要 bash 與 GNU timeout）
npm run test:docs        # 只跑文件與分工一致性
npm run test:collector   # 只跑 SSH 收集器測試（需要 bash 與 GNU timeout）
npm run test:ui          # 只跑畫面冒煙測試（模擬 DOM）
npm run test:large       # 加上約 1000 台的壓力測試
npm run golden:update    # 刻意改變 Snapshot 後更新黃金基準，提交前用 git diff 檢視
npm run sample           # 重新產生範例收集檔並嵌入畫面（核心測試會檢查 samples/ 和產生器一致，不一致時請執行這個）
npm run gen:large        # 產生約 1000 台的收集檔（samples/large-1000.txt，不提交）
npm run oui -- <index.json>      # 更新 OUI 廠商資料（步驟見「更新外部資產」）
git diff --check         # 提交前檢查行尾空白與衝突標記（CI 也會檢查）
```

### 測試

除了逐項功能的測試，核心測試（`tests/run.js`）另有幾類跨元件的檢查：

- **收集器端到端契約**：用假的 `ssh` 實際執行 `tools/collect.sh`，把產生的 `bundle-v1` 交給核心，確認收集時間、失敗原因、設備與指令都讀得出來，收集器註解也不會被列為 I01。需要 `bash` 與 GNU `timeout`（coreutils）；Windows 請安裝 Git Bash 並放在 PATH 前面。缺少時這項測試會明確失敗並說明缺什麼，不會略過。
- **防火牆性質測試**：以固定種子的亂數產生數百組規則，檢查涵蓋判斷的自反、遞移，插入規則不改變其他規則的鍵，在 input 最前面插入 drop 不會增加 F03，不確定的比對不會產生 F01。失敗訊息附上種子與規則，用同一個種子就能重現。
- **比對性質測試**：以範例資料和刻意修改過的版本互相比對，檢查自己比自己沒有差異、A→B 與 B→A 的新增和移除互換、只改 finding 訊息不算差異、新增 WAN 放行標為新暴露。
- **每一行輸入都有被處理**：範例資料與 `tests/fixtures/` 的每個非空行，都要是結構行（設備標頭、指令標記、註解等）、已解析區塊或 I01 區塊的一部分。粒度是區塊：已解析區塊中認不得的行目前測不到，見[設計說明 §4](docs/設計說明.md#4-輸入)。

### 擴充

- 新增廠牌：在 `src/adapters/` 新增檔案並 `S.adapters.register()`，加到 `tools/core-files.js` 與 `index.html`（兩邊載入順序必須一致，有測試檢查）。
- 新增輸入格式：在 `src/readers/` 新增 reader 並放進 `readers/index.js` 的 `ORDER`。
- 新增檢查：在 `src/check/catalog.js` 的 `CATALOG` 加一筆（含常見原因 `causes` 與處理方式 `action`），在 `src/check/checks.js` 實作判斷，同步更新 [docs/基準檢查規則.md](docs/基準檢查規則.md)（有測試檢查兩者一致）；在範例資料放一個對應的問題並加測試。
- 所有程式都是一般 `<script>`，掛在全域 `SSOT` 上，好讓 `file://` 直接開啟；不要改成 ES module 或引入 bundler。

### 用真實設備輸出驗證解析器

解析器目前只用依手冊撰寫與程式產生的資料測試過。若你有實機輸出，可以去識別化後放進 `tests/fixtures/real/` 當回歸測試：

```bash
node tools/anonymize.js 收集檔.txt -o tests/fixtures/real/<RouterOS版本>-<設備型號>.txt
```

MAC 保留廠商前綴、IP 與名稱換成一致的代號、密碼與序號換成 `REDACTED`。產生的 `*.map.json` 對照表不要提交；提交前請再人工檢查一次。詳見 [tests/fixtures/real/README.md](tests/fixtures/real/README.md)。

### 更新外部資產

兩份外部資產都放在 repo 裡，網頁執行時不連網；更新是開發時的步驟。建議每半年檢查一次有沒有新版，或在遇到版面問題、廠商顯示不明時更新。

**ELK.js（分層版面）**

1. 在暫存目錄執行 `npm pack elkjs@<版本>` 並解開，把 `lib/elk.bundled.js` 與 `LICENSE.md` 原樣複製到新的 `vendor/elkjs-<版本>/`，並照舊版寫一份 `README.md`（來源、版本、授權）。授權是 EPL-2.0，`LICENSE.md` 一定要一起放；檔案不要修改。
2. 把 `src/view/graph/elk-layout.js` 的 `ENGINE_SRC` 改成新路徑，刪掉舊的 `vendor/elkjs-<舊版本>/`。
3. 更新文件中寫到版本的地方（[設計說明 §12](docs/設計說明.md#12-未知對端210-新增) 的「版面」、`CLAUDE.md` 的架構段）。
4. 執行 `npm run test:ui`（冒煙測試會實際載入 `ENGINE_SRC` 並排出分層版面）與 `npm test`；再用瀏覽器開啟 `index.html` 載入範例資料，確認分層版面正常。

**OUI 廠商資料**

MAC 前綴 → 廠商的資料來源是 npm 套件 [`oui-data`](https://www.npmjs.com/package/oui-data)（BSD-2-Clause，資料取自 IEEE）。在暫存目錄執行 `npm pack oui-data@<版本>` 並解開，再執行 `npm run oui -- <解開目錄>/package/index.json`。產生器會從同目錄的 `package.json` 讀出版本，寫進 `src/data/oui-data.js` 的檔頭與 `S.oui.source()`；收錄 6／7／9 碼前綴，查詢時取最長符合者。產生後執行 `npm test`，並用 `git diff --stat` 確認只有 `src/data/oui-data.js` 改變。

### CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) 在 PR 時以 Node 22／24 執行 `npm test`（只 push 到分支不會觸發，需要時可在 Actions 頁手動執行）。另一個大型測試 job 在 PR、每週排程與手動觸發時都會執行：以 Node 24 跑 `npm run test:large`（設定 `SSOT_LARGE_MAX_MS: 40000`，CI runner 較慢，只抓明顯退化），再以 `npm run gen:large` 產生的約 1000 台資料跑一次大型冒煙測試（`SMOKE_INPUT=samples/large-1000.txt node tests/ui-smoke.js`）。main 上的部署前由 [deploy-pages.yml](.github/workflows/deploy-pages.yml) 跑 `npm test` 後部署到 GitHub Pages。提交前仍請先在本機執行 `npm test`。

- **行尾空白與衝突標記**：`ci.yml` 跑完 `npm test` 後，以 `git diff --check` 檢查整個 tree。RouterOS 原始輸出（`samples/`、`tests/fixtures/`）與 `vendor/` 的行尾空白是內容的一部分，由 [.gitattributes](.gitattributes) 標為 `-whitespace`，不列入檢查。
- **Pages 只發布畫面需要的檔案**：部署時只複製 git 追蹤的 `index.html`、`assets/`、`src/`、`profiles/`、`samples/`、`vendor/`；`tests/`、`docs/`、`tools/`、`.claude/` 等不上站。部署前會確認 `index.html` 引用的每個檔案，以及 `src/view/graph/elk-layout.js` 的 `ENGINE_SRC`（ELK）都在網站裡，缺少任何一個就停止部署。
- `.gitignore` 排除 `.claude/worktrees/`（Claude Code subagent 的本機 git worktree）。

CI 的畫面測試用模擬 DOM，測不到 Canvas、CSP、`file://` 載入、ELK 動態載入、IndexedDB 與檔案下載；發布前請在真實瀏覽器照 [發布前檢查表](docs/發布前檢查表.md) 手動檢查一次。

### 相關文件

- [設計說明](docs/設計說明.md)：設計取捨、Snapshot 欄位
- [基準檢查規則](docs/基準檢查規則.md)：每項檢查的判斷條件與處理建議
- [收集清單與輸入格式](docs/收集清單與輸入格式.md)：收集指令、`bundle-v1`／`files-v1` 格式、支援範圍
- [命名規則](docs/命名規則.md)：命名 profile
- [發布前檢查表](docs/發布前檢查表.md)：真實瀏覽器的手動檢查項目
- [架構決策](docs/架構決策/README.md)：重要決策的背景、選項與取捨（ADR）
- [CLAUDE.md](CLAUDE.md)、[.github/copilot-instructions.md](.github/copilot-instructions.md)：開發原則與 AI 協作分工

## 注意

- 這是 topo-ssot 的 **MikroTik 專用版**，與多廠牌版並存時互不影響（瀏覽器儲存名稱不同）。
- 解析器依 RouterOS 文件與慣例撰寫，測試資料由程式產生，**尚未用真實設備輸出驗證**。RouterOS 7 為主，6.43 以上大致可用。
- 支援範圍與限制見 [docs/收集清單與輸入格式.md](docs/收集清單與輸入格式.md) 第 4 節。
