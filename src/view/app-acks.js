/*
 * 已確認的檢查結果：使用者看過、決定接受的 finding。
 * 這是檢視狀態，不改 Snapshot：以 Q.findingKey(f) 為鍵存在 store 的獨立鍵 'acks'（{ 鍵: { at } }），
 * 所以清除基準不受影響，重新建立同一份網路的基準時仍然有效。
 */
(function (S) {
  'use strict';
  const V = S.view;
  const A = V.app; const App = window.App;
  const STORE_KEY = 'acks';
  let acks = new Map();

  /** 啟動時從 store 讀回；讀不到時從空白開始，並提示（不靜默略過） */
  A.loadAcks = async function loadAcks() {
    try {
      const saved = (await S.store.get(STORE_KEY)) || {};
      acks = new Map(Object.entries(saved).filter(([, v]) => v && typeof v.at === 'string'));
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

  /** 這筆 finding 的確認紀錄 { at }，未確認為 null */
  A.ackOf = (f) => (App.Q ? acks.get(App.Q.findingKey(f)) || null : null);
  App.isAcked = (f) => !!A.ackOf(f);
  /** 標記或取消確認；確認時間是 UTC ISO 字串 */
  App.ackFinding = async function (f, on) {
    const k = App.Q.findingKey(f);
    if (on) acks.set(k, { at: new Date().toISOString() }); else acks.delete(k);
    A.renderAll();
    await persist();
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
