/**
 * Intelligence Gathering — Trail follow-up READ (IG-06, serve side).
 *
 * The production caller of lib/trailFollowup's aggregation (`aggregateNextMoves`)
 * and AT-10 block filter (`visibleTrailRows`). Derives origin → destination-area
 * cohorts from captured experience.next_move observations (the `trail` capture
 * surface, routes/intel.ts) for the INTERNAL dashboard — spec §29 Included:
 * "Internal coverage dashboard for pilot zones".
 *
 * WHAT THIS IS NOT. It is not movement publication. §29 EXCLUDES "Public Crowd
 * Movement output"; publication is gated by `intel_movement_prediction` (declared
 * in §26 INTEL_FLAGS but NOT SEEDED — no migration creates the row, because the
 * rule migration 2165 states is that "a flag row arrives with the unit that reads
 * it, never before", and nothing reads it yet; isFlagEnabled reads an absent row
 * as false, so the gate is shut) and lib/trailFollowup.mayPublishMovement (the §13
 * privacy threshold plus the 0.65 confidence floor), and NO route calls either.
 * This read therefore evaluates neither subject sensitivity nor confidence,
 * returns no actor identity, and is served only behind requireAdmin
 * (routes/intel.ts).
 *
 * THE COHORT FLOOR IS A FILTER, NOT A LABEL (privacy fix, 2026-09-05)
 * ==================================================================
 * This read used to build every bucket as `{ ...aggregate, cohortFloorMet }` and
 * serve the lot. A bucket with `uniqueActors: 1` went on the wire fully
 * populated, merely FLAGGED as not meeting the floor — so an admin could scope
 * the read to one origin, read `uniqueActors: 1, groups: 1,
 * maxSingleGroupShare: 1`, and learn that one identifiable person declared a
 * move from that place to that area inside a 30-minute window. Differencing an
 * unscoped read against a scoped one recovered the same number arithmetically.
 * `requireAdmin` did not save it: "internal" is an access control, not an
 * anonymity guarantee.
 *
 * TWO THINGS WERE WRONG, and both are fixed here rather than in the aggregate:
 *
 *   1. THE SPREAD. `{ ...a }` copied an INTERNAL aggregate onto a WIRE type, so
 *      every present and future field of OriginDestAggregate was published by
 *      default. TrailMovementBucket is now an enumerated projection: a field
 *      reaches the wire only because someone wrote it out here.
 *   2. THE ORDER. The floor was evaluated AFTER the payload was assembled.
 *      Sub-floor buckets are now dropped before projection — tuple, counts,
 *      share and window all — so nothing about them is computed onto the wire.
 *
 * WHY THE REFUSAL IS A BOOLEAN AND NOT A COUNT. Silence is not an acceptable
 * refusal here: "the floor withheld something" must stay distinguishable from
 * "nothing is happening". But a WITHHELD COUNT is differenceable — narrow the
 * scope until it reads 1 and the cohort size is back. Every signal this module
 * emits about rows it did NOT serve (`withheldBelowFloor`,
 * `anyDroppedIneligible`, and a bucket's `ungroupedPresent`) is therefore a
 * MONOTONE EXISTENCE BIT, never a magnitude. The property that makes that safe
 * is algebraic: a boolean OR is idempotent, so f(A ∪ B) = f(A) ∨ f(B), and from
 * f(A ∪ B) together with f(A) nothing about B can be recovered except in the
 * one case f(A ∪ B) = false — which discloses that B is empty of withheld rows,
 * i.e. discloses nothing at all. Sums do not have that property, which is why
 * two of those three used to be numbers and are no longer, and why the third —
 * the AT-10 hidden-row count — is gone outright rather than reduced to a bit.
 *
 * The buckets that ARE served need no such treatment: each is keyed by
 * (origin, destinationArea, bucketStart) and aggregates only its own rows, so a
 * bucket's numbers are identical whether the caller scoped the read to that
 * origin or not. Scope-invariance, not secrecy, is what makes them
 * un-differenceable — and every one of them stands on at least
 * MOVEMENT_PRIVACY_V1.minUniqueActors people in at least .minGroups independent
 * parties, none of them holding more than .maxSingleGroupShare of the cohort.
 *
 * `cohortFloor` publishes the floor itself as data. It is constant, identical
 * for every caller and every scope, so it leaks nothing — and it is what lets a
 * reader interpret an empty `buckets` correctly: not "no movement", but "no
 * movement above this".
 *
 * FAIL-CLOSED ORDER — each refusal returns EMPTY, never partial:
 *   1. no client                 → "no_service_client"
 *   2. the §26 flag chain is not
 *      fully on (intel_trail_followup,
 *      then its declared dependency
 *      intel_capture_quick_signal) → "flag_off"        (nothing is read)
 *   3. blocked set unreadable    → "blocks_unreadable" (AT-10 cannot be honoured, so nothing is shown)
 *   4. observation read fails    → "read_failed"
 * A consent-read failure empties the cohort (parity with lib/crowdFlowProducer)
 * rather than refusing, because it can only shrink the result.
 *
 * Counting follows lib/trailFollowup.aggregateNextMoves exactly: a row without a
 * certified group key is DROPPED (`droppedUngrouped`), never counted as a
 * person. Note that the capture service derives a group key only for the
 * quick_signal surface today, so trail rows arrive ungrouped and the
 * independent-group floor cannot clear. That is safe, and it is legible without
 * a single count: `buckets` stays empty while `withheldBelowFloor` stays true —
 * "cohorts are forming and none has reached the floor", not "nobody is moving".
 */
import { isFlagEnabled } from "./featureFlags.js";
import { fetchBlockedSet } from "./blocks.js";
import { CLAIM_TYPES, PILOT_CLAIMABLE_MODERATION_STATES } from "./intelContracts.js";
import {
  aggregateNextMoves,
  visibleTrailRows,
  MOVEMENT_PRIVACY_V1,
  type NextMoveRow,
  type OriginDestAggregate,
} from "./trailFollowup.js";
import { logger } from "./logger.js";

export type TrailReadRefusal = "no_service_client" | "flag_off" | "blocks_unreadable" | "read_failed";

/**
 * A bucket that CLEARED the §13 cohort floor, enumerated field by field.
 *
 * Deliberately NOT `extends OriginDestAggregate`, and deliberately never built
 * by spreading one: the aggregate is an internal working record and this is a
 * wire type. `droppedUngrouped` is the field that proves the point — it counts
 * rows the independence gate REMOVED from the cohort, so publishing it would be
 * publishing a measurement over suppressed rows. It survives here only as the
 * existence bit `ungroupedPresent`.
 */
export interface TrailMovementBucket {
  originId: string;
  destinationArea: string;
  /** Start of the ≥30-min window (MOVEMENT_PRIVACY_V1.minTimeBucketMinutes). */
  bucketStart: string;
  uniqueActors: number;
  groups: number;
  maxSingleGroupShare: number;
  /**
   * Always true: sub-floor buckets are not projected at all. Kept as a field,
   * and typed as the literal, so the guarantee is stated on the wire and the
   * compiler refuses any construction that has not been through the floor.
   */
  cohortFloorMet: true;
  /**
   * At least one row at this (origin, destination, window) could not be
   * certified into an independent party and was excluded from the counts above.
   * An existence bit, never the count — see the module docstring.
   */
  ungroupedPresent: boolean;
}

/** The §13 cohort floor in force, published as data. Constant; scope-invariant. */
export interface TrailCohortFloor {
  minUniqueActors: number;
  minGroups: number;
  maxSingleGroupShare: number;
}

export interface TrailMovementRead {
  refusal: TrailReadRefusal | null;
  /** ONLY buckets that cleared `cohortFloor`. Never a below-floor bucket. */
  buckets: TrailMovementBucket[];
  /**
   * The floor every served bucket cleared. Constant and identical for every
   * caller, so it discloses nothing — and it is what makes an empty `buckets`
   * readable as "nothing above this floor" rather than "nothing here".
   */
  cohortFloor: TrailCohortFloor;
  /**
   * At least one cohort existed at this scope and was withheld for being below
   * the floor. A monotone existence bit — NOT how many, and never which.
   *
   * This is the ONE below-floor signal the read emits, and it exists because a
   * refusal must stay visible: without it an empty `buckets` would be
   * indistinguishable from an empty world. Every other below-floor quantity is
   * removed outright rather than reduced to a bit, because a second bit over the
   * same suppressed population is what gives differencing its purchase.
   */
  withheldBelowFloor: boolean;
  /**
   * At least one row was dropped BEFORE the privacy computation — no consent
   * row, a withdrawn one, no actor, or no usable destination.
   *
   * Kept, where the AT-10 hidden-row count was not (see below), because it
   * describes the CONSENT/SHAPE pipeline rather than the cohort: these rows
   * never entered an aggregate, carry no destination and no magnitude here, and
   * this is an operator's only view of consent coverage on the surface. It is
   * still a bit, never a count, for the reason above.
   *
   * NOT PRESENT, deliberately: the old `hiddenByBlock` count of rows the AT-10
   * bidirectional block filter removed for THIS viewer. A viewer knows their own
   * block counterparties, so "1 row hidden, scoped to this origin" named a
   * specific person at a specific place — and even as a bit it would say a
   * blocked person's contribution exists, which is the one thing AT-10 is for
   * hiding. The filter is applied unconditionally on every non-refusing read and
   * fails closed (`blocks_unreadable`) when the blocked set cannot be read; that
   * is the guarantee, and it needs no per-read counter to be true.
   */
  anyDroppedIneligible: boolean;
}

export interface ReadTrailMovementOptions {
  /** Restrict to declarations made AT this origin place (intel_observations.subject_id). */
  originId?: string | null;
  now?: Date | number;
  /** Freshness window; defaults to the experience.next_move TTL (30 min). */
  maxAgeMinutes?: number;
}

/** Anchored to the experience.next_move TTL in the claim registry (2128: 1800 s). */
export const TRAIL_SIGNAL_MAX_AGE_MINUTES =
  (CLAIM_TYPES.find((c) => c.claimType === "experience.next_move")?.ttlSeconds ?? 1800) / 60;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function toEpochMs(v: Date | number | undefined): number {
  if (v instanceof Date) return v.getTime();
  if (finite(v)) return v;
  return Date.now();
}

/**
 * The §13 cohort floor this read enforces, DERIVED from MOVEMENT_PRIVACY_V1
 * (itself derived from the shared PRIVACY_THRESHOLD_V1). Never restated.
 */
export const TRAIL_COHORT_FLOOR: TrailCohortFloor = {
  minUniqueActors: MOVEMENT_PRIVACY_V1.minUniqueActors,
  minGroups: MOVEMENT_PRIVACY_V1.minGroups,
  maxSingleGroupShare: MOVEMENT_PRIVACY_V1.maxSingleGroupShare,
};

/**
 * True iff the aggregate clears the three §13 cohort-size rules (counts only).
 *
 * This is the FILTER predicate, not a label: an aggregate for which this is
 * false is discarded by readTrailMovement and never projected. It is NOT
 * publishability — subject sensitivity, publication delay and confidence are
 * deliberately not evaluated here (see the module docstring).
 */
export function cohortFloorMet(a: OriginDestAggregate): boolean {
  return (
    a.uniqueActors >= MOVEMENT_PRIVACY_V1.minUniqueActors &&
    a.groups >= MOVEMENT_PRIVACY_V1.minGroups &&
    a.maxSingleGroupShare <= MOVEMENT_PRIVACY_V1.maxSingleGroupShare
  );
}

/**
 * Project a floor-CLEARING aggregate onto the wire type. Enumerated on purpose:
 * a field reaches an admin because it is written out here, never because it
 * happened to exist on the internal aggregate.
 */
function projectBucket(a: OriginDestAggregate): TrailMovementBucket {
  return {
    originId: a.originId,
    destinationArea: a.destinationArea,
    bucketStart: a.bucketStart,
    uniqueActors: a.uniqueActors,
    groups: a.groups,
    maxSingleGroupShare: a.maxSingleGroupShare,
    cohortFloorMet: true,
    ungroupedPresent: a.droppedUngrouped > 0,
  };
}

/**
 * Read the fresh, consented, moderation-eligible next_move observations a viewer
 * may see and aggregate them into origin → destination-area cohorts.
 */
export async function readTrailMovement(
  sc: any,
  viewerId: string,
  opts: ReadTrailMovementOptions = {},
): Promise<TrailMovementRead> {
  const empty = (refusal: TrailReadRefusal): TrailMovementRead => ({
    refusal,
    buckets: [],
    cohortFloor: TRAIL_COHORT_FLOOR,
    // A refusal read NOTHING (see the fail-closed order above), so it has no
    // below-floor cohort and no dropped row to report. These are false because
    // nothing was looked at — `refusal` is the field that says so.
    withheldBelowFloor: false,
    anyDroppedIneligible: false,
  });

  if (!sc) return empty("no_service_client");
  // Literal flag args on purpose — check-flag-polarity resolves each stop
  // statically. BOTH stops are the §26 chain: INTEL_FLAG_DEPENDENCIES declares
  // `intel_trail_followup → intel_capture_quick_signal`, and a flag may only be
  // honoured when everything it depends on is also on. Reading captured trail
  // rows while the capture chain is off is the same unsafe combination
  // lib/liveClaimRead.liveLabelsServable walks its own chain to prevent.
  if (!(await isFlagEnabled(sc, "intel_trail_followup"))) return empty("flag_off");
  if (!(await isFlagEnabled(sc, "intel_capture_quick_signal"))) return empty("flag_off");
  // AT-10: without a readable blocked set the filter cannot be honoured, so
  // nothing is shown. fetchBlockedSet returns null on read error and a viewer
  // without an id has no block relation to evaluate.
  if (typeof viewerId !== "string" || viewerId === "") return empty("blocks_unreadable");
  const blocked = await fetchBlockedSet(sc, viewerId);
  if (blocked === null) return empty("blocks_unreadable");

  const nowMs = toEpochMs(opts.now);
  const maxAgeMinutes =
    finite(opts.maxAgeMinutes) && opts.maxAgeMinutes > 0 ? opts.maxAgeMinutes : TRAIL_SIGNAL_MAX_AGE_MINUTES;
  const sinceIso = new Date(nowMs - maxAgeMinutes * 60_000).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  try {
    let query = sc
      .from("intel_observations")
      .select("actor_id, subject_id, value, group_key, observed_at, expires_at")
      .eq("claim_type", "experience.next_move")
      .in("moderation_state", PILOT_CLAIMABLE_MODERATION_STATES as unknown as string[])
      .gte("observed_at", sinceIso);
    if (typeof opts.originId === "string" && opts.originId !== "") query = query.eq("subject_id", opts.originId);
    const { data, error } = await query;
    if (error || !data) {
      logger.warn({ err: error }, "trailServe: next_move read failed");
      return empty("read_failed");
    }

    const fresh = (data as any[]).filter((o) => !o.expires_at || o.expires_at > nowIso);

    // D4 consent parity with system promotion (2174) and lib/crowdFlowProducer: an
    // actor who withdrew consent must not keep inflating a cohort. Fail-soft to EMPTY.
    const actorIds = [...new Set(fresh.map((o) => o.actor_id).filter((id) => typeof id === "string" && id !== ""))];
    let consented = new Set<string>();
    if (actorIds.length > 0) {
      const { data: consentRows, error: consentErr } = await sc
        .from("intel_contribution_consent")
        .select("user_id")
        .in("user_id", actorIds)
        .eq("enabled", true)
        .is("withdrawn_at", null);
      if (consentErr) {
        logger.warn({ err: consentErr }, "trailServe: consent read failed; cohort empty");
      } else {
        consented = new Set(((consentRows as any[]) ?? []).map((r) => r.user_id as string));
      }
    }

    let droppedIneligible = 0;
    const rows: NextMoveRow[] = [];
    for (const o of fresh) {
      const actorId = typeof o.actor_id === "string" && o.actor_id !== "" ? o.actor_id : null;
      const destinationArea =
        o.value && typeof o.value === "object" && typeof (o.value as any).destinationArea === "string"
          ? ((o.value as any).destinationArea as string)
          : null;
      const originId = typeof o.subject_id === "string" && o.subject_id !== "" ? o.subject_id : null;
      if (!actorId || !consented.has(actorId) || !destinationArea || !originId) { droppedIneligible++; continue; }
      rows.push({
        actorId,
        originId,
        destinationArea,
        groupId: typeof o.group_key === "string" && o.group_key !== "" ? o.group_key : null,
        observedAt: String(o.observed_at),
      });
    }

    const visible = visibleTrailRows(rows, blocked);
    // FILTER, then project. The floor decides whether a bucket exists at all;
    // only what survives it is turned into a wire object, and the projection is
    // enumerated so a future field on OriginDestAggregate cannot ride along.
    const aggregates = aggregateNextMoves(visible);
    const clearing = aggregates.filter((a) => cohortFloorMet(a));
    return {
      refusal: null,
      buckets: clearing.map(projectBucket),
      cohortFloor: TRAIL_COHORT_FLOOR,
      withheldBelowFloor: clearing.length < aggregates.length,
      anyDroppedIneligible: droppedIneligible > 0,
    };
  } catch (err) {
    logger.warn({ err }, "trailServe: next_move read threw");
    return empty("read_failed");
  }
}
