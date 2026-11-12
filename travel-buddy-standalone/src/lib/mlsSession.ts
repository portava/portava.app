/** Account-bound MLS operations. A thread's ratchet and decrypted history are
 * committed atomically, so reloads never decrypt already-consumed ciphertext. */
import { SECURE_KEYS, isNative } from './secureStore.ts';
import type { MessagingOwnerRequest } from '../services/observedOwnerSnapshot.ts';
import {
  cryptoOwner, serializedCrypto, readCryptoSecret, readNativeSession, readNativeBody,
  commitNativeSession, destroyNativeSession, pendingWasConsumed,
} from './e2ee/nativeSessionStore.ts';

type Native = typeof import('../../vendor/expo-openmls/src/index.ts');
function nativeModule(): Native { return require('expo-openmls') as Native; }
function check(owner: MessagingOwnerRequest, assertCurrent?: () => void) { cryptoOwner(owner); assertCurrent?.(); }
export interface E1PrivKeys { deviceEd25519PrivB64: string; deviceEd25519PubB64: string }
async function loadPrivKeys(owner: MessagingOwnerRequest): Promise<E1PrivKeys | null> {
  const [deviceEd25519PrivB64, deviceEd25519PubB64] = await Promise.all([
    readCryptoSecret(owner, SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY), readCryptoSecret(owner, SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY),
  ]);
  return deviceEd25519PrivB64 && deviceEd25519PubB64 ? { deviceEd25519PrivB64, deviceEd25519PubB64 } : null;
}
export async function hasGroupSession(threadId: string, request?: MessagingOwnerRequest): Promise<boolean> {
  if (!isNative()) return false;
  const owner = cryptoOwner(request);
  return Boolean(await readNativeSession(owner, threadId));
}
export async function destroyGroupSession(threadId: string, request?: MessagingOwnerRequest): Promise<void> {
  const owner = cryptoOwner(request);
  await serializedCrypto(owner, threadId, () => destroyNativeSession(owner, threadId));
}
export async function initGroupAsInitiator(threadId: string, userId: string, recipientKeyPackageB64: string, assertCurrent?: () => void, request?: MessagingOwnerRequest): Promise<{ welcomeB64: string } | null> {
  if (!isNative()) return null;
  const owner = cryptoOwner(request); check(owner, assertCurrent);
  if (userId !== owner.ownerId) throw new Error('Encrypted-message identity does not match the signed-in account.');
  return serializedCrypto(owner, threadId, async () => {
    const keys = await loadPrivKeys(owner); check(owner, assertCurrent);
    if (!keys) return null;
    const result = await nativeModule().createGroup(userId, keys.deviceEd25519PrivB64, keys.deviceEd25519PubB64, recipientKeyPackageB64);
    check(owner, assertCurrent);
    await commitNativeSession(owner, threadId, result.groupStateB64); check(owner, assertCurrent);
    return { welcomeB64: result.welcomeB64 };
  });
}
export async function initGroupAsRecipient(threadId: string, welcomeB64: string, pendingStateB64: string, assertCurrent?: () => void, request?: MessagingOwnerRequest): Promise<boolean> {
  if (!isNative()) return false;
  const owner = cryptoOwner(request); check(owner, assertCurrent);
  return serializedCrypto(owner, threadId, () => serializedCrypto(owner, '__identity__', async () => {
    // Two overlapping history fetches must not replay a Welcome over live state.
    if (await readNativeSession(owner, threadId)) return false;
    check(owner, assertCurrent);
    if (await pendingWasConsumed(owner, pendingStateB64)) return false;
    check(owner, assertCurrent);
    const state = await nativeModule().processWelcome(welcomeB64, pendingStateB64); check(owner, assertCurrent);
    const memberOwner = await nativeModule().sessionOwnerId(state); check(owner, assertCurrent);
    if (memberOwner !== owner.ownerId) throw new Error('The Welcome belongs to another encrypted-message identity.');
    await commitNativeSession(owner, threadId, state, undefined, pendingStateB64); check(owner, assertCurrent);
    return true;
  }));
}
export interface EncryptedMessage { ciphertextB64: string }
export async function encryptForThread(threadId: string, plaintext: string, assertCurrent?: () => void, request?: MessagingOwnerRequest): Promise<EncryptedMessage | null> {
  if (!isNative()) return null;
  const owner = cryptoOwner(request); check(owner, assertCurrent);
  return serializedCrypto(owner, threadId, async () => {
    const state = await readNativeSession(owner, threadId); check(owner, assertCurrent);
    if (!state) return null;
    const result = await nativeModule().encryptMessage(state, plaintext); check(owner, assertCurrent);
    // MLS cannot decrypt its own consumed send ratchet. Cache outgoing bodies in
    // the same commit, before the durable outbox may dispatch the ciphertext.
    await commitNativeSession(owner, threadId, result.updatedGroupStateB64, { ciphertext: result.ciphertextB64, body: plaintext });
    check(owner, assertCurrent);
    return { ciphertextB64: result.ciphertextB64 };
  });
}
export async function decryptFromThread(threadId: string, ciphertextB64: string, assertCurrent?: () => void, request?: MessagingOwnerRequest): Promise<string | null> {
  if (!isNative()) return null;
  const owner = cryptoOwner(request); check(owner, assertCurrent);
  return serializedCrypto(owner, threadId, async () => {
    const cached = await readNativeBody(owner, threadId, ciphertextB64); check(owner, assertCurrent);
    if (cached !== null) return cached;
    const state = await readNativeSession(owner, threadId); check(owner, assertCurrent);
    if (!state) return null;
    const result = await nativeModule().decryptMessage(state, ciphertextB64); check(owner, assertCurrent);
    await commitNativeSession(owner, threadId, result.updatedGroupStateB64, { ciphertext: ciphertextB64, body: result.plaintext });
    check(owner, assertCurrent);
    return result.plaintext;
  });
}
export async function deriveSafetyNumberForThread(threadId: string, request?: MessagingOwnerRequest): Promise<string | null> {
  if (!isNative()) return null;
  const owner = cryptoOwner(request);
  return serializedCrypto(owner, threadId, async () => {
    const state = await readNativeSession(owner, threadId); check(owner);
    if (!state) return null;
    const result = await nativeModule().deriveSafetyNumber(state); check(owner); return result;
  });
}
