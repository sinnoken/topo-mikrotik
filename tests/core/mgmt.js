// 管理面設定（mgmtSettings）的解析、出廠預設值與 F10–F14、Q.mgmtOf
// 測試資料依 RouterOS 手冊（7.24–7.26）各選單的參數撰寫，不是實機擷取；預設值見 S.MGMT_DEFAULTS
'use strict';
const assert = require('assert');
const { S, build, ids, test, fwBox, fws } = require('../lib.js');

// fwBox：第 1 行設備標頭、第 2 行 /export terse、第 3–7 行 bridge1 與 WAN（ether1，第 7 行）／LAN（bridge1）清單，傳入的行從第 8 行起
const WAN_LINE = 7;
const DROP = '/ip firewall filter add action=drop chain=input in-interface-list=!LAN';
const mg = (s, dev = 'R') => S.query(s).mgmtOf(dev);
const lines = (f) => f.evidence.map((e) => e.line);

test('管理面設定：export 有寫的是事實（basis export、行號），沒寫的以出廠預設值補上（defaulted、basis default），每行都有歸屬（沒有 I03）', () => {
  const s = fwBox(['/ip dns set allow-remote-requests=yes servers=1.1.1.1', '/tool mac-server set allowed-interface-list=LAN',
    '/tool/mac-server/mac-winbox set allowed-interface-list=none', '/ip neighbor discovery-settings set discover-interface-list=LAN protocol=lldp',
    '/snmp set enabled=yes location=lab', '/snmp community set [ find default=yes ] addresses=10.0.0.0/24 name=nms', '/snmp community add name=rw write-access=yes',
    '/ip upnp set enabled=yes', '/ip upnp interfaces add interface=ether1 type=external', '/ip upnp interfaces add interface=bridge1 type=internal',
    '/ip proxy set enabled=yes port=8080,3128', '/ip socks set port=1081', '/tool bandwidth-server set authenticate=no']);
  assert.ok(!ids(s).includes('I03'), JSON.stringify(s.findings.filter((f) => f.id === 'I03').map((f) => f.message)));
  const m = mg(s);
  assert.deepStrictEqual([m.dns.allowRemote, m.dns.vrf, m.dns.basis, m.dns.defaulted, m.dns.src.map((x) => x[1])], [true, 'main', 'export', ['vrf'], [8]]);
  assert.deepStrictEqual([m.macServer.allowedList, m.macServer.basis, m.macServer.src.map((x) => x[1])], ['LAN', 'export', [9]]);
  assert.deepStrictEqual([m.macWinbox.allowedList, m.macWinbox.src.map((x) => x[1])], ['none', [10]], 'RouterOS 7 的斜線路徑也認得');
  assert.deepStrictEqual([m.discovery.list, m.discovery.protocols, m.discovery.mode, m.discovery.defaulted], ['LAN', ['lldp'], 'tx-and-rx', ['mode']]);
  assert.deepStrictEqual([m.snmp.enabled, m.snmp.basis], [true, 'export']);
  assert.deepStrictEqual(m.snmp.communities.map((c) => [c.name, c.addresses, c.write, c.isDefault, c.basis, c.src.map((x) => x[1])]),
    [['nms', ['10.0.0.0/24'], false, true, 'export', [13]], ['rw', ['::/0'], true, false, 'export', [14]]], '[ find default=yes ] 改的是出廠的 community；add 沒寫的欄位是預設值');
  assert.deepStrictEqual(m.snmp.communities[1].defaulted, ['addresses', 'security', 'disabled']);
  assert.deepStrictEqual(m.upnp.interfaces.map((x) => [x.ep, x.type]), [['R|ether1', 'external'], ['R|bridge1', 'internal']]);
  assert.deepStrictEqual([m.proxy.enabled, m.proxy.ports], [true, [8080, 3128]]);
  assert.deepStrictEqual([m.socks.enabled, m.socks.port, m.socks.defaulted], [false, 1081, ['enabled', 'vrf']]);
  assert.deepStrictEqual([m.bandwidthServer.enabled, m.bandwidthServer.authenticate, m.bandwidthServer.defaulted, m.bandwidthServer.basis], [true, false, ['enabled'], 'export']);
  // 沒有任何管理面設定：全部是預設值
  const d = mg(fwBox([]));
  assert.deepStrictEqual(['dns', 'macServer', 'macWinbox', 'discovery', 'snmp', 'upnp', 'proxy', 'socks', 'bandwidthServer'].map((k) => d[k].basis), Array(9).fill('default'));
  assert.deepStrictEqual([d.dns.allowRemote, d.macServer.allowedList, d.discovery.list, d.snmp.enabled, d.upnp.enabled, d.proxy.enabled, d.socks.enabled, d.bandwidthServer.enabled],
    [false, 'all', 'static', false, false, false, false, true]);
  assert.deepStrictEqual(d.snmp.communities.map((c) => [c.name, c.addresses, c.isDefault, c.basis, c.src]), [['public', ['::/0'], true, 'default', []]]);
  assert.ok(d.macServer.src.length === 0 && d.macServer.defaulted.includes('allowedList'));
});

test('管理面設定：compact export（選單路徑另起一行、續行）也認得；沒有 export 的設備沒有這一筆（Q.mgmtOf 為 null），也不產生 F10–F14', () => {
  const s = build(['R (10.0.0.1):', '### /export', '/interface list', 'add name=WAN', '/interface list member', 'add interface=ether1 list=WAN',
    '/tool mac-server mac-winbox', 'set allowed-interface-list=\\', '    LAN', '/snmp community', 'set [ find default=yes ] addresses=10.0.0.0/24 \\', '    name=nms'].join('\n'));
  assert.ok(!ids(s).includes('I03'));
  const m = mg(s);
  assert.deepStrictEqual([m.macWinbox.allowedList, m.macWinbox.src.map((x) => x[1])], ['LAN', [8]]);
  assert.deepStrictEqual(m.snmp.communities.map((c) => [c.name, c.addresses]), [['nms', ['10.0.0.0/24']]]);
  const p = build(['SW (10.0.0.2):', '### /interface print detail', ' 0 R name="ether1" type="ether" mtu=1500'].join('\n'));
  assert.strictEqual(mg(p, 'SW'), null);
  assert.ok(!ids(p).some((id) => /^F1[0-4]$/.test(id)));
  assert.deepStrictEqual(p.model.mgmtSettings, []);
  assert.strictEqual(S.query.mgmtDefaults(), S.MGMT_DEFAULTS);
  assert.ok(Object.isFrozen(S.MGMT_DEFAULTS) && Object.isFrozen(S.MGMT_DEFAULTS.snmp.community.addresses));
});

test('F10：DNS 允許遠端查詢，且 WAN 進來的 UDP／TCP 53 會被 input 放行；沒開、input 擋下或沒有 /ip dns 時不報', () => {
  const s = fwBox(['/ip dns set allow-remote-requests=yes']);
  const f = fws(s, 'F10');
  assert.strictEqual(f.length, 1);
  assert.ok(/allow-remote-requests=yes/.test(f[0].message) && /IPv4 udp\/53 從 ether1/.test(f[0].message) && /IPv4 tcp\/53/.test(f[0].message), f[0].message);
  assert.strictEqual(f[0].basis, 'export');
  assert.deepStrictEqual(lines(f[0]), [8, WAN_LINE], '證據：dns 那一行與 WAN 的成員行');
  const allowLan = fwBox(['/ip dns set allow-remote-requests=yes', '/ip firewall filter add action=accept chain=input dst-port=53 protocol=udp', DROP]);
  assert.deepStrictEqual(lines(fws(allowLan, 'F10')[0]), [8, WAN_LINE, 9], '放行的規則也列為證據；TCP 被最後的 drop 擋下');
  assert.ok(!/tcp\/53/.test(fws(allowLan, 'F10')[0].message));
  assert.strictEqual(fws(fwBox(['/ip dns set allow-remote-requests=yes', DROP]), 'F10').length, 0, 'input 擋下 WAN');
  assert.strictEqual(fws(fwBox(['/ip dns set allow-remote-requests=no servers=1.1.1.1']), 'F10').length, 0);
  assert.strictEqual(fws(fwBox([]), 'F10').length, 0, '沒有 /ip dns：預設不回應遠端查詢');
});

test('F11：MAC Telnet／MAC WinBox 的 allowed-interface-list 含 WAN（預設 all 為推論）；LAN、none 不報；WAN 埠所在的 bridge 在清單中也算', () => {
  const def = fws(fwBox([]), 'F11');
  assert.deepStrictEqual(def.map((f) => [f.facet, f.basis]), [['mac-telnet', 'default'], ['mac-winbox', 'default']]);
  assert.ok(def.every((f) => /「all」，預設值：export 沒有寫出/.test(f.message)), def[0].message);
  assert.deepStrictEqual(def.map(lines), [[WAN_LINE], [WAN_LINE]], '預設值沒有設定行，證據是 WAN 的成員行');
  const lan = fwBox(['/tool mac-server set allowed-interface-list=LAN', '/tool mac-server mac-winbox set allowed-interface-list=none']);
  assert.strictEqual(fws(lan, 'F11').length, 0);
  const all = fwBox(['/tool mac-server set allowed-interface-list=LAN', '/tool mac-server mac-winbox set allowed-interface-list=all']);
  assert.deepStrictEqual(fws(all, 'F11').map((f) => [f.facet, f.basis, lines(f)]), [['mac-winbox', 'export', [9, WAN_LINE]]]);
  // WAN 埠是 bridge 的成員、清單裡放的是 bridge（手冊：bridge 在清單中時，經由它的埠進來的連線也接受）
  const br = fwBox(['/interface bridge port add bridge=bridge1 interface=ether1', '/tool mac-server set allowed-interface-list=LAN', '/tool mac-server mac-winbox set allowed-interface-list=LAN']);
  assert.deepStrictEqual(fws(br, 'F11').map((f) => f.facet), ['mac-telnet', 'mac-winbox']);
  // 清單無法展開（未定義的清單）時不猜
  assert.strictEqual(fws(fwBox(['/tool mac-server set allowed-interface-list=MGMT', '/tool mac-server mac-winbox set allowed-interface-list=MGMT']), 'F11').length, 0);
});

test('F12：鄰居探索的 discover-interface-list 含 WAN（預設 static 為推論）；LAN、protocol 空白、rx-only 不報；!dynamic 也算全部', () => {
  const def = fws(fwBox([]), 'F12');
  assert.deepStrictEqual(def.map((f) => [f.basis, lines(f)]), [['default', [WAN_LINE]]]);
  assert.ok(/「static」，預設值/.test(def[0].message) && /cdp,lldp,mndp/.test(def[0].message), def[0].message);
  assert.strictEqual(fws(fwBox(['/ip neighbor discovery-settings set discover-interface-list=LAN']), 'F12').length, 0);
  assert.strictEqual(fws(fwBox(['/ip neighbor discovery-settings set protocol=""']), 'F12').length, 0, '不跑任何協定');
  assert.strictEqual(fws(fwBox(['/ip neighbor discovery-settings set mode=rx-only']), 'F12').length, 0, '只收不送');
  const nd = fws(fwBox(['/ip neighbor discovery-settings set discover-interface-list=!dynamic']), 'F12');
  assert.deepStrictEqual(nd.map((f) => [f.basis, lines(f)]), [['export', [8, WAN_LINE]]]);
  assert.strictEqual(fws(fwBox(['/ip neighbor discovery-settings set discover-interface-list=!WAN']), 'F12').length, 0, '!WAN 不含 WAN');
});

test('F13：SNMP 開著且 community 是 public 或不限來源（含出廠預設 community）；SNMP 沒開、改名又限來源、停用的 community 不報；不需要 WAN', () => {
  const def = fws(fwBox(['/snmp set enabled=yes']), 'F13');
  assert.deepStrictEqual(def.map((f) => [f.facet, f.basis, lines(f)]), [['public', 'default', [8]]]);
  assert.ok(/名稱是 public（預設值/.test(def[0].message) && /不限來源位址（addresses=::\/0，預設值/.test(def[0].message) && /出廠的預設 community/.test(def[0].message), def[0].message);
  assert.strictEqual(fws(fwBox([]), 'F13').length, 0, 'SNMP 預設沒開');
  const ok = fwBox(['/snmp set enabled=yes', '/snmp community set [ find default=yes ] addresses=10.0.0.0/24 name=nms']);
  assert.strictEqual(fws(ok, 'F13').length, 0);
  const add = fwBox(['/snmp set enabled=yes', '/snmp community set [ find default=yes ] disabled=yes', '/snmp community add name=rw write-access=yes',
    '/snmp community add addresses=10.0.0.0/24 name=public']);
  assert.deepStrictEqual(fws(add, 'F13').map((f) => [f.facet, f.basis, lines(f)]), [['public', 'export', [8, 11]], ['rw', 'default', [8, 10]]]);
  assert.ok(/可以寫入（write-access=yes）/.test(fws(add, 'F13').find((f) => f.facet === 'rw').message));
  const set = fwBox(['/snmp set enabled=yes', '/snmp community add addresses=10.0.0.0/24 name=a', '/snmp community set a addresses=0.0.0.0/0']);
  assert.deepStrictEqual(fws(set, 'F13').map((f) => [f.facet, f.basis]), [['a', 'export'], ['public', 'default']], '以名稱 set 的 community');
  const noWan = fwBox(['/snmp set enabled=yes'], { noLists: true });
  assert.strictEqual(fws(noWan, 'F13').length, 1, '不需要 WAN');
});

test('F14：UPnP 的 internal 介面是 WAN、web proxy／SOCKS／bandwidth-server 開著且 WAN 可以連入；擋下、關閉、internal 只放 LAN 時不報', () => {
  const off = '/tool bandwidth-server set enabled=no';
  const s = fwBox([off, '/ip upnp set enabled=yes', '/ip upnp interfaces add interface=ether1 type=internal', '/ip proxy set enabled=yes', '/ip socks set enabled=yes port=1081']);
  assert.deepStrictEqual(fws(s, 'F14').map((f) => [f.facet, f.basis, lines(f)]).sort(), [['proxy', 'export', [11, WAN_LINE]], ['socks', 'export', [12, WAN_LINE]], ['upnp', 'export', [9, 10]]]);
  assert.ok(/tcp\/8080 從 ether1/.test(fws(s, 'F14').find((f) => f.facet === 'proxy').message));
  assert.ok(/tcp\/1081/.test(fws(s, 'F14').find((f) => f.facet === 'socks').message));
  assert.strictEqual(fws(fwBox([off, '/ip proxy set enabled=yes', '/ip socks set enabled=yes', DROP]), 'F14').length, 0, 'input 擋下 WAN');
  assert.strictEqual(fws(fwBox([off, '/ip upnp set enabled=yes', '/ip upnp interfaces add interface=ether1 type=external', '/ip upnp interfaces add interface=bridge1 type=internal']), 'F14').length, 0);
  assert.strictEqual(fws(fwBox([off, '/ip upnp interfaces add interface=ether1 type=internal']), 'F14').length, 0, 'UPnP 沒開');
  // bandwidth-server 出廠是開的（推論），訊息註明 device-mode 看不出來
  const bw = fws(fwBox([]), 'F14');
  assert.deepStrictEqual(bw.map((f) => [f.facet, f.basis, lines(f)]), [['bandwidth-server', 'default', [WAN_LINE]]]);
  assert.ok(/tcp\/2000/.test(bw[0].message) && /device-mode/.test(bw[0].message), bw[0].message);
  assert.ok(/不需要登入/.test(fws(fwBox(['/tool bandwidth-server set authenticate=no']), 'F14')[0].message));
  assert.strictEqual(fws(fwBox([off]), 'F14').length, 0);
});

test('F10／F11／F12／F14：沒有 WAN 判斷時不檢查（F08 說明），不猜', () => {
  const lines = ['/ip dns set allow-remote-requests=yes', '/ip proxy set enabled=yes', '/ip firewall filter add action=accept chain=input protocol=icmp'];
  [fwBox(lines, { noLists: true }), fwBox(lines, { emptyWan: true })].forEach((s) => {
    assert.deepStrictEqual(['F10', 'F11', 'F12', 'F14'].filter((id) => fws(s, id).length), []);
    assert.strictEqual(fws(s, 'F08').length, 1);
  });
});

// ---- 審查 r19 的修正：部分 export、VRF、同名 community、預設值的版本範圍
const F1x = (s) => s.findings.filter((f) => /^F1[0-4]$/.test(f.id));
const partial = (hdr, extra = []) => build(['R (10.0.0.1):', `### ${hdr}`, '/interface list', 'add name=WAN', '/interface list member', 'add interface=ether1 list=WAN',
  '/ip firewall filter', 'add action=accept chain=input', ...extra].join('\n'));
const AREAS = ['dns', 'macServer', 'macWinbox', 'discovery', 'snmp', 'upnp', 'proxy', 'socks', 'bandwidthServer'];

test('管理面設定：部分 export（/ip firewall export、/interface list export、/ip export、沒有指令標記）沒寫出的選單不補預設值（basis none、reason not-exported），不產生 F10–F14', () => {
  ['/ip firewall export terse', '/interface list export', '/ip export'].forEach((hdr) => {
    const s = partial(hdr);
    assert.deepStrictEqual(F1x(s).map((f) => f.id + ':' + f.facet), [], hdr);
    const m = mg(s);
    assert.strictEqual(m.export, 'partial', hdr);
    AREAS.forEach((k) => assert.deepStrictEqual([k, m[k].basis, m[k].reason, m[k].defaulted], [k, 'none', 'not-exported', []], hdr));
    assert.deepStrictEqual([m.macServer.allowedList, m.macServer.unknown], [null, ['allowedList']]);
    assert.strictEqual(m.snmp.communities, null, '沒有出廠 community 的推定');
  });
  // 沒有指令標記的區塊：看不出是整機 export，同樣不補
  const u = build(['R (10.0.0.1):', '/interface list add name=WAN', '/interface list member add interface=ether1 list=WAN', '/ip firewall filter add action=accept chain=input'].join('\n'));
  assert.strictEqual(mg(u).export, 'partial');
  assert.deepStrictEqual(F1x(u), []);
  // 部分 export 裡出現的選單：沒寫的參數仍以預設值補上（那個選單有被 export）
  const p = partial('/ip export', ['/ip neighbor discovery-settings', 'set discover-interface-list=WAN']);
  assert.deepStrictEqual([mg(p).discovery.basis, mg(p).discovery.defaulted, mg(p).discovery.protocols], ['export', ['protocols', 'mode'], ['cdp', 'lldp', 'mndp']]);
  assert.deepStrictEqual(F1x(p).map((f) => f.id), ['F12']);
  // 整機 export：/export、/export terse、/export compact 都算
  ['/export', '/export terse', '/export compact', 'export verbose'].forEach((hdr) => assert.strictEqual(mg(partial(hdr)).export, 'full', hdr));
  // 同一台另有完整 export 時以完整的為準
  const both = build(['R (10.0.0.1):', '### /ip firewall export', '/ip firewall filter add action=accept chain=input', 'R (10.0.0.1):', '### /export terse',
    '/interface list add name=WAN', '/interface list member add interface=ether1 list=WAN'].join('\n'));
  assert.strictEqual(mg(both).export, 'full');
  assert.ok(F1x(both).some((f) => f.id === 'F11'));
});

test('F10／F14：DNS、SOCKS 只在自己的 VRF（vrf=，預設 main）回應；WAN 在其他 VRF 時不報，vrf 指到 WAN 的 VRF 時報', () => {
  const vrf = '/ip vrf add interfaces=ether1 name=wan';
  assert.deepStrictEqual(fws(fwBox([vrf, '/ip dns set allow-remote-requests=yes']), 'F10'), []);
  const inWan = fws(fwBox([vrf, '/ip dns set allow-remote-requests=yes vrf=wan']), 'F10');
  assert.strictEqual(inWan.length, 1);
  assert.ok(/vrf=wan/.test(inWan[0].message), inWan[0].message);
  assert.strictEqual(mg(fwBox([vrf, '/ip dns set allow-remote-requests=yes'])).dns.vrf, 'main');
  const off = '/tool bandwidth-server set enabled=no';
  assert.deepStrictEqual(fws(fwBox([off, vrf, '/ip socks set enabled=yes']), 'F14'), []);
  assert.deepStrictEqual(fws(fwBox([off, vrf, '/ip socks set enabled=yes vrf=wan']), 'F14').map((f) => f.facet), ['socks']);
  // proxy、bandwidth-server 的手冊沒有 vrf 參數：照舊判斷
  assert.deepStrictEqual(fws(fwBox([off, vrf, '/ip proxy set enabled=yes']), 'F14').map((f) => f.facet), ['proxy']);
});

test('F13：同名的 community 各自一筆，findingKey 不同（facet 加上內容的雜湊）；名稱不重複時 facet 仍是名稱', () => {
  const s = fwBox(['/snmp set enabled=yes', '/snmp community add name=public addresses=10.0.0.0/8']);
  const f = fws(s, 'F13');
  assert.strictEqual(f.length, 2);
  const keys = f.map((x) => JSON.stringify(S.query(s).findingKey(x)));
  assert.notStrictEqual(keys[0], keys[1]);
  assert.ok(f.every((x) => /^public#[0-9a-f]{8}$/.test(x.facet)), f.map((x) => x.facet).join());
  assert.ok(f.every((x) => /同名的 community 有 2 個/.test(x.message)), f[0].message);
  // 加在前面的設定行不影響 facet（不用行號、順序）
  const s2 = fwBox(['/ip dns set servers=1.1.1.1', '/snmp set enabled=yes', '/snmp community add name=public addresses=10.0.0.0/8']);
  assert.deepStrictEqual(fws(s2, 'F13').map((x) => x.facet).sort(), f.map((x) => x.facet).sort());
  assert.deepStrictEqual(fws(fwBox(['/snmp set enabled=yes']), 'F13').map((x) => x.facet), ['public']);
});
test('管理面設定：每個 community 都有 facet，與 F13 finding 的 facet 是同一個值（畫面直接比對）；停用的、沒有 finding 的也有', () => {
  const s = fwBox(['/snmp set enabled=yes', '/snmp community add name=public addresses=10.0.0.0/8', '/snmp community add name=mon addresses=10.0.0.0/8',
    '/snmp community add name=old disabled=yes']);
  const cs = mg(s).snmp.communities;
  assert.deepStrictEqual(cs.map((c) => c.name), ['public', 'public', 'mon', 'old']);
  assert.ok(cs.slice(0, 2).every((c) => /^public#[0-9a-f]{8}$/.test(c.facet)) && cs[0].facet !== cs[1].facet, cs.map((c) => c.facet).join());
  assert.deepStrictEqual(cs.slice(2).map((c) => c.facet), ['mon', 'old']);
  assert.deepStrictEqual(fws(s, 'F13').map((f) => f.facet).sort(), cs.slice(0, 2).map((c) => c.facet).sort());
  // 停用一個同名的之後只剩一個啟用中的 public：兩者的 facet 都回到名稱
  const one = mg(fwBox(['/snmp set enabled=yes', '/snmp community set [ find default=yes ] disabled=yes', '/snmp community add name=public addresses=10.0.0.0/8'])).snmp.communities;
  assert.deepStrictEqual(one.map((c) => [c.facet, c.disabled]), [['public', true], ['public', false]]);
});

test('管理面設定：出廠預設值只用在 RouterOS 7.24–7.26；版本在範圍外（含 v6）時沒寫的設定視為無法判斷（reason version），訊息寫出預設值的版本範圍', () => {
  const at = (ver, extra) => build(['R (10.0.0.1):', '### /export terse', `# 2026-10-13 10:00:00 by RouterOS ${ver}`, '/interface list add name=WAN',
    '/interface list member add interface=ether1 list=WAN', ...extra].join('\n'));
  ['7.12.1', '6.49.10', '7.27'].forEach((ver) => {
    const s = at(ver, ['/snmp set enabled=yes', '/tool mac-server mac-winbox set allowed-interface-list=all']);
    const m = mg(s);
    assert.deepStrictEqual([m.version, m.versionInRange, m.macServer.basis, m.macServer.reason, m.macServer.allowedList], [ver, false, 'none', 'version', null], ver);
    assert.deepStrictEqual(F1x(s).map((f) => f.id + ':' + f.facet + ':' + f.basis), ['F11:mac-winbox:export'], ver);
  });
  // 範圍內：預設值照用，訊息寫出依據的版本範圍
  const s = at('7.25.1', []);
  assert.deepStrictEqual([mg(s).version, mg(s).versionInRange], ['7.25.1', true]);
  const def = fws(s, 'F11');
  assert.strictEqual(def.length, 2);
  assert.ok(def.every((f) => /RouterOS 7\.24–7\.26/.test(f.message)), def[0].message);
  // /system resource 的版本優先於 export 抬頭
  const r = build(['R (10.0.0.1):', '### /system resource print', '    version: 7.12.1 (stable)', ' board-name: RB5009', '### /export terse', '# 2026-10-13 10:00:00 by RouterOS 7.25',
    '/interface list add name=WAN', '/interface list member add interface=ether1 list=WAN'].join('\n'));
  assert.deepStrictEqual([mg(r).version, mg(r).versionInRange], ['7.12.1 (stable)', false]);
  // 版本不明：照用預設值，訊息註明版本不明
  const u = fwBox([]);
  assert.deepStrictEqual([mg(u).version, mg(u).versionInRange], [null, null]);
  assert.ok(fws(u, 'F11').every((f) => /設備版本不明/.test(f.message)), fws(u, 'F11')[0].message);
});
