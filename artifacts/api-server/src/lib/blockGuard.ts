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
export async function isBlockedBetween(
  sc: any,
  userA: string,
  userB: string,
): Promise<boolean> {
  if (!userA || !userB) return false;
  const { data, error } = await sc
    .from("blocks")
    .select("blocker_id")
    .or(
      `and(blocker_id.eq.${userA},blocked_id.eq.${userB}),and(blocker_id.eq.${userB},blocked_id.eq.${userA})`,
    )
    .limit(1);
  if (error) return true; // fail closed — an unreadable blocks table denies
  return Array.isArray(data) && data.length > 0;
}
