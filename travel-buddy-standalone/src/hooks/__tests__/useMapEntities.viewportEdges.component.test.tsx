/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; sweep SW12, SW14): the NOW map says a layer it never asked for
 * because it had no position, and says a viewport it could only ask for in part.
 *
 * SW12. With no position (no parameters, no GPS, no last-known or home location yet), the hook asked the gateway for
 *       nothing and the rollback path skipped the events layer — neither named in `unreadLayers` — so the optional
 *       layers only the gateway serves (safety first) and the events layer were drawn as empty.
 *   NP1  no position, events and safety requested → both named unread; the gateway is never asked
 *   NP0  CONTROL: no position, only trips requested → nothing named (trips are not read by position)
 *
 * SW14. `bboxFromCenter` clamps the viewport box at ±179.9° and ±89.9° and floors cos(lat) at 0.2, and the gateway
 *       takes one box that cannot cross the antimeridian — so near the line or a pole it answered for part of the area
 *       and the map drew it as whole (lib: features/map/layers/viewportBoxClamped.ts).
 *   VE1  the camera ~5 km from the antimeridian → `truncated`
 *   VE2  the camera at 85°N → `truncated`
 *   VE0  CONTROL: the camera at Da Nang, a whole answer → not truncated
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { useMapEntities } from '../useMapEntities.ts';

// NOTE: exhaustive by design — the hook forwards only to `fetchMapProjection` and `bboxFromCenter` from this module.
jest.mock('../../services/mapProjection.ts', () => ({
  fetchMapProjection: jest.fn(),
  bboxFromCenter: (lat: number, lng: number, r: number) => ({ west: lng - r / 111, south: lat - r / 111, east: lng + r / 111, north: lat + r / 111 }),
}));
// NOTE: exhaustive by design — the legacy fetchers answer empty and whole; the gateway leg is what is under test.
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

const CENTER = { city: 'Da Nang', lat: 16.1, lng: 108.25 };
const zone = { id: 'zone:city:1', kind: 'activity_zone', geometry: { type: 'Polygon', coordinates: [[[108.2, 16.05], [108.3, 16.05], [108.3, 16.15], [108.2, 16.05]]] }, title: '1000 places in this area', subtitle: null, count: 1000, privacyClass: 'aggregate_only', renderingPriority: 40, interaction: { actions: ['view'], opensSheet: false } };
const PRODUCERS = { meeting_point: null, memory: null, safety_notice: null, saved_place: null };
const body = (sources: string[], over: Record<string, unknown> = {}) => ({ ok: true as const, data: { enabled: true, objects: [], viewport: null, total: 0, nextCursor: null, sources, liveEnrichment: { considered: 0, enriched: 0, skipped: 0 }, producers: PRODUCERS, generatedAt: '2026-09-30T12:00:00.000Z', ...over } });
const FLAG_OFF = { enabled: false, objects: [], viewport: null, total: 0, nextCursor: null, sources: [], aggregation: null, protection: null, liveEnrichment: null, crowdFlow: null, producers: null, places: null, discoveryCandidates: null, trips: null, worldIntelligence: null, display: null, generatedAt: '2026-09-30T12:00:00.000Z' };

const load = async (enabledLayers: any[], at: { lat: number | null; lng: number | null }, extra: Record<string, unknown> = {}) => {
  const hook = await renderHook(() => useMapEntities({ enabledLayers, city: null, ...at, zoom: 11, ...extra }));
  await waitFor(() => expect(hook.result.current.stage).not.toBe('cached_geography'));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook.result.current;
};

beforeEach(() => {
  jest.clearAllMocks();
  mapCache.read.mockResolvedValue(null); mapCache.write.mockResolvedValue(undefined);
  listGems.mockResolvedValue([]); listEvents.mockResolvedValue({ ok: true, data: { events: [], page: 1, limit: 50 } });
  searchBuddies.mockResolvedValue({ ok: true, data: { buddies: [], total: 0, page: 1, perPage: 50 } });
  fetchMapProjection.mockResolvedValue(body(['events', 'safety']));
  (jest.requireMock('../../services/trips.ts') as { listMyTrips: jest.Mock }).listMyTrips.mockResolvedValue([]);
});

describe('census-discovery §116 (SW12): the NOW map with no position', () => {
  it('NP1 no position, events and safety requested → both named unread; the gateway is never asked', async () => {
    const r = await load(['events'], { lat: null, lng: null }, { safety: true });
    expect(fetchMapProjection).not.toHaveBeenCalled();
    expect({ unread: [...r.unreadLayers].sort(), seen: JSON.stringify({ unread: r.unreadLayers, source: r.source }) }).toEqual(expect.objectContaining({ unread: ['events', 'safety'] }));
  });
  it('NP0 CONTROL: no position, only trips requested → nothing named', async () => {
    const r = await load(['trips'], { lat: null, lng: null });
    expect(r.unreadLayers).toEqual([]);
  });
});

describe('census-discovery §116 (SW14): the NOW map near the antimeridian or a pole', () => {
  it('VE0 CONTROL: Da Nang, a whole answer → not truncated', async () => {
    const r = await load(['events'], { lat: 16.1, lng: 108.25 });
    expect(fetchMapProjection).toHaveBeenCalled();
    expect(r.truncated).toBe(false);
  });
  it('VE1 the camera ~5 km from the antimeridian → truncated (the gateway answered for part of the area)', async () => {
    const r = await load(['events'], { lat: -16.82, lng: 179.95 });
    expect(fetchMapProjection).toHaveBeenCalled();
    expect(r.truncated).toBe(true);
  });
  it('VE2 the camera at 85°N → truncated', async () => {
    const r = await load(['events'], { lat: 85, lng: 15 });
    expect(r.truncated).toBe(true);
  });
});
