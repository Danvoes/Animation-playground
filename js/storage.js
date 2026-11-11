/*
 * storage.js
 * Saving and loading.
 *
 * - Browser storage (IndexedDB) keeps all your projects (the gallery), saved
 *   automatically so closing the tab doesn't lose your work.
 *     store "projects":  one summary per project for the gallery (name, dates, thumbnail)
 *     store "meta":      each project's description (layers, frames, settings), keyed by project id
 *     store "cels":      pictures and sounds, keyed "projectId|what" (e.g. "P123|l1|f1")
 *     store "tl2":       time-lapse snapshots, keyed [projectId, number]
 *     store "app":       small app-wide notes (which project was open last)
 * - Project files (.anim): one file with everything inside, for backups and
 *   moving between devices. It's a JSON text file with the pictures stored
 *   as PNG "data URLs".
 */
(function () {
  'use strict';

  const DB_NAME = 'animation-playground';
  const DB_VERSION = 3; // 2 added time-lapse, 3 added the project gallery
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['meta', 'cels', 'projects', 'app', 'tl2']) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
        if (!db.objectStoreNames.contains('timelapse')) db.createObjectStore('timelapse', { autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Storage is blocked by another tab'));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  // Wrap an IndexedDB request / transaction in a promise.
  const done = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const finished = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Save was cancelled'));
  });
  // Every key that belongs to one project.
  const prefixRange = (pid) => IDBKeyRange.bound(`${pid}|`, `${pid}|￿`);
  const tlRange = (pid) => IDBKeyRange.bound([pid, 0], [pid, Number.MAX_SAFE_INTEGER]);

  async function get(store, key) {
    const db = await openDB();
    return done(db.transaction(store, 'readonly').objectStore(store).get(key));
  }
  const getMeta = (pid) => get('meta', pid);
  const getRecord = (pid, key) => get('cels', `${pid}|${key}`);
  const getApp = (key) => get('app', key);
  async function setApp(key, value) {
    const db = await openDB();
    const tx = db.transaction('app', 'readwrite');
    tx.objectStore('app').put(value, key);
    await finished(tx);
  }

  /** All project summaries, most recently edited first. */
  async function listProjects() {
    const db = await openDB();
    const all = await done(db.transaction('projects', 'readonly').objectStore('projects').getAll());
    return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /**
   * Save a project: its description, any changed pictures/sounds, and its gallery
   * summary. Pictures no longer used by the project are removed.
   *   puts: [[key, value]], keep: Set of every key still in use (without the project prefix)
   */
  async function saveProject(pid, meta, puts, keep, summary) {
    const db = await openDB();
    const tx = db.transaction(['meta', 'cels', 'projects'], 'readwrite');
    const cels = tx.objectStore('cels');
    tx.objectStore('meta').put(meta, pid);
    for (const [key, value] of puts) cels.put(value, `${pid}|${key}`);
    const keys = await done(cels.getAllKeys(prefixRange(pid)));
    const cut = pid.length + 1;
    for (const key of keys) if (!keep.has(key.slice(cut))) cels.delete(key);
    if (summary) {
      const projects = tx.objectStore('projects');
      const old = await done(projects.get(pid));
      projects.put(Object.assign({}, old || {}, summary, { id: pid }), pid);
    }
    await finished(tx);
  }

  /** Change part of a project's gallery summary (without touching anything else). */
  async function updateSummary(pid, patch) {
    const db = await openDB();
    const tx = db.transaction('projects', 'readwrite');
    const st = tx.objectStore('projects');
    const old = await done(st.get(pid));
    if (old) st.put(Object.assign(old, patch), pid);
    await finished(tx);
  }

  async function renameProject(pid, name) {
    const db = await openDB();
    const tx = db.transaction(['meta', 'projects'], 'readwrite');
    const meta = await done(tx.objectStore('meta').get(pid));
    if (meta) { meta.name = name; tx.objectStore('meta').put(meta, pid); }
    const sum = await done(tx.objectStore('projects').get(pid));
    if (sum) { sum.name = name; tx.objectStore('projects').put(sum, pid); }
    await finished(tx);
  }

  async function deleteProject(pid) {
    const db = await openDB();
    const tx = db.transaction(['meta', 'cels', 'projects', 'tl2'], 'readwrite');
    tx.objectStore('meta').delete(pid);
    tx.objectStore('cels').delete(prefixRange(pid));
    tx.objectStore('tl2').delete(tlRange(pid));
    tx.objectStore('projects').delete(pid);
    await finished(tx);
  }

  /** Copy a whole project (pictures, sounds, time-lapse and all) under a new id. */
  async function duplicateProject(pid, newPid, name) {
    const db = await openDB();
    const tx = db.transaction(['meta', 'cels', 'projects', 'tl2'], 'readwrite');
    const meta = await done(tx.objectStore('meta').get(pid));
    if (!meta) throw new Error('Project not found');
    meta.name = name;
    tx.objectStore('meta').put(meta, newPid);
    const cels = tx.objectStore('cels');
    const keys = await done(cels.getAllKeys(prefixRange(pid)));
    const vals = await done(cels.getAll(prefixRange(pid)));
    keys.forEach((k, i) => cels.put(vals[i], newPid + k.slice(pid.length)));
    const tl = tx.objectStore('tl2');
    const tkeys = await done(tl.getAllKeys(tlRange(pid)));
    const tvals = await done(tl.getAll(tlRange(pid)));
    tkeys.forEach((k, i) => tl.put(tvals[i], [newPid, k[1]]));
    const projects = tx.objectStore('projects');
    const sum = await done(projects.get(pid));
    const now = Date.now();
    projects.put(Object.assign({}, sum || {}, { id: newPid, name, createdAt: now, updatedAt: now }), newPid);
    await finished(tx);
  }

  /**
   * Older versions kept one project under "current". Move it into the gallery.
   * Returns its new project id, or null if there was nothing to move.
   */
  async function migrateLegacy(newPid) {
    const db = await openDB();
    const tx = db.transaction(['meta', 'cels', 'projects', 'timelapse', 'tl2'], 'readwrite');
    const metaStore = tx.objectStore('meta');
    const meta = await done(metaStore.get('current'));
    if (!meta) { await finished(tx); return null; }
    const cels = tx.objectStore('cels');
    const keys = await done(cels.getAllKeys());
    const vals = await done(cels.getAll());
    keys.forEach((k, i) => {
      if (/^P\d+\|/.test(String(k))) return; // already belongs to a gallery project
      cels.put(vals[i], `${newPid}|${k}`);
      cels.delete(k);
    });
    metaStore.put(meta, newPid);
    metaStore.delete('current');
    const shots = await done(tx.objectStore('timelapse').getAll());
    const tl = tx.objectStore('tl2');
    shots.forEach((blob, i) => tl.put(blob, [newPid, i + 1]));
    tx.objectStore('timelapse').clear();
    const now = Date.now();
    tx.objectStore('projects').put({
      id: newPid, name: meta.name || 'Untitled', createdAt: now,
      updatedAt: Date.parse(meta.savedAt) || now, frames: (meta.frames || []).length,
    }, newPid);
    await finished(tx);
    return newPid;
  }

  // ---- Time-lapse: one small JPEG picture per change, in order, per project ----
  let tlSeq = 0;
  async function tlAdd(pid, blob) {
    const db = await openDB();
    const tx = db.transaction('tl2', 'readwrite');
    tx.objectStore('tl2').put(blob, [pid, Date.now() * 100 + (tlSeq++ % 100)]);
    await finished(tx);
  }
  async function tlKeys(pid) {
    const db = await openDB();
    return done(db.transaction('tl2', 'readonly').objectStore('tl2').getAllKeys(tlRange(pid)));
  }
  const tlGet = (key) => get('tl2', key);
  async function tlDelete(keys) {
    const db = await openDB();
    const tx = db.transaction('tl2', 'readwrite');
    const st = tx.objectStore('tl2');
    for (const k of keys) st.delete(k);
    await finished(tx);
  }
  async function tlClear(pid) {
    const db = await openDB();
    const tx = db.transaction('tl2', 'readwrite');
    tx.objectStore('tl2').delete(tlRange(pid));
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
          types: [{ description: 'Playground project', accept: { 'application/json': ['.anim'] } }],
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
    openDB, getMeta, getRecord, getApp, setApp,
    listProjects, saveProject, updateSummary, renameProject, deleteProject, duplicateProject, migrateLegacy,
    tlAdd, tlKeys, tlGet, tlDelete, tlClear,
    canvasToBlob, blobToDataURL, toImage, writeFile, download,
  };
})();
