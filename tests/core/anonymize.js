// 去識別化（tools/anonymize.js）
'use strict';
const assert = require('assert');
const lib = require('../lib.js');
const { read, build, ids, test } = lib;
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
  ['alice', 'Corp"', 'HE0123', 'topsecret', 'AP_1', '192.168.5.11'].forEach((x) => assert.ok(!w.includes(x), `${x} 應被去識別化`));
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
test('去識別化：print 的「key: value」格式也遮蔽序號與授權識別碼（routerboard、license，大小寫與空白變化），一般欄位保留', () => {
  const { anonymize } = require('../../tools/anonymize.js');
  const rb = anonymize('R1 (10.0.0.1):\n/system routerboard print\n  routerboard: yes\n  model: RB5009UG+S+\n  serial-number: HF0123ABCD').text;
  assert.ok(!rb.includes('HF0123ABCD'), `routerboard 的 serial-number 應被遮蔽：${rb}`);
  assert.ok(rb.includes('serial-number: REDACTED') && rb.includes('model: RB5009UG+S+') && rb.includes('routerboard: yes'), '只遮蔽序號，其他欄位保留');
  const raw = ['SW (10.0.0.2):', '### /system routerboard print',
    '        Serial-Number :  HF9999ZZZZ  ', '  serial number: HFSPACE001', '  serial-number = HFEQ000001', 'serial-number=HFNOIND001',
    '### /system license print', '  software-id: ABCD-EF12', '  system-id: SYSID12345', '  level: 6',
    '### /system resource print', '  uptime: 1w2d03:04:05', '  board-name: CRS326',
    '### /export terse', '# SERIAL-NUMBER = HFEXP00001', '#software id=SWID000001',
    '# model = RB5009UG+S+'].join('\n');
  const a = anonymize(raw).text;
  ['HF9999ZZZZ', 'HFSPACE001', 'HFEQ000001', 'HFNOIND001', 'ABCD-EF12', 'SYSID12345', 'HFEXP00001', 'SWID000001']
    .forEach((x) => assert.ok(!a.includes(x), `${x} 應被遮蔽：${a}`));
  ['level: 6', 'uptime: 1w2d03:04:05', 'board-name: CRS326', '# model = RB5009UG+S+'].forEach((x) => assert.ok(a.includes(x), `${x} 應保留`));
  assert.strictEqual(anonymize(raw.replace(/\n/g, '\r\n')).text, a.replace(/\n/g, '\r\n'), 'CRLF 的結果相同');
});

// 依序產生 n 個不同的公網 /16（從 1.0 起，跳過不是公網的第一段）
const publicNets = (n) => {
  const S = lib.S; const out = [];
  for (let a = 1; out.length < n && a < 224; a++) for (let b = 0; out.length < n && b < 256; b++) if (S.ip.classify(`${a}.${b}.1.1`) === 'public') out.push([a, b]);
  return out;
};
const IP_TOKEN = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;
test('去識別化：IPv4 依類別換到同類範圍（私有、CGNAT、公網 11/8），整類的網段與不換的位址原樣保留', () => {
  const { anonymize } = require('../../tools/anonymize.js'); const S = lib.S;
  const keep = ['127.0.0.1', '169.254.1.1', '224.0.0.5', '255.255.255.0', '203.0.113.5', '198.18.0.1', '0.0.0.0/0',
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'];
  const raw = ['R1 (10.1.1.1):', '### /ip address print detail',
    ' 0 address=10.1.1.1/24 network=10.1.1.0 interface=ether1', ' 1 address=172.20.3.4/24 network=172.20.3.0 interface=ether2',
    ' 2 address=192.168.7.9/24 network=192.168.7.0 interface=ether3', ' 3 address=100.70.1.2/30 network=100.70.1.0 interface=ether4',
    ' 4 address=8.8.4.4/29 network=8.8.4.0 interface=ether5',
    '### /ip route print detail', ' 0 dst-address=0.0.0.0/0 gateway=8.8.4.1', ' 1 dst-address=8.8.0.0/16 gateway=8.8.4.1',
    '### /export terse', ...keep.map((x, i) => `/ip firewall address-list add address=${x} list=L${i}`)].join('\n');
  const r = anonymize(raw); const t = r.text;
  keep.forEach((x) => assert.ok(t.includes(`address=${x} `), `${x} 不換`));
  assert.deepStrictEqual(r.warnings, [], '都在保留單位以內，不應有警告');
  ['10.1.1.1', '172.20.3.4', '192.168.7.9', '100.70.1.2', '8.8.4.4', '8.8.4.1'].forEach((x) => assert.ok(!t.includes(x), `${x} 應換掉`));
  const raws = raw.match(IP_TOKEN); const outs = t.match(IP_TOKEN);
  assert.strictEqual(outs.length, raws.length, '位址個數不變');
  raws.forEach((x, i) => assert.strictEqual(S.ip.classify(outs[i]), S.ip.classify(x), `${x} → ${outs[i]} 的類別不變`));
  outs.filter((x) => S.ip.classify(x) === 'public').forEach((x) => assert.ok(x.startsWith('11.'), `公網代號在 11/8：${x}`));
  assert.ok(/address=10\.101\.1\.1\/24 network=10\.101\.1\.0 /.test(t) && t.includes('dst-address=11.0.0.0/16 gateway=11.0.4.1'), `/16 內的關係保留：${t}`);
  assert.deepStrictEqual(r.nets.filter((n) => n.count).map((n) => [n.bucket, n.level, n.count]),
    [['p10', 16, 1], ['p172', 16, 1], ['p192', 24, 1], ['cgnat', 16, 1], ['public', 16, 1]]);
  assert.deepStrictEqual(r.map.public, { '8.8.x.x': '11.0.x.x' }, '對照表記錄原單位與代號');
});
test('去識別化：鄰居的空 identity、值後面的續行符號、每段都像遮罩的位址都不破壞輸出', () => {
  const { anonymize } = require('../../tools/anonymize.js');
  const raw = ['R1 (10.0.0.1):', '### /ip neighbor print detail without-paging', ' 0 interface=ether1 address=10.0.0.2 identity="" platform=MikroTik',
    '### /export terse', '/system script add name=s1 source=":local veth \\"veth5\\"\\', '    \\n/interface/veth/add name=\\$veth comment=\\$veth\\', '    \\n:log info done"',
    '/ip firewall address-list add address=192.192.128.0/17 list=geo', '/ip address add address=10.0.0.1 netmask=255.255.240.0 interface=ether1'].join('\n');
  const t = anonymize(raw).text;
  assert.ok(t.startsWith('DEV-001 (10.101.0.1):\n') && t.includes(' identity="" platform=MikroTik'), `空的 identity 不當成設備名：${t}`);
  assert.ok(t.includes('comment=comment-001\\\n'), `行尾的續行符號保留：${t}`);
  assert.ok(t.includes('address=11.0.128.0/17 ') && t.includes('netmask=255.255.240.0 '), `不連續的「遮罩」是一般位址，真的遮罩不換：${t}`);
});
test('去識別化：超過 256 個公網 /16 時改以 /24 為單位，代號不重複、同一個位址一定換成同一個代號、/24 以上的關係保留', () => {
  const { anonymize } = require('../../tools/anonymize.js');
  const nets = publicNets(300);
  const lines = ['R1 (10.0.0.1):', '### /export terse'];
  nets.forEach(([a, b]) => lines.push(`/ip firewall address-list add address=${a}.${b}.1.0/24 list=L`, `/ip firewall address-list add address=${a}.${b}.1.7 list=L`,
    `/ip firewall address-list add address=${a}.${b}.2.7 list=L`));
  nets.forEach(([a, b]) => lines.push(`/ip route add dst-address=${a}.${b}.1.0/24 gateway=${a}.${b}.1.7`));
  const r = anonymize(lines.join('\n'));
  assert.strictEqual(r.nets.find((n) => n.bucket === 'public').level, 24);
  assert.deepStrictEqual(r.warnings, []);
  const outs = r.text.match(IP_TOKEN).slice(1);
  const ins = lines.join('\n').match(IP_TOKEN).slice(1);
  const pairs = new Map();
  ins.forEach((x, i) => { assert.ok(outs[i].startsWith('11.'), `公網代號在 11/8：${outs[i]}`); if (pairs.has(x)) assert.strictEqual(pairs.get(x), outs[i], `${x} 換成同一個代號`); pairs.set(x, outs[i]); });
  assert.strictEqual(new Set(pairs.values()).size, pairs.size, '不同位址換成不同代號');
  nets.forEach(([a, b]) => {
    const n = pairs.get(`${a}.${b}.1.0`); const h = pairs.get(`${a}.${b}.1.7`);
    assert.strictEqual(h.replace(/\.\d+$/, '.0'), n, '/24 網段與其中的位址仍在同一個 /24');
    assert.ok(h.endsWith('.7') && n.endsWith('.0'), '最後一段保留');
  });
});
test('去識別化：比保留單位短的網段與跨單位的範圍列出警告（含輸出行號），整類的網段不警告', () => {
  const { anonymize } = require('../../tools/anonymize.js');
  const nets = publicNets(257);
  const raw = ['R1 (10.0.0.1):', '### /export terse',
    '/ip firewall address-list add address=10.0.0.0/8 list=lan', '/ip firewall address-list add address=10.16.0.0/12 list=x',
    '/ip firewall address-list add address=10.1.2.3-10.2.0.1 list=x',
    ...nets.map(([a, b]) => `/ip firewall address-list add address=${a}.${b}.0.0/22 list=geo`)].join('\n');
  const w = anonymize(raw).warnings;
  assert.strictEqual(w.length, 3, w.join('\n'));
  assert.ok(w[0].startsWith('私有位址 10/8：1 處網段短於 /16（/12–/12）') && w[0].includes('輸出第 4 行'), w[0]);
  assert.ok(w[1].startsWith('私有位址 10/8：1 處位址範圍跨越不同的 /16 網段') && w[1].includes('輸出第 5 行'), w[1]);
  assert.ok(w[2].startsWith('公網位址：257 處網段短於 /24（/22–/22）') && w[2].includes('輸出第 6、7、8、9、10… 行'), w[2]);
  const few = anonymize('R1 (10.0.0.1):\n/ip firewall address-list add address=8.8.0.0/22 list=geo\n');
  assert.deepStrictEqual(few.warnings, [], '公網 /16 不多時以 /16 為單位，/22 的關係保留');
  assert.ok(few.text.includes('address=11.0.0.0/22 '), few.text);
});
test('去識別化：位址太多、/24 也放不下時明確失敗，訊息的數量與實際判斷一致', () => {
  const { anonymize } = require('../../tools/anonymize.js');
  const lines = ['R1 (10.0.0.1):'];
  for (let i = 0; i < 155 * 256 + 1; i++) lines.push(`/ip route add dst-address=10.${i >> 8}.${i & 255}.0/24`);
  assert.throws(() => anonymize(lines.join('\n')), { message: '私有位址 10/8：有 156 個不同的 /16、39681 個不同的 /24 網段，'
    + '超過 10.101.0.0–10.255.255.255 可容納的 155 個 /16 或 39680 個 /24，無法維持網段關係；請先切出需要的片段再去識別化' });
  lines.pop();
  assert.strictEqual(anonymize(lines.join('\n')).nets.find((n) => n.bucket === 'p10').level, 16, '39680 個 /24 剛好是 155 個 /16，放得下');
  const fb = ['R1 (10.0.0.1):']; for (let i = 1; i <= 155; i++) fb.push(`10.${i}.0.1`);
  assert.strictEqual(anonymize(fb.join('\n')).nets.find((n) => n.bucket === 'p10').level, 24, '156 個 /16 放不下時改以 /24 為單位，不失敗');
  const pub = ['R1 (10.0.0.1):'];
  publicNets(257).forEach(([a, b]) => { for (let c = 0; c < 256; c++) pub.push(`${a}.${b}.${c}.1`); });
  assert.throws(() => anonymize(pub.join('\n')), /^Error: 公網位址：有 257 個不同的 \/16、65792 個不同的 \/24 網段，超過 11\.0\.0\.0\/8 可容納的 256 個 \/16 或 65536 個 \/24/);
});
