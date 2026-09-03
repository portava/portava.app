/**
 * searchAdapter — unified search results shaped for the map (§27).
 *
 * The property under test throughout is the one that is easy to break and
 * impossible to notice: a result with no usable coordinates must produce NO
 * frame. Both plausible fallbacks — the viewport centre, or the user's own
 * position — would move the camera somewhere confident and wrong.
 *
 * FIXTURE SPELLING
 * ================
 * Every `type` below is spelled the way the WIRE spells it — the plural
 * `SearchType` values from artifacts/api-server/src/routes/discoverySearch.ts.
 * This file used to say `place`, `user`, `trip`, `area`, `event`; the server
 * has never sent any of those. The adapter was keyed on the same singular
 * forms, so the tests and the bug agreed with each other and the suite stayed
 * green while map search dropped four of §27's nine types.
 *
 * The type table's coverage of the wire is enforced in serverSearchTypes.test.ts,
 * which reads the server's own SEARCH_TYPES rather than restating it. This file
 * covers behaviour; that file covers vocabulary.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SERVER_TYPE_TO_MAP_TYPE,
  boundsFromMetadata,
  centerFromMetadata,
  mapSearchTypeFor,
  setUnknownServerTypeSink,
  toMapSearchResult,
  toMapSearchResults,
} from '../searchAdapter.ts';
import { frameFor, MAP_SEARCH_RESULT_TYPES } from '../mapSearchModel.ts';

// The unknown-type fixtures below are deliberate; silence the diagnostic so the
// suite's output stays readable. Behaviour is unchanged — the drop still happens.
setUnknownServerTypeSink(() => {});

const BASE = { id: 'r1', type: 'places', title: 'Rooftop Bar' };

describe('server type mapping', () => {
  test('maps every known alias onto one of §27 nine types', () => {
    for (const [alias, mapped] of Object.entries(SERVER_TYPE_TO_MAP_TYPE)) {
      assert.ok(
        (MAP_SEARCH_RESULT_TYPES as readonly string[]).includes(mapped),
        `alias "${alias}" maps to "${mapped}", which is not a §27 result type`,
      );
    }
  });

  test('is case-insensitive', () => {
    assert.equal(mapSearchTypeFor('PLACES'), 'place');
    assert.equal(mapSearchTypeFor('Hidden_Gems'), 'hidden_gem');
  });

  test('an unrecognised type is DROPPED, not coerced to place', () => {
    // A result under the wrong heading gets the wrong zoom AND the wrong
    // camera state — worse than being absent from the map.
    assert.equal(mapSearchTypeFor('podcast'), null);
    assert.equal(toMapSearchResult({ ...BASE, type: 'podcast' }), null);
  });
});

describe('coordinate extraction', () => {
  test('reads the shapes the API actually uses', () => {
    assert.deepEqual(centerFromMetadata({ lat: 16.05, lng: 108.2 }), { lat: 16.05, lng: 108.2 });
    assert.deepEqual(centerFromMetadata({ latitude: 1, longitude: 2 }), { lat: 1, lng: 2 });
    assert.deepEqual(centerFromMetadata({ center: { lat: 3, lng: 4 } }), { lat: 3, lng: 4 });
    assert.deepEqual(centerFromMetadata({ location: { lat: 5, lon: 6 } }), { lat: 5, lng: 6 });
  });

  test('a partial pair is not a coordinate', () => {
    // Half a coordinate plus a default is a confident lie about a location.
    assert.equal(centerFromMetadata({ lat: 16.05 }), null);
    assert.equal(centerFromMetadata({ lng: 108.2 }), null);
  });

  test('rejects out-of-range and non-finite values', () => {
    assert.equal(centerFromMetadata({ lat: 91, lng: 0 }), null);
    assert.equal(centerFromMetadata({ lat: 0, lng: 181 }), null);
    assert.equal(centerFromMetadata({ lat: NaN, lng: 0 }), null);
    assert.equal(centerFromMetadata({ lat: 'north', lng: 'east' }), null);
  });

  test('null and absent metadata yield null', () => {
    assert.equal(centerFromMetadata(null), null);
    assert.equal(centerFromMetadata(undefined), null);
    assert.equal(centerFromMetadata({}), null);
  });
});

describe('bounds extraction', () => {
  test('reads both key spellings', () => {
    assert.deepEqual(
      boundsFromMetadata({ bounds: { north: 2, south: 1, east: 4, west: 3 } }),
      { north: 2, south: 1, east: 4, west: 3 },
    );
    assert.deepEqual(
      boundsFromMetadata({ bbox: { maxLat: 2, minLat: 1, maxLng: 4, minLng: 3 } }),
      { north: 2, south: 1, east: 4, west: 3 },
    );
  });

  test('rejects inverted or out-of-range bounds', () => {
    assert.equal(boundsFromMetadata({ bounds: { north: 1, south: 2, east: 4, west: 3 } }), null);
    assert.equal(boundsFromMetadata({ bounds: { north: 2, south: 1, east: 3, west: 4 } }), null);
    assert.equal(boundsFromMetadata({ bounds: { north: 200, south: 1, east: 4, west: 3 } }), null);
    assert.equal(boundsFromMetadata({ bounds: { north: 2, south: 1, east: 4 } }), null);
  });
});

describe('the no-coordinates rule (§27)', () => {
  test('a place with no coordinates is dropped rather than placed', () => {
    assert.equal(toMapSearchResult({ ...BASE, metadata: null }), null);
  });

  test('a user/buddy with no coordinates survives but frames NOTHING', () => {
    // People are listable without being locatable — §23 means a person often
    // has no position to show at all.
    const user = toMapSearchResult({ id: 'u1', type: 'travelers', title: 'Ada', metadata: null })!;
    assert.equal(user.type, 'user');
    assert.deepEqual(frameFor(user), { kind: 'none', reason: 'no_geometry' });
  });

  test('a trip with neither centre nor bounds frames nothing', () => {
    const trip = toMapSearchResult({ id: 't1', type: 'trips', title: 'Songkran', metadata: {} })!;
    assert.equal(frameFor(trip).kind, 'none');
  });
});

describe('area results frame rather than centre', () => {
  test('an area with bounds produces a bounds frame', () => {
    const area = toMapSearchResult({
      id: 'a1',
      type: 'cities',
      title: 'An Thuong',
      metadata: { bounds: { north: 16.06, south: 16.03, east: 108.25, west: 108.21 } },
    })!;
    assert.equal(area.type, 'area');
    const f = frameFor(area);
    assert.equal(f.kind, 'bounds', 'an Area must FRAME its bounds, not centre on a point');
  });

  test('an area WITHOUT bounds degrades to a point rather than faking a region', () => {
    const degraded = toMapSearchResult({
      id: 'a2',
      type: 'cities',
      title: 'Somewhere',
      metadata: { lat: 16.05, lng: 108.2 },
    })!;
    assert.equal(degraded.type, 'saved');
    assert.equal(frameFor(degraded).kind, 'center');
  });

  test('an area with neither is dropped', () => {
    assert.equal(toMapSearchResult({ id: 'a3', type: 'cities', title: 'Nowhere', metadata: {} }), null);
  });
});

describe('toMapSearchResults', () => {
  test('preserves order and drops only what cannot be represented', () => {
    const out = toMapSearchResults([
      { id: '1', type: 'places', title: 'A', metadata: { lat: 1, lng: 1 } },
      { id: '2', type: 'podcast', title: 'B' },
      { id: '3', type: 'events', title: 'C', metadata: { lat: 2, lng: 2 } },
      { id: '4', type: 'places', title: 'D', metadata: null },
      // A type ruled off the map on purpose drops too — silently, by decision.
      { id: '5', type: 'stamps', title: 'E', metadata: { lat: 3, lng: 3 } },
    ]);
    assert.deepEqual(out.map((r) => r.id), ['1', '3']);
  });

  test('an empty or absent list is empty, not an error', () => {
    assert.deepEqual(toMapSearchResults([]), []);
    assert.deepEqual(toMapSearchResults(undefined as never), []);
  });

  test('carries the detail route through so a non-geographic result stays actionable', () => {
    const [r] = toMapSearchResults([
      { id: 'u9', type: 'travelers', title: 'Rui', destinationRoute: '/profile/u9' },
    ]);
    assert.equal(r.detailRoute, '/profile/u9');
  });
});
