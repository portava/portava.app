/**
 * The per-read bound on paid Routes API calls (census-trips §82; verifier
 * finding 7, 2026-10-05: "one member can drain the shared daily quota").
 *
 * 3971's spend gate bounds the DAY. Nothing bounded one READ: the route chain
 * asks once per hop over every placed plan item, the feasibility check up to
 * four times per hop, each call up to 4 s, sequentially. This module is the
 * bound in front of that, and it carries who the spend is FOR, so the gate can
 * charge a per-user and a per-trip share of the day (migration 3973).
 *
 * A BUDGET IS ONE READ, NESTED READS SHARE IT. `withRoutesRequestBudget` opens
 * one for the outermost Trips read (a route handler, or a projection builder
 * called on its own) and every builder it calls reuses it — Today → Health →
 * Freedom is one budget, not three. A builder called OUTSIDE any budget opens
 * its own.
 *
 * Inside a budget:
 *   - at most ROUTES_MAX_CALLS_PER_REQUEST calls are ASKED of the spend gate
 *     (a cached answer costs nothing and is not counted);
 *   - no routed call starts after ROUTES_REQUEST_TIME_BUDGET_MS since the
 *     budget opened, and a call in flight is abandoned when it would overrun it;
 *   - a spend needs BOTH a user and a trip: the gate charges their shares.
 * Over any of these the answer is the labelled straight-line bound
 * (`routes-api-fallback:<why>`), never an error and never a silent zero.
 *
 * Outside any budget nothing is spent at all (`unscoped`): a background job
 * that never said whose read it is cannot be charged to anyone's share.
 *
 * WHY THE COUNT CANNOT OVERSHOOT WITHIN A READ. The attempt is counted
 * synchronously, before the first await, so N concurrent estimates in one read
 * (a Promise.all over hops) see the counter in program order on Node's single
 * thread: exactly `max` reach the gate. Across reads and instances the shares
 * are counted in the database under row locks (3973).
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Calls one read may ASK the spend gate for. A day's route chain is a handful of hops; four per hop is feasibility's mode check. */
export const ROUTES_MAX_CALLS_PER_REQUEST = 12;
/** Wall-clock a read may spend waiting on routed calls before the rest fall back. Two of the adapter's 4 s timeouts. */
export const ROUTES_REQUEST_TIME_BUDGET_MS = 8_000;

interface Counter {
  attempts: number;
  readonly startedAt: number;
  /**
   * Set when a routed call in this read was abandoned for the time bound. From
   * then on the read's time is spent, whatever the clock says: a timer can fire
   * a millisecond before `Date.now()` agrees the budget has run out, and the
   * next hop must not start in that millisecond (CI flake, tripRoutedTravelTime G6).
   */
  timedOut?: boolean;
}

export interface RoutesRequestBudget {
  userId: string | null;
  tripId: string | null;
  readonly counter: Counter;
  readonly maxCalls: number;
  readonly budgetMs: number;
}

const store = new AsyncLocalStorage<RoutesRequestBudget>();

export function currentRoutesRequestBudget(): RoutesRequestBudget | undefined {
  return store.getStore();
}

/**
 * Run `fn` inside a routing budget for this user and trip. Reuses the enclosing
 * budget when there is one: its counter is shared, and a user or trip it lacks
 * is filled in. A nested read for a DIFFERENT trip shares the counter but is
 * charged to its own trip.
 */
export function withRoutesRequestBudget<T>(
  scope: { userId?: string | null; tripId?: string | null },
  fn: () => Promise<T>,
  limits: { maxCalls?: number; budgetMs?: number; now?: () => number } = {},
): Promise<T> {
  const cur = store.getStore();
  if (cur) {
    const tripId = scope.tripId ?? null;
    if (tripId !== null && cur.tripId !== null && tripId !== cur.tripId) {
      return store.run({ ...cur, tripId, userId: cur.userId ?? scope.userId ?? null }, fn);
    }
    if (cur.userId === null && scope.userId) cur.userId = scope.userId;
    if (cur.tripId === null && tripId) cur.tripId = tripId;
    return fn();
  }
  const now = limits.now ?? Date.now;
  return store.run({
    userId: scope.userId ?? null,
    tripId: scope.tripId ?? null,
    counter: { attempts: 0, startedAt: now() },
    maxCalls: limits.maxCalls ?? ROUTES_MAX_CALLS_PER_REQUEST,
    budgetMs: limits.budgetMs ?? ROUTES_REQUEST_TIME_BUDGET_MS,
  }, fn);
}

/** Fill in who the enclosing read is for, once a handler knows. Outside a budget it does nothing. */
export function fillRoutesRequestScope(scope: { userId?: string | null; tripId?: string | null }): void {
  const cur = store.getStore();
  if (!cur) return;
  if (cur.userId === null && scope.userId) cur.userId = scope.userId;
  if (cur.tripId === null && scope.tripId) cur.tripId = scope.tripId;
}
