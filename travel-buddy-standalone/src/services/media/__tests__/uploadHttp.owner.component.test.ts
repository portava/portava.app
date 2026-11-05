import { setDiscoveryViewerFromSession } from '../../discoveryViewerScope.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken } from '../../__tests__/observedOwnerSessionFixture.ts';
jest.mock('../../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; } } } };
});
jest.mock('../../apiToken.ts', () => ({ ...jest.requireActual('../../apiToken.ts'), freshToken: jest.fn() }));
import { freshToken } from '../../apiToken.ts';
import { captureObservedOwnerSnapshot } from '../../observedOwnerSnapshot.ts';
import { createUploadLifetime } from '../uploadLifetime.ts';
import { apiCall } from '../uploadHttp.ts';
const ownerId = '10000000-0000-4000-a000-000000000001';
const savedBase = process.env.EXPO_PUBLIC_API_BASE_URL;
function response(overrides: Partial<Response> = {}): Response {
  return { status: 200, ok: true, url: '', redirected: false, headers: new Headers({ 'retry-after': '3' }), json: async () => ({ id: 'post' }), ...overrides } as Response;
}
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  setDiscoveryViewerFromSession(ownerId); seedObservedOwnerSession(ownerId, 'upload-session');
  jest.mocked(freshToken).mockResolvedValue(observedOwnerAccessToken(ownerId, 'upload-session'));
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(response());
});
afterEach(() => {
  disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null);
  jest.restoreAllMocks(); jest.resetAllMocks(); jest.useRealTimers();
  if (savedBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = savedBase;
});
it('retains original bearer, HTTP retry metadata and refuses redirects', async () => {
  expect(await apiCall('POST', '/api/postcards', {})).toEqual({ status: 200, body: { id: 'post' }, retryAfter: '3' });
  expect(fetch).toHaveBeenCalledWith('https://api.test/api/postcards', expect.objectContaining({ redirect: 'error', credentials: 'omit', headers: expect.objectContaining({ Authorization: `Bearer ${observedOwnerAccessToken(ownerId, 'upload-session')}` }) }));
  jest.mocked(fetch).mockResolvedValueOnce(response({ redirected: true }));
  await expect(apiCall('POST', '/api/postcards')).rejects.toThrow(/redirected/);
});
it('account/session replacement during token refresh never sends the queued upload as the replacement user', async () => {
  let release!: (token: string) => void;
  jest.mocked(freshToken).mockImplementation(() => new Promise<string>((r) => { release = r; }));
  const pending = apiCall('POST', '/api/postcards');
  for (let i = 0; i < 12; i++) await Promise.resolve();
  seedObservedOwnerSession(ownerId, 'replacement-session');
  release(observedOwnerAccessToken(ownerId, 'replacement-session'));
  await expect(pending).rejects.toThrow(/session changed/); expect(fetch).not.toHaveBeenCalled();
});
it('cancel aborts a token lookup even when the provider does not settle', async () => {
  const lifetime = createUploadLifetime(captureObservedOwnerSnapshot()!);
  try {
    jest.mocked(freshToken).mockReturnValue(new Promise(() => {}));
    const pending = apiCall('POST', '/api/postcards', {}, lifetime);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    lifetime.cancel();
    await expect(pending).rejects.toThrow(/interrupted/); expect(fetch).not.toHaveBeenCalled();
  } finally { lifetime.dispose(); }
});
it('unsafe API endpoints are refused before obtaining a token', async () => {
  for (const base of ['http://api.test', 'https://user@api.test', 'https://api.test/nested', 'https://api.test?secret=x']) {
    process.env.EXPO_PUBLIC_API_BASE_URL = base;
    await expect(apiCall('POST', '/api/postcards')).rejects.toThrow();
  }
  expect(freshToken).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it('a hanging response body is bounded and cancellation does not wait for parsing', async () => {
  const lifetime = createUploadLifetime(captureObservedOwnerSnapshot()!);
  try {
    jest.mocked(fetch).mockResolvedValue(response({ json: () => new Promise(() => {}) }));
    const pending = apiCall('POST', '/api/postcards', {}, lifetime);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    lifetime.cancel(); await expect(pending).rejects.toThrow(/interrupted/);
  } finally { lifetime.dispose(); }
});
it('token refresh has a deadline even when there is no active network request to abort', async () => {
  jest.useFakeTimers();
  jest.mocked(freshToken).mockReturnValue(new Promise(() => {}));
  const outcome = expect(apiCall('POST', '/api/postcards')).rejects.toThrow(/timed out/);
  await jest.advanceTimersByTimeAsync(30_001);
  await outcome; expect(fetch).not.toHaveBeenCalled();
});
