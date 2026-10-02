/**
 * HM-F19 — a place's recaps, listed honestly.
 *
 * `listPlaceRecaps` had no caller and answered `[]` for every failure — a
 * disabled capability, a 500 and a dropped connection all read as "you have
 * no recaps here". The place screen now lists them, so the list must keep the
 * refusal: `feature_disabled` hides the section, anything else is an error
 * with a retry, and only a real empty list is "none yet".
 *
 * Run with: pnpm test:component
 */

// NOTE: exhaustive-by-design — the module reads only isSupabaseConfigured from
// lib/supabase, and the real module drags the native SecureStore chain in.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: {},
  authedClient: () => ({}),
}));
// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session.
jest.mock('../apiToken.ts', () => ({
  freshToken: async () => 'test-token',
}));

import { listPlaceRecaps } from '../placeRecaps.ts';

const PLACE = '66666666-6666-4666-8666-666666666666';
let responses: Array<{ status: number; json: unknown } | 'throw'> = [];
let urls: string[] = [];

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  (globalThis as { fetch: unknown }).fetch = jest.fn((url: string) => {
    urls.push(String(url));
    const next = responses.shift();
    if (next === 'throw' || next === undefined) return Promise.reject(new TypeError('Network request failed'));
    return Promise.resolve({ ok: next.status < 300, status: next.status, json: async () => next.json } as Response);
  });
});
beforeEach(() => { responses = []; urls = []; });

it('reads GET /api/places/:placeId/recaps', async () => {
  const recap = { id: 'r1', place_id: PLACE, status: 'published', created_at: 'x', current_version_id: 'v1', live_place_recap_versions: [{ version_number: 1, title: 'A day', summary: 's', published_at: 'y' }] };
  responses.push({ status: 200, json: { recaps: [recap] } });
  const r = await listPlaceRecaps(PLACE);
  expect(urls[0]).toBe(`http://api.test/api/places/${PLACE}/recaps`);
  expect(r).toEqual({ data: [recap], error: null });
});

it('a disabled capability is `disabled`, not an empty list', async () => {
  responses.push({ status: 404, json: { error: 'feature_disabled' } });
  const r = await listPlaceRecaps(PLACE);
  expect(r).toEqual({ data: null, error: 'disabled' });
});

it('a server failure is an error, not an empty list', async () => {
  responses.push({ status: 500, json: { error: 'db_error', message: 'x' } });
  const r = await listPlaceRecaps(PLACE);
  expect(r.error).toBe('server');
  expect(r.data).toBeNull();
});

it('a dropped connection is `network`', async () => {
  responses.push('throw');
  const r = await listPlaceRecaps(PLACE);
  expect(r).toEqual({ data: null, error: 'network' });
});

it('a malformed 200 is an error', async () => {
  responses.push({ status: 200, json: { nope: 1 } });
  const r = await listPlaceRecaps(PLACE);
  expect(r.error).toBe('server');
});
