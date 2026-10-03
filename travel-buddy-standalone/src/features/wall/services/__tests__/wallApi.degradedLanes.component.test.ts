/**
 * census-wall §19 — the client keeps the server's `degraded` lanes.
 *
 * GET /wall answers a failed read with a 200 whose `degraded` names the lanes
 * that could not be read (lib/wallProjection.ts `WallResponse.degraded`): an
 * `items: []` WITH `degraded` is an outage, without it an honestly empty feed.
 * `normalizeWallResponse` rebuilt the body member by member and left
 * `degraded` out, so the one field that told the two apart never reached the
 * screen and an outage rendered as "Nothing here yet".
 *
 * Runs the REAL wallApi with only `fetch`, the supabase config flag and the
 * token faked.
 */

// NOTE: intentional stub — the real module opens a native supabase client at
// import; fetchWall reads only this flag from it.
jest.mock('../../../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: null }));
// NOTE: intentional stub — the real token service needs a signed-in session;
// fetchWall only needs a bearer string.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: async () => 'test-token' }));

import { fetchWall } from '../wallApi.ts';

const ORIGINAL_BASE = process.env.EXPO_PUBLIC_API_BASE_URL;

function answer(body: unknown) {
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  }));
}

const BASE_BODY = { mode: 'for_you', liveForYou: [], items: [], generatedAt: '2026-10-03T00:00:00.000Z' };

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
});
afterAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL_BASE;
});

it('carries the lanes a failed read named', async () => {
  answer({ ...BASE_BODY, degraded: ['spine', 'follow_graph'] });
  const res = await fetchWall({ mode: 'for_you' });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.data.degraded).toEqual(['spine', 'follow_graph']);
});

it('an answer with no `degraded` is a complete answer (absent, not an empty list)', async () => {
  answer(BASE_BODY);
  const res = await fetchWall({ mode: 'for_you' });
  if (!res.ok) throw new Error('vacuity: the fake must answer');
  expect(res.data.degraded).toBeUndefined();
});

it('keeps only lane NAMES — a malformed member is dropped, not rendered', async () => {
  answer({ ...BASE_BODY, degraded: ['media', 42, null, ''] });
  const res = await fetchWall({ mode: 'following' });
  if (!res.ok) throw new Error('vacuity: the fake must answer');
  expect(res.data.degraded).toEqual(['media']);
});
