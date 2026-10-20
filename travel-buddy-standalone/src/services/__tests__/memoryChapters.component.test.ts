jest.mock('../apiToken.ts', () => ({ ...jest.requireActual('../apiToken.ts'), freshToken: jest.fn() }));

import { freshToken } from '../apiToken.ts';
import { getLifeChapters } from '../memoryChapters.ts';
import { supabase } from '../../lib/supabase.ts';

const originalFetch = global.fetch;
const mockFetch = jest.fn();
const memoryIds = ['33333333-3333-4333-8333-000000000001', '33333333-3333-4333-8333-000000000002'];
function payload() {
  return { graph: { truncated: false, momentCount: 2, momentsOnRecordedTime: 1, levels: { LIFE_CHAPTER: [{
    level: 'LIFE_CHAPTER', id: 'life_chapter:place:park', key: 'place:park',
    startedAt: '2025-04-01T00:00:00Z', endedAt: '2026-04-01T00:00:00Z',
    memoryCount: 2, memberMemoryIds: memoryIds,
  }] } } };
}
beforeEach(() => {
  (freshToken as jest.Mock).mockResolvedValue('test-token');
  mockFetch.mockReset().mockResolvedValue({ ok: true, json: async () => payload() });
  global.fetch = mockFetch;
});
afterEach(() => { global.fetch = originalFetch; });
afterAll(async () => { await supabase.auth.stopAutoRefresh(); });

it('uses the authenticated owner graph and retains references, not content', async () => {
  const result = await getLifeChapters();
  expect(mockFetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/memories\/graph$/), expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } }));
  expect(result).toEqual({ ok: true, truncated: false, recordedTimeCount: 1, chapters: [{
    id: 'life_chapter:place:park', kind: 'place', startedAt: '2025-04-01T00:00:00Z', endedAt: '2026-04-01T00:00:00Z', memoryIds,
  }] });
});

it('does not request private data without a token', async () => {
  (freshToken as jest.Mock).mockResolvedValue(null);
  expect((await getLifeChapters()).ok).toBe(false);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('does not fetch after cancellation during token refresh', async () => {
  const controller = new AbortController();
  (freshToken as jest.Mock).mockImplementation(async () => { controller.abort(); return 'test-token'; });
  expect((await getLifeChapters(controller.signal)).ok).toBe(false);
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each([
  ['missing graph', {}],
  ['null list', { graph: { ...payload().graph, levels: { LIFE_CHAPTER: null } } }],
  ['invalid truncation', { graph: { ...payload().graph, truncated: 'false' } }],
  ['invalid count', { graph: { ...payload().graph, momentsOnRecordedTime: 3 } }],
])('refuses %s rather than showing empty history', async (_name, body) => {
  mockFetch.mockResolvedValue({ ok: true, json: async () => body });
  expect((await getLifeChapters()).ok).toBe(false);
});

it.each([
  { memberMemoryIds: [memoryIds[0], memoryIds[0]] },
  { memberMemoryIds: ['../private', memoryIds[1]] },
  { memoryCount: 99 },
  { id: 'unrelated' },
  { startedAt: 'unknown' },
  { endedAt: '2020-01-01' },
  { key: 'caption:copied text' },
])('refuses malformed chapter %j', async (patch) => {
  const body = payload();
  Object.assign(body.graph.levels.LIFE_CHAPTER[0], patch);
  mockFetch.mockResolvedValue({ ok: true, json: async () => body });
  expect((await getLifeChapters()).ok).toBe(false);
});

it('accepts genuine empty and truncated responses', async () => {
  const body = payload();
  body.graph.levels.LIFE_CHAPTER = [];
  body.graph.truncated = true;
  mockFetch.mockResolvedValue({ ok: true, json: async () => body });
  expect(await getLifeChapters()).toEqual({ ok: true, chapters: [], truncated: true, recordedTimeCount: 1 });
});

it.each(['network', 'http', 'json'])('refuses %s failures', async (failure) => {
  if (failure === 'network') mockFetch.mockRejectedValue(new Error('offline'));
  else mockFetch.mockResolvedValue({ ok: failure !== 'http', json: async () => { throw new Error('bad json'); } });
  expect((await getLifeChapters()).ok).toBe(false);
});
