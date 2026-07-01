/**
 * Pure helper — AsyncStorage read/write for the Discovery map filter.
 *
 * Extracted from DiscoveryMapView so the persistence logic can be tested
 * without a native runtime or React.
 */

export type MapFilter = 'all' | 'traveler' | 'osm';

export const FILTER_STORAGE_KEY = 'discovery_map_filter';
export const VALID_FILTERS = new Set<string>(['all', 'traveler', 'osm']);

/** Minimal subset of AsyncStorage needed by these helpers. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * Read the saved map filter from storage.
 * Returns 'all' for any missing, invalid, or unreadable value.
 */
export async function loadMapFilter(storage: StorageLike): Promise<MapFilter> {
  try {
    const stored = await storage.getItem(FILTER_STORAGE_KEY);
    if (stored && VALID_FILTERS.has(stored)) {
      return stored as MapFilter;
    }
    return 'all';
  } catch {
    return 'all';
  }
}

/**
 * Persist the chosen filter to storage.
 * Errors are swallowed — this is fire-and-forget.
 */
export function saveMapFilter(storage: StorageLike, filter: MapFilter): void {
  storage.setItem(FILTER_STORAGE_KEY, filter).catch(() => {});
}
