# 網路基準（topo-mikrotik）

由 **MikroTik RouterOS** 的 CLI 輸出，一次建立網路現況基準（Single Source of Truth）：拓樸、介面、VLAN、MAC／IP 位置、路由，並列出資料之間的矛盾與缺漏。

- 純前端、**零相依套件**、可**完全離線**：直接雙擊 `index.html` 即可使用
- 資料只在瀏覽器內處理，不會傳到任何地方
- 約 1000 台設備一次建立約 3 秒

## 使用

1. 依 [收集清單](docs/collection.md) 收集每台 RouterOS 的輸出（**所有 print 都要加 `detail without-paging`**），合併成一個收集檔
2. 開啟 `index.html` → **建立基準…** → 貼上或選擇檔案（可先按「載入範例資料」試用）
3. 畫面分三塊：
   - **左：檢查結果／覆蓋率／比對**：點任一筆，圖上會定位並標紅
   - **中：拓樸圖**：滾輪縮放、拖曳、點選；同兩台設備間的多條連結合併成一條線；沒有 LLDP 鄰居、只由 MAC 推論出來的末端，以「未知對端」節點畫在所屬設備下方（可收合、可關閉）
   - **右：詳細資料**：鄰居、介面、VLAN、MAC、路由表；每筆都能開啟原文並標示行號
4. 上方搜尋可直接輸入設備名、MAC、IP、VLAN ID 或介面描述；**路由追蹤**輸入來源與目的 IP，逐跳顯示（含 ECMP）

基準會保存在這個瀏覽器（IndexedDB），下次開啟自動還原；按「清除」只清除本工具的資料。

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

收集器使用既有 SSH key 或 ssh-agent，並保留系統的 host-key 驗證；不要略過 host-key
檢查，也不要在 CSV 或收集檔放入密碼、私鑰或 `show-sensitive` 輸出。完整收集清單、輸入
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
  view/               畫面：dom、store（IndexedDB）、graph（版面＋Canvas）、panels、app
profiles/             命名規則範例（可不套用）
samples/              範例收集檔（含刻意放入的問題）、預期資料範例、舊版 lldp.txt
tools/                產生測試資料、更新 OUI、嵌入範例
tests/                核心測試、畫面冒煙測試
docs/                 設計說明、收集清單、命名規則
```

## 開發

只需要 Node.js（不需安裝任何套件）：

```bash
npm test               # 核心 32 項＋畫面冒煙測試
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

設計與取捨見 [docs/design-ssot.md](docs/design-ssot.md)。

## 注意

- 這是 topo-ssot 的 **MikroTik 專用版**，與多廠牌版並存時互不影響（瀏覽器儲存名稱不同）。
- 解析器依 RouterOS 文件與慣例撰寫，測試資料由程式產生，**尚未用真實設備輸出驗證**。RouterOS 7 為主，6.43 以上大致可用。
- 支援範圍與限制見 [docs/collection.md](docs/collection.md) 第 4 節。
