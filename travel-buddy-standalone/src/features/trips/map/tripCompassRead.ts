/**
 * census-discovery §108 (DV-83 round 11, D-W11X2-81): the §11 trip map's Compass alternatives read.
 *
 * `buildComposedTrip` (app/map/index.tsx) read GET /compass/recommendations for the trip as
 * `compassRes.ok ? data.recommendations : []`: a failed read and a refused (`nothing`) body were both
 * drawn as "Compass has no alternatives" — no pins and no word — and a `partial` body as the complete
 * set. These two functions are the whole of the consumer's branch on coverage, through the shared
 * predicate every /compass/recommendations consumer uses (D-W11X2-55):
 *   - `nothing`, a missing or unknown coverage, an older server's `error` marker, or a failed transport
 *     → no alternatives, read state `failed` (the map says it);
 *   - `partial` → the rows that were read, read state `partial` (the map says the set may be incomplete);
 *   - no refusal → the rows, no read state.
 * The map keeps its §33 posture — one unreachable source never blanks the map — and now says which.
 */
import type { CompassRecommendation, CompassRecommendationsResponse } from '../../../services/compass.ts';
import { compassRecommendationsFailed } from '../../../services/compassRecommendationsRefusal.ts';

export type TripCompassRead = 'failed' | 'partial' | null;

type TripCompassAnswer = { ok: boolean; data?: Partial<CompassRecommendationsResponse> | null };

/** The recommendations the trip map may compose into alternatives: none over a failed read. */
export function tripCompassRecommendations(res: TripCompassAnswer): CompassRecommendation[] {
  if (!res.ok || !res.data || compassRecommendationsFailed(res.data)) return [];
  return res.data.recommendations ?? [];
}

/** What the trip map says about its Compass alternatives: a failed read, a partial one, or nothing. */
export function tripCompassReadState(res: TripCompassAnswer): TripCompassRead {
  if (!res.ok || !res.data || compassRecommendationsFailed(res.data)) return 'failed';
  return res.data.refusal?.coverage === 'partial' ? 'partial' : null;
}
