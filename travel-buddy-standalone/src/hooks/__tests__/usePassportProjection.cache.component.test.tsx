/**
 * usePassportProjection — the §31 cache wiring around the fetch.
 *
 *   1. Cold: no cache → loading, then the server projection lands and is cached.
 *   2. Warm (fresh in-memory): a remount shows the full cached projection
 *      immediately, without waiting on the network.
 *   3. Stale in-memory (past the short TTL): the static half shows at once but
 *      the VOLATILE fields are blanked until the revalidation fetch replaces
 *      them — stale availability is never presented as current (§31).
 *   4. Empty userId is a no-op (no fetch, null data).
 */
import { renderHook, waitFor } from '@testing-library/react-native';

const mockGet = jest.fn();
const DENIED = {
  can_follow: false, can_message: false, can_make_plan: false,
  can_invite_trip: false, can_view_availability: false, can_view_trust: false,
};
// NOTE: intentionally exhaustive — the real service reaches Supabase/the API; the hook only needs getPassportProjection + DENIED_VIEWER_ACTIONS.
jest.mock('../../services/passportProjection.ts', () => ({
  getPassportProjection: (id: string) => mockGet(id),
  DENIED_VIEWER_ACTIONS: DENIED,
}));

import { usePassportProjection } from '../usePassportProjection.ts';
import {
  __clearMemoryCache,
  writeMemoryCache,
  VOLATILE_TTL_MS,
} from '../passportProjectionCache.ts';
import type { PassportProjectionView } from '../../services/passportProjection.ts';

function view(over: Partial<PassportProjectionView> = {}): PassportProjectionView {
  return {
    userId: 'u1',
    identity: { userId: 'u1', name: 'A', handle: 'a', avatarUrl: null, verified: true, verificationLevel: 'id', homeCountry: 'VN' },
    viewerContext: 'follower',
    travelerState: { state: 'open_to_plans', label: 'Open to Plans', city: 'Da Nang', validFrom: null, expiresAt: null },
    availability: { openToPlans: true, socialAvailability: 'open', currentWindow: null, expiresAt: null },
    trust: { label: 'Strong', publicLevel: 'strong', score: 87, confidence: 'high' },
    hasTravelIdentity: true,
    stats: { countries: 1, cities: 2, stamps: 3, trips: 4 },
    recentStamps: [], featuredJourney: null, upcomingPlans: [], memories: [],
    sharedContext: null,
    actions: { can_follow: true, can_message: true, can_make_plan: true, can_invite_trip: true, can_view_availability: true, can_view_trust: true },
    interests: [], restricted: false,
    ...over,
  };
}

beforeEach(() => {
  __clearMemoryCache();
  mockGet.mockReset();
  const AsyncStorage = require('@react-native-async-storage/async-storage');
  (AsyncStorage.clear as () => Promise<void>)?.();
});

it('cold: fetches, then serves and caches the server projection', async () => {
  mockGet.mockResolvedValue({ ok: true, data: view() });
  const { result } = await renderHook(() => usePassportProjection('u1'));

  await waitFor(() => expect(result.current.data).not.toBeNull());
  expect(result.current.data?.stats.stamps).toBe(3);
  expect(result.current.data?.availability?.openToPlans).toBe(true);
  expect(result.current.loading).toBe(false);
  expect(mockGet).toHaveBeenCalledWith('u1');
});

it('warm (fresh): a remount shows the full cached projection immediately', async () => {
  writeMemoryCache('u1', view(), Date.now());
  mockGet.mockResolvedValue({ ok: true, data: view() });

  const { result } = await renderHook(() => usePassportProjection('u1'));
  // Synchronous first render already has the cached data (no await).
  expect(result.current.data?.availability?.openToPlans).toBe(true);
  expect(result.current.data?.trust?.score).toBe(87);
});

it('stale in-memory: static half shows at once, volatile blanked until refetch', async () => {
  // Cached longer ago than the short TTL: availability/state/trust/capabilities
  // must be blanked on read even though the static half is still shown.
  writeMemoryCache('u1', view(), Date.now() - (VOLATILE_TTL_MS + 5_000));
  // The refetch will restore fresh volatile data.
  let resolveFetch: (v: unknown) => void = () => {};
  mockGet.mockReturnValue(new Promise((r) => { resolveFetch = r; }));

  const { result } = await renderHook(() => usePassportProjection('u1'));

  // Immediately: static kept, volatile blanked, capabilities denied.
  expect(result.current.data?.stats.stamps).toBe(3);
  expect(result.current.data?.availability).toBeNull();
  expect(result.current.data?.travelerState).toBeNull();
  expect(result.current.data?.trust).toBeNull();
  expect(result.current.data?.actions.can_follow).toBe(false);

  // After the fetch lands, volatile data returns.
  resolveFetch({ ok: true, data: view() });
  await waitFor(() => expect(result.current.data?.availability?.openToPlans).toBe(true));
  expect(result.current.data?.actions.can_follow).toBe(true);
});

it('empty userId is a no-op — no fetch, null data', async () => {
  const { result } = await renderHook(() => usePassportProjection(null));
  expect(result.current.data).toBeNull();
  expect(mockGet).not.toHaveBeenCalled();
});
