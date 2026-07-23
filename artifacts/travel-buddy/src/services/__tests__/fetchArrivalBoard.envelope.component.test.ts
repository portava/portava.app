/**
 * Service-level contract test for fetchArrivalBoard.
 *
 * Validates that the raw API envelope { tripId, destination, board: [...], note }
 * is correctly mapped to { arrivals: [...], note } before the caller sees it.
 * This class of bug is invisible to component tests that mock the service function
 * directly — this test catches the real client↔API contract.
 *
 * Run: pnpm test (Jest)
 */

// NOTE: exhaustive by design — this test only needs freshToken from apiToken;
// spreading requireActual would pull in the real Supabase session logic which
// requires network access and breaks in CI without credentials.
jest.mock('../apiToken.ts', () => ({ freshToken: jest.fn().mockResolvedValue('test-token') }));
// NOTE: exhaustive by design — only isSupabaseConfigured is read by tripIntel's
// guard; the real module initialises a Supabase client on import which fails
// without env vars in the test environment.
jest.mock('../../lib/supabase.ts', () => ({ isSupabaseConfigured: true }));

import { fetchArrivalBoard } from '../tripIntel.ts';

const TRIP_ID = 'trip-envelope-test';

// ── helpers ──────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, ok = true) {
  (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({
    ok,
    json: jest.fn().mockResolvedValue(body),
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchArrivalBoard — API envelope unwrapping', () => {
  test('maps board[] from envelope to arrivals[] in the return value', async () => {
    const rawEnvelope = {
      tripId:      TRIP_ID,
      destination: 'Tokyo, Japan',
      board: [
        { userId: 'u-1', arrival: { time: '2026-09-01T10:00:00Z', label: 'Alice' } },
        { userId: 'u-2', arrival: null },
      ],
      note: 'Arrival times are estimates.',
    };
    mockFetch(rawEnvelope);

    const result = await fetchArrivalBoard(TRIP_ID);

    expect(result).not.toBeNull();
    expect(Array.isArray(result!.arrivals)).toBe(true);
    expect(result!.arrivals).toHaveLength(2);
    expect(result!.arrivals[0].userId).toBe('u-1');
    expect(result!.arrivals[0].arrival?.label).toBe('Alice');
    expect(result!.arrivals[1].arrival).toBeNull();
    expect(result!.note).toBe('Arrival times are estimates.');
    // Must NOT expose raw envelope keys on the result
    expect((result as Record<string, unknown>).board).toBeUndefined();
    expect((result as Record<string, unknown>).tripId).toBeUndefined();
  });

  test('returns { arrivals: [], note } when board is an empty array', async () => {
    mockFetch({ tripId: TRIP_ID, destination: 'Paris', board: [], note: null });

    const result = await fetchArrivalBoard(TRIP_ID);

    expect(result).not.toBeNull();
    expect(result!.arrivals).toHaveLength(0);
  });

  test('returns null when the API responds with a non-ok status', async () => {
    mockFetch({}, false);

    const result = await fetchArrivalBoard(TRIP_ID);

    expect(result).toBeNull();
  });

  test('returns null when fetch throws (network error)', async () => {
    (global.fetch as jest.Mock) = jest.fn().mockRejectedValue(new Error('network down'));

    const result = await fetchArrivalBoard(TRIP_ID);

    expect(result).toBeNull();
  });
});
