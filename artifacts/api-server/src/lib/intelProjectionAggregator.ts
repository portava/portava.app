/**
 * Intel projection aggregator (IG-04) — the missing PRODUCER-side assembly that
 * turns stored claims + their evidence into the ProjectionInput lib/intelProjection
 * consumes. Before this, projectAndStore was only ever called by tests with a
 * hand-built input, so nothing drove the projection in production.
 *
 * WHAT IT DERIVES, AND HOW CONSERVATIVELY. The one value that MUST be exact is
 * `distinctActors` — the privacy gate (lib/privacyGate) refuses to publish an
 * aggregate below k distinct contributors, so an over-count would be a k=1 leak.
 * It is counted as the number of DISTINCT observers of (subject, claim_type)
 * within the freshness window — real people, from intel_observations.actor_id.
 *
 * The seven confidence components are derived v1-conservatively: unknown or thin
 * evidence scores LOW, never high. That is fail-safe by construction — the
 * confidence FLOOR in lib/liveClaimRead only shows a snapshot as LIVE above a
 * band, so under-scoring hides a label; it never invents one. Presence is P0 for
 * all Phase-1 quick signals (capture hard-codes it), so a single unverified
 * report scores low and, lacking corroboration, is suppressed — exactly right.
 *
 * RUNTIME EFFECT: NONE on its own. The scheduler (lib/intelProjectionScheduler)
 * drives it, gated by intel_claim_projection_crowd.
 */
import type { ProjectionInput } from "./intelProjection.js";
import type { ConfidenceComponents, ConfidencePenalties } from "./confidenceScore.js";
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";
import { getPolicy } from "./freshnessPolicy.js";

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Presence attestation strength → [0,1]. Phase-1 capture is P0 (unverified). */
const PRESENCE_STRENGTH: Record<string, number> = { P0: 0, P1: 0.25, P2: 0.5, P3: 0.75, P4: 1 };

/** Epistemic reliability of a source class → [0,1] (spec §5 source classes). */
const SOURCE_RELIABILITY: Record<string, number> = {
  official_signed: 1.0,
  verified_firsthand: 0.9,
  imported_owned: 0.6,
  firsthand_unverified: 0.5,
  historical_pattern: 0.5,
  portava_prediction: 0.4,
  sponsored: 0.4,
  hearsay: 0.2,
};

export interface ClaimEvidence {
  /** Distinct real contributors to (subject, claim_type), fresh — the k-anon input. */
  distinctActors: number;
  /** Distinct independent groups/parties, if derivable (else undefined → gate uses actors only). */
  distinctGroups?: number;
  maxGroupShare?: number;
  agrees: number;
  disagrees: number;
  /** Strongest presence attestation among the supporting observations ('P0'..'P4'). */
  maxPresenceLevel: string;
  hasEvidence: boolean;
  /** Strongest source class among the supporting observations. */
  sourceClass: string;
  /** age / ttl of the freshest observation, 0..1+ (>1 means already stale). */
  ageRatio: number;
  sensitiveSubject?: boolean;
  /** True for a claim in the 'conflicting' state — applies a material-conflict penalty. */
  conflicting?: boolean;
}

/**
 * Derive the seven confidence components from a claim's evidence. Conservative:
 * thin evidence scores low. Every output is clamped to [0,1].
 */
export function deriveComponents(ev: ClaimEvidence): ConfidenceComponents {
  const totalConfirmations = ev.agrees + ev.disagrees;
  return {
    presence: PRESENCE_STRENGTH[ev.maxPresenceLevel] ?? 0,
    freshness: clamp01(1 - ev.ageRatio),
    // More distinct contributors ⇒ more independent corroboration; saturates at
    // the k-anonymity threshold so a barely-publishable aggregate is not also
    // treated as maximally independent.
    independence: clamp01(ev.distinctActors / Math.max(1, PRIVACY_THRESHOLD_V1.minUniqueActors)),
    sourceReliability: SOURCE_RELIABILITY[ev.sourceClass] ?? 0.3,
    evidenceQuality: ev.hasEvidence ? 0.8 : 0.3,
    // No confirmations ⇒ neutral (0.5), not assumed-agreement; with confirmations,
    // the agree fraction.
    agreement: totalConfirmations > 0 ? clamp01(ev.agrees / totalConfirmations) : 0.5,
    // v1 default — claim-value specificity scoring is deferred; a mid value neither
    // inflates nor zeroes confidence.
    specificity: 0.5,
  };
}

/** Penalties from the claim's state. A conflicting claim carries a material-conflict penalty. */
export function derivePenalties(ev: ClaimEvidence): Partial<ConfidencePenalties> {
  return ev.conflicting ? { materialConflict: 0.2 } : {};
}

/** A claim row as read from intel_claims for projection. */
export interface ClaimRow {
  id: string;
  subject_id: string;
  zone_id: string | null;
  claim_type: string;
  value: unknown;
  status: string;
  observed_at: string;
}

/**
 * Assemble the ProjectionInput for one active claim by gathering its real
 * evidence: distinct fresh observers, confirmation stances, strongest presence
 * and source class, evidence presence, and freshness. All reads are fail-soft —
 * a query error yields a conservative (low) input, never a fabricated high one.
 */
export async function assembleClaimInput(sc: any, claim: ClaimRow, now: Date): Promise<ProjectionInput> {
  const nowIso = now.toISOString();

  // Distinct fresh observers of (subject, claim_type) — the cohort the privacy
  // gate counts. Fresh = expires_at null or in the future.
  const { data: obs } = await sc
    .from("intel_observations")
    .select("actor_id, presence_level, source_class, expires_at")
    .eq("subject_id", claim.subject_id)
    .eq("claim_type", claim.claim_type);
  const freshObs = ((obs as any[]) ?? []).filter((o) => !o.expires_at || o.expires_at > nowIso);
  const distinctActors = new Set(freshObs.map((o) => o.actor_id)).size;
  const maxPresenceLevel = freshObs.reduce(
    (m, o) => ((PRESENCE_STRENGTH[o.presence_level] ?? 0) > (PRESENCE_STRENGTH[m] ?? 0) ? o.presence_level : m),
    "P0",
  );
  const sourceClass = freshObs.reduce(
    (m, o) => ((SOURCE_RELIABILITY[o.source_class] ?? 0) > (SOURCE_RELIABILITY[m] ?? 0) ? o.source_class : m),
    "firsthand_unverified",
  );

  // Confirmation stances for this claim.
  const { data: confs } = await sc.from("intel_confirmations").select("stance").eq("claim_id", claim.id);
  let agrees = 0, disagrees = 0;
  for (const c of ((confs as any[]) ?? [])) {
    if (c.stance === "agree") agrees++;
    else if (c.stance === "disagree") disagrees++;
  }

  // Evidence quality: intel_evidence links to an observation (observation_id) and
  // its contributor, not to a claim/subject directly, and Phase-1 quick signals
  // attach none. v1 treats a claim as evidence-thin (conservative) until the
  // observation→evidence linkage is wired into this assembly.
  const hasEvidence = false;

  // Freshness: age of the claim's observation relative to its TTL.
  const policy = await getPolicy(sc, claim.claim_type);
  const ttl = policy?.ttlSeconds ?? 0;
  const ageSeconds = Math.max(0, (now.getTime() - new Date(claim.observed_at).getTime()) / 1000);
  const ageRatio = ttl > 0 ? ageSeconds / ttl : 1;

  const evidence: ClaimEvidence = {
    distinctActors,
    agrees,
    disagrees,
    maxPresenceLevel,
    hasEvidence,
    sourceClass,
    ageRatio,
    conflicting: claim.status === "conflicting",
  };

  return {
    claimType: claim.claim_type,
    value: claim.value,
    observedAt: claim.observed_at,
    distinctActors,
    sensitiveSubject: false,
    components: deriveComponents(evidence),
    penalties: derivePenalties(evidence),
  };
}
