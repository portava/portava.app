/**
 * E-0 validation: localMessageDb round-trip tests.
 *
 * Uses in-memory mocks for expo-secure-store and @op-engineering/op-sqlite.
 * Validates DB key generation, table creation, upsert, and query helpers.
 */

const { _reset: resetSecureStore } = require('expo-secure-store') as { _reset(): void };
import { resetFixture as resetOpSqlite, fixture } from '../e2ee/__tests__/nativeSqliteFixture.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession } from '../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';
import { captureObservedOwnerSnapshot } from '../../services/observedOwnerSnapshot.ts';
import { cryptoStorageKey } from '../e2ee/nativeSessionStore.ts';
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
jest.mock('@op-engineering/op-sqlite', () => require('../e2ee/__tests__/nativeSqliteFixture.ts'));
jest.mock('expo-openmls');
jest.mock('../supabase.ts', () => {
 const listeners = new Set();
 return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; } } } };
});
const keyName = () => cryptoStorageKey(captureObservedOwnerSnapshot()!, 'database_key');
afterEach(() => { _resetLocalDb(); resetOpSqlite(); disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); });

beforeEach(() => {
  setDiscoveryViewerFromSession('owner-a'); seedObservedOwnerSession('owner-a', 'session-a');
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
    const key = await getSecure(keyName());
    expect(key).toBeTruthy();
  });

  it('returns the same db instance on second call (singleton)', async () => {
    const db1 = await openLocalDb();
    const db2 = await openLocalDb();
    expect(db1).toBe(db2);
  });

  it('uses existing DB key from SecureStore — does not generate a new one', async () => {
    await setSecure(keyName(), 'existing_key==');
    await openLocalDb();
    const key = await getSecure(keyName());
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

it('legacy cache API also refuses an installed binary without SQLCipher', async () => {
 fixture.cipher = false;
 await expect(upsertLocalMessage(makeMsg())).rejects.toThrow(/encrypted message storage/);
});
it('replaced bodies disappear from full-text results and cannot leak across accounts', async () => {
 await upsertLocalMessage(makeMsg({ body: 'uniqueoldword' }));
 await upsertLocalMessage(makeMsg({ body: 'uniquenewword' }));
 expect(await searchLocalMessages('uniqueoldword')).toEqual([]);
 expect(await searchLocalMessages('uniquenewword')).toHaveLength(1);
 setDiscoveryViewerFromSession('owner-b'); seedObservedOwnerSession('owner-b','session-b');
 expect(await getLocalMessages('thread-a')).toEqual([]);
});
