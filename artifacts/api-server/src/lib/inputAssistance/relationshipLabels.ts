/**
 * §20 "Current Trip or Saved relationship" on a TYPED answer — census G179.
 *
 * WHAT WAS THERE. "Current Trip" / "Upcoming Trip" / "Saved" appeared only as the
 * `reason` of zero-character rows. A typed row inside the active Trip's city was
 * identified (`verdict.tripFitIds`) but used only as a ranking term, so it ranked
 * higher and said nothing — and a Trip's CITY is not the Trip: a café in Bangkok
 * is not "in your Trip" because the Trip goes to Bangkok. A place the viewer had
 * saved said nothing either: no `EntityType` reaches the saved lane (G220).
 *
 * WHAT THIS IS. After the answer is ranked and capped, each PLACE row in it gets
 * a closed-vocabulary `relationship`:
 *   - `'in_trip'` when the place is on one of the viewer's live Trips' plans,
 *     read from the plan items themselves (`zeroStatePlaces.ts#viewerTripPlaceIds`,
 *     the same Trips and OD-TRIP-3 visibility as the zero-state Trip places);
 *   - otherwise `'saved'` when the viewer saved it (`savedEntities.ts#viewerSavedPlaceIds`).
 * One label per row; the Trip is the stronger claim, so it wins.
 *
 * THE RULES.
 *   - It labels, it never adds, removes or reorders a row: both reads are
 *     bounded to the ids already in the answer.
 *   - Viewer-scoped: only the viewer's own Trips and saves are read, so a label
 *     says something about the viewer, never about another person.
 *   - Only for a field whose policy allows personalization — the same gate the
 *     zero-state Trip/saved arms use — so the Hidden Gem and identity fields
 *     never read either table.
 *   - Fail closed: a read that fails labels nothing (no claim is made from an
 *     unknown); the answer is otherwise unchanged.
 *   - Typed answers only: the zero-state arms return before this runs, and their
 *     rows already say why they are there (`reason`).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { viewerTripPlaceIds } from './zeroStatePlaces';
import { viewerSavedPlaceIds } from './savedEntities';
import type { InputFieldPolicy, InputSuggestion } from './types';

export type SuggestionRelationship = 'in_trip' | 'saved';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function labelable(s: InputSuggestion): s is InputSuggestion & { entityId: string } {
  return s.entityType === 'place' && typeof s.entityId === 'string' && UUID.test(s.entityId);
}

export async function annotateRelationships(
  db: SupabaseClient,
  rows: InputSuggestion[],
  opts: { userId: string; policy: InputFieldPolicy },
): Promise<InputSuggestion[]> {
  if (!opts.userId || opts.policy.allowPersonalization !== true) return rows;
  const ids = [...new Set(rows.filter(labelable).map((s) => s.entityId))];
  if (ids.length === 0) return rows;
  const [onTrip, saved] = await Promise.all([
    viewerTripPlaceIds(db, opts.userId, ids).catch(() => null),
    viewerSavedPlaceIds(db, opts.userId, ids).catch(() => null),
  ]);
  return rows.map((s) => {
    if (!labelable(s)) return s;
    if (onTrip?.has(s.entityId)) return { ...s, relationship: 'in_trip' as const };
    if (saved?.has(s.entityId)) return { ...s, relationship: 'saved' as const };
    return s;
  });
}
