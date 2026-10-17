/**
 * servedTaskOutcome — the field that served a task, carried to the moment the
 * task completes (§45 / OD-INPUT-1, census G320).
 *
 * Driven through the REAL reporter, the REAL consent gate and a telemetry sink
 * spy, so what is asserted is what would leave the device.
 *
 *   S1  without consent nothing is emitted and nothing is posted;
 *   S2  a trip destination bound to a canonical city: the §44 outcome event, and
 *       on success the city credited under the field's own context;
 *   S3  a failed task emits ok:false and credits nothing;
 *   S4  an unresolved or non-city binding emits, credits nothing; no binding is
 *       "the field did not serve this task";
 *   S5  a field without per-user memory reports the event alone;
 *   S6  one report per field, and a throwing reporter never escapes;
 *   S7  each field id/context pair is the one the screens register;
 *   S8  Create trip: the picked single destination and a still-standing AI title
 *       served it; a multi-city stop, a pre-filled destination and a rewritten
 *       AI title did not;
 *   S9  Create event: a picked location and an applied title value served it.
 *
 * Run: node --import tsx/esm --test src/platform/input-assistance/services/__tests__/servedTaskOutcome.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_LOCATION_FIELD,
  EVENT_TITLE_FIELD,
  TRIP_DESTINATION_FIELD,
  TRIP_TITLE_FIELD,
  eventCreationServed,
  reportServedTask,
  servedWithoutCredit,
  tripCreationServed,
  tripDestinationServed,
} from '../servedTaskOutcome.ts';
import {
  applyOutcomeConsent,
  beginOutcomeAccount,
  setOutcomePoster,
  type TaskOutcomeBody,
} from '../outcomeLearning.ts';
import { setTelemetrySink, resetTelemetrySink, type InputTelemetryEvent } from '../inputTelemetry.ts';
import { GEO_FIELD_CONTEXTS, GEO_FIELD_IDS } from '../../geographic/geoFields.ts';
import { CREATION_FIELD_CONTEXTS, CREATION_FIELD_IDS } from '../../creation/creationFields.ts';
import type { CanonicalPlaceBinding } from '../../geographic/canonicalBinding.ts';

const CITY = '22222222-2222-4222-8222-222222222222';

function binding(over: Partial<CanonicalPlaceBinding> = {}): CanonicalPlaceBinding {
  return {
    entityType: 'city', entityId: CITY, canonicalId: CITY, displayName: 'Da Nang, Vietnam',
    city: 'Da Nang', country: 'Vietnam', countryCode: 'VN', neighborhood: null,
    lat: 16.0544, lng: 108.2022, timezone: 'Asia/Ho_Chi_Minh', resolved: true, ...over,
  };
}

function harness(consented: boolean) {
  const events: InputTelemetryEvent[] = [];
  const posts: TaskOutcomeBody[] = [];
  setTelemetrySink((e) => { events.push(e); });
  setOutcomePoster(async (b) => { posts.push(b); return true; });
  beginOutcomeAccount('owner-1');
  if (consented) applyOutcomeConsent('owner-1', true);
  return { events, posts };
}

afterEach(() => {
  resetTelemetrySink();
  setOutcomePoster(null);
  beginOutcomeAccount(null);
});

test('S1: without consent, a served task emits nothing and posts nothing', () => {
  const h = harness(false);
  assert.equal(reportServedTask([tripDestinationServed(binding())], 'trip_created', true), 0);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.posts, []);
});

test('S2: a trip destination bound to a canonical city — the outcome event, and the city credited on success', () => {
  const h = harness(true);
  assert.equal(reportServedTask([tripDestinationServed(binding())], 'trip_created', true), 1);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.name, 'downstream_task_completed');
  assert.equal(h.events[0]!.fieldId, 'trip.destination');
  assert.equal(h.events[0]!.context, 'trip_destination');
  assert.deepEqual(h.events[0]!.props, { task: 'trip_created', ok: true });
  assert.deepEqual(h.posts, [{
    context: 'trip_destination', fieldId: 'trip.destination', task: 'trip_created', ok: true,
    entities: [{ entityType: 'city', entityId: CITY }],
  }]);
});

test('S3: a failed task is reported ok:false and credits nothing', () => {
  const h = harness(true);
  assert.equal(reportServedTask([tripDestinationServed(binding())], 'trip_created', false), 1);
  assert.deepEqual(h.events.map((e) => e.props), [{ task: 'trip_created', ok: false }]);
  assert.deepEqual(h.posts, []);
  const offered: unknown[] = [];
  reportServedTask([tripDestinationServed(binding())], 'trip_created', false, (_f, _t, _ok, entities) => { offered.push(entities); return 'reported'; });
  assert.deepEqual(offered, [[]], 'a failed task never even offers an entity to the reporter');
});

test('S4: an unresolved or non-city binding credits nothing; no binding means the field did not serve', () => {
  const h = harness(true);
  assert.deepEqual(tripDestinationServed(binding({ canonicalId: null, resolved: false }))!.entities, []);
  assert.deepEqual(tripDestinationServed(binding({ entityType: 'country' }))!.entities, []);
  assert.deepEqual(tripDestinationServed(binding({ canonicalId: '   ' }))!.entities, []);
  assert.equal(tripDestinationServed(null), null);
  assert.equal(tripDestinationServed(undefined), null);
  reportServedTask([tripDestinationServed(binding({ canonicalId: null, resolved: false })), tripDestinationServed(null)], 'trip_created', true);
  assert.equal(h.events.length, 1);
  assert.deepEqual(h.posts, []);
});

test('S5: a field without per-user memory reports the §44 event alone', () => {
  const h = harness(true);
  assert.equal(reportServedTask([servedWithoutCredit(EVENT_LOCATION_FIELD), servedWithoutCredit(EVENT_TITLE_FIELD)], 'event_created', true), 2);
  assert.deepEqual(h.events.map((e) => [e.fieldId, e.context, e.props]), [
    ['event.location', 'event_location', { task: 'event_created', ok: true }],
    ['event.title', 'event_title', { task: 'event_created', ok: true }],
  ]);
  assert.deepEqual(h.posts, []);
});

test('S6: one report per field, a falsy entry is skipped, and a throwing reporter never escapes', () => {
  const calls: unknown[][] = [];
  const n = reportServedTask(
    [tripDestinationServed(binding()), false, tripDestinationServed(binding()), servedWithoutCredit(TRIP_TITLE_FIELD)],
    'trip_created', true,
    (...a) => { calls.push(a); return 'reported'; },
  );
  assert.equal(n, 2);
  assert.deepEqual(calls.map((c) => (c[0] as { fieldId: string }).fieldId), ['trip.destination', 'trip.title']);
  assert.doesNotThrow(() => reportServedTask([servedWithoutCredit(TRIP_TITLE_FIELD)], 'trip_created', true, () => { throw new Error('boom'); }));
});

test('S7: each field id/context pair is the one the screens register', () => {
  assert.deepEqual(TRIP_DESTINATION_FIELD, { fieldId: GEO_FIELD_IDS.tripDestination, context: GEO_FIELD_CONTEXTS[GEO_FIELD_IDS.tripDestination] });
  assert.deepEqual(EVENT_LOCATION_FIELD, { fieldId: GEO_FIELD_IDS.eventLocation, context: GEO_FIELD_CONTEXTS[GEO_FIELD_IDS.eventLocation] });
  assert.deepEqual(TRIP_TITLE_FIELD, { fieldId: CREATION_FIELD_IDS.tripTitle, context: CREATION_FIELD_CONTEXTS[CREATION_FIELD_IDS.tripTitle] });
  assert.deepEqual(EVENT_TITLE_FIELD, { fieldId: CREATION_FIELD_IDS.eventTitle, context: CREATION_FIELD_CONTEXTS[CREATION_FIELD_IDS.eventTitle] });
});

test('S8: Create trip — which fields served the trip', () => {
  const ids = (xs: ReturnType<typeof tripCreationServed>) => xs.map((x) => x.field.fieldId);
  assert.deepEqual(ids(tripCreationServed({ multiCity: false, binding: binding(), acceptedAiTitle: null, title: 'Da Nang week' })), ['trip.destination']);
  assert.deepEqual(ids(tripCreationServed({ multiCity: true, binding: binding(), acceptedAiTitle: null, title: 'x' })), [], 'a multi-city stop is not served by an Input field');
  assert.deepEqual(ids(tripCreationServed({ multiCity: false, binding: null, acceptedAiTitle: null, title: 'x' })), [], 'a pre-filled destination has no binding');
  assert.deepEqual(ids(tripCreationServed({ multiCity: false, binding: null, acceptedAiTitle: 'Coastal Da Nang', title: ' Coastal Da Nang ' })), ['trip.title']);
  assert.deepEqual(ids(tripCreationServed({ multiCity: false, binding: null, acceptedAiTitle: 'Coastal Da Nang', title: 'My own words' })), [], 'a rewritten AI title did not serve');
  assert.deepEqual(ids(tripCreationServed({ multiCity: false, binding: null, acceptedAiTitle: '  ', title: '' })), []);
  assert.deepEqual(tripCreationServed({ multiCity: false, binding: binding(), acceptedAiTitle: null, title: 'x' })[0]!.entities, [{ entityType: 'city', entityId: CITY }]);
});

test('S9: Create event — a picked location and an applied title value served it, and credit nothing', () => {
  assert.deepEqual(eventCreationServed({ locationPicked: false, structuredValueApplied: false }), []);
  assert.deepEqual(
    eventCreationServed({ locationPicked: true, structuredValueApplied: true }).map((x) => [x.field.fieldId, x.entities.length]),
    [['event.location', 0], ['event.title', 0]],
  );
});
