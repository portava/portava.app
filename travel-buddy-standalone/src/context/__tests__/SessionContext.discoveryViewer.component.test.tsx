/**
 * SessionProvider — every auth event moves the Discovery viewer scope, BEFORE
 * any screen re-renders. census-discovery §50.
 *
 * WHY THIS IS THE LOAD-BEARING HALF
 * =================================
 * `ForYouTab` and `DiscoveryCategoryTab` seed their first render SYNCHRONOUSLY
 * from `getCachedDiscoveryPlaces`, and `useCommunityDiscovery` does the same
 * from its module cache. A synchronous read at mount runs before any request
 * could say who is asking, so the only thing that can stop it painting the
 * previous account's page is the auth layer telling the viewer scope first.
 * These tests pin that it does — on the initial session, on every auth event
 * (sign-in, account switch, sign-out, expiry), and on an explicit sign-out —
 * and that the caches are cleared INSIDE the auth callback, not in an effect
 * that runs after the screens have already rendered.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';
import { Text } from 'react-native';

let mockAuthCallback: ((uid: string | null) => void) | null = null;

// NOTE: intentionally exhaustive — services/profile.ts pulls in the API client
// chain at module level, so spreading requireActual would execute it.
jest.mock('../../services/profile.ts', () => ({
  TOKEN_UNAVAILABLE: 'token_unavailable',
  getAccountStatus: jest.fn().mockResolvedValue({ ok: true, status: { status: 'active' } }),
  reactivateAccount: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: intentionally exhaustive — the real module reaches the Supabase auth
// client at import time.
jest.mock('../../services/auth.ts', () => ({
  getSessionUserId: () => Promise.resolve('user-x'),
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
// Supabase client or the API token chain at module scope.
jest.mock('../../services/circle.ts', () => ({ pauseOnSessionEnd: jest.fn().mockResolvedValue(undefined) }));
// NOTE: intentionally exhaustive — see the note above.
jest.mock('../../services/savedPostsCache.ts', () => ({ clearForUser: jest.fn(), primeSaved: jest.fn() }));
// NOTE: intentionally exhaustive — see the note above.
jest.mock('../../services/postEngagement.ts', () => ({ fetchMySavedPostIds: jest.fn().mockResolvedValue([]) }));
// NOTE: intentionally exhaustive — see the note above.
jest.mock('../../services/compass.ts', () => ({ clearCachedFeed: jest.fn().mockResolvedValue(undefined) }));

import { SessionProvider, useSession } from '../SessionContext.tsx';
import {
  currentDiscoveryScope,
  onDiscoveryScopeChange,
  _resetDiscoveryViewerScopeForTests,
} from '../../services/discoveryViewerScope.ts';

let signOutFromUi: (() => Promise<void>) | null = null;
function Probe() {
  const { userId, signOut } = useSession();
  signOutFromUi = signOut;
  return <Text>{userId ?? 'signed-out'}</Text>;
}

beforeEach(() => {
  mockAuthCallback = null;
  signOutFromUi = null;
  _resetDiscoveryViewerScopeForTests();
});

async function mountProvider() {
  const utils = await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(utils.getByText('user-x')).toBeTruthy());
  return utils;
}

describe('SessionProvider → Discovery viewer scope', () => {
  it('the initial session names the viewer', async () => {
    await mountProvider();
    expect(currentDiscoveryScope().viewer).toBe('u:user-x');
  });

  it('an account switch moves the scope and clears the caches INSIDE the auth callback', async () => {
    await mountProvider();
    const cleared = jest.fn();
    const off = onDiscoveryScopeChange(cleared);

    // Read INSIDE the same synchronous turn as the callback, before React has
    // processed the state update it queued: if the scope moved only in an
    // effect, these would still read user-x and zero.
    let viewerInCallback: string | undefined;
    let clearsInCallback = -1;
    await act(async () => {
      mockAuthCallback!('user-y');
      viewerInCallback = currentDiscoveryScope().viewer;
      clearsInCallback = cleared.mock.calls.length;
    });
    expect(viewerInCallback).toBe('u:user-y');
    expect(clearsInCallback).toBe(1);
    off();
  });

  it('an auth event that says "signed out" (expiry, revocation) moves the scope to anonymous', async () => {
    await mountProvider();
    await act(async () => { mockAuthCallback!(null); });
    expect(currentDiscoveryScope().viewer).toBe('anon');
  });

  it('CONTROL: a token refresh for the SAME user does not move the scope or clear anything', async () => {
    await mountProvider();
    const cleared = jest.fn();
    const off = onDiscoveryScopeChange(cleared);
    await act(async () => { mockAuthCallback!('user-x'); });
    expect(cleared).not.toHaveBeenCalled();
    off();
  });

  it('the explicit sign-out clears the Discovery caches before the session is torn down', async () => {
    await mountProvider();
    const cleared = jest.fn();
    const off = onDiscoveryScopeChange(cleared);
    await act(async () => { await signOutFromUi!(); });
    expect(currentDiscoveryScope().viewer).toBe('anon');
    expect(cleared).toHaveBeenCalled();
    off();
  });
});
