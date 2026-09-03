/**
 * Global Input Intelligence — Phase 7 (Compass + AI): field registration (§5/§52).
 *
 * Registers the canonical fieldIds for the compass-prompt surfaces and the two
 * AI-writing contexts NOT already owned by another phase. Mirrors
 * `creation/creationFields.ts`, `search/searchFields.ts`, etc.
 *
 * SCOPE NOTE: the writing TITLE fields `event.title` / `trip.title` / `plan.title`
 * are already registered by `creation/creationFields.ts` (their policies already
 * allow `ai_suggestion` + `allowAI`), so this module does NOT re-register them —
 * that would fork the creation policy. It registers only `post.caption` and
 * `event.description`, which the creation phase does not own.
 *
 * `registerCompassFields()` is idempotent and safe to call at module load or on
 * any screen mount. Pure registry operation (no React/network) — unit-testable.
 */
import type { InputContext } from '../types/inputContext.ts';
import { registerField, isFieldRegistered } from '../contexts/fieldRegistry.ts';

/** Compass-prompt fieldIds (all resolve to the `compass_prompt` context). */
export const COMPASS_FIELD_IDS = {
  /** The AI tab's prompt bar (`app/(tabs)/ai.tsx`). */
  compassPrompt: 'compass.prompt',
  /** The Trip-surface Concierge command bar. */
  commandBar: 'compass.commandbar',
  /** The map's "Ask Compass" bar. */
  mapAskCompass: 'map.askCompass',
} as const;

export type CompassFieldId = (typeof COMPASS_FIELD_IDS)[keyof typeof COMPASS_FIELD_IDS];

/** AI-writing fieldIds owned by this phase (the two not owned by creation). */
export const AI_WRITING_FIELD_IDS = {
  /** Post/media caption composer (pulse / postcard / highlight / story / memory). */
  caption: 'post.caption',
  /** Event description composer. */
  eventDescription: 'event.description',
} as const;

export type AiWritingFieldId = (typeof AI_WRITING_FIELD_IDS)[keyof typeof AI_WRITING_FIELD_IDS];

export const COMPASS_FIELD_CONTEXTS: Record<CompassFieldId, InputContext> = {
  [COMPASS_FIELD_IDS.compassPrompt]: 'compass_prompt',
  [COMPASS_FIELD_IDS.commandBar]: 'compass_prompt',
  [COMPASS_FIELD_IDS.mapAskCompass]: 'compass_prompt',
};

export const AI_WRITING_FIELD_CONTEXTS: Record<AiWritingFieldId, InputContext> = {
  [AI_WRITING_FIELD_IDS.caption]: 'caption',
  [AI_WRITING_FIELD_IDS.eventDescription]: 'event_description',
};

let done = false;

/**
 * Register every compass-prompt + phase-owned AI-writing field policy. Idempotent
 * — repeated calls are a no-op after the first, and a field already registered
 * (e.g. by a test or another phase) is left untouched.
 */
export function registerCompassFields(): void {
  if (done) return;
  for (const [fieldId, context] of Object.entries(COMPASS_FIELD_CONTEXTS)) {
    if (!isFieldRegistered(fieldId)) registerField(fieldId, context);
  }
  for (const [fieldId, context] of Object.entries(AI_WRITING_FIELD_CONTEXTS)) {
    if (!isFieldRegistered(fieldId)) registerField(fieldId, context);
  }
  done = true;
}

/** Test-only: reset the idempotency latch so registration can be re-exercised. */
export function _resetCompassRegistration(): void {
  done = false;
}
