/**
 * Suggestion Projection (§42).
 *
 * Converts the INTERNAL SearchResult (routes/discoverySearch) into the UI-ready
 * InputSuggestion (§8). This is the boundary the spec calls out: the server
 * returns a UI-ready projection and NEVER exposes raw trust vectors, private
 * ranking features, or hidden policy decisions. Only a fixed, safe subset of
 * SearchResult is copied out; internal metadata (owner ids, like counts, host
 * ids, raw coordinates, privacyState/accessState) is deliberately dropped.
 *
 * It also builds the non-entity suggestion shapes that keep the surface free of
 * dead rows (§13): a "search for" query completion (resolves to submit_search)
 * and static Compass prompt starters (§56, resolve to editable replace_text —
 * never silently inserted, §22).
 */
import type { SearchResult } from '../../routes/discoverySearch';
import { matchTier } from '../../routes/discoverySearchHelpers';
import type { CanonicalRow } from '../canonicalLocations';
import type { CanonicalCityBinding, GeoDefault } from './geoResolver';
import { cityBinding, airportCityBinding } from './geoResolver';
import type { StaticAirport } from '../../services/airport/StaticAirportData';
import { searchTypeToEntity, type DispatchSearchType } from './entityMap';
import type {
  InputContext,
  InputSuggestion,
  SuggestionAction,
  AssistanceType,
} from './types';

// Match tier (3 exact / 2 prefix / 1 substring / 0 none) → a bounded confidence
// the client can display. This reuses the same matchTier the search path uses,
// so confidence tracks the existing ranking rather than a second scheme.
function tierConfidence(tier: number): number {
  switch (tier) {
    case 3: return 0.99;
    case 2: return 0.85;
    case 1: return 0.6;
    default: return 0.4;
  }
}

/**
 * Project one internal SearchResult into a UI-ready InputSuggestion.
 *
 * Every row resolves: entity rows carry a resolvable `open_entity` action AND a
 * canonical destination, so nothing is a dead row (§13). `freshness` is left
 * UNSET — Phase 1 does not wire the LiveSuggestionService, and a live label must
 * never be fabricated when live state is unavailable (§31).
 */
export function projectSearchResult(
  r: SearchResult,
  context: InputContext,
  policyVersion: string,
  q: string,
): InputSuggestion {
  const entityType = searchTypeToEntity(r.type as DispatchSearchType);
  const confidence = tierConfidence(matchTier(r.title, q, r.subtitle));

  // Canonical registry rows carry source:"canonical" in metadata; every other
  // entity from dispatchSearch is likewise a canonical Portava entity match.
  const source: InputSuggestion['source'] = 'canonical';

  const action: SuggestionAction = {
    type: 'open_entity',
    entityType,
    entityId: r.id,
  };

  const suggestion: InputSuggestion = {
    id: `${context}:${r.type}:${r.id}`,
    type: 'entity',
    context,
    label: r.title,
    entityType,
    entityId: r.id,
    action,
    confidence,
    source,
    policyVersion,
  };

  // Only copy display-safe optional fields — NEVER internal metadata (§42).
  if (r.subtitle) suggestion.subtitle = r.subtitle;
  if (r.matchedReason) suggestion.reason = r.matchedReason;
  if (r.destinationRoute) {
    suggestion.destination = { route: r.destinationRoute, entityType, entityId: r.id };
    suggestion.canonicalUri = `portava:${r.destinationRoute}`;
  }

  return suggestion;
}

// ── Geographic core projection (§12/§17/§19/§53) ──────────────────────────────

function citySlug(name: string): string {
  return `/city/${encodeURIComponent((name || '').toLowerCase())}`;
}

/**
 * Project a canonical city row for a geographic PICKER context. Selecting it
 * sets the §17/§53 structured binding (city_id + country + coordinates +
 * timezone) so dependent fields prefill — visibly and editably (§17). When
 * `disambiguation` is set (§19) the row is a ranked CHOICE, not an auto-pick,
 * and its confidence is capped in the MEDIUM band so the client never
 * auto-replaces on it.
 */
export function projectCanonicalCity(
  row: CanonicalRow,
  context: InputContext,
  policyVersion: string,
  q: string,
  opts: { disambiguation?: boolean } = {},
): InputSuggestion {
  const label = row.name || row.display_name;
  const subtitle = [row.region, row.country].filter(Boolean).join(', ') || null;
  const binding: CanonicalCityBinding = cityBinding(row);
  const disambiguation = opts.disambiguation === true;
  const confidence = disambiguation
    ? 0.55 // MEDIUM (§19): a ranked choice, never an auto-replace
    : tierConfidence(matchTier(label, q, subtitle));

  const suggestion: InputSuggestion = {
    id: `${context}:city:${row.id}`,
    type: disambiguation ? 'disambiguation' : 'entity',
    context,
    label,
    entityType: 'city',
    entityId: row.id,
    // Selecting a picker city BINDS the field to the canonical value (§17/§53).
    action: { type: 'set_structured_value', value: binding },
    structuredValue: binding,
    confidence,
    source: 'canonical',
    destination: { route: citySlug(label), entityType: 'city', entityId: row.id },
    canonicalUri: `portava:${citySlug(label)}`,
    policyVersion,
  };
  if (subtitle) suggestion.subtitle = subtitle;
  if (disambiguation && row.country) suggestion.reason = row.country;
  return suggestion;
}

/**
 * Project an airport-code match as a DISAMBIGUATION choice pointing at the
 * airport's CITY (§12 airport/city ambiguity). A bare code ("DAD") is never
 * silently resolved to a city; the user is offered the city explicitly.
 */
export function projectAirportDisambiguation(
  airport: StaticAirport,
  context: InputContext,
  policyVersion: string,
): InputSuggestion {
  const binding = airportCityBinding(airport);
  return {
    id: `${context}:airport:${airport.iataCode}`,
    type: 'disambiguation',
    context,
    label: airport.city,
    subtitle: `${airport.iataCode} · ${airport.country}`,
    entityType: 'city',
    action: { type: 'set_structured_value', value: binding },
    structuredValue: binding,
    confidence: 0.5, // MEDIUM — a clarification choice, not an auto-pick (§19)
    source: 'canonical',
    reason: `${airport.iataCode} airport`,
    destination: { route: citySlug(airport.city), entityType: 'city' },
    policyVersion,
  };
}

/**
 * Project a zero-character default (§14/§53): the viewer's current city or an
 * active/upcoming Trip destination. Bindable when it resolved to a canonical
 * city; otherwise it drops the raw name into the field (editable, never a
 * silent commit).
 */
export function projectGeoDefault(
  def: GeoDefault,
  context: InputContext,
  policyVersion: string,
  index: number,
): InputSuggestion {
  const action: SuggestionAction = def.binding
    ? { type: 'set_structured_value', value: def.binding }
    : { type: 'replace_text', text: def.label };
  const suggestion: InputSuggestion = {
    id: `${context}:default:${def.kind}:${index}`,
    type: 'recent',
    context,
    label: def.label,
    action,
    confidence: 0.7,
    source: def.kind === 'current' ? 'local' : 'recent',
    reason: def.reason,
    policyVersion,
  };
  if (def.subtitle) suggestion.subtitle = def.subtitle;
  if (def.binding) {
    suggestion.structuredValue = def.binding;
    suggestion.entityType = 'city';
    if (def.binding.cityId) suggestion.entityId = def.binding.cityId;
    suggestion.destination = { route: citySlug(def.label), entityType: 'city' };
  } else {
    suggestion.replacementText = def.label;
  }
  return suggestion;
}

/**
 * The "SEARCH FOR" query completion row (§13). Tapping it submits a search.
 * Only produced when the policy allows the `completion` type.
 */
export function buildQueryCompletion(
  context: InputContext,
  policyVersion: string,
  q: string,
): InputSuggestion {
  return {
    id: `${context}:completion:${q}`,
    type: 'completion',
    context,
    label: `Search "${q}"`,
    replacementText: q,
    action: { type: 'submit_search', query: q },
    confidence: 0.3,
    source: 'local',
    policyVersion,
  };
}

// Static Compass prompt starters (§56). These are canned, opt-in prompt
// suggestions — NOT AI-generated text. Real AI writing assistance (§22) is
// deferred. They resolve to an editable replace_text action so nothing is ever
// silently inserted (§22), and to open_compass context carryover on submit.
const COMPASS_STARTERS = [
  'Where should I go tonight?',
  'Where should I eat nearby?',
  'Where should we go after this?',
  'Find a hidden gem.',
];

/**
 * Build Compass prompt starters filtered to the typed prefix. Only called when
 * the policy has allowAI=true AND allows the `ai_suggestion` type.
 */
export function buildCompassStarters(
  context: InputContext,
  policyVersion: string,
  q: string,
  max: number,
): InputSuggestion[] {
  const needle = q.trim().toLowerCase();
  const matched = needle.length === 0
    ? COMPASS_STARTERS
    : COMPASS_STARTERS.filter((s) => s.toLowerCase().includes(needle) || needle.length < 3);
  return matched.slice(0, Math.max(0, max)).map((text, i): InputSuggestion => ({
    id: `${context}:ai:${i}`,
    type: 'ai_suggestion',
    context,
    label: text,
    replacementText: text,
    action: { type: 'replace_text', text },
    confidence: 0.5,
    source: 'ai',
    reason: 'Suggested prompt',
    policyVersion,
  }));
}

// Ordering priority by assistance type: canonical entities first, then recents,
// then query completions, and AI suggestions LAST — enforcing §9's rule that AI
// must never outrank a strong canonical entity match.
const TYPE_RANK: Record<AssistanceType, number> = {
  entity: 0,
  recent: 1,
  personalized: 2,
  structured_value: 3,
  disambiguation: 4,
  completion: 5,
  correction: 6,
  validation: 7,
  action: 8,
  ai_suggestion: 9,
};

/**
 * Stable ordering + cap. Primary: assistance-type rank (§9 trust order).
 * Secondary: confidence desc. Ties keep input order (stable).
 */
export function orderSuggestions(
  suggestions: InputSuggestion[],
  limit: number,
): InputSuggestion[] {
  return suggestions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ra = TYPE_RANK[a.s.type] ?? 50;
      const rb = TYPE_RANK[b.s.type] ?? 50;
      if (ra !== rb) return ra - rb;
      const ca = a.s.confidence ?? 0;
      const cb = b.s.confidence ?? 0;
      if (ca !== cb) return cb - ca;
      return a.i - b.i;
    })
    .map((x) => x.s)
    .slice(0, Math.max(0, limit));
}

/**
 * §13 requires the global-search result to keep its "SEARCH FOR" query-
 * completion row(s) available: a mixed result must be able to show BOTH the
 * matched entities AND a submittable-search row, and the completion must never
 * be silently capped out by a long run of entity rows (which always sort ahead
 * of it under §9 trust order).
 *
 * This orders exactly like `orderSuggestions` — so §9 order still holds
 * (entities lead, completions trail) — but RESERVES up to `reserve` slots for
 * suggestions whose type is in `reservedTypes` so at least one survives the cap
 * whenever the field produced one. Primary (non-reserved) rows keep priority
 * for the remaining slots, and when nothing else matched the reserved rows still
 * show (never an empty result while a submittable search exists). The total is
 * still capped at `limit`, so `maxSuggestions` is never exceeded.
 */
export function orderSuggestionsReserving(
  suggestions: InputSuggestion[],
  limit: number,
  reservedTypes: ReadonlySet<AssistanceType>,
  reserve: number,
): InputSuggestion[] {
  const cap = Math.max(0, limit);
  if (cap === 0) return [];
  const ordered = orderSuggestions(suggestions, Number.POSITIVE_INFINITY);
  const reservedRows = ordered.filter((s) => reservedTypes.has(s.type));
  if (reservedRows.length === 0) return ordered.slice(0, cap);
  const primaryRows = ordered.filter((s) => !reservedTypes.has(s.type));

  const wantReserved = Math.min(Math.max(0, reserve), reservedRows.length);
  // Never starve the primary rows: when primary rows exist, keep the reservation
  // strictly below the cap so entities still lead. With no primary rows the
  // reserved rows are the only useful output, so they may fill the whole cap.
  const protect = primaryRows.length > 0
    ? Math.min(wantReserved, Math.max(0, cap - 1))
    : Math.min(wantReserved, cap);
  const keepPrimary = primaryRows.slice(0, Math.max(0, cap - protect));
  const keepReserved = reservedRows.slice(0, Math.max(0, cap - keepPrimary.length));
  return orderSuggestions([...keepPrimary, ...keepReserved], cap);
}

/**
 * §13 "No dead suggestion rows": every returned suggestion must resolve to
 * something the client can act on — an inline action, a canonical entity id, or
 * a routable destination. Tapping an entity opens/resolves it; tapping a
 * completion submits a search; there is never a row that does nothing.
 */
export function isResolvable(s: InputSuggestion): boolean {
  return (
    s.action != null ||
    (typeof s.entityId === 'string' && s.entityId.length > 0) ||
    (s.destination != null && typeof s.destination.route === 'string' && s.destination.route.length > 0)
  );
}

/**
 * Server-side safety net for §13: drop any non-resolvable row so a "dead" row
 * can never reach the client even if a future projector forgets to attach an
 * action/entity/destination. The real projections above always produce a
 * resolvable row; this guarantees the invariant regardless.
 */
export function dropDeadRows(suggestions: InputSuggestion[]): InputSuggestion[] {
  return suggestions.filter(isResolvable);
}
