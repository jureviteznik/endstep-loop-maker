// IndexedDB storage for capture sessions, shared by the service worker and side panel.
const DB_NAME = 'endstep-loop-maker';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      const records = db.createObjectStore('records', { autoIncrement: true });
      records.createIndex('sessionId', 'sessionId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putSession(session) {
  const db = await openDb();
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').put(session);
  return done(tx);
}

export async function addRecords(sessionId, records) {
  const db = await openDb();
  const tx = db.transaction('records', 'readwrite');
  const store = tx.objectStore('records');
  for (const r of records) store.add({ ...r, sessionId });
  return done(tx);
}

export async function listSessions() {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'records'], 'readonly');
  const sessions = await result(tx.objectStore('sessions').getAll());
  const index = tx.objectStore('records').index('sessionId');
  const counts = await Promise.all(sessions.map((s) => result(index.count(s.id))));
  return sessions
    .map((s, i) => ({ ...s, count: counts[i] }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export async function getRecords(sessionId) {
  const db = await openDb();
  const tx = db.transaction('records', 'readonly');
  const records = await result(tx.objectStore('records').index('sessionId').getAll(sessionId));
  return records.sort((a, b) => a.seq - b.seq);
}

export async function deleteSession(sessionId) {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'records'], 'readwrite');
  tx.objectStore('sessions').delete(sessionId);
  const index = tx.objectStore('records').index('sessionId');
  const keys = await result(index.getAllKeys(sessionId));
  const records = tx.objectStore('records');
  for (const k of keys) records.delete(k);
  return done(tx);
}
