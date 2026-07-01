/**
 * Pure helper — AsyncStorage read/write for the Discovery map filter.
 *
 * Extracted from DiscoveryMapView so the persistence logic can be tested
 * without a native runtime or React.
 *
 * A module-level memory cache (_memoryCache) allows the component to read the
 * last-saved filter synchronously in its useState lazy initialiser, eliminating
 * the 'all' flash that occurs when Expo Router remounts the screen during tab
 * navigation. The cache is maintained by saveMapFilter / removeMapFilter and
 * populated on the first successful loadMapFilter call.
 */

export type MapFilter = 'all' | 'traveler' | 'osm';

export const FILTER_STORAGE_KEY = 'discovery_map_filter';
export const VALID_FILTERS = new Set<string>(['all', 'traveler', 'osm']);

/** Minimal subset of AsyncStorage needed by these helpers. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

// ── Memory cache ──────────────────────────────────────────────────────────────
// Survives component remounts within the same JS runtime session (e.g. Expo
// Router tab navigation). Reset to null by removeMapFilter (long-press reset).

let _memoryCache: MapFilter | null = null;

/**
 * Return the in-memory cached filter synchronously, or null if not yet loaded.
 * Use as a lazy useState initialiser so remounts start with the correct value.
 */
export function getCachedFilter(): MapFilter | null {
  return _memoryCache;
}

// ── AsyncStorage helpers ───────────────────────────────────────────────────────

/**
 * Read the saved map filter from storage.
 * Returns 'all' for any missing, invalid, or unreadable value.
 * Also updates the in-memory cache when a valid value is found.
 */
export async function loadMapFilter(storage: StorageLike): Promise<MapFilter> {
  try {
    const stored = await storage.getItem(FILTER_STORAGE_KEY);
    if (stored && VALID_FILTERS.has(stored)) {
      _memoryCache = stored as MapFilter;
      return stored as MapFilter;
    }
    return 'all';
  } catch {
    return 'all';
  }
}

/**
 * Persist the chosen filter to storage and update the in-memory cache.
 * Errors are swallowed — this is fire-and-forget.
 */
export function saveMapFilter(storage: StorageLike, filter: MapFilter): void {
  _memoryCache = filter;
  storage.setItem(FILTER_STORAGE_KEY, filter).catch(() => {});
}

/**
 * Clear both the persisted storage value and the in-memory cache.
 * Call this when the user long-presses the active filter to reset to 'all'.
 * Errors are swallowed — fire-and-forget.
 */
export function removeMapFilter(storage: StorageLike): void {
  _memoryCache = null;
  storage.removeItem(FILTER_STORAGE_KEY).catch(() => {});
}
