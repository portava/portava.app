/**
 * census-discovery §108 (DV-83 round 11, D-W11X2-80). §108.1 BK4: the Ask Compass chip's availability
 * check (`checkCompassTelegraphAvailable`) kept the chip on a refusal (D-W11X2-68), but a transport
 * failure — an HTTP 5xx or a network error — still answered `false`, which app/messages/[id].tsx
 * renders exactly like COMPASS_TELEGRAPH being READ and off: the chip was hidden for the thread, and
 * the tray's failed state could never say the failure. Only the flag read off, a non-member (403) and
 * an unconfigured client hide it now.
 *
 * V10-* cases are the round-10 verifier's probes (scratchpad v10-probes/zz-v10-compassTelegraphChip),
 * copied in unchanged apart from this header.
 *
 *   V10-CH0  CONTROL: a READ-and-off flag (404 feature_disabled) hides the chip
 *   V10-CH1  HTTP 503 → the chip is not hidden as "off"
 *   V10-CH2  a network error → the chip is not hidden as "off"
 *   CH3      CONTROL: a 403 (not a member of the thread) hides the chip; a healthy answer keeps it
 *   CH4      a 200 refusal whose code reads 'forbidden' is still a refusal (a failed read), never "not a member"
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

import { checkCompassTelegraphAvailable } from '../compass.ts';

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

describe('§108 the Ask Compass chip over a transport failure', () => {
  it('V10-CH0 CONTROL: READ-and-off hides the chip', async () => {
    status = 404; answer = { error: 'feature_disabled', message: 'off' };
    expect(await checkCompassTelegraphAvailable('t-1')).toBe(false);
  });
  it('V10-CH1 HTTP 503 → the chip must not be hidden as "off"', async () => {
    status = 503; answer = { error: 'upstream' };
    expect(await checkCompassTelegraphAvailable('t-1')).toBe(true);
  });
  it('V10-CH2 a network error → the chip must not be hidden as "off"', async () => {
    global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); }) as unknown as typeof fetch;
    expect(await checkCompassTelegraphAvailable('t-1')).toBe(true);
  });
  it('CH3 CONTROL: a 403 (not a member) hides the chip; a healthy answer keeps it', async () => {
    status = 403; answer = { error: 'forbidden', message: 'Not a member of this thread' };
    expect(await checkCompassTelegraphAvailable('t-1')).toBe(false);
    status = 200; answer = { cards: [CARD], city: 'Paris' };
    expect(await checkCompassTelegraphAvailable('t-1')).toBe(true);
  });
  it('CH4 a 200 refusal whose code reads "forbidden" is still a refusal — the chip stays', async () => {
    answer = { cards: [], city: null, refusal: { class: 'transient_db', code: 'forbidden', route: 'GET /compass/telegraph', coverage: 'nothing', failedSources: ['message_thread_members'] } };
    expect(await checkCompassTelegraphAvailable('t-1')).toBe(true);
  });
});
