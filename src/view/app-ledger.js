/*
 * 處理紀錄（ssot-ledger/1）的畫面接線：使用者對每個 finding 的決定（排程修復、可接受、誤報…）與每一輪的歷程。
 * 資料模型、狀態轉換、驗證與統計都在核心 S.ledger（src/ledger/ledger.js）；這裡只負責：
 *   - 讀寫 store 的 'ledger' 鍵（與基準 'last' 分開：清除基準不影響處理紀錄）
 *   - 舊的確認標記（store 的 'acks'）第一次遇到基準時以 S.ledger.fromAcks 轉換；確認 'ledger' 寫入成功後才刪掉 'acks'
 *   - 建立或還原基準後呼叫 S.ledger.advance（目前時間由畫面傳入，核心不讀時間）
 *   - 使用者變更狀態（S.ledger.set，錯誤原樣回傳給畫面顯示）、匯出與匯入
 * 無法使用處理紀錄時（store 中的資料格式不正確、舊確認標記無法轉換）進入「停用」狀態：不寫入 store、不丟資料，畫面說明原因。
 */
(function (S) {
  'use strict';
  const V = S.view; const LG = S.ledger;
  const A = V.app; const App = window.App;
  const KEY = 'ledger'; const ACKS = 'acks';
  const st = {
    ledger: LG.empty(),
    blocked: null, // { reason, errors, raw? }：無法使用時的原因；raw 是 store 中格式不正確的原資料
    pendingAcks: null, // 尚未轉換的舊確認標記（等第一份基準）
    acksToDelete: false, // 已轉換，等 'ledger' 寫入成功後刪除 'acks'
    round: null, // 最近一次 advance 的結果 { inputHash, changes, unobserved }（skipped 時為 null）
    saveError: null, // 最近一次寫入失敗的訊息
    imported: null, // 匯入：{ name, errors } 或 { name, ledger }（等待使用者確認覆蓋）
  };
  const nowIso = () => new Date().toISOString();

  // ================================================================ 讀取與轉換
  /** 啟動時讀取：有 'ledger' 就驗證後使用；沒有時記下舊的 'acks'，等第一份基準再轉換 */
  A.loadLedger = async function loadLedger() {
    Object.assign(st, { ledger: LG.empty(), blocked: null, pendingAcks: null, acksToDelete: false, round: null, saveError: null });
    let saved;
    try { saved = await S.store.get(KEY); } catch (e) {
      console.error(e); st.blocked = { reason: '無法讀取處理紀錄：' + e.message, errors: [] };
      A.banner(st.blocked.reason, 10000); return;
    }
    if (saved != null) {
      const v = LG.validate(saved);
      if (!v.ok) {
        st.blocked = { reason: '瀏覽器中儲存的處理紀錄格式不正確，沒有載入；原資料保留不動，可匯出原資料，或匯入正確的處理紀錄取代', errors: v.errors, raw: saved };
        A.banner(`${st.blocked.reason}（${v.errors.length} 項錯誤）`, 10000); return;
      }
      st.ledger = saved; return;
    }
    let acks;
    try { acks = await S.store.get(ACKS); } catch (e) {
      console.error(e); st.blocked = { reason: '無法讀取舊的確認標記（acks）：' + e.message, errors: [] };
      A.banner(st.blocked.reason, 10000); return;
    }
    if (acks && typeof acks === 'object' && Object.keys(acks).length) st.pendingAcks = acks;
  };

  /** 寫入 'ledger'；成功後才刪掉已轉換的 'acks'。失敗時保留 acks 並提示（記憶體中的處理紀錄照常使用，下次變更再寫入） */
  async function persist() {
    try { await S.store.set(KEY, st.ledger); } catch (e) {
      console.error(e); st.saveError = e.message;
      A.banner('無法儲存處理紀錄：' + e.message + (st.acksToDelete ? '。舊的確認標記（acks）保留不刪，下次開啟時會再轉換一次' : ''), 10000);
      return false;
    }
    st.saveError = null;
    if (st.acksToDelete) {
      try { await S.store.del(ACKS); st.acksToDelete = false; } catch (e) {
        console.error(e); A.banner('處理紀錄已儲存，但無法刪除舊的確認標記（acks）：' + e.message, 10000);
      }
    }
    return true;
  }

  /**
   * 以目前的基準推進一輪（建立或還原基準後呼叫）。有尚未轉換的舊確認標記時先轉換（fromAcks 內含推進）。
   * 轉換失敗時停用處理紀錄並說明，acks 保留不動；同一份基準已推進過（skipped）時不顯示變化。
   */
  A.advanceLedger = function advanceLedger(Q) {
    st.round = null;
    if (st.blocked || !Q) return Promise.resolve(false);
    let r;
    if (st.pendingAcks) {
      try { r = LG.fromAcks(st.pendingAcks, Q, { now: nowIso() }); } catch (e) {
        console.error(e);
        st.blocked = { reason: '舊的確認標記（acks）無法轉換成處理紀錄，原資料保留不動：' + e.message, errors: [], acks: true };
        A.banner(st.blocked.reason, 12000); return Promise.resolve(false);
      }
      st.pendingAcks = null; st.acksToDelete = true;
      A.banner(`已把舊的確認標記轉換成處理紀錄（${Object.keys(r.ledger.items).length} 項）`, 6000);
    } else {
      try { r = LG.advance(st.ledger, Q, { now: nowIso() }); } catch (e) {
        console.error(e); A.banner('無法以這份基準推進處理紀錄：' + e.message, 10000); return Promise.resolve(false);
      }
    }
    st.ledger = r.ledger;
    if (!r.skipped) st.round = { inputHash: Q.meta().inputHash, changes: r.changes, unobserved: r.unobserved };
    return r.skipped && !st.acksToDelete ? Promise.resolve(true) : persist();
  };

  // ================================================================ 查詢（畫面用）
  A.ledger = () => st.ledger;
  A.ledgerState = () => st;
  /** 這筆 finding 的處理紀錄項目；沒有（或處理紀錄停用）時為 null */
  A.ledgerItem = (f) => (App.Q && !st.blocked ? st.ledger.items[App.Q.findingKey(f)] || null : null);
  A.ledgerStatus = (f) => (A.ledgerItem(f) || {}).status || null;
  /** 仍待處理（open、regressed，或不在處理紀錄中） */
  A.isPending = (f) => V.remediation.isPendingStatus(A.ledgerStatus(f));
  /** 使用者最後一次變更的時間（歷程中最後一筆 by user）；沒有時為 null */
  A.ledgerUserAt = (it) => { const h = (it && it.history || []).filter((x) => x.by === 'user'); return h.length ? h[h.length - 1].at : null; };
  /** 匯出用（V.exporter 的 opts.ledgerOf）：{ status, at（使用者最後一次變更）, note, waiver }；不在處理紀錄中時為 null */
  A.ledgerExport = (f) => { const it = A.ledgerItem(f); return it ? { status: it.status, at: A.ledgerUserAt(it), note: it.note, waiver: it.waiver } : null; };
  /** 這份基準在處理紀錄中是第幾輪（0 起算）；沒有時 -1。以基準鍵比較（沒有 baselineKey 的舊紀錄、舊基準用 inputHash，與 S.ledger 相同） */
  const baseOf = (b) => (b && b.baselineKey != null ? b.baselineKey : b && b.inputHash);
  A.ledgerRoundIndex = () => (App.Q ? st.ledger.iterations.findIndex((r) => baseOf(r.baseline) === baseOf(App.Q.meta())) : -1);

  /** 目前基準中待處理／已處理的錯誤與警告筆數，與回歸、無法判斷、豁免到期（基準摘要用） */
  A.problemCounts = function problemCounts() {
    const out = { error: 0, warn: 0, handled: 0, regressed: 0, unobserved: 0, waiverExpired: 0 };
    const regressed = new Set();
    App.snap.findings.forEach((f) => {
      const s = A.ledgerStatus(f);
      if (s === 'regressed') regressed.add(App.Q.findingKey(f));
      if (f.severity === 'info') return;
      if (V.remediation.isPendingStatus(s)) out[f.severity]++; else out.handled++;
    });
    out.regressed = regressed.size;
    if (st.round) {
      out.unobserved = st.round.unobserved.length;
      out.waiverExpired = st.round.changes.filter((c) => c.reason === 'waiver-expired').length;
    }
    return out;
  };

  // ================================================================ 使用者變更
  /**
   * 變更一筆 finding 的處理紀錄：change = { status?, note?, waiver?, patch? }（S.ledger.set）。
   * 回傳 { ok: true } 或 { ok: false, error }；不合法的變更不改任何資料，錯誤由呼叫端顯示。
   */
  App.setLedger = async function (f, change) {
    if (st.blocked) return { ok: false, error: '處理紀錄目前無法使用：' + st.blocked.reason };
    let next;
    try { next = LG.set(st.ledger, App.Q.findingKey(f), change, { now: nowIso() }); } catch (e) { return { ok: false, error: e.message }; }
    st.ledger = next;
    A.renderAll();
    await persist();
    return { ok: true };
  };

  // ================================================================ 匯出與匯入
  /** 處理紀錄的 JSON 文字；停用時匯出 store 中的原資料（格式不正確的那份），讓使用者自行修正 */
  A.ledgerJson = () => JSON.stringify(st.blocked && st.blocked.raw !== undefined ? st.blocked.raw : st.ledger, null, 2) + '\n';
  App.exportLedger = function () {
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/[^0-9A-Za-z]/g, '');
    try { V.exporter.download(`ledger-${stamp}.json`, A.ledgerJson(), 'application/json'); } catch (e) {
      console.error(e); A.banner('匯出失敗：' + e.message, 10000);
    }
  };
  /** 讀入處理紀錄：先 S.ledger.validate；不合法時列出錯誤、不動現有的；合法時等使用者確認覆蓋 */
  App.importLedger = function (name, text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { st.imported = { name, errors: ['不是 JSON：' + e.message] }; A.renderAll(); return st.imported; }
    const v = LG.validate(obj);
    st.imported = v.ok ? { name, ledger: obj } : { name, errors: v.errors };
    A.renderAll();
    return st.imported;
  };
  /** 確認覆蓋：以匯入的處理紀錄取代目前的（含停用狀態），再以目前的基準推進一輪 */
  App.confirmImport = async function () {
    if (!st.imported || !st.imported.ledger) return false;
    const name = st.imported.name;
    Object.assign(st, { ledger: st.imported.ledger, imported: null, blocked: null, pendingAcks: null });
    // 同一份基準已在匯入的紀錄中時 advance 會略過（不寫入），所以一律再寫入一次
    if (App.Q) await A.advanceLedger(App.Q);
    await persist();
    A.renderAll();
    A.banner(`已以 ${name} 覆蓋處理紀錄（${Object.keys(st.ledger.items).length} 項）`, 6000);
    return true;
  };
  App.cancelImport = function () { st.imported = null; A.renderAll(); };
  /** 停用時從空白開始：舊的確認標記（acks）保留在 store 不刪；store 中格式不正確的 'ledger' 會被取代 */
  App.resetLedger = async function () {
    if (!confirm('以空白的處理紀錄重新開始？' + (st.blocked && st.blocked.raw !== undefined ? '瀏覽器中格式不正確的處理紀錄會被取代（建議先匯出原資料）。' : '舊的確認標記保留不刪。'))) return false;
    Object.assign(st, { ledger: LG.empty(), blocked: null, pendingAcks: null, acksToDelete: false, imported: null });
    // 同一份基準已在匯入的紀錄中時 advance 會略過（不寫入），所以一律再寫入一次
    if (App.Q) await A.advanceLedger(App.Q);
    await persist();
    A.renderAll();
    return true;
  };
})(globalThis.SSOT = globalThis.SSOT || {});
