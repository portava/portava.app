/**
 * blocks — the one place the app resolves "who is blocked, in either direction".
 *
 * A block is symmetric for visibility: if A blocked B, then A must not see B
 * AND B must not see A. Every surface that exposes people or their locations
 * (map travelers, trip-crew map, circle locations, search, feeds) filters
 * against this set.
 *
 * fetchBlockedSet returns EVERY user id that either blocked `userId` or was
 * blocked by them, or null when the list could not be read — callers MUST treat
 * null as "show nobody" (fail-closed), never as "no blocks" (lib/mapTravelers).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readBlockExclusions } from "./exclusionSet.js";

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
    // ONE definition of the whole-list read (census-telegraph §98): lib/exclusionSet's,
    // keyset-paged to the END of the list. This read was range-less, so past
    // PostgREST's db-max-rows (1000 hosted) block relationships it held a PREFIX
    // and everyone after it read as "not blocked"; and it read `data ?? []`, so
    // `{ data: null, error: null }` — what postgrest-js resolves for a 404 or a 2xx
    // with an empty body — was "nobody is blocked". Every failure (an error on any
    // page, a page that is not a row list, a row without its counter-party, a list
    // past BLOCK_LIST_CEILING) is unreadable there, and null here.
    const set = await readBlockExclusions(sc, userId);
    if (!set.ok) return null;
    return new Set(set.ids);
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
