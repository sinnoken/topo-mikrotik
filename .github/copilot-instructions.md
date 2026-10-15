# topo-mikrotik — 開發原則

這是一個可離線執行的 MikroTik RouterOS 網路基準工具。核心流程將
CLI 輸入轉成可追溯的純 JSON Snapshot，畫面只是 Snapshot 的檢視方式。
修改程式前，先維持這個邊界與以下原則。

## 鐵則

1. **先理解再修改**
   先找出資料流、既有 helper、測試與文件，再做最小且完整的修改。不要用
   猜測補行為，也不要順手修理與目前任務無關的問題。

2. **單一事實來源（SSOT）**
   同一個規則、狀態或資料不要在多處各自實作。沿用既有 canonical key、
   parser、query API、常數與狀態管理；需要新規則時，優先抽成可重用的單一
   來源，而不是複製邏輯。

3. **保持單向依賴**
   Reader/adapter 產生事實，model/infer 建立模型與推論，check 負責檢查，
   pipeline 負責編排，view/compare 只讀 Snapshot。核心不可依賴 DOM、Canvas
   或 IndexedDB；檢視層不可反向改寫核心模型。

4. **不靜默失敗**
   無法辨識、資料不完整、輸入不合法或操作失敗，都要以既有的 finding、錯誤、
   通知或測試失敗明確呈現。不可丟棄輸入、吞掉例外、回傳看似成功的預設值。

5. **資料必須可追溯**
   解析後的事實、模型資料與檢查結果要保留來源區塊、檔案與行號。任何 UI
   顯示的問題，都應能回到原始 RouterOS 輸出驗證。

6. **不要混淆事實與推論**
   收集到的設備、介面、連結、VLAN、位址與路由是事實；設備類型、配對、
   分群、未知對端等是推論。命名 profile 只能 canonicalize 或加註解，不能
   偽造、刪除或改寫事實。

7. **保持可重現性**
   相同輸入與選項應得到相同結果。不要以目前時間、執行順序、隨機值或環境
   狀態影響核心結果；必要的時間與效能欄位要明確隔離。測試比較 Snapshot
   時使用固定時間。

8. **優先小而清楚的變更**
   以根因為目標，避免大範圍重構、無關格式化與投機性抽象。每次修改只處理
   一個清楚的責任，並維持既有命名、載入順序、資料契約與使用者行為。

9. **型別與邊界要明確**
   在資料進入核心時驗證格式與邊界；使用現有 guard/helper，不用寬鬆轉型、
   `any`、隱性 fallback 或未說明的 magic number 掩蓋問題。

10. **UI 與資料層分離**
    UI 從 `SSOT.query(snapshot)` 查詢資料；畫布節點、選取、展開、縮放與
    位置是檢視狀態，不得污染 Snapshot。持久化集中在既有 store，不另建平行
    狀態來源。

11. **離線契約不可被破壞**
    `index.html` 必須能直接開啟。不要任意加入必需的後端、bundler、外部
    runtime 資產、執行期網路請求或只在真實瀏覽器存在的 API。

12. **生成資料走生成流程**
    由工具產生的 sample、嵌入檔與 OUI 資料，不手動逐字修改；修改來源或
    產生器後重新生成，並檢查產物與測試。

13. **SSH 收集器與網站分離**
    `tools/collect.sh` 是 WSL/Linux 可執行的本機 Bash CLI；它只能使用系統
    SSH 與既有 key/agent，產生 `bundle-v1`。不要把 SSH、credential 或
    shell subprocess 邏輯引入瀏覽器核心。


## 修改時的工作習慣

- 先讀相關 README、`docs/`、測試與呼叫端，再決定改哪一層。
- 優先重用現有模式；若跨模組修改，確認每個入口、載入順序與相關 UI 都一致。
- 新增行為要有可重現測試；修 bug 先加入能重現問題的案例，再修實作。
- 先寫出可驗收的完成條件，再開始修改；完成後逐項核對，避免用模糊的品質
  評語代替驗證結果。
- 任何輸入格式、Snapshot、檢查代碼或使用方式的變更，都同步更新直接相關
  文件；不要複製一份與程式脫節的規格。
- 保持錯誤訊息、finding id、資料欄位與輸出排序穩定，避免無必要的破壞性變更。
- 只加入必要的註解；註解說明「為什麼」而不是重述程式碼。
- 不覆蓋、還原或清理使用者未要求處理的既有變更與未追蹤檔案。

## 針對性守則

- **離線 UI 驗證**：`tests/ui-smoke.js` 使用簡化的模擬 DOM，`querySelector` 能力有限；
  讀詳情文字用 `text('#detail')`。測試避免硬編碼筆數與內部形狀，改斷言關係與
  可觀察行為。新增核心檔案時，`index.html` 與 `tools/core-files.js` 的載入順序
  必須一致；不引入外部資源或執行期網路請求。
- **檢查（finding）設計**：新增或調整檢查（如 K01、A02）時，先寫出判斷依據與
  證據來源（事實），推論要標示為推論；保留來源區塊與行號；訊息、id 與排序保持
  穩定，並同步 `docs/design-ssot.md` 的檢查代碼表。MNDP 只證明 L2 可達，不可當作
  LLDP／CDP 鄰接證據。
- **文件同步對照**：使用方式、畫面行為 → `README.md`；資料模型、檢查代碼、規則
  → `docs/design-ssot.md`；收集指令與格式 → `docs/collection.md`；命名 profile →
  `docs/profile.md`。程式與文件一起改，不另寫一份與程式脫節的規格。
- **專用 skill**：改 adapter／解析使用 `routeros-parser-fixtures`；改 Snapshot 欄位、
  檢查代碼或版本使用 `snapshot-contract-change`；改鄰居與拓樸使用
  `mikrotik-neighbor-topology`。

## 驗證底線

完成程式修改後，至少執行與變更相符的最小驗證；核心或 UI 變更通常執行：

```bash
npm test
```

大型資料或效能相關變更再執行：

```bash
npm run test:large
```

本專案沒有獨立 lint/format script。除測試外，確認 `git diff --check`，
並檢查 `index.html` 與 `tools/core-files.js` 的核心載入順序沒有漂移。
