// 折行寬度的變形測試：同一段 RouterOS 輸出依不同終端寬度重新折行，解析出的事實與 findings 必須相同
'use strict';
const assert = require('assert');
const { S, read, build, test } = require('../lib.js');

/*
 * rewrap(text, W)：把「不折行」的收集檔依終端寬度 W 重新折行，模擬 RouterOS 的輸出。
 * 手冊沒有折行規則（只說明終端寬度可在登入名稱後加 +<N>w 設定：https://manual.mikrotik.com/docs/management-tools/console.md），
 * 以下全部依實機樣本推論（tests/fixtures/real/ 的 7.24.4-RB5009UG+S+.txt、7.25.1-RB3011UiAS.txt、7.25.1-neighbor-wrap.txt、
 * 7.x-defconf-fwstats.txt；手冊無法確認）。實機在 80 欄時每行最多 79 字，所以每行上限是 W-1。
 *
 * detail 的列（/… print detail）：
 *  - 列首是「序號 旗標」；欄位接在列首之後，續行縮排到列首的寬度（RB3011 的路由與介面、RB5009 的介面與 OSPF）。
 *  - 欄位（key=value，值含引號內的空白；日期與時間之間的空白也屬於同一個值）以空白分開，一行放得下就接在後面，放不下就換行。
 *  - 一個欄位在新的一行也放不下時，在值裡最後一個放得下的位置斷開：斷在 , - / 之後的字元留在行尾
 *    （RB5009 的 system-caps 斷在「,」之後；neighbor-wrap 的 system-description 斷在「-」之後；/ 依同樣規則推論），
 *    或斷在空白處、空白不留（樣本沒有這種斷法，依 parser 的推論）；斷開後的下一行縮排比欄位深 3 格，之後的欄位接在同一行
 *    （neighbor-wrap 的「5HacD2HnD" system-caps=…」）。找不到斷點時丟出錯誤，不自己編造斷法。
 *  - 有註解時：列首後接 `;;; 註解`，欄位從下一行開始。註解太長時依寬度硬切，續行補空白到註解文字的欄位、沒有 `;;;`
 *    （RB5009 bridge 的「, C000」、RB3011 CAPsMAN 說明的「CA」／「P」）。
 *  - 旗標說明（Flags:）以「; 」「, 」分開的項目折行，斷開處的分隔符號不留，續行縮排 7 格（RB3011 路由的 Flags）。
 * print stats 的表格（RouterOS 7）：只有 `;;; 註解` 會折，依寬度硬切、續行從第 0 欄開始、沒有 `;;;`；資料列與表頭不折
 *  （實機 fixture 只有短註解，續行的形狀依 f038643 的實機觀察，tests/core/fwstats.js 的長註解測試同樣形狀）。
 * key: value 的 print（/system routerboard print、/interface bridge monitor）：開頭的 `;;;` 依單字折行、每行都有 `;;;`
 *  （RB3011 routerboard 的升級訊息、RB5009 bridge monitor 的註解）；欄位行不折。
 * 不模擬的形狀：一列有多個註解（CAPsMAN 說明後接 `;;; mode:` 或獨立一行 `;;;`，7.25.1-hAPax2.txt），排法無法從樣本歸納；
 * 多欄的 bridge port monitor；export 的反斜線續行。這些區塊原樣保留，由 tests/core/fixtures.js 直接測。
 */
const DETAIL = /\bprint\b.*\bdetail\b/;
const STATS = /\bprint\b.*\bstats\b/;
const WORD_NOTE = /^\/?(?:system\s+routerboard\s+print|interface\s+bridge\s+monitor)\b/;
const COMMAND = /^(?:###\s+|\[[^\]]*\]\s*>\s*)(.*)$/;
const DEVICE = /^[^\s#\[].*\([^)]*\):\s*$/;

/** 引號外以空白分開欄位；日期之後的時間（2026-10-30 14:02:23）併回同一個值 */
function tokens(text) {
  const out = []; let cur = ''; let q = false;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (q && ch === '\\') { cur += ch + (text[++k] || ''); continue; }
    if (ch === '"') q = !q;
    if (!q && /\s/.test(ch)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.reduce((acc, t) => {
    if (/^\d{1,2}:\d{2}:\d{2}$/.test(t) && acc.length && /=\d{4}-\d{2}-\d{2}$/.test(acc[acc.length - 1])) acc[acc.length - 1] += ' ' + t;
    else acc.push(t);
    return acc;
  }, []);
}
/** 欄位在 room 個字內最後一個斷點：{ cut（這一行留到哪）, skip（斷點的空白不留）} */
function breakAt(tok, room) {
  let best = null;
  for (let k = tok.indexOf('=') + 1; k < tok.length; k++) {
    if (tok[k] === ' ' && k <= room && k > 0) best = { cut: k, skip: 1 };
    else if (',-/'.includes(tok[k]) && k + 1 <= room && k + 1 < tok.length) best = { cut: k + 1, skip: 0 };
  }
  if (!best) throw new Error(`rewrap：「${tok}」在 ${room} 字內沒有斷點（樣本沒有這種形狀）`);
  return best;
}
const hardCut = (first, col, text, max) => {
  const out = [first + text.slice(0, max - first.length)]; let rest = text.slice(max - first.length);
  while (rest) { out.push(' '.repeat(col) + rest.slice(0, max - col)); rest = rest.slice(max - col); }
  return out;
};
function renderRow(r, max) {
  const out = []; const ind = r.head.length;
  if (r.comment !== null) out.push(...hardCut(r.head + ';;; ', ind + 4, r.comment, max));
  let line = r.comment !== null ? ' '.repeat(ind) : r.head; let empty = true;
  tokens(r.fields).forEach((tok) => {
    let t = tok;
    if (line.length + (empty ? 0 : 1) + t.length <= max) { line += (empty ? '' : ' ') + t; empty = false; return; }
    if (!empty) { out.push(line); line = ' '.repeat(ind); }
    while (line.length + t.length > max) {
      const b = breakAt(t, max - line.length);
      out.push(line + t.slice(0, b.cut)); t = t.slice(b.cut + b.skip); line = ' '.repeat(ind + 3);
    }
    line += t; empty = false;
  });
  if (!empty || r.comment === null) out.push(line);
  return out;
}
function renderLegend(text, max) {
  const items = []; const re = /\s*([;,])\s*/g; let last = 0; let m;
  const body = text.trim();
  while ((m = re.exec(body))) { items.push({ text: body.slice(last, m.index), sep: m[1] }); last = re.lastIndex; }
  if (body.slice(last)) items.push({ text: body.slice(last), sep: '' });
  if (!items.length) return [text];
  const out = []; let line = 'Flags: ' + items[0].text;
  items.slice(1).forEach((it, k) => {
    const cand = `${line}${items[k].sep} ${it.text}`;
    if (cand.length <= max) line = cand; else { out.push(line); line = ' '.repeat(7) + it.text; }
  });
  out.push(line);
  return out;
}
/** detail 區塊：把現有的折行接回列（列首之外的非空行以一個空白接上），再依寬度折行 */
function rewrapDetail(lines, max) {
  const out = []; let flags = new Set(); let row = null;
  const flush = () => { if (row) out.push(...renderRow(row, max)); row = null; };
  lines.forEach((l) => {
    const t = l.trim();
    const legend = /^\s*Flags:(.*)$/.exec(l);
    if (legend) { flush(); flags = new Set(Array.from(legend[1].matchAll(/(?:^|[;,\s])([A-Za-z*+])\s*-/g), (x) => x[1])); out.push(...renderLegend(legend[1], max)); return; }
    if (!t || t.startsWith('#') || /^Columns:/.test(t)) { flush(); out.push(l); return; }
    const h = /^(\s*(?:\d+(?:\s+|$))?(?:([A-Za-z*+]+)(?:\s+|$))?)(.*)$/.exec(l);
    // 旗標不在說明行裡（範例資料路由的 d）時，縮排沒有比上一列深也是列首（續行一定比列首深）
    const indent = l.length - l.trimStart().length;
    const flagOk = !h[2] || Array.from(h[2]).every((ch) => flags.has(ch)) || (row && indent <= row.indent);
    const isHead = h[1].trim() && flagOk && (/^\s*\d/.test(h[1]) || h[2]);
    if (isHead) {
      flush();
      const rest = h[3];
      row = Object.assign({ head: h[1], indent }, rest.startsWith(';;;') ? { comment: rest.slice(4), fields: '' } : { comment: null, fields: rest });
      return;
    }
    // 沒有 key= 的行不是欄位（範例資料刻意放的雜訊「```」）：原樣保留，交給解析器列為 I03
    if (!row || !/(^|\s)[\w.\-]+=/.test(t)) { flush(); out.push(l); return; }
    row.fields = row.fields ? `${row.fields} ${t}` : t;
  });
  flush();
  return out;
}
const rewrapStats = (lines, max) => lines.flatMap((l) => (l.startsWith(';;;') ? hardCut('', 0, l, max) : [l]));
/** key: value 的 print：開頭連續的 ;;; 行接成一句，依單字折行，每行都有 ;;; */
function rewrapWordNote(lines, max) {
  const out = []; let note = null;
  const flush = () => {
    if (!note) return;
    let line = note.prefix;
    note.words.forEach((w) => {
      if (line === note.prefix) line += w;
      else if (line.length + 1 + w.length <= max) line += ' ' + w;
      else { out.push(line); line = note.prefix + w; }
    });
    assert.ok(line.length <= max, `rewrap：「${line}」放不下`);
    out.push(line); note = null;
  };
  lines.forEach((l) => {
    const m = /^(\s*;;; )(.*)$/.exec(l);
    if (m) { if (!note) note = { prefix: m[1], words: [] }; note.words.push(...m[2].split(' ').filter(Boolean)); return; }
    flush(); out.push(l);
  });
  flush();
  return out;
}
function rewrap(text, W) {
  const max = W - 1; const out = []; let block = []; let kind = null;
  const flush = () => {
    if (kind === 'detail') out.push(...rewrapDetail(block, max));
    else if (kind === 'stats') out.push(...(block.some((l) => /^\s*Columns:/.test(l)) ? rewrapStats(block, max) : block));
    else if (kind === 'note') out.push(...rewrapWordNote(block, max));
    else out.push(...block);
    block = [];
  };
  text.split(/\r?\n/).forEach((l) => {
    const c = COMMAND.exec(l);
    if (c || DEVICE.test(l) || /^_{3,}$/.test(l)) {
      flush(); out.push(l);
      kind = !c ? null : STATS.test(c[1]) ? 'stats' : DETAIL.test(c[1]) ? 'detail' : WORD_NOTE.test(c[1]) ? 'note' : null;
      return;
    }
    block.push(l);
  });
  flush();
  return out.join('\n');
}

// 比較用：去掉行號與區塊（src、line、lines、block、evidence 裡的位置）；訊息裡的「第 N 行」換成「第 # 行」
const POSITION = new Set(['src', 'line', 'lines', 'block', 'startLine', 'endLine', 'file']);
// 命中次數對不上 export 時的 reason.rule／reason.row 是 [block, line]（src/model/build.js 的 matchFirewallStats）
const BLOCK_LINE = new Set(['rule', 'row']);
const isBlockLine = (x) => Array.isArray(x) && x.length === 2 && x.every(Number.isInteger);
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).filter((k) => !POSITION.has(k) && !(BLOCK_LINE.has(k) && isBlockLine(v[k]))).map((k) => [k, strip(v[k])]));
  }
  return v;
}
const noLine = (m) => m.replace(/第 \d+(?:–\d+)? 行/g, '第 # 行');
const facts = (s) => ({ model: strip(s.model), findings: s.findings.map((f) => [f.id, noLine(f.message)]) });
const WIDTHS = [60, 79, 100, 132, 511];

const unparsed = (s) => s.findings.filter((f) => f.id === 'I01' || f.id === 'I03').map((f) => noLine(f.message));
/** 模擬收集器：每個指令標記的下一行（緊接著 collected-at 時是它的下一行）加上 # terminal-width: W */
function withWidth(text, W) {
  const ls = text.split('\n'); const at = (l) => /^#\s*collected-at:/.test(l || '');
  return ls.flatMap((l, k) => ((COMMAND.test(l) && !at(ls[k + 1])) || (at(l) && COMMAND.test(ls[k - 1] || '')) ? [l, `# terminal-width: ${W}`] : [l])).join('\n');
}
/**
 * 每個寬度、有記錄寬度（# terminal-width:）與沒有記錄（由輸出推算）兩種：I01／I03 與 base 相同
 * （expectI01 列出 base 本來就有的，例如範例資料刻意放的 /system clock print；其他一律不可有），
 * 去掉位置後的事實（model）與 findings 的 id、訊息都與 base 相同
 */
function sameAtAllWidths(name, unwrapped, base, expectI01 = []) {
  assert.deepStrictEqual(unparsed(base), expectI01, `${name}：基準的 I01／I03`);
  const want = facts(base);
  WIDTHS.forEach((W) => {
    const wrapped = rewrap(unwrapped, W);
    [['沒有記錄寬度', wrapped], ['有記錄寬度', withWidth(wrapped, W)]].forEach(([how, text]) => {
      const s = build(text);
      assert.deepStrictEqual(unparsed(s), expectI01, `${name} W=${W}（${how}）：I01／I03`);
      assert.deepStrictEqual(facts(s), want, `${name} W=${W}（${how}）：事實或 findings 與原本不同`);
      const recorded = s.blocks.filter((b) => b.command).map((b) => b.terminalWidth);
      assert.ok(recorded.length && recorded.every((w) => w === (how === '有記錄寬度' ? W : null)), `${name} W=${W}（${how}）：區塊的 terminalWidth`);
    });
  });
}

// ---- 實機片段還原成不折行的版本（換行位置以外照抄 fixture；每列一行，有註解時欄位在下一行）
const RB5009 = ['DEV-007 (192.168.0.253):',
  '### /ip neighbor print detail without-paging',
  '# collected-at: 2026-11-07T09:42:31Z',
  ' 0  interface=ether1,bridge address=192.168.1.254 address4=192.168.1.254 address6=2001:db8:0:1::6 mac-address=2C:C8:1B:00:00:06 identity="DEV-003" platform="MikroTik" version="7.25.1 2026-11-02 12:39:53" unpack=none age=14m9s uptime=8h31s software-id="REDACTED" board="RBwAPGR-5HacD2HnD" interface-name="bridge/ether2" system-caps=bridge,router system-caps-enabled=bridge,router discovered-by=lldp,mndp',
  '',
  ' 7  interface=ether4,bridge mac-address=E0:D5:5E:00:00:38 identity="" platform="" version="" unpack=none age=2m14s system-caps=repeater,bridge,wlan-ap,router,telephone,docsis-cable-device,station-only system-caps-enabled=bridge,router discovered-by=lldp',
  '',
  '### /interface print detail without-paging',
  '# collected-at: 2026-11-07T09:42:36Z',
  'Flags: X - DISABLED; R - RUNNING; S - SLAVE',
  ' 9  R  ;;;  0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, A000, B000, C000, D000, E000, F000',
  '       name="bridge" type="bridge" mtu=auto actual-mtu=1500 l2mtu=1514 vrf=main mac-address=2C:C8:1B:00:00:1A last-link-up-time=2026-10-30 14:02:23 link-downs=0',
  '',
  '10  R  name="lo" type="loopback" mtu=65536 actual-mtu=65536 vrf=main mac-address=00:00:00:00:00:00 last-link-up-time=2026-10-30 14:02:20 link-downs=0',
  '',
  '### /routing ospf neighbor print detail without-paging',
  '# collected-at: 2026-11-07T09:42:36Z',
  'Flags: D - DYNAMIC',
  '0 D instance=v3inst area=backbone_v3 interface=bridge address=fe80::2ec8:1bff:fe00:6 priority=1 router-id=169.254.0.6 dr=169.254.0.253 bdr=169.254.0.252 state="Full" state-changes=5 adjacency=8h14m1s timeout=33s',
  '',
  '1 D instance=v3inst area=backbone_v3 interface=bridge address=fe80::6e3b:6bff:fe00:5 priority=64 router-id=169.254.0.252 dr=169.254.0.253 bdr=169.254.0.252 state="Full" state-changes=6 adjacency=8h20m54s timeout=33s',
  '',
  '### /interface bridge monitor [find] once',
  '# collected-at: 2026-11-07T09:42:36Z',
  '                     ;;; 0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, A000, B000, C000, D000, E000, F000',
  '                  state: enabled',
  '    current-mac-address: 2C:C8:1B:00:00:1A',
  '              bridge-id: 0.2C:C8:1B:00:00:1A',
  '            root-bridge: yes',
  '         root-bridge-id: 0.2C:C8:1B:00:00:1A',
  '         root-path-cost: 0',
  '              root-port: none',
  '             port-count: 4',
  '  designated-port-count: 4',
  '           fast-forward: no'].join('\n');
// RB3011 不含第 12 列（CAPsMAN 說明後另有 ;;; 註解）與多欄的 bridge port monitor
const RB3011 = ['DEV-006 (192.168.0.252):',
  '### /system routerboard print',
  '# collected-at: 2026-11-07T09:42:18Z',
  '                ;;; Firmware upgraded successfully, please reboot for changes to take effect!',
  '       routerboard: yes',
  '             model: RB3011UiAS',
  '     serial-number: REDACTED',
  '     firmware-type: ipq8060',
  '  minimum-firmware: 3.27',
  '  current-firmware: 7.25',
  '  upgrade-firmware: 7.25.1',
  '',
  '### /ip route print detail without-paging',
  '# collected-at: 2026-11-07T09:42:16Z',
  'Flags: D - DYNAMIC; X - DISABLED, I - INACTIVE, A - ACTIVE; c - CONNECT, s - STATIC, r - RIP, b - BGP, o - OSPF, i - IS-IS, d - DHCP, v - VPN, m - MODEM, y - BGP-MPLS-VPN; H - HW-OFFLOADED; + - ECMP',
  ' 0   Xs  ;;; comment-459',
  '         dst-address=11.4.74.1/32 routing-table=main gateway="" blackhole distance=1 scope=30',
  '',
  ' 5   As  ;;; comment-453',
  '         dst-address=10.0.0.0/8 routing-table=main gateway=192.168.0.250 blackhole immediate-gw="" distance=1 scope=30',
  '',
  '    DAo  ;;; comment-1407',
  '         dst-address=10.101.92.242/32 routing-table=main gateway=192.168.0.6%bridge immediate-gw=192.168.0.6%bridge distance=130 scope=20 target-scope=10',
  '',
  '    DAb  ;;; comment-1406',
  '         dst-address=11.4.98.107/32 routing-table=main blackhole immediate-gw="" distance=20',
  '',
  '    DAc+ dst-address=172.17.168.0/24 routing-table=main gateway=zerotier1 immediate-gw=zerotier1 distance=0 scope=10 target-scope=5 local-address=172.17.168.254%zerotier1',
  '',
  '### /interface print detail without-paging',
  '# collected-at: 2026-11-07T09:42:18Z',
  'Flags: D - DYNAMIC; X - DISABLED; R - RUNNING; S - SLAVE',
  ' 0    RS ;;; comment-011',
  '         name="ether1-Wan" default-name="ether1" type="ether" mtu=1500 actual-mtu=1500 l2mtu=1514 max-l2mtu=8156 vrf=main mac-address=6C:3B:6B:00:00:05 last-link-up-time=2026-11-07 09:21:34 link-downs=0',
  '',
  '11  D    ;;; operated by CAP CC:2D:E0:00:00:99%bridge, traffic processing on CAP',
  '         name="cap1-2g" type="wifi" max-l2mtu=1560 vrf=main mac-address=CC:2D:E0:00:00:32 link-downs=0',
  '',
  '### /routing ospf neighbor print detail without-paging',
  '# collected-at: 2026-11-07T09:42:18Z',
  'Flags: D - DYNAMIC',
  '0 D instance=v2inst area=backbone_v2 interface=bridge address=192.168.0.6 priority=1 router-id=169.254.0.6 dr=192.168.0.251 bdr=192.168.0.250 state="Full" state-changes=5 adjacency=8h13m42s timeout=32s',
  '',
  '2 D instance=v3inst area=backbone_v3 interface=bridge address=fe80::2ec8:1bff:fe00:6 priority=1 router-id=169.254.0.6 dr=169.254.0.253 bdr=169.254.0.252 state="Full" state-changes=6 adjacency=8h13m41s timeout=32s',
  ''].join('\n');
const NEIGHBOR_WRAP = ['DEV-001 (10.101.88.1):',
  '### /ip neighbor print detail without-paging',
  '# collected-at: 2026-11-07T09:41:40Z',
  ' 3  interface=ether2,bridge address=10.101.59.254 address4=10.101.59.254 address6=fd00:db8:21::6 mac-address=2C:C8:1B:00:00:01 identity="DEV-002" platform="MikroTik" version="7.25.1 2026-11-02 12:39:53" unpack=none age=13m33s uptime=8h31s software-id="REDACTED" board="RBwAPGR-5HacD2HnD" ipv6=yes interface-name="bridge/ether1" system-description="MikroTik RouterOS 7.25.1 2026-11-02 12:39:53 RBwAPGR-5HacD2HnD" system-caps=bridge,router system-caps-enabled=bridge,router discovered-by=lldp,mndp'].join('\n');
/** fixture 裡從設備標頭起、去掉 skip 範圍（[開頭行的文字, 結束前的空行]）的行 */
const fixtureFrom = (f, skipHead) => {
  const lines = read(`tests/fixtures/real/${f}`).replace(/\r\n/g, '\n').split('\n');
  const body = lines.slice(lines.findIndex((l) => DEVICE.test(l)));
  if (!skipHead) return body;
  const a = body.findIndex((l) => l.startsWith(skipHead)); const z = body.indexOf('', a);
  return body.slice(0, a).concat(body.slice(z + 1));
};

test('折行（helper）：依 80 欄重新折行可逐字重現實機輸出（RB3011 的路由、介面、OSPF、routerboard 提示；RB5009 的介面、OSPF、bridge monitor）', () => {
  // RB3011：只比到 bridge port monitor 之前（多欄的 monitor 不模擬）
  const rb3011 = fixtureFrom('7.25.1-RB3011UiAS.txt', '12  D');
  const end = rb3011.findIndex((l) => /bridge port monitor/.test(l));
  assert.deepStrictEqual(rewrap(RB3011, 80).split('\n'), rb3011.slice(0, end));
  // RB5009：鄰居表經手動刪減欄位（換行位置與欄位不再對得上），從介面開始比
  const rb5009 = fixtureFrom('7.24.4-RB5009UG+S+.txt');
  const from = (ls) => ls.slice(ls.findIndex((l) => l.startsWith('### /interface print')));
  assert.deepStrictEqual(from(rewrap(RB5009, 80).split('\n')), from(rb5009).slice(0, -1), 'fixture 最後是換行');
});

test('折行：實機片段依 60／79／100／132／511 欄重新折行，事實與 findings 都不變、沒有 I01／I03', () => {
  sameAtAllWidths('RB5009', RB5009, build(fixtureFrom('7.24.4-RB5009UG+S+.txt').join('\n')));
  sameAtAllWidths('RB3011', RB3011, build(rewrap(RB3011, 80)));
  sameAtAllWidths('neighbor-wrap', NEIGHBOR_WRAP, build(read('tests/fixtures/real/7.25.1-neighbor-wrap.txt')));
  const stats = read('tests/fixtures/real/7.x-defconf-fwstats.txt');
  sameAtAllWidths('fwstats', stats, build(stats));
  // 實機 fixture 的表格註解都很短：另以 tests/core/fwstats.js 的長註解（含中文、regex）測硬切
  const LONG = ['RT_A (10.0.0.1):', '### /ip firewall filter print stats detail without-paging',
    'Flags: X - disabled, I - invalid; D - dynamic', 'Columns: CHAIN, ACTION, BYTES, PACKETS',
    ' #   CHAIN    ACTION                         BYTES  PACKETS',
    ';;; special dummy rule to show fasttrack counters',
    ' 0 D forward  passthrough               50 507 925   50 048',
    ';;; (quake3)udplite, dccp, and sctp are built-in services of conntracking. Since these are not separately loaded modules, they cannot be disabled separately',
    ' 1   input    accept                           312        3',
    ';;; redirect NTP 錯誤比較少，這一條註解寫得比較長一點，用來測試中文的註解在硬切之後是否仍能接回原本的樣子',
    ' 2 X forward  add-src-to-address-list            0        0',
    ';;; #(last|frst|[0-9]+)\\.(acpt|dlst|rtrn|reject|drop)\\.(flt|nat)(4|6) and some more words to make it long enough',
    ' 3   forward  drop                       1 806 976   23 776'].join('\n');
  sameAtAllWidths('fwstats-long', LONG, build(LONG));
  // 確實有折行：寬度越窄行數越多
  [RB5009, RB3011, NEIGHBOR_WRAP, LONG].forEach((u) => assert.ok(rewrap(u, 60).split('\n').length > rewrap(u, 511).split('\n').length));
});

test('detail：註解硬切剛好切在空白之後（行尾是空白）時，接上下一行補回那個空白', () => {
  // 硬切的行剛好是最長的一行（21 字）：寬度是接回的必要條件
  const s = build(['SW_A (10.0.0.1):', '### /interface print detail without-paging', 'Flags: R - RUNNING', ' 9  R  ;;; uplink to ', '           core', '       name="ether1"', '       type="ether"', '       mtu=1500'].join('\n'));
  assert.deepStrictEqual([s.model.interfaces.find((i) => i.key === 'SW_A|ether1').desc, s.findings.filter((f) => f.id === 'I03').length], ['uplink to core', 0]);
});

test('折行：範例資料的 detail、print stats、routerboard 區塊依各寬度重新折行，事實與 findings 都不變', () => {
  const sample = read('samples/sample-bundle.txt');
  // 範例資料刻意放的兩個問題：無法辨識的 /system clock print、bridge host 中混入的一行「```」
  sameAtAllWidths('sample-bundle', sample, build(sample), ['無法辨識的內容：t.txt 第 # 行（指令：/system clock print）',
    '1 行無法辨識，沒有進入基準：t.txt 第 # 行（/interface bridge host print detail without-paging）中的第 # 行「```」']);
});

// ---- 終端寬度：接回的必要條件
const wrapsOf = (text) => S.readers.readAll([{ name: 't.txt', text }]).blocks.filter((b) => b.command).map((b) => [b.command.split(' ').slice(0, 3).join(' '), b.wrap]);
// 硬切的註解列：剛好寫滿 len 字，下一行是註解的續行
const cutRow = (len) => { const head = ' 0  R  ;;; '; return [head + 'x'.repeat(len - head.length), '           tail', '       name="ether1"']; };
test('寬度推算：沒有記錄時，同一段中最長一行是被硬切的註解才採用（W-1）；只有下界不採用；monitor、export、一列的第二個註解不算', () => {
  // RB3011：硬切的 CAPsMAN 說明 79 字是最長的行；bridge port monitor 的 88 字、第 12 列第二個註解所在的 86 字不算
  const rb = wrapsOf(fixtureFrom('7.25.1-RB3011UiAS.txt').join('\n'));
  assert.ok(rb.length > 3 && rb.every(([, w]) => JSON.stringify(w) === JSON.stringify({ limit: 79, basis: 'inferred' })), JSON.stringify(rb));
  // neighbor-wrap：只有折行、沒有硬切的註解 → 只知道下界（最長 76 字），不採用
  assert.deepStrictEqual(wrapsOf(read('tests/fixtures/real/7.25.1-neighbor-wrap.txt')), [['/ip neighbor print', null]]);
  // 只有 monitor、export：沒有依寬度折行的行 → 寬度不明
  const mon = ['SW_A (10.0.0.1):', '### /interface bridge port monitor [find] once', `  interface: ether1 ${'x'.repeat(200)}`, '### /export terse', `/interface bridge add name=${'b'.repeat(150)}`].join('\n');
  assert.deepStrictEqual(wrapsOf(mon).map(([, w]) => w), [null, null]);
  // 同一段裡 monitor 的長行不影響 detail 的寬度，整段（同一次連線）都用；不同的設備標頭各自推算
  const two = [mon, '### /interface print detail without-paging', 'Flags: R - RUNNING', ...cutRow(59),
    'SW_B (10.0.0.2):', '### /interface print detail without-paging', 'Flags: R - RUNNING', ...cutRow(45)].join('\n');
  assert.deepStrictEqual(wrapsOf(two).map(([, w]) => w && w.limit), [59, 59, 59, 45]);
  // 硬切的註解不是最長的行：行長與硬切對不上（例如去識別化換了長度），不採用
  assert.deepStrictEqual(wrapsOf(['SW_A (10.0.0.1):', '### /interface print detail without-paging', 'Flags: R - RUNNING', ...cutRow(30),
    '       mac-address=AA:BB:CC:00:00:01 last-link-up-time=2026-10-30 14:02:23'].join('\n')).map(([, w]) => w), [null]);
  // 表格（print stats）只算 ;;; 註解行：資料列不算
  const stats = rewrap(['RT_A (10.0.0.1):', '### /ip firewall filter print stats detail without-paging', 'Columns: CHAIN, ACTION, BYTES, PACKETS',
    ' #   CHAIN    ACTION                         BYTES  PACKETS', `;;; ${'long comment '.repeat(8)}`, ' 0   input    accept                           312        3'].join('\n'), 40);
  assert.deepStrictEqual(wrapsOf(stats), [['/ip firewall filter', { limit: 39, basis: 'inferred' }]]);
  // 有記錄時用記錄的值（W-1）；同一段沒有記錄、也沒有硬切證據的區塊不採用
  const rec = wrapsOf(['SW_A (10.0.0.1):', '### /ip arp print detail', '# terminal-width: 511', ' 0 DC address=10.0.0.9 interface=ether1', '### /ip arp print detail', ' 1 DC address=10.0.0.8'].join('\n'));
  assert.deepStrictEqual(rec.map(([, w]) => w), [{ limit: 510, basis: 'recorded' }, null]);
});

test('寬度擋下誤接：前一行明顯沒寫滿時，縮排較深的下一行不當成續行（以單字開頭的續行、註解硬切），留給 I03 而不是悄悄併進上一列', () => {
  const routes = (width) => build(['R_A (10.0.0.1):', '### /ip route print detail without-paging', ...width,
    'Flags: D - DYNAMIC; X - DISABLED, A - ACTIVE; s - STATIC',
    ' 0  As  dst-address=10.0.0.0/8 routing-table=main gateway=10.0.0.254 distance=1',
    ' 1  As  dst-address=10.9.0.0/16 gateway=10.0.0.1', '         blackhole distance=1', '',
    // 硬切的註解剛好 79 字：沒有記錄時由它推得 W-1 = 79
    ` 2  As  ;;; ${'c'.repeat(67)}`, '            uplink', '         dst-address=10.8.0.0/16 gateway=10.0.0.1'].join('\n'));
  const bh = (s) => s.model.routes.find((r) => r.prefix === '10.9.0.0').blackhole || false;
  const i03Lines = (s) => s.findings.filter((f) => f.id === 'I03').map((f) => f.evidence.map((e) => e.text));
  // 有記錄（80 欄）、沒有記錄（由硬切的註解推得 79）：「第 1 列 48 字 + 1 + blackhole」沒有超過 79，不是折行
  [routes(['# terminal-width: 80']), routes([])].forEach((s) => assert.deepStrictEqual([bh(s), i03Lines(s)], [false, [['blackhole distance=1']]]));
  // 寫滿 79 字的註解：下一行照樣接回（不在 I03 中），這一列照常解析
  assert.ok(routes([]).model.routes.some((r) => r.prefix === '10.8.0.0'));
  // 記錄與輸出不符（有一行超過 W-1）：I01 指出，這一段回到只看形狀的規則（併進上一列）
  const bad = routes(['# terminal-width: 40']);
  assert.deepStrictEqual([bh(bad), i03Lines(bad), bad.blocks[0].terminalWidth], [true, [], 40]);
  assert.deepStrictEqual(bad.findings.filter((f) => f.id === 'I01').map((f) => [f.message, f.evidence.map((e) => e.text)]),
    [['收集器註解有誤：t.txt 第 3 行，終端寬度 40（每行最多 39 字）與輸出不符：第 4 行有 56 字，這段輸出的折行不以寬度判斷', ['# terminal-width: 40']]]);
  // 註解：「uplink」沒有寫滿，下一行在註解的欄位開始也不是硬切的續行
  const note = build(['SW_A (10.0.0.1):', '### /interface print detail without-paging', '# terminal-width: 80', 'Flags: R - RUNNING',
    ' 0  R  ;;; uplink', '           core', '       name="ether1" type="ether" mtu=1500'].join('\n'));
  assert.deepStrictEqual([note.model.interfaces.find((i) => i.key === 'SW_A|ether1').desc, i03Lines(note)], ['uplink', [['core']]]);
});

test('寬度 511（收集器的 +ct511w）：只有超過 510 字的列折行，折行處「這一行 + 1 + 下一個欄位」超過 510；有沒有記錄寬度，事實都和不折行相同', () => {
  const words = Array.from({ length: 60 }, (_, k) => `seg-${String(k).padStart(2, '0')}`).join(' ');
  const unwrapped = ['DEV-001 (10.101.88.1):', '### /ip neighbor print detail without-paging', '# collected-at: 2026-11-07T09:41:40Z',
    ' 0  interface=ether2,bridge address=10.101.59.254 mac-address=2C:C8:1B:00:00:01 identity="DEV-002" platform="MikroTik" discovered-by=lldp',
    '',
    ` 1  interface=ether3,bridge mac-address=2C:C8:1B:00:00:02 identity="DEV-003" system-description="${words}" system-caps=bridge,router discovered-by=lldp,mndp`,
    '',
    ' 2  interface=ether4 mac-address=2C:C8:1B:00:00:03 identity="DEV-004" discovered-by=mndp'].join('\n');
  const wrapped = rewrap(unwrapped, 511).split('\n');
  const before = unwrapped.split('\n');
  // 第 0、2 列原樣；第 1 列（超過 510 字）折成兩行以上
  assert.ok(before[5].length > 510);
  assert.deepStrictEqual([wrapped.slice(0, 5), wrapped.slice(-2)], [before.slice(0, 5), before.slice(-2)]);
  const row1 = wrapped.slice(5, -2);
  assert.ok(row1.length >= 2 && row1.every((l) => l.length <= 510), JSON.stringify(row1.map((l) => l.length)));
  // 第一行在欄位之間換行：下一個欄位是整個 system-description；之後在值裡斷開：下一段放不下
  const desc = tokens(before[5]).find((x) => x.startsWith('system-description='));
  assert.ok(row1[0].length + 1 + desc.length > 510 && row1[1].trim().startsWith('system-description='), JSON.stringify(row1.slice(0, 2)));
  row1.slice(1, -1).forEach((l, k) => assert.ok(l.length + 1 + row1[k + 2].trim().split(/\s/)[0].length > 510, `第 ${k + 1} 行沒有寫滿：${l.length}`));
  const base = build(unwrapped);
  [wrapped.join('\n'), withWidth(wrapped.join('\n'), 511)].forEach((text, k) => {
    const s = build(text);
    assert.deepStrictEqual([unparsed(s), facts(s)], [[], facts(base)], k ? '有記錄寬度' : '沒有記錄寬度');
  });
  assert.strictEqual(build(withWidth(wrapped.join('\n'), 511)).blocks[0].terminalWidth, 511);
});
