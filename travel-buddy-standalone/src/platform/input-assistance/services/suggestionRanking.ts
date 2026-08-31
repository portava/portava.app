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
