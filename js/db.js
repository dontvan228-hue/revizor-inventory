// Локальная база на телефоне (IndexedDB). Всё хранится на устройстве, работает без интернета.
const DB = (() => {
  const NAME = 'revizor', VERSION = 1;
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('items')) {
          const s = db.createObjectStore('items', { keyPath: 'id' });
          s.createIndex('barcode', 'barcode');
          s.createIndex('sku', 'sku');
        }
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      let out;
      Promise.resolve(fn(t.objectStore(store))).then(v => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return {
    uid,
    all: store => tx(store, 'readonly', s => req(s.getAll())),
    get: (store, id) => tx(store, 'readonly', s => req(s.get(id))),
    put: (store, obj) => tx(store, 'readwrite', s => req(s.put(obj))),
    putMany: (store, arr) => tx(store, 'readwrite', s => Promise.all(arr.map(o => req(s.put(o))))),
    del: (store, id) => tx(store, 'readwrite', s => req(s.delete(id))),
    clear: store => tx(store, 'readwrite', s => req(s.clear())),
    kvGet: async (k, d) => { const v = await tx('kv', 'readonly', s => req(s.get(k))); return v === undefined ? d : v; },
    kvSet: (k, v) => tx('kv', 'readwrite', s => req(s.put(v, k))),
    async persist() { try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; } },
    async usage() { try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { return null; } }
  };
})();
