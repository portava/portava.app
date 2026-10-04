/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; sweep): getPulseData never hands its callers a feed the server
 * said it could not read as a feed with nothing in it.
 *
 * GET /pulse keeps its fail-closed empty answer when the viewer's block state or the crew tab's follows cannot be read,
 * and names the read in `failedSources` (pulseFeedUnread PF1, PF2). getPulseData returned that body as `ok`, so the
 * Pulse feed and the destination page's posts section drew "no posts". A body that names a failed read is now a failed
 * load (`ok: false`), which both callers already say as a failed load.
 *
 *   PD0 CONTROL: a whole answer with one post → ok, the post
 *   PD1 `posts: []` beside `failedSources: ["blocks"]` → not ok
 *   PD2 CONTROL: `posts: []`, nothing named (a quiet city) → ok and empty
 *
 * census-discovery §123 (DV-83 round 24; the round-23 verifier's survivor Y37): the one name that leaves a feed whole is
 * `post_saves` (§122, B36: the viewer's own saved state). Every other name is a failed feed, and nothing pinned that for
 * `post_hides`, the read GET /pulse fails CLOSED over (§122, B40): a mutation that read a `post_hides` refusal as an
 * empty feed survived. These fixtures kill it.
 *   PD3 `posts: []` beside `failedSources: ["post_hides"]` → not ok (the viewer hid posts the server could not list)
 *   PD4 `["user_follows"]` → not ok; PD5 `["post_saves", "post_hides"]` → not ok (one exempt name does not exempt the rest)
 *   PD6 a name this client has never seen → not ok (only `post_saves` is exempt, by name)
 */
// NOTE: intentionally exhaustive — apiToken exposes a single async helper; a stable token reaches fetch.
jest.mock('../apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'tok'),
}));
// NOTE: intentionally exhaustive — requireActual would construct the real Supabase client, whose auto-refresh timer outlives the test.
jest.mock('../../lib/supabase.ts', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));

import { getPulseData } from '../pulse.ts';

const POST = { id: 'p1', authorId: 'u2', content: 'Sunset from the fort', createdAt: '2026-09-30T18:00:00.000Z', mediaUrls: [] };
function answer(body: Record<string, unknown>) {
  (globalThis as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterEach(() => { delete (globalThis as any).fetch; });

describe('census-discovery §119 (sweep): getPulseData reads failedSources', () => {
  it('PD0 CONTROL: a whole answer → ok, the post', async () => {
    answer({ posts: [POST], total: 1, tab: 'all' });
    const r = await getPulseData({ city: 'Lisbon' });
    expect(r.ok && r.data.posts.map((p) => p.id)).toEqual(['p1']);
  });
  it('PD1 posts [] beside failedSources ["blocks"] → not ok, never an empty feed', async () => {
    answer({ posts: [], total: 0, tab: 'all', failedSources: ['blocks'] });
    const r = await getPulseData({ city: 'Lisbon' });
    expect(r.ok).toBe(false);
  });
  it('PD2 CONTROL: posts [], nothing named → ok and empty', async () => {
    answer({ posts: [], total: 0, tab: 'all' });
    const r = await getPulseData({ city: 'Lisbon' });
    expect(r.ok && r.data.posts).toEqual([]);
  });
});

describe('census-discovery §123 (Y37): only `post_saves` leaves a Pulse feed whole', () => {
  const failed = async (failedSources: string[]) => {
    answer({ posts: [], total: 0, tab: 'all', failedSources });
    return getPulseData({ city: 'Lisbon' });
  };
  it('PD3 failedSources ["post_hides"] → not ok, never an empty feed', async () => {
    const r = await failed(['post_hides']);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("Couldn't load the feed");
  });
  it('PD4 failedSources ["user_follows"] → not ok', async () => {
    expect((await failed(['user_follows'])).ok).toBe(false);
  });
  it('PD5 failedSources ["post_saves", "post_hides"] → not ok', async () => {
    expect((await failed(['post_saves', 'post_hides'])).ok).toBe(false);
    expect((await failed(['post_hides', 'post_saves'])).ok).toBe(false);
  });
  it('PD6 a name this client has never seen → not ok', async () => {
    expect((await failed(['some_future_read'])).ok).toBe(false);
  });
});
