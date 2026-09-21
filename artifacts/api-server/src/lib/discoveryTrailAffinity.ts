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
 * THE CAP IS THE PROOF — AND THE NUMBER IS THE OWNER'S, NOT THIS LANE'S
 * ====================================================================
 * `TRAIL_AFFINITY_MAX_CONTRIBUTION` is 0.10 because the OWNER RULED IT SO on
 * 2026-09-14, verbatim: "Use 0.10 as the provisional Trail affinity cap,
 * subject to any explicit spec constraints." It is an APPROVED INITIAL
 * SETTING, PROVISIONAL AND SUBJECT TO REVISION — not a value this code chose
 * and not a value a reader should treat as derived.
 *
 * The spec constraint the ruling defers to was searched for and is NOT THERE.
 * `docs/specs/discovery-v1/02_Trails.md` §11 states the obligation in words
 * only — "Trail health should influence ranking but not silently erase
 * legitimate content" (`:163`) — and names no number anywhere in the file;
 * `docs/specs/discovery-v1/06_Recommendation_Engine.md` §3 lists
 * `trail_relevance` as one feature family among eleven and gives no weight,
 * no bound and no cap. So 0.10 stands on the ruling alone.
 *
 * What the repository CAN say about 0.10 is that it is consistent with the
 * bounds already ratified elsewhere, which is why the cap tests pin these
 * relations rather than the digits:
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
 * portavaRank applies to localMomentum. `lib/portavaRank.ts` imports that
 * function rather than restating the bound, so there is exactly one place the
 * cap is written and exactly one place a revision has to land.
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
 * THE REASON CODE — NOW WIRED, AND WHAT THAT DOES AND DOES NOT MEAN
 * =================================================================
 * `lib/discoveryReasonCodes.ts` used to list `trail_affinity` in
 * `REASON_CODES_WITHOUT_PRODUCER` with the reason "There is no Trail object in
 * this repository or in production". The first half of that reason is false as
 * of migration 2910, so the code now has its producer:
 * `TRAIL_AFFINITY_SIGNAL_KEY` is the verbatim key in that module's
 * `SIGNAL_TO_CODE`, and it is also `portavaRank`'s own feature name, so the
 * reason and the number that earned it cannot drift apart.
 *
 * The SECOND half of the old reason still stands and is not papered over: 2910
 * is applied to the `portava-ci` rehearsal project ONLY — six tables, RLS on,
 * zero rows, verified 2026-09-14 — and NOT to production; and the modifier runs
 * behind `discovery_ranking_modifiers_enabled`, seeded OFF. In production today
 * the signal never fires and the code is never emitted. A mapped code whose
 * producer has nothing to read is a different state from an unmapped one, and
 * only the first is claimed here.
 *
 * THE FULL PATH, so a reader can check it rather than take it:
 *   TrailService.loadViewerTrailModifier  (reads trail_follows + content_trails)
 *     → trailAffinityMap                   (this file — health- and momentum-scaled)
 *     → DiscoveryModifiers.trailAffinity   (lib/discoveryModifiers.ts, under the flag)
 *     → ViewerContext.trailAffinity        (lib/discoveryPde.ts)
 *     → scoreCandidate f.trailAffinity     (lib/portavaRank.ts, capped here)
 */
import {
  computeLocalMomentum, type MomentumRow,
} from "./discoveryLocalMomentum.js";
import { TRAIL_HEALTH_MIN_SCALE } from "./discoveryTrailHealth.js";
import type { TrailRelationship } from "./discoveryTrailObject.js";

/**
 * The largest score contribution a Trail may ever make, whatever weight is
 * passed. See the header: the VALUE is the owner's ruling of 2026-09-14 and
 * the RELATIONS below it are what this repository can defend. The cap tests in
 * test/discoveryTrailModifier.test.ts pin it against portavaRank's own weight
 * table AND against the real ranker's output, so raising it fails the build
 * rather than quietly changing the product.
 */
export const TRAIL_AFFINITY_MAX_CONTRIBUTION = 0.10;
// ^ OWNER-APPROVED INITIAL SETTING, 2026-09-14. Provisional and subject to
//   revision. No spec constraint overrides it: `02_Trails.md` and
//   `06_Recommendation_Engine.md` were both read for an explicit cap and state
//   none (see the header). Changing it changes served rank, so it changes only
//   by a further ruling — not by a weight table, not by an admin override, and
//   not by a reader who mistakes it for a tuned constant.

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
  /**
   * trail id → `lib/discoveryTrailHealth.trailHealthScale(health)`.
   *
   * `02` §11: "Trail health should influence ranking but not silently erase
   * legitimate content." THIS is where the influence half happens — the health
   * multiplier was computed and returned by TrailService and multiplied
   * nothing, which made §11 a sentence the code did not implement.
   *
   * Two properties, and both are enforced HERE rather than trusted from the
   * caller, because a bound that lives only at the call site is a bound one new
   * call site removes:
   *   INFLUENCE   a lower scale yields a strictly lower affinity;
   *   NOT ERASE   the value is clamped into [TRAIL_HEALTH_MIN_SCALE, 1], so a
   *               caller that passed 0 (or a negative, or a NaN) still cannot
   *               zero a place out of the map, and a caller that passed 3
   *               cannot promote one above its own relationship weight.
   *
   * An ABSENT entry is unscaled, like `trailMomentum`: a Trail whose health
   * could not be measured is not evidence of ill health, and defaulting it to
   * the floor would punish exactly the newest Trails §9 exists to protect.
   */
  trailHealthScale?: Record<string, number>;
}

/**
 * The §11 health multiplier, re-clamped at the point of use. See
 * `TrailAffinityOptions.trailHealthScale`.
 */
function healthFactor(scales: Record<string, number> | undefined, trailId: string): number {
  if (!scales) return 1;
  const raw = scales[trailId];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  return Math.min(1, Math.max(TRAIL_HEALTH_MIN_SCALE, raw));
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

    // §11 health, §9/DV-25 momentum, §4 confidence and §4's relationship class,
    // in that order and all multiplicative: each can only ever DAMP the one
    // before it, so the relationship weight remains the ceiling of the term and
    // no combination of the three can manufacture rank.
    const value = round3(
      base * clamp01(m.confidence) * scale * healthFactor(opts?.trailHealthScale, m.trail_id),
    );
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
  // `.values`: a Trail fold is scoped to Trails, and the momentum store's own
  // provenance describes the PLACE-level window it was computed over. Restating
  // it here would attach a window label to a different unit of analysis.
  return computeLocalMomentum(folded, nowMs).values;
}
