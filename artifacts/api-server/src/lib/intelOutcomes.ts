/**
 * Intelligence Gathering — OUTCOME events (unit I4a, spec §14 / Appendix A).
 *
 * THE RULING THIS IMPLEMENTS
 * ==========================
 * Migration 2130 declined the spec's intel_outcomes table "in favour of
 * canonical_events". So an intel outcome IS a canonical_events row: verb in the
 * existing 'outcome' family, and a payload envelope shared with unit I4b:
 *
 *   payload.intel = { snapshot_id, claim_id, subject_id, outcome,
 *                     experience_rating?, served_at }        (EXACTLY this shape)
 *
 * The Appendix-A outcome enum is expressible on the existing verbs, so the verb
 * set is NOT widened for outcomes (only for the §21 domain verbs — see 2277):
 *
 *   better / slightly_better / same / worse  → completion  (went; graded)
 *   did_not_go                               → rejection   (declined the recommendation)
 *   could_not_enter                          → arrival     (arrived; entry failed)
 *
 * The Table-22 attribution inputs (touch, counterfactual answer) and the §15
 * scope input (traveler_mode) ride as SIBLING payload keys, never inside `intel`,
 * so the shared contract stays exact.
 *
 * THE FIVE-COLUMN ENVELOPE IS THE SERVED STATE AT REPORT TIME
 * ===========================================================
 * canonical_events carries source_count / freshness_seconds / confidence /
 * privacy_eligible / expires_at. For an outcome event they are filled from the
 * referenced snapshot AT THE MOMENT THE OUTCOME IS REPORTED — the closest thing
 * the model has to "what was served", because snapshots are upserted in place
 * and no serve-time history exists (a stated limitation, not a hidden one). The
 * attribution job reads `confidence` back as the §15 expected_accuracy.
 *
 * "WAS THE CALLER ACTUALLY SERVED THIS?"
 * =====================================
 * There is no per-viewer serve ledger for snapshots (the RewardOracle's own
 * "served" signal is the privacy-eligible, unexpired intel_state_snapshots row).
 * So served-ness is verified by PLAUSIBILITY against that same record:
 *   * the snapshot exists and is (still) privacy-eligible — it was servable;
 *   * the referenced claim exists and shares the snapshot's (subject, zone,
 *     claim_type) — it is one of that snapshot's inputs;
 *   * served_at is not before the snapshot's observed_at (state cannot be served
 *     before it was observed), not after its expires_at (not servable after
 *     expiry), and not in the future.
 * A per-viewer serve log would tighten this; it does not exist (see report).
 */
import { projectEvent, type CanonicalEventInput, type CanonicalEventVerb } from "./canonicalEvents.js";
import { logger } from "./logger.js";

/** Appendix A — outcome enum, v1. */
export const INTEL_OUTCOMES = [
  "better",
  "slightly_better",
  "same",
  "worse",
  "did_not_go",
  "could_not_enter",
] as const;
export type IntelOutcome = (typeof INTEL_OUTCOMES)[number];
const OUTCOME_SET = new Set<string>(INTEL_OUTCOMES);

/** Outcome → existing 'outcome'-family verb (2123). Total over the enum. */
export const OUTCOME_VERB: Record<IntelOutcome, CanonicalEventVerb> = {
  better: "completion",
  slightly_better: "completion",
  same: "completion",
  worse: "completion",
  did_not_go: "rejection",
  could_not_enter: "arrival",
};

/** The verbs an intel outcome can carry — what readers filter on. */
export const OUTCOME_VERBS = ["completion", "rejection", "arrival"] as const;

/** Table 22 touch kinds (the weights live in lib/intelAttribution.ts). */
export const ATTRIBUTION_TOUCHES = [
  "direct_paid_answer",
  "go_tap",
  "compass_explanation",
  "impression",
  "pre_committed",
] as const;
export type AttributionTouch = (typeof ATTRIBUTION_TOUCHES)[number];

/** §15 traveler_mode scope dimension, v1. */
export const TRAVELER_MODES = ["solo", "couple", "group", "family", "unknown"] as const;
export type TravelerMode = (typeof TRAVELER_MODES)[number];

/** experience_rating is a 1..5 structured satisfaction integer (Table 21). */
export const EXPERIENCE_RATING_MIN = 1;
export const EXPERIENCE_RATING_MAX = 5;

/** The shared I4a/I4b outcome envelope — keep EXACTLY this shape. */
export interface IntelOutcomePayload {
  snapshot_id: string;
  claim_id: string;
  subject_id: string;
  outcome: IntelOutcome;
  experience_rating?: number;
  served_at: string;
}

/** Type guard for readers (the attribution job, I4b). Fail-closed on any drift. */
export function isIntelOutcomePayload(x: unknown): x is IntelOutcomePayload {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  if (typeof p.snapshot_id !== "string" || p.snapshot_id.length === 0) return false;
  if (typeof p.claim_id !== "string" || p.claim_id.length === 0) return false;
  if (typeof p.subject_id !== "string" || p.subject_id.length === 0) return false;
  if (typeof p.outcome !== "string" || !OUTCOME_SET.has(p.outcome)) return false;
  if (typeof p.served_at !== "string" || Number.isNaN(Date.parse(p.served_at))) return false;
  if (p.experience_rating !== undefined) {
    if (typeof p.experience_rating !== "number" || !Number.isInteger(p.experience_rating)) return false;
    if (p.experience_rating < EXPERIENCE_RATING_MIN || p.experience_rating > EXPERIENCE_RATING_MAX) return false;
  }
  return true;
}

/** The served snapshot facts the outcome needs (intel_state_snapshots columns). */
export interface ServedSnapshot {
  id: string;
  subject_id: string;
  zone_id: string | null;
  claim_type: string;
  confidence: number | null;
  source_count: number | null;
  privacy_eligible: boolean;
  observed_at: string;
  expires_at: string;
}

/** Tolerated clock skew for a served_at "in the future". */
export const SERVED_AT_MAX_SKEW_MS = 60_000;

export type ServedRefusal =
  | "snapshot_not_served"
  | "served_before_observed"
  | "served_after_expiry"
  | "served_in_future"
  | "invalid_served_at";

export type ServedCheck = { ok: true } | { ok: false; reason: ServedRefusal };

/**
 * Plausibility check that the caller was served `snapshot` at `servedAt`. Pure.
 * See the module header for why this is plausibility rather than a serve log.
 */
export function checkServed(snapshot: ServedSnapshot, servedAt: string, now: Date = new Date()): ServedCheck {
  const t = Date.parse(servedAt);
  if (!Number.isFinite(t)) return { ok: false, reason: "invalid_served_at" };
  if (snapshot.privacy_eligible !== true) return { ok: false, reason: "snapshot_not_served" };
  if (t > now.getTime() + SERVED_AT_MAX_SKEW_MS) return { ok: false, reason: "served_in_future" };
  const observed = Date.parse(snapshot.observed_at);
  if (Number.isFinite(observed) && t < observed) return { ok: false, reason: "served_before_observed" };
  const expires = Date.parse(snapshot.expires_at);
  if (Number.isFinite(expires) && t > expires) return { ok: false, reason: "served_after_expiry" };
  return { ok: true };
}

export interface OutcomeInput {
  snapshotId: string;
  claimId: string;
  outcome: IntelOutcome;
  experienceRating?: number;
  servedAt: string;
  touch: AttributionTouch;
  counterfactualSameChoice?: boolean;
  travelerMode?: TravelerMode;
  /** Optional surface label (allow-listed payload key), e.g. 'compass'. */
  surface?: string;
}

/**
 * Build the canonical event for an outcome. Pure. The five-column envelope is
 * filled from the snapshot (see header); `intel` is exactly the shared shape.
 */
export function buildOutcomeEvent(
  actorId: string,
  snapshot: ServedSnapshot,
  input: OutcomeInput,
  now: Date = new Date(),
): CanonicalEventInput {
  const intel: IntelOutcomePayload = {
    snapshot_id: snapshot.id,
    claim_id: input.claimId,
    subject_id: snapshot.subject_id,
    outcome: input.outcome,
    served_at: input.servedAt,
  };
  if (input.experienceRating !== undefined) intel.experience_rating = input.experienceRating;

  const payload: Record<string, unknown> = { intel, touch: input.touch };
  if (typeof input.counterfactualSameChoice === "boolean") payload.counterfactual_same_choice = input.counterfactualSameChoice;
  if (input.travelerMode) payload.traveler_mode = input.travelerMode;
  if (input.surface) payload.surface = input.surface;

  const servedMs = Date.parse(input.servedAt);
  const observedMs = Date.parse(snapshot.observed_at);
  const freshness = Number.isFinite(servedMs) && Number.isFinite(observedMs)
    ? Math.max(0, Math.round((servedMs - observedMs) / 1000))
    : null;

  return {
    verb: OUTCOME_VERB[input.outcome],
    actorId,
    subjectKind: "place",
    subjectId: snapshot.subject_id,
    occurredAt: now.toISOString(),
    sourceCount: snapshot.source_count ?? null,
    freshnessSeconds: freshness,
    confidence: typeof snapshot.confidence === "number" ? snapshot.confidence : null,
    privacyEligible: snapshot.privacy_eligible,
    expiresAt: snapshot.expires_at,
    payload,
  };
}

export type OutcomeRefusal =
  | "snapshot_not_found"
  | "claim_not_found"
  | "claim_mismatch"
  | ServedRefusal
  | "db_error";

export type RecordOutcomeResult =
  | { ok: true; eventId: string; deduped: boolean; event: CanonicalEventInput }
  | { ok: false; reason: OutcomeRefusal; detail?: string };

/**
 * Verify, dedup and write an outcome. The DB-touching half; every decision is
 * derived from real rows, never from the body. Idempotent on (actor, snapshot):
 * a second report of the same served snapshot returns the original event id
 * (the 2277 partial unique index makes that race-safe — 23505 ⇒ replay).
 */
export async function recordIntelOutcome(
  sc: any,
  actorId: string,
  input: OutcomeInput,
  now: Date = new Date(),
): Promise<RecordOutcomeResult> {
  // 1. The served record (the same row the RewardOracle treats as "served").
  const { data: snap, error: snapErr } = await sc
    .from("intel_state_snapshots")
    .select("id, subject_id, zone_id, claim_type, confidence, source_count, privacy_eligible, observed_at, expires_at")
    .eq("id", input.snapshotId)
    .maybeSingle();
  if (snapErr) return { ok: false, reason: "db_error", detail: "snapshot read failed" };
  if (!snap) return { ok: false, reason: "snapshot_not_found" };
  const snapshot = snap as ServedSnapshot;

  const served = checkServed(snapshot, input.servedAt, now);
  if (!served.ok) return { ok: false, reason: served.reason };

  // 2. The referenced claim must be one of the snapshot's inputs: same
  //    (subject, zone, claim_type) natural key the projection keys on.
  const { data: claim, error: claimErr } = await sc
    .from("intel_claims")
    .select("id, subject_id, zone_id, claim_type")
    .eq("id", input.claimId)
    .maybeSingle();
  if (claimErr) return { ok: false, reason: "db_error", detail: "claim read failed" };
  if (!claim) return { ok: false, reason: "claim_not_found" };
  if (
    claim.subject_id !== snapshot.subject_id
    || claim.claim_type !== snapshot.claim_type
    || (claim.zone_id ?? "") !== (snapshot.zone_id ?? "")
  ) {
    return { ok: false, reason: "claim_mismatch" };
  }

  // 3. Dedup per (actor, snapshot) — read first so a replay is answered without
  //    an insert attempt; the unique index still closes the race.
  const { data: existing, error: existErr } = await sc
    .from("canonical_events")
    .select("id")
    .eq("actor_id", actorId)
    .eq("payload->intel->>snapshot_id", snapshot.id)
    .in("verb", OUTCOME_VERBS as unknown as string[])
    .limit(1);
  if (existErr) return { ok: false, reason: "db_error", detail: "dedup read failed" };
  const event = buildOutcomeEvent(actorId, snapshot, input, now);
  const prior = Array.isArray(existing) ? existing[0] : existing;
  if (prior?.id) return { ok: true, eventId: prior.id, deduped: true, event };

  // 4. Write through the same projection recordEvents uses (verb check + GPS
  //    strip + allow-list), but NOT fire-and-forget: the caller needs the id and
  //    must see a refused insert.
  const row = projectEvent(event);
  if (!row) return { ok: false, reason: "db_error", detail: "event projection refused" };
  const { data: inserted, error: insErr } = await sc
    .from("canonical_events")
    .insert(row)
    .select("id")
    .single();
  if (insErr) {
    if (insErr.code === "23505") {
      // Lost the race to an identical report: return the winner.
      const { data: winner, error: winErr } = await sc
        .from("canonical_events")
        .select("id")
        .eq("actor_id", actorId)
        .eq("payload->intel->>snapshot_id", snapshot.id)
        .in("verb", OUTCOME_VERBS as unknown as string[])
        .limit(1);
      const w = Array.isArray(winner) ? winner[0] : winner;
      if (!winErr && w?.id) return { ok: true, eventId: w.id, deduped: true, event };
    }
    logger.warn({ err: insErr, actor: actorId, snapshot: snapshot.id }, "intelOutcomes: outcome insert rejected");
    return { ok: false, reason: "db_error", detail: "outcome insert failed" };
  }
  return { ok: true, eventId: inserted.id, deduped: false, event };
}
