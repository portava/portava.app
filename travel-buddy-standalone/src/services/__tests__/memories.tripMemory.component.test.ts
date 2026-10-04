/**
 * Memories created from trips — the client half of POST/GET /trips/:id/memory.
 *
 * WHAT WAS WRONG (lane highlights, 2026-10-03):
 *   - `createTripMemory` sent no §19 Idempotency-Key, the only Memory write in
 *     this module that did not, so a blind retry was a different command;
 *   - `getTripMemory` answered every failure as `{ok:false, message}`, so the
 *     trip screen could not tell "this trip has no Memory" (404) from "the
 *     read could not be performed" (503 / no network), and offered to CREATE a
 *     second Memory on an outage.
 *
 * Run with: pnpm test:component
 */

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session,
// which this suite does not exercise.
jest.mock('../apiToken.ts', () => ({
  freshToken: async () => 'test-token',
}));

import { createTripMemory, getTripMemory, _resetMemoryOperationIds } from '../memories.ts';

const TRIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function captureFetch(reply: { ok: boolean; status: number; body: unknown } | Error) {
  const calls: Array<{ url: string; init: any }> = [];
  global.fetch = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return { ok: reply.ok, status: reply.status, json: async () => reply.body };
  }) as unknown as typeof fetch;
  return calls;
}
const keyOf = (c: { init: any }): string | undefined => c.init?.headers?.['Idempotency-Key'];

describe('trip Memory client', () => {
  const realFetch = global.fetch;
  const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;
  beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; _resetMemoryOperationIds(); });
  afterEach(() => { global.fetch = realFetch; process.env.EXPO_PUBLIC_API_BASE_URL = realBase; });

  it('create sends an Idempotency-Key, and a blind retry reuses it', async () => {
    const calls = captureFetch({ ok: false, status: 503, body: { error: 'degraded_unavailable', message: 'try again' } });
    const first = await createTripMemory(TRIP);
    const second = await createTripMemory(TRIP);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`https://api.test/api/trips/${TRIP}/memory`);
    expect(typeof keyOf(calls[0])).toBe('string');
    expect(keyOf(calls[0])).toBe(keyOf(calls[1]));
    expect(first.ok === false && first.kind).toBe('degraded_unavailable');
    expect(second.ok === false && second.operationId).toBe(keyOf(calls[0]));
  });

  it('a create the server answers with the existing Memory says so', async () => {
    captureFetch({ ok: true, status: 200, body: { memory: { id: 'mem-1' }, taggedCount: 0, existing: true } });
    const r = await createTripMemory(TRIP);
    expect(r.ok).toBe(true);
    expect(r.ok && r.memory.id).toBe('mem-1');
    expect(r.ok && r.existing).toBe(true);
  });

  it('a create that never reached the server is network_unreachable, not a server refusal', async () => {
    captureFetch(new TypeError('Network request failed'));
    const r = await createTripMemory(TRIP);
    expect(r.ok === false && r.kind).toBe('network_unreachable');
  });

  it('read: a 404 is not_found — the one answer that means "no Memory for this trip"', async () => {
    captureFetch({ ok: false, status: 404, body: { error: 'not_found', message: 'No memory for this trip' } });
    const r = await getTripMemory(TRIP);
    expect(r.ok === false && r.kind).toBe('not_found');
  });

  it('read: a 503 and a dropped connection are NOT not_found', async () => {
    captureFetch({ ok: false, status: 503, body: { error: 'degraded_unavailable', message: 'Could not read the trip.' } });
    const outage = await getTripMemory(TRIP);
    expect(outage.ok === false && outage.kind).toBe('degraded_unavailable');
    expect(outage.ok === false && outage.message).toBe('Could not read the trip.');

    captureFetch(new TypeError('Network request failed'));
    const offline = await getTripMemory(TRIP);
    expect(offline.ok === false && offline.kind).toBe('network_unreachable');
  });
});
