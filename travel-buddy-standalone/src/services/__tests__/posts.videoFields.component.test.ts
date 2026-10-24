/**
 * Video playback (owner-reported 2026-10-24) — `getPostById` carries the post's own declared
 * media fields, which the detail screen falls back to when `media` is empty.
 *
 * mapPost dropped `media_type`, `has_video` and (until it reached the screen) the thumbnail, so a
 * post served with `media: []` and a `.mov` in `media_urls` had nothing left that said "video".
 * Drives the real getPostById against a fetch stub with e4bbf335's production shape.
 */
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

// NOTE: intentionally exhaustive — the two exports posts.ts reads from supabase.
jest.mock('../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the one export posts.ts reads.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => 'test-token' }));

import { getPostById } from '../posts.ts';

const MOV = 'post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov';
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function serve(body: Record<string, unknown>) {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => body }) as any) as any;
}

test("e4bbf335's shape: mediaType, hasVideo and the thumbnail reach the PostRow", async () => {
  serve({ id: 'e4bbf335', author_id: 'a', content: 'x', media_urls: [MOV], media: [], media_type: 'video/quicktime', has_video: false, media_thumbnail_url: null, visibility: 'public', status: 'active' });
  const r = await getPostById('e4bbf335');
  expect(r.ok).toBe(true);
  expect(r.data?.mediaType).toBe('video/quicktime');
  expect(r.data?.hasVideo).toBe(false);
  expect(r.data?.mediaThumbnailUrl).toBeNull();
  expect(r.data?.mediaUrls).toEqual([MOV]);
});

test('has_video true and a recorded thumbnail are carried', async () => {
  serve({ id: 'p2', author_id: 'a', media_urls: [], media: [], media_type: null, has_video: true, media_thumbnail_url: `${MOV}.poster.jpg`, visibility: 'public', status: 'active' });
  const r = await getPostById('p2');
  expect(r.data?.hasVideo).toBe(true);
  expect(r.data?.mediaType).toBeNull();
  expect(r.data?.mediaThumbnailUrl).toBe(`${MOV}.poster.jpg`);
});
