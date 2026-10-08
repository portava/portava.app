/**
 * Lead ruling D-24c (2026-10-06) for the Discovery ranker and the feed slot
 * allocator: "While a messaging restriction is active, the person's posts get no
 * boost lift. Their stored boost preference is kept, and the lift comes back
 * when the restriction ends. If the restriction state cannot be read, apply no
 * boost: this is fail-closed for reach amplification, and it refuses nothing the
 * person does."
 *
 * The same rule, and the same reads, as lane L's `loadBoostLiftWithheld` in
 * compass/CompassFeedBuilder.ts (PR #643) — kept as a separate module here only
 * because that PR is not on main yet; the lead unifies the two after merge.
 *
 * Returns the authors (of those given) whose lift is withheld. READ-ONLY: nothing
 * is written, so a stored preference or score survives the restriction and the
 * lift returns the moment the restriction ends. Reads go through lane B's seam
 * (`getRestrictionState`, one per author, in parallel; route code must not read
 * `trust_restrictions` directly). Withheld: an active messaging restriction,
 * EITHER degraded shape (fail_closed, or fail_open — whose can-flags read true
 * although nobody read the table), a throw, or no client at all. Callers pass
 * only the authors a boost could actually lift, so nobody else's restriction
 * state is read.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getRestrictionState } from "../trust/TrustRestrictionService.js";

/** At most this many authors are read per call; any author past it is withheld (never lifted unread). */
export const BOOST_LIFT_READ_CAP = 200;

export async function loadBoostLiftWithheld(
  db: SupabaseClient | null | undefined,
  authorIds: Iterable<string>,
): Promise<Set<string>> {
  const unique = [...new Set([...authorIds].filter((id) => typeof id === "string" && id.length > 0))];
  const withheld = new Set<string>();
  if (unique.length === 0) return withheld;
  if (!db) { for (const id of unique) withheld.add(id); return withheld; }
  const read = unique.slice(0, BOOST_LIFT_READ_CAP);
  for (const id of unique.slice(BOOST_LIFT_READ_CAP)) withheld.add(id);
  await Promise.all(read.map(async (id) => {
    try {
      const state = await getRestrictionState(db, id);
      if (state.degraded || !state.canMessage) withheld.add(id);
    } catch {
      withheld.add(id);
    }
  }));
  return withheld;
}
