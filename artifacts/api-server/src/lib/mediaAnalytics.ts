/**
 * mediaAnalytics — Fire-and-forget analytics event recording for the Media
 * destination.
 *
 * Design constraints
 * ──────────────────
 * • Async, fire-and-forget: callers NEVER await this — it must not block any
 *   HTTP response.
 * • Safe payloads: private captions, raw coordinates, private entity details,
 *   ranking vectors, fraud internals, and secrets are stripped before write.
 * • Fail-silent: a DB write failure is logged but never surfaced to users.
 * • Gated by MEDIA_ANALYTICS_ENABLED feature flag (fails open = does nothing
 *   when the flag is absent or disabled).
 */

import { isFlagEnabled } from "./featureFlags.js";
import { logger } from "./logger.js";

// ── Event type taxonomy ────────────────────────────────────────────────────────

export type MediaEventType =
  // Feed / mode
  | "mode_switch"
  | "impression"
  | "qualified_view"
  | "completion"
  | "rewatch"
  // Interactions
  | "like"
  | "comment"
  | "save"
  | "share"
  | "profile_open"
  | "place_open"
  | "event_open"
  | "trip_open"
  | "grid_tile_open"
  // Gems
  | "gems_filter_change"
  | "add_to_trip"
  | "directions_tap"
  | "wrong_place_report"
  // Upload / processing
  | "upload_start"
  | "processing_complete"
  | "processing_failure"
  | "playback_failure"
  // §45 north-star outcome transitions — "did this media cause a real-world
  // action", which is what §45 defines success as. Mirrors the client union in
  // travel-buddy-standalone/src/hooks/useMediaAnalytics.ts and the emitter in
  // features/media/telemetry/mediaTelemetry.ts. `media_route`,
  // `media_contribution` and `media_arrival` have no trigger on the action rail
  // yet; they are named here so the surfaces that will emit them reuse the
  // canonical name instead of inventing one.
  | "media_place_open"
  | "media_compass"
  | "media_route"
  | "media_trip_add"
  | "media_plan"
  | "media_contribution"
  | "media_correction"
  | "media_arrival";

/**
 * The eight §45 north-star events, as a runtime list.
 *
 * Exported so the HTTP allow-list (routes/mediaAnalyticsBatch.ts) enumerates
 * the same eight names this type declares, rather than keeping a second hand-
 * written copy that can drift — which is exactly how these events came to be
 * accepted by the client, typed by the server, and dropped by the route.
 */
export const MEDIA_NORTH_STAR_EVENT_TYPES: readonly MediaEventType[] = [
  "media_place_open",
  "media_compass",
  "media_route",
  "media_trip_add",
  "media_plan",
  "media_contribution",
  "media_correction",
  "media_arrival",
];

// ── Safe payload fields (allow-list) ─────────────────────────────────────────

/**
 * Safe fields that may appear in analytics payloads.
 * Any field NOT in this list is stripped before writing.
 */
const ALLOWED_PAYLOAD_KEYS = new Set([
  "media_id",
  "post_id",
  "creator_id",        // pseudonymous user_id — no PII
  "viewer_id",         // pseudonymous user_id — no PII
  "session_id",
  "feed_type",         // "for_you" | "following"
  "mode",              // "watch" | "grid" | "gems"
  "media_type",        // "video" | "photo"
  "watched_ms",
  "completion_fraction",
  "surface",
  "position",
  "place_id",          // non-private entity reference
  "event_id",          // non-private entity reference
  "trip_id",           // non-private entity reference
  "gems_filter",
  // §44/§45 north-star funnel dimensions. Both are coarse and opaque by
  // construction — `action_id` is a fixed action identifier from
  // services/mediaActions.ts ('add_to_trip', 'ask_compass', …) and
  // `entity_kind` is one of 'media' | 'place' | 'trip' | 'gem'. Without them
  // every north-star event collapsed to an undifferentiated row: the funnel
  // could not say WHICH transition fired or what kind of thing it acted on,
  // which is the entire question §45 asks.
  "action_id",
  "entity_kind",
  "from_mode",
  "to_mode",
  "failure_code",
  "failure_reason",    // generic reason only — no raw error messages
  "processing_status",
  "source_type",
  "is_rewatch",
  "ranking_version",   // opaque version string — no vectors
]);

/** Forbidden fields — never included even if they happen to be in the payload */
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  "caption",
  "content",
  "lat",
  "lng",
  "latitude",
  "longitude",
  "raw_coordinates",
  "ranking_vector",
  "fraud_score",
  "spam_score",
  "private_notes",
  "secret",
  "token",
  "password",
  "api_key",
]);

/**
 * Strip any keys that are not in the allow-list or are explicitly forbidden.
 */
function sanitisePayload(raw: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(k)) continue;
    if (!ALLOWED_PAYLOAD_KEYS.has(k)) continue;
    // Allow primitives and null only — no nested objects that could smuggle PII
    if (v !== null && typeof v === "object") continue;
    safe[k] = v;
  }
  return safe;
}

// ── recordMediaEvent ──────────────────────────────────────────────────────────

/**
 * Record a media analytics event to the `media_events` table.
 *
 * This function is deliberately void-returning and fire-and-forget.
 * Pass `sc` (service client) so the write bypasses RLS.
 *
 * @param type     The event type from `MediaEventType`.
 * @param payload  Free-form payload; forbidden / unknown fields are stripped.
 * @param sc       Supabase service client (from getServiceClient()).
 */
export function recordMediaEvent(
  type: MediaEventType,
  payload: Record<string, unknown>,
  sc: any,
): void {
  // Intentionally not awaited — fire and forget
  void (async () => {
    try {
      // Gate on feature flag — fail open (do nothing) when disabled
      const enabled = await isFlagEnabled(sc, "MEDIA_ANALYTICS_ENABLED");
      if (!enabled) return;

      const safePayload = sanitisePayload(payload);

      // supabase-js resolves rather than throws on a DB error — unchecked, a
      // missing/broken media_events table silently dropped every analytics
      // event. Analytics stays fire-and-forget (never surfaces to users), but
      // the failure is now visible in the server log.
      const { error } = await sc.from("media_events").insert({
        event_type:  type,
        payload:     safePayload,
        occurred_at: new Date().toISOString(),
      });
      if (error) {
        logger.warn({ err: error, type }, "recordMediaEvent: media_events insert failed");
      }
    } catch (err) {
      // Fail silent toward users — analytics must never surface errors to them.
      logger.warn({ err, type }, "recordMediaEvent: unexpected error");
    }
  })();
}
