// OUI 廠商
'use strict';
const assert = require('assert');
const { S, test } = require('../lib.js');
// ------------------------------------------------------------------ OUI 廠商
test('OUI：取最長符合的前綴（MA-S 9 碼 → MA-M 7 碼 → MA-L 6 碼），並記錄資料來源', () => {
  const p = S.data.ouiPacked; const vendors = p.vendors.split('|');
  const v6 = new Map(p.entries.split(',').map((e) => [e.slice(0, 6), vendors[parseInt(e.slice(6), 36)]]));
  [[7, p.entries7], [9, p.entries9]].forEach(([len, packed]) => {
    const e = packed.split(',')[0]; const prefix = e.slice(0, len); const want = vendors[parseInt(e.slice(len), 36)];
    assert.strictEqual(S.oui.lookup((prefix + '000000').slice(0, 12)), want, `${len} 碼前綴 ${prefix} 應查到 ${want}`);
    assert.strictEqual(v6.get(prefix.slice(0, 6)), 'IEEE Registration Authority', '細分區塊的 6 碼前綴登記為 IEEE，不能拿來當廠商');
  });
  assert.strictEqual(S.oui.lookup('3C5AB4000001'), 'Google');
  assert.strictEqual(S.oui.lookup('020000000001'), '本機管理位址');
  assert.ok(/^oui-data@\d+\.\d+\.\d+/.test(S.oui.source()), S.oui.source());
});
