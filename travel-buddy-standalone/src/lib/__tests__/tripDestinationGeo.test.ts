/**
 * tripDestinationGeo — the destination point a new or edited trip sends.
 *
 * Run with: node --import tsx --test src/lib/__tests__/tripDestinationGeo.test.ts
 *
 * Pinned: the binding wins over the place; a missing or (0,0) point is not a
 * point; a canonical id alone is still worth sending; the zone is sent only
 * when known. On edit: a new pick replaces (or clears) the old point, an
 * untouched destination only fills in a missing point, and never the zone.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tripDestinationGeo, tripDestinationGeoForEdit } from '../tripDestinationGeo.ts';

describe('tripDestinationGeo', () => {
  it('takes the first source with a valid point, and the first id and zone among all', () => {
    assert.deepEqual(
      tripDestinationGeo({ lat: null, lng: null, canonicalId: 'loc_cebu' }, { lat: 10.3, lng: 123.9, timezone: 'Asia/Manila' }),
      { destinationLat: 10.3, destinationLng: 123.9, destinationPlaceId: 'loc_cebu', timezone: 'Asia/Manila' },
    );
    assert.deepEqual(
      tripDestinationGeo({ lat: 1, lng: 2 }, { lat: 3, lng: 4, canonicalId: 'x' }),
      { destinationLat: 1, destinationLng: 2, destinationPlaceId: 'x' },
    );
  });

  it('a (0,0), out-of-range or non-finite point is not a point', () => {
    assert.equal(tripDestinationGeo({ lat: 0, lng: 0 }), null);
    assert.equal(tripDestinationGeo({ lat: 91, lng: 10 }), null);
    assert.equal(tripDestinationGeo({ lat: Number.NaN, lng: 10 }), null);
    assert.equal(tripDestinationGeo(null, undefined, {}), null);
  });

  it('a canonical id with no point is still sent, with null coordinates', () => {
    assert.deepEqual(tripDestinationGeo({ canonicalId: '  loc_1 ' }), { destinationLat: null, destinationLng: null, destinationPlaceId: 'loc_1' });
  });
});

describe('tripDestinationGeoForEdit', () => {
  const pick = { lat: 14.6, lng: 121.0, canonicalId: 'loc_mnl', timezone: 'Asia/Manila' };

  it('a new pick sends its point and zone', () => {
    assert.deepEqual(tripDestinationGeoForEdit({ repicked: true, storedHasPoint: true }, pick), {
      destinationLat: 14.6, destinationLng: 121.0, destinationPlaceId: 'loc_mnl', timezone: 'Asia/Manila',
    });
  });

  it('a new pick with nothing known clears the old point', () => {
    assert.deepEqual(tripDestinationGeoForEdit({ repicked: true, storedHasPoint: true }, { lat: null, lng: null }), {
      destinationLat: null, destinationLng: null, destinationPlaceId: null,
    });
  });

  it('an untouched destination only fills in a missing point, without the zone', () => {
    assert.deepEqual(tripDestinationGeoForEdit({ repicked: false, storedHasPoint: false }, pick), {
      destinationLat: 14.6, destinationLng: 121.0, destinationPlaceId: 'loc_mnl',
    });
    assert.deepEqual(tripDestinationGeoForEdit({ repicked: false, storedHasPoint: true }, pick), {});
    assert.deepEqual(tripDestinationGeoForEdit({ repicked: false, storedHasPoint: false }, { canonicalId: 'only_id' }), {});
  });
});
