/**
 * E-1 validation: cryptoIdentity key generation and idempotency tests.
 */

const { _reset: resetSecureStore } = require('expo-secure-store') as { _reset(): void };
import {
  hasCryptoIdentity,
  initCryptoIdentity,
  getIdentityPublicKey,
  getDeviceEd25519PublicKey,
  getRegisteredDeviceId,
} from '../cryptoIdentity.ts';
import { getSecure, SECURE_KEYS } from '../secureStore.ts';

import { seedObservedOwnerSession, disposeObservedOwnerSession } from '../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';
import { captureObservedOwnerSnapshot } from '../../services/observedOwnerSnapshot.ts';
import { cryptoStorageKey, closeNativeMessageDatabases } from '../e2ee/nativeSessionStore.ts';
import { resetFixture } from '../e2ee/__tests__/nativeSqliteFixture.ts';
jest.mock('../supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; } } } };
});
jest.mock('@op-engineering/op-sqlite', () => {
  // NOTE: real SQLite transaction semantics with synthetic cipher capability.
  return require('../e2ee/__tests__/nativeSqliteFixture.ts');
});
beforeEach(() => { closeNativeMessageDatabases(); resetFixture(); setDiscoveryViewerFromSession('user-under-test'); seedObservedOwnerSession('user-under-test', 'session-under-test'); });
afterEach(() => { closeNativeMessageDatabases(); resetFixture(); disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); });
const scopedKey = (key: string) => cryptoStorageKey(captureObservedOwnerSnapshot()!, key);

jest.mock('expo-secure-store');
jest.mock('expo-openmls');

const mockApiPost = jest.fn().mockResolvedValue({ data: { device: { id: 'device-uuid-123' } }, error: null });
const mockApiPut  = jest.fn().mockResolvedValue({ data: { ok: true }, error: null });

beforeEach(() => {
  resetSecureStore();
  jest.clearAllMocks();
  mockApiPost.mockResolvedValue({ data: { device: { id: 'device-uuid-123' } }, error: null });
});

describe('hasCryptoIdentity()', () => {
  it('returns false when no keys are stored', async () => {
    expect(await hasCryptoIdentity()).toBe(false);
  });
});

describe('initCryptoIdentity()', () => {
  it('generates and stores identity key pair', async () => {
    await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut });
    expect(await hasCryptoIdentity()).toBe(true);
  });

  it('stores the identity public key', async () => {
    await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut });
    const pub = await getIdentityPublicKey();
    expect(pub).toBeTruthy();
  });

  it('stores device Ed25519 public key', async () => {
    await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut });
    const pub = await getDeviceEd25519PublicKey();
    expect(pub).toBeTruthy();
  });

  it('stores all six key material entries in SecureStore', async () => {
    await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut });
    const keys = await Promise.all([
      getSecure(scopedKey(SECURE_KEYS.IDENTITY_PRIVATE_KEY)),
      getSecure(scopedKey(SECURE_KEYS.IDENTITY_PUBLIC_KEY)),
      getSecure(scopedKey(SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY)),
      getSecure(scopedKey(SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY)),
      getSecure(scopedKey(SECURE_KEYS.DEVICE_X25519_PRIVATE_KEY)),
      getSecure(scopedKey(SECURE_KEYS.DEVICE_X25519_PUBLIC_KEY)),
    ]);
    expect(keys.every(Boolean)).toBe(true);
  });

  it('is idempotent — calling twice does not regenerate keys', async () => {
    await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut });
    const firstPub = await getIdentityPublicKey();

    // Reset mock call counts but keys remain in SecureStore
    jest.clearAllMocks();

    await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut });
    const secondPub = await getIdentityPublicKey();

    expect(firstPub).toBe(secondPub);
  });

  it('reports registration failure so initialization can retry on foreground', async () => {
    mockApiPost.mockResolvedValue({ data: null, error: 'network error' });
    await expect(
      initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut }),
    ).rejects.toThrow(/registration failed/);
  });
});

it('publishes a pending KeyPackage once after confirmed acceptance, and reuses it on retry', async () => {
  let fail = true;
  mockApiPost.mockImplementation(async (path: string) => path.endsWith('/key-packages') && fail
    ? { error: 'lost response' } : { data: { device: { id: 'device-uuid-123' } } });
  await expect(initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut })).rejects.toThrow(/publication failed/);
  const first = mockApiPost.mock.calls.find(([path]) => path.endsWith('/key-packages'))![1];
  fail = false;
  await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut });
  await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut });
  const publications = mockApiPost.mock.calls.filter(([path]) => path.endsWith('/key-packages'));
  expect(publications).toHaveLength(2); expect(publications[1]![1]).toEqual(first);
});
it('never attributes a legacy identity to a different signed-in account', async () => {
  const { setSecure } = require('../secureStore.ts');
  await setSecure(SECURE_KEYS.REGISTERED_DEVICE_ID, 'old-device');
  await setSecure(SECURE_KEYS.IDENTITY_PUBLIC_KEY, 'old-key');
  await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut, apiGet: async () => ({ data: { devices: [] } }) });
  expect(await getIdentityPublicKey()).not.toBe('old-key');
  expect(await getSecure(SECURE_KEYS.IDENTITY_PUBLIC_KEY)).toBe('old-key');
});

it('recovers an interrupted identity write from its original keychain bundle', async () => {
  const { setSecure, deleteSecure } = require('../secureStore.ts');
  await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut });
  const original = await getIdentityPublicKey();
  await deleteSecure(scopedKey(SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY));
  await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut });
  expect(await getIdentityPublicKey()).toBe(original);
  expect(await getSecure(scopedKey(SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY))).toBeTruthy();
});
it('preserves legacy Welcome material while publishing a new usable conversation key', async () => {
  const { setSecure } = require('../secureStore.ts');
  const required = [SECURE_KEYS.IDENTITY_PRIVATE_KEY, SECURE_KEYS.IDENTITY_PUBLIC_KEY, SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY, SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY, SECURE_KEYS.DEVICE_X25519_PRIVATE_KEY, SECURE_KEYS.DEVICE_X25519_PUBLIC_KEY];
  for (const key of required) await setSecure(key, `legacy-${key}`);
  await setSecure(SECURE_KEYS.REGISTERED_DEVICE_ID, 'legacy-device');
  await setSecure(SECURE_KEYS.MLS_PENDING_KEY_PACKAGE, 'private-pending-welcome');
  await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut, apiGet: async () => ({ data: { devices: [{ id: 'legacy-device', public_key: `legacy-${SECURE_KEYS.IDENTITY_PUBLIC_KEY}` }] } }) });
  expect(await getIdentityPublicKey()).toBe(`legacy-${SECURE_KEYS.IDENTITY_PUBLIC_KEY}`);
  expect(await getSecure(scopedKey('legacy_pending_keypackage'))).toBe('private-pending-welcome');
  expect(await getSecure(scopedKey(SECURE_KEYS.MLS_PENDING_KEY_PACKAGE))).toBeTruthy();
  expect(mockApiPost.mock.calls.some(([path]) => path.endsWith('/key-packages'))).toBe(true);
});

it('recovers a crash after Welcome commit before Keychain cleanup and replenishes with a different package', async () => {
  await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut });
  const owner = captureObservedOwnerSnapshot()!;
  const oldPending = await getSecure(scopedKey(SECURE_KEYS.MLS_PENDING_KEY_PACKAGE));
  expect(oldPending).toBeTruthy();
  const { commitNativeSession, pendingWasConsumed } = require('../e2ee/nativeSessionStore.ts');
  await commitNativeSession(owner, 'joined-thread', 'committed-group', undefined, oldPending);
  const native = require('expo-openmls') as typeof import('../../../vendor/expo-openmls/src/index.ts');
  const generate = jest.spyOn(native, 'generateKeyPackage').mockResolvedValueOnce({ keyPackageB64: 'new-public-package', pendingStateB64: 'new-private-package' });
  await initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut });
  expect(await getSecure(scopedKey(SECURE_KEYS.MLS_PENDING_KEY_PACKAGE))).toBe('new-private-package');
  expect(await pendingWasConsumed(owner, oldPending)).toBe(true);
  generate.mockRestore();
});
