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
 * Return value (base64) should be uploaded to the server's KeyPackage pool.
 * Never stores private keys — those come from SecureStore on the caller side.
 */
export function generateKeyPackage(
  identityPrivB64: string,
  deviceEd25519PrivB64: string,
  deviceX25519PrivB64: string,
): Promise<string> {
  return wrapNative<string>('generateKeyPackage', identityPrivB64, deviceEd25519PrivB64, deviceX25519PrivB64);
}

/**
 * Create a new MLS group (1:1 thread).
 * Returns `groupStateB64` (store in SecureStore) and `welcomeB64` (send to recipient).
 */
export function createGroup(
  myIdentityPrivB64: string,
  myDeviceEd25519PrivB64: string,
  myDeviceX25519PrivB64: string,
  recipientKeyPackageB64: string,
): Promise<GroupCreateResult> {
  return wrapNative<GroupCreateResult>(
    'createGroup',
    myIdentityPrivB64,
    myDeviceEd25519PrivB64,
    myDeviceX25519PrivB64,
    recipientKeyPackageB64,
  );
}

/**
 * Join an MLS group from a Welcome message.
 * Returns `groupStateB64` (store in SecureStore).
 */
export function processWelcome(
  myIdentityPrivB64: string,
  myDeviceEd25519PrivB64: string,
  myDeviceX25519PrivB64: string,
  welcomeB64: string,
): Promise<string> {
  return wrapNative<string>(
    'processWelcome',
    myIdentityPrivB64,
    myDeviceEd25519PrivB64,
    myDeviceX25519PrivB64,
    welcomeB64,
  );
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
 * Derive a 60-digit decimal safety number from two Ed25519 identity public keys.
 * Commutative: derive_safety_number(A, B) === derive_safety_number(B, A).
 */
export function deriveSafetyNumber(identityPubAB64: string, identityPubBB64: string): Promise<string> {
  return wrapNative<string>('deriveSafetyNumber', identityPubAB64, identityPubBB64);
}
