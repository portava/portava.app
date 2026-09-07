/**
 * sensingRevocationLineage — §18.4, defined as code for the anonymous path.
 *
 *   raw contribution → aggregate → world inference → ExperienceSession? → Memory?
 *   "Define what revocation removes, expires, prevents and may retain as
 *    genuinely de-identified aggregate. Do not let implementation accident
 *    decide retention."                                                 (§18.4)
 *
 * Census S112 scored the intel path's first link exemplary (erase_intel_for_
 * actor, 2130:398-455) and the chain past it "undefined because the stages do
 * not exist". For the anonymous path the stages now exist —
 * lib/sensingAnonStore (raw) → lib/sensingCoverageAggregate (aggregate) →
 * lib/sensingPresenceState / lib/vibeInference (inference) → lib/experienceTruth
 * (composition) — and this file states, per stage, what a revocation does, and
 * proves the one property that makes "may retain" honest: nothing past the raw
 * stage carries anything a revocation could find.
 *
 * ── THE DEFINITION ───────────────────────────────────────────────────────────
 *   raw            REMOVED. revoke_sensing_contributions deletes every row under
 *                  (epoch, token); the device proves ownership by revealing its
 *                  epoch secret (lib/sensingAnonStore). Scope: that epoch only.
 *   aggregate      NOT RECOMPUTED, RETAINED. A published aggregate is a k-gated
 *                  decision + coarse counts + a per-person median; it holds no
 *                  token, so there is nothing in it to remove. A FUTURE
 *                  aggregation of the same cohort no longer counts the revoked
 *                  contributor (prevented), which is what `applySensingRevocation`
 *                  models in memory and the DELETE does in the store.
 *   inference      RETAINED. Presence and vibe states are built from the
 *                  aggregate and carry no identity — `SensingPresenceState` has
 *                  no field for a token or a count (test-walked).
 *   session        PREVENTED — no ExperienceSession exists on this path (S54
 *                  NOT-BUILT), so a contribution cannot reach one.
 *   memory         PREVENTED — no path from sensing to Memory exists; Memory is
 *                  projected from an enumerated source set (S91).
 *
 * What revocation does NOT do, stated so an accident cannot decide it later:
 * it does not un-publish an aggregate already served; it does not touch other
 * epochs; it does not reach the canonical intel lifecycle, which has its own
 * erasure path.
 *
 * PURE. No I/O, no clock.
 */
import {
  applySensingRevocation,
  type SensingContributionRow,
  type SensingRevocation,
} from "./sensingAnonStore.js";
import { aggregateSensingCohort, type SensingCohortAggregate } from "./sensingCoverageAggregate.js";

export const SENSING_LINEAGE_STAGES = ["raw", "aggregate", "inference", "session", "memory"] as const;
export type SensingLineageStage = (typeof SENSING_LINEAGE_STAGES)[number];

export type RevocationEffect = "removed" | "retained_deidentified" | "prevented";

/** The definition, as data a test can walk and a reader can quote. */
export const SENSING_REVOCATION_EFFECT: Readonly<Record<SensingLineageStage, RevocationEffect>> = Object.freeze({
  raw: "removed",
  aggregate: "retained_deidentified",
  inference: "retained_deidentified",
  session: "prevented",
  memory: "prevented",
});

/** Scope of one revocation: exactly one rotation epoch of one device. */
export const SENSING_REVOCATION_SCOPE = "per_epoch" as const;

/**
 * The property behind "retained as genuinely de-identified": a serialised
 * aggregate contains no contributor token and no group token. If it ever did,
 * "retain" would be a lie and this returns the offending field.
 */
export function aggregateCarriesIdentity(agg: SensingCohortAggregate, rows: readonly SensingContributionRow[]): string | null {
  const json = JSON.stringify(agg);
  for (const r of rows) {
    if (r.contributor_token && json.includes(r.contributor_token)) return "contributor_token";
    if (r.group_token && json.includes(r.group_token)) return "group_token";
  }
  return null;
}

export interface RevocationOutcome {
  /** Rows the revocation removes from a fresh read of this cohort. */
  removed: number;
  /** The aggregate a future aggregation would produce, without the revoked contributor. */
  after: SensingCohortAggregate;
  /** Whether the previously published aggregate held anything a revocation could act on. */
  publishedAggregateCarriedIdentity: string | null;
}

/**
 * Model one revocation against one cohort, in memory. This is the definition
 * above made executable: the raw rows are removed, a future aggregate excludes
 * them, and the already-published aggregate is shown to carry nothing.
 */
export function modelSensingRevocation(
  rows: readonly SensingContributionRow[],
  published: SensingCohortAggregate,
  revocation: SensingRevocation,
  nowMs: number,
): RevocationOutcome {
  const remaining = applySensingRevocation(rows, revocation);
  const after = aggregateSensingCohort({ ok: true, complete: true, rows: remaining }, { nowMs });
  return {
    removed: rows.length - remaining.length,
    after,
    publishedAggregateCarriedIdentity: aggregateCarriesIdentity(published, rows),
  };
}
