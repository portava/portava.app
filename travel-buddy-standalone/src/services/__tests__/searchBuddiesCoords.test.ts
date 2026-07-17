/**
 * Confirms that searchBuddies, createRequest, and joinWaitlistV2 never ship a
 * lat without a lng (or vice versa) in their POST payloads.
 *
 * Each function destructures lat/lng from its input and routes them through
 * cityCoordSpread, which enforces the both-or-null contract.  These tests
 * exercise that contract by building the payload the same way each function
 * does — without making a real network call.
 *
 * Run via the standard node:test runner:
 *   node --import tsx/esm --test src/services/__tests__/searchBuddiesCoords.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cityCoordSpread } from '../../lib/cityCoords.ts';

// ── Payload builders (mirror each function's serialisation logic) ─────────────

/** Mirrors searchBuddies: destructures lat/lng, spreads cityCoordSpread. */
function buildSearchPayload(
  params: { city: string; lat?: number; lng?: number; sortBy?: string },
): Record<string, unknown> {
  const { lat, lng, ...rest } = params;
  return JSON.parse(JSON.stringify({ ...rest, ...cityCoordSpread({ lat, lng }) }));
}

/** Mirrors createRequest: destructures lat/lng, spreads cityCoordSpread. */
function buildCreateRequestPayload(
  payload: { city: string; lat?: number; lng?: number; category: string; notes?: string },
): Record<string, unknown> {
  const { lat, lng, ...rest } = payload;
  return JSON.parse(JSON.stringify({ ...rest, ...cityCoordSpread({ lat, lng }) }));
}

/** Mirrors joinWaitlistV2: destructures lat/lng, spreads cityCoordSpread. */
function buildJoinWaitlistV2Payload(
  payload: { city: string; lat?: number; lng?: number; category?: string },
): Record<string, unknown> {
  const { lat, lng, ...rest } = payload;
  return JSON.parse(JSON.stringify({ ...rest, ...cityCoordSpread({ lat, lng }) }));
}

// ── searchBuddies ─────────────────────────────────────────────────────────────

describe('searchBuddies payload — both-or-null coord contract', () => {
  it('includes lat and lng when both are valid numbers', () => {
    const payload = buildSearchPayload({ city: 'Tokyo', lat: 35.6762, lng: 139.6503 });
    assert.equal(payload.lat, 35.6762);
    assert.equal(payload.lng, 139.6503);
  });

  it('omits both when only lat is provided', () => {
    const payload = buildSearchPayload({ city: 'Tokyo', lat: 35.6762 });
    assert.equal('lat' in payload, false, 'lat should be absent');
    assert.equal('lng' in payload, false, 'lng should be absent');
  });

  it('omits both when only lng is provided', () => {
    const payload = buildSearchPayload({ city: 'Tokyo', lng: 139.6503 });
    assert.equal('lat' in payload, false, 'lat should be absent');
    assert.equal('lng' in payload, false, 'lng should be absent');
  });

  it('omits both when lat is undefined and lng is a number', () => {
    const payload = buildSearchPayload({ city: 'Tokyo', lat: undefined, lng: 139.6503 });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both when neither lat nor lng are provided', () => {
    const payload = buildSearchPayload({ city: 'Tokyo' });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both when lat is NaN', () => {
    const payload = buildSearchPayload({ city: 'Tokyo', lat: NaN, lng: 139.6503 });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both when lng is NaN', () => {
    const payload = buildSearchPayload({ city: 'Tokyo', lat: 35.6762, lng: NaN });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('always includes city regardless of coords', () => {
    const payload = buildSearchPayload({ city: 'Paris', lat: NaN, lng: 2.3522 });
    assert.equal(payload.city, 'Paris');
  });

  it('preserves other search params alongside coords', () => {
    const payload = buildSearchPayload({ city: 'Berlin', lat: 52.52, lng: 13.405, sortBy: 'highest_rated' });
    assert.equal(payload.city, 'Berlin');
    assert.equal(payload.sortBy, 'highest_rated');
    assert.equal(payload.lat, 52.52);
    assert.equal(payload.lng, 13.405);
  });

  it('payload never has lat key without lng key (exhaustive half-pair cases)', () => {
    const halfPairCases: Array<{ lat?: number; lng?: number }> = [
      { lat: 1.0 },
      { lat: 1.0, lng: undefined },
      { lat: NaN, lng: 2.0 },
      {},
    ];
    for (const coords of halfPairCases) {
      const payload = buildSearchPayload({ city: 'Seoul', ...coords });
      const hasLat = 'lat' in payload;
      const hasLng = 'lng' in payload;
      assert.equal(
        hasLat && !hasLng,
        false,
        `lat without lng for coords: ${JSON.stringify(coords)}`,
      );
    }
  });

  it('payload never has lng key without lat key (exhaustive half-pair cases)', () => {
    const halfPairCases: Array<{ lat?: number; lng?: number }> = [
      { lng: 2.0 },
      { lat: undefined, lng: 2.0 },
      { lat: 1.0, lng: NaN },
      {},
    ];
    for (const coords of halfPairCases) {
      const payload = buildSearchPayload({ city: 'Seoul', ...coords });
      const hasLat = 'lat' in payload;
      const hasLng = 'lng' in payload;
      assert.equal(
        !hasLat && hasLng,
        false,
        `lng without lat for coords: ${JSON.stringify(coords)}`,
      );
    }
  });
});

// ── createRequest ─────────────────────────────────────────────────────────────

describe('createRequest payload — both-or-null coord contract', () => {
  it('includes lat and lng when both are valid numbers', () => {
    const payload = buildCreateRequestPayload({ city: 'Bali', lat: -8.409518, lng: 115.188919, category: 'nature' });
    assert.equal(payload.lat, -8.409518);
    assert.equal(payload.lng, 115.188919);
  });

  it('omits both when only lat is provided', () => {
    const payload = buildCreateRequestPayload({ city: 'Bali', lat: -8.409518, category: 'nature' });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both when only lng is provided', () => {
    const payload = buildCreateRequestPayload({ city: 'Bali', lng: 115.188919, category: 'nature' });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both when neither is provided', () => {
    const payload = buildCreateRequestPayload({ city: 'Bali', category: 'nature' });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both when lat is NaN', () => {
    const payload = buildCreateRequestPayload({ city: 'Bali', lat: NaN, lng: 115.188919, category: 'nature' });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('always preserves required fields (city, category) regardless of coords', () => {
    const payload = buildCreateRequestPayload({ city: 'Bali', lat: NaN, lng: 115.0, category: 'food', notes: 'vegan' });
    assert.equal(payload.city, 'Bali');
    assert.equal(payload.category, 'food');
    assert.equal(payload.notes, 'vegan');
  });

  it('payload never has lat key without lng key', () => {
    const cases: Array<{ lat?: number; lng?: number }> = [
      { lat: 1.0 },
      { lat: 1.0, lng: undefined },
      { lat: NaN, lng: 2.0 },
      {},
    ];
    for (const coords of cases) {
      const payload = buildCreateRequestPayload({ city: 'Bangkok', category: 'city', ...coords });
      const hasLat = 'lat' in payload;
      const hasLng = 'lng' in payload;
      assert.equal(hasLat && !hasLng, false, `lat without lng for coords: ${JSON.stringify(coords)}`);
    }
  });

  it('payload never has lng key without lat key', () => {
    const cases: Array<{ lat?: number; lng?: number }> = [
      { lng: 2.0 },
      { lat: undefined, lng: 2.0 },
      { lat: 1.0, lng: NaN },
      {},
    ];
    for (const coords of cases) {
      const payload = buildCreateRequestPayload({ city: 'Bangkok', category: 'city', ...coords });
      const hasLat = 'lat' in payload;
      const hasLng = 'lng' in payload;
      assert.equal(!hasLat && hasLng, false, `lng without lat for coords: ${JSON.stringify(coords)}`);
    }
  });
});

// ── joinWaitlistV2 ────────────────────────────────────────────────────────────

describe('joinWaitlistV2 payload — both-or-null coord contract', () => {
  it('includes lat and lng when both are valid numbers', () => {
    const payload = buildJoinWaitlistV2Payload({ city: 'Barcelona', lat: 41.3851, lng: 2.1734 });
    assert.equal(payload.lat, 41.3851);
    assert.equal(payload.lng, 2.1734);
  });

  it('omits both when only lat is provided', () => {
    const payload = buildJoinWaitlistV2Payload({ city: 'Barcelona', lat: 41.3851 });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both when only lng is provided', () => {
    const payload = buildJoinWaitlistV2Payload({ city: 'Barcelona', lng: 2.1734 });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both when neither is provided', () => {
    const payload = buildJoinWaitlistV2Payload({ city: 'Barcelona' });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both when lat is NaN', () => {
    const payload = buildJoinWaitlistV2Payload({ city: 'Barcelona', lat: NaN, lng: 2.1734 });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both when lng is Infinity', () => {
    const payload = buildJoinWaitlistV2Payload({ city: 'Barcelona', lat: 41.3851, lng: Infinity });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('always preserves city and category regardless of coords', () => {
    const payload = buildJoinWaitlistV2Payload({ city: 'Rome', lat: undefined, lng: 12.4964, category: 'culture' });
    assert.equal(payload.city, 'Rome');
    assert.equal(payload.category, 'culture');
  });

  it('payload never has lat key without lng key', () => {
    const cases: Array<{ lat?: number; lng?: number }> = [
      { lat: 1.0 },
      { lat: 1.0, lng: undefined },
      { lat: NaN, lng: 2.0 },
      {},
    ];
    for (const coords of cases) {
      const payload = buildJoinWaitlistV2Payload({ city: 'Rome', ...coords });
      const hasLat = 'lat' in payload;
      const hasLng = 'lng' in payload;
      assert.equal(hasLat && !hasLng, false, `lat without lng for coords: ${JSON.stringify(coords)}`);
    }
  });

  it('payload never has lng key without lat key', () => {
    const cases: Array<{ lat?: number; lng?: number }> = [
      { lng: 2.0 },
      { lat: undefined, lng: 2.0 },
      { lat: 1.0, lng: NaN },
      {},
    ];
    for (const coords of cases) {
      const payload = buildJoinWaitlistV2Payload({ city: 'Rome', ...coords });
      const hasLat = 'lat' in payload;
      const hasLng = 'lng' in payload;
      assert.equal(!hasLat && hasLng, false, `lng without lat for coords: ${JSON.stringify(coords)}`);
    }
  });
});
