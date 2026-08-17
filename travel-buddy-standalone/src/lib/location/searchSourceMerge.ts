/**
 * searchSourceMerge — which provider's results the picker shows.
 *
 * ## The blink
 *
 * GlobalPlacePicker merged two providers on every keystroke: Google's
 * autocomplete first, then /places/search backfilling anything Google's top-5
 * did not cover. For venues and addresses that merge is genuinely additive —
 * Foursquare knows places Google's autocomplete does not surface.
 *
 * For CITIES it produced results that blinked. /places/search fans out to
 * Nominatim, which is a geocoder rather than an autocomplete: it matches whole
 * tokens, so a partial city name is answered erratically. Measured against
 * production:
 *
 *     q=Bangkok  type=city → 1 result
 *     q=Bangko   type=city → 7 results
 *     q=bangk    type=city → 0 results
 *     q=Toky     type=city → 2 results
 *
 * Rows therefore appeared, vanished at the next keystroke and returned at the
 * one after. Google's own list stayed stable underneath, so what a user saw was
 * a list that reshuffled while they typed — which reads as "it does not
 * autocomplete" rather than as one provider being unreliable.
 *
 * ## The rule
 *
 * In city mode Google is the source. Nominatim is a FALLBACK that runs only
 * when Google returns nothing, never merged alongside it. A fallback on empty
 * cannot subtract rows that were already on screen, so it cannot blink; a merge
 * can, and did.
 *
 * Outside city mode the merge is unchanged — venues, hotels, landmarks and
 * addresses still benefit from both providers, and Nominatim answers those
 * well because they are usually typed in full or selected from a map.
 *
 * ## Why /places/search is still called in city mode
 *
 * It is the fallback, and it has to be ready the moment Google answers empty —
 * fetching only after that would add a visible delay to the case that is
 * already the worst one. The call is cached server-side for five minutes and
 * costs nothing per request, unlike the Google call, so keeping it warm is
 * cheap. This is a deliberate trade, not an oversight.
 */

/** Minimal shape both providers produce. */
export interface SearchRow {
  id: string;
  displayName: string;
}

export type SearchSource = "google" | "fallback" | "merged";

export interface SourceSelection<T extends SearchRow> {
  /** Which provider(s) the rows came from — drives attribution in the UI. */
  source: SearchSource;
  rows: T[];
  /** True when Google supplied at least one row (attribution must be shown). */
  showGoogleAttribution: boolean;
}

/**
 * Choose the rows to display.
 *
 * `cityMode` is the only thing that changes the rule, and it changes it in one
 * direction: it removes the merge. Nothing here can show fewer rows than the
 * providers returned for a non-city search.
 */
export function selectSearchRows<T extends SearchRow>(opts: {
  googlePlaces: T[];
  searchResults: T[];
  cityMode: boolean;
}): SourceSelection<T> {
  const { googlePlaces, searchResults, cityMode } = opts;

  if (googlePlaces.length === 0) {
    // Google answered nothing — the fallback runs. In city mode this is the
    // ONLY circumstance in which /places/search rows are shown.
    return { source: "fallback", rows: searchResults, showGoogleAttribution: false };
  }

  if (cityMode) {
    // Google is the source. No backfill: merging is what produced the blink.
    return { source: "google", rows: googlePlaces, showGoogleAttribution: true };
  }

  // Venues and addresses: keep the additive merge, de-duplicated by display
  // name so the same place from two providers is not offered twice.
  const seen = new Set(googlePlaces.map((p) => p.displayName.toLowerCase()));
  const backfill = searchResults.filter((p) => !seen.has(p.displayName.toLowerCase()));
  return {
    source: "merged",
    rows: [...googlePlaces, ...backfill],
    showGoogleAttribution: true,
  };
}
