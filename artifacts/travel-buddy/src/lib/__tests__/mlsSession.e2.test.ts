/**
 * E-2 validation: mlsSession encrypt/decrypt round-trip.
 *
 * Uses in-memory mocks for expo-secure-store and expo-openmls.
 */

import { _reset as resetSecureStore } from 'expo-secure-store';
import { _resetMls } from 'expo-openmls';
import {
  hasGroupSession,
  initGroupAsInitiator,
  initGroupAsRecipient,
  encryptForThread,
  decryptFromThread,
  destroyGroupSession,
  deriveSafetyNumberForThread,
} from '../mlsSession.ts';
import { setSecure, SECURE_KEYS } from '../secureStore.ts';

jest.mock('expo-secure-store');
jest.mock('expo-openmls');

// Fake keys that look like real base64
const FAKE_IDENT_PRIV = Buffer.from('fake-identity-priv-key-32bytes!!').toString('base64');
const FAKE_IDENT_PUB  = Buffer.from('fake-identity-pub-key-32bytes!!!').toString('base64');
const FAKE_ED_PRIV    = Buffer.from('fake-device-ed25519-priv-key-32b').toString('base64');
const FAKE_X25519_PRIV= Buffer.from('fake-device-x25519-priv-key-32by').toString('base64');
const FAKE_KP         = Buffer.from('fake-mls-key-package-v1').toString('base64');

async function seedPrivateKeys() {
  await setSecure(SECURE_KEYS.IDENTITY_PRIVATE_KEY, FAKE_IDENT_PRIV);
  await setSecure(SECURE_KEYS.IDENTITY_PUBLIC_KEY,  FAKE_IDENT_PUB);
  await setSecure(SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY, FAKE_ED_PRIV);
  await setSecure(SECURE_KEYS.DEVICE_X25519_PRIVATE_KEY,  FAKE_X25519_PRIV);
}

beforeEach(async () => {
  resetSecureStore();
  _resetMls();
  await seedPrivateKeys();
});

describe('group lifecycle', () => {
  it('initGroupAsInitiator returns a welcome message', async () => {
    const result = await initGroupAsInitiator('thread-1', FAKE_KP);
    expect(result).not.toBeNull();
    expect(typeof result?.welcomeB64).toBe('string');
    expect(result!.welcomeB64.length).toBeGreaterThan(0);
  });

  it('hasGroupSession returns true after initGroupAsInitiator', async () => {
    await initGroupAsInitiator('thread-1', FAKE_KP);
    expect(await hasGroupSession('thread-1')).toBe(true);
  });

  it('hasGroupSession returns false before init', async () => {
    expect(await hasGroupSession('thread-never-init')).toBe(false);
  });

  it('initGroupAsRecipient returns true', async () => {
    const fakeWelcome = Buffer.from('fake-welcome').toString('base64');
    const ok = await initGroupAsRecipient('thread-2', fakeWelcome);
    expect(ok).toBe(true);
  });

  it('destroyGroupSession clears the session', async () => {
    await initGroupAsInitiator('thread-1', FAKE_KP);
    await destroyGroupSession('thread-1');
    expect(await hasGroupSession('thread-1')).toBe(false);
  });
});

describe('encrypt / decrypt round-trip', () => {
  beforeEach(async () => {
    await initGroupAsInitiator('thread-rtt', FAKE_KP);
  });

  it('encryptForThread returns a ciphertext', async () => {
    const result = await encryptForThread('thread-rtt', 'Hello world');
    expect(result).not.toBeNull();
    expect(typeof result?.ciphertextB64).toBe('string');
  });

  it('decryptFromThread recovers the original plaintext', async () => {
    const encrypted = await encryptForThread('thread-rtt', 'Secret message');
    expect(encrypted).not.toBeNull();
    const decrypted = await decryptFromThread('thread-rtt', encrypted!.ciphertextB64);
    expect(decrypted).toBe('Secret message');
  });

  it('encryptForThread returns null when no group session exists', async () => {
    const result = await encryptForThread('thread-nostate', 'test');
    expect(result).toBeNull();
  });

  it('decryptFromThread returns null when no group session exists', async () => {
    const result = await decryptFromThread('thread-nostate', 'abc');
    expect(result).toBeNull();
  });
});

describe('safety number', () => {
  it('derives a 60-digit safety number', async () => {
    const pub1 = Buffer.from('pubkey1-32bytesAAAAAAAAAAAAAAAAAAAA').toString('base64');
    const pub2 = Buffer.from('pubkey2-32bytesAAAAAAAAAAAAAAAAAAAA').toString('base64');
    const num = await deriveSafetyNumberForThread(pub1, pub2);
    expect(typeof num).toBe('string');
    expect(num?.length).toBe(60);
    expect(/^\d+$/.test(num!)).toBe(true);
  });
});
