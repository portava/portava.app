/**
 * Global Input Intelligence — Phase 5 (Creation): the §23 validation-row bridge.
 *
 * §23 (Validation and Correction While Typing) — the validation table:
 *   - Duplicate Place/Gem      → show probable existing entity before creation.
 *   - City-country mismatch    → suggest canonical correction.
 *   - Trip date conflict       → explain conflict and preserve user control.
 *   - Unresolved address       → offer map pin / nearby candidates / raw fallback.
 *   - Invalid hashtag/handle   → explain normalization or reserved-name rules.
 *
 * This module maps the `validation` / `correction` suggestions the P1 gateway
 * emits on a creation stream (§8) into ONE `CreationValidationView` a creation
 * screen renders through the shared P1 `CorrectionBanner`. It never blocks the
 * field (§2 preserve user control): the view is advisory, dismissible, and offers
 * — never forces — a canonical correction.
 *
 * DEGRADE GRACEFULLY (§38): a stream with no validation/correction row maps to
 * `null` → the screen shows no banner and behaves exactly as today. Never throws.
 *
 * Pure module — no React, no network — unit-testable under node:test.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import type { ValidationRule } from '../types/fieldPolicy.ts';

/** The semantic §23 validation kinds a creation flow surfaces. */
export type CreationValidationKind =
  | 'duplicate'
  | 'city_country_mismatch'
  | 'date_conflict'
  | 'unresolved_address'
  | 'invalid_hashtag'
  | 'invalid_handle'
  | 'generic';

/** A banner-ready view of a single §23 validation/correction (CorrectionBanner). */
export interface CreationValidationView {
  kind: CreationValidationKind;
  /** Non-color-only severity cue for the banner (§46). Advisory — never a block. */
  tone: 'warning' | 'error';
  message: string;
  /** Canonical correction text the user MAY accept (§23), when the gateway offers one. */
  correctionText: string | null;
  /** Accept-affordance label, or null when there is nothing to apply (info-only). */
  acceptLabel: string | null;
  /** The original suggestion (for telemetry + so the screen can route/apply it). */
  suggestion: InputSuggestion;
}

/** Default, §23-faithful copy per kind when the projection carries no message. */
const DEFAULT_MESSAGE: Record<CreationValidationKind, string> = {
  duplicate: 'This may already exist — check the matches below.',
  city_country_mismatch: 'That city may not be in that country.',
  date_conflict: 'These dates overlap another trip.',
  unresolved_address: "We couldn't pin that address.",
  invalid_hashtag: "Hashtags can't contain spaces or symbols.",
  invalid_handle: 'That handle isn’t available or is reserved.',
  generic: 'Double-check this entry.',
};

/** Map a §6 `ValidationRule.kind` to the creation-facing validation kind. */
export function kindFromRule(ruleKind: ValidationRule['kind']): CreationValidationKind {
  switch (ruleKind) {
    case 'duplicate_entity':
      return 'duplicate';
    case 'city_country_match':
      return 'city_country_mismatch';
    case 'date_conflict':
      return 'date_conflict';
    case 'address_resolvable':
      return 'unresolved_address';
    case 'hashtag_format':
      return 'invalid_hashtag';
    case 'username_available':
      return 'invalid_handle';
    default:
      return 'generic';
  }
}

/** Read an optional string field off a projection's structuredValue bag. */
function structuredString(s: InputSuggestion, key: string): string | null {
  const bag = s.structuredValue;
  if (bag && typeof bag === 'object' && key in (bag as Record<string, unknown>)) {
    const v = (bag as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function clean(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s.length > 0 ? s : null;
}

const KNOWN_KINDS = new Set<CreationValidationKind>([
  'duplicate',
  'city_country_mismatch',
  'date_conflict',
  'unresolved_address',
  'invalid_hashtag',
  'invalid_handle',
  'generic',
]);

/**
 * Determine the validation kind a suggestion represents. Prefers an explicit
 * `structuredValue.kind` (either a creation kind or a §6 rule kind), then falls
 * back to `generic`. Correction rows with no kind read as `generic`.
 */
function kindOf(s: InputSuggestion): CreationValidationKind {
  const raw = structuredString(s, 'kind');
  if (raw) {
    if (KNOWN_KINDS.has(raw as CreationValidationKind)) return raw as CreationValidationKind;
    // Also accept a §6 ValidationRule.kind spelling (e.g. "city_country_match").
    const mapped = kindFromRule(raw as ValidationRule['kind']);
    if (mapped !== 'generic' || raw === 'generic') return mapped;
  }
  return 'generic';
}

/** The canonical correction text a suggestion offers, if any (§23). */
function correctionTextOf(s: InputSuggestion): string | null {
  const fromReplacement = clean(s.replacementText);
  if (fromReplacement) return fromReplacement;
  const action = s.action;
  if (action && action.type === 'replace_text') return clean(action.text);
  return null;
}

/**
 * Map a single validation/correction suggestion into a banner view. Returns null
 * for any other suggestion type (an entity/completion/action row is not a §23
 * validation).
 */
export function suggestionToValidation(s: InputSuggestion): CreationValidationView | null {
  const isValidation = s.type === 'validation';
  const isCorrection = s.type === 'correction';
  if (!isValidation && !isCorrection) return null;

  const kind = kindOf(s);
  const correctionText = correctionTextOf(s);
  const message =
    clean(s.reason) ?? clean(s.subtitle) ?? clean(s.label) ?? DEFAULT_MESSAGE[kind];

  // Advisory severity only (§2 non-blocking): a high-confidence hard validation
  // (e.g. a reserved handle) reads as `error`; everything else is a `warning`.
  const tone: 'warning' | 'error' =
    isValidation && (s.confidence ?? 0) >= 0.9 ? 'error' : 'warning';

  // Only offer an accept affordance when there is something to apply. The
  // unresolved-address fallback (map pin / nearby / raw) is owned by the screen,
  // not a single "use this", so it stays info-only here.
  const acceptLabel =
    correctionText && kind !== 'unresolved_address'
      ? kind === 'city_country_mismatch'
        ? 'Use canonical'
        : 'Use this'
      : null;

  return { kind, tone, message, correctionText, acceptLabel, suggestion: s };
}

/**
 * Pick the single most relevant §23 validation to surface from a creation stream.
 * A `validation` row wins over a `correction` row (a validation is a stronger
 * signal); within a type the first (highest-ranked) wins. Returns null when the
 * stream carries none → the screen shows no banner (graceful degrade, §38).
 */
export function mapCreationValidation(
  suggestions: InputSuggestion[] | null | undefined,
): CreationValidationView | null {
  const list = suggestions ?? [];
  const validation = list.find((s) => s.type === 'validation');
  if (validation) return suggestionToValidation(validation);
  const correction = list.find((s) => s.type === 'correction');
  if (correction) return suggestionToValidation(correction);
  return null;
}
