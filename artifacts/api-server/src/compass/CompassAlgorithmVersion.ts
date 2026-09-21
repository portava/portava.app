/**
 * CompassAlgorithmVersion — Trips §18: an automated suggestion must be
 * explainable from its STORED INPUTS **and a versioned algorithm**.
 *
 * WHAT WAS MISSING, AND IT WAS ONLY EVER THE SECOND HALF
 * =====================================================
 * census-compass CT-13 measured both halves and found the first one built:
 * every autopilot proposal persists its `reason` and per-item before/after
 * `changes`, and every served recommendation persists its factor snapshot. The
 * second half was absent outright — `grep -i algorithm CompassAutopilotEngine.ts`
 * returned nothing, and `compass_algorithm_versions` existed as a table that
 * the ADMIN routes write and NOTHING stamps a suggestion with. So a stored
 * suggestion could be re-read but not re-derived: the inputs were there and the
 * rules that turned them into that suggestion were not identified.
 *
 * THE SHAPE IS NOT NEW — IT IS THE INTEL LAYER'S, DELIBERATELY
 * ===========================================================
 * `PROJECTION_ALGORITHM_VERSION`, `ATTRIBUTION_ALGORITHM_VERSION` and
 * `SCOPED_TRUST_ALGORITHM_VERSION` already stamp stored intel rows with a
 * `component/N+component/N` string, and `intelReplay` uses it to say
 * `algorithm_version_changed` when a replay disagrees for that reason rather
 * than a numeric one. Compass adopts the same grammar so a reader who knows one
 * knows both.
 *
 * WHERE IT IS STORED, AND WHY THERE
 * =================================
 *   • Served recommendations → inside the `ranking_factors` JSONB that already
 *     holds the factor snapshot. The reader takes named keys, so an added key
 *     is additive and no migration is needed.
 *   • Autopilot proposals → on EVERY entry of the `changes` JSONB array.
 *     `trip_autopilot_proposals` has no envelope column, and this pass wrote no
 *     migration. Putting it on one entry would make the stamp depend on which
 *     entry survived an edit; putting it on all of them makes the proposal
 *     explainable as long as ANY change remains. The redundancy is the price of
 *     not writing a migration, and it is stated here rather than discovered.
 *
 * WHAT THIS DOES NOT CLAIM
 * ========================
 * Nothing MECHANICALLY forces a bump when a weight or a repair rule changes —
 * exactly as nothing does for the three intel constants above. A version
 * somebody forgets to raise is a wrong version, and this module cannot see
 * that. What it does buy is the thing §18 actually asks for: a stored
 * suggestion now NAMES the algorithm that produced it, so two suggestions made
 * by different rule sets are distinguishable instead of silently identical.
 */

/** Bump when a scoring weight, a boost or the factor vocabulary changes. */
export const COMPASS_RANKING_ALGORITHM_VERSION =
  "compass-ranking/1+factors/1+worldmodel/1+intent/1";

/** Bump when an autopilot detection rule or repair shape changes. */
export const COMPASS_AUTOPILOT_ALGORITHM_VERSION =
  "compass-autopilot/1+repair-rules/1";

/** The key every Compass stamp rides under, so a reader greps one word. */
export const ALGORITHM_VERSION_KEY = "algorithmVersion" as const;

/**
 * A `component/N+component/N` string, the grammar lib/intelContracts' three
 * version constants already use. Exported so a test can assert the shape
 * rather than the literal, which would make every legitimate bump a test edit.
 */
export const ALGORITHM_VERSION_SHAPE = /^[a-z][a-z0-9-]*\/\d+(\+[a-z][a-z0-9-]*\/\d+)*$/;

export function isAlgorithmVersion(v: unknown): v is string {
  return typeof v === "string" && ALGORITHM_VERSION_SHAPE.test(v);
}
