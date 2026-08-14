/**
 * usePublicPassport — reload() refresh coverage.
 *
 * Task 3272 added `reload()` to support pull-to-refresh on the public
 * profile screen (see app/u/__tests__/publicProfile.pullToRefresh.component.test.tsx
 * for the screen-level wiring). This file covers the hook itself: does
 * calling reload() actually re-invoke the passport + postcards services,
 * in the right order, without silently dropping data on partial failures?
 *
 * NOTE: named `.component.test.ts` (not `.test.ts`) so it is actually
 * picked up — `pnpm test` (node:test) cannot render React hooks, and Jest's
 * `test:component` script filters on the `.component.test.` pattern.
 *
 * Coverage (per task spec):
 *   1. Successful reload — both getPublicPassport and getPublicPostcards
 *      are re-invoked, and profile/postcards state is refreshed.
 *   2. Reload after a partial fetch error (postcards fetch fails on the
 *      second call) — the postcards service is still called, and its
 *      failure does not wipe out the freshly-reloaded profile.
 *   3. Reload while the profile is private — the sentinel branch runs
 *      again on refresh and postcards is never called for a private
 *      profile, on either the initial load or reload.
 *   4. reload() does not reset state to the blank loading placeholder —
 *      existing content stays visible while the refetch is in flight
 *      (this is the whole point of pull-to-refresh).
 *
 * Run: pnpm --dir travel-buddy-standalone run test:component -- --testPathPattern=usePublicPassport
 */

import { renderHook, act, waitFor, cleanup } from '@testing-library/react-native';
import { usePublicPassport } from '../usePublicPassport.ts';

const mockGetPublicPassport = jest.fn();
const mockGetPublicPostcards = jest.fn();

// NOTE: intentionally exhaustive — the real module imports Supabase / network.
jest.mock('../../services/profile.ts', () => ({
  getPublicPassport: (...args: unknown[]) => mockGetPublicPassport(...args),
  getPublicPostcards: (...args: unknown[]) => mockGetPublicPostcards(...args),
}));

const PROFILE_A = { id: 'user-1', handle: 'traveler42', displayName: 'Traveler 42', stampsEarned: 5 } as any;
const PROFILE_A_REFRESHED = { id: 'user-1', handle: 'traveler42', displayName: 'Traveler 42', stampsEarned: 9 } as any;

const POSTCARDS_A = [{ id: 'pc-1' }] as any;
const POSTCARDS_A_REFRESHED = [{ id: 'pc-1' }, { id: 'pc-2' }] as any;

describe('usePublicPassport — reload() refresh coverage', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) — mockResolvedValueOnce queues must
    // not bleed between tests; clearAllMocks only wipes call history, not
    // queued "once" implementations.
    jest.resetAllMocks();
  });

  afterEach(async () => {
    await act(async () => {});
    cleanup();
  });

  it('reload() re-invokes both passport and postcards services and refreshes state', async () => {
    mockGetPublicPassport.mockResolvedValueOnce({ ok: true, data: PROFILE_A });
    mockGetPublicPostcards.mockResolvedValueOnce({ ok: true, data: POSTCARDS_A, sentinel: undefined });

    const { result, rerender } = await renderHook((u: string) => usePublicPassport(u), { initialProps: 'traveler42' });

    await waitFor(() => {
      expect(result.current.profile).toEqual(PROFILE_A);
      expect(result.current.postcards).toEqual(POSTCARDS_A);
    });

    expect(mockGetPublicPassport).toHaveBeenCalledTimes(1);
    expect(mockGetPublicPostcards).toHaveBeenCalledTimes(1);

    mockGetPublicPassport.mockResolvedValueOnce({ ok: true, data: PROFILE_A_REFRESHED });
    mockGetPublicPostcards.mockResolvedValueOnce({ ok: true, data: POSTCARDS_A_REFRESHED, sentinel: undefined });

    result.current.reload();
    rerender('traveler42');

    await waitFor(() => {
      expect(mockGetPublicPassport).toHaveBeenCalledTimes(2);
      expect(mockGetPublicPostcards).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(result.current.profile).toEqual(PROFILE_A_REFRESHED);
      expect(result.current.postcards).toEqual(POSTCARDS_A_REFRESHED);
    });

    // Both services must have been called with the same username on reload.
    expect(mockGetPublicPassport).toHaveBeenNthCalledWith(2, 'traveler42');
    expect(mockGetPublicPostcards).toHaveBeenNthCalledWith(2, 'traveler42');
  });

  it('reload() does not reset to the blank loading placeholder — content stays visible during refetch', async () => {
    mockGetPublicPassport.mockResolvedValueOnce({ ok: true, data: PROFILE_A });
    mockGetPublicPostcards.mockResolvedValueOnce({ ok: true, data: POSTCARDS_A, sentinel: undefined });

    const { result, rerender } = await renderHook((u: string) => usePublicPassport(u), { initialProps: 'traveler42' });

    await waitFor(() => {
      expect(result.current.profile).toEqual(PROFILE_A);
      expect(result.current.loading).toBe(false);
    });

    // Second fetch hangs — never resolves during this assertion window.
    let resolvePassport!: (v: unknown) => void;
    mockGetPublicPassport.mockReturnValueOnce(new Promise((resolve) => { resolvePassport = resolve; }));
    // Queued for when the hanging passport fetch above eventually resolves
    // and the effect proceeds to fetch postcards.
    mockGetPublicPostcards.mockResolvedValueOnce({ ok: true, data: POSTCARDS_A_REFRESHED, sentinel: undefined });

    result.current.reload();
    rerender('traveler42');

    // While the refetch is in flight, existing profile/postcards must remain
    // visible and `loading` must NOT flip back to true (unlike a cold mount).
    expect(result.current.profile).toEqual(PROFILE_A);
    expect(result.current.postcards).toEqual(POSTCARDS_A);
    expect(result.current.loading).toBe(false);

    // Let the hanging fetch resolve and fully settle so no pending promise
    // leaks into the next test (which would corrupt its render).
    resolvePassport({ ok: true, data: PROFILE_A_REFRESHED });
    await waitFor(() => {
      expect(result.current.profile).toEqual(PROFILE_A_REFRESHED);
      expect(result.current.postcards).toEqual(POSTCARDS_A_REFRESHED);
    });
  });

  it('reload() after a postcards-fetch error keeps the refreshed profile — does not silently drop it', async () => {
    mockGetPublicPassport.mockResolvedValueOnce({ ok: true, data: PROFILE_A });
    mockGetPublicPostcards.mockResolvedValueOnce({ ok: true, data: POSTCARDS_A, sentinel: undefined });

    const { result, rerender } = await renderHook((u: string) => usePublicPassport(u), { initialProps: 'traveler42' });

    await waitFor(() => {
      expect(result.current.profile).toEqual(PROFILE_A);
    });

    // Reload: passport succeeds with fresh data, but the postcards fetch
    // itself fails outright (ok: false) — a partial failure.
    mockGetPublicPassport.mockResolvedValueOnce({ ok: true, data: PROFILE_A_REFRESHED });
    mockGetPublicPostcards.mockResolvedValueOnce({ ok: false, data: null, errorKind: 'db_error' });

    result.current.reload();
    rerender('traveler42');

    await waitFor(() => {
      expect(mockGetPublicPostcards).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      // Profile refresh must not be silently dropped by the postcards failure.
      expect(result.current.profile).toEqual(PROFILE_A_REFRESHED);
    });

    // Postcards service was invoked (not skipped) even though it failed —
    // its failure clears stale postcards rather than leaving them stuck.
    expect(result.current.postcards).toEqual([]);
    expect(result.current.postcardSentinel).toBeNull();
    // A postcards-only failure must not surface as a page-level error.
    expect(result.current.error).toBeNull();
  });

  it('reload() while private re-runs the private sentinel branch and never calls postcards', async () => {
    const PRIVATE_SENTINEL = {
      visibility: 'private',
      id: 'user-2',
      username: 'lockeddown',
      displayName: 'Locked Down',
      avatarUrl: null,
      is_friend: false,
      friend_request_pending: false,
    };

    mockGetPublicPassport.mockResolvedValueOnce({ ok: true, data: PRIVATE_SENTINEL });

    const { result, rerender } = await renderHook((u: string) => usePublicPassport(u), { initialProps: 'lockeddown' });

    await waitFor(() => {
      expect(result.current.isPrivate).toBe(true);
      expect(result.current.previewProfile?.id).toBe('user-2');
    });

    expect(mockGetPublicPostcards).not.toHaveBeenCalled();

    // Reload: server still reports private, but with an updated pending flag
    // (e.g. viewer just sent a friend request from another screen).
    mockGetPublicPassport.mockResolvedValueOnce({
      ok: true,
      data: { ...PRIVATE_SENTINEL, friend_request_pending: true },
    });

    result.current.reload();
    rerender('lockeddown');

    await waitFor(() => {
      expect(mockGetPublicPassport).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(result.current.friendRequestPending).toBe(true);
    });

    expect(result.current.isPrivate).toBe(true);
    // Postcards must never be fetched for a private profile, on initial load
    // or on reload — the sentinel branch returns before that call.
    expect(mockGetPublicPostcards).not.toHaveBeenCalled();
  });
});
