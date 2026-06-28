/**
 * Pure helper functions extracted from SavedPlacesMapView so they can be
 * unit-tested without a React Native / MapLibre render environment.
 */
import type { BookmarkedPlace } from '../services/discoveryBookmarks';

/** [west, south, east, north] — same shape as MapLibre's LngLatBounds */
export type BoundsRect = [number, number, number, number];

/**
 * Sentinel value used as the activeCategory key for places that have no
 * category label (null / empty string).  Never displayed verbatim —
 * CategoryChips renders it as "Uncategorized".
 */
export const UNCATEGORIZED = '__uncategorized__';

/**
 * Return the subset of places that have non-null lat AND lng coordinates.
 * Only mappable places are ever rendered as pins on the map.
 */
export function filterMappable(places: BookmarkedPlace[]): BookmarkedPlace[] {
  return places.filter((p) => p.lat != null && p.lng != null);
}

/**
 * Derive unique category labels from an already-coordinate-filtered list.
 *
 * Named categories are sorted alphabetically.  If any place has a null/empty
 * category the UNCATEGORIZED sentinel is appended at the end so users can
 * filter to uncategorized pins without losing them in the "All" view.
 *
 * Callers are expected to pass `filterMappable` output so that coord-less
 * places never contribute a category that would yield zero pins.
 */
export function uniqueCategories(places: BookmarkedPlace[]): string[] {
  const seen = new Set<string>();
  let hasUncategorized = false;
  for (const p of places) {
    const cat = (p.category ?? '').trim();
    if (cat) {
      seen.add(cat);
    } else {
      hasUncategorized = true;
    }
  }
  const sorted = [...seen].sort();
  if (hasUncategorized) sorted.push(UNCATEGORIZED);
  return sorted;
}

/**
 * Should the CategoryChips row be rendered?
 * Chips only add value when there are 2+ distinct categories.
 */
export function shouldShowChips(categories: string[]): boolean {
  return categories.length >= 2;
}

/**
 * Apply an active category filter to the mappable place list.
 * - null  → all places visible
 * - UNCATEGORIZED sentinel → places with empty/null category
 * - any other string → exact category match
 */
export function filterVisible(
  mappable: BookmarkedPlace[],
  activeCategory: string | null,
): BookmarkedPlace[] {
  if (activeCategory === null) return mappable;
  if (activeCategory === UNCATEGORIZED) {
    return mappable.filter((p) => !(p.category ?? '').trim());
  }
  return mappable.filter((p) => p.category === activeCategory);
}

/**
 * Determine the effective active-category after reading from storage or after
 * the place list changes.
 *
 * Returns `stored` when it is a non-empty string that exists in `categories`;
 * returns `null` in every other case (null input, empty string, stale key).
 *
 * This is the single pure decision used by both:
 *   1. The mount-restore effect — resolves the AsyncStorage value against the
 *      current category list before setting state.
 *   2. The stale-category effect — resets to null when the active category has
 *      been removed from the list (e.g. last place of that type deleted).
 */
export function resolveStoredCategory(
  stored: string | null,
  categories: string[],
): string | null {
  if (!stored) return null;
  return categories.includes(stored) ? stored : null;
}

/**
 * Count how many mappable pins belong to each category key.
 *
 * Named categories are keyed by their trimmed label.
 * Places with a null/empty category are keyed by the UNCATEGORIZED sentinel.
 * The returned record covers every key that `uniqueCategories` would produce,
 * so chip rendering can do a simple `counts[key] ?? 0` lookup.
 */
export function categoryCounts(
  mappable: BookmarkedPlace[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of mappable) {
    const cat = (p.category ?? '').trim();
    const key = cat || UNCATEGORIZED;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Category keywords for each non-Places tab on the Saved screen.
 * Case-insensitive substring match against `BookmarkedPlace.category`.
 * Exported so callers (saved.tsx) and tests share the same mapping.
 */
export const TAB_CATEGORIES: Record<string, string[]> = {
  Hotels:      ['hotel', 'hostel', 'motel', 'resort', 'inn', 'accommodation', 'lodging', 'guesthouse'],
  Nightlife:   ['bar', 'pub', 'nightclub', 'nightlife', 'lounge', 'club', 'disco', 'karaoke'],
  Itineraries: ['museum', 'attraction', 'tour', 'landmark', 'gallery', 'park', 'monument', 'temple', 'castle', 'historic'],
};

/**
 * Filter places for a given Saved screen tab.
 * - 'Places' is the catch-all — returns the full list unchanged.
 * - Other tabs return places whose category contains any of the tab's keywords
 *   (case-insensitive substring match).
 * - Unknown tab names (no entry in TAB_CATEGORIES) fall back to all places.
 */
export function placesForTab(
  tabName: string,
  places: BookmarkedPlace[],
): BookmarkedPlace[] {
  if (tabName === 'Places') return places;
  const keywords = TAB_CATEGORIES[tabName];
  if (!keywords || keywords.length === 0) return places;
  return places.filter((p) =>
    keywords.some((k) => (p.category ?? '').toLowerCase().includes(k))
  );
}

/**
 * Determine the effective selectedId after the visible list changes.
 *
 * Returns `selectedId` when it still refers to a place that exists in
 * `visible`; returns `null` in every other case (null input, or the place
 * was removed / filtered out).
 *
 * This is the single pure decision used by the selection-sync effect so
 * `selectedId` is always cleared in the same render cycle that drops the pin.
 */
export function resolveSelectedId(
  selectedId: string | null,
  visible: BookmarkedPlace[],
): string | null {
  if (selectedId === null) return null;
  return visible.some((p) => p.id === selectedId) ? selectedId : null;
}

/**
 * Should the "No pins in this category" overlay be shown?
 */
export function shouldShowNoPinsOverlay(
  activeCategory: string | null,
  visibleCount: number,
): boolean {
  return activeCategory !== null && visibleCount === 0;
}

/**
 * Compute a bounding box [west, south, east, north] with a small padding margin
 * so that pins are never clipped at the viewport edge.
 *
 * Returns null when the list is empty (caller should skip fitBounds).
 */
export function computeBounds(places: BookmarkedPlace[]): BoundsRect | null {
  const withCoords = places.filter((p) => p.lat != null && p.lng != null);
  if (withCoords.length === 0) return null;
  const lngs = withCoords.map((p) => p.lng!);
  const lats = withCoords.map((p) => p.lat!);
  const west  = Math.min(...lngs);
  const east  = Math.max(...lngs);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const dLng = Math.max(east - west, 0.01) * 0.3;
  const dLat = Math.max(north - south, 0.01) * 0.3;
  return [west - dLng, south - dLat, east + dLng, north + dLat];
}
