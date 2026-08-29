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

  /**
   * E-2: private material for the currently-published KeyPackage.
   *
   * Written by cryptoIdentity when publishing, read by the e2ee port when a
   * Welcome arrives. It lives here rather than as a literal in both places
   * because a drift between the two makes every incoming Welcome unopenable —
   * silently, and with no way to recover the thread afterwards.
   */
  MLS_PENDING_KEY_PACKAGE: 'portava:mls_group:pending_keypackage',
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
// On native, uses expo-secure-store (Keychain / Keystore).
// On web, uses localStorage so sessions survive page refreshes in the preview.
// ---------------------------------------------------------------------------

// Fallback in-memory store for SSR / environments without localStorage.
const _webMemory = new Map<string, string>();

function webGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return _webMemory.get(key) ?? null; }
}
function webSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { _webMemory.set(key, value); }
}
function webRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { _webMemory.delete(key); }
}

// ---------------------------------------------------------------------------
// Keychain FAILURE handling for the Supabase adapter
//
// WHY THIS EXISTS (2026-08-29)
// ----------------------------
// The adapter below used to handle exactly one failure mode: the native module
// being absent (`if (!store) return webGet(key)`). It assumed that if
// `require('expo-secure-store')` resolved, the calls themselves would succeed.
// They do not. The native call can reject while the module is perfectly
// present, and then the rejection travels straight into GoTrue:
//
//   GoTrueClient._recoverAndRefresh   -> getItem -> Uncaught (in promise)
//   GoTrueClient._autoRefreshTokenTick -> getItem -> repeated every ~30s
//
// Observed on the iOS Simulator as `getValueWithKeyAsync ... A required
// entitlement isn't present` (errSecMissingEntitlement, -34018) — a red LogBox
// screen at launch plus a permanent error loop on the refresh timer.
//
// That particular cause is a BUILD problem (an ad-hoc-signed binary with an
// empty entitlements blob has no keychain access group). But the crash path is
// reachable on a correctly signed production build too: keychain reads fail
// with errSecInteractionNotAllowed (-25308) while the device is locked, and the
// auto-refresh timer runs while the phone is in a pocket. A storage adapter
// invoked from a timer must never throw.
//
// DELIBERATELY NOT CHANGED: getSecure/setSecure/deleteSecure still propagate.
// They carry E2EE private key material, where a swallowed failure means keys
// silently absent or lost, and every caller there needs to know. Only the
// Supabase session adapter degrades.
// ---------------------------------------------------------------------------

/** What the last native keychain operation of each kind actually did. */
export interface SecureStorePersistenceHealth {
  /** True once any native keychain call has failed this process. */
  degraded: boolean;
  /** Total native failures observed, by operation. */
  failures: { getItem: number; setItem: number; removeItem: number };
  /** Error message of the most recent failure; null while healthy. */
  lastError: string | null;
}

const _health: SecureStorePersistenceHealth = {
  degraded: false,
  failures: { getItem: 0, setItem: 0, removeItem: 0 },
  lastError: null,
};

/**
 * Persistence health for the Supabase session store.
 *
 * Exposed so the failure is assertable STATE rather than console output a test
 * would have to grep for: a call that "returned successfully" is not evidence
 * the keychain write happened.
 */
export function getSecureStorePersistenceHealth(): SecureStorePersistenceHealth {
  return { ..._health, failures: { ..._health.failures } };
}

/** Test seam: forget recorded failures. */
export function _resetSecureStorePersistenceHealth(): void {
  _health.degraded = false;
  _health.failures = { getItem: 0, setItem: 0, removeItem: 0 };
  _health.lastError = null;
}

type NativeOp = 'getItem' | 'setItem' | 'removeItem';

/**
 * Record a native keychain failure and log it without flooding.
 *
 * The auto-refresh timer retries roughly every 30s, so an unthrottled log is
 * thousands of identical lines a day. First failure of each kind logs in full;
 * after that only every 50th, carrying the running count.
 *
 * Logs the KEY NAME and the error. Never the value — see the module header.
 */
function noteNativeFailure(op: NativeOp, key: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  _health.degraded = true;
  _health.lastError = message;
  const n = (_health.failures[op] += 1);

  if (n === 1 || n % 50 === 0) {
    console.error(
      `[secureStore] keychain ${op} failed (${n} so far) for "${key}": ${message} — ` +
        'the Supabase session is NOT being persisted; sign-in will not survive a relaunch.',
    );
  }
}

export const SecureStoreAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    if (!isNative()) return webGet(key);
    const store = getStore();
    if (!store) return webGet(key);
    try {
      return await store.getItemAsync(key);
    } catch (err) {
      noteNativeFailure('getItem', key, err);
      // Fall back to whatever this process wrote after the keychain broke, so a
      // session established in THIS launch stays readable. Returning null
      // instead would make GoTrue see "no session" moments after a successful
      // sign-in. Null when nothing is held: a truthful "no stored session",
      // which GoTrue handles as signed-out rather than as an exception.
      return webGet(key);
    }
  },
  setItem: async (key: string, value: string): Promise<void> => {
    if (!isNative()) { webSet(key, value); return; }
    const store = getStore();
    if (!store) { webSet(key, value); return; }
    try {
      await store.setItemAsync(key, value);
    } catch (err) {
      noteNativeFailure('setItem', key, err);
      // In-process fallback only. This is NOT persistence and must never be
      // reported as success: the health record above is the honest signal.
      // It adds no new exposure — GoTrue already holds the live session in the
      // JS heap regardless of what the storage adapter does — but it does not
      // survive a relaunch, which is exactly what `degraded` says.
      webSet(key, value);
    }
  },
  removeItem: async (key: string): Promise<void> => {
    if (!isNative()) { webRemove(key); return; }
    const store = getStore();
    if (!store) { webRemove(key); return; }
    try {
      await store.deleteItemAsync(key);
    } catch (err) {
      // Security-relevant: a sign-out that fails to erase leaves a usable
      // session behind. Always clear the in-process copy, and record it.
      noteNativeFailure('removeItem', key, err);
    } finally {
      webRemove(key);
    }
  },
};
