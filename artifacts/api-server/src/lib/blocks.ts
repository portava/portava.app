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
import type { SupabaseClient } from "@supabase/supabase-js"; import { readBlockExclusions } from "./exclusionSet.js"; // census-telegraph §94 (T220c): the whole-list read, by key

/**
 * Bidirectional blocked-user set for `userId`.
 * @returns a Set of the counter-party ids for every block row touching
 *          `userId`, or null if the block list could not be read (fail-closed).
 */
export async function fetchBlockedSet(
  sc: SupabaseClient,
  userId: string,
): Promise<Set<string> | null> {
  // census-telegraph §94 (T220c): this was ONE range-less `.or()` read, and PostgREST cuts
  // every answer at db-max-rows (1,000 hosted) with NO error, so a user with more block
  // rows than that got a prefix: every block past the cut was simply not excluded. It is
  // now the definition of record's whole-list read, lib/exclusionSet.ts readBlockExclusions:
  // the same `.or()` read first, byte for byte (one round trip under the cap); an answer as
  // long as the cap may have been cut, so it is read again by key, with counts.
  //
  // The contract is unchanged: a Set of every counter-party, or `null` when the list could
  // not be read. `null` now also covers what this read let through as an answer: a cut
  // read; an answer that is not a row list (`data ?? []` read it as "nobody is blocked");
  // a row that does not name both parties (it added `undefined`); a missing client or id.
  try {
    const read = await readBlockExclusions(sc, userId); // never rejects: every failure is `read.ok === false`
    return read.ok ? new Set(read.ids) : null;
  } catch { return null; } // defence in depth, and blockReadCatchGuard's THE READERS rule: a thrown read is null
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
