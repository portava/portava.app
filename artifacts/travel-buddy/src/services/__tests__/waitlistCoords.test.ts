/**
 * Confirms that the waitlist join payload never ships a lat without a lng
 * (or vice versa), and that the cityCoordSpread helper enforces the
 * both-or-null contract used by joinWaitlist.
 *
 * Run via the standard node:test runner:
 *   node --import tsx/esm --test src/services/__tests__/waitlistCoords.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cityCoordSpread } from '../../lib/cityCoords.ts';

// ── cityCoordSpread unit tests ────────────────────────────────────────────────

describe('cityCoordSpread — both-or-null contract', () => {
  it('returns { lat, lng } when both values are valid numbers', () => {
    const result = cityCoordSpread({ lat: 35.6762, lng: 139.6503 });
    assert.deepEqual(result, { lat: 35.6762, lng: 139.6503 });
  });

  it('returns {} when lat is missing (undefined)', () => {
    const result = cityCoordSpread({ lat: undefined, lng: 139.6503 });
    assert.deepEqual(result, {});
  });

  it('returns {} when lng is missing (undefined)', () => {
    const result = cityCoordSpread({ lat: 35.6762, lng: undefined });
    assert.deepEqual(result, {});
  });

  it('returns {} when lat is null', () => {
    const result = cityCoordSpread({ lat: null, lng: 139.6503 });
    assert.deepEqual(result, {});
  });

  it('returns {} when lng is null', () => {
    const result = cityCoordSpread({ lat: 35.6762, lng: null });
    assert.deepEqual(result, {});
  });

  it('returns {} when both values are null', () => {
    const result = cityCoordSpread({ lat: null, lng: null });
    assert.deepEqual(result, {});
  });

  it('returns {} when coords is undefined', () => {
    const result = cityCoordSpread(undefined);
    assert.deepEqual(result, {});
  });

  it('returns {} when coords is null', () => {
    const result = cityCoordSpread(null);
    assert.deepEqual(result, {});
  });

  it('returns {} when coords is an empty object', () => {
    const result = cityCoordSpread({});
    assert.deepEqual(result, {});
  });

  it('returns {} when lat is NaN', () => {
    const result = cityCoordSpread({ lat: NaN, lng: 139.6503 });
    assert.deepEqual(result, {});
  });

  it('returns {} when lng is NaN', () => {
    const result = cityCoordSpread({ lat: 35.6762, lng: NaN });
    assert.deepEqual(result, {});
  });

  it('returns {} when lat is Infinity', () => {
    const result = cityCoordSpread({ lat: Infinity, lng: 139.6503 });
    assert.deepEqual(result, {});
  });

  it('returns {} when lng is -Infinity', () => {
    const result = cityCoordSpread({ lat: 35.6762, lng: -Infinity });
    assert.deepEqual(result, {});
  });

  it('strips extra fields — only lat and lng are returned', () => {
    const result = cityCoordSpread({ lat: 1, lng: 2, altitude: 100 } as Parameters<typeof cityCoordSpread>[0]);
    assert.deepEqual(result, { lat: 1, lng: 2 });
  });

  it('strips extra fields and returns {} when coords are invalid', () => {
    const result = cityCoordSpread({ lat: null, lng: 2, altitude: 100 } as Parameters<typeof cityCoordSpread>[0]);
    assert.deepEqual(result, {});
  });
});

// ── Waitlist payload contract ─────────────────────────────────────────────────

function buildWaitlistPayload(
  city: string,
  category: string | undefined,
  coords: { lat?: number | null; lng?: number | null } | undefined,
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({ city, category, ...cityCoordSpread(coords) }),
  );
}

describe('joinWaitlist payload — both-or-null contract', () => {
  it('includes lat and lng when both are valid', () => {
    const payload = buildWaitlistPayload('Tokyo', 'city', { lat: 35.6762, lng: 139.6503 });
    assert.equal(payload.lat, 35.6762);
    assert.equal(payload.lng, 139.6503);
  });

  it('omits both lat and lng when only lat is provided', () => {
    const payload = buildWaitlistPayload('Tokyo', 'city', { lat: 35.6762 });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both lat and lng when only lng is provided', () => {
    const payload = buildWaitlistPayload('Tokyo', 'city', { lng: 139.6503 });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both lat and lng when lat is null and lng is a number', () => {
    const payload = buildWaitlistPayload('Tokyo', 'city', { lat: null, lng: 139.6503 });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both lat and lng when lng is null and lat is a number', () => {
    const payload = buildWaitlistPayload('Tokyo', 'city', { lat: 35.6762, lng: null });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both lat and lng when coords is undefined', () => {
    const payload = buildWaitlistPayload('Tokyo', 'city', undefined);
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('omits both lat and lng when both are null', () => {
    const payload = buildWaitlistPayload('Tokyo', 'city', { lat: null, lng: null });
    assert.equal('lat' in payload, false);
    assert.equal('lng' in payload, false);
  });

  it('always includes city regardless of coords', () => {
    const payload = buildWaitlistPayload('Paris', undefined, { lat: null, lng: 2.3522 });
    assert.equal(payload.city, 'Paris');
  });

  it('payload never has lat key without lng key', () => {
    const cases: Array<{ lat?: number | null; lng?: number | null } | undefined> = [
      { lat: 1.0 },
      { lat: 1.0, lng: null },
      { lat: 1.0, lng: undefined },
      { lat: NaN, lng: 2.0 },
      undefined,
      {},
    ];
    for (const coords of cases) {
      const payload = buildWaitlistPayload('Berlin', 'nightlife', coords);
      const hasLat = 'lat' in payload;
      const hasLng = 'lng' in payload;
      assert.equal(
        hasLat && !hasLng,
        false,
        `lat without lng found for coords: ${JSON.stringify(coords)}`,
      );
    }
  });

  it('payload never has lng key without lat key', () => {
    const cases: Array<{ lat?: number | null; lng?: number | null } | undefined> = [
      { lng: 2.0 },
      { lat: null, lng: 2.0 },
      { lat: undefined, lng: 2.0 },
      { lat: 1.0, lng: NaN },
      undefined,
      {},
    ];
    for (const coords of cases) {
      const payload = buildWaitlistPayload('Berlin', 'nightlife', coords);
      const hasLat = 'lat' in payload;
      const hasLng = 'lng' in payload;
      assert.equal(
        !hasLat && hasLng,
        false,
        `lng without lat found for coords: ${JSON.stringify(coords)}`,
      );
    }
  });
});
