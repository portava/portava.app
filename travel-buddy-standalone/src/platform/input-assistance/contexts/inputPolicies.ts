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
import type {
  InputFieldPolicy,
  InputTelemetryEventName,
  InputTelemetryPolicy,
} from '../types/fieldPolicy.ts';
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
 * §44 — the per-field telemetry policy, derived from the field's privacy class
 * so the rule is structural rather than remembered per-screen.
 *
 * TWO THINGS CHANGED HERE ON 2026-09-21, both because census G33 recorded that
 * the two sides declared DIFFERENT SHAPES for this member and a server policy
 * change therefore could not reach the client.
 *
 * 1. The shape is now the server's: `{ logRawText, events: string[] }`. The
 *    old one named the raw-text gate differently and allowed an `'all'`
 *    sentinel in `events`; neither existed on the server side.
 *
 * 2. `logRawText` is FALSE for every class, which is what the server's registry
 *    has always said (`STANDARD_TELEMETRY` and `METADATA_ONLY_TELEMETRY` both
 *    set it false on all 29 contexts). The old rule here — capture raw text
 *    whenever the class is `public` — was not merely a different default: it
 *    was evaluated against the client's OWN taxonomy, in which
 *    `hidden_gem_name` and `comment` were `public`. The server calls those two
 *    sensitive-location and viewer-scoped. So the client's gate said "capture
 *    the raw text" for a Hidden Gem name and a comment body while the authority
 *    said the opposite, and only the fact that `setTelemetrySink` is called
 *    from no non-test file kept it latent. That is the same shape of defect
 *    d4db6009 found on `allowPersonalization`, one member over.
 *
 * The EVENT list is narrowed for `private_message`, mirroring the server's
 * `METADATA_ONLY_TELEMETRY`, and is the full §44 vocabulary otherwise.
 */
const STANDARD_TELEMETRY_EVENTS: InputTelemetryEventName[] = [
  'input_opened',
  'query_length_changed',
  'suggestion_request_started',
  'suggestion_request_completed',
  'suggestion_rendered',
  'suggestion_selected',
  'suggestion_dismissed',
  'raw_search_submitted',
  'manual_value_kept',
  'validation_shown',
  'correction_accepted',
  'disambiguation_selected',
  'action_completed',
  'downstream_task_completed',
];

/** Mirrors the server's METADATA_ONLY_TELEMETRY, member for member. */
const METADATA_ONLY_TELEMETRY_EVENTS: InputTelemetryEventName[] = [
  'suggestion_request_completed',
  'suggestion_selected',
  'action_completed',
];

function defaultTelemetryPolicy(privacyClass: PrivacyClass): InputTelemetryPolicy {
  return {
    logRawText: false,
    events:
      privacyClass === 'private_message'
        ? METADATA_ONLY_TELEMETRY_EVENTS.slice()
        : STANDARD_TELEMETRY_EVENTS.slice(),
  };
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
