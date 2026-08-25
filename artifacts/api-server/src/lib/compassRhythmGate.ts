/**
 * Intelligence Gathering — Compass rhythm k-anonymity gate (IG-07).
 *
 * THE LEAK THIS CLOSES. CompassGraphEngine.buildDestinationContextLines emits a
 * "Destination rhythm — <city> (<slice>): typically active around … at this time
 * (community history, N observations)" line whenever a time slice has
 * `count >= MIN_SLICE_SAMPLE`. But `count` sums `observed_count` over
 * compass_graph_edges whose dedup key contains NO user id, so N observations can
 * all be ONE person. At k=1 that line is a single traveler's rhythm published as
 * "community history".
 *
 * THE FIX. Publish a time-sliced rhythm line only when at least
 * COMPASS_RHYTHM_K DISTINCT contributors are behind it (reusing lib/kAnonymity),
 * AND only when the gate flag is on. With the flag off — the deploy default —
 * the sliced line is suppressed entirely and Compass falls back to the
 * city-wide, non-time-sliced summary, which carries no k=1 exposure.
 *
 * ⚠ LIVE-PATH NOTE. The rhythm line is already live. Deploying this SUPPRESSES it
 * until (a) the graph build records a per-slice distinct-actor count and (b) an
 * owner enables intel_compass_rhythm_actor_gate. Until then `distinctActors` is
 * absent (0) and every sliced line is suppressed — the safe direction.
 *
 * RUNTIME EFFECT of THIS module: NONE on its own — pure functions.
 */
import { meetsKAnonymity } from "./kAnonymity.js";

export const COMPASS_RHYTHM_FLAG = "intel_compass_rhythm_actor_gate";

/**
 * Minimum DISTINCT contributors before a time-sliced destination-rhythm line may
 * publish. A product/owner parameter (kAnonymity never chooses k); 5 matches the
 * spec's minimum-cohort floor for a coarse city×time-slice aggregate.
 */
export const COMPASS_RHYTHM_K = 5;

/**
 * May a time-sliced rhythm line be published? Requires the gate flag on AND the
 * slice to clear k-anonymity on DISTINCT contributors. Fail-closed: flag off, or
 * an absent/low distinct-actor count, suppresses.
 */
export function mayPublishRhythm(distinctActors: number, flagEnabled: boolean, k: number = COMPASS_RHYTHM_K): boolean {
  if (!flagEnabled) return false;
  return meetsKAnonymity(distinctActors, k);
}
