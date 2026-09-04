/**
 * Intelligence Gathering — outcome route (unit I4a, spec §14 / §19 "Outcomes").
 *
 * POST /v1/intel/outcomes — a traveler reports what happened after being served
 * a live-state snapshot. Writes a canonical_events row (the 2130 ruling: no
 * intel_outcomes table) whose payload.intel is the envelope shared with I4b.
 *
 * Lives in its own router file (routes/intel.ts is owned by another unit this
 * hour) and is mounted alongside it in routes/index.ts.
 *
 * CONTRACT
 *   * authenticated (requireUser — the ban/suspend gate); actor_id is the
 *     session user, never the body;
 *   * rate-limited per user like the other intel captures (30 / hour);
 *   * Idempotency-Key header required on every intel write (§19) and validated;
 *     the EFFECTIVE idempotency key is structural — (actor, snapshot) — because a
 *     traveler has one outcome per served snapshot, and the 2277 partial unique
 *     index enforces that regardless of the header. A replay returns 200 with the
 *     original event id;
 *   * validates the Appendix-A outcome enum, an optional 1..5 experience_rating,
 *     the Table-22 touch, the counterfactual answer and traveler_mode;
 *   * requires that the caller was plausibly SERVED the referenced snapshot and
 *     that the claim is one of its inputs (lib/intelOutcomes.checkServed);
 *   * gated on intel_claim_projection_crowd: no snapshot can have been served
 *     without the projection stage, so with it off the route is a fail-closed
 *     `feature_disabled` — nothing is written.
 *
 * The response carries schema_version, source label and generated_at (§19) and
 * never a location proof.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError, type ApiErrorCode } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { isValidIdempotencyKey } from "../lib/intelContracts.js";
import {
  INTEL_OUTCOMES, ATTRIBUTION_TOUCHES, TRAVELER_MODES,
  EXPERIENCE_RATING_MIN, EXPERIENCE_RATING_MAX,
  recordIntelOutcome, type OutcomeRefusal,
} from "../lib/intelOutcomes.js";

const router = Router();

/** The stage flag whose absence makes a served snapshot impossible. */
export const INTEL_OUTCOME_GATE_FLAG = "intel_claim_projection_crowd";

export const INTEL_OUTCOME_RATE_LIMIT = { id: "intel_outcomes", limit: 30, windowMs: 60 * 60_000 };

export const OUTCOME_SCHEMA_VERSION = 1;
export const OUTCOME_SOURCE_LABEL = "traveler_outcome";

export const outcomeSchema = z.object({
  snapshotId: z.string().uuid(),
  claimId: z.string().uuid(),
  outcome: z.enum(INTEL_OUTCOMES),
  experienceRating: z.number().int().min(EXPERIENCE_RATING_MIN).max(EXPERIENCE_RATING_MAX).optional(),
  servedAt: z.string().datetime(),
  touch: z.enum(ATTRIBUTION_TOUCHES),
  counterfactualSameChoice: z.boolean().optional(),
  travelerMode: z.enum(TRAVELER_MODES).optional(),
  surface: z.string().max(40).optional(),
});

/** Map a service refusal onto a stable API error code. */
const REASON_CODE: Record<OutcomeRefusal, ApiErrorCode> = {
  snapshot_not_found: "not_found",
  claim_not_found: "not_found",
  claim_mismatch: "invalid_payload",
  snapshot_not_served: "forbidden",
  served_before_observed: "invalid_payload",
  served_after_expiry: "invalid_payload",
  served_in_future: "invalid_payload",
  invalid_served_at: "invalid_payload",
  db_error: "db_error",
};

router.post("/v1/intel/outcomes", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "The service client is not configured");
    return;
  }

  // Rate limit BEFORE the flag read (mapObservations' idiom): a disabled capture
  // endpoint should still not be a free loop.
  const rl = checkRateLimit(INTEL_OUTCOME_RATE_LIMIT.id, user.id, INTEL_OUTCOME_RATE_LIMIT.limit, INTEL_OUTCOME_RATE_LIMIT.windowMs);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many outcome reports. Please wait.");
    return;
  }

  const key = req.header("Idempotency-Key") ?? req.header("idempotency-key");
  if (!isValidIdempotencyKey(key)) {
    sendError(res, "invalid_payload", "An Idempotency-Key header is required on every intel write.");
    return;
  }

  const parsed = outcomeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid outcome");
    return;
  }

  if (!(await isFlagEnabled(sc, INTEL_OUTCOME_GATE_FLAG))) {
    sendError(res, "feature_disabled", "Intel outcomes are not enabled");
    return;
  }

  const result = await recordIntelOutcome(sc, user.id, parsed.data);
  if (!result.ok) {
    sendError(res, REASON_CODE[result.reason] ?? "invalid_payload", result.detail ?? result.reason);
    return;
  }

  const intel = (result.event.payload as any)?.intel ?? {};
  res.status(result.deduped ? 200 : 201).json({
    outcome: {
      eventId: result.eventId,
      snapshotId: intel.snapshot_id,
      claimId: intel.claim_id,
      subjectId: intel.subject_id,
      outcome: intel.outcome,
      experienceRating: intel.experience_rating ?? null,
      servedAt: intel.served_at,
      occurredAt: result.event.occurredAt,
      touch: parsed.data.touch,
    },
    deduped: result.deduped,
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    sourceLabel: OUTCOME_SOURCE_LABEL,
    generatedAt: new Date().toISOString(),
  });
}));

export default router;
