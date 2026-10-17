/**
 * MD385 client service — "Save to a Memory" from one's own post.
 *
 * Pins: the request names the post and the media INDEX, never a URL, and
 * carries a §19 idempotency key; every server answer becomes a person's
 * sentence with the right retry; a multi-photo copy that stops part-way says
 * how many made it.
 *
 * Run with: pnpm test:component
 */
const mockToken = jest.fn();
// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session.
jest.mock('../apiToken.ts', () => ({ freshToken: () => mockToken() }));

import {
  saveOwnPostMediaToMemory, saveOwnPostToMemory, describeSavePostReport, isRetryable, SAVE_FROM_POST_COPY, MEMORY_FROM_OWN_MEDIA_FLAG,
} from '../memoryFromPost.ts';

const MEM = '10000000-0000-4000-8000-000000000001';
const POST = '20000000-0000-4000-8000-000000000002';
const realFetch = global.fetch;
const fetchMock = jest.fn();
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  mockToken.mockReset().mockResolvedValue('tok');
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => { global.fetch = realFetch; });

describe('saveOwnPostMediaToMemory', () => {
  it('names the post and the media index — never a URL — with an idempotency key', async () => {
    fetchMock.mockResolvedValueOnce(reply(201, { item: { id: 'item-1', mediaUrl: 'x' } }));
    const r = await saveOwnPostMediaToMemory({ memoryId: MEM, postId: POST, mediaIndex: 2 });
    expect(r).toEqual({ ok: true, itemId: 'item-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://api.test/api/memories/${MEM}/items/from-post`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(typeof init.headers['Idempotency-Key']).toBe('string');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ postId: POST, mediaIndex: 2, position: 2 });
    expect(JSON.stringify(body)).not.toMatch(/http|mediaUrl/);
  });

  it.each([
    [403, { error: 'feature_disabled' }, 'disabled', false],
    [404, { error: 'not_found' }, 'not_found', false],
    [403, { error: 'forbidden' }, 'forbidden', false],
    [400, { error: 'invalid_payload' }, 'no_media', false],
    [409, { error: 'conflict' }, 'already_saved', false],
    [503, { error: 'degraded_unavailable' }, 'unavailable', true],
    [500, { error: 'db_error' }, 'failed', true],
  ])('HTTP %s %j is "%s" (retryable: %s), said in words', async (status, body, kind, retryable) => {
    fetchMock.mockResolvedValueOnce(reply(status as number, body));
    const r = await saveOwnPostMediaToMemory({ memoryId: MEM, postId: POST, mediaIndex: 0 });
    expect(r).toEqual({ ok: false, kind, message: SAVE_FROM_POST_COPY[kind as keyof typeof SAVE_FROM_POST_COPY] });
    expect(isRetryable(kind as any)).toBe(retryable);
  });

  it('a request that never reached the server is "network", and says nothing was saved', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    const r = await saveOwnPostMediaToMemory({ memoryId: MEM, postId: POST, mediaIndex: 0 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind).toBe('network');
    expect(!r.ok && r.message).toMatch(/Nothing was saved/);
  });

  it('reads the flag by the name 3999 seeds', () => {
    expect(MEMORY_FROM_OWN_MEDIA_FLAG).toBe('memory_from_own_media_enabled');
  });
});

describe('saveOwnPostToMemory — every media item, honestly counted', () => {
  it('copies each media index in order', async () => {
    fetchMock.mockResolvedValue(reply(201, { item: { id: 'i' } }));
    const r = await saveOwnPostToMemory({ memoryId: MEM, postId: POST, mediaCount: 3 });
    expect(r).toEqual({ saved: 3, alreadyThere: 0, total: 3, refusal: null });
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).mediaIndex)).toEqual([0, 1, 2]);
    expect(describeSavePostReport(r, 'Lisbon')).toBe('All 3 saved to “Lisbon”.');
  });

  it('a final refusal on the first item stops at once', async () => {
    fetchMock.mockResolvedValueOnce(reply(403, { error: 'feature_disabled' }));
    const r = await saveOwnPostToMemory({ memoryId: MEM, postId: POST, mediaCount: 3 });
    expect(r).toEqual({ saved: 0, alreadyThere: 0, total: 3, refusal: 'disabled' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(describeSavePostReport(r, 'Lisbon')).toBe(SAVE_FROM_POST_COPY.disabled);
  });

  it('a failure part-way says how many made it — never "saved", never "failed"', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(201, { item: { id: 'a' } }))
      .mockResolvedValueOnce(reply(503, { error: 'degraded_unavailable' }));
    const r = await saveOwnPostToMemory({ memoryId: MEM, postId: POST, mediaCount: 3 });
    expect(r).toEqual({ saved: 1, alreadyThere: 0, total: 3, refusal: 'unavailable' });
    expect(describeSavePostReport(r, null)).toBe('1 of 3 saved to your Memory. The rest weren’t — try again.');
  });

  it('a photo already in the Memory is counted as there, not as a failure', async () => {
    fetchMock.mockResolvedValueOnce(reply(409, { error: 'conflict' }));
    const r = await saveOwnPostToMemory({ memoryId: MEM, postId: POST, mediaCount: 1 });
    expect(r).toEqual({ saved: 0, alreadyThere: 1, total: 1, refusal: null });
    expect(describeSavePostReport(r, 'Kyoto')).toBe('Already in “Kyoto”.');
  });
});
