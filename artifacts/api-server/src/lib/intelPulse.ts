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
 */
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";

/** Minimum distinct subjects before a neighborhood aggregate may be exposed. */
export const MIN_PULSE_SUBJECTS = 3;

/** A privacy-eligible live snapshot feeding the pulse (crowd.level only). */
export interface PulseSnapshotInput {
  subjectId: string;
  claimType: string;
  value: unknown;
  observedAt: string;
}

export interface NeighborhoodPulse {
  exposable: boolean;
  reason: "ok" | "no_data" | "below_threshold";
  /** Distinct subjects that contributed a crowd.level snapshot. */
  subjectCount: number;
  /** Distribution: crowd level → number of subjects at it. Empty unless exposable. */
  levels: Record<string, number>;
  /** ISO timestamp of the freshest input, or null. */
  freshestObservedAt: string | null;
  /** Cache/version token — changes when the underlying set changes (for ETag). */
  stateVersion: string;
}

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

  const stateVersion = `${subjectCount}:${freshest ?? "-"}`;

  if (subjectCount === 0) {
    return { exposable: false, reason: "no_data", subjectCount: 0, levels: {}, freshestObservedAt: null, stateVersion };
  }
  if (subjectCount < minSubjects) {
    // Below the subject-count floor — withhold the whole aggregate (never a partial).
    return { exposable: false, reason: "below_threshold", subjectCount, levels: {}, freshestObservedAt: freshest, stateVersion };
  }
  return { exposable: true, reason: "ok", subjectCount, levels, freshestObservedAt: freshest, stateVersion };
}

/** The per-subject actor floor this aggregate assumes upstream (documented contract). */
export const PULSE_PER_SUBJECT_ACTOR_FLOOR = PRIVACY_THRESHOLD_V1.minUniqueActors;
