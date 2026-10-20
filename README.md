# 網路基準（topo-mikrotik）

由 **MikroTik RouterOS** 的 CLI 輸出，一次建立網路現況基準（Single Source of Truth）：拓樸、介面、VLAN、MAC／IP 位置、路由，並列出資料之間的矛盾與缺漏。

- 純前端、**零相依套件**（不需安裝；分層版面用的 ELK.js 已放在 `vendor/`）、可**完全離線**：直接雙擊 `index.html` 即可使用
- 資料只在瀏覽器內處理，不會傳到任何地方
- 約 1000 台設備一次建立約 3 秒

## 使用

1. 依 [收集清單](docs/collection.md) 收集每台 RouterOS 的輸出（**所有 print 都要加 `detail without-paging`**），合併成一個收集檔
2. 開啟 `index.html` → **建立基準…** → 貼上或選擇檔案（可先按「載入範例資料」試用）
3. 畫面分三塊：
   - **左：檢查結果／覆蓋率／清單／比對**：點任一筆，圖上會定位並標紅；「清單」分設備、介面、IP、網段、MAC、VLAN 六份完整清單（網段是由設備自有介面位址推導的直連網段，列出設定的設備／介面與落在網段內的 IP 數）（設備清單另有「末端」分類：一般非 Wi-Fi 介面須恰好學到一個 MAC 且沒有 LLDP／CDP 介面鄰接；Wi-Fi 介面本身不算末端介面，但每個 Wi-Fi MAC 觀察位置仍列入末端清單且不參與 A02，因 MAC 可能因漫遊出現在多個 AP。純 MNDP 網域可達不算直連鄰接，不計入總覽的設備數。同一 MAC 的一般末端位置只在 VLAN 相同，或兩端皆未記錄 VLAN 時比較；跨設備的同 VLAN ID 不保證屬於同一 L2 網域，A02 是待核實警告）（IP 已去重複），可文字篩選，MAC 清單可篩「缺 IP」
   - **中：拓樸圖**：版面預設為「分層（ELK）」，先以快速版面出圖，再於背景用 ELK 做多輪交叉最小化後替換；網路設備超過 1500 台或計算失敗時維持快速版面並提示原因，可在工具列切換「快速（內建）」。只畫 L2 鄰接；同兩台設備間的多條連結合併成一條線；純 MNDP 證據以半透明（70%）點劃線表示同一 L2 broadcast domain 可達，不代表實體直連；OSPF 鄰接不作為拓樸 edge；連線兩端埠名在放大時顯示，滑過連線或節點（及選取連線）時不受縮放與重疊限制強制顯示；符合末端條件的位置以「未知對端」節點畫在所屬設備下方（可收合、可關閉）；Wi-Fi MAC 觀察位置也保留圖面提示，多 MAC 以菱形呈現，Wi-Fi 介面本身不算末端介面，Wi-Fi 觀察亦不參與 A02
   - **右：詳細資料**：鄰居（含類別與 LLDP／MNDP／CDP 協定）、OSPF L3 鄰接、介面（埠模式、PVID、untagged／tagged VLAN、所屬聚合／bridge）、VLAN、MAC、路由表；每筆都能開啟原文並標示行號
4. 上方搜尋可直接輸入設備名、MAC、IP、VLAN ID 或介面描述；**路由追蹤**輸入來源與目的 IP，逐跳顯示（含 ECMP）

基準會保存在這個瀏覽器（IndexedDB），下次開啟自動還原；程式更新後若基準格式不同，會用保存的輸入重新建立。按「清除」只清除本工具的資料。

建立基準後，頂端摘要會顯示檢查規則發現的錯誤／警告與收集缺漏，並提供直接跳到問題、覆蓋率、搜尋或路由追蹤的入口。這些是該份 Snapshot 的檢查結果與收集完整度，不代表即時網路健康狀態。窄螢幕可切換「拓樸／檢查／詳細資料」工作區；設備詳情中的 VLAN、鄰居、OSPF、路由與原始輸出可按需要展開。

### SSH 批次收集（選用）

在 WSL／Linux 可用 [`tools/collect.sh`](tools/collect.sh) 透過 SSH 收集多台設備。先複製
[`tools/devices.csv`](tools/devices.csv) 為自己的設備清單，並把範例的文件保留 IP
（`192.0.2.0/24`）改為實際位址：

```bash
cp tools/devices.csv devices.csv
```

設備清單第一列必須是 `name,address,user,port`；`name` 應唯一，且建議與設備的
`/system identity` 相同。`port` 可留空，預設為 `22`。

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

收集器預設使用既有 SSH key 或 ssh-agent，並保留系統的 host-key 驗證；不要略過 host-key
檢查，也不要在 CSV 或收集檔放入密碼、私鑰或 `show-sensitive` 輸出。沒有設定 SSH key 時，
可加 `--ask-password`：每台設備互動連線一次（輸入密碼、確認 host key），其餘命令共用該連線；
密碼不會寫入任何檔案。每次執行都會覆蓋輸出檔，要保留舊結果請用 `-o` 指定其他檔名。完整收集清單、輸入
格式與所有可用的命令 ID 見 [`docs/collection.md`](docs/collection.md)。

## 專案結構

```
index.html            單一畫面（載入順序：核心 → 命名規則 → 範例 → 畫面）
assets/app.css
src/
  core/               命名空間、IP 工具、唯一鍵
  readers/            輸入格式：bundle-v1、files-v1
  adapters/           mikrotik.js（10 個）
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
samples/              範例收集檔（含刻意放入的問題）、預期資料範例、舊版 lldp.txt
tools/                產生測試資料、更新 OUI、嵌入範例
tests/                核心測試、畫面冒煙測試
docs/                 設計說明、收集清單、命名規則
```

## 開發

只需要 Node.js（不需安裝任何套件）：

```bash
npm test               # 核心測試＋SSH 收集器測試＋畫面冒煙測試
npm run test:large     # 加上約 1000 台的壓力測試
npm run sample         # 重新產生範例收集檔
npm run gen:large      # 產生約 1000 台的收集檔（samples/large-1000.txt）
npm run oui -- <oui-data.json>   # 更新 OUI 廠商資料
./tools/collect.sh devices.csv --output collection.txt  # WSL 透過 SSH 批次收集
```

- 新增廠牌：在 `src/adapters/` 新增檔案並 `S.adapters.register()`，加到 `tools/core-files.js` 與 `index.html`。
- 新增輸入格式：在 `src/readers/` 新增 reader 並放進 `readers/index.js` 的 `ORDER`。
- 新增檢查：在 `src/check/checks.js` 的 `CATALOG` 加一筆並實作；在範例資料放一個對應的問題並加測試。
- SSH 收集器是 WSL/Linux 可執行的本機 Bash CLI，不是瀏覽器功能；使用既有 SSH key/agent，將多台設備的唯讀輸出包成一個 `bundle-v1` 檔。
- CI：[.github/workflows/ci.yml](.github/workflows/ci.yml) 在 PR 與非 main 分支 push 時以 Node 20／24 執行 `npm test`；壓力測試（`npm run test:large`）只在每週排程與手動觸發時執行。main 上的部署前仍由 `deploy-pages.yml` 跑 `npm test`。提交前仍請先在本機執行 `npm test`。

設計與取捨見 [docs/design-ssot.md](docs/design-ssot.md)。

## 注意

- 這是 topo-ssot 的 **MikroTik 專用版**，與多廠牌版並存時互不影響（瀏覽器儲存名稱不同）。
- 解析器依 RouterOS 文件與慣例撰寫，測試資料由程式產生，**尚未用真實設備輸出驗證**。RouterOS 7 為主，6.43 以上大致可用。
- 支援範圍與限制見 [docs/collection.md](docs/collection.md) 第 4 節。
