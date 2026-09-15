/**
 * POST /api/rank-events/outcome
 *
 * Records a user outcome (tap, save, join, rsvp, trip_add, attended) against the
 * most recent matching rank_events row for the authenticated user whose current
 * outcome sits on a LOWER funnel rung — an impression row, or a row already
 * upgraded to a weaker one (impression → tap → save/join/rsvp → trip_add → attended).
 *
 * Auth required.  Returns 404 when no upgradable row is found — phantom rows
 * are never created.
 *
 * Body: { item_id: uuid, surface: string, outcome: OutcomeEnum, session_id?: uuid }
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { asyncHandler } from "../lib/asyncHandler";
import { linkOutcomeSignal } from "../compass/CompassOutcomeEngine";
import { RankingEvent, OUTCOME_TO_ANALYTICS_EVENT } from "../services/ranking/rankingAnalytics.js";
import { recordNegativeDistributionSignal } from "../services/ranking/DiscoveryRankingService.js";
import { recommendationIdFor } from "../lib/discoveryRecommendationId.js";
const router = Router();

// ── POST /rank-events — direct impression write ───────────────────────────────
//
// Allows clients to write a rank_event row for surfaces that generate their
// own impression signals (e.g. Living Destination Page views).  Distinct from
// /rank-events/outcome which upgrades an existing impression row.
//
// Supported event_types:
//   place_view — viewer opened the Living Destination Page for a canonical place.

const DIRECT_EVENT_TYPES = ["place_view"] as const;
type DirectEventType = typeof DIRECT_EVENT_TYPES[number];

const directEventSchema = z.object({
  event_type:  z.enum(DIRECT_EVENT_TYPES),
  entity_type: z.string().min(1).max(50),
  entity_id:   z.string().min(1).max(200),
});

router.post("/rank-events", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  if (isDirectEventBatchBody(req.body)) { await handleDirectEventBatch(req, res, user.id); return; }
  const parsed = directEventSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { event_type, entity_id } = parsed.data;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  // Fire-and-forget: failures are non-fatal — a missed signal is better than
  // a broken Living Page load.
  const { error } = await sc.from("rank_events").insert({
    event_type,
    item_id:    entity_id,
    surface:    "living_page",
    user_id:    user.id,
    served_at:  new Date().toISOString(),
    outcome:    "impression",
  });

  if (error) {
    req.log.warn({ err: error, event_type, entity_id }, "rank-events: direct insert failed (non-fatal)");
  }

  res.json({ ok: true });
}));

// Existing outcome values — kept for backward compatibility with clients
// sending the legacy string values.  New outcome event types are emitted
// as additional analytics rows using the typed RankingEvent constants.
//
// 'dismiss' is the ONE negative value, added with migration 2297. Before it the
// vocabulary was entirely positive (tap/save/join/rsvp/attended), so negative
// user intent was unrecordable — a client had nothing to send — and
// content_distribution_stats.negative_signal_count consequently had NO WRITER
// AT ALL. That made the underexposure classifier structurally incapable of a
// negative verdict: 0 negatives over N impressions is never >= the 0.3
// suppression rate, so every item crossing the threshold classified 'boosting'.
// See the handler below, and DiscoveryRankingService.recordNegativeDistributionSignal.
//
// REQUIRES migration 2297_rank_events_dismiss_outcome.sql to be applied LIVE
// before this ships: rank_events.outcome carries a CHECK constraint, and the
// analytics insert further down echoes an outcome-derived row back into the
// table. Shipping first would 404 every dismiss (the UPDATE would violate the
// CHECK) while looking identical to "nobody dismisses anything".
const OUTCOME_VALUES = ["tap", "save", "join", "rsvp", "attended", "dismiss", "trip_add"] as const;
type OutcomeValue = typeof OUTCOME_VALUES[number];

/**
 * The negative outcome. Not a funnel rung — see upgradableOutcomesFor.
 *
 * Typed `Extract<OutcomeValue, "dismiss">` and not `OutcomeValue`: the literal
 * type is what lets `outcome === DISMISS` narrow the union in the branches
 * below, and the Extract is what makes the declaration fail to compile if
 * 'dismiss' is ever dropped from OUTCOME_VALUES (Extract would be `never`).
 */
const DISMISS: Extract<OutcomeValue, "dismiss"> = "dismiss";

/**
 * Funnel rungs (0153: impression → tap → save/join/rsvp → attended, plus
 * `trip_add` from migration 2894).  rank_events is a mutable-state table — an
 * outcome UPDATES the impression row in place — so the row can only ever hold
 * ONE outcome, and it should be the furthest rung reached.
 *
 * The lookup below therefore accepts any row on a strictly LOWER rung than the
 * reported outcome, not only outcome='impression'.  Without that, the first
 * outcome consumes the row and every stronger one after it 404s: the discovery
 * surface reports 'tap' when a place card opens its detail sheet, and a 'save'
 * made from inside that sheet was silently lost.  A weaker or equal outcome
 * never downgrades: it finds no row and 404s exactly as a duplicate did.
 * `trip_add` is ABOVE save (`04` §8: … → save → trip_add), BELOW attended (a
 * plan is not a visit), and narrowed — see NOT_SUBSUMED_BY_TRIP_ADD below. */
type FunnelOutcome = Exclude<OutcomeValue, typeof DISMISS>;

const OUTCOME_RUNG: Record<FunnelOutcome | "impression", number> = {
  impression: 0,
  tap:        1,
  save:       2,
  join:       2,
  rsvp:       2,
  trip_add:   3,
  attended:   4,
};

/** rank_events.outcome values a row may hold and still be upgraded to `outcome`. */
export function upgradableOutcomesFor(outcome: OutcomeValue): string[] {
  // 'dismiss' is NOT a rung on the positive funnel and is deliberately absent
  // from OUTCOME_RUNG. Two consequences, both wanted:
  //   • a dismiss may only be recorded against a row still at 'impression' —
  //     you dismiss something you were shown, not something you already saved;
  //   • 'dismiss' appears in no other outcome's upgradable set, so a later tap
  //     or save can never silently overwrite a recorded negative. A dismissed
  //     row is terminal, and a stronger signal after it 404s exactly as a
  //     duplicate does.  'trip_add' is narrowed the same way — see below.
  if (outcome === DISMISS) return ["impression"];
  const rung = OUTCOME_RUNG[outcome];
  return (Object.keys(OUTCOME_RUNG) as Array<keyof typeof OUTCOME_RUNG>)
    .filter((o) => OUTCOME_RUNG[o] < rung && !(outcome === TRIP_ADD && NOT_SUBSUMED_BY_TRIP_ADD.has(o)));
}

/**
 * Surfaces a client may report an outcome against.  This is the ONLY server-side
 * validation of `surface`; everything else writes a hard-coded literal.
 *
 * 'live_pulse' — the Live Pulse rail (GET /api/pulse/live).  Its serve rows are
 * written on their own surface by logLivePulseServe (lib/rankLog.ts) precisely
 * so they cannot hijack outcome attribution from ranked surface='pulse'
 * impressions, and the lookup below hard-filters .eq("surface", surface), so
 * without this value every Live Pulse save/rsvp 400s at the zod boundary.
 *
 * NOTE this value also reaches the CHECK constraint a SECOND time: the analytics
 * insert further down echoes `surface` verbatim into a new row.  Migration
 * 0199_rank_events_live_pulse_surface.sql must be applied live before this enum
 * is widened, or that insert is silently rejected (it only warns).
 */
const SURFACE_VALUES = ["pulse", "discovery", "events", "live_pulse"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const outcomeBodySchema = z.object({
  // item_id is text — Discovery places use OSM IDs ("node/12345", "db/<uuid>")
  // in addition to plain UUIDs from posts/events/plans/buddies.
  item_id:    z.string().min(1).max(200),
  surface:    z.enum(SURFACE_VALUES),
  outcome:    z.enum(OUTCOME_VALUES),
  session_id: z.string().regex(UUID_RE, "session_id must be a valid UUID").optional(),
});

router.post("/rank-events/outcome", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = outcomeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const { item_id, surface, outcome, session_id } = parsed.data;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  // Find the most recent upgradable row for this user + item + surface
  // (+ optionally session): an impression, or a row on a lower funnel rung.
  // DV-46: id + the coordinates the exposure token needs. TWO whole chains, not
  // one computed list: check:write-path-columns resolves only a literal/const.
  let query = (_recommendationIdColumn === "absent" ? sc.from("rank_events").select(EXPOSURE_COLUMNS_LEGACY) : sc.from("rank_events").select(EXPOSURE_COLUMNS))
    .eq("user_id", user.id)
    .eq("item_id", item_id)
    .eq("surface", surface)
    .in("outcome", upgradableOutcomesFor(outcome))   // never downgrades — see OUTCOME_RUNG
    .order("served_at", { ascending: false })
    .limit(1);

  if (session_id) {
    query = query.eq("session_id", session_id);
  }

  const picked = await readUpgradableExposure(sc, query, {
    userId: user.id, itemId: item_id, surface, outcome, sessionId: session_id,
  }, req.log);
  if (picked.error) {
    req.log.error({ err: picked.error }, "rank-events/outcome: select failed");
    sendError(res, "db_error", picked.error.message); return;
  }
  const row = picked.row;
  if (!row) {
    sendError(res, "not_found", "No matching impression row found for this item");
    return;
  }
  const recommendationId = exposureTokenFor(row, user.id, item_id, surface);  // `04` §10.6
  const { error: updateErr } = await sc
    .from("rank_events")
    .update({ outcome, outcome_at: new Date().toISOString(), ...(canStampExposureToken(recommendationId) ? { recommendation_id: recommendationId } : {}) })
    .eq("id", row.id);

  const settled = await settleOutcomeUpdate(sc, row.id, outcome, recommendationId, updateErr, req.log);
  if (!settled.ok) {
    sendError(res, "db_error", settled.message);
    return;
  }

  // Phase 14 — map the rank-events funnel outcome onto the Compass outcome
  // chain and link it back to the originating served recommendation.
  //
  // 'dismiss' is excluded: the Compass chain models progress toward acting on a
  // recommendation (viewed → saved → went) and has no negative stage. The
  // `else` arm here is "went", so a dismiss falling through would record the
  // viewer as having GONE to a place they explicitly waved away — the strongest
  // positive signal the chain carries, written from its opposite.
  if (outcome !== DISMISS) {
    // 'trip_add' maps to `saved`, NOT the `went` fallthrough: a trip add is a
    // plan to go and `went` asserts the traveller WAS THERE, which is the same
    // class of fabrication the dismiss exclusion above exists to prevent.
    const stage = compassStageFor(outcome);
    void linkOutcomeSignal(sc, user.id, item_id, stage, `route:rank_event_${outcome}`);
  }

  // ── The underexposure NUMERATOR ─────────────────────────────────────────────
  // This is the only place content_distribution_stats.negative_signal_count is
  // ever written. It calls record_distribution_negative_signal (2297), NOT
  // increment_distribution_stats: the latter moves eligible_impressions in the
  // same statement, and an outcome must never move the exposure denominator
  // (see the note at the end of this handler). Fire-and-forget.
  if (outcome === DISMISS) {
    void recordNegativeDistributionSignal(sc, item_id, user.id);
  }

  // Emit typed analytics event for this outcome (fire-and-forget).
  // Maps the legacy outcome string to the new RankingEvent constant so
  // analytics pipelines can filter by the canonical event_type name.
  // Backward compatibility: the existing `outcome` field on the row is
  // already updated above — this is an additive analytics insert only.
  const analyticsEventType = OUTCOME_TO_ANALYTICS_EVENT[outcome];
  if (analyticsEventType) {
    // DV-46: `recommendation_id` makes this row part of the SAME exposure as the
    // impression it follows, and migration 2891's UNIQUE (recommendation_id,
    // outcome) index turns a repeat into an UPGRADE of the one analytics row
    // rather than a second one. On a database without the column this falls back
    // to the plain insert it has always been — loudly, once. Fire-and-forget.
    void writeOutcomeAnalyticsRow(sc, {
      event_type:  analyticsEventType,
      item_id,
      surface,
      user_id:     user.id,
      session_id:  session_id ?? null,
      served_at:   new Date().toISOString(),
      // Analytics sentinel — prevents impression-finding query from matching
      outcome:     "analytics",
      recommendation_id: recommendationId,
    }, req.log, { outcome, analyticsEventType });
  }
  // content_distribution_stats.eligible_impressions is deliberately NOT touched
  // here.  This route used to be the ONLY writer of it — "an outcome confirms
  // the impression was real" — which made the exposure denominator a count of
  // conversions (docs/architecture/00_STATUS.md defect 4).  The DENOMINATOR is
  // incremented where the impression is written (lib/rankLog.ts,
  // lib/discoveryServeLog.ts → recordImpressionDistributionStats); an outcome
  // is a numerator event and must never move it.  The NUMERATOR is written
  // above, for outcome='dismiss' only, through a separate RPC that leaves
  // eligible_impressions alone.

  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// Everything below this line is declared BELOW the last anchored doc citation
// into this file (`routes/rankEvents.ts:290#content_distribution_stats`). The
// handlers above call into it by hoisted function declaration, so the citations
// at :44, :99, :139, :169, :208, :229-238, :231 and :290 keep pointing at the
// code they describe. Put new declarations here, not up there.
// ═══════════════════════════════════════════════════════════════════════════════

/** The subset of pino's logger these helpers use; absent in unit tests. */
type RouteLog = {
  warn?:  (ctx: unknown, msg?: string) => void;
  error?: (ctx: unknown, msg?: string) => void;
};

/** Same idiom as lib/requireAdmin.ts — a missing req.log must not become a 500. */
function warnOn(log: RouteLog | undefined, ctx: unknown, msg: string): void {
  (log?.warn ?? console.warn).call(log ?? console, ctx, msg);
}

// ── DC-09 / DV-79 — `trip_add`, admitted by migration 2894 ───────────────────
//
// `04` §8's first behaviour chain is `impression → place_open → save → trip_add`
// and `12` Phase 9's sixth comparison axis is "estimated travel intent". Both
// were blocked on the same absence: the outcome CHECK vocabulary had no
// trip-add token. A previous pass considered borrowing `join` and REFUSED —
// `join` means "joined somebody's plan", and a place put on an itinerary has
// joined nothing — and that refusal stands. 2894 removes the reason for it.
//
// WHERE IT SITS, AND WHAT THAT COSTS
// ==================================
// The rungs are now impression 0 · tap 1 · save/join/rsvp 2 · trip_add 3 ·
// attended 4. Two of the three placements are forced:
//
//   ABOVE save — §8's chain is `… → save → trip_add`. At rung 2, a trip add
//   arriving after a save would find no upgradable row and 404, so the single
//   transition the chain exists to measure is the one it would lose.
//
//   BELOW attended — `attended` is "I went"; a trip add is "I plan to". A
//   planning signal able to overwrite a confirmed visit would replace the
//   strongest positive fact this funnel carries with a weaker one, leaving no
//   trace that the stronger one was ever recorded.
//
// The third is a JUDGEMENT and is therefore narrowed by hand rather than left
// to the integer. `join` and `rsvp` are commitments made TO SOMEBODY ELSE — a
// host expecting you. `attended` may consume an `rsvp` because attending
// CONTAINS it; adding the same event to your own itinerary does not contain it,
// it is a different fact about a different party. So trip_add's upgradable set
// is (impression, tap, save) and nothing else, exactly as `dismiss`'s is
// ["impression"]. The refusal is symmetric: a later join/rsvp sits at a lower
// rung than trip_add and cannot overwrite one either.
//
// THE WRITER IS THE CLIENT, AND IT IS THE PLAN PICKER. When a traveller adds a
// served Discovery item to a trip, travel-buddy-standalone's
// PlanPickerController reports `trip_add` here through useRankOutcome, on the
// SUCCESS path of the add and with the surface the impression was served under.
// It is fire-and-forget like every other outcome: a failed report never breaks
// the add. `POST /api/places/:placeId/add-to-trip-plan` (routes/plan.ts) still
// reports nothing of its own — it is the transport for the itinerary row, not
// the funnel — so an add made anywhere the picker is not involved is still
// unrecorded, and a read of outcome='trip_add' can legitimately return zero
// rows. That remains a corpus of zero from a read that RAN, which
// lib/discoveryShadow.ts keeps distinct from a read that failed.

/** The itinerary-commitment outcome (2894). Typed like DISMISS, for the same reason. */
const TRIP_ADD: Extract<OutcomeValue, "trip_add"> = "trip_add";

/**
 * Outcomes a `trip_add` does NOT subsume, and may therefore never overwrite,
 * even though the plain rung comparison would let it. See the note above.
 */
const NOT_SUBSUMED_BY_TRIP_ADD: ReadonlySet<string> = new Set(["join", "rsvp"]);

/**
 * The Compass outcome chain stage for a funnel outcome (viewed → saved → went).
 *
 * `trip_add` is `saved` and NOT the `went` fallthrough. `went` asserts the
 * traveller WAS THERE; a trip add says they intend to be. Letting it fall
 * through would record a visit that never happened — the same fabrication the
 * handler's `dismiss` exclusion exists to prevent, from the opposite direction.
 *
 * Never called for `dismiss`: the chain has no negative stage, and the caller
 * guards on that before reaching here.
 */
export function compassStageFor(outcome: Exclude<OutcomeValue, typeof DISMISS>): "viewed" | "saved" | "went" {
  if (outcome === "tap") return "viewed";
  if (outcome === "save" || outcome === TRIP_ADD) return "saved";
  return "went"; // join / rsvp / attended
}

// ── DV-46 / DSV2-12 — the exposure token on an outcome upgrade ────────────────
//
// `04` §5 asks that every served item carry a `recommendation_id`, and §10.6
// asks that it PROPAGATE. lib/discoveryRecommendationId mints it and
// lib/discoveryServeLog writes it (into `features.recommendationId`); migration
// 2891 gives it a column plus `UNIQUE (recommendation_id, outcome)`. The gap
// this closes is the last hop: an outcome upgrade that carried no token left the
// exposure and its outcomes sharing no key at all.
//
// ── THE MIGRATION IS APPLIED, AND THE FALLBACK STAYS ─────────────────────────
// 2891 was applied to portava-ci (rehearsal E4, steps 2/4/6) and to production
// on 2026-09-14 (docs/architecture/production-deployment-2026-09-14.md, row 4).
// The sentence that stood here — "staged and rehearsed on portava-ci only" — was
// true when it was written and is no longer; it is corrected rather than deleted
// so the record of when it changed survives.
//
// Every path below still has to be correct BOTH ways, because "applied to the
// two databases we know about" is not "applied everywhere this code runs", and
// the failure mode to design against is not the missing column — it is a route
// that turns a missing column into a 500 on an endpoint whose whole job is to
// record a signal. So: attempt the arbitrated shape, and on the specific errors
// that mean "2891 is not here", say so ONCE, latch it, and redo the write in the
// shape that has always worked. The outcome is never dropped and the degradation
// is never silent.

/** rank_events.recommendation_id's shape CHECK, mirrored from migration 2891. */
const RECOMMENDATION_ID_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** The conflict arbiter. BOTH columns, in index order — `recommendation_id`
 *  alone raises 42P10 against 2891's index (the migration says so verbatim). */
const RECOMMENDATION_ARBITER = "recommendation_id,outcome";

/** Exposure coordinates the outcome handler reads, WITH 2891's column. */
const EXPOSURE_COLUMNS        = "id, position, served_at, session_id, features, recommendation_id";
/** The same list on a database where 2891 has not been applied. */
const EXPOSURE_COLUMNS_LEGACY = "id, position, served_at, session_id, features";

let _recommendationIdColumn: "unknown" | "absent" = "unknown";

/** Test seam — the latch is process-wide, so a suite that simulates a 2891-less
 *  database would otherwise poison every suite that runs after it. */
export function _resetRecommendationIdSchemaLatch(): void {
  _recommendationIdColumn = "unknown";
}

/**
 * The select list this route asks for, as one named DECISION.
 *
 * The outcome handler does NOT call it: `check:write-path-columns` resolves a
 * `.select` argument only from a string literal or a same-file const string, so
 * a computed list is a blind spot in the one check that compares a READ list
 * against the live schema — and a read list that drifts fails the whole query
 * with PGRST100. The handler therefore writes the branch out as two whole
 * chains. This function is the same decision in one place, and the tests assert
 * the two agree, so the duplication cannot rot silently.
 */
export function exposureColumns(): string {
  return _recommendationIdColumn === "absent" ? EXPOSURE_COLUMNS_LEGACY : EXPOSURE_COLUMNS;
}

/**
 * Does this PostgREST error mean "migration 2891 is not applied here"?
 *
 * Three codes, all of which this route can only produce for that one reason —
 * `recommendation_id` is the only column it names that is not in the pre-2891
 * thirteen, and the only ON CONFLICT it ever asks for:
 *   42703    undefined_column — the SELECT list or the filter named it;
 *   PGRST204 PostgREST's schema cache has no such column for a write;
 *   42P10    the column exists but the unique index that arbitrates it does not.
 * Anything else — a timeout, an RLS denial, a CHECK violation — is NOT this, and
 * must keep its 500 rather than be quietly absorbed by the fallback.
 */
export function isMissingRecommendationIdSchema(err: unknown): boolean {
  const e    = err as { code?: unknown; message?: unknown } | null | undefined;
  const code = String(e?.code ?? "");
  if (code === "42703" || code === "PGRST204" || code === "42P10") return true;
  const msg = String(e?.message ?? "").toLowerCase();
  if (msg.includes("on conflict specification")) return true;
  if (!msg.includes("recommendation_id")) return false;
  return msg.includes("does not exist")
      || msg.includes("could not find")
      || msg.includes("schema cache");
}

function noteRecommendationIdUnavailable(err: unknown, log: RouteLog | undefined, where: string): void {
  const firstTime = _recommendationIdColumn !== "absent";
  _recommendationIdColumn = "absent";
  if (!firstTime) return;   // one line per process, not one per request
  warnOn(
    log,
    { err, where, migration: "2891_rank_events_recommendation_id.sql" },
    "rank-events/outcome: rank_events.recommendation_id is unavailable — outcome recorded " +
    "WITHOUT an exposure token; 04 §10.6 propagation is off until 2891 is applied",
  );
}

/**
 * The exposure's `recommendation_id`, in order of authority:
 *   1. the column, once 2891 is applied and a writer fills it;
 *   2. `features.recommendationId`, which lib/discoveryServeLog writes today;
 *   3. derived from the row's own coordinates.
 *
 * (3) is not an invention: `recommendationIdFor` is pure and total over exactly
 * (userId, sessionId, servedAt, surface, position, itemId), and every one of
 * those is a column on the row just read — so it REPRODUCES what the serve-side
 * writer computed rather than minting a rival identity for the same exposure.
 *
 * A stored value is used only if it matches 2891's shape CHECK. Otherwise it is
 * some other system's token (Compass's HMAC handle, say) and writing it would
 * fail the CHECK with a 23514 — a real error, on a path meant to degrade.
 */
export function exposureTokenFor(
  row:     Record<string, unknown> | null | undefined,
  userId:  string,
  itemId:  string,
  surface: string,
): string {
  const stored = row?.["recommendation_id"];
  if (typeof stored === "string" && RECOMMENDATION_ID_SHAPE.test(stored)) return stored;
  const inFeatures = (row?.["features"] as { recommendationId?: unknown } | null | undefined)?.recommendationId;
  if (typeof inFeatures === "string" && RECOMMENDATION_ID_SHAPE.test(inFeatures)) return inFeatures;
  const position = row?.["position"];
  return recommendationIdFor({
    userId,
    sessionId: typeof row?.["session_id"] === "string" ? (row["session_id"] as string) : "",
    servedAt:  typeof row?.["served_at"]  === "string" ? (row["served_at"]  as string) : "",
    surface,
    position:  typeof position === "number" ? position : -1,
    itemId,
  });
}

/**
 * May this exposure token be written into `rank_events.recommendation_id`?
 *
 * The predicate half of what used to be `outcomeUpdatePatch`. The patch itself
 * is now spelled out as an object literal at each of the two update sites: a
 * payload built by a function call is invisible to `check:write-path-columns`,
 * which is how a column can start being written before its migration is applied
 * without any check noticing. The literal costs one repetition and buys the
 * column list back.
 */
export function canStampExposureToken(recommendationId: string): boolean {
  return _recommendationIdColumn !== "absent" && RECOMMENDATION_ID_SHAPE.test(recommendationId);
}

/**
 * Execute the upgradable-row lookup, retrying without 2891's column if the
 * database has not got it. The retry rebuilds the query from the same filters
 * rather than reusing the builder, because a PostgREST builder is spent once
 * awaited.
 */
async function readUpgradableExposure(
  sc: any,
  query: any,
  f: { userId: string; itemId: string; surface: string; outcome: OutcomeValue; sessionId?: string },
  log: RouteLog | undefined,
): Promise<{ row: any | null; error: any | null }> {
  const first = await query;
  if (!first?.error) return { row: ((first?.data as any[]) ?? [])[0] ?? null, error: null };
  if (!isMissingRecommendationIdSchema(first.error)) return { row: null, error: first.error };

  noteRecommendationIdUnavailable(first.error, log, "outcome select");
  let retry = sc
    .from("rank_events")
    .select(EXPOSURE_COLUMNS_LEGACY)
    .eq("user_id", f.userId)
    .eq("item_id", f.itemId)
    .eq("surface", f.surface)
    .in("outcome", upgradableOutcomesFor(f.outcome))
    .order("served_at", { ascending: false })
    .limit(1);
  if (f.sessionId) retry = retry.eq("session_id", f.sessionId);

  const second = await retry;
  if (second?.error) return { row: null, error: second.error };
  return { row: ((second?.data as any[]) ?? [])[0] ?? null, error: null };
}

/**
 * Settle the funnel-row update.
 *
 * `firstErr` is the error from the update the handler already issued. A
 * PGRST204 there means PostgREST's schema cache has no `recommendation_id` —
 * which can happen even when the SELECT succeeded, because the cache and the
 * catalogue drift independently — so the write is redone WITHOUT the column
 * rather than resent unchanged, which would fail identically.
 */
async function settleOutcomeUpdate(
  sc: any,
  rowId: unknown,
  outcome: OutcomeValue,
  recommendationId: string,
  firstErr: any,
  log: RouteLog | undefined,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!firstErr) return { ok: true };

  if (isMissingRecommendationIdSchema(firstErr)) {
    noteRecommendationIdUnavailable(firstErr, log, "outcome update");
    const { error: retryErr } = await sc
      .from("rank_events")
      // The latch is now "absent", so canStampExposureToken is false and the
      // spread contributes nothing — the same patch the old helper produced.
      .update({ outcome, outcome_at: new Date().toISOString(), ...(canStampExposureToken(recommendationId) ? { recommendation_id: recommendationId } : {}) })
      .eq("id", rowId);
    if (!retryErr) return { ok: true };
    firstErr = retryErr;
  }

  (log?.error ?? console.error).call(log ?? console, { err: firstErr }, "rank-events/outcome: update failed");
  return { ok: false, message: String(firstErr?.message ?? "db_error") };
}

/**
 * Write the analytics row for this outcome.
 *
 * With 2891 applied this is an ON CONFLICT UPGRADE on (recommendation_id,
 * outcome): one analytics row per exposure, carrying the latest event type,
 * instead of a fresh row every time an outcome is re-reported. `ignoreDuplicates`
 * is deliberately FALSE — DO NOTHING would make a repeat a no-op, and the
 * requirement is an upgrade.
 *
 * Without it, a plain insert of the same row minus the token: exactly what this
 * route did before, so a 2891-less database loses nothing it had.
 *
 * Fire-and-forget throughout; this never rejects.
 */
interface OutcomeAnalyticsRow {
  event_type: string;
  item_id:    string;
  surface:    string;
  user_id:    string;
  session_id: string | null;
  served_at:  string;
  /** Always the 'analytics' sentinel — the value that keeps this row out of the funnel lookup. */
  outcome:    string;
  recommendation_id: string;
}

async function writeOutcomeAnalyticsRow(
  sc:  any,
  row: OutcomeAnalyticsRow,
  log: RouteLog | undefined,
  ctx: { outcome: OutcomeValue; analyticsEventType: string },
): Promise<void> {
  const token = row.recommendation_id;
  // Spelled out rather than `{ ...row }` minus a key: a payload the AST cannot
  // resolve is invisible to check:write-path-columns, and this is an INSERT into
  // the table the whole Discovery funnel lives in. The column list is the thing
  // the check exists to compare against the live schema, so it is written down.
  const bare = {
    event_type: row.event_type,
    item_id:    row.item_id,
    surface:    row.surface,
    user_id:    row.user_id,
    session_id: row.session_id,
    served_at:  row.served_at,
    outcome:    row.outcome,
  };
  const withToken = { ...bare, recommendation_id: row.recommendation_id };

  try {
    const rel = sc.from("rank_events");
    // The capability check is not ceremony: `upsert` is the one method here that
    // a narrower client-shaped object may not carry, and calling it blind would
    // turn "no arbiter available" into a TypeError that silently loses the row.
    const arbitrated =
      _recommendationIdColumn !== "absent" &&
      typeof token === "string" && RECOMMENDATION_ID_SHAPE.test(token) &&
      typeof rel?.upsert === "function";

    const res = arbitrated
      ? await rel.upsert(withToken, { onConflict: RECOMMENDATION_ARBITER, ignoreDuplicates: false })
      : await rel.insert(bare);
    if (!res?.error) return;

    if (arbitrated && isMissingRecommendationIdSchema(res.error)) {
      noteRecommendationIdUnavailable(res.error, log, "analytics upsert");
      const retry = await sc.from("rank_events").insert(bare);
      if (!retry?.error) return;
      warnOn(log, { err: retry.error, ...ctx }, "rank-events/outcome: analytics insert failed (non-fatal)");
      return;
    }
    warnOn(log, { err: res.error, ...ctx }, "rank-events/outcome: analytics insert failed (non-fatal)");
  } catch (err) {
    warnOn(log, { err, ...ctx }, "rank-events/outcome: analytics insert failed (non-fatal)");
  }
}

// ── DC-19 — the batch form of POST /rank-events ──────────────────────────────
//
// ADDITIVE. A body without an `events` key never reaches any of this: the
// single-event path above is untouched, down to its `{ ok: true }` body and its
// fire-and-forget treatment of a rejected insert.
//
// PARTIAL-FAILURE SEMANTICS: **ALL-OR-NOTHING**, chosen and not defaulted.
//
//   Why not per-item results? These are impression events and their only
//   consumer is an exposure denominator. A 207-style body saying "14 of 20
//   landed" is only useful to a client that will resend the other 6, and no
//   client resends against a 2xx. A batch that half-lands therefore leaves the
//   denominator holding a number nobody will ever correct — and an exposure
//   denominator that is quietly wrong is the defect `04` §5 exists to prevent
//   ("without exposure denominators, engagement rates are misleading").
//
//   So the rule is: validate EVERYTHING first, then write everything in ONE
//   multi-row insert. PostgREST executes a multi-row insert as a single
//   statement, so atomicity comes from the database rather than from a promise
//   made here. One invalid item ⇒ 400, nothing written, the offending index
//   named. A rejected insert ⇒ 500 `db_error`, never `{ ok: true }`.
//
//   THAT LAST LINE IS WHERE THE BATCH DELIBERATELY DIFFERS FROM THE SINGLE
//   FORM. The single form answers a rejected insert with 200 `{ ok: true }` and
//   a warn — "a missed signal beats a broken Living Page load" — and that stays,
//   because clients depend on it. A new shape does not inherit it: a batch that
//   reports success having written nothing is the masquerade `11` §9 forbids,
//   and there is no compatibility argument for a shape nobody has called yet.

/** Upper bound on one batch. An unbounded batch is an unbounded statement. */
const DIRECT_EVENT_BATCH_MAX = 200;

const directEventBatchSchema = z.object({
  events: z.array(directEventSchema).min(1).max(DIRECT_EVENT_BATCH_MAX),
});

/**
 * Is this the batch shape?
 *
 * Presence of `events` — NOT "is it a valid batch". A body carrying `events`
 * that fails the schema must be a 400 about its batch, never a fall-through
 * that re-reports it as a malformed single event.
 */
export function isDirectEventBatchBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && !Array.isArray(body)
      && Object.prototype.hasOwnProperty.call(body, "events");
}

async function handleDirectEventBatch(req: any, res: any, userId: string): Promise<void> {
  const parsed = directEventBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = (issue?.path?.length ?? 0) > 0 ? issue!.path.join(".") : "events";
    sendError(res, "invalid_payload", `${where}: ${issue?.message ?? "Invalid payload"}`);
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  // One timestamp for the whole batch: these rows describe one client flush, and
  // per-row clocks would make them look like separate serves.
  const servedAt = new Date().toISOString();
  const rows = parsed.data.events.map((e) => ({
    event_type: e.event_type,
    item_id:    e.entity_id,
    surface:    "living_page",
    user_id:    userId,
    served_at:  servedAt,
    outcome:    "impression",
  }));

  const { error } = await sc.from("rank_events").insert(rows);
  if (error) {
    (req.log?.error ?? console.error).call(
      req.log ?? console,
      { err: error, count: rows.length },
      "rank-events: batch insert rejected — NOTHING was written",
    );
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({ ok: true, accepted: rows.length });
}

export default router;
