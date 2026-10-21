/**
 * Trips spec §8.1 — who may read a TripGoal (census-trips TR84, TR139; 2783).
 *
 *   "Goals may be personal or shared and weighted without forcing every
 *    participant to share priorities."
 *
 * 2783 gave `trip_goals` a `scope` ('shared' | 'personal') and an
 * `owner_user_id` set exactly when personal, and its RLS policy
 * `trip_goals_select_scoped` reads: crew AND (scope = 'shared' OR
 * owner_user_id = auth.uid()). A personal goal is its owner's alone.
 *
 * Every server reader of `trip_goals` uses the SERVICE client, so that policy
 * never runs on them. Until this file each of the three readers — the decision
 * surface, the pulse and the opportunity projection — served or weighed EVERY
 * goal on the trip, so one member's personal goal (its type, priority, weight
 * and evidence) reached every other member, and argued their recommendations.
 * This is the policy restated in TypeScript, once, for the readers RLS cannot
 * reach.
 *
 * FAIL CLOSED. A row whose scope is unread or unrecognised is not shared: it
 * is withheld. So is a personal goal with no owner, and any personal goal when
 * no viewer is named. The rule only ever narrows.
 */

/** The two columns the rule reads; a reader's select must name both. */
export const TRIP_GOAL_VISIBILITY_COLUMNS = "scope, owner_user_id";

export interface GoalVisibilityRow {
  scope?: unknown;
  owner_user_id?: unknown;
}

/** `trip_goals_select_scoped` for one row, for the viewer `viewerId`. */
export function goalVisibleTo(row: GoalVisibilityRow, viewerId: string | null): boolean {
  if (row.scope === "shared") return true;
  if (row.scope !== "personal") return false;
  return typeof viewerId === "string" && viewerId.length > 0 && row.owner_user_id === viewerId;
}

/** The rows of `rows` the viewer may read, in their original order. */
export function goalsVisibleTo<T extends GoalVisibilityRow>(rows: readonly T[], viewerId: string | null): T[] {
  return rows.filter((row) => goalVisibleTo(row, viewerId));
}
