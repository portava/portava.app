/**
 * useCommunityDiscovery — a refused community read must not be CACHED as "no
 * hidden gems in this city".
 *
 * OWNER RULING, 2026-09-14: "Do not cache rate limits or outages as 'this
 * location does not exist.'"
 *
 * That sentence is about the server's geocode cache, and it names a shape that
 * exists on the client too. This hook keeps a MODULE-LEVEL 5-minute cache
 * (`_communityCache`, keyed on city+sort) and seeds its state from it on every
 * mount. It already declines to cache a transport failure (`!result.ok`) — but
 * a REFUSAL is `ok: true` with `items: []`, so it sailed into the cache as a
 * perfectly good result. One refused read therefore made the city's hidden gems
 * disappear for five minutes, from the device's own memory, with no further
 * network call able to notice the server had recovered.
 *
 * That is the same defect as the 24-hour geocode null, one tier down and with a
 * shorter fuse.
 *
 * Reachable from: Explore tab → app/(tabs)/discovery.tsx → ForYouTab
 * (`community = useCommunityDiscovery(destination, sortBy)`).
 *
 * Run with: pnpm test:component
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

const REFUSAL = {
  class: 'transient_db', code: 'community_places_read_failed',
  route: 'GET /discovery/community', coverage: 'nothing' as const,
};

function gem(id: string) {
  return {
    id, city: 'Cebu City', name: `Gem ${id}`, placeType: 'hidden_gem',
    category: 'hidden_gem', neighborhood: null, blurb: null, imageUrl: null,
    submittedBy: null, savedCount: 0, rating: null, source: 'traveler',
    status: 'provisional', verified: false, worthItCount: null, avgRating: null,
    reviewCount: null, note: null, tag: null, lat: null, lng: null,
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => { jest.clearAllMocks(); });

describe('useCommunityDiscovery — a refusal is not a cacheable empty city', () => {
  it('re-fetches on the next mount instead of replaying a refused read from cache', async () => {
    // Each city name is unique to its test: the cache is module-level and
    // outlives the render, which is exactly the property under test.
    const CITY = 'Refusedville';
    mockGetCommunityPlaces.mockResolvedValue({
      ok: true, data: { items: [], city: CITY, total: 0, refusal: REFUSAL },
    });
    const first = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(1));
    await act(async () => { first.unmount(); });

    mockGetCommunityPlaces.mockResolvedValue({
      ok: true, data: { items: [gem('g1')], city: CITY, total: 1 },
    });
    const second = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.result.current.gems).toHaveLength(1));
  });

  it('POSITIVE CONTROL: a GENUINELY empty city IS cached and is not re-fetched', async () => {
    // Without this the assertion above would also pass if the cache had simply
    // been switched off, which would cost every returning user a round trip and
    // remove the reason the cache exists.
    const CITY = 'Genuinelyemptyville';
    mockGetCommunityPlaces.mockResolvedValue({
      ok: true, data: { items: [], city: CITY, total: 0 },
    });
    const first = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(1));
    await act(async () => { first.unmount(); });

    await renderHook(() => useCommunityDiscovery(CITY, null));
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(1);
  });

  it('POSITIVE CONTROL: a city WITH gems is cached and is not re-fetched', async () => {
    const CITY = 'Gemville';
    mockGetCommunityPlaces.mockResolvedValue({
      ok: true, data: { items: [gem('g9')], city: CITY, total: 1 },
    });
    const first = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(first.result.current.gems).toHaveLength(1));
    await act(async () => { first.unmount(); });

    const second = await renderHook(() => useCommunityDiscovery(CITY, null));
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(1);
    expect(second.result.current.gems).toHaveLength(1);
  });

  it('reports the refusal on the state so a consumer can tell it from an empty city', async () => {
    const CITY = 'Refusedville2';
    mockGetCommunityPlaces.mockResolvedValue({
      ok: true, data: { items: [], city: CITY, total: 0, refusal: REFUSAL },
    });
    const { result } = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.refused).toBe(true);
  });

  it('a genuinely empty city reports refused:false — the control', async () => {
    const CITY = 'Genuinelyemptyville2';
    mockGetCommunityPlaces.mockResolvedValue({
      ok: true, data: { items: [], city: CITY, total: 0 },
    });
    const { result } = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.refused).toBe(false);
  });

  it('a PARTIAL refusal that returned gems IS cached — those gems are real', async () => {
    const CITY = 'Partialville';
    mockGetCommunityPlaces.mockResolvedValue({
      ok: true,
      data: { items: [gem('g2')], city: CITY, total: 1,
        refusal: { ...REFUSAL, coverage: 'partial' as const } },
    });
    const first = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(first.result.current.gems).toHaveLength(1));
    await act(async () => { first.unmount(); });

    await renderHook(() => useCommunityDiscovery(CITY, null));
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(1);
  });
});
