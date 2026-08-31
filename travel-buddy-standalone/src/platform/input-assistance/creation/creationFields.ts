/**
 * Global Input Intelligence — Phase 5 (Creation): field registration.
 *
 * §5/§52: a field joins the platform by registering a policy, not by building a
 * new engine. This registers the canonical fieldIds for the creation NAME/TITLE
 * surfaces (the free-text fields that drive duplicate detection + §23 validation).
 * Mirrors `search/searchFields.ts`, `social/socialFields.ts`, `geographic/geoFields.ts`.
 *
 * SCOPE NOTE: the creation LOCATION fields (gem/event/trip location) are already
 * registered by `geographic/geoFields.ts` (`gem.location` / `event.location` /
 * `trip.destination`) — this module does NOT re-register them (that would fork the
 * geographic policy). It registers only the name/title fields the geographic phase
 * does not own.
 *
 * The gem-name field overrides `minChars` to 2 (its context default) but is kept
 * explicit here so duplicate detection begins only once a couple of characters are
 * typed (§33) — a single letter is not a meaningful name to dedupe.
 *
 * `registerCreationFields()` is idempotent and safe to call at module load or on
 * any screen mount. Pure registry operation (no React/network) — unit-testable.
 */
import type { InputContext } from '../types/inputContext.ts';
import { registerField, isFieldRegistered } from '../contexts/fieldRegistry.ts';

/**
 * Canonical fieldIds for the creation surfaces. `gem.name` / `event.title` /
 * `trip.title` / `plan.title` match the ids used in the client audit's §50 field
 * table (section C — Creation).
 */
export const CREATION_FIELD_IDS = {
  gemName: 'gem.name',
  eventTitle: 'event.title',
  tripTitle: 'trip.title',
  planTitle: 'plan.title',
} as const;

export type CreationFieldId = (typeof CREATION_FIELD_IDS)[keyof typeof CREATION_FIELD_IDS];

/** fieldId → InputContext for every creation name/title field. */
export const CREATION_FIELD_CONTEXTS: Record<CreationFieldId, InputContext> = {
  [CREATION_FIELD_IDS.gemName]: 'hidden_gem_name',
  [CREATION_FIELD_IDS.eventTitle]: 'event_title',
  [CREATION_FIELD_IDS.tripTitle]: 'trip_title',
  [CREATION_FIELD_IDS.planTitle]: 'plan_title',
};

let done = false;

/**
 * Register every creation name/title field's policy. Idempotent — repeated calls
 * are a no-op after the first, and a field already registered (e.g. by a test) is
 * left untouched.
 */
export function registerCreationFields(): void {
  if (done) return;
  for (const [fieldId, context] of Object.entries(CREATION_FIELD_CONTEXTS)) {
    if (!isFieldRegistered(fieldId)) registerField(fieldId, context);
  }
  done = true;
}

/** Test-only: reset the idempotency latch so registration can be re-exercised. */
export function _resetCreationRegistration(): void {
  done = false;
}
