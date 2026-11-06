/*
 * 內建命名規則（可不套用）：企業三層式的「站點-角色-編號」，連字號分隔、大小寫皆可。
 * 格式：站點-角色-編號（HQ-CR-01、tpe-ds-02、TPE-AS-15、HQ-FW-01），或站點-角色-類型-編號（HQ-CORE-SW-01、HQ-DIST-RT-02）。
 *   站點 2–6 個英數字；角色、類型 2–5 個英文字母；編號 1–3 位數字（前面的連字號可省略）。
 * 類型：類型段（四段名稱的第三段，或三段名稱的第二段）是 FW／FG／FGT → firewall、RT／RTR／GW／BR／WAN → router、SW → switch。
 *   沒有類型段時才依角色推測：DS／DIST（匯聚）、AS／ACC（接入）→ switch；CR／CORE（核心）可能是 L3 交換器或路由器，不推測類型，依收集到的資料判斷。
 *   AP、WLC 只標角色，不標類型（專案的類型沒有 AP，依資料判斷）。
 * 角色：CR／CORE → CORE、DS／DIST → DIST、AS／ACC → ACC；其他照第二段原樣（HQ-FW-01 → FW、HQ-WLC-01 → WLC）。
 * 站點與分群：第一段，大小寫照原樣（tpe 與 TPE 是不同的分群）。
 * 限制：會先去掉網域（HQ-FW-01.corp.local → HQ-FW-01）；名稱不符合上面的格式（底線分隔、沒有編號、段數不對）時不標註任何欄位。
 * 只加註解，不改寫事實。
 */
(function (S) {
  S.profiles = S.profiles || {};
  const NUM = '-?\\d{1,3}$';
  const TYPED = (t) => `^[A-Z0-9]{2,6}-(?:[A-Z]{2,5}-)?(?:${t})${NUM}`; // 類型段：四段的第三段或三段的第二段
  const ROLE = (r) => `^[A-Z0-9]{2,6}-(?:${r})(?:-[A-Z]{2,5})?${NUM}`; // 角色段：第二段
  const FULL = `^([A-Z0-9]{2,6})-([A-Z]{2,5})(?:-[A-Z]{2,5})?${NUM}`;
  S.profiles['site-role-dash'] = {
    schema: 'ssot-profile/1', id: 'site-role-dash', version: '1',
    name: '站點-角色-編號（例：HQ-CR-01、TPE-AS-15、HQ-CORE-SW-01）',
    description: '企業三層式網路（核心 CR／CORE、匯聚 DS／DIST、接入 AS／ACC），連字號分隔、大小寫皆可。',
    stripDomain: true,
    alias: {},
    // 類型與角色各自取第一個符合的規則：先依明確的類型段，再依角色推測
    classify: [
      { match: TYPED('FW|FG|FGT'), kind: 'firewall' },
      { match: TYPED('RT|RTR|GW|BR|WAN'), kind: 'router' },
      { match: TYPED('SW'), kind: 'switch' },
      { match: ROLE('CR|CORE'), role: 'CORE' },
      { match: ROLE('DS|DIST'), kind: 'switch', role: 'DIST' },
      { match: ROLE('AS|ACC'), kind: 'switch', role: 'ACC' },
      { match: FULL, role: '$2', site: '$1' },
    ],
    group: { match: FULL, value: '$1' },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
