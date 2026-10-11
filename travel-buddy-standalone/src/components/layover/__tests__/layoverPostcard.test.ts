/**
 * census-layover L275 — the pure half of the layover postcard: when it is
 * offered, and what location the composer sends for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { layoverPostcardHref, layoverPostcardOffered, layoverPostcardParam, layoverPostcardPlaceLabel } from '../layoverPostcard.ts';
import { postcardLocationFields } from '../../postcardLocation.ts';

test('offered for a COMPLETED layover only', () => {
  assert.equal(layoverPostcardOffered('completed'), true);
  for (const s of ['active', 'cancelled', 'expired', '', null, undefined]) assert.equal(layoverPostcardOffered(s), false, String(s));
});

test('a layover postcard sends ONLY its layover id — never the picked place, a coordinate or an id', () => {
  const place = { id: 'nominatim:42', name: 'Taipei', city: 'Taipei', country: 'Taiwan', lat: 25.03, lng: 121.56, canonicalId: 'c-1' } as any;
  assert.deepEqual(postcardLocationFields(place, { sessionId: 'sess-1', city: 'Taipei' }), { layoverSessionId: 'sess-1' });
  assert.deepEqual(postcardLocationFields(null, { sessionId: 'sess-1', city: null }), { layoverSessionId: 'sess-1' });
});

test('without a layover the ordinary place mapping is unchanged', () => {
  const place = { id: 'nominatim:42', name: 'Taipei', city: 'Taipei', country: 'Taiwan', lat: 25.03, lng: 121.56, canonicalId: 'c-1' } as any;
  assert.deepEqual(postcardLocationFields(place, null), {
    locationCity: 'Taipei', locationCountry: 'Taiwan', locationLat: 25.03, locationLng: 121.56, placeId: 'nominatim:42', canonicalLocationId: 'c-1',
  });
  assert.deepEqual(postcardLocationFields(null, undefined), {});
});

test('the label names the layover city, or says only "Your layover"', () => {
  assert.equal(layoverPostcardPlaceLabel({ sessionId: 's', city: 'Taipei' }), 'Layover in Taipei');
  assert.equal(layoverPostcardPlaceLabel({ sessionId: 's', city: null }), 'Your layover');
});

test('LP-2: the hand-off to Passport is a route carrying the layover id and nothing else', () => {
  assert.deepEqual(layoverPostcardHref('dddddddd-dddd-dddd-dddd-dddddddddddd'), {
    pathname: '/(tabs)/passport', params: { layoverPostcard: 'dddddddd-dddd-dddd-dddd-dddddddddddd' },
  });
});

test('LP-2: Passport opens a layover postcard only for one uuid param', () => {
  assert.equal(layoverPostcardParam('dddddddd-dddd-dddd-dddd-dddddddddddd'), 'dddddddd-dddd-dddd-dddd-dddddddddddd');
  for (const bad of [undefined, null, '', 'sess-1', ['dddddddd-dddd-dddd-dddd-dddddddddddd'], 'dddddddd-dddd-dddd-dddd-dddddddddddd/x']) {
    assert.equal(layoverPostcardParam(bad), null, JSON.stringify(bad));
  }
});
