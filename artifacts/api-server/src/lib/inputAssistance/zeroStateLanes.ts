/**
 * The names the empty-field (zero-state) lanes put into a serve's coverage when a
 * read FAILED (VERIFY-D2d F1, VERIFY-D2e F5).
 *
 * None of them may equal a dispatched search type (`DispatchSearchType`, or a
 * `SEARCH_TYPES` value): `gatewayCoverageRefusal` reads "every dispatched type is
 * unreadable" as coverage "nothing", so a zero-state lane named `trips` under a
 * trips-only policy turned a failed Trip zero-state read into "nothing" instead
 * of "partial" (V-ZS). The names follow lane R's zero-state sources
 * (recent_places / trip_places / current_trip / nearby_places). The client reads
 * `failedSources` lane-agnostically.
 */
export const ZERO_STATE_LANE = {
  /** zeroCharGeoDefaults: the viewer's Trip memberships / Trips. */
  trips: 'trip_zero_state',
  /** zeroCharGeoDefaults: the client-supplied current city's canonical row. */
  currentCity: 'current_city_zero_state',
  /** fetchSelectionMemory / buildSelectionRecents: the viewer's recent selections. */
  recents: 'recent_selections',
  /** buildSavedPlaceSuggestions: the viewer's saved places. */
  saved: 'saved_places',
} as const;

export type ZeroStateLane = (typeof ZERO_STATE_LANE)[keyof typeof ZERO_STATE_LANE];

/** Every zero-state failure-lane name, for the disjointness guard. */
export const ZERO_STATE_LANES: readonly ZeroStateLane[] = Object.values(ZERO_STATE_LANE);
