// F 檢查與 L4 共用同一套 chain 判斷（S.infer.fw.decide）：條件無法判斷、會改變結果時，檢查不報（以前把這種規則當作不存在），
// 暴露清單（Q.exposure）也是「無法判斷」。F07 報出的服務在暴露清單「外部 → 網路設備本身」一定是允許，沒有報的不會是允許。
'use strict';
const assert = require('assert');
const { S, build, test, fws } = require('../lib.js');

const RT = 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC';
/** 一台 WAN＝ether1（198.51.100.2/30）、LAN＝bridge1 的路由器；只開 winbox（tcp/8291），其他服務停用。 */
const box = (lines) => build(['R (192.168.1.1):', '### /export terse', '/interface bridge add name=bridge1',
  '/interface list add name=WAN', '/interface list add name=LAN', '/interface list member add interface=bridge1 list=LAN', '/interface list member add interface=ether1 list=WAN',
  '/ip address add address=192.168.1.1/24 interface=bridge1 network=192.168.1.0', '/ip address add address=198.51.100.2/30 interface=ether1 network=198.51.100.0',
  ...['api', 'api-ssl', 'ftp', 'ssh', 'telnet', 'www', 'www-ssl'].map((n) => `/ip service set ${n} disabled=yes`),
  ...lines,
  '### /ip route print detail without-paging', RT,
  ' DAc dst-address=192.168.1.0/24 routing-table=main gateway=bridge1 distance=0',
  ' DAc dst-address=198.51.100.0/30 routing-table=main gateway=ether1 distance=0',
  ' As dst-address=0.0.0.0/0 routing-table=main gateway=198.51.100.1 distance=1'].join('\n'));
const FF = (a) => `/ip firewall filter add ${a}`;
const winboxRow = (s) => S.query(s).exposure().self.rows.find((r) => r.ip === '198.51.100.2' && r.service === 'tcp/8291');
/** F07 是否報 winbox，以及暴露清單第 1 段 winbox 的結論（沒有列＝拒絕）。 */
const both = (s) => [fws(s, 'F07').some((f) => f.message.includes('winbox')), (winboxRow(s) || { verdict: 'deny' }).verdict];

test('F07 與暴露清單一致：條件無法判斷的 drop（time=、src-address-list）在前時，F07 不報，暴露清單是無法判斷', () => {
  // time= 的內容無法判斷：以前把這條 drop 當作不存在，F07 報出 winbox；Q.reach 是無法判斷
  assert.deepStrictEqual(both(box([FF('action=drop chain=input in-interface-list=WAN time=0s-1h,mon')])), [false, 'unknown']);
  // src-address-list 的內容不在基準：以前假設攻擊者不在名單內（F07 報），Q.reach 是無法判斷
  assert.deepStrictEqual(both(box([FF('action=drop chain=input src-address-list=blocked'), FF('action=drop chain=input in-interface-list=!LAN disabled=yes')])), [false, 'unknown']);
  // 對照：沒有任何 drop 時兩邊都是允許；確定命中的 drop 時兩邊都是拒絕
  assert.deepStrictEqual(both(box([FF('action=accept chain=input protocol=icmp')])), [true, 'allow']);
  assert.deepStrictEqual(both(box([FF('action=drop chain=input in-interface-list=WAN')])), [false, 'deny']);
});

test('F07 與暴露清單一致：tcp-flags 依新連線的 SYN 判斷；raw notrack 之後連線狀態是 untracked（只擋 new 的 drop 不命中）', () => {
  assert.deepStrictEqual(both(box([FF('action=drop chain=input in-interface-list=WAN protocol=tcp tcp-flags=syn')])), [false, 'deny']);
  assert.deepStrictEqual(both(box([FF('action=drop chain=input in-interface-list=WAN protocol=tcp tcp-flags=!syn')])), [true, 'allow']);
  const nt = box(['/ip firewall raw add action=notrack chain=prerouting in-interface-list=WAN', FF('action=drop chain=input connection-state=new in-interface-list=WAN')]);
  assert.deepStrictEqual(both(nt), [true, 'allow']);
});

test('F03：放行規則前面有條件無法判斷的 drop 時不報（無法判斷）；來源埠由用戶端自選，前面只限來源埠的 drop 也是無法判斷', () => {
  const open = FF('action=accept chain=input dst-port=8291 protocol=tcp');
  assert.strictEqual(fws(box([open]), 'F03').length, 1, '對照：沒有其他規則時報');
  assert.strictEqual(fws(box([FF('action=drop chain=input in-interface-list=WAN time=0s-1h,mon'), open]), 'F03').length, 0);
  assert.strictEqual(fws(box([FF('action=drop chain=input protocol=tcp src-port=1-1023'), open]), 'F03').length, 0);
});

test('S.infer.fw.evalChain／evalFilter：decide 的包裝；無法判斷時 verdict 為 unknown 並列出規則，不略過', () => {
  const fw = S.infer.fw;
  const rules = [{ key: 'a', position: 1, family: 'ip', table: 'filter', chain: 'input', action: 'drop', match: { time: '0s-1h,mon' }, params: {}, disabled: false },
    { key: 'b', position: 2, family: 'ip', table: 'filter', chain: 'input', action: 'accept', match: { protocol: 'tcp' }, params: {}, disabled: false }];
  const ctx = fw.fwContext('R', [], ['R|ether1'], rules);
  const r = fw.evalFilter(ctx, 'ip', 'input', fw.wanPacket('ip', 'R|ether1', 'input', { dstPort: 22 }));
  assert.deepStrictEqual([r.verdict, r.rule, r.uncertain.map((u) => [u.rule.key, u.keys])], ['unknown', null, [['a', ['time']]]]);
  const ok = fw.evalChain(fw.fwContext('R', [], ['R|ether1'], rules.slice(1)), 'ip', 'filter', 'input', fw.wanPacket('ip', 'R|ether1', 'input', { dstPort: 22 }));
  assert.deepStrictEqual([ok.verdict, ok.rule.key], ['accept', 'b']);
  // 沒有規則決定：filter 為內建 chain 的預設放行（policy），nat 為 null
  const none = fw.fwContext('R', [], ['R|ether1'], []);
  assert.deepStrictEqual([fw.evalFilter(none, 'ip', 'input', fw.wanPacket('ip', 'R|ether1', 'input')).policy, fw.evalFilter(none, 'ip', 'dstnat', fw.wanPacket('ip', 'R|ether1', 'dstnat'), 'nat').verdict], [true, null]);
});

test('對外入口 S.infer.fw.wanEntries：沒有介面紀錄的成員視為 main；非 main VRF 的 WAN 成員是 F03 的入口，但不是 F07（/ip service 在 main）的入口，和暴露清單一致', () => {
  const fw = S.infer.fw;
  const ctx = fw.fwContext('R', [{ name: 'WAN', defined: true, include: [], exclude: [], members: ['R|ether2', 'R|ether1'] }], ['R|ether1'], []);
  assert.deepStrictEqual(fw.wanEntries(ctx, (ep) => (ep === 'R|ether1' ? 'cust' : undefined)),
    [{ dev: 'R', ep: 'R|ether1', vrf: 'cust', hasIfc: true, wanList: true }, { dev: 'R', ep: 'R|ether2', vrf: 'main', hasIfc: false, wanList: true }]);
  assert.deepStrictEqual(fw.wanEntries(fw.fwContext('R', [], [], []), () => undefined), [], '沒有 WAN 清單時沒有入口');
  // WAN（ether1）在 VRF cust：winbox 從 WAN 連不到（服務在 main），F03 的放行規則仍從 WAN 走得到
  const s = box(['/ip vrf add interfaces=ether1 name=cust', FF('action=accept chain=input dst-port=8291 protocol=tcp')]);
  assert.deepStrictEqual([fws(s, 'F07').length, fws(s, 'F03').length, winboxRow(s)], [0, 1, undefined]);
  assert.deepStrictEqual(both(box([FF('action=accept chain=input dst-port=8291 protocol=tcp')])), [true, 'allow'], '對照：WAN 在 main');
});
