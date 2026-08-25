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

/** §13 Privacy threshold v1 — the defaults that gate any movement publication. */
export const MOVEMENT_PRIVACY_V1 = {
  minUniqueActors: 15,
  minGroups: 5,
  maxSingleGroupShare: 0.2,
  minTimeBucketMinutes: 30,
  minPublicationDelayMinutes: 10,
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
  type Acc = { actors: Set<string>; groupCounts: Map<string, number>; dropped: number };
  const groupsByKey = new Map<string, Acc>();

  for (const r of rows) {
    const t = Date.parse(r.observedAt);
    if (!Number.isFinite(t)) continue;
    const bucketStart = new Date(Math.floor(t / bucketMs) * bucketMs).toISOString();
    const key = `${r.originId} ${r.destinationArea} ${bucketStart}`;
    let acc = groupsByKey.get(key);
    if (!acc) { acc = { actors: new Set(), groupCounts: new Map(), dropped: 0 }; groupsByKey.set(key, acc); }
    if (!r.groupId) { acc.dropped++; continue; } // fail-closed: uncertifiable independence
    acc.actors.add(r.actorId);
    acc.groupCounts.set(r.groupId, (acc.groupCounts.get(r.groupId) ?? 0) + 1);
  }

  const out: OriginDestAggregate[] = [];
  for (const [key, acc] of groupsByKey) {
    const [originId, destinationArea, bucketStart] = key.split(" ");
    const total = [...acc.groupCounts.values()].reduce((a, b) => a + b, 0);
    const maxGroup = acc.groupCounts.size ? Math.max(...acc.groupCounts.values()) : 0;
    out.push({
      originId, destinationArea, bucketStart,
      uniqueActors: acc.actors.size,
      groups: acc.groupCounts.size,
      maxSingleGroupShare: total > 0 ? maxGroup / total : 0,
      droppedUngrouped: acc.dropped,
    });
  }
  return out;
}

// ── §14 Arrival / outcome link (derivation over family='outcome' events) ──────
/** Outcome verbs that close a Trail (mirror canonical_event_families family='outcome'). */
export const TRAIL_OUTCOME_VERBS = ["arrival_confirmed", "next_stop", "entry_succeeded", "entry_failed"] as const;
export type TrailOutcomeVerb = (typeof TRAIL_OUTCOME_VERBS)[number];

export interface OutcomeEventRow {
  verb: string;
  subjectId: string;   // the place the outcome is about
  observedAt: string;
}

export interface TrailArrivalLink {
  destinationArea: string;   // matched via the next_move
  arrivals: number;          // arrival_confirmed at the destination after the declaration
  entrySucceeded: number;
  entryFailed: number;
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
  const after = outcomes.filter(
    (o) => o.subjectId === destinationPlaceId && Number.isFinite(Date.parse(o.observedAt)) && Date.parse(o.observedAt) >= t0,
  );
  return {
    destinationArea,
    arrivals: after.filter((o) => o.verb === "arrival_confirmed" || o.verb === "next_stop").length,
    entrySucceeded: after.filter((o) => o.verb === "entry_succeeded").length,
    entryFailed: after.filter((o) => o.verb === "entry_failed").length,
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
