# RouterOS 網路基準（topo-mikrotik）

由 **MikroTik RouterOS** 的 CLI 輸出，一次建立網路現況基準（Single Source of Truth）：拓樸、介面、VLAN、MAC／IP 位置、路由，並列出資料之間的矛盾與缺漏。

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

- 點任一筆，圖上會定位並標紅。沒有發現的規則列在下方，分成「通過」與「沒有資料可檢查」（預設收合）。
- 「清單」分設備、介面、IP、網段、MAC、VLAN 六份完整清單，可文字篩選；IP 已去重複，MAC 清單可篩「缺 IP」。
  - 網段是由設備自有介面位址推導的直連網段，列出設定的設備／介面與落在網段內的 IP 數。
  - 設備清單另有「終端」分類：一般非 Wi-Fi 介面須恰好學到一個 MAC，且沒有 LLDP／CDP 介面鄰接。
  - Wi-Fi 介面本身不算終端介面，但每個 Wi-Fi MAC 觀察位置仍列入終端清單，且不參與 A02（MAC 可能因漫遊出現在多個 AP）。
  - 同一 MAC 的一般終端位置只在 VLAN 相同、或兩端皆未記錄 VLAN 時比較。跨設備的同 VLAN ID 不保證屬於同一 L2 廣播網域，所以 A02 是待核實的警告。
  - 純 MNDP 廣播網域可達不算直連鄰接，不計入總覽的設備數。
- 「比對」可載入「預期應該長怎樣」的 JSON（格式 `ssot-expected/1`，範例見 [`samples/expected-sample.json`](samples/expected-sample.json)）與目前基準比對；比對只讀取基準，不會修改它。

**中：拓樸圖**

- 版面預設為「分層（ELK）」：先以快速版面出圖，再於背景用 ELK 做多輪交叉最小化後替換。網路設備超過 1500 台或計算失敗時維持快速版面並提示原因；可在工具列切換「快速（內建）」。
- 只畫 L2 鄰接，同兩台設備間的多條鏈路合併成一條線。
- 只有 MNDP 的設備對不畫線（MNDP 只證明同一 L2 廣播網域可達，不代表直連），但仍列在設備的鄰居表與鏈路詳情。OSPF 鄰接也不作為拓樸 edge。
- 沒有 LLDP 的設備（例如 SwOS 的 CSS106、CSS610）依 MAC 表、點對點網段推定「推論鏈路」，以綠色長虛線表示，點選可看依據與信心。接在這類交換器底下的終端依上一跳的 MAC 表推定位置（埠不明），畫在該交換器下。
- 連線兩端埠名在放大時顯示；滑過連線或節點（及選取連線）時，不受縮放與重疊限制強制顯示。
- 符合終端條件的位置以「未知對端」節點畫在所屬設備下方（可收合、可關閉）。Wi-Fi MAC 觀察位置也保留圖面提示，多 MAC 以菱形呈現。

**右：詳細資料**

- 鄰居（含類別與 LLDP／MNDP／CDP 協定）、OSPF L3 鄰接、介面（埠模式、PVID、untagged／tagged VLAN、所屬聚合／bridge）、VLAN、MAC、路由表。
- 每筆都能開啟原文並標示行號；VLAN、鄰居、OSPF、路由與原始輸出可按需要展開。

窄螢幕可切換「拓樸／檢查／詳細資料」工作區。

### 搜尋與路由追蹤

- 上方搜尋可直接輸入設備名、MAC、IP、VLAN ID 或介面描述。
- **路由追蹤**輸入來源與目的 IP，逐跳顯示（含 ECMP），同時列出回程並標示非對稱路徑，遇到黑洞路由會停下。

### 基準摘要

建立基準後，頂端摘要會顯示檢查規則發現的錯誤／警告與收集缺漏，並提供直接跳到問題、覆蓋率、搜尋或路由追蹤的入口。每項規則的判斷條件與處理建議見 [基準檢查規則](docs/基準檢查規則.md)。

這些是該份 Snapshot 的檢查結果與收集完整度，**不代表即時網路健康狀態**。

### 儲存

基準會儲存在這個瀏覽器（IndexedDB），下次開啟自動還原；程式更新後若基準格式不同，會用儲存的輸入重新建立。按「清除」只清除本工具的資料。

### SSH 批次收集（選用）

在 WSL／Linux 可用 [`tools/collect.sh`](tools/collect.sh) 透過 SSH 收集多台設備。先複製
[`tools/devices.csv`](tools/devices.csv) 為自己的設備清單，並把範例的文件保留 IP
（`192.0.2.0/24`）改為實際位址：

```bash
cp tools/devices.csv devices.csv
```

設備清單第一列必須是 `name,address,user,port`，可再加選填的第五欄 `extra`；`name` 應唯一，且建議與設備的
`/system identity` 相同。`port` 可留空，預設為 `22`。Wi-Fi AP 或 CAPsMAN 控制器可在 `extra` 填 `wifi`、`wireless`
或 `capsman`，只對這些設備加收 Wi-Fi 關聯表（判斷客戶端連在哪台 AP），見 [收集清單](docs/收集清單與輸入格式.md)。

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
  check/              一致性檢查、覆蓋率
  profile/            命名規則引擎
  pipeline.js         建立基準
  query/              唯讀查詢、路由追蹤
  compare/            預期資料比對（獨立格式）
  data/               OUI 廠商資料（離線）
  view/               畫面：dom、theme（顏色／線型／透明度的唯一來源）、store（IndexedDB）、graph（版面、ELK 分層版面＋Canvas）、panels、app
vendor/               第三方函式庫（elkjs，EPL-2.0；第一次需要分層版面時才由畫面層載入）
profiles/             命名規則範例（可不套用）
samples/              範例收集檔（含刻意放入的問題）、預期資料範例
tools/                SSH 收集器、去識別化、產生測試資料、更新 OUI、嵌入範例
tests/                核心、文件、收集器、畫面冒煙測試；golden/ 黃金基準；fixtures/ 手冊與真實設備輸出
docs/                 設計說明、檢查規則、收集清單、命名規則、多層架構圖規格
```

處理流程：reader 切成區塊（保留檔案與行號）→ adapter 解析為事實 → model 建立實體 → 推論 → 檢查 → Snapshot（`ssot-snapshot/2`）。畫面與比對只透過 `SSOT.query()` 唯讀存取 Snapshot。細節見 [docs/設計說明.md](docs/設計說明.md)。

## 開發

只需要 Node.js（CI 使用 Node 22／24），不需安裝任何套件，也沒有 build 步驟：

```bash
npm test                 # 全部：核心、文件、SSH 收集器、畫面冒煙測試
npm run test:core        # 只跑核心測試
npm run test:docs        # 只跑文件與分工一致性
npm run test:collector   # 只跑 SSH 收集器測試（需要 bash）
npm run test:ui          # 只跑畫面冒煙測試（模擬 DOM）
npm run test:large       # 加上約 1000 台的壓力測試
npm run golden:update    # 刻意改變 Snapshot 後更新黃金基準，提交前用 git diff 檢視
npm run sample           # 重新產生範例收集檔並嵌入畫面
npm run gen:large        # 產生約 1000 台的收集檔（samples/large-1000.txt，不提交）
npm run oui -- <index.json>      # 更新 OUI 廠商資料（步驟見下方）
```

### 擴充

- 新增廠牌：在 `src/adapters/` 新增檔案並 `S.adapters.register()`，加到 `tools/core-files.js` 與 `index.html`（兩邊載入順序必須一致，有測試檢查）。
- 新增輸入格式：在 `src/readers/` 新增 reader 並放進 `readers/index.js` 的 `ORDER`。
- 新增檢查：在 `src/check/checks.js` 的 `CATALOG` 加一筆並實作，同步更新 [docs/基準檢查規則.md](docs/基準檢查規則.md)（有測試檢查兩者一致）；在範例資料放一個對應的問題並加測試。
- 所有程式都是一般 `<script>`，掛在全域 `SSOT` 上，好讓 `file://` 直接開啟；不要改成 ES module 或引入 bundler。

### 用真實設備輸出驗證解析器

解析器目前只用依手冊撰寫與程式產生的資料測試過。若你有實機輸出，可以去識別化後放進 `tests/fixtures/real/` 當回歸測試：

```bash
node tools/anonymize.js 收集檔.txt -o tests/fixtures/real/<RouterOS版本>-<設備型號>.txt
```

MAC 保留廠商前綴、IP 與名稱換成一致的代號、密碼與序號換成 `REDACTED`。產生的 `*.map.json` 對照表不要提交；提交前請再人工檢查一次。詳見 [tests/fixtures/real/README.md](tests/fixtures/real/README.md)。

### 更新 OUI 廠商資料

MAC 前綴 → 廠商的資料來源是 npm 套件 [`oui-data`](https://www.npmjs.com/package/oui-data)（BSD-2-Clause，資料取自 IEEE）。在暫存目錄執行 `npm pack oui-data@<版本>` 並解開，再執行 `npm run oui -- <解開目錄>/package/index.json`。產生器會從同目錄的 `package.json` 讀出版本，寫進 `src/data/oui-data.js` 的檔頭與 `S.oui.source()`；收錄 6／7／9 碼前綴，查詢時取最長符合者。這是開發時的步驟，網頁執行時不連網。

### CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) 在 PR 時以 Node 22／24 執行 `npm test`（只 push 到分支不會觸發，需要時可在 Actions 頁手動執行）；壓力測試（`npm run test:large`）只在每週排程與手動觸發時執行。main 上的部署前由 [deploy-pages.yml](.github/workflows/deploy-pages.yml) 跑 `npm test` 後部署到 GitHub Pages。提交前仍請先在本機執行 `npm test`。

### 相關文件

- [設計說明](docs/設計說明.md)：設計取捨、Snapshot 欄位
- [基準檢查規則](docs/基準檢查規則.md)：每項檢查的判斷條件與處理建議
- [收集清單與輸入格式](docs/收集清單與輸入格式.md)：收集指令、`bundle-v1`／`files-v1` 格式、支援範圍
- [命名規則](docs/命名規則.md)：命名 profile
- [CLAUDE.md](CLAUDE.md)、[.github/copilot-instructions.md](.github/copilot-instructions.md)：開發原則與 AI 協作分工

## 注意

- 這是 topo-ssot 的 **MikroTik 專用版**，與多廠牌版並存時互不影響（瀏覽器儲存名稱不同）。
- 解析器依 RouterOS 文件與慣例撰寫，測試資料由程式產生，**尚未用真實設備輸出驗證**。RouterOS 7 為主，6.43 以上大致可用。
- 支援範圍與限制見 [docs/收集清單與輸入格式.md](docs/收集清單與輸入格式.md) 第 4 節。
