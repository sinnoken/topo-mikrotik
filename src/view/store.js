/*
 * 瀏覽器儲存：用 IndexedDB 儲存最後一次的輸入、基準與節點位置（不會自動過期）。
 * 無法使用 IndexedDB 時（例如隱私模式）退回記憶體，畫面會提示。
 * 唯一的例外是配色偏好（S.store.theme）：首次繪製前要同步讀到，所以放 localStorage（理由見下方）。
 * 存了哪些鍵、中文名稱與用途只定義在下方的 KEYS（設定「本機資料」的清單、清除與備份都依它）。
 */
(function (S) {
  'use strict';
  const DB = 'topo-mikrotik'; const STORE = 'kv';
  // 每個鍵最後一次寫入或刪除的時間：store 自己記，不是使用者的資料（不列在 keys、不進備份）。舊版沒有記錄的鍵沒有時間
  const META = 'meta:updatedAt';
  let dbp = null; const mem = new Map();
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  const tx = (db, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(STORE, mode); const st = t.objectStore(STORE); const r = fn(st);
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
  });
  /** 同一筆交易裡更新 META 的時間（at 為 null 時刪掉這個鍵的時間） */
  const stamp = (st, keys, at) => {
    const g = st.get(META);
    g.onsuccess = () => { const m = Object.assign({}, g.result || {}); keys.forEach((k) => { if (at) m[k] = at; else delete m[k]; }); st.put(m, META); };
  };
  const memStamp = (keys, at) => { const m = Object.assign({}, mem.get(META) || {}); keys.forEach((k) => { if (at) m[k] = at; else delete m[k]; }); mem.set(META, m); };
  const nowIso = () => new Date().toISOString();
  /*
   * 寫入的次數（這個頁面經 S.store 的寫入、刪除、還原與配色）：寫入完成後才加一，畫面據此判斷清單要不要重讀。
   * sizes 是每個鍵的大小快取 { at, bytes }，at 是 META 記的更新時間；本頁寫入時刪掉該鍵的快取，其他分頁寫入時 META 的時間不同也會重算
   */
  let rev = 0; const sizes = new Map();
  const changed = (keys) => { keys.forEach((k) => sizes.delete(k)); rev++; };
  S.store = {
    async available() { return !!(await open()); },
    async get(k) { const db = await open(); return db ? tx(db, 'readonly', (s) => s.get(k)) : mem.get(k); },
    async set(k, v) {
      const db = await open(); const at = nowIso();
      if (!db) { mem.set(k, v); memStamp([k], at); changed([k]); return; }
      try { return await tx(db, 'readwrite', (s) => { const r = s.put(v, k); stamp(s, [k], at); return r; }); } finally { changed([k]); }
    },
    async del(k) {
      const db = await open();
      if (!db) { mem.delete(k); memStamp([k], null); changed([k]); return; }
      try { return await tx(db, 'readwrite', (s) => { const r = s.delete(k); stamp(s, [k], null); return r; }); } finally { changed([k]); }
    },
    /** 寫入的次數：數字不同表示這個頁面寫過資料（清單要重讀）；只讀不變 */
    revision: () => rev,
  };

  /*
   * 配色偏好（跟隨系統／淺色／深色）：唯一放在 localStorage 的資料。
   * 首次繪製前就要知道深淺（index.html 的 inline script 同步讀），IndexedDB 是非同步的，等它讀回來畫面已經以系統的深淺畫過一次（閃一下）。
   * 只是顯示偏好、很小，不是基準或處理紀錄；其他資料仍只在 IndexedDB。localStorage 無法使用（被封鎖、沙箱）時退回記憶體，set 回傳 false 讓畫面提示。
   */
  const THEME_KEY = 'topo-mikrotik:theme';
  const THEMES = Object.freeze(['system', 'light', 'dark']);
  let themeMem = null; const themeWarned = new Set();
  const ls = () => { try { return globalThis.localStorage || null; } catch (e) { return null; } };
  /** 存著的原值（沒有存過時 null）；不驗證 */
  const themeRaw = () => {
    if (themeMem !== null) return themeMem;
    const st = ls(); try { return st ? st.getItem(THEME_KEY) : null; } catch (e) { return null; }
  };
  S.store.theme = Object.freeze({
    KEY: THEME_KEY, VALUES: THEMES,
    /** 目前的偏好；沒有存過時 'system'。存的值不合法時忽略（不改寫）、退回 'system'，並 console.warn（同一個值只警告一次） */
    get() {
      const v = themeRaw();
      if (v === null || v === undefined) return 'system';
      if (THEMES.includes(v)) return v;
      if (!themeWarned.has(v)) { themeWarned.add(v); console.warn(`配色偏好 ${JSON.stringify(v)} 不是 ${THEMES.join('／')} 之一，已忽略，改用跟隨系統。`); }
      return 'system';
    },
    /** 存偏好；不合法的值丟 RangeError。存不進 localStorage 時記在記憶體（這次有效）並回傳 false */
    set(v) {
      if (!THEMES.includes(v)) throw new RangeError('未知的配色偏好：' + v);
      const st = ls(); rev++;
      try { if (!st) throw new Error('localStorage 無法使用'); st.setItem(THEME_KEY, v); themeMem = null; return true; } catch (e) { themeMem = v; return false; }
    },
    /** 刪掉偏好（回到跟隨系統）；localStorage 無法使用時只清記憶體並回傳 false */
    clear() {
      themeMem = null; const st = ls(); rev++;
      try { if (!st) return false; st.removeItem(THEME_KEY); return true; } catch (e) { return false; }
    },
  });

  // ================================================================ 本機資料的描述表（單一來源）
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  /**
   * 儲存的「基準與輸入」（'last'）能不能還原：App.restore 與還原備份的檢查共用這一個判斷。
   * 回傳 { ok, reason, meta, rebuild }：
   *   meta     S.query.metaOf 讀到的 meta（沒有時 null）
   *   rebuild  要用儲存的輸入重建（格式或程式版本不同、且有輸入）
   *   reason   不能還原的原因（ok 為 false 時）
   * 格式不同又沒有儲存輸入時不能還原（沒有東西可以重建）。重建本身可能失敗，那由 App.restore 說明。
   */
  function lastRestorable(v) {
    if (!isObj(v) || !isObj(v.snapshot)) return { ok: false, reason: '應是含 snapshot 的物件', meta: null, rebuild: false };
    if (v.sources !== undefined && !Array.isArray(v.sources)) return { ok: false, reason: 'sources 應是陣列', meta: null, rebuild: false };
    const meta = S.query.metaOf(v.snapshot);
    if (!meta) return { ok: false, reason: 'snapshot 沒有 meta，無法判斷是哪一版的基準', meta: null, rebuild: false };
    const hasInputs = !!(v.sources && v.sources.length);
    const sameSchema = meta.schema === S.SCHEMA;
    if (!sameSchema && !hasInputs) return { ok: false, reason: `基準格式（${meta.schema}）已不相容，且沒有儲存輸入可以重新建立`, meta, rebuild: false };
    return { ok: true, reason: null, meta, rebuild: hasInputs && (!sameSchema || meta.version !== S.VERSION) };
  }
  /**
   * 這個工具存的每一個鍵：
   *   key       IndexedDB 的鍵（配色是 'theme'，實際在 localStorage 的 THEME_KEY）
   *   label     中文名稱；purpose 用途；loss 清除時會失去什麼（確認對話框用）
   *   kind      'data'（使用者的資料）或 'pref'（畫面偏好，「重設畫面偏好」只清這一種）
   *   critical  無法從輸入重建（清除時特別警告）
   *   check(v)  還原備份時的格式檢查：合法回傳 null，否則回傳原因
   */
  const KEYS = Object.freeze([
    { key: 'last', label: '基準與輸入', kind: 'data', where: 'indexedDB',
      purpose: '最後一次建立的基準、收集檔、命名規則、預期現況與設備圖的節點位置；重新開啟頁面時還原。',
      loss: '目前的基準、收集檔與設備圖的節點位置（可以用原本的收集檔重新建立）。',
      check: (v) => lastRestorable(v).reason },
    { key: 'ledger', label: '處理紀錄', kind: 'data', where: 'indexedDB', critical: true,
      purpose: '每個問題的處理狀態、備註、接受風險的理由與每一輪的紀錄；跨輪保留，清除基準不影響。',
      loss: '所有問題的處理狀態、備註、接受風險的理由與歷次的紀錄。',
      check: (v) => { const r = S.ledger && S.ledger.validate ? S.ledger.validate(v) : { ok: isObj(v), errors: ['應是物件'] }; return r.ok ? null : '不是有效的處理紀錄（' + r.errors.slice(0, 3).join('；') + '）'; } },
    { key: 'acks', label: '舊版的確認標記', kind: 'data', where: 'indexedDB',
      purpose: '舊版（處理紀錄之前）的確認標記；第一次載入基準時轉換成處理紀錄，轉換成功後刪除。',
      loss: '還沒轉換成處理紀錄的舊確認標記。',
      check: (v) => (isObj(v) ? null : '應是物件') },
    { key: 'profiles', label: '載入的命名規則', kind: 'data', where: 'indexedDB',
      purpose: '你載入過的命名規則檔（內建的不在這裡）；建立基準時可以選用。',
      loss: '載入過的命名規則（內建的不受影響，蓋過的內建規則恢復）；建立基準時不能再選用，需要時再載入檔案。已建立的基準不受影響。',
      check: (v) => (isObj(v) && Object.values(v).every(isObj) ? null : '應是「ID → 命名規則」的物件') },
    { key: 'layout', label: '欄寬', kind: 'pref', where: 'indexedDB',
      purpose: '左右欄調整過的寬度。',
      loss: '調整過的欄寬；清除後馬上回到預設寬度。',
      check: (v) => (isObj(v) && ['left', 'right'].every((s) => v[s] === undefined || Number.isFinite(v[s])) ? null : '應是 { left, right } 的數字') },
    { key: 'layoutMode', label: '預設版面', kind: 'pref', where: 'indexedDB',
      purpose: '拓樸圖的預設版面（分層或快速）。',
      loss: '選過的預設版面；回到預設的分層版面。',
      check: (v) => (typeof v === 'string' && v ? null : '應是版面名稱（字串）') },
    { key: 'theme', label: '配色', kind: 'pref', where: 'localStorage',
      purpose: '跟隨系統、淺色或深色。',
      loss: '選過的配色；回到跟隨系統。',
      check: (v) => (THEMES.includes(v) ? null : `應是 ${THEMES.join('／')} 之一`) },
  ].map((d) => Object.freeze(d)));
  const descOf = (k) => KEYS.find((d) => d.key === k) || null;
  const BACKUP_SCHEMA = 'ssot-localdata/1';

  /** JSON 序列化後的 UTF-8 位元組數（undefined 為 0） */
  function sizeOf(v) {
    if (v === undefined) return 0;
    const s = JSON.stringify(v); if (s === undefined) return 0;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; } else n += 3;
    }
    return n;
  }
  /** IndexedDB（或記憶體）裡實際存的資料鍵，排序；不含 META */
  async function keys() {
    const db = await open();
    const all = db ? await tx(db, 'readonly', (s) => s.getAllKeys()) : [...mem.keys()];
    return all.map(String).filter((k) => k !== META).sort();
  }

  /**
   * 列出存了什麼：{ storage: 'indexedDB'|'memory', themeStorage: 'localStorage'|'memory', items }。
   * items 依 KEYS 的順序（沒有資料的也列，present 為 false），之後是不認得的鍵（kind 'other'）。
   * 每一項 { key, label, purpose, loss, kind, where, critical, present, bytes, updatedAt }；updatedAt 沒有記錄時為 null。
   */
  async function inventory() {
    const db = await open(); const stored = await keys(); const meta = (await S.store.get(META)) || {};
    // 大小快取到這個鍵改變時（本頁寫入，或 META 的時間不同）：大型基準每次讀出並序列化要數百 ms
    const bytesOf = async (k) => {
      const at = meta[k] || null; const c = sizes.get(k);
      if (c && c.at === at) return c.bytes;
      const bytes = sizeOf(await S.store.get(k)); sizes.set(k, { at, bytes }); return bytes;
    };
    const items = [];
    for (const d of KEYS) {
      let bytes = 0; let present;
      if (d.where === 'localStorage') { const raw = themeRaw(); present = raw !== null && raw !== undefined; bytes = present ? sizeOf(raw) : 0; } else { present = stored.includes(d.key); bytes = present ? await bytesOf(d.key) : 0; }
      items.push({ key: d.key, label: d.label, purpose: d.purpose, loss: d.loss, kind: d.kind, where: d.where, critical: !!d.critical,
        present, bytes, updatedAt: (d.where !== 'localStorage' && meta[d.key]) || null });
    }
    for (const k of stored.filter((x) => !descOf(x))) {
      items.push({ key: k, label: '其他：' + k, purpose: '這個版本不使用的鍵（可能來自其他版本）。', loss: '這個鍵的內容（這個版本不使用）。', kind: 'other', where: 'indexedDB', critical: false,
        present: true, bytes: await bytesOf(k), updatedAt: meta[k] || null });
    }
    let themeStorage = 'localStorage';
    { const st = ls(); if (!st || themeMem !== null) themeStorage = 'memory'; }
    return { storage: db ? 'indexedDB' : 'memory', themeStorage, items };
  }

  /** 清除一個鍵（配色是 'theme'）。KEYS 以外存著的鍵也可以清 */
  async function clear(k) {
    if (k === 'theme') { S.store.theme.clear(); return; }
    return S.store.del(k);
  }
  /** 重設畫面偏好：只清 kind 'pref' 的鍵，回傳清了哪些；基準、處理紀錄與命名規則不動 */
  async function resetPrefs() {
    const ks = KEYS.filter((d) => d.kind === 'pref').map((d) => d.key);
    for (const k of ks) await clear(k);
    return ks;
  }

  /**
   * 備份：{ schema: 'ssot-localdata/1', version, exportedAt, items: { 鍵: 值 } }，包含 KEYS 中存著的鍵（含配色；不認得的鍵不放）。
   * now 是呼叫端傳入的時間（ISO 字串）。
   */
  async function exportAll(now) {
    const stored = await keys(); const items = {};
    for (const d of KEYS) {
      if (d.where === 'localStorage') { const raw = themeRaw(); if (THEMES.includes(raw)) items[d.key] = raw; } else if (stored.includes(d.key)) items[d.key] = await S.store.get(d.key);
    }
    return { schema: BACKUP_SCHEMA, version: S.VERSION || null, exportedAt: now || null, items };
  }
  /**
   * 檢查備份：{ ok, errors, keys }。keys 是將覆蓋的鍵（KEYS 的順序）。
   * extra 是呼叫端另外的檢查 { 鍵: (v) => null | 原因 }（例如版面名稱要是畫面認得的）。
   */
  function validateBackup(obj, extra) {
    const errors = [];
    if (!isObj(obj)) return { ok: false, errors: ['不是 JSON 物件'], keys: [] };
    if (obj.schema !== BACKUP_SCHEMA) errors.push(`schema 應是 ${BACKUP_SCHEMA}（這個檔是 ${obj.schema === undefined ? '沒有 schema' : JSON.stringify(obj.schema)}）`);
    if (!isObj(obj.items)) { errors.push('items 應是物件'); return { ok: false, errors, keys: [] }; }
    const names = Object.keys(obj.items);
    if (!names.length) errors.push('沒有任何資料可以還原');
    names.forEach((k) => {
      const d = descOf(k);
      if (!d) { errors.push(`items.${k}：不是這個工具儲存的資料`); return; }
      const why = d.check(obj.items[k]) || (extra && extra[k] ? extra[k](obj.items[k]) : null);
      if (why) errors.push(`items.${k}（${d.label}）：${why}`);
    });
    return { ok: !errors.length, errors, keys: KEYS.map((d) => d.key).filter((k) => names.includes(k)) };
  }
  /**
   * 從備份還原：先 validateBackup，不合法時回傳 { ok: false, errors }，一筆都不寫。
   * 合法時 IndexedDB 的鍵在同一筆交易寫回（中途失敗時整筆不寫入，丟出錯誤），之後寫配色。
   * 回傳 { ok: true, keys, warnings }；warnings 是配色存不進 localStorage 時的說明。備份裡沒有的鍵不動。
   */
  async function restore(obj, extra) {
    const v = validateBackup(obj, extra);
    if (!v.ok) return { ok: false, errors: v.errors, keys: [] };
    const idbKeys = v.keys.filter((k) => descOf(k).where !== 'localStorage');
    const db = await open(); const at = nowIso();
    if (db) {
      if (idbKeys.length) {
        try { await tx(db, 'readwrite', (s) => { idbKeys.forEach((k) => s.put(obj.items[k], k)); stamp(s, idbKeys, at); return null; }); } finally { changed(idbKeys); }
      }
    } else { idbKeys.forEach((k) => mem.set(k, obj.items[k])); memStamp(idbKeys, at); changed(idbKeys); }
    const warnings = [];
    if (v.keys.includes('theme') && !S.store.theme.set(obj.items.theme)) warnings.push('這個瀏覽器無法保存配色設定：這次有效，關閉頁面後不會保留。');
    return { ok: true, keys: v.keys, warnings };
  }

  Object.assign(S.store, { KEYS, BACKUP_SCHEMA, keys, sizeOf, lastRestorable, inventory, clear, resetPrefs, exportAll, validateBackup, restore });
})(globalThis.SSOT = globalThis.SSOT || {});
