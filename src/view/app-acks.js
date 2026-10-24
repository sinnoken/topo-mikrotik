/*
 * 已確認的檢查結果：使用者看過、決定接受的 finding。
 * 這是檢視狀態，不改 Snapshot：以 Q.findingKey(f) 為鍵存在 store 的獨立鍵 'acks'（{ 鍵: { at, kind, note } }），
 * 所以清除基準不受影響，重新建立同一份網路的基準時仍然有效。
 *   at  ：第一次確認的時間（UTC ISO），修改分類或原因時不變
 *   kind：分類（V.remediation.ACK_KIND 的鍵）；舊格式只有 { at }，視為未分類（null）
 *   note：自由文字的原因；沒有時為空字串
 * 讀取時保留紀錄的其他欄位（例如較新版本寫入的），修改時只覆寫 kind 與 note，不丟資料。
 */
(function (S) {
  'use strict';
  const V = S.view;
  const A = V.app; const App = window.App;
  const STORE_KEY = 'acks';
  let acks = new Map();

  /** 讀進來的紀錄 → 畫面使用的形狀；at 不是字串的紀錄無法使用（沿用舊行為：不載入） */
  const normalize = (v) => Object.assign({}, v, {
    kind: typeof v.kind === 'string' && v.kind ? v.kind : null,
    note: typeof v.note === 'string' ? v.note : '',
  });

  /** 啟動時從 store 讀回；讀不到時從空白開始，並提示（不靜默略過） */
  A.loadAcks = async function loadAcks() {
    try {
      const saved = (await S.store.get(STORE_KEY)) || {};
      acks = new Map(Object.entries(saved).filter(([, v]) => v && typeof v.at === 'string').map(([k, v]) => [k, normalize(v)]));
    } catch (e) {
      console.error(e); acks = new Map();
      A.banner('無法讀取已確認的檢查結果：' + e.message, 10000);
    }
  };
  function persist() {
    return S.store.set(STORE_KEY, Object.fromEntries(acks)).catch((e) => {
      console.error(e); A.banner('無法儲存已確認的檢查結果：' + e.message, 10000);
    });
  }

  /** 這筆 finding 的確認紀錄 { at, kind, note }，未確認為 null */
  A.ackOf = (f) => (App.Q ? acks.get(App.Q.findingKey(f)) || null : null);
  /** 全部確認紀錄 [[findingKey, 紀錄]]（修復追蹤用，含目前基準沒有的鍵） */
  A.ackEntries = () => Array.from(acks.entries());
  App.isAcked = (f) => !!A.ackOf(f);
  /**
   * 標記、修改或取消確認。info = { kind, note }；已確認時再呼叫是修改分類與原因，確認時間不變。
   */
  App.ackFinding = async function (f, on, info) {
    const k = App.Q.findingKey(f);
    if (on) {
      const i = info || {}; const prev = acks.get(k);
      // 沒給 kind 時沿用原本的分類；給了已知分類或原本就有的（未知）分類時採用；空字串是未分類
      const kind = !('kind' in i) ? (prev ? prev.kind : null)
        : i.kind && (V.remediation.ACK_KIND[i.kind] || (prev && prev.kind === i.kind)) ? i.kind : null;
      const note = typeof i.note === 'string' ? i.note.trim() : prev ? prev.note : '';
      acks.set(k, Object.assign({}, prev || {}, { at: prev ? prev.at : new Date().toISOString(), kind, note }));
    } else acks.delete(k);
    A.renderAll();
    await persist();
  };
  /** 依 findingKey 清掉確認（修復追蹤的「清掉已修復的確認」）；回傳實際清掉的筆數 */
  App.clearAcks = async function (keys) {
    const n = keys.filter((k) => acks.delete(k)).length;
    A.renderAll();
    await persist();
    return n;
  };
  /** 目前基準中未確認／已確認的錯誤與警告筆數（基準摘要用） */
  A.problemCounts = function problemCounts() {
    const out = { error: 0, warn: 0, acked: 0 };
    App.snap.findings.forEach((f) => {
      if (f.severity === 'info') return;
      if (A.ackOf(f)) out.acked++; else out[f.severity]++;
    });
    return out;
  };
})(globalThis.SSOT = globalThis.SSOT || {});
