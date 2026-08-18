/**
 * resolvePickedPlace — the one rule for what a picked place does to typed text.
 *
 * The rule exists because reversing it is a regression someone already fixed:
 * EventComposerSheet.tsx:604 and app/events/create/index.tsx:927 both carry the
 * "QA round 2, bug 6" comment about a picker silently overwriting a manually
 * entered city. These tests are what stops a future edit from undoing it
 * quietly in three files at once.
 *
 * Run: node --import tsx/esm --test src/lib/location/__tests__/applyPickedPlace.test.ts
 * (also auto-discovered by scripts/run-node-tests.mjs via src/**\/*.test.ts)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePickedPlace } from '../applyPickedPlace.ts';
import type { Place } from '../placeTypes.ts';

function place(over: Partial<Place> = {}): Place {
  return {
    id: 'p1', type: 'city', name: 'Ubud', displayName: 'Ubud, Indonesia',
    country: 'Indonesia', countryCode: 'ID', region: null, city: 'Ubud',
    district: null, lat: -8.506, lng: 115.262, timezone: 'Asia/Makassar',
    source: 'manual',
    ...over,
  } as Place;
}

describe('resolvePickedPlace — blank fields fill silently', () => {
  it('fills every blank field the place carries', () => {
    const r = resolvePickedPlace(place({ district: 'Peliatan' }), {});
    assert.deepEqual(r.fill, { city: 'Ubud', country: 'Indonesia', neighborhood: 'Peliatan' });
    assert.equal(r.hasConflict, false);
  });

  it('treats whitespace-only text as blank', () => {
    // A field holding "   " is not something the user meant to keep.
    const r = resolvePickedPlace(place(), { city: '   ', country: '' });
    assert.equal(r.fill.city, 'Ubud');
    assert.equal(r.fill.country, 'Indonesia');
    assert.equal(r.hasConflict, false);
  });

  it('leaves fields the place carries nothing for alone', () => {
    const r = resolvePickedPlace(place({ country: null, district: null }), {});
    assert.equal(r.fill.city, 'Ubud');
    assert.ok(!('country' in r.fill));
    assert.ok(!('neighborhood' in r.fill));
  });
});

describe('resolvePickedPlace — typed text is never overwritten silently', () => {
  it('reports a conflict instead of filling', () => {
    // The regression guard. `fill` is what the caller applies without asking,
    // so a typed value appearing there is the QA round 2 bug 6 defect exactly.
    const r = resolvePickedPlace(place(), { city: 'Denpasar' });
    assert.ok(!('city' in r.fill), 'must not silently replace typed text');
    assert.equal(r.conflict.city, 'Ubud');
    assert.equal(r.hasConflict, true);
  });

  it('conflicts on each typed field independently', () => {
    // Mixed state: one typed, one blank. The blank one still fills, so picking
    // is useful even when part of the form is already filled in.
    const r = resolvePickedPlace(place(), { city: 'Denpasar', country: '' });
    assert.equal(r.conflict.city, 'Ubud');
    assert.equal(r.fill.country, 'Indonesia');
    assert.equal(r.hasConflict, true);
  });

  it('is not a conflict when the typed text already agrees', () => {
    // Prompting to replace "Ubud" with "Ubud" is noise, and a user who taught
    // themselves to dismiss it stops reading the one that matters.
    const r = resolvePickedPlace(place(), { city: 'Ubud' });
    assert.equal(r.hasConflict, false);
    assert.ok(!('city' in r.fill));
    assert.ok(!('city' in r.conflict));
  });

  it('ignores surrounding whitespace when comparing', () => {
    const r = resolvePickedPlace(place(), { city: '  Ubud  ' });
    assert.equal(r.hasConflict, false);
  });
});

describe('resolvePickedPlace — the city value itself', () => {
  it('falls back to the place name when it has no city', () => {
    // Islands, regions and districts have no `city`. Picking one should still
    // fill the field rather than appear to do nothing.
    const r = resolvePickedPlace(place({ city: null, name: 'Gili Air' }), {});
    assert.equal(r.fill.city, 'Gili Air');
  });

  it('never uses displayName, which carries the country suffix', () => {
    // The server matches this string with `city.ilike.<value>`
    // (api-server routes/discovery.ts:732), so "Ubud, Indonesia" would match
    // nothing. Asserted explicitly because displayName is the obvious-looking
    // field and the failure is silent — an empty result set, not an error.
    const r = resolvePickedPlace(place({ city: null, name: 'Ubud' }), {});
    assert.equal(r.fill.city, 'Ubud');
    assert.notEqual(r.fill.city, 'Ubud, Indonesia');
  });

  it('yields nothing for a place with neither city nor name', () => {
    const r = resolvePickedPlace(place({ city: null, name: '' as any }), {});
    assert.ok(!('city' in r.fill));
    assert.equal(r.hasConflict, false);
  });
});

describe('resolvePickedPlace — coordinates', () => {
  it('carries the picked place coordinates', () => {
    const r = resolvePickedPlace(place(), {});
    assert.deepEqual(r.coords, { lat: -8.506, lng: 115.262 });
  });

  it('is null when the place has no usable coordinates', () => {
    // A caller must be able to tell "no coordinates" from "coordinates at 0,0".
    assert.equal(resolvePickedPlace(place({ lat: null, lng: null }), {}).coords, null);
    assert.equal(resolvePickedPlace(place({ lat: NaN as any, lng: 5 }), {}).coords, null);
  });

  it('keeps a genuine zero coordinate', () => {
    // Null Island is a real place to pass through; dropping it via a falsy
    // check is the classic version of this bug.
    const r = resolvePickedPlace(place({ lat: 0, lng: 0 }), {});
    assert.deepEqual(r.coords, { lat: 0, lng: 0 });
  });
});
