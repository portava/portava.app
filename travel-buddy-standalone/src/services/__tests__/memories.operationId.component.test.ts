/**
 * §19 — client operation ids, and the refusal a concurrent edit gets.
 *
 * Highlights/Memories Development Architecture Spec v1 §19 ("Offline and
 * Multi-Device Behavior"). Census H175 ("Client operation ids + server
 * idempotency on the sync command") and H178 ("Concurrent edits resolve at
 * command/field level, not blind row last-write-wins").
 *
 * WHAT WAS WRONG. `lib/memoryCommandBus.ts:584#readMemoryCommandEnvelope` has
 * read an `idempotency-key` header on every Memory write route for some time,
 * and mints `randomUUID()` when the header is absent — its own comment says
 * that is so "an unaware client is not given a dedup window keyed on something
 * it did not choose". This client sent no header at all, so §19's CLIENT
 * operation id did not exist on the client. Separately, the server's 409
 * `conflict` — the one answer that means "somebody else changed this" — was
 * flattened by every function in `services/memories.ts` into the same
 * `{ok:false, message}` a dropped socket produces.
 *
 * WHAT THIS SUITE PINS:
 *   - the header crosses the wire on create, patch, delete and media add;
 *   - a BLIND RETRY of the same call reuses the SAME key. This is the whole
 *     point: a key minted per call is exactly as useless as the server minting
 *     one, because the second attempt is then a different command.
 *   - a DIFFERENT payload is a different operation;
 *   - an explicit `operationId` is used verbatim and nothing is guessed;
 *   - 409 arrives as `kind: 'conflict'`, distinguishable from a network drop,
 *     and the server's own sentence still reaches the caller's `message`.
 *
 * Run with: pnpm test:component
 */

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session,
// which this suite does not exercise.
jest.mock('../apiToken.ts', () => ({
  freshToken: async () => 'test-token',
}));

import {
  createMemory,
  updateMemory,
  deleteMemory,
  deleteMemoryItem,
  addMemoryItemFromUrl,
  newMemoryOperationId,
  _resetMemoryOperationIds,
} from '../memories.ts';

const MID = '33333333-3333-4333-8333-333333333333';

/** Records every request so the header can be asserted on. */
function captureFetch(reply: { ok: boolean; status: number; body: unknown }) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return {
      ok: reply.ok,
      status: reply.status,
      json: async () => reply.body,
    };
  });
  global.fetch = fn as unknown as typeof fetch;
  return calls;
}

function keyOf(call: { init: any }): string | undefined {
  return call.init?.headers?.['Idempotency-Key'];
}

describe('§19 client operation ids', () => {
  const realFetch = global.fetch;
  const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    _resetMemoryOperationIds();
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
  });

  it('sends an Idempotency-Key on create', async () => {
    const calls = captureFetch({ ok: true, status: 201, body: { memory: { id: MID } } });
    const r = await createMemory({ caption: 'Lanterns' });

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const key = keyOf(calls[0]);
    expect(typeof key).toBe('string');
    expect((key ?? '').length).toBeGreaterThan(0);
    // The server rejects anything longer than 200 characters with a 400.
    expect((key ?? '').length).toBeLessThanOrEqual(200);
  });

  it('reuses ONE key across a blind retry of the same create', async () => {
    const calls = captureFetch({
      ok: false, status: 503, body: { error: 'degraded_unavailable', message: 'try again' },
    });

    const first = await createMemory({ caption: 'Lanterns' });
    const second = await createMemory({ caption: 'Lanterns' });

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(calls).toHaveLength(2);
    expect(keyOf(calls[0])).toBe(keyOf(calls[1]));
    // And the caller is told which operation it was, so it can hold onto it.
    expect(first.ok === false && first.operationId).toBe(keyOf(calls[0]));
  });

  it('gives a DIFFERENT payload a different key', async () => {
    const calls = captureFetch({ ok: true, status: 201, body: { memory: { id: MID } } });

    await createMemory({ caption: 'Lanterns' });
    await createMemory({ caption: 'Something else entirely' });

    expect(calls).toHaveLength(2);
    expect(keyOf(calls[0])).not.toBe(keyOf(calls[1]));
  });

  it('treats key order in the payload as irrelevant — same intent, same key', async () => {
    const calls = captureFetch({ ok: true, status: 201, body: { memory: { id: MID } } });

    await createMemory({ caption: 'Lanterns', title: 'Hoi An' });
    await createMemory({ title: 'Hoi An', caption: 'Lanterns' });

    expect(calls).toHaveLength(2);
    expect(keyOf(calls[0])).toBe(keyOf(calls[1]));
  });

  it('uses an explicit operationId verbatim and guesses nothing', async () => {
    const calls = captureFetch({ ok: true, status: 200, body: { memory: { id: MID } } });
    const mine = newMemoryOperationId('lane-test');

    await updateMemory(MID, { caption: 'edited', operationId: mine });

    expect(keyOf(calls[0])).toBe(mine);
    // The id is NOT part of the patch body — it travels in the header only.
    expect(JSON.parse(calls[0].init.body)).not.toHaveProperty('operationId');
  });

  it('sends the key on delete and on a media add', async () => {
    const calls = captureFetch({ ok: true, status: 201, body: { item: { id: 'i1' } } });
    await addMemoryItemFromUrl(MID, 'https://example.test/a.jpg', 'image/jpeg');
    expect(keyOf(calls[0])).toBeTruthy();

    const delCalls = captureFetch({ ok: true, status: 204, body: {} });
    await deleteMemory(MID);
    expect(keyOf(delCalls[0])).toBeTruthy();
  });

  it('keys REMOVE_MEDIA on the item, so removing two items is two operations', async () => {
    const calls = captureFetch({ ok: true, status: 204, body: {} });

    await deleteMemoryItem(MID, 'item-a');
    await deleteMemoryItem(MID, 'item-b');

    expect(keyOf(calls[0])).not.toBe(keyOf(calls[1]));
  });
});

describe('§19 / H178 — a conflict is not a network error', () => {
  const realFetch = global.fetch;
  const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    _resetMemoryOperationIds();
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
  });

  it('reports the server’s 409 as `conflict`, with its sentence intact', async () => {
    captureFetch({
      ok: false,
      status: 409,
      body: {
        error: 'conflict',
        message: 'This Memory changed while you were editing it. Reload it and try again.',
      },
    });

    const r = await updateMemory(MID, { caption: 'mine' });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.kind).toBe('conflict');
    // `app/memory/edit.tsx:135` renders `message` — the server's own words must
    // survive the mapping, not be replaced by a client paraphrase.
    expect(r.message).toContain('changed while you were editing it');
  });

  it('does not call a dropped connection a conflict', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('Network request failed');
    }) as unknown as typeof fetch;

    const r = await updateMemory(MID, { caption: 'mine' });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.kind).toBe('network_unreachable');
  });

  it('maps the other refusals the write routes can send', async () => {
    const cases: Array<[number, string, string]> = [
      [404, 'not_found', 'not_found'],
      [403, 'forbidden', 'forbidden'],
      [400, 'invalid_payload', 'invalid_payload'],
      [503, 'degraded_unavailable', 'degraded_unavailable'],
    ];
    for (const [status, code, expected] of cases) {
      _resetMemoryOperationIds();
      captureFetch({ ok: false, status, body: { error: code, message: code } });
      const r = await updateMemory(MID, { caption: `c-${code}` });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.kind).toBe(expected);
    }
  });

  it('does not grow a second vocabulary — an unknown code becomes db_error', async () => {
    captureFetch({ ok: false, status: 500, body: { error: 'something_new', message: 'x' } });
    const r = await updateMemory(MID, { caption: 'mine' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.kind).toBe('db_error');
  });
});
