import { fixture, resetFixture } from './nativeSqliteFixture.ts';
const { _reset: resetSecureStore } = require('expo-secure-store') as { _reset(): void };
import { commitNativeSession, readNativeBody, readNativeSession, closeNativeMessageDatabases, cryptoStorageKey, writeCryptoSecret } from '../nativeSessionStore.ts';
import { encryptForThread, decryptFromThread } from '../../mlsSession.ts';
import type { MessagingOwnerRequest } from '../../../services/observedOwnerSnapshot.ts';
const native = require('expo-openmls') as typeof import('../../../../vendor/expo-openmls/src/index.ts');
jest.mock('expo-secure-store');
jest.mock('expo-openmls');
jest.mock('@op-engineering/op-sqlite', () => {
  // NOTE: real SQLite semantics, synthetic cipher capability only; native encryption is a separate acceptance gate.
  return require('./nativeSqliteFixture.ts');
});
let current = true;
const owner: MessagingOwnerRequest = { ownerId: 'owner-a', sessionId: 'session-a', isCurrent: () => current, invalidate: () => { current = false; } };
beforeEach(() => { current = true; closeNativeMessageDatabases(); resetFixture(); resetSecureStore(); jest.clearAllMocks(); });
afterEach(() => { closeNativeMessageDatabases(); resetFixture(); });
it('rejects a native build without SQLCipher before creating history tables', async () => {
  fixture.cipher = false;
  await expect(commitNativeSession(owner, 'thread', 'state')).rejects.toThrow(/encrypted message storage/);
});
it('separates accounts and refuses an expired session handle', async () => {
  await commitNativeSession(owner, 'thread', 'a-state', { ciphertext: 'cipher', body: 'a-private' });
  const other = { ...owner, ownerId: 'owner-b', sessionId: 'session-b', isCurrent: () => true };
  expect(await readNativeSession(other, 'thread')).toBeNull(); expect(await readNativeBody(other, 'thread', 'cipher')).toBeNull();
  expect(fixture.opened[0]!.name).not.toBe(fixture.opened[1]!.name);
  current = false; await expect(readNativeBody(owner, 'thread', 'cipher')).rejects.toThrow(/session changed/);
});
it('rolls plaintext and the MLS ratchet back together on write failure', async () => {
  await commitNativeSession(owner, 'thread', 'before');
  fixture.failSql = 'INSERT OR REPLACE INTO mls_sessions';
  await expect(commitNativeSession(owner, 'thread', 'after', { ciphertext: 'cipher', body: 'private' })).rejects.toThrow();
  fixture.failSql = '';
  expect(await readNativeSession(owner, 'thread')).toBe('before'); expect(await readNativeBody(owner, 'thread', 'cipher')).toBeNull();
});
it('cache persists across a JS database close and exact ciphertext is required', async () => {
  await commitNativeSession(owner, 'thread', 'state', { ciphertext: 'cipher', body: 'private' });
  closeNativeMessageDatabases();
  expect(await readNativeBody(owner, 'thread', 'cipher')).toBe('private'); expect(await readNativeBody(owner, 'thread', 'different')).toBeNull();
});
it('does not let two decrypts consume the same message twice', async () => {
  await commitNativeSession(owner, 'thread', 'before');
  const decrypt = jest.spyOn(native, 'decryptMessage').mockResolvedValue({ plaintext: 'private', updatedGroupStateB64: 'after' });
  const values = await Promise.all([decryptFromThread('thread', 'cipher', undefined, owner), decryptFromThread('thread', 'cipher', undefined, owner)]);
  expect(values).toEqual(['private', 'private']); expect(decrypt).toHaveBeenCalledTimes(1);
  expect(await readNativeSession(owner, 'thread')).toBe('after'); decrypt.mockRestore();
});
it('outgoing bodies are cached atomically so own history never invokes native self-decryption', async () => {
  await commitNativeSession(owner, 'thread', 'before');
  const encrypt = jest.spyOn(native, 'encryptMessage').mockResolvedValue({ ciphertextB64: 'outgoing', updatedGroupStateB64: 'after' });
  const decrypt = jest.spyOn(native, 'decryptMessage');
  expect(await encryptForThread('thread', 'my message', undefined, owner)).toEqual({ ciphertextB64: 'outgoing' });
  expect(await decryptFromThread('thread', 'outgoing', undefined, owner)).toBe('my message'); expect(decrypt).not.toHaveBeenCalled();
  encrypt.mockRestore(); decrypt.mockRestore();
});
it('drops a late native decrypt after session replacement without saving its state or body', async () => {
  await commitNativeSession(owner, 'thread', 'before');
  let release!: (value: { plaintext: string; updatedGroupStateB64: string }) => void;
  const decrypt = jest.spyOn(native, 'decryptMessage').mockImplementation(() => new Promise((r) => { release = r; }));
  const work = decryptFromThread('thread', 'cipher', undefined, owner);
  for (let i = 0; i < 40 && !release; i++) await Promise.resolve();
  current = false; release({ plaintext: 'private', updatedGroupStateB64: 'after' });
  await expect(work).rejects.toThrow(/session changed/);
  current = true; expect(await readNativeSession(owner, 'thread')).toBe('before'); expect(await readNativeBody(owner, 'thread', 'cipher')).toBeNull(); decrypt.mockRestore();
});

it('adopts a legacy session only when its native local credential matches this account', async () => {
  const { setSecure, SECURE_KEYS } = require('../../secureStore.ts');
  await setSecure(`${SECURE_KEYS.MLS_GROUP_STATE_PREFIX}legacy`, 'legacy-state');
  const identify = jest.spyOn(native, 'sessionOwnerId').mockResolvedValue('owner-b');
  expect(await readNativeSession(owner, 'legacy')).toBeNull();
  identify.mockResolvedValue('owner-a');
  expect(await readNativeSession(owner, 'legacy')).toBe('legacy-state');
  identify.mockRestore();
});
it('deleting a migrated session does not resurrect its retained legacy copy', async () => {
  const { setSecure, SECURE_KEYS } = require('../../secureStore.ts');
  const { destroyNativeSession } = require('../nativeSessionStore.ts');
  await setSecure(`${SECURE_KEYS.MLS_GROUP_STATE_PREFIX}legacy`, 'legacy-state');
  const identify = jest.spyOn(native, 'sessionOwnerId').mockResolvedValue('owner-a');
  expect(await readNativeSession(owner, 'legacy')).toBe('legacy-state');
  await destroyNativeSession(owner, 'legacy');
  expect(await readNativeSession(owner, 'legacy')).toBeNull(); identify.mockRestore();
});

it('a canonical tombstone without ciphertext erases the mapped decrypted body', async () => {
  const { reconcileNativeMessage } = require('../nativeSessionStore.ts');
  await reconcileNativeMessage(owner, 'thread', 'canonical-id', 'cipher', false);
  await commitNativeSession(owner, 'thread', 'state', { ciphertext: 'cipher', body: 'removed message' });
  await reconcileNativeMessage(owner, 'thread', 'canonical-id', null, true);
  expect(await readNativeBody(owner, 'thread', 'cipher')).toBeNull();
  expect(await readNativeSession(owner, 'thread')).toBe('state');
});

it('Welcome consumption and the recipient ratchet commit together and keep a one-use fingerprint', async () => {
  const { pendingWasConsumed } = require('../nativeSessionStore.ts');
  fixture.failSql = 'INSERT OR REPLACE INTO mls_sessions';
  await expect(commitNativeSession(owner, 'joined', 'after', undefined, 'private-pending')).rejects.toThrow();
  fixture.failSql = ''; expect(await pendingWasConsumed(owner, 'private-pending')).toBe(false);
  await commitNativeSession(owner, 'joined', 'after', undefined, 'private-pending');
  closeNativeMessageDatabases(); expect(await pendingWasConsumed(owner, 'private-pending')).toBe(true);
  expect(await pendingWasConsumed(owner, 'other-private-pending')).toBe(false);
});
it('invalid legacy key names do not block a new native install, while storage failures still propagate', async () => {
  const store = require('../../secureStore.ts');
  const read = jest.spyOn(store, 'getSecure').mockRejectedValueOnce(new Error('Invalid key provided to SecureStore. Keys must not be empty'));
  const { readLegacyCryptoSecret } = require('../nativeSessionStore.ts');
  expect(await readLegacyCryptoSecret('old:invalid')).toBeNull();
  read.mockRejectedValueOnce(new Error('Keychain locked'));
  await expect(readLegacyCryptoSecret('old:invalid')).rejects.toThrow('locked'); read.mockRestore();
});
