/**
 * SecureStore — typed wrapper around expo-secure-store.
 *
 * All E2EE private key material and the Supabase auth session flow through
 * this module. Keys are stored in iOS Keychain (WHEN_UNLOCKED_THIS_DEVICE_ONLY)
 * and Android Keystore via expo-secure-store defaults.
 *
 * Platform guard: SecureStore is unavailable on web (Expo web preview).
 * On web, all operations silently no-op (read = null, write = noop).
 * This means auth won't persist across web reloads — acceptable; web is not
 * a production target for the E2EE feature.
 *
 * NEVER log values stored through this module.
 * NEVER pass key material as function arguments that reach analytics or crash reporters.
 */

import { Platform } from 'react-native';

// ---------------------------------------------------------------------------
// Dynamic import — expo-secure-store is a native module; avoid static import
// on web where it throws "Cannot find native module 'ExpoSecureStore'".
// We use a lazy-init pattern and cache the module reference.
// ---------------------------------------------------------------------------

type SecureStoreModule = {
  getItemAsync(key: string, options?: object): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: object): Promise<void>;
  deleteItemAsync(key: string, options?: object): Promise<void>;
};

let _store: SecureStoreModule | null = null;

function getStore(): SecureStoreModule | null {
  if (!isNative()) return null;
  if (_store) return _store;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _store = require('expo-secure-store') as SecureStoreModule;
    return _store;
  } catch {
    return null;
  }
}

export function isNative(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

// ---------------------------------------------------------------------------
// iOS Keychain accessibility option: WHEN_UNLOCKED_THIS_DEVICE_ONLY prevents
// iCloud Keychain sync and ensures private keys cannot leave the device.
// ---------------------------------------------------------------------------
const ACCESSIBILITY_OPTION = isNative()
  ? (() => {
      try {
        const SecureStore = require('expo-secure-store');
        return { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
      } catch {
        return {};
      }
    })()
  : {};

// ---------------------------------------------------------------------------
// Key-name constants — centralised to avoid typos and track all stored values.
// ---------------------------------------------------------------------------
export const SECURE_KEYS = {
  // E-0: migration marker
  E0_MIGRATION_DONE: 'portava:e0_migration_done',

  // E-0: local SQLCipher DB root key (32-byte random, base64-encoded)
  LOCAL_DB_KEY: 'portava:local_db_key',

  // E-1: identity key pair (Ed25519)
  IDENTITY_PRIVATE_KEY: 'portava:identity_private_key',
  IDENTITY_PUBLIC_KEY: 'portava:identity_public_key',

  // E-1: device key pair (Ed25519 + X25519)
  DEVICE_ED25519_PRIVATE_KEY: 'portava:device_ed25519_private_key',
  DEVICE_ED25519_PUBLIC_KEY: 'portava:device_ed25519_public_key',
  DEVICE_X25519_PRIVATE_KEY: 'portava:device_x25519_private_key',
  DEVICE_X25519_PUBLIC_KEY: 'portava:device_x25519_public_key',

  // E-1: registered device ID (UUID from server)
  REGISTERED_DEVICE_ID: 'portava:registered_device_id',

  // E-2: MLS group state is stored per group; keys are prefixed
  MLS_GROUP_STATE_PREFIX: 'portava:mls_group:',
} as const;

export type SecureKey = typeof SECURE_KEYS[keyof typeof SECURE_KEYS];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read a value from SecureStore. Returns null on web or if key not found. */
export async function getSecure(key: string): Promise<string | null> {
  const store = getStore();
  if (!store) return null;
  return store.getItemAsync(key, ACCESSIBILITY_OPTION);
}

/** Write a value to SecureStore. No-op on web. */
export async function setSecure(key: string, value: string): Promise<void> {
  const store = getStore();
  if (!store) return;
  return store.setItemAsync(key, value, ACCESSIBILITY_OPTION);
}

/** Delete a value from SecureStore. No-op on web. */
export async function deleteSecure(key: string): Promise<void> {
  const store = getStore();
  if (!store) return;
  return store.deleteItemAsync(key, ACCESSIBILITY_OPTION);
}

// ---------------------------------------------------------------------------
// Supabase storage adapter
//
// Passed to createClient({ auth: { storage: SecureStoreAdapter } }).
// On web, falls back to a no-op in-memory shim so the web preview renders.
// ---------------------------------------------------------------------------

const _webMemory = new Map<string, string>();

export const SecureStoreAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    if (!isNative()) return _webMemory.get(key) ?? null;
    const store = getStore();
    if (!store) return _webMemory.get(key) ?? null;
    return store.getItemAsync(key);
  },
  setItem: async (key: string, value: string): Promise<void> => {
    if (!isNative()) { _webMemory.set(key, value); return; }
    const store = getStore();
    if (!store) { _webMemory.set(key, value); return; }
    return store.setItemAsync(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    if (!isNative()) { _webMemory.delete(key); return; }
    const store = getStore();
    if (!store) { _webMemory.delete(key); return; }
    return store.deleteItemAsync(key);
  },
};
