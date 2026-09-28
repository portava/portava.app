/**
 * useCommunityDiscovery — a community read that FAILED in transport is not a
 * city with no traveler places (census-discovery §100, lane W11-X2 round 4;
 * DV-83, the round's adversarial sweep; register D-W11X2-26).
 *
 * The hook already declined to CACHE a transport failure (`!result.ok`), and it
 * kept whatever state it held. But it said nothing: `refused` stays false (a
 * refusal is a body, and there was none), `incomplete` stays false, and with
 * nothing held the state is `{ gems: [], picks: [] }` — byte-identical to a city
 * whose travelers submitted nothing. ForYouTab then drew no community section,
 * the very screen its own comment calls the defect for a refusal ("one lane
 * going quiet for a reason nobody can see is the defect, whichever lane it is").
 * The hook now says so: `unavailable`, beside whatever it kept.
 *
 *   F1  first read fails in transport: unavailable, no rows — and the rows stay absent, not "a quiet city"
 *   F2  a THROWN read is the same failure
 *   F3  a failed refetch over rows on screen keeps the rows, and says unavailable
 *   F4  a good read after a failure clears unavailable
 *   F5  the failure is not cached: the next mount asks again
 *   C1  CONTROL: a genuinely empty city is not unavailable (and not refused)
 *   C2  CONTROL: a refused read is refused, not unavailable
 *
 * Run with: npx jest src/hooks/__tests__/useCommunityDiscovery.failedRead.component.test.tsx
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

describe('useCommunityDiscovery — a transport failure is said, never a quiet city (§100, D-W11X2-26)', () => {
  it('F1 first read fails in transport: unavailable, no rows', async () => {
    mockGetCommunityPlaces.mockResolvedValue(NET_FAIL);
    const { result } = await renderHook(() => useCommunityDiscovery('FailCityOne', null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.refused).toBe(false);
    expect(result.current.gems).toEqual([]);
  });

  it('F2 a THROWN read is the same failure', async () => {
    mockGetCommunityPlaces.mockRejectedValue(new Error('socket hang up'));
    const { result } = await renderHook(() => useCommunityDiscovery('FailCityTwo', null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBe(true);
  });

  it('F3 a failed refetch over rows on screen keeps the rows, and says unavailable', async () => {
    mockGetCommunityPlaces.mockResolvedValueOnce({ ok: true, data: { items: [gem('g1')], city: 'FailCityThree', total: 1 } });
    const { result, rerender } = await renderHook(({ sort }: { sort: string | null }) => useCommunityDiscovery('FailCityThree', sort), { initialProps: { sort: null as string | null } });
    await waitFor(() => expect(result.current.gems).toHaveLength(1));
    expect(result.current.unavailable).toBeFalsy();
    mockGetCommunityPlaces.mockResolvedValueOnce(NET_FAIL);
    await act(async () => { rerender({ sort: 'top' }); });
    await waitFor(() => expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.gems).toHaveLength(1);
    expect(result.current.unavailable).toBe(true);
  });

  it('F4 a good read after a failure clears unavailable', async () => {
    mockGetCommunityPlaces.mockResolvedValueOnce(NET_FAIL);
    const { result, rerender } = await renderHook(({ sort }: { sort: string | null }) => useCommunityDiscovery('FailCityFour', sort), { initialProps: { sort: null as string | null } });
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    mockGetCommunityPlaces.mockResolvedValueOnce({ ok: true, data: { items: [gem('g2')], city: 'FailCityFour', total: 1 } });
    await act(async () => { rerender({ sort: 'top' }); });
    await waitFor(() => expect(result.current.gems).toHaveLength(1));
    expect(result.current.unavailable).toBeFalsy();
  });

  it('F5 the failure is not cached: the next mount asks again', async () => {
    mockGetCommunityPlaces.mockResolvedValue(NET_FAIL);
    const first = await renderHook(() => useCommunityDiscovery('FailCityFive', null));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => { first.unmount(); });
    mockGetCommunityPlaces.mockResolvedValue({ ok: true, data: { items: [gem('g3')], city: 'FailCityFive', total: 1 } });
    const second = await renderHook(() => useCommunityDiscovery('FailCityFive', null));
    await waitFor(() => expect(second.result.current.gems).toHaveLength(1));
    expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(2);
    expect(second.result.current.unavailable).toBeFalsy();
  });

  it('C1 CONTROL: a genuinely empty city is neither unavailable nor refused', async () => {
    mockGetCommunityPlaces.mockResolvedValue({ ok: true, data: { items: [], city: 'QuietCity', total: 0 } });
    const { result } = await renderHook(() => useCommunityDiscovery('QuietCity', null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBeFalsy();
    expect(result.current.refused).toBe(false);
  });

  it('C2 CONTROL: a refused read is refused, not unavailable', async () => {
    mockGetCommunityPlaces.mockResolvedValue({ ok: true, data: { items: [], city: 'RefCity', total: 0,
      refusal: { class: 'transient_db', code: 'community_places_read_failed', route: 'GET /discovery/community', coverage: 'nothing' } } });
    const { result } = await renderHook(() => useCommunityDiscovery('RefCity', null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.refused).toBe(true);
    expect(result.current.unavailable).toBeFalsy();
  });
});
