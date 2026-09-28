/**
 * useCommunityDiscovery — a failed read after a CITY SWITCH never presents the
 * previous city's gems (census-discovery §101, lane W11-X2 round 5; DV-83,
 * §100.11 "also found"; register D-W11X2-32), and the no-service-client
 * refusal GET /discovery/community now sends is not cached as a quiet city
 * (D-W11X2-31).
 *
 * §100 made a failed community read say `unavailable` and keep what the state
 * held. The state is not keyed by city, so after a switch from A to B a failed
 * read of B kept A's gems — shown under B's "couldn't refresh" line. The failure
 * was stated; the places were the wrong city's. Held rows are now kept only for
 * the city they were read for: a new city starts with nothing held.
 *
 *   CS1  A answered, B's read fails: unavailable, no gems (the verifier's probe, unchanged)
 *   CS2  A answered, B's read THROWS: unavailable, no gems
 *   CS3  A answered, B's read still in flight: A's gems are not presented under B
 *   CS4  B failed, then B answers: B's gems, unavailable cleared
 *   CS5  B failed, then back to A (cache hit): A's gems, not unavailable
 *   CS6  the no-service-client refusal (upstream_unavailable, `nothing`) is refused and not cached
 *   C1   CONTROL: the same city, a sort change whose read fails, keeps the city's rows (§100's F3)
 *   C2   CONTROL: a switch whose read succeeds shows B's gems only
 *
 * Run with: npx jest src/hooks/__tests__/useCommunityDiscovery.citySwitch.component.test.tsx
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

const mockGetCommunityPlaces = jest.fn();

// NOTE: exhaustive on purpose — spreading requireActual pulls in supabase/apiToken
// native deps at module load; useCommunityDiscovery imports only this one function
// (its other imports from the module are types, erased at runtime).
jest.mock('../../services/discovery.ts', () => ({
  getCommunityPlaces: (...args: unknown[]) => mockGetCommunityPlaces(...args),
}));

import { useCommunityDiscovery } from '../useCommunityDiscovery.ts';

function gem(id: string) {
  return {
    id, city: 'X', name: `Gem ${id}`, placeType: 'hidden_gem',
    category: 'hidden_gem', neighborhood: null, blurb: null, imageUrl: null,
    submittedBy: null, savedCount: 0, rating: null, source: 'traveler',
    status: 'provisional', verified: false, worthItCount: null, avgRating: null,
    reviewCount: null, note: null, tag: null, lat: null, lng: null,
    createdAt: new Date().toISOString(),
  };
}
const NET_FAIL = { ok: false, error: 'Network error — check your connection' };

beforeEach(() => { jest.clearAllMocks(); });

const page = (city: string, ...ids: string[]) => ({ ok: true, data: { items: ids.map(gem), city, total: ids.length } });

describe('useCommunityDiscovery — held rows belong to the city they were read for (DV-83, §101)', () => {
  beforeEach(() => { mockGetCommunityPlaces.mockReset(); mockGetCommunityPlaces.mockReturnValue(new Promise(() => {})); });

  it('CS1 city A answered, switch to city B whose read fails: B must not present A\'s gems', async () => {
    mockGetCommunityPlaces.mockResolvedValueOnce({ ok: true, data: { items: [gem('a1')], city: 'VrCityA', total: 1 } });
    const { result, rerender } = await renderHook(({ c }: { c: string }) => useCommunityDiscovery(c, null), { initialProps: { c: 'VrCityA' } });
    await waitFor(() => expect(result.current.gems).toHaveLength(1));
    mockGetCommunityPlaces.mockResolvedValueOnce(NET_FAIL);
    await act(async () => { rerender({ c: 'VrCityB' }); });
    await waitFor(() => expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.gems).toHaveLength(0);
  });

  it('CS2 A answered, B\'s read THROWS: unavailable, no gems', async () => {
    mockGetCommunityPlaces.mockResolvedValueOnce(page('SwCityA2', 'a2'));
    const { result, rerender } = await renderHook(({ c }: { c: string }) => useCommunityDiscovery(c, null), { initialProps: { c: 'SwCityA2' } });
    await waitFor(() => expect(result.current.gems).toHaveLength(1));
    mockGetCommunityPlaces.mockRejectedValueOnce(new Error('socket hang up'));
    await act(async () => { rerender({ c: 'SwCityB2' }); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.gems).toHaveLength(0);
    expect(result.current.places).toHaveLength(0);
  });

  it('CS3 A answered, B\'s read still in flight: A\'s gems are not presented under B', async () => {
    mockGetCommunityPlaces.mockResolvedValueOnce(page('SwCityA3', 'a3'));
    const { result, rerender } = await renderHook(({ c }: { c: string }) => useCommunityDiscovery(c, null), { initialProps: { c: 'SwCityA3' } });
    await waitFor(() => expect(result.current.gems).toHaveLength(1));
    await act(async () => { rerender({ c: 'SwCityB3' }); });
    expect(result.current.loading).toBe(true);
    expect(result.current.gems).toHaveLength(0);
    expect(result.current.places).toHaveLength(0);
  });

  it('CS4 B failed, then B answers: B\'s gems, unavailable cleared', async () => {
    mockGetCommunityPlaces.mockResolvedValueOnce(page('SwCityA4', 'a4'));
    const { result, rerender } = await renderHook(({ c, s }: { c: string; s: string | null }) => useCommunityDiscovery(c, s), { initialProps: { c: 'SwCityA4', s: null as string | null } });
    await waitFor(() => expect(result.current.gems).toHaveLength(1));
    mockGetCommunityPlaces.mockResolvedValueOnce(NET_FAIL);
    await act(async () => { rerender({ c: 'SwCityB4', s: null }); });
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    mockGetCommunityPlaces.mockResolvedValueOnce(page('SwCityB4', 'b4'));
    await act(async () => { rerender({ c: 'SwCityB4', s: 'top' }); });
    await waitFor(() => expect(result.current.gems).toHaveLength(1));
    expect(result.current.gems[0]!.id).toBe('b4');
    expect(result.current.unavailable).toBeFalsy();
  });

  it('CS5 B failed, then back to A (cache hit): A\'s gems, not unavailable', async () => {
    mockGetCommunityPlaces.mockResolvedValueOnce(page('SwCityA5', 'a5'));
    const { result, rerender } = await renderHook(({ c }: { c: string }) => useCommunityDiscovery(c, null), { initialProps: { c: 'SwCityA5' } });
    await waitFor(() => expect(result.current.gems).toHaveLength(1));
    mockGetCommunityPlaces.mockResolvedValueOnce(NET_FAIL);
    await act(async () => { rerender({ c: 'SwCityB5' }); });
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    await act(async () => { rerender({ c: 'SwCityA5' }); });
    expect(result.current.gems.map((g) => g.id)).toEqual(['a5']);
    expect(result.current.unavailable).toBeFalsy();
    expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(2);
  });

  it('CS6 the no-service-client refusal (upstream_unavailable, `nothing`) is refused and not cached', async () => {
    const REFUSED = { ok: true, data: { items: [], city: 'NoClientCity', total: 0,
      refusal: { class: 'upstream_unavailable', code: 'community_service_unavailable', route: 'GET /discovery/community', coverage: 'nothing' } } };
    mockGetCommunityPlaces.mockResolvedValueOnce(REFUSED);
    const first = await renderHook(() => useCommunityDiscovery('NoClientCity', null));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.refused).toBe(true);
    expect(first.result.current.gems).toHaveLength(0);
    await act(async () => { first.unmount(); });
    mockGetCommunityPlaces.mockResolvedValueOnce(page('NoClientCity', 'n1'));
    const second = await renderHook(() => useCommunityDiscovery('NoClientCity', null));
    await waitFor(() => expect(second.result.current.gems).toHaveLength(1));
    expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(2);
    expect(second.result.current.refused).toBe(false);
  });

  it('C1 CONTROL the same city, a sort change whose read fails, keeps the city\'s rows', async () => {
    mockGetCommunityPlaces.mockResolvedValueOnce(page('SwCityC1', 'c1'));
    const { result, rerender } = await renderHook(({ s }: { s: string | null }) => useCommunityDiscovery('SwCityC1', s), { initialProps: { s: null as string | null } });
    await waitFor(() => expect(result.current.gems).toHaveLength(1));
    mockGetCommunityPlaces.mockResolvedValueOnce(NET_FAIL);
    await act(async () => { rerender({ s: 'top' }); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.gems.map((g) => g.id)).toEqual(['c1']);
    expect(result.current.unavailable).toBe(true);
  });

  it('C2 CONTROL a switch whose read succeeds shows B\'s gems only', async () => {
    mockGetCommunityPlaces.mockResolvedValueOnce(page('SwCityA6', 'a6'));
    const { result, rerender } = await renderHook(({ c }: { c: string }) => useCommunityDiscovery(c, null), { initialProps: { c: 'SwCityA6' } });
    await waitFor(() => expect(result.current.gems).toHaveLength(1));
    mockGetCommunityPlaces.mockResolvedValueOnce(page('SwCityB6', 'b6'));
    await act(async () => { rerender({ c: 'SwCityB6' }); });
    await waitFor(() => expect(result.current.gems.map((g) => g.id)).toEqual(['b6']));
    expect(result.current.unavailable).toBeFalsy();
  });
});
