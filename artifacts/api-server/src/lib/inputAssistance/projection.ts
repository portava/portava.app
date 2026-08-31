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
