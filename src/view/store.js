/*
 * 瀏覽器儲存：用 IndexedDB 儲存最後一次的輸入、基準與節點位置（不再用 localStorage，也不會自動過期）。
 * 無法使用 IndexedDB 時（例如隱私模式）退回記憶體，畫面會提示。
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
})(globalThis.SSOT = globalThis.SSOT || {});
