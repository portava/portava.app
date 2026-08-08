/**
 * The production CryptoPort — binds threadCrypto to the real crypto layer.
 *
 * Kept apart from threadCrypto.ts so that module stays free of
 * expo-modules-core imports and its failure paths remain testable under
 * node:test. This file is the only thing that reaches into mlsSession /
 * secureStore.
 */
import { getSecure, setSecure, deleteSecure, SECURE_KEYS, isNative } from '../secureStore.ts';
import {
  hasGroupSession,
  initGroupAsInitiator,
  initGroupAsRecipient,
  encryptForThread,
  decryptFromThread,
} from '../mlsSession.ts';
import type { CryptoPort } from './threadCrypto.ts';

/** Single source of truth — see SECURE_KEYS.MLS_PENDING_KEY_PACKAGE. */
const PENDING_KP_KEY = SECURE_KEYS.MLS_PENDING_KEY_PACKAGE;

export const realCryptoPort: CryptoPort = {
  isNative,
  hasGroupSession,
  // mlsSession returns { ciphertextB64 } | null; the port speaks in strings so
  // threadCrypto's null-check is the single place a failure is interpreted.
  encryptForThread: async (threadId, plaintext) =>
    (await encryptForThread(threadId, plaintext))?.ciphertextB64 ?? null,
  decryptFromThread,
  initGroupAsInitiator,
  initGroupAsRecipient,
  getDeviceSigningKeys: async () => {
    const [priv, pub] = await Promise.all([
      getSecure(SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY),
      getSecure(SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY),
    ]);
    return priv && pub ? { priv, pub } : null;
  },
  getPendingKeyPackageState: () => getSecure(PENDING_KP_KEY),
  setPendingKeyPackageState: async (stateB64: string) => { await setSecure(PENDING_KP_KEY, stateB64); },
  clearPendingKeyPackageState: async () => { await deleteSecure(PENDING_KP_KEY); },
};
