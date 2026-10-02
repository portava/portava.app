/**
 * getMyLocationPrivacy — an unreadable answer is `null`, not "City only".
 *
 * Runs under jest (`pnpm test:component`) because map.ts reaches ../lib/supabase,
 * which node's tsx transform cannot load — the same reason
 * location.gps.component.test.ts lives here.
 *
 * ## The defect
 *
 * Every failure path returned LOCATION_PRIVACY_FALLBACK: `{ locationMode:
 * 'city_only', safeReturnEnabled: true, hotelBlurEnabled: true, ... }`. Its only
 * caller is app/profile/edit/location.tsx, the Location & Availability privacy
 * screen, which rendered those values as the user's live settings — so a user
 * whose sharing is actually **Off** read "City only — Only your city is used".
 *
 * ## What's covered
 *
 * Unreadable (401 / 500 / network throw) → `null`; readable → the server's real
 * answer, including the values that happen to equal the old fallback, so the fix
 * cannot blank a working screen.
 */

import { getMyLocationPrivacy } from '../map.ts';

// ── auth token — present, so the tests exercise the HTTP paths ───────────────

jest.mock('../apiToken', () => ({
  ...jest.requireActual('../apiToken'),
  freshToken: jest.fn(async () => 'test-token'),
}));

// The service short-circuits on an unconfigured Supabase; keep it configured.
jest.mock('../../lib/supabase', () => ({
  ...jest.requireActual('../../lib/supabase'),
  isSupabaseConfigured: true,
}));

const realFetch = globalThis.fetch;

function stubFetch(outcome: { status: number; body?: unknown } | 'throw') {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    if (outcome === 'throw') throw new Error('network down');
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      json: async () => outcome.body ?? {},
    };
  };
}

afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  jest.clearAllMocks();
});

describe('getMyLocationPrivacy', () => {
  it('returns null on a 500 rather than asserting "city_only"', async () => {
    stubFetch({ status: 500, body: { error: 'boom' } });
    expect(await getMyLocationPrivacy()).toBeNull();
  });

  it('returns null on a 401', async () => {
    stubFetch({ status: 401, body: { error: 'unauthorized' } });
    expect(await getMyLocationPrivacy()).toBeNull();
  });

  it('returns null when the network throws', async () => {
    stubFetch('throw');
    expect(await getMyLocationPrivacy()).toBeNull();
  });

  it('still returns the real settings when the read succeeds', async () => {
    stubFetch({
      status: 200,
      body: {
        locationMode: 'off',
        sharingPaused: true,
        pulseVisibility: 'no_location',
        discoveryVisibility: null,
        safeReturnEnabled: false,
        trustedCircleShare: true,
        hotelBlurEnabled: false,
      },
    });

    const prefs = await getMyLocationPrivacy();
    expect(prefs).not.toBeNull();
    expect(prefs!.locationMode).toBe('off');
    expect(prefs!.sharingPaused).toBe(true);
    expect(prefs!.safeReturnEnabled).toBe(false);
    expect(prefs!.trustedCircleShare).toBe(true);
    expect(prefs!.hotelBlurEnabled).toBe(false);
  });

  it('fills only the fields a SUCCESSFUL response omitted', async () => {
    stubFetch({ status: 200, body: {} });

    const prefs = await getMyLocationPrivacy();
    expect(prefs).not.toBeNull();
    expect(prefs!.locationMode).toBe('city_only');
    expect(prefs!.hotelBlurEnabled).toBe(true);
  });
});
