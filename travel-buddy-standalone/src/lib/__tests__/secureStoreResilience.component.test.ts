/**
 * SecureStoreAdapter — behaviour when the native keychain FAILS.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST (2026-08-29)
 * ----------------------------------------------
 * The adapter handled exactly one failure mode — the native module being
 * absent (`if (!store) return webGet(key)`) — and assumed that if
 * `require('expo-secure-store')` resolved, the calls themselves succeeded.
 *
 * They do not. On the iOS Simulator the app was built ad-hoc with an EMPTY
 * entitlements blob (`codesign -d --entitlements` returns nothing,
 * `TeamIdentifier=not set`), so it has no keychain access group and every call
 * fails with errSecMissingEntitlement (-34018). The rejection went straight
 * into Supabase's GoTrue client:
 *
 *   _recoverAndRefresh    -> getItem -> Uncaught (in promise) at launch
 *   _autoRefreshTokenTick -> getItem -> the same error every ~30s, forever
 *
 * The signing problem is a build fix. This suite is about the code path, which
 * is reachable on a correctly signed production build too: keychain reads fail
 * with errSecInteractionNotAllowed (-25308) while the device is locked, and the
 * refresh timer runs while the phone is in a pocket. An adapter invoked from a
 * timer must never throw.
 *
 * Every assertion here checks resulting STATE — the health record — rather than
 * "the call returned". A call that resolves is not evidence the keychain write
 * happened; that confusion is what let this ship.
 */

import { Platform } from 'react-native';

// NOTE: exhaustive by design. expo-secure-store is a native module with no JS
// implementation to requireActual — there is nothing real to spread. The
// factory below is the complete surface secureStore.ts touches.
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  getItemAsync: (...a: unknown[]) => mockNative.getItemAsync(...a),
  setItemAsync: (...a: unknown[]) => mockNative.setItemAsync(...a),
  deleteItemAsync: (...a: unknown[]) => mockNative.deleteItemAsync(...a),
}));

/** Mutable native backing so each test picks healthy or failing behaviour. */
const mockNative = {
  store: new Map<string, string>(),
  fail: null as string | null,
  getItemAsync: jest.fn(async (key: string) => {
    if (mockNative.fail) throw new Error(mockNative.fail);
    return mockNative.store.get(key) ?? null;
  }),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    if (mockNative.fail) throw new Error(mockNative.fail);
    mockNative.store.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    if (mockNative.fail) throw new Error(mockNative.fail);
    mockNative.store.delete(key);
  }),
};

/** The real -34018 message, as expo-secure-store surfaces it. */
const ENTITLEMENT_ERROR =
  "Calling the 'getValueWithKeyAsync' function has failed\n" +
  '→ Caused by: A required entitlement isn\'t present.';

import {
  SecureStoreAdapter,
  getSecureStorePersistenceHealth,
  _resetSecureStorePersistenceHealth,
  getSecure,
  setSecure,
  deleteSecure,
} from '../secureStore.ts';

const KEY = 'sb-ajrurzioarfkagpuxfnb-auth-token';
const SESSION = '{"access_token":"redacted","refresh_token":"redacted"}';

beforeAll(() => {
  // isNative() reads Platform.OS at call time; jest-expo may run this file
  // under a non-native project, so pin it.
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
});

beforeEach(() => {
  mockNative.store.clear();
  mockNative.fail = null;
  mockNative.getItemAsync.mockClear();
  mockNative.setItemAsync.mockClear();
  mockNative.deleteItemAsync.mockClear();
  _resetSecureStorePersistenceHealth();
  // Drop the in-process fallback copy between tests.
  void SecureStoreAdapter.removeItem(KEY);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a healthy keychain is unchanged', () => {
  it('round-trips a session and reports NOT degraded', async () => {
    await SecureStoreAdapter.setItem(KEY, SESSION);
    expect(await SecureStoreAdapter.getItem(KEY)).toBe(SESSION);

    const health = getSecureStorePersistenceHealth();
    expect(health.degraded).toBe(false);
    expect(health.failures).toEqual({ getItem: 0, setItem: 0, removeItem: 0 });
    expect(health.lastError).toBeNull();
  });

  it('actually reaches the native module — the mock is wired', async () => {
    await SecureStoreAdapter.setItem(KEY, SESSION);
    expect(mockNative.setItemAsync).toHaveBeenCalled();
  });
});

describe('getItem when the keychain rejects', () => {
  it('RESOLVES instead of rejecting — this is the unhandled promise', async () => {
    mockNative.fail = ENTITLEMENT_ERROR;
    // The pre-fix behaviour was a rejection here, which LogBox reported as
    // "Uncaught (in promise, id: 0)".
    await expect(SecureStoreAdapter.getItem(KEY)).resolves.toBeNull();
  });

  it('records the failure as state, not just console noise', async () => {
    mockNative.fail = ENTITLEMENT_ERROR;
    await SecureStoreAdapter.getItem(KEY);

    const health = getSecureStorePersistenceHealth();
    expect(health.degraded).toBe(true);
    expect(health.failures.getItem).toBe(1);
    expect(health.lastError).toContain('required entitlement');
  });

  it('survives a refresh timer hammering it — 40 ticks, no rejection', async () => {
    // _autoRefreshTokenTick fires roughly every 30s for the life of the app.
    mockNative.fail = ENTITLEMENT_ERROR;
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () => SecureStoreAdapter.getItem(KEY)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(getSecureStorePersistenceHealth().failures.getItem).toBe(40);
  });

  it('does not flood the log — 40 failures produce far fewer lines', async () => {
    mockNative.fail = ENTITLEMENT_ERROR;
    for (let i = 0; i < 40; i += 1) await SecureStoreAdapter.getItem(KEY);
    // Unthrottled this would be ~2,880 identical lines a day.
    expect((console.error as jest.Mock).mock.calls.length).toBeLessThan(5);
  });
});

describe('setItem when the keychain rejects', () => {
  it('resolves, but must NOT report the write as persisted', async () => {
    mockNative.fail = ENTITLEMENT_ERROR;
    await expect(SecureStoreAdapter.setItem(KEY, SESSION)).resolves.toBeUndefined();

    // The whole point: resolving is not evidence the side effect happened.
    expect(mockNative.store.has(KEY)).toBe(false);
    const health = getSecureStorePersistenceHealth();
    expect(health.degraded).toBe(true);
    expect(health.failures.setItem).toBe(1);
  });

  it('keeps the session readable within the SAME launch', async () => {
    // Otherwise GoTrue reads back null moments after a successful sign-in and
    // behaves as though the user were signed out mid-session.
    mockNative.fail = ENTITLEMENT_ERROR;
    await SecureStoreAdapter.setItem(KEY, SESSION);
    expect(await SecureStoreAdapter.getItem(KEY)).toBe(SESSION);
  });

  it('the in-process copy is explicitly NOT persistence', async () => {
    mockNative.fail = ENTITLEMENT_ERROR;
    await SecureStoreAdapter.setItem(KEY, SESSION);
    // Nothing reached the keychain, so a relaunch has nothing to recover.
    expect(mockNative.store.size).toBe(0);
    expect(getSecureStorePersistenceHealth().degraded).toBe(true);
  });
});

describe('removeItem when the keychain rejects', () => {
  it('still clears the in-process copy — sign-out must not leave a session', async () => {
    // Security-relevant: a failed delete that also skipped the local clear
    // would leave a readable session behind after the user signed out.
    await SecureStoreAdapter.setItem(KEY, SESSION);
    mockNative.fail = ENTITLEMENT_ERROR;

    await expect(SecureStoreAdapter.removeItem(KEY)).resolves.toBeUndefined();
    expect(await SecureStoreAdapter.getItem(KEY)).toBeNull();
  });

  it('records the failed erase', async () => {
    mockNative.fail = ENTITLEMENT_ERROR;
    await SecureStoreAdapter.removeItem(KEY);
    expect(getSecureStorePersistenceHealth().failures.removeItem).toBe(1);
  });
});

describe('the E2EE key path is deliberately NOT softened', () => {
  it('getSecure still PROPAGATES a keychain failure', async () => {
    // Swallowing here would mean private key material silently absent, and the
    // caller deciding it must generate a new identity — orphaning every thread.
    mockNative.fail = ENTITLEMENT_ERROR;
    await expect(getSecure('portava:identity_private_key')).rejects.toThrow(/entitlement/);
  });

  it('setSecure still PROPAGATES', async () => {
    mockNative.fail = ENTITLEMENT_ERROR;
    await expect(setSecure('portava:identity_private_key', 'k')).rejects.toThrow(/entitlement/);
  });

  it('deleteSecure still PROPAGATES', async () => {
    mockNative.fail = ENTITLEMENT_ERROR;
    await expect(deleteSecure('portava:identity_private_key')).rejects.toThrow(/entitlement/);
  });

  it('a key-path failure does not pollute the session health record', async () => {
    mockNative.fail = ENTITLEMENT_ERROR;
    await getSecure('portava:identity_private_key').catch(() => {});
    expect(getSecureStorePersistenceHealth().degraded).toBe(false);
  });
});

describe('the launch sequence that produced the red screen', () => {
  it('_recoverAndRefresh then repeated ticks yield zero rejections', async () => {
    mockNative.fail = ENTITLEMENT_ERROR;
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);

    // What GoTrue actually does at launch, then on its timer.
    await SecureStoreAdapter.getItem(KEY);
    await SecureStoreAdapter.setItem(KEY, SESSION);
    for (let i = 0; i < 6; i += 1) await SecureStoreAdapter.getItem(KEY);
    await new Promise((r) => setImmediate(r));

    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });
});
