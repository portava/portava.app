/**
 * G109 — selecting a structured field prefills dependents (Venue → City /
 * Country / Coordinates / Timezone).
 *
 * WHAT THE ROW ASKED FOR, AND WHAT WAS MISSING. The CITY half has been complete
 * since §17: `cityBinding` carries city, country, country code, coordinates and
 * an offline-derived IANA zone. The spec's worked example, though, runs from a
 * VENUE — Sky36 → Da Nang → Vietnam → coordinates → Asia/Ho_Chi_Minh — and
 * selecting a place emitted a bare `open_entity` with no structured value at
 * all. So the dependency graph existed for one node class out of the two named,
 * and a venue selection prefilled nothing.
 *
 * THE FOUR CASES BELOW ARE THE ROW'S OWN ACCEPTANCE CRITERIA, plus the two
 * refusals that keep the prefill honest:
 *
 *   1. a venue selection carries all four dependents;
 *   2. the coordinates are the VENUE's, not the city centroid's, and the
 *      timezone is derived from them;
 *   3. a place with NO canonical link binds with a null country rather than an
 *      inferred one — "Springfield" names places in dozens of countries;
 *   4. a canonical link to something that is NOT a city yields no cityId, but
 *      still yields the country, because a landmark row knows its country and
 *      that is a fact about where the venue is.
 *
 * MUTATION LOG (each reverted after):
 *   • `lat: place.lat` → `canonical.lat`         reddens case 2
 *   • `country: canonical?.country` → `null`     reddens cases 1 and 4
 *   • CITY_KINDS gains 'landmark'                reddens case 4
 *   • dropping the `structuredValue` assignment  reddens case 1
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { venueBinding, timezoneForCoords } from '../lib/inputAssistance/geoResolver.js';
import { resolveVenueBindings } from '../lib/inputAssistance/gateway.js';
import { projectSearchResult } from '../lib/inputAssistance/projection.js';
import type { CanonicalRow } from '../lib/canonicalLocations.js';
import type { SearchResult } from '../routes/discoverySearch.js';

/** Sky36 is on the 36th floor of the Novotel on the Han river, Da Nang. */
const SKY36 = { id: 'venue-sky36', name: 'Sky36', city: 'Da Nang', lat: 16.0678, lng: 108.2233 };

/** The Da Nang canonical CITY row. Its centroid is deliberately NOT Sky36's. */
const DA_NANG: CanonicalRow = {
  id: 'canon-da-nang',
  kind: 'city',
  name: 'Da Nang',
  normalized_name: 'da nang',
  display_name: 'Da Nang, Vietnam',
  city: 'Da Nang',
  region: null,
  country: 'Vietnam',
  country_code: 'VN',
  postal_code: null,
  lat: 16.0544,
  lng: 108.2022,
} as CanonicalRow;

describe('§17/G109 — a venue selection prefills its dependents', () => {
  test('all four dependents are present', () => {
    const b = venueBinding(SKY36, DA_NANG);
    assert.equal(b.entityType, 'venue');
    assert.equal(b.venueId, 'venue-sky36');
    assert.equal(b.city, 'Da Nang');
    assert.equal(b.cityId, 'canon-da-nang');
    assert.equal(b.country, 'Vietnam');
    assert.equal(b.countryCode, 'VN');
    assert.equal(typeof b.lat, 'number');
    assert.equal(typeof b.lng, 'number');
    assert.equal(b.timezone, 'Asia/Ho_Chi_Minh');
  });

  test("the coordinates are the VENUE's, and the timezone is derived from them", () => {
    const b = venueBinding(SKY36, DA_NANG);
    // The whole point of a venue binding: a map pin must land on the venue, not
    // in the middle of town. If these ever equal the canonical centroid, the
    // binding has started substituting the city's position for the place's.
    assert.equal(b.lat, SKY36.lat);
    assert.equal(b.lng, SKY36.lng);
    assert.notEqual(b.lat, DA_NANG.lat);
    assert.notEqual(b.lng, DA_NANG.lng);
    assert.equal(b.timezone, timezoneForCoords(SKY36.lat, SKY36.lng));
  });

  test('a place with no canonical link gets a city NAME but never an inferred country', () => {
    const b = venueBinding(
      { id: 'v2', name: "Joe's Diner", city: 'Springfield', lat: 39.7817, lng: -89.6501 },
      null,
    );
    // The name is known from the place row and is honest; the id and the
    // country are not, and are not invented. "Springfield" names places in
    // dozens of countries — a prefilled country the user did not choose is
    // worse than an empty one they will fill.
    assert.equal(b.city, 'Springfield');
    assert.equal(b.cityId, null);
    assert.equal(b.country, null);
    assert.equal(b.countryCode, null);
    // Coordinates and timezone need no canonical row at all, so they survive.
    assert.equal(b.lat, 39.7817);
    assert.equal(b.timezone, 'America/Chicago');
  });

  test('a link to a non-city canonical row yields the country but no cityId', () => {
    const landmark: CanonicalRow = { ...DA_NANG, id: 'canon-dragon-bridge', kind: 'landmark', name: 'Dragon Bridge' };
    const b = venueBinding(SKY36, landmark);
    // A venue linked to another venue has not thereby acquired a city, and
    // putting "Dragon Bridge" in a field labelled City would be a visible lie.
    assert.equal(b.cityId, null);
    assert.notEqual(b.city, 'Dragon Bridge');
    assert.equal(b.city, 'Da Nang', 'falls back to the place row’s own free-text city');
    // The country is still a fact about where the venue is.
    assert.equal(b.country, 'Vietnam');
    assert.equal(b.countryCode, 'VN');
  });

  test('a place with no coordinates yields no timezone rather than a fabricated one', () => {
    const b = venueBinding({ id: 'v3', name: 'Somewhere', city: null, lat: null, lng: null }, DA_NANG);
    assert.equal(b.timezone, null, 'tz must not be borrowed from the city when the venue has no position');
    assert.equal(b.lat, null);
    // The city half still binds — a missing position does not erase a known city.
    assert.equal(b.cityId, 'canon-da-nang');
    assert.equal(b.country, 'Vietnam');
  });
});

// ── The gateway half: one batched read, and what happens when it fails ────────

/**
 * A `canonical_locations` reader that records its calls, so the batching claim
 * is measured rather than asserted. `fail` makes the read resolve with an error
 * the way supabase-js actually does — it RESOLVES on failure, which is the seam
 * that makes a swallowed read look like an empty one.
 */
function fakeClient(rows: CanonicalRow[], opts: { fail?: boolean } = {}) {
  const calls: { table: string; ids: string[] }[] = [];
  return {
    calls,
    from(table: string) {
      const b: any = {
        select: () => b,
        in: (_col: string, ids: string[]) => {
          calls.push({ table, ids });
          return b;
        },
        then: (onF: any, onR: any) =>
          Promise.resolve(
            opts.fail
              ? { data: null, error: { message: 'simulated canonical_locations outage' } }
              : { data: rows, error: null },
          ).then(onF, onR),
      };
      return b;
    },
  };
}

function placeResult(id: string, name: string, city: string | null, linkId: string | null): SearchResult {
  return {
    id,
    type: 'places',
    title: name,
    subtitle: null,
    avatarUrl: null,
    imageUrl: null,
    fallbackInitials: '',
    locationPreview: city,
    matchedReason: null,
    actionState: null,
    privacyState: null,
    accessState: { canAccess: true },
    destinationRoute: `/place/${id}`,
    metadata: { lat: 16.0678, lng: 108.2233, ...(linkId ? { livingPageId: linkId } : {}) },
    createdAt: null,
    startsAt: null,
  } as unknown as SearchResult;
}

describe('§17/G109 — the gateway resolves bindings in one read, and fails closed', () => {
  test('one batched read covers every linked place in the request', async () => {
    const sc = fakeClient([DA_NANG]);
    const out = await resolveVenueBindings(sc, [
      placeResult('v1', 'Sky36', 'Da Nang', 'canon-da-nang'),
      placeResult('v2', 'Madame Lan', 'Da Nang', 'canon-da-nang'),
      placeResult('v3', 'Unlinked Cafe', 'Da Nang', null),
    ]);
    assert.equal(sc.calls.length, 1, 'three places must cost ONE canonical read, not three');
    assert.deepEqual(sc.calls[0].ids, ['canon-da-nang'], 'the duplicate link id is deduped before the read');
    assert.equal(out.size, 3);
    assert.equal(out.get('v1')?.country, 'Vietnam');
    assert.equal(out.get('v2')?.cityId, 'canon-da-nang');
  });

  test('no linked place means no read at all', async () => {
    const sc = fakeClient([DA_NANG]);
    const out = await resolveVenueBindings(sc, [placeResult('v3', 'Unlinked Cafe', 'Da Nang', null)]);
    assert.equal(sc.calls.length, 0, 'a request with nothing to look up must not issue a query');
    assert.equal(out.get('v3')?.city, 'Da Nang');
    assert.equal(out.get('v3')?.country, null);
  });

  test('FAIL-CLOSED: an unreadable canonical row yields NO binding, not a null country', async () => {
    const sc = fakeClient([], { fail: true });
    const out = await resolveVenueBindings(sc, [
      placeResult('v1', 'Sky36', 'Da Nang', 'canon-da-nang'),
      placeResult('v3', 'Unlinked Cafe', 'Da Nang', null),
    ]);
    // This is the distinction the whole helper exists to preserve. §17 PREFILLS
    // dependent fields from this value, so an outage rendered as `country: null`
    // would write "this venue is in no country" into a field the user can see.
    // Absent prefill is a smaller harm than wrong prefill.
    assert.equal(out.has('v1'), false, 'a linked place whose read failed must be skipped entirely');
    // The unlinked place is unaffected: its null country was never a lookup.
    assert.equal(out.has('v3'), true);
    assert.equal(out.get('v3')?.country, null);
  });

  test('the projector attaches the binding, and attaches nothing without one', () => {
    const r = placeResult('v1', 'Sky36', 'Da Nang', 'canon-da-nang');
    const b = venueBinding(SKY36, DA_NANG);

    const withBinding = projectSearchResult(r, 'place_picker', 'v-test', 'sky', { venueBinding: b });
    assert.deepEqual(withBinding.structuredValue, b);

    const without = projectSearchResult(r, 'place_picker', 'v-test', 'sky', {});
    assert.equal(
      'structuredValue' in without,
      false,
      'a row with no binding must carry NO key — an absent binding is not a venue that is in no city',
    );
  });
});
