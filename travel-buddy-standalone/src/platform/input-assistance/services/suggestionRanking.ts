/**
 * Global Input Intelligence — client-side ranking helpers (spec §15, §30, §42).
 *
 * IMPORTANT: real ranking is SERVER-OWNED. The server returns a UI-ready
 * projection and must not expose raw trust vectors or private ranking features
 * (§42). The client therefore does NOT re-rank; it only performs the two safe,
 * presentation-level operations the projection contract permits:
 *   - de-duplicate suggestions that resolve to the same canonical entity
 *     (§20 "Duplicate entity suppression", §36),
 *   - cap the visible count to the field's policy (§33 "cap visible results").
 *
 * The `SuggestionScore` composition (§15) and conflict-resolution precedence
 * (§30) are deliberately NOT reimplemented here — that would fork the server's
 * authority. Pure module.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import type { AssistanceType } from '../types/inputContext.ts';
import { foldForMatch, matchesGeographicQuery } from './queryNormalization.ts';

/** Identity key for dedupe: canonical entity if present, else uri, else id. */
function identityKey(s: InputSuggestion): string {
  if (s.entityType && s.entityId) return `${s.entityType}:${s.entityId}`;
  if (s.canonicalUri) return `uri:${s.canonicalUri}`;
  return `id:${s.id}`;
}

/**
 * Remove suggestions that resolve to the same canonical entity, keeping the
 * first occurrence (the server already ordered them, so first = best). Stable.
 */
export function dedupeSuggestions(suggestions: InputSuggestion[]): InputSuggestion[] {
  const seen = new Set<string>();
  const out: InputSuggestion[] = [];
  for (const s of suggestions) {
    const key = identityKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Cap to at most `max` items (§33). Non-mutating. */
export function capSuggestions(suggestions: InputSuggestion[], max: number): InputSuggestion[] {
  if (max <= 0) return [];
  return suggestions.length > max ? suggestions.slice(0, max) : suggestions;
}

/** Convenience: dedupe then cap — the exact post-projection cleanup the hook applies. */
export function finalizeSuggestions(suggestions: InputSuggestion[], max: number): InputSuggestion[] {
  return capSuggestions(dedupeSuggestions(suggestions), max);
}

// ── §33 tier 1 / §34 local narrowing ──────────────────────────────────────────

/**
 * The assistance types a cached list may keep when it is reused for a LONGER
 * query than the one it was fetched for.
 *
 * Only rows that stand for a THING survive: an entity, a prior selection, a
 * personalized entity row, a resolved structured value. Every other type
 * encodes the query or a verdict ABOUT the query that is now out of date — a
 * `completion` carries the old text in `replacementText` and would submit it, a
 * `correction` / `validation` judged a string the user has since changed, a
 * `disambiguation` offered a choice between readings of the old text, an
 * `action` was resolved from the old parse, an `ai_suggestion` was written for
 * it. Re-showing any of those for text they were not produced from is the
 * "stale data presented as current" §2 forbids, so they are dropped rather than
 * re-matched.
 */
const LOCALLY_REUSABLE_TYPES: ReadonlySet<AssistanceType> = new Set<AssistanceType>([
  'entity',
  'recent',
  'personalized',
  'structured_value',
]);

/**
 * §33 / §34 — narrow a list cached for a SHORTER query down to the rows that can
 * still be answers for `query`. Pure, order-preserving, and STRICTLY SUBTRACTIVE:
 * it can only drop rows, never add, reorder, re-score or rewrite one. The server
 * stays the authority on what matches and in what order (§42); this decides only
 * which of the rows it already returned survive another keystroke.
 *
 * A row is kept when the folded query appears in its label — the same
 * case/diacritic fold the cache key uses, matching the server's `ilike %q%`
 * match semantics — or when the query is a known local alias of the label
 * ("hcmc" → "Ho Chi Minh City", which contains neither the letters nor the
 * order of the query).
 *
 * An empty query returns nothing: an empty field's list is the ZERO-STATE, which
 * is fetched under its own cache key, never narrowed out of a typed one.
 */
export function narrowToQuery(
  suggestions: InputSuggestion[],
  query: string,
): InputSuggestion[] {
  const q = foldForMatch(query);
  if (!q) return [];
  return suggestions.filter((s) => {
    if (!LOCALLY_REUSABLE_TYPES.has(s.type)) return false;
    if (foldForMatch(s.label).includes(q)) return true;
    return matchesGeographicQuery(query, s.label);
  });
}
