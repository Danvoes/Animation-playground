/*
 * storage.js
 * Saving and loading.
 *
 * - Browser storage (IndexedDB): the app keeps your current project here
 *   automatically, so closing the tab doesn't lose your work.
 *     store "meta": the project description (layers, frames, settings)
 *     store "cels": one PNG picture per drawing, keyed "layerId|frameId"
 * - Project files (.anim): one file with everything inside, for backups and
 *   moving between devices. It's a JSON text file with the pictures stored
 *   as PNG "data URLs".
 */
(function () {
  'use strict';

  const DB_NAME = 'animation-playground';
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('cels')) db.createObjectStore('cels');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Storage is blocked by another tab'));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  // Wrap an IndexedDB request in a promise.
  const done = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const finished = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Save was cancelled'));
  });

  async function get(store, key) {
    const db = await openDB();
    return done(db.transaction(store, 'readonly').objectStore(store).get(key));
  }

  /**
   * Save the project description plus any changed pictures, and remove
   * pictures that are no longer used.
   *   meta: object, puts: [[key, Blob]], keep: Set of every picture key still in use
   */
  async function saveProject(meta, puts, keep) {
    const db = await openDB();
    const tx = db.transaction(['meta', 'cels'], 'readwrite');
    const cels = tx.objectStore('cels');
    tx.objectStore('meta').put(meta, 'current');
    for (const [key, blob] of puts) cels.put(blob, key);
    const keys = await done(cels.getAllKeys());
    for (const key of keys) if (!keep.has(key)) cels.delete(key);
    await finished(tx);
  }

  async function clearProject() {
    const db = await openDB();
    const tx = db.transaction(['meta', 'cels'], 'readwrite');
    tx.objectStore('meta').clear();
    tx.objectStore('cels').clear();
    await finished(tx);
  }

  // ---- Picture helpers ----
  const canvasToBlob = (canvas) => new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode picture'))), 'image/png');
  });
  const blobToDataURL = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  // Turn a Blob or a data URL into something that can be drawn on a canvas.
  async function toImage(src) {
    if (src instanceof Blob && window.createImageBitmap) {
      try { return await createImageBitmap(src); } catch (_) { /* fall back below */ }
    }
    const url = src instanceof Blob ? URL.createObjectURL(src) : src;
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      if (src instanceof Blob) URL.revokeObjectURL(url);
    }
  }

  // ---- Files ----
  // Offer a file to the user: a "Save as" window where the browser supports it,
  // otherwise a normal download. Returns the file handle (or null), or
  // throws an error named AbortError if they cancelled.
  async function writeFile(blob, suggestedName, handle) {
    if (window.showSaveFilePicker) {
      if (!handle) {
        handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'Animation project', accept: { 'application/json': ['.anim'] } }],
        });
      }
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return handle;
    }
    download(blob, suggestedName);
    return null;
  }
  // A plain download (goes to the Downloads folder).
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 20000);
  }

  window.ProjectStorage = {
    get, saveProject, clearProject, openDB,
    canvasToBlob, blobToDataURL, toImage, writeFile, download,
  };
})();
