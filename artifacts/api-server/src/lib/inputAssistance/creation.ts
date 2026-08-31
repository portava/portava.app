/**
 * Creation assistance orchestrator (Phase 5 — Creation, spec §20/§23/§36/§55).
 *
 * For the CREATION contexts (Gem / Place / Event / Trip / Plan fields) this
 * composes, THROUGH the Phase-1 gateway:
 *   1. Duplicate detection (§20/§55) — surface likely-existing canonical records
 *      as `disambiguation` rows so creation resolves an existing entity first,
 *      instead of minting a duplicate. (lib/inputAssistance/duplicateDetection.)
 *   2. The §23 validation suite — city-country mismatch (`correction`), trip date
 *      conflict (`validation`), unresolved-address fallbacks (`action`/`validation`).
 *   3. Constraint-aware filtering (§20) — before ranking, REMOVE hard-infeasible
 *      candidates (blocked/ineligible, sensitive-exact protected locations) and
 *      DEMOTE soft-infeasible ones (outside the constrained city / Trip window).
 *
 * HARD RULE (§20/§23/§37): nothing here BLOCKS creation or auto-merges. Every row
 * only proposes; the flow (or user) decides. Fallback actions are
 * context-dependent — a city picker never offers "create/drop pin", a Gem/location
 * flow may. That is expressed by gating each row on the field POLICY's allowed
 * assistance types (§6): a context only ever emits what its policy permits.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { searchKey } from '../canonicalLocations';
import {
  findDuplicateGems,
  findDuplicatePlaces,
  findDuplicateEvents,
  type DuplicateMatch,
} from './duplicateDetection';
import {
  checkCityCountryMismatch,
  checkTripDateConflict,
  projectCityCountryCorrection,
  projectTripDateConflict,
  buildAddressFallbacks,
  type ExistingTripWindow,
} from './validationSuite';
import type {
  InputContext,
  InputFieldPolicy,
  InputSuggestion,
  EntityType,
  SuggestSessionContext,
  CreationDraft,
} from './types';

export type { CreationDraft };

// ── Creation context classification ────────────────────────────────────────────

/** Every context that participates in Phase-5 creation assistance. */
export const CREATION_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'hidden_gem_name',
  'hidden_gem_location',
  'event_title',
  'event_location',
  'place_picker',
  'trip_stop_place',
  'trip_title',
  'trip_destination',
  'address',
  'plan_title',
]);

export function isCreationContext(context: InputContext): boolean {
  return CREATION_CONTEXTS.has(context);
}

/** The creation contexts (as an array), for registry/introspection callers. */
export function getCreationDraftContexts(): InputContext[] {
  return [...CREATION_CONTEXTS];
}

// Which duplicate finders run for each context, and where the entity NAME comes
// from. `text` = the typed field value; `draftName` = draft.name (used when the
// typed field is a LOCATION rather than the entity's own name).
const GEM_NAME_FROM: Partial<Record<InputContext, 'text' | 'draftName'>> = {
  hidden_gem_name: 'text',
  hidden_gem_location: 'draftName',
  trip_stop_place: 'text',
};
const PLACE_NAME_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'hidden_gem_location',
  'event_location',
  'place_picker',
  'trip_stop_place',
  'address',
]);
const EVENT_NAME_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>(['event_title']);
const TRIP_DATE_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'trip_title',
  'trip_destination',
]);
const CITY_COUNTRY_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'hidden_gem_name',
  'hidden_gem_location',
  'event_title',
  'event_location',
]);
// Location fields where an unresolved address may offer §37 fallbacks.
const ADDRESS_FALLBACK_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'hidden_gem_location',
  'event_location',
  'place_picker',
  'address',
]);

// ── §20 constraint-aware filtering (pure, tested directly) ─────────────────────

export interface ConstraintCandidate<T> {
  item: T;
  city?: string | null;
  /** ISO start time, for Trip-window feasibility. */
  startsAt?: string | null;
  /** Hard-infeasible: blocked / private / ineligible for the viewer. */
  blocked?: boolean;
  /** Hard-infeasible: a protected location whose exact position cannot surface. */
  sensitiveExact?: boolean;
}

export interface FeasibilityConstraint {
  /** The field is constrained to this city (fold-compared). */
  city?: string | null;
  /** Trip date window (ISO); a candidate starting outside it is demoted. */
  windowStart?: string | null;
  windowEnd?: string | null;
}

function foldCity(s: string | null | undefined): string {
  // Reuse the canonical stroke/diacritic/case fold so "Đà Nẵng" === "da nang".
  return searchKey(s ?? '');
}

function parseMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s.length <= 10 ? `${s}T00:00:00Z` : s);
  return Number.isFinite(t) ? t : null;
}

/**
 * §20: remove infeasible candidates and demote inappropriate ones BEFORE ranking.
 *
 *   HARD (removed):  blocked/ineligible, or a sensitive-exact protected location.
 *   SOFT (demoted):  outside the constrained city, or outside the Trip window.
 *
 * Stable, feasible-first ordering. PURE — proven directly (mutation: dropping the
 * demotion makes the out-of-window / out-of-city candidate keep its lead slot).
 */
export function filterInfeasibleCandidates<T>(
  candidates: ConstraintCandidate<T>[],
  constraint: FeasibilityConstraint = {},
): ConstraintCandidate<T>[] {
  const cityKey = foldCity(constraint.city);
  const wStart = parseMs(constraint.windowStart);
  const wEnd = parseMs(constraint.windowEnd);

  const feasible: ConstraintCandidate<T>[] = [];
  const demoted: ConstraintCandidate<T>[] = [];

  for (const c of candidates) {
    // HARD infeasible → removed entirely.
    if (c.blocked === true || c.sensitiveExact === true) continue;

    let soft = false;
    // Outside the constrained city.
    if (cityKey) {
      const ck = foldCity(c.city);
      if (ck && ck !== cityKey) soft = true;
    }
    // Outside the Trip window.
    if (!soft && (wStart != null || wEnd != null)) {
      const at = parseMs(c.startsAt);
      if (at != null) {
        if (wStart != null && at < wStart) soft = true;
        if (wEnd != null && at > wEnd) soft = true;
      }
    }
    (soft ? demoted : feasible).push(c);
  }
  return [...feasible, ...demoted];
}

// ── Duplicate → disambiguation projection ──────────────────────────────────────

/**
 * Project a duplicate match as a `disambiguation` row: "Did you mean this
 * existing Gem/Place/Event?" It resolves to the EXISTING entity (open_entity) and
 * carries a `resolve_existing` structured value so the creation flow can adopt the
 * canonical record instead of creating a new one (§20/§55). Confidence is capped
 * in the MEDIUM band so the client never auto-replaces on it (§19).
 */
export function projectDuplicate(
  match: DuplicateMatch,
  entityType: EntityType,
  context: InputContext,
  policyVersion: string,
): InputSuggestion {
  const routeBase =
    entityType === 'hidden_gem' ? '/hidden-gem/' : entityType === 'event' ? '/event/' : '/place/';
  return {
    id: `${context}:dup:${entityType}:${match.entity.id}`,
    type: 'disambiguation',
    context,
    label: `Did you mean ${match.entity.name}?`,
    subtitle: match.reason,
    entityType,
    entityId: match.entity.id,
    action: { type: 'open_entity', entityType, entityId: match.entity.id },
    structuredValue: { kind: 'resolve_existing', entityType, entityId: match.entity.id },
    // Cap in the MEDIUM band (§19): a ranked choice, never an auto-replace.
    confidence: Math.min(0.75, match.score),
    source: 'canonical',
    reason: match.reason,
    destination: { route: `${routeBase}${match.entity.id}`, entityType, entityId: match.entity.id },
    policyVersion,
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────────

export interface CreationParams {
  context: InputContext;
  policy: InputFieldPolicy;
  text: string;
  userId: string;
  draft: CreationDraft;
  /** Viewer's current city (falls back for the field city when the draft omits it). */
  viewerCity: string | null;
  lat: number | null;
  lng: number | null;
  sessionContext?: SuggestSessionContext;
  policyVersion: string;
  max: number;
}

function allows(policy: InputFieldPolicy, ...types: string[]): boolean {
  return types.some((t) => policy.allowedSuggestionTypes.includes(t as any));
}

/**
 * Build the creation-time duplicate + validation rows for a creation context.
 * Each feature is gated on the field POLICY (§6) so a context never emits an
 * assistance type it does not allow.
 */
export async function buildCreationAssistance(
  sc: SupabaseClient,
  p: CreationParams,
): Promise<InputSuggestion[]> {
  const { context, policy, text, userId, draft, viewerCity, lat, lng, sessionContext, policyVersion, max } = p;
  const out: InputSuggestion[] = [];

  const typed = (text ?? '').trim();
  const city = (draft.city ?? viewerCity ?? null);
  const country = draft.country ?? null;
  const dlat = draft.lat ?? lat ?? null;
  const dlng = draft.lng ?? lng ?? null;
  const category = draft.category ?? null;

  // ── 1. Duplicate detection (§20/§55) → disambiguation ─────────────────────────
  if (allows(policy, 'disambiguation')) {
    const tagged: Array<{ match: DuplicateMatch; entityType: EntityType }> = [];

    const gemNameSrc = GEM_NAME_FROM[context];
    if (gemNameSrc) {
      const gemName = gemNameSrc === 'text' ? typed : (draft.name ?? '').trim();
      if (gemName.length >= 2) {
        const gems = await findDuplicateGems(
          sc, { name: gemName, city, country, category, lat: dlat, lng: dlng }, { max },
        ).catch(() => [] as DuplicateMatch[]);
        for (const m of gems) tagged.push({ match: m, entityType: 'hidden_gem' });
      }
    }

    if (PLACE_NAME_CONTEXTS.has(context) && typed.length >= 2) {
      const places = await findDuplicatePlaces(
        sc, { name: typed, city, country, category, lat: dlat, lng: dlng }, { max },
      ).catch(() => [] as DuplicateMatch[]);
      for (const m of places) tagged.push({ match: m, entityType: 'place' });
    }

    if (EVENT_NAME_CONTEXTS.has(context) && typed.length >= 2) {
      const events = await findDuplicateEvents(
        sc, { name: typed, city, country, startsAt: draft.startDate }, { max },
      ).catch(() => [] as DuplicateMatch[]);
      for (const m of events) tagged.push({ match: m, entityType: 'event' });
    }

    // §20 constraint-aware: demote out-of-city duplicates (resolve the in-city
    // record first), remove sensitive-exact ones. Feasible-first, then capped.
    const constrained = filterInfeasibleCandidates(
      tagged.map((t) => ({ item: t, city: t.match.entity.city })),
      { city },
    );
    for (const c of constrained.slice(0, max)) {
      out.push(projectDuplicate(c.item.match, c.item.entityType, context, policyVersion));
    }
  }

  // ── 2. City-country mismatch (§23) → correction ───────────────────────────────
  if (allows(policy, 'correction') && CITY_COUNTRY_CONTEXTS.has(context) && city && country) {
    const verdict = checkCityCountryMismatch({ city, country });
    if (!verdict.ok) out.push(projectCityCountryCorrection(context, policyVersion, verdict, city));
  }

  // ── 3. Trip date conflict (§23) → validation ──────────────────────────────────
  if (
    allows(policy, 'validation') &&
    TRIP_DATE_CONTEXTS.has(context) &&
    (draft.startDate || draft.endDate)
  ) {
    const existing = await fetchViewerTripWindows(sc, userId, sessionContext?.tripId).catch(
      () => [] as ExistingTripWindow[],
    );
    const verdict = checkTripDateConflict(
      { startDate: draft.startDate, endDate: draft.endDate },
      existing,
    );
    if (!verdict.ok) out.push(projectTripDateConflict(context, policyVersion, verdict));
  }

  return out;
}

/**
 * §23 unresolved-address fallbacks — called by the gateway ONLY when a creation
 * location field produced no canonical candidate. Fallbacks are context-gated by
 * policy (§37): drop-pin/nearby are `action` rows, "use as typed" is a
 * `validation` row. A canonical city picker (no `action`/`validation`) yields
 * none, honoring "a city picker should not offer create/drop pin".
 */
export function buildUnresolvedAddress(
  context: InputContext,
  policy: InputFieldPolicy,
  policyVersion: string,
  text: string,
): InputSuggestion[] {
  if (!ADDRESS_FALLBACK_CONTEXTS.has(context)) return [];
  const canAction = policy.allowedSuggestionTypes.includes('action');
  const canValidate = policy.allowedSuggestionTypes.includes('validation');
  if (!canAction && !canValidate) return [];
  return buildAddressFallbacks(context, policyVersion, text, {
    dropPin: canAction,
    searchNearby: canAction,
    useRaw: canValidate,
  });
}

// ── Viewer's own trip windows (for §23 date-overlap) ───────────────────────────

/**
 * The viewer's OWN active/upcoming trip windows, excluding the trip currently
 * being edited. Read-only, fail-soft to []. Sourced from the viewer's own rows,
 * so no cross-tenant exposure.
 */
export async function fetchViewerTripWindows(
  sc: SupabaseClient,
  userId: string,
  excludeTripId?: string,
): Promise<ExistingTripWindow[]> {
  try {
    const { data: memberRows, error: memErr } = await sc
      .from('trip_members')
      .select('trip_id, role')
      .eq('user_id', userId)
      .neq('role', 'invited');
    if (memErr || !memberRows || memberRows.length === 0) return [];
    const tripIds = (memberRows as Array<{ trip_id: string }>)
      .map((r) => r.trip_id)
      .filter((id) => id !== excludeTripId);
    if (tripIds.length === 0) return [];

    const { data: trips, error: tErr } = await sc
      .from('trips')
      .select('id, title, start_date, end_date, status')
      .in('id', tripIds)
      .in('status', ['active', 'upcoming', 'planning'])
      .limit(50);
    if (tErr || !trips) return [];
    return (trips as any[]).map((t) => ({
      id: t.id as string,
      title: (t.title as string | null) ?? null,
      startDate: (t.start_date as string | null) ?? null,
      endDate: (t.end_date as string | null) ?? null,
    }));
  } catch {
    return [];
  }
}
