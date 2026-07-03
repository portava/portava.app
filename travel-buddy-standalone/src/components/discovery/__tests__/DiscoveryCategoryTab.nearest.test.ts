/**
 * Tests for the pure Nearest-sort helpers used by DiscoveryCategoryTab.
 *
 * Covers two contracts that are critical to the bootstrap re-fetch path:
 *
 *  1. shouldBootstrapNearestLoad — determines whether the location-change
 *     effect should trigger a fresh fetch because coords just arrived after
 *     the initial load ran without them.
 *
 *  2. resolveNearestFetchCoords — determines which user coords to pass to
 *     getDiscoveryPlaces so the API sorts by real user position rather than
 *     returning null (destination-centre fallback).
 *
 * The test sequence mirrors the real user flow:
 *   tap Nearest chip (no coords yet)
 *     → initial fetch fires with nearestUserLat=null (no user position)
 *     → coords arrive (permission granted or GPS unlocks)
 *     → shouldBootstrapNearestLoad must return true
 *     → resolveNearestFetchCoords must return the real coords, not null
 *
 * Run via:
 *   node --import tsx/esm --test \
 *     src/components/discovery/__tests__/DiscoveryCategoryTab.nearest.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldBootstrapNearestLoad,
  resolveNearestFetchCoords,
} from '../discoveryCategoryTabNearest.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_LAT = 48.8566;
const USER_LNG = 2.3522;
const PRIOR_COORDS = { lat: 51.5074, lng: -0.1278 };

// ── shouldBootstrapNearestLoad ────────────────────────────────────────────────

describe('shouldBootstrapNearestLoad — bootstrap case (coord transition)', () => {
  it('returns true when sortBy=nearest, coords arrive, and lastFetchedCoords is null', () => {
    assert.equal(
      shouldBootstrapNearestLoad({
        sortBy: 'nearest',
        userLat: USER_LAT,
        userLng: USER_LNG,
        lastFetchedCoords: null,
      }),
      true,
      'bootstrap re-fetch should be triggered when initial load had no user coords',
    );
  });

  it('returns false when lastFetchedCoords is already set (movement case, not bootstrap)', () => {
    assert.equal(
      shouldBootstrapNearestLoad({
        sortBy: 'nearest',
        userLat: USER_LAT,
        userLng: USER_LNG,
        lastFetchedCoords: PRIOR_COORDS,
      }),
      false,
      'movement case should not be treated as bootstrap',
    );
  });

  it('returns false when sortBy is not nearest', () => {
    assert.equal(
      shouldBootstrapNearestLoad({
        sortBy: 'popular',
        userLat: USER_LAT,
        userLng: USER_LNG,
        lastFetchedCoords: null,
      }),
      false,
    );
  });

  it('returns false when sortBy is null', () => {
    assert.equal(
      shouldBootstrapNearestLoad({
        sortBy: null,
        userLat: USER_LAT,
        userLng: USER_LNG,
        lastFetchedCoords: null,
      }),
      false,
    );
  });

  it('returns false when userLat is null (coords not yet available)', () => {
    assert.equal(
      shouldBootstrapNearestLoad({
        sortBy: 'nearest',
        userLat: null,
        userLng: USER_LNG,
        lastFetchedCoords: null,
      }),
      false,
      'must not bootstrap when only lat is missing',
    );
  });

  it('returns false when userLng is null', () => {
    assert.equal(
      shouldBootstrapNearestLoad({
        sortBy: 'nearest',
        userLat: USER_LAT,
        userLng: null,
        lastFetchedCoords: null,
      }),
      false,
      'must not bootstrap when only lng is missing',
    );
  });

  it('returns false when both coords are null (permission not yet granted)', () => {
    assert.equal(
      shouldBootstrapNearestLoad({
        sortBy: 'nearest',
        userLat: null,
        userLng: null,
        lastFetchedCoords: null,
      }),
      false,
      'no bootstrap while GPS is still pending',
    );
  });
});

// ── resolveNearestFetchCoords — coord pass-through ────────────────────────────

describe('resolveNearestFetchCoords — passes real coords when sortBy=nearest', () => {
  it('returns real user coords when sortBy=nearest (re-fetch uses correct position)', () => {
    const result = resolveNearestFetchCoords('nearest', USER_LAT, USER_LNG);
    assert.equal(
      result.nearestUserLat,
      USER_LAT,
      'nearestUserLat must be the real user latitude, not null',
    );
    assert.equal(
      result.nearestUserLng,
      USER_LNG,
      'nearestUserLng must be the real user longitude, not null',
    );
  });

  it('returns null coords when sortBy is not nearest (no user-position leakage into cache key)', () => {
    const result = resolveNearestFetchCoords('popular', USER_LAT, USER_LNG);
    assert.equal(result.nearestUserLat, null);
    assert.equal(result.nearestUserLng, null);
  });

  it('returns null coords when sortBy is null', () => {
    const result = resolveNearestFetchCoords(null, USER_LAT, USER_LNG);
    assert.equal(result.nearestUserLat, null);
    assert.equal(result.nearestUserLng, null);
  });

  it('returns null coords when sortBy is undefined', () => {
    const result = resolveNearestFetchCoords(undefined, USER_LAT, USER_LNG);
    assert.equal(result.nearestUserLat, null);
    assert.equal(result.nearestUserLng, null);
  });

  it('returns null coords even when user coords are non-null but sort is not nearest', () => {
    const result = resolveNearestFetchCoords('rating', USER_LAT, USER_LNG);
    assert.equal(result.nearestUserLat, null);
    assert.equal(result.nearestUserLng, null);
  });

  it('returns null,null when sortBy=nearest but userLat is null (coords not ready)', () => {
    const result = resolveNearestFetchCoords('nearest', null, USER_LNG);
    assert.equal(result.nearestUserLat, null);
    assert.equal(result.nearestUserLng, null);
  });

  it('returns null,null when sortBy=nearest but userLng is null', () => {
    const result = resolveNearestFetchCoords('nearest', USER_LAT, null);
    assert.equal(result.nearestUserLat, null);
    assert.equal(result.nearestUserLng, null);
  });
});

// ── Integration: both helpers together (the full bootstrap path) ───────────────

describe('bootstrap flow — shouldBootstrapNearestLoad + resolveNearestFetchCoords', () => {
  it('full bootstrap path: no coords → coords arrive → re-fetch with real position', () => {
    // Step 1: Initial state — Nearest is active but no user coords yet.
    // The initial load would have called resolveNearestFetchCoords with null coords.
    const initialFetch = resolveNearestFetchCoords('nearest', null, null);
    assert.equal(initialFetch.nearestUserLat, null, 'initial fetch must not pass user coords');
    assert.equal(initialFetch.nearestUserLng, null, 'initial fetch must not pass user coords');

    // lastFetchedCoords remains null because the initial load returned null coords
    // and the component only records them when both are non-null.
    const lastFetchedCoords = null;

    // Step 2: Coords arrive (GPS granted or permission finally resolved).
    const bootstrapShouldFire = shouldBootstrapNearestLoad({
      sortBy: 'nearest',
      userLat: USER_LAT,
      userLng: USER_LNG,
      lastFetchedCoords,
    });
    assert.equal(bootstrapShouldFire, true, 'bootstrap re-fetch must fire when coords arrive');

    // Step 3: The bootstrap load calls resolveNearestFetchCoords with real coords.
    const bootstrapFetch = resolveNearestFetchCoords('nearest', USER_LAT, USER_LNG);
    assert.equal(
      bootstrapFetch.nearestUserLat,
      USER_LAT,
      'bootstrap re-fetch must pass real nearestUserLat to getDiscoveryPlaces',
    );
    assert.equal(
      bootstrapFetch.nearestUserLng,
      USER_LNG,
      'bootstrap re-fetch must pass real nearestUserLng to getDiscoveryPlaces',
    );
  });

  it('no spurious re-fetch after the bootstrap has already run', () => {
    // After the bootstrap load completes, lastFetchedCoords is set to the
    // real coords. A subsequent location-change effect run (same coords)
    // must not trigger another bootstrap re-fetch.
    const shouldFire = shouldBootstrapNearestLoad({
      sortBy: 'nearest',
      userLat: USER_LAT,
      userLng: USER_LNG,
      lastFetchedCoords: { lat: USER_LAT, lng: USER_LNG },
    });
    assert.equal(shouldFire, false, 'no second bootstrap re-fetch once lastFetchedCoords is set');
  });
});
