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
import { normalizeLocationName, suggestCanonicalLocations } from '../canonicalLocations';
import { applyAliases, type SearchQueryContext } from '../../routes/discoverySearchHelpers';
import {
  dispatchSearch,
  fetchAgeRestrictedSet,
  sanitizeQuery,
  canonicalToCityResult,
  mergeCitySuggestions,
  type SearchResult,
} from '../../routes/discoverySearch';
import { entityToSearchType, type DispatchSearchType } from './entityMap';
import { POLICY_VERSION } from './policyRegistry';
import {
  projectSearchResult,
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
  // normalizeLocationName is the canonical diacritic/case fold — used here to
  // gate the canonical-city path consistently with suggestCanonicalLocations.
  const normalized = normalizeLocationName(q);

  // Honor minChars (§33). compass_prompt has minChars:0 so it still yields
  // starter prompts on an empty field (§14 zero-character assistance).
  if (q.length < policy.minChars) return [];

  const suggestions: InputSuggestion[] = [];

  // ── Entity candidate generation ─────────────────────────────────────────────
  const wantsEntities = policy.allowedSuggestionTypes.includes('entity');
  // POLICY GATE (§6): only the policy's declared entity types are ever queried.
  const policyEntityTypes = policy.entityTypes ?? [];
  const dispatchTypes: DispatchSearchType[] = uniq(
    policyEntityTypes.map(entityToSearchType),
  );

  // dispatchSearch needs a ≥2-char pattern to be meaningful.
  if (wantsEntities && dispatchTypes.length > 0 && q.length >= 2) {
    // ── Privacy / eligibility gateway (§29) — fail-closed, BEFORE projection ──
    // Resolve viewer eligibility first. A null block-set or age-restriction set
    // means the state is UNKNOWN → suppress everybody/everything (show nobody).
    const [blockedSet, ageRestrictedSet] = await Promise.all([
      fetchBlockedSet(sc, userId),
      fetchAgeRestrictedSet(sc),
    ]);

    if (blockedSet !== null && ageRestrictedSet !== null) {
      // Split the suggestion budget across the requested types (≥2 each so a
      // small maxSuggestions still surfaces more than one type).
      const perType = Math.max(2, Math.ceil(policy.maxSuggestions / dispatchTypes.length));
      const ctx: SearchQueryContext = {
        lat,
        lng,
        userCity: city,
        nearbyIntent: false,
      };

      // Canonical city rows (public geo registry, no user linkage) run in
      // parallel and are merged into the "cities" bucket when present.
      const wantsCities = dispatchTypes.includes('cities');
      const [perTypeResults, canonicalRows] = await Promise.all([
        Promise.all(
          dispatchTypes.map((t) =>
            dispatchSearch(sc, q, userId, blockedSet, ageRestrictedSet, t, 0, perType, ctx)
              .catch(() => [] as SearchResult[]),
          ),
        ),
        wantsCities && !isHandle
          ? suggestCanonicalLocations(sc, q, 4).catch(() => [])
          : Promise.resolve([]),
      ]);

      // Cross-type dedupe by internal id (a profile must not appear as both a
      // traveler and a buddy), then project each survivor to the §8 shape.
      const seenIds = new Set<string>();
      dispatchTypes.forEach((t, idx) => {
        let items = perTypeResults[idx] ?? [];
        if (t === 'cities' && canonicalRows.length > 0) {
          items = mergeCitySuggestions(canonicalRows.map(canonicalToCityResult), items, perType);
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
