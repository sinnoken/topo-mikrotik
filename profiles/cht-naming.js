/*
 * 命名規則範例（可不套用）。規則來自舊版 GROUP_RULES，移出核心後只作為註解來源。
 * 也可以把同樣內容存成 .json，在畫面上「命名規則 → 載入檔案」使用。
 */
(function (S) {
  S.profiles = S.profiles || {};
  S.profiles['cht-naming'] = {
    schema: 'ssot-profile/1', id: 'cht-naming', version: '1', label: '站點_角色_編號（例：TPE_CORE_SW_01）',
    stripDomain: true,
    alias: {},
    classify: [
      { match: '(^|_)(FW|FG|FGT)(_|\\d|$)', kind: 'firewall', role: 'FW' },
      { match: '^[A-Z0-9]{2,5}_(CORE|DIST|ACC|SW|NOC|OSS|OA)_', kind: 'switch', role: '$1' },
      { match: '^[A-Z0-9]{2,5}_(RT|WAN|BB)_', kind: 'router', role: '$1' },
      { match: '^(DESKTOP|WINDOWS|PC|NB)-', kind: 'host', role: 'PC' },
      { match: '-SRV-|^SRV', kind: 'host', role: 'SRV' },
    ],
    group: { match: '^([A-Z0-9]{2,5})[_-]', value: '$1' },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
