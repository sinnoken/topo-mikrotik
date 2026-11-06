/*
 * 內建命名規則（可不套用）：園區或大樓依建物與樓層命名，「建物-樓層-類型-編號」。
 * 格式：建物-樓層-類型-編號（B1-3F-SW-01、HQ-B2-AP-05、A棟-5F-RT-01）。
 *   建物 1–12 個字元，可用中文，不含空白、點、底線、連字號；樓層是 3F、12F（地上）或 B2、B1F（地下）；
 *   類型 2–5 個英文字母；編號 1–3 位數字（前面的連字號可省略）。
 *   樓層固定是第二段，所以 B1-3F-SW-01 的 B1 是建物、HQ-B2-AP-05 的 B2 是地下二樓。
 * 類型：FW／FG／FGT → firewall、RT／RTR／GW → router、SW → switch；AP 等其他類型只標角色，不推測類型。
 * 角色：類型段照原樣（SW、AP、PRN…）。
 * 站點：建物。分群：建物＋樓層（B1-3F）——同一樓層的設備多半接在同一組交換器，依樓層分群在拓樸圖上比較好讀；
 *   要依建物看時用站點欄位。
 * 限制：會先去掉網域；樓層不是上面的寫法（例如 ROOF）、段數不對或沒有編號時不標註。只加註解，不改寫事實。
 */
(function (S) {
  S.profiles = S.profiles || {};
  const B = '([^\\s._-]{1,12})'; const F = '(B?\\d{1,3}F|B\\d{1,2})'; const NUM = '-?\\d{1,3}$';
  const TYPED = (t) => `^${B}-${F}-(?:${t})${NUM}`;
  const FULL = `^${B}-${F}-([A-Z]{2,5})${NUM}`;
  S.profiles['building-floor'] = {
    schema: 'ssot-profile/1', id: 'building-floor', version: '1',
    name: '建物-樓層-類型-編號（例：B1-3F-SW-01、HQ-B2-AP-05、A棟-5F-RT-01）',
    description: '園區或大樓依建物與樓層命名的環境；站點取建物，分群取建物＋樓層，建物可用中文。',
    stripDomain: true,
    alias: {},
    // 類型與角色各自取第一個符合的規則：類型只依類型段，角色照類型段原樣
    classify: [
      { match: TYPED('FW|FG|FGT'), kind: 'firewall' },
      { match: TYPED('RT|RTR|GW'), kind: 'router' },
      { match: TYPED('SW'), kind: 'switch' },
      { match: FULL, role: '$3', site: '$1' },
    ],
    group: { match: FULL, value: '$1-$2' },
  };
})(globalThis.SSOT = globalThis.SSOT || {});
