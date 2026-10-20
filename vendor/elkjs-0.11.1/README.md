# elkjs 0.11.1（第三方，未修改）

- 來源：npm 套件 [`elkjs@0.11.1`](https://www.npmjs.com/package/elkjs/v/0.11.1)（2026-03-03 發布）的 `lib/elk.bundled.js`，原樣複製
- 授權：EPL-2.0，全文見同目錄 `LICENSE.md`
- 用途：拓樸圖的分層版面引擎（`src/view/graph/elk-layout.js`），只在畫面層載入，不屬於核心載入順序
- 更新方式：`npm pack elkjs@<版本>`，解開後複製 `lib/elk.bundled.js` 與 `LICENSE.md` 到新的 `vendor/elkjs-<版本>/`，再更新 `src/view/graph/elk-layout.js` 的 `ENGINE_SRC`
