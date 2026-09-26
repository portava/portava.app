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
 * yields a lower reputation, never an inflated or errored one. Since migration
 * 3002 the contributor's OWN rows are keyed by a rotating token rather than by
 * their account id, so the reads below are preceded by one identity resolution
 * (lib/intelConsent). It obeys the same rule: an identity that cannot be
 * resolved yields the EMPTY reputation, logged at warn, never an inflated one —
 * and never an account id, which this module neither receives nor derives.
 */
import {
  computeContributorReputation,
  type ContributorIntelSignals,
  type ContributorReputation,
} from "../../lib/mediaContributorReputation.js";
import { readOwnContributorIdentities } from "../../lib/intelConsent.js";
import { logger } from "../../lib/logger.js";

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
  // WHICH VALUES OF actor_id ARE THIS CONTRIBUTOR'S.
  //
  // Migration 3002 stopped storing the account id here: a BEFORE INSERT trigger
  // writes a rotating contributor token instead, one per 7-day epoch, derived
  // from a pepper no application role may read. `.eq("actor_id", contributorId)`
  // therefore matches nothing after it lands, and — because an empty filter is
  // not an error — this service's Promise.allSettled fail-open would have turned
  // that into "this contributor has never contributed" for everyone. The
  // database-side bridge (lib/intelConsent) runs account -> tokens, the safe
  // direction; the caller already holds the account id, and nothing here learns
  // whose a token is.
  //
  // Pre-3002 the answer is the single account id and the query below is the
  // unchanged `.eq`.
  const identities = await readOwnContributorIdentities(sc, scope.contributorId);
  if (!identities.ok) {
    // The module's declared contract is that a partial DB failure yields a LOWER
    // reputation, never an inflated one, so the empty reputation is the correct
    // degradation and is what today's failed read already produces. It is logged
    // at warn so an operator can tell it from a genuinely new contributor.
    logger.warn(
      { reason: identities.reason, detail: identities.detail },
      "MediaContributorReputationService: contributor identity could not be resolved; reputation degrades to empty",
    );
    return computeContributorReputation({
      acceptedObservations: 0,
      totalObservations: 0,
      placeAcceptedObservations: 0,
      corroboratedObservations: 0,
      corroborationOpportunities: 0,
    });
  }
  const ids = identities.identities;

  const [obsRes, snapRes] = await Promise.allSettled([
    // One identity is the pre-3002 shape and stays an `.eq` so the query, and
    // every fake that serves it, is byte-for-byte what it was.
    (ids.length === 1
      ? sc
          .from("intel_observations")
          .select("subject_id, claim_type, moderation_state")
          .eq("actor_id", ids[0])
      : sc
          .from("intel_observations")
          .select("subject_id, claim_type, moderation_state")
          .in("actor_id", ids)
    ).limit(5000),
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
