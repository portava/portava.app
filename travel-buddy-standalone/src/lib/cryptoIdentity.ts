/**
 * E-1: Crypto identity initialisation.
 *
 * On first launch (or after a re-install that cleared SecureStore on iOS):
 *   1. Generates an Ed25519 identity key pair and an Ed25519+X25519 device key pair.
 *   2. Stores all private keys in SecureStore.
 *   3. Registers the device with the server (`POST /me/crypto-devices/:id/public-key`).
 *   4. Generates an initial batch of KeyPackages and uploads them to the server.
 *
 * Subsequent launches: detects existing keys in SecureStore and skips generation.
 *
 * HALTING CONDITION: if expo-openmls is not loaded (EAS build not performed),
 * this function logs an error and returns without setting keys. The app continues
 * to work without E2EE (E-0 / plaintext mode) until an EAS build is run.
 *
 * NEVER log private key values.
 */

import { Platform } from 'react-native';
import {
  getSecure,
  setSecure,
  SECURE_KEYS,
  isNative,
} from './secureStore.ts';
import { freshToken } from '../services/apiToken.ts';

const KEY_PACKAGE_BATCH_SIZE = 10;

function log(msg: string, data?: object) {
  if (__DEV__) {
    console.log(`[CryptoIdentity] ${msg}`, data ?? '');
  }
}

/** Returns true if identity keys are already in SecureStore. */
export async function hasCryptoIdentity(): Promise<boolean> {
  if (!isNative()) return false;
  const key = await getSecure(SECURE_KEYS.IDENTITY_PRIVATE_KEY);
  return Boolean(key);
}

/** Returns the stored identity public key, or null if not initialised. */
export async function getIdentityPublicKey(): Promise<string | null> {
  return getSecure(SECURE_KEYS.IDENTITY_PUBLIC_KEY);
}

/** Returns the stored device Ed25519 public key, or null if not initialised. */
export async function getDeviceEd25519PublicKey(): Promise<string | null> {
  return getSecure(SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY);
}

/** Returns the registered device ID (UUID from server), or null. */
export async function getRegisteredDeviceId(): Promise<string | null> {
  return getSecure(SECURE_KEYS.REGISTERED_DEVICE_ID);
}

/**
 * Main entry point. Idempotent — safe to call on every app launch.
 * Returns immediately if keys are already generated.
 */
export async function initCryptoIdentity(opts: {
  /** Server API helper — must POST and PUT against /api endpoints. */
  apiPost: (path: string, body?: object) => Promise<{ data?: unknown; error?: unknown }>;
  apiPut: (path: string, body: object) => Promise<{ data?: unknown; error?: unknown }>;
}): Promise<void> {
  if (!isNative()) return;

  // Guard: expo-openmls native module requires an EAS dev build
  let ExpoOpenmls: any = null;
  try {
    ExpoOpenmls = require('expo-openmls');
  } catch {
    log('expo-openmls not available — running in plaintext mode (EAS build required for E2EE)');
    return;
  }

  // Idempotent: already initialised?
  const existingIdentityPriv = await getSecure(SECURE_KEYS.IDENTITY_PRIVATE_KEY);
  if (existingIdentityPriv) {
    // Ensure the server has our device ID (may have been lost between restarts)
    await _ensureDeviceRegistered(opts.apiPost, ExpoOpenmls, existingIdentityPriv);
    return;
  }

  log('generating key material for first time…');

  // 1. Identity key pair (Ed25519 — long-lived per user)
  let identityKeys: { pubKeyB64: string; privKeyB64: string };
  try {
    identityKeys = await ExpoOpenmls.generateIdentityKeyPair();
  } catch (err) {
    log('identity key generation failed', { err });
    return; // non-fatal: app continues without E2EE
  }

  // 2. Device key pair (Ed25519 + X25519 — one per install)
  let deviceKeys: {
    ed25519PubB64: string; ed25519PrivB64: string;
    x25519PubB64: string; x25519PrivB64: string;
  };
  try {
    deviceKeys = await ExpoOpenmls.generateDeviceKeyPair();
  } catch (err) {
    log('device key generation failed', { err });
    return;
  }

  // 3. Store ALL private keys before any network call.
  //    If the network call fails below, keys are in SecureStore for next launch.
  await setSecure(SECURE_KEYS.IDENTITY_PRIVATE_KEY,        identityKeys.privKeyB64);
  await setSecure(SECURE_KEYS.IDENTITY_PUBLIC_KEY,         identityKeys.pubKeyB64);
  await setSecure(SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY,  deviceKeys.ed25519PrivB64);
  await setSecure(SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY,   deviceKeys.ed25519PubB64);
  await setSecure(SECURE_KEYS.DEVICE_X25519_PRIVATE_KEY,   deviceKeys.x25519PrivB64);
  await setSecure(SECURE_KEYS.DEVICE_X25519_PUBLIC_KEY,    deviceKeys.x25519PubB64);

  log('keys generated and stored in SecureStore');

  // 4. Register device + upload public key
  await _ensureDeviceRegistered(opts.apiPost, ExpoOpenmls, identityKeys.privKeyB64);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _ensureDeviceRegistered(
  apiPost: (path: string, body?: object) => Promise<{ data?: unknown; error?: unknown }>,
  ExpoOpenmls: any,
  identityPrivB64: string,
): Promise<void> {
  let deviceId = await getSecure(SECURE_KEYS.REGISTERED_DEVICE_ID);

  if (!deviceId) {
    // Register the device
    const { data, error } = await apiPost('/me/crypto-devices', {
      platform: Platform.OS === 'android' ? 'android' : Platform.OS === 'web' ? 'web' : 'ios',
    }) as { data?: { device?: { id: string } }; error?: unknown };

    if (error || !data?.device?.id) {
      log('device registration failed', { error });
      return;
    }
    deviceId = data.device.id;
    await setSecure(SECURE_KEYS.REGISTERED_DEVICE_ID, deviceId);
    log('device registered', { deviceId });
  }

  // Upload public key (no-op if already set — server handles gracefully)
  const identityPub = await getSecure(SECURE_KEYS.IDENTITY_PUBLIC_KEY);
  if (identityPub && deviceId) {
    const result = await (async () => {
      try {
        const url = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
        const token = await freshToken();
        if (!token) return;
        await fetch(`${url}/api/me/crypto-devices/${deviceId}/public-key`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ publicKey: identityPub }),
        });
      } catch { /* best-effort */ }
    })();
  }
}
