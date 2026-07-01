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
