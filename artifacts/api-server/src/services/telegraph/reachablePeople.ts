/**
 * reachablePeople — Telegraph §30A.2's `ReachablePersonProjection`, and §4.3's
 * `nearbyRank`.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT §30A.2 ASKS FOR, AND WHY IT IS ONE OBJECT
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * "Nearby is geographical, availability temporal, reachability contextual;
 *  clients must not recompute this eligibility from raw tables."
 *
 * A client that assembles reachability itself has to read presence, availability
 * and relationship tables directly, and then every client — every version of
 * every client — owns a copy of the privacy rules. This module is the server-side
 * answer: one projection, built once, carrying only what the viewer is entitled
 * to know, with no raw input for a client to re-derive from.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THREE DISCLOSURE CHANNELS, ALL CLOSED HERE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * (a) THE RESPONSE BODY. `ReachablePersonProjection` has no `lat`, no `lng`, no
 *     `distanceKm`, no `etaMinutes` and no timestamp finer than a bucket. Its
 *     `proximity.precision` is the LITERAL TYPE `"bucket"`, so the projection
 *     cannot be given a precise rung without changing the type — and every
 *     construction site is then a compile error rather than a code review.
 *
 * (b) LOGS. `reachableTelemetry` is the only summary this module produces and it
 *     emits counts, buckets and refusal reasons. Nothing in this file passes a
 *     coordinate to a logger, because nothing in this file ever holds one: the
 *     proximity inputs arrive as `CoarsePoint`s (see lib/proximityBuckets.ts)
 *     and the raw position never crosses the boundary.
 *
 * (c) RANKING ORDER — the channel that gets missed. If results are ordered by
 *     true distance, the ORDER discloses distance no matter how coarse the
 *     number beside it is: the first person in a bucketed list is the nearest
 *     person in that bucket, and polling while walking turns a list into a
 *     bearing. `nearbyRank` therefore consumes `proximity.bucket` — an index on
 *     a five-rung ladder — and never a distance. `orderReachablePeople` breaks
 *     ties on `stableTiebreak`, a deterministic per-(viewer, person) hash with
 *     no geographic content, NOT on anything positional. The test
 *     `ranking order does not disclose sub-bucket distance` swaps two people's
 *     true distances inside one bucket and asserts the order is unchanged.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT A FIFTH RELATIONSHIP RESOLVER
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * §30A.1's evidence names four independent relationship resolvers and calls the
 * duplication the anti-pattern. So this module resolves nothing: it CONSUMES
 * `lib/messagingPermissions.ts#canMessage`'s `relationship_context` — the
 * resolver that already folds friendship, follows, shared trips and shared
 * circles together — and projects it onto §30A.1's origin vocabulary.
 * `relationshipFrom` takes a context and touches no table.
 *
 * `canMessage`'s own `degraded` flag is honoured: a person whose relationship
 * reads failed is REFUSED, not published at a floor. A floor is safe for a
 * permission decision (it can only restrict) but not for a presence surface,
 * where the floor would be published as a fact about someone.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * CONSENT FAILS CLOSED, INCLUDING WHEN THE READ FAILS
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Every gate below is expressed as "publish only if consent is affirmatively
 * present", never "publish unless consent is denied". `projectReachablePerson`
 * takes explicit `*Error` inputs for the reads its decisions rest on, because a
 * PostgREST failure RESOLVES as `{ data: null, error }` and a caller reading
 * only `data` cannot tell a refusal from an empty table.
 */
import {
  overlapBandForMinutes,
  overlapBandRank,
  overlapMinutes,
  proximityBucketBetween,
  proximityBucketRank,
  travelBandForBucket,
  travelBandRank,
  type CoarsePoint,
  type OverlapBand,
  type ProximityBucket,
  type TravelBand,
} from "../../lib/proximityBuckets.js";
import {
  permitsPrivateMapUse,
  suppressesSurface,
  type InvisibleModeState,
} from "../../lib/invisibleMode.js";
import { hash01 } from "../../lib/mapTravelers.js";
import type { RelationshipContext } from "../../lib/messagingPermissions.js";

// ── Relationship, projected from the canonical resolver ───────────────────────

/**
 * Ordered weakest → strongest. A tier is a summary of the relationship context,
 * not a new source of truth for it.
 */
export const RELATIONSHIP_TIERS = [
  "none",
  "follow",
  "mutual_follow",
  "shared_context",
  "friend",
  "crew",
] as const;
export type RelationshipTier = (typeof RELATIONSHIP_TIERS)[number];

/** §30A.1's origin vocabulary, restricted to the origins this tree can evidence. */
export const RELATIONSHIP_ORIGINS = ["FOLLOW", "MUTUAL_FOLLOW", "TRIP", "CREW", "FRIEND"] as const;
export type RelationshipOrigin = (typeof RELATIONSHIP_ORIGINS)[number];

export interface ProjectedRelationship {
  readonly tier: RelationshipTier;
  readonly origins: readonly RelationshipOrigin[];
}

/** Rank; HIGHER = stronger. */
export function relationshipTierRank(tier: RelationshipTier): number {
  const i = RELATIONSHIP_TIERS.indexOf(tier);
  return i < 0 ? 0 : i;
}

/**
 * Project `canMessage`'s relationship context onto a tier + origins.
 *
 * Pure. Takes no client, reads no table, and cannot disagree with the resolver
 * because it has no independent inputs.
 */
export function relationshipFrom(ctx: RelationshipContext): ProjectedRelationship {
  const origins: RelationshipOrigin[] = [];
  if (ctx.sharedCircle) origins.push("CREW");
  if (ctx.isFriend) origins.push("FRIEND");
  if (ctx.sharedTrip) origins.push("TRIP");
  if (ctx.senderFollowsRecipient && ctx.recipientFollowsSender) origins.push("MUTUAL_FOLLOW");
  else if (ctx.senderFollowsRecipient || ctx.recipientFollowsSender) origins.push("FOLLOW");

  let tier: RelationshipTier = "none";
  if (ctx.sharedCircle) tier = "crew";
  else if (ctx.isFriend) tier = "friend";
  else if (ctx.sharedTrip) tier = "shared_context";
  else if (ctx.senderFollowsRecipient && ctx.recipientFollowsSender) tier = "mutual_follow";
  else if (ctx.senderFollowsRecipient || ctx.recipientFollowsSender) tier = "follow";
  return { tier, origins };
}

// ── Availability, as a published state ────────────────────────────────────────

/**
 * `unknown` is distinct from `unavailable` on purpose: "we were not told" and
 * "they said no" are different facts, and collapsing them is how a surface ends
 * up asserting something nobody published.
 */
export const AVAILABILITY_STATES = [
  "available_now",
  "available_later",
  "unavailable",
  "unknown",
] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

export function availabilityStateRank(state: AvailabilityState): number {
  const order: AvailabilityState[] = ["available_now", "available_later", "unknown", "unavailable"];
  const i = order.indexOf(state);
  return i < 0 ? order.length - 1 : i;
}

export const FRESHNESS_STATES = ["live", "recent", "stale"] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

export const SAFETY_STATES = ["clear", "caution"] as const;
export type SafetyState = (typeof SAFETY_STATES)[number];

// ── The projection ────────────────────────────────────────────────────────────

export interface ReachablePersonProjection {
  readonly personId: string;
  readonly relationship: ProjectedRelationship;
  readonly availability: {
    readonly state: AvailabilityState;
    readonly intents: readonly string[];
    readonly overlap: OverlapBand;
    /** Coarse expiry: the ISO instant the published window ends, or null. */
    readonly publishedUntil: string | null;
  };
  readonly proximity: {
    readonly bucket: ProximityBucket;
    /**
     * A LITERAL TYPE. This projection is bucket-only by construction; a precise
     * rung is not representable here, so the default path cannot emit one and a
     * future "just this once" cannot be added without changing the type.
     */
    readonly precision: "bucket";
    readonly travel: TravelBand;
    readonly freshness: FreshnessState;
  };
  readonly sharedContext: {
    readonly trips: number;
    readonly circles: number;
    readonly kinds: readonly string[];
  };
  readonly privacy: {
    readonly availabilityPublished: boolean;
    readonly proximityPublished: boolean;
    /** Always false here — see `proximity.precision`. */
    readonly preciseShared: false;
  };
  readonly safety: { readonly state: SafetyState };
  readonly rank: number;
}

/** Why a candidate was not published. Coordinate-free, and countable in logs. */
export const REFUSAL_REASONS = [
  "self",
  "blocked",
  "relationship_unknown",
  "invisible",
  "no_presence_consent",
  "no_availability_consent",
  "stale",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export type ProjectionOutcome =
  | { readonly ok: true; readonly person: ReachablePersonProjection }
  | { readonly ok: false; readonly refusal: RefusalReason };

// ── nearbyRank ────────────────────────────────────────────────────────────────

/**
 * §4.3's ranking inputs, every one of them already banded or bucketed.
 *
 * There is no `distanceKm`, no `etaMinutes` and no `lastSeenAt`. The type is the
 * guarantee: a caller cannot pass a distance to the ranker, so the ranker cannot
 * order by one, so the ORDER cannot disclose one.
 */
export interface NearbyRankFactors {
  readonly availability: AvailabilityState;
  readonly relationship: RelationshipTier;
  /** Count of intents the two people share, clamped by the caller's vocabulary. */
  readonly intentOverlap: number;
  /** Count of shared trips + circles. */
  readonly sharedContextCount: number;
  readonly overlap: OverlapBand;
  readonly travel: TravelBand;
  readonly proximity: ProximityBucket;
  readonly freshness: FreshnessState;
  readonly safety: SafetyState;
}

/**
 * Weights. Availability outranks proximity deliberately: §4.1 says AVAILABLE is
 * not NEARBY, and a surface that sorts by nearness first is a proximity radar
 * with an availability label on it.
 */
const W = {
  availability: 1000,
  relationship: 180,
  proximity: 120,
  overlap: 90,
  sharedContext: 60,
  intent: 45,
  travel: 30,
  freshness: 25,
  safetyCaution: -400,
} as const;

const FRESHNESS_PENALTY = new Map<FreshnessState, number>([
  ["live", 0],
  ["recent", 1],
  ["stale", 2],
]);

/** Cap on the count-shaped inputs, so one prolific dimension cannot dominate. */
const COUNT_CAP = 4;

/**
 * A single integer score. Higher ranks earlier.
 *
 * Every term is a rank on a small ladder multiplied by a weight, so the function
 * is total, deterministic and has no floating-point tail a client could invert
 * to recover an input. It is deliberately NOT normalised to 0..1: a normalised
 * score varies continuously with its inputs, and a continuous score computed
 * from a bucketed distance is the sort of number people try to invert.
 */
export function nearbyRank(f: NearbyRankFactors): number {
  let score = 0;
  score += W.availability * (3 - availabilityStateRank(f.availability));
  score += W.relationship * relationshipTierRank(f.relationship);
  score += W.proximity * (5 - proximityBucketRank(f.proximity));
  score += W.overlap * (4 - overlapBandRank(f.overlap));
  score += W.sharedContext * Math.min(COUNT_CAP, Math.max(0, Math.trunc(f.sharedContextCount)));
  score += W.intent * Math.min(COUNT_CAP, Math.max(0, Math.trunc(f.intentOverlap)));
  score += W.travel * (4 - travelBandRank(f.travel));
  score += W.freshness * (2 - (FRESHNESS_PENALTY.get(f.freshness) ?? 2));
  if (f.safety === "caution") score += W.safetyCaution;
  return score;
}

/**
 * Deterministic, geography-free tiebreak.
 *
 * Two people with identical rank must be ordered SOMEHOW, and every natural
 * candidate leaks: true distance leaks distance, `last_seen_at` leaks movement,
 * insertion order leaks the database's own geographic index order. A hash of
 * (viewer, person) leaks nothing, is stable across polls — so the list does not
 * shuffle under the viewer's thumb — and differs per viewer, so two viewers
 * cannot compare their orderings to triangulate.
 */
export function stableTiebreak(viewerId: string, personId: string): number {
  return hash01(`${viewerId}:${personId}`);
}

/**
 * Order a projected list. Rank first, then the pseudonymous tiebreak.
 *
 * Note the input type: `ReachablePersonProjection` carries no distance, so this
 * comparator could not sort by one even if it wanted to.
 */
export function orderReachablePeople(
  viewerId: string,
  people: readonly ReachablePersonProjection[],
): ReachablePersonProjection[] {
  return [...people].sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    const ta = stableTiebreak(viewerId, a.personId);
    const tb = stableTiebreak(viewerId, b.personId);
    if (ta !== tb) return ta - tb;
    return a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0;
  });
}

// ── Building one projection ───────────────────────────────────────────────────

export interface ReachablePersonInputs {
  readonly viewerId: string;
  readonly personId: string;
  /** Viewer's own coarse position, or null when the viewer publishes none. */
  readonly viewerPoint: CoarsePoint | null;
  /** Person's coarse position, or null when they publish none. */
  readonly personPoint: CoarsePoint | null;
  /** From `canMessage(...).relationship_context`. */
  readonly relationshipContext: RelationshipContext | null;
  /** `canMessage(...).degraded` — a relationship read failed. */
  readonly relationshipDegraded: boolean;
  /** True when a block exists in either direction. */
  readonly blocked: boolean;
  /**
   * Null means the block state could NOT be established. Distinct from `false`,
   * and refused rather than published.
   */
  readonly blockStateKnown: boolean;
  readonly personInvisible: InvisibleModeState;
  readonly viewerInvisible: InvisibleModeState;
  /** Affirmative presence consent: the person's effective discovery visibility. */
  readonly personPresenceConsent: boolean;
  /** Affirmative availability consent, already resolved by the audience policy. */
  readonly availabilityPublished: boolean;
  readonly availabilityState: AvailabilityState;
  readonly availabilityIntents: readonly string[];
  readonly availabilityWindow: { startMs: number; endMs: number } | null;
  readonly viewerWindow: { startMs: number; endMs: number } | null;
  readonly availabilityPublishedUntil: string | null;
  readonly personFreshness: FreshnessState;
  readonly safety: SafetyState;
  readonly sharedTrips: number;
  readonly sharedCircles: number;
  readonly viewerIntents: readonly string[];
}

/**
 * Build one projection, or refuse.
 *
 * Pure: no clock, no client, no logger. Every refusal is a NAMED reason so the
 * route can report honest counts instead of an unexplained short list.
 */
export function projectReachablePerson(input: ReachablePersonInputs): ProjectionOutcome {
  if (input.personId === input.viewerId) return { ok: false, refusal: "self" };

  // Safety first, and unknown counts as blocked.
  if (!input.blockStateKnown || input.blocked) return { ok: false, refusal: "blocked" };

  // A relationship we could not establish is not a relationship we may publish.
  if (!input.relationshipContext || input.relationshipDegraded) {
    return { ok: false, refusal: "relationship_unknown" };
  }

  const relationship = relationshipFrom(input.relationshipContext);

  // §4.4, applied as TWO independent suppressions rather than one early exit.
  //
  // An early `if (invisible) return refusal` would have been shorter and would
  // have left the availability half unreachable — dead code that looks like a
  // gate, and that a mutation test cannot tell from a gate, which is how one in
  // this repo came to be deleted as "redundant". Suppressing each surface where
  // it is USED keeps both live: knock either one out and an invisible person
  // starts publishing through the other, which `an invisible PERSON is removed
  // from Nearby entirely` catches.
  const nearbySuppressed = suppressesSurface(input.personInvisible, "nearby");
  const availabilitySuppressed = suppressesSurface(input.personInvisible, "public_availability");

  // Availability is published only where an audience policy admitted the viewer
  // AND the person is not invisible for public availability.
  const availabilityPublished = input.availabilityPublished && !availabilitySuppressed;
  const availabilityState: AvailabilityState = availabilityPublished
    ? input.availabilityState
    : "unknown";

  // Proximity needs affirmative consent from the person AND a point from the
  // viewer. A viewer who publishes nothing measures from nowhere — which is the
  // reciprocity §4.2 asks for, expressed as arithmetic rather than a rule.
  const viewerPoint = suppressesSurface(input.viewerInvisible, "nearby") ? null : input.viewerPoint;
  const personPoint =
    input.personPresenceConsent && !nearbySuppressed ? input.personPoint : null;
  const bucket = proximityBucketBetween(viewerPoint, personPoint);
  const proximityPublished = bucket !== "unknown";

  // Nothing to say at all is a refusal, not an empty card: a row that carries
  // neither availability nor proximity is a person's name published on a
  // presence surface for no stated reason.
  if (!availabilityPublished && !proximityPublished) {
    if (nearbySuppressed || availabilitySuppressed) return { ok: false, refusal: "invisible" };
    return {
      ok: false,
      refusal: input.personPresenceConsent ? "no_availability_consent" : "no_presence_consent",
    };
  }

  const freshness = proximityPublished ? input.personFreshness : "stale";
  if (proximityPublished && freshness === "stale" && !availabilityPublished) {
    return { ok: false, refusal: "stale" };
  }

  const overlap = availabilityPublished
    ? overlapBandForMinutes(overlapMinutes(input.viewerWindow, input.availabilityWindow))
    : "unknown";

  const intentOverlap = availabilityPublished
    ? countSharedIntents(input.viewerIntents, input.availabilityIntents)
    : 0;

  const travel = travelBandForBucket(bucket);
  const sharedContextCount = Math.max(0, input.sharedTrips) + Math.max(0, input.sharedCircles);

  const rank = nearbyRank({
    availability: availabilityState,
    relationship: relationship.tier,
    intentOverlap,
    sharedContextCount,
    overlap,
    travel,
    proximity: bucket,
    freshness,
    safety: input.safety,
  });

  const kinds: string[] = [];
  if (input.sharedTrips > 0) kinds.push("trip");
  if (input.sharedCircles > 0) kinds.push("circle");

  return {
    ok: true,
    person: {
      personId: input.personId,
      relationship,
      availability: {
        state: availabilityState,
        intents: availabilityPublished ? [...input.availabilityIntents] : [],
        overlap,
        publishedUntil: availabilityPublished ? input.availabilityPublishedUntil : null,
      },
      proximity: { bucket, precision: "bucket", travel, freshness },
      sharedContext: { trips: input.sharedTrips, circles: input.sharedCircles, kinds },
      privacy: { availabilityPublished, proximityPublished, preciseShared: false },
      safety: { state: input.safety },
      rank,
    },
  };
}

/** Shared intents, case-insensitively, without leaking the intent lists. */
export function countSharedIntents(
  viewerIntents: readonly string[],
  personIntents: readonly string[],
): number {
  if (viewerIntents.length === 0 || personIntents.length === 0) return 0;
  const mine = new Set(viewerIntents.map((i) => i.toLowerCase()));
  let n = 0;
  for (const i of personIntents) if (mine.has(i.toLowerCase())) n++;
  return n;
}

// ── Telemetry (channel b) ─────────────────────────────────────────────────────

export interface ReachableTelemetry {
  readonly published: number;
  readonly refusals: Readonly<Record<string, number>>;
  readonly buckets: Readonly<Record<string, number>>;
  readonly viewerInvisible: boolean;
  readonly degraded: boolean;
}

/**
 * The ONLY summary this module hands a logger.
 *
 * Counts, bucket names and refusal reasons — no ids, no coordinates, no city
 * names, no timestamps. A log line that names the bucket a specific person fell
 * into is a disclosure with a longer retention than the response was.
 */
export function reachableTelemetry(
  people: readonly ReachablePersonProjection[],
  refusals: readonly RefusalReason[],
  opts: { viewerInvisible: boolean; degraded: boolean },
): ReachableTelemetry {
  const refusalCounts: Record<string, number> = {};
  for (const r of refusals) refusalCounts[r] = (refusalCounts[r] ?? 0) + 1;
  const bucketCounts: Record<string, number> = {};
  for (const p of people) {
    bucketCounts[p.proximity.bucket] = (bucketCounts[p.proximity.bucket] ?? 0) + 1;
  }
  return {
    published: people.length,
    refusals: refusalCounts,
    buckets: bucketCounts,
    viewerInvisible: opts.viewerInvisible,
    degraded: opts.degraded,
  };
}

/**
 * §4.4's second clause, restated where a reader of this module will see it: a
 * viewer in invisible mode still gets their own map. Referenced by the route so
 * the private-map path cannot be "tidied away" as unused.
 */
export function viewerMayUsePrivateMap(state: InvisibleModeState): true {
  return permitsPrivateMapUse(state);
}
