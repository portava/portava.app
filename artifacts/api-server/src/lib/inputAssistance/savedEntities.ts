/**
 * §35 Saved entities — the half of "Saved and Trip-related entities" that read
 * nothing (census-input-intelligence §4, row G228; §14 rows G86/G89).
 *
 * WHAT WAS MISSING
 * ----------------
 * §35 asks selection memory to draw on "Saved and Trip-related entities". The
 * Trip half was served: `geoResolver.zeroCharGeoDefaults` reads the viewer's
 * active/upcoming Trip destinations into the §14 zero-character list. The SAVED
 * half was served by nothing — no saved, bookmarked or wishlisted source was
 * read anywhere in `lib/inputAssistance/`, so a user who had explicitly saved a
 * place got no acknowledgement of it in any picker.
 *
 * WHY THIS SOURCE, AND WHY IT IS NOT input_selection_history
 * ---------------------------------------------------------
 * `input_selection_history` (migration 2258) is **not applied to production**
 * (`scripts/checkProductionDrift.ts`, entry `input_selection_history`), so every
 * §35 path built on it fails soft to an empty memory there. `discovery_place_saves`
 * is a table production HAS. A SAVE is also a stronger §35 signal than a pick:
 * it is an explicit, durable, user-initiated act — never a view, a dwell or an
 * inferred fact — which is exactly the boundary §35 draws.
 *
 * THE FOUR GATES, ALL FAIL-CLOSED
 * -------------------------------
 *   1. `policy.allowPersonalization` — username / private-message / hidden-gem
 *      contexts never reach this, the same gate the selection-memory read uses.
 *   2. `policy.entityTypes` must list `place` — a field that may not surface a
 *      place does not get one because the user saved it. This is what keeps
 *      `city_picker` (`['city','country']`) out without naming it.
 *   3. `policy.allowedSuggestionTypes` must list `recent`.
 *   4. The §7/§47 BLOCK FUNNEL. `discovery_places` rows carry a `submitted_by`
 *      whose blurb and photo ride along with the venue, so every reader of that
 *      table filters on `lib/blocks.submitterIsVisible`. An unreadable block
 *      list returns NOTHING — `fetchBlockedSet` null means "show nobody", never
 *      "no blocks". `routes/discoverySearch.ts:1135-1148` states this contract
 *      for the two serve points that already learned it the hard way; this is a
 *      THIRD reader of the same table and it joins the funnel rather than
 *      becoming the next surface that silently skipped it.
 *
 * It reads only the VIEWER'S OWN save rows (`.eq('user_id', userId)`) against
 * PUBLIC, `status = 'active'` canonical places, so it surfaces nothing the
 * viewer could not already see and no other person's behaviour. It never writes.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchBlockedSet, submitterIsVisible } from '../blocks.js';
import type { InputContext, InputFieldPolicy, InputSuggestion } from './types';

/**
 * Confidence for a saved-place row. Below `buildSelectionRecents`' 0.75 (a
 * just-picked entity is the more immediate intent) and far below the
 * exact-match band, so a saved row reorders WITHIN the zero-character list and
 * can never outrank a canonical typed match.
 */
export const SAVED_PLACE_CONFIDENCE = 0.7;

/** How many save rows are read before the visibility filter. A bounded fan-out. */
export const SAVED_READ_MULTIPLIER = 4;

interface SavedRow {
  place_id: string | null;
  saved_at: string | null;
}

interface PlaceRow {
  id: string;
  name: string | null;
  city: string | null;
  primary_category: string | null;
  category: string | null;
  submitted_by: string | null;
}

/**
 * The viewer's explicitly SAVED canonical places, newest save first, projected
 * as §14 zero-character `recent` suggestions.
 *
 * Bounded and fail-soft: any read failure yields an empty list and the caller
 * behaves exactly as it did before this source existed. Returns `[]` — never a
 * partially-filtered list — when the block set cannot be read.
 *
 * MUTATION-PROOF: return `[]` unconditionally and the "a saved place is offered
 * before the first keystroke" assertion goes RED; drop the `submitterIsVisible`
 * filter and the blocked-submitter assertion goes RED.
 */
export async function buildSavedPlaceSuggestions(
  db: SupabaseClient,
  opts: {
    userId: string;
    context: InputContext;
    policy: InputFieldPolicy;
    policyVersion: string;
    max: number;
    existingEntityIds?: ReadonlySet<string>;
  },
): Promise<InputSuggestion[]> {
  if (!opts.userId) return [];
  if (opts.policy.allowPersonalization !== true) return [];
  if (!(opts.policy.entityTypes ?? []).includes('place')) return [];
  if (!opts.policy.allowedSuggestionTypes.includes('recent')) return [];
  const max = Math.max(0, opts.max);
  if (max === 0) return [];

  const existing = opts.existingEntityIds ?? new Set<string>();

  try {
    const { data: saveData, error: saveErr } = await db
      .from('discovery_place_saves')
      .select('place_id, saved_at')
      .eq('user_id', opts.userId)
      .order('saved_at', { ascending: false })
      .limit(max * SAVED_READ_MULTIPLIER);
    if (saveErr) return [];

    // Newest save first, resolved HERE rather than trusted from the query, so
    // the order is a property of this function and not of the driver.
    const saves = ((saveData ?? []) as SavedRow[])
      .filter((s) => typeof s.place_id === 'string' && s.place_id.length > 0)
      .filter((s) => !existing.has(s.place_id as string))
      .sort((a, b) => String(b.saved_at ?? '').localeCompare(String(a.saved_at ?? '')));
    if (saves.length === 0) return [];

    const ids: string[] = [];
    for (const s of saves) {
      const id = s.place_id as string;
      if (!ids.includes(id)) ids.push(id);
      if (ids.length >= max * SAVED_READ_MULTIPLIER) break;
    }

    // The block funnel. Read BEFORE the places, so an unreadable block list
    // costs one query and serves nothing (fail-closed, per lib/blocks).
    const blocked = await fetchBlockedSet(db, opts.userId);
    if (blocked === null) return [];

    const { data: placeData, error: placeErr } = await db
      .from('discovery_places')
      .select('id, name, city, primary_category, category, submitted_by')
      .in('id', ids)
      .eq('status', 'active');
    if (placeErr) return [];

    const byId = new Map<string, PlaceRow>();
    for (const p of ((placeData ?? []) as PlaceRow[])) {
      if (!submitterIsVisible(p.submitted_by, blocked)) continue;
      if (typeof p.id === 'string') byId.set(p.id, p);
    }

    const out: InputSuggestion[] = [];
    for (const id of ids) {
      if (out.length >= max) break;
      const row = byId.get(id);
      // A save whose place is gone or withheld is DROPPED, never rendered from
      // the save row alone — §2: no suggestion is fabricated from a stale id.
      if (!row) continue;
      const label = (row.name ?? '').trim();
      if (!label) continue;
      out.push(projectSavedPlace(row, label, opts.context, opts.policyVersion));
    }
    return out;
  } catch {
    return [];
  }
}

/** Project one saved canonical place as a §14 zero-character `recent` row. */
function projectSavedPlace(
  row: PlaceRow,
  label: string,
  context: InputContext,
  policyVersion: string,
): InputSuggestion {
  const subtitle = [row.city, row.primary_category ?? row.category].filter(Boolean).join(' · ') || null;
  const suggestion: InputSuggestion = {
    id: `${context}:saved:place:${row.id}`,
    type: 'recent',
    context,
    label,
    entityType: 'place',
    entityId: row.id,
    action: { type: 'open_entity', entityType: 'place', entityId: row.id },
    confidence: SAVED_PLACE_CONFIDENCE,
    source: 'memory',
    reason: 'Saved',
    destination: { route: `/place/${row.id}`, entityType: 'place', entityId: row.id },
    canonicalUri: `portava:/place/${row.id}`,
    policyVersion,
  };
  if (subtitle) suggestion.subtitle = subtitle;
  return suggestion;
}
