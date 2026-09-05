/**
 * Intelligence Gathering — Trail follow-up (IG-06).
 *
 * Wires the two Quick Signal contexts IG-03 deliberately deferred (spec §6):
 *   • movement → "Where next?"        → experience.next_move
 *   • exit     → "Why are you leaving?" → experience.exit_reason
 * plus the §13 crowd-movement inference math and the two gates that make an
 * aggregate publishable — the §13 privacy threshold and the bidirectional block
 * filter (acceptance test AT-10) — and the §14 arrival/outcome derivation.
 *
 * PRIVACY INVARIANT (spec §4 claim registry — experience.next_move is
 * "Aggregate cohort threshold; never single-user claim"): a next_move
 * observation is captured PRIVATE and may NEVER become a single-user published
 * claim. It surfaces only through the aggregate below, above threshold and
 * confidence floor. `mustAggregate()` enforces this at propose time; the capture
 * service refuses to mint a single-user claim for it.
 *
 * RUNTIME EFFECT: NONE on its own — pure declarations + pure functions, no
 * table of its own (movement aggregates are DERIVED at read time). The capture
 * surface is gated by `intel_trail_followup` (seeded off); the aggregate is
 * gated by `movementPrivacyMet` + `MOVEMENT_CONFIDENCE_FLOOR`.
 */

// Type-only import: lib/canonicalEvents pulls in the logger at runtime, and this
// module's "no runtime effect" property is load-bearing. lib/eventFamilies is
// pure (its own canonicalEvents import is type-only), so VERB_FAMILY is the
// runtime source of the verb vocabulary here.
import type { CanonicalEventVerb } from "./canonicalEvents.js";
import { VERB_FAMILY } from "./eventFamilies.js";
// Value import on purpose. lib/intelContracts is declarations plus pure
// functions with NO imports of its own, so pulling PRIVACY_THRESHOLD_V1 in at
// runtime preserves this module's load-bearing "no runtime effect" property —
// the same reason canonicalEvents above is imported for types only.
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ── Trail claim vocabulary (spec §6 Exit/Movement, §4 registry) ───────────────
export const TRAIL_CLAIM_TYPES = ["experience.next_move", "experience.exit_reason"] as const;
export type TrailClaimType = (typeof TRAIL_CLAIM_TYPES)[number];

/** Exit reasons (§6 "Why are you leaving?") in canonical snake_case. */
export const EXIT_REASONS = [
  "planned", "declining", "too_crowded", "denied", "slow", "unsafe", "better_option",
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

/** The §6 option copy → canonical exit reason (copy is friendlier than the enum). */
const EXIT_OPTION_MAP: Record<string, ExitReason> = {
  planned: "planned",
  declining: "declining",
  "too crowded": "too_crowded",
  denied: "denied",
  slow: "slow",
  unsafe: "unsafe",
  "better option": "better_option",
};

/** Coarse time windows for a going-next declaration — never a precise timestamp. */
export const NEXT_MOVE_TIME_WINDOWS = ["now", "soon", "later"] as const;

// ── Option → canonical Trail claim ────────────────────────────────────────────
export interface MappedTrailClaim {
  claimType: TrailClaimType;
  value: Record<string, unknown>;
}

/**
 * Map a Trail (context, option) selection to a canonical claim. For "movement"
 * the option is a COARSE destination area (neighborhood/district string), never
 * a precise place id — geography stays coarse by construction (spec §13
 * "Neighborhood/district unless venue cohort ≥30"). Returns null (fail-closed)
 * for an unrecognised option so the caller never invents vocabulary.
 */
export function mapTrailSignal(context: "exit" | "movement", option: string): MappedTrailClaim | null {
  if (context === "exit") {
    const reason = EXIT_OPTION_MAP[option];
    if (!reason) return null;
    return { claimType: "experience.exit_reason", value: { reason } };
  }
  // movement — the option is the chosen coarse destination area.
  const area = option.trim();
  if (!area || area.length > 120) return null;
  return { claimType: "experience.next_move", value: { destinationArea: area } };
}

// ── Per-claim value validators (mirror quickSignal.VALUE_VALIDATORS) ───────────
type Validator = (v: unknown) => boolean;

export const TRAIL_VALUE_VALIDATORS: Record<TrailClaimType, Validator> = {
  "experience.next_move": (v) =>
    isObj(v) &&
    typeof v.destinationArea === "string" &&
    v.destinationArea.length > 0 &&
    v.destinationArea.length <= 120 &&
    (v.timeWindow === undefined ||
      (typeof v.timeWindow === "string" && (NEXT_MOVE_TIME_WINDOWS as readonly string[]).includes(v.timeWindow))) &&
    (v.strength === undefined ||
      (typeof v.strength === "number" && Number.isFinite(v.strength) && v.strength >= 0 && v.strength <= 1)),
  "experience.exit_reason": (v) =>
    isObj(v) && typeof v.reason === "string" && (EXIT_REASONS as readonly string[]).includes(v.reason),
};

export function validateTrailClaimValue(claimType: string, value: unknown): boolean {
  const validator = TRAIL_VALUE_VALIDATORS[claimType as TrailClaimType];
  return validator ? validator(value) : false;
}

/**
 * The claim types the `trail` capture surface may STORE (IntelCaptureService
 * SURFACE_CLAIMS.trail).
 *
 * Spec §29 Phase-1 "Included" lists "experience.next_move input capture". That
 * capture is realised HERE, on the Trail surface behind `intel_trail_followup`
 * (the §26 flag for the Trail follow-up), and deliberately NOT by adding
 * next_move to quickSignal.PHASE1_CAPTURE_CLAIM_TYPES: that list defines what
 * `intel_capture_quick_signal` alone may store, and listing next_move there
 * would let a movement declaration bypass the Trail flag and break the
 * surface-isolation invariant ("surfaces cannot emit each other's claims").
 *
 * experience.exit_reason is deliberately ABSENT. It is not in the §4 claim
 * registry, has no freshness_policies row (2128 seeds only next_move for this
 * family) and therefore no TTL — storing it would silently mint an observation
 * with no expiry. mapTrailSignal still maps the §6 exit prompt to it so the
 * vocabulary is stable; contracting it is an owner ruling (a §4 row plus a TTL
 * migration), not a capture-surface change.
 */
export const PHASE1_TRAIL_CAPTURE_CLAIM_TYPES: readonly TrailClaimType[] = ["experience.next_move"];

/**
 * True iff this claim type may NEVER be published as a single-user claim and must
 * instead pass through the movement aggregate. Enforced at propose time so a
 * next_move can be captured but never surfaces one person's live destination.
 */
export function mustAggregate(claimType: string): boolean {
  return claimType === "experience.next_move";
}

// ── §13 Crowd-movement inference ──────────────────────────────────────────────
export interface MovementCounts {
  verifiedArrivals: number; // consent-based arrival confirmations at the destination
  headingTo: number;        // going-next declarations toward it
  saves: number;            // rising destination saves/monitors
  cancellations: number;    // declared-then-abandoned
}

/** movement_strength = verified_arrivals + 0.6*heading_to + 0.25*saves − 0.5*cancellations. */
export function computeMovementStrength(c: MovementCounts): number {
  return c.verifiedArrivals + 0.6 * c.headingTo + 0.25 * c.saves - 0.5 * c.cancellations;
}

/**
 * §13 Privacy threshold v1 — the values that gate any movement publication.
 *
 * DERIVED, NEVER RESTATED. Until 2026-09-05 every number here was written out
 * as a literal under a comment claiming these were "the defaults". They were a
 * COPY of lib/intelContracts.PRIVACY_THRESHOLD_V1, and a copy of a threshold is
 * a threshold that silently stops tracking: tightening the shared gate (the one
 * the A0 packet §09 requires to cover the Compass aggregate path too) would have
 * left every movement reader — lib/trailServe's cohort floor included — on the
 * old, looser floor with nothing red to show for it. This is the same
 * hard-coded-mirror class as the phantom TRAIL_OUTCOME_VERBS vocabulary below.
 *
 * The names differ from the shared record's on purpose (`minGroups` vs
 * `minIndependentGroups`, `minTimeBucketMinutes` vs `timeBucketMinutes`) — this
 * is the movement-side vocabulary and callers depend on it — so the mapping is
 * spelled out here, once, rather than left to a spread that would also drag in
 * `minVenueCohortForVenueGeography`, which is a GEOGRAPHY rule, not a floor.
 */
export const MOVEMENT_PRIVACY_V1 = {
  minUniqueActors: PRIVACY_THRESHOLD_V1.minUniqueActors,
  minGroups: PRIVACY_THRESHOLD_V1.minIndependentGroups,
  maxSingleGroupShare: PRIVACY_THRESHOLD_V1.maxSingleGroupShare,
  minTimeBucketMinutes: PRIVACY_THRESHOLD_V1.timeBucketMinutes,
  minPublicationDelayMinutes: PRIVACY_THRESHOLD_V1.publicationDelayMinutes,
} as const;

export const MOVEMENT_CONFIDENCE_FLOOR = 0.65;

export interface MovementAggregate {
  uniqueActors: number;
  groups: number;              // independent groups/parties, certified (see aggregateNextMoves)
  maxSingleGroupShare: number; // largest single group's fraction of the cohort, 0..1
  timeBucketMinutes: number;
  publicationDelayMinutes: number;
  sensitiveSubject: boolean;   // protected origin/destination → always excluded
}

/** True iff a movement aggregate clears every §13 privacy-threshold rule. Fail-closed. */
export function movementPrivacyMet(a: MovementAggregate): boolean {
  if (a.sensitiveSubject) return false; // "Sensitive/protected subjects: Always excluded"
  if (!(a.uniqueActors >= MOVEMENT_PRIVACY_V1.minUniqueActors)) return false;
  if (!(a.groups >= MOVEMENT_PRIVACY_V1.minGroups)) return false;
  if (!(a.maxSingleGroupShare <= MOVEMENT_PRIVACY_V1.maxSingleGroupShare)) return false;
  if (!(a.timeBucketMinutes >= MOVEMENT_PRIVACY_V1.minTimeBucketMinutes)) return false;
  if (!(a.publicationDelayMinutes >= MOVEMENT_PRIVACY_V1.minPublicationDelayMinutes)) return false;
  return true;
}

/** Publishable only if privacy thresholds pass AND confidence clears the floor (§13). */
export function mayPublishMovement(a: MovementAggregate, confidence: number): boolean {
  return movementPrivacyMet(a) && confidence >= MOVEMENT_CONFIDENCE_FLOOR;
}

// ── Aggregation over captured next_move observations (derivation, no new table)─
export interface NextMoveRow {
  actorId: string;
  originId: string;         // origin place (observation.subject_id)
  destinationArea: string;  // coarse area
  groupId?: string | null;  // party/crew id, if the actor moved as part of one
  observedAt: string;       // ISO
}

export interface OriginDestAggregate {
  originId: string;
  destinationArea: string;
  bucketStart: string;   // ISO — start of the 30-min window
  uniqueActors: number;
  groups: number;        // distinct certified groups (rows without a groupId are EXCLUDED)
  maxSingleGroupShare: number;
  droppedUngrouped: number; // rows we could not certify a group for
}

/**
 * Bucket next_move rows into origin→destination aggregates over fixed time
 * windows. Rows without a groupId cannot be certified as an independent party,
 * so they are EXCLUDED (fail-closed) and counted in `droppedUngrouped` rather
 * than inflating actor/group counts. Pure — no clock, callers pass `nowMs` only
 * to bound the newest bucket if they wish; here bucketing is purely by observedAt.
 */
export function aggregateNextMoves(
  rows: readonly NextMoveRow[],
  bucketMinutes = MOVEMENT_PRIVACY_V1.minTimeBucketMinutes,
): OriginDestAggregate[] {
  const bucketMs = bucketMinutes * 60_000;
  // The bucket tuple (origin, destination, window) is carried IN the accumulator,
  // never encoded into the map key and parsed back — a destination area can
  // contain any character, so there is no safe in-band delimiter.
  type Acc = {
    originId: string; destinationArea: string; bucketStart: string;
    actors: Set<string>; groupCounts: Map<string, number>; dropped: number;
  };
  const byKey = new Map<string, Acc>();

  for (const r of rows) {
    const t = Date.parse(r.observedAt);
    if (!Number.isFinite(t)) continue;
    const bucketStart = new Date(Math.floor(t / bucketMs) * bucketMs).toISOString();
    const key = JSON.stringify([r.originId, r.destinationArea, bucketStart]);
    let acc = byKey.get(key);
    if (!acc) {
      acc = { originId: r.originId, destinationArea: r.destinationArea, bucketStart, actors: new Set(), groupCounts: new Map(), dropped: 0 };
      byKey.set(key, acc);
    }
    if (!r.groupId) { acc.dropped++; continue; } // fail-closed: uncertifiable independence
    acc.actors.add(r.actorId);
    acc.groupCounts.set(r.groupId, (acc.groupCounts.get(r.groupId) ?? 0) + 1);
  }

  const out: OriginDestAggregate[] = [];
  for (const acc of byKey.values()) {
    const total = [...acc.groupCounts.values()].reduce((a, b) => a + b, 0);
    const maxGroup = acc.groupCounts.size ? Math.max(...acc.groupCounts.values()) : 0;
    out.push({
      originId: acc.originId, destinationArea: acc.destinationArea, bucketStart: acc.bucketStart,
      uniqueActors: acc.actors.size,
      groups: acc.groupCounts.size,
      maxSingleGroupShare: total > 0 ? maxGroup / total : 0,
      droppedUngrouped: acc.dropped,
    });
  }
  return out;
}

// ── §14 Arrival / outcome link (derivation over family='outcome' events) ──────
/**
 * The outcome verbs that can close a Trail — DERIVED from lib/eventFamilies, the
 * one place the verb→family map lives, so this list cannot drift from the
 * `canonical_event_families` view (2123/2277) or from the
 * `canonical_events_verb_check` CHECK that decides what may be stored at all.
 *
 * WHY DERIVED, NOT WRITTEN OUT. Until 2026-09-05 this constant read
 * `["arrival_confirmed","next_stop","entry_succeeded","entry_failed"]` under a
 * comment claiming it mirrored family='outcome'. It mirrored nothing: NONE of
 * those four strings is a canonical verb, so `canonical_events` (CHECK verb IN
 * (…), 2120 widened by 2277) can never hold one and `linkTrailOutcomes` could
 * never count a single real event — the §14 derivation was inert by construction
 * and its test was green only because the fixture used the same phantom
 * vocabulary. The real outcome family is arrival | completion | rejection.
 */
export const TRAIL_OUTCOME_VERBS: readonly CanonicalEventVerb[] = (
  Object.keys(VERB_FAMILY) as CanonicalEventVerb[]
).filter((v) => VERB_FAMILY[v] === "outcome");
export type TrailOutcomeVerb = CanonicalEventVerb;

export interface OutcomeEventRow {
  verb: string;
  subjectId: string;   // the place the outcome is about
  observedAt: string;
}

export interface TrailArrivalLink {
  destinationArea: string;   // matched via the next_move
  arrivals: number;          // verb 'arrival' at the destination after the declaration
  completions: number;       // verb 'completion'
  rejections: number;        // verb 'rejection'
  /**
   * Rows at the destination and after the declaration whose verb is NOT an
   * outcome-family canonical verb. Counted rather than silently dropped: a
   * non-zero value here is the signature of the vocabulary drift described
   * above, and a caller can see it instead of reading a zero as "no arrivals".
   */
  ignoredNonOutcome: number;
}

/**
 * Derive arrival/outcome counts for a declared next_move by matching outcome
 * events at the destination that occur AFTER the declaration. Pure; the caller
 * supplies both sides. Arrivals feed `verifiedArrivals` in computeMovementStrength.
 */
export function linkTrailOutcomes(
  destinationPlaceId: string,
  destinationArea: string,
  declaredAt: string,
  outcomes: readonly OutcomeEventRow[],
): TrailArrivalLink {
  const t0 = Date.parse(declaredAt);
  // An unparseable declaration time matches nothing (fail-closed) rather than
  // letting NaN comparisons decide which side of the declaration a row is on.
  const after = Number.isFinite(t0)
    ? outcomes.filter((o) => {
        if (o.subjectId !== destinationPlaceId) return false;
        const t = Date.parse(o.observedAt);
        return Number.isFinite(t) && t >= t0;
      })
    : [];
  const outcomeVerbs = new Set<string>(TRAIL_OUTCOME_VERBS);
  return {
    destinationArea,
    arrivals: after.filter((o) => o.verb === "arrival").length,
    completions: after.filter((o) => o.verb === "completion").length,
    rejections: after.filter((o) => o.verb === "rejection").length,
    ignoredNonOutcome: after.filter((o) => !outcomeVerbs.has(o.verb)).length,
  };
}

// ── AT-10 block filter — a blocked viewer sees no Trail contribution ───────────
/**
 * Filter next_move rows to those a viewer may see: rows whose actor is not in the
 * viewer's bidirectional blocked set. `blockedSet` comes from
 * lib/blocks.fetchBlockedSet — which returns null on read error; the caller must
 * pass an EMPTY set only when the read succeeded and null must be treated as
 * "show nothing" (fail-closed) before calling here.
 */
export function visibleTrailRows<T extends { actorId: string }>(
  rows: readonly T[],
  blockedSet: ReadonlySet<string>,
): T[] {
  return rows.filter((r) => !blockedSet.has(r.actorId));
}
