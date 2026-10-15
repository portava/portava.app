/**
 * census-layover L118 — the client half of `POST /airport/sessions/:id/simulate`:
 * `simulateMapBudget`, against the bodies `routes/layoverSimulate.ts` sends.
 *
 * Pinned: the request names the session and carries ONLY the budget; a refusal,
 * an off switch, an outage and an unreadable answer stay distinct and keep the
 * server's sentence; and a 200 that is not a simulation of THIS budget (another
 * budget, a stop without the server's band) is refused rather than drawn. Only
 * `fetch` and the two auth modules beneath it are replaced.
 */
import { simulateMapBudget } from '../../../services/layover.ts';

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

const BAND = { band: 'TIGHT', reason: 'Only 10 min to spare after the stay and the trip there and back.', neededMin: 110, usableMinutes: 120, spareMin: 10 };
function okBody(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    simulation: { budgetMinutes: 120, certifiedUsableMinutes: 300, stored: false, statement: 'If you had only 2 h out of the airport: …' },
    stops: [{ id: 'a', insideAirport: false, mapBand: BAND }, { id: 'lounge', insideAirport: true, mapBand: { ...BAND, band: null } }],
    planFit: { usableMinutes: 120, fit: 'fits' },
    certification: { inputHash: 'h' },
    ...over,
  };
}

afterEach(() => { jest.restoreAllMocks(); });

describe('simulateMapBudget — the request', () => {
  test('POSTs to THIS session\'s simulate route with the budget and nothing else', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, okBody()));
    await simulateMapBudget('s-1', 120);
    expect(String(spy.mock.calls[0][0])).toMatch(/\/api\/airport\/sessions\/s-1\/simulate$/);
    expect(spy.mock.calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toEqual({ budgetMinutes: 120 });
  });
});

describe('simulateMapBudget — the answers stay distinct', () => {
  test('a simulation of this budget is returned as the server sent it', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, okBody()));
    const r = await simulateMapBudget('s-1', 120);
    expect(r).toEqual({
      ok: true, budgetMinutes: 120, certifiedUsableMinutes: 300, statement: 'If you had only 2 h out of the airport: …',
      stops: okBody().stops, planFit: okBody().planFit,
    });
  });

  test('409 is a refusal in the server\'s words', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(409, { error: 'conflict', reason: 'above_certified', message: 'Your certified usable time is 110 minutes. A time budget can only narrow it, never widen it.' }));
    expect(await simulateMapBudget('s-1', 120)).toEqual({ ok: false, reason: 'refused', message: 'Your certified usable time is 110 minutes. A time budget can only narrow it, never widen it.' });
  });

  test('feature_disabled is OFF; 400 is invalid; 503 is unavailable; no response is unreachable', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(404, { error: 'feature_disabled', message: 'Time-budget chips are not switched on.' }));
    expect((await simulateMapBudget('s-1', 120) as any).reason).toBe('off');
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_payload', message: 'x' }));
    expect((await simulateMapBudget('s-1', 120) as any).reason).toBe('invalid');
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(503, { error: 'degraded_unavailable', message: 'Your layover could not be loaded. Please try again.' }));
    expect(await simulateMapBudget('s-1', 120)).toEqual({ ok: false, reason: 'unavailable', message: 'Your layover could not be loaded. Please try again.' });
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Network request failed'));
    expect((await simulateMapBudget('s-1', 120) as any).reason).toBe('unreachable');
  });

  test('a 200 for ANOTHER budget is not this simulation', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, okBody({ simulation: { ...okBody().simulation, budgetMinutes: 180 } })));
    expect((await simulateMapBudget('s-1', 120)).ok).toBe(false);
  });

  test('a stop without the server\'s band under the budget is not a simulation — never drawn as one', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, okBody({ stops: [{ id: 'a', insideAirport: false }] })));
    const r = await simulateMapBudget('s-1', 120);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('refused');
  });

  test('no statement, no certified figure, no stop list, or not ok: refused', async () => {
    for (const body of [
      okBody({ simulation: { budgetMinutes: 120, certifiedUsableMinutes: 300 } }),
      okBody({ simulation: { budgetMinutes: 120, statement: 's' } }),
      okBody({ stops: null }),
      okBody({ ok: false }),
      null,
    ]) {
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(200, body));
      expect((await simulateMapBudget('s-1', 120)).ok).toBe(false);
    }
  });
});
