/**
 * useCommunityDiscovery — the module cache is per viewer.
 * census-discovery §50 (the client-correctness lane).
 *
 * `GET /api/discovery/community` is now sent with the viewer's token, and what
 * it returns is the viewer's: bylines are shown or withheld per viewer, and the
 * submitters the viewer blocked (either direction) or muted are removed. This
 * hook keeps a MODULE-LEVEL 5-minute cache and seeds its first render from it,
 * keyed on (city, sort) — so without a viewer term, one account's gems (and the
 * real names that account was allowed to see) were painted for the next account
 * to open the tab on the same phone, and a gem whose submitter the viewer had
 * just blocked came back from memory on the next mount.
 *
 * `getCommunityPlaces` is stubbed; the viewer scope
 * (`services/discoveryViewerScope.ts`) is REAL — it is the thing under test.
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

import { useCommunityDiscovery, _communityCacheSizeForTests } from '../useCommunityDiscovery.ts';
import {
  setDiscoveryViewerFromSession,
  invalidateDiscoveryCaches,
  currentDiscoveryScope,
  _resetDiscoveryViewerScopeForTests,
} from '../../services/discoveryViewerScope.ts';

function gem(id: string, submitterName: string | null) {
  return {
    id, city: 'Cebu City', name: `Gem ${id}`, placeType: 'hidden_gem',
    category: 'hidden_gem', neighborhood: null, blurb: null, imageUrl: null,
    submittedBy: { id: `s-${id}`, name: submitterName ?? '@sub', displayName: submitterName, handle: 'sub', avatarUrl: null },
    savedCount: 0, rating: null, source: 'traveler',
    status: 'provisional', verified: false, worthItCount: null, avgRating: null,
    reviewCount: null, note: null, tag: null, lat: null, lng: null,
    createdAt: new Date().toISOString(),
  };
}

/** What the service answers when it fetched as the CURRENT viewer. */
function answer(...items: ReturnType<typeof gem>[]) {
  return { ok: true, data: { items, city: 'Cebu', total: items.length }, scope: currentDiscoveryScope() };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetDiscoveryViewerScopeForTests();
});

describe('useCommunityDiscovery — one viewer\'s gems are never painted for another', () => {
  it('X\'s cached gems do not seed Y\'s first render, and Y\'s mount re-fetches', async () => {
    const CITY = 'ViewerSwitchCity';
    setDiscoveryViewerFromSession('user-x');
    mockGetCommunityPlaces.mockImplementation(async () => answer(gem('x1', 'Seen By X Only')));
    const first = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(first.result.current.gems).toHaveLength(1));
    await act(async () => { first.unmount(); });

    expect(_communityCacheSizeForTests()).toBeGreaterThan(0);
    setDiscoveryViewerFromSession('user-y');
    // Not merely unreadable: the previous viewer's bylines are not held at all.
    expect(_communityCacheSizeForTests()).toBe(0);
    mockGetCommunityPlaces.mockImplementation(async () => answer());
    // Every render is recorded: the defect is in the FIRST one, which is seeded
    // synchronously from the module cache before any request could run.
    const renders: Array<{ gems: unknown[]; loading: boolean }> = [];
    const second = await renderHook(() => {
      const s = useCommunityDiscovery(CITY, null);
      renders.push({ gems: s.gems, loading: s.loading });
      return s;
    });
    expect(renders[0].gems).toEqual([]);
    expect(renders[0].loading).toBe(true);
    // No render ever showed X's gem.
    await waitFor(() => expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(renders.every((r) => r.gems.length === 0)).toBe(true);
  });

  it('CONTROL: the same viewer re-mounting IS served from the cache, without a fetch', async () => {
    const CITY = 'SameViewerCity';
    setDiscoveryViewerFromSession('user-x');
    mockGetCommunityPlaces.mockImplementation(async () => answer(gem('x1', null)));
    const first = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(first.result.current.gems).toHaveLength(1));
    await act(async () => { first.unmount(); });

    const second = await renderHook(() => useCommunityDiscovery(CITY, null));
    expect(second.result.current.gems).toHaveLength(1);
    expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(1);
  });

  it('a block (or mute, or dismissal) clears it: the next mount re-fetches', async () => {
    const CITY = 'BlockCity';
    setDiscoveryViewerFromSession('user-x');
    mockGetCommunityPlaces.mockImplementation(async () => answer(gem('z1', null)));
    const first = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(first.result.current.gems).toHaveLength(1));
    await act(async () => { first.unmount(); });

    invalidateDiscoveryCaches();
    mockGetCommunityPlaces.mockImplementation(async () => answer());
    const second = await renderHook(() => useCommunityDiscovery(CITY, null));
    expect(second.result.current.gems).toEqual([]);
    await waitFor(() => expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(2));
  });

  it('an answer whose scope moved while it was in flight is shown but NOT cached', async () => {
    const CITY = 'InFlightBlockCity';
    setDiscoveryViewerFromSession('user-x');
    // The service hands back the scope the request was SENT in; a block lands
    // before the hook writes, so that scope is no longer current.
    mockGetCommunityPlaces.mockImplementation(async () => {
      const sentIn = currentDiscoveryScope();
      invalidateDiscoveryCaches();
      return { ok: true, data: { items: [gem('z1', null)], city: 'Cebu', total: 1 }, scope: sentIn };
    });
    const first = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(first.result.current.gems).toHaveLength(1));
    await act(async () => { first.unmount(); });

    mockGetCommunityPlaces.mockImplementation(async () => answer());
    await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(2));
  });

  it('MOUNTED across an account switch: X\'s gems are dropped and re-fetched as Y', async () => {
    const CITY = 'MountedSwitchCity';
    setDiscoveryViewerFromSession('user-x');
    mockGetCommunityPlaces.mockImplementation(async () => answer(gem('x1', 'Seen By X Only')));
    const hook = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(hook.result.current.gems).toHaveLength(1));

    mockGetCommunityPlaces.mockImplementation(async () => answer(gem('y1', null)));
    await act(async () => { setDiscoveryViewerFromSession('user-y'); });

    await waitFor(() => expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.gems.map((g) => g.id)).toEqual(['y1']));
  });

  it('CONTROL: a first-ever viewer being learned (nobody → X) is not a switch and fetches nothing extra', async () => {
    const CITY = 'FirstViewerCity';
    mockGetCommunityPlaces.mockImplementation(async () => answer(gem('a1', null)));
    const hook = await renderHook(() => useCommunityDiscovery(CITY, null));
    await waitFor(() => expect(hook.result.current.gems).toHaveLength(1));
    await act(async () => { setDiscoveryViewerFromSession('user-x'); });
    // Give a spurious reload the chance to happen before asserting it did not.
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(mockGetCommunityPlaces).toHaveBeenCalledTimes(1);
  });
});
