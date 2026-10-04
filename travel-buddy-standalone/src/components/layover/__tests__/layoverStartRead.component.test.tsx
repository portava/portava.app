/**
 * census-layover L294 (C2) / L267 — starting a layover: the two reads the
 * creation sheet makes, against the bodies the server actually sends.
 *
 * `POST /api/airport/sessions` refuses with a sentence written for a traveller
 * (`artifacts/api-server/src/routes/airport.ts`, the create handler):
 *
 *   400 invalid_payload       "This layover has already departed — set a
 *                             departure time in the future", "A layover window
 *                             cannot exceed 48 hours", "Boarding time must fall
 *                             between arrival and departure", …
 *   403 feature_disabled      "Airport / Layover Mode is not yet enabled"
 *   503 degraded_unavailable  "Airport details could not be loaded. Please try again."
 *
 * `createLayoverSession` threw `Failed to create layover session: <status>`
 * for all of them — the code and the sentence both discarded — and the sheet
 * then matched that string against `feature_disabled`, which it can never
 * contain. Every refusal read "Could not start your layover. Please try
 * again.", including the ones a retry cannot fix: a tester who picked a
 * departure time that had already passed was told to try again, forever.
 *
 * `GET /api/airport/search` answers `featureEnabled: false` when the mode is
 * off and refuses on a bad query; `searchAirports` returned `[]` for those, for
 * a 5xx and for an offline device — so a failed search read as "no airport
 * matches", on the first screen of the feature.
 *
 * Only `fetch` and the two auth modules beneath it are replaced.
 */
import { createLayoverSession, searchAirports } from '../../../services/layover.ts';

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

const PAYLOAD = { arrivalLocal: '2026-10-04T10:00', departureLocal: '2026-10-04T16:00', iata: 'TPE' };

afterEach(() => { jest.restoreAllMocks(); });

describe('createLayoverSession — the refusal keeps its code and its sentence', () => {
  test('1. a 400 keeps the server\'s sentence and is NOT retryable', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(400, {
      error: 'invalid_payload', message: 'This layover has already departed — set a departure time in the future',
    }));
    const r = await createLayoverSession(PAYLOAD);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('invalid_payload');
    expect(r.message).toBe('This layover has already departed — set a departure time in the future');
    expect(r.retryable).toBe(false);
  });

  test('2. feature_disabled is reported AS feature_disabled', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(403, {
      error: 'feature_disabled', message: 'Airport / Layover Mode is not yet enabled',
    }));
    const r = await createLayoverSession(PAYLOAD);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('feature_disabled');
  });

  test('3. a 503 is retryable, by the server\'s own flag', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(503, {
      error: 'degraded_unavailable', message: 'Airport details could not be loaded. Please try again.', retryable: true,
    }));
    const r = await createLayoverSession(PAYLOAD);
    if (r.ok) throw new Error('unreachable');
    expect(r.retryable).toBe(true);
    expect(r.message).toBe('Airport details could not be loaded. Please try again.');
  });

  test('4. an offline device RESOLVES with a retryable refusal — it does not throw', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
    const r = await createLayoverSession(PAYLOAD);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.retryable).toBe(true);
    expect(r.code).toBeNull();
  });

  test('5b. a 2xx that carries no session (a captive-portal page, a proxy) is a refusal, not a crash', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); },
    } as unknown as Response);
    const r = await createLayoverSession(PAYLOAD);
    expect(r.ok).toBe(false);
  });

  test('5. CONTROL: a 201 is the session', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(201, {
      ok: true, session: { id: 'sess-9' }, safeReturnSuggested: false, safeReturnReasons: [],
    }));
    const r = await createLayoverSession(PAYLOAD);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.session.id).toBe('sess-9');
  });
});

describe('searchAirports — a failed search is not "no airport matches"', () => {
  test('6. a 5xx is a FAILED search, with the server\'s sentence when it wrote one', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(500, { error: 'internal', message: 'Something went wrong' }));
    const r = await searchAirports('TPE');
    expect(r.ok).toBe(false);
  });

  test('7. an offline device is a FAILED search, and it resolves', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
    const r = await searchAirports('TPE');
    expect(r.ok).toBe(false);
  });

  test('8. the mode switched off is said, not served as an empty list', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { airports: [], featureEnabled: false }));
    const r = await searchAirports('TPE');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.featureEnabled).toBe(false);
  });

  test('9. CONTROL: a measured zero is ok:true with no airports, and the mode on', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { airports: [], featureEnabled: true, degraded: false, degradedReasons: [] }));
    const r = await searchAirports('ZZQ');
    if (!r.ok) throw new Error('unreachable');
    expect(r.airports).toEqual([]);
    expect(r.featureEnabled).toBe(true);
  });

  test('10. CONTROL: matches are served as they came', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {
      airports: [{ id: null, iataCode: 'TPE', name: 'Taoyuan', city: 'Taoyuan', country: 'Taiwan' }],
      featureEnabled: true, degraded: false, degradedReasons: [],
    }));
    const r = await searchAirports('TPE');
    if (!r.ok) throw new Error('unreachable');
    expect(r.airports.map((a) => a.iataCode)).toEqual(['TPE']);
  });
});
