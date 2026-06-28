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
