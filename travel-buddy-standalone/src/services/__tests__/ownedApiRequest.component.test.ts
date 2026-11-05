// NOTE: SDK transport only; real observer, token checks and HTTP implementation run.
jest.mock('../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; } } } };
});
import { fetchOwnedApi } from '../ownedApiRequest.ts';
import { captureMessagingOwnerRequest } from '../messagingOwnerRequest.ts';
import { _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken, emitObservedAuthEvent, observedOwnerSession } from './observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../discoveryViewerScope.ts';
import { createPlanItem, fetchPlanEditableTrips } from '../../features/trips/planning/tripPlan.ts';
import { createRoutePlan } from '../routePlan.ts';
import { inviteToSharedMoment } from '../sharedMoments.ts';
const realFetch = globalThis.fetch;
const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const token = observedOwnerAccessToken('owner-a', 'session-a');
const tokenReply = () => ({ data: { session: { access_token: token, expires_at: Math.floor(Date.now() / 1000) + 3600 } } });
function sdk(getSession: () => Promise<unknown> = async () => tokenReply()) { _setTestSupabase({ auth: { getSession } } as any); }
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
const fetchMock = jest.fn();
beforeEach(() => {
  setDiscoveryViewerFromSession('owner-a'); seedObservedOwnerSession('owner-a', 'session-a'); sdk();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }); globalThis.fetch = fetchMock;
});
afterEach(() => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); _resetTestSupabase(); jest.useRealTimers(); globalThis.fetch = realFetch; if (realBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = realBase; });

for (const name of ['account', 'session'] as const) {
  it(`refuses token acquisition that crosses a ${name} change`, async () => {
    const pending = deferred<unknown>(); sdk(() => pending.promise);
    const result = fetchOwnedApi('/api/route-plans', { method: 'POST', body: {} }).catch(() => null);
    emitObservedAuthEvent('SIGNED_IN', observedOwnerSession(name === 'account' ? 'owner-b' : 'owner-a', 'session-b'));
    pending.resolve(tokenReply());
    expect(await result).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
  });
}
it('rejects response decoding after session replacement', async () => {
  const pending = deferred<unknown>(); fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => pending.promise });
  const response = await fetchOwnedApi('/api/test'); const result = response.json().catch(() => null);
  emitObservedAuthEvent('SIGNED_IN', observedOwnerSession('owner-a', 'other-session')); pending.resolve({ secret: true });
  expect(await result).toBeNull();
});
for (const phase of ['token', 'headers', 'body'] as const) {
  it(`bounds a stalled ${phase} to the same ten-second request deadline`, async () => {
    jest.useFakeTimers();
    if (phase === 'token') sdk(() => new Promise(() => {}));
    if (phase === 'headers') fetchMock.mockImplementation(() => new Promise(() => {}));
    if (phase === 'body') fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
    const result = fetchOwnedApi('/api/test').then(response => response.json()).catch(() => null);
    await jest.advanceTimersByTimeAsync(10001);
    expect(await result).toBeNull();
    if (phase !== 'token') expect(fetchMock.mock.lastCall[1].signal.aborted).toBe(true);
  });
}
it('cancels even when the fetch implementation ignores AbortSignal', async () => {
  fetchMock.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController(); const result = fetchOwnedApi('/api/test', { signal: controller.signal }).catch(() => null);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  controller.abort(); expect(await result).toBeNull();
});
it('pins credentials to the configured HTTPS origin and refuses redirects', async () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  await expect(fetchOwnedApi('/api/test')).rejects.toThrow(); expect(fetchMock).not.toHaveBeenCalled();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  fetchMock.mockResolvedValue({ ok: true, status: 200, redirected: true, url: 'https://other.test/api/test' });
  await expect(fetchOwnedApi('/api/test')).rejects.toThrow('redirected');
  expect(fetchMock.mock.lastCall[1]).toMatchObject({ redirect: 'error', credentials: 'omit', headers: { Authorization: `Bearer ${token}` } });
});
it('refuses a retired panel before dispatch', async () => {
  await expect(fetchOwnedApi('/api/test', { isCurrent: () => false })).rejects.toThrow(); expect(fetchMock).not.toHaveBeenCalled();
});
it('carries the initiating owner across every Media-to-Trip and invitation executor', async () => {
  const owner = captureMessagingOwnerRequest()!;
  emitObservedAuthEvent('SIGNED_IN', observedOwnerSession('owner-b', 'session-b'));
  await expect(fetchPlanEditableTrips({ owner })).rejects.toThrow();
  await expect(createPlanItem('trip-a', { title: 'Stop' }, { owner })).rejects.toThrow();
  await expect(createRoutePlan({ title: 'Route', routeStyle: 'custom', stops: [] }, { owner })).rejects.toThrow();
  expect(await inviteToSharedMoment('moment-a', 'person-a', null, { owner })).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('treats malformed plan acceptance as unconfirmed rather than successful', async () => {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  await expect(createPlanItem('trip-a', { title: 'Stop' })).rejects.toThrow('confirm');
});
