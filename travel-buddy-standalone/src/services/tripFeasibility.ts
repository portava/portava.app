/**
 * §7 feasibility — the client for GET /trips/:tripId/feasibility.
 *
 * WHAT THIS SURFACE IS ALLOWED TO SAY
 * ===================================
 * The server has no routing provider, and it does not pretend otherwise. Its
 * travel numbers are straight-line lower bounds, which supports exactly one
 * confident claim and no other:
 *
 *   INFEASIBLE           PROVEN. No road is shorter than the great circle, so
 *                        a schedule that fails against a straight line cannot
 *                        be rescued by a real route.
 *   FEASIBLE_UNVERIFIED  it fits against that lower bound, and the real journey
 *                        is longer by an unknown amount. This is NOT "you are
 *                        fine", and any surface rendering it must carry the
 *                        server's `disclosure` alongside.
 *   UNKNOWN              nothing could be computed — usually because a
 *                        commitment names no place, or names one with no
 *                        coordinates.
 *
 * There is no FEASIBLE. If one ever appears in a response, something upstream
 * started claiming a measurement it did not make, and `isFeasibilityVerdict`
 * will reject it rather than pass it through to a screen.
 *
 * THE THIRD STATE, AS EVERYWHERE ELSE IN TRIPS
 * ===========================================
 * `off` and `unavailable` are different and neither is a verdict. A schedule
 * whose feasibility could not be READ is not a schedule with no problems in
 * it — that is the same collapse the readiness card carried until 2026-09-09,
 * and it matters more here, because the thing being hidden is "you cannot get
 * there in time".
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

/** Every verdict the server may return. FEASIBLE is deliberately absent. */
export const FEASIBILITY_VERDICTS = ['INFEASIBLE', 'UNKNOWN', 'FEASIBLE_UNVERIFIED'] as const;
export type FeasibilityVerdict = (typeof FEASIBILITY_VERDICTS)[number];

export function isFeasibilityVerdict(v: unknown): v is FeasibilityVerdict {
  return typeof v === 'string' && (FEASIBILITY_VERDICTS as readonly string[]).includes(v);
}

export interface FeasibilityHop {
  fromCommitmentId: string;
  toCommitmentId: string;
  verdict: FeasibilityVerdict;
  /** Minutes to spare. Negative is the size of the shortfall. Null when unknown. */
  slackMinutes: number | null;
  travelMinutes: number | null;
  prepMinutes: number | null;
  latenessToleranceMinutes: number | null;
  /** False when the hop was judged against a required arrival time, not a start. */
  usedStartAsArrival: boolean;
  confidence: string | null;
  unknownReason: string | null;
  routed: boolean;
}

/** §7.4's three-valued outcome, worst last. */
export const CONSISTENCY_VERDICTS = ['CONSISTENT', 'UNCHECKABLE', 'INCONSISTENT'] as const;
export type ConsistencyVerdict = (typeof CONSISTENCY_VERDICTS)[number];

export interface ConsistencyFinding {
  /** STAGE_LOCALITY_TIME | STAGE_LOCALITY_PLACE | PLACE_IDENTITY | ROUTE_AVAILABILITY */
  check: string;
  verdict: ConsistencyVerdict;
  reason: string;
  planIds: string[];
  stageId: string | null;
  detail: string;
}

export interface FeasibilityReport {
  tripId: string;
  commitmentCount: number;
  evaluatedHops: number;
  verdict: FeasibilityVerdict;
  confidence: string | null;
  worstSlackMinutes: number | null;
  offendingHopIndex: number | null;
  hops: FeasibilityHop[];
  /** Place ids a commitment names with no row behind them — a data defect. */
  unresolvedPlaceIds: string[];
  provider: { id: string; routed: boolean };
  /** The sentence to show next to any non-INFEASIBLE verdict. Always present. */
  disclosure: string;
  /**
   * §7.4's OTHER three checks — stage locality, place identity, route
   * availability. `verdict` cannot be CONSISTENT today: route availability
   * needs a transport-mode policy this system does not have, so it emits a
   * permanent UNCHECKABLE. That is §7.4's honest state, and a client that
   * showed a green tick would be claiming three checks are four.
   */
  consistency: { verdict: ConsistencyVerdict; findings: ConsistencyFinding[] };
}

export type FeasibilityRead =
  | { state: 'ok'; report: FeasibilityReport }
  /** Not configured here. Nothing was measured and nothing is claimed. */
  | { state: 'off' }
  /** The read FAILED. Distinct from `off`, and never a verdict. */
  | { state: 'unavailable'; detail: string };

export async function fetchTripFeasibility(tripId: string): Promise<FeasibilityRead> {
  if (!isSupabaseConfigured || !apiBase()) return { state: 'off' };
  const token = await freshToken();
  // Consistent with the rest of Trips: a missing token is the signed-out path,
  // not a read failure. See blocker-ledger API_TOKEN_SIGNED_OUT_VS_UNREADABLE.
  if (!token) return { state: 'off' };
  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/feasibility`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      // Only the server saying the feature is off counts as off. A 503, a 500,
      // an auth failure and a gateway page are all reads that did not answer.
      if (res.status === 404 && body?.error === 'feature_disabled') return { state: 'off' };
      return { state: 'unavailable', detail: `HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => null) as FeasibilityReport | null;
    // A verdict this client does not recognise is not passed to a screen. That
    // is how a future FEASIBLE — a claim nothing here measures — would reach a
    // user as reassurance.
    if (
      !body || !Array.isArray(body.hops) || !isFeasibilityVerdict(body.verdict)
      // §7.4 rides in the same response; a body without it is not a partial
      // answer, it is one this client cannot interpret.
      || !body.consistency || !Array.isArray(body.consistency.findings)
    ) {
      return { state: 'unavailable', detail: 'unreadable response' };
    }
    return { state: 'ok', report: body };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

/** The one-line headline for a verdict. Never reassuring about an unmeasured route. */
export function feasibilityHeadline(report: FeasibilityReport): string {
  switch (report.verdict) {
    case 'INFEASIBLE': {
      const short = report.worstSlackMinutes;
      return short === null || short >= 0
        ? "This schedule doesn't work"
        : `This schedule doesn't work — you're ${Math.abs(short)} min short`;
    }
    case 'FEASIBLE_UNVERIFIED':
      return 'Nothing here is impossible on paper';
    case 'UNKNOWN':
    default:
      return "We can't check this schedule yet";
  }
}

/**
 * The §7.4 findings a user should be shown: everything INCONSISTENT, and
 * nothing else.
 *
 * The UNCHECKABLE ones are deliberately NOT surfaced as warnings — there is
 * one per plan with no coordinates and a permanent one for route availability,
 * and a screen full of "we could not check this" trains a reader to ignore the
 * list that also carries "this plan is in the wrong city". They are counted
 * instead, so the absence is stated without being shouted.
 */
export function consistencyProblems(report: FeasibilityReport): ConsistencyFinding[] {
  return report.consistency.findings.filter((f) => f.verdict === 'INCONSISTENT');
}

/** How many §7.4 checks could not be run. Never zero today: see the type. */
export function consistencyUnchecked(report: FeasibilityReport): number {
  return report.consistency.findings.filter((f) => f.verdict === 'UNCHECKABLE').length;
}

/** Why UNKNOWN, in words, when the report says. */
export function feasibilityUnknownDetail(report: FeasibilityReport): string {
  if (report.evaluatedHops === 0) {
    return report.commitmentCount === 0
      ? 'This trip has no timed commitments to check.'
      : 'None of this trip\'s commitments have times to check against each other.';
  }
  const reasons = new Set(report.hops.map((h) => h.unknownReason).filter(Boolean) as string[]);
  if (reasons.has('NO_COORDINATES')) {
    return 'Some commitments have no location, so travel time between them cannot be estimated.';
  }
  if (reasons.has('NO_DEADLINE')) return 'Some commitments have no time to be there by.';
  if (reasons.has('PROVIDER_UNAVAILABLE')) return 'Travel times could not be estimated just now.';
  return 'Not enough information to check this schedule.';
}
