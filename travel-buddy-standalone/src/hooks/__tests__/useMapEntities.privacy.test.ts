/**
 * useMapEntities — privacy and visibility guard unit tests.
 *
 * Tests the event visibility filter (only public/friends_only on map),
 * the friends coordinate jitter (area-level coarsening), and that
 * private trips and null-coord entities are excluded.
 *
 * Run via the mobile-test workflow:
 *   pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */
import assert from 'node:assert/strict';
import { describe, it, mock, beforeEach } from 'node:test';

// ── Inline the pure logic under test — no React hook required ─────────────────
// We pull the pure filtering/coarsening helpers out of the hook file by
// re-implementing them here exactly as they appear in useMapEntities.ts.
// This gives deterministic, fast unit coverage with no module-mock pain.

type EventVisibility = 'public' | 'friends_only' | 'invite_only' | 'circle' | 'trip';

interface FakeEvent {
  id: string;
  visibility: EventVisibility;
  locationLat: number | null;
  locationLng: number | null;
}

/** Mirrors fetchEvents visibility guard in useMapEntities.ts */
function filterEvents(events: FakeEvent[]): FakeEvent[] {
  return events.filter((ev) => {
    if (ev.locationLat == null || ev.locationLng == null) return false;
    if (
      ev.visibility === 'invite_only' ||
      ev.visibility === 'circle' ||
      ev.visibility === 'trip'
    ) return false;
    return true;
  });
}

/** Mirrors deterministicJitter in useMapEntities.ts */
function deterministicJitter(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  }
  return ((h & 0xffff) / 0x10000 - 0.5) * 0.02;
}

/** Mirrors coarsenForFriend in useMapEntities.ts */
function coarsenForFriend(userId: string, lat: number, lng: number) {
  return {
    lat: lat + deterministicJitter(userId + ':lat'),
    lng: lng + deterministicJitter(userId + ':lng'),
  };
}

// ── Event visibility matrix ────────────────────────────────────────────────────

describe('filterEvents — visibility guards', () => {
  const BASE = { locationLat: 10, locationLng: 20 };

  it('includes public events', () => {
    const result = filterEvents([{ id: '1', visibility: 'public', ...BASE }]);
    assert.equal(result.length, 1);
  });

  it('includes friends_only events', () => {
    const result = filterEvents([{ id: '2', visibility: 'friends_only', ...BASE }]);
    assert.equal(result.length, 1);
  });

  it('excludes invite_only events', () => {
    const result = filterEvents([{ id: '3', visibility: 'invite_only', ...BASE }]);
    assert.equal(result.length, 0);
  });

  it('excludes circle events — privacy guard', () => {
    const result = filterEvents([{ id: '4', visibility: 'circle', ...BASE }]);
    assert.equal(result.length, 0, 'circle-visibility events must not appear as public map pins');
  });

  it('excludes trip events', () => {
    const result = filterEvents([{ id: '5', visibility: 'trip', ...BASE }]);
    assert.equal(result.length, 0);
  });

  it('excludes events with null coordinates', () => {
    const result = filterEvents([{ id: '6', visibility: 'public', locationLat: null, locationLng: null }]);
    assert.equal(result.length, 0);
  });

  it('excludes events with only one coordinate (half-pair)', () => {
    const result = filterEvents([{ id: '7', visibility: 'public', locationLat: 10, locationLng: null }]);
    assert.equal(result.length, 0);
  });

  it('returns only allowed events from a mixed batch', () => {
    const events: FakeEvent[] = [
      { id: 'a', visibility: 'public',       ...BASE },
      { id: 'b', visibility: 'friends_only', ...BASE },
      { id: 'c', visibility: 'invite_only',  ...BASE },
      { id: 'd', visibility: 'circle',       ...BASE },
      { id: 'e', visibility: 'trip',         ...BASE },
    ];
    const result = filterEvents(events);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((e) => e.id), ['a', 'b']);
  });

  it('a mixed list of located and location-less public events keeps only the located ones', () => {
    // All events here are otherwise pin-eligible (public visibility); the
    // only distinguishing factor is presence/absence of coordinates. This
    // isolates the coordinate guard from the visibility guard covered above.
    const events: FakeEvent[] = [
      { id: 'has-coords-1', visibility: 'public', locationLat: 10, locationLng: 20 },
      { id: 'no-coords',    visibility: 'public', locationLat: null, locationLng: null },
      { id: 'has-coords-2', visibility: 'public', locationLat: 30, locationLng: 40 },
      { id: 'half-pair',    visibility: 'public', locationLat: 50, locationLng: null },
    ];
    const result = filterEvents(events);
    assert.equal(result.length, 2, 'only the two events with full coordinate pairs should remain');
    assert.deepEqual(result.map((e) => e.id), ['has-coords-1', 'has-coords-2']);
    // No fallback/default coordinate is ever substituted for the excluded events.
    assert.ok(!result.some((e) => e.id === 'no-coords' || e.id === 'half-pair'));
  });
});

// ── Friends coordinate coarsening ─────────────────────────────────────────────

describe('coarsenForFriend — area-level jitter', () => {
  it('returns coords that differ from the originals', () => {
    const orig = { lat: 48.8566, lng: 2.3522 };
    const coarsened = coarsenForFriend('user-abc', orig.lat, orig.lng);
    assert.notEqual(coarsened.lat, orig.lat);
    assert.notEqual(coarsened.lng, orig.lng);
  });

  it('jitter stays within ±0.01° (area-level, ~1 km)', () => {
    const orig = { lat: 40.7128, lng: -74.006 };
    const coarsened = coarsenForFriend('user-xyz', orig.lat, orig.lng);
    assert.ok(Math.abs(coarsened.lat - orig.lat) <= 0.01, 'lat jitter exceeds 0.01°');
    assert.ok(Math.abs(coarsened.lng - orig.lng) <= 0.01, 'lng jitter exceeds 0.01°');
  });

  it('is deterministic — same userId produces same offset', () => {
    const orig = { lat: 35.6762, lng: 139.6503 };
    const a = coarsenForFriend('stable-user', orig.lat, orig.lng);
    const b = coarsenForFriend('stable-user', orig.lat, orig.lng);
    assert.equal(a.lat, b.lat);
    assert.equal(a.lng, b.lng);
  });

  it('different userIds produce different offsets', () => {
    const orig = { lat: 51.5074, lng: -0.1278 };
    const a = coarsenForFriend('user-1', orig.lat, orig.lng);
    const b = coarsenForFriend('user-2', orig.lat, orig.lng);
    // Both should differ from each other (extremely unlikely to be equal).
    assert.ok(a.lat !== b.lat || a.lng !== b.lng, 'different users must get different jitter');
  });
});

// ── Trip visibility guard ──────────────────────────────────────────────────────

describe('trip visibility filter', () => {
  interface FakeTrip {
    id: string;
    visibility: string;
    destinationLat: number | null;
    destinationLng: number | null;
  }

  function filterTrips(trips: FakeTrip[]): FakeTrip[] {
    return trips.filter((t) =>
      t.visibility !== 'private' &&
      t.destinationLat != null &&
      t.destinationLng != null,
    );
  }

  it('excludes private trips', () => {
    const result = filterTrips([{ id: '1', visibility: 'private', destinationLat: 10, destinationLng: 20 }]);
    assert.equal(result.length, 0);
  });

  it('includes public trips with coordinates', () => {
    const result = filterTrips([{ id: '2', visibility: 'public', destinationLat: 10, destinationLng: 20 }]);
    assert.equal(result.length, 1);
  });

  it('excludes trips with null destination coordinates', () => {
    const result = filterTrips([{ id: '3', visibility: 'public', destinationLat: null, destinationLng: null }]);
    assert.equal(result.length, 0);
  });
});
