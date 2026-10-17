/**
 * §45 / OD-INPUT-1 (census G320) — which input fields served a task, carried to
 * the moment the task completes.
 *
 * `reportInputTaskOutcome` has to be called by the screen that sees the task
 * finish, and by then the field that served it is closed. Census G320 named the
 * gap exactly: the creation screens "do not currently retain" the field that
 * served the creation. A screen records a `ServedField` when it ACCEPTS a
 * suggestion from a field, and calls `reportServedTask` once the task's write has
 * answered — `ok: true` when it succeeded, `ok: false` when it did not.
 *
 * WHAT IS CREDITED. Only what the field's server policy keeps per-user memory
 * of: the outcome route refuses a whole report whose entity type the policy does
 * not remember (`policyAdmitsMemory`), and refuses any field without
 * personalization. So `trip.destination` credits the canonical CITY it bound to,
 * and every other field reports the §44 event alone, with no entity.
 *
 * WHAT IS NOT DECIDED HERE. Consent. `reportInputTaskOutcome` does nothing at all
 * unless this account opted in to outcome learning (migration 3780, flag
 * `input_outcome_learning_enabled` seeded FALSE, disclosure awaiting approval),
 * and the server re-checks both. Recording which field served a task is a fact
 * about this screen's own state; it leaves the device only through that gate.
 *
 * Pure module — no React, no network — safe under node:test.
 */
import { GEO_FIELD_IDS } from '../geographic/geoFields.ts';
import { CREATION_FIELD_IDS } from '../creation/creationFields.ts';
import type { CanonicalPlaceBinding } from '../geographic/canonicalBinding.ts';
import {
  reportInputTaskOutcome,
  type InputOutcomeTask,
  type OutcomeEntity,
  type TaskOutcomeField,
} from './outcomeLearning.ts';

export const TRIP_DESTINATION_FIELD: TaskOutcomeField = { fieldId: GEO_FIELD_IDS.tripDestination, context: 'trip_destination' };
export const TRIP_TITLE_FIELD: TaskOutcomeField = { fieldId: CREATION_FIELD_IDS.tripTitle, context: 'trip_title' };
export const EVENT_LOCATION_FIELD: TaskOutcomeField = { fieldId: GEO_FIELD_IDS.eventLocation, context: 'event_location' };
export const EVENT_TITLE_FIELD: TaskOutcomeField = { fieldId: CREATION_FIELD_IDS.eventTitle, context: 'event_title' };

/** One field that served the task, and what a success credits to it. */
export interface ServedField {
  field: TaskOutcomeField;
  entities: readonly OutcomeEntity[];
}

/**
 * The trip destination accepted from the `trip.destination` picker. Credits the
 * canonical city it bound to (the same id the picker's gateway row carried, so
 * the outcome lands on the key selection memory uses); an unresolved, non-city
 * or absent binding credits nothing. No binding at all means the field did not
 * serve this destination (e.g. it came from the description pre-fill): null.
 */
export function tripDestinationServed(binding: CanonicalPlaceBinding | null | undefined): ServedField | null {
  if (!binding) return null;
  const canonicalId = typeof binding.canonicalId === 'string' ? binding.canonicalId.trim() : '';
  const entities: OutcomeEntity[] = binding.entityType === 'city' && canonicalId
    ? [{ entityType: 'city', entityId: canonicalId }]
    : [];
  return { field: TRIP_DESTINATION_FIELD, entities };
}

/** A field whose server policy keeps no per-user memory: the §44 event only. */
export function servedWithoutCredit(field: TaskOutcomeField): ServedField {
  return { field, entities: [] };
}

/**
 * Create trip (`app/trip/new.tsx`): the fields that served the trip being created.
 *
 *   - `trip.destination`, single-destination mode only. A multi-city stop comes
 *     from `DestinationListEditor`, whose picker is not an Input field (it passes
 *     no `assistContext`), so it is not served by one.
 *   - `trip.title`, only when an accepted AI proposal is STILL the title at create:
 *     a proposal the person then rewrote did not serve the trip.
 */
export function tripCreationServed(s: {
  multiCity: boolean;
  binding: CanonicalPlaceBinding | null | undefined;
  acceptedAiTitle: string | null;
  title: string;
}): ServedField[] {
  const out: ServedField[] = [];
  const destination = s.multiCity ? null : tripDestinationServed(s.binding);
  if (destination) out.push(destination);
  const accepted = (s.acceptedAiTitle ?? '').trim();
  if (accepted && accepted === s.title.trim()) out.push(servedWithoutCredit(TRIP_TITLE_FIELD));
  return out;
}

/**
 * Create event (`app/events/create/index.tsx`): the fields that served the event
 * being published — a location picked from `event.location` in this screen, and
 * a structured value applied from `event.title`. Neither field keeps per-user
 * memory (`event_location` and `event_title` have no personalization), so
 * neither credits an entity.
 */
export function eventCreationServed(s: { locationPicked: boolean; structuredValueApplied: boolean }): ServedField[] {
  const out: ServedField[] = [];
  if (s.locationPicked) out.push(servedWithoutCredit(EVENT_LOCATION_FIELD));
  if (s.structuredValueApplied) out.push(servedWithoutCredit(EVENT_TITLE_FIELD));
  return out;
}

/**
 * Report a finished task once per field that served it. A falsy entry is a field
 * that did not serve this task. A field named twice is reported once. Entities
 * are offered only on success (a failed task credits nothing). Never throws.
 * Returns how many fields were reported — 0 without consent.
 */
export function reportServedTask(
  served: ReadonlyArray<ServedField | null | undefined | false>,
  task: InputOutcomeTask,
  ok: boolean,
  report: typeof reportInputTaskOutcome = reportInputTaskOutcome,
): number {
  const seen = new Set<string>();
  let reported = 0;
  for (const s of served) {
    if (!s || seen.has(s.field.fieldId)) continue;
    seen.add(s.field.fieldId);
    try {
      if (report(s.field, task, ok, ok ? s.entities : []) === 'reported') reported += 1;
    } catch {
      // best-effort — an outcome report must never affect the task
    }
  }
  return reported;
}
