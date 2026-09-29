/**
 * census-discovery §104 (DV-83, D-W11X2-55) — the Compass match readers name the
 * route's refusal. GET /compass/recommendations' buddy and traveler arms answer a
 * failed read with the refusal envelope (or, on an older server, `error:
 * "block_check_failed"`); the readers turn a `nothing` refusal and that marker into
 * `ok: false`, and a `partial` one into `partial: true` beside its rows.
 *
 *   M1  traveler: refused `nothing` → ok:false, with the refusal's code
 *   M2  traveler: an older server's `error` marker → ok:false
 *   M3  traveler: partial → ok:true, the rows, partial:true
 *   M4  buddy: refused `nothing` → ok:false; partial → partial:true
 *   Mc  CONTROL: a healthy answer and the viewer's own `disabled` answer are unchanged
 *
 * THE SERVICE IS REAL (services/compass.ts imports react-native, so this runs under
 * jest). Only `fetch`, the configured client and the token are stood in.
 */
// NOTE: a stand-in on purpose — the readers need a configured client and nothing else from the module.
jest.mock('../../lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — the readers need a configured client and nothing else from the module.
jest.mock('../../lib/supabase.ts', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — only freshToken is read, and the test fixes its value.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));
// NOTE: a stand-in on purpose — only freshToken is read, and the test fixes its value.
jest.mock('../apiToken', () => ({ freshToken: async () => 'tok-1' }));

import { fetchCompassTravelerMatches, fetchCompassBuddyMatches } from '../compass.ts';

let answer: unknown = {};
const realFetch = global.fetch;
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => {
  global.fetch = jest.fn(async () => new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
});

const ROW = { id: 'u-2', type: 'traveler', category: 'traveler', title: 'Ana', reason: 'r', city: 'Paris', data: {} };
const nothing = (code: string) => ({ class: 'transient_db', code, coverage: 'nothing', failedSources: ['blocks'] });
const partial = { class: 'transient_db', code: 'compass_sources_unread', coverage: 'partial', failedSources: ['profile_privacy_settings'] };

describe('§104 the Compass match readers name the route\'s refusal', () => {
  it('M1 traveler: refused `nothing` → ok:false with its code', async () => {
    answer = { recommendations: [], surface: 'traveler', refusal: nothing('traveler_read_failed') };
    expect(await fetchCompassTravelerMatches({ city: 'Paris' })).toEqual({ ok: false, error: 'traveler_read_failed' });
  });

  it('M2 traveler: an older server\'s `error` marker → ok:false', async () => {
    answer = { recommendations: [], surface: 'traveler', error: 'block_check_failed' };
    expect(await fetchCompassTravelerMatches({ city: 'Paris' })).toEqual({ ok: false, error: 'block_check_failed' });
  });

  it('M3 traveler: partial → the rows, marked partial', async () => {
    answer = { recommendations: [ROW], surface: 'traveler', refusal: partial };
    expect(await fetchCompassTravelerMatches({ city: 'Paris' })).toEqual({ ok: true, data: [ROW], partial: true });
  });

  it('M4 buddy: refused `nothing` → ok:false; partial → partial:true', async () => {
    answer = { recommendations: [], surface: 'buddy', error: 'block_check_failed', refusal: nothing('block_check_failed') };
    expect(await fetchCompassBuddyMatches({ city: 'Paris' })).toEqual({ ok: false, error: 'block_check_failed' });
    answer = { recommendations: [{ ...ROW, type: 'buddy' }], surface: 'buddy', refusal: partial };
    expect(await fetchCompassBuddyMatches({ city: 'Paris' })).toEqual({ ok: true, data: [{ ...ROW, type: 'buddy' }], partial: true });
  });

  it('Mc CONTROL: a healthy answer and the viewer\'s own `disabled` answer are unchanged', async () => {
    answer = { recommendations: [ROW], surface: 'traveler' };
    expect(await fetchCompassTravelerMatches({ city: 'Paris' })).toEqual({ ok: true, data: [ROW] });
    answer = { recommendations: [], surface: 'traveler', disabled: true };
    expect(await fetchCompassTravelerMatches({ city: 'Paris' })).toEqual({ ok: true, data: [], disabled: true });
    answer = { recommendations: [], surface: 'buddy' };
    expect(await fetchCompassBuddyMatches({ city: 'Paris' })).toEqual({ ok: true, data: [] });
  });
});
