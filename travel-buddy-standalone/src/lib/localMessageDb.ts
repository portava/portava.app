/**
 * Account-scoped encrypted local message cache compatibility API.
 *
 * Uses @op-engineering/op-sqlite with SQLCipher encryption at rest.
 * Shares the nativeSessionStore capability gate and native CSPRNG database key.
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

import { isNative } from './secureStore.ts';

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

// Legacy cache API retained for callers, using the same account-bound,
// capability-checked SQLCipher database as the live MLS receive path.
import { cryptoOwner, openBoundNativeMessageDatabase, type NativeMessageDatabase } from './e2ee/nativeSessionStore.ts';
import type { MessagingOwnerRequest } from '../services/observedOwnerSnapshot.ts';
let bound: { owner: MessagingOwnerRequest; db: NativeMessageDatabase } | null = null;
export async function openLocalDb(): Promise<NativeMessageDatabase | null> {
  if (!isNative()) return null;
  const owner = cryptoOwner();
  if (bound?.owner.isCurrent()) return bound.db;
  const db = await openBoundNativeMessageDatabase(owner);
  db.executeSync(`CREATE TABLE IF NOT EXISTS cached_messages (
    id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,sender_id TEXT NOT NULL,body TEXT,msg_type TEXT NOT NULL DEFAULT 'text',
    subtype TEXT,created_at TEXT NOT NULL,decrypted_at TEXT,is_e2ee INTEGER NOT NULL DEFAULT 0
  )`);
  db.executeSync('CREATE INDEX IF NOT EXISTS idx_lm_thread_time ON cached_messages(thread_id,created_at DESC)');
  db.executeSync('CREATE VIRTUAL TABLE IF NOT EXISTS cached_messages_fts USING fts5(id UNINDEXED,thread_id UNINDEXED,body)');
  bound = { owner, db }; return db;
}
export function _resetLocalDb(): void { bound?.db.close(); bound = null; }

/** Insert or replace a message in the local cache. */
export async function upsertLocalMessage(msg: LocalMessage): Promise<void> {
  const db = await openLocalDb();
  if (!db) return;
  db.executeSync('BEGIN IMMEDIATE');
  try {
  db.executeSync(
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

  db.executeSync('DELETE FROM cached_messages_fts WHERE id = ?', [msg.id]);
  // Keep FTS index in sync for non-null bodies
  if (msg.body) {
    db.executeSync(
      `INSERT INTO cached_messages_fts (id, thread_id, body)
       SELECT id, thread_id, body FROM cached_messages WHERE id = ?`,
      [msg.id],
    );
  }
  db.executeSync('COMMIT');
  } catch (error) { try { db.executeSync('ROLLBACK'); } catch {} throw error; }
}

/** Return cached messages for a thread, newest first. */
export async function getLocalMessages(
  threadId: string,
  limit = 50,
): Promise<LocalMessage[]> {
  const db = await openLocalDb();
  if (!db) return [];
  const result = db.executeSync(
    `SELECT id, thread_id, sender_id, body, msg_type, subtype, created_at, decrypted_at, is_e2ee
       FROM cached_messages
      WHERE thread_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    [threadId, Math.min(200, Math.max(1, Math.trunc(limit)))],
  );
  return result.rows as unknown as LocalMessage[];
}

/** Full-text search over decrypted message bodies. Returns matching messages. */
export async function searchLocalMessages(
  query: string,
  limit = 20,
): Promise<LocalMessage[]> {
  const db = await openLocalDb();
  if (!db) return [];
  // FTS5 snippet search: safe to pass user input because we use parameterised query
  const result = db.executeSync(
    `SELECT cm.id, cm.thread_id, cm.sender_id, cm.body, cm.msg_type, cm.subtype,
            cm.created_at, cm.decrypted_at, cm.is_e2ee
       FROM cached_messages_fts fts
       JOIN cached_messages cm ON cm.id = fts.id
      WHERE cached_messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
    [`"${query.replaceAll('"', '""')}"`, Math.min(200, Math.max(1, Math.trunc(limit)))],
  );
  return result.rows as unknown as LocalMessage[];
}

/** Delete all cached messages for a thread (e.g. on thread leave). */
export async function clearLocalThread(threadId: string): Promise<void> {
  const db = await openLocalDb();
  if (!db) return;
  db.executeSync('BEGIN IMMEDIATE');
  try {
    db.executeSync(`DELETE FROM cached_messages WHERE thread_id = ?`, [threadId]);
    db.executeSync(`DELETE FROM cached_messages_fts WHERE thread_id = ?`, [threadId]);
    db.executeSync('COMMIT');
  } catch (error) { try { db.executeSync('ROLLBACK'); } catch {} throw error; }
}
