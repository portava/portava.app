/**
 * useSnapshotCache — user-isolation and transition tests.
 *
 * Run with: pnpm --dir travel-buddy-standalone test:component -- --testPathPattern=useSnapshotCache
 *
 * ## What's covered
 *
 * The hook namespaces snapshot keys per-user (`snap:v1:<key>:<userId>`).
 * These tests confirm that cached data from one user never leaks into
 * another user's session, and that going from authenticated → logged-out
 * also clears the in-memory snapshot.
 *
 *  1. User A's cached snapshot is cleared when the hook transitions to User B
 *     (no cache for User B) — not carried over into User B's view.
 *  2. User A's snapshot is cleared when userId becomes null (logout).
 *  3. After the user-switch, the hook loads User B's own cached data (not A's).
 *  4. A fresh mount with no userId starts with snapshot=null and never calls
 *     getItem (no key to read).
 *
 * ## Assertion strategy
 *
 * `waitFor` is used throughout so tests poll until the condition is true
 * rather than asserting on a specific React flush boundary. This avoids
 * brittle act()-timing issues while still verifying the data-isolation
 * guarantee: User A's data is NOT present after the switch, and User B's
 * data (if cached) IS present after the switch settles.
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSnapshotCache } from '../useSnapshotCache.ts';
import { useSession } from '../../context/SessionContext.tsx'; // eslint-disable-line @typescript-eslint/no-unused-vars

// NOTE: intentionally exhaustive — SessionContext imports Supabase client
// initialisation that requires network/env vars unavailable under Jest.
// We return a jest.fn() so beforeEach can control userId without referencing
// out-of-scope variables inside the factory (jest.mock is hoisted).
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: jest.fn(),
}));

// AsyncStorage is globally mapped by jest.config.js to the official jest mock
// (@react-native-async-storage/async-storage/jest/async-storage-mock), which
// provides jest.fn() spies for getItem/setItem/removeItem. We use jest.spyOn
// to control return values without replacing the global mapping.

// ── Typed mock ref ─────────────────────────────────────────────────────────────

const mockUseSession = useSession as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEntry<T>(data: T, ageMs = 0): string {
  return JSON.stringify({ data, savedAt: Date.now() - ageMs });
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('useSnapshotCache — user isolation across account switches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: authenticated as user-a, no AsyncStorage data.
    mockUseSession.mockReturnValue({ userId: 'user-a', isAuthed: true });
    jest.spyOn(AsyncStorage, 'getItem').mockResolvedValue(null);
    jest.spyOn(AsyncStorage, 'setItem').mockResolvedValue(undefined);
    jest.spyOn(AsyncStorage, 'removeItem').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    // Drain any residual async state updates to prevent cross-test bleed.
    await act(async () => {});
  });

  it('clears snapshot after userId switches to a new user with no cache', async () => {
    // User A has a cached snapshot; User B has none.
    jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key) => {
      if (key === 'snap:v1:pulse:user-a') return makeEntry({ posts: ['post-1'] });
      return null;
    });

    const { result, rerender } = await renderHook(() =>
      useSnapshotCache<{ posts: string[] }>('pulse'),
    );

    // Wait for User A's cache to load.
    await waitFor(() => {
      expect(result.current.snapshot?.posts).toEqual(['post-1']);
    }, { timeout: 500 });

    // Switch to User B (no cache).
    mockUseSession.mockReturnValue({ userId: 'user-b', isAuthed: true });
    rerender({});

    // After the switch settles, User A's data must be gone and no data for B.
    await waitFor(() => {
      expect(result.current.snapshot).toBeNull();
    }, { timeout: 500 });

    expect(result.current.isStale).toBe(false);
  });

  it('clears snapshot after userId becomes null (logout)', async () => {
    // User A has a cached snapshot.
    jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key) => {
      if (key === 'snap:v1:passport:user-a') return makeEntry({ bio: 'Hello' });
      return null;
    });

    const { result, rerender } = await renderHook(() =>
      useSnapshotCache<{ bio: string }>('passport'),
    );

    // Wait for User A's cache to load.
    await waitFor(() => {
      expect(result.current.snapshot).not.toBeNull();
    }, { timeout: 500 });

    // User logs out.
    mockUseSession.mockReturnValue({ userId: null, isAuthed: false });
    rerender({});

    // After logout settles, snapshot must be null.
    await waitFor(() => {
      expect(result.current.snapshot).toBeNull();
    }, { timeout: 500 });

    expect(result.current.isStale).toBe(false);
  });

  it("loads User B's own cached data after the switch — not User A's", async () => {
    // Both users have their own cached data.
    jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key) => {
      if (key === 'snap:v1:trips:user-a') return makeEntry({ trips: ['trip-a'] });
      if (key === 'snap:v1:trips:user-b') return makeEntry({ trips: ['trip-b'] });
      return null;
    });

    const { result, rerender } = await renderHook(() =>
      useSnapshotCache<{ trips: string[] }>('trips'),
    );

    // Wait for User A's data.
    await waitFor(() => {
      expect(result.current.snapshot?.trips).toEqual(['trip-a']);
    }, { timeout: 500 });

    // Switch to User B.
    mockUseSession.mockReturnValue({ userId: 'user-b', isAuthed: true });
    rerender({});

    // After the switch settles, User B's data must be present — not User A's.
    await waitFor(() => {
      expect(result.current.snapshot?.trips).toEqual(['trip-b']);
    }, { timeout: 500 });

    // Confirm User A's stale data is not present.
    expect(result.current.snapshot?.trips).not.toContain('trip-a');
  });

  it('starts with snapshot=null on a fresh mount when there is no userId', async () => {
    mockUseSession.mockReturnValue({ userId: null, isAuthed: false });
    const getItemSpy = jest.spyOn(AsyncStorage, 'getItem');

    const { result } = await renderHook(() =>
      useSnapshotCache<{ items: number[] }>('events'),
    );

    await act(async () => {});

    expect(result.current.snapshot).toBeNull();
    expect(result.current.isStale).toBe(false);
    // getItem must NOT have been called — no userId means no key to read.
    expect(getItemSpy).not.toHaveBeenCalled();
  });
});
