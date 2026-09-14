/**
 * discoveryTrailAffinity — THE ONE NUMBER TRAILS IS ALLOWED TO GIVE THE RANKER.
 *
 * THE RULING, VERBATIM, BECAUSE IT DECIDES THE SHAPE OF THIS FILE
 * ==============================================================
 * `docs/discovery/ROADMAP.md:148` — "Anything assuming the six P1 components
 * are **peer scoring systems**: STALE — must be re-scoped before
 * implementation."
 *
 * `docs/architecture/02_Trails.md:5-12` records the re-scope that followed, and
 * the re-scope — not the freeze — is the authoritative design: "ROADMAP step 7
 * keeps trails only as a future MODIFIER to the ranker, never a parallel
 * engine", alongside "graph, behaviour … and capped `local_momentum` as
 * modifiers only".
 *
 * WHAT THAT MEANS HERE, CONCRETELY
 * ================================
 * This module produces ONE THING: `place id → affinity in [0,1]`. That is the
 * SAME SHAPE `ViewerContext.localMomentum` already has in lib/portavaRank.ts,
 * for the same reason — so the Trail term can be handed to the EXISTING ranker
 * as one more bounded modifier map, with no new ordering code, no second
 * scorer, and no second pipeline.
 *
 * There is no `rankTrailCandidates` in this file and there must never be one.
 * If a future change needs Trails to ORDER anything, that is the peer-scoring
 * system the ruling marked STALE, and it needs a new owner ruling first.
 *
 * THE CAP IS THE PROOF
 * ====================
 * `TRAIL_AFFINITY_MAX_CONTRIBUTION` is 0.10:
 *   - at or below LOCAL_MOMENTUM_MAX_CONTRIBUTION (0.15), the bound step 7
 *     already set for the other modifier, because Trail membership is an
 *     EDITORIAL fact about content and momentum is a measured fact about the
 *     world — the weaker evidence must not carry the larger weight;
 *   - strictly below every taste-side weight in DEFAULT_WEIGHTS
 *     (categoryAffinity 0.4, interestTag 0.3, cityMatch 0.45, distance 0.35,
 *     actionability 0.9), so a saturated Trail affinity can break a tie between
 *     two places the viewer's taste rates alike and can never lift a place over
 *     one the viewer's taste prefers;
 *   - equal to `capacityOpen` (0.1), the smallest positive weight in the table,
 *     which is the honest place for a signal this indirect.
 * `trailAffinityContribution` clamps in CODE, not by the weight, so an admin
 * weight override cannot turn the modifier into a driver — the same defence
 * portavaRank applies to localMomentum.
 *
 * DV-25 REUSES THE MOMENTUM KERNEL THAT ALREADY SHIPS
 * ===================================================
 * `trailMomentumFromRankEvents` does not compute velocity. It folds a Trail's
 * member item ids onto the Trail id and calls
 * `lib/discoveryLocalMomentum.computeLocalMomentum` — the same 48 h / 30 d
 * windows, the same weights, the same saturation, the same evidence floor. A
 * second velocity model would be a parallel engine by another name, and would
 * also have re-opened `04` §2's "Do not create a new parallel behavior store":
 * the rows are `rank_events` rows and no Trail table records behaviour.
 *
 * census-discovery rows: DV-25 (behaviour → Trail momentum), DV-18's
 * `trail_affinity` producer (see below), DC-05's ranking input.
 *
 * THE REASON CODE — WHAT THIS FILE CAN AND CANNOT CLOSE
 * ====================================================
 * `lib/discoveryReasonCodes.ts` lists `trail_affinity` in
 * `REASON_CODES_WITHOUT_PRODUCER` with the reason "There is no Trail object in
 * this repository or in production". That reason is now false: the object
 * exists (migration 2910) and this module computes the signal.
 * `TRAIL_AFFINITY_SIGNAL_KEY` is the verbatim key that module's
 * `SIGNAL_TO_CODE` map would need. THIS LANE MAY NOT EDIT THAT FILE, so the
 * mapping is a cross-lane request, not a claim: until the entry exists,
 * `reasonCodeForSignal("trailAffinity")` still returns null and no served row
 * carries the code. Said plainly rather than reported as closed.
 */
import {
  computeLocalMomentum, type MomentumRow,
} from "./discoveryLocalMomentum.js";
import type { TrailRelationship } from "./discoveryTrailObject.js";

/**
 * The largest score contribution a Trail may ever make, whatever weight is
 * passed. See the header for why 0.10 and not more. Change it only with a
 * ruling; the cap tests in test/discoveryTrailModifier.test.ts pin it against
 * portavaRank's own weight table, so raising it fails the build rather than
 * quietly changing the product.
 */
export const TRAIL_AFFINITY_MAX_CONTRIBUTION = 0.10;

/**
 * The ranker-signal key this modifier would appear under, verbatim.
 * lib/discoveryReasonCodes.ts maps signal keys to `01` §11 reason codes by
 * exact string, so this constant is the contract between the two.
 */
export const TRAIL_AFFINITY_SIGNAL_KEY = "trailAffinity";

/**
 * `02` §4's three label classes, as affinity weights.
 *
 * Strictly ordered, and the order is the specification's: the primary Trail is
 * the content's discovery identity, a supporting Trail is a secondary home, a
 * Signal ("rooftop", "late night") is an adjective. Treating them alike would
 * let five adjectives outweigh one identity, which is precisely the "renamed
 * hashtag" failure §1 says a Trail must not become.
 */
export const RELATIONSHIP_AFFINITY: Readonly<Record<TrailRelationship, number>> = {
  primary: 1.0,
  supporting: 0.6,
  signal: 0.3,
};

/**
 * How far a Trail with NO momentum is damped. Not to zero: a viewer who follows
 * "Kyoto Hidden Temples" still has that taste when the Trail is quiet, and
 * zeroing it would make the object flicker in and out of the ranker with the
 * news cycle.
 */
export const TRAIL_MOMENTUM_SCALE_FLOOR = 0.6;

/** The `content_trails` columns this module reads. Nothing else is needed. */
export interface TrailMembershipRow {
  trail_id: string;
  source_type: string;
  source_id: string;
  relationship: TrailRelationship;
  confidence: number;
}

const clamp01 = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface TrailAffinityOptions {
  /**
   * trail id → momentum in [0,1] from `trailMomentumFromRankEvents`. When
   * OMITTED entirely, affinity is unscaled — no momentum information is not the
   * same fact as zero momentum, and defaulting the two to the same number would
   * make a failed read look like a cold Trail.
   */
  trailMomentum?: Record<string, number>;
}

/**
 * The modifier map: the viewer's followed Trails plus the Trails' place
 * memberships → `place id → affinity in [0,1]`.
 *
 * COMBINED BY MAX, NEVER SUMMED. A sum would make MEMBERSHIP COUNT the driver —
 * ten weak Signal attachments would outrank one primary Trail, and a creator
 * could manufacture rank by attaching labels. `02` §4's cap already bounds the
 * count; taking the maximum makes the count irrelevant to the score as well.
 *
 * Only `source_type = 'place'` rows enter: the ranker's modifier map is keyed by
 * place id, and a post membership has no place to attach to. A Trail's posts
 * are not ignored — they are what `trailMomentumFromRankEvents` measures.
 */
export function trailAffinityMap(
  followedTrailIds: readonly string[],
  memberships: readonly TrailMembershipRow[],
  opts: TrailAffinityOptions = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(followedTrailIds) || !Array.isArray(memberships)) return out;
  const followed = new Set(followedTrailIds.filter((id) => typeof id === "string" && id.length > 0));
  if (followed.size === 0) return out;

  const momentum = opts?.trailMomentum;

  for (const m of memberships) {
    if (!m || typeof m.trail_id !== "string" || typeof m.source_id !== "string") continue;
    if (m.source_type !== "place") continue;
    if (!followed.has(m.trail_id)) continue;

    const base = RELATIONSHIP_AFFINITY[m.relationship as TrailRelationship];
    if (typeof base !== "number") continue;

    // An absent momentum MAP means unscaled; an absent ENTRY in a supplied map
    // means measured-and-flat, which is the floor. Those are different facts.
    const scale = momentum
      ? TRAIL_MOMENTUM_SCALE_FLOOR + (1 - TRAIL_MOMENTUM_SCALE_FLOOR) * clamp01(momentum[m.trail_id])
      : 1;

    const value = round3(base * clamp01(m.confidence) * scale);
    if (value <= 0) continue;
    if (value > (out[m.source_id] ?? 0)) out[m.source_id] = value;
  }
  return out;
}

/**
 * Affinity → the score contribution, clamped in code.
 *
 * `weight` exists so a future weight table can carry `trailAffinity` the way it
 * carries `localMomentum` — and, exactly like `localMomentum`, whatever that
 * weight says the result is clamped to TRAIL_AFFINITY_MAX_CONTRIBUTION. A
 * negative or non-finite affinity contributes 0, never a penalty: this modifier
 * may promote and may decline to promote; it may not demote, because a place
 * being in no Trail says nothing bad about it.
 */
export function trailAffinityContribution(
  affinity: number,
  weight: number = TRAIL_AFFINITY_MAX_CONTRIBUTION,
): number {
  const a = typeof affinity === "number" && Number.isFinite(affinity) ? affinity : 0;
  const w = typeof weight === "number" && Number.isFinite(weight) ? weight : 0;
  return Math.min(TRAIL_AFFINITY_MAX_CONTRIBUTION, Math.max(0, w * a));
}

/**
 * DV-25 — `rank_events` rows + Trail membership → `trail id → momentum in [0,1]`.
 *
 * The events are folded onto the Trail (an event on an item that belongs to two
 * Trails counts for both) and handed to the SHIPPING momentum kernel. Every
 * property of that kernel is inherited rather than restated: the 48-hour recent
 * window against the 30-day baseline, MOMENTUM_EVENT_WEIGHTS, the
 * MOMENTUM_MIN_RECENT_WEIGHT evidence floor below which a Trail has no momentum
 * at all, and the saturation clamp. Only Trails with momentum > 0 appear, so an
 * empty map means "no Trail is surging", never "the read failed".
 */
export function trailMomentumFromRankEvents(
  events: readonly MomentumRow[],
  memberships: readonly TrailMembershipRow[],
  nowMs: number,
): Record<string, number> {
  if (!Array.isArray(events) || !Array.isArray(memberships)) return {};

  const trailsByItem = new Map<string, string[]>();
  for (const m of memberships) {
    if (!m || typeof m.trail_id !== "string" || typeof m.source_id !== "string") continue;
    const list = trailsByItem.get(m.source_id);
    if (list) { if (!list.includes(m.trail_id)) list.push(m.trail_id); }
    else trailsByItem.set(m.source_id, [m.trail_id]);
  }
  if (trailsByItem.size === 0) return {};

  const folded: MomentumRow[] = [];
  for (const e of events) {
    if (!e || typeof e.item_id !== "string") continue;
    for (const trailId of trailsByItem.get(e.item_id) ?? []) {
      folded.push({ ...e, item_id: trailId });
    }
  }
  return computeLocalMomentum(folded, nowMs);
}
