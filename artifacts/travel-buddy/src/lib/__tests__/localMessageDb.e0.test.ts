/**
 * E-0 validation: localMessageDb round-trip tests.
 *
 * Uses in-memory mocks for expo-secure-store and @op-engineering/op-sqlite.
 * Validates DB key generation, table creation, upsert, and query helpers.
 */

import { _reset as resetSecureStore } from 'expo-secure-store';
import { _reset as resetOpSqlite } from '@op-engineering/op-sqlite';
import {
  openLocalDb,
  upsertLocalMessage,
  getLocalMessages,
  searchLocalMessages,
  clearLocalThread,
  _resetLocalDb,
} from '../localMessageDb.ts';
import type { LocalMessage } from '../localMessageDb.ts';
import { SECURE_KEYS, getSecure, setSecure } from '../secureStore.ts';

jest.mock('expo-secure-store');
jest.mock('@op-engineering/op-sqlite');

beforeEach(() => {
  resetSecureStore();
  resetOpSqlite();
  _resetLocalDb();
});

const makeMsg = (overrides: Partial<LocalMessage> = {}): LocalMessage => ({
  id: 'msg-1',
  thread_id: 'thread-a',
  sender_id: 'user-1',
  body: 'Hello world',
  msg_type: 'text',
  subtype: null,
  created_at: '2026-07-22T10:00:00Z',
  decrypted_at: null,
  is_e2ee: 0,
  ...overrides,
});

describe('openLocalDb', () => {
  it('opens the database and returns a db object', async () => {
    const db = await openLocalDb();
    expect(db).not.toBeNull();
  });

  it('generates and persists a DB key in SecureStore on first open', async () => {
    await openLocalDb();
    const key = await getSecure(SECURE_KEYS.LOCAL_DB_KEY);
    expect(key).toBeTruthy();
  });

  it('returns the same db instance on second call (singleton)', async () => {
    const db1 = await openLocalDb();
    const db2 = await openLocalDb();
    expect(db1).toBe(db2);
  });

  it('uses existing DB key from SecureStore — does not generate a new one', async () => {
    await setSecure(SECURE_KEYS.LOCAL_DB_KEY, 'existing_key==');
    await openLocalDb();
    const key = await getSecure(SECURE_KEYS.LOCAL_DB_KEY);
    expect(key).toBe('existing_key==');
  });
});

describe('upsertLocalMessage + getLocalMessages', () => {
  it('inserts a message and retrieves it', async () => {
    await upsertLocalMessage(makeMsg());
    const messages = await getLocalMessages('thread-a');
    expect(messages.length).toBeGreaterThan(0);
  });

  it('returns empty array for unknown thread', async () => {
    const messages = await getLocalMessages('thread-unknown');
    expect(messages).toEqual([]);
  });

  it('upsert is idempotent — same id does not duplicate', async () => {
    await upsertLocalMessage(makeMsg({ id: 'msg-dupe' }));
    await upsertLocalMessage(makeMsg({ id: 'msg-dupe', body: 'Updated' }));
    const messages = await getLocalMessages('thread-a');
    const dupes = messages.filter(m => m.id === 'msg-dupe');
    expect(dupes.length).toBe(1);
  });
});

describe('clearLocalThread', () => {
  it('removes all messages for the thread', async () => {
    await upsertLocalMessage(makeMsg({ id: 'msg-2' }));
    await clearLocalThread('thread-a');
    const messages = await getLocalMessages('thread-a');
    expect(messages).toEqual([]);
  });
});

describe('searchLocalMessages', () => {
  it('returns results without throwing', async () => {
    await upsertLocalMessage(makeMsg({ body: 'Travel to Tokyo' }));
    const results = await searchLocalMessages('Tokyo');
    expect(Array.isArray(results)).toBe(true);
  });
});
