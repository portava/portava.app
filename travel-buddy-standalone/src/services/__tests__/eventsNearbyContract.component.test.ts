/**
 * Events "near me" reads go to the route that reads a location, and the
 * Events tab stops offering filters the server never applied.
 *
 * THE DEFECTS.
 *   1. `listEvents({ nearLat, nearLng, nearRadiusKm })` appended those three to
 *      GET /api/events — whose handler (artifacts/api-server/src/routes/events.ts)
 *      reads state, city, category, dateFrom, dateTo, page and limit, nothing
 *      else. The Events tab's "Near me", the map's events layer and the media
 *      experience sources were all shown the GLOBAL feed as if it were nearby.
 *      GET /events/nearby (lat, lng, radiusKm, page, limit) is the route that
 *      reads a location.
 *   2. The same call appended free / verifiedHostOnly / capacityAvailable, which
 *      no route reads: the tab's "Free", "Verified host" and "Spots available"
 *      chips lit up and filtered nothing.
 *
 * /events/nearby has no date filter and sorts by starts_at ascending from the
 * beginning of time, so the service applies the caller's window itself (an
 * ended event is not "near me") and walks pages forward; that is pinned too.
 *
 * Only `fetch` is faked; the module under test is the real events service.
 *
 * RED on the tree before this change: 5 failed / 0 passed.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// NOTE: intentionally exhaustive — the real module builds a Supabase client at
// import time; the events service only needs a configured flag and a session.
jest.mock('../../lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

const HOUR = 3_600_000;
const NOW = Date.parse('2030-06-07T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ev = (id: string, startsAt: number, endsAt: number | null = null) => ({
  id, title: id, startsAt: iso(startsAt), endsAt: endsAt == null ? null : iso(endsAt),
  visibility: 'public', state: 'open', locationLat: 13.7, locationLng: 100.5,
});

const fetchMock = jest.fn();
let listEvents: typeof import('../events.ts').listEvents;

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  listEvents = require('../events.ts').listEvents;
});
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'setTimeout', 'setInterval'] });
  fetchMock.mockReset();
  (globalThis as any).fetch = fetchMock;
});
afterEach(() => { jest.useRealTimers(); });

const paths = () => fetchMock.mock.calls.map(([u]) => new URL(String(u)));

describe('listEvents with a location reads GET /events/nearby', () => {
  it('sends lat / lng / radiusKm to the nearby route, and never asks GET /events', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ events: [ev('tonight', NOW + 6 * HOUR)], page: 1, limit: 50 }) });
    const r = await listEvents({ nearLat: 13.75, nearLng: 100.5, nearRadiusKm: 25, limit: 15 });
    expect(r.ok).toBe(true);
    const [u] = paths();
    expect(u!.pathname).toBe('/api/events/nearby');
    expect(u!.searchParams.get('lat')).toBe('13.75');
    expect(u!.searchParams.get('lng')).toBe('100.5');
    expect(u!.searchParams.get('radiusKm')).toBe('25');
    expect(paths().some((p) => p.pathname === '/api/events')).toBe(false);
    expect(r.data!.events.map((e) => e.id)).toEqual(['tonight']);
  });

  it('drops events that have already ended (the route has no date filter)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ events: [
      ev('last-month', NOW - 30 * 24 * HOUR, NOW - 30 * 24 * HOUR + 2 * HOUR),
      ev('on-now', NOW - HOUR, NOW + HOUR),
      ev('tonight', NOW + 6 * HOUR),
    ] }) });
    const r = await listEvents({ nearLat: 13.75, nearLng: 100.5, limit: 15 });
    expect(r.data!.events.map((e) => e.id)).toEqual(['on-now', 'tonight']);
  });

  it("applies the map layer's 24-hour window, walking pages until it is past it", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ev(`old-${i}`, NOW - (60 - i) * 24 * HOUR, NOW - (60 - i) * 24 * HOUR + HOUR));
    const page2 = [ev('in-window', NOW + 3 * HOUR), ev('tomorrow-night', NOW + 30 * HOUR), ev('next-week', NOW + 7 * 24 * HOUR)];
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events: page1 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events: page2 }) });
    const r = await listEvents({ nearLat: 13.75, nearLng: 100.5, nearRadiusKm: 50, dateFrom: iso(NOW), dateTo: iso(NOW + 24 * HOUR), limit: 60 });
    expect(r.data!.events.map((e) => e.id)).toEqual(['in-window']);
    expect(paths().map((p) => p.searchParams.get('page'))).toEqual(['1', '2']);
  });

  it('a failed nearby read is a failure, not an empty "nothing near you"', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'degraded_unavailable', message: 'try again' }) });
    const r = await listEvents({ nearLat: 13.75, nearLng: 100.5 });
    expect(r.ok).toBe(false);
    expect(paths()[0]!.pathname).toBe('/api/events/nearby');
  });
});

describe('the Events tab offers no filter the server ignores', () => {
  it('"Free", "Verified host" and "Spots available" are gone, and their params are never sent', () => {
    const root = join(__dirname, '../../..');
    const tab = readFileSync(join(root, 'app/(tabs)/events.tsx'), 'utf8');
    const svc = readFileSync(join(root, 'src/services/events.ts'), 'utf8');
    expect(tab).not.toMatch(/>(Free|Verified host|Spots available)</);
    expect(tab).not.toMatch(/set(FreeOnly|VerifiedHostOnly|CapacityAvailable)\(/);
    expect(tab).not.toMatch(/\b(free|verifiedHostOnly|capacityAvailable): /);
    expect(svc).not.toMatch(/qs\.set\('(free|verifiedHostOnly|capacityAvailable|nearLat|nearLng|nearRadiusKm)'/);
  });
});
