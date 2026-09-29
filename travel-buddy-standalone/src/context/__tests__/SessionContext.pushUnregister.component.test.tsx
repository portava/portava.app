/**
 * SessionProvider.signOut unregisters this device's push token BEFORE the
 * session is torn down — TM-social, PLAT-F20.
 *
 * DELETE /me/devices/:id is authorised by the OUTGOING user's bearer token, so
 * it must run before services/auth.signOut clears the session; after it, the
 * request could not be authorised and the row (and the previous account's
 * pushes to this device) would survive. It is also best-effort: a failed
 * unregister must never stop the sign-out.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';
import { Text } from 'react-native';

const mockOrder: string[] = [];

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
  onAuthChange: () => () => {},
  signOut: jest.fn(async () => { mockOrder.push('auth.signOut'); }),
  ensureProfile: jest.fn().mockResolvedValue(undefined),
}));
// NOTE: intentionally exhaustive — the real module constructs a Supabase client
// at import time.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { role: null } }) }) }) }),
  },
}));
// NOTE: intentionally exhaustive — sign-out side-effect modules that reach the
// Supabase client or the API token chain at module scope.
jest.mock('../../services/circle.ts', () => ({ pauseOnSessionEnd: jest.fn().mockResolvedValue(undefined) }));
// NOTE: intentionally exhaustive — see the note above.
jest.mock('../../services/savedPostsCache.ts', () => ({ clearForUser: jest.fn(), primeSaved: jest.fn() }));
// NOTE: intentionally exhaustive — see the note above.
jest.mock('../../services/postEngagement.ts', () => ({ fetchMySavedPostIds: jest.fn().mockResolvedValue([]) }));
// NOTE: intentionally exhaustive — see the note above.
jest.mock('../../services/compass.ts', () => ({ clearCachedFeed: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/pushTokenService.ts', () => ({
  ...jest.requireActual('../../services/pushTokenService.ts'),
  unregisterPushDeviceOnSignOut: jest.fn(async () => { mockOrder.push('unregister'); return 'removed'; }),
}));

import { SessionProvider, useSession } from '../SessionContext.tsx';
import { unregisterPushDeviceOnSignOut } from '../../services/pushTokenService.ts';

let signOutFromUi: (() => Promise<void>) | null = null;
function Probe() {
  const { userId, signOut } = useSession();
  signOutFromUi = signOut;
  return <Text>{userId ?? 'signed-out'}</Text>;
}

async function mountProvider() {
  const utils = await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(utils.getByText('user-x')).toBeTruthy());
  return utils;
}

jest.setTimeout(20000);

describe('SessionProvider.signOut → push device unregistration', () => {
  beforeEach(() => { mockOrder.length = 0; jest.clearAllMocks(); });

  it('unregisters the device before the auth session is torn down', async () => {
    const utils = await mountProvider();
    await act(async () => { await signOutFromUi!(); });
    expect(unregisterPushDeviceOnSignOut).toHaveBeenCalledTimes(1);
    expect(mockOrder).toEqual(['unregister', 'auth.signOut']);
    await waitFor(() => expect(utils.getByText('signed-out')).toBeTruthy());
  });

  it('a failed unregister never blocks sign-out', async () => {
    (unregisterPushDeviceOnSignOut as jest.Mock).mockImplementationOnce(async () => { mockOrder.push('unregister'); throw new Error('offline'); });
    const utils = await mountProvider();
    await act(async () => { await signOutFromUi!(); });
    expect(mockOrder).toEqual(['unregister', 'auth.signOut']);
    await waitFor(() => expect(utils.getByText('signed-out')).toBeTruthy());
  });
});
