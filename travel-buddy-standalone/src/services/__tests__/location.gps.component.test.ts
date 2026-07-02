/**
 * Unit tests for getCurrentGps() in services/location.ts
 *
 * Covers:
 *  • permission denied → { granted: false, error: 'permission_denied' }
 *  • fresh live fix succeeds → { granted: true, cached: false }
 *  • live fix fails → falls back to last-known position → { granted: true, cached: true }
 *  • live fix fails AND last-known returns null → { granted: false, error: 'gps_failed' }
 *  • live fix fails AND last-known throws → { granted: false, error: 'gps_failed' }
 *  • last-known cache call receives correct maxAge / requiredAccuracy constraints
 *  • outer permission error is caught and returned as error string
 *
 * Run with:  pnpm test:component
 *
 * expo-location is mocked; no real device I/O occurs.
 * getCurrentPositionAsync is made to reject instantly so no fake timers
 * are needed to trigger the 8-second GPS_TIMEOUT_MS path.
 */

import { getCurrentGps } from '../location';

// ── expo-location mock ────────────────────────────────────────────────────────

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync:           jest.fn(),
  getLastKnownPositionAsync:         jest.fn(),
  Accuracy: { Balanced: 3, High: 4 },
}));

import * as Location from 'expo-location';

const mockRequestPerms        = Location.requestForegroundPermissionsAsync as jest.Mock;
const mockGetCurrentPosition  = Location.getCurrentPositionAsync          as jest.Mock;
const mockGetLastKnown        = Location.getLastKnownPositionAsync         as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LIVE_POS = {
  coords: { latitude: 48.8584, longitude: 2.2945, accuracy: 12.5 },
  timestamp: Date.now(),
};

const CACHED_POS = {
  coords: { latitude: 48.8600, longitude: 2.2960, accuracy: 45.0 },
  timestamp: Date.now() - 90_000,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getCurrentGps()', () => {
  it('returns error: permission_denied when foreground permission is denied', async () => {
    mockRequestPerms.mockResolvedValue({ status: 'denied' });

    const result = await getCurrentGps();

    expect(result.granted).toBe(false);
    expect(result.error).toBe('permission_denied');
    expect(result.lat).toBeNull();
    expect(result.lng).toBeNull();
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });

  it('returns cached: false when the live GPS fix succeeds (gps_fresh path)', async () => {
    mockRequestPerms.mockResolvedValue({ status: 'granted' });
    mockGetCurrentPosition.mockResolvedValue(LIVE_POS);

    const result = await getCurrentGps();

    expect(result.granted).toBe(true);
    expect(result.cached).toBe(false);
    expect(result.lat).toBe(LIVE_POS.coords.latitude);
    expect(result.lng).toBe(LIVE_POS.coords.longitude);
    expect(result.accuracyMeters).toBe(LIVE_POS.coords.accuracy);
    expect(result.error).toBeUndefined();
    expect(mockGetLastKnown).not.toHaveBeenCalled();
  });

  it('falls back to last-known position and returns cached: true (gps_cached path)', async () => {
    mockRequestPerms.mockResolvedValue({ status: 'granted' });
    mockGetCurrentPosition.mockRejectedValue(new Error('location unavailable'));
    mockGetLastKnown.mockResolvedValue(CACHED_POS);

    const result = await getCurrentGps();

    expect(result.granted).toBe(true);
    expect(result.cached).toBe(true);
    expect(result.lat).toBe(CACHED_POS.coords.latitude);
    expect(result.lng).toBe(CACHED_POS.coords.longitude);
    expect(result.error).toBeUndefined();
  });

  it('calls getLastKnownPositionAsync with correct maxAge and requiredAccuracy', async () => {
    mockRequestPerms.mockResolvedValue({ status: 'granted' });
    mockGetCurrentPosition.mockRejectedValue(new Error('timeout'));
    mockGetLastKnown.mockResolvedValue(CACHED_POS);

    await getCurrentGps();

    expect(mockGetLastKnown).toHaveBeenCalledWith({
      maxAge:           5 * 60 * 1000,
      requiredAccuracy: 500,
    });
  });

  it('returns error: gps_failed when live fix fails and last-known returns null', async () => {
    mockRequestPerms.mockResolvedValue({ status: 'granted' });
    mockGetCurrentPosition.mockRejectedValue(new Error('timeout'));
    mockGetLastKnown.mockResolvedValue(null);

    const result = await getCurrentGps();

    expect(result.granted).toBe(false);
    expect(result.error).toBe('gps_failed');
    expect(result.lat).toBeNull();
    expect(result.lng).toBeNull();
  });

  it('returns error: gps_failed when both live fix and last-known throw', async () => {
    mockRequestPerms.mockResolvedValue({ status: 'granted' });
    mockGetCurrentPosition.mockRejectedValue(new Error('timeout'));
    mockGetLastKnown.mockRejectedValue(new Error('no cache'));

    const result = await getCurrentGps();

    expect(result.granted).toBe(false);
    expect(result.error).toBe('gps_failed');
  });

  it('returns error from the outer catch when requestForegroundPermissionsAsync throws', async () => {
    mockRequestPerms.mockRejectedValue(new Error('permission_api_crash'));

    const result = await getCurrentGps();

    expect(result.granted).toBe(false);
    expect(result.error).toBe('permission_api_crash');
  });
});
