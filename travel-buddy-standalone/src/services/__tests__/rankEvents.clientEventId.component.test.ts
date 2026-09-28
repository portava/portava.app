/**
 * services/rankEvents.ts `recordOutcome` names each outcome with a
 * `client_event_id` (census-discovery §63, DV-37 — §62.7 hunk H1's second file).
 *
 * Nothing in the tree calls `recordOutcome` today (census-discovery §62's
 * NOT-GRADED entry); it is the service-layer twin of `fireRankOutcome`, and a
 * future caller must not reintroduce the keyless outcome §62 closed on the
 * server. So: one call is one action with one v4 key; the body is otherwise the
 * one it always was; and the server's `duplicate` answer is not an error.
 *
 * Run with: pnpm test:component
 */
// NOTE: intentionally exhaustive — apiToken imports the Supabase client; only
// freshToken is needed and a fixed token is all these tests require.
jest.mock('../apiToken.ts', () => ({ freshToken: jest.fn(async () => 'test-token') }));

import { recordOutcome } from '../rankEvents.ts';

const SERVER_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fetchMock = jest.fn((_url: string, _init?: RequestInit) => Promise.resolve({ ok: true, status: 200 } as Response));
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_BASE = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve({ ok: true, status: 200 } as Response));
});
afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL_BASE;
});

const body = (i: number) => JSON.parse(String((fetchMock.mock.calls[i][1] as RequestInit).body)) as Record<string, unknown>;

describe('recordOutcome — §63 DV-37', () => {
  it('R1. carries a v4 key the server validator accepts, beside the body it always sent', async () => {
    await recordOutcome('evt-1', 'events', 'rsvp', '5e550000-0000-4000-8000-000000000001');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/api/rank-events/outcome');
    const b = body(0);
    expect(b.client_event_id).toEqual(expect.stringMatching(SERVER_KEY));
    expect(b).toEqual({
      item_id: 'evt-1', surface: 'events', outcome: 'rsvp',
      session_id: '5e550000-0000-4000-8000-000000000001', client_event_id: b.client_event_id,
    });
  });

  it('R2. two calls are two actions: two different keys', async () => {
    await recordOutcome('evt-1', 'events', 'rsvp');
    await recordOutcome('evt-1', 'events', 'rsvp');
    expect(body(0).client_event_id).not.toBe(body(1).client_event_id);
    expect(body(0)).not.toHaveProperty('session_id');
  });

  it('R3. the server\'s `duplicate` answer, a 5xx and a network failure all resolve quietly', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, duplicate: true }) } as unknown as Response));
    await expect(recordOutcome('evt-1', 'events', 'rsvp')).resolves.toBeUndefined();
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: false, status: 500 } as Response));
    await expect(recordOutcome('evt-1', 'events', 'rsvp')).resolves.toBeUndefined();
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('Network request failed')));
    await expect(recordOutcome('evt-1', 'events', 'rsvp')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
