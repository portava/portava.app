/**
 * census-layover §83 — two pure readings of what the server serves, kept OUT of `services/layover.ts` on purpose: three
 * dozen dashboard suites mock that module with an explicit factory, and a helper living there would be `undefined`
 * under every one of them. Nothing here fetches or decides; the status and the fallback are the server's.
 */
import type { CandidateFeasibility, CompassAssistantState, LayoverRecommendation } from '../../services/layover.ts';
/**
 * census-layover §83 (L38/L50/L97 reaching the map; L117) — the per-recommendation band the map joins onto plan stops.
 * A card the server serves with `available === false` (BLOCKED, STALE, EXPIRED or SUPERSEDED, under
 * `layover_recommendation_status_enabled`) is a BLOCKED pin carrying the server's own sentence, so a stop added before
 * its card stopped being available is kept off the map and listed with why. Every other card passes its feasibility
 * through unchanged, and a card with neither has no entry (unmeasured, never unblocked). A lookup, not a calculation:
 * the status is decided on the server.
 */
export function candidateFeasibilityByRecId(recs: readonly LayoverRecommendation[]): Record<string, CandidateFeasibility> {
  const out: Record<string, CandidateFeasibility> = {};
  for (const r of recs) {
    if (!r.id) continue;
    if (r.available === false) {
      out[r.id] = { band: 'BLOCKED', certified: false, lowerBoundOneWayMin: r.feasibility?.lowerBoundOneWayMin ?? null, withinPlannedEdge: null, reason: r.statusExplanation ?? 'This idea is not available right now.', plannedEdgeReason: null, impliesFit: false };
    } else if (r.feasibility) {
      out[r.id] = r.feasibility;
    }
  }
  return out;
}

/** The one sentence a fallback answer carries. Every reason is said as a reason; an unknown one is said generically. */
export function compassFallbackSentence(a: CompassAssistantState | undefined | null): string | null {
  if (!a || a.status !== 'fallback') return null;
  const why: Record<string, string> = {
    rate_limited: 'it is busy right now',
    certification_mismatch: 'its answer did not match your certified plan',
    model_error: 'it could not be reached',
    model_timeout: 'it took too long',
    model_empty: 'it returned nothing',
    boundary_violation: 'its answer went beyond what your certified plan allows',
    nothing_admitted: 'none of its answer could be checked against your certified plan',
  };
  const reason = a.fallbackReason ? why[a.fallbackReason] : undefined;
  return `The assistant did not shape this answer${reason ? ` (${reason})` : ''}. This is your certified answer on its own.`;
}
