/**
 * expo-openmls — TypeScript entry point.
 *
 * Loads the native module and exposes typed async wrappers.
 * All functions throw OpenMlsError on failure.
 *
 * CRITICAL: never pass return values from these functions to console.log,
 * analytics, crash reporters, or any network call except the explicitly
 * designated public-key endpoints. Private key fields (privKeyB64,
 * ed25519PrivB64, x25519PrivB64) must go only to SecureStore.
 */

import { NativeModulesProxy, requireNativeModule } from 'expo-modules-core';
import {
  KeyPairBytes,
  DeviceKeyPairBytes,
  KeyPackageResult,
  GroupCreateResult,
  EncryptResult,
  DecryptResult,
  OpenMlsError,
  type OpenMlsErrorCode,
} from './ExpoOpenmls.types';

export * from './ExpoOpenmls.types';

// ---------------------------------------------------------------------------
// Native module proxy
// ---------------------------------------------------------------------------

let _native: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null;

function getNative() {
  if (_native) return _native;
  try {
    _native = requireNativeModule('ExpoOpenmls') as typeof _native;
    return _native!;
  } catch {
    throw new OpenMlsError('KeyGenFailed', 'ExpoOpenmls native module not loaded. Is this a dev build (not Expo Go)?');
  }
}

function wrapNative<T>(fnName: string, ...args: unknown[]): Promise<T> {
  return getNative()[fnName](...args) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Generate an Ed25519 identity key pair (long-lived, one per user). */
export function generateIdentityKeyPair(): Promise<KeyPairBytes> {
  return wrapNative<KeyPairBytes>('generateIdentityKeyPair');
}

/** Generate a device key pair (Ed25519 + X25519, one per install). */
export function generateDeviceKeyPair(): Promise<DeviceKeyPairBytes> {
  return wrapNative<DeviceKeyPairBytes>('generateDeviceKeyPair');
}

/**
 * Generate a KeyPackage for the device's public key material.
 *
 * `userId` is a PUBLIC identifier placed in the MLS credential — it travels to
 * the server and to the peer. It is not key material and must never be one.
 *
 * Returns both halves: `keyPackageB64` for the server's pool, and
 * `pendingStateB64`, the private material processWelcome needs later, which
 * belongs in SecureStore.
 */
export function generateKeyPackage(
  userId: string,
  deviceEd25519PrivB64: string,
  deviceEd25519PubB64: string,
): Promise<KeyPackageResult> {
  return wrapNative<KeyPackageResult>('generateKeyPackage', userId, deviceEd25519PrivB64, deviceEd25519PubB64);
}

/**
 * Create a new MLS group (1:1 thread).
 * Returns `groupStateB64` (store in SecureStore) and `welcomeB64` (send to recipient).
 *
 * `userId` is the same PUBLIC credential identifier as in generateKeyPackage.
 */
export function createGroup(
  userId: string,
  deviceEd25519PrivB64: string,
  deviceEd25519PubB64: string,
  recipientKeyPackageB64: string,
): Promise<GroupCreateResult> {
  return wrapNative<GroupCreateResult>(
    'createGroup',
    userId,
    deviceEd25519PrivB64,
    deviceEd25519PubB64,
    recipientKeyPackageB64,
  );
}

/**
 * Join an MLS group from a Welcome message.
 * Returns `groupStateB64` (store in SecureStore).
 *
 * `pendingStateB64` is the private material returned by generateKeyPackage for
 * the KeyPackage this Welcome was encrypted to. Without the matching one the
 * Welcome cannot be opened — see SECURE_KEYS.MLS_PENDING_KEY_PACKAGE.
 */
export function processWelcome(
  welcomeB64: string,
  pendingStateB64: string,
): Promise<string> {
  return wrapNative<string>('processWelcome', welcomeB64, pendingStateB64);
}

/** Encrypt plaintext in an MLS group. Updates group state (must be stored back). */
export function encryptMessage(groupStateB64: string, plaintext: string): Promise<EncryptResult> {
  return wrapNative<EncryptResult>('encryptMessage', groupStateB64, plaintext);
}

/** Decrypt an MLS ciphertext. Updates group state (must be stored back). */
export function decryptMessage(groupStateB64: string, ciphertextB64: string): Promise<DecryptResult> {
  return wrapNative<DecryptResult>('decryptMessage', groupStateB64, ciphertextB64);
}

/**
 * Derive a 60-digit decimal safety number from the group's ACTUAL member
 * signature keys, read out of the ratchet tree in `groupStateB64`. Sorted, so
 * both devices derive the same value. Substituting a member changes their leaf
 * signature key and therefore the number — which is what makes it a real check.
 *
 * It previously took two caller-supplied identity public keys. Those were never
 * used by the MLS session, so a match proved nothing; openmls.udl:62-69 records
 * the change. This wrapper was not updated at the time.
 */
export function deriveSafetyNumber(groupStateB64: string): Promise<string> {
  return wrapNative<string>('deriveSafetyNumber', groupStateB64);
}
