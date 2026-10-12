/**
 * census-layover L275 — what `createPostcard` puts on the WIRE for a layover postcard.
 *
 * The composer suite mocks this module wholesale, so it cannot see the HTTP
 * body. This file drives the real `createPostcard` against a fetch stub and
 * asserts the POST body: a layover postcard carries `layoverSessionId` and NO
 * location key (the server takes city/country from the layover and refuses a
 * location sent alongside it). Without this, dropping the field from the body
 * would create a layover postcard with no place at all and every suite above
 * would stay green (verifier mutant C-V1).
 */
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

// NOTE: intentionally exhaustive — the two exports postcards.ts reads.
jest.mock('../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the one export postcards.ts reads.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => 'test-token' }));

import { createPostcard } from '../postcards.ts';

const LOCATION_KEYS = ['locationName', 'locationCity', 'locationCountry', 'locationLat', 'locationLng', 'placeId', 'canonicalLocationId'];

let bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
const realFetch = global.fetch;
beforeEach(() => {
  bodies = [];
  global.fetch = jest.fn(async (url: any, init: any) => {
    bodies.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return { ok: true, status: 201, json: async () => ({ id: 'post-1' }) } as any;
  }) as any;
});
afterEach(() => { global.fetch = realFetch; });

test('a layover postcard POSTs its layoverSessionId and no location key', async () => {
  const r = await createPostcard({ visibility: 'private', layoverSessionId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', addToPassport: true });
  expect(r.ok).toBe(true);
  expect(bodies).toHaveLength(1);
  expect(bodies[0].url).toBe('http://api.test/api/postcards');
  expect(bodies[0].body.layoverSessionId).toBe('dddddddd-dddd-dddd-dddd-dddddddddddd');
  expect(bodies[0].body.visibility).toBe('private');
  for (const k of LOCATION_KEYS) expect(bodies[0].body).not.toHaveProperty(k);
});

test('an ordinary postcard POSTs its place and no layoverSessionId', async () => {
  await createPostcard({ locationCity: 'Tokyo', locationCountry: 'Japan', locationLat: 35.68, locationLng: 139.76 });
  expect(bodies[0].body).not.toHaveProperty('layoverSessionId');
  expect(bodies[0].body.locationCity).toBe('Tokyo');
  expect(bodies[0].body.locationLat).toBe(35.68);
});
