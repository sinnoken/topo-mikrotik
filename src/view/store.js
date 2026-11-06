/*
 * 瀏覽器儲存：用 IndexedDB 儲存最後一次的輸入、基準與節點位置（不會自動過期）。
 * 無法使用 IndexedDB 時（例如隱私模式）退回記憶體，畫面會提示。
 * 唯一的例外是配色偏好（S.store.theme）：首次繪製前要同步讀到，所以放 localStorage（理由見下方）。
 */
(function (S) {
  'use strict';
  const DB = 'topo-mikrotik'; const STORE = 'kv';
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
  S.store = {
    async available() { return !!(await open()); },
    async get(k) { const db = await open(); return db ? tx(db, 'readonly', (s) => s.get(k)) : mem.get(k); },
    async set(k, v) { const db = await open(); if (!db) { mem.set(k, v); return; } return tx(db, 'readwrite', (s) => s.put(v, k)); },
    async del(k) { const db = await open(); if (!db) { mem.delete(k); return; } return tx(db, 'readwrite', (s) => s.delete(k)); },
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
  S.store.theme = Object.freeze({
    KEY: THEME_KEY, VALUES: THEMES,
    /** 目前的偏好；沒有存過時 'system'。存的值不合法時忽略（不改寫）、退回 'system'，並 console.warn（同一個值只警告一次） */
    get() {
      let v = themeMem;
      if (v === null) { const st = ls(); try { v = st ? st.getItem(THEME_KEY) : null; } catch (e) { v = null; } }
      if (v === null || v === undefined) return 'system';
      if (THEMES.includes(v)) return v;
      if (!themeWarned.has(v)) { themeWarned.add(v); console.warn(`配色偏好 ${JSON.stringify(v)} 不是 ${THEMES.join('／')} 之一，已忽略，改用跟隨系統。`); }
      return 'system';
    },
    /** 存偏好；不合法的值丟 RangeError。存不進 localStorage 時記在記憶體（這次有效）並回傳 false */
    set(v) {
      if (!THEMES.includes(v)) throw new RangeError('未知的配色偏好：' + v);
      const st = ls();
      try { if (!st) throw new Error('localStorage 無法使用'); st.setItem(THEME_KEY, v); themeMem = null; return true; } catch (e) { themeMem = v; return false; }
    },
  });
})(globalThis.SSOT = globalThis.SSOT || {});
