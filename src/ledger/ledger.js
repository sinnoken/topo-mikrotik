/*
 * 處理紀錄（ssot-ledger/1）：使用者對每個 finding 的決定與歷程，讓一輪輪收集的結果互相銜接、逐漸收斂。
 * 這是使用者的資料，不放進 Snapshot；只透過查詢介面（S.query）讀取基準，絕不修改基準。
 * 全部是純函式：不碰 DOM／IndexedDB、不讀目前時間（時間一律由呼叫端以 now 傳入）、不修改傳入的物件。
 *
 * {
 *   schema: 'ssot-ledger/1',
 *   items: { '<findingKey>': {
 *     status, id, dev, devs?, firstSeen, lastSeen, // firstSeen／lastSeen：第一次／最後一次出現的基準鍵
 *     patch: string|null, waiver: { reason, until }|null, note,
 *     history: [{ at, from, to, by: 'user'|'advance', baseline, reason, waiver?, ack?, fromKey?, superseded? }] } },   // baseline：當時最新一輪的基準鍵
 *   iterations: [{ baseline: { inputHash, baselineKey, createdAt }, at, counts, coverage: { collected, expected }, unknownPeers }]
 * }
 * 基準鍵：基準的 meta.baselineKey（輸入、程式 major.minor 版本、命名規則、預期資料的組合，見 pipeline.js），判斷是否同一份基準。
 *   較早的處理紀錄沒有 baselineKey，firstSeen／lastSeen／history.baseline 記的是 inputHash；這些紀錄一律退回用 inputHash
 *   （baseOf），不改寫舊資料。沒有 baselineKey 的舊基準同樣退回用 inputHash。
 *   schema 維持 ssot-ledger/1：只新增選用欄位 baselineKey，舊紀錄不轉換也照常讀取，舊版程式讀到新紀錄時保留不認得的欄位
 *   （ADR-010：新增欄位且能相容讀取時不升 schema）。
 * devs：只有 findingKey 推不出設備的項目（例如只涉及 IP、MAC 的 A01）才有。最後一次出現時，證據所在區塊的設備（排序）；
 *   [] 表示證據都在沒有設備標頭的區塊（收集檔本身的問題）；null 表示推不出來（沒有證據或區塊對不到）。用來判斷能不能觀察到（見 observer）。
 *   較早的紀錄沒有這個欄位，視為推不出來；同樣是新增選用欄位，不升 schema（ADR-010）。
 * fromKey／superseded：舊鍵轉換（reason 為 facet-split 等，見 KEY_MIGRATIONS）的那一筆 history 才有。fromKey 是轉換前的舊鍵；
 *   superseded 只在新鍵已有項目時出現，保存被取代的舊項目完整內容。沒有這兩個欄位的 history 不是轉換；新增選用欄位，不升 schema（ADR-010）。
 * waiver 只在 accepted 時有值；離開 accepted 時，原本的 waiver 記在那一筆 history 的 waiver，不遺失。
 * 狀態轉換規則見 advance 與 set 的說明。
 */
(function (S) {
  'use strict';
  const U = S.util;
  const K = S.keys;
  const L = {};
  const SCHEMA = 'ssot-ledger/1';
  const STATUS = ['open', 'scheduled', 'fixed', 'accepted', 'false-positive', 'regressed'];
  const BY = ['user', 'advance'];
  const DAY_MS = 86400000;
  const WAIVER_DAYS = 182; // 豁免預設約半年，到期後重新檢視
  const COUNT_KEYS = ['new', 'fixed', 'open', 'scheduled', 'regressed', 'accepted', 'falsePositive', 'waiverExpired', 'unobserved'];
  /** 舊確認標記（app-acks 的 kind）→ 狀態；未分類（null）與不認得的分類視為 accepted（舊確認的意義就是「看過、決定接受」） */
  const ACK_KIND = { accepted: 'accepted', scheduled: 'scheduled', 'false-positive': 'false-positive' };
  /**
   * 使用者可以做的轉換（from → 允許的 to）。fixed 與 regressed 是依基準判定的結果：
   * regressed 只能由 advance 產生；fixed 只允許在項目已不在最新一輪基準時手動標記（例如設備已移除、無法自動判斷）。
   * 已 fixed 的項目不能改狀態（之後若再出現，advance 會標為 regressed）；仍可修改 note 與 patch。
   */
  const USER_TO = {
    open: ['scheduled', 'accepted', 'false-positive', 'fixed'],
    scheduled: ['open', 'accepted', 'false-positive', 'fixed'],
    accepted: ['open', 'scheduled', 'false-positive', 'fixed'],
    'false-positive': ['open', 'scheduled', 'accepted', 'fixed'],
    regressed: ['open', 'scheduled', 'accepted', 'false-positive', 'fixed'],
    fixed: [],
  };

  // ---- 共用小工具
  const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
  const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const isStrOrNull = (v) => v === null || typeof v === 'string';
  const isCount = (v) => Number.isInteger(v) && v >= 0;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  /** 時間參數：必須是 ISO 8601（可只有日期，視為 UTC 0 時）；正規化成 toISOString 的形式，結果才可重現 */
  const isoOf = (v, what) => {
    if (!isIso(v)) throw new Error(`${what} 必須是 ISO 8601 時間字串（例如 2026-01-01T00:00:00Z），目前是 ${JSON.stringify(v)}`);
    return new Date(Date.parse(v)).toISOString();
  };
  const nowOf = (opt) => isoOf((opt || {}).now, 'now');
  /** 一輪（iterations[].baseline）或一份基準（meta）的基準鍵；舊紀錄、舊基準沒有 baselineKey 時退回用 inputHash */
  const baseOf = (b) => (b && b.baselineKey != null ? b.baselineKey : b && b.inputHash);
  const sortItems = (items) => { const out = {}; Object.keys(items).sort(U.cmp).forEach((k) => { out[k] = items[k]; }); return out; };

  /** findingKey → [id, 'type:key', ...]；不是 Q.findingKey 的形式時回傳 null */
  function parseKey(key) {
    let a;
    try { a = JSON.parse(key); } catch (e) { return null; }
    return Array.isArray(a) && a.length && a.every((x) => typeof x === 'string') && a[0] ? a : null;
  }
  /**
   * findingKey 涉及的設備（排序）：device 的鍵、interface／rule／service 鍵的設備部分（DEV|…）、link 兩端的設備。
   * ip、mac、vlan 不屬於單一設備。
   */
  function devicesOfKey(key) {
    const a = parseKey(key); if (!a) return [];
    const out = [];
    a.slice(1).forEach((ent) => {
      const i = ent.indexOf(':'); const type = ent.slice(0, i); const k = ent.slice(i + 1);
      if (type === 'device') out.push(k);
      else if (type === 'interface' || type === 'rule' || type === 'service') out.push(K.splitEp(k)[0]);
      else if (type === 'link') k.split('~').forEach((ep) => out.push(K.splitEp(ep)[0]));
    });
    return U.uniq(out).sort(U.cmp);
  }
  /** 項目的 dev：只涉及一台設備時是該設備，否則（沒有或多台）為 null */
  const devOfKey = (key) => { const d = devicesOfKey(key); return d.length === 1 ? d[0] : null; };

  // ---- 驗證
  /**
   * 驗證處理紀錄（匯入時使用）。不修改、不丟棄任何資料；回傳 { ok, errors }，errors 每筆指出位置與原因。
   * 不認得的欄位（較新版本寫入的）保留，不算錯誤。
   */
  L.validate = function validate(obj) {
    const errors = [];
    const err = (path, msg) => errors.push(`${path}：${msg}`);
    if (!isObj(obj)) return { ok: false, errors: ['（根）：必須是物件'] };
    if (obj.schema !== SCHEMA) err('schema', `必須是 ${SCHEMA}，目前是 ${JSON.stringify(obj.schema)}`);
    if (!isObj(obj.items)) err('items', '必須是物件（以 findingKey 為鍵）');
    else Object.keys(obj.items).forEach((key) => {
      const p = `items[${key}]`; const it = obj.items[key];
      const a = parseKey(key);
      if (!a) err(p, '鍵不是 findingKey 的形式（JSON 字串陣列，第一個元素是規則 id）');
      if (!isObj(it)) { err(p, '必須是物件'); return; }
      if (!STATUS.includes(it.status)) err(p + '.status', `必須是 ${STATUS.join('／')} 之一，目前是 ${JSON.stringify(it.status)}`);
      if (typeof it.id !== 'string' || !it.id) err(p + '.id', '必須是非空字串');
      else if (a && a[0] !== it.id) err(p + '.id', `與鍵的規則 id（${a[0]}）不一致`);
      if (!isStrOrNull(it.dev)) err(p + '.dev', '必須是字串或 null');
      if (it.devs !== undefined && it.devs !== null && (!Array.isArray(it.devs) || it.devs.some((d) => typeof d !== 'string' || !d))) err(p + '.devs', '必須是設備鍵（非空字串）的陣列或 null');
      ['firstSeen', 'lastSeen', 'patch'].forEach((f) => { if (!isStrOrNull(it[f])) err(`${p}.${f}`, '必須是字串或 null'); });
      if (typeof it.note !== 'string') err(p + '.note', '必須是字串');
      if (it.waiver !== null) {
        if (!isObj(it.waiver)) err(p + '.waiver', '必須是 { reason, until } 或 null');
        else {
          if (typeof it.waiver.reason !== 'string') err(p + '.waiver.reason', '必須是字串');
          if (!isIso(it.waiver.until)) err(p + '.waiver.until', `必須是 ISO 8601 時間，目前是 ${JSON.stringify(it.waiver.until)}`);
        }
      }
      if (it.status === 'accepted' && it.waiver === null) err(p + '.waiver', 'accepted 必須有豁免（原因與到期日）');
      if (it.status !== 'accepted' && it.waiver != null) err(p + '.waiver', `只有 accepted 可以有豁免，目前狀態是 ${it.status}`);
      if (!Array.isArray(it.history)) err(p + '.history', '必須是陣列');
      else it.history.forEach((h, i) => {
        const hp = `${p}.history[${i}]`;
        if (!isObj(h)) { err(hp, '必須是物件'); return; }
        if (!isIso(h.at)) err(hp + '.at', `必須是 ISO 8601 時間，目前是 ${JSON.stringify(h.at)}`);
        if (h.from !== null && !STATUS.includes(h.from)) err(hp + '.from', `必須是狀態或 null，目前是 ${JSON.stringify(h.from)}`);
        if (!STATUS.includes(h.to)) err(hp + '.to', `必須是狀態，目前是 ${JSON.stringify(h.to)}`);
        if (!BY.includes(h.by)) err(hp + '.by', `必須是 ${BY.join('／')}，目前是 ${JSON.stringify(h.by)}`);
        if (!isStrOrNull(h.baseline)) err(hp + '.baseline', '必須是字串（基準鍵；舊紀錄為 inputHash）或 null');
        if (h.reason !== undefined && !isStrOrNull(h.reason)) err(hp + '.reason', '必須是字串或 null');
        if (h.fromKey !== undefined && !parseKey(h.fromKey)) err(hp + '.fromKey', '必須是 findingKey（轉換前的舊鍵）');
      });
    });
    if (!Array.isArray(obj.iterations)) err('iterations', '必須是陣列');
    else {
      const seen = new Set();
      obj.iterations.forEach((r, i) => {
        const p = `iterations[${i}]`;
        if (!isObj(r)) { err(p, '必須是物件'); return; }
        if (!isObj(r.baseline) || typeof r.baseline.inputHash !== 'string' || !r.baseline.inputHash) err(p + '.baseline.inputHash', '必須是非空字串');
        else if (r.baseline.baselineKey !== undefined && (typeof r.baseline.baselineKey !== 'string' || !r.baseline.baselineKey)) err(p + '.baseline.baselineKey', '必須是非空字串（舊紀錄可以沒有這個欄位）');
        else {
          // 各輪的基準鍵不可重複；舊紀錄沒有 baselineKey 時以 inputHash 比較
          const f = r.baseline.baselineKey !== undefined ? 'baselineKey' : 'inputHash'; const b = baseOf(r.baseline);
          if (seen.has(b)) err(`${p}.baseline.${f}`, `與前面的一輪重複（${b}）`); else seen.add(b);
        }
        if (isObj(r.baseline) && !isStrOrNull(r.baseline.createdAt)) err(p + '.baseline.createdAt', '必須是字串或 null');
        if (!isIso(r.at)) err(p + '.at', `必須是 ISO 8601 時間，目前是 ${JSON.stringify(r.at)}`);
        if (!isObj(r.counts)) err(p + '.counts', '必須是物件');
        else COUNT_KEYS.forEach((k) => { if (r.counts[k] !== undefined && !isCount(r.counts[k])) err(`${p}.counts.${k}`, '必須是非負整數'); });
        if (!isObj(r.coverage) || !isCount(r.coverage.collected) || !isCount(r.coverage.expected)) err(p + '.coverage', '必須是 { collected, expected }（非負整數）');
        if (!isCount(r.unknownPeers)) err(p + '.unknownPeers', '必須是非負整數');
      });
    }
    return { ok: !errors.length, errors };
  };
  /** 函式入口共用：格式不對就丟錯（列出前幾項），不靜默修正 */
  function checked(ledger) {
    const v = L.validate(ledger);
    if (!v.ok) throw new Error(`處理紀錄格式不正確（${v.errors.length} 項）：${v.errors.slice(0, 5).join('；')}${v.errors.length > 5 ? '…' : ''}`);
    return clone(ledger);
  }

  L.empty = () => ({ schema: SCHEMA, items: {}, iterations: [] });

  // ---- 推進一輪
  /**
   * 基準能不能判斷「某設備上的問題已經消失」：
   *   該設備已收集且沒有任何收集失敗 → 可以；只在鄰居資料中出現（未收集）→ 可以（它的問題不依賴它自己的輸出）；
   *   已收集但有收集失敗、或整台不在基準中 → 不行（問題消失可能只是沒收到資料）。
   * findingKey 推不出設備的問題（例如只涉及 IP、MAC）改看項目的 devs（證據所在區塊的設備）：
   *   devs 的設備都已收集且沒有收集失敗 → 可以。換成另一個網路時這些設備不在基準中，所以不判斷。
   *   devs 為 []（證據都在沒有設備標頭的區塊，是收集檔本身的問題）→ 基準中沒有任何收集失敗時才可以。
   *   沒有 devs（舊紀錄）或為 null（推不出來）→ 不行，保守列為 unobserved。
   */
  function observer(Q) {
    const rows = new Map(Q.coverage().map((r) => [r.dev, r]));
    const anyFailure = Q.coverage().some((r) => r.failures && r.failures.length);
    const devOk = (d) => { const r = rows.get(d); return !!r && (!r.collected || !(r.failures || []).length); };
    const collectedOk = (d) => { const r = rows.get(d); return !!r && r.collected && !(r.failures || []).length; };
    return (key, it) => {
      const ds = devicesOfKey(key);
      if (ds.length) return ds.every(devOk);
      if (!Array.isArray(it.devs)) return false;
      return it.devs.length ? it.devs.every(collectedOk) : !anyFailure;
    };
  }
  /**
   * findingKey 推不出設備時，同一個鍵的所有 finding 的證據所在區塊的設備（排序）；
   * 證據都在沒有設備標頭的區塊時為 []；沒有證據或有區塊對不到時為 null（推不出來）。
   */
  function evidenceDevs(Q, findings) {
    const out = [];
    for (const f of findings) {
      const ev = f.evidence || [];
      if (!ev.length) return null;
      for (const e of ev) {
        const b = typeof Q.block === 'function' ? Q.block(e.block) : null;
        if (!b) return null;
        if (b.devKey != null) out.push(b.devKey);
      }
    }
    return U.uniq(out).sort(U.cmp);
  }
  /** 這一輪的覆蓋：collected＝已收集設備數，expected＝已收集＋應收集但未收集（C01，與檢查規則同一個來源） */
  function coverageOf(Q) {
    const collected = Q.devices().filter((d) => d.collected).length;
    const c01 = U.uniq(Q.findings().filter((f) => f.id === 'C01').map(Q.findingKey)).length;
    return { collected, expected: collected + c01 };
  }
  const unknownPeersOf = (Q) => Q.unknownDevices().reduce((n, d) => n + Q.unknownPeers(d).length, 0);

  // ---- 舊鍵轉換（findingKey 的組成改變時，把舊鍵的決定帶到新鍵）
  /**
   * 鍵的組成改變（ADR-003）後，一個舊鍵可能對應到新基準中的多個新鍵（「舊鍵分裂」）。
   * 每條規則：{ reason, oldKeys(Q, f) → string[] }，給新基準的一筆 finding，回傳它可能對應到的舊鍵（可以是空陣列）。
   *   reason 寫進新項目那一筆 history 的 reason，用來說明是哪一種轉換。
   * 擴充方式：在這裡加一條規則即可，轉換流程（migrateKeys）不用改。例如之後 VRF（ssot-snapshot/3）讓實體鍵多了 @VRF：
   *   { reason: 'vrf-split', oldKeys: (Q, f) => [去掉實體鍵的 @VRF 後的鍵] }；或對 A07／A08／A09／R06 這類依 VRF 拆開、
   *   實體變少的規則，回傳「實體是它的超集合」的舊鍵（需要時可在規則內參考處理紀錄現有的鍵，由 data-model 提供鍵的拆解函式）。
   * 規則依陣列順序套用；同一筆 finding 的新鍵與舊鍵相同時不算轉換。
   */
  const KEY_MIGRATIONS = [
    // 2.9.0：有 facet 的規則，鍵多了 "facet:…"；舊鍵就是不含 facet 的鍵（一個舊鍵對應到 facet 不同的每一筆）
    { reason: 'facet-split', oldKeys: (Q, f) => (f.facet != null ? [Q.findingBaseKey(f)] : []) },
  ];
  /**
   * 依 KEY_MIGRATIONS 把舊鍵的項目轉換到新鍵（直接修改 items，呼叫端傳入的是複本）。回傳 [{ from: 舊鍵, to: [新鍵…], reason }]，依舊鍵排序。
   * 只轉換「處理紀錄有這個舊鍵、而且舊鍵不在新基準中」的項目（舊鍵仍出現在基準時它本身就是現行的項目）。
   *   新鍵還沒有項目：複製整個舊項目（狀態、note、waiver、patch、firstSeen、歷程與不認得的欄位），
   *     歷程加一筆 { from: 狀態, to: 狀態, by: 'advance', reason, fromKey: 舊鍵 }。
   *   新鍵已有項目（只有混用新舊版本時會發生）：以新鍵的項目為準，歷程加一筆同樣的紀錄，並在 superseded 保存舊項目的完整內容。
   *   處理完的舊項目移除：它的內容已在每一筆新項目裡，留著會被判為「消失 → fixed」或重複計數。
   * 冪等：舊項目轉換後就移除，之後的基準不會再轉換；同一份基準再推進時依基準鍵略過。
   */
  function migrateKeys(items, Q, present, step) {
    const targets = new Map(); // 舊鍵 → Map(新鍵 → reason)
    Q.findings().forEach((f) => {
      const nk = Q.findingKey(f);
      KEY_MIGRATIONS.forEach((m) => m.oldKeys(Q, f).forEach((ok) => {
        if (ok === nk || !items[ok] || present.has(ok)) return;
        const t = U.getOr(targets, ok, () => new Map());
        if (!t.has(nk)) t.set(nk, m.reason);
      }));
    });
    const out = [];
    Array.from(targets.keys()).sort(U.cmp).forEach((ok) => {
      const old = items[ok]; const t = targets.get(ok); const to = Array.from(t.keys()).sort(U.cmp);
      to.forEach((nk) => {
        const entry = (status) => ({ at: step.at, from: status, to: status, by: 'advance', baseline: step.baseline, reason: t.get(nk), fromKey: ok });
        if (items[nk]) items[nk].history.push(Object.assign(entry(items[nk].status), { superseded: clone(old) }));
        else { const it = clone(old); it.dev = devOfKey(nk); it.history.push(entry(it.status)); items[nk] = it; }
      });
      delete items[ok];
      out.push({ from: ok, to, reason: U.uniq(to.map((nk) => t.get(nk))).join('、') });
    });
    return out;
  }

  function moveTo(it, to, h) {
    const entry = Object.assign({ at: h.at, from: it.status, to, by: h.by, baseline: h.baseline, reason: h.reason || null }, h.extra || {});
    if (it.status === 'accepted' && to !== 'accepted' && it.waiver) { entry.waiver = it.waiver; it.waiver = null; }
    it.history.push(entry);
    it.status = to;
  }

  /**
   * 以新基準推進一輪，回傳 { ledger, changes, unobserved, split, skipped }：
   *   changes   ：[{ key, from, to, reason }]，依 key 排序；reason 為 new／disappeared／reappeared／waiver-expired
   *   unobserved：基準中沒有、但無法判斷是否已修好的待處理項目鍵（狀態不變，見 observer）
   *   split     ：[{ from: 舊鍵, to: [新鍵…], reason }]，這一輪由舊鍵轉換到新鍵的項目（見 KEY_MIGRATIONS、migrateKeys），依舊鍵排序。
   *               轉換在判定之前進行：新項目沿用舊狀態再照下列規則判定，舊項目移除，不會被判為 fixed
   *   skipped   ：這份基準（基準鍵相同）已經推進過時為 true，ledger 原樣回傳、不新增一輪（split 為 []）
   * 轉換（present＝基準中有這個 findingKey；absent＝沒有且可以判斷；unobserved＝沒有但無法判斷）：
   *   （無）        present → open（new）
   *   open／scheduled／regressed：present 不變；absent → fixed（disappeared）；unobserved 不變
   *   fixed         present → regressed（reappeared）；其餘不變
   *   accepted      waiver.until < now → open（waiver-expired，不論是否出現）；否則不變
   *   false-positive 不變（判斷的是規則本身，不是網路現況；保留以供規則品質統計）
   * 出現在基準中的項目更新 lastSeen（第一次出現時也補 firstSeen），記的是基準鍵。
   */
  L.advance = function advance(ledger, Q, opt) {
    const now = nowOf(opt);
    const out = checked(ledger);
    const meta = Q.meta();
    if (typeof meta.inputHash !== 'string' || !meta.inputHash) throw new Error('基準沒有 inputHash，無法推進處理紀錄');
    if (meta.baselineKey != null && (typeof meta.baselineKey !== 'string' || !meta.baselineKey)) throw new Error('基準的 baselineKey 必須是非空字串');
    const hash = baseOf(meta);
    if (out.iterations.some((r) => baseOf(r.baseline) === hash)) return { ledger: out, changes: [], unobserved: [], split: [], skipped: true };
    const present = new Map(); const byKey = new Map();
    Q.findings().forEach((f) => { const k = Q.findingKey(f); if (!present.has(k)) present.set(k, f); U.getOr(byKey, k, () => []).push(f); });
    const step = { at: now, by: 'advance', baseline: hash };
    // 先把舊鍵轉換到新鍵，舊項目才不會在下面被判為消失
    const split = migrateKeys(out.items, Q, present, step);
    const devsOf = (key) => (devicesOfKey(key).length ? undefined : evidenceDevs(Q, byKey.get(key)));
    const canJudge = observer(Q);
    const changes = []; const unobserved = [];
    const delta = { new: 0, fixed: 0, waiverExpired: 0 };
    const tNow = Date.parse(now);
    const change = (key, it, to, reason) => {
      changes.push({ key, from: it.status, to, reason });
      moveTo(it, to, Object.assign({ reason }, step));
    };
    Object.keys(out.items).forEach((key) => {
      const it = out.items[key];
      const here = present.has(key);
      if (here) {
        it.lastSeen = hash; if (it.firstSeen === null) it.firstSeen = hash;
        const ds = devsOf(key); if (ds !== undefined) it.devs = ds;
      }
      if (it.status === 'accepted') {
        if (Date.parse(it.waiver.until) < tNow) { change(key, it, 'open', 'waiver-expired'); delta.waiverExpired++; }
        return;
      }
      if (it.status === 'fixed') { if (here) change(key, it, 'regressed', 'reappeared'); return; }
      if (it.status === 'false-positive' || here) return;
      // open／scheduled／regressed 且基準中沒有
      if (canJudge(key, it)) { change(key, it, 'fixed', 'disappeared'); delta.fixed++; } else unobserved.push(key);
    });
    present.forEach((f, key) => {
      if (out.items[key]) return;
      const ds = devsOf(key);
      out.items[key] = Object.assign({ status: 'open', id: f.id, dev: devOfKey(key) }, ds !== undefined ? { devs: ds } : {}, { firstSeen: hash, lastSeen: hash, patch: null, waiver: null, note: '',
        history: [{ at: now, from: null, to: 'open', by: 'advance', baseline: hash, reason: 'new' }] });
      changes.push({ key, from: null, to: 'open', reason: 'new' });
      delta.new++;
    });
    out.items = sortItems(out.items);
    changes.sort((a, b) => U.cmp(a.key, b.key));
    unobserved.sort(U.cmp);
    const tally = byStatus(out);
    out.iterations.push({
      baseline: Object.assign({ inputHash: meta.inputHash }, meta.baselineKey != null ? { baselineKey: meta.baselineKey } : {}, { createdAt: meta.createdAt || null }), at: now,
      counts: { new: delta.new, fixed: delta.fixed, open: tally.open, scheduled: tally.scheduled, regressed: tally.regressed, accepted: tally.accepted,
        falsePositive: tally['false-positive'], waiverExpired: delta.waiverExpired, unobserved: unobserved.length },
      coverage: coverageOf(Q), unknownPeers: unknownPeersOf(Q),
    });
    return { ledger: out, changes, unobserved, split, skipped: false };
  };

  function byStatus(ledger) {
    const t = {}; STATUS.forEach((s) => { t[s] = 0; });
    Object.values(ledger.items).forEach((it) => { t[it.status]++; });
    return t;
  }

  // ---- 使用者變更
  /** 豁免：until 省略時為 now＋182 天；until 必須晚於 now（否則一建立就到期） */
  function waiverOf(w, now) {
    if (!isObj(w)) throw new Error('accepted 必須附豁免 waiver：{ reason, until? }');
    if (w.reason !== undefined && typeof w.reason !== 'string') throw new Error('waiver.reason 必須是字串');
    const until = w.until == null ? new Date(Date.parse(now) + WAIVER_DAYS * DAY_MS).toISOString() : isoOf(w.until, 'waiver.until');
    if (Date.parse(until) <= Date.parse(now)) throw new Error(`waiver.until（${until}）必須晚於 now（${now}）`);
    return { reason: (w.reason || '').trim(), until };
  }
  /**
   * 使用者手動變更一個項目：change = { status?, note?, waiver?, patch? }，省略的欄位不變。回傳新的 ledger。
   * 允許的狀態轉換見 USER_TO；不合法的轉換、不存在的鍵、格式不對的欄位都丟出錯誤。
   * accepted 必須有 waiver（until 省略時預設 now＋182 天）；其他狀態不能給 waiver。
   * 有任何欄位改變時寫入一筆 history（狀態不變時 from＝to，reason 為 edit）；完全沒有改變時原樣回傳。
   */
  L.set = function set(ledger, key, change, opt) {
    const now = nowOf(opt);
    const out = checked(ledger);
    const it = out.items[key];
    if (!it) throw new Error(`處理紀錄沒有這個項目：${key}（請先以 advance 推進含有它的基準）`);
    const c = change || {};
    const to = c.status === undefined ? it.status : c.status;
    if (!STATUS.includes(to)) throw new Error(`不認得的狀態：${JSON.stringify(to)}（可用：${STATUS.join('／')}）`);
    const last = out.iterations[out.iterations.length - 1];
    if (to !== it.status) {
      if (!USER_TO[it.status].includes(to)) throw new Error(`不能由 ${it.status} 手動改為 ${to}${to === 'regressed' ? '（regressed 只由 advance 依基準判定）' : ''}`);
      if (to === 'fixed' && last && it.lastSeen === baseOf(last.baseline)) throw new Error('這個項目仍出現在最新一輪基準中，不能手動標為 fixed（修好後重新收集，advance 會判定）');
    }
    if (c.waiver !== undefined && c.waiver !== null && to !== 'accepted') throw new Error(`只有 accepted 可以有豁免，目前要設為 ${to}`);
    if (c.note !== undefined && typeof c.note !== 'string') throw new Error('note 必須是字串');
    if (c.patch !== undefined && !isStrOrNull(c.patch)) throw new Error('patch 必須是字串（patch 鍵）或 null');
    const waiver = to !== 'accepted' ? null : c.waiver !== undefined ? waiverOf(c.waiver, now) : it.status === 'accepted' ? it.waiver : waiverOf(null, now);
    const note = c.note === undefined ? it.note : c.note.trim();
    const patch = c.patch === undefined ? it.patch : c.patch;
    if (to === it.status && note === it.note && patch === it.patch && JSON.stringify(waiver) === JSON.stringify(it.waiver)) return out;
    const entry = { at: now, from: it.status, to, by: 'user', baseline: last ? baseOf(last.baseline) : null, reason: to === it.status ? 'edit' : null };
    if (it.waiver && JSON.stringify(waiver) !== JSON.stringify(it.waiver)) entry.waiver = it.waiver; // 被取代或移除的豁免記在歷程
    it.history.push(entry);
    Object.assign(it, { status: to, note, patch, waiver });
    return out;
  };

  // ---- 從舊確認標記轉換
  /**
   * 把 app-acks 的確認標記（{ findingKey: { at, kind, note } }，或同內容的 Map）轉成處理紀錄，接著以 Q 推進一輪。
   * 回傳與 advance 相同的 { ledger, changes, unobserved, split, skipped }。
   * 舊確認標記用的是當時的鍵：推進時依 KEY_MIGRATIONS 轉換到新鍵（例如 2.9.0 以前的 A12 鍵轉成 dns／ntp 兩筆），規則與 advance 相同。
   *   kind：accepted→accepted、scheduled→scheduled、false-positive→false-positive；未分類（null）與不認得的分類→accepted。
   *   accepted 的豁免原因取 note，到期日為 now＋182 天（從轉換時起算，避免很久以前的確認一轉換就到期）。
   *   每筆的第一筆 history 是 { at: 確認時間, from: null, to, by: 'user', baseline: null, reason: 'from-ack', ack: 原始紀錄 }，原始內容不遺失。
   * 任何一筆格式不對（鍵不是 findingKey、at 不是 ISO 時間、kind／note 型別不對）就丟錯並列出全部問題，不略過。
   */
  L.fromAcks = function fromAcks(acks, Q, opt) {
    const now = nowOf(opt);
    const entries = acks instanceof Map ? Array.from(acks.entries()) : isObj(acks) ? Object.entries(acks) : null;
    if (!entries) throw new Error('acks 必須是 { findingKey: { at, kind, note } } 物件或 Map');
    const errors = []; const out = L.empty();
    entries.forEach(([key, a]) => {
      const p = `acks[${key}]`; const k = parseKey(key);
      if (!k) { errors.push(`${p}：鍵不是 findingKey`); return; }
      if (!isObj(a)) { errors.push(`${p}：必須是物件`); return; }
      if (!isIso(a.at)) { errors.push(`${p}.at：必須是 ISO 8601 時間，目前是 ${JSON.stringify(a.at)}`); return; }
      if (a.kind != null && typeof a.kind !== 'string') { errors.push(`${p}.kind：必須是字串或 null`); return; }
      if (a.note != null && typeof a.note !== 'string') { errors.push(`${p}.note：必須是字串`); return; }
      const status = ACK_KIND[a.kind] || 'accepted';
      const note = (a.note || '').trim();
      out.items[key] = { status, id: k[0], dev: devOfKey(key), firstSeen: null, lastSeen: null, patch: null,
        waiver: status === 'accepted' ? waiverOf({ reason: note }, now) : null, note,
        history: [{ at: isoOf(a.at, p + '.at'), from: null, to: status, by: 'user', baseline: null, reason: 'from-ack', ack: clone(a) }] };
    });
    if (errors.length) throw new Error(`確認標記有 ${errors.length} 筆格式不正確：${errors.join('；')}`);
    out.items = sortItems(out.items);
    return L.advance(out, Q, { now });
  };

  /**
   * 這份基準是處理紀錄的第幾輪（iterations 的索引，0 起算）；沒有推進過時為 -1。
   * meta 是基準的 meta（或 iterations[].baseline 的形式）；判斷方式和 advance 的冪等判斷相同（基準鍵，舊資料退回 inputHash）。
   * 工作包用它確認基準和處理紀錄是同一輪。
   */
  L.roundOf = function roundOf(ledger, meta) {
    const v = L.validate(ledger);
    if (!v.ok) throw new Error(`處理紀錄格式不正確（${v.errors.length} 項）：${v.errors.slice(0, 5).join('；')}${v.errors.length > 5 ? '…' : ''}`);
    const b = baseOf(meta);
    if (typeof b !== 'string' || !b) throw new Error('基準沒有 baselineKey 或 inputHash');
    return ledger.iterations.findIndex((r) => baseOf(r.baseline) === b);
  };

  // ---- 統計
  /**
   * 趨勢圖用的時間序列與目前狀態：
   *   series ：每一輪 { at, inputHash, baselineKey（舊紀錄為 null）, createdAt, counts, pending（open＋regressed，待處理）, coverage: { collected, expected, ratio }, unknownPeers }
   *   current：{ total, byStatus: { 狀態: 筆數 }, waivers: { total, missingReason（豁免沒寫原因的筆數） } }
   * ratio 為 collected／expected（expected 為 0 時為 null）。
   */
  L.summary = function summary(ledger) {
    const lg = checked(ledger);
    const series = lg.iterations.map((r) => ({
      at: r.at, inputHash: r.baseline.inputHash, baselineKey: r.baseline.baselineKey ?? null, createdAt: r.baseline.createdAt, counts: r.counts,
      pending: (r.counts.open || 0) + (r.counts.regressed || 0),
      coverage: { collected: r.coverage.collected, expected: r.coverage.expected, ratio: r.coverage.expected ? r.coverage.collected / r.coverage.expected : null },
      unknownPeers: r.unknownPeers,
    }));
    const items = Object.values(lg.items);
    const waived = items.filter((it) => it.waiver);
    return { series, current: { total: items.length, byStatus: byStatus(lg), waivers: { total: waived.length, missingReason: waived.filter((it) => !it.waiver.reason).length } } };
  };
  /**
   * 各規則的處理結果（規則品質閉環的依據），依規則編號排序：
   * [{ id, total, byStatus: { 狀態: 筆數 }, falsePositive, rate }]；rate＝目前標為 false-positive 的比率（falsePositive／total）。
   */
  L.ruleStats = function ruleStats(ledger) {
    const lg = checked(ledger);
    const by = new Map();
    Object.values(lg.items).forEach((it) => {
      const r = U.getOr(by, it.id, () => { const b = {}; STATUS.forEach((s) => { b[s] = 0; }); return { id: it.id, total: 0, byStatus: b }; });
      r.total++; r.byStatus[it.status]++;
    });
    return Array.from(by.values()).sort((a, b) => U.natural(a.id, b.id))
      .map((r) => Object.assign(r, { falsePositive: r.byStatus['false-positive'], rate: r.byStatus['false-positive'] / r.total }));
  };

  Object.assign(L, { SCHEMA, STATUS, WAIVER_DAYS, USER_TO, KEY_MIGRATIONS, devicesOfKey });
  S.ledger = L;
})(globalThis.SSOT = globalThis.SSOT || {});
