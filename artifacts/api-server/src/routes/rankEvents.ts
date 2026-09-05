/**
 * POST /api/rank-events/outcome
 *
 * Records a user outcome (tap, save, join, rsvp, attended) against the most
 * recent matching rank_events row for the authenticated user whose current
 * outcome sits on a LOWER funnel rung — an impression row, or a row already
 * upgraded to a weaker outcome (impression → tap → save/join/rsvp → attended).
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
const OUTCOME_VALUES = ["tap", "save", "join", "rsvp", "attended", "dismiss"] as const;
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
 * Funnel rungs (0153_add_rank_events.sql: impression → tap → save/join/rsvp →
 * attended).  rank_events is a mutable-state table — an outcome UPDATES the
 * impression row in place — so the row can only ever hold ONE outcome, and it
 * should be the furthest rung reached.
 *
 * The lookup below therefore accepts any row on a strictly LOWER rung than the
 * reported outcome, not only outcome='impression'.  Without that, the first
 * outcome consumes the row and every stronger one after it 404s: the discovery
 * surface reports 'tap' when a place card opens its detail sheet, and a 'save'
 * made from inside that sheet — the strongest signal the surface has — was
 * silently lost.  A weaker or equal outcome (a 'tap' after a 'save', a 'join'
 * after an 'rsvp') never downgrades: it finds no row and returns 404 exactly as
 * a duplicate did before.
 */
type FunnelOutcome = Exclude<OutcomeValue, typeof DISMISS>;

const OUTCOME_RUNG: Record<FunnelOutcome | "impression", number> = {
  impression: 0,
  tap:        1,
  save:       2,
  join:       2,
  rsvp:       2,
  attended:   3,
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
  //     duplicate does.
  if (outcome === DISMISS) return ["impression"];
  const rung = OUTCOME_RUNG[outcome];
  return (Object.keys(OUTCOME_RUNG) as Array<keyof typeof OUTCOME_RUNG>)
    .filter((o) => OUTCOME_RUNG[o] < rung);
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
  let query = sc
    .from("rank_events")
    .select("id")
    .eq("user_id", user.id)
    .eq("item_id", item_id)
    .eq("surface", surface)
    .in("outcome", upgradableOutcomesFor(outcome))   // never downgrades — see OUTCOME_RUNG
    .order("served_at", { ascending: false })
    .limit(1);

  if (session_id) {
    query = query.eq("session_id", session_id);
  }

  const { data: rows, error: selectErr } = await query;
  if (selectErr) {
    req.log.error({ err: selectErr }, "rank-events/outcome: select failed");
    sendError(res, "db_error", selectErr.message);
    return;
  }

  const row = (rows as any[] ?? [])[0];
  if (!row) {
    sendError(res, "not_found", "No matching impression row found for this item");
    return;
  }

  const { error: updateErr } = await sc
    .from("rank_events")
    .update({ outcome, outcome_at: new Date().toISOString() })
    .eq("id", row.id);

  if (updateErr) {
    req.log.error({ err: updateErr }, "rank-events/outcome: update failed");
    sendError(res, "db_error", updateErr.message);
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
    const stage =
      outcome === "tap"  ? "viewed" :
      outcome === "save" ? "saved"  :
      "went"; // join / rsvp / attended
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
    void sc
      .from("rank_events")
      .insert({
        event_type:  analyticsEventType,
        item_id,
        surface,
        user_id:     user.id,
        session_id:  session_id ?? null,
        served_at:   new Date().toISOString(),
        // Analytics sentinel — prevents impression-finding query from matching
        outcome:     "analytics",
      })
      .then(() => {}, (err: unknown) => {
        req.log.warn({ err, outcome, analyticsEventType }, "rank-events/outcome: analytics insert failed (non-fatal)");
      });
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

export default router;
