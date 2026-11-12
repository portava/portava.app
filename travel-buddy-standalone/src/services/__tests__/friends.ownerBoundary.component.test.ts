import { getFriendStatus, removeFriend, sendFriendRequest } from '../friends.ts';
import { setDiscoveryViewerFromSession, _resetDiscoveryViewerScopeForTests } from '../discoveryViewerScope.ts';

const mockToken = jest.fn();
// NOTE: Token refresh is the asynchronous auth boundary under test.
jest.mock('../apiToken.ts', () => ({ freshToken: () => mockToken() }));
// NOTE: The real Supabase instance is a native/network dependency, not used by this API transport.
jest.mock('../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));

const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const token = (owner: string) => `e30.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.signature`;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  _resetDiscoveryViewerScopeForTests(); setDiscoveryViewerFromSession('owner-a');
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  mockToken.mockReset().mockResolvedValue(token('owner-a'));
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'friends' }) });
});
afterEach(() => {
  global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
  _resetDiscoveryViewerScopeForTests();
});

it.each([
  { name: 'read', run: () => getFriendStatus('person') },
  { name: 'send', run: () => sendFriendRequest('person') },
  { name: 'remove', run: () => removeFriend('person') },
])('does not dispatch $name with a token refreshed into another account', async ({ run }) => {
  const refresh = deferred<string>(); mockToken.mockReturnValue(refresh.promise);
  const pending = run();
  setDiscoveryViewerFromSession('owner-b'); refresh.resolve(token('owner-b'));
  expect(await pending).toMatchObject({ ok: false, errorKind: 'unauthenticated' });
  expect(global.fetch).not.toHaveBeenCalled();
});

it('rejects a mismatched token before an auth event has arrived', async () => {
  mockToken.mockResolvedValue(token('owner-b'));
  expect(await sendFriendRequest('person')).toMatchObject({ ok: false, errorKind: 'unauthenticated' });
  expect(global.fetch).not.toHaveBeenCalled();
});

it('discards a success body decoded after an account change', async () => {
  const body = deferred<{ status: string }>(); const decoding = deferred<void>();
  jest.mocked(global.fetch).mockResolvedValue({ ok: true, json: () => { decoding.resolve(); return body.promise; } } as Response);
  const pending = sendFriendRequest('person'); await decoding.promise;
  setDiscoveryViewerFromSession('owner-b'); body.resolve({ status: 'friends' });
  expect(await pending).toMatchObject({ ok: false, data: null, errorKind: 'unauthenticated' });
});

it('preserves a valid owner mutation and the server auto-accept result', async () => {
  expect(await sendFriendRequest('person')).toMatchObject({ ok: true, data: { status: 'friends' } });
  expect(global.fetch).toHaveBeenCalledWith('https://api.test/api/users/person/friend-request', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: `Bearer ${token('owner-a')}` }) }));
});
