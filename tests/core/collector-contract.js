// 收集器 → reader 端到端契約
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { S, ROOT, ids, iface, addrs, test } = require('../lib.js');
// ------------------------------------------------------------------ 收集器 → reader 端到端契約
// 用假的 ssh 實際跑 tools/collect.sh（方式同 tests/collect.sh），把產生的 bundle-v1 交給核心，確認兩邊對格式的認知一致。
// 環境缺 bash 或 GNU timeout 時「明確失敗」而不是略過：npm test 本來就要跑 bash tests/collect.sh，CI（ubuntu）一定有；
// 略過會讓這份跨元件契約在少了工具的環境裡看起來像是通過。
const E2E = {
  // 每台設備每個指令的固定輸出（RouterOS 的 SSH 輸出帶 CR）；exit 不是 0 的指令模擬失敗
  devices: [['SW_A', '192.0.2.1'], ['R_B', '192.0.2.2']],
  commands: ['system', 'config', 'neighbor', 'interface', 'arp'],
  cmdText: { system: '/system resource print', config: '/export terse', neighbor: '/ip neighbor print detail without-paging',
    interface: '/interface print detail without-paging', arp: '/ip arp print detail without-paging' },
  out: {
    'SW_A|system': ['            version: 7.16.1 (stable)', '         board-name: CRS326-24G-2S+', '           platform: MikroTik'],
    'SW_A|config': ['# 2026-10-24 03:00:00 by RouterOS 7.16.1', '/interface bridge add name=bridge1 vlan-filtering=yes',
      '/interface bridge port add bridge=bridge1 interface=ether2 pvid=20', '/interface bridge vlan add bridge=bridge1 tagged=ether1 untagged=ether2 vlan-ids=20',
      '/ip address add address=192.0.2.1/24 interface=bridge1 network=192.0.2.0', '/system identity set name=SW_A'],
    'SW_A|neighbor': [' 0 interface=ether1 address=192.0.2.2 mac-address=AA:BB:CC:00:00:02 identity=R_B platform=MikroTik', '    interface-name=ether1 discovered-by=lldp'],
    'SW_A|interface': ['Flags: R - RUNNING', ' 0  R  name="ether1" default-name="ether1" type="ether" mtu=1500 mac-address=AA:BB:CC:00:00:01',
      ' 1  R  name="ether2" default-name="ether2" type="ether" mtu=1500', ' 2  R  name="bridge1" type="bridge" mtu=auto'],
    'SW_A|arp': [' 0 DC address=192.0.2.2 mac-address=AA:BB:CC:00:00:02 interface=bridge1'],
    'R_B|system': ['            version: 7.16.1 (stable)', '         board-name: RB5009UG+S+', '           platform: MikroTik'],
    'R_B|config': ['/ip address add address=192.0.2.2/24 interface=ether1 network=192.0.2.0', '/system identity set name=R_B'],
    'R_B|neighbor': [' 0 interface=ether1 address=192.0.2.1 mac-address=AA:BB:CC:00:00:01 identity=SW_A platform=MikroTik', '    interface-name=ether1 discovered-by=lldp'],
    'R_B|interface': ['Flags: R - RUNNING', ' 0  R  name="ether1" default-name="ether1" type="ether" mtu=1500 mac-address=AA:BB:CC:00:00:02'],
  },
  fail: { 'R_B|arp': { exit: 3, stderr: 'failure: not enough permissions' } },
};
const FAKE_SSH = [
  '#!/usr/bin/env bash',
  '# 假的 ssh：最後一個參數是指令、倒數第二個是 user@位址；輸出取自 responses/<位址>/<指令>，有 .exit 檔時以該結束碼失敗',
  'set -u',
  'DIR=$(cd "$(dirname "$0")" && pwd)',
  'command_name=; target=',
  'for argument in "$@"; do target=${command_name:-}; command_name=$argument; done',
  'printf \'%s|%s\\n\' "$target" "$command_name" >> "$DIR/../ssh.log"',
  'f="$DIR/../responses/${target#*@}/$(printf \'%s\' "$command_name" | tr -c \'A-Za-z0-9\' \'_\')"',
  'if [[ -f "$f.exit" ]]; then [[ -f "$f" ]] && cat "$f"; cat "$f.stderr" >&2; exit "$(cat "$f.exit")"; fi',
  '[[ -f "$f" ]] || { printf \'fake ssh：沒有準備 %s 的輸出\\n\' "$target|$command_name" >&2; exit 99; }',
  'cat "$f"', ''].join('\n');
const E2E_WRAPPER = ['#!/usr/bin/env bash', 'set -euo pipefail', 'DIR=$(cd "$(dirname "$0")" && pwd)', 'export PATH="$DIR/bin:$PATH"', 'exec bash "$@"', ''].join('\n');
const slug = (cmd) => cmd.replace(/[^A-Za-z0-9]/g, '_');
const bashPath = (p) => p.replace(/\\/g, '/'); // Git Bash 接受 C:/… 形式；Linux 不變
/** 檢查 bash 與 GNU timeout；缺少時丟出說明原因的錯誤（測試失敗，不略過）。 */
function requireBashTools() {
  const { spawnSync } = require('child_process');
  const r = spawnSync('bash', ['-c', 'command -v timeout >/dev/null || { echo "找不到 timeout"; exit 3; }; timeout --version | head -n 1'], { encoding: 'utf8' });
  if (r.error) assert.fail(`收集器端到端測試需要 bash（${r.error.code || r.error.message}）；Windows 請安裝 Git Bash 並放在 PATH 前面，WSL／Linux 請安裝 bash`);
  if (r.status !== 0 || !/GNU coreutils/.test(r.stdout)) assert.fail(`收集器端到端測試需要 GNU timeout（coreutils）：${(r.stdout + r.stderr).trim() || `bash 結束碼 ${r.status}`}`);
}
/** 在暫存目錄準備假的 ssh 並執行 tools/collect.sh；回傳 { status, text, log, stderr }，結束後刪除暫存目錄。 */
function runCollector() {
  const os = require('os'); const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topo-mikrotik-e2e-'));
  try {
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'ssh'), FAKE_SSH, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'run.sh'), E2E_WRAPPER, { mode: 0o755 });
    E2E.devices.forEach(([name, ip]) => {
      const d = path.join(dir, 'responses', ip); fs.mkdirSync(d, { recursive: true });
      E2E.commands.forEach((id) => {
        const k = `${name}|${id}`; const f = path.join(d, slug(E2E.cmdText[id]));
        if (E2E.out[k]) fs.writeFileSync(f, E2E.out[k].map((l) => l + '\r\n').join(''));
        if (E2E.fail[k]) { fs.writeFileSync(f + '.exit', String(E2E.fail[k].exit)); fs.writeFileSync(f + '.stderr', E2E.fail[k].stderr + '\n'); }
      });
    });
    fs.writeFileSync(path.join(dir, 'devices.csv'), ['name,address,user,port', ...E2E.devices.map(([n, ip]) => `${n},${ip},admin,22`)].join('\n') + '\n');
    const out = path.join(dir, 'bundle.txt');
    const r = spawnSync('bash', [bashPath(path.join(dir, 'run.sh')), bashPath(path.join(ROOT, 'tools/collect.sh')), bashPath(path.join(dir, 'devices.csv')),
      '--commands', E2E.commands.join(','), '--timeout', '20', '--output', bashPath(out)], { encoding: 'utf8', timeout: 120000 });
    if (r.error) throw r.error;
    const read1 = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    return { status: r.status, stderr: r.stderr, stdout: r.stdout, text: read1(out), log: read1(path.join(dir, 'ssh.log')) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('收集器端到端：假 ssh 執行 tools/collect.sh 產生的 bundle-v1，核心讀得出收集時間、失敗原因、設備與指令，且收集器註解不是 I01', () => {
  requireBashTools();
  const run = runCollector();
  assert.strictEqual(run.status, 1, `有一個指令失敗，收集器應以 1 結束；實際 ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.ok(/failure: not enough permissions/.test(run.stderr), '失敗指令的 stderr 要轉給使用者：' + run.stderr);
  // 每台設備依序執行每個指令，連到正確的位址（假 ssh 記錄「user@位址|指令」）
  const want = E2E.devices.flatMap(([, ip]) => E2E.commands.map((id) => `admin@${ip}|${E2E.cmdText[id]}`));
  assert.deepStrictEqual(run.log.trim().split(/\r?\n/), want);
  const s = S.build([{ name: 'collection.txt', text: run.text }], { now: '2026-01-01T00:00:00Z' });
  assert.strictEqual(s.meta.sources[0].reader, 'bundle-v1');
  assert.deepStrictEqual(s.findings.filter((f) => f.id === 'I01').map((f) => f.message), [], '收集器寫的 # collected-at／# collection failed 不可變成 I01');
  // 設備名稱與指令標記對回來：每個區塊一個指令，順序與收集順序相同
  assert.deepStrictEqual(s.blocks.map((b) => [b.device, b.command]), E2E.devices.flatMap(([n]) => E2E.commands.map((id) => [n, E2E.cmdText[id]])));
  assert.deepStrictEqual(s.model.devices.filter((d) => d.collected).map((d) => [d.key, d.mgmtIp]), E2E.devices.slice().sort((x, y) => S.util.natural(x[0], y[0])));
  // 收集時間：每個區塊都有，格式是 UTC ISO 8601 秒精度（值由收集當下決定，不比對）
  s.blocks.forEach((b) => assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(b.collectedAt || ''), `${b.device} ${b.command} 的 collectedAt：${b.collectedAt}`));
  // 失敗：只有 R_B 的 ARP，原因 exit-code，結束碼 3；其他區塊沒有 failure
  assert.deepStrictEqual(s.blocks.filter((b) => b.failure).map((b) => [b.device, b.command, b.failure.reason, b.failure.exitCode]),
    [['R_B', E2E.cmdText.arp, 'exit-code', 3]]);
  assert.deepStrictEqual(s.coverage.find((c) => c.dev === 'R_B').failures.map((x) => [x.command, x.reason, x.exitCode, x.dataTypes]),
    [[E2E.cmdText.arp, 'exit-code', 3, ['arp']]]);
  assert.deepStrictEqual(s.coverage.find((c) => c.dev === 'SW_A').failures, []);
  // 收集到的內容確實被解析：LLDP 雙向、ARP、VLAN、IP
  assert.deepStrictEqual(s.model.links.map((l) => [l.key, l.verified]), [['R_B|ether1~SW_A|ether1', true]]);
  assert.deepStrictEqual(s.model.arps.map((a) => [a.dev, a.ip]), [['SW_A', '192.0.2.2']]);
  assert.deepStrictEqual(addrs(s, 'R_B|ether1'), ['192.0.2.2/24']);
  assert.deepStrictEqual(iface(s, 'SW_A|ether2').untaggedVlans, [20]);
  // 可重現：再收集一次，除了收集時間以外輸出相同，Snapshot 的模型、finding、coverage 也相同
  const again = runCollector();
  const norm = (t) => t.replace(/^# collected-at: .*$/gm, '# collected-at: <時間>');
  assert.strictEqual(norm(again.text), norm(run.text));
  const s2 = S.build([{ name: 'collection.txt', text: again.text }], { now: '2026-01-01T00:00:00Z' });
  // 收集時間也會出現在 C02 證據的原文裡，一併換掉
  const stable = (x) => JSON.stringify({ model: x.model, findings: x.findings, coverage: x.coverage, blocks: x.blocks }).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, '<時間>');
  assert.strictEqual(stable(s2), stable(s));
});
