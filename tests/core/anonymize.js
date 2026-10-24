// 去識別化（tools/anonymize.js）
'use strict';
const assert = require('assert');
const { read, build, ids, test } = require('../lib.js');
test('去識別化：關係與檢查結果不變，設備名與 IP 不殘留，機密欄位遮蔽，結果可重現', () => {
  const { anonymize } = require('../../tools/anonymize.js');
  const raw = read('samples/sample-bundle.txt'); const a = anonymize(raw);
  const shape = (snap) => JSON.stringify({ st: snap.meta.stats, f: ids(snap).sort(), k: snap.model.devices.map((d) => d.kind).sort(),
    v: snap.model.macs.map((m) => m.vendor).sort(), l: snap.model.links.map((l) => [l.verified, l.hearsay, l.cls].join()).sort() });
  const s0 = build(raw); const s1 = build(a.text);
  assert.strictEqual(shape(s1), shape(s0), '去識別化不可改變網路結構、廠商判斷與檢查結果');
  s0.model.devices.forEach((d) => assert.ok(!a.text.toUpperCase().includes(d.key), `設備名 ${d.key} 不應殘留`));
  assert.ok(!/(?<![\d.])10\.1\.10\.2(?![\d.])/.test(a.text), '原始 IP 不應殘留');
  assert.strictEqual(anonymize(raw).text, a.text, '同一份輸入應得到同一份輸出');
  const w = anonymize('AP_1 (192.168.5.11):\n### /interface wifi registration-table print detail\n 0 A interface=wifi1 ssid="Corp" mac-address=AA:BB:CC:00:10:01 uptime=1h last-activity=1s\n     eap-identity="alice@corp" eap-username="alice" dhcp-hostname="alice-nb"\n### /export terse\n# serial number = HE0123\n/interface wireless security-profiles add name=p1 wpa2-pre-shared-key=topsecret\n').text;
  ['alice', 'Corp"', 'HE0123', 'topsecret', 'AP_1', '192.168'].forEach((x) => assert.ok(!w.includes(x), `${x} 應被去識別化`));
  const id = anonymize('SW (10.0.0.1):\n### /system identity print\n  name: SW\n### /interface bridge monitor [find] once\n  name: bridge1\n').text;
  assert.ok(id.includes('name: bridge1') && !/name: SW\b/.test(id), '只有 /system identity print 的 name 是設備名，bridge 名稱不換');
  assert.ok(w.includes('AA:BB:CC:'), '保留 OUI，廠商判斷不受影響');
});
test('去識別化：RouterOS export 的密碼、金鑰、SNMP community 都遮蔽（*-password、點號欄位、community 名稱），一般欄位保留', () => {
  const { anonymize } = require('../../tools/anonymize.js');
  const raw = ['SW (10.0.0.1):', '### /export terse',
    '/snmp community add addresses=10.0.0.0/8 authentication-password=authpw1 authentication-protocol=SHA1 encryption-password=encpw1 encryption-protocol=AES name=commsecret security=private',
    '/snmp community set [ find default=yes ] name=publicsecret',
    '/snmp set enabled=yes trap-community=trapsecret',
    '/ppp secret add name=vpnuser password=ppppw1 profile=default',
    '/interface wifi add configuration.ssid=CorpNet security.authentication-types=wpa2-psk security.passphrase=wifipw1 name=wifi1',
    '/interface wifi security add name=sec1 passphrase=wifipw2',
    '/interface wireless security-profiles add name=p1 static-key-0=wepkey0 wpa-pre-shared-key=wpapsk1 management-protection-key=mgmtkey1',
    '/interface wireguard add name=wg1 private-key="wgpriv1="',
    '/interface wireguard peers add interface=wg1 preshared-key="wgpsk1=" public-key="wgpub1="',
    '/ip ipsec identity add peer=p1 secret=ipsecpw1',
    '/radius add address=10.0.0.5 secret=radiuspw1 service=login',
    '/routing ospf interface-template add area=backbone auth=md5 auth-key=ospfkey1 auth-id=1',
    '/routing bgp connection add name=b1 tcp-md5-key=bgpkey1',
    '/system ntp key add key=ntpkey1 key-id=1',
    '/tool romon set enabled=yes secrets=romonpw1',
    '/interface l2tp-server server set ipsec-secret=l2tppw1',
    '/interface bridge add name=bridge1',
    '/snmp community',
    'add addresses=::/0 name=compactsecret',
    '### /snmp community print detail without-paging',
    ' 0 * name="printsecret" addresses=::/0 security=none read-access=yes',
    '### /interface bridge print detail',
    ' 0 name="bridge2" mtu=auto'].join('\n');
  const a = anonymize(raw).text;
  ['authpw1', 'encpw1', 'commsecret', 'publicsecret', 'trapsecret', 'ppppw1', 'wifipw1', 'wifipw2', 'wepkey0', 'wpapsk1', 'mgmtkey1', 'wgpriv1', 'wgpsk1',
    'ipsecpw1', 'radiuspw1', 'ospfkey1', 'bgpkey1', 'ntpkey1', 'romonpw1', 'l2tppw1', 'compactsecret', 'printsecret', 'CorpNet']
    .forEach((x) => assert.ok(!a.includes(x), `${x} 應被遮蔽`));
  ['authentication-protocol=SHA1', 'encryption-protocol=AES', 'security=private', 'name=vpnuser', 'name=bridge1', 'name="bridge2"', 'name=wifi1', 'auth-id=1', 'key-id=1',
    'security.authentication-types=wpa2-psk', 'configuration.ssid=SSID-001']
    .forEach((x) => assert.ok(a.includes(x), `${x} 應保留`));
  assert.strictEqual(anonymize(raw.replace(/\n/g, '\r\n')).text, a.replace(/\n/g, '\r\n'), 'CRLF 的結果相同');
});
