/**
 * E-0 validation: SecureStore wrapper round-trip tests.
 *
 * Validates that getSecure/setSecure/deleteSecure work correctly and that the
 * SecureStoreAdapter matches the Supabase storage interface.
 *
 * WHY THIS FILE WAS REPAIRED (2026-08-29)
 * ---------------------------------------
 * This suite had never executed. It was listed in KNOWN_BROKEN in
 * scripts/run-node-tests.mjs (so the node:test runner skipped it) and was named
 * `secureStore.e0.test.ts`, which does not match the only jest entry point,
 * `pnpm test:component` -> jest --testPathPattern='\.component\.test\.'. It ran
 * in NEITHER runner while being reported complete in
 * docs/security/e2ee-completion-report.md.
 *
 * It also imported `_reset` from a mock at `__mocks__/expo-secure-store.ts`
 * that does not exist anywhere in the repo, so it could not have passed even if
 * a runner had picked it up.
 *
 * Two changes fixed that: the `.component.test.` rename, and the self-contained
 * mock below replacing the phantom `__mocks__` file. The assertions are the
 * original ones, plus a real isNative() check (see its describe block).
 */

import { Platform } from 'react-native';

// NOTE: exhaustive by design. expo-secure-store is a native module with no JS
// implementation to requireActual — there is nothing real to spread. This
// factory is the complete surface secureStore.ts touches. It replaces the
// `__mocks__/expo-secure-store.ts` file that docs claimed existed but never did.
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  getItemAsync: async (key: string) => mockKeychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    mockKeychain.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    mockKeychain.delete(key);
  },
}));

/** In-memory stand-in for the iOS Keychain / Android Keystore. */
const mockKeychain = new Map<string, string>();

import {
  getSecure,
  setSecure,
  deleteSecure,
  SecureStoreAdapter,
  SECURE_KEYS,
  isNative,
} from '../secureStore.ts';

beforeAll(() => {
  // isNative() reads Platform.OS at call time. jest-expo happens to default it
  // to 'ios', but pinning it makes the wrapper tests deterministic rather than
  // dependent on which jest-expo project picks the file up.
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
});

beforeEach(() => {
  mockKeychain.clear();
});

describe('SecureStore wrapper', () => {
  it('returns null for a key that has not been set', async () => {
    expect(await getSecure('nonexistent')).toBeNull();
  });

  it('round-trips a string value', async () => {
    await setSecure('test_key', 'hello');
    expect(await getSecure('test_key')).toBe('hello');
  });

  it('overwrites an existing value', async () => {
    await setSecure('test_key', 'first');
    await setSecure('test_key', 'second');
    expect(await getSecure('test_key')).toBe('second');
  });

  it('deleteSecure removes the value', async () => {
    await setSecure('test_key', 'to_delete');
    await deleteSecure('test_key');
    expect(await getSecure('test_key')).toBeNull();
  });

  it('stores values independently under different keys', async () => {
    await setSecure(SECURE_KEYS.LOCAL_DB_KEY, 'db-key-value');
    await setSecure(SECURE_KEYS.IDENTITY_PRIVATE_KEY, 'identity-key-value');
    expect(await getSecure(SECURE_KEYS.LOCAL_DB_KEY)).toBe('db-key-value');
    expect(await getSecure(SECURE_KEYS.IDENTITY_PRIVATE_KEY)).toBe('identity-key-value');
  });

  it('actually reaches the keychain — the mock is wired, not silently bypassed', async () => {
    // Without this, every assertion above would still pass against a wrapper
    // that quietly no-ops (which is exactly what it does when isNative() is
    // false), and the suite would prove nothing. That failure mode is why this
    // file was worth repairing rather than deleting.
    await setSecure(SECURE_KEYS.LOCAL_DB_KEY, 'written-through');
    expect(mockKeychain.get(SECURE_KEYS.LOCAL_DB_KEY)).toBe('written-through');
  });
});

describe('SecureStoreAdapter (Supabase storage interface)', () => {
  it('getItem returns null for unknown key', async () => {
    expect(await SecureStoreAdapter.getItem('unknown')).toBeNull();
  });

  it('setItem then getItem round-trips', async () => {
    await SecureStoreAdapter.setItem('sb-proj-auth-token', '{"access_token":"abc"}');
    expect(await SecureStoreAdapter.getItem('sb-proj-auth-token')).toBe('{"access_token":"abc"}');
  });

  it('removeItem clears the value', async () => {
    await SecureStoreAdapter.setItem('key', 'value');
    await SecureStoreAdapter.removeItem('key');
    expect(await SecureStoreAdapter.getItem('key')).toBeNull();
  });
});

describe('isNative()', () => {
  // The original single assertion set Platform.OS to 'ios' and then checked for
  // 'ios', which cannot fail. Checking every branch is what actually pins the
  // predicate — a wrong one silently turns the whole module into a no-op.
  it.each([
    ['ios', true],
    ['android', true],
    ['web', false],
    ['windows', false],
  ])('Platform.OS=%s -> %s', (os, expected) => {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    expect(isNative()).toBe(expected);
  });

  afterAll(() => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  });
});
