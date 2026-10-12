/**
 * The bounded-attempt budget for ESSENTIAL notifications when the
 * notification ledger cannot be read — OD-1012-LAY-4a (owner, 2026-10-12):
 *
 *   "If notification history is unavailable, urgent warnings must still be
 *    attempted, but retries must remain bounded to avoid notification storms."
 *
 * The ledger (public.notifications) is what normally makes a second "leave
 * now" for the same session a duplicate. When it cannot be read, an essential
 * warning must not be suppressed (OD-1012-LAY-1) — and must not go out once per
 * replan either. This budget is the bound, and it does not depend on the
 * unavailable ledger: it lives in this process's memory.
 *
 * THE BOUND (exact):
 *   - key        = user + category + event type + source type + source id
 *                  (for a layover warning: one traveller, one session, one
 *                  required action — `<session>:<action>`);
 *   - at most ESSENTIAL_UNREADABLE_MAX_ATTEMPTS (2) attempts per key in any
 *     rolling ESSENTIAL_UNREADABLE_WINDOW_MS (30 minutes, the ledger's own
 *     general dedup window) while the ledger is unreadable. The first is the
 *     attempt the ruling requires; the second covers a first attempt whose
 *     persist failed in the same outage. A third inside the window is
 *     suppressed as `essential_attempt_cap`.
 *   - memory is bounded too: at most ESSENTIAL_BUDGET_MAX_KEYS keys; expired
 *     keys are pruned first (when the cap is reached), then the oldest.
 *
 * ACROSS PROCESS RESTARTS the budget starts empty, so the bound is
 * 2 x (process starts inside the window) per key. Nothing on this path
 * restarts a process, and every attempt still needs a NEW replan that
 * re-evaluates the warning; a durable bound needs a readable store, which is
 * exactly what is missing in this state. When the ledger IS readable, the
 * ledger's rule applies and this budget is not consulted.
 *
 * It is consulted ONLY for a caller that marked the notification `essential`
 * (today: a layover return warning at an `urgent` rung). Every other caller
 * keeps the ledger's fail-closed answer (an unreadable ledger is a duplicate).
 */

export const ESSENTIAL_UNREADABLE_MAX_ATTEMPTS = 2;
export const ESSENTIAL_UNREADABLE_WINDOW_MS = 30 * 60 * 1000;
export const ESSENTIAL_BUDGET_MAX_KEYS = 10_000;

const attempts = new Map<string, number[]>();

export function essentialAttemptKey(p: { userId: string; category: string; eventType: string; sourceType?: string; sourceId?: string }): string {
  return [p.userId, p.category, p.eventType, p.sourceType ?? "", p.sourceId ?? ""].join("|");
}

function prune(now: number): void {
  for (const [k, ts] of attempts) {
    const live = ts.filter((t) => now - t < ESSENTIAL_UNREADABLE_WINDOW_MS);
    if (live.length === 0) attempts.delete(k);
    else if (live.length !== ts.length) attempts.set(k, live);
  }
  while (attempts.size >= ESSENTIAL_BUDGET_MAX_KEYS) {
    const oldest = attempts.keys().next().value;
    if (oldest === undefined) break;
    attempts.delete(oldest);
  }
}

/**
 * Take one attempt for `key` at `now`. True = attempt it (and it is counted);
 * false = the bound is reached for this window — suppress.
 */
export function takeEssentialAttempt(key: string, now: number = Date.now()): boolean {
  const live = (attempts.get(key) ?? []).filter((t) => now - t < ESSENTIAL_UNREADABLE_WINDOW_MS);
  if (live.length >= ESSENTIAL_UNREADABLE_MAX_ATTEMPTS) {
    attempts.set(key, live);
    return false;
  }
  if (!attempts.has(key) && attempts.size >= ESSENTIAL_BUDGET_MAX_KEYS) prune(now);
  live.push(now);
  attempts.delete(key); // re-insert: Map order is the eviction order (oldest first)
  attempts.set(key, live);
  return true;
}

/** Test seam: forget every attempt (simulates a process restart). */
export function _resetEssentialAttemptBudget(): void {
  attempts.clear();
}

/** Test seam: how many keys are held. */
export function _essentialAttemptBudgetSize(): number {
  return attempts.size;
}
