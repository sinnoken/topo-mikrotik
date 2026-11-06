/*
 * 內建命名規則（可不套用）：小型環境以 MikroTik 型號加位置命名，「型號-位置」。
 * 格式：型號-位置（RB5009-Lobby、hAP-ax3-Meeting、CRS326-Rack2、CCR2004-Core、cAP-ac-3F）。
 *   型號是名稱開頭的 MikroTik 產品線前綴：RB、CCR、hEX、CRS、CSS、hAP、cAP、wAP；位置是型號之後的其餘部分。
 *   完整型號（CCR2004-1G-12S+2XS-Core、CRS326-24G-2S+RM-Rack2）的埠數段（數字開頭、接 G／S／Q／P／X）也算型號。
 * 類型是推論，依型號前綴（產品線的一般用途，實際用途以收集到的資料為準）：
 *   RB250／RB260（SwOS 交換器）→ switch，排在 RB 之前；其他 RB、CCR、hEX → router；CRS、CSS → switch；
 *   hAP、cAP、wAP 是無線設備，專案的類型沒有 AP，所以只標角色 AP、不標類型（可能是路由器，也可能只當 AP 橋接）。
 * 站點：位置（Lobby、Rack2、3F）。不設分群：位置通常一台一個，分群照常依連線關係。
 * 限制：會先去掉網域；名稱不是以型號開頭（Lobby-RB5009）或沒有位置（RB5009）時不標註；
 *   型號沒有後綴、位置剛好是後綴字（例如 cAP-ac）時，ac 會被當成位置；完整型號沒有位置（CRS326-24G-2S+RM）時，
 *   最後一個埠數段會被當成位置；位置本身像埠數段（例如 5G-Room）時會被當成型號。只加註解，不改寫事實。
 */
(function (S) {
  S.profiles = S.profiles || {};
  const LOC = '-(.+)$';
  // 完整型號的埠數段（CCR2004-1G-12S+2XS、CRS326-24G-2S+RM 的 -1G、-12S+2XS、-24G、-2S+RM）：數字開頭、接 G／S／Q／P／X，
  // 算型號的一部分。至少留一段給位置（回溯），所以 CRS326-24G 的位置是 24G；3F、1F 這類樓層不是埠數段
  const SEG = '(?:-\\d+[GSQPX][A-Z0-9+]*)*';
  S.profiles['model-location'] = {
    schema: 'ssot-profile/1', id: 'model-location', version: '1',
    name: '型號-位置（例：RB5009-Lobby、hAP-ax3-Meeting、CRS326-Rack2）',
    description: '小型環境以 MikroTik 型號加位置命名；類型依型號前綴推論，站點取位置。',
    stripDomain: true,
    alias: {},
    // 類型取第一個符合的規則：RB250／RB260 是交換器，要排在一般的 RB 之前
    classify: [
      { match: `^RB2[56]0[A-Z0-9+]*${LOC}`, kind: 'switch', site: '$1' },
      { match: `^(?:(?:RB\\d{3,4}|CCR\\d{4})[A-Z0-9+]*${SEG}|hEX(?:-(?:S|lite|PoE|refresh))?)${LOC}`, kind: 'router', site: '$1' },
      { match: `^(?:CRS|CSS)\\d{3}[A-Z0-9+]*${SEG}${LOC}`, kind: 'switch', site: '$1' },
      { match: `^(?:hAP|cAP|wAP)(?:-(?:ac|ax|lite|mini|lte|xl|lr)\\d*)?${LOC}`, role: 'AP', site: '$1' },
    ],
  };
})(globalThis.SSOT = globalThis.SSOT || {});
