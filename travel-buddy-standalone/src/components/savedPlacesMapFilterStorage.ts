/**
 * Pure helper — AsyncStorage read/write for the SavedPlacesMapView category
 * chip filter.
 *
 * Extracted from SavedPlacesMapView so the persistence logic can be tested
 * without a native runtime or React.
 *
 * Unlike the Discovery map filter (which has a fixed enum of valid values),
 * valid categories here are dynamic — derived from the current place list.
 * Callers pass the current `categories` snapshot at read time so stale values
 * are resolved before touching component state.
 */

import { isAccountScopedStorageEnabled } from '../config/accountScopedStorageFlag.ts';
import { getCurrentAccountId } from '../services/accountId.ts';

/** Storage key prefix — the full key is prefix + listId. */
export const CATEGORY_STORAGE_PREFIX = 'saved_places_map_cat_v1_';

/** Minimal subset of AsyncStorage needed by these helpers. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Build the per-list storage key from a listId. */
export function categoryStorageKey(listId: string): string {
  return `${CATEGORY_STORAGE_PREFIX}${listId}`;
}

/**
 * Per-account key, used only when isAccountScopedStorageEnabled() is true.
 * categoryStorageKey() above stays the sole key while the flag is off.
 *
 * This filter is genuinely account-specific: it is which category chip the
 * viewing account personally selected while browsing THEIR OWN saved places
 * for this list, and it actively hides/shows pins (not just a passive
 * preference) — so on a shared device, a stale filter left by a previous
 * account can silently hide places the new account expects to see.
 */
export function scopedCategoryStorageKey(listId: string, accountId: string): string {
  return `${CATEGORY_STORAGE_PREFIX}scoped_v1_${listId}_${accountId}`;
}

const migratedListAccountPairs = new Set<string>();

/** Test seam — clear the migration-attempted cache between test cases. */
export function _resetMigratedCategoryFilterPairs(): void {
  migratedListAccountPairs.clear();
}

/**
 * One-time migration: attribute the existing unscoped per-list category
 * filter to whichever account is currently signed in, then delete the
 * legacy key.
 *
 * THIS IS A ONE-TIME BEST GUESS — the legacy key has no account field, so if
 * two accounts previously used this device and saved places to the same
 * listId (most commonly 'global'), the filter selection is attributed to
 * whichever account happens to be signed in the first time this runs
 * post-upgrade. There is no field anywhere to do better. The filter choice
 * itself carries no sensitive content (just a category label already visible
 * in the UI), so unlike reminders there is no side effect to clean up beyond
 * the key move.
 */
async function migrateLegacyCategoryFilterIfNeeded(
  storage: StorageLike,
  listId: string,
  accountId: string,
): Promise<void> {
  const pairKey = `${listId}::${accountId}`;
  if (migratedListAccountPairs.has(pairKey)) return;
  migratedListAccountPairs.add(pairKey);

  const scoped = scopedCategoryStorageKey(listId, accountId);
  const existingScoped = await storage.getItem(scoped);
  if (existingScoped !== null) return; // already migrated, or already has its own scoped data

  const legacyRaw = await storage.getItem(categoryStorageKey(listId));
  if (!legacyRaw) return; // nothing to migrate

  await storage.setItem(scoped, legacyRaw);
  await storage.removeItem(categoryStorageKey(listId));
}

/**
 * Resolves which key to read/write for this list's category filter.
 *  - Flag off: always the legacy per-list key (unchanged behavior).
 *  - Flag on, account resolvable: the per-list-per-account scoped key
 *    (running the one-time migration first if needed).
 *  - Flag on, no account resolvable: null — treat as "no stored filter" for
 *    reads, skip the write. Never fall back to the unscoped legacy key.
 */
export async function resolveCategoryStorageKey(
  storage: StorageLike,
  listId: string,
): Promise<string | null> {
  if (!isAccountScopedStorageEnabled()) return categoryStorageKey(listId);
  const accountId = await getCurrentAccountId();
  if (!accountId) return null;
  await migrateLegacyCategoryFilterIfNeeded(storage, listId, accountId);
  return scopedCategoryStorageKey(listId, accountId);
}

/**
 * Read the saved category filter from storage.
 *
 * Returns the stored value when it is a non-empty string that is present in
 * `categories`; returns `null` in every other case (null, empty string, stale
 * key, or storage error).
 */
export async function loadCategoryFilter(
  storage: StorageLike,
  storageKey: string,
  categories: string[],
): Promise<string | null> {
  try {
    const stored = await storage.getItem(storageKey);
    if (stored && categories.includes(stored)) {
      return stored;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the raw stored category value without validating against a categories
 * snapshot.
 *
 * Prefer this over `loadCategoryFilter` in the mount-restore useEffect so the
 * validation is deferred until the Promise resolves, using the LATEST categories
 * (via a ref) rather than the snapshot captured when the effect ran. This
 * prevents a race condition where a fast network refresh repopulates categories
 * between the effect firing and the Promise resolving, causing a valid stored
 * category to be silently discarded.
 *
 * Returns null for missing keys, empty strings, or storage errors.
 */
export async function readRawCategoryFilter(
  storage: StorageLike,
  storageKey: string,
): Promise<string | null> {
  try {
    const stored = await storage.getItem(storageKey);
    return stored || null; // coerce empty string → null
  } catch {
    return null;
  }
}

/**
 * Persist the chosen category to storage.
 *
 * When `cat` is `null` (meaning "All places") the stored key is removed so
 * the next load falls back to null cleanly.
 *
 * Errors are swallowed — this is fire-and-forget; the UI never needs to wait.
 */
export function saveCategoryFilter(
  storage: StorageLike,
  storageKey: string,
  cat: string | null,
): void {
  if (cat !== null) {
    storage.setItem(storageKey, cat).catch(() => {});
  } else {
    storage.removeItem(storageKey).catch(() => {});
  }
}
