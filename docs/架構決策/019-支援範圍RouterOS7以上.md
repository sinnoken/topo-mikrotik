# ADR-019：支援範圍：RouterOS 7 以上

- **狀態**：已接受
- **日期**：2026-10-24
- **決策者**：使用者

## 背景

- 使用者的網路是 RouterOS 7。
- 線上手冊只有 7.24–7.26 版（`routeros-manual` skill 的 `manual.py versions`；舊版只能對照 [compare-versions](https://manual.mikrotik.com/docs/cli-reference/compare-versions)）。RouterOS 6 的格式只能依舊 wiki 撰寫，無法以手冊確認，例如：
  - VRF 是 `/ip route vrf`，路由以 `routing-mark` 指定（RouterOS 7 是 `/ip vrf` 與 `routing-table`）。
  - `print` 的旗標以逗號分隔。
  - 防火牆命中次數的數字沒有千位空白（RouterOS 7 以空白分千位，見[收集清單「防火牆命中次數」](../收集清單與輸入格式.md#1-每台設備要收集的指令)）。
- M3（VRF，[ADR-015](015-支援VRF並升級ssot-snapshot-3.md)）原本要同時處理兩種寫法，讓解析、收集與測試資料都多一倍，而且其中一半無法確認。

## 決策

- 新的解析、收集、fixture 與檢查都只依 RouterOS 7 的語法撰寫。
- 現有程式中處理 RouterOS 6 差異的地方（例如 NTP 的 `primary-ntp`／`secondary-ntp`、路由的旗標、命中次數的純數字）先不主動拆除。
- RouterOS 6 的輸入照現有行為處理，不保證結果正確。

## 考慮過的選項

| 選項 | 優點 | 缺點 | 結論 |
|---|---|---|---|
| A. 支援 RouterOS 6 與 7 | 舊設備也能用 | 每項功能要寫兩套解析與測試資料；RouterOS 6 的格式無法以手冊確認；使用者的網路用不到 | 不採用 |
| B. 只支援 RouterOS 7 | 只依手冊可以確認的語法撰寫；M3 的範圍減半 | RouterOS 6 的輸入可能解析錯而沒有提示 | **採用** |
| C. 支援 RouterOS 7，並對 RouterOS 6 的輸入報出明確的警告 | 不靜默：使用者知道結果不保證正確 | 要新增一條 finding，並決定版本判斷的依據 | 之後再決定（見「之後要回頭看的」） |

## 後果

### 變容易的

- 新功能只依手冊可以確認的 RouterOS 7 語法撰寫，每一條判斷規則都可以附上手冊網址。
- M3 不必處理 RouterOS 6 的 `/ip route vrf` 寫法。

### 變困難的

- RouterOS 6 的設備仍可以輸入，但結果不保證正確，而且目前沒有提示。
- 現有的 RouterOS 6 處理留在程式裡，修改附近的程式時要注意不要弄壞它，也不要再擴充。

### 之後要回頭看的

- 選項 C：是否新增一條 finding，例如設備的 `softwareVersion` 小於 7 時提醒結果不保證正確。

## 待辦

- docs：收集清單寫明支援範圍、README、agent 定義、路線圖 M3 的範圍（本次完成）。
- data-model、collector、workflow：之後的修改依本 ADR 只寫 RouterOS 7 的語法。
