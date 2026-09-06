/**
 * Safety publication policy — the one place that decides whether a safety claim
 * may become servable truth.
 *
 * WHY THIS FILE EXISTS AS DATA
 * ============================
 * `unsafe_density` has been in the crowd vocabulary since intelContracts was
 * written, carved out as SPECIALIST_ONLY_CROWD_LEVELS with the comment "a safety
 * claim, not a vibe: specialist review only". The Map's safetyNoticeProducer has
 * always read exactly that value. But the specialist never existed: the only
 * enforcement was a client-side refusal in quickSignal's validator, and no
 * server path could ever produce the value. The layer was built, mounted,
 * reachable from eight surfaces, and structurally incapable of showing anything.
 *
 * This module is the missing half — the policy the word "specialist" always
 * implied — written as a typed, testable contract rather than as conditionals
 * scattered through a service. It answers, in one place:
 *
 *   * which claim types are SAFETY claims at all
 *   * which source authority classes may publish without a crowd cohort
 *   * which reviewed states may publish
 *   * what corroboration ordinary community evidence still needs
 *   * what freshness applies
 *   * whether a given claim is publicly eligible, and if not, exactly why
 *
 * THE INVARIANT THIS PROTECTS
 * ===========================
 * CROWDED IS NOT UNSAFE. `busy` and `packed` are vibes; they describe a room.
 * `unsafe_density` is an assertion that people are in physical danger. Nothing
 * in this module may promote the first into the second — not a high number, not
 * a trajectory, not a model's opinion. A safety assertion is earned by REVIEW or
 * by AUTHENTICATED AUTHORITY, and by nothing else.
 *
 * WHAT IS DELIBERATELY NOT HERE (v1 scope, owner ruling 2026-09-06)
 * ================================================================
 *   * Zone, polygon, route-segment and city-area hazards. The intel spine keys
 *     every subject to `places(id)` (2130), so an area hazard is not honestly
 *     representable and must NOT be smuggled through `zone_id` — that column is
 *     bare text inside the snapshot unique index. A future `SpatialSafetyHazard`
 *     primitive owns that, with its own identity and explicit bridges.
 *   * Direct authoritative publication. See AUTHORITY_LANE_STATUS below: the
 *     lane is specified and INFRA-BLOCKED, not built, because no mechanism
 *     exists to authenticate an authoritative source. A string is not authority.
 */
import { SPECIALIST_ONLY_CROWD_LEVELS } from "./intelContracts.js";
import type { PrivacyThreshold } from "./privacyGate.js";

// ── What counts as a safety claim ────────────────────────────────────────────

/**
 * Claim types whose values can carry a safety assertion.
 *
 * v1 is exactly one, and that is a finding rather than a limitation: of the
 * eight hazard classes the product defines, only unsafe crowd density has an
 * existing canonical vocabulary. `transit.condition` and `closure.state` are
 * near-misses that model OPERATING CONDITIONS — closure.state's own contract
 * says it is "never a structural permanent-closure fact" — and an evacuation is
 * not an operating condition. Widening this set means adding claim types with
 * their own validators and freshness entries, not overloading a neighbour.
 */
export const SAFETY_CLAIM_TYPES: readonly string[] = ["crowd.level"] as const;

/**
 * Values within a safety claim type that ARE the safety assertion.
 *
 * Sourced from intelContracts rather than re-declared, so the two can never
 * drift: if a level is added to SPECIALIST_ONLY_CROWD_LEVELS it becomes a safety
 * value here automatically, and if one is removed it stops being one.
 */
export const SAFETY_CLAIM_VALUES: readonly string[] = SPECIALIST_ONLY_CROWD_LEVELS;

export function isSafetyClaimType(claimType: unknown): boolean {
  return typeof claimType === "string" && SAFETY_CLAIM_TYPES.includes(claimType);
}

/** True when this claim_type + value pair is a safety assertion, not a vibe. */
export function isSafetyAssertion(claimType: unknown, value: unknown): boolean {
  if (!isSafetyClaimType(claimType)) return false;
  const level =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (value as { level?: unknown }).level
        : null;
  return typeof level === "string" && SAFETY_CLAIM_VALUES.includes(level);
}

// ── Authority ────────────────────────────────────────────────────────────────

/**
 * How a safety assertion earned the right to be published.
 *
 * `ai_classification` is present and permanently non-publishing ON PURPOSE. A
 * model may cluster reports, suggest a type or triage a queue; it may never be
 * the reason a warning appears on a map. Naming it here makes that refusal a
 * tested property instead of an omission someone later "fixes".
 */
export type SafetyAuthority =
  | "authenticated_official"
  | "admin_review"
  | "community_corroboration"
  | "ai_classification";

/**
 * THE AUTHENTICATED-AUTHORITY LANE IS SPECIFIED AND NOT BUILT.
 *
 * Phase-0 finding, verified: nothing in this repo can establish that a source is
 * authoritative. `official_signed` exists as a source class with reliability 1.0
 * and NOTHING writes it. `disclosureSourceClass` — the only path a client
 * observation takes — returns exactly 'sponsored' or 'firsthand_unverified'.
 * `public.sources` (2121) is a PLACE-ORIGIN registry answering which supplier a
 * venue record came from; it does not authenticate a reporter.
 *
 * So a claim asserting official provenance is, today, indistinguishable from a
 * claim merely saying so. Treating it as authority would make the string itself
 * the credential — the exact failure the product contract forbids. The lane
 * stays closed until a real registration/credential primitive exists, and
 * `authorityLaneAvailable()` is the single place that answers whether it does.
 */
export const AUTHORITY_LANE_STATUS = {
  available: false,
  reason:
    "No authoritative-source authentication exists. official_signed has no writer; " +
    "disclosureSourceClass yields only sponsored|firsthand_unverified; public.sources " +
    "is place-origin provenance, not reporter authentication.",
} as const;

export function authorityLaneAvailable(): boolean {
  return AUTHORITY_LANE_STATUS.available;
}

// ── Publication thresholds ───────────────────────────────────────────────────

/**
 * The threshold for an ADMIN-REVIEWED safety assertion.
 *
 * This is not a bypass. It goes through the same `evaluatePrivacy` gate as every
 * other claim; only the numbers differ, and they differ because the question
 * differs. The ordinary intel threshold (15 distinct actors, 5 independent
 * groups, ≤20% single-group share, 10-minute delay) exists to stop an AGGREGATE
 * from re-identifying the people in it. A reviewed safety assertion is not an
 * aggregate of people — it is one authorized principal's judgement about a
 * place, and the subject is a public venue, not a person. Requiring fifteen
 * strangers to corroborate an evacuation before it may be shown would be a
 * privacy control doing safety harm.
 *
 * minUniqueActors is 1 rather than 0 because the gate rejects a threshold below
 * 1 as invalid input, and because the number is honest: the reviewer IS the
 * actor. publicationDelayMinutes is 0 — a ten-minute delay on a hazard warning
 * is a defect, not a safeguard.
 *
 * What this does NOT relax: the claim must still be a real safety type, anchored
 * to a real canonical place, within freshness, and reviewed by an authorized
 * principal. Those are checked in evaluateSafetyPublication, not here.
 */
export const SAFETY_REVIEWED_THRESHOLD: PrivacyThreshold = {
  minUniqueActors: 1,
  minIndependentGroups: 1,
  maxSingleGroupShare: 1,
  timeBucketMinutes: 5,
  publicationDelayMinutes: 0,
};

/**
 * The threshold for COMMUNITY-CORROBORATED safety evidence with no reviewer.
 *
 * Deliberately stricter than the ordinary intel threshold on the dimension that
 * matters — independent groups — and never weaker on any dimension. Severity
 * does not buy standing: a report claiming danger gets no shortcut over a report
 * claiming a queue. If anything it should be harder, because the cost of a false
 * safety warning is higher than the cost of a false vibe.
 */
export const SAFETY_COMMUNITY_THRESHOLD: PrivacyThreshold = {
  minUniqueActors: 15,
  minIndependentGroups: 6,
  maxSingleGroupShare: 0.2,
  timeBucketMinutes: 15,
  publicationDelayMinutes: 10,
};

// ── Reviewed states ──────────────────────────────────────────────────────────

/**
 * Claim statuses a safety assertion may be served from.
 *
 * Reuses the existing intel_claims lifecycle vocabulary rather than adding a
 * second status enum — candidate | active | conflicting | superseded | expired |
 * retracted | rejected already covers every transition the product needs.
 *
 * NOTE the difference from LIVE_ELIGIBLE_CLAIM_STATUSES, which admits
 * 'conflicting': a conflicting ORDINARY claim can be served with a lowered
 * confidence band, because a disagreement about how busy a bar is degrades
 * gracefully. A conflicting SAFETY claim must not be served at all. "Some people
 * say this is dangerous and others disagree" is not a warning, and showing it
 * would spend user trust on a coin flip.
 */
export const SAFETY_SERVABLE_CLAIM_STATUSES: readonly string[] = ["active"] as const;

export function isSafetyServableStatus(status: unknown): boolean {
  return typeof status === "string" && SAFETY_SERVABLE_CLAIM_STATUSES.includes(status);
}

// ── The decision ─────────────────────────────────────────────────────────────

export interface SafetyPublicationInput {
  claimType: unknown;
  value: unknown;
  status: unknown;
  /** How this assertion earned publication, if it has. */
  authority: SafetyAuthority | null;
  /** The canonical place this is anchored to. v1 requires one. */
  subjectPlaceId: string | null;
  /** Distinct contributing actors, counted truthfully by the caller. */
  distinctActors: number;
  distinctGroups?: number;
  maxGroupShare?: number;
}

export type SafetyPublicationDecision =
  | { publishable: true; authority: SafetyAuthority; threshold: PrivacyThreshold }
  | { publishable: false; reason: SafetyRefusalReason };

export type SafetyRefusalReason =
  | "not_a_safety_assertion"
  | "not_servable_status"
  | "no_canonical_place"
  | "no_authority"
  | "ai_is_never_authoritative"
  | "authority_lane_unavailable"
  | "below_community_threshold";

/**
 * Decide whether a safety assertion may be published, and say precisely why not
 * when it may not.
 *
 * The refusal reason is part of the contract, not a debugging aid. A caller that
 * cannot distinguish "there is no hazard here" from "we could not establish
 * authority" will eventually render the second as the first, and this whole
 * feature exists because that substitution is dangerous.
 *
 * This function decides ELIGIBILITY only. It does not read a database, does not
 * check freshness against a clock, and does not apply the k-anonymity arithmetic
 * — that stays in evaluatePrivacy, which this returns the threshold for.
 */
export function evaluateSafetyPublication(
  input: SafetyPublicationInput,
): SafetyPublicationDecision {
  if (!isSafetyAssertion(input.claimType, input.value)) {
    // A `busy` or `packed` claim reaching here is not an error — it is the
    // invariant working. It is ordinary intelligence and takes the ordinary path.
    return { publishable: false, reason: "not_a_safety_assertion" };
  }
  if (!isSafetyServableStatus(input.status)) {
    return { publishable: false, reason: "not_servable_status" };
  }
  // v1 is place-anchored. An assertion with no honest canonical place stays
  // evidence; it is never coerced onto a nearby venue to make it drawable.
  if (typeof input.subjectPlaceId !== "string" || input.subjectPlaceId === "") {
    return { publishable: false, reason: "no_canonical_place" };
  }

  switch (input.authority) {
    case "ai_classification":
      // Named explicitly so this refusal is a tested property, not a gap.
      return { publishable: false, reason: "ai_is_never_authoritative" };

    case "authenticated_official":
      if (!authorityLaneAvailable()) {
        return { publishable: false, reason: "authority_lane_unavailable" };
      }
      return {
        publishable: true,
        authority: "authenticated_official",
        threshold: SAFETY_REVIEWED_THRESHOLD,
      };

    case "admin_review":
      return {
        publishable: true,
        authority: "admin_review",
        threshold: SAFETY_REVIEWED_THRESHOLD,
      };

    case "community_corroboration": {
      const groups = input.distinctGroups ?? 0;
      const share = input.maxGroupShare ?? 1;
      const t = SAFETY_COMMUNITY_THRESHOLD;
      const meets =
        input.distinctActors >= t.minUniqueActors &&
        groups >= t.minIndependentGroups &&
        share <= t.maxSingleGroupShare;
      if (!meets) return { publishable: false, reason: "below_community_threshold" };
      return {
        publishable: true,
        authority: "community_corroboration",
        threshold: SAFETY_COMMUNITY_THRESHOLD,
      };
    }

    default:
      return { publishable: false, reason: "no_authority" };
  }
}
