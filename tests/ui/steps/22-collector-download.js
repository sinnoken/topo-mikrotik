// 畫面冒煙測試的 step：⚙ 設定「收集與建立基準」下載收集腳本（collect.zip，內容是嵌入的 S.samples.collectorFiles）與取得最新版的連結。
'use strict';
const { S, step, $, text, captureDownloads, settingsTab } = require('../helpers.js');
const assert = require('assert');

const App = () => globalThis.App;
const helpBtn = (key) => $('#settings-panel').testAll('button').find((b) => b.getAttribute('data-settings-focus') === key);

module.exports = async () => {
  await step('收集腳本下載：按下後下載 topo-mikrotik-collector.zip，讀回的檔案與嵌入的 S.samples.collectorFiles 逐字相同，兩次產生的 bytes 相同', async () => {
    const files = S.samples.collectorFiles;
    assert.ok(Array.isArray(files) && files.length, '前提：index.html 應載入 samples/collector-files.js');
    App().openSettings('help'); settingsTab('help').click();
    const btn = helpBtn('download-collector');
    assert.ok(btn, '「收集與建立基準」應有下載收集腳本的按鈕');
    assert.strictEqual(btn.getAttribute('disabled'), null, '有嵌入的收集腳本時按鈕可用');
    assert.ok(btn.textContent.includes('collect.zip'), '按鈕文字應寫出 collect.zip：' + btn.textContent);
    const once = async () => {
      const { files: got } = await captureDownloads(async () => { helpBtn('download-collector').click(); });
      assert.strictEqual(got.length, 1, '按一次應下載一個檔案');
      return got[0];
    };
    const a = await once(); const b = await once();
    assert.strictEqual(a.name, 'topo-mikrotik-collector.zip', '檔名');
    assert.ok(Buffer.compare(a.bytes, b.bytes) === 0, '同一版網頁兩次產生的 ZIP 應逐位元相同（固定的修改時間）');
    const z = S.zip.read(new Uint8Array(a.bytes));
    const dec = new TextDecoder();
    assert.deepStrictEqual(z.entries.map((e) => ({ path: e.path, text: dec.decode(e.bytes) })), files.map((f) => ({ path: f.path, text: f.text })),
      'ZIP 的檔案與內容應和 S.samples.collectorFiles 相同');
    assert.ok(files.every((f) => f.path.startsWith('topo-mikrotik-collector/')), '前提：檔案都在 topo-mikrotik-collector/ 底下');
    // 說明：解壓後 chmod +x，ZIP 的用法（cd 解壓後的目錄、./collect.sh）與 repo 裡的用法都寫出
    const t = text('#settings-panel');
    assert.ok(t.includes('chmod +x collect.sh'), '應說明解壓後 chmod +x collect.sh');
    assert.ok(t.includes('cd topo-mikrotik-collector') && /(^|\s)\.\/collect\.sh devices\.csv --dry-run/m.test(t), '應寫出解壓後的用法：' + t);
    assert.ok(/\.\/tools\/collect\.sh devices\.csv --dry-run/.test(t), '應保留在 repo 裡的用法');
    // 取得最新版：連到 GitHub main 的 ZIP，標明需要網路，新分頁開啟
    const latest = $('#settings-panel').testAll('a').find((x) => x.getAttribute('data-latest-collector') !== null);
    assert.ok(latest, '應有取得最新版的連結');
    assert.strictEqual(latest.getAttribute('href'), S.view.settings.REPO + '/archive/refs/heads/main.zip');
    assert.strictEqual(latest.getAttribute('href'), 'https://github.com/sinnoken/topo-mikrotik/archive/refs/heads/main.zip');
    assert.ok(latest.textContent.includes('需要網路'), '連結應標明需要網路：' + latest.textContent);
    assert.strictEqual(latest.getAttribute('target'), '_blank');
    assert.ok(/noopener/.test(latest.getAttribute('rel') || ''), 'rel 應含 noopener');
  });

  await step('收集腳本下載：沒有嵌入檔（S.samples.collectorFiles 未定義）時按鈕停用並說明原因，按下不下載', async () => {
    const saved = S.samples.collectorFiles;
    try {
      S.samples.collectorFiles = undefined;
      settingsTab('help').click();
      const btn = helpBtn('download-collector');
      assert.ok(btn && btn.getAttribute('disabled') !== null, '沒有嵌入檔時按鈕應停用');
      const reason = $('#settings-collector-note');
      assert.ok(reason && reason.textContent.includes('samples/collector-files.js'), '應說明停用的原因：' + (reason && reason.textContent));
      const { files } = await captureDownloads(async () => { btn.click(); });
      assert.strictEqual(files.length, 0, '停用時不應下載');
    } finally {
      S.samples.collectorFiles = saved;
      settingsTab('help').click();
    }
    assert.strictEqual(helpBtn('download-collector').getAttribute('disabled'), null, '恢復後按鈕可用');
    S.view.app.closeSettings();
  });
};
