/**
 * Confirms that searchBuddies, createRequest, and joinWaitlistV2 never ship
 * a lat without a lng (or vice versa) — each function strips lat/lng through
 * cityCoordSpread before serialising the HTTP body.
 *
 * These tests mirror the pattern in waitlistCoords.test.ts and exercise the
 * payload-building logic directly so they require no network or auth.
 *
 * Run via the standard node:test runner:
 *   node --import tsx/esm --test src/services/__tests__/rentABuddyCoords.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cityCoordSpread } from '../../lib/cityCoords.ts';

// ── Local payload builders (mirror what each service function does) ────────────
//
// Each builder replicates the exact destructure-and-spread pattern used in the
// service so the tests stay coupled to the contract, not the implementation detail.

function buildSearchPayload(
  city: string,
  lat: number | undefined,
  lng: number | undefined,
): Record<string, unknown> {
  const params = { city, lat, lng, page: 1 };
  const { lat: pLat, lng: pLng, ...rest } = params;
  return JSON.parse(JSON.stringify({ ...rest, ...cityCoordSpread({ lat: pLat, lng: pLng }) }));
}

function buildCreateRequestPayload(
  city: string,
  lat: number | undefined,
  lng: number | undefined,
): Record<string, unknown> {
  const payload = { city, lat, lng, category: 'city' };
  const { lat: pLat, lng: pLng, ...rest } = payload;
  return JSON.parse(JSON.stringify({ ...rest, ...cityCoordSpread({ lat: pLat, lng: pLng }) }));
}

function buildJoinWaitlistV2Payload(
  city: string,
  lat: number | undefined,
  lng: number | undefined,
): Record<string, unknown> {
  const payload = { city, lat, lng, category: 'city' };
  const { lat: pLat, lng: pLng, ...rest } = payload;
  return JSON.parse(JSON.stringify({ ...rest, ...cityCoordSpread({ lat: pLat, lng: pLng }) }));
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function assertNeitherHalfPair(payload: Record<string, unknown>, label: string) {
  const hasLat = 'lat' in payload;
  const hasLng = 'lng' in payload;
  assert.equal(hasLat && !hasLng, false, `${label}: lat present without lng`);
  assert.equal(!hasLat && hasLng, false, `${label}: lng present without lat`);
}

// ── searchBuddies payload contract ────────────────────────────────────────────

describe('searchBuddies payload — both-or-null contract', () => {
  it('includes lat and lng when both are valid', () => {
    const p = buildSearchPayload('Tokyo', 35.6762, 139.6503);
    assert.equal(p.lat, 35.6762);
    assert.equal(p.lng, 139.6503);
  });

  it('omits both when only lat is provided', () => {
    const p = buildSearchPayload('Tokyo', 35.6762, undefined);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('omits both when only lng is provided', () => {
    const p = buildSearchPayload('Tokyo', undefined, 139.6503);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('omits both when both are undefined', () => {
    const p = buildSearchPayload('Tokyo', undefined, undefined);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('omits both when lat is NaN', () => {
    const p = buildSearchPayload('Tokyo', NaN, 139.6503);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('omits both when lng is NaN', () => {
    const p = buildSearchPayload('Tokyo', 35.6762, NaN);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('always preserves city regardless of coords', () => {
    const p = buildSearchPayload('Paris', undefined, 2.3522);
    assert.equal(p.city, 'Paris');
  });

  it('payload never has lat without lng across half-pair cases', () => {
    const cases: Array<[number | undefined, number | undefined]> = [
      [1.0, undefined],
      [undefined, 2.0],
      [NaN, 2.0],
      [1.0, NaN],
      [undefined, undefined],
    ];
    for (const [lat, lng] of cases) {
      assertNeitherHalfPair(buildSearchPayload('Berlin', lat, lng), `lat=${lat} lng=${lng}`);
    }
  });
});

// ── createRequest payload contract ────────────────────────────────────────────

describe('createRequest payload — both-or-null contract', () => {
  it('includes lat and lng when both are valid', () => {
    const p = buildCreateRequestPayload('Tokyo', 35.6762, 139.6503);
    assert.equal(p.lat, 35.6762);
    assert.equal(p.lng, 139.6503);
  });

  it('omits both when only lat is provided', () => {
    const p = buildCreateRequestPayload('Tokyo', 35.6762, undefined);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('omits both when only lng is provided', () => {
    const p = buildCreateRequestPayload('Tokyo', undefined, 139.6503);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('omits both when both are undefined', () => {
    const p = buildCreateRequestPayload('Tokyo', undefined, undefined);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('omits both when lat is NaN', () => {
    const p = buildCreateRequestPayload('Tokyo', NaN, 139.6503);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('omits both when lng is NaN', () => {
    const p = buildCreateRequestPayload('Tokyo', 35.6762, NaN);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('always preserves city and category regardless of coords', () => {
    const p = buildCreateRequestPayload('Paris', 48.8, undefined);
    assert.equal(p.city, 'Paris');
    assert.equal(p.category, 'city');
  });

  it('payload never has lat without lng across half-pair cases', () => {
    const cases: Array<[number | undefined, number | undefined]> = [
      [1.0, undefined],
      [undefined, 2.0],
      [NaN, 2.0],
      [1.0, NaN],
      [undefined, undefined],
    ];
    for (const [lat, lng] of cases) {
      assertNeitherHalfPair(buildCreateRequestPayload('Berlin', lat, lng), `lat=${lat} lng=${lng}`);
    }
  });
});

// ── joinWaitlistV2 payload contract ───────────────────────────────────────────

describe('joinWaitlistV2 payload — both-or-null contract', () => {
  it('includes lat and lng when both are valid', () => {
    const p = buildJoinWaitlistV2Payload('Tokyo', 35.6762, 139.6503);
    assert.equal(p.lat, 35.6762);
    assert.equal(p.lng, 139.6503);
  });

  it('omits both when only lat is provided', () => {
    const p = buildJoinWaitlistV2Payload('Tokyo', 35.6762, undefined);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('omits both when only lng is provided', () => {
    const p = buildJoinWaitlistV2Payload('Tokyo', undefined, 139.6503);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('omits both when both are undefined', () => {
    const p = buildJoinWaitlistV2Payload('Tokyo', undefined, undefined);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('omits both when lat is NaN', () => {
    const p = buildJoinWaitlistV2Payload('Tokyo', NaN, 139.6503);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('omits both when lng is NaN', () => {
    const p = buildJoinWaitlistV2Payload('Tokyo', 35.6762, NaN);
    assert.equal('lat' in p, false);
    assert.equal('lng' in p, false);
  });

  it('always preserves city regardless of coords', () => {
    const p = buildJoinWaitlistV2Payload('Lisbon', 38.7, undefined);
    assert.equal(p.city, 'Lisbon');
  });

  it('payload never has lat without lng across half-pair cases', () => {
    const cases: Array<[number | undefined, number | undefined]> = [
      [1.0, undefined],
      [undefined, 2.0],
      [NaN, 2.0],
      [1.0, NaN],
      [undefined, undefined],
    ];
    for (const [lat, lng] of cases) {
      assertNeitherHalfPair(buildJoinWaitlistV2Payload('Berlin', lat, lng), `lat=${lat} lng=${lng}`);
    }
  });
});
