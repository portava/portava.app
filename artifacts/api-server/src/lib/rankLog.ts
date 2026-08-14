/**
 * rankLog — fire-and-forget impression logger for the Portava rank_events table.
 *
 * Spec §7: every rankCandidates() call in Pulse, Discovery, and Events must log
 * one `impression` row per served item so the outcome funnel
 * (impression → tap → save/join/rsvp → attended) can be reconstructed for
 * fitting v2 weights.
 *
 * Spec §8 privacy rule: precise GPS coordinates must never be stored.  This
 * module strips any `distanceKm`-adjacent raw-coordinate keys from features
 * before insert.  The computed scalar `distance` feature (already a float
 * 0–1 produced by the distance kernel) is safe and is retained.
 */

import { randomUUID } from "node:crypto";
import { getServiceClient } from "./supabase";
import { LIVE_PULSE_SERVE_EVENT } from "../services/ranking/rankingAnalytics.js";
import type { ScoredCandidate, RankCandidate } from "./portavaRank";

// ── Fatigue tracking ──────────────────────────────────────────────────────────
// Fire-and-forget upsert into viewer_creator_fatigue for impression batches.
// Gated by the CREATOR_FATIGUE_ENABLED feature flag (fail-open: skipped when flag
// is unreachable). Deduplicates creator IDs within each batch (batch-at-most-once
// per session per creator) to avoid write amplification.

let _fatigueFlagCachedAt   = 0;
let _fatigueFlagEnabled    = false;
const FATIGUE_FLAG_TTL_MS  = 60_000; // 60 s TTL matching rankingConfig cache

async function isFatigueEnabled(sc: any): Promise<boolean> {
  if (Date.now() - _fatigueFlagCachedAt < FATIGUE_FLAG_TTL_MS) return _fatigueFlagEnabled;
  try {
    const { data } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "CREATOR_FATIGUE_ENABLED")
      .maybeSingle();
    _fatigueFlagEnabled  = Boolean((data as any)?.enabled);
    _fatigueFlagCachedAt = Date.now();
  } catch { /* fail-open: keep previous value */ }
  return _fatigueFlagEnabled;
}

function upsertCreatorFatigueAsync(
  sc:         any,
  viewerId:   string,
  creatorIds: string[],
): void {
  const unique = [...new Set(creatorIds.filter(Boolean))];
  if (unique.length === 0) return;
  // Validate UUIDs — the RPC parameter is UUID[]; non-UUID OSM IDs must be filtered.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidIds = unique.filter((id) => UUID_RE.test(id));
  if (uuidIds.length === 0) return;

  void sc
    .rpc("increment_creator_fatigue_batch", {
      p_viewer_id:  viewerId,
      p_creator_ids: uuidIds,
    })
    .then(() => {}, () => {});
}

/** Feature keys that carry or could carry raw GPS coordinates — strip on log. */
const COORDINATE_KEYS = new Set(["lat", "lng", "latitude", "longitude", "distanceKm"]);

function stripCoordinateKeys(features: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(features)) {
    if (!COORDINATE_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Bulk-insert one `impression` row per scored candidate into `rank_events`.
 *
 * Fire-and-forget: call without `await` so a logging failure never blocks a
 * feed response.  All errors are swallowed silently.
 *
 * @param scored    Output of rankCandidates() — position is inferred from array order.
 * @param userId    Authenticated viewer.
 * @param surface   "pulse" | "discovery" | "events"
 * @param sessionId Optional session UUID for grouping a single open.
 * @param extraFeatures
 *   Merged into each row's `features` alongside the ranking features. Added for
 *   Stage 0 discovery instrumentation, which records which serve point answered
 *   the request. Callers that log through lib/discoveryServeLog.ts must NOT also
 *   call this function for the same serve — one impression row per served item.
 */
export async function logImpression(
  scored: ScoredCandidate<RankCandidate>[],
  userId: string,
  surface: "pulse" | "discovery" | "events",
  sessionId?: string,
  extraFeatures?: Record<string, string | number | boolean>,
): Promise<void> {
  try {
    const sc = getServiceClient();
    if (!sc || scored.length === 0) return;

    const servedAt = new Date().toISOString();
    // Generate one fallback session UUID for the whole batch so every row from
    // this invocation shares the same session_id — mirrors the "single open"
    // semantics callers rely on for funnel reconstruction.
    const effectiveSessionId = sessionId ?? randomUUID();

    const rows = scored.map((s, idx) => {
      const kind = s.candidate.kind;
      // Map CandidateKind → item_kind enum (collapse aliases)
      const itemKind: string =
        kind === "postcard" ? "post" :
        kind === "traveler" ? "buddy" :
        kind === "trip"     ? "plan" :
        kind;

      return {
        user_id:    userId,
        item_id:    s.candidate.id,
        item_kind:  itemKind,
        position:   idx,
        features:   { ...stripCoordinateKeys(s.features), ...(extraFeatures ?? {}) },
        outcome:    "impression",
        served_at:  servedAt,
        surface,
        session_id: effectiveSessionId,
      };
    });

    await sc.from("rank_events").insert(rows);

    // Fatigue tracking — fire-and-forget, gated by feature flag
    const fatigueEnabled = await isFatigueEnabled(sc).catch(() => false);
    if (fatigueEnabled) {
      const creatorIds = scored
        .map((s) => s.candidate.authorId as string | null | undefined)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      upsertCreatorFatigueAsync(sc, userId, creatorIds);
    }
  } catch {
    // Silent swallow — logging must never break the feed
  }
}

/**
 * Maps raw Compass item.type strings to the item_kind values allowed by the
 * rank_events CHECK constraint ('post','event','plan','buddy','place','gem').
 *
 * Types absent from this map (e.g. 'safety_tip', 'language_tip') are static
 * appended items, not ML-ranked candidates — they are filtered out before
 * insert so they never cause a constraint violation.
 */
const COMPASS_ITEM_KIND: Record<string, string> = {
  event:    "event",
  post:     "post",
  postcard: "post",     // Compass alias for post
  plan:     "plan",
  trip:     "plan",     // Compass alias for plan
  buddy:    "buddy",
  traveler: "buddy",    // Compass alias for buddy
  place:    "place",
  gem:      "gem",
};

/**
 * Log Compass recommendation impressions into rank_events.
 *
 * Accepts the lighter-weight Compass item shape (id + type) rather than the
 * full ScoredCandidate used by the portavaRank pipeline.  item.type values are
 * normalised to the schema-valid item_kind set; static items without a mapping
 * (safety_tip, language_tip, …) are silently skipped.
 *
 * Calls rank_events.insert unconditionally (even when all items are filtered
 * out) so that fire-and-forget behaviour can be verified in timing tests.
 *
 * Fire-and-forget: call without `await` so a logging failure never blocks the
 * recommendations response.  All errors are swallowed silently.
 *
 * @param items     Served recommendations — id + type from the Compass feed.
 * @param userId    Authenticated viewer.
 * @param sessionId Optional session UUID for grouping a single open.
 */
export async function logCompassImpression(
  items: Array<{ id: string; type: string }>,
  userId: string,
  sessionId?: string,
): Promise<void> {
  try {
    const sc = getServiceClient();
    if (!sc) return;

    const servedAt = new Date().toISOString();

    const rows = items.flatMap((item, idx) => {
      const itemKind = COMPASS_ITEM_KIND[item.type];
      if (!itemKind) return []; // static / unknown type — skip
      return [{
        user_id:    userId,
        item_id:    item.id,
        item_kind:  itemKind,
        position:   idx,
        features:   {},
        outcome:    "impression",
        served_at:  servedAt,
        surface:    "compass",
        session_id: sessionId ?? null,
      }];
    });

    await sc.from("rank_events").insert(rows);
  } catch {
    // Silent swallow — logging must never break the feed
  }
}

// ── Live Pulse serve logging ──────────────────────────────────────────────────
//
// Live Pulse (GET /api/pulse/live) assembles its rail by *urgency*, not by the
// ranker.  There is no ScoredCandidate and no feature vector, so logImpression
// must never be used for it and features must never be fabricated.  What these
// rows do record is a true fact: the item was served to the viewer at this
// position on the Live Pulse rail.
//
// They are written as outcome='impression' + surface='live_pulse'.  The surface
// value is the load-bearing part.  The outcome funnel in routes/rankEvents.ts
// resolves an outcome to an impression with
//
//   .eq("user_id").eq("item_id").eq("surface").eq("outcome","impression")
//   .order("served_at", desc).limit(1)      [ + .eq("session_id") IF sent ]
//
// so writing these rows on surface='pulse' — the ranked /pulse writer's key
// space, with the same canonical entity ids — made the newer Live Pulse row
// steal outcomes belonging to genuine ranked impressions.  session_id does not
// fix that: the filter is skipped entirely whenever the client omits it, so the
// hijack would persist permanently, not just during rollout.  A separate
// surface is a separate key space, so the collision cannot occur at all and the
// ranked corpus is untouched.  session_id is still written and still narrows
// the match when the client echoes it — belt and braces, not the mechanism.
//
// REQUIRES migration 0199_rank_events_live_pulse_surface.sql to be applied LIVE
// before this code ships.  rank_events.surface carries a CHECK constraint and
// this insert is fire-and-forget (see logLivePulseServe): a rejected row is
// reported to onError and nothing else, so shipping first loses 100% of the
// signal while looking identical to working — the exact state 'living_page' is
// in today.
//
// The rows are additionally tagged event_type='live_pulse_serve' as provenance,
// so a consumer fitting ranker weights can select the ranked corpus with
// `event_type IS NULL` without needing to know the surface vocabulary.

/**
 * Live Pulse `item_type` → rank_events `item_kind`.
 *
 * Only the four existing CHECK-constraint values are used ('event','plan',
 * 'buddy','gem'); no aliases and no new vocabulary.  A type mapped to
 * `undefined` — or any type absent from the table — emits NO row at all.
 * Excluded on purpose:
 *
 *   circle        — item_id is a trips.id but the action is navigate_circle;
 *                   there is no rankable circle entity.
 *   safe_return   — a safety session, not a recommendation.
 *   compass       — excluded by product decision (its item_id is a real
 *                   hidden_gems.id, so this drops genuine gem impressions).
 *   buddy_request — item_id is a buddy_bookings PK, NOT a buddy entity id.
 *                   There is no permitted item_kind for a booking, and
 *                   mislabelling booking PKs as 'buddy' would merge two entity
 *                   namespaces into one (user_id, item_id) key space.  The
 *                   booking rows do carry a buddy_id / traveler_id, but the
 *                   *served* entity is the booking, not the buddy: emitting the
 *                   counterparty's id would claim an impression of a person the
 *                   rail never actually recommended.  A known gap is preferable
 *                   to permanently wrong data.
 */
const LIVE_PULSE_ITEM_KIND: Record<string, string | undefined> = {
  event:           "event",  // pulse.ts hosted / rsvp'd / saved — events.id
  trip:            "plan",   // pulse.ts trip_members  — trips.id
  trip_request:    "plan",   // pulse.ts join requests — trips.id, navigate_trip
  hidden_gem:      "gem",    // pulse.ts hidden gems   — hidden_gems.id
  // Buddy cards: the rail's item_id is rent_buddy_profiles.id, but rank_events
  // must store the buddy's user_id to match the ranked /pulse writer — the
  // route supplies it via _rankItemId, and without it no row is emitted.
  available_buddy: "buddy",

  circle:          undefined,
  safe_return:     undefined,
  compass:         undefined,
  buddy_request:   undefined,
};

/**
 * Pure mapping from a Live Pulse item_type to the rank_events item_kind.
 *
 * Returns `null` for every excluded or unknown type — including any
 * LivePulseItemType added later that nobody remembers to map.  Fail-closed:
 * an unmapped type produces no row rather than a CHECK-constraint violation
 * that would fail the whole batch.
 */
export function livePulseItemKind(itemType: string): string | null {
  // hasOwnProperty guard: a bare index would resolve inherited keys such as
  // "constructor" / "toString" to Object.prototype members.
  if (!Object.prototype.hasOwnProperty.call(LIVE_PULSE_ITEM_KIND, itemType)) return null;
  return LIVE_PULSE_ITEM_KIND[itemType] ?? null;
}

/**
 * Shape this module needs from a served Live Pulse rail item.
 *
 * `_rankItemId` is the route's internal override for the id the entity is known
 * by in rank_events, used when the rail's client-facing `item_id` is a
 * different id for the same thing (available_buddy: rail carries
 * rent_buddy_profiles.id, rank_events must carry the buddy's user_id).  It is
 * stripped from the HTTP response in routes/pulse.ts.
 */
export interface LivePulseServeInput {
  item_type:    string;
  item_id:      string;
  id?:          string;
  _rankItemId?: string | null;
}

/**
 * item_kinds whose id namespace is fixed by the ranked writer, and which may
 * therefore only be emitted with an explicit `_rankItemId`.
 *
 * 'buddy': the ranked /pulse writer builds buddy candidates as `id: b.user_id`
 * (routes/pulse.ts) and logImpression stores that as item_id, so every
 * item_kind='buddy' row in the corpus is keyed by user_id.  surface='live_pulse'
 * gives these rows their own key space, so a rent_buddy_profiles.id here could
 * no longer collide with a ranked row — but it would still be the wrong id:
 * every cross-surface join, every per-entity rollup, and any future comparison
 * of live_pulse against pulse exposure would silently miss.  One entity, one
 * id, everywhere.  Fail closed: no override, no row.
 */
const RANK_ID_REQUIRED_KINDS = new Set<string>(["buddy"]);

/** One rank_events row describing a served Live Pulse rail item. */
export interface LivePulseServeRow {
  user_id:      string;
  item_id:      string;
  item_kind:    string;
  position:     number;
  outcome:      "impression";
  served_at:    string;
  /**
   * Live Pulse's own surface key space — NOT 'pulse'.  Permitted live only by
   * migration 0199_rank_events_live_pulse_surface.sql.  Changing this back to
   * 'pulse' re-opens the outcome-attribution hijack described at the top of
   * this section.
   */
  surface:      "live_pulse";
  session_id:   string;
  event_type:   string;
  content_type: string;
}

/**
 * Pure row builder for Live Pulse serve telemetry — exported for direct testing.
 *
 * Invariants this function is responsible for:
 *  • `item_id` is ALWAYS a canonical entity id: `item._rankItemId` when the
 *    route supplied one, otherwise `item.item_id`.  The presentation key
 *    `item.id` is the composite `${item_type}:${entity}` and would join to
 *    nothing; it is never read here.
 *  • An item_kind in RANK_ID_REQUIRED_KINDS emits NOTHING unless
 *    `_rankItemId` is a non-empty string, because for those kinds the
 *    rail's own `item_id` belongs to a different namespace than the one the
 *    ranked writer uses for the same entity.
 *  • `surface` is always 'live_pulse'.  Never 'pulse' — see the section
 *    header; that is the whole reason this writer exists separately.
 *  • `features` is absent from every row.  The column is NOT NULL DEFAULT
 *    '{}'::jsonb, so the database supplies the empty object.  Writing a
 *    synthetic feature vector for un-ranked items is forbidden.
 *  • `position` is the index in the SERVED array (post urgency-sort).  Excluded
 *    types consume an index without producing a row, so the emitted sequence
 *    has gaps — that is correct, the item really did occupy that slot.
 *  • At most one row per (item_kind, item_id) per response.  addItem() in
 *    pulse.ts dedups on `${item_type}:${item_id}`, so the same trips.id can
 *    legitimately arrive as both 'trip' and 'trip_request'; both map to 'plan',
 *    and two rows sharing (user_id, item_id, surface, served_at) would make the
 *    "most recent impression for user+item" outcome lookup nondeterministic.
 *    The first occurrence (lowest position = highest urgency) wins.
 *
 * @param items     Served items, in served order. `id` is accepted only so the
 *                  full LivePulseItem can be passed; it is deliberately unused.
 * @param userId    Authenticated viewer.
 * @param sessionId Session UUID shared by every row of one response.
 * @param servedAt  ISO timestamp shared by every row of one response.
 */
export function buildLivePulseServeRows(
  items:     LivePulseServeInput[],
  userId:    string,
  sessionId: string,
  servedAt:  string,
): LivePulseServeRow[] {
  const emitted = new Set<string>();

  return items.flatMap((item, idx) => {
    const itemKind = livePulseItemKind(item.item_type);
    if (!itemKind) return [];                 // excluded / unknown type — skip

    // Namespace resolution.  For most kinds the rail's item_id already IS the
    // id the ranker uses; where it is not, the route must say so explicitly.
    const override = item._rankItemId;
    const hasOverride = typeof override === "string" && override.length > 0;
    if (RANK_ID_REQUIRED_KINDS.has(itemKind) && !hasOverride) return [];
    const itemId = hasOverride ? override : item.item_id;
    // item_id is NOT NULL in rank_events; a blank id would fail the whole batch.
    if (typeof itemId !== "string" || itemId.length === 0) return [];

    const key = `${itemKind}:${itemId}`;
    if (emitted.has(key)) return [];          // e.g. trip + trip_request → one 'plan'
    emitted.add(key);

    return [{
      user_id:      userId,
      item_id:      itemId,                   // canonical entity id — never item.id
      item_kind:    itemKind,
      position:     idx,                      // index in the served array; gaps kept
      outcome:      "impression" as const,
      served_at:    servedAt,
      surface:      "live_pulse" as const,
      session_id:   sessionId,
      event_type:   LIVE_PULSE_SERVE_EVENT,
      content_type: item.item_type,           // finer provenance item_kind collapses
      // features intentionally omitted — DB default '{}'. These items are
      // urgency-assembled, never ranker-scored: there is no feature vector.
    }];
  });
}

/**
 * Log Live Pulse serve rows into rank_events.
 *
 * Fire-and-forget: call with `void` and never `await` it — GET /api/pulse/live
 * must respond regardless of what rank_events does.  This function never
 * throws and never rejects; failures are reported through `onError` only.
 *
 * Unlike logCompassImpression this early-returns when nothing is emittable,
 * rather than issuing an empty insert: /pulse/live is polled continuously, and
 * a pointless round trip per poll is not worth the test convenience.
 *
 * @param items     Served items in served order (the array sent to the client).
 * @param userId    Authenticated viewer.
 * @param sessionId Session UUID for this response.
 * @param onError   Optional non-fatal error sink (e.g. req.log.warn).
 */
export async function logLivePulseServe(
  items:     LivePulseServeInput[],
  userId:    string,
  sessionId: string,
  onError?:  (err: unknown) => void,
): Promise<void> {
  try {
    const sc = getServiceClient();
    if (!sc) return;

    const rows = buildLivePulseServeRows(items, userId, sessionId, new Date().toISOString());
    if (rows.length === 0) return;

    const { error } = await sc.from("rank_events").insert(rows);
    if (error) onError?.(error);
  } catch (err) {
    // Never rethrow — a logging failure must not surface as an unhandled
    // rejection on the response path.
    try { onError?.(err); } catch { /* the error sink itself failed — swallow */ }
  }
}
