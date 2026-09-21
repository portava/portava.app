/**
 * MediaConsensusService (§18) — Corroboration → Contradiction → Visual Consensus.
 *
 * §18's pipeline is
 *
 *   Media Perspective Resolver ─► Independent Sources ─► Coverage Analysis
 *     ─► Corroboration ─► Contradiction ─► Visual Consensus Projection
 *
 * The first three stages already exist (MediaPerspectiveService,
 * `countIndependentSources` over lib/intelIndependence, and the visual-coverage
 * route). This module is the last three, and it is a PURE aggregator: no DB, no
 * network, no clock beyond the `nowMs` it is handed.
 *
 * ── WHAT IS NOT INVENTED HERE, AND WHY ───────────────────────────────────────
 * A photograph ASSERTS NO VALUE. That is not a limitation of this tree, it is
 * what a perspective is: MediaPerspectiveService deliberately makes the
 * synchronised-behaviour detector inert for exactly this reason ("two strangers
 * shooting the same bar seconds apart are two witnesses"), and
 * MediaPerspectiveService's header refuses to invent a physical vantage the data
 * does not support. So two perspectives of one place CANNOT contradict each
 * other, and a module that scored them as agreeing or disagreeing would be
 * manufacturing a signal — the one thing every service in this tree refuses.
 *
 * Therefore the two stages are fed from the two things that ARE true:
 *
 *   CORROBORATION — the agreement measure media can carry honestly is WITNESS
 *     corroboration: how many INDEPENDENT sources (lib/intelIndependence
 *     clusters, not accounts) independently witnessed this place inside the
 *     FRESH window. One account posting eight photos is one witness; eight
 *     accounts posting one file are one witness; a trip crew is one party. All
 *     three of those already collapse in `countIndependentSources`, so this
 *     stage inherits the anti-manipulation posture rather than restating it.
 *     Stale perspectives corroborate NOTHING about the current picture — the
 *     window is the same `FRESH_WINDOW_MS` the rest of the media tree uses.
 *
 *   CONTRADICTION — read from `lib/intelConflict`, the codebase's ONE conflict
 *     engine, via the conflict state that already rides on every gated
 *     live-claim envelope Media ALREADY fetches
 *     (`MediaProjectionService.readCurrentState` → `readLiveClaimEnvelopes`).
 *     Media has been dropping it on the floor: `CurrentState.claims` carries
 *     `conflictState` per claim and nothing has ever derived a place-level or
 *     zone-level uncertainty from it. NO SECOND CONFLICT ENGINE IS BUILT HERE.
 *     This module reaches the canonical one.
 *
 * ── THE BANNER FIRES ONLY ON A MATERIAL CONFLICT ─────────────────────────────
 * `lib/intelConflict`'s own contract: 'material' triggers suppression of the
 * strong Live label and the contradiction-resolution prompt; 'minor' is "a real
 * but sub-threshold disagreement … surfaced in the conflict block, no
 * suppression". This module uses the SAME threshold. A minor disagreement is
 * recorded in `contradiction` and gets no banner; escalating it would put
 * "Mixed reports" on every venue where two honest people said 'busy' and
 * 'packed', which is the inflation intelConflict's weight/distance/window gates
 * exist to refuse.
 *
 * DIRECTION OF ERROR. Ambiguity resolves toward SHOWING uncertainty:
 * `normalizeConflictState` reads an unrecognised stored value as 'material', so
 * a conflict state this tree has never seen produces the banner rather than a
 * confident-looking place card. Nothing here can raise a confidence, widen what
 * serves, or manufacture a live label — it can only add a caveat.
 */

import {
  normalizeConflictState,
  type ConflictBlock,
  type ConflictState,
} from "../../lib/intelConflict.js";
import type { LiveClaimEnvelope } from "../../lib/liveClaimRead.js";
import type { MediaProjection } from "../../lib/media/mediaProjection.js";
import { isFreshEnoughForLabel } from "../../lib/media/mediaFreshness.js";
import { countIndependentSources } from "./MediaPerspectiveService.js";

/**
 * The §18 copy, verbatim from the spec sentence:
 * *"When reports disagree, surface uncertainty such as 'Mixed reports —
 * conditions may be changing'"*.
 */
export const MIXED_REPORTS_LABEL = "Mixed reports — conditions may be changing";

/** How many independent witnesses a place's CURRENT picture rests on. */
export type CorroborationLevel =
  /** No fresh independent witness at all. */
  | "none"
  /** Exactly one independent source — a single witness is not a consensus. */
  | "single_source"
  /** Two independent sources. */
  | "corroborated"
  /** Three or more independent sources. */
  | "well_corroborated";

export interface CorroborationMeasure {
  level: CorroborationLevel;
  /** Perspectives inside the fresh window (raw count — NOT witnesses). */
  freshPerspectiveCount: number;
  /**
   * Independence CLUSTERS among those fresh perspectives. Bounded above by the
   * fresh contributor count by construction (merging only ever reduces).
   */
  independentSourceCount: number;
}

export interface ContradictionMeasure {
  /** The WORST conflict state across the place's gated live claims. */
  state: Exclude<ConflictState, "none">;
  /** Which claim types disagree. Agreeing types are not listed. */
  claimTypes: string[];
  /** The canonical counts-only block from lib/intelConflict; never side sizes. */
  block: ConflictBlock | null;
}

export type VisualConsensusState =
  /** No fresh independent witness — the honest answer, never dressed as agreement. */
  | "insufficient"
  /** Two or more independent fresh witnesses and no material dispute. */
  | "corroborated"
  /** A material dispute is on record. Corroboration does NOT overwrite this. */
  | "mixed";

/** §18's Visual Consensus Projection. Carries no location and no actor id. */
export interface VisualConsensus {
  state: VisualConsensusState;
  corroboration: CorroborationMeasure;
  /** Null when nothing disagrees — uncertainty is never fabricated. */
  contradiction: ContradictionMeasure | null;
  /** The §18 banner copy, or null. Present ONLY on a material contradiction. */
  uncertaintyLabel: string | null;
  /**
   * §18 "optionally request another observation" — true when a fresh
   * observation would actually settle something. The client routes this to the
   * EXISTING §19 Request-a-View surface (MediaViewRequestService); this flag
   * grants nothing, it only says the offer is meaningful here.
   */
  requestAnotherObservation: boolean;
}

const EMPTY_CORROBORATION: CorroborationMeasure = {
  level: "none",
  freshPerspectiveCount: 0,
  independentSourceCount: 0,
};

function levelFor(independentSourceCount: number): CorroborationLevel {
  if (independentSourceCount <= 0) return "none";
  if (independentSourceCount === 1) return "single_source";
  if (independentSourceCount === 2) return "corroborated";
  return "well_corroborated";
}

/**
 * The worst conflict on record across a place's gated live claims, or null.
 *
 * `normalizeConflictState` is the canonical reader and is used rather than a
 * local comparison so an unrecognised stored value keeps its strict reading
 * ('material'). A claim whose state normalises to 'none' is NOT listed as
 * disagreeing.
 */
function worstContradiction(claims: readonly LiveClaimEnvelope[]): ContradictionMeasure | null {
  let worst: ConflictState = "none";
  const claimTypes: string[] = [];
  let block: ConflictBlock | null = null;
  for (const c of claims ?? []) {
    const state = normalizeConflictState((c as any)?.conflictState);
    if (state === "none") continue;
    if (typeof c?.claimType === "string" && !claimTypes.includes(c.claimType)) {
      claimTypes.push(c.claimType);
    }
    // Prefer the MATERIAL side's own block; otherwise keep the first one seen,
    // so the block always describes the conflict `state` reports.
    if (state === "material" ? worst !== "material" : block === null) {
      block = c?.conflict ?? null;
    }
    if (state === "material") worst = "material";
    else if (worst !== "material") worst = "minor";
  }
  if (worst === "none") return null;
  return { state: worst, claimTypes, block };
}

/**
 * Build the §18 Visual Consensus Projection for one place (or one world zone)
 * from its already-projected, already-eligible perspectives and the gated live
 * claims its caller already read.
 *
 * Empty input yields a well-formed 'insufficient' consensus — never an error,
 * and never agreement.
 */
export function buildVisualConsensus(
  media: readonly MediaProjection[],
  claims: readonly LiveClaimEnvelope[],
  nowMs: number,
  opts: { groupKeyById?: ReadonlyMap<string, string | null> } = {},
): VisualConsensus {
  const fresh = (media ?? []).filter((m) =>
    isFreshEnoughForLabel(nowMs - new Date(m.capturedAt).getTime()),
  );

  const corroboration: CorroborationMeasure =
    fresh.length === 0
      ? EMPTY_CORROBORATION
      : (() => {
          const independentSourceCount = countIndependentSources(fresh, opts.groupKeyById);
          return {
            level: levelFor(independentSourceCount),
            freshPerspectiveCount: fresh.length,
            independentSourceCount,
          };
        })();

  const contradiction = worstContradiction(claims ?? []);
  const material = contradiction?.state === "material";

  // A material dispute OUTRANKS corroboration: four agreeing photographs do not
  // settle a disputed live claim, because the photographs are not evidence about
  // the disputed value at all (they assert nothing). Ordering it the other way
  // would let volume silence a recorded disagreement.
  const state: VisualConsensusState = material
    ? "mixed"
    : corroboration.independentSourceCount >= 2
      ? "corroborated"
      : "insufficient";

  return {
    state,
    corroboration,
    contradiction,
    uncertaintyLabel: material ? MIXED_REPORTS_LABEL : null,
    requestAnotherObservation: material,
  };
}
