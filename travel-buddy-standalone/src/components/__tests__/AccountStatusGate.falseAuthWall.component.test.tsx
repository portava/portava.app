/**
 * AccountStatusGate — the false "Couldn't verify your account" wall (task 3658).
 *
 * THE DEFECT
 * ==========
 * Navigating /search → /discovery raised the full-page "Couldn't verify your
 * account" wall while the session was live and other requests were succeeding.
 * Two independent causes, both of which made the app assert a check that had
 * never run:
 *
 *  1. `getAccountStatus()` returned errorKind 'unauthenticated' BOTH when the
 *     server answered 401 and when `freshToken()` returned null without ever
 *     sending a request. `fetchAccountStatus` failed closed on the pair, so one
 *     lost token mint raised the wall. The client-side case is now
 *     TOKEN_UNAVAILABLE and fails open; the server's 401 still fails closed.
 *
 *  2. `fetchAccountStatus(null)` set accountStatusLoaded = TRUE alongside
 *     accountStatus = null — the exact pair the gate renders as the wall — when
 *     the truth is that nothing had been asked. Stated precisely, because the
 *     temptation is to overclaim it: this is a STATE-TRUTHFULNESS defect, and it
 *     is NOT established as the cause of the persistent wall. Its render-level
 *     consequence is one frame between the userId commit and the effect that
 *     clears it, which React coalesces. Cause 1 is the one that latches.
 *
 * WHAT EACH TEST IS FOR
 * =====================
 * Verified against the unfixed tree (which already carried a first attempt at
 * this fix, `83e443d38`, widening fail-open to ALL of 'unauthenticated'):
 *
 *   RED without the fix — these are the ones that carry the defect:
 *     · 401 still fails closed          (catches 83e443d38's regression)
 *     · TOKEN_UNAVAILABLE raises no wall
 *     · TOKEN_UNAVAILABLE is a hold, not a bypass
 *     · signed out ⇒ NOT ASKED
 *
 *   GREEN either way — deliberately, and each is here for a reason:
 *     · the two remaining POSITIVE CONTROLs. Most assertions in this file are
 *       "the wall is NOT shown", and that whole set passes trivially against a
 *       gate that stopped blocking for any reason at all — deleting
 *       StatusErrorScreen would look identical to classifying correctly. These
 *       two hold the other end.
 *     · "settles back to the app" — a no-regression companion, not evidence.
 *
 * A test in this file that is green both ways and is NOT on that second list is
 * a test that has stopped meaning anything. Check before trusting it.
 *
 * ## Act strategy
 * `render` is AWAITED: under React 19 + RNTL v14 it returns a promise, and an
 * un-awaited call resolves after the assertions (and often after teardown), which
 * surfaces as "`render` function has not been called". Bare render + `waitFor`,
 * matching DiscoveryShareSheet.searchReset — wrapping
 * in `await act()` under React 19 produces overlapping-act warnings. The auth
 * callback is driven inside `act` because it is an external event source.
 *
 * ## Mock strategy
 * services/profile, services/auth and lib/supabase are exhaustively mocked: all
 * three construct or reach a Supabase client at module scope.
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';
import { Text } from 'react-native';

// ── Module-level mock state ────────────────────────────────────────────────

const mockGetAccountStatus = jest.fn();
let mockAuthCallback: ((uid: string | null) => void) | null = null;

const TOKEN_UNAVAILABLE = 'token_unavailable';

// NOTE: intentionally exhaustive — services/profile.ts pulls in the API client
// chain at module level, so spreading requireActual would execute it.
jest.mock('../../services/profile.ts', () => ({
  TOKEN_UNAVAILABLE: 'token_unavailable',
  getAccountStatus: (...a: unknown[]) => mockGetAccountStatus(...a),
  reactivateAccount: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: intentionally exhaustive — the real module reaches the Supabase auth
// client at import time.
jest.mock('../../services/auth.ts', () => ({
  getSessionUserId: () => Promise.resolve('user-1'),
  onAuthChange: (cb: (uid: string | null) => void) => {
    mockAuthCallback = cb;
    return () => { mockAuthCallback = null; };
  },
  signOut: jest.fn().mockResolvedValue(undefined),
  ensureProfile: jest.fn().mockResolvedValue(undefined),
}));

// NOTE: intentionally exhaustive — the real module constructs a Supabase client
// at import time.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: { role: null } }) }),
      }),
    }),
  },
}));

// NOTE: intentionally exhaustive — SessionProvider imports these four purely for
// its sign-out / pre-warm side effects, and every one of them reaches the
// Supabase client or the API token chain at module scope. Only the names the
// provider actually calls are needed; requireActual would execute the chain.
jest.mock('../../services/circle.ts', () => ({ pauseOnSessionEnd: jest.fn().mockResolvedValue(undefined) }));
// NOTE: intentionally exhaustive — see the note above.
jest.mock('../../services/savedPostsCache.ts', () => ({ clearForUser: jest.fn(), primeSaved: jest.fn() }));
// NOTE: intentionally exhaustive — see the note above.
jest.mock('../../services/postEngagement.ts', () => ({ fetchMySavedPostIds: jest.fn().mockResolvedValue([]) }));
// NOTE: intentionally exhaustive — see the note above.
jest.mock('../../services/compass.ts', () => ({ clearCachedFeed: jest.fn() }));

import { SessionProvider, useSession } from '../../context/SessionContext.tsx';
import { AccountStatusGate } from '../AccountStatusGate.tsx';

const WALL = "Couldn't verify your account";
const APP = 'the-app-rendered';

async function renderGate() {
  return render(
    <SessionProvider>
      <AccountStatusGate>
        <Text>{APP}</Text>
      </AccountStatusGate>
    </SessionProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthCallback = null;
});

describe('AccountStatusGate — false auth wall (3658)', () => {
  it('POSITIVE CONTROL: a real server verdict it cannot read still raises the wall', async () => {
    // Without this passing, every "no wall" assertion below is vacuous: they
    // would all pass against a gate that had simply stopped blocking.
    mockGetAccountStatus.mockResolvedValue({
      ok: false, data: null, errorKind: 'db_error', message: 'API 500',
    });

    await renderGate();
    expect(await screen.findByText(WALL)).toBeTruthy();
    expect(screen.queryByText(APP)).toBeNull();
  });

  it('POSITIVE CONTROL: a server 401 still fails closed — fail-open must not cover it', async () => {
    // Regression guard on the previous attempt at this fix, which widened the
    // fail-open branch to all of 'unauthenticated' and so would have rendered
    // the app for a genuinely invalid, expired or revoked token. 'unauthenticated'
    // is what api-server's requireUser sends on a 401.
    mockGetAccountStatus.mockResolvedValue({
      ok: false, data: null, errorKind: 'unauthenticated', message: 'Invalid or expired token',
    });

    await renderGate();

    expect(await screen.findByText(WALL)).toBeTruthy();
    expect(screen.queryByText(APP)).toBeNull();
  });

  it('POSITIVE CONTROL: a server verdict of deactivated is still enforced', async () => {
    mockGetAccountStatus.mockResolvedValue({
      ok: true, data: { accountStatus: 'deactivated', deletionScheduledAt: null },
    });

    await renderGate();

    expect(await screen.findByText('Your account is deactivated')).toBeTruthy();
    expect(screen.queryByText(APP)).toBeNull();
  });

  it('a failed token mint (TOKEN_UNAVAILABLE) does NOT raise the wall — nothing was asked', async () => {
    mockGetAccountStatus.mockResolvedValue({
      ok: false, data: null, errorKind: TOKEN_UNAVAILABLE, message: 'Could not obtain a session token',
    });

    await renderGate();

    expect(await screen.findByText(APP)).toBeTruthy();
    expect(screen.queryByText(WALL)).toBeNull();
  });

  it('the failed token mint is a HOLD, not a bypass — the background retry adopts the real verdict', async () => {
    mockGetAccountStatus.mockResolvedValueOnce({
      ok: false, data: null, errorKind: TOKEN_UNAVAILABLE,
    });
    mockGetAccountStatus.mockResolvedValue({
      ok: true, data: { accountStatus: 'deactivated', deletionScheduledAt: null },
    });

    await renderGate();
    expect(await screen.findByText(APP)).toBeTruthy();

    // The scheduled 15s background retry lands the server's real verdict, which
    // is then enforced. Failing open must not become failing forever.
    await waitFor(
      async () => {
        expect(await screen.findByText('Your account is deactivated')).toBeTruthy();
      },
      { timeout: 20_000, interval: 250 },
    );
    expect(mockGetAccountStatus.mock.calls.length).toBeGreaterThan(1);
    expect(screen.queryByText(APP)).toBeNull();
  }, 30_000);

  it('signed out, the context says NOT ASKED — not asked-and-failed', async () => {
    // Cause 2, asserted on the state rather than on the render.
    //
    // (accountStatus === null) is BOTH "we have not asked" and "we asked and
    // could not get an answer"; accountStatusLoaded is the only thing that tells
    // them apart, and the wall is what the second one renders. The signed-out
    // branch used to set it TRUE, which is the second when the truth is the
    // first.
    //
    // Asserted here and not through the gate on purpose: the render-level
    // consequence is a single frame between the userId commit and the effect
    // that clears it, which React coalesces, so a gate-level test of it passes
    // against the unfixed code and proves nothing. This one is red without the
    // fix. Do not "strengthen" it into a screen assertion — that makes it
    // vacuous.
    mockGetAccountStatus.mockResolvedValue({
      ok: true, data: { accountStatus: 'active', deletionScheduledAt: null },
    });

    const seen: Array<{ isAuthed: boolean; loaded: boolean; status: string | null }> = [];
    function Probe() {
      const s = useSession();
      seen.push({ isAuthed: s.isAuthed, loaded: s.accountStatusLoaded, status: s.accountStatus });
      return <Text>{APP}</Text>;
    }

    await render(<SessionProvider><Probe /></SessionProvider>);
    await waitFor(() => expect(seen.some((s) => s.isAuthed && s.loaded)).toBe(true));

    await act(async () => { mockAuthCallback?.(null); });

    const last = seen[seen.length - 1]!;
    expect(last.isAuthed).toBe(false);
    expect(last.status).toBeNull();
    expect(last.loaded).toBe(false); // ← "not asked". Was true before the fix.
  });

  // Companion no-regression check: green with and without the fix, by design.
  it('the session returning after a null auth event settles back to the app, no wall', async () => {
    mockGetAccountStatus.mockResolvedValue({
      ok: true, data: { accountStatus: 'active', deletionScheduledAt: null },
    });

    await renderGate();
    expect(await screen.findByText(APP)).toBeTruthy();

    await act(async () => { mockAuthCallback?.(null); });
    await act(async () => { mockAuthCallback?.('user-1'); });

    expect(await screen.findByText(APP)).toBeTruthy();
    expect(screen.queryByText(WALL)).toBeNull();
  });
});
