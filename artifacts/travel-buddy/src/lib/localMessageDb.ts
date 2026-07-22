/**
 * Local encrypted message database — Phase E-0 foundation.
 *
 * Uses @op-engineering/op-sqlite with SQLCipher encryption at rest.
 * The 32-byte root key is generated once and stored in SecureStore.
 *
 * In E-0: schema mirrors the server message snapshot (plaintext body).
 * In E-2: body is always null for E2EE messages; decrypted content stored here.
 *         FTS5 virtual table added for on-device search.
 *
 * ONLY call from native (iOS/Android) contexts. All functions return early
 * on web where op-sqlite and SecureStore are unavailable.
 *
 * NEVER log the DB key, message bodies, or decrypted content.
 */

import { getSecure, setSecure, SECURE_KEYS, isNative } from './secureStore.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalMessage {
  id: string;
  thread_id: string;
  sender_id: string;
  /** Plaintext body. Null for E2EE messages prior to decryption. */
  body: string | null;
  msg_type: string;
  subtype: string | null;
  created_at: string;
  /** ISO timestamp set when an E2EE message was successfully decrypted. */
  decrypted_at: string | null;
  /** 1 = this message is encrypted end-to-end; 0 = plaintext. */
  is_e2ee: number;
}

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

// op-sqlite v17+ returns rows as a direct array. v11 used rows._array.
// Support both to handle version drift gracefully.
type OpSqliteRows = unknown[] | { _array: unknown[] };
type OpSqliteDb = {
  execute(sql: string, args?: unknown[]): { rows: OpSqliteRows };
  executeAsync(sql: string, args?: unknown[]): Promise<{ rows: OpSqliteRows }>;
  close(): void;
};

function extractRows<T>(result: { rows: OpSqliteRows }): T[] {
  if (Array.isArray(result.rows)) return result.rows as T[];
  return ((result.rows as { _array: T[] })._array ?? []) as T[];
}

let _db: OpSqliteDb | null = null;

/**
 * Generate (or recover) the 32-byte SQLCipher root key from SecureStore.
 * Key is stored base64-encoded.
 */
async function getOrCreateDbKey(): Promise<string> {
  const existing = await getSecure(SECURE_KEYS.LOCAL_DB_KEY);
  if (existing) return existing;

  // Generate a new random key using the Web Crypto API (available on React Native).
  const bytes = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Fallback: should not occur on a real device; present for completeness.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  // btoa from a Uint8Array — convert via String.fromCharCode
  const base64Key = btoa(String.fromCharCode(...bytes));
  await setSecure(SECURE_KEYS.LOCAL_DB_KEY, base64Key);
  return base64Key;
}

/**
 * Open (or return the cached) SQLCipher database.
 * Returns null on web or in Jest without the native module.
 */
export async function openLocalDb(): Promise<OpSqliteDb | null> {
  if (!isNative()) return null;
  if (_db) return _db;

  const key = await getOrCreateDbKey();

  let open: ((opts: { name: string; encryptionKey: string }) => OpSqliteDb) | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@op-engineering/op-sqlite') as { open: typeof open };
    open = mod.open;
  } catch {
    return null; // native module not loaded (e.g. Expo Go, web preview)
  }

  _db = open!({ name: 'portava_local.db', encryptionKey: key });

  // ── Core message cache table ──────────────────────────────────────────────
  _db.execute(`
    CREATE TABLE IF NOT EXISTS cached_messages (
      id          TEXT PRIMARY KEY,
      thread_id   TEXT    NOT NULL,
      sender_id   TEXT    NOT NULL,
      body        TEXT,
      msg_type    TEXT    NOT NULL DEFAULT 'text',
      subtype     TEXT,
      created_at  TEXT    NOT NULL,
      decrypted_at TEXT,
      is_e2ee     INTEGER NOT NULL DEFAULT 0
    )
  `);

  _db.execute(`
    CREATE INDEX IF NOT EXISTS idx_lm_thread_time
      ON cached_messages (thread_id, created_at DESC)
  `);

  // ── E-2: FTS5 virtual table for on-device full-text search ─────────────
  // Created here so the schema exists from E-0 onward; it stays empty until
  // E-2 starts populating decrypted bodies.
  _db.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS cached_messages_fts
      USING fts5(
        id        UNINDEXED,
        thread_id UNINDEXED,
        body,
        content  = 'cached_messages',
        content_rowid = 'rowid'
      )
  `);

  return _db;
}

/**
 * For tests and clean shutdown: close and reset the DB handle.
 * Should not be called in production unless the app is explicitly wiping state.
 */
export function _resetLocalDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Insert or replace a message in the local cache. */
export async function upsertLocalMessage(msg: LocalMessage): Promise<void> {
  const db = await openLocalDb();
  if (!db) return;
  db.execute(
    `INSERT OR REPLACE INTO cached_messages
       (id, thread_id, sender_id, body, msg_type, subtype, created_at, decrypted_at, is_e2ee)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      msg.id, msg.thread_id, msg.sender_id,
      msg.body, msg.msg_type, msg.subtype ?? null,
      msg.created_at, msg.decrypted_at ?? null,
      msg.is_e2ee,
    ],
  );

  // Keep FTS index in sync for non-null bodies
  if (msg.body) {
    db.execute(
      `INSERT OR REPLACE INTO cached_messages_fts (rowid, id, thread_id, body)
       SELECT rowid, id, thread_id, body FROM cached_messages WHERE id = ?`,
      [msg.id],
    );
  }
}

/** Return cached messages for a thread, newest first. */
export async function getLocalMessages(
  threadId: string,
  limit = 50,
): Promise<LocalMessage[]> {
  const db = await openLocalDb();
  if (!db) return [];
  const result = db.execute(
    `SELECT id, thread_id, sender_id, body, msg_type, subtype, created_at, decrypted_at, is_e2ee
       FROM cached_messages
      WHERE thread_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    [threadId, limit],
  );
  return extractRows<LocalMessage>(result);
}

/** Full-text search over decrypted message bodies. Returns matching messages. */
export async function searchLocalMessages(
  query: string,
  limit = 20,
): Promise<LocalMessage[]> {
  const db = await openLocalDb();
  if (!db) return [];
  // FTS5 snippet search: safe to pass user input because we use parameterised query
  const result = db.execute(
    `SELECT cm.id, cm.thread_id, cm.sender_id, cm.body, cm.msg_type, cm.subtype,
            cm.created_at, cm.decrypted_at, cm.is_e2ee
       FROM cached_messages_fts fts
       JOIN cached_messages cm ON cm.id = fts.id
      WHERE cached_messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
    [query, limit],
  );
  return extractRows<LocalMessage>(result);
}

/** Delete all cached messages for a thread (e.g. on thread leave). */
export async function clearLocalThread(threadId: string): Promise<void> {
  const db = await openLocalDb();
  if (!db) return;
  db.execute(`DELETE FROM cached_messages WHERE thread_id = ?`, [threadId]);
  db.execute(`DELETE FROM cached_messages_fts WHERE thread_id = ?`, [threadId]);
}
