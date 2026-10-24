// Wi-Fi 關聯表與位置
'use strict';
const assert = require('assert');
const { build, ids, iface, test } = require('../lib.js');
// ------------------------------------------------------------------ Wi-Fi 關聯表與位置
// 測試資料依 RouterOS 手冊的欄位撰寫（/interface wifi｜wireless registration-table、/caps-man registration-table），不是實機擷取
const WIFI7 = ['AP_1 (10.0.0.11):', '### /interface wifi registration-table print detail without-paging', 'Flags: A - AUTHORIZED',
  ' 0 A interface=wifi1 ssid="Corp" mac-address=AA:BB:CC:00:10:01 uptime=1h2m3s last-activity=120ms signal=-58 band=5ghz-ax',
  '     auth-type=wpa2-eap eap-identity="alice@corp" eap-username="alice" vlan-id=30 dhcp-address=10.1.30.11 dhcp-hostname="alice-nb"'].join('\n');
test('Wi-Fi 關聯表（RouterOS 7）：續行、時間與訊號、DHCP 主機名；帳號欄位不寫進基準', () => {
  const s = build(WIFI7);
  assert.deepStrictEqual(s.model.wifiAssociations.map((a) => [a.ep, a.mac, a.ssid, a.band, a.vlan, a.uptime, a.lastActivity, a.signal, a.ip, a.hostname]),
    [['AP_1|wifi1', 'AABBCC001001', 'Corp', '5ghz-ax', 30, 3723, 0.12, -58, '10.1.30.11', 'alice-nb']]);
  assert.ok(!/alice@corp|"alice"/.test(JSON.stringify(s)), 'eap-identity／eap-username 不可進入基準');
  const w = s.model.macs.find((m) => m.mac === 'AABBCC001001').wifi;
  assert.deepStrictEqual([w.basis, w.dev, w.ep, w.ssid, w.roaming], ['registration', 'AP_1', 'AP_1|wifi1', 'Corp', false]);
  assert.deepStrictEqual([iface(s, 'AP_1|wifi1').type, iface(s, 'AP_1|wifi1').typeBasis], ['wireless', 'assoc']);
  assert.ok(s.model.devices.find((d) => d.key === 'AP_1').data.includes('wifireg'));
  assert.ok(!ids(s).includes('I01'));
});
test('Wi-Fi 關聯表（舊版 wireless、CAPsMAN）：signal-strength、last-ip；略過 ap=yes 的對端 AP', () => {
  const s = build(['AP_2 (10.0.0.12):', '### /interface wireless registration-table print detail without-paging',
    ' 0 interface=wlan1 mac-address=AA:BB:CC:00:10:02 ap=no wds=no signal-strength=-62dBm@6Mbps uptime=2m last-activity=1s last-ip=10.1.30.12',
    ' 1 interface=wlan1 mac-address=AA:BB:CC:00:10:0F ap=yes wds=no signal-strength=-50dBm@6Mbps uptime=1d last-activity=0ms',
    'CAPSMAN (10.0.0.13):', '### /caps-man registration-table print detail without-paging',
    ' 0 interface=cap1 ssid="Guest" mac-address=AA:BB:CC:00:10:04 rx-signal=-70 uptime=5m last-ip=10.1.40.5'].join('\n'));
  assert.deepStrictEqual(s.model.wifiAssociations.map((a) => [a.ep, a.mac, a.signal, a.ip, a.ssid, a.lastActivity]),
    [['AP_2|wlan1', 'AABBCC001002', -62, '10.1.30.12', null, 1], ['CAPSMAN|cap1', 'AABBCC001004', -70, '10.1.40.5', 'Guest', null]]);
});
test('Wi-Fi 漫遊：多台 AP 的關聯表都有同一 MAC 時取 last-activity 最近者，其餘列為候選', () => {
  const s = build(WIFI7.replace('last-activity=120ms', 'last-activity=5s') + '\n' + ['AP_2 (10.0.0.12):', '### /interface wifi registration-table print detail without-paging',
    ' 0 A interface=wifi2 ssid="Corp" mac-address=AA:BB:CC:00:10:01 uptime=10s last-activity=200ms signal=-61 band=5ghz-ax'].join('\n'));
  const w = s.model.macs.find((m) => m.mac === 'AABBCC001001').wifi;
  assert.deepStrictEqual([w.basis, w.ep, w.candidates, w.roaming], ['registration', 'AP_2|wifi2', ['AP_1|wifi1'], true]);
});
test('Wi-Fi 關聯表：沒有客戶端（只有說明行）記為已收集；指令不存在的錯誤回應列為 I01', () => {
  const empty = build('AP_1 (10.0.0.11):\n### /interface wifi registration-table print detail without-paging\nFlags: A - AUTHORIZED\n');
  assert.ok(!ids(empty).includes('I01'));
  assert.ok(empty.model.devices[0].data.includes('wifireg'));
  const bad = build('SW_A (10.0.0.1):\n### /interface wifi registration-table print detail without-paging\nbad command name registration-table (line 1 column 16)\n');
  assert.ok(ids(bad).includes('I01'));
});
test('Wi-Fi 位置推定：無線介面的 MAC 表、經由 AP 的交換器埠；有線終端與 AP 自己的 MAC 不套用', () => {
  const ap = build(['AP_1 (10.0.0.11):', '### /interface print detail without-paging', ' 0 R name="wifi1" type="wifi" mtu=1500',
    '### /interface bridge host print detail without-paging', ' 0 D mac-address=AA:BB:CC:00:20:01 on-interface=wifi1 bridge=bridge1 vid=0'].join('\n'));
  assert.deepStrictEqual(Object.values(ap.model.macs.find((m) => m.mac === 'AABBCC002001').wifi).slice(0, 3), ['bridge-wifi', 'AP_1', 'AP_1|wifi1']);
  const sw = build(['SW_A (10.0.0.1):', '### /ip neighbor print detail without-paging',
    ' 0 interface=ether5 mac-address=AA:BB:CC:00:00:A9 identity=AP_9 platform=MikroTik board="cAP ac" interface-name=ether1 system-caps-enabled=bridge,wlan-ap',
    '### /interface bridge host print detail without-paging',
    ' 0 D mac-address=AA:BB:CC:00:00:A9 on-interface=ether5 bridge=bridge1 vid=0', ' 1 D mac-address=AA:BB:CC:00:20:02 on-interface=ether5 bridge=bridge1 vid=0',
    ' 2 D mac-address=AA:BB:CC:00:20:03 on-interface=ether6 bridge=bridge1 vid=0', ' 3 D mac-address=AA:BB:CC:00:20:03 on-interface=ether5 bridge=bridge1 vid=0'].join('\n'));
  const wifi = (mk) => sw.model.macs.find((m) => m.mac === mk).wifi;
  assert.deepStrictEqual([wifi('AABBCC002002').basis, wifi('AABBCC002002').dev, wifi('AABBCC002002').ep], ['via-ap-port', 'AP_9', 'SW_A|ether5']);
  assert.strictEqual(wifi('AABBCC0000A9'), null, 'AP 自己的 MAC 不是 Wi-Fi 客戶端');
  assert.strictEqual(wifi('AABBCC002003'), null, '同時是有線終端埠（ether6）的 MAC，即使也出現在 AP 埠也不推定為 Wi-Fi');
});
