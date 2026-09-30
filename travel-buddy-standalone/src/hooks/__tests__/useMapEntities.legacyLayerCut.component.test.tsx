/**
 * census-discovery §115 (DV-83 round 18, lane W11-X2; the round-17 verifier's B12): the NOW map's rollback path (the
 * gateway failed, was refused, or its flag is off) says a cut buddy page and a cut events page, not only a cut gem page
 * (SW2). The verifier's V17-LC probes, copied in (LC0, LCc, LC1, LC2 unchanged), and this lane's:
 *
 *   V17-LC0  CONTROL: a cut gem page (SW2) → truncated
 *   V17-LCc  CONTROL: buddies 3 of 3, events 3 → whole, nothing said
 *   V17-LC1  buddies: page one of 50, total 180 → said (`total` is read, not dropped)
 *   V17-LC2  events: a full page (50, the server's limit) → said (a full page may be one of several)
 *   LC2b     the fixed GET /events body: `truncated: true` → said
 *   LC1c     CONTROL: buddies 50 of total 50 → whole
 *   LC3      an unread gateway flag (B9) rolls back, names the safety layer, and a cut buddy page is said as well
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { useMapEntities } from '../useMapEntities.ts';
import { markGemListCut } from '../../services/gemListCut.ts';

// NOTE: exhaustive by design — the hook forwards only to `fetchMapProjection` and `bboxFromCenter` from this module.
jest.mock('../../services/mapProjection.ts', () => ({
  fetchMapProjection: jest.fn(),
  bboxFromCenter: (lat: number, lng: number, r: number) => ({ west: lng - r / 111, south: lat - r / 111, east: lng + r / 111, north: lat + r / 111 }),
}));
// NOTE: exhaustive by design
jest.mock('../../services/rentABuddy.ts', () => ({ searchBuddies: jest.fn() }));
// NOTE: exhaustive by design
jest.mock('../../services/trips.ts', () => ({ listMyTrips: jest.fn() }));
// NOTE: exhaustive by design
jest.mock('../../services/map.ts', () => ({ listVisibleCircleLocations: jest.fn() }));
// NOTE: exhaustive by design
jest.mock('../../services/events.ts', () => ({ listEvents: jest.fn() }));
// NOTE: exhaustive by design
jest.mock('../../services/hiddenGems.ts', () => ({ listGems: jest.fn() }));
// NOTE: exhaustive by design
jest.mock('../../features/map/cache/mapCache.ts', () => ({ mapCache: { read: jest.fn(), write: jest.fn(), purgeSupersededVersions: jest.fn().mockResolvedValue(0) } }));

const { fetchMapProjection } = jest.requireMock('../../services/mapProjection.ts') as { fetchMapProjection: jest.Mock };
const { searchBuddies } = jest.requireMock('../../services/rentABuddy.ts') as { searchBuddies: jest.Mock };
const { listEvents } = jest.requireMock('../../services/events.ts') as { listEvents: jest.Mock };
const { listGems } = jest.requireMock('../../services/hiddenGems.ts') as { listGems: jest.Mock };
const { mapCache } = jest.requireMock('../../features/map/cache/mapCache.ts') as { mapCache: { read: jest.Mock; write: jest.Mock } };

const CENTER = { city: 'Lisbon', lat: 38.72, lng: -9.14 };
const now = Date.now();
const event = (i: number) => ({ id: `ev-${i}`, title: `Event ${i}`, locationName: 'Somewhere', locationLat: 38.72 + i / 1000, locationLng: -9.14, visibility: 'public', startsAt: new Date(now + 3_600_000).toISOString(), endsAt: new Date(now + 7_200_000).toISOString(), state: 'published', category: 'music', city: 'Lisbon', goingCount: 1 });
const buddy = (i: number) => ({ id: `b-${i}`, userId: `u-${i}`, displayName: `Buddy ${i}`, city: 'Lisbon', meetupBaseLat: 38.72 + i / 1000, meetupBaseLng: -9.14, hourlyRate: 10, currency: 'EUR', rating: 5, reviewCount: 1, verified: true, languages: [], interests: [] });
const gem = (i: number) => ({ id: `g-${i}`, name: `Gem ${i}`, category: 'viewpoint', city: 'Lisbon', lat: 38.72 + i / 1000, lng: -9.14, status: 'active' });

async function load(enabledLayers: any[]) {
  const hook = await renderHook(() => useMapEntities({ enabledLayers, ...CENTER }));
  await waitFor(() => expect(hook.result.current.stage).not.toBe('cached_geography'));
  return hook.result.current;
}
const seen = (r: any) => JSON.stringify({ source: r.source, objects: r.objects.length, unreadLayers: r.unreadLayers, truncated: r.truncated });

beforeEach(() => {
  jest.clearAllMocks();
  mapCache.read.mockResolvedValue(null); mapCache.write.mockResolvedValue(undefined);
  fetchMapProjection.mockResolvedValue({ ok: false, error: 'Network request failed' });
  listGems.mockResolvedValue([]);
  searchBuddies.mockResolvedValue({ ok: true, data: { buddies: [], total: 0, page: 1, perPage: 50 } });
  listEvents.mockResolvedValue({ ok: true, data: { events: [], page: 1, limit: 50 } });
});

describe('census-discovery §115 (B12): the NOW map rollback path over a page of several', () => {
  it('V17-LC0 CONTROL: a cut gem page (SW2) → truncated', async () => {
    listGems.mockResolvedValue(markGemListCut([gem(1), gem(2)]));
    const r = await load(['gems']);
    expect(r.source).toBe('legacy');
    expect(r.truncated).toBe(true);
  });
  it('V17-LCc CONTROL: buddies 3 of 3, events 3 → whole, nothing said about them', async () => {
    searchBuddies.mockResolvedValue({ ok: true, data: { buddies: [buddy(1), buddy(2), buddy(3)], total: 3, page: 1, perPage: 50 } });
    listEvents.mockResolvedValue({ ok: true, data: { events: [event(1), event(2), event(3)], page: 1, limit: 50 } });
    const r = await load(['buddies', 'events']);
    expect(r.source).toBe('legacy');
    expect(r.truncated).toBe(false);
    expect(r.unreadLayers.filter((l: string) => l === 'buddies' || l === 'events')).toEqual([]);
  });
  it('V17-LC1 buddies: page one of 50, total 180 → must be said', async () => {
    searchBuddies.mockResolvedValue({ ok: true, data: { buddies: Array.from({ length: 50 }, (_, i) => buddy(i)), total: 180, page: 1, perPage: 50 } });
    const r = await load(['buddies']);
    expect(r.source).toBe('legacy');
    expect({ said: r.truncated === true || r.unreadLayers.includes('buddies'), seen: seen(r) }).toEqual(expect.objectContaining({ said: true }));
  });
  it('V17-LC2 events: a full page (50, the server limit) → must be said', async () => {
    listEvents.mockResolvedValue({ ok: true, data: { events: Array.from({ length: 50 }, (_, i) => event(i)), page: 1, limit: 50 } });
    const r = await load(['events']);
    expect(r.source).toBe('legacy');
    expect({ said: r.truncated === true || r.unreadLayers.includes('events'), seen: seen(r) }).toEqual(expect.objectContaining({ said: true }));
  });
  it('LC2b the fixed server body: GET /events says truncated → said', async () => {
    listEvents.mockResolvedValue({ ok: true, data: { events: [event(1), event(2)], page: 1, limit: 50, truncated: true } });
    const r = await load(['events']);
    expect(r.source).toBe('legacy');
    expect(r.truncated).toBe(true);
  });
  it('LC1c CONTROL: buddies 50 of total 50 (a whole page that fills perPage) → not cut', async () => {
    searchBuddies.mockResolvedValue({ ok: true, data: { buddies: Array.from({ length: 50 }, (_, i) => buddy(i)), total: 50, page: 1, perPage: 50 } });
    const r = await load(['buddies']);
    expect(r.truncated).toBe(false);
    expect(r.unreadLayers).toEqual([]);
  });
  it('LC3 the flag-unreadable refusal (B9) rolls back AND names the optional layers; a cut buddy page is said too', async () => {
    fetchMapProjection.mockResolvedValue({ ok: true, data: { enabled: false, refusal: 'flag_unreadable', objects: [], viewport: null, total: 0, nextCursor: null, sources: [], liveEnrichment: null, generatedAt: '2026-09-30T12:00:00.000Z' } });
    searchBuddies.mockResolvedValue({ ok: true, data: { buddies: [buddy(1)], total: 2, page: 1, perPage: 50 } });
    const layers: any[] = ['buddies'];
    const hook = await renderHook(() => useMapEntities({ enabledLayers: layers, ...CENTER, safety: true }));
    await waitFor(() => expect(hook.result.current.stage).not.toBe('cached_geography'));
    await waitFor(() => expect(hook.result.current.source).toBe('legacy'));
    expect(hook.result.current.unreadLayers).toEqual(['safety']);
    expect(hook.result.current.truncated).toBe(true);
  });
});
