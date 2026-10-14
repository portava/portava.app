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
 * that would fork the creation policy. It registers `post.caption`, `event.description`
 * and (G141) `postcard.caption` + `memory.caption`, all under existing contexts.
 *
 * `registerCompassFields()` is idempotent and safe to call at module load or on
 * any screen mount. Pure registry operation (no React/network) — unit-testable.
 */
import type { InputContext } from '../types/inputContext.ts'; import type { InputFieldPolicy } from '../types/fieldPolicy.ts';
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
  postcardCaption: 'postcard.caption', // G141 — the Postcard composer's caption (PostcardComposer.tsx). Its own id, so the server polishes the traveller's words and adds no fact.
  caption: 'post.caption', // Post/media caption composer (pulse / highlight / story). Postcards and Memories have their own ids (G141).
  memoryCaption: 'memory.caption', // G141 — the Memory caption on /memory/new and /memory/edit. The same server rule, plus the owner's controls on an existing Memory.
  eventDescription: 'event.description', // Event description composer.
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
  [AI_WRITING_FIELD_IDS.postcardCaption]: 'caption',
  [AI_WRITING_FIELD_IDS.memoryCaption]: 'caption',
};
/** G141: a Postcard or Memory draft is its writer's until it is published, so its AI proposals never enter the shared suggestion cache (§29: only `public` is cacheable). Narrower, never wider, than the `caption` context. */ const AI_WRITING_FIELD_OVERRIDES: Partial<Record<AiWritingFieldId, Partial<InputFieldPolicy>>> = { [AI_WRITING_FIELD_IDS.postcardCaption]: { privacyClass: 'owner_only' }, [AI_WRITING_FIELD_IDS.memoryCaption]: { privacyClass: 'owner_only' } };
let done = false;
/**
 * Register every compass-prompt + phase-owned AI-writing field policy. Idempotent — repeated calls are a no-op
 * after the first, and a field already registered (e.g. by a test or another phase) is left untouched.
 */
export function registerCompassFields(): void {
  if (done) return;
  for (const [fieldId, context] of Object.entries(COMPASS_FIELD_CONTEXTS)) {
    if (!isFieldRegistered(fieldId)) registerField(fieldId, context);
  }
  for (const [fieldId, context] of Object.entries(AI_WRITING_FIELD_CONTEXTS)) {
    if (!isFieldRegistered(fieldId)) registerField(fieldId, context, AI_WRITING_FIELD_OVERRIDES[fieldId as AiWritingFieldId]);
  }
  done = true;
}

/** Test-only: reset the idempotency latch so registration can be re-exercised. */
export function _resetCompassRegistration(): void {
  done = false;
}
