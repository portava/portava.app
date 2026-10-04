/**
 * The two API calls `useThreadReadState` makes — `fetchReceipts` and `markSeen`
 * — against the routes the server actually serves
 * (artifacts/api-server/src/routes/telegraphLifecycle.ts: GET
 * /threads/:threadId/receipts?messageIds=…, POST /threads/:threadId/seen with
 * `{ upToMessageId }`). The hook's own test replaces both, so without this file
 * a wrong path, method or body would pass every client test and fail on the
 * first real device.
 *
 * WHAT TURNS THIS RED: a path, method, query or body the routes do not accept,
 * or a failure turned into a success.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */

// NOTE: intentional stub — the real module builds a Supabase client at import time.
jest.mock('../../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: null }));
// NOTE: intentionally exhaustive — the module reads one function from it.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));

import { fetchReceipts, markSeen } from '../lifecycle/lifecycleApi.ts';

const T = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});
afterAll(() => { (global as any).fetch = realFetch; });

const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

describe('fetchReceipts', () => {
  it('GETs the receipts route with the ids as one comma-separated query value', async () => {
    fetchMock.mockResolvedValue(answer(200, { threadId: T, receipts: [] }));
    const r = await fetchReceipts(T, [A, B]);
    expect(r).toEqual({ ok: true, data: { threadId: T, receipts: [] } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.test/api/threads/${T}/receipts?messageIds=${encodeURIComponent(`${A},${B}`)}`);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.headers?.Authorization).toBe('Bearer tok-1');
  });

  it('a refusal is a failure, never an empty set of receipts', async () => {
    fetchMock.mockResolvedValue(answer(503, { error: 'db_error', message: 'down' }));
    const r = await fetchReceipts(T, [A]);
    expect(r).toEqual(expect.objectContaining({ ok: false, error: 'db_error' }));
  });

  it('a request that never got an answer is a failure too', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    const r = await fetchReceipts(T, [A]);
    expect(r).toEqual(expect.objectContaining({ ok: false, error: 'network' }));
  });
});

describe('markSeen', () => {
  it('POSTs the message-anchored seen route with { upToMessageId }', async () => {
    fetchMock.mockResolvedValue(answer(200, { advanced: true, lastReadAt: '2026-10-03T10:00:00Z' }));
    const r = await markSeen(T, A);
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.test/api/threads/${T}/seen`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ upToMessageId: A });
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('a refused mark (e.g. a message outside the window) is reported, not swallowed', async () => {
    fetchMock.mockResolvedValue(answer(404, { error: 'not_found', message: 'No such message in this conversation' }));
    const r = await markSeen(T, A);
    expect(r).toEqual(expect.objectContaining({ ok: false, error: 'not_found' }));
  });
});
