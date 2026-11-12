import AsyncStorage from '@react-native-async-storage/async-storage';
import { encryptedOutboxStorage } from '../storage.ts';
import * as secure from '../../../../lib/secureStore.ts';
import type { OutboxEntry } from '../types.ts';
const mockSecrets = new Map<string, string>();
// NOTE: intentionally isolated boundary; the real auth, native storage, routing or API module would start side effects outside this controlled fixture.
jest.mock('../../../../lib/secureStore.ts', () => ({
  isNative: () => true,
  getSecure: jest.fn(async (key: string) => mockSecrets.get(key) ?? null),
  setSecure: jest.fn(async (key: string, value: string) => { mockSecrets.set(key, value); }),
  deleteSecure: jest.fn(async (key: string) => { mockSecrets.delete(key); }),
}));
const entry: OutboxEntry = { ownerId: 'alice', sessionId: 's1', threadId: 'thread', clientId: 'client', createdAt: '2026-11-05T00:00:00Z', display: { body: 'private-body'.repeat(500), isE2ee: true, msgType: 'text', subtype: null, replyToId: 'reply' }, payload: { ciphertext: 'opaque-ciphertext', clientId: 'client', idempotencyKey: 'client', replyToId: 'reply' }, attempts: 0, nextAttemptAt: 0, state: 'queued' };
beforeEach(async () => { await AsyncStorage.clear(); mockSecrets.clear(); jest.clearAllMocks(); });
it('stores bodies only in secure chunks and restores a multi-chunk pending message', async () => {
  await encryptedOutboxStorage.put(entry);
  expect(jest.mocked(secure.setSecure).mock.calls.length).toBeGreaterThan(1);
  const rawIndex = await AsyncStorage.getItem('telegraph.outbox.v1.alice');
  expect(rawIndex).not.toContain('private-body'); expect(rawIndex).not.toContain('opaque-ciphertext');
  expect(await encryptedOutboxStorage.read(entry)).toEqual([entry]);
  expect(await encryptedOutboxStorage.read({ ownerId: 'alice', sessionId: 's2' })).toEqual([]);
  expect(await encryptedOutboxStorage.read({ ownerId: 'bob', sessionId: 's1' })).toEqual([]);
});
it('keeps the last committed version when writing a new secure version fails', async () => {
  await encryptedOutboxStorage.put(entry);
  jest.mocked(secure.setSecure).mockRejectedValueOnce(new Error('locked'));
  await expect(encryptedOutboxStorage.put({ ...entry, attempts: 1 })).rejects.toThrow('locked');
  expect(await encryptedOutboxStorage.read(entry)).toEqual([entry]);
});
it('refuses a silent secure-store no-op rather than claiming persistence', async () => {
  jest.mocked(secure.setSecure).mockResolvedValueOnce(undefined);
  await expect(encryptedOutboxStorage.put(entry)).rejects.toThrow('Secure storage is unavailable');
  expect(await encryptedOutboxStorage.read(entry)).toEqual([]);
});
it('erases this owner from secure storage and the index, preserving another account', async () => {
  await encryptedOutboxStorage.put(entry);
  await encryptedOutboxStorage.put({ ...entry, ownerId: 'bob' });
  await encryptedOutboxStorage.clearOwner('alice');
  expect(await encryptedOutboxStorage.read(entry)).toEqual([]);
  expect(await encryptedOutboxStorage.read({ ownerId: 'bob', sessionId: 's1' })).toHaveLength(1);
  expect(await AsyncStorage.getItem('telegraph.outbox.v1.alice')).toBeNull();
});
it('will not use a tampered pending-message index to delete unrelated secure keys', async () => {
  await AsyncStorage.setItem('telegraph.outbox.v1.alice', JSON.stringify([{ clientId: 'c', sessionId: 's1', key: 'private.identity.key', count: 1 }]));
  await expect(encryptedOutboxStorage.clearOwner('alice')).rejects.toThrow('index is damaged');
  expect(secure.deleteSecure).not.toHaveBeenCalled();
});

it('a cancelled native draft cannot be recreated by a late acknowledgement or retry', async () => {
  await encryptedOutboxStorage.put(entry);
  await encryptedOutboxStorage.remove(entry, entry.clientId);
  await expect(encryptedOutboxStorage.put({ ...entry, state: 'retryable' }, true)).rejects.toThrow(/removed/);
  expect(await encryptedOutboxStorage.read(entry)).toEqual([]);
});
it('a failed secure erase leaves no replayable draft and retains a cleanup journal', async () => {
  await encryptedOutboxStorage.put(entry);
  jest.mocked(secure.deleteSecure).mockRejectedValueOnce(new Error('locked'));
  await expect(encryptedOutboxStorage.remove(entry, entry.clientId)).rejects.toThrow('locked');
  expect(await encryptedOutboxStorage.read(entry)).toEqual([]);
  expect(await AsyncStorage.getItem('telegraph.outbox.v1.alice')).toContain('staging');
  await encryptedOutboxStorage.clearOwner(entry.ownerId);
  expect(await AsyncStorage.getItem('telegraph.outbox.v1.alice')).toBeNull();
});
