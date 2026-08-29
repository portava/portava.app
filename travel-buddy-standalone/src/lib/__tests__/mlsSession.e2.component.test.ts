/**
 * E-2 validation: mlsSession encrypt/decrypt round-trip.
 *
 * Uses in-memory mocks for expo-secure-store and expo-openmls.
 *
 * DRIFT REPAIRED 2026-08-29
 * -------------------------
 * This suite had never executed (see the note in secureStore.e0.component.test.ts
 * for the runner gap), so it had drifted away from mlsSession.ts unnoticed in two
 * ways. Both were fixed HERE rather than in the product, because the product is
 * the coherent side of each disagreement:
 *
 *   1. initGroupAsInitiator takes (threadId, userId, recipientKeyPackageB64).
 *      The suite passed two arguments, so the key package landed in `userId` and
 *      the real key package was undefined. `userId` is deliberate: mlsSession.ts:93
 *      documents it as the PUBLIC identifier placed in the MLS credential.
 *   2. loadPrivKeys() requires the device ed25519 PUBLIC key as well as the
 *      private one, and seedPrivateKeys() seeded only the private half — so
 *      loadPrivKeys() returned null and every group operation returned null with
 *      no error, which is what "Received: null" was.
 *
 * Both would have been caught the day they were introduced had the suite been
 * wired into a runner.
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
const FAKE_ED_PUB     = Buffer.from('fake-device-ed25519-pub-key-32by').toString('base64');
const FAKE_X25519_PRIV= Buffer.from('fake-device-x25519-priv-key-32by').toString('base64');
const FAKE_KP         = Buffer.from('fake-mls-key-package-v1').toString('base64');

/** Public identifier for the MLS credential — NOT key material (mlsSession.ts:93). */
const USER_ID = 'user-under-test';

async function seedPrivateKeys() {
  await setSecure(SECURE_KEYS.IDENTITY_PRIVATE_KEY, FAKE_IDENT_PRIV);
  await setSecure(SECURE_KEYS.IDENTITY_PUBLIC_KEY,  FAKE_IDENT_PUB);
  await setSecure(SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY, FAKE_ED_PRIV);
  // loadPrivKeys() returns null unless BOTH halves are present, and a null there
  // makes every group operation return null silently.
  await setSecure(SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY,  FAKE_ED_PUB);
  await setSecure(SECURE_KEYS.DEVICE_X25519_PRIVATE_KEY,  FAKE_X25519_PRIV);
}

beforeEach(async () => {
  resetSecureStore();
  _resetMls();
  await seedPrivateKeys();
});

describe('group lifecycle', () => {
  it('initGroupAsInitiator returns a welcome message', async () => {
    const result = await initGroupAsInitiator('thread-1', USER_ID, FAKE_KP);
    expect(result).not.toBeNull();
    expect(typeof result?.welcomeB64).toBe('string');
    expect(result!.welcomeB64.length).toBeGreaterThan(0);
  });

  it('hasGroupSession returns true after initGroupAsInitiator', async () => {
    await initGroupAsInitiator('thread-1', USER_ID, FAKE_KP);
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
    await initGroupAsInitiator('thread-1', USER_ID, FAKE_KP);
    await destroyGroupSession('thread-1');
    expect(await hasGroupSession('thread-1')).toBe(false);
  });
});

describe('encrypt / decrypt round-trip', () => {
  beforeEach(async () => {
    await initGroupAsInitiator('thread-rtt', USER_ID, FAKE_KP);
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
  // Third drift, and the one that exposed a real inconsistency in the module.
  // The suite called deriveSafetyNumberForThread(pubA, pubB) — two identity
  // public keys. The function takes a THREAD ID (mlsSession.ts:221), loads that
  // thread's group state, and derives from it. Passing a pubkey as the threadId
  // meant loadGroupState() found nothing and returned null, so the assertion saw
  // `typeof null === 'object'`.
  //
  // Rust (lib.rs:417), openmls.udl:72, the generated Swift and mlsSession.ts all
  // agree the derivation takes ONE argument, the group state. See the standalone
  // note below for the one layer that does not.
  it('derives a 60-digit safety number for an established thread', async () => {
    await initGroupAsInitiator('thread-sn', USER_ID, FAKE_KP);
    const num = await deriveSafetyNumberForThread('thread-sn');
    expect(typeof num).toBe('string');
    expect(num?.length).toBe(60);
    expect(/^\d+$/.test(num!)).toBe(true);
  });

  it('returns null for a thread with no group state, rather than throwing', async () => {
    expect(await deriveSafetyNumberForThread('thread-never-established')).toBeNull();
  });
});
