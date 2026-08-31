/**
 * InputAssistanceGateway — candidate generation + privacy gateway + projection.
 *
 * This is the unification-layer spine (§3/§4/§42). It WRAPS existing systems and
 * reimplements nothing:
 *
 *   - Candidate generation delegates to `dispatchSearch` (routes/discoverySearch)
 *     — the same per-type query + match-tier ranking + fail-closed privacy code
 *     paths /discovery/search and /discovery/suggest use.
 *   - Canonical city rows come from `suggestCanonicalLocations`
 *     (lib/canonicalLocations) merged via the existing `mergeCitySuggestions`.
 *   - Normalization reuses `normalizeLocationName` + `applyAliases` + the shared
 *     `sanitizeQuery` PostgREST guard.
 *   - The privacy/eligibility gateway (§29) runs BEFORE projection and is
 *     fail-closed: unknown block/age state ⇒ no entity suggestions (mirrors
 *     /discovery/suggest, which returns empty when block state is unknown).
 *   - Projection to InputSuggestion strips raw trust/ranking internals (§42).
 *
 * The gateway ORDER (§4): classify → resolve policy (caller) → normalize →
 * generate candidates filtered to the policy's allowed entity/assistance types
 * → privacy gateway → rank/dedupe → project.
 */
import { fetchBlockedSet } from '../blocks';
import { normalizeLocationName } from '../canonicalLocations';
import { applyAliases, type SearchQueryContext } from '../../routes/discoverySearchHelpers';
import {
  dispatchSearch,
  fetchAgeRestrictedSet,
  sanitizeQuery,
  canonicalToCityResult,
  mergeCitySuggestions,
  type SearchResult,
} from '../../routes/discoverySearch';
import { resolveGeoCandidates, zeroCharGeoDefaults, type GeoResolution } from './geoResolver';
import { entityToSearchType, type DispatchSearchType } from './entityMap';
import { POLICY_VERSION } from './policyRegistry';
import {
  projectSearchResult,
  projectCanonicalCity,
  projectAirportDisambiguation,
  projectGeoDefault,
  buildQueryCompletion,
  buildCompassStarters,
  orderSuggestions,
} from './projection';
import type {
  InputContext,
  InputFieldPolicy,
  InputSuggestion,
  SuggestSessionContext,
} from './types';

// Geographic PICKER contexts (§12) that resolve to a canonical city and, on
// selection, return the §17/§53 binding. These get the strengthened city path:
// diacritic/stroke/alias-aware resolution, airport/ambiguity disambiguation, and
// zero-character defaults. global_search is intentionally NOT here — it keeps its
// existing mixed-entity search behavior (cities merged, no forced binding).
const GEO_PICKER_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'city_picker',
  'country_picker',
  'neighborhood_picker',
  'place_picker',
  'trip_destination',
  'trip_stop_place',
  'event_location',
  'passport_homebase',
  'address',
  'buddy_service_area',
  'hidden_gem_location',
]);

const EMPTY_GEO: GeoResolution = { rows: [], ambiguous: false, airport: null };

export interface GenerateParams {
  context: InputContext;
  policy: InputFieldPolicy;
  text: string;
  userId: string;
  limit: number;
  sessionContext?: SuggestSessionContext;
  lat: number | null;
  lng: number | null;
  city: string | null;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/**
 * Generate the ranked, projected suggestion list for one request.
 * Returns InputSuggestion[] (already ordered and capped).
 */
export async function generateSuggestions(
  sc: any,
  params: GenerateParams,
): Promise<InputSuggestion[]> {
  const { context, policy, text, userId, limit, sessionContext, lat, lng, city } = params;

  // no_assistance fields produce nothing (§6). generic_text lands here.
  if (policy.mode === 'no_assistance') return [];

  // ── Normalization (§10, reused) ─────────────────────────────────────────────
  // @handle queries target people; strip the sigil first, then alias-expand
  // (typo tolerance) and apply the shared PostgREST-injection sanitizer.
  const trimmed = (text ?? '').trim();
  const isHandle = trimmed.startsWith('@');
  const aliased = applyAliases(isHandle ? trimmed.slice(1) : trimmed);
  const q = sanitizeQuery(aliased).slice(0, 80);
  // normalizeLocationName is the canonical diacritic/case fold — kept for the
  // §16 session-bias comparison below (the stroke/alias-aware geographic fold
  // lives in the geoResolver / suggestCanonicalLocationsFolded path).
  const normalized = normalizeLocationName(q);

  const isGeoPicker = GEO_PICKER_CONTEXTS.has(context);
  const wantsRecent = policy.allowedSuggestionTypes.includes('recent');
  const wantsEntities = policy.allowedSuggestionTypes.includes('entity');

  // ── §14 zero-character assistance (geographic pickers) ──────────────────────
  // When the field is EMPTY and the policy allows recents/entities, serve the
  // viewer's current city + active/upcoming Trip destinations (§53). Sourced
  // only from the viewer's OWN rows, so no person-privacy gate is required.
  if (q.length === 0 && isGeoPicker && (wantsRecent || wantsEntities)) {
    const defaults = await zeroCharGeoDefaults(sc, {
      userId,
      city,
      max: policy.maxSuggestions,
    }).catch(() => []);
    const projected = defaults.map((d, i) => projectGeoDefault(d, context, POLICY_VERSION, i));
    return orderSuggestions(
      applySessionBias(projected, sessionContext, normalized),
      Math.min(limit, policy.maxSuggestions),
    );
  }

  // Honor minChars (§33). compass_prompt has minChars:0 so it still yields
  // starter prompts on an empty field (§14 zero-character assistance).
  if (q.length < policy.minChars) return [];

  const suggestions: InputSuggestion[] = [];

  // POLICY GATE (§6): only the policy's declared entity types are ever queried.
  const policyEntityTypes = policy.entityTypes ?? [];
  const dispatchTypes: DispatchSearchType[] = uniq(
    policyEntityTypes.map(entityToSearchType),
  );
  const wantsCities = dispatchTypes.includes('cities');

  // ── Strengthened canonical city resolution (§10/§11/§12/§19) ─────────────────
  // Diacritic/stroke/alias-aware ("da nang"→Đà Nẵng, "hcmc"→the HCMC city id).
  // Public geo registry data with no user linkage, so it runs OUTSIDE the
  // person-privacy gate. Reused by BOTH the geo-picker path (binding +
  // disambiguation) and global_search (merged as SearchResults).
  const geoRes: GeoResolution =
    wantsEntities && wantsCities && !isHandle && q.length >= 2
      ? await resolveGeoCandidates(sc, q, Math.max(4, policy.maxSuggestions)).catch(() => EMPTY_GEO)
      : EMPTY_GEO;

  if (wantsEntities && dispatchTypes.length > 0 && q.length >= 2) {
    if (isGeoPicker) {
      // ── Geographic picker path (§12/§17/§19/§53) ────────────────────────────
      // Cities resolve to canonical entities that BIND the field on selection.
      // Airport codes and same-name-different-place inputs surface as
      // disambiguation CHOICES (§19), never a silent guess.
      if (wantsCities) {
        if (geoRes.airport) {
          suggestions.push(projectAirportDisambiguation(geoRes.airport, context, POLICY_VERSION));
        }
        for (const row of geoRes.rows) {
          suggestions.push(
            projectCanonicalCity(row, context, POLICY_VERSION, q, { disambiguation: geoRes.ambiguous }),
          );
        }
      }
      // Non-city entity types the picker allows (place / hidden_gem / country)
      // still flow through the existing per-type search behind the privacy gate.
      const otherTypes = dispatchTypes.filter((t) => t !== 'cities');
      if (otherTypes.length > 0) {
        suggestions.push(
          ...(await dispatchAndProject(sc, otherTypes, {
            q, userId, context, policy, lat, lng, city,
          })),
        );
      }
    } else {
      // ── Generic mixed-entity path (global_search, username, hashtag, …) ─────
      // Unchanged behavior: privacy-gated per-type dispatch, canonical cities
      // MERGED into the cities bucket, projected as open_entity rows.
      const [blockedSet, ageRestrictedSet] = await Promise.all([
        fetchBlockedSet(sc, userId),
        fetchAgeRestrictedSet(sc),
      ]);

      if (blockedSet !== null && ageRestrictedSet !== null) {
        const perType = Math.max(2, Math.ceil(policy.maxSuggestions / dispatchTypes.length));
        const ctx: SearchQueryContext = { lat, lng, userCity: city, nearbyIntent: false };

        const perTypeResults = await Promise.all(
          dispatchTypes.map((t) =>
            dispatchSearch(sc, q, userId, blockedSet, ageRestrictedSet, t, 0, perType, ctx)
              .catch(() => [] as SearchResult[]),
          ),
        );

        const seenIds = new Set<string>();
        dispatchTypes.forEach((t, idx) => {
          let items = perTypeResults[idx] ?? [];
          if (t === 'cities' && geoRes.rows.length > 0) {
            items = mergeCitySuggestions(geoRes.rows.map(canonicalToCityResult), items, perType);
          }
          for (const r of items) {
            if (seenIds.has(r.id)) continue;
            seenIds.add(r.id);
            suggestions.push(projectSearchResult(r, context, POLICY_VERSION, q));
          }
        });
      }
      // else: fail-closed — no entity suggestions when eligibility is unknown.
    }
  }

  // ── Query completion (§13 "SEARCH FOR") ─────────────────────────────────────
  // Tapping submits a search. Only when the policy allows the completion type
  // and there is a query to submit — never a dead row.
  if (policy.allowedSuggestionTypes.includes('completion') && q.length >= Math.max(1, policy.minChars)) {
    suggestions.push(buildQueryCompletion(context, POLICY_VERSION, q));
  }

  // ── Compass prompt starters (§56, AI lane) ──────────────────────────────────
  // Static opt-in prompts, gated by the policy's AI allowance. Real AI writing
  // (§22) is deferred; these are canned starters resolving to editable text.
  if (
    context === 'compass_prompt' &&
    policy.allowAI &&
    policy.allowedSuggestionTypes.includes('ai_suggestion')
  ) {
    suggestions.push(
      ...buildCompassStarters(context, POLICY_VERSION, q, policy.maxSuggestions),
    );
  }

  // ── §16 context carryover (bounded, session-scoped) ─────────────────────────
  // When the active task carries a cityId, bias a matching city/place row to the
  // front so dependent fields inherit the task's city first. Bounded to this
  // request; never mutates persistent preferences. Fuller §16/§17 carryover is
  // deferred.
  const biased = applySessionBias(suggestions, sessionContext, normalized);

  // ── Rank + cap (§9 trust order, §15 tie-break by confidence) ────────────────
  return orderSuggestions(biased, Math.min(limit, policy.maxSuggestions));
}

/**
 * Privacy-gated per-type dispatch → projection for NON-city entity types in a
 * geographic picker (place / hidden_gem / country). Same fail-closed gate as
 * the generic path: a null block/age set suppresses everything.
 */
async function dispatchAndProject(
  sc: any,
  types: DispatchSearchType[],
  p: {
    q: string;
    userId: string;
    context: InputContext;
    policy: InputFieldPolicy;
    lat: number | null;
    lng: number | null;
    city: string | null;
  },
): Promise<InputSuggestion[]> {
  const [blockedSet, ageRestrictedSet] = await Promise.all([
    fetchBlockedSet(sc, p.userId),
    fetchAgeRestrictedSet(sc),
  ]);
  // Fail-closed (§29): unknown eligibility ⇒ no entity suggestions.
  if (blockedSet === null || ageRestrictedSet === null) return [];

  const perType = Math.max(2, Math.ceil(p.policy.maxSuggestions / types.length));
  const ctx: SearchQueryContext = { lat: p.lat, lng: p.lng, userCity: p.city, nearbyIntent: false };
  const perTypeResults = await Promise.all(
    types.map((t) =>
      dispatchSearch(sc, p.q, p.userId, blockedSet, ageRestrictedSet, t, 0, perType, ctx)
        .catch(() => [] as SearchResult[]),
    ),
  );

  const out: InputSuggestion[] = [];
  const seen = new Set<string>();
  for (const items of perTypeResults) {
    for (const r of items) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(projectSearchResult(r, p.context, POLICY_VERSION, p.q));
    }
  }
  return out;
}

/**
 * Move any suggestion whose entityId matches the session's cityId to the front
 * (stable). A minimal, bounded implementation of §16 context carryover.
 */
function applySessionBias(
  suggestions: InputSuggestion[],
  sessionContext: SuggestSessionContext | undefined,
  _normalizedQuery: string,
): InputSuggestion[] {
  const cityId = sessionContext?.cityId;
  if (!cityId) return suggestions;
  const boosted: InputSuggestion[] = [];
  const rest: InputSuggestion[] = [];
  for (const s of suggestions) {
    if (s.entityId === cityId) boosted.push({ ...s, confidence: Math.max(s.confidence ?? 0, 0.995) });
    else rest.push(s);
  }
  return [...boosted, ...rest];
}
