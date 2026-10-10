/**
 * Telegraph §30A.1 — the canonical relationship VOCABULARY, and its derivation.
 *
 * Spec §30A.1: "Relationship origins include FOLLOW, MUTUAL_FOLLOW, TRIP, CREW,
 * EVENT, BUMP, NEARBY, BUDDY, PLAN, and MANUAL. Relationship states include
 * REQUEST_ONLY, ACTIVE, TEMPORARY, RESTRICTED, BLOCKED, and EXPIRED.
 * Relationship policy is an input to ConversationPolicy; it is not a
 * replacement for block, age, safety, membership, or object-specific
 * authorization." (census-telegraph T380: "Neither vocabulary exists in any form.")
 *
 * ── THIS IS PURE ────────────────────────────────────────────────────────────
 * `deriveTelegraphRelationship` takes FACTS and touches no table. The facts are
 * gathered by services/telegraph/telegraphRelationship.ts, which reads follows,
 * friendship, shared trips and shared circles through the EXISTING resolver
 * (lib/messagingPermissions.ts#canMessage — the one services/telegraph/
 * reachablePeople.ts#relationshipFrom already consumes), and adds only the
 * three sources that resolver does not read: shared events, Rent-a-Buddy
 * bookings and shared plans (meetups), plus an accepted message request.
 *
 * ── TWO ORIGINS ARE DECLARED AND NEVER PRODUCED ─────────────────────────────
 * BUMP and NEARBY have no source in this repository that records a
 * person-to-person connection: no bump exchange table exists, and Nearby
 * observations are a proximity budget, not a relationship (§30A.13 forbids
 * Nearby becoming mass-DM infrastructure). They are in the vocabulary so it is
 * the spec's, and `UNPRODUCED_ORIGINS` says why nothing emits them. Producing
 * them from anything that exists would be inventing a connection.
 *
 * ── STATES, AND THE ORDER THEY ARE DECIDED IN ───────────────────────────────
 *   BLOCKED       a block in EITHER direction (the direction is never stated).
 *   RESTRICTED    the VIEWER is under a Trust messaging restriction (D-24:
 *                 "cannot start new conversations").
 *   ACTIVE        at least one DURABLE origin: FOLLOW, MUTUAL_FOLLOW, CREW
 *                 (a shared circle), MANUAL (an accepted message request).
 *   TEMPORARY     no durable origin, at least one LIVE time-bound origin:
 *                 TRIP (current shared crew), EVENT, BUDDY (a booking in a live
 *                 state), PLAN (an accepted meetup not yet over).
 *   EXPIRED       no durable or live origin, but a time-bound one that ENDED
 *                 (event over, booking completed, plan over).
 *   REQUEST_ONLY  no origin at all: contact goes through the person's own
 *                 message-privacy door, which ConversationPolicy still decides.
 *
 * FRIEND (a user_friendships row) is not a §30A.1 origin; it is read as
 * MUTUAL_FOLLOW — a two-sided, accepted, durable connection — and named so.
 */

export const RELATIONSHIP_ORIGINS = [
  "FOLLOW", "MUTUAL_FOLLOW", "TRIP", "CREW", "EVENT", "BUMP", "NEARBY", "BUDDY", "PLAN", "MANUAL",
] as const;
export type TelegraphRelationshipOrigin = (typeof RELATIONSHIP_ORIGINS)[number];

export const RELATIONSHIP_STATES = ["REQUEST_ONLY", "ACTIVE", "TEMPORARY", "RESTRICTED", "BLOCKED", "EXPIRED"] as const;
export type TelegraphRelationshipState = (typeof RELATIONSHIP_STATES)[number];

export const DURABLE_ORIGINS: readonly TelegraphRelationshipOrigin[] = ["FOLLOW", "MUTUAL_FOLLOW", "CREW", "MANUAL"];
export const TIME_BOUND_ORIGINS: readonly TelegraphRelationshipOrigin[] = ["TRIP", "EVENT", "BUDDY", "PLAN"];

export const UNPRODUCED_ORIGINS: Readonly<Partial<Record<TelegraphRelationshipOrigin, string>>> = {
  BUMP: "No table records a bump exchange between two people; nothing can evidence this origin.",
  NEARBY: "Nearby observations are a proximity budget, not a connection, and §30A.13 forbids Nearby becoming a contact channel.",
};

export interface RelationshipFacts {
  blocked: boolean;
  viewerMessagingRestricted: boolean;
  isFriend: boolean;
  viewerFollows: boolean;
  otherFollows: boolean;
  sharedCircle: boolean;
  sharedTrip: boolean;
  acceptedRequest: boolean;
  /** Time-bound origins, each with whether it is still live. */
  events: { live: number; ended: number };
  buddy: { live: number; ended: number };
  plans: { live: number; ended: number };
}

export interface TelegraphRelationship {
  readonly state: TelegraphRelationshipState;
  /** Origins that are in force now (live time-bound ones included, ended ones not). */
  readonly origins: readonly TelegraphRelationshipOrigin[];
  /** Time-bound origins that existed and ended. */
  readonly expiredOrigins: readonly TelegraphRelationshipOrigin[];
}

export function deriveTelegraphRelationship(f: RelationshipFacts): TelegraphRelationship {
  const origins: TelegraphRelationshipOrigin[] = [];
  const expired: TelegraphRelationshipOrigin[] = [];
  if (f.isFriend || (f.viewerFollows && f.otherFollows)) origins.push("MUTUAL_FOLLOW");
  else if (f.viewerFollows || f.otherFollows) origins.push("FOLLOW");
  if (f.sharedCircle) origins.push("CREW");
  if (f.acceptedRequest) origins.push("MANUAL");
  if (f.sharedTrip) origins.push("TRIP");
  for (const [origin, c] of [["EVENT", f.events], ["BUDDY", f.buddy], ["PLAN", f.plans]] as const) {
    if (c.live > 0) origins.push(origin);
    else if (c.ended > 0) expired.push(origin);
  }

  let state: TelegraphRelationshipState;
  if (f.blocked) state = "BLOCKED";
  else if (f.viewerMessagingRestricted) state = "RESTRICTED";
  else if (origins.some((o) => DURABLE_ORIGINS.includes(o))) state = "ACTIVE";
  else if (origins.some((o) => TIME_BOUND_ORIGINS.includes(o))) state = "TEMPORARY";
  else if (expired.length > 0) state = "EXPIRED";
  else state = "REQUEST_ONLY";

  // Across a block nothing about the relationship is stated (§15.3: no
  // subsystem may rediscover a blocked relationship).
  if (state === "BLOCKED") return { state, origins: [], expiredOrigins: [] };
  return { state, origins, expiredOrigins: expired };
}
