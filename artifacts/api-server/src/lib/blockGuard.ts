/**
 * Canonical, FAIL-CLOSED block check between two users.
 *
 * Why this exists: several call sites hand-rolled a block check as
 *   const { data } = await sc.from("blocks")…maybeSingle(); return Boolean(data);
 * which is fail-OPEN in two distinct ways, both confirmed as live authorization
 * bugs:
 *
 *  1. supabase-js RESOLVES (does not reject) on a PostgREST/Postgres error,
 *     returning { data: null, error }. Reading only `data` treats any transient
 *     DB error as "not blocked" — a blocked user slips through during a blip.
 *
 *  2. `.maybeSingle()` raises on >1 row. A mutual block is two rows — (A,B) and
 *     (B,A), both permitted by the blocks UNIQUE(blocker_id, blocked_id) — so the
 *     STRONGEST block state (fully mutual) made maybeSingle error, `data` null,
 *     and the check read "not blocked". The guard failed exactly when it mattered
 *     most.
 *
 * This helper fails CLOSED: it returns true (treat as blocked) if a block exists
 * in EITHER direction OR if the query errors, and uses `.limit(1)` so the mutual
 * case never raises. A block guard denying on an unreadable blocks table is the
 * safe default; a transient error briefly over-denying an invite/presence is far
 * better than leaking to a blocked user.
 */
import { recordTelegraphMetric } from "../domain/telegraph/services/telegraphObservability.js";

export async function isBlockedBetween(
  sc: any,
  userA: string,
  userB: string,
): Promise<boolean> {
  if (!userA || !userB) return false; try { // census-telegraph §94: a THROWN read is the same unknown as a returned error — see the catch at the foot
  const { data, error } = await sc
    .from("blocks")
    .select("blocker_id")
    .or(
      `and(blocker_id.eq.${userA},blocked_id.eq.${userB}),and(blocker_id.eq.${userB},blocked_id.eq.${userA})`,
    )
    .limit(1);
  if (error) {
    // Telegraph §28 "blocked direct deliveries = 0" / §30A.17 block-enforcement
    // SLO. This branch is the one worth counting: the guard denied WITHOUT
    // KNOWING, which is the rate at which block enforcement is running blind.
    // It is invisible in any success metric, and it is what a leak looks like in
    // its early stage. Counters only — no ids leave this call.
    recordTelegraphMetric("block_enforcement_failures", "violation");
    recordTelegraphMetric("blocked_direct_deliveries", "unknown");
    // `unknown`, deliberately, and not `violation`: nothing was delivered, so
    // the §28 target is not breached. What happened is that the guard could not
    // SEE, and an unknown folded into either column would hide that.
    return true; // fail closed — an unreadable blocks table denies
  }
  const blocked = Array.isArray(data) && data.length > 0;
  // Both answers are `ok` for the §28 metric, and that is not a shortcut: the
  // target is "blocked direct deliveries = 0", and a refusal IS zero deliveries.
  // This counter cannot observe a leak — a delivery to a blocked pair would mean
  // this function was never consulted — so the zero is established by the §27.1
  // property P-04, which quantifies over the failure states, and what the
  // counter adds is the rate at which the guard runs blind.
  recordTelegraphMetric("blocked_direct_deliveries", "ok");
  recordTelegraphMetric("block_enforcement_failures", "ok");
  return blocked; } catch { return deniedAfterThrow(); } // a torn-down client, a builder bug, a rejected fetch: deny and count, exactly as :40-51 do
}

/**
 * census-telegraph §94. A THROWN read used to escape `isBlockedBetween` as an
 * exception, so whether it denied depended on the caller: the thread read's
 * capability resolver let it out as a 500 while a RETURNED error, two lines
 * apart in the same function, was served as "blocked". It is now the same
 * unknown with the same answer and the same two counters as the error branch.
 */
function deniedAfterThrow(): true {
  recordTelegraphMetric("block_enforcement_failures", "violation");
  recordTelegraphMetric("blocked_direct_deliveries", "unknown");
  return true; // fail closed — an unreadable blocks table denies
}
