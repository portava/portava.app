/**
 * Admin console service (testing-mode WP-21).
 *
 * Covers the two things the admin screens rely on:
 *   - a failed or malformed read is `{ ok: false }` — never an empty list, so a
 *     screen cannot show "nothing to review" off a request that did not answer;
 *   - the form builders enforce the server's own schema before a request is
 *     made (routes/admin.ts promoteLiveScopeSchema, routes/airport.ts
 *     adminProfileSchema / cautionZoneSchema), including the rule that a
 *     zone-less live scope is SAID as null.
 *
 * A jest file rather than node:test: anything reaching src/lib/supabase.ts
 * cannot load under tsx (react-native esbuild "Unexpected typeof", see
 * scripts/run-node-tests.mjs KNOWN_BROKEN).
 *
 * Run with: pnpm test:component
 */
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

// NOTE: intentionally exhaustive — the real Supabase client pulls react-native
// native internals that crash under jest-expo.
jest.mock('../../lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: true }));
jest.mock('../apiToken', () => ({
  ...jest.requireActual('../apiToken'),
  freshToken: jest.fn(async () => 'tok'),
}));

const {
  buildAirportProfileBody,
  buildCautionZoneBody,
  buildPromoteBody,
  listGuideApplications,
  listPendingGems,
  listUserStamps,
  setGuideStatus,
  verifyGem,
} = require('../adminConsole.ts');

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
function respond(status: number, body: unknown) {
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
  });
}
const bodyOf = (i: number) => JSON.parse(String(calls[i].init.body));

beforeEach(() => { calls = []; });

describe('reads never turn a failure into an empty queue', () => {
  it('a 500 on the pending-gem queue is ok:false with the server message', async () => {
    respond(500, { error: 'db_error', message: 'A database error occurred. Please try again.' });
    await expect(listPendingGems()).resolves.toEqual({ ok: false, error: 'A database error occurred. Please try again.' });
  });

  it('a 200 without the queue array is ok:false, not []', async () => {
    respond(200, { something: 'else' });
    const r = await listPendingGems();
    expect(r.ok).toBe(false);
  });

  it('an empty queue that DID load is ok:true with []', async () => {
    respond(200, { queue: [] });
    await expect(listPendingGems()).resolves.toEqual({ ok: true, data: [] });
    expect(calls[0].url).toBe('http://api.test/api/admin/hidden-gems/pending');
  });

  it('guide applications: malformed is ok:false', async () => {
    respond(200, { applications: null });
    expect((await listGuideApplications()).ok).toBe(false);
  });

  it("a person's stamps come from the admin per-user route, and a refusal is ok:false", async () => {
    respond(200, { stamps: [{ id: 's1' }], total: 1 });
    await expect(listUserStamps('u-1')).resolves.toEqual({ ok: true, data: { stamps: [{ id: 's1' }], total: 1 } });
    expect(calls[0].url).toBe('http://api.test/api/admin/stamps/users/u-1/stamps');
    respond(403, { error: 'forbidden', message: 'Admin role required' });
    await expect(listUserStamps('u-1')).resolves.toEqual({ ok: false, error: 'Admin role required' });
  });
});

describe('writes carry exactly what the server contract names', () => {
  it('approve sends result=approved and a trimmed note', async () => {
    respond(200, { ok: true });
    await verifyGem('g1', 'approved', '  looks right ');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url).toBe('http://api.test/api/admin/hidden-gems/g1/verify');
    expect(bodyOf(0)).toEqual({ result: 'approved', notes: 'looks right' });
  });

  it('guide approval sets status=active on the admin route', async () => {
    respond(200, { ok: true });
    await setGuideStatus('u1', 'active');
    expect(calls[0].url).toBe('http://api.test/api/admin/local-guides/u1/status');
    expect(bodyOf(0)).toEqual({ status: 'active' });
  });

  it('a 404 from guide approval is ok:false (no profile is not an approval)', async () => {
    respond(404, { error: 'not_found', message: 'This user has no local guide profile' });
    await expect(setGuideStatus('u1', 'active')).resolves.toEqual({ ok: false, error: 'This user has no local guide profile' });
  });
});

describe('buildPromoteBody', () => {
  const now = new Date('2026-09-29T00:00:00.000Z');
  const base = { zoneId: '', claimType: 'crowd_level', horizonDays: 14, reasoning: 'test city, supervised', assessmentJson: '{"certifiable":false}' };

  it('an empty zone is the zone-less scope, sent as null', () => {
    expect(buildPromoteBody(base, now)).toEqual({
      ok: true,
      body: {
        zoneId: null,
        claimType: 'crowd_level',
        expiresAt: '2026-10-13T00:00:00.000Z',
        evidence: { assessment: { certifiable: false }, reasoning: 'test city, supervised' },
      },
    });
  });

  it('refuses a missing reason, a bad horizon and a non-object assessment', () => {
    expect(buildPromoteBody({ ...base, reasoning: ' ' }, now).ok).toBe(false);
    expect(buildPromoteBody({ ...base, horizonDays: 0 }, now).ok).toBe(false);
    expect(buildPromoteBody({ ...base, horizonDays: Number('x') }, now).ok).toBe(false);
    expect(buildPromoteBody({ ...base, assessmentJson: '[1]' }, now).ok).toBe(false);
    expect(buildPromoteBody({ ...base, assessmentJson: '{' }, now).ok).toBe(false);
    expect(buildPromoteBody({ ...base, claimType: '' }, now).ok).toBe(false);
  });
});

describe('airport form builders', () => {
  const f = { iataCode: 'lis', name: 'Lisbon', city: 'Lisbon', country: 'Portugal', countryCode: 'pt', timezone: '', lat: '38.77', lng: '-9.13', verified: true };

  it('upper-cases codes, parses coordinates, omits an empty timezone', () => {
    expect(buildAirportProfileBody(f)).toEqual({
      ok: true,
      body: { iataCode: 'LIS', name: 'Lisbon', city: 'Lisbon', country: 'Portugal', countryCode: 'PT', lat: 38.77, lng: -9.13, verified: true },
    });
  });

  it('refuses out-of-range or non-numeric coordinates and a bad code', () => {
    expect(buildAirportProfileBody({ ...f, lat: '91' }).ok).toBe(false);
    expect(buildAirportProfileBody({ ...f, lng: 'west' }).ok).toBe(false);
    expect(buildAirportProfileBody({ ...f, lat: '' }).ok).toBe(false);
    expect(buildAirportProfileBody({ ...f, iataCode: 'LISBON' }).ok).toBe(false);
  });

  it('caution zone: default radius 1000, integer 50..50000, needs an airport', () => {
    const z = { iataCode: 'LIS', name: 'Taxi rank', zoneType: 'caution_zone', centerLat: '38.77', centerLng: '-9.13', radiusMeters: '', note: '' };
    const r = buildCautionZoneBody(z);
    expect(r.ok).toBe(true);
    expect(r.body.radiusMeters).toBe(1000);
    expect(buildCautionZoneBody({ ...z, radiusMeters: '10' }).ok).toBe(false);
    expect(buildCautionZoneBody({ ...z, radiusMeters: '100.5' }).ok).toBe(false);
    expect(buildCautionZoneBody({ ...z, iataCode: '' }).ok).toBe(false);
  });
});
