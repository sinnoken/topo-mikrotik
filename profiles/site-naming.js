/*
 * 內建命名規則（可不套用）：index.html 載入後出現在「命名規則」選單。規則來自舊版 GROUP_RULES，移出核心後只作為註解來源。
 * 名稱格式：站點_層級_類型_編號（TPE_CORE_RT_01），也相容三段的站點_角色_編號。
 * 使用者自己的規則請存成 .json，在「命名規則 → 載入命名規則檔（JSON）…」載入；範例見 floor-device-naming.json。
 */
(function (S) {
  S.profiles = S.profiles || {};
  S.profiles['site-naming'] = {
    schema: 'ssot-profile/1', id: 'site-naming', version: '2', label: '站點_層級_類型_編號（例：TPE_CORE_RT_01、TPE_ACC_SW_01）',
    stripDomain: true,
    alias: {},
    // 類型（kind）與角色（role）各自取第一個符合的規則，所以「依類型段判斷」的規則要排在「依層級推測」之前
    classify: [
      { match: '(^|_)(FW|FG|FGT)(_|\\d|$)', kind: 'firewall', role: 'FW' },
      // 四段名稱：第三段是設備類型，第二段的層級只當角色
      { match: '^[A-Z0-9]{2,5}_([A-Z]+)_(RT|WAN|BB)(_|\\d|$)', kind: 'router', role: '$1' },
      { match: '^[A-Z0-9]{2,5}_([A-Z]+)_SW(_|\\d|$)', kind: 'switch', role: '$1' },
      // 三段名稱（站點_角色_編號）沒有類型段：依角色推測
      { match: '^[A-Z0-9]{2,5}_(RT|WAN|BB)_', kind: 'router', role: '$1' },
      { match: '^[A-Z0-9]{2,5}_(CORE|DIST|ACC|SW|NOC|OSS|OA)_', kind: 'switch', role: '$1' },
      { match: '^(DESKTOP|WINDOWS|PC|NB)-', kind: 'host', role: 'PC' },
      { match: '-SRV-|^SRV', kind: 'host', role: 'SRV' },
    ],
    group: { match: '^([A-Z0-9]{2,5})[_-]', value: '$1' },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
