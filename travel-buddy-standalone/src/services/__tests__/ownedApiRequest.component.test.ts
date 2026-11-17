// NOTE: SDK transport only; real observer, token checks and HTTP implementation run.
jest.mock('../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; } } } };
});
import { addComment, editComment, deleteComment, likeComment } from '../postEngagement.ts';
import { readLiveComments, readLiveReplies } from '../commentActivity.ts';
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

for (const write of [
  () => addComment('post', 'private draft'), () => editComment('post', 'comment', 'edited draft'),
  () => deleteComment('post', 'comment'), () => likeComment('post', 'comment'),
]) {
  it('refuses a comment mutation if token acquisition crosses to another account', async () => {
    const pending = deferred<unknown>(); sdk(() => pending.promise);
    const result = write();
    emitObservedAuthEvent('SIGNED_IN', observedOwnerSession('owner-b', 'session-b'));
    pending.resolve(tokenReply());
    expect(await result).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
  });
}
it('preserves comments-disabled refusal and accepted write contracts', async () => {
  fetchMock.mockResolvedValueOnce({ok: false, status: 403, json: async () => ({error: 'comments_disabled', message: 'Disabled'})});
  expect(await addComment('post', 'draft')).toEqual({error: 'comments_disabled'});
  const comment = {id: 'comment', body: 'accepted'};
  fetchMock.mockResolvedValueOnce({ok: true, status: 200, json: async () => ({ok: true, comment, commentCount: 2})});
  expect(await addComment('post', 'accepted')).toMatchObject({comment, commentCount: 2});
  expect(JSON.parse(fetchMock.mock.lastCall[1].body)).toEqual({body: 'accepted'});
});
const commentRow = {id: 'comment', body: 'readable', createdAt: '2026-11-12T00:00:00Z', updatedAt: null,
  author: {id: 'owner-a', handle: '@owner', name: 'Owner', avatarUrl: null}, canDelete: true};
for (const target of ['comments', 'replies'] as const) {
  const read = () => target === 'comments' ? readLiveComments('post', {}) : readLiveReplies('post', 'comment', {});
  it(`decodes checked ${target} and keeps empty success distinct from malformed/network/refused reads`, async () => {
    for (const rows of [[commentRow], []]) {
      fetchMock.mockResolvedValueOnce({ok: true, status: 200, json: async () => ({ok: true, [target]: rows})});
      expect(await read()).toEqual({ok: true, [target]: rows});
    }
    fetchMock.mockResolvedValueOnce({ok: true, status: 200, json: async () => ({ok: true, [target]: [{...commentRow, author: {...commentRow.author, name: null, handle: null}}]})});
    expect(await read()).toEqual({ok: true, [target]: [{...commentRow, author: {...commentRow.author, name: '', handle: ''}}]});
    for (const data of [{}, {[target]: [{id: 'bad'}]}, {ok: false, [target]: []}]) {
      fetchMock.mockResolvedValueOnce({ok: true, status: 200, json: async () => data});
      expect(await read()).toEqual({ok: false, denied: false});
    }
    fetchMock.mockRejectedValueOnce(new Error('network failed'));
    expect(await read()).toEqual({ok: false, denied: false});
    for (const status of [401, 403, 404, 410, 500]) {
      fetchMock.mockResolvedValueOnce({ok: false, status, json: async () => ({})});
      expect(await read()).toEqual({ok: false, denied: status !== 500});
    }
  });
  it(`refuses ${target} decoded after its post panel closes`, async () => {
    let active = true; const body = deferred<unknown>();
    fetchMock.mockResolvedValueOnce({ok: true, status: 200, json: () => body.promise});
    const pending = target === 'comments' ? readLiveComments('post', {isCurrent: () => active}) : readLiveReplies('post', 'comment', {isCurrent: () => active});
    for (let i = 0; i < 20; i++) await Promise.resolve();
    active = false; body.resolve({ok: true, [target]: [commentRow]});
    expect(await pending).toEqual({ok: false, denied: false});
  });
}

it.each(['/api/users/me/saved-places', '/api/posts/post/share-preview', '/api/post-references/ref', '/api/posts/post/destinations'])(
  'accepts the native transport final URL for %s without reparsing it', async path => {
    const originalURL = globalThis.URL;
    // Use the shipped native implementation, not Node's WHATWG URL. It appends
    // a slash when parsing response.url as an absolute URL without a query.
    globalThis.URL = require('react-native/Libraries/Blob/URL').URL;
    try {
      fetchMock.mockImplementation(async (url: string) => ({ ok: true, status: 200, url, json: async () => ({ ok: true }) }));
      const response = await fetchOwnedApi(path);
      expect(await response.json()).toEqual({ ok: true });
      expect(fetchMock.mock.lastCall[0]).toBe(`https://api.test${path}`);
      fetchMock.mockResolvedValue({ ok: true, status: 200, url: `https://other.test${path}` });
      await expect(fetchOwnedApi(path)).rejects.toThrow('redirected');
    } finally { globalThis.URL = originalURL; }
  },
);
