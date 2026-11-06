/*
 * 內建命名規則（可不套用）：以 DNS 名稱命名設備，「類型編號.站點.網域」。
 * 格式：類型[-角色]編號.站點.網域（rt1.tpe.example.net、sw-acc-03.hq.corp.local、fw01.khh.example.com）。
 *   類型、角色 2–5 個英文字母；編號 1–3 位數字（前面的連字號可省略）；站點是第二段；網域至少一段。
 * 不去掉網域（stripDomain: false）：建模時 classify／group 比對的是經 canon（alias／stripDomain）之後的名稱，
 *   去掉網域會連第二段的站點一起去掉，所以這份規則保留完整的 FQDN，設備鍵也是完整的 FQDN。
 * 類型：第一段的類型 FW／FG／FGT → firewall、RT／RTR／GW／BR → router、SW → switch；AP 只標角色。
 * 角色：有角色段時用它（CR／CORE → CORE、DS／DIST → DIST、AS／ACC → ACC，其他照原樣，例如 sw-dmz-01 → dmz）；
 *   沒有角色段時用類型（FW、RT、SW、AP）。
 * 站點與分群：第二段，照原樣（DNS 名稱通常是小寫）。
 * 限制：只有主機名稱的名稱（rt1）、只有兩段（rt1.tpe）或第一段沒有編號（www.example.com）時不標註。
 *   同一台設備若在鄰居資料中只以短名稱出現，會和 FQDN 成為不同的設備；需要時以 alias 對應。只加註解，不改寫事實。
 */
(function (S) {
  S.profiles = S.profiles || {};
  const TAIL = '-?\\d{1,3}\\.([A-Z0-9-]+)(?:\\.[A-Z0-9-]+)+$'; // 編號.站點.網域；$1／$2 之後的群組是站點
  const TYPED = (t) => `^(?:${t})(?:-[A-Z]{2,5})?${TAIL}`;
  const ROLE = (r) => `^[A-Z]{2,5}-(?:${r})${TAIL}`;
  S.profiles['fqdn-role-site'] = {
    schema: 'ssot-profile/1', id: 'fqdn-role-site', version: '1',
    name: '類型編號.站點.網域（例：rt1.tpe.example.net、sw-acc-03.hq.corp.local）',
    description: '設備以 DNS 名稱命名、站點寫在第二段的環境；保留網域，站點與分群取第二段。',
    stripDomain: false,
    alias: {},
    // 類型只由第一段的類型決定；角色先取角色段，沒有時才用類型（各自取第一個符合的規則）
    classify: [
      { match: ROLE('CR|CORE'), role: 'CORE' },
      { match: ROLE('DS|DIST'), role: 'DIST' },
      { match: ROLE('AS|ACC'), role: 'ACC' },
      { match: `^[A-Z]{2,5}-([A-Z]{2,5})${TAIL}`, role: '$1' },
      { match: TYPED('FW|FG|FGT'), kind: 'firewall', role: 'FW' },
      { match: TYPED('RT|RTR|GW|BR'), kind: 'router', role: 'RT' },
      { match: TYPED('SW'), kind: 'switch', role: 'SW' },
      { match: TYPED('AP'), role: 'AP' },
      { match: `^[A-Z]{2,5}(?:-[A-Z]{2,5})?${TAIL}`, site: '$1' },
    ],
    group: { match: `^[A-Z]{2,5}(?:-[A-Z]{2,5})?${TAIL}`, value: '$1' },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
