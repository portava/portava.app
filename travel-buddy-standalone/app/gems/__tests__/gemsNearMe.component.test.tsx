/**
 * census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-131): the Gems Discover tab's "Near Me" asks the server
 * for gems near the viewer (GET /hidden-gems/nearby) and never says "No hidden gems found" over a capped read.
 *
 * It filtered, on the device, the default page `useGemList({})` held — GET /hidden-gems' 40 gems, ranked from an
 * unordered 120-row scan of every active gem — to 50 km, and said "No hidden gems found — Try a different city or
 * category" when none of those 40 was near (the round-15 verifier's B3).
 *
 *   V15-NM0  CONTROL (the verifier's, adapted): a gem 2 km away → listed under Near Me
 *   V15-NM1  (the verifier's) a full page of 40 far gems → never "No hidden gems found" for Near Me
 *   NM2      Near Me asks the server with the viewer's position, a 50 km radius and the chosen category
 *   NM3      the server's nearby read is cut and holds nothing → "Couldn't check every gem near you", never "none"
 *   NM4      the nearby read fails → the error with a Retry, never the empty state
 *   NM5      a cut nearby read with rows → the rows, and "Showing some gems near you"
 *   NM6      a whole, empty nearby read → "No hidden gems near you" (the honest empty, said for Near Me)
 *   NMc      CONTROL: without Near Me the city list is read and shown as before
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react-native';

// NOTE: exhaustive on purpose — the screen reads only useRouter from expo-router here; the spread keeps the rest.
jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
// NOTE: exhaustive on purpose — the screen reads only getCurrentGps from the location service.
jest.mock('../../../src/services/location', () => ({ getCurrentGps: jest.fn(async () => ({ granted: true, lat: 38.72, lng: -9.14, accuracyMeters: 10, error: null })) }));
jest.mock('../../../src/services/hiddenGems', () => ({
  ...jest.requireActual('../../../src/services/hiddenGems'),
  listGems: jest.fn(async () => []), getSavedGems: jest.fn(async () => []), getLayoverGems: jest.fn(async () => []),
  listNearbyGems: jest.fn(async () => ({ gems: [], truncated: false })),
}));
import GemsScreen from '../index.tsx';
import * as svc from '../../../src/services/hiddenGems';

const listGems = svc.listGems as jest.Mock;
const listNearbyGems = (svc as any).listNearbyGems as jest.Mock;
const gem = (id: string, city: string, lat: number, lng: number) => ({ id, name: `Gem ${id}`, category: 'food', city, country: null, neighborhood: null, description: null, lat, lng, coordsPrecision: 'exact', vibeTags: [], priceRange: null, safetyNotes: null, bestTimeToGo: null, localEtiquette: null, layoverSafe: false, minimumLayoverMinutes: null, sensitivityLevel: 'public', verificationLevel: 'guide', status: 'active', submittedBy: null, imageUrl: null, canonicalPlaceId: null, saveCount: 0, visitCount: 0, createdAt: '', updatedAt: '', gemState: null, gemConfidence: null, visitOutcomes: null });
afterEach(() => { cleanup(); jest.clearAllMocks(); });

async function nearMe() {
  await render(<GemsScreen />);
  await waitFor(() => expect(listGems.mock.calls.length).toBeGreaterThan(0));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  await act(async () => { fireEvent.press(screen.getByText('Near Me')); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

describe('§113: Gems "Near Me" reads the server near the viewer (D-W11X2-131)', () => {
  it('V15-NM0 CONTROL: a gem 2 km away → listed under Near Me', async () => {
    listGems.mockResolvedValue([gem('near', 'Lisbon', 38.73, -9.15), gem('far', 'Tokyo', 35.68, 139.69)]);
    listNearbyGems.mockResolvedValue({ gems: [gem('near', 'Lisbon', 38.73, -9.15)], truncated: false });
    await nearMe();
    expect(screen.getByText('Gem near')).toBeTruthy();
    expect(screen.queryByText('Gem far')).toBeNull();
  });

  it('V15-NM1 a FULL page of 40 far-away gems (the server cap) → never "No hidden gems found" for Near Me', async () => {
    listGems.mockResolvedValue(Array.from({ length: 40 }, (_, i) => gem(`t${i}`, 'Tokyo', 35.68, 139.69)));
    listNearbyGems.mockResolvedValue({ gems: [], truncated: true });
    await nearMe();
    expect(screen.queryByText('No hidden gems found')).toBeNull();
  });

  it('NM2 Near Me asks the server with the position, 50 km and the category', async () => {
    await nearMe();
    await waitFor(() => expect(listNearbyGems).toHaveBeenCalled());
    expect(listNearbyGems.mock.calls[0].slice(0, 3)).toEqual([38.72, -9.14, 50]);
    await act(async () => { fireEvent.press(screen.getByText('Food')); });
    await waitFor(() => expect(listNearbyGems.mock.calls.some((c) => c[3] === 'food')).toBe(true));
  });

  it("NM3 a cut nearby read with nothing in it → \"Couldn't check every gem near you\", never \"none\"", async () => {
    listNearbyGems.mockResolvedValue({ gems: [], truncated: true });
    await nearMe();
    expect(screen.getByText("Couldn't check every gem near you")).toBeTruthy();
    expect(screen.queryByText('No hidden gems found')).toBeNull();
    expect(screen.queryByText('No hidden gems near you')).toBeNull();
  });

  it('NM4 the nearby read fails → the error with a Retry, never the empty state', async () => {
    listNearbyGems.mockRejectedValueOnce(new Error('Request failed (503)')).mockResolvedValue({ gems: [gem('near', 'Lisbon', 38.73, -9.15)], truncated: false });
    await nearMe();
    expect(screen.getByText('Request failed (503)')).toBeTruthy();
    expect(screen.queryByText('No hidden gems near you')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByText('Retry')); });
    await waitFor(() => expect(screen.getByText('Gem near')).toBeTruthy());
  });

  it('NM5 a cut nearby read with rows → the rows, and "Showing some gems near you"', async () => {
    listNearbyGems.mockResolvedValue({ gems: [gem('near', 'Lisbon', 38.73, -9.15)], truncated: true });
    await nearMe();
    expect(screen.getByText('Gem near')).toBeTruthy();
    expect(screen.getByText('Showing some gems near you')).toBeTruthy();
  });

  it('NM6 a whole, empty nearby read → "No hidden gems near you"', async () => {
    listNearbyGems.mockResolvedValue({ gems: [], truncated: false });
    await nearMe();
    expect(screen.getByText('No hidden gems near you')).toBeTruthy();
    expect(screen.queryByText("Couldn't check every gem near you")).toBeNull();
  });

  it('NMc CONTROL: without Near Me the city list is read and shown as before', async () => {
    listGems.mockResolvedValue([gem('a', 'Lisbon', 38.73, -9.15)]);
    await render(<GemsScreen />);
    await waitFor(() => expect(screen.getByText('Gem a')).toBeTruthy());
    expect(listNearbyGems).not.toHaveBeenCalled();
    expect(screen.queryByText('Showing some gems near you')).toBeNull();
  });
});
