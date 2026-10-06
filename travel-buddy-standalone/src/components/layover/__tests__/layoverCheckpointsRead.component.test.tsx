/**
 * census-layover L30 / L173 — the client half of the traveller's check-ins:
 * `getLayoverCheckpoints`, `reportLayoverCheckpoint` and `checkpointCapability`,
 * against the bodies `routes/airport.ts` actually sends.
 *
 * The rule pinned throughout: a store that is OFF, a read that FAILED and a
 * list that is EMPTY are three different answers, and none of them may be
 * turned into another. Only `fetch` and the two auth modules beneath it are
 * replaced.
 */
import { getLayoverCheckpoints, reportLayoverCheckpoint } from '../../../services/layover.ts';
import { checkpointCapability } from '../LayoverCheckpointControl.tsx';

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

describe('getLayoverCheckpoints — OFF, FAILED and EMPTY stay three answers', () => {
  test('1. the store OFF is available:false — not an empty list', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true, available: false, reason: 'persistence_disabled', checkpoints: null, airportPresence: null }));
    expect(await getLayoverCheckpoints('s-1')).toEqual({ ok: true, available: false });
  });

  test('2. an empty list on a store that is ON is reported as such', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true, available: true, checkpoints: [], airportPresence: 'unreported' }));
    expect(await getLayoverCheckpoints('s-1')).toEqual({ ok: true, available: true, checkpoints: [], airportPresence: 'unreported' });
  });

  test('3. a 503 is unavailable with the server sentence; offline is unreachable', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(503, { error: 'degraded_unavailable', message: 'Your checkpoints could not be loaded. Please try again.' }));
    expect(await getLayoverCheckpoints('s-1')).toEqual({ ok: false, reason: 'unavailable', message: 'Your checkpoints could not be loaded. Please try again.' });
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Network request failed'));
    expect((await getLayoverCheckpoints('s-1') as any).reason).toBe('unreachable');
  });

  test('4. a 200 that claims ON without a list is a contract mismatch, never "nothing reported"', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true, available: true, airportPresence: 'unreported' }));
    const r = await getLayoverCheckpoints('s-1');
    expect(r.ok).toBe(false);
  });

  test('5. the GET goes to this session\'s checkpoints', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true, available: false }));
    await getLayoverCheckpoints('s-1');
    expect(String(spy.mock.calls[0][0])).toMatch(/\/api\/airport\/sessions\/s-1\/checkpoints$/);
  });
});

describe('reportLayoverCheckpoint — every answer the route gives', () => {
  test('6. 201 and 200-duplicate are both a saved report', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(201, { ok: true, duplicate: false, airportPresence: 'landside' }));
    expect(await reportLayoverCheckpoint('s-1', 'LANDSIDE_EXIT', 'op-1')).toEqual({ ok: true, duplicate: false, airportPresence: 'landside' });
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ type: 'LANDSIDE_EXIT', operationId: 'op-1' });
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(200, { ok: true, duplicate: true, airportPresence: 'landside' }));
    expect(await reportLayoverCheckpoint('s-1', 'LANDSIDE_EXIT', 'op-1')).toEqual({ ok: true, duplicate: true, airportPresence: 'landside' });
  });

  test('7. off / ended / unavailable / refused / unreachable are distinct failures', async () => {
    const cases: Array<[number, object, string]> = [
      [403, { error: 'feature_disabled', message: 'Checkpoints are not switched on yet.' }, 'off'],
      [409, { error: 'conflict', message: 'This layover has ended, so there is nothing to report.' }, 'ended'],
      [503, { error: 'degraded_unavailable', message: 'Your checkpoint was not saved. Please try again.' }, 'unavailable'],
      [400, { error: 'invalid_payload', message: 'type must be one of …' }, 'refused'],
    ];
    for (const [status, body, reason] of cases) {
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(status, body));
      const r = await reportLayoverCheckpoint('s-1', 'AIRPORT_REENTRY', 'op-2');
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.reason).toBe(reason);
      expect(r.message).toBe((body as any).message);
    }
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Network request failed'));
    expect((await reportLayoverCheckpoint('s-1', 'AIRPORT_REENTRY', 'op-2') as any).reason).toBe('unreachable');
  });
});

describe('checkpointCapability — read off the overview\'s `persisted`, unknown is hidden', () => {
  test('8. persistence_disabled is OFF; any other published state is ON; absent is UNKNOWN', () => {
    expect(checkpointCapability({ persisted: { state: 'not_stored', reason: 'persistence_disabled' } })).toBe('off');
    expect(checkpointCapability({ persisted: { state: 'stored' } })).toBe('on');
    expect(checkpointCapability({ persisted: { state: 'already_recorded' } })).toBe('on');
    // A store that is ON but failed this once is still ON — the check-in may work.
    expect(checkpointCapability({ persisted: { state: 'not_stored', reason: 'write_failed' } })).toBe('on');
    expect(checkpointCapability({})).toBe('unknown');
    expect(checkpointCapability({ persisted: null })).toBe('unknown');
  });
});
