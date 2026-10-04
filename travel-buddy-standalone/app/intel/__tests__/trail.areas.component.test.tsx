/**
 * Trail ("where next?") — a tester can actually reach a destination area, and a
 * failure to find one is not reported as "no areas".
 *
 * THE DEFECT. The area list comes from GET /api/cities/neighborhoods, which
 * needs a CITY, and the screen only fetched it when a `city` route param was
 * supplied. Its one launcher — Quick Signal's "Leaving soon? Share your exit" —
 * passes subjectId/subjectName/venue and no city, so the fetch never ran, the
 * list stayed empty, and every tester read "No nearby areas to choose from yet"
 * with nothing to tap: the Trail capture surface could not be used at all. The
 * same sentence also covered location denied and every failed read.
 *
 * Now the screen derives the city from the device's own fix (reverse geocode)
 * when none is passed, and says which of four things is true: still looking,
 * location is off, the areas could not be loaded (Try again), or there really
 * are none. CONTROLLED evidence: location, geocoder and network are doubles.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
}));
let mockParams: Record<string, string> = {};
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// NOTE: intentional stub — flags and Safe Return are not under test here.
jest.mock('../../../src/hooks/useIntelPrompts', () => ({
  useIntelPrompts: () => ({ captureEnabled: true, trailEnabled: true, safeReturnActive: false }),
}));
const mockGps = jest.fn();
const mockReverse = jest.fn();
// NOTE: intentionally exhaustive — the real module loads expo-location natively.
jest.mock('../../../src/services/location', () => ({
  getCurrentGps: (...a: unknown[]) => mockGps(...a),
  reverseGeocodeToPlace: (...a: unknown[]) => mockReverse(...a),
}));
const mockAreas = jest.fn();
jest.mock('../../../src/services/neighborhoods', () => ({
  ...jest.requireActual('../../../src/services/neighborhoods'),
  fetchCityNeighborhoods: (...a: unknown[]) => mockAreas(...a),
}));
const mockSubmit = jest.fn();
// NOTE: intentionally exhaustive — the real service does an authed fetch with a native token store.
jest.mock('../../../src/services/intelCapture', () => ({
  submitTrailMovement: (...a: unknown[]) => mockSubmit(...a),
  makeIdempotencyKey: () => 'k',
}));

import TrailScreen from '../trail';

const FIX = { granted: true, lat: 16.06, lng: 108.22, accuracyMeters: 20 };
const AREAS = { areas: [{ name: 'Son Tra' }, { name: 'Hai Chau' }] };

beforeEach(() => {
  [mockGps, mockReverse, mockAreas, mockSubmit].forEach((m) => m.mockReset());
  mockParams = { subjectId: 'place-1', subjectName: 'Cafe Giang', venue: 'cafe' }; // exactly what Quick Signal sends
});

describe('Trail — reachable from Quick Signal, which passes no city', () => {
  it('derives the city from the device fix, loads its areas, and lets the person send one', async () => {
    mockGps.mockResolvedValue(FIX);
    mockReverse.mockResolvedValue({ city: 'Da Nang' });
    mockAreas.mockResolvedValue(AREAS);
    mockSubmit.mockResolvedValue({ ok: true });
    const r = await render(<TrailScreen />);
    fireEvent.press(await r.findByTestId('intel-trail-area-Son Tra'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 'place-1', destinationArea: 'Son Tra' })));
    expect(mockAreas).toHaveBeenCalledWith('Da Nang', FIX.lat, FIX.lng);
    expect(r.queryByText(/No nearby areas/)).toBeNull();
  });

  it('a passed city is used as-is, without a reverse geocode', async () => {
    mockParams = { ...mockParams, city: 'Hoi An' };
    mockGps.mockResolvedValue(FIX);
    mockAreas.mockResolvedValue(AREAS);
    const r = await render(<TrailScreen />);
    await r.findByTestId('intel-trail-area-Hai Chau');
    expect(mockReverse).not.toHaveBeenCalled();
    expect(mockAreas).toHaveBeenCalledWith('Hoi An', FIX.lat, FIX.lng);
  });
});

describe('Trail — what is shown when there are no areas to pick', () => {
  it('location OFF says so — it is not "no areas"', async () => {
    mockGps.mockResolvedValue({ granted: false, lat: null, lng: null, accuracyMeters: null, error: 'permission_denied' });
    const r = await render(<TrailScreen />);
    await r.findByTestId('intel-trail-areas-no-location');
    expect(r.queryByText(/No nearby areas/)).toBeNull();
  });

  it('a FAILED area read says it could not load, and Try again re-reads', async () => {
    mockGps.mockResolvedValue(FIX);
    mockReverse.mockResolvedValue({ city: 'Da Nang' });
    mockAreas.mockResolvedValueOnce(null).mockResolvedValueOnce(AREAS);
    const r = await render(<TrailScreen />);
    await r.findByTestId('intel-trail-areas-unavailable');
    expect(r.queryByText(/No nearby areas/)).toBeNull();
    fireEvent.press(r.getByText('Try again'));
    await r.findByTestId('intel-trail-area-Son Tra');
  });

  it('a fix the geocoder cannot name a city for is "could not load", not "none"', async () => {
    mockGps.mockResolvedValue(FIX);
    mockReverse.mockResolvedValue({ city: null });
    const r = await render(<TrailScreen />);
    await r.findByTestId('intel-trail-areas-unavailable');
    expect(mockAreas).not.toHaveBeenCalled();
  });

  it('a server that ANSWERED with no areas is the one case that says there are none', async () => {
    mockGps.mockResolvedValue(FIX);
    mockReverse.mockResolvedValue({ city: 'Da Nang' });
    mockAreas.mockResolvedValue({ areas: [], reason: 'no_data' });
    const r = await render(<TrailScreen />);
    await r.findByText(/No nearby areas/);
  });
});
