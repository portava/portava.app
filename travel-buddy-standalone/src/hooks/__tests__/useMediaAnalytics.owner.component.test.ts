// NOTE: SDK transport and feature flag boundary only; real owner observer,
// token acquisition, request deadline, hook queue and HTTP sender run.
jest.mock('../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; } } } };
});
const mockFlags = { enabled: true };
// NOTE: exhaustive flag boundary; this suite drives the single analytics gate directly.
jest.mock('../../context/FeatureFlagsContext.tsx', () => ({ useFeatureFlags: () => ({ isEnabled: () => mockFlags.enabled }) }));
import { renderHook, act } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useMediaAnalytics } from '../useMediaAnalytics.ts';
import { _setTestSupabase, _resetTestSupabase } from '../../services/apiToken.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken, emitObservedAuthEvent, observedOwnerSession } from '../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';

const originalFetch = globalThis.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const fetchMock = jest.fn();
let ownerId = 'owner-a';
let sessionId = 'session-a';
let onAppState: ((state: AppStateStatus) => void) | undefined;
const sessionReply = () => ({ data: { session: { access_token: observedOwnerAccessToken(ownerId, sessionId), expires_at: Math.floor(Date.now() / 1000) + 3600 } } });
function sdk(getSession: () => Promise<unknown> = async () => sessionReply()) { _setTestSupabase({ auth: { getSession } } as any); }
function changeOwner(id: string, session = 'session-b') {
  ownerId = id; sessionId = session;
  setDiscoveryViewerFromSession(id);
  emitObservedAuthEvent('SIGNED_IN', observedOwnerSession(id, session));
  sdk();
}
async function settle() { await act(async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); }); }
function bodies() { return fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body)); }
beforeEach(() => {
  jest.useFakeTimers(); mockFlags.enabled = true; ownerId = 'owner-a'; sessionId = 'session-a';
  setDiscoveryViewerFromSession(ownerId); seedObservedOwnerSession(ownerId, sessionId); sdk();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: true, status: 200 }); globalThis.fetch = fetchMock;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, listener: (state: AppStateStatus) => void) => { onAppState = listener; return { remove: () => { onAppState = undefined; } }; }) as typeof AppState.addEventListener);
});
afterEach(() => {
  disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); _resetTestSupabase();
  jest.restoreAllMocks(); jest.useRealTimers(); globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

it('does not send an old account queue using the next account token', async () => {
  const h = await renderHook(() => useMediaAnalytics('feed-a'));
  await act(async () => h.result.current.record('place_open', { media_id: 'old-media' }));
  changeOwner('owner-b');
  await act(async () => { await jest.advanceTimersByTimeAsync(2001); });
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => h.result.current.record('place_open', { media_id: 'new-media' }));
  await act(async () => { await h.result.current.flush(); });
  expect(bodies()[0].events.map((e: any) => e.payload.media_id)).toEqual(['new-media']);
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${observedOwnerAccessToken('owner-b', 'session-b')}`);
});

it('drops events across logout/login to the same account', async () => {
  const h = await renderHook(() => useMediaAnalytics());
  await act(async () => h.result.current.record('place_open', { media_id: 'old-session' }));
  emitObservedAuthEvent('SIGNED_OUT', null); changeOwner('owner-a', 'replacement-session');
  await act(async () => { await h.result.current.flush(); });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('does not dispatch when the owner changes during token acquisition', async () => {
  let resolve!: (value: unknown) => void;
  sdk(() => new Promise(done => { resolve = done; }));
  const h = await renderHook(() => useMediaAnalytics());
  await act(async () => h.result.current.record('place_open', { media_id: 'm1' }));
  let pending!: Promise<void>; await act(async () => { pending = h.result.current.flush(); });
  changeOwner('owner-b'); resolve(sessionReply());
  await act(async () => { await pending; });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('disabled collection sends nothing and a mid-flight disable aborts the request', async () => {
  mockFlags.enabled = false;
  const h = await renderHook(() => useMediaAnalytics());
  await act(async () => h.result.current.record('place_open', { media_id: 'disabled' }));
  await act(async () => { await h.result.current.flush(); });
  expect(fetchMock).not.toHaveBeenCalled();
  mockFlags.enabled = true; await h.rerender({});
  fetchMock.mockImplementation(() => new Promise(() => {}));
  await act(async () => h.result.current.record('place_open', { media_id: 'queued' }));
  let pending!: Promise<void>; await act(async () => { pending = h.result.current.flush(); }); await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  mockFlags.enabled = false; await h.rerender({});
  await act(async () => { await pending; });
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  mockFlags.enabled = true; await h.rerender({});
  await act(async () => { await jest.advanceTimersByTimeAsync(2001); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('flushes on background, has no idle polling, and bounds stalled transport concurrency', async () => {
  const h = await renderHook(() => useMediaAnalytics());
  await act(async () => h.result.current.record('place_open', { media_id: 'm1' }));
  await act(async () => onAppState!('background')); await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { await jest.advanceTimersByTimeAsync(60000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockImplementation(() => new Promise(() => {}));
  await act(async () => { for (let i = 0; i < 1000; i++) h.result.current.record('place_open', { media_id: `m${i}` }); });
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(bodies()[1].events).toHaveLength(10);
  await act(async () => { await jest.advanceTimersByTimeAsync(10001); });
  expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
});

it('ignores stale callbacks after unmount and resets dedup across account changes', async () => {
  const h = await renderHook(() => useMediaAnalytics());
  await act(async () => h.result.current.record('impression', { media_id: 'shared' }));
  changeOwner('owner-b');
  await act(async () => h.result.current.record('impression', { media_id: 'shared' }));
  await act(async () => { await h.result.current.flush(); });
  expect(bodies()[0].events).toHaveLength(1);
  const record = h.result.current.record; await h.unmount();
  record('place_open', { media_id: 'after-unmount' });
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('rejects unknown/private fields, raw error text and invalid values before transmission', async () => {
  const h = await renderHook(() => useMediaAnalytics());
  for (const payload of [
    { media_id: 'm1', caption: 'private draft' }, { viewer_id: 'someone' },
    { failure_reason: 'message contains private notes' }, { media_id: 'x'.repeat(129) },
    { place_id: { lat: 12.3 } }, { watched_ms: -1 }, { completion_fraction: 1.5 },
  ]) await act(async () => h.result.current.record('place_open', payload as any));
  await act(async () => { await h.result.current.flush(); });
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => h.result.current.record('playback_failure', { media_id: 'm1', failure_code: 'network_unavailable' }));
  await act(async () => { await h.result.current.flush(); });
  expect(bodies()[0].events[0].payload).toEqual({ media_id: 'm1', failure_code: 'network_unavailable' });
});
