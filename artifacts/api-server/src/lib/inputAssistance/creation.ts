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
  scanDuplicateGems,
  scanDuplicatePlaces,
  scanDuplicateEvents,
  type DuplicateMatch, type DuplicateScan,
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
  const { feasible, demoted } = partitionByFeasibility(candidates, constraint);
  return [...feasible, ...demoted];
}

/**
 * The §18 classification itself, as a three-way PARTITION.
 *
 * `filterInfeasibleCandidates` above is this function plus a concatenation, and
 * is kept verbatim for its existing caller. The partition exists because the
 * MAIN suggestion pipeline needs the verdict, not the order: it demotes by
 * lowering a row's confidence (the secondary sort key) rather than by moving it,
 * since the gateway re-ranks everything by §9 type order afterwards and a mere
 * reordering would not survive that. Both callers therefore run the SAME rule —
 * §18 is one rule, and two implementations of it would drift.
 */
export function partitionByFeasibility<T>(
  candidates: ConstraintCandidate<T>[],
  constraint: FeasibilityConstraint = {},
): { feasible: ConstraintCandidate<T>[]; demoted: ConstraintCandidate<T>[]; removed: ConstraintCandidate<T>[] } {
  const cityKey = foldCity(constraint.city);
  const wStart = parseMs(constraint.windowStart);
  const wEnd = parseMs(constraint.windowEnd);

  const feasible: ConstraintCandidate<T>[] = [];
  const demoted: ConstraintCandidate<T>[] = [];
  const removed: ConstraintCandidate<T>[] = [];

  for (const c of candidates) {
    // HARD infeasible → removed entirely.
    if (c.blocked === true || c.sensitiveExact === true) { removed.push(c); continue; }

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
  return { feasible, demoted, removed };
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
    // D11 last mile. These three reads go through `scanDuplicate*`, not the
    // fail-soft `findDuplicate*` adapters, because THIS is the caller the
    // swallowed-read ruling is about: it turns matches into `disambiguation`
    // rows, and NO rows is read by a traveller as "nothing like this exists
    // yet". Each unreadable pool is collected here and stated below; the
    // fail-closed direction is unchanged (an unreadable pool still proposes
    // nothing, and nothing is blocked or auto-merged).
    const unreadable: string[] = [];
    const take = (scan: DuplicateScan, entityType: EntityType): void => {
      if (scan.ok) {
        for (const m of scan.matches) tagged.push({ match: m, entityType });
      } else if (!unreadable.includes(scan.table)) {
        unreadable.push(scan.table);
      }
    };

    const gemNameSrc = GEM_NAME_FROM[context];
    if (gemNameSrc) {
      const gemName = gemNameSrc === 'text' ? typed : (draft.name ?? '').trim();
      if (gemName.length >= 2) {
        take(
          await scanDuplicateGems(
            sc, { name: gemName, city, country, category, lat: dlat, lng: dlng }, { max },
          ).catch(() => poolUnreadable('hidden_gems')),
          'hidden_gem',
        );
      }
    }

    if (PLACE_NAME_CONTEXTS.has(context) && typed.length >= 2) {
      take(
        await scanDuplicatePlaces(
          sc, { name: typed, city, country, category, lat: dlat, lng: dlng }, { max },
        ).catch(() => poolUnreadable('places')),
        'place',
      );
    }

    if (EVENT_NAME_CONTEXTS.has(context) && typed.length >= 2) {
      take(
        await scanDuplicateEvents(
          sc, { name: typed, city, country, startsAt: draft.startDate }, { max },
        ).catch(() => poolUnreadable('events')),
        'event',
      );
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

    // D11: an absent duplicate row now has two causes, and only this says which.
    // Policy-gated like every other row in this file (§6) — see
    // DUPLICATE_SCAN_UNREADABLE_POLICY_GAP at the foot of this file for the two
    // contexts that allow `disambiguation` but not `validation`.
    if (unreadable.length > 0 && allows(policy, 'validation')) {
      out.push(projectDuplicateScanUnreadable(context, policyVersion, unreadable));
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
      () => windowsUnreadable('trips'),
    );
    if (!existing.ok) {
      // "No conflict" is a claim about the traveller's OTHER trips. Unreadable
      // windows cannot support it, so it is withdrawn rather than asserted. Not
      // a block: the dates are still submittable (§23 user stays in control).
      out.push(projectTripWindowsUnreadable(context, policyVersion, existing.table));
    } else {
      const verdict = checkTripDateConflict(
        { startDate: draft.startDate, endDate: draft.endDate },
        existing.windows,
      );
      if (!verdict.ok) out.push(projectTripDateConflict(context, policyVersion, verdict));
    }
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
): Promise<TripWindowScan> {
  // SAME defect class as the three duplicate pools above, found in this file
  // while closing them, and NOT in the swallowed-read inventory (that
  // measurement walks nine directories and admits it under-counts).
  //
  // Both reads answered a failure with the `[]` that means "this traveller has
  // no other trip". `checkTripDateConflict` against `[]` returns `{ ok: true }`,
  // buildCreationAssistance then emits NO row, and a field that emits no
  // date-conflict row is read as "your dates are clear" — a POSITIVE claim,
  // made out of a read that never ran, about the one thing the traveller asked.
  //
  // `trip_members` returning zero ROWS is different and is left as an answer:
  // a traveller who is on no trip genuinely has no window to clash with.
  try {
    const { data: memberRows, error: memErr } = await sc
      .from('trip_members')
      .select('trip_id, role')
      .eq('user_id', userId)
      .neq('role', 'invited');
    if (memErr || !memberRows) return windowsUnreadable('trip_members');
    if (memberRows.length === 0) return { ok: true, windows: [] };
    const tripIds = (memberRows as Array<{ trip_id: string }>)
      .map((r) => r.trip_id)
      .filter((id) => id !== excludeTripId);
    if (tripIds.length === 0) return { ok: true, windows: [] };

    const { data: trips, error: tErr } = await sc
      .from('trips')
      .select('id, title, start_date, end_date, status')
      .in('id', tripIds)
      .in('status', ['active', 'upcoming', 'planning'])
      .limit(50);
    if (tErr || !trips) return windowsUnreadable('trips');
    return {
      ok: true,
      windows: (trips as any[]).map((t) => ({
        id: t.id as string,
        title: (t.title as string | null) ?? null,
        startDate: (t.start_date as string | null) ?? null,
        endDate: (t.end_date as string | null) ?? null,
      })),
    };
  } catch {
    return windowsUnreadable('trips');
  }
}

// ── D11 last mile: an unreadable candidate pool is not "nothing like this" ────
//
// docs/architecture/swallowed-read-inventory.md rules one question per site —
// may the caller act on this emptiness as if it were an answer? For the three
// duplicate-candidate reads the answer was NO, and the fix landed in
// `duplicateDetection.ts` as `scanDuplicate{Gems,Places,Events}`: the honest
// entry points that separate "the pool could not be read" from "the pool is
// empty". `buildCreationAssistance` is the caller that ruling names, and until
// now it consumed the fail-soft `findDuplicate*` adapters, which collapse both
// back into the same `[]`. It now consumes the scans.
//
// Declared at the FOOT of the file, below every doc-cited line, in the same way
// MediaViewRequestService declares `ViewRequestRecipientDetermination`.

/** The `DuplicateScan` shape for a scan that threw rather than resolved. */
function poolUnreadable(table: string): DuplicateScan {
  return { ok: false, reason: 'candidate_pool_unreadable', table };
}

/**
 * KNOWN GAP, stated rather than worked around.
 *
 * This row is a `validation` row, and §6 is absolute in this file: a context
 * only ever emits what its policy permits. Five of the seven contexts that
 * allow `disambiguation` also allow `validation` (`hidden_gem_name`,
 * `hidden_gem_location`, `place_picker`, `event_location`, `address`) and are
 * therefore told. TWO are not:
 *
 *   • `trip_stop_place`  — ['entity', 'recent', 'disambiguation']
 *   • `event_title`      — ['ai_suggestion', 'disambiguation', 'correction']
 *
 * For those two an unreadable pool is still silent. Widening their policy is a
 * change to the §6 policy registry — a different surface, with other consumers
 * of the `validation` flag (`gateway.ts` unresolved-address and hashtag rows) —
 * and is not something a duplicate-detection fix may decide on its own. The
 * fail-closed direction is identical in all seven; the difference is only
 * whether the traveller is told.
 */
export const DUPLICATE_SCAN_UNREADABLE_POLICY_GAP = ['trip_stop_place', 'event_title'] as const;

/**
 * Say that the duplicate check did not run (§10 "appropriate to field context"),
 * using the convention `socialIdentity.buildRecipientsUnreadable` already set
 * for exactly this class: a NON-BLOCKING `validation` row, MEDIUM-low
 * confidence, carrying a structured status the client can branch on.
 *
 * It asserts nothing about what exists — it withdraws the claim that nothing
 * does. Creation is never blocked (§20/§23/§37); the traveller may still submit.
 */
export function projectDuplicateScanUnreadable(
  context: InputContext,
  policyVersion: string,
  tables: readonly string[],
): InputSuggestion {
  const value = {
    kind: 'duplicate_check_status',
    available: false,
    reason: 'candidate_pool_unreadable',
    tables: [...tables],
  };
  return {
    id: `${context}:validation:duplicates`,
    type: 'validation',
    context,
    label: 'We could not check whether this already exists — it still might.',
    subtitle: 'Existing entries could not be checked just now.',
    action: { type: 'set_structured_value', value },
    structuredValue: value,
    confidence: 0.2,
    source: 'local',
    reason: 'candidate_pool_unreadable',
    policyVersion,
  };
}

// ── Same class, second site: the viewer's own trip windows ───────────────────
//
// Found in this file while closing the three duplicate pools. `checkTripDateConflict`
// is only as honest as the window list it is given, and an unreadable list
// produced the same `[]` as "you are on no other trip" — which the §23 validator
// turns into the positive verdict `{ ok: true }`, i.e. "your dates are clear".

export type TripWindowScan =
  | { ok: true; windows: ExistingTripWindow[] }
  | { ok: false; reason: 'trip_windows_unreadable'; table: string };

function windowsUnreadable(table: string): TripWindowScan {
  return { ok: false, reason: 'trip_windows_unreadable', table };
}

/**
 * Say that the date-conflict check did not run. Same convention as
 * `projectDuplicateScanUnreadable` and `socialIdentity.buildRecipientsUnreadable`:
 * a NON-BLOCKING `validation` row that withdraws a claim rather than making one.
 *
 * Both trip-date contexts (`trip_title`, `trip_destination`) allow `validation`,
 * so unlike the duplicate row this one has no policy gap.
 */
export function projectTripWindowsUnreadable(
  context: InputContext,
  policyVersion: string,
  table: string,
): InputSuggestion {
  const value = {
    kind: 'trip_date_conflict_status',
    available: false,
    reason: 'trip_windows_unreadable',
    table,
  };
  return {
    id: `${context}:validation:trip-dates-unreadable`,
    type: 'validation',
    context,
    label: 'We could not check these dates against your other trips.',
    subtitle: 'Your other trips could not be read just now.',
    action: { type: 'set_structured_value', value },
    structuredValue: value,
    confidence: 0.2,
    source: 'local',
    reason: 'trip_windows_unreadable',
    policyVersion,
  };
}
