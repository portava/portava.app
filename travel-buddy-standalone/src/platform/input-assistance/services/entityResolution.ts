/**
 * Global Input Intelligence — entity resolution (spec §11, §17, §53).
 *
 * STUB (Phase 1). The system must resolve accepted user text to CANONICAL
 * entities, not strings (§11), and populate dependent fields from the selection
 * (§17 cross-field graph: Venue → City/Country/Coordinates/Timezone).
 *
 * The runtime already exists per-domain — `src/lib/location/resolveCanonical.ts`
 * and `POST /api/locations/resolve` do find-or-create canonical binding for
 * places today. A LATER PHASE (2: Geographic Core) wraps those behind this
 * uniform interface so every canonical_picker field resolves the same way. This
 * file intentionally defines only the contract + a safe no-op so the spine
 * compiles and consumers can depend on the shape now.
 *
 * Kept dependency-free (no supabase import) so it is safe to import anywhere,
 * including node:test.
 */
import type { EntityType } from '../types/inputContext.ts';
import type { InputSuggestion } from '../types/inputSuggestion.ts';

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

/**
 * Resolve an accepted suggestion to a canonical entity.
 *
 * Phase 1: pass-through — if the suggestion already carries a canonical
 * entityType+entityId (the server projection usually does), surface it as-is;
 * otherwise return null so the caller keeps the raw user selection (§2 preserve
 * input on low confidence). Phase 2 replaces the null branch with a call into
 * the canonical resolver.
 */
export async function resolveSuggestion(
  suggestion: InputSuggestion,
): Promise<ResolvedEntity | null> {
  if (suggestion.entityType && suggestion.entityId) {
    return {
      entityType: suggestion.entityType,
      entityId: suggestion.entityId,
      canonicalUri: suggestion.canonicalUri,
      displayName: suggestion.label,
    };
  }
  // Phase 2: resolve free text / provider candidates via resolveCanonical.
  return null;
}
