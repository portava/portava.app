/**
 * MediaContributorReputationService — Media v2 Phase 10 (§25).
 *
 * Assembles a media contributor's §25 reputation from EXISTING tables only and
 * hands the counts to the pure lib/mediaContributorReputation. Intel trust reads
 * intel_observations (acceptance / place experience) and intel_state_snapshots
 * (corroboration); §25 Trip Expertise reads PUBLIC completed trips (see
 * readJourneySignals). It DELIBERATELY reads NO social table (passport_stamps,
 * follows, likes). Popularity has no path into this number.
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
  type ContributorReputation, type ContributorJourneySignals,
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
 * Read intel and PUBLIC-journey signals for a contributor; compute four §25 dimensions.
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
  //
  // §25 Trip Expertise needs no contributor-token resolution — it reads trips,
  // not intel — so it starts now and is joined at both returns below.
  const journeyP = readJourneySignals(sc, scope);
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
    }, await journeyP);
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
  return computeContributorReputation(signals, await journeyP);
}

// ── §25 Trip Expertise — relevant, PUBLIC journey history ────────────────────

/** Trip rows the journey read needs. Never a coordinate, never a member list. */
const JOURNEY_TRIP_COLUMNS = "id, destination_city, end_date, status, visibility, show_destination_city";

/**
 * Count the contributor's COMPLETED, PUBLIC trips — owned, or joined as an
 * accepted member — and, when the scope names a place, how many of them went
 * to that place's city.
 *
 * WHAT COUNTS AS A JOURNEY HERE, AND WHY THE BAR IS HIGH. The reputation this
 * feeds is served to any authenticated caller (routes/mediaViewRequest), so a
 * trip counts ONLY when its owner made it `visibility = 'public'` AND left
 * `show_destination_city` on. A private, buddies-only or invite trip never moves
 * the number, whatever client the caller passed — the rule is applied here, not
 * left to row-level security. Completed means the end date has passed or the
 * trip is marked `completed`; a cancelled trip is not a journey.
 *
 * FAIL-SOFT TO ZERO, like every read in this service: a failed read lowers the
 * dimension, it never inflates it.
 */
export async function readJourneySignals(
  sc: any,
  scope: ReputationScope,
  nowMs: number = Date.now(),
): Promise<ContributorJourneySignals> {
  const empty: ContributorJourneySignals = { completedTrips: 0, completedTripsInScope: 0, scoped: false };
  try {
    const [owned, memberships, place] = await Promise.all([
      sc.from("trips").select(JOURNEY_TRIP_COLUMNS).eq("owner_id", scope.contributorId).limit(500),
      sc.from("trip_members").select("trip_id, status, role").eq("user_id", scope.contributorId).limit(500),
      scope.subjectId
        ? sc.from("places").select("id, city").eq("id", scope.subjectId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (owned.error || memberships.error) return empty;
    const memberTripIds = ((memberships.data as any[]) ?? [])
      .filter((m) => m?.status === "accepted" && m?.role !== "invited")
      .map((m) => String(m.trip_id));
    let joined: any[] = [];
    if (memberTripIds.length > 0) {
      const res = await sc.from("trips").select(JOURNEY_TRIP_COLUMNS).in("id", memberTripIds.slice(0, 500));
      if (res.error) return empty;
      joined = (res.data as any[]) ?? [];
    }
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const byId = new Map<string, any>();
    for (const t of [...((owned.data as any[]) ?? []), ...joined]) if (t?.id) byId.set(String(t.id), t);
    const scopeCity =
      !place.error && typeof (place.data as any)?.city === "string" ? String((place.data as any).city).trim().toLowerCase() : "";
    let completedTrips = 0;
    let completedTripsInScope = 0;
    for (const t of byId.values()) {
      if (t.visibility !== "public" || t.show_destination_city !== true) continue;
      if (t.status === "cancelled") continue;
      const ended = t.status === "completed" || (typeof t.end_date === "string" && t.end_date.slice(0, 10) < today);
      if (!ended) continue;
      completedTrips += 1;
      if (scopeCity && typeof t.destination_city === "string" && t.destination_city.trim().toLowerCase() === scopeCity) {
        completedTripsInScope += 1;
      }
    }
    return { completedTrips, completedTripsInScope, scoped: scopeCity.length > 0 };
  } catch {
    return empty;
  }
}
