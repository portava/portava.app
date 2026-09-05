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

/**
 * Author-side visibility for one submitted row (`discovery_places.submitted_by`,
 * `hidden_gems.submitted_by`, and any other row that carries an author id
 * alongside a venue fact).
 *
 * A `discovery_places` row can carry a `submitted_by` — a real person, whose
 * blurb, photo and rating ride along with the venue. Blocking that person hides
 * their submission, which is what every other surface already does with this
 * same column.
 *
 * `blockedIds === null` means the block list could not be READ. A row with no
 * submitter is a venue fact and stays; a row with one is withheld, per the
 * fail-closed contract above — never leak while block state is uncertain.
 *
 * This lives HERE, next to fetchBlockedSet, rather than in one route, because
 * more than one route queries `discovery_places` directly: routes/discovery.ts
 * (feed + community) and routes/discoverySearch.ts (serve points 8 and 9,
 * `/discovery/search` and `/discovery/suggest`) each build their own query, and
 * a rule that lives inside one of them is a rule the other can silently skip —
 * which is exactly how search and suggest kept serving a blocked submitter's
 * rows after the feed stopped. One definition, imported by every reader.
 *
 * routes/discovery.ts re-exports this symbol so its existing importers (and the
 * source guards in test/discoveryBlockedSubmitter.test.ts) are unaffected.
 */
export function submitterIsVisible(
  submittedBy: unknown,
  blockedIds: Set<string> | null,
): boolean {
  const author = (submittedBy ?? null) as string | null;
  if (!author) return true;               // venue fact — no voice attached to it
  if (blockedIds === null) return false;  // block state unknown → fail closed
  return !blockedIds.has(author);
}
