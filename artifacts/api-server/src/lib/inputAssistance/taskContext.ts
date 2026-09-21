/**
 * §16/§17/§18 Task context — the constraint the main suggestion pipeline never had.
 *
 * WHAT WAS THERE BEFORE. `gateway.applySessionBias` was the whole of carryover:
 * a suggestion whose `entityId` EXACTLY equalled `sessionContext.cityId` was
 * moved to the front. That is a reorder of a candidate that was already
 * returned, not a constraint on which candidates are generated or how they rank,
 * and the gateway's own comment conceded it ("Fuller §16/§17 carryover is
 * deferred"). §18's `filterInfeasibleCandidates` — a real, correct, already
 * mutation-proven implementation in `creation.ts` — had exactly ONE caller, on
 * duplicate candidates in creation contexts. The main pipeline never called it,
 * so none of these ever fired on an ordinary suggestion list:
 *
 *   §18  "before ranking, remove or demote infeasible/inappropriate options"
 *   §18  "outside Trip date/time window"
 *   §18  "outside selected city/area where the field is constrained"
 *   §15  TripFit
 *
 * WHAT THIS ADDS. One read of the ACTIVE TASK — the session's city and Trip —
 * resolved once per request, and a feasibility pass over the candidate
 * `SearchResult`s that runs the SAME `filterInfeasibleCandidates` the creation
 * flow uses. The result is expressed as a per-row DEMOTION, never a deletion,
 * because §18 says "remove or demote" and this layer's evidence (a city string
 * on a row) is not strong enough to justify removal: two venues can share a city
 * name, a row's `locationPreview` can be null, and a user who types the name of
 * a place in another city must still be able to reach it.
 *
 * FAIL-SOFT IS THE WHOLE POSTURE. Every read here returns nulls on any error,
 * and a null constraint is the identity transform: the pipeline behaves exactly
 * as it did before this file existed. A carryover feature that hard-fails a
 * suggestion request would be worse than no carryover.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SearchResult } from '../../routes/discoverySearch';
import { searchKey } from '../canonicalLocations';
import { partitionByFeasibility } from './creation';
import type { SuggestSessionContext } from './types';

/** The active task's bounds, as far as the session context can establish them. */
export interface TaskConstraint {
  /** The session's canonical city id, echoed for the existing exact-match bias. */
  cityId: string | null;
  /**
   * The city the task is scoped to, by NAME — from the session's canonical city
   * row, or failing that from the Trip's destination. Null when the task names
   * no city, which makes every city check below a no-op.
   */
  city: string | null;
  country: string | null;
  tripId: string | null;
  /** The Trip's start date (ISO), when the task is a Trip. */
  windowStart: string | null;
  /**
   * The Trip's end date, pushed to the END of that day. A Trip ending
   * `2026-12-05` includes an event at 19:00 on the 5th; comparing against
   * midnight would call the last evening of the Trip infeasible.
   */
  windowEnd: string | null;
}

export const EMPTY_TASK_CONSTRAINT: TaskConstraint = {
  cityId: null,
  city: null,
  country: null,
  tripId: null,
  windowStart: null,
  windowEnd: null,
};

/** True when the constraint would change nothing — the identity case. */
export function isEmptyConstraint(c: TaskConstraint): boolean {
  return c.city === null && c.windowStart === null && c.windowEnd === null;
}

/** `2026-12-05` → `2026-12-05T23:59:59.999Z`. Anything else is passed through. */
function endOfDay(date: string | null): string | null {
  if (!date) return null;
  const m = /^(\d{4}-\d{2}-\d{2})$/.exec(date.trim());
  if (m) return `${m[1]}T23:59:59.999Z`;
  return date;
}

/**
 * Resolve the active task's city + Trip window from the session context.
 *
 * Bounded: at most two point reads, both by primary key, both fail-soft. Called
 * once per suggest request and only when the session actually carries a task —
 * a request with no `cityId` and no `tripId` issues no query at all.
 */
export async function resolveTaskConstraint(
  db: SupabaseClient,
  sessionContext: SuggestSessionContext | undefined,
): Promise<TaskConstraint> {
  const cityId = sessionContext?.cityId ?? null;
  const tripId = sessionContext?.tripId ?? null;
  if (!cityId && !tripId) return EMPTY_TASK_CONSTRAINT;

  let city: string | null = null;
  let country: string | null = null;
  let windowStart: string | null = null;
  let windowEnd: string | null = null;

  if (cityId) {
    try {
      const { data, error } = await (db as any)
        .from('canonical_locations')
        .select('id, name, display_name, country')
        .eq('id', cityId)
        .maybeSingle();
      if (!error && data) {
        city = ((data.name as string | null) || (data.display_name as string | null)) ?? null;
        country = (data.country as string | null) ?? null;
      }
    } catch {
      /* fail-soft: no city constraint */
    }
  }

  if (tripId) {
    try {
      const { data, error } = await (db as any)
        .from('trips')
        .select('id, destination_city, destination_country, start_date, end_date')
        .eq('id', tripId)
        .maybeSingle();
      if (!error && data) {
        if (!city) city = ((data.destination_city as string | null) ?? null) || null;
        if (!country) country = (data.destination_country as string | null) ?? null;
        windowStart = (data.start_date as string | null) ?? null;
        windowEnd = endOfDay((data.end_date as string | null) ?? null);
      }
    } catch {
      /* fail-soft: no Trip window */
    }
  }

  return { cityId, city, country, tripId, windowStart, windowEnd };
}

/**
 * Search types whose ROW IS a geography. A city row must never be demoted for
 * "being in another city" — it IS the other city, and a city picker inside a
 * Bangkok Trip still has to be able to offer Da Nang.
 */
const GEOGRAPHIC_TYPES: ReadonlySet<string> = new Set(['cities', 'countries']);

/** The city a candidate row sits in, as far as its display projection says. */
function candidateCity(r: SearchResult): string | undefined {
  if (GEOGRAPHIC_TYPES.has(r.type)) return undefined;
  // `locationPreview` is the city (places) or "City, Country" (events); the
  // fold below only compares the leading city token, so both shapes work.
  const raw = r.locationPreview ?? r.subtitle ?? null;
  if (!raw) return undefined;
  return raw.split(',')[0]!.trim() || undefined;
}

export interface FeasibilityVerdict {
  /** Rows the task makes less appropriate. Demoted at projection, never dropped. */
  demotedIds: ReadonlySet<string>;
  /** Rows that sit INSIDE the active Trip's city — the §15 TripFit term. */
  tripFitIds: ReadonlySet<string>;
}

/**
 * Run the §18 feasibility pass over one request's candidate rows.
 *
 * The classification is delegated WHOLE to `filterInfeasibleCandidates` — the
 * same function, with the same semantics, that the creation flow has used since
 * Phase 5. That is deliberate: §18 is one rule, and two implementations of it
 * would drift. What this adds is the second caller the rule never had, plus the
 * mapping from a `SearchResult` to the constraint fields it understands.
 *
 * An empty constraint returns two empty sets, so the caller's projection is
 * byte-identical to its pre-constraint output.
 */
export function classifyFeasibility(
  results: readonly SearchResult[],
  constraint: TaskConstraint,
): FeasibilityVerdict {
  if (results.length === 0 || isEmptyConstraint(constraint)) {
    return { demotedIds: new Set<string>(), tripFitIds: new Set<string>() };
  }

  const { demoted, removed } = partitionByFeasibility(
    results.map((r) => ({
      item: r,
      city: candidateCity(r),
      startsAt: r.startsAt ?? undefined,
    })),
    {
      city: constraint.city ?? undefined,
      windowStart: constraint.windowStart ?? undefined,
      windowEnd: constraint.windowEnd ?? undefined,
    },
  );

  // Both buckets DEMOTE here. `removed` is the hard-infeasible bucket the
  // creation flow drops; this pipeline's evidence (a city string on a projected
  // row) is weaker than the creation flow's, and the privacy gate has already
  // decided what the viewer may see, so a suggestion is pushed down rather than
  // deleted. §18 permits either; the weaker evidence chooses the weaker action.
  const demotedIds = new Set<string>();
  for (const c of demoted) demotedIds.add((c.item as SearchResult).id);
  for (const c of removed) demotedIds.add((c.item as SearchResult).id);

  // §15 TripFit — only meaningful when the active task IS a Trip.
  const tripFitIds = new Set<string>();
  if (constraint.tripId && constraint.city) {
    const ck = searchKey(constraint.city);
    for (const r of results) {
      const rc = candidateCity(r);
      if (rc && searchKey(rc) === ck) tripFitIds.add(r.id);
    }
  }

  return { demotedIds, tripFitIds };
}
