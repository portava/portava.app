/**
 * census-layover L273 / L254 / L294 — `getLayoverBuddies`, against the bodies
 * `GET /api/airport/sessions/:id/buddies` actually sends.
 *
 * The route has published, for several census passes, WHY a list is short or
 * empty (`artifacts/api-server/src/routes/airport.ts`, the /buddies handler):
 *
 *   reason: "rent_buddy_not_enabled"     the marketplace is switched off
 *   reason: "safety_gate_not_passed"     the certified window says this
 *        + safetyGate {verdict, …}       traveller cannot go and meet anybody
 *   degraded + degradedReasons           "blocks_unreadable" (nobody served, by
 *                                        design) / "buddy_availability_unreadable"
 *   availableDuringLayover: null         availability was NOT measured
 *   503 degraded_unavailable             the profiles could not be read at all
 *
 * and this function returned `res.json()` typed as `{ city, buddies }` — every
 * one of those fields unnamed — or `null` for a 503, which the dashboard then
 * stored as `[]`. Census §23.8 recorded the client half as the open end of its
 * own fix: "If a client renders it with a truthiness test, `null` and `false`
 * look the same there and the disclosure stops at the API."
 *
 * This file is the parsing half and runs the real service module; only `fetch`
 * and the two auth modules beneath it are replaced.
 */
import { getLayoverBuddies } from '../../../services/layover.ts';

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

const BUDDY = {
  id: 'b-1', userId: 'u-9', displayName: 'Mai', tagline: null, city: 'Bangkok', country: 'Thailand',
  categories: ['city'], hourlyRateUsd: 20, averageRating: 4.8, reviewCount: 12, verified: true,
  coverPhotoUrl: null, buddyLevel: 'pro', availableNow: false, availableDuringLayover: null,
  layoverCompatible: true,
};

afterEach(() => { jest.restoreAllMocks(); });

test('1. an unmeasured availability arrives as NULL, not as false, and the degradation is carried', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {
    ok: true, city: 'Bangkok', buddies: [BUDDY],
    safetyGate: { passed: true, verdict: 'yes', usableMinutes: 240, returnState: 'NORMAL', engineVersion: 'x' },
    trustRequirement: { applied: false, reason: null, requires: [] },
    degraded: true, degradedReasons: ['buddy_availability_unreadable'],
  }));
  const res = await getLayoverBuddies('sess-1');
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('unreachable');
  expect(res.buddies).toHaveLength(1);
  expect(res.buddies[0].availableDuringLayover).toBeNull();
  expect(res.degraded).toBe(true);
  expect(res.degradedReasons).toEqual(['buddy_availability_unreadable']);
  expect(res.refusal).toBeNull();
});

test('2. the safety gate\'s refusal is carried with its verdict — it is not an empty city', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {
    ok: true, city: 'Bangkok', buddies: [], reason: 'safety_gate_not_passed',
    safetyGate: { passed: false, verdict: 'no', usableMinutes: 20, returnState: 'NORMAL', engineVersion: 'x' },
  }));
  const res = await getLayoverBuddies('sess-1');
  if (!res.ok) throw new Error('unreachable');
  expect(res.refusal).toBe('safety_gate_not_passed');
  expect(res.safetyGate?.verdict).toBe('no');
  expect(res.degraded).toBe(false);
});

test('3. the marketplace switched off is its own answer', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {
    ok: true, city: 'Bangkok', buddies: [], reason: 'rent_buddy_not_enabled',
  }));
  const res = await getLayoverBuddies('sess-1');
  if (!res.ok) throw new Error('unreachable');
  expect(res.refusal).toBe('rent_buddy_not_enabled');
  expect(res.buddies).toEqual([]);
});

test('4. a 503 is a FAILED READ with the server\'s sentence — never an empty list', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(503, {
    error: 'degraded_unavailable', message: 'Local buddies could not be loaded. Please try again.', retryable: true,
  }));
  const res = await getLayoverBuddies('sess-1');
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('unreachable');
  expect(res.message).toBe('Local buddies could not be loaded. Please try again.');
});

test('5. a rejected fetch RESOLVES as a failed read — it does not throw into the dashboard', async () => {
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
  const res = await getLayoverBuddies('sess-1');
  expect(res.ok).toBe(false);
});

test('6. CONTROL: a measured list with measured availability is served as it came', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {
    ok: true, city: 'Bangkok', buddies: [{ ...BUDDY, availableDuringLayover: true }],
    safetyGate: { passed: true, verdict: 'yes', usableMinutes: 240, returnState: 'NORMAL', engineVersion: 'x' },
    trustRequirement: { applied: false, reason: null, requires: [] },
    degraded: false, degradedReasons: [],
  }));
  const res = await getLayoverBuddies('sess-1');
  if (!res.ok) throw new Error('unreachable');
  expect(res.buddies[0].availableDuringLayover).toBe(true);
  expect(res.degraded).toBe(false);
  expect(res.refusal).toBeNull();
});

test('7. a 2xx whose envelope says ok:false is a refusal, not a list — same contract as the overview read', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {
    ok: false, message: 'Local buddies could not be loaded. Please try again.',
  }));
  const res = await getLayoverBuddies('sess-1');
  expect(res.ok).toBe(false);
});
