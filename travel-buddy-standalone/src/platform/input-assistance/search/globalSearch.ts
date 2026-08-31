/**
 * Global Input Intelligence — Phase 3 (Global Search): the gateway ⇄ search-row bridge.
 *
 * The existing global search bar (`app/search.tsx` + `SearchSuggestionsPanel` +
 * `searchNav.resolveRoute`) speaks the app's `SuggestGroup` / `UnifiedSearchResult`
 * shape end-to-end (typeahead → grouped rows → route on tap). To source
 * suggestions from the P1 gateway (`POST /input-assistance/suggest`) WITHOUT
 * rewriting that UI, this module maps the canonical `InputSuggestion` projection
 * (§8) into the exact `SuggestGroup[]` the panel already renders — additively.
 *
 * Faithful to §13 (Global Search Suggestions):
 *   - Typed grouped rows: entities are grouped by kind (Cities / Places / People
 *     / Hidden Gems / …), ordered canonical-first (§9).
 *   - "SEARCH FOR …" query completions become a trailing `query` group whose rows
 *     carry a `submit_search` query in `metadata.submitQuery`, so tapping one
 *     submits that search (not the raw typed text).
 *   - NO DEAD ROWS: every row this mapper emits is either an entity row (a
 *     non-null `destinationRoute` the existing `resolveRoute` understands) OR a
 *     query-completion row (a `submitQuery`). A suggestion that resolves to
 *     neither is dropped rather than rendered inert (§13 "No dead suggestion rows").
 *
 * Routing is delegated to the existing `resolveRoute` (§43) via `destinationRoute`
 * — this module does not fork the route table. It only projects the gateway's
 * UI-ready `destination.route` (§42), synthesising the backend route convention
 * as a fallback when a minimal gateway omits it.
 *
 * Pure module — no React, no network — unit-testable under node:test. The
 * discovery types are imported `type`-only so this file never loads the
 * Supabase-backed service at runtime.
 */
import type { SuggestGroup, UnifiedSearchResult } from '../../../services/discovery.ts';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import type { EntityType } from '../types/inputContext.ts';
import { foldForMatch } from '../services/queryNormalization.ts';

/** The synthetic group/row type for query-completion ("SEARCH FOR …") rows. */
export const QUERY_GROUP_TYPE = 'query';

/**
 * Map the Input Intelligence `EntityType` to the `UnifiedSearchResult.type`
 * string the existing panel/icons/route table already speak (see `searchNav`
 * `TypeIcon` + `resolveRoute`). Kept exhaustive so a new entity type is a
 * compile error here rather than a silently mis-iconed row.
 */
const RESULT_TYPE_BY_ENTITY: Record<EntityType, string> = {
  city: 'cities',
  country: 'countries',
  neighborhood: 'places',
  place: 'places',
  hidden_gem: 'hidden_gems',
  user: 'travelers',
  trip: 'trips',
  event: 'events',
  plan: 'plans',
  buddy: 'buddies',
  hashtag: 'hashtags',
  language: 'languages',
  interest: 'interests',
};

/** Human group labels (rendered uppercase by the panel's group header style). */
const GROUP_LABEL: Record<string, string> = {
  cities: 'Cities',
  countries: 'Countries',
  places: 'Places',
  hidden_gems: 'Hidden Gems',
  events: 'Experiences',
  trips: 'Trips',
  travelers: 'People',
  buddies: 'Buddies',
  plans: 'Plans',
  hashtags: 'Hashtags',
  languages: 'Languages',
  interests: 'Interests',
  [QUERY_GROUP_TYPE]: 'Search for',
};

/**
 * Canonical group order (§9 candidate hierarchy: real entities first, generic
 * query completion last). Groups not listed here fall to the end but before the
 * query group, in first-seen order.
 */
const GROUP_ORDER: string[] = [
  'cities',
  'countries',
  'places',
  'hidden_gems',
  'events',
  'trips',
  'travelers',
  'buddies',
  'plans',
  'hashtags',
  'languages',
  'interests',
  QUERY_GROUP_TYPE,
];

function groupRank(type: string): number {
  const i = GROUP_ORDER.indexOf(type);
  // Unknown groups sort after known entity groups but before the query group.
  return i === -1 ? GROUP_ORDER.length - 1.5 : i;
}

/**
 * Synthesize a backend-convention route from an entity type + id, used only
 * when the gateway did not already provide a UI-ready `destination.route`.
 * These match the raw route strings `resolveRoute` normalises (e.g. `/city/:slug`
 * → `/destination/:slug`, `/hidden-gem/:id` → `/gems/:id`), so the existing
 * route table stays the single source of truth (§43).
 */
function synthRoute(entityType: EntityType | undefined, entityId: string | undefined): string | null {
  if (!entityId) return null;
  switch (entityType) {
    case 'city': return `/city/${entityId}`;
    case 'country': return `/country/${entityId}`;
    case 'place': return `/place/${entityId}`;
    case 'neighborhood': return `/place/${entityId}`;
    case 'hidden_gem': return `/hidden-gem/${entityId}`;
    case 'user': return `/passport/${entityId}`;
    case 'buddy': return `/passport/${entityId}`; // resolveRoute overrides via type==='buddies'
    case 'trip': return `/trip/${entityId}`;
    case 'event': return `/event/${entityId}`;
    case 'plan': return '/plan';
    case 'hashtag': return `/hashtag/${entityId}`;
    default: return null;
  }
}

function blankResult(id: string, type: string): UnifiedSearchResult {
  return {
    id,
    type,
    title: '',
    subtitle: null,
    avatarUrl: null,
    imageUrl: null,
    fallbackInitials: null,
    locationPreview: null,
    matchedReason: null,
    actionState: null,
    privacyState: null,
    accessState: null,
    destinationRoute: null,
    metadata: null,
    createdAt: null,
    startsAt: null,
  };
}

/** The entity identity a suggestion carries, drawn from top-level fields or an
 *  `open_entity` action, whichever is present. */
function entityIdentity(s: InputSuggestion): { entityType?: EntityType; entityId?: string } {
  const action = s.action;
  if (action && action.type === 'open_entity') {
    return {
      entityType: s.entityType ?? action.entityType,
      entityId: s.entityId ?? action.entityId,
    };
  }
  return { entityType: s.entityType, entityId: s.entityId };
}

/**
 * Try to project a suggestion as an entity row. Returns null when the suggestion
 * carries no resolvable destination — the caller then tries the submit path, and
 * failing that drops the row (no dead rows).
 */
function tryEntityRow(s: InputSuggestion): { group: string; result: UnifiedSearchResult } | null {
  const { entityType, entityId } = entityIdentity(s);
  const route = s.destination?.route ?? synthRoute(entityType, entityId ?? undefined);
  if (!route) return null;

  const typeForResult =
    (s.destination?.entityType && RESULT_TYPE_BY_ENTITY[s.destination.entityType]) ||
    (entityType && RESULT_TYPE_BY_ENTITY[entityType]) ||
    'places';

  const r = blankResult(entityId ?? s.destination?.entityId ?? s.id, typeForResult);
  r.title = (s.label ?? '').trim();
  r.subtitle = s.subtitle?.trim() || null;
  r.matchedReason = s.reason?.trim() || null;
  r.destinationRoute = route;
  return { group: typeForResult, result: r };
}

/**
 * True when a non-entity suggestion legitimately represents a text search to
 * submit (§13 "SEARCH FOR …"): an explicit `submit_search` action, or a
 * query-completion / recent / personalized search string. An arbitrary action
 * (drop_pin, add_to_trip, …) is NOT a query row — it is dropped rather than
 * rendered as an inert "search for X" row (no dead rows).
 */
function isQueryLike(s: InputSuggestion): boolean {
  const action = s.action;
  if (action) return action.type === 'submit_search';
  return s.type === 'completion' || s.type === 'recent' || s.type === 'personalized';
}

/** The submit-search query a completion/recent suggestion resolves to. */
function submitQueryFor(s: InputSuggestion): string {
  const action = s.action;
  if (action && action.type === 'submit_search') return (action.query ?? '').trim();
  return (s.replacementText ?? s.label ?? '').trim();
}

/**
 * Try to project a suggestion as a "SEARCH FOR …" query-completion row. Skips a
 * completion that just repeats the typed query (the panel already renders an
 * always-first "Search for «q»" row for that), and any too-short query.
 */
function trySubmitRow(
  s: InputSuggestion,
  typedFold: string,
): { group: string; result: UnifiedSearchResult } | null {
  const query = submitQueryFor(s);
  if (query.length < 2) return null;
  if (foldForMatch(query) === typedFold) return null; // dup of the always-first row

  const r = blankResult(s.id || `q:${foldForMatch(query)}`, QUERY_GROUP_TYPE);
  r.title = (s.label ?? '').trim() || query;
  r.metadata = { submitQuery: query, isQueryCompletion: true };
  return { group: QUERY_GROUP_TYPE, result: r };
}

/**
 * Map a flat, already-ranked `InputSuggestion[]` (as returned by
 * `useInputAssistance` for the `global_search` context) into the grouped
 * `SuggestGroup[]` the existing `SearchSuggestionsPanel` renders.
 *
 * @param suggestions the gateway's ranked suggestions (finalized/capped upstream)
 * @param typedQuery  the current field text, used to drop redundant completions
 */
export function mapSuggestionsToGroups(
  suggestions: InputSuggestion[],
  typedQuery: string,
): SuggestGroup[] {
  const typedFold = foldForMatch((typedQuery ?? '').trim());
  const byGroup = new Map<string, UnifiedSearchResult[]>();

  const push = (row: { group: string; result: UnifiedSearchResult } | null) => {
    if (!row) return;
    const list = byGroup.get(row.group);
    if (list) list.push(row.result);
    else byGroup.set(row.group, [row.result]);
  };

  for (const s of suggestions ?? []) {
    // Entity first (§9 canonical-first). If it has no resolvable destination,
    // fall back to a submit row; if it can't submit either, it is dropped —
    // never rendered as a dead row (§13).
    const entity = tryEntityRow(s);
    if (entity) {
      push(entity);
      continue;
    }
    if (isQueryLike(s)) push(trySubmitRow(s, typedFold));
  }

  const groups: SuggestGroup[] = [];
  for (const [type, items] of byGroup) {
    if (items.length === 0) continue;
    groups.push({ type, label: GROUP_LABEL[type] ?? type, items });
  }
  groups.sort((a, b) => groupRank(a.type) - groupRank(b.type));
  return groups;
}

/**
 * The submit-search query a mapped row carries, or null when it is an entity
 * row. `app/search.tsx` calls this in its suggestion-pick handler: a non-null
 * result means "submit this search" (§43 `submit_search`); null means "route
 * this entity via resolveRoute" (§43 `open_entity`).
 */
export function getSubmitQuery(item: { metadata?: Record<string, unknown> | null }): string | null {
  const q = item.metadata?.submitQuery;
  return typeof q === 'string' && q.trim().length >= 2 ? q.trim() : null;
}

/**
 * A row is resolvable (NOT dead) iff it routes to an entity (`destinationRoute`)
 * or submits a search (`submitQuery`). The no-dead-rows invariant test asserts
 * this holds for every row `mapSuggestionsToGroups` emits.
 */
export function isResolvableRow(item: UnifiedSearchResult): boolean {
  return !!item.destinationRoute || getSubmitQuery(item) !== null;
}
