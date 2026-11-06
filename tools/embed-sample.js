// 把 samples/sample-bundle.txt 包成 samples/sample-bundle.js，讓 index.html 以 file:// 開啟時也能「載入範例資料」。
// 同時把收集器的指令定義（tools/collector-commands.sh，唯一來源）包成 samples/collect-commands.js，給收集指引離線顯示。
// 另把收集腳本（collect.sh、collector-commands.sh 與範例 devices.csv）逐字包成 samples/collector-files.js，給說明頁離線下載 collect.zip。
// 產生內容的 embed(text)、collectCommandsJs(sh)、collectorFilesJs(texts) 另外匯出，tests/core/generated.js 用它們檢查生成檔有沒有跟著來源更新。
'use strict';
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');

/** sample-bundle.txt 的內容 → sample-bundle.js 的內容。 */
function embed(text) {
  return '// 由 tools/embed-sample.js 產生，請勿手動修改\n(function (S) { S.samples = S.samples || {}; S.samples[\'sample-bundle.txt\'] = ' + JSON.stringify(text) + '; })(globalThis.SSOT = globalThis.SSOT || {});\n';
}

/** 解析 collector-commands.sh：預設與選用的命令 ID 陣列，以及 command_for_id 的 case 分支。任何 ID 找不到指令就失敗。 */
function collectorCommands(sh) {
  const ids = (name) => {
    const m = new RegExp('^' + name + '=\\(([^)]*)\\)', 'm').exec(sh);
    if (!m) throw new Error('collector-commands.sh 找不到 ' + name);
    return m[1].trim().split(/\s+/);
  };
  const cmd = new Map(Array.from(sh.matchAll(/^\s*([\w-]+)\)\s*printf '%s\\n' '([^']+)'\s*;;/gm), (m) => [m[1], m[2]]));
  const list = (name) => ids(name).map((id) => {
    if (!cmd.has(id)) throw new Error('collector-commands.sh 的 ' + id + ' 沒有對應的指令');
    return { id, command: cmd.get(id) };
  });
  return { default: list('COLLECT_COMMAND_IDS'), optional: list('OPTIONAL_COMMAND_IDS') };
}

/** collector-commands.sh 的內容 → samples/collect-commands.js 的內容。 */
function collectCommandsJs(sh) {
  return '// 由 tools/embed-sample.js 依 tools/collector-commands.sh 產生，請勿手動修改\n'
    + '(function (S) { S.collectCommands = ' + JSON.stringify(collectorCommands(sh)) + '; })(globalThis.SSOT = globalThis.SSOT || {});\n';
}

/** 收集腳本的來源（tools/ 下的檔名）與在 collect.zip 中的路徑；順序固定。 */
const COLLECTOR_FILES = [
  { src: 'collect.sh', path: 'topo-mikrotik-collector/collect.sh' },
  { src: 'collector-commands.sh', path: 'topo-mikrotik-collector/collector-commands.sh' },
  { src: 'devices.csv', path: 'topo-mikrotik-collector/devices.csv' },
];

/** 各來源的內容（與 COLLECTOR_FILES 同順序，逐字不轉換）→ samples/collector-files.js 的內容。 */
function collectorFilesJs(texts) {
  if (texts.length !== COLLECTOR_FILES.length) throw new Error('收集腳本應有 ' + COLLECTOR_FILES.length + ' 個檔案，收到 ' + texts.length + ' 個');
  const items = COLLECTOR_FILES.map((f, i) => 'Object.freeze({ path: ' + JSON.stringify(f.path) + ', text: ' + JSON.stringify(texts[i]) + ' })');
  return '// 由 tools/embed-sample.js 依 ' + COLLECTOR_FILES.map((f) => 'tools/' + f.src).join('、') + ' 產生，請勿手動修改\n'
    + '(function (S) { S.samples = S.samples || {}; S.samples.collectorFiles = Object.freeze([\n  ' + items.join(',\n  ') + ',\n]); })(globalThis.SSOT = globalThis.SSOT || {});\n';
}

module.exports = { embed, collectorCommands, collectCommandsJs, COLLECTOR_FILES, collectorFilesJs };

if (require.main === module) {
  const text = fs.readFileSync(path.join(root, 'samples/sample-bundle.txt'), 'utf8');
  fs.writeFileSync(path.join(root, 'samples/sample-bundle.js'), embed(text));
  console.log('samples/sample-bundle.js 已更新');
  fs.writeFileSync(path.join(root, 'samples/collect-commands.js'), collectCommandsJs(fs.readFileSync(path.join(root, 'tools/collector-commands.sh'), 'utf8')));
  console.log('samples/collect-commands.js 已更新');
  fs.writeFileSync(path.join(root, 'samples/collector-files.js'), collectorFilesJs(COLLECTOR_FILES.map((f) => fs.readFileSync(path.join(root, 'tools', f.src), 'utf8'))));
  console.log('samples/collector-files.js 已更新');
}
