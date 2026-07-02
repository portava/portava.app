/**
 * Pure helper — AsyncStorage read/write for Discovery filter preferences
 * (radiusKm, openNow, minRating, sortBy).
 *
 * Extracted from discovery.tsx so the persistence logic can be tested
 * without a native runtime or React.
 *
 * A module-level memory cache (_memoryCache) lets the screen read the
 * last-saved filters synchronously in its useState lazy initialiser,
 * eliminating the "defaults flash" that occurs when Expo Router remounts
 * the screen during tab navigation.
 */
import type { DiscoveryFilters } from '../../services/discovery';

export const FILTER_STORAGE_KEY = 'discovery_filters';

const DEFAULT_FILTERS: DiscoveryFilters = { radiusKm: 10, openNow: false, minRating: null };

/** Minimal subset of AsyncStorage needed by these helpers. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

// ── Memory cache ──────────────────────────────────────────────────────────────
// Survives component remounts within the same JS runtime session (e.g. Expo
// Router tab navigation). Reset to null by removeDiscoveryFilters.

let _memoryCache: DiscoveryFilters | null = null;

/**
 * Return the in-memory cached filters synchronously, or null if not yet loaded.
 * Use as a lazy useState initialiser so remounts start with the correct value
 * without waiting for an async read.
 */
export function getCachedFilters(): DiscoveryFilters | null {
  return _memoryCache;
}

// ── Validation ────────────────────────────────────────────────────────────────

function isValidFilters(v: unknown): v is DiscoveryFilters {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.radiusKm === 'number' &&
    typeof f.openNow === 'boolean' &&
    (f.minRating === null || typeof f.minRating === 'number') &&
    (f.sortBy === undefined || f.sortBy === null || f.sortBy === 'rating')
  );
}

// ── AsyncStorage helpers ───────────────────────────────────────────────────────

/**
 * Read the saved discovery filters from storage.
 * Returns DEFAULT_FILTERS for any missing, invalid, or unreadable value.
 * Also updates the in-memory cache when a valid value is found.
 */
export async function loadDiscoveryFilters(storage: StorageLike): Promise<DiscoveryFilters> {
  try {
    const stored = await storage.getItem(FILTER_STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (isValidFilters(parsed)) {
        _memoryCache = parsed;
        return parsed;
      }
    }
    return DEFAULT_FILTERS;
  } catch {
    return DEFAULT_FILTERS;
  }
}

/**
 * Persist the chosen filters to storage and update the in-memory cache.
 * Errors are swallowed — this is fire-and-forget.
 */
export function saveDiscoveryFilters(storage: StorageLike, filters: DiscoveryFilters): void {
  _memoryCache = filters;
  storage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters)).catch(() => {});
}

/**
 * Clear both the persisted storage value and the in-memory cache.
 * Call this when the user explicitly resets Discovery filters to defaults.
 * Errors are swallowed — fire-and-forget.
 */
export function removeDiscoveryFilters(storage: StorageLike): void {
  _memoryCache = null;
  storage.removeItem(FILTER_STORAGE_KEY).catch(() => {});
}
