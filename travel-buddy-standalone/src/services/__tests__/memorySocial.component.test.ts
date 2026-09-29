/**
 * Memory social and browse reads/writes — testing mode WP-06 (HM-F11/F12/F13/F15).
 *
 * The routes existed (`routes/memories.ts` tags / save / share / timeline /
 * places / people / trip recap, and `GET /me/saved-memories`) and no client
 * called them. This suite pins the client half:
 *
 *   - every call goes to the route that owns the behaviour, with the method the
 *     server expects;
 *   - the tag decision (§17 ADD_PERSON consent / REMOVE_PERSON) carries an
 *     Idempotency-Key, like every other Memory command this client sends;
 *   - a refusal arrives as a typed `kind` with the server's own sentence, and a
 *     dropped connection is `network_unreachable` — never an empty list. A
 *     timeline that could not be read is NOT "you have no memories" (DV-83).
 *
 * Run with: pnpm test:component
 */

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session,
// which this suite does not exercise.
jest.mock('../apiToken.ts', () => ({
  freshToken: async () => 'test-token',
}));

import {
  saveMemory,
  unsaveMemory,
  getSavedMemories,
  getMemoryTags,
  respondToMemoryTag,
  getMemoryTimeline,
  getMemoryPlaceHistory,
  getMemoryPeopleHistory,
  getTripMemoryRecap,
  prepareMemoryShare,
} from '../memorySocial.ts';

const MID = '33333333-3333-4333-8333-333333333333';
const UID = '44444444-4444-4444-8444-444444444444';

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
let calls: Call[] = [];
let responses: Array<{ status: number; json: unknown } | 'throw'> = [];

const fakeFetch = jest.fn((url: string, opts: RequestInit = {}) => {
  calls.push({
    url: String(url),
    method: String(opts.method ?? 'GET'),
    headers: (opts.headers ?? {}) as Record<string, string>,
    body: opts.body ? JSON.parse(String(opts.body)) : null,
  });
  const next = responses.shift();
  if (next === 'throw' || next === undefined) return Promise.reject(new TypeError('Network request failed'));
  return Promise.resolve({
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    json: async () => next.json,
  } as Response);
});

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  (globalThis as { fetch: unknown }).fetch = fakeFetch;
});
beforeEach(() => { calls = []; responses = []; });

describe('save / unsave (HM-F13)', () => {
  it('POSTs and DELETEs /memories/:id/save and reports the server state', async () => {
    responses.push({ status: 200, json: { savedByMe: true } });
    const saved = await saveMemory(MID);
    expect(saved).toEqual({ ok: true, savedByMe: true });
    expect(calls[0]).toMatchObject({ url: `http://api.test/api/memories/${MID}/save`, method: 'POST' });

    responses.push({ status: 200, json: { savedByMe: false } });
    const unsaved = await unsaveMemory(MID);
    expect(unsaved).toEqual({ ok: true, savedByMe: false });
    expect(calls[1]).toMatchObject({ url: `http://api.test/api/memories/${MID}/save`, method: 'DELETE' });
  });

  it('a Memory the caller may not read is not_found, with the server sentence', async () => {
    responses.push({ status: 404, json: { error: 'not_found', message: 'Memory not found' } });
    const r = await saveMemory(MID);
    expect(r).toEqual({ ok: false, kind: 'not_found', message: 'Memory not found' });
  });

  it('a dropped connection is network_unreachable, not a save', async () => {
    responses.push('throw');
    const r = await saveMemory(MID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('network_unreachable');
  });
});

describe('saved memories list', () => {
  it('reads GET /me/saved-memories', async () => {
    responses.push({ status: 200, json: { memories: [{ id: MID }], truncated: false } });
    const r = await getSavedMemories();
    expect(calls[0].url).toBe('http://api.test/api/me/saved-memories');
    expect(r).toEqual({ ok: true, memories: [{ id: MID }], truncated: false });
  });

  it('an unreadable shelf is an error, never an empty list', async () => {
    responses.push({ status: 503, json: { error: 'degraded_unavailable', message: 'We could not load your saved memories. Please try again.' } });
    const r = await getSavedMemories();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('degraded_unavailable');
  });
});

describe('participants (HM-F12)', () => {
  it('reads GET /memories/:id/tags', async () => {
    responses.push({ status: 200, json: { tags: [{ userId: UID, status: 'pending', rung: 'NAMED', name: 'B', handle: 'b' }], anonymousParticipants: 1 } });
    const r = await getMemoryTags(MID);
    expect(calls[0]).toMatchObject({ url: `http://api.test/api/memories/${MID}/tags`, method: 'GET' });
    expect(r).toEqual({ ok: true, tags: [{ userId: UID, status: 'pending', rung: 'NAMED', name: 'B', handle: 'b' }], anonymousParticipants: 1 });
  });

  it('PATCHes the tag with the action and an Idempotency-Key', async () => {
    responses.push({ status: 200, json: { status: 'approved' } });
    const r = await respondToMemoryTag(MID, UID, 'approve');
    expect(r).toEqual({ ok: true, status: 'approved' });
    expect(calls[0]).toMatchObject({
      url: `http://api.test/api/memories/${MID}/tags/${UID}`,
      method: 'PATCH',
      body: { action: 'approve' },
    });
    const key = calls[0].headers['Idempotency-Key'];
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
    expect(key.length).toBeLessThanOrEqual(200);
  });

  it('an explicit operation id is sent verbatim', async () => {
    responses.push({ status: 200, json: { status: 'removed' } });
    await respondToMemoryTag(MID, UID, 'remove', { operationId: 'op-fixed-1' });
    expect(calls[0].headers['Idempotency-Key']).toBe('op-fixed-1');
    expect(calls[0].body).toEqual({ action: 'remove' });
  });

  it('a kernel refusal keeps its kind and sentence', async () => {
    responses.push({ status: 403, json: { error: 'forbidden', message: 'Only the tagged person can approve their own tag' } });
    const r = await respondToMemoryTag(MID, UID, 'approve');
    expect(r).toEqual({ ok: false, kind: 'forbidden', message: 'Only the tagged person can approve their own tag' });
  });
});

describe('owner browse projections (HM-F11)', () => {
  it('timeline rows come from GET /memories/timeline', async () => {
    const rows = [{ memory_id: MID, occurred_at: '2026-09-01T00:00:00Z', title: 'Hoi An' }];
    responses.push({ status: 200, json: { timeline: { rows, truncated: false } } });
    const r = await getMemoryTimeline();
    expect(calls[0].url).toBe('http://api.test/api/memories/timeline');
    expect(r).toEqual({ ok: true, rows, truncated: false });
  });

  it('an unbuildable timeline is an error, not an empty life', async () => {
    responses.push({ status: 503, json: { error: 'degraded_unavailable', message: 'We could not build your timeline. Please try again.' } });
    const r = await getMemoryTimeline();
    expect(r).toEqual({ ok: false, kind: 'degraded_unavailable', message: 'We could not build your timeline. Please try again.' });
  });

  it('place history reads GET /memories/places/:placeId', async () => {
    responses.push({ status: 200, json: { history: { rows: [], truncated: false } } });
    const r = await getMemoryPlaceHistory(UID);
    expect(calls[0].url).toBe(`http://api.test/api/memories/places/${UID}`);
    expect(r).toEqual({ ok: true, rows: [], truncated: false });
  });

  it('shared history reads GET /memories/people/:personId', async () => {
    responses.push({ status: 200, json: { sharedHistory: { rows: [{ memory_id: MID }], truncated: true } } });
    const r = await getMemoryPeopleHistory(UID);
    expect(calls[0].url).toBe(`http://api.test/api/memories/people/${UID}`);
    expect(r).toEqual({ ok: true, rows: [{ memory_id: MID }], truncated: true });
  });

  it('a malformed 200 is an error, not an empty history', async () => {
    responses.push({ status: 200, json: { unexpected: true } });
    const r = await getMemoryPeopleHistory(UID);
    expect(r.ok).toBe(false);
  });
});

describe('trip recap (HM-F15)', () => {
  it('reads GET /trips/:tripId/memories/recap', async () => {
    const rows = [{ memory_id: MID, occurred_at: '2026-09-01T00:00:00Z', people: [UID], media_count: 3 }];
    responses.push({ status: 200, json: { recap: { tripId: UID, rows } } });
    const r = await getTripMemoryRecap(UID);
    expect(calls[0].url).toBe(`http://api.test/api/trips/${UID}/memories/recap`);
    expect(r).toEqual({ ok: true, rows });
  });

  it('no recap for this viewer is not_found', async () => {
    responses.push({ status: 404, json: { error: 'not_found', message: 'No recap for this trip' } });
    const r = await getTripMemoryRecap(UID);
    expect(r).toEqual({ ok: false, kind: 'not_found', message: 'No recap for this trip' });
  });
});

describe('share gate (HM-F13)', () => {
  it('POSTs /memories/:id/share and returns the Telegraph reference the server issues', async () => {
    responses.push({ status: 200, json: { ok: true, share: { objectType: 'MEMORY', objectId: MID, deepLink: `/memory/${MID}`, public: true } } });
    const r = await prepareMemoryShare(MID);
    expect(calls[0]).toMatchObject({ url: `http://api.test/api/memories/${MID}/share`, method: 'POST' });
    expect(r).toEqual({ ok: true, share: { objectType: 'MEMORY', objectId: MID, deepLink: `/memory/${MID}`, public: true } });
  });

  it('a 200 without a share reference is NOT a green light', async () => {
    responses.push({ status: 200, json: { ok: true } });
    const r = await prepareMemoryShare(MID);
    expect(r.ok).toBe(false);
  });
});
