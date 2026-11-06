/*
 * 內建命名規則（可不套用）：ISP 與電信網路的「站點-角色-編號」，角色是 ISP 用語。
 * 格式：站點-角色-編號（TPE-PE-01、TPE-P-02、KHH-BNG-01、TPE-BRAS-01、TPE-RR-01、CUST123-CE-01、TPE-AGG-03）。
 *   站點 2–12 個英數字；編號 1–3 位數字（前面的連字號可省略）。
 * 類型：PE（provider edge）、P（provider core）、RR（route reflector）、BNG／BRAS（用戶接取閘道）、CE（customer edge）→ router；
 *   AGG（匯聚）、ACC（接入）→ switch。角色段本身就是類型，沒有另外的類型段。
 * 角色：角色段照原樣。站點與分群：第一段；CE 的第一段是客戶代號，所以 CE 依客戶分群。
 * 限制：會先去掉網域；角色不在上面的清單（例如 CORE）、沒有編號時不標註。只加註解，不改寫事實。
 */
(function (S) {
  S.profiles = S.profiles || {};
  const ROLE = (r) => `^([A-Z0-9]{2,12})-(${r})-?\\d{1,3}$`;
  S.profiles['isp-roles'] = {
    schema: 'ssot-profile/1', id: 'isp-roles', version: '1',
    name: '站點-ISP 角色-編號（例：TPE-PE-01、KHH-BNG-01、CUST123-CE-01）',
    description: 'ISP 與電信網路，角色用 PE／P／RR／BNG／BRAS／CE（路由器）與 AGG／ACC（交換器）；CE 的站點是客戶代號。',
    stripDomain: true,
    alias: {},
    classify: [
      { match: ROLE('PE|P|RR|BNG|BRAS|CE'), kind: 'router', role: '$2', site: '$1' },
      { match: ROLE('AGG|ACC'), kind: 'switch', role: '$2', site: '$1' },
    ],
    group: { match: ROLE('PE|P|RR|BNG|BRAS|CE|AGG|ACC'), value: '$1' },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
