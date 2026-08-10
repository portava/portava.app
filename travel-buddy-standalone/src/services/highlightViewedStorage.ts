/**
 * highlightViewedStorage — pure module holding the "which highlights has the
 * current account personally viewed" singleton state and its account-scoped
 * persistence.
 *
 * Extracted out of useHighlightRingState.ts (which transitively imports
 * 'react-native' via services/highlights.ts → lib/supabase.ts and so cannot
 * load under node:test) so the account-scoping logic is directly unit
 * testable. useHighlightRingState.ts re-exports viewedHighlightIds/
 * markViewed from here to keep every existing import site unchanged.
 */
import RealAsyncStorage from '@react-native-async-storage/async-storage';
import { isAccountScopedStorageEnabled } from '../config/accountScopedStorageFlag.ts';
import { getCurrentAccountId } from './accountId.ts';

/** Minimal subset of AsyncStorage this module needs. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

let _testStorage: StorageLike | null = null;

/**
 * Test seam — swap in a fake storage backend. The real
 * @react-native-async-storage/async-storage web fallback touches
 * `window.localStorage`, which doesn't exist under node:test; production
 * code never calls this. Pass null to restore the real AsyncStorage.
 */
export function _setTestStorage(storage: StorageLike | null): void {
  _testStorage = storage;
}

function storage(): StorageLike {
  return _testStorage ?? RealAsyncStorage;
}

const LEGACY_STORAGE_KEY = '@highlight_viewed_ids_v1';

/**
 * Per-account key, used only when isAccountScopedStorageEnabled() is true.
 * LEGACY_STORAGE_KEY above stays the sole key while the flag is off.
 *
 * This is account-specific: whether the CURRENT account has personally
 * viewed a given highlight. Left unscoped, a shared device leaks it across
 * accounts — account B would see other users' highlight rings as
 * "already viewed" that they have never actually opened.
 */
function scopedStorageKey(accountId: string): string {
  return `@highlight_viewed_ids_scoped_v1:${accountId}`;
}

const migratedAccountIds = new Set<string>();

/** Test seam — clear the migration-attempted cache between test cases. */
export function _resetMigratedHighlightViewedAccountIds(): void {
  migratedAccountIds.clear();
}

/**
 * One-time migration: attribute the existing unscoped viewed-ids map to
 * whichever account is currently signed in, then delete the legacy key.
 *
 * THIS IS A ONE-TIME BEST GUESS — the legacy map has no account field. If
 * two accounts previously shared this device, the viewed history is
 * attributed to whichever one happens to be signed in the first time this
 * runs post-upgrade. The map only holds other users' highlight ids and
 * expiry timestamps, so there is no side effect to clean up beyond moving
 * the key.
 */
async function migrateLegacyHighlightViewedIfNeeded(accountId: string): Promise<void> {
  if (migratedAccountIds.has(accountId)) return;
  migratedAccountIds.add(accountId);

  const scoped = scopedStorageKey(accountId);
  const existingScoped = await storage().getItem(scoped);
  if (existingScoped !== null) return; // already migrated, or this account already has its own map

  const legacyRaw = await storage().getItem(LEGACY_STORAGE_KEY);
  if (!legacyRaw) return; // nothing to migrate

  await storage().setItem(scoped, legacyRaw);
  await storage().removeItem(LEGACY_STORAGE_KEY);
}

/**
 * Resolves which key backs the viewed-ids map.
 *  - Flag off: always the legacy unscoped key (unchanged behavior).
 *  - Flag on, account resolvable: the per-account scoped key (running the
 *    one-time migration first if needed).
 *  - Flag on, no account resolvable: null. Never falls back to the unscoped
 *    legacy key.
 */
async function resolveHighlightViewedKey(): Promise<string | null> {
  if (!isAccountScopedStorageEnabled()) return LEGACY_STORAGE_KEY;
  const accountId = await getCurrentAccountId();
  if (!accountId) return null;
  await migrateLegacyHighlightViewedIfNeeded(accountId);
  return scopedStorageKey(accountId);
}

/**
 * In-memory set of viewed highlight IDs.
 * Populated on first import by `initViewedIds()` (which loads & prunes AsyncStorage).
 * Updated on every `markViewed()` call.
 */
export const viewedHighlightIds = new Set<string>();

/** Map persisted to AsyncStorage: id → ISO expiresAt string. */
let _persistedMap: Record<string, string> = {};

/**
 * The key the in-memory state above was last loaded from. `undefined` means
 * never loaded; `null` means "flag on, no account resolvable" (in-memory
 * only, no persistence). Used by markViewed() to know where to write, and by
 * loadForCurrentAccount() to detect an account switch mid-session.
 */
let _loadedKey: string | null | undefined;

/** Promise for any in-flight load, so concurrent initViewedIds() calls share one resolution. */
let _initPromise: Promise<void> | null = null;

async function loadForCurrentAccount(): Promise<void> {
  const key = await resolveHighlightViewedKey();
  if (key === _loadedKey) return; // already loaded for the current account — nothing to do

  // The resolved key changed (first load, or the signed-in account changed
  // since the last load) — the in-memory state belongs to a different
  // account and must not leak into the new one.
  viewedHighlightIds.clear();
  _persistedMap = {};
  _loadedKey = key;

  if (key === null) return; // no account resolvable — in-memory only, nothing to load

  try {
    const raw = await storage().getItem(key);
    const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    const pruned: Record<string, string> = {};
    for (const [id, expiresAt] of Object.entries(stored)) {
      if (new Date(expiresAt).getTime() > now) {
        pruned[id] = expiresAt;
        viewedHighlightIds.add(id);
      }
    }
    _persistedMap = pruned;
    // Write back the pruned map only if we actually removed stale entries
    if (Object.keys(pruned).length !== Object.keys(stored).length) {
      await storage().setItem(key, JSON.stringify(pruned));
    }
  } catch {
    // Storage unavailable — fall back to module-memory only
  }
}

/** Initialise (or re-sync, if the signed-in account changed) from AsyncStorage. */
export function initViewedIds(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = loadForCurrentAccount().finally(() => {
    _initPromise = null;
  });
  return _initPromise;
}

// Kick off immediately so storage is ready before the first render.
initViewedIds();

/**
 * Mark a highlight as viewed.
 * Updates the in-memory set and persists id→expiresAt to AsyncStorage so
 * the ring stays muted across app restarts.
 *
 * @param id        Highlight ID.
 * @param expiresAt ISO-8601 expiry string from the Highlight object (optional;
 *                  if omitted the entry is still added in-memory but not persisted).
 */
export function markViewed(id: string, expiresAt?: string): void {
  viewedHighlightIds.add(id);
  if (!expiresAt) return;
  // Skip persistence if this id is already stored with the same expiry
  if (_persistedMap[id] === expiresAt) return;
  _persistedMap[id] = expiresAt;

  if (!isAccountScopedStorageEnabled()) {
    // Flag off: always the legacy key, independent of _loadedKey, so
    // behavior is byte-identical to before this file gained account scoping.
    storage().setItem(LEGACY_STORAGE_KEY, JSON.stringify(_persistedMap)).catch(() => {});
    return;
  }

  // Flag on: write to whatever key the in-memory state is currently loaded
  // from. If that's null (no account resolvable), skip the write — never
  // fall back to the unscoped legacy key.
  if (_loadedKey) {
    storage().setItem(_loadedKey, JSON.stringify(_persistedMap)).catch(() => {});
  }
}

/**
 * Test seam — reset the module-level in-memory state (viewed ids, persisted
 * map, loaded-key marker) between test cases. This module keeps
 * process-lifetime singletons (by design — one viewed-ids set per app run),
 * which would otherwise leak state across unrelated tests.
 */
export function _resetHighlightViewedStateForTest(): void {
  viewedHighlightIds.clear();
  _persistedMap = {};
  _loadedKey = undefined;
  _initPromise = null;
}
