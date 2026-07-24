/**
 * blocks — the one place the app resolves "who is blocked, in either direction".
 *
 * A block is symmetric for visibility: if A blocked B, then A must not see B
 * AND B must not see A. Every surface that exposes people or their locations
 * (map travelers, trip-crew map, circle locations, search, feeds) filters
 * against this set.
 *
 * fetchBlockedSet returns EVERY user id that either blocked `userId` or was
 * blocked by them. It returns null on read error — callers MUST treat null as
 * "show nobody" (fail-closed), never as "no blocks". This mirrors the contract
 * lib/mapTravelers already relies on: never leak when block state is uncertain.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Bidirectional blocked-user set for `userId`.
 * @returns a Set of the counter-party ids for every block row touching
 *          `userId`, or null if the block list could not be read (fail-closed).
 */
export async function fetchBlockedSet(
  sc: SupabaseClient,
  userId: string,
): Promise<Set<string> | null> {
  try {
    const { data, error } = await sc
      .from("blocks")
      .select("blocker_id, blocked_id")
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
    if (error) return null;
    const set = new Set<string>();
    for (const b of (data ?? []) as any[]) {
      if (b.blocker_id === userId) set.add(b.blocked_id as string);
      else set.add(b.blocker_id as string);
    }
    return set;
  } catch {
    return null;
  }
}
