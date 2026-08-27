/**
 * Claim projection (IG-04) — turns stored claims into publishable live state.
 *
 * This is the only writer of intel_state_snapshots. It reads active claims for a
 * subject, scores each with the spec's confidence formula, asks the shared
 * privacy gate whether the aggregate may be published, and writes the result.
 *
 * WHAT IT IS NOT. It does not capture anything (that is IG-03) and it does not
 * decide what a surface shows (that is lib/liveClaimRead.ts, which applies its
 * own gates on the way out). The two-sided arrangement is deliberate: a snapshot
 * written with privacy_eligible=false is inert even if a reader is buggy, and a
 * reader that filters on privacy_eligible is inert even if a writer is buggy.
 * Neither side trusts the other.
 *
 * FAIL-CLOSED AT EVERY STEP:
 *   * flag off, unreadable, or no client  => project nothing;
 *   * a claim whose TTL has no policy     => skipped (freshnessPolicy already
 *                                            treats unknown claim types as stale);
 *   * privacy gate says no                => the snapshot is still written, with
 *                                            privacy_eligible=false, because a
 *                                            suppressed aggregate is a fact worth
 *                                            recording; the reader will not show it;
 *   * any error                           => that subject is skipped, not
 *                                            partially written.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { logger } from "./logger.js";
import { scoreConfidence, type ConfidenceComponents, type ConfidencePenalties } from "./confidenceScore.js";
import { evaluatePrivacy, type PrivacyDecision } from "./privacyGate.js";
import { expiresAt as policyExpiresAt } from "./freshnessPolicy.js";
import { LIVE_ELIGIBLE_CLAIM_STATUSES } from "./intelContracts.js";

export interface ProjectionInput {
  claimType: string;
  value: unknown;
  observedAt: string;
  /** Distinct PEOPLE who contributed, counted by the caller from confirmations. */
  distinctActors: number;
  distinctGroups?: number;
  maxGroupShare?: number;
  sensitiveSubject?: boolean;
  components: Partial<ConfidenceComponents>;
  penalties?: Partial<ConfidencePenalties>;
}

export interface ProjectedSnapshot {
  subject_id: string;
  zone_id: string | null;
  claim_type: string;
  value: unknown;
  confidence: number;
  confidence_band: string;
  source_count: number;
  distinct_actors: number;
  privacy_eligible: boolean;
  observed_at: string;
  expires_at: string;
}

export interface ProjectionResult {
  snapshot: ProjectedSnapshot | null;
  /** Why it is not publishable, when it is not. */
  privacy: PrivacyDecision;
  skippedReason?: "no_ttl_policy" | "invalid_input";
}

/**
 * Project one claim. Pure apart from the TTL lookup, so it can be tested without
 * writing anything.
 */
export async function projectClaim(
  sc: any,
  subjectId: string,
  input: ProjectionInput,
  opts: { zoneId?: string | null; now?: Date } = {},
): Promise<ProjectionResult> {
  const now = opts.now ?? new Date();

  if (!subjectId || !input?.claimType || !input.observedAt) {
    return { snapshot: null, privacy: { publishable: false, reason: "invalid_input" }, skippedReason: "invalid_input" };
  }

  // A claim type with no policy has no defined lifetime; freshnessPolicy already
  // treats it as stale, so projecting it would create a snapshot that can never
  // be live. Skip rather than invent a TTL.
  const expires = await policyExpiresAt(sc, input.claimType, input.observedAt);
  if (!expires) {
    return { snapshot: null, privacy: { publishable: false, reason: "invalid_input" }, skippedReason: "no_ttl_policy" };
  }

  const scored = scoreConfidence(input.components, input.penalties);
  const privacy = evaluatePrivacy({
    distinctActors: input.distinctActors,
    distinctGroups: input.distinctGroups,
    maxGroupShare: input.maxGroupShare,
    observedAt: input.observedAt,
    now,
    sensitiveSubject: input.sensitiveSubject,
  });

  return {
    snapshot: {
      subject_id: subjectId,
      // '' (not null) for a zone-less snapshot: the unique index + PostgREST
      // onConflict target are plain columns (2176), so the key must be a
      // concrete value. Writing null made ON CONFLICT (subject_id,zone_id,
      // claim_type) fail to match the old coalesce() index (SQLSTATE 42P10).
      zone_id: opts.zoneId ?? "",
      claim_type: input.claimType,
      value: input.value,
      confidence: scored.confidence,
      confidence_band: scored.band,
      source_count: Number.isFinite(input.distinctActors) ? input.distinctActors : 0,
      distinct_actors: Number.isFinite(input.distinctActors) ? input.distinctActors : 0,
      privacy_eligible: privacy.publishable,
      observed_at: new Date(input.observedAt).toISOString(),
      expires_at: expires,
    },
    privacy,
  };
}

/**
 * Project and persist. Upserts on (subject_id, zone_id, claim_type), matching the
 * unique index in 2130 — a subject has one current snapshot per claim, not a
 * growing history. History lives in intel_observations, which is append-only.
 */
export async function projectAndStore(
  sc: any,
  subjectId: string,
  inputs: readonly ProjectionInput[],
  opts: { zoneId?: string | null; now?: Date } = {},
): Promise<{ written: number; suppressed: number; skipped: number }> {
  const tally = { written: 0, suppressed: 0, skipped: 0 };
  if (!sc || !subjectId || !inputs?.length) return tally;
  if (!(await isFlagEnabled(sc, "intel_claim_projection_crowd"))) return tally;

  for (const input of inputs) {
    try {
      const r = await projectClaim(sc, subjectId, input, opts);
      if (!r.snapshot) { tally.skipped++; continue; }
      const { error } = await sc
        .from("intel_state_snapshots")
        .upsert(r.snapshot, { onConflict: "subject_id,zone_id,claim_type" });
      if (error) { tally.skipped++; logger.warn({ err: error }, "intelProjection: upsert failed"); continue; }
      if (r.snapshot.privacy_eligible) tally.written++; else tally.suppressed++;
    } catch (err) {
      tally.skipped++;
      logger.warn({ err }, "intelProjection: projection threw");
    }
  }
  return tally;
}

/** Statuses a claim must hold to be projected at all. */
export const PROJECTABLE_STATUSES = LIVE_ELIGIBLE_CLAIM_STATUSES;
