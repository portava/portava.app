/**
 * census-discovery §104 (DV-83, D-W11X2-55): GET /compass/recommendations' failed reads.
 *
 * Every failure arm of the route used to answer `{ recommendations: [] }`, the body a
 * city with nothing to suggest gets, so search's Compass rail and For You's traveler row
 * drew a failed read as an absence. The route now sends the refusal envelope: `nothing`
 * when the read that fills the list failed, `partial` beside the rows that were read.
 * An older server's `error: "block_check_failed"` marker is read as `nothing` too.
 *
 * Kept in its own module (not services/compass.ts) so a test that mocks the service
 * still gets the real predicate, as hooks/compass/compassSectionFailure.ts is.
 */
export interface CompassRecommendationsRefusal {
  class?: string;
  code?: string;
  coverage: 'nothing' | 'partial';
  failedSources?: string[];
}

/** Is this answer a FAILED read — refused `nothing`, or an older server's `error` marker? */
export function compassRecommendationsFailed(body: { refusal?: CompassRecommendationsRefusal | null; error?: unknown } | null | undefined): boolean {
  if (!body) return false;
  if (body.refusal) return body.refusal.coverage !== 'partial';  // census-discovery §108 (DV-83, D-W11X2-82): a missing or unknown coverage is a failed read, never a complete answer — was: === 'nothing'
  return typeof body.error === 'string';
}

/** A list read from the route: a failure is `ok: false`, a partial answer carries `partial: true`. */
export function compassMatchesFromBody<T>(body: { recommendations?: unknown; refusal?: CompassRecommendationsRefusal | null; error?: unknown }): { ok: boolean; data?: T[]; error?: string; partial?: boolean } {
  if (compassRecommendationsFailed(body)) return { ok: false, error: body.refusal?.code ?? (typeof body.error === 'string' ? body.error : 'refused') };
  const data = (Array.isArray(body.recommendations) ? body.recommendations : []) as T[];
  return body.refusal?.coverage === 'partial' ? { ok: true, data, partial: true } : { ok: true, data };
}
