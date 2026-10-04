/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; §119.16 B36): the Pulse feed never draws the viewer's own saved
 * state from a read the server could not make.
 *
 * GET /pulse now serves `savedByMe: null` on every post and names `post_saves` in `failedSources` when the viewer's
 * saves cannot be read (api-server pulseSavedUnread PS1, PS2). The posts themselves are whole: the save state never
 * decides what is shown. So getPulseData keeps such a feed `ok` (only an own-state source is named), and
 * pulsePostToFeedItem carries `null` through, never `false` ("not saved").
 *
 *   PSC0 posts beside failedSources ["post_saves"] → ok, the posts kept, savedByMe null
 *   PSC1 failedSources ["post_saves", "blocks"] → not ok (the block read is still a failed feed)
 *   PSC2 pulsePostToFeedItem: savedByMe null → null, never false
 *   PSC3 CONTROL: savedByMe true / false → carried as measured
 */
// NOTE: intentionally exhaustive — apiToken exposes a single async helper; a stable token reaches fetch.
jest.mock('../apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'tok'),
}));
// NOTE: intentionally exhaustive — requireActual would construct the real Supabase client, whose auto-refresh timer outlives the test.
jest.mock('../../lib/supabase.ts', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));

import { getPulseData, pulsePostToFeedItem, type PulsePost } from '../pulse.ts';

const POST = { id: 'p1', authorId: 'u2', content: 'Sunset from the fort', createdAt: '2026-09-30T18:00:00.000Z', mediaUrls: [], spanTags: [], spanHashtags: [] };
function answer(body: Record<string, unknown>) {
  (globalThis as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterEach(() => { delete (globalThis as any).fetch; });

describe('census-discovery §122 (B36): the Pulse feed never says "not saved" over an unread save state', () => {
  it('PSC0 posts beside failedSources ["post_saves"] → ok, the posts kept, savedByMe null', async () => {
    answer({ posts: [{ ...POST, savedByMe: null }], total: 1, tab: 'all', failedSources: ['post_saves'] });
    const r = await getPulseData({ city: 'Lisbon' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.posts.map((p) => [p.id, p.savedByMe])).toEqual([['p1', null]]);
    expect(r.data.failedSources).toEqual(['post_saves']);
  });
  it('PSC1 failedSources ["post_saves", "blocks"] → not ok', async () => {
    answer({ posts: [], total: 0, tab: 'all', failedSources: ['post_saves', 'blocks'] });
    const r = await getPulseData({ city: 'Lisbon' });
    expect(r.ok).toBe(false);
  });
  it('PSC2 pulsePostToFeedItem carries savedByMe null, never false', () => {
    expect(pulsePostToFeedItem({ ...POST, savedByMe: null } as unknown as PulsePost).savedByMe).toBeNull();
  });
  it('PSC3 CONTROL: savedByMe true / false carried as measured', () => {
    expect(pulsePostToFeedItem({ ...POST, savedByMe: true } as unknown as PulsePost).savedByMe).toBe(true);
    expect(pulsePostToFeedItem({ ...POST, savedByMe: false } as unknown as PulsePost).savedByMe).toBe(false);
  });
});
