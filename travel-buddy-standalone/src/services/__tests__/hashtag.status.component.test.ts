/**
 * services/hashtag.ts keeps a failed read's HTTP status — census-discovery §105 (DV-83 round 9,
 * register D-W11X2-61). app/hashtag/[slug].tsx tells "removed or blocked" (404) from "couldn't be
 * loaded" (500 / network) by it; without it every failure read as "This hashtag is unavailable".
 *
 *   HSS1  a 500 → { ok: false, status: 500 }
 *   HSS2  a 404 → { ok: false, status: 404 }
 *   HSS3  a thrown fetch → ok: false with no status (the screen treats it as a failed read)
 *
 * Run with: pnpm test:component
 */
// NOTE: a stand-in on purpose — the service needs a configured client and nothing else from the module.
jest.mock('../../lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — the service needs a configured client and nothing else from the module.
jest.mock('../../lib/supabase.ts', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — only freshToken is read, and the test fixes its value.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));
// NOTE: a stand-in on purpose — only freshToken is read, and the test fixes its value.
jest.mock('../apiToken', () => ({ freshToken: async () => 'tok-1' }));

import { getHashtag } from '../hashtag.ts';

const realFetch = global.fetch;
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterAll(() => { global.fetch = realFetch; });
const answer = (status: number) => {
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ error: 'x', message: 'x' }), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
};

describe('hashtag service failure status (§105)', () => {
  it('HSS1 a 500 keeps its status', async () => {
    answer(500);
    const r = await getHashtag('romejazz');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  });

  it('HSS2 a 404 keeps its status', async () => {
    answer(404);
    const r = await getHashtag('romejazz');
    expect(r.status).toBe(404);
  });

  it('HSS3 a thrown fetch has no status', async () => {
    global.fetch = jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const r = await getHashtag('romejazz');
    expect(r.ok).toBe(false);
    expect(r.status).toBeUndefined();
  });
});
