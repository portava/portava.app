/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; the round-18 verifier's B16): the NOW map's rollback path says a
 * gems or buddies layer it could not read for want of a city, never draws it as an empty one.
 *
 * The rollback path reads gems and buddies BY CITY (`fetchGems(city)`, `fetchBuddies(city, …)`) and skipped both when
 * the hook had no city — neither read nor named in `unreadLayers`. The Gems tab's "View on map", `/map?entry=compass`
 * and the Wall's "See live" reach the hook with no city (and, since §116 B17, so does every entry that passes only a
 * display title). An enabled layer that cannot be attempted is now attempted as a read that failed, so it is named.
 * The gem list has no positional read, and the buddy search's position only RANKS the whole population (no radius), so
 * neither is read by coordinates instead.
 *
 *   RC1  gateway FAILED (ok:false), no city → gems and buddies are named unread; neither service is called
 *   RC2  gateway REFUSED (enabled:false, refusal block_set_unreadable), no city → the same
 *   RC3  gateway FAILED, the gem layer alone, no city (a Compass entry since B17 hands no venue name as the city) →
 *        the gem layer is named unread, and listGems is never asked for a "city" that is not one
 *   RC0  CONTROL: gateway failed, a city known → gems and buddies are read, whole, and nothing is said about them
 *   RC0b CONTROL: gateway failed, no city, neither layer enabled → nothing is named for them
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { useMapEntities } from '../useMapEntities.ts';

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

const AT = { lat: 38.72, lng: -9.14 };
async function load(enabledLayers: any[], city: string | null) {
  const hook = await renderHook(() => useMapEntities({ enabledLayers, city, ...AT }));
  await waitFor(() => expect(hook.result.current.stage).not.toBe('cached_geography'));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook.result.current;
}
const seen = (r: any) => JSON.stringify({ source: r.source, objects: r.objects.length, unreadLayers: r.unreadLayers, truncated: r.truncated, error: r.error });

beforeEach(() => {
  jest.clearAllMocks();
  mapCache.read.mockResolvedValue(null); mapCache.write.mockResolvedValue(undefined);
  fetchMapProjection.mockResolvedValue({ ok: false, error: 'Network request failed' });
  listGems.mockResolvedValue([]);
  searchBuddies.mockResolvedValue({ ok: true, data: { buddies: [], total: 0, page: 1, perPage: 50 } });
  listEvents.mockResolvedValue({ ok: true, data: { events: [], page: 1, limit: 50 } });
});

describe('census-discovery §116 (B16): the NOW map rollback path with no city', () => {
  it('RC0 CONTROL: gateway failed, city known → gems and buddies are read (whole), nothing said about them', async () => {
    const r = await load(['gems', 'buddies'], 'Lisbon');
    expect(r.source).toBe('legacy');
    expect(listGems).toHaveBeenCalled();
    expect(searchBuddies).toHaveBeenCalled();
    expect(r.unreadLayers.filter((l: string) => l === 'gems' || l === 'buddies')).toEqual([]);
  });
  it('RC0b CONTROL: gateway failed, no city, neither layer enabled → nothing named for them', async () => {
    const r = await load(['trips'], null);
    expect(r.unreadLayers.filter((l: string) => l === 'gems' || l === 'buddies')).toEqual([]);
  });
  it('RC1 gateway FAILED, no city → gems and buddies were never read; they are said', async () => {
    const r = await load(['gems', 'buddies'], null);
    expect(r.source).toBe('legacy');
    expect({ calledGems: listGems.mock.calls.length, calledBuddies: searchBuddies.mock.calls.length, seen: seen(r) }).toEqual(expect.objectContaining({ calledGems: 0, calledBuddies: 0 }));
    expect({ unread: [...r.unreadLayers].filter((l: string) => l === 'gems' || l === 'buddies').sort(), seen: seen(r) }).toEqual(expect.objectContaining({ unread: ['buddies', 'gems'] }));
  });
  it('RC2 gateway REFUSED (block_set_unreadable), no city → the same', async () => {
    fetchMapProjection.mockResolvedValue({ ok: true, data: { enabled: false, refusal: 'block_set_unreadable', objects: [], viewport: null, total: 0, nextCursor: null, sources: [], liveEnrichment: null, generatedAt: '2026-09-30T12:00:00.000Z' } });
    const r = await load(['gems', 'buddies'], null);
    expect({ unread: [...r.unreadLayers].filter((l: string) => l === 'gems' || l === 'buddies').sort(), seen: seen(r) }).toEqual(expect.objectContaining({ unread: ['buddies', 'gems'] }));
  });
  it('RC3 gateway FAILED, the gem layer alone, no city → gems named unread, listGems never asked', async () => {
    const r = await load(['gems'], null);
    expect(listGems).not.toHaveBeenCalled();
    expect({ gemsDrawn: r.objects.filter((o: any) => o.kind === 'hidden_gem').length, gemsUnread: r.unreadLayers.includes('gems'), seen: seen(r) }).toEqual(expect.objectContaining({ gemsDrawn: 0, gemsUnread: true }));
  });
});
