/**
 * Intelligence Gathering — §24 / Table-32 observability read (INTERNAL).
 *
 *   GET /v1/internal/intel/observability?windowDays=7
 *     The Truth-health / Calibration / Decision / Economy dashboards' one read.
 *
 * INTERNAL ONLY. requireAdmin gates it, exactly like routes/intelCoverage.ts and
 * routes/intelApi.ts — there is no client-facing surface here and no external
 * credential. It is strictly READ-ONLY: no write, no flag read, no promotion.
 * Nothing it returns is fed back into confidence, trust or ranking (§23).
 *
 * WHY THE READS LIVE HERE AND THE ARITHMETIC DOES NOT
 * ===================================================
 * The row fetch below is deliberately the SAME set the daily calibration
 * scheduler (lib/intelCalibrationScheduler) performs, plus the three ledgers the
 * dashboards need that the scheduler does not read (reward ledger, attribution
 * ledger, and the served confidence on the outcome events). The shaping is
 * lib/intelObservabilityReport's, which is pure and tested. One instrument, two
 * drivers — a daily log line and an on-demand dashboard — never two tallies that
 * can disagree.
 *
 * NOT-INSTRUMENTED IS PART OF THE PAYLOAD, NOT AN OMISSION
 * ========================================================
 * Several Table-32 metrics have no source in this system yet. They are returned
 * with status UNINSTRUMENTED and value null so the dashboard renders "not
 * instrumented"; a zero would read as a measurement. See the report module's
 * header for why that distinction is the whole point of this surface.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { logger } from "../lib/logger.js";
import {
  buildObservabilityReport,
  type AttributionRow,
  type ObsClaimRow,
  type ObsObservationRow,
  type ObsOutcomeRow,
  type ObsSnapshotRow,
  type RewardLedgerRow,
} from "../lib/intelObservabilityReport.js";
import { OUTCOME_VERBS } from "../lib/intelOutcomes.js";
import type { ConfirmationRow } from "../lib/intelFunnelReport.js";

const router = Router();

/** Bound every read (house pattern; pre-launch volume is ~0). */
const FETCH_CAP = 200_000;
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 90;

router.get("/v1/internal/intel/observability", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const parsedWindow = z.coerce.number().int().min(1).max(MAX_WINDOW_DAYS).safeParse(req.query.windowDays ?? DEFAULT_WINDOW_DAYS);
  if (!parsedWindow.success) return sendError(res, "invalid_payload", `windowDays must be an integer 1..${MAX_WINDOW_DAYS}`);
  const windowDays = parsedWindow.data;

  const now = new Date();
  const sinceIso = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();

  try {
    const [obs, freshObs, claims, snaps, confs, outcomeEvents, rewards, attributions] = await Promise.all([
      ctx.sc.from("intel_observations")
        .select("actor_id, subject_id, zone_id, claim_type, moderation_state, observed_at, expires_at, group_key, party_size_bucket, source_class")
        .gte("observed_at", sinceIso).limit(FETCH_CAP),
      // The FULL fresh cohort (no observed_at lower bound) — the gate re-derivation
      // must match the aggregator, which counts every unexpired observation.
      ctx.sc.from("intel_observations")
        .select("actor_id, subject_id, zone_id, claim_type, observed_at, expires_at, group_key, moderation_state, source_class")
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`).limit(FETCH_CAP),
      ctx.sc.from("intel_claims")
        .select("subject_id, claim_type, status, observed_at, superseded_by")
        .gte("observed_at", sinceIso).limit(FETCH_CAP),
      ctx.sc.from("intel_state_snapshots")
        .select("privacy_eligible, confidence_band, expires_at, conflict_state")
        .gte("computed_at", sinceIso).limit(FETCH_CAP),
      ctx.sc.from("intel_confirmations")
        .select("stance").gte("created_at", sinceIso).limit(FETCH_CAP),
      // The outcome events carry the SERVED confidence in the envelope column.
      // The VERB filter is load-bearing, not a narrowing optimisation:
      // payload.intel is the envelope of EVERY intel domain event (§ lib/
      // intelDomainEvents builds intel.observation.recorded, intel.claim.promoted
      // and intel.state.changed with one), so `payload->intel is not null` alone
      // sweeps up system transitions that are not outcomes at all. Those rows
      // carry no `outcome`, and the decision section derives arrival as
      // total − did_not_go — so every promoted claim would be reported as a
      // traveler who successfully arrived. OUTCOME_VERBS is what the production
      // readers filter on (lib/intelOutcomes dedup, intelAttributionScheduler).
      ctx.sc.from("canonical_events")
        .select("subject_id, occurred_at, confidence, payload")
        .in("verb", OUTCOME_VERBS as unknown as string[])
        .not("payload->intel", "is", null).gte("occurred_at", sinceIso).limit(FETCH_CAP),
      ctx.sc.from("intel_reward_ledger")
        .select("qiu, earned_units, cash_amount").gte("created_at", sinceIso).limit(FETCH_CAP),
      ctx.sc.from("intel_attributions")
        .select("outcome, counterfactual, contradiction").gte("computed_at", sinceIso).limit(FETCH_CAP),
    ]);

    for (const r of [obs, freshObs, claims, snaps, confs, outcomeEvents, rewards, attributions]) {
      if (r.error) {
        logger.warn({ err: r.error }, "intel observability: read failed");
        return sendError(res, "db_error", "observability read failed");
      }
    }

    const outcomes: ObsOutcomeRow[] = ((outcomeEvents.data ?? []) as any[]).map((e) => ({
      subject_id: e.subject_id ?? e.payload?.intel?.subject_id ?? null,
      snapshot_id: e.payload?.intel?.snapshot_id ?? null,
      outcome: e.payload?.intel?.outcome ?? null,
      occurred_at: e.occurred_at ?? null,
      confidence: typeof e.confidence === "number" ? e.confidence : null,
    }));

    const report = buildObservabilityReport({
      observations: (obs.data ?? []) as ObsObservationRow[],
      freshObservations: (freshObs.data ?? []) as ObsObservationRow[],
      claims: (claims.data ?? []) as ObsClaimRow[],
      snapshots: (snaps.data ?? []) as ObsSnapshotRow[],
      confirmations: (confs.data ?? []) as ConfirmationRow[],
      outcomes,
      rewards: (rewards.data ?? []) as RewardLedgerRow[],
      attributions: (attributions.data ?? []) as AttributionRow[],
    }, { now, windowDays });

    res.json(report);
  } catch (err) {
    logger.warn({ err }, "intel observability: read threw");
    return sendError(res, "db_error", "observability read failed");
  }
}));

export default router;
