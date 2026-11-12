import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken, observedOwnerSession, emitObservedAuthEvent } from '../../../services/__tests__/observedOwnerSessionFixture.ts';
import { freshToken } from '../../../services/apiToken.ts';
import { fetchMediaActions, fetchExperiencePlan, fetchCompiledExperiencePlan, postMediaIntent, deleteMediaIntent, linkMediaToEvent, _setTestOwnerTokenProvider } from '../services/mediaActions.ts';
import { messagingOwnerToken } from '../../../services/messagingOwnerRequest.ts';
import { saveMedia, unsaveMedia, recordMediaShare, reportMedia, updateMediaVisibility, deleteMedia, hideMedia, recordMediaSignal } from '../../../services/mediaInteractions.ts';

jest.mock('../../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => {
    listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
  } } } };
});
jest.mock('../../../services/apiToken.ts', () => ({ ...jest.requireActual('../../../services/apiToken.ts'), freshToken: jest.fn() }));
const token = observedOwnerAccessToken('owner-a', 'session-a');
const savedBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const response = (overrides: Partial<Response> = {}): Response => ({ ok: true, status: 200, url: '', redirected: false,
  json: async () => ({ mediaId: 'media-a', actions: [], entityRefs: [] }), ...overrides } as Response);
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  setDiscoveryViewerFromSession('owner-a'); seedObservedOwnerSession('owner-a', 'session-a');
  _setTestOwnerTokenProvider(messagingOwnerToken);
  jest.mocked(freshToken).mockResolvedValue(token);
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(response());
});
afterEach(() => {
  disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null);
  _setTestOwnerTokenProvider(null);
  jest.restoreAllMocks(); jest.resetAllMocks(); jest.useRealTimers();
  if (savedBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = savedBase;
});
const requests = [() => fetchMediaActions('media-a'), () => fetchExperiencePlan('experience-a'),
  () => fetchCompiledExperiencePlan('experience-a', { source: 'experience' }), () => postMediaIntent('media-a'),
  () => deleteMediaIntent('media-a'), () => linkMediaToEvent('media-a', 'event-a')];

it('uses the observed owner and a pinned secure endpoint for every action transport', async () => {
  for (const request of requests) expect((await request()).ok).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(6);
  for (const [url, init] of jest.mocked(fetch).mock.calls) {
    expect(String(url)).toMatch(/^https:\/\/api.test\/api\/media\//);
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
  }
});

for (const replacement of ['different account', 'same account new session', 'logout and login']) {
  it(`cannot dispatch after token refresh crosses ${replacement}`, async () => {
    let finish!: (value: string) => void;
    jest.mocked(freshToken).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = requests.map(request => request());
    for (let i = 0; i < 30 && jest.mocked(freshToken).mock.calls.length < 6; i++) await Promise.resolve();
    expect(freshToken).toHaveBeenCalledTimes(6);
    const owner = replacement === 'different account' ? 'owner-b' : 'owner-a';
    if (replacement === 'logout and login') emitObservedAuthEvent('SIGNED_OUT', null);
    setDiscoveryViewerFromSession(owner);
    const session = replacement === 'logout and login' ? 'session-a' : 'session-b';
    emitObservedAuthEvent('SIGNED_IN', observedOwnerSession(owner, session));
    finish(observedOwnerAccessToken(owner, session));
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ ok: false, errorKind: 'auth' });
    expect(fetch).not.toHaveBeenCalled();
  });
}

it('rejects decoded data after the owner signs out', async () => {
  jest.mocked(fetch).mockResolvedValue(response({ json: async () => { emitObservedAuthEvent('SIGNED_OUT', null); return {}; } }));
  expect(await fetchMediaActions('media-a')).toMatchObject({ ok: false, errorKind: 'auth' });
});

for (const stage of ['token', 'headers', 'body']) {
  it(`bounds an unresponsive ${stage} without leaving the UI pending`, async () => {
    jest.useFakeTimers();
    if (stage === 'token') jest.mocked(freshToken).mockReturnValue(new Promise(() => {}));
    else if (stage === 'headers') jest.mocked(fetch).mockReturnValue(new Promise(() => {}));
    else jest.mocked(fetch).mockResolvedValue(response({ json: () => new Promise(() => {}) }));
    const pending = fetchMediaActions('media-a');
    await jest.advanceTimersByTimeAsync(10_001);
    expect(await pending).toMatchObject({ ok: false, errorKind: 'network' });
    if (stage !== 'token') expect(jest.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    else expect(fetch).not.toHaveBeenCalled();
  });
}

it('honors cancellation before refresh and while receiving a response', async () => {
  const before = new AbortController(); before.abort();
  expect((await postMediaIntent('media-a', 'want_to_go', { signal: before.signal })).ok).toBe(false);
  expect(freshToken).not.toHaveBeenCalled();
  jest.mocked(fetch).mockReturnValue(new Promise(() => {}));
  const running = new AbortController();
  const pending = deleteMediaIntent('media-a', { signal: running.signal });
  running.abort(); expect((await pending).ok).toBe(false);
});

it('refuses unsafe API origins and redirected bearer requests', async () => {
  for (const base of ['http://api.test', 'https://user:pass@api.test', 'https://api.test/nested', 'https://api.test?redirect=1']) {
    process.env.EXPO_PUBLIC_API_BASE_URL = base;
    expect((await postMediaIntent('media-a')).ok).toBe(false);
  }
  expect(fetch).not.toHaveBeenCalled(); expect(freshToken).not.toHaveBeenCalled();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  jest.mocked(fetch).mockResolvedValue(response({ redirected: true, url: 'https://foreign.test' }));
  expect((await linkMediaToEvent('media-a', 'event-a')).ok).toBe(false);
});

const interactions = [() => saveMedia('media-a'), () => unsaveMedia('media-a'), () => recordMediaShare('media-a', 'native'),
  () => reportMedia('media-a', 'spam'), () => updateMediaVisibility('media-a', 'private'), () => deleteMedia('media-a'),
  () => hideMedia('media-a'), () => recordMediaSignal('save', { mediaId: 'media-a' })];
it('uses the same authenticated transport for all eight media interaction methods', async () => {
  for (const run of interactions) expect((await run()).ok).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(interactions.length);
  expect(jest.mocked(fetch).mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'DELETE', 'POST', 'POST', 'PATCH', 'DELETE', 'POST', 'POST']);
  for (const [, init] of jest.mocked(fetch).mock.calls) expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: `Bearer ${token}` } });
});
for (const replacement of ['different account', 'same account new session', 'logout and login']) {
  it(`does not send any interaction when refresh crosses ${replacement}`, async () => {
    let finish!: (value: string) => void;
    jest.mocked(freshToken).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = interactions.map(run => run());
    const owner = replacement === 'different account' ? 'owner-b' : 'owner-a';
    if (replacement === 'logout and login') emitObservedAuthEvent('SIGNED_OUT', null);
    setDiscoveryViewerFromSession(owner);
    const session = replacement === 'logout and login' ? 'session-a' : 'session-b';
    emitObservedAuthEvent('SIGNED_IN', observedOwnerSession(owner, session));
    finish(observedOwnerAccessToken(owner, session));
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ ok: false, errorKind: 'unauthenticated' });
    expect(fetch).not.toHaveBeenCalled();
  });
}
for (const stage of ['token', 'headers', 'body']) {
  it(`bounds every interaction's ${stage}`, async () => {
    jest.useFakeTimers();
    if (stage === 'token') jest.mocked(freshToken).mockReturnValue(new Promise(() => {}));
    else if (stage === 'headers') jest.mocked(fetch).mockReturnValue(new Promise(() => {}));
    else jest.mocked(fetch).mockResolvedValue(response({ json: () => new Promise(() => {}) }));
    const pending = interactions.map(run => run());
    await jest.advanceTimersByTimeAsync(10_001);
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ ok: false, errorKind: 'network' });
  });
}
it('does not report success on an HTTP refusal, malformed body or late owner response', async () => {
  jest.mocked(fetch).mockResolvedValueOnce(response({ ok: false, status: 403, json: async () => ({ error: 'not_allowed', message: 'Not allowed' }) }))
    .mockResolvedValueOnce(response({ json: async () => null }))
    .mockResolvedValueOnce(response({ json: async () => { emitObservedAuthEvent('SIGNED_OUT', null); return {}; } }));
  expect(await reportMedia('media-a', 'spam')).toMatchObject({ ok: false, errorKind: 'not_allowed' });
  expect(await deleteMedia('media-a')).toMatchObject({ ok: false, errorKind: 'server' });
  expect(await saveMedia('media-a')).toMatchObject({ ok: false, errorKind: 'unauthenticated' });
});
