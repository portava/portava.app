/**
 * Pure helper — AsyncStorage read/write for the LocationCheckSheet view mode
 * (map vs list) preference, keyed per tripId.
 *
 * Follows the same pattern as savedPlacesMapFilterStorage.ts so the
 * persistence logic is testable without a native runtime or React.
 */

/** Storage key prefix — the full key is prefix + tripId. */
export const VIEW_MODE_STORAGE_PREFIX = 'location_check_view_mode_v1_';

export type ViewMode = 'map' | 'list';

/** Valid view mode values. */
const VALID_MODES: ViewMode[] = ['map', 'list'];

/** Minimal subset of AsyncStorage needed by these helpers. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Build the per-trip storage key from a tripId. */
export function viewModeStorageKey(tripId: string): string {
  return `${VIEW_MODE_STORAGE_PREFIX}${tripId}`;
}

/**
 * Read the saved view mode preference from storage.
 *
 * Returns the stored value when it is a recognised ViewMode; falls back to
 * `'map'` for missing keys, unknown values, or storage errors.
 */
export async function loadViewMode(
  storage: StorageLike,
  tripId: string,
): Promise<ViewMode> {
  try {
    const stored = await storage.getItem(viewModeStorageKey(tripId));
    if (stored && (VALID_MODES as string[]).includes(stored)) {
      return stored as ViewMode;
    }
    return 'map';
  } catch {
    return 'map';
  }
}

/**
 * Persist the chosen view mode to storage.
 *
 * Errors are swallowed — this is fire-and-forget; the UI never needs to wait.
 */
export function saveViewMode(
  storage: StorageLike,
  tripId: string,
  mode: ViewMode,
): void {
  storage.setItem(viewModeStorageKey(tripId), mode).catch(() => {});
}
