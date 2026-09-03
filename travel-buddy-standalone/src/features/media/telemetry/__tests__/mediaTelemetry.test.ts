/**
 * mediaTelemetry tests (Media v2 spec §44/§45).
 *
 * The bar these tests hold the module to:
 *   1. every mapped media action resolves to the correct §45 north-star event,
 *      and every non-outcome action resolves to null (no fabricated outcomes);
 *   2. NOTHING that leaves this module carries raw private text (caption, note,
 *      message, comment, prompt, title, name, …) or a coordinate — checked by a
 *      forbidden-key sweep over the built payload and by direct guard tests;
 *   3. the payload is coarse metadata only — opaque ids + coarse enums;
 *   4. emit is fire-and-forget + fail-soft: a throwing recorder does NOT
 *      propagate, and a non-outcome action never calls the recorder.
 *
 * Pure node:test suite — imports only the telemetry module (no react-native).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mediaActionToNorthStar,
  buildNorthStarPayload,
  emitMediaNorthStar,
  hasForbiddenKey,
  isForbiddenKey,
  MEDIA_NORTH_STAR_EVENTS,
  type MediaNorthStarEvent,
  type MediaEventRecorder,
} from '../mediaTelemetry.ts';

// ── 1. Action → north-star mapping ────────────────────────────────────────────

test('maps each media action to its §45 north-star transition', () => {
  const expected: Record<string, MediaNorthStarEvent> = {
    show_on_map: 'media_place_open',
    view_experience: 'media_place_open',
    ask_compass: 'media_compass',
    create_plan: 'media_plan',
    do_this_experience: 'media_plan',
    add_to_trip: 'media_trip_add',
    report: 'media_correction',
  };
  for (const [actionId, event] of Object.entries(expected)) {
    assert.equal(mediaActionToNorthStar(actionId), event, `${actionId} → ${event}`);
  }
});

test('non-outcome actions (and unknown ids) map to null — never a fabricated outcome', () => {
  for (const actionId of [
    'see_nearby',
    'find_similar',
    'save',
    'meet_here',
    'i_want_this',
    'share_telegraph',
    'some_future_action',
    '',
  ]) {
    assert.equal(mediaActionToNorthStar(actionId), null, `${actionId} → null`);
  }
});

test('every mapped event is a member of the declared north-star vocabulary', () => {
  for (const actionId of [
    'show_on_map',
    'view_experience',
    'ask_compass',
    'create_plan',
    'do_this_experience',
    'add_to_trip',
    'report',
  ]) {
    const event = mediaActionToNorthStar(actionId);
    assert.ok(event && MEDIA_NORTH_STAR_EVENTS.includes(event), `${actionId} in vocabulary`);
  }
  // The vocabulary is the full §45 set of eight.
  assert.equal(MEDIA_NORTH_STAR_EVENTS.length, 8);
});

// ── 2/3. Payload is coarse metadata only, no raw text / coords ────────────────

test('buildNorthStarPayload carries only coarse metadata (opaque ids + enums)', () => {
  const payload = buildNorthStarPayload({
    mediaId: 'm_123',
    actionId: 'show_on_map',
    entityKind: 'place',
    placeId: 'p_456',
    tripId: 't_789',
    surface: 'action_rail',
  });
  assert.deepEqual(payload, {
    media_id: 'm_123',
    action_id: 'show_on_map',
    entity_kind: 'place',
    place_id: 'p_456',
    trip_id: 't_789',
    surface: 'action_rail',
  });
  // Every key in the built payload must be within the allowed set.
  const allowed = new Set(['media_id', 'action_id', 'entity_kind', 'place_id', 'trip_id', 'surface']);
  for (const key of Object.keys(payload)) assert.ok(allowed.has(key), `unexpected key ${key}`);
});

test('buildNorthStarPayload drops empty/absent fields — stays minimal', () => {
  assert.deepEqual(buildNorthStarPayload({ mediaId: 'm_1', actionId: 'ask_compass' }), {
    media_id: 'm_1',
    action_id: 'ask_compass',
  });
  assert.deepEqual(buildNorthStarPayload({ mediaId: '', placeId: null, tripId: undefined }), {});
});

test('the built payload never contains a forbidden (raw-text / coordinate) key', () => {
  const payload = buildNorthStarPayload({
    mediaId: 'm_1',
    actionId: 'show_on_map',
    entityKind: 'place',
    placeId: 'p_1',
    tripId: 't_1',
    surface: 'action_rail',
  });
  assert.equal(hasForbiddenKey(payload), false);
});

// ── Forbidden-key guard: the raw-text/coordinate denylist ─────────────────────

test('isForbiddenKey rejects raw private-text keys (§44 hygiene)', () => {
  for (const key of [
    'caption',
    'captionText',
    'note',
    'raw_note',
    'message',
    'comment',
    'text',
    'body',
    'prompt',
    'prefillMessage',
    'title',
    'name',
    'displayName',
    'description',
    'query',
    'transcript',
    'content',
  ]) {
    assert.equal(isForbiddenKey(key), true, `${key} is forbidden`);
  }
});

test('isForbiddenKey rejects precise-location keys (§44/§23 — never a coordinate)', () => {
  for (const key of [
    'lat',
    'latitude',
    'lng',
    'lon',
    'longitude',
    'coord',
    'coordinates',
    'geometry',
    'geohash',
    'address',
    'street',
    'postcode',
    'zipcode',
  ]) {
    assert.equal(isForbiddenKey(key), true, `${key} is forbidden`);
  }
});

test('isForbiddenKey allows the coarse metadata keys', () => {
  for (const key of ['media_id', 'action_id', 'entity_kind', 'place_id', 'trip_id', 'surface']) {
    assert.equal(isForbiddenKey(key), false, `${key} allowed`);
  }
});

test('hasForbiddenKey flags a payload that carries any forbidden key', () => {
  assert.equal(hasForbiddenKey({ media_id: 'm_1', caption: 'It is filling up fast' }), true);
  assert.equal(hasForbiddenKey({ media_id: 'm_1', lat: 16.06, lng: 108.2 }), true);
  assert.equal(hasForbiddenKey({ media_id: 'm_1', surface: 'action_rail' }), false);
  assert.equal(hasForbiddenKey(null), false);
  assert.equal(hasForbiddenKey(undefined), false);
});

// ── 4. Emit: mapping + fire-and-forget + fail-soft ────────────────────────────

test('emitMediaNorthStar records the mapped event with a coarse payload', () => {
  const calls: Array<{ type: string; payload: unknown }> = [];
  const record: MediaEventRecorder = (type, payload) => {
    calls.push({ type, payload });
  };
  const emitted = emitMediaNorthStar(record, 'add_to_trip', {
    mediaId: 'm_1',
    entityKind: 'place',
    placeId: 'p_1',
    surface: 'action_rail',
  });
  assert.equal(emitted, 'media_trip_add');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.type, 'media_trip_add');
  assert.deepEqual(calls[0]!.payload, {
    media_id: 'm_1',
    action_id: 'add_to_trip',
    entity_kind: 'place',
    place_id: 'p_1',
    surface: 'action_rail',
  });
  // Guarantee: nothing raw-text / coordinate left the module.
  assert.equal(hasForbiddenKey(calls[0]!.payload as Record<string, unknown>), false);
});

test('emitMediaNorthStar is a no-op for a non-outcome action — recorder not called', () => {
  const calls: string[] = [];
  const record: MediaEventRecorder = (type) => {
    calls.push(type);
  };
  assert.equal(emitMediaNorthStar(record, 'i_want_this', { mediaId: 'm_1' }), null);
  assert.equal(emitMediaNorthStar(record, 'share_telegraph', { mediaId: 'm_1' }), null);
  assert.equal(calls.length, 0);
});

test('emitMediaNorthStar is fail-soft: a throwing recorder does not propagate', () => {
  const throwing: MediaEventRecorder = () => {
    throw new Error('transport exploded');
  };
  // Must not throw — telemetry failure never breaks the action.
  assert.doesNotThrow(() => emitMediaNorthStar(throwing, 'show_on_map', { mediaId: 'm_1' }));
  assert.equal(emitMediaNorthStar(throwing, 'show_on_map', { mediaId: 'm_1' }), null);
});
