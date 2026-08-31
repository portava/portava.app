/**
 * MediaContributorReputationService — Media v2 Phase 10 (§25).
 *
 * Assembles a media contributor's INTELLIGENCE-TRUST reputation from the
 * EXISTING intel tables ONLY, then hands the counts to the pure
 * lib/mediaContributorReputation.computeContributorReputation. It reads
 * intel_observations (acceptance / place experience) and intel_state_snapshots
 * (independent corroboration) — and DELIBERATELY reads NO social table
 * (passport_stamps, follows, likes). Popularity has no path into this number.
 *
 * Every read is fail-open to 0 (Promise.allSettled) so a partial DB failure
 * yields a lower reputation, never an inflated or errored one.
 */
import {
  computeContributorReputation,
  type ContributorIntelSignals,
  type ContributorReputation,
} from "../../lib/mediaContributorReputation.js";

/** Observation moderation states that count as ACCEPTED (useful) contributions. */
const ACCEPTED_STATES = new Set(["allowed"]);

export interface ReputationScope {
  contributorId: string;
  /** Optional place/subject for the Place-Expertise dimension. */
  subjectId?: string | null;
}

/**
 * Read the intel signals for a contributor and compute the three §25 dimensions.
 * SOCIAL POPULARITY IS NEVER READ — there is no query here against any follow /
 * stamp / like table, so a contributor's audience cannot influence the result.
 */
export async function readContributorReputation(
  sc: any,
  scope: ReputationScope,
): Promise<ContributorReputation> {
  const [obsRes, snapRes] = await Promise.allSettled([
    sc
      .from("intel_observations")
      .select("subject_id, claim_type, moderation_state")
      .eq("actor_id", scope.contributorId)
      .limit(5000),
    // Served live snapshots at the subjects the contributor observed carry
    // distinct_actors — the independent-corroboration count the aggregator uses.
    sc
      .from("intel_state_snapshots")
      .select("subject_id, claim_type, distinct_actors, privacy_eligible")
      .limit(5000),
  ]);

  const obs: any[] = obsRes.status === "fulfilled" ? ((obsRes.value as any).data ?? []) : [];

  let total = 0;
  let accepted = 0;
  let placeAccepted = 0;
  // The distinct (subject, claim) cells this contributor took part in.
  const contributorCells = new Set<string>();
  for (const o of obs) {
    total += 1;
    const isAccepted = ACCEPTED_STATES.has(String(o.moderation_state));
    if (isAccepted) accepted += 1;
    if (scope.subjectId && o.subject_id === scope.subjectId && isAccepted) placeAccepted += 1;
    contributorCells.add(`${o.subject_id}|${o.claim_type}`);
  }

  // Live Accuracy: of the contributor's cells that reached a privacy-eligible
  // served snapshot, how many were INDEPENDENTLY corroborated (distinct_actors
  // >= 2). Opportunities = the contributor's cells with any served snapshot.
  const snaps: any[] = snapRes.status === "fulfilled" ? ((snapRes.value as any).data ?? []) : [];
  let corroborationOpportunities = 0;
  let corroboratedObservations = 0;
  for (const s of snaps) {
    if (s.privacy_eligible !== true) continue;
    const key = `${s.subject_id}|${s.claim_type}`;
    if (!contributorCells.has(key)) continue;
    corroborationOpportunities += 1;
    if (Number(s.distinct_actors ?? 0) >= 2) corroboratedObservations += 1;
  }

  const signals: ContributorIntelSignals = {
    acceptedObservations: accepted,
    totalObservations: total,
    placeAcceptedObservations: placeAccepted,
    corroboratedObservations,
    corroborationOpportunities,
  };
  return computeContributorReputation(signals);
}
