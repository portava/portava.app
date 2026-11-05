/** Native MLS state and decrypted bodies commit together in an account-scoped
 * SQLCipher database. No plaintext fallback, random fallback, or legacy-owner guessing. */
import { getSecure, setSecure, isNative, SECURE_KEYS } from '../secureStore.ts';
import { captureObservedOwnerSnapshot, type MessagingOwnerRequest } from '../../services/observedOwnerSnapshot.ts';
import { sha256Hex } from '../sensing/commitment.ts';
import { onDiscoveryScopeChange } from '../../services/discoveryViewerScope.ts';

type SqlValue = string | number | null;
export interface NativeMessageDatabase {
  executeSync(sql: string, params?: SqlValue[]): { rows: Array<Record<string, unknown>> };
  close(): void;
}
interface NativeIdentity { generateIdentityKeyPair(): Promise<{ privKeyB64: string; pubKeyB64: string }> }
const databases = new Map<string, { owner: MessagingOwnerRequest; db: NativeMessageDatabase }>();
const opening = new Map<string, Promise<NativeMessageDatabase>>();
const queues = new Map<string, Promise<unknown>>();
export function cryptoOwner(request?: MessagingOwnerRequest): MessagingOwnerRequest {
  const owner = request ?? captureObservedOwnerSnapshot();
  if (!owner?.isCurrent() || !/^[A-Za-z0-9_-]{1,80}$/.test(owner.ownerId)) throw new Error('The encrypted-message session changed.');
  return owner;
}
export function cryptoStorageKey(owner: MessagingOwnerRequest, key: string): string {
  cryptoOwner(owner);
  return `telegraph.crypto.v2.${owner.ownerId}.${key.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}
/** Older wrappers used colon-separated keys. Current Expo rejects that name
 * before touching native storage; treat only that precise legacy-name refusal
 * as absent. Locked/unavailable Keychain errors must still stop migration. */
export async function readLegacyCryptoSecret(key: string): Promise<string | null> {
  try { return await getSecure(key); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid key provided to SecureStore.')) return null;
    throw error;
  }
}
export async function readCryptoSecret(owner: MessagingOwnerRequest, key: string): Promise<string | null> {
  const result = await getSecure(cryptoStorageKey(owner, key)); cryptoOwner(owner); return result;
}
export async function writeCryptoSecret(owner: MessagingOwnerRequest, key: string, value: string): Promise<void> {
  const name = cryptoStorageKey(owner, key);
  await setSecure(name, value); cryptoOwner(owner);
  if (await getSecure(name) !== value) throw new Error('Secure encrypted-message storage is unavailable.');
  cryptoOwner(owner);
}
export function closeNativeMessageDatabases(): void {
  for (const { db } of databases.values()) { try { db.close(); } catch {} }
  databases.clear();
}
onDiscoveryScopeChange(closeNativeMessageDatabases);
async function database(owner: MessagingOwnerRequest): Promise<NativeMessageDatabase> {
  cryptoOwner(owner);
  if (!isNative()) throw new Error('Encrypted message history requires a native build.');
  const cached = databases.get(owner.ownerId);
  if (cached?.owner.isCurrent()) return cached.db;
  if (cached) { try { cached.db.close(); } catch {} databases.delete(owner.ownerId); }
  const pending = opening.get(owner.ownerId);
  if (pending) { await pending.catch(() => {}); cryptoOwner(owner); return database(owner); }
  const work = (async () => {
    let key = await readCryptoSecret(owner, 'database_key');
    if (!key) {
      // Fresh native CSPRNG output; this pair is used only as a database secret,
      // never as a signing identity or sent to the server.
      const native = require('expo-openmls') as NativeIdentity;
      const generated = await native.generateIdentityKeyPair(); cryptoOwner(owner);
      key = generated.privKeyB64;
      if (typeof key !== 'string' || key.length < 32) throw new Error('Secure database key generation failed.');
      await writeCryptoSecret(owner, 'database_key', key);
    }
    const sqlite = require('@op-engineering/op-sqlite') as { open(options: { name: string; encryptionKey: string }): NativeMessageDatabase };
    cryptoOwner(owner);
    const db = sqlite.open({ name: `telegraph_v2_${owner.ownerId}.db`, encryptionKey: key });
    try {
      const cipher = db.executeSync('PRAGMA cipher_version').rows[0];
      if (!cipher || !Object.values(cipher).some((value) => typeof value === 'string' && value.length > 0)) throw new Error('This build does not include encrypted message storage.');
      db.executeSync('PRAGMA secure_delete = ON');
      db.executeSync('PRAGMA max_page_count = 131072');
      db.executeSync('CREATE TABLE IF NOT EXISTS consumed_pending (state TEXT PRIMARY KEY)');
      db.executeSync('CREATE TABLE IF NOT EXISTS legacy_sessions (thread_id TEXT PRIMARY KEY)');
      db.executeSync('CREATE TABLE IF NOT EXISTS mls_sessions (thread_id TEXT PRIMARY KEY, state TEXT NOT NULL)');
      db.executeSync('CREATE TABLE IF NOT EXISTS message_ciphertexts (thread_id TEXT NOT NULL, message_id TEXT NOT NULL, ciphertext TEXT NOT NULL, PRIMARY KEY (thread_id, message_id))');
      db.executeSync('CREATE TABLE IF NOT EXISTS decrypted_bodies (thread_id TEXT NOT NULL, ciphertext TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (thread_id, ciphertext))');
      cryptoOwner(owner);
      databases.set(owner.ownerId, { owner, db });
      return db;
    } catch (error) { db.close(); throw error; }
  })();
  opening.set(owner.ownerId, work);
  try { return await work; } finally { if (opening.get(owner.ownerId) === work) opening.delete(owner.ownerId); }
}
export async function serializedCrypto<T>(owner: MessagingOwnerRequest, threadId: string, operation: () => Promise<T>): Promise<T> {
  cryptoOwner(owner);
  const key = JSON.stringify([owner.ownerId, threadId]);
  const work = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => { cryptoOwner(owner); return operation(); });
  queues.set(key, work);
  try { return await work; } finally { if (queues.get(key) === work) queues.delete(key); }
}
export async function readNativeSession(owner: MessagingOwnerRequest, threadId: string): Promise<string | null> {
  const db = await database(owner); cryptoOwner(owner);
  const state = db.executeSync('SELECT state FROM mls_sessions WHERE thread_id = ?', [threadId]).rows[0]?.state;
  if (typeof state === 'string') return state;
  if (db.executeSync('SELECT thread_id FROM legacy_sessions WHERE thread_id = ?', [threadId]).rows.length) return null;
  const legacy = await readLegacyCryptoSecret(`${SECURE_KEYS.MLS_GROUP_STATE_PREFIX}${threadId}`); cryptoOwner(owner);
  if (!legacy) return null;
  const native = require('expo-openmls') as { sessionOwnerId(state: string): Promise<string> };
  const legacyOwner = await native.sessionOwnerId(legacy); cryptoOwner(owner);
  // The credential comes from the persisted local MLS member, not a guessed
  // last-login identifier. A different account's legacy state stays untouched.
  if (legacyOwner !== owner.ownerId) return null;
  const current = db.executeSync('SELECT state FROM mls_sessions WHERE thread_id = ?', [threadId]).rows[0]?.state;
  if (typeof current === 'string') return current;
  if (db.executeSync('SELECT thread_id FROM legacy_sessions WHERE thread_id = ?', [threadId]).rows.length) return null;
  db.executeSync('INSERT INTO mls_sessions (thread_id, state) VALUES (?, ?)', [threadId, legacy]);
  return legacy;
}
export async function readNativeBody(owner: MessagingOwnerRequest, threadId: string, ciphertext: string): Promise<string | null> {
  const db = await database(owner); cryptoOwner(owner);
  const body = db.executeSync('SELECT body FROM decrypted_bodies WHERE thread_id = ? AND ciphertext = ?', [threadId, ciphertext]).rows[0]?.body;
  return typeof body === 'string' ? body : null;
}
export async function commitNativeSession(owner: MessagingOwnerRequest, threadId: string, state: string, message?: { ciphertext: string; body: string }, consumedPending?: string): Promise<void> {
  const db = await database(owner); cryptoOwner(owner);
  db.executeSync('BEGIN IMMEDIATE');
  try {
    if (consumedPending) db.executeSync('INSERT OR IGNORE INTO consumed_pending (state) VALUES (?)', [sha256Hex(consumedPending)]);
    if (message) db.executeSync('INSERT OR REPLACE INTO decrypted_bodies (thread_id, ciphertext, body) VALUES (?, ?, ?)', [threadId, message.ciphertext, message.body]);
    db.executeSync('INSERT OR REPLACE INTO mls_sessions (thread_id, state) VALUES (?, ?)', [threadId, state]);
    db.executeSync('COMMIT');
  } catch (error) { try { db.executeSync('ROLLBACK'); } catch {} throw error; }
}
export async function pendingWasConsumed(owner: MessagingOwnerRequest, state: string): Promise<boolean> {
  const db = await database(owner); cryptoOwner(owner);
  return db.executeSync('SELECT state FROM consumed_pending WHERE state = ?', [sha256Hex(state)]).rows.length > 0;
}
/** Bind only IDs from an authorized canonical history page. Tombstones often
 * omit ciphertext, so this mapping lets them erase the correct local body. */
export async function reconcileNativeMessage(owner: MessagingOwnerRequest, threadId: string, messageId: string, ciphertext: string | null, deleted: boolean): Promise<void> {
  const db = await database(owner); cryptoOwner(owner);
  db.executeSync('BEGIN IMMEDIATE');
  try {
    if (deleted) {
      const stored = db.executeSync('SELECT ciphertext FROM message_ciphertexts WHERE thread_id = ? AND message_id = ?', [threadId, messageId]).rows[0]?.ciphertext;
      for (const value of [stored, ciphertext]) if (typeof value === 'string') db.executeSync('DELETE FROM decrypted_bodies WHERE thread_id = ? AND ciphertext = ?', [threadId, value]);
      db.executeSync('DELETE FROM message_ciphertexts WHERE thread_id = ? AND message_id = ?', [threadId, messageId]);
    } else if (ciphertext) {
      db.executeSync('INSERT OR REPLACE INTO message_ciphertexts (thread_id, message_id, ciphertext) VALUES (?, ?, ?)', [threadId, messageId, ciphertext]);
    }
    db.executeSync('COMMIT');
  } catch (error) { try { db.executeSync('ROLLBACK'); } catch {} throw error; }
}
export async function destroyNativeSession(owner: MessagingOwnerRequest, threadId: string): Promise<void> {
  const db = await database(owner); cryptoOwner(owner);
  db.executeSync('BEGIN IMMEDIATE');
  try {
    db.executeSync('DELETE FROM message_ciphertexts WHERE thread_id = ?', [threadId]);
    db.executeSync('DELETE FROM decrypted_bodies WHERE thread_id = ?', [threadId]);
    db.executeSync('DELETE FROM mls_sessions WHERE thread_id = ?', [threadId]);
    db.executeSync('INSERT OR IGNORE INTO legacy_sessions (thread_id) VALUES (?)', [threadId]);
    db.executeSync('COMMIT');
  } catch (error) { try { db.executeSync('ROLLBACK'); } catch {} throw error; }
}

/** Compatibility callers receive a session-fenced handle to the same verified
 * SQLCipher store. A raw process-global plaintext fallback is never exposed. */
export async function openBoundNativeMessageDatabase(owner: MessagingOwnerRequest): Promise<NativeMessageDatabase> {
  const db = await database(owner); cryptoOwner(owner);
  return {
    executeSync: (sql, params) => { cryptoOwner(owner); return db.executeSync(sql, params); },
    close: closeNativeMessageDatabases,
  };
}
