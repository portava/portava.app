/** Concurrent screen reads should share work without caching across accounts or edits. */
// NOTE: avoid constructing a native auth client; requests use the controlled token below.
jest.mock('../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
let mockToken = 'owner-a';
// NOTE: auth is the boundary here; verify that coalescing remains scoped to its token.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => mockToken }));
import { getMyProfile, updateMyProfile } from '../profile.ts';
import { getPulseData } from '../pulse.ts';

const realFetch = globalThis.fetch;
const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const response = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; mockToken = 'owner-a'; });
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
});

it('coalesces 20 concurrent own-profile reads into one HTTP request, then reads fresh again', async () => {
  let release!: (value: Response) => void;
  const fetcher = jest.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
  globalThis.fetch = fetcher;
  const reads = Array.from({ length: 20 }, () => getMyProfile());
  await tick();
  expect(fetcher).toHaveBeenCalledTimes(1);
  release(response({ id: 'owner-a' }));
  const results = await Promise.all(reads);
  expect(results.every((r) => r.ok && r.data?.id === 'owner-a')).toBe(true);
  fetcher.mockResolvedValueOnce(response({ id: 'owner-a', bio: 'Updated' }));
  const next = await getMyProfile();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(next.data?.bio).toBe('Updated');
});

it('does not reuse another account’s pending profile read', async () => {
  const releases: Array<(value: Response) => void> = [];
  const fetcher = jest.fn(() => new Promise<Response>((resolve) => { releases.push(resolve); }));
  globalThis.fetch = fetcher;
  const first = getMyProfile(); await tick();
  mockToken = 'owner-b';
  const second = getMyProfile(); await tick();
  expect(fetcher).toHaveBeenCalledTimes(2);
  releases[0](response({ id: 'owner-a' })); releases[1](response({ id: 'owner-b' }));
  expect((await first).data?.id).toBe('owner-a');
  expect((await second).data?.id).toBe('owner-b');
});

it('does not reuse a pre-edit read after saving a profile', async () => {
  const releases: Array<(value: Response) => void> = [];
  globalThis.fetch = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'PATCH'
    ? Promise.resolve(response({ id: 'owner-a', bio: 'New bio' }))
    : new Promise<Response>((resolve) => { releases.push(resolve); }));
  const before = getMyProfile(); await tick();
  await updateMyProfile({ bio: 'New bio' });
  const after = getMyProfile(); await tick();
  expect(releases).toHaveLength(2);
  releases[0](response({ id: 'owner-a', bio: 'Old bio' }));
  releases[1](response({ id: 'owner-a', bio: 'New bio' }));
  await before;
  expect((await after).data?.bio).toBe('New bio');
});

it('forwards feed cancellation to fetch so superseded pages stop using the network', async () => {
  const controller = new AbortController();
  const fetcher = jest.fn(async () => response({ posts: [], placeCards: [] }));
  globalThis.fetch = fetcher;
  await getPulseData({ city: 'Cebu', signal: controller.signal });
  expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
});
