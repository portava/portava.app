/**
 * tripGoals — what TripDecisionsCard says about a trip's goals (census-trips
 * wave-5 follow-up: the card read the board's `goals` and never drew them).
 *
 * The goals arrive on the same §8 board as the recommendations they explain
 * (`SERVES_GOAL` names them), issued by TripStructureComposer's ADD_GOAL.
 * Three states, and none of them is allowed to stand in for another:
 *
 *   listed      — the board carried goals; each is drawn in words, and any row
 *                 that could not be read is COUNTED, never silently dropped.
 *   none        — the board carried an empty list: a measurement, so "no goals
 *                 set yet" is true.
 *   unreadable  — the board carried no list at all (an older or broken
 *                 response). That is not "no goals", and it is never drawn as one.
 *
 * Nothing is re-derived: type, priority, status and scope are the server's
 * (2762 + 2783). An unknown value passes through rather than being dropped or
 * mapped to a neighbour, for the reason `reasonText` gives — a value nobody can
 * name is still a value.
 */
import type { DecisionBoard } from './tripDecisions.ts';

export type BoardGoal = DecisionBoard['goals'][number];

export type GoalsRead =
  | { state: 'listed'; goals: BoardGoal[]; unreadable: number }
  | { state: 'none' }
  | { state: 'unreadable' };

const TYPE_LABEL: Record<string, string> = {
  rest: 'Rest', budget: 'Budget', experience: 'Experience', social: 'Social',
  logistics: 'Logistics', safety: 'Safety', other: 'Other',
};
const PRIORITY_LABEL: Record<string, string> = { high: 'high priority', normal: 'normal priority', low: 'low priority' };
const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

function readable(g: unknown): g is BoardGoal {
  if (!g || typeof g !== 'object') return false;
  const r = g as Record<string, unknown>;
  return typeof r.id === 'string' && r.id.length > 0
    && typeof r.type === 'string' && r.type.length > 0
    && typeof r.priority === 'string' && typeof r.status === 'string';
}

/** The board's goals as one of the three states. Open goals first, then by priority. */
export function goalsOf(board: Pick<DecisionBoard, 'goals'> | null | undefined): GoalsRead {
  const raw = (board as { goals?: unknown } | null | undefined)?.goals;
  if (!Array.isArray(raw)) return { state: 'unreadable' };
  if (raw.length === 0) return { state: 'none' };
  const goals = raw.filter(readable);
  const rank = (g: BoardGoal) => (g.status === 'open' ? 0 : 1) * 10 + (PRIORITY_RANK[g.priority] ?? 3);
  return {
    state: 'listed',
    goals: goals.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map(({ g }) => g),
    unreadable: raw.length - goals.length,
  };
}

/** One goal in words: "Rest · high priority · just you · met". */
export function goalLine(g: BoardGoal): string {
  const parts = [TYPE_LABEL[g.type] ?? g.type, PRIORITY_LABEL[g.priority] ?? g.priority];
  // 2783: a personal goal is served only to its owner, so "personal" here means the viewer's.
  if (g.scope === 'personal') parts.push('just you');
  if (g.status !== 'open') parts.push(g.status); // 2762: 'met' or 'abandoned', said as stored
  return parts.join(' · ');
}
