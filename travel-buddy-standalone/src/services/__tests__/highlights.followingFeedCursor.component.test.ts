/**
 * The following-feed client carries the server's §12 cursor both ways.
 *
 * With `highlights_feed_bounded_enabled` on, `GET /api/highlights/following-feed`
 * answers one finite page plus `nextCursor`. `fetchFollowingHighlightsFeed`
 * used to send no cursor and drop `nextCursor` from the response, so a caller
 * had no way to read past the first page: everything after it was unreachable
 * while the tray looked complete. These assertions pin the transport half;
 * `useFollowingHighlights.cursorWalk` pins the walk.
 *
 * Run with: pnpm test:component
 */
process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';

jest.mock('../../lib/supabase.ts', () => ({
  ...jest.requireActual('../../lib/supabase.ts'),
  isSupabaseConfigured: true,
}));

jest.mock('../../services/apiToken.ts', () => ({
  ...jest.requireActual('../../services/apiToken.ts'),
  freshToken: async () => 'test-token',
}));

import { fetchFollowingHighlightsFeed } from '../highlights.ts';

const realFetch = global.fetch;
let calls: string[] = [];

function respondWith(status: number, body: unknown) {
  calls = [];
  global.fetch = jest.fn(async (url: string) => {
    calls.push(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof fetch;
}

const user = (id: string) => ({ userId: id, handle: id, name: null, avatarUrl: null, highlights: [] });

afterEach(() => {
  global.fetch = realFetch;
});

describe('fetchFollowingHighlightsFeed — the §12 cursor', () => {
  it('returns the server\'s nextCursor with the page', async () => {
    respondWith(200, { users: [user('a')], nextCursor: '2026-10-03T06:00:00.000000+00:00' });

    const r = await fetchFollowingHighlightsFeed();

    expect(r.ok).toBe(true);
    expect(r.data?.map((u) => u.userId)).toEqual(['a']);
    expect(r.nextCursor).toBe('2026-10-03T06:00:00.000000+00:00');
  });

  it('sends the cursor it is given, encoded, and none on the first page', async () => {
    respondWith(200, { users: [], nextCursor: null });

    await fetchFollowingHighlightsFeed();
    await fetchFollowingHighlightsFeed('2026-10-03T06:00:00.000000+00:00');

    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain('cursor=');
    const second = new URL(calls[1]);
    expect(second.pathname).toBe('/api/highlights/following-feed');
    expect(second.searchParams.get('cursor')).toBe('2026-10-03T06:00:00.000000+00:00');
  });

  it('reports no cursor when the server sends none (cap off: one unbounded response)', async () => {
    respondWith(200, { users: [user('a')] });

    const r = await fetchFollowingHighlightsFeed();

    expect(r.ok).toBe(true);
    expect(r.nextCursor).toBeNull();
  });

  it('reports no cursor on a refusal', async () => {
    respondWith(503, { error: 'degraded_unavailable', message: 'try again' });

    const r = await fetchFollowingHighlightsFeed('c1');

    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('degraded_unavailable');
    expect(r.nextCursor).toBeNull();
  });
});
