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

export type ZeroStateFailureLane = (typeof ZERO_STATE_LANE)[keyof typeof ZERO_STATE_LANE];

/**
 * Lane R's zero-state PLACE arms (zeroStatePlaces.ts, census §41 / #658): recent,
 * Trip, current-Trip and nearby places. Same rule — never a dispatched search type.
 */
export const ZERO_STATE_PLACE_LANES = ['recent_places', 'trip_places', 'current_trip', 'nearby_places'] as const;
export type ZeroStatePlaceLane = (typeof ZERO_STATE_PLACE_LANES)[number];

/** Every zero-state failure-lane name (both families), for the disjointness guard. */
export const ZERO_STATE_LANES: readonly string[] = [...Object.values(ZERO_STATE_LANE), ...ZERO_STATE_PLACE_LANES];

/**
 * §35 G229 (previousQueries.ts): the viewer's own previous successful searches.
 * Not a zero-state arm (it needs typed text), but a failure lane under the same
 * rule — never a dispatched search type (inputAssistancePreviousQueries.test.ts).
 */
export const PREVIOUS_QUERIES_LANE = 'previous_queries' as const;
