import { searchUsers } from '../follows.ts';
import { _resetDiscoveryViewerScopeForTests, currentDiscoveryScope, invalidateDiscoveryCaches, setDiscoveryViewerFromSession } from '../discoveryViewerScope.ts';

const mockToken = jest.fn();
jest.mock('../apiToken.ts', () => { return { freshToken: () => mockToken() }; });
jest.mock('../../lib/supabase.ts', () => { return { isSupabaseConfigured: true, supabase: {} }; });

const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const mockFetch = jest.fn();
const person = { id: 'synthetic-person', isPrivate: true, friendRequestPending: true };
function token(owner = 'owner-A') {
  return `e30.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.synthetic`;
}
function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}
function request() {
  const controller = new AbortController();
  return { signal: controller.signal, isCurrent: jest.fn(() => true), scope: currentDiscoveryScope(), controller };
}

beforeEach(() => {
  _resetDiscoveryViewerScopeForTests();
  setDiscoveryViewerFromSession('owner-A');
  mockToken.mockReset().mockResolvedValue(token());
  mockFetch.mockReset().mockResolvedValue(response({ users: [person] }));
  global.fetch = mockFetch;
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
});
afterEach(() => {
  global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

it('preserves legacy two-argument callers and their request shape', async () => {
  mockToken.mockResolvedValue('legacy-synthetic-token');
  expect(await searchUsers(' private query ', 10)).toEqual({ ok: true, data: [person] });
  expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:9/api/users/search?q=private%20query&limit=10', {
    headers: { Authorization: 'Bearer legacy-synthetic-token' },
  });
});

it('passes current scoped results and the abort signal without changing eligibility', async () => {
  const current = request();
  expect(await searchUsers('alice', 10, current)).toEqual({ ok: true, data: [person] });
  expect(mockFetch.mock.calls[0][1].signal).toBe(current.signal);
});

it.each(['account', 'relogin', 'epoch', 'query', 'abort'] as const)('does not dispatch after %s changes during token acquisition', async change => {
  const pending = deferred<string>();
  const current = request();
  mockToken.mockReturnValue(pending.promise);
  const result = searchUsers('private-query-from-A', 10, current);
  if (change === 'account') setDiscoveryViewerFromSession('owner-B');
  if (change === 'relogin') { setDiscoveryViewerFromSession(null); setDiscoveryViewerFromSession('owner-A'); }
  if (change === 'epoch') invalidateDiscoveryCaches();
  if (change === 'query') current.isCurrent.mockReturnValue(false);
  if (change === 'abort') current.controller.abort();
  pending.resolve(token(change === 'account' ? 'owner-B' : 'owner-A'));
  expect(await result).toEqual({ ok: false, data: null, errorKind: 'stale_request' });
  expect(mockFetch).not.toHaveBeenCalled();
});

it('rejects a mismatched token even before the auth listener catches up', async () => {
  mockToken.mockResolvedValue(token('owner-B'));
  expect(await searchUsers('private-query-from-A', 10, request())).toEqual({ ok: false, data: null, errorKind: 'stale_request' });
  expect(mockFetch).not.toHaveBeenCalled();
});

it('does not acquire a token for an already-cancelled request', async () => {
  const current = request();
  current.controller.abort();
  expect((await searchUsers('alice', 10, current)).errorKind).toBe('stale_request');
  expect(mockToken).not.toHaveBeenCalled();
});

it.each([200, 403])('withholds a body arriving after scope changes (%s)', async status => {
  const pending = deferred<unknown>();
  let parsing!: () => void;
  const started = new Promise<void>(done => { parsing = done; });
  mockFetch.mockResolvedValue({ ok: status === 200, status, json: () => { parsing(); return pending.promise; } });
  const result = searchUsers('alice', 10, request());
  await started;
  setDiscoveryViewerFromSession('owner-B');
  pending.resolve(status === 200 ? { users: [person] } : { error: 'forbidden' });
  expect(await result).toEqual({ ok: false, data: null, errorKind: 'stale_request' });
});

it.each([
  [403, { error: 'forbidden', message: 'Not permitted' }, 'forbidden'],
  [200, { refusal: { class: 'policy', code: 'blocked' } }, 'policy'],
  [200, { unexpected: [] }, 'malformed_response'],
] as const)('preserves current failures without replacing them with an empty success (%s %s)', async (status, body, errorKind) => {
  mockFetch.mockResolvedValue(response(body, status));
  expect(await searchUsers('alice', 10, request())).toMatchObject({ ok: false, data: null, errorKind });
});

it('preserves unauthenticated and network failure results', async () => {
  mockToken.mockResolvedValueOnce(null);
  expect((await searchUsers('alice', 10, request())).errorKind).toBe('unauthenticated');
  mockFetch.mockRejectedValue(new TypeError('Network request failed'));
  expect((await searchUsers('alice', 10, request())).errorKind).toBe('network_unreachable');
});
