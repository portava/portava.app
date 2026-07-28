/**
 * POST /api/rank-events/outcome
 *
 * Records a user outcome (tap, save, join, rsvp, attended) against the most
 * recent matching impression row in rank_events for the authenticated user.
 *
 * Auth required.  Returns 404 when no impression row is found — phantom rows
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
import { upsertDistributionStats } from "../services/ranking/DiscoveryRankingService.js";
import { RankingEvent, OUTCOME_TO_ANALYTICS_EVENT } from "../services/ranking/rankingAnalytics.js";

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
const OUTCOME_VALUES = ["tap", "save", "join", "rsvp", "attended"] as const;
const SURFACE_VALUES = ["pulse", "discovery", "events"] as const;

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

  // Find the most recent impression row for this user + item (+ optionally surface)
  let query = sc
    .from("rank_events")
    .select("id")
    .eq("user_id", user.id)
    .eq("item_id", item_id)
    .eq("surface", surface)
    .eq("outcome", "impression")   // only upgrade from impression rows
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
  const stage =
    outcome === "tap"  ? "viewed" :
    outcome === "save" ? "saved"  :
    "went"; // join / rsvp / attended
  void linkOutcomeSignal(sc, user.id, item_id, stage, `route:rank_event_${outcome}`);

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

  // Update content_distribution_stats for this item — fire-and-forget.
  // An outcome confirms the impression was real: increment eligible_impressions
  // and unique_viewers, then let the service determine underexposure_status.
  // negativeSignal=false: tap/save/join/rsvp/attended are all positive outcomes
  void upsertDistributionStats(sc, item_id, user.id, false);

  res.json({ ok: true });
}));

export default router;
