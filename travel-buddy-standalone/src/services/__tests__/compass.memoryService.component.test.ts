/**
 * Memory + Experience Intelligence service methods (Rediscovery §8 + view /
 * feedback / export / reset §17).
 *
 * A jest suite (not node:test) because the service imports lib/supabase, whose
 * SecureStoreAdapter → react-native chain cannot be transformed by tsx/esbuild
 * in plain Node — jest-expo transforms it correctly. supabase is mocked so the
 * `isSupabaseConfigured` gate is deterministically on and no native module is
 * touched; `fetch` is faked so no network/auth is involved.
 *
 * Covers, per method: happy path (URL/method/body + parsed result), empty
 * result, and error mapping (non-2xx → http_<status>, thrown → network_error).
 *
 * Run with: pnpm test:component
 */

// NOTE: exhaustive-by-design mock — lib/supabase only exports isSupabaseConfigured,
// supabase and authedClient, and this file must FORCE isSupabaseConfigured true
// (so the service's config gate passes) while keeping the real module's
// SecureStoreAdapter → react-native native chain out of the test entirely.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: {},
  authedClient: () => ({}),
}));

import {
  fetchRediscover,
  fetchProjectedMemories,
  postMemoryFeedback,
  fetchMemoryExport,
  postMemoryReset,
  _setTestAuthToken,
} from '../compass.ts';

interface CapturedCall { url: string; method: string; body: Record<string, unknown> | null; }
let calls: CapturedCall[] = [];
let responses: Array<{ status: number; json: unknown } | 'throw'> = [];

const fakeFetch = jest.fn((url: string, opts: RequestInit = {}) => {
  const next = responses.shift();
  calls.push({
    url: String(url),
    method: String(opts.method ?? 'GET'),
    body: opts.body ? JSON.parse(String(opts.body)) : null,
  });
  if (next === 'throw' || next === undefined) return Promise.reject(new Error('network down'));
  return Promise.resolve({
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    json: async () => next.json,
  } as Response);
});

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  // @ts-expect-error — override the global for the duration of the suite.
  global.fetch = fakeFetch;
});

beforeEach(() => {
  calls = [];
  responses = [];
  fakeFetch.mockClear();
  _setTestAuthToken('test-token');
});

describe('fetchRediscover', () => {
  it('requests the city + returns the tagged memories on success', async () => {
    responses = [{ status: 200, json: { rediscover: [
      { id: 'm1', memory_type: 'episodic', subject_type: 'city', subject_id: 'Lisbon', content: 'You loved Alfama', confidence: 0.9, reason: 'been_here_before' },
      { id: 'm2', memory_type: 'place', subject_type: 'place', subject_id: 'p9', content: 'Saved A Brasileira', confidence: 0.7, reason: 'you_saved' },
    ] } }];
    const r = await fetchRediscover('Lisbon');
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(2);
    expect(r.data?.[0].reason).toBe('been_here_before');
    expect(calls[0].url).toMatch(/\/api\/compass\/me\/memory\/rediscover\?city=Lisbon&limit=20$/);
    expect(calls[0].method).toBe('GET');
  });

  it('returns an empty array (not an error) when there is nothing to resurface', async () => {
    responses = [{ status: 200, json: { rediscover: [] } }];
    const r = await fetchRediscover('Lisbon');
    expect(r).toEqual({ ok: true, data: [] });
  });

  it('rejects an empty city without hitting the network', async () => {
    const r = await fetchRediscover('   ');
    expect(r).toEqual({ ok: false, error: 'no_city' });
    expect(calls).toHaveLength(0);
  });

  it('maps a non-2xx response to http_<status>', async () => {
    responses = [{ status: 500, json: { error: 'db' } }];
    const r = await fetchRediscover('Lisbon');
    expect(r).toEqual({ ok: false, error: 'http_500' });
  });

  it('maps a thrown fetch to network_error', async () => {
    responses = ['throw'];
    const r = await fetchRediscover('Lisbon');
    expect(r).toEqual({ ok: false, error: 'network_error' });
  });
});

describe('fetchProjectedMemories', () => {
  it('returns the ranked memories for the requested surface', async () => {
    responses = [{ status: 200, json: { memories: [
      { id: 'p1', memory_type: 'semantic', subject_type: 'cuisine', subject_id: 'ramen', content: 'You favour ramen', confidence: 0.8, last_supported_at: null, valid_from: null },
    ] } }];
    const r = await fetchProjectedMemories('compass');
    expect(r.ok).toBe(true);
    expect(r.data?.[0].id).toBe('p1');
    expect(calls[0].url).toMatch(/\/api\/compass\/me\/memory\?surface=compass&limit=50$/);
  });

  it('is empty (not an error) when the projector has produced nothing', async () => {
    responses = [{ status: 200, json: { memories: [] } }];
    const r = await fetchProjectedMemories();
    expect(r).toEqual({ ok: true, data: [] });
  });

  it('maps a 401 to http_401', async () => {
    responses = [{ status: 401, json: {} }];
    const r = await fetchProjectedMemories();
    expect(r).toEqual({ ok: false, error: 'http_401' });
  });
});

describe('postMemoryFeedback', () => {
  it('POSTs the kind + projectionId', async () => {
    responses = [{ status: 201, json: { recorded: true } }];
    const r = await postMemoryFeedback({ kind: 'forget', projectionId: 'p1' });
    expect(r.ok).toBe(true);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toMatch(/\/api\/compass\/me\/memory\/feedback$/);
    expect(calls[0].body).toEqual({ kind: 'forget', projectionId: 'p1' });
  });

  it('surfaces a 404 (borrowed/guessed projection) as http_404', async () => {
    responses = [{ status: 404, json: { error: 'not_found' } }];
    const r = await postMemoryFeedback({ kind: 'hide', projectionId: 'nope' });
    expect(r).toEqual({ ok: false, error: 'http_404' });
  });

  it('maps a thrown fetch to network_error', async () => {
    responses = ['throw'];
    const r = await postMemoryFeedback({ kind: 'incorrect', projectionId: 'p1' });
    expect(r).toEqual({ ok: false, error: 'network_error' });
  });
});

describe('fetchMemoryExport', () => {
  it('returns every derived row, including suppressed ones', async () => {
    responses = [{ status: 200, json: { memories: [
      { memory_type: 'place', subject_type: 'place', subject_id: 'p9', content: 'A Brasileira', confidence: 0.6, state: 'active', valid_from: null, valid_to: null, last_supported_at: null },
      { memory_type: 'social', subject_type: 'user', subject_id: 'u2', content: 'Knows Marta', confidence: 0.4, state: 'decayed', valid_from: null, valid_to: null, last_supported_at: null, suppressed_by: true },
    ] } }];
    const r = await fetchMemoryExport();
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(2);
    expect(calls[0].url).toMatch(/\/api\/compass\/me\/memory\/export$/);
  });

  it('is empty (not an error) when nothing has been derived', async () => {
    responses = [{ status: 200, json: { memories: [] } }];
    const r = await fetchMemoryExport();
    expect(r).toEqual({ ok: true, data: [] });
  });

  it('maps a 500 to http_500', async () => {
    responses = [{ status: 500, json: {} }];
    const r = await fetchMemoryExport();
    expect(r).toEqual({ ok: false, error: 'http_500' });
  });
});

describe('postMemoryReset', () => {
  it('POSTs an empty body for a full reset and normalizes the counts', async () => {
    responses = [{ status: 200, json: { reset: true, projectionsCleared: 4, eventsCleared: 12, feedbackKept: 2 } }];
    const r = await postMemoryReset();
    expect(r.ok).toBe(true);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({});
    expect(r.data).toEqual({ reset: true, projectionsCleared: 4, eventsCleared: 12, feedbackKept: 2 });
  });

  it('scopes to given memory classes when provided', async () => {
    responses = [{ status: 200, json: { reset: true, projectionsCleared: 1, eventsCleared: 0, feedbackKept: 0 } }];
    const r = await postMemoryReset(['place', 'social']);
    expect(r.ok).toBe(true);
    expect(calls[0].body).toEqual({ memoryTypes: ['place', 'social'] });
  });

  it('maps a 500 to http_500', async () => {
    responses = [{ status: 500, json: {} }];
    const r = await postMemoryReset();
    expect(r).toEqual({ ok: false, error: 'http_500' });
  });
});
