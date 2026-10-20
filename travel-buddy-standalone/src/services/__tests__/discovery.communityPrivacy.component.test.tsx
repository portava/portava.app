import { act, renderHook, waitFor } from '@testing-library/react-native';
import { getCommunityPlaces, _setDiscoveryTokenSourceForTests, type CommunityPlaceItem } from '../discovery.ts';
import {
  _resetDiscoveryViewerScopeForTests,
  invalidateDiscoveryCaches,
  setDiscoveryViewerFromSession,
} from '../discoveryViewerScope.ts';
import { useCommunityDiscovery, _communityCacheSizeForTests } from '../../hooks/useCommunityDiscovery.ts';
import { communityBylineText } from '../../features/discovery/communityByline.ts';

const CITY = 'CommunityPrivacyCity';
const realFetch = global.fetch;
const originalApiBase = process.env.EXPO_PUBLIC_API_BASE_URL;
let fetchMock: jest.Mock;

function communityResponse(displayName: string | null, cacheControl = 'private, no-store', legacy = false, handle: string | null = 'traveler') {
  const submittedBy: CommunityPlaceItem['submittedBy'] = {
    id: 'submitter', name: legacy ? 'Unredacted legacy name' : displayName,
    displayName, handle, avatarUrl: null,
  };
  const items = (['hidden_gem', 'traveler_pick'] as const).map((placeType) => ({
    id: placeType, name: `Place ${placeType}`, city: CITY, placeType,
    category: 'food', neighborhood: null, blurb: null, imageUrl: null,
    submittedBy, savedCount: 0, tag: null, note: null, rating: null,
    source: 'traveler', status: 'provisional', verified: false,
    createdAt: '2026-10-16T00:00:00.000Z', lat: null, lng: null,
  }));
  return new Response(JSON.stringify({ items, city: CITY, total: items.length }), {
    status: 200, headers: { 'Cache-Control': cacheControl },
  });
}

function bylines(state: ReturnType<typeof useCommunityDiscovery>) {
  return [
    ...state.gems.map((gem) => communityBylineText(gem.submittedBy)),
    ...state.picks.map((pick) => communityBylineText(pick.user)),
  ];
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolveResponse) => { resolve = resolveResponse; });
  return { promise, resolve };
}

beforeEach(() => {
  _resetDiscoveryViewerScopeForTests();
  setDiscoveryViewerFromSession('viewer');
  const payload = Buffer.from(JSON.stringify({ sub: 'viewer' })).toString('base64url');
  _setDiscoveryTokenSourceForTests(async () => `header.${payload}.signature`);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

afterEach(() => {
  global.fetch = realFetch;
  _setDiscoveryTokenSourceForTests(null);
  jest.restoreAllMocks();
  if (originalApiBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalApiBase;
});

describe('C19 community privacy through the real service and feed hook', () => {
  it.each([false, true])('uses only permission-safe fields for both bylines (legacy=%s)', async (legacy) => {
    fetchMock.mockResolvedValue(communityResponse(null, 'private, no-store', legacy));
    const hook = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(bylines(hook.result.current)).toEqual(['@traveler', '@traveler']));
    expect(hook.result.current.gems[0].submittedBy?.name).toBe('@traveler');
    expect(hook.result.current.picks[0].user.name).toBe('@traveler');
    expect(JSON.stringify(hook.result.current)).not.toContain('Unredacted legacy name');
  });

  it('bypasses pre-rollout HTTP caches while retaining the viewer token', async () => {
    fetchMock.mockResolvedValue(communityResponse(null));
    await getCommunityPlaces(CITY);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      cache: 'no-store', headers: { Authorization: expect.stringMatching(/^Bearer /) },
    });
  });

  it('with no permitted name or handle, both feed bylines say Traveler', async () => {
    fetchMock.mockResolvedValue(communityResponse(null, 'private, no-store', true, null));
    const hook = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(bylines(hook.result.current)).toEqual(['Traveler', 'Traveler']));
    expect(JSON.stringify(hook.result.current)).not.toContain('Unredacted legacy name');
  });

  it.each(['private, no-store', 'PRIVATE, No-Store', 'private, no-cache'])('does not retain %s responses across navigation', async (cacheControl) => {
    fetchMock.mockResolvedValueOnce(communityResponse('Previously allowed name', cacheControl));
    const first = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(bylines(first.result.current)).toEqual(['Previously allowed name', 'Previously allowed name']));
    await first.unmount();
    expect(_communityCacheSizeForTests()).toBe(0);

    const revoked = deferredResponse();
    fetchMock.mockReturnValueOnce(revoked.promise);
    const renders: string[][] = [];
    const second = await renderHook(() => {
      const state = useCommunityDiscovery(CITY);
      renders.push(bylines(state));
      return state;
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(renders[0]).toEqual([]);
    await act(async () => { revoked.resolve(communityResponse(null, cacheControl)); });
    await waitFor(() => expect(bylines(second.result.current)).toEqual(['@traveler', '@traveler']));
    expect(renders.flat()).not.toContain('Previously allowed name');
  });

  it('preserves legacy cache behavior when the server permits reuse', async () => {
    fetchMock.mockResolvedValue(communityResponse(null, 'private, max-age=60', true));
    const first = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(bylines(first.result.current)).toEqual(['@traveler', '@traveler']));
    await first.unmount();
    const second = await renderHook(() => useCommunityDiscovery(CITY));
    expect(bylines(second.result.current)).toEqual(['@traveler', '@traveler']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('evicts a previous cache entry when revalidation changes to no-store', async () => {
    const clock = jest.spyOn(Date, 'now');
    const start = Date.now();
    clock.mockReturnValue(start);
    fetchMock.mockResolvedValueOnce(communityResponse('Previously allowed name', 'private, max-age=60'));
    const first = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await first.unmount();
    expect(_communityCacheSizeForTests()).toBe(1);

    clock.mockReturnValue(start + 5 * 60_000 + 1);
    fetchMock.mockResolvedValueOnce(communityResponse(null));
    const second = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(bylines(second.result.current)).toEqual(['@traveler', '@traveler']));
    await second.unmount();
    expect(_communityCacheSizeForTests()).toBe(0);

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const third = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(third.result.current.loading).toBe(false));
    expect(bylines(third.result.current)).toEqual([]);
  });

  it('refresh rechecks permission rather than keeping a cached byline', async () => {
    fetchMock.mockResolvedValueOnce(communityResponse('Previously allowed name', 'private, max-age=60'));
    const hook = await renderHook(({ refreshKey }: { refreshKey: number }) => useCommunityDiscovery(CITY, null, refreshKey), {
      initialProps: { refreshKey: 0 },
    });
    await waitFor(() => expect(bylines(hook.result.current)).toEqual(['Previously allowed name', 'Previously allowed name']));

    const revoked = deferredResponse();
    fetchMock.mockReturnValueOnce(revoked.promise);
    await hook.rerender({ refreshKey: 1 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bylines(hook.result.current)).toEqual([]);
    await act(async () => { revoked.resolve(communityResponse(null)); });
    await waitFor(() => expect(bylines(hook.result.current)).toEqual(['@traveler', '@traveler']));
  });

  it('clears mounted bylines on invalidation even if the replacement read fails', async () => {
    fetchMock.mockResolvedValueOnce(communityResponse('Previously allowed name'));
    const hook = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(bylines(hook.result.current)).toEqual(['Previously allowed name', 'Previously allowed name']));

    const replacement = deferredResponse();
    fetchMock.mockReturnValueOnce(replacement.promise);
    await act(async () => { invalidateDiscoveryCaches(); });
    expect(bylines(hook.result.current)).toEqual([]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => { replacement.resolve(new Response('{}', { status: 503 })); });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(bylines(hook.result.current)).toEqual([]);
    expect(_communityCacheSizeForTests()).toBe(0);
  });

  it('refuses a service answer fetched before a permission invalidation', async () => {
    const stale = deferredResponse();
    fetchMock.mockReturnValueOnce(stale.promise);
    const pending = getCommunityPlaces(CITY);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    invalidateDiscoveryCaches();
    stale.resolve(communityResponse('Previously allowed name'));
    expect(await pending).toMatchObject({ ok: false });
  });

  it('a pre-invalidation response cannot overwrite a newer canonical null byline', async () => {
    const stale = deferredResponse();
    fetchMock.mockReturnValueOnce(stale.promise);
    const renders: string[][] = [];
    const hook = await renderHook(() => {
      const state = useCommunityDiscovery(CITY);
      renders.push(bylines(state));
      return state;
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fetchMock.mockResolvedValueOnce(communityResponse(null));
    await act(async () => { invalidateDiscoveryCaches(); });
    await waitFor(() => expect(bylines(hook.result.current)).toEqual(['@traveler', '@traveler']));
    await act(async () => { stale.resolve(communityResponse('Previously allowed name')); });
    expect(bylines(hook.result.current)).toEqual(['@traveler', '@traveler']);
    expect(renders.flat()).not.toContain('Previously allowed name');
    expect(_communityCacheSizeForTests()).toBe(0);
  });

  it('unmount cancels a reload started after a legacy cache-hit mount', async () => {
    fetchMock.mockResolvedValueOnce(communityResponse(null, 'private, max-age=60'));
    const first = await renderHook(() => useCommunityDiscovery(CITY));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await first.unmount();
    const second = await renderHook(() => useCommunityDiscovery(CITY));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const pending = deferredResponse();
    fetchMock.mockReturnValueOnce(pending.promise);
    await act(async () => { invalidateDiscoveryCaches(); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await second.unmount();
    await act(async () => { pending.resolve(communityResponse('Previously allowed name', 'private, max-age=60')); });
    expect(_communityCacheSizeForTests()).toBe(0);
  });
});
