/**
 * E-0 validation: one-shot AsyncStorage → SecureStore migration tests.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { _reset as resetSecureStore } from 'expo-secure-store';
import { runE0Migration } from '../e0Migration.ts';
import { getSecure, SecureStoreAdapter, SECURE_KEYS } from '../secureStore.ts';

jest.mock('expo-secure-store');
// NOTE: Exhaustive by design — e0Migration only calls getItem/setItem/removeItem/clear.
// Spreading requireActual would import the native module and crash in Jest.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  resetSecureStore();
  jest.clearAllMocks();
  // Restore env var for tests that check URL parsing
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://ajrurzioarfkagpuxfnb.supabase.co';
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
});

describe('runE0Migration', () => {
  it('copies session from AsyncStorage to SecureStore', async () => {
    const fakeSession = JSON.stringify({ access_token: 'tok123', refresh_token: 'ref456' });
    mockAsyncStorage.getItem.mockResolvedValueOnce(fakeSession);

    await runE0Migration();

    const inSecure = await SecureStoreAdapter.getItem('sb-ajrurzioarfkagpuxfnb-auth-token');
    expect(inSecure).toBe(fakeSession);
  });

  it('removes the session from AsyncStorage after copying', async () => {
    const fakeSession = JSON.stringify({ access_token: 'tok' });
    mockAsyncStorage.getItem.mockResolvedValueOnce(fakeSession);

    await runE0Migration();

    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(
      'sb-ajrurzioarfkagpuxfnb-auth-token',
    );
  });

  it('marks migration done in SecureStore', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);
    await runE0Migration();
    expect(await getSecure(SECURE_KEYS.E0_MIGRATION_DONE)).toBe('true');
  });

  it('is idempotent — does not re-run if already done', async () => {
    // First run
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);
    await runE0Migration();

    // Second run — AsyncStorage should not be queried again
    jest.clearAllMocks();
    await runE0Migration();

    expect(mockAsyncStorage.getItem).not.toHaveBeenCalled();
  });

  it('does not throw if AsyncStorage is missing the session key', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);
    await expect(runE0Migration()).resolves.not.toThrow();
  });

  it('does not throw if AsyncStorage.getItem rejects', async () => {
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('storage error'));
    // Still marks migration done despite the error
    await expect(runE0Migration()).resolves.not.toThrow();
    expect(await getSecure(SECURE_KEYS.E0_MIGRATION_DONE)).toBe('true');
  });

  it('skips if EXPO_PUBLIC_SUPABASE_URL is missing', async () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);
    await expect(runE0Migration()).resolves.not.toThrow();
  });
});
