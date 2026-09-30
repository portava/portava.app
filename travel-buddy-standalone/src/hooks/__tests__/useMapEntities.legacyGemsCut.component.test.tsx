/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; sweep SW2): the NOW map's rollback path says a gem page the
 * server cut.
 *
 * With the gateway flag off the hook reads each layer itself; the gems layer reads GET /hidden-gems for the city with
 * `limit: 100`, which sends `truncated: true` over a cut scan or a longer list (marked beside the array by listGems,
 * services/gemListCut.ts). The hook drew it as the whole layer.
 *
 *   LG1  the gems page is cut → truncated (the map says it shows only part of the area)
 *   LG0  CONTROL: a whole gems page → not truncated
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { useMapEntities } from '../useMapEntities.ts';
import { markGemListCut } from '../../services/gemListCut.ts';

// NOTE: exhaustive by design — the hook forwards only to `fetchMapProjection` and `bboxFromCenter` from this module.
jest.mock('../../services/mapProjection.ts', () => ({
  fetchMapProjection: jest.fn(),
  bboxFromCenter: (lat: number, lng: number, r: number) => ({ west: lng - r / 111, south: lat - r / 111, east: lng + r / 111, north: lat + r / 111 }),
}));
// NOTE: exhaustive by design — the hook uses only `searchBuddies` here.
jest.mock('../../services/rentABuddy.ts', () => ({ searchBuddies: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listMyTrips` from here.
jest.mock('../../services/trips.ts', () => ({ listMyTrips: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listVisibleCircleLocations`.
jest.mock('../../services/map.ts', () => ({ listVisibleCircleLocations: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listEvents` from here.
jest.mock('../../services/events.ts', () => ({ listEvents: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listGems` from here.
jest.mock('../../services/hiddenGems.ts', () => ({ listGems: jest.fn() }));
// NOTE: exhaustive by design — only read/write/purge are used, and the real cache reaches for AsyncStorage on import.
jest.mock('../../features/map/cache/mapCache.ts', () => ({ mapCache: { read: jest.fn(), write: jest.fn(), purgeSupersededVersions: jest.fn().mockResolvedValue(0) } }));

const { fetchMapProjection } = jest.requireMock('../../services/mapProjection.ts') as { fetchMapProjection: jest.Mock };
const { listGems } = jest.requireMock('../../services/hiddenGems.ts') as { listGems: jest.Mock };
const { mapCache } = jest.requireMock('../../features/map/cache/mapCache.ts') as { mapCache: { read: jest.Mock; write: jest.Mock } };

const GEMS: any[] = ['gems'];  // stable: a new array each render would re-key the fetch forever
const OFF = { ok: true as const, data: { enabled: false, objects: [], viewport: null, total: 0, nextCursor: null, sources: [], liveEnrichment: null, generatedAt: '2026-09-30T12:00:00.000Z' } };
const gem = (id: string) => ({ id, name: `Gem ${id}`, category: 'food', city: 'Bangkok', lat: 13.75, lng: 100.5, coordsPrecision: 'exact', sensitivityLevel: 'public', status: 'active', verificationLevel: 'community' });

beforeEach(() => { jest.clearAllMocks(); mapCache.read.mockResolvedValue(null); mapCache.write.mockResolvedValue(undefined); fetchMapProjection.mockResolvedValue(OFF); });

describe('§114 SW2: the rollback path says a cut gem page', () => {
  it('LG1 the gems page is cut → truncated', async () => {
    listGems.mockImplementation(async () => markGemListCut([gem('a')]));
    const { result } = await renderHook(() => useMapEntities({ enabledLayers: GEMS, city: 'Bangkok', lat: 13.75, lng: 100.5 }));
    await waitFor(() => expect(result.current.source).toBe('legacy'));
    await waitFor(() => expect(listGems).toHaveBeenCalled());
    await waitFor(() => expect(result.current.truncated).toBe(true));
  });

  it('LG0 CONTROL: a whole gems page → not truncated', async () => {
    listGems.mockResolvedValue([gem('a')]);
    const { result } = await renderHook(() => useMapEntities({ enabledLayers: GEMS, city: 'Bangkok', lat: 13.75, lng: 100.5 }));
    await waitFor(() => expect(listGems).toHaveBeenCalled());
    await waitFor(() => expect(result.current.stage).not.toBe('cached_geography'));
    expect(result.current.truncated).toBe(false);
  });
});
