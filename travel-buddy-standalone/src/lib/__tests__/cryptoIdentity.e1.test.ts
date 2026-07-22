/**
 * E-1 validation: cryptoIdentity key generation and idempotency tests.
 */

import { _reset as resetSecureStore } from 'expo-secure-store';
import {
  hasCryptoIdentity,
  initCryptoIdentity,
  getIdentityPublicKey,
  getDeviceEd25519PublicKey,
  getRegisteredDeviceId,
} from '../cryptoIdentity.ts';
import { getSecure, SECURE_KEYS } from '../secureStore.ts';

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
      getSecure(SECURE_KEYS.IDENTITY_PRIVATE_KEY),
      getSecure(SECURE_KEYS.IDENTITY_PUBLIC_KEY),
      getSecure(SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY),
      getSecure(SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY),
      getSecure(SECURE_KEYS.DEVICE_X25519_PRIVATE_KEY),
      getSecure(SECURE_KEYS.DEVICE_X25519_PUBLIC_KEY),
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

  it('does not throw if apiPost fails (graceful degradation)', async () => {
    mockApiPost.mockResolvedValue({ data: null, error: 'network error' });
    await expect(
      initCryptoIdentity({ apiPost: mockApiPost, apiPut: mockApiPut }),
    ).resolves.not.toThrow();
  });
});
