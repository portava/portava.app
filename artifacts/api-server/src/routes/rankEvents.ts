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
import { recommendationIdFor } from "../lib/discoveryRecommendationId.js";  import { RECOMMENDATION_ID_SHAPE, RECOMMENDATION_ARBITER, RECOMMENDATION_ID_MIGRATION, isMissingRecommendationIdSchema, noteRecommendationIdAbsent, recommendationIdSchemaAbsent, reportRankEventsRejection, _resetRecommendationIdSchemaLatch as _resetSharedRecommendationIdLatch } from "../lib/rankEventsProvenance.js";  /* one line ON PURPOSE — see WHY THIS FILE IS EDITED IN PLACE, below. */  import { bindOutcomeToExposure, checkEventSchemaVersion, canonicalServedAt, isDuplicateExposureReplay, type OutcomeBinding } from "../lib/discoveryRecommendationRecord.js";  /* census-discovery §48 — the shared served-recommendation contract */
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
  entity_id:   z.string().min(1).max(200),  client_event_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "client_event_id must be a UUID").optional(), schema_version: z.unknown().optional(),  // §48 DV-37 / DV-38
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

  const { event_type, entity_id, client_event_id } = parsed.data; if (!acceptsEventVersion(res, parsed.data.schema_version)) return;  // §48 DV-38 — an unknown record version is refused, never stored

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  // DV-40 / DV-46 — this exposure carries 2891's token, so an outcome reported
  // against it can be joined back to the impression that produced it. `living_page`
  // is one of the two surfaces census-discovery §41.1 found wrongly recorded as
  // writerless; a writer whose rows carry no join key is only half an answer to
  // that, because nothing in its telemetry can be attributed to a ranking run.
  //
  // Fire-and-forget as before — failures are non-fatal, a missed signal is better
  // than a broken Living Page load — but no longer only WARNED. §41.1's hazard is
  // that a constraint refusing every row of a surface reads exactly like a surface
  // nobody uses, so the refusal is COUNTED by the constraint that caused it.
  const servedAt = new Date().toISOString();
  await writeDirectImpression(sc, { event_type, item_id: entity_id,
    surface: "living_page", user_id: user.id, served_at: servedAt,
    outcome: "impression", recommendation_id: directExposureToken(user.id, entity_id, servedAt, client_event_id), keyed: client_event_id !== undefined }, req.log);

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
  session_id: z.string().regex(UUID_RE, "session_id must be a valid UUID").optional(),  recommendation_id: z.string().regex(RECOMMENDATION_ID_SHAPE, "recommendation_id is not a served exposure id").optional(), schema_version: z.unknown().optional(), client_event_id: directEventSchema.shape.client_event_id,  // §48 DV-46 / DV-38; §62 DV-37 — the key, validated exactly as POST /rank-events validates it
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
  const { item_id, surface, outcome, session_id, recommendation_id: claimedId, client_event_id: clientEventId } = parsed.data; if (!acceptsEventVersion(res, parsed.data.schema_version)) return;  // §48 — DV-38: an unknown version is refused; DV-46: a served id, when the client echoes one, is BOUND below

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  // Find the most recent upgradable row for this user + item + surface
  // (+ optionally session): an impression, or a row on a lower funnel rung.
  // DV-46: id + the coordinates the exposure token needs. TWO whole chains, not
  // one computed list: check:write-path-columns resolves only a literal/const.
  let query = (recommendationIdSchemaAbsent() ? sc.from("rank_events").select(EXPOSURE_COLUMNS_LEGACY) : sc.from("rank_events").select(EXPOSURE_COLUMNS))
    .eq("user_id", user.id)
    .eq("item_id", item_id)
    .eq("surface", surface)
    .in("outcome", upgradableOutcomesFor(outcome))   // never downgrades — see OUTCOME_RUNG
    .order("served_at", { ascending: false })
    .limit(1);

  if (session_id) {
    query = query.eq("session_id", session_id);
  }

  const receipt = await readOutcomeReceipt(sc, user.id, clientEventId, req.log); const picked = receipt.error || receipt.hit ? receipt : claimedId ? await readClaimedExposure(sc, user.id, claimedId, req.log) : await readKeylessOrUpgradable(sc, query, clientEventId, {
    userId: user.id, itemId: item_id, surface, outcome, sessionId: session_id,
  }, req.log);
  if (picked.error) {
    req.log.error({ err: picked.error }, "rank-events/outcome: select failed");
    sendError(res, "db_error", picked.error.message); return;
  }
  const row = picked.row; if (receipt.hit) { await answerKeyedReplay(sc, res, receipt.hit, { userId: user.id, itemId: item_id, surface, outcome, sessionId: session_id ?? null }, req.log); return; } if ("keylessReplay" in picked && picked.keylessReplay) { res.json({ ok: true, duplicate: true }); return; }  // §62 DV-37; §82 D-W10-O-5 — a keyless retry
  if (!row) {
    sendError(res, "not_found", "No matching impression row found for this item");
    return;
  }
  const binding = claimedId ? bindOutcomeToExposure({ callerUserId: user.id, body: { item_id, surface, outcome }, row, upgradable: upgradableOutcomesFor(outcome) }) : null; if (binding && refuseUnboundOutcome(res, binding)) return; const cas = newOutcomeCas(outcome, binding); const recommendationId = claimedId ?? exposureTokenFor(row, user.id, item_id, surface);  // `04` §10.6; §48 DV-37/46 — bind a claimed id to THIS viewer, then compare-and-set
  const { error: updateErr } = await compareAndSetClient(sc
    .from("rank_events")
    .update({ outcome, outcome_at: new Date().toISOString(), ...(canStampExposureToken(recommendationId) ? { recommendation_id: recommendationId } : {}), ...(clientEventId && canStampOutcomeKey() ? { outcome_client_event_id: clientEventId } : {}) })
    .eq("id", row.id), cas);

  const settled = await settleKeyedOutcomeUpdate(sc, row.id, outcome, recommendationId, updateErr, req.log, cas, clientEventId);  // §62 DV-37 — a key that already landed elsewhere is a duplicate
  if (!settled.ok) {
    sendError(res, settled.notFound ? "not_found" : "db_error", settled.message);
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
  if (outcome !== DISMISS && !settled.duplicate) {  // §48 DV-37 — a replay links nothing a second time
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
  if (outcome === DISMISS && !settled.duplicate) {  // §48 DV-37 — a replayed dismiss must not count twice in a cross-viewer statistic; §83 DV-UNDO — and neither must a dismiss→undo→re-dismiss loop, which carries a NEW client_event_id and so is no replay at all
    if (await negativeSignalBanked(sc, user.id, item_id, surface, row, req.log) === "not_counted") void recordNegativeDistributionSignal(sc, item_id, user.id);  // §83 — "unknown" does not increment: the counter is increment-only, so a wrong +1 is permanent
  }

  // Emit typed analytics event for this outcome (fire-and-forget).
  // Maps the legacy outcome string to the new RankingEvent constant so
  // analytics pipelines can filter by the canonical event_type name.
  // Backward compatibility: the existing `outcome` field on the row is
  // already updated above — this is an additive analytics insert only.
  const analyticsEventType = settled.keyedCollision ? undefined : OUTCOME_TO_ANALYTICS_EVENT[outcome];  // §62 DV-37
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

  res.json(settled.duplicate ? { ok: true, duplicate: true } : { ok: true });  // §48 DV-37 — a replay of a recorded outcome is answered as the success it was
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

// ── WHY THIS FILE IS EDITED IN PLACE ─────────────────────────────────────────
//
// EIGHT anchored doc citations point into lines 44-290 of this file — `44`,
// `99`, `139`, `169`, `208`, `229-238`, `231`, `290` — and `check:doc-citations`
// fails an anchor whose text is no longer at its line. Most of those citations
// live in `docs/architecture/census-discovery.md`, which this lane may not edit.
// So inserting ONE line above 290 would red a guard with no fix available here.
//
// That is why the shared import at the top sits on one line with an existing
// one, and why the direct-impression handler was rewritten to exactly the line
// count it had. It is a constraint of who owns which file today, recorded so the
// next reader does not mistake the cramping for carelessness — and so it can be
// undone in one edit once the census citations are re-anchored.
//
// Everything below this point is BELOW the last cited line and is written
// normally.

/** Exposure coordinates the outcome handler reads, WITH 2891's column. */
const EXPOSURE_COLUMNS        = "id, position, served_at, session_id, features, recommendation_id";
/** The same list on a database where 2891 has not been applied. */
const EXPOSURE_COLUMNS_LEGACY = "id, position, served_at, session_id, features";

/**
 * This route's name in the rejection counter and in the schema latch. One
 * string, because a counter keyed by a value spelled differently at two call
 * sites reports two problems where there is one.
 */
const RANK_EVENTS_WRITER = "routes/rankEvents.ts";

/**
 * Test seam — re-exported rather than re-implemented.
 *
 * The latch now lives in `lib/rankEventsProvenance.ts` because BOTH writers of
 * this table talk to one database: "2891 is not applied here" is one fact about
 * the process, not one per module. The export stays on this path because the
 * suites that reset it import it from here, and moving a test seam is a change
 * to the tests rather than to the thing under test.
 */
export function _resetRecommendationIdSchemaLatch(): void {
  _resetSharedRecommendationIdLatch(); _resetOutcomeKeyLatch();   // §62: and the 3420 latch
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
  return recommendationIdSchemaAbsent() ? EXPOSURE_COLUMNS_LEGACY : EXPOSURE_COLUMNS;
}

/**
 * `isMissingRecommendationIdSchema` — the three codes that mean "2891 is not
 * applied here" — now lives in `lib/rankEventsProvenance.ts` and is re-exported
 * so the suites that import it from this path keep working. Its reasoning is in
 * that module beside the predicate itself, which is where it can also be read by
 * the serve-log writer that needs exactly the same answer.
 */
export { isMissingRecommendationIdSchema };

function noteRecommendationIdUnavailable(err: unknown, log: RouteLog | undefined, where: string): void {
  if (!noteRecommendationIdAbsent(RANK_EVENTS_WRITER)) return;   // one line per process, not one per request
  warnOn(
    log,
    { err, where, migration: RECOMMENDATION_ID_MIGRATION },
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
    // Canonicalised (§48): PostgREST reads timestamptz back as "…+00:00" and the
    // writer minted "…Z" — the same instant, a different digest.
    servedAt:  typeof row?.["served_at"]  === "string" ? canonicalServedAt(row["served_at"] as string) : "",
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
  return !recommendationIdSchemaAbsent() && RECOMMENDATION_ID_SHAPE.test(recommendationId);
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
  cas?: OutcomeCas,
): Promise<{ ok: true; duplicate?: boolean; notFound?: undefined } | { ok: false; message: string; notFound?: boolean }> {
  if (!firstErr) return cas ? settleCompareAndSet(sc, rowId, outcome, cas) : { ok: true };

  if (isMissingRecommendationIdSchema(firstErr)) {
    noteRecommendationIdUnavailable(firstErr, log, "outcome update");
    const { error: retryErr } = await compareAndSetClient(sc
      .from("rank_events")
      // The latch is now "absent", so canStampExposureToken is false and the
      // spread contributes nothing — the same patch the old helper produced.
      .update({ outcome, outcome_at: new Date().toISOString(), ...(canStampExposureToken(recommendationId) ? { recommendation_id: recommendationId } : {}) })
      .eq("id", rowId), cas);
    if (!retryErr) return cas ? settleCompareAndSet(sc, rowId, outcome, cas) : { ok: true };
    firstErr = retryErr;
  }

  // The 500 and the error line are UNCHANGED — this path was never
  // fire-and-forget and must not become quieter. What is added is the count.
  //
  // This is where `trip_add` dies today. 2894 admits it to
  // `rank_events_outcome_check` and is applied to no database, so every
  // PlanPickerController report reaches here, is refused with a 23514, and
  // answers 500 — which `useRankOutcome`'s `.catch(() => {})` then discards, so
  // the refusal is silent end to end. A 500 whose body says `db_error` cannot
  // tell an operator WHICH constraint refused it or how many times; the counter
  // can, and "rank_events_outcome_check, 412 times" is the sentence that gets
  // 2894 applied.
  reportRankEventsRejection(log, {
    writer: RANK_EVENTS_WRITER, err: firstErr, extra: { outcome, where: "outcome update" },
  });
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
      !recommendationIdSchemaAbsent() &&
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
      reportRankEventsRejection(log, { writer: RANK_EVENTS_WRITER, err: retry.error, extra: { ...ctx, where: "analytics insert" } });
      return;
    }
    // §41.1 — this is the row that carries `trip_add` into the outcome CHECK, so
    // until 2894 is applied it is REFUSED on every database, and it is refused
    // the same way the funnel update above is. Counted by constraint name, so
    // "2894 is not applied" is a sentence somebody can be told.
    reportRankEventsRejection(log, { writer: RANK_EVENTS_WRITER, err: res.error, extra: { ...ctx, where: "analytics insert" } });
  } catch (err) {
    reportRankEventsRejection(log, { writer: RANK_EVENTS_WRITER, err, extra: { ...ctx, where: "analytics insert threw" } });
  }
}

// ── The direct `living_page` impression writer ───────────────────────────────

/**
 * The exposure token for a DIRECT impression — one a client reports for itself,
 * rather than one a serve produced.
 *
 * `sessionId` is the empty string, and that is a decision rather than a gap.
 * `POST /rank-events` carries no session: the Living Destination Page opens on
 * its own, outside any ranked serve. Passing `""` makes the token a function of
 * (user, instant, surface, item) and nothing else, which is the most that is
 * KNOWN about this exposure. The alternative — minting a session id here — would
 * put a value on the row that stands for nothing, and `recommendationIdFor` is
 * deliberately total over missing coordinates for exactly this case.
 *
 * `position` is 0 because a direct view is one item, not a ranked page.
 *
 * The consequence is stated rather than hidden: two `place_view`s of one place
 * by one user in the same millisecond collapse to one token, and 2891's unique
 * index would settle the second into the first. At millisecond resolution that
 * is a double-fired client, not two views.
 */
export function directExposureToken(userId: string, itemId: string, servedAt: string, clientEventId?: string): string {
  // §48 DV-37 — a client that names its event (`client_event_id`, a UUID it
  // mints once and re-sends on every retry) gets a token that does NOT depend
  // on the server's clock, so a retried POST collides with its first landing on
  // 2891's index instead of minting a second exposure. Without one, the
  // historical token: a function of the instant, which a retry cannot reproduce
  // — stated rather than hidden, and the reason the key exists.
  if (clientEventId) {
    return recommendationIdFor({
      userId, sessionId: `client-event:${clientEventId.toLowerCase()}`, servedAt: "", surface: "living_page", position: 0, itemId,
    });
  }
  return recommendationIdFor({
    userId, sessionId: "", servedAt, surface: "living_page", position: 0, itemId,
  });
}

/** The direct-impression row, spelled out so `check:write-path-columns` can see it. */
interface DirectImpressionRow {
  event_type:        string;
  item_id:           string;
  surface:           string;
  user_id:           string;
  served_at:         string;
  outcome:           string;
  recommendation_id: string;
  /** §48 — the token came from a client event id: a repeat is a RETRY, and the first landing wins. */
  keyed?:            boolean;
}

/**
 * Write one direct impression, arbitrated by 2891's unique index where the
 * database has it.
 *
 * Three shapes, in order, and the route never learns which one ran:
 *   1. `upsert` on (recommendation_id, outcome) — a re-fired client event
 *      SETTLES into the row it already wrote instead of appending a second
 *      exposure. `ignoreDuplicates` is FALSE: DO NOTHING would make the repeat a
 *      no-op, and the requirement is that the row ends up correct.
 *   2. plain `insert` WITH the column — for a client object that has no
 *      `upsert` method. Not having the METHOD says nothing about the database's
 *      schema, so dropping the join key here would lose it for a reason that is
 *      not about the column.
 *   3. plain `insert` WITHOUT the column — once 42703 / PGRST204 / 42P10 has
 *      established that 2891 is not applied here. The column is OMITTED rather
 *      than sent as null: sending it again is the same failure a second time.
 *
 * Fire-and-forget throughout. This never throws and never rejects; the caller
 * does not await a result and has none to branch on. A refused write is COUNTED
 * and named (§41.1) instead of only warned.
 */
async function writeDirectImpression(
  sc:  any,
  row: DirectImpressionRow,
  log: RouteLog | undefined,
): Promise<void> {
  // Spelled out rather than `{ ...row }` minus a key, for the reason
  // writeOutcomeAnalyticsRow gives: a payload the AST cannot resolve is
  // invisible to check:write-path-columns, and this is an INSERT into the table
  // the whole Discovery funnel lives in.
  const bare = {
    event_type: row.event_type,
    item_id:    row.item_id,
    surface:    row.surface,
    user_id:    row.user_id,
    served_at:  row.served_at,
    outcome:    row.outcome,
  };
  const withToken = { ...bare, recommendation_id: row.recommendation_id };
  const ctx = { event_type: row.event_type, where: "direct impression" };

  try {
    const rel = sc.from("rank_events");
    const canArbitrate =
      !recommendationIdSchemaAbsent() &&
      RECOMMENDATION_ID_SHAPE.test(row.recommendation_id) &&
      typeof rel?.upsert === "function";

    // A KEYED repeat is a retry of the same client event: DO NOTHING, so the
    // first landing's served_at stands. An unkeyed repeat keeps the historical
    // DO UPDATE (the row ends up as the latest report).
    const first = canArbitrate
      ? await rel.upsert(withToken, { onConflict: RECOMMENDATION_ARBITER, ignoreDuplicates: row.keyed === true })
      : recommendationIdSchemaAbsent()
        ? await rel.insert(bare)
        : await rel.insert(withToken);
    if (!first?.error) return;

    if (isDuplicateExposureReplay(first.error)) return;   // §48 DV-37 — a keyed retry already landed (plain-insert path)
    if (isMissingRecommendationIdSchema(first.error)) {
      noteRecommendationIdUnavailable(first.error, log, "direct impression");
      const retry = await sc.from("rank_events").insert(bare);
      if (!retry?.error) return;
      reportRankEventsRejection(log, { writer: RANK_EVENTS_WRITER, err: retry.error, extra: ctx });
      return;
    }
    reportRankEventsRejection(log, { writer: RANK_EVENTS_WRITER, err: first.error, extra: ctx });
  } catch (err) {
    reportRankEventsRejection(log, { writer: RANK_EVENTS_WRITER, err, extra: { ...ctx, where: "direct impression threw" } });
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
  const bare = parsed.data.events.map((e) => ({
    event_type: e.event_type,
    item_id:    e.entity_id,
    surface:    "living_page",
    user_id:    userId,
    served_at:  servedAt,
    outcome:    "impression",
  }));
  // DV-40 — the batch mints the same token the single form does, from the same
  // coordinates, so a batched exposure is traceable to a ranking exactly as an
  // unbatched one is. A writer that mints none would reopen the gap for the one
  // shape nobody has called yet, which is the easiest place for it to hide.
  //
  // Two positions of ONE item inside a batch would collide (same user, same
  // batch clock, same item, position 0) and 2891's index would make the upsert
  // touch one row twice — a 21000 on the WHOLE statement, which for an
  // all-or-nothing batch means every row lost. So the position is the item's
  // INDEX in the batch, which is also the truthful thing to say about it.
  // §48 DV-38 — every event in the batch declares a version this server reads,
  // or none; one unknown version refuses the whole batch, naming its index.
  for (let i = 0; i < parsed.data.events.length; i++) {
    const check = checkEventSchemaVersion(parsed.data.events[i]!.schema_version);
    if (!check.ok) { sendError(res, "invalid_payload", `events.${i}.schema_version: unsupported_schema_version: ${check.reason}`); return; }
  }
  // §48 DV-37 — an event the client NAMED (`client_event_id`) takes a token that
  // does not depend on this flush's clock, so a retried flush collides with the
  // one that landed instead of doubling every exposure in it.
  const rows = bare.map((r, idx) => {
    const cid = parsed.data.events[idx]!.client_event_id;
    return { ...r, recommendation_id: cid
      ? directExposureToken(userId, r.item_id, servedAt, cid)
      : recommendationIdFor({ userId, sessionId: "", servedAt, surface: "living_page", position: idx, itemId: r.item_id }) };
  });
  const keyedBatch = parsed.data.events.some((e) => e.client_event_id !== undefined);
  if (keyedBatch && !recommendationIdSchemaAbsent()) { await handleKeyedDirectBatch(req, res, sc, rows); return; }

  const attempt = recommendationIdSchemaAbsent()
    ? await sc.from("rank_events").insert(bare)
    : await sc.from("rank_events").insert(rows);
  // Unlike every other writer in this file the batch is NOT fire-and-forget — it
  // answers `db_error` and writes nothing — so a 2891-less database must not be
  // allowed to turn it into a permanent 500. Same three codes, same latch, one
  // retry in the pre-2891 shape.
  let error = attempt?.error ?? null;
  if (error && isMissingRecommendationIdSchema(error)) {
    noteRecommendationIdUnavailable(error, req.log, "direct impression batch");
    error = (await sc.from("rank_events").insert(bare))?.error ?? null;
  }
  if (error) {
    // Counted as well as raised: this statement carries `surface: "living_page"`,
    // one of §41.1's two wrongly-writerless surfaces, and a batch refused by the
    // surface CHECK should be countable next to the single form's refusals
    // rather than only visible as a 500 in a request log.
    reportRankEventsRejection(req.log, {
      writer: RANK_EVENTS_WRITER, err: error, rows: rows.length,
      extra: { where: "direct impression batch" },
    });
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

// ═══════════════════════════════════════════════════════════════════════════════
// census-discovery §48 — versioned, BOUND, retry-safe ingestion (DV-37, DV-38, DV-46)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The served-recommendation contract is lib/discoveryRecommendationRecord.ts.
// Three properties are enforced here, each at the door rather than downstream:
//
//   VERSIONED (DV-38)  A body that declares a `schema_version` this server does
//                      not read is refused 400 `unsupported_schema_version`.
//                      Absent ⇒ version 1: every client that exists predates the
//                      field, and refusing them would be an outage, not a check.
//
//   BOUND (DV-46)      An outcome that echoes the served `recommendation_id` is
//                      credited to THAT exposure and to no other: the lookup is
//                      (signed-in caller, id). Another viewer's id, an anonymous
//                      id, an unknown id → 404, credits nothing. An id naming a
//                      different item or surface → 409. An id whose exposure has
//                      already moved past this outcome → 404 (stale). Without an
//                      id, the historical item lookup, unchanged.
//
//   RETRY-SAFE (DV-37) The funnel update is COMPARE-AND-SET on the row's current
//                      outcome. Of two concurrent identical reports exactly one
//                      moves the row; the other — and any later replay of an
//                      outcome already recorded — is answered 200
//                      `{ duplicate: true }` and moves NO counter a second time
//                      (no second Compass link, no second negative signal). The
//                      analytics row is an upsert on (recommendation_id,
//                      'analytics'), so re-driving it on a replay completes a
//                      first attempt that died after the update: a partial
//                      failure followed by a retry converges.

/** DV-38 — refuse an event whose declared schema version this server cannot read. */
function acceptsEventVersion(res: any, v: unknown): boolean {
  const check = checkEventSchemaVersion(v);
  if (check.ok) return true;
  sendError(res, "invalid_payload", `unsupported_schema_version: ${check.reason}`);
  return false;
}

/** What a claimed-id lookup reads: enough to bind, and to re-derive nothing. */
const CLAIMED_EXPOSURE_COLUMNS        = "id, user_id, item_id, surface, outcome, position, served_at, session_id, features, recommendation_id";
const CLAIMED_EXPOSURE_COLUMNS_LEGACY = "id, user_id, item_id, surface, outcome, position, served_at, session_id, features";

/**
 * The exposure a claimed id names — for THIS viewer only, and never the
 * analytics row that shares its token. Matched on 2891's column OR on
 * `features.recommendationId` (every serve-log row since §13.3 carries it
 * there), so a row written before the column was filled still binds.
 */
async function readClaimedExposure(
  sc: any, userId: string, rid: string, log: RouteLog | undefined,
): Promise<{ row: any | null; error: any | null }> {
  // `rid` passed the shape CHECK at the zod boundary ([A-Za-z0-9_-]{22}), so it
  // cannot carry a PostgREST filter delimiter into the `or` expression.
  const first = recommendationIdSchemaAbsent()
    ? await sc.from("rank_events").select(CLAIMED_EXPOSURE_COLUMNS_LEGACY)
        .eq("user_id", userId).eq("features->>recommendationId", rid).neq("outcome", "analytics")
        .order("served_at", { ascending: false }).limit(1)
    : await sc.from("rank_events").select(CLAIMED_EXPOSURE_COLUMNS)
        .eq("user_id", userId).or(`recommendation_id.eq.${rid},features->>recommendationId.eq.${rid}`).neq("outcome", "analytics")
        .order("served_at", { ascending: false }).limit(1);
  if (!first?.error) return { row: ((first?.data as any[]) ?? [])[0] ?? null, error: null };
  if (!isMissingRecommendationIdSchema(first.error)) return { row: null, error: first.error };
  noteRecommendationIdUnavailable(first.error, log, "claimed-id select");
  const second = await sc.from("rank_events").select(CLAIMED_EXPOSURE_COLUMNS_LEGACY)
    .eq("user_id", userId).eq("features->>recommendationId", rid).neq("outcome", "analytics")
    .order("served_at", { ascending: false }).limit(1);
  if (second?.error) return { row: null, error: second.error };
  return { row: ((second?.data as any[]) ?? [])[0] ?? null, error: null };
}

/**
 * Answer a binding that credits nothing. Returns true when it answered.
 * `not_found` never says WHY — whether the id belongs to somebody else is not
 * this caller's to learn.
 */
export function refuseUnboundOutcome(res: any, binding: OutcomeBinding): boolean {
  switch (binding.kind) {
    case "bound":
    case "duplicate":
      return false;
    case "not_found":
      sendError(res, "not_found", "No exposure with this recommendation_id for this viewer");
      return true;
    case "mismatch":
      sendError(res, "conflict", `recommendation_id names a different ${binding.field} than this event`);
      return true;
    case "not_upgradable":
      sendError(res, "not_found", "stale: this exposure has already moved past this outcome");
      return true;
  }
}

/** The compare-and-set state one outcome report carries through the update. */
export interface OutcomeCas {
  /** The outcomes the row may hold for this report to move it. */
  upgradable: string[];
  /** true: this report moved the row · false: it did not (someone else did) · null: unknown (no CAS available). */
  applied:    boolean | null;
  /** The binding already knows this is a replay: do not touch the row. */
  skip:       boolean;
}

export function newOutcomeCas(outcome: OutcomeValue, binding: OutcomeBinding | null): OutcomeCas {
  return { upgradable: upgradableOutcomesFor(outcome), applied: null, skip: binding?.kind === "duplicate" };
}

/**
 * COMPARE-AND-SET over an update the caller already built:
 * `compareAndSetClient(sc.from("rank_events").update(p).eq(c, v), cas)`. The
 * update also requires the row's outcome to still be upgradable, and returns
 * the rows it moved so the caller learns whether IT moved the row. The caller
 * spells the table and payload, so check:write-path-columns reads them there.
 * With no `cas` the built update is returned untouched (the keyless path).
 * Real PostgREST builders are lazy, so a skipped update is never sent.
 *
 */
export function compareAndSetClient(built: any, cas?: OutcomeCas): any {
  // Before, this wrapped the CLIENT and issued `sc.from(table).update(patch)`
  // itself: a site whose table and payload were both variables, which the
  // column check reported as a new blind spot on 23e976fcf. Taking the built
  // update removes that second site; for lazy builders nothing else changes.
  if (!cas) return built;
  if (cas.skip) { cas.applied = false; return Promise.resolve({ data: [], error: null }); }
  // Real builders carry `.in` and `.select` after `.eq`, so production always
  // gets the guard. A narrower builder (a test double whose `.eq` already
  // resolves) passes through with `applied: null` — "unknown", never "won" —
  // which is the pre-§48 behaviour, and the route treats it that way.
  if (typeof built?.in !== "function") { cas.applied = null; return built; }
  const narrowed = built.in("outcome", cas.upgradable);
  const counted = typeof narrowed?.select === "function" ? narrowed.select("id") : narrowed;
  return Promise.resolve(counted).then((r: any) => {
    cas.applied = r?.error ? null : Array.isArray(r?.data) ? r.data.length > 0 : null;
    return r;
  });
}

/**
 * The update landed without error; did THIS report move the row?
 *   applied true/null → it did (or we cannot know): the historical answer.
 *   applied false     → it did not. If the row now holds this outcome, this
 *                       report is a duplicate of one that did: 200, no side
 *                       effects. Otherwise the row moved elsewhere: stale, 404.
 */
async function settleCompareAndSet(
  sc: any, rowId: unknown, outcome: OutcomeValue, cas: OutcomeCas,
): Promise<{ ok: true; duplicate?: boolean } | { ok: false; message: string; notFound?: boolean }> {
  if (cas.applied !== false) return { ok: true };
  if (cas.skip) return { ok: true, duplicate: true };
  const { data, error } = await sc.from("rank_events").select("outcome").eq("id", rowId).maybeSingle();
  if (error) return { ok: false, message: String(error?.message ?? "db_error") };
  const current = (data as { outcome?: unknown } | null)?.outcome;
  if (current === outcome) return { ok: true, duplicate: true };
  // Moved by a concurrent report to an outcome this one may not replace: stale.
  if (typeof current === "string" && !cas.upgradable.includes(current)) {
    return { ok: false, notFound: true, message: "stale: this exposure moved to another outcome concurrently" };
  }
  // The statement reported no row moved, yet the row is absent or still
  // upgradable. A database cannot produce that (the WHERE that refused it is
  // the same one this re-read contradicts); a client that reports no rows for
  // every update can. Answer as before §48 — success — rather than invent a
  // refusal out of a missing count.
  return { ok: true };
}

/**
 * The keyed batch: `INSERT … ON CONFLICT (recommendation_id, outcome) DO
 * NOTHING`, returning the rows that landed. A replayed flush lands nothing and
 * is told so — `accepted` counts the NEW rows, `duplicates` the rest — instead
 * of the all-or-nothing plain insert refusing the whole retry with a 23505 and
 * answering it as a 500. Still all-or-nothing for any OTHER refusal.
 */
async function handleKeyedDirectBatch(req: any, res: any, sc: any, rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  // Two events naming the same client event AND item are one event: send once.
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const k = String(r["recommendation_id"]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rel = sc.from("rank_events");
  const attempt = typeof rel?.upsert === "function"
    ? await rel.upsert(unique, { onConflict: RECOMMENDATION_ARBITER, ignoreDuplicates: true }).select("id")
    : await rel.insert(unique);
  let error = attempt?.error ?? null;
  if (error && isDuplicateExposureReplay(error)) {
    // The plain-insert path (no upsert on this client): the whole replay collided.
    res.json({ ok: true, accepted: 0, duplicates: rows.length });
    return;
  }
  if (error) {
    reportRankEventsRejection(req.log, {
      writer: RANK_EVENTS_WRITER, err: error, rows: unique.length,
      extra: { where: "keyed direct impression batch" },
    });
    (req.log?.error ?? console.error).call(req.log ?? console, { err: error, count: unique.length },
      "rank-events: keyed batch insert rejected — NOTHING was written");
    sendError(res, "db_error", error.message);
    return;
  }
  const landed = Array.isArray(attempt?.data) ? attempt.data.length : unique.length;
  res.json({ ok: true, accepted: landed, duplicates: rows.length - landed });
}

export default router;

// ═══════════════════════════════════════════════════════════════════════════════
// census-discovery §55 — DV-41: `04` §7 dwell quality, POST /rank-events/dwell
// ═══════════════════════════════════════════════════════════════════════════════
//
// APPENDED BELOW `export default router` ON PURPOSE. Census rows cite this file
// by line (179, 228, 229-238, 600, 1083, 1138 …), so every existing line keeps
// its position and text; a registration after the default export still runs at
// module evaluation, before any importer mounts the router.
//
// A SIBLING PATH, NOT A BRANCH OF /rank-events/outcome: a dwell is not a funnel
// rung (the outcome zod enum refuses it, and a dwell must never upgrade the
// exposure's outcome), and the contract names no route for it. Everything but
// the authentication lives in lib/discoveryDwell.ts: the owner's flag (3395,
// seeded FALSE — off ⇒ 404 feature_disabled, nothing read, nothing written), the
// (caller, recommendation_id) binding, and the retry-idempotent write.
import { acceptDiscoveryDwell } from "../lib/discoveryDwell.js";

router.post("/rank-events/dwell", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  await acceptDiscoveryDwell(getServiceClient(), req, res, auth.user.id);
}));

// ═══════════════════════════════════════════════════════════════════════════════
// census-discovery §62 — DV-37: a KEYED outcome lands once (migration 3420)
// ═══════════════════════════════════════════════════════════════════════════════
//
// APPENDED HERE, below every cited line, and reached from the outcome handler by
// hoisted declaration (the handler's edits are each on a line it already had).
//
// THE DEFECT (§59.1, db/discoveryVerifyChain V7). An outcome with no
// recommendation_id moves "the most recent upgradable row for (viewer, item,
// surface)". A sequential retry, after the item was served twice, found the
// SECOND exposure and moved it too: one "Not interested", two dismisses, two
// negative signals, and the retry answered as a new outcome. The server cannot
// tell a retry from a second action without an identity for the action.
//
// THE IDENTITY is `client_event_id`, exactly as POST /rank-events takes it: the
// same validator (directEventSchema's field, reused at the schema), minted once
// per user action by the client and re-sent on every retry of that action. And
// the same kind of mechanism: a unique key the database arbitrates. An outcome
// UPDATEs an exposure whose recommendation_id is the SERVED id, so the key gets
// its own arbiter (3420): the UPDATE writes `outcome_client_event_id`, and a
// trigger records the landing in `rank_event_outcome_receipts`, PRIMARY KEY
// (user_id, client_event_id), in the same statement.
//
//   1. A key that already landed is FOUND first (readOutcomeReceipt) and
//      answered 200 `{ duplicate: true }`: no row moves, no Compass link, no
//      negative signal. If its exposure still holds this outcome, the analytics
//      row is re-driven (an upsert on its own key), so a first attempt that died
//      after the update converges exactly as the recommendation_id path does.
//      A key re-used for a different item, surface or outcome is a client bug
//      and is refused 409, never silently merged.
//   2. Two copies racing past the lookup: if both pick the same exposure,
//      compare-and-set moves it once and the other is `duplicate` (unchanged
//      §48 behaviour); if the second picks ANOTHER exposure, its UPDATE collides
//      on the receipt's key, the database rolls it back (23505), and it is
//      answered `duplicate` with no side effect — not even an analytics row for
//      the exposure it did not move.
//
// A KEYLESS OUTCOME IS UNCHANGED: it sends no key, reads no receipt, fires no
// trigger. A genuine second dismissal still counts. Refusing keyless outcomes
// would stop every client build shipped before the client half of §62 from
// recording anything; that is a rollout decision (census-discovery §62.7), so
// until the owner takes it a keyless retry after a second serve still
// double-counts.
//
// WITHOUT 3420 (production, 2026-09-27) the route degrades the way it does for
// 2891: the first refusal naming the missing table or column is said ONCE per
// process, latched, and the outcome is recorded keyless — never a 500 on an
// endpoint whose job is to record a signal. The key's own failures (a receipt
// read that errors for any other reason) are a 500, because answering them
// keyless could double-count the very retry the key exists to recognise, and
// the client will retry with the same key.

/** Where the process believes 3420 stands. `unknown` = not disproved. */
let _outcomeKeySchema: "unknown" | "absent" = "unknown";

/** Test seam — forget what this process learned about 3420. */
export function _resetOutcomeKeyLatch(): void {
  _outcomeKeySchema = "unknown";
}

/** May the keyed UPDATE name `outcome_client_event_id`? False once 3420 is known absent here. */
export function canStampOutcomeKey(): boolean {
  return _outcomeKeySchema !== "absent";
}

/**
 * Is this error "3420 is not applied here"? The four shapes PostgREST and
 * PostgreSQL give a missing table or column, and ONLY when they name 3420's
 * objects: `isMissingRecommendationIdSchema` answers true for ANY 42703 /
 * PGRST204, so the handler must ask this first or a missing key column would
 * be misread as a missing 2891 and latch the wrong migration absent.
 */
export function isMissingOutcomeKeySchema(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; details?: unknown } | null | undefined;
  const code = String(e?.code ?? "");
  if (!["42703", "PGRST204", "42P01", "PGRST205"].includes(code)) return false;
  const text = `${String(e?.message ?? "")} ${String(e?.details ?? "")}`;
  return text.includes("outcome_client_event_id") || text.includes("rank_event_outcome_receipts");
}

/** Is this the receipt's key refusing a second landing of one client event? */
export function isOutcomeReceiptCollision(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; details?: unknown } | null | undefined;
  if (String(e?.code ?? "") !== "23505") return false;
  return `${String(e?.message ?? "")} ${String(e?.details ?? "")}`.includes("rank_event_outcome_receipts");
}

function noteOutcomeKeyUnavailable(err: unknown, log: RouteLog | undefined, where: string): void {
  if (_outcomeKeySchema === "absent") return;   // one line per process, not one per request
  _outcomeKeySchema = "absent";
  warnOn(log, { err, where, migration: "3420_rank_events_outcome_receipts.sql" },
    "rank-events/outcome: 3420 is not applied — keyed outcomes are recorded KEYLESS, so a retry after a second serve can move a second exposure until it is");
}

/** A key that already landed, as its receipt recorded it. */
export interface OutcomeReceiptHit {
  rankEventId: string;
  itemId:      string;
  surface:     string;
  outcome:     string;
  /** The exposure the key moved, as it is NOW; null if it could not be read or no longer exists. */
  exposure:    Record<string, unknown> | null;
}

/**
 * The receipt of this viewer's key, if the key already landed. `hit: null` with
 * no error when there is no key, no receipt, or no 3420 (latched). The shape is
 * the handler's `picked` shape, so one line can fold it in.
 */
async function readOutcomeReceipt(
  sc: any, userId: string, clientEventId: string | undefined, log: RouteLog | undefined,
): Promise<{ row: any | null; error: any | null; hit: OutcomeReceiptHit | null }> {
  const none = { row: null, error: null, hit: null };
  if (!clientEventId || !canStampOutcomeKey()) return none;
  const r = await sc.from("rank_event_outcome_receipts")
    .select("rank_event_id, item_id, surface, outcome")
    .eq("user_id", userId).eq("client_event_id", clientEventId)
    .maybeSingle();
  if (r?.error) {
    if (isMissingOutcomeKeySchema(r.error)) { noteOutcomeKeyUnavailable(r.error, log, "receipt read"); return none; }
    return { row: null, error: r.error, hit: null };
  }
  if (!r?.data) return none;
  const d = r.data as { rank_event_id: string; item_id: string; surface: string; outcome: string };
  // The exposure is read only to re-drive its analytics row; a failed read here
  // loses that convergence, not the answer, so it is warned and not a 500.
  const ex = recommendationIdSchemaAbsent()
    ? await sc.from("rank_events").select(CLAIMED_EXPOSURE_COLUMNS_LEGACY).eq("id", d.rank_event_id).eq("user_id", userId).maybeSingle()
    : await sc.from("rank_events").select(CLAIMED_EXPOSURE_COLUMNS).eq("id", d.rank_event_id).eq("user_id", userId).maybeSingle();
  if (ex?.error) warnOn(log, { err: ex.error, where: "keyed replay exposure read" }, "rank-events/outcome: a landed key's exposure could not be read — answered duplicate without re-driving its analytics row");
  const exposure = ex?.error ? null : ((ex?.data as Record<string, unknown> | null) ?? null);
  const hit: OutcomeReceiptHit = { rankEventId: d.rank_event_id, itemId: d.item_id, surface: d.surface, outcome: d.outcome, exposure };
  return { row: exposure ?? { id: d.rank_event_id }, error: null, hit };
}

/**
 * Answer a key that already landed: 200 `{ ok, duplicate }`, or 409 when the
 * key names a different event. Moves no row and no counter.
 */
async function answerKeyedReplay(
  sc: any, res: any, hit: OutcomeReceiptHit,
  q: { userId: string; itemId: string; surface: string; outcome: OutcomeValue; sessionId: string | null },
  log: RouteLog | undefined,
): Promise<void> {
  if (hit.itemId !== q.itemId || hit.surface !== q.surface || hit.outcome !== q.outcome) {
    const field = hit.itemId !== q.itemId ? "item" : hit.surface !== q.surface ? "surface" : "outcome";
    sendError(res, "conflict", `client_event_id already names an outcome with a different ${field}`);
    return;
  }
  // Convergence, as the recommendation_id replay has it: while the exposure
  // still holds this outcome, re-drive its analytics row (an upsert on its own
  // key, so a repeat is an upgrade of one row). Once a stronger outcome has
  // moved it, that outcome owns the analytics row and nothing is re-driven.
  const analyticsEventType = OUTCOME_TO_ANALYTICS_EVENT[q.outcome];
  if (analyticsEventType && hit.exposure && hit.exposure["outcome"] === q.outcome) {
    void writeOutcomeAnalyticsRow(sc, {
      event_type: analyticsEventType, item_id: q.itemId, surface: q.surface, user_id: q.userId,
      session_id: q.sessionId, served_at: new Date().toISOString(), outcome: "analytics",
      recommendation_id: exposureTokenFor(hit.exposure, q.userId, q.itemId, q.surface),
    }, log, { outcome: q.outcome, analyticsEventType });
  }
  res.json({ ok: true, duplicate: true });
}

/**
 * settleOutcomeUpdate, with the key's two outcomes in front of it:
 *   - the receipt's key refused the UPDATE (23505): this copy of a keyed
 *     outcome picked ANOTHER exposure after its first copy landed — the row did
 *     not move, answer `duplicate` and move nothing (`keyedCollision`);
 *   - 3420 is missing: latch it, say so once, redo the same compare-and-set
 *     WITHOUT the key, and settle that — the outcome is recorded keyless.
 * Everything else is settleOutcomeUpdate's, unchanged.
 */
async function settleKeyedOutcomeUpdate(
  sc: any, rowId: unknown, outcome: OutcomeValue, recommendationId: string, firstErr: any,
  log: RouteLog | undefined, cas: OutcomeCas | undefined, clientEventId: string | undefined,
): Promise<{ ok: true; duplicate?: boolean; notFound?: undefined; keyedCollision?: boolean } | { ok: false; message: string; notFound?: boolean }> {
  if (clientEventId && firstErr) {
    if (isOutcomeReceiptCollision(firstErr)) return { ok: true, duplicate: true, keyedCollision: true };
    if (isMissingOutcomeKeySchema(firstErr)) {
      noteOutcomeKeyUnavailable(firstErr, log, "outcome update");
      const { error: retryErr } = await compareAndSetClient(sc
        .from("rank_events")
        .update({ outcome, outcome_at: new Date().toISOString(), ...(canStampExposureToken(recommendationId) ? { recommendation_id: recommendationId } : {}) })
        .eq("id", rowId), cas);
      return settleOutcomeUpdate(sc, rowId, outcome, recommendationId, retryErr, log, cas);
    }
  }
  return settleOutcomeUpdate(sc, rowId, outcome, recommendationId, firstErr, log, cas);
}

// ═══════════════════════════════════════════════════════════════════════════════
// census-discovery §82 (lane W10-O) — DV-37 / D-9: a KEYLESS outcome is accepted,
// marked unkeyed, and a retry of it lands once. Register D-W10-O-5.
// ═══════════════════════════════════════════════════════════════════════════════
//
// APPENDED, below every cited line. The handler reaches it through two edits,
// each on a line it already had: the upgradable lookup is called through
// `readKeylessOrUpgradable`, and a keyless replay is answered beside the keyed
// one.
//
// THE QUESTION (§62.7 Q1): every client build shipped before §62's H1 sends
// outcomes with no `client_event_id`. Mint a key for them on the server, refuse
// them, or accept them marked unkeyed?
//
//   * A server-minted key is minted per REQUEST, so a retry gets a new one: it
//     would identify nothing, and it would make an unkeyed outcome look keyed.
//   * Refusing them loses every outcome the shipped builds record — every
//     "Not interested", open, save and trip add — until the keyed build is the
//     floor. Refusal becomes right only then, and that is a release decision.
//   * DECIDED: accept them, MARKED unkeyed, and bound the retry. The mark is
//     3420's own column: a keyless outcome leaves `outcome_client_event_id`
//     NULL, so every reader can tell a keyed landing from an unkeyed one.
//
// THE RETRY BOUND. Without a key the server cannot tell a retry from a second
// action, so it uses the natural key the defect is about: (viewer, item,
// surface[, session]) and the outcome. A keyless outcome that would move a
// SECOND exposure while the same outcome — or one that subsumes it — LANDED on
// another exposure of that key within KEYLESS_OUTCOME_RETRY_WINDOW_MS is a
// retry: answered 200 `{ duplicate: true }`, nothing moves, no Compass link, no
// negative signal, no analytics row.
//
// WHY TEN MINUTES. A shipped build's retry is the user pressing again, or the
// app re-sending on the next screen: seconds to minutes, inside one visit. Ten
// minutes is also CACHE_B_TTL_MS: inside it, a second serve of the same item is
// most likely the SAME ranked page replayed from Cache B, i.e. the same
// recommendation, so "the same outcome on another exposure of it" is the same
// act. What it costs: a GENUINE repeat of the same act on a genuinely new serve
// inside ten minutes counts once. For `dismiss` that cannot happen (a dismissed
// place is filtered from every serve path). For a tap it can; the funnel then
// under-counts one repeat open, which is the lesser error than V7's double
// negative signal. Outside the window the keyless path behaves as before.
//
// A KEYED request never takes this path: the client said, by minting a new key,
// that it is a new action, and the key — not a clock — is its arbiter.

/** The landing read's columns (a literal const, so check:write-path-columns resolves it). */
export const KEYLESS_LANDING_COLUMNS = "id, outcome, outcome_at";

/** How long a keyless landing makes the same keyless outcome on another exposure a retry. */
export const KEYLESS_OUTCOME_RETRY_WINDOW_MS = 10 * 60_000;

/**
 * The outcomes whose landing makes a keyless `outcome` a retry: the outcome
 * itself, and every funnel outcome that can have consumed it (the rows a retry
 * would find "already past" this rung). `dismiss` is terminal and stands alone.
 */
export function keylessLandingOutcomesFor(outcome: OutcomeValue): readonly OutcomeValue[] {
  if (outcome === DISMISS) return [DISMISS];
  return OUTCOME_VALUES.filter((o) => o === outcome || (o !== DISMISS && upgradableOutcomesFor(o).includes(outcome)));
}

/**
 * The upgradable lookup, and — for a KEYLESS outcome that found a row — the
 * retry check. `keylessReplay: true` means "answer duplicate, move nothing".
 * A failed landing read is returned as an error (the handler answers 500):
 * guessing either way could double-count the retry this exists to recognise,
 * and the client will retry.
 */
async function readKeylessOrUpgradable(
  sc: any,
  query: any,
  clientEventId: string | undefined,
  f: { userId: string; itemId: string; surface: string; outcome: OutcomeValue; sessionId?: string },
  log: RouteLog | undefined,
): Promise<{ row: any | null; error: any | null; keylessReplay: boolean }> {
  const picked = await readUpgradableExposure(sc, query, f, log);
  if (picked.error || !picked.row || clientEventId) return { ...picked, keylessReplay: false };
  const nowMs = Date.now();
  let landed = sc.from("rank_events")
    .select(KEYLESS_LANDING_COLUMNS)
    .eq("user_id", f.userId)
    .eq("item_id", f.itemId)
    .eq("surface", f.surface)
    .in("outcome", [...keylessLandingOutcomesFor(f.outcome)]);
  if (f.sessionId) landed = landed.eq("session_id", f.sessionId);
  // Newest landing first, NULLs last (PostgreSQL puts NULLs FIRST on DESC). The
  // window is applied below rather than as a range filter, so the check needs
  // nothing of a client beyond the filters the upgradable lookup already uses.
  const r = await landed.order("outcome_at", { ascending: false, nullsFirst: false }).limit(5);
  if (r?.error) {
    (log?.error ?? console.error).call(log ?? console, { err: r.error }, "rank-events/outcome: keyless retry check failed");
    return { row: null, error: r.error, keylessReplay: false };
  }
  // The window: only a landing at or after (now − window) is a retry.
  const hit = ((r?.data as Array<{ id: unknown; outcome_at: unknown }>) ?? []).some((x) =>
    x.id !== picked.row.id && typeof x.outcome_at === "string" && Date.parse(x.outcome_at) >= nowMs - KEYLESS_OUTCOME_RETRY_WINDOW_MS);
  return hit ? { row: null, error: null, keylessReplay: true } : { ...picked, keylessReplay: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// census-discovery §83 (lane B-DISCOVERY) — DV-UNDO: undoing a "Not interested"
// POST /rank-events/undo-dismiss
// ═══════════════════════════════════════════════════════════════════════════════
//
// APPENDED BELOW EVERY CITED LINE, for the reason the §55/§62/§82 sections give:
// eight anchored doc citations point into lines 44-290 of this file. The ONE edit
// inside that range (the numerator guard at :262-263) is written on lines it
// already had, so no citation moves.
//
// WHAT WAS MISSING. `lib/discoveryDismissed.ts` states the cost of its own design
// out loud — "a viewer who dismisses a lot in a thin city shrinks their own
// results and there is no in-product way to undo one" — and `rank_events` has
// only ever had three writers for this surface (`POST /rank-events`,
// `/rank-events/outcome`, `/rank-events/dwell`). There was no undo at all.
//
// A DOWNGRADE, NOT A DELETE. The undo sets `outcome` back to `'impression'` and
// clears `outcome_at`. It does NOT delete the row, and that is the whole point:
// the row IS the exposure record, and `content_distribution_stats`'
// eligible_impressions denominator is built from exposures (2297:36-44, :148-149
// — "an outcome must never move the exposure denominator"). Deleting it would
// destroy a real impression to retract an outcome, which is exactly the defect
// 2297 was written to avoid, from the other side. Everything the viewer expects
// an undo to restore is DERIVED FROM THE ROW AT READ TIME and therefore needs no
// separate repair:
//   • the place reappears — lib/discoveryDismissed.ts reads outcome='dismiss';
//   • the per-viewer category penalty lifts — DiscoveryRankingService :1567-1570;
//   • eligibility, place momentum (3417) and Trail positives all re-derive.
//
// WHAT THE UNDO DOES *NOT* ERASE, AND WHY — THE OWNER'S OPEN QUESTION
// ===================================================================
// `content_distribution_stats.negative_signal_count`, already incremented by the
// dismiss through `record_distribution_negative_signal` (2297:123-169), is NOT
// decremented. This is the DEFAULT, taken deliberately, and it is the owner's
// open question — the only accumulator affected:
//
//   1. NO DECREMENT EXISTS. 2297's RPC is increment-only; there is no inverse
//      anywhere in the schema, and inventing one here would make this route the
//      sole writer able to lower a cross-viewer ranking statistic.
//   2. IT CANNOT BE ATTRIBUTED. The RPC accepts `p_viewer_id` and deliberately
//      does not use it (2297:115-117 — "accepted and unused … so a future
//      per-viewer dedup has a place to stand"). The counter therefore carries no
//      record of WHOSE dismissals built it, so "subtract mine" is not a
//      statement the data can express.
//   3. IT IS A DIFFERENT KIND OF FACT. The counter is a global exposure
//      statistic — how often this item was waved away, across everyone — not a
//      record of this person's preference. The person's preference is the row,
//      and the row is what the undo restores.
//   4. 2297'S OWN ROLLBACK REFUSES THE SAME THING, in the same words:
//      "deleting recorded user feedback is a retention decision, not a rollback"
//      (db/rollback/2026-09-28-2297-rank-events-dismiss-outcome-rollback.sql:40-43).
//
// So the undo is honest about its reach: the viewer's own results are fully
// restored; one aggregate statistic keeps the single increment it already took.
// If the owner decides otherwise, the change is a decrementing RPC plus
// per-viewer attribution in 2297's function — not a change to this route.
//
// IDEMPOTENCE AGAINST SIGNAL INFLATION
// ====================================
// Given (1), a dismiss → undo → re-dismiss loop would be a free way to inflate a
// cross-viewer statistic: one tap each way, +1 to `negative_signal_count` every
// time round. `/rank-events/outcome`'s existing guard does not stop it. That
// guard is `!settled.duplicate`, which keys on `client_event_id` / the receipt
// (§62) — and a re-dismiss is a NEW user action, so the client mints a NEW key
// and no receipt matches. The §82 keyless window does not stop it either: it is
// ten minutes wide and compares landings, not undos.
//
// THE MECHANISM CHOSEN: an explicit idempotence marker, `features.<KEY>`, set by
// the undo and consulted by the dismiss path before it touches the counter.
// Why this one rather than preserving `outcome_client_event_id` across the
// downgrade:
//   • preserving the key only recognises a RETRY of the original dismiss (same
//     key). It cannot recognise a genuinely new re-dismiss, which is precisely
//     the loop. The column is nonetheless left ALONE by the undo, so a retry of
//     the original dismiss still settles against its receipt as §62 intends;
//   • the marker says the thing that is actually true and durable — "this
//     viewer's negative signal for this item has already been banked in a
//     counter that cannot be un-banked" — and it survives the place being served
//     again, which a per-row outcome field would not;
//   • `features` is a jsonb column that exists on every database this code runs
//     on, so the guard needs no migration and cannot be defeated by an unapplied
//     one. A marker column behind a pending migration would leave production —
//     the only place the loop matters — unguarded.
//
// The guard is read-modify-write on a row keyed to the caller, so it races only
// with this viewer's own ranking features for this exposure.

/** The `features` key that records "this viewer's negative signal for this item is already banked". */
export const NEGATIVE_SIGNAL_BANKED_KEY = "negativeSignalCounted";

/** Does this row's `features` already carry the banked marker? */
export function hasBankedNegativeSignal(features: unknown): boolean {
  if (!features || typeof features !== "object" || Array.isArray(features)) return false;
  return (features as Record<string, unknown>)[NEGATIVE_SIGNAL_BANKED_KEY] === true;
}

/** `features` with the banked marker set, preserving every key already on it. */
export function bankNegativeSignal(features: unknown): Record<string, unknown> {
  const base = features && typeof features === "object" && !Array.isArray(features)
    ? (features as Record<string, unknown>)
    : {};
  return { ...base, [NEGATIVE_SIGNAL_BANKED_KEY]: true };
}

/**
 * Has this viewer's negative signal for this item already been banked?
 *
 *   counted     — yes: the increment has happened and must not happen again.
 *   not_counted — no: the dismiss may move the counter.
 *   unknown     — the read did not complete.
 *
 * `unknown` MUST NOT be treated as `not_counted`. The repo's rule is that a
 * check which cannot establish its result fails, and here "failing" means not
 * writing: the counter is cross-viewer and increment-only, so a wrong +1 is
 * permanent and un-retractable (see the §83 note above), while a missed +1 is a
 * single under-count of a ratio the classifier already evaluates over hundreds
 * of impressions. The loss is logged at error level, named, and never silent.
 * The dismissal itself is unaffected — it is already recorded on the row by the
 * time this runs, and the numerator write was always fire-and-forget.
 */
const BANKED_SIGNAL_COLUMNS = "id";

export type NegativeSignalBankState = "counted" | "not_counted" | "unknown";

async function negativeSignalBanked(
  sc: any,
  userId: string,
  itemId: string,
  surface: string,
  row: Record<string, unknown> | null | undefined,
  log: RouteLog | undefined,
): Promise<NegativeSignalBankState> {
  // The exposure this dismiss just moved is the common case: no read needed.
  if (hasBankedNegativeSignal(row?.["features"])) return "counted";
  try {
    // Any OTHER exposure of this item for this viewer may carry the marker: an
    // undo makes the place servable again, so the re-dismiss usually lands on a
    // NEWER impression row than the one that was undone.
    const { data, error } = await sc
      .from("rank_events")
      .select(BANKED_SIGNAL_COLUMNS)
      .eq("user_id", userId)
      .eq("item_id", itemId)
      .eq("surface", surface)
      .eq(`features->>${NEGATIVE_SIGNAL_BANKED_KEY}`, "true")
      .limit(1);
    // supabase-js RESOLVES with `{ error }` on a PostgREST rejection rather than
    // throwing (CONTRIBUTING.md's rank_events entry), so `error` is destructured
    // and inspected. A try/catch alone would read a refusal as "no marker".
    if (error || !Array.isArray(data)) {
      (log?.error ?? console.error).call(log ?? console,
        { err: error ?? null, itemId, surface },
        "rank-events/outcome: the negative-signal idempotence read did not complete — negative_signal_count was NOT incremented for this dismiss");
      return "unknown";
    }
    return data.length > 0 ? "counted" : "not_counted";
  } catch (err) {
    (log?.error ?? console.error).call(log ?? console,
      { err, itemId, surface },
      "rank-events/outcome: the negative-signal idempotence read threw — negative_signal_count was NOT incremented for this dismiss");
    return "unknown";
  }
}

/** What the undo lookup reads, WITH 3420's key column. A literal const, for check:write-path-columns. */
const UNDO_DISMISS_COLUMNS        = "id, user_id, outcome, outcome_at, features, outcome_client_event_id";
/** The same list on a database where 3420 has not been applied. */
const UNDO_DISMISS_COLUMNS_LEGACY = "id, user_id, outcome, outcome_at, features";

const undoDismissBodySchema = z.object({
  // Same validators as the outcome body: item_id is text (OSM ids), the surface
  // enum is the only server-side validation of `surface`, session_id is a UUID.
  item_id:    z.string().min(1).max(200),
  surface:    z.enum(SURFACE_VALUES),
  session_id: z.string().regex(UUID_RE, "session_id must be a valid UUID").optional(),
});

/**
 * This viewer's most recent dismissal of this item on this surface.
 *
 * SCOPED TO THE CALLER by `.eq("user_id", userId)`, which is the whole of the
 * authorization: another viewer's dismissal is not found, and the refusal is
 * `not_found` rather than `forbidden` — whether somebody else dismissed this
 * item is not this caller's to learn (the same reasoning as
 * `refuseUnboundOutcome`).
 *
 * Two whole chains rather than a computed select list, for the reason the
 * outcome handler gives: `check:write-path-columns` resolves a `.select`
 * argument only from a string literal or a same-file const.
 */
async function readDismissedExposure(
  sc: any,
  userId: string,
  itemId: string,
  surface: string,
  sessionId: string | undefined,
  log: RouteLog | undefined,
): Promise<{ row: any | null; error: any | null }> {
  let first = canStampOutcomeKey()
    ? sc.from("rank_events").select(UNDO_DISMISS_COLUMNS)
        .eq("user_id", userId).eq("item_id", itemId).eq("surface", surface).eq("outcome", DISMISS)
        .order("served_at", { ascending: false }).limit(1)
    : sc.from("rank_events").select(UNDO_DISMISS_COLUMNS_LEGACY)
        .eq("user_id", userId).eq("item_id", itemId).eq("surface", surface).eq("outcome", DISMISS)
        .order("served_at", { ascending: false }).limit(1);
  if (sessionId) first = first.eq("session_id", sessionId);
  const r = await first;
  if (!r?.error) return { row: ((r?.data as any[]) ?? [])[0] ?? null, error: null };
  if (!isMissingOutcomeKeySchema(r.error)) return { row: null, error: r.error };

  noteOutcomeKeyUnavailable(r.error, log, "undo-dismiss select");
  let retry = sc.from("rank_events").select(UNDO_DISMISS_COLUMNS_LEGACY)
    .eq("user_id", userId).eq("item_id", itemId).eq("surface", surface).eq("outcome", DISMISS)
    .order("served_at", { ascending: false }).limit(1);
  if (sessionId) retry = retry.eq("session_id", sessionId);
  const second = await retry;
  if (second?.error) return { row: null, error: second.error };
  return { row: ((second?.data as any[]) ?? [])[0] ?? null, error: null };
}

router.post("/rank-events/undo-dismiss", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = undoDismissBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const { item_id, surface, session_id } = parsed.data;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const found = await readDismissedExposure(sc, user.id, item_id, surface, session_id, req.log);
  // A read that did not complete REFUSES. Reporting `{ ok: true }` here would
  // tell the viewer their place is back while nothing was written — the
  // masquerade `11` §9 forbids, and the exact shape CONTRIBUTING.md records for
  // this table (a resolved `{ error }` nobody inspected).
  if (found.error) {
    (req.log?.error ?? console.error).call(req.log ?? console,
      { err: found.error }, "rank-events/undo-dismiss: select failed");
    sendError(res, "db_error", String(found.error?.message ?? "db_error"));
    return;
  }
  const row = found.row;
  if (!row) {
    // No dismissal of this item by this viewer — including the case where the
    // dismissal belongs to somebody else. Nothing is created and nothing moves.
    sendError(res, "not_found", "No dismissal to undo for this item");
    return;
  }

  // The downgrade. `outcome_at` is cleared because there is no longer an outcome
  // for it to time, and `features` carries the idempotence marker forward.
  // `outcome_client_event_id` is deliberately NOT cleared — see the §83 note.
  //
  // The update re-asserts `user_id` (defence in depth: the read already scoped
  // it, and a route that mutates rank_events should not rely on one filter) and
  // `outcome = 'dismiss'` as a compare-and-set, so a row that changed between
  // the read and the write is left alone rather than silently overwritten.
  const { error: updateErr } = await sc
    .from("rank_events")
    .update({ outcome: "impression", outcome_at: null, features: bankNegativeSignal(row["features"]) })
    .eq("id", row.id)
    .eq("user_id", user.id)
    .eq("outcome", DISMISS);
  if (updateErr) {
    reportRankEventsRejection(req.log, {
      writer: RANK_EVENTS_WRITER, err: updateErr, extra: { where: "undo-dismiss downgrade" },
    });
    (req.log?.error ?? console.error).call(req.log ?? console,
      { err: updateErr }, "rank-events/undo-dismiss: downgrade failed — the dismissal still stands");
    sendError(res, "db_error", String(updateErr?.message ?? "db_error"));
    return;
  }

  res.json({ ok: true });
}));
