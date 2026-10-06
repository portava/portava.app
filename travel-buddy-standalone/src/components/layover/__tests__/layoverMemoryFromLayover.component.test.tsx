/**
 * census-layover L275 — keeping a completed layover as a private Memory: the
 * client half.
 *
 * Layover spec §25: "convert a COMPLETED session into an optional
 * stamp/postcard/memory". `createMemoryFromLayover` asks
 * `POST /api/memories/from-layover/:id`; `endLayoverToast` turns the two
 * elections' answers (stamp, Memory) into the one sentence the dashboard shows.
 *
 * What is pinned, against the bodies the server actually sends
 * (`artifacts/api-server/src/routes/memories.ts`, the from-layover handler):
 *
 *   201 { memory, existing:false }  /  200 { memory, existing:true }
 *   409 conflict  reason layover_not_completed
 *   404 not_found  503 degraded_unavailable
 *
 * and that every failure is a FAILURE with the server's sentence — never a
 * silent success, never "saved" over a 2xx that carries no Memory.
 *
 * Only `fetch` and the two auth modules beneath it are replaced.
 */
import {
  createMemoryFromLayover,
  layoverMemoryIdempotencyKey,
} from '../../../services/layover.ts';
import { endLayoverToast } from '../layoverEndToast.ts';

// NOTE: intentionally exhaustive — requireActual on lib/supabase.ts constructs a
// real Supabase client through SecureStoreAdapter, which needs native modules.
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — apiToken.ts imports lib/supabase.ts at module
// scope; a requireActual spread would defeat the mock above.
jest.mock('../../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

afterEach(() => { jest.restoreAllMocks(); });

describe('createMemoryFromLayover — the request', () => {
  test('1. POSTs to the from-layover route with a key that is the SAME on every retry', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(201, { memory: { id: 'm-1' }, existing: false }));
    await createMemoryFromLayover('sess-1');
    await createMemoryFromLayover('sess-1');
    expect(spy).toHaveBeenCalledTimes(2);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/memories\/from-layover\/sess-1$/);
    expect(init.method).toBe('POST');
    const h1 = (init.headers as Record<string, string>)['Idempotency-Key'];
    const h2 = ((spy.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>)['Idempotency-Key'];
    expect(h1).toBe(layoverMemoryIdempotencyKey('sess-1'));
    expect(h2).toBe(h1);
    expect(layoverMemoryIdempotencyKey('sess-2')).not.toBe(h1);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });
});

describe('createMemoryFromLayover — every answer the server gives', () => {
  test('2. 201 is a new Memory', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(201, { memory: { id: 'm-1' }, existing: false }));
    expect(await createMemoryFromLayover('sess-1')).toEqual({ ok: true, memoryId: 'm-1', existing: false });
  });

  test('3. 200 existing is the SAME Memory, said as such', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { memory: { id: 'm-1' }, existing: true }));
    expect(await createMemoryFromLayover('sess-1')).toEqual({ ok: true, memoryId: 'm-1', existing: true });
  });

  test('4. a 2xx that carries no Memory is NOT a saved Memory', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(201, { ok: true }));
    const r = await createMemoryFromLayover('sess-1');
    expect(r.ok).toBe(false);
  });

  test('5. 409 keeps the server sentence and says not_completed', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(409, {
      error: 'conflict', reason: 'layover_not_completed', message: 'Only a layover that ended with your flight can be kept as a Memory.',
    }));
    expect(await createMemoryFromLayover('sess-1')).toEqual({
      ok: false, reason: 'not_completed', message: 'Only a layover that ended with your flight can be kept as a Memory.',
    });
  });

  test('6. 503 is unavailable, 404 is gone, other refusals are refused', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(503, { error: 'degraded_unavailable', message: 'Could not read the layover. Please try again.' }));
    const a = await createMemoryFromLayover('sess-1');
    expect(a).toEqual({ ok: false, reason: 'unavailable', message: 'Could not read the layover. Please try again.' });
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(404, { error: 'not_found', message: 'Layover not found' }));
    expect((await createMemoryFromLayover('sess-1') as any).reason).toBe('gone');
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_payload', message: 'Invalid layover id' }));
    expect((await createMemoryFromLayover('sess-1') as any).reason).toBe('refused');
  });

  test('7. an offline device is unreachable, not a crash and not a success', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
    const r = await createMemoryFromLayover('sess-1');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('unreachable');
  });
});

describe('endLayoverToast — one sentence from two answers, a failure always outranks a success', () => {
  const saved = { ok: true as const, memoryId: 'm-1', existing: false };
  const failed = { ok: false as const, reason: 'unavailable' as const, message: 'Try again later.' };
  test('8. nothing elected, nothing to say', () => { expect(endLayoverToast(false, null)).toBeNull(); });
  test('9. a refused stamp is reported (the existing sentence, unchanged)', () => {
    expect(endLayoverToast(true, null)).toBe('Layover ended — the Passport stamp could not be saved');
  });
  test('10. a failed Memory is reported with the server sentence', () => {
    expect(endLayoverToast(false, failed)).toBe('Layover ended — the Memory could not be saved. Try again later.');
  });
  test('11. both failing names both — neither overwrites the other', () => {
    expect(endLayoverToast(true, failed)).toBe('Layover ended — neither the Passport stamp nor the Memory could be saved');
  });
  test('12. a refused stamp outranks a saved Memory', () => {
    expect(endLayoverToast(true, saved)).toBe('Layover ended — the Passport stamp could not be saved');
  });
  test('13. a saved Memory is confirmed', () => {
    expect(endLayoverToast(false, saved)).toBe('Layover ended — kept as a private Memory');
  });
});
