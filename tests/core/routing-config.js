// 對外與路由網域的設定（ADR-023 階段 1a）：/ip dhcp-client、/interface pppoe-client、/routing ospf area、/routing ospf interface-template，
// 以及路由的 check-gateway。測試資料依 RouterOS 手冊（7.24–7.26）的參數表與使用說明的範例撰寫，不是實機擷取；預設值的依據見 model/build.js 的 resolveRoutingCfg
'use strict';
const assert = require('assert');
const { S, build, ids, test } = require('../lib.js');

// 第 1 行設備標頭、第 2 行 /export terse，傳入的行從第 3 行起
const box = (lines) => build(['R (10.0.0.1):', '### /export terse', ...lines].join('\n'));
const pick = (x, keys) => keys.map((k) => x[k]);
const noI03 = (s) => assert.ok(!ids(s).includes('I03'), JSON.stringify(s.findings.filter((f) => f.id === 'I03').map((f) => f.message)));

test('dhcp-client：add 寫出的是事實，沒寫的以手冊預設值補上（defaulted）；set 依名稱或 [ find ] 套用；行號保留；沒有 I03', () => {
  const s = box(['/ip dhcp-client add interface=ether1',
    '/ip dhcp-client add add-default-route=no comment=backup default-route-distance=5 check-gateway=ping disabled=yes interface=ether2 name=c2 use-peer-dns=no',
    '/ip dhcp-client set [ find interface=ether1 ] default-route-distance=3', '/ip dhcp-client set c2 disabled=no',
    '/ip dhcp-client set [ find interface=ether9 ] add-default-route=special-classless']);
  noI03(s);
  const [a, b, c] = S.query(s).dhcpClientsOf('R');
  assert.deepStrictEqual(pick(a, ['interface', 'ep', 'addDefaultRoute', 'defaultRouteDistance', 'checkGateway', 'usePeerDns', 'disabled', 'basis', 'order']),
    ['ether1', 'R|ether1', 'yes', 3, null, true, false, 'export', 1]);
  assert.deepStrictEqual([a.defaulted, a.unknown, a.src.map((x) => x[1])], [['addDefaultRoute', 'checkGateway', 'usePeerDns', 'disabled'], ['name'], [3, 5]]);
  assert.deepStrictEqual(pick(b, ['name', 'interface', 'addDefaultRoute', 'defaultRouteDistance', 'checkGateway', 'usePeerDns', 'disabled', 'comment']),
    ['c2', 'ether2', 'no', 5, 'ping', false, false, 'backup'], 'set c2 disabled=no 套用到名稱是 c2 的那一筆');
  assert.deepStrictEqual([b.defaulted, b.src.map((x) => x[1])], [[], [4, 6]]);
  // set 找不到對象：另成一筆，沒寫的欄位都不明（不以預設值補）
  assert.deepStrictEqual(pick(c, ['basis', 'interface', 'addDefaultRoute', 'disabled']), ['set', null, 'special-classless', null]);
  assert.ok(c.unknown.includes('disabled') && c.defaulted.length === 0);
  assert.ok(Object.isFrozen(S.query(s).dhcpClientsOf('R')) && S.query(s).dhcpClientsOf('X').length === 0);
});

test('pppoe-client：add-default-route、use-peer-dns 沒寫時是 no（手冊範例）；distance、disabled 無法以手冊確認時是 null（unknown）；帳密不進 Snapshot', () => {
  const s = build(['R (10.0.0.1):', '### /export', '/interface pppoe-client',
    'add add-default-route=yes default-route-distance=2 disabled=no interface=ether1 name=pppoe-out1 \\', '    password=S3cretPass user=isp-user',
    'add interface=ether2 name=pppoe-out2', 'set [ find name=pppoe-out2 ] use-peer-dns=yes'].join('\n'));
  noI03(s);
  const [a, b] = S.query(s).pppoeClientsOf('R');
  assert.deepStrictEqual(pick(a, ['name', 'ep', 'interface', 'interfaceEp', 'addDefaultRoute', 'defaultRouteDistance', 'usePeerDns', 'disabled']),
    ['pppoe-out1', 'R|pppoe-out1', 'ether1', 'R|ether1', true, 2, false, false]);
  assert.deepStrictEqual([a.defaulted, a.unknown, a.src.map((x) => x[1])], [['usePeerDns'], [], [4]]);
  assert.deepStrictEqual(pick(b, ['addDefaultRoute', 'defaultRouteDistance', 'usePeerDns', 'disabled']), [false, null, true, null]);
  assert.deepStrictEqual([b.defaulted, b.unknown], [['addDefaultRoute'], ['defaultRouteDistance', 'disabled']]);
  const json = JSON.stringify(s.model);
  assert.ok(!json.includes('S3cretPass') && !json.includes('isp-user'), '帳號與密碼不進 model');
});

test('ospf area：area-id、instance、type 是事實；area-id、type 沒寫時無法以手冊確認（null）；disabled 沒寫為 false', () => {
  const s = box(['/routing ospf instance add name=default-v2 router-id=10.0.0.1',
    '/routing ospf area add area-id=0.0.0.0 instance=default-v2 name=backbone', '/routing/ospf/area add instance=default-v2 name=a1 area-id=1.1.1.1 type=stub',
    '/routing ospf area add instance=default-v2 name=a2', '/routing ospf area set a2 disabled=yes']);
  noI03(s);
  const { areas, templates } = S.query(s).ospfOf('R');
  assert.deepStrictEqual(areas.map((x) => pick(x, ['name', 'areaId', 'instance', 'type', 'disabled'])),
    [['backbone', '0.0.0.0', 'default-v2', null, false], ['a1', '1.1.1.1', 'default-v2', 'stub', false], ['a2', null, 'default-v2', null, true]]);
  assert.deepStrictEqual([areas[0].unknown, areas[0].defaulted, areas[2].unknown, areas[2].src.map((x) => x[1])], [['type'], ['disabled'], ['areaId', 'type'], [6, 7]]);
  assert.strictEqual(templates.length, 0);
  const Q = S.query(s);
  assert.ok(Object.isFrozen(Q.ospfOf('R')) && Object.isFrozen(Q.ospfOf('R').areas) && Q.ospfOf('R') === Q.ospfOf('R'));
  assert.deepStrictEqual(S.query(s).ospfOf('X'), { areas: [], templates: [] });
});

test('ospf interface-template：passive 是單獨的字；auth 只記類型與有沒有設金鑰（金鑰不進 Snapshot）；networks／interfaces 是清單；沒寫的 cost、type 不明', () => {
  const s = build(['R (10.0.0.1):', '### /export', '/routing ospf interface-template',
    'add area=backbone auth=md5 auth-id=1 auth-key=TopSecretKey cost=10 interfaces=ether1,ether2 type=ptp',
    'add area=backbone comment="passive users" networks=10.1.30.0/24,10.1.31.0/24',
    'add area=backbone networks=10.1.10.0/24 passive',
    'add area=a1 disabled=yes interfaces=LAN', 'set [ find area=a1 ] passive'].join('\n'));
  noI03(s);
  const t = S.query(s).ospfOf('R').templates;
  assert.deepStrictEqual(t.map((x) => pick(x, ['order', 'area', 'networks', 'interfaces', 'passive', 'auth', 'authKey', 'cost', 'type', 'disabled'])), [
    [1, 'backbone', [], ['ether1', 'ether2'], false, 'md5', true, 10, 'ptp', false],
    [2, 'backbone', ['10.1.30.0/24', '10.1.31.0/24'], [], false, null, false, null, null, false],
    [3, 'backbone', ['10.1.10.0/24'], [], true, null, false, null, null, false],
    [4, 'a1', [], ['LAN'], true, null, false, null, null, true]]);
  assert.strictEqual(t[1].comment, 'passive users', '引號內的 passive 不算 switch');
  assert.deepStrictEqual([t[1].defaulted, t[1].unknown], [['interfaces', 'passive', 'auth', 'authKey', 'disabled'], ['cost', 'type']]);
  assert.deepStrictEqual(t[3].src.map((x) => x[1]), [7, 8]);
  assert.ok(!JSON.stringify(s).includes('TopSecretKey'), 'auth-key 的值不進 Snapshot（含 blocks 與 findings）');
  // 收集檔去識別化時金鑰也會遮掉
  const { anonymize } = require('../../tools/anonymize.js');
  assert.ok(!anonymize('R (10.0.0.1):\n### /export\n/routing ospf interface-template add area=backbone auth=md5 auth-key=TopSecretKey').text.includes('TopSecretKey'));
});

test('路由的 check-gateway：print detail 有寫時是事實，沒寫或 none 為 null', () => {
  const s = build(['R (10.0.0.1):', '### /ip route print detail', 'Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC',
    ' 0  As dst-address=0.0.0.0/0 routing-table=main gateway=203.0.113.1 immediate-gw=203.0.113.1%ether1 check-gateway=ping distance=1 scope=30',
    ' 1  As dst-address=10.9.0.0/16 routing-table=main gateway=10.0.0.2 immediate-gw=10.0.0.2%ether2 check-gateway=none distance=1 scope=30',
    ' 2  As dst-address=10.8.0.0/16 routing-table=main gateway=10.0.0.2 immediate-gw=10.0.0.2%ether2 distance=1 scope=30'].join('\n'));
  noI03(s);
  assert.deepStrictEqual(s.model.routes.map((r) => [r.prefix, r.checkGateway]), [['0.0.0.0', 'ping'], ['10.8.0.0', null], ['10.9.0.0', null]]);
});

test('沒有這四類設定時，Snapshot 的陣列是空的', () => {
  const s = box(['/interface bridge add name=bridge1']);
  assert.deepStrictEqual([s.model.dhcpClients, s.model.pppoeClients, s.model.ospfAreas, s.model.ospfInterfaceTemplates], [[], [], [], []]);
});
