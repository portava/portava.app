/**
 * E-2: MLS group session management.
 *
 * Manages per-thread MLS group state stored in SecureStore.
 * Group state is loaded fresh on each operation and stored back immediately after.
 * This avoids in-memory state that would be lost on process kill.
 *
 * Called by the messaging service layer:
 *   - Before sending an E2EE message: encryptForThread()
 *   - After receiving an E2EE message: decryptFromThread()
 *   - When a new E2EE thread is created: initGroupAsInitiator() / initGroupAsRecipient()
 *
 * NEVER log plaintext, ciphertext, group state bytes, or key material.
 */

import {
  getSecure,
  setSecure,
  deleteSecure,
  SECURE_KEYS,
  isNative,
} from './secureStore.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface E1PrivKeys {
  /** Device Ed25519 SIGNING key — the key MLS actually uses. */
  deviceEd25519PrivB64: string;
  /** Its public half; the Rust side imports the pair rather than minting one. */
  deviceEd25519PubB64: string;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/** Build the SecureStore key for a thread's group state. */
function groupStateKey(threadId: string): string {
  return `${SECURE_KEYS.MLS_GROUP_STATE_PREFIX}${threadId}`;
}

/**
 * Load the device signing key pair from SecureStore.
 *
 * The identity PRIVATE key is deliberately NOT loaded here any more. It used to
 * be passed to the native module, which placed it in the MLS credential — a
 * public field that travels to the server and the peer. Nothing outside
 * SecureStore needs it.
 */
async function loadPrivKeys(): Promise<E1PrivKeys | null> {
  const [deviceEd25519PrivB64, deviceEd25519PubB64] = await Promise.all([
    getSecure(SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY),
    getSecure(SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY),
  ]);
  if (!deviceEd25519PrivB64 || !deviceEd25519PubB64) return null;
  return { deviceEd25519PrivB64, deviceEd25519PubB64 };
}

/** Load MLS group state for a thread. Returns null if not yet established. */
async function loadGroupState(threadId: string): Promise<string | null> {
  return getSecure(groupStateKey(threadId));
}

/** Persist updated MLS group state for a thread. */
async function saveGroupState(threadId: string, groupStateB64: string): Promise<void> {
  await setSecure(groupStateKey(threadId), groupStateB64);
}

/** Check whether an MLS session exists for a thread. */
export async function hasGroupSession(threadId: string): Promise<boolean> {
  if (!isNative()) return false;
  const state = await loadGroupState(threadId);
  return Boolean(state);
}

/** Delete the MLS session for a thread (e.g. on thread leave or reset). */
export async function destroyGroupSession(threadId: string): Promise<void> {
  await deleteSecure(groupStateKey(threadId));
}

// ---------------------------------------------------------------------------
// Group lifecycle
// ---------------------------------------------------------------------------

/**
 * Called by the thread initiator to create a new MLS group.
 * Returns the Welcome message to send to the recipient via the server.
 */
export async function initGroupAsInitiator(
  threadId: string,
  /** PUBLIC identifier placed in the MLS credential. Never key material. */
  userId: string,
  recipientKeyPackageB64: string,
): Promise<{ welcomeB64: string } | null> {
  if (!isNative()) return null;

  const keys = await loadPrivKeys();
  if (!keys) {
    console.error('[mlsSession] initGroupAsInitiator: no crypto identity — run initCryptoIdentity first');
    return null;
  }

  let ExpoOpenmls: any = null;
  try {
    ExpoOpenmls = require('expo-openmls');
  } catch {
    console.error('[mlsSession] expo-openmls not available — EAS build required');
    return null;
  }

  const result = await ExpoOpenmls.createGroup(
    userId,
    keys.deviceEd25519PrivB64,
    keys.deviceEd25519PubB64,
    recipientKeyPackageB64,
  );

  await saveGroupState(threadId, result.groupStateB64);
  return { welcomeB64: result.welcomeB64 };
}

/**
 * Called by the recipient when a new E2EE thread is opened.
 * The Welcome message is fetched from the server and passed in here.
 */
export async function initGroupAsRecipient(
  threadId: string,
  welcomeB64: string,
  /**
   * Provider snapshot returned by generateKeyPackage. It carries the
   * KeyPackage's private material, which the Welcome is encrypted to — without
   * it the join cannot succeed.
   */
  pendingStateB64: string,
): Promise<boolean> {
  if (!isNative()) return false;

  let ExpoOpenmls: any = null;
  try {
    ExpoOpenmls = require('expo-openmls');
  } catch {
    return false;
  }

  const groupStateB64 = await ExpoOpenmls.processWelcome(welcomeB64, pendingStateB64);

  await saveGroupState(threadId, groupStateB64);
  return true;
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

export interface EncryptedMessage {
  ciphertextB64: string;
}

/**
 * Encrypt a plaintext message for an E2EE thread.
 * Updates group state in SecureStore after encryption.
 */
export async function encryptForThread(
  threadId: string,
  plaintext: string,
): Promise<EncryptedMessage | null> {
  if (!isNative()) return null;

  const groupState = await loadGroupState(threadId);
  if (!groupState) {
    console.error('[mlsSession] encryptForThread: no group state for thread', threadId);
    return null;
  }

  let ExpoOpenmls: any = null;
  try { ExpoOpenmls = require('expo-openmls'); } catch { return null; }

  const result = await ExpoOpenmls.encryptMessage(groupState, plaintext);
  await saveGroupState(threadId, result.updatedGroupStateB64);
  return { ciphertextB64: result.ciphertextB64 };
}

/**
 * Decrypt a received E2EE message.
 * Updates group state in SecureStore after decryption.
 */
export async function decryptFromThread(
  threadId: string,
  ciphertextB64: string,
): Promise<string | null> {
  if (!isNative()) return null;

  const groupState = await loadGroupState(threadId);
  if (!groupState) {
    console.error('[mlsSession] decryptFromThread: no group state for thread', threadId);
    return null;
  }

  let ExpoOpenmls: any = null;
  try { ExpoOpenmls = require('expo-openmls'); } catch { return null; }

  const result = await ExpoOpenmls.decryptMessage(groupState, ciphertextB64);
  await saveGroupState(threadId, result.updatedGroupStateB64);
  return result.plaintext;
}

// ---------------------------------------------------------------------------
// Safety number
// ---------------------------------------------------------------------------

/**
 * Derive the safety number for a 1:1 E2EE thread from the LIVE group state.
 *
 * It used to take two identity public keys fetched from the server. Those keys
 * were never used by the MLS session, so a matching number proved nothing and
 * could not have detected a MitM. It now derives from the signature keys
 * actually present in the group's ratchet tree.
 */
export async function deriveSafetyNumberForThread(
  threadId: string,
): Promise<string | null> {
  if (!isNative()) return null;

  const groupState = await loadGroupState(threadId);
  if (!groupState) return null;

  let ExpoOpenmls: any = null;
  try { ExpoOpenmls = require('expo-openmls'); } catch { return null; }

  return ExpoOpenmls.deriveSafetyNumber(groupState);
}
