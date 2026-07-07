// Persistent local catalog index (IndexedDB). Stores one record — the full
// list of catalog books plus metadata — so the manager can search the whole
// catalog instantly and offline instead of hitting the API per keystroke.
// IndexedDB (not chrome.storage) because the catalog can be ~10MB (49k books).
//
// Global object, same pattern as the other lib modules; loaded via <script>.
const CatalogStore = {
  _DB: 'oreilly-epub-catalog',
  _STORE: 'catalog',
  _KEY: 'index',

  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this._DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this._STORE)) db.createObjectStore(this._STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  // record: { books, total, query, topic, updatedAt }
  async save(record) {
    const db = await this._open();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this._STORE, 'readwrite');
        tx.objectStore(this._STORE).put(record, this._KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },

  async load() {
    const db = await this._open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(this._STORE, 'readonly');
        const req = tx.objectStore(this._STORE).get(this._KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  },

  async clear() {
    const db = await this._open();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this._STORE, 'readwrite');
        tx.objectStore(this._STORE).delete(this._KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
};
