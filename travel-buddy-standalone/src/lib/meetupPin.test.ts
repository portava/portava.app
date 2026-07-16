/**
 * Guards the meetup-pin privacy contract:
 *  - coordinates rounded to ~3 decimals (≈110 m, never exact addresses)
 *  - both-coordinates-or-both-null saves (no half-cleared pins)
 *  - PATCH payload keys are exactly meetupBaseLat / meetupBaseLng
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEETUP_PIN_DECIMALS,
  roundMeetupCoord,
  roundMeetupPin,
  buildMeetupPinPatch,
} from './meetupPin.ts';

test('privacy precision is 3 decimals (~110 m)', () => {
  assert.equal(MEETUP_PIN_DECIMALS, 3);
});

test('roundMeetupCoord rounds to 3 decimals', () => {
  assert.equal(roundMeetupCoord(48.8583701), 48.858);
  assert.equal(roundMeetupCoord(2.2944813), 2.294);
  assert.equal(roundMeetupCoord(-33.86882), -33.869);
  assert.equal(roundMeetupCoord(0), 0);
  // already-rounded values pass through unchanged
  assert.equal(roundMeetupCoord(51.507), 51.507);
});

test('roundMeetupCoord never keeps more than 3 decimals of precision', () => {
  const exact = 40.4167754;
  const rounded = roundMeetupCoord(exact);
  assert.notEqual(rounded, exact);
  assert.ok(Math.abs(rounded - exact) <= 0.0005 + 1e-12);
});

test('roundMeetupPin rounds both coordinates together', () => {
  assert.deepEqual(roundMeetupPin(35.6586407, 139.7454329), {
    lat: 35.659,
    lng: 139.745,
  });
});

test('roundMeetupPin returns null when either coordinate is missing', () => {
  assert.equal(roundMeetupPin(null, 139.745), null);
  assert.equal(roundMeetupPin(35.659, null), null);
  assert.equal(roundMeetupPin(undefined, undefined), null);
});

test('buildMeetupPinPatch uses exactly the meetupBaseLat/meetupBaseLng keys', () => {
  const patch = buildMeetupPinPatch(35.659, 139.745);
  assert.deepEqual(Object.keys(patch).sort(), ['meetupBaseLat', 'meetupBaseLng']);
  assert.equal(patch.meetupBaseLat, 35.659);
  assert.equal(patch.meetupBaseLng, 139.745);
});

test('buildMeetupPinPatch clears both when both are null', () => {
  assert.deepEqual(buildMeetupPinPatch(null, null), {
    meetupBaseLat: null,
    meetupBaseLng: null,
  });
});

test('buildMeetupPinPatch never emits a half-set pin', () => {
  assert.deepEqual(buildMeetupPinPatch(35.659, null), {
    meetupBaseLat: null,
    meetupBaseLng: null,
  });
  assert.deepEqual(buildMeetupPinPatch(null, 139.745), {
    meetupBaseLat: null,
    meetupBaseLng: null,
  });
});
