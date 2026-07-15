/**
 * Pure handler for non-Nearest sort chips (rating, popular, …) in FilterStrip.
 *
 * Kept in a zero-React-Native-import file so it can be tested directly with
 * `node --import tsx/esm --test` without pulling in the full RN module graph.
 *
 * Unlike the Nearest chip there is no location guard here — pressing "rating"
 * or "popular" always propagates to onChange.  This file exists so that any
 * future rearrangement of the FilterStrip branch logic cannot accidentally
 * pull the Nearest guard into these chips (the test suite catches that).
 */

export interface SortChipFilters {
  radiusKm: number;
  openNow: boolean;
  minRating: number | null;
  sortBy?: string | null;
}

/**
 * Handle a tap on a non-Nearest sort chip (e.g. "rating" or "popular").
 *
 * Behaviour:
 * - When the chip is not yet active, sets `sortBy` to `key`.
 * - When the chip is already active (toggle-off), sets `sortBy` to null.
 * - Always calls `onChange` — there is no location guard for these chips.
 *
 * @param key      - the sort key for this chip (e.g. "rating", "popular")
 * @param isActive - true when this chip is the current active sort
 * @param filters  - the current filter state
 * @param onChange - called with the updated filters
 */
export function handleSortChipPress(
  key: string,
  isActive: boolean,
  filters: SortChipFilters,
  onChange: (f: SortChipFilters) => void,
): void {
  onChange({ ...filters, sortBy: isActive ? null : key });
}
