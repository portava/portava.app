/**
 * E-0 validation: SecureStore wrapper round-trip tests.
 *
 * Uses the in-memory mock at __mocks__/expo-secure-store.ts.
 * Validates that getSecure/setSecure/deleteSecure work correctly
 * and that the SecureStoreAdapter matches the Supabase storage interface.
 */

import { _reset } from 'expo-secure-store';
import {
  getSecure,
  setSecure,
  deleteSecure,
  SecureStoreAdapter,
  SECURE_KEYS,
  isNative,
} from '../secureStore.ts';

jest.mock('expo-secure-store');

beforeEach(() => {
  _reset();
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
  it('returns true when Platform.OS is ios (jest-expo default)', () => {
    // jest-expo defaults Platform.OS to 'ios'
    expect(isNative()).toBe(true);
  });
});
