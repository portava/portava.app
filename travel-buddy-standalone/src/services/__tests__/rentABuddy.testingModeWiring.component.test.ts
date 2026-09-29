/**
 * Rent a Buddy — the service calls the testing-mode screens depend on (lane tm-rab).
 *
 *   S1  A refusal keeps the server's `gate`. `apiFetch` kept only the code, so
 *       `feature_disabled` from the master switch and from a kill switch were
 *       indistinguishable to every screen.
 *   S2  `submitCheckIn` sent `{ status, broadArea }` to a route that reads
 *       `{ checkinType, response }` — every call was a 400. It now sends the
 *       server's own field names and check-in vocabulary.
 *   S3  The admin reads the new screens use are failure-honest: a failed read is
 *       `ok: false`, never an empty array (they used to return `[]`).
 *   S4  `createLaunchControl` / `updateLaunchControl` sent snake_case keys the
 *       route never reads (it destructures camelCase), so every field silently
 *       fell back to the route's defaults. They now send the route's keys.
 *   S5  The new calls hit the routes they claim to: the change-request read and
 *       answer, the buddy's own sessions, review moderation.
 *
 * Run: pnpm --dir travel-buddy-standalone test:component (jest — rentABuddy.ts
 * imports apiToken → supabase → react-native, which node:test cannot load;
 * see KNOWN_BROKEN in scripts/run-node-tests.mjs).
 */
// NOTE: exhaustive by design — only freshToken is read by the services under
// test; the real apiToken pulls in the Supabase session client.
jest.mock('../apiToken.ts', () => ({ freshToken: jest.fn().mockResolvedValue('tok') }));

import {
  startBooking,
  submitCheckIn,
  getBookingChangeRequests,
  respondToChangeRequest,
  listMyBuddySessions,
} from '../rentABuddy.ts';
import {
  getAdminSupportReports,
  getAdminRiskReview,
  getLaunchControls,
  createLaunchControl,
  updateLaunchControl,
  listAdminReviews,
  approveReview,
  rejectReview,
} from '../rentABuddyAdmin.ts';

// Small assert-style shims over jest's expect, so each check reads as one line.
function eq(actual: unknown, expected: unknown, _msg?: string) { expect(actual).toBe(expected); }
function deep(actual: unknown, expected: unknown) { expect(actual).toEqual(expected); }
function match(actual: string, re: RegExp) { expect(actual).toMatch(re); }

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let respond: (url: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
const realFetch = global.fetch;

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  global.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    const r = respond(url);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      json: async () => r.body,
    };
  }) as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  respond = () => ({ status: 200, body: {} });
});

describe('S1 a refusal keeps the gate', () => {
  it('feature_disabled + gate reaches the caller', async () => {
    respond = () => ({ status: 404, body: { error: 'feature_disabled', gate: 'disable_rab_bookings', message: 'x' } });
    const r = await startBooking('b1');
    eq(r.ok, false);
    if (r.ok) return;
    eq(r.error, 'feature_disabled');
    eq(r.gate, 'disable_rab_bookings');
  });

  it('a refusal without a gate has none', async () => {
    respond = () => ({ status: 409, body: { error: 'invalid_transition' } });
    const r = await startBooking('b1');
    eq(r.ok, false);
    if (r.ok) return;
    eq(r.gate, undefined);
  });
});

describe('S2 submitCheckIn speaks the route\'s vocabulary', () => {
  it('posts checkinType/response to the canonical check-in route', async () => {
    respond = () => ({ status: 201, body: { checkin: { id: 'c1' } } });
    const r = await submitCheckIn('b1', 'arrival', 'Rossio square');
    eq(r.ok, true);
    eq(calls.length, 1);
    match(calls[0].url, /\/api\/rent-a-buddy\/bookings\/b1\/check-in$/);
    eq(calls[0].method, 'POST');
    deep(calls[0].body, { checkinType: 'arrival', response: 'Rossio square' });
  });
});

describe('S3 admin reads are failure-honest', () => {
  const reads: Array<[string, () => Promise<{ ok: boolean }>]> = [
    ['support reports', () => getAdminSupportReports('open')],
    ['risk review', () => getAdminRiskReview('watch')],
    ['launch controls', () => getLaunchControls()],
    ['review moderation', () => listAdminReviews('pending_moderation')],
  ];
  for (const [label, read] of reads) {
    it(`${label}: a 500 is ok:false, not an empty list`, async () => {
      respond = () => ({ status: 500, body: { error: 'db_error', message: 'boom' } });
      const r = await read();
      eq(r.ok, false, label);
    });
  }

  it('launch controls: rows come through', async () => {
    respond = () => ({ status: 200, body: { controls: [{ id: 'lc1', city: 'Lisbon' }] } });
    const r = await getLaunchControls();
    eq(r.ok, true);
    if (r.ok) eq(r.data.length, 1);
  });
});

describe('S4 launch-control writes send the route\'s keys', () => {
  it('create sends camelCase', async () => {
    respond = () => ({ status: 201, body: { control: { id: 'lc1' }, ok: true } });
    await createLaunchControl({
      countryCode: 'PT', city: 'Lisbon', category: null, enabled: true, waitlistOnly: false,
      minAge: 18, nightlifeMinAge: 21, requireIdVerification: true, requirePhoneVerification: false,
      notes: 'testing',
    });
    deep(calls[0].body, {
      countryCode: 'PT', city: 'Lisbon', category: null, enabled: true, waitlistOnly: false,
      minAge: 18, nightlifeMinAge: 21, requireIdVerification: true, requirePhoneVerification: false,
      notes: 'testing',
    });
    eq(calls[0].method, 'POST');
  });

  it('update sends camelCase to the control', async () => {
    respond = () => ({ status: 200, body: { ok: true } });
    const r = await updateLaunchControl('lc1', { enabled: false, requireIdVerification: true });
    eq(r.ok, true);
    match(calls[0].url, /\/admin\/launch-controls\/lc1$/);
    eq(calls[0].method, 'PATCH');
    deep(calls[0].body, { enabled: false, requireIdVerification: true });
  });

  it('a failed update is reported', async () => {
    respond = () => ({ status: 500, body: { error: 'db_error', message: 'boom' } });
    const r = await updateLaunchControl('lc1', { enabled: true });
    eq(r.ok, false);
  });
});

describe('S5 new calls hit their routes', () => {
  it('change requests: read', async () => {
    respond = () => ({ status: 200, body: { bookingStatus: 'requested', changeRequests: [] } });
    const r = await getBookingChangeRequests('b1');
    eq(r.ok, true);
    match(calls[0].url, /\/api\/rent-a-buddy\/bookings\/b1\/change-requests$/);
  });

  it('change requests: answer', async () => {
    respond = () => ({ status: 200, body: { ok: true } });
    await respondToChangeRequest('b1', 'cr1', 'accept');
    match(calls[0].url, /\/api\/rent-a-buddy\/bookings\/b1\/respond-change-request$/);
    deep(calls[0].body, { changeRequestId: 'cr1', decision: 'accept' });
  });

  it('buddy sessions: one read per active status, mapped from snake_case', async () => {
    respond = (url) => ({
      status: 200,
      body: url.includes('status=in_progress')
        ? { requests: [{ id: 'b9', buddy_id: 'bp', traveler_id: 't', booking_date: '2026-10-10', start_time: '10:00', duration_h: 2, group_size: 1, city: 'Lisbon', category: 'city', status: 'in_progress', total_usd: 60 }] }
        : { requests: [] },
    });
    const r = await listMyBuddySessions();
    eq(r.ok, true);
    const statuses = calls.map((c) => new URL(c.url).searchParams.get('status')).sort();
    deep(statuses, ['completed_pending_traveler_confirmation', 'confirmed', 'in_progress', 'scheduled']);
    if (r.ok) {
      eq(r.data.length, 1);
      eq(r.data[0].id, 'b9');
      eq(r.data[0].bookingDate, '2026-10-10');
      eq(r.data[0].status, 'in_progress');
    }
  });

  it('buddy sessions: one failed status read fails the whole list (never a partial list shown as complete)', async () => {
    respond = (url) => url.includes('status=scheduled')
      ? { status: 500, body: { error: 'db_error' } }
      : { status: 200, body: { requests: [] } };
    const r = await listMyBuddySessions();
    eq(r.ok, false);
  });

  it('review moderation: approve and reject', async () => {
    respond = () => ({ status: 200, body: { ok: true } });
    await approveReview('rv1');
    await rejectReview('rv2', 'spam');
    match(calls[0].url, /\/admin\/reviews\/rv1\/approve$/);
    match(calls[1].url, /\/admin\/reviews\/rv2\/reject$/);
    deep(calls[1].body, { reason: 'spam' });
  });
});
