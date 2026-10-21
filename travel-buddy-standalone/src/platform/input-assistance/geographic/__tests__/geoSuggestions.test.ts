/**
 * Phase 2 (Geographic Core) — the gateway ⇄ Place bridge + §14 zero-state.
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  suggestionToPlace,
  placeToSuggestion,
  assembleGeoZeroState,
} from '../geoSuggestions.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import type { Place } from '../../../../lib/location/placeTypes.ts';

function sug(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: over.id ?? 's1',
    type: over.type ?? 'entity',
    context: over.context ?? 'trip_destination',
    label: over.label ?? 'Da Nang',
    source: over.source ?? 'canonical',
    policyVersion: 'input-2026-08',
    ...over,
  };
}

function place(over: Partial<Place> = {}): Place {
  return {
    id: 'p1', type: 'city', name: 'Da Nang', displayName: 'Da Nang, Vietnam',
    country: 'Vietnam', countryCode: 'VN', region: null, city: 'Da Nang',
    district: null, lat: 16.05, lng: 108.2, timezone: 'Asia/Ho_Chi_Minh',
    source: 'canonical',
    ...over,
  } as Place;
}

const venueId = '11111111-1111-4111-8111-111111111111';
const cityId = '22222222-2222-4222-8222-222222222222';
const venueValue = {
  entityType: 'venue', venueId, venue: 'Sky36', cityId, city: 'Da Nang',
  country: 'Vietnam', countryCode: 'VN', lat: 16.07, lng: 108.22, timezone: 'Asia/Ho_Chi_Minh',
};
function venue(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return sug({ context: 'event_location', label: 'Sky36', subtitle: 'Da Nang',
    entityType: 'place', entityId: venueId,
    action: { type: 'open_entity', entityType: 'place', entityId: venueId },
    structuredValue: venueValue, ...over });
}

test('canonical venue binding preserves venue identity and the six dependent fields', () => {
  assert.deepEqual(suggestionToPlace(venue()), {
    id: `gw-${venueId}`, type: 'place', name: 'Sky36', displayName: 'Sky36, Da Nang',
    canonicalId: venueId, source: 'canonical', city: 'Da Nang', country: 'Vietnam',
    countryCode: 'VN', lat: 16.07, lng: 108.22, timezone: 'Asia/Ho_Chi_Minh',
    district: null, region: null, confidence: undefined,
  });
});

test('canonical venue binding preserves genuine zero coordinates', () => {
  const result = suggestionToPlace(venue({ structuredValue: { ...venueValue, lat: 0, lng: 0 } }));
  assert.equal(result?.lat, 0);
  assert.equal(result?.lng, 0);
});

test('canonical venue binding does not invent optional facts from subtitle or city identity', () => {
  const result = suggestionToPlace(venue({ structuredValue: { entityType: 'venue', venueId, venue: 'Sky36', cityId } }));
  assert.ok(result);
  for (const field of ['city', 'country', 'countryCode', 'lat', 'lng', 'timezone'] as const) {
    assert.equal(result[field], null);
  }
  assert.equal(result.canonicalId, venueId);
});

const mismatches: [string, Partial<InputSuggestion>][] = [
  ['source', { source: 'provider' }],
  ['binding source', { structuredValue: { ...venueValue, source: 'provider' } }],
  ['target type', { entityType: 'city' }],
  ['target identity', { entityId: cityId }],
  ['absent identity', { entityId: undefined }],
  ['binding identity', { structuredValue: { ...venueValue, venueId: '' } }],
  ['binding name', { structuredValue: { ...venueValue, venue: '' } }],
  ['label', { label: 'Another venue' }],
  ['action identity', { action: { type: 'open_entity', entityType: 'place', entityId: cityId } }],
  ['action type', { action: { type: 'replace_text', value: 'Sky36' } } as never],
  ['validation', { type: 'validation' }],
  ['completion', { type: 'completion' }],
  ['action', { type: 'action' }],
  ['approximate precision', { locationPrecision: 'approximate' }],
  ['hidden precision', { locationPrecision: 'hidden' }],
  ['embedded Place bypass', { source: 'provider', structuredValue: { ...venueValue, ...place() } }],
  ['string latitude', { structuredValue: { ...venueValue, lat: '0' } }],
  ['out of range longitude', { structuredValue: { ...venueValue, lng: 181 } }],
  ['nonfinite latitude', { structuredValue: { ...venueValue, lat: NaN } }],
  ['half coordinates', { structuredValue: { ...venueValue, lng: null } }],
  ['nontext country', { structuredValue: { ...venueValue, country: 5 } }],
];
for (const [name, mismatch] of mismatches) {
  test(`canonical venue binding refuses ${name} without label-only fallback`, () => {
    assert.equal(suggestionToPlace(venue(mismatch)), null);
  });
}

test('non-place rows and approximate areas never become label-only Places', () => {
  for (const type of ['validation', 'completion', 'correction', 'structured_value', 'action'] as const) {
    assert.equal(suggestionToPlace(sug({ type, label: 'Not a venue', entityType: 'place' })), null);
  }
  assert.equal(suggestionToPlace(sug({ structuredValue: { kind: 'approximate_area', city: 'Da Nang' } })), null);
  assert.equal(suggestionToPlace(sug({ entityType: 'place', locationPrecision: 'approximate' })), null);
});

test('canonical disambiguated venues and absent optional action retain the existing entity identity', () => {
  assert.equal(suggestionToPlace(venue({ type: 'disambiguation', action: undefined }))?.canonicalId, venueId);
});

test('suggestionToPlace: entity suggestion → Place carrying the canonical id', () => {
  const p = suggestionToPlace(sug({ label: 'Da Nang', subtitle: 'Vietnam', entityType: 'city', entityId: 'city_da_nang' }));
  assert.ok(p);
  assert.equal(p!.name, 'Da Nang');
  assert.equal(p!.type, 'city');
  assert.equal(p!.city, 'Da Nang');
  assert.equal(p!.displayName, 'Da Nang, Vietnam'); // subtitle appended
  assert.equal(p!.canonicalId, 'city_da_nang'); // so resolveCanonical short-circuits
});

test('suggestionToPlace: does not double the label when subtitle repeats it', () => {
  const p = suggestionToPlace(sug({ label: 'Da Nang', subtitle: 'Da Nang', entityType: 'city' }));
  assert.equal(p!.displayName, 'Da Nang');
});

test('suggestionToPlace: prefers a fully-formed Place carried in structuredValue', () => {
  const embedded = place({ id: 'canon-1', canonicalId: 'city_da_nang' });
  const p = suggestionToPlace(sug({ label: 'Da Nang', structuredValue: embedded, entityId: 'ignored' }));
  assert.equal(p!.id, 'canon-1');
  assert.equal(p!.timezone, 'Asia/Ho_Chi_Minh');
  assert.equal(p!.canonicalId, 'city_da_nang');
});

test('suggestionToPlace: returns null for a labelless / non-place suggestion', () => {
  assert.equal(suggestionToPlace(sug({ label: '   ' })), null);
});

test('placeToSuggestion: round-trips a Place through structuredValue', () => {
  const s = placeToSuggestion(place({ canonicalId: 'city_da_nang' }), 'trip_destination', { source: 'recent', reason: 'Recent' });
  assert.equal(s.label, 'Da Nang');
  assert.equal(s.entityType, 'city');
  assert.equal(s.entityId, 'city_da_nang');
  assert.equal(s.reason, 'Recent');
  assert.equal(s.source, 'recent');
  // The embedded Place lets a select re-hydrate the exact Place for the picker.
  const back = suggestionToPlace(s);
  assert.equal(back!.canonicalId, 'city_da_nang');
});

test('assembleGeoZeroState: orders current → recent → trips → popular and dedupes', () => {
  const current = place({ id: 'cur', canonicalId: 'city_da_nang', name: 'Da Nang' });
  const recentDup = place({ id: 'rec', canonicalId: 'city_da_nang', name: 'Da Nang' }); // same canonical → deduped
  const recentOther = place({ id: 'rec2', canonicalId: 'city_hanoi', name: 'Hanoi' });
  const trip = place({ id: 'trip', canonicalId: 'city_hoi_an', name: 'Hoi An' });
  const popular = place({ id: 'pop', canonicalId: 'city_hue', name: 'Hue' });

  const rows = assembleGeoZeroState(
    { currentPlace: current, recents: [recentDup, recentOther], tripPlaces: [{ place: trip, label: 'Current Trip' }], popular: [popular] },
    'trip_destination',
  );

  const labels = rows.map((r) => r.label);
  assert.deepEqual(labels, ['Da Nang', 'Hanoi', 'Hoi An', 'Hue']); // dup Da Nang collapsed
  assert.equal(rows[0].reason, 'Current location');
  assert.equal(rows[1].reason, 'Recent');
  assert.equal(rows[2].reason, 'Current Trip'); // custom trip label honored
  assert.equal(rows[3].reason, 'Popular on Portava');
});

test('assembleGeoZeroState: empty inputs → empty list; respects the limit', () => {
  assert.deepEqual(assembleGeoZeroState({}, 'city_picker'), []);
  const many = Array.from({ length: 20 }, (_, i) => place({ id: `p${i}`, canonicalId: `c${i}`, name: `City${i}` }));
  assert.equal(assembleGeoZeroState({ popular: many, limit: 5 }, 'city_picker').length, 5);
});

test('suggestionToPlace: an ACTION row is never a Place, even with a label and a structured value (verifier D4)', () => {
  // MUTATION-PROOF: drop the `s.type === 'action'` guard → both assertions red
  // (the approximate-area row becomes a label-only Place named "Use approximate area").
  assert.equal(
    suggestionToPlace(sug({
      type: 'action', label: 'Use approximate area', subtitle: 'Da Nang, Vietnam', entityType: undefined,
      structuredValue: { kind: 'approximate_area', areaType: 'city', cityId: 'c1', city: 'Da Nang' },
    } as any)),
    null,
  );
  assert.equal(
    suggestionToPlace(sug({ type: 'action', label: 'Open on map', entityType: 'place', entityId: 'p1' } as any)),
    null,
  );
});

// ── census-trips wave-5 follow-up (G109): a gateway CITY row keeps the zone its own binding states ──
const daNangId = '33333333-3333-4333-8333-333333333333';
const cityValue = {
  entityType: 'city', cityId: daNangId, city: 'Da Nang', country: 'Vietnam', countryCode: 'VN',
  lat: 16.05, lng: 108.2, timezone: 'Asia/Ho_Chi_Minh',
};
function cityRow(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return sug({ context: 'city_picker', label: 'Da Nang', subtitle: 'Vietnam', entityType: 'city', entityId: daNangId,
    action: { type: 'set_structured_value', value: cityValue }, structuredValue: cityValue, ...over });
}

test('a gateway city row carries the time zone its own binding states', () => {
  const p = suggestionToPlace(cityRow());
  assert.equal(p?.type, 'city');
  assert.equal(p?.canonicalId, daNangId);
  assert.equal(p?.timezone, 'Asia/Ho_Chi_Minh');
});

test('a multi-segment zone and UTC are carried as sent', () => {
  assert.equal(suggestionToPlace(cityRow({ structuredValue: { ...cityValue, timezone: 'America/Argentina/Buenos_Aires' } }))?.timezone, 'America/Argentina/Buenos_Aires');
  assert.equal(suggestionToPlace(cityRow({ structuredValue: { ...cityValue, timezone: ' UTC ' } }))?.timezone, 'UTC');
});

test('no zone is invented: a null, blank, malformed or non-string bound zone stays null', () => {
  for (const timezone of [null, undefined, '', '   ', 'null', 'Asia/', '/Ho_Chi_Minh', 'Asia Ho Chi Minh', 7]) {
    const p = suggestionToPlace(cityRow({ structuredValue: { ...cityValue, timezone } }));
    assert.ok(p, `the row is still a Place (${String(timezone)})`);
    assert.equal(p.timezone, null, `bound zone ${JSON.stringify(timezone)}`);
  }
});

test('a binding for ANOTHER entity says nothing about this row: no zone', () => {
  // a different city's binding
  assert.equal(suggestionToPlace(cityRow({ structuredValue: { ...cityValue, cityId: cityId } }))?.timezone, null);
  // a row with no canonical id cannot be matched to any binding
  assert.equal(suggestionToPlace(cityRow({ entityId: undefined }))?.timezone, null);
  // a non-city row carrying a city binding
  assert.equal(suggestionToPlace(cityRow({ entityType: 'country' }))?.timezone, null);
  // a binding that is not a city binding
  assert.equal(suggestionToPlace(cityRow({ structuredValue: { ...cityValue, entityType: 'region' } }))?.timezone, null);
  // no binding at all (the label alone): unchanged, null
  assert.equal(suggestionToPlace(cityRow({ structuredValue: undefined, action: undefined }))?.timezone, null);
});

test('only the zone is carried: the binding\'s coordinates and country are not (scoped follow-up)', () => {
  const p = suggestionToPlace(cityRow());
  assert.equal(p?.lat, null);
  assert.equal(p?.lng, null);
  assert.equal(p?.country, null);
  assert.equal(p?.countryCode, null);
});
