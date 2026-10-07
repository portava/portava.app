/**
 * Global Input Intelligence — entity resolution (spec §11, §17, §53).
 *
 * The system must resolve accepted user text to CANONICAL entities, not
 * strings (§11), and populate dependent fields from the selection (§17
 * cross-field graph: Venue → City/Country/Coordinates/Timezone).
 *
 * The server-side runtime exists per-domain — `src/lib/location/resolveCanonical.ts`
 * and `POST /api/locations/resolve` do find-or-create canonical binding for
 * places. Phase 1 shipped only this contract and a pass-through; the LOCAL
 * resolution below (G260) is what an offline accept can do without a server.
 *
 * Kept dependency-free (no supabase import) so it is safe to import anywhere,
 * including node:test.
 *
 * ── THE NULL BRANCH, BUILT (census G260, 2026-10-07) ────────────────────────
 *
 * An UNRESOLVED row is one with no canonical `entityId`: a shipped-dictionary
 * row offered offline (`localDictionary.ts` — a NAME the client ships, never an
 * identity), or anything else the server did not bind. It is now resolved
 * against the one local index that DOES hold canonical identities: the rows the
 * server projected and the user explicitly accepted in this same field
 * (`localZeroState.ts`, device-local since G199). Nothing is resolved from the
 * dictionary itself, and no identity is ever invented.
 *
 * The rules, each a reason to return null rather than guess:
 *   - a row that is not an `entity` or `recent` row, or that names no entity
 *     class — a "Search …" completion, a correction, an action or an AI row is
 *     the person's text or a parse, never an entity to bind;
 *   - no policy, or a field whose privacy class forbids local retention — the
 *     retained rows are read through `localZeroState`, which applies the LIVE
 *     policy gate, so a viewer-scoped field has nothing to resolve against;
 *   - a retained row of a DIFFERENT entity class than the unresolved row says it
 *     is — a city name never binds to a place of the same name;
 *   - AMBIGUITY: two or more DISTINCT canonical entities share the folded label
 *     (two "San Jose"s the user has picked before). §19 says ambiguity is a
 *     choice for the person, never an auto-pick, so the row stays unresolved;
 *   - no retained match at all.
 * A single unambiguous match resolves to the retained row's canonical id, its
 * canonical uri, and — when the server bound one — the §17 prefill it carried.
 */
import type { EntityType } from '../types/inputContext.ts';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import { localZeroState, type LocalZeroStatePolicy } from './localZeroState.ts';
import { foldForMatch } from './queryNormalization.ts';

/** A resolved canonical entity + the fields it can prefill (§17). */
export interface ResolvedEntity {
  entityType: EntityType;
  entityId: string;
  canonicalUri?: string;
  displayName: string;
  /** Dependent-field prefill values (visible + editable at the call site, §17). */
  prefill?: {
    cityId?: string;
    countryId?: string;
    lat?: number;
    lng?: number;
    timezone?: string;
  };
}

/** Options for {@link resolveSuggestion}. */
export interface ResolveOptions {
  /**
   * The field's LIVE policy. Without it nothing is resolved locally: the local
   * index is gated per field, and an unknown field is a closed one.
   */
  policy?: LocalZeroStatePolicy | null;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The §17 prefill a retained row's server binding carried, or undefined.
 * Read defensively: `structuredValue` is `unknown` on the wire, and a value
 * that is not the shape is ignored rather than coerced. A coordinate is taken
 * only as a PAIR — never half a position.
 */
function prefillFrom(structured: unknown): ResolvedEntity['prefill'] | undefined {
  if (!structured || typeof structured !== 'object') return undefined;
  const b = structured as Record<string, unknown>;
  const out: NonNullable<ResolvedEntity['prefill']> = {};
  if (typeof b.cityId === 'string' && b.cityId.length > 0) out.cityId = b.cityId;
  if (finite(b.lat) && finite(b.lng)) {
    out.lat = b.lat;
    out.lng = b.lng;
  }
  if (typeof b.timezone === 'string' && b.timezone.length > 0) out.timezone = b.timezone;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The assistance types an unresolved row may have and still be bound. */
const BINDABLE_TYPES: ReadonlySet<InputSuggestion['type']> = new Set(['entity', 'recent']);

/**
 * The retained canonical row an UNRESOLVED suggestion denotes in this field, or
 * null. Synchronous: the local index is in process memory. See the header for
 * every reason this returns null.
 */
export function resolveLocally(
  suggestion: InputSuggestion,
  policy: LocalZeroStatePolicy | null | undefined,
): InputSuggestion | null {
  if (!policy) return null;
  if (suggestion.entityId) return null; // already resolved — nothing to do locally
  // Only a row that stands for a THING of a named class may be bound. A
  // completion, correction, action or AI row carries the person's own text or a
  // parse; binding one would turn an explicit "Search …" tap into an entity pick
  // (verifier finding F1, 2026-10-07). A row with no entity class has nothing to
  // match a class against, so it is never bound either.
  if (!BINDABLE_TYPES.has(suggestion.type) || !suggestion.entityType) return null;
  const key = foldForMatch(suggestion.replacementText ?? suggestion.label ?? '');
  if (!key) return null;

  // Every retained row the LIVE policy still lets this field read (an empty
  // list for a field that may not retain), at the full retention depth.
  const retained = localZeroState({ ...policy, maxSuggestions: Number.MAX_SAFE_INTEGER });
  const matches = new Map<string, InputSuggestion>();
  for (const r of retained) {
    if (!r.entityType || !r.entityId) continue;
    if (suggestion.entityType && r.entityType !== suggestion.entityType) continue;
    if (foldForMatch(r.label) !== key && foldForMatch(r.replacementText ?? '') !== key) continue;
    const id = `${r.entityType}:${r.entityId}`;
    if (!matches.has(id)) matches.set(id, r);
  }
  if (matches.size !== 1) return null; // none, or AMBIGUOUS — never an auto-pick (§19)
  return [...matches.values()][0] ?? null;
}

/**
 * The suggestion as it should be ACCEPTED: unchanged when it is already bound
 * or cannot be bound unambiguously; otherwise the same row carrying the
 * retained row's canonical identity, action, canonical uri and §17 binding.
 * Its label, replacement text and `source` are kept — the row the person tapped
 * is still the row that was accepted, and `source: 'local'` stays honest about
 * where it was offered from.
 */
export function bindLocally(
  suggestion: InputSuggestion,
  policy: LocalZeroStatePolicy | null | undefined,
): InputSuggestion {
  const hit = resolveLocally(suggestion, policy);
  if (!hit) return suggestion;
  const bound: InputSuggestion = {
    ...suggestion,
    entityType: hit.entityType,
    entityId: hit.entityId,
  };
  if (hit.action) bound.action = hit.action;
  if (hit.canonicalUri) bound.canonicalUri = hit.canonicalUri;
  if (hit.structuredValue !== undefined) bound.structuredValue = hit.structuredValue;
  return bound;
}

/**
 * Resolve an accepted suggestion to a canonical entity.
 *
 * A suggestion that already carries a canonical entityType+entityId (the server
 * projection usually does) is surfaced as-is. An unresolved one is resolved
 * against the field's retained canonical rows ({@link resolveLocally}): exactly
 * one distinct match binds; none, a class mismatch, or an ambiguous label
 * returns null so the caller keeps the raw user selection (§2 preserve input on
 * low confidence).
 */
export async function resolveSuggestion(
  suggestion: InputSuggestion,
  opts: ResolveOptions = {},
): Promise<ResolvedEntity | null> {
  if (suggestion.entityType && suggestion.entityId) {
    return {
      entityType: suggestion.entityType,
      entityId: suggestion.entityId,
      canonicalUri: suggestion.canonicalUri,
      displayName: suggestion.label,
    };
  }
  const hit = resolveLocally(suggestion, opts.policy);
  if (!hit) return null;
  const resolved: ResolvedEntity = {
    entityType: hit.entityType as EntityType,
    entityId: hit.entityId as string,
    displayName: hit.label,
  };
  if (hit.canonicalUri) resolved.canonicalUri = hit.canonicalUri;
  const prefill = prefillFrom(hit.structuredValue);
  if (prefill) resolved.prefill = prefill;
  return resolved;
}
