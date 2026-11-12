/**
 * The production CryptoPort — binds threadCrypto to the real crypto layer.
 *
 * Kept apart from threadCrypto.ts so that module stays free of
 * expo-modules-core imports and its failure paths remain testable under
 * node:test. This file is the only thing that reaches into mlsSession /
 * secureStore.
 */
import { deleteSecure, SECURE_KEYS, isNative } from '../secureStore.ts';
import {
  hasGroupSession,
  initGroupAsInitiator,
  initGroupAsRecipient,
  encryptForThread,
  decryptFromThread,
} from '../mlsSession.ts';
import type { CryptoPort } from './threadCrypto.ts';
import type { MessagingOwnerRequest } from '../../services/observedOwnerSnapshot.ts';
import { LEGACY_PENDING, PENDING_PUBLIC, PENDING_PUBLISHED, notifyKeyPackageConsumed } from '../cryptoIdentity.ts';
import { cryptoOwner, cryptoStorageKey, serializedCrypto, reconcileNativeMessage, readCryptoSecret, writeCryptoSecret } from './nativeSessionStore.ts';

/** Single source of truth — see SECURE_KEYS.MLS_PENDING_KEY_PACKAGE. */
const PENDING_KP_KEY = SECURE_KEYS.MLS_PENDING_KEY_PACKAGE;

export const realCryptoPort = {
  isNative,
  reconcileMessage: (threadId: string, messageId: string, ciphertext: string | null, deleted: boolean, request?: MessagingOwnerRequest) => reconcileNativeMessage(cryptoOwner(request), threadId, messageId, ciphertext, deleted),
  hasGroupSession,
  // mlsSession returns { ciphertextB64 } | null; the port speaks in strings so
  // threadCrypto's null-check is the single place a failure is interpreted.
  encryptForThread: async (threadId: string, plaintext: string, assertCurrent?: () => void, owner?: MessagingOwnerRequest) => {
    const result = await encryptForThread(threadId, plaintext, assertCurrent, owner);
    assertCurrent?.();
    return result?.ciphertextB64 ?? null;
  },
  decryptFromThread,
  initGroupAsInitiator,
  initGroupAsRecipient,
  getDeviceSigningKeys: async (request?: MessagingOwnerRequest) => {
    const owner = cryptoOwner(request);
    const [priv, pub] = await Promise.all([
      readCryptoSecret(owner, SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY),
      readCryptoSecret(owner, SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY),
    ]);
    return priv && pub ? { priv, pub } : null;
  },
  getPendingKeyPackageState: (owner?: MessagingOwnerRequest) => readCryptoSecret(cryptoOwner(owner), PENDING_KP_KEY),
  getPendingKeyPackageStates: async (request?: MessagingOwnerRequest) => {
    const owner = cryptoOwner(request);
    const values = await Promise.all([readCryptoSecret(owner, PENDING_KP_KEY), readCryptoSecret(owner, LEGACY_PENDING)]);
    return values.filter((value): value is string => !!value);
  },
  setPendingKeyPackageState: async (stateB64: string, owner?: MessagingOwnerRequest) => { await writeCryptoSecret(cryptoOwner(owner), PENDING_KP_KEY, stateB64); },
  clearPendingKeyPackageState: async (usedState?: string, request?: MessagingOwnerRequest) => {
    const owner = cryptoOwner(request);
    // Serialize replenishment against initialization; preserve private material
    // until the recipient session has committed successfully.
    await serializedCrypto(owner, '__identity__', async () => {
      const pending = await readCryptoSecret(owner, PENDING_KP_KEY);
      if (!usedState || pending === usedState) for (const key of [PENDING_KP_KEY, PENDING_PUBLIC, PENDING_PUBLISHED]) {
        await deleteSecure(cryptoStorageKey(owner, key)); cryptoOwner(owner);
      }
      const legacy = await readCryptoSecret(owner, LEGACY_PENDING);
      if (legacy && legacy === usedState) { await deleteSecure(cryptoStorageKey(owner, LEGACY_PENDING)); cryptoOwner(owner); }
    });
    notifyKeyPackageConsumed();
  },
} satisfies CryptoPort;
