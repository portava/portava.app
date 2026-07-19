/**
 * useActiveLocation.gpsRevocation.test.ts
 *
 * Unit tests for the GPS-revocation state transition: when the user revokes
 * location permission after GPS was live, the app must clear the stale GPS
 * source rather than continuing to show a location the user has blocked.
 *
 * Exercises `buildGpsRevokedState` from `activeLocation.state.ts`.
 * This is a pure helper — no React renderer is needed.
 *
 * Coverage:
 *  1. source:gps_fresh → permission denied → source becomes 'none' (not 'gps_fresh')
 *  2. source:gps_fresh → permission denied → permissionStatus becomes 'denied'
 *  3. source:gps_fresh → permission denied → coords are cleared
 *  4. source:gps_fresh → permission denied → ok becomes false
 *  5. source:gps_fresh → permission denied → freshness becomes 'unavailable'
 *  6. source:gps_fresh → permission denied → place is preserved (kept for display)
 *  7. source:gps_cached → permission denied → source also clears (not just live fix)
 *  8. source:gps (legacy) → permission denied → source also clears
 *  9. GPS unavailable (not denied) → source clears + permissionStatus:'unavailable'
 * 10. source:home → permission denied → source is preserved (non-GPS fallback kept)
 * 11. source:home → permission denied → permissionStatus still becomes 'denied'
 * 12. source:manual_city → permission denied → source is preserved
 * 13. userMessage matches the denial reason (denied vs unavailable)
 *
 * Run (auto-discovered by scripts/run-node-tests.mjs):
 *   node --import tsx/esm --test src/hooks/__tests__/useActiveLocation.gpsRevocation.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGpsRevokedState, shouldRestorePersistedState } from '../activeLocation.state.ts';
import type { ActiveLocationState } from '../useActiveLocation.ts';
import type { Place } from '../../lib/location/placeTypes.ts';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const GPS_PLACE: Place = {
  id: 'gps-osaka',
  type: 'city',
  name: 'Osaka',
  displayName: 'Osaka, Japan',
  country: 'Japan',
  countryCode: 'JP',
  region: null,
  city: 'Osaka',
  district: null,
  lat: 34.6937,
  lng: 135.5022,
  timezone: 'Asia/Tokyo',
  source: 'gps',
};

const HOME_PLACE: Place = {
  id: 'home-tokyo',
  type: 'city',
  name: 'Tokyo',
  displayName: 'Tokyo, Japan',
  country: 'Japan',
  countryCode: 'JP',
  region: null,
  city: 'Tokyo',
  district: null,
  lat: null,
  lng: null,
  timezone: null,
  source: 'manual',
};

const GPS_FRESH_STATE: ActiveLocationState = {
  ok: true,
  permissionStatus: 'granted',
  source: 'gps_fresh',
  freshness: 'live',
  coords: { lat: 34.6937, lng: 135.5022, accuracyMeters: 10 },
  place: GPS_PLACE,
  lastUpdatedAt: '2026-07-19T10:00:00.000Z',
  userMessage: null,
};

const HOME_STATE: ActiveLocationState = {
  ok: true,
  permissionStatus: 'denied',
  source: 'home',
  freshness: 'stale',
  coords: null,
  place: HOME_PLACE,
  lastUpdatedAt: null,
  userMessage: null,
};

const MANUAL_STATE: ActiveLocationState = {
  ok: true,
  permissionStatus: 'granted',
  source: 'manual_city',
  freshness: 'live',
  coords: null,
  place: HOME_PLACE,
  lastUpdatedAt: '2026-07-19T09:00:00.000Z',
  userMessage: null,
};

// ── source:gps_fresh revocation ───────────────────────────────────────────────

describe('buildGpsRevokedState — gps_fresh source is cleared on denial', () => {
  it('source becomes "none" — not "gps_fresh" — after permission is denied', () => {
    const next = buildGpsRevokedState(GPS_FRESH_STATE, 'denied');
    assert.notEqual(next.source, 'gps_fresh',
      'source must not remain gps_fresh after permission is revoked');
    assert.equal(next.source, 'none');
  });

  it('permissionStatus becomes "denied"', () => {
    const next = buildGpsRevokedState(GPS_FRESH_STATE, 'denied');
    assert.equal(next.permissionStatus, 'denied');
  });

  it('coords are cleared to null — stale GPS coords are not kept', () => {
    const next = buildGpsRevokedState(GPS_FRESH_STATE, 'denied');
    assert.equal(next.coords, null,
      'coords must be cleared when GPS permission is revoked');
  });

  it('ok becomes false when GPS source is cleared', () => {
    const next = buildGpsRevokedState(GPS_FRESH_STATE, 'denied');
    assert.equal(next.ok, false);
  });

  it('freshness becomes "unavailable"', () => {
    const next = buildGpsRevokedState(GPS_FRESH_STATE, 'denied');
    assert.equal(next.freshness, 'unavailable');
  });

  it('place is preserved (the last known city can still be displayed)', () => {
    const next = buildGpsRevokedState(GPS_FRESH_STATE, 'denied');
    assert.equal(next.place.id, GPS_PLACE.id,
      'place should be preserved so the UI can display the last known city');
  });
});

// ── Other GPS source variants ─────────────────────────────────────────────────

describe('buildGpsRevokedState — gps_cached source is also cleared', () => {
  it('source becomes "none" when gps_cached is revoked', () => {
    const cachedState: ActiveLocationState = {
      ...GPS_FRESH_STATE,
      source: 'gps_cached',
      freshness: 'recent',
    };
    const next = buildGpsRevokedState(cachedState, 'denied');
    assert.notEqual(next.source, 'gps_cached');
    assert.equal(next.source, 'none');
  });
});

describe('buildGpsRevokedState — legacy "gps" source is also cleared', () => {
  it('source becomes "none" for legacy source:"gps"', () => {
    const legacyState: ActiveLocationState = {
      ...GPS_FRESH_STATE,
      source: 'gps',
    };
    const next = buildGpsRevokedState(legacyState, 'denied');
    assert.notEqual(next.source, 'gps');
    assert.equal(next.source, 'none');
  });
});

// ── "unavailable" (timeout) vs "denied" ──────────────────────────────────────

describe('buildGpsRevokedState — unavailable (timeout) also clears GPS', () => {
  it('source becomes "none" and permissionStatus is "unavailable" on GPS timeout', () => {
    const next = buildGpsRevokedState(GPS_FRESH_STATE, 'unavailable');
    assert.equal(next.source, 'none');
    assert.equal(next.permissionStatus, 'unavailable');
    assert.equal(next.coords, null);
  });

  it('userMessage references the timeout — not the denial message', () => {
    const next = buildGpsRevokedState(GPS_FRESH_STATE, 'unavailable');
    assert.ok(
      typeof next.userMessage === 'string' && next.userMessage.includes('timed out'),
      'userMessage should reference the timeout reason',
    );
  });
});

// ── Non-GPS sources are preserved ────────────────────────────────────────────

describe('buildGpsRevokedState — home-city fallback is preserved when permission is denied', () => {
  it('source remains "home" — non-GPS location is not cleared', () => {
    const next = buildGpsRevokedState(HOME_STATE, 'denied');
    assert.equal(next.source, 'home',
      'source:home must not be cleared — the user still has a valid fallback location');
  });

  it('permissionStatus is updated to "denied" even for a home-city state', () => {
    const next = buildGpsRevokedState(HOME_STATE, 'denied');
    assert.equal(next.permissionStatus, 'denied');
  });

  it('ok stays true for a home-city state — the location is still usable', () => {
    const next = buildGpsRevokedState(HOME_STATE, 'denied');
    assert.equal(next.ok, true);
  });
});

describe('buildGpsRevokedState — manual_city source is preserved when permission is denied', () => {
  it('source remains "manual_city"', () => {
    const next = buildGpsRevokedState(MANUAL_STATE, 'denied');
    assert.equal(next.source, 'manual_city');
  });

  it('permissionStatus is updated to "denied"', () => {
    const next = buildGpsRevokedState(MANUAL_STATE, 'denied');
    assert.equal(next.permissionStatus, 'denied');
  });
});

// ── userMessage content ───────────────────────────────────────────────────────

describe('buildGpsRevokedState — userMessage matches the denial reason', () => {
  it('denied userMessage mentions "Location is off"', () => {
    const next = buildGpsRevokedState(GPS_FRESH_STATE, 'denied');
    assert.ok(
      typeof next.userMessage === 'string' && next.userMessage.includes('Location is off'),
      'denied message should prompt the user to choose a city manually',
    );
  });

  it('unavailable userMessage mentions "timed out"', () => {
    const next = buildGpsRevokedState(GPS_FRESH_STATE, 'unavailable');
    assert.ok(
      typeof next.userMessage === 'string' && next.userMessage.includes('timed out'),
    );
  });
});

// ── shouldRestorePersistedState — on-mount cascade guard ─────────────────────
//
// Covers the bug: on app restart after GPS revocation, the mount cascade was
// re-applying server-persisted GPS coords (source:'last_known') even though
// permission was now 'denied'. The guard must block that restore.

const LAST_KNOWN_STATE: ActiveLocationState = {
  ok: true,
  permissionStatus: 'granted',
  source: 'last_known',
  freshness: 'stale',
  coords: { lat: 34.6937, lng: 135.5022, accuracyMeters: 10 },
  place: GPS_PLACE,
  lastUpdatedAt: '2026-07-19T08:00:00.000Z',
  userMessage: null,
};

const MANUAL_CITY_STATE: ActiveLocationState = {
  ok: true,
  permissionStatus: 'granted',
  source: 'manual_city',
  freshness: 'live',
  coords: null,
  place: HOME_PLACE,
  lastUpdatedAt: '2026-07-19T09:00:00.000Z',
  userMessage: null,
};

describe('shouldRestorePersistedState — blocks GPS state when permission is denied', () => {
  it('returns false for source:last_known when permission is denied — stale GPS must not be restored', () => {
    const result = shouldRestorePersistedState('denied', LAST_KNOWN_STATE);
    assert.equal(result, false,
      'server-persisted GPS coords must not be re-applied after permission is revoked');
  });

  it('returns true for source:last_known when permission is granted — normal restore path', () => {
    const result = shouldRestorePersistedState('granted', LAST_KNOWN_STATE);
    assert.equal(result, true);
  });

  it('returns true for source:last_known when permission is unknown — not yet checked, allow restore', () => {
    const result = shouldRestorePersistedState('unknown', LAST_KNOWN_STATE);
    assert.equal(result, true);
  });

  it('returns true for source:manual_city when permission is denied — manual location is unaffected by GPS revocation', () => {
    const result = shouldRestorePersistedState('denied', MANUAL_CITY_STATE);
    assert.equal(result, true,
      'a manually-set city must survive GPS revocation');
  });

  it('returns true for source:manual_city when permission is granted', () => {
    const result = shouldRestorePersistedState('granted', MANUAL_CITY_STATE);
    assert.equal(result, true);
  });

  it('returns true for source:none (no saved coords) when permission is denied — nothing to block', () => {
    const emptyState: ActiveLocationState = {
      ...LAST_KNOWN_STATE,
      ok: false,
      source: 'none',
      coords: null,
    };
    const result = shouldRestorePersistedState('denied', emptyState);
    assert.equal(result, true);
  });
});
