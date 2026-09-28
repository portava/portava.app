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
 *   session        PREVENTED — nothing bridges the anonymous store to a session.
 *                  (`lib/experienceSession` DOES now exist; its `claim_refs`
 *                  are canonical `intel_state_snapshots` ids, which this store
 *                  never reaches. See CANONICAL_REVOCATION_EFFECT below, where
 *                  the stage IS reached.)
 *   memory         PREVENTED — no path from the anonymous store to Memory
 *                  exists; Memory is projected from an enumerated source set
 *                  (S91), and the S92 bridge runs off a SESSION, not off this.
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

// ═════════════════════════════════════════════════════════════════════════════
// S112 — THE SECOND PATH, WHERE THE LAST TWO STAGES ACTUALLY EXIST
// ═════════════════════════════════════════════════════════════════════════════
/**
 * §18.4's five stages exist on TWO paths, and a single effect table was hiding
 * that. Census S112's RED WHEN is *"a session exists (S30) and a memory bridge
 * exists (S54/S92) for a revocation to reach"* — and those now exist, but NOT
 * on the path `SENSING_REVOCATION_EFFECT` above describes.
 *
 * ── WHY THE ANONYMOUS TABLE IS UNCHANGED, AND IS STILL RIGHT ─────────────────
 * The reason recorded above for the anonymous path — *"no ExperienceSession
 * exists on this path (S54 NOT-BUILT)"* — is now STALE: `lib/experienceSession`
 * exists. The VERDICT is not. `session` and `memory` are still `prevented` for
 * a `sensing_anon_contributions` row, for a different and better reason:
 * nothing bridges the anonymous store to anything. No route may write it and no
 * surface may read an aggregate from it (`docs/architecture/
 * sensing-input-gap.md` §3.2, the owner's decision #9, UNTAKEN), and an
 * `ExperienceSession`'s `claim_refs` are `intel_state_snapshots` ids from the
 * CANONICAL intel path, which the anonymous store never reaches. So the
 * anonymous table keeps every value it had; only its reason is corrected.
 *
 * ── THE CANONICAL PATH, WHERE A REVOCATION NOW REACHES FIVE STAGES ───────────
 *   raw        REMOVED. `erase_intel_for_actor()` (2130:398-455) deletes the
 *              actor's own observations through one narrow SECURITY DEFINER
 *              path.
 *   aggregate  RETAINED, de-identified. 2130:449-452 states the decision
 *              explicitly — derived claims and snapshots survive because
 *              *"Deleting them here would destroy other people's
 *              contributions"*.
 *   inference  RETAINED, de-identified, for the same reason.
 *   session    REACHED, and RETAINED de-identified. An `ExperienceSession`
 *              carries `claim_refs` — the snapshot ids its opportunity rested
 *              on — and no actor id, no contributor token and no coordinate.
 *              So there is nothing in it for a revocation to DELETE, and
 *              `claim_refs` is exactly what makes it FINDABLE.
 *   memory     REACHED, and RETAINED de-identified. The S92 bridge
 *              (`services/memoryProjections/experienceSessionBridge`) carries
 *              those same `claim_refs` into `provenance_json`, so a Memory
 *              derived from a session is traceable to the evidence behind it.
 *
 * ── WHAT "REACHED" BUYS, STATED WITHOUT OVERCLAIMING ─────────────────────────
 * 2130:452 defers recomputation-after-erasure to *"IG-04's responsibility"*,
 * and this does not do IG-04's job. What it does is end the state the census
 * called undefined: the last two stages can now be ENUMERATED. Given the
 * snapshot ids a revocation invalidated, `services/memoryProjections/
 * sessionRevocationReach` names the sessions and the memory records that rested
 * on them. Before the bridge existed there was no field to follow and the
 * question could not be asked at all.
 *
 * This module states the DEFINITION and stays pure: it imports no session and
 * no memory module, because the anonymous path it models still reaches
 * neither, and the executable reach lives beside the bridge that created it.
 */
export const REVOCATION_PATHS = ["sensing_anonymous", "canonical_intel"] as const;
export type RevocationPath = (typeof REVOCATION_PATHS)[number];

/** The canonical intel path's effect per stage. Total over the five stages. */
export const CANONICAL_REVOCATION_EFFECT: Readonly<Record<SensingLineageStage, RevocationEffect>> = Object.freeze({
  raw: "removed",
  aggregate: "retained_deidentified",
  inference: "retained_deidentified",
  session: "retained_deidentified",
  memory: "retained_deidentified",
});

export const REVOCATION_EFFECT_BY_PATH: Readonly<
  Record<RevocationPath, Readonly<Record<SensingLineageStage, RevocationEffect>>>
> = Object.freeze({
  sensing_anonymous: SENSING_REVOCATION_EFFECT,
  canonical_intel: CANONICAL_REVOCATION_EFFECT,
});

/**
 * The stages a revocation on this path can REACH — that is, the stages where a
 * revoked contribution's influence is identifiable rather than merely absent.
 *
 * `prevented` is NOT reached: it means nothing ever got there, so there is
 * nothing to find. This is the distinction the census asked for, and it is
 * derived from the effect table rather than restated beside it, so the two can
 * never disagree.
 */
export function stagesReached(path: RevocationPath): SensingLineageStage[] {
  const table = REVOCATION_EFFECT_BY_PATH[path];
  return SENSING_LINEAGE_STAGES.filter((s) => table[s] !== "prevented");
}

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
