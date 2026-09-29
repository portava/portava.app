/**
 * census-discovery §107 (DV-83 round 10, D-W11X2-68) — the Telegraph card reader names the
 * route's refusal. GET /compass/telegraph now answers a failed read with the Discovery refusal
 * envelope beside `{ cards, city }`: `nothing` for a failed build, profile, context or flag read,
 * `partial` beside the cards when one card source failed. Before §107 the reader passed
 * `body.cards` on as a complete answer, and the chip's availability check hid an unread flag
 * table exactly like the flag being off.
 *
 *   TS1  refused `nothing` → ok:false, refused, with the refusal's code
 *   TS2  refused `partial` beside cards → ok:true, the cards, partial:true
 *   TS3  a refusal with a missing or unknown coverage → ok:false (never a complete list)
 *   TS4  the chip's availability: a refusal (the flag table unread) keeps the chip; it is not "off"
 *   TSc  CONTROL: a healthy answer is unchanged; a READ-and-off flag (404 feature_disabled) hides the chip
 *
 * THE SERVICE IS REAL (services/compass.ts imports react-native, so this runs under jest).
 */
// NOTE: a stand-in on purpose — the reader needs a configured client and nothing else from the module.
jest.mock('../../lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — the reader needs a configured client and nothing else from the module.
jest.mock('../../lib/supabase.ts', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — only freshToken is read, and the test fixes its value.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));
// NOTE: a stand-in on purpose — only freshToken is read, and the test fixes its value.
jest.mock('../apiToken', () => ({ freshToken: async () => 'tok-1' }));

import { fetchCompassTelegraphCards, checkCompassTelegraphAvailable } from '../compass.ts';

let answer: unknown = {};
let status = 200;
const realFetch = global.fetch;
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => {
  status = 200;
  global.fetch = jest.fn(async () => new Response(JSON.stringify(answer), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
});

const CARD = { id: 'ev-1', type: 'event', title: 'Jazz night', city: 'Paris', category: 'music', description: null, imageUrl: null };
const refusal = (coverage: unknown, code = 'telegraph_sources_unread') => ({ class: 'transient_db', code, route: 'GET /compass/telegraph', coverage, failedSources: ['events'] });

describe('§107 the Telegraph card reader names the route\'s refusal', () => {
  it('TS1 refused `nothing` → ok:false, refused, with its code', async () => {
    answer = { cards: [], city: null, refusal: refusal('nothing', 'telegraph_build_failed') };
    expect(await fetchCompassTelegraphCards('t-1')).toEqual({ ok: false, refused: true, error: 'telegraph_build_failed' });
  });

  it('TS2 refused `partial` beside cards → ok:true, the cards, partial:true', async () => {
    answer = { cards: [CARD], city: 'Paris', refusal: refusal('partial') };
    expect(await fetchCompassTelegraphCards('t-1')).toEqual({ ok: true, cards: [CARD], city: 'Paris', partial: true });
  });

  it('TS3 a refusal with a missing or unknown coverage → ok:false, never a complete list', async () => {
    answer = { cards: [CARD], city: 'Paris', refusal: { class: 'transient_db', code: 'x' } };
    expect((await fetchCompassTelegraphCards('t-1')).ok).toBe(false);
    answer = { cards: [CARD], city: 'Paris', refusal: refusal('some_future_value') };
    expect((await fetchCompassTelegraphCards('t-1')).ok).toBe(false);
  });

  it('TS4 an unread flag table (a refusal) keeps the chip — it is not "Compass Telegraph is off"', async () => {
    answer = { cards: [], city: null, refusal: refusal('nothing', 'compass_flags_unreadable') };
    expect(await checkCompassTelegraphAvailable('t-1')).toBe(true);
  });

  it('TSc CONTROL: a healthy answer is unchanged; a READ-and-off flag hides the chip', async () => {
    answer = { cards: [CARD], city: 'Paris' };
    expect(await fetchCompassTelegraphCards('t-1')).toEqual({ ok: true, cards: [CARD], city: 'Paris' });
    status = 404;
    answer = { error: 'feature_disabled', message: 'compass_telegraph feature is not enabled' };
    expect(await fetchCompassTelegraphCards('t-1')).toEqual({ ok: true, cards: [], flagDisabled: true });
    expect(await checkCompassTelegraphAvailable('t-1')).toBe(false);
  });
});
