/**
 * §33 "prefetch likely NEXT-FIELD entities" / §53 "→ prefetch → next fields
 * inherit" (census G209, G361).
 *
 * After a canonical selection in a field, the field a person fills NEXT on the
 * same screen is asked for its zero-character answer — the request it would send
 * itself when focused — and the answer is written into the shared suggestion
 * cache under exactly the key that field's hook reads. Its first render is then a
 * cache hit with no network.
 *
 * WHICH FIELD IS NEXT is declared, not guessed: `FIELD_DEPENDENTS` below is the
 * cross-field graph for the screens that mount a dependent pair (§17 owns the
 * graph; G109's binding is its value half — this is its field half). A field
 * with no declared dependent prefetches nothing.
 *
 * WHAT IS NEVER PREFETCHED: a field whose privacy class keeps it out of the
 * shared cache (viewer-scoped, sensitive, private message) — nothing would be
 * written, so nothing is asked; a field with no zero-state; an answer the server
 * marked as an outage (`refusal`), which the hook itself never caches either.
 * A prefetch never retains anything on the device (G200 retention is the
 * field's own, on its own serve) and emits no impression telemetry: nothing was
 * shown. Fire-and-forget: it never throws and never blocks the selection.
 */
import type { InputContext } from '../types/inputContext.ts';
import { resolveFieldPolicy } from '../contexts/fieldRegistry.ts';
import { getContextDescriptor } from '../contexts/inputContexts.ts';
import { capabilitySignature, SDK_CAPABILITIES, type ClientCapabilities } from '../contexts/clientCapabilities.ts';
import { sharedSuggestionCache, SuggestionCache, isCacheablePrivacyClass } from './suggestionCache.ts';
import { finalizeSuggestions } from './suggestionRanking.ts';
import { GEO_FIELD_IDS } from '../geographic/geoFields.ts';
import type { SuggestRequest, SuggestResult } from '../types/inputSuggestion.ts';

/** The transport. The shared client by default, loaded lazily: it reaches the Supabase-backed token helper, which cannot load under node:test (voiceIntake.ts uses the same form). */
export type PrefetchRequest = (req: SuggestRequest) => Promise<SuggestResult>;
async function sharedRequest(req: SuggestRequest): Promise<SuggestResult> {
  const mod = await import('./inputAssistance.ts');
  return mod.requestSuggestions(req);
}

/** A field to warm: its id, its context, and the capabilities its mount declares (part of its cache key). */
export interface DependentField {
  fieldId: string;
  context: InputContext;
  capabilities?: ClientCapabilities;
}

/**
 * The declared next fields. Gem wizard (`app/gems/submit.tsx`): after the place
 * picker resolves the Gem's location, the Neighbourhood field (a SmartInput, so
 * it declares the shared overlay's capabilities) is next.
 */
export const FIELD_DEPENDENTS: Readonly<Record<string, readonly DependentField[]>> = {
  [GEO_FIELD_IDS.gemLocation]: [
    { fieldId: GEO_FIELD_IDS.neighborhoodPicker, context: 'neighborhood_picker', capabilities: SDK_CAPABILITIES },
  ],
};

/** The cache key the dependent field's hook reads for its EMPTY text (useInputAssistance's own construction). */
export function zeroStateCacheKey(field: DependentField): string {
  const capKey = capabilitySignature(field.capabilities);
  const cacheFieldId = capKey ? `${field.fieldId}::cap:${capKey}` : field.fieldId;
  return SuggestionCache.key(cacheFieldId, '', null, null);
}

/**
 * Warm one field's zero-character answer. Resolves to what happened, for tests
 * and telemetry-free diagnostics: 'skipped' (not cacheable / no zero-state /
 * no policy), 'cached' (already warm), 'warmed', or 'failed'.
 */
export async function prefetchZeroState(field: DependentField, request: PrefetchRequest = sharedRequest): Promise<'skipped' | 'cached' | 'warmed' | 'failed'> {
  try {
    const policy = resolveFieldPolicy(field.fieldId, field.context);
    if (!policy) return 'skipped';
    if (!isCacheablePrivacyClass(policy.privacyClass)) return 'skipped';
    if (getContextDescriptor(policy.context).zeroStateAssistance !== true) return 'skipped';
    const key = zeroStateCacheKey(field);
    if (sharedSuggestionCache.get(key)) return 'cached';
    const res = await request({
      context: policy.context,
      fieldId: field.fieldId,
      text: '',
      limit: policy.maxSuggestions,
      client: field.capabilities,
    });
    if (!res.ok || res.refusal) return 'failed';
    sharedSuggestionCache.set(key, finalizeSuggestions(res.suggestions, policy.maxSuggestions));
    return 'warmed';
  } catch {
    return 'failed';
  }
}

/** After a canonical selection in `fieldId`: warm every declared next field. Fire-and-forget. */
export function prefetchDependentFields(fieldId: string | null | undefined, request?: PrefetchRequest): Promise<Array<'skipped' | 'cached' | 'warmed' | 'failed'>> {
  const deps = fieldId ? FIELD_DEPENDENTS[fieldId] ?? [] : [];
  return Promise.all(deps.map((d) => prefetchZeroState(d, request)));
}
