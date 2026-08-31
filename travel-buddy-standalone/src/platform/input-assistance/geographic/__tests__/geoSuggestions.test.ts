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
