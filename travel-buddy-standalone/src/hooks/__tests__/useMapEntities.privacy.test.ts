/**
 * useMapEntities — privacy and visibility guard unit tests.
 *
 * Tests the event visibility filter (only public/friends_only on map),
 * the friends coordinate jitter (area-level coarsening), and that
 * private trips and null-coord entities are excluded.
 *
 * These import the REAL helpers from ../mapEntityFilters.ts — the same module
 * useMapEntities imports — so deleting a guard from the product source turns
 * these tests red (previously they re-implemented the logic and stayed green).
 *
 * Run via the mobile-test workflow:
 *   pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coarsenForFriend,
  isMapVisibleEvent,
  isMapVisibleTrip,
  type MapEventVisibilityFields,
  type MapTripVisibilityFields,
} from '../mapEntityFilters.ts';

type EventVisibility = 'public' | 'friends_only' | 'invite_only' | 'circle' | 'trip';

interface FakeEvent extends MapEventVisibilityFields {
  id: string;
  visibility: EventVisibility;
}

/** Apply the shipped per-event visibility guard across a batch. */
function filterEvents(events: FakeEvent[]): FakeEvent[] {
  return events.filter(isMapVisibleEvent);
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
  interface FakeTrip extends MapTripVisibilityFields {
    id: string;
  }

  function filterTrips(trips: FakeTrip[]): FakeTrip[] {
    return trips.filter(isMapVisibleTrip);
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
