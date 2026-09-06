/**
 * Intelligence Gathering — Neighborhood Pulse aggregation (§19 read model,
 * Table 28 "Neighborhood Pulse | Thresholded aggregates | [never] Small-cohort
 * movement").
 *
 * PURE. No I/O. Turns the neighborhood's privacy-eligible live snapshots into a
 * k-ANONYMOUS coarse aggregate. Two independent thresholds, both fail-closed:
 *   1. every input snapshot is already privacy_eligible — it cleared the k=15
 *      actor / group gate at projection time (PRIVACY_THRESHOLD_V1), so no single
 *      contributor is identifiable within any one subject;
 *   2. the NEIGHBORHOOD aggregate is exposed only across ≥ MIN_PULSE_SUBJECTS
 *      distinct subjects — a pulse over one venue would just be that venue's
 *      state wearing a neighborhood label, which is the small-cohort exposure
 *      Table 28 forbids.
 * Below either threshold the pulse is withheld (exposable=false), never thinned.
 * The output is a DISTRIBUTION (how many subjects sit at each crowd level), never
 * a per-subject or per-contributor row.
 *
 * A COUNT COMPUTED OVER BELOW-FLOOR ROWS IS ITSELF AN EXPOSURE (2026-09-05)
 * ========================================================================
 * This module used to return the real `subjectCount` and a
 * `stateVersion` of `${subjectCount}:${freshestObservedAt}` even when
 * `exposable` was false — and routes/intelReadModels.ts serves BOTH fields
 * (`pulse.subjectCount` and `state_version`) on every response, withheld or not.
 * Suppressing `levels` while publishing the count and the freshest observation
 * timestamp still answered the two questions the floor exists to refuse:
 * *how many* venues in this neighborhood are live right now (1 or 2), and *when*
 * the most recent of them was observed to the millisecond. Two reads of adjacent
 * neighborhoods, or one read before and after a single capture, differenced that
 * into a single venue's live state — the small-cohort exposure Table 28 forbids,
 * delivered through the fields that were supposed to prove it had been refused.
 *
 * So the withheld shape is now genuinely CONSTANT: no count, no timestamp, and a
 * `stateVersion` that carries only the refusal reason (which keeps the caller's
 * ETag correct — the two withheld bodies still differ from each other and from
 * every exposable body — without carrying the cohort). The real numbers stay
 * inside this function; they never reach a return value that is not exposable.
 * The count is only ever published once it has cleared the floor it describes.
 */
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";
import { normalizeConflictState } from "./intelConflict.js";

/** Minimum distinct subjects before a neighborhood aggregate may be exposed. */
export const MIN_PULSE_SUBJECTS = 3;

/** A privacy-eligible live snapshot feeding the pulse (crowd.level only). */
export interface PulseSnapshotInput {
  subjectId: string;
  claimType: string;
  value: unknown;
  observedAt: string;
  /**
   * §10 conflict state of the cohort behind the snapshot (intel_state_snapshots
   * .conflict_state, 2275). A MATERIAL conflict contributes NOTHING to the
   * distribution — see computeNeighborhoodPulse. Read through
   * lib/intelConflict.normalizeConflictState, the same policy lib/liveClaimRead
   * applies, so absent/null is 'none' (pre-2275 rows) and an unrecognised marker
   * is 'material'.
   */
  conflictState?: unknown;
}

export interface NeighborhoodPulse {
  exposable: boolean;
  reason: "ok" | "no_data" | "below_threshold";
  /**
   * Distinct subjects behind the exposed distribution. **0 unless `exposable`** —
   * a below-floor cohort size is the exposure the floor exists to refuse, so it
   * is never returned (see the module header).
   */
  subjectCount: number;
  /** Distribution: crowd level → number of subjects at it. Empty unless exposable. */
  levels: Record<string, number>;
  /** ISO timestamp of the freshest input. **null unless `exposable`** — same rule. */
  freshestObservedAt: string | null;
  /**
   * Cache/version token — changes when the exposed answer changes (for ETag).
   * When the pulse is withheld this is a constant derived from the refusal
   * REASON alone, never from the suppressed cohort.
   */
  stateVersion: string;
}

/**
 * The withheld tokens. Constant per refusal reason: they carry nothing about the
 * rows that were refused, but they still differ from each other (the two withheld
 * BODIES differ in `reason`, so sharing one ETag would let a 304 serve the wrong
 * one) and from every exposable `${count}:${iso}` token.
 *
 * `no_data` deliberately keeps the historic `"0:-"` spelling, which is also the
 * literal routes/intelReadModels.ts emits when Live is globally off — "nothing to
 * show" must look identical whether the cause is the kill switch or an empty
 * neighborhood.
 */
const WITHHELD_STATE_VERSION = {
  no_data: "0:-",
  below_threshold: "w:below_threshold",
} as const;

function crowdLevelOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as any).level === "string") return (value as any).level;
  return null;
}

/**
 * Compute the neighborhood pulse. `k` is the per-subject actor floor already
 * enforced upstream (documented here so the contract is explicit); this function
 * enforces the SUBJECT-count threshold that makes the neighborhood aggregate
 * itself k-anonymous.
 */
export function computeNeighborhoodPulse(
  snapshots: readonly PulseSnapshotInput[],
  opts: { minSubjects?: number } = {},
): NeighborhoodPulse {
  const minSubjects = opts.minSubjects ?? MIN_PULSE_SUBJECTS;
  // One crowd.level per subject (dedupe by subject) + track the freshest.
  const perSubject = new Map<string, { level: string; observedAt: string }>();
  for (const s of snapshots) {
    if (s.claimType !== "crowd.level") continue;
    // §10 / invariant §1: a subject whose cohort MATERIALLY disagrees has no
    // single current value, and this aggregate has nowhere to carry a "reports
    // differ" marker — folding its plurality into the distribution would be the
    // silent averaging the conflict state exists to prevent. It is dropped, not
    // averaged; a subject with no other snapshot then simply does not count
    // toward subjectCount, so the k-threshold gets STRICTER, never looser.
    if (normalizeConflictState(s.conflictState) === "material") continue;
    const level = crowdLevelOf(s.value);
    if (!level) continue;
    const prev = perSubject.get(s.subjectId);
    if (!prev || s.observedAt > prev.observedAt) perSubject.set(s.subjectId, { level, observedAt: s.observedAt });
  }

  const subjectCount = perSubject.size;
  let freshest: string | null = null;
  const levels: Record<string, number> = {};
  for (const { level, observedAt } of perSubject.values()) {
    levels[level] = (levels[level] ?? 0) + 1;
    if (!freshest || observedAt > freshest) freshest = observedAt;
  }

  if (subjectCount === 0) {
    return {
      exposable: false, reason: "no_data",
      subjectCount: 0, levels: {}, freshestObservedAt: null,
      stateVersion: WITHHELD_STATE_VERSION.no_data,
    };
  }
  if (subjectCount < minSubjects) {
    // Below the subject-count floor — withhold the whole aggregate, INCLUDING the
    // cohort size and the freshest observation time. Returning either would let a
    // caller difference two reads back into a single venue's live state (module
    // header); `levels: {}` alone never did.
    return {
      exposable: false, reason: "below_threshold",
      subjectCount: 0, levels: {}, freshestObservedAt: null,
      stateVersion: WITHHELD_STATE_VERSION.below_threshold,
    };
  }
  return {
    exposable: true, reason: "ok",
    subjectCount, levels, freshestObservedAt: freshest,
    stateVersion: `${subjectCount}:${freshest ?? "-"}`,
  };
}

/** The per-subject actor floor this aggregate assumes upstream (documented contract). */
export const PULSE_PER_SUBJECT_ACTOR_FLOOR = PRIVACY_THRESHOLD_V1.minUniqueActors;
