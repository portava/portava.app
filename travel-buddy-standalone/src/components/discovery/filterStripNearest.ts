/**
 * Pure guard logic for the Nearest sort chip in FilterStrip.
 *
 * Kept in a zero-React-Native-import file so it can be tested directly with
 * `node --import tsx/esm --test` without pulling in the full RN module graph.
 */

export interface NearestPressFilters {
  radiusKm: number;
  openNow: boolean;
  minRating: number | null;
  sortBy?: string | null;
}

/**
 * Handle a tap on the Nearest sort chip.
 *
 * When `hasUserLocation` is false the user has no real GPS coordinates and we
 * must NOT propagate the sort change — doing so would silently sort by the
 * destination-centre coordinates and produce wrong ordering.  Instead we call
 * `onNearestUnavailable` so the parent can request a permission or explain why
 * location is unavailable.
 *
 * @param hasUserLocation - true when real GPS coords are available
 * @param isActive        - true when 'nearest' is the current active sort
 * @param filters         - the current filter state
 * @param onChange        - called with the updated filters when the press is allowed
 * @param onNearestUnavailable - called (if provided) when the press is blocked
 */
export function handleNearestChipPress(
  hasUserLocation: boolean,
  isActive: boolean,
  filters: NearestPressFilters,
  onChange: (f: NearestPressFilters) => void,
  onNearestUnavailable?: () => void,
): void {
  if (!hasUserLocation) {
    onNearestUnavailable?.();
    return;
  }
  onChange({ ...filters, sortBy: isActive ? null : 'nearest' });
}
