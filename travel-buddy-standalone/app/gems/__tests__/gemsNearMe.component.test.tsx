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
 *   NM7      the service reads `truncated` off GET /hidden-gems/nearby (and a whole body is not cut)
 *   NM8      the category changes while the first nearby read is in flight → the late first answer is dropped
 *   NM9      the hook: a failed refresh after a good read clears the rows and keeps the error
 *   NM10     the hook with no position is idle: no rows, not loading, no error, nothing read
 *   NM11     the hook: a new position shows nothing of the old one while it is read
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
import { renderHook } from '@testing-library/react-native';
import GemsScreen from '../index.tsx';
import { useNearbyGems } from '../../../src/hooks/useHiddenGems';
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

  it('NM7 the service reads `truncated` off GET /hidden-gems/nearby, and a whole body is not cut', async () => {
    const real = jest.requireActual('../../../src/services/hiddenGems') as typeof svc;
    const fetchBefore = global.fetch;
    const raw = { id: 'g1', name: 'Gem g1', category: 'food', city: 'Lisbon', latitude: 38.73, longitude: -9.15 };
    try {
      global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, gems: [raw], truncated: true }) })) as any;
      const cut = await (real as any).listNearbyGems(38.72, -9.14, 50, 'food');
      expect(cut.truncated).toBe(true);
      expect(cut.gems.map((g: any) => g.id)).toEqual(['g1']);
      expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toMatch(/\/api\/hidden-gems\/nearby\?lat=38\.72&lng=-9\.14&radiusKm=50&limit=50&category=food$/);
      global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, gems: [raw] }) })) as any;
      expect((await (real as any).listNearbyGems(38.72, -9.14, 50)).truncated).toBe(false);
    } finally { global.fetch = fetchBefore; }
  });

  it('NM8 the category changes while the first nearby read is in flight → the late first answer is dropped', async () => {
    let first: (v: any) => void = () => {};
    listNearbyGems.mockImplementation((_la: number, _ln: number, _r: number, cat?: string) =>
      cat === 'food' ? Promise.resolve({ gems: [gem('b', 'Lisbon', 38.73, -9.15)], truncated: false }) : new Promise((r) => { first = r; }));
    await nearMe();
    await act(async () => { fireEvent.press(screen.getByText('Food')); });
    await waitFor(() => expect(screen.getByText('Gem b')).toBeTruthy());
    await act(async () => { first({ gems: [gem('a', 'Lisbon', 38.73, -9.15)], truncated: false }); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText('Gem a')).toBeNull();
    expect(screen.getByText('Gem b')).toBeTruthy();
  });

  it('NM9 the hook: a failed refresh after a good read clears the rows and keeps the error', async () => {
    listNearbyGems.mockResolvedValueOnce({ gems: [gem('a', 'Lisbon', 38.73, -9.15)], truncated: true }).mockRejectedValueOnce(new Error('offline'));
    const { result } = await renderHook(() => useNearbyGems({ lat: 38.72, lng: -9.14 }));
    await waitFor(() => expect(result.current.gems.length).toBe(1));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.error).toBe('offline');
    expect(result.current.gems).toEqual([]);
    expect(result.current.truncated).toBe(false);
  });

  it('NM10 the hook with no position is idle: no rows, not loading, no error, nothing read', async () => {
    const { result } = await renderHook(() => useNearbyGems(null));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current).toMatchObject({ gems: [], loading: false, error: null, truncated: false });
    expect(listNearbyGems).not.toHaveBeenCalled();
  });

  it('NM11 the hook: a new position shows nothing of the old one while it is read', async () => {
    listNearbyGems.mockResolvedValueOnce({ gems: [gem('a', 'Lisbon', 38.73, -9.15)], truncated: true }).mockImplementationOnce(() => new Promise(() => {}));
    const { result, rerender } = await renderHook((p: { c: { lat: number; lng: number } }) => useNearbyGems(p.c), { initialProps: { c: { lat: 38.72, lng: -9.14 } } });
    await waitFor(() => expect(result.current.gems.length).toBe(1));
    await rerender({ c: { lat: 41.15, lng: -8.61 } });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.loading).toBe(true);
    expect(result.current.gems).toEqual([]);
    expect(result.current.truncated).toBe(false);
  });

  it('NMc CONTROL: without Near Me the city list is read and shown as before', async () => {
    listGems.mockResolvedValue([gem('a', 'Lisbon', 38.73, -9.15)]);
    await render(<GemsScreen />);
    await waitFor(() => expect(screen.getByText('Gem a')).toBeTruthy());
    expect(listNearbyGems).not.toHaveBeenCalled();
    expect(screen.queryByText('Showing some gems near you')).toBeNull();
  });
});
