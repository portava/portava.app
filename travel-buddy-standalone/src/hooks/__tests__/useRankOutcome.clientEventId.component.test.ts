/**
 * useRankOutcome — every outcome names its ACTION with a `client_event_id`, and a
 * "Not interested" retried after a failure re-sends the SAME name
 * (census-discovery §63, DV-37 — the client half of §62.7's hunk H1).
 *
 * WHY. `POST /rank-events/outcome` now keeps a receipt per (viewer,
 * client_event_id) (migration 3420): a key it has already recorded is answered
 * `200 { ok: true, duplicate: true }` and moves nothing. A KEYLESS outcome has no
 * such memory, so when the item was served twice, a retry of one dismissal moved
 * a SECOND exposure and sent a second negative signal (§59 V7). The server half
 * is only as good as the key the client sends, and the key is only useful if a
 * retry carries the one the first attempt carried.
 *
 * WHAT IS PINNED
 *   C1  fire-and-forget: each call carries a v4 key the server's validator
 *       accepts; two calls (two actions) carry two different keys
 *   C2  the hook's tap / save / join / rsvp / trip_add: one key per action
 *   C3  "Not interested" after a NETWORK failure: the retry carries the SAME key
 *   C4  after a 5xx, the retry's `duplicate` answer is SUCCESS: the card may go
 *       (true), the caches are invalidated, and the key is cleared
 *   C5  a success clears the pending key: the next dismissal is a new action
 *   C6  a 404 (no impression to dismiss) keeps the key: the retry re-sends it
 *   C7  keys are per item, per mount, and per surface: two items, two mounts or
 *       two surfaces never share one
 *   C8  signed out: nothing is sent and no key is spent
 *
 * Run with: pnpm test:component
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderHook, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — apiToken imports the Supabase client; only
// freshToken is needed and a controllable token is all these tests require.
const mockFreshToken = jest.fn<Promise<string | null>, []>(async () => 'test-token');
jest.mock('../../services/apiToken.ts', () => ({ freshToken: () => mockFreshToken() }));

import { useRankOutcome, fireRankOutcome } from '../useRankOutcome.ts';
import { onDiscoveryScopeChange, _resetDiscoveryViewerScopeForTests } from '../../services/discoveryViewerScope.ts';

/** The server's validator for `client_event_id` (routes/rankEvents.ts, directEventSchema): a UUID. */
const SERVER_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RID = 'Ab3_-x9QzW7kLmN2pR4tUv';

type Reply = { ok: boolean; status: number; body?: unknown } | 'network';
const fetchMock = jest.fn((_url: string, _init?: RequestInit): Promise<Response> => Promise.resolve(reply({ ok: true, status: 200 })));
function reply(r: { ok: boolean; status: number; body?: unknown }): Response {
  return { ok: r.ok, status: r.status, json: async () => r.body ?? { ok: r.ok } } as unknown as Response;
}
/** Queue the server's answers, in order, for the next requests. */
function serverAnswers(...replies: Reply[]): void {
  for (const r of replies) {
    fetchMock.mockImplementationOnce(() => (r === 'network' ? Promise.reject(new TypeError('Network request failed')) : Promise.resolve(reply(r))));
  }
}

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_BASE = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(reply({ ok: true, status: 200 })));
  mockFreshToken.mockReset();
  mockFreshToken.mockImplementation(async () => 'test-token');
  _resetDiscoveryViewerScopeForTests();
});
afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL_BASE;
});

async function settle() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}
function sentBody(i: number): Record<string, unknown> {
  return JSON.parse(String((fetchMock.mock.calls[i][1] as RequestInit).body));
}
const keyOf = (i: number) => sentBody(i).client_event_id as string;

describe('C1 — fire-and-forget: one action, one key', () => {
  it('SERVER_KEY is the route\'s own validator, read from the server tree (so this suite cannot drift from it)', () => {
    const route = readFileSync(join(__dirname, '../../../../artifacts/api-server/src/routes/rankEvents.ts'), 'utf8');
    expect(route).toContain(`client_event_id: z.string().regex(${SERVER_KEY.toString()}, "client_event_id must be a UUID")`);
    expect(route).toContain('client_event_id: directEventSchema.shape.client_event_id');   // the outcome route reuses it
  });

  it('each call carries a key the server accepts, and two calls carry two keys', async () => {
    fireRankOutcome('node/1', 'discovery', 'tap', null, RID);
    fireRankOutcome('node/1', 'discovery', 'tap', null, RID);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOf(0)).toMatch(SERVER_KEY);
    expect(keyOf(1)).toMatch(SERVER_KEY);
    expect(keyOf(0)).not.toBe(keyOf(1));
    expect(sentBody(0)).toEqual({ item_id: 'node/1', surface: 'discovery', outcome: 'tap', recommendation_id: RID, client_event_id: keyOf(0) });
  });
});

describe('C2 — the hook: one key per action', () => {
  it('tap, save, join, rsvp and trip_add on one item each carry their own key', async () => {
    const { result } = await renderHook(() => useRankOutcome({ surface: 'events' }));
    await act(async () => {
      result.current.reportTap('e1'); result.current.reportSave('e1'); result.current.reportJoin('e1');
      result.current.reportRsvp('e1'); result.current.reportTripAdd('e1');
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const keys = [0, 1, 2, 3, 4].map(keyOf);
    for (const k of keys) expect(k).toMatch(SERVER_KEY);
    expect(new Set(keys).size).toBe(5);
  });
});

describe('"Not interested" — the key survives a failure and is cleared by a success', () => {
  it('C3. a retry after a NETWORK failure carries the SAME key, and succeeds', async () => {
    serverAnswers('network', { ok: true, status: 200 });
    const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));
    let first = true, second = false;
    await act(async () => { first = await result.current.reportDismiss('node/9', RID); });
    await act(async () => { second = await result.current.reportDismiss('node/9', RID); });
    expect([first, second]).toEqual([false, true]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOf(0)).toMatch(SERVER_KEY);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(sentBody(1)).toEqual({ item_id: 'node/9', surface: 'discovery', outcome: 'dismiss', recommendation_id: RID, client_event_id: keyOf(0) });
  });

  it('C4. after a 5xx, the retry is answered `duplicate` (the first attempt had landed): that is SUCCESS', async () => {
    serverAnswers({ ok: false, status: 500 }, { ok: true, status: 200, body: { ok: true, duplicate: true } });
    const scopes: number[] = [];
    const off = onDiscoveryScopeChange(() => scopes.push(1));
    const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));
    let first = true, second = false;
    await act(async () => { first = await result.current.reportDismiss('node/9'); });
    expect(scopes).toHaveLength(0);
    await act(async () => { second = await result.current.reportDismiss('node/9'); });
    off();
    expect([first, second]).toEqual([false, true]);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(scopes.length).toBeGreaterThan(0);
    // …and the key is spent: a later dismissal of the same item is a new action.
    await act(async () => { await result.current.reportDismiss('node/9'); });
    expect(keyOf(2)).toMatch(SERVER_KEY);
    expect(keyOf(2)).not.toBe(keyOf(0));
  });

  it('C5. a success clears the pending key: two accepted dismissals carry two keys', async () => {
    const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));
    await act(async () => { await result.current.reportDismiss('node/9'); });
    await act(async () => { await result.current.reportDismiss('node/9'); });
    expect(keyOf(0)).not.toBe(keyOf(1));
  });

  it('C6. a 404 (nothing to dismiss) keeps the key: the retry re-sends it', async () => {
    serverAnswers({ ok: false, status: 404 }, { ok: false, status: 404 }, { ok: true, status: 200 });
    const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));
    const got: boolean[] = [];
    for (let i = 0; i < 3; i++) await act(async () => { got.push(await result.current.reportDismiss('node/9')); });
    expect(got).toEqual([false, false, true]);
    expect(new Set([0, 1, 2].map(keyOf)).size).toBe(1);
  });

  it('C7. per item, per mount and per surface: no two actions share a key', async () => {
    serverAnswers('network', 'network', 'network', 'network');
    const a = await renderHook(() => useRankOutcome({ surface: 'discovery' }));
    const b = await renderHook(() => useRankOutcome({ surface: 'discovery' }));
    const s = await renderHook(({ surface }: { surface: 'discovery' | 'pulse' }) => useRankOutcome({ surface }), { initialProps: { surface: 'discovery' as 'discovery' | 'pulse' } });
    await act(async () => { await a.result.current.reportDismiss('node/1'); });       // 0: mount A, item 1
    await act(async () => { await a.result.current.reportDismiss('node/2'); });       // 1: mount A, item 2
    await act(async () => { await b.result.current.reportDismiss('node/1'); });       // 2: mount B, item 1
    await act(async () => { await s.result.current.reportDismiss('node/1'); });       // 3: mount S on discovery
    await act(async () => { s.rerender({ surface: 'pulse' }); });
    await act(async () => { await s.result.current.reportDismiss('node/1'); });       // 4: mount S on pulse
    await act(async () => { await a.result.current.reportDismiss('node/1'); });       // 5: mount A, item 1 again (a retry)
    const k = [0, 1, 2, 3, 4, 5].map(keyOf);
    expect(new Set(k.slice(0, 5)).size).toBe(5);
    expect(k[5]).toBe(k[0]);
  });

  it('C8. signed out: nothing is sent, and the next signed-in attempt still starts from one key', async () => {
    mockFreshToken.mockImplementationOnce(async () => null);
    serverAnswers('network', { ok: true, status: 200 });
    const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));
    let out = true;
    await act(async () => { out = await result.current.reportDismiss('node/9'); });
    expect(out).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { await result.current.reportDismiss('node/9'); });
    await act(async () => { await result.current.reportDismiss('node/9'); });
    expect(keyOf(1)).toBe(keyOf(0));
  });
});
