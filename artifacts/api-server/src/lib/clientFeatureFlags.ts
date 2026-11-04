/**
 * The flags GET /api/feature-flags serves: the ones a client actually reads
 * (sec/public-surface, 2026-11-04).
 *
 * The endpoint is public (FeatureFlagsContext fetches it before sign-in, with no
 * token) and used to return EVERY row of feature_flags: each disable_* kill
 * switch and whether it was engaged, every server-only gate, every unreleased
 * feature's name. None of that changes what a client does, and all of it tells
 * an outsider what the operator is switching and what is coming.
 *
 * DERIVED, NOT CHOSEN. Each name below is read by the app tree
 * (travel-buddy-standalone, the only client of this endpoint in the repository
 * besides the beta smoke check) in one of the ways
 * src/test/clientFeatureFlagsAllowlist.test.ts scans for:
 *   - FeatureFlagsContext's readers, isEnabled / isLivePlacesEnabled, or a name
 *     they are destructured to, called with a literal, a const or a const-object
 *     member;
 *   - a flag-carrying property (featureFlag / flagKey / flagName / requiresFlag)
 *     in a route or mode table;
 *   - a direct read of the response body, flags['…'] (useCircleFlag,
 *     useRentABuddyFlag);
 * plus every Live Places parent of a listed child (LIVE_PLACES_REQUIREMENTS),
 * because FeatureFlagsContext re-checks the parents on the device.
 *
 * That test FAILS when the app reads a name this list lacks (a new screen would
 * otherwise read `false` for ever, silently), when a reader's argument cannot be
 * resolved and is not declared, and when a name here is read by nothing (stale).
 * So the list moves only together with the app.
 *
 * Kill switches: the app reads none of the disable_* stops through this
 * endpoint (each is enforced on the server, and the refusal names its gate), so
 * none is listed. A stop the app must honour on the device would be read by the
 * app, and the test would require it here.
 */
export const CLIENT_FEATURE_FLAGS: readonly string[] = [
  // Media
  "MEDIA_FOLLOWING_ENABLED",
  "MEDIA_HIDDEN_GEMS_CREATE_ENABLED",
  "MEDIA_HIDDEN_GEMS_NEARBY_ENABLED",
  "MEDIA_TAB_ENABLED",
  "MEDIA_TAB_WORLD_DEFAULT_ENABLED",
  "MEDIA_UPLOAD_ENABLED",
  "MEDIA_UPLOAD_PHOTO_ENABLED",
  "MEDIA_UPLOAD_VIDEO_ENABLED",
  "MEDIA_VIEW_MODE_FULLSCREEN_ENABLED",
  "MEDIA_VIEW_MODE_GRID_ENABLED",
  "MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED",
  "MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED",
  "MEDIA_WATCH_TAP_TO_PLAY_ENABLED",
  "MEDIA_WORLD_SHELL_ENABLED",
  "media_captions_enabled",
  "media_dubbing_enabled",
  "media_neighborhood_only_mode_enabled",
  "media_perspective_vantage_enabled",
  "media_request_a_view_enabled",
  "media_transcoder_enabled",
  "memory_from_own_media_enabled",
  // AI visuals and writing
  "ai_event_auto_suggest_enabled",
  "ai_event_headers_enabled",
  "ai_place_headers_enabled",
  "ai_visual_provider_enabled",
  "compass_ai_writing_enabled",
  // Discovery
  "discovery_dwell_telemetry_enabled",
  "discovery_for_you_pde_enabled",
  "discovery_live_rank_enabled",
  "discovery_output_kinds_enabled",
  "discovery_trend_lists_enabled",
  "discovery_trending_api_enabled",
  "trail_creation_enabled",
  // Live Places (the parents are re-checked on the device)
  "external_places_enabled",
  "live_places_enabled",
  "place_days_enabled",
  "place_recaps_enabled",
  "shared_moments_enabled",
  // Map and intel
  "intel_capture_quick_signal",
  "intel_live_label_crowd",
  "intel_trail_followup",
  "locate_friends_enabled",
  "map_contributions_enabled",
  "map_search_enabled",
  // Events, trips, input
  "event_start_transition_enabled",
  "input_structured_values_enabled",
  "reservation_import_enabled",
  "trip_kernel_enabled",
  // Passport and stamps
  "memory_recaps",
  "passport_event_share_enabled",
  "passport_travel_dna_enabled",
  "stamp_admire_enabled",
  "stamp_showcase_enabled",
  // Social
  "find_your_circle_enabled",
  "rent_buddy_enabled",
  "telegraph_link_previews_enabled",
  "wall_enabled",
];

const CLIENT_FEATURE_FLAG_SET: ReadonlySet<string> = new Set(CLIENT_FEATURE_FLAGS);

export function isClientFeatureFlag(flag: string): boolean {
  return CLIENT_FEATURE_FLAG_SET.has(flag);
}

/** Keep only the client-facing flags of an already resolved flag map. */
export function clientFeatureFlags(resolved: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [flag, enabled] of Object.entries(resolved)) {
    if (CLIENT_FEATURE_FLAG_SET.has(flag)) out[flag] = enabled;
  }
  return out;
}
