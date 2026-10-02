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
  | "media_arrival" | "visual_opportunity_open" | "gem_open" | "invite_sent" | "experience_complete" | "contribution_submit" | "contribution_accept" | "postcard_create";

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
  "ranking_version", "route_plan_id", "gem_id", "contribution_type", // opaque ids + a coarse enum — no vectors, no text
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

// ── §44 outcome signals (census-media §21) ────────────────────────────────────
//
// Declared at the end of the file so no line above moves (an anchored citation
// points into recordMediaEvent).

/**
 * §44 outcome signals a CLIENT surface emits through the batch endpoint — a
 * viewer opening something from Media. The batch route allow-lists exactly
 * these, spread from this list.
 */
export const MEDIA_CLIENT_OUTCOME_SIGNAL_TYPES: readonly MediaEventType[] = [
  "visual_opportunity_open", // §44 Visual opportunity opened
  "gem_open", //                §44 Hidden Gem opened
];

/**
 * §44 outcome signals only the SERVER emits, at the moment the outcome is
 * committed (an invite written, a contribution recorded or accepted, a Postcard
 * or Memory created, an experience completed). DELIBERATELY NOT on the batch
 * allow-list: a client could otherwise claim an outcome that never happened,
 * and these are the events the funnel is supposed to be able to trust.
 */
export const MEDIA_SERVER_OUTCOME_SIGNAL_TYPES: readonly MediaEventType[] = [
  "invite_sent",
  "experience_complete",
  "contribution_submit",
  "contribution_accept",
  "postcard_create",
];

/** The §45 transitions that make an arrival or a completion ATTRIBUTABLE to Media. */
export const MEDIA_ORIGIN_EVENT_TYPES: readonly MediaEventType[] = [
  "media_place_open",
  "media_route",
  "media_trip_add",
  "media_plan",
  "media_compass",
  "directions_tap",
];

/** How long a media-originated action can explain a later arrival. */
export const MEDIA_ATTRIBUTION_WINDOW_MS = 30 * 86_400_000;

export interface MediaOrigin {
  mediaId: string | null;
  placeId: string | null;
}

/**
 * Did one of THIS viewer's own media-originated actions lead here? Reads the
 * viewer's own §45 events for the place (or the route plan) within the
 * attribution window. Returns null when nothing attributes — or when the read
 * fails: an unreadable history is not evidence of an origin.
 */
export async function findMediaOrigin(
  sc: any,
  q: { userId: string; placeId?: string | null; routePlanId?: string | null; nowMs?: number },
): Promise<MediaOrigin | null> {
  if (!q.userId || (!q.placeId && !q.routePlanId)) return null;
  try {
    let query = sc
      .from("media_events")
      .select("event_type, payload, occurred_at")
      .in("event_type", [...MEDIA_ORIGIN_EVENT_TYPES])
      .eq("payload->>viewer_id", q.userId)
      .gte("occurred_at", new Date((q.nowMs ?? Date.now()) - MEDIA_ATTRIBUTION_WINDOW_MS).toISOString());
    query = q.routePlanId ? query.eq("payload->>route_plan_id", q.routePlanId) : query.eq("payload->>place_id", q.placeId);
    const { data, error } = await query.order("occurred_at", { ascending: false }).limit(1);
    if (error || !Array.isArray(data) || data.length === 0) return null;
    const p = (data[0] as any)?.payload ?? {};
    return {
      mediaId: typeof p.media_id === "string" ? p.media_id : null,
      placeId: typeof p.place_id === "string" ? p.place_id : (q.placeId ?? null),
    };
  } catch {
    return null;
  }
}

/**
 * §26 "Arrived … where safely measurable" / §45 "Media → Real-World Arrival".
 * Called ONLY from a check-in the traveller made themselves — a GPS-verified
 * gem visit, a route stop marked arrived — never from background location, and
 * recorded only when one of their own media-originated actions explains it.
 * Fire-and-forget like every media event.
 */
export function recordMediaArrivalIfAttributable(
  sc: any,
  q: { userId: string; placeId?: string | null; routePlanId?: string | null; gemId?: string | null; source: string },
): void {
  void (async () => {
    const origin = await findMediaOrigin(sc, q);
    if (!origin) return;
    recordMediaEvent("media_arrival", {
      viewer_id: q.userId,
      media_id: origin.mediaId,
      place_id: origin.placeId,
      route_plan_id: q.routePlanId ?? null,
      gem_id: q.gemId ?? null,
      surface: q.source,
    }, sc);
  })().catch(() => {});
}

/**
 * §44 "Contribution submitted" — a §16.1 gem submission or a §16.3 gem
 * observation (Hidden Gems are Media architecture, §16). Recorded by the route
 * at the moment the contribution is written. §45 "Media → Contribution" is
 * recorded as well ONLY when the contributor acted from a media item
 * (`originMediaId`) and that media is actually AT the gem's place — a media id
 * that has nothing to do with the gem attributes nothing.
 */
export function recordGemContributionSignal(
  sc: any,
  q: { userId: string; gemId: string; kind: string; originMediaId?: string | null },
): void {
  recordMediaEvent("contribution_submit", {
    viewer_id: q.userId, gem_id: q.gemId, contribution_type: q.kind, surface: "hidden_gems",
  }, sc);
  if (!q.originMediaId) return;
  void (async () => {
    const [{ data: gem, error: gErr }, { data: post, error: pErr }] = await Promise.all([
      sc.from("hidden_gems").select("id, canonical_place_id").eq("id", q.gemId).maybeSingle(),
      sc.from("posts").select("id, canonical_place_id, status").eq("id", q.originMediaId).maybeSingle(),
    ]);
    if (gErr || pErr || !gem || !post || (post as any).status !== "active") return;
    const place = (gem as any).canonical_place_id;
    if (!place || (post as any).canonical_place_id !== place) return;
    recordMediaEvent("media_contribution", {
      viewer_id: q.userId, gem_id: q.gemId, media_id: q.originMediaId, place_id: place,
      contribution_type: q.kind, surface: "hidden_gems",
    }, sc);
  })().catch(() => {});
}

/**
 * §44 "Contribution … accepted": an admin APPROVED a submitted gem. Attributed
 * to the SUBMITTER — it is their contribution that was accepted — never to the
 * admin who approved it.
 */
export function recordGemAcceptedSignal(sc: any, q: { submitterId: string; gemId: string }): void {
  recordMediaEvent("contribution_accept", {
    viewer_id: q.submitterId, gem_id: q.gemId, contribution_type: "gem_submission", surface: "hidden_gems",
  }, sc);
}

/**
 * A GPS-verified, NON-suspicious gem visit (the only kind the route passes in)
 * is a safely-measured arrival; it is a MEDIA arrival when the visitor's own
 * media-originated action at the gem's canonical place explains it.
 */
export function recordGemArrivalIfAttributable(sc: any, q: { userId: string; gemId: string }): void {
  void (async () => {
    const { data: gem, error } = await sc.from("hidden_gems").select("id, canonical_place_id").eq("id", q.gemId).maybeSingle();
    if (error || !gem || !(gem as any).canonical_place_id) return;
    recordMediaArrivalIfAttributable(sc, {
      userId: q.userId, placeId: String((gem as any).canonical_place_id), gemId: q.gemId, source: "gem_visit",
    });
  })().catch(() => {});
}

/**
 * §44 "Invite sent" — written by the Shared Moments invite route when the
 * invite was sent FROM a media item (`originMediaId`) that is an APPROVED
 * contribution to that very Moment. Any other media id attributes nothing.
 */
export function recordMediaInviteIfAttributable(
  sc: any,
  q: { inviterId: string; momentId: string; originMediaId?: string | null },
): void {
  if (!q.originMediaId) return;
  void (async () => {
    const { data, error } = await sc
      .from("shared_moment_contributions")
      .select("moment_id, post_id, status")
      .eq("moment_id", q.momentId)
      .eq("post_id", q.originMediaId)
      .eq("status", "approved")
      .maybeSingle();
    if (error || !data) return;
    recordMediaEvent("invite_sent", { viewer_id: q.inviterId, media_id: q.originMediaId, action_id: "invite_people", surface: "shared_moment" }, sc);
  })().catch(() => {});
}

/**
 * §44 "Memory / Postcard created" — recorded by the Postcard writer at the
 * moment the passport_postcards row is written. A Postcard IS a posts row, so
 * its id is the media id: this is media becoming Passport's narrative (§29).
 * The Memory half has NO producer and no name: a Memory is created without
 * media (POST /memories takes none), so a creation event there would not be a
 * media outcome, and a name with no producer is only a name.
 */
export function recordPostcardCreatedSignal(sc: any, q: { userId: string; postId: string }): void {
  recordMediaEvent("postcard_create", { viewer_id: q.userId, media_id: q.postId, post_id: q.postId, surface: "passport" }, sc);
}

/**
 * §44 "Experience completed": a route the viewer saved FROM MEDIA (its
 * `media_route` event carries the route plan id) was completed.
 */
export function recordExperienceCompletionIfAttributable(
  sc: any,
  q: { userId: string; routePlanId: string },
): void {
  void (async () => {
    const origin = await findMediaOrigin(sc, q);
    if (!origin) return;
    recordMediaEvent("experience_complete", {
      viewer_id: q.userId,
      media_id: origin.mediaId,
      route_plan_id: q.routePlanId,
      surface: "route_plan",
    }, sc);
  })().catch(() => {});
}
