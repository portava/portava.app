/**
 * Global Input Intelligence — default field policies (spec §6).
 *
 * Builds a concrete `InputFieldPolicy` for a fieldId from its context
 * descriptor. Screens register a field by calling `registerField` (see
 * fieldRegistry.ts) with a context and optional overrides — they never
 * hand-author the whole policy, so defaults stay consistent across the app
 * (§52 "add fields by registering a policy and consuming shared primitives").
 */
import type { InputContext, PrivacyClass } from '../types/inputContext.ts';
import type { InputFieldPolicy, InputTelemetryPolicy } from '../types/fieldPolicy.ts';
import { getContextDescriptor } from './inputContexts.ts';

/**
 * §33 — recommended debounce is 100–150 ms. The legacy `useSearchSuggestions`
 * used 250 ms; this new spine adopts the spec's tighter default and lets a
 * field override it. Distinct constant so the number is auditable in one place.
 */
export const DEFAULT_DEBOUNCE_MS = 120;

/** §41 example `limit: 8` — default cap on visible suggestions per field. */
export const DEFAULT_MAX_SUGGESTIONS = 8;

/**
 * §44 — private-message and sensitive fields must never capture raw text.
 * Derive the telemetry policy from the field's privacy class so this rule is
 * enforced structurally rather than remembered per-screen.
 */
function defaultTelemetryPolicy(privacyClass: PrivacyClass): InputTelemetryPolicy {
  const captureRawText = privacyClass === 'public';
  return { captureRawText, events: 'all' };
}

/** Deep-ish clone of the mutable array fields so callers can't mutate the shared
 *  descriptor arrays through a returned policy. */
function cloneArrays<T>(arr: readonly T[]): T[] {
  return arr.slice();
}

/**
 * Build the default `InputFieldPolicy` for a field of the given context. Pass
 * `overrides` to tune any field-specific value (e.g. a shorter maxLength for a
 * username, a custom debounce). Overrides are shallow-merged over the default.
 */
export function buildDefaultPolicy(
  fieldId: string,
  context: InputContext,
  overrides: Partial<InputFieldPolicy> = {},
): InputFieldPolicy {
  const d = getContextDescriptor(context);

  const base: InputFieldPolicy = {
    fieldId,
    context,
    mode: d.defaultMode,
    allowedSuggestionTypes: cloneArrays(d.allowedSuggestionTypes),
    entityTypes: d.entityTypes.length ? cloneArrays(d.entityTypes) : undefined,
    allowPersonalization: d.allowPersonalization,
    allowLiveContext: d.allowLiveContext,
    allowMemoryContext: d.allowMemoryContext,
    allowAI: d.allowAI,
    minChars: d.minChars,
    maxSuggestions: DEFAULT_MAX_SUGGESTIONS,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    offlinePolicy: d.offlinePolicy,
    privacyClass: d.privacyClass,
    validationRules: undefined,
    telemetryPolicy: defaultTelemetryPolicy(d.privacyClass),
  };

  // Shallow-merge overrides. If the override changes privacyClass but not the
  // telemetry policy, re-derive telemetry so the "no raw text for private"
  // invariant can't be silently broken by a privacy override.
  const merged: InputFieldPolicy = { ...base, ...overrides, fieldId, context };
  if (overrides.privacyClass && !overrides.telemetryPolicy) {
    merged.telemetryPolicy = defaultTelemetryPolicy(overrides.privacyClass);
  }
  return merged;
}
