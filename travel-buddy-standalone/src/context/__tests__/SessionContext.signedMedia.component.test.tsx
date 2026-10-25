/**
 * SessionProvider — signed media URLs are per account (2026-10-25, PR #808 verifier, verdict-808b finding 1).
 *
 * lib/batchSignMedia.ts caches a signed URL for up to 55 minutes, keyed by URL and transform only. Nothing cleared
 * it on sign-out, so a second account signing in on the same device could be served the first account's signed URL
 * for a ref it rendered too. The auth listener that already clears the Telegraph cursors and the Discovery caches
 * on an account change now clears it too — inside the callback, before any screen re-renders — and the explicit
 * sign-out clears it as well.
 *
 *   SM1  an account switch empties the signed-URL cache INSIDE the auth callback; the next ask goes to the server
 *   SM2  an auth event that says "signed out" empties it
 *   SM3  the explicit sign-out empties it
 *   SM4  CONTROL: a token refresh for the SAME user keeps it
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
import { batchSignUrls, _getCacheSize, _resetBatchSignCache, _setTestSignTokenProvider } from '../../lib/batchSignMedia.ts';

const REF = 'post-media/owner-1/clip.mov';
let signCalls = 0;
const realFetch = global.fetch;

let signOutFromUi: (() => Promise<void>) | null = null;
function Probe() {
  const { userId, signOut } = useSession();
  signOutFromUi = signOut;
  return <Text>{userId ?? 'signed-out'}</Text>;
}

beforeEach(() => {
  mockAuthCallback = null;
  signOutFromUi = null;
  signCalls = 0;
  _resetBatchSignCache();
  _setTestSignTokenProvider(async () => 'token-of-user-x');
  global.fetch = (async (url: string, opts?: any) => {
    if (!String(url).includes('/api/media/sign')) throw new Error(`unexpected fetch ${url}`);
    signCalls++;
    const body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ signed: Object.fromEntries(body.urls.map((u: string) => [u, `https://signed.example/${u}?n=${signCalls}`])), ttlSeconds: 3600 }) };
  }) as unknown as typeof fetch;
});
afterAll(() => { global.fetch = realFetch; _setTestSignTokenProvider(null); _resetBatchSignCache(); });

async function mountSignedIn() {
  const utils = await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(utils.getByText('user-x')).toBeTruthy());
  const first = await batchSignUrls([REF]);
  expect(first.get(REF)).toBe(`https://signed.example/${REF}?n=1`);
  expect(_getCacheSize()).toBe(1);
  return utils;
}

describe('SessionProvider → signed media URLs are per account', () => {
  it('SM1 an account switch empties the signed-URL cache inside the auth callback; the next ask goes to the server', async () => {
    await mountSignedIn();
    let sizeInCallback = -1;
    await act(async () => {
      mockAuthCallback!('user-y');
      sizeInCallback = _getCacheSize();
    });
    expect(sizeInCallback).toBe(0);
    _setTestSignTokenProvider(async () => 'token-of-user-y');
    const forY = await batchSignUrls([REF]);
    expect(signCalls).toBe(2);
    expect(forY.get(REF)).toBe(`https://signed.example/${REF}?n=2`);
  });

  it('SM2 an auth event that says "signed out" empties it', async () => {
    await mountSignedIn();
    await act(async () => { mockAuthCallback!(null); });
    expect(_getCacheSize()).toBe(0);
  });

  it('SM3 the explicit sign-out empties it', async () => {
    await mountSignedIn();
    await act(async () => { await signOutFromUi!(); });
    expect(_getCacheSize()).toBe(0);
  });

  it('SM4 CONTROL: a token refresh for the SAME user keeps it', async () => {
    await mountSignedIn();
    await act(async () => { mockAuthCallback!('user-x'); });
    expect(_getCacheSize()).toBe(1);
    await batchSignUrls([REF]);
    expect(signCalls).toBe(1);
  });
});
