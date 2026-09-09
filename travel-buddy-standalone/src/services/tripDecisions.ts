/**
 * §8 + §5.1 — the clients for the decision and structure read surfaces.
 *
 * WHY THESE TWO ARE ONE FILE
 * ==========================
 * They are the two halves of "what does this trip actually consist of, and
 * what is it waiting on". A screen showing a recommendation without the plan
 * element it concerns, or a stage spine with no idea which decisions are
 * blocking it, has half the picture — and the joins that make them one picture
 * were done server-side precisely so each client would not do them differently.
 *
 * THE THIRD STATE, AGAIN
 * ======================
 * Both routes refuse the whole response when any input read fails, because a
 * partial answer here is not a weaker answer, it is a different one. This
 * client preserves that: `unavailable` is never collapsed into an empty
 * result, and there is no "we got some of it" state to fall into.
 *
 * WHAT IS DELIBERATELY NOT RE-DERIVED HERE
 * ========================================
 * The recommendation kind, the reasons, the risk propagation, `goingUserIds`
 * and the vote tally all arrive computed. None is recalculated locally. Each
 * one is a rule with a wrong-but-plausible local version — "no objection
 * found" instead of INSUFFICIENT_BASIS, `interested` counted as attending,
 * "more than half of those who voted" instead of half the electorate — and a
 * second implementation is a second chance to get it wrong.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

// ── §8 ──────────────────────────────────────────────────────────────────────

/** The three outcomes. INSUFFICIENT_BASIS is an ANSWER, not a weak yes. */
export const RECOMMENDATION_KINDS = ['INSUFFICIENT_BASIS', 'DO_NOT_RECOMMEND', 'RECOMMEND'] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

export interface OptionAssessment {
  proposalId: string;
  eligible: boolean;
  reasons: string[];
  servedOpenGoalIds: string[];
  worstRiskImpact: 'low' | 'medium' | 'high' | null;
}

export interface Recommendation {
  decisionTaskId: string;
  kind: RecommendationKind;
  proposalId: string | null;
  reasons: string[];
  options: OptionAssessment[];
}

export interface ProposalTally {
  found: boolean;
  decision_rule?: string;
  electorate?: number;
  yes?: number; no?: number; abstain?: number; cast?: number;
  majority_met?: boolean; unanimous_met?: boolean;
}

export interface DecisionBoard {
  tripId: string;
  asOf: string;
  goals: Array<{ id: string; type: string; priority: string; status: string; evidence: unknown }>;
  decisionTasks: Array<{
    id: string; type: string; deadlineAt: string | null; consequence: string | null;
    assignedUserId: string | null; status: string;
  }>;
  risks: Array<{
    id: string; likelihood: string; impact: string; status: string;
    trigger: unknown; mitigation: unknown;
  }>;
  proposals: Array<{
    id: string; type: string; status: string; decisionRule: string;
    proposedBy: string | null; expiresAt: string | null; payload: unknown;
    /** NULL means the tally could not be COMPUTED. Never render it as no votes. */
    tally: ProposalTally | null;
    /**
     * The VIEWER's own ballot, or null for "has not voted".
     *
     * Null is not `abstain`. An abstention is a recorded decision not to
     * decide and counts toward a unanimous rule being satisfied; a silence
     * does not, because nobody knows what it means. Rendering both as "no
     * vote" erases the distinction that rule turns on.
     *
     * Other people's ballots are NOT served — see VOTE_BALLOT_VISIBILITY in
     * the blocker ledger for why the narrow default was chosen.
     */
    myVote: 'yes' | 'no' | 'abstain' | null;
  }>;
  /** How many tallies failed. A null tally is a visible absence because of this. */
  tallyFailures: number;
  recommendations: Recommendation[];
  elementRisks: Array<{
    elementId: string; riskIds: string[];
    worstImpact: 'low' | 'medium' | 'high';
    worstLikelihood: 'low' | 'medium' | 'high';
  }>;
}

export type DecisionRead =
  | { state: 'ok'; board: DecisionBoard }
  | { state: 'off' }
  | { state: 'unavailable'; detail: string };

// ── §5.1 ────────────────────────────────────────────────────────────────────

export interface TripStructure {
  tripId: string;
  stages: Array<{
    id: string; stageType: string; placeId: string | null; cityId: string | null;
    timezone: string; startsAt: string | null; endsAt: string | null;
    state: string; sequence: number;
    legsFrom: string[]; legsTo: string[]; commitmentIds: string[];
  }>;
  legs: Array<{
    id: string; fromStageId: string; toStageId: string; legType: string;
    startsAt: string | null; endsAt: string | null; sourceRef: string | null;
  }>;
  commitments: Array<{
    id: string; stageId: string | null; type: string;
    startsAt: string | null; requiredArrivalAt: string | null; placeId: string | null;
    /** Postgres interval TEXT, unparsed. A duration that cannot be read is not
     *  a duration of zero, so nothing here turns it into one. */
    latenessTolerance: string | null; prepDuration: string | null;
    flexibility: string; confidence: number | null; sourceRef: string | null;
  }>;
  planAttendance: Array<{
    planId: string;
    participants: Array<{ userId: string; attendanceState: string; role: string | null }>;
    /** §9.1's party: `going` only. Computed server-side; do not re-derive. */
    goingUserIds: string[];
  }>;
  outcomes: Array<{
    id: string; stageId: string | null; planId: string | null;
    outcomeType: string; occurredAt: string; evidence: unknown;
    /** False when the plan is gone entirely — the case §5.2's missing FK
     *  exists for, not a data defect. Null when the outcome names no plan. */
    planPresent: boolean | null;
    stagePresent: boolean | null;
  }>;
  /** Should always be empty; reported so the day one is not, it is visible. */
  orphanedLegs: string[];
  orphanedCommitments: string[];
  orphanedAttendance: string[];
}

export type StructureRead =
  | { state: 'ok'; structure: TripStructure }
  | { state: 'off' }
  | { state: 'unavailable'; detail: string };

// ── the fetchers ────────────────────────────────────────────────────────────

async function readJson<T>(
  path: string,
  valid: (body: any) => boolean,
): Promise<{ state: 'ok'; body: T } | { state: 'off' } | { state: 'unavailable'; detail: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { state: 'off' };
  const token = await freshToken();
  if (!token) return { state: 'off' };
  try {
    const res = await fetch(`${apiBase()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const err = await res.json().catch(() => null) as { error?: string } | null;
      if (res.status === 404 && err?.error === 'feature_disabled') return { state: 'off' };
      return { state: 'unavailable', detail: `HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => null);
    // A body missing the lists is not an empty trip. Only a response that
    // actually carries them may be reported as one.
    if (!body || !valid(body)) return { state: 'unavailable', detail: 'unreadable response' };
    return { state: 'ok', body: body as T };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

export async function fetchTripDecisions(tripId: string): Promise<DecisionRead> {
  const r = await readJson<DecisionBoard>(
    `/api/trips/${tripId}/decisions`,
    (b) => Array.isArray(b.recommendations) && Array.isArray(b.proposals) && Array.isArray(b.elementRisks),
  );
  return r.state === 'ok' ? { state: 'ok', board: r.body } : r;
}

export async function fetchTripStructure(tripId: string): Promise<StructureRead> {
  const r = await readJson<TripStructure>(
    `/api/trips/${tripId}/structure`,
    (b) => Array.isArray(b.stages) && Array.isArray(b.legs) && Array.isArray(b.commitments),
  );
  return r.state === 'ok' ? { state: 'ok', structure: r.body } : r;
}

// ── presentation helpers ────────────────────────────────────────────────────

/**
 * One line for a recommendation. INSUFFICIENT_BASIS is never phrased as
 * approval, and DO_NOT_RECOMMEND is never softened into a shrug — those are
 * the two directions this can go wrong in.
 */
export function recommendationHeadline(r: Recommendation): string {
  switch (r.kind) {
    case 'RECOMMEND':          return 'Recommended';
    case 'DO_NOT_RECOMMEND':   return 'None of these work';
    case 'INSUFFICIENT_BASIS':
    default:                   return 'Not enough to go on yet';
  }
}

/**
 * What to say about the viewer's own ballot. The three states stay three:
 * voted, deliberately abstained, and not voted at all.
 */
export function myVoteLabel(v: 'yes' | 'no' | 'abstain' | null): string {
  switch (v) {
    case 'yes':     return 'You voted yes';
    case 'no':      return 'You voted no';
    case 'abstain': return 'You abstained';
    default:        return 'You have not voted';
  }
}

/** The reason codes, in words. An unknown code passes through rather than
 *  being dropped: a reason nobody can read is still a reason. */
const REASON_TEXT: Record<string, string> = {
  INFEASIBLE_SCHEDULE: 'the schedule cannot be met',
  FEASIBILITY_UNKNOWN: 'the schedule could not be checked',
  BLOCKED_BY_HIGH_RISK: 'a high-impact risk affects it',
  DEADLINE_PASSED: 'the deadline has passed',
  NO_PROPOSALS: 'nothing has been proposed',
  ALL_OPTIONS_DISQUALIFIED: 'every option was ruled out',
  TIED_ON_AVAILABLE_EVIDENCE: 'the options are tied on what we know',
  PROPOSAL_NOT_DECIDED: 'its vote has not concluded',
  SERVES_GOAL: 'it serves a goal you set',
  NO_OBJECTION_AND_NO_GOAL: 'nothing objects to it',
};

export function reasonText(code: string): string {
  return REASON_TEXT[code] ?? code;
}

/**
 * Can this proposal be accepted under its own rule?
 *
 * Returns null when the tally is missing — which is NOT false. "It cannot be
 * accepted yet" and "we could not work out whether it can" are different
 * things to tell someone holding the decision.
 */
export function acceptanceMet(p: { decisionRule: string; tally: ProposalTally | null }): boolean | null {
  if (!p.tally || p.tally.found !== true) return null;
  switch (p.decisionRule) {
    case 'majority':  return p.tally.majority_met ?? null;
    case 'unanimous': return p.tally.unanimous_met ?? null;
    // 'host' and 'anyone' are not vote-counted rules: the tally says nothing
    // about them, and guessing from vote counts would be inventing a rule.
    case 'host':
    case 'anyone':
    default:          return null;
  }
}
