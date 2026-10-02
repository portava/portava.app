/**
 * The client half of §17.8 / §30A.7 (T235 / T400): an active precise location
 * belongs to the DEVICE that published it and to the ACCOUNT that was signed in
 * when it did.
 *
 * The server refuses to serve a precise coordinate to any other device and says
 * so with `coordsPrecision`. Two things follow on this side, and both are pure
 * so they can be asserted without React:
 *
 *   1. a restored APPROXIMATE point is never presented as a live fix. It is a
 *      ~2 km grid cell; "live" beside it would let every downstream consumer
 *      read it as a current position, which is the misreading the coarsening
 *      exists to prevent;
 *   2. an ACCOUNT CHANGE drops the held location — coords, place and source —
 *      instead of carrying one account's position into the next session on the
 *      same phone. Same shape as
 *      `platform/input-assistance/services/policyStore.ts#setActiveAccount`,
 *      which drops its snapshot on an account change.
 *
 * Run: node --import tsx/esm --test src/hooks/__tests__/activeLocation.deviceBoundPrecision.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_ID_HEADER,
  EMPTY_PLACE,
  accountChanged,
  buildAccountChangeState,
  clampFreshnessForPrecision,
  coordsPrecisionOf,
} from '../activeLocation.state.ts';
import type { ActiveLocationState } from '../useActiveLocation.ts';
import type { Place } from '../../lib/location/placeTypes.ts';

const PORTO: Place = {
  ...EMPTY_PLACE,
  id: 'porto',
  name: 'Porto',
  displayName: 'Porto, Portugal',
  country: 'Portugal',
  city: 'Porto',
  lat: 41.15,
  lng: -8.61,
};

function stateWith(overrides: Partial<ActiveLocationState> = {}): ActiveLocationState {
  return {
    ok: true,
    permissionStatus: 'granted',
    source: 'last_known',
    freshness: 'live',
    coords: { lat: 41.15, lng: -8.61, accuracyMeters: 12 },
    coordsPrecision: 'precise',
    place: PORTO,
    lastUpdatedAt: new Date().toISOString(),
    userMessage: null,
    ...overrides,
  };
}

describe('the device-id header', () => {
  it('is the header the server reads — the two spellings must match exactly', () => {
    assert.equal(DEVICE_ID_HEADER, 'x-portava-device-id');
  });
});

describe('coordsPrecisionOf', () => {
  it('accepts the two values the server sends and nothing else', () => {
    assert.equal(coordsPrecisionOf('precise'), 'precise');
    assert.equal(coordsPrecisionOf('approximate'), 'approximate');
    assert.equal(coordsPrecisionOf(undefined), null);
    assert.equal(coordsPrecisionOf(null), null);
    assert.equal(coordsPrecisionOf('exact'), null, 'an unknown rung is not trusted into precision');
    assert.equal(coordsPrecisionOf(true), null);
  });
});

describe('clampFreshnessForPrecision', () => {
  it('an APPROXIMATE point is never live', () => {
    assert.equal(clampFreshnessForPrecision('live', 'approximate'), 'recent');
  });

  it('it does not make a stale point fresher', () => {
    assert.equal(clampFreshnessForPrecision('recent', 'approximate'), 'recent');
    assert.equal(clampFreshnessForPrecision('stale', 'approximate'), 'stale');
    assert.equal(clampFreshnessForPrecision('unavailable', 'approximate'), 'unavailable');
  });

  it('a precise point — this device published it — keeps its freshness', () => {
    assert.equal(clampFreshnessForPrecision('live', 'precise'), 'live');
  });

  it('a coordinate this device measured itself (no discriminator) is untouched', () => {
    assert.equal(clampFreshnessForPrecision('live', null), 'live');
  });
});

describe('buildAccountChangeState — the previous account keeps nothing', () => {
  const next = buildAccountChangeState(stateWith());

  it('drops the coordinate, its precision, the place and the source', () => {
    assert.equal(next.coords, null);
    assert.equal(next.coordsPrecision, null);
    assert.equal(next.source, 'none');
    assert.equal(next.freshness, 'unavailable');
    assert.equal(next.lastUpdatedAt, null);
    assert.equal(next.ok, false);
    assert.deepEqual(next.place, EMPTY_PLACE);
    assert.equal(next.place.city, null, 'the previous account’s city is a location too');
  });

  it('keeps the permission status — that is a fact about the phone, not the account', () => {
    assert.equal(next.permissionStatus, 'granted');
    assert.equal(buildAccountChangeState(stateWith({ permissionStatus: 'denied' })).permissionStatus, 'denied');
  });

  it('drops a manual city as readily as a GPS fix', () => {
    const manual = buildAccountChangeState(stateWith({ source: 'manual_city', coordsPrecision: null }));
    assert.equal(manual.source, 'none');
    assert.deepEqual(manual.place, EMPTY_PLACE);
  });
});

describe('accountChanged', () => {
  it('is true only when the signed-in account differs', () => {
    assert.equal(accountChanged('a', 'b'), true);
    assert.equal(accountChanged('a', null), true, 'signing out is a change');
    assert.equal(accountChanged(null, 'a'), true, 'signing in is a change');
    assert.equal(accountChanged('a', 'a'), false);
    assert.equal(accountChanged(null, null), false);
  });
});
