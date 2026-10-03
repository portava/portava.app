/**
 * census-discovery §115 (DV-83 round 18, lane W11-X2; sweep SW6): the NOW map's rollback friends layer never draws a
 * failed circle-locations read as "no friends here".
 *
 * `listVisibleCircleLocations` is read only by useMapEntities' rollback path (`fetchFriends`), whose `attempt()` turns
 * a rejected fetcher into an unread layer ("Couldn't load friends here"). The service answered every failure — a 5xx,
 * a network throw, a missing token, a body with no list — with `[]`, which the map drew as a whole, empty friends layer.
 * It now rejects over each; a healthy answer (including a genuinely empty circle) is unchanged.
 *
 *   CL1  a 5xx → rejects          CL2  a network throw → rejects
 *   CL3  no token → rejects       CL4  a 200 with no `locations` array → rejects
 *   CL0  CONTROL: a 200 with `locations: []` → [] (a whole, empty circle); with one member → that member
 */
import { listVisibleCircleLocations } from '../map.ts';

const mockToken = jest.fn<Promise<string | null>, []>(async () => 'test-token');
jest.mock('../apiToken', () => ({
  ...jest.requireActual('../apiToken'),
  freshToken: () => mockToken(),
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
    return { ok: outcome.status >= 200 && outcome.status < 300, status: outcome.status, json: async () => outcome.body ?? {} };
  };
}
afterEach(() => { (globalThis as unknown as { fetch: unknown }).fetch = realFetch; mockToken.mockImplementation(async () => 'test-token'); });

const MEMBER = { userId: 'u1', name: null, avatarUrl: null, lat: 16.05, lng: 108.2, city: 'Da Nang', country: 'VN', updatedAt: '2026-09-30T12:00:00.000Z' };

describe('census-discovery §115 (SW6): a failed circle-locations read is never an empty circle', () => {
  it('CL0 CONTROL: a whole answer — empty, or one member — is returned as it is', async () => {
    stubFetch({ status: 200, body: { ok: true, locations: [] } });
    await expect(listVisibleCircleLocations()).resolves.toEqual([]);
    stubFetch({ status: 200, body: { ok: true, locations: [MEMBER] } });
    await expect(listVisibleCircleLocations()).resolves.toEqual([MEMBER]);
  });
  it('CL1 a 5xx rejects', async () => {
    stubFetch({ status: 500, body: { error: 'db_error' } });
    await expect(listVisibleCircleLocations()).rejects.toThrow();
  });
  it('CL2 a network throw rejects', async () => {
    stubFetch('throw');
    await expect(listVisibleCircleLocations()).rejects.toThrow();
  });
  it('CL3 no token rejects', async () => {
    mockToken.mockImplementation(async () => null);
    stubFetch({ status: 200, body: { ok: true, locations: [MEMBER] } });
    await expect(listVisibleCircleLocations()).rejects.toThrow();
  });
  it('CL4 a 200 with no locations array rejects', async () => {
    stubFetch({ status: 200, body: { ok: true } });
    await expect(listVisibleCircleLocations()).rejects.toThrow();
  });
});
