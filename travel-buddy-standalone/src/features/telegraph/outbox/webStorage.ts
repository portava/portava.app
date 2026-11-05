import type { OutboxScope, OutboxStorage } from './types.ts';
import { validate } from './validate.ts';
// WebCrypto keys remain nonextractable. IndexedDB contains ciphertext and routing
// identifiers only. No plaintext fallback on an insecure/unsupported browser.
interface WebRecord { id: string; ownerId: string; sessionId: string; iv: Uint8Array; ciphertext: ArrayBuffer }
interface KeyRecord { key: CryptoKey | null; version: string }
const webId = (scope: OutboxScope, clientId: string) => JSON.stringify([scope.ownerId, scope.sessionId, clientId]);
let webDbPromise: Promise<IDBDatabase> | null = null;
function webDb(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) return Promise.reject(new Error('Encrypted pending-message storage is unavailable in this browser.'));
  if (!webDbPromise) webDbPromise = new Promise((resolve, reject) => {
    let refused = false;
    const request = indexedDB.open('portava-telegraph-outbox-v1', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('keys');
      request.result.createObjectStore('messages', { keyPath: 'id' }).createIndex('ownerId', 'ownerId');
    };
    request.onsuccess = () => {
      if (refused) { request.result.close(); return; }
      request.result.onversionchange = () => { request.result.close(); webDbPromise = null; };
      request.result.onclose = () => { webDbPromise = null; };
      resolve(request.result);
    };
    request.onerror = () => { webDbPromise = null; reject(request.error); };
    request.onblocked = () => { refused = true; webDbPromise = null; reject(new Error('Close older Portava tabs and try again.')); };
  });
  return webDbPromise;
}
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('Pending-message transaction interrupted.')); });
}
async function webKey(db: IDBDatabase, ownerId: string, create: boolean): Promise<KeyRecord & { key: CryptoKey }> {
  const existing = await requestResult<KeyRecord | CryptoKey | undefined>(db.transaction('keys').objectStore('keys').get(ownerId));
  if (existing && 'key' in existing && existing.key) return { ...existing, key: existing.key };
  if (!create && !existing) throw new Error('The pending-message encryption key is unavailable.');
  if (!create && existing && 'key' in existing && !existing.key) throw new Error('The pending-message session was cleared.');
  const candidate = existing && 'type' in existing ? existing : await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const tx = db.transaction('keys', 'readwrite'), done = committed(tx), store = tx.objectStore('keys');
  try {
    const current = await requestResult<KeyRecord | CryptoKey | undefined>(store.get(ownerId));
    if (current && 'key' in current && current.key) { await done; return { ...current, key: current.key }; }
    // A clear in another tab must invalidate work that started with the prior key.
    if (current && 'key' in current && current.version !== (existing && 'key' in existing ? existing.version : undefined)) throw new Error('The pending-message session was cleared.');
    const record = { key: current && 'type' in current ? current : candidate, version: crypto.randomUUID() };
    store.put(record, ownerId); await done; return record;
  } catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
}
export const webStorage: OutboxStorage = {
  read: async (scope) => {
    const db = await webDb();
    const rows = await requestResult<WebRecord[]>(db.transaction('messages').objectStore('messages').index('ownerId').getAll(scope.ownerId));
    const relevant = rows.filter((r) => r.sessionId === scope.sessionId);
    if (!relevant.length) return [];
    if (rows.length > 200) throw new Error('Pending-message storage exceeds capacity.');
    const record = await webKey(db, scope.ownerId, false);
    return Promise.all(relevant.map(async (row) => {
      if (row.ciphertext.byteLength > 301000 || row.iv.byteLength !== 12) throw new Error('Pending-message storage is damaged.');
      const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(row.iv), additionalData: new TextEncoder().encode(row.id) }, record.key, row.ciphertext);
      const entry = validate(JSON.parse(new TextDecoder().decode(bytes)), scope);
      if (row.id !== webId(scope, entry.clientId)) throw new Error('Pending message identity changed.');
      return entry;
    }));
  },
  put: async (entry, onlyIfPresent) => {
    validate(entry, entry);
    const raw = new TextEncoder().encode(JSON.stringify(entry));
    if (raw.byteLength > 300000) throw new Error('Pending-message storage is full.');
    const db = await webDb(), record = await webKey(db, entry.ownerId, true), id = webId(entry, entry.clientId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) }, record.key, raw);
    const tx = db.transaction(['messages','keys'], 'readwrite'), done = committed(tx), store = tx.objectStore('messages');
    try {
      const current = await requestResult<KeyRecord | undefined>(tx.objectStore('keys').get(entry.ownerId));
      if (!current?.key || current.version !== record.version) throw new Error('The pending-message session was cleared.');
      const previous = await requestResult<WebRecord | undefined>(store.get(id));
      if (onlyIfPresent && !previous) throw new Error('Pending message was removed.');
      if (!previous && await requestResult<number>(store.index('ownerId').count(entry.ownerId)) >= 200) throw new Error('Pending-message storage is full.');
      store.put({ id, ownerId: entry.ownerId, sessionId: entry.sessionId, iv, ciphertext } satisfies WebRecord);
      await done;
    } catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
  },
  remove: async (scope, clientId) => {
    const db = await webDb(), tx = db.transaction('messages', 'readwrite'), done = committed(tx);
    tx.objectStore('messages').delete(webId(scope, clientId)); await done;
  },
  clearOwner: async (ownerId) => {
    const db = await webDb(), tx = db.transaction(['messages', 'keys'], 'readwrite'), done = committed(tx), store = tx.objectStore('messages');
    const keys = await requestResult<IDBValidKey[]>(store.index('ownerId').getAllKeys(ownerId));
    keys.forEach((key) => store.delete(key));
    // Retain a public generation marker, with no key/content, to fence a stale
    // encryption operation still running in a different tab.
    tx.objectStore('keys').put({ key: null, version: crypto.randomUUID() } satisfies KeyRecord, ownerId);
    await done;
  },
};
